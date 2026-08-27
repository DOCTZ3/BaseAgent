// ============================================
// Core 层:AgentSession —— 一次会话的全部接线
// ============================================
//
// 这个模块的存在是为了兑现架构文档第一条:「交互层(壳)可替换 ——
// CLI / 语音 / GUI 只做输入→文本与结果→展示,零业务逻辑」。
//
// 抽出来之前那条不成立:cli.ts 有 937 行、21 段接线(配置、留痕、工具注册、
// LLM、视觉、venv、依赖检测、Python 沙箱、读黑名单、常驻浏览器、工具桥、
// shell、安全边界、环境提示、上下文、长期记忆…),全是业务装配而非展示逻辑。
// 照那样再写一个客户端只有两条路:整段复制(于是每次改动要同步两处 ——
// 这个项目已经在「同一份事实写两处」上栽过四次:visionAnalyzer、
// pythonExecutor、models.vision、fsDeniedPaths),或者把 CLI 当子进程调
// (那不是客户端,是终端模拟器)。
//
// 三条边界:
// ① **不做任何输出**。装配过程中的告警(venv 不可用、缺基线依赖、
//    没配 WORKSPACE)以 `notices` 数组返回,由壳决定怎么呈现 ——
//    console.log 写在这里就等于把展示逻辑焊死在业务层。
// ② **确认走 async 回调注入**。壳可以是终端 readline,也可以是客户端弹窗
//    (跨进程往返)。`run_command` 的安全性**全部**来自用户读那一行原样命令,
//    所以这个回调不能有默认放行的实现 —— 必须由壳显式提供。
// ③ **dispose 是必须调的**。常驻 chromium 是 detached 的,不随本进程退出;
//    不关会一直锁着 profile 目录导致下次启动失败(实测)。
// ============================================

import path from 'path';
import {
  FileLogger,
  LogLevel,
  loadConfig,
  TraceRecorder,
  Storage,
  type AgentConfig,
  type Logger,
} from '../platform/index.js';
import {
  ToolRegistry,
  ToolRunner,
  type InheritableRunnerConfig,
} from '../tools/index.js';
import {
  PythonExecutor,
  ShellExecutor,
  BrowserManager,
  BrowserOps,
  ToolBridge,
  ensureSandboxVenv,
  checkSandboxDeps,
  defaultReadDenyPaths,
  type BridgeToolResult,
} from '../executors/index.js';
import {
  EchoTool,
  GetCurrentTimeTool,
  ReadFileTool,
  ListFilesTool,
  SearchFilesTool,
  WriteFileTool,
  SpawnSubAgentTool,
  ExecutePythonTool,
  ViewImageTool,
  ScreenshotTool,
  RequestHelpTool,
  RunCommandTool,
} from '../tools/builtin/index.js';
import { ContextManager } from './context.js';
import { DeepSeekAdapter } from './deepseek-adapter.js';
import {
  Orchestrator,
  type AgentRunResult,
  type AgentEventSink,
} from './orchestrator.js';
import { LocalSubAgentRunner } from './sub-agent.js';
import { LocalVisionAnalyzer } from './vision-analyzer.js';
import { MemoryManager } from './memory-manager.js';
import { buildMainSystemPrompt, type EnvironmentOptions } from './system-prompt.js';

/** 装配期的一条提示。壳自己决定用什么颜色、放在哪 */
export interface SessionNotice {
  level: 'warn' | 'info';
  message: string;
  /** 可执行的下一步(如安装命令)。没有则为 undefined */
  hint?: string;
}

/** 确认请求 —— 与 ToolRunner 的 onConfirmRequired 同形 */
export interface ConfirmRequest {
  toolName: string;
  args: Record<string, unknown>;
}

export interface CreateSessionOptions {
  /**
   * 危险工具的确认回调
   *
   * **没有默认实现是刻意的**:`run_command` 没有任何机制边界,
   * 它全部的安全性就是用户读那一行原样命令并判断。给个默认放行
   * 等于让这个边界在某些壳里静默消失。
   */
  onConfirm: (req: ConfirmRequest) => Promise<boolean>;
  /** 会话 id 前缀,用于区分 trace 目录(如 'cli' / 'app') */
  idPrefix?: string;
  /** 覆盖配置(测试用)。不传则从环境变量加载 */
  configOverrides?: Partial<AgentConfig>;
}

