import type { DB } from '../db/db.ts';
import { tx } from '../db/db.ts';
import { type Actor, can, requireCap } from '../auth/policy.ts';
import { audit, notify } from './audit.ts';
import { addDays, clock, londonDate, londonDayStart, MIN } from '../lib/clock.ts';
import { ConflictError, DomainError, ForbiddenError, NotFoundError } from '../lib/errors.ts';
import { Form } from '../lib/form.ts';
import { nextRef } from '../lib/refs.ts';
import { getJob, isReady, type Job, type OpStatus, unmetReadiness, WAITING_LABEL } from './jobs.ts';
import { recordSlaEvent } from './sla.ts';

export const COMMITMENTS = ['provisional', 'customer_confirmed'] as const;

export interface Attendance {
  id: number;
  ref: string;
  job_id: number;
  engineer_user_id: number;
  status: 'planned' | 'dispatched' | 'travelling' | 'on_site' | 'working' | 'submitted' | 'cancelled';
  commitment: (typeof COMMITMENTS)[number];
  planned_start: string;
  planned_end: string;
  instructions: string | null;
  warnings: string | null;
  override_reason: string | null;
  override_by: number | null;
  scheduled_by: number | null;
  scheduled_at: string | null;
  dispatched_at: string | null;
  travel_started_at: string | null;
  arrived_at: string | null;
  work_started_at: string | null;
  work_ended_at: string | null;
  submitted_at: string | null;
  outcome: string | null;
  authority_basis: string | null;
  reported_confirmed: string | null;
  observed_facts: string | null;
  tests_performed: string | null;
  diagnosis: string | null;
  diagnosis_verified: number;
  work_done: string | null;
  final_condition: string | null;
  safety_notes: string | null;
  uncertainty: string | null;
  recommendations: string | null;
  labour_minutes: number | null;
  travel_minutes: number | null;
  followon_required: number;
  handoff_required_outcome: string | null;
  handoff_dependency: string | null;
  handoff_dependency_detail: string | null;
  handoff_operating_condition: string | null;
  handoff_parts_specialist: string | null;
  handoff_promises: string | null;
  handoff_urgency: string | null;
  handoff_authority: string | null;
  handoff_next_owner_user_id: number | null;
  ack_name: string | null;
  ack_role: string | null;
  ack_at: string | null;
  ack_comment: string | null;
  ack_not_obtained_reason: string | null;
  cancelled_reason: string | null;
  version: number;
  created_at: string;
  engineer_name?: string;
  job_ref?: string;
  job_title?: string;
  priority?: string;
  site_name?: string;
  site_postcode?: string;
  customer_name?: string;
}

export const ACTIVE_ATTENDANCE = ['planned', 'dispatched', 'travelling', 'on_site', 'working'] as const;

const ATT_SELECT = `SELECT a.*, u.display_name AS engineer_name, j.ref AS job_ref, j.title AS job_title, j.priority, j.op_status AS job_status,
  s.name AS site_name, s.postcode AS site_postcode, s.area AS site_area, c.trading_name AS customer_name
  FROM attendances a JOIN users u ON u.id = a.engineer_user_id JOIN jobs j ON j.id = a.job_id JOIN sites s ON s.id = j.site_id JOIN customers c ON c.id = j.customer_id`;

export function getAttendance(db: DB, id: number): Attendance {
  const a = db.prepare(`${ATT_SELECT} WHERE a.id = ?`).get(id) as Attendance | undefined;
  if (!a) throw new NotFoundError('Attendance');
  return a;
}

export function attendancesForJob(db: DB, jobId: number): Attendance[] {
  return db.prepare(`${ATT_SELECT} WHERE a.job_id = ? ORDER BY a.planned_start`).all(jobId) as Attendance[];
}

export interface Engineer {
  id: number;
  display_name: string;
  home_area: string | null;
  van_location_id: number | null;
  planning_notes: string | null;
  phone: string | null;
}

export function engineers(db: DB): Engineer[] {
  return db.prepare(`SELECT id, display_name, home_area, van_location_id, planning_notes, phone FROM users WHERE role = 'engineer' AND active = 1 ORDER BY display_name`).all() as Engineer[];
}

