// ============================================
// Turn 平铺存储 —— 重建保真性测试
// ============================================
//
// 这批测试针对两个**真实发生过**的丢数据 bug，旧的分组结构下必然失败：
//   ① addAssistantMessage 只存 reasoning + tool_calls，丢掉 content，
//      重建时硬写 ''  → 模型调工具时同时说的话在压缩后全部消失
//   ② 工具产出的图片要另起一条 user 消息承载（tool 消息 content 只能是字符串），
//      而旧结构 user_message 是单数字段装不下 → Mid-Turn 压缩时图片被静默丢弃，
//      但 tool 响应还写着「图片已附加」，模型会基于不存在的观察作答
//
// 所以断言的重点不是「跑通」，而是**重建出来的消息和写进去的一模一样**。
// ============================================

import { describe, it, expect, vi } from 'vitest';
import { ContextManager, turnUserMessage, turnFinalResponse, type Turn } from './context.js';
import type { ContentPart } from './llm-client.js';
import { ConsoleLogger, LogLevel } from '../platform/index.js';

const IMG: ContentPart = {
  type: 'image',
  data: 'aGVsbG8=',
  mimeType: 'image/png',
  label: 'shot.png',
  width: 800,
  height: 600,
};

function makeContext() {
  return new ContextManager(
    {
      sessionId: `t-${Math.random().toString(36).slice(2, 8)}`,
      windowSize: 1_000_000,
      compressionThreshold: 0.7,
      recentTurnsToKeep: 10,
      maxTopicsInContext: 10,
      logger: new ConsoleLogger(LogLevel.ERROR),
    },
    { complete: vi.fn() } as never,
  );
}

