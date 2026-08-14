// ============================================
// 测试脚本:使用 Mock LLM 验证完整流程
// ============================================

import {
  ConsoleLogger,
  LogLevel,
  loadConfig,
} from './platform/index.js';
import { ToolRegistry, ToolRunner } from './tools/index.js';
import { MockLLMClient, Orchestrator } from './core/index.js';
import { EchoTool, GetCurrentTimeTool } from './tools/builtin/index.js';

async function testRun() {
  console.log('========================================');
  console.log('BaseAgent 测试运行(Mock LLM)');
  console.log('========================================\n');

  // ① 初始化 Logger
  const logger = new ConsoleLogger(LogLevel.INFO);

  // ② 注册工具
  const registry = new ToolRegistry(logger);
  registry.register(new EchoTool());
  registry.register(new GetCurrentTimeTool());

  logger.info('已注册工具', { count: registry.all().length });

  // ③ 创建 Runner
  const abortController = new AbortController();
  const runner = new ToolRunner(registry, {
    sessionId: 'test-session-mock',
    logger,
    signal: abortController.signal,
    onConfirmRequired: async (req) => {
      logger.warn(`需要确认: ${req.reason}`, { tool: req.toolName });
      return true;
    },
    allowDangerousTools: false,
    fsSandboxPaths: [],
  });

  // ④ 创建 Mock LLM Client
  const llmClient = new MockLLMClient(logger);

  // ⑤ 创建 Orchestrator
  const orchestrator = new Orchestrator(llmClient, runner, registry, {
    maxSteps: 10,
    logger,
  });

  // ⑥ 运行测试任务
  console.log('\n--- 开始执行任务 ---\n');
  const result = await orchestrator.run([
    {
      role: 'system',
      content: '你是一个 AI 助手,可以使用工具来完成任务。',
    },
    {
      role: 'user',
      content: '请告诉我现在的时间,然后用 echo 工具回显"Hello BaseAgent"',
    },
  ]);

  console.log('\n--- 任务完成 ---\n');
  console.log('最终结果:');
  console.log(JSON.stringify(result, null, 2));
  console.log('\n========================================');
  console.log('✅ 最小闭环验证通过!');
  console.log('========================================');
}

testRun().catch(error => {
  console.error('\n❌ 测试失败:', error);
  process.exit(1);
});
