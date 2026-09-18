import { html, raw, type SafeHtml } from '../../lib/html.ts';
import { addDays, clock, fmtD, fmtDT, fmtT, fromLocalInput, londonDate, londonDayStart, MIN, relative, toLocalInput } from '../../lib/clock.ts';
import { DomainError } from '../../lib/errors.ts';
import * as J from '../../domain/jobs.ts';
import * as Sched from '../../domain/scheduling.ts';
import * as CRM from '../../domain/crm.ts';
import * as Inv from '../../domain/inventory.ts';
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
  input,
  labelise,
  opChip,
  page,
  priorityChip,
  prose,
  select,
  staffOptions,
  table,
  textarea,
  versionInput,
} from '../ui.ts';
import { actorOf, back, canReq, ctxOf, h, intParam, intQuery, needCap, ok, type RouteModule, send, strQuery } from '../kit.ts';

const DAY_START_HOUR = 6;
const DAY_END_HOUR = 20;

const register: RouteModule = (app, { db }) => {
  // ---------------------------------------------------------------- board
  app.get(
    '/schedule',
    h((req, res) => {
      needCap(req, 'schedule.read');
      const ctx = ctxOf(req);
      const view = strQuery(req, 'view') === 'week' ? 'week' : 'day';
      const date = strQuery(req, 'date') ?? londonDate(clock.now());
      const days = view === 'week' ? 7 : 1;
      const from = date;
      const to = addDays(date, days);
      const engineers = Sched.engineers(db);
      const attendances = Sched.boardAttendances(db, from, to);
      const ready = Sched.readyUnscheduled(db);
      const notReady = Sched.notReadyOpen(db);

      const byEngineer = new Map<number, typeof attendances>();
      for (const a of attendances) {
        if (!byEngineer.has(a.engineer_user_id)) byEngineer.set(a.engineer_user_id, []);
        byEngineer.get(a.engineer_user_id)!.push(a);
      }

      const board = view === 'day' ? dayBoard(engineers, byEngineer, date) : weekBoard(engineers, byEngineer, date);

      send(
        res,
        page(ctx, {
          title: 'Schedule',
          heading: 'Schedule',
          sub: 'Where everybody is, what is committed to the customer, and what is ready to book.',
          actions: html`<a class="btn" href="/schedule?view=${view}&date=${addDays(date, -days)}">‹ ${view === 'week' ? 'Previous week' : 'Previous day'}</a>
            <a class="btn" href="/schedule?view=${view}&date=${londonDate(clock.now())}">Today</a>
            <a class="btn" href="/schedule?view=${view}&date=${addDays(date, days)}">${view === 'week' ? 'Next week' : 'Next day'} ›</a>
            <a class="btn ${raw(view === 'day' ? 'primary' : '')}" href="/schedule?view=day&date=${date}">Day</a>
            <a class="btn ${raw(view === 'week' ? 'primary' : '')}" href="/schedule?view=week&date=${date}">Week</a>`,
          body: html`
            ${card({
              title: view === 'day' ? `Day board — ${fmtD(londonDayStart(date))}` : `Week board — from ${fmtD(londonDayStart(date))}`,
              tight: true,
              body: html`${board}
                <div class="boardlegend">
                  <span><span class="chip">striped</span> provisional diary entry</span>
                  <span><span class="chip ok">solid</span> customer-confirmed commitment</span>
                  <span><span class="chip p1">P1</span> / <span class="chip p2">P2</span> urgent</span>
                  <span>faded = submitted</span>
                </div>`,
            })}
            <div class="grid cols2">
              ${card({
                id: 'ready',
                title: `Ready but unscheduled (${ready.length})`,
                tight: true,
                body: table({
                  cols: ['Job', 'P', 'Site', 'Needs', { label: 'Waiting', nowrap: true }, ''],
                  rows: ready.map((j) => [
                    html`<a class="rowtitle" href="/jobs/${String(j.id)}">${j.ref}</a><br><span class="tiny subtle">${j.title}</span>`,
                    priorityChip(j.priority),
                    html`${j.site_name}<br><span class="tiny subtle">${j.site_postcode ?? ''} ${j.site_area ?? ''}</span>`,
                    html`<span class="tiny">${j.required_competences ?? 'no competence recorded'}${j.estimated_minutes ? ` · ${j.estimated_minutes}m` : ''}</span>`,
                    html`<span class="tiny">${relative(j.received_at)}</span>`,
                    canReq(req, 'schedule.assign') ? html`<a class="btn small primary" href="/schedule/assign?job=${String(j.id)}">Assign</a>` : '',
                  ]),
                  empty: 'Nothing is ready and waiting for a slot.',
                }),
                definition: 'Jobs whose authority and readiness checklist are confirmed, with no planned attendance.',
              })}
              ${card({
                title: `Not yet ready (${notReady.length})`,
                tight: true,
                body: table({
                  cols: ['Job', 'P', 'Site', 'Outstanding', 'State'],
                  rows: notReady.slice(0, 15).map((j) => [
                    html`<a class="rowtitle" href="/jobs/${String(j.id)}">${j.ref}</a><br><span class="tiny subtle">${j.title}</span>`,
                    priorityChip(j.priority),
                    html`<span class="tiny">${j.site_name}</span>`,
                    html`<span class="tiny">${J.unmetReadiness(j).join(', ') || '—'}</span>`,
                    opChip(j.op_status),
                  ]),
                  empty: 'Everything open is ready.',
                }),
                definition: 'Open work that is not schedulable yet: scope, authority, access, competence, parts or another dependency is still outstanding.',
              })}
            </div>
          `,
        }),
      );
    }),
  );

  // ---------------------------------------------------------------- assignment drawer (US-030)
  app.get(
    '/schedule/assign',
    h((req, res) => {
      needCap(req, 'schedule.assign');
      const ctx = ctxOf(req);
      const attendanceId = intQuery(req, 'attendance');
      const existing = attendanceId ? Sched.getAttendance(db, attendanceId) : null;
      const jobId = existing ? existing.job_id : intQuery(req, 'job');
      if (!jobId) throw new DomainError('Choose a job to schedule.');
      const job = J.getJob(db, jobId);
      const site = CRM.redactSite(db, ctx.user, CRM.getSite(db, job.site_id));
      const engineers = Sched.engineers(db);
      const staff = J.staffOptions(db);

      const defaultStart = existing ? existing.planned_start : nextSlot();
      const startIso = strQuery(req, 'start') ? isoFromLocal(strQuery(req, 'start')!) : defaultStart;
      const duration = intQuery(req, 'duration') ?? (existing ? Math.round((new Date(existing.planned_end).getTime() - new Date(existing.planned_start).getTime()) / MIN) : (job.estimated_minutes ?? 120));
      const endIso = new Date(new Date(startIso).getTime() + duration * MIN).toISOString();
      const chosen = intQuery(req, 'engineer') ?? existing?.engineer_user_id;

      const signalsByEngineer = engineers.map((e) => ({ engineer: e, signals: Sched.assignmentSignals(db, job, e.id, startIso, endIso, existing?.id) }));
      const chosenSignals = chosen ? signalsByEngineer.find((s) => s.engineer.id === chosen)?.signals ?? [] : [];
      const warnings = chosenSignals.filter((s) => s.level === 'warn');
      const overlaps = chosen ? Sched.overlappingAttendances(db, chosen, startIso, endIso, existing?.id) : [];
      const reservations = Inv.reservationsFor(db, { jobId, active: true });

      send(
        res,
        page(ctx, {
          title: existing ? `Reschedule ${existing.ref}` : `Assign ${job.ref}`,
          heading: existing ? `Reschedule ${existing.ref}` : `Assign an engineer — ${job.ref}`,
          headingChips: html`${priorityChip(job.priority)} ${opChip(job.op_status)}`,
          crumbs: [{ href: '/schedule', label: 'Schedule' }, { href: `/jobs/${jobId}`, label: job.ref }, { label: existing ? 'Reschedule' : 'Assign' }],
          sub: html`${job.title} · <a href="/sites/${String(job.site_id)}">${job.site_name}</a>${site.postcode ? `, ${site.postcode}` : ''}`,
          body: html`
            <div class="grid split">
              <div>
                ${card({
                  title: 'Choose the slot, then compare engineers',
                  body: html`<form class="filters" method="get" action="/schedule/assign">
                    ${existing ? html`<input type="hidden" name="attendance" value="${String(existing.id)}">` : html`<input type="hidden" name="job" value="${String(jobId)}">`}
                    ${chosen ? html`<input type="hidden" name="engineer" value="${String(chosen)}">` : ''}
                    ${dtInput({ name: 'start', label: 'Start', iso: startIso })}
                    ${input({ name: 'duration', label: 'Minutes on site', type: 'number', min: 30, max: 1440, step: '15', value: duration })}
                    <button class="btn" type="submit">Recheck signals</button>
                  </form>`,
                })}
                ${card({
                  title: 'Engineer signals for this slot',
                  tight: true,
                  body: table({
                    cols: ['Engineer', 'Competence / clearance', 'Commitments that day', 'Signals', ''],
                    rows: signalsByEngineer.map(({ engineer, signals }) => {
                      const warn = signals.filter((s) => s.level === 'warn');
                      const info = signals.filter((s) => s.level !== 'warn');
                      return [
                        html`<b>${engineer.display_name}</b><br><span class="tiny subtle">${engineer.home_area ?? '—'}</span>`,
                        html`<span class="tiny">${Sched.competencesFor(db, engineer.id).map((c) => c.tag).join(', ') || 'none recorded'}</span>`,
                        html`<span class="tiny">${info.find((s) => s.code === 'booked')?.text ?? '—'}</span>`,
                        html`${warn.length ? html`<div class="chips">${warn.map((w) => chip(w.text, 'warn'))}</div>` : chip('no warnings', 'ok')}
                          ${info.filter((s) => s.code !== 'booked').length ? html`<div class="tiny subtle mt1">${info.filter((s) => s.code !== 'booked').map((s) => s.text).join(' · ')}</div>` : ''}`,
                        html`<a class="btn small ${raw(chosen === engineer.id ? 'primary' : '')}" href="/schedule/assign?${raw(existing ? `attendance=${existing.id}` : `job=${jobId}`)}&engineer=${String(engineer.id)}&start=${encodeURIComponent(toLocalInput(startIso))}&duration=${String(duration)}">${chosen === engineer.id ? 'Selected' : 'Select'}</a>`,
                      ];
                    }),
                  }),
                  definition:
                    'Signals come from recorded planning data — competences and their validity, site clearances, existing commitments, working-time guide, home area and job readiness. They are warnings, not rules; overriding one is recorded with your reason.',
                })}
                ${
                  chosen
                    ? card({
                        title: existing ? 'Confirm the new slot' : 'Confirm the assignment',
                        body: html`
                          ${warnings.length ? banner('warn', html`<ul style="margin:0 0 0 16px">${warnings.map((w) => html`<li>${w.text}</li>`)}</ul>`, 'These warnings need an acknowledged override') : banner('ok', 'No planning warnings for this engineer and slot.')}
                          ${overlaps.length ? banner('err', html`Overlaps ${overlaps.map((o) => html`<b>${o.ref}</b> (${o.job_ref}, ${fmtT(o.planned_start)}–${fmtT(o.planned_end)}${o.commitment === 'customer_confirmed' ? ', customer-confirmed' : ''}) `)}. Displace it below, or pick another time.`, 'Diary clash') : ''}
                          ${form({
                            ctx,
                            action: existing ? `/attendances/${existing.id}/reschedule` : `/jobs/${jobId}/attendances`,
                            submit: existing ? 'Move this attendance' : 'Assign engineer',
                            body: html`
                              <input type="hidden" name="engineer_user_id" value="${String(chosen)}">
                              <input type="hidden" name="planned_start" value="${toLocalInput(startIso)}">
                              <input type="hidden" name="planned_end" value="${toLocalInput(endIso)}">
                              ${existing ? versionInput(existing.version) : ''}
                              <div class="fields cols2">
                                ${select({ name: 'commitment', label: 'Commitment', options: enumOptions(Sched.COMMITMENTS, { provisional: 'Provisional diary entry', customer_confirmed: 'Customer-confirmed appointment' }, existing?.commitment ?? 'provisional'), hint: 'Only mark as confirmed once the customer has been told and agreed.' })}
                                ${input({ name: 'reason', label: existing ? 'Reason for the move' : 'Note', required: !!existing, value: '' })}
                              </div>
                              ${textarea({ name: 'instructions', label: 'Instructions for the engineer', rows: 2, value: existing?.instructions ?? '', placeholder: 'Access, who to ask for, what to take, what is authorised' })}
                              ${
                                warnings.length
                                  ? html`<fieldset><legend>Override</legend>
                                      ${checkbox({ name: 'override_ack', label: 'I have considered these warnings and am proceeding anyway' })}
                                      ${textarea({ name: 'override_reason', label: 'Why this is still the right assignment', rows: 2 })}
                                    </fieldset>`
                                  : ''
                              }
                              ${
                                overlaps.length
                                  ? html`<fieldset><legend>Displace the clashing work</legend>
                                      <p class="tiny subtle">Displacing committed work needs a reason, someone to tell the customer, and a new owner and next action for the work being moved.</p>
                                      ${overlaps.map((o) => checkbox({ name: 'displace_ids', value: String(o.id), label: `Displace ${o.ref} (${o.job_ref})`, hint: `${fmtT(o.planned_start)}–${fmtT(o.planned_end)} · ${labelise(o.commitment)}` }))}
                                      ${textarea({ name: 'disp_reason', label: 'Why this work takes priority', rows: 2 })}
                                      <div class="fields cols2">
                                        ${select({ name: 'disp_comms_owner_user_id', label: 'Who tells the customer', blank: '—', options: staffOptions(staff, ctx.user.id) })}
                                        ${select({ name: 'disp_new_owner_user_id', label: 'New owner of the displaced work', blank: '—', options: staffOptions(staff, ctx.user.id) })}
                                      </div>
                                      ${textarea({ name: 'disp_comms_note', label: 'What the customer will be told', rows: 2 })}
                                      <div class="fields cols2">
                                        ${input({ name: 'disp_new_next_action', label: 'Next action for displaced work' })}
                                        ${dtInput({ name: 'disp_review_at', label: 'Review by', iso: J.defaultReview(24) })}
                                      </div>
                                    </fieldset>`
                                  : ''
                              }
                              <input type="hidden" name="__back" value="/schedule/assign?${raw(existing ? `attendance=${existing.id}` : `job=${jobId}`)}&engineer=${String(chosen)}&start=${encodeURIComponent(toLocalInput(startIso))}&duration=${String(duration)}">
                            `,
                          })}
                        `,
                      })
                    : ''
                }
              </div>
              <div>
                ${card({
                  title: 'What the engineer is walking into',
                  body: defList(
                    [
                      ['Reported', prose(job.reported_symptom)],
                      ['Impact', prose(job.impact)],
                      ['Safety', job.safety_flag ? html`<span class="chip danger">yes</span> ${job.safety_risk}` : 'none recorded'],
                      ['Authority', chip(J.AUTHORITY_LABEL[job.authority_basis], job.authority_basis === 'not_established' ? 'warn' : 'ok')],
                      ['Readiness', J.isReady(job) ? chip('ready', 'ok') : html`<span class="chip warn">outstanding: ${J.unmetReadiness(job).join(', ')}</span>`],
                      ['Competences needed', job.required_competences ?? 'none recorded'],
                      ['Estimated', job.estimated_minutes ? `${job.estimated_minutes} minutes` : '—'],
                      ['Expected resources', prose(job.expected_resources)],
                      ['Parts reserved', reservations.length ? html`${reservations.map((r) => html`${r.sku} × ${String(r.qty_outstanding)} at ${r.location_code}<br>`)}` : 'none'],
                      ['Site access', prose([site.opening_hours, site.parking_loading, site.induction_required ? 'Induction required' : '', site.work_restrictions].filter(Boolean).join(' · '))],
                    ],
                    true,
                  ),
                })}
              </div>
            </div>
          `,
        }),
      );
    }),
  );

  // ---------------------------------------------------------------- attendance actions
  app.post(
    '/jobs/:id/attendances',
    h((req, res) => {
      const jobId = intParam(req);
      const id = Sched.assignAttendance(db, actorOf(req), jobId, req.body);
      ok(res, `/jobs/${jobId}`, `${Sched.getAttendance(db, id).ref} scheduled.`);
    }),
  );

  app.post(
    '/attendances/:id/reschedule',
    h((req, res) => {
      const id = intParam(req);
      Sched.rescheduleAttendance(db, actorOf(req), id, req.body);
      const a = Sched.getAttendance(db, id);
      ok(res, `/jobs/${a.job_id}`, `${a.ref} moved. It is provisional again until the customer confirms.`);
    }),
  );

  app.post(
    '/attendances/:id/dispatch',
    h((req, res) => {
      const id = intParam(req);
      Sched.dispatchAttendance(db, actorOf(req), id);
      ok(res, back(req), 'Dispatched — the engineer has been notified.');
    }),
  );

  app.post(
    '/attendances/:id/confirm',
    h((req, res) => {
      const id = intParam(req);
      Sched.confirmCommitment(db, actorOf(req), id, req.body);
      ok(res, back(req), 'Recorded as a customer-confirmed commitment.');
    }),
  );

  app.post(
    '/attendances/:id/cancel',
    h((req, res) => {
      const id = intParam(req);
      const a = Sched.getAttendance(db, id);
      Sched.cancelAttendance(db, actorOf(req), id, req.body);
      ok(res, back(req) || `/jobs/${a.job_id}`, `${a.ref} cancelled.`);
    }),
  );

  // Attendance detail for office users (engineers use /attendances/:id in field.ts).
  app.get(
    '/attendances/:id/manage',
    h((req, res) => {
      needCap(req, 'schedule.assign');
      const ctx = ctxOf(req);
      const id = intParam(req);
      const a = Sched.getAttendance(db, id);
      const job = J.getJob(db, a.job_id);
      const staff = J.staffOptions(db);
      const displacementFields = html`
        <p class="tiny subtle">This is a customer-confirmed commitment. Moving or cancelling it needs a reason, someone to tell the customer, and a new owner and next action.</p>
        ${textarea({ name: 'disp_reason', label: 'Reason', rows: 2, required: true })}
        <div class="fields cols2">
          ${select({ name: 'disp_comms_owner_user_id', label: 'Who tells the customer', required: true, options: staffOptions(staff, ctx.user.id) })}
          ${select({ name: 'disp_new_owner_user_id', label: 'New owner of the work', required: true, options: staffOptions(staff, ctx.user.id) })}
        </div>
        ${textarea({ name: 'disp_comms_note', label: 'What the customer will be told', rows: 2, required: true })}
        <div class="fields cols2">${input({ name: 'disp_new_next_action', label: 'Next action', required: true })}${dtInput({ name: 'disp_review_at', label: 'Review by', required: true, iso: J.defaultReview(24) })}</div>
      `;
      send(
        res,
        page(ctx, {
          title: `${a.ref} planning`,
          heading: `${a.ref} — ${a.engineer_name}`,
          headingChips: html`${chip(labelise(a.status), 'info')} ${a.commitment === 'customer_confirmed' ? chip('customer-confirmed', 'ok') : chip('provisional', 'neutral')}`,
          crumbs: [{ href: '/schedule', label: 'Schedule' }, { href: `/jobs/${a.job_id}`, label: job.ref }, { label: a.ref }],
          narrow: true,
          sub: html`${fmtDT(a.planned_start)} – ${fmtT(a.planned_end)} · ${job.title} · ${a.site_name}`,
          body: html`
            ${card({ title: 'Instructions', body: prose(a.instructions) })}
            ${
              ['planned', 'dispatched'].includes(a.status)
                ? html`
                    ${a.status === 'planned' ? card({ title: 'Dispatch', body: form({ ctx, action: `/attendances/${id}/dispatch`, submit: 'Dispatch to engineer', submitClass: 'accent', body: html`<p class="tiny subtle">Dispatch releases the job to the engineer and records the dispatched SLA event.</p><input type="hidden" name="__back" value="/attendances/${String(id)}/manage">` }) }) : ''}
                    ${a.commitment === 'provisional' ? card({ title: 'Customer confirmation', body: form({ ctx, action: `/attendances/${id}/confirm`, submit: 'Record customer confirmation', body: html`${input({ name: 'note', label: 'Who confirmed it and how', required: true })}<input type="hidden" name="__back" value="/attendances/${String(id)}/manage">` }) }) : ''}
                    ${card({ title: 'Move or cancel', body: html`<a class="btn" href="/schedule/assign?attendance=${String(id)}">Reschedule…</a>
                      ${drawer({
                        danger: true,
                        summary: 'Cancel this attendance',
                        body: form({
                          ctx,
                          action: `/attendances/${id}/cancel`,
                          submit: 'Cancel attendance',
                          submitClass: 'danger',
                          confirm: 'Cancel this attendance?',
                          body: html`${textarea({ name: 'reason', label: 'Reason', rows: 2, required: true })}${a.commitment === 'customer_confirmed' || a.status === 'dispatched' ? displacementFields : ''}<input type="hidden" name="__back" value="/jobs/${String(a.job_id)}">`,
                        }),
                      })}` })}
                  `
                : banner('info', `This attendance is ${labelise(a.status).toLowerCase()} and can no longer be changed from the schedule.`)
            }
          `,
        }),
      );
    }),
  );
};

