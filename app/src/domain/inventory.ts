import type { DB } from '../db/db.ts';
import { tx } from '../db/db.ts';
import { type Actor, requireApproval, requireCap } from '../auth/policy.ts';
import { audit, notify } from './audit.ts';
import { clock } from '../lib/clock.ts';
import { ConflictError, DomainError, ForbiddenError, NotFoundError } from '../lib/errors.ts';
import { Form } from '../lib/form.ts';
import { nextRef } from '../lib/refs.ts';
import { getAttendance } from './scheduling.ts';

export const STOCK_STATES = ['available', 'reserved', 'picked', 'quarantined', 'return_pending', 'evidence_hold', 'obsolete'] as const;
export type StockState = (typeof STOCK_STATES)[number];
export type OwnerType = 'frostline' | 'customer' | 'job';
export const STATE_LABEL: Record<StockState, string> = {
  available: 'Available',
  reserved: 'Reserved',
  picked: 'Picked',
  quarantined: 'Quarantined',
  return_pending: 'Return pending assessment',
  evidence_hold: 'Evidence hold',
  obsolete: 'Obsolete',
};
export const RECEIPT_CONDITIONS = ['good', 'damaged', 'incorrect', 'uncertain'] as const;
export const RETURN_OUTCOMES = ['unused', 'opened', 'damaged', 'contaminated', 'suspect', 'customer_owned', 'warranty_return', 'disposal'] as const;
export const RETURN_OUTCOME_LABEL: Record<(typeof RETURN_OUTCOMES)[number], string> = {
  unused: 'Unused — return to available',
  opened: 'Opened — quarantine for inspection',
  damaged: 'Damaged — quarantine',
  contaminated: 'Contaminated — quarantine',
  suspect: 'Suspect — quarantine',
  customer_owned: 'Customer-owned — hold for customer',
  warranty_return: 'Warranty return — evidence hold',
  disposal: 'Disposal (authorised)',
};

interface BalanceKey {
  item_id: number;
  location_id: number;
  state: StockState;
  owner_type?: OwnerType;
  owner_ref?: number;
}

/**
 * Atomic conditional decrement: succeeds only if enough quantity exists in exactly this
 * bucket at the moment of the write. Combined with BEGIN IMMEDIATE and the qty >= 0 CHECK,
 * concurrent issues/reservations can never drive legitimate availability negative (AC-060-02).
 */
function take(db: DB, k: BalanceKey, qty: number, what = 'stock') {
  const r = db
    .prepare(`UPDATE stock_balances SET qty = qty - ? WHERE item_id = ? AND location_id = ? AND state = ? AND owner_type = ? AND owner_ref = ? AND qty >= ?`)
    .run(qty, k.item_id, k.location_id, k.state, k.owner_type ?? 'frostline', k.owner_ref ?? 0, qty);
  if (r.changes !== 1) {
    const have = bucketQty(db, k);
    throw new ConflictError(`Not enough ${what}: ${have} ${STATE_LABEL[k.state].toLowerCase()} at this location, ${qty} requested. Someone may have just used it — refresh and re-check.`);
  }
}

function put(db: DB, k: BalanceKey, qty: number) {
  db.prepare(
    `INSERT INTO stock_balances (item_id, location_id, state, owner_type, owner_ref, qty) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (item_id, location_id, state, owner_type, owner_ref) DO UPDATE SET qty = qty + excluded.qty`,
  ).run(k.item_id, k.location_id, k.state, k.owner_type ?? 'frostline', k.owner_ref ?? 0, qty);
}

function bucketQty(db: DB, k: BalanceKey): number {
  return (
    (db
      .prepare(`SELECT qty FROM stock_balances WHERE item_id = ? AND location_id = ? AND state = ? AND owner_type = ? AND owner_ref = ?`)
      .get(k.item_id, k.location_id, k.state, k.owner_type ?? 'frostline', k.owner_ref ?? 0) as { qty: number } | undefined)?.qty ?? 0
  );
}

interface MovementInput {
  movement_type: string;
  item_id: number;
  qty: number;
  from_location_id?: number | null;
  from_state?: string | null;
  to_location_id?: number | null;
  to_state?: string | null;
  owner_type?: OwnerType;
  owner_ref?: number;
  job_id?: number | null;
  attendance_id?: number | null;
  reservation_id?: number | null;
  receipt_line_id?: number | null;
  recipient?: string | null;
  serial_batch?: string | null;
  reason?: string | null;
  idem_key?: string | null;
}

function movement(db: DB, actor: Actor, m: MovementInput): number {
  const r = db
    .prepare(
      `INSERT INTO stock_movements (movement_type, item_id, qty, from_location_id, from_state, to_location_id, to_state, owner_type, owner_ref, job_id, attendance_id,
         reservation_id, receipt_line_id, recipient, serial_batch, reason, actor_id, at, idem_key)
       VALUES (@movement_type, @item_id, @qty, @from_location_id, @from_state, @to_location_id, @to_state, @owner_type, @owner_ref, @job_id, @attendance_id,
         @reservation_id, @receipt_line_id, @recipient, @serial_batch, @reason, @actor, @at, @idem_key)`,
    )
    .run({
      from_location_id: null,
      from_state: null,
      to_location_id: null,
      to_state: null,
      owner_type: 'frostline',
      owner_ref: 0,
      job_id: null,
      attendance_id: null,
      reservation_id: null,
      receipt_line_id: null,
      recipient: null,
      serial_batch: null,
      reason: null,
      idem_key: null,
      ...m,
      actor: actor.id,
      at: clock.iso(),
    });
  return Number(r.lastInsertRowid);
}

function idemSeen(db: DB, key: string | null): boolean {
  return !!key && !!db.prepare('SELECT 1 FROM stock_movements WHERE idem_key = ?').get(key);
}

// ------------------------------------------------------------------ read models (US-060)

export interface ItemSummary {
  id: number;
  sku: string;
  name: string;
  category: string | null;
  unit: string;
  manufacturer: string | null;
  part_number: string | null;
  min_level: number | null;
  on_hand: number;
  available: number;
  reserved: number;
  picked: number;
  quarantined: number;
  return_pending: number;
  evidence_hold: number;
  obsolete: number;
  customer_owned: number;
  job_specific: number;
}

const SUMMARY_COLS = `
  COALESCE(SUM(b.qty), 0) AS on_hand,
  COALESCE(SUM(CASE WHEN b.state = 'available' AND b.owner_type = 'frostline' THEN b.qty END), 0) AS available,
  COALESCE(SUM(CASE WHEN b.state = 'reserved' THEN b.qty END), 0) AS reserved,
  COALESCE(SUM(CASE WHEN b.state = 'picked' THEN b.qty END), 0) AS picked,
  COALESCE(SUM(CASE WHEN b.state = 'quarantined' THEN b.qty END), 0) AS quarantined,
  COALESCE(SUM(CASE WHEN b.state = 'return_pending' THEN b.qty END), 0) AS return_pending,
  COALESCE(SUM(CASE WHEN b.state = 'evidence_hold' THEN b.qty END), 0) AS evidence_hold,
  COALESCE(SUM(CASE WHEN b.state = 'obsolete' THEN b.qty END), 0) AS obsolete,
  COALESCE(SUM(CASE WHEN b.owner_type = 'customer' THEN b.qty END), 0) AS customer_owned,
  COALESCE(SUM(CASE WHEN b.owner_type = 'job' THEN b.qty END), 0) AS job_specific`;

