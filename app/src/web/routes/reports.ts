import { html, raw } from '../../lib/html.ts';
import { fmtD, fmtDT } from '../../lib/clock.ts';
import { fmtMoney } from '../../lib/money.ts';
import { reports } from '../../domain/dashboard.ts';
import { auditLog } from '../../domain/admin.ts';
import { EXPORTS, type ExportKey, exportCsv, IMPORTS, type ImportKey, importCsv } from '../../domain/importexport.ts';
import { PRIORITY_LABEL } from '../../domain/jobs.ts';
import { banner, card, chip, defList, empty, form, labelise, page, pagination, select, table } from '../ui.ts';
import { actorOf, canReq, ctxOf, h, intQuery, needCap, ok, type RouteModule, send, strQuery } from '../kit.ts';
import { auditTable } from './jobs.ts';

const register: RouteModule = (app, { db }) => {
  app.get(
    '/reports',
    h((req, res) => {
      needCap(req, 'reports.read');
      const ctx = ctxOf(req);
      const days = intQuery(req, 'days') ?? 30;
      const r = reports(db, days);
      const byPriority = new Map<string, number>();
      const byKind = new Map<string, number>();
      for (const row of r.received) {
        byPriority.set(row.priority, (byPriority.get(row.priority) ?? 0) + row.n);
        byKind.set(row.kind, (byKind.get(row.kind) ?? 0) + row.n);
      }
      const totalReceived = [...byPriority.values()].reduce((a, b) => a + b, 0);

      send(
        res,
        page(ctx, {
          title: 'Reports',
          heading: 'Reports',
          sub: html`Derived from the records, with the denominator and time basis stated. Period: last ${String(days)} days (since ${fmtD(r.since)}).`,
          actions: html`${[7, 30, 90].map((d) => html`<a class="btn ${raw(d === days ? 'primary' : '')}" href="/reports?days=${String(d)}">${String(d)} days</a>`)}
            ${canReq(req, 'data.export') ? html`<a class="btn" href="/data">Import / export</a>` : ''}`,
          body: html`
            <div class="grid cols2">
              ${card({
                title: 'Work received',
                tight: true,
                body: table({
                  cols: ['Priority', { label: 'Jobs', num: true }, 'Share'],
                  rows: [...byPriority.entries()]
                    .sort()
                    .map(([p, n]) => [PRIORITY_LABEL[p as keyof typeof PRIORITY_LABEL] ?? p, String(n), html`<span class="tiny subtle">${totalReceived ? `${Math.round((n / totalReceived) * 100)}% of ${totalReceived}` : '—'}</span>`]),
                  empty: 'No jobs received in this period.',
                }),
                definition: `Jobs whose received date falls in the last ${days} days, counted by the priority they hold now.`,
              })}
              ${card({
                title: 'Work received by type',
                tight: true,
                body: table({ cols: ['Type', { label: 'Jobs', num: true }], rows: [...byKind.entries()].map(([k, n]) => [labelise(k), String(n)]), empty: 'None.' }),
                definition: `Same population as above, grouped by job type.`,
              })}
              ${card({
                title: 'Contractual SLA outcomes',
                tight: true,
                body: table({
                  cols: ['Target', { label: 'Met', num: true }, { label: 'Missed', num: true }, { label: 'Breached (open)', num: true }, { label: 'Still running', num: true }, { label: 'Measured', num: true }],
                  rows: Object.entries(r.sla).map(([measure, s]) => [labelise(measure), String(s.met), String(s.missed), String(s.breached), String(s.open), html`<b>${String(s.total)}</b>`]),
                  empty: 'No contracted jobs received in this period.',
                }),
                definition: `Jobs under a contract received in the last ${days} days, measured against that contract's target for their priority. Due times include permitted clock stops. "Measured" is the denominator — jobs with no target for that measure are excluded.`,
              })}
              ${card({
                title: 'Attendance outcomes',
                tight: true,
                body: table({
                  cols: ['Outcome', { label: 'Attendances', num: true }, 'Share'],
                  rows: r.outcomes.map((o) => [o.outcome ?? '—', String(o.n), html`<span class="tiny subtle">${r.submitted ? `${Math.round((o.n / r.submitted) * 100)}% of ${r.submitted}` : '—'}</span>`]),
                  empty: 'No attendances submitted in this period.',
                }),
                definition: `Attendances submitted in the last ${days} days, by the outcome the engineer recorded.`,
              })}
              ${card({
                title: 'Open work by age',
                tight: true,
                body: table({ cols: ['Age since received', { label: 'Open jobs', num: true }], rows: r.ageing.map((a) => [a.bucket, String(a.n)]), empty: 'Nothing open.' }),
                definition: 'All jobs that are not operationally complete or cancelled, by how long ago they were received.',
              })}
              ${card({
                title: 'Quotations',
                body: defList([
                  ['Issued in period', String(r.quotes.issued ?? 0)],
                  ['Accepted (of those issued)', String(r.quotes.accepted ?? 0)],
                  ['Declined', String(r.quotes.declined ?? 0)],
                  ['Expired', String(r.quotes.expired ?? 0)],
                  ['Still outstanding with customers', String(r.quotes.outstanding ?? 0)],
                  ['Acceptances recorded in period', `${r.acceptedValue.n} · ${fmtMoney(r.acceptedValue.v)} net`],
                ]),
                definition: `Revisions issued in the last ${days} days and their current status, plus acceptances recorded in the same window. "Outstanding" counts every revision still sitting at issued, regardless of when it was sent.`,
              })}
              ${card({
                title: 'Completed work awaiting closure',
                tight: true,
                body: table({
                  cols: ['Financial', 'Commercial', { label: 'Jobs', num: true }],
                  rows: r.openClosure.map((o) => [labelise(o.financial_status), labelise(o.commercial_status), String(o.n)]),
                  empty: 'Nothing operationally complete is awaiting financial or commercial closure.',
                }),
                definition: 'Operationally complete jobs that are not yet financially closed — the gap between finishing work and finishing the paperwork.',
              })}
            </div>
          `,
        }),
      );
    }),
  );

  // ---------------------------------------------------------------- audit log
  app.get(
    '/audit',
    h((req, res) => {
      needCap(req, 'audit.read');
      const ctx = ctxOf(req);
      const limit = 100;
      const offset = intQuery(req, 'offset') ?? 0;
      const entityType = strQuery(req, 'entity');
      const { rows, total } = auditLog(db, { entityType, limit, offset });
      send(
        res,
        page(ctx, {
          title: 'Audit log',
          heading: 'Audit log',
          sub: 'Append-only record of consequential decisions: priority, authority, clock stops, schedule displacement, approvals, stock state and closure.',
          body: html`
            <form class="filters card" method="get" action="/audit" style="padding:12px" data-autosubmit>
              ${select({
                name: 'entity',
                label: 'Record type',
                value: entityType ?? '',
                blank: 'All',
                options: ['job', 'attendance', 'customer', 'site', 'asset', 'contact', 'reservation', 'stock_item', 'goods_receipt', 'evidence_hold', 'quote_revision', 'opportunity', 'acceptance', 'variation', 'user', 'approval_policy', 'setting', 'export', 'import'].map((v) => ({ value: v, label: labelise(v) })),
              })}
              <button class="btn" type="submit">Apply</button>
            </form>
            ${card({ tight: true, body: auditTable(rows), foot: pagination({ total, limit, offset, base: `/audit?${entityType ? `entity=${entityType}` : ''}` }) })}
          `,
        }),
      );
    }),
  );

  // ---------------------------------------------------------------- import / export (US-072)
  app.get(
    '/data',
    h((req, res) => {
      needCap(req, 'data.export');
      const ctx = ctxOf(req);
      const results = (req.query.result as string) ?? '';
      send(
        res,
        page(ctx, {
          title: 'Import and export',
          heading: 'Import and export',
          narrow: true,
          sub: 'CSV in and out for master data. This is a file seam for migrating off spreadsheets — there is no accounting or portal integration.',
          body: html`
            ${banner('info', 'No external system is connected. Exports are plain CSV files; imports are validated, previewed and only then applied.')}
            ${card({
              title: 'Export',
              tight: true,
              body: table({
                cols: ['Data', 'Columns', ''],
                rows: Object.entries(EXPORTS).map(([key, def]) => [def.label, html`<span class="tiny subtle mono-sm">${def.columns.join(', ')}</span>`, html`<a class="btn small" href="/data/export/${key}">Download CSV</a>`]),
              }),
            })}
            ${
              canReq(req, 'data.import')
                ? card({
                    title: 'Import',
                    body: html`
                      ${results ? banner(results.includes('imported') ? 'ok' : 'warn', html`${results}`) : ''}
                      <p class="tiny subtle">Rows with an existing reference are skipped, never overwritten. Preview first: nothing is written until you tick “apply”.</p>
                      <form method="post" action="/data/import" enctype="multipart/form-data" class="stack">
                        <input type="hidden" name="_csrf" value="${ctx.csrf}">
                        ${select({ name: 'kind', label: 'What you are importing', required: true, options: Object.entries(IMPORTS).map(([k, v]) => ({ value: k, label: `${v.label} — required: ${v.required.join(', ')}` })) })}
                        <div class="field"><label for="f_file">CSV file</label><input id="f_file" type="file" name="file" accept=".csv,text/csv" required></div>
                        <label class="check"><input type="checkbox" name="commit" value="1"><span>Apply the import (leave unticked to preview)</span></label>
                        <div class="btnrow"><button class="btn primary" type="submit">Upload</button></div>
                      </form>
                    `,
                  })
                : ''
            }
          `,
        }),
      );
    }),
  );

  app.get(
    '/data/export/:key',
    h((req, res) => {
      const key = String(req.params.key) as ExportKey;
      if (!(key in EXPORTS)) {
        res.status(404).type('text').send('Unknown export');
        return;
      }
      const csv = exportCsv(db, actorOf(req), key);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="frostline-${key}-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send(csv);
    }),
  );

  app.post(
    '/data/import',
    h((req, res) => {
      const ctx = ctxOf(req);
      const kind = String(req.body?.kind ?? '') as ImportKey;
      const commit = String(req.body?.commit ?? '') === '1';
      const text = req.file?.buffer?.toString('utf8') ?? '';
      const results = importCsv(db, actorOf(req), kind, text, commit);
      const created = results.filter((r) => r.action === 'create').length;
      const skipped = results.filter((r) => r.action === 'skip').length;
      const errors = results.filter((r) => r.action === 'error');
      send(
        res,
        page(ctx, {
          title: commit ? 'Import applied' : 'Import preview',
          heading: commit ? 'Import applied' : 'Import preview',
          narrow: true,
          crumbs: [{ href: '/data', label: 'Import and export' }, { label: commit ? 'Applied' : 'Preview' }],
          body: html`
            ${
              errors.length
                ? banner('err', html`${String(errors.length)} row${errors.length === 1 ? '' : 's'} cannot be imported. Fix them and upload again — ${commit ? 'nothing was written' : 'nothing has been written'}.`)
                : commit
                  ? banner('ok', html`${String(created)} record${created === 1 ? '' : 's'} imported${skipped ? `, ${skipped} skipped as already present` : ''}.`)
                  : banner('info', html`Preview only — nothing has been written. ${String(created)} would be created${skipped ? `, ${skipped} skipped as already present` : ''}.`)
            }
            ${card({
              tight: true,
              body: table({
                cols: [{ label: 'Line', num: true }, 'Outcome', 'Detail'],
                rows: results.slice(0, 500).map((r) => [String(r.line), chip(labelise(r.action), r.action === 'create' ? 'ok' : r.action === 'skip' ? 'neutral' : 'danger'), r.message]),
                empty: 'No data rows found.',
              }),
            })}
            <div class="btnrow"><a class="btn" href="/data">Back to import and export</a></div>
          `,
        }),
      );
    }),
  );
};

export default register;
