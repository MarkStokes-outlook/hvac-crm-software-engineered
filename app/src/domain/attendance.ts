import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from '../db/db.ts';
import { tx } from '../db/db.ts';
import { type Actor, requireCap } from '../auth/policy.ts';
import { audit, notify } from './audit.ts';
import { clock, DAY } from '../lib/clock.ts';
import { DomainError, ForbiddenError, NotFoundError } from '../lib/errors.ts';
import { Form } from '../lib/form.ts';
import { getJob, WAITING_CATEGORIES, WAITING_LABEL, AUTHORITY_BASES } from './jobs.ts';
import { type Attendance, getAttendance } from './scheduling.ts';
import { recordFirstSlaEvent } from './sla.ts';

export interface OutcomeCode {
  code: string;
  label: string;
  requires_followon: number;
  temporary: number;
  resolves: number;
}

export function outcomeCodes(db: DB): OutcomeCode[] {
  return db.prepare(`SELECT * FROM outcome_codes WHERE active = 1 ORDER BY sort, label`).all() as OutcomeCode[];
}

export const FINAL_CONDITIONS = ['operating_normally', 'operating_limited', 'made_safe_isolated', 'not_operating', 'unknown'] as const;
export const FINAL_CONDITION_LABEL: Record<(typeof FINAL_CONDITIONS)[number], string> = {
  operating_normally: 'Operating normally',
  operating_limited: 'Operating with limitations',
  made_safe_isolated: 'Made safe / isolated',
  not_operating: 'Not operating',
  unknown: 'Unknown / not verified',
};

export const STOP_KINDS = ['stop_unsafe', 'stop_competence', 'escalate_scope', 'escalate_access', 'escalate_equipment', 'escalate_time', 'escalate_authority', 'other'] as const;
export const STOP_LABEL: Record<(typeof STOP_KINDS)[number], string> = {
  stop_unsafe: 'Stop — unsafe to continue',
  stop_competence: 'Stop — outside my competence',
  escalate_scope: 'Escalate — scope gap',
  escalate_access: 'Escalate — access / permit problem',
  escalate_equipment: 'Escalate — tools / equipment / parts',
  escalate_time: 'Escalate — duration / working time',
  escalate_authority: 'Escalate — authority / spend needed',
  other: 'Escalate — other',
};

/** Only the assigned engineer executes an attendance (AC-002-02). */
function requireAssigned(actor: Actor, a: Attendance) {
  requireCap(actor, 'attendance.execute');
  if (a.engineer_user_id !== actor.id) throw new ForbiddenError('This attendance is assigned to another engineer.');
}

type Step = 'travel' | 'arrive' | 'start_work';
const STEP: Record<Step, { from: Attendance['status'][]; to: Attendance['status']; col: string; label: string }> = {
  travel: { from: ['dispatched'], to: 'travelling', col: 'travel_started_at', label: 'travel_started' },
  arrive: { from: ['dispatched', 'travelling'], to: 'on_site', col: 'arrived_at', label: 'arrived' },
  start_work: { from: ['on_site'], to: 'working', col: 'work_started_at', label: 'work_started' },
};

/** Field progress events use the server clock (AC-041-01). */
export function progressAttendance(db: DB, actor: Actor, attId: number, step: Step) {
  const def = STEP[step];
  if (!def) throw new DomainError('Unknown step.');
  tx(db, () => {
    const a = getAttendance(db, attId);
    requireAssigned(actor, a);
    if (a.status === 'planned') throw new DomainError('Not dispatched yet — contact the service desk before travelling.');
    if (!def.from.includes(a.status)) throw new DomainError(`Cannot ${step.replace('_', ' ')} while ${a.status.replace('_', ' ')}.`);
    const now = clock.iso();
    db.prepare(`UPDATE attendances SET status = ?, ${def.col} = ?, version = version + 1 WHERE id = ?`).run(def.to, now, attId);
    if (step === 'arrive') {
      recordFirstSlaEvent(db, actor, a.job_id, 'attendance', now, { source: 'attendance', attendanceId: attId, note: `${a.engineer_name} on site` });
      const j = getJob(db, a.job_id);
      if (['scheduled', 'dispatched', 'ready', 'authorised', 'triaged', 'new'].includes(j.op_status)) {
        db.prepare(`UPDATE jobs SET op_status = 'in_progress', updated_at = ?, version = version + 1 WHERE id = ?`).run(now, a.job_id);
      }
    }
    audit(db, actor, 'attendance', attId, def.label, { before: { status: a.status }, after: { status: def.to, at: now } });
  });
}

