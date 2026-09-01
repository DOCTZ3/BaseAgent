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

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

const appRoot = path.join(__dirname, '..');

// .env 仍然读 —— 它是配置的**回落**,现有 .env 一个字不用改
require('dotenv').config({ path: path.join(appRoot, '.env') });

// 与 config-store.ts 的 BaseAgent 目录保持一致;否则 userData 可能跟随
// package name 变成 base-agent,配置和运行时产物分散到两个目录。
app.setName('BaseAgent');

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
    onConfirm: req =>
      new Promise(resolve => {
        // 窗口没了就拒绝:无人看守时放行等于开了任意命令执行
        if (!win || win.isDestroyed()) return resolve(false);
        const reqId = ++confirmSeq;
        pendingConfirms.set(reqId, resolve);
        win.webContents.send('agent:confirm', reqId, req);
      }),
    // 技能沉淀完了通知渲染层刷角标。窗口没了就静默丢弃 ——
    // 库已经落盘,下次开窗口拉列表时自然带出来
    onSkillsChanged: () => {
      if (win && !win.isDestroyed()) win.webContents.send('agent:skills-changed');
    },
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
    return { ok: true, stopReason: result.stopReason, answer: result.answer };
  } catch (err) {
    // 失败**当成正常返回值**回去,不让异常穿过 IPC。两个理由:
    //
    // ① Electron 序列化异常时只带 message,自定义字段(LLMError.detail)会被丢掉 ——
    //    而 detail 里正是服务端的原话(如「Output data may contain inappropriate
    //    content.」= 输出被内容审查拦下),丢了就又回到「只显示 LLM API 调用失败」
    // ② 它还会给消息加上「Error invoking remote method 'agent:run':」前缀,
    //    那半截是实现细节,不该出现在用户眼前
    console.error('本轮执行失败', err);
    return {
      ok: false,
      error: err && err.message ? err.message : String(err),
      // 服务端原话。渲染进程只把它当文本显示,不做任何解析
      detail: err && err.detail ? String(err.detail) : undefined,
      code: err && err.code ? String(err.code) : undefined,
    };
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
  const s = session;
  const c = s ? s.config : await loadEffectiveConfig();
  const main = c.models.main;
  const shellEnabled =
    s ? s.info.shellEnabled : c.shell.enabled && !!c.workspace && c.security.allowDangerousTools;

  return {
    model: s ? s.info.model : main.model,
    baseURL: s ? s.info.baseURL : main.baseURL,
    visionModel: s ? s.info.visionModel || '' : c.models.vision?.model || '',
    workspace: c.workspace || '',
    pythonEnabled: c.python.enabled,
    allowDangerousTools: c.security.allowDangerousTools,
    // shell 要给**两个**值,不能只给一个:
    // - shellEnabled 是实际生效值(shell.enabled && workspace && allowDangerousTools 的合成)
    // - shellConfigured 是用户勾的那个原始值
    // 只给合成值会静默丢配置:勾了 shell 但没勾「允许危险工具」时,
    // 面板回填成未勾选,用户下次保存就把自己存的 true 写成了 false
    shellEnabled,
    shellConfigured: c.shell.enabled,
    subAgentEnabled: c.subAgent.enabled,
    memoryEnabled: c.memory.enabled,
    // 运行参数:给**实际生效值**。maxTokens 未配时是 undefined,
    // 原样传出去让面板显示空(= 走默认),不要兜成 0
    maxTokens: c.models.main.maxTokens,
    maxSteps: c.execution.maxSteps,
    enableThinking: c.models.main.enableThinking,
    userDataDir: app.getPath('userData'),
    // 只给掩码。明文 key 不进渲染进程 —— 那里跑着不可信内容
    apiKeyMasked: maskKey(main.apiKey),
  };
});

