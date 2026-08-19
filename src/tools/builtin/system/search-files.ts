// ============================================
// 系统工具:搜索文件
// ============================================

import { z } from 'zod';
import { Tool, ToolContext, ToolResult } from '../../contract.js';

// 单次返回的结果上限。超限报错并告知总数,引导收窄模式 ——
// 静默截断会让模型以为看到了全部匹配,得出错误结论。
const MAX_RESULTS = 300;

export class SearchFilesTool implements Tool {
  name = 'search_files';
  description = '在指定目录下递归搜索匹配模式的文件。支持通配符: * 匹配单段, ** 匹配任意深度。例如: "*.ts" 匹配所有 TypeScript 文件, "**/*.json" 递归匹配所有 JSON 文件。匹配过多时会报错并提示收窄模式。';

  parameters = z.object({
    baseDir: z.string().describe('搜索起始目录'),
    pattern: z.string().describe('文件名匹配模式(支持 * 和 **)'),
    maxDepth: z.number().optional().describe('最大递归深度(默认 10)'),
  });

  needs = ['fs'] as const;
  danger = false;  // 搜索操作非危险

  async run(
    args: { baseDir: string; pattern: string; maxDepth?: number },
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
      const results = await fsDriver.searchFiles(
        args.baseDir,
        args.pattern,
        args.maxDepth || 10
      );

      if (results.length > MAX_RESULTS) {
        return {
          ok: false,
          error: `模式 "${args.pattern}" 在 "${args.baseDir}" 下匹配到 ${results.length} 个文件,` +
            `超过单次返回上限 ${MAX_RESULTS}。\n` +
            `请收窄范围后重试,例如:\n` +
            `  - 指定更深的起始目录\n` +
            `  - 用更具体的模式(如 "src/**/*.ts" 而非 "**/*")\n` +
            `  - 降低 maxDepth`,
        };
      }

      return {
        ok: true,
        data: {
          baseDir: args.baseDir,
          pattern: args.pattern,
          results,
          count: results.length,
        },
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : '搜索文件失败',
      };
    }
  }
}
