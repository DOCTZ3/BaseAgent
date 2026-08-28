// ============================================
// Electron 主进程 —— 原生窗口 + agent 宿主
// ============================================
//
// agent 直接跑在**这个进程**里(它本来就是 Node),所以没有端口、没有 HTTP、
// 没有第二套鉴权。渲染进程与它之间只有 preload.cjs 那一道窄口子。
//
// 两个不得不这么写的地方:
//
// ① **CommonJS**。Electron 的主进程与 preload 以 CJS 加载,而项目根
//    package.json 是 "type": "module" —— 所以这两个文件用 .cjs 后缀,
//    并用动态 import() 去拿 agent 那边的 ESM 代码。
//
// ② **agent 用 tsx 注册器加载 .ts 源码**。为壳单独跑一遍 tsc 会引入
//    「dist 与 src 不同步」这种不报错的错位:界面上看到的是旧行为,
//    而你改的是新代码。开发期直接吃源码更可靠。
// ============================================

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');

// .env 仍然读 —— 它是配置的**回落**,现有 .env 一个字不用改
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

let win = null;
let session = null;          // AgentSession
let createAgentSession = null;   // 动态 import 拿到的工厂
let currentRunId = null;

// 确认往返:reqId → resolve。主进程问、页面答
const pendingConfirms = new Map();
let confirmSeq = 0;

/**
 * 加载 agent 的 ESM 代码
 *
 * 用 tsx 的 ESM 注册器直接吃 .ts,理由见文件头 ②。
 * 失败不能静默:那会表现成「窗口开着但发消息没反应」,最难查的形态。
 */
let createSharedBrowser = null;

async function loadAgentModule() {
  if (createAgentSession) return createAgentSession;

  const tsxUrl = require('url').pathToFileURL(
    require.resolve('tsx/esm/api', { paths: [path.join(__dirname, '..')] }),
  ).href;
  const tsx = await import(tsxUrl);
  tsx.register();

  const sessionUrl = require('url').pathToFileURL(
    path.join(__dirname, '..', 'src', 'core', 'session.ts'),
  ).href;
  const mod = await import(sessionUrl);
  createAgentSession = mod.createAgentSession;
  createSharedBrowser = mod.createSharedBrowser;
  return createAgentSession;
}

/**
 * 常驻浏览器提到**进程级**,不随会话重建
 *
 * 它归 AgentSession 所有时,切会话(整个 session 拆了重建)会连带重启
 * chromium —— 窗口跳一下、几秒等待,而且**页面停留位置丢了**。
 * 而那正是常驻浏览器存在的理由(登录态在 profile 里能留住,停在哪一页留不住)。
 *
 * 谁创建谁关闭:这里创建,所以由 before-quit 负责关。
 * 漏了就是孤儿进程锁着 profile 目录、下次启动失败。
 */
let sharedBrowser = null;

async function ensureBrowser(config) {
  if (sharedBrowser) return sharedBrowser;
  if (!config.python.enabled) return undefined;
  // 启动失败不抛:没有浏览器仍能干别的活
  sharedBrowser = await createSharedBrowser(config, console);
  return sharedBrowser;
}

/**
 * 建会话
 *
 * onConfirm **必须**由壳提供且不能默认放行:`run_command` 全部的安全性
 * 就是用户读那一行原样命令(见 session.ts 的 CreateSessionOptions 注释)。
 * 这里把它转成一次 IPC 往返 —— 页面弹窗、用户点、答案回来。
 */
/**
 * 取会话,没有则建 —— **并发安全**,所有入口都必须走这里
 *
 * 不能直接写 `if (!session) await createSession()`:多个 IPC 处理器
 * (run / info / notices / restart)都会这么判,而它们可以并发到达 ——
 * 两个同时看到 null 就各建一整套会话。
 *
 * 后果不是「多占内存」而是**必然坏一个**:`.browser-profile` 只能被一个
 * chromium 实例锁住,第二个必然启动超时。实测日志:
 *   工具桥已启动 → chromium 启动超时,CDP 未就绪 → 工具桥已启动
 * 装配跑了三次,最后那个会话的 browserCdpUrl 是空的 ——
 * 于是模型后续再想用浏览器就连不上,而这一切没有任何报错指向真正的原因。
 *
 * 用 in-flight promise 而不是布尔标志:后者只能拦住「别建了」,
 * 拦不住「等那个建好的」—— 第二个调用方需要拿到同一个会话,不是拿到 null。
 */
