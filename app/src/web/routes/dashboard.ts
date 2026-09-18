import { html, raw, type SafeHtml } from '../../lib/html.ts';
import { fmtDT, fmtT, relative } from '../../lib/clock.ts';
import { dashboard, type Queue, type SlaRiskRow, type StockException } from '../../domain/dashboard.ts';
import { search } from '../../domain/search.ts';
import { markRead, notificationsFor } from '../../domain/admin.ts';
import { card, chip, empty, form, labelise, opChip, page, priorityChip, table, when } from '../ui.ts';
import { actorOf, ctxOf, h, ok, type RouteModule, send, strQuery } from '../kit.ts';

const register: RouteModule = (app, { db }) => {
  // Engineers land on their own day; everyone else gets the operations dashboard.
  app.get(
    '/',
    h((req, res) => {
      const user = actorOf(req);
      if (user.role === 'engineer') return res.redirect('/my-day');
      const ctx = ctxOf(req);
      const { queues, waitingBy, mine } = dashboard(db, user);
      const q = (key: string) => queues.find((x) => x.key === key)!;

      const mineCard = card({
        title: 'Your next actions',
        body: table({
          cols: ['Job', 'Priority', 'Next action', { label: 'Review', nowrap: true }, 'State'],
          rows: mine.slice(0, 8).map((j) => [
            html`<a class="rowtitle" href="/jobs/${String(j.id)}">${j.ref}</a><br><span class="tiny subtle">${j.customer_name} · ${j.site_name}</span>`,
            priorityChip(j.priority),
            html`${j.next_action ?? html`<span class="subtle">—</span>`}`,
            j.review_at ? html`${when(j.review_at)}<br><span class="tiny ${raw(j.review_at < new Date().toISOString() ? 'chip danger' : 'subtle')}">${relative(j.review_at)}</span>` : html`<span class="subtle">—</span>`,
            opChip(j.op_status),
          ]),
          empty: 'Nothing is currently assigned to you as next owner.',
        }),
        definition: 'Open jobs where you are recorded as the next-action owner, soonest review first.',
        foot: mine.length > 8 ? html`<a href="/jobs?owner=${String(user.id)}">View all ${String(mine.length)}</a>` : undefined,
        tight: true,
      });

      const body = html`
        ${mineCard}
        <div class="grid cols2">
          ${queueCard(q('urgent'), jobRows)}
          ${queueCard(q('sla'), slaRows)}
          ${queueCard(q('waiting_overdue'), waitingRows)}
          ${queueCard(q('escalations'), escalationRows)}
          ${queueCard(q('today'), todayRows)}
          ${queueCard(q('ready'), readyRows)}
          ${queueCard(q('temporary'), tempRows)}
          ${q('stock') ? queueCard(q('stock'), stockRows) : ''}
        </div>
        ${card({
          title: 'What is waiting, and on whom',
          body: table({
            cols: ['Dependency', 'Owner', { label: 'Jobs', num: true }, { label: 'Review overdue', num: true }],
            rows: waitingBy.map((w) => [labelise(w.category ?? 'unspecified'), w.owner, String(w.n), w.overdue ? html`${chip(String(w.overdue), 'danger')}` : html`<span class="subtle">0</span>`]),
            empty: 'No work is waiting on a dependency.',
          }),
          definition: 'Every waiting job grouped by its recorded dependency and the FrostLine owner responsible for clearing it.',
          tight: true,
        })}
      `;

      send(
        res,
        page(ctx, {
          title: 'Operations dashboard',
          heading: 'Operations dashboard',
          sub: html`Live from the record — every count links to the jobs behind it. ${chip(`as at ${fmtDT(new Date().toISOString())}`, 'neutral')}`,
          actions: html`<a class="btn primary" href="/jobs/new">Log a call</a><a class="btn" href="/schedule">Schedule</a>`,
          body,
        }),
      );
    }),
  );

  app.get(
    '/search',
    h((req, res) => {
      const ctx = ctxOf(req);
      const q = strQuery(req, 'q') ?? '';
      const hits = q.trim().length >= 2 ? search(db, actorOf(req), q, 12) : [];
      const groups = new Map<string, typeof hits>();
      for (const hit of hits) {
        if (!groups.has(hit.type)) groups.set(hit.type, []);
        groups.get(hit.type)!.push(hit);
      }
      const TITLES: Record<string, string> = { customer: 'Customers', site: 'Sites', contact: 'Contacts', asset: 'Equipment', job: 'Jobs', quote: 'Quotations', attendance: 'Attendances' };
      send(
        res,
        page(ctx, {
          title: q ? `Search: ${q}` : 'Search',
          heading: 'Search',
          sub: q ? html`${String(hits.length)} match${raw(hits.length === 1 ? '' : 'es')} for “${q}”` : 'Search across customers, sites, contacts, equipment, jobs and quotations.',
          body: html`
            <form class="filters card" method="get" action="/search" style="padding:12px">
              <div class="field wide"><label for="f_q">Search term</label><input id="f_q" type="search" name="q" value="${q}" placeholder="Name, reference, postcode, serial number, PO…" autofocus></div>
              <button class="btn primary" type="submit">Search</button>
            </form>
            ${
              !q
                ? ''
                : hits.length === 0
                  ? empty('No matches', 'Try a shorter term, a reference such as J-10004, a postcode or a serial number.')
                  : html`${[...groups.entries()].map(([type, list]) =>
                      card({
                        title: TITLES[type] ?? type,
                        tight: true,
                        body: table({
                          cols: ['Record', 'Detail'],
                          rows: list.map((hit) => [html`<a class="rowtitle" href="${hit.href}">${hit.title}</a>`, html`<span class="subtle">${hit.subtitle}</span>`]),
                        }),
                      }),
                    )}`
            }
          `,
        }),
      );
    }),
  );

  app.get(
    '/notifications',
    h((req, res) => {
      const ctx = ctxOf(req);
      const user = actorOf(req);
      const rows = notificationsFor(db, user.id, 60);
      send(
        res,
        page(ctx, {
          title: 'Notifications',
          heading: 'Notifications',
          sub: 'Handovers, escalations, displaced work, reallocated stock and clock stops addressed to you.',
          narrow: true,
          actions: rows.some((r) => !r.read_at)
            ? form({ ctx, action: '/notifications/read-all', body: html``, submit: 'Mark all as read', submitClass: '' })
            : undefined,
          body: rows.length
            ? html`${card({
                tight: true,
                body: table({
                  cols: [{ label: 'When', nowrap: true }, 'Kind', 'Message'],
                  rows: rows.map((n) => [
                    html`${when(n.created_at)}`,
                    chip(labelise(n.kind), n.read_at ? 'neutral' : 'info'),
                    n.link ? html`<a href="${n.link}">${n.message}</a>` : html`${n.message}`,
                  ]),
                  rowClass: (i) => (rows[i].read_at ? '' : 'rowwarn'),
                }),
              })}`
            : empty('No notifications', 'You will be told here when work is handed to you.'),
        }),
      );
    }),
  );

  app.post(
    '/notifications/read-all',
    h((req, res) => {
      markRead(db, actorOf(req).id);
      ok(res, '/notifications', 'All notifications marked as read.');
    }),
  );
};

