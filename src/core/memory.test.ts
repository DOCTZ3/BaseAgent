// ============================================
// 长期记忆 —— 合并/淘汰/过滤的纯逻辑
// ============================================
//
// 最重要的一组是「抽取器不能删除条目」:抽取器只看一个区间,而
// 「用户要说中文」这类条目可能是十轮前定下、本区间完全没体现的。
// 如果合并按填表式覆写,它们会被静默抹掉 —— 没有报错、没有迹象。
// 所以这里断言的核心性质是**没提到就保留**,而且它必须由代码保证,
// 不是靠 prompt 里写一句「没看到的别删」。
// ============================================

import { describe, it, expect } from 'vitest';
import {
  mergeExtraction,
  looksLikeCredential,
  renderMemoryPrompt,
  renderExistingForExtractor,
  loadMemory,
  saveMemory,
  clearMemory,
  MAX_ENTRIES_PER_DIMENSION,
  MEMORY_KEY,
  type MemoryEntry,
  type MemoryStore,
} from './memory.js';

const T0 = 1_700_000_000_000;

const entry = (
  dimension: MemoryEntry['dimension'],
  text: string,
  hits = 1,
  lastSeen = T0,
): MemoryEntry => ({ dimension, text, hits, lastSeen, createdAt: T0 });

/** 内存版 store,够用且不碰磁盘 */
const makeStore = (): MemoryStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    get: (k) => data.get(k) ?? null,
    set: (k, v) => void data.set(k, v),
    delete: (k) => void data.delete(k),
  };
};

describe('合并:抽取器不能删除条目', () => {
  it('**没提到的条目保留** —— 这是本模块最重要的性质', () => {
    const existing = [entry('language', '用中文应答'), entry('style', '要理由')];
    // 抽取器这次只看到 workflow,完全没提前两条
    const merged = mergeExtraction(
      existing,
      { candidates: [{ dimension: 'workflow', text: '先讨论再动手' }], contradicts: [] },
      T0 + 1000,
    );

    expect(merged.map(e => e.text)).toContain('用中文应答');
    expect(merged.map(e => e.text)).toContain('要理由');
    expect(merged.map(e => e.text)).toContain('先讨论再动手');
  });

  it('空抽取结果不动任何东西', () => {
    const existing = [entry('language', '用中文应答')];
    const merged = mergeExtraction(existing, { candidates: [], contradicts: [] }, T0 + 1000);

    expect(merged).toHaveLength(1);
    expect(merged[0].text).toBe('用中文应答');
  });

  it('只有明确指出矛盾时才替换', () => {
    const existing = [entry('language', '用中文应答')];
    const merged = mergeExtraction(
      existing,
      {
        candidates: [{ dimension: 'language', text: '改用英文应答' }],
        contradicts: [{ index: 0, reason: '用户明确改要英文' }],
      },
      T0 + 1000,
    );

    expect(merged.map(e => e.text)).toEqual(['改用英文应答']);
  });

  it('越界编号被忽略,不删错条目', () => {
    // 模型给错编号时宁可不删 —— 删错是静默丢失
    const existing = [entry('language', '用中文应答')];
    const merged = mergeExtraction(
      existing,
      { candidates: [], contradicts: [{ index: 99, reason: '乱给的编号' }] },
      T0 + 1000,
    );

    expect(merged).toHaveLength(1);
  });
});

describe('重复确认累加 hits', () => {
  it('同一条再次出现时 hits+1 而不是新增一条', () => {
    const merged = mergeExtraction(
      [entry('language', '用中文应答', 2)],
      { candidates: [{ dimension: 'language', text: '用中文应答' }], contradicts: [] },
      T0 + 5000,
    );

    expect(merged).toHaveLength(1);
    expect(merged[0].hits).toBe(3);
    expect(merged[0].lastSeen).toBe(T0 + 5000);
  });

  it('换个标点/大小写/空格算同一条 —— 不该占两个坑', () => {
    const merged = mergeExtraction(
      [entry('language', '用中文应答')],
      { candidates: [{ dimension: 'language', text: '用中文应答。' }], contradicts: [] },
      T0 + 5000,
    );

    expect(merged).toHaveLength(1);
    expect(merged[0].hits).toBe(2);
  });

  it('不同维度的同样文字是两条', () => {
    const merged = mergeExtraction(
      [entry('style', '简洁')],
      { candidates: [{ dimension: 'focus', text: '简洁' }], contradicts: [] },
      T0 + 5000,
    );

    expect(merged).toHaveLength(2);
  });
});

describe('淘汰按 hits 而非时间', () => {
  it('超额时淘汰 hits 最低的,老而稳的条目活下来', () => {
    // 按时间淘汰会让「用中文」这种最老最稳的先死 —— 那恰恰最该留
    const existing = [
      entry('style', '老而稳', 10, T0),
      entry('style', '中等', 5, T0 + 1000),
      entry('style', '偶然一次', 1, T0 + 2000),
    ];
    const merged = mergeExtraction(
      existing,
      { candidates: [{ dimension: 'style', text: '新来的' }], contradicts: [] },
      T0 + 3000,
    );

    const texts = merged.filter(e => e.dimension === 'style').map(e => e.text);
    expect(texts).toHaveLength(MAX_ENTRIES_PER_DIMENSION);
    expect(texts).toContain('老而稳');
    expect(texts).toContain('中等');
    // hits=1 的两条里,lastSeen 近的留下
    expect(texts).toContain('新来的');
    expect(texts).not.toContain('偶然一次');
  });

  it('每个维度独立限额 —— 一个维度写满不影响别的', () => {
    const existing = [
      entry('style', 's1', 3), entry('style', 's2', 3), entry('style', 's3', 3),
    ];
    const merged = mergeExtraction(
      existing,
      { candidates: [{ dimension: 'language', text: '用中文' }], contradicts: [] },
      T0 + 1000,
    );

    expect(merged.filter(e => e.dimension === 'style')).toHaveLength(3);
    expect(merged.filter(e => e.dimension === 'language')).toHaveLength(1);
  });
});

