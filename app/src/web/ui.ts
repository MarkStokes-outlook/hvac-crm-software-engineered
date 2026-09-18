import crypto from 'node:crypto';
import { escapeHtml, html, raw, type SafeHtml } from '../lib/html.ts';
import { type Capability, can, ROLE_LABEL, type Role } from '../auth/policy.ts';
import type { SessionUser } from '../auth/auth.ts';
import { fmtD, fmtDT, fmtT, relative, toLocalInput } from '../lib/clock.ts';
import { PRIORITY_LABEL, type Priority } from '../domain/jobs.ts';
import { penceToInput } from '../lib/money.ts';

export interface Ctx {
  user: SessionUser;
  csrf: string;
  path: string;
  unread: number;
  flash?: { tone: 'ok' | 'err' | 'warn' | 'info'; message: string } | null;
}

export const LOGO = raw(`<svg viewBox="0 0 40 40" fill="none" aria-hidden="true">
  <circle cx="20" cy="20" r="18" stroke="currentColor" stroke-width="2.5" fill="none"/>
  <path d="M20 6 L20 10 M20 30 L20 34 M6 20 L10 20 M30 20 L34 20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <path d="M20 13 L17 17 L20 15 L23 17 Z" fill="currentColor"/>
  <path d="M15 20 L25 20" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  <path d="M20 27 L17 23 L20 25 L23 23 Z" fill="currentColor"/>
  <circle cx="20" cy="20" r="3" fill="none" stroke="currentColor" stroke-width="1.5"/>
</svg>`);

interface NavItem {
  href: string;
  label: string;
  cap?: Capability;
  roles?: Role[];
}
const NAV: NavItem[] = [
  { href: '/', label: 'Dashboard' },
  { href: '/my-day', label: 'My day', roles: ['engineer'] },
  { href: '/jobs', label: 'Service', cap: 'job.read' },
  { href: '/schedule', label: 'Schedule', cap: 'schedule.read' },
  { href: '/customers', label: 'Customers', cap: 'crm.read' },
  { href: '/assets', label: 'Assets', cap: 'crm.read' },
  { href: '/quotes', label: 'Quotes', cap: 'quote.read' },
  { href: '/stock', label: 'Stock', cap: 'stock.read' },
  { href: '/reports', label: 'Reports', cap: 'reports.read' },
  { href: '/admin', label: 'Admin', cap: 'admin.config' },
];

export function navFor(user: SessionUser): NavItem[] {
  return NAV.filter((n) => (n.roles ? n.roles.includes(user.role) : n.cap ? can(user, n.cap) : true));
}

export interface PageOpts {
  title: string;
  body: SafeHtml;
  crumbs?: { href?: string; label: string }[];
  heading?: SafeHtml | string;
  headingChips?: SafeHtml;
  actions?: SafeHtml;
  narrow?: boolean;
  sub?: SafeHtml | string;
}