/**
 * 装配结果的事实快照 —— 给壳做启动信息展示
 *
 * 这些值全是装配过程中**算出来**的(venv 到底用上没有、实际是哪个解释器、
 * 缺哪些基线依赖),壳自己重算必然错位。之前 `pythonDir` 就踩过这个:
 * 两处各算一份,而错位不报错、只表现成「venv 里装了、代码里 import 不到」。
 */
export interface SessionInfo {
  model: string;
  baseURL?: string;
  converged: boolean;
  /** 实际执行代码的解释器(venv 不可用时是基础解释器) */
  sandboxPython?: string;
  venv: { enabled: boolean; ok: boolean; created: boolean; dir: string };
  deps?: { ok: boolean; missing: string[]; error?: string };
  shellEnabled: boolean;
  /** PATH 前置的解释器目录 —— 装包会落在这儿 */
  pythonDir?: string;
  visionModel?: string;
  browserProfileDir?: string;
  browserCdpUrl?: string;
  readDenyCount: number;
  /** 运行日志的落盘位置。写盘失败时是 undefined(降级为只打终端) */
  logFile?: string;
  /** 只在代码里可调、不出现在工具清单里的那些 */
  bridgedTools: string[];
  compression: { budget: number; source: '显式配置' | '跟随主模型' | '内置兜底' };
}

export interface AgentSession {
  readonly sessionId: string;
  readonly config: AgentConfig;
  readonly logger: Logger;
  readonly recorder: TraceRecorder;
  readonly context: ContextManager;
  readonly memory?: MemoryManager;
  readonly info: SessionInfo;
  /** 装配期的告警 —— 壳决定怎么呈现 */
  readonly notices: readonly SessionNotice[];

  /**
   * 跑一轮。记忆抽取在内部触发(不阻塞返回)
   *
   * `onEvent` 逐轮传而非装配期固定:传了才走流式(见 Orchestrator.deltaSink)。
   * 壳可以只在交互轮次听、单发轮次不听。
   */
  run(input: string, onEvent?: AgentEventSink): Promise<AgentRunResult>;
  /** 中断当前轮次 */
  abort(): void;
  /**
   * 收尾 —— **必须调**
   *
   * 常驻 chromium 是 detached 的,不随本进程退出。不关会一直锁着
   * profile 目录,导致下次启动失败(实测)。
   */
  dispose(): Promise<void>;
}

const LOG_LEVELS = {
  debug: LogLevel.DEBUG,
  info: LogLevel.INFO,
  warn: LogLevel.WARN,
  error: LogLevel.ERROR,
} as const;

/** 只在代码里可调的工具。筛选依据见 tool-bridge.ts 顶部 */
const BRIDGED = ['screenshot', 'view_image'];

/**
 * 装配一次会话
 *
 * 顺序上有几处**隐式依赖**,不是可以随意调换的:
 * - venv 必须先于 PythonExecutor(要拿到实际解释器路径)
 * - 依赖检测必须先于 environment(提示词里的「已预装」要是实况)
 * - 工具桥必须先于 execute_python 注册(它的 description 要带桥的函数签名)
 * - 子 agent runner 必须后于所有执行器(它整份继承 inherited)
 * 这些顺序在原来的 cli.ts 里靠注释维持,抽出来之后仍然如此 ——
 * 靠 `sub-agent.test.ts` 那条「父 runner 能注入的子 agent 全拿得到」兜底。
 */
