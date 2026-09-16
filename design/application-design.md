# Application and UX design

## Information architecture

Persistent desktop navigation: **Dashboard · Service · Schedule · Customers · Assets · Quotes · Stock · Reports**. Role-aware secondary actions hide unauthorised mutation but do not create separate disconnected applications. Engineer mobile landing is **My day / Assigned work**.

## Dashboard

Cards/queues answer: urgent P1/P2; SLA at risk; waiting dependencies overdue; today's committed attendances; ready-but-unscheduled; temporary restorations nearing review; stock exceptions. Every metric drills into records and shows its definition rather than decorative totals. Trace FR-028.

## Customer / site / asset

Customer page: identity, contacts, sites, active work, quotes and recent history. Site page: access banner, contacts, assets, active work/history. Asset page: identity, ownership note, service timeline, open work and parts/evidence history. Cross-links keep physical/commercial identities visible. Trace FR-001..004.

## Service workspace

Intake wizard is short: identify customer/site/asset → reported symptom/impact/safety → contract/authority context → priority → triage outcome/next action. Job detail uses a header with priority and three closure dimensions, then tabs/sections for timeline, attendances, SLA, evidence, materials, commercial context and audit. A prominent **Next action** panel always shows dependency, owner and review date when open. Trace FR-005..013,018.

## Schedule

Day/week board plus unscheduled-ready queue. Assignment drawer shows engineer competence/clearance signals, location, existing commitments and parts/readiness. Warnings do not pretend to know undiscovered hard rules. Moving a customer-confirmed appointment or displacing work requires reason, communication owner and replacement next action. Trace FR-009..012.

## Engineer mobile workflow

1. My Day list: priority, time/window, site, symptom, access warning.
2. Job brief: scope/authority, asset/history, access/safety, expected parts/tools.
3. Actions: Start travelling → Arrive → Start/record work; stop/escalate always available.
4. Completion: structured attendance outcome; reported/observed/diagnosis/work/final condition; time/materials/readings/evidence; customer acknowledgement; follow-on dependency/owner.
5. Temporary restoration reveals mandatory limitation/residual-risk/review/permanent-owner fields.
6. Submit produces durable confirmation; job remains open unless separate rules/office review close it.

## Quotes

Opportunity list → estimate/quote workspace → immutable revisions → internal approval → issue → acceptance checklist → commercial release. Show assumptions/exclusions/options beside price; acceptance must visibly name the revision. Post-award change is a new controlled record, not an edit to history.

## Stock

Stock list shows on-hand alongside **available**, reserved and quarantine/evidence quantities. Item page has locations, reservations and movement timeline. Reservation/reallocation/issue/receipt/return use explicit dialogs with reason/owner where required. Damaged receipt defaults to quarantine. Evidence hold has a custody panel.

## AI affordances

Contextual buttons: “Summarise history”, “Suggest triage questions”, “Draft customer update”, “Check handoff completeness”. Render in a suggestion panel with source-record links and **Apply/Copy** rather than automatic mutation. Never present AI as approver/diagnostician.

## Visual system

Use the frozen public website only for brand cues (Frostline name/logo/colour feel), not as an application layout. Aim for credible operations software: compact tables on desktop, clear status chips, restrained colour, high information hierarchy, accessible forms and mobile touch targets.