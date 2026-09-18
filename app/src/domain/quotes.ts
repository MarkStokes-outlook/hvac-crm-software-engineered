import type { DB } from '../db/db.ts';
import { tx } from '../db/db.ts';
import { type Actor, checkApproval, requireApproval, requireCap } from '../auth/policy.ts';
import { audit, notify } from './audit.ts';
import { clock } from '../lib/clock.ts';
import { ConflictError, DomainError, NotFoundError } from '../lib/errors.ts';
import { Form } from '../lib/form.ts';
import { nextRef } from '../lib/refs.ts';
import { getSite } from './crm.ts';

export const MATURITIES = ['enquiry', 'qualified', 'survey', 'estimate', 'quoted', 'awarded', 'lost', 'withdrawn'] as const;
export const ESTIMATE_BASES = ['budget_indication', 'concept_estimate', 'developed_estimate', 'approved_quotation_basis', 'delivery_forecast'] as const;
export const ESTIMATE_BASIS_LABEL: Record<(typeof ESTIMATE_BASES)[number], string> = {
  budget_indication: 'Budget indication',
  concept_estimate: 'Concept estimate',
  developed_estimate: 'Developed estimate',
  approved_quotation_basis: 'Approved quotation basis',
  delivery_forecast: 'Delivery forecast',
};
export const OPP_SOURCES = ['enquiry', 'engineer_recommendation', 'maintenance_finding', 'tender', 'other'] as const;
export const LINE_TYPES = ['labour', 'materials', 'equipment', 'subcontract', 'provisional_sum', 'other'] as const;
export const VARIATION_CLASSES = [
  'in_scope_clarification',
  'frostline_error',
  'customer_change',
  'failed_assumption',
  'third_party_dependency',
  'emergency_make_safe',
  'separate_follow_on',
] as const;
export const VARIATION_LABEL: Record<(typeof VARIATION_CLASSES)[number], string> = {
  in_scope_clarification: 'In-scope clarification',
  frostline_error: 'FrostLine error',
  customer_change: 'Customer change',
  failed_assumption: 'Failed explicit assumption',
  third_party_dependency: 'Third-party dependency',
  emergency_make_safe: 'Emergency make-safe',
  separate_follow_on: 'Separate follow-on work',
};
export const CREDIT_STATES = ['unchecked', 'not_required', 'cleared', 'pending', 'refused'] as const;

export interface Opportunity {
  id: number;
  ref: string;
  customer_id: number;
  site_id: number | null;
  title: string;
  source: (typeof OPP_SOURCES)[number];
  originating_job_id: number | null;
  owner_user_id: number | null;
  maturity: (typeof MATURITIES)[number];
  estimate_basis: (typeof ESTIMATE_BASES)[number];
  notes: string | null;
  created_at: string;
  updated_at: string;
  customer_name?: string;
  site_name?: string | null;
  owner_name?: string | null;
  originating_job_ref?: string | null;
}

export interface Revision {
  id: number;
  opportunity_id: number;
  rev_no: number;
  status: 'draft' | 'internally_approved' | 'issued' | 'superseded' | 'accepted' | 'declined' | 'expired';
  scope: string;
  equipment_materials: string | null;
  programme: string | null;
  assumptions: string | null;
  exclusions: string | null;
  warranty_position: string | null;
  customer_responsibilities: string | null;
  payment_terms: string | null;
  acceptance_method: string | null;
  outage_design_notes: string | null;
  vat_rate_bp: number;
  valid_until: string | null;
  change_summary: string | null;
  created_by: number | null;
  created_at: string;
  approved_by: number | null;
  approved_at: string | null;
  approval_reason: string | null;
  issued_by: number | null;
  issued_at: string | null;
  closed_reason: string | null;
  version: number;
  approved_by_name?: string | null;
  issued_by_name?: string | null;
  created_by_name?: string | null;
}

export interface QuoteLine {
  id: number;
  revision_id: number;
  sort: number;
  option_code: string | null;
  line_type: (typeof LINE_TYPES)[number];
  description: string;
  qty: number;
  unit_price_pence: number;
}

export function getOpportunity(db: DB, id: number): Opportunity {
  const o = db
    .prepare(
      `SELECT o.*, c.trading_name AS customer_name, s.name AS site_name, u.display_name AS owner_name, j.ref AS originating_job_ref
       FROM opportunities o JOIN customers c ON c.id = o.customer_id LEFT JOIN sites s ON s.id = o.site_id LEFT JOIN users u ON u.id = o.owner_user_id
       LEFT JOIN jobs j ON j.id = o.originating_job_id WHERE o.id = ?`,
    )
    .get(id) as Opportunity | undefined;
  if (!o) throw new NotFoundError('Opportunity');
  return o;
}

export function getRevision(db: DB, id: number): Revision {
  const r = db
    .prepare(
      `SELECT r.*, a.display_name AS approved_by_name, i.display_name AS issued_by_name, c.display_name AS created_by_name FROM quote_revisions r
       LEFT JOIN users a ON a.id = r.approved_by LEFT JOIN users i ON i.id = r.issued_by LEFT JOIN users c ON c.id = r.created_by WHERE r.id = ?`,
    )
    .get(id) as Revision | undefined;
  if (!r) throw new NotFoundError('Quote revision');
  return r;
}

