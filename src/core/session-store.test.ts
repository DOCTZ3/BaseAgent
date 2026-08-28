// ============================================
// 会话历史 —— 落盘、恢复、turn_id 不撞号
// ============================================
//
// 这批测试锁三件事,每一件做错都是**静默的**:
//
// ① **turn_id 撞号**(这次改动前就存在的 bug)。原来 turn_id 由
//    `this.turns.length + 1` 派生,而压缩执行 `this.turns = recentTurns`
//    把数组截短 —— 15 轮压到保留 10 轮后,下一轮算出 11,与已存在的第 11 轮撞。
//    后果:activeTurnTopics 映射错乱、归档文件被覆盖、
//    历史落盘按 turn_id 判断写到哪了,撞号会让压缩之后的每一轮都不再写入。
//
// ② **最后一轮不落盘**。finalizeTurn() 只在 addUserMessage() 里调,
//    一轮要等下一条用户消息才进 this.turns —— 靠它挂钩子的话每个会话的
//    最后一轮永远丢。与 peekTurns 那个 bug 同一形态,所以这里断言
//    「刚结束的轮次立刻可见」。
//
// ③ **坏行不能毁掉整份历史**。进程被 Ctrl+C 时可能留下半行 JSON,
//    那不该让前面几十轮真实对话一起读不出来。
// ============================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ContextManager, type Turn } from './context.js';
import { ConsoleLogger, LogLevel } from '../platform/index.js';
import {
  turnsFile,
  appendTurn,
  readTurns,
  listSessions,
} from './session-store.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseagent-hist-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeContext(sessionId = 's1', recentTurnsToKeep = 10) {
  return new ContextManager(
    {
      sessionId,
      windowSize: 1_000_000,
      compressionThreshold: 0.7,
      recentTurnsToKeep,
      maxTopicsInContext: 10,
      sessionsDir: dir,
      logger: new ConsoleLogger(LogLevel.ERROR),
    },
    { complete: vi.fn() } as never,
  );
}

/** 跑完整一轮:提问 → 回答 */
async function oneTurn(ctx: ContextManager, q: string, a: string) {
  await ctx.addUserMessage(q);
  ctx.addFinalResponse(a);
}

function fakeTurn(id: number, question: string): Turn {
  return {
    turn_id: id,
    timestamp: Date.now() + id,
    messages: [
      { role: 'user', content: question },
      { role: 'assistant', content: `答案 ${id}` },
    ],
  };
}

