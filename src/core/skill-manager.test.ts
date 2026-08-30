// ============================================
// SkillManager —— 触发判据 / 只读边界 / 审批闸门
// ============================================
//
// 纯逻辑(存取/渲染/合并)在 skill.test.ts。这里测**只有接起来才会暴露**的性质:
//
// ① **触发判据错了不报错**。门槛写成「攒够 N 轮」或漏掉 stopReason 过滤时,
//    表现只是「该沉淀时没沉淀」或「把半截流程记成了 skill」——
//    两者都要等到几十次会话之后才看得出来。
// ② **pending 闸门漏了不报错**。待审批的 skill 一旦能被 load_skill 取到,
//    含糊的描述就会开始误导模型,而没有任何信号提示这件事。
// ③ **抽取失败绝不能向主循环冒泡**。skill 是增强不是必需品,
//    一次抽取失败不该让用户的这一轮报错(与 MemoryManager 同一条原则)。
// ============================================

import { describe, it, expect, vi } from 'vitest';
import { SkillManager, type TurnActivity } from './skill-manager.js';
import { saveSkills, loadSkills, type Skill, type SkillStore } from './skill.js';
import type { Turn } from './context.js';
import type { LLMClient, LLMResponse } from './llm-client.js';
import { ConsoleLogger, LogLevel } from '../platform/index.js';

const logger = new ConsoleLogger(LogLevel.ERROR);
const T0 = 1_700_000_000_000;

function makeStore(): SkillStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: (k: string) => data.get(k) ?? null,
    set: (k: string, v: string) => void data.set(k, v),
    delete: (k: string) => void data.delete(k),
  };
}

