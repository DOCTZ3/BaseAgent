// ============================================
// 中断(停止按钮)—— 四个**静默**性质
// ============================================
//
// 这个功能的每一种做错方式都不报错:
//
// ① **AbortController 一旦 abort 就永久失效**。会话级只建一个的话,
//    用户点过一次停止之后,后续每轮的请求都带着已中止的信号发出去 ——
//    表现成「点过一次停止,这个会话再也跑不了」,而且每步都是立刻返回,
//    看起来像模型不回话。所以下游一律拿 getSignal() **现取**。
//
// ② **中断不能落进重试分支**。中断抛的 APIUserAbortError 若被判为可重试,
//    点一次停止会打出三次新请求 —— 「越点停止越忙」,只有账单看得见。
//
// ③ **中断不是失败**。包成 LLMError 的话界面标红、日志报 error,
//    而用户只是点了停止 —— 那看起来像自己把程序弄坏了。
//
// ④ **只接中断,别的错误照旧抛**。把 API 故障也吞成「已停止」
//    会让真正的失败无声消失,比报错难查得多。
// ============================================

import { describe, it, expect, vi } from 'vitest';
import { DeepSeekAdapter } from './deepseek-adapter.js';
import { Orchestrator } from './orchestrator.js';
import type { LLMClient, LLMRequest, LLMResponse } from './llm-client.js';
import { ToolRegistry, ToolRunner } from '../tools/index.js';
import {
  ConsoleLogger,
  LogLevel,
  RetryHandler,
  AbortedError,
  isAbortError,
  LLMError,
} from '../platform/index.js';

const logger = new ConsoleLogger(LogLevel.ERROR);

/** SDK 中断错误的形状 —— 按 name 认,不依赖 instanceof(见 isAbortError) */
function sdkAbortError(): Error {
  const e = new Error('Request was aborted.');
  e.name = 'APIUserAbortError';
  return e;
}

function domAbortError(): Error {
  const e = new Error('The operation was aborted.');
  e.name = 'AbortError';
  return e;
}

function orchestratorWith(
  client: LLMClient,
  getSignal?: () => AbortSignal | undefined,
) {
  const registry = new ToolRegistry(logger);
  const runner = new ToolRunner(registry, {
    sessionId: 'test-abort',
    logger,
    getSignal: () => getSignal?.() ?? new AbortController().signal,
    onConfirmRequired: async () => false,
    allowDangerousTools: false,
    fsGrants: [],
  });
  return new Orchestrator(client, runner, registry, {
    maxSteps: 5,
    logger,
    getSignal,
  });
}

/** 记录每次请求收到的 signal,便于断言「传下去了」 */
function recordingClient(res: Partial<LLMResponse> = {}) {
  const seen: Array<AbortSignal | undefined> = [];
  const client: LLMClient = {
    async complete(req: LLMRequest): Promise<LLMResponse> {
      seen.push(req.signal);
      return {
        content: '答案',
        reasoning: null,
        toolCalls: [],
        finishReason: 'stop',
        ...res,
      };
    },
  };
  return { client, seen };
}

describe('isAbortError 的识别范围', () => {
  it('认 SDK 的 APIUserAbortError 与 DOM 的 AbortError', () => {
    expect(isAbortError(sdkAbortError())).toBe(true);
    expect(isAbortError(domAbortError())).toBe(true);
    expect(isAbortError(new AbortedError())).toBe(true);
  });

  it('不认普通错误 —— 否则真实故障会被当成「已停止」吞掉', () => {
    expect(isAbortError(new Error('ECONNRESET'))).toBe(false);
    expect(isAbortError(new LLMError('LLM API 调用失败'))).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
    expect(isAbortError('abort')).toBe(false);   // 字符串不是错误对象
  });
});

