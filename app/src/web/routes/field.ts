import { html, raw, type SafeHtml } from '../../lib/html.ts';
import { addDays, clock, DAY, fmtD, fmtDT, fmtT, londonDate, londonDayStart, relative } from '../../lib/clock.ts';
import { ForbiddenError } from '../../lib/errors.ts';
import * as J from '../../domain/jobs.ts';
import * as A from '../../domain/attendance.ts';
import * as Sched from '../../domain/scheduling.ts';
import * as CRM from '../../domain/crm.ts';
import * as Inv from '../../domain/inventory.ts';
import {
  banner,
  card,
  checkbox,
  chip,
  csrfInput,
  type Ctx,
  defList,
  drawer,
  dtInput,
  empty,
  enumOptions,
  form,
  idemInput,
  input,
  labelise,
  options,
  page,
  priorityChip,
  prose,
  select,
  staffOptions,
  table,
  textarea,
  when,
} from '../ui.ts';
import { actorOf, back, ctxOf, h, intParam, ok, type RouteModule, send, strQuery } from '../kit.ts';
import { aiButtons, aiPanel, loadInteraction } from '../aipanel.ts';

const register: RouteModule = (app, deps) => {
  const { db } = deps;

  const requireEngineer = (req: Parameters<Parameters<typeof h>[0]>[0]) => {
    const user = actorOf(req);
    if (user.role !== 'engineer') throw new ForbiddenError('The field workflow is for engineers. Office users manage attendances from the job page.');
    return user;
  };

  // ---------------------------------------------------------------- My day (US-040)
  app.get(
    '/my-day',
    h((req, res) => {
      const user = requireEngineer(req);
      const ctx = ctxOf(req);
      const date = strQuery(req, 'date') ?? londonDate(clock.now());
      const from = londonDayStart(date);
      const to = londonDayStart(addDays(date, 1));
      const list = A.myAttendances(db, user.id, from, to);
      const upcoming = db
        .prepare(
          `SELECT a.id, a.ref, a.planned_start, a.commitment, j.ref AS job_ref, j.priority, s.name AS site_name FROM attendances a JOIN jobs j ON j.id = a.job_id JOIN sites s ON s.id = j.site_id
           WHERE a.engineer_user_id = ? AND a.status IN ('planned','dispatched') AND a.planned_start >= ? ORDER BY a.planned_start LIMIT 8`,
        )
        .all(user.id, to) as { id: number; ref: string; planned_start: string; commitment: string; job_ref: string; priority: string; site_name: string }[];
      const today = londonDate(clock.now()) === date;

      send(
        res,
        page(ctx, {
          title: 'My day',
          heading: today ? 'My day' : `My day — ${fmtD(from)}`,
          sub: `${list.length} visit${list.length === 1 ? '' : 's'}${today ? ' today' : ''}`,
          actions: html`<a class="btn" href="/my-day?date=${addDays(date, -1)}">‹</a><a class="btn" href="/my-day">Today</a><a class="btn" href="/my-day?date=${addDays(date, 1)}">›</a>`,
          body: html`
            ${list.length === 0 ? empty('Nothing booked', 'Anything the office dispatches will appear here.') : ''}
            <div class="fieldlist">
              ${list.map(
                (a) => html`<a class="jobcard ${raw((a.priority ?? '').toLowerCase())}" href="/attendances/${String(a.id)}">
                  <div class="top">
                    <span class="time">${fmtT(a.planned_start)}–${fmtT(a.planned_end)}</span>
                    ${priorityChip(a.priority ?? 'P3')}
                    ${chip(labelise(a.status), a.status === 'submitted' ? 'neutral' : a.status === 'planned' ? 'neutral' : 'ok')}
                    ${a.commitment === 'customer_confirmed' ? chip('customer confirmed', 'info') : ''}
                    ${a.open_stops ? chip('escalation open', 'danger') : ''}
                  </div>
                  <h3>${a.job_ref} — ${a.job_title}</h3>
                  <div class="where">${a.customer_name} · ${a.site_name}${a.site_postcode ? `, ${a.site_postcode}` : ''}</div>
                  ${a.safety_flag ? html`<div class="sym"><span class="chip danger">safety</span> ${a.safety_risk ?? ''}</div>` : ''}
                  ${a.induction_required ? html`<div class="sym"><span class="chip warn">induction required</span></div>` : ''}
                  ${a.reported_symptom ? html`<div class="sym">${a.reported_symptom.slice(0, 160)}</div>` : ''}
                </a>`,
              )}
            </div>
            ${
              upcoming.length
                ? card({
                    title: 'Coming up',
                    tight: true,
                    body: table({
                      cols: ['When', 'Job', 'Site', 'Commitment'],
                      rows: upcoming.map((u) => [
                        html`${fmtDT(u.planned_start)}<br><span class="tiny subtle">${relative(u.planned_start)}</span>`,
                        html`<a href="/attendances/${String(u.id)}">${u.job_ref}</a> ${priorityChip(u.priority)}`,
                        u.site_name,
                        u.commitment === 'customer_confirmed' ? chip('confirmed', 'info') : chip('provisional', 'neutral'),
                      ]),
                    }),
                  })
                : ''
            }
          `,
        }),
      );
    }),
  );

  // ---------------------------------------------------------------- job brief (read-only context)
  app.get(
    '/jobs/:id/brief',
    h((req, res) => {
      const user = actorOf(req);
      const ctx = ctxOf(req);
      const id = intParam(req);
      const job = J.getJob(db, id);
      if (user.role === 'engineer' && !CRM.engineerAssignedToSite(db, user.id, job.site_id)) throw new ForbiddenError('You are not assigned to this work.');
      const mine = db.prepare(`SELECT id FROM attendances WHERE job_id = ? AND engineer_user_id = ? AND status <> 'cancelled' ORDER BY planned_start DESC LIMIT 1`).get(id, user.id) as { id: number } | undefined;
      send(res, briefPage(deps, ctx, id, mine?.id));
    }),
  );

  // ---------------------------------------------------------------- attendance (the field flow)
  app.get(
    '/attendances/:id',
    h((req, res) => {
      const user = actorOf(req);
      const ctx = ctxOf(req);
      const id = intParam(req);
      const a = Sched.getAttendance(db, id);
      if (user.role !== 'engineer') return res.redirect(`/attendances/${id}/manage`);
      if (a.engineer_user_id !== user.id) throw new ForbiddenError('That visit is assigned to another engineer.');
      send(res, attendancePage(deps, ctx, a, strQuery(req, 'ai') ? Number(strQuery(req, 'ai')) : undefined));
    }),
  );

  const step = (name: 'travel' | 'arrive' | 'start_work', message: string) =>
    app.post(
      `/attendances/:id/${name.replace('_', '-')}`,
      h((req, res) => {
        const id = intParam(req);
        A.progressAttendance(db, actorOf(req), id, name);
        ok(res, `/attendances/${id}`, message);
      }),
    );
  step('travel', 'Travel started.');
  step('arrive', 'Arrival recorded — this is the attendance time for the SLA.');
  step('start_work', 'Work started.');

  app.post(
    '/attendances/:id/stop',
    h((req, res) => {
      const id = intParam(req);
      A.raiseStop(db, actorOf(req), id, req.body);
      ok(res, `/attendances/${id}`, 'Recorded and sent to the service desk. Do not continue until you have an answer.');
    }),
  );

  app.post(
    '/attendances/:id/readings',
    h((req, res) => {
      const id = intParam(req);
      A.addReading(db, actorOf(req), id, req.body);
      ok(res, `/attendances/${id}#evidence`, 'Reading recorded.');
    }),
  );

  app.post(
    '/attendances/:id/evidence',
    h((req, res) => {
      const id = intParam(req);
      A.addEvidence(db, actorOf(req), deps.uploadDir, id, req.body, req.file ?? undefined);
      ok(res, `/attendances/${id}#evidence`, 'Evidence saved.');
    }),
  );

  app.post(
    '/attendances/:id/materials',
    h((req, res) => {
      const id = intParam(req);
      if (String(req.body?.item_id ?? '')) Inv.issueToAttendance(db, actorOf(req), id, req.body);
      else A.addDirectMaterial(db, actorOf(req), id, req.body);
      ok(res, `/attendances/${id}#evidence`, 'Material recorded against this visit.');
    }),
  );

  app.post(
    '/attendances/:id/returns',
    h((req, res) => {
      const id = intParam(req);
      const a = Sched.getAttendance(db, id);
      Inv.bookReturn(db, actorOf(req), { ...req.body, job_id: String(a.job_id) });
      ok(res, `/attendances/${id}#evidence`, 'Booked back to your van as return-pending — the warehouse assesses it before it counts as available.');
    }),
  );

  app.post(
    '/attendances/:id/evidence-hold',
    h((req, res) => {
      const id = intParam(req);
      const a = Sched.getAttendance(db, id);
      const holdId = Inv.createEvidenceHold(db, actorOf(req), { ...req.body, job_id: String(a.job_id), attendance_id: String(id) });
      ok(res, `/attendances/${id}#evidence`, `Failed part held as evidence (${(db.prepare('SELECT ref FROM evidence_holds WHERE id = ?').get(holdId) as { ref: string }).ref}). Chain of custody started.`);
    }),
  );

  app.get(
    '/attendances/:id/submit',
    h((req, res) => {
      const user = requireEngineer(req);
      const ctx = ctxOf(req);
      const id = intParam(req);
      const a = Sched.getAttendance(db, id);
      if (a.engineer_user_id !== user.id) throw new ForbiddenError('That visit is assigned to another engineer.');
      send(res, submitPage(deps, ctx, a));
    }),
  );

  app.post(
    '/attendances/:id/submit',
    h((req, res) => {
      const id = intParam(req);
      const result = A.submitAttendance(db, actorOf(req), id, req.body);
      const a = Sched.getAttendance(db, id);
      ok(res, '/my-day', result.duplicate ? `${a.ref} was already submitted — nothing was duplicated.` : `${a.ref} submitted. The office has it; the job stays open until they review it.`);
    }),
  );
};

