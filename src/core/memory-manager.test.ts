// ============================================
// 长期记忆 —— 抽取驱动(触发时机 / 失败降级 / 喂什么给抽取器)
// ============================================
//
// 纯逻辑在 memory.test.ts。这里测的是**只有接起来才会暴露**的那些性质:
// - 抽取失败绝不向主循环冒泡(记忆是增强不是必需品)
// - 计数器在发起前清零 —— 不清会让一次模型抽风变成连续重试
// - 只喂用户发言,不喂工具往返:messages[0] 之后的 role:'user' 是**工具观察**
//   (见 context.ts 顺序约定),喂进去会把截图描述当成用户说过的话
// ============================================

import { describe, it, expect, vi } from 'vitest';
import { MemoryManager } from './memory-manager.js';
import { loadMemory, type MemoryStore } from './memory.js';
import type { LLMClient, LLMResponse } from './llm-client.js';
import type { Turn } from './context.js';

const logger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
} as never;

const makeStore = (): MemoryStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    get: (k) => data.get(k) ?? null,
    set: (k, v) => void data.set(k, v),
    delete: (k) => void data.delete(k),
  };
};

/** 返回固定 JSON 的假 LLM,并记录收到的 prompt */
const makeLLM = (json: unknown | (() => never)) => {
  const seen: string[] = [];
  const client: LLMClient = {
    complete: async (req) => {
      seen.push(req.messages.map(m => String(m.content)).join('\n---\n'));
      if (typeof json === 'function') (json as () => never)();
      return {
        content: JSON.stringify(json),
        reasoning: null,
        toolCalls: [],
        finishReason: 'stop',
      } satisfies LLMResponse;
    },
  };
  return { client, seen };
};

const turn = (id: number, userText: string, extra: Turn['messages'] = []): Turn => ({
  turn_id: id,
  timestamp: Date.now(),
  messages: [
    { role: 'user', content: userText },
    { role: 'assistant', content: '好' },
    ...extra,
  ],
});

/** 关掉重试,让失败用例不必等退避 */
const NO_RETRY = { maxRetries: 0 };

describe('触发时机', () => {
  it('不到 N 轮不抽', async () => {
    const { client, seen } = makeLLM({ candidates: [], contradicts: [] });
    const m = new MemoryManager({
      store: makeStore(), llmClient: client, logger,
      turnsPerExtraction: 3, retry: NO_RETRY,
    });

    await m.onTurnEnd([turn(1, '你好')]);
    await m.onTurnEnd([turn(1, '你好'), turn(2, '嗯')]);

    expect(seen).toHaveLength(0);
  });

  it('到第 N 轮就抽', async () => {
    const { client, seen } = makeLLM({
      candidates: [{ dimension: 'language', text: '用中文应答' }], contradicts: [],
    });
    const store = makeStore();
    const m = new MemoryManager({
      store, llmClient: client, logger,
      turnsPerExtraction: 3, retry: NO_RETRY,
    });

    const turns = [turn(1, '说中文'), turn(2, '继续'), turn(3, '再来')];
    await m.onTurnEnd(turns.slice(0, 1));
    await m.onTurnEnd(turns.slice(0, 2));
    await m.onTurnEnd(turns);

    expect(seen).toHaveLength(1);
    expect(loadMemory(store).map(e => e.text)).toEqual(['用中文应答']);
  });

  it('抽完后计数器清零,下一轮不会立刻再抽', async () => {
    const { client, seen } = makeLLM({ candidates: [], contradicts: [] });
    const m = new MemoryManager({
      store: makeStore(), llmClient: client, logger,
      turnsPerExtraction: 2, retry: NO_RETRY,
    });

    await m.onTurnEnd([turn(1, 'a')]);
    await m.onTurnEnd([turn(1, 'a'), turn(2, 'b')]);
    expect(seen).toHaveLength(1);

    // 第 3 轮:计数器已清零,不该再抽
    await m.onTurnEnd([turn(1, 'a'), turn(2, 'b'), turn(3, 'c')]);
    expect(seen).toHaveLength(1);

    // 第 4 轮:又攒够 2 轮
    await m.onTurnEnd([turn(1, 'a'), turn(2, 'b'), turn(3, 'c'), turn(4, 'd')]);
    expect(seen).toHaveLength(2);
  });

  it('没有已完成轮次时不抽', async () => {
    const { client, seen } = makeLLM({ candidates: [], contradicts: [] });
    const m = new MemoryManager({
      store: makeStore(), llmClient: client, logger,
      turnsPerExtraction: 1, retry: NO_RETRY,
    });

    await m.onTurnEnd([]);
    expect(seen).toHaveLength(0);
  });
});

