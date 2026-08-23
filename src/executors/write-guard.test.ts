// ============================================
// 写边界 —— 拦截有效性与不可绕过性
// ============================================
//
// 重点是**绕过测试**：第一版把判定函数放在模块级，模型代码写一行
//   def _inside(p): return True
// 就能整个换掉判定（实测确认可绕过）。改成闭包后才拦得住。
// 所以「模型能不能覆盖守卫」这组用例比「能不能拦住写」更关键。
// ============================================

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

let workspace: string;
let outsideDir: string;
let outsideFile: string;

function makeExecutor(writeGuard = true) {
  return new PythonExecutor({
    pythonPath: 'python',
    workDir: workspace,
    timeout: 30_000,
    maxStdoutBytes: 50 * 1024,
    maxStderrBytes: 16 * 1024,
    writeGuard,
    logger,
  });
}

describe.skipIf(!hasPython)('写边界', () => {
  beforeAll(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-ws-'));
    // 刻意放在 workspace 之外、且不在 temp 根下（temp 是放行的）
    outsideDir = await fs.mkdtemp(path.join(os.homedir(), '.ba-outside-'));
    outsideFile = path.join(outsideDir, 'victim.txt');
    await fs.writeFile(outsideFile, 'original', 'utf-8');
  });

  afterAll(async () => {
    await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
    await fs.rm(outsideDir, { recursive: true, force: true }).catch(() => {});
  });

  const py = (s: string) => s.replace(/\\/g, '\\\\');

  describe('工作区内正常放行', () => {
    it('写文件', async () => {
      const r = await makeExecutor().run(
        `open("inside.txt", "w").write("hi")\nprint("ok")`
      );
      expect(r.ok).toBe(true);
      expect(r.stdout.trim()).toBe('ok');
    });

    it('删除自己写的文件', async () => {
      const r = await makeExecutor().run(
        `import os\n` +
        `open("t.txt","w").write("x")\nos.remove("t.txt")\nprint("ok")`
      );
      expect(r.ok).toBe(true);
    });

    it('建目录', async () => {
      const r = await makeExecutor().run(
        `import os\nos.makedirs("sub/deep", exist_ok=True)\nprint("ok")`
      );
      expect(r.ok).toBe(true);
    });
  });

  describe('import 不被误伤', () => {
    // 这是「只管写不管读」的核心理由：一次 import pandas 触发 1183 次 open
    // 超时给到 30s：import pandas 本身就要几秒（触发上千次 open），
    // vitest 默认 5s 会误报成失败
    it('import 常用库全部成功', async () => {
      const r = await makeExecutor().run(
        `import json, csv, zipfile, base64\n` +
        `import pandas, requests, bs4\nprint("ok")`
      );
      expect(r.ok).toBe(true);
      expect(r.stdout.trim()).toBe('ok');
    }, 30_000);

    it('pandas 落盘到工作区可用', async () => {
      const r = await makeExecutor().run(
        `import pandas as pd\n` +
        `pd.DataFrame({"a":[1,2]}).to_csv("d.csv", index=False)\n` +
        `print(len(pd.read_csv("d.csv")))`
      );
      expect(r.ok).toBe(true);
      expect(r.stdout.trim()).toBe('2');
    }, 30_000);
  });

  describe('工作区外写入被拒', () => {
    it('open(..., "w") 被拒且文件未被改动', async () => {
      const r = await makeExecutor().run(
        `open(r"${py(outsideFile)}", "w").write("HACKED")`
      );
      expect(r.ok).toBe(false);
      expect(r.stderr).toContain('写入被拒绝');
      expect(await fs.readFile(outsideFile, 'utf-8')).toBe('original');
    });

    it('os.remove 被拒且文件仍在', async () => {
      const r = await makeExecutor().run(
        `import os\nos.remove(r"${py(outsideFile)}")`
      );
      expect(r.ok).toBe(false);
      await expect(fs.access(outsideFile)).resolves.toBeUndefined();
    });

    it('追加模式同样被拒', async () => {
      const r = await makeExecutor().run(
        `open(r"${py(outsideFile)}", "a").write("more")`
      );
      expect(r.ok).toBe(false);
      expect(await fs.readFile(outsideFile, 'utf-8')).toBe('original');
    });

    it('底层 os.open 也被拦（不只是内置 open）', async () => {
      const r = await makeExecutor().run(
        `import os\n` +
        `fd = os.open(r"${py(outsideFile)}", os.O_WRONLY | os.O_TRUNC)`
      );
      expect(r.ok).toBe(false);
      expect(await fs.readFile(outsideFile, 'utf-8')).toBe('original');
    });

    it('工作区外读取仍然放行（只管写）', async () => {
      const r = await makeExecutor().run(
        `print(open(r"${py(outsideFile)}").read())`
      );
      expect(r.ok).toBe(true);
      expect(r.stdout.trim()).toBe('original');
    });
  });

  describe('不可绕过', () => {
    it('覆盖同名函数无效（第一版就是这样被绕过的）', async () => {
      const r = await makeExecutor().run(
        `def inside(p): return True\n` +
        `def _inside(p): return True\n` +
        `def deny(op, p): pass\n` +
        `open(r"${py(outsideFile)}", "w").write("HACKED")`
      );
      expect(r.ok).toBe(false);
      expect(await fs.readFile(outsideFile, 'utf-8')).toBe('original');
    });

    it('无法注销 audit hook（PEP 578 不提供 remove）', async () => {
      const r = await makeExecutor().run(
        `import sys\n` +
        `sys.addaudithook = lambda h: None\n` +
        `try:\n` +
        `    del sys.audit\n` +
        `except Exception:\n` +
        `    pass\n` +
        `open(r"${py(outsideFile)}", "w").write("HACKED")`
      );
      expect(r.ok).toBe(false);
      expect(await fs.readFile(outsideFile, 'utf-8')).toBe('original');
    });

    it('shutil 高层封装也走同样的底层事件', async () => {
      const r = await makeExecutor().run(
        `import shutil\n` +
        `open("src.txt","w").write("x")\n` +
        `shutil.copyfile("src.txt", r"${py(path.join(outsideDir, 'copied.txt'))}")`
      );
      expect(r.ok).toBe(false);
      await expect(
        fs.access(path.join(outsideDir, 'copied.txt'))
      ).rejects.toThrow();
    });

    it('拼接构造的路径同样被拦（不是字符串扫描）', async () => {
      // 审计钩子拿到的是解析后的真实路径，怎么拼都一样
      const parts = outsideFile.split(path.sep);
      const joined = parts.map(p => JSON.stringify(p)).join(', ');
      const r = await makeExecutor().run(
        `import os\n` +
        `p = os.sep.join([${joined}])\n` +
        `open(p, "w").write("HACKED")`
      );
      expect(r.ok).toBe(false);
      expect(await fs.readFile(outsideFile, 'utf-8')).toBe('original');
    });
  });

  describe('关闭时行为', () => {
    it('writeGuard:false 时不拦（用于排查，默认不该关）', async () => {
      const target = path.join(outsideDir, 'unguarded.txt');
      const r = await makeExecutor(false).run(
        `open(r"${py(target)}", "w").write("written")\nprint("ok")`
      );
      expect(r.ok).toBe(true);
      expect(await fs.readFile(target, 'utf-8')).toBe('written');
      await fs.rm(target, { force: true });
    });
  });

  describe('错误信息可指导模型改道', () => {
    it('说清工作区在哪、下一步怎么做', async () => {
      const r = await makeExecutor().run(
        `open(r"${py(outsideFile)}", "w").write("x")`
      );
      expect(r.stderr).toContain('写入被拒绝');
      expect(r.stderr).toContain('工作区');
      expect(r.stderr).toContain('相对路径');
    });
  });
});
