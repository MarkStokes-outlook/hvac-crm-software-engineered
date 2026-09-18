import type { DB } from '../db/db.ts';
import { tx } from '../db/db.ts';
import { type Actor, requireCap } from '../auth/policy.ts';
import { audit, notify } from './audit.ts';
import { clock, DAY, MIN } from '../lib/clock.ts';
import { ConflictError, DomainError, ForbiddenError, NotFoundError } from '../lib/errors.ts';
import { Form } from '../lib/form.ts';
import { nextRef } from '../lib/refs.ts';
import { contractForSite, getSite } from './crm.ts';
import { recordSlaEvent } from './sla.ts';

export const PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_LABEL: Record<Priority, string> = { P1: 'P1 Critical', P2: 'P2 High', P3: 'P3 Normal', P4: 'P4 Planned' };

export const JOB_KINDS = ['reactive', 'planned', 'quoted_works', 'project_task', 'warranty', 'follow_on'] as const;
export const JOB_KIND_LABEL: Record<(typeof JOB_KINDS)[number], string> = {
  reactive: 'Reactive',
  planned: 'Planned maintenance',
  quoted_works: 'Quoted works',
  project_task: 'Project task',
  warranty: 'Warranty investigation',
  follow_on: 'Follow-on',
};
export const CHANNELS = ['phone', 'email', 'engineer', 'portal_other', 'planned', 'quote'] as const;

export const OP_STATUSES = ['new', 'triaged', 'authorised', 'ready', 'scheduled', 'dispatched', 'in_progress', 'waiting', 'operationally_complete', 'cancelled'] as const;
export type OpStatus = (typeof OP_STATUSES)[number];
export const OPEN_STATUSES: OpStatus[] = ['new', 'triaged', 'authorised', 'ready', 'scheduled', 'dispatched', 'in_progress', 'waiting'];
export const FINANCIAL_STATUSES = ['not_ready', 'ready_to_invoice', 'invoiced', 'financially_closed'] as const;
export const COMMERCIAL_STATUSES = ['clear', 'approval_required', 'warranty_or_liability_pending', 'disputed', 'resolved'] as const;

/** Authority basis for work (Q016). Site presence is not unlimited authority. */
export const AUTHORITY_BASES = [
  'not_established',
  'diagnosis_only',
  'planned_maintenance',
  'accepted_quote',
  'contract_minor_repair',
  'delegated_spend',
  'project_task',
  'warranty_investigation',
  'emergency_make_safe',
] as const;
export const AUTHORITY_LABEL: Record<(typeof AUTHORITY_BASES)[number], string> = {
  not_established: 'Not yet established',
  diagnosis_only: 'Diagnosis only',
  planned_maintenance: 'Planned maintenance',
  accepted_quote: 'Accepted quotation',
  contract_minor_repair: 'Contract-covered minor repair',
  delegated_spend: 'Delegated spend',
  project_task: 'Project task',
  warranty_investigation: 'Warranty investigation / remediation',
  emergency_make_safe: 'Emergency make-safe',
};

/** Waiting dependencies (Q013). Generic "on hold" is deliberately absent (RULE-005). */
export const WAITING_CATEGORIES = [
  'customer_approval',
  'customer_information',
  'part_availability',
  'manufacturer_decision',
  'technical_review',
  'access',
  'subcontract_acceptance',
  'office_review',
  'specialist_required',
] as const;
export const WAITING_LABEL: Record<(typeof WAITING_CATEGORIES)[number], string> = {
  customer_approval: 'Customer approval',
  customer_information: 'Customer information / authority',
  part_availability: 'Part availability',
  manufacturer_decision: 'Manufacturer decision',
  technical_review: 'Technical review',
  access: 'Access / permit',
  subcontract_acceptance: 'Subcontract acceptance',
  office_review: 'Office review of attendance',
  specialist_required: 'Specialist required',
};

export const READINESS_KEYS = ['ready_scope', 'ready_authority', 'ready_access', 'ready_competence', 'ready_parts', 'ready_dependencies'] as const;
export const READINESS_LABEL: Record<(typeof READINESS_KEYS)[number], string> = {
  ready_scope: 'Scope sufficiently defined',
  ready_authority: 'Authority to proceed confirmed',
  ready_access: 'Access / permits arranged',
  ready_competence: 'Competent engineer available',
  ready_parts: 'Parts / tools / resources available',
  ready_dependencies: 'Other dependencies cleared',
};

