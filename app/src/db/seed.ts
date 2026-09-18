import type { DB } from './db.ts';
import { hashPassword } from '../auth/auth.ts';
import type { Actor, Role } from '../auth/policy.ts';
import { clock, MIN, HOUR, DAY, toLocalInput } from '../lib/clock.ts';
import { nextRef } from '../lib/refs.ts';
import * as jobs from '../domain/jobs.ts';
import * as sched from '../domain/scheduling.ts';
import * as att from '../domain/attendance.ts';
import * as sla from '../domain/sla.ts';
import * as quotes from '../domain/quotes.ts';
import * as inv from '../domain/inventory.ts';

export const DEMO_PASSWORD = 'frostline';

/**
 * Deterministic FrostLine demo dataset (US-001, NFR-008). Reference data is inserted directly;
 * operational history is produced by running the real domain services as the right users with
 * the server clock moved to the moment each thing happened, so audit trails, SLA events, stock
 * movements and custody records are all internally consistent.
 *
 * All customers, people and sites are fictional. Contract targets below are demo contract data,
 * not FrostLine business rules; approval thresholds are deliberately left unset (DISC-D008).
 */
export function seed(db: DB, opts: { now?: Date } = {}) {
  const realNow = opts.now ?? new Date();
  const NOW = new Date(Math.floor(realNow.getTime() / (5 * MIN)) * 5 * MIN);
  const iso = (offsetMin: number) => new Date(NOW.getTime() + offsetMin * MIN).toISOString();
  const local = (offsetMin: number) => toLocalInput(iso(offsetMin));
  const at = <T>(offsetMin: number, fn: () => T): T => {
    clock.set(new Date(NOW.getTime() + offsetMin * MIN));
    return fn();
  };
  const created = new Date(NOW.getTime() - 400 * DAY).toISOString();

  try {
    // ---------------------------------------------------------------- configuration
    const settings: [string, string, string][] = [
      ['sla_at_risk_fraction', '0.25', 'Fraction of an SLA window remaining below which a target is shown "at risk" (0–1).'],
      ['planning_day_minutes', '600', 'Planning guide for booked minutes per engineer per day before a working-time warning.'],
      ['default_payment_terms', '30 days from invoice date', 'Default payment terms text for new quotation drafts.'],
      ['default_acceptance_method', 'Signed acceptance form or written purchase order quoting the quotation number and revision', 'Default acceptance method text for new quotation drafts.'],
    ];
    const st = db.prepare('INSERT INTO settings (key, value, description) VALUES (?, ?, ?)');
    for (const s of settings) st.run(...s);

    const outcomes: [string, string, number, number, number][] = [
      ['completed', 'Completed — authorised work done', 0, 0, 1],
      ['maintenance_completed', 'Planned maintenance completed', 0, 0, 1],
      ['partial', 'Partially completed', 1, 0, 0],
      ['diagnosis_further_work', 'Diagnosis complete — further work required', 1, 0, 0],
      ['temporary_restoration', 'Temporary restoration', 1, 1, 0],
      ['made_safe', 'Made safe', 1, 0, 0],
      ['no_fault_found', 'No fault found', 0, 0, 0],
      ['no_access', 'No access', 1, 0, 0],
      ['missing_parts_tools', 'Missing parts / tools', 1, 0, 0],
      ['scope_authority_changed', 'Scope or authority changed', 1, 0, 0],
      ['specialist_required', 'Specialist required', 1, 0, 0],
      ['stopped_unsafe', 'Stopped — unsafe or outside competence', 1, 0, 0],
    ];
    const oc = db.prepare('INSERT INTO outcome_codes (code, label, requires_followon, temporary, resolves, sort) VALUES (?, ?, ?, ?, ?, ?)');
    outcomes.forEach((o, i) => oc.run(...o, i));

    const pol = db.prepare('INSERT INTO approval_policies (action, role, max_value_pence, notes) VALUES (?, ?, NULL, ?)');
    const polNote = 'Seeded default. No monetary threshold configured — governance decision pending (discovery gap 1).';
    for (const [a, r] of [
      ['quote.approve', 'manager'],
      ['quote.release', 'manager'],
      ['variation.approve', 'manager'],
      ['stock.reallocate', 'manager'],
      ['stock.reallocate', 'warehouse'],
      ['stock.dispose', 'manager'],
    ]) pol.run(a, r, polNote);

    // ---------------------------------------------------------------- people
    const hash = hashPassword(DEMO_PASSWORD);
    const insUser = db.prepare(
      `INSERT INTO users (username, display_name, email, phone, role, password_hash, home_area, planning_notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const people: [string, string, Role, string | null, string | null][] = [
      ['priya', 'Priya Shah', 'admin', null, 'Systems administrator'],
      ['susan', 'Susan Mercer', 'manager', null, 'Director — service & commercial'],
      ['martin', 'Martin Hale', 'manager', null, 'Director — engineering'],
      ['dan', 'Dan Whitaker', 'coordinator', null, 'Service coordinator'],
      ['leanne', 'Leanne Okafor', 'coordinator', null, 'Service coordinator / planner'],
      ['tom', 'Tom Brierley', 'engineer', 'Greater Manchester', 'Senior refrigeration & AC engineer'],
      ['aisha', 'Aisha Rahman', 'engineer', 'Greater Manchester', 'AC & VRF engineer'],
      ['gareth', 'Gareth Lloyd', 'engineer', 'Cheshire', 'Heating & ventilation engineer (commercial gas)'],
      ['kieran', 'Kieran Walsh', 'engineer', 'Lancashire', 'Multi-skilled service engineer'],
      ['sam', 'Sam Dixon', 'engineer', 'West Yorkshire', 'Service engineer (ex-Calder Cooling)'],
      ['jordan', 'Jordan Price', 'engineer', 'Greater Manchester', 'Improver — supervised on refrigeration'],
      ['rachel', 'Rachel Booth', 'estimator', null, 'Estimator'],
      ['owen', 'Owen Clarke', 'project', null, 'Installation project manager'],
      ['mick', 'Mick Taylor', 'warehouse', null, 'Stores & procurement'],
      ['helen', 'Helen Ashworth', 'finance', null, 'Accounts'],
    ];
    const U: Record<string, Actor> = {};
    for (const [u, name, role, area, notes] of people) {
      const r = insUser.run(u, name, `${u}@frostline.example`, '0161 000 0000', role, hash, area, notes, created);
      U[u] = { id: Number(r.lastInsertRowid), role, name };
    }

    // ---------------------------------------------------------------- stock locations & items
    const insLoc = db.prepare('INSERT INTO stock_locations (code, name, kind, engineer_user_id) VALUES (?, ?, ?, ?)');
    const LOC: Record<string, number> = {};
    LOC.WH = Number(insLoc.run('WH-BURY', 'Bury depot stores', 'warehouse', null).lastInsertRowid);
    for (const e of ['tom', 'aisha', 'gareth', 'kieran', 'sam', 'jordan']) {
      const id = Number(insLoc.run(`VAN-${e.toUpperCase()}`, `${U[e].name} van`, 'van', U[e].id).lastInsertRowid);
      LOC[e] = id;
      db.prepare('UPDATE users SET van_location_id = ? WHERE id = ?').run(id, U[e].id);
    }
    const insItem = db.prepare(`INSERT INTO stock_items (sku, name, category, unit, manufacturer, part_number, serial_tracked, min_level, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const itemDefs: [string, string, string, string, string | null, string | null, number, number | null][] = [
      ['CAP-35-5', 'Run capacitor 35+5µF 440V', 'Electrical', 'each', 'Ducati', 'DUC-35/5', 0, 10],
      ['CAP-10', 'Fan capacitor 10µF 450V', 'Electrical', 'each', 'Ducati', 'DUC-10', 0, 10],
      ['CON-3P-25A', 'Contactor 3-pole 25A 230V coil', 'Electrical', 'each', 'Schneider', 'LC1D25P7', 0, 6],
      ['FLT-G4-592', 'Panel filter G4 592×592×48', 'Filters', 'each', 'Camfil', '30/30-592', 0, 40],
      ['FLT-BAG-F7', 'Bag filter F7 592×592 6-pocket', 'Filters', 'each', 'Camfil', 'Hi-Flo F7', 0, 12],
      ['BELT-SPZ1250', 'V-belt SPZ 1250', 'Mechanical', 'each', 'Gates', 'SPZ1250', 0, 6],
      ['PMP-MINI-OR', 'Condensate pump mini orange', 'Pumps', 'each', 'Aspen', 'FP2212', 0, 4],
      ['DRIER-083', 'Filter drier 3/8 flare 083', 'Refrigeration', 'each', 'Danfoss', 'DML083', 0, 8],
      ['TXV-TES2', 'Expansion valve TES2 R404A body', 'Refrigeration', 'each', 'Danfoss', '068Z3403', 0, 2],
      ['PSW-HP', 'High pressure switch auto reset', 'Refrigeration', 'each', 'Danfoss', 'KP5', 0, 3],
      ['REF-R32-9', 'Refrigerant R32 9kg cylinder', 'Refrigerant', 'cyl', 'A-Gas', 'R32-9', 1, 2],
      ['REF-R410A-10', 'Refrigerant R410A 10kg cylinder', 'Refrigerant', 'cyl', 'A-Gas', 'R410A-10', 1, 2],
      ['MTR-EC-250', 'EC fan motor 250mm 230V', 'Motors', 'each', 'ebm-papst', 'W3G250', 1, 1],
      ['MTR-AHU-4KW', 'AHU fan motor 4kW 4-pole IE3', 'Motors', 'each', 'WEG', 'W22-4KW', 1, null],
      ['PCB-DAI-OUT', 'Daikin outdoor PCB (FTXM/RXM)', 'Controls', 'each', 'Daikin', '2P479216', 1, null],
      ['STAT-DIG', 'Digital room thermostat', 'Controls', 'each', 'Honeywell', 'T6360', 0, 4],
      ['CU-14-15M', 'Copper pipe 1/4" 15m coil', 'Pipework', 'coil', 'Wieland', 'CU14', 0, 3],
      ['INS-13-12', 'Pipe insulation 13mm wall 12mm bore (2m)', 'Pipework', 'length', 'Armacell', 'AF-13-12', 0, 20],
      ['FUSE-10A', 'Fuse 10A ceramic 20mm', 'Electrical', 'each', null, null, 0, 20],
      ['GAS-VLV-20', 'Gas solenoid valve 20mm', 'Heating', 'each', 'Dungs', 'MVD210', 0, 1],
      ['BRN-IGN', 'Burner ignition electrode set', 'Heating', 'each', 'Riello', '3013800', 0, 2],
      ['CU-COMP-SH', 'Compressor contactor & overload kit (cold room)', 'Refrigeration', 'kit', 'Danfoss', 'CI-6.5', 0, null],
    ];
    const I: Record<string, number> = {};
    for (const d of itemDefs) I[d[0]] = Number(insItem.run(...d, created).lastInsertRowid);

    // Opening balances are recorded as receipts so the movement ledger explains every quantity.
    at(-60 * 24 * 30, () => {
      const lines: [string, number][] = [
        ['CAP-35-5', 18], ['CAP-10', 24], ['CON-3P-25A', 8], ['FLT-G4-592', 120], ['FLT-BAG-F7', 24], ['BELT-SPZ1250', 10], ['PMP-MINI-OR', 6],
        ['DRIER-083', 14], ['TXV-TES2', 2], ['PSW-HP', 5], ['REF-R32-9', 4], ['REF-R410A-10', 3], ['MTR-EC-250', 3], ['MTR-AHU-4KW', 1],
        ['STAT-DIG', 6], ['CU-14-15M', 5], ['INS-13-12', 40], ['FUSE-10A', 60], ['GAS-VLV-20', 2], ['BRN-IGN', 3],
      ];
      inv.receiveGoods(db, U.mick, {
        supplier: 'Opening balance (stock count)',
        po_ref: 'STOCKTAKE',
        location_id: String(LOC.WH),
        notes: 'Opening balance from annual stock count spreadsheet',
        line_item_id: lines.map(([s]) => String(I[s])),
        line_qty_received: lines.map(([, q]) => String(q)),
        line_condition: lines.map(() => 'good'),
      });
      // Van replenishment
      const vanLoad: [string, string, number][] = [
        ['tom', 'CAP-35-5', 3], ['tom', 'CAP-10', 3], ['tom', 'CON-3P-25A', 2], ['tom', 'DRIER-083', 3], ['tom', 'FUSE-10A', 10], ['tom', 'PSW-HP', 1],
        ['aisha', 'CAP-35-5', 3], ['aisha', 'CAP-10', 3], ['aisha', 'PMP-MINI-OR', 2], ['aisha', 'FUSE-10A', 10], ['aisha', 'INS-13-12', 6],
        ['gareth', 'BELT-SPZ1250', 2], ['gareth', 'FLT-G4-592', 12], ['gareth', 'BRN-IGN', 1], ['gareth', 'STAT-DIG', 1], ['gareth', 'FUSE-10A', 10],
        ['kieran', 'CAP-35-5', 2], ['kieran', 'FLT-G4-592', 8], ['kieran', 'PMP-MINI-OR', 1], ['kieran', 'FUSE-10A', 10],
        ['sam', 'CAP-35-5', 2], ['sam', 'CAP-10', 2], ['sam', 'FLT-G4-592', 8], ['sam', 'FUSE-10A', 10],
        ['jordan', 'FLT-G4-592', 10], ['jordan', 'FUSE-10A', 6],
      ];
      for (const [e, sku, q] of vanLoad) inv.transfer(db, U.mick, { item_id: String(I[sku]), from_location_id: String(LOC.WH), to_location_id: String(LOC[e]), qty: String(q), reason: 'Van replenishment' });
    });

    // ---------------------------------------------------------------- customers, sites, contacts, assets
    const insCust = db.prepare(
      `INSERT INTO customers (ref, trading_name, legal_name, company_number, billing_address, billing_email, invoice_notes, po_required, sector, status, account_notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insSite = db.prepare(
      `INSERT INTO sites (customer_id, ref, name, address, town, postcode, area, opening_hours, parking_loading, keys_security, induction_permits, induction_required,
         roof_plant_access, asbestos_info, safeguarding, work_restrictions, billing_arrangement, access_confirmed_at, created_at, updated_at)
       VALUES (@customer_id, @ref, @name, @address, @town, @postcode, @area, @opening_hours, @parking_loading, @keys_security, @induction_permits, @induction_required,
         @roof_plant_access, @asbestos_info, @safeguarding, @work_restrictions, @billing_arrangement, @access_confirmed_at, @created, @created)`,
    );
    const insContact = db.prepare(
      `INSERT INTO contacts (customer_id, site_id, name, role_type, job_title, phone, email, can_authorise_spend, authority_notes, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insAsset = db.prepare(
      `INSERT INTO assets (site_id, ref, category, description, manufacturer, model, serial, location_detail, refrigerant, install_date, ownership_note, status, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const C: Record<string, number> = {};
    const S: Record<string, number> = {};
    const A: Record<string, number> = {};
    const CT: Record<string, number> = {};
    const customer = (key: string, d: [string, string, string | null, string, string, string | null, number, string, string | null]) => {
      const ref = nextRef(db, 'CUS');
      C[key] = Number(insCust.run(ref, d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7], 'active', d[8], created, created).lastInsertRowid);
    };
    const site = (key: string, cust: string, d: Partial<Record<string, string | number | null>>) => {
      S[key] = Number(
        insSite.run({
          customer_id: C[cust],
          ref: nextRef(db, 'S'),
          town: null,
          area: null,
          opening_hours: null,
          parking_loading: null,
          keys_security: null,
          induction_permits: null,
          induction_required: 0,
          roof_plant_access: null,
          asbestos_info: null,
          safeguarding: null,
          work_restrictions: null,
          billing_arrangement: null,
          access_confirmed_at: iso(-60 * 24 * 40),
          created,
          ...d,
        }).lastInsertRowid,
      );
    };
    const contact = (key: string, cust: string, siteKey: string | null, name: string, role: string, title: string, phone: string, email: string | null, spend = 0, authNotes: string | null = null) => {
      CT[key] = Number(insContact.run(C[cust], siteKey ? S[siteKey] : null, name, role, title, phone, email, spend, authNotes, null, created).lastInsertRowid);
    };
    const asset = (key: string, siteKey: string, d: [string, string, string | null, string | null, string | null, string | null, string | null, string | null], ownership: string | null = null, notes: string | null = null) => {
      A[key] = Number(insAsset.run(S[siteKey], nextRef(db, 'AS', 10000), d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7], ownership, 'in_service', notes, created, created).lastInsertRowid);
    };

    customer('northgate', ['Northgate Property Management', 'Northgate Property Management Ltd', '08812345', 'Accounts Payable, 14 Peter Street, Manchester M2 5GP', 'ap@northgate-pm.example', 'Invoices must quote the building PO. Separate invoice per building.', 1, 'Facilities management', 'Managing agent for several multi-tenanted office buildings. Each building has its own PO and budget holder.']);
    site('albion', 'northgate', { name: 'Albion House', address: '22 Albion Street', town: 'Manchester', postcode: 'M1 5NZ', area: 'Greater Manchester', opening_hours: 'Mon–Fri 07:00–19:00 (security 24h)', parking_loading: 'No on-site parking. NCP Chorlton St 3 min walk; loading bay Albion St 30 min max.', keys_security: 'Sign in at reception; plant room keys in security office key safe K14. Roof access requires security escort.', induction_permits: 'Permit to work for roof plant; hot works permit from building manager.', roof_plant_access: 'Roof via 8th floor plant room, fixed ladder, guarded edges.', asbestos_info: 'Asbestos register at reception. Ceiling tiles 3rd floor presumed ACM — no disturbance.', work_restrictions: 'No noisy work in tenant areas 09:00–17:00.', billing_arrangement: 'PO per building; Albion budget holder: M. Grant.' });
    site('kingsway', 'northgate', { name: 'Kingsway Business Park — Unit 4', address: 'Unit 4, Kingsway Business Park, Oldham Road', town: 'Rochdale', postcode: 'OL16 4NW', area: 'Greater Manchester', opening_hours: 'Mon–Fri 08:00–18:00', parking_loading: 'Visitor bays at front.', keys_security: 'Tenant reception; roof hatch key held by Northgate site manager.', roof_plant_access: 'Roof hatch via internal cat ladder — two-person access.', work_restrictions: 'Tenant is a call centre — minimise noise.' });
    site('stanns', 'northgate', { name: "St Ann's Chambers", address: "5 St Ann's Square", town: 'Manchester', postcode: 'M2 7LP', area: 'Greater Manchester', opening_hours: 'Mon–Fri 08:00–18:00', keys_security: 'Concierge desk; basement plant room key on fob.', asbestos_info: 'Listed building. Basement pipe lagging removed 2019 (cert on file).', work_restrictions: 'Listed building — no fixings to facade.' });
    contact('ng_mgrant', 'northgate', 'albion', 'Michael Grant', 'facilities', 'Building manager, Albion House', '0161 555 0101', 'm.grant@northgate-pm.example', 1, 'Can approve reactive repairs up to the building PO value.');
    contact('ng_proc', 'northgate', null, 'Joanne Kerr', 'procurement', 'Procurement manager', '0161 555 0100', 'procurement@northgate-pm.example', 1, 'Approves quotations and raises POs.');
    contact('ng_security', 'northgate', 'albion', 'Albion security desk', 'site', 'Security (24h)', '0161 555 0199', null);
    contact('ng_finance', 'northgate', null, 'Accounts Payable', 'finance', 'AP team', '0161 555 0120', 'ap@northgate-pm.example');
    contact('ng_ks', 'northgate', 'kingsway', 'Paul Hurst', 'site', 'Site manager, Kingsway', '01706 555 010', 'p.hurst@northgate-pm.example');
    asset('alb_vrf1', 'albion', ['VRF system', 'VRF outdoor unit — floors 1–4', 'Mitsubishi Electric', 'PURY-P400YNW-A', '1234567T', 'Roof, north side', 'R410A', '2016-05-12']);
    asset('alb_vrf2', 'albion', ['VRF system', 'VRF outdoor unit — floors 5–8', 'Mitsubishi Electric', 'PURY-P400YNW-A', '1234871T', 'Roof, north side', 'R410A', '2016-05-12']);
    asset('alb_mr3', 'albion', ['Split AC', 'Meeting room 3.2 wall split', 'Daikin', 'FTXM35R / RXM35R', 'E004512', 'Floor 3 meeting room 3.2', 'R32', '2019-08-20'], 'Tenant-owned (Holt & Partners LLP); maintained by Northgate under service charge.');
    asset('alb_ahu', 'albion', ['AHU', 'Air handling unit — fresh air', 'Swegon', 'GOLD RX 25', 'SW-88231', 'Roof plant room', null, '2016-05-12']);
    asset('alb_boiler', 'albion', ['Boiler', 'Gas boiler 1 of 2', 'Hamworthy', 'Wessex ModuMax 116V', 'HW-55821', 'Roof plant room', null, '2014-03-01']);
    asset('ks_split1', 'kingsway', ['Split AC', 'Server room split (duty)', 'Daikin', 'FTXM50R', 'E009911', 'Server room, ground floor', 'R32', '2021-02-11'], null, 'Critical: call centre IT. Standby unit A-SPLIT2.');
    asset('ks_split2', 'kingsway', ['Split AC', 'Server room split (standby)', 'Daikin', 'FTXM50R', 'E009912', 'Server room, ground floor', 'R32', '2021-02-11']);
    asset('sa_ahu', 'stanns', ['AHU', 'Basement AHU', 'Nuaire', 'XBOXER XBC', 'NU-44120', 'Basement plant room', null, '2012-09-01']);

    customer('pennine', ['Pennine Care Homes', 'Pennine Care Homes Ltd', '06655443', 'Head Office, 3 Mill Lane, Bolton BL1 2AA', 'invoices@penninecare.example', 'Monthly consolidated invoice; home name on each line.', 0, 'Healthcare & care', 'Three residential homes. Vulnerable residents — heating/hot water loss is treated as critical by the customer.']);
    site('oakwood', 'pennine', { name: 'Oakwood Lodge', address: '18 Chorley New Road', town: 'Bolton', postcode: 'BL1 4QR', area: 'Greater Manchester', opening_hours: '24/7 care home', parking_loading: 'Staff car park rear — keep ambulance bay clear.', keys_security: 'Ring bell; sign in; plant room key with duty manager.', safeguarding: 'DBS-checked staff only in resident areas; escort required on residents\' floors.', work_restrictions: 'No isolation of heating/hot water without duty manager agreement; residents\' rooms by appointment.' });
    site('ribble', 'pennine', { name: 'Ribble View', address: '7 Riverside Drive', town: 'Preston', postcode: 'PR1 8BU', area: 'Lancashire', opening_hours: '24/7 care home', keys_security: 'Plant room keys held by maintenance lead (not always on site).', safeguarding: 'DBS-checked staff only; escort in resident areas.', work_restrictions: 'Quiet hours 20:00–08:00.' });
    site('hollins', 'pennine', { name: 'Hollins Park', address: '42 Hollins Road', town: 'Oldham', postcode: 'OL8 3AB', area: 'Greater Manchester', opening_hours: '24/7 care home', safeguarding: 'DBS-checked staff only.' });
    contact('pc_ops', 'pennine', null, 'Denise Parr', 'escalation', 'Operations director', '01204 555 200', 'd.parr@penninecare.example', 1, 'Approves spend over home budget.');
    contact('pc_oak', 'pennine', 'oakwood', 'Grace Ndlovu', 'site', 'Home manager, Oakwood Lodge', '01204 555 210', 'oakwood@penninecare.example', 1, 'Can approve contract-covered repairs and emergency make-safe.');
    contact('pc_rib', 'pennine', 'ribble', 'Lee Marsden', 'facilities', 'Maintenance lead, Ribble View', '01772 555 220', 'ribble@penninecare.example');
    asset('oak_boiler1', 'oakwood', ['Boiler', 'Gas boiler 1 (lead)', 'Remeha', 'Gas 310 Eco Pro 280', 'RM-310-7781', 'Plant room', null, '2015-10-01']);
    asset('oak_boiler2', 'oakwood', ['Boiler', 'Gas boiler 2 (lag)', 'Remeha', 'Gas 310 Eco Pro 280', 'RM-310-7782', 'Plant room', null, '2015-10-01']);
    asset('oak_ahu', 'oakwood', ['Ventilation', 'Kitchen extract fan', 'Nuaire', 'Twinfan TF-4', 'NU-12002', 'Kitchen roof', null, '2015-10-01']);
    asset('rib_boiler', 'ribble', ['Boiler', 'Gas boiler', 'Ideal', 'Evomax 2 150', 'ID-EV-9920', 'Plant room', null, '2018-04-15']);
    asset('rib_ahu', 'ribble', ['Ventilation', 'Laundry extract', 'Vent-Axia', 'ACP 315', 'VA-551', 'Laundry', null, '2018-04-15']);
    asset('hol_boiler', 'hollins', ['Boiler', 'Gas boiler', 'Ideal', 'Evomax 2 120', 'ID-EV-7710', 'Plant room', null, '2017-01-10']);

    customer('mersey', ['Mersey Fresh Foods', 'Mersey Fresh Foods Ltd', '09988776', 'Finance Dept, Speke Distribution Centre, Liverpool L24 8QD', 'purchase.ledger@merseyfresh.example', 'PO mandatory; invoices without PO rejected.', 1, 'Light industrial & warehousing', 'Chilled distribution. Cold room temperature excursions put stock at risk.']);
    site('speke', 'mersey', { name: 'Speke Distribution Centre', address: 'Unit 12, Estuary Commerce Park', town: 'Liverpool', postcode: 'L24 8QD', area: 'Merseyside', opening_hours: '24/7 operation', parking_loading: 'Contractor parking bay 5; do not block dock doors.', keys_security: 'Gatehouse sign-in, hi-vis mandatory; plant compound keys at gatehouse.', induction_permits: 'Site safety & food hygiene induction (30 min) before first visit; permit for work in cold rooms.', induction_required: 1, roof_plant_access: 'Condensing units in ground-level compound.', work_restrictions: 'Coordinate any cold room shutdown with shift manager — stock must be moved first.' });
    contact('mf_shift', 'mersey', 'speke', 'Shift manager (duty)', 'site', 'Duty shift manager', '0151 555 300', null, 0, 'Can authorise make-safe only.');
    contact('mf_eng', 'mersey', 'speke', 'Carl Jennings', 'technical', 'Engineering manager', '0151 555 301', 'c.jennings@merseyfresh.example', 1, 'Approves repairs within contract; quotes above via procurement.');
    contact('mf_proc', 'mersey', null, 'Lisa Moran', 'procurement', 'Buyer', '0151 555 305', 'purchasing@merseyfresh.example', 1);
    asset('sp_cr1', 'speke', ['Refrigeration', 'Cold room 1 condensing unit', 'Bitzer', 'LH84E/4FES-5Y', 'BZ-1188201', 'Compound bay 1', 'R449A', '2017-06-01']);
    asset('sp_cr2', 'speke', ['Refrigeration', 'Cold room 2 condensing unit', 'Bitzer', 'LH84E/4FES-5Y', 'BZ-1188202', 'Compound bay 2', 'R449A', '2017-06-01']);
    asset('sp_cr3', 'speke', ['Refrigeration', 'Cold room 3 condensing unit', 'Bitzer', 'LH104E/4EES-6Y', 'BZ-1190377', 'Compound bay 3', 'R449A', '2019-03-12']);
    asset('sp_evap3', 'speke', ['Refrigeration', 'Cold room 3 evaporator', 'Searle', 'KEC90-6', 'SE-77120', 'Cold room 3', 'R449A', '2019-03-12']);

    customer('harbour', ['Harbour Hotel Group', 'Harbour Hospitality (North) Ltd', '07711223', 'Group Finance, The Quayside Hotel, Salford M50 3AZ', 'finance@harbourhotels.example', null, 1, 'Hospitality & leisure', 'Two hotels. Kitchen extract and guest room comfort are the pressure points.']);
    site('quayside', 'harbour', { name: 'The Quayside Hotel', address: '1 The Quays', town: 'Salford', postcode: 'M50 3AZ', area: 'Greater Manchester', opening_hours: '24/7; kitchen 06:00–23:00', parking_loading: 'Service yard via Broadway; call chief engineer on arrival.', keys_security: 'Chief engineer holds plant keys; guest floors by arrangement only.', work_restrictions: 'Kitchen extract work only 15:00–17:00 or after 23:00.' });
    site('chester', 'harbour', { name: 'Chester Riverside Hotel', address: '12 The Groves', town: 'Chester', postcode: 'CH1 1SD', area: 'Cheshire', opening_hours: '24/7', keys_security: 'Duty manager holds keys.', roof_plant_access: 'AHU in roof plant room via service lift to 5th.' });
    contact('hh_ce', 'harbour', 'quayside', 'Viktor Nowak', 'technical', 'Chief engineer, Quayside', '0161 555 400', 'v.nowak@harbourhotels.example', 1, 'Authorises repairs up to £1,500 (customer statement).');
    contact('hh_gm_ch', 'harbour', 'chester', 'Emma Carr', 'site', 'General manager, Chester', '01244 555 410', 'gm.chester@harbourhotels.example', 0);
    contact('hh_proc', 'harbour', null, 'Group procurement', 'procurement', 'Procurement', '0161 555 402', 'procurement@harbourhotels.example', 1);
    asset('qs_kex', 'quayside', ['Ventilation', 'Kitchen extract fan', 'Elta', 'Revolution EC 500', 'EL-99312', 'Roof above kitchen', null, '2018-11-01']);
    asset('qs_chiller', 'quayside', ['Chiller', 'Air-cooled chiller', 'Carrier', '30RB-262', 'CA-4410982', 'Roof', 'R410A', '2013-04-01']);
    asset('ch_ahu', 'chester', ['AHU', 'Conference suite AHU', 'Systemair', 'Topvex SR11', 'SA-70112', '5th floor plant room', null, '2011-07-01']);

    customer('stwilfrids', ["St Wilfrid's Academy Trust", "St Wilfrid's Catholic Academy Trust", '10223344', 'Trust Business Office, Moorside High, Bury BL9 9QQ', 'finance@stwilfrids.example', 'PO from trust business office required for anything over £500.', 1, 'Education', 'No maintenance contract; reactive and project work. Term-time restrictions.']);
    site('stw_primary', 'stwilfrids', { name: "St Wilfrid's Primary", address: 'Church Lane', town: 'Wigan', postcode: 'WN1 2XY', area: 'Greater Manchester', opening_hours: 'Term: 07:30–17:30; holidays by arrangement', keys_security: 'Caretaker (Mr Hughes) holds keys.', safeguarding: 'DBS required during term; sign in and wear visitor lanyard. No access to classrooms while pupils present unless escorted.', work_restrictions: 'Noisy work outside teaching hours.' });
    site('moorside', 'stwilfrids', { name: 'Moorside High', address: 'Moorside Road', town: 'Bury', postcode: 'BL9 9QQ', area: 'Greater Manchester', opening_hours: 'Term: 07:00–18:00', safeguarding: 'DBS required during term; escorted access.', work_restrictions: 'Exam season (May–June): no noisy work.' });
    contact('stw_caretaker', 'stwilfrids', 'stw_primary', 'Alan Hughes', 'site', 'Caretaker', '01942 555 500', null, 0);
    contact('stw_bm', 'stwilfrids', null, 'Nadia Iqbal', 'procurement', 'Trust business manager', '0161 555 510', 'n.iqbal@stwilfrids.example', 1, 'Approves spend; raises POs.');
    asset('stw_fcu4', 'stw_primary', ['Fan coil', 'Classroom 4 fan coil', 'Daikin', 'FWD04', 'DK-FW-2231', 'Classroom 4 ceiling void', null, '2012-08-01']);
    asset('moor_sci', 'moorside', ['Ventilation', 'Science block extract', 'Vent-Axia', 'Sentinel Totus2', 'VA-3321', 'Science block roof', null, '2014-08-01']);

    customer('calder', ['Calder Valley Business Centre', 'Calder Valley Estates Ltd', '05544332', 'Estate Office, Calder Valley Business Centre, Halifax HX1 1TP', 'accounts@caldervalley.example', null, 0, 'Offices & commercial property', 'Contract transferred from Calder Cooling Services (2021 acquisition).']);
    site('calder_bc', 'calder', { name: 'Calder Valley Business Centre', address: 'Wharf Street', town: 'Halifax', postcode: 'HX1 1TP', area: 'West Yorkshire', opening_hours: 'Mon–Fri 07:30–18:00', keys_security: 'Estate office; roof key on board 3.', roof_plant_access: 'Roof via stair core B; fall-arrest line.' });
    contact('cv_est', 'calder', 'calder_bc', 'Ruth Sutcliffe', 'facilities', 'Estate manager', '01422 555 600', 'r.sutcliffe@caldervalley.example', 1);
    asset('cv_vrf', 'calder_bc', ['VRF system', 'VRF outdoor unit — east wing', 'Mitsubishi Electric', 'PUHY-P300YNW-A', 'ME-3300991', 'Roof east', 'R410A', '2015-02-01']);
    asset('cv_vrf2', 'calder_bc', ['VRF system', 'VRF outdoor unit — west wing', 'Mitsubishi Electric', 'PUHY-P300YNW-A', 'ME-3300992', 'Roof west', 'R410A', '2015-02-01']);

    customer('brightwell', ['Brightwell Home & Garden', 'Brightwell Retail Ltd', '04433221', 'Brightwell Retail Ltd, PO Box 88, Warrington WA1 1AA', 'ap@brightwell.example', 'Store number on every invoice.', 1, 'Retail', 'Regional chain; store managers report faults, head office facilities authorises.']);
    site('bw_stock', 'brightwell', { name: 'Brightwell Stockport (store 12)', address: 'Peel Retail Park', town: 'Stockport', postcode: 'SK1 3AA', area: 'Greater Manchester', opening_hours: 'Mon–Sat 08:00–20:00, Sun 10:00–16:00', work_restrictions: 'No ladders on shop floor during trading without barrier.' });
    site('bw_warr', 'brightwell', { name: 'Brightwell Warrington (store 3)', address: 'Winwick Road', town: 'Warrington', postcode: 'WA2 8JF', area: 'Cheshire', opening_hours: 'Mon–Sat 08:00–20:00', roof_plant_access: 'Roof via external ladder — requires two-person and wind below 23 mph.' });
    site('bw_bolton', 'brightwell', { name: 'Brightwell Bolton (store 7)', address: 'Trinity Retail Park', town: 'Bolton', postcode: 'BL3 6DH', area: 'Greater Manchester', opening_hours: 'Mon–Sat 08:00–20:00' });
    contact('bw_fac', 'brightwell', null, 'Stephen Rowe', 'facilities', 'Head of facilities', '01925 555 700', 's.rowe@brightwell.example', 1, 'All spend over £250 needs his PO.');
    contact('bw_sm12', 'brightwell', 'bw_stock', 'Kelly Burns', 'site', 'Store manager (12)', '0161 555 712', 'store12@brightwell.example', 0, 'Can report faults; cannot authorise spend.');
    contact('bw_sm3', 'brightwell', 'bw_warr', 'Omar Aziz', 'site', 'Store manager (3)', '01925 555 703', 'store3@brightwell.example', 0, 'Cannot authorise spend.');
    asset('bw12_cass1', 'bw_stock', ['Split AC', 'Sales floor cassette 1', 'Mitsubishi Electric', 'PLA-M100EA', 'ME-C-10021', 'Sales floor, aisle 4', 'R32', '2020-03-01']);
    asset('bw12_cass2', 'bw_stock', ['Split AC', 'Sales floor cassette 2', 'Mitsubishi Electric', 'PLA-M100EA', 'ME-C-10022', 'Sales floor, tills', 'R32', '2020-03-01']);
    asset('bw3_rtu', 'bw_warr', ['Rooftop unit', 'Rooftop packaged unit', 'Carrier', '50FC-08', 'CA-RT-5591', 'Roof', 'R410A', '2010-05-01'], null, 'Ageing unit; replacement recommended 2023.');
    asset('bw7_cu', 'bw_bolton', ['Split AC', 'Sales floor condensing unit', 'Daikin', 'RZAG125', 'DK-RZ-8812', 'Rear yard', 'R32', '2014-09-01'], null, 'Compressor noise reported; replacement quoted.');

    customer('irwell', ['Irwell Leisure', 'Irwell Community Leisure Trust', 'CE011122', 'Irwell Leisure Centre, Bolton Street, Bury BL9 0HU', 'accounts@irwell-leisure.example', null, 0, 'Hospitality & leisure', null]);
    site('irwell_lc', 'irwell', { name: 'Irwell Leisure Centre', address: 'Bolton Street', town: 'Bury', postcode: 'BL9 0HU', area: 'Greater Manchester', opening_hours: 'Daily 06:30–22:00', keys_security: 'Duty manager.', work_restrictions: 'Pool hall plant — chlorine store adjacent; follow site COSHH.' });
    contact('ir_dm', 'irwell', 'irwell_lc', 'Duty manager', 'site', 'Duty manager', '0161 555 800', 'duty@irwell-leisure.example', 0);
    contact('ir_fm', 'irwell', null, 'Gary Nuttall', 'facilities', 'Facilities officer', '0161 555 801', 'g.nuttall@irwell-leisure.example', 1);
    asset('ir_gym_ac', 'irwell_lc', ['Split AC', 'Gym ducted AC', 'Fujitsu', 'ARXG36KHTAP', 'FJ-36-4412', 'Gym ceiling void', 'R32', '2019-05-01']);
    asset('ir_pool_ahu', 'irwell_lc', ['AHU', 'Pool hall dehumidification AHU', 'Calorex', 'Delta 12', 'CX-D12-0931', 'Pool plant room', null, '2011-01-01']);

    customer('cheslab', ['Cheshire Lab Services', 'Cheshire Analytical Laboratories Ltd', '03322110', 'Finance, Daresbury Park, Runcorn WA4 4FS', 'finance@cheslab.example', 'PO required. Temperature-critical areas — see site notes.', 1, 'Healthcare & care', 'Temperature-controlled sample storage. Loss of cooling is critical.']);
    site('cl_runcorn', 'cheslab', { name: 'Cheshire Lab — Daresbury', address: 'Building 3, Daresbury Park', town: 'Runcorn', postcode: 'WA4 4FS', area: 'Cheshire', opening_hours: 'Mon–Fri 07:00–19:00; alarms monitored 24/7', keys_security: 'Security gatehouse; escorted in labs; lab access cards issued on induction.', induction_permits: 'Lab safety induction (valid 12 months) required before unescorted access.', induction_required: 1, work_restrictions: 'Sample store cooling: never isolate both units at once.' });
    contact('cl_fac', 'cheslab', 'cl_runcorn', 'Dr Helen Byrne', 'technical', 'Facilities & compliance lead', '01928 555 900', 'h.byrne@cheslab.example', 1);
    contact('cl_sec', 'cheslab', 'cl_runcorn', 'Security gatehouse', 'site', 'Security (24h)', '01928 555 999', null, 0);
    asset('cl_store1', 'cl_runcorn', ['Refrigeration', 'Sample store cooling — unit A (duty)', 'Daikin', 'ERQ125AV1', 'DK-ERQ-55001', 'Rear compound', 'R410A', '2018-01-15']);
    asset('cl_store2', 'cl_runcorn', ['Refrigeration', 'Sample store cooling — unit B (standby)', 'Daikin', 'ERQ125AV1', 'DK-ERQ-55002', 'Rear compound', 'R410A', '2018-01-15']);
    asset('cl_lab_ahu', 'cl_runcorn', ['AHU', 'Lab supply AHU', 'Swegon', 'GOLD RX 35', 'SW-99120', 'Plant room', null, '2018-01-15']);

    customer('deansgate', ['Deansgate Dental', 'Deansgate Dental Group Ltd', '11223344', '210 Deansgate, Manchester M3 3NW', 'practice@deansgatedental.example', null, 0, 'Healthcare & care', 'Installed two splits in the spring; within installation warranty.']);
    site('dd_practice', 'deansgate', { name: 'Deansgate Dental — main practice', address: '210 Deansgate', town: 'Manchester', postcode: 'M3 3NW', area: 'Greater Manchester', opening_hours: 'Mon–Fri 08:00–18:00, Sat 09:00–13:00', work_restrictions: 'Surgeries in use — work in waiting room before 08:00.' });
    contact('dd_pm', 'deansgate', 'dd_practice', 'Sarah Whitfield', 'site', 'Practice manager', '0161 555 950', 'sarah@deansgatedental.example', 1);
    asset('dd_split1', 'dd_practice', ['Split AC', 'Waiting room split', 'Daikin', 'FTXM25R / RXM25R', 'DK-25-77101', 'Waiting room', 'R32', iso(-60 * 24 * 150).slice(0, 10)], 'Customer-owned; FrostLine installation warranty 12 months.');
    asset('dd_split2', 'dd_practice', ['Split AC', 'Surgery 2 split', 'Daikin', 'FTXM25R / RXM25R', 'DK-25-77102', 'Surgery 2', 'R32', iso(-60 * 24 * 150).slice(0, 10)], 'Customer-owned; FrostLine installation warranty 12 months.');

    customer('kirklees', ['Kirklees Print Works', 'Kirklees Print & Packaging Ltd', '02211009', 'Colne Bridge Road, Huddersfield HD5 0RH', 'accounts@kirkleesprint.example', null, 0, 'Light industrial & warehousing', 'Prospect: new print hall ventilation.']);
    db.prepare(`UPDATE customers SET status = 'prospect' WHERE id = ?`).run(C.kirklees);
    site('kp_hall', 'kirklees', { name: 'Kirklees Print Works — print hall', address: 'Colne Bridge Road', town: 'Huddersfield', postcode: 'HD5 0RH', area: 'West Yorkshire', opening_hours: 'Mon–Fri 06:00–22:00 (two shifts)' });
    contact('kp_md', 'kirklees', null, 'James Firth', 'escalation', 'Managing director', '01484 555 111', 'j.firth@kirkleesprint.example', 1);

    // ---------------------------------------------------------------- contracts (demo contract data)
    const insContract = db.prepare(
      `INSERT INTO contracts (customer_id, ref, name, starts_on, ends_on, entitlement_notes, clock_stop_permitted, clock_stop_terms, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    );
    const insTarget = db.prepare(`INSERT INTO contract_targets (contract_id, priority, response_minutes, attendance_minutes, resolution_minutes) VALUES (?, ?, ?, ?, ?)`);
    const insCS = db.prepare(`INSERT INTO contract_sites (contract_id, site_id) VALUES (?, ?)`);
    const K: Record<string, number> = {};
    const contract = (key: string, cust: string, name: string, sites: string[], ent: string, stop: number, stopTerms: string | null, targets: [string, number | null, number | null, number | null][]) => {
      const start = new Date(NOW.getTime() - 300 * DAY).toISOString().slice(0, 10);
      const end = new Date(NOW.getTime() + 65 * DAY).toISOString().slice(0, 10);
      K[key] = Number(insContract.run(C[cust], nextRef(db, 'CT', 100), name, start, end, ent, stop, stopTerms, created).lastInsertRowid);
      for (const s of sites) insCS.run(K[key], S[s]);
      for (const t of targets) insTarget.run(K[key], ...t);
    };
    contract('ng', 'northgate', 'Northgate — planned & reactive maintenance', ['albion', 'kingsway', 'stanns'], 'Quarterly PPM on listed plant. Reactive labour included within working hours; parts chargeable; repairs over PO value by quotation.', 1, 'Clock may stop for denied access or customer-requested delay, evidenced in writing.', [
      ['P1', 30, 240, 1440],
      ['P2', 60, 480, 2880],
      ['P3', 240, 1440, 7200],
    ]);
    contract('pc', 'pennine', 'Pennine Care — heating & ventilation service', ['oakwood', 'ribble', 'hollins'], 'Annual boiler service, 6-monthly ventilation service. Reactive attendance 24/7 for heating/hot water loss. Minor repairs under £250 parts covered.', 1, 'Clock stops permitted for no access or customer delay, with written evidence.', [
      ['P1', 15, 240, 1440],
      ['P2', 60, 480, 2880],
      ['P3', 240, 1440, 4320],
    ]);
    contract('mf', 'mersey', 'Mersey Fresh — refrigeration service', ['speke'], 'Quarterly refrigeration PPM. 24/7 reactive. Parts chargeable.', 1, 'Clock stops for parts on manufacturer back-order and for customer access delay.', [
      ['P1', 15, 240, 720],
      ['P2', 30, 480, 1440],
      ['P3', 240, 1440, 4320],
    ]);
    contract('hh', 'harbour', 'Harbour Hotels — mechanical services', ['quayside', 'chester'], 'Bi-annual PPM, reactive within business hours; out-of-hours at extra charge.', 0, null, [
      ['P1', 60, 480, 2880],
      ['P2', 120, 1440, 4320],
      ['P3', 480, 2880, 10080],
    ]);
    contract('cv', 'calder', 'Calder Valley — AC maintenance (transferred)', ['calder_bc'], 'Transferred from Calder Cooling. Six-monthly service; reactive business hours.', 1, 'Clock stop for manufacturer decisions and parts.', [
      ['P2', 120, 1440, 4320],
      ['P3', 480, 2880, 10080],
    ]);
    contract('bw', 'brightwell', 'Brightwell — store HVAC', ['bw_stock', 'bw_warr', 'bw_bolton'], 'PPM twice a year; reactive trading hours. Repairs over £250 need head office PO.', 0, null, [
      ['P2', 120, 480, 2880],
      ['P3', 480, 1440, 7200],
    ]);
    contract('cl', 'cheslab', 'Cheshire Lab — critical cooling', ['cl_runcorn'], '24/7 critical response for sample store cooling. Quarterly PPM.', 1, 'Clock stops only for denied access with gatehouse record.', [
      ['P1', 15, 180, 720],
      ['P2', 30, 360, 1440],
      ['P3', 240, 1440, 4320],
    ]);

    // ---------------------------------------------------------------- competences & clearances
    const insComp = db.prepare(`INSERT INTO engineer_competences (user_id, tag, detail, valid_from, valid_to, notes) VALUES (?, ?, ?, ?, ?, ?)`);
    const until = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString().slice(0, 10);
    const comps: [string, string, string, number | null][] = [
      ['tom', 'fgas', 'F-Gas Category 1', 900],
      ['tom', 'refrigeration', 'Commercial refrigeration', null],
      ['tom', 'aircon', 'Split/VRF air conditioning', null],
      ['tom', 'daikin', 'Daikin VRV/Sky Air training', 400],
      ['aisha', 'fgas', 'F-Gas Category 1', 600],
      ['aisha', 'aircon', 'Split/VRF air conditioning', null],
      ['aisha', 'vrf-mitsubishi', 'Mitsubishi City Multi service course', 500],
      ['aisha', 'ipaf', 'IPAF 3a/3b', 200],
      ['gareth', 'gas-commercial', 'Gas Safe — commercial (ICPN1, COCN1)', 700],
      ['gareth', 'ventilation', 'Ventilation & AHU', null],
      ['gareth', 'controls', 'BMS / controls', null],
      ['kieran', 'aircon', 'Split air conditioning', null],
      ['kieran', 'ventilation', 'Ventilation & AHU', null],
      ['kieran', 'fgas', 'F-Gas Category 1', 20],
      ['kieran', 'gas-commercial', 'Gas Safe — commercial', -10],
      ['sam', 'fgas', 'F-Gas Category 1', 800],
      ['sam', 'aircon', 'Split/VRF air conditioning', null],
      ['sam', 'vrf-mitsubishi', 'Mitsubishi City Multi service course', 300],
      ['jordan', 'ventilation', 'Filter changes & basic ventilation (supervised)', null],
    ];
    for (const [u, tag, detail, days] of comps) insComp.run(U[u].id, tag, detail, null, days === null ? null : until(days), days !== null && days < 0 ? 'Renewal booked' : null);
    const insClear = db.prepare(`INSERT INTO engineer_site_clearances (user_id, site_id, detail, valid_to) VALUES (?, ?, ?, ?)`);
    insClear.run(U.tom.id, S.speke, 'Site safety & food hygiene induction', until(200));
    insClear.run(U.tom.id, S.cl_runcorn, 'Lab safety induction', until(150));
    insClear.run(U.gareth.id, S.cl_runcorn, 'Lab safety induction', until(-5));
    insClear.run(U.kieran.id, S.speke, 'Site safety & food hygiene induction', until(90));

    // ---------------------------------------------------------------- operational history via domain services
    const coord = U.dan;
    const coord2 = U.leanne;
    const all = (x: Record<string, string>) => ({ ready_scope: 'on', ready_authority: 'on', ready_access: 'on', ready_competence: 'on', ready_parts: 'on', ready_dependencies: 'on', ...x });

    interface NewJob {
      site: string;
      assets?: string[];
      kind?: string;
      title: string;
      symptom?: string;
      reporter?: string;
      reporterContact?: string;
      channel?: string;
      impact?: string;
      safety?: string;
      priority: string;
      reason: string;
      authority?: string;
      authorityRef?: string;
      po?: string;
      triage?: string;
      comps?: string;
      minutes?: number;
      next?: [string, string, number];
      by?: Actor;
      responseNote?: string;
    }
    const newJob = (j: NewJob): number => {
      const id = jobs.createJob(db, j.by ?? coord, {
        site_id: String(S[j.site]),
        kind: j.kind ?? 'reactive',
        title: j.title,
        channel: j.channel ?? 'phone',
        received_at: toLocalInput(clock.iso()),
        priority: j.priority,
        priority_reason: j.reason,
        reported_symptom: j.symptom ?? '',
        reported_by_name: j.reporter ?? '',
        reported_by_contact_id: j.reporterContact ? String(CT[j.reporterContact]) : '',
        impact: j.impact ?? '',
        safety_risk: j.safety ?? '',
        safety_flag: j.safety ? 'on' : '',
        asset_ids: (j.assets ?? []).map((a) => String(A[a])),
        authority_basis: j.authority ?? 'not_established',
        authority_ref: j.authorityRef ?? '',
        customer_po: j.po ?? '',
        triage_notes: j.triage ?? '',
        required_competences: j.comps ?? '',
        estimated_minutes: String(j.minutes ?? 120),
        next_action: j.next?.[0] ?? '',
        next_owner_user_id: j.next ? String(U[j.next[1]].id) : '',
        review_at: j.next ? local(minutesFromClock(j.next[2])) : '',
        acknowledged: 'on',
      });
      // Coordinators call the customer back; recording it keeps the SLA picture honest rather
      // than showing every job as an unanswered breach.
      if ((j.kind ?? 'reactive') !== 'planned') {
        sla.recordManualEvent(db, j.by ?? coord, id, { type: 'response', note: j.responseNote ?? 'Coordinator spoke to the customer, confirmed the symptom and explained the next step' });
      }
      return id;
    };
    function minutesFromClock(addMin: number) {
      return (clock.now().getTime() - NOW.getTime()) / MIN + addMin;
    }
    const ready = (id: number, extra: Record<string, string> = {}) => {
      const j = jobs.getJob(db, id);
      jobs.updateReadiness(db, coord, id, all({ required_competences: j.required_competences ?? '', estimated_minutes: String(j.estimated_minutes ?? 120), ...extra }));
    };
    const assign = (id: number, eng: string, startOff: number, durMin: number, commitment = 'provisional', by: Actor = coord, instructions = ''): number =>
      sched.assignAttendance(db, by, id, {
        engineer_user_id: String(U[eng].id),
        planned_start: local(startOff),
        planned_end: local(startOff + durMin),
        commitment,
        instructions,
        override_ack: 'on',
        override_reason: 'Planner judgement: engineer known to site / competence confirmed verbally; record to be updated.',
      });
    const visit = (attId: number, eng: string, startOff: number, submit: Record<string, string> | null, workMin = 60) => {
      at(startOff - 30, () => att.progressAttendance(db, U[eng], attId, 'travel'));
      at(startOff, () => att.progressAttendance(db, U[eng], attId, 'arrive'));
      at(startOff + 5, () => att.progressAttendance(db, U[eng], attId, 'start_work'));
      if (submit) at(startOff + workMin, () => att.submitAttendance(db, U[eng], attId, { submit_key: `seed-${attId}`, travel_minutes: '30', ...submit }));
    };
    const complete = (id: number, reason: string, by: Actor = coord) => {
      const j = jobs.getJob(db, id);
      if (j.op_status === 'waiting') jobs.resolveWaiting(db, by, id, { resolution: 'Office review complete — evidence checked.' });
      jobs.completeOperationally(db, by, id, { reason });
    };
    const done = (outcome: string, observed: string, work: string, extra: Record<string, string> = {}) => ({
      outcome,
      authority_basis: 'contract_minor_repair',
      observed_facts: observed,
      work_done: work,
      final_condition: 'operating_normally',
      labour_minutes: '75',
      ack_name: 'Site contact',
      ack_role: 'Site',
      ...extra,
    });

    // ---- History: completed and closed work (for customer/site/asset history) ----
    const hist: { off: number; job: NewJob; eng: string; sub: Record<string, string>; fin?: string }[] = [
      {
        off: -60 * 24 * 85,
        job: { site: 'albion', assets: ['alb_vrf1'], kind: 'planned', channel: 'planned', title: 'Q2 PPM — VRF & AHU', priority: 'P4', reason: 'Scheduled contract maintenance', authority: 'planned_maintenance', authorityRef: 'Contract PPM schedule', comps: 'aircon', minutes: 360 },
        eng: 'aisha',
        sub: done('maintenance_completed', 'Both VRF outdoor units running; 1st floor BC controller slight oil staining at joint. AHU filters 70% loaded.', 'Full PPM per schedule. AHU G4 filters replaced. Coil cleaned.', { authority_basis: 'planned_maintenance', recommendations: 'Monitor BC controller joint for leak at next visit.', ack_name: 'Michael Grant', ack_role: 'Building manager' }),
        fin: 'invoiced',
      },
      {
        off: -60 * 24 * 62,
        job: { site: 'albion', assets: ['alb_mr3'], title: 'Meeting room 3.2 not cooling', symptom: 'Meeting room too warm, unit blowing but not cold', reporter: 'Michael Grant', reporterContact: 'ng_mgrant', impact: 'One meeting room unusable in afternoons', priority: 'P3', reason: 'Single room comfort, alternatives available', authority: 'diagnosis_only', comps: 'aircon, fgas' },
        eng: 'tom',
        sub: done('diagnosis_further_work', 'Unit running, suction pressure low, oil at flare on indoor unit liquid line.', 'Leak located at indoor flare; flare remade; system topped up 0.3kg R32 (logged).', { authority_basis: 'diagnosis_only', diagnosis: 'Refrigerant leak at indoor unit liquid flare joint', diagnosis_verified: 'on', recommendations: 'Indoor coil shows corrosion at return bends — replacement indoor unit advisable within 12 months.', ack_name: 'Michael Grant', ack_role: 'Building manager', handoff_required_outcome: 'Quote indoor unit replacement to Northgate procurement', handoff_dependency: 'customer_approval', handoff_dependency_detail: 'Customer to decide on indoor unit replacement once quoted', handoff_operating_condition: 'Operating normally after leak repair; corroded coil is a future risk', handoff_urgency: 'P3', handoff_next_owner_user_id: String(U.rachel.id), handoff_review_at: local(-60 * 24 * 55) }),
        fin: 'invoiced',
      },
      {
        off: -60 * 24 * 40,
        job: { site: 'speke', assets: ['sp_cr1'], kind: 'planned', channel: 'planned', title: 'Quarterly refrigeration PPM', priority: 'P4', reason: 'Contract PPM', authority: 'planned_maintenance', comps: 'refrigeration, fgas', minutes: 300 },
        eng: 'tom',
        sub: done('maintenance_completed', 'All three condensing units running within design. CR3 condenser fins partly blocked with debris.', 'PPM completed; condensers cleaned; leak test all circuits (no leaks).', { authority_basis: 'planned_maintenance', recommendations: 'CR3 contactor showing pitting — replace at next visit.', ack_name: 'Carl Jennings', ack_role: 'Engineering manager' }),
        fin: 'invoiced',
      },
      {
        off: -60 * 24 * 21,
        job: { site: 'oakwood', assets: ['oak_boiler1'], title: 'Boiler 1 lockout', symptom: 'Boiler 1 showing lockout, boiler 2 running', reporter: 'Grace Ndlovu', reporterContact: 'pc_oak', impact: 'Heating maintained on boiler 2 only', priority: 'P2', reason: 'Care home, redundancy lost', authority: 'contract_minor_repair', comps: 'gas-commercial' },
        eng: 'gareth',
        sub: done('completed', 'Boiler 1 lockout code 5 (flame loss). Ignition electrode worn and misaligned.', 'Replaced ignition electrode set; combustion analysed; boiler 1 back in lead/lag rotation.', { diagnosis: 'Worn ignition electrode causing flame failure', diagnosis_verified: 'on', ack_name: 'Grace Ndlovu', ack_role: 'Home manager' }),
        fin: 'ready_to_invoice',
      },
      {
        off: -60 * 24 * 14,
        job: { site: 'bw_warr', assets: ['bw3_rtu'], title: 'Store too hot — rooftop unit', symptom: 'Store very warm, RTU tripping', reporter: 'Omar Aziz', reporterContact: 'bw_sm3', impact: 'Customer and staff comfort; trading continues', priority: 'P3', reason: 'Comfort only, no safety risk', authority: 'diagnosis_only', comps: 'aircon' },
        eng: 'kieran',
        sub: done('temporary_restoration', 'RTU compressor tripping on high head pressure. Condenser coil heavily fouled; condenser fan motor bearings noisy.', 'Condenser coil cleaned; fan motor bearings lubricated; unit running.', {
          authority_basis: 'diagnosis_only',
          final_condition: 'operating_limited',
          diagnosis: 'High head pressure from fouled coil and failing condenser fan motor',
          diagnosis_verified: 'on',
          recommendations: 'Replace condenser fan motor; plan RTU replacement (unit 14 years old).',
          handoff_required_outcome: 'Supply and fit condenser fan motor; quote RTU replacement',
          handoff_dependency: 'customer_approval',
          handoff_dependency_detail: 'Head office PO needed for fan motor (over £250)',
          handoff_operating_condition: 'Running with limited capacity; may trip on hot days',
          handoff_parts_specialist: 'Condenser fan motor Carrier 50FC-08',
          handoff_urgency: 'P3',
          handoff_next_owner_user_id: String(U.dan.id),
          handoff_review_at: local(-60 * 24 * 10),
          temp_change_made: 'Coil cleaned, bearings lubricated as stop-gap',
          temp_reason: 'Fan motor not in stock; PO needed',
          temp_service_restored: 'Cooling restored at reduced capacity',
          temp_limitations: 'May trip on ambient above ~26°C',
          temp_residual_risk: 'Fan motor failure would stop cooling entirely',
          temp_monitoring: 'Store to report any tripping',
          temp_review_at: local(-60 * 24 * 7),
          temp_customer_understanding: 'Store manager told unit is on temporary fix pending PO',
          temp_approver: 'Dan Whitaker (coordinator)',
          temp_permanent_owner_user_id: String(U.dan.id),
          ack_name: 'Omar Aziz',
          ack_role: 'Store manager',
        }),
      },
      {
        off: -60 * 24 * 9,
        job: { site: 'irwell_lc', assets: ['ir_gym_ac'], title: 'Gym AC dripping water', symptom: 'Water dripping from ceiling grille in gym', reporter: 'Duty manager', reporterContact: 'ir_dm', impact: 'Slip hazard, area coned off', safety: 'Water on gym floor — slip hazard', priority: 'P2', reason: 'Slip hazard in public area', authority: 'diagnosis_only', channel: 'phone', comps: 'aircon' },
        eng: 'aisha',
        sub: done('completed', 'Condensate pump failed (float stuck); tray overflowing.', 'Replaced condensate pump (Aspen mini orange) from van stock; tested; tray dry.', { authority_basis: 'delegated_spend', diagnosis: 'Condensate pump failure', diagnosis_verified: 'on', ack_name: 'Duty manager', ack_role: 'Duty manager' }),
        fin: 'invoiced',
      },
    ];
    const histIds: number[] = [];
    for (const h of hist) {
      const id = at(h.off, () => newJob(h.job));
      histIds.push(id);
      at(h.off + 10, () => ready(id));
      const a = at(h.off + 15, () => assign(id, h.eng, h.off + 180, 150));
      at(h.off + 60, () => sched.dispatchAttendance(db, coord, a));
      visit(a, h.eng, h.off + 180, h.sub, 90);
    }
    // Gym pump was fitted from van stock
    // (recorded retrospectively here as material use would have been during the visit)
    // Close most historical jobs; leave the Brightwell temporary restoration open (it's live).
    at(hist[0].off + 60 * 24, () => complete(histIds[0], 'PPM completed, report sent.'));
    at(hist[1].off + 60 * 24 * 3, () => {
      jobs.resolveWaiting(db, coord, histIds[1], { resolution: 'Recommendation passed to estimating (quote raised).' });
      complete(histIds[1], 'Leak repaired; replacement recommendation handed to estimating.');
    });
    at(hist[2].off + 60 * 24, () => complete(histIds[2], 'PPM completed.'));
    at(hist[3].off + 60 * 24, () => complete(histIds[3], 'Repair completed and verified by combustion test.'));
    at(hist[5].off + 60 * 24, () => complete(histIds[5], 'Pump replaced, leak resolved.'));
    const finance = U.helen;
    at(-60 * 24 * 60, () => jobs.setFinancialStatus(db, finance, histIds[0], { financial_status: 'ready_to_invoice', reason: 'PPM complete' }));
    at(-60 * 24 * 59, () => jobs.setFinancialStatus(db, finance, histIds[0], { financial_status: 'invoiced', reason: 'Invoice INV-20411' }));
    at(-60 * 24 * 50, () => jobs.setFinancialStatus(db, finance, histIds[1], { financial_status: 'ready_to_invoice', reason: 'Leak repair' }));
    at(-60 * 24 * 49, () => jobs.setFinancialStatus(db, finance, histIds[1], { financial_status: 'invoiced', reason: 'Invoice INV-20498' }));
    at(-60 * 24 * 30, () => jobs.setFinancialStatus(db, finance, histIds[1], { financial_status: 'financially_closed', reason: 'Paid' }));
    at(-60 * 24 * 38, () => jobs.setFinancialStatus(db, finance, histIds[2], { financial_status: 'ready_to_invoice', reason: 'PPM' }));
    at(-60 * 24 * 37, () => jobs.setFinancialStatus(db, finance, histIds[2], { financial_status: 'invoiced', reason: 'Invoice INV-20533' }));
    at(-60 * 24 * 19, () => jobs.setFinancialStatus(db, finance, histIds[3], { financial_status: 'ready_to_invoice', reason: 'Parts to charge: electrode set' }));
    at(-60 * 24 * 7, () => jobs.setFinancialStatus(db, finance, histIds[5], { financial_status: 'ready_to_invoice', reason: 'Pump and labour' }));
    at(-60 * 24 * 6, () => jobs.setFinancialStatus(db, finance, histIds[5], { financial_status: 'invoiced', reason: 'Invoice INV-20701' }));

    // ---- Quotes ----
    const est = U.rachel;
    const mgr = U.susan;
    const makeQuote = (o: { cust: string; site: string; title: string; source: string; job?: number; basis?: string; scope: string; lines: [string | null, string, string, number, number][]; assumptions: string; exclusions: string; programme?: string; validDays?: number; warranty?: string; responsibilities?: string }) => {
      const oppId = quotes.createOpportunity(db, est, {
        customer_id: String(C[o.cust]),
        site_id: String(S[o.site]),
        title: o.title,
        source: o.source,
        originating_job_id: o.job ? String(o.job) : '',
        owner_user_id: String(est.id),
        maturity: 'estimate',
        estimate_basis: o.basis ?? 'developed_estimate',
      });
      const rev = quotes.revisionsFor(db, oppId)[0];
      quotes.updateDraft(db, est, rev.id, {
        scope: o.scope,
        equipment_materials: o.lines.filter((l) => l[1] !== 'labour').map((l) => l[2]).join('; '),
        programme: o.programme ?? 'Within 10 working days of order, subject to parts lead time',
        assumptions: o.assumptions,
        exclusions: o.exclusions,
        warranty_position: o.warranty ?? '12 months parts and labour on new equipment supplied and fitted by FrostLine.',
        customer_responsibilities: o.responsibilities ?? 'Provide access and isolation windows; clear working area.',
        payment_terms: '30 days from invoice date',
        acceptance_method: 'Signed acceptance form or written purchase order quoting the quotation number and revision',
        vat_rate: '20',
        valid_until: new Date(clock.now().getTime() + (o.validDays ?? 30) * DAY).toISOString().slice(0, 10),
      });
      for (const [opt, type, desc, qty, price] of o.lines) quotes.addLine(db, est, rev.id, { option_code: opt ?? '', line_type: type, description: desc, qty: String(qty), unit_price: (price / 100).toFixed(2) });
      return { oppId, revId: rev.id };
    };
    const approveIssue = (revId: number, note = 'Pricing and scope checked.') => {
      quotes.approveRevision(db, mgr, revId, { reason: note });
      quotes.issueRevision(db, est, revId, { note: 'Emailed to customer contact as PDF' });
    };

    // Q1 Northgate meeting room replacement (issued, awaiting customer)
    const q1 = at(-60 * 24 * 50, () =>
      makeQuote({
        cust: 'northgate',
        site: 'albion',
        title: 'Meeting room 3.2 indoor unit replacement',
        source: 'engineer_recommendation',
        job: histIds[1],
        scope: 'Replace corroded Daikin FTXM35R indoor unit in meeting room 3.2 with like-for-like; reuse existing pipework after pressure test; recommission and F-Gas record.',
        lines: [
          [null, 'equipment', 'Daikin FTXM35R indoor unit', 1, 64500],
          [null, 'labour', 'Engineer labour — replacement & commissioning (2 engineers × 4h)', 8, 6500],
          [null, 'materials', 'Flare fittings, insulation, consumables', 1, 4500],
          ['A', 'other', 'Option A: out-of-hours installation (Saturday)', 1, 18000],
        ],
        assumptions: 'Existing pipework passes pressure test. Access to ceiling above unit is clear. Outdoor unit (RXM35R) serviceable.',
        exclusions: 'Making good decorations; replacement of pipework if pressure test fails (would be a variation); asbestos works.',
      }),
    );
    at(-60 * 24 * 48, () => approveIssue(q1.revId));
    // Park the (then) job to wait on the customer
    // Q2 Harbour Chester AHU motor — accepted & released
    const q2 = at(-60 * 24 * 20, () =>
      makeQuote({
        cust: 'harbour',
        site: 'chester',
        title: 'Conference AHU fan motor replacement',
        source: 'maintenance_finding',
        scope: 'Replace failing 4kW AHU supply fan motor, new belts and pulleys aligned; test and balance airflow.',
        lines: [
          [null, 'equipment', 'WEG 4kW 4-pole IE3 motor', 1, 48000],
          [null, 'materials', 'SPZ belts ×2, taper lock bush', 1, 6200],
          [null, 'labour', 'Engineer labour (2 × 5h)', 10, 6500],
        ],
        assumptions: 'Motor frame size unchanged; service lift available.',
        exclusions: 'Controls/inverter changes; out-of-hours working.',
      }),
    );
    at(-60 * 24 * 19, () => approveIssue(q2.revId));
    const acc2 = at(-60 * 24 * 12, () =>
      quotes.recordAcceptance(db, est, q2.revId, {
        accepting_party: 'Group procurement, Harbour Hospitality (North) Ltd',
        accepting_contact_id: String(CT.hh_proc),
        acceptance_evidence: 'PO HH-44718 received by email 12 days ago',
        confirm_revision: '1',
        chk_authority: 'on',
        chk_authority_note: 'Group procurement holds authority for capital repairs',
        chk_revision_options: 'on',
        chk_po_value: 'on',
        po_number: 'HH-44718',
        po_value: '1302.00',
        chk_terms: 'on',
        chk_terms_note: 'Our terms accepted on PO',
        chk_dates: 'on',
        proposed_start: new Date(NOW.getTime() + 2 * DAY).toISOString().slice(0, 10),
        chk_validity_pricing: 'on',
        credit_deposit: 'not_required',
      }),
    );
    const rel2 = at(-60 * 24 * 11, () => quotes.releaseWork(db, mgr, acc2, { target: 'job', reason: 'All checks complete; motor ordered.', owner_user_id: String(coord2.id) }));
    const jobChesterAhu = rel2.jobId!;
    // Q3 Kirklees — rev1 superseded, rev2 issued with options
    const q3 = at(-60 * 24 * 30, () =>
      makeQuote({
        cust: 'kirklees',
        site: 'kp_hall',
        title: 'Print hall ventilation system',
        source: 'enquiry',
        basis: 'developed_estimate',
        scope: 'Design, supply and install supply & extract ventilation to the print hall (approx 1,800 m²) to remove heat and VOCs; two roof-mounted AHUs with ductwork to high-level grilles; controls integration.',
        lines: [
          [null, 'equipment', 'Roof AHUs ×2 (supply/extract)', 2, 1850000],
          [null, 'materials', 'Ductwork, grilles, dampers, supports', 1, 1420000],
          [null, 'subcontract', 'Crane lift & roof works', 1, 380000],
          [null, 'labour', 'Installation labour (2 engineers × 12 days)', 24, 52000],
          [null, 'provisional_sum', 'Provisional sum — electrical supplies by others', 1, 250000],
          ['A', 'equipment', 'Option A: heat recovery wheels on both AHUs', 1, 640000],
          ['B', 'other', 'Option B: BMS integration & remote monitoring', 1, 285000],
        ],
        assumptions: 'Roof structure can take AHU loads (structural check by client). Electrical supply available within 10 m of AHU positions.',
        exclusions: 'Structural works; builder\'s work in connection; electrical supplies (provisional sum only); planning permission.',
        programme: '4 weeks on site after 8-week equipment lead time.',
        responsibilities: 'Structural engineer sign-off; production shutdown windows for roof penetrations.',
        validDays: 60,
      }),
    );
    at(-60 * 24 * 28, () => approveIssue(q3.revId, 'Developed estimate approved for issue; margins checked.'));
    const q3r2 = at(-60 * 24 * 10, () => quotes.newRevision(db, est, q3.oppId, { change_summary: 'Customer asked to split heat recovery out as an option and add BMS option; AHU spec revised after survey.' }));
    at(-60 * 24 * 10 + 30, () => {
      const lines = quotes.linesFor(db, q3r2);
      const labour = lines.find((l) => l.line_type === 'labour')!;
      quotes.removeLine(db, est, labour.id);
      quotes.addLine(db, est, q3r2, { option_code: '', line_type: 'labour', description: 'Installation labour (2 engineers × 14 days, revised after survey)', qty: '28', unit_price: '520.00' });
    });
    at(-60 * 24 * 9, () => approveIssue(q3r2, 'Rev 2 after survey; labour revised.'));
    // Q4 St Wilfrid's Moorside — draft
    at(-60 * 24 * 3, () =>
      makeQuote({
        cust: 'stwilfrids',
        site: 'moorside',
        title: 'Classroom cooling — ICT suites',
        source: 'enquiry',
        basis: 'concept_estimate',
        scope: 'Supply and install wall-mounted split AC to two ICT suites.',
        lines: [
          [null, 'equipment', 'Split AC 5kW ×2 (indoor/outdoor)', 2, 145000],
          [null, 'labour', 'Installation labour', 16, 6500],
        ],
        assumptions: 'Outdoor units on flat roof above suites; summer holiday installation.',
        exclusions: 'Electrical supplies; builder\'s work.',
      }),
    );
    // Q5 Brightwell Bolton condensing unit — accepted, release blocked (credit pending / terms not reviewed)
    const q5 = at(-60 * 24 * 15, () =>
      makeQuote({
        cust: 'brightwell',
        site: 'bw_bolton',
        title: 'Sales floor condensing unit replacement',
        source: 'engineer_recommendation',
        scope: 'Replace noisy Daikin RZAG125 condensing unit with RZAG125 (like for like), recover refrigerant, pressure test, evacuate, recharge and commission.',
        lines: [
          [null, 'equipment', 'Daikin RZAG125NY1 condensing unit', 1, 348000],
          [null, 'labour', 'Engineer labour (2 × 1 day)', 16, 6500],
          [null, 'materials', 'Refrigerant, anti-vibration mounts, consumables', 1, 42000],
        ],
        assumptions: 'Existing pipework reusable; installation before store opening.',
        exclusions: 'Indoor unit works; electrical isolator replacement.',
      }),
    );
    at(-60 * 24 * 14, () => approveIssue(q5.revId));
    at(-60 * 24 * 2, () =>
      quotes.recordAcceptance(db, est, q5.revId, {
        accepting_party: 'Stephen Rowe, Head of facilities, Brightwell Retail Ltd',
        accepting_contact_id: String(CT.bw_fac),
        acceptance_evidence: 'Email "go ahead" from S. Rowe 2 days ago; PO to follow',
        confirm_revision: '1',
        chk_authority: 'on',
        chk_authority_note: 'Head of facilities confirmed authority for store capital works',
        chk_revision_options: 'on',
        chk_po_value: '',
        po_number: '',
        chk_terms: '',
        chk_dates: 'on',
        chk_validity_pricing: 'on',
        credit_deposit: 'pending',
        credit_note: 'Account over terms — finance checking before release',
      }),
    );
    // Q6 Pennine budget indication (enquiry)
    at(-60 * 24 * 5, () => {
      quotes.createOpportunity(db, est, {
        customer_id: String(C.pennine),
        site_id: String(S.oakwood),
        title: 'Boiler plant replacement (budget)',
        source: 'enquiry',
        owner_user_id: String(est.id),
        maturity: 'qualified',
        estimate_basis: 'budget_indication',
        notes: 'Operations director asked for a budget figure for next financial year. Survey needed before any quotation.',
      });
    });
    // Q7 historical declined
    const q7 = at(-60 * 24 * 70, () =>
      makeQuote({
        cust: 'irwell',
        site: 'irwell_lc',
        title: 'Pool hall AHU refurbishment',
        source: 'maintenance_finding',
        scope: 'Refurbish pool hall dehumidification AHU: replace fans, recoat coil.',
        lines: [[null, 'other', 'Refurbishment package', 1, 1240000]],
        assumptions: 'Unit casing sound.',
        exclusions: 'Pool water treatment.',
      }),
    );
    at(-60 * 24 * 68, () => approveIssue(q7.revId));
    at(-60 * 24 * 40, () => quotes.closeRevision(db, est, q7.revId, { status: 'declined', reason: 'Trust has no capital budget this year; revisit next April.' }));

    // ---- Live work ----
    // L1: Cheshire Lab P1 — sample store alarm; dispatched, engineer travelling now. SLA attendance at risk.
    const L1 = at(-150, () =>
      newJob({ site: 'cl_runcorn', assets: ['cl_store1'], title: 'Sample store temperature alarm', symptom: 'Sample store high-temp alarm; unit A running but store at +7°C and rising (setpoint +4°C)', reporter: 'Security gatehouse', reporterContact: 'cl_sec', impact: 'Temperature-critical samples at risk; standby unit B started manually', safety: 'None to people; sample integrity at risk', priority: 'P1', reason: 'Critical storage at risk; standby only partly holding', authority: 'contract_minor_repair', authorityRef: 'Contract critical cover', triage: 'Remote: asked security to confirm unit B running — yes. Store still rising slowly. Attend.', comps: 'refrigeration, fgas', minutes: 180 }),
    );
    at(-140, () => ready(L1));
    const L1a = at(-135, () => assign(L1, 'tom', -120, 180, 'customer_confirmed', coord, 'Lab induction on file. Escort from gatehouse. Do not isolate unit B.'));
    at(-130, () => sched.dispatchAttendance(db, coord, L1a));
    at(-100, () => att.progressAttendance(db, U.tom, L1a, 'travel'));

    // L2: Pennine Oakwood P1 — no heating east wing, ready and unscheduled right now.
    const L2 = at(-35, () =>
      newJob({ site: 'oakwood', assets: ['oak_boiler1', 'oak_boiler2'], title: 'No heating — east wing', symptom: 'East wing radiators cold since early morning; boilers showing no fault', reporter: 'Grace Ndlovu', reporterContact: 'pc_oak', impact: '14 residents in east wing; portable heaters deployed', safety: 'Vulnerable residents — cold exposure risk', priority: 'P1', reason: 'Vulnerable residents without heating', authority: 'contract_minor_repair', authorityRef: 'Contract 24/7 heating cover', triage: 'Boilers firing per home manager. Likely zone valve / pump on east wing circuit.', comps: 'gas-commercial', minutes: 180, next: ['Assign heating engineer — Gareth closest', 'dan', 20] }),
    );
    at(-30, () => ready(L2));

    // L3: Mersey Fresh CR3 — temporary restoration yesterday, waiting on part; reservation for part.
    const L3 = at(-60 * 26, () =>
      newJob({ site: 'speke', assets: ['sp_cr3'], title: 'Cold room 3 high temperature', symptom: 'CR3 at +9°C (setpoint +2°C), compressor short cycling', reporter: 'Shift manager', reporterContact: 'mf_shift', impact: 'Stock being moved to CR1/CR2', priority: 'P2', reason: 'Stock at risk but alternative storage available', authority: 'contract_minor_repair', comps: 'refrigeration, fgas', minutes: 180 }),
    );
    at(-60 * 26 + 10, () => ready(L3));
    const L3a = at(-60 * 26 + 15, () => assign(L3, 'tom', -60 * 25, 180, 'customer_confirmed'));
    at(-60 * 26 + 20, () => sched.dispatchAttendance(db, coord, L3a));
    visit(L3a, 'tom', -60 * 25, null);
    at(-60 * 25 + 60, () => att.addReading(db, U.tom, L3a, { name: 'Cold room 3 air temperature', value: '9.2', unit: '°C', asset_id: String(A.sp_cr3) }));
    at(-60 * 25 + 65, () => att.addReading(db, U.tom, L3a, { name: 'Suction pressure', value: '2.1', unit: 'bar g', asset_id: String(A.sp_cr3) }));
    at(-60 * 25 + 70, () => att.addEvidence(db, U.tom, '', L3a, { kind: 'photo', caption: 'Pitted contactor contacts CR3 (photo taken on engineer phone, file to follow)' }));
    at(-60 * 25 + 150, () =>
      att.submitAttendance(db, U.tom, L3a, {
        submit_key: 'seed-L3a',
        outcome: 'temporary_restoration',
        authority_basis: 'contract_minor_repair',
        reported_confirmed: 'CR3 warm, compressor short cycling — confirmed',
        observed_facts: 'Compressor contactor contacts badly pitted causing chatter and short cycling. Overload intact. Refrigerant charge correct (sight glass clear).',
        tests_performed: 'Coil voltage steady 230V; contact resistance high on L2; pressures normal once running.',
        diagnosis: 'Failing compressor contactor',
        diagnosis_verified: 'on',
        work_done: 'Contacts dressed and contactor re-seated as temporary measure. Room pulling down.',
        final_condition: 'operating_limited',
        safety_notes: 'Panel re-secured; no exposed conductors.',
        uncertainty: 'Contacts may re-weld under load within days.',
        recommendations: 'Fit replacement contactor & overload kit ASAP.',
        labour_minutes: '150',
        travel_minutes: '45',
        handoff_required_outcome: 'Replace compressor contactor & overload kit (CI-6.5)',
        handoff_dependency: 'part_availability',
        handoff_dependency_detail: 'Contactor/overload kit ordered from Danfoss wholesaler, due tomorrow AM',
        handoff_operating_condition: 'Running on dressed contacts; room at +3°C and holding',
        handoff_parts_specialist: 'Danfoss CI-6.5 contactor & overload kit',
        handoff_promises: 'Told Carl Jennings we would return as soon as the kit arrives (aim tomorrow)',
        handoff_urgency: 'P2',
        handoff_authority: 'Contract minor repair; parts chargeable — Carl Jennings agreed verbally',
        handoff_next_owner_user_id: String(U.dan.id),
        handoff_review_at: local(60 * 18),
        temp_change_made: 'Contactor contacts dressed and re-seated',
        temp_reason: 'Replacement contactor not on van',
        temp_service_restored: 'CR3 pulling down to setpoint',
        temp_limitations: 'Contacts may weld or chatter again; not a permanent repair',
        temp_residual_risk: 'Compressor could stop or run continuously; stock risk if unnoticed',
        temp_monitoring: 'Shift manager to check CR3 display hourly and call if above +5°C',
        temp_review_at: local(60 * 20),
        temp_customer_understanding: 'Carl Jennings understands it is a temporary fix and agreed to hourly checks',
        temp_approver: 'Tom Brierley with Dan Whitaker by phone',
        temp_permanent_owner_user_id: String(U.dan.id),
        ack_name: 'Carl Jennings',
        ack_role: 'Engineering manager',
        ack_comment: 'Happy with temporary fix; please return with part ASAP',
      }),
    );
    // Part ordered and received today; reserved for L3
    at(-60 * 3, () =>
      inv.receiveGoods(db, U.mick, {
        supplier: 'Refrigeration Wholesale Ltd',
        po_ref: 'PO-31877',
        delivery_ref: 'DN-558120',
        carrier: 'DPD',
        location_id: String(LOC.WH),
        line_item_id: [String(I['CU-COMP-SH']), String(I['FLT-BAG-F7']), String(I['MTR-EC-250'])],
        line_qty_expected: ['1', '12', '2'],
        line_qty_received: ['1', '12', '2'],
        line_condition: ['good', 'good', 'damaged'],
        line_evidence: ['', '', 'Box crushed; one motor housing cracked, other unknown. Photos taken at goods-in; carrier signed "damaged".'],
        line_impact: ['', '', 'No job currently waiting; restocks EC motor minimum'],
        line_next_action: ['', '', 'Raise damage claim with supplier & request replacement'],
        line_next_owner: ['', '', String(U.mick.id)],
        line_return_deadline: ['', '', new Date(NOW.getTime() + 5 * DAY).toISOString().slice(0, 10)],
      }),
    );
    at(-60 * 2, () =>
      inv.reserve(db, U.mick, {
        item_id: String(I['CU-COMP-SH']),
        location_id: String(LOC.WH),
        qty: '1',
        job_id: String(L3),
        purpose: 'Permanent repair CR3 contactor (Mersey Fresh)',
        owner_user_id: String(U.dan.id),
        required_by: local(60 * 16),
        review_at: local(60 * 24),
        substitution_allowed: '',
        reallocation_consequence: 'CR3 stays on temporary repair; stock risk at Mersey Fresh',
      }),
    );

    // L4: Harbour Quayside kitchen extract noisy — confirmed for later today.
    const L4 = at(-60 * 20, () =>
      newJob({ site: 'quayside', assets: ['qs_kex'], title: 'Kitchen extract fan noisy', symptom: 'Loud rumbling from kitchen extract on roof', reporter: 'Viktor Nowak', reporterContact: 'hh_ce', impact: 'Kitchen still extracting; noise complaint from guests', priority: 'P2', reason: 'Risk of extract failure affecting kitchen service', authority: 'contract_minor_repair', comps: 'ventilation', minutes: 120 }),
    );
    at(-60 * 20 + 10, () => ready(L4));
    at(-60 * 19, () => assign(L4, 'gareth', 150, 120, 'customer_confirmed', coord, 'Kitchen extract work window 15:00–17:00 only. Report to chief engineer.'));

    // L5: Northgate Albion meeting room — waiting on customer approval of Q1
    const L5 = at(-60 * 24 * 47, () =>
      newJob({ site: 'albion', assets: ['alb_mr3'], kind: 'follow_on', channel: 'engineer', title: 'Meeting room 3.2 indoor unit — awaiting quote decision', priority: 'P3', reason: 'Follow-on from leak repair; unit currently operating', authority: 'not_established', triage: 'Follow-on to engineer recommendation. Quote issued to procurement.', by: coord }),
    );
    at(-60 * 24 * 47 + 5, () =>
      jobs.setWaiting(db, coord, L5, {
        waiting_category: 'customer_approval',
        waiting_detail: `Northgate procurement to accept quotation ${quotes.getOpportunity(db, q1.oppId).ref} rev 1`,
        next_action: 'Chase Joanne Kerr (procurement) for decision',
        next_owner_user_id: String(est.id),
        review_at: local(60 * 24 * 2),
      }),
    );

    at(-60 * 24 * 46, () =>
      sla.startClockStop(db, coord, L5, {
        reason_category: 'customer_delay',
        contractual_basis: 'Contract permits clock stops for customer-requested delay, evidenced in writing',
        dependency_detail: 'Northgate procurement deciding on the quoted indoor unit replacement',
        evidence: 'Email from J. Kerr confirming the decision is with their client',
        expected_actor: 'Joanne Kerr (Northgate procurement)',
        owner_user_id: String(est.id),
        chase_at: local(-60 * 24 * 44),
      }),
    );

    // L6: Brightwell Stockport — engineer on site now (leak from cassette)
    const L6 = at(-60 * 4, () =>
      newJob({ site: 'bw_stock', assets: ['bw12_cass1'], title: 'Cassette leaking water onto sales floor', symptom: 'Water dripping from cassette above aisle 4', reporter: 'Kelly Burns', reporterContact: 'bw_sm12', impact: 'Aisle coned off; trading continues', safety: 'Slip hazard on sales floor', priority: 'P2', reason: 'Slip hazard to public', authority: 'diagnosis_only', triage: 'Store manager cannot authorise spend — diagnosis only; repairs over £250 need S. Rowe PO.', comps: 'aircon', minutes: 120 }),
    );
    at(-60 * 4 + 10, () => ready(L6));
    const L6a = at(-60 * 4 + 15, () => assign(L6, 'aisha', -60, 120, 'customer_confirmed'));
    at(-60 * 4 + 20, () => sched.dispatchAttendance(db, coord, L6a));
    visit(L6a, 'aisha', -40, null);

    // L7: Calder VRF fault — waiting manufacturer decision, review overdue; clock stopped.
    const L7 = at(-60 * 24 * 6, () =>
      newJob({ site: 'calder_bc', assets: ['cv_vrf'], title: 'East wing VRF fault code 4250', symptom: 'East wing offices no cooling; outdoor unit showing 4250', reporter: 'Ruth Sutcliffe', reporterContact: 'cv_est', impact: 'East wing tenants without cooling (mild weather)', priority: 'P3', reason: 'Comfort; mild weather', authority: 'contract_minor_repair', comps: 'aircon, vrf-mitsubishi', minutes: 180 }),
    );
    at(-60 * 24 * 6 + 10, () => ready(L7));
    const L7a = at(-60 * 24 * 6 + 20, () => assign(L7, 'sam', -60 * 24 * 5, 240));
    at(-60 * 24 * 6 + 30, () => sched.dispatchAttendance(db, coord2, L7a));
    visit(L7a, 'sam', -60 * 24 * 5, {
      outcome: 'specialist_required',
      authority_basis: 'contract_minor_repair',
      observed_facts: 'Code 4250 (inverter heatsink overheat / power module). Heatsink clean; fan runs. Fault returns within 20 min.',
      tests_performed: 'Checked supply voltage balance (OK), inverter fan, heatsink thermistor resistance (in range).',
      diagnosis: 'Suspected inverter power module failure — not verified',
      work_done: 'Fault-finding only; unit left isolated at tenant request.',
      final_condition: 'made_safe_isolated',
      uncertainty: 'Could be inverter board or compressor; needs manufacturer technical support.',
      recommendations: 'Log case with Mitsubishi technical; likely inverter board replacement.',
      labour_minutes: '180',
      handoff_required_outcome: 'Manufacturer diagnosis and repair of inverter fault',
      handoff_dependency: 'manufacturer_decision',
      handoff_dependency_detail: 'Mitsubishi technical support case MEUK-77120 — awaiting callback on whether inverter or compressor',
      handoff_operating_condition: 'East wing unit isolated; west wing unaffected',
      handoff_parts_specialist: 'Probable inverter PCB; manufacturer to confirm',
      handoff_promises: 'Told Ruth we would update her within two working days',
      handoff_urgency: 'P3',
      handoff_next_owner_user_id: String(U.leanne.id),
      handoff_review_at: local(-60 * 24 * 2),
      ack_name: 'Ruth Sutcliffe',
      ack_role: 'Estate manager',
    }, 180);
    at(-60 * 24 * 5 + 240, () =>
      sla.startClockStop(db, coord2, L7, {
        reason_category: 'manufacturer',
        contractual_basis: 'Contract clause: clock stop for manufacturer decisions',
        dependency_detail: 'Awaiting Mitsubishi technical support decision (case MEUK-77120)',
        evidence: 'Case logged by Sam Dixon; email acknowledgement from Mitsubishi',
        expected_actor: 'Mitsubishi Electric technical support',
        owner_user_id: String(U.leanne.id),
        chase_at: local(-60 * 24 * 3),
      }),
    );

    // L8: Irwell — attendance completed yesterday, waiting office review (not auto-closed)
    const L8 = at(-60 * 30, () =>
      newJob({ site: 'irwell_lc', assets: ['ir_pool_ahu'], title: 'Pool hall AHU noisy bearing', symptom: 'Squealing from pool hall AHU', reporter: 'Gary Nuttall', reporterContact: 'ir_fm', impact: 'Noise; AHU running', priority: 'P3', reason: 'Running, risk of failure', authority: 'delegated_spend', authorityRef: 'G. Nuttall verbal approval up to £400', comps: 'ventilation', minutes: 120 }),
    );
    at(-60 * 30 + 10, () => ready(L8));
    const L8a = at(-60 * 30 + 15, () => assign(L8, 'kieran', -60 * 26, 150));
    at(-60 * 30 + 20, () => sched.dispatchAttendance(db, coord, L8a));
    visit(L8a, 'kieran', -60 * 26, null);
    at(-60 * 26 + 30, () => inv.issueToAttendance(db, U.kieran, L8a, { item_id: String(I['FLT-G4-592']), qty: '4' }));
    at(-60 * 26 + 120, () =>
      att.submitAttendance(db, U.kieran, L8a, {
        submit_key: 'seed-L8a',
        outcome: 'completed',
        authority_basis: 'delegated_spend',
        observed_facts: 'Supply fan belt glazed and slipping (squeal). Bearings OK. Filters dirty.',
        diagnosis: 'Worn/slipping drive belt',
        diagnosis_verified: 'on',
        work_done: 'Belt re-tensioned (no SPZ1250 on van — belt serviceable for now). Replaced 4 G4 filters.',
        final_condition: 'operating_normally',
        recommendations: 'Replace belt at next PPM.',
        labour_minutes: '90',
        travel_minutes: '25',
        ack_name: 'Gary Nuttall',
        ack_role: 'Facilities officer',
      }),
    );

    // L9: New unacknowledged-by-triage job just logged (St Wilfrid's Primary)
    at(-12, () =>
      jobs.createJob(db, coord2, {
        site_id: String(S.stw_primary),
        kind: 'reactive',
        title: 'Classroom 4 fan coil rattling',
        channel: 'email',
        received_at: toLocalInput(clock.iso()),
        priority: 'P3',
        priority_reason: 'Provisional — noise only reported',
        reported_symptom: 'Loud rattle from ceiling unit in classroom 4, started today',
        reported_by_name: 'Alan Hughes (caretaker)',
        reported_by_contact_id: String(CT.stw_caretaker),
        asset_ids: [String(A.stw_fcu4)],
      }),
    );

    // L10: Brightwell Warrington RTU (the temporary restoration job) — still waiting, now escalation from new visit
    const L10 = histIds[4];
    at(-60 * 24 * 8, () => jobs.setWaiting(db, coord, L10, { waiting_category: 'customer_approval', waiting_detail: 'Head office PO for fan motor (S. Rowe)', next_action: 'Chase Brightwell head office for PO', next_owner_user_id: String(U.dan.id), review_at: local(-60 * 24 * 1) }));
    at(-60 * 24 * 2, () => jobs.resolveWaiting(db, coord, L10, { resolution: 'PO BR-9921 received for fan motor', next_action: 'Fit fan motor', next_owner_user_id: String(U.dan.id), review_at: local(60 * 24) }));
    const L10a = at(-60 * 24 * 2 + 30, () => assign(L10, 'kieran', -90, 180, 'customer_confirmed', coord, 'Fit condenser fan motor (collect from stores). Two-person roof access — Jordan assisting.'));
    at(-60 * 24 * 2 + 40, () => sched.dispatchAttendance(db, coord, L10a));
    at(-120, () => att.progressAttendance(db, U.kieran, L10a, 'travel'));
    at(-80, () => att.progressAttendance(db, U.kieran, L10a, 'arrive'));
    at(-70, () =>
      att.raiseStop(db, U.kieran, L10a, {
        kind: 'stop_unsafe',
        detail: 'Wind gusting over 30 mph on the roof — site rule is below 23 mph for the external ladder. Not safe to lift the motor up.',
        safety_condition: 'RTU still running on temporary fix; no change made.',
      }),
    );

    // L11: Deansgate Dental warranty — failed PCB held as evidence
    const L11 = at(-60 * 24 * 4, () =>
      newJob({ site: 'dd_practice', assets: ['dd_split1'], kind: 'warranty', title: 'Waiting room split not working (installed this spring)', symptom: 'Unit dead, no display', reporter: 'Sarah Whitfield', reporterContact: 'dd_pm', impact: 'Waiting room warm', priority: 'P3', reason: 'Comfort; within installation warranty', authority: 'warranty_investigation', authorityRef: 'FrostLine installation warranty', comps: 'aircon, daikin' }),
    );
    at(-60 * 24 * 4 + 10, () => ready(L11));
    const L11a = at(-60 * 24 * 4 + 20, () => assign(L11, 'tom', -60 * 24 * 3, 120, 'customer_confirmed'));
    at(-60 * 24 * 4 + 30, () => sched.dispatchAttendance(db, coord, L11a));
    visit(L11a, 'tom', -60 * 24 * 3, null);
    at(-60 * 24 * 3 + 60, () =>
      inv.createEvidenceHold(db, U.tom, {
        description: 'Daikin RXM25R outdoor PCB — failed (burn mark at power supply section)',
        job_id: String(L11),
        attendance_id: String(L11a),
        asset_id: String(A.dd_split1),
        failure_evidence: 'No 5V on PCB; visible burn at SMPS section. Photos on job.',
        tests_photos: 'Supply 238V at terminal block; fuse intact; no output from SMPS.',
        condition_packaging: 'Bagged in anti-static bag, labelled with job and serial',
        storage_location_id: String(LOC.tom),
        storage_detail: 'Van evidence box until returned to depot',
        deadline: new Date(NOW.getTime() + 25 * DAY).toISOString().slice(0, 10),
        manufacturer_ref: '',
        next_action: 'Return to depot and log warranty claim with Daikin',
        next_owner_user_id: String(U.mick.id),
      }),
    );
    at(-60 * 24 * 3 + 90, () =>
      att.submitAttendance(db, U.tom, L11a, {
        submit_key: 'seed-L11a',
        outcome: 'missing_parts_tools',
        authority_basis: 'warranty_investigation',
        observed_facts: 'Outdoor unit PCB failed (no 5V, burn at SMPS). Indoor unit OK.',
        diagnosis: 'Outdoor PCB failure',
        diagnosis_verified: 'on',
        work_done: 'Removed failed PCB for warranty evidence; ordered replacement under warranty.',
        final_condition: 'not_operating',
        uncertainty: 'Cause of PCB failure not established (possible supply transient).',
        labour_minutes: '60',
        handoff_required_outcome: 'Fit replacement outdoor PCB under warranty and recommission',
        handoff_dependency: 'part_availability',
        handoff_dependency_detail: 'Replacement PCB 2P479216 on order from Daikin (warranty) — ETA 3–5 days',
        handoff_operating_condition: 'Unit isolated, not operating',
        handoff_parts_specialist: 'Daikin PCB 2P479216',
        handoff_promises: 'Told practice manager we will call with a date once the part arrives',
        handoff_urgency: 'P3',
        handoff_authority: 'Installation warranty — no charge to customer; liability for cause not yet established',
        handoff_next_owner_user_id: String(U.leanne.id),
        handoff_review_at: local(60 * 24 * 2),
        ack_name: 'Sarah Whitfield',
        ack_role: 'Practice manager',
      }),
    );
    at(-60 * 24 * 3 + 120, () => jobs.setCommercialStatus(db, U.susan, L11, { commercial_status: 'warranty_or_liability_pending', reason: 'Installation warranty claim; cause of PCB failure not established' }));

    // L12: Ribble View — no access; clock stopped; waiting access
    const L12 = at(-60 * 9, () =>
      newJob({ site: 'ribble', assets: ['rib_ahu'], title: 'Laundry extract not running', symptom: 'Laundry extract fan stopped; laundry humid', reporter: 'Lee Marsden', reporterContact: 'pc_rib', impact: 'Laundry very humid; driers overheating risk', priority: 'P2', reason: 'Care home laundry; overheating risk to driers', authority: 'contract_minor_repair', comps: 'ventilation' }),
    );
    at(-60 * 9 + 10, () => ready(L12));
    const L12a = at(-60 * 9 + 15, () => assign(L12, 'kieran', -60 * 7, 120));
    at(-60 * 9 + 20, () => sched.dispatchAttendance(db, coord, L12a));
    visit(L12a, 'kieran', -60 * 7, {
      outcome: 'no_access',
      authority_basis: 'contract_minor_repair',
      observed_facts: 'Arrived 10:02. Plant room locked; maintenance lead off site; duty manager has no key.',
      work_done: '',
      final_condition: 'unknown',
      labour_minutes: '20',
      handoff_required_outcome: 'Re-attend when plant room key available',
      handoff_dependency: 'access',
      handoff_dependency_detail: 'Plant room key only held by Lee Marsden (back on site 16:00)',
      handoff_operating_condition: 'Not inspected — extract believed stopped',
      handoff_urgency: 'P2',
      handoff_next_owner_user_id: String(U.dan.id),
      handoff_review_at: local(60 * 2),
      ack_name: '',
      ack_not_obtained_reason: 'Duty manager busy with residents; spoke by phone',
    }, 20);
    at(-60 * 7 + 30, () =>
      sla.startClockStop(db, coord, L12, {
        reason_category: 'no_access',
        contractual_basis: 'Contract: clock stops for denied access, evidenced in writing',
        dependency_detail: 'Plant room locked; key holder off site until 16:00',
        evidence: 'Engineer arrival 10:02 logged; email to Lee Marsden sent 10:15',
        expected_actor: 'Lee Marsden (Pennine maintenance lead)',
        owner_user_id: String(U.dan.id),
        chase_at: local(60 * 2),
      }),
    );

    // L13: Planned maintenance this week (Northgate) — scheduled, provisional; Chester AHU motor job readying.
    for (const [siteKey, off, eng] of [
      ['kingsway', 60 * 24 + 60, 'aisha'],
      ['stanns', 60 * 24 * 2 + 60, 'jordan'],
      ['albion', 60 * 24 * 3, 'aisha'],
    ] as [string, number, string][]) {
      const pj = at(-60 * 24 * 7, () =>
        newJob({ site: siteKey, kind: 'planned', channel: 'planned', title: 'Q3 PPM visit', priority: 'P4', reason: 'Contract PPM schedule', authority: 'planned_maintenance', authorityRef: 'Contract PPM schedule', comps: eng === 'jordan' ? 'ventilation' : 'aircon', minutes: 300 }),
      );
      at(-60 * 24 * 7 + 5, () => ready(pj));
      at(-60 * 24 * 7 + 10, () => assign(pj, eng, off, 300, 'provisional'));
    }
    // Chester AHU (released quoted works): motor reserved; readiness partly confirmed.
    at(-60 * 24 * 10, () =>
      inv.receiveGoods(db, U.mick, {
        supplier: 'Motor Supplies North',
        po_ref: 'PO-31802',
        location_id: String(LOC.WH),
        line_item_id: [String(I['MTR-AHU-4KW'])],
        line_qty_received: ['1'],
        line_condition: ['good'],
        line_job_id: [String(jobChesterAhu)],
      }),
    );
    at(-60 * 24 * 9, () =>
      jobs.updateReadiness(db, coord2, jobChesterAhu, {
        ready_scope: 'on',
        ready_authority: 'on',
        ready_parts: 'on',
        ready_competence: 'on',
        required_competences: 'ventilation',
        estimated_minutes: '600',
        expected_resources: 'Motor (job-allocated stock in depot), SPZ belts, pulley puller',
      }),
    );
    at(-60 * 24 * 9 + 5, () =>
      jobs.setNextAction(db, coord2, jobChesterAhu, { next_action: 'Confirm service lift booking and conference suite downtime with hotel GM', next_owner_user_id: String(coord2.id), review_at: local(-60 * 24 * 1) }),
    );

    // L14: A ready-but-unscheduled P3 (Kingsway standby split noisy)
    const L14 = at(-60 * 24, () =>
      newJob({ site: 'kingsway', assets: ['ks_split2'], title: 'Server room standby split noisy fan', symptom: 'Standby unit indoor fan noisy when it runs', reporter: 'Paul Hurst', reporterContact: 'ng_ks', impact: 'Duty unit OK; standby reliability concern', priority: 'P3', reason: 'Standby resilience only', authority: 'contract_minor_repair', comps: 'aircon' }),
    );
    at(-60 * 24 + 10, () => ready(L14));

    // Reservation + reallocation example: pump reserved for L6 at Aisha's van.
    at(-60 * 3, () =>
      inv.reserve(db, U.mick, {
        item_id: String(I['PMP-MINI-OR']),
        location_id: String(LOC.aisha),
        qty: '1',
        job_id: String(L6),
        purpose: 'Likely condensate pump replacement at Brightwell Stockport',
        owner_user_id: String(U.dan.id),
        required_by: local(0),
        review_at: local(60 * 24),
        substitution_allowed: 'on',
        reallocation_consequence: 'Aisha would need a warehouse run for another pump',
      }),
    );
    // Return pending in Tom's van (unused capacitor from an earlier job)
    at(-60 * 20, () => inv.bookReturn(db, U.tom, { item_id: String(I['CAP-35-5']), qty: '1', location_id: String(LOC.tom), job_id: String(histIds[1]), note: 'Took spare, not used; box opened' }));
    // Variation on Chester AHU job (post-award change)
    at(-60 * 24 * 8, () =>
      quotes.createVariation(db, U.owen, {
        acceptance_id: String(acc2),
        job_id: String(jobChesterAhu),
        classification: 'failed_assumption',
        description: 'Survey found motor frame larger than quoted (132 vs 112) — new base plate needed',
        scope_impact: 'Fabricate and fit adaptor base plate',
        value_impact: '185.00',
        customer_ref: '',
      }),
    );

    // Notifications: mark older ones as read for a tidier demo
    db.prepare(`UPDATE notifications SET read_at = created_at WHERE created_at < ?`).run(iso(-60 * 24));
  } finally {
    clock.set(null);
  }
}
