import type { DB } from '../db/db.ts';
import { tx } from '../db/db.ts';
import { type Actor, requireCap } from '../auth/policy.ts';
import { audit, notify } from './audit.ts';
import { clock, MIN } from '../lib/clock.ts';
import { DomainError, NotFoundError } from '../lib/errors.ts';
import { Form } from '../lib/form.ts';

export const SLA_EVENT_TYPES = ['received', 'acknowledged', 'response', 'dispatched', 'attendance', 'diagnosis', 'restoration', 'resolution', 'closure'] as const;
export type SlaEventType = (typeof SLA_EVENT_TYPES)[number];
export const SLA_EVENT_LABEL: Record<SlaEventType, string> = {
  received: 'Request received',
  acknowledged: 'Acknowledged',
  response: 'Initial response',
  dispatched: 'Dispatched',
  attendance: 'Attendance (on site, able to begin)',
  diagnosis: 'Diagnosis',
  restoration: 'Service restored (may be temporary)',
  resolution: 'Resolution (agreed remedial outcome)',
  closure: 'Operational closure',
};
/** Events a coordinator may record by hand; field events come from the attendance flow. */
export const MANUAL_EVENT_TYPES: SlaEventType[] = ['acknowledged', 'response', 'diagnosis', 'restoration', 'resolution'];

export const CLOCK_STOP_REASONS = ['no_access', 'permit', 'customer_delay', 'unsafe_external', 'utilities', 'third_party', 'manufacturer', 'parts'] as const;
export const CLOCK_STOP_LABEL: Record<(typeof CLOCK_STOP_REASONS)[number], string> = {
  no_access: 'No access',
  permit: 'Permit / induction',
  customer_delay: 'Customer delay or authority',
  unsafe_external: 'Unsafe external condition',
  utilities: 'Utilities',
  third_party: 'Third party',
  manufacturer: 'Manufacturer decision',
  parts: 'Parts',
};

/** Back-dated manual entries beyond this need an explanatory note (no silent retro-edits, AC-021-04). */
const BACKDATE_TOLERANCE = 15 * MIN;

export interface SlaEvent {
  id: number;
  job_id: number;
  type: SlaEventType;
  occurred_at: string;
  recorded_at: string;
  recorded_by: number | null;
  recorded_by_name?: string | null;
  attendance_id: number | null;
  source: string;
  note: string | null;
  supersedes_id: number | null;
  superseded: number;
}

