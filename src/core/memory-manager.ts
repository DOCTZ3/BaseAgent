// ============================================
// Core 层:长期记忆的抽取驱动
// ============================================
//
// 纯逻辑(合并/淘汰/渲染/过滤)在 memory.ts,那部分不依赖 LLM、可独立测试。
// 这里只管**什么时候抽、给它看哪一段、结果怎么落盘**。
//
// 触发就是**每 N 轮抽一次**(默认 3),没有别的条件。
//
// 原先叠了一层「token 增量」,实测是错的:那个量取的是模型**输出**的增量,
// 而用户在横幅上看到的是上下文水位(total_prompt)。同一次会话里
// 输出累计 3656、水位涨到 11966,差三倍多 —— 于是「聊了 11k 还没触发」。
// 两个量都能自圆其说,但放在一起就是让人猜不到什么时候会抽。
// 按轮次计数虽然粗(一轮可能是「嗯」也可能是长篇讨论),但它**可预测**,
// 而记忆抽取不需要精确计量:抽多了浪费一次便宜调用,抽少了下次补上。
//
// 抽取**绝不向主循环抛异常**。记忆是增强不是必需品:一次抽取失败
// 不该让用户的这一轮报错。所有失败路径都只记日志。
// ============================================

import { z } from 'zod';
import { Logger, RetryHandler, RetryConfig, RetryableError } from '../platform/index.js';
import type { LLMClient } from './llm-client.js';
import { messageToText } from './llm-client.js';
import type { Turn } from './context.js';
import {
  ExtractionSchema,
  EXTRACTION_SYSTEM_PROMPT,
  renderExistingForExtractor,
  mergeExtraction,
  loadMemory,
  saveMemory,
  clearMemory,
  renderMemoryPrompt,
  type MemoryEntry,
  type MemoryStore,
} from './memory.js';

export interface MemoryManagerConfig {
  store: MemoryStore;
  llmClient: LLMClient;
  logger: Logger;
  /**
   * 每几轮抽一次(默认 3)
   *
   * 同时也是**给抽取器看的轮数** —— 两者是同一个数,不该拆成两个旋钮:
   * 拆开的话「隔 3 轮抽、但看最近 6 轮」意味着每轮被重复分析,
   * 而重复分析同一段对话只会让同一条特征反复 hits+1,虚高它的稳定度。
   */
  turnsPerExtraction?: number;
  /** 抽取调用的输出上限。思维链计入输出预算,给小了正文会空 */
  maxTokens?: number;
  retry?: Partial<RetryConfig>;
}

const DEFAULTS = {
  turnsPerExtraction: 3,
  maxTokens: 2000,
};

/** 单条用户发言的截断长度。抽取只需要看**倾向**,不需要全文 */
const USER_TEXT_CLIP = 400;

export class MemoryManager {
  private entries: MemoryEntry[];
  private retryHandler: RetryHandler;
  private turnsSinceLast = 0;
  /** 抽取进行中的标志。防重入:抽取本身是 await,期间可能又攒够一次触发条件 */
  private extracting = false;

  constructor(private config: MemoryManagerConfig) {
    this.entries = loadMemory(config.store, config.logger);
    // explicitOnly:只重试解析/校验失败。网络类错误在 llmClient 内部已经重试过
    this.retryHandler = new RetryHandler(
      { ...(config.retry ?? {}), explicitOnly: true },
      config.logger,
    );
    if (this.entries.length > 0) {
      config.logger.debug('长期记忆已加载', { entries: this.entries.length });
    }
  }

  /** 注入系统提示的那一段(空记忆时为空串) */
  prompt(): string {
    return renderMemoryPrompt(this.entries);
  }

  /** 给 /memory 命令看 */
  list(): readonly MemoryEntry[] {
    return this.entries;
  }

  /** 整体清空 —— 用户唯一的写操作(不做逐条编辑,见 memory.ts 顶部) */
  clear(): void {
    this.entries = [];
    clearMemory(this.config.store);
    this.config.logger.info('长期记忆已清空');
  }

