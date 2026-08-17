// ============================================
// Platform 层:配置管理
// ============================================

// 单个模型配置
export interface ModelConfig {
  provider: 'deepseek' | 'openai';
  apiKey: string;
  baseURL?: string;
  model: string;
  temperature: number;
  maxTokens?: number;
  enableThinking?: boolean;  // 是否开启推理模式(如 DeepSeek 的 reasoning_content)
}

export interface AgentConfig {
  // 多模型配置
  models: {
    main: ModelConfig;        // 主模型(必需)
    fast?: ModelConfig;       // 快速模型(可选)
    reasoning?: ModelConfig;  // 推理模型(可选)
  };

  // 执行控制
  execution: {
    maxSteps: number;          // 最大工具调用轮数
    timeout: number;           // 单次工具超时(ms)
  };

  // 上下文管理
  context: {
    windowSize: number;        // 上下文窗口大小(token)
    compressionThreshold: number;  // 压缩触发阈值(占窗口比例)
    recentTurnsToKeep: number;     // 压缩时保留的最近轮数
    maxTopicsInContext: number;    // 上下文中最多保留的主题数量（时间滑动窗口）
    maxDOMTokens: number;          // DOM/无障碍树单次上限
    maxContentTokens: number;      // 网页正文单次上限
    maxFileTokens: number;         // 文件读取单次上限
  };

  // 安全配置
  security: {
    fsSandboxPaths: string[];  // 文件系统白名单路径
    allowDangerousTools: boolean;  // 是否启用危险工具
  };

  // 重试配置（幂等操作:LLM 调用/结构化输出解析）
  retry: {
    maxRetries: number;          // 最大重试次数(不含首次尝试)
    baseDelay: number;           // 指数退避基础延迟(ms)
    maxDelay: number;            // 单次延迟上限(ms)
    retryableErrors?: string[];  // 可重试错误特征,未配置则用内置默认表
  };

