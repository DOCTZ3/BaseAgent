// ============================================
// 配置加载 —— 三个**实测踩过**的坑
// ============================================
//
// 这批测试盯的都是「不报错、只在运行时表现成模型莫名失败」的那类 bug:
// ① `models.vision` 被 loadConfig 丢掉 —— VISION_MODEL 配了也等于没配,
//    视觉工具不注册、提示里没有视觉段,模型只好自己去装 OCR 库
// ② 新增顶层配置段忘了在 loadConfig 合并 —— 默认值丢失
// ③ PYTHON_PATH 留相对路径 —— 子进程 cwd 是**工作区**,
//    `.sandbox-venv/Scripts/python.exe` 会按工作区解析,spawn 直接 ENOENT
//
// 三个都是同一个失败模式:**逐字段拷贝**。本项目已在这上面栽过多次。
// ============================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

// config.ts 在模块加载时读 process.env（defaultConfig 是模块级常量），
// 所以每个用例要改 env 就必须重新 import —— vi.resetModules + 动态 import
async function freshConfig(env: Record<string, string | undefined>) {
  const { resetModules } = await import('vitest').then(m => ({
    resetModules: () => m.vi.resetModules(),
  }));
  resetModules();

  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  try {
    const mod = await import('./config.js?t=' + Date.now());
    return mod as typeof import('./config.js');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('PYTHON_PATH 解析', () => {
  it('相对路径转成**绝对**路径 —— 子进程 cwd 是工作区,留相对会 spawn ENOENT', async () => {
    const { defaultConfig } = await freshConfig({
      PYTHON_PATH: '.sandbox-venv/Scripts/python.exe',
    });

    expect(path.isAbsolute(defaultConfig.python.pythonPath)).toBe(true);
    // 基准是**项目根目录**(用户在 .env 里写相对路径时心里的基准),不是工作区
    expect(defaultConfig.python.pythonPath).toBe(
      path.resolve('.sandbox-venv/Scripts/python.exe'),
    );
  });

  it('裸名字保持原样 —— 那要交给 PATH 查找,转绝对反而错', async () => {
    const { defaultConfig } = await freshConfig({ PYTHON_PATH: 'python' });
    expect(defaultConfig.python.pythonPath).toBe('python');
  });

  it('未配置时回落到裸 python', async () => {
    const { defaultConfig } = await freshConfig({ PYTHON_PATH: undefined });
    expect(defaultConfig.python.pythonPath).toBe('python');
  });
});

describe('loadConfig 的合并', () => {
  it('配了 VISION_MODEL,models.vision 必须存活到 loadConfig 之后', async () => {
    // 实测事故:loadConfig 重建 models 时只列了 main/fast/reasoning,
    // vision 被静默丢掉 —— 视觉工具不注册,模型只好自己去装 OCR 库
    const { loadConfig } = await freshConfig({
      VISION_MODEL: 'test-vision',
      DEEPSEEK_API_KEY: 'sk-test',
    });

    const c = loadConfig();
    expect(c.models.vision).toBeDefined();
    expect(c.models.vision?.model).toBe('test-vision');
    expect(c.models.vision?.apiKey).toBe('sk-test');
  });

  it('未配 VISION_MODEL 时 models.vision 保持 undefined', async () => {
    const { loadConfig } = await freshConfig({ VISION_MODEL: undefined });
    expect(loadConfig().models.vision).toBeUndefined();
  });

  it('shell 段被合并 —— 漏了会让 overrides 生效但默认值丢失', async () => {
    const { loadConfig, defaultConfig } = await freshConfig({});

    // 只覆盖一个字段,其余必须保留默认
    const c = loadConfig({ shell: { ...defaultConfig.shell, timeout: 999 } });
    expect(c.shell.timeout).toBe(999);
    expect(c.shell.maxStdoutBytes).toBe(defaultConfig.shell.maxStdoutBytes);
  });

  it('python 段的新字段 blockPipInstall 默认为 true', async () => {
    const { loadConfig } = await freshConfig({ BLOCK_PIP_INSTALL: undefined });
    expect(loadConfig().python.blockPipInstall).toBe(true);
  });

  it('BLOCK_PIP_INSTALL=false 能关掉 —— 留一个可对照的开关', async () => {
    const { loadConfig } = await freshConfig({ BLOCK_PIP_INSTALL: 'false' });
    expect(loadConfig().python.blockPipInstall).toBe(false);
  });

  it('SHELL_ENABLED 默认关 —— 它没有机制边界,开之前用户该知道自己在开什么', async () => {
    const { loadConfig } = await freshConfig({ SHELL_ENABLED: undefined });
    expect(loadConfig().shell.enabled).toBe(false);
  });
});

// 沙箱 venv 由框架托管 —— 用户不该为「建目录、按平台写对子路径」负责,
// 那三件事做错都不报错在正确的地方(见 venv.ts 顶部)
describe('沙箱 venv 配置', () => {
  it('默认开启 —— 装包落项目内是默认行为,不是要用户主动开的优化', async () => {
    const { loadConfig } = await freshConfig({ SANDBOX_VENV: undefined });
    expect(loadConfig().python.useVenv).toBe(true);
  });

  it('SANDBOX_VENV=false 能关 —— 留一个可对照的开关', async () => {
    const { loadConfig } = await freshConfig({ SANDBOX_VENV: 'false' });
    expect(loadConfig().python.useVenv).toBe(false);
  });

  it('venvDir 默认在项目根下,且是**绝对**路径', async () => {
    const { loadConfig } = await freshConfig({ SANDBOX_VENV_DIR: undefined });
    const dir = loadConfig().python.venvDir;

    expect(path.isAbsolute(dir)).toBe(true);
    expect(dir).toBe(path.resolve('.sandbox-venv'));
  });

  it('SANDBOX_VENV_DIR 的相对路径按**项目根**解析,不按工作区', async () => {
    // 按工作区解析会踩 PYTHON_PATH 那个坑的同一个形状:
    // 子进程 cwd 是工作区,而用户写相对路径时心里的基准是项目根
    const { loadConfig } = await freshConfig({ SANDBOX_VENV_DIR: 'my-venv' });
    expect(loadConfig().python.venvDir).toBe(path.resolve('my-venv'));
  });

  it('pythonPath 是**基础**解释器,不被 venv 配置改写', async () => {
    // 语义分离:配置里存基础解释器,启动阶段的 ensureSandboxVenv 才决定
    // 真正执行代码的那个。混在一起的话「回落到哪」就没有来源了
    const { loadConfig } = await freshConfig({
      PYTHON_PATH: undefined,
      SANDBOX_VENV: 'true',
    });
    expect(loadConfig().python.pythonPath).toBe('python');
  });
});
