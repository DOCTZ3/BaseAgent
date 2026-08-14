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
│    · cli          先做:命令行输入输出                      │
│    · voice        预留:ASR 语音转文字 / TTS 播报            │
│    · gui          预留:Electron/Tauri 桌面窗口             │
│    职责:只做 输入→文本 / 结构化结果→展示,零业务逻辑        │
└───────────────────────────┬──────────────────────────────┘
                            │ AgentInput / AgentEvent
┌───────────────────────────┴──────────────────────────────┐
│  core/  Agent 内核(大脑)                                  │
│    · orchestrator  主循环:调 LLM → 拿决策 → 派发 → 观察    │
│    · planner       复杂任务的多步拆解(可选增强)           │
│    · llm-client    封装 Claude tool-use 调用               │
│    · context       单次会话的上下文/消息栈                 │
│    · memory        长期记忆:用户偏好/历史(接 storage)     │
│    职责:理解意图、决定调哪个工具、串联多步、错误恢复        │
│    关键:只知道「有一批工具可用」,不知道任何工具的实现       │
└───────────────────────────┬──────────────────────────────┘
                            │ ToolCall(name,args) / ToolResult
┌───────────────────────────┴──────────────────────────────┐
│  tools/  工具层(核心扩展层)                               │
│    · contract      Tool 统一契约(interface 定义) ✅ 已实现│
│    · registry      注册表:名册 + 名字→工具 映射 ✅ 已实现  │
│    · runner        调用管线:校验/权限/日志/重试 ✅ 已实现  │
│    · builtin/      内置组:时间、计算、记事、查询 ✅ 已实现 │
│    · browser/      浏览器组(重点扩展):导航/点击/填表/抓取(预留)│
│    · system/       系统组:文件操作(读/写/列表/搜索) ✅ 已实现│
│    职责:登记工具、统一执行入口、承载通用横切能力            │
└───────────────────────────┬──────────────────────────────┘
                            │ 受控地调用真实资源
┌───────────────────────────┴──────────────────────────────┐
│  executors/  执行器 / 资源层                               │
│    · browser-driver   Playwright 实例管理(页面/会话)(预留)│
│    · fs-driver        文件系统访问(限定沙盒目录) ✅ 已实现 │
│    · http-client      外部 API 调用(预留)                  │
└───────────────────────────┬──────────────────────────────┘
                            │
┌───────────────────────────┴──────────────────────────────┐
│  platform/  横切基础设施(被各层共用)                      │
│    · logger      统一日志 ✅ 已实现                                  │
│    · config      配置/密钥管理(API key 等) ✅ 已实现                │
│    · storage     持久化:SQLite(记忆、日志、用户数据) ✅ 已实现      │
│    · security    权限策略、沙盒、危险工具确认 ✅ 已实现               │
│    · errors      统一错误类型 ✅ 已实现                              │
└──────────────────────────────────────────────────────────┘
```

---

## 各层职责与关键约定

### interface/ — 壳
唯一规则:**不含业务逻辑**。CLI 只干「读一行字 → 交给 core → 把结果打印出来」。
语音、GUI 以后各自实现同一个「输入→文本、事件→展示」的接口即可,内核零改动。

### core/ — 内核(护城河)
`orchestrator` 是心脏,跑工具调用循环:

```
把[用户消息 + 注册表里所有工具的描述] → llm-client
← LLM 返回:要么「最终回答」,要么「调用某工具(name,args)」
若是工具调用 → 交给 tools/runner 执行 → 结果塞回 context → 再问 LLM
直到 LLM 给出最终回答,或触发任一「刹车」条件
```

内核**只依赖注册表给的「工具描述列表」和 runner 的「执行入口」**,不 import 任何具体工具。这是解耦命门。

**`llm-client` — provider 中立 + adapter 适配:**

内核绝不直接对话某个厂商的 API 格式。`llm-client` 对内暴露一套**中立**的请求/响应类型,对外为每个厂商写一个 adapter 做翻译。

```
orchestrator  →  中立 LLMRequest  →  llm-client
                                       ├─ DeepSeekAdapter  (OpenAI 兼容 function calling)
                                       ├─ ClaudeAdapter    (tool_use 协议)
                                       └─ ...
                                     ←  中立 LLMResponse  ←