export function competencesFor(db: DB, userId: number) {
  return db.prepare(`SELECT * FROM engineer_competences WHERE user_id = ? ORDER BY tag`).all(userId) as {
    id: number;
    tag: string;
    detail: string | null;
    valid_from: string | null;
    valid_to: string | null;
    notes: string | null;
  }[];
}

export function clearancesFor(db: DB, userId: number) {
  return db
    .prepare(`SELECT c.*, s.name AS site_name FROM engineer_site_clearances c JOIN sites s ON s.id = c.site_id WHERE c.user_id = ? ORDER BY s.name`)
    .all(userId) as { id: number; site_id: number; site_name: string; detail: string | null; valid_to: string | null }[];
}

export function planningDayMinutes(db: DB): number {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'planning_day_minutes'`).get() as { value: string } | undefined;
  return row ? parseInt(row.value, 10) || 600 : 600;
}

export type SignalLevel = 'ok' | 'info' | 'warn';
export interface Signal {
  level: SignalLevel;
  code: string;
  text: string;
}

/**
 * Planning signals for putting an engineer on a job (FR-010/011). These are advisory
 * warnings from recorded planning data, not undiscovered hard rules; warnings require an
 * acknowledged override with a reason (AC-030-03).
 */
export function assignmentSignals(db: DB, job: Job, engineerId: number, start: string, end: string, ignoreAttendanceId?: number): Signal[] {
  const out: Signal[] = [];
  const date = start.slice(0, 10);
  const eng = db.prepare(`SELECT id, display_name, home_area, role, active FROM users WHERE id = ?`).get(engineerId) as
    | { id: number; display_name: string; home_area: string | null; role: string; active: number }
    | undefined;
  if (!eng || eng.role !== 'engineer' || !eng.active) {
    out.push({ level: 'warn', code: 'not_engineer', text: 'Selected user is not an active field engineer.' });
    return out;
  }
  // Competence / authorisation
  const required = (job.required_competences ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const comps = competencesFor(db, engineerId);
  if (!required.length) out.push({ level: 'info', code: 'no_requirement', text: 'No competence requirement recorded on the job.' });
  for (const r of required) {
    const match = comps.find((c) => c.tag.toLowerCase() === r);
    if (!match) out.push({ level: 'warn', code: 'competence_missing', text: `No recorded competence: ${r}` });
    else if (match.valid_to && match.valid_to < date) out.push({ level: 'warn', code: 'competence_expired', text: `${match.tag} expired ${match.valid_to}` });
    else out.push({ level: 'ok', code: 'competence_ok', text: `${match.tag}${match.valid_to ? ` (valid to ${match.valid_to})` : ''}` });
  }
  // Site clearance
  const site = db.prepare('SELECT induction_required, induction_permits, area FROM sites WHERE id = ?').get(job.site_id) as {
    induction_required: number;
    induction_permits: string | null;
    area: string | null;
  };
  if (site.induction_required) {
    const cl = db.prepare('SELECT * FROM engineer_site_clearances WHERE user_id = ? AND site_id = ?').get(engineerId, job.site_id) as { valid_to: string | null } | undefined;
    if (!cl) out.push({ level: 'warn', code: 'clearance_missing', text: 'Site requires induction/clearance; none recorded for this engineer.' });
    else if (cl.valid_to && cl.valid_to < date) out.push({ level: 'warn', code: 'clearance_expired', text: `Site clearance expired ${cl.valid_to}` });
    else out.push({ level: 'ok', code: 'clearance_ok', text: 'Site clearance recorded' });
  }
  // Geography (information only — travel time is not modelled in V1)
  if (eng.home_area && site.area) {
    out.push(
      eng.home_area === site.area
        ? { level: 'ok', code: 'area_match', text: `Based in ${eng.home_area}` }
        : { level: 'info', code: 'area_differs', text: `Based in ${eng.home_area}; site is in ${site.area}` },
    );
  }
  // Existing commitments and overlaps
  const dayStart = londonDayStart(londonDate(start));
  const dayEnd = londonDayStart(addDays(londonDate(start), 1));
  const sameDay = db
    .prepare(
      `SELECT a.id, a.ref, a.planned_start, a.planned_end, a.commitment, j.ref AS job_ref, j.priority FROM attendances a JOIN jobs j ON j.id = a.job_id
       WHERE a.engineer_user_id = ? AND a.status IN ('planned','dispatched','travelling','on_site','working') AND a.planned_start < ? AND a.planned_end > ? AND a.id IS NOT ?`,
    )
    .all(engineerId, dayEnd, dayStart, ignoreAttendanceId ?? null) as { id: number; ref: string; planned_start: string; planned_end: string; commitment: string; job_ref: string; priority: string }[];
  const booked = sameDay.reduce((m, a) => m + (new Date(a.planned_end).getTime() - new Date(a.planned_start).getTime()) / MIN, 0);
  const thisMins = (new Date(end).getTime() - new Date(start).getTime()) / MIN;
  const limit = planningDayMinutes(db);
  out.push({ level: 'info', code: 'booked', text: `${sameDay.length} other commitment(s), ${Math.round(booked / 6) / 10}h booked that day` });
  if (booked + thisMins > limit) {
    out.push({ level: 'warn', code: 'long_day', text: `Planned time would reach ${Math.round((booked + thisMins) / 6) / 10}h (planning guide ${limit / 60}h) — check working time/fatigue` });
  }
  for (const a of sameDay) {
    if (a.planned_start < end && a.planned_end > start) {
      out.push({
        level: 'warn',
        code: 'overlap',
        text: `Overlaps ${a.ref} (${a.job_ref} ${a.priority}${a.commitment === 'customer_confirmed' ? ', customer-confirmed' : ''})`,
      });
    }
  }
  // Readiness (RULE-004)
  if (job.op_status === 'waiting') {
    out.push({ level: 'warn', code: 'waiting', text: `Job is waiting: ${job.waiting_category ? WAITING_LABEL[job.waiting_category] : ''} — ${job.waiting_detail ?? ''}` });
  } else if (!isReady(job)) {
    out.push({ level: 'warn', code: 'not_ready', text: `Job not ready: ${unmetReadiness(job).join(', ')}` });
  } else if (job.emergency_proceed) {
    out.push({ level: 'info', code: 'emergency', text: `Emergency proceed: ${job.emergency_reason ?? ''}` });
  }
  if (job.authority_basis === 'not_established') out.push({ level: 'warn', code: 'no_authority', text: 'No authority basis recorded — attendance would be diagnosis at most.' });
  // Parts
  const res = db.prepare(`SELECT COUNT(*) n FROM reservations WHERE job_id = ? AND status IN ('active','picked')`).get(job.id) as { n: number };
  if (res.n) out.push({ level: 'info', code: 'parts_reserved', text: `${res.n} stock reservation(s) held for this job` });
  return out;
}

export function overlappingAttendances(db: DB, engineerId: number, start: string, end: string, ignoreId?: number) {
  return db
    .prepare(
      `SELECT a.*, j.ref AS job_ref FROM attendances a JOIN jobs j ON j.id = a.job_id
       WHERE a.engineer_user_id = ? AND a.status IN ('planned','dispatched','travelling','on_site','working') AND a.planned_start < ? AND a.planned_end > ? AND a.id IS NOT ?`,
    )
    .all(engineerId, end, start, ignoreId ?? null) as (Attendance & { job_ref: string })[];
}

interface DisplacementInput {
  reason: string;
  comms_owner_user_id: number;
  comms_note: string;
  new_next_action: string;
  new_owner_user_id: number;
  review_at: string;
}

function readDisplacement(f: Form, prefix = 'disp_'): DisplacementInput {
  return {
    reason: f.str(`${prefix}reason`, 'Displacement reason', 2000),
    comms_owner_user_id: f.reqInt(`${prefix}comms_owner_user_id`, 'Customer communication owner'),
    comms_note: f.str(`${prefix}comms_note`, 'Customer communication', 2000),
    new_next_action: f.str(`${prefix}new_next_action`, 'Next action for displaced work', 500),
    new_owner_user_id: f.reqInt(`${prefix}new_owner_user_id`, 'Owner for displaced work'),
    review_at: f.reqDt(`${prefix}review_at`, 'Review by for displaced work'),
  };
}

/**
 * Records a displacement/reschedule/cancellation of committed work and hands the displaced job
 * a new owner and next action (FR-012, AC-031-01/02).
 */
function applyDisplacement(
  db: DB,
  actor: Actor,
  att: Attendance,
  type: 'displaced' | 'rescheduled' | 'cancelled',
  d: DisplacementInput,
  opts: { displacingJobId?: number | null; newStart?: string | null; newEnd?: string | null },
) {
  const now = clock.iso();
  db.prepare(
    `INSERT INTO schedule_displacements (attendance_id, displacing_job_id, change_type, previous_start, previous_end, new_start, new_end, reason, authorised_by,
       comms_owner_user_id, comms_note, new_next_action, new_owner_user_id, review_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    att.id,
    opts.displacingJobId ?? null,
    type,
    att.planned_start,
    att.planned_end,
    opts.newStart ?? null,
    opts.newEnd ?? null,
    d.reason,
    actor.id,
    d.comms_owner_user_id,
    d.comms_note,
    d.new_next_action,
    d.new_owner_user_id,
    d.review_at,
    actor.id,
    now,
  );
  db.prepare(`UPDATE jobs SET next_action = ?, next_owner_user_id = ?, review_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`).run(
    d.new_next_action,
    d.new_owner_user_id,
    d.review_at,
    now,
    att.job_id,
  );
  db.prepare(`INSERT INTO job_notes (job_id, kind, body, author_id, created_at) VALUES (?, 'note', ?, ?, ?)`).run(
    att.job_id,
    `${att.ref} ${type}: ${d.reason}. Customer communication: ${d.comms_note}`,
    actor.id,
    now,
  );
  audit(db, actor, 'attendance', att.id, `commitment_${type}`, {
    reason: d.reason,
    before: { planned_start: att.planned_start, planned_end: att.planned_end, commitment: att.commitment, engineer: att.engineer_user_id },
    after: { new_start: opts.newStart ?? null, displacing_job: opts.displacingJobId ?? null, comms_owner: d.comms_owner_user_id, new_owner: d.new_owner_user_id },
  });
  audit(db, actor, 'job', att.job_id, 'schedule_displaced', { reason: d.reason, after: { attendance: att.ref, change: type, next_action: d.new_next_action } });
  notify(db, d.new_owner_user_id, 'displacement', `${att.job_ref ?? 'Job'}: ${att.ref} ${type} — ${d.new_next_action}`, `/jobs/${att.job_id}`);
  if (d.comms_owner_user_id !== d.new_owner_user_id) notify(db, d.comms_owner_user_id, 'customer_comms', `Tell customer about ${att.ref} (${type}): ${d.comms_note}`, `/jobs/${att.job_id}`);
  notify(db, att.engineer_user_id, 'schedule', `${att.ref} ${type}`, `/my-day`);
}

