import { html, raw, type SafeHtml } from '../../lib/html.ts';
import { fmtD, relative } from '../../lib/clock.ts';
import { ForbiddenError } from '../../lib/errors.ts';
import { can } from '../../auth/policy.ts';
import * as CRM from '../../domain/crm.ts';
import * as J from '../../domain/jobs.ts';
import * as Q from '../../domain/quotes.ts';
import { auditFor } from '../../domain/audit.ts';
import {
  banner,
  card,
  checkbox,
  chip,
  commChip,
  type Ctx,
  defList,
  drawer,
  empty,
  enumOptions,
  finChip,
  form,
  input,
  labelise,
  opChip,
  options,
  page,
  pagination,
  priorityChip,
  prose,
  select,
  table,
  textarea,
  when,
} from '../ui.ts';
import { actorOf, back, canReq, ctxOf, h, intParam, intQuery, needCap, ok, type RouteModule, send, strQuery } from '../kit.ts';
import { aiButtons, aiPanel, loadInteraction } from '../aipanel.ts';
import { auditTable } from './jobs.ts';

const register: RouteModule = (app, { db }) => {
  // ---------------------------------------------------------------- customers
  app.get(
    '/customers',
    h((req, res) => {
      needCap(req, 'crm.read');
      const ctx = ctxOf(req);
      const limit = 50;
      const offset = intQuery(req, 'offset') ?? 0;
      const q = strQuery(req, 'q');
      const status = strQuery(req, 'status');
      const { rows, total } = CRM.listCustomers(db, { q, status, limit, offset });
      send(
        res,
        page(ctx, {
          title: 'Customers',
          heading: 'Customers',
          sub: 'The commercial organisation. Sites are the physical places we attend; contacts hold the authority.',
          actions: canReq(req, 'crm.write') ? html`<a class="btn primary" href="/customers/new">Add customer</a>` : undefined,
          body: html`
            <form class="filters card" method="get" action="/customers" style="padding:12px" data-autosubmit>
              <div class="field wide"><label for="f_q">Search</label><input id="f_q" type="search" name="q" value="${q ?? ''}" placeholder="Trading or legal name, reference"></div>
              ${select({ name: 'status', label: 'Status', value: status ?? '', blank: 'Any', options: enumOptions(['active', 'prospect', 'inactive']) })}
              <button class="btn" type="submit">Apply</button>
            </form>
            ${card({
              tight: true,
              body: table({
                cols: ['Customer', 'Sector', { label: 'Sites', num: true }, { label: 'Open jobs', num: true }, { label: 'Contracts', num: true }, 'Status'],
                rows: rows.map((c) => [
                  html`<a class="rowtitle" href="/customers/${String(c.id)}">${c.trading_name}</a><br><span class="tiny subtle">${c.ref}${c.legal_name && c.legal_name !== c.trading_name ? ` · ${c.legal_name}` : ''}</span>`,
                  c.sector ?? '—',
                  String(c.site_count),
                  c.open_jobs ? html`<a href="/jobs?q=${encodeURIComponent(c.trading_name)}">${String(c.open_jobs)}</a>` : '0',
                  String(c.active_contracts),
                  chip(labelise(c.status), c.status === 'active' ? 'ok' : c.status === 'prospect' ? 'info' : 'neutral'),
                ]),
                empty: 'No customers match.',
              }),
              foot: pagination({ total, limit, offset, base: `/customers?${new URLSearchParams(Object.entries({ q: q ?? '', status: status ?? '' }).filter(([, v]) => v)).toString()}` }),
            })}
          `,
        }),
      );
    }),
  );

  app.get(
    '/customers/new',
    h((req, res) => {
      needCap(req, 'crm.write');
      const ctx = ctxOf(req);
      send(res, page(ctx, { title: 'Add customer', heading: 'Add customer', narrow: true, crumbs: [{ href: '/customers', label: 'Customers' }, { label: 'New' }], body: customerForm(ctx, null, canReq(req, 'crm.billing.write')) }));
    }),
  );

  app.post(
    '/customers',
    h((req, res) => {
      const id = CRM.saveCustomer(db, actorOf(req), req.body);
      ok(res, `/customers/${id}`, 'Customer added.');
    }),
  );

  app.get(
    '/customers/:id',
    h((req, res) => {
      needCap(req, 'crm.read');
      const ctx = ctxOf(req);
      const id = intParam(req);
      const customer = CRM.getCustomer(db, id);
      const sites = CRM.sitesForCustomer(db, id);
      const contacts = CRM.contactsFor(db, id);
      const contracts = CRM.contractsForCustomer(db, id);
      const history = CRM.workHistory(db, { customerId: id }, 25);
      const opportunities = can(ctx.user, 'quote.read') ? Q.listOpportunities(db, { customerId: id, limit: 20 }).rows : [];
      const interaction = intQuery(req, 'ai') ? loadInteraction(db, intQuery(req, 'ai')!, ctx.user.id) : null;
      const openJobs = history.filter((j) => J.OPEN_STATUSES.includes(j.op_status as J.OpStatus));

      send(
        res,
        page(ctx, {
          title: customer.trading_name,
          heading: customer.trading_name,
          headingChips: html`${chip(labelise(customer.status), customer.status === 'active' ? 'ok' : 'neutral')}`,
          crumbs: [{ href: '/customers', label: 'Customers' }, { label: customer.ref }],
          sub: html`${customer.legal_name ? `${customer.legal_name} · ` : ''}${customer.sector ?? ''}`,
          actions: html`${aiButtons(ctx, { entity: 'customer', id, tasks: ['summarise_history'], back: `/customers/${id}` })}
            ${canReq(req, 'crm.write') ? html`<a class="btn" href="/customers/${String(id)}/edit">Edit</a>` : ''}`,
          body: html`
            ${interaction ? aiPanel(ctx, { interaction, back: `/customers/${id}` }) : ''}
            <div class="grid split">
              <div>
                ${card({
                  title: `Sites (${sites.length})`,
                  actions: canReq(req, 'crm.write') ? html`<a class="btn small" href="/customers/${String(id)}/sites/new">Add site</a>` : undefined,
                  tight: true,
                  body: table({
                    cols: ['Site', 'Town / postcode', { label: 'Equipment', num: true }, { label: 'Open jobs', num: true }, 'Access'],
                    rows: sites.map((s) => [
                      html`<a class="rowtitle" href="/sites/${String(s.id)}">${s.name}</a><br><span class="tiny subtle">${s.ref}</span>`,
                      html`${s.town ?? '—'}<br><span class="tiny subtle">${s.postcode ?? ''}</span>`,
                      String(s.asset_count),
                      s.open_jobs ? html`<a href="/jobs?q=${encodeURIComponent(s.name)}">${String(s.open_jobs)}</a>` : '0',
                      html`${s.induction_required ? chip('induction', 'warn') : ''} ${s.access_confirmed_at ? html`<span class="tiny subtle">confirmed ${fmtD(s.access_confirmed_at)}</span>` : chip('unconfirmed', 'warn')}`,
                    ]),
                    empty: 'No sites yet — a job needs a site.',
                  }),
                })}
                ${card({
                  title: 'Work history',
                  tight: true,
                  body: historyTable(history),
                  definition: 'Jobs and their attendances for every site of this customer, most recent first. Records are linked, never duplicated.',
                })}
                ${
                  opportunities.length
                    ? card({
                        title: 'Quotations',
                        tight: true,
                        body: table({
                          cols: ['Ref', 'Title', 'Maturity', 'Latest revision', { label: 'Value (max)', num: true }],
                          rows: opportunities.map((o) => [
                            html`<a class="rowtitle" href="/quotes/${String(o.id)}">${o.ref}</a>`,
                            o.title,
                            chip(labelise(o.maturity), o.maturity === 'awarded' ? 'ok' : o.maturity === 'lost' ? 'neutral' : 'info'),
                            o.latest_rev ? html`rev ${String(o.latest_rev)} ${chip(labelise(o.latest_status), 'neutral')}` : '—',
                            o.latest_total ? `£${(o.latest_total.maxNet / 100).toFixed(2)}` : '—',
                          ]),
                        }),
                      })
                    : ''
                }
              </div>
              <div>
                ${card({
                  title: 'Identity and billing',
                  body: defList(
                    [
                      ['Trading name', customer.trading_name],
                      ['Legal entity', customer.legal_name ?? html`<span class="chip warn">not recorded</span>`],
                      ['Company number', customer.company_number],
                      ['Billing address', prose(customer.billing_address)],
                      ['Billing email', customer.billing_email],
                      ['PO required', customer.po_required ? chip('yes', 'warn') : 'no'],
                      ['Invoice notes', prose(customer.invoice_notes)],
                      ['Account notes', prose(customer.account_notes)],
                    ],
                    true,
                  ),
                  definition: 'Operations use the trading name; finance needs the correct legal and billing entity. They are stored separately and only Finance or a Manager can change the billing identity.',
                })}
                ${card({
                  title: `Contacts (${contacts.length})`,
                  actions: canReq(req, 'crm.write') ? html`<a class="btn small" href="/customers/${String(id)}/contacts/new">Add contact</a>` : undefined,
                  tight: true,
                  body: table({
                    cols: ['Name', 'Role', 'Reach', 'Authority'],
                    rows: contacts.map((c) => [
                      html`${c.name}${c.job_title ? html`<br><span class="tiny subtle">${c.job_title}</span>` : ''}${c.site_name ? html`<br><span class="tiny subtle">${c.site_name}</span>` : ''}`,
                      chip(labelise(c.role_type), 'neutral'),
                      html`<span class="tiny">${[c.phone, c.email].filter(Boolean).join('<br>') ? raw([c.phone, c.email].filter(Boolean).map((x) => String(x)).join('<br>')) : '—'}</span>`,
                      c.can_authorise_spend ? html`${chip('can authorise spend', 'ok')}${c.authority_notes ? html`<br><span class="tiny subtle">${c.authority_notes}</span>` : ''}` : html`<span class="tiny subtle">reporter only</span>`,
                    ]),
                    empty: 'No contacts recorded.',
                  }),
                  definition: 'The person who reports a fault is not necessarily the person who can authorise spending on it.',
                })}
                ${card({
                  title: `Contracts (${contracts.length})`,
                  tight: true,
                  body: contracts.length
                    ? html`${contracts.map(
                        (k) => html`<div class="body" style="border-bottom:1px solid var(--line-2)">
                          <b>${k.ref}</b> ${k.name} ${chip(labelise(k.status), k.status === 'active' ? 'ok' : 'neutral')}
                          <div class="tiny subtle">${fmtD(k.starts_on)} – ${k.ends_on ? fmtD(k.ends_on) : 'open'} · sites: ${k.sites.map((s) => s.name).join(', ') || 'none'}</div>
                          ${k.targets.length
                            ? html`<div class="chips mt1">${k.targets.map((t) => chip(`${t.priority} · respond ${t.response_minutes ?? '—'}m · attend ${t.attendance_minutes ? `${Math.round(t.attendance_minutes / 60)}h` : '—'}${t.resolution_minutes ? ` · resolve ${Math.round(t.resolution_minutes / 60)}h` : ''}`, 'neutral'))}</div>`
                            : ''}
                          ${k.entitlement_notes ? html`<p class="tiny mt1">${k.entitlement_notes}</p>` : ''}
                          <p class="tiny subtle">${k.clock_stop_permitted ? `Clock stops permitted: ${k.clock_stop_terms ?? ''}` : 'Clock stops not permitted.'}</p>
                        </div>`,
                      )}`
                    : empty('No contracts', 'Not every customer has one — authority then comes from a quotation or delegated spend.'),
                })}
                ${
                  openJobs.length
                    ? card({
                        title: `Open work (${openJobs.length})`,
                        tight: true,
                        body: table({
                          cols: ['Job', 'P', 'State'],
                          rows: openJobs.slice(0, 10).map((j) => [html`<a href="/jobs/${String(j.id)}">${j.ref}</a><br><span class="tiny subtle">${j.title}</span>`, priorityChip(j.priority), opChip(j.op_status)]),
                        }),
                      })
                    : ''
                }
              </div>
            </div>
          `,
        }),
      );
    }),
  );

  app.get(
    '/customers/:id/edit',
    h((req, res) => {
      needCap(req, 'crm.write');
      const ctx = ctxOf(req);
      const customer = CRM.getCustomer(db, intParam(req));
      send(
        res,
        page(ctx, {
          title: `Edit ${customer.trading_name}`,
          heading: `Edit ${customer.trading_name}`,
          narrow: true,
          crumbs: [{ href: '/customers', label: 'Customers' }, { href: `/customers/${customer.id}`, label: customer.ref }, { label: 'Edit' }],
          body: customerForm(ctx, customer, canReq(req, 'crm.billing.write')),
        }),
      );
    }),
  );

  app.post(
    '/customers/:id',
    h((req, res) => {
      const id = intParam(req);
      CRM.saveCustomer(db, actorOf(req), req.body, id);
      ok(res, `/customers/${id}`, 'Customer updated.');
    }),
  );

  // ---------------------------------------------------------------- sites
  app.get(
    '/customers/:id/sites/new',
    h((req, res) => {
      needCap(req, 'crm.write');
      const ctx = ctxOf(req);
      const customer = CRM.getCustomer(db, intParam(req));
      send(
        res,
        page(ctx, {
          title: 'Add site',
          heading: `Add site — ${customer.trading_name}`,
          narrow: true,
          crumbs: [{ href: `/customers/${customer.id}`, label: customer.trading_name }, { label: 'New site' }],
          body: siteForm(ctx, customer.id, null),
        }),
      );
    }),
  );

  app.post(
    '/customers/:id/sites',
    h((req, res) => {
      const customerId = intParam(req);
      const id = CRM.saveSite(db, actorOf(req), customerId, req.body);
      ok(res, `/sites/${id}`, 'Site added.');
    }),
  );

  app.get(
    '/sites/:id',
    h((req, res) => {
      const ctx = ctxOf(req);
      const id = intParam(req);
      if (!CRM.canReadSite(db, ctx.user, id)) throw new ForbiddenError('You can only view sites where you have work.');
      const site = CRM.redactSite(db, ctx.user, CRM.getSite(db, id));
      const assets = CRM.assetsForSite(db, id);
      const contacts = CRM.contactsFor(db, site.customer_id!, id);
      const history = CRM.workHistory(db, { siteId: id }, 25);
      const contract = CRM.contractForSite(db, id);
      const interaction = intQuery(req, 'ai') ? loadInteraction(db, intQuery(req, 'ai')!, ctx.user.id) : null;

      const accessBanner = banner(
        'security',
        html`${defList(
          [
            ['Opening hours', site.opening_hours],
            ['Parking / loading', site.parking_loading],
            ['Keys / security', site.redacted ? html`<span class="chip neutral">restricted to operational roles</span>` : prose(site.keys_security)],
            ['Induction / permits', html`${site.induction_required ? chip('required before first visit', 'warn') : ''} ${prose(site.induction_permits)}`],
            ['Roof / plant access', site.roof_plant_access],
            ['Asbestos', site.asbestos_info],
            ['Safeguarding', site.redacted ? html`<span class="chip neutral">restricted</span>` : site.safeguarding],
            ['Restrictions on work', site.work_restrictions],
            ['Access last confirmed', site.access_confirmed_at ? html`${fmtD(site.access_confirmed_at)} <span class="tiny subtle">(${relative(site.access_confirmed_at)})</span>` : html`<span class="chip warn">never confirmed</span>`],
          ],
          true,
        )}`,
        'Access, security and site conditions',
      );

      send(
        res,
        page(ctx, {
          title: site.name!,
          heading: site.name!,
          crumbs: [{ href: '/customers', label: 'Customers' }, { href: `/customers/${site.customer_id}`, label: site.customer_name! }, { label: site.ref! }],
          sub: html`${site.address}${site.town ? `, ${site.town}` : ''}${site.postcode ? `, ${site.postcode}` : ''}${site.area ? ` · ${site.area}` : ''}`,
          actions: html`${aiButtons(ctx, { entity: 'site', id, tasks: ['summarise_history'], back: `/sites/${id}` })}
            ${canReq(req, 'job.create') ? html`<a class="btn primary" href="/jobs/new?site=${String(id)}">Log a call here</a>` : ''}
            ${canReq(req, 'crm.write') ? html`<a class="btn" href="/sites/${String(id)}/edit">Edit</a>` : ''}`,
          body: html`
            ${interaction ? aiPanel(ctx, { interaction, back: `/sites/${id}` }) : ''}
            <div class="grid split">
              <div>
                ${card({
                  title: `Equipment (${assets.length})`,
                  actions: canReq(req, 'crm.write') ? html`<a class="btn small" href="/sites/${String(id)}/assets/new">Add equipment</a>` : undefined,
                  tight: true,
                  body: table({
                    cols: ['Ref', 'Description', 'Make / model', 'Serial', 'Location', 'Status'],
                    rows: assets.map((a) => [
                      html`<a class="rowtitle" href="/assets/${String(a.id)}">${a.ref}</a>`,
                      html`${a.description}<br><span class="tiny subtle">${a.category}</span>`,
                      html`${[a.manufacturer, a.model].filter(Boolean).join(' ') || '—'}${a.refrigerant ? html`<br><span class="tiny subtle">${a.refrigerant}</span>` : ''}`,
                      html`<span class="mono-sm">${a.serial ?? '—'}</span>`,
                      a.location_detail ?? '—',
                      chip(labelise(a.status), a.status === 'in_service' ? 'ok' : 'neutral'),
                    ]),
                    empty: 'No equipment recorded at this site.',
                  }),
                })}
                ${card({ title: 'Work history', tight: true, body: historyTable(history), definition: 'Jobs at this site with their attendances and outcomes, most recent first.' })}
              </div>
              <div>
                ${accessBanner}
                ${contract ? card({ title: 'Contract cover', body: html`<b>${contract.ref}</b> ${contract.name}<br><span class="tiny subtle">${contract.entitlement_notes ?? ''}</span>` }) : banner('warn', 'No active contract covers this site.')}
                ${card({
                  title: 'Site contacts',
                  tight: true,
                  body: table({
                    cols: ['Name', 'Role', 'Reach'],
                    rows: contacts.map((c) => [html`${c.name}${c.can_authorise_spend ? html` ${chip('spend', 'ok')}` : ''}`, chip(labelise(c.role_type), 'neutral'), html`<span class="tiny">${[c.phone, c.email].filter(Boolean).join(' · ') || '—'}</span>`]),
                    empty: 'No contacts.',
                  }),
                })}
                ${canReq(req, 'crm.write')
                  ? card({
                      title: 'Access confirmation',
                      body: form({
                        ctx,
                        action: `/sites/${id}/confirm-access`,
                        submit: 'Record that access details were reconfirmed',
                        submitClass: '',
                        body: html`<p class="tiny subtle">Coordinators reconfirm access because it changes — keys move, inductions lapse, contractors change.</p><input type="hidden" name="__back" value="/sites/${String(id)}">`,
                      }),
                    })
                  : ''}
              </div>
            </div>
          `,
        }),
      );
    }),
  );

  app.get(
    '/sites/:id/edit',
    h((req, res) => {
      needCap(req, 'crm.write');
      const ctx = ctxOf(req);
      const site = CRM.getSite(db, intParam(req));
      send(
        res,
        page(ctx, {
          title: `Edit ${site.name}`,
          heading: `Edit ${site.name}`,
          narrow: true,
          crumbs: [{ href: `/customers/${site.customer_id}`, label: site.customer_name! }, { href: `/sites/${site.id}`, label: site.ref }, { label: 'Edit' }],
          body: siteForm(ctx, site.customer_id, site),
        }),
      );
    }),
  );

  app.post(
    '/sites/:id',
    h((req, res) => {
      const id = intParam(req);
      const site = CRM.getSite(db, id);
      CRM.saveSite(db, actorOf(req), site.customer_id, req.body, id);
      ok(res, `/sites/${id}`, 'Site updated.');
    }),
  );

  app.post(
    '/sites/:id/confirm-access',
    h((req, res) => {
      const id = intParam(req);
      const site = CRM.getSite(db, id);
      CRM.saveSite(db, actorOf(req), site.customer_id, { ...site, confirm_access: 'on' } as Record<string, unknown>, id);
      ok(res, back(req), 'Access details recorded as reconfirmed today.');
    }),
  );

  // ---------------------------------------------------------------- contacts
  app.get(
    '/customers/:id/contacts/new',
    h((req, res) => {
      needCap(req, 'crm.write');
      const ctx = ctxOf(req);
      const customer = CRM.getCustomer(db, intParam(req));
      const sites = CRM.sitesForCustomer(db, customer.id);
      send(
        res,
        page(ctx, {
          title: 'Add contact',
          heading: `Add contact — ${customer.trading_name}`,
          narrow: true,
          crumbs: [{ href: `/customers/${customer.id}`, label: customer.trading_name }, { label: 'New contact' }],
          body: form({
            ctx,
            action: `/customers/${customer.id}/contacts`,
            submit: 'Add contact',
            body: html`<div class="fields cols2">
              ${input({ name: 'name', label: 'Name', required: true, autofocus: true })}
              ${select({ name: 'role_type', label: 'Contact role', required: true, options: enumOptions(CRM.CONTACT_ROLES) })}
              ${input({ name: 'job_title', label: 'Job title' })}
              ${select({ name: 'site_id', label: 'Site (if site-specific)', blank: 'All sites', options: options(sites.map((s) => ({ id: s.id, label: s.name }))) })}
              ${input({ name: 'phone', label: 'Phone' })}
              ${input({ name: 'email', label: 'Email', type: 'email' })}
              ${checkbox({ name: 'can_authorise_spend', label: 'Can authorise spend', hint: 'Reporting a fault is not the same as authorising the repair.' })}
              ${input({ name: 'authority_notes', label: 'Authority notes', placeholder: 'e.g. up to the building PO value' })}
              ${textarea({ name: 'notes', label: 'Notes', rows: 2, span: true })}
            </div>`,
          }),
        }),
      );
    }),
  );

  app.post(
    '/customers/:id/contacts',
    h((req, res) => {
      const customerId = intParam(req);
      CRM.saveContact(db, actorOf(req), customerId, req.body);
      ok(res, `/customers/${customerId}#contacts`, 'Contact added.');
    }),
  );

  // ---------------------------------------------------------------- assets
  app.get(
    '/assets',
    h((req, res) => {
      needCap(req, 'crm.read');
      const ctx = ctxOf(req);
      const limit = 50;
      const offset = intQuery(req, 'offset') ?? 0;
      const q = strQuery(req, 'q');
      const { rows, total } = CRM.listAssets(db, { q, limit, offset });
      send(
        res,
        page(ctx, {
          title: 'Equipment',
          heading: 'Equipment register',
          sub: 'Systems and units we maintain, with the site they belong to and their service history.',
          body: html`
            <form class="filters card" method="get" action="/assets" style="padding:12px">
              <div class="field wide"><label for="f_q">Search</label><input id="f_q" type="search" name="q" value="${q ?? ''}" placeholder="Asset ref, serial, model, manufacturer, site, customer"></div>
              <button class="btn" type="submit">Search</button>
            </form>
            ${card({
              tight: true,
              body: table({
                cols: ['Ref', 'Description', 'Make / model', 'Serial', 'Site', { label: 'Open jobs', num: true }, 'Status'],
                rows: rows.map((a) => [
                  html`<a class="rowtitle" href="/assets/${String(a.id)}">${a.ref}</a>`,
                  html`${a.description}<br><span class="tiny subtle">${a.category}</span>`,
                  [a.manufacturer, a.model].filter(Boolean).join(' ') || '—',
                  html`<span class="mono-sm">${a.serial ?? '—'}</span>`,
                  html`<a href="/sites/${String(a.site_id)}">${a.site_name}</a><br><span class="tiny subtle">${a.customer_name}</span>`,
                  String(a.open_jobs),
                  chip(labelise(a.status), a.status === 'in_service' ? 'ok' : 'neutral'),
                ]),
                empty: 'No equipment matches.',
              }),
              foot: pagination({ total, limit, offset, base: `/assets?${q ? `q=${encodeURIComponent(q)}` : ''}` }),
            })}
          `,
        }),
      );
    }),
  );

  app.get(
    '/sites/:id/assets/new',
    h((req, res) => {
      needCap(req, 'crm.write');
      const ctx = ctxOf(req);
      const site = CRM.getSite(db, intParam(req));
      send(
        res,
        page(ctx, {
          title: 'Add equipment',
          heading: `Add equipment — ${site.name}`,
          narrow: true,
          crumbs: [{ href: `/sites/${site.id}`, label: site.name }, { label: 'New equipment' }],
          body: assetForm(ctx, site.id, null),
        }),
      );
    }),
  );

  app.post(
    '/sites/:id/assets',
    h((req, res) => {
      const siteId = intParam(req);
      const id = CRM.saveAsset(db, actorOf(req), siteId, req.body);
      ok(res, `/assets/${id}`, 'Equipment added.');
    }),
  );

  app.get(
    '/assets/:id',
    h((req, res) => {
      const ctx = ctxOf(req);
      const id = intParam(req);
      const asset = CRM.getAsset(db, id);
      if (!CRM.canReadSite(db, ctx.user, asset.site_id)) throw new ForbiddenError('You can only view equipment at sites where you have work.');
      const history = CRM.workHistory(db, { assetId: id }, 30);
      const readings = db
        .prepare(
          `SELECT r.name, r.value, r.unit, r.recorded_at, a.ref AS attendance_ref, u.display_name AS engineer FROM readings r JOIN attendances a ON a.id = r.attendance_id
           JOIN users u ON u.id = a.engineer_user_id WHERE r.asset_id = ? ORDER BY r.recorded_at DESC LIMIT 20`,
        )
        .all(id) as { name: string; value: string; unit: string | null; recorded_at: string; attendance_ref: string; engineer: string }[];
      const interaction = intQuery(req, 'ai') ? loadInteraction(db, intQuery(req, 'ai')!, ctx.user.id) : null;

      send(
        res,
        page(ctx, {
          title: `${asset.ref} ${asset.description}`,
          heading: `${asset.ref} — ${asset.description}`,
          headingChips: chip(labelise(asset.status), asset.status === 'in_service' ? 'ok' : 'neutral'),
          crumbs: [{ href: '/assets', label: 'Equipment' }, { href: `/sites/${asset.site_id}`, label: asset.site_name! }, { label: asset.ref }],
          sub: html`<a href="/customers/${String(asset.customer_id)}">${asset.customer_name}</a> · ${asset.site_name}${asset.location_detail ? ` · ${asset.location_detail}` : ''}`,
          actions: html`${aiButtons(ctx, { entity: 'asset', id, tasks: ['summarise_history'], back: `/assets/${id}` })}
            ${canReq(req, 'job.create') ? html`<a class="btn primary" href="/jobs/new?site=${String(asset.site_id)}">Log a call</a>` : ''}`,
          body: html`
            ${interaction ? aiPanel(ctx, { interaction, back: `/assets/${id}` }) : ''}
            <div class="grid split">
              <div>
                ${card({ title: 'Service history', tight: true, body: historyTable(history), definition: 'Every job linked to this equipment, with the attendances, diagnoses and outcomes recorded against them.' })}
                ${readings.length
                  ? card({
                      title: 'Recent readings',
                      tight: true,
                      body: table({
                        cols: ['Reading', 'Value', 'When', 'Attendance'],
                        rows: readings.map((r) => [r.name, html`<b>${r.value}${r.unit ?? ''}</b>`, when(r.recorded_at), html`${r.attendance_ref}<br><span class="tiny subtle">${r.engineer}</span>`]),
                      }),
                    })
                  : ''}
              </div>
              <div>
                ${card({
                  title: 'Identity',
                  body: defList(
                    [
                      ['Internal reference', asset.ref],
                      ['Category', asset.category],
                      ['Manufacturer', asset.manufacturer],
                      ['Model', asset.model],
                      ['Serial number', asset.serial ? html`<span class="mono-sm">${asset.serial}</span>` : null],
                      ['Refrigerant', asset.refrigerant],
                      ['Installed', asset.install_date ? fmtD(asset.install_date) : null],
                      ['Location on site', asset.location_detail],
                      ['Ownership', asset.ownership_note ? html`${asset.ownership_note}` : html`<span class="subtle">Assumed customer-owned; not separately recorded.</span>`],
                      ['Notes', prose(asset.notes)],
                    ],
                    true,
                  ),
                  definition: 'Manufacturer, model, serial and our own reference are what engineers need to identify parts. Equipment ownership can differ from the site occupier.',
                })}
                ${canReq(req, 'crm.write') ? card({ title: 'Edit', body: assetForm(ctx, asset.site_id, asset) }) : ''}
                ${canReq(req, 'audit.read') ? card({ title: 'Audit', tight: true, body: drawer({ summary: 'Show audit trail', body: auditTable(auditFor(db, 'asset', id)) }) }) : ''}
              </div>
            </div>
          `,
        }),
      );
    }),
  );

  app.post(
    '/assets/:id',
    h((req, res) => {
      const id = intParam(req);
      const asset = CRM.getAsset(db, id);
      CRM.saveAsset(db, actorOf(req), asset.site_id, req.body, id);
      ok(res, `/assets/${id}`, 'Equipment updated.');
    }),
  );
};

