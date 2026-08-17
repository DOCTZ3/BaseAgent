// ============================================
// Core 层:上下文管理器
// ============================================

import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import { Logger, RetryHandler, RetryConfig, RetryableError } from '../platform/index.js';
import { TokenCounter } from './token-counter.js';
import { LLMClient, Message } from './llm-client.js';

// ============================================
// LLM 结构化输出 Schema
// ============================================
// 主题分析和摘要生成改用 response_format: json_object + Zod 校验,
// 替代原先脆弱的正则提取。校验失败抛 RetryableError,由 RetryHandler 重试;
// 重试用尽后各调用点自行降级(默认主题 / 占位摘要),不中断压缩流程。

const TopicAssignmentSchema = z.object({
  assignments: z.array(z.object({
    turn_id: z.number().int(),
    topic: z.string().min(1).max(40),
  })).min(1),
});

const TopicSummarySchema = z.object({
  summary: z.string().min(10),
  keywords: z.array(z.string().min(1)).default([]),
});

// Turn 结构（完整对话单元）
export interface Turn {
  turn_id: number;
  user_message: Message;
  // 一次迭代 = 一次 LLM 响应。模型可能并行返回多个 tool_call，必须全部记录：
  // 只存第一个会导致压缩后重建出「assistant 声明 N 个 tool_call 但只有 1 个 tool 响应」
  // 的消息序列，API 直接 400。
  assistant_iterations: Array<{
    reasoning?: string;
    tool_calls?: Array<{ id: string; name: string; args: unknown }>;
    tool_results?: Array<{ tool_call_id: string; content: string }>;
  }>;
  final_response?: Message;
  timestamp: number;
}

// 主题摘要（聚类压缩）
export interface TopicSummary {
  id: string;                 // UUID
  title: string;              // 主题名称（3-8 字）
  summary: string;            // 高密度摘要（150-200 字）
  turn_ids: number[];         // 相关的 Turn ID 列表
  keywords: string[];         // 关键词（3-5 个）
  timestamp: number;          // 最后一个 Turn 的时间
}

// 归档索引（扩展支持主题）
export interface ArchiveIndex {
  session_id: string;
  turns: Array<{
    turn: number;
    summary: string;
    tools_used: string[];
    timestamp: number;
    file: string;
    topic_id?: string;        // 关联的主题 ID
  }>;
  topics: TopicSummary[];     // 主题摘要列表
}

export interface ContextConfig {
  sessionId: string;
  windowSize: number;           // 上下文窗口大小（token）
  compressionThreshold: number; // 压缩触发阈值（占窗口比例，如 0.7）
  recentTurnsToKeep: number;    // 压缩时保留的最近轮数
  maxTopicsInContext: number;   // 上下文中最多保留的主题数量（时间滑动窗口）
  maxTokensPerToolResult: {     // 单次工具结果 token 上限
    file_read: number;
    web_content: number;
    dom_tree: number;
  };
  logger: Logger;
  retry?: Partial<RetryConfig>;  // 摘要/主题分析的重试策略
}

export class ContextManager {
  private messages: Message[] = [];
  private turns: Turn[] = [];
  private currentTurn: Partial<Turn> | null = null;
  private tokenCounter: TokenCounter;
  private archiveDir: string;
  private needsMidTurnCompression: boolean = false;  // Mid-Turn 压缩标志位
  private topicSummaries: Map<string, TopicSummary> = new Map();  // 主题摘要（id -> TopicSummary）
  private activeTurnTopics: Map<number, string> = new Map();      // Turn ID -> Topic ID 映射
  private retryHandler: RetryHandler;
  // 实际执行过的压缩次数（跳过的不计）。上层靠它判断「这一轮是否压缩了」——
  // 不能用 turns 数量反推：turns 要到下一轮开始才递增，新会话第一轮会误报。
  private compressionCount = 0;