export function stockSummary(db: DB, opts: { q?: string; locationId?: number; exceptions?: boolean; limit?: number; offset?: number } = {}) {
  const where: string[] = ['i.active = 1'];
  const params: unknown[] = [];
  if (opts.q) {
    const like = `%${opts.q}%`;
    where.push('(i.sku LIKE ? OR i.name LIKE ? OR i.part_number LIKE ? OR i.manufacturer LIKE ?)');
    params.push(like, like, like, like);
  }
  const locJoin = opts.locationId ? 'AND b.location_id = ?' : '';
  const having = opts.exceptions ? `HAVING quarantined > 0 OR return_pending > 0 OR evidence_hold > 0 OR (i.min_level IS NOT NULL AND available < i.min_level)` : '';
  const sql = `SELECT i.id, i.sku, i.name, i.category, i.unit, i.manufacturer, i.part_number, i.min_level, ${SUMMARY_COLS}
    FROM stock_items i LEFT JOIN stock_balances b ON b.item_id = i.id ${locJoin}
    WHERE ${where.join(' AND ')} GROUP BY i.id ${having} ORDER BY i.category, i.name`;
  const all = db.prepare(sql).all(...(opts.locationId ? [opts.locationId] : []), ...params) as ItemSummary[];
  return { total: all.length, rows: all.slice(opts.offset ?? 0, (opts.offset ?? 0) + (opts.limit ?? 100)) };
}

export function itemSummary(db: DB, itemId: number): ItemSummary {
  const row = db.prepare(`SELECT i.*, ${SUMMARY_COLS} FROM stock_items i LEFT JOIN stock_balances b ON b.item_id = i.id WHERE i.id = ? GROUP BY i.id`).get(itemId) as ItemSummary | undefined;
  if (!row) throw new NotFoundError('Stock item');
  return row;
}

export function balancesForItem(db: DB, itemId: number) {
  return db
    .prepare(
      `SELECT b.*, l.code AS location_code, l.name AS location_name, l.kind AS location_kind,
         CASE b.owner_type WHEN 'customer' THEN (SELECT trading_name FROM customers WHERE id = b.owner_ref) WHEN 'job' THEN (SELECT ref FROM jobs WHERE id = b.owner_ref) END AS owner_label
       FROM stock_balances b JOIN stock_locations l ON l.id = b.location_id WHERE b.item_id = ? AND b.qty > 0 ORDER BY l.kind, l.code, b.state`,
    )
    .all(itemId) as { location_id: number; location_code: string; location_name: string; location_kind: string; state: StockState; owner_type: OwnerType; owner_ref: number; owner_label: string | null; qty: number }[];
}

export function availableAt(db: DB, itemId: number, locationId: number): number {
  return bucketQty(db, { item_id: itemId, location_id: locationId, state: 'available' });
}

export function movementsFor(db: DB, where: { itemId?: number; jobId?: number }, limit = 100) {
  return db
    .prepare(
      `SELECT m.*, i.sku, i.name AS item_name, fl.code AS from_code, tl.code AS to_code, u.display_name AS actor_name, j.ref AS job_ref, r.ref AS reservation_ref
       FROM stock_movements m JOIN stock_items i ON i.id = m.item_id LEFT JOIN stock_locations fl ON fl.id = m.from_location_id LEFT JOIN stock_locations tl ON tl.id = m.to_location_id
       JOIN users u ON u.id = m.actor_id LEFT JOIN jobs j ON j.id = m.job_id LEFT JOIN reservations r ON r.id = m.reservation_id
       WHERE ${where.itemId ? 'm.item_id = ?' : 'm.job_id = ?'} ORDER BY m.at DESC, m.id DESC LIMIT ?`,
    )
    .all(where.itemId ?? where.jobId, limit) as {
    id: number;
    movement_type: string;
    sku: string;
    item_name: string;
    qty: number;
    from_code: string | null;
    from_state: string | null;
    to_code: string | null;
    to_state: string | null;
    owner_type: string;
    actor_name: string;
    job_ref: string | null;
    reservation_ref: string | null;
    recipient: string | null;
    serial_batch: string | null;
    reason: string | null;
    at: string;
  }[];
}

export function locations(db: DB) {
  return db
    .prepare(`SELECT l.*, u.display_name AS engineer_name FROM stock_locations l LEFT JOIN users u ON u.id = l.engineer_user_id WHERE l.active = 1 ORDER BY l.kind <> 'warehouse', l.code`)
    .all() as { id: number; code: string; name: string; kind: string; engineer_user_id: number | null; engineer_name: string | null }[];
}

export function items(db: DB) {
  return db.prepare(`SELECT id, sku, name, unit FROM stock_items WHERE active = 1 ORDER BY name`).all() as { id: number; sku: string; name: string; unit: string }[];
}

export interface Reservation {
  id: number;
  ref: string;
  item_id: number;
  location_id: number;
  qty: number;
  qty_outstanding: number;
  job_id: number | null;
  project_id: number | null;
  customer_id: number | null;
  purpose: string;
  requested_by: number;
  owner_user_id: number;
  required_by: string;
  review_at: string;
  substitution_allowed: number;
  reallocation_consequence: string;
  status: string;
  created_at: string;
  closed_at: string | null;
  closed_reason: string | null;
  sku?: string;
  item_name?: string;
  location_code?: string;
  job_ref?: string | null;
  owner_name?: string;
  requested_by_name?: string;
  customer_name?: string | null;
}

const RES_SELECT = `SELECT r.*, i.sku, i.name AS item_name, l.code AS location_code, j.ref AS job_ref, o.display_name AS owner_name, q.display_name AS requested_by_name, c.trading_name AS customer_name
  FROM reservations r JOIN stock_items i ON i.id = r.item_id JOIN stock_locations l ON l.id = r.location_id LEFT JOIN jobs j ON j.id = r.job_id
  JOIN users o ON o.id = r.owner_user_id JOIN users q ON q.id = r.requested_by LEFT JOIN customers c ON c.id = r.customer_id`;

export function reservationsFor(db: DB, where: { itemId?: number; jobId?: number; active?: boolean }) {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (where.itemId) {
    conds.push('r.item_id = ?');
    params.push(where.itemId);
  }
  if (where.jobId) {
    conds.push('r.job_id = ?');
    params.push(where.jobId);
  }
  if (where.active) conds.push(`r.status IN ('active','picked')`);
  return db.prepare(`${RES_SELECT} ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''} ORDER BY r.required_by`).all(...params) as Reservation[];
}

export function getReservation(db: DB, id: number): Reservation {
  const r = db.prepare(`${RES_SELECT} WHERE r.id = ?`).get(id) as Reservation | undefined;
  if (!r) throw new NotFoundError('Reservation');
  return r;
}

// ------------------------------------------------------------------ reservation (US-061)