export function page(ctx: Ctx, o: PageOpts): string {
  const nav = navFor(ctx.user);
  const active = nav
    .filter((n) => (n.href === '/' ? ctx.path === '/' : ctx.path.startsWith(n.href)))
    .sort((a, b) => b.href.length - a.href.length)[0];
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(o.title)} · FrostLine Ops</title>
<link rel="stylesheet" href="/static/app.css">
<link rel="icon" href="/static/logo.svg" type="image/svg+xml">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="app">
  <div class="topbar">
    <a class="brand" href="/"><span class="logo">${LOGO}</span><span><b>Frost</b>line <span class="brand-sub">operations</span></span></a>
    <form class="topsearch" role="search" action="/search" method="get">
      <input type="search" name="q" placeholder="Search customers, sites, equipment, jobs, quotes…" aria-label="Search records" autocomplete="off">
    </form>
    <a class="searchlink" href="/search" aria-label="Search records">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
    </a>
    <div class="topright">
      <a class="bell" href="/notifications" aria-label="Notifications${ctx.unread ? ` (${ctx.unread} unread)` : ''}">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>
        ${ctx.unread ? `<span class="dot">${ctx.unread > 9 ? '9+' : ctx.unread}</span>` : ''}
      </a>
      <div class="whoami"><b>${escapeHtml(ctx.user.name)}</b><small>${escapeHtml(ROLE_LABEL[ctx.user.role])}</small></div>
      <form method="post" action="/logout"><input type="hidden" name="_csrf" value="${escapeHtml(ctx.csrf)}"><button class="logout btn small" type="submit">Sign out</button></form>
    </div>
  </div>
  <nav class="mainnav" aria-label="Main">
    ${nav.map((n) => `<a href="${n.href}"${active === n ? ' aria-current="page"' : ''}>${escapeHtml(n.label)}</a>`).join('')}
  </nav>
  <main id="main"${o.narrow ? ' class="narrow"' : ''}>
    ${ctx.flash ? `<div class="flash"><div class="banner ${ctx.flash.tone}" role="status">${escapeHtml(ctx.flash.message)}</div></div>` : ''}
    ${
      o.heading || o.crumbs
        ? `<div class="pagehead"><div class="grow">
            ${o.crumbs ? `<div class="crumbs">${o.crumbs.map((c, i) => `${i ? ' / ' : ''}${c.href ? `<a href="${c.href}">${escapeHtml(c.label)}</a>` : escapeHtml(c.label)}`).join('')}</div>` : ''}
            <h1>${o.heading instanceof Object ? String(o.heading) : escapeHtml(String(o.heading ?? o.title))}${o.headingChips ? ` ${o.headingChips}` : ''}</h1>
            ${o.sub ? `<div class="subtle">${o.sub instanceof Object ? String(o.sub) : escapeHtml(String(o.sub))}</div>` : ''}
          </div>${o.actions ? `<div class="actions">${o.actions}</div>` : ''}</div>`
        : ''
    }
    ${o.body}
  </main>
  <footer class="appfoot">FrostLine operations CRM · demo dataset · all customers, people and sites are fictional</footer>
</div>
<script src="/static/app.js" defer></script>
</body>
</html>`;
}

export function loginPage(o: { error?: string; users?: { username: string; display_name: string; role: Role }[]; csrf: string; next?: string }): string {
  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · FrostLine Ops</title><link rel="stylesheet" href="/static/app.css"><link rel="icon" href="/static/logo.svg" type="image/svg+xml"></head>
<body><div class="loginwrap"><div class="loginbox">
  <div class="brandrow" style="color:var(--primary)">${LOGO}<div><h1><b>Frost</b>line operations</h1><small class="subtle">Service, scheduling, quoting &amp; stock</small></div></div>
  ${o.error ? `<div class="banner err mt2" role="alert">${escapeHtml(o.error)}</div>` : ''}
  <form method="post" action="/login" class="stack mt2">
    <input type="hidden" name="_csrf" value="${escapeHtml(o.csrf)}">
    ${o.next ? `<input type="hidden" name="next" value="${escapeHtml(o.next)}">` : ''}
    <div class="field"><label for="u">Username</label><input id="u" name="username" autocomplete="username" required autofocus></div>
    <div class="field"><label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required></div>
    <button class="btn primary block" type="submit">Sign in</button>
  </form>
  ${
    o.users?.length
      ? `<details class="drawer mt2"><summary>Demo sign-in accounts</summary><div class="drawerbody">
          <p class="tiny subtle">Every demo account uses the password <code>frostline</code>. Roles see different navigation and are permitted different actions.</p>
          <table class="demotable">${o.users.map((u) => `<tr><td>${escapeHtml(u.username)}</td><td>${escapeHtml(u.display_name)}</td><td class="subtle">${escapeHtml(ROLE_LABEL[u.role])}</td></tr>`).join('')}</table>
        </div></details>`
      : ''
  }
</div></div></body></html>`;
}

// ---------------------------------------------------------------- small pieces

export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral';

export function chip(text: string, tone: Tone | string = 'neutral', big = false): SafeHtml {
  return html`<span class="chip ${raw(tone)}${raw(big ? ' big' : '')}">${text}</span>`;
}

