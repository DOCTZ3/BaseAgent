// ============================================
// 系统工具:列出目录
// ============================================

import { z } from 'zod';
import { Tool, ToolContext, ToolResult } from '../../contract.js';

export class ListFilesTool implements Tool {
  name = 'list_files';
  description = '列出指定目录下的所有文件和子目录。返回文件名列表。';

  parameters = z.object({
    path: z.string().describe('目录路径(相对路径或绝对路径)'),
  });

  needs = ['fs'] as const;
  danger = false;  // 列出目录非危险

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
      const entries = await fsDriver.listDirectory(args.path);

      return {
        ok: true,
        data: {
          path: args.path,
          entries,
          count: entries.length,
        },
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : '列出目录失败',
      };
    }
  }
}