export function reserve(db: DB, actor: Actor, body: Record<string, unknown>): number {
  requireCap(actor, 'stock.reserve');
  const f = new Form(body);
  const d = {
    item_id: f.reqInt('item_id', 'Item'),
    location_id: f.reqInt('location_id', 'Location'),
    qty: f.reqInt('qty', 'Quantity', { min: 1, max: 100000 }),
    job_id: f.int('job_id', 'Job'),
    purpose: f.str('purpose', 'Purpose', 1000),
    owner_user_id: f.reqInt('owner_user_id', 'Accountable owner'),
    required_by: f.reqDt('required_by', 'Required by'),
    review_at: f.reqDt('review_at', 'Review / expiry'),
    substitution_allowed: f.bool('substitution_allowed') ? 1 : 0,
    reallocation_consequence: f.str('reallocation_consequence', 'Consequence if reallocated', 1000),
  };
  const idem = f.opt('idem_key', 100);
  f.done();
  return tx(db, () => {
    if (idemSeen(db, idem)) {
      const m = db.prepare('SELECT reservation_id FROM stock_movements WHERE idem_key = ?').get(idem) as { reservation_id: number };
      return m.reservation_id;
    }
    let customerId: number | null = null;
    if (d.job_id) {
      const j = db.prepare('SELECT customer_id, op_status FROM jobs WHERE id = ?').get(d.job_id) as { customer_id: number; op_status: string } | undefined;
      if (!j) throw new NotFoundError('Job');
      if (['operationally_complete', 'cancelled'].includes(j.op_status)) throw new DomainError('Cannot reserve for a closed job.');
      customerId = j.customer_id;
    }
    take(db, { item_id: d.item_id, location_id: d.location_id, state: 'available' }, d.qty, 'available stock');
    put(db, { item_id: d.item_id, location_id: d.location_id, state: 'reserved' }, d.qty);
    const ref = nextRef(db, 'RS', 500);
    const r = db
      .prepare(
        `INSERT INTO reservations (ref, item_id, location_id, qty, qty_outstanding, job_id, customer_id, purpose, requested_by, owner_user_id, required_by, review_at,
           substitution_allowed, reallocation_consequence, status, created_at)
         VALUES (@ref, @item_id, @location_id, @qty, @qty, @job_id, @customer_id, @purpose, @actor, @owner_user_id, @required_by, @review_at,
           @substitution_allowed, @reallocation_consequence, 'active', @now)`,
      )
      .run({ ...d, ref, customer_id: customerId, actor: actor.id, now: clock.iso() });
    const id = Number(r.lastInsertRowid);
    movement(db, actor, {
      movement_type: 'reserve',
      item_id: d.item_id,
      qty: d.qty,
      from_location_id: d.location_id,
      from_state: 'available',
      to_location_id: d.location_id,
      to_state: 'reserved',
      job_id: d.job_id,
      reservation_id: id,
      reason: d.purpose,
      idem_key: idem,
    });
    audit(db, actor, 'reservation', id, 'created', { after: { ref, ...d } });
    if (d.job_id) audit(db, actor, 'job', d.job_id, 'stock_reserved', { after: { reservation: ref, item_id: d.item_id, qty: d.qty } });
    return id;
  });
}

export function releaseReservation(db: DB, actor: Actor, resId: number, body: Record<string, unknown>) {
  requireCap(actor, 'stock.reserve');
  const f = new Form(body);
  const reason = f.str('reason', 'Reason', 1000);
  f.done();
  tx(db, () => {
    const r = getReservation(db, resId);
    if (r.status !== 'active') throw new DomainError(`Reservation is ${r.status}.`);
    take(db, { item_id: r.item_id, location_id: r.location_id, state: 'reserved' }, r.qty_outstanding, 'reserved stock');
    put(db, { item_id: r.item_id, location_id: r.location_id, state: 'available' }, r.qty_outstanding);
    db.prepare(`UPDATE reservations SET status = 'released', qty_outstanding = 0, closed_at = ?, closed_reason = ? WHERE id = ?`).run(clock.iso(), reason, resId);
    movement(db, actor, {
      movement_type: 'unreserve',
      item_id: r.item_id,
      qty: r.qty_outstanding,
      from_location_id: r.location_id,
      from_state: 'reserved',
      to_location_id: r.location_id,
      to_state: 'available',
      job_id: r.job_id,
      reservation_id: resId,
      reason,
    });
    audit(db, actor, 'reservation', resId, 'released', { reason });
    if (r.owner_user_id !== actor.id) notify(db, r.owner_user_id, 'reservation', `${r.ref} released: ${reason}`, `/stock/items/${r.item_id}`);
  });
}

/**
 * Reallocation is an explicit, approved decision that notifies the displaced owner (RULE-009, AC-061-03).
 * Stock physically stays reserved; only its purpose moves.
 */
export function reallocate(db: DB, actor: Actor, resId: number, body: Record<string, unknown>): number {
  const f = new Form(body);
  const toJob = f.reqInt('to_job_id', 'New job');
  const qty = f.reqInt('qty', 'Quantity', { min: 1 });
  const reason = f.str('reason', 'Reallocation decision / reason', 2000);
  const toOwner = f.reqInt('owner_user_id', 'New accountable owner');
  const requiredBy = f.reqDt('required_by', 'Required by');
  const consequence = f.str('reallocation_consequence', 'Consequence if reallocated again', 1000);
  const displacedNextAction = f.str('displaced_next_action', 'What happens for the original work', 1000);
  f.done();
  return tx(db, () => {
    requireCap(actor, 'stock.reserve');
    requireApproval(db, actor, 'stock.reallocate', null);
    const r = getReservation(db, resId);
    if (r.status !== 'active') throw new DomainError(`Reservation is ${r.status}; only active reservations can be reallocated.`);
    if (qty > r.qty_outstanding) throw new DomainError(`Only ${r.qty_outstanding} outstanding on ${r.ref}.`);
    if (r.job_id === toJob) throw new DomainError('Already reserved for that job.');
    const j = db.prepare('SELECT id, ref, customer_id, op_status FROM jobs WHERE id = ?').get(toJob) as { id: number; ref: string; customer_id: number; op_status: string } | undefined;
    if (!j) throw new NotFoundError('Job');
    if (['operationally_complete', 'cancelled'].includes(j.op_status)) throw new DomainError('Cannot reallocate to a closed job.');
    const now = clock.iso();
    const remaining = r.qty_outstanding - qty;
    db.prepare(`UPDATE reservations SET qty_outstanding = ?, status = CASE WHEN ? = 0 THEN 'reallocated' ELSE status END, closed_at = CASE WHEN ? = 0 THEN ? ELSE closed_at END, closed_reason = CASE WHEN ? = 0 THEN ? ELSE closed_reason END WHERE id = ?`).run(
      remaining,
      remaining,
      remaining,
      now,
      remaining,
      `Reallocated to ${j.ref}: ${reason}`,
      resId,
    );
    const ref = nextRef(db, 'RS', 500);
    const nr = db
      .prepare(
        `INSERT INTO reservations (ref, item_id, location_id, qty, qty_outstanding, job_id, customer_id, purpose, requested_by, owner_user_id, required_by, review_at,
           substitution_allowed, reallocation_consequence, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'active', ?)`,
      )
      .run(ref, r.item_id, r.location_id, qty, qty, toJob, j.customer_id, `Reallocated from ${r.ref}: ${reason}`, actor.id, toOwner, requiredBy, requiredBy, consequence, now);
    const newId = Number(nr.lastInsertRowid);
    movement(db, actor, {
      movement_type: 'reallocate',
      item_id: r.item_id,
      qty,
      from_location_id: r.location_id,
      from_state: 'reserved',
      to_location_id: r.location_id,
      to_state: 'reserved',
      job_id: toJob,
      reservation_id: newId,
      reason: `From ${r.ref} (${r.job_ref ?? 'no job'}) → ${j.ref}: ${reason}`,
    });
    audit(db, actor, 'reservation', resId, 'reallocated', {
      reason,
      before: { job: r.job_ref, qty_outstanding: r.qty_outstanding, consequence: r.reallocation_consequence },
      after: { to_job: j.ref, qty, new_reservation: ref, displaced_next_action: displacedNextAction },
    });
    if (r.job_id) {
      audit(db, actor, 'job', r.job_id, 'stock_reallocated_away', { reason, after: { reservation: r.ref, qty, to_job: j.ref, next_action: displacedNextAction } });
      db.prepare(`UPDATE jobs SET ready_parts = 0, next_action = ?, next_owner_user_id = ?, review_at = ?, version = version + 1, updated_at = ?,
                    op_status = CASE WHEN op_status = 'ready' THEN 'authorised' ELSE op_status END WHERE id = ?`).run(
        displacedNextAction,
        r.owner_user_id,
        new Date(clock.now().getTime() + 86400000).toISOString(),
        now,
        r.job_id,
      );
    }
    audit(db, actor, 'job', toJob, 'stock_reallocated_in', { reason, after: { reservation: ref, qty, from: r.ref } });
    notify(db, r.owner_user_id, 'reallocation', `${qty} × ${r.sku} reallocated from ${r.job_ref ?? r.ref} to ${j.ref}: ${reason}. Next: ${displacedNextAction}`, r.job_id ? `/jobs/${r.job_id}` : `/stock/items/${r.item_id}`);
    return newId;
  });
}