  constructor(
    private config: ContextConfig,
    private llmClient: LLMClient
  ) {
    this.tokenCounter = new TokenCounter(config.logger);
    this.archiveDir = path.join('.claude', 'sessions', config.sessionId);
    // 重试粒度 = 单次 LLM 调用（每个主题的摘要各自重试，互不影响）
    //
    // explicitOnly：这一层只重试 JSON 解析/Schema 校验失败（RetryableError）。
    // 网络错误/限流/5xx 由 LLM Adapter 内部的 RetryHandler 负责——两层都按错误特征
    // 匹配会让真实 API 调用次数变成相乘（各 3 次重试 → 最坏 16 次），退避时长同样翻倍。
    this.retryHandler = new RetryHandler(
      { ...(config.retry ?? {}), explicitOnly: true },
      config.logger
    );
  }

  /**
   * 初始化（创建归档目录）
   */
  async initialize() {
    await fs.mkdir(this.archiveDir, { recursive: true });
    this.config.logger.debug('Context 管理器初始化', { archiveDir: this.archiveDir });
  }

  /**
   * 添加系统消息
   */
  addSystemMessage(content: string) {
    this.messages.push({ role: 'system', content });
  }

  /**
   * 添加用户消息（开启新 Turn）
   */
  async addUserMessage(content: string) {
    // 完成上一个 Turn
    if (this.currentTurn?.user_message) {
      this.finalizeTurn();

      // Turn 边界检查：根据阈值选择策略
      const threshold = this.config.compressionThreshold;
      let shouldCompress = false;

      if (threshold <= 0.7) {
        // 保守阈值（≤70%）：直接判断已有 token（留有足够余地）
        shouldCompress = this.tokenCounter.shouldCompress(
          this.config.windowSize,
          threshold
        );
      } else {
        // 激进阈值（>70%）：预估新消息 token 后再判断
        const currentTokens = this.tokenCounter.getStats().total_prompt;
        const newTokens = this.tokenCounter.estimate(content);
        shouldCompress = (currentTokens + newTokens) >=
          this.config.windowSize * threshold;
      }

      if (shouldCompress) {
        this.config.logger.info('触发上下文压缩（Turn 边界）', {
          threshold: `${this.config.compressionThreshold * 100}%`,
          current_tokens: this.tokenCounter.getStats().total_prompt,
          turns: this.turns.length
        });
        await this.compress();
      }
    }

    // 开启新 Turn
    const userMsg: Message = { role: 'user', content };
    this.messages.push(userMsg);

    this.currentTurn = {
      turn_id: this.turns.length + 1,
      user_message: userMsg,
      assistant_iterations: [],
      timestamp: Date.now()
    };
  }

  /**
   * 添加 Assistant 消息（推理 + 工具调用）
   */
  addAssistantMessage(content: string, toolCalls?: Array<{ id: string; name: string; args: unknown }>, reasoning?: string) {
    const msg: Message = {
      role: 'assistant',
      content,
      toolCalls: toolCalls?.map(tc => ({
        id: tc.id,
        name: tc.name,
        args: tc.args as Record<string, unknown>
      })),
      reasoning
    };
    this.messages.push(msg);

    // 记录到当前 Turn（并行 tool_call 全部保留）
    if (this.currentTurn) {
      this.currentTurn.assistant_iterations!.push({
        reasoning,
        tool_calls: toolCalls && toolCalls.length > 0 ? [...toolCalls] : undefined
      });
    }
  }

  /**
   * 添加工具结果
   */
  addToolResult(toolCallId: string, content: string) {
    const msg: Message = {
      role: 'tool',
      toolCallId,
      content
    };
    this.messages.push(msg);

    // 追加到当前 Turn 最后一次迭代的结果列表
    // （一次迭代有 N 个 tool_call 就会有 N 次 addToolResult，逐个 append）
    if (this.currentTurn && this.currentTurn.assistant_iterations!.length > 0) {
      const lastIter = this.currentTurn.assistant_iterations![this.currentTurn.assistant_iterations!.length - 1];
      if (!lastIter.tool_results) {
        lastIter.tool_results = [];
      }
      lastIter.tool_results.push({ tool_call_id: toolCallId, content });
    }
  }

