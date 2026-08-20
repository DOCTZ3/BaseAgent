// ============================================
// Core 层:Token 计数器
// ============================================

import { encoding_for_model, Tiktoken } from 'tiktoken';
import { Logger } from '../platform/index.js';

export interface TokenUsage {
  turn: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;   // 思维链消耗（已包含在 completion_tokens 内）
  timestamp: number;
}

export interface TokenStats {
  total_prompt: number;       // 当前上下文大小（非累加）
  total_completion: number;
  total_cached: number;
  total_reasoning: number;
  /**
   * 缓存命中率 = 累计命中 / 累计 prompt
   *
   * 两者量纲必须一致。旧算法用 `累计命中 / (当前 prompt + 累计命中)`——
   * 分子累加、分母掺一个当前值，会话越长比率越虚高，数字不可信。
   */
  cache_hit_rate: number;
  turns: TokenUsage[];
}

export class TokenCounter {
  private encoder: Tiktoken;
  private turns: TokenUsage[] = [];
  private currentTurn = 0;

  // 当前上下文大小（直接从最新 API 返回获取，不累加）
  private currentPromptTokens = 0;

  // 累计消耗（只增不减）
  private totalCompletionTokens = 0;
  private totalCachedTokens = 0;
  private totalReasoningTokens = 0;
  // 累计 prompt —— 仅用于算缓存命中率，使分子分母量纲一致
  private totalPromptTokens = 0;

  constructor(
    private logger: Logger,
    private model: string = 'gpt-3.5-turbo' // DeepSeek 兼容 OpenAI tokenizer
  ) {
    this.encoder = encoding_for_model(model as any);
  }

  /**
   * 预估文本的 token 数（请求前）
   */
  estimate(text: string): number {
    return this.encoder.encode(text).length;
  }

  /**
   * 预估消息列表的 token 数
   */
  estimateMessages(messages: Array<{ role: string; content: string | null }>): number {
    // OpenAI 的消息格式每条有固定开销（约 4 tokens）
    const messageOverhead = messages.length * 4;
    const contentTokens = messages.reduce((sum, msg) => {
      const content = msg.content || '';
      return sum + this.estimate(content);
    }, 0);
    return messageOverhead + contentTokens;
  }

  /**
   * 记录实际使用量（请求后，从 API 返回）
   */
  recordUsage(usage: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_cache_hit_tokens?: number;
    reasoning_tokens?: number;
  }) {
    this.currentTurn++;

    // 关键修复：prompt_tokens 直接覆盖（API 返回的是当前上下文大小）
    this.currentPromptTokens = usage.prompt_tokens;

    // 累计量（这是真实消耗）
    this.totalPromptTokens += usage.prompt_tokens;
    this.totalCompletionTokens += usage.completion_tokens;
    this.totalCachedTokens += usage.prompt_cache_hit_tokens || 0;
    this.totalReasoningTokens += usage.reasoning_tokens || 0;

    const record: TokenUsage = {
      turn: this.currentTurn,
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      cached_tokens: usage.prompt_cache_hit_tokens || 0,
      reasoning_tokens: usage.reasoning_tokens || 0,
      timestamp: Date.now()
    };

    this.turns.push(record);

    // 本次命中率用本次数据，累计命中率用累计数据 —— 不混用量纲
    const thisTurnRate = usage.prompt_tokens > 0
      ? (((usage.prompt_cache_hit_tokens || 0) / usage.prompt_tokens) * 100).toFixed(1)
      : '0.0';

    this.logger.info('Token 使用情况', {
      turn: record.turn,
      current_prompt: this.currentPromptTokens,
      completion: usage.completion_tokens,
      reasoning: record.reasoning_tokens,
      cached_this_turn: record.cached_tokens,
      cache_hit_this_turn: `${thisTurnRate}%`,
      累计_prompt: this.totalPromptTokens,
      累计_completion: this.totalCompletionTokens,
      累计_cached: this.totalCachedTokens,
      累计_reasoning: this.totalReasoningTokens
    });
  }

  /**
   * 获取累计统计
   */
  getStats(): TokenStats {
    // total_prompt 返回当前上下文大小（不是累加）——
    // 它用于压缩阈值判断，必须是「现在有多大」而非「一共发过多少」
    return {
      total_prompt: this.currentPromptTokens,
      total_completion: this.totalCompletionTokens,
      total_cached: this.totalCachedTokens,
      total_reasoning: this.totalReasoningTokens,
      // 分子分母都用累计值，量纲一致
      cache_hit_rate: this.totalPromptTokens > 0
        ? this.totalCachedTokens / this.totalPromptTokens
        : 0,
      turns: this.turns
    };
  }

  /**
   * 检查是否达到阈值
   */
  shouldCompress(windowSize: number, threshold: number): boolean {
    // 使用当前 prompt 大小判断（不是累加值）
    return this.currentPromptTokens >= windowSize * threshold;
  }

  /**
   * 释放资源
   */
  dispose() {
    this.encoder.free();
  }
}
