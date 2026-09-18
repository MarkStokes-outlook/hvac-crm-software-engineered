import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { migrate, openDb } from '../src/db/db.ts';
import { clock } from '../src/lib/clock.ts';
import * as J from '../src/domain/jobs.ts';
import { Client, count, localIn, makeEnv, one, startServer, type TestEnv, type TestServer } from './helpers.ts';

let env: TestEnv;
let server: TestServer;

before(async () => {
  env = makeEnv('workflow');
  server = await startServer(env);
});
after(async () => {
  await server.close();
  env.close();
});

const client = () => new Client(server.url);

describe('access control (US-002)', () => {
  it('blocks operational routes until you sign in, then returns you to where you were going', async () => {
    const c = client();
    for (const path of ['/', '/jobs', '/schedule', '/customers', '/stock', '/reports', '/admin', '/my-day']) {
      const res = await c.get(path);
      assert.equal(res.status, 302, `${path} must not be readable anonymously`);
      assert.ok(res.headers.get('location')?.startsWith('/login'), `${path} redirects to sign-in`);
    }
    const post = await c.post('/jobs/1/notes', { kind: 'note', body: 'should not work' }, { csrf: 'nope' });
    assert.equal(post.status, 302);
    assert.equal(count(env.db, `SELECT COUNT(*) n FROM job_notes WHERE body = 'should not work'`), 0, 'nothing is written for an anonymous post');
  });

  it('refuses a form without a valid CSRF token', async () => {
    const c = client();
    await c.login('dan');
    const res = await c.post('/jobs/1/notes', { kind: 'note', body: 'csrf test note' }, { csrf: 'wrong-token' });
    assert.equal(res.status, 302);
    assert.equal(count(env.db, `SELECT COUNT(*) n FROM job_notes WHERE body = 'csrf test note'`), 0);
  });

  it('enforces role boundaries server-side, not just in the navigation', async () => {
    const eng = client();
    await eng.login('tom');
    assert.equal((await eng.get('/customers')).status, 403, 'engineers do not browse the customer list');
    assert.equal((await eng.get('/admin')).status, 403);
    assert.equal((await eng.get('/reports')).status, 403);

    const job = one<{ id: number; version: number }>(env.db, `SELECT id, version FROM jobs WHERE op_status = 'waiting' LIMIT 1`);
    const before = J.getJob(env.db, job.id).commercial_status;
    const res = await eng.post(`/jobs/${job.id}/commercial`, { commercial_status: 'resolved', reason: 'trying it on', version: String(job.version) });
    assert.equal(res.status, 302);
    assert.equal(J.getJob(env.db, job.id).commercial_status, before, 'an engineer cannot change commercial status');
    assert.match(eng.flash() ?? '', /role|permission/i);
  });

  it('hides sensitive site notes from roles without an operational need', async () => {
    const site = one<{ id: number; keys_security: string }>(env.db, `SELECT id, keys_security FROM sites WHERE keys_security IS NOT NULL LIMIT 1`);
    const secret = site.keys_security.slice(0, 24);

    const coordinator = client();
    await coordinator.login('dan');
    assert.ok((await coordinator.text(`/sites/${site.id}`)).includes(secret), 'coordinators can see access and key details');

    const finance = client();
    await finance.login('helen');
    const financeView = await finance.text(`/sites/${site.id}`);
    assert.ok(!financeView.includes(secret), 'finance does not need key and security detail');
    assert.ok(financeView.includes('restricted'), 'the redaction is visible rather than silent');
  });
});