  /**
   * 记录本轮最终回复（模型无工具调用、直接给出答案时）
   *
   * 必须调用：Turn.final_response 是压缩后重建「保留轮次」的唯一答案来源。
   * 不记录会导致模型看不到自己之前的回答（flattenTurns 只能重放 user 消息和工具往返）。
   */
  addFinalResponse(content: string, reasoning?: string) {
    const msg: Message = { role: 'assistant', content, reasoning };
    this.messages.push(msg);

    if (this.currentTurn) {
      this.currentTurn.final_response = msg;
    }
  }

  /**
   * 完成当前 Turn
   */
  private finalizeTurn() {
    if (!this.currentTurn || !this.currentTurn.user_message) {
      return;
    }

    // 检查是否有 assistant 响应：工具迭代或最终回复，有其一即算完整
    // （模型直接回答的轮次没有 iterations，只有 final_response，不能当不完整丢掉）
    const hasIterations = (this.currentTurn.assistant_iterations?.length ?? 0) > 0;
    if (!hasIterations && !this.currentTurn.final_response) {
      this.config.logger.warn('Turn 不完整：没有 assistant 响应', { turn_id: this.currentTurn.turn_id });
      return;
    }

    // 直接回答的轮次没有 iterations，补空数组以满足 Turn 结构
    if (!this.currentTurn.assistant_iterations) {
      this.currentTurn.assistant_iterations = [];
    }

    this.turns.push(this.currentTurn as Turn);
    this.config.logger.debug('Turn 已完成', {
      turn_id: this.currentTurn.turn_id,
      iterations: this.currentTurn.assistant_iterations.length,
      has_final_response: !!this.currentTurn.final_response
    });
    this.currentTurn = null;
  }

  /**
   * 只读快照当前消息列表（观测用，不触发压缩）
   *
   * 与 preparePrompt() 的区别：后者会检查并执行 Mid-Turn 压缩。
   * CLI 的 /context 命令必须用这个，否则「看一眼上下文」会改变上下文。
   */
  peekMessages(): readonly Message[] {
    return this.messages;
  }

  /**
   * 准备 Prompt（检查 Mid-Turn 压缩）
   */
  async preparePrompt(): Promise<Message[]> {
    // 检查是否需要 Mid-Turn 压缩
    if (this.needsMidTurnCompression) {
      this.config.logger.warn('触发上下文压缩（Mid-Turn）', {
        current_tokens: this.tokenCounter.getStats().total_prompt,
        within_turn: true,
        current_turn_id: this.currentTurn?.turn_id
      });

      await this.compressMidTurn();
      this.needsMidTurnCompression = false;
    }

    return this.messages;
  }

  /**
   * 压缩上下文（Turn 级别）
   */
  private async compress() {
    // 完成当前 Turn
    this.finalizeTurn();

    if (this.turns.length <= this.config.recentTurnsToKeep) {
      this.config.logger.warn('Turn 数不足，跳过压缩', { turns: this.turns.length });
      return;
    }

    // 分离最近和早期 Turn
    const recentTurns = this.turns.slice(-this.config.recentTurnsToKeep);
    const oldTurns = this.turns.slice(0, -this.config.recentTurnsToKeep);

    this.config.logger.info('开始压缩', {
      total_turns: this.turns.length,
      to_archive: oldTurns.length,
      to_keep: recentTurns.length
    });

    // 归档早期 Turn
    await this.archiveTurns(oldTurns);

    // 主题聚类压缩
    await this.compressWithTopicClustering(oldTurns);

    // 重建消息列表
    const initialSystemMessage = this.messages.find(m => m.role === 'system');
    const recentMessages = this.flattenTurns(recentTurns);

    // 生成上下文消息
    const contextMessages = this.buildContextMessages(initialSystemMessage, oldTurns.length);

    this.messages = [
      ...contextMessages,
      ...recentMessages
    ];

    // 更新 Turn 列表
    this.turns = recentTurns;

    this.compressionCount++;

    this.config.logger.info('压缩完成', {
      archived: oldTurns.length,
      messages_after: this.messages.length,
      topics_count: this.topicSummaries.size
    });

    // 验证消息结构
    this.validateMessageStructure();
  }