export async function createAgentSession(
  options: CreateSessionOptions,
): Promise<AgentSession> {
  const config = loadConfig(options.configOverrides ?? {});
  const modelConfig = config.models.main;
  // sessionId 必须先算出来:日志文件要落在这次会话自己的目录里,
  // 与 trace 的 calls/ 和 archive/ 并列
  const sessionId = `${options.idPrefix ?? 'session'}-${Date.now()}`;
  const notices: SessionNotice[] = [];

  // 运行日志落盘。**客户端必须要有这个**:Electron 脱离终端启动时 stdout
  // 没有去处,而 `chromium 启动超时` / `venv 不可用` 这类只存在于运行日志里,
  // trace 文件里根本没有 —— 那时它是唯一能看的东西。
  //
  // 与 trace 共用会话目录但**不受 TRACE_ENABLED 管**:关掉留痕通常是为了
  // 不落盘对话内容(隐私),而运行日志里没有对话内容,却正是排障要的
  const logger = new FileLogger(
    path.join(config.trace.dir, sessionId, 'agent.log'),
    LOG_LEVELS[config.logLevel] ?? LogLevel.INFO,
  );

  if (!modelConfig.apiKey) {
    // 这个是硬失败,不是 notice:没有 key 什么都跑不了
    throw new Error('未设置 DEEPSEEK_API_KEY,无法调用真实 API');
  }

  // 未配工作区 = 所有 fs 工具和代码执行都会被拒,模型会一路试路径撞墙。
  // 判空看内容不看数组长度:未配置时 fsSandboxPaths 是 [''],长度 1 但没有意义,
  // 而空串在路径检查里会解析成 cwd(即整个项目目录)
  if (!config.workspace) {
    notices.push({
      level: 'warn',
      message: 'WORKSPACE 未配置,文件类工具与代码执行将全部被拒绝。',
      hint: `在 .env 里设置,例如: WORKSPACE=${process.cwd()}`,
    });
  }

  const recorder = new TraceRecorder({
    sessionId,
    logger,
    baseDir: config.trace.dir,
    enabled: config.trace.enabled,
  });

  // ---------- 工具注册 ----------
  // CodeAct 收敛:动作空间变成代码后,「代码能做的」不再占工具位 ——
  // 每个工具都要在**每次调用**的 prompt 里付 schema 成本,而且「工具和等价代码
  // 两条路」会让模型的选择不可预测(实测:两条路都开时它一律选工具)。
  // 只在代码通道可用时收敛:没有 execute_python 还删工具就是净损失能力
  const converged = config.python.enabled && config.python.convergeTools;

  const registry = new ToolRegistry(logger);
  if (!converged) {
    registry.register(new EchoTool());
    registry.register(new GetCurrentTimeTool());
    registry.register(new ListFilesTool());
    registry.register(new WriteFileTool());
  }
  // 保留 read_file 与 search_files:它们自带返回量上限,而裸 glob 命中三千个文件
  // 一 print 就撑爆上下文 ——「数据大不大」是领域知识,封在工具里才有效
  registry.register(new ReadFileTool());
  registry.register(new SearchFilesTool());

  // 视觉是**插件**:配了 VISION_MODEL 才有这两个函数。
  // 没配就不注册 —— 暴露一个必然返回 ok:false 的函数只会让模型白花一步
  const visionConfig = config.models.vision;
  if (visionConfig) {
    registry.register(new ViewImageTool());
    if (config.python.enabled) registry.register(new ScreenshotTool());
  }

  // request_help 无条件注册:它不碰浏览器、不需要执行器,只是「暂停交回用户」
  registry.register(new RequestHelpTool());

  // run_command 要两个开关都满足:没有工作区 cwd 会解析成整个项目目录;
  // ALLOW_DANGEROUS_TOOLS=false 时调用会被 runner 直接拒,注册它只让模型白花一步
  const shellEnabled =
    config.shell.enabled && !!config.workspace && config.security.allowDangerousTools;
  if (shellEnabled) {
    registry.register(
      new RunCommandTool(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'),
    );
  }
  if (config.subAgent.enabled) registry.register(new SpawnSubAgentTool());

  const abortController = new AbortController();
  const onConfirmRequired = options.onConfirm;

  // ---------- LLM ----------
  const llmClient = new DeepSeekAdapter({
    apiKey: modelConfig.apiKey,
    baseURL: modelConfig.baseURL!,
    model: modelConfig.model,
    enableThinking: modelConfig.enableThinking ?? true,
    retry: config.retry,
    onTrace: recorder.sink,
    logger,
  });

  // 视觉单独一个 adapter:视觉模型很可能来自另一个 provider,key/baseURL 独立配。
  // 复用 DeepSeekAdapter —— 图片转线格式已经在里面,变的只是「发给谁」
  const visionAnalyzer = visionConfig
    ? new LocalVisionAnalyzer({
        client: new DeepSeekAdapter({
          apiKey: visionConfig.apiKey,
          baseURL: visionConfig.baseURL!,
          model: visionConfig.model,
          // 描述一张图不需要思维链,开着纯烧 token
          enableThinking: visionConfig.enableThinking ?? false,
          retry: config.retry,
          onTrace: recorder.sink,
          logger,
        }),
        modelName: visionConfig.model,
        maxTokens: visionConfig.maxTokens,
        logger,
      })
    : undefined;

  // 子 agent 的上下文配置与主 agent 同构(sessionId/logger 由 runner 各自填)
  const contextTuning = {
    windowSize: config.context.windowSize,
    compressionThreshold: config.context.compressionThreshold,
    recentTurnsToKeep: config.context.recentTurnsToKeep,
    maxTopicsInContext: config.context.maxTopicsInContext,
    highWaterRatio: config.context.highWaterRatio,
    compressionMaxTokens: config.context.compressionMaxTokens,
    modelMaxTokens: modelConfig.maxTokens,
    compressionClip: config.context.compressionClip,
    retry: config.retry,
    // 归档与 LLM 留痕共用会话目录:<dir>/<sessionId>/archive|calls
    sessionsDir: config.trace.dir,
  };

  // ---------- 沙箱 venv(框架托管,不存在则自动创建)----------
  // 为什么框架管而不写进文档让用户跑一条命令:做错的三种方式都不报错在正确的地方 ——
  // 忘了建 → 每次 execute_python 都 spawn ENOENT(模型以为是自己代码错了,实测踩到);
  // 忘了 --system-site-packages → 预装库全丢而代码里的 pip 已被禁,沙箱直接瘫;
  // 平台写错 Scripts/ 或 bin/ → 同第一种。三件都可推导,没理由交给人。
  //
  // 失败不阻塞:回落到基础解释器并告警。没有隔离仍能干活,起不来就什么都干不了
  const venv = config.python.enabled && config.python.useVenv
    ? await ensureSandboxVenv({
        venvDir: config.python.venvDir,
        baseInterpreter: config.python.pythonPath,
        // 只用于校验 venv 不在工作区内 —— 在里面的话模型能改 venv 自身
        workspace: config.workspace || undefined,
        logger,
      })
    : undefined;

  if (venv?.reason) {
    notices.push({ level: 'warn', message: `沙箱 venv 不可用: ${venv.reason}` });
  }

  // 真正执行代码的解释器。venv 可用就用它,否则回落
  const sandboxPython = venv?.ok ? venv.pythonPath : config.python.pythonPath;

  // ---------- 基线依赖检测 ----------
  // 提示词里「沙箱已预装 playwright、pandas…」那句话在开发机上碰巧是真的,
  // 在新机器上是**假的**。模型会照着不存在的前提写代码撞 ImportError,
  // 而代码里的 pip 已被禁,它自己修不了。
  //
  // 只检测、**不自动装**:基线依赖装进的是系统环境(共享资源),自动往里装
  // 等于替用户决定要不要动他别的项目在用的包
  const deps = config.python.enabled
    ? await checkSandboxDeps(sandboxPython, logger)
    : undefined;

  if (deps && !deps.ok) {
    notices.push(
      deps.error
        ? { level: 'warn', message: `沙箱依赖检测失败: ${deps.error}` }
        : {
            level: 'warn',
            message: `沙箱缺少基线依赖: ${deps.missing.join(', ')}`,
            hint: deps.hint,
          },
    );
  }

  // profile 用绝对路径:要同时注入子进程和进读黑名单,相对路径两边解析基准不同
  const browserProfileDir = path.resolve(config.python.browserProfileDir);

  // ---------- 读黑名单(凭证类路径)----------
  // 算一次、两处用(fs 工具的 SecurityGuard + Python 的 audit hook)。
  // **必须同源**:两边各算一份就会出现「工具读不到、代码读得到」这种不报错的错位
  const readDenyPaths = defaultReadDenyPaths({
    projectDir: process.cwd(),
    // profile 里的 cookie 等价于活凭证,比密码更直接(不用过二次验证)
    extra: config.python.enabled ? [browserProfileDir] : [],
  });

  // ---------- 常驻浏览器(CDP)----------
  // 由框架启动而非模型代码启动,浏览器才能跨轮次存活。
  // 顺带消掉一个软边界:模型再没机会自己造 profile 路径
  const browserManager = config.python.enabled
    ? new BrowserManager({
        profileDir: browserProfileDir,
        headless: false,   // 有头:能看见 agent 在做什么,登录引导也自然
        logger,
      })
    : undefined;
  if (browserManager) {
    await browserManager.start();   // 失败只告警,不阻塞
  }

  // ---------- 工具桥(CodeAct)----------
  // 用 describe() 而不是 getAllDescriptions():后者会过滤掉隐藏的工具,
  // 而下面正要隐藏它们 —— 那样桥就拿不到 schema、直接不启动了
  const bridgeTools = registry.describe(
    registry.all().filter(t => BRIDGED.includes(t.name)),
  );

  // 三者构成一个环:桥 → runner → pythonExecutor → 桥。运行时不成问题 ——
  // invoke 只在模型代码真的调工具时才执行,那时 runner 早就建好了。
  // 但类型推断绕不出来,所以这几个声明都显式标注类型
  const toolBridge: ToolBridge | undefined =
    config.python.enabled && bridgeTools.length > 0
      ? new ToolBridge({
          tools: bridgeTools,
          invoke: (name, args): Promise<BridgeToolResult> => runner.run({ name, args }),
          logger,
        })
      : undefined;

  let bridgedActive: string[] = [];
  if (toolBridge && (await toolBridge.start())) {
    // 桥起来了**才**隐藏:顺序很重要。桥启动失败时不能隐藏 ——
    // 否则模型两条路都没有了(工具清单里没有、代码里的函数也连不上)。
    // 实测:两条路都开时模型一律直接发 tool_call,代码那条根本走不到,
    // 所以隐藏是无条件的、不留开关。工具仍留在注册表:桥的 invoke 要按名字查
    registry.hide(BRIDGED);
    bridgedActive = [...BRIDGED];
  }

  // execute_python 特意在这里注册:它的 description 要带上桥暴露的函数签名,
  // 而签名由桥从工具 schema 生成,所以必须等桥建好
  if (config.python.enabled) {
    registry.register(new ExecutePythonTool(toolBridge?.signatures ?? []));
  }

  // 没有工作区就不创建执行器:workDir 为空串会让 path.resolve 解析成 cwd,
  // 写边界随之变成整个项目目录。缺配置时宁可代码执行不可用,不可越界
  const pythonExecutor: PythonExecutor | undefined =
    config.python.enabled && config.workspace
      ? new PythonExecutor({
          pythonPath: sandboxPython,
          // 与 fs 白名单同源:cwd 和写边界都用 workspace
          workDir: config.workspace,
          timeout: config.python.timeout,
          maxStdoutBytes: config.python.maxStdoutBytes,
          maxStderrBytes: config.python.maxStderrBytes,
          env: {
            // 模型代码里读 os.environ,不硬编码路径
            BROWSER_PROFILE_DIR: browserProfileDir,
            // 空串表示浏览器没起来,模型代码会拿到连接失败并改道
            BROWSER_CDP_URL: browserManager?.cdpUrl ?? '',
          },
          blockPipInstall: config.python.blockPipInstall,
          readDenyPaths,
          toolBridge,
          logger,
        })
      : undefined;

  // ---------- Shell 执行器 ----------
  // PATH 前置 venv 的 Scripts/bin:**这一步不做,前面的 venv 隔离就白做了** ——
  // shell 从 PATH 找 pip 会找到全局那个,装回用户机器上(实测:模型装的
  // rapidocr 顺带升级了全局 onnxruntime)。
  // 从**实际使用的**解释器推导,两处各自算必然错位而且不报错
  const pythonDir = /[\\/]/.test(sandboxPython)
    ? path.dirname(path.resolve(sandboxPython))
    : undefined;

  const shellExecutor: ShellExecutor | undefined = shellEnabled
    ? new ShellExecutor({
        workDir: config.workspace,
        timeout: config.shell.timeout,
        maxStdoutBytes: config.shell.maxStdoutBytes,
        maxStderrBytes: config.shell.maxStderrBytes,
        pathPrepend: pythonDir ? [pythonDir] : [],
        // 刻意**不设** PIP_NO_INDEX:这里是装包的正式通道,pip 要能联网
        logger,
      })
    : undefined;

  // ---------- 资源与安全边界(主 agent 与子 agent 共用同一份)----------
  // 抽成一个对象而不是两处各写一遍:逐字段转发实测漏过两次 ——
  // 先漏 visionAnalyzer,又漏 pythonExecutor,后者让子 agent 每次
  // execute_python 返回「未初始化」,它以为是自己代码的问题,白烧十几步
  const inherited: InheritableRunnerConfig = {
    allowDangerousTools: config.security.allowDangerousTools,
    fsGrants: config.security.fsGrants,
    fsDeniedPaths: readDenyPaths,
    workspace: config.workspace || undefined,
    pythonExecutor,
    shellExecutor,
    // 浏览器操作复用 PythonExecutor 跑框架自己写的脚本 ——
    // TS 侧不再引一份 playwright,而 Python 侧本来就装着
    browserOps: pythonExecutor && browserManager?.cdpUrl
      ? new BrowserOps(pythonExecutor, browserManager.cdpUrl)
      : undefined,
    visionAnalyzer,
  };

  // ---------- 运行环境(主/子 agent 提示词同源)----------
  const environment: EnvironmentOptions = {
    converged,
    pythonEnabled: config.python.enabled,
    visionModel: visionConfig?.model,
    shellEnabled,
    // 提示里的「已预装」必须是实况,与启动检测同源
    missingPackages: deps?.missing ?? [],
  };

  // 必须建在所有执行器之后:它整份继承 inherited
  const subAgentRunner = config.subAgent.enabled
    ? new LocalSubAgentRunner(llmClient, registry, {
        parentSessionId: sessionId,
        logger,
        signal: abortController.signal,
        onConfirmRequired,
        inherited,
        environment,
        maxSteps: config.subAgent.maxSteps,
        maxCount: config.subAgent.maxCount,
        contextConfig: contextTuning,
      })
    : undefined;

  const runner: ToolRunner = new ToolRunner(registry, {
    ...inherited,
    sessionId,
    logger,
    signal: abortController.signal,
    onConfirmRequired,
    subAgentRunner,
  });

  // ---------- 上下文 ----------
  const context = new ContextManager({ ...contextTuning, sessionId, logger }, llmClient);
  await context.initialize();

  const orchestrator = new Orchestrator(llmClient, runner, registry, {
    maxSteps: config.execution.maxSteps,
    logger,
    context,
  });

  // ---------- 长期记忆 ----------
  // 起不来只告警不阻塞:记忆是增强,不该让会话因为它跑不了
  let memoryStorage: Storage | undefined;
  let memory: MemoryManager | undefined;
  if (config.memory.enabled) {
    try {
      memoryStorage = new Storage(config.memory.dbPath, logger);
      memory = new MemoryManager({
        store: memoryStorage,
        llmClient,
        logger,
        turnsPerExtraction: config.memory.turnsPerExtraction,
        maxTokens: config.memory.maxTokens,
        retry: config.retry,
      });
    } catch (e) {
      notices.push({
        level: 'warn',
        message: `长期记忆不可用: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  // 系统提示只在会话开始时加一次。后续每轮只传 user 消息,
  // 让 ContextManager 接到同一个 Turn 序列上(压缩才能真正生效)。
  //
  // 记忆拼在环境约定**之后**:它是「关于这位用户」的观察而非环境事实,
  // 混在一段里模型分不清哪些是硬约束
  context.addSystemMessage(
    buildMainSystemPrompt({
      ...environment,
      subAgentEnabled: config.subAgent.enabled,
    }) + (memory?.prompt() ? '\n\n' + memory.prompt() : ''),
  );

  const compBudget = config.context.compressionMaxTokens ?? modelConfig.maxTokens ?? 4000;
  const info: SessionInfo = {
    model: modelConfig.model,
    baseURL: modelConfig.baseURL,
    converged,
    sandboxPython: config.python.enabled ? sandboxPython : undefined,
    venv: {
      enabled: config.python.enabled && config.python.useVenv,
      ok: !!venv?.ok,
      created: !!venv?.created,
      dir: config.python.venvDir,
    },
    deps: deps ? { ok: deps.ok, missing: deps.missing, error: deps.error } : undefined,
    shellEnabled,
    pythonDir,
    visionModel: visionConfig?.model,
    browserProfileDir: config.python.enabled ? browserProfileDir : undefined,
    browserCdpUrl: browserManager?.cdpUrl || undefined,
    readDenyCount: readDenyPaths.length,
    logFile: logger.filePath,
    bridgedTools: bridgedActive,
    compression: {
      budget: compBudget,
      source: config.context.compressionMaxTokens
        ? '显式配置'
        : modelConfig.maxTokens ? '跟随主模型' : '内置兜底',
    },
  };

  return {
    sessionId,
    config,
    logger,
    recorder,
    context,
    memory,
    info,
    notices,

    async run(input: string, onEvent?: AgentEventSink) {
      const result = await orchestrator.run(
        [{ role: 'user', content: input }],
        onEvent,
      );
      // 记忆抽取:**不 await** —— 它要调一次 LLM(几秒),
      // 挡在这里会让用户干等一个与本轮无关的调用。
      // onTurnEnd 内部不抛异常(记忆是增强不是必需品)
      if (memory) void memory.onTurnEnd(context.peekTurns());
      return result;
    },

    abort() {
      abortController.abort();
    },

    async dispose() {
      context.dispose();
      // SQLite 句柄不关会留下 -wal/-shm 文件
      memoryStorage?.close();
      // 常驻浏览器是 detached 的,不随本进程退出。留下来会一直锁着
      // profile 目录,导致下次启动失败
      await browserManager?.stop();
      await toolBridge?.stop();
    },
  };
}