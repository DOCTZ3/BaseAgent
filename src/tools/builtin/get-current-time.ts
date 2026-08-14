// ============================================
// 内置工具示例:GetCurrentTime
// ============================================

import { z } from 'zod';
import { Tool, ToolContext, ToolResult } from '../index.js';

export class GetCurrentTimeTool implements Tool {
  name = 'get_current_time';
  description = '获取当前时间';
  parameters = z.object({
    format: z.enum(['iso', 'timestamp', 'readable']).optional().describe('时间格式'),
  });
  needs = [];
  danger = false;

  async run(
    args: { format?: 'iso' | 'timestamp' | 'readable' },
    ctx: ToolContext
  ): Promise<ToolResult> {
    const now = new Date();
    const format = args.format || 'iso';

    let result: string | number;
    if (format === 'timestamp') {
      result = now.getTime();
    } else if (format === 'readable') {
      result = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    } else {
      result = now.toISOString();
    }

    ctx.logger.info(`获取当前时间: ${result}`);
    return {
      ok: true,
      data: { time: result, format },
    };
  }
}
