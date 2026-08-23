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
│    · code\         execute_python(代码) / view_image(看图)  │
│    · system\       系统组:文件操作(读/写/列表/搜索)        │
│    职责:具体能力实现,申明 needs 依赖,runner 注入资源       │
└───────────────────────────┬──────────────────────────────┘
                            │ needs: ['fs', 'python', ...]
┌───────────────────────────┴──────────────────────────────┐
│  executors/  执行器 / 资源层                              │
│    · fs-driver     文件系统封装,集成 security 白名单       │
│    · python-executor  子进程执行代码 + 写边界(audit hook)   │
│    · http-client   HTTP 请求(抓 API / 下载文件)           │
│    职责:操作真实资源,被 runner 按工具 needs 动态注入       │
└───────────────────────────┬──────────────────────────────┘
                            │ 横切依赖
┌───────────────────────────┴──────────────────────────────┐
│  platform/  横切基础设施                                   │
│    · logger        分级日志输出                           │
│    · config        .env 配置加载                          │
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
  // 需要让模型「看见」的二进制产物(图片)。由 orchestrator 注入成 user 消息,
  // 不能塞进 data —— tool 消息的 content 只接受字符串
  attachments?: ImageAttachment[];
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

run(initialMessages: Message[]): Promise<AgentRunResult>
```

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
  - **只管写,不管读** —— 两个理由,后者是决定性的:
    ①写/删不可逆,一次手滑就是真实损失;读错文件没有直接损害。
    而读的白名单最容易误伤(实测一次 `import pandas` 触发 1183 次 `open`,
    漏放行一个目录就是 import 直接失败)。
    ②**读边界在给了浏览器能力的前提下不可实现**。实测:Python 层拦住了
    工作区外的 `open`,但 `page.goto("file:///.../id_rsa")` +
    `inner_text("body")` 三行就把内容原样取回 —— chromium 是独立进程,
    audit hook 只约束 Python;而浏览器的启动参数由模型自己写
    (`import playwright` 直接起),框架没有插手的位置。
    这不是实现没做好,是「代码执行」与「浏览器」两个已定能力的固有冲突
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
- **评估后明确不做(不是欠的债)**:
  - **网络管控** —— 实测无效。Playwright 全流程里 `socket.connect` 只出现 2 次、
    都是 `127.0.0.1`(Python 连本地 driver);真正访问网站的是 node driver 与
    chromium **独立进程**,audit hook 只约束 Python 进程,一个字节都看不到
  - **subprocess / ctypes 拦截** —— 实测 `subprocess.Popen` 的 `executable` 参数是
    `None`、命令行是一整个带空格的字符串无法可靠切分;而 `ctypes.dlopen` 有正常用途
    (标准库查时区会 dlopen `kernel32`/`tzres.dll`)。要区分「谁触发的」需要栈分析,
    复杂且脆弱
  - **读路径白名单 / 分级策略 / 中途授权确认** —— 见上;后者还需 CodeAct 工具桥,
    且会加重确认疲劳
  - **剩余风险**(产品决策,非技术限制):模型仍能读任意文件(含 `.ssh`/`.env`),
    并可借浏览器把内容发出去。自用 + 用户信任该 agent 的前提下接受 ——
    同类工具(Codex / Claude Code)同样是全权限跑在用户机器上
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
- **图片是模型「要求看图」的带内信道,不是输入侧的旁路**:
  模型的输出只有文本和 tool_calls,改不了请求体,所以它无法自己把图片塞进上下文。
  流程是「模型调 `view_image` → 框架读盘编码 → **下一轮**注入成 user 消息」,
  模型不需要知道 wire 格式,它只是「调了个工具,然后就看见了」。
  - **图片走 user 消息,不塞进 tool 响应**。后者能 work 但不可靠:实测 68 次里
    tool 通道有 9% 模型看不见图、user 通道 2%,而失败是**静默的** —— 图片照样计费
    (prompt_tokens 明显更高)、HTTP 200、无任何可检测字段,只有模型嘴上说「无图」。
    于是它会基于自己从没看过的观察继续推理,比抛错危险得多。
    图片块只允许出现在 user 里(DeepSeek 对 system/assistant 带图直接 400)
  - 注入时机在**全部 tool 响应写完之后**:配对未闭合时插 user 消息会 400
  - **图片作为「工具观察」进入 `Turn.messages`,随对话保留**(`addObservation()` 写入,
    压缩后由 `flattenTurns` 原样重建)。代价是历史截图每步重发,但 append-only
    保住 KV cache 前缀,而为省 token 去改上下文中间内容反而破坏前缀匹配。
    累积过多由已有压缩机制归档老轮次,**不做滑动窗口**。
    因此 prompt 约定是「旧图只反映截图当时的状态,页面变了要重新截」,
    而不是图片会消失时那套「看到关键信息就写成文字」
  - **累积成本已实测(6 轮连续截图)**:含图片的前缀**可被 KV cache 命中**
    (命中量随累积增长),所以历史图片按缓存价重发,滑动窗口没有必要 ——
    这是上面那条决定的依据。每轮增量约 200~240 token 且**与图片体积无关**
    (426KB 与 1KB 的图增量相同),`detail:'low'` 下每张实际远低于 384 上限
  - **截图是便宜通道,不该劝模型少用**:每张 ≤384 token(服务端先缩放,
    2000×2000 与 5000×5000 消耗相同),而同页 `aria_snapshot` 往往 1000~3000 token。
    token 估算因此按上限计,**不能按 base64 字符数算** —— 1MB 截图的 base64 有
    130 万字符,按字符算会让压缩阈值判断彻底失真
  - trace 落盘前把 data URL 负载换成 `<stripped 1.2MB>`,否则单个 `call-NNN.json`
    几 MB,trace 是为了「能翻」,翻不动就失去意义
  - 格式按**内容**(magic bytes)判而非扩展名 —— 服务端也是按内容判的,
    改名的 bmp 会 400。超配额时返回 `ok:false` + 可照抄的 PIL 缩放代码,不引入图像库

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
- WriteGuard (audit hook 写边界:只允许写工作区 + temp,读不限;
  判定在闭包内,模型无法覆盖。详见「代码执行的边界」那条决策)

**Tools 层**:
- Contract / Registry / Runner (调用管线)
- 内置工具:Echo / GetCurrentTime / SpawnSubAgent
- 系统工具:ReadFile / WriteFile / ListFiles / SearchFiles (均自带返回量上限)
- 代码工具:execute_python (`danger: true`,默认关闭,需 `PYTHON_ENABLED=true`)
- 视觉工具:view_image (默认关闭,需 `VISION_ENABLED=true` + 视觉模型)

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
- 容器隔离 —— **仅在做服务端形态时才需要**。本地形态下已用 audit hook 写边界
  替代(见「代码执行的边界」),不作为本地路线的待办
- 浏览器常驻实例(CDP 连接,跨轮次保持页面停留位置)—— 当前每轮
  `with sync_playwright()` 结束即关闭浏览器,所以「上一轮打开的页面下一轮接着点」
  做不到。`launch_persistent_context` 只保住登录态,保不住页面停留位置
- 子 Agent 的 stateful 模式(保留上下文可续传)+ LRU 驻留池

---

## 技术选型

| 模块 | 技术 |
|------|------|
| 语言 | TypeScript (ES modules) |
| LLM | DeepSeek V4 (1M context) |
| 浏览器自动化 | Playwright(装在 Python 环境内,非 TS 侧依赖) |
| 代码执行 | Python 子进程 + audit hook 写边界(读不限,详见设计决策) |
| 持久化 | SQLite |
| 参数校验 | Zod |
| 测试 | Vitest 单元测试(`src/**/*.test.ts`)+ 手写集成测试 |
| 日志 | 自研 ConsoleLogger |

---

## 下一步

**先验证已交付的部分**:

- **主题目录是否真能驱动回溯**:上下文里的主题块已从「标题 + 摘要正文」
  改为只留标题 + 轮次号,理由是摘要会**抑制**模型去读归档原文
  (实测它 reasoning 里权衡后判断「摘要已足够」,然后照 60 字复述细节)。
  但这个判断只有一次 trace 作证,标题版也可能只是换个形式继续猜 —— 需实跑确认

**然后按此顺序**:

1. **浏览器常驻实例(CDP)**:让「上一轮打开的页面,下一轮接着操作」成为可能。
   排在工具桥之前 —— 它是实际撞到过的限制,纯工程、无未知量
   (原先排在这里的「隔离边界」已由 audit hook 写边界完成)
2. **CodeAct 的工具桥**:让子进程内的 Python 能回调 TS 侧工具,
   动作空间才真正变成代码。架构级改动,需重新设计动作空间
4. Memory 模块(长期记忆)
5. Planner 模块(多步任务拆解)—— 刻意排在最后:
   ReAct 单循环目前还没跑出「明显不够」的证据,提前做属过度设计
