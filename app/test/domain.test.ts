import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { clock, DAY, MIN } from '../src/lib/clock.ts';
import { ConflictError, DomainError, ForbiddenError } from '../src/lib/errors.ts';
import * as J from '../src/domain/jobs.ts';
import * as S from '../src/domain/sla.ts';
import * as A from '../src/domain/attendance.ts';
import * as Sched from '../src/domain/scheduling.ts';
import * as Inv from '../src/domain/inventory.ts';
import * as Q from '../src/domain/quotes.ts';
import { checkApproval } from '../src/auth/policy.ts';
import { count, localIn, makeEnv, one, READY_ALL, type TestEnv } from './helpers.ts';

let env: TestEnv;
before(() => {
  env = makeEnv('domain');
});
after(() => env.close());

/**
 * Test attendances are booked well clear of the seeded diary so a clash only happens when a
 * test deliberately creates one. Each call takes the next free window.
 */
let slotSeq = 0;
function freeSlot(): { start: string; end: string } {
  slotSeq += 1;
  const base = 30 * 24 * 60 + slotSeq * 4 * 60; // a month out, 4 hours apart
  return { start: localIn(base), end: localIn(base + 120) };
}

/** Creates a fresh reactive job at a covered site, ready to schedule. */
function newReadyJob(opts: { priority?: string; site?: string; comps?: string } = {}) {
  const { db, actors } = env;
  const site = one<{ id: number }>(db, `SELECT id FROM sites WHERE name = ?`, opts.site ?? 'Oakwood Lodge');
  const id = J.createJob(db, actors.dan, {
    site_id: String(site.id),
    kind: 'reactive',
    title: 'Test job',
    channel: 'phone',
    priority: opts.priority ?? 'P2',
    priority_reason: 'Test priority reason',
    reported_symptom: 'Something is not working',
    required_competences: opts.comps ?? '',
    authority_basis: 'contract_minor_repair',
    authority_ref: 'Contract cover',
  });
  J.updateReadiness(db, actors.dan, id, { ...READY_ALL });
  return id;
}