export interface Job {
  id: number;
  ref: string;
  kind: (typeof JOB_KINDS)[number];
  customer_id: number;
  site_id: number;
  contract_id: number | null;
  project_id: number | null;
  acceptance_id: number | null;
  parent_job_id: number | null;
  title: string;
  reported_symptom: string | null;
  reported_by_name: string | null;
  reported_by_contact_id: number | null;
  channel: string | null;
  received_at: string;
  impact: string | null;
  safety_risk: string | null;
  safety_flag: number;
  priority: Priority;
  priority_reason: string;
  triage_notes: string | null;
  authority_basis: (typeof AUTHORITY_BASES)[number];
  authority_ref: string | null;
  authority_notes: string | null;
  customer_po: string | null;
  ready_scope: number;
  ready_authority: number;
  ready_access: number;
  ready_competence: number;
  ready_parts: number;
  ready_dependencies: number;
  emergency_proceed: number;
  emergency_reason: string | null;
  required_competences: string | null;
  estimated_minutes: number | null;
  expected_resources: string | null;
  op_status: OpStatus;
  financial_status: (typeof FINANCIAL_STATUSES)[number];
  commercial_status: (typeof COMMERCIAL_STATUSES)[number];
  waiting_category: (typeof WAITING_CATEGORIES)[number] | null;
  waiting_detail: string | null;
  waiting_since: string | null;
  next_action: string | null;
  next_owner_user_id: number | null;
  review_at: string | null;
  coordinator_user_id: number | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  version: number;
  // joined
  customer_name?: string;
  site_name?: string;
  site_postcode?: string;
  site_area?: string;
  contract_ref?: string | null;
  contract_name?: string | null;
  next_owner_name?: string | null;
  coordinator_name?: string | null;
}

const JOB_SELECT = `SELECT j.*, c.trading_name AS customer_name, s.name AS site_name, s.postcode AS site_postcode, s.area AS site_area,
  k.ref AS contract_ref, k.name AS contract_name, nu.display_name AS next_owner_name, cu.display_name AS coordinator_name
  FROM jobs j JOIN customers c ON c.id = j.customer_id JOIN sites s ON s.id = j.site_id
  LEFT JOIN contracts k ON k.id = j.contract_id LEFT JOIN users nu ON nu.id = j.next_owner_user_id LEFT JOIN users cu ON cu.id = j.coordinator_user_id`;

export function getJob(db: DB, id: number): Job {
  const j = db.prepare(`${JOB_SELECT} WHERE j.id = ?`).get(id) as Job | undefined;
  if (!j) throw new NotFoundError('Job');
  return j;
}

export function isReady(j: Pick<Job, (typeof READINESS_KEYS)[number] | 'emergency_proceed'>): boolean {
  return !!j.emergency_proceed || READINESS_KEYS.every((k) => !!j[k]);
}

export function unmetReadiness(j: Job): string[] {
  return READINESS_KEYS.filter((k) => !j[k]).map((k) => READINESS_LABEL[k]);
}

export interface JobFilter {
  q?: string;
  status?: string; // specific op status or group: open | waiting_overdue | unscheduled_ready | closed
  priority?: string;
  kind?: string;
  owner?: number;
  siteId?: number;
  customerId?: number;
  limit?: number;
  offset?: number;
}

export function listJobs(db: DB, f: JobFilter = {}) {
  const where: string[] = [];
  const params: unknown[] = [];
  const now = clock.iso();
  if (f.status === 'open' || !f.status) where.push(`j.op_status IN (${OPEN_STATUSES.map((s) => `'${s}'`).join(',')})`);
  else if (f.status === 'waiting_overdue') {
    where.push(`j.op_status = 'waiting' AND j.review_at < ?`);
    params.push(now);
  } else if (f.status === 'closed') where.push(`j.op_status IN ('operationally_complete','cancelled')`);
  else if (f.status === 'awaiting_finance') where.push(`j.op_status = 'operationally_complete' AND j.financial_status <> 'financially_closed'`);
  else if (f.status !== 'all') {
    where.push('j.op_status = ?');
    params.push(f.status);
  }
  if (f.priority) {
    where.push('j.priority = ?');
    params.push(f.priority);
  }
  if (f.kind) {
    where.push('j.kind = ?');
    params.push(f.kind);
  }
  if (f.owner) {
    where.push('j.next_owner_user_id = ?');
    params.push(f.owner);
  }
  if (f.siteId) {
    where.push('j.site_id = ?');
    params.push(f.siteId);
  }
  if (f.customerId) {
    where.push('j.customer_id = ?');
    params.push(f.customerId);
  }
  if (f.q) {
    const like = `%${f.q}%`;
    where.push(`(j.ref LIKE ? OR j.title LIKE ? OR j.reported_symptom LIKE ? OR c.trading_name LIKE ? OR s.name LIKE ? OR s.postcode LIKE ? OR j.customer_po LIKE ?)`);
    params.push(like, like, like, like, like, like, like);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) n FROM jobs j JOIN customers c ON c.id = j.customer_id JOIN sites s ON s.id = j.site_id ${w}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(`${JOB_SELECT} ${w} ORDER BY j.priority, CASE WHEN j.review_at IS NULL THEN 1 ELSE 0 END, j.review_at, j.received_at LIMIT ? OFFSET ?`)
    .all(...params, f.limit ?? 50, f.offset ?? 0) as Job[];
  return { rows, total };
}

