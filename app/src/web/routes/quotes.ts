import { html, raw, type SafeHtml } from '../../lib/html.ts';
import { clock, fmtD, fmtDT, relative } from '../../lib/clock.ts';
import { fmtMoney, penceToInput } from '../../lib/money.ts';
import { DomainError } from '../../lib/errors.ts';
import { APPROVAL_ACTIONS } from '../../auth/policy.ts';
import * as Q from '../../domain/quotes.ts';
import * as CRM from '../../domain/crm.ts';
import * as J from '../../domain/jobs.ts';
import { auditFor } from '../../domain/audit.ts';
import {
  banner,
  card,
  checkbox,
  chip,
  type Ctx,
  defList,
  drawer,
  empty,
  enumOptions,
  form,
  input,
  labelise,
  money,
  options,
  page,
  pagination,
  prose,
  select,
  staffOptions,
  table,
  textarea,
  versionInput,
  when,
} from '../ui.ts';
import { actorOf, back, canReq, ctxOf, h, intParam, intQuery, needCap, ok, type RouteModule, send, strQuery } from '../kit.ts';
import { auditTable } from './jobs.ts';

const STATUS_TONE: Record<string, string> = { draft: 'neutral', internally_approved: 'info', issued: 'warn', accepted: 'ok', superseded: 'neutral', declined: 'neutral', expired: 'neutral' };

