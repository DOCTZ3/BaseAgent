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
│    · cli          已实现:REPL/单发两种模式 + 可观测回显     │
│    · voice        预留:ASR 语音转文字 / TTS 播报            │
│    · gui          预留:Electron/Tauri 桌面窗口             │
│    职责:只做 输入→文本 / 结构化结果→展示,零业务逻辑        │
└───────────────────────────┬──────────────────────────────┘
                            │ AgentInput / AgentEvent
┌───────────────────────────┴──────────────────────────────┐
│  core/  Agent 内核(大脑)                                  │
│    · orchestrator  主循环:调 LLM → 拿决策 → 派发 → 观察    │
│    · planner       复杂任务的多步拆解(可选增强)           │
│    · llm-client    封装 LLM API 调用                       │
│    · context       上下文管理:Turn 级别 + 主题聚类压缩     │
│    · sub-agent     一次性子 agent(独立上下文,只回传结论)  │
│    · memory        长期记忆:用户偏好/历史(接 storage)     │
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
│    · builtin\      内置组:时间、计算、记事、查询           │
│    · code\         execute_python:CodeAct 的唯一入口       │
│    · system\       系统组:文件操作(读/写/列表/搜索)        │
│    职责:具体能力实现,申明 needs 依赖,runner 注入资源       │
└───────────────────────────┬──────────────────────────────┘
                            │ needs: ['fs', 'python', ...]
┌───────────────────────────┴──────────────────────────────┐
│  executors/  执行器 / 资源层                              │
│    · fs-driver     文件系统封装,集成 security 白名单       │
│    · python-executor  子进程执行代码(⚠️ 无隔离,主环境权限) │
│    · http-client   HTTP 请求(抓 API / 下载文件)           │
│    职责:操作真实资源,被 runner 按工具 needs 动态注入       │
└───────────────────────────┬──────────────────────────────┘
                            │ 横切依赖
┌───────────────────────────┴──────────────────────────────┐
│  platform/  横切基础设施                                   │
│    · logger        分级日志输出                           │
│    · config        .env 配置加载                          │
│    · storage       SQLite 持久化(记忆/session 索引)       │
│    · security      SecurityGuard:白名单路径检查            │
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

interface ToolResult { ok: boolean; data?: unknown; error?: string }
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

**关键设计**:
- 内核只依赖接口,不依赖具体厂商
- **用量字段的厂商差异由 adapter 吸收**:缓存命中在 DeepSeek 是顶层
  `prompt_cache_hit_tokens`、在 OpenAI/中转站是嵌套 `prompt_tokens_details.cached_tokens`,
  两种都认并兜底为 0(实测中转站格式变过,只读一种会让命中率静默归零)。
  跨层传 `usage` 整体透传、不逐字段列举 —— 列举会让新增字段被静默丢掉
- Adapter 模式:DeepSeekAdapter / OpenAIAdapter / ...
- 支持 reasoning (DeepSeek) 和 response_format (JSON 强制)

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

run(initialMessages: Message[]): Promise<AgentRunResult>
```

**关键设计**:返回对象而非裸字符串 —— 退出路径有三条,字符串只能表达一种
(`no_response` 以前返回一句写死的话、与真实回答同通道,CLI 会把内部状态当回答打出)。
用联合类型而非布尔,将来加「用户取消」只需加成员。
子 agent 必须把 `max_steps` 转成 `SubAgentResult.truncated` 继续上传:截断是嵌套的,
中间任何一层吞掉信号,主 agent 就会把半成品当定论。

### ContextManager (上下文管理)

```typescript
interface Turn {
  turn_id: number;
  user_message: Message;
  // 一次迭代 = 一次 LLM 响应。模型可能并行返回多个 tool_call,必须全部记录
  assistant_iterations: Array<{
    reasoning?: string;
    tool_calls?: ToolCall[];
    tool_results?: ToolResult[];
  }>;
  final_response?: Message;
  timestamp: number;
}

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
- Turn 级别管理(不是消息级别),确保压缩时对话完整
- 主题聚类压缩:LLM 分析主题 → 生成索引 → 按时间窗口保留最新 N 个
- 压缩触发只有一处:标志位由 `recordTokenUsage()` 置真、`preparePrompt()` 消费
- 归档到 `<traceDir>/{sessionId}/archive/`,与 LLM 留痕 `calls/` 并列在同一会话目录下。
  不放隐藏目录:**模型自己要读它**(压缩后被提示用 `read_file` 回溯早期对话),
  沙箱若收窄会把它指向读不到的路径;你排查「当时到底聊了什么」也要能直接翻到。
  注入给模型的路径统一用正斜杠 —— `path.join` 在 Windows 上产出反斜杠,
  模型把它当 JSON 参数传回时还得转义