describe('失败降级', () => {
  it('LLM 抛错不冒泡,记忆保持原样', async () => {
    const store = makeStore();
    // 先存一条,确认失败后它还在
    const ok = makeLLM({
      candidates: [{ dimension: 'language', text: '用中文应答' }], contradicts: [],
    });
    const m1 = new MemoryManager({
      store, llmClient: ok.client, logger,
      turnsPerExtraction: 1, retry: NO_RETRY,
    });
    await m1.onTurnEnd([turn(1, '说中文')]);
    expect(loadMemory(store)).toHaveLength(1);

    const boom: LLMClient = {
      complete: async () => { throw new Error('network down'); },
    };
    const m2 = new MemoryManager({
      store, llmClient: boom, logger,
      turnsPerExtraction: 1, retry: NO_RETRY,
    });

    // 不该抛
    await expect(m2.onTurnEnd([turn(2, 'x')])).resolves.toBeUndefined();
    expect(loadMemory(store).map(e => e.text)).toEqual(['用中文应答']);
  });

  it('返回非法 JSON 时同样不冒泡', async () => {
    const bad: LLMClient = {
      complete: async () => ({
        content: '这不是 JSON', reasoning: null, toolCalls: [], finishReason: 'stop',
      }),
    };
    const m = new MemoryManager({
      store: makeStore(), llmClient: bad, logger,
      turnsPerExtraction: 1, retry: NO_RETRY,
    });

    await expect(m.onTurnEnd([turn(1, 'x')])).resolves.toBeUndefined();
  });

  it('schema 不符时不冒泡,也不写入垃圾', async () => {
    const store = makeStore();
    const bad = makeLLM({ candidates: [{ dimension: 'misc', text: 'x' }] });
    const m = new MemoryManager({
      store, llmClient: bad.client, logger,
      turnsPerExtraction: 1, retry: NO_RETRY,
    });

    await expect(m.onTurnEnd([turn(1, 'x')])).resolves.toBeUndefined();
    expect(loadMemory(store)).toEqual([]);
  });
});

describe('喂给抽取器的内容', () => {
  it('只含用户发言,不含 assistant 与工具往返', async () => {
    const { client, seen } = makeLLM({ candidates: [], contradicts: [] });
    const m = new MemoryManager({
      store: makeStore(), llmClient: client, logger,
      turnsPerExtraction: 1, retry: NO_RETRY,
    });

    await m.onTurnEnd([
      turn(1, '帮我查一下天气', [
        { role: 'assistant', content: '我来写代码', toolCalls: [] },
        { role: 'tool', content: 'stdout: 晴 25 度', toolCallId: 'c1' },
      ]),
    ]);

    const prompt = seen[0];
    expect(prompt).toContain('帮我查一下天气');
    expect(prompt).not.toContain('stdout');
    expect(prompt).not.toContain('我来写代码');
  });

  it('**工具观察不被当成用户发言** —— 否则会把截图描述当用户说的话', async () => {
    // messages[0] 之后的 role:'user' 是 addObservation 注入的(见 context.ts)
    const { client, seen } = makeLLM({ candidates: [], contradicts: [] });
    const m = new MemoryManager({
      store: makeStore(), llmClient: client, logger,
      turnsPerExtraction: 1, retry: NO_RETRY,
    });

    await m.onTurnEnd([
      turn(1, '看这张图', [
        { role: 'user', content: '[图片观察] 页面上有个登录按钮' },
      ]),
    ]);

    expect(seen[0]).toContain('看这张图');
    expect(seen[0]).not.toContain('登录按钮');
  });

  it('只看最近 N 轮,更早的不重复分析', async () => {
    // 重复分析同一段对话会让同一条特征反复 hits+1,虚高它的稳定度 ——
    // 而 hits 正是淘汰依据。所以「隔几轮抽」和「看几轮」必须是同一个数
    const { client, seen } = makeLLM({ candidates: [], contradicts: [] });
    const m = new MemoryManager({
      store: makeStore(), llmClient: client, logger,
      turnsPerExtraction: 2, retry: NO_RETRY,
    });

    const turns = [turn(1, '第一轮'), turn(2, '第二轮'), turn(3, '第三轮')];
    await m.onTurnEnd(turns.slice(0, 1));
    await m.onTurnEnd(turns.slice(0, 2));   // 攒够 2 轮 → 抽,看第 1-2 轮
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('第一轮');

    await m.onTurnEnd(turns);               // 只过了 1 轮,不抽
    expect(seen).toHaveLength(1);
  });

  it('现有条目带编号一起给出', async () => {
    const store = makeStore();
    const first = makeLLM({
      candidates: [{ dimension: 'language', text: '用中文应答' }], contradicts: [],
    });
    const m1 = new MemoryManager({
      store, llmClient: first.client, logger,
      turnsPerExtraction: 1, retry: NO_RETRY,
    });
    await m1.onTurnEnd([turn(1, '说中文')]);

    const second = makeLLM({ candidates: [], contradicts: [] });
    const m2 = new MemoryManager({
      store, llmClient: second.client, logger,
      turnsPerExtraction: 1, retry: NO_RETRY,
    });
    await m2.onTurnEnd([turn(2, 'x')]);

    expect(second.seen[0]).toContain('0. [language] 用中文应答');
  });
});

describe('对外接口', () => {
  it('启动时从 store 载入,prompt() 直接可用', () => {
    const store = makeStore();
    const seed = makeLLM({ candidates: [], contradicts: [] });
    // 直接写库,模拟上次会话留下的记忆
    store.set(
      'memory:user-profile:v1',
      JSON.stringify({
        version: 1,
        entries: [{
          dimension: 'language', text: '用中文应答',
          hits: 2, lastSeen: Date.now(), createdAt: Date.now(),
        }],
      }),
    );

    const m = new MemoryManager({ store, llmClient: seed.client, logger });

    expect(m.list()).toHaveLength(1);
    expect(m.prompt()).toContain('用中文应答');
  });

  it('clear() 同时清内存与 store', () => {
    const store = makeStore();
    const seed = makeLLM({ candidates: [], contradicts: [] });
    store.set(
      'memory:user-profile:v1',
      JSON.stringify({
        version: 1,
        entries: [{
          dimension: 'style', text: '简洁',
          hits: 1, lastSeen: Date.now(), createdAt: Date.now(),
        }],
      }),
    );

    const m = new MemoryManager({ store, llmClient: seed.client, logger });
    m.clear();

    expect(m.list()).toEqual([]);
    expect(m.prompt()).toBe('');
    expect(loadMemory(store)).toEqual([]);
  });
});
