// ============================================
// 本轮工具活动量 —— skill 沉淀的准入判据
// ============================================
//
// 判据是「这一轮是否经历了 8 步工具调用,或出现过工具失败」。
// 两个数的粒度不同,而**混淆粒度是这里唯一的失败模式**,并且它不报错:
//
// ① 一步里模型可以并发声明多个 tool_calls。按「每个工具调用记一次」计步,
//    一步并发三个工具就算成 3 —— 8 步门槛两三步就被撞上,
//    于是每个稍微复杂的任务都触发沉淀,库里灌满垃圾。
// ② 反过来,把失败数按步记(一步只记一次),会漏掉「一步里三个工具全挂了」
//    这种最该被沉淀的情况。
//
// 所以 toolSteps 一步一次、toolFails 按次累加,由 orchestrator 分别推进来 ——
// ContextManager 自己数不出来:addToolResult 每个工具调用都会被调一次,
// 而 ok 到那一层已经是 JSON.stringify 之后的字符串。
// ============================================

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { ContextManager } from './context.js';
import { Orchestrator } from './orchestrator.js';
import type { LLMClient, LLMResponse } from './llm-client.js';
import { ToolRegistry, ToolRunner, type Tool } from '../tools/index.js';
import { ConsoleLogger, LogLevel } from '../platform/index.js';

const logger = new ConsoleLogger(LogLevel.ERROR);

function makeContext() {
  return new ContextManager(
    {
      sessionId: `ta-${Math.random().toString(36).slice(2, 8)}`,
      windowSize: 1_000_000,
      compressionThreshold: 0.7,
      recentTurnsToKeep: 10,
      maxTopicsInContext: 10,
      logger,
    },
    { complete: vi.fn() } as never,
  );
}

describe('ContextManager 的计数与清零', () => {
  it('recordToolStep 一次记一步,失败数按传入值累加', () => {
    const ctx = makeContext();

    ctx.recordToolStep(0);
    ctx.recordToolStep(2);   // 这一步里有两个工具调用失败
    ctx.recordToolStep(1);

    const s = ctx.getStats().currentTurn;
    expect(s.toolSteps).toBe(3);   // 步数与失败数无关
    expect(s.toolFails).toBe(3);
  });

  it('统计单开一层 —— 与会话累计项不混在一起', () => {
    // 混在同一层将来一定有人读错:把「本轮 8 步」当成「整个会话 8 步」,
    // 而那不报错,只是沉淀在该触发时不触发
    const ctx = makeContext();
    ctx.recordToolStep(0);

    const stats = ctx.getStats();
    expect(stats.currentTurn.toolSteps).toBe(1);
    // 累计项仍在顶层
    expect(stats).toHaveProperty('compressions');
    expect(stats).toHaveProperty('tokens');
    expect(stats).not.toHaveProperty('toolSteps');
  });

  it('addUserMessage 清零 —— 不清会跨轮累加', async () => {
    const ctx = makeContext();
    await ctx.addUserMessage('第一轮');
    ctx.recordToolStep(1);
    ctx.recordToolStep(0);
    ctx.addFinalResponse('答案');

    expect(ctx.getStats().currentTurn.toolSteps).toBe(2);

    await ctx.addUserMessage('第二轮');
    const s = ctx.getStats().currentTurn;
    expect(s.toolSteps).toBe(0);
    expect(s.toolFails).toBe(0);
  });

  it('discardCurrentTurn 也清零 —— 否则被丢弃的六步会算进下一轮', async () => {
    // 用户中断一个跑了六步的任务,如果计数不清,
    // 下一个两步的任务会凭空够 8 步的门槛
    const ctx = makeContext();
    await ctx.addUserMessage('会被中断的任务');
    for (let i = 0; i < 6; i++) ctx.recordToolStep(0);
    ctx.addAssistantMessage('查一半', [{ id: 'c1', name: 'f', args: {} }]);

    expect(ctx.getStats().currentTurn.toolSteps).toBe(6);

    ctx.discardCurrentTurn();
    expect(ctx.getStats().currentTurn.toolSteps).toBe(0);
  });
});

// ---------- orchestrator 层:粒度是否正确 ----------

