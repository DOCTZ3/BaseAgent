// ============================================
// 生成预算(max_tokens / temperature)—— 一个**死配置**的回归测试
// ============================================
//
// 实测事故:MAIN_MAX_TOKENS 配了等于没配。
// adapter 里写的是 `max_tokens: request.maxTokens`,靠**每个调用方自己传**,
// 而 orchestrator 那两处 complete() 都没传 —— 于是主循环的请求体里
// max_tokens 恒为 undefined。trace 实证:配了 256,某次输出仍有
// 14485 个 completion token(既超了 256,也超了 .env 里的 10000)。
// temperature 是同一个洞。
//
// 这是本项目栽过四次的同一个形状:models.vision 被 loadConfig 丢掉、
// 新增顶层配置段忘了合并、fsGrants 不跟随 workspace,以及这一次。
// 共性是**逐字段转发**,而漏掉的那一份不报错。
// 所以这批测试断言的是「配置到达线格式请求体」这条链本身,
// 而不是某个调用点记得传没传。
//
// 另一半是被截断之后的表现:finishReason='length' 原先**没人看** ——
// 被截断的回答有正文、无工具调用,与正常回答完全同形,于是走 complete
// 通道返回,用户只看到「话说到一半就没了」,没有任何东西指向 max_tokens。
// ============================================

import { describe, it, expect } from 'vitest';
import { DeepSeekAdapter } from './deepseek-adapter.js';
import { Orchestrator } from './orchestrator.js';
import type { LLMClient, LLMRequest, LLMResponse } from './llm-client.js';
import { ToolRegistry, ToolRunner } from '../tools/index.js';
import { ConsoleLogger, LogLevel } from '../platform/index.js';

const logger = new ConsoleLogger(LogLevel.ERROR);

