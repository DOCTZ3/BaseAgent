// ============================================
// Executors 层:工具桥(让沙箱内的 Python 回调 TS 侧工具)
// ============================================
//
// CodeAct 的最后一块:代码里能调那些**代码本身做不到**的工具。
//
// 桥只暴露 screenshot / view_image 两个。判据不是「哪些工具有用」,
// 是「哪些能力代码根本碰不到」—— 图片进上下文只有 ToolResult.attachments
// 一条路(由 orchestrator 注入成 user 消息),代码只能回传 stdout,
// 在代码里截了图自己看不见。
//
// **刻意不暴露 read_file / search_files**:Python 有 open() 和 glob,
// 而且没有读边界 —— 经桥去读只会比内置慢一圈,是纯冗余。
// 它们留作工具是为了「不开 Python 进程也能读一个文件」,不是为了给代码用。
//
// **刻意不暴露 request_help**:它存在的理由是「代码块是原子的,中间没有
// 跟用户说话的位置」(判据②)。可正因为原子,在代码里调它也不会真的暂停 ——
// 脚本会继续跑到底,请求只在返回后才到用户面前。那和直接当工具调没有区别,
// 还会让模型误以为代码能停下来等人。
//
// 同理不暴露 spawn_subagent:在代码块里套一整个 orchestrator,
// 受外层脚本超时约束,收益不明而失败模式很难查。
//
// 有了桥,这种写法才成立(以前必须退出代码、调工具、再进代码):
//   for name, url in targets:
//       page.goto(url)
//       if page.locator(".chart").count():
//           screenshot(selector=".chart")   # 图片会出现在下一轮上下文里
//
// 为什么用 localhost HTTP 而不是 stdin/stdout:
// stdout 已经被结果占用(还有体积上限),在同一条流上复用请求/响应需要分帧,
// 而且会和库打的警告混在一起 —— 实测 Playwright 就会往 stdout 写东西。
// HTTP 是独立信道,与浏览器走 localhost CDP 的做法一致。
//
// 安全:只绑 127.0.0.1 + 每次启动换 token。没有 token 的话,本机任何进程
// 都能驱动这个 agent 的工具 —— 这是本地形态下少数真能守住的边界。
// 注意 token 经环境变量下发,模型代码读得到,所以它**不是**对模型的边界;
// 对模型的边界是白名单本身。
//
// 依赖方向:桥不 import tools 层(那会形成 executors → tools 的反向依赖),
// 只接一个 invoke 回调,由入口注入 —— 与 SubAgentRunner 同样的模式。
// ============================================

import * as http from 'http';
import { randomBytes } from 'crypto';

interface BridgeLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * 桥要暴露的工具规格
 *
 * 结构上与 tools 层的 ToolDescription 兼容,但这里**重新声明**而不是 import ——
 * executors 在 tools 之下,反向依赖会破坏分层。入口把 getAllDescriptions()
 * 过滤后传进来即可,类型自然对得上。
 */
export interface BridgeToolSpec {
  name: string;
  description: string;
  /** JSON Schema(由 Zod 生成)。用来推导 Python 函数签名,保证两边不漂移 */
  parameters: Record<string, unknown>;
}

export interface BridgeToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  /**
   * 视觉插件产出的观察文字(与 ToolResult.observations 同构)
   *
   * **不返回给代码**:实测模型裸调 `view_image(...)` 三次都没 print,
   * 它依赖框架投递。真返给代码,观察就会随进程消失 ——
   * 而那次视觉调用是花过钱的,静默丢结果比多花 token 糟得多。
   */
  observations?: string[];
}

export interface ToolBridgeConfig {
  /** 执行一次工具调用。由入口注入(通常直接转给 ToolRunner.run) */
  invoke(name: string, args: Record<string, unknown>): Promise<BridgeToolResult>;
  /** 允许经桥调用的工具。空数组 = 桥没有意义,入口应该干脆不创建它 */
  tools: BridgeToolSpec[];
  logger: BridgeLogger;
}

/**
 * 单次执行最多收集多少段观察
 *
 * 必须有上限:模型在循环里调 screenshot 是很自然的写法,
 * 50 次迭代就是 50 次视觉调用 + 50 段观察进上下文。超出后拒绝并在返回里说明,
 * 让模型改成「先筛选再看图」—— 与 stdout 上限同一个思路。
 */
const MAX_OBSERVATIONS_PER_RUN = 8;

export class ToolBridge {
  private server: http.Server | null = null;
  private port = 0;
  private token = '';
  /**
   * runId → 该次执行产出的观察文字
   *
   * 必须按 run 分桶:模型代码调 screenshot 时,框架会**嵌套**再起一个
   * Python 进程(BrowserOps 驱动浏览器截图)。共用一个数组的话,
   * 内层执行结束时会把外层攒的观察一并取走。
   */
  private obsBuckets = new Map<string, string[]>();
  private callCount = 0;

  constructor(private config: ToolBridgeConfig) {}

  get isRunning(): boolean {
    return !!this.server;
  }

