// ============================================
// Platform 层:配置持久化(客户端配置面板的后端)
// ============================================
//
// 为什么不直接读写 .env:
//
// ① **改了不生效**。config.ts 的 defaultConfig 是**模块级常量** ——
//    所有 process.env.XXX 在该模块首次被 import 时求值一次,之后永不再读。
//    写回 .env 文件确实改了,但进程内什么都没变(dotenv 不重读、
//    defaultConfig 不重算)。用户点了保存看不到任何变化,只能重启,
//    这是最糟的反馈形态。config.test.ts 顶部那句注释记的就是这件事 ——
//    那些测试必须 vi.resetModules() 重新 import 才能验证不同环境变量。
//
// ② **.env 在项目根目录,而它在读黑名单里**。我们自己把项目 .env 列进了
//    read-deny(沙箱代码不该读到它)。客户端加了配置面板之后 key 的
//    生命周期变长、被打开的次数变多,继续放那儿只是把同一个问题做大。
//
// 所以:配置存到**用户配置目录**的 JSON,在项目外、在工作区外 ——
// 与 .agent-memory.db / .sandbox-venv 同一个理由,模型的代码碰不到。
// .env 保留为**回落**:JSON 里没有的项才读环境变量,现有 CLI 不受影响。
//
// **生效时机不假装热更新**。改完要重建会话(客户端就是一个
// 「保存并重启会话」的动作)—— 因为 workspace 派生出 fsGrants、
// Python cwd、写边界三样东西,venv 要重新校验,常驻浏览器要重开。
// 假装热更新会得到一个「界面显示新值、实际跑的是旧边界」的会话。
// ============================================

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AgentConfig } from './config.js';

/**
 * 客户端可配置的项
 *
 * 刻意**只放用户真正需要决定的**。压缩阈值、clip 上限、重试退避那些
 * 仍然只走 .env —— 它们要理解内部机制才填得对,放进界面等于把
 * 「能填错的东西」变多。
 */
export interface StoredConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  visionModel?: string;
  workspace?: string;
  pythonEnabled?: boolean;
  allowDangerousTools?: boolean;
  shellEnabled?: boolean;
  subAgentEnabled?: boolean;
  memoryEnabled?: boolean;
}

/**
 * 配置文件位置 —— 用户配置目录,不在项目内
 *
 * Windows: %APPDATA%/BaseAgent/config.json
 * macOS:   ~/Library/Application Support/BaseAgent/config.json
 * Linux:   ~/.config/BaseAgent/config.json
 */
export function configFilePath(): string {
  const dir =
    process.platform === 'win32'
      ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');

  return path.join(dir, 'BaseAgent', 'config.json');
}

/**
 * 读配置
 *
 * 文件不存在、内容坏了都返回空对象 —— 配置读不出来不该让程序起不来,
 * 回落到 .env 仍然能跑。
 */
export function readConfigFile(): StoredConfig {
  try {
    const raw = fs.readFileSync(configFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as StoredConfig) : {};
  } catch {
    return {};
  }
}

/**
 * 写配置(增量合并)
 *
 * **合并而不是覆盖**:界面上的 apiKey 输入框留空表示「不修改」,
 * 整份覆盖会把已存的 key 抹掉 —— 而 key 抹掉之后用户看到的是
 * 「未设置 DEEPSEEK_API_KEY」,不会想到是自己点了保存造成的。
 *
 * 文件权限设 0600:里面有 API key。Windows 上这个模式基本无效,
 * 但在 macOS/Linux 上是有意义的,而设了不亏。
 */
export function writeConfigFile(patch: StoredConfig): StoredConfig {
  const file = configFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const current = readConfigFile();
  const merged: StoredConfig = { ...current };

  for (const [k, v] of Object.entries(patch)) {
    // undefined = 不修改(apiKey 留空走这条)。空串是**有意清空**,要保留
    if (v === undefined) continue;
    (merged as Record<string, unknown>)[k] = v;
  }

  // 先写临时文件再 rename:直接写的话中途崩掉会留下半个 JSON,
  // 下次启动读不出来 —— 而那时用户的 key 就丢了
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);

  return merged;
}

/**
 * 把存下来的配置翻成 loadConfig() 的 overrides
 *
 * 为什么要这一层翻译:界面上是平的一层(十个字段),而 AgentConfig 是
 * 分段嵌套的,并且有几项是**派生**的 —— workspace 一项要派生出
 * fsGrants(工作区 rw + 归档 ro 两条)。这些派生规则只有一份、
 * 在 config.ts 里,所以这里只给 workspace,派生仍由它做。
 *
 * 返回 undefined 的字段一律不放进 overrides —— 放了会用 undefined
 * 盖掉 .env 里的值(浅合并的坑,config.ts 里那条注释说的同一件事)。
 */
export function toOverrides(stored: StoredConfig): Partial<AgentConfig> {
  // 各段都是**部分**字段(界面只暴露十项),而 AgentConfig 的段是完整类型 ——
  // loadConfig 逐段浅合并时缺的字段由 defaultConfig 补上,所以这里断言是安全的。
  // 用 Record<string, unknown> 会让调用方失去类型检查:传错段名不报错、
  // 只表现成「保存了但没生效」
  const out: Record<string, unknown> = {};

  const model: Record<string, unknown> = {};
  if (stored.apiKey) model.apiKey = stored.apiKey;
  if (stored.baseURL) model.baseURL = stored.baseURL;
  if (stored.model) model.model = stored.model;
  if (Object.keys(model).length > 0) out.models = { main: model };

  if (stored.workspace !== undefined) out.workspace = stored.workspace;

  if (stored.pythonEnabled !== undefined) {
    out.python = { enabled: stored.pythonEnabled };
  }
  if (stored.shellEnabled !== undefined) {
    out.shell = { enabled: stored.shellEnabled };
  }
  if (stored.allowDangerousTools !== undefined) {
    out.security = { allowDangerousTools: stored.allowDangerousTools };
  }
  if (stored.subAgentEnabled !== undefined) {
    out.subAgent = { enabled: stored.subAgentEnabled };
  }
  if (stored.memoryEnabled !== undefined) {
    out.memory = { enabled: stored.memoryEnabled };
  }

  return out as Partial<AgentConfig>;
}
