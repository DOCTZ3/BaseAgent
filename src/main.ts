// ============================================
// BaseAgent 最小入口(非交互)
// ============================================
//
// 装配全部在 core/session.ts。这里只演示「建会话 → 跑一轮 → 收尾」。
//
// 原先这个文件自己建了一份 PythonExecutor / ToolRunner / ContextManager /
// Orchestrator —— 那会变成**第二份装配**,和 app 会话装配必然漂移。
// 这个项目已经在「同一份事实写两处」上栽过四次(visionAnalyzer、
// pythonExecutor、models.vision、fsDeniedPaths),所以这里改成消费 session。
//
// 用法:npm run dev / npm start
// ============================================

import 'dotenv/config';   // ← 第一行加载 .env，后面所有 process.env 才能读到
import { createAgentSession } from './core/index.js';

async function main() {
  const session = await createAgentSession({
    idPrefix: 'main',
    // **一律拒绝**,不是自动批准。
    // 这是非交互入口,没有人可问 —— 而 run_command 没有任何机制边界,
    // 它全部的安全性就是「用户读那一行原样命令并判断」。
    // 原先这里写的是 `return true`(那时还没有 run_command),
    // 沿用到今天就等于给一个无人看守的入口开了任意命令执行
    onConfirm: async req => {
      session.logger.warn('非交互入口拒绝危险工具', { tool: req.toolName });
      return false;
    },
  });

  for (const n of session.notices) {
    session.logger.warn(n.message, n.hint ? { hint: n.hint } : undefined);
  }

  session.logger.info('BaseAgent 启动', {
    model: session.info.model,
    sessionId: session.sessionId,
  });

  try {
    const result = await session.run(
      '请告诉我现在的时间(用代码实现),然后回显 "Hello BaseAgent"',
    );

    session.logger.info('任务结果', {
      answer: result.answer,
      stopReason: result.stopReason,
      steps: result.steps,
    });
  } finally {
    // 必须调:常驻 chromium 是 detached 的,不关会一直锁着 profile 目录
    await session.dispose();
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