function checkVersion(j: Job, expected: number | null | undefined) {
  if (expected !== null && expected !== undefined && expected !== j.version) {
    throw new ConflictError(`${j.ref} was changed by someone else since you opened it. Reload to see the latest before trying again.`);
  }
}

function bump(db: DB, id: number, set: Record<string, unknown>) {
  const cols = Object.keys(set);
  db.prepare(`UPDATE jobs SET ${cols.map((c) => `${c} = @${c}`).join(', ')}${cols.length ? ',' : ''} updated_at = @__now, version = version + 1 WHERE id = @__id`).run({
    ...set,
    __now: clock.iso(),
    __id: id,
  });
}

function assertOpen(j: Job) {
  if (j.op_status === 'operationally_complete' || j.op_status === 'cancelled') throw new DomainError(`${j.ref} is ${j.op_status.replace('_', ' ')}; reopen is not supported in V1.`);
}

function userExists(db: DB, id: number | null): boolean {
  return !!id && !!db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(id);
}

// ------------------------------------------------------------------ intake (US-020)

/**
 * Logs a request. Captures the reported facts as given (reporter, channel, symptom,
 * impact, safety) separately from the office's priority decision and its reason.
 */
export function createJob(db: DB, actor: Actor, body: Record<string, unknown>): number {
  requireCap(actor, 'job.create');
  const f = new Form(body);
  const siteId = f.reqInt('site_id', 'Site');
  const kind = f.oneOf('kind', 'Job type', JOB_KINDS);
  const title = f.str('title', 'Short title', 200);
  const channel = f.oneOf('channel', 'Channel', CHANNELS);
  const receivedAt = f.dt('received_at', 'Time received', false) ?? clock.iso();
  const priority = f.oneOf('priority', 'Priority', PRIORITIES);
  const priorityReason = f.str('priority_reason', 'Priority reason', 1000);
  const reported = {
    reported_symptom: f.opt('reported_symptom'),
    reported_by_name: f.opt('reported_by_name', 200),
    reported_by_contact_id: f.int('reported_by_contact_id', 'Reporter'),
    impact: f.opt('impact'),
    safety_risk: f.opt('safety_risk'),
    safety_flag: f.bool('safety_flag') ? 1 : 0,
  };
  if (kind === 'reactive') f.check(reported.reported_symptom, 'reported_symptom', 'Reported symptom is required for reactive calls.');
  if (reported.safety_flag) f.check(reported.safety_risk, 'safety_risk', 'Describe the safety or property risk.');
  const assetIds = f.list('asset_ids').map(Number).filter(Number.isFinite);
  const authorityBasis = f.oneOf('authority_basis', 'Authority basis', AUTHORITY_BASES, false) || 'not_established';
  const authorityRef = f.opt('authority_ref', 200);
  const authorityNotes = f.opt('authority_notes');
  const customerPo = f.opt('customer_po', 100);
  const triageNotes = f.opt('triage_notes');
  const nextAction = f.opt('next_action', 500);
  const nextOwner = f.int('next_owner_user_id', 'Next owner');
  const reviewAt = f.dt('review_at', 'Review by', false);
  const acknowledged = f.bool('acknowledged');
  const requiredComp = f.opt('required_competences', 500);
  const estimated = f.int('estimated_minutes', 'Estimated duration', { min: 15, max: 7 * 24 * 60 });
  const projectId = f.int('project_id', 'Project');
  const parentJobId = f.int('parent_job_id', 'Parent job');
  const contractChoice = f.opt('contract_id');
  f.check(new Date(receivedAt).getTime() <= clock.now().getTime() + MIN, 'received_at', 'Time received cannot be in the future.');
  if (nextAction) {
    f.check(nextOwner, 'next_owner_user_id', 'A next action needs an owner.');
    f.check(reviewAt, 'review_at', 'A next action needs a review time.');
  }
  f.done();

  return tx(db, () => {
    const site = getSite(db, siteId);
    if (reported.reported_by_contact_id) {
      const ct = db.prepare('SELECT customer_id FROM contacts WHERE id = ?').get(reported.reported_by_contact_id) as { customer_id: number } | undefined;
      if (!ct || ct.customer_id !== site.customer_id) throw new DomainError('Reporter contact does not belong to this customer.');
    }
    for (const a of assetIds) {
      const row = db.prepare('SELECT site_id FROM assets WHERE id = ?').get(a) as { site_id: number } | undefined;
      if (!row || row.site_id !== siteId) throw new DomainError('Selected equipment is not at this site.');
    }
    if (nextOwner && !userExists(db, nextOwner)) throw new DomainError('Next owner is not an active user.');
    // Contract context is looked up, not typed in; "none" records a deliberate no-contract decision.
    const contract = contractChoice === 'none' ? null : contractForSite(db, siteId);
    const ref = nextRef(db, 'J', 10000);
    const now = clock.iso();
    const status: OpStatus = authorityBasis !== 'not_established' ? 'authorised' : triageNotes || nextAction ? 'triaged' : 'new';
    const r = db
      .prepare(
        `INSERT INTO jobs (ref, kind, customer_id, site_id, contract_id, project_id, parent_job_id, title, reported_symptom, reported_by_name, reported_by_contact_id,
           channel, received_at, impact, safety_risk, safety_flag, priority, priority_reason, triage_notes, authority_basis, authority_ref, authority_notes,
           customer_po, ready_authority, required_competences, estimated_minutes, op_status, next_action, next_owner_user_id, review_at,
           coordinator_user_id, created_by, created_at, updated_at)
         VALUES (@ref, @kind, @customer_id, @site_id, @contract_id, @project_id, @parent_job_id, @title, @reported_symptom, @reported_by_name, @reported_by_contact_id,
           @channel, @received_at, @impact, @safety_risk, @safety_flag, @priority, @priority_reason, @triage_notes, @authority_basis, @authority_ref, @authority_notes,
           @customer_po, @ready_authority, @required_competences, @estimated_minutes, @op_status, @next_action, @next_owner_user_id, @review_at,
           @coordinator_user_id, @created_by, @now, @now)`,
      )
      .run({
        ref,
        kind,
        customer_id: site.customer_id,
        site_id: siteId,
        contract_id: contract?.id ?? null,
        project_id: projectId,
        parent_job_id: parentJobId,
        title,
        ...reported,
        channel,
        received_at: receivedAt,
        priority,
        priority_reason: priorityReason,
        triage_notes: triageNotes,
        authority_basis: authorityBasis,
        authority_ref: authorityRef,
        authority_notes: authorityNotes,
        customer_po: customerPo,
        ready_authority: authorityBasis !== 'not_established' ? 1 : 0,
        required_competences: requiredComp,
        estimated_minutes: estimated,
        op_status: status,
        next_action: nextAction,
        next_owner_user_id: nextOwner,
        review_at: reviewAt,
        coordinator_user_id: actor.role === 'coordinator' ? actor.id : null,
        created_by: actor.id,
        now,
      });
    const id = Number(r.lastInsertRowid);
    const ins = db.prepare('INSERT INTO job_assets (job_id, asset_id) VALUES (?, ?)');
    for (const a of assetIds) ins.run(id, a);
    db.prepare('INSERT INTO priority_changes (job_id, from_priority, to_priority, reason, decided_by, decided_at) VALUES (?, NULL, ?, ?, ?, ?)').run(
      id,
      priority,
      priorityReason,
      actor.id,
      now,
    );
    recordSlaEvent(db, actor, id, 'received', receivedAt, { source: 'system', note: `Logged via ${channel}` });
    if (acknowledged) recordSlaEvent(db, actor, id, 'acknowledged', now, { source: 'manual', note: 'Acknowledged at intake' });
    if (triageNotes) db.prepare(`INSERT INTO job_notes (job_id, kind, body, author_id, created_at) VALUES (?, 'triage', ?, ?, ?)`).run(id, triageNotes, actor.id, now);
    audit(db, actor, 'job', id, 'created', {
      reason: priorityReason,
      after: { ref, kind, priority, op_status: status, contract: contract?.ref ?? 'none', authority_basis: authorityBasis, assets: assetIds },
    });
    if (nextOwner && nextOwner !== actor.id) notify(db, nextOwner, 'next_action', `${ref}: ${nextAction}`, `/jobs/${id}`);
    return id;
  });
}

