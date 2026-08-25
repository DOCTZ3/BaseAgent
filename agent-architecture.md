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
│    · system-prompt 提示词组装(主/子 agent 环境约定同源)   │
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
- **评估后明确不做(不是欠的债)**:
  - **网络管控** —— 实测无效。Playwright 全流程里 `socket.connect` 只出现 2 次、
    都是 `127.0.0.1`(Python 连本地 driver);真正访问网站的是 node driver 与
    chromium **独立进程**,audit hook 只约束 Python 进程,一个字节都看不到
  - **subprocess / ctypes 的调用栈分析** —— 实测 `subprocess.Popen` 的 `executable`
    参数是 `None`、命令行是一整个带空格的字符串无法可靠切分;而 `ctypes.dlopen`
    有正常用途(标准库查时区会 dlopen `kernel32`/`tzres.dll`)。
    要区分「谁触发的」需要栈分析,复杂且脆弱。
    **注意这条只说明「拦 subprocess 很难」,不改变上面那个缺口的存在**
  - **读路径白名单 / 分级策略 / 中途授权确认** —— 见上;后者还需 CodeAct 工具桥,
    且会加重确认疲劳
  - **代码里的中途确认** —— 结构上不可能:代码块是原子的,一段代码跑完才返回,
    中间没有「跟用户说句话然后等他」的位置(这也是 `request_help` 不上工具桥的原因)。
    所以装包只能在**钝的**两端选:要么禁、要么放行,没有「装之前问一下」这个中间态 ——
    `run_command` 是把那次询问挪到了代码**之外**
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

**Executors 层**:
- FsDriver (文件系统,集成 SecurityGuard 白名单 + 凭证目录黑名单)
- PythonExecutor (子进程执行代码:超时 / stdout 上限 / env 白名单继承 / 进程树回收 /
  `PIP_NO_INDEX` 禁止代码里装包)
- WriteGuard (audit hook 写边界:只允许写工作区 + temp,读不限;
  判定在闭包内,模型无法覆盖。**已知缺口:换个进程即绕过** ——
  详见「代码执行的边界」与「已知缺口」两条决策)
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
- LLMClient (接口) + DeepSeekAdapter (实现,含 trace 钩子)
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
| 代码执行 | Python 子进程 + audit hook 写边界(读不限,详见设计决策) |
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

**仍待验证**:

- **request_help 的实际效果**:调用后会不会照约定明确说「请切换到浏览器窗口」
  并**本轮结束**,而不是继续轮询等待。prompt 写了不等于模型照做
  (`page.accessibility` 那次就是先例)
- **模型能否自己定位登录入口**:导航和点击现在全交给模型写代码
  (它有 aria_snapshot 和截图)。实测过一次它把 `url` 传成站点首页 ——
  那时导航还在框架侧,所以用户被扔在首页。现在这一步归模型,需重测

**然后按此顺序**:

1. Memory 模块(长期记忆)
2. Planner 模块(多步任务拆解)—— 刻意排在最后:
   ReAct 单循环目前还没跑出「明显不够」的证据,提前做属过度设计
