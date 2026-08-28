# BaseAgent — 架构设计文档

> **BaseAgent** —— 一个自然语言驱动、可扩展工具、以浏览器操作为重点扩展方向的 PC 端通用 Agent。
> 技术栈:TypeScript 全栈。默认壳:CLI + 文字输入(语音/GUI 作为可后插模块预留)。
> 模型:DeepSeek V4 Pro 起步(上下文 1M),但内核不绑定任何厂商(见 llm-client 的 provider 中立设计)。

---

## 设计总纲

> 一条数据流贯穿到底:`输入 → 内核决策 → 经调用管线 → 工具执行 → 结果回流内核`。
> 内核不认识任何具体工具,工具不认识内核,两者只通过「注册表 + 统一契约」对话。
> 这就是可无限扩展的根。

核心解耦原则:

- **交互层(壳)可替换** —— CLI / 语音 / GUI 只做「输入→文本」与「结果→展示」,零业务逻辑。
- **内核只知道「有一批工具可用」**,不 import 任何具体工具实现。
- **工具只实现统一契约**,写完塞进注册表,内核自动可用。
- **通用横切能力(日志/权限/校验)** 挂在「调用管线」这个唯一入口上,工具不各写一遍。

---

## 整体模块框架

```
┌──────────────────────────────────────────────────────────┐
│  interface/  交互层(壳,可替换)                            │
│    · cli          已实现:REPL/单发 + 调试回显(turn/token)  │
│    · app/         已实现:Electron 客户端(流式、历史侧边栏) │
│                   含自写 Markdown 渲染(只建 DOM,不碰 HTML) │
│    · voice        预留:ASR 语音转文字 / TTS 播报            │
│    职责:只做 输入→文本 / 结构化结果→展示,零业务逻辑        │
│    关键:两个壳共用 core/session.ts 一份装配,壳不重算事实   │
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
│    · http-client   HTTP 请求(抓 API / 下载文件)           │
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
用户输入 → CLI(interface)
         → Orchestrator(core) 调 LLMClient 拿决策
         → 决策含 tool_call → ToolRunner(tools) 校验/注入资源
         → Tool.run() 调用 Executor(executors) 操作资源
         → ToolResult 回流 → Orchestrator 再调 LLM
         → 多轮后得到 final_response → CLI 展示
```

---

## 核心接口

### Tool Contract (工具统一契约)

```typescript
interface Tool {
  name: string;
  description: string;
  parameters: ZodSchema;        // Zod 校验参数
  needs: readonly ResourceType[];  // 声明依赖资源 ['fs', 'python', ...]
  danger: boolean;              // 是否危险操作(写入/删除)
  run(args: T, ctx: ToolContext): Promise<ToolResult>;
}

interface ToolContext {          // runner 组装,是唯一的资源注入点
  executors: Record<string, Executor>;  // 按 needs 注入(含 agent = 子 agent)
  confirm: (prompt: string) => Promise<boolean>;
  signal: AbortSignal;          // 用户取消
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
  stopReason: 'complete' | 'max_steps' | 'no_response';
  steps: number;              // 主循环实际步数(收尾调用不计入)
}

// onEvent 逐轮传,不在装配期固定 —— 传了才走流式(见下)
run(initialMessages: Message[], onEvent?: AgentEventSink): Promise<AgentRunResult>
```

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
- **`reset` 的擦除由壳实现**:终端要按宽度算 ANSI 回退行数,客户端只是清一个
  DOM 节点 —— 两边不共用代码,共用只会让两套逻辑互相将就

### AgentSession (壳与内核的边界)

```typescript
interface AgentSession {
  readonly info: SessionInfo;              // 装配算出的事实,壳不重算
  readonly notices: readonly SessionNotice[];   // 装配期告警,壳决定怎么呈现
  run(input: string, onEvent?: AgentEventSink): Promise<AgentRunResult>;
  dispose(): Promise<void>;                // **必须调**
}
```