let sessionPromise = null;

function ensureSession(resumeSessionId) {
  if (session) return Promise.resolve(session);
  if (!sessionPromise) {
    sessionPromise = createSession(resumeSessionId)
      .finally(() => { sessionPromise = null; });
  }
  return sessionPromise;
}

/**
 * 换会话 —— 切历史 / 开新对话共用这一条路
 *
 * 与 restart() 同构(那是改配置后重建),所以顺序上的坑也一样:
 * 先 await 掉正在进行的装配,否则它落地后会覆盖新建的那个,
 * 而旧的那份再没人 dispose、chromium 成为孤儿锁住 profile 目录。
 */
async function switchSession(resumeSessionId) {
  if (sessionPromise) {
    try { await sessionPromise; } catch { /* 装配失败,下面照常重建 */ }
  }
  const old = session;
  session = null;
  await old?.dispose();
  const s = await ensureSession(resumeSessionId);
  if (win && !win.isDestroyed()) win.webContents.send('agent:session-changed');
  return s;
}

async function createSession(resumeSessionId) {
  const factory = await loadAgentModule();

  // 配置的三层优先级:配置面板存的 JSON > .env > 内置默认。
  //
  // 由**壳**读出来当 overrides 传进去,而不是让 session.ts 自己读文件 ——
  // 那样所有测试都会读到运行机器上的 config.json,于是同一份测试在
  // 你机器上过、在别的机器上挂,而且挂的原因不在代码里。
  const { readConfigFile, toOverrides } = await loadConfigStore();
  const configOverrides = toOverrides(readConfigFile());

  // 浏览器要在建会话**之前**就位:会话装配时要拿它的 CDP 地址注入
  // 子进程环境变量(BROWSER_CDP_URL),晚了模型代码就连不上。
  // 用同一份 config 建 —— profile 路径的解析必须与会话里的读黑名单同源
  const { loadConfig } = await loadPlatformConfig();
  const browser = await ensureBrowser(loadConfig(configOverrides));

  session = await factory({
    idPrefix: 'app',
    configOverrides,
    // 复用进程级实例 —— session 因此**不会**在 dispose 时关掉它,
    // 于是切会话不再重启 chromium(见 session.ts 的 browserManager 注释)
    browserManager: browser,
    // 传了就续接那个会话(沿用同一个 sessionId 并灌回历史轮次)
    resumeSessionId,
    onConfirm: req =>
      new Promise(resolve => {
        // 窗口没了就拒绝:无人看守时放行等于开了任意命令执行
        if (!win || win.isDestroyed()) return resolve(false);
        const reqId = ++confirmSeq;
        pendingConfirms.set(reqId, resolve);
        win.webContents.send('agent:confirm', reqId, req);
      }),
  });

  return session;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    // 无边框 + 自绘顶栏。app.css 里的 -webkit-app-region: drag 就是为它写的
    titleBarStyle: 'hidden',
    backgroundColor: '#16171a',
    show: false,        // 等页面画好再显示,避免白闪
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      // 这两项是安全边界,不是默认值填空:页面渲染的是模型输出和抓来的网页,
      // 开 nodeIntegration 等于把 fs 和 process.env(含 API key)交给它
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,   // preload 里要 require('electron'),不能全沙箱
    },
  });

  win.loadFile(path.join(__dirname, '..', 'src', 'interface', 'app', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // 页面里的外链走系统浏览器,不在应用窗口里导航 ——
  // 应用窗口一旦被导航到外部页面,preload 暴露的那些函数就落到了外部页面手里
  win.webContents.setWindowOpenHandler(({ url }) => {
    require('electron').shell.openExternal(url);
    return { action: 'deny' };
    });

  win.on('closed', () => { win = null; });
}

// ---------- IPC:跑一轮 ----------
ipcMain.handle('agent:run', async (_e, runId, input) => {
  const s = await ensureSession();
  currentRunId = runId;

  const send = event => {
    if (win && !win.isDestroyed()) win.webContents.send('agent:event', runId, event);
  };

  try {
    // 用局部的 s,不用全局 session:重建可能在这一轮进行中发生,
    // 那样 session 会被换掉而这一轮该跑在它原来那个上
    const result = await s.run(input, send);
    return { stopReason: result.stopReason, answer: result.answer };
  } finally {
    currentRunId = null;
  }
});

ipcMain.handle('agent:abort', () => {
  session?.abort();
  return true;
});

// ---------- IPC:窗口控制 ----------
//
// 顶栏是自绘的(titleBarStyle: 'hidden'),系统的最小化/最大化/关闭按钮
// 不存在了,所以这三件事必须由页面经 IPC 请求。
//
// 用模块级的 win 而不是 BrowserWindow.getFocusedWindow():确认对话框
// 弹出时焦点可能不在主窗口上,那时 getFocusedWindow() 会返回 null。
ipcMain.handle('window:minimize', () => { win?.minimize(); });

ipcMain.handle('window:toggle-maximize', () => {
  if (!win) return false;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
  return win.isMaximized();
});

// close 而不是 destroy:destroy 会跳过 before-quit,于是常驻 chromium
// 不被 dispose —— 它是 detached 的,留下来会锁住 profile 目录导致下次启动失败
ipcMain.handle('window:close', () => { win?.close(); });

ipcMain.handle('window:is-maximized', () => !!win?.isMaximized());

ipcMain.on('agent:confirm-reply', (_e, reqId, ok) => {
  const resolve = pendingConfirms.get(reqId);
  if (resolve) {
    pendingConfirms.delete(reqId);
    resolve(!!ok);
  }
});

// ---------- IPC:会话事实 ----------
//
// 壳一律问主进程,不自己重算。session.ts 的 SessionInfo 注释里记着为什么:
// pythonDir 曾经两处各算一份,而错位不报错、只表现成
// 「venv 里装了、代码里 import 不到」
ipcMain.handle('agent:info', async () => {
  const s = await ensureSession();
  const c = s.config;
  return {
    model: s.info.model,
    baseURL: s.info.baseURL,
    visionModel: s.info.visionModel || '',
    workspace: c.workspace || '',
    pythonEnabled: c.python.enabled,
    allowDangerousTools: c.security.allowDangerousTools,
    // 实际生效值(三个条件的合成),不是用户勾的那个
    shellEnabled: s.info.shellEnabled,
    subAgentEnabled: c.subAgent.enabled,
    memoryEnabled: c.memory.enabled,
    // 只给掩码。明文 key 不进渲染进程 —— 那里跑着不可信内容
    apiKeyMasked: maskKey(c.models.main.apiKey),
  };
});

ipcMain.handle('agent:notices', async () => {
  const s = await ensureSession();
  return s.notices;
});

function maskKey(k) {
  if (!k) return '(未配置)';
  return k.length <= 8 ? 'sk-••••' : `${k.slice(0, 3)}••••••••${k.slice(-4)}`;
}

// ---------- IPC:目录选择 ----------
//
// 这是 Electron 相对纯网页唯一实打实的优势:拿到真实绝对路径。
// workspace 必须是绝对路径,而网页里 webkitdirectory 只给相对路径、
// showDirectoryPicker 只给 handle —— 用户只能手敲,敲错的后果是
// 所有文件类工具静默全拒
ipcMain.handle('dialog:pick-directory', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择工作区',
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});