// ---------------------------------------------------------------- shared pieces

function historyTable(history: ReturnType<typeof CRM.workHistory>): SafeHtml {
  if (!history.length) return empty('No work recorded yet');
  return html`<div class="tablewrap"><table class="data">
    <thead><tr><th>Job</th><th>Received</th><th>P</th><th>What happened</th><th>State</th></tr></thead>
    <tbody>
      ${history.map(
        (j) => html`<tr>
          <td><a class="rowtitle" href="/jobs/${String(j.id)}">${j.ref}</a><br><span class="tiny subtle">${j.site_name}</span></td>
          <td class="nowrap">${when(j.received_at)}</td>
          <td>${priorityChip(j.priority)}</td>
          <td>
            <b>${j.title}</b>${j.reported_symptom ? html`<br><span class="tiny subtle">${j.reported_symptom.slice(0, 140)}</span>` : ''}
            ${j.attendances.map(
              (a) => html`<br><span class="tiny">· ${a.ref} ${a.engineer_name}${a.outcome ? ` — ${labelise(a.outcome)}` : ` — ${labelise(a.status)}`}${a.diagnosis ? `: ${a.diagnosis}` : a.work_done ? `: ${a.work_done}` : ''}</span>`,
            )}
          </td>
          <td>${opChip(j.op_status)}<br>${finChip(j.financial_status)}<br>${commChip(j.commercial_status)}</td>
        </tr>`,
      )}
    </tbody>
  </table></div>`;
}

