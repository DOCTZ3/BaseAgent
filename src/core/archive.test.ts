// ============================================
// 归档索引 —— 累积性与轮次可发现性
// ============================================
//
// 针对两个实测发现的 bug（trace cli-1787376768308）：
//   ① index.json 每次压缩都从空数组重建 → 磁盘上有 turn-001/002/003，
//      索引里只剩 turn 3。而给模型的提示恰恰是「读 index.json 回溯早期对话」，
//      于是更早的轮次它永远发现不了
//   ② archiveTurns 跑在 compressWithTopicClustering 之前，而 Turn→Topic 映射
//      是后者填的 → topic_id 恒为 null
// ============================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ContextManager, type Turn } from './context.js';
import { ConsoleLogger, LogLevel } from '../platform/index.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'baseagent-arch-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

function makeContext(sessionId: string) {
  return new ContextManager(
    {
      sessionId,
      windowSize: 1_000_000,
      compressionThreshold: 0.7,
      recentTurnsToKeep: 1,
      maxTopicsInContext: 10,
      sessionsDir: dir,
      logger: new ConsoleLogger(LogLevel.ERROR),
    },
    { complete: vi.fn() } as never,
  );
}

function fakeTurn(id: number, question: string): Turn {
  return {
    turn_id: id,
    timestamp: Date.now() + id,
    messages: [
      { role: 'user', content: question },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: `c${id}`, name: 'view_image', args: {} }],
      },
      { role: 'tool', toolCallId: `c${id}`, content: '{"ok":true}' },
      { role: 'assistant', content: `答案 ${id}` },
    ],
  };
}

async function readIndex(sessionId: string) {
  const p = path.join(dir, sessionId, 'archive', 'index.json');
  return JSON.parse(await fs.readFile(p, 'utf-8'));
}

describe('归档索引', () => {
  it('多批归档累积，不覆盖早期轮次', async () => {
    const ctx = makeContext('s1');
    await ctx.initialize();

    // 模拟三次压缩，每次归档一轮
    await (ctx as any).archiveTurns([fakeTurn(1, '第一个问题')]);
    await (ctx as any).archiveTurns([fakeTurn(2, '第二个问题')]);
    await (ctx as any).archiveTurns([fakeTurn(3, '第三个问题')]);

    const index = await readIndex('s1');

    // 旧实现这里只有 [3]
    expect(index.turns.map((t: any) => t.turn)).toEqual([1, 2, 3]);
    // 无主题摘要时 did 退回用户提问（主题分析降级路径）
    expect(index.turns[0].did).toContain('第一个问题');
  });

  it('索引按轮次号升序，模型可据此判断先后', async () => {
    const ctx = makeContext('s2');
    await ctx.initialize();

    // 乱序归档
    await (ctx as any).archiveTurns([fakeTurn(3, 'C')]);
    await (ctx as any).archiveTurns([fakeTurn(1, 'A')]);
    await (ctx as any).archiveTurns([fakeTurn(2, 'B')]);

    const index = await readIndex('s2');
    expect(index.turns.map((t: any) => t.turn)).toEqual([1, 2, 3]);
  });

  it('索引里每轮都能定位到真实存在的文件', async () => {
    const ctx = makeContext('s3');
    await ctx.initialize();
    await (ctx as any).archiveTurns([fakeTurn(1, 'A'), fakeTurn(2, 'B')]);

    const index = await readIndex('s3');
    for (const entry of index.turns) {
      const p = path.join(dir, 's3', 'archive', entry.file);
      // 提示叫模型 read_file 这个路径，文件必须真的在
      await expect(fs.access(p)).resolves.toBeUndefined();
    }
  });

  it('重复归档同一轮不产生重复条目', async () => {
    const ctx = makeContext('s4');
    await ctx.initialize();
    await (ctx as any).archiveTurns([fakeTurn(1, '原始')]);
    await (ctx as any).archiveTurns([fakeTurn(1, '重写')]);

    const index = await readIndex('s4');
    expect(index.turns).toHaveLength(1);
    expect(index.turns[0].did).toContain('重写');
  });

  it('索引文件损坏时不炸压缩流程', async () => {
    const ctx = makeContext('s5');
    await ctx.initialize();
    const archiveDir = path.join(dir, 's5', 'archive');
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.writeFile(path.join(archiveDir, 'index.json'), '{ 坏掉的 json');

    // 压缩是保命机制，不能因为归档索引读不出来就中断
    await expect((ctx as any).archiveTurns([fakeTurn(1, 'A')])).resolves.toBeUndefined();
    const index = await readIndex('s5');
    expect(index.turns.map((t: any) => t.turn)).toEqual([1]);
  });

  it('主题标题与摘要就地展开（映射先于归档建立）', async () => {
    const ctx = makeContext('s6');
    await ctx.initialize();

    // 模拟 compressWithTopicClustering 已填好映射与摘要
    (ctx as any).topicSummaries.set('topic-abc', {
      id: 'topic-abc',
      title: '查看图片内容',
      summary: '识别为界面截图，含医患问诊对话',
      turn_ids: [1],
      keywords: ['截图'],
      timestamp: Date.now(),
    });
    (ctx as any).activeTurnTopics.set(1, 'topic-abc');
    await (ctx as any).archiveTurns([fakeTurn(1, 'A')]);

    const index = await readIndex('s6');
    // 旧实现（先归档后聚类）这里两个字段都是 undefined
    expect(index.turns[0].topic).toBe('查看图片内容');
    // did 是「做了什么 + 结果」，不是用户提问
    expect(index.turns[0].did).toBe('识别为界面截图，含医患问诊对话');
    expect(index.turns[0].did).not.toBe('A');
  });

  it('主题被 pruneTopics 删掉后，归档条目里的 did 依然完整', async () => {
    // 这是展开存储（而非留 topic_id 引用）的核心理由：
    // topicSummaries 是「上下文当前记得的主题」，会被滑动窗口删；
    // 归档条目必须自包含，否则会话变长后索引就失联了
    const ctx = makeContext('s10');
    await ctx.initialize();

    (ctx as any).topicSummaries.set('t-old', {
      id: 't-old', title: '早期主题', summary: '做了早期的事',
      turn_ids: [1], keywords: [], timestamp: Date.now(),
    });
    (ctx as any).activeTurnTopics.set(1, 't-old');
    await (ctx as any).archiveTurns([fakeTurn(1, 'A')]);

    // 模拟 prune：主题从上下文消失
    (ctx as any).topicSummaries.delete('t-old');
    (ctx as any).activeTurnTopics.delete(1);
    await (ctx as any).archiveTurns([fakeTurn(2, 'B')]);

    const index = await readIndex('s10');
    const first = index.turns.find((t: any) => t.turn === 1);
    expect(first.did).toBe('做了早期的事');
    expect(first.topic).toBe('早期主题');
  });

  it('索引不再有 topics 数组（单层，无跨数组引用）', async () => {
    const ctx = makeContext('s11');
    await ctx.initialize();
    await (ctx as any).archiveTurns([fakeTurn(1, 'A')]);

    const index = await readIndex('s11');
    expect(index.topics).toBeUndefined();
    expect(index.turns[0].topic_id).toBeUndefined();
  });
});

