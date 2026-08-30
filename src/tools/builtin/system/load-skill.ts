// ============================================
// 系统工具:取出一条 skill 轨迹
// ============================================
//
// 为什么用工具而不是把正文塞进系统提示:
//
// ① **prompt cache**。系统提示是缓存前缀里最稳定的部分(实测命中率 60~77%)。
//    每轮注入不同的 skill 正文会让整段前缀失效 —— 那个代价比多一次
//    工具调用大得多。所以提示里只放索引(名字 + 一行描述),正文按需取。
//
// ② **权限**。正文由 SkillReader 在 TS 侧读出来,沙箱代码完全够不到 store,
//    不需要给 skill 加任何 fs 授权。「模型不能改自己的行为规则」这条约束
//    靠结构就满足了(对比 .agent-memory.db 要靠「放在工作区外」来保证)。
//
// ③ **可见性**。走工具通道会产生 tool_start / tool_end 事件,
//    界面上能看到「加载了哪个 skill」,trace 里也留痕。
//    两条相似 skill 竞争时模型选了哪个是可审计的。
//
// **不受 converged 影响**,两种模式下都注册。收敛针对的是「能力重复」——
// 工具和等价代码两条路,而实测两条都开时模型一律选工具。
// 但 skill store 从沙箱不可达,`execute_python` 里没有任何办法拿到轨迹,
// 所以不存在第二条路,收敛的前提不成立。

import { z } from 'zod';
import { Tool, ToolContext, ToolResult, SkillReader } from '../../contract.js';

export class LoadSkillTool implements Tool {
  name = 'load_skill';
  description =
    '取出一条已记录的任务轨迹(步骤 + 已知的坑)。系统提示的「可用技能」一节列出了' +
    '所有调用名与适用场景,遇到相似任务时先取轨迹再动手,比自己摸索快且少踩坑。' +
    '轨迹里的「做法」可能已过期,走不通时按「目标」自己重新找路。';

  parameters = z.object({
    name: z.string().describe('技能调用名,取自系统提示「可用技能」一节'),
  });

  needs = ['skill'] as const;
  danger = false;  // 只读一段文本,没有副作用

  async run(args: { name: string }, ctx: ToolContext): Promise<ToolResult> {
    const reader = ctx.executors.skill as SkillReader | undefined;

    if (!reader) {
      return {
        ok: false,
        error: '技能库未启用(SKILL_ENABLED=false 或存储不可用)。请直接按自己的判断执行任务。',
      };
    }

    const result = reader.load(args.name);

    if (!result.ok) {
      // 取错名字时把可用名单一并给出 —— 省一轮试错。
      // 只报「没找到」的话模型会去猜第二个名字,而猜错的代价是又一次
      // round trip(按实测首字延迟地板 5.79s,那是 6~12 秒)
      return {
        ok: false,
        error: result.error ?? '未找到该技能',
        data: result.available?.length ? { available: result.available } : undefined,
      };
    }

    ctx.logger.info('已加载技能轨迹', { skill: args.name });

    return {
      ok: true,
      data: {
        name: args.name,
        // 正文原样给模型。渲染在 core 层做(renderSkillBody)——
        // 格式规则只能有一份,工具这边不重新拼
        trajectory: result.body,
      },
    };
  }
}