// ------------------------------------------------------------------ triage / priority / authority

export function triageJob(db: DB, actor: Actor, id: number, body: Record<string, unknown>) {
  requireCap(actor, 'job.triage');
  const f = new Form(body);
  const notes = f.str('triage_notes', 'Triage outcome', 4000);
  const version = f.int('version', 'Version');
  f.done();
  tx(db, () => {
    const j = getJob(db, id);
    checkVersion(j, version);
    assertOpen(j);
    const status = j.op_status === 'new' ? 'triaged' : j.op_status;
    bump(db, id, { triage_notes: notes, op_status: status });
    db.prepare(`INSERT INTO job_notes (job_id, kind, body, author_id, created_at) VALUES (?, 'triage', ?, ?, ?)`).run(id, notes, actor.id, clock.iso());
    audit(db, actor, 'job', id, 'triaged', { before: { op_status: j.op_status }, after: { op_status: status } });
  });
}

/** Priority change with reason, decision-maker and time (FR-006, RULE-002). */
export function changePriority(db: DB, actor: Actor, id: number, body: Record<string, unknown>) {
  requireCap(actor, 'job.priority');
  const f = new Form(body);
  const to = f.oneOf('priority', 'New priority', PRIORITIES);
  const reason = f.str('reason', 'Reason for change', 1000);
  const version = f.int('version', 'Version');
  f.done();
  tx(db, () => {
    const j = getJob(db, id);
    checkVersion(j, version);
    assertOpen(j);
    if (j.priority === to) throw new DomainError(`Priority is already ${to}.`);
    bump(db, id, { priority: to, priority_reason: reason });
    db.prepare('INSERT INTO priority_changes (job_id, from_priority, to_priority, reason, decided_by, decided_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      j.priority,
      to,
      reason,
      actor.id,
      clock.iso(),
    );
    audit(db, actor, 'job', id, 'priority_changed', { reason, before: { priority: j.priority }, after: { priority: to } });
  });
}

