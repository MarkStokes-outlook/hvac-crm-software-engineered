# Domain and data model

## Core aggregates

**Customer** (`id`, tradingName, legalName, billing details, status) has Contacts and Sites. **Site** has address, access/security/induction/safeguarding notes and Contacts. **Asset/System** belongs to Site, with manufacturer/model/serial/internalRef, ownership note, service history.

**Job** links customer/site and optionally assets, contract/quote; carries type, priority, reported need, authority/readiness, waiting dependency, next owner/review, and independent operational/financial/commercial states. **Attendance** belongs to Job (or Project work package where implemented) and records assignment, commitment, travel/arrival/work timestamps, authority basis, outcome, safety/final condition, evidence and follow-on.

**SlaEvent/ClockStop** belongs to Job/contract context. Events are typed and timestamped; clock stop includes contractual basis, dependency/evidence, owner, review and restart.

**EngineerProfile** links User to competences/authorisations/site clearances and planning metadata. Discovery does not define a universal competence taxonomy, so use configurable tags/records with validity dates and notes rather than invented certification rules.

**Opportunity/Quotation** has maturity, customer/site, owner, revisions. **QuoteRevision** preserves scope, assumptions, exclusions, options, price/VAT, validity, terms, approval. **Acceptance** references exact revision/options and validation evidence. **Variation/Change** records classification and approval.

**InventoryItem** identifies product/variant; **StockUnit/Balance** identifies location/ownership/condition/state; **Reservation** allocates quantity to purpose/work; **StockMovement** is append-only receipt/reserve/pick/issue/transfer/return/quarantine/release/dispose movement; **EvidenceHold** adds chain-of-custody metadata.

**AuditEvent**: actor, timestamp, entity type/id, action, reason, before/after summary, correlation ID. **AiInteraction**: task, actor, entity refs, prompt-template version/provider, output, accepted/rejected and accepted-at; never an authority record itself.

## Key invariants

1. Attendance outcome cannot implicitly set all Job closure dimensions.
2. `available` inventory is derived/guarded against reserved, quarantine, evidence-hold and ownership constraints; consequential stock movements are atomic.
3. Quote acceptance references an immutable revision; later edits create another revision/change.
4. Waiting work requires next owner + review trigger.
5. Temporary restoration requires review/expiry + permanent-resolution owner.
6. Priority/clock-stop/approval/reallocation/closure transitions require actor and reason.
7. AI output cannot directly execute protected transitions.

## Suggested state vocabularies

Job operational: `new | triaged | authorised | ready | scheduled | dispatched | in_progress | waiting | operationally_complete | cancelled`. Financial: `not_ready | ready_to_invoice | invoiced | financially_closed`. Commercial: `clear | approval_required | warranty_or_liability_pending | disputed | resolved`. Attendance outcomes use the discovery list as configurable codes.

Inventory: `available | reserved | picked | issued | quarantined | return_pending | evidence_hold | obsolete | disposed`. Quotation: `draft | internally_approved | issued | superseded | accepted | declined | expired`; commercial release is a separate boolean/state with validation record.

These vocabularies are engineering interpretations of discovered distinctions, not claims that FrostLine supplied exact labels.