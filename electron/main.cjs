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
  return createAgentSession;
}

/**
 * 建会话
 *
 * onConfirm **必须**由壳提供且不能默认放行:`run_command` 全部的安全性
 * 就是用户读那一行原样命令(见 session.ts 的 CreateSessionOptions 注释)。
 * 这里把它转成一次 IPC 往返 —— 页面弹窗、用户点、答案回来。
 */
async function createSession() {
  const factory = await loadAgentModule();

  // 配置的三层优先级:配置面板存的 JSON > .env > 内置默认。
  //
  // 由**壳**读出来当 overrides 传进去,而不是让 session.ts 自己读文件 ——
  // 那样所有测试都会读到运行机器上的 config.json,于是同一份测试在
  // 你机器上过、在别的机器上挂,而且挂的原因不在代码里。
  const { readConfigFile, toOverrides } = await loadConfigStore();
  const configOverrides = toOverrides(readConfigFile());

  session = await factory({
    idPrefix: 'app',
    configOverrides,
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
  if (!session) await createSession();
  currentRunId = runId;

  const send = event => {
    if (win && !win.isDestroyed()) win.webContents.send('agent:event', runId, event);
  };

  try {
    const result = await session.run(input, send);
    return { stopReason: result.stopReason, answer: result.answer };
  } finally {
    currentRunId = null;
  }
});

ipcMain.handle('agent:abort', () => {
  session?.abort();
  return true;
});

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
  if (!session) await createSession();
  const c = session.config;
  return {
    model: session.info.model,
    baseURL: session.info.baseURL,
    visionModel: session.info.visionModel || '',
    workspace: c.workspace || '',
    pythonEnabled: c.python.enabled,
    allowDangerousTools: c.security.allowDangerousTools,
    // 实际生效值(三个条件的合成),不是用户勾的那个
    shellEnabled: session.info.shellEnabled,
    subAgentEnabled: c.subAgent.enabled,
    memoryEnabled: c.memory.enabled,
    // 只给掩码。明文 key 不进渲染进程 —— 那里跑着不可信内容
    apiKeyMasked: maskKey(c.models.main.apiKey),
  };
});

ipcMain.handle('agent:notices', async () => {
  if (!session) await createSession();
  return session.notices;
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

ipcMain.handle('agent:restart', async () => {
  await session?.dispose();
  session = null;
  await createSession();
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
  if (cleaningUp || !session) return;
  e.preventDefault();
  cleaningUp = true;
  try {
    await session.dispose();
  } catch (err) {
    console.error('收尾失败', err);
  }
  session = null;
  app.quit();
});