export function setAuthority(db: DB, actor: Actor, id: number, body: Record<string, unknown>) {
  requireCap(actor, 'job.authorise');
  const f = new Form(body);
  const basis = f.oneOf('authority_basis', 'Authority basis', AUTHORITY_BASES);
  const ref = f.opt('authority_ref', 200);
  const notes = f.opt('authority_notes');
  const po = f.opt('customer_po', 100);
  const reason = f.str('reason', 'Evidence / reason', 1000);
  const version = f.int('version', 'Version');
  if (basis === 'accepted_quote') f.check(ref, 'authority_ref', 'Reference the accepted quotation.');
  f.done();
  tx(db, () => {
    const j = getJob(db, id);
    checkVersion(j, version);
    assertOpen(j);
    const established = basis !== 'not_established';
    let status = j.op_status;
    if (established && (status === 'new' || status === 'triaged')) status = 'authorised';
    if (!established && (status === 'authorised' || status === 'ready')) status = 'triaged';
    bump(db, id, { authority_basis: basis, authority_ref: ref, authority_notes: notes, customer_po: po ?? j.customer_po, ready_authority: established ? 1 : 0, op_status: status });
    audit(db, actor, 'job', id, 'authority_set', {
      reason,
      before: { authority_basis: j.authority_basis, authority_ref: j.authority_ref, op_status: j.op_status },
      after: { authority_basis: basis, authority_ref: ref, op_status: status },
    });
  });
}

/**
 * Readiness is an explicit checklist, separate from authority and scheduling (RULE-004).
 * All items confirmed -> ready. Emergency proceed records a deliberate decision to go with uncertainty.
 */
export function updateReadiness(db: DB, actor: Actor, id: number, body: Record<string, unknown>) {
  requireCap(actor, 'job.readiness');
  const f = new Form(body);
  const flags = Object.fromEntries(READINESS_KEYS.map((k) => [k, f.bool(k) ? 1 : 0])) as Record<(typeof READINESS_KEYS)[number], number>;
  const emergency = f.bool('emergency_proceed') ? 1 : 0;
  const emergencyReason = f.opt('emergency_reason', 1000);
  const requiredComp = f.opt('required_competences', 500);
  const estimated = f.int('estimated_minutes', 'Estimated duration', { min: 15, max: 7 * 24 * 60 });
  const resources = f.opt('expected_resources');
  const version = f.int('version', 'Version');
  if (emergency) f.check(emergencyReason, 'emergency_reason', 'Record why the work proceeds despite unmet readiness.');
  f.done();
  tx(db, () => {
    const j = getJob(db, id);
    checkVersion(j, version);
    assertOpen(j);
    if (flags.ready_authority && j.authority_basis === 'not_established') {
      throw new DomainError('Authority cannot be confirmed as ready until an authority basis is recorded.');
    }
    const merged = { ...j, ...flags, emergency_proceed: emergency };
    let status = j.op_status;
    const authorised = j.authority_basis !== 'not_established';
    if (['new', 'triaged', 'authorised', 'ready'].includes(status)) {
      if (isReady(merged) && (authorised || emergency)) status = 'ready';
      else if (authorised) status = 'authorised';
      else status = j.op_status === 'new' ? 'new' : 'triaged';
    }
    bump(db, id, {
      ...flags,
      emergency_proceed: emergency,
      emergency_reason: emergency ? emergencyReason : null,
      required_competences: requiredComp,
      estimated_minutes: estimated,
      expected_resources: resources,
      op_status: status,
    });
    audit(db, actor, 'job', id, emergency && !j.emergency_proceed ? 'emergency_proceed' : 'readiness_updated', {
      reason: emergency ? emergencyReason : null,
      before: { ...Object.fromEntries(READINESS_KEYS.map((k) => [k, j[k]])), emergency_proceed: j.emergency_proceed, op_status: j.op_status },
      after: { ...flags, emergency_proceed: emergency, op_status: status },
    });
  });
}

