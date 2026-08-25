// ============================================
// 代码工具:view_image(把一张本地图片交给视觉模型,带回文字观察)
// ============================================
//
// **数据流是「图进视觉模型、文字回主模型」**,不是「把图搬进主模型的上下文」。
// 主模型全程不接触像素,所以它是不是多模态与框架无关 —— 这是视觉即插件的含义。
// 未配 VISION_MODEL 时这个工具不注册,函数在代码里直接不存在。
//
// 关键设计：
// - 格式按**文件内容**判断(magic bytes),不看扩展名 —— 服务端也是按内容判的,
//   一个改名成 .png 的 bmp 会在服务端 400,在这里提前拦住并说清原因
// - 尺寸从文件头解析,用于拦住超限图(单边 >8192px)并给出可执行建议
// - 不引入图像库做缩放:超限就返回 ok:false 建议用 PIL 缩放后重试
//   (沙箱已带 PIL),同「工具超限返回收窄建议」那套
// - 路径过 SecurityGuard,与 read_file 同一套白名单/黑名单
// - `question` 决定视觉模型找什么。不给只能拿到泛泛描述,
//   很可能恰好漏掉主模型真正要的东西
//
// 配额(来自 DeepSeek vision 文档):
//   单图 ≤32MiB / 单边 ≤8192px / 每图 token 上限 384
// ============================================

import { z } from 'zod';
import {
  Tool,
  ToolContext,
  ToolResult,
  ImageMime,
  VisionAnalyzer,
} from '../../contract.js';

// 服务端硬限。超了必定 400，提前拦
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_SIDE = 8192;

type Mime = ImageMime;

export class ViewImageTool implements Tool {
  name = 'view_image';

  // 中性表述:不承诺「你会看到图」,只承诺「你会得到对这张图的观察」——
  // 观察由视觉模型产出,你拿到的是文字
  description = [
    '看一张本地图片 —— 返回对这张图的观察(文字)。',
    '用于:确认网页截图的渲染效果、读图表、识别图中文字、检查布局问题。',
    '',
    '**务必写 question**:观察由视觉模型产出,它只回答你问的东西。',
    '「验证码是什么」和「这页面为什么看起来是坏的」需要的描述完全不同,',
    '不问就只能拿到泛泛描述,很可能恰好漏掉你要的信息。',
    '',
    'detail:默认 low(先缩到 512×512,够看布局和大字);',
    '要看清小字、表格、验证码时传 original。',
    '',
    '观察反映的是**调用当时**的状态。页面或文件变化后请重新调用。',
    '需要追问同一张图,再调一次并换个 question。',
  ].join('\n');

  parameters = z.object({
    path: z.string().describe('图片路径。支持 JPEG / PNG / GIF / WebP'),
    question: z
      .string()
      .optional()
      .describe('你想从这张图里知道什么。写清楚，观察会聚焦在这上面'),
    detail: z
      .enum(['low', 'original'])
      .optional()
      .describe('low=缩到 512×512(默认,省 token);original=保留原图(看清细节)'),
  });

  needs = ['fs', 'vision'] as const;

  // 只读文件，不产生副作用
  danger = false;