describe('给模型的归档提示', () => {
  it('列出真实文件名，不含 turn-XXX 占位符', async () => {
    const ctx = makeContext('s7');
    await ctx.initialize();
    await (ctx as any).archiveTurns([fakeTurn(1, 'A'), fakeTurn(2, 'B')]);

    const msgs = (ctx as any).buildContextMessages(undefined, 2);
    const hint = msgs[msgs.length - 1].content as string;

    expect(hint).toContain('turn-001.json');
    expect(hint).toContain('turn-002.json');
    // 模型没法把 XXX 当参数传给 read_file
    expect(hint).not.toContain('turn-XXX');
  });

  it('不说「早期的 N 轮」——那会被理解成历史总共只有 N 轮', async () => {
    const ctx = makeContext('s8');
    await ctx.initialize();
    // 前两轮已归档，本批只有第 3 轮
    await (ctx as any).archiveTurns([fakeTurn(1, 'A'), fakeTurn(2, 'B')]);
    await (ctx as any).archiveTurns([fakeTurn(3, 'C')]);

    const msgs = (ctx as any).buildContextMessages(undefined, 1);
    const hint = msgs[msgs.length - 1].content as string;

    expect(hint).toContain('已全部归档');
    expect(hint).toContain('共 3 轮');       // 累计，而非本批的 1
    expect(hint).not.toMatch(/早期的 1 轮/);
  });

  it('主题目录带轮次号（否则答不了「第一次」这类问题）', async () => {
    const ctx = makeContext('s9');
    await ctx.initialize();

    (ctx as any).topicSummaries.set('t1', {
      id: 't1',
      title: '图片内容查看',
      summary: '识别为界面截图，含医患问诊对话',
      turn_ids: [2, 1],
      keywords: ['截图'],
      timestamp: Date.now(),
    });

    const msgs = (ctx as any).buildContextMessages(undefined, 0);
    const dir = msgs.find((m: any) =>
      typeof m.content === 'string' && m.content.includes('主题目录')
    );

    expect(dir).toBeDefined();
    expect(dir.content).toContain('第 1-2 轮');
    expect(dir.content).toContain('图片内容查看');

    // 关键：目录里**不含摘要正文**。
    // 摘要会抑制回溯 —— 实测模型拿到它就不去读归档，直接照 60 字复述细节
    expect(dir.content).not.toContain('识别为界面截图');
  });

  it('主题目录按轮次升序（倒序会让模型把最近的当最早的）', async () => {
    const ctx = makeContext('s12');
    await ctx.initialize();

    const now = Date.now();
    // 刻意让「时间上更晚」的主题轮次更小，区分排序依据是轮次还是时间
    (ctx as any).topicSummaries.set('late', {
      id: 'late', title: '后聚类的早期话题', summary: 'x',
      turn_ids: [1], keywords: [], timestamp: now + 1000,
    });
    (ctx as any).topicSummaries.set('early', {
      id: 'early', title: '先聚类的后期话题', summary: 'y',
      turn_ids: [5], keywords: [], timestamp: now,
    });

    const msgs = (ctx as any).buildContextMessages(undefined, 0);
    const dir = msgs.find((m: any) =>
      typeof m.content === 'string' && m.content.includes('主题目录')
    );

    expect(dir.content.indexOf('第 1 轮'))
      .toBeLessThan(dir.content.indexOf('第 5 轮'));
  });
});
