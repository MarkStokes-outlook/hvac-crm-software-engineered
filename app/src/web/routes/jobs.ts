import fs from 'node:fs';
import path from 'node:path';
import { html, raw, type SafeHtml } from '../../lib/html.ts';
import { clock, fmtD, fmtDT, fmtT, relative } from '../../lib/clock.ts';
import { fmtMoney } from '../../lib/money.ts';
import { NotFoundError } from '../../lib/errors.ts';
import { can } from '../../auth/policy.ts';
import { auditFor } from '../../domain/audit.ts';
import * as J from '../../domain/jobs.ts';
import * as S from '../../domain/sla.ts';
import * as A from '../../domain/attendance.ts';
import * as Sched from '../../domain/scheduling.ts';
import * as CRM from '../../domain/crm.ts';
import * as Inv from '../../domain/inventory.ts';
import * as Q from '../../domain/quotes.ts';
import {
  banner,
  card,
  checkbox,
  chip,
  commChip,
  type Ctx,
  defList,
  drawer,
  dtInput,
  empty,
  enumOptions,
  finChip,
  form,
  input,
  labelise,
  opChip,
  options,
  page,
  priorityChip,
  prose,
  pagination,
  select,
  slaChip,
  staffOptions,
  table,
  textarea,
  versionInput,
  when,
} from '../ui.ts';
import { actorOf, back, canReq, ctxOf, h, intParam, intQuery, needCap, ok, type RouteDeps, type RouteModule, send, strQuery } from '../kit.ts';
import { aiButtons, aiPanel, loadInteraction } from '../aipanel.ts';

