// ============================================
// Core 层:Skill —— 可复用的任务轨迹
// ============================================
//
// 一条 skill 是「做成过一件事的流程指引」,内容是**文本**而非代码:
// 文本能说明「为什么这么做」和「哪条路不通」,而代码只能表达「怎么做」,
// 且依赖归纳模型不出错(它写错了要到运行时才知道)。
//
// 为什么不把正文放进系统提示:
//
// ① **prompt cache**。系统提示是缓存前缀里最稳定的部分 ——
//    实测缓存命中率 60~77%(cached_tokens 按 1024 对齐)。
//    每轮按请求注入不同的 skill 正文会让整段前缀失效,那个代价比
//    多一次工具调用大得多。所以提示里只放**索引**(名字 + 一行描述),
//    正文由 load_skill 工具按需取。
//
// ② **权限**。正文由工具在 TS 侧读取,沙箱代码完全够不到 store ——
//    不需要给 skill 目录加 fs 授权,也就没有「模型改自己的行为规则」的风险
//    (与 .agent-memory.db / .sandbox-venv 必须在工作区外同一条约束,
//    但这里靠结构就满足了)。
//
// ③ **可见性**。走工具通道意味着 skill 加载会产生 tool_start / tool_end 事件,
//    界面上能看到「加载了哪个 skill」,trace 里也留痕。两条相似 skill 竞争时
//    模型选了哪个是可审计的 —— 而注入式做法里这个选择完全不可见。
//
// 代价是每次用 skill 多一个 round trip。按实测的首字延迟地板(5.79s),
// 那是 6~12 秒。所以 skill 的粒度必须是「一件完整的事」
// (搜知乎热搜),不能是「一个动作」(打开知乎)—— 后者会让模型
// 连着调好几次 load_skill,那就不划算了。
//
// 轨迹里**目的与手段分开写**:腐烂是按步发生的。网站改版后模型走到第 2 步
// 失败,只写手段的话它只会重复失败;目的清楚时它能自己重新找路。
// ============================================

import { z } from 'zod';
import type { Logger } from '../platform/index.js';

/** skill 的存储接口 —— 与 MemoryStore 同形,复用同一个 Storage 实例 */
export interface SkillStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

/**
 * 全局一份,不按 session 分 —— skill 的意义就是跨会话复用
 *
 * 与 MEMORY_KEY 同库不同 key:ABI 问题刚修好(better-sqlite3 要按
 * Electron 重编),不必为此再引一个存储依赖。
 */
export const SKILL_KEY = 'skills:library:v1';

/** 索引里最多列多少条 —— 超出的按命中数淘汰 */
export const MAX_ACTIVE_SKILLS = 20;

/** 名字与描述的长度上限。索引进系统提示,预算要可算 */
export const MAX_NAME_LEN = 40;
export const MAX_DESC_LEN = 120;

export interface SkillStep {
  /** 这一步要达成什么 —— **耐久**,网站改版也不变 */
  goal: string;
  /** 当时的做法 —— 会过期。失效时模型据 goal 自己重新找路 */
  how?: string;
}

export interface Skill {
  /** 调用名,模型用它作为 load_skill 的参数。全库唯一 */
  name: string;
  /** 一行描述。它决定模型会不会选中这条 skill —— 整个系统的成败在这里 */
  description: string;
  /** 轨迹。顺序即执行顺序 */
  steps: SkillStep[];
  /** 已知不通的路。往往比正确路径更值钱 */
  pitfalls?: string[];
  /**
   * 待审批 = true。**审批前不进索引、不可加载**
   *
   * 抽取模型写出「知乎相关操作」这种描述时,这条 skill 等于不存在
   * (模型永远不会选它),而没有任何自动信号能发现这件事。
   * 所以早期一律人工过一遍。
   */
  pending: boolean;
  /** 被 load_skill 取用的次数 —— 淘汰依据 */
  hits: number;
  /** 最后一次取用之后任务成功的时间。腐烂的 skill 靠它暴露 */
  lastOkAt?: number;
  createdAt: number;
  updatedAt: number;
  /** 沉淀时的依据,写清「截至何时如此」让陈旧可见 */
  note?: string;
}

// ---------- 存取 ----------

const StoredSchema = z.object({
  version: z.literal(1),
  skills: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      steps: z.array(z.object({ goal: z.string(), how: z.string().optional() })),
      pitfalls: z.array(z.string()).optional(),
      pending: z.boolean(),
      hits: z.number(),
      lastOkAt: z.number().optional(),
      createdAt: z.number(),
      updatedAt: z.number(),
      note: z.string().optional(),
    }),
  ),
});

/**
 * 读全库(含待审批的)
 *
 * 格式坏了返回空数组而不抛 —— skill 是增强,读不出来不该让会话起不来
 * (与 loadMemory 同一条原则)。
 */
export function loadSkills(store: SkillStore, logger?: Logger): Skill[] {
  const raw = store.get(SKILL_KEY);
  if (!raw) return [];

  try {
    const parsed = StoredSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      logger?.warn('skill 库格式不符,按空处理', { key: SKILL_KEY });
      return [];
    }
    return parsed.data.skills;
  } catch {
    logger?.warn('skill 库解析失败,按空处理', { key: SKILL_KEY });
    return [];
  }
}

