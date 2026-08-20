// ============================================
// Core 层:子 Agent 执行器(一次性 / stateless)
// ============================================
//
// 职责：
// 1. 接一个自包含的任务描述，用**独立上下文**跑完，只把最终回答交回主 agent
// 2. 子 agent 用完即弃：不驻留、不续传（stateful 模式留作后续增量）
//
// 为什么要它：
// 需要吞大量上下文的子任务（遍历代码库、批量抓取）如果在主 agent 里做，
// 十几个文件的内容会全部堆进主上下文，可能在攒够压缩轮次前就撑破窗口。
// 下放给子 agent 后，那些内容留在子 agent 自己的上下文里，主 agent 只收到一段回答 ——
// 从源头避免膨胀，比事后压缩更根本。
//
// 关键设计：
// - 结构上杜绝递归：子 agent 的工具集从父 registry 复制，但跳过 needs 含 'agent' 的工具
// - 安全边界不放宽：共享父级的 signal（取消可连带）与 confirm（危险工具仍需用户确认），
//   权限仍由 needs + SecurityGuard 两层管住，没有新的提权面
// - 结果即蒸馏：直接返回 final_response，不再多调一次 LLM 做摘要
//   （实测模型最终回答的信息密度远高于原始数据）
// - 失败不炸主循环：一律以 ok:false 返回，交给模型自行改道
// - 配额：限制单次会话内可 spawn 的次数，防止主 agent 连续下放烧钱
//
// 配置参数见：.env.example 的 SUBAGENT_* 部分
// ============================================

import {
  ToolRegistry,
  ToolRunner,
  SubAgentRunner,
  SubAgentRequest,
  SubAgentResult,
  ConfirmRequest,
} from '../tools/index.js';
import { Logger } from '../platform/index.js';
import { LLMClient } from './llm-client.js';
import { ContextManager, ContextConfig } from './context.js';
import { Orchestrator } from './orchestrator.js';

export interface SubAgentConfig {
  parentSessionId: string;
  logger: Logger;
  signal: AbortSignal;
  onConfirmRequired: (req: ConfirmRequest) => Promise<boolean>;
  allowDangerousTools: boolean;
  fsSandboxPaths: string[];

  maxSteps: number;      // 单个子 agent 的步数预算
  maxCount: number;      // 单次会话内最多 spawn 多少个子 agent

  // 子 agent 自己的上下文配置（除 sessionId 外与主 agent 同构）
  contextConfig: Omit<ContextConfig, 'sessionId' | 'logger'>;

  systemPrompt?: string;  // 子 agent 的系统提示，未给则用内置默认
}

const DEFAULT_SYSTEM_PROMPT =
  '你是一个专注的子任务执行器。你会收到一个自包含的任务，请用提供的工具完成它。\n' +
  '你看不到主对话的历史，任务描述里的信息就是你拥有的全部背景。\n' +
  '完成后给出一段**高信息密度**的回答：直接写结论与关键事实（具体数值、路径、名称），' +
  '不要复述过程，不要客套。你的回答会作为唯一产物交回主 agent，' +
  '中间读到的原始内容不会传出去，所以必须把结论写全。';

export class LocalSubAgentRunner implements SubAgentRunner {
  private spawnCount = 0;

  constructor(
    private llmClient: LLMClient,
    private parentRegistry: ToolRegistry,
    private config: SubAgentConfig,
  ) {}

  remainingQuota(): number {
    return Math.max(0, this.config.maxCount - this.spawnCount);
  }

