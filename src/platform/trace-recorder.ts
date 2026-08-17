// ============================================
// Platform 层:LLM 调用留痕
// ============================================
//
// 职责：
// 1. 把每次 LLM 调用的「线格式请求 + 原始响应」成对落盘，供本地定位真实效果问题
// 2. 终端只回显精简摘要（终端要能读），深挖去翻 JSON 文件
//
// 关键设计：
// - 一次调用 = 一个文件 call-NNN.json。单文件比一个巨大 JSONL 更好翻，
//   出问题时直接打开对应序号，不用 grep 切分
// - 另写一份 index.jsonl（一行一次调用的摘要），用来快速扫「哪次慢/哪次失败」
// - 写盘失败绝不影响主流程：留痕是辅助手段，不能反过来搞崩被观测的程序
// - 同步写入。CLI 场景下调用频率低（每次都要等模型），换取「进程崩了也不丢」
//
// 落盘位置：traces/<sessionId>/（项目根下的可见目录，方便直接翻）
//
// 使用示例：
//   const recorder = new TraceRecorder({ sessionId, logger });
//   const adapter = new DeepSeekAdapter({ ..., onTrace: recorder.sink });
// ============================================

import fs from 'fs';
import path from 'path';

// 只依赖四个日志方法，避免与 Logger 形成循环导入（同 RetryHandler 的做法）
interface TraceLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface TraceRecorderConfig {
  sessionId: string;
  logger: TraceLogger;
  baseDir?: string;     // 默认 traces/（项目根下的可见目录）
  enabled?: boolean;    // 默认 true；false 时所有方法变空操作
}

export interface TraceSummary {
  callIndex: number;
  label: string;
  durationMs: number;
  attempts?: number;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  toolCalls: string[];
  finishReason?: string;
  hasReasoning: boolean;
  failed: boolean;
  errorMessage?: string;
  file?: string;
}

export class TraceRecorder {
  private dir: string;
  private enabled: boolean;
  private summaries: TraceSummary[] = [];
  private ready = false;

  constructor(private config: TraceRecorderConfig) {
    this.enabled = config.enabled ?? true;
    this.dir = path.join(config.baseDir ?? 'traces', config.sessionId);
  }

  /** 传给 Adapter 的 onTrace。绑定 this，可直接作为回调传递 */
  sink = (event: {
    callIndex: number;
    label: string;
    model: string;
    startedAt: number;
    durationMs: number;
    attempts?: number;
    wireRequest: unknown;
    wireResponse?: unknown;
    parsed?: unknown;
    error?: { message: string; name?: string };
  }): void => {
    if (!this.enabled) return;

    const parsed = event.parsed as {
      content?: string | null;
      reasoning?: string | null;
      toolCalls?: Array<{ name: string }>;
      finishReason?: string;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_cache_hit_tokens?: number;
      };
    } | undefined;

    const summary: TraceSummary = {
      callIndex: event.callIndex,
      label: event.label,
      durationMs: event.durationMs,
      attempts: event.attempts,
      promptTokens: parsed?.usage?.prompt_tokens,
      completionTokens: parsed?.usage?.completion_tokens,
      cachedTokens: parsed?.usage?.prompt_cache_hit_tokens,
      toolCalls: parsed?.toolCalls?.map(tc => tc.name) ?? [],
      finishReason: parsed?.finishReason,
      hasReasoning: !!parsed?.reasoning,
      failed: !!event.error,
      errorMessage: event.error?.message,
    };

    const filename = `call-${String(event.callIndex).padStart(3, '0')}.json`;
    summary.file = path.join(this.dir, filename);
    this.summaries.push(summary);

    // 留痕失败不能影响主流程
    try {
      this.ensureDir();
      fs.writeFileSync(
        path.join(this.dir, filename),
        JSON.stringify({
          call_index: event.callIndex,
          label: event.label,
          model: event.model,
          started_at: new Date(event.startedAt).toISOString(),
          duration_ms: event.durationMs,
          attempts: event.attempts,
          wire_request: event.wireRequest,
          wire_response: event.wireResponse,
          parsed: event.parsed,
          error: event.error,
        }, null, 2)
      );

      fs.appendFileSync(
        path.join(this.dir, 'index.jsonl'),
        JSON.stringify({ ...summary, file: filename }) + '\n'
      );
    } catch (err) {
      this.config.logger.warn('trace 写入失败（不影响主流程）', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  private ensureDir() {
    if (this.ready) return;
    fs.mkdirSync(this.dir, { recursive: true });
    this.ready = true;
  }

  /** 最近一次调用的摘要 */
  last(): TraceSummary | undefined {
    return this.summaries[this.summaries.length - 1];
  }

  /** 指定序号之后的调用（用于回显「本轮发生了什么」） */
  since(callIndex: number): TraceSummary[] {
    return this.summaries.filter(s => s.callIndex > callIndex);
  }

  count(): number {
    return this.summaries.length;
  }

  get traceDir(): string {
    return this.dir;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }
}