  /**
   * 主题聚类压缩
   */
  private async compressWithTopicClustering(oldTurns: Turn[]) {
    // 按主题聚类
    const topicGroups = await this.clusterTurnsByTopic(oldTurns);

    // 为每个主题生成摘要
    for (const [topicTitle, turns] of topicGroups.entries()) {
      const topicSummary = await this.generateTopicSummary(topicTitle, turns);

      // 保存主题摘要
      this.topicSummaries.set(topicSummary.id, topicSummary);

      // 建立 Turn -> Topic 映射
      for (const turn of turns) {
        this.activeTurnTopics.set(turn.turn_id, topicSummary.id);
      }

      this.config.logger.debug('主题摘要生成', {
        topic: topicTitle,
        turns: turns.length
      });
    }

    // 清理超过数量限制的旧主题（按时间滑动窗口）
    this.pruneTopics();

    this.config.logger.debug('主题聚类压缩完成', {
      topics_total: this.topicSummaries.size,
      topic_titles: Array.from(this.topicSummaries.values()).map(t => t.title)
    });
  }

  /**
   * 清理超过数量限制的旧主题（按时间滑动窗口）
   */
  private pruneTopics() {
    const maxTopics = this.config.maxTopicsInContext || 10;

    if (this.topicSummaries.size <= maxTopics) {
      return;
    }

    // 按时间排序（保留最新的）
    const sortedTopics = Array.from(this.topicSummaries.values())
      .sort((a, b) => b.timestamp - a.timestamp);

    // 保留最新的 N 个主题，移除旧的
    const topicsToRemove = sortedTopics.slice(maxTopics);

    for (const topic of topicsToRemove) {
      this.topicSummaries.delete(topic.id);

      // 清理 Turn 映射
      for (const turnId of topic.turn_ids) {
        this.activeTurnTopics.delete(turnId);
      }
    }

    if (topicsToRemove.length > 0) {
      this.config.logger.info('清理旧主题', {
        removed: topicsToRemove.length,
        topics: topicsToRemove.map(t => t.title)
      });
    }
  }

  /**
   * 构建上下文消息（system 消息）
   */
  private buildContextMessages(initialSystemMessage: Message | undefined, archivedCount: number): Message[] {
    const messages: Message[] = [];

    // 初始 system 消息
    if (initialSystemMessage) {
      messages.push(initialSystemMessage);
    }

    // 主题摘要（按时间排序）
    if (this.topicSummaries.size > 0) {
      // 按时间排序（最新的在前）
      const sortedTopics = Array.from(this.topicSummaries.values())
        .sort((a, b) => b.timestamp - a.timestamp);

      const topicsText = sortedTopics.map(topic => {
        const keywordsText = topic.keywords.length > 0 ? `\n关键词: ${topic.keywords.join(', ')}` : '';
        return `## ${topic.title}\n${topic.summary}${keywordsText}`;
      }).join('\n\n---\n\n');

      messages.push({
        role: 'system',
        content: `[历史对话主题摘要 - 共 ${sortedTopics.length} 个主题]\n\n${topicsText}`
      });
    }

    // 归档提示
    messages.push({
      role: 'system',
      content: `[早期的 ${archivedCount} 轮对话已归档到 ${this.archiveDir}/
索引文件：${path.join(this.archiveDir, 'index.json')}
详细内容：${path.join(this.archiveDir, 'turn-XXX.json')}
需要回顾早期对话时，可用 read_file 工具查看]`
    });

    return messages;
  }