/** After attendance changes, move the job between ready/scheduled/dispatched consistently. */
export function recomputeScheduleStatus(db: DB, jobId: number) {
  const j = getJob(db, jobId);
  if (!['ready', 'authorised', 'triaged', 'new', 'scheduled', 'dispatched'].includes(j.op_status)) return;
  const counts = db.prepare(`SELECT status, COUNT(*) n FROM attendances WHERE job_id = ? GROUP BY status`).all(jobId) as { status: string; n: number }[];
  const n = (s: string) => counts.find((c) => c.status === s)?.n ?? 0;
  let status: OpStatus;
  if (n('dispatched')) status = 'dispatched';
  else if (n('planned')) status = 'scheduled';
  else if (j.authority_basis !== 'not_established' && isReady(j)) status = 'ready';
  else if (j.authority_basis !== 'not_established') status = 'authorised';
  else status = 'triaged';
  if (status !== j.op_status) db.prepare(`UPDATE jobs SET op_status = ?, updated_at = ?, version = version + 1 WHERE id = ?`).run(status, clock.iso(), jobId);
}

/** Assigns an engineer (US-030). Signals computed server-side; warnings need acknowledged override. */
export function assignAttendance(db: DB, actor: Actor, jobId: number, body: Record<string, unknown>): number {
  requireCap(actor, 'schedule.assign');
  const f = new Form(body);
  const engineerId = f.reqInt('engineer_user_id', 'Engineer');
  const start = f.reqDt('planned_start', 'Start');
  const end = f.reqDt('planned_end', 'End');
  const commitment = f.oneOf('commitment', 'Commitment', COMMITMENTS);
  const instructions = f.opt('instructions');
  const overrideAck = f.bool('override_ack');
  const overrideReason = f.opt('override_reason', 2000);
  const displace = f.list('displace_ids').map(Number);
  f.check(!start || !end || end > start, 'planned_end', 'End must be after start.');
  f.done();
  const disp = displace.length ? (() => {
    const g = new Form(body);
    const d = readDisplacement(g);
    g.done();
    return d;
  })() : null;

  return tx(db, () => {
    const job = getJob(db, jobId);
    if (['operationally_complete', 'cancelled'].includes(job.op_status)) throw new DomainError(`${job.ref} is closed.`);
    const overlaps = overlappingAttendances(db, engineerId, start, end);
    const unhandled = overlaps.filter((o) => !displace.includes(o.id));
    if (unhandled.length) {
      throw new ConflictError(`Overlaps ${unhandled.map((o) => `${o.ref} (${o.job_ref})`).join(', ')}. Pick another time or displace that work with a recorded reason.`);
    }
    for (const o of overlaps) {
      if (o.status !== 'planned') throw new DomainError(`${o.ref} is already ${o.status}; in-progress work cannot be displaced from the schedule.`);
    }
    if (overlaps.length && !can(actor, 'schedule.displace')) throw new ForbiddenError('Your role cannot displace committed work.');
    // Displacement is its own recorded decision; remaining warnings need an acknowledged override.
    const signals = assignmentSignals(db, job, engineerId, start, end).filter((s) => s.code !== 'overlap');
    const warnings = signals.filter((s) => s.level === 'warn');
    if (signals.some((s) => s.code === 'not_engineer')) throw new DomainError('Selected user is not an active field engineer.');
    if (warnings.length) {
      if (!overrideAck || !overrideReason) {
        throw new DomainError(`Planning warnings need an acknowledged override with a reason: ${warnings.map((w) => w.text).join('; ')}`, { override_reason: 'Required to override warnings.' });
      }
      requireCap(actor, 'schedule.override');
    }
    for (const o of overlaps) {
      db.prepare(`UPDATE attendances SET status = 'cancelled', cancelled_reason = ?, version = version + 1 WHERE id = ?`).run(`Displaced by ${job.ref}: ${disp!.reason}`, o.id);
      applyDisplacement(db, actor, getAttendance(db, o.id), 'displaced', disp!, { displacingJobId: jobId });
      recomputeScheduleStatus(db, o.job_id);
    }
    const ref = nextRef(db, 'A', 20000);
    const now = clock.iso();
    const r = db
      .prepare(
        `INSERT INTO attendances (ref, job_id, engineer_user_id, status, commitment, planned_start, planned_end, instructions, warnings, override_reason, override_by, scheduled_by, scheduled_at, authority_basis, created_at)
         VALUES (?, ?, ?, 'planned', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ref,
        jobId,
        engineerId,
        commitment,
        start,
        end,
        instructions,
        warnings.length ? JSON.stringify(warnings.map((w) => w.text)) : null,
        warnings.length ? overrideReason : null,
        warnings.length ? actor.id : null,
        actor.id,
        now,
        job.authority_basis,
        now,
      );
    const id = Number(r.lastInsertRowid);
    if (job.op_status !== 'waiting' && job.op_status !== 'in_progress') recomputeScheduleStatus(db, jobId);
    audit(db, actor, 'attendance', id, 'scheduled', {
      reason: warnings.length ? overrideReason : null,
      after: { ref, job: job.ref, engineer: engineerId, planned_start: start, planned_end: end, commitment, overridden_warnings: warnings.map((w) => w.text) },
    });
    audit(db, actor, 'job', jobId, 'attendance_scheduled', { after: { attendance: ref, engineer: engineerId, planned_start: start, commitment } });
    notify(db, engineerId, 'schedule', `New ${commitment === 'customer_confirmed' ? 'confirmed' : 'provisional'} attendance ${ref} (${job.ref}) at ${job.site_name}`, `/my-day`);
    return id;
  });
}

export function confirmCommitment(db: DB, actor: Actor, attId: number, body: Record<string, unknown>) {
  requireCap(actor, 'schedule.assign');
  const f = new Form(body);
  const note = f.str('note', 'Who confirmed and how', 1000);
  f.done();
  tx(db, () => {
    const a = getAttendance(db, attId);
    if (a.status !== 'planned' && a.status !== 'dispatched') throw new DomainError('Only upcoming attendances can be confirmed.');
    if (a.commitment === 'customer_confirmed') throw new DomainError('Already customer-confirmed.');
    db.prepare(`UPDATE attendances SET commitment = 'customer_confirmed', version = version + 1 WHERE id = ?`).run(attId);
    audit(db, actor, 'attendance', attId, 'customer_confirmed', { reason: note, before: { commitment: a.commitment }, after: { commitment: 'customer_confirmed' } });
  });
}

/** Reschedules. Moving a customer-confirmed appointment requires the displacement record. */
export function rescheduleAttendance(db: DB, actor: Actor, attId: number, body: Record<string, unknown>) {
  requireCap(actor, 'schedule.assign');
  const f = new Form(body);
  const start = f.reqDt('planned_start', 'New start');
  const end = f.reqDt('planned_end', 'New end');
  const engineerId = f.int('engineer_user_id', 'Engineer');
  const reason = f.str('reason', 'Reason', 2000);
  const overrideAck = f.bool('override_ack');
  const overrideReason = f.opt('override_reason', 2000);
  const version = f.int('version', 'Version');
  f.check(!start || !end || end > start, 'planned_end', 'End must be after start.');
  f.done();
  tx(db, () => {
    const a = getAttendance(db, attId);
    if (version !== null && version !== a.version) throw new ConflictError(`${a.ref} was changed by someone else. Reload and try again.`);
    if (a.status !== 'planned') throw new DomainError(`${a.ref} is ${a.status}; only planned attendances can be moved.`);
    const eng = engineerId ?? a.engineer_user_id;
    const overlaps = overlappingAttendances(db, eng, start, end, attId);
    if (overlaps.length) throw new ConflictError(`New slot overlaps ${overlaps.map((o) => o.ref).join(', ')}.`);
    const job = getJob(db, a.job_id);
    const warnings = assignmentSignals(db, job, eng, start, end, attId).filter((s) => s.level === 'warn');
    if (warnings.length && (!overrideAck || !overrideReason)) {
      throw new DomainError(`Planning warnings need an acknowledged override with a reason: ${warnings.map((w) => w.text).join('; ')}`, { override_reason: 'Required.' });
    }
    if (a.commitment === 'customer_confirmed') {
      requireCap(actor, 'schedule.displace');
      const g = new Form(body);
      const d = readDisplacement(g);
      g.done();
      applyDisplacement(db, actor, a, 'rescheduled', { ...d, reason: `${reason} — ${d.reason}` }, { newStart: start, newEnd: end });
    }
    db.prepare(
      `UPDATE attendances SET planned_start = ?, planned_end = ?, engineer_user_id = ?, commitment = 'provisional', warnings = ?, override_reason = ?, override_by = ?, version = version + 1 WHERE id = ?`,
    ).run(start, end, eng, warnings.length ? JSON.stringify(warnings.map((w) => w.text)) : null, warnings.length ? overrideReason : null, warnings.length ? actor.id : null, attId);
    audit(db, actor, 'attendance', attId, 'rescheduled', {
      reason,
      before: { planned_start: a.planned_start, planned_end: a.planned_end, engineer: a.engineer_user_id, commitment: a.commitment },
      after: { planned_start: start, planned_end: end, engineer: eng, commitment: 'provisional' },
    });
    if (eng !== a.engineer_user_id) notify(db, eng, 'schedule', `${a.ref} (${a.job_ref}) assigned to you`, '/my-day');
  });
}

export function cancelAttendance(db: DB, actor: Actor, attId: number, body: Record<string, unknown>) {
  requireCap(actor, 'schedule.assign');
  const f = new Form(body);
  const reason = f.str('reason', 'Reason', 2000);
  f.done();
  tx(db, () => {
    const a = getAttendance(db, attId);
    if (a.status !== 'planned' && a.status !== 'dispatched') throw new DomainError(`${a.ref} is ${a.status} and cannot be cancelled from the schedule.`);
    if (a.commitment === 'customer_confirmed' || a.status === 'dispatched') {
      requireCap(actor, 'schedule.displace');
      const g = new Form(body);
      const d = readDisplacement(g);
      g.done();
      applyDisplacement(db, actor, a, 'cancelled', { ...d, reason: `${reason} — ${d.reason}` }, {});
    }
    db.prepare(`UPDATE attendances SET status = 'cancelled', cancelled_reason = ?, version = version + 1 WHERE id = ?`).run(reason, attId);
    recomputeScheduleStatus(db, a.job_id);
    audit(db, actor, 'attendance', attId, 'cancelled', { reason, before: { status: a.status } });
    notify(db, a.engineer_user_id, 'schedule', `${a.ref} cancelled: ${reason}`, '/my-day');
  });
}

/** Dispatch is a distinct step from scheduling (RULE-004) and records the SLA dispatched event. */
export function dispatchAttendance(db: DB, actor: Actor, attId: number) {
  requireCap(actor, 'schedule.assign');
  tx(db, () => {
    const a = getAttendance(db, attId);
    if (a.status !== 'planned') throw new DomainError(`${a.ref} is ${a.status}; only planned attendances can be dispatched.`);
    const job = getJob(db, a.job_id);
    if (job.op_status === 'waiting') {
      throw new DomainError(`${job.ref} is waiting on ${job.waiting_category ? WAITING_LABEL[job.waiting_category] : 'a dependency'}. Clear it before dispatching.`);
    }
    if (!isReady(job) && !a.override_reason) throw new DomainError(`${job.ref} is not ready and this attendance has no recorded override.`);
    const now = clock.iso();
    db.prepare(`UPDATE attendances SET status = 'dispatched', dispatched_at = ?, version = version + 1 WHERE id = ?`).run(now, attId);
    recordSlaEvent(db, actor, a.job_id, 'dispatched', now, { source: 'system', attendanceId: attId, note: `${a.ref} to ${a.engineer_name}` });
    recomputeScheduleStatus(db, a.job_id);
    audit(db, actor, 'attendance', attId, 'dispatched', { before: { status: 'planned' }, after: { status: 'dispatched' } });
    notify(db, a.engineer_user_id, 'dispatch', `${a.ref} dispatched: ${a.job_ref} ${a.site_name}`, `/attendances/${attId}`);
  });
}

// ------------------------------------------------------------------ board read model (US-030)

export function boardAttendances(db: DB, fromDate: string, toDateExclusive: string) {
  const from = londonDayStart(fromDate);
  const to = londonDayStart(toDateExclusive);
  return db
    .prepare(`${ATT_SELECT} WHERE a.status <> 'cancelled' AND a.planned_start < ? AND a.planned_end > ? ORDER BY a.planned_start`)
    .all(to, from) as (Attendance & { job_status: string; site_area: string | null })[];
}

export function readyUnscheduled(db: DB) {
  return db
    .prepare(
      `SELECT j.*, c.trading_name AS customer_name, s.name AS site_name, s.postcode AS site_postcode, s.area AS site_area
       FROM jobs j JOIN customers c ON c.id = j.customer_id JOIN sites s ON s.id = j.site_id
       WHERE j.op_status = 'ready' ORDER BY j.priority, j.received_at`,
    )
    .all() as Job[];
}

export function notReadyOpen(db: DB) {
  return db
    .prepare(
      `SELECT j.*, c.trading_name AS customer_name, s.name AS site_name, s.postcode AS site_postcode
       FROM jobs j JOIN customers c ON c.id = j.customer_id JOIN sites s ON s.id = j.site_id
       WHERE j.op_status IN ('new','triaged','authorised') ORDER BY j.priority, j.received_at`,
    )
    .all() as Job[];
}

export function displacementsForJob(db: DB, jobId: number) {
  return db
    .prepare(
      `SELECT d.*, a.ref AS attendance_ref, au.display_name AS authorised_by_name, co.display_name AS comms_owner_name, no.display_name AS new_owner_name, dj.ref AS displacing_job_ref
       FROM schedule_displacements d JOIN attendances a ON a.id = d.attendance_id JOIN users au ON au.id = d.authorised_by
       JOIN users co ON co.id = d.comms_owner_user_id JOIN users no ON no.id = d.new_owner_user_id LEFT JOIN jobs dj ON dj.id = d.displacing_job_id
       WHERE a.job_id = ? ORDER BY d.created_at DESC`,
    )
    .all(jobId) as {
    id: number;
    attendance_ref: string;
    change_type: string;
    previous_start: string;
    new_start: string | null;
    reason: string;
    authorised_by_name: string;
    comms_owner_name: string;
    comms_note: string;
    new_owner_name: string;
    new_next_action: string;
    review_at: string;
    displacing_job_ref: string | null;
    created_at: string;
  }[];
}