/** 一个必定失败的工具 */
function failingTool(name = 'boom'): Tool {
  return {
    name,
    description: '总是失败',
    parameters: z.object({}),
    needs: [],
    danger: false,
    run: async () => ({ ok: false, error: '故意失败' }),
  };
}

/** 一个必定成功的工具 */
function okTool(name = 'noop'): Tool {
  return {
    name,
    description: '总是成功',
    parameters: z.object({}),
    needs: [],
    danger: false,
    run: async () => ({ ok: true, data: { done: true } }),
  };
}

/**
 * 脚本化客户端:先按 plan 逐步返回 tool_calls,用完之后给最终答案
 *
 * @param plan 每一项是这一步要声明的工具名数组（可多个 = 并发声明）
 */
function scriptedClient(plan: string[][]): LLMClient {
  let step = 0;
  return {
    async complete(): Promise<LLMResponse> {
      const names = plan[step++];
      if (!names) {
        return { content: '做完了', reasoning: null, toolCalls: [], finishReason: 'stop' };
      }
      return {
        content: '',
        reasoning: null,
        toolCalls: names.map((n, i) => ({ id: `c${step}_${i}`, name: n, args: {} })),
        finishReason: 'tool_calls',
      };
    },
  };
}

function runWith(plan: string[][], tools: Tool[]) {
  const ctx = makeContext();
  const registry = new ToolRegistry(logger);
  for (const t of tools) registry.register(t);

  const runner = new ToolRunner(registry, {
    sessionId: 'ta-orch',
    logger,
    getSignal: () => new AbortController().signal,
    onConfirmRequired: async () => true,
    allowDangerousTools: false,
    fsGrants: [],
  });

  const orchestrator = new Orchestrator(scriptedClient(plan), runner, registry, {
    maxSteps: 20,
    logger,
    context: ctx,
  });

  return { ctx, orchestrator };
}

describe('orchestrator 推进来的粒度', () => {
  it('**一步并发三个工具只算一步** —— 这是 8 步门槛的全部前提', async () => {
    // 按「每个工具调用记一次」的话这里会得到 3,
    // 于是一个三步的任务就顶到 9 步、凭空够格
    const { ctx, orchestrator } = runWith([['noop', 'noop', 'noop']], [okTool()]);
    await orchestrator.run([{ role: 'user', content: 'q' }]);

    expect(ctx.getStats().currentTurn.toolSteps).toBe(1);
  });

  it('失败数按**每次工具调用**累加 —— 一步里三个全挂要记 3', async () => {
    const { ctx, orchestrator } = runWith([['boom', 'boom', 'boom']], [failingTool()]);
    await orchestrator.run([{ role: 'user', content: 'q' }]);

    const s = ctx.getStats().currentTurn;
    expect(s.toolSteps).toBe(1);
    expect(s.toolFails).toBe(3);
  });

  it('多步累加,成功的步不计失败', async () => {
    const { ctx, orchestrator } = runWith(
      [['noop'], ['boom'], ['noop'], ['noop']],
      [okTool(), failingTool()],
    );
    await orchestrator.run([{ role: 'user', content: 'q' }]);

    const s = ctx.getStats().currentTurn;
    expect(s.toolSteps).toBe(4);
    expect(s.toolFails).toBe(1);
  });

  it('不调工具直接回答的轮次两个数都是 0 —— 不该触发沉淀', async () => {
    const { ctx, orchestrator } = runWith([], [okTool()]);
    await orchestrator.run([{ role: 'user', content: 'q' }]);

    const s = ctx.getStats().currentTurn;
    expect(s.toolSteps).toBe(0);
    expect(s.toolFails).toBe(0);
  });

  it('跑到 8 步时判据成立 —— 门槛本身可达', async () => {
    // 这条盯的是「配了但永远达不到」那类问题(CONTEXT_RECENT_TURNS=10 就是
    // 这么形同虚设的)。8 步在一次普通任务里确实能达到
    const plan = Array.from({ length: 8 }, () => ['noop']);
    const { ctx, orchestrator } = runWith(plan, [okTool()]);
    await orchestrator.run([{ role: 'user', content: 'q' }]);

    expect(ctx.getStats().currentTurn.toolSteps).toBeGreaterThanOrEqual(8);
  });
});
