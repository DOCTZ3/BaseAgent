// ============================================
// 多模态(图片输入)单元测试
// ============================================
//
// 覆盖三处新行为：
// 1. 中立格式 → OpenAI 线格式的转换（唯一知道 image_url 结构的地方）
// 2. 图片的 token 估算（每图上限 384，不能按 base64 字符数算）
// 3. base64 在压缩/日志路径里被折成占位标签
// ============================================

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { messageToText, hasImage, type ContentPart } from './llm-client.js';
import { DeepSeekAdapter } from './deepseek-adapter.js';
import { TokenCounter } from './token-counter.js';
import { ConsoleLogger, LogLevel, TraceRecorder } from '../platform/index.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

const IMG: ContentPart = {
  type: 'image',
  data: 'aGVsbG8=',
  mimeType: 'image/png',
  label: 'shot.png',
  width: 1024,
  height: 768,
};

describe('中立格式 → 线格式', () => {
  /**
   * 借失败留痕拿到 wireRequest：onTrace 在失败路径也会触发，
   * 于是不需要真实 API 就能验证发出去的结构。
   */
  async function captureWire(content: string | ContentPart[]) {
    let wire: any;
    const adapter = new DeepSeekAdapter({
      apiKey: 'test',
      baseURL: 'http://127.0.0.1:1',   // 必定连不上
      model: 'deepseek-v4-flash-vision-exp',
      enableThinking: false,
      retry: { maxRetries: 0 },
      onTrace: e => { wire = e.wireRequest; },
      logger,
    });

    await adapter.complete({ messages: [{ role: 'user', content }] }).catch(() => {});
    return wire;
  }

  it('图片转成 image_url + data URL 前缀', async () => {
    const wire = await captureWire([{ type: 'text', text: '这是什么' }, IMG]);

    expect(wire.messages[0].content).toEqual([
      { type: 'text', text: '这是什么' },
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,aGVsbG8=' },
      },
    ]);
  });

  it('detail 透传给服务端', async () => {
    const wire = await captureWire([{ ...IMG, detail: 'low' }]);

    expect(wire.messages[0].content[0].image_url.detail).toBe('low');
  });

  it('纯文本不被包成数组', async () => {
    // 包了会改变 prompt cache 的 key，白丢缓存命中
    const wire = await captureWire('只是文本');

    expect(wire.messages[0].content).toBe('只是文本');
  });

  it('base64 存的是裸数据，前缀由 adapter 拼', async () => {
    const wire = await captureWire([IMG]);

    expect(IMG.type === 'image' && IMG.data).not.toContain('data:');
    expect(wire.messages[0].content[0].image_url.url).toMatch(/^data:image\/png;base64,/);
  });
});

describe('token 估算', () => {
  const counter = new TokenCounter(new ConsoleLogger(LogLevel.ERROR));

  it('单图按上限 384 计，与像素无关', () => {
    // 服务端会缩放，2000×2000 和 5000×5000 消耗相同
    expect(counter.estimateImage()).toBe(384);
    expect(counter.estimateImage('original')).toBe(384);
  });

  it("detail:'low' 更省（先缩到 512×512）", () => {
    expect(counter.estimateImage('low')).toBeLessThan(counter.estimateImage('original'));
  });

  it('不按 base64 字符数算', () => {
    // 一张 1MB 截图的 base64 约 130 万字符。按字符算会让压缩阈值严重高估，
    // 图片却只占 384 token。
    // 对照用 4 万字符（tiktoken 的 wasm 喂 100 万字符会 unreachable 崩溃，
    // 这里只需证明量级差异，不必真的构造完整 base64）
    const sample = 'A'.repeat(40_000);
    const asText = counter.estimate(sample);

    const asImage = counter.estimateMessages([
      { role: 'user', content: [{ type: 'image' }] },
    ]);

    expect(asImage).toBeLessThan(500);
    expect(asText).toBeGreaterThan(asImage * 10);
  });

  it('混合内容分别计入', () => {
    const textOnly = counter.estimateMessages([
      { role: 'user', content: [{ type: 'text', text: '描述这张图' }] },
    ]);
    const withImage = counter.estimateMessages([
      { role: 'user', content: [{ type: 'text', text: '描述这张图' }, { type: 'image' }] },
    ]);

    expect(withImage - textOnly).toBe(384);
  });

  it('纯字符串 content 行为不变', () => {
    expect(counter.estimateMessages([{ role: 'user', content: 'hello' }]))
      .toBe(counter.estimate('hello') + 4);
  });
});

describe('图片在文本路径里折成占位标签', () => {
  it('messageToText 折叠图片并保留来源', () => {
    const text = messageToText([{ type: 'text', text: '看这个' }, IMG]);

    expect(text).toContain('看这个');
    expect(text).toContain('[图片 shot.png 1024x768]');
    expect(text).not.toContain('aGVsbG8=');   // base64 不进摘要
  });

  it('纯字符串原样返回', () => {
    expect(messageToText('普通消息')).toBe('普通消息');
  });

  it('hasImage 正确判别', () => {
    expect(hasImage([IMG])).toBe(true);
    expect(hasImage([{ type: 'text', text: 'x' }])).toBe(false);
    expect(hasImage('文本')).toBe(false);
  });
});

describe('trace 落盘剥离 base64', () => {
  it('data URL 换成占位符，保留 mime 与体积', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseagent-trace-'));
    const recorder = new TraceRecorder({
      sessionId: 's1',
      logger,
      baseDir: dir,
      enabled: true,
    });

    // 2MB 级别的 base64：不剥的话单个 call-NNN.json 就有几 MB，trace 翻不动
    const big = 'B'.repeat(2_000_000);
    recorder.sink({
      callIndex: 1,
      label: 'test',
      model: 'm',
      startedAt: Date.now(),
      durationMs: 1,
      wireRequest: {
        messages: [{
          role: 'user',
          content: [{
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${big}` },
          }],
        }],
      },
    });

    const file = path.join(dir, 's1', 'calls', 'call-001.json');
    const written = fs.readFileSync(file, 'utf-8');

    expect(written).not.toContain(big);
    expect(written).toContain('<stripped');
    expect(written).toContain('data:image/png;base64,');   // 结构仍可读
    expect(fs.statSync(file).size).toBeLessThan(10_000);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('短字符串不受影响', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseagent-trace-'));
    const recorder = new TraceRecorder({
      sessionId: 's2', logger, baseDir: dir, enabled: true,
    });

    recorder.sink({
      callIndex: 1, label: 'test', model: 'm',
      startedAt: Date.now(), durationMs: 1,
      wireRequest: { messages: [{ role: 'user', content: '正常文本' }] },
    });

    const written = fs.readFileSync(
      path.join(dir, 's2', 'calls', 'call-001.json'), 'utf-8'
    );
    expect(written).toContain('正常文本');
    expect(written).not.toContain('<stripped');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
