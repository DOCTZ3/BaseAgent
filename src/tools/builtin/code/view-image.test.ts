// ============================================
// view_image 单元测试
// ============================================
//
// 重点：格式按文件内容判断、尺寸解析、超限拦截。
// 这三件事错了都会在服务端变成 400，而错误信息对模型毫无指导性，
// 所以必须在工具里提前拦住并给出可执行建议。
// ============================================

import { describe, it, expect, vi } from 'vitest';
import { ViewImageTool } from './view-image.js';
import type { ToolContext } from '../../contract.js';

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

function makeCtx(bytes: Buffer | Error): ToolContext {
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
    },
  } as unknown as ToolContext;
}

const tool = new ViewImageTool();

describe('ViewImageTool', () => {
  describe('格式识别（按内容，非扩展名）', () => {
    it('识别 PNG 并解析尺寸', async () => {
      const r = await tool.run({ path: 'a.png' }, makeCtx(png(1024, 768)));

      expect(r.ok).toBe(true);
      expect(r.attachments).toHaveLength(1);
      expect(r.attachments![0].mimeType).toBe('image/png');
      expect(r.attachments![0].width).toBe(1024);
      expect(r.attachments![0].height).toBe(768);
    });

    it('识别 JPEG 并解析尺寸', async () => {
      const r = await tool.run({ path: 'a.jpg' }, makeCtx(jpeg(800, 600)));

      expect(r.ok).toBe(true);
      expect(r.attachments![0].mimeType).toBe('image/jpeg');
      expect(r.attachments![0].width).toBe(800);
      expect(r.attachments![0].height).toBe(600);
    });

    it('识别 GIF 并解析尺寸', async () => {
      const r = await tool.run({ path: 'a.gif' }, makeCtx(gif(320, 240)));

      expect(r.ok).toBe(true);
      expect(r.attachments![0].mimeType).toBe('image/gif');
      expect(r.attachments![0].width).toBe(320);
    });

    it('识别 WebP', async () => {
      const r = await tool.run({ path: 'a.webp' }, makeCtx(webp()));

      expect(r.ok).toBe(true);
      expect(r.attachments![0].mimeType).toBe('image/webp');
    });

    it('扩展名对但内容不是图片 → 拒绝并给转换建议', async () => {
      // 服务端按内容判格式，扩展名骗不过去，提前拦住比拿 400 有用
      const notImage = Buffer.from('BM this is actually a bmp or text', 'ascii');
      const r = await tool.run({ path: 'fake.png' }, makeCtx(notImage));

      expect(r.ok).toBe(false);
      expect(r.error).toContain('无法识别图片格式');
      expect(r.error).toContain('PIL');       // 给出可执行的转换路径
    });

    it('空文件 → 明确报错', async () => {
      const r = await tool.run({ path: 'empty.png' }, makeCtx(Buffer.alloc(0)));

      expect(r.ok).toBe(false);
      expect(r.error).toContain('文件为空');
    });
  });

  describe('配额拦截', () => {
    it('单边超 8192px → 拒绝并给缩放建议', async () => {
      const r = await tool.run({ path: 'huge.png' }, makeCtx(png(9000, 100)));

      expect(r.ok).toBe(false);
      expect(r.error).toContain('9000x100');
      expect(r.error).toContain('thumbnail');   // 可直接照抄的修复代码
    });

    it('恰好 8192px 放行', async () => {
      const r = await tool.run({ path: 'edge.png' }, makeCtx(png(8192, 8192)));

      expect(r.ok).toBe(true);
    });
  });

  describe('detail 默认值', () => {
    it('默认 low（省 token）', async () => {
      const r = await tool.run({ path: 'a.png' }, makeCtx(png(100, 100)));

      expect(r.attachments![0].detail).toBe('low');
    });

    it('可显式要 original', async () => {
      const r = await tool.run(
        { path: 'a.png', detail: 'original' },
        makeCtx(png(100, 100)),
      );

      expect(r.attachments![0].detail).toBe('original');
    });
  });

  describe('返回结构', () => {
    it('图片本体走 attachments，data 里只放元信息', async () => {
      // tool 消息的 content 只接受字符串，base64 必须走 attachments
      const r = await tool.run({ path: 'a.png' }, makeCtx(png(10, 10)));

      expect(JSON.stringify(r.data)).not.toContain(r.attachments![0].data);
      expect(r.data).toMatchObject({ path: 'a.png', format: 'image/png' });
    });

    it('base64 不含 data: 前缀（前缀由 adapter 拼）', async () => {
      const r = await tool.run({ path: 'a.png' }, makeCtx(png(10, 10)));

      expect(r.attachments![0].data).not.toContain('data:');
      expect(r.attachments![0].data).toBe(png(10, 10).toString('base64'));
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

  describe('未初始化执行器', () => {
    it('返回 ok:false 而不是崩溃', async () => {
      const ctx = { ...makeCtx(png(1, 1)), executors: {} } as ToolContext;
      const r = await tool.run({ path: 'a.png' }, ctx);

      expect(r.ok).toBe(false);
      expect(r.error).toContain('未初始化');
    });
  });
});