describe('service control and closure (RULE-001, FR-018)', () => {
  it('separates authorised, ready, scheduled and dispatched', () => {
    const slot = freeSlot();
    const { db, actors } = env;
    const site = one<{ id: number }>(db, `SELECT id FROM sites WHERE name = 'Oakwood Lodge'`);
    const id = J.createJob(db, actors.dan, {
      site_id: String(site.id),
      kind: 'reactive',
      title: 'Readiness progression',
      channel: 'phone',
      priority: 'P3',
      priority_reason: 'Comfort only',
      reported_symptom: 'Warm office',
    });
    assert.equal(J.getJob(db, id).op_status, 'new', 'a logged call starts as new, not ready');

    J.setAuthority(db, actors.dan, id, { authority_basis: 'diagnosis_only', reason: 'Customer agreed to a diagnosis visit' });
    assert.equal(J.getJob(db, id).op_status, 'authorised');

    J.updateReadiness(db, actors.dan, id, { ready_scope: 'on', ready_authority: 'on' });
    assert.equal(J.getJob(db, id).op_status, 'authorised', 'a partial checklist does not make work ready');

    J.updateReadiness(db, actors.dan, id, { ...READY_ALL });
    assert.equal(J.getJob(db, id).op_status, 'ready');

    const att = Sched.assignAttendance(db, actors.dan, id, {
      engineer_user_id: String(actors.gareth.id),
      planned_start: slot.start,
      planned_end: slot.end,
      commitment: 'provisional',
      override_ack: 'on',
      override_reason: 'test',
    });
    assert.equal(J.getJob(db, id).op_status, 'scheduled', 'scheduled is not the same as dispatched');

    Sched.dispatchAttendance(db, actors.dan, att);
    assert.equal(J.getJob(db, id).op_status, 'dispatched');
    assert.equal(count(db, `SELECT COUNT(*) n FROM sla_events WHERE job_id = ? AND type = 'dispatched'`, id), 1);
  });

  it('never closes the job when an attendance is submitted, and demands a controlled handoff', () => {
    const slot = freeSlot();
    const { db, actors } = env;
    const id = newReadyJob();
    const att = Sched.assignAttendance(db, actors.dan, id, {
      engineer_user_id: String(actors.gareth.id),
      planned_start: slot.start,
      planned_end: slot.end,
      commitment: 'provisional',
      override_ack: 'on',
      override_reason: 'test',
    });
    Sched.dispatchAttendance(db, actors.dan, att);
    A.progressAttendance(db, actors.gareth, att, 'travel');
    A.progressAttendance(db, actors.gareth, att, 'arrive');
    A.progressAttendance(db, actors.gareth, att, 'start_work');

    // An outcome that requires follow-on cannot be submitted without the handoff detail.
    assert.throws(
      () =>
        A.submitAttendance(db, actors.gareth, att, {
          submit_key: `k-${att}-a`,
          outcome: 'missing_parts_tools',
          authority_basis: 'contract_minor_repair',
          observed_facts: 'Pump seized',
          work_done: 'Isolated',
          final_condition: 'not_operating',
          labour_minutes: '45',
          ack_name: 'Site manager',
        }),
      (e: Error) => e instanceof DomainError && /required outcome|dependency|owner|condition/i.test(e.message),
      'follow-on outcomes must carry the handoff',
    );

    A.submitAttendance(db, actors.gareth, att, {
      submit_key: `k-${att}-b`,
      outcome: 'completed',
      authority_basis: 'contract_minor_repair',
      observed_facts: 'Contactor welded',
      diagnosis: 'Failed contactor',
      diagnosis_verified: 'on',
      work_done: 'Replaced contactor',
      final_condition: 'operating_normally',
      labour_minutes: '90',
      ack_name: 'Grace Ndlovu',
      ack_role: 'Home manager',
    });

    const job = J.getJob(db, id);
    assert.notEqual(job.op_status, 'operationally_complete', 'attendance submission must not close the job (RULE-001)');
    assert.equal(job.op_status, 'waiting');
    assert.equal(job.waiting_category, 'office_review');
    assert.ok(job.next_owner_user_id, 'the waiting job has an owner');
    assert.ok(job.review_at, 'the waiting job has a review point');
    assert.equal(job.financial_status, 'not_ready', 'financial closure is independent');
    assert.equal(job.commercial_status, 'clear', 'commercial closure is independent');
  });

  it('is idempotent on submission so a retry cannot duplicate the record', () => {
    const slot = freeSlot();
    const { db, actors } = env;
    const id = newReadyJob();
    const att = Sched.assignAttendance(db, actors.dan, id, {
      engineer_user_id: String(actors.kieran.id),
      planned_start: slot.start,
      planned_end: slot.end,
      commitment: 'provisional',
      override_ack: 'on',
      override_reason: 'test',
    });
    Sched.dispatchAttendance(db, actors.dan, att);
    A.progressAttendance(db, actors.kieran, att, 'arrive');
    const body = {
      submit_key: `dupe-${att}`,
      outcome: 'no_fault_found',
      authority_basis: 'diagnosis_only',
      observed_facts: 'Everything running within spec',
      work_done: 'Checked operation',
      final_condition: 'operating_normally',
      labour_minutes: '30',
      ack_name: 'Duty manager',
    };
    const first = A.submitAttendance(db, actors.kieran, att, body);
    const second = A.submitAttendance(db, actors.kieran, att, body);
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true, 'the same submit key must not create a second submission');
    assert.equal(count(db, `SELECT COUNT(*) n FROM audit_events WHERE entity_type = 'attendance' AND entity_id = ? AND action = 'submitted'`, att), 1);
  });

  it('blocks operational completion while obligations are open, and keeps the other dimensions separate', () => {
    const slot = freeSlot();
    const { db, actors } = env;
    const id = newReadyJob();
    const att = Sched.assignAttendance(db, actors.dan, id, {
      engineer_user_id: String(actors.tom.id),
      planned_start: slot.start,
      planned_end: slot.end,
      commitment: 'provisional',
      override_ack: 'on',
      override_reason: 'test',
    });
    Sched.dispatchAttendance(db, actors.dan, att);
    A.progressAttendance(db, actors.tom, att, 'arrive');
    A.submitAttendance(db, actors.tom, att, {
      submit_key: `temp-${att}`,
      outcome: 'temporary_restoration',
      authority_basis: 'contract_minor_repair',
      observed_facts: 'Pitted contacts',
      work_done: 'Dressed contacts',
      final_condition: 'operating_limited',
      labour_minutes: '60',
      ack_name: 'Site',
      handoff_required_outcome: 'Replace contactor',
      handoff_dependency: 'part_availability',
      handoff_dependency_detail: 'Contactor on order',
      handoff_operating_condition: 'Running on dressed contacts',
      handoff_urgency: 'P2',
      handoff_next_owner_user_id: String(env.actors.dan.id),
      handoff_review_at: localIn(24 * 60),
      temp_change_made: 'Dressed contacts',
      temp_reason: 'No part on van',
      temp_service_restored: 'Cooling restored',
      temp_limitations: 'May fail again',
      temp_residual_risk: 'Stock at risk',
      temp_review_at: localIn(3 * 24 * 60),
      temp_customer_understanding: 'Customer told it is temporary',
      temp_approver: 'Dan Whitaker',
      temp_permanent_owner_user_id: String(env.actors.dan.id),
    });

    const blockers = J.closureBlockers(db, J.getJob(db, id));
    assert.ok(
      blockers.some((b) => /temporary restoration/i.test(b)),
      'an open temporary restoration blocks completion',
    );
    assert.throws(() => J.completeOperationally(db, actors.dan, id, { reason: 'Looks done' }), DomainError);

    const temp = one<{ id: number }>(db, `SELECT id FROM temporary_restorations WHERE job_id = ?`, id);
    A.resolveTemporary(db, actors.dan, temp.id, { resolution_note: 'Contactor fitted on the return visit' });
    J.resolveWaiting(db, actors.dan, id, { resolution: 'Part fitted' });
    J.completeOperationally(db, actors.dan, id, { reason: 'Permanent repair verified' });

    const done = J.getJob(db, id);
    assert.equal(done.op_status, 'operationally_complete');
    assert.equal(done.financial_status, 'not_ready', 'completing work does not make it invoiced');
    assert.throws(() => J.setFinancialStatus(db, actors.dan, id, { financial_status: 'invoiced', reason: 'x' }), ForbiddenError, 'coordinators cannot move financial state');
    J.setFinancialStatus(db, env.actors.helen, id, { financial_status: 'ready_to_invoice', reason: 'Parts and labour to charge' });
    assert.equal(J.getJob(db, id).financial_status, 'ready_to_invoice');
    assert.equal(count(db, `SELECT COUNT(*) n FROM sla_events WHERE job_id = ? AND type = 'closure'`, id), 1);
  });

  it('refuses a waiting state without dependency, owner and review point (RULE-005)', () => {
    const { db, actors } = env;
    const id = newReadyJob();
    assert.throws(() => J.setWaiting(db, actors.dan, id, { waiting_category: 'part_availability', waiting_detail: 'Part on order' }), DomainError, 'owner and review are required');
    assert.throws(
      () => db.prepare(`UPDATE jobs SET op_status = 'waiting', waiting_category = NULL WHERE id = ?`).run(id),
      /CHECK constraint failed/,
      'the database itself refuses a bare waiting state',
    );
  });

  it('records priority changes with reason and decision-maker (RULE-002)', () => {
    const { db, actors } = env;
    const id = newReadyJob({ priority: 'P3' });
    J.changePriority(db, actors.dan, id, { priority: 'P1', reason: 'Residents now without heating' });
    const change = one<{ from_priority: string; to_priority: string; reason: string; decided_by: number }>(db, `SELECT * FROM priority_changes WHERE job_id = ? ORDER BY id DESC`, id);
    assert.equal(change.from_priority, 'P3');
    assert.equal(change.to_priority, 'P1');
    assert.equal(change.decided_by, actors.dan.id);
    assert.equal(count(db, `SELECT COUNT(*) n FROM audit_events WHERE entity_type = 'job' AND entity_id = ? AND action = 'priority_changed'`, id), 1);
    assert.throws(() => J.changePriority(db, actors.dan, id, { priority: 'P2', reason: '' }), DomainError, 'a reason is mandatory');
  });

  it('rejects a stale edit rather than overwriting someone else silently', () => {
    const { db, actors } = env;
    const id = newReadyJob();
    const stale = J.getJob(db, id).version;
    J.setNextAction(db, actors.dan, id, { next_action: 'First change', next_owner_user_id: String(actors.dan.id), review_at: localIn(60) });
    assert.throws(
      () => J.setNextAction(db, actors.leanne, id, { next_action: 'Conflicting change', next_owner_user_id: String(actors.leanne.id), review_at: localIn(90), version: String(stale) }),
      ConflictError,
    );
  });
});

