// ============================================
// Executors 层:常驻浏览器(CDP)
// ============================================
//
// 为什么要它:
// 每轮 `with sync_playwright()` 块结束就关掉 chromium，于是「上一轮打开的页面、
// 下一轮接着点」做不到 —— 第二轮那个页面已经不存在，只能重新 goto，
// 中间的登录/填表/分页状态全丢。`launch_persistent_context` 只保住登录态，
// 保不住页面停留位置。
//
// 做法:把浏览器的生命周期从「代码块内」提到「会话级」。框架启动一个带
// `--remote-debugging-port` 的 chromium，模型代码用 `connect_over_cdp` 连上去、
// 不关闭。跨轮次操作同一个页面因此成为可能。
//
// 实测确认的三件事(决定了下面的实现):
// - chromium 直接启动后能**脱离启动方存活**:启动脚本退出，端口仍可达。
//   这是常驻方案的前提
// - CDP 的 `/json/close/<id>` **只关标签页**,浏览器进程照旧活着。
//   所以关闭必须靠 PID 强杀，不能只发 CDP 命令
// - 进程没死时 profile 目录**完全删不掉**(几百个文件 EBUSY)。
//   所以孤儿进程不只占内存，它会锁死 profile 让下次启动失败 ——
//   必须在启动前主动清理残留
//
// 由框架启动而非模型代码启动,顺带消掉一个软边界:模型再也没机会自己造
// profile 路径了(之前那是靠 prompt 约定,不可靠)。
// ============================================