export function pickReservation(db: DB, actor: Actor, resId: number) {
  requireCap(actor, 'stock.move');
  tx(db, () => {
    const r = getReservation(db, resId);
    if (r.status !== 'active') throw new DomainError(`Reservation is ${r.status}.`);
    take(db, { item_id: r.item_id, location_id: r.location_id, state: 'reserved' }, r.qty_outstanding, 'reserved stock');
    put(db, { item_id: r.item_id, location_id: r.location_id, state: 'picked' }, r.qty_outstanding);
    db.prepare(`UPDATE reservations SET status = 'picked' WHERE id = ?`).run(resId);
    movement(db, actor, { movement_type: 'pick', item_id: r.item_id, qty: r.qty_outstanding, from_location_id: r.location_id, from_state: 'reserved', to_location_id: r.location_id, to_state: 'picked', job_id: r.job_id, reservation_id: resId });
    audit(db, actor, 'reservation', resId, 'picked');
  });
}

/** Issues reserved/picked stock to its job (warehouse handover). Custody: recipient recorded (AC-063-01). */
export function issueReservation(db: DB, actor: Actor, resId: number, body: Record<string, unknown>) {
  requireCap(actor, 'stock.move');
  const f = new Form(body);
  const qty = f.reqInt('qty', 'Quantity', { min: 1 });
  const recipient = f.str('recipient', 'Recipient (engineer / van / site)', 200);
  const toLocation = f.int('to_location_id', 'Destination (van)');
  const serial = f.opt('serial_batch', 200);
  const idem = f.opt('idem_key', 100);
  f.done();
  tx(db, () => {
    if (idemSeen(db, idem)) return;
    const r = getReservation(db, resId);
    if (!['active', 'picked'].includes(r.status)) throw new DomainError(`Reservation is ${r.status}.`);
    if (qty > r.qty_outstanding) throw new DomainError(`Only ${r.qty_outstanding} outstanding.`);
    if (toLocation && qty !== r.qty_outstanding) throw new DomainError('Van handover moves the whole outstanding reservation; split it first if needed.');
    if (toLocation === r.location_id) throw new DomainError('Reservation is already at that location.');
    const fromState: StockState = r.status === 'picked' ? 'picked' : 'reserved';
    take(db, { item_id: r.item_id, location_id: r.location_id, state: fromState }, qty, `${fromState} stock`);
    const remaining = r.qty_outstanding - qty;
    if (toLocation) {
      // Handed to a van, still reserved for the job at its new custody location.
      put(db, { item_id: r.item_id, location_id: toLocation, state: 'reserved' }, qty);
      db.prepare(`UPDATE reservations SET location_id = ?, status = 'active' WHERE id = ?`).run(toLocation, resId);
    } else {
      db.prepare(`UPDATE reservations SET qty_outstanding = ?, status = CASE WHEN ? = 0 THEN 'fulfilled' ELSE status END, closed_at = CASE WHEN ? = 0 THEN ? ELSE NULL END WHERE id = ?`).run(
        remaining,
        remaining,
        remaining,
        clock.iso(),
        resId,
      );
    }
    movement(db, actor, {
      movement_type: toLocation ? 'transfer' : 'issue',
      item_id: r.item_id,
      qty,
      from_location_id: r.location_id,
      from_state: fromState,
      to_location_id: toLocation,
      to_state: toLocation ? 'reserved' : null,
      job_id: r.job_id,
      reservation_id: resId,
      recipient,
      serial_batch: serial,
      idem_key: idem,
    });
    audit(db, actor, 'reservation', resId, toLocation ? 'handed_to_van' : 'issued', { after: { qty, recipient, to_location: toLocation } });
  });
}

/**
 * Engineer records stock used on an attendance (FR-016/026). Draws first from a reservation
 * for this job at the engineer's van, otherwise from general available stock in the van.
 * Never from quarantine, evidence hold, customer-owned or another job's stock (RULE-010).
 */