// ------------------------------------------------------------------ waiting / next action (US-022)

export function setWaiting(db: DB, actor: Actor, id: number, body: Record<string, unknown>) {
  requireCap(actor, 'job.waiting');
  const f = new Form(body);
  const category = f.oneOf('waiting_category', 'Dependency', WAITING_CATEGORIES);
  const detail = f.str('waiting_detail', 'Exactly what is awaited', 2000);
  const nextAction = f.str('next_action', 'Next action', 500);
  const owner = f.reqInt('next_owner_user_id', 'Owner');
  const reviewAt = f.reqDt('review_at', 'Review / chase by');
  const version = f.int('version', 'Version');
  f.done();
  tx(db, () => {
    const j = getJob(db, id);
    checkVersion(j, version);
    assertOpen(j);
    if (!userExists(db, owner)) throw new DomainError('Owner is not an active user.');
    const active = db.prepare(`SELECT COUNT(*) n FROM attendances WHERE job_id = ? AND status IN ('dispatched','travelling','on_site','working')`).get(id) as { n: number };
    if (active.n) throw new DomainError('An attendance is in progress; the engineer records the outcome and handoff first.');
    bump(db, id, {
      op_status: 'waiting',
      waiting_category: category,
      waiting_detail: detail,
      waiting_since: j.op_status === 'waiting' ? j.waiting_since : clock.iso(),
      next_action: nextAction,
      next_owner_user_id: owner,
      review_at: reviewAt,
    });
    audit(db, actor, 'job', id, 'waiting_set', {
      reason: detail,
      before: { op_status: j.op_status, waiting_category: j.waiting_category, next_owner: j.next_owner_user_id, review_at: j.review_at },
      after: { op_status: 'waiting', waiting_category: category, next_owner: owner, review_at: reviewAt },
    });
    if (owner !== actor.id) notify(db, owner, 'waiting', `${j.ref} waiting on ${WAITING_LABEL[category]}: ${nextAction}`, `/jobs/${id}`);
  });
}

/** Clears a dependency. The job returns to the stage its readiness supports. */
export function resolveWaiting(db: DB, actor: Actor, id: number, body: Record<string, unknown>) {
  requireCap(actor, 'job.waiting');
  const f = new Form(body);
  const note = f.str('resolution', 'What resolved the dependency', 2000);
  const nextAction = f.opt('next_action', 500);
  const owner = f.int('next_owner_user_id', 'Owner');
  const reviewAt = f.dt('review_at', 'Review by', false);
  const version = f.int('version', 'Version');
  f.done();
  tx(db, () => {
    const j = getJob(db, id);
    checkVersion(j, version);
    if (j.op_status !== 'waiting') throw new DomainError(`${j.ref} is not waiting.`);
    const hasPlanned = db.prepare(`SELECT COUNT(*) n FROM attendances WHERE job_id = ? AND status = 'planned'`).get(id) as { n: number };
    const authorised = j.authority_basis !== 'not_established';
    const status: OpStatus = hasPlanned.n ? 'scheduled' : isReady(j) && authorised ? 'ready' : authorised ? 'authorised' : 'triaged';
    bump(db, id, {
      op_status: status,
      waiting_category: null,
      waiting_detail: null,
      waiting_since: null,
      next_action: nextAction,
      next_owner_user_id: nextAction ? owner : null,
      review_at: nextAction ? reviewAt : null,
    });
    db.prepare(`INSERT INTO job_notes (job_id, kind, body, author_id, created_at) VALUES (?, 'note', ?, ?, ?)`).run(
      id,
      `Dependency cleared (${j.waiting_category ? WAITING_LABEL[j.waiting_category] : '—'}): ${note}`,
      actor.id,
      clock.iso(),
    );
    audit(db, actor, 'job', id, 'waiting_resolved', { reason: note, before: { op_status: 'waiting', waiting_category: j.waiting_category }, after: { op_status: status } });
  });
}

export function setNextAction(db: DB, actor: Actor, id: number, body: Record<string, unknown>) {
  requireCap(actor, 'job.waiting');
  const f = new Form(body);
  const nextAction = f.str('next_action', 'Next action', 500);
  const owner = f.reqInt('next_owner_user_id', 'Owner');
  const reviewAt = f.reqDt('review_at', 'Review by');
  const version = f.int('version', 'Version');
  f.done();
  tx(db, () => {
    const j = getJob(db, id);
    checkVersion(j, version);
    assertOpen(j);
    if (!userExists(db, owner)) throw new DomainError('Owner is not an active user.');
    bump(db, id, { next_action: nextAction, next_owner_user_id: owner, review_at: reviewAt });
    audit(db, actor, 'job', id, 'next_action_set', {
      before: { next_action: j.next_action, next_owner: j.next_owner_user_id, review_at: j.review_at },
      after: { next_action: nextAction, next_owner: owner, review_at: reviewAt },
    });
    if (owner !== actor.id) notify(db, owner, 'next_action', `${j.ref}: ${nextAction}`, `/jobs/${id}`);
  });
}

