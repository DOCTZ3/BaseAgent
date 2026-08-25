// ============================================
// view_image 单元测试(视觉插件版)
// ============================================
//
// 两组重点：
// - **格式/配额拦截**:格式按内容判、尺寸解析、超限拦住。这三件事错了都会在
//   服务端变成 400,而错误信息对模型毫无指导性,所以必须在工具里提前拦并给建议。
//   它们都发生在**调视觉模型之前** —— 拦住就不该花那次钱
// - **数据流方向**:图交给视觉模型、只把文字带回来。主模型拿到的是 observation,
//   `attachments` 里不该有任何东西 —— 这是「视觉即插件」的核心不变量
// ============================================

import { describe, it, expect, vi } from 'vitest';
import { ViewImageTool } from './view-image.js';
import type { ToolContext, VisionAnalyzer, VisionRequest } from '../../contract.js';

/** 构造合法 PNG 头（IHDR 带真实尺寸） */
function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

/** 构造带 SOF0 的最小 JPEG */
function jpeg(width: number, height: number): Buffer {
  const b = Buffer.alloc(22);
  b.writeUInt16BE(0xffd8, 0);        // SOI
  b.writeUInt16BE(0xffe0, 2);        // APP0
  b.writeUInt16BE(6, 4);             // 段长
  b.write('JFIF', 6, 'ascii');
  b.writeUInt16BE(0xffc0, 12);       // SOF0
  b.writeUInt16BE(11, 14);           // 段长
  b.writeUInt8(8, 16);               // 精度
  b.writeUInt16BE(height, 17);
  b.writeUInt16BE(width, 19);
  return b;
}

