// ============================================
// Core 层:LLM 客户端 - 内部中立格式
// ============================================

import { ToolDescription } from '../tools/index.js';

// 内部中立的消息格式
export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; reasoning?: string; toolCalls?: ToolCallMessage[] }
  | { role: 'tool'; toolCallId: string; content: string };

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
    prompt_cache_hit_tokens?: number;
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

// LLM 客户端接口
export interface LLMClient {
  complete(request: LLMRequest): Promise<LLMResponse>;
}
