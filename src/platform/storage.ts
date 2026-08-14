// ============================================
// Platform 层:存储接口(起步用 SQLite)
// ============================================

import Database from 'better-sqlite3';
import { Logger } from './logger.js';

export interface StorageRecord {
  key: string;
  value: string;
  created_at: number;
  updated_at: number;
}

export class Storage {
  private db: Database.Database;

  constructor(
    private dbPath: string,
    private logger: Logger,
  ) {
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
