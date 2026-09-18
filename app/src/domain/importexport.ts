import type { DB } from '../db/db.ts';
import { tx } from '../db/db.ts';
import { type Actor, requireCap } from '../auth/policy.ts';
import { audit } from './audit.ts';
import { clock } from '../lib/clock.ts';
import { DomainError } from '../lib/errors.ts';
import { nextRef } from '../lib/refs.ts';

/**
 * CSV seam for master data (FR-033, ADR-008). This is a file interface for migration from
 * spreadsheets and for handing data to other systems — not an accounting integration.
 */

export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    // Neutralise spreadsheet formula injection.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\r\n') + '\r\n';
}

export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f !== '')) out.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== '')) out.push(row);
  return out;
}

export const EXPORTS = {
  customers: {
    label: 'Customers',
    columns: ['ref', 'trading_name', 'legal_name', 'company_number', 'billing_address', 'billing_email', 'po_required', 'sector', 'status'],
    sql: `SELECT ref, trading_name, legal_name, company_number, billing_address, billing_email, po_required, sector, status FROM customers ORDER BY ref`,
  },
  sites: {
    label: 'Sites',
    columns: ['ref', 'customer_ref', 'name', 'address', 'town', 'postcode', 'area', 'opening_hours', 'induction_required', 'status'],
    sql: `SELECT s.ref, c.ref AS customer_ref, s.name, s.address, s.town, s.postcode, s.area, s.opening_hours, s.induction_required, s.status FROM sites s JOIN customers c ON c.id = s.customer_id ORDER BY s.ref`,
  },
  contacts: {
    label: 'Contacts',
    columns: ['customer_ref', 'site_ref', 'name', 'role_type', 'job_title', 'phone', 'email', 'can_authorise_spend'],
    sql: `SELECT c.ref AS customer_ref, s.ref AS site_ref, ct.name, ct.role_type, ct.job_title, ct.phone, ct.email, ct.can_authorise_spend FROM contacts ct JOIN customers c ON c.id = ct.customer_id LEFT JOIN sites s ON s.id = ct.site_id ORDER BY c.ref, ct.name`,
  },
  assets: {
    label: 'Assets',
    columns: ['ref', 'site_ref', 'category', 'description', 'manufacturer', 'model', 'serial', 'location_detail', 'refrigerant', 'install_date', 'ownership_note', 'status'],
    sql: `SELECT a.ref, s.ref AS site_ref, a.category, a.description, a.manufacturer, a.model, a.serial, a.location_detail, a.refrigerant, a.install_date, a.ownership_note, a.status FROM assets a JOIN sites s ON s.id = a.site_id ORDER BY a.ref`,
  },
  stock_items: {
    label: 'Stock items',
    columns: ['sku', 'name', 'category', 'unit', 'manufacturer', 'part_number', 'min_level'],
    sql: `SELECT sku, name, category, unit, manufacturer, part_number, min_level FROM stock_items WHERE active = 1 ORDER BY sku`,
  },
  jobs: {
    label: 'Jobs (operational, financial & commercial status)',
    columns: ['ref', 'kind', 'customer_ref', 'site_ref', 'title', 'priority', 'received_at', 'op_status', 'financial_status', 'commercial_status', 'customer_po', 'authority_basis', 'authority_ref'],
    sql: `SELECT j.ref, j.kind, c.ref AS customer_ref, s.ref AS site_ref, j.title, j.priority, j.received_at, j.op_status, j.financial_status, j.commercial_status, j.customer_po, j.authority_basis, j.authority_ref
          FROM jobs j JOIN customers c ON c.id = j.customer_id JOIN sites s ON s.id = j.site_id ORDER BY j.ref`,
  },
} as const;
export type ExportKey = keyof typeof EXPORTS;

export function exportCsv(db: DB, actor: Actor, key: ExportKey): string {
  requireCap(actor, 'data.export');
  const def = EXPORTS[key];
  if (!def) throw new DomainError('Unknown export.');
  const rows = db.prepare(def.sql).all() as Record<string, unknown>[];
  audit(db, actor, 'export', null, `exported_${key}`, { after: { rows: rows.length } });
  return toCsv(rows, [...def.columns]);
}

export const IMPORTS = {
  customers: { label: 'Customers', required: ['trading_name'], optional: ['ref', 'legal_name', 'company_number', 'billing_address', 'billing_email', 'sector', 'status'] },
  sites: { label: 'Sites', required: ['customer_ref', 'name', 'address'], optional: ['ref', 'town', 'postcode', 'area', 'opening_hours'] },
  assets: { label: 'Assets', required: ['site_ref', 'category', 'description'], optional: ['ref', 'manufacturer', 'model', 'serial', 'location_detail', 'refrigerant', 'install_date', 'ownership_note'] },
} as const;
export type ImportKey = keyof typeof IMPORTS;