  // 日志
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

// 默认配置
const buildModels = (): { main: ModelConfig; fast?: ModelConfig; reasoning?: ModelConfig } => {
  const models = {
    main: {
      provider: 'deepseek' as 'deepseek' | 'openai',
      apiKey: process.env.DEEPSEEK_API_KEY || '',
      baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
      model: process.env.MAIN_MODEL || 'deepseek-v4-flash',
      temperature: parseFloat(process.env.MAIN_TEMPERATURE || '0.7'),
      maxTokens: process.env.MAIN_MAX_TOKENS ? parseInt(process.env.MAIN_MAX_TOKENS) : undefined,
      enableThinking: process.env.MAIN_ENABLE_THINKING !== 'false', // 默认开启
    },
  } as { main: ModelConfig; fast?: ModelConfig; reasoning?: ModelConfig };

  // 可选的 fast 模型
  if (process.env.FAST_MODEL) {
    const fastProvider = process.env.FAST_PROVIDER || 'deepseek';
    models.fast = {
      provider: (fastProvider === 'openai' ? 'openai' : 'deepseek') as 'deepseek' | 'openai',
      apiKey: process.env.DEEPSEEK_API_KEY || '',
      baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
      model: process.env.FAST_MODEL,
      temperature: parseFloat(process.env.FAST_TEMPERATURE || '0.3'),
      maxTokens: process.env.FAST_MAX_TOKENS ? parseInt(process.env.FAST_MAX_TOKENS) : undefined,
      enableThinking: process.env.FAST_ENABLE_THINKING === 'true', // 默认关闭
    };
  }

  // 可选的 reasoning 模型
  if (process.env.REASONING_MODEL) {
    const reasoningProvider = process.env.REASONING_PROVIDER || 'deepseek';
    models.reasoning = {
      provider: (reasoningProvider === 'openai' ? 'openai' : 'deepseek') as 'deepseek' | 'openai',
      apiKey: process.env.DEEPSEEK_API_KEY || '',
      baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
      model: process.env.REASONING_MODEL,
      temperature: parseFloat(process.env.REASONING_TEMPERATURE || '0.9'),
      maxTokens: process.env.REASONING_MAX_TOKENS ? parseInt(process.env.REASONING_MAX_TOKENS) : undefined,
      enableThinking: process.env.REASONING_ENABLE_THINKING !== 'false', // 默认开启
    };
  }

  return models;
};

export const defaultConfig: AgentConfig = {
  models: buildModels(),
  execution: {
    maxSteps: process.env.MAX_STEPS ? parseInt(process.env.MAX_STEPS) : 20,
    timeout: process.env.EXECUTION_TIMEOUT ? parseInt(process.env.EXECUTION_TIMEOUT) : 60000,
  },
  context: {
    windowSize: process.env.CONTEXT_WINDOW_SIZE ? parseInt(process.env.CONTEXT_WINDOW_SIZE) : 1_000_000,
    compressionThreshold: process.env.CONTEXT_COMPRESSION_THRESHOLD ? parseFloat(process.env.CONTEXT_COMPRESSION_THRESHOLD) : 0.7,
    recentTurnsToKeep: process.env.CONTEXT_RECENT_TURNS ? parseInt(process.env.CONTEXT_RECENT_TURNS) : 10,
    maxTopicsInContext: process.env.CONTEXT_MAX_TOPICS ? parseInt(process.env.CONTEXT_MAX_TOPICS) : 10,
    maxDOMTokens: process.env.CONTEXT_MAX_DOM_TOKENS ? parseInt(process.env.CONTEXT_MAX_DOM_TOKENS) : 20_000,
    maxContentTokens: process.env.CONTEXT_MAX_CONTENT_TOKENS ? parseInt(process.env.CONTEXT_MAX_CONTENT_TOKENS) : 10_000,
    maxFileTokens: process.env.CONTEXT_MAX_FILE_TOKENS ? parseInt(process.env.CONTEXT_MAX_FILE_TOKENS) : 10_000,
  },
  security: {
    fsSandboxPaths: process.env.FS_SANDBOX_PATHS ? process.env.FS_SANDBOX_PATHS.split(',') : [],
    allowDangerousTools: process.env.ALLOW_DANGEROUS_TOOLS === 'true',
  },
  retry: {
    maxRetries: process.env.RETRY_MAX_ATTEMPTS ? parseInt(process.env.RETRY_MAX_ATTEMPTS) : 3,
    baseDelay: process.env.RETRY_BASE_DELAY ? parseInt(process.env.RETRY_BASE_DELAY) : 1000,
    maxDelay: process.env.RETRY_MAX_DELAY ? parseInt(process.env.RETRY_MAX_DELAY) : 60_000,
    // 未配置时留空,由 RetryHandler 使用内置默认错误表
    retryableErrors: process.env.RETRY_RETRYABLE_ERRORS
      ? process.env.RETRY_RETRYABLE_ERRORS.split(',').map(s => s.trim()).filter(Boolean)
      : undefined,
  },
  logLevel: (process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error') || 'info',
};

export function loadConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const models: { main: ModelConfig; fast?: ModelConfig; reasoning?: ModelConfig } = {
    main: { ...defaultConfig.models.main, ...overrides.models?.main },
  };

  // 合并可选的 fast 模型
  if (defaultConfig.models.fast || overrides.models?.fast) {
    models.fast = { ...defaultConfig.models.fast, ...overrides.models?.fast } as ModelConfig;
  }

  // 合并可选的 reasoning 模型
  if (defaultConfig.models.reasoning || overrides.models?.reasoning) {
    models.reasoning = { ...defaultConfig.models.reasoning, ...overrides.models?.reasoning } as ModelConfig;
  }

  return {
    ...defaultConfig,
    ...overrides,
    models,
    execution: { ...defaultConfig.execution, ...overrides.execution },
    context: { ...defaultConfig.context, ...overrides.context },
    security: { ...defaultConfig.security, ...overrides.security },
    retry: { ...defaultConfig.retry, ...overrides.retry },
  };
}
