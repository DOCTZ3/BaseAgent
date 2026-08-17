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

// LLM 客户端接口
export interface LLMClient {
  complete(request: LLMRequest): Promise<LLMResponse>;
}