export function saveSkills(store: SkillStore, skills: readonly Skill[]): void {
  store.set(SKILL_KEY, JSON.stringify({ version: 1, skills }));
}

export function clearSkills(store: SkillStore): void {
  store.delete(SKILL_KEY);
}

/** 已生效的(审批过的)。索引和加载都只看这些 */
export function activeSkills(skills: readonly Skill[]): Skill[] {
  return skills.filter(s => !s.pending);
}

/** 待审批的 —— 审批 UI 用 */
export function pendingSkills(skills: readonly Skill[]): Skill[] {
  return skills.filter(s => s.pending);
}

/**
 * 名字归一化 —— **只用于比对**,存储和展示一律用原样的名字
 *
 * 严格字符串相等在这里不够用,而且失败得很难看:抽取模型两次写出的名字
 * 只要差一个空格、一个全角/半角标点,或者刚好在 MAX_NAME_LEN 处截断位置不同,
 * 就会被当成两条不同的轨迹 push 进库 —— 界面上是两个**看起来一模一样**的名字,
 * 而且各自带一半步骤,谁也不完整(实测踩到)。
 *
 * 去掉所有空白 + 转小写就够:中文名不受大小写影响,而空白是模型最常见的抖动。
 * 不做更激进的归一(如去标点):那会把「导出-CSV」和「导出CSV」并成一条,
 * 而它们可能真是两件事。
 */
function normalizeName(name: string): string {
  return name.replace(/\s+/g, '').toLowerCase();
}

export function findSkill(skills: readonly Skill[], name: string): Skill | undefined {
  const target = normalizeName(name);
  // 先试严格相等:模型照着索引原样抄名字时这是常态,一次命中不必扫两遍
  return skills.find(s => s.name === name)
    ?? skills.find(s => normalizeName(s.name) === target);
}

// ---------- 渲染 ----------

/**
 * 索引 —— 进系统提示的那一段
 *
 * **只有名字和描述**,正文一个字都不进。这是整个设计的前提:
 * 索引落在缓存前缀里,首次之后近乎免费;正文若每轮注入会让缓存整段失效。
 * 一条约 20~30 token,20 条上限约 500~600 —— 对照实测的 prompt 规模
 * (3.5k~11k)可控。
 *
 * 待审批的**不列**:描述含糊的 skill 列出来只会浪费预算和误导选择。
 */
export function renderSkillIndex(skills: readonly Skill[]): string {
  const active = activeSkills(skills);
  if (active.length === 0) return '';

  // 命中多的排前面 —— 模型对靠前的条目更敏感,而命中数是唯一可信的有用度信号
  const ordered = [...active].sort((a, b) => b.hits - a.hits).slice(0, MAX_ACTIVE_SKILLS);

  const lines = ordered.map(s => `- ${s.name}: ${s.description}`);

  return [
    '## 可用技能',
    '',
    '以下是之前做成过的任务轨迹。遇到相似任务时**先用 load_skill 取出轨迹**,',
    '照着走比自己摸索快得多(也少踩已知的坑)。名字即调用参数。',
    '',
    ...lines,
    '',
    '轨迹里的「做法」可能已经过期(网站改版、接口变更)。走不通时按「目标」',
    '自己重新找路,不要反复重试同一个失效的做法。',
  ].join('\n');
}

/** 正文 —— load_skill 返回给模型的东西 */
export function renderSkillBody(skill: Skill): string {
  const parts = [`# ${skill.name}`, '', skill.description, ''];

  if (skill.note) {
    parts.push(`> ${skill.note}`, '');
  }

  parts.push('## 轨迹', '');
  skill.steps.forEach((s, i) => {
    parts.push(`${i + 1}. ${s.goal}`);
    // 手段缩进一层,与目的在视觉上分开 —— 前者会过期,后者耐久
    if (s.how) parts.push(`   (做法:${s.how})`);
  });

  if (skill.pitfalls?.length) {
    parts.push('', '## 已知不通的路', '');
    parts.push(...skill.pitfalls.map(p => `- ${p}`));
  }

  return parts.join('\n');
}

// ---------- 抽取 ----------

/**
 * 抽取结果的结构
 *
 * `worth: false` 是**必须给模型的选项**。触发条件只看得到步数和失败数,
 * 而「这次有没有可复用的东西」要看实际轨迹才知道 ——
 * 让抽取模型有权说「不值得」比我们在触发条件上猜要准。
 */
export const SkillExtractionSchema = z.object({
  worth: z.boolean(),
  reason: z.string().optional(),
  /** 复用已有 skill 的名字 = 更新它;新名字 = 新建 */
  name: z.string().optional(),
  description: z.string().optional(),
  steps: z.array(z.object({ goal: z.string(), how: z.string().optional() })).optional(),
  pitfalls: z.array(z.string()).optional(),
  note: z.string().optional(),
});