  async run(request: SubAgentRequest): Promise<SubAgentResult> {
    const { logger } = this.config;

    if (this.remainingQuota() <= 0) {
      const error =
        `子 agent 配额已用尽（上限 ${this.config.maxCount}）。` +
        `请直接用工具完成剩余工作，或缩小任务范围。`;
      logger.warn('子 agent 配额已用尽', { max_count: this.config.maxCount });
      return { ok: false, error };
    }

    // 父任务已取消时不该再起新的子 agent
    if (this.config.signal.aborted) {
      return { ok: false, error: '任务已取消，不再启动子 agent' };
    }

    this.spawnCount++;
    const subAgentId = `sub-${this.spawnCount}`;
    const sessionId = `${this.config.parentSessionId}-${subAgentId}`;

    logger.info('启动子 agent', {
      sub_agent_id: subAgentId,
      task: request.task.slice(0, 80),
      remaining_quota: this.remainingQuota(),
    });

    let context: ContextManager | undefined;

    try {
      // ① 独立上下文 —— 子 agent 的核心价值所在：
      //    它读到的内容全部留在这里，主 agent 的上下文不受影响
      context = new ContextManager(
        {
          ...this.config.contextConfig,
          sessionId,
          logger,
        },
        this.llmClient,
      );
      await context.initialize();

      // ② 工具集：继承父 registry，但排除子 agent 相关工具（结构上无递归）
      const registry = this.buildChildRegistry();

      // ③ runner：共享父级 signal 与 confirm —— 安全边界不因下放而放宽。
      //    注意不传 subAgentRunner，双重保证拿不到 spawn 能力
      const runner = new ToolRunner(registry, {
        sessionId,
        logger,
        signal: this.config.signal,
        onConfirmRequired: this.config.onConfirmRequired,
        allowDangerousTools: this.config.allowDangerousTools,
        fsSandboxPaths: this.config.fsSandboxPaths,
      });

      const orchestrator = new Orchestrator(this.llmClient, runner, registry, {
        maxSteps: this.config.maxSteps,
        logger,
        context,
        // trace 里能按子 agent 归因 token 与步数
        traceLabelPrefix: `subagent:${subAgentId}`,
      });

      context.addSystemMessage(this.config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT);

      const userContent = request.context
        ? `任务：${request.task}\n\n背景信息：\n${request.context}`
        : request.task;

      const run = await orchestrator.run([{ role: 'user', content: userContent }]);

      const stats = context.getStats();
      const truncated = run.stopReason === 'max_steps';

      logger.info('子 agent 完成', {
        sub_agent_id: subAgentId,
        stop_reason: run.stopReason,
        turns: stats.turns,
        prompt_tokens: stats.tokens.total_prompt,
        completion_tokens: stats.tokens.total_completion,
      });

      if (truncated) {
        // 必须往上传：子 agent 的截断是嵌套的，中间任何一层吞掉这个信号，
        // 主 agent 就会把半成品当定论用
        logger.warn('子 agent 因步数上限提前收尾', {
          sub_agent_id: subAgentId,
          max_steps: this.config.maxSteps,
        });
      }

      return {
        ok: true,
        answer: run.answer,
        truncated,
        stats: {
          subAgentId,
          steps: stats.tokens.turns.length,
          llmCalls: stats.tokens.turns.length,
          promptTokens: stats.tokens.total_prompt,
          completionTokens: stats.tokens.total_completion,
        },
      };
    } catch (error) {
      // 子 agent 失败不炸主循环：包成 ok:false 让主 agent 自行改道
      const message = error instanceof Error ? error.message : String(error);
      logger.error('子 agent 执行失败', { sub_agent_id: subAgentId, error: message });
      return {
        ok: false,
        error: `子 agent 执行失败：${message}`,
        stats: context
          ? {
              subAgentId,
              steps: context.getStats().tokens.turns.length,
              llmCalls: context.getStats().tokens.turns.length,
              promptTokens: context.getStats().tokens.total_prompt,
              completionTokens: context.getStats().tokens.total_completion,
            }
          : undefined,
      };
    } finally {
      // 一次性：用完即释放 tokenizer 等资源
      context?.dispose();
    }
  }

  /**
   * 构造子 agent 的工具集
   *
   * 继承父 registry 的全部工具，但跳过 needs 含 'agent' 的（即 spawn 自身）——
   * 从结构上杜绝无限递归，而不是靠深度计数去兜。
   */
  private buildChildRegistry(): ToolRegistry {
    const registry = new ToolRegistry(this.config.logger);
    const skipped: string[] = [];

    for (const tool of this.parentRegistry.all()) {
      if (tool.needs.includes('agent')) {
        skipped.push(tool.name);
        continue;
      }
      registry.register(tool);
    }

    if (skipped.length > 0) {
      this.config.logger.debug('子 agent 工具集已排除递归入口', { skipped });
    }

    return registry;
  }
}
