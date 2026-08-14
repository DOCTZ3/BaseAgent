// ============================================
// Tools 层:工具契约定义
// ============================================

import { z } from 'zod';
import { Logger } from '../platform/index.js';

// 工具可访问资源类型
export type ResourceType = 'fs' | 'browser' | 'http';

// 工具上下文:runner 组装、传给工具的"工具箱"
export interface ToolContext {
  sessionId: string;
  logger: Logger;
  signal: AbortSignal;
  confirm(request: ConfirmRequest): Promise<boolean>;
  executors: {
    fs?: unknown;      // 文件系统执行器(后续实现)
    browser?: unknown; // 浏览器执行器(后续实现)
    http?: unknown;    // HTTP 客户端(后续实现)
  };
}

// 确认请求
export interface ConfirmRequest {
  reason: string;
  toolName: string;
  args: Record<string, unknown>;
}

// 工具调用
export interface ToolCall {
  id?: string;           // 可选的调用 ID(多并行调用时用)
  name: string;
  args: Record<string, unknown>;
}

// 工具结果
export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

// 工具参数定义(JSON Schema,用 Zod 生成)
export type ToolParameters = z.ZodObject<z.ZodRawShape>;

// 工具契约接口
export interface Tool {
  name: string;
  description: string;
  parameters: ToolParameters;
  needs: readonly ResourceType[];  // 声明需要的资源类型(只读数组)
  danger: boolean;        // 是否需要用户确认

  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

// 工具描述(喂给模型的说明书)
export interface ToolDescription {
  name: string;
  description: string;
  parameters: Record<string, unknown>;  // JSON Schema 格式
}