describe('SLA events and clock stops (FR-007/008, RULE-003)', () => {
  it('keeps event types distinct and derives targets from the contract', () => {
    const { db, actors } = env;
    const id = newReadyJob({ priority: 'P2' });
    const job = J.getJob(db, id);
    const sla = S.computeSla(db, job);
    const attendance = sla.find((t) => t.measure === 'attendance')!;
    assert.ok(attendance.targetMinutes, 'the contract supplies an attendance target');
    assert.equal(attendance.state, 'on_track');

    S.recordManualEvent(db, actors.dan, id, { type: 'response', note: 'Called the home back' });
    const events = S.slaEvents(db, id).filter((e) => !e.superseded);
    assert.deepEqual(events.map((e) => e.type), ['received', 'response'], 'received and response are separate events');
    S.recordManualEvent(db, actors.dan, id, { type: 'acknowledged', note: 'Confirmed to the customer' });
    assert.deepEqual(
      S.slaEvents(db, id).filter((e) => !e.superseded).map((e) => e.type).sort(),
      ['acknowledged', 'received', 'response'],
      'acknowledgement is its own event, not a byproduct of another',
    );
  });

  it('extends the due time by permitted clock stops only', () => {
    const { db, actors } = env;
    const id = newReadyJob({ priority: 'P2' });
    const before = S.computeSla(db, J.getJob(db, id)).find((t) => t.measure === 'attendance')!;

    S.startClockStop(db, actors.dan, id, {
      reason_category: 'no_access',
      contractual_basis: 'Contract permits stops for denied access',
      dependency_detail: 'Plant room locked, key holder off site',
      evidence: 'Engineer arrival logged; email sent',
      expected_actor: 'Customer maintenance lead',
      owner_user_id: String(actors.dan.id),
      chase_at: localIn(120),
    });

    const realNow = clock.now();
    clock.set(new Date(realNow.getTime() + 60 * MIN));
    const during = S.computeSla(db, J.getJob(db, id)).find((t) => t.measure === 'attendance')!;
    assert.ok(new Date(during.dueAt!).getTime() > new Date(before.dueAt!).getTime(), 'a running stop pushes the due time out');
    assert.ok(during.pausedMinutes >= 59);
    clock.set(null);

    assert.throws(
      () =>
        S.startClockStop(db, actors.dan, id, {
          reason_category: 'parts',
          contractual_basis: 'x',
          dependency_detail: 'y',
          evidence: 'z',
          expected_actor: 'supplier',
          owner_user_id: String(actors.dan.id),
          chase_at: localIn(60),
        }),
      DomainError,
      'only one stop can run at a time',
    );
  });

  it('refuses a clock stop where the contract does not permit one', () => {
    const { db, actors } = env;
    const quayside = one<{ id: number }>(db, `SELECT id FROM sites WHERE name = 'The Quayside Hotel'`);
    const id = J.createJob(db, actors.dan, {
      site_id: String(quayside.id),
      kind: 'reactive',
      title: 'Clock stop not permitted',
      channel: 'phone',
      priority: 'P2',
      priority_reason: 'Kitchen extract',
      reported_symptom: 'Noise',
    });
    assert.throws(
      () =>
        S.startClockStop(db, actors.dan, id, {
          reason_category: 'customer_delay',
          contractual_basis: 'none',
          dependency_detail: 'waiting',
          evidence: 'call',
          expected_actor: 'customer',
          owner_user_id: String(actors.dan.id),
          chase_at: localIn(60),
        }),
      (e: Error) => e instanceof DomainError && /does not permit clock stops/i.test(e.message),
    );
  });

  it('corrects an event by superseding it, never by rewriting history (AC-021-04)', () => {
    const { db, actors } = env;
    const id = newReadyJob();
    S.recordManualEvent(db, actors.dan, id, { type: 'acknowledged', note: 'Emailed the customer' });
    const event = S.slaEvents(db, id).find((e) => e.type === 'acknowledged')!;

    assert.throws(() => db.prepare(`UPDATE sla_events SET occurred_at = ? WHERE id = ?`).run('2020-01-01T00:00:00.000Z', event.id), /append-only/, 'timestamps cannot be rewritten in place');
    assert.throws(() => db.prepare('DELETE FROM sla_events WHERE id = ?').run(event.id), /append-only/);

    S.supersedeEvent(db, actors.dan, event.id, { occurred_at: localIn(-30), reason: 'Logged late — actually acknowledged on the first call' });
    const after = S.slaEvents(db, id).filter((e) => e.type === 'acknowledged');
    assert.equal(after.length, 2, 'the original and the correction are both on the record');
    assert.equal(after.filter((e) => e.superseded).length, 1);
    assert.ok(after.find((e) => e.supersedes_id === event.id));
  });

  it('requires an explanation for a late manual entry', () => {
    const { db, actors } = env;
    const site = one<{ id: number }>(db, `SELECT id FROM sites WHERE name = 'Oakwood Lodge'`);
    const id = J.createJob(db, actors.dan, {
      site_id: String(site.id),
      kind: 'reactive',
      title: 'Late entry',
      channel: 'phone',
      received_at: localIn(-24 * 60),
      priority: 'P3',
      priority_reason: 'Reported yesterday',
      reported_symptom: 'Noise',
    });
    assert.throws(() => S.recordManualEvent(db, actors.dan, id, { type: 'response', occurred_at: localIn(-120) }), (e: Error) => e instanceof DomainError && /late entry/i.test(e.message));
    S.recordManualEvent(db, actors.dan, id, { type: 'response', occurred_at: localIn(-120), note: 'Phoned at the time; logged after the callout' });
  });
});

