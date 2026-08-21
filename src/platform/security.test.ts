// ============================================
// Platform 层:SecurityGuard 单元测试
// ============================================
//
// 重点覆盖黑名单：浏览器 profile 目录靠它挡住 read_file，
// 而 profile 里的 cookie 等价于活凭证。判定顺序错了这层就失效。
// ============================================

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SecurityGuard } from './security.js';

let root: string;
let profileDir: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'baseagent-sec-'));
  profileDir = path.join(root, '.browser-profile');
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(path.join(root, 'notes.txt'), 'ok', 'utf-8');
  await fs.writeFile(path.join(profileDir, 'Cookies'), 'secret', 'utf-8');
});

describe('SecurityGuard', () => {
  describe('白名单', () => {
    it('允许白名单目录内的路径', () => {
      const guard = new SecurityGuard([root]);
      expect(guard.checkFsAccess(path.join(root, 'notes.txt'))).toBe(true);
    });

    it('允许白名单目录本身', () => {
      const guard = new SecurityGuard([root]);
      expect(guard.checkFsAccess(root)).toBe(true);
    });

    it('拒绝白名单外的路径', () => {
      const guard = new SecurityGuard([root]);
      expect(guard.checkFsAccess(path.join(os.tmpdir(), 'elsewhere.txt'))).toBe(false);
    });

    it('拒绝用 .. 逃逸的路径', () => {
      const guard = new SecurityGuard([root]);
      expect(guard.checkFsAccess(path.join(root, '..', 'escaped.txt'))).toBe(false);
    });

    it('空白名单拒绝一切', () => {
      const guard = new SecurityGuard([]);
      expect(guard.checkFsAccess(path.join(root, 'notes.txt'))).toBe(false);
    });
  });

  describe('黑名单', () => {
    it('拒绝黑名单目录内的文件,即使它在白名单内', () => {
      // 这是核心场景:profile 在沙箱根目录下,但必须读不到
      const guard = new SecurityGuard([root], [profileDir]);
      expect(guard.checkFsAccess(path.join(profileDir, 'Cookies'))).toBe(false);
    });

    it('拒绝黑名单目录本身', () => {
      const guard = new SecurityGuard([root], [profileDir]);
      expect(guard.checkFsAccess(profileDir)).toBe(false);
    });

    it('拒绝黑名单目录的深层子路径', () => {
      const guard = new SecurityGuard([root], [profileDir]);
      expect(
        guard.checkFsAccess(path.join(profileDir, 'Default', 'Local Storage', 'x.log'))
      ).toBe(false);
    });

    it('不影响黑名单之外的同级文件', () => {
      const guard = new SecurityGuard([root], [profileDir]);
      expect(guard.checkFsAccess(path.join(root, 'notes.txt'))).toBe(true);
    });

    it('未配置黑名单时行为不变', () => {
      const guard = new SecurityGuard([root]);
      expect(guard.checkFsAccess(path.join(profileDir, 'Cookies'))).toBe(true);
    });
  });

  describe('assertFsAccess 的错误信息', () => {
    it('黑名单拒绝时说明是受保护目录,而不是「不在白名单内」', () => {
      // 错误会回流给模型,原因说错会让它一直换路径重试
      const guard = new SecurityGuard([root], [profileDir]);
      expect(() => guard.assertFsAccess(path.join(profileDir, 'Cookies')))
        .toThrow(/受保护目录/);
    });

    it('白名单拒绝时列出允许的路径', () => {
      const guard = new SecurityGuard([root]);
      expect(() => guard.assertFsAccess(path.join(os.tmpdir(), 'nope.txt')))
        .toThrow(/不在沙箱白名单内/);
    });

    it('允许的路径不抛错', () => {
      const guard = new SecurityGuard([root], [profileDir]);
      expect(() => guard.assertFsAccess(path.join(root, 'notes.txt'))).not.toThrow();
    });
  });
});
