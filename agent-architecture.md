# BaseAgent — 架构设计文档

> **BaseAgent** —— 一个自然语言驱动、可扩展工具、以浏览器操作为重点扩展方向的 PC 端通用 Agent。
> 技术栈:TypeScript 全栈。默认壳:Electron 客户端(语音/其他 GUI 作为可后插模块预留)。
> 模型:DeepSeek V4 Pro 起步(上下文 1M),但内核不绑定任何厂商(见 llm-client 的 provider 中立设计)。

---

## 设计总纲

> 一条数据流贯穿到底:`输入 → 内核决策 → 经调用管线 → 工具执行 → 结果回流内核`。
> 内核不认识任何具体工具,工具不认识内核,两者只通过「注册表 + 统一契约」对话。
> 这就是可无限扩展的根。

核心解耦原则:

- **交互层(壳)可替换** —— Electron / 语音 / 其他 GUI 只做「输入→文本」与「结果→展示」,零业务逻辑。
- **内核只知道「有一批工具可用」**,不 import 任何具体工具实现。
- **工具只实现统一契约**,写完塞进注册表,内核自动可用。
- **通用横切能力(日志/权限/校验)** 挂在「调用管线」这个唯一入口上,工具不各写一遍。

---

## 整体模块框架

```
┌──────────────────────────────────────────────────────────┐
│  interface/  交互层(壳,可替换)                            │
│    · app/         已实现:Electron 客户端(流式、历史侧边栏) │
│                   含自写 Markdown 渲染(只建 DOM,不碰 HTML) │
│    · voice        预留:ASR 语音转文字 / TTS 播报            │
│    职责:只做 输入→文本 / 结构化结果→展示,零业务逻辑        │
│    关键:壳共用 core/session.ts 一份装配,壳不重算事实       │
└───────────────────────────┬──────────────────────────────┘
                            │ AgentInput / AgentEvent
┌───────────────────────────┴──────────────────────────────┐
│  core/  Agent 内核(大脑)                                  │
│    · session       一次会话的全部接线(壳共用,零输出)      │
│    · session-store 会话历史:append-only 的轮次日志         │
│    · orchestrator  主循环:调 LLM → 拿决策 → 派发 → 观察    │
│    · planner       复杂任务的多步拆解(可选增强)           │
│    · llm-client    封装 LLM API 调用                       │
│    · context       上下文管理:Turn 级别 + 主题聚类压缩     │
│    · sub-agent     一次性子 agent(独立上下文,只回传结论)  │
│    · system-prompt 提示词组装(主/子 agent 环境约定同源)   │
│    · memory        长期记忆:用户特征(6 维度,接 storage)   │
│    · skill         技能库:轨迹存取/索引渲染/合并规则       │
│    · skill-manager 沉淀驱动:触发判据 → 抽取 → 人工审批     │
│    · token-counter Token 统计和阈值判断                   │
│    职责:理解意图、决定调哪个工具、串联多步、错误恢复        │
│    关键:只知道「有一批工具可用」,不知道任何工具的实现       │
└───────────────────────────┬──────────────────────────────┘
                            │ ToolCall(name,args) / ToolResult
┌───────────────────────────┴──────────────────────────────┐
│  tools/  工具层(核心扩展层)                               │
│    · contract      Tool 统一契约(interface 定义)          │
│    · registry      注册表:名册 + 名字→工具 映射            │
│    · runner        调用管线:校验/权限/日志/重试            │
│    · builtin\      spawn_subagent(收敛后 echo/时间进代码)  │
│    · code\         execute_python(动作空间) / view_image    │
│    · browser\      screenshot / request_help               │
│    · system\       read_file / search_files(自带返回量上限) │
│                    run_command(外部程序,每次人工确认)      │
│                    load_skill(取轨迹正文,索引在系统提示)   │
│    职责:具体能力实现,申明 needs 依赖,runner 注入资源       │
└───────────────────────────┬──────────────────────────────┘
                            │ needs: ['fs', 'python', 'browser', ...]
┌───────────────────────────┴──────────────────────────────┐
│  executors/  执行器 / 资源层                              │
│    · fs-driver     文件系统封装,集成 security 白名单       │
│    · python-executor  子进程执行代码 + 写边界(audit hook)   │
│    · shell-executor   外部程序(pip/git):**无机制边界**     │
│    · browser-manager  常驻 chromium(CDP,跨轮次保持页面)    │
│    · browser-ops      截图(逻辑在此,Tool 只薄包装)         │
│    · tool-bridge   工具桥:沙箱内 Python 回调 TS 侧工具      │
│    · sandbox-env   env 白名单 + PIP_NO_INDEX(两执行器共用)  │
│    · capped-buffer / process-tree  输出上限、进程树回收(共用)│
│    · http-client   ⏳ 未实现(抓 API / 下载文件)            │
│    职责:操作真实资源,被 runner 按工具 needs 动态注入       │
└───────────────────────────┬──────────────────────────────┘
                            │ 横切依赖
┌───────────────────────────┴──────────────────────────────┐
│  platform/  横切基础设施                                   │
│    · logger        分级日志输出                           │
│    · config        .env 配置加载                          │
│    · config-store  客户端配置持久化(JSON,.env 作回落)      │
│    · storage       SQLite 持久化(记忆/session 索引)       │
│    · security      SecurityGuard:白名单 + 凭证目录黑名单    │
│    · errors        统一错误类型(Validation/Security/...)  │
│    · retry-handler 幂等操作的指数退避重试                  │
│    · trace-recorder LLM 调用留痕(线格式请求/响应落盘)      │
│    职责:全局共用,所有层都可能依赖                          │
└──────────────────────────────────────────────────────────┘
```

