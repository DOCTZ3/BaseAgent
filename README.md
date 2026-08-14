# BaseAgent

一个基于 DeepSeek 的模块化 AI Agent 框架。

## 架构

- **platform**: 基础设施(logger / config / errors / storage)
- **tools**: 工具层(契约 / 注册表 / runner)
- **core**: 内核层(llm-client / orchestrator)
- **executors**: 执行器层(文件系统 / 浏览器等,待实现)
- **interaction**: 交互层(待实现)

## 快速开始

```bash
# 安装依赖
npm install

# 设置 API Key
export DEEPSEEK_API_KEY=your_key_here

# 构建
npm run build

# 运行
npm start

# 开发模式(带热重载)
npm run dev
```

## 当前状态

✅ 阶段 1 已完成:
- Platform 层基础设施
- Tools 三件套(契约 / 注册表 / runner)
- Core 层(DeepSeekAdapter / Orchestrator 主循环)
- 内置工具示例(echo / get_current_time)
- 最小闭环可运行

🚧 待实现:
- 执行器层(fs / browser / http)
- 三档执行模式(直接回答 / tool_call / code 模式)
- 多维意图识别
- 上下文管理与压缩
- 子 Agent 支持
- 交互层(CLI / API)

## 设计文档

详见 [agent-architecture.md](./agent-architecture.md)