describe('scheduling signals and displacement (FR-010/011/012)', () => {
  it('warns on missing competence and expired clearance, and needs an acknowledged override', () => {
    const slot = freeSlot();
    const { db, actors } = env;
    const id = newReadyJob({ comps: 'gas-commercial' });
    const job = J.getJob(db, id);
    const signals = Sched.assignmentSignals(db, job, actors.aisha.id, new Date(clock.now().getTime() + 2 * 3600_000).toISOString(), new Date(clock.now().getTime() + 4 * 3600_000).toISOString());
    assert.ok(signals.some((s) => s.level === 'warn' && s.code === 'competence_missing'), 'Aisha has no commercial gas competence recorded');

    assert.throws(
      () =>
        Sched.assignAttendance(db, actors.dan, id, {
          engineer_user_id: String(actors.aisha.id),
          planned_start: slot.start,
          planned_end: slot.end,
          commitment: 'provisional',
        }),
      (e: Error) => e instanceof DomainError && /warnings need an acknowledged override/i.test(e.message),
    );

    const att = Sched.assignAttendance(db, actors.dan, id, {
      engineer_user_id: String(actors.aisha.id),
      planned_start: slot.start,
      planned_end: slot.end,
      commitment: 'provisional',
      override_ack: 'on',
      override_reason: 'Aisha is shadowing Gareth who holds the ticket',
    });
    const stored = Sched.getAttendance(db, att);
    assert.ok(stored.override_reason, 'the override reason is stored on the attendance');
    assert.ok(JSON.parse(stored.warnings ?? '[]').length, 'the warnings that were overridden are stored');
  });

  it('records displacement with a communications owner and a new owner for the displaced work', () => {
    const { db, actors } = env;
    const first = newReadyJob({ priority: 'P3' });
    const contested = freeSlot();
    const start = contested.start;
    const end = contested.end;
    const firstAtt = Sched.assignAttendance(db, actors.dan, first, {
      engineer_user_id: String(actors.gareth.id),
      planned_start: start,
      planned_end: end,
      commitment: 'customer_confirmed',
      override_ack: 'on',
      override_reason: 'test',
    });

    const urgent = newReadyJob({ priority: 'P1' });
    assert.throws(
      () =>
        Sched.assignAttendance(db, actors.dan, urgent, {
          engineer_user_id: String(actors.gareth.id),
          planned_start: start,
          planned_end: end,
          commitment: 'customer_confirmed',
          override_ack: 'on',
          override_reason: 'emergency',
        }),
      ConflictError,
      'an unhandled clash is refused rather than double-booked',
    );

    Sched.assignAttendance(db, actors.dan, urgent, {
      engineer_user_id: String(actors.gareth.id),
      planned_start: start,
      planned_end: end,
      commitment: 'customer_confirmed',
      override_ack: 'on',
      override_reason: 'P1 care home emergency',
      displace_ids: [String(firstAtt)],
      disp_reason: 'P1 heating loss at a care home takes precedence',
      disp_comms_owner_user_id: String(actors.leanne.id),
      disp_comms_note: 'Leanne to call the customer and re-book',
      disp_new_next_action: 'Re-book the displaced visit within 48 hours',
      disp_new_owner_user_id: String(actors.dan.id),
      disp_review_at: localIn(24 * 60),
    });

    assert.equal(Sched.getAttendance(db, firstAtt).status, 'cancelled');
    const displaced = J.getJob(db, first);
    assert.equal(displaced.next_action, 'Re-book the displaced visit within 48 hours');
    assert.equal(displaced.next_owner_user_id, actors.dan.id);
    const record = one<{ change_type: string; comms_owner_user_id: number; authorised_by: number }>(db, `SELECT * FROM schedule_displacements WHERE attendance_id = ?`, firstAtt);
    assert.equal(record.change_type, 'displaced');
    assert.equal(record.comms_owner_user_id, actors.leanne.id);
    assert.equal(record.authorised_by, actors.dan.id);
    assert.ok(count(db, `SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND kind = 'displacement'`, actors.dan.id) > 0);
  });

  it('will not dispatch a job that is waiting on a dependency', () => {
    const slot = freeSlot();
    const { db, actors } = env;
    const id = newReadyJob();
    const att = Sched.assignAttendance(db, actors.dan, id, {
      engineer_user_id: String(actors.kieran.id),
      planned_start: slot.start,
      planned_end: slot.end,
      commitment: 'provisional',
      override_ack: 'on',
      override_reason: 'test',
    });
    J.setWaiting(db, actors.dan, id, {
      waiting_category: 'access',
      waiting_detail: 'Site cannot give access until Monday',
      next_action: 'Chase access',
      next_owner_user_id: String(actors.dan.id),
      review_at: localIn(60),
    });
    assert.throws(() => Sched.dispatchAttendance(db, actors.dan, att), (e: Error) => e instanceof DomainError && /waiting/i.test(e.message));
  });
});

