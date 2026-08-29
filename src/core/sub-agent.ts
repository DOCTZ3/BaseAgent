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
  type InheritableRunnerConfig,
} from '../tools/index.js';
import { Logger } from '../platform/index.js';
import { LLMClient } from './llm-client.js';
import { ContextManager, ContextConfig } from './context.js';
import { Orchestrator } from './orchestrator.js';
import {
  buildSubAgentSystemPrompt,
  type EnvironmentOptions,
} from './system-prompt.js';

export interface SubAgentConfig {
  parentSessionId: string;
  logger: Logger;
  signal: AbortSignal;
  onConfirmRequired: (req: ConfirmRequest) => Promise<boolean>;
  /**
   * 从主 agent 继承的资源与安全边界(整份传,不逐字段列举)
   *
   * **逐字段转发实测会漏**:先漏了 `visionAnalyzer`,又漏了 `pythonExecutor` ——
   * 后者让子 agent 的 `execute_python` 每次返回「未初始化」,它以为是自己代码
   * 的问题,连跑 `print("hello")` 探活,白烧十几步。
   * 整份传之后「新增执行器忘了给子 agent」这个失败模式从结构上消失。
   *
   * 安全边界随之一并继承(授权列表、deny 列表、危险工具开关)——
   * 下放任务不放宽边界。`subAgentRunner` 不在其中,子 agent 拿不到 spawn 能力。
   */
  inherited: InheritableRunnerConfig;

  maxSteps: number;      // 单个子 agent 的步数预算
  maxCount: number;      // 单次会话内最多 spawn 多少个子 agent

  // 子 agent 自己的上下文配置（除 sessionId 外与主 agent 同构）
  contextConfig: Omit<ContextConfig, 'sessionId' | 'logger'>;

  /**
   * 运行环境(代码执行 / 视觉插件 / 是否已收敛动作空间)
   *
   * **必填**,而且由这里自己拼提示、不接受入口传一段现成的 systemPrompt ——
   * 否则又会变成「入口忘了同步」的漏:子 agent 原本就是因为用一段独立短提示,
   * 对环境一无所知,拿 requests 去抓需要登录的站点、还可能 close 掉常驻浏览器。
   *
   * 环境约定与主 agent 出自**同一个函数**,变了只改一处。
   */
  environment: EnvironmentOptions;

  /**
   * 覆盖系统提示(仅测试/特殊场景用)
   *
   * 给了它就完全替换,**环境约定也会一并丢掉** —— 所以生产路径不要用
   */
  systemPromptOverride?: string;
}

/**
 * 不下放给子 agent 的工具(按名字)
 *
 * 两个都得按名字排除:它们没有可依赖的结构特征 ——
 * `request_help` 的 needs 是空数组,`run_command` 的 needs 是 ['shell'],
 * 而「有 shell 就排除」会在将来加入无害的 shell 类工具时误伤。
 *
 * 共同理由:**需要人当场判断的事,只能发生在用户正在对话的那个 agent 上。**
 * - `request_help`:子 agent 的输出只回给主 agent,用户看不到它说的话 ——
 *   它请求帮助等于打扰了用户、却没有任何人告诉用户该做什么。
 * - `run_command`:它唯一的安全机制就是用户读那行命令并判断。
 *   子 agent 的推理过程用户看不到,确认框会凭空冒出来 ——
 *   用户不知道这条 `pip install` 从哪来、为什么需要,只能盲点。
 *   而装包是对**整台机器**的副作用,这个决定该由主 agent 拿着上下文来做。
 */
const NO_SUBAGENT_TOOLS = new Set(['request_help', 'run_command']);


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
        // 资源与安全边界整份继承 —— 逐字段转发漏过两次（见 inherited 字段注释）
        ...this.config.inherited,
        sessionId,
        logger,
        signal: this.config.signal,
        onConfirmRequired: this.config.onConfirmRequired,
      });

      const orchestrator = new Orchestrator(this.llmClient, runner, registry, {
        maxSteps: this.config.maxSteps,
        logger,
        context,
        // trace 里能按子 agent 归因 token 与步数
        traceLabelPrefix: `subagent:${subAgentId}`,
      });

      // 环境约定与主 agent 同源（同一个函数产出），差别只在角色部分
      context.addSystemMessage(
        this.config.systemPromptOverride ??
          buildSubAgentSystemPrompt(this.config.environment),
      );

      const userContent = request.context
        ? `任务：${request.task}\n\n背景信息：\n${request.context}`
        : request.task;

      const run = await orchestrator.run([{ role: 'user', content: userContent }]);

      const stats = context.getStats();
      // max_tokens 截断也算 truncated —— 语义是「这个答案不完整」,
      // 而不是「因为步数不够」。漏掉 'truncated' 的话主 agent 会把
      // 停在半句的回答当成定论用,而那正是这个字段存在的理由
      const truncated =
        run.stopReason === 'max_steps' || run.stopReason === 'truncated';

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
      // needs 含 'agent' = 递归入口,结构上排除(不靠深度计数)
      if (tool.needs.includes('agent')) {
        skipped.push(tool.name);
        continue;
      }
      // 请求用户帮助也排除:子 agent 的输出只回给主 agent,**用户看不到它说的话**。
      // 让它调 request_help 的话,用户压根不知道要去操作浏览器,
      // 而子 agent 已经带着未完成的答案返回了 —— 打扰了用户却什么也没推进。
      // 遇到需要人介入时它应当把情况写进回答,交回主 agent 去请用户处理。
      //
      // 用工具名而非 needs 判定:request_help 的 needs 是空数组(它不碰任何执行器),
      // 没有可依赖的结构特征。这是唯一按名字排除的工具,所以显式列出
      if (NO_SUBAGENT_TOOLS.has(tool.name)) {
        skipped.push(tool.name);
        continue;
      }
      registry.register(tool);
    }

    if (skipped.length > 0) {
      this.config.logger.debug('子 agent 工具集已排除', { skipped });
    }

    return registry;
  }
}