  /**
   * Mid-Turn 压缩（当前 Turn 未完成时触发）
   */
  private async compressMidTurn() {
    // 只压缩已完成的 Turn
    if (this.turns.length === 0) {
      this.config.logger.warn('没有可压缩的 Turn（当前 Turn 未完成）', {
        current_turn_id: this.currentTurn?.turn_id
      });
      return;
    }

    // 保存当前 Turn 的消息
    const currentTurnMessages = this.getCurrentTurnMessages();

    this.config.logger.debug('保存当前 Turn 消息', {
      turn_id: this.currentTurn?.turn_id,
      messages_count: currentTurnMessages.length
    });

    // Bug 修复：直接压缩已完成的 Turn，不调用 compress()（它会 finalizeTurn）
    if (this.turns.length <= this.config.recentTurnsToKeep) {
      this.config.logger.warn('Turn 数不足，跳过 Mid-Turn 压缩', { turns: this.turns.length });
      return;
    }

    // 分离最近和早期 Turn
    const recentTurns = this.turns.slice(-this.config.recentTurnsToKeep);
    const oldTurns = this.turns.slice(0, -this.config.recentTurnsToKeep);

    this.config.logger.info('开始 Mid-Turn 压缩', {
      total_turns: this.turns.length,
      to_archive: oldTurns.length,
      to_keep: recentTurns.length
    });

    // 归档早期 Turn
    await this.archiveTurns(oldTurns);

    // 主题聚类压缩
    await this.compressWithTopicClustering(oldTurns);

    // 重建消息列表（不包含当前 Turn）
    const initialSystemMessage = this.messages.find(m => m.role === 'system');
    const recentMessages = this.flattenTurns(recentTurns);

    // 生成上下文消息
    const contextMessages = this.buildContextMessages(initialSystemMessage, oldTurns.length);

    this.messages = [
      ...contextMessages,
      ...recentMessages
    ];

    // 更新 Turn 列表
    this.turns = recentTurns;

    // 恢复当前 Turn 的消息
    this.messages.push(...currentTurnMessages);

    this.compressionCount++;

    this.config.logger.debug('恢复当前 Turn 消息', {
      total_messages: this.messages.length
    });

    this.validateMessageStructure();
  }

  /**
   * 提取当前 Turn 的消息（用于 Mid-Turn 压缩）
   */
  private getCurrentTurnMessages(): Message[] {
    if (!this.currentTurn) return [];

    const messages: Message[] = [];

    // 添加 user 消息
    if (this.currentTurn.user_message) {
      messages.push(this.currentTurn.user_message);
    }

    // 添加已完成的 assistant iterations
    if (this.currentTurn.assistant_iterations) {
      for (const iter of this.currentTurn.assistant_iterations) {
        // assistant 消息：并行 tool_call 必须全部带上，
        // 否则重建出的序列会「声明 N 个但只回 1 个」，API 直接 400
        if (iter.tool_calls && iter.tool_calls.length > 0) {
          messages.push({
            role: 'assistant',
            content: '',
            toolCalls: iter.tool_calls.map(tc => ({
              id: tc.id,
              name: tc.name,
              args: tc.args as Record<string, unknown>
            })),
            reasoning: iter.reasoning
          });
        }

        // 每个 tool_call 对应一条 tool 消息
        for (const result of iter.tool_results ?? []) {
          messages.push({
            role: 'tool',
            toolCallId: result.tool_call_id,
            content: result.content
          });
        }
      }
    }

    // 已给出最终回复但尚未 finalize 的轮次，回复也要一起搬回去
    if (this.currentTurn.final_response) {
      messages.push(this.currentTurn.final_response);
    }

    return messages;
  }

