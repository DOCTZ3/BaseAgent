// ============================================
// Executors 层:Python 子进程执行器(CodeAct 的执行底座)
// ============================================
//
// ⚠️ 这里没有隔离。代码以当前 OS 用户的全部权限运行。
//
// 本模块做的是**资源管控**(超时、输出上限、进程树回收),不是安全边界:
// - cwd 只是相对路径的起点,`open('C:/Users/x/.ssh/id_rsa')` 照样读得到
// - 文件系统白名单(SecurityGuard / FS_SANDBOX_PATHS)在这里完全不适用 ——
//   它靠检查工具入参生效,而这里入参就是一整段任意代码
// - 网络无限制
// 也就是说 `execute_python` 事实上绕开了架构文档里的两层权限模型。
// `danger: true` 只保证调用前弹一次确认,确认之后即全权限。
// 真隔离需要容器/独立用户/seccomp 这类进程外的边界,属于待实现。
//
// 唯一主动收紧的一处:父进程 env 按白名单继承,不全量透传。
// process.env 里有 DEEPSEEK_API_KEY,全量继承的话模型写
// print(os.environ['DEEPSEEK_API_KEY']) 就能把 key 打进上下文、跟着 trace 落盘。
// 这不构成隔离(代码仍可读 .env 文件),只是不把凭证直接递到手里。
//
// 职责：
// 1. 把模型写的 Python 代码丢进子进程跑,回收 stdout/stderr/exitCode
// 2. 对 stdout 设硬上限 —— 这是 CodeAct 唯一必须框架兜底的地方
// 3. 注入环境变量(BROWSER_PROFILE_DIR 等),让代码不必硬编码路径
//
// 关键设计：
// - 代码写临时文件再执行,不走 `python -c`:后者在 Windows 上要处理命令行转义和长度上限,
//   多行代码 + 中文极易炸
// - stdout 超限即判失败并给收窄建议。模型很容易写出 print(page.content()),
//   2MB HTML 直接怼回上下文;这里截断是为了让「筛选发生在子进程内」这条前提成立
// - 超时后杀整个进程树:Playwright 会拉起 chromium 子进程,只杀 python 会留下孤儿浏览器
// - 不做 import 白名单:`__import__` / importlib 有无数绕法,
//   黑名单只会给出虚假的安全感,不如把边界诚实地留在进程之外
//
// 使用示例：
//   const py = new PythonExecutor({ pythonPath: 'python', workDir: 'sandbox', logger });
//   const r = await py.run('print(1 + 1)');   // r.stdout === '2\n'
//
// 配置参数见：.env.example 的 PYTHON_* 部分
// ============================================

import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

// 只依赖四个方法,与 RetryHandler 同样的窄接口,避免耦合具体 Logger 实现
interface ExecutorLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface PythonExecutorConfig {
  /** python 可执行文件。沙箱装了 venv 就指向 venv 里那个 */
  pythonPath: string;
  /** 代码的工作目录(cwd)。模型写的相对路径都落在这里 */
  workDir: string;
  /** 单次执行超时(ms) */
  timeout: number;
  /** stdout 上限(字节)。超了判失败并给收窄建议 */
  maxStdoutBytes: number;
  /** stderr 上限(字节)。traceback 通常不长,给小一点 */
  maxStderrBytes: number;
  /** 注入子进程的环境变量(如 BROWSER_PROFILE_DIR) */
  env?: Record<string, string>;
  /**
   * 从父进程继承的环境变量白名单(键名精确匹配)
   *
   * 默认只继承 PATH 一类运行必需项。父进程的 env 里有 DEEPSEEK_API_KEY ——
   * 全量继承的话,模型写 print(os.environ['DEEPSEEK_API_KEY']) 就能把它
   * 打进上下文并跟着 trace 落盘。
   */
  inheritEnv?: string[];
  logger: ExecutorLogger;
}

/**
 * 默认继承的环境变量
 *
 * 只放「不给就跑不起来」的:找解释器和动态库要 PATH,
 * Windows 下 python 还依赖 SystemRoot / TEMP 一类。
 * 白名单而非黑名单 —— 黑名单漏一个键就是一次凭证泄漏。
 */
const DEFAULT_INHERIT_ENV = [
  'PATH',
  'Path',              // Windows 上键名大小写不定
  'SystemRoot',
  'windir',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',       // Playwright 找 chromium 缓存要用
  'LANG',
  'LC_ALL',
  'PYTHONHOME',
  'PYTHONPATH',
  'LD_LIBRARY_PATH',
  'DISPLAY',           // headless=False 在 Linux 上要
];

export interface PythonRunOptions {
  /** 覆盖默认超时 */
  timeout?: number;
  /** 追加环境变量(与构造时的 env 合并,同名键覆盖) */
  env?: Record<string, string>;
}

export interface PythonRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  /** 超时被杀 */
  timedOut: boolean;
  /** stdout 超过上限被截断 —— 此时 ok 为 false */
  stdoutTruncated: boolean;
  /** 实际产生的 stdout 字节数(截断前),用于给模型量化提示 */
  stdoutBytes: number;
}

export class PythonExecutor {
  constructor(private config: PythonExecutorConfig) {}