const register: RouteModule = (app, { db }) => {
  // ---------------------------------------------------------------- list
  app.get(
    '/quotes',
    h((req, res) => {
      needCap(req, 'quote.read');
      const ctx = ctxOf(req);
      const limit = 50;
      const offset = intQuery(req, 'offset') ?? 0;
      const maturity = strQuery(req, 'maturity');
      const q = strQuery(req, 'q');
      const open = !maturity && strQuery(req, 'all') !== '1';
      const { rows, total } = Q.listOpportunities(db, { q, maturity, open, limit, offset });
      send(
        res,
        page(ctx, {
          title: 'Quotations',
          heading: 'Opportunities and quotations',
          sub: 'Enquiry through to a validated acceptance and a controlled commercial release.',
          actions: canReq(req, 'quote.write') ? html`<a class="btn primary" href="/quotes/new">New opportunity</a>` : undefined,
          body: html`
            <form class="filters card" method="get" action="/quotes" style="padding:12px" data-autosubmit>
              <div class="field wide"><label for="f_q">Search</label><input id="f_q" type="search" name="q" value="${q ?? ''}" placeholder="Reference, title, customer"></div>
              ${select({ name: 'maturity', label: 'Maturity', value: maturity ?? '', blank: 'Open only', options: enumOptions(Q.MATURITIES) })}
              <label class="check"><input type="checkbox" name="all" value="1" ${raw(!open && !maturity ? 'checked' : '')}><span>Include closed</span></label>
              <button class="btn" type="submit">Apply</button>
            </form>
            ${card({
              tight: true,
              body: table({
                cols: ['Ref', 'Customer / site', 'Title', 'Maturity', 'Latest revision', { label: 'Value', num: true }, 'Owner'],
                rows: rows.map((o) => [
                  html`<a class="rowtitle" href="/quotes/${String(o.id)}">${o.ref}</a>`,
                  html`${o.customer_name}<br><span class="tiny subtle">${o.site_name ?? 'no site set'}</span>`,
                  html`${o.title}<br><span class="tiny subtle">${Q.ESTIMATE_BASIS_LABEL[o.estimate_basis]}</span>`,
                  chip(labelise(o.maturity), o.maturity === 'awarded' ? 'ok' : o.maturity === 'lost' || o.maturity === 'withdrawn' ? 'neutral' : 'info'),
                  o.latest_rev ? html`rev ${String(o.latest_rev)} ${chip(labelise(o.latest_status), STATUS_TONE[o.latest_status] ?? 'neutral')}${o.latest_valid_until ? html`<br><span class="tiny subtle">valid to ${fmtD(o.latest_valid_until)}</span>` : ''}` : html`<span class="subtle">—</span>`,
                  o.latest_total ? fmtMoney(o.latest_total.maxNet) : '—',
                  html`<span class="tiny">${o.owner_name ?? '—'}</span>`,
                ]),
                empty: 'No opportunities match.',
              }),
              foot: pagination({ total, limit, offset, base: `/quotes?${new URLSearchParams(Object.entries({ q: q ?? '', maturity: maturity ?? '' }).filter(([, v]) => v)).toString()}` }),
            })}
          `,
        }),
      );
    }),
  );

  app.get(
    '/quotes/new',
    h((req, res) => {
      needCap(req, 'quote.write');
      const ctx = ctxOf(req);
      const customers = CRM.listCustomers(db, { limit: 500 }).rows;
      const customerId = intQuery(req, 'customer');
      const sites = customerId ? CRM.sitesForCustomer(db, customerId) : [];
      const staff = J.staffOptions(db);
      send(
        res,
        page(ctx, {
          title: 'New opportunity',
          heading: 'New opportunity',
          narrow: true,
          crumbs: [{ href: '/quotes', label: 'Quotations' }, { label: 'New' }],
          body: html`
            <form class="filters card" method="get" action="/quotes/new" style="padding:12px">
              ${select({ name: 'customer', label: 'Customer', value: customerId ?? '', blank: 'Choose…', options: options(customers.map((c) => ({ id: c.id, label: c.trading_name })), customerId ?? null), required: true })}
              <button class="btn" type="submit">Choose</button>
            </form>
            ${
              customerId
                ? form({
                    ctx,
                    action: '/quotes',
                    submit: 'Create opportunity',
                    body: html`<input type="hidden" name="customer_id" value="${String(customerId)}">
                      <div class="fields cols2">
                        ${input({ name: 'title', label: 'Title', required: true, autofocus: true, span: true })}
                        ${select({ name: 'site_id', label: 'Site', blank: 'Not yet known', options: options(sites.map((s) => ({ id: s.id, label: s.name }))), hint: 'Needed before work can be released.' })}
                        ${select({ name: 'source', label: 'Source', required: true, options: enumOptions(Q.OPP_SOURCES) })}
                        ${select({ name: 'maturity', label: 'Maturity', options: enumOptions(Q.MATURITIES.filter((m) => m !== 'awarded'), undefined, 'enquiry') })}
                        ${select({ name: 'estimate_basis', label: 'Confidence of the number', options: enumOptions(Q.ESTIMATE_BASES, Q.ESTIMATE_BASIS_LABEL, 'budget_indication'), hint: 'A budget indication and an approved quotation basis mean very different things.' })}
                        ${select({ name: 'owner_user_id', label: 'Owner', options: staffOptions(staff, ctx.user.id) })}
                        ${input({ name: 'originating_job_id', label: 'Originating job id', hint: 'If an engineer recommended this work.' })}
                        ${textarea({ name: 'notes', label: 'Notes', rows: 2, span: true })}
                      </div>`,
                  })
                : ''
            }
          `,
        }),
      );
    }),
  );

  app.post(
    '/quotes',
    h((req, res) => {
      const id = Q.createOpportunity(db, actorOf(req), req.body);
      ok(res, `/quotes/${id}`, 'Opportunity created with a draft revision 1.');
    }),
  );

  // ---------------------------------------------------------------- opportunity page
  app.get(
    '/quotes/:id',
    h((req, res) => {
      needCap(req, 'quote.read');
      const ctx = ctxOf(req);
      const id = intParam(req);
      const opp = Q.getOpportunity(db, id);
      const revisions = Q.revisionsFor(db, id);
      const staff = J.staffOptions(db);
      const sites = CRM.sitesForCustomer(db, opp.customer_id);
      const variations = Q.variationsFor(db, { acceptanceId: undefined, jobId: undefined, projectId: undefined });
      const selectedRevId = intQuery(req, 'rev') ?? revisions[0]?.id;
      const rev = selectedRevId ? Q.getRevision(db, selectedRevId) : undefined;
      const lines = rev ? Q.linesFor(db, rev.id) : [];
      const totals = Q.totals(lines);
      const acceptance = rev ? Q.acceptanceForRevision(db, rev.id) : null;
      const canWrite = canReq(req, 'quote.write');

      send(
        res,
        page(ctx, {
          title: `${opp.ref} ${opp.title}`,
          heading: `${opp.ref} — ${opp.title}`,
          headingChips: html`${chip(labelise(opp.maturity), opp.maturity === 'awarded' ? 'ok' : 'info')} ${chip(Q.ESTIMATE_BASIS_LABEL[opp.estimate_basis], 'neutral')}`,
          crumbs: [{ href: '/quotes', label: 'Quotations' }, { href: `/customers/${opp.customer_id}`, label: opp.customer_name! }, { label: opp.ref }],
          sub: html`${opp.site_name ? html`<a href="/sites/${String(opp.site_id)}">${opp.site_name}</a>` : html`<span class="chip warn">no site set</span>`} · owner ${opp.owner_name ?? '—'}${opp.originating_job_ref ? html` · from <a href="/jobs/${String(opp.originating_job_id)}">${opp.originating_job_ref}</a>` : ''}`,
          body: html`
            <div class="grid split">
              <div>
                ${
                  rev
                    ? card({
                        title: `Revision ${rev.rev_no}`,
                        actions: html`${chip(labelise(rev.status), STATUS_TONE[rev.status] ?? 'neutral')} ${rev.valid_until ? chip(`valid to ${fmtD(rev.valid_until)}${rev.valid_until < clock.iso().slice(0, 10) ? ' (expired)' : ''}`, rev.valid_until < clock.iso().slice(0, 10) ? 'warn' : 'neutral') : ''}`,
                        body: html`
                          ${rev.change_summary ? banner('info', html`${rev.change_summary}`, `What changed in revision ${rev.rev_no}`) : ''}
                          ${table({
                            cols: ['Option', 'Type', 'Description', { label: 'Qty', num: true }, { label: 'Unit', num: true }, { label: 'Line', num: true }, ''],
                            rows: lines.map((l) => [
                              l.option_code ? chip(`Option ${l.option_code}`, 'info') : html`<span class="subtle">base</span>`,
                              labelise(l.line_type),
                              l.description,
                              String(l.qty),
                              fmtMoney(l.unit_price_pence),
                              fmtMoney(Math.round(l.qty * l.unit_price_pence)),
                              canWrite && rev.status === 'draft'
                                ? form({ ctx, action: `/quote-lines/${l.id}/delete`, body: html`<input type="hidden" name="__back" value="/quotes/${String(id)}?rev=${String(rev.id)}">`, submit: 'Remove', submitClass: 'small danger' })
                                : '',
                            ]),
                            empty: 'No priced lines yet.',
                          })}
                          <div class="kv mt1">
                            <div><b>Base net</b> ${fmtMoney(totals.baseNet)}</div>
                            ${totals.options.map((o) => html`<div><b>Option ${o.code}</b> ${fmtMoney(o.net)}</div>`)}
                            <div><b>Maximum net</b> ${fmtMoney(totals.maxNet)}</div>
                            <div><b>VAT @ ${(rev.vat_rate_bp / 100).toFixed(1)}%</b> ${fmtMoney(Q.vatOf(totals.maxNet, rev.vat_rate_bp))}</div>
                            <div><b>Gross (all options)</b> ${fmtMoney(totals.maxNet + Q.vatOf(totals.maxNet, rev.vat_rate_bp))}</div>
                          </div>
                          ${defList(
                            [
                              ['Scope', prose(rev.scope, true)],
                              ['Equipment / materials', prose(rev.equipment_materials)],
                              ['Programme / lead time', prose(rev.programme)],
                              ['Assumptions', prose(rev.assumptions)],
                              ['Exclusions', prose(rev.exclusions)],
                              ['Warranty position', prose(rev.warranty_position)],
                              ['Customer responsibilities', prose(rev.customer_responsibilities)],
                              ['Payment terms', rev.payment_terms],
                              ['Acceptance method', rev.acceptance_method],
                              ['Outage / design notes', prose(rev.outage_design_notes)],
                              ['Approved', rev.approved_at ? html`${rev.approved_by_name} ${fmtDT(rev.approved_at)}<br><span class="tiny subtle">${rev.approval_reason ?? ''}</span>` : null],
                              ['Issued', rev.issued_at ? html`${rev.issued_by_name} ${fmtDT(rev.issued_at)}` : null],
                              ['Closed', rev.closed_reason],
                            ],
                            true,
                          )}
                        `,
                        definition:
                          'A revision is immutable once it leaves draft: approval, issue and acceptance all point at exactly this content. Changes create a new revision, and post-award changes are variations.',
                      })
                    : ''
                }
                ${
                  rev && canWrite && rev.status === 'draft'
                    ? card({
                        title: 'Edit draft',
                        body: html`
                          ${drawer({
                            summary: 'Scope, assumptions and terms',
                            body: form({
                              ctx,
                              action: `/revisions/${rev.id}`,
                              submit: 'Save draft',
                              body: html`${versionInput(rev.version)}
                                <div class="fields">
                                  ${textarea({ name: 'scope', label: 'Scope', rows: 4, required: true, value: rev.scope })}
                                  ${textarea({ name: 'equipment_materials', label: 'Equipment and materials', rows: 2, value: rev.equipment_materials ?? '' })}
                                  ${textarea({ name: 'programme', label: 'Programme / lead time', rows: 2, value: rev.programme ?? '' })}
                                  ${textarea({ name: 'assumptions', label: 'Assumptions', rows: 3, value: rev.assumptions ?? '', hint: 'Required before approval — write "None" if there genuinely are none.' })}
                                  ${textarea({ name: 'exclusions', label: 'Exclusions', rows: 3, value: rev.exclusions ?? '' })}
                                  ${textarea({ name: 'warranty_position', label: 'Warranty position', rows: 2, value: rev.warranty_position ?? '' })}
                                  ${textarea({ name: 'customer_responsibilities', label: 'Customer responsibilities', rows: 2, value: rev.customer_responsibilities ?? '' })}
                                  ${textarea({ name: 'outage_design_notes', label: 'Outage / design responsibility notes', rows: 2, value: rev.outage_design_notes ?? '' })}
                                  <div class="fields cols3">
                                    ${input({ name: 'payment_terms', label: 'Payment terms', value: rev.payment_terms ?? '' })}
                                    ${input({ name: 'vat_rate', label: 'VAT rate %', type: 'number', step: '0.1', min: 0, max: 100, value: (rev.vat_rate_bp / 100).toFixed(1) })}
                                    ${input({ name: 'valid_until', label: 'Valid until', type: 'date', value: rev.valid_until ?? '' })}
                                  </div>
                                  ${input({ name: 'acceptance_method', label: 'Acceptance method', value: rev.acceptance_method ?? '' })}
                                </div>
                                <input type="hidden" name="__back" value="/quotes/${String(id)}?rev=${String(rev.id)}">`,
                            }),
                          })}
                          ${drawer({
                            summary: 'Add a priced line',
                            body: form({
                              ctx,
                              action: `/revisions/${rev.id}/lines`,
                              submit: 'Add line',
                              body: html`<div class="fields cols2">
                                  ${select({ name: 'line_type', label: 'Type', required: true, options: enumOptions(Q.LINE_TYPES) })}
                                  ${input({ name: 'option_code', label: 'Option code', placeholder: 'Blank = base scope; A, B… = optional', hint: 'Options are priced separately and named at acceptance.' })}
                                  ${input({ name: 'description', label: 'Description', required: true, span: true })}
                                  ${input({ name: 'qty', label: 'Quantity', type: 'number', step: '0.01', min: 0.01, value: 1, required: true })}
                                  ${money({ name: 'unit_price', label: 'Unit price', required: true })}
                                </div>
                                <input type="hidden" name="__back" value="/quotes/${String(id)}?rev=${String(rev.id)}">`,
                            }),
                          })}
                          ${drawer({
                            summary: 'Submit for internal approval',
                            body: html`<p class="tiny subtle">Approval is checked against the configurable approval policy — it is not authority to purchase or start (that is commercial release).</p>
                              ${form({
                                ctx,
                                action: `/revisions/${rev.id}/approve`,
                                submit: 'Approve for issue',
                                body: html`${textarea({ name: 'reason', label: 'What you checked', rows: 2, required: true })}<input type="hidden" name="__back" value="/quotes/${String(id)}?rev=${String(rev.id)}">`,
                              })}`,
                          })}
                        `,
                      })
                    : ''
                }
                ${
                  rev && canWrite && rev.status === 'internally_approved'
                    ? card({
                        title: 'Issue to the customer',
                        body: form({
                          ctx,
                          action: `/revisions/${rev.id}/issue`,
                          submit: 'Mark as issued',
                          body: html`${input({ name: 'note', label: 'Issued to whom, and how', required: true, placeholder: 'e.g. Emailed to procurement as PDF' })}<input type="hidden" name="__back" value="/quotes/${String(id)}?rev=${String(rev.id)}">`,
                        }),
                      })
                    : ''
                }
                ${rev && rev.status === 'issued' && canReq(req, 'quote.accept.record') ? acceptanceForm(ctx, db, opp, rev, totals, id) : ''}
                ${acceptance ? acceptanceCard(ctx, db, acceptance, rev!, opp, canReq(req, 'quote.accept.record')) : ''}
              </div>
              <div>
                ${card({
                  title: 'Revisions',
                  tight: true,
                  body: table({
                    cols: ['Rev', 'Status', 'Created', ''],
                    rows: revisions.map((r) => [
                      html`<a href="/quotes/${String(id)}?rev=${String(r.id)}">rev ${String(r.rev_no)}</a>`,
                      chip(labelise(r.status), STATUS_TONE[r.status] ?? 'neutral'),
                      html`<span class="tiny">${fmtD(r.created_at)}<br>${r.created_by_name ?? ''}</span>`,
                      r.id === rev?.id ? chip('showing', 'info') : '',
                    ]),
                  }),
                  foot: canWrite
                    ? drawer({
                        summary: 'Create a new revision',
                        body: form({
                          ctx,
                          action: `/quotes/${id}/revisions`,
                          submit: 'Create revision',
                          body: html`<p class="tiny subtle">Copies the latest revision into a new draft. History is preserved.</p>
                            ${textarea({ name: 'change_summary', label: 'What changes and why', rows: 2, required: true })}
                            <input type="hidden" name="__back" value="/quotes/${String(id)}">`,
                        }),
                      })
                    : undefined,
                })}
                ${card({
                  title: 'Opportunity',
                  body: html`${defList(
                      [
                        ['Customer', html`<a href="/customers/${String(opp.customer_id)}">${opp.customer_name}</a>`],
                        ['Site', opp.site_name ?? 'not set'],
                        ['Source', labelise(opp.source)],
                        ['Maturity', labelise(opp.maturity)],
                        ['Basis', Q.ESTIMATE_BASIS_LABEL[opp.estimate_basis]],
                        ['Notes', prose(opp.notes)],
                      ],
                      true,
                    )}
                    ${
                      canWrite
                        ? drawer({
                            summary: 'Update opportunity',
                            body: form({
                              ctx,
                              action: `/quotes/${id}/update`,
                              submit: 'Save',
                              body: html`<div class="fields">
                                  ${input({ name: 'title', label: 'Title', required: true, value: opp.title })}
                                  ${select({ name: 'maturity', label: 'Maturity', options: enumOptions(Q.MATURITIES.filter((m) => m !== 'awarded'), undefined, opp.maturity) })}
                                  ${select({ name: 'estimate_basis', label: 'Basis', options: enumOptions(Q.ESTIMATE_BASES, Q.ESTIMATE_BASIS_LABEL, opp.estimate_basis) })}
                                  ${select({ name: 'owner_user_id', label: 'Owner', options: staffOptions(staff, opp.owner_user_id) })}
                                  ${textarea({ name: 'notes', label: 'Notes', rows: 2, value: opp.notes ?? '' })}
                                  ${input({ name: 'reason', label: 'Reason for change' })}
                                </div>
                                <input type="hidden" name="__back" value="/quotes/${String(id)}">`,
                            }),
                          })
                        : ''
                    }
                    ${
                      canWrite && rev?.status === 'issued'
                        ? drawer({
                            summary: 'Record a decline or expiry',
                            body: form({
                              ctx,
                              action: `/revisions/${rev.id}/close`,
                              submit: 'Record outcome',
                              body: html`${select({ name: 'status', label: 'Outcome', options: [{ value: 'declined', label: 'Declined by customer' }, { value: 'expired', label: 'Expired' }] })}
                                ${textarea({ name: 'reason', label: 'Reason / what they said', rows: 2, required: true })}
                                <input type="hidden" name="__back" value="/quotes/${String(id)}">`,
                            }),
                          })
                        : ''
                    }`,
                })}
                ${canReq(req, 'audit.read') ? card({ title: 'Audit', tight: true, body: drawer({ summary: 'Show audit trail', body: auditTable([...auditFor(db, 'opportunity', id), ...revisions.flatMap((r) => auditFor(db, 'quote_revision', r.id))].sort((a, b) => b.at.localeCompare(a.at))) }) }) : ''}
              </div>
            </div>
          `,
        }),
      );
      void variations;
    }),
  );

  // ---------------------------------------------------------------- revision actions
  app.post(
    '/quotes/:id/update',
    h((req, res) => {
      const id = intParam(req);
      Q.updateOpportunity(db, actorOf(req), id, req.body);
      ok(res, `/quotes/${id}`, 'Opportunity updated.');
    }),
  );
  app.post(
    '/quotes/:id/revisions',
    h((req, res) => {
      const id = intParam(req);
      const revId = Q.newRevision(db, actorOf(req), id, req.body);
      ok(res, `/quotes/${id}?rev=${revId}`, 'New draft revision created from the latest.');
    }),
  );
  app.post(
    '/revisions/:id',
    h((req, res) => {
      const id = intParam(req);
      Q.updateDraft(db, actorOf(req), id, req.body);
      ok(res, back(req), 'Draft saved.');
    }),
  );
  app.post(
    '/revisions/:id/lines',
    h((req, res) => {
      const id = intParam(req);
      Q.addLine(db, actorOf(req), id, req.body);
      ok(res, back(req), 'Line added.');
    }),
  );
  app.post(
    '/quote-lines/:id/delete',
    h((req, res) => {
      Q.removeLine(db, actorOf(req), intParam(req));
      ok(res, back(req), 'Line removed.');
    }),
  );
  app.post(
    '/revisions/:id/approve',
    h((req, res) => {
      const id = intParam(req);
      Q.approveRevision(db, actorOf(req), id, req.body);
      ok(res, back(req), 'Revision approved for issue. That is not authority to purchase or start.');
    }),
  );
  app.post(
    '/revisions/:id/issue',
    h((req, res) => {
      const id = intParam(req);
      Q.issueRevision(db, actorOf(req), id, req.body);
      ok(res, back(req), 'Recorded as issued. Earlier revisions are superseded.');
    }),
  );
  app.post(
    '/revisions/:id/close',
    h((req, res) => {
      const id = intParam(req);
      Q.closeRevision(db, actorOf(req), id, req.body);
      ok(res, back(req), 'Outcome recorded.');
    }),
  );
  app.post(
    '/revisions/:id/acceptance',
    h((req, res) => {
      const id = intParam(req);
      const rev = Q.getRevision(db, id);
      Q.recordAcceptance(db, actorOf(req), id, req.body);
      ok(res, `/quotes/${rev.opportunity_id}?rev=${id}`, 'Acceptance recorded against this exact revision. Release is a separate decision.');
    }),
  );
  app.post(
    '/acceptances/:id/checklist',
    h((req, res) => {
      Q.updateChecklist(db, actorOf(req), intParam(req), req.body);
      ok(res, back(req), 'Validation checklist updated.');
    }),
  );
  app.post(
    '/acceptances/:id/release',
    h((req, res) => {
      const id = intParam(req);
      const result = Q.releaseWork(db, actorOf(req), id, req.body);
      if (result.jobId) ok(res, `/jobs/${result.jobId}`, 'Released. The job carries the accepted quotation as its authority.');
      else ok(res, back(req), 'Released as a project.');
    }),
  );

  // ---------------------------------------------------------------- variations
  app.post(
    '/variations',
    h((req, res) => {
      Q.createVariation(db, actorOf(req), req.body);
      ok(res, back(req), 'Variation recorded as proposed. It does not change the accepted quotation.');
    }),
  );
  app.post(
    '/variations/:id/decide',
    h((req, res) => {
      Q.decideVariation(db, actorOf(req), intParam(req), req.body);
      ok(res, back(req), 'Decision recorded.');
    }),
  );

  app.get(
    '/variations',
    h((req, res) => {
      needCap(req, 'quote.read');
      const ctx = ctxOf(req);
      const openOnly = strQuery(req, 'all') !== '1';
      const rows = Q.variationsFor(db, { open: openOnly });
      send(
        res,
        page(ctx, {
          title: 'Variations',
          heading: 'Post-award variations',
          sub: 'Changes after award are classified and approved separately — the accepted quotation is never rewritten.',
          actions: html`<a class="btn" href="/variations${openOnly ? '?all=1' : ''}">${openOnly ? 'Include decided' : 'Proposed only'}</a>`,
          body: card({
            tight: true,
            body: table({
              cols: ['Ref', 'Classification', 'Against', 'Description', { label: 'Value', num: true }, 'State', ''],
              rows: rows.map((v) => [
                v.ref,
                chip(Q.VARIATION_LABEL[v.classification], 'neutral'),
                v.job_ref ? html`<a href="/jobs/${String(v.job_id)}">${v.job_ref}</a>` : (v.project_ref ?? '—'),
                html`${v.description}<br><span class="tiny subtle">${v.scope_impact}</span>`,
                fmtMoney(v.value_impact_pence),
                html`${chip(labelise(v.status), v.status === 'approved' ? 'ok' : v.status === 'proposed' ? 'warn' : 'neutral')}${v.decided_by_name ? html`<br><span class="tiny subtle">${v.decided_by_name}</span>` : ''}`,
                v.status === 'proposed' && canReq(req, 'quote.read')
                  ? drawer({
                      summary: 'Decide',
                      body: form({
                        ctx,
                        action: `/variations/${v.id}/decide`,
                        submit: 'Record decision',
                        body: html`${select({ name: 'decision', label: 'Decision', options: enumOptions(['approved', 'rejected', 'withdrawn']) })}
                          ${textarea({ name: 'reason', label: 'Reason', rows: 2, required: true })}
                          <p class="tiny subtle">Approving is governed by the configurable approval policy (${APPROVAL_ACTIONS['variation.approve']}).</p>
                          <input type="hidden" name="__back" value="/variations">`,
                      }),
                    })
                  : '',
              ]),
              empty: 'No variations.',
            }),
          }),
        }),
      );
    }),
  );
};

