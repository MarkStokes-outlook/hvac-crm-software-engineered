# Solution architecture

Engineering begins from the frozen discovery record only.

## ADR-001 — modular monolith

Build a single deployable web application with clear domain modules: Identity/Access, CRM (Customer/Site/Asset), Service Work, Scheduling, Field Attendance, Commercial/Quoting, Inventory, Audit/Reporting, AI Assistance. This keeps V1 operationally simple while preserving boundaries for later extraction. Trace: BR-001..008.

## ADR-002 — relational transactional persistence

Use PostgreSQL (or a repository-supported relational equivalent) with migrations and foreign keys. Business operations such as inventory issue/reservation, quote acceptance/release and lifecycle transitions execute server-side transactionally. Avoid browser-local persistence as system of record. Trace: FR-004, FR-018, FR-020, FR-023..027; NFR-003/005.

## ADR-003 — explicit state + event history

Current-state columns support efficient work queues, while append-only domain/audit events retain consequential transitions and reasons. Do not infer SLA timestamps from `updated_at`. Trace: FR-006..008, FR-030.

## ADR-004 — web application / responsive field mode

One responsive web app serves office and field roles. Desktop uses information-dense tables/boards; engineer routes use large touch targets, progressive disclosure and a focused attendance flow. No offline-first promise is made. Trace: FR-014..017, NFR-001.

## ADR-005 — policy service for authority

Centralise permission/action checks and configurable approval policies. Seed role capabilities, but do not invent monetary thresholds. Overrides require reason and audit. Trace: FR-022, roles, DISC-D008.

## ADR-006 — AI behind an advisory boundary

Expose AI through an `AiAssistant` application service with task-specific endpoints (summarise history, draft update, suggest triage questions, handoff completeness). Send only necessary record context, label output as suggestion, store provenance/task/actor when accepted. Never let model output directly mutate operational records. Provide a deterministic/mock provider when no API key is configured. Trace: FR-031, RULE-011.

## ADR-007 — evidence metadata first

V1 must persist evidence metadata/notes and may support local/object-storage attachment adapters if straightforward. The business requirement is durable attributable evidence, not a specific cloud blob vendor. Trace: FR-016, NFR-003.

## ADR-008 — integration seams, not fictional integrations

Provide import/export services and stable internal IDs. Do not claim accounting, customer portal or supplier integrations. Trace: FR-033, NFR-009.

## Runtime shape

Browser → server-rendered/API application → application services → domain modules → relational DB. Authentication middleware resolves user/role; authorisation/policy guards execute server-side. Audit writer participates in the same transaction as consequential changes. AI provider is outbound-only through an adapter. Optional attachment storage sits behind an interface.

## Security model

Authenticate every non-public route. Authorise actions, not just pages. Engineers see work relevant to them plus customer/site context required for delivery; commercial/finance and administration actions are separately permissioned. Site access/security notes are sensitive operational data. Never trust client-supplied actor, approval or stock totals. Use CSRF protection/session hardening appropriate to chosen framework, parameterised ORM/queries, validation schemas, secret/env configuration and no credentials in repo.

## Reliability and concurrency

Use database transactions and row/version locking or atomic conditional updates for stock reservation/issue and other contested transitions. Reject negative legitimate availability. Idempotency keys are recommended for consequential form/API submissions so refresh/retry does not duplicate receipt/issue/attendance actions. Surface conflicts to the user rather than last-write-wins silently.

## Observability

Structured server logs with correlation/request ID; audit events for business decisions; health endpoint; error boundary/user-safe error messages. Dashboard metrics derive from source events and states, not hard-coded demo numbers.