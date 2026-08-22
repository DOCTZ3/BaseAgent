// ============================================
// Core 层:主循环 Orchestrator(集成 Context 管理)
// ============================================

import { LLMClient, Message, ContentPart } from './llm-client.js';
import { ToolRunner, ToolRegistry, type ImageAttachment } from '../tools/index.js';
import { Logger, MaxStepsExceededError } from '../platform/index.js';
import { ContextManager } from './context.js';

export interface OrchestratorConfig {
  maxSteps: number;
  logger: Logger;
  context?: ContextManager;  // 可选的上下文管理器
  modelKey?: 'main' | 'fast' | 'reasoning';  // 指定使用哪个模型配置
  // trace 标签前缀。默认 'main-loop'，子 agent 传 'subagent:<id>'，
  // 这样同一份 trace 里能区分调用来源、按子 agent 归因 token 与步数
  traceLabelPrefix?: string;
}

export interface AgentTurn {
  messages: Message[];
  currentStep: number;
}

/**
 * run() 的结果
 *
 * 用对象而非裸字符串：退出路径有三条，但字符串只能表达一种。
 * 尤其 no_response 那条以前返回一句写死的话，和真实回答走同一通道，
 * 调用方无法区分「模型给了答案」和「模型没给答案」。
 */
export interface AgentRunResult {
  answer: string;
  /**
   * complete    正常给出最终回答
   * max_steps   触达步数上限、由收尾调用产出结论（结论可能不完整）
   * no_response 模型既无工具调用也无内容
   */
  stopReason: 'complete' | 'max_steps' | 'no_response';
  steps: number;   // 主循环实际执行的步数（收尾调用不计入）
}

/**
 * 触达上限时塞进最后一条工具结果的提示
 *
 * 借工具结果的通道传递，而不是新加一条 user 消息 —— 这样它天然落在
 * assistant/tool 的配对之内，不必关心「插在哪里才合法」。
 * （Turn 改平铺存储后，新加 user 消息也不再是障碍，可走 addObservation()；
 * 但借工具结果通道更省一条消息。）
 *
 * 用 `_system_note` 这个键名标明它不是工具返回的数据；放进对象内部而非
 * 拼在 JSON 之后，否则会破坏合法性。
 *
 * 刻意**不给重试建议**：新子 agent 是全新上下文，不知道上一个读到哪、卡在哪，
 * 大概率用相似范围重跑、撞同一面墙。要不要补齐由模型看着「未完成部分」自己判断。
 */
function buildWrapUpNote(maxSteps: number): string {
  return `已达到步数上限（${maxSteps} 步），不要再调用工具。` +
    `请基于现有信息给出结论，并明确说明哪些部分尚未完成。`;
}

export class Orchestrator {
  constructor(
    private llmClient: LLMClient,
    private toolRunner: ToolRunner,
    private toolRegistry: ToolRegistry,
    private config: OrchestratorConfig,
  ) {}

