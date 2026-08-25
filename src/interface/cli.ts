// ============================================
// Interface 层:CLI(本地效果测试入口)
// ============================================
//
// 职责：
// 1. 读 stdin 的多轮输入 → 交给 Orchestrator → 展示结果（壳，零业务逻辑）
// 2. 每轮回显可观测数值：token / 压缩是否触发 / 主题数 / 工具调用 / 耗时
// 3. 原始上下文和响应由 TraceRecorder 落盘，终端只给摘要 + 文件路径
//
// 关键设计：
// - 多轮共享同一个 ContextManager：反复调 orchestrator.run() 即可，
//   第二轮起只传单条 user 消息，会接到同一个 Context 上（压缩因此能真正触发）
// - 危险工具走真实终端确认，不再无条件放行（交互式测试与跑脚本的本质区别）
// - 空白名单会让所有 fs 工具被拒，启动时显式告警而不是让模型撞墙
//
// 用法：
//   npm run cli                  交互模式（REPL）
//   npm run cli -- "任务描述"     单发模式，跑完即退
//
// 斜杠命令见 HELP 常量。配置参数见 .env.example
// ============================================

import 'dotenv/config';
import readline from 'readline';
import path from 'path';
import {
  ConsoleLogger,
  LogLevel,
  loadConfig,
  TraceRecorder,
  type TraceSummary,
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
  SANDBOX_DEPS,
  type BridgeToolResult,
} from '../executors/index.js';
import {
  ContextManager,
  DeepSeekAdapter,
  Orchestrator,
  LocalSubAgentRunner,
  LocalVisionAnalyzer,
  buildMainSystemPrompt,
  messageToText,
  type EnvironmentOptions,
} from '../core/index.js';
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

const HELP = `
可用命令：
  /stats     显示上下文与 token 统计
  /trace     显示最近一次 LLM 调用的摘要与文件路径
  /calls     列出本次会话所有 LLM 调用
  /context   打印当前发送给模型的消息结构
  /help      显示本帮助
  /exit      退出（Ctrl+C 亦可）

直接输入文字即为向 Agent 提问。
`.trim();

// ---------- 展示辅助 ----------

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

function dim(s: string) { return `${DIM}${s}${RESET}`; }
function bold(s: string) { return `${BOLD}${s}${RESET}`; }

