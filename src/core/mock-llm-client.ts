// ============================================
// Mock LLM Client:测试用,不调真实 API
// ============================================

import {
  LLMClient,
  LLMRequest,
  LLMResponse,
} from './llm-client.js';
import { Logger } from '../platform/index.js';

export class MockLLMClient implements LLMClient {
  private logger: Logger;
  private callCount = 0;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    this.callCount++;
    this.logger.info(`MockLLM 调用 #${this.callCount}`, {
      messages: request.messages.length,
      tools: request.tools?.length || 0,
    });

    // 模拟第一次调用:返回工具调用
    if (this.callCount === 1) {
      return {
        content: null,
        reasoning: null,
        toolCalls: [
          {
            id: 'call_1',
            name: 'get_current_time',
            args: { format: 'readable' },
          },
        ],
        finishReason: 'tool_calls',
      };
    }

    // 模拟第二次调用:再次工具调用
    if (this.callCount === 2) {
      return {
        content: null,
        reasoning: null,
        toolCalls: [
          {
            id: 'call_2',
            name: 'echo',
            args: { message: 'Hello BaseAgent' },
          },
        ],
        finishReason: 'tool_calls',
      };
    }

    // 模拟第三次调用:最终回答
    return {
      content:
        '当前时间已获取,并且成功回显了 "Hello BaseAgent"。任务完成!',
      reasoning: null,
      toolCalls: [],
      finishReason: 'stop',
    };
  }
}