// ---------------------------------------------------------------- pages

function briefPage(deps: Parameters<RouteModule>[1], ctx: Ctx, jobId: number, attendanceId?: number): string {
  const { db } = deps;
  const job = J.getJob(db, jobId);
  const site = CRM.redactSite(db, ctx.user, CRM.getSite(db, job.site_id));
  const assets = J.jobAssets(db, jobId);
  const history = CRM.workHistory(db, { siteId: job.site_id }, 6);
  const reservations = Inv.reservationsFor(db, { jobId, active: true });
  const temps = A.temporaryRestorations(db, { jobId, open: true });
  const contacts = CRM.contactsFor(db, job.customer_id, job.site_id);

  return page(ctx, {
    title: `${job.ref} brief`,
    heading: `${job.ref} — ${job.title}`,
    headingChips: html`${priorityChip(job.priority)} ${chip(J.AUTHORITY_LABEL[job.authority_basis], job.authority_basis === 'not_established' ? 'warn' : 'ok')}`,
    crumbs: attendanceId ? [{ href: '/my-day', label: 'My day' }, { href: `/attendances/${attendanceId}`, label: 'Visit' }, { label: 'Brief' }] : [{ label: job.ref }],
    sub: html`${job.customer_name} · ${job.site_name}`,
    narrow: true,
    body: html`
      ${job.safety_flag ? banner('err', html`${job.safety_risk ?? ''}`, 'Safety / property risk reported') : ''}
      ${temps.map((t) => banner('warn', html`${t.change_made}<br><b>Limits:</b> ${t.limitations}<br><b>Residual risk:</b> ${t.residual_risk}`, 'This equipment is on a temporary repair'))}
      ${card({
        title: 'What we have been told',
        body: defList(
          [
            ['Reported', prose(job.reported_symptom)],
            ['Impact', prose(job.impact)],
            ['Triage notes', prose(job.triage_notes)],
            ['Reported by', job.reported_by_name],
          ],
          true,
        ),
      })}
      ${card({
        title: 'What you are authorised to do',
        body: html`${defList(
          [
            ['Authority basis', chip(J.AUTHORITY_LABEL[job.authority_basis], job.authority_basis === 'not_established' ? 'warn' : 'ok')],
            ['Reference', job.authority_ref],
            ['Limits / notes', prose(job.authority_notes)],
            ['Contract', job.contract_ref ? `${job.contract_ref} ${job.contract_name}` : 'No contract — nothing is covered by default'],
            ['Customer PO', job.customer_po],
          ],
          true,
        )}
        ${banner('info', 'Being on site is not authority to do more than this. If the job needs more, escalate from the visit screen before doing it.')}`,
      })}
      ${card({
        title: 'Access and site conditions',
        body: defList(
          [
            ['Address', html`${site.address}${site.town ? `, ${site.town}` : ''}${site.postcode ? `, ${site.postcode}` : ''}`],
            ['Opening hours', site.opening_hours],
            ['Parking / loading', site.parking_loading],
            ['Keys / security', prose(site.keys_security)],
            ['Induction / permits', html`${site.induction_required ? chip('required', 'warn') : ''} ${site.induction_permits ?? ''}`],
            ['Roof / plant access', site.roof_plant_access],
            ['Asbestos', site.asbestos_info],
            ['Safeguarding', site.safeguarding],
            ['Restrictions', site.work_restrictions],
            ['Site contacts', contacts.length ? html`${contacts.map((c) => html`${c.name} (${labelise(c.role_type)}) ${c.phone ?? ''}${c.can_authorise_spend ? ' · can authorise spend' : ''}<br>`)}` : null],
          ],
          true,
        ),
      })}
      ${card({
        title: 'Equipment and history',
        body: html`
          ${assets.length
            ? html`${assets.map(
                (a) => html`<div class="mb1"><b><a href="/assets/${String(a.id)}">${a.ref}</a> ${a.description}</b><br><span class="tiny subtle">${[a.manufacturer, a.model, a.serial ? `S/N ${a.serial}` : '', a.location_detail].filter(Boolean).join(' · ')}</span></div>`,
              )}`
            : html`<p class="subtle tiny">No specific equipment linked to this job.</p>`}
          <h4 class="mt2">Recent work at this site</h4>
          <ul class="timeline">
            ${history.map(
              (j) => html`<li>
                <span class="when">${fmtD(j.received_at)}</span>
                <span class="what"><b>${j.ref}</b> ${j.title}${j.attendances.map((a) => html`<br><span class="tiny">· ${a.engineer_name}: ${a.diagnosis ?? a.work_done ?? labelise(a.status)}${a.recommendations ? ` — recommended: ${a.recommendations}` : ''}</span>`)}</span>
              </li>`,
            )}
          </ul>
          ${history.length ? '' : html`<p class="subtle tiny">No previous work recorded here.</p>`}
        `,
      })}
      ${card({
        title: 'Expected parts and resources',
        body: html`${defList([['Expected', prose(job.expected_resources)], ['Competences', job.required_competences], ['Estimated time', job.estimated_minutes ? `${job.estimated_minutes} minutes` : null]], true)}
          ${reservations.length ? table({ cols: ['Reserved part', { label: 'Qty', num: true }, 'Where'], rows: reservations.map((r) => [`${r.sku} ${r.item_name}`, String(r.qty_outstanding), r.location_code ?? '—']) }) : html`<p class="subtle tiny">No parts reserved for this job.</p>`}`,
      })}
      ${attendanceId ? html`<div class="btnrow"><a class="btn primary" href="/attendances/${String(attendanceId)}">Back to the visit</a></div>` : ''}
    `,
  });
}

