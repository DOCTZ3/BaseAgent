// ============================================
// Platform 层:统一重试处理器
// ============================================
//
// 职责：
// 1. 对幂等操作做自动重试（LLM API 调用、结构化输出解析）
// 2. 指数退避 + jitter，避免重试风暴打爆上游
// 3. 区分可重试 / 不可重试错误，不可重试的立刻抛出
//
// 关键设计：
// - 只重试幂等操作。工具执行（写文件/删除）不得走这里，重试会产生副作用
// - 错误分类靠"错误码 / HTTP 状态码 / 消息子串"三路匹配，兼容 SDK 包装后的错误
// - RetryableError 是显式标记：业务代码（如 JSON 解析失败）抛它即可获得重试
// - 不做熔断和全局限流，超出 maxRetries 直接抛最后一次错误给调用方
//
// 使用示例：
//   const retry = new RetryHandler({ maxRetries: 3 }, logger);
//   const res = await retry.execute(() => fetchSomething(), 'DeepSeek API 调用');
//
// 配置参数见：.env.example 的 RETRY_* 部分
// ============================================

import { BaseAgentError } from './errors.js';

/**
 * 显式可重试错误：业务层主动抛出以请求重试
 * 典型场景：模型返回的 JSON 解析失败 / Schema 校验不通过，重新生成一次即可
 */
export class RetryableError extends BaseAgentError {
  constructor(message: string) {
    super(message, 'RETRYABLE_ERROR', true);
  }
}

export interface RetryConfig {
  maxRetries: number;         // 最大重试次数（不含首次尝试）
  baseDelay: number;          // 基础延迟（ms），指数退避的起点
  maxDelay: number;           // 单次延迟上限（ms）
  retryableErrors: string[];  // 可重试的错误码 / 状态码 / 消息特征
  // 只重试显式的 RetryableError，不做错误特征匹配。
  // 用于「嵌套在已有重试之上」的外层：网络错误已由内层（LLM Adapter）重试完，
  // 外层再按特征匹配一次会让总调用数变成两层相乘（4×4=16）。
  explicitOnly: boolean;
}

export const DEFAULT_RETRYABLE_ERRORS = [
  // 网络层
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EPIPE',
  'EAI_AGAIN',
  // HTTP 状态码（限流 + 服务端错误）
  '429',
  '500',
  '502',
  '503',
  '504',
  // 常见文本特征（SDK 常把状态码埋进 message）
  'rate limit',
  'timeout',
  'socket hang up',
  'overloaded',
];

const DEFAULTS: RetryConfig = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 60_000,
  retryableErrors: DEFAULT_RETRYABLE_ERRORS,
  explicitOnly: false,
};

// 只依赖 warn/info/debug/error 四个方法，避免与 Logger 形成循环导入
interface RetryLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export class RetryHandler {
  private config: RetryConfig;

  constructor(config: Partial<RetryConfig> = {}, private logger?: RetryLogger) {
    this.config = {
      maxRetries: config.maxRetries ?? DEFAULTS.maxRetries,
      baseDelay: config.baseDelay ?? DEFAULTS.baseDelay,
      maxDelay: config.maxDelay ?? DEFAULTS.maxDelay,
      retryableErrors: config.retryableErrors ?? DEFAULTS.retryableErrors,
      explicitOnly: config.explicitOnly ?? DEFAULTS.explicitOnly,
    };
  }

  /**
   * 执行一个幂等异步操作，失败时按策略重试
   * @param fn 待执行的函数（必须幂等，重试会重复调用）
   * @param operationName 操作名称，仅用于日志
   * @returns fn 的返回值
   * @throws 最后一次的错误（不可重试，或已用尽重试次数）
   */
  async execute<T>(fn: () => Promise<T>, operationName: string): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = this.calculateDelay(attempt);
        this.logger?.info('重试操作', {
          operation: operationName,
          attempt: `${attempt}/${this.config.maxRetries}`,
          delay_ms: delay,
        });
        await this.sleep(delay);
      }

      try {
        const result = await fn();
        if (attempt > 0) {
          this.logger?.info('重试后成功', { operation: operationName, attempts: attempt + 1 });
        }
        return result;
      } catch (error) {
        lastError = error;

        if (!this.isRetryable(error)) {
          this.logger?.warn('操作失败（不可重试）', {
            operation: operationName,
            error: this.describe(error),
          });
          throw error;
        }

        this.logger?.warn('操作失败（可重试）', {
          operation: operationName,
          attempt: attempt + 1,
          error: this.describe(error),
        });
      }
    }

    this.logger?.error('重试次数已用尽', {
      operation: operationName,
      max_retries: this.config.maxRetries,
      error: this.describe(lastError),
    });
    throw lastError;
  }

  /**
   * 判断错误是否可重试
   * 匹配顺序：显式标记 → 错误码 / 状态码 / 消息子串
   */
  private isRetryable(error: unknown): boolean {
    if (error instanceof RetryableError) {
      return true;
    }

    // 外层模式：网络类错误交给内层重试，这里不再按特征匹配（避免次数相乘）
    if (this.config.explicitOnly) {
      return false;
    }

    const err = error as { code?: unknown; status?: unknown; message?: unknown };
    const haystack = [
      typeof err?.code === 'string' || typeof err?.code === 'number' ? String(err.code) : '',
      err?.status !== undefined ? String(err.status) : '',
      typeof err?.message === 'string' ? err.message : '',
    ]
      .join(' ')
      .toLowerCase();

    return this.config.retryableErrors.some(pattern =>
      haystack.includes(pattern.toLowerCase())
    );
  }

  /**
   * 指数退避 + jitter
   * delay = baseDelay * 2^(attempt-1) ± 30%，并截断到 maxDelay
   * jitter 用于打散并发客户端的重试时刻，避免同时打上游
   */
  private calculateDelay(attempt: number): number {
    const exponential = this.config.baseDelay * Math.pow(2, attempt - 1);
    const jitter = exponential * 0.3 * (Math.random() * 2 - 1);
    return Math.max(0, Math.min(Math.round(exponential + jitter), this.config.maxDelay));
  }

  private describe(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
