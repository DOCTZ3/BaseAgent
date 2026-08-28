// ============================================
// Core 层:会话历史(append-only 的轮次日志)
// ============================================
//
// 这一层的存在是因为 **archive/ 不是历史**:那里只有被压缩掉的轮次。
// 实测最近 8 个会话的 archive 全是空的 —— 窗口 1M、阈值 0.7,压缩从没触发过,
// 于是所有轮次只活在内存里,关掉客户端就没了。
//
// 与压缩的关系是**两条路分开**,这是整个设计的关键:
//
//   前端显示 → 本文件的 turns.jsonl(完整原始对话,append-only,永不压缩)
//   模型请求 → ContextManager 那套(主题聚类压缩,一个字不改)
//
// 分开之后不需要序列化 ContextManager 的全部内部状态(主题摘要、轮次到主题的
// 映射、归档索引、token 计数 —— 10 个私有字段,漏一个就是静默错误)。
// 恢复会话只需要把原始轮次灌回去,压缩状态让它按需重新产生。
//
// 格式选 JSONL 而不是单个 JSON 数组:
// - 追加是一次 appendFileSync,不必读出整个数组、改完再写回
// - 崩溃只损坏最后一行,前面的历史仍然可读(单个 JSON 数组会整份失效)
// - 一行一轮,想看某轮直接 grep
// ============================================

import fs from 'fs';
import path from 'path';
import { type Turn, turnUserMessage } from './context.js';
import { messageToText } from './llm-client.js';

/** 侧边栏一条 —— 只放列表要显示的,不读全部轮次 */
export interface SessionSummary {
  sessionId: string;
  /** 第一条用户提问的截断,做标题 */
  title: string;
  turnCount: number;
  /** 最后一轮的时间。列表按它倒序 */
  updatedAt: number;
}

/** 标题长度上限。侧边栏宽度有限,长了会把布局撑开 */
const TITLE_CLIP = 34;

export function turnsFile(baseDir: string, sessionId: string): string {
  return path.join(baseDir, sessionId, 'turns.jsonl');
}

/**
 * 追加一轮
 *
 * 用 appendFileSync 而非流:与 FileLogger 同一个理由 —— 崩溃时不丢尾部,
 * 而且这里丢的是用户真实说过的话。写入量小(一轮几 KB),同步开销无关紧要。
 *
 * **写盘失败绝不抛异常**:历史记录是增强,不能让「存不下来」变成
 * 「这一轮任务失败」(同 TraceRecorder 与 FileLogger 的处理)。
 */
export function appendTurn(file: string, turn: Turn): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 一行一个 JSON,行内不能有裸换行 —— JSON.stringify 会把 \n 转义掉,天然满足
    fs.appendFileSync(file, JSON.stringify(turn) + '\n');
    return true;
  } catch {
    return false;
  }
}

/**
 * 读回全部轮次
 *
 * **坏行跳过而不是整份失败**:进程被 Ctrl+C 或崩溃时可能留下半行,
 * 那不该让前面几十轮真实历史一起读不出来。
 */
export function readTurns(file: string): Turn[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }

  const turns: Turn[] = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const t = JSON.parse(s) as Turn;
      // 形状校验:messages 必须是数组,否则后面渲染和重建都会炸在别处
      if (t && Array.isArray(t.messages)) turns.push(t);
    } catch {
      // 半行/坏行:跳过
    }
  }
  return turns;
}

/**
 * 列出所有会话
 *
 * 靠**扫目录**而不是维护一份索引文件:索引要在会话开始、每轮结束时更新,
 * 而它和真实目录不一致时(手动删了 traces/xxx、或写索引那次崩了)
 * 列表里会出现打不开的条目。扫目录是自愈的 —— 目录在就在,删了就没。
 *
 * 只读每个文件的**第一行**取标题、数行数取轮数,不解析全部内容:
 * 会话可能有几百轮,列侧边栏没有理由把它们全读出来。
 */
export function listSessions(baseDir: string): SessionSummary[] {
  let dirs: string[];
  try {
    dirs = fs.readdirSync(baseDir);
  } catch {
    return [];
  }

  const out: SessionSummary[] = [];
  for (const sessionId of dirs) {
    const file = turnsFile(baseDir, sessionId);
    let raw: string;
    let mtime: number;
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.size === 0) continue;
      mtime = st.mtimeMs;
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;   // 没有 turns.jsonl 的目录不是会话(如只有 calls/ 的旧留痕)
    }

    const lines = raw.split('\n').filter(l => l.trim());
    if (lines.length === 0) continue;

    out.push({
      sessionId,
      title: titleOf(lines[0]),
      turnCount: lines.length,
      updatedAt: mtime,
    });
  }

  // 倒序:最近聊的在最上面。对话的时间局部性远强于访问局部性
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 从第一行取标题。取不出来给个占位,不能让列表里出现空条目 */
function titleOf(firstLine: string): string {
  try {
    const turn = JSON.parse(firstLine) as Turn;
    const msg = turnUserMessage(turn);
    // 图文混排的轮次 messageToText 会摊平成文字,所以这里不必分情况
    const text = msg ? messageToText(msg.content).replace(/\s+/g, ' ').trim() : '';
    if (!text) return '(无标题)';
    return text.length > TITLE_CLIP ? text.slice(0, TITLE_CLIP) + '…' : text;
  } catch {
    return '(无标题)';
  }
}
