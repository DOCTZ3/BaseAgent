// ============================================
// Platform 层:配置管理
// ============================================

import path from 'path';
import type { FsGrant } from './security.js';

/**
 * 解析工作区路径
 *
 * 未配置时返回空串,**不回落到 process.cwd()** —— 那会把整个项目目录
 * (含 src/ 与 .env)交给模型读写,是比"什么都读不到"糟得多的失败模式。
 * 空串一路传下去的效果是:fs 白名单为空 → 文件工具全部拒绝,
 * app 启动时显式告警。宁可不能干活,不可越界。
 *
 * 兼容旧的 FS_SANDBOX_PATHS:那时它是逗号分隔的多路径列表,取第一项。
 */
/**
 * 解析 python 可执行文件路径
 *
 * 含路径分隔符(即指向某个 venv)时**必须转绝对路径**:子进程的 cwd 是
 * **工作区**,相对路径会按工作区解析 —— `.sandbox-venv/Scripts/python.exe`
 * 于是变成「工作区/.sandbox-venv/...」,spawn 直接 ENOENT(实测踩到)。
 * 而用户在 .env 里写的相对路径,心里的基准是**项目根目录**。
 *
 * 裸名字(`python` / `python3`)保持原样:那要交给 PATH 查找,转绝对反而错。
 */
function resolvePythonPath(): string {
  const raw = process.env.PYTHON_PATH || 'python';
  return /[\\/]/.test(raw) ? path.resolve(raw) : raw;
}

function resolveWorkspace(): string {
  const explicit = process.env.WORKSPACE?.trim();
  if (explicit) return path.resolve(explicit);

  const legacy = process.env.FS_SANDBOX_PATHS?.split(',')[0]?.trim();
  if (legacy) return path.resolve(legacy);

  return '';
}

/**
 * 工作区路径归一化
 *
 * 环境变量那条路径已经过 resolveWorkspace 的 trim + resolve,但**客户端那条没有**:
 * config.json 里的值是原样存的字符串,直接进 overrides。留着相对路径会让
 * SecurityGuard 与 Python 子进程按不同基准解析(子进程 cwd 是工作区本身),
 * 于是「授权了却读不到」。空串保持空串 —— 它的含义是「未配置」,
 * 绝不能 resolve 成 cwd(那等于把整个项目目录交给模型)。
 */
function normalizeWorkspace(raw: string): string {
  const trimmed = raw.trim();
  return trimmed ? path.resolve(trimmed) : '';
}

/**
 * 由工作区派生文件授权列表 —— **唯一一份**派生规则
 *
 * 抽出来是因为它原先只在 defaultConfig 里算过一次(用的是环境变量),
 * 而 loadConfig 的 security 段是浅合并:传 `overrides.workspace` 时
 * workspace 变了、fsGrants 还钉在环境变量的旧值上。实测过 ——
 * `loadConfig({ workspace: 'D:\\别的目录' })` 得到的 fsGrants 与 .env 一致,
 * 完全没跟着走。客户端的工作区走 config.json、不经环境变量,所以在界面里
 * 换目录只改了显示值,权限边界没动:表现成「面板显示已授权、fs 工具全被拒」,
 * 而且两边路径碰巧相同时症状会被完全掩盖。
 *
 * @param workspace 已归一化的绝对路径;空串表示未配置
 * @param traceDir 归档所在目录(压缩后的历史在 <traceDir>/<session>/archive/)
 */
function deriveFsGrants(workspace: string, traceDir: string): FsGrant[] {
  // 未配置时必须是**空数组**而不是 [''] —— 空串在 path.resolve 下等于 cwd,
  // 那会把整个项目目录(含 src/ 和 .env)当成白名单,
  // 比「什么都读不到」糟得多的失败模式
  if (!workspace) return [];

  return [
    { path: workspace, mode: 'rw' as const },
    // 归档目录由框架自动加入,不要用户配:压缩后模型会被提示用 read_file
    // 回溯早期对话,读不到就等于历史彻底丢失。
    // 只给 ro —— 模型要读它回溯,但不能覆盖自己的归档
    { path: path.resolve(traceDir), mode: 'ro' as const },
  ];
}

// 单个模型配置
export interface ModelConfig {
  provider: 'deepseek' | 'openai';
  apiKey: string;
  baseURL?: string;
  model: string;
  temperature: number;
  maxTokens?: number;
  enableThinking?: boolean;  // 是否开启推理模式(如 DeepSeek 的 reasoning_content)
}

