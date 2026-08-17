// ============================================
// Core 层:DeepSeek Adapter(OpenAI 兼容)
// ============================================

import OpenAI from 'openai';
import { LLMClient, LLMRequest, LLMResponse, ToolCallMessage } from './llm-client.js';
import { Logger, LLMError, RetryHandler, RetryConfig } from '../platform/index.js';

export interface DeepSeekConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  enableThinking: boolean;  // 是否开启推理模式
  logger: Logger;
  retry?: Partial<RetryConfig>;  // 重试策略(未配置则用 RetryHandler 默认值)
}

export class DeepSeekAdapter implements LLMClient {
  private client: OpenAI;
  private retryHandler: RetryHandler;

  constructor(private config: DeepSeekConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      // 关掉 SDK 自带重试,统一由 RetryHandler 管,避免两层重试叠乘
      maxRetries: 0,
    });
    this.retryHandler = new RetryHandler(config.retry ?? {}, config.logger);
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    // 转换内部格式 → OpenAI 格式
    const messages = this.convertMessages(request.messages);
    const tools = request.tools?.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    this.config.logger.debug('LLM 请求', {
      messageCount: messages.length,
      toolCount: tools?.length || 0,
      responseFormat: request.responseFormat || 'text',
    });

    try {
      // API 调用是幂等的,交给 RetryHandler 处理网络错误/限流/5xx
      const completion = await this.retryHandler.execute(
        () => this.client.chat.completions.create({
          model: this.config.model,
          messages,
          tools: tools && tools.length > 0 ? tools : undefined,
          temperature: request.temperature,
          max_tokens: request.maxTokens,
          // 结构化输出:强制模型只返回合法 JSON
          ...(request.responseFormat === 'json_object' ? {
            response_format: { type: 'json_object' as const }
          } : {}),
          // 根据配置决定是否开启推理模式
          ...(this.config.enableThinking !== undefined ? {
            thinking: { type: this.config.enableThinking ? 'enabled' : 'disabled' }
          } : {}),
        }),
        'DeepSeek API 调用'
      );

      const choice = completion.choices[0];
      if (!choice) {
        throw new LLMError('模型未返回有效响应');
      }

      // 提取推理内容(如果存在)
      const reasoning = (choice.message as any).reasoning_content || null;

      // 转换 OpenAI 格式 → 内部格式
      const toolCalls: ToolCallMessage[] = choice.message.tool_calls?.map(tc => ({
        id: tc.id,
        name: tc.function.name,
        args: JSON.parse(tc.function.arguments),
      })) || [];

      const response: LLMResponse = {
        content: choice.message.content,
        reasoning,
        toolCalls,
        finishReason: choice.finish_reason === 'tool_calls' ? 'tool_calls' :
                      choice.finish_reason === 'length' ? 'length' : 'stop',
        usage: completion.usage ? {
          prompt_tokens: completion.usage.prompt_tokens,
          completion_tokens: completion.usage.completion_tokens,
          prompt_cache_hit_tokens: (completion.usage as any).prompt_cache_hit_tokens
        } : undefined
      };

      this.config.logger.debug('LLM 响应', {
        hasContent: !!response.content,
        hasReasoning: !!response.reasoning,
        toolCallCount: toolCalls.length,
        finishReason: response.finishReason,
        usage: response.usage
      });

      return response;

    } catch (error) {
      this.config.logger.error('LLM 调用失败', { error });
      throw new LLMError(
        error instanceof Error ? error.message : '未知错误',
        true
      );
    }
  }

  private convertMessages(messages: LLMRequest['messages']): OpenAI.Chat.ChatCompletionMessageParam[] {
    return messages.map(msg => {
      if (msg.role === 'system') {
        return { role: 'system', content: msg.content };
      } else if (msg.role === 'user') {
        return { role: 'user', content: msg.content };
      } else if (msg.role === 'assistant') {
        // 有工具调用时，content 必须是 null 或不存在（不能是空字符串）
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          const result: any = {
            role: 'assistant',
            content: msg.content || null,  // 空字符串转为 null
            tool_calls: msg.toolCalls.map(tc => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.args),
              },
            })),
          };
          // 重要:如果原消息有 reasoning,必须回传 reasoning_content
          // 否则 DeepSeek API 会返回 400 错误
          if (msg.reasoning) {
            result.reasoning_content = msg.reasoning;
          }
          return result;
        }
        // 无工具调用，正常返回 content
        const result: any = {
          role: 'assistant',
          content: msg.content,
        };
        // 无工具调用时也可能有 reasoning
        if (msg.reasoning) {
          result.reasoning_content = msg.reasoning;
        }
        return result;
      } else {
        // tool 消息
        return {
          role: 'tool' as const,
          tool_call_id: msg.toolCallId,
          content: msg.content,
        };
      }
    });
  }
}
