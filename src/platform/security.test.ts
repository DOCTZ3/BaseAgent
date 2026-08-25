// ============================================
// Platform 层:SecurityGuard 单元测试
// ============================================
//
// 覆盖三档判定（「授权才有权限」）：
//   deny 列表 > 授权路径（ro/rw）> 其余一律拒绝
//
// 两处重点：
// - **未授权连读都拒**。这是刻意的：能读任意文件是 prompt 注入的主要入口，
//   而外发那条路在本地形态下拦不住，只能在入口侧收紧
// - **读写必须分开判**。归档目录要让模型读（压缩后回溯早期对话），
//   但绝不能让它写 —— 否则模型可以覆盖自己的归档
// ============================================

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SecurityGuard } from './security.js';

let root: string;
let profileDir: string;
let archiveDir: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'baseagent-sec-'));
  profileDir = path.join(root, '.browser-profile');
  archiveDir = path.join(root, 'traces');
  await fs.mkdir(profileDir, { recursive: true });
  await fs.mkdir(archiveDir, { recursive: true });
  await fs.writeFile(path.join(root, 'notes.txt'), 'ok', 'utf-8');
  await fs.writeFile(path.join(profileDir, 'Cookies'), 'secret', 'utf-8');
  await fs.writeFile(path.join(archiveDir, 'turn-001.json'), '{}', 'utf-8');
});

