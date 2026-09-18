import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client, localIn, makeEnv, one, startServer, type TestEnv, type TestServer } from './helpers.ts';

/**
 * Exercises every state-changing route through the HTTP layer with the field names the forms
 * actually submit, so a mismatch between a form and its domain service cannot go unnoticed.
 * Each step asserts on the flash message the application gave the user.
 */
let env: TestEnv;
let server: TestServer;
before(async () => {
  env = makeEnv('routes');
  server = await startServer(env);
});
after(async () => {
  await server.close();
  env.close();
});

const REFUSAL = /cannot|not permitted|required|expired|invalid|must |blocked|unknown|already|refus/i;

describe('every action route accepts what its form sends', () => {
  it('walks the commercial, stock, admin and service actions end to end', async () => {
    const results: string[] = [];
    const check = async (label: string, c: Client, fn: () => Promise<Response>) => {
      const res = await fn();
      const flash = c.flash() ?? '';
      assert.ok(res.status === 302 || res.status === 200, `${label}: unexpected status ${res.status}`);
      assert.ok(flash, `${label}: the application said nothing back`);
      assert.ok(!REFUSAL.test(flash), `${label} was refused: ${flash}`);
      results.push(`${label}: ${flash}`);
    };
    const { db } = env;

  // --- quotes: full commercial journey through the UI
  const est = new Client(server.url); await est.login('rachel');
  const mgr = new Client(server.url); await mgr.login('susan');
  const cust = one<{ id: number }>(db, `SELECT id FROM customers WHERE trading_name = 'Irwell Leisure'`).id;
  const site = one<{ id: number }>(db, 'SELECT id FROM sites WHERE customer_id = ?', cust).id;
  await check('create opportunity', est, () => est.post('/quotes', { customer_id: String(cust), site_id: String(site), title: 'UI probe works', source: 'enquiry', estimate_basis: 'developed_estimate', owner_user_id: String(env.actors.rachel.id) }));
  const opp = one<{ id: number }>(db, 'SELECT id FROM opportunities ORDER BY id DESC').id;
  const rev = one<{ id: number }>(db, 'SELECT id FROM quote_revisions WHERE opportunity_id = ?', opp).id;
  await check('save draft', est, () => est.post(`/revisions/${rev}`, { scope: 'Replace gym unit', assumptions: 'Access out of hours', exclusions: 'Electrical', payment_terms: '30 days', acceptance_method: 'PO', vat_rate: '20', valid_until: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10) }));
  await check('add line', est, () => est.post(`/revisions/${rev}/lines`, { line_type: 'equipment', description: 'Ducted unit', qty: '1', unit_price: '3200.00' }));
  await check('add option line', est, () => est.post(`/revisions/${rev}/lines`, { option_code: 'A', line_type: 'other', description: 'Out of hours', qty: '1', unit_price: '450.00' }));
  await check('approve (manager)', mgr, () => mgr.post(`/revisions/${rev}/approve`, { reason: 'Checked' }));
  await check('issue', est, () => est.post(`/revisions/${rev}/issue`, { note: 'Emailed' }));
  await check('record acceptance', est, () => est.post(`/revisions/${rev}/acceptance`, {
    confirm_revision: '1', accepting_party: 'Gary Nuttall', acceptance_evidence: 'Email', options: ['A'],
    chk_authority: 'on', chk_authority_note: 'Facilities officer', chk_revision_options: 'on', chk_po_value: 'on', po_number: 'PO-77', po_value: '3650.00',
    chk_terms: 'on', chk_dates: 'on', chk_validity_pricing: 'on', credit_deposit: 'not_required',
  }));
  const acc = one<{ id: number }>(db, 'SELECT id FROM acceptances ORDER BY id DESC').id;
  await check('release (manager)', mgr, () => mgr.post(`/acceptances/${acc}/release`, { target: 'job', reason: 'All checks complete', owner_user_id: String(env.actors.dan.id) }));

  // --- stock: reserve, reallocate, receipt, return assessment, custody
  const wh = one<{ id: number }>(db, `SELECT id FROM stock_locations WHERE code = 'WH-BURY'`).id;
  const item = one<{ id: number }>(db, `SELECT id FROM stock_items WHERE sku = 'FLT-BAG-F7'`).id;
  const job = one<{ id: number }>(db, `SELECT id FROM jobs WHERE op_status NOT IN ('operationally_complete','cancelled') LIMIT 1`).id;
  const job2 = one<{ id: number }>(db, `SELECT id FROM jobs WHERE op_status NOT IN ('operationally_complete','cancelled') AND id <> ? LIMIT 1`, job).id;
  const mick = new Client(server.url); await mick.login('mick');
  await check('reserve stock', mick, () => mick.post('/reservations', { item_id: String(item), location_id: String(wh), qty: '3', job_id: String(job), purpose: 'Probe', owner_user_id: String(env.actors.dan.id), required_by: localIn(60), review_at: localIn(600), reallocation_consequence: 'Job waits' }));
  const res1 = one<{ id: number }>(db, 'SELECT id FROM reservations ORDER BY id DESC').id;
  await check('reallocate stock', mick, () => mick.post(`/reservations/${res1}/reallocate`, { to_job_id: String(job2), qty: '1', reason: 'Higher priority', owner_user_id: String(env.actors.leanne.id), required_by: localIn(120), reallocation_consequence: 'Other job waits', displaced_next_action: 'Re-order' }));
  await check('transfer stock', mick, () => mick.post('/stock/transfers', { item_id: String(item), from_location_id: String(wh), to_location_id: String(one<{id:number}>(db, `SELECT id FROM stock_locations WHERE code='VAN-SAM'`).id), qty: '2', reason: 'Replenish' }));
  await check('goods receipt', mick, () => mick.post('/stock/receipts', { supplier: 'Probe Supplies', po_ref: 'PO-1', location_id: String(wh), line_item_id: [String(item), String(item)], line_qty_received: ['5', '2'], line_condition: ['good', 'damaged'], line_evidence: ['', 'Crushed'], line_impact: ['', 'None'], line_next_action: ['', 'Claim'], line_next_owner: ['', String(env.actors.mick.id)], line_return_deadline: ['', ''], line_qty_expected: ['5','2'], line_job_id: ['',''] }));
  const line = one<{ id: number }>(db, `SELECT id FROM receipt_lines WHERE exception_status = 'open' ORDER BY id DESC`).id;
  await check('resolve receipt exception', mick, () => mick.post(`/receipt-lines/${line}/resolve`, { outcome: 'release_available', qty: '2', note: 'Inspected, sound' }));
  const pend = db.prepare(`SELECT item_id, location_id, owner_type, owner_ref, qty FROM stock_balances WHERE state='return_pending' AND qty>0 LIMIT 1`).get() as any;
  if (pend) await check('assess return', mick, () => mick.post('/stock/returns/assess', { item_id: String(pend.item_id), location_id: String(pend.location_id), owner_type: pend.owner_type, owner_ref: String(pend.owner_ref), qty: '1', outcome: 'unused', note: 'Sealed' }));
  const hold = one<{ id: number }>(db, `SELECT id FROM evidence_holds WHERE status='held' LIMIT 1`).id;
  await check('custody action', mick, () => mick.post(`/stock/holds/${hold}/action`, { action: 'sent_to_supplier', detail: 'Returned for assessment', reference: 'RMA-1' }));

  // --- admin
  const admin = new Client(server.url); await admin.login('priya');
  await check('save setting', admin, () => admin.post('/admin/settings', { key: 'sla_at_risk_fraction', value: '0.3' }));
  await check('save policy', admin, () => admin.post('/admin/policies', { action: 'quote.approve', role: 'estimator', max_value: '5000.00', notes: 'Board decision 2026-09' }));
  await check('add competence', admin, () => admin.post(`/admin/users/${env.actors.sam.id}/competences`, { tag: 'controls', detail: 'BMS course', valid_to: '2028-01-01' }));
  await check('add user', admin, () => admin.post('/admin/users', { display_name: 'Probe Person', username: 'probe', role: 'coordinator', password: 'probe12345', active: 'on' }));
  await check('update outcome code', admin, () => admin.post('/admin/outcome-codes', { code: 'no_access', label: 'No access (revised)', active: 'on' }));

  // --- job actions not yet exercised over HTTP
  const dan = new Client(server.url); await dan.login('dan');
  const jrow = one<{ id: number; version: number }>(db, `SELECT id, version FROM jobs WHERE op_status = 'ready' LIMIT 1`);
  await check('sla event', dan, () => dan.post(`/jobs/${jrow.id}/sla/event`, { type: 'response', note: 'Called back' }));
  await check('set waiting', dan, () => dan.post(`/jobs/${jrow.id}/waiting`, { waiting_category: 'customer_approval', waiting_detail: 'Awaiting go-ahead', next_action: 'Chase', next_owner_user_id: String(env.actors.dan.id), review_at: localIn(120), version: String(jrow.version) }));
  const contracted = one<{ id: number; version: number }>(db, `SELECT j.id, j.version FROM jobs j JOIN contracts k ON k.id = j.contract_id WHERE k.clock_stop_permitted = 1 AND j.op_status NOT IN ('operationally_complete','cancelled') AND NOT EXISTS (SELECT 1 FROM clock_stops c WHERE c.job_id = j.id AND c.ended_at IS NULL) LIMIT 1`);
  await check('clock stop', dan, () => dan.post(`/jobs/${contracted.id}/clock-stop`, { reason_category: 'customer_delay', contractual_basis: 'Clause 4', dependency_detail: 'Customer deciding', evidence: 'Email', expected_actor: 'Customer', owner_user_id: String(env.actors.dan.id), chase_at: localIn(240) }));
  const stop = one<{ id: number }>(db, 'SELECT id FROM clock_stops WHERE ended_at IS NULL ORDER BY id DESC').id;
  await check('clock restart', dan, () => dan.post(`/clock-stops/${stop}/end`, { end_note: 'Customer approved' }));
  await check('variation', dan, () => dan.post('/variations', { job_id: String(job), classification: 'customer_change', description: 'Extra unit', scope_impact: 'One more unit', value_impact: '250.00' }));
  const v = one<{ id: number }>(db, 'SELECT id FROM variations ORDER BY id DESC').id;
  await check('variation decision (manager)', mgr, () => mgr.post(`/variations/${v}/decide`, { decision: 'approved', reason: 'Customer agreed' }));

    assert.ok(results.length >= 25, 'every probed action reported success');
  });
});
