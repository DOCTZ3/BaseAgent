// ============================================
// Electron 主进程 —— 原生窗口 + agent 宿主
// ============================================
//
// agent 直接跑在**这个进程**里(它本来就是 Node)。渲染进程与它之间只有
// preload.cjs 那一道窄口子;未来手机/转发入口则经 RemoteHub 复用同一套 AppApi。
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

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const { createAppApi } = require('./app-api.cjs');
const { createRemoteHub } = require('./remote-hub.cjs');
const { createRelayClient } = require('./relay-client.cjs');

const appRoot = path.join(__dirname, '..');

// .env 仍然读 —— 它是配置的**回落**,现有 .env 一个字不用改
require('dotenv').config({ path: path.join(appRoot, '.env') });

// 与 config-store.ts 的 BaseAgent 目录保持一致;否则 userData 可能跟随
// package name 变成 base-agent,配置和运行时产物分散到两个目录。
app.setName('BaseAgent');

let win = null;
let session = null;          // AgentSession
let createAgentSession = null;   // 动态 import 拿到的工厂
let remoteHub = null;
let relayClient = null;

// 确认往返:reqId → resolve。主进程问、页面答
const pendingConfirms = new Map();
let confirmSeq = 0;
const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 加载 agent 的 ESM 代码
 *
 * 用 tsx 的 ESM 注册器直接吃 .ts,理由见文件头 ②。
 * 失败不能静默:那会表现成「窗口开着但发消息没反应」,最难查的形态。
 */
let createSharedBrowser = null;

function moduleUrl(devRelativePath, packagedRelativePath) {
  const relative = app.isPackaged ? packagedRelativePath : devRelativePath;
  return pathToFileURL(path.join(appRoot, relative)).href;
}

async function registerTsxForDevelopment() {
  if (app.isPackaged) return;
  const tsxUrl = pathToFileURL(
    require.resolve('tsx/esm/api', { paths: [appRoot] }),
  ).href;
  const tsx = await import(tsxUrl);
  tsx.register();
}

