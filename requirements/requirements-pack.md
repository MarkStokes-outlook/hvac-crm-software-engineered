# Requirements pack

All requirements below derive from the frozen discovery record. `Source` references discovery IDs, never hidden canonical material.

## Business requirements

- **BR-001 Operational truth** — provide one operational view of customers, sites, assets, work, attendances and dependencies. Source: Q001–Q005, Q038.
- **BR-002 Controlled service delivery** — support intake → triage → authority/readiness → schedule → attendance → follow-on → multidimensional closure. Source: Q006–Q021.
- **BR-003 Promise control** — make SLA events, customer commitments, waiting dependencies and owners visible. Source: Q008–Q013, Q032.
- **BR-004 Commercial control** — preserve quote maturity/revisions, acceptance validation and release boundary. Source: Q022–Q026.
- **BR-005 Material truth** — distinguish physical possession from legitimate availability and preserve custody. Source: Q027–Q031.
- **BR-006 Field usability** — engineer workflow must be mobile-friendly, evidence-first and safe. Source: Q014–Q020, Q036.
- **BR-007 Accountability** — consequential decisions are attributable/auditable. Source: Q007, Q009, Q012, Q026, Q034.
- **BR-008 Assistive AI** — AI reduces reading/writing overhead without acquiring business authority. Source: Q035.

## Functional requirements

- **FR-001** Manage customer organisations, legal/billing identity and typed contacts. Source: Q001–Q002.
- **FR-002** Manage sites with operational access/security/induction notes and contacts. Source: Q003.
- **FR-003** Manage assets/systems with manufacturer/model/serial/internal ID, ownership note and history. Source: Q004.
- **FR-004** Link jobs/projects and attendances to customer/site/assets without conflating those records. Source: Q001,Q004,Q005.
- **FR-005** Log reactive requests with reported symptom, impact/safety facts, channel/time, provisional priority and authority/contract context. Source: Q006–Q007.
- **FR-006** Record priority changes with reason, actor and timestamp. Source: Q007,Q034.
- **FR-007** Record distinct SLA events: received, acknowledged, response, dispatch, attendance, diagnosis, restoration, resolution, closure. Source: Q008.
- **FR-008** Record contract-permitted clock stops with reason/evidence/actor/owner/review/restart. Source: Q009.
- **FR-009** Represent readiness separately from scheduling; show unmet dependencies. Source: Q010–Q013.
- **FR-010** Schedule attendances with engineer, commitment type, dates/times and readiness/competence warnings. Source: Q010–Q012.
- **FR-011** Represent engineer competence/authorisation/site clearance as planning data; permit controlled override with reason rather than hard-coded omniscience. Source: Q010,Q015.
- **FR-012** Preserve schedule displacement decision and displaced-work follow-on. Source: Q012.
- **FR-013** Every waiting state has dependency category/text, owner and review/chase date. Source: Q013,Q017.
- **FR-014** Engineer mobile view exposes pre-travel context and allows travel/arrival/work progress. Source: Q014.
- **FR-015** Engineer can record stop/escalation, authority basis and safety/operating condition. Source: Q015–Q016.
- **FR-016** Attendance captures structured outcome, notes/evidence, time, materials, readings/photos metadata, customer acknowledgement and follow-on. Source: Q017–Q020.
- **FR-017** Temporary restoration requires limitations/residual risk/review date/approver/permanent owner. Source: Q019.
- **FR-018** Job operational, financial and commercial/warranty closure dimensions are independent. Source: Q021.
- **FR-019** Opportunity/quotation supports maturity, revision, scope, assumptions/exclusions/options, pricing/VAT, validity and approval. Source: Q022–Q025.
- **FR-020** Quote acceptance validates party/authority, revision/options, PO/value, terms flag, dates, validity and credit/deposit status before release. Source: Q024.
- **FR-021** Post-award change/variation records classification, scope/value impact and approval state. Source: Q025.
- **FR-022** Approval policy is configurable; consequential approvals retain approver/reason. Exact thresholds are seed/config data, not invented requirements. Source: Q026.
- **FR-023** Inventory item tracks identity, location, ownership and quantities/states including available/reserved/picked/issued/quarantine/return/evidence/obsolete. Source: Q027.
- **FR-024** Reservation links quantity to work/purpose, owner, dates, substitution and reallocation consequence. Source: Q028.
- **FR-025** Goods receipt can quarantine exceptions without increasing available stock. Source: Q029.
- **FR-026** Issue/transfer/return records preserve custody and require return assessment before availability. Source: Q030.
- **FR-027** Evidence-hold material preserves chain-of-custody fields and cannot be casually returned/disposed. Source: Q031.
- **FR-028** Dashboard exposes urgent/at-risk/waiting/committed/ready-unscheduled/SLA-risk work. Source: Q032.
- **FR-029** Role-oriented navigation/views for coordination, engineer, estimating, project, warehouse/procurement, finance and management. Source: Q033.
- **FR-030** Audit log for priority, clock, authority, schedule displacement, approval, stock state/reallocation and closure. Source: Q034.
- **FR-031** AI may summarise history, draft updates/notes, suggest triage questions and flag incomplete handoffs; output is visibly suggested and human-confirmed. Source: Q035.
- **FR-032** Search across customer/site/asset/job/quote identifiers and history. Source: Q036.
- **FR-033** Provide CSV import/export seams but no fabricated accounting integration. Source: Q039.

