// ============================================
// Tools 层:工具契约定义
// ============================================

import { z } from 'zod';
import { Logger } from '../platform/index.js';

// 工具可访问资源类型
//
// 'browser' **只给 screenshot 一个工具**:图片要经 ToolResult.attachments
// 才能进上下文,而 execute_python 只能回传 stdout —— 模型在代码里截了图自己看不见。
//
// 导航、定位元素、点击、DOM 提取一律走代码,不做工具:模型有 aria_snapshot
// 和截图,按站点差异自己找入口比框架猜选择器准,而且长尾无穷、覆盖不完。
// 见架构文档「浏览器是代码里的一个库,不是独立模块层」。
//
// request_help(暂停并交回控制权)**不需要**这个资源 —— 它不碰浏览器,
// needs 是空数组。
export type ResourceType = 'fs' | 'python' | 'browser' | 'http' | 'agent';

// 工具上下文:runner 组装、传给工具的"工具箱"
export interface ToolContext {
  sessionId: string;
  logger: Logger;
  signal: AbortSignal;
  confirm(request: ConfirmRequest): Promise<boolean>;
  executors: {
    fs?: unknown;      // 文件系统执行器
    python?: unknown;  // Python 沙箱执行器(CodeAct 的执行底座)
    browser?: unknown; // 常驻浏览器操作(BrowserOps),只给 screenshot
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
  // 子 agent 因步数上限提前收尾 → 结论可能不完整。
  // 必须一路传到主 agent:截断是嵌套的,中间任何一层吞掉这个信号,
  // 主 agent 就会把半成品当定论用
  truncated?: boolean;
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

// ============================================
// 工具附件(多模态回传)
// ============================================
//
// 为什么需要单独的字段、不能塞进 data:
// OpenAI 兼容接口的 `role:'tool'` 消息 content 只接受字符串,图片内容块只允许出现在
// user 消息里(DeepSeek 对 system/assistant 带图直接返回 400)。
// 所以工具"给模型看一张图"必须由框架另起一条 user 消息承载 ——
// 工具只声明"我产出了一张图",转成线格式由 adapter 负责,工具不碰厂商格式。
//
// 这也是模型唯一能"要求读图"的通路:它的输出只有文本和 tool_calls,
// 改不了请求体。于是流程是「模型调 view_image → 框架读盘编码 → 下一轮注入」。

export interface ImageAttachment {
  kind: 'image';
  /** 原始字节的 base64(不含 data: 前缀,前缀由 adapter 拼) */
  data: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  /** 来源标注,注入时作为文字说明,也用于压缩摘要和 trace 里替代 base64 */
  label: string;
  width?: number;
  height?: number;
  /** 'low' 让服务端先缩到 512×512,省 token;要看清小字用 'original' */
  detail?: 'low' | 'high' | 'original' | 'auto';
}

// 工具结果
export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  /**
   * 需要让模型"看见"的二进制产物。
   * 由 orchestrator 在写入工具结果后注入成 user 消息(见上方注释)。
   */
  attachments?: ImageAttachment[];
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
