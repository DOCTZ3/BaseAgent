// ============================================
// Tools 层:工具执行器(runner)
// ============================================

import {
  Tool,
  ToolCall,
  ToolResult,
  ToolContext,
  ConfirmRequest,
  SubAgentRunner,
  VisionAnalyzer,
} from './contract.js';
import { ToolRegistry } from './registry.js';
import { Logger, ValidationError, SecurityError, ToolExecutionError, SecurityGuard, type FsGrant } from '../platform/index.js';
import { FsDriver, PythonExecutor, ShellExecutor, BrowserOps } from '../executors/index.js';

export interface RunnerConfig {
  sessionId: string;
  logger: Logger;
  /**
   * 取当前的中断信号 —— 是**函数**而不是 AbortSignal 本身
   *
   * AbortController 一旦 abort 就永久失效,而 ToolRunner 是会话级的(只建一次)。
   * 存一个 AbortSignal 的话:用户点过一次「停止」之后,这个会话里后续每次
   * 工具调用拿到的都是那个已中止的信号 —— 表现成「点过一次停止,
   * 之后什么都跑不了」,而且不报错,只是每个工具都立刻返回。
   * 取函数则每次现取,由 session 每轮换一个新的。
   */
  getSignal: () => AbortSignal;
  onConfirmRequired: (req: ConfirmRequest) => Promise<boolean>;
  allowDangerousTools: boolean;
  // 授权列表(带 ro/rw 档位)。未授权的路径读和写都会被拒
  fsGrants: FsGrant[];
  // 文件工具够不到的目录(优先于授权列表)。浏览器 profile 走这里:
  // 里面的 cookie 等价于活凭证,被 read_file 读进上下文会跟着 trace 落盘
  fsDeniedPaths?: string[];
  // 相对路径的解析基准,应为**工作区**。不给则退回 process.cwd()
  //
  // 必须与 Python 子进程的 cwd 同源:模型在代码里写 read_file("a.txt") 时,
  // 文件在工作区里(os.path.exists 为 True),但经工具桥回到 TS 后若按进程 cwd
  // (项目目录)解析,就变成了另一个文件 —— 实测被拒
  workspace?: string;
  // Python 沙箱执行器(CodeAct 底座)。未提供 = 代码执行未启用,
  // execute_python 会返回 ok:false 说明原因
  pythonExecutor?: PythonExecutor;
  // Shell 执行器(外部程序,如 pip/git)。未提供 = run_command 返回 ok:false。
  // 它没有机制边界,安全性来自 run_command 的 danger:true 人工确认
  shellExecutor?: ShellExecutor;
  // 常驻浏览器操作。未提供 = screenshot 返回 ok:false 说明原因
  browserOps?: BrowserOps;
  // 子 agent 执行器(实现在 core 层,由入口注入)。
  // 未提供 = 子 agent 功能未启用,spawn 工具会返回 ok:false 说明原因
  subAgentRunner?: SubAgentRunner;
  // 视觉插件(实现在 core 层,由入口注入)。
  // 未提供 = 未配 VISION_MODEL,入口那边根本不会注册看图类工具
  visionAnalyzer?: VisionAnalyzer;
}

/**
 * 可被子 agent 继承的部分(资源 + 安全边界)
 *
 * 单独抽成一个对象,而不是让子 agent 逐字段转发 —— **逐字段转发实测会漏**:
 * 本次开发里先漏了 `visionAnalyzer`,又漏了 `pythonExecutor`,
 * 后者让子 agent 的 `execute_python` 每次都返回「未初始化」,
 * 它以为是自己代码的问题,连跑 `print("hello")` 探活,白烧十几步才放弃。
 *
 * 抽成一个对象后入口只构造一次、主 runner 与子 agent 共用同一份,
 * 「新增执行器忘了给子 agent」这个失败模式从结构上消失。
 *
 * **刻意不含 `subAgentRunner`**:子 agent 拿不到 spawn 能力,结构上无递归。
 * 也不含 sessionId / logger —— 那两个每个 agent 各不相同。
 */