  /**
   * 一轮结束时调用 —— 每 N 轮抽一次
   *
   * **不 await 也不抛异常**:调用方可以直接 `void manager.onTurnEnd(turns)`。
   * 抽取失败只记日志,记忆是增强不是必需品。
   */
  async onTurnEnd(turns: readonly Turn[]): Promise<void> {
    this.turnsSinceLast += 1;

    const every = this.config.turnsPerExtraction ?? DEFAULTS.turnsPerExtraction;
    if (this.extracting) return;
    if (this.turnsSinceLast < every) return;
    if (turns.length === 0) return;

    this.extracting = true;
    // 计数器**在这里就清零**,不等抽取成功:失败时不清会让下一轮立刻再试,
    // 一次模型抽风就变成连续重试
    const turnsToRead = Math.min(this.turnsSinceLast, every);
    this.turnsSinceLast = 0;

    try {
      await this.extract(turns.slice(-turnsToRead));
    } catch (e) {
      // 抽取失败不影响任何东西 —— 记忆保持原样,下次再试
      this.config.logger.warn('长期记忆抽取失败,保持原记忆', {
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      this.extracting = false;
    }
  }

  private async extract(turns: readonly Turn[]): Promise<void> {
    const dialogue = this.renderTurns(turns);
    if (!dialogue.trim()) return;

    const existing = renderExistingForExtractor(this.entries);
    const extraction = await this.completeJSON(
      `已记录的特征:\n${existing}\n\n最近的对话:\n${dialogue}`,
    );

    if (extraction.candidates.length === 0 && extraction.contradicts.length === 0) {
      this.config.logger.debug('长期记忆:本次无可抽取内容');
      return;
    }

    const before = this.entries.length;
    // 合并在 memory.ts:默认全部保留,只替换明确指出矛盾的条目
    this.entries = mergeExtraction(this.entries, extraction, Date.now());
    saveMemory(this.config.store, this.entries);

    this.config.logger.info('长期记忆已更新', {
      before,
      after: this.entries.length,
      candidates: extraction.candidates.length,
      contradicts: extraction.contradicts.length,
    });
  }

  /**
   * 渲染对话给抽取器
   *
   * 只给**用户发言**和**最终回答的存在性**,不给工具往返:
   * 工具调用和代码是模型的行为,不是用户特征的证据,给了只会稀释信号
   * (而且工具结果动辄几千字,会把区间撑爆)。
   *
   * `messages[0]` 之后的 role:'user' 是**工具观察**而非用户发言
   * (见 context.ts 的顺序约定),必须排除 —— 否则会把截图描述
   * 当成用户说过的话去提取特征。
   */
  private renderTurns(turns: readonly Turn[]): string {
    const lines: string[] = [];

    for (const turn of turns) {
      const first = turn.messages[0];
      if (!first || first.role !== 'user') continue;

      const text = messageToText(first.content ?? '').trim();
      if (!text) continue;

      lines.push(
        `用户: ${text.length > USER_TEXT_CLIP ? text.slice(0, USER_TEXT_CLIP) + '…' : text}`,
      );
    }

    return lines.join('\n');
  }

  private async completeJSON(userContent: string): Promise<z.infer<typeof ExtractionSchema>> {
    return this.retryHandler.execute(async () => {
      const response = await this.config.llmClient.complete({
        messages: [
          { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        temperature: 0.3,
        maxTokens: this.config.maxTokens ?? DEFAULTS.maxTokens,
        responseFormat: 'json_object',
        traceLabel: 'memory:extraction',
      });

      const raw = response.content?.trim();
      if (!raw) throw new RetryableError('记忆抽取:模型返回空内容');

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new RetryableError('记忆抽取:JSON 解析失败');
      }

      const validated = ExtractionSchema.safeParse(parsed);
      if (!validated.success) {
        const detail = validated.error.issues
          .map(i => `${i.path.join('.')} ${i.message}`)
          .join('; ');
        throw new RetryableError(`记忆抽取:Schema 校验失败 - ${detail}`);
      }

      return validated.data;
    }, '记忆抽取');
  }
}