  /**
   * 执行一段 Python 代码
   *
   * 不抛异常：失败一律以 ok:false + stderr 返回,交由工具层包成 ToolResult
   * 回流给模型(见架构文档「所有报错回流 loop」)。
   */
  async run(code: string, options: PythonRunOptions = {}): Promise<PythonRunResult> {
    const timeout = options.timeout ?? this.config.timeout;
    const startedAt = Date.now();

    await fs.mkdir(this.config.workDir, { recursive: true });
    const scriptPath = path.join(os.tmpdir(), `baseagent-${randomUUID()}.py`);
    await fs.writeFile(scriptPath, code, 'utf-8');

    try {
      return await this.spawnScript(scriptPath, timeout, startedAt, options.env);
    } finally {
      // 临时脚本不留痕:代码本身已经在 LLM trace 里了
      await fs.rm(scriptPath, { force: true }).catch(() => {});
    }
  }

  /**
   * 按白名单挑出要继承的父进程环境变量
   *
   * 不用 `...process.env` 是因为里面有 DEEPSEEK_API_KEY:模型写
   * print(os.environ['DEEPSEEK_API_KEY']) 就能把 key 打进上下文、跟着 trace 落盘。
   * 这不是隔离(进程仍是主环境全权限),只是不主动把凭证递到手里。
   */
  private baseEnv(): Record<string, string> {
    const keys = this.config.inheritEnv ?? DEFAULT_INHERIT_ENV;
    const env: Record<string, string> = {};

    for (const key of keys) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }

    return env;
  }

  private spawnScript(
    scriptPath: string,
    timeout: number,
    startedAt: number,
    extraEnv?: Record<string, string>,
  ): Promise<PythonRunResult> {
    return new Promise<PythonRunResult>(resolve => {
      const child = spawn(this.config.pythonPath, ['-X', 'utf8', '-u', scriptPath], {
        cwd: this.config.workDir,
        env: {
          ...this.baseEnv(),
          // 让 print 的中文在 Windows 上不炸(cp936 编码错误)
          PYTHONIOENCODING: 'utf-8',
          ...this.config.env,
          ...extraEnv,
        },
        // 有子进程要连坐杀(Playwright 会拉起 chromium),需要独立进程组
        detached: process.platform !== 'win32',
        windowsHide: true,
      });

      const stdout = new CappedBuffer(this.config.maxStdoutBytes);
      const stderr = new CappedBuffer(this.config.maxStderrBytes);
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        this.killTree(child.pid);
      }, timeout);

      child.stdout.on('data', (chunk: Buffer) => {
        // 超限后仍要读完流,否则子进程会因管道写满而卡死(拿不到 exit 事件)
        stdout.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

      const settle = (exitCode: number | null, spawnError?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        if (spawnError) stderr.push(Buffer.from(`\n${spawnError.message}`, 'utf-8'));

        const stdoutTruncated = stdout.overflowed;
        const ok = !timedOut && !stdoutTruncated && exitCode === 0 && !spawnError;

        this.config.logger.debug('Python 执行结束', {
          exit_code: exitCode,
          duration_ms: Date.now() - startedAt,
          stdout_bytes: stdout.totalBytes,
          timed_out: timedOut,
          stdout_truncated: stdoutTruncated,
        });

        resolve({
          ok,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          exitCode,
          durationMs: Date.now() - startedAt,
          timedOut,
          stdoutTruncated,
          stdoutBytes: stdout.totalBytes,
        });
      };

      child.on('error', err => {
        // 最常见的是 ENOENT:python 不在 PATH 上
        this.config.logger.error('Python 进程启动失败', { error: err.message });
        settle(null, err);
      });

      child.on('close', code => settle(code));
    });
  }

  /**
   * 杀掉整个进程树
   *
   * Playwright 会拉起 chromium 子进程,只杀 python 会留下孤儿浏览器 ——
   * 它还锁着 profile 目录,导致下一轮 launch_persistent_context 直接失败。
   */
  private killTree(pid: number | undefined) {
    if (pid === undefined) return;

    if (process.platform === 'win32') {
      // Windows 没有进程组,借 taskkill /T 递归
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      return;
    }

    try {
      // detached 让子进程自成进程组,负 pid = 杀整组
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // 已经退出了
      }
    }
  }
}

/**
 * 带上限的字节缓冲:超限后丢弃新数据,但记账总量
 *
 * 记账是为了给模型量化提示（"你打印了 1.8MB"比"输出过大"有用得多）。
 * 按字节而非字符截断,再在末尾切掉可能被劈开的多字节字符。
 */
class CappedBuffer {
  private chunks: Buffer[] = [];
  private kept = 0;
  totalBytes = 0;
  overflowed = false;

  constructor(private limit: number) {}

  push(chunk: Buffer) {
    this.totalBytes += chunk.length;

    if (this.kept >= this.limit) {
      this.overflowed = true;
      return;
    }

    const room = this.limit - this.kept;
    if (chunk.length <= room) {
      this.chunks.push(chunk);
      this.kept += chunk.length;
    } else {
      this.chunks.push(chunk.subarray(0, room));
      this.kept = this.limit;
      this.overflowed = true;
    }
  }

  toString(): string {
    // 截断可能把一个 UTF-8 字符劈成两半,末尾会出现替换字符;去掉它
    const text = Buffer.concat(this.chunks).toString('utf-8');
    return this.overflowed ? text.replace(/�+$/, '') : text;
  }
}
