// ============================================
// Core 层:主循环 Orchestrator(集成 Context 管理)
// ============================================

import { LLMClient, Message, LLMDelta } from './llm-client.js';
import { ToolRunner, ToolRegistry } from '../tools/index.js';
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
  /**
   * 过程事件回调 —— 客户端/CLI 用它做实时展示
   *
   * 只在**主循环**上给流式:压缩、摘要、记忆抽取那些单发调用的产物是
   * 给机器解析的 JSON,吐给用户没有意义(见 llm-client.ts 的 onDelta 注释)。
   *
   * 子 agent **不转发**这个回调:它的推理过程用户看不到,
   * 混进主流会让用户分不清哪句是谁说的 —— 与 request_help 不下放同一个理由。
   */
  onEvent?: AgentEventSink;
}

/**
 * 主循环的过程事件
 *
 * 为什么不只做 token 流:用户等的十几秒里,信息量最大的不是逐字吐字,
 * 而是「它在干什么」。Orchestrator 本来就知道每一步(第几步、调了哪个工具),
 * 把这些一起推出去,展示层才能给出「正在执行代码…」这种有用的反馈。
 */
export type AgentEvent =
  /** 正文增量 */
  | { type: 'content'; text: string }
  /** 推理增量(思维链)。展示层通常折叠 */
  | { type: 'reasoning'; text: string }
  /** 重试导致的重来 —— 丢弃本步此前收到的所有增量 */
  | { type: 'reset' }
  /** 新的一步开始 */
  | { type: 'step'; step: number; maxSteps: number }
  /** 模型请求调用工具(参数已完整) */
  | { type: 'tool_start'; id: string; name: string; args: Record<string, unknown> }
  /** 工具执行完毕。result 是给人看的摘要,不是完整返回 */
  | { type: 'tool_end'; id: string; name: string; ok: boolean; summary: string }
  /** 本轮结束 */
  | { type: 'done'; stopReason: AgentRunResult['stopReason']; steps: number };

export type AgentEventSink = (event: AgentEvent) => void;

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
   * truncated   生成被 max_tokens 截断，回答停在半句
   *
   * truncated 必须与 complete 分开:被截断的回答**看起来**是正常回答
   * (有内容、无工具调用),混在一起的话用户只会看到「话说到一半就没了」,
   * 而没有任何东西指向 max_tokens。它也必须与 no_response 分开 ——
   * 开着思维链且预算给小时,预算会被思维链吃光、content 为空,
   * 那时报「模型无有效响应」是错的归因:模型响应了,是我们没给它说完的余量。
   */
  stopReason: 'complete' | 'max_steps' | 'no_response' | 'truncated';
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

/** 工具结果摘要的长度上限。展示层要的是「成了没有」,完整数据在 trace 里 */
const TOOL_SUMMARY_CLIP = 200;

/**
 * 把工具返回压成一行摘要
 *
 * 不用 JSON.stringify 直接截断:代码执行的结果是 `{stdout, duration_ms}`,
 * 截断后用户看到的是 `{"stdout":"第1条: 星宇股份被曝批量劝` 这种半截转义 ——
 * 引号和 \n 会占掉本就不多的字数。取 stdout 这类主字段更有用。
 */
function summarizeToolData(data: unknown): string {
  if (data === undefined || data === null) return '完成';
  if (typeof data === 'string') return clip(data);

  if (typeof data === 'object') {
    const o = data as Record<string, unknown>;
    // 按「人最想看的」排序取第一个命中的字段
    for (const key of ['stdout', 'content', 'text', 'summary', 'observation']) {
      const v = o[key];
      if (typeof v === 'string' && v.trim()) return clip(v);
    }
    // 列表类结果报个数就够(search_files / list_files)
    for (const key of ['files', 'matches', 'items', 'results']) {
      const v = o[key];
      if (Array.isArray(v)) return `${v.length} 项`;
    }
  }

  return clip(JSON.stringify(data));
}

function clip(s: string): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > TOOL_SUMMARY_CLIP
    ? oneLine.slice(0, TOOL_SUMMARY_CLIP) + '…'
    : oneLine;
}