// ------------------------------------------------------------------ closure dimensions (FR-018)

/** Operational completion is an office decision; attendance submission never implies it (RULE-001). */
export function completeOperationally(db: DB, actor: Actor, id: number, body: Record<string, unknown>) {
  requireCap(actor, 'job.close.operational');
  const f = new Form(body);
  const reason = f.str('reason', 'Completion basis', 2000);
  const version = f.int('version', 'Version');
  f.done();
  tx(db, () => {
    const j = getJob(db, id);
    checkVersion(j, version);
    assertOpen(j);
    const blockers = closureBlockers(db, j);
    if (blockers.length) throw new DomainError(`Cannot complete ${j.ref}: ${blockers.join('; ')}.`);
    bump(db, id, { op_status: 'operationally_complete', waiting_category: null, waiting_detail: null, waiting_since: null, next_action: null, next_owner_user_id: null, review_at: null });
    recordSlaEvent(db, actor, id, 'closure', clock.iso(), { source: 'system', note: reason });
    audit(db, actor, 'job', id, 'operationally_completed', { reason, before: { op_status: j.op_status }, after: { op_status: 'operationally_complete', financial_status: j.financial_status, commercial_status: j.commercial_status } });
  });
}

export function closureBlockers(db: DB, j: Job): string[] {
  const out: string[] = [];
  const active = db.prepare(`SELECT COUNT(*) n FROM attendances WHERE job_id = ? AND status NOT IN ('submitted','cancelled')`).get(j.id) as { n: number };
  if (active.n) out.push(`${active.n} attendance(s) not yet submitted or cancelled`);
  const temp = db.prepare(`SELECT COUNT(*) n FROM temporary_restorations WHERE job_id = ? AND status = 'open'`).get(j.id) as { n: number };
  if (temp.n) out.push(`${temp.n} temporary restoration(s) still open — resolve or hand to a follow-on first`);
  const esc = db
    .prepare(`SELECT COUNT(*) n FROM attendance_stops st JOIN attendances a ON a.id = st.attendance_id WHERE a.job_id = ? AND st.resolved_at IS NULL`)
    .get(j.id) as { n: number };
  if (esc.n) out.push(`${esc.n} stop/escalation(s) unresolved`);
  const clk = db.prepare(`SELECT COUNT(*) n FROM clock_stops WHERE job_id = ? AND ended_at IS NULL`).get(j.id) as { n: number };
  if (clk.n) out.push('an SLA clock stop is still running');
  return out;
}

export function setFinancialStatus(db: DB, actor: Actor, id: number, body: Record<string, unknown>) {
  requireCap(actor, 'job.close.financial');
  const f = new Form(body);
  const to = f.oneOf('financial_status', 'Financial status', FINANCIAL_STATUSES);
  const reason = f.str('reason', 'Reason / reference', 1000);
  const version = f.int('version', 'Version');
  f.done();
  tx(db, () => {
    const j = getJob(db, id);
    checkVersion(j, version);
    if (j.financial_status === to) throw new DomainError(`Financial status is already ${to.replace(/_/g, ' ')}.`);
    if (to === 'financially_closed' && j.op_status !== 'operationally_complete' && j.op_status !== 'cancelled') {
      throw new DomainError('Financial closure requires the job to be operationally complete or cancelled first.');
    }
    bump(db, id, { financial_status: to });
    audit(db, actor, 'job', id, 'financial_status_changed', { reason, before: { financial_status: j.financial_status }, after: { financial_status: to } });
  });
}

export function setCommercialStatus(db: DB, actor: Actor, id: number, body: Record<string, unknown>) {
  requireCap(actor, 'job.commercial');
  const f = new Form(body);
  const to = f.oneOf('commercial_status', 'Commercial status', COMMERCIAL_STATUSES);
  const reason = f.str('reason', 'Reason', 1000);
  const version = f.int('version', 'Version');
  f.done();
  tx(db, () => {
    const j = getJob(db, id);
    checkVersion(j, version);
    if (j.commercial_status === to) throw new DomainError(`Commercial status is already ${to.replace(/_/g, ' ')}.`);
    bump(db, id, { commercial_status: to });
    audit(db, actor, 'job', id, 'commercial_status_changed', { reason, before: { commercial_status: j.commercial_status }, after: { commercial_status: to } });
  });
}

