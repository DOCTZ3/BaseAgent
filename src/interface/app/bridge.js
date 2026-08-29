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
    async run(input, onEvent) {
      const r = await bridge.run(input, onEvent);

      // 主进程把失败当**返回值**回来(见 main.cjs 的 agent:run):
      // 异常穿过 IPC 会丢掉 LLMError.detail 里的服务端原话,还会带上
      // 「Error invoking remote method」前缀。在这里翻回异常,
      // 交给 app.js 那个 catch 统一显示。
      //
      // 只认**显式**的 ok === false:mock.js 走的是同一份契约但不带这个字段,
      // 用真值判断会把每一次成功也当成失败
      if (r && r.ok === false) {
        const err = new Error(r.detail ? `${r.error}: ${r.detail}` : r.error);
        // 原始字段也挂上去,将来要按类型分流(如内容审查单独提示)不必改协议
        err.detail = r.detail;
        err.code = r.code;
        throw err;
      }

      // 一轮跑完刷新侧边栏:新会话要等第一轮落盘之后才会出现在列表里
      // (列表靠扫 turns.jsonl,而那个文件在第一轮结束时才被创建),
      // 已有会话则要更新「N 轮 · 刚刚」。
      // 不 await —— 侧边栏刷新是次要的,不该让它挡住回答呈现
      void window.AgentApp.refreshSidebar();
      return r;
    },
    abort: () => bridge.abort(),
  };

  window.AgentConfigApi = {
    async save(patch) {
      const r = await bridge.saveConfig(patch);

      // 校验失败是**正常返回值**(主进程刻意不让异常穿过 IPC —— 那会带上
      // 「Error invoking remote method」前缀)。在这里翻回异常,
      // 让 app.js 那个 try/catch 一处统一显示错误。
      // 不翻的话 ok:false 会一路走到下面的 needsRestart 判断:
      // 没存上、也不重启,而界面照样报「配置已更新」
      if (r && r.ok === false) {
        throw new Error(r.error || '配置校验未通过');
      }

      // 不假装热更新:workspace 派生出 fs 白名单、Python cwd、写边界三样东西,
      // venv 要重新校验、常驻浏览器要重开。所以保存即重建会话
      if (r && r.needsRestart) {
        // 只调 restart,**不再自己 hydrate** —— restart 落地后主进程会发
        // session-changed,下面那个监听器负责刷新界面。
        // 两处都拉的话会 info()/notices() 各发两轮 IPC(旧代码就是这样)
        await bridge.restart();
      }
      return r;
    },
  };

  // 危险工具确认:主进程问 → 页面弹窗 → 答案回去。
  // 页面这边的实现在 app.js 的 AgentConfirm(命令原样呈现、默认焦点在拒绝)
  bridge.onConfirm(req => window.AgentConfirm.ask(req));

  // 历史会话。这一层保留包装是因为它有第二个实现的余地(mock.js 里可以给假列表),
  // 与窗口控制不同 —— 那个只有 Electron 一种实现
  window.AgentHistory = {
    list: () => bridge.listHistory(),
    current: () => bridge.currentHistory(),
    open: sessionId => bridge.openHistory(sessionId),
    newSession: () => bridge.newSession(),
  };

  // 窗口控制**不在这里包一层**:app.js 直接用 AgentBridge。
  // 包装过的话 app.js 就得等 bridge.js 执行完才能判断,而脚本顺序是
  // app.js 在前 —— 实测的后果是窗口按钮被整组隐藏、压根不出现。
  // 而且窗口按钮只有 Electron 一种实现,抽象层没有第二个消费者。

  /** 拉一次会话事实填进界面。壳不重算任何值,一律问主进程 */
  async function hydrate() {
    try {
      window.AgentApp.hydrate(await bridge.info());
      window.AgentApp.notices(await bridge.notices());
      // 会话就绪后载入它的历史 —— 切会话时 session-changed 也会走到这里,
      // 所以切换后对话区自然被重画成那个会话的内容
      await window.AgentApp.loadHistory();
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
