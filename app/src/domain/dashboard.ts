import type { DB } from '../db/db.ts';
import type { Actor } from '../auth/policy.ts';
import { can } from '../auth/policy.ts';
import { addDays, clock, DAY, londonDate, londonDayStart } from '../lib/clock.ts';
import { computeSla, type TargetStatus } from './sla.ts';
import { OPEN_STATUSES, type Job } from './jobs.ts';

const OPEN_IN = `(${OPEN_STATUSES.map((s) => `'${s}'`).join(',')})`;
const JOB_COLS = `j.id, j.ref, j.title, j.priority, j.op_status, j.kind, j.received_at, j.contract_id, j.waiting_category, j.waiting_detail, j.next_action, j.review_at,
  j.safety_flag, c.trading_name AS customer_name, s.name AS site_name, nu.display_name AS next_owner_name`;
const JOB_FROM = `FROM jobs j JOIN customers c ON c.id = j.customer_id JOIN sites s ON s.id = j.site_id LEFT JOIN users nu ON nu.id = j.next_owner_user_id`;

export interface Queue<T> {
  key: string;
  title: string;
  definition: string;
  count: number;
  rows: T[];
  href: string;
  tone: 'danger' | 'warn' | 'info' | 'ok';
}

type JobRow = Pick<Job, 'id' | 'ref' | 'title' | 'priority' | 'op_status' | 'kind' | 'received_at' | 'contract_id' | 'waiting_category' | 'waiting_detail' | 'next_action' | 'review_at' | 'safety_flag'> & {
  customer_name: string;
  site_name: string;
  next_owner_name: string | null;
};

export interface SlaRiskRow extends JobRow {
  measure: TargetStatus;
}

