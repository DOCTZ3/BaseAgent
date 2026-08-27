// ============================================
// 传输层:Electron IPC —— 把 AgentBridge 接成 app.js 要的那个契约
// ============================================
//
// app.js 只认两个全局:AgentTransport(跑一轮)和 AgentConfigApi(存配置)。
// 这个文件用真实 IPC 实现它们;mock.js 用假事件流实现同一份契约。
// 二者互斥,由「有没有 AgentBridge」决定 —— 于是:
//   双击 index.html(file://) → 没有 AgentBridge → mock 接手,纯看界面
//   npm run app(Electron)   → 有 AgentBridge   → 走真实 agent
// 渲染代码一行不改。
// ============================================

(() => {
  'use strict';

  // 不在 Electron 里 —— 让 mock.js 接手
  if (!window.AgentBridge) return;

  const bridge = window.AgentBridge;

  window.AgentTransport = {
    run: (input, onEvent) => bridge.run(input, onEvent),
    abort: () => bridge.abort(),
  };

  window.AgentConfigApi = {
    async save(patch) {
      const r = await bridge.saveConfig(patch);
      // 不假装热更新:workspace 派生出 fs 白名单、Python cwd、写边界三样东西,
      // venv 要重新校验、常驻浏览器要重开。所以保存即重建会话
      if (r && r.needsRestart) {
        await bridge.restart();
        await hydrate();
      }
      return r;
    },
  };

  // 危险工具确认:主进程问 → 页面弹窗 → 答案回去。
  // 页面这边的实现在 app.js 的 AgentConfirm(命令原样呈现、默认焦点在拒绝)
  bridge.onConfirm(req => window.AgentConfirm.ask(req));

  /** 拉一次会话事实填进界面。壳不重算任何值,一律问主进程 */
  async function hydrate() {
    try {
      window.AgentApp.hydrate(await bridge.info());
      window.AgentApp.notices(await bridge.notices());
    } catch (e) {
      // 装配失败(没配 key、venv 起不来一类)必须说出来。
      // 静默的话表现成「窗口开着但发消息没反应」—— 最难查的形态
      window.AgentApp.notices([
        {
          level: 'error',
          message: `会话启动失败: ${e && e.message ? e.message : String(e)}`,
        },
      ]);
    }
  }

  bridge.onSessionChanged(() => { void hydrate(); });
  void hydrate();
})();
