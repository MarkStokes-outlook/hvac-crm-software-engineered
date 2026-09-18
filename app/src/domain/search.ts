import type { DB } from '../db/db.ts';
import { type Actor, can } from '../auth/policy.ts';

export interface SearchHit {
  type: 'customer' | 'site' | 'contact' | 'asset' | 'job' | 'quote' | 'attendance';
  id: number;
  title: string;
  subtitle: string;
  href: string;
}

/**
 * Global search across core identifiers and history text (FR-032, AC-070-02). Engineers only
 * see results tied to work assigned to them.
 */
export function search(db: DB, actor: Actor, q: string, perType = 8): SearchHit[] {
  const term = q.trim();
  if (term.length < 2) return [];
  const like = `%${term}%`;
  const hits: SearchHit[] = [];
  const engineer = actor.role === 'engineer';
  const assignedJobs = engineer ? `AND j.id IN (SELECT job_id FROM attendances WHERE engineer_user_id = ${Number(actor.id)} AND status <> 'cancelled')` : '';

  if (can(actor, 'crm.read')) {
    for (const r of db
      .prepare(`SELECT id, ref, trading_name, legal_name, sector FROM customers WHERE trading_name LIKE ? OR legal_name LIKE ? OR ref LIKE ? OR company_number LIKE ? ORDER BY trading_name LIMIT ?`)
      .all(like, like, like, like, perType) as { id: number; ref: string; trading_name: string; legal_name: string | null; sector: string | null }[]) {
      hits.push({ type: 'customer', id: r.id, title: r.trading_name, subtitle: [r.ref, r.legal_name, r.sector].filter(Boolean).join(' · '), href: `/customers/${r.id}` });
    }
    for (const r of db
      .prepare(
        `SELECT s.id, s.ref, s.name, s.postcode, s.town, c.trading_name FROM sites s JOIN customers c ON c.id = s.customer_id
         WHERE s.name LIKE ? OR s.ref LIKE ? OR s.postcode LIKE ? OR s.address LIKE ? OR s.town LIKE ? ORDER BY s.name LIMIT ?`,
      )
      .all(like, like, like, like, like, perType) as { id: number; ref: string; name: string; postcode: string | null; town: string | null; trading_name: string }[]) {
      hits.push({ type: 'site', id: r.id, title: r.name, subtitle: [r.trading_name, r.town, r.postcode, r.ref].filter(Boolean).join(' · '), href: `/sites/${r.id}` });
    }
    for (const r of db
      .prepare(
        `SELECT ct.id, ct.name, ct.role_type, ct.phone, ct.email, ct.customer_id, c.trading_name FROM contacts ct JOIN customers c ON c.id = ct.customer_id
         WHERE ct.name LIKE ? OR ct.email LIKE ? OR REPLACE(ct.phone, ' ', '') LIKE REPLACE(?, ' ', '') OR ct.notes LIKE ? ORDER BY ct.name LIMIT ?`,
      )
      .all(like, like, like, like, perType) as { id: number; name: string; role_type: string; phone: string | null; email: string | null; customer_id: number; trading_name: string }[]) {
      hits.push({ type: 'contact', id: r.id, title: r.name, subtitle: [r.role_type, r.trading_name, r.phone, r.email].filter(Boolean).join(' · '), href: `/customers/${r.customer_id}#contacts` });
    }
  }
  const assetScope = engineer ? `AND a.site_id IN (SELECT j.site_id FROM jobs j WHERE 1=1 ${assignedJobs})` : '';
  if (can(actor, 'crm.read') || engineer) {
    for (const r of db
      .prepare(
        `SELECT a.id, a.ref, a.description, a.manufacturer, a.model, a.serial, s.name AS site_name FROM assets a JOIN sites s ON s.id = a.site_id
         WHERE (a.ref LIKE ? OR a.serial LIKE ? OR a.model LIKE ? OR a.description LIKE ? OR a.manufacturer LIKE ?) ${assetScope} ORDER BY a.ref LIMIT ?`,
      )
      .all(like, like, like, like, like, perType) as { id: number; ref: string; description: string; manufacturer: string | null; model: string | null; serial: string | null; site_name: string }[]) {
      hits.push({
        type: 'asset',
        id: r.id,
        title: `${r.ref} ${r.description}`,
        subtitle: [r.manufacturer, r.model, r.serial && `S/N ${r.serial}`, r.site_name].filter(Boolean).join(' · '),
        href: `/assets/${r.id}`,
      });
    }
  }
  if (can(actor, 'job.read') || engineer) {
    for (const r of db
      .prepare(
        `SELECT j.id, j.ref, j.title, j.priority, j.op_status, s.name AS site_name, c.trading_name FROM jobs j JOIN sites s ON s.id = j.site_id JOIN customers c ON c.id = j.customer_id
         WHERE (j.ref LIKE ? OR j.title LIKE ? OR j.reported_symptom LIKE ? OR j.customer_po LIKE ? OR j.triage_notes LIKE ?
           OR j.id IN (SELECT job_id FROM attendances WHERE ref LIKE ? OR diagnosis LIKE ? OR work_done LIKE ? OR observed_facts LIKE ?)) ${assignedJobs}
         ORDER BY j.received_at DESC LIMIT ?`,
      )
      .all(like, like, like, like, like, like, like, like, like, perType) as { id: number; ref: string; title: string; priority: string; op_status: string; site_name: string; trading_name: string }[]) {
      hits.push({ type: 'job', id: r.id, title: `${r.ref} ${r.title}`, subtitle: `${r.priority} · ${r.op_status.replace(/_/g, ' ')} · ${r.trading_name} · ${r.site_name}`, href: engineer ? `/jobs/${r.id}/brief` : `/jobs/${r.id}` });
    }
  }
  if (can(actor, 'quote.read')) {
    for (const r of db
      .prepare(`SELECT o.id, o.ref, o.title, o.maturity, c.trading_name FROM opportunities o JOIN customers c ON c.id = o.customer_id WHERE o.ref LIKE ? OR o.title LIKE ? ORDER BY o.updated_at DESC LIMIT ?`)
      .all(like, like, perType) as { id: number; ref: string; title: string; maturity: string; trading_name: string }[]) {
      hits.push({ type: 'quote', id: r.id, title: `${r.ref} ${r.title}`, subtitle: `${r.maturity} · ${r.trading_name}`, href: `/quotes/${r.id}` });
    }
  }
  return hits;
}