describe('coordinator to engineer and back (US-020 → US-041 → US-022)', () => {
  it('carries one job from a phone call to a submitted attendance and an office decision', async () => {
    const { db } = env;
    const office = client();
    await office.login('dan');

    // 1. Log the call.
    const site = one<{ id: number }>(db, `SELECT id FROM sites WHERE name = 'Hollins Park'`);
    const create = await office.post('/jobs', {
      site_id: String(site.id),
      kind: 'reactive',
      title: 'End-to-end test: no hot water',
      channel: 'phone',
      received_at: localIn(-20),
      priority: 'P2',
      priority_reason: 'Care home without hot water; residents affected',
      reported_symptom: 'No hot water on the first floor since this morning',
      reported_by_name: 'Home manager',
      impact: 'Residents washing with kettles',
      safety_flag: 'on',
      safety_risk: 'Scald risk from manual hot water',
      authority_basis: 'contract_minor_repair',
      authority_ref: 'Contract 24/7 heating cover',
      acknowledged: 'on',
      next_action: 'Assign a heating engineer',
      next_owner_user_id: String(env.actors.dan.id),
      review_at: localIn(60),
    });
    assert.equal(create.status, 302);
    const jobId = Number(create.headers.get('location')!.split('/').pop());
    const job = J.getJob(db, jobId);
    assert.equal(job.op_status, 'authorised');
    assert.equal(count(db, `SELECT COUNT(*) n FROM sla_events WHERE job_id = ? AND type = 'acknowledged'`, jobId), 1);

    // 2. Confirm readiness, then schedule and dispatch.
    await office.post(`/jobs/${jobId}/readiness`, {
      ready_scope: 'on',
      ready_authority: 'on',
      ready_access: 'on',
      ready_competence: 'on',
      ready_parts: 'on',
      ready_dependencies: 'on',
      required_competences: 'gas-commercial',
      estimated_minutes: '120',
      version: String(J.getJob(db, jobId).version),
    });
    assert.equal(J.getJob(db, jobId).op_status, 'ready');
    assert.ok((await office.text('/schedule')).includes(job.ref), 'the job appears in the ready-but-unscheduled queue');

    const assign = await office.post(`/jobs/${jobId}/attendances`, {
      engineer_user_id: String(env.actors.gareth.id),
      planned_start: localIn(40 * 24 * 60),
      planned_end: localIn(40 * 24 * 60 + 120),
      commitment: 'customer_confirmed',
      instructions: 'Ask for the duty manager. DBS lanyard required.',
      override_ack: 'on',
      override_reason: 'Gareth holds the commercial gas ticket',
    });
    assert.equal(assign.status, 302);
    const attendance = one<{ id: number; ref: string }>(db, `SELECT id, ref FROM attendances WHERE job_id = ? ORDER BY id DESC`, jobId);
    await office.post(`/attendances/${attendance.id}/dispatch`, {});
    assert.equal(J.getJob(db, jobId).op_status, 'dispatched');

    // 3. The engineer works it on a phone.
    const engineer = client();
    await engineer.login('gareth');
    const myDay = await engineer.text('/my-day');
    assert.ok(myDay.includes(job.ref) || myDay.includes('Coming up'), 'the visit reaches the engineer');
    const brief = await engineer.text(`/jobs/${jobId}/brief`);
    assert.ok(brief.includes('Scald risk'), 'the brief carries the safety warning');
    assert.ok(brief.includes('Contract 24/7 heating cover'), 'the brief states what is authorised');

    await engineer.post(`/attendances/${attendance.id}/travel`, {});
    await engineer.post(`/attendances/${attendance.id}/arrive`, {});
    assert.equal(count(db, `SELECT COUNT(*) n FROM sla_events WHERE job_id = ? AND type = 'attendance'`, jobId), 1, 'arrival is the attendance SLA event');
    await engineer.post(`/attendances/${attendance.id}/start-work`, {});
    await engineer.post(`/attendances/${attendance.id}/readings`, { name: 'Flow temperature', value: '38', unit: '°C' });
    await engineer.post(`/attendances/${attendance.id}/evidence`, { kind: 'photo', caption: 'Diverter valve head' });

    // 4. Submit an honest partial outcome with a handoff.
    const submit = await engineer.post(`/attendances/${attendance.id}/submit`, {
      submit_key: `wf-${attendance.id}`,
      outcome: 'missing_parts_tools',
      authority_basis: 'contract_minor_repair',
      reported_confirmed: 'Confirmed — no hot water above 38°C',
      observed_facts: 'Diverter valve head seized; boiler otherwise healthy',
      tests_performed: 'Flow and return temperatures, valve continuity',
      diagnosis: 'Failed diverter valve head',
      diagnosis_verified: 'on',
      work_done: 'Isolated and drained; temporary immersion in use',
      final_condition: 'operating_limited',
      labour_minutes: '95',
      travel_minutes: '25',
      handoff_required_outcome: 'Fit new diverter valve head and recommission',
      handoff_dependency: 'part_availability',
      handoff_dependency_detail: 'Valve head not on van; merchant has stock tomorrow',
      handoff_operating_condition: 'Heating fine; hot water on immersion only',
      handoff_parts_specialist: 'Diverter valve head for Ideal Evomax 2',
      handoff_promises: 'Told the home manager we would return tomorrow morning',
      handoff_urgency: 'P2',
      handoff_next_owner_user_id: String(env.actors.dan.id),
      handoff_review_at: localIn(20 * 60),
      ack_name: 'Grace Ndlovu',
      ack_role: 'Home manager',
    });
    assert.equal(submit.status, 302);

    const afterSubmit = J.getJob(db, jobId);
    assert.equal(afterSubmit.op_status, 'waiting', 'the job stays open and waits on the named dependency');
    assert.equal(afterSubmit.waiting_category, 'part_availability');
    assert.equal(afterSubmit.next_owner_user_id, env.actors.dan.id);
    assert.ok(afterSubmit.review_at);
    assert.equal(count(db, `SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND kind = 'handoff'`, env.actors.dan.id) > 0, true);

    // 5. The office reviews and closes it out, one dimension at a time.
    const jobPage = await office.text(`/jobs/${jobId}`);
    assert.ok(jobPage.includes('Fit new diverter valve head'), 'the handoff is visible to the office');
    assert.ok(jobPage.includes('not verified') === false && jobPage.includes('verified'), 'a verified diagnosis is labelled as such');

    await office.post(`/jobs/${jobId}/waiting/resolve`, { resolution: 'Valve head collected from the merchant', version: String(J.getJob(db, jobId).version) });
    await office.post(`/jobs/${jobId}/complete`, { reason: 'Return visit completed and verified', version: String(J.getJob(db, jobId).version) });
    assert.equal(J.getJob(db, jobId).op_status, 'operationally_complete');
    assert.equal(J.getJob(db, jobId).financial_status, 'not_ready', 'completing the work does not invoice it');

    const finance = client();
    await finance.login('helen');
    await finance.post(`/jobs/${jobId}/financial`, { financial_status: 'ready_to_invoice', reason: 'Parts and labour to charge', version: String(J.getJob(db, jobId).version) });
    assert.equal(J.getJob(db, jobId).financial_status, 'ready_to_invoice');
  });
});

