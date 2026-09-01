// ============================================
// Core 层:AgentSession —— 一次会话的全部接线
// ============================================
//
// 这个模块的存在是为了兑现架构文档第一条:「交互层(壳)可替换 ——
// Electron / 语音 / GUI 只做输入→文本与结果→展示,零业务逻辑」。
//
// 抽出来之前那条不成立:早期入口有 937 行、21 段接线(配置、留痕、工具注册、
// LLM、视觉、venv、依赖检测、Python 沙箱、读黑名单、常驻浏览器、工具桥、
// shell、安全边界、环境提示、上下文、长期记忆…),全是业务装配而非展示逻辑。
// 照那样再写一个客户端只有两条路:整段复制(于是每次改动要同步两处 ——
// 这个项目已经在「同一份事实写两处」上栽过四次:visionAnalyzer、
// pythonExecutor、models.vision、fsDeniedPaths),或者把旧命令行壳当子进程调
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
  LoadSkillTool,
} from '../tools/builtin/index.js';
import { ContextManager, type Turn } from './context.js';
import { turnsFile, readTurns, appendTurn } from './session-store.js';
import { DeepSeekAdapter } from './deepseek-adapter.js';
import {
  Orchestrator,
  type AgentRunResult,
  type AgentEventSink,
} from './orchestrator.js';
import { LocalSubAgentRunner } from './sub-agent.js';
import { LocalVisionAnalyzer } from './vision-analyzer.js';
import { MemoryManager } from './memory-manager.js';
import { SkillManager } from './skill-manager.js';
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
  /**
   * 技能库变动的通知 —— 壳用它刷新待审批角标
   *
   * 必须是推送而不是让壳轮询:沉淀在 run() 返回**之后**才完成
   * (那一步是 void 调用的,要等一次 LLM),壳在轮末自己拉列表
   * 一定拉不到刚沉淀的那条。
   */
  onSkillsChanged?: () => void;
  /** 会话 id 前缀,用于区分 trace 目录(如 'cli' / 'app') */
  idPrefix?: string;
  /** 覆盖配置(测试用)。不传则从环境变量加载 */
  configOverrides?: Partial<AgentConfig>;
  /**
   * 外部提供的常驻浏览器 —— 传它则本会话**不创建也不关闭**浏览器
   *
   * 为什么需要这个:浏览器是**进程级**资源,不属于某次对话。默认由 session
   * 自己创建时,切会话(整个 session 拆了重建)会连带重启 chromium ——
   * 窗口跳一下、几秒等待,而且**页面停留位置丢了**(登录态在 profile 里能留住,
   * 停在哪一页留不住,而那正是常驻浏览器存在的理由)。
   *
   * 所有权规则:谁创建谁关闭。传进来的实例由调用方(客户端主进程)在退出时
   * 关掉 —— 它是 detached 的,不关会一直锁着 profile 目录导致下次启动失败。
   */
  browserManager?: BrowserManager;
  /**
   * 续接一个已有会话 —— 传它则不新建 sessionId,而是沿用并灌回历史轮次
   *
   * 沿用同一个 id(而不是新建一个再把历史抄过去)是刻意的:
   * turns.jsonl / calls/ / archive/ / agent.log 都按 sessionId 分目录,
   * 新建 id 会让同一段对话的产物散在两个目录里,排障时对不上。
   *
   * 历史读不出来时**不静默新建**:那样用户以为在续聊、实际模型什么都不记得。
   * 走 notices 明说。
   */
  resumeSessionId?: string;
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
  /**
   * 技能库 —— 壳靠它做审批
   *
   * 沉淀出来的轨迹一律 pending,审批前不进索引、load_skill 也取不到。
   * 没有这个出口的话功能等于不存在:沉淀会发生、会写进库,但用户看不到也批不了。
   */
  readonly skills?: SkillManager;
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
  /**
   * 完整原始对话 —— 给壳做历史展示
   *
   * 从 turns.jsonl 读,**不是** `context.peekTurns()`:后者被压缩截断过
   * (旧轮次已移出内存、只剩一条 60 字检索索引)。
   * 前端显示用户真实说过的话,模型请求走压缩那套 —— 两条路分开。
   */
  history(): Turn[];
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

/**
 * 建一个常驻浏览器并启动
 *
 * 抽成导出函数是为了让**壳**也能建:客户端要把它提到进程级(跨会话共享),
 * 而 profile 路径的解析规则只能有一份 —— 壳自己拼一次必然错位,
 * 而错位不报错,只表现成「读黑名单挡不住 cookie」或「模型代码连不上浏览器」。
 * 本项目已在「同一份事实写两处」上栽过四次。
 *
 * 启动失败不抛异常:没有浏览器仍能干别的活,而抛出去会让整个会话起不来。
 */