export interface AgentConfig {
  // 多模型配置
  models: {
    main: ModelConfig;        // 主模型(必需)
    fast?: ModelConfig;       // 快速模型(可选)
    reasoning?: ModelConfig;  // 推理模型(可选)
    /**
     * 视觉模型(可选)—— 视觉能力的**插件**
     *
     * 配了它才有视觉能力。图片只进这个模型的请求,主模型全程只收文字,
     * 因此**主模型是不是多模态变得无关** —— 这正是要把主模型换成
     * 强文本模型(v4-pro)时需要的形状。
     *
     * 为什么不再用 VISION_ENABLED:那是个「我保证主模型能看图」的断言,
     * 框架无法验证,填错的后果是运行时 400。改成「配了没有」这个可验证的事实。
     */
    vision?: ModelConfig;
  };

  // 执行控制
  execution: {
    maxSteps: number;          // 最大工具调用轮数
    timeout: number;           // 单次工具超时(ms)
  };

  // 上下文管理
  context: {
    windowSize: number;        // 上下文窗口大小(token)
    compressionThreshold: number;  // 压缩触发阈值(占窗口比例)
    recentTurnsToKeep: number;     // 压缩时保留的最近轮数
    maxTopicsInContext: number;    // 上下文中最多保留的主题数量（时间滑动窗口）

    // 高水位（占窗口比例）。超过它时 recentTurnsToKeep 让位于「不崩」：
    // 突破轮次门槛强制压缩，最少保留 1 轮。兜底机制，不是常规触发点。
    highWaterRatio: number;
    maxDOMTokens: number;          // DOM/无障碍树单次上限
    maxContentTokens: number;      // 网页正文单次上限
    maxFileTokens: number;         // 文件读取单次上限

    // 压缩调用的输出预算(token)。未配置则跟随主模型 maxTokens:
    // 推理内容计入输出预算,给小了会让思维链吃光额度、正文为空(finish_reason=length)
    compressionMaxTokens?: number;

    // 压缩「输入」的逐字段截断上限(字符)。防止工具结果(可能是整个文件)
    // 把压缩自身的输入撑爆;给太小则会切掉摘要需要的事实
    compressionClip: {
      user: number;         // 用户提问
      toolArgs: number;     // 工具入参
      toolResult: number;   // 工具返回(最关键:摘要的事实来源)
      answer: number;       // 最终回答(摘要生成用)
      answerBrief: number;  // 最终回答(主题分析用,只需判意图)
    };
  };

  /**
   * 工作区:用户唯一需要配置的路径
   *
   * 它同时是三样东西,不再分开配:
   *   ① fs 工具的**读写**白名单根(SecurityGuard)
   *   ② Python 代码的 cwd —— 模型写的相对路径都落在这里
   *   ③ Python **写**边界的允许范围(audit hook)
   *
   * 分开配的问题:改一个忘一个就会错位,出现「fs 工具读得到、Python 写不进」
   * 这类不一致,而错位不报错、只在运行时表现成模型莫名失败。
   *
   * ⚠️ **它不约束沙箱代码的读**。同一个工作区外的普通文件,`read_file` 会被拒,
   * 而 `execute_python` 里一句 `open()` 读得到(实测确认)。
   * 原因:读侧无法做白名单 —— 一次 `import pandas` 触发 1183 次 `open`,
   * 漏放行一个目录就是 import 直接失败。读侧改用黑名单,只挡纯负债的路径
   * (见 read-deny.ts)。所以这一项的准确含义是
   * 「不可逆操作的边界 + 工具层的授权范围」,不是「代码能看到的世界的边界」。
   *
   * 客户端的交互形态是「点一下选一个目录」(原生对话框,拿绝对路径),
   * 对应的就是这一项。
   */
  workspace: string;

  // 安全配置
  security: {
    /**
     * 授权列表(由 workspace 派生,带读写档位)
     *
     * 工作区 rw;归档目录 ro —— 模型要读它回溯早期对话,但不能覆盖自己的归档。
     * 数组形态是为了将来「加号选多个目录」时直接扩展,不必改接口。
     */
    fsGrants: FsGrant[];
    allowDangerousTools: boolean;  // 是否启用危险工具
  };

  // 注:视觉能力不再有独立开关。见 models.vision ——
  // 「配了视觉模型」是可验证的事实,而「主模型能看图」是框架验证不了的断言

