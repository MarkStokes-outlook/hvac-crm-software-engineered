import type { DB } from '../db/db.ts';
import { tx } from '../db/db.ts';
import { type Actor, can, requireCap } from '../auth/policy.ts';
import { audit } from './audit.ts';
import { clock } from '../lib/clock.ts';
import { DomainError, ForbiddenError, NotFoundError } from '../lib/errors.ts';
import { Form } from '../lib/form.ts';
import { nextRef } from '../lib/refs.ts';

export const CONTACT_ROLES = ['procurement', 'facilities', 'site', 'finance', 'technical', 'escalation', 'other'] as const;
export const SECTORS = ['Offices & commercial property', 'Retail', 'Hospitality & leisure', 'Education', 'Healthcare & care', 'Light industrial & warehousing', 'Facilities management', 'Public sector'] as const;
export const ASSET_STATUSES = ['in_service', 'out_of_service', 'decommissioned'] as const;

export interface Customer {
  id: number;
  ref: string;
  trading_name: string;
  legal_name: string | null;
  company_number: string | null;
  billing_address: string | null;
  billing_email: string | null;
  invoice_notes: string | null;
  po_required: number;
  sector: string | null;
  status: 'active' | 'prospect' | 'inactive';
  account_notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface Site {
  id: number;
  customer_id: number;
  ref: string;
  name: string;
  address: string;
  town: string | null;
  postcode: string | null;
  area: string | null;
  opening_hours: string | null;
  parking_loading: string | null;
  keys_security: string | null;
  induction_permits: string | null;
  induction_required: number;
  roof_plant_access: string | null;
  asbestos_info: string | null;
  safeguarding: string | null;
  work_restrictions: string | null;
  billing_arrangement: string | null;
  access_confirmed_at: string | null;
  access_confirmed_by: number | null;
  status: string;
  customer_name?: string;
}

export interface Contact {
  id: number;
  customer_id: number;
  site_id: number | null;
  name: string;
  role_type: (typeof CONTACT_ROLES)[number];
  job_title: string | null;
  phone: string | null;
  email: string | null;
  can_authorise_spend: number;
  authority_notes: string | null;
  notes: string | null;
  site_name?: string | null;
}

export interface Asset {
  id: number;
  site_id: number;
  ref: string;
  category: string;
  description: string;
  manufacturer: string | null;
  model: string | null;
  serial: string | null;
  location_detail: string | null;
  refrigerant: string | null;
  install_date: string | null;
  ownership_note: string | null;
  status: string;
  notes: string | null;
  site_name?: string;
  customer_id?: number;
  customer_name?: string;
}

/** Security-sensitive site fields (NFR-004). */
export const SENSITIVE_SITE_FIELDS = ['keys_security', 'safeguarding'] as const;

/** Engineers see a site's context only when they have (or had) work there. */
export function engineerAssignedToSite(db: DB, userId: number, siteId: number): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM attendances a JOIN jobs j ON j.id = a.job_id
       WHERE a.engineer_user_id = ? AND j.site_id = ? AND a.status <> 'cancelled' LIMIT 1`,
    )
    .get(userId, siteId);
}

export function canReadSite(db: DB, actor: Actor, siteId: number): boolean {
  if (can(actor, 'crm.read')) return true;
  return actor.role === 'engineer' && engineerAssignedToSite(db, actor.id, siteId);
}

export function canReadSiteSecurity(db: DB, actor: Actor, siteId: number): boolean {
  if (can(actor, 'site.security.read')) return true;
  return actor.role === 'engineer' && engineerAssignedToSite(db, actor.id, siteId);
}

/** Returns the site with sensitive fields redacted for roles without a need to know. */
export function redactSite<T extends Partial<Site>>(db: DB, actor: Actor, site: T): T & { redacted: boolean } {
  if (site.id && canReadSiteSecurity(db, actor, site.id)) return { ...site, redacted: false };
  const copy: T & { redacted: boolean } = { ...site, redacted: true };
  for (const f of SENSITIVE_SITE_FIELDS) (copy as Record<string, unknown>)[f] = site[f] ? '[restricted]' : null;
  return copy;
}

// ------------------------------------------------------------------ queries

export function listCustomers(db: DB, opts: { q?: string; status?: string; limit?: number; offset?: number } = {}) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.q) {
    where.push(`(c.trading_name LIKE ? OR c.legal_name LIKE ? OR c.ref LIKE ?)`);
    const like = `%${opts.q}%`;
    params.push(like, like, like);
  }
  if (opts.status) {
    where.push('c.status = ?');
    params.push(opts.status);
  }
  const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) n FROM customers c ${sqlWhere}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT c.*,
         (SELECT COUNT(*) FROM sites s WHERE s.customer_id = c.id) AS site_count,
         (SELECT COUNT(*) FROM jobs j WHERE j.customer_id = c.id AND j.op_status NOT IN ('operationally_complete','cancelled')) AS open_jobs,
         (SELECT COUNT(*) FROM contracts k WHERE k.customer_id = c.id AND k.status = 'active') AS active_contracts
       FROM customers c ${sqlWhere} ORDER BY c.trading_name LIMIT ? OFFSET ?`,
    )
    .all(...params, opts.limit ?? 50, opts.offset ?? 0) as (Customer & { site_count: number; open_jobs: number; active_contracts: number })[];
  return { rows, total };
}

