// ============================================
// 测试文件系统工具
// ============================================

import 'dotenv/config';
import {
  ConsoleLogger,
  LogLevel,
  loadConfig,
} from './dist/platform/index.js';
import { ToolRegistry, ToolRunner } from './dist/tools/index.js';
import { DeepSeekAdapter, Orchestrator } from './dist/core/index.js';
import {
  EchoTool,
  GetCurrentTimeTool,
  ReadFileTool,
  ListFilesTool,
  SearchFilesTool,
  WriteFileTool,
} from './dist/tools/builtin/index.js';

async function main() {
  const config = loadConfig({
    model: {
      provider: 'deepseek',
      apiKey:   process.env.DEEPSEEK_API_KEY  || '',
      baseURL:  process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
      model:    process.env.DEEPSEEK_MODEL    || 'deepseek-chat',
      temperature: 0.7,
    },
    execution: {
      maxSteps: Number(process.env.MAX_STEPS)  || 10,
      timeout:  Number(process.env.TIMEOUT_MS) || 60000,
    },
    logLevel: 'info',
    security: {
      // 允许访问当前项目目录
      fsSandboxPaths: [process.cwd()],
      allowDangerousTools: true,  // 允许写文件测试
    },
  });

  const logger = new ConsoleLogger(LogLevel.INFO);
  const registry = new ToolRegistry(logger);

  // 注册所有工具
  registry.register(new EchoTool());
  registry.register(new GetCurrentTimeTool());
  registry.register(new ReadFileTool());
  registry.register(new ListFilesTool());
  registry.register(new SearchFilesTool());
  registry.register(new WriteFileTool());

  const abortController = new AbortController();
  const runner = new ToolRunner(registry, {
    sessionId: 'test-fs-session',
    logger,
    signal: abortController.signal,
    onConfirmRequired: async (req) => {
      logger.warn(`需要确认: ${req.reason}`, { tool: req.toolName, args: req.args });
      return true;
    },
    allowDangerousTools: config.security.allowDangerousTools,
    fsSandboxPaths:      config.security.fsSandboxPaths,
  });

  const llmClient = new DeepSeekAdapter({
    apiKey:  config.model.apiKey,
    baseURL: config.model.baseURL,
    model:   config.model.model,
    logger,
  });

  const orchestrator = new Orchestrator(llmClient, runner, registry, {
    maxSteps: config.execution.maxSteps,
    logger,
  });

  // 测试任务:读取 package.json 并搜索 .ts 文件
  const result = await orchestrator.run([
    {
      role: 'system',
      content: '你是一个 AI 助手，可以使用工具来完成任务。当前可用工具包括文件系统操作工具。',
    },
    {
      role: 'user',
      content: '请执行以下任务:该文件夹下是否有python文件',
    },
  ]);

  logger.info('=== 测试完成 ===');
  logger.info('最终结果', { result });
}

main().catch(error => {
  console.error('测试失败:', error);
  process.exit(1);
});
