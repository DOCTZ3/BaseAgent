# BaseAgent 项目指令

## 架构文档同步规则

**重要：每次修改代码后，必须同步更新 [agent-architecture.md](agent-architecture.md)**

### 需要同步的情况

1. **新增模块或文件**
   - 添加新的工具类（如新增浏览器工具）
   - 添加新的执行器（如 http-client）
   - 添加新的核心模块（如 planner）
   
2. **修改架构设计**
   - 改变模块间的调用关系
   - 修改接口定义（Tool、ToolContext、ToolResult 等）
   - 调整权限模型或安全机制
   
3. **实现架构文档中的"预留"功能**
   - 将占位符（如 `executors.browser = null`）改为真实实现
   - 完成标注为"后续实现"的模块

4. **发现架构缺陷并修复**
   - 发现设计问题并调整实现
   - 添加新的安全机制或检查点

### 同步方式

- 在 agent-architecture.md 对应章节更新
- 如果是重大架构变更，更新"关键设计决策记录"章节
- 保持文档的示例代码与实际实现一致

### 文档结构对应关系

| 代码目录 | 文档章节 |
|---------|---------|
| `src/platform/*` | "platform/ — 横切基础设施" |
| `src/executors/*` | "executors/ — 执行器 / 资源层" |
| `src/tools/*` | "tools/ — 工具层" |
| `src/core/*` | "core/ — Agent 内核" |
| `src/interface/*` | "interface/ — 壳" |
| 接口定义 | "贯穿全局的关键接口" |
| 安全实现 | "安全与权限" |

## 当前项目状态

### 已完成模块

✅ **Platform 层（基础设施）**
- Logger（日志系统）
- Config（配置加载，支持 .env）
- Storage（持久化存储）
- Errors（统一错误类型）
- SecurityGuard（沙箱权限检查）

✅ **Executors 层（执行器）**
- FsDriver（文件系统执行器，集成 SecurityGuard）

✅ **Tools 层（工具系统）**
- Tool Contract（工具接口定义）
- ToolRegistry（工具注册表）
- ToolRunner（工具执行器，支持权限检查和资源注入）
- 内置工具：
  - EchoTool
  - GetCurrentTimeTool
  - ReadFileTool
  - ListFilesTool
  - SearchFilesTool
  - WriteFileTool

✅ **Core 层（内核）**
- LLMClient（Provider 中立接口）
- DeepSeekAdapter（DeepSeek V4 适配器）
- Orchestrator（ReAct 主循环）

### 待实现模块

⏳ **Executors 层**
- BrowserDriver（浏览器执行器 - Playwright）
- HttpClient（HTTP 客户端）

⏳ **Tools 层**
- Browser 工具组（导航、点击、填表、抓取）

⏳ **Core 层**
- Context 管理（上下文压缩、摘要）
- Memory 模块（长期记忆）
- Planner（多步任务拆解）

⏳ **Interface 层**
- CLI（命令行交互）
- Voice（语音接口 - 预留）
- GUI（图形界面 - 预留）

⏳ **高级特性**
- Code 模式（CodeAct 范式）
- 子 Agent 支持
- 三档执行路由（直接回答/简单 tool_call/code 模式）

## 代码风格约定

### TypeScript 规范
- 使用 ES modules（`.js` 后缀导入）
- 接口优先于类型别名（当定义对象结构时）
- 使用 `readonly` 保护不可变数据
- Zod 用于运行时参数校验

### 注释规范
```typescript
// ============================================
// 模块功能:简短描述
// ============================================

/**
 * 函数/方法的详细说明
 * @param paramName 参数说明
 * @returns 返回值说明
 */
```

### 错误处理
- 所有工具错误必须包装为 `ToolResult { ok: false, error: string }`
- 不让异常向上冒泡炸掉主循环
- 安全相关错误使用 `SecurityError`
- 参数校验错误使用 `ValidationError`

### 依赖注入
- 通过构造函数注入依赖（Logger、SecurityGuard、Config）
- 通过 ToolContext 注入执行器
- 避免工具直接 import 执行器

## 测试约定

### 测试文件命名
- 单元测试：`src/**/*.test.ts`
- 集成测试：`test-*.js`（项目根目录）

### 当前测试覆盖
- ✅ test-mock.ts（Mock LLM 测试）
- ✅ test-fs-tools.js（文件系统工具集成测试）
