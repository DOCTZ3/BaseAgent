// ============================================
// Core 层:长期记忆(用户特征)
// ============================================
//
// 与 ContextManager 的摘要是**两件事**,不能混:
// - 摘要是为了让**这次会话**能继续(做了什么 + 结果),按会话存,会过期
// - 记忆是为了让**下次会话**知道你是谁(习惯 / 偏好),跨会话,变化极慢
// 混在一起的后果是会话摘要被当长期记忆越攒越多,而真正该记的偏好被压缩掉。
//
// 三条刻意的设计约束:
//
// ① **抽取器不能删除条目。** 它只输出「这个区间里看到证据的候选」,
//    合并由代码做:默认全部保留,只在它明确指出矛盾时替换。
//    如果让它输出整张表(填表式覆写),那么「用户要说中文」这种十轮前定下、
//    本区间没体现的条目会被静默抹掉 —— 而这种丢失你不会发现。
//    这一点必须是**结构保证**,不能靠 prompt 里写一句「没看到的别删」。
//
// ② **维度是枚举,没有 misc 兜底。** 分维度的全部价值是把抽取从开放式生成
//    变成填表 —— 有兜底维度就会什么都往里塞(「用户在做知乎热搜任务」这类
//    一次性事实)。不属于任何维度的东西就该被挡在外面。
//    也刻意**不设**「当前在做什么」维度:那类信息按天过期,而记忆是永久注入的,
//    过期的项目描述会持续误导。它归 ContextManager 的摘要。
//
// ③ **淘汰按 hits,不按时间。** 按时间会让越老越稳定的条目先死,
//    而那恰恰是最该留的(「说中文」永远不变,偶然出现一次的才该沉底)。
//
// 模型**没有**维护记忆的工具。理由是 context.ts 里那条实测:
// 模型拿到摘要后会在 reasoning 里判定「已经足够明确」,于是照着复述,
// 廉价的近似答案挤掉准确答案而且看起来可信。错的记忆会以完全一样的方式
// 抑制它去核实,所以人必须能看见和推翻,模型不该能改。
// 用户侧只给最便宜的两个口子:列出、整体清空(不做逐条编辑 ——
// 那是把负担和「给自己定性」推给用户)。
// ============================================

import { z } from 'zod';
import type { Logger } from '../platform/index.js';

/**
 * 记忆维度
 *
 * 通用优先,不写成技术栈那一类 —— 记忆要在非编程场景下同样成立。
 */
export const MEMORY_DIMENSIONS = [
  'language',    // 语言与称呼:用什么语言应答、怎么称呼
  'style',       // 表达风格:详略、要不要讲理由、格式偏好
  'workflow',    // 协作方式:怎么推进事情(先讨论再动手 / 直接给结果)
  'focus',       // 在意什么:反复关注的点(安全、成本、可维护性)
  'background',  // 背景与熟悉度:需要解释到什么程度
  'taboo',       // 明确禁忌:说过「不要…」的事
] as const;

export type MemoryDimension = (typeof MEMORY_DIMENSIONS)[number];

/** 维度中文名(给提示词和 /memory 显示用,两处同源) */
export const DIMENSION_LABELS: Record<MemoryDimension, string> = {
  language: '语言与称呼',
  style: '表达风格',
  workflow: '协作方式',
  focus: '在意什么',
  background: '背景与熟悉度',
  taboo: '明确禁忌',
};

/** 每个维度最多留几条。限条数而非总字数:限总字数会让一个维度写长了挤掉别的维度 */
export const MAX_ENTRIES_PER_DIMENSION = 3;

export interface MemoryEntry {
  dimension: MemoryDimension;
  /** 一句话,尽量短 */
  text: string;
  /** 被重复确认的次数。淘汰按这个,不按时间 */
  hits: number;
  /** 最近一次被确认的时间(仅用于同 hits 时的次级排序与展示) */
  lastSeen: number;
  /** 首次写入时间 */
  createdAt: number;
}

/** 抽取器的输出:候选条目 + 明确指出的矛盾。**没有删除字段** */
export const ExtractionSchema = z.object({
  candidates: z
    .array(
      z.object({
        dimension: z.enum(MEMORY_DIMENSIONS),
        text: z.string().min(2).max(80),
      }),
    )
    .default([]),
  /** 与现有条目矛盾时,指出被取代的那条(按传给它的编号) */
  contradicts: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        reason: z.string().min(2).max(120),
      }),
    )
    .default([]),
});

export type Extraction = z.infer<typeof ExtractionSchema>;