export type InheritableRunnerConfig = Pick<
  RunnerConfig,
  | 'allowDangerousTools'
  | 'fsGrants'
  | 'fsDeniedPaths'
  | 'workspace'
  | 'pythonExecutor'
  | 'shellExecutor'
  | 'browserOps'
  | 'visionAnalyzer'
>;

export class ToolRunner {
  private fsDriver: FsDriver;

  constructor(
    private registry: ToolRegistry,
    private config: RunnerConfig,
  ) {
    // 初始化文件系统执行器(授权列表 + 凭证目录黑名单 + 相对路径基准)
    const securityGuard = new SecurityGuard(
      config.fsGrants,
      config.fsDeniedPaths ?? [],
      config.workspace,
    );
    this.fsDriver = new FsDriver(securityGuard);
  }

  async run(toolCall: ToolCall): Promise<ToolResult> {
    const { name, args } = toolCall;
    const tool = this.registry.get(name);

    if (!tool) {
      return {
        ok: false,
        error: `工具 ${name} 未注册`,
      };
    }

    try {
      // ① 校验参数
      const parseResult = tool.parameters.safeParse(args);
      if (!parseResult.success) {
        throw new ValidationError(
          `参数校验失败: ${parseResult.error.message}`
        );
      }

      // ② 危险工具确认
      if (tool.danger && this.config.allowDangerousTools) {
        const confirmed = await this.config.onConfirmRequired({
          reason: `工具 ${name} 需要确认`,
          toolName: name,
          args,
        });
        if (!confirmed) {
          return {
            ok: false,
            error: '用户拒绝执行',
          };
        }
      } else if (tool.danger && !this.config.allowDangerousTools) {
        throw new SecurityError(`危险工具 ${name} 已被禁用`);
      }

      // ③ 组装 ctx(按 needs 注入资源)
      const ctx = this.buildContext(tool);

      // ④ 执行工具
      this.config.logger.info(`执行工具: ${name}`, { args });
      const result = await tool.run(parseResult.data, ctx);

      return result;

    } catch (error) {
      this.config.logger.error(`工具执行失败: ${name}`, { error });

      if (error instanceof ValidationError || error instanceof SecurityError) {
        return { ok: false, error: error.message };
      }

      return {
        ok: false,
        error: error instanceof Error ? error.message : '未知错误',
      };
    }
  }

  private buildContext(tool: Tool): ToolContext {
    // 按 needs 注入执行器
    const executors: ToolContext['executors'] = {};

    for (const need of tool.needs) {
      if (need === 'fs') {
        executors.fs = this.fsDriver;
      } else if (need === 'python') {
        // 由入口注入。未注入时保持 undefined，工具自己返回 ok:false 报「未启用」
        executors.python = this.config.pythonExecutor;
      } else if (need === 'shell') {
        // 外部程序通道。未注入时工具报「未初始化」——
        // 它没有机制边界,靠 run_command 的 danger:true 人工确认兜住
        executors.shell = this.config.shellExecutor;
      } else if (need === 'browser') {
        // 常驻浏览器操作。同样由入口注入，未注入时工具报「未启用」
        executors.browser = this.config.browserOps;
      } else if (need === 'http') {
        executors.http = null; // 占位
      } else if (need === 'agent') {
        // 子 agent 执行器由入口注入（实现在 core 层，tools 只认接口）。
        // 未注入时保持 undefined，工具自己返回 ok:false 报「未启用」
        executors.agent = this.config.subAgentRunner;
      } else if (need === 'vision') {
        // 视觉插件由入口注入（实现在 core 层，要用 LLMClient）。
        // 未配 VISION_MODEL 时入口根本不注册看图类工具，所以这里通常不会是 undefined
        executors.vision = this.config.visionAnalyzer;
      }
    }

    return {
      sessionId: this.config.sessionId,
      logger: this.config.logger,
      // 现取:buildContext 每次工具调用都会跑,所以拿到的总是本轮那个
      signal: this.config.getSignal(),
      confirm: this.config.onConfirmRequired,
      executors,
    };
  }
}
