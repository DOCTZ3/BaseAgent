// ============================================
// Skill 库 —— 三类静默失败
// ============================================
//
// ① **抽取器覆写掉已有轨迹**。它只看到这一次任务,而库里某条可能是十次会话
//    打磨出来的。按填表式合并会静默抹掉它们 —— 这条规则是记忆那边
//    (mergeExtraction)用血换来的,skill 只会更严重:记忆丢了模型少知道一件事,
//    轨迹丢了模型会重新踩一遍所有坑。
//
// ② **待审批的 skill 混进索引**。描述写得含糊的条目一旦生效,
//    要么永远不被选中(白占预算),要么被选中然后误导模型。
//    而「描述好不好」没有任何自动信号,所以 pending 这道闸门必须严。
//
// ③ **索引膨胀**。它进系统提示、落在缓存前缀里,无上限增长会稀释缓存收益,
//    也会让模型在几十条相似条目间静默乱选。
// ============================================

import { describe, it, expect } from 'vitest';
import {
  loadSkills,
  saveSkills,
  clearSkills,
  activeSkills,
  pendingSkills,
  findSkill,
  renderSkillIndex,
  renderSkillBody,
  renderExistingSkillsForExtractor,
  mergeSkillExtraction,
  SkillExtractionSchema,
  SKILL_KEY,
  MAX_ACTIVE_SKILLS,
  MAX_NAME_LEN,
  MAX_DESC_LEN,
  type Skill,
  type SkillStore,
} from './skill.js';

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
    steps: [{ goal: '进入知乎', how: 'page.goto("https://www.zhihu.com")' }],
    pending: false,
    hits: 0,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

describe('存取', () => {
  it('空库读出空数组', () => {
    expect(loadSkills(makeStore())).toEqual([]);
  });

  it('存了能读回来', () => {
    const store = makeStore();
    saveSkills(store, [skill()]);

    const back = loadSkills(store);
    expect(back).toHaveLength(1);
    expect(back[0].name).toBe('zhihu-hot');
  });

  it('格式坏了按空处理,不抛 —— skill 是增强,读不出来不该让会话起不来', () => {
    const store = makeStore();
    store.set(SKILL_KEY, '{ 这不是合法 JSON');
    expect(loadSkills(store)).toEqual([]);

    store.set(SKILL_KEY, JSON.stringify({ version: 99, skills: [] }));
    expect(loadSkills(store)).toEqual([]);
  });

  it('clearSkills 删掉整个键', () => {
    const store = makeStore();
    saveSkills(store, [skill()]);
    clearSkills(store);
    expect(store.data.has(SKILL_KEY)).toBe(false);
  });
});

describe('pending 闸门', () => {
  it('activeSkills 只给审批过的', () => {
    const list = [skill({ name: 'a' }), skill({ name: 'b', pending: true })];
    expect(activeSkills(list).map(s => s.name)).toEqual(['a']);
    expect(pendingSkills(list).map(s => s.name)).toEqual(['b']);
  });

  it('索引里**不出现**待审批的 —— 含糊的描述不该占预算', () => {
    const idx = renderSkillIndex([
      skill({ name: 'good', description: '搜索知乎热搜榜' }),
      skill({ name: 'vague', description: '知乎相关操作', pending: true }),
    ]);

    expect(idx).toContain('good');
    expect(idx).not.toContain('vague');
  });

  it('全是待审批时索引为空串 —— 不留一个空标题段', () => {
    expect(renderSkillIndex([skill({ pending: true })])).toBe('');
  });
});

describe('索引渲染', () => {
  it('只有名字和描述,轨迹正文一个字都不进', () => {
    const idx = renderSkillIndex([
      skill({ steps: [{ goal: '这是轨迹内容', how: '这是具体做法XYZ' }] }),
    ]);

    expect(idx).toContain('zhihu-hot');
    expect(idx).toContain('搜索知乎热搜榜');
    // 正文进了提示就会让缓存前缀每轮变动 —— 那是整个设计要避免的东西
    expect(idx).not.toContain('这是轨迹内容');
    expect(idx).not.toContain('XYZ');
  });

  it('命中多的排前面 —— hits 是唯一可信的有用度信号', () => {
    const idx = renderSkillIndex([
      skill({ name: 'cold', hits: 0 }),
      skill({ name: 'hot', hits: 9 }),
    ]);
    expect(idx.indexOf('hot')).toBeLessThan(idx.indexOf('cold'));
  });

  it(`索引上限 ${MAX_ACTIVE_SKILLS} 条 —— 无上限会稀释缓存收益`, () => {
    const many = Array.from({ length: MAX_ACTIVE_SKILLS + 8 }, (_, i) =>
      skill({ name: `s${i}`, hits: i }),
    );
    const lines = renderSkillIndex(many).split('\n').filter(l => l.startsWith('- '));
    expect(lines).toHaveLength(MAX_ACTIVE_SKILLS);
  });

  it('提示里说明做法会过期 —— 否则模型会反复重试失效的路', () => {
    const idx = renderSkillIndex([skill()]);
    expect(idx).toContain('过期');
    expect(idx).toContain('load_skill');
  });
});

