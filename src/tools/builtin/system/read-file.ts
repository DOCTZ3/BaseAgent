// ============================================
// 系统工具:读取文件
// ============================================

import { z } from 'zod';
import { Tool, ToolContext, ToolResult } from '../../contract.js';

export class ReadFileTool implements Tool {
  name = 'read_file';
  description = '读取文件内容。返回文件的完整文本内容。';

  parameters = z.object({
    path: z.string().describe('文件路径(相对路径或绝对路径)'),
  });

  needs = ['fs'] as const;
  danger = false;  // 读操作非危险

  async run(
    args: { path: string },
    ctx: ToolContext
  ): Promise<ToolResult> {
    const fsDriver = ctx.executors.fs as any;  // FsDriver 实例

    if (!fsDriver) {
      return {
        ok: false,
        error: '文件系统执行器未初始化',
      };
    }

    try {
      const content = await fsDriver.readFile(args.path);

      return {
        ok: true,
        data: {
          path: args.path,
          content,
          size: content.length,
        },
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : '读取文件失败',
      };
    }
  }
}