// ---------------------------------------------------------------- queue rendering

function queueCard(q: Queue<unknown>, renderer: (rows: unknown[]) => SafeHtml): SafeHtml {
  const tone = q.tone === 'danger' ? 'danger' : q.tone === 'warn' ? 'warn' : q.tone === 'ok' ? 'ok' : 'info';
  return card({
    title: q.title,
    actions: html`<span class="count ${raw(q.count === 0 ? 'ok' : tone)}">${String(q.count)}</span>`,
    body: q.count ? renderer(q.rows as unknown[]) : empty('Clear', 'Nothing in this queue right now.'),
    definition: q.definition,
    foot: q.count > 6 ? html`<a href="${q.href}">View all ${String(q.count)}</a>` : undefined,
    tight: true,
  });
}

interface Jobish {
  id: number;
  ref: string;
  title: string;
  priority: string;
  op_status: string;
  customer_name: string;
  site_name: string;
  received_at: string;
  next_owner_name: string | null;
  review_at: string | null;
  waiting_category: string | null;
  waiting_detail: string | null;
  safety_flag: number;
}

const jobLink = (j: Jobish) => html`<a class="rowtitle" href="/jobs/${String(j.id)}">${j.ref}</a> ${j.safety_flag ? chip('safety', 'danger') : ''}<br><span class="tiny subtle">${j.title}</span>`;
const place = (j: Jobish) => html`${j.customer_name}<br><span class="tiny subtle">${j.site_name}</span>`;

function jobRows(rows: unknown[]): SafeHtml {
  const jobs = rows as Jobish[];
  return table({
    cols: ['Job', 'P', 'Customer / site', 'State', { label: 'Logged', nowrap: true }],
    rows: jobs.slice(0, 6).map((j) => [jobLink(j), priorityChip(j.priority), place(j), opChip(j.op_status), html`<span class="tiny">${relative(j.received_at)}</span>`]),
  });
}

function slaRows(rows: unknown[]): SafeHtml {
  const list = rows as SlaRiskRow[];
  return table({
    cols: ['Job', 'P', 'Target', { label: 'Due', nowrap: true }, 'Customer'],
    rows: list.slice(0, 6).map((j) => [
      jobLink(j as unknown as Jobish),
      priorityChip(j.priority),
      html`${j.measure.label} ${chip(labelise(j.measure.state), j.measure.state === 'breached' ? 'danger' : 'warn')}`,
      html`${when(j.measure.dueAt)}<br><span class="tiny subtle">${relative(j.measure.dueAt)}</span>`,
      html`<span class="tiny">${j.customer_name}</span>`,
    ]),
    rowClass: (i) => (list[i].measure.state === 'breached' ? 'rowdanger' : 'rowwarn'),
  });
}

