# BaseAgent

BaseAgent 是一个面向 PC 本地环境的通用 Agent 宿主。它用自然语言驱动模型,
再由模型通过工具、Python 代码、浏览器和子 agent 完成任务。

项目当前重点已经从“补功能”转向“稳定架构与修 bug”:核心链路已经跑通,
后续新增能力应当先确认是否真的属于架构层需求。

## 核心架构

整体依赖方向是:

```text
interface -> core -> tools -> executors -> platform
```

- `interface/`:交互壳。当前正式入口是 Electron 客户端。壳只负责输入、展示、
  确认与配置,不重新装配 agent。
- `core/`:Agent 内核。`session.ts` 是唯一装配中心,负责把 LLM、工具、执行器、
  上下文、记忆、技能和浏览器接到一起。
- `tools/`:工具契约、注册表与调用管线。工具声明 `needs`,由 runner 注入资源。
- `executors/`:真实资源执行层,包括文件系统、Python、Shell、浏览器、工具桥等。
- `platform/`:日志、配置、安全检查、重试、留痕和 SQLite 存储。

详细设计见 [agent-architecture.md](./agent-architecture.md),踩坑复盘见
[pitfalls.md](./pitfalls.md)。

## 当前能力

- ReAct 主循环,支持工具调用、流式事件、步数上限收尾、用户中断和截断归因。
- 上下文管理:按 Turn 记录、token 水位触发压缩、旧轮次归档供模型回溯。
- 文件工具:`read_file` / `search_files` 等,带授权范围和返回量控制。
- CodeAct:通过 `execute_python` 执行 Python,浏览器/数据处理/文件写入主要走代码。
- 常驻 Chromium:框架启动浏览器并通过 CDP 供 Python 连接,保留登录态和页面状态。
- 视觉插件:配置 `VISION_MODEL` 后,图片交给视觉模型分析,主模型只接收文字观察。
- 子 agent:用于大上下文子任务,独立上下文运行,只把结论回传主 agent。
- 长期记忆:提取跨会话的用户偏好和稳定特征。
- 技能库:从复杂任务轨迹中异步沉淀可复用做法,人工审批后进入索引。
- Electron 客户端:历史会话、配置面板、危险命令确认、技能审批、Markdown 渲染。

## 安全边界

BaseAgent 是本地工具,代码和命令以当前 OS 用户身份运行。它不是强隔离沙箱。

当前边界主要包括:

- 工作区是文件工具读写授权范围,也是 Python 的 cwd 与写边界来源。
- Python 写操作通过 audit hook 限制在工作区和临时目录;读侧只拦凭证类路径。
- `.env`、浏览器 profile、私钥、云凭证、token 文件等在读黑名单内。
- Python 子进程只继承环境变量白名单,不会直接拿到模型 API key。
- 代码里默认禁止 `pip install`;装包等外部程序操作走 `run_command`。
- `run_command` 没有机制边界,每次执行前必须由用户确认原样命令。

已知缺口与历史事故记录在 [pitfalls.md](./pitfalls.md)。

## 运行入口

```bash
npm install
npm run build
```

主要入口:

```bash
npm run app
```

启动 Electron 客户端,这是目前主要使用入口。

```bash
npm start
```

运行 `dist/main.js` 的最小非交互入口。这个入口没有人在场确认危险操作,
因此一律拒绝危险工具。

验证:

```bash
npm test
npm run typecheck
```

注意:Vitest 走 esbuild,不做 TypeScript 类型检查,所以 `npm test` 和
`npm run typecheck` 都要分别看。

Electron 原生依赖重编:

```bash
npm run rebuild:native
```

当 Electron 运行时报 `better-sqlite3` ABI 不匹配时使用。

## Windows 打包

当前已接入 `electron-builder`,先以 Windows 为主支持平台。

```bash
npm run pack:win
```

生成可直接运行的目录包:

```text
release/win-unpacked/BaseAgent.exe
```

这个产物适合本机烟测,也可以把整个 `win-unpacked` 目录拷到另一台 Windows
机器上试用。不要只拷贝单个 `BaseAgent.exe`,它依赖旁边的 `resources/` 和
运行时 DLL。

```bash
npm run dist:win
```

默认生成 portable 单文件:

```text
release/BaseAgent 0.1.0.exe
```

也可以显式运行:

```bash
npm run dist:win:portable
npm run dist:win:installer
```

安装包产物:

```text
release/BaseAgent Setup 0.1.0.exe
```

portable / installer 首次构建需要下载 electron-builder 的辅助二进制;下载完成后会走本地缓存。

打包后的用户数据写到系统用户目录,不会写进安装目录:

- 配置: `%APPDATA%/BaseAgent/config.json`
- 历史与 trace: `%APPDATA%/BaseAgent/traces`
- 记忆与技能库: `%APPDATA%/BaseAgent/agent-memory.db`
- Python venv: `%APPDATA%/BaseAgent/sandbox-venv`
- 浏览器 profile: `%APPDATA%/BaseAgent/browser-profile`

这个目录也会显示在客户端配置抽屉的“本机数据”里,可直接点“打开”。

## 配置

`.env` 仍可作为配置回落来源。Electron 客户端的配置面板会把用户配置写到系统用户配置目录,
不会写回项目根目录的 `.env`。

最少需要配置:

- `DEEPSEEK_API_KEY`:主模型 API key。
- `WORKSPACE`:允许 agent 操作的工作区目录。

常用开关:

- `PYTHON_ENABLED=true`:启用 `execute_python`。
- `VISION_MODEL=...`:启用视觉插件。
- `SHELL_ENABLED=true` + `ALLOW_DANGEROUS_TOOLS=true`:启用外部命令通道。
- `MAIN_MAX_TOKENS=...`:控制单次生成上限,也会作为记忆/技能抽取的默认预算来源。

更完整的配置说明见 [.env.example](./.env.example)。

## 开发提示

- 修改代码后同步检查 [agent-architecture.md](./agent-architecture.md):它只写架构事实、
  核心接口和设计决策,实现细节留在代码顶部注释。
- 不要在两处手写同一份事实。这个项目多次踩过配置、资源转发和提示词漂移的问题。
- 不要读取或打印任何 API key、cookie、浏览器 profile 或其他凭证内容。