**关键设计**:三条边界让「壳可替换」这条总纲真正成立(抽出前 cli.ts 有 937 行、
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

### Orchestrator (ReAct 主循环)

**关键设计**:返回对象而非裸字符串 —— 退出路径有三条,字符串只能表达一种
(`no_response` 以前返回一句写死的话、与真实回答同通道,CLI 会把内部状态当回答打出)。
用联合类型而非布尔,将来加「用户取消」只需加成员。
子 agent 必须把 `max_steps` 转成 `SubAgentResult.truncated` 继续上传:截断是嵌套的,
中间任何一层吞掉信号,主 agent 就会把半成品当定论。

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

- **平台 = PC**:个人开发者唯一能真正操作「外部世界」的地方(手机被系统权限墙挡死)。
- **工具作为独立一层 + 可插拔**:加能力 = 写新 Tool 塞进注册表,内核零改动。
- **模型不绑定厂商**:DeepSeek V4 起步,但内核只对话中立的 llm-client,换模型 = 加 adapter。
- **主循环有刹车,但到顶不硬停**:触达 `maxSteps` 时不抛异常,而是追加
  「已达上限,请给结论并说明未完成部分」的提示,再调一次**不带 tools** 的 LLM 收尾
  (不占常规步数;收尾自身失败才抛 `MaxStepsExceededError`)。
  - 理由:硬停丢掉整轮探索的全部成果。子 agent 尤其贵 —— 跑满 15 步读了十几个文件,
    抛异常后主 agent 只收到「执行失败」,token 白花且拿不到部分结果
  - 不传 tools 是协议层约束:仅在提示里说「不要调工具」,模型仍可能返回 tool_calls
  - 必须要求模型说清**未完成部分**,否则后续补齐是盲的。但刻意**不给重试建议** ——
    新子 agent 是全新上下文,不知道上一个卡在哪,大概率相似范围重跑撞同一面墙
  - 提示借**最后一条工具结果**注入(`_system_note` 键),天然落在 assistant/tool
    配对之内,不必关心「插在哪里才合法」
- **规划范式起步用纯 ReAct**:orchestrator 单循环即可,planner 留作后续增强,避免过度设计。
- **两类 LLM 调用分开**:只有主循环走 ReAct(带工具/刹车);压缩、摘要、分类是一次性单发调用,
  直接调 `complete` 原语,不套循环。
- **两层权限**:能碰哪类资源 = `needs` 静态绑死;这一次准不准 = security 运行时按参数判。
  规则住代码里、不进 prompt,模型撞墙后从错误学边界,零常驻上下文。
- **ToolContext 是接线枢纽**:取消/确认/资源访问都经 ctx 注入,工具不自己 import。
- **所有报错回流 loop**:参数不合法/权限拒绝/工具抛异常一律包成 `ToolResult{ok:false}`,永不炸主循环。
- **主题窗口按时间排序,不是 LRU**:对话的时间局部性 >> 访问局部性,
  用户很少跳回旧主题。不引入 `lastAccessTime`,避免复杂度。
- **结构化输出替代正则提取**:主题分析/摘要生成走 `responseFormat: 'json_object'` + Zod 校验。
  正则解析模型自由文本极脆弱,格式漂移即静默丢数据;校验失败视为可重试错误让模型重新生成。
- **重试只作用于幂等操作,且分层不叠乘**:LLM 调用、JSON 解析/校验走 RetryHandler,
  工具执行**不走**(写文件/发请求重试会产生重复副作用)。
  分层是:adapter 内层管网络错误/限流/5xx,ContextManager 外层用 `explicitOnly`
  只重试显式的 `RetryableError`。两层都按错误特征匹配会让真实调用次数**相乘**
  (各 3 次 → 最坏 16 次),而关掉 SDK 自带重试只解决了三层里的一层。
  粒度是单次 LLM 调用 —— 一个主题的摘要失败不会导致整批重来。不做熔断(单进程 CLI 属过度设计)。
- **压缩失败降级而非中断**:主题分析失败 → 归入默认主题;摘要生成失败 → 占位摘要。
  压缩是保命机制(防超窗口),中断它比丢一段摘要严重得多。
- **压缩必须看到完整轨迹**:送给压缩模型的每轮包含「提问 + 工具调用 + **工具结果** +
  **最终回答**」,不是只给提问和工具名。缺了结果和回答,模型只能靠猜补全 ——
  实测出现过「工具调用后未返回具体时间数据」这种与事实相反的摘要,而那轮工具明明成功了。
  **压缩注入假事实比丢一段摘要严重得多**。输入按字段截断(保留开头,`ok` 标志在前),
  最终回答的额度给得比工具结果宽 —— 它是对原始输出的蒸馏,单位字符信息密度更高。
- **压缩时机只有一处**:`recordTokenUsage()` 按 API 返回的真实 `prompt_tokens`
  置标志位,`preparePrompt()` 在下次发 prompt 前消费。一份实现同时覆盖 Turn 内
  溢出和 Turn 边界溢出(进行中的 Turn 取出、重建后追回)。
  不做发送前的 token 预估 —— 吃窗口的是工具返回和模型输出,预估 user 消息属虚假精确。
- **窗口告急时,「保留最近 N 轮」让位于「不崩」**:`recentTurnsToKeep` 是硬门槛,
  但单轮很大时可能在攒够 N+1 轮前就撑破窗口,常规压缩会因轮次不足一直跳过直到 API 报错。
  三层防护:①工具自己限制返回量 ②超过**高水位**(默认 0.9,须高于常规阈值)
  突破轮次门槛强制压缩、最少保留 1 轮 ③日志按紧迫度分级,不静默。
  与「压缩失败降级而非中断」同一原则:宁可少留几轮,也不能让会话崩掉。
- **工具结果的大小由工具自己管,不在 context 层截断**:超限返回 `ok:false` +
  实际总量 + 收窄建议,走「所有报错回流 loop」让模型改道。
  理由:context 层无声截断会让模型以为看到了全部、基于残缺数据推理(如据残缺目录
  断言「没有 .py 文件」);且只有工具懂自己的数据结构,能给出有意义的恢复路径。
- **大上下文任务由模型自己决定下放子 agent**:需要吞大量上下文的子任务
  (遍历代码库、批量抓取)交给子 agent,只把最终回答交回主 agent。
  从源头避免主上下文膨胀比事后压缩更根本 —— 这也是高水位只需做「兜底」的前提。
  决策权在模型,框架只提供能力和边界。三条约束:
  ①**结构上杜绝递归** —— 子 agent 继承父 registry 全部工具但跳过 `needs` 含
  `'agent'` 的,不靠深度计数去兜;②**安全边界不放宽** —— 共享父级 `signal` 与
  `confirm`,权限仍由 `needs` + SecurityGuard 两层管住;③**结果即蒸馏** ——
  直接返回 `final_response`,不再多调一次 LLM 做摘要。
  起步只做 stateless;stateful + LRU 驻留池留作后续增量。
  接口定义在 tools 层、实现在 core 层并由入口注入,避免 executors → core 反向依赖。
  - **资源与边界整份继承(`InheritableRunnerConfig`),不逐字段转发**:
    子 agent 自己建 `ToolRunner`,而逐字段转发**实测漏过两次** ——
    先漏 `visionAnalyzer`,又漏 `pythonExecutor`。后者的表现极具误导性:
    子 agent 注册了 `execute_python` 却拿不到执行器,每次返回「未初始化」,
    它以为是自己代码的问题,连跑 `print("hello")` / `print(sys.version)` 探活,
    白烧十几步才放弃(实测 trace 22 轮)。
    抽成一个对象、由入口构造一次、主 runner 与子 agent 共用同一份之后,
    「新增执行器忘了给子 agent」这个失败模式从结构上消失。
    该类型**刻意不含 `subAgentRunner`** —— 递归的结构性阻断因此有两道:
    工具集过滤 + 类型上就传不进去
  - 连带的构造顺序约束:子 agent runner 必须建在 `pythonExecutor` 等资源之后。
    这类「A 必须先于 B」的隐式顺序是入口层的常见坑,靠回归测试锁住
    (`sub-agent.test.ts` 一次性断言「父 runner 能注入的子 agent 全拿得到」,
    而不是逐个断言某个执行器 —— 后者等于把同一个漏再写一遍)
- **子 agent 的提示词必须与主 agent 环境同源**:提示分成「环境约定」与
  「角色说明」两段,环境段由 `buildEnvironmentPrompt` 产出、两边**逐字相同**,
  只有角色段各写。
  - 起因是实测:子 agent 原本用一段独立短提示,只讲「你是子任务执行器、
    看不到主对话历史、回答要高信息密度」,**对运行环境一无所知**。
    后果按危害排序:
    - **它的错误会毁掉主 agent**:不知道「绝不能 `close()` 浏览器」——
      一次 close 杀掉常驻实例,主 agent 后续所有轮次都接不上,profile 还被锁住
    - **任务直接做不成**:不知道浏览器是框架常驻的,拿 `requests` 硬抓知乎/搜狐,
      没有登录态基本抓不到正文(实测 trace 里就是这么干的)
    - **白烧步数**:不知道动作空间已收敛,会去调 `write_file` 撞「工具未注册」
    - **撑爆自己的上下文**:不知道 stdout 上限与「先提取再打印」
  - **环境参数是必填的,且不接受入口传一段现成的提示**:后者又会变成
    「入口忘了同步」的漏 —— 与逐字段转发执行器同一个失败模式
  - 环境段**不写函数签名**:签名由工具桥从 schema 生成、写在 `execute_python`
    的 description 里。手写一份必然漂移(之前就漏了 `detail` 参数),
    而漂移的表现是「模型照提示调用却报 TypeError」
  - **`request_help` 不下放给子 agent**,而且是**工具层直接不给**、不只靠提示约束:
    子 agent 的输出只回给主 agent,**用户看不到它说的话** ——
    它调 `request_help` 等于打扰了用户却没人告诉用户要做什么,
    而它已经带着未完成的答案返回了。
    遇到登录/验证码时它应把「卡在哪一步、需要人做什么」写进回答,
    交回主 agent 去请用户处理。
    - 按**名字**排除而非按 `needs`:`request_help` 的 `needs` 是空数组
      (它不碰任何执行器),没有可依赖的结构特征。这是唯一按名字排除的工具
    - 两侧提示都要写明这件事:子 agent 侧说「你无法与用户交互」,
      否则它会写「请用户登录后重试」然后等一个永远不会来的回复;
      主 agent 侧说「子 agent 没有这个能力,收到这类回答由你 `request_help`」,
      否则它会把「需要登录」当成任务失败
  - 测试锁的是**同源性**而不是「提示里有某句话」:断言整个环境段被两份提示
    原样嵌入,将来给主 agent 加约定却忘了子 agent 会直接失败。
    这条测试当时就抓到一个真 bug:`pythonEnabled=false` 时收敛段与视觉段
    仍在引用 `execute_python`,而那时它根本不存在(视觉那处更严重 ——
    没有工具桥就不会 `hide()`,`view_image` 仍是普通工具,
    说「必须在代码里调」会让模型写出一段它跑不了的代码)
- **压缩产物是检索索引,不是文章摘要**:目标 60 字以内,只写「做了什么 + 结果」,
  禁止过程叙述。它常驻上下文,用途是让模型判断「要不要读归档原文」,
  翻阅由 `read_file` 完成,所以只需可判别、不需完整。
  字数只给上限不给下限 —— 给下限会逼模型注水复述过程,产出比原文还长(实测发生过)。
- **长期记忆与压缩是两件事**:压缩让**这次会话**能继续(做了什么 + 结果,
  按会话存、会过期);记忆让**下次会话**知道你是谁(习惯 / 偏好,跨会话、变化极慢)。
  混在一起的后果是会话摘要被当长期记忆越攒越多,而真正该记的偏好被压缩掉。
  - **抽取器结构上不能删除条目**:它只输出「本区间看到证据的候选」+
    「与第 k 条矛盾」,合并由代码做 —— 默认全部保留。
    若让它输出整张表(填表式覆写),「用户要说中文」这类十轮前定下、
    本区间完全没体现的条目会被**静默抹掉**,而这种丢失没有任何迹象。
    这一点必须是结构保证,不能靠 prompt 里写一句「没看到的别删」
  - **维度是封闭枚举,没有 misc 兜底**:分维度的全部价值是把抽取从开放式生成
    变成填表 —— 有兜底就会什么都往里塞(「用户在做知乎热搜任务」这类一次性事实)。
    也刻意**不设**「当前在做什么」维度:那类信息按天过期,而记忆是每轮注入的,
    过期的项目描述会持续误导
  - **淘汰按 hits(被重复确认次数),不按时间**:按时间会让越老越稳定的条目先死,
    而那恰恰最该留。限**每维度条数**而非总字数 —— 限总字数会让一个维度写长了
    挤掉其他维度
  - **触发就是每 N 轮一次(默认 3),不叠别的条件**:原先还加了一层
    「token 增量」,实测是错的 —— 那个量取的是模型**输出**的增量,而用户在
    横幅上看到的是上下文水位(`total_prompt`)。同一次会话里输出累计 3656、
    水位涨到 11966,差三倍多,于是出现「聊了 11k 还没触发」。
    两个量各自都能自圆其说,放在一起就是让人猜不到什么时候会抽。
    按轮次计数虽然粗(一轮可能是「嗯」也可能是长篇讨论)但**可预测**,
    而记忆抽取不需要精确计量:抽多了浪费一次便宜调用,抽少了下次补上
  - **「隔几轮抽」与「看几轮」是同一个数**,不拆成两个旋钮:拆开会让同一段对话
    被重复分析,同一条特征反复 `hits+1`、虚高它的稳定度 —— 而 hits 正是淘汰依据
  - **快照必须含进行中那一轮**:`finalizeTurn()` 只在 `addUserMessage()` 里调,
    于是一个轮次要等**下一条用户消息**才进 `turns`。而抽取发生在轮末,
    只取 `turns` 会让抽取器永远看不到最新一轮(最新鲜的证据),
    且第一轮结束时拿到空数组直接返回。完整性判据(有没有 assistant 响应)
    与 `finalizeTurn()` 同源
  - **模型没有维护记忆的工具,只有用户能看和清空**:依据是压缩那条实测 ——
    模型拿到概括性输入后会判定「已经足够明确」然后照着复述、不去核实。
    一条错的特征长得和对的一样权威,而它**每轮**都在注入。
    不做逐条编辑:那是把负担和「给自己定性」推给用户
  - **凭证形态过滤是代码做的,不只靠提示词**:记忆进的是每一轮的上下文,
    写进去就是永久。代价不对称 —— 错杀一条偏好下次还能再抽到,
    漏放一次就是永久泄露
  - DB 放**工作区之外**(与 `.sandbox-venv` 同一个理由):放进去模型的代码
    就能改自己的记忆。抽取失败一律降级(保持原记忆),与「压缩失败降级」同一原则
- **压缩预算跟随主模型,不写死**:
  - 输出预算解析顺序:显式配置 → 主模型 `maxTokens` → 内置兜底
  - 理由一:压缩用的就是主模型,预算理应同步,不该另设一个调参时找不到的硬编码值
  - 理由二:**推理内容计入输出预算**。给小了会让思维链吃光额度、正文为空
    (`finish_reason=length` → 重试用尽 → 占位摘要)。实测思维链可达 1500+ token
  - 生效值与来源打在 CLI 启动横幅上,任何日志级别都能看见
- **可观测靠留痕,不靠日志**:
  - Adapter 暴露 `onTrace` 钩子,记录**线格式**(转换后)的请求与原始响应;
    落盘由 `TraceRecorder` 负责,Adapter 不关心写到哪里
  - 理由:定位真实效果问题需要「发出去的原始请求 + 收到的原始响应」成对数据,
    而日志只有布尔值和计数。记内部格式会看漏 —— `content: null` 转换、
    `reasoning_content` 回填、`tool_calls` 结构都在转换那一步才成型
  - 失败调用同样留痕:定位 4xx 时请求体比错误消息有用
  - 留痕写盘失败只告警,绝不影响主流程
- **浏览器是代码里的一个库,不是独立模块层**:不做 BrowserDriver、不做浏览器工具组、
  不做意图分流。框架只提供 `execute_python` + 环境预装 Playwright,导航/读 DOM/提取
  全由模型写代码决定。
  - 理由一(核心):**筛选发生在子进程内,不在上下文里**。`browser_get_dom()` 这类工具会把
    整页 HTML(常 500KB~2MB)灌进上下文;而 `page.locator('.price').all_inner_texts()`
    让 HTML 全程留在子进程,只有蒸馏结果回流。这比「工具自限返回量」更根本 ——
    截断会让模型基于残缺数据推理,提取不会
  - 理由二:长尾场景无穷(iframe/上传/截图/拦 XHR),逐个做工具做不完;
    `page.evaluate()` 一条就覆盖了「浏览器能做的一切」
  - 代价:模型首次访问陌生页面时不知道选择器。靠 prompt 约定解决 ——
    先 `locator.aria_snapshot()`(语义树,2MB → 5~20KB)或 `locator.count()`
    渐进收窄,而不是 `print(page.content())`
  - 因此 `execute_python` 必须对 **stdout 设上限**并在超限时给收窄建议:
    这是本方案里唯一需要框架兜底的地方(同「工具结果大小由工具自己管」)
- **代码执行的边界 = 写边界,靠 Python audit hook,不用容器**:
  `needs` + SecurityGuard 那套的前提是「框架能看懂工具入参」,而这里入参是一整段
  任意代码 —— 参数检查无法约束图灵完备的输入。于是改用运行时事件拦截:
  PythonExecutor 在模型代码**之前**注入一段 `sys.addaudithook`,
  按解析后的真实路径判定写操作。审计钩子注册后无法注销(PEP 578 故意不提供 remove),
  模型删不掉它;拿到的是真实路径而非代码文本,所以拼接构造、`os.open` 底层调用、
  `shutil` 高层封装都拦得住。
  - **为什么不用容器**:产品形态是**本地 agent** —— 用户授权某个目录、
    agent 直接操作真实文件、浏览器用真实桌面。容器会砍掉已经跑通的能力
    (`headless=False` 登录引导在 WSL2 里没有桌面可显示),
    而它要防的「有决心的人类攻击者」不在本机自用的威胁模型内。
    容器仍是服务端形态的正确选择,但那是另一个产品
  - **工作区约束的是什么**(必须写准,否则「授权才有权限」这句话与实际行为不符):
    实测同一个工作区外的普通文件 —— `read_file` **拒绝**,而 `execute_python`
    里一句 `open()` **读得到**;写那一侧两条通道都拒绝。所以这一项的准确含义是
    「**不可逆操作的边界 + 工具层的授权范围**」,不是「代码能看到的世界的边界」。
    | 通道 | 工作区外的读 | 工作区外的写 | 凭证类路径 |
    |---|---|---|---|
    | fs 工具(`read_file` 等) | 拒绝 | 拒绝 | 拒绝 |
    | 沙箱代码(`execute_python`) | **允许** | 拒绝 | 拒绝 |
    这个不对称是下面那条决策的直接后果,不是漏洞;但它与直觉相反
    (「未授权也不可读才逻辑通顺」),所以在 `.env.example` 与 `config.ts`
    的 `workspace` 注释里都写明了 —— 配置项的语义不能只有读过这份文档的人知道
  - **写按白名单,读按黑名单** —— 两侧策略相反,因为约束不同:
    写/删不可逆,一次手滑就是真实损失,所以收紧到工作区 + temp。
    读的白名单做不了(实测一次 `import pandas` 触发 1183 次 `open`,
    漏放行一个目录就是 import 直接失败),但读**不能完全不管** ——
    读错普通文件没有直接损害,读到凭证不一样:值会进上下文、
    发给模型服务商、落进 traces,事后删 trace 追不回已经发出去的那一次。
    于是只列**纯负债**的路径(私钥/云凭证/token/浏览器 cookie/本框架 `.env`),
    误伤面接近零。清单见 `read-deny.ts`,与 SecurityGuard **同源** ——
    两边各算一份就会出现「工具读不到、代码读得到」这种不报错的错位
    (这正是修补前的形态:`fsDeniedPaths` 只挡住 fs 工具,代码里一句 `open()` 照读)
  - **读黑名单挡不住的两条路,都是已知的**:①`subprocess` 换个进程
    (与写边界同一个缺口,见下);②`page.goto("file:///.../id_rsa")` +
    `inner_text("body")` 三行原样取回 —— chromium 是独立进程,audit hook
    只约束 Python。所以它和写边界一样是**护栏**:治的是「模型顺手读一下配置
    好判断环境」这种现实会发生的形态,而那一下就足够把明文凭证写进对话记录
  - **写边界之所以成立,靠的是一个不对称**:chromium 不能往任意路径写文件
    (没有 `file://` 写语义,下载目录受控),所以写这一侧没有对应的绕过路径。
    于是能守住的恰好是不可逆的那一半
  - **判定必须放在闭包里**。第一版把判定函数放在模块级,模型代码写一行
    `def _inside(p): return True` 就能整个换掉判定(实测确认可绕过)——
    因为模块级函数被调用时从 globals 查名字。闭包变量走 `LOAD_DEREF`,外部无法重绑
  - 用户只配置**工作区**一项;Python 安装目录与 temp 运行时推导
    (`sys.prefix` / `tempfile.gettempdir()`),换机器换平台不用改配置
  - env **按白名单继承**、不全量透传:`process.env` 里有 `DEEPSEEK_API_KEY`,
    全量继承则模型一行 `print(os.environ[...])` 就能把它打进上下文并跟着 trace 落盘
- **⚠️ 已知缺口:写边界换个进程就绕过**(不是设计选择,是缺口):
  audit hook 的性质是「注册后删不掉,但**只管当前进程**」。所以模型不必攻击钩子,
  只要换个进程。实测对照:同一路径直接写 → 被拒;经
  `subprocess.run([sys.executable, "-c", "open(...,'w')"])` 写 → 返回码 0,文件落盘。
  `os.system` / `ctypes` 调 CreateProcess、以及机器上现成的 powershell / node / git
  都是同一个出口。
  - 因此写边界是**护栏,不是边界**:挡得住「没在攻击、只是按常规写法办事」的代码
    (实测事故正是这种 —— 模型想做 OCR,不是想越界),挡不住刻意绕的。
    真边界必须在进程之外(容器 / 独立用户 / seccomp),仍属待实现
  - **触发这次修补的事故**:模型为做 OCR 在代码里 `pip install rapidocr_onnxruntime`,
    返回码 0 静默成功,顺带升级了用户**全局环境**的 `onnxruntime`,
    用户事后翻 trace 才发现。危害不止「多几个文件」—— pip 在**安装期**执行
    `setup.py`(PEP 517 后端),而构建隔离恰好跑在放行的 TEMP 里,
    等于**远程代码执行**;配合 typosquatting(抢注 `opencv-pythonn` 一类近似名),
    而模型是凭记忆猜安装名,猜错概率比人打错字高得多
  - **三层缓解,各管一段,都不管全部**:
    ① **沙箱 venv,由框架托管**(启动时不存在则自动创建,幂等;须在工作区**之外**,
       否则模型能改 venv 自身 —— 在工作区内时框架拒绝使用并告警):
       装包落进 venv,碰不到全局环境。结构性、无绕法。治的是「污染」不是「越界」。
       带 `--system-site-packages`,否则预装库全丢而代码里又装不回来,沙箱直接瘫。
       **为什么框架管而不写进文档让用户跑一条命令**:做错的三种方式都不报错在
       正确的地方 —— 忘了建 → 每次 `execute_python` 都 spawn ENOENT
       (模型以为是自己代码错了,实测踩到);忘了 `--system-site-packages` → 沙箱瘫;
       平台写错 `Scripts/` 或 `bin/` → 同第一种。三件都可推导。
       `PYTHON_PATH` 因此只是**基础**解释器(建 venv 用它、venv 不可用时回落到它),
       不是最终执行代码的那个。创建失败不阻塞启动:回落 + 告警 ——
       没有隔离仍能干活,CLI 起不来就什么都干不了
    ② **`PIP_NO_INDEX`**:代码里 pip 不查索引,`pip install X` 返回码 1。
       它借的是 env **向子进程继承**的性质 —— 恰好覆盖 subprocess 这条路
       (实测有效),与 audit hook 在「进程边界」上正好互补。
       **是路牌不是锁**:传一份清掉该键的 env、或 `pip install <URL>` 都能绕
    ③ **`run_command`**(见下):装包的正式通道,每次人工确认
  - **`sitecustomize.py` / `.pth` 注入**(让新解释器自动装同一份写边界):
    可行且便宜,但绕法仍在(`python -S` 不加载 site、`-I` 连 PYTHONPATH 一起忽略),
    且只覆盖 Python 子进程。加了容易让人误以为进程内边界补上了,故暂不做
- **`run_command`:让危险操作变得可读,而不是把它挡住**:
  安全性**完全来自人工确认**,没有任何机制边界 —— Python 的写边界是进程内钩子,
  shell 起的进程根本不经过它。这是产品决策(同类工具 Claude Code / Codex 同形状),
  但要诚实记账:靠人守,不靠机制守。
  - **真正的收益不是「风险外移」,是「确认变得可读」**:`execute_python` 本来就在
    逐次确认,可那是一屏 40 行代码里的第 23 行 pip,人不会看清包名;
    单独一行 `pip install pillow` 才会。typosquatting 的整个攻击面就是
    一两个字符的差别,只有原样单独呈现才拦得住
  - **两条约束,少一条这工具就没意义**:①确认显示**原样命令**,不摘要
    (摘要成「安装 OCR 库」恰好把攻击藏起来);②调用量必须低 ——
    确认疲劳是真的,模型拿它去 `ls`/`cat` 会让用户点成条件反射,
    那个拼错一个字母的 pip 也会一起过。提示词里写明「日常操作写 Python,
    这个只用于调外部程序」
  - **必须同时堵住代码那条路**:给它加确认、却留着 `subprocess` 里不用等人的 pip,
    等于什么都没加 —— 模型一定走更省事的那条。所以 ② 与 `run_command` 是一对
  - **PATH 前置 venv 的 Scripts**:否则 shell 从 PATH 找到的是**全局** pip,
    装回用户机器上,venv 隔离白做。该目录由 `PYTHON_PATH` 推导、不另配 ——
    两处配置必然错位,而错位不报错,只表现成「venv 里装了、代码里 import 不到」
  - **env 白名单与 Python 执行器共用同一份**:各写一份的话,Python 那侧费劲不继承
    `DEEPSEEK_API_KEY`、一句 `echo $DEEPSEEK_API_KEY` 就把凭证隔离还回去了。
    本项目已在「逐字段拷贝」上栽过三次(`visionAnalyzer` / `pythonExecutor` /
    `models.vision`),故 `sandbox-env.ts` / `capped-buffer.ts` / `process-tree.ts`
    三处共用抽出
  - **不下放给子 agent**(按工具名排除):子 agent 的推理过程用户看不到,
    确认框会凭空冒出来 —— 用户不知道这条命令从哪来、为什么需要,只能盲点。
    装包是对整台机器的副作用,该由主 agent 拿着上下文决定
  - **禁装包并不削减模型的能力**:它本来就能跑任意代码(`execute_python` 入参
    就是任意代码)。禁掉减少的只有「污染」(已被 venv 解决)与供应链暴露
- **客户端用 Electron,不用「本地 server + 浏览器」**:壳的技术不重要,
  但「独立程序」和「浏览器里的网页」是两种东西,而后者要付的成本更高。
  - **HTML 页面不能直接 import Node 代码**,而 agent 要 spawn Python、连 CDP、
    开 SQLite —— 只有 Node 进程能做。所以壳与内核之间**必然有一层通信**,
    分歧只在它长什么样:Electron 是进程内 IPC(`contextBridge`),
    浏览器方案是 HTTP/SSE。界面代码两边完全一样
  - **端口是净负债**:localhost 端口对 Python 沙箱是可达的
    (`requests.post` 打得到确认接口),于是要额外造 token 鉴权 ——
    而 Electron 的 IPC 根本没有这个面。这是同类护栏里唯一可以直接消掉的
  - **原生目录对话框是实打实的优势**:`workspace` 必须是**绝对路径**,而网页里
    拿不到(`webkitdirectory` 只给相对路径、`showDirectoryPicker` 只给 handle)。
    只能让用户手敲,而敲错的后果是所有文件类工具静默全拒
  - **代价诚实记账**:多一份 Chromium(装完约 270MB),且与框架常驻的那个
    chromium 是两个进程、两份 profile。「只有一个浏览器」的唯一做法是把界面
    开成常驻实例的一个标签页,而那**恰好是唯一不安全的**方案 ——
    模型对那个浏览器有 CDP 控制权,能自己点掉自己的 `run_command` 确认框。
    所以「两个浏览器」不是成本,是必要条件
  - **渲染进程按不可信环境对待**:`contextIsolation: true` / `nodeIntegration: false`。
    它渲染的是模型输出、抓来的网页片段、工具返回 —— 开 nodeIntegration 等于把
    `fs` 和 `process.env`(含 `DEEPSEEK_API_KEY`)交给这些内容。
    明文 key 也不进渲染进程,界面只收掩码
  - **启动必须摘掉 `ELECTRON_RUN_AS_NODE`**:该变量存在时 electron 退化成普通
    Node 运行时,`app` / `ipcMain` / `BrowserWindow` 全为 undefined,
    实测报错是 `Cannot read properties of undefined (reading 'handle')` ——
    完全指不到真正的原因。IDE 与各类工具会设它且会继承,所以在启动路径上删,
    不靠文档提醒
- **会话历史与压缩归档是两份存储,不合并**:
  - **`archive/` 不是历史**:它只有被压缩挤出上下文的轮次。实测 8 个客户端
    会话的 archive 全为空 —— 窗口 1M、阈值 0.7,压缩从没触发过,于是所有轮次
    只活在内存里、关掉客户端就没了。缺的是「轮次完成即落盘」
  - **两条路分开**是整个设计的关键:前端显示读 `turns.jsonl`(完整原始对话,
    append-only,永不压缩),模型请求走 ContextManager 那套(一个字不改)。
    分开之后**不需要序列化 ContextManager 的内部状态** —— 主题摘要、
    轮次到主题的映射、归档索引、token 计数共 10 个私有字段,逐个灌回
    漏一个就是静默错误(漏了 `archivedTurnIds`,压缩提示会列出模型读不到的文件名)。
    而它们本来是**可再生的**:恢复后水位到了自然重新压一次
  - 因此 `restoreTurns()` 刻意**只恢复原始轮次**,也**不预估 token** ——
    压缩触发靠 `recordTokenUsage()` 拿 API 返回的真实值,在这里估一个数
    只会多一处与真实值不符的来源
  - **不能复用 archive/ 的写入路径**:它现在做的是「归档 + 写 index.json +
    标记 topic_id」,而那份索引是给**模型回溯**用的(压缩后提示它 `read_file`
    读 index.json 找早期对话)。每轮都写会让索引里塞满没被压缩的轮次,
    而模型看到索引却发现那些内容还在上下文里 —— 索引的语义就坏了
  - 代价(已确认接受):压缩发生后同一轮在两处都有。保留冗余是因为读者不同
    (模型 vs 前端),且 archive 那侧的文件带 `topic_id` 这类压缩元信息
  - **格式选 JSONL**:追加是一次 `appendFileSync`,不必读出整个数组改完写回;
    崩溃只损坏最后一行,前面的历史仍可读(单个 JSON 数组会整份失效)
  - **列表靠扫目录,不维护索引文件**:索引要在会话开始、每轮结束时更新,
    而它与真实目录不一致时(手动删了某个目录、或写索引那次崩了)
    列表里会出现打不开的条目。扫目录是自愈的
  - **落盘挂在 `session.run()` 之后、用 `peekTurns()`**,不等 `finalizeTurn()`:
    后者只在 `addUserMessage()` 里调,一轮要等下一条用户消息才入库 ——
    照那样挂钩子,**每个会话的最后一轮永远不落盘**(与 peekTurns 那个 bug 同形)
- **⚠️ 连带修掉一个既有 bug:`turn_id` 撞号**。原先由 `this.turns.length + 1`
  派生,而压缩执行 `this.turns = recentTurns` 把数组截短 —— 15 轮压到保留 10 轮后
  下一轮算出 11,与已存在的第 11 轮撞。后果全是静默的:`activeTurnTopics`
  映射错乱、归档文件 `turn-011.json` 被覆盖、历史落盘按 turn_id 判断进度
  于是压缩之后的每一轮都不再写入。改为独立的单调计数器,与 turns 的增删解耦;
  续接会话时抬到历史最大 id(取 max 而非 length —— 文件里可能有坏行被跳过)
- **Markdown 渲染自己写,不用 marked + DOMPurify**:
  - **安全靠结构而不靠消毒**。库的做法是「markdown → HTML 字符串 → innerHTML」,
    于是必须再挂一个消毒器,漏配一个选项就是 XSS。而渲染的是模型输出与它从
    网页抓回来的片段,全是不可信文本。自写的版本全程 `createElement` +
    `textContent` —— 没有 HTML 解析,就没有 HTML 注入
  - 刻意不支持:原始 HTML 块(正是要避免的);图片 `![]()` ——
    会让模型输出触发外部请求(等于信标),渲染成链接;多级嵌套列表(用得少、要一套栈)
  - 链接按协议白名单(`http`/`https`/`mailto`),其余原样显示成文本
  - **流式期间不渲染**:每来一个字符重渲染是 O(n²) 的 DOM 重建,而且半截的
    ``` 或 `|` 会让结构反复跳变。做法是流式追加纯文本、`done` 时一次性渲染。
    `reset`(重试)必须同时清掉缓冲,否则重试后的正文会拼在上一次那半截后面
  - 历史渲染走同一套:否则同一段回答「当时排版好、重开会话变纯文本」,
    用户会以为历史存坏了
- **客户端配置存 JSON,不写回 `.env`**:
  - **改了不生效**:`config.ts` 的 `defaultConfig` 是**模块级常量** ——
    所有 `process.env.XXX` 在该模块首次 import 时求值一次,之后永不再读。
    写回 `.env` 文件确实改了,但进程内什么都没变,用户点了保存看不到任何变化。
    `config.test.ts` 必须 `vi.resetModules()` 才能验证不同环境变量,记的是同一件事
  - **`.env` 在项目根目录,而它自己在读黑名单里**:配置面板会让 key 的生命周期
    变长、被打开的次数变多,继续放那儿只是把同一个问题做大。改存用户配置目录
    (`%APPDATA%/BaseAgent/config.json`),在项目外、工作区外 ——
    与 `.agent-memory.db` / `.sandbox-venv` 同一个理由
  - **`.env` 保留为回落**:JSON 里没有的项才读环境变量,现有 CLI 一个字不用改
  - **由壳读出来当 `configOverrides` 传进去**,不让 session 自己读文件:
    后者会让所有测试都读到运行机器上的 `config.json`,于是同一份测试在一台机器上
    过、另一台挂,而挂的原因不在代码里
  - **写入是增量合并**:界面上 apiKey 留空表示「不修改」,整份覆盖会把已存的 key
    抹掉 —— 而用户看到的是「未设置 DEEPSEEK_API_KEY」,不会想到是自己点保存造成的。
    先写临时文件再 rename:中途崩掉会留下半个 JSON,那时 key 就丢了
  - **不假装热更新**:改完重建会话。`workspace` 一项派生出 fs 白名单、Python cwd、
    写边界三样东西,venv 要重新校验,常驻浏览器要重开 ——
    热更新只会得到「界面显示新值、实际跑的是旧边界」的会话
  - **只放用户真正需要决定的项**:压缩阈值、clip 上限、重试退避仍只走 `.env` ——
    它们要理解内部机制才填得对,进界面等于把「能填错的东西」变多
  - **实际生效值与勾选值可能不同,必须说出来**:`shellEnabled` 是
    `shell.enabled && workspace && allowDangerousTools` 三者的合成,而界面上是
    三个独立开关。不提示的话用户只会觉得开关坏了
- **评估后明确不做(不是欠的债)**:
  - **网络管控** —— 实测无效。Playwright 全流程里 `socket.connect` 只出现 2 次、
    都是 `127.0.0.1`(Python 连本地 driver);真正访问网站的是 node driver 与
    chromium **独立进程**,audit hook 只约束 Python 进程,一个字节都看不到
  - **subprocess / ctypes 的调用栈分析** —— 实测 `subprocess.Popen` 的 `executable`
    参数是 `None`、命令行是一整个带空格的字符串无法可靠切分;而 `ctypes.dlopen`
    有正常用途(标准库查时区会 dlopen `kernel32`/`tzres.dll`)。
    要区分「谁触发的」需要栈分析,复杂且脆弱。
    **注意这条只说明「拦 subprocess 很难」,不改变上面那个缺口的存在**
  - **读路径白名单 / 分级策略 / 中途授权确认** —— 白名单见上(误伤 import);
    中途授权确认还需 CodeAct 工具桥,且结构上不可能(代码块是原子的)
  - **读黑名单的 `realpath`** —— 读侧只做 `abspath` 前缀匹配,不解析符号链接,
    于是「工作区内建软链接指到 `~/.ssh` 再读那个链接」绕得过。
    不补是权衡:`realpath` 要按路径分量做 syscall,而读事件一次 import 上千次;
    更关键的是 `subprocess` 那条绕法**更省事**,补了也不会让谁绕不过去。
    fs 工具那一侧(SecurityGuard)是做 `realpath` 的,严格于此
  - **代码里的中途确认** —— 结构上不可能:代码块是原子的,一段代码跑完才返回,
    中间没有「跟用户说句话然后等他」的位置(这也是 `request_help` 不上工具桥的原因)。
    所以装包只能在**钝的**两端选:要么禁、要么放行,没有「装之前问一下」这个中间态 ——
    `run_command` 是把那次询问挪到了代码**之外**
  - **剩余风险**(产品决策,非技术限制):黑名单之外的文件模型仍读得到,
    且黑名单内的文件经 `subprocess` 或浏览器仍取得到,内容可被发出去。
    自用 + 用户信任该 agent 的前提下接受 —— 同类工具(Codex / Claude Code)
    同样是全权限跑在用户机器上。黑名单收的只是**纯负债**的那部分(凭证),
    因为那类内容一旦进上下文就已经发给模型服务商了
- **登录态靠 chromium 的 user-data-dir 持久化,不靠框架解析**:
  - 用 `launch_persistent_context(dir)` 而非 `storage_state`:后者只搬 cookie +
    localStorage(用 IndexedDB 存 token 的站点会漏)且要显式存盘;前者是整个 profile、
    关闭时自动落盘,少一个「模型忘了存」的失败点
  - 框架**不生成也不解析** profile 内容,只提供目录路径(经环境变量
    `BROWSER_PROFILE_DIR` 注入子进程)。目录内容由 chromium 自己读写(SQLite/LevelDB),
    因此不存在「按站点适配注入格式」的问题 —— cookie 对浏览器就是不透明键值对
  - 密码不进上下文:登录由用户在 `headless=False` 窗口里手动完成、代码用
    `wait_for_url` 等待。让模型 `fill('#password', ...)` 会把明文密码写进 trace 和压缩摘要
  - 故障只在**行为层**判定与修复:查页面上有没有登录按钮 → 失效就删目录重走引导。
    profile 是缓存不是权威源,不需要理解它为什么坏
  - profile 目录必须进 SecurityGuard deny 列表:里面的 cookie 等价于活凭证,
    一个 `read_file` 就能读进上下文并跟着 trace 落盘。这是软边界(沙箱进程本身必须能读写),
    配合 prompt 约定 + stdout 上限兜底
- **浏览器由框架常驻(CDP),不由模型代码启动**:每轮 `with sync_playwright()` 块结束
  就关掉 chromium,于是「上一轮打开的页面下一轮接着点」做不到 ——
  `launch_persistent_context` 只保住登录态,保不住页面停留位置。
  改成框架启动一个带 `--remote-debugging-port` 的实例,模型代码用
  `connect_over_cdp` 连上去、不关闭。
  - 顺带消掉一个软边界:模型再没机会自己造 profile 路径(之前靠 prompt 约定,不可靠)
  - **关闭必须按 PID 强杀,不能只发 CDP 命令**:实测 `/json/close/<id>` 只关标签页,
    浏览器进程照旧活着。而进程活着时 profile 目录**完全删不掉**(几百个文件 EBUSY)——
    所以孤儿不是「多占内存」,而是**下次必然启动失败**
  - chromium 会 fork 多个进程,`spawn` 返回的 pid 未必持有端口。
    关闭时按监听端口反查 PID,杀错就等于没杀
  - 端口不写死 9222:用户自己开着 Chrome 调试就会占用它
  - Ctrl+C / 崩溃时 `finally` 可能来不及跑,所以把 pid+port 落进 lock 文件,
    **启动前主动清理**残留。按端口反查而非直接用记录的 pid —— pid 可能已被系统复用
  - **浏览器归进程,不归会话**(客户端有多会话之后才暴露出来):
    它原先由 `AgentSession` 创建与销毁,而切换历史会话是整个 session 拆了重建 ——
    于是每次切换都重启 chromium:窗口跳一下、几秒等待,**而且页面停留位置丢了**。
    最后那条是关键 —— 保住停留位置正是常驻浏览器存在的理由
    (登录态靠 profile 能留住,停在哪一页留不住),会话级所有权把它自己抵消了。
    - `CreateSessionOptions.browserManager` 传了就复用,并由 `ownsBrowser`
      标记决定 `dispose()` 时关不关。**谁创建谁关闭** —— 在会话里关掉共享实例,
      后续会话会拿到一个死的 CDP 地址(而那不报错,只表现成模型代码连不上浏览器)
    - `createSharedBrowser()` 由 core 导出给壳用,不让壳自己 new:
      profile 路径的解析规则只能有一份。壳自己拼一次必然错位,而错位不报错 ——
      只表现成「读黑名单挡不住 cookie」或「模型连不上浏览器」。
      本项目已在「同一份事实写两处」上栽过四次
    - 浏览器必须在建会话**之前**就位:装配时要拿它的 CDP 地址注入子进程环境变量
      (`BROWSER_CDP_URL`),晚了模型代码连不上
    - 连带改法:客户端 `before-quit` 的判断从 `!session` 变成
      `!session && !sharedBrowser`。只判会话的话,会话为 null 时直接 return、
      把 detached 的 chromium 漏掉 —— 而漏掉的代价是下次启动必然失败。
      两者分别 try:会话收尾失败不能让浏览器漏关(后者才是不可恢复的那个)
- **CodeAct 之后,工具层只留代码碰不到的那几件事**:动作空间变成代码后,
  绝大多数工具应当消失 —— 每保留一个都要在**每次调用**的 prompt 里付 schema 成本,
  而且「工具和等价代码两条路」会让模型的选择变得不可预测。
  留在外面的判据只有三条:
  - **① 需要框架持有的凭证 / 产出物必须由框架投递**:视觉模型的 API key
    不在沙箱 env 白名单里(与 `DEEPSEEK_API_KEY` 同理),所以代码自己调不了视觉 API。
    而观察文字也**不返回给代码** —— 实测模型裸调 `view_image(...)` 三次都没 print,
    它依赖框架投递;真交给代码,花过钱的观察会静默消失。
    `screenshot` / `view_image` 属于此类
    - 注:视觉改成插件之前,这一条的理由是「图片进上下文只有 attachments 一条路」。
      现在返回的是文字,代码理论上能 print —— 但**模型不会**,所以判据从
      「通道限制」换成了「凭证边界 + 投递责任」,结论不变
  - **② 需要跨出执行单元**:代码块是原子的,中间没有「跟用户说句话然后等他」的位置。
    `request_help` 要暂停等人操作(可能一分钟以上),模型自己写 `wait_for_url`
    会死等、agent 卡住且用户看不到提示。`spawn_subagent` 同理(独立上下文与生命周期)
  - **③ 工具确实比等价代码更好**:`read_file` / `search_files` 自带返回量上限,
    超限返回 `ok:false` + 收窄建议;而裸 `glob('**/*')` 命中三千个文件、
    一 `print` 就撑爆上下文。「数据大不大」是领域知识,封在工具里才有效
  - 按此筛选,现有 11 个工具会缩到 6 个:`screenshot` / `view_image` /
    `request_help` / `spawn_subagent` / `read_file` / `search_files`。
    `get_current_time`(`datetime.now()` 一行)、`write_file`(写边界已在 audit hook
    管住,工具层重复)、`list_files`(与 search 重合)、`echo` 一律进代码;
    `execute_python` 本身消失 —— 它变成动作空间
  - **但「留作工具」和「经桥暴露」是两个问题**。落地时桥只暴露 2 个,不是 6 个 ——
    每暴露一个都要在**每次执行**注入一个函数定义,而判据①②③里只有①
    真的落在「代码碰不到」上:
    - `screenshot` / `view_image` —— **暴露**。视觉模型的 key 不在沙箱 env
      白名单里(代码调不了视觉 API),且观察由框架投递而非返回给代码
    - `read_file` / `search_files` —— **不暴露**。Python 有 `open()` / `glob`,
      经桥去读只是慢一圈。判据③(返回量上限是领域知识)在代码里已由
      `execute_python` 的 **stdout 上限**兜住 —— 框架已经在这条边界上了,
      不需要再在桥上重复一遍。它们留作工具的理由是「不开 Python 进程也能读一个文件」
    - `request_help` —— **不暴露**。它存在的理由恰恰是「代码块是原子的」(判据②),
      可正因为原子,在代码里调它也不会真暂停:脚本继续跑到底,请求只在返回后
      才到用户面前。那与直接当工具调没有区别,还会让模型误以为代码能停下来等人
    - `spawn_subagent` —— **不暴露**。在代码块里套一整个 orchestrator,
      受外层脚本超时约束,收益不明而失败模式很难查
  - 一律**不做「暴露全部让模型挑」**:那看似保留退路,实际是把取舍推给模型,
    代价是冗余 + 行为不可预测
  - 待验:③ 的前提是「模型在代码里不会自己控制返回量」。
    实测有正面信号(它在抓官网时主动写了 `lines[:60]`),仍需实跑验证
- **CodeAct 不做「模型不发 JSON 而发一段代码」**:那需要从自由文本里正则提取
  代码块,与「不正则解析模型自由文本」那条决策直接冲突(格式漂移即静默丢数据)。
  CodeAct 的价值在「工具能不能在代码里被调用」,不在「JSON 还是代码」——
  `execute_python` 的 `code` 参数就是动作空间,`tool_calls` 通道照旧用。
  - 落地后的实测支持这个取舍:模型在代码里连续三轮调 `view_image(...)`、
    一次调两张,循环与条件真的下沉到了代码里,而协议层没有任何改动
- **工具桥走 localhost HTTP,不复用 stdin/stdout**:桥是 CodeAct 的最后一块 ——
  有了它,代码里才能调那些代码本身做不到的事,循环与条件真正下沉到代码。
  - **为什么不复用 stdout**:stdout 已经被执行结果占用(还有体积上限),
    在同一条流上复用请求/响应需要分帧协议,而且会和库打的警告混在一起 ——
    实测 Playwright 就会往 stdout 写东西。HTTP 是独立信道,
    与浏览器走 localhost CDP 的做法一致
  - **只绑 `127.0.0.1` + 每次启动换 token**:没有 token 的话,本机任何进程都能
    驱动这个 agent 的工具。注意 token 经环境变量下发、模型代码读得到,
    所以它**不是**对模型的边界 —— 对模型的边界是白名单本身
  - **`invoke` 转给 ToolRunner**:经桥的调用与模型直接调工具走同一条路径,
    权限检查、确认、日志不会因为「从代码里调」而被绕过
  - **图片按 run 分桶,不共用一个数组**:代码调 `screenshot()` 时,框架会**嵌套**
    再起一个 Python 进程(BrowserOps)去驱动浏览器,它也有自己的 run id。
    共用一个桶时,内层结束会把外层攒的图片一并取走。
    嵌套**不会死锁**(已实测):模型代码正持有 `connect_over_cdp` 连接时调
    `screenshot()`,整段 1.2s 完成、内层结束后外层连接照旧可用 ——
    chromium 的调试端口本身支持多客户端接入
    框架自己写的脚本因此传 `bridge:false` —— 桥里的 `screenshot()` 正是靠它实现的,
    注进去会形成递归入口
  - **单次执行的图片数设上限**:模型在循环里截图是很自然的写法,50 次迭代
    就是 50 张图进上下文。超限时拒收图片但**照常返回工具结果** ——
    让模型知道「动作成功了,只是图没收」,而不是以为整个调用失败(同 stdout 上限的思路)
  - **Python 函数签名从工具的 JSON Schema 推导,不手写**:手写的那份迟早与 Zod
    定义漂移,而漂移的表现是「模型照描述调用却报 TypeError」,很难查。
    `execute_python` 的 description 用的也是同一份签名
  - 与 write-guard 不同,桥的 prelude **不需要闭包防篡改**:那边的闭包是安全边界
    (覆盖判定函数就能越权写文件),这里的函数只是便利封装 —— 模型把 `screenshot`
    覆盖掉,损失的是它自己的能力,不构成越权。真正的边界在服务端的白名单
  - 桥的 prelude 排在写边界**之后**注入:它没有理由成为写边界的例外
- **视觉是插件,不是主模型的输入通道**:配了 `VISION_MODEL` 才有看图能力。
  数据流是「**图进视觉模型、文字回主模型**」—— 主模型全程不接触像素,
  因此**它是不是多模态与框架无关**。这正是把主模型换成强文本模型(v4-pro)
  时需要的形状,换模型不必动视觉这一侧。
  - **`VISION_ENABLED` 删掉,换成「配了没有」**:前者是「我保证主模型能看图」的
    断言,框架无法验证,填错的后果是运行时 400;后者是可验证的事实。
    未配时**不注册看图工具** —— 暴露一个必然返回 `ok:false` 的函数只会让模型白花一步
  - **不留 inline(图直接进主上下文)那条路**:它唯一的优势是主模型看原始像素,
    而那以主模型多模态为前提 —— 与换 v4-pro 的方向相反。
    留两条路的真实代价是**语义分散在三处**(系统提示 + 两个工具的 description),
    2×2 组合必然漂移,而漂移的表现是「模型照描述调用却拿到另一种返回」
  - **`question` 是必要参数而非装饰**:视觉模型必须被告知找什么。
    「验证码是什么」和「这页面为什么看起来是坏的」需要的描述完全不同,
    不问只能拿到泛泛描述,很可能恰好漏掉主模型真正要的东西。追问 = 再调一次
  - **观察走 `ToolResult.observations`,不塞进 `data`**:经工具桥调用时 `data` 会
    返回给 Python 代码,而**模型不会 print 它**(实测裸调 `view_image(...)` 三次
    都没 print,它依赖框架投递)。放 `data` 就等于让花过钱的观察静默消失。
    所以文字与图片同一套语义:**由框架投递,代码拿不到本体**
  - **系统提示只写语义、不写函数签名**:签名由桥从工具 schema 生成,
    写在 `execute_python` 的 description 里。手写一份必然漂移(之前就漏了 `detail`),
    加 `question` 时会立刻踩上 —— 模型照提示调用就不会传它
  - **视觉模型的观察是二手信息**,所以结果里标注 `observed_by` ——
    出错时能判断该怀疑视觉模型还是主模型的推理。空观察一律判 `ok:false`:
    视觉调用花过钱,返回一句空话比报错危险得多
  - 代价(已确认接受):主模型看不见它没问的东西,追问要重发一次图;
    每张图多一次 LLM 调用(延迟 + 成本)。
    收益:**主上下文里再也没有图片** —— 下面那些累积成本整块消失
- **图片相关的实测结论**(inline 时期测得,现按是否仍生效标注):
  - **仍生效**:格式按**内容**(magic bytes)判而非扩展名 —— 服务端也按内容判,
    改名的 bmp 会 400;超配额返回 `ok:false` + 可照抄的 PIL 缩放代码,不引入图像库。
    这些检查都发生在**调视觉模型之前**,拦住就不该花那次钱
  - **仍生效**:trace 落盘前把 data URL 负载换成 `<stripped 1.2MB>`,
    否则单个 `call-NNN.json` 几 MB,trace 是为了「能翻」,翻不动就失去意义
  - **仍生效**:每张图 ≤384 token(服务端先缩放,2000×2000 与 5000×5000 消耗相同),
    所以 token **不能按 base64 字符数算** —— 1MB 图的 base64 有 130 万字符。
    `detail:'low'` 现在省的是视觉模型那边的 token
  - **已不适用于主上下文**:「含图前缀可被 KV cache 命中、每轮增量 200~240 token
    且与图片体积无关」「图片走 user 消息而非 tool 响应(tool 通道 9% 静默失败)」——
    主上下文里已经没有图片了。这两条恰恰是选 delegate 的依据之一:
    累积成本与静默失败风险一并消失。它们仍适用于视觉插件**发出**的那一侧请求

---

## 实现状态

### ✅ 已完成

**Platform 层**:
- Logger / Config / Storage / SecurityGuard / Errors
- RetryHandler (幂等操作的统一重试)
- TraceRecorder (LLM 调用留痕,本地可观测)
- config-store (客户端配置持久化:用户配置目录下的 JSON,`.env` 作回落。
  增量合并、原子写、不假装热更新。详见「客户端配置存 JSON」那条决策)

**Executors 层**:
- FsDriver (文件系统,集成 SecurityGuard 白名单 + 凭证目录黑名单)
- PythonExecutor (子进程执行代码:超时 / stdout 上限 / env 白名单继承 / 进程树回收 /
  `PIP_NO_INDEX` 禁止代码里装包)
- WriteGuard (audit hook:写按白名单(工作区 + temp),读按黑名单(凭证类路径);
  判定在闭包内,模型无法覆盖。**已知缺口:换个进程即绕过** ——
  详见「代码执行的边界」与「已知缺口」两条决策)
- read-deny (读黑名单清单:私钥/云凭证/token/浏览器 cookie/本框架 `.env`。
  一份清单两处用 —— SecurityGuard 与 audit hook,不同源会造成不报错的错位)
- ShellExecutor (外部程序通道:PATH 前置 venv / 超时杀进程树 / 输出上限。
  **没有任何机制边界**,安全性来自 `run_command` 的人工确认)
- venv (沙箱 venv 的自动准备:启动时不存在则创建,幂等;校验不在工作区内;
  失败回落到基础解释器 + 告警。解释器子路径按平台推导,不进配置。
  详见「三层缓解 ①」)
- sandbox-env / capped-buffer / process-tree (两个执行器**共用**:env 白名单、
  输出截断与 CRLF 归一、进程树回收。抽出来是因为逐字段拷贝已栽过三次)
- BrowserManager (常驻 chromium:CDP 端口 / 随机端口 / lock 文件清理残留 /
  按端口反查 PID 强杀。详见「浏览器常驻」那条决策)
- BrowserOps (截图的具体实现。逻辑放执行器层而非 Tool 内 ——
  工具桥的 `screenshot()` 复用的就是同一份)
- ToolBridge (CodeAct 工具桥:localhost HTTP + 每次换 token,
  只暴露 `screenshot` / `view_image`。图片与观察都按 run 分桶、
  由框架投递而非返回给代码。详见「工具桥」那条决策)

**Tools 层**:
- Contract / Registry / Runner (调用管线)。Registry 支持 `hide()`:
  工具留在表里但不进模型清单 —— 工具桥的 invoke 要经 runner 按名字查找
- **动作空间已收敛**(`CONVERGE_TOOLS=true`,仅 `PYTHON_ENABLED` 时生效)。
  清单从 11 个降到 6 个(开 `SHELL_ENABLED` 则 7 个),其中 2 个只在代码里可调:
  - 工具位:`execute_python`(动作空间本身) / `read_file` / `search_files` /
    `request_help` / `spawn_subagent`,以及可选的 `run_command`
    (需 `SHELL_ENABLED=true` **且** `ALLOW_DANGEROUS_TOOLS=true` ——
    它是 danger 工具,只开前者会让模型调用后被 runner 直接拒、白花一步)
  - **仅代码可调**(无开关):`screenshot` / `view_image`。隐藏是无条件的 ——
    实测两条路都开时模型一律直接发 tool_call,代码那条路走不到。
    但**必须在 `toolBridge.start()` 成功之后才隐藏**:桥起不来又隐藏了工具,
    模型就两条路都没有(清单里没有、代码里的函数也连不上)
  - 已下沉进代码:`get_current_time`(`datetime.now()`)、`write_file`
    (`open(...,'w')`,写边界已由 audit hook 管住)、`list_files`(`glob`)、`echo`
  - 收敛时**必须同步改系统提示**:模型不会因为工具消失就自动改用代码,
    它会照旧发 `write_file` 然后撞「工具未注册」白花一步
- 看图工具需配 `VISION_MODEL`(视觉插件)。未配则**不注册** ——
  暴露一个必然失败的函数只会让模型白花一步。详见「视觉是插件」那条决策

**Core 层**:
- AgentSession (一次会话的全部接线:21 段装配集中一处,两个壳共用。
  装配期零输出、`onConfirm` 必须由壳提供、`dispose()` 必须调。
  详见「AgentSession」那节)
- LLMClient (接口) + DeepSeekAdapter (实现,含 trace 钩子与**流式分支** ——
  SSE 由 SDK 解析成 `AsyncIterable`,累积成与非流式同构的响应;
  非流式路径未改动。详见「AgentEvent」那节)
- TokenCounter (Token 统计和阈值判断)
- ContextManager (Turn 管理 + 主题聚类压缩 + 结构化输出)
- Orchestrator (ReAct 主循环)
- LocalSubAgentRunner (一次性子 agent:独立上下文,无递归,只回传结论)
- LocalVisionAnalyzer (视觉插件:单发调用,图进视觉模型、只回文字观察。
  实现放 core 是因为它要用 LLMClient,接口声明在 tools/contract.ts ——
  与 SubAgentRunner 同一套注入模式。详见「视觉是插件」那条决策)
- system-prompt (提示词组装:环境约定由 `buildEnvironmentPrompt` 产出,
  主 agent 与子 agent **共用同一份**,角色说明各自保留。
  详见「子 agent 的提示词必须与主 agent 环境同源」那条决策)
- session-store (会话历史:append-only 的 `turns.jsonl`、恢复、扫目录列会话。
  与压缩归档是**两份存储** —— 前端显示原始对话、模型请求走压缩那套。
  详见「会话历史与压缩归档是两件事」那条决策)
- memory (长期记忆的纯逻辑:6 个维度、合并、按 hits 淘汰、凭证形态过滤、
  渲染。不依赖 LLM,可独立测试)
- MemoryManager (抽取驱动:何时抽、给它看哪一段、结果怎么落盘。
  详见「长期记忆与压缩是两件事」那条决策)

**Interface 层**(两个壳共用 `core/session.ts` 一份装配):
- CLI (REPL / 单发两种模式,斜杠命令 + 每轮可观测回显 —— **调试壳**,
  turn/token/压缩次数/trace 路径都在这里看)
- Electron 客户端 (`electron/` + `src/interface/app/`):原生无边框窗口
  (自绘顶栏 + 窗口按钮)、流式正文与可折叠思考过程、工具调用标签、
  历史会话侧边栏(切换/新建)、Markdown 渲染、原生目录选择、配置面板、
  危险工具确认(命令原样呈现)。**不显示** turn/token 这类调试信息。
  agent 直接跑在主进程,无端口无 HTTP;渲染进程按不可信环境对待。
  详见「客户端用 Electron」「Markdown 渲染自己写」两条决策
- `scripts/import-history.ts` (一次性脚本:把旧会话的对话从
  `calls/*.json` 的 wire_request 反推成 `turns.jsonl`。默认预演不写盘 ——
  切分靠位置约定,判错会往每个目录塞一份错的历史且不报错)

### ⏳ 待实现

**Executors 层**:
- HttpClient

**Core 层**:
- Planner 模块(多步任务拆解)

**Interface 层**:
- Voice (语音接口 - 预留)
- 客户端打包成 exe:主进程现在用 tsx 直接吃 `.ts` 源码(开发期正确 ——
  避免 dist 与 src 不同步这种不报错的错位),打包时要改成加载编译产物

**高级特性**:
- 容器隔离 —— **仅在做服务端形态时才需要**。本地形态下已用 audit hook 写边界
  替代(见「代码执行的边界」),不作为本地路线的待办
- 子 Agent 的 stateful 模式(保留上下文可续传)+ LRU 驻留池

---

## 技术选型

| 模块 | 技术 |
|------|------|
| 语言 | TypeScript (ES modules) |
| LLM | DeepSeek V4 (1M context) |
| 浏览器自动化 | Playwright(装在 Python 环境内,非 TS 侧依赖) |
| 代码执行 | Python 子进程 + audit hook(写按白名单,读按凭证黑名单,详见设计决策) |
| 持久化 | SQLite |
| 参数校验 | Zod |
| 测试 | Vitest 单元测试(`src/**/*.test.ts`)+ 手写集成测试 |
| 日志 | 自研 ConsoleLogger |

---

## 下一步

**已实跑验证 ①**(18 轮 trace,知乎热搜看图任务):

- **工具桥可用,且「两条路都开时模型不走代码」**:工具清单里有 `screenshot` /
  `view_image` 时,模型一律直接发 tool_call;把它们从清单隐藏后,
  它立刻改成在代码里调 `view_image(...)`,连续三轮、一次调两张。
  图片确实注入进上下文(累计 1→2→4 个图片块 —— 那是 inline 时期,
  现在观察是文字,不再有图片块)。
  这条实测是「隐藏改成无条件、不留开关」的依据 ——
  留着工具那条路等于桥形同不存在
- **模型用相对路径调桥**:它把图存到 `zhihu_imgs/` 再传相对路径。
  这正是路径基准那个 bug 的实战场景 —— 不修的话这一步必然被拒
- **遵守浏览器约定**:11 次 `connect_over_cdp`,0 次 `close()`,0 次自己 `launch`
- **模型会自己控制打印量**:10 轮代码里 8 轮带 `count()` 或切片 `[:N]`,
  全程没出现 `print(page.content())`。这是判据③的正面信号,但样本仍小,
  所以 `read_file` / `search_files` 继续留作工具兜底
- **一处模型侧失误**:曾把工具名发成 `execute_pinyin`,框架回
  「工具未注册」后自行纠正。错误回流机制有效,代价是白花一步 ——
  框架侧无法预防,记录备查

**已实跑验证 ②**(收敛后,9 轮 trace,改一份埋了 3 个 bug 的贪吃蛇):

- **收敛生效,没有撞不存在的工具**:全程只用了 `search_files` / `read_file` /
  `execute_python`,一次都没去调已下沉的 `write_file` —— 写文件是在代码里
  `open(path,"w")` 做的。系统提示那条改动是必要且足够的
- **模型自发做出了「编辑工具」该有的纪律**,而框架并没有提供编辑工具:
  - 改之前 `shutil.copy2` 备份(这就是多出来的 `.bak` 文件)
  - 每次 `replace()` 前先 `assert src.count(old) == 1` —— 锚点唯一性检查,
    与 Edit 类工具强制的那条约束一致,它自己想到的
  - 三处一次性改完,不是逐个试错
- **诊断先于修改**:先跑一遍看失败,再把逻辑单独复现一遍把 3 个 bug 全部定位,
  然后才动文件。没有「见到第一条断言失败就改那一处」
- **改完独立复验**:重跑文件之后,又用 `importlib` 重新加载模块、
  自己写断言复测三条行为 —— 没有只信文件自带的 self_check
- 这条支持「不做编辑工具」的取舍:结构化编辑在代码里是 `replace` 加一句断言,
  模型有能力自己写对

**已实跑验证 ③**(11 轮 trace,未登录状态下问知乎热搜 —— 补掉了前两条待验证):

- **`request_help` 照约定本轮结束**:调用后直接给回答并停
  (`toolCalls: []` / `finishReason: stop`),没有继续轮询等待,
  且明确说了「请切换到浏览器窗口」。起作用的是**工具结果里那段 note** ——
  指令出现在**当场**比只写在几千 token 之前的系统提示里可靠,
  `page.accessibility` 那次的失败模式没有重演
- **模型能自己定位登录入口**:一步 `goto("/signin")`,没有再把 url
  传成站点首页
- **未登录时的降级是诚实的**:官方 API 401 → 确认是登录墙 → 改走第三方镜像,
  并在回答里**主动说明**数据来源与可能的延迟,没有把降级藏起来
- **读黑名单没有误伤**:11 步 0 次 `PermissionError`。模型判断登录状态用的是
  API 状态码和页面语义树,从没试图读 profile 目录或 cookie ——
  这正是黑名单「误伤面接近零」的原因:凭证文件不在完成任务的自然路径上

**仍待验证**:

- **长期记忆的实际抽取质量**:6 个维度能不能抽出真东西而不是泛泛之谈,
  以及「宁可空手而归」这条提示词约束是否真的抑制了编造。
  代价不对称 —— 编出来的特征会永久注入每一轮

**然后**:

1. Planner 模块(多步任务拆解)—— 刻意排在最后:
   ReAct 单循环目前还没跑出「明显不够」的证据,提前做属过度设计