  /** 注入子进程的环境变量。run id 每次执行都不同,由 PythonExecutor 追加 */
  get env(): Record<string, string> {
    if (!this.server) return {};
    return {
      BASEAGENT_BRIDGE_URL: `http://127.0.0.1:${this.port}`,
      BASEAGENT_BRIDGE_TOKEN: this.token,
    };
  }

  /** 注入到模型代码之前的 Python 函数定义 */
  get prelude(): string {
    return this.server ? buildBridgePrelude(this.config.tools) : '';
  }

  /**
   * 函数签名列表,供 execute_python 写进 description
   *
   * 与实际生成的函数出自同一份 schema —— 描述和真实签名不会漂移
   */
  get signatures(): string[] {
    return this.config.tools.map(pySignature);
  }

  async start(): Promise<boolean> {
    if (this.server) return true;
    if (this.config.tools.length === 0) {
      this.config.logger.warn('工具桥没有可暴露的工具,不启动');
      return false;
    }

    // 每次启动换 token:泄漏也只在本次会话内有效
    this.token = randomBytes(24).toString('hex');

    const server = http.createServer((req, res) => void this.handle(req, res));

    return new Promise(resolve => {
      server.once('error', err => {
        // 桥起不来不该拖垮 app:代码执行仍可用,只是少了这几个函数
        this.config.logger.error('工具桥启动失败', { error: String(err) });
        resolve(false);
      });
      // 只绑回环:绑 0.0.0.0 会把 agent 的工具暴露到局域网
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        this.port = typeof addr === 'object' && addr ? addr.port : 0;
        this.server = server;
        this.config.logger.info('工具桥已启动', {
          port: this.port,
          tools: this.config.tools.map(t => t.name),
        });
        resolve(true);
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    // close() 只停止监听,残留连接会吊住进程
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
    this.obsBuckets.clear();
    this.config.logger.debug('工具桥已关闭', { calls: this.callCount });
  }

  /**
   * 取出某次执行产出的观察文字并清空该桶
   *
   * 与图片同一套语义:代码能**触发**看图,但拿不到观察本体 ——
   * 观察由框架投递。这一条是必须的,因为实测模型裸调 `view_image(...)`
   * 不会 print 返回值,真交给代码就会静默丢掉花过钱的结果。
   */
  takeObservations(runId: string): string[] {
    const taken = this.obsBuckets.get(runId) ?? [];
    this.obsBuckets.delete(runId);
    return taken;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    // 只认 POST /invoke,其余一律拒绝 —— 缩小攻击面
    if (req.method !== 'POST' || req.url !== '/invoke') {
      res.writeHead(404).end();
      return;
    }
    if (req.headers['x-baseagent-token'] !== this.token) {
      this.config.logger.warn('工具桥收到无效 token 的请求');
      res.writeHead(403).end();
      return;
    }

    let body = '';
    try {
      for await (const chunk of req) {
        body += chunk;
        // 参数不该很大:真要传大内容应该走文件,不然桥会变成数据通道
        if (body.length > 1_000_000) {
          res.writeHead(413).end();
          return;
        }
      }
    } catch {
      res.writeHead(400).end();
      return;
    }

    let name: string;
    let args: Record<string, unknown>;
    let runId: string;
    try {
      const parsed = JSON.parse(body);
      name = String(parsed.name ?? '');
      args = (parsed.args ?? {}) as Record<string, unknown>;
      runId = String(parsed.run_id ?? '_default');
    } catch {
      this.reply(res, { ok: false, error: '请求体不是合法 JSON' });
      return;
    }

    await this.dispatch(res, name, args, runId);
  }

  private async dispatch(
    res: http.ServerResponse,
    name: string,
    args: Record<string, unknown>,
    runId: string,
  ) {
    if (!this.config.tools.some(t => t.name === name)) {
      this.reply(res, {
        ok: false,
        error:
          `工具 ${name} 未经工具桥暴露。可用:${this.config.tools
            .map(t => t.name)
            .join('、')}。` + '其余能力请直接用 Python 标准库或预装包完成。',
      });
      return;
    }

    this.callCount++;

    try {
      const result = await this.config.invoke(name, args);
      // 观察从返回值里剥掉:它由框架投递,代码拿不到本体
      const { observations, ...rest } = result;

      if (!observations?.length) {
        this.reply(res, rest);
        return;
      }

      // 超过上限就拒收观察,但工具本身的结果照常返回 ——
      // 让模型知道「动作成功了,只是这次的观察没收」,而不是以为整个调用失败
      const obsBucket = this.obsBuckets.get(runId) ?? [];
      const room = MAX_OBSERVATIONS_PER_RUN - obsBucket.length;

      if (room <= 0) {
        this.reply(res, {
          ...rest,
          observations_attached: 0,
          note:
            `本次执行的看图次数已达上限(${MAX_OBSERVATIONS_PER_RUN} 次),这次的观察没有收进上下文。` +
            '请先在代码里筛出真正需要看的目标。',
        });
        return;
      }

      obsBucket.push(...observations.slice(0, room));
      this.obsBuckets.set(runId, obsBucket);

      this.reply(res, {
        ...rest,
        observations_attached: Math.min(observations.length, room),
        note:
          '观察已附加，你将在本轮工具结果之后看到它' +
          '（代码里拿不到观察本体，不需要 print）',
      });
    } catch (error) {
      // 工具异常不能炸掉桥:包成 ok:false,让代码侧能 if 判断
      this.reply(res, {
        ok: false,
        error: error instanceof Error ? error.message : '工具执行失败',
      });
    }
  }

  private reply(res: http.ServerResponse, payload: unknown) {
    const body = JSON.stringify(payload);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }
}

// ============================================
// Python 侧代码生成
// ============================================
//
// 从工具的 JSON Schema 推导函数签名,不手写 —— 手写的那份迟早和 Zod 定义漂移,
// 而漂移的表现是「模型按描述调用却报 TypeError」,很难查。
//
// 与 write-guard 不同,这里**不需要**闭包防篡改:那边的闭包是安全边界
// (模型覆盖 _inside 就能越权写文件),这里的函数只是便利封装 ——
// 模型把 screenshot 覆盖掉,损失的是它自己的能力,不构成越权。
// 真正的边界是服务端的白名单。

interface PyParam {
  name: string;
  required: boolean;
}

/** Python 关键字 + 内置名,撞上就跳过该参数(生成不合法代码比少个参数糟得多) */
const PY_RESERVED = new Set([
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def',
  'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if',
  'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise',
  'return', 'try', 'while', 'with', 'yield', 'None', 'True', 'False',
]);

function pyParams(spec: BridgeToolSpec): PyParam[] {
  const props = (spec.parameters?.properties ?? {}) as Record<string, unknown>;
  const required = new Set(
    Array.isArray(spec.parameters?.required)
      ? (spec.parameters.required as unknown[]).map(String)
      : [],
  );

  const params = Object.keys(props)
    .filter(n => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !PY_RESERVED.has(n))
    .map(name => ({ name, required: required.has(name) }));

  // 必填排前面:Python 不允许有默认值的参数出现在无默认值参数之前
  return [...params.filter(p => p.required), ...params.filter(p => !p.required)];
}

function pySignature(spec: BridgeToolSpec): string {
  const args = pyParams(spec)
    .map(p => (p.required ? p.name : `${p.name}=None`))
    .join(', ');
  return `${spec.name}(${args})`;
}

/**
 * 生成注入模型代码之前的 Python 函数定义
 *
 * 语义:返回值就是 ToolResult 本身(dict),`result["ok"]` 可判断成败。
 * 图片不在返回值里 —— 它经 attachments 由框架注入,代码拿不到本体。
 */
function buildBridgePrelude(tools: BridgeToolSpec[]): string {
  const defs = tools
    .map(spec => {
      const params = pyParams(spec);
      const sig = pySignature(spec);
      // docstring 用 JSON.stringify 而不是拼 """:JSON 的转义(\n \" \\ \uXXXX)
      // 恰好都是合法的 Python 字符串字面量,而三引号拼接会被描述里的引号搞挂 ——
      // 描述以 " 结尾就产出 """",那是 SyntaxError,而且会让**所有**代码执行失败
      const doc = JSON.stringify(spec.description);
      const pairs = params
        .map(p => `${JSON.stringify(p.name)}: ${p.name}`)
        .join(', ');
      return `def ${sig}:
    ${doc}
    return _baseagent_call(${JSON.stringify(spec.name)}, {${pairs}})
`;
    })
    .join('\n');

  return `# --- BaseAgent 工具桥(自动注入) ---
def _baseagent_make_call():
    import json, os, urllib.request, urllib.error

    url = os.environ.get("BASEAGENT_BRIDGE_URL", "")
    token = os.environ.get("BASEAGENT_BRIDGE_TOKEN", "")
    # 按本次执行分桶:模型代码调 screenshot 时框架会嵌套再起一个 Python 进程,
    # 没有 run_id 的话内层结束时会把外层攒的图片一并取走
    run_id = os.environ.get("BASEAGENT_RUN_ID", "")

    def call(name, args):
        if not url:
            return {"ok": False, "error": "工具桥未启用"}
        # None 表示"没传",不下发:否则会覆盖 TS 侧 Zod 的 optional 默认值
        payload = {
            "name": name,
            "args": {k: v for k, v in args.items() if v is not None},
            "run_id": run_id,
        }
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            url + "/invoke",
            data=body,
            headers={
                "Content-Type": "application/json; charset=utf-8",
                "X-BaseAgent-Token": token,
            },
        )
        try:
            # 超时给得宽:截图要嵌套起一个浏览器进程。外层脚本超时会连坐杀掉整棵树,
            # 所以这里不必卡得紧
            with urllib.request.urlopen(req, timeout=300) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return {"ok": False, "error": "工具桥返回 HTTP %s" % e.code}
        except Exception as e:
            # 工具调不通不该让整段代码崩:返回 ok:False 让模型能继续往下走
            return {"ok": False, "error": "工具桥调用失败: %s: %s" % (type(e).__name__, e)}

    return call

_baseagent_call = _baseagent_make_call()
del _baseagent_make_call

${defs}# --- 工具桥结束 ---

`;
}
