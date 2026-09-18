import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type DB = Database.Database;

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Opens the system-of-record database with durability and integrity pragmas. */
export function openDb(file: string, opts: { readonly?: boolean } = {}): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file, { readonly: !!opts.readonly, fileMustExist: !!opts.readonly });
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  if (!opts.readonly) {
    if (file !== ':memory:') db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
  } else {
    db.pragma('query_only = ON');
  }
  return db;
}

export function migrate(db: DB): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').pluck().all() as string[]);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const ran: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, new Date().toISOString());
    })();
    ran.push(f);
  }
  return ran;
}

/** Runs fn in a write transaction that takes the write lock up front (BEGIN IMMEDIATE). */
export function tx<T>(db: DB, fn: () => T): T {
  return db.transaction(fn).immediate();
}

/** Opens a read-only companion connection (used for AI context retrieval). */
export function openDbReadOnly(file: string): DB | undefined {
  try {
    return openDb(file, { readonly: true });
  } catch (err) {
    console.error(JSON.stringify({ level: 'warn', msg: 'read-only connection unavailable; AI context falls back to the main connection', error: (err as Error).message }));
    return undefined;
  }
}
