// ============================================
// Core 层:DeepSeek Adapter(OpenAI 兼容)
// ============================================

import OpenAI from 'openai';
import { LLMClient, LLMRequest, LLMResponse, ToolCallMessage, TraceSink, ContentPart } from './llm-client.js';
import { Logger, LLMError, RetryHandler, RetryConfig } from '../platform/index.js';

export interface DeepSeekConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  enableThinking: boolean;  // 是否开启推理模式
  logger: Logger;
  retry?: Partial<RetryConfig>;  // 重试策略(未配置则用 RetryHandler 默认值)
  onTrace?: TraceSink;           // 可观测钩子(未设置则零开销)
}

export class DeepSeekAdapter implements LLMClient {
  private client: OpenAI;
  private retryHandler: RetryHandler;
  private callCounter = 0;

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

    // 线格式请求体：这才是真正发给 API 的内容，trace 必须记这个
    const wireRequest = {
      model: this.config.model,
      messages,
      tools: tools && tools.length > 0 ? tools : undefined,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      ...(request.responseFormat === 'json_object' ? {
        response_format: { type: 'json_object' as const }
      } : {}),
      ...(this.config.enableThinking !== undefined ? {
        thinking: { type: this.config.enableThinking ? 'enabled' : 'disabled' }
      } : {}),
    };

    const callIndex = ++this.callCounter;
    const label = request.traceLabel ?? 'unlabeled';
    const startedAt = Date.now();
    let attempts = 0;

    try {
      // API 调用是幂等的,交给 RetryHandler 处理网络错误/限流/5xx
      const completion = await this.retryHandler.execute(
        () => {
          attempts++;
          return this.client.chat.completions.create(wireRequest as any);
        },
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
        usage: completion.usage ? this.extractUsage(completion.usage) : undefined
      };

      this.config.logger.debug('LLM 响应', {
        hasContent: !!response.content,
        hasReasoning: !!response.reasoning,
        toolCallCount: toolCalls.length,
        finishReason: response.finishReason,
        usage: response.usage
      });

      this.config.onTrace?.({
        callIndex,
        label,
        model: this.config.model,
        startedAt,
        durationMs: Date.now() - startedAt,
        attempts,
        wireRequest,
        wireResponse: completion,
        parsed: response,
      });

      return response;

    } catch (error) {
      this.config.logger.error('LLM 调用失败', { error });

      // 失败也要留痕：定位 4xx/格式问题时，请求体比错误消息更有用
      this.config.onTrace?.({
        callIndex,
        label,
        model: this.config.model,
        startedAt,
        durationMs: Date.now() - startedAt,
        attempts,
        wireRequest,
        error: {
          message: error instanceof Error ? error.message : String(error),
          name: error instanceof Error ? error.name : undefined,
        },
      });

      // 关键修复：不透传原始错误消息（会包含网络错误特征如 "ECONNRESET"），
      // 避免外层 RetryHandler 匹配到并再次重试，导致调用次数相乘（4×4=16）。
      // 保留错误类型（如 APIConnectionError）方便排查，但消息统一为 "LLM API 调用失败"
      throw new LLMError(
        `LLM API 调用失败${error instanceof Error ? ` (${error.name})` : ''}`,
        true
      );
    }
  }

  /**
   * 提取 token 用量,兼容两种缓存字段格式
   *
   * 各家/各网关对「缓存命中」的字段名不统一:
   * - DeepSeek 官方:顶层 `prompt_cache_hit_tokens`
   * - OpenAI 标准(多数中转站):嵌套 `prompt_tokens_details.cached_tokens`
   *
   * 实测中转站(api.with7.cn)的响应格式变过 —— 早期两个字段都给,后来只给标准字段,
   * 于是只读 DeepSeek 那个顶层字段会静默拿到 undefined、缓存命中率恒为 0%,
   * 而后台明明有命中。所以两种都认,取先有值的那个。
   *
   * 顺带取出 reasoning_tokens:排查「思维链吃光输出预算导致正文为空」时,
   * 这个值是关键证据(实测出现过 1535 token 全花在推理上)。
   *
   * Provider 差异在 adapter 层吸收,内核的中立格式不受影响。
   */
  private extractUsage(usage: OpenAI.Completions.CompletionUsage) {
    const raw = usage as any;

    const cached =
      raw.prompt_cache_hit_tokens              // DeepSeek 官方
      ?? raw.prompt_tokens_details?.cached_tokens;  // OpenAI 标准

    const reasoning = raw.completion_tokens_details?.reasoning_tokens;

    return {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      // 显式转数字并兜底 0：两种字段都缺时不该让下游拿到 undefined
      prompt_cache_hit_tokens: typeof cached === 'number' ? cached : 0,
      ...(typeof reasoning === 'number' ? { reasoning_tokens: reasoning } : {}),
    };
  }

  /**
   * 中立内容块 → OpenAI 线格式
   *
   * 这是项目里唯一知道 `image_url: { url: 'data:...' }` 长什么样的地方。
   * 内核用的中立格式（{type:'image', data, mimeType}）不带厂商结构，
   * 换 Claude 时只改这个方法。
   */
  private convertParts(parts: ContentPart[]): OpenAI.Chat.ChatCompletionContentPart[] {
    return parts.map(part => {
      if (part.type === 'text') {
        return { type: 'text' as const, text: part.text };
      }

      return {
        type: 'image_url' as const,
        image_url: {
          // base64 存的是裸数据，data: 前缀在这里拼 —— 存裸数据才能换厂商
          url: `data:${part.mimeType};base64,${part.data}`,
          ...(part.detail ? { detail: part.detail as 'low' | 'high' | 'auto' } : {}),
        },
      };
    });
  }

  private convertMessages(messages: LLMRequest['messages']): OpenAI.Chat.ChatCompletionMessageParam[] {
    return messages.map(msg => {
      if (msg.role === 'system') {
        return { role: 'system', content: msg.content };
      } else if (msg.role === 'user') {
        // 纯文本走原路：绝大多数消息是这种，不要无谓地包成单元素数组
        // （包了会让 prompt cache 的 key 变化，白丢缓存命中）
        if (typeof msg.content === 'string') {
          return { role: 'user', content: msg.content };
        }
        return { role: 'user', content: this.convertParts(msg.content) };
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
