import { html, raw } from '../../lib/html.ts';
import { clock, fmtD, fmtDT } from '../../lib/clock.ts';
import * as Inv from '../../domain/inventory.ts';
import * as J from '../../domain/jobs.ts';
import { stockExceptions } from '../../domain/dashboard.ts';
import { auditFor } from '../../domain/audit.ts';
import {
  banner,
  card,
  checkbox,
  chip,
  defList,
  drawer,
  dtInput,
  enumOptions,
  form,
  idemInput,
  input,
  labelise,
  options,
  page,
  pagination,
  prose,
  select,
  staffOptions,
  table,
  textarea,
  when,
} from '../ui.ts';
import { actorOf, back, canReq, ctxOf, h, intParam, intQuery, needCap, ok, type RouteModule, send, strQuery } from '../kit.ts';
import { auditTable } from './jobs.ts';

const register: RouteModule = (app, { db }) => {
  // ---------------------------------------------------------------- stock list (US-060)
  app.get(
    '/stock',
    h((req, res) => {
      needCap(req, 'stock.read');
      const ctx = ctxOf(req);
      const limit = 100;
      const offset = intQuery(req, 'offset') ?? 0;
      const q = strQuery(req, 'q');
      const locationId = intQuery(req, 'location');
      const exceptions = strQuery(req, 'exceptions') === '1';
      const { rows, total } = Inv.stockSummary(db, { q, locationId, exceptions, limit, offset });
      const locations = Inv.locations(db);
      const exceptionList = stockExceptions(db);

      send(
        res,
        page(ctx, {
          title: 'Stock',
          heading: 'Stock',
          sub: 'Physical possession is not availability. Reserved, quarantined, evidence-held, customer-owned and job-specific stock are all excluded from what you can promise.',
          actions: html`${canReq(req, 'stock.receive') ? html`<a class="btn primary" href="/stock/receipts/new">Book in a delivery</a>` : ''}
            ${canReq(req, 'stock.assess') ? html`<a class="btn" href="/stock/returns">Assess returns</a>` : ''}
            ${canReq(req, 'stock.read') ? html`<a class="btn" href="/stock/holds">Evidence holds</a>` : ''}`,
          body: html`
            ${exceptionList.length ? banner('warn', html`${String(exceptionList.length)} stock exception${exceptionList.length === 1 ? '' : 's'} need attention — <a href="/stock?exceptions=1">show only those</a>.`) : ''}
            <form class="filters card" method="get" action="/stock" style="padding:12px" data-autosubmit>
              <div class="field wide"><label for="f_q">Search</label><input id="f_q" type="search" name="q" value="${q ?? ''}" placeholder="SKU, name, part number, manufacturer"></div>
              ${select({ name: 'location', label: 'Location', value: locationId ?? '', blank: 'All locations', options: options(locations.map((l) => ({ id: l.id, label: `${l.code} — ${l.name}` })), locationId ?? null) })}
              <label class="check"><input type="checkbox" name="exceptions" value="1" ${raw(exceptions ? 'checked' : '')}><span>Exceptions only</span></label>
              <button class="btn" type="submit">Apply</button>
              <a class="btn" href="/stock">Clear</a>
            </form>
            ${card({
              tight: true,
              body: table({
                cols: [
                  'Item',
                  { label: 'Available', num: true },
                  { label: 'Reserved', num: true },
                  { label: 'Picked', num: true },
                  { label: 'Quarantine', num: true },
                  { label: 'Return pending', num: true },
                  { label: 'Evidence', num: true },
                  { label: 'Customer / job owned', num: true },
                  { label: 'On hand', num: true },
                ],
                rows: rows.map((i) => [
                  html`<a class="rowtitle" href="/stock/items/${String(i.id)}">${i.sku}</a> ${i.name}<br><span class="tiny subtle">${[i.manufacturer, i.part_number, i.category].filter(Boolean).join(' · ')}</span>`,
                  html`<b class="${raw(i.min_level !== null && i.available < i.min_level ? 'chip danger' : '')}">${String(i.available)}</b>${i.min_level !== null ? html`<br><span class="tiny subtle">min ${String(i.min_level)}</span>` : ''}`,
                  String(i.reserved),
                  String(i.picked),
                  i.quarantined ? html`<span class="chip warn">${String(i.quarantined)}</span>` : '0',
                  i.return_pending ? html`<span class="chip warn">${String(i.return_pending)}</span>` : '0',
                  i.evidence_hold ? html`<span class="chip warn">${String(i.evidence_hold)}</span>` : '0',
                  String(i.customer_owned + i.job_specific),
                  html`<b>${String(i.on_hand)}</b>`,
                ]),
                empty: 'No items match.',
              }),
              foot: pagination({ total, limit, offset, base: `/stock?${new URLSearchParams(Object.entries({ q: q ?? '', location: locationId ? String(locationId) : '', exceptions: exceptions ? '1' : '' }).filter(([, v]) => v)).toString()}` }),
              definition: 'Available means FrostLine-owned stock in a usable state at a location. Everything else is shown separately because it cannot be promised to the next job.',
            })}
            ${
              exceptionList.length
                ? card({
                    title: 'Exceptions',
                    tight: true,
                    body: table({
                      cols: ['Exception', 'Detail', 'Type'],
                      rows: exceptionList.map((e) => [html`<a href="${e.href}">${e.label}</a>`, html`<span class="tiny subtle">${e.detail}</span>`, chip(labelise(e.kind), 'warn')]),
                    }),
                  })
                : ''
            }
          `,
        }),
      );
    }),
  );

  // ---------------------------------------------------------------- item page
  app.get(
    '/stock/items/:id',
    h((req, res) => {
      needCap(req, 'stock.read');
      const ctx = ctxOf(req);
      const id = intParam(req);
      const item = Inv.itemSummary(db, id);
      const balances = Inv.balancesForItem(db, id);
      const reservations = Inv.reservationsFor(db, { itemId: id });
      const movements = Inv.movementsFor(db, { itemId: id }, 60);
      const locations = Inv.locations(db);
      const staff = J.staffOptions(db);
      const openJobs = J.listJobs(db, { status: 'open', limit: 200 }).rows;

      send(
        res,
        page(ctx, {
          title: `${item.sku} ${item.name}`,
          heading: `${item.sku} — ${item.name}`,
          crumbs: [{ href: '/stock', label: 'Stock' }, { label: item.sku }],
          sub: html`${[item.manufacturer, item.part_number, item.category].filter(Boolean).join(' · ')}`,
          body: html`
            <div class="grid split">
              <div>
                ${card({
                  title: 'Where it is and what state it is in',
                  tight: true,
                  body: table({
                    cols: ['Location', 'State', 'Ownership', { label: 'Qty', num: true }],
                    rows: balances.map((b) => [
                      html`${b.location_code}<br><span class="tiny subtle">${b.location_name}</span>`,
                      chip(Inv.STATE_LABEL[b.state], b.state === 'available' ? 'ok' : b.state === 'reserved' || b.state === 'picked' ? 'info' : 'warn'),
                      b.owner_type === 'frostline' ? html`<span class="subtle">FrostLine</span>` : html`${chip(labelise(b.owner_type), 'warn')} ${b.owner_label ?? ''}`,
                      html`<b>${String(b.qty)}</b>`,
                    ]),
                    empty: 'No stock of this item anywhere.',
                  }),
                })}
                ${card({
                  title: 'Reservations',
                  tight: true,
                  body: table({
                    cols: ['Ref', 'For', 'Purpose', { label: 'Qty', num: true }, 'Owner', 'Required / review', 'State', ''],
                    rows: reservations.map((r) => [
                      r.ref,
                      r.job_ref ? html`<a href="/jobs/${String(r.job_id)}">${r.job_ref}</a>` : (r.customer_name ?? '—'),
                      html`<span class="tiny">${r.purpose}${r.substitution_allowed ? ' · substitution allowed' : ' · no substitution'}<br>If reallocated: ${r.reallocation_consequence}</span>`,
                      String(r.qty_outstanding),
                      html`<span class="tiny">${r.owner_name}</span>`,
                      html`<span class="tiny">${fmtD(r.required_by)}<br>review ${fmtD(r.review_at)}${r.review_at < clock.iso() ? html` <span class="chip danger">overdue</span>` : ''}</span>`,
                      chip(labelise(r.status), r.status === 'active' ? 'info' : r.status === 'fulfilled' ? 'neutral' : 'neutral'),
                      r.status === 'active' && canReq(req, 'stock.reserve')
                        ? html`${drawer({
                            summary: 'Reallocate',
                            body: html`<p class="tiny subtle">Reallocating is an explicit decision: the original owner is notified and the displaced job gets a next action.</p>
                              ${form({
                                ctx,
                                action: `/reservations/${r.id}/reallocate`,
                                submit: 'Reallocate',
                                body: html`<div class="fields cols2">
                                    ${select({ name: 'to_job_id', label: 'To job', required: true, options: options(openJobs.map((j) => ({ id: j.id, label: `${j.ref} ${j.title}` }))) })}
                                    ${input({ name: 'qty', label: 'Quantity', type: 'number', min: 1, max: r.qty_outstanding, value: r.qty_outstanding, required: true })}
                                    ${select({ name: 'owner_user_id', label: 'New accountable owner', required: true, options: staffOptions(staff, ctx.user.id) })}
                                    ${dtInput({ name: 'required_by', label: 'Required by', required: true, iso: r.required_by })}
                                  </div>
                                  ${textarea({ name: 'reason', label: 'Why this work needs it more', rows: 2, required: true })}
                                  ${input({ name: 'reallocation_consequence', label: 'Consequence if it is reallocated again', required: true })}
                                  ${input({ name: 'displaced_next_action', label: 'What now happens for the original work', required: true, placeholder: 'e.g. Re-order part, tell customer of new date' })}
                                  <input type="hidden" name="__back" value="/stock/items/${String(id)}">`,
                              })}`,
                          })}
                          ${drawer({
                            summary: 'Release',
                            body: form({
                              ctx,
                              action: `/reservations/${r.id}/release`,
                              submit: 'Release reservation',
                              body: html`${input({ name: 'reason', label: 'Why it is no longer needed', required: true })}<input type="hidden" name="__back" value="/stock/items/${String(id)}">`,
                            }),
                          })}`
                        : '',
                    ]),
                    empty: 'No reservations.',
                  }),
                  definition: 'A reservation ties quantity to work, a purpose, an accountable owner, dates, a review point and the consequence of taking it away.',
                })}
                ${card({
                  title: 'Movement history',
                  tight: true,
                  body: table({
                    cols: [{ label: 'When', nowrap: true }, 'Movement', { label: 'Qty', num: true }, 'From → to', 'Against', 'Who', 'Reason'],
                    rows: movements.map((m) => [
                      when(m.at),
                      chip(labelise(m.movement_type), m.movement_type === 'issue' || m.movement_type === 'dispose' ? 'warn' : 'neutral'),
                      String(m.qty),
                      html`<span class="tiny">${[m.from_code, m.from_state].filter(Boolean).join(' / ') || '—'} → ${[m.to_code, m.to_state].filter(Boolean).join(' / ') || 'consumed'}</span>`,
                      html`<span class="tiny">${m.job_ref ?? m.reservation_ref ?? '—'}${m.recipient ? html`<br>${m.recipient}` : ''}${m.serial_batch ? html`<br>${m.serial_batch}` : ''}</span>`,
                      html`<span class="tiny">${m.actor_name}</span>`,
                      html`<span class="tiny subtle">${m.reason ?? ''}</span>`,
                    ]),
                    empty: 'No movements.',
                  }),
                  definition: 'Every quantity change is an append-only movement, so any balance can be explained.',
                })}
              </div>
              <div>
                ${card({
                  title: 'Availability',
                  body: html`<div class="kv">
                    <div><b>Available</b> <span class="count ${raw(item.min_level !== null && item.available < item.min_level ? 'danger' : 'ok')}">${String(item.available)}</span></div>
                    <div><b>On hand</b> ${String(item.on_hand)}</div>
                  </div>
                  ${defList([
                    ['Reserved', String(item.reserved)],
                    ['Picked', String(item.picked)],
                    ['Quarantined', String(item.quarantined)],
                    ['Return pending', String(item.return_pending)],
                    ['Evidence hold', String(item.evidence_hold)],
                    ['Customer-owned', String(item.customer_owned)],
                    ['Job-specific', String(item.job_specific)],
                    ['Minimum level', item.min_level === null ? 'not set' : String(item.min_level)],
                  ])}`,
                })}
                ${
                  canReq(req, 'stock.reserve')
                    ? card({
                        title: 'Reserve for work',
                        body: form({
                          ctx,
                          action: '/reservations',
                          submit: 'Reserve',
                          body: html`<input type="hidden" name="item_id" value="${String(id)}">
                            <div class="fields cols2">
                              ${select({ name: 'location_id', label: 'From location', required: true, options: options(locations.map((l) => ({ id: l.id, label: l.code }))) })}
                              ${input({ name: 'qty', label: 'Quantity', type: 'number', min: 1, value: 1, required: true })}
                              ${select({ name: 'job_id', label: 'For job', blank: 'No job (general)', options: options(openJobs.map((j) => ({ id: j.id, label: `${j.ref} ${j.title}` }))) })}
                              ${select({ name: 'owner_user_id', label: 'Accountable owner', required: true, options: staffOptions(staff, ctx.user.id) })}
                              ${dtInput({ name: 'required_by', label: 'Required by', required: true, iso: J.defaultReview(24) })}
                              ${dtInput({ name: 'review_at', label: 'Review / expiry', required: true, iso: J.defaultReview(24 * 7) })}
                            </div>
                            ${input({ name: 'purpose', label: 'Purpose', required: true, placeholder: 'What it is for' })}
                            ${input({ name: 'reallocation_consequence', label: 'Consequence if reallocated', required: true, placeholder: 'What happens to this work if the part is taken' })}
                            ${checkbox({ name: 'substitution_allowed', label: 'Substitution allowed' })}
                            ${idemInput()}
                            <input type="hidden" name="__back" value="/stock/items/${String(id)}">`,
                        }),
                      })
                    : ''
                }
                ${
                  canReq(req, 'stock.move')
                    ? card({
                        title: 'Transfer available stock',
                        body: form({
                          ctx,
                          action: '/stock/transfers',
                          submit: 'Transfer',
                          body: html`<input type="hidden" name="item_id" value="${String(id)}">
                            <div class="fields cols2">
                              ${select({ name: 'from_location_id', label: 'From', required: true, options: options(locations.map((l) => ({ id: l.id, label: l.code }))) })}
                              ${select({ name: 'to_location_id', label: 'To', required: true, options: options(locations.map((l) => ({ id: l.id, label: l.code }))) })}
                              ${input({ name: 'qty', label: 'Quantity', type: 'number', min: 1, value: 1, required: true })}
                              ${input({ name: 'reason', label: 'Reason', placeholder: 'e.g. van replenishment' })}
                            </div>
                            ${idemInput()}
                            <input type="hidden" name="__back" value="/stock/items/${String(id)}">`,
                        }),
                      })
                    : ''
                }
                ${canReq(req, 'audit.read') ? card({ title: 'Audit', tight: true, body: drawer({ summary: 'Show audit trail', body: auditTable(auditFor(db, 'stock_item', id)) }) }) : ''}
              </div>
            </div>
          `,
        }),
      );
    }),
  );

  // ---------------------------------------------------------------- reservations
  app.post(
    '/reservations',
    h((req, res) => {
      Inv.reserve(db, actorOf(req), req.body);
      ok(res, back(req), 'Reserved. It is no longer available to promise elsewhere.');
    }),
  );
  app.post(
    '/reservations/:id/release',
    h((req, res) => {
      Inv.releaseReservation(db, actorOf(req), intParam(req), req.body);
      ok(res, back(req), 'Reservation released back to available.');
    }),
  );
  app.post(
    '/reservations/:id/reallocate',
    h((req, res) => {
      Inv.reallocate(db, actorOf(req), intParam(req), req.body);
      ok(res, back(req), 'Reallocated. The previous owner has been notified and the displaced job has a next action.');
    }),
  );
  app.post(
    '/reservations/:id/pick',
    h((req, res) => {
      Inv.pickReservation(db, actorOf(req), intParam(req));
      ok(res, back(req), 'Picked.');
    }),
  );
  app.post(
    '/reservations/:id/issue',
    h((req, res) => {
      Inv.issueReservation(db, actorOf(req), intParam(req), req.body);
      ok(res, back(req), 'Issued with the recipient recorded.');
    }),
  );
  app.post(
    '/stock/transfers',
    h((req, res) => {
      Inv.transfer(db, actorOf(req), req.body);
      ok(res, back(req), 'Transferred.');
    }),
  );

  // ---------------------------------------------------------------- goods receipt (US-062)
  app.get(
    '/stock/receipts/new',
    h((req, res) => {
      needCap(req, 'stock.receive');
      const ctx = ctxOf(req);
      const items = Inv.items(db);
      const locations = Inv.locations(db);
      const staff = J.staffOptions(db);
      const openJobs = J.listJobs(db, { status: 'open', limit: 200 }).rows;
      const lineCount = 4;

      send(
        res,
        page(ctx, {
          title: 'Book in a delivery',
          heading: 'Book in a delivery',
          crumbs: [{ href: '/stock', label: 'Stock' }, { label: 'Goods receipt' }],
          sub: 'Anything damaged, incorrect or uncertain goes to quarantine — a carrier signature is not technical acceptance.',
          body: form({
            ctx,
            action: '/stock/receipts',
            submit: 'Book in',
            body: html`
              <input type="hidden" name="receipt_key" value="${`gr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`}">
              ${card({
                title: 'Delivery',
                body: html`<div class="fields cols3">
                  ${input({ name: 'supplier', label: 'Supplier', required: true, autofocus: true })}
                  ${input({ name: 'po_ref', label: 'Purchase order' })}
                  ${input({ name: 'delivery_ref', label: 'Delivery note' })}
                  ${input({ name: 'carrier', label: 'Carrier' })}
                  ${select({ name: 'location_id', label: 'Received into', required: true, options: options(locations.map((l) => ({ id: l.id, label: `${l.code} — ${l.name}` }))) })}
                  ${input({ name: 'notes', label: 'Notes', span: true })}
                </div>`,
              })}
              ${Array.from({ length: lineCount }, (_, i) =>
                card({
                  title: `Line ${i + 1}`,
                  body: html`<div class="fields cols3">
                      ${select({ name: 'line_item_id', label: 'Item', blank: '—', options: options(items.map((it) => ({ id: it.id, label: `${it.sku} ${it.name}` }))) })}
                      ${input({ name: 'line_qty_expected', label: 'Expected', type: 'number', min: 0 })}
                      ${input({ name: 'line_qty_received', label: 'Received', type: 'number', min: 0 })}
                      ${select({ name: 'line_condition', label: 'Condition', options: enumOptions(Inv.RECEIPT_CONDITIONS, { good: 'Good', damaged: 'Damaged', incorrect: 'Incorrect item', uncertain: 'Uncertain / needs checking' }, 'good') })}
                      ${select({ name: 'line_job_id', label: 'Allocated to job', blank: 'General stock', options: options(openJobs.map((j) => ({ id: j.id, label: `${j.ref} ${j.title}` }))), hint: 'Job-allocated stock is not general availability.' })}
                      ${input({ name: 'line_return_deadline', label: 'Return deadline', type: 'date' })}
                      ${input({ name: 'line_evidence', label: 'Evidence (exceptions)', span: true, placeholder: 'Condition seen, photos taken, what the carrier signed' })}
                      ${input({ name: 'line_impact', label: 'Operational impact', span: true })}
                      ${input({ name: 'line_next_action', label: 'Next action (exceptions)', placeholder: 'e.g. Raise damage claim with supplier' })}
                      ${select({ name: 'line_next_owner', label: 'Next-action owner', blank: '—', options: staffOptions(staff, null) })}
                    </div>`,
                }),
              )}
              <input type="hidden" name="__back" value="/stock/receipts/new">
            `,
          }),
        }),
      );
    }),
  );

  app.post(
    '/stock/receipts',
    h((req, res) => {
      const id = Inv.receiveGoods(db, actorOf(req), req.body);
      ok(res, `/stock/receipts/${id}`, 'Delivery booked in.');
    }),
  );

  app.get(
    '/stock/receipts',
    h((req, res) => {
      needCap(req, 'stock.read');
      const ctx = ctxOf(req);
      const rows = Inv.listReceipts(db, 60);
      send(
        res,
        page(ctx, {
          title: 'Goods receipts',
          heading: 'Goods receipts',
          crumbs: [{ href: '/stock', label: 'Stock' }, { label: 'Receipts' }],
          actions: canReq(req, 'stock.receive') ? html`<a class="btn primary" href="/stock/receipts/new">Book in a delivery</a>` : undefined,
          body: card({
            tight: true,
            body: table({
              cols: ['Ref', 'Supplier', 'PO', 'Received', { label: 'Lines', num: true }, 'Exceptions'],
              rows: rows.map((r) => [
                html`<a class="rowtitle" href="/stock/receipts/${String(r.id)}">${r.ref}</a>`,
                r.supplier,
                r.po_ref ?? '—',
                html`${when(r.received_at)}<br><span class="tiny subtle">${r.received_by_name}</span>`,
                String(r.line_count),
                r.open_exceptions ? chip(`${r.open_exceptions} open`, 'warn') : chip('none', 'ok'),
              ]),
              empty: 'No receipts recorded.',
            }),
          }),
        }),
      );
    }),
  );

  app.get(
    '/stock/receipts/:id',
    h((req, res) => {
      needCap(req, 'stock.read');
      const ctx = ctxOf(req);
      const id = intParam(req);
      const receipt = Inv.getReceipt(db, id);
      send(
        res,
        page(ctx, {
          title: receipt.ref,
          heading: `${receipt.ref} — ${receipt.supplier}`,
          crumbs: [{ href: '/stock', label: 'Stock' }, { href: '/stock/receipts', label: 'Receipts' }, { label: receipt.ref }],
          sub: html`${fmtDT(receipt.received_at)} · received by ${receipt.received_by_name} into ${receipt.location_code}${receipt.po_ref ? ` · PO ${receipt.po_ref}` : ''}${receipt.delivery_ref ? ` · DN ${receipt.delivery_ref}` : ''}${receipt.carrier ? ` · ${receipt.carrier}` : ''}`,
          body: html`
            ${receipt.notes ? banner('info', html`${receipt.notes}`) : ''}
            ${card({
              tight: true,
              body: table({
                cols: ['Item', { label: 'Expected', num: true }, { label: 'Received', num: true }, 'Condition', 'Allocation', 'Exception detail', ''],
                rows: receipt.lines.map((l) => [
                  html`<a href="/stock/items/${String(l.item_id)}">${l.sku}</a> ${l.item_name}`,
                  l.qty_expected === null ? '—' : String(l.qty_expected),
                  String(l.qty_received),
                  chip(labelise(l.condition), l.condition === 'good' ? 'ok' : 'warn'),
                  l.job_ref ? html`<a href="/jobs/${String(l.allocated_job_id)}">${l.job_ref}</a>` : html`<span class="subtle">general</span>`,
                  l.condition === 'good'
                    ? html`<span class="subtle">—</span>`
                    : html`<span class="tiny">${l.evidence ?? ''}${l.operational_impact ? html`<br><b>Impact:</b> ${l.operational_impact}` : ''}<br><b>Next:</b> ${l.next_action ?? ''} (${l.next_owner_name ?? 'unassigned'})${l.return_deadline ? html`<br><b>Return by:</b> ${fmtD(l.return_deadline)}` : ''}${l.resolved_note ? html`<br><b>Resolved:</b> ${l.resolved_note}` : ''}</span>`,
                  l.exception_status === 'open' && canReq(req, 'stock.assess')
                    ? drawer({
                        summary: 'Resolve',
                        body: form({
                          ctx,
                          action: `/receipt-lines/${l.id}/resolve`,
                          submit: 'Record decision',
                          body: html`${select({
                              name: 'outcome',
                              label: 'Outcome',
                              options: [
                                { value: 'release_available', label: 'Technically accepted — release to available' },
                                { value: 'return_to_supplier', label: 'Return to supplier' },
                                { value: 'dispose', label: 'Dispose (needs approval)' },
                              ],
                            })}
                            ${input({ name: 'qty', label: 'Quantity', type: 'number', min: 1, value: l.qty_received, required: true })}
                            ${textarea({ name: 'note', label: 'Decision note', rows: 2, required: true })}
                            <input type="hidden" name="__back" value="/stock/receipts/${String(id)}">`,
                        }),
                      })
                    : l.exception_status === 'resolved'
                      ? chip('resolved', 'ok')
                      : '',
                ]),
              }),
              definition: 'Quarantined quantities are recorded as received but never counted as available, so nothing can be promised from them by mistake.',
            })}
          `,
        }),
      );
    }),
  );

  app.post(
    '/receipt-lines/:id/resolve',
    h((req, res) => {
      Inv.resolveReceiptException(db, actorOf(req), intParam(req), req.body);
      ok(res, back(req), 'Exception resolved.');
    }),
  );

  // ---------------------------------------------------------------- returns (US-063)
  app.get(
    '/stock/returns',
    h((req, res) => {
      needCap(req, 'stock.read');
      const ctx = ctxOf(req);
      const pending = Inv.pendingReturns(db);
      const quarantine = Inv.quarantined(db);
      send(
        res,
        page(ctx, {
          title: 'Returns and quarantine',
          heading: 'Returns awaiting assessment',
          crumbs: [{ href: '/stock', label: 'Stock' }, { label: 'Returns' }],
          sub: 'Material coming back is assessed before it counts as available again.',
          body: html`
            ${card({
              tight: true,
              body: table({
                cols: ['Item', 'Location', 'Ownership', { label: 'Qty', num: true }, ''],
                rows: pending.map((p) => [
                  html`<a href="/stock/items/${String(p.item_id)}">${p.sku}</a> ${p.item_name}`,
                  p.location_code,
                  p.owner_type === 'frostline' ? html`<span class="subtle">FrostLine</span>` : html`${chip(labelise(p.owner_type), 'warn')} ${p.owner_label ?? ''}`,
                  String(p.qty),
                  canReq(req, 'stock.assess')
                    ? drawer({
                        summary: 'Assess',
                        body: form({
                          ctx,
                          action: '/stock/returns/assess',
                          submit: 'Record assessment',
                          body: html`<input type="hidden" name="item_id" value="${String(p.item_id)}">
                            <input type="hidden" name="location_id" value="${String(p.location_id)}">
                            <input type="hidden" name="owner_type" value="${p.owner_type}">
                            <input type="hidden" name="owner_ref" value="${String(p.owner_ref)}">
                            <div class="fields cols2">
                              ${input({ name: 'qty', label: 'Quantity', type: 'number', min: 1, max: p.qty, value: p.qty, required: true })}
                              ${select({ name: 'outcome', label: 'Assessment', required: true, options: enumOptions(Inv.RETURN_OUTCOMES, Inv.RETURN_OUTCOME_LABEL) })}
                            </div>
                            ${textarea({ name: 'note', label: 'What you found', rows: 2, required: true })}
                            <input type="hidden" name="__back" value="/stock/returns">`,
                        }),
                      })
                    : '',
                ]),
                empty: 'Nothing is waiting for assessment.',
              }),
              definition: 'Unused stock returns to available; opened, damaged, contaminated or suspect material is quarantined; warranty returns become evidence holds; disposal needs approval.',
            })}
            ${card({
              title: 'Quarantined stock',
              tight: true,
              body: table({
                cols: ['Item', 'Location', { label: 'Qty', num: true }],
                rows: quarantine.map((q) => [html`<a href="/stock/items/${String(q.item_id)}">${q.sku}</a> ${q.item_name}`, q.location_code, String(q.qty)]),
                empty: 'Nothing in quarantine.',
              }),
            })}
          `,
        }),
      );
    }),
  );

  app.post(
    '/stock/returns/assess',
    h((req, res) => {
      Inv.assessReturn(db, actorOf(req), req.body);
      ok(res, back(req), 'Assessment recorded.');
    }),
  );

  // ---------------------------------------------------------------- evidence holds
  app.get(
    '/stock/holds',
    h((req, res) => {
      needCap(req, 'stock.read');
      const ctx = ctxOf(req);
      const showAll = strQuery(req, 'all') === '1';
      const holds = Inv.listHolds(db, { open: !showAll });
      send(
        res,
        page(ctx, {
          title: 'Evidence holds',
          heading: 'Evidence holds (failed parts and warranty returns)',
          crumbs: [{ href: '/stock', label: 'Stock' }, { label: 'Evidence holds' }],
          sub: 'Chain of custody for parts that may be evidence. Nothing is stripped, returned or scrapped without authorisation.',
          actions: html`<a class="btn" href="/stock/holds${showAll ? '' : '?all=1'}">${showAll ? 'Held only' : 'Include closed'}</a>`,
          body: card({
            tight: true,
            body: table({
              cols: ['Ref', 'Part', 'From', 'Removed', 'Deadline', 'Next action', 'State'],
              rows: holds.map((hld) => [
                html`<a class="rowtitle" href="/stock/holds/${String(hld.id)}">${hld.ref}</a>`,
                html`${hld.description}<br><span class="tiny subtle">${hld.condition_packaging}</span>`,
                html`${hld.customer_name ?? '—'}<br><span class="tiny subtle">${hld.site_name ?? ''} ${hld.asset_ref ?? ''}${hld.job_ref ? ` · ${hld.job_ref}` : ''}</span>`,
                html`${when(hld.removed_at, { dateOnly: true })}<br><span class="tiny subtle">${hld.removed_by_name ?? ''}</span>`,
                hld.deadline ? html`${fmtD(hld.deadline)}${hld.deadline < clock.iso().slice(0, 10) && hld.status === 'held' ? html` <span class="chip danger">passed</span>` : ''}` : html`<span class="subtle">—</span>`,
                html`<span class="tiny">${hld.next_action}<br>${hld.next_owner_name}</span>`,
                chip(labelise(hld.status), hld.status === 'held' ? 'warn' : 'neutral'),
              ]),
              empty: 'No evidence holds.',
            }),
          }),
        }),
      );
    }),
  );

  app.get(
    '/stock/holds/:id',
    h((req, res) => {
      needCap(req, 'stock.read');
      const ctx = ctxOf(req);
      const id = intParam(req);
      const hold = Inv.getHold(db, id);
      const locations = Inv.locations(db);
      send(
        res,
        page(ctx, {
          title: hold.ref,
          heading: `${hold.ref} — ${hold.description}`,
          headingChips: chip(labelise(hold.status), hold.status === 'held' ? 'warn' : 'neutral'),
          crumbs: [{ href: '/stock/holds', label: 'Evidence holds' }, { label: hold.ref }],
          narrow: true,
          body: html`
            ${hold.deadline && hold.status === 'held' && hold.deadline < clock.iso().slice(0, 10) ? banner('err', html`The claim or return deadline (${fmtD(hold.deadline)}) has passed.`) : ''}
            ${card({
              title: 'Custody record',
              body: defList(
                [
                  ['Part', hold.description],
                  ['Source', html`${hold.customer_name ?? '—'} · ${hold.site_name ?? '—'}${hold.asset_ref ? ` · ${hold.asset_ref}` : ''}${hold.job_ref ? html` · <a href="/jobs/${String(hold.job_id)}">${hold.job_ref}</a>` : ''}`],
                  ['Removed', html`${fmtDT(hold.removed_at)} by ${hold.removed_by_name ?? '—'}`],
                  ['Failure evidence', prose(hold.failure_evidence)],
                  ['Tests / photos', prose(hold.tests_photos)],
                  ['Condition and packaging', hold.condition_packaging],
                  ['Stored at', `${hold.storage_code ?? '—'}${hold.storage_detail ? ` · ${hold.storage_detail}` : ''}`],
                  ['Deadline', hold.deadline ? fmtD(hold.deadline) : 'none recorded'],
                  ['Manufacturer reference', hold.manufacturer_ref],
                  ['Supplier reference', hold.supplier_ref],
                  ['Next action', `${hold.next_action} — ${hold.next_owner_name}`],
                  ['Closed', hold.closed_at ? `${fmtDT(hold.closed_at)} · ${hold.closed_reason ?? ''}` : null],
                ],
                true,
              ),
            })}
            ${card({
              title: 'Custody events',
              tight: true,
              body: table({
                cols: [{ label: 'When', nowrap: true }, 'Action', 'Detail', 'Who'],
                rows: hold.events.map((e) => [when(e.at), chip(labelise(e.action), 'neutral'), html`<span class="tiny">${e.detail ?? ''}</span>`, html`<span class="tiny">${e.actor_name}</span>`]),
              }),
            })}
            ${
              hold.status === 'held' && canReq(req, 'stock.custody')
                ? card({
                    title: 'Record a custody action',
                    body: form({
                      ctx,
                      action: `/stock/holds/${id}/action`,
                      submit: 'Record action',
                      body: html`${select({
                          name: 'action',
                          label: 'Action',
                          required: true,
                          options: [
                            { value: 'note', label: 'Note / update' },
                            { value: 'moved', label: 'Moved to another storage location' },
                            { value: 'sent_to_supplier', label: 'Sent to supplier or manufacturer' },
                            { value: 'released', label: 'Released (needs approval)' },
                            { value: 'disposed', label: 'Disposed (needs approval)' },
                          ],
                        })}
                        ${textarea({ name: 'detail', label: 'Detail', rows: 2, required: true })}
                        ${input({ name: 'reference', label: 'Supplier / manufacturer reference' })}
                        ${select({ name: 'storage_location_id', label: 'New storage location (if moved)', blank: '—', options: options(locations.map((l) => ({ id: l.id, label: `${l.code} — ${l.name}` }))) })}
                        <p class="tiny subtle">Releasing or disposing of held material is governed by the approval policy and is recorded against your name.</p>
                        <input type="hidden" name="__back" value="/stock/holds/${String(id)}">`,
                    }),
                  })
                : ''
            }
          `,
        }),
      );
    }),
  );

  app.post(
    '/stock/holds/:id/action',
    h((req, res) => {
      Inv.custodyAction(db, actorOf(req), intParam(req), req.body);
      ok(res, back(req), 'Custody action recorded.');
    }),
  );
};

export default register;
