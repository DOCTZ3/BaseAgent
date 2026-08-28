// ============================================
// 一次性脚本:把旧会话的对话导入 turns.jsonl
// ============================================
//
// 背景:历史存储(turns.jsonl)是后加的,之前 38 个会话的对话只存在于
// `calls/*.json` 的 `wire_request.messages` 里 —— 那是每次调用把当时全部
// 消息发出去的快照。这个脚本把它切回轮次结构。
//
// 用法:
//   npx tsx scripts/import-history.ts            预演,只打印不写盘
//   npx tsx scripts/import-history.ts --write     实际写入
//   npx tsx scripts/import-history.ts --only <sessionId>   只处理一个
//
// **默认预演**是刻意的:切分逻辑靠位置约定,而位置约定判错的话会往
// 每个会话目录塞一份错的 turns.jsonl,而且是静默的 —— 界面上看着有历史,
// 内容却是错位的。先看清楚再写。
//
// 能恢复到什么程度(数据源决定的上限,不是实现偷懒):
// - 能:用户提问、模型回答、调过哪些工具及其参数
// - 不能:真实 timestamp(只能用文件 mtime 近似)
// - 不能:被压缩掉的早期轮次 —— 压缩后的请求里那些已被摘要替换。
//   原文在 archive/turn-*.json,所以脚本会**合并**那一侧(见 mergeArchived)
// ============================================

import fs from 'fs';
import path from 'path';
import type { Turn } from '../src/core/context.js';
import type { Message } from '../src/core/llm-client.js';

const TRACE_DIR = process.env.TRACE_DIR || 'traces';
const WRITE = process.argv.includes('--write');
const onlyIdx = process.argv.indexOf('--only');
const ONLY = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : undefined;

/** 线格式的 assistant.tool_calls → 内部 Message.toolCalls */
function convertToolCalls(raw: unknown): Message['toolCalls'] {
  if (!Array.isArray(raw)) return undefined;
  const out = [];
  for (const tc of raw) {
    const fn = tc?.function;
    if (!fn?.name) continue;
    let args: unknown = {};
    try {
      // arguments 是 JSON 字符串。坏了就给空对象 —— 导入历史是为了「能看」,
      // 一个参数解析不出来不该让整轮丢掉
      args = fn.arguments ? JSON.parse(fn.arguments) : {};
    } catch {
      args = { _raw: String(fn.arguments).slice(0, 200) };
    }
    out.push({ id: tc.id ?? '', name: fn.name, args });
  }
  return out.length > 0 ? out : undefined;
}

/** 线格式消息 → 内部 Message */
function convertMessage(m: any): Message | null {
  if (!m?.role) return null;
  if (m.role === 'system') return null;   // system 提示不属于任何轮次

  if (m.role === 'tool') {
    return {
      role: 'tool',
      toolCallId: m.tool_call_id ?? '',
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    };
  }

  if (m.role === 'assistant') {
    return {
      role: 'assistant',
      content: typeof m.content === 'string' ? m.content : '',
      reasoning: m.reasoning_content || undefined,
      toolCalls: convertToolCalls(m.tool_calls),
    };
  }

  // user:content 可能是字符串,也可能是图文数组(工具观察)
  return { role: 'user', content: m.content };
}

/**
 * 把一串消息切成轮次
 *
 * 位置约定与 core 一致(见 context.ts 的 Turn 注释):
 * `role:'user'` 开新一轮,之后的 assistant/tool 归入这一轮。
 *
 * **连续两条 user 要区分**:实测存在 `user(数组) user(字符串)` 这种序列 ——
 * 前者是工具产出的观察(图片只能走 user 通道),后者才是真提问。
 * 判据是 content 类型:数组 = 观察,归入当前轮;字符串 = 提问,开新轮。
 * 不区分的话一轮会被劈成两半,而前半轮没有用户提问、后半轮没有工具上下文。
 */
function splitIntoTurns(wire: any[], baseTime: number): Turn[] {
  const turns: Turn[] = [];
  let current: Message[] | null = null;

  for (const raw of wire) {
    const msg = convertMessage(raw);
    if (!msg) continue;

    const isRealQuestion = msg.role === 'user' && typeof msg.content === 'string';

    if (isRealQuestion) {
      if (current) turns.push(finish(current, turns.length + 1, baseTime));
      current = [msg];
      continue;
    }

    // 观察和 assistant/tool 都归入当前轮。开头就是 assistant 的情况
    // (压缩后重建的请求会这样)没有归属,丢掉 —— 没有提问的半轮没有展示价值
    if (current) current.push(msg);
  }

  if (current) turns.push(finish(current, turns.length + 1, baseTime));
  return turns;
}

function finish(messages: Message[], turnId: number, baseTime: number): Turn {
  return { turn_id: turnId, messages, timestamp: baseTime + turnId };
}