export function revisionsFor(db: DB, oppId: number): Revision[] {
  return db
    .prepare(
      `SELECT r.*, a.display_name AS approved_by_name, i.display_name AS issued_by_name, c.display_name AS created_by_name FROM quote_revisions r
       LEFT JOIN users a ON a.id = r.approved_by LEFT JOIN users i ON i.id = r.issued_by LEFT JOIN users c ON c.id = r.created_by
       WHERE r.opportunity_id = ? ORDER BY r.rev_no DESC`,
    )
    .all(oppId) as Revision[];
}

export function linesFor(db: DB, revId: number): QuoteLine[] {
  return db.prepare(`SELECT * FROM quote_lines WHERE revision_id = ? ORDER BY option_code IS NOT NULL, option_code, sort, id`).all(revId) as QuoteLine[];
}

export interface Totals {
  baseNet: number;
  options: { code: string; net: number; lines: QuoteLine[] }[];
  maxNet: number;
}

export function totals(lines: QuoteLine[]): Totals {
  const lineNet = (l: QuoteLine) => Math.round(l.qty * l.unit_price_pence);
  const baseNet = lines.filter((l) => !l.option_code).reduce((s, l) => s + lineNet(l), 0);
  const codes = [...new Set(lines.filter((l) => l.option_code).map((l) => l.option_code!))];
  const options = codes.map((code) => {
    const ls = lines.filter((l) => l.option_code === code);
    return { code, net: ls.reduce((s, l) => s + lineNet(l), 0), lines: ls };
  });
  return { baseNet, options, maxNet: baseNet + options.reduce((s, o) => s + o.net, 0) };
}

export function vatOf(net: number, bp: number): number {
  return Math.round((net * bp) / 10000);
}

export function quoteRef(o: { ref: string }, r: { rev_no: number }): string {
  return `${o.ref} rev ${r.rev_no}`;
}

