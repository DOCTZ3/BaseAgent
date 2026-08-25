// ============================================
// Tools 层:工具注册表
// ============================================

import { Tool, ToolDescription } from './contract.js';
import { Logger } from '../platform/index.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  /**
   * 不出现在模型工具清单里的工具(但仍可被调用)
   *
   * 「注册」与「暴露」是两件事:工具桥的 invoke 要经 runner 按名字查找,
   * 所以工具必须留在表里;而要测「模型会不会在代码里调工具」,
   * 就得把工具那条路从 prompt 里拿掉,否则模型总会选它更熟的形式。
   */
  private hidden = new Set<string>();

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

  /**
   * 把工具从模型的工具清单里隐藏(仍然可以被调用)
   *
   * 用于工具桥:被隐藏的工具只能在代码里调,不能作为 tool_call 调。
   * 不校验工具是否已注册 —— 隐藏在注册之前发生是合理的调用顺序。
   */
  hide(names: readonly string[]): void {
    for (const name of names) this.hidden.add(name);
    if (names.length) {
      this.logger.debug('工具已从模型清单隐藏(仍可经工具桥调用)', { tools: names });
    }
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  all(): Tool[] {
    return Array.from(this.tools.values());
  }

  /** 全部工具的说明书(不过滤隐藏项)。工具桥用它取被隐藏工具的 schema */
  describe(tools: Tool[]): ToolDescription[] {
    return tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: zodToJsonSchema(tool.parameters) as Record<string, unknown>,
    }));
  }

  /**
   * 导出说明书(喂给模型)
   *
   * 隐藏的工具不在其中 —— 它们只能在代码里调。
   * 桥要取这些工具的 schema 请用 describe(),别用这个方法
   */
  getAllDescriptions(): ToolDescription[] {
    return this.describe(this.all().filter(t => !this.hidden.has(t.name)));
  }
}