const register: RouteModule = (app, deps) => {
  const { db } = deps;

  // ---------------------------------------------------------------- list
  app.get(
    '/jobs',
    h((req, res) => {
      needCap(req, 'job.read');
      const ctx = ctxOf(req);
      const limit = 50;
      const offset = intQuery(req, 'offset') ?? 0;
      const filter: J.JobFilter = {
        status: strQuery(req, 'status') ?? 'open',
        priority: strQuery(req, 'priority'),
        kind: strQuery(req, 'kind'),
        owner: intQuery(req, 'owner'),
        q: strQuery(req, 'q'),
        limit,
        offset,
      };
      const { rows, total } = J.listJobs(db, filter);
      const now = clock.iso();
      const staff = J.staffOptions(db);
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries({ status: filter.status, priority: filter.priority, kind: filter.kind, owner: filter.owner, q: filter.q })) if (v) qs.set(k, String(v));

      send(
        res,
        page(ctx, {
          title: 'Service',
          heading: 'Service work',
          sub: 'Every job with its operational, financial and commercial state — these are recorded separately and never collapse into one “done”.',
          actions: canReq(req, 'job.create') ? html`<a class="btn primary" href="/jobs/new">Log a call</a>` : undefined,
          body: html`
            <form class="filters card" method="get" action="/jobs" style="padding:12px" data-autosubmit>
              <div class="field wide"><label for="f_q">Search</label><input id="f_q" type="search" name="q" value="${filter.q ?? ''}" placeholder="Reference, title, symptom, customer, postcode, PO"></div>
              ${select({
                name: 'status',
                label: 'State',
                value: filter.status,
                options: [
                  { value: 'open', label: 'Open work' },
                  { value: 'waiting', label: 'Waiting' },
                  { value: 'waiting_overdue', label: 'Waiting — review overdue' },
                  { value: 'ready', label: 'Ready to schedule' },
                  { value: 'scheduled', label: 'Scheduled' },
                  { value: 'in_progress', label: 'In progress' },
                  { value: 'awaiting_finance', label: 'Complete, not financially closed' },
                  { value: 'closed', label: 'Closed' },
                  { value: 'all', label: 'All' },
                ],
              })}
              ${select({ name: 'priority', label: 'Priority', value: filter.priority ?? '', blank: 'Any', options: enumOptions(J.PRIORITIES, J.PRIORITY_LABEL) })}
              ${select({ name: 'kind', label: 'Type', value: filter.kind ?? '', blank: 'Any', options: enumOptions(J.JOB_KINDS, J.JOB_KIND_LABEL) })}
              ${select({ name: 'owner', label: 'Next owner', value: filter.owner ?? '', blank: 'Anyone', options: staffOptions(staff, filter.owner ?? null) })}
              <button class="btn" type="submit">Apply</button>
              <a class="btn" href="/jobs">Clear</a>
            </form>
            ${card({
              tight: true,
              body: table({
                cols: ['Job', 'P', 'Customer / site', 'Operational', 'Next action / dependency', { label: 'Review', nowrap: true }, 'Financial', 'Commercial'],
                rows: rows.map((j) => [
                  html`<a class="rowtitle" href="/jobs/${String(j.id)}">${j.ref}</a> ${j.safety_flag ? chip('safety', 'danger') : ''}<br><span class="tiny subtle">${j.title}</span>`,
                  priorityChip(j.priority),
                  html`${j.customer_name}<br><span class="tiny subtle">${j.site_name}</span>`,
                  html`${opChip(j.op_status)}${j.op_status === 'waiting' && j.waiting_category ? html`<br><span class="tiny subtle">${J.WAITING_LABEL[j.waiting_category]}</span>` : ''}`,
                  html`${j.next_action ?? html`<span class="subtle">—</span>`}${j.next_owner_name ? html`<br><span class="tiny subtle">${j.next_owner_name}</span>` : ''}`,
                  j.review_at ? html`${when(j.review_at)}<br><span class="tiny ${raw(j.review_at < now ? 'chip danger' : 'subtle')}">${relative(j.review_at)}</span>` : html`<span class="subtle">—</span>`,
                  finChip(j.financial_status),
                  commChip(j.commercial_status),
                ]),
                rowClass: (i) => (rows[i].op_status === 'waiting' && rows[i].review_at && rows[i].review_at! < now ? 'rowwarn' : ''),
                empty: 'No jobs match these filters.',
              }),
              foot: pagination({ total, limit, offset, base: `/jobs?${qs.toString()}` }),
            })}
          `,
        }),
      );
    }),
  );

  // ---------------------------------------------------------------- intake (US-020)
  app.get(
    '/jobs/new',
    h((req, res) => {
      needCap(req, 'job.create');
      const ctx = ctxOf(req);
      const siteId = intQuery(req, 'site');
      const customerId = siteId ? CRM.getSite(db, siteId).customer_id : intQuery(req, 'customer');
      const customers = CRM.listCustomers(db, { limit: 500 }).rows;
      const sites = customerId ? CRM.sitesForCustomer(db, customerId) : [];
      const staff = J.staffOptions(db);

      const picker = card({
        title: '1 · Identify the customer and site',
        body: html`<form class="filters" method="get" action="/jobs/new">
          ${select({ name: 'customer', label: 'Customer', value: customerId ?? '', blank: 'Choose a customer…', options: options(customers.map((c) => ({ id: c.id, label: `${c.trading_name} (${c.ref})` })), customerId ?? null), required: true })}
          ${customerId ? select({ name: 'site', label: 'Site', value: siteId ?? '', blank: 'Choose a site…', options: options(sites.map((s) => ({ id: s.id, label: `${s.name}${s.postcode ? ` — ${s.postcode}` : ''}` })), siteId ?? null), required: true }) : ''}
          <button class="btn" type="submit">${customerId ? 'Use this site' : 'Next'}</button>
          ${customerId ? html`<a class="btn" href="/jobs/new">Start again</a>` : ''}
        </form>
        <p class="hint mt1">Can’t find them? <a href="/customers/new">Add a customer</a> first — a job always belongs to a site so the engineer knows where to go.</p>`,
      });

      if (!siteId) {
        send(res, page(ctx, { title: 'Log a call', heading: 'Log a call', crumbs: [{ href: '/jobs', label: 'Service' }, { label: 'New' }], narrow: true, body: picker }));
        return;
      }

      const site = CRM.redactSite(db, ctx.user, CRM.getSite(db, siteId));
      const contacts = CRM.contactsFor(db, site.customer_id!, siteId);
      const assets = CRM.assetsForSite(db, siteId).filter((a) => a.status !== 'decommissioned');
      const contract = CRM.contractForSite(db, siteId);
      const targets = contract ? (db.prepare('SELECT * FROM contract_targets WHERE contract_id = ? ORDER BY priority').all(contract.id) as CRM.ContractTarget[]) : [];

      send(
        res,
        page(ctx, {
          title: 'Log a call',
          heading: `Log a call — ${site.name}`,
          crumbs: [{ href: '/jobs', label: 'Service' }, { href: `/sites/${siteId}`, label: site.name! }, { label: 'New job' }],
          sub: html`${site.customer_name} · ${site.address}${site.postcode ? `, ${site.postcode}` : ''}`,
          body: html`
            ${picker}
            ${site.work_restrictions || site.induction_required || site.asbestos_info ? banner('warn', html`${[site.induction_required ? 'Induction/permit required at this site.' : '', site.asbestos_info ? `Asbestos: ${site.asbestos_info}` : '', site.work_restrictions ?? ''].filter(Boolean).join(' · ')}`, 'Site conditions') : ''}
            ${
              contract
                ? banner(
                    'info',
                    html`<a href="/customers/${String(site.customer_id)}#contracts">${contract.ref} ${contract.name}</a> covers this site.
                      ${targets.length ? html`Targets: ${targets.map((t) => html`<span class="chip">${t.priority}: response ${t.response_minutes ? `${t.response_minutes}m` : '—'} / attend ${t.attendance_minutes ? `${Math.round(t.attendance_minutes / 60)}h` : '—'}</span> `)}` : ''}
                      ${contract.entitlement_notes ? html`<br><span class="tiny">${contract.entitlement_notes}</span>` : ''}`,
                    'Contract cover',
                  )
                : banner('warn', html`No active contract covers this site. Establish who authorises the work and any spend before committing an attendance.`, 'No contract')
            }
            ${form({
              ctx,
              action: '/jobs',
              submit: 'Log the job',
              body: html`
                <input type="hidden" name="site_id" value="${String(siteId)}">
                ${card({
                  title: '2 · What has been reported',
                  body: html`<div class="fields cols2">
                    ${input({ name: 'title', label: 'Short title', required: true, placeholder: 'e.g. No cooling in server room', span: true, autofocus: true })}
                    ${textarea({ name: 'reported_symptom', label: 'Reported symptom (their words)', rows: 3, span: true, hint: 'Record what was reported, before any interpretation.' })}
                    ${select({ name: 'reported_by_contact_id', label: 'Reported by (known contact)', blank: 'Not a recorded contact', options: options(contacts.map((c) => ({ id: c.id, label: `${c.name} — ${labelise(c.role_type)}${c.can_authorise_spend ? ' · can authorise spend' : ''}` }))) })}
                    ${input({ name: 'reported_by_name', label: 'Or name / number given', placeholder: 'Caller name' })}
                    ${select({ name: 'channel', label: 'How it reached us', required: true, options: enumOptions(J.CHANNELS, { phone: 'Phone', email: 'Email', engineer: 'Engineer on site', portal_other: 'Other', planned: 'Planned schedule', quote: 'From a quotation' }, 'phone') })}
                    ${dtInput({ name: 'received_at', label: 'Time received', iso: clock.iso(), hint: 'When the customer contacted us, not when you finished typing.' })}
                    ${textarea({ name: 'impact', label: 'Impact now', rows: 2, span: true, placeholder: 'Who or what is affected? Is there a backup? Stock, medicine, IT, trading or residents at risk?' })}
                    ${checkbox({ name: 'safety_flag', label: 'Safety or property risk reported' })}
                    ${textarea({ name: 'safety_risk', label: 'Safety / property risk detail', rows: 2 })}
                    ${select({ name: 'kind', label: 'Job type', required: true, options: enumOptions(J.JOB_KINDS, J.JOB_KIND_LABEL, 'reactive') })}
                    ${assets.length ? html`<div class="field span2"><span class="lbl">Equipment involved</span><div class="fields cols3">${assets.map((a) => checkbox({ name: 'asset_ids', value: String(a.id), label: `${a.ref} — ${a.description}`, hint: [a.manufacturer, a.model, a.location_detail].filter(Boolean).join(' · ') }))}</div><span class="hint">Linking equipment gives the engineer its history and keeps the asset record accurate.</span></div>` : ''}
                  </div>`,
                })}
                ${card({
                  title: '3 · Authority and priority',
                  body: html`<div class="fields cols2">
                    ${select({ name: 'contract_id', label: 'Contract context', options: [{ value: '', label: contract ? `${contract.ref} — ${contract.name}` : 'No contract found for this site' }, { value: 'none', label: 'Deliberately outside contract (chargeable)' }], hint: 'Detected from the site; choose “outside contract” if this call is not covered.' })}
                    ${select({ name: 'authority_basis', label: 'Authority to proceed', options: enumOptions(J.AUTHORITY_BASES, J.AUTHORITY_LABEL, 'not_established'), hint: 'Being on site is not unlimited authority. Diagnosis only is a valid answer.' })}
                    ${input({ name: 'authority_ref', label: 'Authority reference', placeholder: 'Quote number, contract clause, who approved' })}
                    ${input({ name: 'customer_po', label: 'Customer PO', placeholder: 'If supplied' })}
                    ${select({ name: 'priority', label: 'Priority', required: true, options: enumOptions(J.PRIORITIES, J.PRIORITY_LABEL, 'P3'), hint: 'Based on current impact, not who shouts loudest.' })}
                    ${textarea({ name: 'priority_reason', label: 'Why this priority', rows: 2, required: true, span: true, placeholder: 'e.g. Care home with vulnerable residents and no heating; no alternative' })}
                  </div>`,
                })}
                ${card({
                  title: '4 · Triage outcome and next action',
                  body: html`<div class="fields cols2">
                    ${textarea({ name: 'triage_notes', label: 'Triage outcome / remote checks', rows: 3, span: true, placeholder: 'What you established on the call, what you told them, what you still need.' })}
                    ${input({ name: 'required_competences', label: 'Competences needed', placeholder: 'e.g. refrigeration, fgas', hint: 'Comma separated tags used to warn planners.' })}
                    ${input({ name: 'estimated_minutes', label: 'Estimated duration (minutes)', type: 'number', min: 15, max: 1440, value: 120 })}
                    ${input({ name: 'next_action', label: 'Next action', placeholder: 'e.g. Assign engineer today' })}
                    ${select({ name: 'next_owner_user_id', label: 'Next-action owner', blank: 'No owner yet', options: staffOptions(staff, ctx.user.id) })}
                    ${dtInput({ name: 'review_at', label: 'Review by', iso: J.defaultReview(4) })}
                    ${checkbox({ name: 'acknowledged', label: 'Acknowledgement given to the customer now', hint: 'Records the acknowledged SLA event.' })}
                  </div>`,
                })}
              `,
            })}
          `,
        }),
      );
    }),
  );

  app.post(
    '/jobs',
    h((req, res) => {
      const id = J.createJob(db, actorOf(req), req.body);
      ok(res, `/jobs/${id}`, `${J.getJob(db, id).ref} logged.`);
    }),
  );

  // ---------------------------------------------------------------- detail
  app.get(
    '/jobs/:id',
    h((req, res) => {
      const user = actorOf(req);
      const id = intParam(req);
      if (user.role === 'engineer') return res.redirect(`/jobs/${id}/brief`);
      needCap(req, 'job.read');
      send(res, jobPage(deps, req.ctx!, id, intQuery(req, 'ai')));
    }),
  );

  // ---------------------------------------------------------------- job actions
  const action = (path: string, fn: (id: number, req: Parameters<Parameters<typeof h>[0]>[0]) => string) =>
    app.post(
      path,
      h((req, res) => {
        const id = intParam(req);
        const message = fn(id, req);
        ok(res, back(req) || `/jobs/${id}`, message);
      }),
    );

  action('/jobs/:id/triage', (id, req) => {
    J.triageJob(db, actorOf(req), id, req.body);
    return 'Triage recorded.';
  });
  action('/jobs/:id/priority', (id, req) => {
    J.changePriority(db, actorOf(req), id, req.body);
    return 'Priority changed and recorded with your reason.';
  });
  action('/jobs/:id/authority', (id, req) => {
    J.setAuthority(db, actorOf(req), id, req.body);
    return 'Authority basis recorded.';
  });
  action('/jobs/:id/readiness', (id, req) => {
    J.updateReadiness(db, actorOf(req), id, req.body);
    return 'Readiness updated.';
  });
  action('/jobs/:id/waiting', (id, req) => {
    J.setWaiting(db, actorOf(req), id, req.body);
    return 'Dependency recorded with an owner and review point.';
  });
  action('/jobs/:id/waiting/resolve', (id, req) => {
    J.resolveWaiting(db, actorOf(req), id, req.body);
    return 'Dependency cleared.';
  });
  action('/jobs/:id/next-action', (id, req) => {
    J.setNextAction(db, actorOf(req), id, req.body);
    return 'Next action updated.';
  });
  action('/jobs/:id/notes', (id, req) => {
    J.addNote(db, actorOf(req), id, req.body);
    return 'Note saved.';
  });
  action('/jobs/:id/complete', (id, req) => {
    J.completeOperationally(db, actorOf(req), id, req.body);
    return 'Job recorded as operationally complete. Financial and commercial closure remain separate.';
  });
  action('/jobs/:id/financial', (id, req) => {
    J.setFinancialStatus(db, actorOf(req), id, req.body);
    return 'Financial status updated.';
  });
  action('/jobs/:id/commercial', (id, req) => {
    J.setCommercialStatus(db, actorOf(req), id, req.body);
    return 'Commercial status updated.';
  });
  action('/jobs/:id/cancel', (id, req) => {
    J.cancelJob(db, actorOf(req), id, req.body);
    return 'Job cancelled.';
  });
  action('/jobs/:id/sla/event', (id, req) => {
    S.recordManualEvent(db, actorOf(req), id, req.body);
    return 'SLA event recorded.';
  });
  action('/jobs/:id/clock-stop', (id, req) => {
    S.startClockStop(db, actorOf(req), id, req.body);
    return 'Clock stop started, with its dependency, evidence, owner and chase point.';
  });

  app.post(
    '/sla-events/:id/supersede',
    h((req, res) => {
      S.supersedeEvent(db, actorOf(req), intParam(req), req.body);
      ok(res, back(req), 'Correction recorded. The original event remains visible.');
    }),
  );
  app.post(
    '/clock-stops/:id/end',
    h((req, res) => {
      S.endClockStop(db, actorOf(req), intParam(req), req.body);
      ok(res, back(req), 'Clock restarted.');
    }),
  );
  app.post(
    '/temporary-restorations/:id/resolve',
    h((req, res) => {
      A.resolveTemporary(db, actorOf(req), intParam(req), req.body);
      ok(res, back(req), 'Temporary restoration closed out.');
    }),
  );
  app.post(
    '/escalations/:id/resolve',
    h((req, res) => {
      A.resolveStop(db, actorOf(req), intParam(req), req.body);
      ok(res, back(req), 'Escalation answered; the engineer has been notified.');
    }),
  );

  // ---------------------------------------------------------------- evidence files
  app.get(
    '/evidence/:id/file',
    h((req, res) => {
      const user = actorOf(req);
      const id = intParam(req);
      const row = db.prepare(`SELECT e.*, j.site_id FROM evidence e JOIN jobs j ON j.id = e.job_id WHERE e.id = ?`).get(id) as
        | { id: number; job_id: number; site_id: number; stored_path: string | null; mime_type: string | null; file_name: string | null }
        | undefined;
      if (!row || !row.stored_path) throw new NotFoundError('Evidence file');
      if (!can(user, 'job.read') && !CRM.engineerAssignedToSite(db, user.id, row.site_id)) throw new NotFoundError('Evidence file');
      const full = path.join(deps.uploadDir, path.basename(row.stored_path));
      if (!fs.existsSync(full)) throw new NotFoundError('Evidence file');
      res.setHeader('Content-Type', row.mime_type ?? 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${(row.file_name ?? 'evidence').replace(/[^\w.\- ]/g, '_')}"`);
      res.setHeader('Cache-Control', 'private, max-age=60');
      fs.createReadStream(full).pipe(res);
    }),
  );
};

