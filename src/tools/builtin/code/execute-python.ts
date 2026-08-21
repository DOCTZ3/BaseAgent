// ============================================
// 代码工具:execute_python(CodeAct 的唯一入口)
// ============================================
//
// 这个工具刻意做得很薄:它不理解代码在干什么,只负责把代码送进沙箱、
// 把结果整理成模型能据以纠偏的形式。能力扩展靠沙箱预装库,不靠加工具。
//
// 唯一的"框架意志"是 stdout 上限:模型很容易写出 print(page.content()),
// 2MB HTML 一次就烧掉几十万 token。超限时返回 ok:false + 实际体积 + 收窄建议,
// 走「所有报错回流 loop」让模型改成在沙箱内先提取(见架构文档)。
// ============================================

import { z } from 'zod';
import { Tool, ToolContext, ToolResult } from '../../contract.js';
import type { PythonExecutor } from '../../../executors/index.js';

export class ExecutePythonTool implements Tool {
  name = 'execute_python';

  // description 是模型用这个工具的唯一说明书,所以把"怎么用才不炸上下文"写在这里,
  // 而不是散在 system prompt 里
  description = [
    '在沙箱里执行 Python 代码,返回 stdout。已预装:playwright(浏览器)、',
    'python-docx / openpyxl / pypdf(文档)、pandas、requests、beautifulsoup4。',
    '',
    '重要:只有 print 出来的内容会回到你的上下文,且有体积上限。',
    '务必在代码内先提取/过滤再打印,不要打印整页 HTML 或整个文件。',
    '',
    '浏览器用法(登录态自动持久化,不要自己造 profile 路径):',
    '  import os',
    '  from playwright.sync_api import sync_playwright',
    '  with sync_playwright() as p:',
    '      ctx = p.chromium.launch_persistent_context(',
    '          os.environ["BROWSER_PROFILE_DIR"], headless=True)',
    '      page = ctx.pages[0] if ctx.pages else ctx.new_page()',
    '      page.goto(url)',
    '      print(page.locator(".price").all_inner_texts())  # 只回传提取结果',
    '      ctx.close()',
    '',
    '注意 launch_persistent_context 返回 BrowserContext(没有 new_context)。',
    '页面结构未知时,先用 page.locator("body").aria_snapshot() 拿语义树',
    '(只含角色+可见文本,整页 2MB 通常压到几 KB),或用 locator(...).count() 数条目。',
    '不要 print(page.content()) —— 整页 HTML 会撑爆上下文。',
    '注意 page.accessibility 在新版 Playwright 已移除,不要用。',
    '需要用户登录时用 headless=False 打开窗口,再 page.wait_for_url(...) 等待,',
    '绝不要在代码里填写账号密码。',
  ].join('\n');

  parameters = z.object({
    code: z.string().describe('要执行的 Python 代码。用 print 输出你需要带回的结果'),
    timeout_ms: z
      .number()
      .optional()
      .describe('超时(毫秒)。浏览器登录引导等需要人工操作的场景可调大'),
  });

  needs = ['python'] as const;

  // 代码执行能写文件、能发网络请求,副作用范围远超写单个文件
  danger = true;

  async run(
    args: { code: string; timeout_ms?: number },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const python = ctx.executors.python as PythonExecutor | undefined;

    if (!python) {
      return { ok: false, error: 'Python 执行器未初始化' };
    }

    try {
      const result = await python.run(args.code, { timeout: args.timeout_ms });

      // 超限：报实际体积并给出收窄路径。不静默截断 ——
      // 模型会以为看到了全部,基于残缺数据推理
      if (result.stdoutTruncated) {
        return {
          ok: false,
          error:
            `输出 ${formatBytes(result.stdoutBytes)} 超过上限,已丢弃。\n` +
            '请在代码内先提取再打印,不要打印整页 HTML / 整个文件。\n' +
            '探查结构可用:page.locator("body").aria_snapshot()、locator(...).count()、' +
            'inner_html()[:1500]。\n' +
            `开头片段:${clip(result.stdout, 500)}`,
        };
      }

      if (result.timedOut) {
        return {
          ok: false,
          error:
            `执行超时(${result.durationMs}ms),进程已终止。\n` +
            '若在等待用户登录,请用 timeout_ms 调大;若是等页面元素,' +
            '请用 wait_for_selector 而非 sleep。\n' +
            (result.stdout ? `超时前输出:${clip(result.stdout, 500)}` : ''),
        };
      }

      if (!result.ok) {
        return {
          ok: false,
          error:
            `Python 退出码 ${result.exitCode}。\n` +
            `stderr:\n${clip(result.stderr, 2000)}` +
            (result.stdout ? `\nstdout:\n${clip(result.stdout, 500)}` : ''),
        };
      }

      return {
        ok: true,
        data: {
          stdout: result.stdout,
          // 成功但有 stderr 是常态(warning),不算失败,但要让模型看见
          ...(result.stderr.trim() ? { stderr: clip(result.stderr, 1000) } : {}),
          duration_ms: result.durationMs,
        },
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : '代码执行失败',
      };
    }
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…(已截断)` : text;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}