// ---------- IPC:配置 ----------
ipcMain.handle('config:get', async () => {
  const { readConfigFile } = await loadConfigStore();
  return readConfigFile();
});

ipcMain.handle('config:save', async (_e, patch) => {
  const { writeConfigFile } = await loadConfigStore();
  writeConfigFile(patch);
  // 不假装热更新:改完要重建会话才生效(见 config-store 顶部说明)
  return { needsRestart: true };
});

/**
 * 重建会话(改了 workspace 这类需要重启的项之后)
 *
 * 三处顺序不能换:
 * ① 先 await 掉正在进行的装配 —— 否则它建好之后会覆盖掉重建出来的那个,
 *    而旧的那份再没人 dispose,chromium 就成了孤儿(锁着 profile 目录)
 * ② dispose 必须在 session = null **之前**取到引用,否则关不掉旧实例
 * ③ 新会话建好才发 session-changed:壳收到就会去拉 info,
 *    早发会让它拿到半个状态
 */
// ---------- IPC:会话历史 ----------
//
// 列表**不经会话**:开一个 AgentSession 要起 chromium、建 venv、检依赖,
// 而这里只要读几个 turns.jsonl 的第一行。为了列侧边栏付那些代价说不通。
ipcMain.handle('history:list', async () => {
  const { listSessions } = await loadSessionStore();
  const { loadConfig } = await loadPlatformConfig();
  return listSessions(loadConfig().trace.dir);
});