  async run(
    args: { path: string; question?: string; detail?: 'low' | 'original' },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const fsDriver = ctx.executors.fs as
      | { readFileBytes(p: string): Promise<Buffer> }
      | undefined;

    if (!fsDriver) {
      return { ok: false, error: '文件系统执行器未初始化' };
    }

    // 未配视觉模型时这个工具本不该被注册，走到这里说明注入漏了
    const vision = ctx.executors.vision as VisionAnalyzer | undefined;
    if (!vision) {
      return { ok: false, error: '视觉插件未启用（需配置 VISION_MODEL）' };
    }

    try {
      const bytes = await fsDriver.readFileBytes(args.path);

      if (bytes.length === 0) {
        return { ok: false, error: `文件为空: ${args.path}` };
      }

      if (bytes.length > MAX_BYTES) {
        return {
          ok: false,
          error:
            `图片 ${formatBytes(bytes.length)} 超过单图上限 32MiB。\n` +
            '请先压缩再试,例如用 PIL:\n' +
            "  from PIL import Image\n" +
            `  im = Image.open(r"${args.path}")\n` +
            '  im.save("smaller.jpg", quality=70)',
        };
      }

      // 按内容判格式：改名成 .png 的 bmp 在服务端会 400，这里提前说清
      const mimeType = sniffMime(bytes);
      if (!mimeType) {
        return {
          ok: false,
          error:
            `无法识别图片格式(按文件内容判断,与扩展名无关)。\n` +
            '支持:JPEG / PNG / GIF / WebP。\n' +
            '若这是 BMP/TIFF/SVG 等格式,请先转换:\n' +
            "  from PIL import Image\n" +
            `  Image.open(r"${args.path}").convert("RGB").save("converted.png")`,
        };
      }

      const size = readDimensions(bytes, mimeType);

      if (size && Math.max(size.width, size.height) > MAX_SIDE) {
        return {
          ok: false,
          error:
            `图片尺寸 ${size.width}x${size.height},单边超过上限 ${MAX_SIDE}px。\n` +
            '请先缩放再试:\n' +
            "  from PIL import Image\n" +
            `  im = Image.open(r"${args.path}")\n` +
            `  im.thumbnail((${MAX_SIDE}, ${MAX_SIDE}))\n` +
            '  im.save("resized.png")',
        };
      }

      const detail = args.detail ?? 'low';

      // 图交给视觉模型，只把文字带回来 —— 主模型全程不接触像素
      const result = await vision.analyze({
        data: bytes.toString('base64'),
        mimeType,
        label: args.path,
        question: args.question,
        detail,
      });

      if (!result.ok || !result.observation) {
        return { ok: false, error: result.error ?? '视觉观察失败' };
      }

      ctx.logger.info('看图完成', {
        path: args.path,
        mime: mimeType,
        bytes: bytes.length,
        ...(size ? { size: `${size.width}x${size.height}` } : {}),
        detail,
        question: args.question ?? '(通用描述)',
      });

      // 观察走 observations 而不是塞进 data：经工具桥调用时 data 会返回给
      // Python 代码，而模型不会 print 它（实测连续三次裸调 view_image 都没 print）。
      // 放 observations 才能由框架投递，与图片同一套语义
      return {
        ok: true,
        observations: [
          args.question
            ? `【${args.path}｜问：${args.question}】\n${result.observation}`
            : `【${args.path}】\n${result.observation}`,
        ],
        data: {
          path: args.path,
          // 让主模型知道这是谁看的：观察是二手信息，出错时能判断该怀疑哪一层
          observed_by: vision.modelName,
          ...(args.question ? { question: args.question } : {}),
          ...(size ? { width: size.width, height: size.height } : {}),
        },
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : '读取图片失败',
      };
    }
  }
}

/**
 * 按 magic bytes 判断格式
 *
 * 不信扩展名：DeepSeek 按实际内容判格式，扩展名对了但内容不对一样 400。
 */
function sniffMime(b: Buffer): Mime | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (b.length >= 6 && b.subarray(0, 6).toString('ascii').match(/^GIF8[79]a$/)) {
    return 'image/gif';
  }
  if (
    b.length >= 12 &&
    b.subarray(0, 4).toString('ascii') === 'RIFF' &&
    b.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * 从文件头读尺寸
 *
 * 只为拦住超限图，读不出来不算错误（返回 null，跳过检查）——
 * 拿不到尺寸不该阻止模型看图。
 */
function readDimensions(b: Buffer, mime: Mime): { width: number; height: number } | null {
  try {
    if (mime === 'image/png') {
      // IHDR 紧跟 8 字节签名 + 4 长度 + 4 类型
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    }

    if (mime === 'image/gif') {
      return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    }

    if (mime === 'image/webp') {
      const fmt = b.subarray(12, 16).toString('ascii');
      if (fmt === 'VP8 ') {
        return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      }
      if (fmt === 'VP8L') {
        const bits = b.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (fmt === 'VP8X') {
        return {
          width: (b.readUIntLE(24, 3) & 0xffffff) + 1,
          height: (b.readUIntLE(27, 3) & 0xffffff) + 1,
        };
      }
      return null;
    }

    // JPEG：扫 SOFn 段。段长可变，必须顺序跳
    let offset = 2;
    while (offset + 9 < b.length) {
      if (b[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = b[offset + 1];
      // SOF0-SOF3, SOF5-SOF7, SOF9-SOF11, SOF13-SOF15（跳过 DHT=C4/JPG=C8/DAC=CC）
      if (
        marker >= 0xc0 && marker <= 0xcf &&
        marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      ) {
        return { height: b.readUInt16BE(offset + 5), width: b.readUInt16BE(offset + 7) };
      }
      offset += 2 + b.readUInt16BE(offset + 2);
    }
    return null;
  } catch {
    return null;
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.round(bytes / 1024)}KB`;
}