function waitingRows(rows: unknown[]): SafeHtml {
  const jobs = rows as Jobish[];
  return table({
    cols: ['Job', 'Waiting on', 'Owner', { label: 'Review was', nowrap: true }],
    rows: jobs.slice(0, 6).map((j) => [
      jobLink(j),
      html`${labelise(j.waiting_category ?? '—')}<br><span class="tiny subtle">${(j.waiting_detail ?? '').slice(0, 90)}</span>`,
      html`<span class="tiny">${j.next_owner_name ?? '—'}</span>`,
      html`<span class="chip danger">${relative(j.review_at)}</span>`,
    ]),
    rowClass: () => 'rowwarn',
  });
}

interface EscalationRow {
  id: number;
  kind: string;
  detail: string;
  raised_at: string;
  attendance_ref: string;
  job_id: number;
  job_ref: string;
  raised_by_name: string;
}
function escalationRows(rows: unknown[]): SafeHtml {
  const list = rows as EscalationRow[];
  return table({
    cols: ['Job', 'Raised by', 'What', { label: 'When', nowrap: true }],
    rows: list.slice(0, 6).map((s) => [
      html`<a class="rowtitle" href="/jobs/${String(s.job_id)}">${s.job_ref}</a><br><span class="tiny subtle">${s.attendance_ref}</span>`,
      html`<span class="tiny">${s.raised_by_name}</span>`,
      html`${chip(labelise(s.kind), s.kind.startsWith('stop') ? 'danger' : 'warn')}<br><span class="tiny subtle">${s.detail.slice(0, 90)}</span>`,
      html`<span class="tiny">${relative(s.raised_at)}</span>`,
    ]),
    rowClass: () => 'rowdanger',
  });
}

interface TodayRow {
  id: number;
  ref: string;
  planned_start: string;
  planned_end: string;
  status: string;
  commitment: string;
  engineer_name: string;
  job_id: number;
  job_ref: string;
  priority: string;
  site_name: string;
}
function todayRows(rows: unknown[]): SafeHtml {
  const list = rows as TodayRow[];
  return table({
    cols: [{ label: 'Time', nowrap: true }, 'Engineer', 'Job / site', 'Commitment', 'State'],
    rows: list.slice(0, 8).map((a) => [
      html`<span class="nowrap">${fmtT(a.planned_start)}–${fmtT(a.planned_end)}</span>`,
      html`<span class="tiny">${a.engineer_name}</span>`,
      html`<a href="/jobs/${String(a.job_id)}">${a.job_ref}</a> ${priorityChip(a.priority)}<br><span class="tiny subtle">${a.site_name}</span>`,
      a.commitment === 'customer_confirmed' ? chip('confirmed', 'ok') : chip('provisional', 'neutral'),
      opChip(a.status),
    ]),
  });
}

function readyRows(rows: unknown[]): SafeHtml {
  const jobs = rows as Jobish[];
  return table({
    cols: ['Job', 'P', 'Customer / site', { label: 'Waiting since', nowrap: true }, ''],
    rows: jobs.slice(0, 6).map((j) => [
      jobLink(j),
      priorityChip(j.priority),
      place(j),
      html`<span class="tiny">${relative(j.received_at)}</span>`,
      html`<a class="btn small" href="/schedule/assign?job=${String(j.id)}">Assign</a>`,
    ]),
  });
}

interface TempRow {
  id: number;
  review_at: string;
  limitations: string;
  job_id: number;
  job_ref: string;
  site_name: string;
  owner_name: string;
}
function tempRows(rows: unknown[]): SafeHtml {
  const list = rows as TempRow[];
  const now = new Date().toISOString();
  return table({
    cols: ['Job', 'Limitation', 'Permanent owner', { label: 'Review', nowrap: true }],
    rows: list.slice(0, 6).map((t) => [
      html`<a class="rowtitle" href="/jobs/${String(t.job_id)}">${t.job_ref}</a><br><span class="tiny subtle">${t.site_name}</span>`,
      html`<span class="tiny">${t.limitations.slice(0, 80)}</span>`,
      html`<span class="tiny">${t.owner_name}</span>`,
      html`${when(t.review_at, { dateOnly: true })}<br><span class="tiny ${raw(t.review_at < now ? 'chip danger' : 'subtle')}">${relative(t.review_at)}</span>`,
    ]),
    rowClass: (i) => (list[i].review_at < now ? 'rowdanger' : 'rowwarn'),
  });
}

function stockRows(rows: unknown[]): SafeHtml {
  const list = rows as StockException[];
  return table({
    cols: ['Exception', 'Detail', 'Type'],
    rows: list.slice(0, 6).map((s) => [html`<a href="${s.href}">${s.label}</a>`, html`<span class="tiny subtle">${s.detail}</span>`, chip(labelise(s.kind), s.kind === 'quarantine' || s.kind === 'evidence' ? 'warn' : 'neutral')]),
  });
}

export default register;