```

- 各厂商在**消息结构、tool_result 回填格式、并行工具调用支持**上都不同,由 adapter 吸收这些差异。
- adapter 附带一张**能力表**(是否支持并行 tool call、上下文窗口大小、是否支持流式等)。内核读能力表决定行为:例如模型不支持并行调用时,orchestrator 自动**降级为串行**执行。
- 换模型 / 同时挂多个模型 = 加一个 adapter,内核零改动。这与整体架构的解耦精神一致。
- DeepSeek V4 Pro 的确切规格(窗口、并行支持)以实际接入为准,先按能力表设计,别假设某能力一定存在。

**主循环刹车(必须内建,否则会失控烧钱/死循环):**

- **最大轮数 `maxSteps`**:按任务类型分级,不是一刀切。纯问答 **3~5**、一般任务默认 **10**、浏览器多步任务放宽到 **15~20**。到顶后不硬停,而是把「已达步数上限」作为提示喂回 LLM,让它基于现有进展给一个收尾回答。
- **重复调用检测**:记录 `(工具名 + 参数指纹)`,若连续/高频出现同一调用,判定为死循环,中断并如实告知用户「我卡在同一步了,这是目前进展」。
- **取消**:用户可随时通过反向通道(见下文 `AgentControl`)打断,信号经 `ctx.signal` 传到正在执行的工具。
- (预留)**token / 成本预算上限**:接入用量统计后再加,当前用 `maxSteps` 兜底。

阈值(`maxSteps`、重复判定次数)都写成**可配参数**,不写死在代码里。

**两类 LLM 调用,别混用范式:**

系统里的模型调用分两种,只有第一种走 ReAct 循环:

| 类型 | 谁在用 | 范式 | 特征 |
|---|---|---|---|
| **主循环(agentic)** | orchestrator | **ReAct**:想→调工具→观察→再想,多轮迭代 | 带工具、带 maxSteps 刹车、结果回流再决策 |
| **一次性工具调用(utility)** | 记忆压缩、历史摘要、内容分类、疑似注入检测等 | **单发**:输入→输出,一问一答就结束 | 不带工具、无循环、无刹车、不进主 context |

- 记忆压缩、滚动摘要这类是**纯函数式的一次性调用**:给它一段文本,让它压缩/摘要,拿到结果就完事,**绝不套 ReAct 循环**,否则平白多轮、烧 token、还可能跑偏。
- 两类调用都经 `llm-client`(复用 provider 中立 + adapter),但只有主循环经 orchestrator。utility 调用由各自模块(如 context 的压缩器)直接调 llm-client 的单发接口。
- 因此 `llm-client` 要暴露两个层次:底层 `complete(request)` 单发原语(utility 用),orchestrator 在其上叠加工具循环(主循环用)。

### tools/ — 工具层(三件套是重点)
1. `contract`:所有工具实现的统一 interface(name / description / parameters / run + 危险标记)。
2. `registry`:登记册 + `名字→工具` 映射,并能「导出全部工具描述」喂给内核。
3. `runner`:**所有调用的唯一关卡**,校验参数、查权限、记日志、重试都在这里统一做(即「调用管线」)。

各工具组(builtin / browser / system)只管实现 contract,写完往 registry 一塞,内核自动就会用。

**注册表 vs 调用管线的职责区分:**
- 注册表 = 名册:有哪些工具、名字对应哪个函数、各自怎么描述。
- 调用管线 = 门禁:所有调用都走的唯一关卡,日志/权限/校验统一挂在这。
- 注册表提供「唯一入口」这个前提,通用模块才有地方统一挂。

### executors/ — 执行器
真正碰浏览器、文件、网络的地方。**工具不直接碰资源,通过执行器**。
例如所有浏览器工具共用一个 `browser-driver` 管理的 Playwright 实例,省得各开一个浏览器。

### platform/ — 横切基础设施
日志、配置、存储、安全、错误,被上面所有层共用。
特别是 `security`,给 runner 提供权限判断,是通用 agent 的安全底座。

---

## 贯穿全局的关键接口

```typescript
// 1) 工具契约 —— 工具层的地基
interface Tool {
  name: string;
  description: string;              // 喂给 LLM,决定何时调用
  parameters: JSONSchema;           // 入参结构
  danger?: boolean;                 // 是否需用户确认(安全层用)
  needs?: ('browser' | 'fs' | 'http')[]; // 静态声明:本工具要哪些资源。runner 据此只注入对应执行器
  run(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

// 2) 工具执行环境 —— 由 runner 组装并注入,是「取消/确认/资源访问」的接线枢纽
interface ToolContext {
  sessionId: string;
  signal: AbortSignal;                                 // 取消:工具需主动 signal.throwIfAborted()
  logger: Logger;
  confirm(req: { reason: string }): Promise<boolean>;  // 危险操作请求确认,内部发 confirm_required 事件并挂起等回传
  executors: {                                         // 依赖注入:工具不自己 import 资源;只含该工具 needs 声明的执行器
    browser?: BrowserDriver;
    fs?: FsDriver;
    http?: HttpClient;
  };
}

// 3) 内核↔工具层 的唯一通信形态
type ToolCall   = { name: string; args: unknown };
type ToolResult = { ok: boolean; data?: unknown; error?: string };

// 4) 交互层↔内核 的唯一通信形态(壳可随意替换的保证)
type AgentInput = { text: string; sessionId: string };

type AgentEvent =                     // 内核 → 壳(流式吐出)
  | { type: "thinking" }
  | { type: "tool_call"; name: string }
  | { type: "tool_result"; ok: boolean }
  | { type: "confirm_required"; callId: string; call: ToolCall; reason: string } // 危险操作,等用户批准
  | { type: "final"; text: string };

// 5) 壳 → 内核 的反向通道(确认回传 / 取消,单靠 AgentInput 表达不了往返)
type AgentControl =
  | { type: "approve"; callId: string }   // 批准某个 confirm_required
  | { type: "deny"; callId: string }      // 拒绝
  | { type: "cancel" };                   // 打断当前任务,触发 ctx.signal
```

**反向通道怎么闭环(危险工具确认的一次往返):**

```
工具/runner 判定 danger → ctx.confirm({reason})
  → 内核发出 AgentEvent { confirm_required, callId, ... } 给壳,并挂起该次调用
  → 壳问用户,用户答复
  → 壳经反向通道回传 AgentControl { approve/deny, callId }
  → 内核用 callId 找到挂起的 confirm,resolve 成 true/false
  → 工具据此继续执行或放弃,循环推进
```

取消同理:壳发 `{ cancel }` → 内核 abort → `ctx.signal` 通知正在跑的工具停下。

---

## 目录结构(TS 全栈,单体起步)

```
src/
  interface/   cli/  voice/  gui/
  core/        orchestrator.ts  planner.ts  llm-client.ts  context.ts  memory.ts
  tools/       contract.ts  registry.ts  runner.ts
               builtin/  browser/  system/
  executors/   browser-driver.ts  fs-driver.ts  http-client.ts
  platform/    logger.ts  config.ts  storage.ts  security.ts  errors.ts
  main.ts      组装:注册工具 → 建内核 → 挂壳 → 启动
```

---

## 执行模式(三档路由:直接回答 / 简单 tool_call / code 模式)

不是所有请求都值得走同一条路。入口处做**多维意图识别**,把请求路由到三档之一。

### 多维意图识别(维度打分 → 组合逻辑写死在代码里路由)

不让模型笼统判「复杂/简单」(黑盒、不可调试、可被话术操纵),而是拆成**独立维度**各判是/否,再由**代码里的确定规则**组合出路由结果:

| 需要调工具? | 需要多轮迭代? | 路由到 |
|---|---|---|
| 否 | —— | **① 直接回答**(纯问答,不碰工具) |
| 是 | 否 | **② 简单 tool_call**(单次/少量,如查天气) |
| 是 | 是 | **③ code 模式**(复杂多步、数据密集) |

- 维度可扩展:以后加「是否涉及危险操作」「预估数据量」等只是加列加规则,主干不动。
- 每个维度可用不同手段判:能用规则/关键词粗筛的先用规则,拿不准再上模型,省 LLM 调用。
- **组合逻辑(几个维度 → 哪一档)写死在代码里**,不让模型直接吐「复杂/简单」——路由确定、可测、不被注入操纵(同「权限只绑操作不绑模型声称任务」的思路)。
- 判定器本身是一次 **utility 单发调用**(不套循环),要低成本。误判代价不对称:**复杂误判成简单**只是多几轮往返(无害);**简单误判成复杂**会为小任务平白暴露「代码执行」这个高危面。故判定器**偏保守**,拿不准走简单档。

### 三档各自怎么跑

- **① 直接回答**:一次 LLM 调用出结果,连工具都不给。
- **② 简单 tool_call**:标准 function-calling。说明书 = `registry.getAllDescriptions()`(name/description/parameters),经 adapter 塞进请求。适合单次或少量、无数据加工的调用。
- **③ code 模式(CodeAct 范式)**:复杂任务下,让模型**写一段代码去调用工具**,在代码里就地过滤/转换工具返回的数据,只把最终结果 `return` 回 context。收益:减少往返、大块中间数据(DOM/文件列表/正文)留在运行时不进窗口、对数据流掌控更强。

### code 模式的安全铁律(不守则整套安全作废)

- **代码调工具必须仍走 runner**:沙箱里不给真执行器,只给一层 `tools` 代理,每个方法内部调 `runner.run({name,args})`。于是 `needs` 权限、参数校验、沙盒白名单、`danger` 确认、日志**全自动保留**。代码模式只是把「车」从「单个 tool_call」换成「一段会多次过收费站的代码」,收费站没变。
- **代理自动生成,零手写**:遍历注册表,每个工具自动生成一个走 runner 的代理方法;说明书(可调函数清单)也从同一批 description/parameters 生成。加新工具两边自动跟上。
- **代码沙箱必须真隔离**:执行模型现写的任意 JS 是真正的任意代码执行面。沙箱里除 `tools` 代理外什么都碰不到(无 require/fs/网络/process)。**不要用 vm2**(已废弃、有逃逸漏洞),用 `isolated-vm` 或独立子进程 + 单一 IPC 通道回 runner。这是整个创新最硬的安全专题。
- **code 模式仍是循环,归 orchestrator 管**:模型写的代码常首次报错,真实流程是「写→跑→抛错→喂回改→再跑」,`maxSteps` 刹车照样套在这个循环上。它不是 utility 单发。

### 落地分期(顺序不能乱)

1. 先把 **② 简单 tool_call + runner + security** 做扎实——code 模式完全依赖 runner 当关卡。
2. **③ code 模式作为后续独立阶段**加(排在浏览器工具组之后或并行),因为它依赖两样先就位:成熟的 runner(挂代理)+ 真隔离的代码沙箱(新大件)。

---

## 上下文管理(不做会被工具结果撑爆窗口)

DeepSeek V4 Pro 窗口有 **1M**,压力比小窗模型小得多,但**不等于可以随便灌**——原始 DOM 单页就能几十万 token,几轮照样爆;而且喂太多噪声会稀释注意力、拖慢也烧钱。所以策略从「省到极致」放宽为「够用即可、不浪费」。
`context` 模块不只是「消息栈」,还要按场景执行截断 / 摘要规则(以下阈值针对 1M 窗口设定,均为可配参数)。

**请求前 Prompt 加工(context 的核心职责):**

每次送给 llm-client 之前,context 模块负责组装最终 prompt:历史压缩、摘要注入、工具结果截断、子 agent 摘要注入、中间态折叠。这是上下文管理的统一入口,不散落在各处。

| 场景 | 规则 |
|---|---|
| **DOM / 无障碍树** | 绝不把原始 HTML 塞进 context。只提取「可交互元素清单 + 文本摘要」,单次上限 **~2 万 token**;完整结果留在 context 外,LLM 要细看再用工具二次读取 |
| **网页正文抓取** | 单次上限 **~1 万 token**,超出截断(附「已截断」标记)或先摘要再入栈 |
| **文件读取** | 单次上限 **~1 万 token**,用 offset/limit 分块读 |
| **长会话历史** | 累计用量达窗口 **70%(~700K)** 时压缩:保留系统提示 + 最近 **10 轮**原文,更早的滚动摘要;丢弃中间态工具结果但保留其结论 |
| **中间态 vs 结论** | 「导航成功」这类过程结果,下一步之后即折叠;只有结论长期留栈 |

阈值(单次截断上限、压缩触发比、保留轮数)全部写成**可配参数**。1M 下这些值偏宽松,以后换小窗模型时(adapter 能力表会给出窗口大小)按比例调紧即可。

---

## 安全与权限(通用 agent 的生死线)

一个能开浏览器、碰文件系统、跑命令的 agent,出错或被提示注入时能造成真实破坏。架构必须内建:

- **工具分级**:只读工具(查、抓)自动执行;写/危险工具(删文件、提交表单、花钱)需**用户确认**(`danger: true`)。
- **沙盒/白名单**:文件操作限定目录,命令执行白名单。
- **网页内容是不可信输入**:抓回来的网页文字可能含「忽略之前指令」的注入攻击,内核要对「工具返回内容」和「用户指令」做隔离。

### 两层权限模型(能力边界 vs 策略边界)

一个工具的权限约束分两层,别混:

| 层 | 管什么 | 何时定 | 谁决定 |
|---|---|---|---|
| **静态:能碰哪类资源** | 删文件工具只有 fs、给不到 browser | 编写工具时,靠 `needs` 声明绑死 | 工具作者,写死在契约里 |
| **动态:这一次准不准** | 删 `桌面/old.log` 准、删 `C:/Windows/System32/x` 拒 | 运行时,依赖模型填的具体参数 | security 策略,每次现判 |

- 静态层:工具声明 `needs: ['fs']`,runner 只把 fs 执行器放进它的 ctx,它这辈子都碰不到浏览器。
- 动态层:同一个工具、同一份 needs,但每次操作的具体参数(路径/URL/命令)要过 security 策略。
- **模型两层都改不了**:它连工具能碰什么资源都动不了,更谈不上提权,只能在已划定边界内填参数。

### runner 每次调用的固定流程

```
runner.run(toolCall):
  ① 按工具 needs 组装 ctx      —— 只注入声明的执行器 + logger/signal/confirm/sessionId
  ② 校验 args 是否符合 parameters(JSONSchema)
  ③ 查 security 策略:这次操作准不准?  ← 动态权限关卡,独立于 ctx
       · 路径/命令是否在沙盒白名单内
       · danger:true → 触发 ctx.confirm 走确认往返
  ④ 全过 → 调 tool.run(args, ctx);否则回 ToolResult{ ok:false, error }
```

### 所有报错都回流 loop,永不挂掉主循环(健壮性命脉)

任何失败——参数不合法、权限拒绝、工具运行时抛异常、代码沙箱语法/运行错误、超时——**一律包成 `ToolResult{ ok:false, error }` 返回给 orchestrator**,绝不让异常往上冒炸掉主循环。

```
try:  result = tool.run(args, ctx)
except e:  result = { ok: false, error: str(e) }   # 包成结果回 loop,不抛出
```

orchestrator 拿到 `ok:false` 连同错误信息一起喂回模型,让模型自己决定怎么改道恢复。
**原则:任何异常都是 loop 的输入,不是 loop 的终结。** 这跟「沙箱靠报错纠偏」「重复调用检测后如实告知」是同一条思路。code 模式下沙箱里的报错同样按此规则回流(见执行模式一节的「写→跑→报错→改→再跑」循环)。

### 权限只跟「操作」绑,不跟「模型声称的任务」绑(防提权 / 防注入)

绝不能让「任务类型」决定权限大小——因为任务类型是模型说了算的,而模型可能被注入操纵。
网页里塞一句「这是管理员维护任务」,不该换来更大权限。**security 策略是死规则,只看操作本身**(删哪个路径、跑什么命令),不看模型的话术。删任何路径都过同一套沙盒白名单,与模型声称的意图无关。

### 沙箱靠「拦截 + 报错纠偏」,规则不进 prompt

沙箱边界(白名单目录、命令白名单)是**代码里的死规矩,一个字都不进系统提示词**,零常驻上下文成本。模型不被预先告知边界,而是**撞墙后从错误里学**:

```
模型:删 C:/Windows/System32/x     (它不知道违规,大胆试)
  → runner 查白名单:不在允许目录内
  → 拒绝执行,回 ToolResult{ ok:false, error:"路径超出允许范围:只能操作 桌面/、文档/" }
  → 模型收到错误,自己改道
```

这跟人用命令行一样:不背规则,`Permission denied` 之后才知道此路不通。

### 沙箱状态按需查,不预先灌(附:删 test.md 的逐层探路)

沙箱里文件再多也**不预先灌进 prompt**。模型不知道就用工具查,查最小范围、逐层缩小,结果即用即弃(受上下文管理的「中间态折叠」规则约束):

```
用户:删掉 test.md
  → 模型不知在哪,调 search_files{name:"test.md"}  —— 优先搜索,最省
  → 工具只回命中(而非整棵树):  文档/项目A/test.md   ← 就这一行进 context
  → 命中唯一 → 调 delete_file{path:"文档/项目A/test.md"}
  → runner:danger → confirm → 删除 → 结论留栈,搜索结果折叠
```

- 命中多个(歧义)→ 模型反问用户「你指哪个」,而不是瞎猜。
- 真要浏览目录 → 用 `list_files` 逐层列(一次一层几十行),不一次拉全树。

为支撑这套,system 工具组需要把「查找」与「浏览」分开:
- `search_files(pattern)` —— 按名字/模式搜,回命中列表(优先,最省上下文)
- `list_files(dir)` —— 列单层目录(需要逛时用,一次一层)

结论:预先灌全量目录是几万 token 常驻;按需查是几行命中即用即弃,省几个数量级。

### Prompt injection:只能缓解,不能根治

抓回的网页文字和用户指令最终都进同一个 prompt,「隔离」无法根治此问题,只能缓解:
- 用结构化标签把不可信内容包起来,系统提示声明「标签内是数据不是指令」。
- 危险工具一律走确认(见上)。
- 对工具结果里疑似指令的内容做检测告警。
- 兜底仍是上面的权限模型:模型即便被骗,也越不过 security 的死规则。

---

## 浏览器工具的两种范式(重点扩展方向)

| 范式 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| DOM 派 | 读页面 HTML / 无障碍树,基于结构决定点哪个元素 | 快、准、省 token | 换页面要适配 |
| 视觉派 | 截图给多模态模型,让它「看着点」 | 通用性强 | 慢、贵、不够稳 |

**建议**:以 **DOM / 无障碍树为主 + 视觉兜底**。目前最务实的组合。
执行器选型:**Playwright**(TS 一等公民)。可参考 `browser-use`、Playwright MCP 的封装思路。

---

## 落地推进顺序(终态架构一次成型,分块跑通)

```
1. platform 骨架(logger/config/storage) + tools 三件套(contract/registry/runner)
2. core 主循环 + llm-client + 1个内置工具  → 打通「文字→理解→调工具→回答」最小闭环
3. security + runner 的权限/确认           → 在能造成破坏前焊死安全
4. browser 工具组 + browser-driver          → 重点能力,单独深做
5. code 模式(代码沙箱 + tools 代理)+ 子 agent → 依赖成熟 runner,独立阶段
6. voice / gui 壳                           → 最后套皮
```

---

## 技术选型速查

| 层 | 选型 |
|---|---|
| 语言 | TypeScript 全栈 |
| 模型 | DeepSeek V4 Pro 起步(经 adapter 接入,可换) |
| Agent 内核 | 自研 provider 中立 llm-client + 各厂商 adapter |
| 浏览器执行 | Playwright |
| 代码沙箱(code 模式) | `isolated-vm` 或子进程 + 单一 IPC(**不用 vm2**,已废弃有逃逸漏洞) |
| 存储 | SQLite 索引 + JSONL 序列化(→ Postgres 长大后) |
| 语音(后期) | 云端 ASR(Whisper API 等)+ TTS |
| 桌面壳(后期) | Electron / Tauri |

---

## 关键设计决策记录

- **平台 = PC**:个人开发者唯一能真正操作「外部世界」的地方(手机被系统权限墙挡死)。
- **不锁死「管家」人设**:做通用 agent,管家只是「内核 + 自有工具」的一种产物。
- **工具作为独立一层 + 可插拔**:加能力 = 写新 Tool 塞进注册表,内核零改动。
- **大脑与手解耦**:内核(理解/规划/编排)可复用到任何形态;「手」(工具/执行器)按需扩展。
- **模型不绑定厂商**:DeepSeek V4 Pro 起步,但内核只对话中立的 llm-client,换模型 = 加 adapter。
- **主循环有刹车**:`maxSteps` 按任务分级(问答 3~5 / 默认 10 / 浏览器 15~20)+ 重复调用检测 + 反向通道取消,防失控烧钱/死循环。
- **反向通道优先于纯事件流**:危险确认与取消是「往返」而非单向,故有 `AgentControl` 与 `confirm_required`。
- **规划范式起步用纯 ReAct**:orchestrator 单循环即可,planner 留作后续增强,避免过度设计。
- **两类 LLM 调用分开**:只有 orchestrator 主循环走 ReAct(带工具/刹车);记忆压缩、摘要、分类等是一次性单发调用,直接调 llm-client 的 `complete` 原语,不套循环。
- **三档执行 + 多维意图路由**:直接回答 / 简单 tool_call / code 模式。维度各判是否,组合逻辑写死在代码里路由,判定器偏保守。
- **code 模式(CodeAct)经 runner 代理**:复杂任务让模型写代码调工具,但代码只能碰走 `runner.run` 的自动生成代理,安全全保留;代码沙箱须真隔离(不用 vm2),分期在 runner 成熟后再做。
- **两层权限**:能碰哪类资源 = 工具 `needs` 静态绑死;这一次准不准 = security 运行时按参数判。模型两层都改不了。
- **权限只绑操作、不绑任务类型**:防止模型(或注入)通过声称任务类型来提权。
- **沙箱靠拦截+报错纠偏**:边界规则住代码里、不进 prompt;模型撞墙后从错误学边界,零常驻上下文。
- **沙箱状态按需查**:文件再多也不预先灌,用 `search_files`/`list_files` 逐层探路,结果即用即弃。
- **ToolContext 是接线枢纽**:取消(signal)/确认(confirm)/资源访问(executors)都经 ctx 注入,工具不自己 import。
- **所有报错回流 loop**:参数不合法/权限拒绝/工具抛异常/代码沙箱报错一律包成 `ToolResult{ok:false}` 返回,永不炸主循环。
- **存储格式 JSONL**:对话历史/记忆序列化用 JSONL(易追加/流式读/调试),配合 SQLite 做索引和按 session_id 查询。
- **请求前 prompt 加工统一在 context 模块**:历史压缩、摘要注入、工具结果截断、子 agent 摘要注入,不散落各处。
- **子 agent 不主动驻内存**:LRU 池(上限 3~5)管活跃的,超限序列化到磁盘;摘要总是注入主 agent,完整历史按需重建(接受 KV Cache 失效成本)。
```

---

## 子 Agent 设计(递归调用 + 状态管理)

支持主 agent 递归调用子 agent 来处理分解任务,分**有状态**和**无状态**两种:

### 两个函数:保留状态 vs 不保留

- **`spawn_sub_agent_stateful(task)`**:子 agent 跑完后上下文保留,主 agent 可以继续往里传任务复用已有探索(如代码理解 agent 已读大量文件,后续追问直接复用)。
- **`spawn_sub_agent_stateless(task)`**:一次性执行,任务结束释放,不保留上下文。

模型根据任务特性自行选择调用哪个函数。

### 子 agent 状态存储与重建策略

**原则:不主动长期驻内存,按需重建,接受 KV Cache 失效的成本。**

```
子 agent 跑完:
  ① 提取高密度摘要 → 立刻注入主 agent context        (总是做,信息同步主通道)
  ② 序列化完整历史(user/assistant/tool)→ 存 JSONL  (总是做,归档备用)
  ③ 是否驻内存 → LRU 池决定                         (按需)
```

**LRU 活跃池管理:**
- 活跃子 agent 池上限可配(建议 3~5 个),超限或长时间未访问 → LRU 淘汰 → 序列化到磁盘。
- 后续需要该子 agent → 从磁盘加载 JSONL 重建上下文。
- **已知代价**:重建时 KV Cache 大概率失效,所有历史 token 重新计算,比驻内存慢且贵——但换来内存释放、资源按需使用。
- **可选优化**(后续):淘汰时加入重建成本权重(历史长度 × 工具调用次数),优先淘汰低成本的,保留高成本的。

**两级信息流:**
- **摘要 → 主 agent context**:子 agent 的高密度结论,主 agent 立刻可见,无论子 agent 是否还驻内存。
- **完整历史 → JSONL**:需要深挖时重建子 agent,付出重建成本换取完整上下文。

**数量限制**:活跃池和序列化存储都要有上限(可配),防止无限堆积。LRU 自动管理淘汰。
```

---

## 实现进度记录

### 第一阶段：基础设施与文件系统工具 ✅ (2026-08)

**已完成模块：**

1. **Platform 层（横切基础设施）** ✅
   - `logger.ts` - 日志系统，支持多级别输出
   - `config.ts` - 配置加载，支持环境变量和 .env 文件
   - `storage.ts` - SQLite 持久化存储
   - `errors.ts` - 统一错误类型（ValidationError, SecurityError, ToolExecutionError）
   - `security.ts` - SecurityGuard 沙箱权限检查
     - 白名单路径验证
     - 符号链接解析防逃逸
     - `path.relative` 判断位置关系

2. **Executors 层（执行器）** ✅ 部分完成
   - `fs-driver.ts` - 文件系统执行器
     - 集成 SecurityGuard 权限检查
     - 支持读取、列表、搜索（glob 模式）、写入操作
     - 自动创建父目录
     - glob 模式支持 `*`（单段）和 `**`（任意深度）

3. **Tools 层（工具系统）** ✅ 核心完成
   - `contract.ts` - Tool 接口定义
     - 支持 `needs: readonly ResourceType[]` 声明依赖
     - 支持 `danger: boolean` 标记危险操作
   - `registry.ts` - 工具注册表
   - `runner.ts` - 工具执行管线
     - 参数校验（Zod）
     - 权限检查（危险工具确认）
     - 资源注入（按 needs 动态注入 executors）
     - 错误包装为 ToolResult
   
   **内置工具：**
   - `builtin/echo.ts` - 回显工具
   - `builtin/get-current-time.ts` - 获取时间
   
   **文件系统工具：**
   - `system/read-file.ts` - 读取文件内容
   - `system/list-files.ts` - 列出目录内容
   - `system/search-files.ts` - 搜索文件（glob 模式）
   - `system/write-file.ts` - 写入文件（danger: true）

4. **Core 层（内核）** ✅ 基础完成
   - `llm-client.ts` - Provider 中立接口
   - `deepseek-adapter.ts` - DeepSeek V4 适配器
     - 支持 function calling
     - 消息格式转换
   - `orchestrator.ts` - ReAct 主循环
     - 支持 maxSteps 刹车
     - 工具调用循环
     - 错误恢复

**关键设计实现：**
- ✅ 依赖注入：SecurityGuard → FsDriver → ToolRunner → ToolContext → Tool
- ✅ 两层权限模型：
  - 静态层：`needs` 声明限制资源类型
  - 动态层：security 策略检查具体参数
- ✅ 沙箱白名单：`path.relative` + `realpathSync` 防路径逃逸
- ✅ 错误回流 loop：所有异常包装为 `ToolResult{ok:false}` 不炸主循环
- ✅ Provider 中立：通过 adapter 模式支持多种 LLM

**测试覆盖：**
- ✅ `test-mock.ts` - Mock LLM 基础测试
- ✅ `test-fs-tools.js` - 文件系统工具集成测试

**待实现（下一阶段）：**
- ⏳ BrowserDriver + 浏览器工具组
- ⏳ HttpClient + HTTP 工具
- ⏳ Context 管理（压缩、摘要、中间态折叠）
- ⏳ Memory 模块（长期记忆）
- ⏳ CLI 交互界面
- ⏳ Code 模式（CodeAct 范式）
- ⏳ 子 Agent 支持