  /**
   * 归档 Turn 到文件系统
   */
  private async archiveTurns(turns: Turn[]) {
    const index: ArchiveIndex = {
      session_id: this.config.sessionId,
      turns: [],
      topics: Array.from(this.topicSummaries.values())
    };

    for (const turn of turns) {
      const filename = `turn-${String(turn.turn_id).padStart(3, '0')}.json`;
      const filepath = path.join(this.archiveDir, filename);

      // 写入完整 Turn
      await fs.writeFile(filepath, JSON.stringify(turn, null, 2));

      // 更新索引（一次迭代可能并行调多个工具，全部计入）
      const toolsUsed = turn.assistant_iterations
        .flatMap(iter => (iter.tool_calls ?? []).map(tc => tc.name))
        .filter(Boolean) as string[];

      // 查找 Turn 关联的主题
      const topicId = this.activeTurnTopics.get(turn.turn_id);

      index.turns.push({
        turn: turn.turn_id,
        summary: this.extractTurnSummary(turn),
        tools_used: [...new Set(toolsUsed)],  // 去重
        timestamp: turn.timestamp,
        file: filename,
        topic_id: topicId  // 关联主题 ID
      });
    }

    // 写入索引文件
    await fs.writeFile(
      path.join(this.archiveDir, 'index.json'),
      JSON.stringify(index, null, 2)
    );

    this.config.logger.debug('归档完成', {
      turns: turns.length,
      topics: index.topics?.length || 0
    });
  }

  /**
   * 提取 Turn 摘要
   */
  private extractTurnSummary(turn: Turn): string {
    const userContent = turn.user_message.content || '';
    const summary = userContent.length > 100
      ? userContent.substring(0, 100) + '...'
      : userContent;
    return summary;
  }

  /**
   * 生成 UUID（简化版）
   */
  private generateUUID(): string {
    return 'topic-' + Date.now() + '-' + Math.random().toString(36).substring(2, 9);
  }

