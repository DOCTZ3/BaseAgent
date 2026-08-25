// ============================================
// 浏览器工具:screenshot(截当前页面,带回文字观察)
// ============================================
//
// 截图落盘由框架做、看图由**视觉插件**做,主模型只收文字。
// 所以它做的是纯 Python 做不到的两件事:一是拿到常驻浏览器的句柄
// (模型代码虽然也能连 CDP 自己截,但截完还得有人看),二是调视觉模型 ——
// 视觉模型的 API key 不在沙箱 env 白名单里,代码自己调不了。
//
// 这和架构里「不做浏览器工具组」并不矛盾:那条针对的是 DOM 提取类工具
// (会把整页灌进上下文、长尾无穷)。这个工具做的恰好是代码**做不到**的事。
// ============================================

import { z } from 'zod';
import * as fs from 'fs/promises';
import { Tool, ToolContext, ToolResult, VisionAnalyzer } from '../../contract.js';
import type { BrowserOps } from '../../../executors/index.js';

export class ScreenshotTool implements Tool {
  name = 'screenshot';

  // 中性表述:不承诺「你会看见图」,只承诺「你会得到对这一屏的观察」
  description = [
    '截取常驻浏览器当前页面 —— 返回对这一屏的观察(文字)。',
    '',
    '用于:确认页面渲染是否正常、元素有没有被遮挡、读验证码、看图表,',
    '以及确认「用户是否已经登录成功」。这些问题看图比读 DOM 直接。',
    '',
    '**务必写 question**:观察由视觉模型产出,它只回答你问的东西。',
    '「登录成功了吗」和「这一屏有哪些可点的按钮」需要的描述完全不同,',
    '不问就只能拿到泛泛描述,很可能恰好漏掉你要的信息。',
    '',
    'full_page=true 截整页(会很长,小字更难辨认);',
    'selector 只截某个元素,想看清局部时用它 —— 要读小字请用它。',
  ].join('\n');

  parameters = z.object({
    question: z
      .string()
      .optional()
      .describe('你想从这一屏里知道什么。写清楚，观察会聚焦在这上面'),
    full_page: z
      .boolean()
      .optional()
      .describe('是否截整页(默认只截可视区域)'),
    selector: z
      .string()
      .optional()
      .describe('只截这个元素(CSS 选择器)。给了它就忽略 full_page'),
  });

  needs = ['browser', 'vision'] as const;
  danger = false;

  async run(
    args: { question?: string; full_page?: boolean; selector?: string },
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

    // 未配视觉模型时这个工具本不该被注册，走到这里说明注入漏了
    const vision = ctx.executors.vision as VisionAnalyzer | undefined;
    if (!vision) {
      return { ok: false, error: '视觉插件未启用（需配置 VISION_MODEL）' };
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

      // 读完即删:截图是一次性观察,像素已经交给视觉模型,
      // 留在 temp 里只会堆垃圾
      await fs.rm(shot.filePath, { force: true }).catch(() => {});

      // 整页截图往往很长,缩放后小字会糊 —— 整页时保留原图
      const detail = args.full_page ? ('original' as const) : ('low' as const);

      // 像素交给视觉模型，只把文字带回来 —— 主模型全程不接触截图
      const result = await vision.analyze({
        data: bytes.toString('base64'),
        mimeType: 'image/png',
        label: `screenshot ${shot.url ?? ''}`.trim(),
        question: args.question,
        detail,
      });

      if (!result.ok || !result.observation) {
        return { ok: false, error: result.error ?? '视觉观察失败' };
      }

      ctx.logger.info('截图并观察完成', {
        url: shot.url,
        bytes: bytes.length,
        ...(size ?? {}),
        full_page: !!args.full_page,
        selector: args.selector,
        question: args.question ?? '(通用描述)',
      });

      // 观察走 observations 而不是塞进 data：经工具桥调用时 data 会返回给
      // Python 代码，而模型不会 print 它（实测连续三次裸调 view_image 都没 print）。
      // 放 observations 才能由框架投递，与图片同一套语义
      const where = shot.url ? `截图｜${shot.url}` : '截图';
      return {
        ok: true,
        observations: [
          args.question
            ? `【${where}｜问：${args.question}】\n${result.observation}`
            : `【${where}】\n${result.observation}`,
        ],
        data: {
          url: shot.url,
          title: shot.title,
          // 让主模型知道是谁看的：观察是二手信息，出错时能判断该怀疑哪一层
          observed_by: vision.modelName,
          ...(args.question ? { question: args.question } : {}),
          ...(size ?? {}),
        },
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
