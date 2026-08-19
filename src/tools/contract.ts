// ============================================
// Tools 层:工具契约定义
// ============================================

import { z } from 'zod';
import { Logger } from '../platform/index.js';

// 工具可访问资源类型
export type ResourceType = 'fs' | 'browser' | 'http' | 'agent';

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
    agent?: SubAgentRunner;  // 子 agent 执行器(实现在 core 层,见下方接口注释)
  };
}

// ============================================
// 子 Agent 执行器契约
// ============================================
//
// 只在这里定义接口,实现放 core/sub-agent.ts。
// 原因:子 agent 需要创建 Orchestrator(core 层),而依赖方向是
// core → tools → executors。把实现放 executors 会形成 executors → core 的反向依赖。
// 于是 tools 只认接口、不认实现,由入口(cli.ts)注入 —— 与 fs 执行器同样的注入模式。

export interface SubAgentRequest {
  task: string;       // 交给子 agent 的任务描述(必须自包含:子 agent 看不到主对话历史)
  context?: string;   // 可选背景信息,由主 agent 补充
}

export interface SubAgentResult {
  ok: boolean;
  answer?: string;    // 子 agent 的最终回答(本身即是对整个探索过程的蒸馏)
  error?: string;
  stats?: {
    subAgentId: string;
    steps: number;         // 实际执行的主循环步数
    llmCalls: number;      // LLM 调用次数
    promptTokens: number;  // 子 agent 最后一次调用的上下文大小
    completionTokens: number;
  };
}

export interface SubAgentRunner {
  /** 跑一个一次性子 agent。失败不抛异常,以 ok:false 返回 */
  run(request: SubAgentRequest): Promise<SubAgentResult>;
  /** 剩余可用配额(供工具在 description/错误信息里提示模型) */
  remainingQuota(): number;
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
