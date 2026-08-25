// ============================================
// Executors 层:常驻浏览器的具体操作
// ============================================
//
// 为什么单独一层、而不把逻辑写进 Tool:
// CodeAct 工具桥落地后,Python 侧也要能调这些操作。逻辑放在这里,
// Tool 只做薄包装,将来工具桥直接复用同一份实现,不必再抄一遍。
//
// 为什么用「框架自己写的 Python」驱动浏览器,而不是 TS 侧接 Playwright:
// chromium 由 BrowserManager 常驻、只暴露一个 CDP 地址。TS 侧要操作它
// 得再引一个 playwright 包(几百 MB),而 Python 侧本来就装着。
// 所以这里生成**固定的**脚本交给 PythonExecutor 跑 ——
// 与模型自己写代码的区别是:这段代码是框架写的,行为可预测、可测试。
// ============================================

import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { PythonExecutor } from './python-executor.js';

export interface ScreenshotResult {
  ok: boolean;
  /** 截图落盘路径(临时目录) */
  filePath?: string;
  width?: number;
  height?: number;
  url?: string;
  title?: string;
  error?: string;
}


export class BrowserOps {
  constructor(
    private python: PythonExecutor,
    private cdpUrl: string,
  ) {}

  get available(): boolean {
    return !!this.cdpUrl;
  }

  /**
   * 截当前页面
   *
   * 落在系统临时目录而不是工作区:截图是一次性观察,图片本身会经 attachments
   * 直接进上下文、不需要 fs 工具再去读它。写进工作区只会堆垃圾。
   * (写边界允许 temp,所以这里写得进去)
   */
  async screenshot(opts: {
    fullPage?: boolean;
    selector?: string;
  } = {}): Promise<ScreenshotResult> {
    const out = path.join(os.tmpdir(), `baseagent-shot-${randomUUID()}.png`);
    const target = opts.selector
      ? `page.locator(${JSON.stringify(opts.selector)}).first`
      : 'page';

    const code = `
import json, os
from playwright.sync_api import sync_playwright

result = {"ok": False}
try:
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(${JSON.stringify(this.cdpUrl)})
        ctx = browser.contexts[0]
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        ${target}.screenshot(path=${JSON.stringify(out)}${
          opts.selector ? '' : `, full_page=${opts.fullPage ? 'True' : 'False'}`
        })
        size = page.viewport_size or {}
        result = {
            "ok": True,
            "url": page.url,
            "title": page.title(),
            "width": size.get("width"),
            "height": size.get("height"),
        }
        # 不 close():那会杀掉常驻实例
except Exception as e:
    result = {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}

print("__BASEAGENT__" + json.dumps(result, ensure_ascii=False))
`;

    // bridge:false —— 这是框架自己写的脚本,不需要工具桥函数。
    // 更要紧的是:桥里的 screenshot() 就是靠这段脚本实现的,注进来会形成递归入口
    const res = await this.python.run(code, { timeout: 60_000, bridge: false });
    const parsed = this.parse(res.stdout, res.stderr);
    if (!parsed.ok) return parsed as ScreenshotResult;
    return { ...parsed, filePath: out } as ScreenshotResult;
  }

  /**
   * 从 stdout 里取出结果
   *
   * 用 `__BASEAGENT__` 前缀定位:Playwright 和依赖库偶尔会往 stdout 打警告,
   * 直接 JSON.parse 整个 stdout 会被那些噪声搞挂。
   */
  private parse(stdout: string, stderr: string): { ok: boolean; error?: string } {
    const line = stdout
      .split('\n')
      .map(l => l.trim())
      .reverse()
      .find(l => l.startsWith('__BASEAGENT__'));

    if (!line) {
      return {
        ok: false,
        error:
          '浏览器操作没有返回结果。' +
          (stderr.trim() ? `\nstderr: ${stderr.slice(0, 500)}` : ''),
      };
    }

    try {
      return JSON.parse(line.slice('__BASEAGENT__'.length));
    } catch {
      return { ok: false, error: '结果解析失败' };
    }
  }
}
