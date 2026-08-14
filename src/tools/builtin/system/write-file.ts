// ============================================
// 系统工具:写入文件
// ============================================

import { z } from 'zod';
import { Tool, ToolContext, ToolResult } from '../../contract.js';

export class WriteFileTool implements Tool {
  name = 'write_file';
  description = '写入内容到文件。如果文件不存在会创建,存在则覆盖。会自动创建所需的父目录。';

  parameters = z.object({
    path: z.string().describe('文件路径(相对路径或绝对路径)'),
    content: z.string().describe('要写入的文本内容'),
  });

  needs = ['fs'] as const;
  danger = true;  // 写操作危险,需要确认

  async run(
    args: { path: string; content: string },
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
      await fsDriver.writeFile(args.path, args.content);

      return {
        ok: true,
        data: {
          path: args.path,
          size: args.content.length,
        },
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : '写入文件失败',
      };
    }
  }
}
