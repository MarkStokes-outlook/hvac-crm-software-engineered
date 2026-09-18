import type { DB } from '../db/db.ts';
import { ForbiddenError } from '../lib/errors.ts';

export type Role = 'coordinator' | 'engineer' | 'estimator' | 'project' | 'warehouse' | 'finance' | 'manager' | 'admin';
export const ROLES: Role[] = ['coordinator', 'engineer', 'estimator', 'project', 'warehouse', 'finance', 'manager', 'admin'];
export const ROLE_LABEL: Record<Role, string> = {
  coordinator: 'Service coordinator',
  engineer: 'Field engineer',
  estimator: 'Sales / estimating',
  project: 'Installation / project',
  warehouse: 'Warehouse / procurement',
  finance: 'Finance',
  manager: 'Manager / director',
  admin: 'Administrator',
};

export interface Actor {
  id: number;
  role: Role;
  name: string;
}

/**
 * Central capability map (ADR-005). Pages hide what a role cannot do, but every
 * mutation re-checks here server-side (AC-002-02). Monetary authority is not in
 * this map: it lives in the configurable approval_policies table.
 */
const CAPS = {
  'crm.read': ['coordinator', 'estimator', 'project', 'warehouse', 'finance', 'manager', 'admin'],
  'crm.write': ['coordinator', 'estimator', 'project', 'manager', 'admin'],
  'crm.billing.write': ['finance', 'manager'],
  'site.security.read': ['coordinator', 'project', 'manager', 'estimator'], // engineers: only for sites they are assigned to
  'contract.write': ['manager'],
  'job.read': ['coordinator', 'estimator', 'project', 'warehouse', 'finance', 'manager'],
  'job.create': ['coordinator', 'manager', 'project'],
  'job.triage': ['coordinator', 'manager'],
  'job.priority': ['coordinator', 'manager'],
  'job.authorise': ['coordinator', 'manager'],
  'job.readiness': ['coordinator', 'manager', 'project'],
  'job.waiting': ['coordinator', 'manager', 'project'],
  'job.note': ['coordinator', 'manager', 'project', 'estimator', 'finance', 'warehouse'],
  'job.close.operational': ['coordinator', 'manager'],
  'job.close.financial': ['finance', 'manager'],
  'job.commercial': ['finance', 'manager', 'estimator'],
  'job.cancel': ['coordinator', 'manager'],
  'temp.resolve': ['coordinator', 'manager'],
  'sla.record': ['coordinator', 'manager'],
  'sla.clockstop': ['coordinator', 'manager'],
  'schedule.read': ['coordinator', 'project', 'manager', 'warehouse'],
  'schedule.assign': ['coordinator', 'manager'],
  'schedule.override': ['coordinator', 'manager'],
  'schedule.displace': ['coordinator', 'manager'],
  'attendance.execute': ['engineer'],
  'escalation.resolve': ['coordinator', 'manager'],
  'quote.read': ['estimator', 'manager', 'project', 'coordinator', 'finance'],
  'quote.write': ['estimator', 'manager'],
  'quote.issue': ['estimator', 'manager'],
  'quote.accept.record': ['estimator', 'manager'],
  'variation.create': ['estimator', 'project', 'manager', 'coordinator'],
  'project.write': ['project', 'manager'],
  'stock.read': ['warehouse', 'coordinator', 'manager', 'project', 'engineer', 'finance'],
  'stock.receive': ['warehouse', 'manager'],
  'stock.reserve': ['warehouse', 'coordinator', 'manager', 'project'],
  'stock.move': ['warehouse', 'manager'],
  'stock.assess': ['warehouse', 'manager'],
  'stock.custody': ['warehouse', 'manager'],
  'stock.item.write': ['warehouse', 'manager', 'admin'],
  'engineer.material.use': ['engineer'],
  'reports.read': ['coordinator', 'manager', 'finance', 'project'],
  'audit.read': ['manager', 'admin'],
  'admin.users': ['admin'],
  'admin.config': ['admin', 'manager'],
  'data.export': ['manager', 'admin', 'finance'],
  'data.import': ['admin'],
  'ai.use': ['coordinator', 'manager', 'estimator', 'project', 'engineer'],
} as const satisfies Record<string, readonly Role[]>;

export type Capability = keyof typeof CAPS;

export function can(actor: Actor | null | undefined, cap: Capability): boolean {
  return !!actor && (CAPS[cap] as readonly Role[]).includes(actor.role);
}

export function requireCap(actor: Actor, cap: Capability, message?: string): void {
  if (!can(actor, cap)) throw new ForbiddenError(message ?? `Your role (${ROLE_LABEL[actor.role]}) cannot perform this action.`);
}

/** Approval actions governed by configurable policy (FR-022, DISC-D008). */
export const APPROVAL_ACTIONS = {
  'quote.approve': 'Internally approve a quotation revision for issue',
  'quote.release': 'Commercially release accepted work (authority to purchase/start)',
  'variation.approve': 'Approve a post-award variation',
  'stock.reallocate': 'Reallocate reserved stock away from its work',
  'stock.dispose': 'Dispose of stock or release evidence-held material',
} as const;
export type ApprovalAction = keyof typeof APPROVAL_ACTIONS;

export interface ApprovalDecision {
  allowed: boolean;
  limitPence: number | null;
  limitConfigured: boolean;
  message: string;
}

/**
 * Evaluates the configurable approval policy. A role may approve an action only if a
 * policy row exists for it. Monetary limits apply only where someone configured them;
 * discovery did not establish thresholds, so none are seeded (AC-051-04).
 */
export function checkApproval(db: DB, actor: Actor, action: ApprovalAction, valuePence: number | null): ApprovalDecision {
  const row = db.prepare('SELECT max_value_pence FROM approval_policies WHERE action = ? AND role = ?').get(action, actor.role) as
    | { max_value_pence: number | null }
    | undefined;
  if (!row) {
    return { allowed: false, limitPence: null, limitConfigured: false, message: `Approval policy does not grant "${APPROVAL_ACTIONS[action]}" to ${ROLE_LABEL[actor.role]}.` };
  }
  if (row.max_value_pence !== null && valuePence !== null && valuePence > row.max_value_pence) {
    return {
      allowed: false,
      limitPence: row.max_value_pence,
      limitConfigured: true,
      message: `Value exceeds the configured approval limit for ${ROLE_LABEL[actor.role]}.`,
    };
  }
  return {
    allowed: true,
    limitPence: row.max_value_pence,
    limitConfigured: row.max_value_pence !== null,
    message: row.max_value_pence === null ? 'No monetary threshold configured for this role (governance decision pending).' : 'Within configured limit.',
  };
}

export function requireApproval(db: DB, actor: Actor, action: ApprovalAction, valuePence: number | null): ApprovalDecision {
  const d = checkApproval(db, actor, action, valuePence);
  if (!d.allowed) throw new ForbiddenError(d.message);
  return d;
}
