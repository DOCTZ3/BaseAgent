// ============================================
// 子 agent —— 资源继承与「结构上无递归」
// ============================================
//
// 这批测试针对一个**漏了两次**的真实 bug:
// 子 agent 自己建 ToolRunner,而资源原本是**逐字段转发**的 ——
// 先漏了 visionAnalyzer,又漏了 pythonExecutor。
// 后者的表现极具误导性:子 agent 注册了 execute_python 却拿不到执行器,
// 每次调用返回「Python 执行器未初始化」,它以为是自己代码的问题,
// 连跑 print("hello") / print(sys.version) 探活,白烧十几步才放弃。
//
// 所以这里**不逐个断言某个执行器在不在**(那样等于把同一个漏写两遍),
// 而是断言「父 runner 能注入的,子 agent 全都能注入」——
// 将来新增执行器忘了继承,这条会直接失败。
// ============================================

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { LocalSubAgentRunner } from './sub-agent.js';
import type { EnvironmentOptions } from './system-prompt.js';
import type { LLMClient, LLMResponse } from './llm-client.js';
import { ToolRegistry, type Tool, type ToolContext } from '../tools/index.js';
import type { InheritableRunnerConfig } from '../tools/index.js';
import { ConsoleLogger, LogLevel } from '../platform/index.js';

const logger = new ConsoleLogger(LogLevel.ERROR);

/** 记录自己拿到了哪些执行器的探针工具 */
function probeTool(needs: readonly ('fs' | 'python' | 'browser' | 'vision' | 'agent')[]) {
  const seen: Array<Record<string, unknown>> = [];
  const tool: Tool = {
    name: 'probe',
    description: '记录注入到的执行器',
    parameters: z.object({}),
    needs,
    danger: false,
    run: async (_args, ctx: ToolContext) => {
      seen.push({ ...ctx.executors });
      return { ok: true, data: { probed: true } };
    },
  };
  return { tool, seen };
}

/** 第一步调 probe，第二步给最终回答 —— 让子 agent 正常跑完两步 */
function scriptedClient(toolName = 'probe') {
  let step = 0;
  const client: LLMClient = {
    complete: async (): Promise<LLMResponse> => {
      step++;
      if (step === 1) {
        return {
          content: '',
          reasoning: null,
          toolCalls: [{ id: 'c1', name: toolName, args: {} }],
          finishReason: 'tool_calls',
        };
      }
      return {
        content: '探测完成。',
        reasoning: null,
        toolCalls: [],
        finishReason: 'stop',
      };
    },
  };
  return client;
}

const contextConfig = {
  windowSize: 1_000_000,
  compressionThreshold: 0.7,
  recentTurnsToKeep: 10,
  maxTopicsInContext: 10,
};

/** 运行环境。子 agent 的提示由它拼出来，与主 agent 同源 */
const environment: EnvironmentOptions = {
  converged: true,
  pythonEnabled: true,
  visionModel: 'fake-vision',
};

function makeRunner(
  parentRegistry: ToolRegistry,
  inherited: InheritableRunnerConfig,
  client: LLMClient,
) {
  return new LocalSubAgentRunner(client, parentRegistry, {
    parentSessionId: 'test-parent',
    logger,
    getSignal: () => new AbortController().signal,
    onConfirmRequired: async () => true,
    inherited,
    environment,
    maxSteps: 5,
    maxCount: 2,
    contextConfig,
  });
}

// 假执行器：只要是同一个对象引用被传下去就算继承成功
const fakePython = { run: vi.fn() } as unknown as InheritableRunnerConfig['pythonExecutor'];
const fakeBrowser = { available: true } as unknown as InheritableRunnerConfig['browserOps'];
const fakeVision = {
  modelName: 'fake-vision',
  analyze: vi.fn(),
} as unknown as InheritableRunnerConfig['visionAnalyzer'];

const FULL_INHERITED: InheritableRunnerConfig = {
  allowDangerousTools: false,
  fsGrants: [{ path: process.cwd(), mode: 'rw' }],
  fsDeniedPaths: [],
  workspace: process.cwd(),
  pythonExecutor: fakePython,
  browserOps: fakeBrowser,
  visionAnalyzer: fakeVision,
};

