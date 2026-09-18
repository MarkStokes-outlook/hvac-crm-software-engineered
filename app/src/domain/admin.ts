import type { DB } from '../db/db.ts';
import { tx } from '../db/db.ts';
import { type Actor, APPROVAL_ACTIONS, type ApprovalAction, requireCap, ROLES, type Role } from '../auth/policy.ts';
import { hashPassword } from '../auth/auth.ts';
import { audit } from './audit.ts';
import { clock } from '../lib/clock.ts';
import { DomainError, NotFoundError } from '../lib/errors.ts';
import { Form } from '../lib/form.ts';

export interface UserRow {
  id: number;
  username: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  role: Role;
  active: number;
  home_area: string | null;
  van_location_id: number | null;
  planning_notes: string | null;
  van_code?: string | null;
}

export function listUsers(db: DB): UserRow[] {
  return db
    .prepare(`SELECT u.id, u.username, u.display_name, u.email, u.phone, u.role, u.active, u.home_area, u.van_location_id, u.planning_notes, l.code AS van_code
              FROM users u LEFT JOIN stock_locations l ON l.id = u.van_location_id ORDER BY u.active DESC, u.role, u.display_name`)
    .all() as UserRow[];
}

export function getUser(db: DB, id: number): UserRow {
  const u = listUsers(db).find((x) => x.id === id);
  if (!u) throw new NotFoundError('User');
  return u;
}

export function saveUser(db: DB, actor: Actor, body: Record<string, unknown>, id?: number): number {
  requireCap(actor, 'admin.users');
  const f = new Form(body);
  const d = {
    username: f.str('username', 'Username', 50).toLowerCase(),
    display_name: f.str('display_name', 'Name', 100),
    email: f.opt('email', 200),
    phone: f.opt('phone', 50),
    role: f.oneOf('role', 'Role', ROLES),
    active: f.bool('active') ? 1 : 0,
    home_area: f.opt('home_area', 100),
    van_location_id: f.int('van_location_id', 'Van'),
    planning_notes: f.opt('planning_notes', 2000),
  };
  const password = f.opt('password', 200);
  f.check(/^[a-z0-9._-]{2,50}$/.test(d.username), 'username', 'Username may use letters, numbers, dot, dash, underscore.');
  if (!id) f.check(password && password.length >= 8, 'password', 'Set an initial password of at least 8 characters.');
  else if (password) f.check(password.length >= 8, 'password', 'Password must be at least 8 characters.');
  f.done();
  return tx(db, () => {
    const dup = db.prepare('SELECT id FROM users WHERE username = ?').get(d.username) as { id: number } | undefined;
    if (dup && dup.id !== id) throw new DomainError('Username already in use.', { username: 'In use.' });
    if (id === actor.id && (!d.active || d.role !== 'admin')) throw new DomainError('You cannot remove your own admin access.');
    if (id) {
      const before = getUser(db, id);
      db.prepare(
        `UPDATE users SET username = @username, display_name = @display_name, email = @email, phone = @phone, role = @role, active = @active, home_area = @home_area,
           van_location_id = @van_location_id, planning_notes = @planning_notes WHERE id = @id`,
      ).run({ ...d, id });
      if (password) {
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      }
      if (!d.active || before.role !== d.role) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      audit(db, actor, 'user', id, 'updated', { before: { role: before.role, active: before.active }, after: { role: d.role, active: d.active, password_reset: !!password } });
      return id;
    }
    const r = db
      .prepare(
        `INSERT INTO users (username, display_name, email, phone, role, password_hash, active, home_area, van_location_id, planning_notes, created_at)
         VALUES (@username, @display_name, @email, @phone, @role, @hash, @active, @home_area, @van_location_id, @planning_notes, @now)`,
      )
      .run({ ...d, hash: hashPassword(password!), now: clock.iso() });
    const nid = Number(r.lastInsertRowid);
    audit(db, actor, 'user', nid, 'created', { after: { username: d.username, role: d.role } });
    return nid;
  });
}

