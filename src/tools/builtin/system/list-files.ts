// ============================================
// 系统工具:列出目录
// ============================================

import { z } from 'zod';
import { Tool, ToolContext, ToolResult } from '../../contract.js';

// 单次返回的条目上限。超限不静默截断,而是报错并告知总数 +
// 引导用 search_files 缩小范围 —— 静默截断会让模型以为看到了全部,
// 基于残缺数据推理(比如断言"目录下没有 .py 文件")。
const MAX_ENTRIES = 300;

export class ListFilesTool implements Tool {
  name = 'list_files';
  description = '列出指定目录下的所有文件和子目录。返回文件名列表。目录条目过多时会报错并提示改用 search_files 缩小范围。';

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

      if (entries.length > MAX_ENTRIES) {
        return {
          ok: false,
          error: `目录 "${args.path}" 下有 ${entries.length} 个条目,超过单次返回上限 ${MAX_ENTRIES}。\n` +
            `请改用 search_files 按模式缩小范围,例如:\n` +
            `  search_files({ baseDir: "${args.path}", pattern: "*.ts" })`,
        };
      }

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
