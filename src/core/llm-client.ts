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
}

// LLM 响应(内部格式)
export interface LLMResponse {
  content: string | null;          // 文本回复
  reasoning: string | null;        // 推理内容(思考过程)
  toolCalls: ToolCallMessage[];    // 工具调用(可能为空)
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
}

// LLM 客户端接口
export interface LLMClient {
  complete(request: LLMRequest): Promise<LLMResponse>;
}
