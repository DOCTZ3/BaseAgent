// ============================================
// Executors 层:PythonExecutor 单元测试
// ============================================
//
// 需要本机有 python。缺失时整体 skip 而不是失败 ——
// 沙箱依赖是可选功能（PYTHON_ENABLED 默认 false），不该卡住其他人的测试。
// ============================================

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { PythonExecutor } from './python-executor.js';

function pythonAvailable(): boolean {
  try {
    execSync('python --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const hasPython = pythonAvailable();

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

let workDir: string;

function makeExecutor(overrides: Partial<{
  timeout: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  env: Record<string, string>;
  pythonPath: string;
}> = {}) {
  return new PythonExecutor({
    pythonPath: overrides.pythonPath ?? 'python',
    workDir,
    timeout: overrides.timeout ?? 20_000,
    maxStdoutBytes: overrides.maxStdoutBytes ?? 50 * 1024,
    maxStderrBytes: overrides.maxStderrBytes ?? 8 * 1024,
    env: overrides.env,
    logger: mockLogger,
  });
}

describe.skipIf(!hasPython)('PythonExecutor', () => {
  beforeAll(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'baseagent-pytest-'));
  });

  describe('基础执行', () => {
    it('返回 stdout 并标记成功', async () => {
      const r = await makeExecutor().run('print(1 + 1)');

      expect(r.ok).toBe(true);
      expect(r.stdout.trim()).toBe('2');
      expect(r.exitCode).toBe(0);
      expect(r.timedOut).toBe(false);
      expect(r.stdoutTruncated).toBe(false);
    });

    it('中文输出不乱码', async () => {
      // Windows 默认 cp936，不设 PYTHONIOENCODING 这里会抛 UnicodeEncodeError
      const r = await makeExecutor().run('print("正文内容：标题")');

      expect(r.ok).toBe(true);
      expect(r.stdout.trim()).toBe('正文内容：标题');
    });

    it('语法/运行时错误以 ok:false + stderr 返回,不抛异常', async () => {
      const r = await makeExecutor().run('raise ValueError("boom")');

      expect(r.ok).toBe(false);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('ValueError');
      expect(r.stderr).toContain('boom');
    });

    it('python 不存在时以 ok:false 返回而不是崩溃', async () => {
      const r = await makeExecutor({ pythonPath: 'python-does-not-exist-xyz' })
        .run('print(1)');

      expect(r.ok).toBe(false);
      expect(r.exitCode).toBeNull();
      expect(r.stderr.length).toBeGreaterThan(0);
    });
  });

  describe('stdout 上限', () => {
    it('超限时判失败并记账真实体积', async () => {
      // 模拟 print(page.content()):一次打印远超上限的内容
      const r = await makeExecutor({ maxStdoutBytes: 1024 })
        .run('print("x" * 50000)');

      expect(r.stdoutTruncated).toBe(true);
      expect(r.ok).toBe(false);                       // 截断即失败,不静默
      expect(r.stdoutBytes).toBeGreaterThan(49_000);  // 记账用的是截断前的量
      expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(1024);
    });

    it('恰好不超限时正常成功', async () => {
      const r = await makeExecutor({ maxStdoutBytes: 1024 })
        .run('print("y" * 100)');

      expect(r.ok).toBe(true);
      expect(r.stdoutTruncated).toBe(false);
      expect(r.stdout.trim()).toHaveLength(100);
    });

    it('超限后子进程仍能正常退出(不因管道写满卡死)', async () => {
      // 边读边丢是必须的:只要停止消费 stdout,子进程写满管道就会阻塞
      const r = await makeExecutor({ maxStdoutBytes: 512, timeout: 15_000 })
        .run('for i in range(20000): print("line", i)');

      expect(r.timedOut).toBe(false);
      expect(r.exitCode).toBe(0);       // 进程自己跑完了
      expect(r.stdoutTruncated).toBe(true);
      expect(r.ok).toBe(false);
    });
  });

  describe('超时', () => {
    it('超时被杀并标记 timedOut', async () => {
      const r = await makeExecutor({ timeout: 1000 })
        .run('import time\ntime.sleep(30)');

      expect(r.timedOut).toBe(true);
      expect(r.ok).toBe(false);
      expect(r.durationMs).toBeLessThan(10_000);
    }, 20_000);

    it('单次 options.timeout 可覆盖默认值', async () => {
      const r = await makeExecutor({ timeout: 30_000 })
        .run('import time\ntime.sleep(30)', { timeout: 1000 });

      expect(r.timedOut).toBe(true);
    }, 20_000);
  });

  describe('环境变量注入', () => {
    it('构造时的 env 可被代码读到', async () => {
      // 模型代码里 os.environ["BROWSER_PROFILE_DIR"] 依赖这条
      const r = await makeExecutor({ env: { BROWSER_PROFILE_DIR: '/tmp/profile-x' } })
        .run('import os\nprint(os.environ["BROWSER_PROFILE_DIR"])');

      expect(r.ok).toBe(true);
      expect(r.stdout.trim()).toBe('/tmp/profile-x');
    });

    it('单次 options.env 覆盖同名键', async () => {
      const r = await makeExecutor({ env: { FOO: 'base' } })
        .run('import os\nprint(os.environ["FOO"])', { env: { FOO: 'override' } });

      expect(r.stdout.trim()).toBe('override');
    });

    it('不继承父进程的 API key', async () => {
      // 全量继承 process.env 会让模型 print 出 key 并跟着 trace 落盘
      process.env.DEEPSEEK_API_KEY = 'sk-should-not-leak';

      const r = await makeExecutor().run(
        'import os\nprint(os.environ.get("DEEPSEEK_API_KEY", "ABSENT"))'
      );

      expect(r.stdout.trim()).toBe('ABSENT');
      expect(r.stdout).not.toContain('sk-should-not-leak');
    });

    it('仍继承 PATH 一类运行必需项', async () => {
      // 收紧不能收到跑不起来:PATH 缺了连解释器的动态库都找不到
      const r = await makeExecutor().run(
        'import os\nprint(bool(os.environ.get("PATH") or os.environ.get("Path")))'
      );

      expect(r.ok).toBe(true);
      expect(r.stdout.trim()).toBe('True');
    });

    it('inheritEnv 可显式指定继承哪些键', async () => {
      process.env.BASEAGENT_PROBE = 'visible';

      const r = await makeExecutor({} as never)
        .run('import os\nprint(os.environ.get("BASEAGENT_PROBE", "ABSENT"))');
      expect(r.stdout.trim()).toBe('ABSENT');

      const allowed = new PythonExecutor({
        pythonPath: 'python',
        workDir,
        timeout: 20_000,
        maxStdoutBytes: 50 * 1024,
        maxStderrBytes: 8 * 1024,
        inheritEnv: ['PATH', 'Path', 'SystemRoot', 'BASEAGENT_PROBE'],
        logger: mockLogger,
      });
      const r2 = await allowed.run(
        'import os\nprint(os.environ.get("BASEAGENT_PROBE", "ABSENT"))'
      );
      expect(r2.stdout.trim()).toBe('visible');
    });
  });

  describe('工作目录', () => {
    it('相对路径落在 workDir 内', async () => {
      const r = await makeExecutor().run(
        'open("probe.txt", "w").write("hi")\nprint("written")'
      );

      expect(r.ok).toBe(true);
      const written = await fs.readFile(path.join(workDir, 'probe.txt'), 'utf-8');
      expect(written).toBe('hi');
    });
  });

  describe('临时脚本清理', () => {
    it('执行后不残留 .py 临时文件', async () => {
      const before = (await fs.readdir(os.tmpdir()))
        .filter(f => f.startsWith('baseagent-') && f.endsWith('.py'));

      await makeExecutor().run('print("cleanup")');

      const after = (await fs.readdir(os.tmpdir()))
        .filter(f => f.startsWith('baseagent-') && f.endsWith('.py'));

      expect(after.length).toBeLessThanOrEqual(before.length);
    });
  });
});