## Business rules

- **RULE-001:** Attendance completion never automatically closes its parent job. Q001,Q017,Q021.
- **RULE-002:** Priority is impact-based and changes are audited. Q007.
- **RULE-003:** Clock stops require contractual permission plus a genuine blocking dependency. Q009.
- **RULE-004:** Scheduled ≠ ready ≠ dispatched. Q011.
- **RULE-005:** Generic “on hold” is invalid without dependency owner/review. Q013.
- **RULE-006:** Customer acknowledgement is not commercial approval. Q020.
- **RULE-007:** Quote approval/issue is not purchase/start authority. Q024.
- **RULE-008:** Physical stock is not necessarily available. Q027.
- **RULE-009:** Reserved stock reallocation is an explicit decision with notification. Q028.
- **RULE-010:** Quarantined/evidence-held/customer-owned stock cannot be issued as general availability. Q027–Q031.
- **RULE-011:** AI cannot authorise spend, liability, SLA manipulation, diagnosis or safety decisions. Q035.

## Roles and permissions

Use RBAC plus record/action guards. `Coordinator`: service intake/triage/schedule/SLA actions. `Engineer`: assigned-work read, attendance/evidence/material use, stop/escalate; no commercial approval. `Estimator`: opportunities/quotes/revisions. `Project`: project planning/delivery. `Warehouse/Procurement`: inventory/reservation/receipt/issue/custody. `Finance`: billing/legal entity and financial closure views. `Manager/Director`: overrides/approvals/reporting. `Admin`: configuration/users. Monetary limits remain configurable and unset by default where discovery did not establish them.

## Non-functional requirements

- **NFR-001:** Responsive desktop/mobile web; core engineer flow usable at phone widths. Q036–Q037.
- **NFR-002:** Fast search/list interaction suitable for live calls; paginate/filter large lists. Q036.
- **NFR-003:** Durable transactional persistence; submitted attendance/evidence metadata must not disappear on refresh/restart. Q036.
- **NFR-004:** Authentication boundary and least-privilege RBAC; protect site/security notes. Q033,Q036.
- **NFR-005:** Server-side validation and transactional guards for consequential transitions/inventory quantities. Q034,Q036.
- **NFR-006:** Immutable/append-oriented audit events for consequential actions. Q034.
- **NFR-007:** Accessible keyboard navigation, labels, focus and sensible contrast as professional baseline (engineering quality decision, not FrostLine business fact).
- **NFR-008:** Automated tests cover domain invariants and critical vertical workflows; deterministic seed/demo data supports evaluation.
- **NFR-009:** No customer portal/offline-first/accounting integration is required by discovery. Q037,Q039.