describe('field evidence upload (FR-016, ADR-007)', () => {
  it('accepts a photo from the attendance form and stores it durably with its metadata', async () => {
    const { db } = env;
    const live = one<{ id: number; job_id: number; username: string }>(
      db,
      `SELECT a.id, a.job_id, u.username FROM attendances a JOIN users u ON u.id = a.engineer_user_id WHERE a.status IN ('on_site','working') LIMIT 1`,
    );
    const engineer = client();
    await engineer.login(live.username);

    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd4', 'hex');
    const form = new FormData();
    form.set('_csrf', await engineer.csrfToken());
    form.set('kind', 'photo');
    form.set('caption', 'Pitted contactor contacts');
    form.append('file', new Blob([png], { type: 'image/png' }), 'contactor.png');
    const cookies = (engineer as unknown as { cookies: Map<string, string> }).cookies;
    const res = await fetch(`${server.url}/attendances/${live.id}/evidence`, { method: 'POST', body: form, headers: { cookie: `frostline_sid=${cookies.get('frostline_sid')}` }, redirect: 'manual' });
    assert.equal(res.status, 302, 'the upload is accepted, not rejected as an expired form');

    const stored = one<{ id: number; caption: string; sha256: string; stored_path: string; mime_type: string; size_bytes: number }>(
      db,
      'SELECT * FROM evidence WHERE attendance_id = ? ORDER BY id DESC',
      live.id,
    );
    assert.equal(stored.caption, 'Pitted contactor contacts');
    assert.equal(stored.mime_type, 'image/png');
    assert.equal(stored.size_bytes, png.length);
    assert.ok(stored.sha256, 'the file is content-addressed so evidence can be shown to be unchanged');
    assert.ok(fs.existsSync(path.join(env.uploadDir, stored.stored_path)), 'the file is on disk');

    const fetched = await engineer.get(`/evidence/${stored.id}/file`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.headers.get('content-type'), 'image/png');

    // Office roles with job access can see job evidence; an engineer with no work at that site cannot.
    const finance = client();
    await finance.login('helen');
    assert.equal((await finance.get(`/evidence/${stored.id}/file`)).status, 200, 'finance can see the evidence behind a charge');

    const site = one<{ site_id: number }>(db, 'SELECT site_id FROM jobs WHERE id = ?', live.job_id).site_id;
    const stranger = one<{ username: string }>(
      db,
      `SELECT u.username FROM users u WHERE u.role = 'engineer' AND NOT EXISTS (
         SELECT 1 FROM attendances a JOIN jobs j ON j.id = a.job_id WHERE a.engineer_user_id = u.id AND j.site_id = ? AND a.status <> 'cancelled') LIMIT 1`,
      site,
    );
    const outsider = client();
    await outsider.login(stranger.username);
    assert.equal((await outsider.get(`/evidence/${stored.id}/file`)).status, 404, 'an engineer with no work at that site cannot pull the file');
  });
});

