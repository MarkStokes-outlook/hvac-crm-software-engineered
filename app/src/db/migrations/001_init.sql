-- FrostLine operations CRM — initial schema.
-- Conventions: timestamps are ISO-8601 UTC text; money is integer pence;
-- current-state columns support queues, append-only tables retain history (ADR-003).

------------------------------------------------------------------ identity
CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  email         TEXT,
  phone         TEXT,
  role          TEXT NOT NULL CHECK (role IN ('coordinator','engineer','estimator','project','warehouse','finance','manager','admin')),
  password_hash TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  -- engineer planning metadata (FR-011)
  home_area     TEXT,
  van_location_id INTEGER,
  planning_notes TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  csrf_token  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

-- Configurable competence/authorisation tags; no invented universal taxonomy.
CREATE TABLE engineer_competences (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  tag         TEXT NOT NULL,
  detail      TEXT,
  valid_from  TEXT,
  valid_to    TEXT,
  notes       TEXT
);
CREATE INDEX ix_comp_user ON engineer_competences(user_id);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  description TEXT
);

-- Approval policy (FR-022, ADR-005). max_value_pence NULL = no monetary limit configured.
CREATE TABLE approval_policies (
  id              INTEGER PRIMARY KEY,
  action          TEXT NOT NULL,
  role            TEXT NOT NULL,
  max_value_pence INTEGER,
  notes           TEXT,
  UNIQUE (action, role)
);