describe('engineer authority and evidence (Q015–Q020)', () => {
  it('lets only the assigned engineer execute the attendance', () => {
    const slot = freeSlot();
    const { db, actors } = env;
    const id = newReadyJob();
    const att = Sched.assignAttendance(db, actors.dan, id, {
      engineer_user_id: String(actors.tom.id),
      planned_start: slot.start,
      planned_end: slot.end,
      commitment: 'provisional',
      override_ack: 'on',
      override_reason: 'test',
    });
    Sched.dispatchAttendance(db, actors.dan, att);
    assert.throws(() => A.progressAttendance(db, actors.aisha, att, 'arrive'), ForbiddenError);
    assert.throws(() => A.progressAttendance(db, actors.dan, att, 'arrive'), ForbiddenError, 'coordinators cannot record field events for an engineer');
    A.progressAttendance(db, actors.tom, att, 'arrive');
    assert.equal(count(db, `SELECT COUNT(*) n FROM sla_events WHERE job_id = ? AND type = 'attendance'`, id), 1, 'arrival records the attendance SLA event');
  });

  it('keeps stop/escalate available and notifies the office', () => {
    const slot = freeSlot();
    const { db, actors } = env;
    const id = newReadyJob();
    const att = Sched.assignAttendance(db, actors.dan, id, {
      engineer_user_id: String(actors.kieran.id),
      planned_start: slot.start,
      planned_end: slot.end,
      commitment: 'provisional',
      override_ack: 'on',
      override_reason: 'test',
    });
    Sched.dispatchAttendance(db, actors.dan, att);
    A.progressAttendance(db, actors.kieran, att, 'arrive');
    const stopId = A.raiseStop(db, actors.kieran, att, {
      kind: 'stop_unsafe',
      detail: 'Roof access unsafe in this wind',
      safety_condition: 'Nothing altered; unit still running',
    });
    assert.ok(count(db, `SELECT COUNT(*) n FROM notifications WHERE kind = 'escalation'`) > 0);
    const blockers = J.closureBlockers(db, J.getJob(db, id));
    assert.ok(blockers.some((b) => /escalation/i.test(b)), 'an unanswered escalation blocks completion');
    A.resolveStop(db, actors.dan, stopId, { resolution: 'Return tomorrow when wind drops; customer informed' });
    assert.ok(!J.closureBlockers(db, J.getJob(db, id)).some((b) => /escalation/i.test(b)));
  });

  it('records acknowledgement as acknowledgement, not approval', () => {
    const slot = freeSlot();
    const { db, actors } = env;
    const id = newReadyJob();
    const att = Sched.assignAttendance(db, actors.dan, id, {
      engineer_user_id: String(actors.sam.id),
      planned_start: slot.start,
      planned_end: slot.end,
      commitment: 'provisional',
      override_ack: 'on',
      override_reason: 'test',
    });
    Sched.dispatchAttendance(db, actors.dan, att);
    A.progressAttendance(db, actors.sam, att, 'arrive');
    assert.throws(
      () =>
        A.submitAttendance(db, actors.sam, att, {
          submit_key: `ack-${att}`,
          outcome: 'completed',
          authority_basis: 'contract_minor_repair',
          observed_facts: 'x',
          work_done: 'y',
          final_condition: 'operating_normally',
          labour_minutes: '30',
        }),
      (e: Error) => e instanceof DomainError && /acknowledg/i.test(e.message),
      'either an acknowledgement or a reason for its absence is required',
    );
    A.submitAttendance(db, actors.sam, att, {
      submit_key: `ack2-${att}`,
      outcome: 'completed',
      authority_basis: 'contract_minor_repair',
      observed_facts: 'x',
      work_done: 'y',
      final_condition: 'operating_normally',
      labour_minutes: '30',
      ack_not_obtained_reason: 'Site unattended at the time of leaving',
    });
    const stored = Sched.getAttendance(db, att);
    assert.equal(stored.ack_name, null);
    assert.ok(stored.ack_not_obtained_reason);
    assert.notEqual(J.getJob(db, id).op_status, 'operationally_complete');
  });
});