// ============================================
// 凭证形态过滤
// ============================================
//
// 记忆进的是**每一轮**的上下文,写进去就是永久的。
// 所以这一层不能只靠提示词里那句「不要存凭证」—— 代价不对称:
// 错杀一条偏好下次还能再抽到,漏放一次就是永久泄露。
describe('凭证形态过滤', () => {
  it.each([
    ['sk-abcdefghij1234567890XYZ'],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123'],
    ['AKIAIOSFODNN7EXAMPLE'],
    ['-----BEGIN RSA PRIVATE KEY-----'],
    ['xoxb-1234567890-abcdefghij'],
    ['eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0.abc'],
    ['d41d8cd98f00b204e9800998ecf8427e'],
  ])('识别 %s', (s) => {
    expect(looksLikeCredential(s)).toBe(true);
  });

  it('正常的偏好文本不被误判', () => {
    for (const s of ['用中文应答', '要理由不只要结论', '先讨论再动手', '在意安全边界']) {
      expect(looksLikeCredential(s)).toBe(false);
    }
  });

  it('含凭证形态的候选被丢弃,不写进记忆', () => {
    const merged = mergeExtraction(
      [],
      {
        candidates: [
          { dimension: 'focus', text: '用户的 key 是 sk-abcdefghij1234567890XYZ' },
          { dimension: 'language', text: '用中文应答' },
        ],
        contradicts: [],
      },
      T0,
    );

    expect(merged).toHaveLength(1);
    expect(merged[0].text).toBe('用中文应答');
  });
});

describe('渲染进系统提示', () => {
  it('空记忆返回空串 —— 不输出占位,否则模型可能去"补充"它', () => {
    expect(renderMemoryPrompt([])).toBe('');
  });

  it('说清是观察到的倾向、可被本次要求覆盖', () => {
    // 不加这句模型会当硬约束 —— 它对这类概括性输入不会主动质疑
    const text = renderMemoryPrompt([entry('language', '用中文应答')]);

    expect(text).toContain('倾向');
    expect(text).toContain('以这次的要求为准');
    expect(text).toContain('用中文应答');
  });

  it('按维度分组,同维度多条合在一行', () => {
    const text = renderMemoryPrompt([
      entry('style', '要理由'),
      entry('style', '不要废话'),
      entry('language', '用中文'),
    ]);

    expect(text).toContain('要理由；不要废话');
    expect(text.split('\n').filter(l => l.startsWith('- '))).toHaveLength(2);
  });
});

describe('给抽取器看的现有条目', () => {
  it('带编号,且编号与 mergeExtraction 的 index 同源', () => {
    const entries = [entry('language', '用中文'), entry('style', '要理由')];
    const rendered = renderExistingForExtractor(entries);

    expect(rendered).toContain('0. [language] 用中文');
    expect(rendered).toContain('1. [style] 要理由');

    // 编号 1 对应的必须真的是第二条 —— 两处不同源就会删错,而删错是静默的
    const merged = mergeExtraction(
      entries,
      { candidates: [], contradicts: [{ index: 1, reason: '矛盾' }] },
      T0,
    );
    expect(merged.map(e => e.text)).toEqual(['用中文']);
  });

  it('空记忆时给出明确说明,而不是空白', () => {
    expect(renderExistingForExtractor([])).toContain('没有');
  });
});

describe('存储', () => {
  it('存取往返', () => {
    const store = makeStore();
    saveMemory(store, [entry('language', '用中文', 3)]);

    const loaded = loadMemory(store);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].text).toBe('用中文');
    expect(loaded[0].hits).toBe(3);
  });

  it('没存过时返回空数组', () => {
    expect(loadMemory(makeStore())).toEqual([]);
  });

  it('坏数据返回空数组而不是抛错 —— 记忆是增强,不该让 CLI 起不来', () => {
    const store = makeStore();
    store.set(MEMORY_KEY, '{ 这不是 JSON');
    expect(loadMemory(store)).toEqual([]);

    store.set(MEMORY_KEY, JSON.stringify({ version: 99, entries: 'wrong' }));
    expect(loadMemory(store)).toEqual([]);
  });

  it('未知维度的记录被整体拒绝(枚举校验)', () => {
    const store = makeStore();
    store.set(MEMORY_KEY, JSON.stringify({
      version: 1,
      entries: [{ dimension: 'misc', text: 'x', hits: 1, lastSeen: T0, createdAt: T0 }],
    }));

    expect(loadMemory(store)).toEqual([]);
  });

  it('清空', () => {
    const store = makeStore();
    saveMemory(store, [entry('language', '用中文')]);
    clearMemory(store);

    expect(loadMemory(store)).toEqual([]);
  });
});
