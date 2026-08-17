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
│    · llm-client    封装 LLM API 调用                       │
│    · context       上下文管理:Turn 级别 + 主题聚类压缩     │
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
│    · browser\      浏览器组(重点扩展):导航/点击/填表/抓取  │
│    · system\       系统组:文件操作(读/写/列表/搜索)        │
│    职责:具体能力实现,申明 needs 依赖,runner 注入资源       │
└───────────────────────────┬──────────────────────────────┘
                            │ needs: ['fs', 'browser', ...]
┌───────────────────────────┴──────────────────────────────┐
│  executors/  执行器 / 资源层                              │
│    · fs-driver     文件系统封装,集成 security 白名单       │
│    · browser-driver  Playwright 包装(导航/DOM/截图)       │
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
  needs: readonly ResourceType[];  // 声明依赖资源 ['fs', 'browser', ...]
  danger: boolean;              // 是否危险操作(写入/删除)
  run(args: T, ctx: ToolContext): Promise<ToolResult>;
}

interface ToolContext {
  executors: Record<string, Executor>;  // runner 按 needs 注入
  confirm: (prompt: string) => Promise<boolean>;
  signal: AbortSignal;          // 用户取消
}

interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}
```

**关键设计**:
- 工具通过 `needs` 声明依赖,不直接 import executor
- `ToolContext` 是唯一的资源注入点
- 所有错误包装为 `ToolResult{ok:false}`,不炸主循环

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
  usage: { prompt_tokens: number; completion_tokens: number; prompt_cache_hit_tokens?: number };
}
```

**关键设计**:
- 内核只依赖接口,不依赖具体厂商
- Adapter 模式:DeepSeekAdapter / OpenAIAdapter / ...
- 支持 reasoning (DeepSeek) 和 response_format (JSON 强制)

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
  summary: string;            // 高密度摘要(150-200字)
  turn_ids: number[];         // 关联的 Turn
  keywords: string[];
  timestamp: number;          // 按此排序(时间滑动窗口)
}
```

**关键设计**:
- Turn 级别管理(不是消息级别),确保压缩时对话完整
- 主题聚类压缩:LLM 分析主题 → 生成摘要 → 按时间窗口保留最新 N 个
- 双重检查:Turn 边界 + Mid-Turn 防超窗口
- 归档到 `.claude/sessions/{sessionId}/` (JSONL 格式)
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
   - 框架限制:没声明 'browser' 就拿不到 BrowserDriver

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

| 场景 | 策略 | 阈值 |
|------|------|------|
| **长会话历史** | 主题聚类压缩 | 70% 窗口 (700K tokens) |
| **压缩保留** | 最近 N 轮完整 Turn | 默认 10 轮 |
| **主题数量** | 时间滑动窗口 | 默认保留 10 个主题 |
| **文件读取** | 单次截断 | 10K tokens |
| **网页内容** | 单次截断 | 10K tokens |
| **DOM 树** | 单次截断 | 20K tokens |

**压缩时机**:
- Turn 边界检查(新 Turn 开始前)
- Mid-Turn 检查(每次 LLM 调用后实时统计)

**压缩流程**:
1. 保留最近 N 轮完整 Turn
2. 旧 Turn → LLM 分析主题 → 按主题聚类
3. 每个主题生成摘要(TopicSummary)
4. 按时间排序,保留最新 M 个主题
5. 摘要插入 system 消息,旧 Turn 归档到磁盘

---

## 关键设计决策

- **平台 = PC**:个人开发者唯一能真正操作「外部世界」的地方(手机被系统权限墙挡死)。
- **工具作为独立一层 + 可插拔**:加能力 = 写新 Tool 塞进注册表,内核零改动。
- **模型不绑定厂商**:DeepSeek V4 起步,但内核只对话中立的 llm-client,换模型 = 加 adapter。
- **主循环有刹车**:`maxSteps` 按任务分级(问答 3~5 / 默认 20)+ 重复调用检测 + 反向通道取消,防失控烧钱/死循环。
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

---

## 实现状态

### ✅ 已完成

**Platform 层**:
- Logger / Config / Storage / SecurityGuard / Errors
- RetryHandler (幂等操作的统一重试)

**Executors 层**:
- FsDriver (文件系统,集成 SecurityGuard)

**Tools 层**:
- Contract / Registry / Runner (调用管线)
- 内置工具:Echo / GetCurrentTime
- 系统工具:ReadFile / WriteFile / ListFiles / SearchFiles

**Core 层**:
- LLMClient (接口) + DeepSeekAdapter (实现)
- TokenCounter (Token 统计和阈值判断)
- ContextManager (Turn 管理 + 主题聚类压缩 + 结构化输出)
- Orchestrator (ReAct 主循环)

### ⏳ 待实现

**Executors 层**:
- BrowserDriver (Playwright 封装)
- HttpClient

**Tools 层**:
- Browser 工具组(导航/点击/填表/抓取)

**Core 层**:
- Memory 模块(长期记忆)
- Planner 模块(多步任务拆解)

**Interface 层**:
- CLI (命令行交互)
- Voice (语音接口 - 预留)
- GUI (图形界面 - 预留)

**高级特性**:
- Code 模式(CodeAct 范式)
- 子 Agent 支持

---

## 技术选型

| 模块 | 技术 |
|------|------|
| 语言 | TypeScript (ES modules) |
| LLM | DeepSeek V4 (1M context) |
| 浏览器自动化 | Playwright |
| 持久化 | SQLite |
| 参数校验 | Zod |
| 测试 | 手写集成测试(`test-*.js`,仅本地,不入库) |
| 日志 | 自研 ConsoleLogger |

---

## 下一步

1. 实现 BrowserDriver + 浏览器工具组
2. 实现 CLI 交互界面
3. Memory 模块(长期记忆)
4. Planner 模块(多步任务拆解)