  // CodeAct:Python 沙箱(浏览器能力经此提供,不做独立 BrowserDriver)
  python: {
    enabled: boolean;          // 是否注册 execute_python 工具
    /**
     * **基础**解释器(建 venv 用它,venv 不可用时也回落到它)
     *
     * 注意语义:这里**不是**最终执行代码的解释器 —— 启动时框架会准备
     * 沙箱 venv 并改用 venv 里那个(见 useVenv / venvDir)。
     * 之前让用户直接把这项指到 venv 内的解释器,结果是每台新机器都要手动
     * 建目录、还要按平台写对 Scripts/ 或 bin/ —— 忘了就是**每次**
     * execute_python 都 spawn ENOENT,而模型会以为是自己代码错了(实测踩到)。
     */
    pythonPath: string;
    /**
     * 是否使用框架托管的沙箱 venv(默认开)
     *
     * 开着时启动阶段自动创建(幂等,已存在则跳过),模型装的包落在 venv 里,
     * 碰不到用户全局环境。关掉 = 直接用基础解释器,装包会污染全局。
     *
     * 为什么这件事值得框架管:确认管的是**授权**(该不该装),
     * venv 管的是**爆炸半径**(装了影响谁)。确认结构上覆盖不到连带影响 ——
     * 实测事故里用户批准的是 `pip install rapidocr_onnxruntime`,
     * 实际发生的是 onnxruntime 被升级,而那是 pip 在点下同意**之后**
     * 解析依赖树才算出来的,不在用户读的那行字里。且 pip 没有 undo。
     */
    useVenv: boolean;
    /**
     * 沙箱 venv 目录(相对路径按项目根解析)
     *
     * **必须在工作区之外**:放进去的话模型的代码能改 venv 自身,
     * 隔离就自己交出去了。在工作区内时框架会拒绝使用并告警 ——
     * 宁可明说「没有隔离」,不给一个假的。
     */
    venvDir: string;
    // 注:代码的 cwd 与写边界都用顶层 workspace,不再单独配 —— 见 workspace 注释
    timeout: number;           // 单次执行超时(ms)
    maxStdoutBytes: number;    // stdout 上限:防 print 整页 HTML 炸上下文
    maxStderrBytes: number;    // stderr 上限:traceback 通常不长
    // chromium 的 user-data-dir。登录态由 chromium 自己读写(SQLite/LevelDB),
    // 框架不解析内容、只提供路径,经 BROWSER_PROFILE_DIR 注入子进程。
    // 同时进 fs 工具的 deny 列表:里面的 cookie 等价于活凭证
    browserProfileDir: string;
    /**
     * CodeAct 可用时,是否把「代码能做的」工具从清单里去掉
     *
     * 默认开。去掉的是 `get_current_time`(`datetime.now()` 一行)、
     * `write_file`(写边界已在 audit hook 管住,工具层重复)、
     * `list_files`(与 search_files 重合)、`echo`。
     *
     * **只在 python.enabled 时生效**:没有代码通道还删工具就是净损失能力。
     * 设 false 可退回「工具全开」做对照。
     */
    convergeTools: boolean;
    /**
     * 禁止在**代码里**装包(默认开)
     *
     * 装包的正式通道是 run_command:它每次请用户确认、原样显示命令。
     * 关掉这项就回到「模型静默装包、用户事后翻 trace 才发现」——
     * 实测事故就是这样:pip 返回码 0,顺带升级了全局环境的 onnxruntime。
     *
     * 实现是 PIP_NO_INDEX(见 sandbox-env.ts),**是路牌不是锁**:
     * 传一份清掉该键的 env、或 pip install <URL> 都能绕。
     */
    blockPipInstall: boolean;
  };

  /**
   * Shell:调用机器上外部程序的通道(pip / git / ffmpeg 一类)
   *
   * ⚠️ 它**没有机制边界**。Python 的写边界是进程内的 audit hook,
   * shell 起的进程根本不经过它 —— 安全性全部来自 run_command 的
   * danger:true 人工确认(原样命令给用户看)。
   *
   * 为什么仍然要它:让危险操作**变得可读**。一屏 40 行代码里第 23 行的
   * pip install 没人看得见,单独一行用户才会真读清包名 ——
   * 而 typosquatting 的整个攻击面就是一两个字符的差别。
   */
  shell: {
    enabled: boolean;          // 是否注册 run_command 工具
    timeout: number;           // 单次执行超时(ms),装大包要宽
    maxStdoutBytes: number;    // stdout 上限:npm install 能刷几百行
    maxStderrBytes: number;    // stderr 上限(pip 的 warning 都走 stderr)
  };

