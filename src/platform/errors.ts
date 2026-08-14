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

export class LLMError extends BaseAgentError {
  constructor(message: string, recoverable: boolean = true) {
    super(message, 'LLM_ERROR', recoverable);
  }
}

export class MaxStepsExceededError extends BaseAgentError {
  constructor(steps: number) {
    super(`达到最大步数限制 ${steps}`, 'MAX_STEPS_EXCEEDED', false);
  }
}