export function priorityChip(p: string, big = false): SafeHtml {
  return html`<span class="chip ${raw(p.toLowerCase())}${raw(big ? ' big' : '')}" title="${PRIORITY_LABEL[p as Priority] ?? p}">${p}</span>`;
}

const OP_TONE: Record<string, Tone> = {
  new: 'info',
  triaged: 'info',
  authorised: 'info',
  ready: 'ok',
  scheduled: 'ok',
  dispatched: 'ok',
  in_progress: 'ok',
  waiting: 'warn',
  operationally_complete: 'neutral',
  cancelled: 'neutral',
};
export function labelise(s: string): string {
  return s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}
export function opChip(s: string, big = false): SafeHtml {
  return chip(labelise(s), OP_TONE[s] ?? 'neutral', big);
}
export function finChip(s: string, big = false): SafeHtml {
  return chip(labelise(s), s === 'financially_closed' ? 'neutral' : s === 'not_ready' ? 'info' : 'warn', big);
}
export function commChip(s: string, big = false): SafeHtml {
  return chip(labelise(s), s === 'clear' || s === 'resolved' ? 'neutral' : s === 'disputed' ? 'danger' : 'warn', big);
}

export function slaChip(state: string, label: string): SafeHtml {
  const tone: Tone = state === 'breached' ? 'danger' : state === 'at_risk' ? 'warn' : state === 'met' ? 'ok' : state === 'missed' ? 'danger' : 'neutral';
  return chip(`${label}: ${labelise(state)}`, tone);
}

export function when(iso: string | null | undefined, opts: { rel?: boolean; dateOnly?: boolean } = {}): SafeHtml {
  if (!iso) return html`<span class="subtle">—</span>`;
  return html`<span title="${iso}">${opts.dateOnly ? fmtD(iso) : fmtDT(iso)}${opts.rel ? html` <span class="subtle tiny">(${relative(iso)})</span>` : ''}</span>`;
}

export function card(o: { title?: string; id?: string; actions?: SafeHtml | string; body: SafeHtml | string; definition?: string; foot?: SafeHtml | string; tight?: boolean }): SafeHtml {
  return html`<section class="card"${raw(o.id ? ` id="${escapeHtml(o.id)}"` : '')}>
    ${o.title || o.actions ? html`<header><h2>${o.title ?? ''}</h2>${o.actions ? html`<div class="spacer"></div>${o.actions}` : ''}</header>` : ''}
    <div class="body${raw(o.tight ? ' tight' : '')}">${o.body}</div>
    ${o.definition ? html`<p class="definition">${o.definition}</p>` : ''}
    ${o.foot ? html`<div class="foot">${o.foot}</div>` : ''}
  </section>`;
}

export interface Col {
  label: string;
  num?: boolean;
  nowrap?: boolean;
}
export function table(o: { cols: (Col | string)[]; rows: (SafeHtml | string)[][]; rowClass?: (i: number) => string; empty?: string }): SafeHtml {
  if (!o.rows.length) return html`<p class="empty"><b>Nothing to show</b>${o.empty ?? ''}</p>`;
  const cols = o.cols.map((c) => (typeof c === 'string' ? { label: c } : c));
  return html`<div class="tablewrap"><table class="data">
    <thead><tr>${cols.map((c) => html`<th class="${raw([c.num ? 'num' : '', c.nowrap ? 'nowrap' : ''].filter(Boolean).join(' '))}">${c.label}</th>`)}</tr></thead>
    <tbody>${o.rows.map((r, i) => html`<tr class="${raw(o.rowClass?.(i) ?? '')}">${r.map((cell, ci) => html`<td class="${raw([cols[ci]?.num ? 'num' : '', cols[ci]?.nowrap ? 'nowrap' : ''].filter(Boolean).join(' '))}">${cell}</td>`)}</tr>`)}</tbody>
  </table></div>`;
}

export function defList(pairs: [string, SafeHtml | string | null | undefined][], stack = false): SafeHtml {
  const rows = pairs.filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!rows.length) return html`<p class="subtle tiny">Nothing recorded.</p>`;
  return html`<dl class="def${raw(stack ? ' stack' : '')}">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`;
}