describe('commercial control (US-050/051/052)', () => {
  function draftQuote() {
    const { db, actors } = env;
    const customer = one<{ id: number }>(db, `SELECT id FROM customers WHERE trading_name = 'Irwell Leisure'`);
    const site = one<{ id: number }>(db, `SELECT id FROM sites WHERE customer_id = ?`, customer.id);
    const oppId = Q.createOpportunity(db, actors.rachel, { customer_id: String(customer.id), site_id: String(site.id), title: 'Test works', source: 'enquiry' });
    const rev = Q.revisionsFor(db, oppId)[0];
    Q.updateDraft(db, actors.rachel, rev.id, {
      scope: 'Replace unit',
      assumptions: 'Existing pipework reusable',
      exclusions: 'Electrical works',
      vat_rate: '20',
      valid_until: new Date(Date.now() + 30 * DAY).toISOString().slice(0, 10),
    });
    Q.addLine(db, actors.rachel, rev.id, { line_type: 'equipment', description: 'Unit', qty: '1', unit_price: '2000.00' });
    Q.addLine(db, actors.rachel, rev.id, { option_code: 'A', line_type: 'other', description: 'Out of hours', qty: '1', unit_price: '400.00' });
    return { oppId, revId: rev.id };
  }

  it('enforces the configurable approval policy and leaves thresholds unset', () => {
    const { db, actors } = env;
    const { revId } = draftQuote();
    const decision = checkApproval(db, actors.rachel, 'quote.approve', 200000);
    assert.equal(decision.allowed, false, 'estimators are not granted approval by the seeded policy');
    assert.throws(() => Q.approveRevision(db, actors.rachel, revId, { reason: 'Looks fine' }), ForbiddenError);

    const managerDecision = checkApproval(db, actors.susan, 'quote.approve', 200000);
    assert.equal(managerDecision.allowed, true);
    assert.equal(managerDecision.limitConfigured, false, 'no monetary threshold is invented (DISC-D008)');
    Q.approveRevision(db, actors.susan, revId, { reason: 'Checked scope and price' });
    assert.equal(Q.getRevision(db, revId).status, 'internally_approved');
  });

  it('locks revision content once it leaves draft and forces a new revision for changes', () => {
    const { db, actors } = env;
    const { oppId, revId } = draftQuote();
    Q.approveRevision(db, actors.susan, revId, { reason: 'ok' });
    assert.throws(() => Q.updateDraft(db, actors.rachel, revId, { scope: 'Changed scope', vat_rate: '20' }), DomainError);
    assert.throws(() => Q.addLine(db, actors.rachel, revId, { line_type: 'labour', description: 'More', qty: '1', unit_price: '10.00' }), DomainError);
    assert.throws(() => db.prepare('UPDATE quote_revisions SET scope = ? WHERE id = ?').run('sneaky', revId), /locked/, 'the database refuses to rewrite issued content');

    Q.issueRevision(db, actors.rachel, revId, { note: 'Emailed' });
    const rev2 = Q.newRevision(db, actors.rachel, oppId, { change_summary: 'Customer asked for a different unit' });
    assert.equal(Q.getRevision(db, rev2).rev_no, 2);
    assert.equal(Q.getRevision(db, rev2).status, 'draft');
    assert.equal(Q.linesFor(db, rev2).length, 2, 'the new revision starts from a copy');
  });

  it('ties acceptance to an exact revision and gates release behind the checklist (RULE-007)', () => {
    const { db, actors } = env;
    const { oppId, revId } = draftQuote();
    Q.approveRevision(db, actors.susan, revId, { reason: 'ok' });
    Q.issueRevision(db, actors.rachel, revId, { note: 'Emailed' });

    assert.throws(
      () => Q.recordAcceptance(db, actors.rachel, revId, { accepting_party: 'Someone', acceptance_evidence: 'Verbal', confirm_revision: '2', credit_deposit: 'not_required' }),
      (e: Error) => e instanceof DomainError && /revision number/i.test(e.message),
      'the person must name the exact revision being accepted',
    );

    const accId = Q.recordAcceptance(db, actors.rachel, revId, {
      accepting_party: 'Gary Nuttall, Facilities officer',
      acceptance_evidence: 'Email confirmation',
      confirm_revision: '1',
      options: ['A'],
      credit_deposit: 'not_required',
      chk_authority: 'on',
    });
    const acc = Q.getAcceptance(db, accId);
    assert.equal(acc.accepted_net_pence, 240000, 'the accepted value includes the chosen option only');
    assert.equal(Q.getRevision(db, revId).status, 'accepted');
    assert.equal(Q.getOpportunity(db, oppId).maturity, 'awarded');

    const blockers = Q.releaseBlockers(db, acc);
    assert.ok(blockers.length >= 4, 'unchecked validation items block release');
    assert.throws(() => Q.releaseWork(db, actors.susan, accId, { target: 'job', reason: 'Go' }), (e: Error) => e instanceof DomainError && /Release blocked/i.test(e.message));

    Q.updateChecklist(db, actors.rachel, accId, {
      chk_authority: 'on',
      chk_authority_note: 'Facilities officer confirmed authority',
      chk_revision_options: 'on',
      chk_po_value: 'on',
      po_number: 'PO-1',
      po_value: '2400.00',
      chk_terms: 'on',
      chk_dates: 'on',
      chk_validity_pricing: 'on',
      credit_deposit: 'cleared',
    });
    assert.throws(() => Q.releaseWork(db, actors.rachel, accId, { target: 'job', reason: 'Go' }), ForbiddenError, 'release follows the approval policy, not the recorder');

    const released = Q.releaseWork(db, actors.susan, accId, { target: 'job', reason: 'All checks complete', owner_user_id: String(actors.dan.id) });
    const job = J.getJob(db, released.jobId!);
    assert.equal(job.authority_basis, 'accepted_quote');
    assert.equal(job.kind, 'quoted_works');
    assert.ok(job.authority_ref?.includes('rev 1'));
    assert.equal(Q.getAcceptance(db, accId).released, 1);
  });

  it('records post-award change as a classified variation instead of editing the accepted quote', () => {
    const { db, actors } = env;
    const id = newReadyJob();
    const vId = Q.createVariation(db, actors.owen, {
      job_id: String(id),
      classification: 'failed_assumption',
      description: 'Frame size differs from survey',
      scope_impact: 'Adaptor plate required',
      value_impact: '185.00',
    });
    assert.equal(J.getJob(db, id).commercial_status, 'approval_required');
    assert.throws(() => Q.decideVariation(db, actors.owen, vId, { decision: 'approved', reason: 'fine' }), ForbiddenError, 'approval follows the policy');
    Q.decideVariation(db, actors.susan, vId, { decision: 'approved', reason: 'Customer accepted the extra' });
    assert.equal(J.getJob(db, id).commercial_status, 'clear');
  });
});