import { spawn, execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

interface ManagerLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface BrowserManagerConfig {
  /** chromium 的 user-data-dir。登录态持久化在此,内容由 chromium 自己读写 */
  profileDir: string;
  /** 有头模式。本地形态默认有头:能看见 agent 在干什么,登录引导也自然 */
  headless?: boolean;
  /** 启动后等待 CDP 就绪的超时(ms) */
  startupTimeout?: number;
  logger: ManagerLogger;
}

/** lock 文件内容:用于跨进程清理残留 */
interface LockInfo {
  pid: number;
  port: number;
  startedAt: number;
}

export class BrowserManager {
  private port = 0;
  private pid = 0;
  private started = false;

  constructor(private config: BrowserManagerConfig) {}

  /** 模型代码用的连接地址(经环境变量注入) */
  get cdpUrl(): string {
    return this.port ? `http://127.0.0.1:${this.port}` : '';
  }

  get isRunning(): boolean {
    return this.started;
  }

  /**
   * 启动常驻浏览器
   *
   * 幂等:已经在跑就直接返回。失败不抛异常 —— 浏览器起不来不该让整个 CLI 挂掉,
   * 模型调用浏览器相关代码时自己会收到连接错误并改道。
   */
  async start(): Promise<boolean> {
    if (this.started) return true;

    // 先清理上次留下的孤儿:它锁着 profile,不清掉这次必然启动失败
    await this.cleanupStale();

    const chromePath = this.findChromium();
    if (!chromePath) {
      this.config.logger.warn('未找到 chromium,常驻浏览器不可用', {
        hint: '先跑 `playwright install chromium`',
      });
      return false;
    }

    await fs.mkdir(this.config.profileDir, { recursive: true });
    this.port = await this.findFreePort();

    const args = [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.config.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      // 关掉「恢复上次会话」的崩溃气泡:上次被强杀后它会挡在页面前面
      '--disable-session-crashed-bubble',
      '--disable-features=TranslateUI',
      ...(this.config.headless ? ['--headless=new'] : []),
      'about:blank',
    ];

    // detached + ignore stdio:进程要脱离本进程存活,不能继承管道
    // (继承了的话父进程退出时管道关闭会波及子进程)
    const child = spawn(chromePath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,   // 有头模式要能看见窗口
    });
    child.unref();

    if (!child.pid) {
      this.config.logger.error('chromium 启动失败:未拿到 pid');
      return false;
    }

    // chromium 会 fork 出多个进程,child.pid 未必是持有端口的那个。
    // 就绪后按端口反查真实 PID —— 关闭时要靠它
    const ready = await this.waitForCdp(this.config.startupTimeout ?? 20_000);
    if (!ready) {
      this.config.logger.error('chromium 启动超时,CDP 未就绪', { port: this.port });
      this.killByPort(this.port);
      return false;
    }

    this.pid = this.pidByPort(this.port) || child.pid;
    this.started = true;
    await this.writeLock();

    this.config.logger.info('常驻浏览器已启动', {
      port: this.port,
      pid: this.pid,
      headless: !!this.config.headless,
      profile: this.config.profileDir,
    });
    return true;
  }

  /**
   * 关闭常驻浏览器
   *
   * 必须强杀进程树:CDP 的 /json/close 只关标签页,浏览器进程会留下来
   * 继续锁着 profile 目录(实测 profile 内几百个文件全部 EBUSY)。
   */
  async stop(): Promise<void> {
    if (!this.started) return;

    this.killByPort(this.port);
    this.started = false;
    await this.removeLock();

    this.config.logger.info('常驻浏览器已关闭', { port: this.port, pid: this.pid });
  }

  /**
   * 判活。浏览器可能崩了、或被用户手动关掉 ——
   * 此时应重启而不是让模型对着死端口反复失败
   */
  async isAlive(): Promise<boolean> {
    if (!this.started) return false;
    return this.probeCdp();
  }

  /** 挂了就重启;活着则不动 */
  async ensureAlive(): Promise<boolean> {
    if (await this.isAlive()) return true;

    this.config.logger.warn('常驻浏览器已失联,重启', { port: this.port });
    this.started = false;
    return this.start();
  }

  // ---------------------------------------------------------------- 内部

  /**
   * 定位 chromium 可执行文件
   *
   * 不走 playwright 的 `executable_path`:那需要在 `with sync_playwright()` 块内
   * 访问,块外读会 TargetClosedError。所以直接在缓存目录里找。
   * 注意 Windows 下目录是 `chrome-win64` 而非 `chrome-win`,写死会踩空。
   */
  private findChromium(): string | null {
    const envPath = process.env.CHROMIUM_PATH;
    if (envPath && fsSync.existsSync(envPath)) return envPath;

    const home = os.homedir();
    const roots = [
      path.join(home, 'AppData', 'Local', 'ms-playwright'),   // Windows
      path.join(home, '.cache', 'ms-playwright'),             // Linux
      path.join(home, 'Library', 'Caches', 'ms-playwright'),  // macOS
    ];

    const relatives = [
      path.join('chrome-win64', 'chrome.exe'),
      path.join('chrome-win', 'chrome.exe'),
      path.join('chrome-linux', 'chrome'),
      path.join('chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    ];

    for (const root of roots) {
      if (!fsSync.existsSync(root)) continue;
      // chromium-<build> 目录可能有多个版本,取最新的
      const dirs = fsSync
        .readdirSync(root)
        .filter(d => d.startsWith('chromium-'))
        .sort()
        .reverse();

      for (const dir of dirs) {
        for (const rel of relatives) {
          const candidate = path.join(root, dir, rel);
          if (fsSync.existsSync(candidate)) return candidate;
        }
      }
    }
    return null;
  }

  /** 取一个空闲端口。不写死 9222 —— 用户自己开着 Chrome 调试就会占用它 */
  private findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        srv.close(() => (port ? resolve(port) : reject(new Error('取端口失败'))));
      });
    });
  }

  /** 轮询 CDP 的 HTTP 端点直到就绪 */
  private async waitForCdp(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.probeCdp()) return true;
      await new Promise(r => setTimeout(r, 300));
    }
    return false;
  }

  private async probeCdp(): Promise<boolean> {
    if (!this.port) return false;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(`http://127.0.0.1:${this.port}/json/version`, {
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * 按监听端口反查 PID
   *
   * chromium 会 fork 多个进程,spawn 返回的 pid 未必是持有端口的那个。
   * 关闭时必须杀对,否则端口不释放、profile 不解锁。
   */
  private pidByPort(port: number): number {
    try {
      if (process.platform === 'win32') {
        const out = execFileSync('netstat', ['-ano'], { encoding: 'utf-8' });
        for (const line of out.split('\n')) {
          if (line.includes(`:${port}`) && line.includes('LISTENING')) {
            const pid = parseInt(line.trim().split(/\s+/).pop() ?? '', 10);
            if (!Number.isNaN(pid)) return pid;
          }
        }
      } else {
        const out = execFileSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf-8' });
        const pid = parseInt(out.trim().split('\n')[0] ?? '', 10);
        if (!Number.isNaN(pid)) return pid;
      }
    } catch {
      // netstat/lsof 不可用或没匹配
    }
    return 0;
  }

  /** 杀掉持有该端口的进程树 */
  private killByPort(port: number): void {
    const pid = this.pidByPort(port) || this.pid;
    if (!pid) return;
    this.killTree(pid);
  }

  private killTree(pid: number): void {
    try {
      if (process.platform === 'win32') {
        // /T 连子进程一起杀:chromium 的渲染进程都是它的子进程
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
        });
      } else {
        process.kill(-pid, 'SIGKILL');
      }
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // 已经退出了
      }
    }
  }

  // ---- lock 文件:CLI 被 Ctrl+C / 崩溃时 finally 可能来不及跑,
  //      于是把 pid+port 落盘,下次启动前主动清理

  private get lockPath(): string {
    return path.join(this.config.profileDir, '.cdp-lock.json');
  }

  private async writeLock(): Promise<void> {
    const info: LockInfo = { pid: this.pid, port: this.port, startedAt: Date.now() };
    await fs.writeFile(this.lockPath, JSON.stringify(info), 'utf-8').catch(() => {});
  }

  private async removeLock(): Promise<void> {
    await fs.rm(this.lockPath, { force: true }).catch(() => {});
  }

  /**
   * 清理上次遗留的实例
   *
   * 不做这一步的后果不是「多占点内存」,而是**下次必然启动失败** ——
   * 孤儿进程锁着 profile 目录,chromium 拿不到锁就退出。
   */
  private async cleanupStale(): Promise<void> {
    let info: LockInfo;
    try {
      info = JSON.parse(await fs.readFile(this.lockPath, 'utf-8'));
    } catch {
      return;   // 没有 lock,正常首次启动
    }

    // 按端口反查:pid 可能已被系统复用给别的进程,直接杀会误伤
    const livePid = this.pidByPort(info.port);
    if (livePid) {
      this.config.logger.warn('清理上次遗留的浏览器实例', {
        port: info.port,
        pid: livePid,
        age_min: Math.round((Date.now() - info.startedAt) / 60_000),
      });
      this.killTree(livePid);
      // 给 OS 时间释放 profile 上的文件句柄
      await new Promise(r => setTimeout(r, 1500));
    }

    await this.removeLock();
  }
}
