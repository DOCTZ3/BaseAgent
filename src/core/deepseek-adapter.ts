// ============================================
// Core 层:DeepSeek Adapter(OpenAI 兼容)
// ============================================

import OpenAI from 'openai';
import { LLMClient, LLMRequest, LLMResponse, ToolCallMessage, TraceSink, DeltaSink, ContentPart } from './llm-client.js';
import { Logger, LLMError, RetryHandler, RetryConfig } from '../platform/index.js';

/**
 * 流式分片累积的中间态
 *
 * 工具调用的 arguments 在流式里是**逐字拼**的(delta.tool_calls[i].function.arguments
 * 每次给一小段),所以必须按 index 累积成完整字符串再 JSON.parse ——
 * 半截 JSON 解析必然抛错。
 */
interface StreamAccumulator {
  content: string;
  reasoning: string;
  /** 按 index 累积:同一个 index 的分片属于同一个 tool_call */
  toolCalls: Map<number, { id: string; name: string; args: string }>;
  finishReason: string | null;
  usage?: OpenAI.Completions.CompletionUsage;
}

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

    // 流式是**独立分支**,下面那条老路径(含它自己的 try/catch)一个字节没动。
    //
    // 为什么不合并成一个:两条路的**重试单位不一样**。非流式只需要包住
    // 「发起调用」那一下 —— 解析在 retryHandler 外面,模型返回畸形参数时
    // `JSON.parse` 必然直接抛错。流式必须包住「整个消费过程」,因为它可能
    // 吐到一半才断。合并的话 `JSON.parse` 会落进 RetryHandler 的匹配范围,
    // 那是**行为改变**,而且不报错。
    // 代价是 trace 与 catch 那段在流式分支里重复一次 —— 这笔交易值得做
    if (request.onDelta) {
      return await this.completeStreaming(
        wireRequest, request.onDelta, callIndex, label, startedAt,
      );
    }

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
   * 流式路径(与非流式完全独立)
   *
   * 自带 try/catch 与 trace,不复用上面那条 —— 两条路的**重试单位不一样**,
   * 合并会让 JSON.parse 落进 RetryHandler 的匹配范围(行为改变且不报错)。
   *
   * 重试的语义在这里也不同:非流式重试是「重新发一次请求」;流式重试意味着
   * 上一次可能**已经吐给用户半截回答**,所以每次重试前先发 reset 让调用方丢弃。
   */
  private async completeStreaming(
    baseRequest: Record<string, unknown>,
    onDelta: DeltaSink,
    callIndex: number,
    label: string,
    startedAt: number,
  ): Promise<LLMResponse> {
    let attempts = 0;

    // 流式的线格式请求体在**这里**定型,发送和 trace 共用同一个对象。
    //
    // 之前 stream / stream_options 是在 consumeStream 里展开进 create() 的,
    // 而 trace 记的是没有这两项的 baseRequest —— 于是 trace 里的请求体和
    // 线上真正发出的不是同一个东西:照着 trace 复现会得到一个**非流式**请求,
    // 首 token 时序完全对不上(排查流式延迟时正好用不上它)。
    // trace 的全部价值就是「这才是真正发出去的内容」,不能有第二个版本
    const wireRequest = {
      ...baseRequest,
      stream: true,
      // 见 consumeStream ②:不加这个,流式下拿不到 usage
      stream_options: { include_usage: true },
    };

    try {
      const { response, wireResponse } = await this.retryHandler.execute(
        () => {
          attempts++;
          // 不发 reset 的话用户会看到「同一段话说了两遍」而且中间是断的
          if (attempts > 1) onDelta({ reset: true });
          return this.consumeStream(wireRequest, onDelta);
        },
        'DeepSeek API 流式调用',
      );

      this.config.logger.debug('LLM 流式响应', {
        hasContent: !!response.content,
        hasReasoning: !!response.reasoning,
        toolCallCount: response.toolCalls.length,
        finishReason: response.finishReason,
        usage: response.usage,
      });

      this.config.onTrace?.({
        callIndex,
        label,
        model: this.config.model,
        startedAt,
        durationMs: Date.now() - startedAt,
        attempts,
        wireRequest,
        wireResponse,
        parsed: response,
      });

      return response;
    } catch (error) {
      this.config.logger.error('LLM 流式调用失败', { error });

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

      // 与非流式同一个理由:不透传原始消息(含 ECONNRESET 这类特征),
      // 否则外层 RetryHandler 会匹配到并再次重试,调用次数相乘
      throw new LLMError(
        `LLM API 调用失败${error instanceof Error ? ` (${error.name})` : ''}`,
        true,
      );
    }
  }

  /**
   * 消费一次流,累积成与非流式**同形**的结果
   *
   * 三处必须小心,每一处做错都是静默的:
   *
   * ① **工具调用的 arguments 是逐字拼的**。流式里 `delta.tool_calls[i].function
   *    .arguments` 每次只给一小段,必须按 index 累积成完整字符串再 JSON.parse ——
   *    半截 JSON 必然抛错。id 和 name 通常只在该 index 的第一个分片里出现。
   *
   * ② **usage 要显式索要**。流式默认不返回用量,不加 `stream_options.include_usage`
   *    会让 token 统计和缓存命中率静默变成 0,而 /stats 整个显示都依赖那些数。
   *    它只在最后一个分片里给(那个分片的 choices 是空数组)。
   *    那个开关现在由 completeStreaming 加进 wireRequest —— 本函数**原样发出**,
   *    这样 trace 记的就是真正发出去的请求体。
   *
   * ③ **finishReason 从分片里读,不能默认 stop**。否则带 tool_calls 的轮次
   *    会被误判成「模型给出了最终回答」,主循环直接收尾 —— 工具不会被执行。
   *
   * 分片本身**不进 trace**:trace 记的是完整的线格式请求/响应对,
   * 几百条碎片对定位问题没有用。所以这里重组出一个与非流式同构的响应体。
   */
  private async consumeStream(
    wireRequest: Record<string, unknown>,
    onDelta: DeltaSink,
  ): Promise<{ response: LLMResponse; wireResponse: unknown }> {
    // t0 必须在 create() **之前**。
    //
    // 第一版埋点放在 await 之后,量出的首片延迟恒为 0.0s —— 与实际体感
    // (发完十几秒没动静)直接矛盾。原因是 SDK 的这个 await **不是**
    // 「请求已发出」就 resolve,而要等 HTTP 响应头到达、流变为可读。
    // 也就是说用户等的那段时间整个落在这个 await 里,而旧埋点从它之后才计时。
    // 这一条是排查流式延迟的全部关键:分不开「等首 token」和「分片间隔」,
    // 就无法判断该改配置还是改代码。
    const t0 = Date.now();

    // wireRequest 已经带上 stream / stream_options(在 completeStreaming 里定型)——
    // 这里**原样发出**,不再追加任何字段。追加就等于 trace 记的和发出的不一致,
    // 而那正是之前 trace 里 stream_options 显示 undefined 的原因
    const stream = await this.client.chat.completions.create(
      wireRequest as any,
    ) as unknown as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;

    // 流可读的时刻。它减去 t0 = 请求 + 排队 + 服务端首 token 前的处理 ——
    // 输入越长这段越久,而它与我们的代码无关(只能靠配置或缩短上下文)
    const streamReadyMs = Date.now() - t0;

    const acc: StreamAccumulator = {
      content: '',
      reasoning: '',
      toolCalls: new Map(),
      finishReason: null,
    };

    /**
     * 首字延迟埋点 —— 流式下**只有这几个数**能解释体感
     *
     * `duration_ms`(整段流消费完)回答不了「为什么卡一会才开始吐字」。
     * 四个时间点,全部相对 t0(= create() 调用前):
     * - streamReady  流变为可读。这段是「请求 + 排队 + 服务端首 token 前的处理」,
     *   与我们的代码无关 —— 只能靠缩短上下文或换配置
     * - firstChunk   收到任何分片(含空 delta)
     * - firstReason  收到第一个思维链增量
     * - firstContent 收到第一个正文增量
     *
     * 分开 reasoning 与 content 是因为处置不同:DeepSeek 推理模型先生成
     * reasoning_content 再生成 content。firstReason 晚 → API 在攒思维链
     * (只能关 MAIN_ENABLE_THINKING);firstReason 早而 firstContent 晚 →
     * 推理边吐边发、只是正文来得慢,属正常。
     */
    let firstChunkMs: number | undefined;
    let firstReasonMs: number | undefined;
    let firstContentMs: number | undefined;
    let chunkCount = 0;

    for await (const chunk of stream) {
      chunkCount++;
      firstChunkMs ??= Date.now() - t0;

      // usage 分片的 choices 是空数组,所以先取 usage 再看 choices
      if (chunk.usage) acc.usage = chunk.usage;

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      if (choice.finish_reason) acc.finishReason = choice.finish_reason;

      const delta = choice.delta as any;
      if (!delta) continue;

      // 推理和正文分开推:客户端要把思维链折叠显示,混在一起就没法区分
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        firstReasonMs ??= Date.now() - t0;
        acc.reasoning += delta.reasoning_content;
        onDelta({ reasoning: delta.reasoning_content });
      }

      if (typeof delta.content === 'string' && delta.content) {
        firstContentMs ??= Date.now() - t0;
        acc.content += delta.content;
        onDelta({ content: delta.content });
      }

      // 见 ①:按 index 累积,不推给调用方(半截 JSON 没有展示价值)
      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const cur = acc.toolCalls.get(idx) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        acc.toolCalls.set(idx, cur);
      }
    }

    // 按 index 排序:Map 的插入序通常就是 index 序,但不保证 ——
    // 而顺序错了会让「先读文件再写文件」这类调用反过来
    const ordered = [...acc.toolCalls.entries()].sort((a, b) => a[0] - b[0]);

    const toolCalls: ToolCallMessage[] = ordered.map(([idx, tc]) => {
      let args: Record<string, unknown>;
      try {
        args = tc.args ? JSON.parse(tc.args) : {};
      } catch {
        // 拼出来的 JSON 不合法 —— 这是流式特有的失败形态(丢了分片)。
        // 抛 LLMError 而不是静默给空参数:空参数会让工具用默认值跑起来,
        // 那比失败更糟(模型以为自己调成功了)
        throw new LLMError(
          `流式工具调用参数不是合法 JSON (index ${idx}, ${tc.name}): ${tc.args.slice(0, 200)}`,
          true,
        );
      }
      return { id: tc.id, name: tc.name, args };
    });

    const finishReason: LLMResponse['finishReason'] =
      acc.finishReason === 'tool_calls' ? 'tool_calls'
      : acc.finishReason === 'length' ? 'length'
      : 'stop';

    // 重组成与非流式同构的线格式响应,供 trace 记录。
    // 标注 _reassembled_from_stream 是必要的诚实:它不是 API 原样返回的字节,
    // 排查「响应格式变了」这类问题时必须知道这一点
    const wireResponse = {
      _reassembled_from_stream: true,
      choices: [{
        index: 0,
        finish_reason: acc.finishReason,
        message: {
          role: 'assistant',
          content: acc.content || null,
          ...(acc.reasoning ? { reasoning_content: acc.reasoning } : {}),
          ...(ordered.length > 0 ? {
            tool_calls: ordered.map(([, tc]) => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: tc.args },
            })),
          } : {}),
        },
      }],
      usage: acc.usage,
      /**
       * 流式时序 —— 放在这里是为了跟着 trace 落盘
       *
       * 加下划线前缀标明它不是 API 返回的字段(同 _reassembled_from_stream)。
       * 没有这几个数就无法区分「API 攒着不给」与「我们自己攒着不发」,
       * 而两者的处置完全不同。
       */
      _stream_timing: {
        // 这一项是排查的起点:它大 = 服务端在憋首 token(与我们的代码无关);
        // 它小而 first_reasoning_ms 大 = API 在攒思维链
        stream_ready_ms: streamReadyMs,
        first_chunk_ms: firstChunkMs,
        first_reasoning_ms: firstReasonMs,
        first_content_ms: firstContentMs,
        total_ms: Date.now() - t0,
        chunks: chunkCount,
      },
    };

    // 用 info 而不是 debug:这个数是排查「为什么卡一会才吐字」的第一现场,
    // 放在默认关闭的级别上等于每次要查都得先改配置重启一遍(实测踩到)
    this.config.logger.info('流式时序', {
      stream_ready_ms: streamReadyMs,
      first_chunk_ms: firstChunkMs,
      first_reasoning_ms: firstReasonMs,
      first_content_ms: firstContentMs,
      total_ms: Date.now() - t0,
      chunks: chunkCount,
    });

    return {
      wireResponse,
      response: {
        content: acc.content || null,
        reasoning: acc.reasoning || null,
        toolCalls,
        finishReason,
        usage: acc.usage ? this.extractUsage(acc.usage) : undefined,
      },
    };
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
