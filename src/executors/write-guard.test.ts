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
/** 冒充凭证目录:进读黑名单,内含一个「私钥」 */
let secretDir: string;
let secretFile: string;

function makeExecutor(writeGuard = true, readDenyPaths: readonly string[] = []) {
  return new PythonExecutor({
    pythonPath: 'python',
    workDir: workspace,
    timeout: 30_000,
    maxStdoutBytes: 50 * 1024,
    maxStderrBytes: 16 * 1024,
    writeGuard,
    readDenyPaths,
    logger,
  });
}

/** 带读黑名单的执行器(黑名单 = secretDir) */
const guarded = () => makeExecutor(true, [secretDir]);

describe.skipIf(!hasPython)('写边界', () => {
  beforeAll(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-ws-'));
    // 刻意放在 workspace 之外、且不在 temp 根下（temp 是放行的）
    outsideDir = await fs.mkdtemp(path.join(os.homedir(), '.ba-outside-'));
    outsideFile = path.join(outsideDir, 'victim.txt');
    await fs.writeFile(outsideFile, 'original', 'utf-8');

    // 冒充 ~/.ssh：内容要能在断言里认出来，才能验证「没读到」而不只是「没报错」
    secretDir = await fs.mkdtemp(path.join(os.homedir(), '.ba-secret-'));
    secretFile = path.join(secretDir, 'id_rsa');
    await fs.writeFile(secretFile, 'PRIVATE-KEY-CONTENT', 'utf-8');
  });

  afterAll(async () => {
    await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
    await fs.rm(outsideDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(secretDir, { recursive: true, force: true }).catch(() => {});
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

    it('工作区外读取放行（读按黑名单，不在名单里就放行）', async () => {
      const r = await makeExecutor().run(
        `print(open(r"${py(outsideFile)}").read())`
      );
      expect(r.ok).toBe(true);
      expect(r.stdout.trim()).toBe('original');
    });
  });

  // ============================================
  // 读黑名单
  // ============================================
  //
  // 断言重点是**内容没出来**,不只是「报了错」:
  // 这一层要防的后果是凭证进入上下文并发给模型服务商,
  // 所以「拒了但值还在 stdout 里」等于没防住。
  describe('读黑名单', () => {
    it('读名单内文件被拒,且内容不出现在输出里', async () => {
      const r = await guarded().run(
        `print(open(r"${py(secretFile)}").read())`
      );
      expect(r.ok).toBe(false);
      expect(r.stderr).toContain('读取被拒绝');
      expect(r.stdout).not.toContain('PRIVATE-KEY-CONTENT');
      expect(r.stderr).not.toContain('PRIVATE-KEY-CONTENT');
    });

    it('底层 os.open 读同样被拦', async () => {
      const r = await guarded().run(
        `import os\nfd = os.open(r"${py(secretFile)}", os.O_RDONLY)`
      );
      expect(r.ok).toBe(false);
      expect(r.stderr).toContain('读取被拒绝');
    });

    it('bytes 路径也被拦 —— 不转换就是一条静默绕过', async () => {
      // bytes 与 str 做前缀比较永远为假,漏了 fsdecode 这里就会返回内容
      const r = await guarded().run(
        `print(open(rb"${py(secretFile)}").read())`
      );
      expect(r.ok).toBe(false);
      expect(r.stdout).not.toContain('PRIVATE-KEY-CONTENT');
    });

    it('pathlib.Path 也被拦(PathLike 分支)', async () => {
      const r = await guarded().run(
        `from pathlib import Path\nprint(Path(r"${py(secretFile)}").read_text())`
      );
      expect(r.ok).toBe(false);
      expect(r.stdout).not.toContain('PRIVATE-KEY-CONTENT');
    });

    it('列目录被拦 —— 「有哪些凭证文件」本身就是信息', async () => {
      const r = await guarded().run(
        `import os\nprint(os.listdir(r"${py(secretDir)}"))`
      );
      expect(r.ok).toBe(false);
      expect(r.stdout).not.toContain('id_rsa');
    });

    it('往名单内写也被拦(工作区内的 .env 只有这条能拦)', async () => {
      const r = await guarded().run(
        `open(r"${py(secretFile)}", "w").write("x")`
      );
      expect(r.ok).toBe(false);
      expect(await fs.readFile(secretFile, 'utf-8')).toBe('PRIVATE-KEY-CONTENT');
    });

    it('覆盖同名函数无效(闭包,和写边界同一个理由)', async () => {
      const r = await guarded().run(
        `def denied_read(p): return False\n` +
        `def refuse_read(p): pass\n` +
        `print(open(r"${py(secretFile)}").read())`
      );
      expect(r.ok).toBe(false);
      expect(r.stdout).not.toContain('PRIVATE-KEY-CONTENT');
    });

    it('名单外的读不受影响 —— 黑名单不能误伤正常任务', async () => {
      const r = await guarded().run(
        `print(open(r"${py(outsideFile)}").read())`
      );
      expect(r.ok).toBe(true);
      expect(r.stdout.trim()).toBe('original');
    });

    it('import 不被误伤(黑名单开着也一样)', async () => {
      // 读的白名单做不了就是因为这个:一次 import pandas 触发 1183 次 open
      const r = await guarded().run(
        `import json, pandas, requests, bs4\nprint("ok")`
      );
      expect(r.ok).toBe(true);
      expect(r.stdout.trim()).toBe('ok');
    }, 30_000);

    it('错误信息说清为什么不能绕,而不是只说被拒', async () => {
      // 模型看到「被拒」的第一反应是换写法重试。必须告诉它这条不是技术障碍
      const r = await guarded().run(
        `open(r"${py(secretFile)}").read()`
      );
      expect(r.stderr).toContain('凭证');
      expect(r.stderr).toContain('环境变量');
    });

    it('不给黑名单时读什么都放行 —— 默认不改变原行为', async () => {
      const r = await makeExecutor().run(
        `print(open(r"${py(secretFile)}").read())`
      );
      expect(r.ok).toBe(true);
      expect(r.stdout.trim()).toBe('PRIVATE-KEY-CONTENT');
    });

    it('⚠️ 已知缺口:subprocess 换个进程就读得到', async () => {
      // 和写边界同一个洞(audit hook 只管当前进程)。把它测出来,
      // 是为了让「这是护栏不是边界」这句话有对照,而不是停在注释里
      const r = await guarded().run(
        [
          'import sys, subprocess',
          'out = subprocess.run(',
          `    [sys.executable, "-c", "print(open(r'${py(secretFile)}').read())"],`,
          '    capture_output=True, text=True)',
          'print(out.stdout.strip())',
        ].join('\n')
      );
      expect(r.ok).toBe(true);
      expect(r.stdout).toContain('PRIVATE-KEY-CONTENT');
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
