import { html } from '../../lib/html.ts';
import { fmtD } from '../../lib/clock.ts';
import { fmtMoney } from '../../lib/money.ts';
import { APPROVAL_ACTIONS, ROLE_LABEL, ROLES } from '../../auth/policy.ts';
import * as Admin from '../../domain/admin.ts';
import * as Sched from '../../domain/scheduling.ts';
import * as Inv from '../../domain/inventory.ts';
import * as CRM from '../../domain/crm.ts';
import { banner, card, checkbox, chip, drawer, form, input, labelise, money, options, page, select, table, textarea } from '../ui.ts';
import { actorOf, back, canReq, ctxOf, h, intParam, needCap, ok, type RouteModule, send } from '../kit.ts';

const register: RouteModule = (app, { db }) => {
  app.get(
    '/admin',
    h((req, res) => {
      needCap(req, 'admin.config');
      const ctx = ctxOf(req);
      const users = Admin.listUsers(db);
      const policies = Admin.listPolicies(db);
      const settings = Admin.listSettings(db);
      const codes = Admin.listOutcomeCodes(db);
      const locations = Inv.locations(db);
      const isAdmin = canReq(req, 'admin.users');

      send(
        res,
        page(ctx, {
          title: 'Administration',
          heading: 'Administration',
          sub: 'People, approval policy, planning settings and configurable vocabularies.',
          body: html`
            <div class="grid split">
              <div>
                ${card({
                  title: `People (${users.length})`,
                  tight: true,
                  actions: isAdmin ? html`<a class="btn small primary" href="/admin/users/new">Add person</a>` : undefined,
                  body: table({
                    cols: ['Name', 'Username', 'Role', 'Planning data', 'Active', ''],
                    rows: users.map((u) => [
                      html`${u.display_name}<br><span class="tiny subtle">${u.email ?? ''}</span>`,
                      html`<span class="mono-sm">${u.username}</span>`,
                      chip(ROLE_LABEL[u.role], 'neutral'),
                      html`<span class="tiny">${[u.home_area, u.van_code ? `van ${u.van_code}` : '', u.planning_notes].filter(Boolean).join(' · ') || '—'}</span>`,
                      u.active ? chip('active', 'ok') : chip('disabled', 'neutral'),
                      isAdmin ? html`<a class="btn small" href="/admin/users/${String(u.id)}">Edit</a>` : '',
                    ]),
                  }),
                })}
                ${card({
                  title: 'Approval policy',
                  tight: true,
                  body: html`
                    ${banner(
                      'warn',
                      'Discovery did not establish FrostLine’s delegated monetary authority, so no thresholds are configured. Where a limit is blank the role may approve at any value — set limits here once the business has decided them.',
                      'Thresholds are a governance decision',
                    )}
                    ${table({
                      cols: ['Action', 'Role', 'Limit', 'Note'],
                      rows: policies.map((p) => [
                        html`${APPROVAL_ACTIONS[p.action] ?? p.action}<br><span class="tiny subtle mono-sm">${p.action}</span>`,
                        ROLE_LABEL[p.role] ?? p.role,
                        p.max_value_pence === null ? chip('no limit configured', 'warn') : html`<b>${fmtMoney(p.max_value_pence)}</b>`,
                        html`<span class="tiny subtle">${p.notes ?? ''}</span>`,
                      ]),
                      empty: 'No approval policy configured — nobody can approve anything.',
                    })}
                    ${drawer({
                      summary: 'Add or change a policy row',
                      body: form({
                        ctx,
                        action: '/admin/policies',
                        submit: 'Save policy',
                        body: html`<div class="fields cols2">
                            ${select({ name: 'action', label: 'Action', required: true, options: Object.entries(APPROVAL_ACTIONS).map(([k, v]) => ({ value: k, label: v })) })}
                            ${select({ name: 'role', label: 'Role', required: true, options: ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] })) })}
                            ${money({ name: 'max_value', label: 'Maximum value (blank = no limit)' })}
                          </div>
                          ${input({ name: 'notes', label: 'Governance note / decision reference', required: true })}
                          ${checkbox({ name: 'remove', label: 'Remove this role’s permission for the action instead' })}
                          <input type="hidden" name="__back" value="/admin">`,
                      }),
                    })}
                  `,
                  definition: 'A role may approve an action only if it appears here. A blank limit means no monetary threshold has been configured, not that one does not exist.',
                })}
                ${card({
                  title: 'Attendance outcome codes',
                  tight: true,
                  body: html`${table({
                    cols: ['Code', 'Label', 'Forces follow-on', 'Temporary', 'Counts as resolved', 'Active'],
                    rows: codes.map((c) => [
                      html`<span class="mono-sm">${c.code}</span>`,
                      c.label,
                      c.requires_followon ? chip('yes', 'warn') : 'no',
                      c.temporary ? chip('yes', 'warn') : 'no',
                      c.resolves ? chip('yes', 'ok') : 'no',
                      c.active ? chip('active', 'ok') : chip('hidden', 'neutral'),
                    ]),
                  })}
                  ${drawer({
                    summary: 'Rename or hide a code',
                    body: form({
                      ctx,
                      action: '/admin/outcome-codes',
                      submit: 'Save code',
                      body: html`<div class="fields cols2">
                          ${select({ name: 'code', label: 'Code', required: true, options: codes.map((c) => ({ value: c.code, label: `${c.code} — ${c.label}` })) })}
                          ${input({ name: 'label', label: 'Label shown to engineers', required: true })}
                        </div>
                        ${checkbox({ name: 'active', label: 'Available to engineers', checked: true })}
                        <input type="hidden" name="__back" value="/admin">`,
                    }),
                  })}`,
                  definition: 'Outcome codes are configuration derived from the discovered list of honest outcomes. Their behaviour flags (follow-on, temporary) are fixed because the business rules depend on them.',
                })}
              </div>
              <div>
                ${card({
                  title: 'Settings',
                  tight: true,
                  body: html`${table({
                    cols: ['Setting', 'Value'],
                    rows: settings.map((s) => [html`${Admin.EDITABLE_SETTINGS[s.key] ?? s.key}<br><span class="tiny subtle mono-sm">${s.key}</span>`, html`<b>${s.value}</b>`]),
                  })}
                  ${drawer({
                    summary: 'Change a setting',
                    body: form({
                      ctx,
                      action: '/admin/settings',
                      submit: 'Save setting',
                      body: html`${select({ name: 'key', label: 'Setting', required: true, options: Object.entries(Admin.EDITABLE_SETTINGS).map(([k, v]) => ({ value: k, label: v })) })}
                        ${input({ name: 'value', label: 'Value', required: true })}
                        <input type="hidden" name="__back" value="/admin">`,
                    }),
                  })}`,
                })}
                ${card({
                  title: 'Stock locations',
                  tight: true,
                  body: table({
                    cols: ['Code', 'Name', 'Kind', 'Engineer'],
                    rows: locations.map((l) => [html`<span class="mono-sm">${l.code}</span>`, l.name, chip(labelise(l.kind), 'neutral'), l.engineer_name ?? '—']),
                  }),
                })}
                ${card({
                  title: 'Where the rest is configured',
                  body: html`<ul class="tiny" style="margin-left:16px">
                    <li>Contract targets and clock-stop permissions live on the customer’s contract record.</li>
                    <li>Engineer competences and site clearances are on each person’s admin page.</li>
                    <li>Job types, waiting dependencies, authority bases and stock states are part of the domain model and change with the code.</li>
                  </ul>`,
                })}
              </div>
            </div>
          `,
        }),
      );
    }),
  );

  app.get(
    '/admin/users/new',
    h((req, res) => {
      needCap(req, 'admin.users');
      const ctx = ctxOf(req);
      send(res, page(ctx, { title: 'Add person', heading: 'Add person', narrow: true, crumbs: [{ href: '/admin', label: 'Administration' }, { label: 'New' }], body: userForm(ctx, null, Inv.locations(db)) }));
    }),
  );

  app.get(
    '/admin/users/:id',
    h((req, res) => {
      needCap(req, 'admin.users');
      const ctx = ctxOf(req);
      const id = intParam(req);
      const user = Admin.getUser(db, id);
      const competences = Sched.competencesFor(db, id);
      const clearances = Sched.clearancesFor(db, id);
      const sites = CRM.listCustomers(db, { limit: 500 }).rows.flatMap((c) => CRM.sitesForCustomer(db, c.id).map((s) => ({ id: s.id, label: `${c.trading_name} — ${s.name}` })));

      send(
        res,
        page(ctx, {
          title: user.display_name,
          heading: user.display_name,
          headingChips: html`${chip(ROLE_LABEL[user.role], 'neutral')} ${user.active ? chip('active', 'ok') : chip('disabled', 'neutral')}`,
          crumbs: [{ href: '/admin', label: 'Administration' }, { label: user.display_name }],
          narrow: true,
          body: html`
            ${card({ title: 'Details', body: userForm(ctx, user, Inv.locations(db)) })}
            ${
              user.role === 'engineer'
                ? html`
                    ${card({
                      title: 'Competences and authorisations',
                      tight: true,
                      body: html`${table({
                        cols: ['Tag', 'Detail', 'Valid to', ''],
                        rows: competences.map((c) => [
                          html`<span class="mono-sm">${c.tag}</span>`,
                          html`${c.detail ?? '—'}${c.notes ? html`<br><span class="tiny subtle">${c.notes}</span>` : ''}`,
                          c.valid_to ? html`${fmtD(c.valid_to)}${c.valid_to < new Date().toISOString().slice(0, 10) ? html` ${chip('expired', 'danger')}` : ''}` : html`<span class="subtle">no expiry</span>`,
                          form({ ctx, action: `/admin/competences/${c.id}/delete`, body: html`<input type="hidden" name="__back" value="/admin/users/${String(user.id)}">`, submit: 'Remove', submitClass: 'small danger' }),
                        ]),
                        empty: 'None recorded — the planner will warn on every competence requirement.',
                      })}
                      ${drawer({
                        summary: 'Add a competence',
                        body: form({
                          ctx,
                          action: `/admin/users/${user.id}/competences`,
                          submit: 'Add competence',
                          body: html`<div class="fields cols2">
                              ${input({ name: 'tag', label: 'Tag', required: true, placeholder: 'e.g. fgas, gas-commercial, vrf-mitsubishi', hint: 'Matched against the competences a job requires.' })}
                              ${input({ name: 'detail', label: 'Detail', placeholder: 'e.g. F-Gas Category 1' })}
                              ${input({ name: 'valid_from', label: 'Valid from', type: 'date' })}
                              ${input({ name: 'valid_to', label: 'Valid to', type: 'date' })}
                            </div>
                            ${input({ name: 'notes', label: 'Notes' })}
                            <input type="hidden" name="__back" value="/admin/users/${String(user.id)}">`,
                        }),
                      })}`,
                      definition: 'Tags are free text on purpose: discovery did not establish a universal competence taxonomy, so planners match what FrostLine actually records.',
                    })}
                    ${card({
                      title: 'Site clearances',
                      tight: true,
                      body: html`${table({
                        cols: ['Site', 'Detail', 'Valid to'],
                        rows: clearances.map((c) => [html`<a href="/sites/${String(c.site_id)}">${c.site_name}</a>`, c.detail ?? '—', c.valid_to ? html`${fmtD(c.valid_to)}${c.valid_to < new Date().toISOString().slice(0, 10) ? html` ${chip('expired', 'danger')}` : ''}` : '—']),
                        empty: 'No site clearances recorded.',
                      })}
                      ${drawer({
                        summary: 'Add a site clearance',
                        body: form({
                          ctx,
                          action: `/admin/users/${user.id}/clearances`,
                          submit: 'Add clearance',
                          body: html`${select({ name: 'site_id', label: 'Site', required: true, options: options(sites) })}
                            <div class="fields cols2">${input({ name: 'detail', label: 'Detail', placeholder: 'e.g. Lab safety induction' })}${input({ name: 'valid_to', label: 'Valid to', type: 'date' })}</div>
                            <input type="hidden" name="__back" value="/admin/users/${String(user.id)}">`,
                        }),
                      })}`,
                    })}
                  `
                : ''
            }
          `,
        }),
      );
    }),
  );

  app.post(
    '/admin/users',
    h((req, res) => {
      const id = Admin.saveUser(db, actorOf(req), req.body);
      ok(res, `/admin/users/${id}`, 'Person added.');
    }),
  );
  app.post(
    '/admin/users/:id',
    h((req, res) => {
      const id = intParam(req);
      Admin.saveUser(db, actorOf(req), req.body, id);
      ok(res, `/admin/users/${id}`, 'Person updated.');
    }),
  );
  app.post(
    '/admin/users/:id/competences',
    h((req, res) => {
      const id = intParam(req);
      Admin.addCompetence(db, actorOf(req), id, req.body);
      ok(res, back(req), 'Competence recorded.');
    }),
  );
  app.post(
    '/admin/competences/:id/delete',
    h((req, res) => {
      Admin.removeCompetence(db, actorOf(req), intParam(req));
      ok(res, back(req), 'Competence removed.');
    }),
  );
  app.post(
    '/admin/users/:id/clearances',
    h((req, res) => {
      const id = intParam(req);
      Admin.addClearance(db, actorOf(req), id, req.body);
      ok(res, back(req), 'Site clearance recorded.');
    }),
  );
  app.post(
    '/admin/policies',
    h((req, res) => {
      Admin.savePolicy(db, actorOf(req), req.body);
      ok(res, back(req), 'Approval policy updated.');
    }),
  );
  app.post(
    '/admin/settings',
    h((req, res) => {
      Admin.saveSetting(db, actorOf(req), req.body);
      ok(res, back(req), 'Setting saved.');
    }),
  );
  app.post(
    '/admin/outcome-codes',
    h((req, res) => {
      Admin.saveOutcomeCode(db, actorOf(req), req.body);
      ok(res, back(req), 'Outcome code updated.');
    }),
  );
};