- **`final_response` 必须由 orchestrator 显式写回**(`addFinalResponse`):它是压缩后重建
  「保留轮次」时答案的唯一来源。不写回则模型看不到自己此前的回答,且保留轮次只剩
  提问和工具往返
- **并行 tool_call 必须完整记录**:`Turn` 用复数 `tool_calls`/`tool_results`。只存第一个
  会让压缩后重建出「assistant 声明 N 个 tool_call、却只有 1 条 tool 响应」的非法序列,
  API 直接 400。消息结构校验因此逐个核对 `tool_call_id`,而不是只看「下一条是不是 tool」

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
     checkPath(targetPath: string): { allowed: boolean; reason?: string };
   }
   ```
   - 运行时检查具体参数(如路径是否在白名单内)
   - 沙箱机制:`realpathSync` 解析符号链接 + `path.relative` 判断逃逸

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
    新子 agent 是全新上下文,不知道上一个卡在哪,大概率相似范围重跑撞同一面墙;
    是否补齐由模型看着缺口自己判断(实测模型据此缩小范围后 2 步完成)
  - 提示借**最后一条工具结果**注入(`_system_note` 键),而非新加 user 消息 ——
    `Turn.user_message` 是单数字段,而 `addToolResult` 本就同时写 messages 与 Turn
  - 重复调用检测:待实现
- **规划范式起步用纯 ReAct**:orchestrator 单循环即可,planner 留作后续增强,避免过度设计。
- **两类 LLM 调用分开**:只有 orchestrator 主循环走 ReAct(带工具/刹车);记忆压缩、摘要、分类等是一次性单发调用,直接调 llm-client 的 `complete` 原语,不套循环。
- **两层权限**:能碰哪类资源 = 工具 `needs` 静态绑死;这一次准不准 = security 运行时按参数判。模型两层都改不了。
- **沙箱靠拦截+报错纠偏**:边界规则住代码里、不进 prompt;模型撞墙后从错误学边界,零常驻上下文。
- **ToolContext 是接线枢纽**:取消(signal)/确认(confirm)/资源访问(executors)都经 ctx 注入,工具不自己 import。
- **所有报错回流 loop**:参数不合法/权限拒绝/工具抛异常一律包成 `ToolResult{ok:false}` 返回,永不炸主循环。
- **存储格式 JSONL**:对话历史/记忆序列化用 JSONL(易追加/流式读/调试),配合 SQLite 做索引和按 session_id 查询。
- **Context 压缩采用 Turn 级别管理**:
  - 一个 Turn = user_message + assistant_iterations + final_response,避免压缩不完整对话
  - 主题聚类压缩作为唯一模式(已删除线性压缩)
  - 时间滑动窗口(按 timestamp 排序,不是 LRU)
  - 双重检查:Turn 边界 + Mid-Turn 防超窗口
- **主题窗口机制**:
  - 按时间排序保留最新 N 个主题(不是 LRU)
  - 理由:对话的时间局部性 >> 访问局部性,用户很少跳回旧主题
  - 不引入 `lastAccessTime`,避免复杂度
- **结构化输出替代正则提取**:
  - 主题分析/摘要生成走 `responseFormat: 'json_object'` + Zod 校验
  - 理由:正则解析模型自由文本极脆弱,格式漂移即静默丢数据
  - 校验失败视为可重试错误(让模型重新生成),不是硬错误
- **重试只作用于幂等操作**:
  - LLM 调用、JSON 解析/校验走 RetryHandler;工具执行**不走**(写文件/发请求重试会产生重复副作用)
  - SDK 自带重试关掉(`maxRetries: 0`),避免两层重试次数叠乘
  - 不做熔断:单进程 CLI 场景下过度设计
- **重试分层:内层管网络,外层只管解析**:
  - Adapter 内的 RetryHandler 负责网络错误/限流/5xx;ContextManager 外层用 `explicitOnly`
    模式,只重试显式的 `RetryableError`(JSON 解析/Schema 校验失败)
  - 理由:两层都按错误特征匹配会让真实 API 调用次数**相乘**(各 3 次重试 → 最坏 16 次),
    退避时长同样翻倍。关掉 SDK 重试只解决了三层里的一层
- **重试粒度 = 单次 LLM 调用**:
  - 每个主题的摘要各自独立重试,一个主题失败不会导致整批重来
- **压缩失败降级而非中断**:
  - 主题分析失败 → 所有 Turn 归入默认主题
  - 摘要生成失败 → 占位摘要
  - 理由:压缩是保命机制(防超窗口),中断它比丢一段摘要严重得多
- **压缩必须看到完整轨迹**:
  - 送给压缩模型的每一轮包含「用户提问 + 工具调用 + **工具结果** + **最终回答**」,
    不是只给提问和工具名
  - 理由:缺了结果和回答,模型只能靠猜补全,会把编造的结论写进长期上下文。
    实测出现过「工具调用后未返回具体时间数据」这种与事实相反的摘要 ——
    而那轮工具明明成功了、助手也已作答。**压缩注入假事实比丢一段摘要严重得多**
  - 输入按字段截断(保留开头:`ok` 标志和数据头部在前面),防止工具结果撑爆压缩自身的输入
  - 最终回答的截断额度给得比工具结果宽:它是模型对原始输出的蒸馏,
    单位字符信息密度更高,同样的输入预算花在这里更划算
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
- **压缩产物是检索索引,不是文章摘要**:目标 60 字以内,只写「做了什么 + 结果」,
  禁止过程叙述。它常驻上下文,用途是让模型判断「要不要读归档原文」,
  翻阅由 `read_file` 完成,所以只需可判别、不需完整。
  字数只给上限不给下限 —— 给下限会逼模型注水复述过程,产出比原文还长(实测发生过)。
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
- **⚠️ 已知缺口:`execute_python` 绕开了两层权限模型**:
  - 代码在子进程里以**当前 OS 用户的全部权限**运行。PythonExecutor 做的是资源管控
    (超时 / stdout 上限 / 进程树回收),**不是安全边界**
  - `needs` + SecurityGuard 那套之所以成立,前提是「框架能看懂工具入参」;
    而这里入参就是一整段任意代码。`FS_SANDBOX_PATHS` 管不住 `open()`,
    网络也无限制。`danger: true` 只保证调用前弹一次确认,确认之后即全权限
  - 于是当前存在两个动作空间:`tool_calls` 受两层权限管,Python 只受「用户点过同意」管。
    这是路线的固有性质,不是实现疏漏 —— 参数检查无法约束图灵完备的输入
  - 唯一主动收紧的一处:父进程 env **按白名单继承**,不全量透传。
    `process.env` 里有 `DEEPSEEK_API_KEY`,全量继承则模型一行
    `print(os.environ['DEEPSEEK_API_KEY'])` 就能把它打进上下文并跟着 trace 落盘。
    这不构成隔离(代码仍可读 `.env` 文件),只是不把凭证直接递到手里
  - 真隔离需要进程之外的边界:容器 / 独立低权用户 / seccomp。属于待实现,
    在那之前 `PYTHON_ENABLED` 默认关闭,开启即代表接受上述范围
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
    配合 prompt 约定「只用 `BROWSER_PROFILE_DIR`」+ stdout 上限兜底;
    硬隔离需把浏览器移进独立容器、Python 经 CDP 连接,留作后续

---

## 实现状态

### ✅ 已完成

**Platform 层**:
- Logger / Config / Storage / SecurityGuard / Errors
- RetryHandler (幂等操作的统一重试)
- TraceRecorder (LLM 调用留痕,本地可观测)

**Executors 层**:
- FsDriver (文件系统,集成 SecurityGuard 白名单 + 凭证目录黑名单)
- PythonExecutor (子进程执行代码:超时 / stdout 上限 / env 白名单继承 / 进程树回收)
  —— ⚠️ 无隔离,见上方「已知缺口」

**Tools 层**:
- Contract / Registry / Runner (调用管线)
- 内置工具:Echo / GetCurrentTime / SpawnSubAgent
- 系统工具:ReadFile / WriteFile / ListFiles / SearchFiles (均自带返回量上限)
- 代码工具:execute_python (`danger: true`,默认关闭,需 `PYTHON_ENABLED=true`)

**Core 层**:
- LLMClient (接口) + DeepSeekAdapter (实现,含 trace 钩子)
- TokenCounter (Token 统计和阈值判断)
- ContextManager (Turn 管理 + 主题聚类压缩 + 结构化输出)
- Orchestrator (ReAct 主循环)
- LocalSubAgentRunner (一次性子 agent:独立上下文,无递归,只回传结论)

**Interface 层**:
- CLI (REPL / 单发两种模式,斜杠命令 + 每轮可观测回显)

### ⏳ 待实现

**Executors 层**:
- HttpClient

**Core 层**:
- Memory 模块(长期记忆)
- Planner 模块(多步任务拆解)

**Interface 层**:
- Voice (语音接口 - 预留)
- GUI (图形界面 - 预留)

**高级特性**:
- **Code 模式(CodeAct 范式)** —— 目前只完成了执行底座(`execute_python` 仍是
  ReAct 循环里的一个普通工具,与 `read_file` 平级)。真正的 CodeAct 要把
  **动作空间本身变成代码**:模型不发 JSON 而发一段代码,现有工具在那段代码里
  作为函数可调用(`for f in search_files("*.ts"): ...`),循环与条件下沉到代码中,
  一次 LLM 调用完成整轮遍历而非 N 轮往返。
  缺的核心机制是**工具桥** —— 子进程内的 Python 目前没有任何回调 TS 侧的通道
- 代码执行的真隔离(容器 / 独立低权用户 / seccomp)—— 见上方「已知缺口」,
  在此之前 `PYTHON_ENABLED` 默认关闭
- 环境预装 Playwright + 持久 profile 登录引导(依赖手工装库,尚未验证)
- 浏览器常驻实例(CDP 连接,跨轮次保持页面停留位置)
- 子 Agent 的 stateful 模式(保留上下文可续传)+ LRU 驻留池

---

## 技术选型

| 模块 | 技术 |
|------|------|
| 语言 | TypeScript (ES modules) |
| LLM | DeepSeek V4 (1M context) |
| 浏览器自动化 | Playwright(装在 Python 环境内,非 TS 侧依赖) |
| 代码执行 | Python 子进程(⚠️ 无隔离,主环境权限) |
| 持久化 | SQLite |
| 参数校验 | Zod |
| 测试 | Vitest 单元测试(`src/**/*.test.ts`)+ 手写集成测试 |
| 日志 | 自研 ConsoleLogger |

---

## 下一步

1. 装 Playwright + 依赖库,验证浏览器路径(持久 profile 登录引导实际能否跑通)
2. 代码执行的隔离边界(容器 / 独立低权用户)—— 解掉「已知缺口」那条
3. CodeAct 的工具桥:让子进程内的 Python 能回调 TS 侧工具,
   动作空间才真正变成代码
4. Memory 模块(长期记忆)
5. Planner 模块(多步任务拆解)
