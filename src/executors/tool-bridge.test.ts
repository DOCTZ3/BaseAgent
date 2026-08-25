// ============================================
// 工具桥 —— 白名单、图片分桶、参数下发
// ============================================
//
// 三组重点:
// ① 白名单:token 经环境变量下发、模型代码读得到,所以 token 不是对模型的边界,
//    白名单才是。未暴露的工具必须拒掉
// ② 图片分桶:代码调 screenshot 时框架会**嵌套**再起一个 Python 进程,
//    共用一个桶会让内层结束时把外层攒的图片一并取走
// ③ 参数:None 不下发,否则会覆盖 TS 侧 Zod 的 optional 默认值
// ============================================

import { describe, it, expect, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ToolBridge, type BridgeToolSpec, type BridgeToolResult } from './tool-bridge.js';
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

// 参数形状照 zodToJsonSchema 的产物写:签名是从这里推导的
const SHOT: BridgeToolSpec = {
  name: 'screenshot',
  description: '截取当前页面',
  parameters: {
    type: 'object',
    properties: { full_page: { type: 'boolean' }, selector: { type: 'string' } },
  },
};

const VIEW: BridgeToolSpec = {
  name: 'view_image',
  description: '读一张图片',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, detail: { type: 'string' } },
    required: ['path'],
  },
};

/** 构造一段观察文字。形如工具产出的「【来源｜问：…】\n正文」 */
const obs = (text: string) => `【screenshot】\n${text}`;

let bridge: ToolBridge | undefined;

afterEach(async () => {
  await bridge?.stop();
  bridge = undefined;
});

