// ============================================
// Executors 层:Shell 执行器(装包等系统操作的正式通道)
// ============================================
//
// ⚠️ 这里**没有任何机制边界**。命令以当前 OS 用户的全部权限运行,
// Python 的写边界(audit hook)对它完全无效 —— 那是个进程内的钩子,
// shell 起的进程根本不经过它。
//
// 所以本模块的安全性**全部来自工具层的人工确认**(shell 工具 danger:true,
// 执行前把原样命令给用户看)。这不是「已封堵」,是「风险移到了用户的判断上」。
// 同类工具(Claude Code / Codex)也是这个形状,是正当的产品决策,
// 但必须诚实记账:靠人守,不靠机制守。
//
// 为什么要它 —— 让装包这件事**变得可读**:
// 模型此前在 execute_python 里写 subprocess.run([...,"pip","install",...]),
// 静默成功(返回码 0)、顺带升级了用户全局环境里的 onnxruntime,
// 用户是事后翻 trace 才发现的。execute_python 本来就是 danger 工具、
// 也在逐次确认,但那是一屏 40 行代码里的第 23 行 —— 人不会看清包名。
// 单独一行 `pip install rapidocr_onnxruntime` 才会。
// 这对 typosquatting(抢注近似包名;pip 在**安装期**就执行 setup.py,
// 等于远程代码执行)是唯一有效的防线,因为写边界拦不住它:
// pip 的构建隔离恰好在放行的 TEMP 里跑。
//
// 关键设计：
// - PATH 前置 venv 的 Scripts/bin:否则 shell 从 PATH 找到的是**全局** pip,
//   那就绕过了沙箱 venv、装回用户机器上 —— 正是这次要修的东西
// - env 白名单与 Python 执行器**共用同一份**(sandbox-env.ts):
//   各写一份的话,Python 那侧费劲不继承 DEEPSEEK_API_KEY、
//   bash 一句 `echo $DEEPSEEK_API_KEY` 就把这层还回去了
// - **不设 PIP_NO_INDEX**:这里是装包的正式通道,pip 要能联网。
//   代码那侧才设(见 sandbox-env.ts 的 PIP_BLOCKED_ENV)
// - 超时后杀整个进程树:npm/pip install 都会拉起子进程
// - 输出上限复用 CappedBuffer:npm install 的日志能刷几百行
//
// 配置参数见：.env.example 的 SHELL_* 部分
// ============================================

import { spawn } from 'child_process';
import * as path from 'path';
import { CappedBuffer } from './capped-buffer.js';
import { killProcessTree } from './process-tree.js';
import { DEFAULT_INHERIT_ENV, inheritEnv } from './sandbox-env.js';

// 与 PythonExecutor 同样的窄接口,避免耦合具体 Logger 实现
interface ExecutorLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface ShellExecutorConfig {
  /** 命令的工作目录(cwd)。与 Python 同源 = 工作区 */
  workDir: string;
  /** 单次执行超时(ms) */
  timeout: number;
  /** stdout 上限(字节) */
  maxStdoutBytes: number;
  /** stderr 上限(字节) */
  maxStderrBytes: number;
  /**
   * 放到 PATH **最前面**的目录(通常是沙箱 venv 的 Scripts/bin)
   *
   * 必须前置,否则 `pip install` 找到的是全局解释器那个 pip ——
   * 装到用户机器上,venv 隔离白做。
   */
  pathPrepend?: string[];
  /** 追加的环境变量 */
  env?: Record<string, string>;
  /** 从父进程继承的环境变量白名单。默认与 Python 执行器同一份 */
  inheritEnv?: string[];
  logger: ExecutorLogger;
}

export interface ShellRunOptions {
  /** 覆盖默认超时 */
  timeout?: number;
}

export interface ShellRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  /** 输出超上限被截断 —— 此时仍可能 ok(命令本身成功了) */
  stdoutTruncated: boolean;
  stdoutBytes: number;
}

export class ShellExecutor {
  constructor(private config: ShellExecutorConfig) {}

  /**
   * 执行一条 shell 命令
   *
   * 不抛异常:失败一律以 ok:false + stderr 返回,交由工具层包成 ToolResult
   * 回流给模型(见架构文档「所有报错回流 loop」)。
   *
   * 用 shell 模式(`shell: true`)而不是切分 argv:模型写的是给人看的命令行,
   * 管道、重定向、`&&` 都是它的正常表达。切分必然切错 ——
   * 而**切错比不切更危险**(参数错位可能变成删错目标)。
   * 既然安全性靠人工确认而非解析,就诚实地整条交给 shell。
   */
  async run(command: string, options: ShellRunOptions = {}): Promise<ShellRunResult> {
    const timeout = options.timeout ?? this.config.timeout;
    const startedAt = Date.now();

    return new Promise<ShellRunResult>(resolve => {
      const child = spawn(command, {
        shell: true,
        cwd: this.config.workDir,
        env: this.buildEnv(),
        // 有子进程要连坐杀(npm/pip install 都会拉起子进程)
        detached: process.platform !== 'win32',
        windowsHide: true,
      });

      const stdout = new CappedBuffer(this.config.maxStdoutBytes);
      const stderr = new CappedBuffer(this.config.maxStderrBytes);
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child.pid);
      }, timeout);

      // 超限后仍要读完流,否则子进程会因管道写满而卡死(拿不到 exit 事件)
      child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));

      const settle = (exitCode: number | null, spawnError?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        if (spawnError) stderr.push(Buffer.from(`\n${spawnError.message}`, 'utf-8'));

        // 与 Python 执行器不同:输出超限**不判失败** ——
        // `npm install` 刷几百行日志是常态,命令本身是成功的。
        // Python 那边判失败是因为「print 整页 HTML」意味着模型的做法错了,
        // 这里没有等价含义
        const ok = !timedOut && exitCode === 0 && !spawnError;

        this.config.logger.debug('Shell 执行结束', {
          exit_code: exitCode,
          duration_ms: Date.now() - startedAt,
          stdout_bytes: stdout.totalBytes,
          timed_out: timedOut,
        });

        resolve({
          ok,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          exitCode,
          durationMs: Date.now() - startedAt,
          timedOut,
          stdoutTruncated: stdout.overflowed,
          stdoutBytes: stdout.totalBytes,
        });
      };

      child.on('error', err => {
        this.config.logger.error('Shell 进程启动失败', { error: err.message });
        settle(null, err);
      });

      child.on('close', code => settle(code));
    });
  }

  /**
   * 组装子进程环境
   *
   * PATH 前置是这里唯一的实质逻辑:venv 的 Scripts 必须排在最前,
   * 否则 `pip` / `python` 解析到全局解释器,venv 隔离等于没做。
   */
  private buildEnv(): Record<string, string> {
    const env = inheritEnv(this.config.inheritEnv ?? DEFAULT_INHERIT_ENV);

    const prepend = (this.config.pathPrepend ?? []).map(p => path.resolve(p));
    if (prepend.length > 0) {
      // Windows 上键名大小写不定(PATH / Path),两个都可能存在 ——
      // 只改一个会被另一个覆盖,所以统一处理
      const sep = path.delimiter;
      for (const key of ['PATH', 'Path']) {
        if (env[key] !== undefined) {
          env[key] = [...prepend, env[key]].join(sep);
        }
      }
      // 两个键都没有(极少见)时兜一个,否则 PATH 前置静默失效
      if (env.PATH === undefined && env.Path === undefined) {
        env.PATH = prepend.join(sep);
      }
    }

    return { ...env, ...this.config.env };
  }
}
