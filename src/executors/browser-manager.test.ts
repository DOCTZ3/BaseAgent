// ============================================
// BrowserManager —— 常驻浏览器的生命周期
// ============================================
//
// 重点是**清理**，而不是「能不能启动」。实测过的三条硬事实：
// - chromium 直接启动后能脱离启动方存活（常驻方案的前提）
// - CDP 的 /json/close 只关标签页，浏览器进程照旧活着 → 必须按 PID 强杀
// - 进程没死时 profile 目录完全删不掉（几百个文件 EBUSY）→ 孤儿会让下次启动失败
//
// 所以「stop 之后端口真的释放了」和「残留能被自动清理」是这批用例的核心。
// 需要本机装了 chromium，缺失时整体 skip。
// ============================================

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BrowserManager } from './browser-manager.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** 复用 BrowserManager 的查找逻辑判断本机有没有 chromium */
function chromiumAvailable(): boolean {
  const home = os.homedir();
  const roots = [
    path.join(home, 'AppData', 'Local', 'ms-playwright'),
    path.join(home, '.cache', 'ms-playwright'),
    path.join(home, 'Library', 'Caches', 'ms-playwright'),
  ];
  for (const root of roots) {
    if (!fsSync.existsSync(root)) continue;
    const dirs = fsSync.readdirSync(root).filter(d => d.startsWith('chromium-'));
    if (dirs.length > 0) return true;
  }
  return false;
}

const hasChromium = chromiumAvailable();
const created: BrowserManager[] = [];
let profileRoot: string;

function makeManager(profileName: string) {
  const m = new BrowserManager({
    profileDir: path.join(profileRoot, profileName),
    headless: true,          // 测试里用无头，避免弹一堆窗口
    startupTimeout: 30_000,
    logger,
  });
  created.push(m);
  return m;
}

async function cdpReachable(url: string): Promise<boolean> {
  if (!url) return false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`${url}/json/version`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  profileRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-cdp-'));
});

afterEach(async () => {
  // 每个用例后确保没有遗留实例 —— 否则后续用例会因 profile 被锁而失败
  for (const m of created) await m.stop().catch(() => {});
  created.length = 0;
});

describe.skipIf(!hasChromium)('BrowserManager', () => {
  describe('启动与连接', () => {
    it('启动后 CDP 可达', async () => {
      const m = makeManager('p1');
      const ok = await m.start();

      expect(ok).toBe(true);
      expect(m.isRunning).toBe(true);
      expect(m.cdpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(await cdpReachable(m.cdpUrl)).toBe(true);
    }, 60_000);

    it('未启动时 cdpUrl 为空串（模型代码会拿到连接失败并改道）', () => {
      const m = makeManager('p-unused');
      expect(m.cdpUrl).toBe('');
      expect(m.isRunning).toBe(false);
    });

    it('端口不写死 —— 两个实例可并存', async () => {
      // 写死 9222 会和用户自己开的 Chrome 调试撞车
      const a = makeManager('p2a');
      const b = makeManager('p2b');
      await a.start();
      await b.start();

      expect(a.cdpUrl).not.toBe(b.cdpUrl);
      expect(await cdpReachable(a.cdpUrl)).toBe(true);
      expect(await cdpReachable(b.cdpUrl)).toBe(true);
    }, 90_000);

    it('重复 start 幂等，不会起第二个', async () => {
      const m = makeManager('p3');
      await m.start();
      const first = m.cdpUrl;
      await m.start();

      expect(m.cdpUrl).toBe(first);
    }, 60_000);
  });

  describe('清理', () => {
    it('stop 之后端口真的释放', async () => {
      // 只发 CDP 的 /json/close 是不够的：实测那样浏览器进程还活着
      const m = makeManager('p4');
      await m.start();
      const url = m.cdpUrl;
      expect(await cdpReachable(url)).toBe(true);

      await m.stop();
      await new Promise(r => setTimeout(r, 1500));

      expect(m.isRunning).toBe(false);
      expect(await cdpReachable(url)).toBe(false);
    }, 60_000);

    it('stop 之后 profile 目录可删除', async () => {
      // 进程没死时 profile 里几百个文件全是 EBUSY，
      // 这个断言实际是在验「进程真的没了」
      const m = makeManager('p5');
      await m.start();
      await m.stop();
      await new Promise(r => setTimeout(r, 1500));

      const dir = path.join(profileRoot, 'p5');
      await expect(fs.rm(dir, { recursive: true, force: true })).resolves.toBeUndefined();
      expect(fsSync.existsSync(dir)).toBe(false);
    }, 60_000);

    it('未启动时 stop 是空操作', async () => {
      const m = makeManager('p6');
      await expect(m.stop()).resolves.toBeUndefined();
    });

    it('lock 文件在 stop 后被清掉', async () => {
      const m = makeManager('p7');
      await m.start();
      const lock = path.join(profileRoot, 'p7', '.cdp-lock.json');
      expect(fsSync.existsSync(lock)).toBe(true);

      await m.stop();
      expect(fsSync.existsSync(lock)).toBe(false);
    }, 60_000);
  });

  describe('残留清理（Ctrl+C / 崩溃后的孤儿）', () => {
    it('启动前自动清理上次遗留的实例', async () => {
      // 场景：进程崩溃或被强退，finally 没跑到，chromium 成了孤儿并锁着 profile。
      // 不清理的话下次启动必然失败
      const first = makeManager('p8');
      await first.start();
      const staleUrl = first.cdpUrl;

      // 模拟「进程还在但框架状态丢了」：绕过 stop，直接丢掉引用
      (first as unknown as { started: boolean }).started = false;
      created.length = 0;
      expect(await cdpReachable(staleUrl)).toBe(true);

      // 同一 profile 再启动：应先杀掉孤儿
      const second = makeManager('p8');
      const ok = await second.start();

      expect(ok).toBe(true);
      expect(await cdpReachable(staleUrl)).toBe(false);   // 旧实例已被清掉
      expect(await cdpReachable(second.cdpUrl)).toBe(true);
    }, 120_000);
  });

  describe('判活与重启', () => {
    it('isAlive 反映真实状态', async () => {
      const m = makeManager('p9');
      expect(await m.isAlive()).toBe(false);

      await m.start();
      expect(await m.isAlive()).toBe(true);

      await m.stop();
      expect(await m.isAlive()).toBe(false);
    }, 60_000);

    it('浏览器被外部杀掉后 ensureAlive 会重启', async () => {
      // 用户可能手动关掉窗口，或它自己崩了 ——
      // 此时该重启，而不是让模型对着死端口反复失败
      const m = makeManager('p10');
      await m.start();
      const oldUrl = m.cdpUrl;

      // 绕过 stop 强杀，模拟外部关闭
      (m as unknown as { killByPort(p: number): void })
        .killByPort(parseInt(oldUrl.split(':').pop()!, 10));
      await new Promise(r => setTimeout(r, 1500));
      expect(await m.isAlive()).toBe(false);

      const ok = await m.ensureAlive();
      expect(ok).toBe(true);
      expect(await cdpReachable(m.cdpUrl)).toBe(true);
    }, 120_000);
  });
});