/** 当前会话的完整原始对话 —— 前端渲染历史用 */
ipcMain.handle('history:current', async () => {
  const s = await ensureSession();
  return { sessionId: s.sessionId, turns: s.history() };
});

/** 切到某个历史会话 */
ipcMain.handle('history:open', async (_e, sessionId) => {
  const s = await switchSession(sessionId);
  return { sessionId: s.sessionId, turns: s.history() };
});

/** 开新对话 —— 不传 resumeSessionId 即新建 */
ipcMain.handle('history:new', async () => {
  const s = await switchSession(undefined);
  return { sessionId: s.sessionId, turns: [] };
});

async function loadSessionStore() {
  await loadAgentModule();
  return import(require('url').pathToFileURL(
    path.join(__dirname, '..', 'src', 'core', 'session-store.ts'),
  ).href);
}

async function loadPlatformConfig() {
  await loadAgentModule();
  return import(require('url').pathToFileURL(
    path.join(__dirname, '..', 'src', 'platform', 'config.ts'),
  ).href);
}

ipcMain.handle('agent:restart', async () => {
  if (sessionPromise) {
    // 装配中途点了保存。等它落地再关,不然会漏掉一个 chromium
    try { await sessionPromise; } catch { /* 装配本身失败,下面照常重建 */ }
  }
  const old = session;
  session = null;
  await old?.dispose();
  await ensureSession();
  if (win && !win.isDestroyed()) win.webContents.send('agent:session-changed');
  return true;
});

async function loadConfigStore() {
  const url = require('url').pathToFileURL(
    path.join(__dirname, '..', 'src', 'platform', 'config-store.ts'),
  ).href;
  await loadAgentModule();   // 确保 tsx 注册器已装
  return import(url);
}

// ---------- 生命周期 ----------
app.whenReady().then(createWindow);

// Windows/Linux 上关窗即退出。dispose 在 before-quit 里做
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

/**
 * 收尾 —— 必须做
 *
 * 常驻 chromium 是 detached 的,不随本进程退出。不关会一直锁着
 * profile 目录导致下次启动失败(实测)。SQLite 不关会留下 -wal/-shm。
 *
 * 用 before-quit + preventDefault:dispose 是异步的,而 quit 不等异步。
 * 不拦一下的话进程会在 dispose 完成前就没了
 */
let cleaningUp = false;
app.on('before-quit', async e => {
  // 判 sharedBrowser 而不是只判 session:浏览器提到进程级之后,
  // session 的 dispose() 不再关它(ownsBrowser 为 false)——
  // 只判 session 的话,session 为 null 时会直接 return、把 chromium 漏掉,
  // 而它是 detached 的,留下来锁着 profile 目录导致下次启动失败
  if (cleaningUp || (!session && !sharedBrowser)) return;
  e.preventDefault();
  cleaningUp = true;

  // 会话与浏览器分别 try:前者失败不能让后者漏关(那是不可恢复的那一个)
  try {
    await session?.dispose();
  } catch (err) {
    console.error('会话收尾失败', err);
  }
  session = null;

  try {
    await sharedBrowser?.stop();
  } catch (err) {
    console.error('关闭常驻浏览器失败', err);
  }
  sharedBrowser = null;

  app.quit();
});