/** 起一个桥,并给出直接打它 HTTP 接口的辅助函数(模拟 Python 侧) */
async function start(
  tools: BridgeToolSpec[],
  invoke: (name: string, args: Record<string, unknown>) => Promise<BridgeToolResult>,
) {
  const b = new ToolBridge({ tools, invoke, logger });
  bridge = b;
  expect(await b.start()).toBe(true);

  const { BASEAGENT_BRIDGE_URL: url, BASEAGENT_BRIDGE_TOKEN: token } = b.env;

  const call = async (
    body: unknown,
    headers: Record<string, string> = { 'X-BaseAgent-Token': token },
  ) =>
    fetch(`${url}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  const invokeTool = async (name: string, args: unknown, runId = 'run-1') => {
    const res = await call({ name, args, run_id: runId });
    expect(res.status).toBe(200);
    return res.json() as Promise<Record<string, unknown>>;
  };

  return { bridge: b, url, token, call, invokeTool };
}

describe('工具桥', () => {
  describe('白名单', () => {
    it('拒绝未暴露的工具,并列出可用的', async () => {
      const invoke = vi.fn();
      const { invokeTool } = await start([SHOT], invoke);

      const result = await invokeTool('write_file', { path: 'x', content: 'y' });

      expect(result.ok).toBe(false);
      expect(result.error).toContain('write_file');
      expect(result.error).toContain('screenshot');
      // 关键:根本没有派发到 runner
      expect(invoke).not.toHaveBeenCalled();
    });

    it('没有可暴露的工具时不启动 —— 空桥只会白占一个端口', async () => {
      const b = new ToolBridge({ tools: [], invoke: vi.fn(), logger });
      expect(await b.start()).toBe(false);
      expect(b.isRunning).toBe(false);
      expect(b.env).toEqual({});
    });
  });

  describe('token', () => {
    it('token 不对直接 403,不派发工具', async () => {
      const invoke = vi.fn();
      const { call } = await start([SHOT], invoke);

      const res = await call({ name: 'screenshot', args: {} }, { 'X-BaseAgent-Token': 'wrong' });

      expect(res.status).toBe(403);
      expect(invoke).not.toHaveBeenCalled();
    });

    it('只认 POST /invoke,别的路径一律 404', async () => {
      const { url, token } = await start([SHOT], vi.fn());

      const res = await fetch(`${url}/anything`, {
        method: 'POST',
        headers: { 'X-BaseAgent-Token': token },
        body: '{}',
      });

      expect(res.status).toBe(404);
    });
  });

  describe('观察', () => {
    it('观察不进返回值,只攒在 TS 侧 —— 代码拿不到观察本体', async () => {
      const { bridge: b, invokeTool } = await start([SHOT], async () => ({
        ok: true,
        data: { url: 'https://example.com' },
        observations: [obs('登录按钮在右上角')],
      }));

      const result = await invokeTool('screenshot', {});

      // 代码侧只看到「附了几段」和一句说明
      expect(result.ok).toBe(true);
      expect(result.observations_attached).toBe(1);
      expect(result.observations).toBeUndefined();
      expect(String(result.note)).toContain('不需要 print');
      // 观察正文不能出现在返回给代码的 JSON 里
      expect(JSON.stringify(result)).not.toContain('登录按钮在右上角');

      // 观察本体在桥这边,由框架投递进上下文
      expect(b.takeObservations('run-1')).toHaveLength(1);
    });

    it('按 run 分桶 —— 嵌套执行不会把外层的观察取走', async () => {
      // 这是必须分桶的理由:代码调 screenshot 时,框架会再起一个 Python 进程
      // 去驱动浏览器截图,那个进程也有自己的 run id
      const { bridge: b, invokeTool } = await start([SHOT], async () => ({
        ok: true,
        observations: [obs('一段观察')],
      }));

      await invokeTool('screenshot', {}, 'outer');
      await invokeTool('screenshot', {}, 'inner');

      // 内层取走自己的,外层那段还在
      expect(b.takeObservations('inner')).toHaveLength(1);
      expect(b.takeObservations('outer')).toHaveLength(1);
    });

    it('取走后清桶,重复取拿不到东西(否则同 id 复用会串味)', async () => {
      const { bridge: b, invokeTool } = await start([SHOT], async () => ({
        ok: true,
        observations: [obs('一段观察')],
      }));

      await invokeTool('screenshot', {});
      expect(b.takeObservations('run-1')).toHaveLength(1);
      expect(b.takeObservations('run-1')).toHaveLength(0);
    });

    it('没有观察时原样返回,不加多余字段', async () => {
      const { invokeTool } = await start([SHOT], async () => ({
        ok: true,
        data: { url: 'https://example.com' },
      }));

      const result = await invokeTool('screenshot', {});
      expect(result.ok).toBe(true);
      expect(result.observations_attached).toBeUndefined();
      expect(result.note).toBeUndefined();
    });

    it('超过单次上限就不再收观察,但工具结果照常返回', async () => {
      // 模型在循环里看图是很自然的写法,50 次迭代就是 50 次视觉调用。
      // 拒收时要让模型知道「动作成功了,只是这次观察没收」,而不是以为整个调用失败
      const { bridge: b, invokeTool } = await start([SHOT], async () => ({
        ok: true,
        data: { url: 'https://example.com' },
        observations: [obs('一段观察')],
      }));

      for (let i = 0; i < 8; i++) {
        expect((await invokeTool('screenshot', {})).observations_attached).toBe(1);
      }

      const overflow = await invokeTool('screenshot', {});
      expect(overflow.ok).toBe(true);                       // 动作本身成功
      expect(overflow.data).toBeDefined();                  // 结果照常返回
      expect(overflow.observations_attached).toBe(0);
      expect(String(overflow.note)).toContain('上限');

      expect(b.takeObservations('run-1')).toHaveLength(8);
    });
  });

  describe('参数下发', () => {
    it('None 不下发 —— 否则会覆盖 TS 侧 Zod 的 optional 默认值', async () => {
      const invoke = vi.fn(async () => ({ ok: true }));
      const { invokeTool } = await start([SHOT], invoke);

      // Python 侧 prelude 已把 None 过滤掉,这里断言 TS 侧收到的形状
      await invokeTool('screenshot', { full_page: true });

      expect(invoke).toHaveBeenCalledWith('screenshot', { full_page: true });
    });

    it('工具抛异常时包成 ok:false,不炸掉桥', async () => {
      const { invokeTool, bridge: b } = await start([SHOT], async () => {
        throw new Error('浏览器没起来');
      });

      const result = await invokeTool('screenshot', {});

      expect(result.ok).toBe(false);
      expect(result.error).toContain('浏览器没起来');
      expect(b.isRunning).toBe(true);   // 桥还活着,后续调用照常
    });
  });

  describe('Python 函数生成', () => {
    it('签名从 JSON Schema 推导,必填参数排在有默认值的之前', async () => {
      // Python 不允许有默认值的参数出现在无默认值参数之前 ——
      // 顺序错了会是 SyntaxError,整段代码都跑不起来
      const { bridge: b } = await start([SHOT, VIEW], vi.fn());

      expect(b.signatures).toEqual([
        'screenshot(full_page=None, selector=None)',
        'view_image(path, detail=None)',
      ]);
    });

    it('prelude 里为每个工具生成函数,且带工具描述', async () => {
      const { bridge: b } = await start([SHOT, VIEW], vi.fn());

      expect(b.prelude).toContain('def screenshot(full_page=None, selector=None):');
      expect(b.prelude).toContain('def view_image(path, detail=None):');
      expect(b.prelude).toContain('截取当前页面');
      // 未暴露的工具不该出现
      expect(b.prelude).not.toContain('def write_file');
    });

    it('桥没启动时 prelude 为空 —— 不注入连不上的函数', () => {
      const b = new ToolBridge({ tools: [SHOT], invoke: vi.fn(), logger });
      expect(b.prelude).toBe('');
    });
  });
});

// ============================================
// 端到端:真的起 Python 进程跑生成的代码
// ============================================
//
// 上面那些用例都是从 TS 侧打 HTTP 接口,**没有执行过生成的 Python**。
// 而 prelude 是拼出来的源码,语法错误只有真跑一次才会暴露 ——
// 而且它一错就是整段代码跑不起来(注入在模型代码之前),影响面比桥本身大。

describe.skipIf(!hasPython)('工具桥端到端', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true }).catch(() => {})),
    );
  });

  async function makeExecutor(
    tools: BridgeToolSpec[],
    invoke: (name: string, args: Record<string, unknown>) => Promise<BridgeToolResult>,
  ) {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-bridge-'));
    dirs.push(workspace);

    const b = new ToolBridge({ tools, invoke, logger });
    bridge = b;
    expect(await b.start()).toBe(true);

    const py = new PythonExecutor({
      pythonPath: 'python',
      workDir: workspace,
      timeout: 60_000,
      maxStdoutBytes: 50 * 1024,
      maxStderrBytes: 16 * 1024,
      toolBridge: b,
      logger,
    });

    return { py, bridge: b };
  }

  it('代码里调 screenshot:结果回代码,观察留在 TS 侧', async () => {
    const invoke = vi.fn(async () => ({
      ok: true,
      data: { url: 'https://example.com' },
      observations: [obs('登录按钮在右上角')],
    }));
    const { py } = await makeExecutor([SHOT, VIEW], invoke);

    const r = await py.run(
      'r = screenshot(full_page=True)\nprint(r["ok"], r["observations_attached"])',
    );

    expect(r.stderr).toBe('');
    expect(r.ok).toBe(true);
    expect(r.stdout.trim()).toBe('True 1');
    // 观察由框架带出、投递进上下文；代码只知道「附了一段」
    expect(r.observations).toHaveLength(1);
    expect(r.stdout).not.toContain('登录按钮在右上角');
    expect(invoke).toHaveBeenCalledWith('screenshot', { full_page: true });
  });

  it('没传的参数不下发 —— 不覆盖 TS 侧 Zod 的 optional 默认值', async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const { py } = await makeExecutor([SHOT], invoke);

    const r = await py.run('screenshot()');

    expect(r.ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith('screenshot', {});
  });

  it('未暴露的工具在代码里根本不存在(NameError)', async () => {
    const invoke = vi.fn();
    const { py } = await makeExecutor([SHOT], invoke);

    const r = await py.run('write_file(path="x", content="y")');

    expect(r.ok).toBe(false);
    expect(r.stderr).toContain('NameError');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('工具描述里带引号也不会拼出语法错误', async () => {
    // 回归:docstring 早先是拼 """...""" 的,描述以 " 结尾就产出 """" ——
    // SyntaxError 会让**所有**代码执行失败,不只是这个函数不可用
    const quoted: BridgeToolSpec = {
      name: 'view_image',
      description: '看图。要看清小字请传 detail="original",默认 "low"\\反斜杠也测一下"',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    };
    const { py } = await makeExecutor([quoted], vi.fn(async () => ({ ok: true })));

    const r = await py.run('print("prelude 语法没问题")');

    expect(r.stderr).toBe('');
    expect(r.stdout.trim()).toBe('prelude 语法没问题');
  });

  it('bridge:false 时不注入这些函数(框架自己的脚本走这条路)', async () => {
    // BrowserOps 的截图脚本就是 bridge:false —— 桥里的 screenshot() 正是靠它实现的,
    // 注进去会形成递归入口
    const { py } = await makeExecutor([SHOT], vi.fn());

    const r = await py.run('screenshot()', { bridge: false });

    expect(r.ok).toBe(false);
    expect(r.stderr).toContain('NameError');
  });

  it('工具桥函数同样受写边界约束', async () => {
    // 桥的 prelude 排在写边界之后注入:它没有理由成为例外
    const { py } = await makeExecutor([SHOT], vi.fn(async () => ({ ok: true })));

    const outside = path.join(os.homedir(), '.ba-bridge-should-not-exist.txt');
    const r = await py.run(
      `screenshot()\nopen(${JSON.stringify(outside)}, "w").write("x")`,
    );

    expect(r.ok).toBe(false);
    expect(r.stderr).toContain('写入被拒绝');
    await expect(fs.access(outside)).rejects.toThrow();
  });
});