  async run(initialMessages: Message[]): Promise<AgentRunResult> {
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

    // 本步工具产出的图片，攒到全部 tool 响应写完后再注入（见下方注入处注释）
    const pendingAttachments: ImageAttachment[] = [];

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
        traceLabel: `${this.config.traceLabelPrefix ?? 'main-loop'}:step-${step}`,
      });

      // 记录 Token 使用量（如果有 Context）
      // 整个 usage 直接透传：逐字段列举时新增字段会被静默丢掉
      // （缓存命中失效就是这类问题，只是发生在 adapter 那一层）
      if (context && response.usage) {
        context.recordTokenUsage(response.usage);
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

        // 本步是否已是最后一步：若是，把「该收尾了」随工具结果一并告知模型。
        // 写入时就带上，而不是事后回头改历史消息 —— 后者会让 messages 与 Turn 不一致
        const isLastStep = step >= this.config.maxSteps;

        // 依次执行工具(后续可支持并行)
        for (let i = 0; i < response.toolCalls.length; i++) {
          const toolCall = response.toolCalls[i];
          const result = await this.toolRunner.run({
            id: toolCall.id,
            name: toolCall.name,
            args: toolCall.args,
          });

          // 只挂在最后一个工具结果上，避免同一提示重复 N 遍
          const isLastResult = i === response.toolCalls.length - 1;
          const payload = (isLastStep && isLastResult)
            ? { ...result, _system_note: buildWrapUpNote(this.config.maxSteps) }
            : result;

          // 附件不进 tool 消息：OpenAI 兼容接口的 role:'tool' content 只接受字符串，
          // 图片块只允许出现在 user 消息里。剥出来单独注入（见下方）
          const { attachments, ...rest } = payload as typeof payload & {
            attachments?: ImageAttachment[];
          };

          // 添加工具结果
          const resultContent = JSON.stringify(rest);
          if (context) {
            context.addToolResult(toolCall.id, resultContent);
          } else {
            messages.push({
              role: 'tool',
              toolCallId: toolCall.id,
              content: resultContent,
            });
          }

          // 图片以 user 消息承载。必须排在全部 tool 消息之后 ——
          // assistant 声明 N 个 tool_call 后，API 要求紧跟 N 条 tool 响应，
          // 中间插入 user 会让序列非法并直接 400
          if (attachments?.length) {
            pendingAttachments.push(...attachments);
          }
        }

        // 所有 tool 响应写完后再注入图片，此时序列已完整
        if (pendingAttachments.length > 0) {
          const parts: ContentPart[] = [
            {
              type: 'text',
              text: `以下是工具返回的图片（${pendingAttachments
                .map(a => a.label)
                .join('、')}）：`,
            },
            ...pendingAttachments.map(a => ({
              type: 'image' as const,
              data: a.data,
              mimeType: a.mimeType,
              detail: a.detail,
              label: a.label,
              width: a.width,
              height: a.height,
            })),
          ];

          this.config.logger.info('注入图片附件', {
            count: pendingAttachments.length,
            labels: pendingAttachments.map(a => a.label),
          });

          if (context) {
            context.addObservation(parts);
          } else {
            messages.push({ role: 'user', content: parts });
          }

          pendingAttachments.length = 0;
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

        return { answer: response.content, stopReason: 'complete', steps: step };
      }

      // 无工具调用 + 无内容 → 模型无有效响应
      // 用 stopReason 表达，不再把这句写死的话混进正常回答通道
      this.config.logger.warn('模型未返回内容且无工具调用');
      return {
        answer: '任务未完成:模型无有效响应',
        stopReason: 'no_response',
        steps: step,
      };
    }

    // 到达最大步数：不硬停，再给模型一次机会收尾
    return this.wrapUp(step);
  }

  /**
   * 触达步数上限后的收尾调用
   *
   * 为什么不直接抛 MaxStepsExceededError：那样会丢掉整轮探索的全部成果。
   * 子 agent 场景尤其贵 —— 跑满 15 步读了十几个文件，抛异常后主 agent 只收到
   * 一句「执行失败」，那些 token 白花，且拿不到任何部分结果。
   *
   * 关键点：
   * - **不传 tools**：光在提示里说「不要调用工具」不够硬，模型仍可能返回
   *   tool_calls 让流程卡住；请求里不带 tools 从协议层杜绝
   * - **不占常规步数**：在循环外执行，否则会陷入「为了收尾又超限」的死结
   * - 收尾要求模型说清**未完成的部分** —— 有了缺口描述，后续无论是模型自己补
   *   还是用户接手，都是有靶子的；没有它，任何重试都是盲的
   */
  private async wrapUp(step: number): Promise<AgentRunResult> {
    const context = this.config.context;
    const prefix = this.config.traceLabelPrefix ?? 'main-loop';

    this.config.logger.warn('达到步数上限，转入收尾', {
      max_steps: this.config.maxSteps,
    });

    try {
      const currentMessages = context ? await context.preparePrompt() : [];

      const response = await this.llmClient.complete({
        messages: currentMessages,
        // 刻意不传 tools
        traceLabel: `${prefix}:final-wrap`,
      });

      // 整个 usage 透传，理由同主循环那一处
      if (context && response.usage) {
        context.recordTokenUsage(response.usage);
      }

      if (!response.content) {
        // 不传 tools 时协议上不该发生；仍兜底，不再重试
        this.config.logger.error('收尾调用未返回内容');
        return {
          answer: `任务因达到步数上限（${this.config.maxSteps} 步）中止，且未能生成结论。`,
          stopReason: 'max_steps',
          steps: step,
        };
      }

      if (context) {
        context.addFinalResponse(response.content, response.reasoning ?? undefined);
      }

      this.config.logger.info('收尾完成', { steps: step });
      return { answer: response.content, stopReason: 'max_steps', steps: step };

    } catch (error) {
      // 收尾本身失败（网络/限流）→ 没有任何可返回的内容，退回抛错。
      // MaxStepsExceededError 因此保留用途，只是从「必然抛出」变成「极少抛出」
      this.config.logger.error('收尾调用失败', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new MaxStepsExceededError(this.config.maxSteps);
    }
  }
}