function userForm(ctx: Parameters<typeof form>[0]['ctx'], user: Admin.UserRow | null, locations: ReturnType<typeof Inv.locations>) {
  return form({
    ctx,
    action: user ? `/admin/users/${user.id}` : '/admin/users',
    submit: user ? 'Save person' : 'Add person',
    body: html`<div class="fields cols2">
      ${input({ name: 'display_name', label: 'Name', required: true, value: user?.display_name ?? '' })}
      ${input({ name: 'username', label: 'Username', required: true, value: user?.username ?? '' })}
      ${input({ name: 'email', label: 'Email', type: 'email', value: user?.email ?? '' })}
      ${input({ name: 'phone', label: 'Phone', value: user?.phone ?? '' })}
      ${select({ name: 'role', label: 'Role', required: true, options: ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r], selected: user?.role === r })) })}
      ${input({ name: 'password', label: user ? 'Set a new password (optional)' : 'Initial password', type: 'password', required: !user, hint: user ? 'Changing it signs them out everywhere.' : 'At least 8 characters.' })}
      ${input({ name: 'home_area', label: 'Home area (engineers)', value: user?.home_area ?? '', placeholder: 'e.g. Greater Manchester' })}
      ${select({ name: 'van_location_id', label: 'Van stock location (engineers)', blank: 'None', options: options(locations.filter((l) => l.kind === 'van').map((l) => ({ id: l.id, label: `${l.code} — ${l.name}` })), user?.van_location_id ?? null) })}
      ${textarea({ name: 'planning_notes', label: 'Planning notes', rows: 2, span: true, value: user?.planning_notes ?? '' })}
      ${checkbox({ name: 'active', label: 'Active (can sign in)', checked: user ? !!user.active : true })}
    </div>`,
  });
}

export default register;
