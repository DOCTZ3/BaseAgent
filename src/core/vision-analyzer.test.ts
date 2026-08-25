// ============================================
// LocalVisionAnalyzer 单元测试
// ============================================
//
// 三组重点：
// - **发出去的请求**:图片作为 ContentPart 进 user 消息、单发(不带对话历史)、
//   detail 默认 low。图片转线格式那一步复用 adapter,这里只验中立格式组装对
// - **空观察必须判失败**:视觉调用是花过钱的,返回空字符串却 ok:true 的话,
//   主模型会拿着一句空话继续推理 —— 静默失败比报错危险得多
// - **失败不抛异常**:视觉调不通时主模型该能改道(比如改用 aria_snapshot 读结构),
//   所以一律包成 ok:false 回流
// ============================================

import { describe, it, expect, vi } from 'vitest';
import { LocalVisionAnalyzer } from './vision-analyzer.js';
import type { LLMClient, LLMRequest, LLMResponse, ImagePart } from './llm-client.js';
import type { Logger } from '../platform/index.js';

const logger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
} as unknown as Logger;

/** 记录收到什么的假 client。不发网络请求 —— 这里测的是组装与判定 */
function fakeClient(response: Partial<LLMResponse> = { content: '图中有一个登录按钮。' }) {
  const requests: LLMRequest[] = [];
  const client: LLMClient = {
    complete: async (req) => {
      requests.push(req);
      return {
        content: null,
        reasoning: null,
        toolCalls: [],
        finishReason: 'stop',
        ...response,
      } as LLMResponse;
    },
  };
  return { client, requests };
}

function make(response?: Partial<LLMResponse>, maxTokens?: number) {
  const { client, requests } = fakeClient(response);
  const analyzer = new LocalVisionAnalyzer({
    client,
    modelName: 'test-vision',
    maxTokens,
    logger,
  });
  return { analyzer, requests };
}

const IMG = {
  data: 'AAAA',
  mimeType: 'image/png' as const,
  label: 'shot.png',
};

describe('LocalVisionAnalyzer', () => {
  describe('发出去的请求', () => {
    it('图片作为 ContentPart 进 user 消息，system 里带约束', async () => {
      const { analyzer, requests } = make();
      await analyzer.analyze({ ...IMG, question: '有登录按钮吗？' });

      const [sys, user] = requests[0].messages;
      expect(sys.role).toBe('system');
      expect(user.role).toBe('user');

      const parts = user.content as Array<{ type: string }>;
      expect(parts[0]).toMatchObject({ type: 'text', text: '有登录按钮吗？' });
      expect(parts[1]).toMatchObject({
        type: 'image',
        data: 'AAAA',
        mimeType: 'image/png',
      });
    });

    it('单发调用：只有 system + user 两条，不带对话历史', async () => {
      // 视觉模型不需要知道主 agent 在做什么，它只回答「这张图里有什么」。
      // 无状态才能并发、且不受主上下文压缩影响
      const { analyzer, requests } = make();
      await analyzer.analyze(IMG);

      expect(requests[0].messages).toHaveLength(2);
    });

    it('detail 默认 low（省视觉模型那边的 token）', async () => {
      const { analyzer, requests } = make();
      await analyzer.analyze(IMG);

      const parts = requests[0].messages[1].content as ImagePart[];
      expect(parts[1].detail).toBe('low');
    });

    it('detail 可显式指定', async () => {
      const { analyzer, requests } = make();
      await analyzer.analyze({ ...IMG, detail: 'original' });

      const parts = requests[0].messages[1].content as ImagePart[];
      expect(parts[1].detail).toBe('original');
    });

    it('不给 question 时退回通用描述指令，不发空文本块', async () => {
      // 空 text 块有实现会判为非法，所以必须给一句默认指令
      const { analyzer, requests } = make();
      await analyzer.analyze(IMG);

      const parts = requests[0].messages[1].content as Array<{ text?: string }>;
      expect(parts[0].text).toBeTruthy();
      expect(parts[0].text).toContain('描述');
    });

    it('question 只有空白时同样退回通用描述', async () => {
      const { analyzer, requests } = make();
      await analyzer.analyze({ ...IMG, question: '   ' });

      const parts = requests[0].messages[1].content as Array<{ text?: string }>;
      expect(parts[0].text).toContain('描述');
    });

    it('traceLabel 带上来源，视觉调用在 trace 里可查', async () => {
      const { analyzer, requests } = make();
      await analyzer.analyze(IMG);

      expect(requests[0].traceLabel).toBe('vision:shot.png');
    });

    it('maxTokens 默认 1024，可覆盖', async () => {
      const a = make();
      await a.analyzer.analyze(IMG);
      expect(a.requests[0].maxTokens).toBe(1024);

      const b = make(undefined, 256);
      await b.analyzer.analyze(IMG);
      expect(b.requests[0].maxTokens).toBe(256);
    });
  });

  describe('返回观察', () => {
    it('成功时回传文字与 usage', async () => {
      const { analyzer } = make({
        content: '右上角有蓝色「登录」按钮。',
        usage: { prompt_tokens: 400, completion_tokens: 30 },
      });
      const r = await analyzer.analyze(IMG);

      expect(r.ok).toBe(true);
      expect(r.observation).toBe('右上角有蓝色「登录」按钮。');
      expect(r.usage).toEqual({ promptTokens: 400, completionTokens: 30 });
    });

    it('观察过长会截断 —— 它要进主上下文，不能任由视觉模型铺开', async () => {
      const { analyzer } = make({ content: 'x'.repeat(6000) });
      const r = await analyzer.analyze(IMG);

      expect(r.ok).toBe(true);
      expect(r.observation!.length).toBeLessThan(6000);
      expect(r.observation).toContain('已截断');
    });

    it('modelName 暴露出来，供工具标注「是谁看的」', () => {
      const { analyzer } = make();
      expect(analyzer.modelName).toBe('test-vision');
    });
  });

  describe('失败路径', () => {
    it('空观察判失败 —— 不把空话当结果交给主模型', async () => {
      // 视觉调用是花过钱的。返回 ok:true + 空字符串的话，
      // 主模型会基于一句空话继续推理，比报错危险得多
      const { analyzer } = make({ content: '   ', finishReason: 'length' });
      const r = await analyzer.analyze(IMG);

      expect(r.ok).toBe(false);
      expect(r.error).toContain('length');   // 带上 finish_reason，便于判断是不是被截断
      expect(r.observation).toBeUndefined();
    });

    it('content 为 null 同样判失败', async () => {
      const { analyzer } = make({ content: null });
      const r = await analyzer.analyze(IMG);

      expect(r.ok).toBe(false);
    });

    it('调用抛异常 → ok:false，不炸主循环', async () => {
      // 主模型收到 ok:false 后可以改道（比如改用 aria_snapshot 读结构）
      const analyzer = new LocalVisionAnalyzer({
        client: { complete: async () => { throw new Error('429 rate limit'); } },
        modelName: 'test-vision',
        logger,
      });
      const r = await analyzer.analyze(IMG);

      expect(r.ok).toBe(false);
      expect(r.error).toContain('429');
    });
  });
});
