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
    maxDOMTokens: number;          // DOM/无障碍树单次上限
    maxContentTokens: number;      // 网页正文单次上限
    maxFileTokens: number;         // 文件读取单次上限
  };

  // 安全配置
  security: {
    fsSandboxPaths: string[];  // 文件系统白名单路径
    allowDangerousTools: boolean;  // 是否启用危险工具
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
    maxSteps: 20,
    timeout: 60000,
  },
  context: {
    windowSize: 1_000_000,
    compressionThreshold: 0.7,
    recentTurnsToKeep: 10,
    maxDOMTokens: 20_000,
    maxContentTokens: 10_000,
    maxFileTokens: 10_000,
  },
  security: {
    fsSandboxPaths: [],
    allowDangerousTools: false,
  },
  logLevel: 'info',
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
  };
}