// ---------------------------------------------------------------- the job page

export function jobPage(deps: RouteDeps, ctx: Ctx, id: number, aiId?: number): string {
  const { db } = deps;
  const job = J.getJob(db, id);
  const site = CRM.redactSite(db, ctx.user, CRM.getSite(db, job.site_id));
  const assets = J.jobAssets(db, id);
  const attendances = Sched.attendancesForJob(db, id);
  const events = S.slaEvents(db, id);
  const stops = S.clockStops(db, id);
  const sla = S.computeSla(db, job);
  const notes = J.jobNotes(db, id);
  const priorityHistory = J.priorityHistory(db, id);
  const escalations = A.stopsFor(db, { jobId: id });
  const temps = A.temporaryRestorations(db, { jobId: id });
  const evidence = A.evidenceFor(db, { jobId: id });
  const materials = A.materialsFor(db, { jobId: id });
  const reservations = Inv.reservationsFor(db, { jobId: id });
  const holds = Inv.listHolds(db, { jobId: id });
  const variations = Q.variationsFor(db, { jobId: id });
  const displacements = Sched.displacementsForJob(db, id);
  const staff = J.staffOptions(db);
  const openClock = stops.find((s) => !s.ended_at);
  const blockers = J.closureBlockers(db, job);
  const isOpen = J.OPEN_STATUSES.includes(job.op_status);
  const interaction = aiId ? loadInteraction(db, aiId, ctx.user.id) : null;
  const backTo = `/jobs/${id}`;

  const acceptance = job.acceptance_id ? (db.prepare('SELECT * FROM acceptances WHERE id = ?').get(job.acceptance_id) as Q.Acceptance | undefined) : undefined;
  const acceptanceRev = acceptance ? Q.getRevision(db, acceptance.revision_id) : undefined;
  const acceptanceOpp = acceptanceRev ? Q.getOpportunity(db, acceptanceRev.opportunity_id) : undefined;

  const headingChips = html`${priorityChip(job.priority, true)} ${opChip(job.op_status, true)} ${finChip(job.financial_status, true)} ${commChip(job.commercial_status, true)}`;

  // --- banners -------------------------------------------------------
  const banners: SafeHtml[] = [];
  if (job.safety_flag) banners.push(banner('err', html`${job.safety_risk ?? 'Safety risk reported.'}`, 'Safety / property risk reported'));
  for (const e of escalations.filter((x) => !x.resolved_at)) {
    banners.push(
      banner(
        'err',
        html`<b>${A.STOP_LABEL[e.kind]}</b> — ${e.raised_by_name} on ${e.attendance_ref}, ${relative(e.raised_at)}.<br>${e.detail}
          ${e.safety_condition ? html`<br><span class="tiny">Condition left: ${e.safety_condition}</span>` : ''}
          ${canReqCtx(ctx, 'escalation.resolve')
            ? drawer({
                summary: 'Respond to this escalation',
                body: form({
                  ctx,
                  action: `/escalations/${e.id}/resolve`,
                  submit: 'Record decision',
                  body: html`${textarea({ name: 'resolution', label: 'Decision / instruction to the engineer', rows: 3, required: true })}<input type="hidden" name="__back" value="${backTo}">`,
                }),
              })
            : ''}`,
        'Engineer stopped or escalated',
      ),
    );
  }
  if (openClock) {
    banners.push(
      banner(
        'warn',
        html`<b>${S.CLOCK_STOP_LABEL[openClock.reason_category]}</b> since ${fmtDT(openClock.started_at)} (${relative(openClock.started_at)}) — ${openClock.dependency_detail}<br>
          <span class="tiny">Waiting on ${openClock.expected_actor} · FrostLine owner ${openClock.owner_name} · chase ${fmtDT(openClock.chase_at)}</span>
          ${canReqCtx(ctx, 'sla.clockstop')
            ? drawer({
                summary: 'Restart the clock',
                body: form({
                  ctx,
                  action: `/clock-stops/${openClock.id}/end`,
                  submit: 'Restart clock',
                  body: html`${textarea({ name: 'end_note', label: 'What changed / why the clock restarts', rows: 2, required: true })}<input type="hidden" name="__back" value="${backTo}">`,
                }),
              })
            : ''}`,
        'SLA clock stopped',
      ),
    );
  }
  for (const t of temps.filter((x) => x.status === 'open')) {
    banners.push(
      banner(
        t.review_at < clock.iso() ? 'err' : 'warn',
        html`${t.change_made} — <b>limits:</b> ${t.limitations} · <b>residual risk:</b> ${t.residual_risk}<br>
          <span class="tiny">Review ${fmtDT(t.review_at)} (${relative(t.review_at)}) · permanent resolution owned by ${t.owner_name} · customer told: ${t.customer_understanding}</span>
          ${canReqCtx(ctx, 'temp.resolve')
            ? drawer({
                summary: 'Close out this temporary restoration',
                body: form({
                  ctx,
                  action: `/temporary-restorations/${t.id}/resolve`,
                  submit: 'Record permanent resolution',
                  body: html`${textarea({ name: 'resolution_note', label: 'How it was permanently resolved, or which follow-on job now owns it', rows: 3, required: true })}<input type="hidden" name="__back" value="${backTo}">`,
                }),
              })
            : ''}`,
        'Temporary restoration open — this is a future obligation, not a fix',
      ),
    );
  }

  // --- next action panel ---------------------------------------------
  const nextPanel = isOpen
    ? card({
        title: job.op_status === 'waiting' ? `Waiting on ${job.waiting_category ? J.WAITING_LABEL[job.waiting_category] : 'a dependency'}` : 'Next action',
        body: html`
          ${defList([
            [job.op_status === 'waiting' ? 'Exactly what is awaited' : 'Next action', job.op_status === 'waiting' ? prose(job.waiting_detail) : prose(job.next_action)],
            ['Owner', job.next_owner_name ?? html`<span class="chip warn">nobody</span>`],
            ['Review / chase', job.review_at ? html`${when(job.review_at)} <span class="tiny ${raw(job.review_at < clock.iso() ? 'chip danger' : 'subtle')}">${relative(job.review_at)}</span>` : html`<span class="chip warn">not set</span>`],
            job.op_status === 'waiting' ? ['Waiting since', job.waiting_since ? html`${when(job.waiting_since)} <span class="tiny subtle">(${relative(job.waiting_since)})</span>` : null] : ['Next action set', null],
          ])}
          <div class="mt2">
            ${canReqCtx(ctx, 'job.waiting')
              ? html`
                  ${job.op_status === 'waiting'
                    ? drawer({
                        summary: 'Dependency cleared — resume the job',
                        body: form({
                          ctx,
                          action: `/jobs/${id}/waiting/resolve`,
                          submit: 'Clear dependency',
                          body: html`${versionInput(job.version)}${textarea({ name: 'resolution', label: 'What resolved it', rows: 2, required: true })}
                            <div class="fields cols2">${input({ name: 'next_action', label: 'New next action (optional)' })}${select({ name: 'next_owner_user_id', label: 'Owner', blank: '—', options: staffOptions(staff, ctx.user.id) })}${dtInput({ name: 'review_at', label: 'Review by', iso: J.defaultReview(24) })}</div>
                            <input type="hidden" name="__back" value="${backTo}">`,
                        }),
                      })
                    : drawer({
                        summary: 'Park this job on a dependency',
                        body: html`<p class="tiny subtle mb1">There is no generic “on hold”: record what is awaited, who owns it and when we chase.</p>
                          ${form({
                            ctx,
                            action: `/jobs/${id}/waiting`,
                            submit: 'Record dependency',
                            body: html`${versionInput(job.version)}
                              <div class="fields cols2">
                                ${select({ name: 'waiting_category', label: 'Dependency', required: true, options: enumOptions(J.WAITING_CATEGORIES, J.WAITING_LABEL) })}
                                ${select({ name: 'next_owner_user_id', label: 'FrostLine owner', required: true, options: staffOptions(staff, job.next_owner_user_id ?? ctx.user.id) })}
                              </div>
                              ${textarea({ name: 'waiting_detail', label: 'Exactly what is awaited, from whom', rows: 2, required: true })}
                              <div class="fields cols2">${input({ name: 'next_action', label: 'Next action', required: true })}${dtInput({ name: 'review_at', label: 'Review / chase by', required: true, iso: J.defaultReview(24) })}</div>
                              <input type="hidden" name="__back" value="${backTo}">`,
                          })}`,
                      })}
                  ${drawer({
                    summary: 'Change the next action or owner',
                    body: form({
                      ctx,
                      action: `/jobs/${id}/next-action`,
                      submit: 'Save next action',
                      body: html`${versionInput(job.version)}
                        <div class="fields cols2">
                          ${input({ name: 'next_action', label: 'Next action', required: true, value: job.next_action ?? '' })}
                          ${select({ name: 'next_owner_user_id', label: 'Owner', required: true, options: staffOptions(staff, job.next_owner_user_id) })}
                          ${dtInput({ name: 'review_at', label: 'Review by', required: true, iso: job.review_at ?? J.defaultReview(24) })}
                        </div>
                        <input type="hidden" name="__back" value="${backTo}">`,
                    }),
                  })}
                `
              : ''}
          </div>
        `,
        definition: 'Waiting work must name its dependency, its FrostLine owner and when we chase — otherwise it is invisible until the customer calls.',
      })
    : html``;

  // --- overview -------------------------------------------------------
  const overview = card({
    title: 'Job',
    actions: aiButtons(ctx, { entity: 'job', id, tasks: ['summarise_history', 'suggest_triage_questions', 'draft_customer_update', 'check_handoff'], back: backTo }),
    body: html`<div class="grid cols2">
      <div>
        ${defList([
          ['Customer', html`<a href="/customers/${String(job.customer_id)}">${job.customer_name}</a>`],
          ['Site', html`<a href="/sites/${String(job.site_id)}">${job.site_name}</a> <span class="tiny subtle">${site.address}${site.postcode ? `, ${site.postcode}` : ''}</span>`],
          ['Contract', job.contract_ref ? html`${job.contract_ref} — ${job.contract_name}` : html`<span class="chip warn">none</span>`],
          ['Type', labelise(job.kind)],
          ['Received', html`${when(job.received_at, { rel: true })} <span class="tiny subtle">via ${labelise(job.channel ?? '—')}</span>`],
          ['Reported by', job.reported_by_name ?? '—'],
          ['Customer PO', job.customer_po ?? '—'],
          ['Equipment', assets.length ? html`${assets.map((a) => html`<a href="/assets/${String(a.id)}">${a.ref}</a> ${a.description}${a.location_detail ? html` <span class="tiny subtle">(${a.location_detail})</span>` : ''}<br>`)}` : html`<span class="subtle">None linked</span>`],
        ])}
      </div>
      <div>
        ${defList([
          ['Reported symptom', prose(job.reported_symptom, true)],
          ['Impact', prose(job.impact)],
          ['Safety / property risk', job.safety_flag ? html`<span class="chip danger">yes</span> ${prose(job.safety_risk)}` : html`<span class="subtle">None recorded</span>`],
          ['Triage notes', prose(job.triage_notes)],
        ])}
      </div>
    </div>`,
  });

  // --- authority & readiness ------------------------------------------
  const readinessCard = card({
    title: 'Authority and readiness',
    body: html`
      <div class="grid cols2">
        <div>
          ${defList([
            ['Authority basis', html`${chip(J.AUTHORITY_LABEL[job.authority_basis], job.authority_basis === 'not_established' ? 'warn' : 'ok')}`],
            ['Reference', job.authority_ref ?? '—'],
            ['Notes', prose(job.authority_notes)],
          ])}
          ${canReqCtx(ctx, 'job.authorise') && isOpen
            ? drawer({
                summary: 'Record authority to proceed',
                body: form({
                  ctx,
                  action: `/jobs/${id}/authority`,
                  submit: 'Save authority',
                  body: html`${versionInput(job.version)}
                    <div class="fields cols2">
                      ${select({ name: 'authority_basis', label: 'Basis', required: true, options: enumOptions(J.AUTHORITY_BASES, J.AUTHORITY_LABEL, job.authority_basis) })}
                      ${input({ name: 'authority_ref', label: 'Reference (quote, clause, approver)', value: job.authority_ref ?? '' })}
                      ${input({ name: 'customer_po', label: 'Customer PO', value: job.customer_po ?? '' })}
                    </div>
                    ${textarea({ name: 'authority_notes', label: 'Notes / limits of the authority', rows: 2, value: job.authority_notes ?? '' })}
                    ${textarea({ name: 'reason', label: 'Evidence for this authority (who said what, when)', rows: 2, required: true })}
                    <input type="hidden" name="__back" value="${backTo}">`,
                }),
              })
            : ''}
        </div>
        <div>
          <table class="data">
            <tbody>
              ${J.READINESS_KEYS.map((k) => html`<tr><td>${J.READINESS_LABEL[k]}</td><td class="right">${job[k] ? chip('confirmed', 'ok') : chip('not yet', 'warn')}</td></tr>`)}
              ${job.emergency_proceed ? html`<tr><td colspan="2">${chip('Emergency — proceeding with uncertainty', 'danger')}<br><span class="tiny">${job.emergency_reason ?? ''}</span></td></tr>` : ''}
            </tbody>
          </table>
          ${defList([
            ['Competences needed', job.required_competences ?? '—'],
            ['Estimated duration', job.estimated_minutes ? `${job.estimated_minutes} minutes` : '—'],
            ['Expected resources', prose(job.expected_resources)],
          ])}
          ${canReqCtx(ctx, 'job.readiness') && isOpen
            ? drawer({
                summary: 'Update readiness checklist',
                body: form({
                  ctx,
                  action: `/jobs/${id}/readiness`,
                  submit: 'Save readiness',
                  body: html`${versionInput(job.version)}
                    ${J.READINESS_KEYS.map((k) => checkbox({ name: k, label: J.READINESS_LABEL[k], checked: !!job[k] }))}
                    <hr>
                    ${checkbox({ name: 'emergency_proceed', label: 'Emergency: proceed despite unmet readiness', checked: !!job.emergency_proceed, hint: 'Deliberate decision to accept uncertainty — recorded and audited.' })}
                    ${textarea({ name: 'emergency_reason', label: 'Why we are proceeding anyway', rows: 2, value: job.emergency_reason ?? '' })}
                    <div class="fields cols2">
                      ${input({ name: 'required_competences', label: 'Competences needed', value: job.required_competences ?? '' })}
                      ${input({ name: 'estimated_minutes', label: 'Estimated minutes', type: 'number', min: 15, max: 1440, value: job.estimated_minutes ?? 120 })}
                    </div>
                    ${textarea({ name: 'expected_resources', label: 'Parts / tools / access expected', rows: 2, value: job.expected_resources ?? '' })}
                    <input type="hidden" name="__back" value="${backTo}">`,
                }),
              })
            : ''}
        </div>
      </div>
    `,
    definition: 'Authorised, ready, scheduled and dispatched are different things. Readiness is what makes work schedulable; emergencies may deliberately proceed without it.',
  });

  // --- SLA ------------------------------------------------------------
  const slaCard = card({
    title: 'SLA and clock',
    body: html`
      ${job.contract_ref ? '' : banner('info', html`No contract covers this job, so no contractual targets apply. Events are still recorded.`)}
      <div class="chips mb1">${sla.map((t) => (t.state === 'no_target' ? chip(`${t.label}: no target`, 'neutral') : slaChip(t.state, t.label)))}</div>
      ${table({
        cols: ['Target', 'Due', 'Met', 'Paused', 'State'],
        rows: sla
          .filter((t) => t.targetMinutes)
          .map((t) => [
            html`${t.label}<br><span class="tiny subtle">${String(t.targetMinutes)} min from receipt</span>`,
            when(t.dueAt),
            t.metAt ? when(t.metAt) : html`<span class="subtle">—</span>`,
            t.pausedMinutes ? html`${String(t.pausedMinutes)} min` : html`<span class="subtle">—</span>`,
            slaChip(t.state, labelise(t.state)),
          ]),
        empty: 'No contractual targets for this priority.',
      })}
      <h3 class="mt2 mb1">Event timeline</h3>
      <ul class="timeline">
        ${events.map(
          (e) => html`<li class="${raw(e.superseded ? 'superseded' : '')}">
            <span class="when">${fmtDT(e.occurred_at)}</span>
            <span class="what">
              <b>${S.SLA_EVENT_LABEL[e.type]}</b> ${e.superseded ? chip('corrected', 'warn') : ''} ${e.supersedes_id ? chip('correction', 'info') : ''}
              ${e.note ? html`<br>${e.note}` : ''}
              <br><span class="tiny subtle">${e.source === 'attendance' ? 'from attendance' : e.source} · recorded ${fmtDT(e.recorded_at)}${e.recorded_by_name ? ` by ${e.recorded_by_name}` : ''}</span>
              ${
                canReqCtx(ctx, 'sla.record') && !e.superseded
                  ? drawer({
                      summary: 'Correct this time',
                      body: form({
                        ctx,
                        action: `/sla-events/${e.id}/supersede`,
                        submit: 'Record correction',
                        body: html`<p class="tiny subtle">The original stays on the record, struck through, with your reason.</p>
                          ${dtInput({ name: 'occurred_at', label: 'Corrected time', required: true, iso: e.occurred_at })}
                          ${textarea({ name: 'reason', label: 'Why the original was wrong', rows: 2, required: true })}
                          <input type="hidden" name="__back" value="${backTo}">`,
                      }),
                    })
                  : ''
              }
            </span>
          </li>`,
        )}
      </ul>
      ${stops.length
        ? html`<h3 class="mt2 mb1">Clock stops</h3>
            ${table({
              cols: ['Dependency', 'Basis / evidence', 'Owner', 'From', 'To'],
              rows: stops.map((s) => [
                html`${S.CLOCK_STOP_LABEL[s.reason_category]}<br><span class="tiny subtle">${s.dependency_detail}</span>`,
                html`<span class="tiny">${s.contractual_basis}<br>${s.evidence}</span>`,
                html`${s.owner_name}<br><span class="tiny subtle">chase ${fmtDT(s.chase_at)} · ${s.expected_actor}</span>`,
                when(s.started_at),
                s.ended_at ? html`${when(s.ended_at)}<br><span class="tiny subtle">${s.end_note ?? ''}</span>` : chip('running', 'warn'),
              ]),
            })}`
        : ''}
      ${
        canReqCtx(ctx, 'sla.record') && isOpen
          ? html`<div class="mt2">
              ${drawer({
                summary: 'Record an SLA event',
                body: form({
                  ctx,
                  action: `/jobs/${id}/sla/event`,
                  submit: 'Record event',
                  body: html`<div class="fields cols2">
                      ${select({ name: 'type', label: 'Event', required: true, options: S.MANUAL_EVENT_TYPES.map((t) => ({ value: t, label: S.SLA_EVENT_LABEL[t] })) })}
                      ${dtInput({ name: 'occurred_at', label: 'When it happened', iso: clock.iso() })}
                    </div>
                    ${textarea({ name: 'note', label: 'Note (required if recorded late)', rows: 2 })}
                    <input type="hidden" name="__back" value="${backTo}">`,
                }),
              })}
              ${
                canReqCtx(ctx, 'sla.clockstop') && !openClock
                  ? drawer({
                      summary: 'Stop the SLA clock',
                      body: html`<p class="tiny subtle mb1">Only where the contract permits it and a genuine dependency prevents progress. Stops start now — they cannot be back-dated.</p>
                        ${form({
                          ctx,
                          action: `/jobs/${id}/clock-stop`,
                          submit: 'Stop clock',
                          body: html`<div class="fields cols2">
                              ${select({ name: 'reason_category', label: 'Dependency type', required: true, options: enumOptions(S.CLOCK_STOP_REASONS, S.CLOCK_STOP_LABEL) })}
                              ${select({ name: 'owner_user_id', label: 'FrostLine owner', required: true, options: staffOptions(staff, ctx.user.id) })}
                            </div>
                            ${input({ name: 'contractual_basis', label: 'Contract clause / basis', required: true })}
                            ${textarea({ name: 'dependency_detail', label: 'What is blocking progress', rows: 2, required: true })}
                            ${textarea({ name: 'evidence', label: 'Evidence (email, call, gate record)', rows: 2, required: true })}
                            <div class="fields cols2">${input({ name: 'expected_actor', label: 'Who must act', required: true })}${dtInput({ name: 'chase_at', label: 'Chase point', required: true, iso: J.defaultReview(24) })}</div>
                            <input type="hidden" name="__back" value="${backTo}">`,
                        })}`,
                    })
                  : ''
              }
            </div>`
          : ''
      }
    `,
    definition: 'Received, acknowledged, response, dispatched, attendance, diagnosis, restoration, resolution and closure are distinct events. Due times extend by permitted clock stops only.',
  });

  // --- attendances ----------------------------------------------------
  const attendanceCard = card({
    title: `Attendances (${attendances.length})`,
    actions: canReqCtx(ctx, 'schedule.assign') && isOpen ? html`<a class="btn small primary" href="/schedule/assign?job=${String(id)}">Assign an engineer</a>` : undefined,
    body: attendances.length
      ? html`${attendances.map((a) => attendanceBlock(ctx, a, db))}`
      : empty('No attendances yet', 'An attendance is one visit; a job can need several and does not close when one ends.'),
    definition: 'Each attendance records its own authority, outcome, evidence and handoff. Completing one never closes the job by itself.',
  });

  // --- evidence, materials, stock --------------------------------------
  const evidenceCard = card({
    title: 'Evidence and materials',
    body: html`
      ${table({
        cols: ['Evidence', 'Captured', 'By', ''],
        rows: evidence.map((e) => [
          html`${chip(labelise(e.kind), 'neutral')} ${e.caption}${e.sha256 ? html`<br><span class="tiny subtle mono-sm">sha256 ${e.sha256.slice(0, 12)}…</span>` : ''}`,
          when(e.captured_at),
          html`<span class="tiny">${e.captured_by_name}${e.attendance_ref ? ` · ${e.attendance_ref}` : ''}</span>`,
          e.stored_path ? html`<a class="btn small" href="/evidence/${String(e.id)}/file">Open file</a>` : html`<span class="tiny subtle">metadata only</span>`,
        ]),
        empty: 'No photos, certificates or documents recorded.',
      })}
      ${materials.length
        ? html`<h3 class="mt2 mb1">Materials used</h3>
            ${table({
              cols: ['Item', { label: 'Qty', num: true }, 'Source', 'Attendance', 'When'],
              rows: materials.map((m) => [html`${m.description}`, String(m.qty), chip(labelise(m.source), 'neutral'), m.attendance_ref, when(m.recorded_at)]),
            })}`
        : ''}
      ${reservations.length
        ? html`<h3 class="mt2 mb1">Stock reserved for this job</h3>
            ${table({
              cols: ['Reservation', 'Item', { label: 'Qty', num: true }, 'Location', 'Required by', 'State'],
              rows: reservations.map((r) => [
                html`<a href="/stock/items/${String(r.item_id)}">${r.ref}</a><br><span class="tiny subtle">${r.purpose}</span>`,
                html`${r.sku} ${r.item_name}`,
                String(r.qty_outstanding),
                r.location_code ?? '—',
                when(r.required_by, { dateOnly: true }),
                chip(labelise(r.status), r.status === 'active' ? 'info' : 'neutral'),
              ]),
            })}`
        : ''}
      ${holds.length
        ? html`<h3 class="mt2 mb1">Evidence-held material</h3>
            ${table({
              cols: ['Hold', 'Description', 'Deadline', 'Owner', 'State'],
              rows: holds.map((hld) => [html`<a href="/stock/holds/${String(hld.id)}">${hld.ref}</a>`, hld.description, hld.deadline ? fmtD(hld.deadline) : '—', hld.next_owner_name, chip(labelise(hld.status), hld.status === 'held' ? 'warn' : 'neutral')]),
            })}`
        : ''}
    `,
  });

  // --- commercial ------------------------------------------------------
  const commercialCard = card({
    title: 'Commercial and financial',
    body: html`
      ${defList([
        ['Operational', opChip(job.op_status)],
        ['Financial', finChip(job.financial_status)],
        ['Commercial / warranty', commChip(job.commercial_status)],
        ['From quotation', acceptanceOpp && acceptanceRev ? html`<a href="/quotes/${String(acceptanceOpp.id)}">${Q.quoteRef(acceptanceOpp, acceptanceRev)}</a> · accepted ${fmtMoney(acceptance!.accepted_net_pence)} net${acceptance!.po_number ? ` · PO ${acceptance!.po_number}` : ''}` : null],
      ])}
      ${variations.length
        ? html`<h3 class="mt2 mb1">Variations</h3>
            ${table({
              cols: ['Ref', 'Classification', 'Scope impact', { label: 'Value', num: true }, 'State'],
              rows: variations.map((v) => [v.ref, Q.VARIATION_LABEL[v.classification], html`<span class="tiny">${v.scope_impact}</span>`, fmtMoney(v.value_impact_pence), chip(labelise(v.status), v.status === 'approved' ? 'ok' : v.status === 'proposed' ? 'warn' : 'neutral')]),
            })}`
        : ''}
      <div class="mt2">
        ${canReqCtx(ctx, 'job.close.financial')
          ? drawer({
              summary: 'Set financial status',
              body: form({
                ctx,
                action: `/jobs/${id}/financial`,
                submit: 'Save financial status',
                body: html`${versionInput(job.version)}${select({ name: 'financial_status', label: 'Financial status', required: true, options: enumOptions(J.FINANCIAL_STATUSES, undefined, job.financial_status) })}
                  ${input({ name: 'reason', label: 'Reason / invoice reference', required: true })}<input type="hidden" name="__back" value="${backTo}">`,
              }),
            })
          : ''}
        ${canReqCtx(ctx, 'job.commercial')
          ? drawer({
              summary: 'Set commercial / warranty status',
              body: form({
                ctx,
                action: `/jobs/${id}/commercial`,
                submit: 'Save commercial status',
                body: html`${versionInput(job.version)}${select({ name: 'commercial_status', label: 'Commercial status', required: true, options: enumOptions(J.COMMERCIAL_STATUSES, undefined, job.commercial_status) })}
                  ${textarea({ name: 'reason', label: 'Reason', rows: 2, required: true })}<input type="hidden" name="__back" value="${backTo}">`,
              }),
            })
          : ''}
        ${canReqCtx(ctx, 'variation.create')
          ? drawer({
              summary: 'Raise a variation',
              body: form({
                ctx,
                action: '/variations',
                submit: 'Record variation',
                body: html`<input type="hidden" name="job_id" value="${String(id)}">${acceptance ? html`<input type="hidden" name="acceptance_id" value="${String(acceptance.id)}">` : ''}
                  ${select({ name: 'classification', label: 'Classification', required: true, options: enumOptions(Q.VARIATION_CLASSES, Q.VARIATION_LABEL) })}
                  ${textarea({ name: 'description', label: 'What changed', rows: 2, required: true })}
                  ${textarea({ name: 'scope_impact', label: 'Scope impact', rows: 2, required: true })}
                  <div class="fields cols2">${input({ name: 'value_impact', label: 'Value impact (£)', placeholder: '0.00' })}${input({ name: 'customer_ref', label: 'Customer reference' })}</div>
                  <input type="hidden" name="__back" value="${backTo}">`,
              }),
            })
          : ''}
      </div>
    `,
    definition: 'Operational completion, invoicing readiness and commercial/warranty resolution move independently — one flag would erase those distinctions.',
  });

  // --- closure ---------------------------------------------------------
  const closureCard = isOpen
    ? card({
        title: 'Close this job',
        body: html`
          ${blockers.length ? banner('warn', html`<ul style="margin:0 0 0 16px">${blockers.map((b) => html`<li>${b}</li>`)}</ul>`, 'Operational completion is blocked') : banner('ok', html`Nothing blocks operational completion. Financial and commercial closure stay separate.`)}
          <div class="mt2">
            ${canReqCtx(ctx, 'job.close.operational')
              ? drawer({
                  summary: 'Mark operationally complete',
                  body: form({
                    ctx,
                    action: `/jobs/${id}/complete`,
                    submit: 'Mark operationally complete',
                    confirm: 'Record this job as operationally complete?',
                    body: html`${versionInput(job.version)}${textarea({ name: 'reason', label: 'Basis for completion (what evidence you checked)', rows: 3, required: true })}<input type="hidden" name="__back" value="${backTo}">`,
                  }),
                })
              : ''}
            ${canReqCtx(ctx, 'job.cancel')
              ? drawer({
                  danger: true,
                  summary: 'Cancel this job',
                  body: form({
                    ctx,
                    action: `/jobs/${id}/cancel`,
                    submit: 'Cancel job',
                    submitClass: 'danger',
                    confirm: 'Cancel this job and any planned attendances?',
                    body: html`${versionInput(job.version)}${textarea({ name: 'reason', label: 'Why it is being cancelled', rows: 2, required: true })}<input type="hidden" name="__back" value="${backTo}">`,
                  }),
                })
              : ''}
          </div>
        `,
      })
    : html``;

  // --- notes, history --------------------------------------------------
  const notesCard = card({
    title: 'Notes and customer updates',
    body: html`
      ${canReqCtx(ctx, 'job.note')
        ? form({
            ctx,
            action: `/jobs/${id}/notes`,
            submit: 'Add note',
            body: html`${textarea({ name: 'body', label: 'Note', rows: 3, required: true })}
              ${select({ name: 'kind', label: 'Type', options: [{ value: 'note', label: 'Internal note' }, { value: 'customer_update', label: 'Customer update (what we told them)' }] })}
              <input type="hidden" name="__back" value="${backTo}">`,
          })
        : ''}
      <ul class="timeline mt2">
        ${notes.map(
          (n) => html`<li>
            <span class="when">${fmtDT(n.created_at)}</span>
            <span class="what">${chip(labelise(n.kind), n.kind === 'customer_update' ? 'info' : 'neutral')} ${n.ai_interaction_id ? chip('AI-assisted draft', 'info') : ''}<br>${prose(n.body)}<br><span class="tiny subtle">${n.author_name ?? 'system'}</span></span>
          </li>`,
        )}
      </ul>
      ${notes.length ? '' : empty('No notes yet')}
    `,
  });

  const historyCard = card({
    title: 'Decisions and history',
    body: html`
      <h3 class="mb1">Priority decisions</h3>
      ${table({
        cols: ['When', 'Change', 'Reason', 'Decided by'],
        rows: priorityHistory.map((p) => [when(p.decided_at), html`${p.from_priority ? html`${priorityChip(p.from_priority)} → ` : ''}${priorityChip(p.to_priority)}`, prose(p.reason), p.decided_by_name]),
      })}
      ${canReqCtx(ctx, 'job.priority') && isOpen
        ? drawer({
            summary: 'Change priority',
            body: form({
              ctx,
              action: `/jobs/${id}/priority`,
              submit: 'Change priority',
              body: html`${versionInput(job.version)}${select({ name: 'priority', label: 'New priority', required: true, options: enumOptions(J.PRIORITIES, J.PRIORITY_LABEL, job.priority) })}
                ${textarea({ name: 'reason', label: 'Reason (impact-based)', rows: 2, required: true })}<input type="hidden" name="__back" value="${backTo}">`,
            }),
          })
        : ''}
      ${canReqCtx(ctx, 'job.triage') && isOpen
        ? drawer({
            summary: 'Record triage outcome',
            body: form({
              ctx,
              action: `/jobs/${id}/triage`,
              submit: 'Save triage',
              body: html`${versionInput(job.version)}${textarea({ name: 'triage_notes', label: 'Triage outcome / next step', rows: 3, required: true, value: job.triage_notes ?? '' })}<input type="hidden" name="__back" value="${backTo}">`,
            }),
          })
        : ''}
      ${displacements.length
        ? html`<h3 class="mt2 mb1">Schedule changes</h3>
            ${table({
              cols: ['When', 'Attendance', 'Change', 'Reason', 'Customer told by', 'New owner'],
              rows: displacements.map((d) => [
                when(d.created_at),
                d.attendance_ref,
                html`${chip(labelise(d.change_type), 'warn')}<br><span class="tiny subtle">was ${fmtDT(d.previous_start)}${d.displacing_job_ref ? ` · displaced by ${d.displacing_job_ref}` : ''}</span>`,
                html`<span class="tiny">${d.reason}</span>`,
                html`${d.comms_owner_name}<br><span class="tiny subtle">${d.comms_note}</span>`,
                html`${d.new_owner_name}<br><span class="tiny subtle">${d.new_next_action}</span>`,
              ]),
            })}`
        : ''}
      ${canReqCtx(ctx, 'audit.read')
        ? drawer({
            summary: 'Audit trail',
            body: auditTable(auditFor(db, 'job', id)),
          })
        : ''}
    `,
  });

  return page(ctx, {
    title: `${job.ref} ${job.title}`,
    heading: `${job.ref} — ${job.title}`,
    headingChips,
    crumbs: [{ href: '/jobs', label: 'Service' }, { href: `/customers/${job.customer_id}`, label: job.customer_name ?? '' }, { label: job.ref }],
    sub: html`<a href="/sites/${String(job.site_id)}">${job.site_name}</a> · logged ${fmtDT(job.received_at)} (${relative(job.received_at)}) · coordinator ${job.coordinator_name ?? '—'}`,
    body: html`
      ${banners}
      ${interaction ? aiPanel(ctx, { interaction, jobId: id, back: backTo }) : ''}
      <div class="grid split">
        <div>${overview}${slaCard}${attendanceCard}${evidenceCard}${notesCard}${historyCard}</div>
        <div>${nextPanel}${readinessCard}${commercialCard}${closureCard}</div>
      </div>
    `,
  });
}