function fmtTokens(n?: number): string {
  if (n === undefined) return '-';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

/** 一次 LLM 调用的单行摘要 */
function fmtCall(s: TraceSummary): string {
  const parts = [
    dim(`#${s.callIndex}`),
    s.label.padEnd(24).slice(0, 24),
    `${String(s.durationMs).padStart(6)}ms`,
    `in ${fmtTokens(s.promptTokens).padStart(6)}`,
    `out ${fmtTokens(s.completionTokens).padStart(5)}`,
  ];
  if (s.cachedTokens) parts.push(dim(`cache ${fmtTokens(s.cachedTokens)}`));
  if (s.attempts && s.attempts > 1) parts.push(`${YELLOW}重试 ${s.attempts - 1} 次${RESET}`);
  if (s.toolCalls.length > 0) parts.push(`${CYAN}→ ${s.toolCalls.join(', ')}${RESET}`);
  if (s.hasReasoning) parts.push(dim('reasoning'));
  if (s.failed) parts.push(`${RED}失败: ${s.errorMessage ?? ''}${RESET}`);
  return '  ' + parts.join('  ');
}

async function main() {
  const singleShot = process.argv.slice(2).join(' ').trim();

  // ---------- 配置 ----------
  const config = loadConfig();

  const logLevel = ({
    debug: LogLevel.DEBUG,
    info: LogLevel.INFO,
    warn: LogLevel.WARN,
    error: LogLevel.ERROR,
  } as const)[config.logLevel] ?? LogLevel.INFO;

  const logger = new ConsoleLogger(logLevel);
  const modelConfig = config.models.main;
  const sessionId = `cli-${Date.now()}`;

  if (!modelConfig.apiKey) {
    console.error(`${RED}未设置 DEEPSEEK_API_KEY,无法调用真实 API${RESET}`);
    process.exit(1);
  }

  // 未配置工作区 = 所有 fs 工具都会被拒绝，模型会一路试路径撞墙并白烧 token。
  // 这是踩过的坑，必须显式告警。
  //
  // 判空要看内容而不是数组长度：workspace 未配置时 fsSandboxPaths 是 ['']，
  // 长度为 1 但没有意义 —— 而空串在路径检查里会被解析成 cwd（即整个项目目录）。
  if (!config.workspace) {
    console.warn(
      `${YELLOW}警告: WORKSPACE 未配置,文件类工具与代码执行将全部被拒绝。${RESET}\n` +
      `${DIM}      在 .env 里设置,例如: WORKSPACE=${process.cwd()}${RESET}`
    );
  }

  // ---------- 留痕 ----------
  const recorder = new TraceRecorder({
    sessionId,
    logger,
    baseDir: config.trace.dir,
    enabled: config.trace.enabled,
  });

  // ---------- 工具 ----------
  //
  // CodeAct 收敛：动作空间变成代码后，「代码能做的」不再占工具位 ——
  // 每个工具都要在**每次调用**的 prompt 里付 schema 成本，而且「工具和等价代码
  // 两条路」会让模型的选择不可预测（实测：两条路都开时它一律选工具）。
  //
  // 去掉的四个都有一行等价代码：datetime.now() / open(...,'w') / glob / print。
  // 保留 read_file 与 search_files：它们自带返回量上限，而裸 glob 命中三千个文件
  // 一 print 就撑爆上下文 ——「数据大不大」是领域知识，封在工具里才有效。
  //
  // 只在代码通道可用时收敛：没有 execute_python 还删工具就是净损失能力
  const converged = config.python.enabled && config.python.convergeTools;

  const registry = new ToolRegistry(logger);
  if (!converged) {
    registry.register(new EchoTool());
    registry.register(new GetCurrentTimeTool());
    registry.register(new ListFilesTool());
    registry.register(new WriteFileTool());
  }
  registry.register(new ReadFileTool());
  registry.register(new SearchFilesTool());
  // 视觉是**插件**：配了 VISION_MODEL 才有这两个函数。
  // 没配就不注册 —— 暴露一个必然返回 ok:false 的函数只会让模型白花一步
  const visionConfig = config.models.vision;
  if (visionConfig) {
    registry.register(new ViewImageTool());
    // screenshot 还需要常驻浏览器（截图由 BrowserOps 经 Python 跑）
    if (config.python.enabled) {
      registry.register(new ScreenshotTool());
    }
  }
  // request_help 无条件注册：它不碰浏览器、不需要任何执行器，
  // 只是「暂停并把控制权交回用户」。将来非浏览器场景同样能用
  registry.register(new RequestHelpTool());
  // run_command：外部程序的正式通道（装包主要靠它）。
  // 没有工作区就不注册 —— cwd 会解析成 cwd（整个项目目录）
  //
  // 它是 danger 工具，ALLOW_DANGEROUS_TOOLS=false 时调用会被 runner 直接拒。
  // 那种情况下注册它只会让模型白花一步，所以两个开关都要满足。
  // Windows 上 shell:true 用的是 cmd.exe，要告诉模型 —— 它按 bash 习惯写
  // `ls`/`$VAR` 会失败，而那种失败看起来像「工具坏了」，很难自己纠偏
  const shellEnabled =
    config.shell.enabled && !!config.workspace && config.security.allowDangerousTools;
  if (shellEnabled) {
    registry.register(
      new RunCommandTool(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'),
    );
  }
  if (config.subAgent.enabled) {
    registry.register(new SpawnSubAgentTool());
  }

  const abortController = new AbortController();

  // 危险工具的真实终端确认（复用主 rl，避免两个 readline 抢 stdin）
  let confirmFn: (prompt: string) => Promise<boolean>;

  const onConfirmRequired = async (req: { toolName: string; args: Record<string, unknown> }) => {
    const detail = JSON.stringify(req.args);
    return confirmFn(`${YELLOW}需要确认${RESET} ${req.toolName} ${dim(detail)}`);
  };

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

  // ---------- 视觉插件 ----------
  // 单独一个 adapter：视觉模型很可能来自另一个 provider，key/baseURL 都可独立配。
  // 复用 DeepSeekAdapter —— 图片转线格式（data URL 前缀、detail 透传）已经在里面，
  // 变的只是「发给谁」。留痕也共用 recorder.sink，视觉调用在 trace 里可查
  const visionAnalyzer = visionConfig
    ? new LocalVisionAnalyzer({
        client: new DeepSeekAdapter({
          apiKey: visionConfig.apiKey,
          baseURL: visionConfig.baseURL!,
          model: visionConfig.model,
          // 描述一张图不需要思维链，开着纯烧 token
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

  // 子 agent 的上下文配置与主 agent 同构（sessionId/logger 由 runner 各自填）
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
    // 归档与 LLM 留痕共用会话目录：<dir>/<sessionId>/archive|calls
    sessionsDir: config.trace.dir,
  };

  // 注：子 agent 执行器的构造挪到 pythonExecutor 之后了 ——
  // 它要整份继承 inherited（含 pythonExecutor），必须等那些资源建好

  // ---------- 沙箱 venv（框架托管，不存在则自动创建）----------
  //
  // 为什么框架管而不写进文档让用户跑一条命令：做错的三种方式都不报错在正确的地方 ——
  // 忘了建 → 每次 execute_python 都 spawn ENOENT（模型以为是自己代码错了，实测踩到）；
  // 忘了 --system-site-packages → 预装库全丢而代码里的 pip 已被禁，沙箱直接瘫；
  // 平台写错 Scripts/ 或 bin/ → 同第一种。三件都可推导，没理由交给人。
  //
  // 失败不阻塞启动：回落到基础解释器并告警。没有隔离仍能干活，CLI 起不来就什么都干不了
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
    console.warn(`${YELLOW}警告${RESET} 沙箱 venv 不可用: ${venv.reason}`);
  }

  // 真正执行代码的解释器。venv 可用就用它，否则回落到基础解释器
  const sandboxPython = venv?.ok ? venv.pythonPath : config.python.pythonPath;

  // ---------- 基线依赖检测 ----------
  //
  // 提示词里写着「沙箱已预装 playwright、pandas、pypdf…」—— 那句话在开发机上
  // 碰巧是真的，在一台新机器上是**假的**。模型会照着一个不存在的前提写代码，
  // 撞 ImportError；而代码里的 pip 已被禁，它自己修不了，只能反复试或者放弃。
  //
  // 只检测、**不自动装**：基线依赖装进的是系统环境（共享资源），自动往里装
  // 等于替用户决定要不要动他别的项目在用的包；playwright 的 chromium 上百 MB，
  // 启动时静默拉几分钟也是很差的体验。
  // 模型中途要的临时依赖走另一条路（run_command，每次确认，落进 venv）
  const deps = config.python.enabled
    ? await checkSandboxDeps(sandboxPython, logger)
    : undefined;

  if (deps && !deps.ok) {
    console.warn(
      deps.error
        ? `${YELLOW}警告${RESET} 沙箱依赖检测失败: ${deps.error}`
        : `${YELLOW}警告${RESET} 沙箱缺少基线依赖: ${deps.missing.join(', ')}\n` +
          `${DIM}        ${deps.hint}${RESET}`,
    );
  }

  // ---------- Python 沙箱(CodeAct) ----------
  // 浏览器能力经此提供：沙箱预装 Playwright，模型自己写代码驱动。
  // profile 目录用绝对路径：要同时注入子进程和进 fs deny 列表，相对路径两边解析基准不同
  const browserProfileDir = path.resolve(config.python.browserProfileDir);

  // ---------- 常驻浏览器(CDP) ----------
  // 由框架启动而非模型代码启动，浏览器才能跨轮次存活 ——
  // 「上一轮打开的页面下一轮接着点」就靠这个。
  // 顺带消掉一个软边界：模型再没机会自己造 profile 路径
  const browserManager = config.python.enabled
    ? new BrowserManager({
        profileDir: browserProfileDir,
        headless: false,   // 有头：能看见 agent 在做什么，登录引导也自然
        logger,
      })
    : undefined;
  if (browserManager) {
    await browserManager.start();   // 失败只告警，不阻塞 CLI
  }

  // ---------- 工具桥(CodeAct) ----------
  // 让模型代码里能调「代码本身做不到」的工具。只暴露 screenshot / view_image ——
  // 图片进上下文只有 attachments 一条路，代码只能回传 stdout。
  // 筛选依据见 tool-bridge.ts 顶部；read_file 一类刻意不暴露（Python 有 open()）
  const BRIDGED = ['screenshot', 'view_image'];

  // 用 describe() 而不是 getAllDescriptions()：后者会过滤掉隐藏的工具，
  // 而下面正要隐藏它们 —— 那样桥就拿不到 schema、直接不启动了
  const bridgeTools = registry.describe(
    registry.all().filter(t => BRIDGED.includes(t.name)),
  );

  // invoke 转给 runner：这样经桥的调用和模型直接调工具走同一条路径，
  // 权限检查、确认、日志都不会因为「从代码里调」而被绕过。
  //
  // 三者构成一个环：桥 → runner → pythonExecutor → 桥。运行时不成问题 ——
  // invoke 是个箭头函数，只在模型代码真的调工具时才执行，那时 runner 早就建好了。
  // 但类型推断会绕不出来，所以这里的三个声明都显式标注类型
  const toolBridge: ToolBridge | undefined =
    config.python.enabled && bridgeTools.length > 0
      ? new ToolBridge({
          tools: bridgeTools,
          invoke: (name, args): Promise<BridgeToolResult> =>
            runner.run({ name, args }),
          logger,
        })
      : undefined;
  if (toolBridge) {
    // 桥起来了才隐藏：**顺序很重要**。桥启动失败时不能隐藏 ——
    // 否则模型两条路都没有了（工具清单里没有、代码里的函数也连不上）
    if (await toolBridge.start()) {
      // 看图类工具只在代码里可调，不出现在工具清单里 —— 没有开关。
      // 实测：两条路都开时模型一律直接发 tool_call（那是它更熟的形式），
      // 代码那条路根本走不到，留着开关等于维护一个没人该用的模式。
      // 工具仍留在注册表：桥的 invoke 要经 runner 按名字查找
      registry.hide(BRIDGED);
      console.log(
        dim(`  ${BRIDGED.join(' / ')} 只在 execute_python 的代码里可调\n`),
      );
    }
  }

  // execute_python 特意放在这里注册（而不是和其他工具一起）：
  // 它的 description 要带上工具桥暴露的函数签名，而签名由桥从工具 schema 生成，
  // 所以必须等桥建好。registry 只要在 runner.run() 之前注册完就行
  if (config.python.enabled) {
    registry.register(new ExecutePythonTool(toolBridge?.signatures ?? []));
  }

  // 没有工作区就不创建执行器：workDir 为空串会让 path.resolve 解析成 cwd，
  // 写边界随之变成整个项目目录。缺配置时宁可代码执行不可用，不可越界
  const pythonExecutor: PythonExecutor | undefined = config.python.enabled && config.workspace
    ? new PythonExecutor({
        // venv 里那个解释器（venv 不可用时回落到基础解释器，已在上面告警）
        pythonPath: sandboxPython,
        // 与 fs 白名单同源：cwd 和写边界都用 workspace，不再单独配
        workDir: config.workspace,
        timeout: config.python.timeout,
        maxStdoutBytes: config.python.maxStdoutBytes,
        maxStderrBytes: config.python.maxStderrBytes,
        env: {
          // 模型代码里读 os.environ，不硬编码路径
          BROWSER_PROFILE_DIR: browserProfileDir,
          // 常驻浏览器的连接地址。空串表示没起来，模型代码会拿到连接失败并改道
          BROWSER_CDP_URL: browserManager?.cdpUrl ?? '',
        },
        // 代码里装不了包：pip 不查索引，`pip install X` 返回码 1。
        // 装包走 run_command —— 一屏 40 行代码里第 23 行的 pip 用户看不见，
        // 单独一行才会真读清包名（typosquatting 的攻击面就是一两个字符）
        blockPipInstall: config.python.blockPipInstall,
        // 桥的地址与 token 由执行器逐次注入子进程（还要带上 run id 给图片分桶）
        toolBridge,
        logger,
      })
    : undefined;

  // ---------- Shell 执行器（外部程序的正式通道）----------
  //
  // PATH 前置 venv 的 Scripts/bin：**这一步不做，前面的 venv 隔离就白做了** ——
  // shell 从 PATH 找 `pip` 会找到全局解释器那个，装回用户机器上，
  // 正是这次要修的东西（实测：模型装的 rapidocr 顺带升级了全局 onnxruntime）。
  //
  // 从**实际使用的**解释器推导（sandboxPython，而不是配置里的基础解释器）：
  // 两处各自算必然错位，而错位不报错 —— 只表现成「venv 里装了、代码里 import 不到」。
  // 裸 `python`（没有路径分隔符）说明 venv 没用上，此时无从前置，也就不前置
  const pythonDir = /[\\/]/.test(sandboxPython)
    ? path.dirname(path.resolve(sandboxPython))
    : undefined;

  const shellExecutor: ShellExecutor | undefined = shellEnabled
    ? new ShellExecutor({
        // 与 Python 同源：都用工作区，模型写的相对路径两边一致
        workDir: config.workspace,
        timeout: config.shell.timeout,
        maxStdoutBytes: config.shell.maxStdoutBytes,
        maxStderrBytes: config.shell.maxStderrBytes,
        pathPrepend: pythonDir ? [pythonDir] : [],
        // 刻意**不设** PIP_NO_INDEX：这里是装包的正式通道，pip 要能联网。
        // 代码那侧才设（见 sandbox-env.ts 的 PIP_BLOCKED_ENV）
        logger,
      })
    : undefined;

  // ---------- 资源与安全边界（主 agent 与子 agent 共用同一份）----------
  //
  // 抽成一个对象、而不是在两处各写一遍：逐字段转发实测会漏 ——
  // 先漏了 visionAnalyzer，又漏了 pythonExecutor，后者让子 agent 的
  // execute_python 每次返回「未初始化」，它以为是自己代码的问题，
  // 连跑 print("hello") 探活，白烧十几步。
  // 共用一份之后「新增执行器忘了给子 agent」这个失败模式从结构上消失
  const inherited: InheritableRunnerConfig = {
    allowDangerousTools: config.security.allowDangerousTools,
    fsGrants: config.security.fsGrants,
    // profile 里的 cookie 等价于活凭证，不能让 read_file 读进上下文并跟着 trace 落盘
    fsDeniedPaths: config.python.enabled ? [browserProfileDir] : [],
    // 相对路径按工作区解析，与 Python 子进程的 cwd 同源
    workspace: config.workspace || undefined,
    pythonExecutor,
    // 资源整份继承（子 agent 那边按**工具名**排除 run_command，见 sub-agent.ts）——
    // 资源与「谁能用」是两回事，混在一起判过去漏过三次
    shellExecutor,
    // 浏览器操作复用 PythonExecutor 跑框架自己写的脚本 ——
    // TS 侧不再引一份 playwright（几百 MB），而 Python 侧本来就装着
    browserOps: pythonExecutor && browserManager?.cdpUrl
      ? new BrowserOps(pythonExecutor, browserManager.cdpUrl)
      : undefined,
    // 视觉插件：经 ctx.executors.vision 注入给 view_image / screenshot
    visionAnalyzer,
  };

  // ---------- 运行环境（主 agent 与子 agent 的提示词同源）----------
  // 抽成一份：子 agent 原本用一段独立短提示，对环境一无所知 ——
  // 拿 requests 去抓需要登录的站点、还可能 close 掉常驻浏览器（那会毁掉主 agent 的会话）
  const environment: EnvironmentOptions = {
    converged,
    pythonEnabled: config.python.enabled,
    visionModel: visionConfig?.model,
    // 代码里装包被挡住之后必须告诉模型出路在哪，否则它会去试 --index-url、
    // 试直接 URL、试换包名 —— 实测事故就是连着四步都在装包
    shellEnabled,
    // 提示里的「已预装」必须是**实况**，与启动检测同源。
    // 写死一串的话，在缺库的机器上那句话是假的 —— 模型照着不存在的前提写代码、
    // 撞 ImportError，而代码里的 pip 已被禁，它自己修不了
    missingPackages: deps?.missing ?? [],
  };

  // 子 agent 执行器：实现在 core 层，经 ToolRunner 注入到 ctx.executors.agent。
  // 共享 signal 与 confirm —— 下放任务不放宽安全边界。
  // 必须建在 pythonExecutor 之后：它要整份继承 inherited
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
  const context = new ContextManager(
    { ...contextTuning, sessionId, logger },
    llmClient
  );
  await context.initialize();

  const orchestrator = new Orchestrator(llmClient, runner, registry, {
    maxSteps: config.execution.maxSteps,
    logger,
    context,
  });

  // 系统提示只在会话开始时加一次。后续每轮只传 user 消息，
  // 让 ContextManager 把它们接到同一个 Turn 序列上（压缩才能真正生效）。
  // 环境约定与子 agent 出自**同一个函数** —— 提示词写在这里的话，
  // 子 agent 那份必然漂移（它原本就对浏览器常驻、stdout 上限一无所知）
  context.addSystemMessage(
    buildMainSystemPrompt({
      ...environment,
      subAgentEnabled: config.subAgent.enabled,
    }),
  );

  // ---------- 启动信息 ----------
  console.log(bold('\nBaseAgent CLI'));
  console.log(dim(`  模型      ${modelConfig.model}  @ ${modelConfig.baseURL}`));
  console.log(dim(`  会话      ${sessionId}`));
  console.log(dim(`  窗口      ${fmtTokens(config.context.windowSize)} tokens,压缩阈值 ${config.context.compressionThreshold * 100}%,保留最近 ${config.context.recentTurnsToKeep} 轮`));

  // 压缩预算来源要能直接看见：之前是硬编码常量，改配置时根本找不到在哪
  const compBudget = config.context.compressionMaxTokens ?? modelConfig.maxTokens ?? 4000;
  const compSource = config.context.compressionMaxTokens ? '显式配置'
    : modelConfig.maxTokens ? '跟随主模型' : '内置兜底';
  console.log(dim(`  压缩预算  ${fmtTokens(compBudget)} tokens (${compSource}),工具结果截断 ${config.context.compressionClip.toolResult} 字`));
  console.log(dim(`  留痕      ${config.trace.enabled ? recorder.traceDir : '已关闭'}`));
  // 授权范围必须可见：用户得知道 agent 到底能碰哪些目录、哪些只读。
  // 归档目录是框架自动授权的，不显示的话用户根本不知道它在里面
  console.log(dim(`  授权范围  ${
    config.security.fsGrants.length > 0
      ? config.security.fsGrants.map(g => `${g.path} [${g.mode}]`).join('\n            ')
      : '(未配置 WORKSPACE，文件工具与代码执行均不可用)'
  }`));
  console.log(dim(`  危险工具  ${config.security.allowDangerousTools ? '已启用(需确认)' : '已禁用'}`));
  console.log(dim(`  子 agent  ${config.subAgent.enabled
    ? `已启用,最多 ${config.subAgent.maxCount} 个,各 ${config.subAgent.maxSteps} 步`
    : '已禁用'}`));
  console.log(dim(`  代码执行  ${config.python.enabled
    ? `已启用 ${sandboxPython},stdout 上限 ${Math.round(config.python.maxStdoutBytes / 1024)}KB,写边界=工作区`
    : '已禁用 (PYTHON_ENABLED=true 开启)'}`));
  // venv 状态必须可见:用户得知道模型装的包会落在哪儿。
  // 「新建了」和「已存在」要区分 —— 首次启动多等几秒,不说会以为卡住了
  if (config.python.enabled) {
    console.log(dim(`  沙箱 venv ${!config.python.useVenv
      ? '已关闭 (SANDBOX_VENV=false;模型装的包会进全局环境)'
      : venv?.ok
        ? `${venv.created ? '已创建' : '已就绪'} ${config.python.venvDir} (装的包只落在这里)`
        : '不可用,已回落到全局解释器 (见上方警告)'}`));
    // 基线依赖的实况:提示词声称「已预装」,这行是那句话的事实核对
    console.log(dim(`  基线依赖  ${deps?.ok
      ? `齐备 (${SANDBOX_DEPS.length} 个,来自系统环境)`
      : deps?.error
        ? `检测失败 (${deps.error})`
        : `缺 ${deps?.missing.join(', ')} —— 见上方安装命令`}`));
  }
  console.log(dim(`  视觉插件  ${visionConfig
    ? `已启用 ${visionConfig.model} (图不进主上下文,只回文字观察)`
    : '未配置 (设 VISION_MODEL 开启)'}`));
  // 外部命令通道必须可见:它是唯一没有机制边界的能力,安全性全靠用户那次确认。
  // 用户得知道它开着 —— 以及 PATH 前置的是哪个解释器目录(装包会落在那儿)
  console.log(dim(`  外部命令  ${shellEnabled
    ? `已启用 run_command (每次需确认${pythonDir ? `,PATH 前置 ${pythonDir}` : ''})`
    : config.shell.enabled && !config.security.allowDangerousTools
      ? '已配置但未生效 (还需 ALLOW_DANGEROUS_TOOLS=true)'
      : '已禁用 (SHELL_ENABLED=true 开启)'}`));
  if (config.python.enabled) {
    console.log(dim(`  代码装包  ${config.python.blockPipInstall
      ? `已禁止 (pip 不查索引;装包走 ${shellEnabled ? 'run_command' : '用户手动'})`
      : '允许 (模型可在代码里静默装包)'}`));
  }
  if (config.python.enabled) {
    console.log(dim(`  浏览器    profile=${browserProfileDir} (已加入 fs 拒绝列表)`));
  }
  console.log();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  confirmFn = (prompt: string) =>
    new Promise<boolean>(resolve => {
      rl.question(`${prompt} [y/N] `, answer => {
        resolve(/^y(es)?$/i.test(answer.trim()));
      });
    });

  // ---------- 单轮执行 + 回显 ----------
  const runTurn = async (input: string) => {
    const callsBefore = recorder.count();
    const statsBefore = context.getStats();
    const startedAt = Date.now();

    try {
      const run = await orchestrator.run([{ role: 'user', content: input }]);

      const elapsed = Date.now() - startedAt;
      const statsAfter = context.getStats();
      const newCalls = recorder.since(callsBefore);

      console.log(`\n${bold('回答')}\n${run.answer}\n`);

      // 退出原因单独渲染，不混进回答正文
      if (run.stopReason === 'max_steps') {
        console.log(
          `${YELLOW}注意${RESET} 达到 ${config.execution.maxSteps} 步上限后收尾，` +
          `结论可能不完整（见回答中自述的未完成部分）`
        );
      } else if (run.stopReason === 'no_response') {
        console.log(`${RED}注意${RESET} 模型未返回有效内容`);
      }

      // 可观测回显：这一轮实际发生了什么
      console.log(dim('─── 本轮 LLM 调用 ───'));
      if (newCalls.length === 0) {
        console.log(dim('  (无)'));
      } else {
        newCalls.forEach(c => console.log(fmtCall(c)));
      }

      // 用真实压缩计数判断，不靠 turns 数量反推
      const compressedTimes = statsAfter.compressions - statsBefore.compressions;
      console.log(dim('─── 上下文 ───'));
      console.log(
        `  轮次 ${statsAfter.turns}` +
        `  消息 ${statsAfter.messages}` +
        `  主题 ${statsAfter.topics}` +
        `  当前上下文 ${fmtTokens(statsAfter.tokens.total_prompt)} tokens` +
        `  缓存命中 ${(statsAfter.tokens.cache_hit_rate * 100).toFixed(1)}%` +
        `  累计输出 ${fmtTokens(statsAfter.tokens.total_completion)}`
      );
      console.log(
        `  LLM 调用 ${newCalls.length} 次` +
        `  耗时 ${(elapsed / 1000).toFixed(1)}s` +
        (compressedTimes > 0 ? `  ${YELLOW}压缩已触发 ${compressedTimes} 次${RESET}` : '')
      );
      if (config.trace.enabled && newCalls.length > 0) {
        console.log(dim(`  trace: ${newCalls[0].file} … (共 ${newCalls.length} 个文件)`));
      }
      console.log();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`\n${RED}执行失败${RESET} ${msg}`);
      const failed = recorder.since(callsBefore);
      if (failed.length > 0) {
        console.error(dim('  相关调用:'));
        failed.forEach(c => console.error(fmtCall(c)));
        console.error(dim(`  请求体见: ${failed[failed.length - 1].file}`));
      }
      console.log();
    }
  };

  // ---------- 斜杠命令 ----------
  const handleCommand = async (cmd: string): Promise<boolean> => {
    const name = cmd.slice(1).trim().toLowerCase();

    if (name === 'exit' || name === 'quit') return false;

    if (name === 'help') {
      console.log(HELP + '\n');
      return true;
    }

    if (name === 'stats') {
      const s = context.getStats();
      console.log(dim('─── 统计 ───'));
      console.log(`  轮次 ${s.turns}   消息 ${s.messages}`);
      console.log(`  当前上下文 ${fmtTokens(s.tokens.total_prompt)} tokens` +
        ` / 窗口 ${fmtTokens(config.context.windowSize)}` +
        ` (${((s.tokens.total_prompt / config.context.windowSize) * 100).toFixed(2)}%)`);
      console.log(`  压缩阈值 ${fmtTokens(config.context.windowSize * config.context.compressionThreshold)} tokens` +
        `   已压缩 ${s.compressions} 次   主题 ${s.topics} 个`);
      console.log(`  累计输出 ${fmtTokens(s.tokens.total_completion)}   累计缓存 ${fmtTokens(s.tokens.total_cached)}`);
      console.log(`  缓存命中率 ${(s.tokens.cache_hit_rate * 100).toFixed(1)}%`);
      console.log(`  LLM 调用总数 ${recorder.count()}\n`);
      return true;
    }

    if (name === 'trace') {
      const last = recorder.last();
      if (!last) {
        console.log(dim('  还没有 LLM 调用\n'));
        return true;
      }
      console.log(dim('─── 最近一次调用 ───'));
      console.log(fmtCall(last));
      console.log(dim(`  完整请求/响应: ${last.file}\n`));
      return true;
    }

    if (name === 'calls') {
      const all = recorder.since(0);
      if (all.length === 0) {
        console.log(dim('  还没有 LLM 调用\n'));
        return true;
      }
      console.log(dim(`─── 全部 ${all.length} 次调用 ───`));
      all.forEach(c => console.log(fmtCall(c)));
      console.log(dim(`  目录: ${recorder.traceDir}\n`));
      return true;
    }

    if (name === 'context') {
      // 用只读快照：preparePrompt() 会触发 Mid-Turn 压缩，
      // 「看一眼上下文」不该改变上下文
      const messages = context.peekMessages();
      console.log(dim(`─── 当前消息结构(${messages.length} 条)───`));
      messages.forEach((m, i) => {
        const tc = m.role === 'assistant' && m.toolCalls?.length
          ? ` ${CYAN}[tool_calls: ${m.toolCalls.map(t => t.name).join(', ')}]${RESET}`
          : '';
        // 图片折成 [图片 xxx] 占位：base64 直接打出来会糊满整个终端
        const preview = messageToText(m.content ?? '').replace(/\s+/g, ' ').slice(0, 70);
        console.log(`  ${String(i).padStart(3)} ${m.role.padEnd(9)}${tc} ${dim(preview)}`);
      });
      console.log();
      return true;
    }

    console.log(dim(`  未知命令 ${cmd},输入 /help 查看可用命令\n`));
    return true;
  };

  // ---------- 单发模式 ----------
  if (singleShot) {
    console.log(`${bold('提问')} ${singleShot}`);
    await runTurn(singleShot);
    rl.close();
    context.dispose();
    await browserManager?.stop();
    // 桥是个在监听的 HTTP server，不关掉进程不会退出
    await toolBridge?.stop();
    return;
  }

  // ---------- 交互模式 ----------
  console.log(dim('输入问题开始对话,/help 查看命令,/exit 退出\n'));

  rl.setPrompt('> ');
  rl.prompt();

  // 串行队列：readline 的 'line' 事件是同步派发的，async 处理器不会让它等待。
  // 管道输入（printf ... | npm run cli）会一次性吐出所有行，若不排队则：
  //   1. 多轮请求并发打到同一个 Context 上，消息顺序错乱
  //   2. /exit 抢先执行 process.exit()，把还在飞的 LLM 调用直接掐死
  // 所以这里把每行串成一条链，逐个 await。
  let queue: Promise<void> = Promise.resolve();
  let closing = false;

  rl.on('line', (line) => {
    queue = queue.then(async () => {
      if (closing) return;

      const input = line.trim();
      if (!input) return;

      if (input.startsWith('/')) {
        const keepGoing = await handleCommand(input);
        if (!keepGoing) {
          closing = true;
          rl.close();
          return;
        }
      } else {
        await runTurn(input);
      }

      if (!closing) rl.prompt();
    });
  });

  // 队列跑完后再收尾，避免管道输入时 close 早于最后一轮完成
  const finish = () => {
    queue.then(async () => {
      const s = context.getStats();
      console.log(dim(`\n会话结束: ${s.turns} 轮,${recorder.count()} 次 LLM 调用`));
      if (config.trace.enabled && recorder.count() > 0) {
        console.log(dim(`留痕目录: ${path.resolve(recorder.traceDir)}`));
      }
      context.dispose();
      // 必须关掉常驻浏览器：它是 detached 的，不会随本进程退出。
      // 留下来会一直锁着 profile 目录，导致下次启动失败
      await browserManager?.stop();
      await toolBridge?.stop();
      process.exit(0);
    });
  };

  rl.on('close', finish);

  // Ctrl+C 走的是 SIGINT，不一定触发 rl 的 close。
  // 漏掉这条会留下孤儿 chromium —— 而 lock 文件的清理只在下次启动时生效，
  // 中间这段时间 profile 一直是锁着的
  process.on('SIGINT', () => {
    void browserManager?.stop().finally(() => process.exit(0));
  });
}

main().catch(error => {
  console.error('CLI 启动失败:', error);
  process.exit(1);
});