// ---------- 线格式请求体的探针 ----------
//
// 不打真实网络:构造 adapter 后替换掉它内部的 openai 客户端,
// 把 create() 收到的参数原样记下来。断言的是**发出去的那一份**,
// 而不是我们以为自己发了什么 —— 那正是这个 bug 藏身的地方。
function adapterProbe(cfg: { maxTokens?: number; temperature?: number }) {
  const seen: Array<Record<string, any>> = [];

  const adapter = new DeepSeekAdapter({
    apiKey: 'sk-test',
    baseURL: 'https://example.invalid',
    model: 'test-model',
    enableThinking: false,
    maxTokens: cfg.maxTokens,
    temperature: cfg.temperature,
    logger,
  });

  (adapter as any).client = {
    chat: {
      completions: {
        create: async (body: Record<string, any>) => {
          seen.push(body);
          return {
            choices: [{ message: { content: '好', tool_calls: undefined }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
        },
      },
    },
  };

  return { adapter, seen };
}

describe('模型配置到达线格式请求体', () => {
  it('adapter 上配的 maxTokens 进入 max_tokens —— 调用方不必记得传', async () => {
    const { adapter, seen } = adapterProbe({ maxTokens: 256 });

    // 刻意**不传** maxTokens,模拟 orchestrator 的调用方式
    await adapter.complete({ messages: [{ role: 'user', content: 'hi' }] });

    expect(seen[0].max_tokens).toBe(256);
  });

  it('adapter 上配的 temperature 同样进入请求体', async () => {
    const { adapter, seen } = adapterProbe({ temperature: 0.7 });
    await adapter.complete({ messages: [{ role: 'user', content: 'hi' }] });

    expect(seen[0].temperature).toBe(0.7);
  });

  it('temperature=0 不被当成「没配」—— 用 || 判断会静默回落到默认值', async () => {
    // 0 是合法值(要确定性输出时就填 0)。这条专门盯 ?? 与 || 的区别
    const { adapter, seen } = adapterProbe({ temperature: 0 });
    await adapter.complete({ messages: [{ role: 'user', content: 'hi' }] });

    expect(seen[0].temperature).toBe(0);
  });

  it('单发调用显式传的值优先 —— 压缩/记忆/视觉那三处不受影响', async () => {
    const { adapter, seen } = adapterProbe({ maxTokens: 256, temperature: 0.7 });

    await adapter.complete({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 4000,
      temperature: 0.3,
    });

    expect(seen[0].max_tokens).toBe(4000);
    expect(seen[0].temperature).toBe(0.3);
  });

  it('都没配时保持 undefined —— 不能兜成 0(那会让模型一个字都不输出)', async () => {
    const { adapter, seen } = adapterProbe({});
    await adapter.complete({ messages: [{ role: 'user', content: 'hi' }] });

    expect(seen[0].max_tokens).toBeUndefined();
    expect(seen[0].temperature).toBeUndefined();
  });
});

// ---------- 截断之后的表现 ----------

/** 固定返回一份响应的假客户端 */
function fixedClient(res: Partial<LLMResponse>): LLMClient {
  return {
    async complete(_req: LLMRequest): Promise<LLMResponse> {
      return {
        content: null,
        reasoning: null,
        toolCalls: [],
        finishReason: 'stop',
        ...res,
      };
    },
  };
}

function orchestratorWith(client: LLMClient) {
  const registry = new ToolRegistry(logger);
  // ToolRunner 只收两个参数(registry + config),logger 在 config 里 ——
  // 这几条用例根本不执行工具,给足必填字段即可
  const runner = new ToolRunner(registry, {
    sessionId: 'test-budget',
    logger,
    getSignal: () => new AbortController().signal,
    onConfirmRequired: async () => false,
    allowDangerousTools: false,
    fsGrants: [],
  });
  return new Orchestrator(client, runner, registry, { maxSteps: 5, logger });
}

describe('max_tokens 截断的归因', () => {
  it('有正文但被截断 → truncated,而不是 complete', async () => {
    // 这是整个 bug 的核心:被截断的回答与正常回答**同形**
    // (有内容、无工具调用),不区分的话用户只看到「话说到一半就没了」
    const o = orchestratorWith(fixedClient({ content: '答案说到一半', finishReason: 'length' }));
    const r = await o.run([{ role: 'user', content: 'q' }]);

    expect(r.stopReason).toBe('truncated');
    // 半截回答仍要原样返回 —— 丢掉等于让用户白等一轮
    expect(r.answer).toBe('答案说到一半');
  });

  it('无正文且被截断 → truncated,**不是** no_response', async () => {
    // 开着思维链且预算给小时,预算会被思维链吃光、content 为空。
    // 那时报「模型无有效响应」是错的归因:模型响应了,
    // 是我们没给它说完的余量 —— 两者的处置完全相反
    const o = orchestratorWith(fixedClient({ content: null, finishReason: 'length' }));
    const r = await o.run([{ role: 'user', content: 'q' }]);

    expect(r.stopReason).toBe('truncated');
    expect(r.answer).toContain('max_tokens');
  });

  it('正常收尾仍是 complete —— 没把所有结束都当成截断', async () => {
    const o = orchestratorWith(fixedClient({ content: '完整答案', finishReason: 'stop' }));
    const r = await o.run([{ role: 'user', content: 'q' }]);

    expect(r.stopReason).toBe('complete');
  });

  it('既无正文也没被截断 → no_response 保持原样', async () => {
    const o = orchestratorWith(fixedClient({ content: null, finishReason: 'stop' }));
    const r = await o.run([{ role: 'user', content: 'q' }]);

    expect(r.stopReason).toBe('no_response');
  });

  it('done 事件里带上 truncated —— 展示层靠它给出提示', async () => {
    const events: string[] = [];
    const o = orchestratorWith(fixedClient({ content: '半句', finishReason: 'length' }));

    await o.run([{ role: 'user', content: 'q' }], e => {
      if (e.type === 'done') events.push(e.stopReason);
    });

    expect(events).toEqual(['truncated']);
  });
});