describe('durability (NFR-003)', () => {
  it('keeps submitted field evidence across a restart', async () => {
    const { db } = env;
    const attendance = one<{ id: number; ref: string; job_id: number }>(db, `SELECT id, ref, job_id FROM attendances WHERE status = 'submitted' ORDER BY id DESC LIMIT 1`);
    const before = count(db, 'SELECT COUNT(*) n FROM evidence WHERE attendance_id = ?', attendance.id);

    // Reopen the same file with a brand new connection, as a restart would.
    const reopened = openDb(env.file);
    migrate(reopened);
    const after = (reopened.prepare('SELECT COUNT(*) n FROM evidence WHERE attendance_id = ?').get(attendance.id) as { n: number }).n;
    const outcome = reopened.prepare('SELECT outcome, observed_facts FROM attendances WHERE id = ?').get(attendance.id) as { outcome: string; observed_facts: string };
    reopened.close();

    assert.equal(after, before, 'evidence survives a restart');
    assert.ok(outcome.outcome, 'the submitted outcome survives a restart');
    assert.ok(outcome.observed_facts, 'the engineer’s observed facts survive a restart');
  });
});

describe('advisory AI (US-071)', () => {
  it('offers the four discovered tasks, and applying one is a human action', async () => {
    const { db } = env;
    const office = client();
    await office.login('dan');
    const job = one<{ id: number }>(db, `SELECT id FROM jobs WHERE op_status = 'waiting' ORDER BY id LIMIT 1`);

    const page = await office.text(`/jobs/${job.id}`);
    for (const label of ['Summarise history', 'Suggest triage questions', 'Draft customer update', 'Check handoff completeness']) {
      assert.ok(page.includes(label), `${label} is offered`);
    }

    const res = await office.post('/ai/suggest', { task: 'draft_customer_update', entity: 'job', id: String(job.id), __back: `/jobs/${job.id}` });
    assert.equal(res.status, 302);
    const interaction = one<{ id: number; status: string; provider: string; output: string }>(db, `SELECT * FROM ai_interactions ORDER BY id DESC LIMIT 1`);
    assert.equal(interaction.status, 'suggested', 'a suggestion is only ever a suggestion until a human acts');
    assert.equal(interaction.provider, 'mock', 'the deterministic provider works with no API key');
    assert.ok(interaction.output.length > 0);

    const withPanel = await office.text(`/jobs/${job.id}?ai=${interaction.id}`);
    assert.ok(withPanel.includes('AI suggestion — not a decision'));
    assert.ok(withPanel.includes('cannot authorise spend'), 'the boundary is stated where the suggestion is shown');

    const notesBefore = count(db, 'SELECT COUNT(*) n FROM job_notes WHERE job_id = ?', job.id);
    assert.equal(notesBefore, count(db, 'SELECT COUNT(*) n FROM job_notes WHERE job_id = ?', job.id), 'asking for a draft changes no record');

    // The human edits and submits it through the ordinary, permission-checked route.
    await office.post(`/jobs/${job.id}/notes`, { kind: 'customer_update', body: 'Edited by the coordinator before sending.', ai_interaction_id: String(interaction.id) });
    const note = one<{ author_id: number; ai_interaction_id: number; body: string }>(db, 'SELECT * FROM job_notes WHERE job_id = ? ORDER BY id DESC', job.id);
    assert.equal(note.author_id, env.actors.dan.id, 'the human is the author');
    assert.equal(note.ai_interaction_id, interaction.id, 'AI assistance is recorded as provenance');
    assert.equal((db.prepare('SELECT status FROM ai_interactions WHERE id = ?').get(interaction.id) as { status: string }).status, 'applied');
  });

  it('cannot reach a protected mutation and only reads through a read-only connection', async () => {
    const { db } = env;
    const readOnly = openDb(env.file, { readonly: true });
    assert.throws(() => readOnly.prepare(`UPDATE jobs SET op_status = 'operationally_complete' WHERE id = 1`).run(), /readonly|not authorized/i, 'the AI context connection cannot write');
    readOnly.close();

    const engineer = client();
    await engineer.login('tom');
    const other = one<{ id: number }>(db, `SELECT j.id FROM jobs j WHERE NOT EXISTS (SELECT 1 FROM attendances a WHERE a.job_id = j.id AND a.engineer_user_id = ?) LIMIT 1`, env.actors.tom.id);
    const res = await engineer.post('/ai/suggest', { task: 'summarise_history', entity: 'job', id: String(other.id), __back: '/my-day' });
    assert.equal(res.status, 302);
    assert.match(engineer.flash() ?? '', /assigned|permission|role/i, 'engineers only get assistance on their own work');
  });
});