  // 重试配置（幂等操作:LLM 调用/结构化输出解析）
  retry: {
    maxRetries: number;          // 最大重试次数(不含首次尝试)
    baseDelay: number;           // 指数退避基础延迟(ms)
    maxDelay: number;            // 单次延迟上限(ms)
    retryableErrors?: string[];  // 可重试错误特征,未配置则用内置默认表
  };

  // 子 agent(一次性子任务执行器)
  subAgent: {
    enabled: boolean;    // 是否注册 spawn_subagent 工具
    maxSteps: number;    // 单个子 agent 的步数预算
    maxCount: number;    // 单次会话内最多 spawn 多少个(防连续下放烧钱)
  };

  /**
   * 长期记忆(用户特征)
   *
   * 与上下文压缩是两件事:压缩让**这次会话**能继续,记忆让**下次会话**
   * 知道你是谁。详见 memory.ts 顶部。
   *
   * dbPath 必须在**工作区之外** —— 放进工作区,模型的代码就能改自己的记忆
   * (与 .sandbox-venv 同一个理由)。
   */
  memory: {
    enabled: boolean;               // 关掉则不抽取、不注入,零开销
    dbPath: string;                 // SQLite 文件位置(工作区之外)
    /**
     * 每几轮抽一次,同时也是**给抽取器看的轮数**(同一个数)
     *
     * 原先还叠了一层 token 增量,实测那是错的:它取的是模型**输出**增量,
     * 而横幅上看到的是上下文水位 —— 同一次会话输出累计 3656、水位涨到 11966,
     * 差三倍多,于是「聊了 11k 还没触发」。按轮次计数虽粗但**可预测**。
     */
    turnsPerExtraction: number;
    /**
     * 抽取调用的输出上限。**留空即跟随主模型**(MAIN_MAX_TOKENS)
     *
     * 可选是刻意的:给了默认值就等于埋一个暗默预算 —— 配了主模型也管不到
     * 这里,而思维链计入输出预算,不够时 content 直接是空的
     */
    maxTokens?: number;
  };

  /**
   * 可复用任务轨迹(skill)
   *
   * 与记忆**共用同一个 SQLite 文件**(memory.dbPath),只是 key 不同 ——
   * better-sqlite3 的 ABI 要跟着 Electron 重编,不必为此再引一个存储依赖。
   * 所以这里没有独立的 dbPath。
   *
   * 索引(名字+描述)进系统提示,正文由 load_skill 工具按需取:
   * 系统提示是 prompt cache 前缀里最稳定的部分(实测命中率 60~77%),
   * 每轮注入不同的正文会让整段前缀失效。
   */
  skill: {
    enabled: boolean;               // 关掉则不注册工具、不注入索引、不沉淀
    /**
     * 触发沉淀的工具步数门槛
     *
     * 判据是**单轮**的(这一轮跑了几步),不是「攒够 N 轮」——
     * 一次做成的轨迹就已经完整可复用,攒十次只会让它晚十次才拿到。
     * 而实测会话规模是 1~3 轮,轮数门槛会重复 CONTEXT_RECENT_TURNS=10
     * 那个「配了但永远达不到」的错误。
     *
     * 门槛放松是有意的:严格性交给人工审批那一关 ——
     * 触发便宜(一次不阻塞的调用),入库贵(含糊的描述会永久占索引预算)。
     */
    minToolSteps: number;
    /** 抽取调用的输出上限。**留空即跟随主模型** —— 理由见 memory.maxTokens */
    maxTokens?: number;
  };

  // 可观测:LLM 调用留痕(本地调试用)
  trace: {
    enabled: boolean;    // 是否把每次调用的线格式请求/响应写盘
    dir: string;         // 落盘根目录
    verbose: boolean;    // 终端是否回显 reasoning 全文
  };