describe('正文渲染', () => {
  it('目的与做法分开呈现', () => {
    const body = renderSkillBody(
      skill({
        steps: [
          { goal: '获取热搜榜单', how: 'aria_snapshot 取 body' },
          { goal: '返回标题' },
        ],
      }),
    );

    expect(body).toContain('1. 获取热搜榜单');
    expect(body).toContain('(做法:aria_snapshot 取 body)');
    // 没有 how 的步骤不留空括号
    expect(body).toContain('2. 返回标题');
    expect(body).not.toContain('(做法:)');
  });

  it('pitfalls 和 note 都呈现出来', () => {
    const body = renderSkillBody(
      skill({ pitfalls: ['tophub 的榜单是缓存,可能过期'], note: '截至 2026-08' }),
    );
    expect(body).toContain('tophub 的榜单是缓存');
    expect(body).toContain('截至 2026-08');
  });

  it('没有 pitfalls 时不留空标题', () => {
    expect(renderSkillBody(skill())).not.toContain('已知不通的路');
  });
});

describe('抽取器的输入', () => {
  it('现有列表包含待审批的 —— 否则同一件事会在待审列表里堆好几条', () => {
    const rendered = renderExistingSkillsForExtractor([
      skill({ name: 'live' }),
      skill({ name: 'waiting', pending: true }),
    ]);

    expect(rendered).toContain('live');
    expect(rendered).toContain('waiting');
    expect(rendered).toContain('待审批');
  });

  it('空库给出明确说明,不是空串', () => {
    // 空串会让抽取提示里出现一段悬空的标题,模型可能以为输入被截断了
    expect(renderExistingSkillsForExtractor([])).toContain('没有');
  });
});