/** Internal append; callers are already inside a transaction and authorised. */
export function recordSlaEvent(
  db: DB,
  actor: Actor | null,
  jobId: number,
  type: SlaEventType,
  occurredAt: string,
  opts: { source?: 'manual' | 'system' | 'attendance'; note?: string | null; attendanceId?: number | null; supersedesId?: number | null } = {},
): number {
  const r = db
    .prepare(
      `INSERT INTO sla_events (job_id, type, occurred_at, recorded_at, recorded_by, attendance_id, source, note, supersedes_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(jobId, type, occurredAt, clock.iso(), actor?.id ?? null, opts.attendanceId ?? null, opts.source ?? 'system', opts.note ?? null, opts.supersedesId ?? null);
  return Number(r.lastInsertRowid);
}

/** Records the first occurrence of an event type only (e.g. first arrival = attendance). */
export function recordFirstSlaEvent(db: DB, actor: Actor | null, jobId: number, type: SlaEventType, occurredAt: string, opts: Parameters<typeof recordSlaEvent>[5] = {}) {
  const exists = db.prepare(`SELECT 1 FROM sla_events WHERE job_id = ? AND type = ? AND superseded = 0`).get(jobId, type);
  if (!exists) recordSlaEvent(db, actor, jobId, type, occurredAt, opts);
}

export function recordManualEvent(db: DB, actor: Actor, jobId: number, body: Record<string, unknown>) {
  requireCap(actor, 'sla.record');
  const f = new Form(body);
  const type = f.oneOf('type', 'Event', MANUAL_EVENT_TYPES as SlaEventType[]);
  const occurredAt = f.dt('occurred_at', 'When it happened', false) ?? clock.iso();
  const note = f.opt('note', 2000);
  f.done();
  const now = clock.now().getTime();
  const t = new Date(occurredAt).getTime();
  if (t > now + MIN) throw new DomainError('Events cannot be recorded in the future.', { occurred_at: 'In the future.' });
  if (now - t > BACKDATE_TOLERANCE && !note) {
    throw new DomainError('Recording an event more than 15 minutes after it happened requires a note explaining the late entry.', { note: 'Explain the late entry.' });
  }
  tx(db, () => {
    const job = db.prepare('SELECT id, received_at FROM jobs WHERE id = ?').get(jobId) as { id: number; received_at: string } | undefined;
    if (!job) throw new NotFoundError('Job');
    if (occurredAt < job.received_at) throw new DomainError('An event cannot precede the request being received.');
    const id = recordSlaEvent(db, actor, jobId, type, occurredAt, { source: 'manual', note });
    audit(db, actor, 'job', jobId, 'sla_event_recorded', { reason: note, after: { event_id: id, type, occurred_at: occurredAt, backdated: now - t > BACKDATE_TOLERANCE } });
  });
}

/** Corrections append a replacement and mark the original superseded; both stay visible. */
export function supersedeEvent(db: DB, actor: Actor, eventId: number, body: Record<string, unknown>) {
  requireCap(actor, 'sla.record');
  const f = new Form(body);
  const occurredAt = f.reqDt('occurred_at', 'Corrected time');
  const reason = f.str('reason', 'Reason for correction', 2000);
  f.done();
  tx(db, () => {
    const ev = db.prepare('SELECT * FROM sla_events WHERE id = ?').get(eventId) as SlaEvent | undefined;
    if (!ev) throw new NotFoundError('SLA event');
    if (ev.superseded) throw new DomainError('That event has already been corrected.');
    if (ev.type === 'received' || ev.type === 'closure') {
      // Intake/closure timestamps anchor the clock; correcting them is allowed but always audited.
    }
    if (new Date(occurredAt).getTime() > clock.now().getTime() + MIN) throw new DomainError('Corrected time cannot be in the future.');
    db.prepare('UPDATE sla_events SET superseded = 1 WHERE id = ?').run(eventId);
    const newId = recordSlaEvent(db, actor, ev.job_id, ev.type, occurredAt, { source: 'manual', note: `Correction: ${reason}`, supersedesId: eventId, attendanceId: ev.attendance_id });
    if (ev.type === 'received') db.prepare('UPDATE jobs SET received_at = ?, version = version + 1 WHERE id = ?').run(occurredAt, ev.job_id);
    audit(db, actor, 'job', ev.job_id, 'sla_event_corrected', { reason, before: { event_id: eventId, type: ev.type, occurred_at: ev.occurred_at }, after: { event_id: newId, occurred_at: occurredAt } });
  });
}

export interface ClockStop {
  id: number;
  job_id: number;
  reason_category: (typeof CLOCK_STOP_REASONS)[number];
  contractual_basis: string;
  dependency_detail: string;
  evidence: string;
  expected_actor: string;
  owner_user_id: number;
  owner_name?: string;
  chase_at: string;
  started_at: string;
  started_by: number;
  started_by_name?: string;
  ended_at: string | null;
  ended_by: number | null;
  ended_by_name?: string | null;
  end_note: string | null;
}

/**
 * Starts a clock stop (FR-008, RULE-003). Only where the contract permits, with a genuine
 * dependency, evidence, expected actor, FrostLine owner and chase point. The start time is the
 * server's "now": stops cannot be added retrospectively.
 */
export function startClockStop(db: DB, actor: Actor, jobId: number, body: Record<string, unknown>) {
  requireCap(actor, 'sla.clockstop');
  const f = new Form(body);
  const data = {
    reason_category: f.oneOf('reason_category', 'Dependency type', CLOCK_STOP_REASONS),
    contractual_basis: f.str('contractual_basis', 'Contract clause / basis', 1000),
    dependency_detail: f.str('dependency_detail', 'Blocking dependency', 2000),
    evidence: f.str('evidence', 'Evidence', 2000),
    expected_actor: f.str('expected_actor', 'Who must act', 300),
    owner_user_id: f.reqInt('owner_user_id', 'FrostLine owner'),
    chase_at: f.reqDt('chase_at', 'Chase point'),
  };
  f.done();
  if (data.chase_at <= clock.iso()) throw new DomainError('Chase point must be in the future.', { chase_at: 'Must be in the future.' });
  tx(db, () => {
    const job = db
      .prepare(`SELECT j.id, j.ref, j.op_status, k.clock_stop_permitted, k.ref AS contract_ref FROM jobs j LEFT JOIN contracts k ON k.id = j.contract_id WHERE j.id = ?`)
      .get(jobId) as { id: number; ref: string; op_status: string; clock_stop_permitted: number | null; contract_ref: string | null } | undefined;
    if (!job) throw new NotFoundError('Job');
    if (!job.contract_ref) throw new DomainError('This job has no service contract, so there is no contractual SLA clock to stop.');
    if (!job.clock_stop_permitted) throw new DomainError(`Contract ${job.contract_ref} does not permit clock stops.`);
    if (['operationally_complete', 'cancelled'].includes(job.op_status)) throw new DomainError('Job is closed.');
    const open = db.prepare('SELECT 1 FROM clock_stops WHERE job_id = ? AND ended_at IS NULL').get(jobId);
    if (open) throw new DomainError('A clock stop is already running for this job.');
    const now = clock.iso();
    const r = db
      .prepare(
        `INSERT INTO clock_stops (job_id, reason_category, contractual_basis, dependency_detail, evidence, expected_actor, owner_user_id, chase_at, started_at, started_by)
         VALUES (@job_id, @reason_category, @contractual_basis, @dependency_detail, @evidence, @expected_actor, @owner_user_id, @chase_at, @now, @actor)`,
      )
      .run({ ...data, job_id: jobId, now, actor: actor.id });
    audit(db, actor, 'job', jobId, 'clock_stopped', { reason: data.dependency_detail, after: { clock_stop_id: Number(r.lastInsertRowid), ...data, started_at: now } });
    if (data.owner_user_id !== actor.id) notify(db, data.owner_user_id, 'clock_stop', `${job.ref}: SLA clock stopped — chase ${data.expected_actor}`, `/jobs/${jobId}`);
  });
}

export function endClockStop(db: DB, actor: Actor, stopId: number, body: Record<string, unknown>) {
  requireCap(actor, 'sla.clockstop');
  const f = new Form(body);
  const note = f.str('end_note', 'Restart reason', 2000);
  f.done();
  tx(db, () => {
    const s = db.prepare('SELECT * FROM clock_stops WHERE id = ?').get(stopId) as ClockStop | undefined;
    if (!s) throw new NotFoundError('Clock stop');
    if (s.ended_at) throw new DomainError('Clock already restarted.');
    const now = clock.iso();
    db.prepare('UPDATE clock_stops SET ended_at = ?, ended_by = ?, end_note = ? WHERE id = ?').run(now, actor.id, note, stopId);
    audit(db, actor, 'job', s.job_id, 'clock_restarted', { reason: note, before: { clock_stop_id: stopId, started_at: s.started_at }, after: { ended_at: now } });
  });
}

export function slaEvents(db: DB, jobId: number): SlaEvent[] {
  return db
    .prepare(`SELECT e.*, u.display_name AS recorded_by_name FROM sla_events e LEFT JOIN users u ON u.id = e.recorded_by WHERE e.job_id = ? ORDER BY e.occurred_at, e.id`)
    .all(jobId) as SlaEvent[];
}

export function clockStops(db: DB, jobId: number): ClockStop[] {
  return db
    .prepare(
      `SELECT cs.*, o.display_name AS owner_name, sb.display_name AS started_by_name, eb.display_name AS ended_by_name
       FROM clock_stops cs JOIN users o ON o.id = cs.owner_user_id JOIN users sb ON sb.id = cs.started_by LEFT JOIN users eb ON eb.id = cs.ended_by
       WHERE cs.job_id = ? ORDER BY cs.started_at`,
    )
    .all(jobId) as ClockStop[];
}

export type TargetState = 'met' | 'missed' | 'breached' | 'at_risk' | 'on_track' | 'no_target';
export interface TargetStatus {
  measure: 'response' | 'attendance' | 'resolution';
  label: string;
  targetMinutes: number | null;
  dueAt: string | null;
  metAt: string | null;
  state: TargetState;
  pausedMinutes: number;
}

export function atRiskFraction(db: DB): number {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'sla_at_risk_fraction'`).get() as { value: string } | undefined;
  const v = row ? parseFloat(row.value) : 0.25;
  return Number.isFinite(v) && v > 0 && v < 1 ? v : 0.25;
}