export function getCustomer(db: DB, id: number): Customer {
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as Customer | undefined;
  if (!c) throw new NotFoundError('Customer');
  return c;
}

export function getSite(db: DB, id: number): Site {
  const s = db.prepare('SELECT s.*, c.trading_name AS customer_name FROM sites s JOIN customers c ON c.id = s.customer_id WHERE s.id = ?').get(id) as Site | undefined;
  if (!s) throw new NotFoundError('Site');
  return s;
}

export function getAsset(db: DB, id: number): Asset {
  const a = db
    .prepare(
      `SELECT a.*, s.name AS site_name, s.customer_id, c.trading_name AS customer_name
       FROM assets a JOIN sites s ON s.id = a.site_id JOIN customers c ON c.id = s.customer_id WHERE a.id = ?`,
    )
    .get(id) as Asset | undefined;
  if (!a) throw new NotFoundError('Asset');
  return a;
}

export function sitesForCustomer(db: DB, customerId: number) {
  return db
    .prepare(
      `SELECT s.*,
        (SELECT COUNT(*) FROM assets a WHERE a.site_id = s.id AND a.status <> 'decommissioned') AS asset_count,
        (SELECT COUNT(*) FROM jobs j WHERE j.site_id = s.id AND j.op_status NOT IN ('operationally_complete','cancelled')) AS open_jobs
       FROM sites s WHERE s.customer_id = ? ORDER BY s.name`,
    )
    .all(customerId) as (Site & { asset_count: number; open_jobs: number })[];
}

export function contactsFor(db: DB, customerId: number, siteId?: number) {
  if (siteId) {
    return db
      .prepare(`SELECT ct.*, s.name AS site_name FROM contacts ct LEFT JOIN sites s ON s.id = ct.site_id WHERE ct.customer_id = ? AND (ct.site_id = ? OR ct.site_id IS NULL) ORDER BY ct.site_id IS NULL, ct.role_type, ct.name`)
      .all(customerId, siteId) as Contact[];
  }
  return db
    .prepare(`SELECT ct.*, s.name AS site_name FROM contacts ct LEFT JOIN sites s ON s.id = ct.site_id WHERE ct.customer_id = ? ORDER BY ct.role_type, ct.name`)
    .all(customerId) as Contact[];
}

export function assetsForSite(db: DB, siteId: number) {
  return db.prepare(`SELECT * FROM assets WHERE site_id = ? ORDER BY status = 'decommissioned', category, ref`).all(siteId) as Asset[];
}

