// ============================================
// Executors 层:读黑名单(纯负债路径)
// ============================================
//
// 这是**黑名单,不是白名单**。读的白名单做不了 —— 实测一次 `import pandas`
// 触发 1183 次 open,全是库加载,漏放行一个目录就是 import 直接失败。
// 黑名单反过来:只列沙箱代码**没有任何正当理由**去读的东西,误伤面接近零。
//
// 为什么这些路径值得单独收:读错一个普通文件没有直接损害,读到凭证不一样 ——
// 值会进入模型上下文、跟着请求发给模型服务商、并落进 traces。
// 事后删 trace 追不回已经发出去的那一次。
//
// ⚠️ **它拦的是「热心的模型」,不是对手。**
// 和写边界同一个已知缺口:audit hook 只管当前进程,`subprocess` 换个解释器
// 就绕过(见 write-guard.ts 的实测对照)。真边界必须在进程之外
// (低权限账户 / 容器)。但「模型顺手读一下你的配置好判断环境」是现实会发生的
// 形态,而那一下就足够把明文凭证写进对话记录 —— 这一层治的正是它。
//
// **同一份清单给两层用,必须同源:**
// - SecurityGuard(fs 工具):deny 优先于一切授权
// - Python audit hook:代码里的 open
// 两边不同源就会出现「工具读不到、代码读得到」这种不报错的错位。
//
// 判定按**绝对路径前缀**,不按文件名。所以拦的是本项目的 `.env`,
// 不是工作区里用户自己项目的 `.env` —— 后者可能正是模型要处理的对象。
// 同理 `.env.example` 不受影响(前缀不匹配)。
// ============================================

import * as path from 'path';
import * as os from 'os';

export interface ReadDenyOptions {
  /** 本框架自己的目录(存 .env,里面是 API key) */
  projectDir: string;
  /** 用户主目录。缺省取 os.homedir(),测试里可注入 */
  homeDir?: string;
  /** 追加项(如 .browser-profile 的实际位置) */
  extra?: readonly string[];
  /** 平台。缺省取 process.platform,测试里可注入 */
  platform?: NodeJS.Platform;
  /** Windows 的 env 覆盖(测试用) */
  env?: Record<string, string | undefined>;
}

/**
 * 默认读黑名单(绝对路径)
 *
 * 每一项都是「凭证或等价于凭证」:
 * - 私钥 / 云凭证 / token 文件
 * - 浏览器 profile —— 里面的 cookie 是**活凭证**,拿到就等于登录态,
 *   比密码更直接(不需要过二次验证)
 *
 * 不含 traces/ 与归档目录:归档要让模型读(压缩后回溯早期对话,见 security.ts),
 * 而 traces 里的内容模型本来就在上下文里见过,拦它买不到什么。
 */
export function defaultReadDenyPaths(opts: ReadDenyOptions): string[] {
  const platform = opts.platform ?? process.platform;
  const home = path.resolve(opts.homeDir ?? os.homedir());
  const env = opts.env ?? process.env;
  const h = (...parts: string[]) => path.join(home, ...parts);

  const paths: string[] = [
    // 本框架的密钥:DEEPSEEK_API_KEY / VISION_API_KEY 都在这
    path.join(path.resolve(opts.projectDir), '.env'),

    // SSH / GPG 私钥
    h('.ssh'),
    h('.gnupg'),

    // 云与集群凭证
    h('.aws'),
    h('.kube'),
    h('.azure'),
    h('.config', 'gcloud'),
    h('.docker', 'config.json'),

    // 各类 token 文件
    h('.git-credentials'),
    h('.netrc'),
    h('_netrc'),           // Windows 上 curl/git 用这个名字
    h('.npmrc'),
    h('.pypirc'),
    h('.config', 'gh'),    // GitHub CLI(类 Unix)
  ];

  // 浏览器 profile:cookie = 活凭证
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || h('AppData', 'Local');
    const roaming = env.APPDATA || h('AppData', 'Roaming');
    paths.push(
      path.join(local, 'Google', 'Chrome', 'User Data'),
      path.join(local, 'Microsoft', 'Edge', 'User Data'),
      path.join(roaming, 'Mozilla', 'Firefox'),
      path.join(roaming, 'GitHub CLI'),   // gh 在 Windows 上存这
    );
  } else if (platform === 'darwin') {
    const support = h('Library', 'Application Support');
    paths.push(
      path.join(support, 'Google', 'Chrome'),
      path.join(support, 'Firefox'),
      h('Library', 'Keychains'),
    );
  } else {
    paths.push(h('.config', 'google-chrome'), h('.config', 'chromium'), h('.mozilla'));
  }

  for (const e of opts.extra ?? []) paths.push(path.resolve(e));

  // 去重:同一项进来两次(如 extra 又给了 .env)会让错误信息里出现重复条目
  return [...new Set(paths.map(p => path.resolve(p)))];
}
