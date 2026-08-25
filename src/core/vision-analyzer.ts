// ============================================
// Core 层:视觉插件(把图交给视觉模型,只把文字带回来)
// ============================================
//
// 为什么实现放在 core:它要用 LLMClient,而依赖方向是 core → tools → executors。
// 接口声明在 tools/contract.ts,由入口注入 —— 与 SubAgentRunner 同一套模式。
//
// **数据流是反过来的**,这是「视觉即插件」的全部含义:
// 不是「把图搬进主模型的上下文」,而是「把图交给视觉模型、只把文字带回来」。
// 主模型全程不接触像素,所以它是不是多模态与框架无关 ——
// 这正是要把主模型换成强文本模型(v4-pro)时需要的形状。
//
// 复用的部分:图片转线格式(data URL 前缀、detail 透传)完全走已有的
// ContentPart → adapter 那条路,一行都不用重写。变的只是**发给谁**。
//
// 每次调用都是**单发**:一张图 + 一个问题,不带对话历史。
// 视觉模型不需要知道主 agent 在做什么 —— 它只回答「这张图里有什么」。
// 好处是无状态、可并发、不受主上下文压缩影响。
// ============================================

import type { LLMClient, ContentPart } from './llm-client.js';
import type { Logger } from '../platform/index.js';
import type {
  VisionAnalyzer,
  VisionRequest,
  VisionResult,
} from '../tools/contract.js';

/**
 * 视觉模型的系统提示
 *
 * 两条约束都是为了「文字要能替代图片」:
 * - **只描述看得见的**:主模型无法核对,视觉模型一旦推测,错误就成了主模型的事实
 * - **带上位置和原文**:主模型接下来可能要写代码点击某个元素,
 *   「右上角有个蓝色按钮,写着『登录』」比「页面有登录入口」有用得多
 */
const VISION_SYSTEM_PROMPT =
  '你是一个视觉观察助手。你的输出会作为**唯一**的观察结果交给另一个模型，' +
  '它看不到这张图，只能读你的文字。\n' +
  '要求：\n' +
  '① 只描述图中确实可见的内容，不要推测意图、不要补充图外的背景知识。' +
  '看不清就说看不清，不要猜。\n' +
  '② 涉及文字时**照抄原文**（按钮标签、报错信息、验证码、表格数值），' +
  '不要转述或翻译。\n' +
  '③ 带上位置信息（左上/居中/右下、第几行），' +
  '因为对方可能要据此写代码定位元素。\n' +
  '④ 直接给观察，不要写「这张图片显示了」这类开场白。';

/** 观察文字的硬上限(字符)。它会进主上下文,不能任由视觉模型铺开 */
const MAX_OBSERVATION_CHARS = 4000;

export interface VisionAnalyzerConfig {
  /** 视觉模型的 client(由入口用视觉模型配置单独建一个 adapter) */
  client: LLMClient;
  /** 模型名。写进工具返回值,让主模型知道是谁看的 */
  modelName: string;
  logger: Logger;
  /** 单次输出预算。默认 1024 —— 描述一张图够用,又拦得住长篇大论 */
  maxTokens?: number;
}

export class LocalVisionAnalyzer implements VisionAnalyzer {
  constructor(private config: VisionAnalyzerConfig) {}

  get modelName(): string {
    return this.config.modelName;
  }

  async analyze(request: VisionRequest): Promise<VisionResult> {
    const { logger } = this.config;

    // 问题为空时给一个通用指令。不留空字符串:有些实现会把空 text 块判为非法
    const ask = request.question?.trim()
      ? request.question.trim()
      : '描述这张图的内容。如果是网页截图，说明页面主体、可见的可点击元素及其文字。';

    // 图片转线格式复用已有那条路(data URL 前缀、detail 透传都在 adapter 里),
    // 这里只组装中立格式
    const content: ContentPart[] = [
      { type: 'text', text: ask },
      {
        type: 'image',
        data: request.data,
        mimeType: request.mimeType,
        label: request.label,
        detail: request.detail ?? 'low',
      },
    ];

    try {
      const response = await this.config.client.complete({
        messages: [
          { role: 'system', content: VISION_SYSTEM_PROMPT },
          { role: 'user', content },
        ],
        // 单发调用:不带对话历史,视觉模型不需要知道主 agent 在做什么
        maxTokens: this.config.maxTokens ?? 1024,
        traceLabel: `vision:${request.label}`,
      });

      if (!response.content?.trim()) {
        // 视觉模型没给文字 = 这次观察没有任何产物。必须报失败,
        // 否则主模型会拿着一句空话继续推理
        logger.warn('视觉模型未返回观察内容', {
          label: request.label,
          finish_reason: response.finishReason,
        });
        return {
          ok: false,
          error:
            `视觉模型未返回观察内容(finish_reason=${response.finishReason})。` +
            '可重试，或换 detail="original" 再试一次。',
        };
      }

      const observation = clip(response.content.trim(), MAX_OBSERVATION_CHARS);

      logger.info('视觉观察完成', {
        label: request.label,
        model: this.config.modelName,
        question: request.question ?? '(通用描述)',
        chars: observation.length,
        prompt_tokens: response.usage?.prompt_tokens,
        completion_tokens: response.usage?.completion_tokens,
      });

      return {
        ok: true,
        observation,
        ...(response.usage
          ? {
              usage: {
                promptTokens: response.usage.prompt_tokens,
                completionTokens: response.usage.completion_tokens,
              },
            }
          : {}),
      };
    } catch (error) {
      // 视觉调用失败不该炸掉主循环:包成 ok:false 让主模型改道
      // (它可以改用 aria_snapshot 读结构,那条路不需要视觉)
      const message = error instanceof Error ? error.message : String(error);
      logger.error('视觉模型调用失败', { label: request.label, error: message });
      return { ok: false, error: `视觉模型调用失败：${message}` };
    }
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…(观察过长已截断)` : text;
}
