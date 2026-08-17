// ============================================
// 系统工具:读取文件
// ============================================

import { z } from 'zod';
import { Tool, ToolContext, ToolResult } from '../../contract.js';

export class ReadFileTool implements Tool {
  name = 'read_file';
  description = '读取文件内容。支持分块读取大文件。';

  parameters = z.object({
    path: z.string().describe('文件路径(相对路径或绝对路径)'),
    offset: z.number().optional().describe('从第几行开始读（默认 0）'),
    limit: z.number().optional().describe('最多读几行（默认全部，上限 500 行）'),
  });

  needs = ['fs'] as const;
  danger = false;  // 读操作非危险

  // Token 估算（粗略）
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);  // 英文约 4 字符/token
  }

  async run(
    args: { path: string; offset?: number; limit?: number },
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
      const lines = content.split('\n');

      // 检查文件大小
      const estimatedTokens = this.estimateTokens(content);
      const maxTokens = 10_000;  // 单次上限 1 万 token

      if (estimatedTokens > maxTokens && !args.offset && !args.limit) {
        // 文件太大，但用户未指定分块参数
        return {
          ok: false,
          error: `文件过大（约 ${Math.round(estimatedTokens / 1000)}K tokens）。请使用分块读取：
- 方式1：读取前 500 行：read_file({ path: "${args.path}", limit: 500 })
- 方式2：分段读取：read_file({ path: "${args.path}", offset: 0, limit: 500 })
文件总共 ${lines.length} 行。`
        };
      }

      // 分块读取
      const start = args.offset || 0;
      const maxLines = 500;  // 单次最多 500 行
      const requestedLimit = args.limit ? Math.min(args.limit, maxLines) : maxLines;
      const end = args.limit !== undefined
        ? Math.min(start + requestedLimit, lines.length)
        : lines.length;

      const chunk = lines.slice(start, end).join('\n');

      return {
        ok: true,
        data: {
          path: args.path,
          content: chunk,
          metadata: {
            total_lines: lines.length,
            returned_lines: end - start,
            offset: start,
            has_more: end < lines.length
          }
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
