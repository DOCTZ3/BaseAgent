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
import { buildWriteGuardPrelude } from './write-guard.js';
import { CappedBuffer } from './capped-buffer.js';
import { killProcessTree } from './process-tree.js';
import { DEFAULT_INHERIT_ENV, inheritEnv, PIP_BLOCKED_ENV } from './sandbox-env.js';
import type { ToolBridge } from './tool-bridge.js';

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
  /**
   * 写边界:只允许往工作区(和 temp)写文件,其余写操作被拒
   *
   * 默认开启。关掉意味着模型的代码能删/改机器上任意文件 ——
   * 写/删是不可逆的,一次手滑就是真实损失。
   * 只管写不管读:读错文件没有直接损害,而读的白名单最容易误伤 import
   * (实测一次 `import pandas` 触发 1183 次 open,全是库加载)。
   * 详见 write-guard.ts 顶部注释,含「明确不做」的清单与剩余风险。
   */
  writeGuard?: boolean;
  /**
   * 禁止在代码里装包(默认开)
   *
   * 装包的正式通道是 shell 工具:它 danger:true,执行前把**原样命令**
   * 给用户看。关掉这项等于回到「模型静默装包、用户事后翻 trace 才发现」。
   * 实现与绕法见 sandbox-env.ts 的 PIP_BLOCKED_ENV —— 它是路牌不是锁。
   */
  blockPipInstall?: boolean;
  /**
   * 工具桥:让代码里能调「代码本身做不到」的工具(截图、请求用户介入)
   *
   * 不给 = 那几个函数在代码里不存在,其余能力不受影响。
   * 桥只暴露 3 个工具,筛选依据见 tool-bridge.ts 顶部。
   */
  toolBridge?: ToolBridge;
  logger: ExecutorLogger;
}

export interface PythonRunOptions {
  /** 覆盖默认超时 */
  timeout?: number;
  /** 追加环境变量(与构造时的 env 合并,同名键覆盖) */
  env?: Record<string, string>;
  /**
   * 是否注入工具桥函数(默认 true)
   *
   * 框架自己写的脚本(BrowserOps)传 false:它们不需要这些函数,
   * 而且截图脚本里再出现一个 screenshot() 会形成递归的可能。
   */
  bridge?: boolean;
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
  /**
   * 代码经工具桥拿到的观察文字(视觉插件的产物)
   *
   * 由框架投递、不返回给代码:实测模型裸调 `view_image(...)`
   * 不会 print 返回值,真交给代码就会静默丢掉花过钱的视觉调用结果。
   */
  observations: string[];
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

    // 每次执行一个 id:工具桥按它给图片分桶。
    // 必须分桶,因为截图会**嵌套**再起一个 Python 进程(BrowserOps),
    // 共用一个桶时内层结束会把外层攒的图片一并取走
    const runId = randomUUID();
    const bridge = this.config.toolBridge;
    const useBridge = (options.bridge ?? true) && !!bridge?.isRunning;

    // 写边界必须排在模型代码之前：audit hook 一旦注册就无法注销
    // （PEP 578 故意不提供 remove），所以模型的代码删不掉它
    const guardPrelude = (this.config.writeGuard ?? true)
      ? buildWriteGuardPrelude(this.config.workDir)
      : '';
    // 工具桥排在写边界之后:桥自己也要受写边界约束(它没有理由例外)
    const bridgePrelude = useBridge ? bridge!.prelude : '';
    await fs.writeFile(scriptPath, guardPrelude + bridgePrelude + code, 'utf-8');

    try {
      const result = await this.spawnScript(scriptPath, timeout, startedAt, {
        ...(useBridge ? { ...bridge!.env, BASEAGENT_RUN_ID: runId } : {}),
        ...options.env,
      });

      // 观察必须取走:桶留着就是内存泄漏,而且下一次同 id 执行会串味
      return {
        ...result,
        observations: useBridge ? bridge!.takeObservations(runId) : [],
      };
    } finally {
      // 临时脚本不留痕:代码本身已经在 LLM trace 里了
      await fs.rm(scriptPath, { force: true }).catch(() => {});
    }
  }

  /**
   * 按白名单挑出要继承的父进程环境变量
   *
   * 白名单本体在 sandbox-env.ts,与 shell 执行器**共用同一份** ——
   * 各写一份的话,Python 这侧费劲不继承 DEEPSEEK_API_KEY、
   * bash 一句 `echo $DEEPSEEK_API_KEY` 就把这层还回去了。
   */
  private baseEnv(): Record<string, string> {
    return inheritEnv(this.config.inheritEnv ?? DEFAULT_INHERIT_ENV);
  }

  /**
   * 起子进程跑脚本
   *
   * 返回值不含 attachments / observations:两者都攒在 TS 侧的工具桥里、
   * 与子进程无关,由 run() 在结束后取走。类型上排除掉,免得这里漏填也编译通过。
   */
  private spawnScript(
    scriptPath: string,
    timeout: number,
    startedAt: number,
    extraEnv?: Record<string, string>,
  ): Promise<Omit<PythonRunResult, 'attachments' | 'observations'>> {
    return new Promise<Omit<PythonRunResult, 'attachments' | 'observations'>>(resolve => {
      const child = spawn(this.config.pythonPath, ['-X', 'utf8', '-u', scriptPath], {
        cwd: this.config.workDir,
        env: {
          ...this.baseEnv(),
          // 让 print 的中文在 Windows 上不炸(cp936 编码错误)
          PYTHONIOENCODING: 'utf-8',
          // 代码里装不了包:PIP_NO_INDEX 让 pip 不查索引,`pip install X` 返回码 1。
          // 装包的正式通道是 shell 工具(danger:true,原样命令给用户看)——
          // 一屏代码里第 23 行的 pip 没人看得见,单独一行用户才会真读清包名。
          //
          // 关键性质:env **向子进程继承**,所以 subprocess 起的新解释器也覆盖得到
          // (实测有效)。这正好补上写边界补不了的那块 —— audit hook 反过来:
          // 注册后删不掉,但只管当前进程。
          // 它是路牌不是锁:传 env=清掉这个键的副本、或 pip install <URL> 都能绕。
          // 详见 sandbox-env.ts 的 PIP_BLOCKED_ENV 注释
          ...(this.config.blockPipInstall ?? true ? PIP_BLOCKED_ENV : {}),
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
   * 实现与 shell 执行器共用(process-tree.ts),平台分叉只写一份。
   */
  private killTree(pid: number | undefined) {
    killProcessTree(pid);
  }
}