// ============================================
// SDK 静默中断 —— 实测踩到的那个 bug
// ============================================
//
// openai SDK 的 Stream 在 abort 时**不抛异常,而是安静地结束迭代**
// (streaming.js:69 / :116 —— `if (e.name === 'AbortError') return;`)。
// 于是 consumeStream 的 for await 正常退出,代码继续往下走去解析一个
// 只收到半截的 tool_calls.arguments —— JSON.parse 必然失败,
// 抛出「流式工具调用参数不是合法 JSON」。
//
// 用户看到的:点了停止,界面弹一条红色报错,内容是半段 Python 代码。
// 看起来像模型输出坏了,而他只是点了停止。
//
// 「SDK 抛错」那条路本来就被 catch 接住了;这里盯的是「SDK 静默返回」那条。
describe('SDK 静默中断(不抛异常,直接结束迭代)', () => {
  /** 造一个吐半截 tool_call 之后就结束的流 —— 与 SDK abort 后的行为同形 */
  function halfToolCallAdapter(signal: AbortSignal) {
    const adapter = new DeepSeekAdapter({
      apiKey: 'sk-test',
      baseURL: 'https://example.invalid',
      model: 'test-model',
      enableThinking: false,
      logger,
    });

    (adapter as any).client = {
      chat: {
        completions: {
          create: async () => ({
            async *[Symbol.asyncIterator]() {
              // 第一片给 id/name,第二片给**半截** JSON,然后流就没了 ——
              // 正是中断发生在工具参数传输中途时的形状
              yield {
                choices: [{
                  delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'execute_python', arguments: '{"code": "import os' } }] },
                  finish_reason: null,
                }],
              };
            },
          }),
        },
      },
    };
    return adapter;
  }

  it('中断后抛 AbortedError,**不是** JSON 解析失败', async () => {
    const ctrl = new AbortController();
    const adapter = halfToolCallAdapter(ctrl.signal);

    // 流结束时信号已中止 —— 模拟「点了停止,SDK 静默收尾」
    ctrl.abort();

    const caught: unknown = await adapter
      .complete({
        messages: [{ role: 'user', content: 'q' }],
        onDelta: () => {},
        signal: ctrl.signal,
      })
      .catch(e => e);

    // 修复前这里是 LLMError:「流式工具调用参数不是合法 JSON」
    expect(isAbortError(caught)).toBe(true);
    expect(caught).toBeInstanceOf(AbortedError);
  });

  it('未中断时半截 JSON 仍然照旧报错 —— 没把真实的分片丢失也吞掉', async () => {
    // 反向对照:这条失败说明修过头了。半截 JSON 在**没有**中断时
    // 是真实故障(丢了分片),必须报出来 ——
    // 静默给空参数会让工具用默认值跑起来,比失败更糟
    const ctrl = new AbortController();
    const adapter = halfToolCallAdapter(ctrl.signal);

    const caught: unknown = await adapter
      .complete({
        messages: [{ role: 'user', content: 'q' }],
        onDelta: () => {},
        signal: ctrl.signal,
      })
      .catch(e => e);

    expect(isAbortError(caught)).toBe(false);
    expect(caught).toBeInstanceOf(LLMError);
    // 原话在 **detail** 而不是 message:completeStreaming 的 catch 把内层错误
    // 包了一层,而原始消息刻意不拼进 message(进了会被外层 RetryHandler
    // 匹配到、让调用次数相乘)。断言 message 会得到外层那句概括
    expect((caught as LLMError).detail).toContain('不是合法 JSON');
  });
});