**数据流**:
```
用户输入 → Electron app(interface)
         → Orchestrator(core) 调 LLMClient 拿决策
         → 决策含 tool_call → ToolRunner(tools) 校验/注入资源
         → Tool.run() 调用 Executor(executors) 操作资源
         → ToolResult 回流 → Orchestrator 再调 LLM
         → 多轮后得到 final_response → app 展示
```

---

## 核心接口

### Tool Contract (工具统一契约)

```typescript
type ResourceType =
  | 'fs' | 'python' | 'shell' | 'browser' | 'http' | 'agent' | 'vision' | 'skill';

interface Tool {
  name: string;
  description: string;
  parameters: ToolParameters;   // z.ZodObject,运行时校验 + 生成 JSON Schema
  needs: readonly ResourceType[];  // 声明依赖资源
  danger: boolean;              // true = 调用前必须人工确认
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

interface ToolContext {          // runner 组装,是唯一的资源注入点
  sessionId: string;
  logger: Logger;
  signal: AbortSignal;          // 每次 buildContext 现取,不缓存(见下)
  confirm(request: ConfirmRequest): Promise<boolean>;
  executors: {                  // 按 needs 逐项注入,未声明的键为 undefined
    fs?: unknown; python?: unknown; shell?: unknown; browser?: unknown;
    http?: unknown;             // 占位,HttpClient 未实现
    agent?: SubAgentRunner;     // 实现在 core,tools 只认接口
    vision?: VisionAnalyzer;    // 同上;未配 VISION_MODEL 时工具不注册
    skill?: SkillReader;        // 同上;**只读**
  };
}

interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  // 视觉插件产出的观察文字。**不放 data** —— 经工具桥调用时 data 会返回给
  // Python 代码,而模型不会 print 它,那样花过钱的观察会静默消失。
  // 放这里才由框架投递
  observations?: string[];
}
```

**关键设计**:工具通过 `needs` 声明依赖、不直接 import executor;
所有错误包装为 `ToolResult{ok:false}`,不炸主循环。

### SkillReader (技能只读边界)

```typescript
interface SkillReader {          // 经 ToolContext 注入,needs: ['skill']
  load(name: string): SkillLookupResult;
}

interface SkillLookupResult {
  ok: boolean;
  body?: string;                 // 轨迹正文(目标/做法分层 + 坑)
  error?: string;
  available?: string[];          // 取不到时列出可用名字,免得模型反复猜
}
```

**关键设计**:只有 `load`,**没有任何写方法** —— 模型改不了自己的技能库,
这个边界是结构性的而不是靠权限检查。索引(名字+描述)进系统提示、
正文按需取:系统提示是 prompt cache 前缀里最稳定的部分(实测命中率 60~77%),
每轮注入不同正文会让整段前缀失效。子 agent 可读不可写(`skillReader` 在
`InheritableRunnerConfig` 里)。

### LLMClient (Provider 中立接口)

```typescript
interface LLMClient {
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}

interface CompletionRequest {
  messages: Message[];
  temperature?: number;
  maxTokens?: number;
  tools?: ToolSchema[];         // Function calling
  responseFormat?: 'text' | 'json_object';  // 结构化输出(中立表达)
}

// 多模态内容块(中立表达,不含厂商结构)
type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string;
      detail?: 'low' | 'original'; label?: string };

// 图片只允许出现在 user 消息 —— 由类型系统表达,不靠运行时检查
type Message =
  | { role: 'system';    content: string }
  | { role: 'user';      content: string | ContentPart[] }
  | { role: 'assistant'; content: string; reasoning?: string; toolCalls?: ToolCall[] }
  | { role: 'tool';      toolCallId: string; content: string };

interface CompletionResponse {
  content: string | null;
  reasoning?: string;           // DeepSeek reasoning_content
  toolCalls: ToolCall[];
  finishReason: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_cache_hit_tokens?: number;  // 缓存命中
    reasoning_tokens?: number;         // 思维链消耗(已含在 completion_tokens 内)
  };
}
```

**关键设计**:内核只依赖接口,厂商差异全部由 adapter 吸收。两处具体体现:
- **`usage` 整体透传、不逐字段列举**:缓存命中在 DeepSeek 是顶层
  `prompt_cache_hit_tokens`、OpenAI/中转站是嵌套 `prompt_tokens_details.cached_tokens`,
  两种都认并兜底 0(实测中转站格式变过,只读一种会让命中率静默归零);
  逐字段列举则会让新增字段被静默丢掉
