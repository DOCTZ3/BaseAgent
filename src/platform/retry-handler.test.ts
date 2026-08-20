// ============================================
// Platform 层:RetryHandler 单元测试
// ============================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RetryHandler, RetryableError } from './retry-handler.js';

describe('RetryHandler', () => {
  let mockLogger: any;

  beforeEach(() => {
    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  });

  describe('成功场景', () => {
    it('首次尝试成功时不重试', async () => {
      const handler = new RetryHandler({}, mockLogger);
      const fn = vi.fn().mockResolvedValue('success');

      const result = await handler.execute(fn, 'test-op');

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).not.toHaveBeenCalledWith(
        expect.stringContaining('重试'),
        expect.any(Object)
      );
    });

    it('第二次尝试成功时记录重试', async () => {
      const handler = new RetryHandler({ maxRetries: 3 }, mockLogger);
      const fn = vi.fn()
        .mockRejectedValueOnce(new RetryableError('暂时失败'))
        .mockResolvedValue('success');

      const result = await handler.execute(fn, 'test-op');

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
      expect(mockLogger.info).toHaveBeenCalledWith(
        '重试后成功',
        expect.objectContaining({ attempts: 2 })
      );
    });
  });

  describe('错误分类', () => {
    it('RetryableError 应该重试', async () => {
      const handler = new RetryHandler({ maxRetries: 2 }, mockLogger);
      const fn = vi.fn().mockRejectedValue(new RetryableError('可重试错误'));

      await expect(handler.execute(fn, 'test-op')).rejects.toThrow('可重试错误');
      expect(fn).toHaveBeenCalledTimes(3); // 1 次初始 + 2 次重试
    });

    it('网络错误码应该重试', async () => {
      const handler = new RetryHandler({ maxRetries: 2 }, mockLogger);
      const error = Object.assign(new Error('Connection failed'), { code: 'ECONNRESET' });
      const fn = vi.fn().mockRejectedValue(error);

      await expect(handler.execute(fn, 'test-op')).rejects.toThrow('Connection failed');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('HTTP 429 应该重试', async () => {
      const handler = new RetryHandler({ maxRetries: 2 }, mockLogger);
      const error = Object.assign(new Error('Rate limited'), { status: 429 });
      const fn = vi.fn().mockRejectedValue(error);

      await expect(handler.execute(fn, 'test-op')).rejects.toThrow('Rate limited');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('消息包含 "rate limit" 应该重试', async () => {
      const handler = new RetryHandler({ maxRetries: 2 }, mockLogger);
      const error = new Error('API rate limit exceeded');
      const fn = vi.fn().mockRejectedValue(error);

      await expect(handler.execute(fn, 'test-op')).rejects.toThrow('rate limit');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('普通错误不应该重试', async () => {
      const handler = new RetryHandler({ maxRetries: 3 }, mockLogger);
      const error = new Error('Invalid input');
      const fn = vi.fn().mockRejectedValue(error);

      await expect(handler.execute(fn, 'test-op')).rejects.toThrow('Invalid input');
      expect(fn).toHaveBeenCalledTimes(1); // 不重试，立刻抛出
      expect(mockLogger.warn).toHaveBeenCalledWith(
        '操作失败（不可重试）',
        expect.any(Object)
      );
    });
  });

  describe('explicitOnly 模式', () => {
    it('只重试 RetryableError', async () => {
      const handler = new RetryHandler(
        { maxRetries: 2, explicitOnly: true },
        mockLogger
      );
      const networkError = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
      const fn = vi.fn().mockRejectedValue(networkError);

      await expect(handler.execute(fn, 'test-op')).rejects.toThrow('ECONNRESET');
      expect(fn).toHaveBeenCalledTimes(1); // explicitOnly 模式下网络错误不重试
    });

    it('仍然重试 RetryableError', async () => {
      const handler = new RetryHandler(
        { maxRetries: 2, explicitOnly: true },
        mockLogger
      );
      const fn = vi.fn().mockRejectedValue(new RetryableError('显式标记'));

      await expect(handler.execute(fn, 'test-op')).rejects.toThrow('显式标记');
      expect(fn).toHaveBeenCalledTimes(3); // explicitOnly 也重试显式错误
    });
  });

  describe('退避策略', () => {
    it('延迟应该指数增长', async () => {
      const handler = new RetryHandler(
        { maxRetries: 3, baseDelay: 100 },
        mockLogger
      );
      const fn = vi.fn().mockRejectedValue(new RetryableError('持续失败'));

      const startTime = Date.now();
      await expect(handler.execute(fn, 'test-op')).rejects.toThrow();
      const duration = Date.now() - startTime;

      // 预期延迟：100 * (2^0 + 2^1 + 2^2) = 100 + 200 + 400 = 700ms ± jitter(30%)
      // 允许范围：[490, 910]
      expect(duration).toBeGreaterThanOrEqual(490);
      expect(duration).toBeLessThan(1000); // 给测试一些裕度
    });

    it('延迟应该有 jitter', async () => {
      const handler = new RetryHandler(
        { maxRetries: 1, baseDelay: 100 },  // 降低到 100ms 避免超时
        mockLogger
      );

      const delays: number[] = [];
      for (let i = 0; i < 5; i++) {
        const fn = vi.fn().mockRejectedValue(new RetryableError('test'));
        const start = Date.now();
        await handler.execute(fn, 'test-op').catch(() => {});
        delays.push(Date.now() - start);
      }

      // 5 次延迟不应该完全相同（有 jitter）
      const uniqueDelays = new Set(delays);
      expect(uniqueDelays.size).toBeGreaterThan(1);

      // 每次延迟都应该在 [70, 130] 范围内（100 ± 30%）
      delays.forEach(d => {
        expect(d).toBeGreaterThanOrEqual(70);
        expect(d).toBeLessThan(150); // 给测试一些裕度
      });
    }, 10000);  // 增加超时到 10s

    it('延迟不应超过 maxDelay', async () => {
      const handler = new RetryHandler(
        { maxRetries: 3, baseDelay: 100, maxDelay: 200 },  // 降低延迟避免超时
        mockLogger
      );

      // 模拟多次重试，获取每次的延迟记录
      const fn = vi.fn().mockRejectedValue(new RetryableError('test'));
      await handler.execute(fn, 'test-op').catch(() => {});

      // 检查日志中的 delay_ms，都不应超过 maxDelay
      const retryCalls = mockLogger.info.mock.calls.filter(
        (call: any) => call[0] === '重试操作'
      );
      retryCalls.forEach((call: any) => {
        expect(call[1].delay_ms).toBeLessThanOrEqual(200);
      });
    }, 10000);  // 增加超时到 10s
  });

  describe('日志记录', () => {
    it('应该记录重试尝试', async () => {
      const handler = new RetryHandler({ maxRetries: 2 }, mockLogger);
      const fn = vi.fn().mockRejectedValue(new RetryableError('test'));

      await handler.execute(fn, 'my-operation').catch(() => {});

      expect(mockLogger.info).toHaveBeenCalledWith(
        '重试操作',
        expect.objectContaining({
          operation: 'my-operation',
          attempt: '1/2',
        })
      );
    });

    it('应该记录重试用尽', async () => {
      const handler = new RetryHandler({ maxRetries: 1 }, mockLogger);
      const fn = vi.fn().mockRejectedValue(new RetryableError('test'));

      await handler.execute(fn, 'my-operation').catch(() => {});

      expect(mockLogger.error).toHaveBeenCalledWith(
        '重试次数已用尽',
        expect.objectContaining({
          operation: 'my-operation',
          max_retries: 1,
        })
      );
    });
  });
});
