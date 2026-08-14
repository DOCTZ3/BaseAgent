// ============================================
// Core 层:主循环 Orchestrator
// ============================================

import { LLMClient, Message } from './llm-client.js';
import { ToolRunner, ToolRegistry } from '../tools/index.js';
import { Logger, MaxStepsExceededError } from '../platform/index.js';

export interface OrchestratorConfig {
  maxSteps: number;
  logger: Logger;
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
    const messages = [...initialMessages];
    let step = 0;

    this.config.logger.info('开始主循环', { maxSteps: this.config.maxSteps });

    while (step < this.config.maxSteps) {
      step++;
      this.config.logger.debug(`主循环步骤 ${step}/${this.config.maxSteps}`);

      // 调用 LLM
      const response = await this.llmClient.complete({
        messages,
        tools: this.toolRegistry.getAllDescriptions(),
      });

      // 如果有工具调用
      if (response.toolCalls.length > 0) {
        this.config.logger.info(`模型请求调用 ${response.toolCalls.length} 个工具`);

        // 如果有推理内容，先输出
        if (response.reasoning) {
          this.config.logger.info('模型推理过程', { reasoning: response.reasoning });
        }

        // 将 assistant 的工具调用加入消息栈
        messages.push({
          role: 'assistant',
          content: response.content || '',
          reasoning: response.reasoning || undefined,
          toolCalls: response.toolCalls,
        });

        // 依次执行工具(后续可支持并行)
        for (const toolCall of response.toolCalls) {
          const result = await this.toolRunner.run({
            id: toolCall.id,
            name: toolCall.name,
            args: toolCall.args,
          });

          // 将工具结果加入消息栈
          messages.push({
            role: 'tool',
            toolCallId: toolCall.id,
            content: JSON.stringify(result),
          });
        }

        // 继续循环,把工具结果喂回模型
        continue;
      }

      // 无工具调用 + 有内容 → 任务完成
      if (response.content) {
        this.config.logger.info('任务完成', { steps: step });
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