function customerForm(ctx: Ctx, customer: CRM.Customer | null, billingAllowed: boolean): SafeHtml {
  return form({
    ctx,
    action: customer ? `/customers/${customer.id}` : '/customers',
    submit: customer ? 'Save customer' : 'Add customer',
    body: html`
      ${card({
        title: 'Operational identity',
        body: html`<div class="fields cols2">
          ${input({ name: 'trading_name', label: 'Trading name', required: true, value: customer?.trading_name ?? '', autofocus: true })}
          ${input({ name: 'sector', label: 'Sector', value: customer?.sector ?? '', placeholder: 'e.g. Healthcare & care' })}
          ${select({ name: 'status', label: 'Status', options: enumOptions(['active', 'prospect', 'inactive'], undefined, customer?.status ?? 'active') })}
          ${textarea({ name: 'account_notes', label: 'Account notes', rows: 2, span: true, value: customer?.account_notes ?? '' })}
        </div>`,
      })}
      ${card({
        title: 'Legal and billing identity',
        body: billingAllowed
          ? html`<div class="fields cols2">
              ${input({ name: 'legal_name', label: 'Legal entity name', value: customer?.legal_name ?? '' })}
              ${input({ name: 'company_number', label: 'Company number', value: customer?.company_number ?? '' })}
              ${textarea({ name: 'billing_address', label: 'Billing address', rows: 3, value: customer?.billing_address ?? '' })}
              ${input({ name: 'billing_email', label: 'Billing email', type: 'email', value: customer?.billing_email ?? '' })}
              ${checkbox({ name: 'po_required', label: 'Purchase order required before work', checked: !!customer?.po_required })}
              ${textarea({ name: 'invoice_notes', label: 'Invoicing arrangements', rows: 2, span: true, value: customer?.invoice_notes ?? '' })}
            </div>`
          : html`${banner('info', 'Only Finance or a Manager can change the legal and billing identity. Ask them if it needs correcting.')}
              ${defList([['Legal entity', customer?.legal_name], ['Company number', customer?.company_number], ['Billing address', prose(customer?.billing_address)], ['Billing email', customer?.billing_email]], true)}`,
        definition: 'Operations use the trading name; finance needs the correct legal entity. Multi-site customers can have different PO and invoice arrangements per site.',
      })}
    `,
  });
}