  /**
   * 单次 LLM 调用 + JSON 解析 + Schema 校验（带重试）
   *
   * 重试粒度是「一次调用」：主题分析、每个主题的摘要各自独立重试，互不影响。
   * 解析/校验失败抛 RetryableError → RetryHandler 重新生成一次。
   * 重试用尽后向上抛出，由调用点自行降级（默认主题 / 占位摘要）。
   *
   * 注意这一层是 explicitOnly：只重试解析/校验失败。网络类错误在
   * llmClient.complete() 内部已经重试过，到这里直接放行给调用点降级。
   */
  private async completeJSON<T>(
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    systemPrompt: string,
    userContent: string,
    operationName: string,
    maxTokens: number,
    traceLabel: string
  ): Promise<T> {
    return this.retryHandler.execute(async () => {
      const response = await this.llmClient.complete({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent }
        ],
        temperature: 0.3,
        maxTokens,
        responseFormat: 'json_object',
        traceLabel
      });

      const raw = response.content?.trim();
      if (!raw) {
        throw new RetryableError(`${operationName}:模型返回空内容`);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new RetryableError(`${operationName}:JSON 解析失败`);
      }

      const validated = schema.safeParse(parsed);
      if (!validated.success) {
        const detail = validated.error.issues
          .map(i => `${i.path.join('.')} ${i.message}`)
          .join('; ');
        throw new RetryableError(`${operationName}:Schema 校验失败 - ${detail}`);
      }

      return validated.data;
    }, operationName);
  }

  /**
   * 主题聚类：将 Turn 列表按意图分组
   */
  private async clusterTurnsByTopic(turns: Turn[]): Promise<Map<string, Turn[]>> {
    if (turns.length === 0) return new Map();

    // 使用 LLM 分析每个 Turn 的主题
    const turnsWithTopics = await this.analyzeTurnTopics(turns);

    // 按主题分组
    const topicGroups = new Map<string, Turn[]>();

    for (const { turn, topicTitle } of turnsWithTopics) {
      if (!topicGroups.has(topicTitle)) {
        topicGroups.set(topicTitle, []);
      }
      topicGroups.get(topicTitle)!.push(turn);
    }

    this.config.logger.debug('主题聚类完成', {
      total_turns: turns.length,
      topics_count: topicGroups.size,
      topics: Array.from(topicGroups.keys())
    });

    return topicGroups;
  }

  /**
   * 分析每个 Turn 的主题（批量调用 LLM）
   */
  private async analyzeTurnTopics(turns: Turn[]): Promise<Array<{ turn: Turn; topicTitle: string }>> {
    const turnsText = turns.map(t => {
      const tools = t.assistant_iterations
        .flatMap(iter => (iter.tool_calls ?? []).map(tc => tc.name))
        .join(', ');
      return `[Turn ${t.turn_id}] 用户: ${t.user_message.content}\n工具: ${tools || '无'}`;
    }).join('\n\n');

    const systemPrompt = `你是一个对话分析助手。请为每个 Turn 分配一个主题标签（3-8 字）。
相同意图的 Turn 必须使用完全相同的主题标签。

只返回 JSON，格式如下：
{
  "assignments": [
    { "turn_id": 1, "topic": "文件统计" },
    { "turn_id": 2, "topic": "文件统计" },
    { "turn_id": 3, "topic": "时间查询" }
  ]
}

要求：
- 每个输入的 Turn 都要出现在 assignments 中
- turn_id 必须是数字，与输入一致
- topic 为简短中文标签，不要加引号或标点`;

    try {
      const data = await this.completeJSON(
        TopicAssignmentSchema,
        systemPrompt,
        turnsText,
        '主题分析',
        1000,
        'compression:topic-analysis'
      );

      // 按 turn_id 映射回 Turn 对象（模型可能返回不存在的 id，需过滤）
      const result: Array<{ turn: Turn; topicTitle: string }> = [];
      for (const { turn_id, topic } of data.assignments) {
        const turn = turns.find(t => t.turn_id === turn_id);
        if (turn) {
          result.push({ turn, topicTitle: topic.trim() });
        }
      }

      // 补齐模型漏掉的 Turn，避免丢失对话
      const assigned = new Set(result.map(r => r.turn.turn_id));
      const missing = turns.filter(t => !assigned.has(t.turn_id));
      if (missing.length > 0) {
        this.config.logger.warn('主题分析遗漏 Turn，归入默认主题', {
          missing: missing.map(t => t.turn_id)
        });
        for (const turn of missing) {
          result.push({ turn, topicTitle: '对话记录' });
        }
      }

      return result;
    } catch (error) {
      // 重试用尽 → 降级：所有 Turn 归为一个主题，压缩流程继续
      this.config.logger.error('主题分析失败，使用默认主题', {
        error: error instanceof Error ? error.message : String(error)
      });
      return turns.map(turn => ({ turn, topicTitle: '对话记录' }));
    }
  }

  /**
   * 为一组 Turn 生成主题摘要
   */
  private async generateTopicSummary(topicTitle: string, turns: Turn[]): Promise<TopicSummary> {
    const turnsText = turns.map(t => {
      const tools = t.assistant_iterations
        .flatMap(iter => (iter.tool_calls ?? []).map(tc => tc.name))
        .join(', ');
      return `Turn ${t.turn_id}: ${t.user_message.content} [工具: ${tools || '无'}]`;
    }).join('\n');

    const systemPrompt = `你是一个摘要助手。请为主题"${topicTitle}"的对话生成摘要。

只返回 JSON，格式如下：
{
  "summary": "150-200 字的高密度摘要，保留关键信息和决策",
  "keywords": ["关键词1", "关键词2", "关键词3"]
}

要求：
- summary 为完整句子，包含主要结论，不要分点
- keywords 为 3-5 个关键词组成的数组
- 不要输出 JSON 以外的任何内容`;

    try {
      const data = await this.completeJSON(
        TopicSummarySchema,
        systemPrompt,
        turnsText,
        `主题"${topicTitle}"摘要生成`,
        600,
        `compression:topic-summary:${topicTitle}`
      );

      return {
        id: this.generateUUID(),
        title: topicTitle,
        summary: data.summary.trim(),
        turn_ids: turns.map(t => t.turn_id),
        keywords: data.keywords.map(k => k.trim()).filter(k => k),
        timestamp: Math.max(...turns.map(t => t.timestamp))
      };
    } catch (error) {
      // 重试用尽 → 回落占位摘要，不中断压缩（丢一个主题的摘要，但流程继续）
      this.config.logger.error('主题摘要生成失败，使用占位摘要', {
        topic: topicTitle,
        error: error instanceof Error ? error.message : String(error)
      });
      return {
        id: this.generateUUID(),
        title: topicTitle,
        summary: `(主题"${topicTitle}"包含 ${turns.length} 轮对话，摘要生成失败)`,
        turn_ids: turns.map(t => t.turn_id),
        keywords: [],
        timestamp: Math.max(...turns.map(t => t.timestamp))
      };
    }
  }

  /**
   * 将 Turn 列表展开为消息列表
   */
  private flattenTurns(turns: Turn[]): Message[] {
    const messages: Message[] = [];

    for (const turn of turns) {
      messages.push(turn.user_message);

      for (const iter of turn.assistant_iterations) {
        // 并行 tool_call 全部重建（漏一个就是 assistant 声明 N 个、tool 只回 M 个 → 400）
        if (iter.tool_calls && iter.tool_calls.length > 0) {
          messages.push({
            role: 'assistant',
            content: '',
            toolCalls: iter.tool_calls.map(tc => ({
              id: tc.id,
              name: tc.name,
              args: tc.args as Record<string, unknown>
            })),
            reasoning: iter.reasoning
          });
        }
        for (const result of iter.tool_results ?? []) {
          messages.push({
            role: 'tool',
            content: result.content,
            toolCallId: result.tool_call_id
          });
        }
      }

      if (turn.final_response) {
        messages.push(turn.final_response);
      }
    }

    return messages;
  }

  /**
   * 记录 Token 使用量（从 API 返回）
   */
  recordTokenUsage(usage: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_cache_hit_tokens?: number;
  }) {
    this.tokenCounter.recordUsage(usage);

    // Mid-Turn 检查：每次 LLM 调用后实时检查
    if (this.tokenCounter.shouldCompress(
      this.config.windowSize,
      this.config.compressionThreshold
    )) {
      this.needsMidTurnCompression = true;
      this.config.logger.debug('Mid-Turn 压缩标志位已设置', {
        current_tokens: this.tokenCounter.getStats().total_prompt,
        threshold: `${this.config.compressionThreshold * 100}%`
      });
    }
  }

  /**
   * 验证消息结构（调试用）
   */
  private validateMessageStructure() {
    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i];
      if (msg.role !== 'assistant' || !msg.toolCalls || msg.toolCalls.length === 0) {
        continue;
      }

      // 逐个核对 tool_call_id：每个都必须有对应的 tool 响应。
      // 只看「下一条是不是 tool」不够——并行调 N 个工具但只回 1 条时，
      // 下一条确实是 tool，API 仍然会 400（曾经就漏过这个）。
      const expected = msg.toolCalls.map(tc => tc.id);
      const responded = new Set<string>();
      for (let j = i + 1; j < this.messages.length; j++) {
        const next = this.messages[j];
        if (next.role !== 'tool') break;
        responded.add(next.toolCallId);
      }

      const missing = expected.filter(id => !responded.has(id));
      if (missing.length > 0) {
        this.config.logger.error('消息结构错误：tool_call 缺少对应的 tool 响应', {
          index: i,
          expected_count: expected.length,
          responded_count: responded.size,
          missing_tool_call_ids: missing
        });
      }
    }
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      turns: this.turns.length,
      messages: this.messages.length,
      // 实际执行过的压缩次数（跳过的不计），供上层判断某一轮是否发生压缩
      compressions: this.compressionCount,
      topics: this.topicSummaries.size,
      tokens: this.tokenCounter.getStats()
    };
  }

  /**
   * 清理资源
   */
  dispose() {
    this.tokenCounter.dispose();
  }
}