export function listOpportunities(db: DB, opts: { q?: string; maturity?: string; open?: boolean; customerId?: number; limit?: number; offset?: number } = {}) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.q) {
    const like = `%${opts.q}%`;
    where.push('(o.ref LIKE ? OR o.title LIKE ? OR c.trading_name LIKE ?)');
    params.push(like, like, like);
  }
  if (opts.maturity) {
    where.push('o.maturity = ?');
    params.push(opts.maturity);
  } else if (opts.open) where.push(`o.maturity NOT IN ('awarded','lost','withdrawn')`);
  if (opts.customerId) {
    where.push('o.customer_id = ?');
    params.push(opts.customerId);
  }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = (db.prepare(`SELECT COUNT(*) n FROM opportunities o JOIN customers c ON c.id = o.customer_id ${w}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT o.*, c.trading_name AS customer_name, s.name AS site_name, u.display_name AS owner_name,
         (SELECT r.rev_no FROM quote_revisions r WHERE r.opportunity_id = o.id ORDER BY r.rev_no DESC LIMIT 1) AS latest_rev,
         (SELECT r.status FROM quote_revisions r WHERE r.opportunity_id = o.id ORDER BY r.rev_no DESC LIMIT 1) AS latest_status,
         (SELECT r.valid_until FROM quote_revisions r WHERE r.opportunity_id = o.id ORDER BY r.rev_no DESC LIMIT 1) AS latest_valid_until,
         (SELECT r.id FROM quote_revisions r WHERE r.opportunity_id = o.id ORDER BY r.rev_no DESC LIMIT 1) AS latest_rev_id
       FROM opportunities o JOIN customers c ON c.id = o.customer_id LEFT JOIN sites s ON s.id = o.site_id LEFT JOIN users u ON u.id = o.owner_user_id
       ${w} ORDER BY o.updated_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, opts.limit ?? 50, opts.offset ?? 0) as (Opportunity & { latest_rev: number; latest_status: string; latest_valid_until: string | null; latest_rev_id: number })[];
  const lineStmt = db.prepare('SELECT * FROM quote_lines WHERE revision_id = ?');
  return {
    total,
    rows: rows.map((r) => ({ ...r, latest_total: r.latest_rev_id ? totals(lineStmt.all(r.latest_rev_id) as QuoteLine[]) : null })),
  };
}

// ------------------------------------------------------------------ opportunity & revisions (US-050)

export function createOpportunity(db: DB, actor: Actor, body: Record<string, unknown>): number {
  requireCap(actor, 'quote.write');
  const f = new Form(body);
  const customerId = f.reqInt('customer_id', 'Customer');
  const siteId = f.int('site_id', 'Site');
  const data = {
    title: f.str('title', 'Title', 200),
    source: f.oneOf('source', 'Source', OPP_SOURCES),
    originating_job_id: f.int('originating_job_id', 'Originating job'),
    owner_user_id: f.int('owner_user_id', 'Owner') ?? actor.id,
    maturity: f.oneOf('maturity', 'Maturity', MATURITIES, false) || 'enquiry',
    estimate_basis: f.oneOf('estimate_basis', 'Estimate basis', ESTIMATE_BASES, false) || 'budget_indication',
    notes: f.opt('notes'),
  };
  f.done();
  return tx(db, () => {
    if (siteId && getSite(db, siteId).customer_id !== customerId) throw new DomainError('Site does not belong to the customer.');
    const ref = nextRef(db, 'Q', 3000);
    const now = clock.iso();
    const r = db
      .prepare(
        `INSERT INTO opportunities (ref, customer_id, site_id, title, source, originating_job_id, owner_user_id, maturity, estimate_basis, notes, created_by, created_at, updated_at)
         VALUES (@ref, @customer_id, @site_id, @title, @source, @originating_job_id, @owner_user_id, @maturity, @estimate_basis, @notes, @actor, @now, @now)`,
      )
      .run({ ...data, ref, customer_id: customerId, site_id: siteId, actor: actor.id, now });
    const id = Number(r.lastInsertRowid);
    db.prepare(`INSERT INTO quote_revisions (opportunity_id, rev_no, status, scope, payment_terms, acceptance_method, created_by, created_at) VALUES (?, 1, 'draft', '', ?, ?, ?, ?)`).run(
      id,
      settingValue(db, 'default_payment_terms'),
      settingValue(db, 'default_acceptance_method'),
      actor.id,
      now,
    );
    audit(db, actor, 'opportunity', id, 'created', { after: { ref, ...data } });
    return id;
  });
}

function settingValue(db: DB, key: string): string | null {
  return (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
}

export function updateOpportunity(db: DB, actor: Actor, id: number, body: Record<string, unknown>) {
  requireCap(actor, 'quote.write');
  const f = new Form(body);
  const data = {
    title: f.str('title', 'Title', 200),
    maturity: f.oneOf('maturity', 'Maturity', MATURITIES),
    estimate_basis: f.oneOf('estimate_basis', 'Estimate basis', ESTIMATE_BASES),
    owner_user_id: f.int('owner_user_id', 'Owner'),
    notes: f.opt('notes'),
  };
  const reason = f.opt('reason', 1000);
  f.done();
  tx(db, () => {
    const o = getOpportunity(db, id);
    if (data.maturity === 'awarded' && o.maturity !== 'awarded') throw new DomainError('An opportunity becomes awarded only by recording a validated acceptance.');
    db.prepare(`UPDATE opportunities SET title = @title, maturity = @maturity, estimate_basis = @estimate_basis, owner_user_id = @owner_user_id, notes = @notes, updated_at = @now WHERE id = @id`).run({
      ...data,
      now: clock.iso(),
      id,
    });
    audit(db, actor, 'opportunity', id, 'updated', {
      reason,
      before: { maturity: o.maturity, estimate_basis: o.estimate_basis, owner: o.owner_user_id },
      after: { maturity: data.maturity, estimate_basis: data.estimate_basis, owner: data.owner_user_id },
    });
  });
}

const REV_FIELDS = [
  'scope', 'equipment_materials', 'programme', 'assumptions', 'exclusions', 'warranty_position', 'customer_responsibilities',
  'payment_terms', 'acceptance_method', 'outage_design_notes',
] as const;

export function updateDraft(db: DB, actor: Actor, revId: number, body: Record<string, unknown>) {
  requireCap(actor, 'quote.write');
  const f = new Form(body);
  const data: Record<string, unknown> = {};
  for (const k of REV_FIELDS) data[k] = k === 'scope' ? f.str('scope', 'Scope', 20000) : f.opt(k, 20000);
  data.vat_rate_bp = Math.round((f.num('vat_rate', 'VAT rate %', true) ?? 20) * 100);
  data.valid_until = f.date('valid_until', 'Valid until', false);
  const version = f.int('version', 'Version');
  f.check((data.vat_rate_bp as number) >= 0 && (data.vat_rate_bp as number) <= 10000, 'vat_rate', 'VAT rate must be between 0 and 100%.');
  f.done();
  tx(db, () => {
    const r = getRevision(db, revId);
    if (r.status !== 'draft') throw new DomainError(`Revision ${r.rev_no} is ${r.status} and cannot be edited. Create a new revision.`);
    if (version !== null && version !== r.version) throw new ConflictError('This draft was changed by someone else. Reload before saving.');
    const cols = Object.keys(data);
    db.prepare(`UPDATE quote_revisions SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, version = version + 1 WHERE id = @id`).run({ ...data, id: revId });
    db.prepare(`UPDATE opportunities SET updated_at = ? WHERE id = ?`).run(clock.iso(), r.opportunity_id);
    audit(db, actor, 'quote_revision', revId, 'draft_updated');
  });
}

export function addLine(db: DB, actor: Actor, revId: number, body: Record<string, unknown>) {
  requireCap(actor, 'quote.write');
  const f = new Form(body);
  const line = {
    option_code: f.opt('option_code', 40),
    line_type: f.oneOf('line_type', 'Line type', LINE_TYPES),
    description: f.str('description', 'Description', 1000),
    qty: f.num('qty', 'Quantity', true) ?? 1,
    unit_price_pence: f.pence('unit_price', 'Unit price', true) ?? 0,
  };
  f.check(line.qty > 0, 'qty', 'Quantity must be greater than zero.');
  f.check(line.unit_price_pence >= 0, 'unit_price', 'Unit price cannot be negative.');
  f.done();
  tx(db, () => {
    const r = getRevision(db, revId);
    if (r.status !== 'draft') throw new DomainError('Lines can only be changed on a draft revision.');
    const sort = (db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM quote_lines WHERE revision_id = ?').get(revId) as { s: number }).s;
    db.prepare(`INSERT INTO quote_lines (revision_id, sort, option_code, line_type, description, qty, unit_price_pence) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      revId,
      sort,
      line.option_code ? line.option_code.toUpperCase() : null,
      line.line_type,
      line.description,
      line.qty,
      line.unit_price_pence,
    );
    audit(db, actor, 'quote_revision', revId, 'line_added', { after: line });
  });
}