describe('turn_id 单调递增', () => {
  it('压缩截短 turns 之后仍然不撞号', async () => {
    const ctx = makeContext('s1', 2);
    await ctx.initialize();

    for (let i = 1; i <= 4; i++) await oneTurn(ctx, `问题 ${i}`, `答案 ${i}`);

    // 模拟压缩的效果:把 turns 截到最近 2 轮(runCompression 里那句
    // `this.turns = recentTurns` 的直接后果)
    const turns = (ctx as any).turns as Turn[];
    (ctx as any).turns = turns.slice(-2);
    expect(((ctx as any).turns as Turn[]).length).toBe(2);

    await oneTurn(ctx, '压缩后的新问题', '新答案');

    // 注意第 4 轮此刻还挂在 currentTurn 上(finalizeTurn 要等下一条用户消息),
    // 所以上面切掉的是 [1] 而不是 [1,2],新一轮开始时它才被推进 turns
    const ids = ctx.peekTurns().map(t => t.turn_id);
    // 旧实现:此刻 turns 是 [2,3,4],length + 1 = 4 —— 与已存在的第 4 轮撞号
    expect(ids).toEqual([2, 3, 4, 5]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('续接会话后编号接着历史往下走', async () => {
    const ctx = makeContext('s2');
    await ctx.initialize();
    ctx.addSystemMessage('系统提示');

    ctx.restoreTurns([fakeTurn(1, '旧问题一'), fakeTurn(2, '旧问题二')]);
    await oneTurn(ctx, '续接后的新问题', '新答案');

    const ids = ctx.peekTurns().map(t => t.turn_id);
    // 不抬计数器的话新轮次会是 1,与历史第 1 轮撞号
    expect(ids).toEqual([1, 2, 3]);
  });

  it('历史里有坏行导致条数偏小时,仍按最大 id 续号', async () => {
    const ctx = makeContext('s3');
    await ctx.initialize();
    // 只恢复到 5(中间几轮是坏行被跳过),下一轮必须是 6 而不是 2
    ctx.restoreTurns([fakeTurn(5, '第五轮')]);
    await oneTurn(ctx, '新问题', '新答案');

    expect(ctx.peekTurns().map(t => t.turn_id)).toEqual([5, 6]);
  });
});

describe('restoreTurns', () => {
  it('system 消息留在首位,历史接在它之后', async () => {
    const ctx = makeContext('s4');
    await ctx.initialize();
    ctx.addSystemMessage('系统提示');
    ctx.restoreTurns([fakeTurn(1, '旧问题')]);

    const msgs = ctx.peekMessages();
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].role).toBe('user');
    expect(msgs[1].content).toBe('旧问题');
  });

  it('空数组是无操作', async () => {
    const ctx = makeContext('s5');
    await ctx.initialize();
    ctx.addSystemMessage('系统提示');
    ctx.restoreTurns([]);
    expect(ctx.peekMessages().length).toBe(1);
    expect(ctx.peekTurns().length).toBe(0);
  });

  it('刻意不恢复压缩状态 —— 那些字段是可再生的', async () => {
    const ctx = makeContext('s6');
    await ctx.initialize();
    ctx.restoreTurns([fakeTurn(1, '旧问题')]);

    // 主题摘要与归档索引都应保持为空:恢复后水位到了会自然重新压一次。
    // 逐个序列化那 10 个私有字段才是静默 bug 的来源
    expect(((ctx as any).topicSummaries as Map<string, unknown>).size).toBe(0);
    expect(((ctx as any).archivedTurnIds as number[]).length).toBe(0);
  });
});

describe('turns.jsonl 读写', () => {
  it('追加与读回是同一份数据', () => {
    const f = turnsFile(dir, 'w1');
    expect(appendTurn(f, fakeTurn(1, '问题一'))).toBe(true);
    expect(appendTurn(f, fakeTurn(2, '问题二'))).toBe(true);

    const back = readTurns(f);
    expect(back.map(t => t.turn_id)).toEqual([1, 2]);
    expect(back[0].messages[0].content).toBe('问题一');
  });

  it('内容里的换行不会破坏行分隔', () => {
    const f = turnsFile(dir, 'w2');
    appendTurn(f, fakeTurn(1, '第一行\n第二行\n第三行'));
    const back = readTurns(f);
    expect(back.length).toBe(1);
    expect(back[0].messages[0].content).toBe('第一行\n第二行\n第三行');
  });

  it('坏行被跳过,好行照常读出', () => {
    const f = turnsFile(dir, 'w3');
    appendTurn(f, fakeTurn(1, '问题一'));
    // 模拟 Ctrl+C 留下的半行
    fs.appendFileSync(f, '{"turn_id":2,"messa\n');
    appendTurn(f, fakeTurn(3, '问题三'));

    expect(readTurns(f).map(t => t.turn_id)).toEqual([1, 3]);
  });

  it('形状不对的行也跳过(messages 不是数组)', () => {
    const f = turnsFile(dir, 'w4');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '{"turn_id":1,"messages":"不是数组"}\n');
    appendTurn(f, fakeTurn(2, '正常轮次'));
    expect(readTurns(f).map(t => t.turn_id)).toEqual([2]);
  });

  it('文件不存在时返回空数组,不抛异常', () => {
    expect(readTurns(turnsFile(dir, '不存在'))).toEqual([]);
  });
});

describe('listSessions', () => {
  it('标题取第一条用户提问,按最近更新倒序', () => {
    appendTurn(turnsFile(dir, 'a'), fakeTurn(1, '第一个会话的问题'));
    appendTurn(turnsFile(dir, 'b'), fakeTurn(1, '第二个会话的问题'));
    // 让 b 更新更晚
    fs.utimesSync(turnsFile(dir, 'b'), new Date(), new Date(Date.now() + 10_000));

    const list = listSessions(dir);
    expect(list.map(s => s.sessionId)).toEqual(['b', 'a']);
    expect(list[1].title).toBe('第一个会话的问题');
    expect(list[1].turnCount).toBe(1);
  });

  it('长标题被截断,不撑开侧边栏', () => {
    appendTurn(turnsFile(dir, 'long'), fakeTurn(1, '这是一个非常长的问题'.repeat(10)));
    const title = listSessions(dir)[0].title;
    expect(title.length).toBeLessThanOrEqual(35);
    expect(title.endsWith('…')).toBe(true);
  });

  it('标题里的换行折成空格 —— 否则侧边栏一条占三行', () => {
    appendTurn(turnsFile(dir, 'nl'), fakeTurn(1, '第一行\n第二行'));
    expect(listSessions(dir)[0].title).toBe('第一行 第二行');
  });

  it('没有 turns.jsonl 的目录不算会话', () => {
    // 只有 calls/ 的旧留痕目录不该出现在历史列表里
    fs.mkdirSync(path.join(dir, 'onlytrace', 'calls'), { recursive: true });
    appendTurn(turnsFile(dir, 'real'), fakeTurn(1, '真会话'));
    expect(listSessions(dir).map(s => s.sessionId)).toEqual(['real']);
  });

  it('空文件不算会话', () => {
    fs.mkdirSync(path.join(dir, 'empty'), { recursive: true });
    fs.writeFileSync(turnsFile(dir, 'empty'), '');
    expect(listSessions(dir)).toEqual([]);
  });

  it('根目录不存在时返回空数组', () => {
    expect(listSessions(path.join(dir, '没有这个目录'))).toEqual([]);
  });
});