ipcMain.handle('agent:notices', async () => {
  if (session) return session.notices;

  const c = await loadEffectiveConfig();
  const notices = [];
  if (!c.models.main.apiKey) {
    notices.push({
      level: 'error',
      message: 'DEEPSEEK_API_KEY 未配置,请先在配置面板填写 API key。',
    });
  }
  if (!c.workspace) {
    notices.push({
      level: 'warn',
      message: 'WORKSPACE 未配置,文件类工具与代码执行将全部被拒绝。',
    });
  }
  return notices;
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

ipcMain.handle('app:open-user-data', async () => {
  await shell.openPath(app.getPath('userData'));
  return true;
});

// ---------- IPC:配置 ----------
ipcMain.handle('config:get', async () => {
  const { readConfigFile } = await loadConfigStore();
  return readConfigFile();
});

ipcMain.handle('config:save', async (_e, patch) => {
  const { writeConfigFile } = await loadConfigStore();

  // 校验失败要**当成正常返回值**回去,不能让异常穿过 IPC:
  // Electron 会把抛出的 Error 包成
  // 「Error invoking remote method 'config:save': Error: 单次生成上限应在…」——
  // 前缀那半截是实现细节,而这条消息是直接给用户看的
  try {
    writeConfigFile(patch);
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }

  // 不假装热更新:改完要重建会话才生效(见 config-store 顶部说明)
  return { ok: true, needsRestart: true };
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
  return listSessions(loadConfig(await loadAppConfigOverrides()).trace.dir);
});

/** 当前会话的完整原始对话 —— 前端渲染历史用 */
ipcMain.handle('history:current', async () => {
  // 启动时渲染层会调用它来恢复当前视图。这里不能顺手创建完整会话:
  // 建会话会检查 venv、起浏览器、启动工具桥,直接把“打开窗口”拖慢。
  // 真正需要会话的是发送消息或显式打开某段历史。
  if (!session) return { sessionId: null, turns: [] };

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
  // 启动时会刷新角标,但不能为了角标创建完整会话。技能库是增强能力,
  // 首屏响应优先;会话建好后 onSessionChanged / onSkillsChanged 会再刷新。
  if (!session) return { ok: false, error: '会话尚未启动' };

  const s = await ensureSession();
  if (!s.skills) return { ok: false, error: '技能库未启用' };
  return { ok: true, skills: s.skills.list() };
});

ipcMain.handle('skills:approve', async (_e, name) => {
  if (!session) return { ok: false, error: '会话尚未启动' };

  const s = await ensureSession();
  if (!s.skills) return { ok: false, error: '技能库未启用' };

  // approve 返回 false = 名字不存在或它本来就不是待审状态。
  // 两种都不算错误,但要让渲染层知道「没发生变化」,否则列表刷新后
  // 用户会以为自己点了却没反应
  const changed = s.skills.approve(name);
  return { ok: true, changed, skills: s.skills.list() };
});

ipcMain.handle('skills:reject', async (_e, name) => {
  if (!session) return { ok: false, error: '会话尚未启动' };

  const s = await ensureSession();
  if (!s.skills) return { ok: false, error: '技能库未启用' };

  const changed = s.skills.reject(name);
  return { ok: true, changed, skills: s.skills.list() };
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

ipcMain.handle('agent:restart', async () => {
  if (sessionPromise) {
    // 装配中途点了保存。等它落地再关,不然会漏掉一个 chromium
    try { await sessionPromise; } catch { /* 装配本身失败,下面照常重建 */ }
  }

  const old = session;
  session = null;
  await old?.dispose();

  const config = await loadEffectiveConfig();
  // 如果本来就没有会话,保存配置只需要刷新界面事实,不必立刻装配 agent。
  // 第一轮消息会按最新配置懒创建;这能避免“保存/启动就等 venv+浏览器”的卡顿。
  if (!old || !config.models.main.apiKey) {
    if (win && !win.isDestroyed()) win.webContents.send('agent:session-changed');
    return true;
  }

  await ensureSession();
  if (win && !win.isDestroyed()) win.webContents.send('agent:session-changed');
  return true;
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