function skill(over: Partial<Skill> = {}): Skill {
  return {
    name: 'zhihu-hot',
    description: '搜索知乎热搜榜并返回条目标题',
    steps: [{ goal: '进入知乎', how: 'page.goto(...)' }],
    pending: false,
    hits: 0,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

/** 返回固定 JSON 的客户端,并记录被调用次数 */
function jsonClient(payload: unknown) {
  const calls: string[] = [];
  const client: LLMClient = {
    async complete(req): Promise<LLMResponse> {
      calls.push(req.traceLabel ?? '');
      return {
        content: JSON.stringify(payload),
        reasoning: null,
        toolCalls: [],
        finishReason: 'stop',
      };
    },
  };
  return { client, calls };
}

/** 一条「跑了很多步」的轨迹 */
function busyTurn(): Turn {
  return {
    turn_id: 1,
    timestamp: T0,
    messages: [
      { role: 'user', content: '搜一下知乎热搜' },
      { role: 'assistant', content: '我来查', toolCalls: [{ id: 'c1', name: 'execute_python', args: { code: 'x' } }] },
      { role: 'tool', toolCallId: 'c1', content: '{"ok":true,"data":{"titles":["a"]}}' },
      { role: 'assistant', content: '热搜前三条是…' },
    ],
  };
}

const ACTIVE: TurnActivity = { toolSteps: 9, toolFails: 0 };
const QUIET: TurnActivity = { toolSteps: 1, toolFails: 0 };

function manager(store: SkillStore, client: LLMClient, minToolSteps = 8) {
  return new SkillManager({ store, llmClient: client, logger, minToolSteps, retry: { maxRetries: 0 } });
}

describe('load —— 只读边界与 pending 闸门', () => {
  it('取得到已审批的,并累加 hits', () => {
    const store = makeStore();
    saveSkills(store, [skill({ hits: 3 })]);
    const m = manager(store, jsonClient({ worth: false }).client);

    const r = m.load('zhihu-hot');
    expect(r.ok).toBe(true);
    expect(r.body).toContain('进入知乎');

    // hits 是淘汰与排序的唯一可信信号,取用即累加且要落盘
    expect(loadSkills(store)[0].hits).toBe(4);
  });

  it('**取不到待审批的** —— 它根本不在索引里,模型不该能拿到', () => {
    const store = makeStore();
    saveSkills(store, [skill({ pending: true })]);
    const m = manager(store, jsonClient({ worth: false }).client);

    const r = m.load('zhihu-hot');
    expect(r.ok).toBe(false);
    // 也不该出现在可用名单里
    expect(r.available).toEqual([]);
  });

  it('取错名字时给出可用名单 —— 省一轮试错', () => {
    // 只报「没找到」的话模型会去猜第二个名字,而每次猜错都是一个 round trip
    // (按实测首字延迟地板 5.79s,6~12 秒)
    const store = makeStore();
    saveSkills(store, [skill({ name: 'a' }), skill({ name: 'b' })]);
    const m = manager(store, jsonClient({ worth: false }).client);

    const r = m.load('typo');
    expect(r.ok).toBe(false);
    expect(r.available).toEqual(['a', 'b']);
  });

  it('名字两端空白被容忍 —— 模型偶尔会带空格', () => {
    const store = makeStore();
    saveSkills(store, [skill()]);
    const m = manager(store, jsonClient({ worth: false }).client);

    expect(m.load('  zhihu-hot  ').ok).toBe(true);
  });

  it('索引里不含待审批的条目', () => {
    const store = makeStore();
    saveSkills(store, [skill({ name: 'live' }), skill({ name: 'waiting', pending: true })]);
    const m = manager(store, jsonClient({ worth: false }).client);

    const idx = m.prompt();
    expect(idx).toContain('live');
    expect(idx).not.toContain('waiting');
  });
});

describe('审批', () => {
  it('approve 之后才进索引、才可加载', () => {
    const store = makeStore();
    saveSkills(store, [skill({ pending: true })]);
    const m = manager(store, jsonClient({ worth: false }).client);

    expect(m.load('zhihu-hot').ok).toBe(false);
    expect(m.approve('zhihu-hot')).toBe(true);

    expect(m.load('zhihu-hot').ok).toBe(true);
    expect(m.prompt()).toContain('zhihu-hot');
    // 落盘了才算,否则重启就退回待审
    expect(loadSkills(store)[0].pending).toBe(false);
  });

  it('reject 删掉条目并落盘', () => {
    const store = makeStore();
    saveSkills(store, [skill({ pending: true })]);
    const m = manager(store, jsonClient({ worth: false }).client);

    expect(m.reject('zhihu-hot')).toBe(true);
    expect(loadSkills(store)).toHaveLength(0);
  });

  it('**reject 不能删掉已审批的** —— 那是用户已经认可的资产', () => {
    const store = makeStore();
    saveSkills(store, [skill({ pending: false })]);
    const m = manager(store, jsonClient({ worth: false }).client);

    expect(m.reject('zhihu-hot')).toBe(false);
    expect(loadSkills(store)).toHaveLength(1);
  });

  it('approve 不存在的名字返回 false,不抛', () => {
    const m = manager(makeStore(), jsonClient({ worth: false }).client);
    expect(m.approve('nope')).toBe(false);
    expect(m.reject('nope')).toBe(false);
  });
});

describe('onTurnEnd —— 触发判据', () => {
  const extraction = {
    worth: true,
    name: 'zhihu-hot',
    description: '搜索知乎热搜榜并返回条目标题',
    steps: [{ goal: '进入知乎', how: 'goto' }],
  };

  it('够门槛 + complete → 抽取,且新条目是 pending', async () => {
    const store = makeStore();
    const { client, calls } = jsonClient(extraction);
    await manager(store, client).onTurnEnd(busyTurn(), ACTIVE, 'complete');

    expect(calls).toEqual(['skill:extraction']);
    const saved = loadSkills(store);
    expect(saved).toHaveLength(1);
    expect(saved[0].pending).toBe(true);   // 审批前不生效
  });

  it('步数不够且无失败 → **不调 LLM**', async () => {
    const { client, calls } = jsonClient(extraction);
    await manager(makeStore(), client).onTurnEnd(busyTurn(), QUIET, 'complete');
    expect(calls).toEqual([]);
  });

  it('步数不够但**有工具失败** → 仍然抽取(踩过的坑最值钱)', async () => {
    const { client, calls } = jsonClient(extraction);
    await manager(makeStore(), client).onTurnEnd(
      busyTurn(),
      { toolSteps: 2, toolFails: 1 },
      'complete',
    );
    expect(calls).toHaveLength(1);
  });

  it('门槛可配 —— minToolSteps 生效', async () => {
    const { client, calls } = jsonClient(extraction);
    await manager(makeStore(), client, 3).onTurnEnd(
      busyTurn(),
      { toolSteps: 3, toolFails: 0 },
      'complete',
    );
    expect(calls).toHaveLength(1);
  });

  it.each(['truncated', 'max_steps', 'no_response', 'aborted'])(
    'stopReason=%s **不沉淀** —— 半截流程记成 skill 会让下次同样走不完',
    async reason => {
      const { client, calls } = jsonClient(extraction);
      await manager(makeStore(), client).onTurnEnd(busyTurn(), ACTIVE, reason);
      expect(calls).toEqual([]);
    },
  );

  it('turn 为 undefined 时安全返回 —— 第一次请求之前就中断的情况', async () => {
    const { client, calls } = jsonClient(extraction);
    await manager(makeStore(), client).onTurnEnd(undefined, ACTIVE, 'complete');
    expect(calls).toEqual([]);
  });

  it('worth:false 时不入库 —— 模型有权说「这次没有可复用的东西」', async () => {
    const store = makeStore();
    const { client, calls } = jsonClient({ worth: false, reason: '一次性查询' });
    await manager(store, client).onTurnEnd(busyTurn(), ACTIVE, 'complete');

    expect(calls).toHaveLength(1);       // 调了
    expect(loadSkills(store)).toHaveLength(0);   // 但没入库
  });

  it('已有同名条目时更新它,**保留 hits**(那是资历)', async () => {
    const store = makeStore();
    saveSkills(store, [skill({ name: 'zhihu-hot', hits: 12 })]);
    const { client } = jsonClient({ ...extraction, description: '更精确的描述' });

    await manager(store, client).onTurnEnd(busyTurn(), ACTIVE, 'complete');

    const saved = loadSkills(store);
    expect(saved).toHaveLength(1);
    expect(saved[0].description).toBe('更精确的描述');
    expect(saved[0].hits).toBe(12);
    expect(saved[0].pending).toBe(true);   // 内容变了要再看一眼
  });
});

describe('失败降级', () => {
  it('模型返回非 JSON **不抛异常**,库保持原样', async () => {
    const store = makeStore();
    saveSkills(store, [skill()]);
    const client: LLMClient = {
      async complete(): Promise<LLMResponse> {
        return { content: '这不是 JSON', reasoning: null, toolCalls: [], finishReason: 'stop' };
      },
    };

    // 抛出来就会让用户这一轮报错 —— skill 是增强不是必需品
    await expect(
      manager(store, client).onTurnEnd(busyTurn(), ACTIVE, 'complete'),
    ).resolves.toBeUndefined();

    expect(loadSkills(store)).toHaveLength(1);
  });

  it('LLM 调用抛错也不冒泡', async () => {
    const client: LLMClient = {
      async complete(): Promise<LLMResponse> { throw new Error('网络炸了'); },
    };
    await expect(
      manager(makeStore(), client).onTurnEnd(busyTurn(), ACTIVE, 'complete'),
    ).resolves.toBeUndefined();
  });

  it('结构不符(缺 worth)时不入库也不抛', async () => {
    const store = makeStore();
    const { client } = jsonClient({ name: 'x', description: 'y' });
    await expect(
      manager(store, client).onTurnEnd(busyTurn(), ACTIVE, 'complete'),
    ).resolves.toBeUndefined();
    expect(loadSkills(store)).toHaveLength(0);
  });

  it('库格式坏了仍能构造 —— 读不出来不该让会话起不来', () => {
    const store = makeStore();
    store.set('skills:library:v1', '{ 坏的 JSON');
    const m = manager(store, jsonClient({ worth: false }).client);

    expect(m.list()).toEqual([]);
    expect(m.prompt()).toBe('');
  });
});

// onChanged 是壳刷新待审批角标的**唯一**信号 —— 沉淀在 run() 返回之后才结束,
// 渲染层在轮末自己拉一次一定拉不到刚入库那条。
// 这一组测的是「什么时候发」和「发的时候壳炸了会怎样」,两者错了都不报错:
// 多发只是每轮白跑一次 IPC,少发表现成「跑完任务角标不动,重开窗口才冒出来」。
describe('onChanged 通知', () => {
  const extraction = {
    worth: true,
    name: 'zhihu-hot',
    description: '搜索知乎热搜榜并返回条目标题',
    steps: [{ goal: '进入知乎', how: 'goto' }],
  };

  function withHook(store: SkillStore, client: LLMClient) {
    const onChanged = vi.fn();
    const m = new SkillManager({
      store, llmClient: client, logger,
      minToolSteps: 8, retry: { maxRetries: 0 },
      onChanged,
    });
    return { m, onChanged };
  }

  it('真沉淀了才通知,且**落盘之后**才发(早一步壳会读到旧库)', async () => {
    const store = makeStore();
    const { client } = jsonClient(extraction);
    const { m, onChanged } = withHook(store, client);

    // 回调触发的那一刻库里就必须已经有这条 —— 壳收到就会立刻回来读
    let seenAtCallback = -1;
    onChanged.mockImplementation(() => { seenAtCallback = loadSkills(store).length; });

    await m.onTurnEnd(busyTurn(), ACTIVE, 'complete');

    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(seenAtCallback).toBe(1);
  });

  it('worth:false 不通知 —— 否则壳每轮都白跑一次 IPC', async () => {
    const { client } = jsonClient({ worth: false, reason: '一次性查询' });
    const { m, onChanged } = withHook(makeStore(), client);
    await m.onTurnEnd(busyTurn(), ACTIVE, 'complete');
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('结果不完整(未入库)不通知', async () => {
    const { client } = jsonClient({ worth: true });   // 缺 name/steps
    const { m, onChanged } = withHook(makeStore(), client);
    await m.onTurnEnd(busyTurn(), ACTIVE, 'complete');
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('没够门槛时连 LLM 都不调,自然不通知', async () => {
    const { client } = jsonClient(extraction);
    const { m, onChanged } = withHook(makeStore(), client);
    await m.onTurnEnd(busyTurn(), QUIET, 'complete');
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('回调抛异常不影响沉淀结果 —— 库已经存好了,只是界面没刷上', async () => {
    const store = makeStore();
    const { client } = jsonClient(extraction);
    const { m, onChanged } = withHook(store, client);
    onChanged.mockImplementation(() => { throw new Error('窗口没了'); });

    await expect(m.onTurnEnd(busyTurn(), ACTIVE, 'complete')).resolves.toBeUndefined();
    expect(loadSkills(store)).toHaveLength(1);   // 落盘不受影响
  });

  it('approve / reject **不发**通知 —— 那两条路的新列表由 IPC 返回值带回', async () => {
    const store = makeStore();
    saveSkills(store, [skill({ name: 'a', pending: true }), skill({ name: 'b', pending: true })]);
    const { m, onChanged } = withHook(store, jsonClient(extraction).client);

    m.approve('a');
    m.reject('b');
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('没传 onChanged 时照常沉淀 —— CLI 不需要这个通道', async () => {
    const store = makeStore();
    const { client } = jsonClient(extraction);
    await expect(
      manager(store, client).onTurnEnd(busyTurn(), ACTIVE, 'complete'),
    ).resolves.toBeUndefined();
    expect(loadSkills(store)).toHaveLength(1);
  });
});

describe('并发保护', () => {
  it('抽取进行中时跳过 —— 一次抽取是 await,期间下一轮可能又够格', async () => {
    let resolveFirst: (v: LLMResponse) => void = () => {};
    let callCount = 0;

    const client: LLMClient = {
      complete(): Promise<LLMResponse> {
        callCount++;
        return new Promise<LLMResponse>(res => { resolveFirst = res; });
      },
    };

    const m = manager(makeStore(), client);
    const first = m.onTurnEnd(busyTurn(), ACTIVE, 'complete');
    // 第一次还挂着,第二次应当直接返回
    await m.onTurnEnd(busyTurn(), ACTIVE, 'complete');
    expect(callCount).toBe(1);

    resolveFirst({ content: '{"worth":false}', reasoning: null, toolCalls: [], finishReason: 'stop' });
    await first;
  });
});
