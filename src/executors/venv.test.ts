// ============================================
// 沙箱 venv 的自动准备 —— 四条不能错的性质
// ============================================
//
// ① **venv 在工作区内要拒绝**:放进去的话模型的代码能改 venv 自身,
//    隔离就自己交出去了。宁可明说「没有隔离」,不给一个假的
// ② **幂等**:已存在就不重建,否则每次启动白等几秒
// ③ **失败不抛异常**:回落到基础解释器 + reason。沙箱没隔离仍能干活,
//    CLI 起不来就什么都干不了
// ④ **解释器子路径按平台推导**:写进配置的话换个系统就 ENOENT
// ============================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ensureSandboxVenv, venvInterpreterPath } from './venv.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'baseagent-venv-test-'));
  vi.clearAllMocks();
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

describe('解释器子路径按平台推导', () => {
  it('拼出平台对应的解释器位置', () => {
    const p = venvInterpreterPath('/some/venv');

    if (process.platform === 'win32') {
      expect(p).toBe(path.join('/some/venv', 'Scripts', 'python.exe'));
    } else {
      expect(p).toBe(path.join('/some/venv', 'bin', 'python'));
    }
  });
});

describe('venv 位置校验(工作区内必须拒绝)', () => {
  it('venv 在工作区内时拒绝使用并给出原因', async () => {
    const workspace = path.join(tmpRoot, 'workspace');
    const venvDir = path.join(workspace, '.sandbox-venv');
    await fs.mkdir(workspace, { recursive: true });

    const r = await ensureSandboxVenv({
      venvDir,
      baseInterpreter: 'python',
      workspace,
      logger,
    });

    expect(r.ok).toBe(false);
    // 回落到基础解释器 —— 而不是留一个指向不存在解释器的路径
    expect(r.pythonPath).toBe('python');
    expect(r.reason).toContain('工作区内');
    // 关键:**没有真的去创建**。创建了就等于给了模型可改的 venv
    await expect(fs.access(venvDir)).rejects.toThrow();
  });

  it('venv 就是工作区本身时同样拒绝', async () => {
    const dir = path.join(tmpRoot, 'same');
    await fs.mkdir(dir, { recursive: true });

    const r = await ensureSandboxVenv({
      venvDir: dir,
      baseInterpreter: 'python',
      workspace: dir,
      logger,
    });

    expect(r.ok).toBe(false);
    expect(r.reason).toContain('工作区内');
  });

  it('venv 在工作区**之外**时放行（同名前缀不算在内）', async () => {
    // 'ws' 与 'ws-venv' 前缀相同但不是父子 —— 用字符串 startsWith 判会误伤，
    // 所以实现用 path.relative
    const workspace = path.join(tmpRoot, 'ws');
    const venvDir = path.join(tmpRoot, 'ws-venv');
    await fs.mkdir(workspace, { recursive: true });

    const r = await ensureSandboxVenv({
      venvDir,
      baseInterpreter: 'definitely-not-a-real-python-xyz',
      workspace,
      logger,
    });

    // 位置校验通过了，所以走到了创建那一步（基础解释器不存在 → 创建失败）
    expect(r.reason).not.toContain('工作区内');
    expect(r.reason).toContain('创建失败');
  });
});

describe('创建失败不抛异常', () => {
  it('基础解释器不存在时回落 + 给出手动创建命令', async () => {
    const venvDir = path.join(tmpRoot, 'venv');

    const r = await ensureSandboxVenv({
      venvDir,
      baseInterpreter: 'definitely-not-a-real-python-xyz',
      logger,
    });

    expect(r.ok).toBe(false);
    expect(r.created).toBe(false);
    expect(r.pythonPath).toBe('definitely-not-a-real-python-xyz');
    // 原因里要带可照抄的命令 —— 只说「失败了」用户无从下手
    expect(r.reason).toContain('-m venv --system-site-packages');
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('幂等', () => {
  it('解释器已存在时直接返回，不重建', async () => {
    const venvDir = path.join(tmpRoot, 'existing-venv');
    const interpreter = venvInterpreterPath(venvDir);
    await fs.mkdir(path.dirname(interpreter), { recursive: true });
    await fs.writeFile(interpreter, '#!/fake\n');

    const before = (await fs.stat(interpreter)).mtimeMs;

    const r = await ensureSandboxVenv({
      venvDir,
      // 故意给一个跑不起来的基础解释器：真去创建的话这里会失败
      baseInterpreter: 'definitely-not-a-real-python-xyz',
      logger,
    });

    expect(r.ok).toBe(true);
    expect(r.created).toBe(false);
    expect(r.pythonPath).toBe(interpreter);
    // 文件没被动过
    expect((await fs.stat(interpreter)).mtimeMs).toBe(before);
  });
});

describe('真实创建(需要本机有 python)', () => {
  const hasPython = (() => {
    try {
      // 用同步 spawn 探活，避免 describe 阶段做异步
      const { execSync } = require('child_process');
      execSync('python --version', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!hasPython)('新建 venv 并标记 created', async () => {
    const venvDir = path.join(tmpRoot, 'fresh-venv');

    const r = await ensureSandboxVenv({
      venvDir,
      baseInterpreter: 'python',
      logger,
    });

    expect(r.ok).toBe(true);
    expect(r.created).toBe(true);
    // 返回的解释器必须真的能访问 —— 目录建出来但解释器缺失的话，
    // 后面每次 execute_python 都失败，而错误信息指向的是模型的代码
    await expect(fs.access(r.pythonPath)).resolves.toBeUndefined();
  }, 180_000);

  it.skipIf(!hasPython)('第二次调用变成幂等命中', async () => {
    const venvDir = path.join(tmpRoot, 'twice-venv');

    const first = await ensureSandboxVenv({
      venvDir,
      baseInterpreter: 'python',
      logger,
    });
    const second = await ensureSandboxVenv({
      venvDir,
      baseInterpreter: 'python',
      logger,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.pythonPath).toBe(first.pythonPath);
  }, 180_000);
});
