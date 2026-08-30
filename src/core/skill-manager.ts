// ============================================
// Core 层:skill 的读取与沉淀驱动
// ============================================
//
// 纯逻辑(存取/渲染/合并)在 skill.ts,不依赖 LLM、可独立测试。
// 这里只管**什么时候抽、给它看什么、结果怎么落盘**,以及实现工具要用的
// SkillReader 接口。
//
// 触发判据是**单轮**的:这一轮跑了 ≥8 步工具调用,或出现过工具失败。
//
// 为什么不按「攒够 N 轮」——那是记忆的做法,在这里不成立:
// 记忆攒的是「关于用户的观察」,越多轮越准;而 skill 沉淀的对象是
// **一次任务轨迹**,一次做成的「搜知乎热搜」就已经完整可复用,
// 攒十次不会让它更完整,只会让你晚十次才拿到它。
// 而且实测会话规模是 1~3 轮 —— 十轮门槛会重复 CONTEXT_RECENT_TURNS=10
// 那个「配了但永远达不到」的错误(1M×0.7 的阈值让压缩从未触发过)。
//
// 判据宽松是有意的:严格性全部交给**人工审批**那一关。
// 触发便宜(一次不阻塞的调用),而入库贵(一条描述含糊的 skill 会永久
// 占着索引预算、永远不被选中,或更糟——被选中然后误导模型)。
// 有审批闸门在,触发松一点的代价只是多审几条;而漏掉的代价是功能形同虚设。
//
// 抽取**绝不向主循环抛异常**(与 MemoryManager 同一条原则)。
// ============================================

import { z } from 'zod';
import { Logger, RetryHandler, RetryConfig, RetryableError } from '../platform/index.js';
import type { LLMClient } from './llm-client.js';
import { messageToText } from './llm-client.js';
import type { Turn } from './context.js';
import type { SkillLookupResult, SkillReader } from '../tools/index.js';
import {
  SkillExtractionSchema,
  SKILL_EXTRACTION_SYSTEM_PROMPT,
  renderExistingSkillsForExtractor,
  mergeSkillExtraction,
  loadSkills,
  saveSkills,
  activeSkills,
  pendingSkills,
  findSkill,
  renderSkillIndex,
  renderSkillBody,
  type Skill,
  type SkillStore,
} from './skill.js';

export interface SkillManagerConfig {
  store: SkillStore;
  llmClient: LLMClient;
  logger: Logger;
  /** 触发沉淀的工具步数门槛(默认 8) */
  minToolSteps?: number;
  /** 抽取调用的输出上限。思维链计入输出预算,给小了正文会空 */
  maxTokens?: number;
  retry?: Partial<RetryConfig>;
  /**
   * 库变动后的通知 —— 沉淀是**异步**的,壳没法自己知道什么时候刷
   *
   * onTurnEnd 是 `void` 调用的(见 session.ts):run() 早就返回了,
   * 抽取还在跑。壳如果在一轮结束时刷技能列表,必然刷不到这一轮刚沉淀的那条 ——
   * 表现成「跑完任务角标不动,重开窗口才冒出来」。
   *
   * 只在**真有变动**时触发(不值得沉淀、结果不完整都不发),
   * 免得壳每轮都白跑一次 IPC。回调里抛异常不影响抽取结果:已经落盘了。
   */
  onChanged?: () => void;
}

// maxTokens **刻意不在这里给默认值**。
//
// 原先兜底 2000,而那是个暗默预算:配了 MAIN_MAX_TOKENS 也管不到抽取调用。
// 思维链计入输出预算,2000 在开着思维链时根本不够 —— 实测模型把整份答案
// (名字/描述/四个步骤/四条坑)都在 reasoning 里想完了,预算用尽,
// content 一个字都没轮到,4 次重试全是空内容(白等 2 分 40 秒)。
// 而失败原因是预算不够,重试不会让预算变多。
// 证据:traces/app-1788091462247/calls/call-019.json
//
// 不传则由 adapter 回落到主模型那份配置(request.maxTokens ?? config.maxTokens),
// 于是 MAIN_MAX_TOKENS 是输出预算**唯一**的来源。
const DEFAULTS = {
  minToolSteps: 8,
};

/** 轨迹渲染时单条工具结果的截断长度 */
const TOOL_TEXT_CLIP = 500;
/** 单轮渲染的总长上限 —— 一轮可能有几十次工具往返,不截会把抽取输入撑爆 */
const TRAJECTORY_CLIP = 12_000;

/** 本轮的工具活动量 —— 由 session 从 context.getStats().currentTurn 取来 */
export interface TurnActivity {
  toolSteps: number;
  toolFails: number;
}

export class SkillManager implements SkillReader {
  private skills: Skill[];
  private retryHandler: RetryHandler;
  /** 抽取进行中的标志。防重入:抽取是 await,期间下一轮可能又够格了 */
  private extracting = false;