/** Derives every dashboard queue from source records (AC-070-01). Nothing is hard-coded. */
export function dashboard(db: DB, actor: Actor) {
  const now = clock.iso();
  const today = londonDate(now);
  const dayStart = londonDayStart(today);
  const dayEnd = londonDayStart(addDays(today, 1));
  const queues: Queue<unknown>[] = [];

  const urgent = db.prepare(`SELECT ${JOB_COLS} ${JOB_FROM} WHERE j.op_status IN ${OPEN_IN} AND j.priority IN ('P1','P2') ORDER BY j.priority, j.received_at`).all() as JobRow[];
  queues.push({
    key: 'urgent',
    title: 'Urgent work (P1/P2)',
    definition: 'Open jobs (not operationally complete or cancelled) at priority P1 or P2, by priority then age.',
    count: urgent.length,
    rows: urgent,
    href: '/jobs?priority=P1',
    tone: urgent.some((u) => u.priority === 'P1') ? 'danger' : urgent.length ? 'warn' : 'ok',
  });

  // SLA risk: open contracted jobs whose response/attendance/resolution target is breached or inside the at-risk window.
  const contracted = db.prepare(`SELECT ${JOB_COLS} ${JOB_FROM} WHERE j.op_status IN ${OPEN_IN} AND j.contract_id IS NOT NULL`).all() as JobRow[];
  const slaRisk: SlaRiskRow[] = [];
  for (const j of contracted) {
    const measures = computeSla(db, j);
    const worst = measures.find((m) => m.state === 'breached') ?? measures.find((m) => m.state === 'at_risk');
    if (worst) slaRisk.push({ ...j, measure: worst });
  }
  slaRisk.sort((a, b) => (a.measure.state === b.measure.state ? (a.measure.dueAt ?? '').localeCompare(b.measure.dueAt ?? '') : a.measure.state === 'breached' ? -1 : 1));
  const fraction = (db.prepare(`SELECT value FROM settings WHERE key = 'sla_at_risk_fraction'`).get() as { value: string } | undefined)?.value ?? '0.25';
  queues.push({
    key: 'sla',
    title: 'SLA at risk / breached',
    definition: `Open jobs under a contract with a response, attendance or resolution target that is past due (breached) or has less than ${Math.round(parseFloat(fraction) * 100)}% of its window left (at risk). Due times include permitted clock stops.`,
    count: slaRisk.length,
    rows: slaRisk,
    href: '/jobs?status=open',
    tone: slaRisk.some((s) => s.measure.state === 'breached') ? 'danger' : slaRisk.length ? 'warn' : 'ok',
  });

  const overdueWaiting = db.prepare(`SELECT ${JOB_COLS} ${JOB_FROM} WHERE j.op_status = 'waiting' AND j.review_at < ? ORDER BY j.review_at`).all(now) as JobRow[];
  queues.push({
    key: 'waiting_overdue',
    title: 'Waiting — review overdue',
    definition: 'Jobs waiting on a named dependency whose review/chase time has passed.',
    count: overdueWaiting.length,
    rows: overdueWaiting,
    href: '/jobs?status=waiting_overdue',
    tone: overdueWaiting.length ? 'warn' : 'ok',
  });

  const committed = db
    .prepare(
      `SELECT a.id, a.ref, a.planned_start, a.planned_end, a.status, a.commitment, u.display_name AS engineer_name, j.id AS job_id, j.ref AS job_ref, j.priority, s.name AS site_name
       FROM attendances a JOIN users u ON u.id = a.engineer_user_id JOIN jobs j ON j.id = a.job_id JOIN sites s ON s.id = j.site_id
       WHERE a.status <> 'cancelled' AND a.planned_start < ? AND a.planned_end > ? ORDER BY a.planned_start`,
    )
    .all(dayEnd, dayStart) as {
    id: number;
    ref: string;
    planned_start: string;
    planned_end: string;
    status: string;
    commitment: string;
    engineer_name: string;
    job_id: number;
    job_ref: string;
    priority: string;
    site_name: string;
  }[];
  const confirmed = committed.filter((c) => c.commitment === 'customer_confirmed').length;
  queues.push({
    key: 'today',
    title: "Today's attendances",
    definition: `Attendances planned for today (London time), not cancelled. ${confirmed} of ${committed.length} are customer-confirmed commitments; the rest are provisional diary entries.`,
    count: committed.length,
    rows: committed,
    href: '/schedule',
    tone: 'info',
  });

  const ready = db.prepare(`SELECT ${JOB_COLS} ${JOB_FROM} WHERE j.op_status = 'ready' ORDER BY j.priority, j.received_at`).all() as JobRow[];
  queues.push({
    key: 'ready',
    title: 'Ready but unscheduled',
    definition: 'Jobs whose authority and readiness checklist are confirmed but have no planned attendance.',
    count: ready.length,
    rows: ready,
    href: '/schedule#ready',
    tone: ready.some((r) => r.priority === 'P1' || r.priority === 'P2') ? 'warn' : 'info',
  });

  const soon = new Date(clock.now().getTime() + 3 * DAY).toISOString();
  const temps = db
    .prepare(
      `SELECT t.id, t.review_at, t.limitations, j.id AS job_id, j.ref AS job_ref, s.name AS site_name, o.display_name AS owner_name
       FROM temporary_restorations t JOIN jobs j ON j.id = t.job_id JOIN sites s ON s.id = j.site_id JOIN users o ON o.id = t.permanent_owner_user_id
       WHERE t.status = 'open' AND t.review_at < ? ORDER BY t.review_at`,
    )
    .all(soon) as { id: number; review_at: string; limitations: string; job_id: number; job_ref: string; site_name: string; owner_name: string }[];
  queues.push({
    key: 'temporary',
    title: 'Temporary restorations due for review',
    definition: 'Open temporary restorations whose review/expiry date is within 3 days or already passed.',
    count: temps.length,
    rows: temps,
    href: '/jobs?status=open',
    tone: temps.some((t) => t.review_at < now) ? 'danger' : temps.length ? 'warn' : 'ok',
  });

  const escalations = db
    .prepare(
      `SELECT st.id, st.kind, st.detail, st.raised_at, a.ref AS attendance_ref, j.id AS job_id, j.ref AS job_ref, u.display_name AS raised_by_name
       FROM attendance_stops st JOIN attendances a ON a.id = st.attendance_id JOIN jobs j ON j.id = a.job_id JOIN users u ON u.id = st.raised_by
       WHERE st.resolved_at IS NULL ORDER BY st.raised_at`,
    )
    .all() as { id: number; kind: string; detail: string; raised_at: string; attendance_ref: string; job_id: number; job_ref: string; raised_by_name: string }[];
  queues.push({
    key: 'escalations',
    title: 'Engineer stops / escalations',
    definition: 'Stop or escalation raised by an engineer that the office has not yet responded to.',
    count: escalations.length,
    rows: escalations,
    href: '/jobs?status=open',
    tone: escalations.length ? 'danger' : 'ok',
  });

  if (can(actor, 'stock.read')) {
    const stock = stockExceptions(db);
    queues.push({
      key: 'stock',
      title: 'Stock exceptions',
      definition: 'Quarantined goods with open receipt exceptions, returns awaiting assessment, evidence holds, reservations past review, and items below their minimum available level.',
      count: stock.length,
      rows: stock,
      href: '/stock?exceptions=1',
      tone: stock.length ? 'warn' : 'ok',
    });
  }

  // What is waiting, and on whom (Q032)
  const waitingBy = db
    .prepare(
      `SELECT j.waiting_category AS category, COALESCE(u.display_name, '—') AS owner, COUNT(*) AS n, SUM(CASE WHEN j.review_at < ? THEN 1 ELSE 0 END) AS overdue
       FROM jobs j LEFT JOIN users u ON u.id = j.next_owner_user_id WHERE j.op_status = 'waiting' GROUP BY j.waiting_category, u.display_name ORDER BY n DESC`,
    )
    .all(now) as { category: string; owner: string; n: number; overdue: number }[];

  const mine = db
    .prepare(`SELECT ${JOB_COLS} ${JOB_FROM} WHERE j.op_status IN ${OPEN_IN} AND j.next_owner_user_id = ? ORDER BY j.review_at IS NULL, j.review_at`)
    .all(actor.id) as JobRow[];

  return { queues, waitingBy, mine, now };
}

