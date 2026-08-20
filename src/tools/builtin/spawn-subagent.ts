// ============================================
// 内置工具:下放子任务给子 agent
// ============================================
//
// 模型的自主决策入口:需要吞大量上下文的子任务交给子 agent 跑,
// 主 agent 只收到一段回答。框架不预设哪类任务必须下放,决策权在模型 ——
// 所以 description 必须把「适用场景」和「代价」都写清楚,模型才能判断。
// ============================================

import { z } from 'zod';
import { Tool, ToolContext, ToolResult, SubAgentRunner } from '../index.js';

export class SpawnSubAgentTool implements Tool {
  name = 'spawn_subagent';

  description =
    '把一个子任务交给独立的子 agent 执行,只拿回它的最终结论。\n' +
    '适用:需要读取大量内容才能得出结论的任务(遍历目录逐个读文件、批量搜索比对、' +
    '汇总多处信息)。这类任务若直接在当前对话里做,读到的原始内容会占满上下文。\n' +
    '代价:子 agent **看不到**当前对话历史,task 必须自包含 —— 把它需要的背景、' +
    '路径、判断标准都写进去。它只返回一段文字结论,中间读到的原始内容不会传回来,' +
    '所以要在 task 里说清你需要哪些具体信息。\n' +
    '不适用:一两次工具调用就能完成的事(直接自己调更快)。';

  parameters = z.object({
    task: z
      .string()
      .min(10)
      .describe('自包含的任务描述。要写清目标、范围和期望产出的具体信息'),
    context: z
      .string()
      .optional()
      .describe('可选:子 agent 需要但无法自行获取的背景信息'),
  });

  needs = ['agent'] as const;
  danger = false;  // 子 agent 内部的危险工具仍会各自触发确认

  async run(
    args: { task: string; context?: string },
    ctx: ToolContext
  ): Promise<ToolResult> {
    const runner = ctx.executors.agent as SubAgentRunner | undefined;

    if (!runner) {
      return {
        ok: false,
        error: '子 agent 功能未启用(未注入执行器)。请直接使用其他工具完成任务。',
      };
    }

    const result = await runner.run({ task: args.task, context: args.context });

    if (!result.ok) {
      // 失败原因原样回流,让模型自行改道(配额用尽/被取消/内部报错)
      return { ok: false, error: result.error ?? '子 agent 执行失败' };
    }

    return {
      ok: true,
      data: {
        answer: result.answer,
        // 截断信号必须透给模型:布尔字段供代码判断,note 供模型读
        // ——一个布尔值埋在长 JSON 里模型容易扫过去。
        // note 刻意不含重试建议:新子 agent 是全新上下文,不知道上一个读到哪,
        // 大概率用相似范围重跑、撞同一面墙。是否补齐由模型看着「未完成部分」自己判断
        ...(result.truncated
          ? {
              truncated: true,
              note:
                '该子 agent 因达到步数上限提前收尾,上面的结论可能不完整。' +
                '请参考它自述的「未完成部分」再决定下一步。',
            }
          : {}),
        // 暴露统计让模型(和 trace)知道这次下放的成本
        sub_agent: result.stats,
        remaining_quota: runner.remainingQuota(),
      },
    };
  }
}