  constructor(private config: SkillManagerConfig) {
    this.skills = loadSkills(config.store, config.logger);
    // explicitOnly:只重试解析/校验失败。网络类错误在 llmClient 内部已重试过,
    // 两层都按特征匹配会让调用次数相乘
    this.retryHandler = new RetryHandler(
      { ...(config.retry ?? {}), explicitOnly: true },
      config.logger,
    );
    if (this.skills.length > 0) {
      config.logger.debug('技能库已加载', {
        active: activeSkills(this.skills).length,
        pending: pendingSkills(this.skills).length,
      });
    }
  }

  /** 注入系统提示的索引段(空库时为空串) */
  prompt(): string {
    return renderSkillIndex(this.skills);
  }

  // ---------- SkillReader:给 load_skill 工具用 ----------

  /**
   * 按名字取轨迹
   *
   * **只认已审批的**:待审批条目根本不出现在索引里,模型不该能取到它。
   * 取错名字时附上可用名单 —— 只报「没找到」的话模型会去猜第二个名字,
   * 而每次猜错都是一个 round trip(按实测首字延迟地板 5.79s,6~12 秒)。
   */
  load(name: string): SkillLookupResult {
    const active = activeSkills(this.skills);
    const hit = findSkill(active, name.trim());

    if (!hit) {
      return {
        ok: false,
        error: `未找到技能「${name}」`,
        available: active.map(s => s.name),
      };
    }

    // 命中计数是淘汰与排序的唯一可信信号,取用即累加。
    // 写盘失败不影响返回:轨迹已经拿到了,计数丢一次无妨
    hit.hits += 1;
    try {
      saveSkills(this.config.store, this.skills);
    } catch (e) {
      this.config.logger.warn('技能命中数写盘失败', {
        skill: name,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    return { ok: true, body: renderSkillBody(hit) };
  }

  // ---------- 审批 ----------

  list(): readonly Skill[] {
    return this.skills;
  }

  pending(): readonly Skill[] {
    return pendingSkills(this.skills);
  }

  /** 通过审批 —— 这一刻它才进索引、才可被 load_skill 取到 */
  approve(name: string): boolean {
    const hit = findSkill(this.skills, name);
    if (!hit || !hit.pending) return false;

    hit.pending = false;
    hit.updatedAt = Date.now();
    saveSkills(this.config.store, this.skills);
    this.config.logger.info('技能已通过审批', { skill: name });
    return true;
  }

  /** 丢弃 —— 用户判断这条不值得留 */
  reject(name: string): boolean {
    const idx = this.skills.findIndex(s => s.name === name && s.pending);
    if (idx < 0) return false;

    this.skills.splice(idx, 1);
    saveSkills(this.config.store, this.skills);
    this.config.logger.info('技能已丢弃', { skill: name });
    return true;
  }

  // ---------- 沉淀 ----------

  /**
   * 轮末钩子 —— **不 await 也不抛异常**
   *
   * 调用方可以直接 `void manager.onTurnEnd(...)`。抽取失败只记日志,
   * skill 是增强不是必需品。
   *
   * @param turn 刚结束的那一轮(轨迹来源)
   * @param activity 本轮工具活动量,来自 context.getStats().currentTurn
   * @param stopReason 只有 complete 才沉淀 —— 见下
   */
  async onTurnEnd(
    turn: Turn | undefined,
    activity: TurnActivity,
    stopReason: string,
  ): Promise<void> {
    if (!turn) return;

    // 只沉淀**正常完成**的轮次。
    // aborted 已经在 session 那边整轮丢弃了(不会走到这里);
    // truncated / max_steps / no_response 的轨迹本身就是没走完的 ——
    // 把半截流程记成 skill 会让下次照着走同样走不完。
    //
    // 注意 complete 只说明模型**认为**自己答完了,不保证答对。
    // 所以库里会混进错的轨迹,只能靠命中之后的结果淘汰
    // (这就是 hits / lastOkAt 存在的理由)。
    if (stopReason !== 'complete') return;

    const minSteps = this.config.minToolSteps ?? DEFAULTS.minToolSteps;
    const worthTrying = activity.toolSteps >= minSteps || activity.toolFails > 0;
    if (!worthTrying) return;

    if (this.extracting) {
      this.config.logger.debug('技能抽取正在进行,跳过本轮');
      return;
    }

    this.extracting = true;
    try {
      await this.extract(turn, activity);
    } catch (e) {
      // 失败不影响任何东西 —— 库保持原样,下次够格再试
      this.config.logger.warn('技能抽取失败,库保持原样', {
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      this.extracting = false;
    }
  }

  private async extract(turn: Turn, activity: TurnActivity): Promise<void> {
    const trajectory = this.renderTrajectory(turn);
    if (!trajectory.trim()) return;

    // 现有列表必须给 —— 不给的话每次成功都新建一条,
    // 很快就是五十条「搜知乎热搜」。待审批的也要列(否则待审列表里也会堆)
    const existing = renderExistingSkillsForExtractor(this.skills);

    const extraction = await this.completeJSON(
      [
        `已记录的轨迹:\n${existing}`,
        '',
        `本次任务(${activity.toolSteps} 步工具调用,${activity.toolFails} 次失败):`,
        trajectory,
      ].join('\n'),
    );

    if (!extraction.worth) {
      this.config.logger.debug('技能抽取:本次不值得沉淀', {
        reason: extraction.reason,
      });
      return;
    }

    const before = this.skills.length;
    // 合并在 skill.ts:只增不删,更新时保留 hits/createdAt
    const merged = mergeSkillExtraction(this.skills, extraction, Date.now());

    if (merged.changed === 'none') {
      this.config.logger.debug('技能抽取:结果不完整,未入库');
      return;
    }

    this.skills = merged.skills;
    saveSkills(this.config.store, this.skills);

    this.config.logger.info('技能已沉淀(待审批)', {
      skill: merged.name,
      change: merged.changed,
      before,
      after: this.skills.length,
    });

    // 通知壳去刷列表。放在**落盘之后**:壳收到就会立刻回来读,
    // 早发一步会读到旧库。
    //
    // 包 try/catch 是因为这是外部回调:壳里抛异常不该让抽取看起来失败了 ——
    // 库已经存好了,只是界面没刷上。
    //
    // approve/reject **不发**这个通知:那两条路是用户在界面上点出来的,
    // IPC 处理器已经把新列表当返回值带回去了,再发一次等于多跑一趟。
    try {
      this.config.onChanged?.();
    } catch (e) {
      this.config.logger.warn('技能变动通知失败', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * 渲染轨迹给抽取器
   *
   * 与记忆抽取相反:那边**只要**用户发言、不要工具往返(工具调用是模型行为,
   * 不是用户特征的证据)。这边正好要工具往返 —— 轨迹就是「做了哪些动作」。
   *
   * 失败的尝试**也喂**:「别试 X,那条路不通」往往比正确路径更值钱。
   * 抽取提示里要求把它们归进 pitfalls 而不是写成步骤。
   *
   * 单条结果截断到 500 字:抽取要的是「调了什么、成没成」,
   * 不是完整的 stdout(那动辄几千字,几十次往返会把输入撑爆)。
   */
  private renderTrajectory(turn: Turn): string {
    const lines: string[] = [];

    for (const msg of turn.messages) {
      if (msg.role === 'user') {
        // messages[0] 是提问;之后的 role:'user' 是**工具观察**
        // (图片只能走 user 通道,见 context.ts 的顺序约定)
        const text = messageToText(msg.content ?? '').trim();
        if (!text) continue;
        lines.push(lines.length === 0 ? `任务: ${text}` : `观察: ${clip(text)}`);
        continue;
      }

      if (msg.role === 'assistant') {
        if (msg.toolCalls?.length) {
          for (const tc of msg.toolCalls) {
            lines.push(`动作: ${tc.name} ${clip(JSON.stringify(tc.args))}`);
          }
        } else if (msg.content?.trim()) {
          lines.push(`结论: ${clip(msg.content.trim())}`);
        }
        continue;
      }

      if (msg.role === 'tool') {
        lines.push(`结果: ${clip(msg.content ?? '')}`);
      }
    }

    const out = lines.join('\n');
    return out.length > TRAJECTORY_CLIP ? out.slice(0, TRAJECTORY_CLIP) + '\n…(已截断)' : out;
  }

  private async completeJSON(
    userContent: string,
  ): Promise<z.infer<typeof SkillExtractionSchema>> {
    return this.retryHandler.execute(async () => {
      const response = await this.config.llmClient.complete({
        messages: [
          { role: 'system', content: SKILL_EXTRACTION_SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        temperature: 0.3,
        // 不传即跟随主模型(见 DEFAULTS 上方说明)
        maxTokens: this.config.maxTokens,
        responseFormat: 'json_object',
        traceLabel: 'skill:extraction',
      });

      const raw = response.content?.trim();
      if (!raw) throw new RetryableError('技能抽取:模型返回空内容');

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new RetryableError('技能抽取:JSON 解析失败');
      }

      const validated = SkillExtractionSchema.safeParse(parsed);
      if (!validated.success) {
        const detail = validated.error.issues
          .map(i => `${i.path.join('.')} ${i.message}`)
          .join('; ');
        throw new RetryableError(`技能抽取:结构校验失败 (${detail})`);
      }

      return validated.data;
    }, '技能抽取');
  }
}

function clip(text: string): string {
  return text.length > TOOL_TEXT_CLIP ? text.slice(0, TOOL_TEXT_CLIP) + '…' : text;
}