export function banner(tone: 'ok' | 'err' | 'warn' | 'info' | 'security', body: SafeHtml | string, title?: string): SafeHtml {
  return html`<div class="banner ${raw(tone)}"><div>${title ? html`<b>${title}</b>` : ''}${body}</div></div>`;
}

export function empty(title: string, hint?: string): SafeHtml {
  return html`<p class="empty"><b>${title}</b>${hint ?? ''}</p>`;
}

export function prose(text: string | null | undefined, box = false): SafeHtml {
  if (!text) return html`<span class="subtle">—</span>`;
  return html`<div class="prose${raw(box ? ' box' : '')}">${text}</div>`;
}

export function pagination(o: { total: number; limit: number; offset: number; base: string }): SafeHtml {
  const { total, limit, offset, base } = o;
  if (total <= limit) return html`<div class="tfoot">${String(total)} record${raw(total === 1 ? '' : 's')}</div>`;
  const sep = base.includes('?') ? '&' : '?';
  const from = offset + 1;
  const to = Math.min(offset + limit, total);
  return html`<div class="tfoot">
    <span>Showing ${String(from)}–${String(to)} of ${String(total)}</span>
    ${offset > 0 ? html`<a class="btn small" href="${base}${raw(sep)}offset=${String(Math.max(0, offset - limit))}">‹ Previous</a>` : ''}
    ${to < total ? html`<a class="btn small" href="${base}${raw(sep)}offset=${String(offset + limit)}">Next ›</a>` : ''}
  </div>`;
}

// ---------------------------------------------------------------- forms

export function csrfInput(ctx: Ctx): SafeHtml {
  return html`<input type="hidden" name="_csrf" value="${ctx.csrf}">`;
}

/** Fresh idempotency key per rendered form so a refresh or double-tap cannot duplicate the action. */
export function idemInput(name = 'idem_key'): SafeHtml {
  return html`<input type="hidden" name="${name}" value="${crypto.randomUUID()}">`;
}

export function form(o: { ctx: Ctx; action: string; body: SafeHtml | string; submit?: string; submitClass?: string; confirm?: string; enctype?: string; extra?: SafeHtml | string; method?: string }): SafeHtml {
  return html`<form method="${o.method ?? 'post'}" action="${o.action}" class="stack"${raw(o.enctype ? ` enctype="${o.enctype}"` : '')}${raw(o.confirm ? ` data-confirm="${escapeHtml(o.confirm)}"` : '')}>
    ${csrfInput(o.ctx)}${o.body}
    ${o.submit ? html`<div class="btnrow">${o.extra ?? ''}<button class="btn ${raw(o.submitClass ?? 'primary')}" type="submit">${o.submit}</button></div>` : ''}
  </form>`;
}

export function drawer(o: { summary: string; body: SafeHtml | string; open?: boolean; danger?: boolean; id?: string }): SafeHtml {
  return html`<details class="drawer${raw(o.danger ? ' danger' : '')}"${raw(o.open ? ' open' : '')}${raw(o.id ? ` id="${escapeHtml(o.id)}"` : '')}>
    <summary>${o.summary}</summary><div class="drawerbody">${o.body}</div>
  </details>`;
}

interface FieldOpts {
  name: string;
  label: string;
  value?: string | number | null;
  hint?: string;
  required?: boolean;
  placeholder?: string;
  type?: string;
  span?: boolean;
  min?: number | string;
  max?: number | string;
  step?: string;
  autofocus?: boolean;
  disabled?: boolean;
}

function fieldWrap(o: { label: string; name: string; hint?: string; span?: boolean; control: SafeHtml }): SafeHtml {
  return html`<div class="field${raw(o.span ? ' span2' : '')}">
    <label for="f_${raw(o.name)}">${o.label}</label>
    ${o.control}
    ${o.hint ? html`<span class="hint">${o.hint}</span>` : ''}
  </div>`;
}