// ============================================
// 凭证形态过滤
// ============================================
//
// **必须有,且不能只靠提示词。** 今天刚做的读黑名单理由是「值一旦进上下文
// 就发出去且撤不回」,而记忆比那更糟 —— 它进的是**每一轮**的上下文。
// 用户在对话里贴过一次 key,抽取器要是写下「用户的 key 是 sk-...」,那就永久了。
//
// 这里判的是**形态**不是语义:提示词里写「不要存凭证」是让模型自律,
// 而自律在这件事上不够 —— 代价不对称(漏一次就是永久泄露)。
const CREDENTIAL_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}/,           // OpenAI / DeepSeek 一类
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,   // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,    // Slack
  /\bAKIA[0-9A-Z]{16}\b/,              // AWS access key id
  /\bAIza[0-9A-Za-z_-]{30,}/,          // Google
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,  // JWT
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/,      // 长 base64
  /\b[0-9a-fA-F]{32,}\b/,              // 长 hex(MD5 长度起)
];

/**
 * 是否含凭证形态的内容
 *
 * 宁可错杀:被判中的候选**直接丢弃**,不写进记忆。
 * 错杀的代价是少记一条偏好(下次还能再抽到),漏放的代价是永久泄露。
 */
export function looksLikeCredential(text: string): boolean {
  return CREDENTIAL_PATTERNS.some(re => re.test(text));
}

// ============================================
// 合并 —— 这段是「抽取器不能删除」的实现处
// ============================================

/** 归一化用于判重:同一条偏好换个说法不该占两个坑 */
function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/[\s,，。.、;；:：!！?？]+/g, '');
}

/**
 * 把一次抽取结果并进现有记忆
 *
 * **默认全部保留** —— 只有抽取器明确指出矛盾的条目会被替换。
 * 这一条是本模块最重要的性质:抽取器只看一个区间,而「用户要说中文」
 * 这类条目可能是十轮前定下、本区间完全没体现的。让它输出整张表(填表式覆写)
 * 就会静默抹掉那些条目,而这种丢失没有任何迹象。
 *
 * @param existing 现有条目(顺序必须与传给抽取器时的编号一致)
 * @param extraction 抽取器输出
 * @param now 当前时间戳(注入以便测试)
 */
export function mergeExtraction(
  existing: readonly MemoryEntry[],
  extraction: Extraction,
  now: number = Date.now(),
): MemoryEntry[] {
  // 先按编号收集被取代的条目。越界编号直接忽略 ——
  // 模型给错编号时宁可不删,不能删错(删错是静默丢失)
  const replaced = new Set(
    extraction.contradicts
      .map(c => c.index)
      .filter(i => i >= 0 && i < existing.length),
  );

  const result: MemoryEntry[] = existing
    .filter((_, i) => !replaced.has(i))
    .map(e => ({ ...e }));

  for (const cand of extraction.candidates) {
    // 凭证形态直接丢弃,不进记忆。记忆是每轮注入的,写进去就是永久
    if (looksLikeCredential(cand.text)) continue;

    const key = normalize(cand.text);
    if (!key) continue;

    const hit = result.find(e => e.dimension === cand.dimension && normalize(e.text) === key);
    if (hit) {
      // 再次看到同样的模式 —— 这是淘汰时能活下来的依据
      hit.hits += 1;
      hit.lastSeen = now;
      continue;
    }

    result.push({
      dimension: cand.dimension,
      text: cand.text.trim(),
      hits: 1,
      lastSeen: now,
      createdAt: now,
    });
  }

  return evictPerDimension(result);
}

/**
 * 按维度限条数
 *
 * 淘汰按 **hits** 而非时间:按时间会让越老越稳定的条目先死,
 * 而那恰恰最该留(「说中文」永远不变,偶然出现一次的才该沉底)。
 * hits 相同时才比 lastSeen(近的留下)。
 */
function evictPerDimension(entries: MemoryEntry[]): MemoryEntry[] {
  const kept: MemoryEntry[] = [];

  for (const dim of MEMORY_DIMENSIONS) {
    const inDim = entries
      .filter(e => e.dimension === dim)
      .sort((a, b) => b.hits - a.hits || b.lastSeen - a.lastSeen);
    kept.push(...inDim.slice(0, MAX_ENTRIES_PER_DIMENSION));
  }

  return kept;
}

// ============================================
// 注入上下文的渲染
// ============================================

/**
 * 渲染成系统提示里的一段
 *
 * 空记忆返回空串 —— 不要输出「暂无记忆」之类的占位:
 * 那会让模型以为记忆功能存在但没内容,进而可能去「补充」它。
 *
 * 措辞上必须说清这是**观察到的倾向、可能过时**。不加这句的话,
 * 模型会把它当硬约束 —— 而 context.ts 里那条实测说明它对这类
 * 概括性输入不会主动质疑(拿到摘要就照着复述,不去核实)。
 */