function attendanceBlock(ctx: Ctx, a: Sched.Attendance, db: RouteDeps['db']): SafeHtml {
  const readings = A.readingsFor(db, a.id);
  const stops = A.stopsFor(db, { attendanceId: a.id });
  const warnings = (() => {
    try {
      return JSON.parse(a.warnings ?? '[]') as string[];
    } catch {
      return [];
    }
  })();
  return card({
    title: `${a.ref} · ${a.engineer_name}`,
    actions: html`${chip(labelise(a.status), a.status === 'submitted' ? 'neutral' : a.status === 'cancelled' ? 'neutral' : 'ok')} ${a.commitment === 'customer_confirmed' ? chip('customer-confirmed', 'info') : chip('provisional', 'neutral')}`,
    body: html`
      ${defList([
        ['Planned', html`${fmtDT(a.planned_start)} – ${fmtT(a.planned_end)}`],
        ['Travel / arrival', html`${a.travel_started_at ? `travel ${fmtT(a.travel_started_at)}` : '—'} · ${a.arrived_at ? `on site ${fmtT(a.arrived_at)}` : 'not arrived'}${a.work_started_at ? ` · work ${fmtT(a.work_started_at)}` : ''}${a.submitted_at ? ` · submitted ${fmtDT(a.submitted_at)}` : ''}`],
        ['Instructions', prose(a.instructions)],
        warnings.length ? ['Overridden warnings', html`<span class="tiny">${warnings.join(' · ')}</span><br><span class="tiny subtle">Reason: ${a.override_reason ?? ''}</span>`] : ['', null],
        ['Outcome', a.outcome ? html`${chip(labelise(a.outcome), 'info')}${a.final_condition ? html` · left ${A.FINAL_CONDITION_LABEL[a.final_condition as keyof typeof A.FINAL_CONDITION_LABEL]}` : ''}` : html`<span class="subtle">not submitted</span>`],
        ['Authority used', a.authority_basis ? J.AUTHORITY_LABEL[a.authority_basis as keyof typeof J.AUTHORITY_LABEL] ?? a.authority_basis : null],
        ['Reported (confirmed)', prose(a.reported_confirmed)],
        ['Observed facts', prose(a.observed_facts)],
        ['Tests', prose(a.tests_performed)],
        ['Diagnosis', a.diagnosis ? html`${prose(a.diagnosis)} ${a.diagnosis_verified ? chip('verified', 'ok') : chip('hypothesis — not verified', 'warn')}` : null],
        ['Work done', prose(a.work_done)],
        ['Uncertainty', prose(a.uncertainty)],
        ['Recommendations', prose(a.recommendations)],
        ['Labour / travel', a.labour_minutes !== null ? `${a.labour_minutes} min labour${a.travel_minutes ? ` · ${a.travel_minutes} min travel` : ''}` : null],
        [
          'Customer acknowledgement',
          a.ack_name
            ? html`${a.ack_name}${a.ack_role ? ` (${a.ack_role})` : ''} at ${fmtDT(a.ack_at)}${a.ack_comment ? html`<br><span class="tiny">“${a.ack_comment}”</span>` : ''}<br><span class="tiny subtle">Acknowledges attendance and outcome only — not charges, warranty liability or closure.</span>`
            : a.ack_not_obtained_reason
              ? html`<span class="chip warn">not obtained</span> <span class="tiny">${a.ack_not_obtained_reason}</span>`
              : null,
        ],
        a.followon_required
          ? [
              'Handoff',
              html`<b>Required outcome:</b> ${a.handoff_required_outcome}<br><b>Dependency:</b> ${a.handoff_dependency ? J.WAITING_LABEL[a.handoff_dependency as keyof typeof J.WAITING_LABEL] : ''} — ${a.handoff_dependency_detail}<br>
                <b>Left:</b> ${a.handoff_operating_condition}${a.handoff_parts_specialist ? html`<br><b>Parts/specialist:</b> ${a.handoff_parts_specialist}` : ''}${a.handoff_promises ? html`<br><b>Promised:</b> ${a.handoff_promises}` : ''}${a.handoff_authority ? html`<br><b>Authority:</b> ${a.handoff_authority}` : ''}`,
            ]
          : ['', null],
        ['Cancelled', a.cancelled_reason],
      ])}
      ${readings.length ? html`<h4 class="mt2">Readings</h4>${table({ cols: ['Reading', 'Value', 'Equipment', 'When'], rows: readings.map((r) => [r.name, html`${r.value}${r.unit ?? ''}`, r.asset_ref ?? '—', when(r.recorded_at)]) })}` : ''}
      ${stops.length
        ? html`<h4 class="mt2">Stops / escalations</h4>${table({
            cols: ['Type', 'Detail', 'Raised', 'Resolution'],
            rows: stops.map((s) => [chip(labelise(s.kind), s.resolved_at ? 'neutral' : 'danger'), html`<span class="tiny">${s.detail}</span>`, html`<span class="tiny">${s.raised_by_name}<br>${fmtDT(s.raised_at)}</span>`, s.resolved_at ? html`<span class="tiny">${s.resolution}<br>${s.resolved_by_name}</span>` : chip('open', 'danger')]),
          })}`
        : ''}
      ${
        ['planned', 'dispatched'].includes(a.status) && canReqCtx(ctx, 'schedule.assign')
          ? html`<div class="btnrow mt2">
              ${a.status === 'planned' ? form({ ctx, action: `/attendances/${a.id}/dispatch`, body: html`<input type="hidden" name="__back" value="/jobs/${a.job_id}">`, submit: 'Dispatch to engineer', submitClass: 'accent' }) : ''}
              <a class="btn small" href="/schedule/assign?attendance=${String(a.id)}">Reschedule</a>
            </div>`
          : ''
      }
    `,
  });
}

export function auditTable(rows: ReturnType<typeof auditFor>): SafeHtml {
  return table({
    cols: [{ label: 'When', nowrap: true }, 'Who', 'Action', 'Reason', 'Before → after'],
    rows: rows.map((a) => [
      when(a.at),
      html`${a.actor_name ?? 'system'}<br><span class="tiny subtle">${a.actor_role ?? ''}</span>`,
      chip(labelise(a.action), 'neutral'),
      html`<span class="tiny">${a.reason ?? '—'}</span>`,
      html`<span class="tiny subtle mono-sm">${[a.before_json, a.after_json].filter(Boolean).join(' → ').slice(0, 260)}</span>`,
    ]),
    empty: 'No audit records.',
  });
}

function canReqCtx(ctx: Ctx, cap: Parameters<typeof can>[1]): boolean {
  return can(ctx.user, cap);
}

export default register;