async function loadAgentModule() {
  if (createAgentSession) return createAgentSession;

  await registerTsxForDevelopment();

  const sessionUrl = moduleUrl(
    path.join('src', 'core', 'session.ts'),
    path.join('dist', 'core', 'session.js'),
  );
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
 * Electron app 的运行时数据目录
 *
 * 开发期从项目根启动时,`traces` / `.agent-memory.db` / `.sandbox-venv`
 * 落在项目根目录很方便;但打包后 process.cwd() 不再是可靠边界,可能是
 * 安装目录、快捷方式启动目录,甚至用户解压包的位置。
 *
 * app.getPath('userData') 是 Electron 为每个系统准备的可写用户目录:
 * Windows: %APPDATA%/<AppName>
 * macOS:   ~/Library/Application Support/<AppName>
 * Linux:   ~/.config/<AppName>
 */
function appRuntimeOverrides() {
  const dataDir = app.getPath('userData');
  const out = {};

  // 环境变量仍保留最高优先级,方便开发/排障时显式指定。
  if (!process.env.TRACE_DIR) {
    out.trace = { dir: path.join(dataDir, 'traces') };
  }
  if (!process.env.MEMORY_DB_PATH) {
    out.memory = { dbPath: path.join(dataDir, 'agent-memory.db') };
  }
  if (!process.env.SANDBOX_VENV_DIR || !process.env.BROWSER_PROFILE_DIR) {
    out.python = {};
    if (!process.env.SANDBOX_VENV_DIR) {
      out.python.venvDir = path.join(dataDir, 'sandbox-venv');
    }
    if (!process.env.BROWSER_PROFILE_DIR) {
      out.python.browserProfileDir = path.join(dataDir, 'browser-profile');
    }
  }

  return out;
}

function mergeConfigOverrides(...items) {
  const merged = {};
  const sectionKeys = new Set([
    'execution',
    'security',
    'python',
    'shell',
    'retry',
    'subAgent',
    'memory',
    'skill',
    'trace',
  ]);

  for (const item of items) {
    if (!item) continue;

    for (const [key, value] of Object.entries(item)) {
      if (value === undefined) continue;

      if (key === 'models') {
        merged.models = { ...(merged.models || {}) };
        for (const [modelKey, modelValue] of Object.entries(value || {})) {
          merged.models[modelKey] = {
            ...(merged.models[modelKey] || {}),
            ...(modelValue || {}),
          };
        }
        continue;
      }

      if (key === 'context') {
        merged.context = { ...(merged.context || {}), ...(value || {}) };
        if (value?.compressionClip) {
          merged.context.compressionClip = {
            ...(merged.context.compressionClip || {}),
            ...value.compressionClip,
          };
        }
        continue;
      }

      if (sectionKeys.has(key) && value && typeof value === 'object') {
        merged[key] = { ...(merged[key] || {}), ...value };
        continue;
      }

      merged[key] = value;
    }
  }
  return merged;
}

async function loadAppConfigOverrides() {
  const { readConfigFile, toOverrides } = await loadConfigStore();
  return mergeConfigOverrides(appRuntimeOverrides(), toOverrides(readConfigFile()));
}

async function loadEffectiveConfig() {
  const { loadConfig } = await loadPlatformConfig();
  return loadConfig(await loadAppConfigOverrides());
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
  sendSessionChanged();
  return s;
}

async function createSession(resumeSessionId) {
  const factory = await loadAgentModule();

  // 配置的三层优先级:配置面板存的 JSON > .env > 内置默认。
  //
  // 由**壳**读出来当 overrides 传进去,而不是让 session.ts 自己读文件 ——
  // 那样所有测试都会读到运行机器上的 config.json,于是同一份测试在
  // 你机器上过、在别的机器上挂,而且挂的原因不在代码里。
  const configOverrides = await loadAppConfigOverrides();

  // 浏览器要在建会话**之前**就位:会话装配时要拿它的 CDP 地址注入
  // 子进程环境变量(BROWSER_CDP_URL),晚了模型代码就连不上。
  // 用同一份 config 建 —— profile 路径的解析必须与会话里的读黑名单同源
  const { loadConfig } = await loadPlatformConfig();
  const config = loadConfig(configOverrides);
  if (!config.models.main.apiKey) {
    throw new Error('未设置 DEEPSEEK_API_KEY,无法调用真实 API');
  }
  const browser = await ensureBrowser(config);

  session = await factory({
    idPrefix: 'app',
    configOverrides,
    // 复用进程级实例 —— session 因此**不会**在 dispose 时关掉它,
    // 于是切会话不再重启 chromium(见 session.ts 的 browserManager 注释)
    browserManager: browser,
    // 传了就续接那个会话(沿用同一个 sessionId 并灌回历史轮次)
    resumeSessionId,
    onConfirm: requestUserConfirm,
    // 技能沉淀完了通知渲染层刷角标。窗口没了就静默丢弃 ——
    // 库已经落盘,下次开窗口拉列表时自然带出来
    onSkillsChanged: () => {
      sendSkillsChanged();
    },
    onConfigChanged: () => loadAppConfigOverrides(),
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

  win.loadFile(path.join(appRoot, 'src', 'interface', 'app', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // 页面里的外链走系统浏览器,不在应用窗口里导航 ——
  // 应用窗口一旦被导航到外部页面,preload 暴露的那些函数就落到了外部页面手里
  win.webContents.setWindowOpenHandler(({ url }) => {
    require('electron').shell.openExternal(url);
    return { action: 'deny' };
    });

  win.on('closed', () => { win = null; });
}

function sendAgentEvent(runId, event) {
  if (win && !win.isDestroyed()) win.webContents.send('agent:event', runId, event);
  remoteHub?.publish('agent:event', { runId, event });
  relayClient?.publish('agent:event', { runId, event });
}

function sendSessionChanged() {
  if (win && !win.isDestroyed()) win.webContents.send('agent:session-changed');
  remoteHub?.publish('agent:session-changed', {});
  relayClient?.publish('agent:session-changed', {});
}

function sendSkillsChanged() {
  if (win && !win.isDestroyed()) win.webContents.send('agent:skills-changed');
  remoteHub?.publish('agent:skills-changed', {});
  relayClient?.publish('agent:skills-changed', {});
}

function sendConfigChanged() {
  remoteHub?.publish('agent:config-changed', {});
  relayClient?.publish('agent:config-changed', {});
}

function sendMemoryChanged() {
  remoteHub?.publish('agent:memory-changed', {});
  relayClient?.publish('agent:memory-changed', {});
}

function requestUserConfirm(req) {
  return new Promise(resolve => {
    const reqId = ++confirmSeq;
    const timer = setTimeout(() => {
      const record = pendingConfirms.get(reqId);
      if (!record) return;
      pendingConfirms.delete(reqId);
      record.resolve(false);
      sendConfirmResolved(reqId, false, 'timeout');
    }, CONFIRM_TIMEOUT_MS);
    timer.unref?.();

    pendingConfirms.set(reqId, {
      resolve,
      timer,
      req,
      createdAt: Date.now(),
    });
    if (win && !win.isDestroyed()) win.webContents.send('agent:confirm', reqId, req);
    remoteHub?.publish('agent:confirm', { reqId, req });
    relayClient?.publish('agent:confirm', { reqId, req });
  });
}

function submitConfirmReply(reqId, ok) {
  const id = Number(reqId);
  const record = pendingConfirms.get(id);
  if (!record) return { ok: false, error: '确认请求已结束或不存在' };

  pendingConfirms.delete(id);
  clearTimeout(record.timer);
  const allowed = ok === true;
  record.resolve(allowed);
  sendConfirmResolved(id, allowed, 'answered');
  return { ok: true };
}

function listPendingConfirms() {
  return Array.from(pendingConfirms.entries()).map(([reqId, record]) => ({
    reqId,
    req: record.req,
    createdAt: record.createdAt,
  }));
}

function sendConfirmResolved(reqId, ok, reason) {
  const payload = { reqId, ok, reason };
  if (win && !win.isDestroyed()) win.webContents.send('agent:confirm-resolved', reqId, payload);
  remoteHub?.publish('agent:confirm-resolved', payload);
  relayClient?.publish('agent:confirm-resolved', payload);
}

async function restartSession() {
  if (sessionPromise) {
    // 装配中途点了保存。等它落地再关,不然会漏掉一个 chromium
    try { await sessionPromise; } catch { /* 装配本身失败,下面照常重建 */ }
  }

  const old = session;
  const resumeSessionId = old?.sessionId;
  session = null;
  await old?.dispose();

  const config = await loadEffectiveConfig();
  // 如果本来就没有会话,保存配置只需要刷新界面事实,不必立刻装配 agent。
  // 第一轮消息会按最新配置懒创建;这能避免“保存/启动就等 venv+浏览器”的卡顿。
  if (!old || !config.models.main.apiKey) {
    sendSessionChanged();
    return true;
  }

  await ensureSession(resumeSessionId);
  sendSessionChanged();
  return true;
}

const appApi = createAppApi({
  ensureSession,
  getSession: () => session,
  switchSession,
  restartSession,
  loadEffectiveConfig,
  loadAppConfigOverrides,
  loadConfigStore,
  loadPlatformConfig,
  loadPlatformSecrets,
  loadMcpModule,
  loadDeepSeekModule,
  loadSessionStore,
  getUserDataDir: () => app.getPath('userData'),
  getRemoteHubInfo: () => remoteHub?.info() || null,
  getRelayClientInfo: () => relayClient?.info() || null,
  createRemotePairCode: options => remoteHub?.createPairCode(options),
  createRelayPairCode: options => relayClient?.createPairCode(options),
  openPath: p => shell.openPath(p),
  sendAgentEvent,
  sendSessionChanged,
  sendSkillsChanged,
  sendConfigChanged,
  sendMemoryChanged,
  confirmReply: submitConfirmReply,
  listPendingConfirms,
});

async function startRemoteHub() {
  if (process.env.BASEAGENT_REMOTE_HUB === '0') return;

  const host = process.env.BASEAGENT_REMOTE_HOST || '127.0.0.1';
  const port = process.env.BASEAGENT_REMOTE_PORT || 17888;
  remoteHub = createRemoteHub({
    appApi,
    host,
    port,
    token: process.env.BASEAGENT_REMOTE_TOKEN,
    staticRoot: path.join(appRoot, 'src', 'interface', 'remote'),
    markdownPath: path.join(appRoot, 'src', 'interface', 'app', 'md.js'),
    logger: console,
  });

  try {
    await remoteHub.start();
  } catch (err) {
    console.warn('RemoteHub 启动失败,远程同步入口不可用', err);
    remoteHub = null;
  }
}

function startRelayClient() {
  const url = process.env.BASEAGENT_RELAY_URL;
  const token = process.env.BASEAGENT_RELAY_TOKEN;
  if (!url && !token) return;

  relayClient = createRelayClient({
    appApi,
    url,
    token,
    deviceId: process.env.BASEAGENT_RELAY_DEVICE_ID || 'default',
    reconnectMs: process.env.BASEAGENT_RELAY_RECONNECT_MS,
    logger: console,
  });
  relayClient.start();
}

// ---------- IPC:跑一轮 ----------
ipcMain.handle('agent:run', async (_e, runId, input) => {
  return appApi.runAgent(runId, input);
});

ipcMain.handle('agent:abort', () => {
  return appApi.abortAgent();
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
  submitConfirmReply(reqId, !!ok);
});

// ---------- IPC:会话事实 ----------
//
// 壳一律问主进程,不自己重算。session.ts 的 SessionInfo 注释里记着为什么:
// pythonDir 曾经两处各算一份,而错位不报错、只表现成
// 「venv 里装了、代码里 import 不到」
ipcMain.handle('agent:info', async () => {
  return appApi.info();
});

ipcMain.handle('agent:notices', async () => {
  return appApi.notices();
});

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

ipcMain.handle('app:open-user-data', async () => {
  return appApi.openUserDataDir();
});

ipcMain.handle('remote:create-pair-code', async (_e, options) => {
  return appApi.createRemotePairCode(options);
});

ipcMain.handle('relay:create-pair-code', async (_e, options) => {
  return appApi.createRelayPairCode(options);
});

// ---------- IPC:配置 ----------
ipcMain.handle('config:get', async () => {
  return appApi.configGet();
});

ipcMain.handle('config:save', async (_e, patch) => {
  return appApi.configSave(patch);
});

ipcMain.handle('config:test-mcp', async (_e, payload) => {
  return appApi.configTestMcp(payload);
});

ipcMain.handle('config:describe-mcp', async (_e, payload) => {
  return appApi.configDescribeMcp(payload);
});

// ---------- IPC:会话历史 ----------
//
// 列表**不经会话**:开一个 AgentSession 要起 chromium、建 venv、检依赖,
// 而这里只要读几个 turns.jsonl 的第一行。为了列侧边栏付那些代价说不通。
ipcMain.handle('history:list', async () => {
  return appApi.listHistory();
});

/** 当前会话的完整原始对话 —— 前端渲染历史用 */
ipcMain.handle('history:current', async () => {
  return appApi.currentHistory();
});

/** 切到某个历史会话 */
ipcMain.handle('history:open', async (_e, sessionId) => {
  return appApi.openHistory(sessionId);
});

/** 开新对话 —— 不传 resumeSessionId 即新建 */
ipcMain.handle('history:new', async () => {
  return appApi.newHistory();
});

// ---------- IPC:技能审批 ----------
//
// 沉淀出来的轨迹一律 pending —— 审批前不进索引、load_skill 也取不到。
// 没有这套出口的话功能等于不存在:沉淀会发生、会写进库,但用户看不到也批不了。
//
// 与配置保存同一个约定:**不让异常穿过 IPC**。Electron 会把抛出的 Error
// 包成「Error invoking remote method 'skills:approve': ...」,那半截前缀
// 是实现细节,不该出现在用户眼前。

/** 全部技能(含待审批)。渲染层自己按 pending 分组 */
ipcMain.handle('skills:list', async () => {
  return appApi.listSkills();
});

ipcMain.handle('skills:approve', async (_e, name) => {
  return appApi.approveSkill(name);
});

ipcMain.handle('skills:reject', async (_e, name) => {
  return appApi.rejectSkill(name);
});

ipcMain.handle('skills:set-enabled', async (_e, name, enabled) => {
  return appApi.setSkillEnabled(name, enabled);
});

ipcMain.handle('memory:extract-from-turns', async (_e, payload) => {
  return appApi.extractMemoryFromTurns(payload);
});

ipcMain.handle('skills:extract-from-turns', async (_e, payload) => {
  return appApi.extractSkillFromTurns(payload);
});

async function loadSessionStore() {
  await loadAgentModule();
  return import(moduleUrl(
    path.join('src', 'core', 'session-store.ts'),
    path.join('dist', 'core', 'session-store.js'),
  ));
}

async function loadPlatformConfig() {
  await loadAgentModule();
  return import(moduleUrl(
    path.join('src', 'platform', 'config.ts'),
    path.join('dist', 'platform', 'config.js'),
  ));
}

async function loadPlatformSecrets() {
  await registerTsxForDevelopment();
  return import(moduleUrl(
    path.join('src', 'platform', 'secrets.ts'),
    path.join('dist', 'platform', 'secrets.js'),
  ));
}

async function loadMcpModule() {
  await registerTsxForDevelopment();
  return import(moduleUrl(
    path.join('src', 'mcp', 'index.ts'),
    path.join('dist', 'mcp', 'index.js'),
  ));
}

async function loadDeepSeekModule() {
  await registerTsxForDevelopment();
  return import(moduleUrl(
    path.join('src', 'core', 'deepseek-adapter.ts'),
    path.join('dist', 'core', 'deepseek-adapter.js'),
  ));
}

ipcMain.handle('agent:restart', async () => {
  return appApi.restartSession();
});

async function loadConfigStore() {
  await registerTsxForDevelopment();
  const url = moduleUrl(
    path.join('src', 'platform', 'config-store.ts'),
    path.join('dist', 'platform', 'config-store.js'),
  );
  return import(url);
}

// ---------- 生命周期 ----------
app.whenReady().then(async () => {
  createWindow();
  await startRemoteHub();
  startRelayClient();
});

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
  if (cleaningUp || (!session && !sharedBrowser && !remoteHub?.isRunning() && !relayClient)) return;
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

  try {
    await remoteHub?.stop();
  } catch (err) {
    console.error('关闭 RemoteHub 失败', err);
  }
  remoteHub = null;

  try {
    relayClient?.stop();
  } catch (err) {
    console.error('关闭 RelayClient 失败', err);
  }
  relayClient = null;

  app.quit();
});