export function removeLine(db: DB, actor: Actor, lineId: number) {
  requireCap(actor, 'quote.write');
  tx(db, () => {
    const l = db.prepare('SELECT * FROM quote_lines WHERE id = ?').get(lineId) as QuoteLine | undefined;
    if (!l) throw new NotFoundError('Line');
    db.prepare('DELETE FROM quote_lines WHERE id = ?').run(lineId); // trigger blocks non-draft
    audit(db, actor, 'quote_revision', l.revision_id, 'line_removed', { before: l });
  });
}

/** Internal approval per configurable policy (FR-022). Approval ≠ issue ≠ purchase/start authority (RULE-007). */
export function approveRevision(db: DB, actor: Actor, revId: number, body: Record<string, unknown>) {
  const f = new Form(body);
  const reason = f.str('reason', 'Approval note', 2000);
  f.done();
  tx(db, () => {
    const r = getRevision(db, revId);
    if (r.status !== 'draft') throw new DomainError(`Revision is ${r.status}; only drafts can be approved.`);
    const lines = linesFor(db, revId);
    if (!r.scope.trim()) throw new DomainError('Scope is required before approval.');
    if (!lines.length) throw new DomainError('Add at least one priced line before approval.');
    if (!r.valid_until) throw new DomainError('Set a validity date before approval.');
    if (!r.assumptions || !r.exclusions) throw new DomainError('Record assumptions and exclusions before approval (use "None" if genuinely none).');
    const t = totals(lines);
    const decision = requireApproval(db, actor, 'quote.approve', t.maxNet);
    db.prepare(`UPDATE quote_revisions SET status = 'internally_approved', approved_by = ?, approved_at = ?, approval_reason = ?, version = version + 1 WHERE id = ?`).run(
      actor.id,
      clock.iso(),
      reason,
      revId,
    );
    audit(db, actor, 'quote_revision', revId, 'internally_approved', { reason, after: { max_net_pence: t.maxNet, policy: decision.message } });
  });
}

export function issueRevision(db: DB, actor: Actor, revId: number, body: Record<string, unknown>) {
  requireCap(actor, 'quote.issue');
  const f = new Form(body);
  const note = f.str('note', 'Issued to / how', 1000);
  f.done();
  tx(db, () => {
    const r = getRevision(db, revId);
    if (r.status !== 'internally_approved') throw new DomainError('Only an internally approved revision can be issued.');
    const now = clock.iso();
    const older = db.prepare(`SELECT id FROM quote_revisions WHERE opportunity_id = ? AND id <> ? AND status IN ('issued','internally_approved','draft')`).all(r.opportunity_id, revId) as { id: number }[];
    for (const o of older) db.prepare(`UPDATE quote_revisions SET status = 'superseded', closed_reason = ?, version = version + 1 WHERE id = ?`).run(`Superseded by rev ${r.rev_no}`, o.id);
    db.prepare(`UPDATE quote_revisions SET status = 'issued', issued_by = ?, issued_at = ?, version = version + 1 WHERE id = ?`).run(actor.id, now, revId);
    db.prepare(`UPDATE opportunities SET maturity = 'quoted', updated_at = ? WHERE id = ? AND maturity NOT IN ('awarded')`).run(now, r.opportunity_id);
    audit(db, actor, 'quote_revision', revId, 'issued', { reason: note, after: { superseded: older.map((o) => o.id) } });
  });
}

/** Revisions are immutable; a change creates rev n+1 as a draft copy (AC-050-02). */
export function newRevision(db: DB, actor: Actor, oppId: number, body: Record<string, unknown>): number {
  requireCap(actor, 'quote.write');
  const f = new Form(body);
  const summary = f.str('change_summary', 'What changes in this revision', 2000);
  f.done();
  return tx(db, () => {
    const o = getOpportunity(db, oppId);
    const accepted = db.prepare(`SELECT 1 FROM quote_revisions WHERE opportunity_id = ? AND status = 'accepted'`).get(oppId);
    if (accepted) throw new DomainError('This quotation has an accepted revision. Post-award changes are recorded as variations, not revisions.');
    const draft = db.prepare(`SELECT id FROM quote_revisions WHERE opportunity_id = ? AND status = 'draft'`).get(oppId);
    if (draft) throw new DomainError('A draft revision already exists.');
    const latest = db.prepare(`SELECT * FROM quote_revisions WHERE opportunity_id = ? ORDER BY rev_no DESC LIMIT 1`).get(oppId) as Revision;
    const now = clock.iso();
    const cols = [...REV_FIELDS, 'vat_rate_bp', 'valid_until'] as const;
    const r = db
      .prepare(
        `INSERT INTO quote_revisions (opportunity_id, rev_no, status, ${cols.join(', ')}, change_summary, created_by, created_at)
         SELECT opportunity_id, rev_no + 1, 'draft', ${cols.join(', ')}, ?, ?, ? FROM quote_revisions WHERE id = ?`,
      )
      .run(summary, actor.id, now, latest.id);
    const newId = Number(r.lastInsertRowid);
    db.prepare(
      `INSERT INTO quote_lines (revision_id, sort, option_code, line_type, description, qty, unit_price_pence)
       SELECT ?, sort, option_code, line_type, description, qty, unit_price_pence FROM quote_lines WHERE revision_id = ?`,
    ).run(newId, latest.id);
    db.prepare(`UPDATE opportunities SET updated_at = ? WHERE id = ?`).run(now, oppId);
    audit(db, actor, 'opportunity', oppId, 'revision_created', { reason: summary, after: { from_rev: latest.rev_no, rev_no: latest.rev_no + 1 } });
    void o;
    return newId;
  });
}