describe('中断不触发重试', () => {
  it('SDK 中断只调用一次 —— 重试会让「停止」变成「越点越忙」', async () => {
    const handler = new RetryHandler({ maxRetries: 3, baseDelay: 1 }, logger);
    const fn = vi.fn().mockRejectedValue(sdkAbortError());

    await expect(handler.execute(fn, 'op')).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('DOM 中断同样不重试', async () => {
    const handler = new RetryHandler({ maxRetries: 3, baseDelay: 1 }, logger);
    const fn = vi.fn().mockRejectedValue(domAbortError());

    await expect(handler.execute(fn, 'op')).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('AbortedError 也不重试', async () => {
    const handler = new RetryHandler({ maxRetries: 2, baseDelay: 1 }, logger);
    const fn = vi.fn().mockRejectedValue(new AbortedError());

    await expect(handler.execute(fn, 'op')).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('主循环的中断处置', () => {
  it('信号已中止时**一步都不跑** —— 上一步工具执行期间的中断走这条', async () => {
    // 工具错误一律包成 ToolResult 不抛异常(项目约定),所以工具执行期间的
    // 中断不会经由 catch 到达。不在每步开头查就会白跑一整步
    const aborted = new AbortController();
    aborted.abort();

    const { client, seen } = recordingClient();
    const o = orchestratorWith(client, () => aborted.signal);
    const r = await o.run([{ role: 'user', content: 'q' }]);

    expect(r.stopReason).toBe('aborted');
    expect(seen).toHaveLength(0);   // 一次 LLM 请求都没发
  });

  it('请求过程中被中断 → stopReason=aborted,**不抛异常**', async () => {
    const client: LLMClient = {
      async complete() { throw sdkAbortError(); },
    };
    const o = orchestratorWith(client);

    // 抛异常的话界面会标红、日志报 error —— 用户只是点了停止
    const r = await o.run([{ role: 'user', content: 'q' }]);
    expect(r.stopReason).toBe('aborted');
    // 正文不能是空串:空串会让展示层走「无回答」兜底,与 no_response 混在一起
    expect(r.answer.length).toBeGreaterThan(0);
  });

  it('非中断错误照旧往上抛 —— 吞掉会让真实故障无声消失', async () => {
    const client: LLMClient = {
      async complete() { throw new LLMError('LLM API 调用失败', true, '500'); },
    };
    const o = orchestratorWith(client);

    await expect(o.run([{ role: 'user', content: 'q' }])).rejects.toThrow(LLMError);
  });

  it('done 事件里带 aborted —— 展示层靠它决定不标红', async () => {
    const client: LLMClient = {
      async complete() { throw domAbortError(); },
    };
    const events: string[] = [];
    const o = orchestratorWith(client);

    await o.run([{ role: 'user', content: 'q' }], e => {
      if (e.type === 'done') events.push(e.stopReason);
    });

    expect(events).toEqual(['aborted']);
  });

  it('signal 被传进每次 LLM 请求 —— 没有它「停止」最快也要等本步跑完', async () => {
    const ctrl = new AbortController();
    const { client, seen } = recordingClient();
    const o = orchestratorWith(client, () => ctrl.signal);

    await o.run([{ role: 'user', content: 'q' }]);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(ctrl.signal);
  });

  it('未中断时正常收尾 —— 没把所有轮次都判成中断', async () => {
    const ctrl = new AbortController();
    const { client } = recordingClient();
    const o = orchestratorWith(client, () => ctrl.signal);

    const r = await o.run([{ role: 'user', content: 'q' }]);
    expect(r.stopReason).toBe('complete');
  });
});

describe('信号是每轮换的(getSignal 现取)', () => {
  it('中止过的信号被换掉之后,后续轮次照常能跑', async () => {
    // 这条盯的是「点过一次停止就再也跑不了」那个 bug。
    // 模拟 session 的做法:每轮 run() 前换一个新的 controller
    let ctrl = new AbortController();
    const { client, seen } = recordingClient();
    const o = orchestratorWith(client, () => ctrl.signal);

    // 第一轮:中止
    ctrl.abort();
    const first = await o.run([{ role: 'user', content: 'q1' }]);
    expect(first.stopReason).toBe('aborted');

    // 第二轮:换新 controller —— 必须能正常跑完
    ctrl = new AbortController();
    const second = await o.run([{ role: 'user', content: 'q2' }]);

    expect(second.stopReason).toBe('complete');
    expect(seen).toHaveLength(1);          // 只有第二轮发出了请求
    expect(seen[0]).toBe(ctrl.signal);     // 拿到的是**新**信号,不是旧那个
  });

  it('getSignal 每步现取,不缓存 —— 缓存会让中断在本轮内失效', async () => {
    const calls: number[] = [];
    let ctrl = new AbortController();
    const getSignal = () => { calls.push(1); return ctrl.signal; };

    const { client } = recordingClient();
    const o = orchestratorWith(client, getSignal);
    await o.run([{ role: 'user', content: 'q' }]);

    // 每步至少取两次(循环开头查一次、请求里传一次)。
    // 只取一次说明被缓存了 —— 那样中断信号在本轮内就永远读不到变化
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});