------------------------------------------------------------------ CRM
CREATE TABLE customers (
  id              INTEGER PRIMARY KEY,
  ref             TEXT NOT NULL UNIQUE,
  trading_name    TEXT NOT NULL,
  legal_name      TEXT,
  company_number  TEXT,
  billing_address TEXT,
  billing_email   TEXT,
  invoice_notes   TEXT,
  po_required     INTEGER NOT NULL DEFAULT 0,
  sector          TEXT,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','prospect','inactive')),
  account_notes   TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE sites (
  id                 INTEGER PRIMARY KEY,
  customer_id        INTEGER NOT NULL REFERENCES customers(id),
  ref                TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  address            TEXT NOT NULL,
  town               TEXT,
  postcode           TEXT,
  area               TEXT,
  opening_hours      TEXT,
  parking_loading    TEXT,
  keys_security      TEXT,
  induction_permits  TEXT,
  induction_required INTEGER NOT NULL DEFAULT 0,
  roof_plant_access  TEXT,
  asbestos_info      TEXT,
  safeguarding       TEXT,
  work_restrictions  TEXT,
  billing_arrangement TEXT,
  access_confirmed_at TEXT,
  access_confirmed_by INTEGER REFERENCES users(id),
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX ix_sites_customer ON sites(customer_id);

CREATE TABLE contacts (
  id             INTEGER PRIMARY KEY,
  customer_id    INTEGER NOT NULL REFERENCES customers(id),
  site_id        INTEGER REFERENCES sites(id),
  name           TEXT NOT NULL,
  role_type      TEXT NOT NULL CHECK (role_type IN ('procurement','facilities','site','finance','technical','escalation','other')),
  job_title      TEXT,
  phone          TEXT,
  email          TEXT,
  can_authorise_spend INTEGER NOT NULL DEFAULT 0,
  authority_notes TEXT,
  notes          TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX ix_contacts_customer ON contacts(customer_id);
CREATE INDEX ix_contacts_site ON contacts(site_id);

CREATE TABLE engineer_site_clearances (
  id        INTEGER PRIMARY KEY,
  user_id   INTEGER NOT NULL REFERENCES users(id),
  site_id   INTEGER NOT NULL REFERENCES sites(id),
  detail    TEXT,
  valid_to  TEXT,
  notes     TEXT
);
CREATE INDEX ix_clear_user ON engineer_site_clearances(user_id);

CREATE TABLE assets (
  id              INTEGER PRIMARY KEY,
  site_id         INTEGER NOT NULL REFERENCES sites(id),
  ref             TEXT NOT NULL UNIQUE,
  category        TEXT NOT NULL,
  description     TEXT NOT NULL,
  manufacturer    TEXT,
  model           TEXT,
  serial          TEXT,
  location_detail TEXT,
  refrigerant     TEXT,
  install_date    TEXT,
  ownership_note  TEXT,
  status          TEXT NOT NULL DEFAULT 'in_service' CHECK (status IN ('in_service','out_of_service','decommissioned')),
  notes           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX ix_assets_site ON assets(site_id);

CREATE TABLE contracts (
  id                    INTEGER PRIMARY KEY,
  customer_id           INTEGER NOT NULL REFERENCES customers(id),
  ref                   TEXT NOT NULL UNIQUE,
  name                  TEXT NOT NULL,
  starts_on             TEXT NOT NULL,
  ends_on               TEXT,
  entitlement_notes     TEXT,
  clock_stop_permitted  INTEGER NOT NULL DEFAULT 0,
  clock_stop_terms      TEXT,
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','suspended')),
  created_at            TEXT NOT NULL
);

CREATE TABLE contract_sites (
  contract_id INTEGER NOT NULL REFERENCES contracts(id),
  site_id     INTEGER NOT NULL REFERENCES sites(id),
  PRIMARY KEY (contract_id, site_id)
);

-- Per-contract, per-priority targets (contract data, not invented business rules).
CREATE TABLE contract_targets (
  contract_id         INTEGER NOT NULL REFERENCES contracts(id),
  priority            TEXT NOT NULL CHECK (priority IN ('P1','P2','P3','P4')),
  response_minutes    INTEGER,
  attendance_minutes  INTEGER,
  resolution_minutes  INTEGER,
  PRIMARY KEY (contract_id, priority)
);

------------------------------------------------------------------ projects (thin: stage gates are a documented gap)
CREATE TABLE projects (
  id            INTEGER PRIMARY KEY,
  ref           TEXT NOT NULL UNIQUE,
  customer_id   INTEGER NOT NULL REFERENCES customers(id),
  site_id       INTEGER NOT NULL REFERENCES sites(id),
  title         TEXT NOT NULL,
  outcome       TEXT,
  manager_user_id INTEGER REFERENCES users(id),
  acceptance_id INTEGER,
  status        TEXT NOT NULL DEFAULT 'planning' CHECK (status IN ('planning','delivery','handover','complete','cancelled')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

------------------------------------------------------------------ service work
CREATE TABLE jobs (
  id                  INTEGER PRIMARY KEY,
  ref                 TEXT NOT NULL UNIQUE,
  kind                TEXT NOT NULL CHECK (kind IN ('reactive','planned','quoted_works','project_task','warranty','follow_on')),
  customer_id         INTEGER NOT NULL REFERENCES customers(id),
  site_id             INTEGER NOT NULL REFERENCES sites(id),
  contract_id         INTEGER REFERENCES contracts(id),
  project_id          INTEGER REFERENCES projects(id),
  acceptance_id       INTEGER,
  parent_job_id       INTEGER REFERENCES jobs(id),
  title               TEXT NOT NULL,
  -- intake facts (FR-005)
  reported_symptom    TEXT,
  reported_by_name    TEXT,
  reported_by_contact_id INTEGER REFERENCES contacts(id),
  channel             TEXT CHECK (channel IN ('phone','email','engineer','portal_other','planned','quote')),
  received_at         TEXT NOT NULL,
  impact              TEXT,
  safety_risk         TEXT,
  safety_flag         INTEGER NOT NULL DEFAULT 0,
  -- priority (FR-006)
  priority            TEXT NOT NULL CHECK (priority IN ('P1','P2','P3','P4')),
  priority_reason     TEXT NOT NULL,
  triage_notes        TEXT,
  -- authority (Q016)
  authority_basis     TEXT NOT NULL DEFAULT 'not_established',
  authority_ref       TEXT,
  authority_notes     TEXT,
  customer_po         TEXT,
  -- readiness (FR-009); each flag is an explicit human confirmation
  ready_scope         INTEGER NOT NULL DEFAULT 0,
  ready_authority     INTEGER NOT NULL DEFAULT 0,
  ready_access        INTEGER NOT NULL DEFAULT 0,
  ready_competence    INTEGER NOT NULL DEFAULT 0,
  ready_parts         INTEGER NOT NULL DEFAULT 0,
  ready_dependencies  INTEGER NOT NULL DEFAULT 0,
  emergency_proceed   INTEGER NOT NULL DEFAULT 0,
  emergency_reason    TEXT,
  required_competences TEXT,
  estimated_minutes   INTEGER,
  expected_resources  TEXT,
  -- independent state dimensions (FR-018)
  op_status           TEXT NOT NULL DEFAULT 'new' CHECK (op_status IN ('new','triaged','authorised','ready','scheduled','dispatched','in_progress','waiting','operationally_complete','cancelled')),
  financial_status    TEXT NOT NULL DEFAULT 'not_ready' CHECK (financial_status IN ('not_ready','ready_to_invoice','invoiced','financially_closed')),
  commercial_status   TEXT NOT NULL DEFAULT 'clear' CHECK (commercial_status IN ('clear','approval_required','warranty_or_liability_pending','disputed','resolved')),
  -- next action / waiting (FR-013, RULE-005)
  waiting_category    TEXT,
  waiting_detail      TEXT,
  waiting_since       TEXT,
  next_action         TEXT,
  next_owner_user_id  INTEGER REFERENCES users(id),
  review_at           TEXT,
  coordinator_user_id INTEGER REFERENCES users(id),
  created_by          INTEGER REFERENCES users(id),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  version             INTEGER NOT NULL DEFAULT 1,
  CHECK (op_status <> 'waiting' OR (waiting_category IS NOT NULL AND next_owner_user_id IS NOT NULL AND review_at IS NOT NULL))
);
CREATE INDEX ix_jobs_site ON jobs(site_id);
CREATE INDEX ix_jobs_customer ON jobs(customer_id);
CREATE INDEX ix_jobs_status ON jobs(op_status, priority);
CREATE INDEX ix_jobs_review ON jobs(review_at);

CREATE TABLE job_assets (
  job_id   INTEGER NOT NULL REFERENCES jobs(id),
  asset_id INTEGER NOT NULL REFERENCES assets(id),
  PRIMARY KEY (job_id, asset_id)
);
CREATE INDEX ix_job_assets_asset ON job_assets(asset_id);

CREATE TABLE priority_changes (
  id           INTEGER PRIMARY KEY,
  job_id       INTEGER NOT NULL REFERENCES jobs(id),
  from_priority TEXT,
  to_priority  TEXT NOT NULL,
  reason       TEXT NOT NULL,
  decided_by   INTEGER NOT NULL REFERENCES users(id),
  decided_at   TEXT NOT NULL
);

CREATE TABLE job_notes (
  id          INTEGER PRIMARY KEY,
  job_id      INTEGER NOT NULL REFERENCES jobs(id),
  kind        TEXT NOT NULL CHECK (kind IN ('note','customer_update','handoff','triage','system')),
  body        TEXT NOT NULL,
  author_id   INTEGER REFERENCES users(id),
  ai_interaction_id INTEGER,
  created_at  TEXT NOT NULL
);
CREATE INDEX ix_job_notes_job ON job_notes(job_id);

-- SLA events are append-only (FR-007, AC-021-04). Corrections supersede, never edit.
CREATE TABLE sla_events (
  id            INTEGER PRIMARY KEY,
  job_id        INTEGER NOT NULL REFERENCES jobs(id),
  type          TEXT NOT NULL CHECK (type IN ('received','acknowledged','response','dispatched','attendance','diagnosis','restoration','resolution','closure')),
  occurred_at   TEXT NOT NULL,
  recorded_at   TEXT NOT NULL,
  recorded_by   INTEGER REFERENCES users(id),
  attendance_id INTEGER,
  source        TEXT NOT NULL CHECK (source IN ('manual','system','attendance')),
  note          TEXT,
  supersedes_id INTEGER REFERENCES sla_events(id),
  superseded    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_sla_job ON sla_events(job_id);

CREATE TABLE clock_stops (
  id                 INTEGER PRIMARY KEY,
  job_id             INTEGER NOT NULL REFERENCES jobs(id),
  reason_category    TEXT NOT NULL CHECK (reason_category IN ('no_access','permit','customer_delay','unsafe_external','utilities','third_party','manufacturer','parts')),
  contractual_basis  TEXT NOT NULL,
  dependency_detail  TEXT NOT NULL,
  evidence           TEXT NOT NULL,
  expected_actor     TEXT NOT NULL,
  owner_user_id      INTEGER NOT NULL REFERENCES users(id),
  chase_at           TEXT NOT NULL,
  started_at         TEXT NOT NULL,
  started_by         INTEGER NOT NULL REFERENCES users(id),
  ended_at           TEXT,
  ended_by           INTEGER REFERENCES users(id),
  end_note           TEXT,
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX ix_clock_job ON clock_stops(job_id);

------------------------------------------------------------------ scheduling & attendance
CREATE TABLE attendances (
  id                  INTEGER PRIMARY KEY,
  ref                 TEXT NOT NULL UNIQUE,
  job_id              INTEGER NOT NULL REFERENCES jobs(id),
  engineer_user_id    INTEGER NOT NULL REFERENCES users(id),
  status              TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','dispatched','travelling','on_site','working','submitted','cancelled')),
  commitment          TEXT NOT NULL DEFAULT 'provisional' CHECK (commitment IN ('provisional','customer_confirmed')),
  planned_start       TEXT NOT NULL,
  planned_end         TEXT NOT NULL,
  instructions        TEXT,
  warnings            TEXT,
  override_reason     TEXT,
  override_by         INTEGER REFERENCES users(id),
  scheduled_by        INTEGER REFERENCES users(id),
  scheduled_at        TEXT,
  dispatched_at       TEXT,
  travel_started_at   TEXT,
  arrived_at          TEXT,
  work_started_at     TEXT,
  work_ended_at       TEXT,
  submitted_at        TEXT,
  -- outcome & evidence (FR-016). Separate reported/observed/diagnosis/work/final condition (Q018).
  outcome             TEXT,
  authority_basis     TEXT,
  reported_confirmed  TEXT,
  observed_facts      TEXT,
  tests_performed     TEXT,
  diagnosis           TEXT,
  diagnosis_verified  INTEGER NOT NULL DEFAULT 0,
  work_done           TEXT,
  final_condition     TEXT CHECK (final_condition IS NULL OR final_condition IN ('operating_normally','operating_limited','made_safe_isolated','not_operating','unknown')),
  safety_notes        TEXT,
  uncertainty         TEXT,
  recommendations     TEXT,
  labour_minutes      INTEGER,
  travel_minutes      INTEGER,
  -- handoff (Q017)
  followon_required   INTEGER NOT NULL DEFAULT 0,
  handoff_required_outcome TEXT,
  handoff_dependency  TEXT,
  handoff_dependency_detail TEXT,
  handoff_operating_condition TEXT,
  handoff_parts_specialist TEXT,
  handoff_promises    TEXT,
  handoff_urgency     TEXT,
  handoff_authority   TEXT,
  handoff_next_owner_user_id INTEGER REFERENCES users(id),
  -- customer acknowledgement (Q020) — never commercial approval
  ack_name            TEXT,
  ack_role            TEXT,
  ack_at              TEXT,
  ack_comment         TEXT,
  ack_not_obtained_reason TEXT,
  cancelled_reason    TEXT,
  submit_key          TEXT UNIQUE,
  version             INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL,
  CHECK (planned_end > planned_start)
);
CREATE INDEX ix_att_engineer ON attendances(engineer_user_id, planned_start);
CREATE INDEX ix_att_job ON attendances(job_id);

CREATE TABLE attendance_stops (
  id            INTEGER PRIMARY KEY,
  attendance_id INTEGER NOT NULL REFERENCES attendances(id),
  kind          TEXT NOT NULL CHECK (kind IN ('stop_unsafe','stop_competence','escalate_scope','escalate_access','escalate_equipment','escalate_time','escalate_authority','other')),
  detail        TEXT NOT NULL,
  safety_condition TEXT,
  raised_by     INTEGER NOT NULL REFERENCES users(id),
  raised_at     TEXT NOT NULL,
  resolved_at   TEXT,
  resolved_by   INTEGER REFERENCES users(id),
  resolution    TEXT
);

CREATE TABLE readings (
  id            INTEGER PRIMARY KEY,
  attendance_id INTEGER NOT NULL REFERENCES attendances(id),
  asset_id      INTEGER REFERENCES assets(id),
  name          TEXT NOT NULL,
  value         TEXT NOT NULL,
  unit          TEXT,
  recorded_at   TEXT NOT NULL
);

CREATE TABLE evidence (
  id            INTEGER PRIMARY KEY,
  job_id        INTEGER NOT NULL REFERENCES jobs(id),
  attendance_id INTEGER REFERENCES attendances(id),
  kind          TEXT NOT NULL CHECK (kind IN ('photo','certificate','document','commissioning','other')),
  caption       TEXT NOT NULL,
  file_name     TEXT,
  stored_path   TEXT,
  mime_type     TEXT,
  size_bytes    INTEGER,
  sha256        TEXT,
  captured_by   INTEGER NOT NULL REFERENCES users(id),
  captured_at   TEXT NOT NULL
);
CREATE INDEX ix_evidence_job ON evidence(job_id);

CREATE TABLE attendance_materials (
  id            INTEGER PRIMARY KEY,
  attendance_id INTEGER NOT NULL REFERENCES attendances(id),
  item_id       INTEGER REFERENCES stock_items(id),
  description   TEXT NOT NULL,
  qty           INTEGER NOT NULL CHECK (qty > 0),
  source        TEXT NOT NULL CHECK (source IN ('van_stock','reserved_stock','purchased_direct','customer_supplied','other')),
  movement_id   INTEGER,
  recorded_by   INTEGER NOT NULL REFERENCES users(id),
  recorded_at   TEXT NOT NULL
);

CREATE TABLE temporary_restorations (
  id               INTEGER PRIMARY KEY,
  job_id           INTEGER NOT NULL REFERENCES jobs(id),
  attendance_id    INTEGER NOT NULL REFERENCES attendances(id),
  change_made      TEXT NOT NULL,
  reason           TEXT NOT NULL,
  service_restored TEXT NOT NULL,
  limitations      TEXT NOT NULL,
  residual_risk    TEXT NOT NULL,
  monitoring       TEXT,
  review_at        TEXT NOT NULL,
  customer_understanding TEXT NOT NULL,
  approver         TEXT NOT NULL,
  permanent_owner_user_id INTEGER NOT NULL REFERENCES users(id),
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolved_at      TEXT,
  resolved_by      INTEGER REFERENCES users(id),
  resolution_note  TEXT,
  created_at       TEXT NOT NULL
);

CREATE TABLE schedule_displacements (
  id                  INTEGER PRIMARY KEY,
  attendance_id       INTEGER NOT NULL REFERENCES attendances(id),
  displacing_job_id   INTEGER REFERENCES jobs(id),
  change_type         TEXT NOT NULL CHECK (change_type IN ('displaced','rescheduled','cancelled')),
  previous_start      TEXT NOT NULL,
  previous_end        TEXT NOT NULL,
  new_start           TEXT,
  new_end             TEXT,
  reason              TEXT NOT NULL,
  authorised_by       INTEGER NOT NULL REFERENCES users(id),
  comms_owner_user_id INTEGER NOT NULL REFERENCES users(id),
  comms_note          TEXT NOT NULL,
  new_next_action     TEXT NOT NULL,
  new_owner_user_id   INTEGER NOT NULL REFERENCES users(id),
  review_at           TEXT NOT NULL,
  created_by          INTEGER NOT NULL REFERENCES users(id),
  created_at          TEXT NOT NULL
);

------------------------------------------------------------------ commercial
CREATE TABLE opportunities (
  id              INTEGER PRIMARY KEY,
  ref             TEXT NOT NULL UNIQUE,
  customer_id     INTEGER NOT NULL REFERENCES customers(id),
  site_id         INTEGER REFERENCES sites(id),
  title           TEXT NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('enquiry','engineer_recommendation','maintenance_finding','tender','other')),
  originating_job_id INTEGER REFERENCES jobs(id),
  owner_user_id   INTEGER REFERENCES users(id),
  maturity        TEXT NOT NULL DEFAULT 'enquiry' CHECK (maturity IN ('enquiry','qualified','survey','estimate','quoted','awarded','lost','withdrawn')),
  estimate_basis  TEXT NOT NULL DEFAULT 'budget_indication' CHECK (estimate_basis IN ('budget_indication','concept_estimate','developed_estimate','approved_quotation_basis','delivery_forecast')),
  notes           TEXT,
  created_by      INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE quote_revisions (
  id               INTEGER PRIMARY KEY,
  opportunity_id   INTEGER NOT NULL REFERENCES opportunities(id),
  rev_no           INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','internally_approved','issued','superseded','accepted','declined','expired')),
  scope            TEXT NOT NULL DEFAULT '',
  equipment_materials TEXT,
  programme        TEXT,
  assumptions      TEXT,
  exclusions       TEXT,
  warranty_position TEXT,
  customer_responsibilities TEXT,
  payment_terms    TEXT,
  acceptance_method TEXT,
  outage_design_notes TEXT,
  vat_rate_bp      INTEGER NOT NULL DEFAULT 2000,
  valid_until      TEXT,
  change_summary   TEXT,
  created_by       INTEGER REFERENCES users(id),
  created_at       TEXT NOT NULL,
  approved_by      INTEGER REFERENCES users(id),
  approved_at      TEXT,
  approval_reason  TEXT,
  issued_by        INTEGER REFERENCES users(id),
  issued_at        TEXT,
  closed_reason    TEXT,
  version          INTEGER NOT NULL DEFAULT 1,
  UNIQUE (opportunity_id, rev_no)
);

CREATE TABLE quote_lines (
  id            INTEGER PRIMARY KEY,
  revision_id   INTEGER NOT NULL REFERENCES quote_revisions(id),
  sort          INTEGER NOT NULL DEFAULT 0,
  option_code   TEXT,
  line_type     TEXT NOT NULL CHECK (line_type IN ('labour','materials','equipment','subcontract','provisional_sum','other')),
  description   TEXT NOT NULL,
  qty           REAL NOT NULL CHECK (qty > 0),
  unit_price_pence INTEGER NOT NULL CHECK (unit_price_pence >= 0)
);

-- Content of a revision is immutable once it leaves draft.
CREATE TRIGGER trg_quote_lines_immutable_upd BEFORE UPDATE ON quote_lines
WHEN (SELECT status FROM quote_revisions WHERE id = OLD.revision_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'quote revision is locked'); END;
CREATE TRIGGER trg_quote_lines_immutable_del BEFORE DELETE ON quote_lines
WHEN (SELECT status FROM quote_revisions WHERE id = OLD.revision_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'quote revision is locked'); END;
CREATE TRIGGER trg_quote_lines_immutable_ins BEFORE INSERT ON quote_lines
WHEN (SELECT status FROM quote_revisions WHERE id = NEW.revision_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'quote revision is locked'); END;
CREATE TRIGGER trg_quote_rev_content_locked BEFORE UPDATE ON quote_revisions
WHEN OLD.status <> 'draft' AND (
  NEW.scope IS NOT OLD.scope OR NEW.equipment_materials IS NOT OLD.equipment_materials OR NEW.programme IS NOT OLD.programme
  OR NEW.assumptions IS NOT OLD.assumptions OR NEW.exclusions IS NOT OLD.exclusions OR NEW.warranty_position IS NOT OLD.warranty_position
  OR NEW.customer_responsibilities IS NOT OLD.customer_responsibilities OR NEW.payment_terms IS NOT OLD.payment_terms
  OR NEW.acceptance_method IS NOT OLD.acceptance_method OR NEW.vat_rate_bp IS NOT OLD.vat_rate_bp OR NEW.valid_until IS NOT OLD.valid_until
  OR NEW.outage_design_notes IS NOT OLD.outage_design_notes)
BEGIN SELECT RAISE(ABORT, 'quote revision is locked'); END;

CREATE TABLE acceptances (
  id                   INTEGER PRIMARY KEY,
  revision_id          INTEGER NOT NULL UNIQUE REFERENCES quote_revisions(id),
  accepted_options     TEXT NOT NULL DEFAULT '',
  accepted_net_pence   INTEGER NOT NULL,
  accepted_vat_pence   INTEGER NOT NULL,
  accepting_party      TEXT NOT NULL,
  accepting_contact_id INTEGER REFERENCES contacts(id),
  acceptance_received_at TEXT NOT NULL,
  acceptance_evidence  TEXT NOT NULL,
  -- validation checklist (Q024) — each item records a human check and a note
  chk_authority        INTEGER NOT NULL DEFAULT 0,
  chk_authority_note   TEXT,
  chk_revision_options INTEGER NOT NULL DEFAULT 0,
  chk_po_value         INTEGER NOT NULL DEFAULT 0,
  po_number            TEXT,
  po_value_pence       INTEGER,
  chk_terms            INTEGER NOT NULL DEFAULT 0,
  chk_terms_note       TEXT,
  chk_dates            INTEGER NOT NULL DEFAULT 0,
  proposed_start       TEXT,
  chk_validity_pricing INTEGER NOT NULL DEFAULT 0,
  chk_validity_note    TEXT,
  credit_deposit       TEXT NOT NULL DEFAULT 'unchecked' CHECK (credit_deposit IN ('unchecked','not_required','cleared','pending','refused')),
  credit_note          TEXT,
  recorded_by          INTEGER NOT NULL REFERENCES users(id),
  recorded_at          TEXT NOT NULL,
  released             INTEGER NOT NULL DEFAULT 0,
  released_by          INTEGER REFERENCES users(id),
  released_at          TEXT,
  release_reason       TEXT,
  release_target       TEXT CHECK (release_target IN ('job','project')),
  job_id               INTEGER REFERENCES jobs(id),
  project_id           INTEGER REFERENCES projects(id),
  version              INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE variations (
  id              INTEGER PRIMARY KEY,
  ref             TEXT NOT NULL UNIQUE,
  acceptance_id   INTEGER REFERENCES acceptances(id),
  job_id          INTEGER REFERENCES jobs(id),
  project_id      INTEGER REFERENCES projects(id),
  classification  TEXT NOT NULL CHECK (classification IN ('in_scope_clarification','frostline_error','customer_change','failed_assumption','third_party_dependency','emergency_make_safe','separate_follow_on')),
  description     TEXT NOT NULL,
  scope_impact    TEXT NOT NULL,
  value_impact_pence INTEGER NOT NULL DEFAULT 0,
  customer_ref    TEXT,
  status          TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected','withdrawn')),
  decided_by      INTEGER REFERENCES users(id),
  decided_at      TEXT,
  decision_reason TEXT,
  created_by      INTEGER NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL,
  CHECK (acceptance_id IS NOT NULL OR job_id IS NOT NULL OR project_id IS NOT NULL)
);

------------------------------------------------------------------ inventory
CREATE TABLE stock_items (
  id            INTEGER PRIMARY KEY,
  sku           TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  category      TEXT,
  unit          TEXT NOT NULL DEFAULT 'each',
  manufacturer  TEXT,
  part_number   TEXT,
  serial_tracked INTEGER NOT NULL DEFAULT 0,
  min_level     INTEGER,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

CREATE TABLE stock_locations (
  id               INTEGER PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('warehouse','van','site','supplier_return')),
  engineer_user_id INTEGER REFERENCES users(id),
  active           INTEGER NOT NULL DEFAULT 1
);

-- Physical quantity by item/location/state/ownership. qty can never be negative (AC-060-02).
-- owner_type: frostline = general stock; customer = customer-owned; job = project/job-specific.
CREATE TABLE stock_balances (
  id          INTEGER PRIMARY KEY,
  item_id     INTEGER NOT NULL REFERENCES stock_items(id),
  location_id INTEGER NOT NULL REFERENCES stock_locations(id),
  state       TEXT NOT NULL CHECK (state IN ('available','reserved','picked','quarantined','return_pending','evidence_hold','obsolete')),
  owner_type  TEXT NOT NULL DEFAULT 'frostline' CHECK (owner_type IN ('frostline','customer','job')),
  owner_ref   INTEGER NOT NULL DEFAULT 0,
  qty         INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
  UNIQUE (item_id, location_id, state, owner_type, owner_ref)
);

CREATE TABLE reservations (
  id                 INTEGER PRIMARY KEY,
  ref                TEXT NOT NULL UNIQUE,
  item_id            INTEGER NOT NULL REFERENCES stock_items(id),
  location_id        INTEGER NOT NULL REFERENCES stock_locations(id),
  qty                INTEGER NOT NULL CHECK (qty > 0),
  qty_outstanding    INTEGER NOT NULL CHECK (qty_outstanding >= 0),
  job_id             INTEGER REFERENCES jobs(id),
  project_id         INTEGER REFERENCES projects(id),
  customer_id        INTEGER REFERENCES customers(id),
  purpose            TEXT NOT NULL,
  requested_by       INTEGER NOT NULL REFERENCES users(id),
  owner_user_id      INTEGER NOT NULL REFERENCES users(id),
  required_by        TEXT NOT NULL,
  review_at          TEXT NOT NULL,
  substitution_allowed INTEGER NOT NULL DEFAULT 0,
  reallocation_consequence TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','picked','fulfilled','released','reallocated')),
  created_at         TEXT NOT NULL,
  closed_at          TEXT,
  closed_reason      TEXT
);
CREATE INDEX ix_res_job ON reservations(job_id);

CREATE TABLE goods_receipts (
  id           INTEGER PRIMARY KEY,
  ref          TEXT NOT NULL UNIQUE,
  supplier     TEXT NOT NULL,
  po_ref       TEXT,
  delivery_ref TEXT,
  carrier      TEXT,
  received_at  TEXT NOT NULL,
  received_by  INTEGER NOT NULL REFERENCES users(id),
  location_id  INTEGER NOT NULL REFERENCES stock_locations(id),
  notes        TEXT,
  receipt_key  TEXT UNIQUE,
  created_at   TEXT NOT NULL
);

CREATE TABLE receipt_lines (
  id              INTEGER PRIMARY KEY,
  receipt_id      INTEGER NOT NULL REFERENCES goods_receipts(id),
  item_id         INTEGER NOT NULL REFERENCES stock_items(id),
  qty_expected    INTEGER,
  qty_received    INTEGER NOT NULL CHECK (qty_received > 0),
  condition       TEXT NOT NULL CHECK (condition IN ('good','damaged','incorrect','uncertain')),
  allocated_job_id INTEGER REFERENCES jobs(id),
  evidence        TEXT,
  operational_impact TEXT,
  next_action     TEXT,
  next_owner_user_id INTEGER REFERENCES users(id),
  return_deadline TEXT,
  procurement_notified INTEGER NOT NULL DEFAULT 0,
  exception_status TEXT CHECK (exception_status IS NULL OR exception_status IN ('open','resolved')),
  resolved_note   TEXT
);

-- Append-only movement ledger (AC-063-01).
CREATE TABLE stock_movements (
  id              INTEGER PRIMARY KEY,
  movement_type   TEXT NOT NULL CHECK (movement_type IN ('receipt','reserve','unreserve','reallocate','pick','issue','transfer','return','assess','quarantine','release','evidence_hold','dispose','adjust')),
  item_id         INTEGER NOT NULL REFERENCES stock_items(id),
  qty             INTEGER NOT NULL CHECK (qty > 0),
  from_location_id INTEGER REFERENCES stock_locations(id),
  from_state      TEXT,
  to_location_id  INTEGER REFERENCES stock_locations(id),
  to_state        TEXT,
  owner_type      TEXT NOT NULL DEFAULT 'frostline',
  owner_ref       INTEGER NOT NULL DEFAULT 0,
  job_id          INTEGER REFERENCES jobs(id),
  attendance_id   INTEGER REFERENCES attendances(id),
  reservation_id  INTEGER REFERENCES reservations(id),
  receipt_line_id INTEGER REFERENCES receipt_lines(id),
  recipient       TEXT,
  serial_batch    TEXT,
  reason          TEXT,
  actor_id        INTEGER NOT NULL REFERENCES users(id),
  at              TEXT NOT NULL,
  idem_key        TEXT UNIQUE
);
CREATE INDEX ix_mov_item ON stock_movements(item_id, at);
CREATE TRIGGER trg_movements_no_update BEFORE UPDATE ON stock_movements
BEGIN SELECT RAISE(ABORT, 'stock movements are append-only'); END;
CREATE TRIGGER trg_movements_no_delete BEFORE DELETE ON stock_movements
BEGIN SELECT RAISE(ABORT, 'stock movements are append-only'); END;

-- Chain of custody for failed parts / warranty evidence (FR-027).
CREATE TABLE evidence_holds (
  id                  INTEGER PRIMARY KEY,
  ref                 TEXT NOT NULL UNIQUE,
  description         TEXT NOT NULL,
  item_id             INTEGER REFERENCES stock_items(id),
  qty                 INTEGER NOT NULL DEFAULT 1 CHECK (qty > 0),
  customer_id         INTEGER REFERENCES customers(id),
  site_id             INTEGER REFERENCES sites(id),
  asset_id            INTEGER REFERENCES assets(id),
  job_id              INTEGER REFERENCES jobs(id),
  attendance_id       INTEGER REFERENCES attendances(id),
  removed_at          TEXT NOT NULL,
  removed_by          INTEGER REFERENCES users(id),
  failure_evidence    TEXT NOT NULL,
  tests_photos        TEXT,
  condition_packaging TEXT NOT NULL,
  storage_location_id INTEGER REFERENCES stock_locations(id),
  storage_detail      TEXT,
  deadline            TEXT,
  manufacturer_ref    TEXT,
  supplier_ref        TEXT,
  next_action         TEXT NOT NULL,
  next_owner_user_id  INTEGER NOT NULL REFERENCES users(id),
  status              TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held','sent_to_supplier','released','disposed')),
  closed_by           INTEGER REFERENCES users(id),
  closed_at           TEXT,
  closed_reason       TEXT,
  created_by          INTEGER NOT NULL REFERENCES users(id),
  created_at          TEXT NOT NULL
);

CREATE TABLE custody_events (
  id        INTEGER PRIMARY KEY,
  hold_id   INTEGER NOT NULL REFERENCES evidence_holds(id),
  action    TEXT NOT NULL,
  detail    TEXT,
  actor_id  INTEGER NOT NULL REFERENCES users(id),
  at        TEXT NOT NULL
);
CREATE TRIGGER trg_custody_no_update BEFORE UPDATE ON custody_events
BEGIN SELECT RAISE(ABORT, 'custody events are append-only'); END;
CREATE TRIGGER trg_custody_no_delete BEFORE DELETE ON custody_events
BEGIN SELECT RAISE(ABORT, 'custody events are append-only'); END;

------------------------------------------------------------------ cross-cutting
CREATE TABLE notifications (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  kind       TEXT NOT NULL,
  message    TEXT NOT NULL,
  link       TEXT,
  created_at TEXT NOT NULL,
  read_at    TEXT
);
CREATE INDEX ix_notif_user ON notifications(user_id, read_at);

CREATE TABLE audit_events (
  id           INTEGER PRIMARY KEY,
  at           TEXT NOT NULL,
  actor_id     INTEGER REFERENCES users(id),
  actor_role   TEXT,
  entity_type  TEXT NOT NULL,
  entity_id    INTEGER,
  action       TEXT NOT NULL,
  reason       TEXT,
  before_json  TEXT,
  after_json   TEXT,
  correlation_id TEXT
);
CREATE INDEX ix_audit_entity ON audit_events(entity_type, entity_id);
CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
CREATE TRIGGER trg_sla_no_delete BEFORE DELETE ON sla_events
BEGIN SELECT RAISE(ABORT, 'SLA events are append-only'); END;
CREATE TRIGGER trg_sla_no_rewrite BEFORE UPDATE ON sla_events
WHEN NEW.occurred_at IS NOT OLD.occurred_at OR NEW.type IS NOT OLD.type OR NEW.job_id IS NOT OLD.job_id OR NEW.recorded_at IS NOT OLD.recorded_at
BEGIN SELECT RAISE(ABORT, 'SLA events are append-only'); END;
CREATE TRIGGER trg_clock_no_delete BEFORE DELETE ON clock_stops
BEGIN SELECT RAISE(ABORT, 'clock stops cannot be deleted'); END;
CREATE TRIGGER trg_clock_no_backdate BEFORE UPDATE ON clock_stops
WHEN NEW.started_at IS NOT OLD.started_at OR (OLD.ended_at IS NOT NULL AND NEW.ended_at IS NOT OLD.ended_at)
BEGIN SELECT RAISE(ABORT, 'clock stop timing cannot be rewritten'); END;

CREATE TABLE ai_interactions (
  id              INTEGER PRIMARY KEY,
  task            TEXT NOT NULL,
  actor_id        INTEGER NOT NULL REFERENCES users(id),
  entity_type     TEXT NOT NULL,
  entity_id       INTEGER NOT NULL,
  provider        TEXT NOT NULL,
  model           TEXT,
  template_version TEXT NOT NULL,
  source_refs     TEXT,
  output          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested','applied','copied','rejected')),
  decided_at      TEXT,
  created_at      TEXT NOT NULL
);

CREATE TABLE idempotency_keys (
  key        TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  result     TEXT
);

CREATE TABLE sequences (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

-- Attendance outcome codes are configuration (engineering interpretation of Q017), not hard-coded.
CREATE TABLE outcome_codes (
  code              TEXT PRIMARY KEY,
  label             TEXT NOT NULL,
  requires_followon INTEGER NOT NULL DEFAULT 0,
  temporary         INTEGER NOT NULL DEFAULT 0,
  resolves          INTEGER NOT NULL DEFAULT 0,
  sort              INTEGER NOT NULL DEFAULT 0,
  active            INTEGER NOT NULL DEFAULT 1
);