function siteForm(ctx: Ctx, customerId: number, site: CRM.Site | null): SafeHtml {
  return form({
    ctx,
    action: site ? `/sites/${site.id}` : `/customers/${customerId}/sites`,
    submit: site ? 'Save site' : 'Add site',
    body: html`
      ${card({
        title: 'Where it is',
        body: html`<div class="fields cols2">
          ${input({ name: 'name', label: 'Site name', required: true, value: site?.name ?? '', autofocus: true })}
          ${input({ name: 'area', label: 'Area / region', value: site?.area ?? '', placeholder: 'e.g. Greater Manchester', hint: 'Used as a planning signal when assigning engineers.' })}
          ${textarea({ name: 'address', label: 'Address', rows: 2, required: true, value: site?.address ?? '', span: true })}
          ${input({ name: 'town', label: 'Town', value: site?.town ?? '' })}
          ${input({ name: 'postcode', label: 'Postcode', value: site?.postcode ?? '' })}
          ${select({ name: 'status', label: 'Status', options: enumOptions(['active', 'inactive'], undefined, site?.status ?? 'active') })}
          ${input({ name: 'billing_arrangement', label: 'Billing / PO arrangement for this site', value: site?.billing_arrangement ?? '' })}
        </div>`,
      })}
      ${card({
        title: 'Getting in and working safely',
        body: html`<div class="fields cols2">
          ${input({ name: 'opening_hours', label: 'Opening hours', value: site?.opening_hours ?? '' })}
          ${textarea({ name: 'parking_loading', label: 'Parking / loading', rows: 2, value: site?.parking_loading ?? '' })}
          ${textarea({ name: 'keys_security', label: 'Keys / security', rows: 2, value: site?.keys_security ?? '', hint: 'Sensitive: hidden from roles without an operational need.' })}
          ${textarea({ name: 'induction_permits', label: 'Inductions / permits', rows: 2, value: site?.induction_permits ?? '' })}
          ${checkbox({ name: 'induction_required', label: 'Induction or clearance required before first visit', checked: !!site?.induction_required })}
          ${textarea({ name: 'roof_plant_access', label: 'Roof / plant access', rows: 2, value: site?.roof_plant_access ?? '' })}
          ${textarea({ name: 'asbestos_info', label: 'Asbestos information', rows: 2, value: site?.asbestos_info ?? '' })}
          ${textarea({ name: 'safeguarding', label: 'Safeguarding', rows: 2, value: site?.safeguarding ?? '', hint: 'Sensitive: hidden from roles without an operational need.' })}
          ${textarea({ name: 'work_restrictions', label: 'Restrictions on disruptive work', rows: 2, value: site?.work_restrictions ?? '', span: true })}
          ${checkbox({ name: 'confirm_access', label: 'Record that these access details were confirmed today', checked: false })}
        </div>`,
        definition: 'Coordinators reconfirm access because it changes. Engineers see this before they travel.',
      })}
    `,
  });
}