export function input(o: FieldOpts): SafeHtml {
  return fieldWrap({
    ...o,
    control: html`<input id="f_${raw(o.name)}" name="${o.name}" type="${o.type ?? 'text'}" value="${o.value === null || o.value === undefined ? '' : String(o.value)}"${raw(o.required ? ' required' : '')}${raw(
      o.placeholder ? ` placeholder="${escapeHtml(o.placeholder)}"` : '',
    )}${raw(o.min !== undefined ? ` min="${o.min}"` : '')}${raw(o.max !== undefined ? ` max="${o.max}"` : '')}${raw(o.step ? ` step="${o.step}"` : '')}${raw(o.autofocus ? ' autofocus' : '')}${raw(
      o.disabled ? ' disabled' : '',
    )}>`,
  });
}

export function money(o: FieldOpts & { pence?: number | null }): SafeHtml {
  return input({ ...o, value: o.pence !== undefined ? penceToInput(o.pence) : o.value, placeholder: o.placeholder ?? '0.00', hint: o.hint ?? 'Pounds, e.g. 1250.00' });
}

export function dtInput(o: FieldOpts & { iso?: string | null }): SafeHtml {
  return input({ ...o, type: 'datetime-local', value: o.iso !== undefined ? toLocalInput(o.iso) : o.value });
}

export function textarea(o: FieldOpts & { rows?: number }): SafeHtml {
  return fieldWrap({
    ...o,
    control: html`<textarea id="f_${raw(o.name)}" name="${o.name}" rows="${String(o.rows ?? 3)}"${raw(o.required ? ' required' : '')}${raw(o.placeholder ? ` placeholder="${escapeHtml(o.placeholder)}"` : '')}>${o.value ?? ''}</textarea>`,
  });
}

export type Option = { value: string | number; label: string; selected?: boolean; disabled?: boolean };

export function select(o: FieldOpts & { options: Option[]; blank?: string }): SafeHtml {
  const value = o.value === null || o.value === undefined ? '' : String(o.value);
  return fieldWrap({
    ...o,
    control: html`<select id="f_${raw(o.name)}" name="${o.name}"${raw(o.required ? ' required' : '')}${raw(o.disabled ? ' disabled' : '')}>
      ${o.blank !== undefined ? html`<option value="">${o.blank}</option>` : ''}
      ${o.options.map((opt) => html`<option value="${String(opt.value)}"${raw(opt.selected ?? String(opt.value) === value ? ' selected' : '')}${raw(opt.disabled ? ' disabled' : '')}>${opt.label}</option>`)}
    </select>`,
  });
}

export function checkbox(o: { name: string; label: string; checked?: boolean; hint?: string; value?: string }): SafeHtml {
  return html`<div class="check">
    <input type="checkbox" id="f_${raw(o.name)}" name="${o.name}" value="${o.value ?? 'on'}"${raw(o.checked ? ' checked' : '')}>
    <label for="f_${raw(o.name)}">${o.label}${o.hint ? html`<span class="hint">${o.hint}</span>` : ''}</label>
  </div>`;
}

export function options(list: { id: number | string; label: string }[], selected?: number | string | null): Option[] {
  return list.map((l) => ({ value: l.id, label: l.label, selected: selected !== undefined && selected !== null && String(selected) === String(l.id) }));
}

export function enumOptions(values: readonly string[], labels?: Record<string, string>, selected?: string | null): Option[] {
  return values.map((v) => ({ value: v, label: labels?.[v] ?? labelise(v), selected: selected === v }));
}

export function staffOptions(list: { id: number; display_name: string; role: string }[], selected?: number | null): Option[] {
  return list.map((u) => ({ value: u.id, label: `${u.display_name} — ${ROLE_LABEL[u.role as Role]}`, selected: selected === u.id }));
}

export function versionInput(version: number): SafeHtml {
  return html`<input type="hidden" name="version" value="${String(version)}">`;
}

export function timeRange(startIso: string, endIso: string): SafeHtml {
  return html`<span class="nowrap">${fmtT(startIso)}–${fmtT(endIso)}</span>`;
}
