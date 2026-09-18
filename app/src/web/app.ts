import crypto from 'node:crypto';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import type { DB } from '../db/db.ts';
import { config } from '../config.ts';
import { type Role, ROLE_LABEL } from '../auth/policy.ts';
import { login as doLogin, logout as doLogout, sessionUser } from '../auth/auth.ts';
import { DomainError } from '../lib/errors.ts';
import { requestContext } from '../lib/context.ts';
import { html } from '../lib/html.ts';
import { unreadCount } from '../domain/admin.ts';
import { AiAssistant, type AiProvider, providerFromEnv } from '../ai/assistant.ts';
import { banner, loginPage, page } from './ui.ts';
import { back, flashOf, readCookie, type RouteDeps, type RouteModule, safeEqual, setFlash } from './kit.ts';
import dashboardRoutes from './routes/dashboard.ts';
import customerRoutes from './routes/customers.ts';
import jobRoutes from './routes/jobs.ts';
import scheduleRoutes from './routes/schedule.ts';
import fieldRoutes from './routes/field.ts';
import quoteRoutes from './routes/quotes.ts';
import stockRoutes from './routes/stock.ts';
import reportRoutes from './routes/reports.ts';
import adminRoutes from './routes/admin.ts';
import aiRoutes from './routes/ai.ts';

export interface AppDeps {
  db: DB;
  /** Read-only connection handed to the AI assistant (ADR-006 boundary). */
  readDb?: DB;
  provider?: AiProvider;
  uploadDir?: string;
}

const MODULES: RouteModule[] = [dashboardRoutes, customerRoutes, jobRoutes, scheduleRoutes, fieldRoutes, quoteRoutes, stockRoutes, reportRoutes, adminRoutes, aiRoutes];
const PUBLIC_PATHS = new Set(['/login', '/healthz']);