export interface StockException {
  kind: string;
  label: string;
  detail: string;
  href: string;
}

export function stockExceptions(db: DB): StockException[] {
  const out: StockException[] = [];
  const now = clock.iso();
  for (const r of db
    .prepare(
      `SELECT rl.id, rl.qty_received, rl.condition, rl.next_action, rl.return_deadline, g.id AS receipt_id, g.ref, i.sku FROM receipt_lines rl
       JOIN goods_receipts g ON g.id = rl.receipt_id JOIN stock_items i ON i.id = rl.item_id WHERE rl.exception_status = 'open'`,
    )
    .all() as { qty_received: number; condition: string; next_action: string; return_deadline: string | null; receipt_id: number; ref: string; sku: string }[]) {
    out.push({ kind: 'quarantine', label: `${r.ref}: ${r.qty_received} × ${r.sku} ${r.condition}`, detail: `${r.next_action}${r.return_deadline ? ` · return by ${r.return_deadline}` : ''}`, href: `/stock/receipts/${r.receipt_id}` });
  }
  for (const r of db
    .prepare(`SELECT SUM(b.qty) q, i.sku, l.code FROM stock_balances b JOIN stock_items i ON i.id = b.item_id JOIN stock_locations l ON l.id = b.location_id WHERE b.state = 'return_pending' AND b.qty > 0 GROUP BY b.item_id, b.location_id`)
    .all() as { q: number; sku: string; code: string }[]) {
    out.push({ kind: 'return', label: `${r.q} × ${r.sku} awaiting return assessment`, detail: `At ${r.code}`, href: '/stock/returns' });
  }
  for (const h of db.prepare(`SELECT id, ref, description, deadline FROM evidence_holds WHERE status = 'held' ORDER BY deadline IS NULL, deadline`).all() as { id: number; ref: string; description: string; deadline: string | null }[]) {
    out.push({ kind: 'evidence', label: `${h.ref}: ${h.description}`, detail: h.deadline ? `Deadline ${h.deadline}` : 'No deadline recorded', href: `/stock/holds/${h.id}` });
  }
  for (const r of db
    .prepare(`SELECT r.id, r.ref, r.item_id, r.review_at, i.sku, j.ref AS job_ref FROM reservations r JOIN stock_items i ON i.id = r.item_id LEFT JOIN jobs j ON j.id = r.job_id WHERE r.status = 'active' AND r.review_at < ?`)
    .all(now) as { ref: string; item_id: number; sku: string; job_ref: string | null; review_at: string }[]) {
    out.push({ kind: 'reservation', label: `${r.ref}: ${r.sku} for ${r.job_ref ?? 'no job'}`, detail: 'Reservation past its review date', href: `/stock/items/${r.item_id}` });
  }
  for (const r of db
    .prepare(
      `SELECT i.id, i.sku, i.name, i.min_level, COALESCE(SUM(CASE WHEN b.state = 'available' AND b.owner_type = 'frostline' THEN b.qty END), 0) AS avail
       FROM stock_items i LEFT JOIN stock_balances b ON b.item_id = i.id WHERE i.active = 1 AND i.min_level IS NOT NULL GROUP BY i.id HAVING avail < i.min_level`,
    )
    .all() as { id: number; sku: string; name: string; min_level: number; avail: number }[]) {
    out.push({ kind: 'low', label: `${r.sku} ${r.name}`, detail: `${r.avail} available, minimum ${r.min_level}`, href: `/stock/items/${r.id}` });
  }
  return out;
}