export interface ImportRowResult {
  line: number;
  action: 'create' | 'skip' | 'error';
  message: string;
}

/**
 * Validates (and when commit=true, applies) a CSV import in one transaction. Existing refs are
 * skipped, never overwritten, so an import can't silently change live records.
 */
export function importCsv(db: DB, actor: Actor, key: ImportKey, text: string, commit: boolean): ImportRowResult[] {
  requireCap(actor, 'data.import');
  const def = IMPORTS[key];
  if (!def) throw new DomainError('Unknown import type.');
  const rows = parseCsv(text);
  if (rows.length < 2) throw new DomainError('The file needs a header row and at least one data row.');
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const missing = def.required.filter((r) => !header.includes(r));
  if (missing.length) throw new DomainError(`Missing required column(s): ${missing.join(', ')}`);
  if (rows.length > 5001) throw new DomainError('Import up to 5,000 rows at a time.');
  const results: ImportRowResult[] = [];
  const run = () => {
    const now = clock.iso();
    rows.slice(1).forEach((cells, i) => {
      const line = i + 2;
      const rec: Record<string, string | null> = {};
      header.forEach((h, idx) => (rec[h] = cells[idx]?.trim() || null));
      const miss = def.required.filter((r) => !rec[r]);
      if (miss.length) return results.push({ line, action: 'error', message: `Missing ${miss.join(', ')}` });
      if (key === 'customers') {
        if (rec.ref && db.prepare('SELECT 1 FROM customers WHERE ref = ?').get(rec.ref)) return results.push({ line, action: 'skip', message: `${rec.ref} already exists` });
        if (rec.status && !['active', 'prospect', 'inactive'].includes(rec.status)) return results.push({ line, action: 'error', message: 'status must be active, prospect or inactive' });
        const ref = rec.ref ?? nextRef(db, 'CUS');
        db.prepare(
          `INSERT INTO customers (ref, trading_name, legal_name, company_number, billing_address, billing_email, sector, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(ref, rec.trading_name, rec.legal_name, rec.company_number, rec.billing_address, rec.billing_email, rec.sector, rec.status ?? 'active', now, now);
        results.push({ line, action: 'create', message: `${ref} ${rec.trading_name}` });
      } else if (key === 'sites') {
        const c = db.prepare('SELECT id FROM customers WHERE ref = ?').get(rec.customer_ref) as { id: number } | undefined;
        if (!c) return results.push({ line, action: 'error', message: `Unknown customer_ref ${rec.customer_ref}` });
        if (rec.ref && db.prepare('SELECT 1 FROM sites WHERE ref = ?').get(rec.ref)) return results.push({ line, action: 'skip', message: `${rec.ref} already exists` });
        const ref = rec.ref ?? nextRef(db, 'S');
        db.prepare(`INSERT INTO sites (customer_id, ref, name, address, town, postcode, area, opening_hours, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          c.id,
          ref,
          rec.name,
          rec.address,
          rec.town,
          rec.postcode,
          rec.area,
          rec.opening_hours,
          now,
          now,
        );
        results.push({ line, action: 'create', message: `${ref} ${rec.name}` });
      } else {
        const s = db.prepare('SELECT id FROM sites WHERE ref = ?').get(rec.site_ref) as { id: number } | undefined;
        if (!s) return results.push({ line, action: 'error', message: `Unknown site_ref ${rec.site_ref}` });
        if (rec.ref && db.prepare('SELECT 1 FROM assets WHERE ref = ?').get(rec.ref)) return results.push({ line, action: 'skip', message: `${rec.ref} already exists` });
        if (rec.install_date && !/^\d{4}-\d{2}-\d{2}$/.test(rec.install_date)) return results.push({ line, action: 'error', message: 'install_date must be YYYY-MM-DD' });
        const ref = rec.ref ?? nextRef(db, 'AS', 10000);
        db.prepare(
          `INSERT INTO assets (site_id, ref, category, description, manufacturer, model, serial, location_detail, refrigerant, install_date, ownership_note, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(s.id, ref, rec.category, rec.description, rec.manufacturer, rec.model, rec.serial, rec.location_detail, rec.refrigerant, rec.install_date, rec.ownership_note, now, now);
        results.push({ line, action: 'create', message: `${ref} ${rec.description}` });
      }
    });
    if (commit) {
      if (results.some((r) => r.action === 'error')) throw new DomainError('Fix the rows with errors before importing; nothing was imported.');
      audit(db, actor, 'import', null, `imported_${key}`, { after: { created: results.filter((r) => r.action === 'create').length, skipped: results.filter((r) => r.action === 'skip').length } });
    } else {
      throw new DryRun();
    }
  };
  try {
    tx(db, run);
  } catch (e) {
    if (!(e instanceof DryRun)) throw e;
  }
  return results;
}

class DryRun extends Error {}
