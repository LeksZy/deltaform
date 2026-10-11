import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LedgerEntry, Mode } from '../src/shared/types';
import { randomUUID } from 'node:crypto';

export class Store {
  private db: DatabaseSync;
  private workerToken?: string;
  constructor(path = process.env.DATA_PATH || 'data/toolkit.sqlite') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);');
    this.db.exec('CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY, mode TEXT NOT NULL, timestamp INTEGER NOT NULL, value TEXT NOT NULL); CREATE INDEX IF NOT EXISTS audit_mode_time ON audit(mode,timestamp);');
    for (const mode of ['paper', 'live'] as const) {
      const old = this.get<{ events?: LedgerEntry[] }>('state:' + mode);
      for (const event of old?.events ?? []) this.appendEvent(mode, event);
    }
  }
  get<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : undefined;
  }
  set(key: string, value: unknown) {
    this.db.prepare('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  }
  delete(key: string) { this.db.prepare('DELETE FROM kv WHERE key=?').run(key); }
  /** Synchronous atomic state/audit changes; network calls must finish beforehand. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  appendEvent(mode: Mode, event: LedgerEntry) {
    this.db.prepare('INSERT OR IGNORE INTO audit(id,mode,timestamp,value) VALUES(?,?,?,?)').run(event.id, mode, event.timestamp, JSON.stringify(event));
  }
  history(mode: Mode): LedgerEntry[] {
    return (this.db.prepare('SELECT value FROM audit WHERE mode=? ORDER BY timestamp DESC, rowid DESC').all(mode) as { value: string }[]).map(row => JSON.parse(row.value));
  }
  /** One persistent execution service per database on this local host. */
  acquireWorker() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old = this.get<{ pid: number; token: string }>('workerLock');
      if (old) {
        let alive = true;
        try { process.kill(old.pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
        if (alive) throw new Error(`Another execution service holds this database (process ${old.pid}). Stop it before starting a second worker.`);
      }
      const token = randomUUID();
      this.set('workerLock', { pid: process.pid, token, startedAt: Date.now() });
      this.db.exec('COMMIT'); this.workerToken = token;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() {
    if (this.workerToken && this.get<{ token: string }>('workerLock')?.token === this.workerToken) this.delete('workerLock');
    this.db.close();
  }
}

/** Serializes all state mutations, including worker ticks and HTTP requests. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