export async function createSharedBrowser(
  config: AgentConfig,
  logger: Logger,
): Promise<BrowserManager> {
  const manager = new BrowserManager({
    profileDir: path.resolve(config.python.browserProfileDir),
    headless: false,   // 有头:能看见 agent 在做什么,登录引导也自然
    logger,
  });
  await manager.start();
  return manager;
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
 * 这些顺序在早期入口里靠注释维持,抽出来之后仍然如此 ——
 * 靠 `sub-agent.test.ts` 那条「父 runner 能注入的子 agent 全拿得到」兜底。
 */
export async function createAgentSession(
  options: CreateSessionOptions,
): Promise<AgentSession> {
  const config = loadConfig(options.configOverrides ?? {});
  const modelConfig = config.models.main;
  // sessionId 必须先算出来:日志文件要落在这次会话自己的目录里,
  // 与 trace 的 calls/ 和 archive/ 并列。
  // 续接时沿用原 id —— 否则同一段对话的产物会散在两个目录里
  const sessionId =
    options.resumeSessionId ?? `${options.idPrefix ?? 'session'}-${Date.now()}`;
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

  /**
   * 中断控制器 —— **每轮一个**,不是整个会话一个
   *
   * AbortController 一旦 abort 就**永久失效**。会话级只建一个的话:
   * 用户点过一次「停止」之后,这个会话里后续每一次 LLM 请求和工具调用
   * 都带着那个已中止的信号发出去 —— 表现成「点过一次停止,之后什么都跑不了」,
   * 而且不报错,只是每一步都立刻返回。
   *
   * 所以下游一律拿 getSignal() 现取,而不是存一份 AbortSignal。
   * run() 在开头换新的,abort() 只作用于当前这一轮。
   */
  let runAbort = new AbortController();
  const getSignal = () => runAbort.signal;
  const onConfirmRequired = options.onConfirm;

  // ---------- LLM ----------
  const llmClient = new DeepSeekAdapter({
    apiKey: modelConfig.apiKey,
    baseURL: modelConfig.baseURL!,
    model: modelConfig.model,
    enableThinking: modelConfig.enableThinking ?? true,
    // 这两项**必须**在这里注入,否则主循环的请求体里根本没有它们:
    // adapter 原先只认 request.maxTokens/temperature,而 orchestrator 两处
    // complete() 都不传 —— 于是 MAIN_MAX_TOKENS / MAIN_TEMPERATURE 配了等于没配。
    // trace 实证:配了 256,某次输出仍有 14485 个 completion token
    maxTokens: modelConfig.maxTokens,
    temperature: modelConfig.temperature,
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
  //
  // 外部传了就复用,**且不由本会话关闭**(见 options.browserManager)——
  // 客户端把它提到进程级,于是切会话不再重启 chromium。
  // 注:传进来的实例必须用同一份 config 创建,否则它的 profile 目录
  // 与下面读黑名单/env 注入用的 browserProfileDir 不一致(而错位不报错)
  const ownsBrowser = !options.browserManager;
  const browserManager = options.browserManager
    ?? (config.python.enabled ? await createSharedBrowser(config, logger) : undefined);

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
          beforeRun: async () => {
            if (!browserManager) return undefined;
            const before = browserManager.cdpUrl;
            const ok = await browserManager.ensureAlive();
            const after = ok ? browserManager.cdpUrl : '';
            if (before && after && before !== after) {
              logger.info('常驻浏览器已恢复,CDP 地址已刷新', {
                before,
                after,
              });
            }
            return { BROWSER_CDP_URL: after };
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

  // ---------- 持久化存储(记忆与技能共用一个文件)----------
  //
  // 必须建在 `inherited` **之前**:技能读取要作为 skillReader 进那个对象,
  // 而 SkillManager 需要这个 store。三者的依赖顺序是
  // Storage → SkillManager → inherited,不能反。
  //
  // 建不建看**两个开关的并集**,不是只看 memory:
  // 只开 skill 不开 memory 时若跳过建库,技能会静默失效(不报错,
  // 只是索引永远为空、沉淀永远不发生)。
  //
  // 起不来只告警不阻塞 —— 记忆和技能都是增强,不该让会话因为它们跑不了。
  // 技能与记忆同库不同 key:better-sqlite3 的 ABI 要跟着 Electron 重编,
  // 不必为此再引一个存储依赖。
  let sharedStorage: Storage | undefined;
  let memory: MemoryManager | undefined;
  let skillManager: SkillManager | undefined;

  if (config.memory.enabled || config.skill.enabled) {
    try {
      sharedStorage = new Storage(config.memory.dbPath, logger);
    } catch (e) {
      notices.push({
        level: 'warn',
        message: `持久化存储不可用,长期记忆与技能库均已停用: ${
          e instanceof Error ? e.message : String(e)
        }`,
      });
    }
  }

  if (sharedStorage && config.memory.enabled) {
    try {
      memory = new MemoryManager({
        store: sharedStorage,
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

  if (sharedStorage && config.skill.enabled) {
    try {
      skillManager = new SkillManager({
        store: sharedStorage,
        llmClient,
        logger,
        minToolSteps: config.skill.minToolSteps,
        maxTokens: config.skill.maxTokens,
        retry: config.retry,
        onChanged: options.onSkillsChanged,
      });
    } catch (e) {
      notices.push({
        level: 'warn',
        message: `技能库不可用: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  // load_skill 在**这里**注册,不在上面那一批里 —— 它要等 skillManager 建好。
  //
  // 只有真装配起来了才注册:注册一个必然返回 ok:false 的工具会让模型
  // 白花一步去试(与视觉插件「没配 VISION_MODEL 就不注册」同一条判断)。
  //
  // **不受 converged 影响**,两种模式下都注册。收敛针对的是「能力重复」——
  // 工具与等价代码两条路,而实测两条都开时模型一律选工具。
  // 但技能库从沙箱不可达,execute_python 里没有任何办法拿到轨迹,
  // 不存在第二条路,收敛的前提不成立。
  if (skillManager) registry.register(new LoadSkillTool());

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
      ? new BrowserOps(pythonExecutor, () => browserManager.cdpUrl)
      : undefined,
    visionAnalyzer,
    // 子 agent **能读**轨迹(它干的活同样需要流程指引),但拿不到写入能力 ——
    // SkillReader 接口只有 load(),沉淀是主 agent 的轮末动作。
    // 与「子 agent 拿不到 spawn」同一条原则:能力从结构上不给
    skillReader: skillManager,
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
        // 传取信号的**函数**,不传 AbortSignal —— 子 agent runner 也是会话级的,
        // 存一份就会在用户点过一次停止之后永久失效
        getSignal,
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
    getSignal,
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
    // 主循环靠它把信号传进每次 LLM 请求 —— 没有这条,「停止」最快也只能
    // 等当前这步跑完(十几秒到一分钟)
    getSignal,
  });

  // 记忆与技能的装配已移到 `inherited` 之前 ——
  // skillReader 要进那个对象,而它依赖 sharedStorage(见那一段的注释)

  // 系统提示只在会话开始时加一次。后续每轮只传 user 消息,
  // 让 ContextManager 接到同一个 Turn 序列上(压缩才能真正生效)。
  //
  // 记忆拼在环境约定**之后**:它是「关于这位用户」的观察而非环境事实,
  // 混在一段里模型分不清哪些是硬约束
  // 技能索引拼在**最后**:它是「以前怎么做成的」,而记忆是「关于这位用户」,
  // 环境约定才是硬约束。三段的确定性递减,顺序照此排。
  //
  // 只拼**索引**(名字 + 一行描述),正文由 load_skill 按需取 ——
  // 系统提示是 prompt cache 前缀里最稳定的部分(实测命中率 60~77%),
  // 每轮注入不同的正文会让整段前缀失效,那个代价比多一次工具调用大得多。
  const skillIndex = skillManager?.prompt() ?? '';

  context.addSystemMessage(
    buildMainSystemPrompt({
      ...environment,
      subAgentEnabled: config.subAgent.enabled,
    })
    + (memory?.prompt() ? '\n\n' + memory.prompt() : '')
    + (skillIndex ? '\n\n' + skillIndex : ''),
  );

  // ---------- 历史轮次(续接会话)----------
  // 必须在 addSystemMessage() **之后**:system 消息要留在 messages[0],
  // restoreTurns 是往后 append
  const historyFile = turnsFile(config.trace.dir, sessionId);
  // 声明在 if 之外:下面算 lastPersistedTurnId 要用它
  let restoredHistory: Turn[] = [];
  if (options.resumeSessionId) {
    restoredHistory = readTurns(historyFile);
    if (restoredHistory.length === 0) {
      // 不静默新建:用户以为在续聊、模型却什么都不记得,是最坏的形态
      notices.push({
        level: 'warn',
        message: `会话 ${options.resumeSessionId} 没有可恢复的历史,已按新会话开始。`,
      });
    } else {
      context.restoreTurns(restoredHistory);
    }
  }

  /**
   * 把还没落盘的轮次追加进 turns.jsonl
   *
   * 用 turn_id 判断写到哪了,**不能用条数**:压缩会把旧轮次移出
   * `this.turns`(runCompression 里 `this.turns = recentTurns`),
   * 于是 peekTurns() 的长度会**变小** —— 按条数比对会漏掉压缩之后的每一轮。
   *
   * 靠 peekTurns() 而不是等 finalizeTurn():后者只在 addUserMessage() 里调,
   * 一轮要等下一条用户消息才入库,那样**每个会话的最后一轮永远不落盘**。
   * 这与 peekTurns 那个 bug 是同一个形态。
   */
  // 续接时从已恢复的轮次里取最大 turn_id 作为起点。
  // 取 max 而不是 length:文件里可能有坏行被跳过,那样 length 会偏小、
  // 于是已存在的轮次被重复追加一遍
  let lastPersistedTurnId = restoredHistory.reduce(
    (max: number, t: Turn) => (t.turn_id > max ? t.turn_id : max),
    0,
  );

  function persistNewTurns(): void {
    for (const turn of context.peekTurns()) {
      if (turn.turn_id <= lastPersistedTurnId) continue;
      // 写失败不抛也不重试:历史是增强,不能让存不下来变成任务失败。
      // 但要留痕,否则「历史怎么少了几轮」无从查起
      if (appendTurn(historyFile, turn)) {
        lastPersistedTurnId = turn.turn_id;
      } else {
        logger.warn('历史轮次写盘失败', { turn_id: turn.turn_id, file: historyFile });
      }
    }
  }

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
    skills: skillManager,
    info,
    notices,

    async run(input: string, onEvent?: AgentEventSink) {
      // 换一个新的 controller —— 这一行是「停止」能反复用的全部原因。
      // 不换的话上一轮 abort 过的信号会一直生效,后续每轮的请求
      // 一发出去就被立刻掐掉,表现成「点过一次停止,之后什么都跑不了」
      runAbort = new AbortController();

      const result = await orchestrator.run(
        [{ role: 'user', content: input }],
        onEvent,
      );

      // 被中断的轮次**整轮丢掉**,既不落盘也不进记忆。
      //
      // 必须在 persistNewTurns() 之前:那个函数遍历 peekTurns(),
      // 而 peekTurns 会把「已有 assistant 消息」的 currentTurn 也算进去 ——
      // 也就是说跑过几步工具再停的轮次会被写进 turns.jsonl,
      // 成为一条没有结论的半截历史。
      //
      // 丢掉也是为了下一轮:留在内存里的话 addUserMessage() 会把它封进 turns,
      // 模型看到「提问 → 调了几个工具 → 没有结论」,很可能接着往下干 ——
      // 而用户点停止恰恰是不想要那个结果。
      //
      // 代价是明确的:那一轮的 token 已经付过,工具抓到的东西也一起没了。
      // 这是用户的选择 —— 停掉的东西不留痕。
      if (result.stopReason === 'aborted') {
        context.discardCurrentTurn();
        return result;
      }

      // 历史落盘。**在记忆抽取之前**且同步做完:抽取是 void 不 await 的,
      // 而这一步必须在 run() 返回前完成 —— 用户可能立刻关窗口
      persistNewTurns();

      // 记忆抽取:**不 await** —— 它要调一次 LLM(几秒),
      // 挡在这里会让用户干等一个与本轮无关的调用。
      // onTurnEnd 内部不抛异常(记忆是增强不是必需品)
      if (memory) void memory.onTurnEnd(context.peekTurns());

      // 技能沉淀:同样**不 await**、同样不抛异常。
      //
      // 时机必须在这里,不能更晚:两个计数器会在下一次 addUserMessage()
      // 清零(那是轮边界),挪到 run() 之外读就永远是 0。
      //
      // 轨迹取 peekTurns() 的最后一项 —— 刚结束那轮此刻还挂在 currentTurn 上,
      // 而 peekTurns 会把它算进去(这正是它存在的理由)。
      if (skillManager) {
        const turns = context.peekTurns();
        void skillManager.onTurnEnd(
          turns[turns.length - 1],
          context.getStats().currentTurn,
          result.stopReason,
        );
      }
      return result;
    },

    history() {
      // 从文件读而非返回 context.peekTurns():后者被压缩截断过,
      // 而前端要显示的是**完整原始对话**(这正是两条路分开的意义)
      return readTurns(historyFile);
    },

    abort() {
      // 只中止**当前这一轮**。下一轮 run() 会换一个新的 controller ——
      // 不换的话点过一次停止之后整个会话都发不出请求了(AbortController
      // 一旦 abort 就永久失效)
      runAbort.abort();
    },

    async dispose() {
      context.dispose();
      // SQLite 句柄不关会留下 -wal/-shm 文件。
      // 记忆与技能共用这一个实例,所以只关一次
      sharedStorage?.close();
      // 常驻浏览器是 detached 的,不随本进程退出。留下来会一直锁着
      // profile 目录,导致下次启动失败。
      // **只关自己创建的那个**:外部注入的由调用方负责(谁创建谁关闭)——
      // 在这里关掉共享实例会让切会话之后的会话拿到一个死的 CDP 地址
      if (ownsBrowser) await browserManager?.stop();
      await toolBridge?.stop();
    },
  };
}
