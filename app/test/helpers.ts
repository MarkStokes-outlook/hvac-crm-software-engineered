import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { migrate, openDb, type DB } from '../src/db/db.ts';
import { seed } from '../src/db/seed.ts';
import { clock } from '../src/lib/clock.ts';
import type { Actor, Role } from '../src/auth/policy.ts';
import { createApp } from '../src/web/app.ts';
import { MockProvider } from '../src/ai/assistant.ts';

export interface TestEnv {
  db: DB;
  dir: string;
  file: string;
  uploadDir: string;
  actors: Record<string, Actor>;
  close(): void;
}

/** A seeded database in a temporary directory. Each test file gets its own. */
export function makeEnv(name = 'frostline-test'): TestEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  const file = path.join(dir, 'test.db');
  const uploadDir = path.join(dir, 'uploads');
  const db = openDb(file);
  migrate(db);
  seed(db);
  clock.set(null);
  const rows = db.prepare('SELECT id, username, display_name, role FROM users').all() as { id: number; username: string; display_name: string; role: Role }[];
  const actors: Record<string, Actor> = {};
  for (const r of rows) actors[r.username] = { id: r.id, role: r.role, name: r.display_name };
  return {
    db,
    dir,
    file,
    uploadDir,
    actors,
    close() {
      clock.set(null);
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface TestServer {
  url: string;
  server: Server;
  close(): Promise<void>;
}

export function startServer(env: TestEnv): Promise<TestServer> {
  const app = createApp({ db: env.db, readDb: openDb(env.file, { readonly: true }), provider: new MockProvider(), uploadDir: env.uploadDir });
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        server,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

/** Minimal cookie-jar HTTP client that follows the app's redirect-with-flash pattern. */
export class Client {
  private cookies = new Map<string, string>();
  constructor(readonly base: string) {}

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private store(res: Response) {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const idx = pair.indexOf('=');
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (value === '' || /Expires=Thu, 01 Jan 1970/i.test(raw)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async get(pathname: string, opts: { redirect?: RequestRedirect } = {}): Promise<Response> {
    const res = await fetch(`${this.base}${pathname}`, { headers: { cookie: this.cookieHeader() }, redirect: opts.redirect ?? 'manual' });
    this.store(res);
    return res;
  }

  async text(pathname: string): Promise<string> {
    const res = await this.get(pathname);
    return res.text();
  }

  async post(pathname: string, body: Record<string, string | string[]>, opts: { csrf?: string } = {}): Promise<Response> {
    const params = new URLSearchParams();
    params.set('_csrf', opts.csrf ?? this.cookies.get('csrf') ?? (await this.csrfToken()));
    for (const [k, v] of Object.entries(body)) {
      if (Array.isArray(v)) for (const item of v) params.append(k, item);
      else params.set(k, v);
    }
    const res = await fetch(`${this.base}${pathname}`, {
      method: 'POST',
      headers: { cookie: this.cookieHeader(), 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      redirect: 'manual',
    });
    this.store(res);
    return res;
  }

  /** Reads the CSRF token out of any authenticated page. */
  async csrfToken(): Promise<string> {
    const html = await this.text('/notifications');
    const m = /name="_csrf" value="([^"]+)"/.exec(html);
    if (!m) throw new Error('No CSRF token on page — not signed in?');
    this.cookies.set('csrf', m[1]);
    return m[1];
  }

  async login(username: string, password = 'frostline'): Promise<void> {
    const loginPage = await this.text('/login');
    const token = /name="_csrf" value="([^"]+)"/.exec(loginPage)?.[1];
    if (!token) throw new Error('No login token');
    const res = await this.post('/login', { username, password }, { csrf: token });
    if (res.status !== 302) throw new Error(`Login failed: ${res.status}`);
    this.cookies.delete('csrf');
    await this.csrfToken();
  }

  /** The flash message the app set on the last redirect, if any. */
  flash(): string | null {
    const raw = this.cookies.get('frostline_flash');
    if (!raw) return null;
    try {
      return (JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { message: string }).message;
    } catch {
      return null;
    }
  }
}

export function jobByRef(db: DB, ref: string) {
  return db.prepare('SELECT * FROM jobs WHERE ref = ?').get(ref) as Record<string, unknown> & { id: number; op_status: string; version: number };
}

export function one<T>(db: DB, sql: string, ...params: unknown[]): T {
  const row = db.prepare(sql).get(...params) as T | undefined;
  if (row === undefined) throw new Error(`No row for: ${sql}`);
  return row;
}

export function count(db: DB, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { n: number }).n;
}

/** Local datetime-local string for a moment relative to now, for form inputs. */
export function localIn(minutes: number): string {
  const d = new Date(clock.now().getTime() + minutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  // Tests run in Europe/London on the CI box; use the same conversion the app does.
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

export const READY_ALL = {
  ready_scope: 'on',
  ready_authority: 'on',
  ready_access: 'on',
  ready_competence: 'on',
  ready_parts: 'on',
  ready_dependencies: 'on',
};