- **图片用中立块表达,不照抄线格式**:内核只说「有张图、什么类型、数据是什么」,
  `image_url: { url: 'data:...' }` 只出现在 adapter。照抄会把厂商结构焊死在
  `Message` 上,换 Claude(`source: {type:'base64', media_type, data}`)时要改遍全项目。
  base64 存裸数据、`data:` 前缀由 adapter 拼,同理

### Orchestrator (ReAct 主循环)

```typescript
interface AgentRunResult {
  answer: string;
  // complete    正常给出最终回答
  // max_steps   触达步数上限、由收尾调用产出结论(可能不完整)
  // no_response 模型既无工具调用也无内容
  // truncated   生成被 max_tokens 截断,回答停在半句
  // aborted     用户主动中断 —— 是正常退出路径,不是失败
  stopReason: 'complete' | 'max_steps' | 'no_response' | 'truncated' | 'aborted';
  steps: number;              // 主循环实际步数(收尾调用不计入)
}

// onEvent 逐轮传,不在装配期固定 —— 传了才走流式(见下)
run(initialMessages: Message[], onEvent?: AgentEventSink): Promise<AgentRunResult>
```

**关键设计**:返回对象而非裸字符串 —— 退出路径有五条,字符串只能表达一种
(`no_response` 以前返回一句写死的话、与真实回答同通道,壳会把内部状态当回答打出)。

- **`truncated` 必须与 `complete` 分开**:被截断的回答**看起来**是正常回答
  (有内容、无工具调用),混在一起用户只看到「话说到一半就没了」,
  没有任何东西指向 `max_tokens`。它也必须与 `no_response` 分开 ——
  开着思维链且预算给小时,预算会被思维链吃光、`content` 为空,
  那时报「模型无有效响应」是**错的归因**:模型响应了,是我们没给它说完的余量。
  两者的处置完全相反(一个该查模型/提示,一个该调大预算或关思维链)
- **`aborted` 是正常路径而非异常**:走异常的话界面标红、日志报 error ——
  用户只是点了「停止」,那看起来像自己把程序弄坏了;而且异常会丢掉
  已经生成的半截内容。中断必须**第一个**判(在 `isRetryable` 之前),
  否则将来有人往可重试特征里加 `'abort'` 一类的词,点一次停止就会打出三次新请求
- 子 agent 必须把 `max_steps` 转成 `SubAgentResult.truncated` 继续上传:
  截断是嵌套的,中间任何一层吞掉信号,主 agent 就会把半成品当定论

### AgentEvent (过程事件 / 流式)

```typescript
type AgentEvent =
  | { type: 'content';    text: string }      // 正文增量
  | { type: 'reasoning';  text: string }      // 思维链增量(壳通常折叠)
  | { type: 'reset' }                         // 重试:丢弃本步此前所有增量
  | { type: 'step';       step: number; maxSteps: number }
  | { type: 'tool_start'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_end';   id: string; name: string; ok: boolean; summary: string }
  | { type: 'done';       stopReason: AgentRunResult['stopReason']; steps: number };

type AgentEventSink = (event: AgentEvent) => void;
```

**关键设计**:

- **不只做 token 流**:用户等的十几秒里信息量最大的不是逐字吐字,而是
  「它在干什么」。Orchestrator 本来就知道第几步、调了哪个工具,一并推出去
- **流式是独立分支,非流式那条路径一个字节没动**:两者的**重试单元不同** ——
  非流式只包「发请求」(`JSON.parse` 在 retry 之外,坏参数立即抛);
  流式必须包整段消费(可能中途断)。合并会把 `JSON.parse` 挪进 RetryHandler
  的匹配范围,是不报错的行为改变。代价只是 trace/catch 各写一份
- **没人听就不付流式成本**:`onEvent` 逐轮传参而非装配期固定 ——
  Orchestrator 是会话级的,而「这轮要不要流式」是每轮的事。没传则不传 `onDelta`,
  adapter 走非流式(流式要多一层分片累积,`usage` 还得靠 `stream_options` 额外索要)
- **只有主循环流式**:压缩、摘要、记忆抽取的产物是给机器解析的 JSON;
  子 agent **不转发** —— 它的推理混进主流,用户分不清哪句是谁说的
  (与 `request_help` 不下放同一个理由)
- **`done` 收在一个 `finish()` 里**:四个 return 点各写一次 emit 迟早漏一个,
  而漏了不报错 —— 壳只是永远等不到结束信号(光标一直转)
- **工具调用轮次没有流式**:`tool_calls` 的 `arguments` 逐字拼,半截 JSON 不能
  parse 更不能执行,所以 `tool_start` 只能在流结束后发。这是协议决定的
- **`reset` 的擦除由壳实现**:Electron 客户端只清一个 DOM 节点;其他壳若以后恢复,
  也必须自己处理展示介质,不把 UI 细节塞回 core

### AgentSession (壳与内核的边界)