export function listAssets(db: DB, opts: { q?: string; limit?: number; offset?: number } = {}) {
  const params: unknown[] = [];
  let where = '';
  if (opts.q) {
    const like = `%${opts.q}%`;
    where = `WHERE a.ref LIKE ? OR a.serial LIKE ? OR a.model LIKE ? OR a.manufacturer LIKE ? OR a.description LIKE ? OR s.name LIKE ? OR c.trading_name LIKE ?`;
    params.push(like, like, like, like, like, like, like);
  }
  const base = `FROM assets a JOIN sites s ON s.id = a.site_id JOIN customers c ON c.id = s.customer_id ${where}`;
  const total = (db.prepare(`SELECT COUNT(*) n ${base}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT a.*, s.name AS site_name, c.trading_name AS customer_name, c.id AS customer_id,
         (SELECT COUNT(*) FROM job_assets ja JOIN jobs j ON j.id = ja.job_id WHERE ja.asset_id = a.id AND j.op_status NOT IN ('operationally_complete','cancelled')) AS open_jobs
       ${base} ORDER BY c.trading_name, s.name, a.ref LIMIT ? OFFSET ?`,
    )
    .all(...params, opts.limit ?? 50, opts.offset ?? 0) as (Asset & { open_jobs: number })[];
  return { rows, total };
}

export function contractsForCustomer(db: DB, customerId: number) {
  const rows = db.prepare(`SELECT * FROM contracts WHERE customer_id = ? ORDER BY status, starts_on DESC`).all(customerId) as Contract[];
  return rows.map((k) => ({
    ...k,
    sites: db.prepare(`SELECT s.id, s.name FROM contract_sites cs JOIN sites s ON s.id = cs.site_id WHERE cs.contract_id = ?`).all(k.id) as { id: number; name: string }[],
    targets: db.prepare(`SELECT * FROM contract_targets WHERE contract_id = ? ORDER BY priority`).all(k.id) as ContractTarget[],
  }));
}

export interface Contract {
  id: number;
  customer_id: number;
  ref: string;
  name: string;
  starts_on: string;
  ends_on: string | null;
  entitlement_notes: string | null;
  clock_stop_permitted: number;
  clock_stop_terms: string | null;
  status: string;
}
export interface ContractTarget {
  contract_id: number;
  priority: string;
  response_minutes: number | null;
  attendance_minutes: number | null;
  resolution_minutes: number | null;
}

/** Active contract covering a site today, if any. */
export function contractForSite(db: DB, siteId: number): Contract | null {
  const today = clock.iso().slice(0, 10);
  return (
    (db
      .prepare(
        `SELECT k.* FROM contracts k JOIN contract_sites cs ON cs.contract_id = k.id
         WHERE cs.site_id = ? AND k.status = 'active' AND k.starts_on <= ? AND (k.ends_on IS NULL OR k.ends_on >= ?)
         ORDER BY k.starts_on DESC LIMIT 1`,
      )
      .get(siteId, today, today) as Contract | undefined) ?? null
  );
}

/** Work history for a customer, site or asset — links to the single job/attendance records (AC-011-02). */
export function workHistory(db: DB, scope: { customerId?: number; siteId?: number; assetId?: number }, limit = 50) {
  let where: string;
  let param: number;
  if (scope.assetId) {
    where = 'j.id IN (SELECT job_id FROM job_assets WHERE asset_id = ?)';
    param = scope.assetId;
  } else if (scope.siteId) {
    where = 'j.site_id = ?';
    param = scope.siteId;
  } else {
    where = 'j.customer_id = ?';
    param = scope.customerId!;
  }
  const jobs = db
    .prepare(
      `SELECT j.id, j.ref, j.title, j.kind, j.priority, j.op_status, j.financial_status, j.commercial_status, j.received_at, j.reported_symptom,
         s.name AS site_name, s.id AS site_id
       FROM jobs j JOIN sites s ON s.id = j.site_id WHERE ${where} ORDER BY j.received_at DESC LIMIT ?`,
    )
    .all(param, limit) as HistoryJob[];
  const attStmt = db.prepare(
    `SELECT a.id, a.ref, a.status, a.outcome, a.planned_start, a.arrived_at, a.submitted_at, a.diagnosis, a.work_done, a.final_condition, a.recommendations,
       u.display_name AS engineer_name
     FROM attendances a JOIN users u ON u.id = a.engineer_user_id WHERE a.job_id = ? AND a.status <> 'cancelled' ORDER BY a.planned_start`,
  );
  return jobs.map((j) => ({ ...j, attendances: attStmt.all(j.id) as HistoryAttendance[] }));
}
export interface HistoryJob {
  id: number;
  ref: string;
  title: string;
  kind: string;
  priority: string;
  op_status: string;
  financial_status: string;
  commercial_status: string;
  received_at: string;
  reported_symptom: string | null;
  site_name: string;
  site_id: number;
}
export interface HistoryAttendance {
  id: number;
  ref: string;
  status: string;
  outcome: string | null;
  planned_start: string;
  arrived_at: string | null;
  submitted_at: string | null;
  diagnosis: string | null;
  work_done: string | null;
  final_condition: string | null;
  recommendations: string | null;
  engineer_name: string;
}

// ------------------------------------------------------------------ mutations

export function saveCustomer(db: DB, actor: Actor, body: Record<string, unknown>, id?: number): number {
  requireCap(actor, 'crm.write');
  const f = new Form(body);
  const data = {
    trading_name: f.str('trading_name', 'Trading name', 200),
    sector: f.opt('sector', 100),
    status: f.oneOf('status', 'Status', ['active', 'prospect', 'inactive'] as const),
    account_notes: f.opt('account_notes'),
  };
  const billing = {
    legal_name: f.opt('legal_name', 200),
    company_number: f.opt('company_number', 20),
    billing_address: f.opt('billing_address', 500),
    billing_email: f.opt('billing_email', 200),
    invoice_notes: f.opt('invoice_notes'),
    po_required: f.bool('po_required') ? 1 : 0,
  };
  if (billing.billing_email) f.check(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(billing.billing_email), 'billing_email', 'Billing email is not valid.');
  f.done();
  const now = clock.iso();
  // Legal/billing identity is finance-controlled once set (AC-010-02); new records can capture it at creation.
  const billingAllowed = can(actor, 'crm.billing.write');
  return tx(db, () => {
    if (id) {
      const before = getCustomer(db, id);
      const billingChanged = (Object.keys(billing) as (keyof typeof billing)[]).some((k) => (before[k] ?? null) !== (billing[k] ?? null) && !(k === 'po_required' && before.po_required === billing.po_required));
      if (billingChanged && !billingAllowed) {
        throw new ForbiddenError('Legal/billing identity can only be changed by Finance or a Manager.');
      }
      const set = billingAllowed ? { ...data, ...billing } : data;
      const cols = Object.keys(set);
      db.prepare(`UPDATE customers SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_at = @now WHERE id = @id`).run({ ...set, now, id });
      audit(db, actor, 'customer', id, 'updated', { before: pick(before, cols), after: set });
      return id;
    }
    const ref = nextRef(db, 'CUS');
    const r = db
      .prepare(
        `INSERT INTO customers (ref, trading_name, legal_name, company_number, billing_address, billing_email, invoice_notes, po_required, sector, status, account_notes, created_at, updated_at)
         VALUES (@ref, @trading_name, @legal_name, @company_number, @billing_address, @billing_email, @invoice_notes, @po_required, @sector, @status, @account_notes, @now, @now)`,
      )
      .run({ ...data, ...billing, ref, now });
    const newId = Number(r.lastInsertRowid);
    audit(db, actor, 'customer', newId, 'created', { after: { ref, ...data } });
    return newId;
  });
}

const SITE_FIELDS = [
  'name', 'address', 'town', 'postcode', 'area', 'opening_hours', 'parking_loading', 'keys_security', 'induction_permits',
  'roof_plant_access', 'asbestos_info', 'safeguarding', 'work_restrictions', 'billing_arrangement',
] as const;

export function saveSite(db: DB, actor: Actor, customerId: number, body: Record<string, unknown>, id?: number): number {
  requireCap(actor, 'crm.write');
  const f = new Form(body);
  const data: Record<string, unknown> = {};
  for (const k of SITE_FIELDS) data[k] = k === 'name' ? f.str('name', 'Site name', 200) : k === 'address' ? f.str('address', 'Address', 500) : f.opt(k);
  data.induction_required = f.bool('induction_required') ? 1 : 0;
  data.status = f.oneOf('status', 'Status', ['active', 'inactive'] as const, false) || 'active';
  const confirmAccess = f.bool('confirm_access');
  f.done();
  const now = clock.iso();
  return tx(db, () => {
    getCustomer(db, customerId);
    if (confirmAccess) {
      data.access_confirmed_at = now;
      data.access_confirmed_by = actor.id;
    }
    if (id) {
      const before = getSite(db, id);
      if (before.customer_id !== customerId) throw new ForbiddenError('Site does not belong to this customer.');
      const cols = Object.keys(data);
      db.prepare(`UPDATE sites SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_at = @now WHERE id = @id`).run({ ...data, now, id });
      audit(db, actor, 'site', id, confirmAccess ? 'updated_access_confirmed' : 'updated', { before: pick(before, cols), after: data });
      return id;
    }
    const ref = nextRef(db, 'S');
    const cols = Object.keys(data);
    const r = db
      .prepare(`INSERT INTO sites (customer_id, ref, ${cols.join(', ')}, created_at, updated_at) VALUES (@customer_id, @ref, ${cols.map((c) => '@' + c).join(', ')}, @now, @now)`)
      .run({ ...data, customer_id: customerId, ref, now });
    const newId = Number(r.lastInsertRowid);
    audit(db, actor, 'site', newId, 'created', { after: { ref, name: data.name } });
    return newId;
  });
}

export function saveContact(db: DB, actor: Actor, customerId: number, body: Record<string, unknown>, id?: number): number {
  requireCap(actor, 'crm.write');
  const f = new Form(body);
  const siteId = f.int('site_id', 'Site');
  const data = {
    name: f.str('name', 'Name', 200),
    role_type: f.oneOf('role_type', 'Contact role', CONTACT_ROLES),
    job_title: f.opt('job_title', 200),
    phone: f.opt('phone', 50),
    email: f.opt('email', 200),
    can_authorise_spend: f.bool('can_authorise_spend') ? 1 : 0,
    authority_notes: f.opt('authority_notes'),
    notes: f.opt('notes'),
    site_id: siteId,
  };
  f.check(data.phone || data.email, 'phone', 'Provide a phone number or email.');
  f.done();
  return tx(db, () => {
    if (siteId) {
      const s = getSite(db, siteId);
      if (s.customer_id !== customerId) throw new ForbiddenError('Site does not belong to this customer.');
    }
    if (id) {
      const before = db.prepare('SELECT * FROM contacts WHERE id = ? AND customer_id = ?').get(id, customerId) as Contact | undefined;
      if (!before) throw new NotFoundError('Contact');
      const cols = Object.keys(data);
      db.prepare(`UPDATE contacts SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`).run({ ...data, id });
      audit(db, actor, 'contact', id, 'updated', { before: pick(before, cols), after: data });
      return id;
    }
    const r = db
      .prepare(
        `INSERT INTO contacts (customer_id, site_id, name, role_type, job_title, phone, email, can_authorise_spend, authority_notes, notes, created_at)
         VALUES (@customer_id, @site_id, @name, @role_type, @job_title, @phone, @email, @can_authorise_spend, @authority_notes, @notes, @now)`,
      )
      .run({ ...data, customer_id: customerId, now: clock.iso() });
    const newId = Number(r.lastInsertRowid);
    audit(db, actor, 'contact', newId, 'created', { after: { name: data.name, role_type: data.role_type } });
    return newId;
  });
}

export function saveAsset(db: DB, actor: Actor, siteId: number, body: Record<string, unknown>, id?: number): number {
  requireCap(actor, 'crm.write');
  const f = new Form(body);
  const data = {
    category: f.str('category', 'Category', 100),
    description: f.str('description', 'Description', 300),
    manufacturer: f.opt('manufacturer', 100),
    model: f.opt('model', 100),
    serial: f.opt('serial', 100),
    location_detail: f.opt('location_detail', 300),
    refrigerant: f.opt('refrigerant', 50),
    install_date: f.date('install_date', 'Install date', false),
    ownership_note: f.opt('ownership_note'),
    status: f.oneOf('status', 'Status', ASSET_STATUSES, false) || 'in_service',
    notes: f.opt('notes'),
  };
  const internalRef = f.opt('ref', 40);
  f.done();
  const now = clock.iso();
  return tx(db, () => {
    getSite(db, siteId);
    if (id) {
      const before = getAsset(db, id);
      const cols = Object.keys(data);
      db.prepare(`UPDATE assets SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_at = @now WHERE id = @id`).run({ ...data, now, id });
      audit(db, actor, 'asset', id, 'updated', { before: pick(before, cols), after: data });
      return id;
    }
    const ref = internalRef || nextRef(db, 'AS', 10000);
    if (db.prepare('SELECT 1 FROM assets WHERE ref = ?').get(ref)) throw new DomainError('That asset reference is already in use.', { ref: 'Already in use.' });
    const r = db
      .prepare(
        `INSERT INTO assets (site_id, ref, category, description, manufacturer, model, serial, location_detail, refrigerant, install_date, ownership_note, status, notes, created_at, updated_at)
         VALUES (@site_id, @ref, @category, @description, @manufacturer, @model, @serial, @location_detail, @refrigerant, @install_date, @ownership_note, @status, @notes, @now, @now)`,
      )
      .run({ ...data, site_id: siteId, ref, now });
    const newId = Number(r.lastInsertRowid);
    audit(db, actor, 'asset', newId, 'created', { after: { ref, ...data } });
    return newId;
  });
}

function pick(obj: object, keys: string[]) {
  const o = obj as Record<string, unknown>;
  return Object.fromEntries(keys.map((k) => [k, o[k]]));
}
