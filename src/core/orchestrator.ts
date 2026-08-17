// ============================================
// Core 层:主循环 Orchestrator(集成 Context 管理)
// ============================================

import { LLMClient, Message } from './llm-client.js';
import { ToolRunner, ToolRegistry } from '../tools/index.js';
import { Logger, MaxStepsExceededError } from '../platform/index.js';
import { ContextManager } from './context.js';

export interface OrchestratorConfig {
  maxSteps: number;
  logger: Logger;
  context?: ContextManager;  // 可选的上下文管理器
  modelKey?: 'main' | 'fast' | 'reasoning';  // 指定使用哪个模型配置
}

export interface AgentTurn {
  messages: Message[];
  currentStep: number;
}

export class Orchestrator {
  constructor(
    private llmClient: LLMClient,
    private toolRunner: ToolRunner,
    private toolRegistry: ToolRegistry,
    private config: OrchestratorConfig,
  ) {}

  async run(initialMessages: Message[]): Promise<string> {
    const context = this.config.context;

    // 如果有 Context 管理器，使用它管理消息
    if (context) {
      // 添加初始消息到 Context
      // addUserMessage 内部可能触发压缩（await），必须串行等待，否则多条初始消息会乱序
      for (const msg of initialMessages) {
        if (msg.role === 'system') {
          context.addSystemMessage(msg.content!);
        } else if (msg.role === 'user') {
          await context.addUserMessage(msg.content!);
        }
      }
    }

    const messages = context ? [] : [...initialMessages];  // Context 模式下不用本地数组
    let step = 0;

    this.config.logger.info('开始主循环', { maxSteps: this.config.maxSteps });

    while (step < this.config.maxSteps) {
      step++;
      this.config.logger.debug(`主循环步骤 ${step}/${this.config.maxSteps}`);

      // 准备 Prompt（触发压缩检查）
      const currentMessages = context ? await context.preparePrompt() : messages;

      // 调用 LLM
      const response = await this.llmClient.complete({
        messages: currentMessages,
        tools: this.toolRegistry.getAllDescriptions(),
        traceLabel: `main-loop:step-${step}`,
      });

      // 记录 Token 使用量（如果有 Context）
      if (context && response.usage) {
        context.recordTokenUsage({
          prompt_tokens: response.usage.prompt_tokens,
          completion_tokens: response.usage.completion_tokens,
          prompt_cache_hit_tokens: response.usage.prompt_cache_hit_tokens
        });
      }

      // 如果有工具调用
      if (response.toolCalls.length > 0) {
        this.config.logger.info(`模型请求调用 ${response.toolCalls.length} 个工具`);

        // 如果有推理内容，先输出
        if (response.reasoning) {
          this.config.logger.info('模型推理过程', { reasoning: response.reasoning });
        }

        // 添加 assistant 消息
        if (context) {
          context.addAssistantMessage(
            response.content ?? '',  // 将 null 转换为空字符串
            response.toolCalls,
            response.reasoning ?? undefined
          );
        } else {
          messages.push({
            role: 'assistant',
            content: response.content || '',
            reasoning: response.reasoning || undefined,
            toolCalls: response.toolCalls,
          });
        }

        // 依次执行工具(后续可支持并行)
        for (const toolCall of response.toolCalls) {
          const result = await this.toolRunner.run({
            id: toolCall.id,
            name: toolCall.name,
            args: toolCall.args,
          });

          // 添加工具结果
          const resultContent = JSON.stringify(result);
          if (context) {
            context.addToolResult(toolCall.id, resultContent);
          } else {
            messages.push({
              role: 'tool',
              toolCallId: toolCall.id,
              content: resultContent,
            });
          }
        }

        // 继续循环,把工具结果喂回模型
        continue;
      }

      // 无工具调用 + 有内容 → 任务完成
      if (response.content) {
        this.config.logger.info('任务完成', { steps: step });

        // 记录最终回复：压缩后重建保留轮次时，这是答案的唯一来源
        if (context) {
          context.addFinalResponse(response.content, response.reasoning ?? undefined);
        } else {
          messages.push({
            role: 'assistant',
            content: response.content,
            reasoning: response.reasoning || undefined,
          });
        }

        // 输出最终统计
        if (context) {
          const stats = context.getStats();
          this.config.logger.info('会话统计', stats);
        }

        return response.content;
      }

      // 无工具调用 + 无内容 → 异常
      this.config.logger.warn('模型未返回内容且无工具调用');
      return '任务未完成:模型无有效响应';
    }

    // 到达最大步数
    throw new MaxStepsExceededError(this.config.maxSteps);
  }
}
