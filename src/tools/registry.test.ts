// ============================================
// ToolRegistry —— 「注册」与「暴露」是两件事
// ============================================
//
// hide() 支撑的不变量:被隐藏的工具**不在模型清单里,但仍能按名字取到**。
// 这一条是工具桥的前提 —— 桥的 invoke 经 runner.run() 按名字查找,
// 若哪天把 hide() 改成真删,桥不会立刻报错,只会在「模型从代码里调」时
// 静默失效。所以专门锁住它。
// ============================================

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from './registry.js';
import type { Tool } from './contract.js';
import type { Logger } from '../platform/index.js';

const logger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
} as unknown as Logger;

function fakeTool(name: string): Tool {
  return {
    name,
    description: `${name} 的说明`,
    parameters: z.object({ path: z.string(), detail: z.string().optional() }),
    needs: [],
    danger: false,
    run: async () => ({ ok: true }),
  };
}

describe('ToolRegistry', () => {
  it('隐藏的工具不进模型清单，但仍能按名字取到', () => {
    const registry = new ToolRegistry(logger);
    registry.register(fakeTool('screenshot'));
    registry.register(fakeTool('read_file'));
    registry.hide(['screenshot']);

    expect(registry.getAllDescriptions().map(t => t.name)).toEqual(['read_file']);
    // 桥要靠这个查找：拿不到就等于桥失效
    expect(registry.get('screenshot')).toBeDefined();
    expect(registry.all()).toHaveLength(2);
  });

  it('describe() 不过滤隐藏项 —— 桥要用它取 schema', () => {
    // 回归：早期入口曾用 getAllDescriptions() 构建桥的工具列表，
    // 隐藏之后那个列表会变空、桥根本不启动
    const registry = new ToolRegistry(logger);
    registry.register(fakeTool('screenshot'));
    registry.hide(['screenshot']);

    const described = registry.describe(registry.all());
    expect(described).toHaveLength(1);
    expect(described[0].parameters).toHaveProperty('properties.path');
  });

  it('可以在注册之前隐藏（入口的注册顺序不该被约束）', () => {
    const registry = new ToolRegistry(logger);
    registry.hide(['view_image']);
    registry.register(fakeTool('view_image'));

    expect(registry.getAllDescriptions()).toHaveLength(0);
    expect(registry.get('view_image')).toBeDefined();
  });

  it('重复注册同名工具直接报错，不静默覆盖', () => {
    const registry = new ToolRegistry(logger);
    registry.register(fakeTool('echo'));
    expect(() => registry.register(fakeTool('echo'))).toThrow('已注册');
  });
});