```typescript
interface AgentSession {
  readonly info: SessionInfo;              // 装配算出的事实,壳不重算
  readonly notices: readonly SessionNotice[];   // 装配期告警,壳决定怎么呈现
  run(input: string, onEvent?: AgentEventSink): Promise<AgentRunResult>;
  dispose(): Promise<void>;                // **必须调**
}
```

**关键设计**:三条边界让「壳可替换」这条总纲真正成立(早期命令行壳曾有 937 行、
21 段装配,照那样再写一个客户端只能整段复制 —— 本项目已在「同一份事实写两处」
上栽过四次:`visionAnalyzer` / `pythonExecutor` / `models.vision` / `fsDeniedPaths`)。

- **装配期零输出**:告警以 `notices` 返回。`console.log` 写在 core 就等于把
  展示逻辑焊死在业务层
- **`onConfirm` 必须由壳提供,且没有默认实现**:`run_command` 全部的安全性就是
  用户读那一行原样命令,给个默认放行等于让这道边界在某些壳里静默消失
  (`main.ts` 曾经 `async () => true`,那是无人看守的任意命令执行)
- **`SessionInfo` 让壳不重算任何事实**:venv 到底用上没有、实际哪个解释器、
  缺哪些依赖。`pythonDir` 就踩过 —— 两处各算一份,而错位不报错、
  只表现成「venv 里装了、代码里 import 不到」
- **`dispose()` 是必须的**:常驻 chromium 是 detached 的,不关会一直锁着
  profile 目录导致下次启动失败(实测)

### ContextManager (上下文管理)

```typescript
// 按对话顺序**平铺**存储,不按 assistant_iterations 分组
interface Turn {
  turn_id: number;
  messages: Message[];   // [0] 必为用户提问;中间任意;末尾可能是最终回答
  timestamp: number;
}

// 取值靠位置约定,不靠专门字段
turnUserMessage(turn)    // messages[0]
turnFinalResponse(turn)  // 末尾不带 tool_calls 的 assistant

interface TopicSummary {
  id: string;
  title: string;              // 主题名称(如"文件操作")
  summary: string;            // 检索索引(≤60 字):做了什么 + 结果
  turn_ids: number[];         // 关联的 Turn
  keywords: string[];
  timestamp: number;          // 按此排序(时间滑动窗口)
}
```

**关键设计**:
- **平铺存储,因为分组结构是「有损」的**:只有被显式建模的字段才能重建回来,
  漏建模 = 静默丢数据。实际踩到两次:①assistant 的 `content` 没存,重建时硬写 `''`,
  模型调工具时说的话压缩后全消失;②工具产出的图片要另起一条 user 消息承载,
  而旧结构 `user_message` 是单数字段装不下,Mid-Turn 压缩时图片被丢弃 ——
  但 tool 响应还写着「图片已附加」,模型会基于不存在的观察作答。
  平铺后重建就是 `[...turn.messages]`,**没有重建逻辑就没有重建 bug**,
  将来加视频/音频也不必再动结构
- **顺序合法性由写入时保证,不靠重建时拼对**:`add*` 按调用顺序 append,重建只是摊平。
  由此 assistant 声明 N 个 tool_call 后紧跟 N 条 tool 响应的配对天然成立
  (中间插任何消息都会 400)。要守的纪律落在 orchestrator:
  `addObservation()` 必须在该轮**全部** `addToolResult()` 之后调用
- **`final_response` 必须显式写回**(`addFinalResponse`):它是压缩后重建保留轮次时
  答案的唯一来源。不写回则模型看不到自己此前的回答
- 主题聚类压缩:LLM 分析主题 → 生成索引 → 按时间窗口保留最新 N 个。
  触发只有一处:标志位由 `recordTokenUsage()` 置真、`preparePrompt()` 消费
- 归档到 `<traceDir>/{sessionId}/archive/`,与 `calls/` 并列。不放隐藏目录:
  **模型自己要读它**(压缩后被提示用 `read_file` 回溯),沙箱收窄会让它指向读不到的路径。
  注入的路径统一用正斜杠 —— `path.join` 在 Windows 产出反斜杠,模型当 JSON 参数传回还得转义
- **压缩渲染必须区分「用户提问」与「工具观察」**:平铺后两者都是 `role:'user'`,
  靠位置区分(`messages[0]` 是提问,之后的是观察)。混为一谈会让压缩模型把截图
  写成「用户说过的话」—— 即下方「压缩注入假事实」那条。
  工具结果按 `tool_call_id` 配对标注工具名,不按下标 —— 并行乱序返回时下标会错位

---

## 安全与权限

**两层权限模型**:

1. **静态层 (Tool.needs)**:
   ```typescript
   class ReadFileTool implements Tool {
     needs = ['fs'] as const;  // 只能访问文件系统
   }
   ```
   - 工具声明能碰哪类资源
   - 框架限制:没声明 'python' 就拿不到 PythonExecutor

