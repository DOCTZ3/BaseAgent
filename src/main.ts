// ============================================
// BaseAgent 主入口:组装所有模块
// ============================================

import 'dotenv/config';   // ← 第一行加载 .env，后面所有 process.env 才能读到

import {
  ConsoleLogger,
  LogLevel,
  loadConfig,
} from './platform/index.js';
import { ToolRegistry, ToolRunner } from './tools/index.js';
import { DeepSeekAdapter, Orchestrator } from './core/index.js';
import {
  EchoTool,
  GetCurrentTimeTool,
  ReadFileTool,
  ListFilesTool,
  SearchFilesTool,
  WriteFileTool,
} from './tools/builtin/index.js';

async function main() {
  // ① 加载配置(全部从环境变量读,有默认值兜底)
  const config = loadConfig();

  // ② 初始化 Logger
  const logLevel = ({
    debug: LogLevel.DEBUG,
    info:  LogLevel.INFO,
    warn:  LogLevel.WARN,
    error: LogLevel.ERROR,
  } as const)[config.logLevel] ?? LogLevel.INFO;

  const logger = new ConsoleLogger(logLevel);

  // 使用主模型配置
  const modelConfig = config.models.main;
  logger.info('BaseAgent 启动', {
    model: modelConfig.model,
    enableThinking: modelConfig.enableThinking
  });

  if (!modelConfig.apiKey) {
    logger.warn('未设置 DEEPSEEK_API_KEY，调用真实 API 会失败');
  }

  // ③ 注册工具
  const registry = new ToolRegistry(logger);
  registry.register(new EchoTool());
  registry.register(new GetCurrentTimeTool());
  registry.register(new ReadFileTool());
  registry.register(new ListFilesTool());
  registry.register(new SearchFilesTool());
  registry.register(new WriteFileTool());

  // ④ 创建 Runner
  const abortController = new AbortController();
  const runner = new ToolRunner(registry, {
    sessionId: 'session-001',
    logger,
    signal: abortController.signal,
    onConfirmRequired: async (req) => {
      logger.warn(`需要确认: ${req.reason}`, { tool: req.toolName });
      return true; // 测试阶段自动批准，后续接 CLI 交互
    },
    allowDangerousTools: config.security.allowDangerousTools,
    fsSandboxPaths:      config.security.fsSandboxPaths,
  });

  // ⑤ 创建 LLM Client
  const llmClient = new DeepSeekAdapter({
    apiKey:  modelConfig.apiKey,
    baseURL: modelConfig.baseURL!,
    model:   modelConfig.model,
    enableThinking: modelConfig.enableThinking ?? true, // 默认开启
    logger,
  });

  // ⑥ 创建 Orchestrator
  const orchestrator = new Orchestrator(llmClient, runner, registry, {
    maxSteps: config.execution.maxSteps,
    logger,
  });

  // ⑦ 测试任务
  const result = await orchestrator.run([
    {
      role: 'system',
      content: '你是一个 AI 助手，可以使用工具来完成任务。',
    },
    {
      role: 'user',
      content: '请告诉我现在的时间，然后用 echo 工具回显 "Hello BaseAgent"',
    },
  ]);

  logger.info('任务结果', { result });
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

