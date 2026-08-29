// ============================================
// Core 层:LLM 客户端 - 内部中立格式
// ============================================

import { ToolDescription } from '../tools/index.js';

// ============================================
// 多模态内容块（中立格式）
// ============================================
//
// 刻意不照抄 OpenAI 的 `image_url: { url: "data:..." }` 结构：
// 那是线格式，让它渗进内核就等于把厂商细节焊死在 Message 上，
// 换 Claude（`source: { type: 'base64', media_type, data }`）时要改的地方遍布全项目。
// 这里只描述「有一张图，什么类型，数据是什么」，转换由 adapter 独占。
//
// 图片只允许出现在 user 消息里 —— DeepSeek 对 system/assistant 带图直接返回 400。
// 这个约束由类型系统表达（只有 user 分支的 content 是联合类型），不靠运行时检查。

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ImagePart {
  type: 'image';
  /** 图片原始字节的 base64（不含 `data:` 前缀，前缀由 adapter 拼） */
  data: string;
  /** 由文件实际内容判断，而非扩展名 —— DeepSeek 也是按内容判格式的 */
  mimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  /**
   * 缩放策略。'low' 会让服务端在推理前缩到 512×512，省 token 且更快；
   * 需要看清小字（表格/验证码）时用 'original'
   */
  detail?: 'low' | 'high' | 'original' | 'auto';
  /** 人类可读来源标注，用于压缩摘要和 trace 里替代 base64 */
  label?: string;
  /** 原始像素尺寸，仅用于日志与 token 估算 */
  width?: number;
  height?: number;
}

export type ContentPart = TextPart | ImagePart;

// 内部中立的消息格式
export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string; reasoning?: string; toolCalls?: ToolCallMessage[] }
  | { role: 'tool'; toolCallId: string; content: string };

/** 取消息的纯文本表示：图片折叠成占位标签，供压缩/日志/token 估算使用 */
export function messageToText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;

  return content
    .map(part =>
      part.type === 'text'
        ? part.text
        : `[图片${part.label ? ` ${part.label}` : ''}${
            part.width && part.height ? ` ${part.width}x${part.height}` : ''
          }]`
    )
    .join('\n');
}

export interface ToolCallMessage {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

// LLM 请求(内部格式)
export interface LLMRequest {
  messages: Message[];
  tools?: ToolDescription[];
  temperature?: number;
  maxTokens?: number;
  // 结构化输出:'json_object' 强制模型只返回合法 JSON
  // 用于摘要/分类等需要机器解析的单发调用,替代脆弱的正则提取
  responseFormat?: 'text' | 'json_object';
  // 调用来源标签,只用于 trace 归类(如 'main-loop' / 'compression:topic-analysis')
  // 不影响请求内容,不发给模型
  traceLabel?: string;
  /**
   * 分片回调。给了就走流式,不给走原来的一次性返回。
   *
   * 刻意做成**逐调用**而不是 adapter 级配置:压缩、摘要、记忆抽取这些单发调用
   * 不需要流式(它们的产物是给机器解析的 JSON,吐给用户没有意义),
   * 只有主循环需要。adapter 级开关会让那三类调用也白走流式路径。
   */
  onDelta?: DeltaSink;
  /**
   * 中断信号 —— 传下去就能**立即**掐掉正在进行的 HTTP 请求
   *
   * openai SDK 的 RequestOptions 支持它,流式也会当场断开。
   * 没有它的话「停止」最快也只能等当前这一步跑完(十几秒到一分钟),
   * 而用户点停止时想要的是马上停。
   *
   * 中断后 SDK 抛 APIUserAbortError。它**不能**落进重试分支 ——
   * 否则点一次停止会触发三次重试,变成「越停越忙」。
   */
  signal?: AbortSignal;
}

// LLM 响应(内部格式)
export interface LLMResponse {
  content: string | null;          // 文本回复
  reasoning: string | null;        // 推理内容(思考过程)
  toolCalls: ToolCallMessage[];    // 工具调用(可能为空)
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
  usage?: {                        // Token 使用量(来自 API)
    prompt_tokens: number;
    completion_tokens: number;
    // 缓存命中。各家字段名不统一(DeepSeek 顶层 prompt_cache_hit_tokens /
    // OpenAI 嵌套 prompt_tokens_details.cached_tokens),差异由 adapter 吸收
    prompt_cache_hit_tokens?: number;
    // 思维链消耗。它计入 completion_tokens,单独取出用于排查
    // 「推理吃光输出预算导致正文为空」
    reasoning_tokens?: number;
  };
}

// ============================================
// Trace(可观测)
// ============================================
//
// 定位真实效果问题时需要「发出去的原始请求 + 收到的原始响应」成对数据。
// 关键:wireRequest 必须是 Adapter 转换之后的线格式(content: null 的转换、
// reasoning_content 回填、tool_calls 结构都在那一步成型),打内部格式会看漏。
//
// Adapter 负责填充并调用 onTrace;由谁落盘、落到哪里由上层决定(TraceRecorder)。

export interface LLMTraceEvent {
  callIndex: number;              // 本次会话内第几次 LLM 调用(从 1 开始)
  label: string;                  // 调用来源(main-loop / compression:xxx)
  model: string;
  startedAt: number;
  durationMs: number;
  attempts?: number;              // 实际尝试次数(含重试)
  wireRequest: unknown;           // 发给 API 的原始请求体(线格式)
  wireResponse?: unknown;         // API 返回的原始响应体
  parsed?: LLMResponse;           // 转换回内部格式后的响应
  error?: { message: string; name?: string };
}

export type TraceSink = (event: LLMTraceEvent) => void;

// ============================================
// 流式增量
// ============================================
//
// 只有**正文和推理**是增量的,工具调用不是:参数是 JSON,吐一半没有意义
// (拿到半截 JSON 既不能展示也不能解析),所以 tool_calls 仍在
// LLMResponse 里一次性给出。
//
// 分片**不经过 trace**:trace 记的是线格式的完整请求/响应对
// (见上面 LLMTraceEvent 的注释),分片重组之后才交给 onTrace ——
// 否则 trace 里会出现几百条碎片,而定位问题要的是成对的完整数据。
export interface LLMDelta {
  /** 正文增量。与 reasoning 互斥:一次分片只会有一种 */
  content?: string;
  /** 推理增量(思维链) */
  reasoning?: string;
  /**
   * 丢弃此前收到的所有分片,从头开始
   *
   * 重试时发出:上一次尝试可能已经吐了半截回答,不清掉的话
   * 用户会看到「同一段话说了两遍」而且中间是断的。
   */
  reset?: true;
}

/**
 * 分片回调
 *
 * 由**调用方**提供,adapter 只负责调它。这样「往哪送」
 * (终端 stdout / SSE / IPC)不进核心层 —— 与 onTrace 同一套注入模式。
 *
 * 注意重试:网络错误重试时可能已经吐过一部分内容。adapter 会先发一次
 * `reset` 让调用方丢弃已收到的分片,否则用户会看到重复的半截回答。
 */
export type DeltaSink = (delta: LLMDelta) => void;

// LLM 客户端接口
export interface LLMClient {
  complete(request: LLMRequest): Promise<LLMResponse>;
}