export function renderMemoryPrompt(entries: readonly MemoryEntry[]): string {
  if (entries.length === 0) return '';

  const lines: string[] = [];
  for (const dim of MEMORY_DIMENSIONS) {
    const inDim = entries.filter(e => e.dimension === dim);
    if (inDim.length === 0) continue;
    lines.push(`- ${DIMENSION_LABELS[dim]}：${inDim.map(e => e.text).join('；')}`);
  }

  if (lines.length === 0) return '';

  return (
    '关于这位用户（从以往对话里观察到的倾向，不是硬性指令；' +
    '与他这次的明确要求冲突时，以这次的要求为准）：\n' +
    lines.join('\n') +
    '\n'
  );
}

// ============================================
// 存储 —— 用现成的 kv_store,不建新表
// ============================================

/** 只依赖三个方法,避免耦合具体 Storage 实现(与 ExecutorLogger 同样的窄接口) */
export interface MemoryStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

/** 全局一份,不按 session 分 —— 长期记忆的意义就是跨会话 */
export const MEMORY_KEY = 'memory:user-profile:v1';

const StoredSchema = z.object({
  version: z.literal(1),
  entries: z.array(
    z.object({
      dimension: z.enum(MEMORY_DIMENSIONS),
      text: z.string(),
      hits: z.number().int().nonnegative(),
      lastSeen: z.number(),
      createdAt: z.number(),
    }),
  ),
});

/**
 * 读取记忆
 *
 * 解析失败返回空数组而不是抛错:记忆是**增强**,不是必需品。
 * 一条坏记录不该让 app 起不来 —— 那是用可用性换一个可有可无的功能。
 */
export function loadMemory(store: MemoryStore, logger?: Logger): MemoryEntry[] {
  const raw = store.get(MEMORY_KEY);
  if (!raw) return [];

  try {
    const parsed = StoredSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      logger?.warn('长期记忆格式不符,按空处理', { key: MEMORY_KEY });
      return [];
    }
    return parsed.data.entries;
  } catch {
    logger?.warn('长期记忆解析失败,按空处理', { key: MEMORY_KEY });
    return [];
  }
}

export function saveMemory(store: MemoryStore, entries: readonly MemoryEntry[]): void {
  store.set(MEMORY_KEY, JSON.stringify({ version: 1, entries }));
}

export function clearMemory(store: MemoryStore): void {
  store.delete(MEMORY_KEY);
}

// ============================================
// 抽取器提示词
// ============================================
//
// 三件事必须同时说清,少一条抽出来的东西就不能用:
// ① 只抽**反复出现的模式**,不抽一次性事实 —— 后者是绝大多数噪声的来源
// ② 维度是**封闭枚举**,不属于任何维度就不要输出(没有 misc 兜底)
// ③ 宁可**空手而归** —— 这是与压缩摘要最大的不同。摘要必须产出点什么
//    (那一轮确实做了事),而记忆抽取绝大多数时候的正确答案是「没有」。
//    不明说的话模型会为了「有输出」去编,而编出来的偏好会永久注入每一轮
export const EXTRACTION_SYSTEM_PROMPT = [
  '你在从一段对话里提取**用户的长期特征**,供以后的会话参考。',
  '',
  '只提取**反复出现或明确声明**的倾向。一次性的事实(这次在查什么、这次的文件名、',
  '这次的任务内容)一律不要 —— 那些属于会话摘要,不属于长期特征。',
  '',
  '维度是固定的,只能用这几个,不属于任何维度的就不要输出:',
  ...MEMORY_DIMENSIONS.map(d => `- ${d}(${DIMENSION_LABELS[d]})`),
  '',
  '每条一句话、20 字以内、写成对用户的描述(如「用中文应答」「要理由不只要结论」)。',
  '',
  '**大多数情况下应该返回空的 candidates。** 只在你确实看到稳定倾向时才输出 ——',
  '为了凑数编出来的特征会被永久带进以后每一轮对话,代价远大于漏记一条。',
  '',
  '绝不要输出任何密钥、token、密码、路径里的凭证。看到了就跳过。',
  '',
  '如果某条已有特征与你看到的**矛盾**(不是「没提到」,是确实相反),',
  '在 contradicts 里给出它的编号和理由。**没提到不等于矛盾** ——',
  '你只看到了对话的一小段,不要因为这段里没出现就认为它不成立。',
  '',
  'JSON 格式:',
  '{"candidates":[{"dimension":"language","text":"用中文应答"}],',
  ' "contradicts":[{"index":0,"reason":"用户这次明确改要英文"}]}',
].join('\n');

/**
 * 渲染现有条目给抽取器看(带编号,contradicts 按这个编号)
 *
 * 编号必须与 `mergeExtraction` 收到的 `existing` 顺序一致 ——
 * 两处不同源就会删错条目,而删错是静默的。
 */
export function renderExistingForExtractor(entries: readonly MemoryEntry[]): string {
  if (entries.length === 0) return '(目前没有已记录的特征)';
  return entries
    .map((e, i) => `${i}. [${e.dimension}] ${e.text}`)
    .join('\n');
}
