import crypto from 'node:crypto';
import type { DB } from '../db/db.ts';
import type { Actor, Role } from './policy.ts';
import { clock, DAY } from '../lib/clock.ts';

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(pw, Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export interface SessionUser extends Actor {
  username: string;
  sessionId: string;
  csrf: string;
}

const SESSION_TTL = 12 * 60 * 60 * 1000;

export function login(db: DB, username: string, password: string): { sessionId: string } | null {
  const user = db.prepare('SELECT id, password_hash, active FROM users WHERE username = ?').get(username.trim().toLowerCase()) as
    | { id: number; password_hash: string; active: number }
    | undefined;
  if (!user || !user.active || !verifyPassword(password, user.password_hash)) return null;
  const sessionId = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const now = clock.now();
  db.prepare('INSERT INTO sessions (id, user_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(
    sessionId,
    user.id,
    csrf,
    now.toISOString(),
    new Date(now.getTime() + SESSION_TTL).toISOString(),
  );
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date(now.getTime() - DAY).toISOString());
  return { sessionId };
}

export function sessionUser(db: DB, sessionId: string | undefined): SessionUser | null {
  if (!sessionId) return null;
  const row = db
    .prepare(
      `SELECT s.id AS sid, s.csrf_token, s.expires_at, u.id, u.username, u.display_name, u.role, u.active
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    )
    .get(sessionId) as { sid: string; csrf_token: string; expires_at: string; id: number; username: string; display_name: string; role: Role; active: number } | undefined;
  if (!row || !row.active || row.expires_at < clock.iso()) return null;
  return { id: row.id, username: row.username, name: row.display_name, role: row.role, sessionId: row.sid, csrf: row.csrf_token };
}

export function logout(db: DB, sessionId: string) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}