describe('mergeSkillExtraction', () => {
  const good = {
    worth: true,
    name: 'weibo-hot',
    description: '搜索微博热搜并返回标题',
    steps: [{ goal: '进入微博', how: 'goto' }],
  };

  it('worth:false 时什么都不动', () => {
    const before = [skill()];
    const r = mergeSkillExtraction(before, { worth: false, reason: '一次性问答' }, T0);

    expect(r.changed).toBe('none');
    expect(r.skills).toEqual(before);
  });

  it('新条目一律 pending —— 审批前不生效', () => {
    const r = mergeSkillExtraction([], good, T0);

    expect(r.changed).toBe('added');
    expect(r.skills).toHaveLength(1);
    expect(r.skills[0].pending).toBe(true);
    expect(r.skills[0].hits).toBe(0);
    expect(activeSkills(r.skills)).toHaveLength(0);
  });

  it('**不删除**已有条目 —— 抽取器只看到这一次任务', () => {
    // 这条是整个文件里最重要的断言。记忆那边同形的规则是用一个
    // 「十轮前定下的偏好被静默抹掉」的事故换来的
    const existing = [skill({ name: 'zhihu-hot', hits: 12 })];
    const r = mergeSkillExtraction(existing, good, T0 + 1000);

    expect(r.skills).toHaveLength(2);
    expect(findSkill(r.skills, 'zhihu-hot')).toBeDefined();
    expect(findSkill(r.skills, 'zhihu-hot')!.hits).toBe(12);
  });

  // 名字比对必须**归一化**。原先是 `s.name === name`,而抽取模型两次写出的
  // 名字只要差一个空格,就会被当成两条不同的轨迹 push 进库 ——
  // 界面上是两个看起来一模一样的名字,各带一半步骤,谁也不完整。
  // 而且它绕过了「保留 hits」那条规则:新条目 hits 从 0 开始,
  // 老条目的资历被一条同名残缺条目稀释掉。实测踩到(见 skill.ts 的注释)。
  it.each([
    ['前后空格', ' weibo-hot '],
    ['中间空格', 'weibo -hot'],
    ['大小写', 'Weibo-Hot'],
  ])('名字只差%s时视为**更新**,不新建', (_label, variant) => {
    const existing = [skill({ name: 'weibo-hot', hits: 7 })];
    const r = mergeSkillExtraction(existing, { ...good, name: variant }, T0 + 5000);

    expect(r.changed).toBe('updated');
    expect(r.skills).toHaveLength(1);
    expect(r.skills[0].hits).toBe(7);          // 资历没被稀释
    expect(r.skills[0].name).toBe('weibo-hot'); // 存的仍是库里那个名字
  });

  it('更新时回报**库里那个名字**,不是这次抽出来的', () => {
    // 两者可能只差一个空格。日志里打新名字会让人以为库里存的是新的那个,
    // 而按那个名字去查压根查不到
    const existing = [skill({ name: 'weibo-hot' })];
    const r = mergeSkillExtraction(existing, { ...good, name: 'Weibo-Hot' }, T0 + 5000);
    expect(r.name).toBe('weibo-hot');
  });

  it('归一化**不跨标点**合并 —— 那可能真是两件事', () => {
    // 去空白和大小写是安全的(中文名不受大小写影响,空白是模型最常见的抖动),
    // 但去标点会把「导出-CSV」和「导出CSV」并成一条,而它们未必等价
    const existing = [skill({ name: '导出-CSV' })];
    const r = mergeSkillExtraction(existing, { ...good, name: '导出CSV' }, T0 + 5000);

    expect(r.changed).toBe('added');
    expect(r.skills).toHaveLength(2);
  });

  it('findSkill 也走同一套归一化 —— load_skill 与审批都靠它', () => {
    const skills = [skill({ name: 'weibo-hot' })];
    expect(findSkill(skills, 'weibo-hot')).toBeDefined();   // 严格相等仍是第一顺位
    expect(findSkill(skills, ' Weibo-Hot ')).toBeDefined();
    expect(findSkill(skills, '不存在的')).toBeUndefined();
  });

  it('同名视为更新,**保留 hits 与 createdAt**(那是它的资历)', () => {
    const existing = [skill({ name: 'weibo-hot', hits: 7, createdAt: T0 })];
    const r = mergeSkillExtraction(
      existing,
      { ...good, description: '改进后的描述' },
      T0 + 5000,
    );

    expect(r.changed).toBe('updated');
    expect(r.skills).toHaveLength(1);

    const s = r.skills[0];
    expect(s.description).toBe('改进后的描述');
    expect(s.hits).toBe(7);            // 重置会让淘汰排序错乱
    expect(s.createdAt).toBe(T0);
    expect(s.updatedAt).toBe(T0 + 5000);
    expect(s.pending).toBe(true);      // 内容变了要再看一眼
  });

  it('更新时未提供的字段保留原值 —— 不是填表式覆写', () => {
    const existing = [
      skill({ name: 'weibo-hot', pitfalls: ['原有的坑'], note: '原有的备注' }),
    ];
    const r = mergeSkillExtraction(existing, good, T0);

    expect(r.skills[0].pitfalls).toEqual(['原有的坑']);
    expect(r.skills[0].note).toBe('原有的备注');
  });

  it('缺名字/描述/轨迹任一项都不入库', () => {
    for (const bad of [
      { worth: true, description: 'd', steps: good.steps },        // 无名字
      { worth: true, name: 'n', steps: good.steps },               // 无描述
      { worth: true, name: 'n', description: 'd' },                // 无轨迹
      { worth: true, name: 'n', description: 'd', steps: [] },     // 空轨迹
    ]) {
      expect(mergeSkillExtraction([], bad as never, T0).changed).toBe('none');
    }
  });

  it('名字与描述被截断到上限 —— 索引预算必须可算', () => {
    const r = mergeSkillExtraction(
      [],
      { ...good, name: 'x'.repeat(200), description: 'y'.repeat(500) },
      T0,
    );

    expect(r.skills[0].name).toHaveLength(MAX_NAME_LEN);
    expect(r.skills[0].description).toHaveLength(MAX_DESC_LEN);
  });

  it('名字两端空白被去掉 —— 否则 " a" 和 "a" 会各占一条', () => {
    const r = mergeSkillExtraction([skill({ name: 'weibo-hot' })], { ...good, name: '  weibo-hot  ' }, T0);
    expect(r.changed).toBe('updated');
    expect(r.skills).toHaveLength(1);
  });
});

describe('SkillExtractionSchema', () => {
  it('worth 之外全部可选 —— 模型说「不值得」时不该被迫编内容', () => {
    expect(SkillExtractionSchema.safeParse({ worth: false }).success).toBe(true);
  });

  it('缺 worth 直接拒 —— 那是唯一的必答项', () => {
    expect(SkillExtractionSchema.safeParse({ name: 'a' }).success).toBe(false);
  });

  it('steps 里 goal 必填、how 可选', () => {
    expect(
      SkillExtractionSchema.safeParse({ worth: true, steps: [{ goal: 'g' }] }).success,
    ).toBe(true);
    expect(
      SkillExtractionSchema.safeParse({ worth: true, steps: [{ how: 'h' }] }).success,
    ).toBe(false);
  });
});