export function closeRevision(db: DB, actor: Actor, revId: number, body: Record<string, unknown>) {
  requireCap(actor, 'quote.write');
  const f = new Form(body);
  const to = f.oneOf('status', 'Outcome', ['declined', 'expired'] as const);
  const reason = f.str('reason', 'Reason', 2000);
  f.done();
  tx(db, () => {
    const r = getRevision(db, revId);
    if (r.status !== 'issued') throw new DomainError('Only an issued revision can be declined or expired.');
    db.prepare(`UPDATE quote_revisions SET status = ?, closed_reason = ?, version = version + 1 WHERE id = ?`).run(to, reason, revId);
    audit(db, actor, 'quote_revision', revId, to, { reason });
  });
}

// ------------------------------------------------------------------ acceptance & release (US-051)

export interface Acceptance {
  id: number;
  revision_id: number;
  accepted_options: string;
  accepted_net_pence: number;
  accepted_vat_pence: number;
  accepting_party: string;
  accepting_contact_id: number | null;
  acceptance_received_at: string;
  acceptance_evidence: string;
  chk_authority: number;
  chk_authority_note: string | null;
  chk_revision_options: number;
  chk_po_value: number;
  po_number: string | null;
  po_value_pence: number | null;
  chk_terms: number;
  chk_terms_note: string | null;
  chk_dates: number;
  proposed_start: string | null;
  chk_validity_pricing: number;
  chk_validity_note: string | null;
  credit_deposit: (typeof CREDIT_STATES)[number];
  credit_note: string | null;
  recorded_by: number;
  recorded_at: string;
  released: number;
  released_by: number | null;
  released_at: string | null;
  release_reason: string | null;
  release_target: 'job' | 'project' | null;
  job_id: number | null;
  project_id: number | null;
  version: number;
  recorded_by_name?: string;
  released_by_name?: string | null;
  job_ref?: string | null;
  project_ref?: string | null;
}

export function acceptanceForRevision(db: DB, revId: number): Acceptance | null {
  return (
    (db
      .prepare(
        `SELECT a.*, r.display_name AS recorded_by_name, l.display_name AS released_by_name, j.ref AS job_ref, p.ref AS project_ref FROM acceptances a
         JOIN users r ON r.id = a.recorded_by LEFT JOIN users l ON l.id = a.released_by LEFT JOIN jobs j ON j.id = a.job_id LEFT JOIN projects p ON p.id = a.project_id
         WHERE a.revision_id = ?`,
      )
      .get(revId) as Acceptance | undefined) ?? null
  );
}

export function getAcceptance(db: DB, id: number): Acceptance {
  const a = db.prepare('SELECT * FROM acceptances WHERE id = ?').get(id) as Acceptance | undefined;
  if (!a) throw new NotFoundError('Acceptance');
  return a;
}

function readChecklist(f: Form) {
  return {
    chk_authority: f.bool('chk_authority') ? 1 : 0,
    chk_authority_note: f.opt('chk_authority_note', 1000),
    chk_revision_options: f.bool('chk_revision_options') ? 1 : 0,
    chk_po_value: f.bool('chk_po_value') ? 1 : 0,
    po_number: f.opt('po_number', 100),
    po_value_pence: f.pence('po_value', 'PO value'),
    chk_terms: f.bool('chk_terms') ? 1 : 0,
    chk_terms_note: f.opt('chk_terms_note', 1000),
    chk_dates: f.bool('chk_dates') ? 1 : 0,
    proposed_start: f.date('proposed_start', 'Proposed start', false),
    chk_validity_pricing: f.bool('chk_validity_pricing') ? 1 : 0,
    chk_validity_note: f.opt('chk_validity_note', 1000),
    credit_deposit: f.oneOf('credit_deposit', 'Credit / deposit', CREDIT_STATES),
    credit_note: f.opt('credit_note', 1000),
  };
}

/**
 * Records a customer "yes" against an exact issued revision and chosen options (AC-051-01).
 * Recording acceptance is not release: the validation checklist gates release separately.
 */