function gif(width: number, height: number): Buffer {
  const b = Buffer.alloc(13);
  b.write('GIF89a', 0, 'ascii');
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

function webp(): Buffer {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(22, 4);
  b.write('WEBP', 8, 'ascii');
  b.write('VP8 ', 12, 'ascii');
  b.writeUInt32LE(10, 16);
  b.writeUInt16LE(640, 26);
  b.writeUInt16LE(480, 28);
  return b;
}

/** 记录收到什么的假视觉插件。不发网络请求 —— 这里测的是数据流,不是模型能力 */
function fakeVision(
  result: { ok: boolean; observation?: string; error?: string } = {
    ok: true,
    observation: '页面右上角有一个蓝色按钮，写着「登录」。',
  },
) {
  const calls: VisionRequest[] = [];
  const analyzer: VisionAnalyzer = {
    modelName: 'fake-vision-model',
    analyze: async (req) => {
      calls.push(req);
      return result;
    },
  };
  return { analyzer, calls };
}

function makeCtx(
  bytes: Buffer | Error,
  vision?: VisionAnalyzer,
): ToolContext {
  return {
    sessionId: 'test',
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    signal: new AbortController().signal,
    confirm: async () => true,
    executors: {
      fs: {
        readFileBytes: async () => {
          if (bytes instanceof Error) throw bytes;
          return bytes;
        },
      },
      vision: vision ?? fakeVision().analyzer,
    },
  } as unknown as ToolContext;
}

const tool = new ViewImageTool();

describe('ViewImageTool', () => {
  describe('格式识别（按内容，非扩展名）', () => {
    it('识别 PNG 并把尺寸带回结果', async () => {
      const { analyzer, calls } = fakeVision();
      const r = await tool.run({ path: 'a.png' }, makeCtx(png(1024, 768), analyzer));

      expect(r.ok).toBe(true);
      expect(calls[0].mimeType).toBe('image/png');
      expect(r.data).toMatchObject({ width: 1024, height: 768 });
    });

    it('识别 JPEG', async () => {
      const { analyzer, calls } = fakeVision();
      const r = await tool.run({ path: 'a.jpg' }, makeCtx(jpeg(800, 600), analyzer));

      expect(r.ok).toBe(true);
      expect(calls[0].mimeType).toBe('image/jpeg');
      expect(r.data).toMatchObject({ width: 800, height: 600 });
    });

    it('识别 GIF', async () => {
      const { analyzer, calls } = fakeVision();
      const r = await tool.run({ path: 'a.gif' }, makeCtx(gif(320, 240), analyzer));

      expect(r.ok).toBe(true);
      expect(calls[0].mimeType).toBe('image/gif');
    });

    it('识别 WebP', async () => {
      const { analyzer, calls } = fakeVision();
      const r = await tool.run({ path: 'a.webp' }, makeCtx(webp(), analyzer));

      expect(r.ok).toBe(true);
      expect(calls[0].mimeType).toBe('image/webp');
    });

    it('扩展名对但内容不是图片 → 拒绝并给转换建议', async () => {
      // 服务端按内容判格式，扩展名骗不过去，提前拦住比拿 400 有用
      const notImage = Buffer.from('BM this is actually a bmp or text', 'ascii');
      const { analyzer, calls } = fakeVision();
      const r = await tool.run({ path: 'fake.png' }, makeCtx(notImage, analyzer));

      expect(r.ok).toBe(false);
      expect(r.error).toContain('无法识别图片格式');
      expect(r.error).toContain('PIL');       // 给出可执行的转换路径
      expect(calls).toHaveLength(0);          // 拦在调用之前，不该花那次钱
    });

    it('空文件 → 明确报错，不调视觉模型', async () => {
      const { analyzer, calls } = fakeVision();
      const r = await tool.run({ path: 'empty.png' }, makeCtx(Buffer.alloc(0), analyzer));

      expect(r.ok).toBe(false);
      expect(r.error).toContain('文件为空');
      expect(calls).toHaveLength(0);
    });
  });

  describe('配额拦截（都发生在调视觉模型之前）', () => {
    it('单边超 8192px → 拒绝并给缩放建议', async () => {
      const { analyzer, calls } = fakeVision();
      const r = await tool.run({ path: 'huge.png' }, makeCtx(png(9000, 100), analyzer));

      expect(r.ok).toBe(false);
      expect(r.error).toContain('9000x100');
      expect(r.error).toContain('thumbnail');   // 可直接照抄的修复代码
      expect(calls).toHaveLength(0);
    });

    it('恰好 8192px 放行', async () => {
      const r = await tool.run({ path: 'edge.png' }, makeCtx(png(8192, 8192)));
      expect(r.ok).toBe(true);
    });
  });

  describe('detail 与 question 的传递', () => {
    it('默认 low（省视觉模型那边的 token）', async () => {
      const { analyzer, calls } = fakeVision();
      await tool.run({ path: 'a.png' }, makeCtx(png(100, 100), analyzer));

      expect(calls[0].detail).toBe('low');
    });

    it('可显式要 original', async () => {
      const { analyzer, calls } = fakeVision();
      await tool.run(
        { path: 'a.png', detail: 'original' },
        makeCtx(png(100, 100), analyzer),
      );

      expect(calls[0].detail).toBe('original');
    });

    it('question 原样传给视觉插件，并回显在结果里', async () => {
      // 回显是为了让主模型在多张图之间对得上「这段观察回答的是哪个问题」
      const { analyzer, calls } = fakeVision();
      const r = await tool.run(
        { path: 'a.png', question: '验证码是什么？' },
        makeCtx(png(100, 100), analyzer),
      );

      expect(calls[0].question).toBe('验证码是什么？');
      expect(r.data).toMatchObject({ question: '验证码是什么？' });
    });

    it('不写 question 也能用（视觉插件那边会退回通用描述）', async () => {
      const { analyzer, calls } = fakeVision();
      const r = await tool.run({ path: 'a.png' }, makeCtx(png(100, 100), analyzer));

      expect(r.ok).toBe(true);
      expect(calls[0].question).toBeUndefined();
    });
  });

  describe('数据流：图进视觉模型，文字回主模型', () => {
    it('观察走 observations 而不是 data', async () => {
      // 观察必须在 observations 里。放 data 的话，经工具桥调用时它会返回给
      // Python 代码，而模型不会 print 返回值 —— 花过钱的观察会静默消失
      const { analyzer } = fakeVision({ ok: true, observation: '这是一张图表。' });
      const r = await tool.run({ path: 'a.png' }, makeCtx(png(10, 10), analyzer));

      expect(r.ok).toBe(true);
      expect(r.observations).toHaveLength(1);
      expect(r.observations![0]).toContain('这是一张图表。');
      // data 里只有元信息，不含观察正文
      expect(JSON.stringify(r.data)).not.toContain('这是一张图表');
    });

    it('observations 带上来源与问题，多张图之间能对得上', async () => {
      const { analyzer } = fakeVision({ ok: true, observation: '验证码是 8F2K。' });
      const r = await tool.run(
        { path: 'captcha.png', question: '验证码是什么？' },
        makeCtx(png(10, 10), analyzer),
      );

      expect(r.observations![0]).toContain('captcha.png');
      expect(r.observations![0]).toContain('验证码是什么？');
      expect(r.observations![0]).toContain('8F2K');
    });

    it('base64 不进返回值（它只该出现在视觉模型的请求里）', async () => {
      const { analyzer, calls } = fakeVision();
      const r = await tool.run({ path: 'a.png' }, makeCtx(png(10, 10), analyzer));

      const b64 = png(10, 10).toString('base64');
      expect(calls[0].data).toBe(b64);                    // 视觉模型收到了
      expect(JSON.stringify(r.data)).not.toContain(b64);  // 主模型收不到
    });

    it('base64 不含 data: 前缀（前缀由 adapter 拼）', async () => {
      const { analyzer, calls } = fakeVision();
      await tool.run({ path: 'a.png' }, makeCtx(png(10, 10), analyzer));

      expect(calls[0].data).not.toContain('data:');
    });

    it('标注是谁看的 —— 观察是二手信息，出错时要能判断怀疑哪一层', async () => {
      const r = await tool.run({ path: 'a.png' }, makeCtx(png(10, 10)));

      expect(r.data).toMatchObject({ observed_by: 'fake-vision-model' });
    });
  });

  describe('失败路径', () => {
    it('视觉模型失败 → ok:false，原因透传给模型', async () => {
      const { analyzer } = fakeVision({ ok: false, error: '视觉模型调用失败：429' });
      const r = await tool.run({ path: 'a.png' }, makeCtx(png(10, 10), analyzer));

      expect(r.ok).toBe(false);
      expect(r.error).toContain('429');
    });

    it('视觉模型返回空观察 → 判失败，不把空话当结果', async () => {
      const { analyzer } = fakeVision({ ok: true, observation: undefined });
      const r = await tool.run({ path: 'a.png' }, makeCtx(png(10, 10), analyzer));

      expect(r.ok).toBe(false);
    });

    it('读盘失败以 ok:false 返回，不抛异常', async () => {
      const r = await tool.run(
        { path: 'denied.png' },
        makeCtx(new Error('访问被拒绝: 不在沙箱白名单内')),
      );

      expect(r.ok).toBe(false);
      expect(r.error).toContain('访问被拒绝');
    });
  });

  describe('未注入执行器', () => {
    it('fs 缺失 → ok:false 而不是崩溃', async () => {
      const ctx = { ...makeCtx(png(1, 1)), executors: {} } as ToolContext;
      const r = await tool.run({ path: 'a.png' }, ctx);

      expect(r.ok).toBe(false);
      expect(r.error).toContain('未初始化');
    });

    it('vision 缺失 → 说清要配 VISION_MODEL', async () => {
      // 正常情况下未配视觉模型时这个工具根本不会注册，走到这里说明注入漏了
      const ctx = makeCtx(png(1, 1));
      (ctx.executors as { vision?: unknown }).vision = undefined;
      const r = await tool.run({ path: 'a.png' }, ctx);

      expect(r.ok).toBe(false);
      expect(r.error).toContain('VISION_MODEL');
    });
  });
});
