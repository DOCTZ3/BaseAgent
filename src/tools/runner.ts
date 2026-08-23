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
} from './contract.js';
import { ToolRegistry } from './registry.js';
import { Logger, ValidationError, SecurityError, ToolExecutionError, SecurityGuard, type FsGrant } from '../platform/index.js';
import { FsDriver, PythonExecutor } from '../executors/index.js';

export interface RunnerConfig {
  sessionId: string;
  logger: Logger;
  signal: AbortSignal;
  onConfirmRequired: (req: ConfirmRequest) => Promise<boolean>;
  allowDangerousTools: boolean;
  // 授权列表(带 ro/rw 档位)。未授权的路径读和写都会被拒
  fsGrants: FsGrant[];
  // 文件工具够不到的目录(优先于授权列表)。浏览器 profile 走这里:
  // 里面的 cookie 等价于活凭证,被 read_file 读进上下文会跟着 trace 落盘
  fsDeniedPaths?: string[];
  // Python 沙箱执行器(CodeAct 底座)。未提供 = 代码执行未启用,
  // execute_python 会返回 ok:false 说明原因
  pythonExecutor?: PythonExecutor;
  // 子 agent 执行器(实现在 core 层,由入口注入)。
  // 未提供 = 子 agent 功能未启用,spawn 工具会返回 ok:false 说明原因
  subAgentRunner?: SubAgentRunner;
}

export class ToolRunner {
  private fsDriver: FsDriver;

  constructor(
    private registry: ToolRegistry,
    private config: RunnerConfig,
  ) {
    // 初始化文件系统执行器(授权列表 + 凭证目录黑名单)
    const securityGuard = new SecurityGuard(
      config.fsGrants,
      config.fsDeniedPaths ?? [],
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
      } else if (need === 'http') {
        executors.http = null; // 占位
      } else if (need === 'agent') {
        // 子 agent 执行器由入口注入（实现在 core 层，tools 只认接口）。
        // 未注入时保持 undefined，工具自己返回 ok:false 报「未启用」
        executors.agent = this.config.subAgentRunner;
      }
    }

    return {
      sessionId: this.config.sessionId,
      logger: this.config.logger,
      signal: this.config.signal,
      confirm: this.config.onConfirmRequired,
      executors,
    };
  }
}