export class Orchestrator {
  constructor(
    private llmClient: LLMClient,
    private toolRunner: ToolRunner,
    private toolRegistry: ToolRegistry,
    private config: OrchestratorConfig,
  ) {}

  /**
   * 本轮的事件接收方 —— 由 run() 的参数覆盖 config.onEvent
   *
   * 为什么不只靠 config:Orchestrator 是**会话级**的(只建一次),而「这一轮
   * 要不要流式」是**每轮**的事(壳这轮在等着看,记忆抽取那次没人看)。
   * 若在构造时固定塞一个常驻转发函数,`deltaSink()` 里那个
   * 「没人听就不付流式成本」的判断就永久为真了。
   *
   * 代价:同一个实例不可并发跑两轮(后者会覆盖前者的 sink)。
   * 现有调用方都是串行的(CLI 排队、子 agent 各自新建实例),
   * 真要并发就该各建一个实例 —— 它本来也没有跨轮状态。
   */
  private sink?: AgentEventSink;

  /**
   * 发事件 —— 展示层的失败绝不能影响主循环
   *
   * 回调是外部给的(SSE 写盘、IPC 发送、终端打印),它抛异常不该让
   * 这一轮任务失败:那等于「因为界面卡了所以活没干成」。
   * 与工具错误一律包成 ToolResult 同一个原则 —— 边缘的失败不炸主循环。
   */
  private emit(event: AgentEvent): void {
    const sink = this.sink ?? this.config.onEvent;
    if (!sink) return;
    try {
      sink(event);
    } catch (e) {
      this.config.logger.warn('事件回调抛错,已忽略', {
        type: event.type,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * 把 LLM 分片转成主循环事件
   *
   * 返回 undefined 时 adapter 走非流式路径 —— 这是「没人听就不付流式成本」
   * 的开关所在(流式要多一层分片累积,usage 还得靠 stream_options 额外索要)。
   */
  private deltaSink(): ((delta: LLMDelta) => void) | undefined {
    if (!this.sink && !this.config.onEvent) return undefined;

    return (delta: LLMDelta) => {
      // reset 优先:它的语义是「丢掉此前所有增量」,和内容互斥
      if (delta.reset) {
        this.emit({ type: 'reset' });
        return;
      }
      if (delta.reasoning) this.emit({ type: 'reasoning', text: delta.reasoning });
      if (delta.content) this.emit({ type: 'content', text: delta.content });
    };
  }

  /**
   * 收口 —— 每条退出路径都从这里出去
   *
   * 四个 return 点各写一次 emit 迟早漏掉一个,而漏掉不报错:
   * 展示层只是永远等不到结束信号(光标一直转)。收在一处后,
   * 「有返回值就一定发过 done」由类型系统保证。
   */
  private finish(result: AgentRunResult): AgentRunResult {
    this.emit({ type: 'done', stopReason: result.stopReason, steps: result.steps });
    return result;
  }

  async run(
    initialMessages: Message[],
    onEvent?: AgentEventSink,
  ): Promise<AgentRunResult> {
    // 逐轮覆盖。finally 里清掉:留着会让下一轮(可能是没人听的那种)白付流式成本
    this.sink = onEvent;
    try {
      return await this.loop(initialMessages);
    } finally {
      this.sink = undefined;
    }
  }

  private async loop(initialMessages: Message[]): Promise<AgentRunResult> {
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
      this.emit({ type: 'step', step, maxSteps: this.config.maxSteps });

      // 准备 Prompt（触发压缩检查）
      const currentMessages = context ? await context.preparePrompt() : messages;

      // 调用 LLM
      const response = await this.llmClient.complete({
        messages: currentMessages,
        tools: this.toolRegistry.getAllDescriptions(),
        traceLabel: `${this.config.traceLabelPrefix ?? 'main-loop'}:step-${step}`,
        // 没有 onEvent 就不传 onDelta —— adapter 据此走非流式路径。
        // 不做成「总是流式、只是没人听」:流式多一层分片累积,
        // 而且 usage 要靠 stream_options 额外索要,没必要为不展示的调用付这些
        onDelta: this.deltaSink(),
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
          this.emit({
            type: 'tool_start',
            id: toolCall.id,
            name: toolCall.name,
            args: toolCall.args,
          });

          const result = await this.toolRunner.run({
            id: toolCall.id,
            name: toolCall.name,
            args: toolCall.args,
          });

          // 摘要而不是完整结果:工具返回动辄几千字(代码 stdout、文件内容),
          // 展示层要的是「成了没有」。完整数据在 trace 里
          this.emit({
            type: 'tool_end',
            id: toolCall.id,
            name: toolCall.name,
            ok: result.ok,
            summary: result.ok
              ? summarizeToolData(result.data)
              : String(result.error ?? '失败').slice(0, TOOL_SUMMARY_CLIP),
          });

          // 只挂在最后一个工具结果上，避免同一提示重复 N 遍
          const isLastResult = i === response.toolCalls.length - 1;
          const payload = (isLastStep && isLastResult)
            ? { ...result, _system_note: buildWrapUpNote(this.config.maxSteps) }
            : result;

          // 工具结果直接序列化进 tool 消息。
          //
          // 这里曾有一段「把图片从结果里剥出来、攒到全部 tool 响应写完后
          // 注入成 user 消息」的逻辑 —— 视觉改成插件后没有工具再产出图片了
          // (观察是文字,不受「tool content 只接受字符串」的限制),故删除。
          // 要重新支持多模态主模型时,从 git 历史取回比留着死代码清楚
          const resultContent = JSON.stringify(payload);
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

      // 生成被 max_tokens 截断。
      //
      // 这个字段原先**没人看** —— 被截断的回答有内容、无工具调用,
      // 与正常回答完全同形,于是走 complete 通道返回,用户只看到
      // 「话说到一半就没了」,而没有任何东西指向 max_tokens。
      // 实测触发条件很容易达到:把单次生成上限调到 256 且开着思维链,
      // 预算会先被思维链吃掉,正文一个字都出不来
      const cut = response.finishReason === 'length';

      // 无工具调用 + 有内容 → 任务完成
      if (response.content) {
        if (cut) {
          this.config.logger.warn('回答被 max_tokens 截断', {
            steps: step,
            completion_tokens: response.usage?.completion_tokens,
          });
        } else {
          this.config.logger.info('任务完成', { steps: step });
        }

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

        // 半截回答仍然**原样返回** —— 它是模型真实产出的一部分,
        // 丢掉等于让用户白等一轮。区别只在 stopReason 上,由展示层说明原因
        return this.finish({
          answer: response.content,
          stopReason: cut ? 'truncated' : 'complete',
          steps: step,
        });
      }

      // 无工具调用 + 无内容 + 被截断 → 预算被思维链吃光,正文没轮到
      //
      // 必须与下面的 no_response 分开:那句「模型无有效响应」在这里是**错的归因**。
      // 模型响应了,是我们没给它说完的余量 —— 而这两种情况的处置完全相反
      // (一个该查模型/提示,一个该调大 max_tokens 或关掉思维链)
      if (cut) {
        this.config.logger.warn('生成预算耗尽,正文为空', {
          steps: step,
          completion_tokens: response.usage?.completion_tokens,
          // 扁平字段:嵌套的 completion_tokens_details 由 adapter 吸收掉了
          reasoning_tokens: response.usage?.reasoning_tokens,
        });
        return this.finish({
          answer: '任务未完成:生成预算(max_tokens)已耗尽,正文未能输出。'
            + '请调大「单次生成上限」,或关闭「输出思考过程」。',
          stopReason: 'truncated',
          steps: step,
        });
      }

      // 无工具调用 + 无内容 → 模型无有效响应
      // 用 stopReason 表达，不再把这句写死的话混进正常回答通道
      this.config.logger.warn('模型未返回内容且无工具调用');
      return this.finish({
        answer: '任务未完成:模型无有效响应',
        stopReason: 'no_response',
        steps: step,
      });
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
        return this.finish({
          answer: `任务因达到步数上限（${this.config.maxSteps} 步）中止，且未能生成结论。`,
          stopReason: 'max_steps',
          steps: step,
        });
      }

      if (context) {
        context.addFinalResponse(response.content, response.reasoning ?? undefined);
      }

      this.config.logger.info('收尾完成', { steps: step });
      return this.finish({ answer: response.content, stopReason: 'max_steps', steps: step });

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