export function cancelJob(db: DB, actor: Actor, id: number, body: Record<string, unknown>) {
  requireCap(actor, 'job.cancel');
  const f = new Form(body);
  const reason = f.str('reason', 'Cancellation reason', 2000);
  const version = f.int('version', 'Version');
  f.done();
  tx(db, () => {
    const j = getJob(db, id);
    checkVersion(j, version);
    assertOpen(j);
    const inField = db.prepare(`SELECT COUNT(*) n FROM attendances WHERE job_id = ? AND status IN ('dispatched','travelling','on_site','working')`).get(id) as { n: number };
    if (inField.n) throw new DomainError('An engineer is dispatched or on site. Recall them and cancel the attendance first.');
    const planned = db.prepare(`SELECT id, engineer_user_id, ref FROM attendances WHERE job_id = ? AND status = 'planned'`).all(id) as { id: number; engineer_user_id: number; ref: string }[];
    for (const a of planned) {
      db.prepare(`UPDATE attendances SET status = 'cancelled', cancelled_reason = ?, version = version + 1 WHERE id = ?`).run(`Job cancelled: ${reason}`, a.id);
      notify(db, a.engineer_user_id, 'schedule', `${a.ref} cancelled — ${j.ref} was cancelled`, `/jobs/${id}`);
    }
    bump(db, id, { op_status: 'cancelled', waiting_category: null, waiting_detail: null, waiting_since: null, next_action: null, next_owner_user_id: null, review_at: null });
    audit(db, actor, 'job', id, 'cancelled', { reason, before: { op_status: j.op_status }, after: { op_status: 'cancelled', cancelled_attendances: planned.map((a) => a.ref) } });
  });
}

export function addNote(db: DB, actor: Actor, id: number, body: Record<string, unknown>) {
  const f = new Form(body);
  const kind = f.oneOf('kind', 'Note type', ['note', 'customer_update'] as const);
  const text = f.str('body', 'Note', 8000);
  const aiId = f.int('ai_interaction_id', 'AI suggestion');
  f.done();
  const j = getJob(db, id);
  if (actor.role === 'engineer') {
    const assigned = db.prepare(`SELECT 1 FROM attendances WHERE job_id = ? AND engineer_user_id = ? AND status <> 'cancelled'`).get(id, actor.id);
    if (!assigned) throw new ForbiddenError('You are not assigned to this job.');
  } else requireCap(actor, 'job.note');
  tx(db, () => {
    const r = db.prepare(`INSERT INTO job_notes (job_id, kind, body, author_id, ai_interaction_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(id, kind, text, actor.id, aiId, clock.iso());
    if (aiId) {
      // Human applied an AI draft: record acceptance provenance; the note author remains the human.
      db.prepare(`UPDATE ai_interactions SET status = 'applied', decided_at = ? WHERE id = ? AND actor_id = ? AND status = 'suggested'`).run(clock.iso(), aiId, actor.id);
    }
    audit(db, actor, 'job', id, kind === 'customer_update' ? 'customer_update_logged' : 'note_added', { after: { note_id: Number(r.lastInsertRowid), ai_assisted: !!aiId } });
  });
  return j;
}

// ------------------------------------------------------------------ read models for the job page

export function jobNotes(db: DB, id: number) {
  return db
    .prepare(`SELECT n.*, u.display_name AS author_name FROM job_notes n LEFT JOIN users u ON u.id = n.author_id WHERE n.job_id = ? ORDER BY n.created_at DESC, n.id DESC`)
    .all(id) as { id: number; kind: string; body: string; author_name: string | null; created_at: string; ai_interaction_id: number | null }[];
}

export function priorityHistory(db: DB, id: number) {
  return db
    .prepare(`SELECT p.*, u.display_name AS decided_by_name FROM priority_changes p JOIN users u ON u.id = p.decided_by WHERE p.job_id = ? ORDER BY p.decided_at DESC, p.id DESC`)
    .all(id) as { from_priority: string | null; to_priority: string; reason: string; decided_by_name: string; decided_at: string }[];
}

export function jobAssets(db: DB, id: number) {
  return db
    .prepare(`SELECT a.* FROM job_assets ja JOIN assets a ON a.id = ja.asset_id WHERE ja.job_id = ? ORDER BY a.ref`)
    .all(id) as { id: number; ref: string; description: string; manufacturer: string | null; model: string | null; serial: string | null; category: string; location_detail: string | null }[];
}

export function staffOptions(db: DB, roles?: string[]) {
  const rows = db.prepare(`SELECT id, display_name, role FROM users WHERE active = 1 ORDER BY display_name`).all() as { id: number; display_name: string; role: string }[];
  return roles ? rows.filter((r) => roles.includes(r.role)) : rows;
}

export function defaultReview(hours = 24): string {
  return new Date(clock.now().getTime() + hours * 60 * MIN).toISOString();
}
export const ONE_DAY = DAY;
