// ============================================
// Tools 层:工具契约定义
// ============================================

import { z } from 'zod';
import { Logger } from '../platform/index.js';

// 工具可访问资源类型
//
// 'vision' 是**视觉插件**:配了视觉模型才注入。图片只进那个模型的请求,
// 主模型全程只收文字 —— 所以主模型是不是多模态与框架无关。
//
// 导航、定位元素、点击、DOM 提取一律走代码,不做工具:模型有 aria_snapshot
// 和截图,按站点差异自己找入口比框架猜选择器准,而且长尾无穷、覆盖不完。
// 见架构文档「浏览器是代码里的一个库,不是独立模块层」。
//
// request_help(暂停并交回控制权)**不需要**任何资源 —— 它不碰浏览器,
// needs 是空数组。
//
// 'shell' 是**装包等系统操作的正式通道**,只给 run_command(danger:true)。
// 它没有任何机制边界:Python 的写边界是进程内的 audit hook,shell 起的进程
// 根本不经过它。安全性全部来自那次人工确认 —— 见 run-command.ts 顶部。
export type ResourceType =
  | 'fs' | 'python' | 'shell' | 'browser' | 'http' | 'agent' | 'vision' | 'skill';

// 工具上下文:runner 组装、传给工具的"工具箱"
export interface ToolContext {
  sessionId: string;
  logger: Logger;
  signal: AbortSignal;
  confirm(request: ConfirmRequest): Promise<boolean>;
  executors: {
    fs?: unknown;      // 文件系统执行器
    python?: unknown;  // Python 沙箱执行器(CodeAct 的执行底座)
    shell?: unknown;   // Shell 执行器(外部程序,只给 run_command,每次人工确认)
    browser?: unknown; // 常驻浏览器操作(BrowserOps),只给 screenshot
    http?: unknown;    // HTTP 客户端(后续实现)
    agent?: SubAgentRunner;  // 子 agent 执行器(实现在 core 层,见下方接口注释)
    vision?: VisionAnalyzer; // 视觉插件(实现在 core 层,未配视觉模型时为 undefined)
    // skill 轨迹读取(实现在 core 层)。**只读** —— 写入是主 agent 的轮末动作,
    // 工具侧拿不到写方法(与子 agent 拿不到 spawn 同一条原则)
    skill?: SkillReader;
  };
}

// ============================================
// 视觉插件接口(实现在 core 层)
// ============================================
//
// 与 SubAgentRunner 同样的注入模式:接口声明在这里、实现放 core
// (它要用 LLMClient,而依赖方向是 core → tools → executors)。
//
// **数据流是反过来的**:不是「把图搬进主模型的上下文」,而是
// 「把图交给视觉模型、只把文字带回来」。主模型全程不接触像素,
// 因此主模型是不是多模态与框架无关 —— 这是「视觉即插件」的全部含义。
//
// 代价(已确认接受):主模型看不见它没问的东西,追问要重新发一次图。
// 收益:主模型可换成强文本模型,且**主上下文里再也没有图片** ——
// 之前实测的「每轮每图累积 200~240 token、历史截图每步重发」整块消失。

export interface VisionRequest {
  /** 图片原始字节的 base64(不含 data: 前缀,前缀由 adapter 拼) */
  data: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  /** 来源标注,进 trace 与日志 */
  label: string;
  /**
   * 主模型想知道什么。可选 —— 不给时让视觉模型做通用描述
   *
   * 给了明显更好:「验证码是什么」和「这页面为什么看起来是坏的」
   * 需要的描述完全不同,不告知就只能拿到泛泛描述,很可能恰好漏掉要点
   */
  question?: string;
  /** 'low' 让服务端先缩到 512×512(省视觉模型那边的 token);要看清小字用 'original' */
  detail?: 'low' | 'high' | 'original' | 'auto';
}

export interface VisionResult {
  ok: boolean;
  /** 视觉模型对这张图的观察(文字)。这就是会进主上下文的东西 */
  observation?: string;
  error?: string;
  usage?: { promptTokens: number; completionTokens: number };
}

export interface VisionAnalyzer {
  /** 看一张图并回答。失败不抛异常,以 ok:false 返回 */
  analyze(request: VisionRequest): Promise<VisionResult>;
  /** 视觉模型名,写进工具返回值让模型知道是谁看的 */
  readonly modelName: string;
}

// ============================================
// Skill 读取契约(实现在 core 层)
// ============================================
//
// 与 SubAgentRunner / VisionAnalyzer 同一个注入模式:接口在 tools,实现在 core。
//
// **只读**。写入是主 agent 的轮末动作(由 SkillManager 做),
// 工具侧拿不到任何写方法 —— 与「子 agent 拿不到 spawn」同一条原则:
// 能力从结构上不给,比靠约定不去用可靠。
//
// 这也是 skill 不需要 fs 授权的原因:正文由这个接口在 TS 侧读出来,
// 沙箱代码完全够不到 store。于是「模型不能改自己的行为规则」这条约束
// 靠结构就满足了,不用像 .agent-memory.db 那样靠「放在工作区外」来保证。

export interface SkillLookupResult {
  ok: boolean;
  /** 渲染好的轨迹正文(Markdown)。直接给模型看 */
  body?: string;
  error?: string;
  /** 库里现有的调用名 —— 取错名字时列出来,省一轮试错 */
  available?: string[];
}

export interface SkillReader {
  /** 按调用名取轨迹。取不到不抛异常,以 ok:false 返回并附可用名单 */
  load(name: string): SkillLookupResult;
}

// ============================================
// 子 Agent 执行器契约
// ============================================
//
// 只在这里定义接口,实现放 core/sub-agent.ts。
// 原因:子 agent 需要创建 Orchestrator(core 层),而依赖方向是
// core → tools → executors。把实现放 executors 会形成 executors → core 的反向依赖。
// 于是 tools 只认接口、不认实现,由会话装配注入 —— 与 fs 执行器同样的注入模式。

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

/**
 * 图片格式。视觉插件用它标注传给视觉模型的字节是什么格式
 *
 * 只列这四种:服务端按**内容**(magic bytes)判格式,支持的就这些,
 * 改名的 bmp 会直接 400 —— 所以工具层提前按内容判并给转换建议。
 */
export type ImageMime = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

// 工具结果
export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  /**
   * 视觉插件产出的观察文字
   *
   * 为什么不直接放 `data` 里:经工具桥调用时,`data` 会返回给 Python 代码 ——
   * 而模型**不会 print 它**(实测 trace 里连续三次裸调 `view_image(...)`,
   * 一次都没 print,它依赖框架投递)。那样视觉调用花了钱、观察却进不了上下文,
   * 且不报错。
   *
   * 所以文字与图片走同一套语义:**由框架投递,代码拿不到本体**。
   * 直接当工具调时它随结果 JSON 一起可见,经桥调时由 execute_python 带出来。
   */
  observations?: string[];
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