function attendancePage(deps: Parameters<RouteModule>[1], ctx: Ctx, a: Sched.Attendance, aiId?: number): string {
  const { db } = deps;
  const job = J.getJob(db, a.job_id);
  const site = CRM.redactSite(db, ctx.user, CRM.getSite(db, job.site_id));
  const stops = A.stopsFor(db, { attendanceId: a.id });
  const readings = A.readingsFor(db, a.id);
  const evidence = A.evidenceFor(db, { attendanceId: a.id });
  const materials = A.materialsFor(db, { attendanceId: a.id });
  const vanItems = vanStock(db, ctx.user.id);
  const items = Inv.items(db);
  const staff = J.staffOptions(db);
  const assets = J.jobAssets(db, a.job_id);
  const interaction = aiId ? loadInteraction(db, aiId, ctx.user.id) : null;
  const onSite = a.status === 'on_site' || a.status === 'working';
  const backTo = `/attendances/${a.id}`;

  const steps = html`<div class="stepbar">
    <span class="${raw(a.dispatched_at ? 'done' : '')}">Dispatched</span>
    <span class="${raw(a.travel_started_at ? 'done' : a.status === 'dispatched' ? 'now' : '')}">Travelling</span>
    <span class="${raw(a.arrived_at ? 'done' : a.status === 'travelling' ? 'now' : '')}">On site</span>
    <span class="${raw(a.work_started_at ? 'done' : a.status === 'on_site' ? 'now' : '')}">Working</span>
    <span class="${raw(a.submitted_at ? 'done' : onSite ? 'now' : '')}">Submitted</span>
  </div>`;

  const actions = a.status === 'submitted'
    ? banner('ok', html`Submitted ${fmtDT(a.submitted_at)}. The office reviews it — the job stays open until they decide.`, 'Done')
    : a.status === 'planned'
      ? banner('info', 'Not dispatched yet. The service desk releases it when it is ready — call them if you are already on your way.')
      : html`<div class="bigactions">
          ${a.status === 'dispatched' ? actionButton(ctx, `/attendances/${a.id}/travel`, 'Start travelling', 'primary') : ''}
          ${a.status === 'dispatched' || a.status === 'travelling' ? actionButton(ctx, `/attendances/${a.id}/arrive`, 'I have arrived', 'primary') : ''}
          ${a.status === 'on_site' ? actionButton(ctx, `/attendances/${a.id}/start-work`, 'Start work', 'primary') : ''}
          ${onSite ? html`<a class="btn accent" href="/attendances/${String(a.id)}/submit">Record outcome</a>` : ''}
        </div>`;

  return page(ctx, {
    title: `${a.ref} visit`,
    heading: `${job.ref} — ${job.title}`,
    headingChips: html`${priorityChip(job.priority)} ${chip(labelise(a.status), a.status === 'submitted' ? 'neutral' : 'ok')}`,
    crumbs: [{ href: '/my-day', label: 'My day' }, { label: a.ref }],
    sub: html`${fmtDT(a.planned_start)}–${fmtT(a.planned_end)} · ${job.customer_name} · ${site.name}${site.postcode ? `, ${site.postcode}` : ''}`,
    narrow: true,
    body: html`
      ${steps}
      ${job.safety_flag ? banner('err', html`${job.safety_risk ?? ''}`, 'Safety / property risk reported') : ''}
      ${site.induction_required ? banner('warn', html`${site.induction_permits ?? 'Induction or permit required before work.'}`, 'Induction / permit required') : ''}
      ${stops.filter((s) => !s.resolved_at).map((s) => banner('warn', html`${s.detail}${s.resolution ? html`<br><b>Office:</b> ${s.resolution}` : html`<br><span class="tiny">Waiting for the service desk to respond.</span>`}`, A.STOP_LABEL[s.kind]))}
      ${stops.filter((s) => s.resolved_at).map((s) => banner('ok', html`<b>${A.STOP_LABEL[s.kind]}:</b> ${s.detail}<br><b>Office decision:</b> ${s.resolution}`, 'Escalation answered'))}
      ${interaction ? aiPanel(ctx, { interaction, jobId: a.job_id, back: backTo }) : ''}
      ${actions}
      ${card({
        title: 'Before you start',
        actions: html`<a class="btn small" href="/jobs/${String(a.job_id)}/brief">Full brief</a>`,
        body: defList(
          [
            ['Reported', prose(job.reported_symptom)],
            ['Authorised', html`${chip(J.AUTHORITY_LABEL[job.authority_basis], job.authority_basis === 'not_established' ? 'warn' : 'ok')} ${job.authority_notes ?? ''}`],
            ['Instructions', prose(a.instructions)],
            ['Access', prose([site.parking_loading, site.keys_security].filter(Boolean).join(' · '))],
            ['Equipment', assets.length ? html`${assets.map((x) => html`${x.ref} ${x.description}<br>`)}` : null],
          ],
          true,
        ),
      })}
      ${
        a.status !== 'submitted' && a.status !== 'planned'
          ? card({
              title: 'Stop or escalate',
              body: html`<p class="tiny subtle">Anyone may stop work they reasonably believe is unsafe or outside their competence. Customer urgency does not override that.</p>
                ${form({
                  ctx,
                  action: `/attendances/${a.id}/stop`,
                  submit: 'Send to the service desk',
                  submitClass: 'danger',
                  body: html`${select({ name: 'kind', label: 'What is wrong', required: true, options: enumOptions(A.STOP_KINDS, A.STOP_LABEL) })}
                    ${textarea({ name: 'detail', label: 'What you have found', rows: 3, required: true })}
                    ${textarea({ name: 'safety_condition', label: 'Condition you are leaving things in', rows: 2 })}
                    <input type="hidden" name="__back" value="${backTo}">`,
                })}`,
            })
          : ''
      }
      ${
        onSite
          ? card({
              id: 'evidence',
              title: 'Record as you go',
              body: html`
                ${drawer({
                  summary: 'Add a photo, certificate or document',
                  body: html`<form method="post" action="/attendances/${String(a.id)}/evidence" enctype="multipart/form-data" class="stack">
                    ${csrfInput(ctx)}
                    ${select({ name: 'kind', label: 'Type', required: true, options: enumOptions(A.EVIDENCE_KINDS) })}
                    ${input({ name: 'caption', label: 'Caption', required: true, placeholder: 'What it shows' })}
                    <div class="field"><label for="f_file">File (optional)</label><input id="f_file" type="file" name="file" accept="image/*,application/pdf,text/plain" capture="environment"><span class="hint">Photos up to 12 MB. Without a file the caption is still recorded as evidence metadata.</span></div>
                    <input type="hidden" name="__back" value="${backTo}">
                    <div class="btnrow"><button class="btn primary" type="submit">Save evidence</button></div>
                  </form>`,
                })}
                ${drawer({
                  summary: 'Record a reading',
                  body: form({
                    ctx,
                    action: `/attendances/${a.id}/readings`,
                    submit: 'Save reading',
                    body: html`<div class="fields cols2">
                        ${input({ name: 'name', label: 'Reading', required: true, placeholder: 'e.g. Suction pressure' })}
                        ${input({ name: 'value', label: 'Value', required: true })}
                        ${input({ name: 'unit', label: 'Unit', placeholder: 'bar g, °C, A' })}
                        ${select({ name: 'asset_id', label: 'Equipment', blank: 'Not specific', options: options(assets.map((x) => ({ id: x.id, label: `${x.ref} ${x.description}` }))) })}
                      </div>
                      <input type="hidden" name="__back" value="${backTo}">`,
                  }),
                })}
                ${drawer({
                  summary: 'Use a part',
                  body: html`<p class="tiny subtle">Van stock first — it comes off your van and onto this job. If it is not stock, record it as purchased or customer supplied.</p>
                    ${form({
                      ctx,
                      action: `/attendances/${a.id}/materials`,
                      submit: 'Record part used',
                      body: html`${select({
                          name: 'item_id',
                          label: 'From your van',
                          blank: 'Not from van stock',
                          options: vanItems.map((v) => ({ value: v.item_id, label: `${v.sku} ${v.name} — ${v.qty} ${v.state === 'reserved' ? 'reserved for a job' : 'available'}` })),
                        })}
                        <div class="fields cols2">${input({ name: 'qty', label: 'Quantity', type: 'number', min: 1, value: 1, required: true })}${input({ name: 'serial_batch', label: 'Serial / batch' })}</div>
                        <hr>
                        ${input({ name: 'description', label: 'Or describe a non-stock material', placeholder: 'e.g. 2m flexible duct bought at merchants' })}
                        ${select({ name: 'source', label: 'Source (non-stock only)', options: enumOptions(['purchased_direct', 'customer_supplied', 'other']) })}
                        ${idemInput()}
                        <input type="hidden" name="__back" value="${backTo}">`,
                    })}`,
                })}
                ${drawer({
                  summary: 'Return a part to your van',
                  body: form({
                    ctx,
                    action: `/attendances/${a.id}/returns`,
                    submit: 'Book return',
                    body: html`<p class="tiny subtle">Returns are assessed by the warehouse before they count as available again.</p>
                      ${select({ name: 'item_id', label: 'Item', required: true, options: options(items.map((i) => ({ id: i.id, label: `${i.sku} ${i.name}` }))) })}
                      <div class="fields cols2">${input({ name: 'qty', label: 'Quantity', type: 'number', min: 1, value: 1, required: true })}${input({ name: 'location_id', label: '', type: 'hidden', value: String(vanLocation(db, ctx.user.id) ?? '') })}</div>
                      ${textarea({ name: 'note', label: 'Why it is coming back / condition', rows: 2, required: true })}
                      ${checkbox({ name: 'customer_owned', label: 'This is customer-owned material' })}
                      ${idemInput()}
                      <input type="hidden" name="__back" value="${backTo}">`,
                  }),
                })}
                ${drawer({
                  summary: 'Hold a failed part as evidence (warranty)',
                  body: form({
                    ctx,
                    action: `/attendances/${a.id}/evidence-hold`,
                    submit: 'Start chain of custody',
                    body: html`<p class="tiny subtle">Keep failed parts intact — do not strip or scrap them until someone authorises it.</p>
                      ${input({ name: 'description', label: 'What the part is', required: true, placeholder: 'e.g. Daikin outdoor PCB, burn mark at SMPS' })}
                      ${select({ name: 'asset_id', label: 'Removed from', blank: 'Not specific', options: options(assets.map((x) => ({ id: x.id, label: `${x.ref} ${x.description}` }))) })}
                      ${textarea({ name: 'failure_evidence', label: 'Evidence of failure', rows: 2, required: true })}
                      ${textarea({ name: 'tests_photos', label: 'Tests / photos taken', rows: 2 })}
                      ${input({ name: 'condition_packaging', label: 'Condition and packaging', required: true, placeholder: 'e.g. Bagged, labelled with job and serial' })}
                      ${input({ name: 'next_action', label: 'Next action', required: true, value: 'Return to depot and log warranty claim' })}
                      ${select({ name: 'next_owner_user_id', label: 'Who owns that next action', required: true, options: staffOptions(staff, staff.find((s) => s.role === 'warehouse')?.id ?? null) })}
                      <input type="hidden" name="storage_location_id" value="${String(vanLocation(db, ctx.user.id) ?? '')}">
                      <input type="hidden" name="__back" value="${backTo}">`,
                  }),
                })}
              `,
            })
          : ''
      }
      ${
        readings.length || evidence.length || materials.length
          ? card({
              title: 'Recorded on this visit',
              tight: true,
              body: html`
                ${readings.length ? table({ cols: ['Reading', 'Value', 'When'], rows: readings.map((r) => [r.name, html`<b>${r.value}${r.unit ?? ''}</b>`, when(r.recorded_at)]) }) : ''}
                ${evidence.length ? table({ cols: ['Evidence', 'Type', 'When'], rows: evidence.map((e) => [e.stored_path ? html`<a href="/evidence/${String(e.id)}/file">${e.caption}</a>` : html`${e.caption}`, chip(labelise(e.kind), 'neutral'), when(e.captured_at)]) }) : ''}
                ${materials.length ? table({ cols: ['Material', { label: 'Qty', num: true }, 'Source'], rows: materials.map((m) => [m.description, String(m.qty), chip(labelise(m.source), 'neutral')]) }) : ''}
              `,
            })
          : ''
      }
      ${a.status === 'submitted' ? submittedSummary(a) : ''}
      <div class="btnrow mt2">${aiButtons(ctx, { entity: 'attendance', id: a.id, tasks: ['summarise_history'], back: backTo })}</div>
    `,
  });
}

