// ============================================
// Platform 层:存储接口(起步用 SQLite)
// ============================================
//
// **better-sqlite3 是惰性加载的,不能放回顶层 import。**
//
// 它是原生模块(编译出的 .node),必须匹配运行它的 V8 ABI。
// 而本项目有两个运行时,ABI 不同:
//   本机 Node v22       → NODE_MODULE_VERSION 127
//   Electron 34 内置 Node → NODE_MODULE_VERSION 132
// 同一个 .node 文件不可能同时满足两者。客户端跑在 Electron 里,
// 所以二进制按 Electron 编(npm run rebuild:native),代价是本机 Node 加载不了它。
//
// 顶层 import 的后果:`platform/index.ts` 有 `export * from './storage.js'`,
// 于是**任何** `from '../platform/index.js'` 都会在导入期加载那个 .node ——
// 8 个测试文件走这条路,全部在导入期就崩,而报错指向 sqlite、
// 看不出跟 Electron 有任何关系。
//
// 改成惰性之后:只有真的 `new Storage(...)` 才碰原生模块。
// 测试不构造它 → 417 个测试在本机 Node 上照常跑;
// 客户端构造它 → 在 Electron 里加载,ABI 对得上。
// 记忆功能在 SQLite 不可用时会降级,由 session.ts 处理(记忆是增强不是必需品)。
//
// 用 createRequire 而不是 `await import()`:后者会把整条链变成异步,
// Storage 的构造函数得跟着变 async —— 那会传染到所有调用方。

import { createRequire } from 'node:module';
import type BetterSqlite3 from 'better-sqlite3';
import { Logger } from './logger.js';

// 类型是 import type(编译期擦除,不产生 require),实现走运行时 require
const require = createRequire(import.meta.url);

export interface StorageRecord {
  key: string;
  value: string;
  created_at: number;
  updated_at: number;
}

export class Storage {
  private db: BetterSqlite3.Database;

  constructor(
    private dbPath: string,
    private logger: Logger,
  ) {
    // 这一行是原生模块唯一的加载点。ABI 不匹配时在这里抛,
    // 由调用方降级 —— 而不是让整个进程在导入期就起不来
    const Database = require('better-sqlite3') as typeof BetterSqlite3;
    this.db = new Database(dbPath);
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.logger.debug('Storage initialized', { dbPath: this.dbPath });
  }

  set(key: string, value: string): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO kv_store (key, value, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=?, updated_at=?
    `);
    stmt.run(key, value, now, now, value, now);
  }

  get(key: string): string | null {
    const stmt = this.db.prepare('SELECT value FROM kv_store WHERE key = ?');
    const row = stmt.get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  delete(key: string): void {
    const stmt = this.db.prepare('DELETE FROM kv_store WHERE key = ?');
    stmt.run(key);
  }

  close(): void {
    this.db.close();
    this.logger.debug('Storage closed');
  }
}
