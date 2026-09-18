import type { DB } from '../db/db.ts';
import type { Actor } from '../auth/policy.ts';
import { clock } from '../lib/clock.ts';
import { correlationId } from '../lib/context.ts';

/**
 * Append-only audit writer (NFR-006). Always call inside the same transaction as the
 * change it describes so an audited change and its audit record commit together.
 */
export function audit(
  db: DB,
  actor: Actor | null,
  entityType: string,
  entityId: number | null,
  action: string,
  opts: { reason?: string | null; before?: unknown; after?: unknown } = {},
): void {
  db.prepare(
    `INSERT INTO audit_events (at, actor_id, actor_role, entity_type, entity_id, action, reason, before_json, after_json, correlation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    clock.iso(),
    actor?.id ?? null,
    actor?.role ?? null,
    entityType,
    entityId,
    action,
    opts.reason ?? null,
    opts.before === undefined ? null : JSON.stringify(opts.before),
    opts.after === undefined ? null : JSON.stringify(opts.after),
    correlationId(),
  );
}

export function auditFor(db: DB, entityType: string, entityId: number) {
  return db
    .prepare(
      `SELECT a.*, u.display_name AS actor_name FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id
       WHERE entity_type = ? AND entity_id = ? ORDER BY a.id DESC`,
    )
    .all(entityType, entityId) as AuditRow[];
}

export interface AuditRow {
  id: number;
  at: string;
  actor_id: number | null;
  actor_name: string | null;
  actor_role: string | null;
  entity_type: string;
  entity_id: number | null;
  action: string;
  reason: string | null;
  before_json: string | null;
  after_json: string | null;
  correlation_id: string | null;
}

export function notify(db: DB, userId: number, kind: string, message: string, link?: string) {
  db.prepare('INSERT INTO notifications (user_id, kind, message, link, created_at) VALUES (?, ?, ?, ?, ?)').run(userId, kind, message, link ?? null, clock.iso());
}
