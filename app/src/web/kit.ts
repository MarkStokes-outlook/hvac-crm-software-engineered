import crypto from 'node:crypto';
import type express from 'express';
import type { Request, Response } from 'express';
import type { DB } from '../db/db.ts';
import { config } from '../config.ts';
import { type Capability, can, requireCap as policyRequireCap } from '../auth/policy.ts';
import type { SessionUser } from '../auth/auth.ts';
import { ForbiddenError, NotFoundError } from '../lib/errors.ts';
import { escapeHtml, html } from '../lib/html.ts';
import type { AiAssistant } from '../ai/assistant.ts';
import type { Ctx } from './ui.ts';

declare global {
  namespace Express {
    interface Request {
      user?: SessionUser;
      ctx?: Ctx;
    }
  }
}

export interface RouteDeps {
  db: DB;
  readDb: DB;
  ai: AiAssistant;
  uploadDir: string;
}
export type RouteModule = (app: express.Express, deps: RouteDeps) => void;

export function ctxOf(req: Request): Ctx {
  if (!req.ctx) throw new ForbiddenError('Sign in required.');
  return req.ctx;
}

export function actorOf(req: Request): SessionUser {
  if (!req.user) throw new ForbiddenError('Sign in required.');
  return req.user;
}

export function needCap(req: Request, cap: Capability): SessionUser {
  const user = actorOf(req);
  policyRequireCap(user, cap);
  return user;
}

export function canReq(req: Request, cap: Capability): boolean {
  return can(req.user, cap);
}

export function intParam(req: Request, name = 'id'): number {
  const v = parseInt(String(req.params[name]), 10);
  if (!Number.isInteger(v) || v <= 0) throw new NotFoundError();
  return v;
}

export function intQuery(req: Request, name: string): number | undefined {
  const raw = req.query[name];
  if (raw === undefined || raw === '') return undefined;
  const v = parseInt(String(raw), 10);
  return Number.isInteger(v) ? v : undefined;
}

export function strQuery(req: Request, name: string, max = 200): string | undefined {
  const v = req.query[name];
  if (typeof v !== 'string' || v === '') return undefined;
  return v.slice(0, max);
}

export function send(res: Response, body: string) {
  res.type('html').send(body);
}

/** Where a form submission should return to. Only same-site paths are honoured. */
export function back(req: Request): string {
  const supplied = (req.body as Record<string, unknown> | undefined)?.__back;
  if (typeof supplied === 'string' && supplied.startsWith('/') && !supplied.startsWith('//')) return supplied;
  const ref = req.get('referer');
  if (ref) {
    try {
      const u = new URL(ref, `${req.protocol}://${req.get('host')}`);
      if (u.host === req.get('host')) return u.pathname + u.search + u.hash;
    } catch {
      /* ignore malformed referer */
    }
  }
  return '/';
}

export function setFlash(res: Response, tone: 'ok' | 'err' | 'warn' | 'info', message: string) {
  const payload = Buffer.from(JSON.stringify({ tone, message: message.slice(0, 400) }), 'utf8').toString('base64url');
  res.cookie('frostline_flash', payload, { httpOnly: true, sameSite: 'lax', secure: config.isProd, path: '/', maxAge: 30_000 });
}

export function redirectWithFlash(res: Response, to: string, tone: 'ok' | 'err' | 'warn' | 'info', message: string) {
  setFlash(res, tone, message);
  res.redirect(to);
}

export function ok(res: Response, to: string, message: string) {
  redirectWithFlash(res, to, 'ok', message);
}

export function flashOf(req: Request, res: Response): Ctx['flash'] {
  const value = readCookie(req, 'frostline_flash');
  if (!value) return null;
  res.clearCookie('frostline_flash', { path: '/' });
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { tone: string; message: string };
    const tone = (['ok', 'err', 'warn', 'info'] as const).find((t) => t === parsed.tone) ?? 'info';
    return { tone, message: String(parsed.message).slice(0, 400) };
  } catch {
    return null;
  }
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length || ab.length === 0) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Hidden input recording where a form was submitted from, so errors return the user there. */
export function backInput(req: Request) {
  return html`<input type="hidden" name="__back" value="${escapeHtml(req.originalUrl)}">`;
}

/** Wraps an async handler so rejections reach the error middleware on any Express version. */
export function h(fn: (req: Request, res: Response) => Promise<void> | void) {
  return (req: Request, res: Response, next: (err?: unknown) => void) => {
    try {
      const r = fn(req, res);
      if (r instanceof Promise) r.catch(next);
    } catch (err) {
      next(err);
    }
  };
}