2. **动态层 (SecurityGuard)**:
   ```typescript
   class SecurityGuard {
     // baseDir = 工作区,相对路径的解析基准
     constructor(grants: FsGrant[], deniedPaths?: string[], baseDir?: string);
     checkFsAccess(targetPath: string, mode: 'read' | 'write'): boolean;
     // 返回检查时用的绝对路径 —— 调用方必须拿它做实际 IO
     assertFsAccess(targetPath: string, mode: 'read' | 'write'): string;
   }
   ```
   - 运行时检查具体参数(路径是否在授权范围内、该档位允不允许这个动作)
   - 沙箱机制:`realpathSync` 解析符号链接 + `path.relative` 判断逃逸
   - **相对路径按工作区解析,不按 `process.cwd()`**:Python 子进程的 cwd 是工作区,
     两边基准不同会出现「代码里 `os.path.exists` 为 True,经工具桥调工具却被拒」
     (实测)。更危险的一侧是**检查路径 A、读取路径 B** —— 项目目录下有同名文件时,
     检查通过而读到的是未授权的那一个。故 `assertFsAccess` 返回已解析路径,
     `FsDriver` 一律用它做 IO,不用入参

**关键设计**:
- 模型无法绕过:权限在框架代码里,不在 prompt
- 错误回流:权限拒绝 → `ToolResult{ok:false}` → 模型看到错误学习边界
- 危险工具需确认:`danger: true` 的工具,runner 调用前弹确认

---

## 上下文管理策略

| 场景 | 策略 | 默认阈值 |
|------|------|------|
| **长会话历史** | 主题聚类压缩 | 70% 窗口 |
| **窗口告急** | 突破轮次门槛强制压缩 | 90% 窗口(高水位) |
| **压缩保留** | 最近 N 轮完整 Turn | 10 轮 |
| **主题数量** | 时间滑动窗口 | 10 个 |
| **工具返回过大** | 由**工具自己**报错并给收窄建议 | 各工具自定 |

**压缩流程**:保留最近 N 轮 → 旧 Turn 交 LLM 分析主题并聚类 → 每主题生成
检索索引(≤60 字) → 按时间保留最新 M 个 → 索引插入 system 消息、旧 Turn 归档到磁盘。
触发只有一处:`recordTokenUsage()` 置标志位、`preparePrompt()` 消费(详见设计决策)。

---

## 关键设计决策

这一章只写架构层面的「是什么」和「为什么」。具体事故表现、定位过程和实测症状统一放在 [pitfalls.md](pitfalls.md)。保留这些权衡是为了让后续维护者知道哪些复杂度是刻意留下的,哪些只是历史包袱。

- **平台定位在 PC 本地,不是移动端或云端服务。** BaseAgent 要操作真实文件、真实浏览器和本机程序,这些能力在 PC 上天然可达,在手机上会被系统权限模型切碎。服务端形态可以换成容器和多租户隔离,但那会牺牲本地登录态、桌面浏览器和用户目录操作,不是当前产品路线。

- **分层只允许单向依赖:`interface -> core -> tools -> executors -> platform`。** 交互层是壳,内核负责任务决策,工具层负责契约和调用管线,执行器碰真实资源,platform 放横切能力。这个方向让 Electron 和后续语音/其他 GUI 壳都能共用同一个内核,也避免 executor 为了跑子 agent 反向 import core。