  // 日志
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

// 默认配置
const buildModels = (): {
  main: ModelConfig;
  fast?: ModelConfig;
  reasoning?: ModelConfig;
  vision?: ModelConfig;
} => {
  const models = {
    main: {
      provider: 'deepseek' as 'deepseek' | 'openai',
      apiKey: process.env.DEEPSEEK_API_KEY || '',
      baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
      model: process.env.MAIN_MODEL || 'deepseek-v4-flash',
      temperature: parseFloat(process.env.MAIN_TEMPERATURE || '0.7'),
      maxTokens: process.env.MAIN_MAX_TOKENS ? parseInt(process.env.MAIN_MAX_TOKENS) : undefined,
      enableThinking: process.env.MAIN_ENABLE_THINKING !== 'false', // 默认开启
    },
  } as {
    main: ModelConfig;
    fast?: ModelConfig;
    reasoning?: ModelConfig;
    vision?: ModelConfig;
  };

  // 可选的 fast 模型
  if (process.env.FAST_MODEL) {
    const fastProvider = process.env.FAST_PROVIDER || 'deepseek';
    models.fast = {
      provider: (fastProvider === 'openai' ? 'openai' : 'deepseek') as 'deepseek' | 'openai',
      apiKey: process.env.DEEPSEEK_API_KEY || '',
      baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
      model: process.env.FAST_MODEL,
      temperature: parseFloat(process.env.FAST_TEMPERATURE || '0.3'),
      maxTokens: process.env.FAST_MAX_TOKENS ? parseInt(process.env.FAST_MAX_TOKENS) : undefined,
      enableThinking: process.env.FAST_ENABLE_THINKING === 'true', // 默认关闭
    };
  }

  // 可选的 reasoning 模型
  if (process.env.REASONING_MODEL) {
    const reasoningProvider = process.env.REASONING_PROVIDER || 'deepseek';
    models.reasoning = {
      provider: (reasoningProvider === 'openai' ? 'openai' : 'deepseek') as 'deepseek' | 'openai',
      apiKey: process.env.DEEPSEEK_API_KEY || '',
      baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
      model: process.env.REASONING_MODEL,
      temperature: parseFloat(process.env.REASONING_TEMPERATURE || '0.9'),
      maxTokens: process.env.REASONING_MAX_TOKENS ? parseInt(process.env.REASONING_MAX_TOKENS) : undefined,
      enableThinking: process.env.REASONING_ENABLE_THINKING !== 'false', // 默认开启
    };
  }

  // 可选的视觉模型 —— 视觉能力的插件
  //
  // 允许独立的 key / baseURL:视觉插件很可能来自另一个 provider,
  // 这正是「插件」的含义。未给则回落到主 provider 的配置。
  //
  // 注:VISION_API_KEY 不在 PythonExecutor 的 env 继承白名单里,
  // 所以沙箱内的代码拿不到它、无法自己调视觉 API —— 必须经工具桥。
  // 这也是 CodeAct 收敛后工具桥继续存在的理由之一(凭证隔离)
  if (process.env.VISION_MODEL) {
    const visionProvider = process.env.VISION_PROVIDER || 'deepseek';
    models.vision = {
      provider: (visionProvider === 'openai' ? 'openai' : 'deepseek') as 'deepseek' | 'openai',
      apiKey: process.env.VISION_API_KEY || process.env.DEEPSEEK_API_KEY || '',
      baseURL: process.env.VISION_BASE_URL || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
      model: process.env.VISION_MODEL,
      // 低温:看图要的是「图里有什么」这类事实,不是创造性表述
      temperature: parseFloat(process.env.VISION_TEMPERATURE || '0.2'),
      maxTokens: process.env.VISION_MAX_TOKENS ? parseInt(process.env.VISION_MAX_TOKENS) : undefined,
      // 默认关:描述一张图不需要思维链,开着纯烧 token
      enableThinking: process.env.VISION_ENABLE_THINKING === 'true',
    };
  }

  return models;
};

export const defaultConfig: AgentConfig = {
  models: buildModels(),
  execution: {
    maxSteps: process.env.MAX_STEPS ? parseInt(process.env.MAX_STEPS) : 20,
    timeout: process.env.EXECUTION_TIMEOUT ? parseInt(process.env.EXECUTION_TIMEOUT) : 60000,
  },
  context: {
    windowSize: process.env.CONTEXT_WINDOW_SIZE ? parseInt(process.env.CONTEXT_WINDOW_SIZE) : 1_000_000,
    compressionThreshold: process.env.CONTEXT_COMPRESSION_THRESHOLD ? parseFloat(process.env.CONTEXT_COMPRESSION_THRESHOLD) : 0.7,
    recentTurnsToKeep: process.env.CONTEXT_RECENT_TURNS ? parseInt(process.env.CONTEXT_RECENT_TURNS) : 10,
    maxTopicsInContext: process.env.CONTEXT_MAX_TOPICS ? parseInt(process.env.CONTEXT_MAX_TOPICS) : 10,
    // 高水位兜底：默认 0.9，与阈值 0.7 之间留 20% 缓冲
    highWaterRatio: process.env.CONTEXT_HIGH_WATER_RATIO
      ? parseFloat(process.env.CONTEXT_HIGH_WATER_RATIO)
      : 0.9,
    maxDOMTokens: process.env.CONTEXT_MAX_DOM_TOKENS ? parseInt(process.env.CONTEXT_MAX_DOM_TOKENS) : 20_000,
    maxContentTokens: process.env.CONTEXT_MAX_CONTENT_TOKENS ? parseInt(process.env.CONTEXT_MAX_CONTENT_TOKENS) : 10_000,
    maxFileTokens: process.env.CONTEXT_MAX_FILE_TOKENS ? parseInt(process.env.CONTEXT_MAX_FILE_TOKENS) : 10_000,
    // 留空 = 跟随主模型 MAIN_MAX_TOKENS(见 ContextManager 构造函数)
    compressionMaxTokens: process.env.CONTEXT_COMPRESSION_MAX_TOKENS
      ? parseInt(process.env.CONTEXT_COMPRESSION_MAX_TOKENS)
      : undefined,
    compressionClip: {
      user: process.env.CONTEXT_CLIP_USER ? parseInt(process.env.CONTEXT_CLIP_USER) : 300,
      toolArgs: process.env.CONTEXT_CLIP_TOOL_ARGS ? parseInt(process.env.CONTEXT_CLIP_TOOL_ARGS) : 120,
      toolResult: process.env.CONTEXT_CLIP_TOOL_RESULT ? parseInt(process.env.CONTEXT_CLIP_TOOL_RESULT) : 600,
      // 给得比 toolResult 宽：最终回答是模型对工具结果的蒸馏，信息密度更高
      answer: process.env.CONTEXT_CLIP_ANSWER ? parseInt(process.env.CONTEXT_CLIP_ANSWER) : 1200,
      answerBrief: process.env.CONTEXT_CLIP_ANSWER_BRIEF ? parseInt(process.env.CONTEXT_CLIP_ANSWER_BRIEF) : 120,
    },
  },
  // 工作区:唯一需要用户配置的路径。fs 白名单、Python cwd、写边界全部由它派生。
  // 兼容旧的 FS_SANDBOX_PATHS（取第一项）—— 那时它是逗号分隔的多路径列表
  workspace: resolveWorkspace(),
  security: {
    // 派生规则只有一份,在 deriveFsGrants 里 —— loadConfig 换了 workspace
    // 也要走同一条规则重算,否则就是「显示新目录、边界还是旧的」
    fsGrants: deriveFsGrants(
      resolveWorkspace(),
      process.env.TRACE_DIR || 'traces',
    ),
    allowDangerousTools: process.env.ALLOW_DANGEROUS_TOOLS === 'true',
  },
  python: {
    // 默认关闭:需要先装好 python 环境和依赖库,装好再显式开
    enabled: process.env.PYTHON_ENABLED === 'true',
    // **基础**解释器:建 venv 用它,venv 不可用时回落到它。
    // 最终执行代码的解释器由启动阶段的 ensureSandboxVenv 决定。
    // 相对路径按**项目根目录**解析成绝对路径:子进程的 cwd 是工作区,
    // 留着相对路径会按工作区解析 → spawn ENOENT(实测踩到)
    pythonPath: resolvePythonPath(),
    // 默认开:装包落进项目内的 venv,碰不到用户全局环境。
    // 目录不存在时启动阶段自动创建 —— 这件事可推导,没理由交给人做
    useVenv: process.env.SANDBOX_VENV !== 'false',
    // 放项目根下,**在工作区之外** —— 放进工作区的话模型能改 venv 自身。
    // 框架会校验这一点,在工作区内时拒绝使用并告警
    venvDir: path.resolve(process.env.SANDBOX_VENV_DIR || '.sandbox-venv'),
    // 比工具默认超时宽:浏览器启动 + 页面加载本身就要几秒
    timeout: process.env.PYTHON_TIMEOUT ? parseInt(process.env.PYTHON_TIMEOUT) : 120_000,
    // 50KB ≈ 1.2 万 token。够放几百条提取结果,又拦得住整页 HTML
    maxStdoutBytes: process.env.PYTHON_MAX_STDOUT_BYTES
      ? parseInt(process.env.PYTHON_MAX_STDOUT_BYTES)
      : 50 * 1024,
    maxStderrBytes: process.env.PYTHON_MAX_STDERR_BYTES
      ? parseInt(process.env.PYTHON_MAX_STDERR_BYTES)
      : 8 * 1024,
    // 不放 workDir 内:那里是模型的工作区,profile 混在里面容易被误删/误读
    browserProfileDir: process.env.BROWSER_PROFILE_DIR || '.browser-profile',
    // 默认收敛。只在 python.enabled 时生效(见类型定义处说明)
    convergeTools: process.env.CONVERGE_TOOLS !== 'false',
    // 默认禁止代码里装包:装包走 run_command,每次请用户确认、原样显示命令
    blockPipInstall: process.env.BLOCK_PIP_INSTALL !== 'false',
  },
  shell: {
    // 默认关闭:它没有机制边界,开之前用户应当知道自己在开什么。
    // 需要 ALLOW_DANGEROUS_TOOLS=true 才真正可用(run_command 是 danger 工具)
    enabled: process.env.SHELL_ENABLED === 'true',
    // 比 Python 宽:装大包(torch 一类)几分钟很常见
    timeout: process.env.SHELL_TIMEOUT ? parseInt(process.env.SHELL_TIMEOUT) : 300_000,
    // 比 Python 的 50KB 小:命令输出是日志,模型只需要看结论。
    // 超限不判失败(npm install 刷几百行是常态,命令本身是成功的)
    maxStdoutBytes: process.env.SHELL_MAX_STDOUT_BYTES
      ? parseInt(process.env.SHELL_MAX_STDOUT_BYTES)
      : 16 * 1024,
    maxStderrBytes: process.env.SHELL_MAX_STDERR_BYTES
      ? parseInt(process.env.SHELL_MAX_STDERR_BYTES)
      : 8 * 1024,
  },
  retry: {
    maxRetries: process.env.RETRY_MAX_ATTEMPTS ? parseInt(process.env.RETRY_MAX_ATTEMPTS) : 3,
    baseDelay: process.env.RETRY_BASE_DELAY ? parseInt(process.env.RETRY_BASE_DELAY) : 1000,
    maxDelay: process.env.RETRY_MAX_DELAY ? parseInt(process.env.RETRY_MAX_DELAY) : 60_000,
    // 未配置时留空,由 RetryHandler 使用内置默认错误表
    retryableErrors: process.env.RETRY_RETRYABLE_ERRORS
      ? process.env.RETRY_RETRYABLE_ERRORS.split(',').map(s => s.trim()).filter(Boolean)
      : undefined,
  },
  subAgent: {
    enabled: process.env.SUBAGENT_ENABLED !== 'false',
    // 子 agent 的任务通常是「遍历读取」，步数需求比主循环低但不能太紧
    maxSteps: process.env.SUBAGENT_MAX_STEPS ? parseInt(process.env.SUBAGENT_MAX_STEPS) : 15,
    // 配额:防止主 agent 连续下放导致成本失控
    maxCount: process.env.SUBAGENT_MAX_COUNT ? parseInt(process.env.SUBAGENT_MAX_COUNT) : 5,
  },
  memory: {
    // 默认开启:它只在攒够增量时才调一次 LLM,平时零开销
    enabled: process.env.MEMORY_ENABLED !== 'false',
    // 放项目根目录、**不放工作区** —— 放进去模型的代码就能改自己的记忆
    // (与 .sandbox-venv 同一个理由)。resolve 是必须的:
    // Python 子进程的 cwd 是工作区,相对路径两边解析基准不同
    dbPath: path.resolve(process.env.MEMORY_DB_PATH || '.agent-memory.db'),
    // 3:贴合实际会话长度(实测一次会话就 3 轮)。它同时是「看几轮」——
    // 拆成两个数会让同一段对话被重复分析,同一条特征反复 hits+1、虚高稳定度
    turnsPerExtraction: process.env.MEMORY_TURNS_PER_EXTRACTION
      ? parseInt(process.env.MEMORY_TURNS_PER_EXTRACTION) : 3,
    // 不给默认值 —— 留空即**跟随主模型**(MAIN_MAX_TOKENS)。
    //
    // 原先兜底 2000。那个数字是个暗默值:配了 MAIN_MAX_TOKENS 也管不到这里,
    // 而 2000 在开着思维链时根本不够 —— 实测抽取调用把整份答案都想完了、
    // 预算用尽,content 一个字都没轮到,4 次重试全是空内容(白等 2 分 40 秒)。
    // 失败原因是预算不够,重试不会让预算变多。
    maxTokens: process.env.MEMORY_MAX_TOKENS
      ? parseInt(process.env.MEMORY_MAX_TOKENS) : undefined,
  },
  skill: {
    // 默认开启:不触发时零开销(索引为空则提示里什么都不加)。
    // 与记忆共用 memory.dbPath 那个文件,只是 key 不同
    enabled: process.env.SKILL_ENABLED !== 'false',
    // 8:一次任务跑到八步说明它需要来回摸索,那才值得记轨迹。
    // 不用轮数门槛 —— 见 AgentConfig.skill 上的注释
    minToolSteps: process.env.SKILL_MIN_TOOL_STEPS
      ? parseInt(process.env.SKILL_MIN_TOOL_STEPS) : 8,
    // 同记忆:不给默认值,留空即跟随主模型。见上面那段说明 ——
    // 这里正是那个 bug 被实测抓到的地方(traces/app-1788091462247)
    maxTokens: process.env.SKILL_MAX_TOKENS
      ? parseInt(process.env.SKILL_MAX_TOKENS) : undefined,
  },
  trace: {
    // 默认开启:本地调试的主要手段,开销只有一次同步写盘
    enabled: process.env.TRACE_ENABLED !== 'false',
    // 放项目根目录下的可见文件夹,不放 .claude/(隐藏目录不好找)
    dir: process.env.TRACE_DIR || 'traces',
    verbose: process.env.TRACE_VERBOSE === 'true',
  },
  logLevel: (process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error') || 'info',
};

export function loadConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  // 可选模型**遍历键名合并**,不逐个 if ——
  // 逐个写实测漏过:加了 models.vision 却忘了在这里合并,于是 VISION_MODEL
  // 配了也等于没配(config.models.vision 恒为 undefined),
  // 视觉工具不注册、提示里没有视觉段,模型只好自己去装 OCR 库。
  // 遍历之后新增可选模型不需要改这里
  const optionalKeys = ['fast', 'reasoning', 'vision'] as const;

  const models: AgentConfig['models'] = {
    main: { ...defaultConfig.models.main, ...overrides.models?.main },
  };

  for (const key of optionalKeys) {
    const base = defaultConfig.models[key];
    const override = overrides.models?.[key];
    if (base || override) {
      models[key] = { ...base, ...override } as ModelConfig;
    }
  }

  // 工作区要**先归一化再派生**,顺序不能反。
  // 环境变量那条路径在 resolveWorkspace 里已经 trim + resolve 过,
  // 但客户端那条是 config.json 里的原样字符串,直接进 overrides ——
  // 不归一化会留下相对路径,而 SecurityGuard 和 Python 子进程的解析基准不同
  const workspace = normalizeWorkspace(
    overrides.workspace ?? defaultConfig.workspace,
  );

  const trace = { ...defaultConfig.trace, ...overrides.trace };

  // fsGrants 必须跟着 workspace 重算。
  //
  // 之前这里只有一句 `security: {...defaultConfig.security, ...overrides.security}`,
  // 而 fsGrants 是 defaultConfig 里用**环境变量**算出来的 —— 于是传
  // overrides.workspace 时 workspace 变了、授权列表没变。客户端的工作区走
  // config.json、不经环境变量,表现就是「面板显示新目录、fs 工具全被拒」,
  // 而两边路径碰巧相同时症状被完全掩盖(实测:换成别的目录后 fsGrants 原样不动)。
  //
  // 显式传 fsGrants 仍然优先:测试和嵌入式调用要能直接给定授权,
  // 不该被这里的派生覆盖掉
  const security: AgentConfig['security'] = {
    ...defaultConfig.security,
    ...overrides.security,
    fsGrants:
      overrides.security?.fsGrants ?? deriveFsGrants(workspace, trace.dir),
  };

  return {
    ...defaultConfig,
    ...overrides,
    models,
    workspace,
    execution: { ...defaultConfig.execution, ...overrides.execution },
    context: {
      ...defaultConfig.context,
      ...overrides.context,
      // compressionClip 是嵌套对象，浅合并会被整体覆盖 —— 只覆盖传入的字段
      compressionClip: {
        ...defaultConfig.context.compressionClip,
        ...overrides.context?.compressionClip,
      },
    },
    security,
    python: { ...defaultConfig.python, ...overrides.python },
    // 新增顶层配置段必须在这里合并 —— 漏了不会报错,只会让整段 overrides 生效
    // 但默认值丢失(或反之)。models.vision 就是这么漏过一次的
    shell: { ...defaultConfig.shell, ...overrides.shell },
    retry: { ...defaultConfig.retry, ...overrides.retry },
    subAgent: { ...defaultConfig.subAgent, ...overrides.subAgent },
    memory: { ...defaultConfig.memory, ...overrides.memory },
    // 漏了这一行不报错,只表现成「整段 overrides 生效但默认值丢失」
    // (或反之)—— models.vision 就是这么漏过一次的
    skill: { ...defaultConfig.skill, ...overrides.skill },
    // 复用上面那个 trace —— fsGrants 的归档 ro 授权是按它的 dir 派生的,
    // 在这里重新合并一次会让两者有机会不一致
    trace,
  };
}
