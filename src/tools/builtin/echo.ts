// ============================================
// 内置工具示例:Echo(测试用)
// ============================================

import { z } from 'zod';
import { Tool, ToolContext, ToolResult } from '../index.js';

export class EchoTool implements Tool {
  name = 'echo';
  description = '回显输入的消息(测试工具)';
  parameters = z.object({
    message: z.string().describe('要回显的消息'),
  });
  needs = [];
  danger = false;

  async run(
    args: { message: string },
    ctx: ToolContext
  ): Promise<ToolResult> {
    ctx.logger.info(`Echo: ${args.message}`);
    return {
      ok: true,
      data: { echo: args.message },
    };
  }
}