export function recordAcceptance(db: DB, actor: Actor, revId: number, body: Record<string, unknown>): number {
  requireCap(actor, 'quote.accept.record');
  const f = new Form(body);
  const options = f.list('options').map((s) => s.toUpperCase());
  const party = f.str('accepting_party', 'Accepting party (name, role, organisation)', 300);
  const contactId = f.int('accepting_contact_id', 'Contact');
  const receivedAt = f.dt('acceptance_received_at', 'Acceptance received', false) ?? clock.iso();
  const evidence = f.str('acceptance_evidence', 'Acceptance evidence (e.g. signed form, email ref)', 2000);
  const confirmRev = f.str('confirm_revision', 'Revision confirmation', 20);
  const chk = readChecklist(f);
  f.done();
  return tx(db, () => {
    const r = getRevision(db, revId);
    const o = getOpportunity(db, r.opportunity_id);
    if (confirmRev !== String(r.rev_no)) throw new DomainError(`Type the revision number (${r.rev_no}) to confirm exactly what the customer accepted.`, { confirm_revision: 'Does not match.' });
    if (r.status !== 'issued') throw new DomainError(`Rev ${r.rev_no} is ${r.status}; acceptance must reference the current issued revision.`);
    if (contactId) {
      const ct = db.prepare('SELECT customer_id FROM contacts WHERE id = ?').get(contactId) as { customer_id: number } | undefined;
      if (!ct || ct.customer_id !== o.customer_id) throw new DomainError('Contact does not belong to the customer.');
    }
    const t = totals(linesFor(db, revId));
    const unknown = options.filter((c) => !t.options.some((x) => x.code === c));
    if (unknown.length) throw new DomainError(`Unknown option(s): ${unknown.join(', ')}`);
    const net = t.baseNet + t.options.filter((x) => options.includes(x.code)).reduce((s, x) => s + x.net, 0);
    const now = clock.iso();
    const res = db
      .prepare(
        `INSERT INTO acceptances (revision_id, accepted_options, accepted_net_pence, accepted_vat_pence, accepting_party, accepting_contact_id, acceptance_received_at,
           acceptance_evidence, chk_authority, chk_authority_note, chk_revision_options, chk_po_value, po_number, po_value_pence, chk_terms, chk_terms_note, chk_dates,
           proposed_start, chk_validity_pricing, chk_validity_note, credit_deposit, credit_note, recorded_by, recorded_at)
         VALUES (@revision_id, @accepted_options, @net, @vat, @party, @contact, @received, @evidence, @chk_authority, @chk_authority_note, @chk_revision_options,
           @chk_po_value, @po_number, @po_value_pence, @chk_terms, @chk_terms_note, @chk_dates, @proposed_start, @chk_validity_pricing, @chk_validity_note,
           @credit_deposit, @credit_note, @actor, @now)`,
      )
      .run({
        ...chk,
        revision_id: revId,
        accepted_options: options.join(','),
        net,
        vat: vatOf(net, r.vat_rate_bp),
        party,
        contact: contactId,
        received: receivedAt,
        evidence,
        actor: actor.id,
        now,
      });
    db.prepare(`UPDATE quote_revisions SET status = 'accepted', version = version + 1 WHERE id = ?`).run(revId);
    db.prepare(`UPDATE opportunities SET maturity = 'awarded', estimate_basis = 'approved_quotation_basis', updated_at = ? WHERE id = ?`).run(now, o.id);
    const id = Number(res.lastInsertRowid);
    audit(db, actor, 'quote_revision', revId, 'acceptance_recorded', { reason: evidence, after: { acceptance_id: id, options, accepted_net_pence: net, party } });
    return id;
  });
}

export function updateChecklist(db: DB, actor: Actor, accId: number, body: Record<string, unknown>) {
  requireCap(actor, 'quote.accept.record');
  const f = new Form(body);
  const chk = readChecklist(f);
  const version = f.int('version', 'Version');
  f.done();
  tx(db, () => {
    const a = getAcceptance(db, accId);
    if (a.released) throw new DomainError('Work has been released; the acceptance record is locked.');
    if (version !== null && version !== a.version) throw new ConflictError('Checklist changed by someone else. Reload.');
    const cols = Object.keys(chk);
    db.prepare(`UPDATE acceptances SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, version = version + 1 WHERE id = @id`).run({ ...chk, id: accId });
    audit(db, actor, 'acceptance', accId, 'checklist_updated', {
      before: Object.fromEntries(cols.map((c) => [c, (a as unknown as Record<string, unknown>)[c]])),
      after: chk,
    });
  });
}

export function releaseBlockers(db: DB, a: Acceptance): string[] {
  const out: string[] = [];
  if (!a.chk_authority) out.push('Accepting party / authority not verified');
  if (!a.chk_revision_options) out.push('Exact revision and options not confirmed');
  if (!a.chk_po_value) out.push('PO / order value not checked');
  if (!a.chk_terms) out.push('Customer terms not reviewed');
  if (!a.chk_dates) out.push('Achievable dates not confirmed');
  if (!a.chk_validity_pricing) out.push('Validity / supplier pricing not re-checked');
  if (a.credit_deposit !== 'not_required' && a.credit_deposit !== 'cleared') out.push(`Credit / deposit is "${a.credit_deposit.replace('_', ' ')}"`);
  const rev = db.prepare('SELECT valid_until FROM quote_revisions WHERE id = ?').get(a.revision_id) as { valid_until: string | null };
  if (rev.valid_until && a.acceptance_received_at.slice(0, 10) > rev.valid_until && !a.chk_validity_note) {
    out.push(`Accepted after validity (${rev.valid_until}); record the re-validation note`);
  }
  if (a.po_value_pence !== null && a.po_value_pence < a.accepted_net_pence && a.chk_po_value && !a.chk_authority_note) {
    out.push('PO value is below the accepted value; record how the difference is authorised in the authority note');
  }
  return out;
}