// ---------------------------------------------------------------- acceptance UI

function acceptanceForm(ctx: Ctx, db: Parameters<RouteModule>[1]['db'], opp: Q.Opportunity, rev: Q.Revision, totals: Q.Totals, oppId: number): SafeHtml {
  const contacts = CRM.contactsFor(db, opp.customer_id);
  return card({
    title: 'Record the customer’s acceptance',
    body: html`
      <p class="tiny subtle">A “yes” is not yet work. Record exactly what was accepted and validate it; releasing the work is a separate, policy-governed step.</p>
      ${form({
        ctx,
        action: `/revisions/${rev.id}/acceptance`,
        submit: 'Record acceptance',
        body: html`
          <div class="fields cols2">
            ${input({ name: 'confirm_revision', label: `Type the revision number being accepted (${rev.rev_no})`, required: true, placeholder: String(rev.rev_no) })}
            ${input({ name: 'accepting_party', label: 'Accepting party (name, role, organisation)', required: true, span: true })}
            ${select({ name: 'accepting_contact_id', label: 'Known contact', blank: 'Not a recorded contact', options: options(contacts.map((c) => ({ id: c.id, label: `${c.name} — ${labelise(c.role_type)}${c.can_authorise_spend ? ' · can authorise spend' : ''}` }))) })}
            ${input({ name: 'acceptance_received_at', label: 'Received', type: 'datetime-local' })}
          </div>
          ${textarea({ name: 'acceptance_evidence', label: 'Evidence of acceptance', rows: 2, required: true, placeholder: 'e.g. signed acceptance form, email from procurement dated…' })}
          ${totals.options.length ? html`<fieldset><legend>Options accepted</legend>${totals.options.map((o) => checkbox({ name: 'options', value: o.code, label: `Option ${o.code} — ${fmtMoney(o.net)}` }))}</fieldset>` : ''}
          <fieldset>
            <legend>Validation before release</legend>
            ${checkbox({ name: 'chk_authority', label: 'Accepting party verified as authorised' })}
            ${input({ name: 'chk_authority_note', label: 'How their authority was verified' })}
            ${checkbox({ name: 'chk_revision_options', label: 'Exact revision and options confirmed with the customer' })}
            ${checkbox({ name: 'chk_po_value', label: 'PO / order value checked' })}
            <div class="fields cols2">${input({ name: 'po_number', label: 'PO number' })}${money({ name: 'po_value', label: 'PO value' })}</div>
            ${checkbox({ name: 'chk_terms', label: 'Customer terms reviewed' })}
            ${input({ name: 'chk_terms_note', label: 'Terms note' })}
            ${checkbox({ name: 'chk_dates', label: 'Dates achievable' })}
            ${input({ name: 'proposed_start', label: 'Proposed start', type: 'date' })}
            ${checkbox({ name: 'chk_validity_pricing', label: 'Validity and supplier pricing still stand' })}
            ${input({ name: 'chk_validity_note', label: 'Validity / re-pricing note' })}
            ${select({ name: 'credit_deposit', label: 'Credit / deposit', options: enumOptions(Q.CREDIT_STATES, undefined, 'unchecked') })}
            ${input({ name: 'credit_note', label: 'Credit note' })}
          </fieldset>
          <input type="hidden" name="__back" value="/quotes/${String(oppId)}?rev=${String(rev.id)}">
        `,
      })}
    `,
  });
}