export function addCompetence(db: DB, actor: Actor, userId: number, body: Record<string, unknown>) {
  requireCap(actor, 'admin.config');
  const f = new Form(body);
  const d = {
    tag: f.str('tag', 'Competence tag', 60).toLowerCase(),
    detail: f.opt('detail', 300),
    valid_from: f.date('valid_from', 'Valid from', false),
    valid_to: f.date('valid_to', 'Valid to', false),
    notes: f.opt('notes', 1000),
  };
  f.done();
  tx(db, () => {
    const r = db.prepare(`INSERT INTO engineer_competences (user_id, tag, detail, valid_from, valid_to, notes) VALUES (?, ?, ?, ?, ?, ?)`).run(userId, d.tag, d.detail, d.valid_from, d.valid_to, d.notes);
    audit(db, actor, 'user', userId, 'competence_added', { after: { id: Number(r.lastInsertRowid), ...d } });
  });
}

export function removeCompetence(db: DB, actor: Actor, compId: number) {
  requireCap(actor, 'admin.config');
  tx(db, () => {
    const c = db.prepare('SELECT * FROM engineer_competences WHERE id = ?').get(compId) as { user_id: number; tag: string } | undefined;
    if (!c) throw new NotFoundError('Competence');
    db.prepare('DELETE FROM engineer_competences WHERE id = ?').run(compId);
    audit(db, actor, 'user', c.user_id, 'competence_removed', { before: c });
  });
}

export function addClearance(db: DB, actor: Actor, userId: number, body: Record<string, unknown>) {
  requireCap(actor, 'admin.config');
  const f = new Form(body);
  const siteId = f.reqInt('site_id', 'Site');
  const detail = f.opt('detail', 300);
  const validTo = f.date('valid_to', 'Valid to', false);
  f.done();
  tx(db, () => {
    db.prepare(`INSERT INTO engineer_site_clearances (user_id, site_id, detail, valid_to) VALUES (?, ?, ?, ?)`).run(userId, siteId, detail, validTo);
    audit(db, actor, 'user', userId, 'site_clearance_added', { after: { site_id: siteId, detail, valid_to: validTo } });
  });
}

export function listPolicies(db: DB) {
  return db.prepare(`SELECT * FROM approval_policies ORDER BY action, role`).all() as { id: number; action: ApprovalAction; role: Role; max_value_pence: number | null; notes: string | null }[];
}

/** Approval policy is configuration (FR-022). Changes are audited; thresholds default to unset. */
export function savePolicy(db: DB, actor: Actor, body: Record<string, unknown>) {
  requireCap(actor, 'admin.config');
  const f = new Form(body);
  const action = f.oneOf('action', 'Action', Object.keys(APPROVAL_ACTIONS) as ApprovalAction[]);
  const role = f.oneOf('role', 'Role', ROLES);
  const max = f.pence('max_value', 'Maximum value');
  const notes = f.str('notes', 'Governance note / decision reference', 1000);
  const remove = f.bool('remove');
  f.done();
  tx(db, () => {
    const before = db.prepare('SELECT * FROM approval_policies WHERE action = ? AND role = ?').get(action, role);
    if (remove) {
      db.prepare('DELETE FROM approval_policies WHERE action = ? AND role = ?').run(action, role);
    } else {
      db.prepare(
        `INSERT INTO approval_policies (action, role, max_value_pence, notes) VALUES (?, ?, ?, ?)
         ON CONFLICT (action, role) DO UPDATE SET max_value_pence = excluded.max_value_pence, notes = excluded.notes`,
      ).run(action, role, max, notes);
    }
    audit(db, actor, 'approval_policy', null, remove ? 'removed' : 'saved', { reason: notes, before, after: remove ? null : { action, role, max_value_pence: max } });
  });
}