/**
 * Derives SLA status from recorded events and contract targets (never from updated_at, ADR-003).
 * Due time is extended by the duration of permitted clock stops.
 */
export function computeSla(
  db: DB,
  job: { id: number; contract_id: number | null; priority: string; received_at: string },
  now = clock.now(),
): TargetStatus[] {
  const targets = job.contract_id
    ? (db.prepare('SELECT * FROM contract_targets WHERE contract_id = ? AND priority = ?').get(job.contract_id, job.priority) as
        | { response_minutes: number | null; attendance_minutes: number | null; resolution_minutes: number | null }
        | undefined)
    : undefined;
  const events = db.prepare(`SELECT type, MIN(occurred_at) AS first FROM sla_events WHERE job_id = ? AND superseded = 0 GROUP BY type`).all(job.id) as { type: string; first: string }[];
  const firstOf = Object.fromEntries(events.map((e) => [e.type, e.first]));
  const stops = db.prepare('SELECT started_at, ended_at FROM clock_stops WHERE job_id = ?').all(job.id) as { started_at: string; ended_at: string | null }[];
  const fraction = atRiskFraction(db);
  const received = new Date(job.received_at).getTime();

  const measures: [TargetStatus['measure'], string, number | null | undefined, string][] = [
    ['response', 'Initial response', targets?.response_minutes, 'response'],
    ['attendance', 'Attendance', targets?.attendance_minutes, 'attendance'],
    ['resolution', 'Resolution', targets?.resolution_minutes, 'resolution'],
  ];
  return measures.map(([measure, label, target, evType]) => {
    const metAt: string | null = firstOf[evType] ?? (measure === 'response' ? (firstOf['attendance'] ?? null) : null);
    if (!target) return { measure, label, targetMinutes: null, dueAt: null, metAt, state: 'no_target' as const, pausedMinutes: 0 };
    // Pauses only count while the clock would otherwise be running (before the event was met).
    const horizon = metAt ? new Date(metAt).getTime() : now.getTime();
    let paused = 0;
    for (const s of stops) {
      const a = new Date(s.started_at).getTime();
      const b = s.ended_at ? new Date(s.ended_at).getTime() : now.getTime();
      const lo = Math.max(a, received);
      const hi = Math.min(b, horizon);
      if (hi > lo) paused += hi - lo;
    }
    const due = received + target * MIN + paused;
    const dueAt = new Date(due).toISOString();
    let state: TargetState;
    if (metAt) state = new Date(metAt).getTime() <= due ? 'met' : 'missed';
    else if (now.getTime() > due) state = 'breached';
    else if (due - now.getTime() <= target * MIN * fraction) state = 'at_risk';
    else state = 'on_track';
    return { measure, label, targetMinutes: target, dueAt, metAt, state, pausedMinutes: Math.round(paused / MIN) };
  });
}