// ---------------------------------------------------------------- board rendering

type BoardAttendance = ReturnType<typeof Sched.boardAttendances>[number];

function blockClass(a: BoardAttendance): string {
  return [
    'slotblock',
    a.priority ? a.priority.toLowerCase() : '',
    a.commitment === 'provisional' ? 'provisional' : '',
    a.status === 'submitted' ? 'submitted' : '',
    a.status === 'cancelled' ? 'cancelled' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function blockBody(a: BoardAttendance): SafeHtml {
  return html`<b>${fmtT(a.planned_start)} ${a.job_ref}</b>${a.site_name}<br><span class="tiny">${labelise(a.status)}</span>`;
}

function dayBoard(engineers: Sched.Engineer[], byEngineer: Map<number, BoardAttendance[]>, date: string): SafeHtml {
  const dayStart = new Date(londonDayStart(date)).getTime() + DAY_START_HOUR * 60 * MIN;
  const totalMinutes = (DAY_END_HOUR - DAY_START_HOUR) * 60;
  const hours: number[] = [];
  for (let hhh = DAY_START_HOUR; hhh < DAY_END_HOUR; hhh++) hours.push(hhh);
  const nowPct = ((clock.now().getTime() - dayStart) / MIN / totalMinutes) * 100;

  return html`<div class="board" data-scroll-to="${String(Math.max(0, Math.round((nowPct / 100) * 900)))}">
    <table>
      <thead>
        <tr>
          <th class="eng">Engineer</th>
          ${hours.map((hh) => html`<th colspan="1">${String(hh).padStart(2, '0')}:00</th>`)}
        </tr>
      </thead>
      <tbody>
        ${engineers.map((e) => {
          const list = (byEngineer.get(e.id) ?? []).filter((a) => a.status !== 'cancelled');
          return html`<tr>
            <td class="eng">${e.display_name}<small>${e.home_area ?? ''}</small></td>
            <td class="slot" colspan="${String(hours.length)}">
              <div class="lane">
                ${list.map((a) => {
                  const start = Math.max(0, (new Date(a.planned_start).getTime() - dayStart) / MIN);
                  const end = Math.min(totalMinutes, (new Date(a.planned_end).getTime() - dayStart) / MIN);
                  if (end <= 0 || start >= totalMinutes) return '';
                  const left = (start / totalMinutes) * 100;
                  const width = Math.max(3, ((end - start) / totalMinutes) * 100);
                  return html`<a class="${raw(blockClass(a))}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%" href="/jobs/${String(a.job_id)}" title="${a.job_ref} ${a.customer_name} — ${a.site_name} (${fmtT(a.planned_start)}–${fmtT(a.planned_end)}, ${labelise(a.status)}, ${labelise(a.commitment)})">${blockBody(a)}</a>`;
                })}
              </div>
            </td>
          </tr>`;
        })}
      </tbody>
    </table>
  </div>`;
}

function weekBoard(engineers: Sched.Engineer[], byEngineer: Map<number, BoardAttendance[]>, date: string): SafeHtml {
  const days = Array.from({ length: 7 }, (_, i) => addDays(date, i));
  return html`<div class="board">
    <table>
      <thead>
        <tr>
          <th class="eng">Engineer</th>
          ${days.map((d) => html`<th>${fmtD(londonDayStart(d))}</th>`)}
        </tr>
      </thead>
      <tbody>
        ${engineers.map((e) => {
          const list = byEngineer.get(e.id) ?? [];
          return html`<tr>
            <td class="eng">${e.display_name}<small>${e.home_area ?? ''}</small></td>
            ${days.map((d) => {
              const dayJobs = list.filter((a) => londonDate(a.planned_start) === d && a.status !== 'cancelled');
              return html`<td class="weekcell">
                ${dayJobs.map((a) => html`<a class="${raw(blockClass(a))}" href="/jobs/${String(a.job_id)}" title="${a.customer_name} — ${a.site_name}">${blockBody(a)}</a>`)}
              </td>`;
            })}
          </tr>`;
        })}
      </tbody>
    </table>
  </div>`;
}

function nextSlot(): string {
  const now = clock.now();
  const rounded = new Date(Math.ceil(now.getTime() / (30 * MIN)) * 30 * MIN);
  return rounded.toISOString();
}

/** datetime-local values are London wall clock; fall back to now if the value is malformed. */
function isoFromLocal(local: string): string {
  try {
    return fromLocalInput(local);
  } catch {
    return clock.iso();
  }
}

export default register;