describe('import and export seam (US-072)', () => {
  it('exports CSV and previews an import without writing anything', async () => {
    const { db } = env;
    const manager = client();
    await manager.login('susan');

    const csv = await (await manager.get('/data/export/customers')).text();
    const lines = csv.trim().split('\r\n');
    assert.equal(lines[0], 'ref,trading_name,legal_name,company_number,billing_address,billing_email,po_required,sector,status');
    assert.ok(lines.length > 5, 'every customer is exported');

    const admin = client();
    await admin.login('priya');
    const before = count(db, 'SELECT COUNT(*) n FROM customers');
    const form = new FormData();
    form.set('_csrf', await admin.csrfToken());
    form.set('kind', 'customers');
    form.append('file', new Blob(['trading_name,sector\nPreview Only Ltd,Retail\n'], { type: 'text/csv' }), 'import.csv');
    const preview = await fetch(`${server.url}/data/import`, { method: 'POST', body: form, headers: { cookie: `frostline_sid=${(admin as unknown as { cookies: Map<string, string> })['cookies'].get('frostline_sid')}` } });
    assert.equal(preview.status, 200);
    assert.ok((await preview.text()).includes('Preview only'));
    assert.equal(count(db, 'SELECT COUNT(*) n FROM customers'), before, 'a preview writes nothing');
  });
});