function assetForm(ctx: Ctx, siteId: number, asset: CRM.Asset | null): SafeHtml {
  return form({
    ctx,
    action: asset ? `/assets/${asset.id}` : `/sites/${siteId}/assets`,
    submit: asset ? 'Save equipment' : 'Add equipment',
    body: html`<div class="fields cols2">
      ${input({ name: 'category', label: 'Category', required: true, value: asset?.category ?? '', placeholder: 'e.g. Split AC, Chiller, AHU, Boiler' })}
      ${input({ name: 'description', label: 'Description', required: true, value: asset?.description ?? '', placeholder: 'e.g. Server room split (duty)' })}
      ${input({ name: 'manufacturer', label: 'Manufacturer', value: asset?.manufacturer ?? '' })}
      ${input({ name: 'model', label: 'Model', value: asset?.model ?? '' })}
      ${input({ name: 'serial', label: 'Serial number', value: asset?.serial ?? '' })}
      ${input({ name: 'ref', label: 'Internal asset ID', value: asset?.ref ?? '', hint: asset ? 'Cannot be changed here.' : 'Leave blank to allocate the next one.', disabled: !!asset })}
      ${input({ name: 'location_detail', label: 'Location on site', value: asset?.location_detail ?? '' })}
      ${input({ name: 'refrigerant', label: 'Refrigerant', value: asset?.refrigerant ?? '' })}
      ${input({ name: 'install_date', label: 'Install date', type: 'date', value: asset?.install_date ?? '' })}
      ${select({ name: 'status', label: 'Status', options: enumOptions(CRM.ASSET_STATUSES, undefined, asset?.status ?? 'in_service') })}
      ${textarea({ name: 'ownership_note', label: 'Ownership note', rows: 2, span: true, value: asset?.ownership_note ?? '', placeholder: 'e.g. Tenant-owned; maintained under service charge' })}
      ${textarea({ name: 'notes', label: 'Notes', rows: 2, span: true, value: asset?.notes ?? '' })}
    </div>`,
  });
}

export default register;
