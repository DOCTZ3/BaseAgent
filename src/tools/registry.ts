// ============================================
// Tools 层:工具注册表
// ============================================

import { Tool, ToolDescription } from './contract.js';
import { Logger } from '../platform/index.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  constructor(private logger: Logger) {}

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`工具 ${tool.name} 已注册`);
    }
    this.tools.set(tool.name, tool);
    this.logger.debug(`工具已注册: ${tool.name}`, {
      needs: tool.needs,
      danger: tool.danger
    });
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  all(): Tool[] {
    return Array.from(this.tools.values());
  }

  // 导出说明书(喂给模型)
  getAllDescriptions(): ToolDescription[] {
    return this.all().map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: zodToJsonSchema(tool.parameters) as Record<string, unknown>,
    }));
  }
}