describe('SecurityGuard', () => {
  describe('rw 授权', () => {
    it('读写都放行', () => {
      const guard = new SecurityGuard([{ path: root, mode: 'rw' }]);
      const f = path.join(root, 'notes.txt');
      expect(guard.checkFsAccess(f, 'read')).toBe(true);
      expect(guard.checkFsAccess(f, 'write')).toBe(true);
    });

    it('授权目录本身也算在内', () => {
      const guard = new SecurityGuard([{ path: root, mode: 'rw' }]);
      expect(guard.checkFsAccess(root, 'read')).toBe(true);
    });

    it('裸字符串按 rw 处理（兼容旧的 fsSandboxPaths 形态）', () => {
      const guard = new SecurityGuard([root]);
      expect(guard.checkFsAccess(path.join(root, 'notes.txt'), 'write')).toBe(true);
    });
  });

  describe('ro 授权', () => {
    it('可读', () => {
      const guard = new SecurityGuard([{ path: archiveDir, mode: 'ro' }]);
      expect(guard.checkFsAccess(path.join(archiveDir, 'turn-001.json'), 'read'))
        .toBe(true);
    });

    it('不可写 —— 模型不能覆盖自己的归档', () => {
      const guard = new SecurityGuard([{ path: archiveDir, mode: 'ro' }]);
      expect(guard.checkFsAccess(path.join(archiveDir, 'turn-001.json'), 'write'))
        .toBe(false);
    });

    it('拒绝写入时说明是「只读授权」，而非「不在范围内」', () => {
      // 原因说错会让模型一直换路径重试，而问题其实是权限档位
      const guard = new SecurityGuard([{ path: archiveDir, mode: 'ro' }]);
      expect(() => guard.assertFsAccess(path.join(archiveDir, 'x.json'), 'write'))
        .toThrow(/只读授权/);
    });
  });

  describe('未授权：读和写都拒绝', () => {
    it('未授权路径读被拒', () => {
      const guard = new SecurityGuard([{ path: root, mode: 'rw' }]);
      expect(guard.checkFsAccess(path.join(os.tmpdir(), 'elsewhere.txt'), 'read'))
        .toBe(false);
    });

    it('.. 逃逸被拒', () => {
      const guard = new SecurityGuard([{ path: root, mode: 'rw' }]);
      expect(guard.checkFsAccess(path.join(root, '..', 'escaped.txt'), 'read'))
        .toBe(false);
    });

    it('空授权列表拒绝一切', () => {
      const guard = new SecurityGuard([]);
      expect(guard.checkFsAccess(path.join(root, 'notes.txt'), 'read')).toBe(false);
    });

    it('错误信息列出可读写与只读两类范围', () => {
      const guard = new SecurityGuard([
        { path: root, mode: 'rw' },
        { path: archiveDir, mode: 'ro' },
      ]);
      let msg = '';
      try {
        guard.assertFsAccess(path.join(os.tmpdir(), 'nope.txt'), 'read');
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toContain('可读写');
      expect(msg).toContain('只读');
      expect(msg).toContain('请用户授权');
    });
  });

  describe('嵌套授权：更具体的那条优先', () => {
    it('rw 目录内的 ro 子目录不被外层淹掉', () => {
      // traces 在工作区内部，但必须只读
      const guard = new SecurityGuard([
        { path: root, mode: 'rw' },
        { path: archiveDir, mode: 'ro' },
      ]);
      expect(guard.checkFsAccess(path.join(archiveDir, 'turn-001.json'), 'write'))
        .toBe(false);
      expect(guard.checkFsAccess(path.join(root, 'notes.txt'), 'write'))
        .toBe(true);
    });

    it('声明顺序不影响结果（内部按路径长度排序）', () => {
      const guard = new SecurityGuard([
        { path: archiveDir, mode: 'ro' },
        { path: root, mode: 'rw' },
      ]);
      expect(guard.checkFsAccess(path.join(archiveDir, 'x'), 'write')).toBe(false);
    });
  });

  describe('deny 列表优先于一切', () => {
    it('即使在 rw 授权内也拒绝', () => {
      // profile 里的 cookie 等价于活凭证
      const guard = new SecurityGuard([{ path: root, mode: 'rw' }], [profileDir]);
      expect(guard.checkFsAccess(path.join(profileDir, 'Cookies'), 'read'))
        .toBe(false);
    });

    it('目录本身与深层子路径都拒绝', () => {
      const guard = new SecurityGuard([{ path: root, mode: 'rw' }], [profileDir]);
      expect(guard.checkFsAccess(profileDir, 'read')).toBe(false);
      expect(
        guard.checkFsAccess(
          path.join(profileDir, 'Default', 'Local Storage', 'x.log'), 'read')
      ).toBe(false);
    });

    it('不影响同级其他文件', () => {
      const guard = new SecurityGuard([{ path: root, mode: 'rw' }], [profileDir]);
      expect(guard.checkFsAccess(path.join(root, 'notes.txt'), 'read')).toBe(true);
    });

    it('拒绝原因说明是受保护目录', () => {
      const guard = new SecurityGuard([{ path: root, mode: 'rw' }], [profileDir]);
      expect(() => guard.assertFsAccess(path.join(profileDir, 'Cookies'), 'read'))
        .toThrow(/受保护目录/);
    });
  });

  describe('listGrants', () => {
    it('返回授权快照，供启动横幅与 Python 侧同源使用', () => {
      const guard = new SecurityGuard([
        { path: root, mode: 'rw' },
        { path: archiveDir, mode: 'ro' },
      ]);
      const grants = guard.listGrants();
      expect(grants).toHaveLength(2);
      expect(grants.map(g => g.mode).sort()).toEqual(['ro', 'rw']);
    });
  });

  // ============================================
  // 相对路径的解析基准
  // ============================================
  //
  // 回归：基准原本是 process.cwd()（项目目录），而 Python 子进程的 cwd 是工作区。
  // 于是模型在代码里写 read_file("a.txt")、文件确实在工作区里
  // （os.path.exists 为 True），经工具桥回到 TS 却按项目目录解析 —— 实测被拒。
  // 更糟的一侧是「检查路径 A、读取路径 B」：若项目目录下恰好有同名文件，
  // 检查通过之后读到的是未授权的那一个。
  describe('相对路径基准', () => {
    it('按 baseDir（工作区）解析，不按 process.cwd()', () => {
      const guard = new SecurityGuard([{ path: root, mode: 'rw' }], [], root);

      // 裸文件名：只有按工作区解析才落在授权范围内
      expect(guard.checkFsAccess('notes.txt', 'read')).toBe(true);
      expect(guard.checkFsAccess('./notes.txt', 'read')).toBe(true);
    });

    it('不给 baseDir 时退回 process.cwd()（旧行为，兼容既有调用点）', () => {
      const guard = new SecurityGuard([{ path: root, mode: 'rw' }]);
      // 工作区不是 cwd，所以裸文件名解析到 cwd 下、落在授权外
      expect(guard.checkFsAccess('notes.txt', 'read')).toBe(false);
    });

    it('相对路径逃逸出工作区仍被拒', () => {
      const guard = new SecurityGuard([{ path: root, mode: 'rw' }], [], root);
      expect(guard.checkFsAccess('../outside.txt', 'read')).toBe(false);
      expect(guard.checkFsAccess('../../etc/passwd', 'read')).toBe(false);
    });

    it('相对路径同样受 deny 列表约束', () => {
      const guard = new SecurityGuard([{ path: root, mode: 'rw' }], [profileDir], root);
      expect(guard.checkFsAccess('.browser-profile/Cookies', 'read')).toBe(false);
    });

    it('assertFsAccess 返回检查时用的绝对路径，供调用方做实际 IO', () => {
      // FsDriver 必须用这个返回值去读写：用入参会变成「检查 A、读取 B」
      const guard = new SecurityGuard([{ path: root, mode: 'rw' }], [], root);
      const resolved = guard.assertFsAccess('notes.txt', 'read');

      expect(path.isAbsolute(resolved)).toBe(true);
      // realpathSync 会解析符号链接（macOS 的 /var → /private/var），故比对 realpath
      expect(resolved).toBe(fsSync.realpathSync(path.join(root, 'notes.txt')));
    });
  });
});