describe('inventory truth (US-060..063, RULE-008/009/010)', () => {
  const sku = (code: string) => one<{ id: number }>(env.db, 'SELECT id FROM stock_items WHERE sku = ?', code).id;
  const wh = () => one<{ id: number }>(env.db, `SELECT id FROM stock_locations WHERE code = 'WH-BURY'`).id;

  it('separates possession from availability', () => {
    const { db, actors } = env;
    const item = sku('FLT-G4-592');
    const before = Inv.itemSummary(db, item);
    assert.ok(Inv.balancesForItem(db, item).length > 1, 'the same item exists in several places');

    // Reserving moves stock out of availability without changing what we physically hold.
    Inv.reserve(db, actors.mick, {
      item_id: String(item),
      location_id: String(wh()),
      qty: '10',
      purpose: 'Planned maintenance batch',
      owner_user_id: String(actors.mick.id),
      required_by: localIn(24 * 60),
      review_at: localIn(72 * 60),
      reallocation_consequence: 'PPM visits would go without filters',
    });
    const after = Inv.itemSummary(db, item);
    assert.equal(after.on_hand, before.on_hand, 'reserving does not change physical possession');
    assert.equal(after.available, before.available - 10, 'reserved stock is no longer available to promise');
    assert.equal(after.reserved, before.reserved + 10);

    // Quarantined and customer-owned quantities are possession, never availability.
    const item2 = sku('CAP-35-5');
    const base = Inv.itemSummary(db, item2);
    Inv.receiveGoods(db, actors.mick, {
      supplier: 'Availability test',
      location_id: String(wh()),
      line_item_id: [String(item2)],
      line_qty_received: ['4'],
      line_condition: ['uncertain'],
      line_evidence: ['Unlabelled box'],
      line_next_action: ['Inspect before use'],
      line_next_owner: [String(actors.mick.id)],
    });
    const withQuarantine = Inv.itemSummary(db, item2);
    assert.equal(withQuarantine.on_hand, base.on_hand + 4);
    assert.equal(withQuarantine.available, base.available, 'quarantined goods are held but not available (RULE-008/010)');
  });

  it('holds quarantined receipts out of availability until assessed (AC-062)', () => {
    const { db, actors } = env;
    const item = sku('PSW-HP');
    const before = Inv.itemSummary(db, item).available;
    const receiptId = Inv.receiveGoods(db, actors.mick, {
      supplier: 'Test Supplier',
      location_id: String(wh()),
      line_item_id: [String(item), String(item)],
      line_qty_received: ['2', '3'],
      line_condition: ['good', 'damaged'],
      line_evidence: ['', 'Box crushed, switch body cracked'],
      line_next_action: ['', 'Claim from supplier'],
      line_next_owner: ['', String(actors.mick.id)],
    });
    const after = Inv.itemSummary(db, item);
    assert.equal(after.available, before + 2, 'only the good line becomes available');
    assert.equal(after.quarantined, 3);

    const line = one<{ id: number }>(db, `SELECT rl.id FROM receipt_lines rl WHERE rl.receipt_id = ? AND rl.condition = 'damaged'`, receiptId);
    Inv.resolveReceiptException(db, actors.mick, line.id, { outcome: 'release_available', qty: '3', note: 'Supplier sent replacements; originals inspected and sound' });
    assert.equal(Inv.itemSummary(db, item).available, before + 5);
    assert.equal(Inv.itemSummary(db, item).quarantined, 0);
  });

  it('requires assessment before returned material counts as available (AC-063-02)', () => {
    const { db, actors } = env;
    const item = sku('CAP-10');
    const van = one<{ id: number }>(db, `SELECT id FROM stock_locations WHERE code = 'VAN-TOM'`).id;
    const before = Inv.itemSummary(db, item);
    Inv.bookReturn(db, actors.tom, { item_id: String(item), qty: '2', location_id: String(van), note: 'Not needed, box opened' });
    const mid = Inv.itemSummary(db, item);
    assert.equal(mid.return_pending, before.return_pending + 2);
    assert.equal(mid.available, before.available, 'a return does not become available on its own');

    Inv.assessReturn(db, actors.mick, { item_id: String(item), location_id: String(van), owner_type: 'frostline', qty: '1', outcome: 'unused', note: 'Sealed and undamaged' });
    Inv.assessReturn(db, actors.mick, { item_id: String(item), location_id: String(van), owner_type: 'frostline', qty: '1', outcome: 'suspect', note: 'Unclear history — quarantine' });
    const after = Inv.itemSummary(db, item);
    assert.equal(after.available, before.available + 1);
    assert.equal(after.quarantined, before.quarantined + 1);
  });

  it('reallocates reserved stock only as an explicit, notified decision (RULE-009)', () => {
    const { db, actors } = env;
    const item = sku('DRIER-083');
    const jobA = newReadyJob();
    const jobB = newReadyJob();
    const resId = Inv.reserve(db, actors.mick, {
      item_id: String(item),
      location_id: String(wh()),
      qty: '2',
      job_id: String(jobA),
      purpose: 'Planned repair',
      owner_user_id: String(actors.dan.id),
      required_by: localIn(24 * 60),
      review_at: localIn(48 * 60),
      reallocation_consequence: 'Job A waits for a re-order',
    });
    assert.throws(() => Inv.reallocate(db, actors.leanne, resId, { to_job_id: String(jobB), qty: '1', reason: 'x', owner_user_id: String(actors.dan.id), required_by: localIn(60), reallocation_consequence: 'y', displaced_next_action: 'z' }), ForbiddenError);

    const notifiedBefore = count(db, `SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND kind = 'reallocation'`, actors.dan.id);
    Inv.reallocate(db, actors.mick, resId, {
      to_job_id: String(jobB),
      qty: '2',
      reason: 'Job B is a P1 with stock at risk',
      owner_user_id: String(actors.leanne.id),
      required_by: localIn(6 * 60),
      reallocation_consequence: 'Job B would stop again',
      displaced_next_action: 'Re-order drier and tell the customer the new date',
    });
    assert.equal(count(db, `SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND kind = 'reallocation'`, actors.dan.id), notifiedBefore + 1, 'the displaced owner is told');
    const displaced = J.getJob(db, jobA);
    assert.equal(displaced.ready_parts, 0, 'the displaced job is no longer parts-ready');
    assert.equal(displaced.next_action, 'Re-order drier and tell the customer the new date');
  });

  it('keeps evidence-held material out of stock and refuses casual disposal (AC-063-03)', () => {
    const slot = freeSlot();
    const { db, actors } = env;
    const id = newReadyJob();
    const att = Sched.assignAttendance(db, actors.dan, id, {
      engineer_user_id: String(actors.tom.id),
      planned_start: slot.start,
      planned_end: slot.end,
      commitment: 'provisional',
      override_ack: 'on',
      override_reason: 'test',
    });
    Sched.dispatchAttendance(db, actors.dan, att);
    A.progressAttendance(db, actors.tom, att, 'arrive');
    const holdId = Inv.createEvidenceHold(db, actors.tom, {
      description: 'Failed PCB',
      job_id: String(id),
      attendance_id: String(att),
      failure_evidence: 'No output from SMPS',
      condition_packaging: 'Anti-static bag, labelled',
      next_action: 'Log warranty claim',
      next_owner_user_id: String(actors.mick.id),
    });
    assert.throws(() => Inv.custodyAction(db, actors.tom, holdId, { action: 'disposed', detail: 'Binned it' }), ForbiddenError, 'engineers cannot dispose of held evidence');
    assert.throws(() => Inv.custodyAction(db, actors.mick, holdId, { action: 'disposed', detail: 'No longer needed' }), ForbiddenError, 'disposal follows the approval policy');
    Inv.custodyAction(db, actors.mick, holdId, { action: 'sent_to_supplier', detail: 'Returned for warranty assessment', reference: 'RMA-99' });
    const hold = Inv.getHold(db, holdId);
    assert.equal(hold.status, 'sent_to_supplier');
    assert.ok(hold.events.length >= 2, 'custody events accumulate');
    assert.throws(() => db.prepare('DELETE FROM custody_events WHERE hold_id = ?').run(holdId), /append-only/);
  });

  it('refuses to issue more than is available and never goes negative', () => {
    const { db, actors } = env;
    const item = sku('TXV-TES2');
    const available = Inv.itemSummary(db, item).available;
    assert.throws(
      () =>
        Inv.reserve(db, actors.mick, {
          item_id: String(item),
          location_id: String(wh()),
          qty: String(available + 1),
          purpose: 'Too many',
          owner_user_id: String(actors.mick.id),
          required_by: localIn(60),
          review_at: localIn(120),
          reallocation_consequence: 'n/a',
        }),
      ConflictError,
    );
    assert.equal(Inv.itemSummary(db, item).available, available, 'the failed reservation changed nothing');
    assert.equal(count(db, 'SELECT COUNT(*) n FROM stock_balances WHERE qty < 0'), 0);
  });
});

describe('audit trail (FR-030, NFR-006)', () => {
  it('is append-only and captures the reason for consequential decisions', () => {
    const { db, actors } = env;
    const id = newReadyJob();
    J.changePriority(db, actors.dan, id, { priority: 'P1', reason: 'Impact increased' });
    const row = one<{ id: number; reason: string; before_json: string; after_json: string }>(db, `SELECT * FROM audit_events WHERE entity_type = 'job' AND entity_id = ? AND action = 'priority_changed'`, id);
    assert.equal(row.reason, 'Impact increased');
    assert.ok(row.before_json.includes('P2') || row.before_json.includes('P3'));
    assert.throws(() => db.prepare('UPDATE audit_events SET reason = ? WHERE id = ?').run('changed', row.id), /append-only/);
    assert.throws(() => db.prepare('DELETE FROM audit_events WHERE id = ?').run(row.id), /append-only/);
  });
});
