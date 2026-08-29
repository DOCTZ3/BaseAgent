// ============================================
// Platform 层:错误体系
// ============================================

export class BaseAgentError extends Error {
  constructor(
    message: string,
    public code: string,
    public recoverable: boolean = false,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ToolExecutionError extends BaseAgentError {
  constructor(message: string, public toolName: string) {
    super(message, 'TOOL_EXECUTION_ERROR', true);
  }
}

export class ValidationError extends BaseAgentError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR', true);
  }
}

export class SecurityError extends BaseAgentError {
  constructor(message: string) {
    super(message, 'SECURITY_ERROR', false);
  }
}

/**
 * LLM 调用失败
 *
 * `detail` 存**服务端的原话**,而 `message` 只放我们自己的概括。
 *
 * 为什么分成两个字段:adapter 刻意不把原始消息拼进 message ——
 * `ECONNRESET` 这类特征字符串一旦进了 message,外层 RetryHandler 会按
 * DEFAULT_RETRYABLE_ERRORS 匹配到并再重试一轮,调用次数变成 4×4=16。
 *
 * 但原先的做法是把原话整个**丢掉**,代价是所有排查线索一起没了:
 * 中转站返回的 `Output data may contain inappropriate content.`
 * (输出被内容审查拦下)和一个普通网络抖动,在界面上长得一模一样,
 * 都只显示「LLM API 调用失败」。实测排查这个只能去翻 trace 文件。
 *
 * 分字段之后两边都成立:RetryHandler 只看 message/code/status,
 * 匹配范围一个字节没变宽;而 detail 一路透传到界面,用户直接看到原因。
 */
export class LLMError extends BaseAgentError {
  constructor(
    message: string,
    recoverable: boolean = true,
    /** 服务端/SDK 的原始消息。**绝不能**拼进 message —— 见上面的相乘问题 */
    public detail?: string,
  ) {
    super(message, 'LLM_ERROR', recoverable);
  }

  /** 给人看的完整描述:概括 + 原话 */
  get fullMessage(): string {
    return this.detail ? `${this.message}: ${this.detail}` : this.message;
  }
}

export class MaxStepsExceededError extends BaseAgentError {
  constructor(steps: number) {
    super(`达到最大步数限制 ${steps}`, 'MAX_STEPS_EXCEEDED', false);
  }
}

/**
 * 用户主动中断 —— **不是**失败
 *
 * 单独一个类型而不复用 LLMError:两者的处置完全相反。
 * 失败要重试、要告警、要在界面上标红;中断要立刻停手、安静收场。
 * 混在一起的话点一次「停止」会看到一条红色报错,像是自己把程序弄坏了。
 */
export class AbortedError extends BaseAgentError {
  constructor(message = '已中断') {
    super(message, 'ABORTED', false);
  }
}

/**
 * 判断一个错误是不是「中断」
 *
 * 认两个 name:
 * - `AbortError` —— DOM 标准(fetch / AbortController 抛的就是它)
 * - `APIUserAbortError` —— openai SDK 的包装
 * 按 name 而不是 instanceof:错误跨了 SDK 边界,instanceof 依赖同一份类定义,
 * 而 SDK 升级或多副本安装都会让它静默失效。
 *
 * 放在 platform 层是有意的 —— RetryHandler 要用它,而 platform 不该 import SDK。
 * 认 name 就不需要那个依赖。
 */
export function isAbortError(error: unknown): boolean {
  if (error instanceof AbortedError) return true;
  const name = (error as { name?: unknown })?.name;
  return name === 'AbortError' || name === 'APIUserAbortError';
}
