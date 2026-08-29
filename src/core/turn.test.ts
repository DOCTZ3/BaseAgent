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

  // ============================================
  // peekTurns 必须含进行中那一轮
  // ============================================
  //
  // finalizeTurn() 只在 addUserMessage() 里调 —— 一个轮次要等**下一条用户消息**
  // 才进 this.turns。而长期记忆抽取发生在轮末,那一刻刚结束的轮次还挂在
  // currentTurn 上。只返回 this.turns 的话:抽取器永远看不到最新一轮
  // (最新鲜的证据),且第一轮结束时拿到空数组、直接 early return。
  // 这个 bug 单元测试测不出来 —— memory-manager 的测试直接喂构造好的 Turn[],
  // 绕过了这一层。所以断言放在这里。
  describe('peekTurns 含进行中那一轮', () => {
    it('第一轮答完就能被看到(不必等下一条用户消息)', async () => {
      const ctx = makeContext();
      await ctx.addUserMessage('第一个问题');
      ctx.addAssistantMessage('思考中', [{ id: 'c1', name: 'f', args: {} }]);
      ctx.addToolResult('c1', 'ok');
      ctx.addFinalResponse('答案');

      const turns = ctx.peekTurns();
      expect(turns).toHaveLength(1);
      expect(turnUserMessage(turns[0])?.content).toBe('第一个问题');
    });

    it('只有用户提问、模型还没答时不算一轮 —— 判据与 finalizeTurn 同源', async () => {
      const ctx = makeContext();
      await ctx.addUserMessage('刚问出去');

      expect(ctx.peekTurns()).toHaveLength(0);
    });

    it('下一轮开始后不重复计数', async () => {
      const ctx = makeContext();
      await ctx.addUserMessage('第一轮');
      ctx.addAssistantMessage('答');
      ctx.addFinalResponse('答案一');
      expect(ctx.peekTurns()).toHaveLength(1);

      // 新一轮:上一轮进 turns,这一轮还没有 assistant
      await ctx.addUserMessage('第二轮');
      expect(ctx.peekTurns()).toHaveLength(1);

      ctx.addAssistantMessage('答');
      ctx.addFinalResponse('答案二');
      expect(ctx.peekTurns()).toHaveLength(2);
    });

    it('返回的是快照,调用方改不动内部状态', async () => {
      const ctx = makeContext();
      await ctx.addUserMessage('问题');
      ctx.addAssistantMessage('答');
      ctx.addFinalResponse('答案');

      const first = ctx.peekTurns();
      (first as Turn[]).push({ turn_id: 99, messages: [], timestamp: 0 });

      expect(ctx.peekTurns()).toHaveLength(1);
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

// ============================================
// discardCurrentTurn —— 中断的轮次不留痕
// ============================================
//
// 用户点停止后那一轮**整轮丢掉**。不丢的两个后果都不报错:
//
// ① peekTurns() 会把「已有 assistant 消息」的 currentTurn 也算进去,
//    于是跑过几步工具再停的轮次被写进 turns.jsonl —— 一条没有结论的
//    半截历史,而文件里没有任何东西标明它是被打断的。
// ② 留在内存里的话,下一轮 addUserMessage() 会 finalizeTurn() 把它封进 turns。
//    模型于是看到「提问 → 调了几个工具 → 没有结论」,很可能以为自己上次
//    没答完而接着干 —— 而用户停它恰恰是不想要那个结果。
// ============================================
describe('discardCurrentTurn', () => {
  it('把本轮消息从 messages 里全部移除,系统消息不受影响', async () => {
    const ctx = makeContext();
    ctx.addSystemMessage('系统提示');
    await ctx.addUserMessage('问题');
    ctx.addAssistantMessage('我来查', [{ id: 'c1', name: 'f', args: {} }]);
    ctx.addToolResult('c1', '结果');

    expect(ctx.peekMessages()).toHaveLength(4);

    ctx.discardCurrentTurn();

    const left = ctx.peekMessages();
    expect(left).toHaveLength(1);
    expect(left[0].role).toBe('system');
  });

  it('丢弃后 peekTurns 不再包含它 —— 这是不落盘的关键', async () => {
    // persistNewTurns() 遍历的就是 peekTurns()。它把有 assistant 消息的
    // currentTurn 也算进去,所以「跑过几步工具再停」的轮次原本会被写进文件
    const ctx = makeContext();
    await ctx.addUserMessage('问题');
    ctx.addAssistantMessage('我来查', [{ id: 'c1', name: 'f', args: {} }]);
    ctx.addToolResult('c1', '结果');

    expect(ctx.peekTurns()).toHaveLength(1);   // 丢弃前:会被落盘

    ctx.discardCurrentTurn();
    expect(ctx.peekTurns()).toHaveLength(0);
  });

  it('下一轮不会把丢弃的轮次封进 turns —— 模型看不到半截历史', async () => {
    const ctx = makeContext();
    await ctx.addUserMessage('被中断的问题');
    ctx.addAssistantMessage('查了一半', [{ id: 'c1', name: 'f', args: {} }]);
    ctx.addToolResult('c1', '结果');
    ctx.discardCurrentTurn();

    // 下一轮:addUserMessage 会 finalizeTurn(),而那时已经没有 currentTurn 了
    await ctx.addUserMessage('新问题');
    ctx.addFinalResponse('答案');
    await ctx.addUserMessage('第三轮');

    const turns = ctx.peekTurns();
    expect(turns).toHaveLength(1);
    // turnUserMessage 返回 Message 而不是字符串
    expect(turnUserMessage(turns[0])?.content).toBe('新问题');
  });

  it('turn_id **不回退** —— 回退会造成撞号(压缩那个 bug 的同一形状)', async () => {
    // 留个空号无害;而回退会让下一轮拿到同一个 id,
    // 后果是归档文件互相覆盖、主题映射错乱,全部静默
    const ctx = makeContext();
    await ctx.addUserMessage('第一轮');
    ctx.addFinalResponse('答案');
    await ctx.addUserMessage('第二轮');       // turn_id = 2
    ctx.addAssistantMessage('查一半', [{ id: 'c1', name: 'f', args: {} }]);
    ctx.discardCurrentTurn();                 // 丢掉 2

    await ctx.addUserMessage('第三轮');
    const current = (ctx as any).currentTurn as Turn;
    expect(current.turn_id).toBe(3);          // 不是 2
  });

  it('已完成的轮次不受影响 —— 只丢当前那一轮', async () => {
    const ctx = makeContext();
    await ctx.addUserMessage('第一轮');
    ctx.addFinalResponse('答案一');
    await ctx.addUserMessage('第二轮');       // 第一轮在此入库
    ctx.addAssistantMessage('查一半', [{ id: 'c1', name: 'f', args: {} }]);

    ctx.discardCurrentTurn();

    const turns = ctx.peekTurns();
    expect(turns).toHaveLength(1);
    expect(turnFinalResponse(turns[0])?.content).toBe('答案一');
    // 第一轮的消息还在
    expect(ctx.peekMessages().map(m => m.role)).toEqual(['user', 'assistant']);
  });

  it('没有 currentTurn 时是 no-op —— 中断可能发生在第一次请求之前', async () => {
    const ctx = makeContext();
    expect(() => ctx.discardCurrentTurn()).not.toThrow();

    // 连续调也安全:abort 分支不保证只走一次
    await ctx.addUserMessage('问题');
    ctx.discardCurrentTurn();
    expect(() => ctx.discardCurrentTurn()).not.toThrow();
    expect(ctx.peekMessages()).toHaveLength(0);
  });

  it('按**对象身份**移除,messages 被重排也正确 —— 压缩会重建那个数组', async () => {
    // 压缩把 this.messages 整个重建、再把 currentTurn 的消息追加到末尾。
    // 按位置截尾的实现在压缩发生过之后就会切错行 —— 而那不报错,
    // 只表现成「历史里多出或少了几条消息」
    const ctx = makeContext();
    ctx.addSystemMessage('系统');
    await ctx.addUserMessage('问题');
    ctx.addAssistantMessage('查一半', [{ id: 'c1', name: 'f', args: {} }]);

    // 模拟压缩重建:顺序变了,但对象还是同一批引用
    const msgs = (ctx as any).messages as any[];
    (ctx as any).messages = [msgs[1], msgs[0], msgs[2]];

    ctx.discardCurrentTurn();

    const left = ctx.peekMessages();
    expect(left).toHaveLength(1);
    expect(left[0].role).toBe('system');
  });
});