export function createApp(deps: AppDeps) {
  const { db } = deps;
  const uploadDir = deps.uploadDir ?? config.uploadDir;
  const readDb = deps.readDb ?? db;
  const ai = new AiAssistant(readDb, db, deps.provider ?? providerFromEnv());

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    requestContext.run({ correlationId: crypto.randomUUID() }, () => next());
  });

  app.use('/static', express.static(path.join(config.root, 'public'), { maxAge: config.isProd ? '1h' : 0, index: false, redirect: false }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // Multipart bodies (evidence photos, CSV imports) must be parsed before the CSRF check,
  // otherwise the token in the form is invisible to it and every upload is rejected.
  const uploads = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 1, fields: 80 } });
  app.use((req, res, next) => {
    if (!req.is('multipart/form-data')) return next();
    uploads.any()(req, res, (err?: unknown) => {
      if (err) return next(err);
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      req.file = files.find((f) => f.fieldname === 'file');
      next();
    });
  });

  app.get('/healthz', (_req, res) => {
    const row = db.prepare('SELECT COUNT(*) n FROM users').get() as { n: number };
    res.json({ status: 'ok', users: row.n, time: new Date().toISOString() });
  });

  // ---------------------------------------------------------------- session, auth, CSRF
  app.use((req, _res, next) => {
    req.user = sessionUser(db, readCookie(req, config.sessionCookie)) ?? undefined;
    next();
  });

  app.get('/login', (req, res) => {
    if (req.user) return res.redirect('/');
    const users = db.prepare(`SELECT username, display_name, role FROM users WHERE active = 1 ORDER BY role, display_name`).all() as { username: string; display_name: string; role: Role }[];
    const csrf = ensureLoginToken(req, res);
    const flash = flashOf(req, res);
    res.type('html').send(loginPage({ users, csrf, next: typeof req.query.next === 'string' ? req.query.next : undefined, error: flash?.tone === 'err' ? flash.message : undefined }));
  });

  app.post('/login', (req, res) => {
    const token = readCookie(req, 'frostline_lt');
    if (!token || !safeEqual(token, String(req.body?._csrf ?? ''))) {
      setFlash(res, 'err', 'Your sign-in form expired. Please try again.');
      return res.redirect('/login');
    }
    const session = doLogin(db, String(req.body?.username ?? ''), String(req.body?.password ?? ''));
    if (!session) {
      setFlash(res, 'err', 'Username or password not recognised.');
      return res.redirect('/login');
    }
    res.cookie(config.sessionCookie, session.sessionId, { httpOnly: true, sameSite: 'lax', secure: config.isProd, path: '/' });
    res.clearCookie('frostline_lt', { path: '/' });
    const next = typeof req.body?.next === 'string' && req.body.next.startsWith('/') && !req.body.next.startsWith('//') ? req.body.next : '/';
    res.redirect(next);
  });

  // Every operational route requires an authenticated user (AC-002-01).
  app.use((req, res, next) => {
    if (PUBLIC_PATHS.has(req.path)) return next();
    if (!req.user) {
      if (req.method !== 'GET') {
        setFlash(res, 'err', 'Your session ended. Please sign in again.');
        return res.redirect('/login');
      }
      return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    }
    req.ctx = { user: req.user, csrf: req.user.csrf, path: req.path, unread: unreadCount(db, req.user.id), flash: flashOf(req, res) };
    next();
  });

  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const supplied = String((req.body as Record<string, unknown> | undefined)?._csrf ?? req.get('x-csrf-token') ?? '');
    if (!req.user || !safeEqual(req.user.csrf, supplied)) {
      setFlash(res, 'err', 'That form expired or came from another tab. Please reload the page and try again.');
      return res.redirect(back(req));
    }
    next();
  });

  app.post('/logout', (req, res) => {
    if (req.user) doLogout(db, req.user.sessionId);
    res.clearCookie(config.sessionCookie, { path: '/' });
    setFlash(res, 'ok', 'Signed out.');
    res.redirect('/login');
  });

  const routeDeps: RouteDeps = { db, readDb, ai, uploadDir };
  for (const register of MODULES) register(app, routeDeps);

  // ---------------------------------------------------------------- errors
  app.use((req, res) => {
    if (!req.ctx) return res.status(404).type('text').send('Not found');
    res
      .status(404)
      .type('html')
      .send(
        page(req.ctx, {
          title: 'Not found',
          heading: 'Page not found',
          narrow: true,
          body: html`${banner('warn', html`No page at <code>${req.path}</code>. It may have moved, or the record may have been removed.`)}<a class="btn" href="/">Back to dashboard</a>`,
        }),
      );
  });

  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof multer.MulterError) {
      err = new DomainError(err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large — photos must be under 12 MB.' : `Upload rejected (${err.code}).`);
    }
    const de = err as DomainError;
    const isDomain = err instanceof DomainError;
    const status = isDomain && typeof de.status === 'number' ? de.status : 500;
    if (!isDomain || status >= 500) {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: err.message,
          stack: err.stack?.split('\n').slice(0, 5),
          path: req.originalUrl,
          method: req.method,
          user: req.user?.username,
          correlationId: requestContext.getStore()?.correlationId,
        }),
      );
    }
    // A failed action returns the user to the page they submitted from, with the reason.
    if (req.method !== 'GET' && isDomain) {
      setFlash(res, 'err', err.message);
      return res.redirect(back(req));
    }
    if (!req.ctx) return res.status(status).type('text').send(isDomain ? err.message : 'Something went wrong.');
    res
      .status(status)
      .type('html')
      .send(
        page(req.ctx, {
          title: status === 403 ? 'Not permitted' : status === 404 ? 'Not found' : 'Something went wrong',
          heading: status === 403 ? 'Not permitted' : status === 404 ? 'Not found' : 'Something went wrong',
          narrow: true,
          body: html`${banner(
            status === 500 ? 'err' : 'warn',
            isDomain
              ? html`${err.message}`
              : html`The page could not be built and nothing was changed. If it keeps happening, quote this reference: <code>${requestContext.getStore()?.correlationId ?? '—'}</code>.`,
          )}
          ${status === 403 ? html`<p class="subtle">You are signed in as ${req.user?.name} (${ROLE_LABEL[req.user!.role]}).</p>` : ''}
          <div class="btnrow"><a class="btn" href="/">Dashboard</a></div>`,
        }),
      );
  });

  return app;
}

function ensureLoginToken(req: Request, res: Response): string {
  const existing = readCookie(req, 'frostline_lt');
  if (existing) return existing;
  const token = crypto.randomBytes(24).toString('base64url');
  res.cookie('frostline_lt', token, { httpOnly: true, sameSite: 'lax', secure: config.isProd, path: '/', maxAge: 30 * 60_000 });
  return token;
}