export const EDITABLE_SETTINGS: Record<string, string> = {
  sla_at_risk_fraction: 'Fraction of an SLA window remaining below which a target is shown "at risk" (0–1).',
  planning_day_minutes: 'Planning guide for booked minutes per engineer per day before a working-time warning.',
  default_payment_terms: 'Default payment terms text for new quotation drafts.',
  default_acceptance_method: 'Default acceptance method text for new quotation drafts.',
};

export function listSettings(db: DB) {
  return db.prepare('SELECT * FROM settings ORDER BY key').all() as { key: string; value: string; description: string | null }[];
}

export function saveSetting(db: DB, actor: Actor, body: Record<string, unknown>) {
  requireCap(actor, 'admin.config');
  const f = new Form(body);
  const key = f.oneOf('key', 'Setting', Object.keys(EDITABLE_SETTINGS));
  const value = f.str('value', 'Value', 2000);
  f.done();
  if (key === 'sla_at_risk_fraction') {
    const v = parseFloat(value);
    if (!(v > 0 && v < 1)) throw new DomainError('Enter a fraction between 0 and 1, e.g. 0.25.');
  }
  if (key === 'planning_day_minutes' && !(parseInt(value, 10) >= 60)) throw new DomainError('Enter minutes (at least 60).');
  tx(db, () => {
    const before = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    db.prepare(`INSERT INTO settings (key, value, description) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(key, value, EDITABLE_SETTINGS[key]);
    audit(db, actor, 'setting', null, 'changed', { before, after: { key, value } });
  });
}

export function listOutcomeCodes(db: DB) {
  return db.prepare('SELECT * FROM outcome_codes ORDER BY sort, label').all() as { code: string; label: string; requires_followon: number; temporary: number; resolves: number; active: number; sort: number }[];
}

export function saveOutcomeCode(db: DB, actor: Actor, body: Record<string, unknown>) {
  requireCap(actor, 'admin.config');
  const f = new Form(body);
  const code = f.str('code', 'Code', 40);
  const label = f.str('label', 'Label', 200);
  const active = f.bool('active') ? 1 : 0;
  f.done();
  tx(db, () => {
    const r = db.prepare('UPDATE outcome_codes SET label = ?, active = ? WHERE code = ?').run(label, active, code);
    if (!r.changes) throw new NotFoundError('Outcome code');
    audit(db, actor, 'outcome_code', null, 'updated', { after: { code, label, active } });
  });
}

export function auditLog(db: DB, opts: { entityType?: string; actorId?: number; limit?: number; offset?: number } = {}) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.entityType) {
    where.push('a.entity_type = ?');
    params.push(opts.entityType);
  }
  if (opts.actorId) {
    where.push('a.actor_id = ?');
    params.push(opts.actorId);
  }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = (db.prepare(`SELECT COUNT(*) n FROM audit_events a ${w}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(`SELECT a.*, u.display_name AS actor_name FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id ${w} ORDER BY a.id DESC LIMIT ? OFFSET ?`)
    .all(...params, opts.limit ?? 100, opts.offset ?? 0) as {
    id: number;
    at: string;
    actor_name: string | null;
    actor_role: string | null;
    entity_type: string;
    entity_id: number | null;
    action: string;
    reason: string | null;
    before_json: string | null;
    after_json: string | null;
    correlation_id: string | null;
  }[];
  return { rows, total };
}

export function notificationsFor(db: DB, userId: number, limit = 30) {
  return db.prepare(`SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?`).all(userId, limit) as {
    id: number;
    kind: string;
    message: string;
    link: string | null;
    created_at: string;
    read_at: string | null;
  }[];
}

export function unreadCount(db: DB, userId: number): number {
  return (db.prepare(`SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL`).get(userId) as { n: number }).n;
}

export function markRead(db: DB, userId: number, id?: number) {
  if (id) db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL').run(clock.iso(), id, userId);
  else db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(clock.iso(), userId);
}
