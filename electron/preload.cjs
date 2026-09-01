// ============================================
// Electron preload —— 渲染进程与 agent 之间唯一的通道
// ============================================
//
// 这个文件是**安全边界**,不是样板代码。
//
// 渲染进程跑的是 app.js,而它渲染的内容里有模型生成的文本、从网页抓来的
// 片段、工具返回的数据 —— 全是不可信输入。所以窗口开 contextIsolation、
// 关 nodeIntegration:页面里拿不到 require、拿不到 fs、拿不到 process.env
// (那里面有 DEEPSEEK_API_KEY)。
//
// 页面能做的事只有下面 contextBridge 明确暴露的这几个函数,一个不多。
// 这跟工具桥是同一个思路:能力经一道窄口子给出去,而不是把整个运行时递过去。
//
// **不用 ESM**:Electron 的 preload 与主进程都以 CommonJS 加载,
// 而项目根 package.json 是 "type": "module" —— 所以这些文件用 .cjs 后缀。
// ============================================

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 事件流的转发
 *
 * 主进程把 AgentEvent 逐条 send 过来,这里按 runId 分发给对应的回调。
 * 为什么要 runId:用户点「停止」再立刻发下一条时,上一轮的尾巴事件
 * 可能还在路上 —— 没有 id 的话它们会画进新一轮的气泡里。
 */
const sinks = new Map();

ipcRenderer.on('agent:event', (_e, runId, event) => {
  const sink = sinks.get(runId);
  if (sink) sink(event);
});

/** 危险工具确认:主进程发起,页面回答。往返都经这一条通道 */
let confirmHandler = null;

ipcRenderer.on('agent:confirm', async (_e, reqId, req) => {
  // 没有处理器时**必须回 false**。默认放行等于让 run_command 的
  // 那道人工边界在页面还没就绪时静默消失
  let ok = false;
  try {
    if (confirmHandler) ok = await confirmHandler(req);
  } catch {
    ok = false;
  }
  ipcRenderer.send('agent:confirm-reply', reqId, ok);
});

contextBridge.exposeInMainWorld('AgentBridge', {
  /** 跑一轮。onEvent 逐条收到 AgentEvent,resolve 出 { stopReason, answer } */
  run(input, onEvent) {
    const runId = `r${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
    sinks.set(runId, onEvent);
    return ipcRenderer
      .invoke('agent:run', runId, input)
      .finally(() => sinks.delete(runId));
  },

  abort: () => ipcRenderer.invoke('agent:abort'),

  /** 会话事实(模型、工作区、各开关) —— 壳不重算,一律问主进程 */
  info: () => ipcRenderer.invoke('agent:info'),
  notices: () => ipcRenderer.invoke('agent:notices'),

  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: patch => ipcRenderer.invoke('config:save', patch),

  /** 目录选择:原生对话框,返回真实绝对路径 */
  pickDirectory: () => ipcRenderer.invoke('dialog:pick-directory'),
  openUserDataDir: () => ipcRenderer.invoke('app:open-user-data'),

  /** 注册确认处理器 */
  onConfirm(handler) { confirmHandler = handler; },

  /**
   * 窗口控制 —— 顶栏是自绘的,系统按钮不存在,只能由页面请求
   *
   * 关闭走 win.close() 而非 destroy():后者会跳过 before-quit,
   * 于是常驻 chromium 不被 dispose、锁着 profile 目录导致下次启动失败
   */
  minimize: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  close: () => ipcRenderer.invoke('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),

  /**
   * 会话历史
   *
   * listHistory 刻意**不经会话** —— 列侧边栏只要读几个 turns.jsonl 的第一行,
   * 而开一个 AgentSession 要起 chromium、建 venv、检依赖。
   */
  listHistory: () => ipcRenderer.invoke('history:list'),
  currentHistory: () => ipcRenderer.invoke('history:current'),
  openHistory: sessionId => ipcRenderer.invoke('history:open', sessionId),
  newSession: () => ipcRenderer.invoke('history:new'),

  /**
   * 技能审批
   *
   * 沉淀出来的轨迹一律待审批 —— 审批前不进索引、load_skill 也取不到。
   * 三个方法都返回 { ok, changed?, skills } :审批完顺带把新列表带回来,
   * 省一次往返(否则每次点完都要再拉一遍)。
   */
  listSkills: () => ipcRenderer.invoke('skills:list'),
  approveSkill: name => ipcRenderer.invoke('skills:approve', name),
  rejectSkill: name => ipcRenderer.invoke('skills:reject', name),

  /**
   * 技能库变动的推送
   *
   * 必须是推送而不是让渲染层在轮末自己拉一次:沉淀在 run() 返回**之后**
   * 才完成(那一步是 void 调用的,要等一次 LLM),轮末拉一定拉不到
   * 刚沉淀的那条 —— 表现成「跑完任务角标不动,重开窗口才冒出来」。
   */
  onSkillsChanged(cb) {
    ipcRenderer.on('agent:skills-changed', () => cb());
  },

  /** 会话重建(改了 workspace 这类需要重启的项之后) */
  restart: () => ipcRenderer.invoke('agent:restart'),
  onSessionChanged(cb) {
    ipcRenderer.on('agent:session-changed', () => cb());
  },
});
