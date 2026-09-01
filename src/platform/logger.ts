// ============================================
// Platform 层:日志
// ============================================
//
// 两种实现:
// - ConsoleLogger  只打终端。适合非 app 入口 —— 终端本身就是日志
// - FileLogger     同时落盘。**客户端必须用它**:Electron 双击启动时
//                  stdout 没有去处,`chromium 启动超时` 这类只存在于运行日志、
//                  trace 文件里根本没有的信息会彻底看不到
//
// 与 TraceRecorder 的分工:trace 记的是「发给模型的原始请求/响应」(定位效果问题),
// 日志记的是「框架自己在干什么」(定位装配、执行器、生命周期问题)。
// 两者都需要,互相替代不了。
// ============================================

import fs from 'fs';
import path from 'path';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export class ConsoleLogger implements Logger {
  constructor(private level: LogLevel = LogLevel.INFO) {}

  debug(message: string, meta?: Record<string, unknown>): void {
    if (this.level <= LogLevel.DEBUG) {
      console.log(`[DEBUG] ${message}`, meta || '');
    }
  }

  info(message: string, meta?: Record<string, unknown>): void {
    if (this.level <= LogLevel.INFO) {
      console.log(`[INFO] ${message}`, meta || '');
    }
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    if (this.level <= LogLevel.WARN) {
      console.warn(`[WARN] ${message}`, meta || '');
    }
  }

  error(message: string, meta?: Record<string, unknown>): void {
    if (this.level <= LogLevel.ERROR) {
      console.error(`[ERROR] ${message}`, meta || '');
    }
  }
}

/** meta 里被打码的键 —— 命中即替换成掩码,不写值 */
const SECRET_KEYS = /^(.*(api_?key|apikey|token|secret|password|passwd|credential|authorization|cookie).*)$/i;

/**
 * meta 序列化
 *
 * 三件事必须做,少一件日志就会在最需要它的时候坏掉:
 *
 * ① **循环引用要兜住**。meta 里塞过 error 对象、执行器实例这类东西,
 *    `JSON.stringify` 撞上循环引用会**抛异常** —— 而它在 logger 内部抛,
 *    等于「记录一条日志把主流程炸了」。这跟工具错误一律包成 ToolResult
 *    同一个原则:边缘的失败不炸主流程。
 * ② **凭证要打码**。日志会长期留在磁盘上,而 meta 是自由字典 ——
 *    随手 `logger.info('x', { config })` 就可能把 apiKey 写进文件。
 *    trace 那边已经有同类保护(data URL 换成 <stripped>),这里补上。
 * ③ **单条要有长度上限**。执行器返回的 stdout 可能是几十 KB,
 *    整条写进日志会让文件几分钟涨到几百 MB。
 */
function formatMeta(meta?: Record<string, unknown>): string {
  if (!meta || Object.keys(meta).length === 0) return '';
  try {
    const seen = new WeakSet<object>();
    const json = JSON.stringify(meta, (key, value) => {
      if (SECRET_KEYS.test(key) && typeof value === 'string' && value) {
        return value.length <= 8 ? '***' : `${value.slice(0, 3)}***${value.slice(-2)}`;
      }
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      // Error 的 message/stack 是不可枚举的,默认序列化成 {} —— 手工摊平
      if (value instanceof Error) {
        return { name: value.name, message: value.message };
      }
      return value;
    });
    return json.length > 4000 ? `${json.slice(0, 4000)}…(已截断)` : json;
  } catch (e) {
    // 兜底:序列化失败也要留下痕迹,不能静默丢掉这条日志
    return `[meta 序列化失败: ${e instanceof Error ? e.message : String(e)}]`;
  }
}

const LEVEL_TAG = ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const;

/**
 * 同时写终端与文件的 Logger
 *
 * 写盘用 `appendFileSync` 而非流:
 * - 崩溃与 Ctrl+C 时不丢尾部 —— 而崩溃前那几行恰恰是最要看的
 * - 日志量本来就小(一轮几十行),同步写的开销无关紧要
 * - 流要管 'error' 事件与 close 时机,而它的失败模式是静默丢日志
 *
 * **写盘失败一律降级为只打终端,绝不抛异常**:磁盘满、路径没权限、
 * 目录被删都可能发生,而「因为日志写不下去所以任务失败」是不可接受的
 * (同 TraceRecorder 的处理)。
 */
export class FileLogger implements Logger {
  private failed = false;

  constructor(
    private file: string,
    private level: LogLevel = LogLevel.INFO,
    /** 是否同时打终端。从终端启动时有用,打包后的 exe 里没有意义 */
    private alsoConsole = true,
  ) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      this.file = path.resolve(file);
    } catch {
      this.failed = true;
    }
  }

  /** 实际写入的文件路径 —— 壳要把它显示给用户(不然「日志在哪」得翻代码) */
  get filePath(): string | undefined {
    return this.failed ? undefined : this.file;
  }

  private write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (this.level > level) return;
    const tag = LEVEL_TAG[level];

    if (this.alsoConsole) {
      const fn = level >= LogLevel.WARN ? console.error : console.log;
      fn(`[${tag}] ${message}`, meta || '');
    }

    if (this.failed) return;
    try {
      const ts = new Date().toISOString();
      const rendered = formatMeta(meta);
      fs.appendFileSync(this.file, `${ts} [${tag}] ${message}${rendered ? ' ' + rendered : ''}\n`);
    } catch {
      // 只提示一次,否则每条日志都会再打一行噪音
      if (!this.failed) {
        this.failed = true;
        if (this.alsoConsole) console.error(`[WARN] 日志写盘失败,后续只打终端: ${this.file}`);
      }
    }
  }

  debug(message: string, meta?: Record<string, unknown>): void { this.write(LogLevel.DEBUG, message, meta); }
  info(message: string, meta?: Record<string, unknown>): void { this.write(LogLevel.INFO, message, meta); }
  warn(message: string, meta?: Record<string, unknown>): void { this.write(LogLevel.WARN, message, meta); }
  error(message: string, meta?: Record<string, unknown>): void { this.write(LogLevel.ERROR, message, meta); }
}