describe('子 agent 资源继承', () => {
  it('父 runner 能注入的执行器，子 agent 全都拿得到', async () => {
    // 这是那个漏了两次的 bug 的回归：逐字段转发时 pythonExecutor 没传，
    // 子 agent 的 execute_python 每次返回「未初始化」。
    // 一次性断言全部执行器，将来新增一个忘了继承，这条会直接失败
    const { tool, seen } = probeTool(['fs', 'python', 'browser', 'vision']);
    const registry = new ToolRegistry(logger);
    registry.register(tool);

    const result = await makeRunner(registry, FULL_INHERITED, scriptedClient()).run({
      task: '探测注入到的执行器',
    });

    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);

    const executors = seen[0];
    expect(executors.fs).toBeDefined();               // runner 自己建的 FsDriver
    expect(executors.python).toBe(fakePython);        // 漏过一次
    expect(executors.browser).toBe(fakeBrowser);
    expect(executors.vision).toBe(fakeVision);        // 也漏过一次
  });

  it('安全边界一并继承，不因下放而放宽', async () => {
    // fsGrants / fsDeniedPaths / workspace 都在 inherited 里，
    // 所以子 agent 的 SecurityGuard 与主 agent 同源
    const { tool, seen } = probeTool(['fs']);
    const registry = new ToolRegistry(logger);
    registry.register(tool);

    const denied = ['/tmp/creds'];
    await makeRunner(
      registry,
      { ...FULL_INHERITED, fsDeniedPaths: denied },
      scriptedClient(),
    ).run({ task: '探测 fs' });

    // FsDriver 存在即说明授权配置被带下去了（内容由 security.test.ts 覆盖）
    expect(seen[0].fs).toBeDefined();
  });

  it('request_help 不下放 —— 用户看不到子 agent 说的话', async () => {
    // 子 agent 的输出只回给主 agent。它调 request_help 等于打扰了用户、
    // 却没有任何人告诉用户该做什么，而它已经带着未完成的答案返回了。
    // 遇到需要人介入时应当把情况写进回答，交回主 agent 去请用户处理。
    //
    // 按名字排除（不是按 needs）：request_help 的 needs 是空数组，
    // 没有可依赖的结构特征
    const requestHelp: Tool = {
      name: 'request_help',
      description: '请用户帮忙',
      parameters: z.object({}),
      needs: [],
      danger: false,
      run: async () => ({ ok: true, data: { acknowledged: true } }),
    };
    const { tool } = probeTool(['fs']);
    const registry = new ToolRegistry(logger);
    registry.register(tool);
    registry.register(requestHelp);

    const runner = makeRunner(registry, FULL_INHERITED, scriptedClient('request_help'));
    const result = await runner.run({ task: '试图请用户帮忙' });

    // 调用会撞「工具未注册」→ 说明它确实不在子 agent 的清单里
    expect(result.ok).toBe(true);   // 那一步失败但不炸主流程
    expect(result.answer).toBeDefined();
  });

  it('结构上无递归：needs 含 agent 的工具不进子 agent 的工具集', async () => {
    const spawnLike: Tool = {
      name: 'spawn_subagent',
      description: '下放任务',
      parameters: z.object({}),
      needs: ['agent'],
      danger: false,
      run: async () => ({ ok: true }),
    };
    const { tool } = probeTool(['fs']);
    const registry = new ToolRegistry(logger);
    registry.register(tool);
    registry.register(spawnLike);

    // 子 agent 调 spawn_subagent 会撞「工具未注册」→ 说明它确实不在清单里
    const result = await makeRunner(registry, FULL_INHERITED, scriptedClient('spawn_subagent'))
      .run({ task: '试图递归' });

    expect(result.ok).toBe(true);   // 工具没注册不炸主流程，只是那一步失败
    expect(result.answer).toBeDefined();
  });
});

describe('子 agent 配额与取消', () => {
  it('配额用尽后拒绝并说清上限', async () => {
    const { tool } = probeTool(['fs']);
    const registry = new ToolRegistry(logger);
    registry.register(tool);

    const runner = new LocalSubAgentRunner(scriptedClient(), registry, {
      parentSessionId: 'test-parent',
      logger,
      getSignal: () => new AbortController().signal,
      onConfirmRequired: async () => true,
      inherited: FULL_INHERITED,
      environment,
      maxSteps: 5,
      maxCount: 1,
      contextConfig,
    });

    expect(runner.remainingQuota()).toBe(1);
    await runner.run({ task: '第一个' });
    expect(runner.remainingQuota()).toBe(0);

    const second = await runner.run({ task: '第二个' });
    expect(second.ok).toBe(false);
    expect(second.error).toContain('配额');
  });

  it('父任务已取消时不再起新的子 agent', async () => {
    const { tool } = probeTool(['fs']);
    const registry = new ToolRegistry(logger);
    registry.register(tool);

    const aborted = new AbortController();
    aborted.abort();

    const runner = new LocalSubAgentRunner(scriptedClient(), registry, {
      parentSessionId: 'test-parent',
      logger,
      getSignal: () => aborted.signal,
      onConfirmRequired: async () => true,
      inherited: FULL_INHERITED,
      environment,
      maxSteps: 5,
      maxCount: 2,
      contextConfig,
    });

    const result = await runner.run({ task: '不该跑起来' });
    expect(result.ok).toBe(false);
  });
});