export type SkillExtraction = z.infer<typeof SkillExtractionSchema>;

export const SKILL_EXTRACTION_SYSTEM_PROMPT = [
  '你在从一次已完成的任务里总结**可复用的工作轨迹**。',
  '',
  '判据(先判断值不值得,再写内容):',
  '- 只有「换个对象还能照着做一遍」的流程才值得记。一次性的问答、',
  '  纯查询、只调了一两个工具就完成的事,一律 worth: false。',
  '- 已有轨迹能覆盖这次任务时,**更新那一条**(用它原本的名字),不要新建近似的。',
  '',
  '写法要求:',
  '- description 决定它将来会不会被选中,必须具体到能判断适用场景。',
  '  「知乎相关操作」这种等于没写;「搜索知乎热搜榜并返回条目标题」才可用。',
  '- 每步分开写「目标」和「做法」。目标是耐久的(要达成什么),',
  '  做法会过期(当时用了哪个选择器、哪个接口)。只写做法的轨迹在环境变化后',
  '  会让人反复重试失效的路。',
  '- 踩过的坑写进 pitfalls,它往往比正确路径更值钱。',
  '- note 里写清依据的时间点,让陈旧可见(例如「截至 2026-08,该站导出在设置页」)。',
  '',
  '**不要删除或改名已有的轨迹。** 你只看到了这一次任务,',
  '而某条轨迹可能是十次会话打磨出来的。只允许新增,或更新你明确认得出的那一条。',
  '',
  '只返回 JSON,不要任何解释文字。',
].join('\n');

/**
 * 把现有 skill 列给抽取器 —— 防止重复沉淀
 *
 * 不给的话每次成功都会新建一条,很快就是五十条「搜知乎热搜」。
 * 与记忆那边的 renderExistingForExtractor 同一个作用。
 * 待审批的**也要列**:否则同一件事会在待审列表里堆好几条。
 */
export function renderExistingSkillsForExtractor(skills: readonly Skill[]): string {
  if (skills.length === 0) return '(当前没有已记录的轨迹)';

  return skills
    .map(s => `- ${s.name}${s.pending ? '(待审批)' : ''}: ${s.description}`)
    .join('\n');
}

/**
 * 合并抽取结果 —— **只新增或更新,绝不删除**
 *
 * 这条规则是记忆那边用血换来的:抽取器只看到一个区间,
 * 而库里的条目可能是十次会话攒出来的。按填表式覆写会静默抹掉它们。
 *
 * 新条目一律 pending:审批前不进索引、不可加载。
 * 更新已有条目时**保留 hits 和 createdAt** —— 那是它的资历,
 * 重置会让淘汰排序错乱。更新后重新转 pending 待审。
 */
export function mergeSkillExtraction(
  existing: readonly Skill[],
  extraction: SkillExtraction,
  now: number,
): { skills: Skill[]; changed: 'added' | 'updated' | 'none'; name?: string } {
  if (!extraction.worth) return { skills: [...existing], changed: 'none' };

  const name = extraction.name?.trim().slice(0, MAX_NAME_LEN);
  const description = extraction.description?.trim().slice(0, MAX_DESC_LEN);
  const steps = extraction.steps;

  // 三样缺一个就没法用:没名字调不出来,没描述不会被选中,没轨迹等于空壳
  if (!name || !description || !steps?.length) {
    return { skills: [...existing], changed: 'none' };
  }

  const skills = [...existing];
  // 归一化比对 —— **这一行正是重名 bug 的来源**。
  //
  // 原先是 `s.name === name`。抽取模型两次写出的名字差一个空格、一个全角标点,
  // 或在 MAX_NAME_LEN 处截断位置不同,就配不上 → 走下面的 push 新建一条,
  // 于是库里出现两个看起来一模一样的名字,各带一半步骤(实测踩到)。
  //
  // 命中之后写入用的仍是**老条目的名字**(见下面的 ...old),不用新抽出来的:
  // 抽取提示词明确要求「不要改名已有的轨迹」,而名字是 load_skill 的调用参数 ——
  // 悄悄改掉会让模型按索引里读到的名字去取,却取不到。
  const idx = skills.findIndex(s => normalizeName(s.name) === normalizeName(name));

  if (idx >= 0) {
    const old = skills[idx];
    skills[idx] = {
      ...old,
      description,
      steps,
      pitfalls: extraction.pitfalls ?? old.pitfalls,
      note: extraction.note ?? old.note,
      // 资历保留,审批状态重置 —— 内容变了就该再看一眼
      pending: true,
      updatedAt: now,
    };
    // 回报**库里那个名字**,不是这次抽出来的。两者可能只差一个空格,
    // 而日志里打新名字会让人以为库里存的是新的那个,查起来对不上
    return { skills, changed: 'updated', name: old.name };
  }

  skills.push({
    name,
    description,
    steps,
    pitfalls: extraction.pitfalls,
    note: extraction.note,
    pending: true,
    hits: 0,
    createdAt: now,
    updatedAt: now,
  });
  return { skills, changed: 'added', name };
}