/** 只有用户提问、没有任何 assistant 响应的轮次不入库(与 finalizeTurn 同一判据) */
function isComplete(t: Turn): boolean {
  return t.messages.some(m => m.role === 'assistant');
}

/**
 * 合并 archive/ 里的轮次
 *
 * 压缩过的会话,最后一次调用的请求里已经没有早期轮次的原文了(被摘要替换),
 * 但 archive/turn-*.json 存着它们。按 turn_id 去重后合并 —— 那边的编号
 * 与本次切分出来的可能重叠(都是从 1 开始),所以以 archive 为准、
 * 切分结果里编号冲突的往后排。
 */
function mergeArchived(dir: string, fromCalls: Turn[]): Turn[] {
  const archDir = path.join(dir, 'archive');
  let files: string[] = [];
  try {
    files = fs.readdirSync(archDir).filter(f => /^turn-\d+\.json$/.test(f)).sort();
  } catch {
    return fromCalls;
  }
  if (files.length === 0) return fromCalls;

  const archived: Turn[] = [];
  for (const f of files) {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(archDir, f), 'utf8')) as Turn;
      if (t && Array.isArray(t.messages)) archived.push(t);
    } catch { /* 坏文件跳过 */ }
  }
  if (archived.length === 0) return fromCalls;

  // 用「首条用户提问的文本」判重:归档的轮次也可能出现在 calls 快照里
  const seen = new Set(archived.map(firstQuestionOf));
  const extra = fromCalls.filter(t => !seen.has(firstQuestionOf(t)));

  // 重新编号:归档在前(它们本来就是更早的),之后接切分结果
  return [...archived, ...extra].map((t, i) => ({ ...t, turn_id: i + 1 }));
}

function firstQuestionOf(t: Turn): string {
  const m = t.messages[0];
  if (!m || m.role !== 'user') return '';
  return typeof m.content === 'string' ? m.content.slice(0, 80) : '';
}

// ---------- 主流程 ----------

function latestCall(dir: string): { messages: any[]; mtime: number } | null {
  const callsDir = path.join(dir, 'calls');
  let files: string[];
  try {
    files = fs.readdirSync(callsDir).filter(f => /^call-\d+\.json$/.test(f)).sort();
  } catch {
    return null;
  }
  if (files.length === 0) return null;

  // 取**最后一次**调用:它的 messages 含本次会话最完整的序列。
  // 但要跳过压缩/摘要那类单发调用 —— 它们的 messages 是压缩用的提示,
  // 不是对话本身。靠 label 判断(主循环的 label 以 main-loop 开头)
  for (let i = files.length - 1; i >= 0; i--) {
    const p = path.join(callsDir, files[i]);
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const label: string = j.label ?? '';
      if (!label.startsWith('main-loop')) continue;
      const messages = j.wire_request?.messages;
      if (Array.isArray(messages) && messages.length > 1) {
        return { messages, mtime: fs.statSync(p).mtimeMs };
      }
    } catch { /* 坏文件跳过 */ }
  }
  return null;
}

const sessions = fs.readdirSync(TRACE_DIR).filter(d => {
  if (ONLY && d !== ONLY) return false;
  return fs.statSync(path.join(TRACE_DIR, d)).isDirectory();
});

console.log(WRITE ? '=== 写入模式 ===' : '=== 预演模式(不写盘,加 --write 才写)===');
console.log(`扫描 ${TRACE_DIR}/,共 ${sessions.length} 个目录\n`);

let imported = 0, skipped = 0, existed = 0;

for (const sessionId of sessions) {
  const dir = path.join(TRACE_DIR, sessionId);
  const target = path.join(dir, 'turns.jsonl');

  // 已有的不动:那是真实运行时写下的,比从 trace 反推的更准
  if (fs.existsSync(target) && fs.statSync(target).size > 0) {
    existed++;
    continue;
  }

  const call = latestCall(dir);
  if (!call) { skipped++; continue; }

  const fromCalls = splitIntoTurns(call.messages, call.mtime).filter(isComplete);
  const turns = mergeArchived(dir, fromCalls);

  if (turns.length === 0) { skipped++; continue; }

  imported++;
  const title = firstQuestionOf(turns[0]).replace(/\s+/g, ' ').slice(0, 40);
  console.log(`${sessionId}`);
  console.log(`  ${turns.length} 轮  首条提问: ${title || '(空)'}`);

  if (WRITE) {
    fs.writeFileSync(target, turns.map(t => JSON.stringify(t)).join('\n') + '\n');
  }
}

console.log(`\n导入 ${imported} 个,跳过 ${skipped} 个(无 main-loop 调用),已存在 ${existed} 个`);
if (!WRITE && imported > 0) {
  console.log('\n确认无误后加 --write 实际写入。');
}