/**
 * Reports: counts with explicit denominators and time basis (Q032: no vanity averages).
 */
export function reports(db: DB, days = 30) {
  const now = clock.now();
  const since = new Date(now.getTime() - days * DAY).toISOString();
  const received = db.prepare(`SELECT priority, kind, COUNT(*) n FROM jobs WHERE received_at >= ? GROUP BY priority, kind`).all(since) as { priority: string; kind: string; n: number }[];

  // SLA outcomes for contracted jobs received in the period
  const jobs = db.prepare(`SELECT id, contract_id, priority, received_at FROM jobs WHERE contract_id IS NOT NULL AND received_at >= ?`).all(since) as {
    id: number;
    contract_id: number;
    priority: string;
    received_at: string;
  }[];
  const sla: Record<string, { met: number; missed: number; breached: number; open: number; total: number }> = {};
  for (const j of jobs) {
    for (const m of computeSla(db, j)) {
      if (m.state === 'no_target') continue;
      const s = (sla[m.measure] ??= { met: 0, missed: 0, breached: 0, open: 0, total: 0 });
      s.total++;
      if (m.state === 'met') s.met++;
      else if (m.state === 'missed') s.missed++;
      else if (m.state === 'breached') s.breached++;
      else s.open++;
    }
  }
  const outcomes = db
    .prepare(`SELECT COALESCE(o.label, a.outcome) AS outcome, COUNT(*) n FROM attendances a LEFT JOIN outcome_codes o ON o.code = a.outcome WHERE a.status = 'submitted' AND a.submitted_at >= ? GROUP BY a.outcome ORDER BY n DESC`)
    .all(since) as { outcome: string; n: number }[];
  const submitted = outcomes.reduce((s, o) => s + o.n, 0);
  const quotes = db
    .prepare(
      `SELECT
         SUM(CASE WHEN issued_at >= ? THEN 1 ELSE 0 END) AS issued,
         SUM(CASE WHEN status = 'accepted' AND issued_at >= ? THEN 1 ELSE 0 END) AS accepted,
         SUM(CASE WHEN status = 'declined' AND issued_at >= ? THEN 1 ELSE 0 END) AS declined,
         SUM(CASE WHEN status = 'expired' AND issued_at >= ? THEN 1 ELSE 0 END) AS expired,
         SUM(CASE WHEN status = 'issued' THEN 1 ELSE 0 END) AS outstanding
       FROM quote_revisions`,
    )
    .get(since, since, since, since) as { issued: number; accepted: number; declined: number; expired: number; outstanding: number };
  const acceptedValue = (db.prepare(`SELECT COALESCE(SUM(accepted_net_pence), 0) v, COUNT(*) n FROM acceptances WHERE recorded_at >= ?`).get(since) as { v: number; n: number });
  const ageing = db
    .prepare(
      `SELECT CASE WHEN julianday(?) - julianday(received_at) < 2 THEN '0–2 days' WHEN julianday(?) - julianday(received_at) < 7 THEN '2–7 days'
         WHEN julianday(?) - julianday(received_at) < 30 THEN '7–30 days' ELSE '30+ days' END AS bucket, COUNT(*) n
       FROM jobs WHERE op_status IN ${OPEN_IN} GROUP BY bucket`,
    )
    .all(now.toISOString(), now.toISOString(), now.toISOString()) as { bucket: string; n: number }[];
  const openClosure = db
    .prepare(`SELECT financial_status, commercial_status, COUNT(*) n FROM jobs WHERE op_status = 'operationally_complete' AND financial_status <> 'financially_closed' GROUP BY financial_status, commercial_status`)
    .all() as { financial_status: string; commercial_status: string; n: number }[];
  return { days, since, received, sla, outcomes, submitted, quotes, acceptedValue, ageing, openClosure };
}