function submittedSummary(a: Sched.Attendance): SafeHtml {
  return card({
    title: 'What you submitted',
    body: defList(
      [
        ['Outcome', a.outcome ? chip(labelise(a.outcome), 'info') : null],
        ['Observed', prose(a.observed_facts)],
        ['Diagnosis', a.diagnosis ? html`${a.diagnosis} ${a.diagnosis_verified ? chip('verified', 'ok') : chip('not verified', 'warn')}` : null],
        ['Work done', prose(a.work_done)],
        ['Left', a.final_condition ? A.FINAL_CONDITION_LABEL[a.final_condition as keyof typeof A.FINAL_CONDITION_LABEL] : null],
        ['Follow-on', a.followon_required ? html`${a.handoff_required_outcome}<br><span class="tiny subtle">${a.handoff_dependency_detail ?? ''}</span>` : 'none'],
        ['Acknowledged by', a.ack_name ?? a.ack_not_obtained_reason],
      ],
      true,
    ),
  });
}

function submitPage(deps: Parameters<RouteModule>[1], ctx: Ctx, a: Sched.Attendance): string {
  const { db } = deps;
  const job = J.getJob(db, a.job_id);
  const codes = A.outcomeCodes(db);
  const staff = J.staffOptions(db);
  const followonCodes = codes.filter((c) => c.requires_followon || c.temporary).map((c) => c.code);
  const tempCodes = codes.filter((c) => c.temporary).map((c) => c.code);

  return page(ctx, {
    title: `Record outcome — ${a.ref}`,
    heading: 'Record what happened',
    crumbs: [{ href: '/my-day', label: 'My day' }, { href: `/attendances/${a.id}`, label: a.ref }, { label: 'Outcome' }],
    sub: html`${job.ref} — ${job.title} · ${a.site_name}`,
    narrow: true,
    body: html`
      ${banner('info', 'Record what you actually found and did. Submitting this does not close the job — the office reviews it and decides.')}
      ${form({
        ctx,
        action: `/attendances/${a.id}/submit`,
        submit: 'Submit outcome',
        submitClass: 'accent',
        body: html`
          <input type="hidden" name="submit_key" value="${a.id}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}">
          ${card({
            title: 'Outcome',
            body: html`<div class="fields">
              ${select({ name: 'outcome', label: 'Honest outcome of this visit', required: true, options: codes.map((c) => ({ value: c.code, label: c.label })) })}
              ${select({ name: 'authority_basis', label: 'Authority you worked under', required: true, options: enumOptions(J.AUTHORITY_BASES, J.AUTHORITY_LABEL, job.authority_basis) })}
              ${select({ name: 'final_condition', label: 'Condition you left it in', required: true, options: enumOptions(A.FINAL_CONDITIONS, A.FINAL_CONDITION_LABEL) })}
            </div>`,
          })}
          ${card({
            title: 'What you found and did',
            body: html`<div class="fields">
              ${textarea({ name: 'reported_confirmed', label: 'Reported symptom — confirmed or not', rows: 2, placeholder: 'Did you see what was reported?' })}
              ${textarea({ name: 'observed_facts', label: 'Observed facts', rows: 3, required: true, placeholder: 'What you actually saw and measured' })}
              ${textarea({ name: 'tests_performed', label: 'Tests performed', rows: 2 })}
              ${textarea({ name: 'diagnosis', label: 'Diagnosis', rows: 2, placeholder: 'Your conclusion about the cause' })}
              ${checkbox({ name: 'diagnosis_verified', label: 'Diagnosis verified (proven, not a hypothesis)', hint: 'Leave unticked if it is still a best guess — the office will not present it as confirmed.' })}
              ${textarea({ name: 'work_done', label: 'Work carried out', rows: 3, placeholder: 'What you changed. Write "none" if nothing.' })}
              ${textarea({ name: 'safety_notes', label: 'Safety notes', rows: 2 })}
              ${textarea({ name: 'uncertainty', label: 'Anything you are unsure about', rows: 2 })}
              ${textarea({ name: 'recommendations', label: 'Recommendations', rows: 2, placeholder: 'What should happen next, technically' })}
              <div class="fields cols2">
                ${input({ name: 'labour_minutes', label: 'Labour time (minutes)', type: 'number', min: 0, max: 1440, required: true, value: a.work_started_at ? Math.max(15, Math.round((Date.now() - new Date(a.work_started_at).getTime()) / 60000)) : 60 })}
                ${input({ name: 'travel_minutes', label: 'Travel time (minutes)', type: 'number', min: 0, max: 1440, value: a.travel_started_at && a.arrived_at ? Math.round((new Date(a.arrived_at).getTime() - new Date(a.travel_started_at).getTime()) / 60000) : '' })}
              </div>
            </div>`,
          })}
          <div data-show-when="outcome:${raw(tempCodes.join('|'))}" hidden>
            ${card({
              title: 'Temporary restoration',
              body: html`<p class="tiny subtle">A temporary repair is a future obligation, not “fixed”. All of this is required.</p>
                <div class="fields">
                  ${textarea({ name: 'temp_change_made', label: 'What you changed', rows: 2 })}
                  ${textarea({ name: 'temp_reason', label: 'Why it is temporary', rows: 2 })}
                  ${input({ name: 'temp_service_restored', label: 'Service restored' })}
                  ${textarea({ name: 'temp_limitations', label: 'Limitations', rows: 2 })}
                  ${textarea({ name: 'temp_residual_risk', label: 'Residual risk', rows: 2 })}
                  ${input({ name: 'temp_monitoring', label: 'Monitoring the customer should do' })}
                  ${dtInput({ name: 'temp_review_at', label: 'Review / expiry', iso: new Date(clock.now().getTime() + 7 * DAY).toISOString() })}
                  ${input({ name: 'temp_customer_understanding', label: 'What the customer understands' })}
                  ${input({ name: 'temp_approver', label: 'Who approved the temporary measure' })}
                  ${select({ name: 'temp_permanent_owner_user_id', label: 'Who owns the permanent fix', blank: '—', options: staffOptions(staff, job.coordinator_user_id ?? null) })}
                </div>`,
            })}
          </div>
          <div data-show-when="outcome:${raw(followonCodes.join('|'))}" hidden>
            ${card({
              title: 'Handoff — what the next person needs',
              body: html`<div class="fields">
                ${input({ name: 'handoff_required_outcome', label: 'Required outcome to finish the job' })}
                ${select({ name: 'handoff_dependency', label: 'Exact dependency', options: enumOptions(J.WAITING_CATEGORIES, J.WAITING_LABEL) })}
                ${textarea({ name: 'handoff_dependency_detail', label: 'Detail of that dependency', rows: 2 })}
                ${textarea({ name: 'handoff_operating_condition', label: 'Safety / operating condition you left', rows: 2 })}
                ${input({ name: 'handoff_parts_specialist', label: 'Parts or specialist needed' })}
                ${textarea({ name: 'handoff_promises', label: 'What you promised the customer', rows: 2 })}
                ${input({ name: 'handoff_authority', label: 'Authority needed / already given' })}
                <div class="fields cols2">
                  ${select({ name: 'handoff_urgency', label: 'Urgency', options: enumOptions(J.PRIORITIES, J.PRIORITY_LABEL, job.priority) })}
                  ${select({ name: 'handoff_next_owner_user_id', label: 'Recommended next owner', blank: '—', options: staffOptions(staff, job.coordinator_user_id ?? null) })}
                </div>
                ${dtInput({ name: 'handoff_review_at', label: 'Review / chase by', iso: new Date(clock.now().getTime() + DAY).toISOString() })}
              </div>`,
            })}
          </div>
          ${card({
            title: 'Customer acknowledgement',
            body: html`<p class="tiny subtle">This acknowledges the attendance and what you found. It is not approval of charges, warranty liability, design, or closure of the job.</p>
              <div class="fields cols2">
                ${input({ name: 'ack_name', label: 'Name of person acknowledging' })}
                ${input({ name: 'ack_role', label: 'Their role' })}
                ${textarea({ name: 'ack_comment', label: 'Anything they said', rows: 2, span: true })}
                ${input({ name: 'ack_not_obtained_reason', label: 'If nobody acknowledged, why', span: true })}
              </div>`,
          })}
          <input type="hidden" name="__back" value="/attendances/${String(a.id)}/submit">
        `,
      })}
    `,
  });
}

function actionButton(ctx: Ctx, action: string, label: string, cls: string): SafeHtml {
  return html`<form method="post" action="${action}">${csrfInput(ctx)}<button class="btn ${raw(cls)} block" type="submit">${label}</button></form>`;
}

function vanLocation(db: Parameters<RouteModule>[1]['db'], userId: number): number | null {
  return (db.prepare('SELECT van_location_id FROM users WHERE id = ?').get(userId) as { van_location_id: number | null } | undefined)?.van_location_id ?? null;
}

function vanStock(db: Parameters<RouteModule>[1]['db'], userId: number) {
  const loc = vanLocation(db, userId);
  if (!loc) return [];
  return db
    .prepare(
      `SELECT b.item_id, b.state, b.qty, i.sku, i.name FROM stock_balances b JOIN stock_items i ON i.id = b.item_id
       WHERE b.location_id = ? AND b.qty > 0 AND b.state IN ('available','reserved') AND b.owner_type = 'frostline' ORDER BY i.name`,
    )
    .all(loc) as { item_id: number; state: string; qty: number; sku: string; name: string }[];
}

export default register;