export function issueToAttendance(db: DB, actor: Actor, attId: number, body: Record<string, unknown>) {
  requireCap(actor, 'engineer.material.use');
  const f = new Form(body);
  const itemId = f.reqInt('item_id', 'Item');
  const qty = f.reqInt('qty', 'Quantity', { min: 1, max: 1000 });
  const serial = f.opt('serial_batch', 200);
  const idem = f.opt('idem_key', 100);
  f.done();
  tx(db, () => {
    if (idemSeen(db, idem)) return;
    const a = getAttendance(db, attId);
    if (a.engineer_user_id !== actor.id) throw new ForbiddenError('This attendance is assigned to another engineer.');
    if (!['on_site', 'working'].includes(a.status)) throw new DomainError('Materials are recorded while on site.');
    const van = db.prepare(`SELECT van_location_id FROM users WHERE id = ?`).get(actor.id) as { van_location_id: number | null };
    if (!van.van_location_id) throw new DomainError('No van stock location is set up for you. Ask the warehouse.');
    const item = db.prepare('SELECT id, sku, name FROM stock_items WHERE id = ?').get(itemId) as { id: number; sku: string; name: string } | undefined;
    if (!item) throw new NotFoundError('Stock item');
    const res = db
      .prepare(`SELECT * FROM reservations WHERE job_id = ? AND item_id = ? AND location_id = ? AND status = 'active' AND qty_outstanding > 0 ORDER BY required_by LIMIT 1`)
      .get(a.job_id, itemId, van.van_location_id) as Reservation | undefined;
    let movementId: number;
    let source: 'reserved_stock' | 'van_stock';
    if (res && res.qty_outstanding >= qty) {
      take(db, { item_id: itemId, location_id: van.van_location_id, state: 'reserved' }, qty, 'reserved stock in your van');
      const remaining = res.qty_outstanding - qty;
      db.prepare(`UPDATE reservations SET qty_outstanding = ?, status = CASE WHEN ? = 0 THEN 'fulfilled' ELSE status END, closed_at = CASE WHEN ? = 0 THEN ? ELSE NULL END WHERE id = ?`).run(
        remaining,
        remaining,
        remaining,
        clock.iso(),
        res.id,
      );
      movementId = movement(db, actor, { movement_type: 'issue', item_id: itemId, qty, from_location_id: van.van_location_id, from_state: 'reserved', job_id: a.job_id, attendance_id: attId, reservation_id: res.id, recipient: `${a.site_name} (${a.job_ref})`, serial_batch: serial, idem_key: idem });
      source = 'reserved_stock';
    } else {
      take(db, { item_id: itemId, location_id: van.van_location_id, state: 'available' }, qty, `${item.name} available in your van`);
      movementId = movement(db, actor, { movement_type: 'issue', item_id: itemId, qty, from_location_id: van.van_location_id, from_state: 'available', job_id: a.job_id, attendance_id: attId, recipient: `${a.site_name} (${a.job_ref})`, serial_batch: serial, idem_key: idem });
      source = 'van_stock';
    }
    db.prepare(`INSERT INTO attendance_materials (attendance_id, item_id, description, qty, source, movement_id, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      attId,
      itemId,
      `${item.sku} ${item.name}${serial ? ` (${serial})` : ''}`,
      qty,
      source,
      movementId,
      actor.id,
      clock.iso(),
    );
    audit(db, actor, 'attendance', attId, 'stock_used', { after: { item: item.sku, qty, source } });
  });
}

/** Moves general available stock between locations (e.g. warehouse → van replenishment). */
export function transfer(db: DB, actor: Actor, body: Record<string, unknown>) {
  requireCap(actor, 'stock.move');
  const f = new Form(body);
  const itemId = f.reqInt('item_id', 'Item');
  const from = f.reqInt('from_location_id', 'From');
  const to = f.reqInt('to_location_id', 'To');
  const qty = f.reqInt('qty', 'Quantity', { min: 1 });
  const reason = f.opt('reason', 1000);
  const idem = f.opt('idem_key', 100);
  f.check(from !== to, 'to_location_id', 'Choose a different destination.');
  f.done();
  tx(db, () => {
    if (idemSeen(db, idem)) return;
    take(db, { item_id: itemId, location_id: from, state: 'available' }, qty, 'available stock');
    put(db, { item_id: itemId, location_id: to, state: 'available' }, qty);
    movement(db, actor, { movement_type: 'transfer', item_id: itemId, qty, from_location_id: from, from_state: 'available', to_location_id: to, to_state: 'available', reason, idem_key: idem });
    audit(db, actor, 'stock_item', itemId, 'transferred', { after: { from, to, qty } });
  });
}

// ------------------------------------------------------------------ receipt & quarantine (US-062)

/**
 * Goods receipt. Good lines become available (or job-specific if allocated). Damaged,
 * incorrect or uncertain lines go to quarantine — never available (AC-062-01/02) — with
 * evidence, impact, next action/owner and return deadline, and procurement is notified.
 */
export function receiveGoods(db: DB, actor: Actor, body: Record<string, unknown>): number {
  requireCap(actor, 'stock.receive');
  const f = new Form(body);
  const head = {
    supplier: f.str('supplier', 'Supplier', 200),
    po_ref: f.opt('po_ref', 100),
    delivery_ref: f.opt('delivery_ref', 100),
    carrier: f.opt('carrier', 100),
    location_id: f.reqInt('location_id', 'Receiving location'),
    notes: f.opt('notes'),
  };
  const receiptKey = f.opt('receipt_key', 100);
  const itemIds = f.list('line_item_id');
  const lines: {
    item_id: number;
    qty_expected: number | null;
    qty_received: number;
    condition: (typeof RECEIPT_CONDITIONS)[number];
    allocated_job_id: number | null;
    evidence: string | null;
    operational_impact: string | null;
    next_action: string | null;
    next_owner_user_id: number | null;
    return_deadline: string | null;
  }[] = [];
  const arr = (k: string) => f.list(k);
  const qtyR = arr('line_qty_received');
  const qtyE = (f.body['line_qty_expected'] ? ([] as string[]).concat(f.body['line_qty_expected'] as string[]) : []).map(String);
  const cond = arr('line_condition');
  const alloc = (f.body['line_job_id'] ? ([] as string[]).concat(f.body['line_job_id'] as string[]) : []).map(String);
  const ev = (f.body['line_evidence'] ? ([] as string[]).concat(f.body['line_evidence'] as string[]) : []).map(String);
  const imp = (f.body['line_impact'] ? ([] as string[]).concat(f.body['line_impact'] as string[]) : []).map(String);
  const na = (f.body['line_next_action'] ? ([] as string[]).concat(f.body['line_next_action'] as string[]) : []).map(String);
  const no = (f.body['line_next_owner'] ? ([] as string[]).concat(f.body['line_next_owner'] as string[]) : []).map(String);
  const rd = (f.body['line_return_deadline'] ? ([] as string[]).concat(f.body['line_return_deadline'] as string[]) : []).map(String);
  itemIds.forEach((idStr, i) => {
    const q = parseInt(qtyR[i] ?? '', 10);
    const c = (cond[i] ?? 'good') as (typeof RECEIPT_CONDITIONS)[number];
    if (!RECEIPT_CONDITIONS.includes(c)) f.errors[`line_${i}`] = `Line ${i + 1}: invalid condition.`;
    if (!Number.isInteger(q) || q <= 0) f.errors[`line_${i}`] = `Line ${i + 1}: quantity received must be a positive whole number.`;
    const exception = c !== 'good';
    const line = {
      item_id: parseInt(idStr, 10),
      qty_expected: qtyE[i] ? parseInt(qtyE[i], 10) : null,
      qty_received: q,
      condition: c,
      allocated_job_id: alloc[i] ? parseInt(alloc[i], 10) : null,
      evidence: ev[i]?.trim() || null,
      operational_impact: imp[i]?.trim() || null,
      next_action: na[i]?.trim() || null,
      next_owner_user_id: no[i] ? parseInt(no[i], 10) : null,
      return_deadline: rd[i]?.trim() || null,
    };
    if (exception && (!line.evidence || !line.next_action || !line.next_owner_user_id)) {
      f.errors[`line_${i}`] = `Line ${i + 1}: ${c} goods need evidence, a next action and an owner.`;
    }
    lines.push(line);
  });
  f.check(lines.length > 0, 'line_item_id', 'Add at least one line.');
  f.done();
  return tx(db, () => {
    if (receiptKey) {
      const prior = db.prepare('SELECT id FROM goods_receipts WHERE receipt_key = ?').get(receiptKey) as { id: number } | undefined;
      if (prior) return prior.id;
    }
    const ref = nextRef(db, 'GR', 200);
    const now = clock.iso();
    const r = db
      .prepare(`INSERT INTO goods_receipts (ref, supplier, po_ref, delivery_ref, carrier, received_at, received_by, location_id, notes, receipt_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(ref, head.supplier, head.po_ref, head.delivery_ref, head.carrier, now, actor.id, head.location_id, head.notes, receiptKey, now);
    const receiptId = Number(r.lastInsertRowid);
    const exceptions: string[] = [];
    for (const l of lines) {
      const exception = l.condition !== 'good';
      const lr = db
        .prepare(
          `INSERT INTO receipt_lines (receipt_id, item_id, qty_expected, qty_received, condition, allocated_job_id, evidence, operational_impact, next_action, next_owner_user_id,
             return_deadline, procurement_notified, exception_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(receiptId, l.item_id, l.qty_expected, l.qty_received, l.condition, l.allocated_job_id, l.evidence, l.operational_impact, l.next_action, l.next_owner_user_id, l.return_deadline, exception ? 1 : 0, exception ? 'open' : null);
      const lineId = Number(lr.lastInsertRowid);
      const owner: { owner_type: OwnerType; owner_ref: number } = l.allocated_job_id ? { owner_type: 'job', owner_ref: l.allocated_job_id } : { owner_type: 'frostline', owner_ref: 0 };
      const state: StockState = exception ? 'quarantined' : 'available';
      put(db, { item_id: l.item_id, location_id: head.location_id, state, ...owner }, l.qty_received);
      movement(db, actor, { movement_type: exception ? 'quarantine' : 'receipt', item_id: l.item_id, qty: l.qty_received, to_location_id: head.location_id, to_state: state, ...owner, receipt_line_id: lineId, job_id: l.allocated_job_id, reason: exception ? `${l.condition}: ${l.evidence}` : `Received ${ref}` });
      if (exception) {
        const sku = (db.prepare('SELECT sku FROM stock_items WHERE id = ?').get(l.item_id) as { sku: string }).sku;
        exceptions.push(`${l.qty_received} × ${sku} ${l.condition}`);
        if (l.next_owner_user_id) notify(db, l.next_owner_user_id, 'receipt_exception', `${ref}: ${l.qty_received} × ${sku} ${l.condition} — ${l.next_action}`, `/stock/receipts/${receiptId}`);
      }
    }
    if (exceptions.length) {
      for (const u of db.prepare(`SELECT id FROM users WHERE role IN ('warehouse','manager') AND active = 1`).all() as { id: number }[]) {
        notify(db, u.id, 'procurement', `Receipt exception ${ref} from ${head.supplier}: ${exceptions.join(', ')}`, `/stock/receipts/${receiptId}`);
      }
    }
    audit(db, actor, 'goods_receipt', receiptId, 'received', { after: { ref, ...head, lines: lines.length, exceptions } });
    return receiptId;
  });
}

export function getReceipt(db: DB, id: number) {
  const r = db
    .prepare(`SELECT g.*, u.display_name AS received_by_name, l.code AS location_code FROM goods_receipts g JOIN users u ON u.id = g.received_by JOIN stock_locations l ON l.id = g.location_id WHERE g.id = ?`)
    .get(id) as
    | { id: number; ref: string; supplier: string; po_ref: string | null; delivery_ref: string | null; carrier: string | null; received_at: string; received_by_name: string; location_id: number; location_code: string; notes: string | null }
    | undefined;
  if (!r) throw new NotFoundError('Receipt');
  const lines = db
    .prepare(
      `SELECT rl.*, i.sku, i.name AS item_name, j.ref AS job_ref, o.display_name AS next_owner_name FROM receipt_lines rl JOIN stock_items i ON i.id = rl.item_id
       LEFT JOIN jobs j ON j.id = rl.allocated_job_id LEFT JOIN users o ON o.id = rl.next_owner_user_id WHERE rl.receipt_id = ?`,
    )
    .all(id) as {
    id: number;
    item_id: number;
    sku: string;
    item_name: string;
    qty_expected: number | null;
    qty_received: number;
    condition: string;
    job_ref: string | null;
    allocated_job_id: number | null;
    evidence: string | null;
    operational_impact: string | null;
    next_action: string | null;
    next_owner_name: string | null;
    return_deadline: string | null;
    exception_status: string | null;
    resolved_note: string | null;
  }[];
  return { ...r, lines };
}

export function listReceipts(db: DB, limit = 50) {
  return db
    .prepare(
      `SELECT g.*, u.display_name AS received_by_name, (SELECT COUNT(*) FROM receipt_lines rl WHERE rl.receipt_id = g.id) AS line_count,
         (SELECT COUNT(*) FROM receipt_lines rl WHERE rl.receipt_id = g.id AND rl.exception_status = 'open') AS open_exceptions
       FROM goods_receipts g JOIN users u ON u.id = g.received_by ORDER BY g.received_at DESC LIMIT ?`,
    )
    .all(limit) as { id: number; ref: string; supplier: string; po_ref: string | null; received_at: string; received_by_name: string; line_count: number; open_exceptions: number }[];
}

/** Resolves a quarantined receipt line: release to available, return to supplier, or dispose (authorised). */
export function resolveReceiptException(db: DB, actor: Actor, lineId: number, body: Record<string, unknown>) {
  requireCap(actor, 'stock.assess');
  const f = new Form(body);
  const outcome = f.oneOf('outcome', 'Outcome', ['release_available', 'return_to_supplier', 'dispose'] as const);
  const qty = f.reqInt('qty', 'Quantity', { min: 1 });
  const note = f.str('note', 'Technical acceptance / decision note', 2000);
  f.done();
  tx(db, () => {
    const l = db.prepare(`SELECT rl.*, g.location_id, g.ref FROM receipt_lines rl JOIN goods_receipts g ON g.id = rl.receipt_id WHERE rl.id = ?`).get(lineId) as
      | { id: number; item_id: number; location_id: number; allocated_job_id: number | null; exception_status: string | null; ref: string; receipt_id: number }
      | undefined;
    if (!l) throw new NotFoundError('Receipt line');
    if (l.exception_status !== 'open') throw new DomainError('No open exception on this line.');
    const owner: { owner_type: OwnerType; owner_ref: number } = l.allocated_job_id ? { owner_type: 'job', owner_ref: l.allocated_job_id } : { owner_type: 'frostline', owner_ref: 0 };
    if (outcome === 'dispose') requireApproval(db, actor, 'stock.dispose', null);
    take(db, { item_id: l.item_id, location_id: l.location_id, state: 'quarantined', ...owner }, qty, 'quarantined stock');
    if (outcome === 'release_available') put(db, { item_id: l.item_id, location_id: l.location_id, state: 'available', ...owner }, qty);
    movement(db, actor, {
      movement_type: outcome === 'release_available' ? 'release' : outcome === 'dispose' ? 'dispose' : 'return',
      item_id: l.item_id,
      qty,
      from_location_id: l.location_id,
      from_state: 'quarantined',
      to_location_id: outcome === 'release_available' ? l.location_id : null,
      to_state: outcome === 'release_available' ? 'available' : null,
      ...owner,
      receipt_line_id: lineId,
      reason: note,
    });
    const left = bucketQty(db, { item_id: l.item_id, location_id: l.location_id, state: 'quarantined', ...owner });
    const lineQty = (db.prepare(`SELECT COALESCE(SUM(qty), 0) q FROM stock_movements WHERE receipt_line_id = ? AND from_state = 'quarantined'`).get(lineId) as { q: number }).q;
    const received = (db.prepare(`SELECT qty_received FROM receipt_lines WHERE id = ?`).get(lineId) as { qty_received: number }).qty_received;
    if (lineQty >= received || left === 0) db.prepare(`UPDATE receipt_lines SET exception_status = 'resolved', resolved_note = ? WHERE id = ?`).run(note, lineId);
    audit(db, actor, 'goods_receipt', l.receipt_id, `exception_${outcome}`, { reason: note, after: { line: lineId, qty } });
  });
}

// ------------------------------------------------------------------ returns & custody (US-063)

/** Engineer/warehouse books material back; it is not available until assessed (AC-063-02). */
export function bookReturn(db: DB, actor: Actor, body: Record<string, unknown>) {
  if (actor.role !== 'engineer') requireCap(actor, 'stock.move');
  const f = new Form(body);
  const itemId = f.reqInt('item_id', 'Item');
  const qty = f.reqInt('qty', 'Quantity', { min: 1 });
  const locationId = f.reqInt('location_id', 'Returned to');
  const jobId = f.int('job_id', 'From job');
  const note = f.str('note', 'Why returned / condition as seen', 1000);
  const customerOwned = f.bool('customer_owned');
  const idem = f.opt('idem_key', 100);
  f.done();
  tx(db, () => {
    if (idemSeen(db, idem)) return;
    if (actor.role === 'engineer') {
      const van = db.prepare('SELECT van_location_id FROM users WHERE id = ?').get(actor.id) as { van_location_id: number | null };
      if (van.van_location_id !== locationId) throw new ForbiddenError('Engineers book returns into their own van.');
      if (jobId && !db.prepare(`SELECT 1 FROM attendances WHERE job_id = ? AND engineer_user_id = ?`).get(jobId, actor.id)) throw new ForbiddenError('You did not attend that job.');
    }
    const owner: { owner_type: OwnerType; owner_ref: number } = customerOwned && jobId
      ? { owner_type: 'customer', owner_ref: (db.prepare('SELECT customer_id FROM jobs WHERE id = ?').get(jobId) as { customer_id: number }).customer_id }
      : { owner_type: 'frostline', owner_ref: 0 };
    put(db, { item_id: itemId, location_id: locationId, state: 'return_pending', ...owner }, qty);
    movement(db, actor, { movement_type: 'return', item_id: itemId, qty, to_location_id: locationId, to_state: 'return_pending', ...owner, job_id: jobId, reason: note, idem_key: idem });
    audit(db, actor, 'stock_item', itemId, 'return_booked', { reason: note, after: { qty, location: locationId, job: jobId, owner } });
  });
}

export function pendingReturns(db: DB) {
  return db
    .prepare(
      `SELECT b.*, i.sku, i.name AS item_name, l.code AS location_code,
         CASE b.owner_type WHEN 'customer' THEN (SELECT trading_name FROM customers WHERE id = b.owner_ref) END AS owner_label
       FROM stock_balances b JOIN stock_items i ON i.id = b.item_id JOIN stock_locations l ON l.id = b.location_id
       WHERE b.state = 'return_pending' AND b.qty > 0 ORDER BY l.code, i.sku`,
    )
    .all() as { item_id: number; location_id: number; owner_type: OwnerType; owner_ref: number; qty: number; sku: string; item_name: string; location_code: string; owner_label: string | null }[];
}

export function quarantined(db: DB) {
  return db
    .prepare(
      `SELECT b.*, i.sku, i.name AS item_name, l.code AS location_code FROM stock_balances b JOIN stock_items i ON i.id = b.item_id JOIN stock_locations l ON l.id = b.location_id
       WHERE b.state = 'quarantined' AND b.qty > 0 ORDER BY l.code, i.sku`,
    )
    .all() as { item_id: number; location_id: number; owner_type: OwnerType; owner_ref: number; qty: number; sku: string; item_name: string; location_code: string }[];
}

/** Return assessment decides availability; nothing returns to "available" without it. */
export function assessReturn(db: DB, actor: Actor, body: Record<string, unknown>): number | null {
  requireCap(actor, 'stock.assess');
  const f = new Form(body);
  const itemId = f.reqInt('item_id', 'Item');
  const locationId = f.reqInt('location_id', 'Location');
  const ownerType = f.oneOf('owner_type', 'Owner', ['frostline', 'customer', 'job'] as const);
  const ownerRef = f.int('owner_ref', 'Owner ref') ?? 0;
  const qty = f.reqInt('qty', 'Quantity', { min: 1 });
  const outcome = f.oneOf('outcome', 'Assessment', RETURN_OUTCOMES);
  const note = f.str('note', 'Assessment note', 2000);
  f.done();
  return tx(db, () => {
    const from: BalanceKey = { item_id: itemId, location_id: locationId, state: 'return_pending', owner_type: ownerType, owner_ref: ownerRef };
    if (outcome === 'disposal') requireApproval(db, actor, 'stock.dispose', null);
    if (outcome === 'unused' && ownerType !== 'frostline') throw new DomainError('Customer- or job-owned material cannot become general available stock.');
    take(db, from, qty, 'return-pending stock');
    let to: StockState | null;
    let owner = { owner_type: ownerType, owner_ref: ownerRef };
    switch (outcome) {
      case 'unused':
        to = 'available';
        break;
      case 'customer_owned':
        to = 'available';
        if (ownerType !== 'customer') throw new DomainError('Book the return as customer-owned (with its job) so the owner is known.');
        owner = { owner_type: 'customer', owner_ref: ownerRef };
        break;
      case 'warranty_return':
        to = 'evidence_hold';
        break;
      case 'disposal':
        to = null;
        break;
      default:
        to = 'quarantined';
    }
    if (to) put(db, { item_id: itemId, location_id: locationId, state: to, ...owner }, qty);
    movement(db, actor, { movement_type: outcome === 'disposal' ? 'dispose' : 'assess', item_id: itemId, qty, from_location_id: locationId, from_state: 'return_pending', to_location_id: to ? locationId : null, to_state: to, ...owner, reason: `${RETURN_OUTCOME_LABEL[outcome]}: ${note}` });
    audit(db, actor, 'stock_item', itemId, 'return_assessed', { reason: note, after: { outcome, qty, to_state: to } });
    return null;
  });
}

// Evidence holds

export function createEvidenceHold(db: DB, actor: Actor, body: Record<string, unknown>): number {
  if (actor.role !== 'engineer') requireCap(actor, 'stock.custody');
  const f = new Form(body);
  const d = {
    description: f.str('description', 'Failed part description', 500),
    item_id: f.int('item_id', 'Stock item'),
    qty: f.int('qty', 'Quantity', { min: 1 }) ?? 1,
    job_id: f.reqInt('job_id', 'Source job'),
    asset_id: f.int('asset_id', 'Source asset'),
    attendance_id: f.int('attendance_id', 'Attendance'),
    failure_evidence: f.str('failure_evidence', 'Failure evidence', 4000),
    tests_photos: f.opt('tests_photos', 4000),
    condition_packaging: f.str('condition_packaging', 'Condition / packaging', 1000),
    storage_location_id: f.int('storage_location_id', 'Storage location'),
    storage_detail: f.opt('storage_detail', 500),
    deadline: f.date('deadline', 'Claim / return deadline', false),
    manufacturer_ref: f.opt('manufacturer_ref', 200),
    supplier_ref: f.opt('supplier_ref', 200),
    next_action: f.str('next_action', 'Next action', 1000),
    next_owner_user_id: f.reqInt('next_owner_user_id', 'Next-action owner'),
  };
  f.done();
  return tx(db, () => {
    const job = db.prepare(`SELECT id, customer_id, site_id, ref FROM jobs WHERE id = ?`).get(d.job_id) as { id: number; customer_id: number; site_id: number; ref: string } | undefined;
    if (!job) throw new NotFoundError('Job');
    if (actor.role === 'engineer') {
      if (!d.attendance_id) throw new DomainError('Record the failed part from your attendance.');
      const a = getAttendance(db, d.attendance_id);
      if (a.engineer_user_id !== actor.id || a.job_id !== d.job_id) throw new ForbiddenError('That attendance is not yours.');
    }
    if (d.asset_id) {
      const as = db.prepare('SELECT site_id FROM assets WHERE id = ?').get(d.asset_id) as { site_id: number } | undefined;
      if (!as || as.site_id !== job.site_id) throw new DomainError('Asset is not at the job site.');
    }
    const ref = nextRef(db, 'EH', 100);
    const now = clock.iso();
    const removedBy = actor.role === 'engineer' ? actor.id : d.attendance_id ? getAttendance(db, d.attendance_id).engineer_user_id : null;
    const r = db
      .prepare(
        `INSERT INTO evidence_holds (ref, description, item_id, qty, customer_id, site_id, asset_id, job_id, attendance_id, removed_at, removed_by, failure_evidence, tests_photos,
           condition_packaging, storage_location_id, storage_detail, deadline, manufacturer_ref, supplier_ref, next_action, next_owner_user_id, created_by, created_at)
         VALUES (@ref, @description, @item_id, @qty, @customer_id, @site_id, @asset_id, @job_id, @attendance_id, @now, @removed_by, @failure_evidence, @tests_photos,
           @condition_packaging, @storage_location_id, @storage_detail, @deadline, @manufacturer_ref, @supplier_ref, @next_action, @next_owner_user_id, @actor, @now)`,
      )
      .run({ ...d, ref, customer_id: job.customer_id, site_id: job.site_id, removed_by: removedBy, actor: actor.id, now });
    const id = Number(r.lastInsertRowid);
    db.prepare(`INSERT INTO custody_events (hold_id, action, detail, actor_id, at) VALUES (?, 'removed_and_held', ?, ?, ?)`).run(id, `Removed at ${job.ref}; ${d.condition_packaging}`, actor.id, now);
    audit(db, actor, 'evidence_hold', id, 'created', { after: { ref, job: job.ref, description: d.description } });
    audit(db, actor, 'job', d.job_id, 'evidence_hold_created', { after: { hold: ref } });
    if (d.next_owner_user_id !== actor.id) notify(db, d.next_owner_user_id, 'evidence_hold', `${ref}: ${d.description} held — ${d.next_action}`, `/stock/holds/${id}`);
    return id;
  });
}

export function listHolds(db: DB, opts: { open?: boolean; jobId?: number } = {}) {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (opts.open) conds.push(`h.status = 'held'`);
  if (opts.jobId) {
    conds.push('h.job_id = ?');
    params.push(opts.jobId);
  }
  return db
    .prepare(
      `SELECT h.*, j.ref AS job_ref, c.trading_name AS customer_name, s.name AS site_name, x.ref AS asset_ref, o.display_name AS next_owner_name, l.code AS storage_code,
         rb.display_name AS removed_by_name
       FROM evidence_holds h LEFT JOIN jobs j ON j.id = h.job_id LEFT JOIN customers c ON c.id = h.customer_id LEFT JOIN sites s ON s.id = h.site_id
       LEFT JOIN assets x ON x.id = h.asset_id JOIN users o ON o.id = h.next_owner_user_id LEFT JOIN stock_locations l ON l.id = h.storage_location_id
       LEFT JOIN users rb ON rb.id = h.removed_by
       ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''} ORDER BY h.status = 'held' DESC, h.deadline IS NULL, h.deadline`,
    )
    .all(...params) as EvidenceHold[];
}

export interface EvidenceHold {
  id: number;
  ref: string;
  description: string;
  qty: number;
  job_id: number | null;
  job_ref: string | null;
  customer_name: string | null;
  site_name: string | null;
  asset_ref: string | null;
  asset_id: number | null;
  removed_at: string;
  removed_by_name: string | null;
  failure_evidence: string;
  tests_photos: string | null;
  condition_packaging: string;
  storage_code: string | null;
  storage_detail: string | null;
  deadline: string | null;
  manufacturer_ref: string | null;
  supplier_ref: string | null;
  next_action: string;
  next_owner_name: string;
  status: string;
  closed_reason: string | null;
  closed_at: string | null;
}

export function getHold(db: DB, id: number) {
  const h = listHolds(db).find((x) => x.id === id);
  if (!h) throw new NotFoundError('Evidence hold');
  const events = db
    .prepare(`SELECT e.*, u.display_name AS actor_name FROM custody_events e JOIN users u ON u.id = e.actor_id WHERE e.hold_id = ? ORDER BY e.at, e.id`)
    .all(id) as { id: number; action: string; detail: string | null; actor_name: string; at: string }[];
  return { ...h, events };
}

/**
 * Custody actions. Moving/labelling is routine; sending to supplier needs a reference;
 * release or disposal is never casual — it requires the approval policy and a reason (AC-063-03).
 */
export function custodyAction(db: DB, actor: Actor, holdId: number, body: Record<string, unknown>) {
  requireCap(actor, 'stock.custody');
  const f = new Form(body);
  const action = f.oneOf('action', 'Action', ['moved', 'note', 'sent_to_supplier', 'released', 'disposed'] as const);
  const detail = f.str('detail', 'Detail', 2000);
  const locationId = f.int('storage_location_id', 'New storage location');
  const ref = f.opt('reference', 200);
  if (action === 'sent_to_supplier') f.check(ref, 'reference', 'Record the supplier / manufacturer return reference.');
  f.done();
  tx(db, () => {
    const h = db.prepare('SELECT * FROM evidence_holds WHERE id = ?').get(holdId) as { id: number; status: string; ref: string; storage_location_id: number | null } | undefined;
    if (!h) throw new NotFoundError('Evidence hold');
    if (h.status !== 'held') throw new DomainError(`${h.ref} is ${h.status}; custody is closed.`);
    const now = clock.iso();
    if (action === 'released' || action === 'disposed') {
      const decision = requireApproval(db, actor, 'stock.dispose', null);
      db.prepare(`UPDATE evidence_holds SET status = ?, closed_by = ?, closed_at = ?, closed_reason = ? WHERE id = ?`).run(action, actor.id, now, detail, holdId);
      audit(db, actor, 'evidence_hold', holdId, action, { reason: detail, after: { policy: decision.message } });
    } else if (action === 'sent_to_supplier') {
      db.prepare(`UPDATE evidence_holds SET status = 'sent_to_supplier', supplier_ref = COALESCE(?, supplier_ref), closed_by = ?, closed_at = ?, closed_reason = ? WHERE id = ?`).run(ref, actor.id, now, detail, holdId);
      audit(db, actor, 'evidence_hold', holdId, 'sent_to_supplier', { reason: detail, after: { reference: ref } });
    } else if (action === 'moved') {
      if (!locationId) throw new DomainError('Choose the new storage location.');
      db.prepare(`UPDATE evidence_holds SET storage_location_id = ? WHERE id = ?`).run(locationId, holdId);
      audit(db, actor, 'evidence_hold', holdId, 'moved', { reason: detail, before: { location: h.storage_location_id }, after: { location: locationId } });
    }
    db.prepare(`INSERT INTO custody_events (hold_id, action, detail, actor_id, at) VALUES (?, ?, ?, ?, ?)`).run(holdId, action, ref ? `${detail} (ref ${ref})` : detail, actor.id, now);
  });
}

export function saveItem(db: DB, actor: Actor, body: Record<string, unknown>, id?: number): number {
  requireCap(actor, 'stock.item.write');
  const f = new Form(body);
  const d = {
    sku: f.str('sku', 'SKU', 50).toUpperCase(),
    name: f.str('name', 'Name', 200),
    category: f.opt('category', 100),
    unit: f.opt('unit', 20) ?? 'each',
    manufacturer: f.opt('manufacturer', 100),
    part_number: f.opt('part_number', 100),
    serial_tracked: f.bool('serial_tracked') ? 1 : 0,
    min_level: f.int('min_level', 'Minimum level', { min: 0 }),
  };
  f.done();
  return tx(db, () => {
    const dup = db.prepare('SELECT id FROM stock_items WHERE sku = ?').get(d.sku) as { id: number } | undefined;
    if (dup && dup.id !== id) throw new DomainError('SKU already exists.', { sku: 'Already exists.' });
    if (id) {
      db.prepare(`UPDATE stock_items SET sku = @sku, name = @name, category = @category, unit = @unit, manufacturer = @manufacturer, part_number = @part_number, serial_tracked = @serial_tracked, min_level = @min_level WHERE id = @id`).run({ ...d, id });
      audit(db, actor, 'stock_item', id, 'updated', { after: d });
      return id;
    }
    const r = db
      .prepare(`INSERT INTO stock_items (sku, name, category, unit, manufacturer, part_number, serial_tracked, min_level, created_at) VALUES (@sku, @name, @category, @unit, @manufacturer, @part_number, @serial_tracked, @min_level, @now)`)
      .run({ ...d, now: clock.iso() });
    const nid = Number(r.lastInsertRowid);
    audit(db, actor, 'stock_item', nid, 'created', { after: d });
    return nid;
  });
}