- **装配只有一处:`core/session.ts`。** LLM、工具注册、执行器、上下文、记忆、技能、浏览器和确认回调都在这里接线,入口只消费 `AgentSession`。替代方案是每个入口各自装配,短期看直观,长期会让资源清单、路径推导和提示词事实漂移;项目已经多次踩过这类问题,细节见 [pitfalls.md](pitfalls.md#一同一份事实写两处--本项目栽过五次)。

- **接口块必须照源码校正,不能写成概念草图。** 架构文档里的 `Tool`、`ToolContext`、`AgentRunResult` 等代码块是跨模块契约,不是示意图。删掉代码块会让读者失去边界形状,写成近似代码又会误导实现;所以这些块宁可短,也要和 `src/**` 中的真实类型对齐。

- **工具是扩展点,但内核不认识具体工具。** 每个工具实现统一 `Tool` 契约,通过 `needs` 声明资源,再由 `ToolRunner` 注入执行器。这样新增能力通常只需要注册工具,不用改 orchestrator。代价是工具边界必须清楚:资源访问、危险确认、错误回流都要走 runner,不能在工具里私自绕线。

- **权限分两层:静态资源声明 + 动态参数检查。** `Tool.needs` 决定工具能拿到哪类执行器,`SecurityGuard` 决定这次参数是否落在授权范围内。规则在代码里而不是 prompt 里,模型撞墙后通过 `ToolResult{ok:false}` 学边界。替代方案是让模型自觉遵守说明,但那无法约束真实 IO。

- **所有工具错误都回流主循环,不炸掉主循环。** 参数错误、权限拒绝、执行器异常都包装成 `ToolResult{ok:false}`。这是 ReAct 能自我修正的前提:模型看到错误后可以换路径、收窄范围或向用户说明。只有装配失败、LLM 请求失败这类主循环自身无法继续的错误才向上抛。

- **主循环用 ReAct 起步,Planner 暂不抢跑。** 当前 orchestrator 的单循环已经覆盖“调用模型 -> 执行工具 -> 观察 -> 再决策”的闭环。Planner 只有在真实任务显示 ReAct 明显不够时才值得加,否则会提前引入第二套任务状态和失败模式。它保留在待实现列表,但不是当前稳定化阶段的优先项。

- **触达 `maxSteps` 后收尾,不硬抛异常。** 跑满步数时,orchestrator 会给模型一次不带 tools 的收尾调用,要求基于已有信息给结论并说明未完成部分。硬停会丢掉整轮探索成果,尤其是子 agent 已经读了大量文件时更浪费;不传 tools 则从协议层保证它不能继续行动。

- **退出路径用 `stopReason` 精确表达。** `complete`、`max_steps`、`no_response`、`truncated`、`aborted` 是五种不同语义。`truncated` 不能混进 `complete`,否则用户只看到半截回答;也不能混进 `no_response`,因为那通常是生成预算被思维链吃光。`aborted` 是用户主动停止,应当是正常路径而不是错误。

- **流式事件不只是 token 流。** `AgentEvent` 同时描述正文、推理、步骤、工具开始/结束、重试 reset 和 done。用户等待时最需要知道的是 agent 正在做什么,不是只看逐字输出。流式只在有监听者时启用,压缩/记忆/技能这类机器解析调用不走流式,子 agent 的内部推理也不混进主流。

- **上下文按 Turn 平铺存储。** 一轮对话保存为按真实顺序排列的 `messages`,不再拆成 `user_message + assistant_iterations` 之类的分组结构。分组看起来结构化,但只能保存预先想到的字段;一旦 assistant 调工具时同时说话、或工具观察以 user 消息注入,重建时就会静默丢数据。相关事故见 [pitfalls.md](pitfalls.md#二上下文与压缩)。

- **压缩产物是检索索引,不是文章摘要。** 旧 Turn 归档到磁盘,上下文里只保留“做了什么 + 结果”的短索引,供模型判断要不要用 `read_file` 回溯原文。索引常驻上下文,越短越有价值;字数只给上限不给下限,避免模型为了凑字复述过程。

- **压缩触发只认 API 返回的真实 `prompt_tokens`。** `recordTokenUsage()` 置标志位,`preparePrompt()` 在下次请求前消费。不做发送前预估,因为上下文主要被工具结果和模型输出撑大,只估用户消息会产生虚假的精确感。窗口告急时高水位可以突破“保留最近 N 轮”的门槛,优先保证会话不崩。

- **工具结果大小由工具自己管,不在 context 层无声截断。** `read_file`、`search_files`、`execute_python` 这类工具知道自己的数据结构,能返回总量、截断原因和收窄建议。context 层如果偷偷截断,模型会以为看到了全部内容,基于残缺事实下结论,这比直接报错更危险。

- **会话历史和压缩归档是两份存储。** `turns.jsonl` 保存完整原始对话给前端历史使用;`archive/` 保存被压缩挤出的轮次给模型回溯。两者读者不同,不能合并。`history()` 刻意读文件而不是 `context.peekTurns()`,因为后者会被压缩截断。

- **`turn_id` 必须独立单调递增。** 不能由 `turns.length` 派生,因为压缩会截短内存中的 turns 数组。撞号会让主题映射、归档文件、历史落盘进度全部静默错乱。续接会话时从历史最大 turn id 抬高计数器,取 max 而不是 length,以兼容坏行被跳过的情况。

- **大上下文子任务交给一次性子 agent。** 遍历代码库、批量抓取、多站点比对这类任务会吞大量原始内容,下放后原始内容留在子 agent 自己的上下文里,主 agent 只拿高密度结论。子 agent stateless、用完即弃;stateful + LRU 池是后续增强,当前不承担这份复杂度。

- **子 agent 结构上不能递归,安全边界也不放宽。** 子 agent 继承父 registry,但过滤掉 `needs` 含 `agent` 的工具,同时 `InheritableRunnerConfig` 类型本身不含 `subAgentRunner`。它共享父级 signal、confirm、授权列表和执行器,所以取消和危险确认仍由主会话兜住。资源整份继承,避免逐字段转发遗漏,事故细节见 [pitfalls.md](pitfalls.md#一同一份事实写两处--本项目栽过五次)。

- **子 agent 的环境提示与主 agent 同源。** 浏览器是否常驻、能不能用 Python、工具是否收敛、视觉怎么调用,这些不是角色差异,必须由 `buildEnvironmentPrompt` 生成并嵌入两份提示。角色说明可以不同:主 agent 负责下放与向用户求助,子 agent 看不到主历史、不能请求用户帮助、也不能执行外部命令。

- **长期记忆与上下文压缩分开。** 压缩解决“这次会话还能不能继续”,记忆解决“下次会话是否知道用户偏好”。记忆只存稳定用户特征,不存当前任务进展;抽取器只提出候选和矛盾,合并由代码做,结构上不能删除旧条目。错的长期记忆会每轮注入,所以用户必须能查看和清空。

- **技能库记录可复用轨迹,但审批前不可用。** 技能沉淀看单轮工具活动:达到工具步数门槛或出现工具失败,且 `stopReason === 'complete'` 才异步抽取。入库一律 `pending`,人工审批前不进索引、`load_skill` 取不到。索引只放名字和描述,正文按需加载,以保住系统提示的 prompt cache 稳定性。

- **动作空间向 CodeAct 收敛。** Python 可用时,查时间、写文件、列目录等“代码一行能做”的工具从模型清单里移走,减少每次请求的 schema 成本,也避免工具和等价代码两条路让行为不可预测。`read_file` / `search_files` 仍保留,因为它们带返回量控制;`execute_python` 是动作空间入口。

- **代码执行边界是写护栏,不是强沙箱。** `execute_python` 以当前 OS 用户身份运行,框架用 audit hook 拦写操作,用 env 白名单、输出上限和进程树回收降低爆炸半径。读侧不能做白名单,否则正常 import 会被误伤;所以只拦凭证类路径。换进程可绕过 audit hook 是已知缺口,详见 [pitfalls.md](pitfalls.md#三权限与沙箱边界)。

- **写按白名单,读按黑名单。** 写/删不可逆,所以只允许工作区和临时目录;读普通文件的误伤成本高,而读到凭证的代价极高,所以读侧只挡 `.env`、私钥、云凭证、token、浏览器 profile 等纯负债路径。`read-deny.ts` 作为同源清单供 fs 工具和 Python audit hook 共用。

- **框架托管沙箱 venv,不要求用户手工创建。** `PYTHON_PATH` 是基础解释器,启动时框架准备项目根下的 `.sandbox-venv`,成功则用 venv 解释器,失败则回落并告警。这样装包不会污染全局环境;路径按平台推导,避免 Windows `Scripts/` 和 Unix `bin/` 各写一份配置。

- **装包走 `run_command`,代码里默认禁止 pip。** Python 代码中的 pip 通过 `PIP_NO_INDEX` 变成不可用,外部程序和装包必须走 ShellExecutor 背后的 `run_command`。这个通道没有机制边界,但它把危险操作变成用户能读清的一行原样命令。它不下放给子 agent,因为子 agent 的推理上下文用户看不到,确认会变成盲点。

- **浏览器由框架常驻,模型代码只连接 CDP。** 每轮自己 `launch()` 会丢页面停留位置,只靠 profile 也只能保登录态。框架启动有头 Chromium,模型通过 `BROWSER_CDP_URL` 连接,不要关闭 browser/context。客户端把浏览器提到进程级复用,切会话不重启;谁创建谁关闭,否则 profile 会被孤儿进程锁住。

- **浏览器是代码里的库,不是一组浏览器工具。** 导航、定位、点击、DOM 提取都交给 Python + Playwright,让筛选发生在子进程内,不要把整页 HTML 灌进上下文。框架只兜住 stdout 上限、截图和视觉观察。替代方案是做 BrowserDriver 工具组,但长尾交互无穷,还会把大 DOM 变成工具返回。

- **工具桥只暴露代码本身碰不到、且必须由框架投递的能力。** 当前桥只暴露 `screenshot` / `view_image`。`read_file` / `search_files` 在 Python 里有 `open` / `glob`,经桥调用只是冗余;`request_help` 在代码块中不能真正暂停;`spawn_subagent` 套在代码执行里收益不清且失败难查。桥启动成功后才隐藏对应工具,避免两条路都断。

- **视觉是插件,不是主模型的输入通道。** 配了 `VISION_MODEL` 才注册看图能力;图片交给视觉模型,主模型只接收文字观察。因此主模型是否多模态不影响架构,也方便换成更强文本模型。代价是主模型看不到没问到的图像细节,追问要再调一次;收益是主上下文不再携带图片。

- **视觉观察由框架投递,不交给 Python 代码。** 经工具桥看图时,代码触发调用但拿不到观察本体,观察走 `ToolResult.observations` 回到主循环。原因是模型常常不会 `print` 函数返回值,如果把观察只返回给代码,花过钱的视觉结果会静默消失。`question` 必须明确,否则视觉模型只能给泛泛描述。

- **Electron 是主客户端,不是本地 HTTP server。** Agent 需要 Node 主进程来 spawn Python、开 SQLite、连 CDP;Electron 用 IPC 暴露窄接口,没有 localhost 端口和额外鉴权面。渲染进程按不可信环境处理:`contextIsolation: true`、`nodeIntegration: false`,明文 key 不进页面。代价是多一份 Chromium,但它与被 agent 控制的常驻浏览器必须分开。

- **客户端配置写用户配置目录,不写回 `.env`。** `.env` 是回落来源,而 `config.ts` 的默认配置在模块加载时求值,写回 `.env` 不会热生效。配置面板写 JSON,保存后重建会话;workspace 会派生 fs 授权、Python cwd、写边界和浏览器 profile,假装热更新只会制造“界面显示新值、实际跑旧边界”的错位。

- **Markdown 渲染自己构 DOM,不走 HTML 字符串。** 模型输出和网页片段都是不可信文本。`markdown -> HTML -> innerHTML` 需要再依赖消毒器,漏一个选项就是 XSS;当前渲染器全程 `createElement` + `textContent`。流式期间只追加纯文本,done 后一次性渲染,避免半截 Markdown 反复改变结构。

- **可观测靠 trace,日志只放运行线索。** Adapter 通过 `onTrace` 记录线格式请求和原始响应,TraceRecorder 负责落盘。定位模型行为问题需要知道实际发出的 messages/tools、finish_reason、usage 和服务端原始返回;日志只适合记录步骤、警告和路径。trace 写盘失败只告警,不影响任务。

- **原生依赖要按运行时 ABI 处理。** `better-sqlite3` 在 Node 和 Electron 中对应不同 ABI,所以 Storage 惰性加载,只有真正构造 SQLite 时才碰 `.node` 文件。Electron 侧需要时用 `npm run rebuild:native` 重编。Vitest 不做类型检查,所以测试通过不等于 `tsc --noEmit` 通过。

- **明确不做的事也要写成决策。** 本地形态暂不做容器隔离、网络管控、读路径白名单、代码执行中途确认、子 agent stateful 驻留池等。它们不是忘了,而是当前成本和收益不匹配,或会给用户一个虚假的安全感。以后若产品形态变成服务端,这些决策要重新评估。

---

## 实现状态

### ✅ 已完成

- **Interface**:Electron 客户端是当前正式交互壳,消费 `core/session.ts`,提供历史侧边栏、配置面板、危险命令确认、技能审批、流式渲染和安全 Markdown 渲染。
- **Core**:`AgentSession` 统一装配、`Orchestrator` ReAct 主循环、`LLMClient`/`DeepSeekAdapter`、`ContextManager`、`TokenCounter`、`session-store`、长期记忆、技能沉淀、视觉分析、一次性子 agent、系统提示组装。
- **Tools**:统一工具契约、注册表、调用管线和内置工具。工具按 `needs` 声明资源,runner 负责参数校验、资源注入、危险确认和错误包装。
- **Executors**:文件系统驱动、Python 执行器、Shell 执行器、常驻浏览器、浏览器操作、工具桥、沙箱 venv、env 白名单、读黑名单、输出上限和进程树回收。
- **Platform**:配置加载、客户端配置持久化、日志、trace、重试、错误类型、安全检查和 SQLite KV 存储。

### ⏳ 未实现 / 冻结项

- **HttpClient**:HTTP 抓取/下载执行器尚未落地。目前网页与 API 探索主要通过 Python/Playwright 或 Python 标准库完成。
- **Planner**:多步任务拆解模块仍未实现。当前 ReAct 单循环尚未暴露必须引入 planner 的证据,暂不抢跑。
- **Voice**:语音输入/播报仍是预留壳,不影响核心 Agent 能力。
- **客户端打包**:开发期 Electron 主进程通过 `tsx` 直接加载 `.ts` 源码;打包 exe 时需要改成加载编译产物并处理原生依赖。
- **服务端级隔离**:容器、独立用户、网络管控等只在服务端/多租户形态下重新评估,不作为当前本地路线的功能目标。
- **子 agent stateful 模式**:保留上下文续传和 LRU 驻留池属于后续增强,当前只保留一次性子任务执行。

---

## 技术选型

| 模块 | 技术 |
|------|------|
| 语言 | TypeScript, ES modules |
| 模型接入 | OpenAI SDK 兼容接口;默认 DeepSeek,内核依赖 `LLMClient` 抽象 |
| 客户端 | Electron;主进程/预加载脚本用 CommonJS,开发期经 `tsx` 加载 TS 源码 |
| 浏览器自动化 | Playwright 运行在 Python 环境内,通过常驻 Chromium 的 CDP 连接 |
| 代码执行 | Python 子进程 + audit hook 写护栏 + stdout/stderr 上限 + 进程树回收 |
| 外部命令 | Shell 子进程,仅经 `run_command` 人工确认后执行 |
| 持久化 | SQLite(`better-sqlite3` 惰性加载) + JSONL 会话历史 |
| 参数校验 | Zod + `zod-to-json-schema` |
| 可观测 | FileLogger + TraceRecorder 记录线格式 LLM 请求/响应 |
| 测试 | Vitest 单元测试 + `tsc --noEmit` 类型检查 |

---

## 下一步

当前路线是**收束文档、验证真实链路、修已知 bug**,不主动扩新功能。

1. 精修本文档与 README,让它们只保留核心架构、边界与入口说明;事故细节继续沉到 [pitfalls.md](pitfalls.md)。
2. 重新跑 `npm test` 与 `npm run typecheck`;如果改到 Electron 渲染层,还要重启客户端做真实界面验证。
3. 按 [pitfalls.md](pitfalls.md#十待补的坑已知但还没修) 处理已知 bug:子进程中断、技能库覆盖、注定无效的重试、工具桥重建等。
4. `HttpClient`、Planner、Voice、打包、stateful 子 agent 等保持冻结,除非后续明确重新开启功能开发。