function acceptanceCard(ctx: Ctx, db: Parameters<RouteModule>[1]['db'], acc: Q.Acceptance, rev: Q.Revision, opp: Q.Opportunity, canEdit: boolean): SafeHtml {
  const blockers = Q.releaseBlockers(db, acc);
  const staff = J.staffOptions(db);
  const checks: [string, number, string | null][] = [
    ['Accepting party / authority verified', acc.chk_authority, acc.chk_authority_note],
    ['Exact revision and options confirmed', acc.chk_revision_options, acc.accepted_options || 'base scope only'],
    ['PO / order value checked', acc.chk_po_value, acc.po_number ? `${acc.po_number} · ${fmtMoney(acc.po_value_pence)}` : null],
    ['Customer terms reviewed', acc.chk_terms, acc.chk_terms_note],
    ['Dates achievable', acc.chk_dates, acc.proposed_start ? `proposed start ${fmtD(acc.proposed_start)}` : null],
    ['Validity / supplier pricing', acc.chk_validity_pricing, acc.chk_validity_note],
  ];
  return card({
    title: 'Acceptance and release',
    actions: acc.released ? chip('released', 'ok') : chip('not released', 'warn'),
    body: html`
      ${defList([
        ['Accepted revision', `${opp.ref} rev ${rev.rev_no}`],
        ['Accepting party', acc.accepting_party],
        ['Received', when(acc.acceptance_received_at)],
        ['Evidence', prose(acc.acceptance_evidence)],
        ['Accepted value', html`${fmtMoney(acc.accepted_net_pence)} net + ${fmtMoney(acc.accepted_vat_pence)} VAT${acc.accepted_options ? ` · options ${acc.accepted_options}` : ' · base scope only'}`],
        ['Recorded by', `${acc.recorded_by_name ?? ''} ${fmtDT(acc.recorded_at)}`],
      ])}
      ${table({
        cols: ['Validation check', 'State', 'Note'],
        rows: checks.map(([label, value, note]) => [label, value ? chip('confirmed', 'ok') : chip('outstanding', 'warn'), html`<span class="tiny subtle">${note ?? '—'}</span>`]),
      })}
      <div class="kv mt1"><div><b>Credit / deposit</b> ${chip(labelise(acc.credit_deposit), acc.credit_deposit === 'cleared' || acc.credit_deposit === 'not_required' ? 'ok' : 'warn')} ${acc.credit_note ?? ''}</div></div>
      ${
        acc.released
          ? banner('ok', html`Released ${fmtDT(acc.released_at)} by ${acc.released_by_name} as ${acc.release_target === 'project' ? 'a project' : 'a job'}${acc.job_ref ? html` — <a href="/jobs/${String(acc.job_id)}">${acc.job_ref}</a>` : ''}${acc.project_ref ? ` — ${acc.project_ref}` : ''}.<br><span class="tiny">${acc.release_reason ?? ''}</span>`)
          : html`
              ${blockers.length ? banner('warn', html`<ul style="margin:0 0 0 16px">${blockers.map((b) => html`<li>${b}</li>`)}</ul>`, 'Release is blocked until these are resolved') : banner('ok', 'All validation checks are complete. Release is governed by the approval policy.')}
              ${
                canEdit
                  ? html`${drawer({
                      summary: 'Update the validation checklist',
                      body: form({
                        ctx,
                        action: `/acceptances/${acc.id}/checklist`,
                        submit: 'Save checklist',
                        body: html`${versionInput(acc.version)}
                          ${checkbox({ name: 'chk_authority', label: 'Accepting party verified as authorised', checked: !!acc.chk_authority })}
                          ${input({ name: 'chk_authority_note', label: 'How their authority was verified', value: acc.chk_authority_note ?? '' })}
                          ${checkbox({ name: 'chk_revision_options', label: 'Exact revision and options confirmed', checked: !!acc.chk_revision_options })}
                          ${checkbox({ name: 'chk_po_value', label: 'PO / order value checked', checked: !!acc.chk_po_value })}
                          <div class="fields cols2">${input({ name: 'po_number', label: 'PO number', value: acc.po_number ?? '' })}${money({ name: 'po_value', label: 'PO value', pence: acc.po_value_pence })}</div>
                          ${checkbox({ name: 'chk_terms', label: 'Customer terms reviewed', checked: !!acc.chk_terms })}
                          ${input({ name: 'chk_terms_note', label: 'Terms note', value: acc.chk_terms_note ?? '' })}
                          ${checkbox({ name: 'chk_dates', label: 'Dates achievable', checked: !!acc.chk_dates })}
                          ${input({ name: 'proposed_start', label: 'Proposed start', type: 'date', value: acc.proposed_start ?? '' })}
                          ${checkbox({ name: 'chk_validity_pricing', label: 'Validity and supplier pricing still stand', checked: !!acc.chk_validity_pricing })}
                          ${input({ name: 'chk_validity_note', label: 'Validity note', value: acc.chk_validity_note ?? '' })}
                          ${select({ name: 'credit_deposit', label: 'Credit / deposit', options: enumOptions(Q.CREDIT_STATES, undefined, acc.credit_deposit) })}
                          ${input({ name: 'credit_note', label: 'Credit note', value: acc.credit_note ?? '' })}
                          <input type="hidden" name="__back" value="/quotes/${String(opp.id)}?rev=${String(rev.id)}">`,
                      }),
                    })}
                    ${drawer({
                      summary: 'Release the work',
                      body: form({
                        ctx,
                        action: `/acceptances/${acc.id}/release`,
                        submit: 'Release work',
                        submitClass: 'accent',
                        confirm: 'Release this work? It becomes authority to purchase and start.',
                        body: html`<p class="tiny subtle">Release creates the delivery record and is the point at which purchasing and starting are authorised.</p>
                          ${select({ name: 'target', label: 'Release as', options: [{ value: 'job', label: 'Job (service or small works)' }, { value: 'project', label: 'Project (managed delivery)' }] })}
                          ${select({ name: 'owner_user_id', label: 'Owner / coordinator', blank: '—', options: staffOptions(staff, null) })}
                          ${textarea({ name: 'reason', label: 'Release note', rows: 2, required: true })}
                          <input type="hidden" name="__back" value="/quotes/${String(opp.id)}?rev=${String(rev.id)}">`,
                      }),
                    })}`
                  : ''
              }
            `
      }
    `,
    definition: 'Acceptance validation and commercial release are separate from quotation approval and issue: approval to issue is not authority to purchase or start.',
  });
}

export default register;