describe('Turn 平铺存储', () => {
  describe('① assistant 的 content 不再丢失', () => {
    it('调工具时同时说的话被完整保留', async () => {
      const ctx = makeContext();
      await ctx.addUserMessage('看一下这个文件');
      // 模型常见行为：一边说话一边调工具
      ctx.addAssistantMessage('我先读一下文件内容，然后再分析。', [
        { id: 'c1', name: 'read_file', args: { path: 'a.ts' } },
      ], '需要先拿到文件');
      ctx.addToolResult('c1', '{"ok":true}');
      ctx.addFinalResponse('文件里是一个工具类。');

      const msgs = ctx.peekMessages();
      const assistant = msgs.find(m => m.role === 'assistant' && m.toolCalls?.length);

      expect(assistant).toBeDefined();
      // 旧结构这里是 ''
      expect(assistant!.content).toBe('我先读一下文件内容，然后再分析。');
      expect((assistant as any).reasoning).toBe('需要先拿到文件');
    });

    it('reasoning 与 tool_calls 一并保留', async () => {
      const ctx = makeContext();
      await ctx.addUserMessage('并行读两个文件');
      ctx.addAssistantMessage('同时读取两个文件。', [
        { id: 'c1', name: 'read_file', args: { path: 'a.ts' } },
        { id: 'c2', name: 'read_file', args: { path: 'b.ts' } },
      ]);
      ctx.addToolResult('c1', 'A');
      ctx.addToolResult('c2', 'B');

      const assistant = ctx.peekMessages().find(m => m.role === 'assistant')!;
      expect(assistant.toolCalls).toHaveLength(2);
      expect(assistant.toolCalls!.map(t => t.id)).toEqual(['c1', 'c2']);
    });
  });

  describe('② 工具观察（图片）进入 Turn', () => {
    it('addObservation 不开启新 Turn', async () => {
      const ctx = makeContext();
      await ctx.addUserMessage('看截图');
      ctx.addAssistantMessage('', [{ id: 'c1', name: 'view_image', args: {} }]);
      ctx.addToolResult('c1', '{"ok":true,"note":"图片已附加"}');
      ctx.addObservation([{ type: 'text', text: '以下是图片：' }, IMG]);
      ctx.addFinalResponse('图里是一个登录页。');

      // 关键：整段仍是同一个 Turn，没被图片劈成两半
      expect(ctx.getStats().turns).toBe(0);   // 尚未 finalize
      await ctx.addUserMessage('下一个问题');  // 触发 finalize
      expect(ctx.getStats().turns).toBe(1);
    });

    it('图片消息排在所有 tool 响应之后（配对不被打断）', async () => {
      const ctx = makeContext();
      await ctx.addUserMessage('读文件并截图');
      ctx.addAssistantMessage('', [
        { id: 'c1', name: 'list_files', args: {} },
        { id: 'c2', name: 'view_image', args: {} },
      ]);
      ctx.addToolResult('c1', '["a.ts"]');
      ctx.addToolResult('c2', '{"ok":true,"note":"图片已附加"}');
      ctx.addObservation([IMG]);

      const roles = ctx.peekMessages().map(m => m.role);
      // user, assistant, tool, tool, user —— 图片在 2/2 配对完成之后
      expect(roles).toEqual(['user', 'assistant', 'tool', 'tool', 'user']);
    });

    it('Mid-Turn 取出消息时图片不丢', async () => {
      // 这是 bug ② 的核心场景：压缩落在「看了图但还没回答」的时刻
      const ctx = makeContext();
      await ctx.addUserMessage('看截图');
      ctx.addAssistantMessage('', [{ id: 'c1', name: 'view_image', args: {} }]);
      ctx.addToolResult('c1', '{"ok":true,"note":"图片已附加"}');
      ctx.addObservation([{ type: 'text', text: '图片：' }, IMG]);

      const before = ctx.peekMessages().length;
      const restored = await ctx.preparePrompt();

      // 旧实现从 Turn 结构重建，图片不在里面 → 这里会少一条
      expect(restored).toHaveLength(before);
      const imgMsg = restored.find(
        m => m.role === 'user' && Array.isArray(m.content) &&
             m.content.some(p => p.type === 'image')
      );
      expect(imgMsg).toBeDefined();
    });
  });

  describe('Turn 边界与取值helper', () => {
    it('首条必为用户提问，中途 user 不算新轮', async () => {
      const ctx = makeContext();
      await ctx.addUserMessage('问题一');
      ctx.addAssistantMessage('', [{ id: 'c1', name: 'view_image', args: {} }]);
      ctx.addToolResult('c1', 'ok');
      ctx.addObservation([IMG]);
      ctx.addFinalResponse('答案一');
      await ctx.addUserMessage('问题二');

      const turns = (ctx as any).turns as Turn[];
      expect(turns).toHaveLength(1);
      expect(turnUserMessage(turns[0])!.content).toBe('问题一');
      expect(turnFinalResponse(turns[0])!.content).toBe('答案一');
      // 一轮内两条 user：提问 + 观察
      expect(turns[0].messages.filter(m => m.role === 'user')).toHaveLength(2);
    });

    it('带 tool_calls 的 assistant 不被当作最终回答', async () => {
      const ctx = makeContext();
      await ctx.addUserMessage('x');
      ctx.addAssistantMessage('思考中', [{ id: 'c1', name: 'f', args: {} }]);
      ctx.addToolResult('c1', 'r');
      await ctx.addUserMessage('y');

      const turns = (ctx as any).turns as Turn[];
      // 跑满步数 / 无最终回答的轮次是合法的，不该误认成有答案
      expect(turnFinalResponse(turns[0])).toBeUndefined();
    });

    it('只有提问没有任何 assistant 响应 → 轮次不完整，不入库', async () => {
      const ctx = makeContext();
      await ctx.addUserMessage('孤立提问');
      await ctx.addUserMessage('下一条');

      expect((ctx as any).turns).toHaveLength(0);
    });
  });

  describe('压缩渲染区分「用户提问」与「工具观察」', () => {
    it('中途的 user 消息标注为工具观察，不冒充用户发言', async () => {
      // 混为一谈会让压缩模型把截图写成「用户说过的话」——注入假事实
      const ctx = makeContext();
      await ctx.addUserMessage('看截图');
      ctx.addAssistantMessage('', [{ id: 'c1', name: 'view_image', args: {} }]);
      ctx.addToolResult('c1', '{"ok":true}');
      ctx.addObservation([{ type: 'text', text: '这是截图' }, IMG]);
      ctx.addFinalResponse('是登录页');
      await ctx.addUserMessage('next');

      const turn = ((ctx as any).turns as Turn[])[0];
      const trace: string = (ctx as any).renderTurnTrace(turn, false);

      expect(trace).toContain('用户: 看截图');
      expect(trace).toContain('工具观察:');
      // base64 绝不能进压缩输入
      expect(trace).not.toContain('aGVsbG8=');
      expect(trace).toContain('[图片 shot.png 800x600]');
      expect(trace).toContain('助手回答: 是登录页');
    });

    it('工具结果按 tool_call_id 标注工具名（并行时不错位）', async () => {
      const ctx = makeContext();
      await ctx.addUserMessage('并行调用');
      ctx.addAssistantMessage('', [
        { id: 'c1', name: 'list_files', args: {} },
        { id: 'c2', name: 'read_file', args: { path: 'a.ts' } },
      ]);
      // 刻意乱序返回：按下标配对会张冠李戴
      ctx.addToolResult('c2', 'FILE_CONTENT');
      ctx.addToolResult('c1', 'DIR_LISTING');
      ctx.addFinalResponse('done');
      await ctx.addUserMessage('next');

      const turn = ((ctx as any).turns as Turn[])[0];
      const trace: string = (ctx as any).renderTurnTrace(turn, false);

      expect(trace).toContain('工具结果(read_file): FILE_CONTENT');
      expect(trace).toContain('工具结果(list_files): DIR_LISTING');
    });
  });

  describe('flattenTurns 保真', () => {
    it('压缩后重建的消息与原始逐条一致', async () => {
      const ctx = makeContext();
      await ctx.addUserMessage('问题');
      ctx.addAssistantMessage('我来查一下', [{ id: 'c1', name: 'f', args: { a: 1 } }], '推理');
      ctx.addToolResult('c1', '结果');
      ctx.addObservation([{ type: 'text', text: '图：' }, IMG]);
      ctx.addFinalResponse('答案');
      await ctx.addUserMessage('next');

      const turn = ((ctx as any).turns as Turn[])[0];
      const rebuilt = (ctx as any).flattenTurns([turn]);

      expect(rebuilt).toEqual(turn.messages);
      expect(rebuilt.map((m: any) => m.role))
        .toEqual(['user', 'assistant', 'tool', 'user', 'assistant']);
    });
  });
});