/** Stop/escalate is always available to the assigned engineer (AC-041-02, Q015). */
export function raiseStop(db: DB, actor: Actor, attId: number, body: Record<string, unknown>) {
  const f = new Form(body);
  const kind = f.oneOf('kind', 'Type', STOP_KINDS);
  const detail = f.str('detail', 'What is wrong', 4000);
  const safety = f.opt('safety_condition', 2000);
  if (kind === 'stop_unsafe') f.check(safety, 'safety_condition', 'Describe the current safety/operating condition.');
  f.done();
  return tx(db, () => {
    const a = getAttendance(db, attId);
    requireAssigned(actor, a);
    if (a.status === 'submitted' || a.status === 'cancelled') throw new DomainError('Attendance is closed.');
    const now = clock.iso();
    const r = db
      .prepare(`INSERT INTO attendance_stops (attendance_id, kind, detail, safety_condition, raised_by, raised_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(attId, kind, detail, safety, actor.id, now);
    const job = getJob(db, a.job_id);
    audit(db, actor, 'attendance', attId, 'stop_raised', { reason: detail, after: { kind, safety_condition: safety } });
    audit(db, actor, 'job', a.job_id, 'engineer_escalation', { reason: detail, after: { attendance: a.ref, kind } });
    const recipients = new Set<number>();
    if (job.coordinator_user_id) recipients.add(job.coordinator_user_id);
    if (job.next_owner_user_id) recipients.add(job.next_owner_user_id);
    if (!recipients.size) {
      for (const u of db.prepare(`SELECT id FROM users WHERE role IN ('coordinator') AND active = 1`).all() as { id: number }[]) recipients.add(u.id);
    }
    for (const u of recipients) notify(db, u, 'escalation', `${a.ref} ${STOP_LABEL[kind]}: ${detail.slice(0, 120)}`, `/jobs/${a.job_id}`);
    return Number(r.lastInsertRowid);
  });
}

export function resolveStop(db: DB, actor: Actor, stopId: number, body: Record<string, unknown>) {
  requireCap(actor, 'escalation.resolve');
  const f = new Form(body);
  const resolution = f.str('resolution', 'Decision / resolution', 4000);
  f.done();
  tx(db, () => {
    const s = db.prepare(`SELECT st.*, a.job_id FROM attendance_stops st JOIN attendances a ON a.id = st.attendance_id WHERE st.id = ?`).get(stopId) as
      | { id: number; job_id: number; attendance_id: number; resolved_at: string | null; kind: string }
      | undefined;
    if (!s) throw new NotFoundError('Escalation');
    if (s.resolved_at) throw new DomainError('Already resolved.');
    db.prepare(`UPDATE attendance_stops SET resolved_at = ?, resolved_by = ?, resolution = ? WHERE id = ?`).run(clock.iso(), actor.id, resolution, stopId);
    audit(db, actor, 'job', s.job_id, 'escalation_resolved', { reason: resolution, after: { stop_id: stopId, kind: s.kind } });
    const eng = db.prepare('SELECT engineer_user_id, ref FROM attendances WHERE id = ?').get(s.attendance_id) as { engineer_user_id: number; ref: string };
    notify(db, eng.engineer_user_id, 'escalation', `${eng.ref}: office responded — ${resolution.slice(0, 120)}`, `/attendances/${s.attendance_id}`);
  });
}

export function stopsFor(db: DB, where: { attendanceId?: number; jobId?: number }) {
  const sql = `SELECT st.*, a.ref AS attendance_ref, ru.display_name AS raised_by_name, rv.display_name AS resolved_by_name
    FROM attendance_stops st JOIN attendances a ON a.id = st.attendance_id JOIN users ru ON ru.id = st.raised_by LEFT JOIN users rv ON rv.id = st.resolved_by
    WHERE ${where.attendanceId ? 'st.attendance_id = ?' : 'a.job_id = ?'} ORDER BY st.raised_at DESC`;
  return db.prepare(sql).all(where.attendanceId ?? where.jobId) as {
    id: number;
    attendance_ref: string;
    kind: (typeof STOP_KINDS)[number];
    detail: string;
    safety_condition: string | null;
    raised_by_name: string;
    raised_at: string;
    resolved_at: string | null;
    resolved_by_name: string | null;
    resolution: string | null;
  }[];
}

export function addReading(db: DB, actor: Actor, attId: number, body: Record<string, unknown>) {
  const f = new Form(body);
  const name = f.str('name', 'Reading', 200);
  const value = f.str('value', 'Value', 100);
  const unit = f.opt('unit', 30);
  const assetId = f.int('asset_id', 'Equipment');
  f.done();
  tx(db, () => {
    const a = getAttendance(db, attId);
    requireAssigned(actor, a);
    if (!['on_site', 'working'].includes(a.status)) throw new DomainError('Readings are recorded while on site.');
    if (assetId && !db.prepare('SELECT 1 FROM job_assets WHERE job_id = ? AND asset_id = ?').get(a.job_id, assetId)) {
      const siteMatch = db.prepare('SELECT 1 FROM assets x JOIN jobs j ON j.site_id = x.site_id WHERE x.id = ? AND j.id = ?').get(assetId, a.job_id);
      if (!siteMatch) throw new DomainError('Equipment is not at this site.');
    }
    db.prepare(`INSERT INTO readings (attendance_id, asset_id, name, value, unit, recorded_at) VALUES (?, ?, ?, ?, ?, ?)`).run(attId, assetId, name, value, unit, clock.iso());
    audit(db, actor, 'attendance', attId, 'reading_recorded', { after: { name, value, unit, asset_id: assetId } });
  });
}

export function readingsFor(db: DB, attId: number) {
  return db
    .prepare(`SELECT r.*, x.ref AS asset_ref FROM readings r LEFT JOIN assets x ON x.id = r.asset_id WHERE r.attendance_id = ? ORDER BY r.recorded_at`)
    .all(attId) as { id: number; name: string; value: string; unit: string | null; asset_ref: string | null; recorded_at: string }[];
}

export const EVIDENCE_KINDS = ['photo', 'certificate', 'document', 'commissioning', 'other'] as const;
const ALLOWED_MIME = /^(image\/(jpeg|png|webp|heic|heif|gif)|application\/pdf|text\/plain)$/;

/**
 * Stores evidence metadata durably and, when supplied, the file content under a
 * content-addressed name (ADR-007). The DB row is written only after the file is safely on disk.
 */
export function addEvidence(
  db: DB,
  actor: Actor,
  uploadDir: string,
  attId: number,
  body: Record<string, unknown>,
  file?: { originalname: string; mimetype: string; buffer: Buffer; size: number },
) {
  const f = new Form(body);
  const kind = f.oneOf('kind', 'Evidence type', EVIDENCE_KINDS);
  const caption = f.str('caption', 'Caption', 500);
  f.done();
  const a = getAttendance(db, attId);
  requireAssigned(actor, a);
  if (a.status === 'cancelled') throw new DomainError('Attendance is cancelled.');
  let stored: { path: string; sha: string } | null = null;
  if (file && file.size > 0) {
    if (!ALLOWED_MIME.test(file.mimetype)) throw new DomainError('Only photos (JPEG/PNG/WebP/HEIC), PDF or text files can be attached.');
    const sha = crypto.createHash('sha256').update(file.buffer).digest('hex');
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 6);
    fs.mkdirSync(uploadDir, { recursive: true });
    const rel = `${sha}${ext}`;
    const full = path.join(uploadDir, rel);
    if (!fs.existsSync(full)) {
      const tmp = `${full}.${process.pid}.tmp`;
      const fd = fs.openSync(tmp, 'w');
      fs.writeSync(fd, file.buffer);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fs.renameSync(tmp, full);
    }
    stored = { path: rel, sha };
  }
  tx(db, () => {
    const r = db
      .prepare(
        `INSERT INTO evidence (job_id, attendance_id, kind, caption, file_name, stored_path, mime_type, size_bytes, sha256, captured_by, captured_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(a.job_id, attId, kind, caption, file?.originalname ?? null, stored?.path ?? null, file?.mimetype ?? null, file?.size ?? null, stored?.sha ?? null, actor.id, clock.iso());
    audit(db, actor, 'attendance', attId, 'evidence_added', { after: { evidence_id: Number(r.lastInsertRowid), kind, caption, sha256: stored?.sha ?? null } });
  });
}

export function evidenceFor(db: DB, where: { attendanceId?: number; jobId?: number }) {
  return db
    .prepare(
      `SELECT e.*, u.display_name AS captured_by_name, a.ref AS attendance_ref FROM evidence e JOIN users u ON u.id = e.captured_by LEFT JOIN attendances a ON a.id = e.attendance_id
       WHERE ${where.attendanceId ? 'e.attendance_id = ?' : 'e.job_id = ?'} ORDER BY e.captured_at DESC`,
    )
    .all(where.attendanceId ?? where.jobId) as {
    id: number;
    kind: string;
    caption: string;
    file_name: string | null;
    stored_path: string | null;
    mime_type: string | null;
    size_bytes: number | null;
    sha256: string | null;
    captured_by_name: string;
    captured_at: string;
    attendance_ref: string | null;
  }[];
}

export function materialsFor(db: DB, where: { attendanceId?: number; jobId?: number }) {
  return db
    .prepare(
      `SELECT m.*, i.sku, a.ref AS attendance_ref FROM attendance_materials m JOIN attendances a ON a.id = m.attendance_id LEFT JOIN stock_items i ON i.id = m.item_id
       WHERE ${where.attendanceId ? 'm.attendance_id = ?' : 'a.job_id = ?'} ORDER BY m.recorded_at`,
    )
    .all(where.attendanceId ?? where.jobId) as { id: number; description: string; qty: number; source: string; sku: string | null; attendance_ref: string; recorded_at: string }[];
}

/** Non-stock materials (purchased direct, customer supplied). Stock use goes through inventory.issueToAttendance. */
export function addDirectMaterial(db: DB, actor: Actor, attId: number, body: Record<string, unknown>) {
  const f = new Form(body);
  const description = f.str('description', 'Material', 300);
  const qty = f.reqInt('qty', 'Quantity', { min: 1, max: 10000 });
  const source = f.oneOf('source', 'Source', ['purchased_direct', 'customer_supplied', 'other'] as const);
  f.done();
  tx(db, () => {
    const a = getAttendance(db, attId);
    requireAssigned(actor, a);
    if (!['on_site', 'working'].includes(a.status)) throw new DomainError('Materials are recorded while on site.');
    db.prepare(`INSERT INTO attendance_materials (attendance_id, description, qty, source, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
      attId,
      description,
      qty,
      source,
      actor.id,
      clock.iso(),
    );
    audit(db, actor, 'attendance', attId, 'material_recorded', { after: { description, qty, source } });
  });
}

/**
 * Submits the attendance outcome (US-041/042/043).
 * - separates reported / observed / tests / diagnosis / work / final condition / uncertainty (Q018)
 * - temporary restoration demands limits, residual risk, review, approver and permanent owner (FR-017)
 * - incomplete work demands a controlled handoff with dependency, owner and review (RULE-005)
 * - customer acknowledgement is stored but is not approval (RULE-006)
 * - never closes the job (RULE-001): the job goes to an explicit waiting state for the office
 * - idempotent on submit_key so a refresh/retry cannot duplicate the submission (NFR-003)
 */
export function submitAttendance(db: DB, actor: Actor, attId: number, body: Record<string, unknown>): { duplicate: boolean } {
  const f = new Form(body);
  const submitKey = f.str('submit_key', 'Submission key', 100);
  const codes = outcomeCodes(db);
  const outcome = f.oneOf('outcome', 'Outcome', codes.map((c) => c.code));
  const code = codes.find((c) => c.code === outcome);
  const d = {
    authority_basis: f.oneOf('authority_basis', 'Authority basis used', AUTHORITY_BASES),
    reported_confirmed: f.opt('reported_confirmed'),
    observed_facts: f.str('observed_facts', 'Observed facts', 8000),
    tests_performed: f.opt('tests_performed'),
    diagnosis: f.opt('diagnosis'),
    diagnosis_verified: f.bool('diagnosis_verified') ? 1 : 0,
    work_done: f.opt('work_done'),
    final_condition: f.oneOf('final_condition', 'Final condition', FINAL_CONDITIONS),
    safety_notes: f.opt('safety_notes'),
    uncertainty: f.opt('uncertainty'),
    recommendations: f.opt('recommendations'),
    labour_minutes: f.reqInt('labour_minutes', 'Labour time (minutes)', { min: 0, max: 24 * 60 }),
    travel_minutes: f.int('travel_minutes', 'Travel time (minutes)', { min: 0, max: 24 * 60 }),
    ack_name: f.opt('ack_name', 200),
    ack_role: f.opt('ack_role', 200),
    ack_comment: f.opt('ack_comment', 2000),
    ack_not_obtained_reason: f.opt('ack_not_obtained_reason', 1000),
  };
  if (d.diagnosis_verified) f.check(d.diagnosis, 'diagnosis', 'A verified diagnosis needs the diagnosis text.');
  if (outcome !== 'no_access') f.check(d.work_done, 'work_done', 'Record the work carried out (or "none").');
  f.check(d.ack_name || d.ack_not_obtained_reason, 'ack_name', 'Record who acknowledged the attendance, or why acknowledgement was not obtained.');
  const followon = !!code?.requires_followon || !!code?.temporary || f.bool('followon_required');
  const h = {
    handoff_required_outcome: followon ? f.str('handoff_required_outcome', 'Required outcome', 2000) : f.opt('handoff_required_outcome'),
    handoff_dependency: followon ? f.oneOf('handoff_dependency', 'Exact dependency', WAITING_CATEGORIES) : null,
    handoff_dependency_detail: followon ? f.str('handoff_dependency_detail', 'Dependency detail', 2000) : null,
    handoff_operating_condition: followon ? f.str('handoff_operating_condition', 'Safety / operating condition left', 2000) : null,
    handoff_parts_specialist: f.opt('handoff_parts_specialist'),
    handoff_promises: f.opt('handoff_promises'),
    handoff_urgency: followon ? f.oneOf('handoff_urgency', 'Urgency', ['P1', 'P2', 'P3', 'P4'] as const) : null,
    handoff_authority: f.opt('handoff_authority'),
    handoff_next_owner_user_id: followon ? f.reqInt('handoff_next_owner_user_id', 'Recommended next owner') : null,
  };
  const handoffReview = followon ? f.reqDt('handoff_review_at', 'Review / chase by') : null;
  const temp = code?.temporary
    ? {
        change_made: f.str('temp_change_made', 'Temporary change made', 2000),
        reason: f.str('temp_reason', 'Reason for temporary measure', 2000),
        service_restored: f.str('temp_service_restored', 'Service restored', 2000),
        limitations: f.str('temp_limitations', 'Limitations', 2000),
        residual_risk: f.str('temp_residual_risk', 'Residual risk', 2000),
        monitoring: f.opt('temp_monitoring', 2000),
        review_at: f.reqDt('temp_review_at', 'Review / expiry'),
        customer_understanding: f.str('temp_customer_understanding', 'Customer understanding', 2000),
        approver: f.str('temp_approver', 'Approved by', 200),
        permanent_owner_user_id: f.reqInt('temp_permanent_owner_user_id', 'Permanent-resolution owner'),
      }
    : null;
  f.done();

  return tx(db, () => {
    const prior = db.prepare('SELECT id FROM attendances WHERE submit_key = ?').get(submitKey) as { id: number } | undefined;
    if (prior) {
      if (prior.id !== attId) throw new DomainError('Submission key conflict.');
      return { duplicate: true };
    }
    const a = getAttendance(db, attId);
    requireAssigned(actor, a);
    if (a.status === 'submitted') throw new DomainError(`${a.ref} has already been submitted.`);
    if (!['on_site', 'working'].includes(a.status)) throw new DomainError('Record arrival on site before submitting an outcome.');
    const job = getJob(db, a.job_id);
    const now = clock.iso();
    for (const uid of [h.handoff_next_owner_user_id, temp?.permanent_owner_user_id]) {
      if (uid && !db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(uid)) throw new DomainError('Selected owner is not an active user.');
    }
    db.prepare(
      `UPDATE attendances SET status = 'submitted', submitted_at = @now, work_ended_at = COALESCE(work_ended_at, @now), outcome = @outcome,
         authority_basis = @authority_basis, reported_confirmed = @reported_confirmed, observed_facts = @observed_facts, tests_performed = @tests_performed,
         diagnosis = @diagnosis, diagnosis_verified = @diagnosis_verified, work_done = @work_done, final_condition = @final_condition, safety_notes = @safety_notes,
         uncertainty = @uncertainty, recommendations = @recommendations, labour_minutes = @labour_minutes, travel_minutes = @travel_minutes,
         followon_required = @followon, handoff_required_outcome = @handoff_required_outcome, handoff_dependency = @handoff_dependency,
         handoff_dependency_detail = @handoff_dependency_detail, handoff_operating_condition = @handoff_operating_condition,
         handoff_parts_specialist = @handoff_parts_specialist, handoff_promises = @handoff_promises, handoff_urgency = @handoff_urgency,
         handoff_authority = @handoff_authority, handoff_next_owner_user_id = @handoff_next_owner_user_id,
         ack_name = @ack_name, ack_role = @ack_role, ack_at = @ack_at, ack_comment = @ack_comment, ack_not_obtained_reason = @ack_not_obtained_reason,
         submit_key = @submitKey, version = version + 1
       WHERE id = @id`,
    ).run({ ...d, ...h, outcome, followon: followon ? 1 : 0, ack_at: d.ack_name ? now : null, now, submitKey, id: attId });

    // SLA events derived from the engineer's attested outcome; office can correct via supersede.
    if (d.diagnosis_verified) recordFirstSlaEvent(db, actor, a.job_id, 'diagnosis', now, { source: 'attendance', attendanceId: attId, note: d.diagnosis });
    if ((d.final_condition === 'operating_normally' || d.final_condition === 'operating_limited') && outcome !== 'no_access' && outcome !== 'no_fault_found') {
      recordFirstSlaEvent(db, actor, a.job_id, 'restoration', now, { source: 'attendance', attendanceId: attId, note: code?.temporary ? 'Temporary restoration' : null });
    }
    if (code?.resolves && d.final_condition === 'operating_normally' && !followon) {
      recordFirstSlaEvent(db, actor, a.job_id, 'resolution', now, { source: 'attendance', attendanceId: attId, note: 'Attested by engineer; office to confirm' });
    }

    if (temp) {
      db.prepare(
        `INSERT INTO temporary_restorations (job_id, attendance_id, change_made, reason, service_restored, limitations, residual_risk, monitoring, review_at,
           customer_understanding, approver, permanent_owner_user_id, created_at)
         VALUES (@job_id, @attendance_id, @change_made, @reason, @service_restored, @limitations, @residual_risk, @monitoring, @review_at,
           @customer_understanding, @approver, @permanent_owner_user_id, @now)`,
      ).run({ ...temp, job_id: a.job_id, attendance_id: attId, now });
      notify(db, temp.permanent_owner_user_id, 'temporary_restoration', `${job.ref}: temporary restoration — you own the permanent resolution (review ${temp.review_at.slice(0, 10)})`, `/jobs/${a.job_id}`);
    }

    // The job never closes here (RULE-001). It waits on an explicit dependency with an owner.
    const otherPlanned = db.prepare(`SELECT COUNT(*) n FROM attendances WHERE job_id = ? AND id <> ? AND status IN ('planned','dispatched','travelling','on_site','working')`).get(a.job_id, attId) as { n: number };
    let jobUpdate: Record<string, unknown>;
    if (followon) {
      jobUpdate = {
        op_status: 'waiting',
        waiting_category: h.handoff_dependency,
        waiting_detail: h.handoff_dependency_detail,
        next_action: h.handoff_required_outcome,
        next_owner_user_id: h.handoff_next_owner_user_id,
        review_at: handoffReview,
      };
    } else if (otherPlanned.n) {
      jobUpdate = { op_status: job.op_status === 'in_progress' ? 'scheduled' : job.op_status };
    } else {
      const owner = job.coordinator_user_id ?? (db.prepare(`SELECT id FROM users WHERE role = 'coordinator' AND active = 1 ORDER BY id LIMIT 1`).get() as { id: number } | undefined)?.id ?? actor.id;
      jobUpdate = {
        op_status: 'waiting',
        waiting_category: 'office_review',
        waiting_detail: `Review ${a.ref} outcome (${code?.label ?? outcome}) and decide on operational completion.`,
        next_action: 'Review attendance evidence and decide completion / invoicing readiness',
        next_owner_user_id: owner,
        review_at: new Date(clock.now().getTime() + DAY).toISOString(),
      };
    }
    if (jobUpdate.op_status === 'waiting' && job.op_status !== 'waiting') jobUpdate.waiting_since = now;
    const cols = Object.keys(jobUpdate);
    db.prepare(`UPDATE jobs SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_at = @now, version = version + 1 WHERE id = @id`).run({ ...jobUpdate, now, id: a.job_id });
    if (jobUpdate.next_owner_user_id) {
      const cat = jobUpdate.waiting_category as (typeof WAITING_CATEGORIES)[number] | undefined;
      notify(db, jobUpdate.next_owner_user_id as number, 'handoff', `${job.ref}: ${a.ref} submitted — ${cat ? WAITING_LABEL[cat] : 'review'}`, `/jobs/${a.job_id}`);
    }
    audit(db, actor, 'attendance', attId, 'submitted', {
      after: { outcome, final_condition: d.final_condition, followon, temporary: !!temp, acknowledged_by: d.ack_name, labour_minutes: d.labour_minutes },
    });
    audit(db, actor, 'job', a.job_id, 'attendance_submitted', {
      before: { op_status: job.op_status },
      after: { attendance: a.ref, outcome, op_status: jobUpdate.op_status, waiting_category: jobUpdate.waiting_category ?? null, financial_status: job.financial_status, commercial_status: job.commercial_status },
    });
    return { duplicate: false };
  });
}

export function temporaryRestorations(db: DB, where: { jobId?: number; open?: boolean }) {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (where.jobId) {
    conds.push('t.job_id = ?');
    params.push(where.jobId);
  }
  if (where.open) conds.push(`t.status = 'open'`);
  return db
    .prepare(
      `SELECT t.*, o.display_name AS owner_name, a.ref AS attendance_ref, j.ref AS job_ref, j.title AS job_title, s.name AS site_name
       FROM temporary_restorations t JOIN users o ON o.id = t.permanent_owner_user_id JOIN attendances a ON a.id = t.attendance_id
       JOIN jobs j ON j.id = t.job_id JOIN sites s ON s.id = j.site_id ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''} ORDER BY t.review_at`,
    )
    .all(...params) as {
    id: number;
    job_id: number;
    job_ref: string;
    job_title: string;
    site_name: string;
    attendance_ref: string;
    change_made: string;
    reason: string;
    service_restored: string;
    limitations: string;
    residual_risk: string;
    monitoring: string | null;
    review_at: string;
    customer_understanding: string;
    approver: string;
    owner_name: string;
    status: string;
    resolution_note: string | null;
    resolved_at: string | null;
  }[];
}

/** A temporary restoration is a future obligation; resolving it requires an explicit record. */
export function resolveTemporary(db: DB, actor: Actor, tempId: number, body: Record<string, unknown>) {
  requireCap(actor, 'temp.resolve');
  const f = new Form(body);
  const note = f.str('resolution_note', 'How the permanent resolution was achieved / transferred', 2000);
  f.done();
  tx(db, () => {
    const t = db.prepare('SELECT * FROM temporary_restorations WHERE id = ?').get(tempId) as { id: number; job_id: number; status: string } | undefined;
    if (!t) throw new NotFoundError('Temporary restoration');
    if (t.status !== 'open') throw new DomainError('Already resolved.');
    db.prepare(`UPDATE temporary_restorations SET status = 'resolved', resolved_at = ?, resolved_by = ?, resolution_note = ? WHERE id = ?`).run(clock.iso(), actor.id, note, tempId);
    audit(db, actor, 'job', t.job_id, 'temporary_restoration_resolved', { reason: note, after: { temporary_restoration_id: tempId } });
  });
}

/** Attendances for an engineer's My Day (US-040). */
export function myAttendances(db: DB, engineerId: number, fromIso: string, toIso: string) {
  return db
    .prepare(
      `SELECT a.*, j.ref AS job_ref, j.title AS job_title, j.priority, j.reported_symptom, j.safety_flag, j.safety_risk, j.kind,
         s.name AS site_name, s.address AS site_address, s.postcode AS site_postcode, s.induction_required, s.asbestos_info, s.work_restrictions,
         c.trading_name AS customer_name,
         (SELECT COUNT(*) FROM attendance_stops st WHERE st.attendance_id = a.id AND st.resolved_at IS NULL) AS open_stops
       FROM attendances a JOIN jobs j ON j.id = a.job_id JOIN sites s ON s.id = j.site_id JOIN customers c ON c.id = j.customer_id
       WHERE a.engineer_user_id = ? AND a.status <> 'cancelled'
         AND ((a.planned_start < ? AND a.planned_end > ?) OR a.status IN ('dispatched','travelling','on_site','working'))
       ORDER BY a.planned_start`,
    )
    .all(engineerId, toIso, fromIso) as (Attendance & {
    reported_symptom: string | null;
    safety_flag: number;
    safety_risk: string | null;
    kind: string;
    site_address: string;
    induction_required: number;
    asbestos_info: string | null;
    work_restrictions: string | null;
    open_stops: number;
  })[];
}
