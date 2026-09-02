# BaseAgent

BaseAgent 是一个本地优先的桌面端 AI Agent 工作台，基于 TypeScript、Electron、
Node.js、Python 与 Playwright/CDP 构建。它为多步任务执行提供统一运行环境，
支持工具调用、Python CodeAct、浏览器自动化、长期记忆、技能沉淀与 trace 追踪。

这个项目的目标不是做一个简单聊天界面，而是探索一个可落地的本地 Agent
运行框架：模型负责规划和决策，框架负责上下文、工具、执行器、权限边界、
运行状态和桌面端交互。

## 项目亮点

- 本地优先的 Electron 桌面客户端，支持历史会话、配置面板、危险命令确认、
  技能审批与 Markdown 渲染。
- 采用 `orchestrator / session / tool registry / executor / platform` 分层架构，
  将模型决策、会话状态、工具注册、真实资源执行和平台能力解耦。
- 支持 Python CodeAct，模型可以通过 `execute_python` 完成数据处理、文件操作、
  浏览器控制等复杂任务。
- 内置常驻 Chromium，通过 CDP 供 Python/Playwright 连接，保留登录态、
  页面状态，并支持异常关闭后的检测与恢复。
- 提供长上下文管理能力，按 Turn 记录完整对话，并通过 token 水位触发压缩、
  归档和回溯。
- 支持长期记忆与技能库，从跨会话信息和复杂任务轨迹中沉淀可复用上下文。
- 提供 trace 追踪，记录模型请求、工具调用和关键运行状态，便于定位 Agent
  行为问题。
- 已接入 Electron 打包流程，可生成 Windows 目录包、portable 单文件和安装包。

## 架构概览

整体依赖方向保持单向流动：

```text
interface -> core -> tools -> executors -> platform
```

- `interface/`：交互层。当前正式入口是 Electron 客户端，负责输入、展示、
  配置、确认和审批。
- `core/`：Agent 内核。负责会话生命周期、主循环编排、上下文管理、记忆、
  技能沉淀和事件流。
- `tools/`：工具契约与注册表。工具声明自身依赖，由 runner 在调用时注入资源。
- `executors/`：真实资源执行层，包括 Python、Shell、浏览器、文件系统和工具桥。
- `platform/`：横切能力，包括配置、日志、trace、重试、安全检查和 SQLite 存储。

更完整的设计说明见 [agent-architecture.md](./agent-architecture.md)。工程实践和已知边界
记录在 [pitfalls.md](./pitfalls.md)。

## 功能能力

- 多轮 Agent 主循环：支持工具调用、流式事件、用户中断、步数上限和截断归因。
- 上下文管理：按 Turn 存储对话，支持长会话压缩和历史归档。
- 工具系统：提供文件读取、文件搜索、Python 执行、Shell 命令、视觉观察、
  skill 加载等工具能力。
- Python 执行器：支持输出上限、环境变量白名单、进程回收、pip 限制和写入边界。
- 浏览器自动化：框架托管有头 Chromium，模型代码通过 CDP 使用 Playwright 控制。
- 长期记忆：抽取跨会话稳定用户特征，并在后续会话中注入。
- 技能库：从复杂任务轨迹中异步抽取可复用做法，经人工审批后进入索引。
- 桌面端体验：提供配置抽屉、历史会话、技能审批、本机数据目录打开入口等界面能力。

## 快速开始

安装依赖并构建：

```bash
npm install
npm run build
```

启动 Electron 客户端：

```bash
npm run app
```

运行测试和类型检查：

```bash
npm test
npm run typecheck
```

如果 Electron 运行时出现 `better-sqlite3` ABI 不匹配，可以重新编译原生依赖：

```bash
npm run rebuild:native
```

## 配置

项目支持通过 `.env` 和 Electron 客户端配置面板配置运行参数。客户端面板写入的是
系统用户配置目录，不会回写项目根目录的 `.env`。

最少需要配置：

- `DEEPSEEK_API_KEY`：主模型 API key。
- `WORKSPACE`：允许 Agent 操作的工作区目录。

常用开关：

- `PYTHON_ENABLED=true`：启用 Python CodeAct。
- `VISION_MODEL=...`：启用视觉模型观察能力。
- `SHELL_ENABLED=true` + `ALLOW_DANGEROUS_TOOLS=true`：启用外部命令通道。
- `MAIN_MAX_TOKENS=...`：控制单次生成上限，也作为记忆和技能抽取的默认预算来源。

更完整的配置项见 [.env.example](./.env.example)。

## Windows 打包

项目已接入 `electron-builder`，当前主要面向 Windows 桌面端分发。

生成可直接运行的目录包：

```bash
npm run pack:win
```

产物位置：

```text
release/win-unpacked/BaseAgent.exe
```

目录包需要连同 `win-unpacked` 整个目录一起拷贝，不能只拷贝单个 `BaseAgent.exe`，
因为它依赖旁边的 `resources/` 和运行时 DLL。

生成 portable 单文件：

```bash
npm run dist:win:portable
```

生成安装包：

```bash
npm run dist:win:installer
```

默认完整打包命令：

```bash
npm run dist:win
```

打包后的用户数据写入系统用户目录，不写入安装目录：

- 配置：`%APPDATA%/BaseAgent/config.json`
- 历史与 trace：`%APPDATA%/BaseAgent/traces`
- 记忆与技能库：`%APPDATA%/BaseAgent/agent-memory.db`
- Python venv：`%APPDATA%/BaseAgent/sandbox-venv`
- 浏览器 profile：`%APPDATA%/BaseAgent/browser-profile`

客户端配置抽屉中的“本机数据”区域会显示该目录，并提供打开入口。

## 安全边界

BaseAgent 是本地运行工具，代码和命令以当前 OS 用户身份执行。它提供的是运行边界和
风险控制，不是强隔离沙箱。

当前边界包括：

- 工作区是文件工具读写授权范围，也是 Python 的默认工作目录和写入边界来源。
- Python 写操作通过 audit hook 限制在工作区和临时目录内。
- `.env`、浏览器 profile、私钥、云凭证、token 文件等凭证类路径在读黑名单内。
- Python 子进程只继承环境变量白名单，默认不会直接拿到模型 API key。
- 代码里默认禁止 `pip install`；安装依赖等外部程序操作需要通过命令通道并由用户确认。
- `run_command` 面向真实系统命令，执行前会展示原始命令并等待用户确认。

## 项目状态

当前项目已完成核心 Agent 运行链路、Electron 客户端、Python 执行器、浏览器管理、
记忆与技能库、trace 追踪和 Windows 打包支持。后续方向包括进一步增强跨平台打包、
执行隔离、插件化能力和更完整的端到端测试。