/**
 * Commercial release: the only path from an accepted quote to purchasable/startable work
 * (DISC-D006). Gated by the checklist and the configurable release policy.
 */
export function releaseWork(db: DB, actor: Actor, accId: number, body: Record<string, unknown>): { jobId?: number; projectId?: number } {
  const f = new Form(body);
  const target = f.oneOf('target', 'Release as', ['job', 'project'] as const);
  const reason = f.str('reason', 'Release note', 2000);
  const coordinator = f.int('owner_user_id', 'Owner');
  f.done();
  return tx(db, () => {
    const a = getAcceptance(db, accId);
    if (a.released) throw new DomainError('Already released.');
    const blockers = releaseBlockers(db, a);
    if (blockers.length) throw new DomainError(`Release blocked: ${blockers.join('; ')}.`);
    const decision = requireApproval(db, actor, 'quote.release', a.accepted_net_pence);
    const r = getRevision(db, a.revision_id);
    const o = getOpportunity(db, r.opportunity_id);
    if (!o.site_id) throw new DomainError('Set the site on the opportunity before releasing work.');
    const now = clock.iso();
    const qref = quoteRef(o, r);
    let jobId: number | undefined;
    let projectId: number | undefined;
    if (target === 'project') {
      const pref = nextRef(db, 'P', 500);
      const p = db
        .prepare(`INSERT INTO projects (ref, customer_id, site_id, title, outcome, manager_user_id, acceptance_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'planning', ?, ?)`)
        .run(pref, o.customer_id, o.site_id, o.title, r.scope.slice(0, 2000), coordinator, accId, now, now);
      projectId = Number(p.lastInsertRowid);
      audit(db, actor, 'project', projectId, 'created_from_release', { reason, after: { ref: pref, quote: qref } });
    } else {
      const jref = nextRef(db, 'J', 10000);
      const j = db
        .prepare(
          `INSERT INTO jobs (ref, kind, customer_id, site_id, acceptance_id, parent_job_id, title, reported_symptom, channel, received_at, priority, priority_reason,
             authority_basis, authority_ref, authority_notes, customer_po, ready_authority, ready_scope, op_status, next_action, next_owner_user_id, review_at, coordinator_user_id, created_by, created_at, updated_at)
           VALUES (?, 'quoted_works', ?, ?, ?, ?, ?, NULL, 'quote', ?, 'P4', 'Planned delivery of accepted quotation', 'accepted_quote', ?, ?, ?, 1, 1, 'authorised',
             'Confirm readiness (access, parts, engineer) and schedule', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          jref,
          o.customer_id,
          o.site_id,
          accId,
          o.originating_job_id,
          o.title,
          now,
          qref,
          `Released ${fmtOptions(a.accepted_options)}; ${reason}`,
          a.po_number,
          coordinator ?? actor.id,
          new Date(clock.now().getTime() + 2 * 86400000).toISOString(),
          coordinator,
          actor.id,
          now,
          now,
        );
      jobId = Number(j.lastInsertRowid);
      db.prepare('INSERT INTO priority_changes (job_id, from_priority, to_priority, reason, decided_by, decided_at) VALUES (?, NULL, ?, ?, ?, ?)').run(jobId, 'P4', 'Released quoted works', actor.id, now);
      db.prepare(`INSERT INTO sla_events (job_id, type, occurred_at, recorded_at, recorded_by, source, note) VALUES (?, 'received', ?, ?, ?, 'system', ?)`).run(jobId, now, now, actor.id, `Released from ${qref}`);
      audit(db, actor, 'job', jobId, 'created_from_release', { reason, after: { ref: jref, quote: qref, accepted_net_pence: a.accepted_net_pence } });
      if (coordinator && coordinator !== actor.id) notify(db, coordinator, 'release', `${jref} released from ${qref} — confirm readiness and schedule`, `/jobs/${jobId}`);
    }
    db.prepare(`UPDATE acceptances SET released = 1, released_by = ?, released_at = ?, release_reason = ?, release_target = ?, job_id = ?, project_id = ?, version = version + 1 WHERE id = ?`).run(
      actor.id,
      now,
      reason,
      target,
      jobId ?? null,
      projectId ?? null,
      accId,
    );
    audit(db, actor, 'acceptance', accId, 'released', { reason, after: { target, job_id: jobId ?? null, project_id: projectId ?? null, policy: decision.message } });
    return { jobId, projectId };
  });
}

function fmtOptions(s: string) {
  return s ? `with options ${s}` : 'base scope only';
}

// ------------------------------------------------------------------ variations (US-052)

export function createVariation(db: DB, actor: Actor, body: Record<string, unknown>): number {
  requireCap(actor, 'variation.create');
  const f = new Form(body);
  const data = {
    acceptance_id: f.int('acceptance_id', 'Acceptance'),
    job_id: f.int('job_id', 'Job'),
    project_id: f.int('project_id', 'Project'),
    classification: f.oneOf('classification', 'Classification', VARIATION_CLASSES),
    description: f.str('description', 'Description', 4000),
    scope_impact: f.str('scope_impact', 'Scope impact', 4000),
    value_impact_pence: f.pence('value_impact', 'Value impact') ?? 0,
    customer_ref: f.opt('customer_ref', 200),
  };
  f.check(data.acceptance_id || data.job_id || data.project_id, 'job_id', 'A variation must relate to accepted work, a job or a project.');
  f.done();
  return tx(db, () => {
    if (data.job_id && !db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(data.job_id)) throw new NotFoundError('Job');
    if (data.project_id && !db.prepare('SELECT 1 FROM projects WHERE id = ?').get(data.project_id)) throw new NotFoundError('Project');
    const ref = nextRef(db, 'V', 100);
    const r = db
      .prepare(
        `INSERT INTO variations (ref, acceptance_id, job_id, project_id, classification, description, scope_impact, value_impact_pence, customer_ref, created_by, created_at)
         VALUES (@ref, @acceptance_id, @job_id, @project_id, @classification, @description, @scope_impact, @value_impact_pence, @customer_ref, @actor, @now)`,
      )
      .run({ ...data, ref, actor: actor.id, now: clock.iso() });
    const id = Number(r.lastInsertRowid);
    audit(db, actor, 'variation', id, 'proposed', { after: { ref, ...data } });
    if (data.job_id) {
      db.prepare(`UPDATE jobs SET commercial_status = CASE WHEN commercial_status = 'clear' THEN 'approval_required' ELSE commercial_status END, version = version + 1 WHERE id = ?`).run(data.job_id);
      audit(db, actor, 'job', data.job_id, 'variation_proposed', { after: { variation: ref, classification: data.classification } });
    }
    return id;
  });
}

export function decideVariation(db: DB, actor: Actor, id: number, body: Record<string, unknown>) {
  const f = new Form(body);
  const decision = f.oneOf('decision', 'Decision', ['approved', 'rejected', 'withdrawn'] as const);
  const reason = f.str('reason', 'Reason', 2000);
  f.done();
  tx(db, () => {
    const v = db.prepare('SELECT * FROM variations WHERE id = ?').get(id) as { id: number; ref: string; status: string; value_impact_pence: number; job_id: number | null } | undefined;
    if (!v) throw new NotFoundError('Variation');
    if (v.status !== 'proposed') throw new DomainError(`Variation is already ${v.status}.`);
    let policy: string | null = null;
    if (decision === 'approved') policy = requireApproval(db, actor, 'variation.approve', Math.abs(v.value_impact_pence)).message;
    else requireCap(actor, 'variation.create');
    db.prepare(`UPDATE variations SET status = ?, decided_by = ?, decided_at = ?, decision_reason = ? WHERE id = ?`).run(decision, actor.id, clock.iso(), reason, id);
    audit(db, actor, 'variation', id, decision, { reason, after: { policy } });
    if (v.job_id) {
      const open = db.prepare(`SELECT COUNT(*) n FROM variations WHERE job_id = ? AND status = 'proposed'`).get(v.job_id) as { n: number };
      if (!open.n) db.prepare(`UPDATE jobs SET commercial_status = CASE WHEN commercial_status = 'approval_required' THEN 'clear' ELSE commercial_status END, version = version + 1 WHERE id = ?`).run(v.job_id);
      audit(db, actor, 'job', v.job_id, `variation_${decision}`, { reason, after: { variation: v.ref } });
    }
  });
}

export function variationsFor(db: DB, where: { jobId?: number; acceptanceId?: number; projectId?: number; open?: boolean }) {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (where.jobId) {
    conds.push('v.job_id = ?');
    params.push(where.jobId);
  }
  if (where.acceptanceId) {
    conds.push('v.acceptance_id = ?');
    params.push(where.acceptanceId);
  }
  if (where.projectId) {
    conds.push('v.project_id = ?');
    params.push(where.projectId);
  }
  if (where.open) conds.push(`v.status = 'proposed'`);
  return db
    .prepare(
      `SELECT v.*, c.display_name AS created_by_name, d.display_name AS decided_by_name, j.ref AS job_ref, p.ref AS project_ref FROM variations v
       JOIN users c ON c.id = v.created_by LEFT JOIN users d ON d.id = v.decided_by LEFT JOIN jobs j ON j.id = v.job_id LEFT JOIN projects p ON p.id = v.project_id
       ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''} ORDER BY v.created_at DESC`,
    )
    .all(...params) as {
    id: number;
    ref: string;
    classification: (typeof VARIATION_CLASSES)[number];
    description: string;
    scope_impact: string;
    value_impact_pence: number;
    customer_ref: string | null;
    status: string;
    created_by_name: string;
    decided_by_name: string | null;
    decided_at: string | null;
    decision_reason: string | null;
    created_at: string;
    job_ref: string | null;
    job_id: number | null;
    project_ref: string | null;
  }[];
}

export function approvalPreview(db: DB, actor: Actor, action: 'quote.approve' | 'quote.release' | 'variation.approve', value: number) {
  return checkApproval(db, actor, action, value);
}
