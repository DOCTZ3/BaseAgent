// ============================================
// 原型阶段的假事件流 —— 只为「双击 index.html 就能看界面」而存在
// ============================================
//
// 它实现的是 app.js 依赖的那个契约,一共两条:
//   AgentTransport.run(text, onEvent) → Promise<{ stopReason, answer }>
//   AgentTransport.abort?.()
//
// 接上 server 之后**整份删掉**,换成 sse.js 实现同一个契约。
// app.js 一行不改 —— 这正是把渲染层和传输层分开的意义。
//
// 脚本刻意覆盖四种真实形态,因为它们的渲染路径不同:
//   ① 纯问答:只有 reasoning + content
//   ② 带工具:content 空 → tool_start → tool_end → 下一步才有正文
//   ③ 工具失败:tool_end 的 ok:false
//   ④ 需要确认:走 AgentConfirm.ask(),拒绝时工具返回失败
// ============================================

(() => {
  'use strict';

  // 在 Electron 里就让位给 bridge.js。不判这一下,mock 会覆盖掉真实的
  // AgentTransport —— 界面看着正常,但一个字都没真的发给模型
  if (window.AgentBridge) return;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /** 逐字吐 —— 模拟流式的手感,标点后停顿长一点 */
  async function typeOut(text, emit, kind) {
    for (const ch of text) {
      emit({ type: kind, text: ch });
      await sleep(/[。，、！？；：\n]/.test(ch) ? 42 : 14);
    }
  }

  let aborted = false;

  // 轮到第几次调用 —— 让连续几轮展示不同形态,而不是每次都一样
  let round = 0;

  window.AgentTransport = {
    abort() { aborted = true; },

    async run(input, emit) {
      aborted = false;
      round++;

      // 第 2 轮演示「需要确认的危险工具」,其余轮次演示常规带工具的流程
      const wantsConfirm = round % 3 === 2;

      await sleep(300);
      if (aborted) throw new Error('已中断');

      await typeOut(
        `用户要求:${input}\n先判断需要哪些信息。这一步不需要工具,先想清楚范围再动手。`,
        emit, 'reasoning',
      );

      await sleep(200);

      // ---- 第 1 步:调一个工具 ----
      emit({ type: 'step', step: 2, maxSteps: 20 });
      emit({ type: 'tool_start', id: 't1', name: 'execute_python', args: {} });
      await sleep(1400);
      if (aborted) throw new Error('已中断');
      emit({
        type: 'tool_end', id: 't1', name: 'execute_python', ok: true,
        summary: '共 42 行,已写入 out/result.csv',
      });

      // ---- 第 2 步:一个失败的工具 ----
      await sleep(400);
      emit({ type: 'step', step: 3, maxSteps: 20 });
      emit({ type: 'tool_start', id: 't2', name: 'read_file', args: {} });
      await sleep(900);
      emit({
        type: 'tool_end', id: 't2', name: 'read_file', ok: false,
        summary: 'BLOCKED: 该路径在读黑名单内(凭证类)',
      });

      // ---- 第 3 步:需要确认的危险工具 ----
      if (wantsConfirm) {
        await sleep(400);
        emit({ type: 'step', step: 4, maxSteps: 20 });
        const allowed = await window.AgentConfirm.ask({
          toolName: 'run_command',
          // 反斜杠必须原样显示。被双写就等于骗了用户 —— CLI 那边有专门的测试锁这一点
          args: { command: 'python C:\\Users\\me\\scripts\\build.py --out D:\\tmp\\a.txt' },
        });
        emit({ type: 'tool_start', id: 't3', name: 'run_command', args: {} });
        await sleep(allowed ? 1200 : 200);
        emit({
          type: 'tool_end', id: 't3', name: 'run_command', ok: allowed,
          summary: allowed ? 'exit 0,耗时 1.2s' : '用户拒绝执行',
        });
      }

      // ---- 收尾:正文 ----
      await sleep(500);
      emit({ type: 'step', step: wantsConfirm ? 5 : 4, maxSteps: 20 });
      await typeOut('结果已经拿到了,下面是要点。', emit, 'reasoning');
      await sleep(200);

      const answer =
        '处理完成,42 行数据已写入 out/result.csv。\n\n' +
        '其中读取凭证目录那一步被读黑名单拦下了(预期行为),' +
        '所以那部分字段是空的 —— 需要的话得换一个数据来源。';

      await typeOut(answer, emit, 'content');
      emit({ type: 'done', stopReason: 'complete', steps: wantsConfirm ? 5 : 4 });

      return { stopReason: 'complete', answer };
    },
  };

  // 配置面板的假后端 —— 接上 server 后换成 POST /config
  window.AgentConfigApi = {
    async save(patch) {
      console.log('[mock] 保存配置', patch);
      await sleep(200);
    },
  };

  // 假的会话信息,形状与将来 server 要给的一致
  window.AgentApp.hydrate({
    model: 'deepseek-v4-flash',
    baseURL: 'https://api.deepseek.com',
    visionModel: '',
    workspace: 'C:\\Users\\me\\work\\demo',
    pythonEnabled: true,
    allowDangerousTools: false,
    shellEnabled: true,
    subAgentEnabled: true,
    memoryEnabled: true,
    apiKeyMasked: 'sk-••••••••1234',
  });

  window.AgentApp.notices([
    { level: 'warn', message: '沙箱缺少基线依赖: pandas', hint: '安装: pip install pandas' },
  ]);
})();
