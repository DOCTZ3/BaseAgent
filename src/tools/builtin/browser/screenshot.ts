// ============================================
// 浏览器工具:screenshot(截当前页面)
// ============================================
//
// 为什么这件事必须是 Tool、不能让模型用 execute_python 做:
// 图片要进上下文只有一条路 —— `ToolResult.attachments`,由 orchestrator 注入成
// user 消息(tool 消息的 content 只接受字符串)。而 execute_python 只能回传 stdout,
// 模型在代码里截了图也只能拿到一个文件路径,自己看不见。
//
// 这和架构里「不做浏览器工具组」并不矛盾:那条针对的是 DOM 提取类工具
// (会把整页灌进上下文、长尾无穷)。这个工具做的恰好是 execute_python **做不到**
// 的事 —— 把图片送进上下文。判据是「能力上有没有缺口」,不是「浏览器该不该有工具」。
// ============================================

import { z } from 'zod';
import * as fs from 'fs/promises';
import { Tool, ToolContext, ToolResult, ImageAttachment } from '../../contract.js';
import type { BrowserOps } from '../../../executors/index.js';

export class ScreenshotTool implements Tool {
  name = 'screenshot';

  description = [
    '截取常驻浏览器当前页面,截图会直接出现在你的下一轮上下文里(你能看见它)。',
    '',
    '用于:确认页面渲染是否正常、元素有没有被遮挡、读验证码、看图表,',
    '以及确认「用户是否已经登录成功」。这些问题看图比读 DOM 直接。',
    '',
    'full_page=true 截整页(会很长,小字更难辨认);',
    'selector 只截某个元素,想看清局部时用它。',
    '',
    '注意每张图缩放后有分辨率上限,整页截图里的小字可能读不出来 ——',
    '要读细节请用 selector 截局部。',
  ].join('\n');

  parameters = z.object({
    full_page: z
      .boolean()
      .optional()
      .describe('是否截整页(默认只截可视区域)'),
    selector: z
      .string()
      .optional()
      .describe('只截这个元素(CSS 选择器)。给了它就忽略 full_page'),
  });

  needs = ['browser'] as const;
  danger = false;

  async run(
    args: { full_page?: boolean; selector?: string },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const ops = ctx.executors.browser as BrowserOps | undefined;

    if (!ops?.available) {
      return {
        ok: false,
        error:
          '常驻浏览器未启用。需要 PYTHON_ENABLED=true,且 chromium 已安装' +
          '(playwright install chromium)。',
      };
    }

    try {
      const shot = await ops.screenshot({
        fullPage: args.full_page,
        selector: args.selector,
      });

      if (!shot.ok || !shot.filePath) {
        return { ok: false, error: shot.error ?? '截图失败' };
      }

      // 直接用 node fs 读,不走 fs 工具:这是框架自己产出的临时文件,
      // 路径由框架决定而非模型指定,不需要过授权检查(temp 也不在授权列表里)
      const bytes = await fs.readFile(shot.filePath);
      const size = readPngSize(bytes);

      // 读完即删:截图是一次性观察,图片本体已经进 attachments,
      // 留在 temp 里只会堆垃圾
      await fs.rm(shot.filePath, { force: true }).catch(() => {});

      const attachment: ImageAttachment = {
        kind: 'image',
        data: bytes.toString('base64'),
        mimeType: 'image/png',
        label: `screenshot ${shot.url ?? ''}`.trim(),
        // 整页截图往往很长,缩放后小字会糊 —— 让模型能显式要原图
        detail: args.full_page ? 'original' : 'low',
        ...(size ?? {}),
      };

      ctx.logger.info('截图完成', {
        url: shot.url,
        bytes: bytes.length,
        ...(size ?? {}),
        full_page: !!args.full_page,
        selector: args.selector,
      });

      return {
        ok: true,
        data: {
          url: shot.url,
          title: shot.title,
          ...(size ?? {}),
          bytes: bytes.length,
          note: '截图已附加，你将在下一条消息中看到它',
        },
        attachments: [attachment],
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : '截图失败',
      };
    }
  }
}

/** 从 PNG 头读尺寸(IHDR 紧跟 8 字节签名 + 4 长度 + 4 类型) */
function readPngSize(b: Buffer): { width: number; height: number } | null {
  try {
    if (b.length < 24) return null;
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  } catch {
    return null;
  }
}
