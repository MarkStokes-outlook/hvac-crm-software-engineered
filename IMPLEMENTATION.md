# Implementation notes — run/001/claude-opus-5-high-001

The application lives in [`app/`](app/README.md), which documents setup, run and test commands,
the demo accounts and the architecture. This file records how the implementation maps to the frozen
backlog, and the decisions taken where the engineering pack deliberately left implementation open.

Nothing in `reference/`, `discovery/`, `requirements/`, `architecture/`, `design/` or `backlog/` was
modified.

## Story coverage

| Story | Where it lives | Proven by |
| --- | --- | --- |
| **US-001** Shell, persistence, seed | `src/db/migrations/001_init.sql`, `src/db/db.ts`, `src/db/seed.ts`, `src/cli.ts` | `npm run setup` from clean; `workflow.test.ts` restart test |
| **US-002** Authentication, RBAC, audit | `src/auth/*`, `src/domain/audit.ts`, `src/web/app.ts` | `workflow.test.ts` access control; `domain.test.ts` audit |
| **US-010** Customer / site / contact | `src/domain/crm.ts`, `src/web/routes/customers.ts` | `workflow.test.ts` redaction; demo dataset |
| **US-011** Asset register and history | `src/domain/crm.ts` (`workHistory`), asset pages | Asset page timelines in the demo data |
| **US-020** Reactive intake and triage | `src/domain/jobs.ts`, `src/web/routes/jobs.ts` | `domain.test.ts` priority; `workflow.test.ts` end-to-end |
| **US-021** SLA events and clock stops | `src/domain/sla.ts` | `domain.test.ts` SLA suite (5 tests) |
| **US-022** Readiness and next action | `src/domain/jobs.ts` | `domain.test.ts` readiness progression, waiting rules |
| **US-030** Schedule board and assignment | `src/domain/scheduling.ts`, `src/web/routes/schedule.ts` | `domain.test.ts` signals and override |
| **US-031** Commitment displacement | `src/domain/scheduling.ts` (`applyDisplacement`) | `domain.test.ts` displacement |
| **US-040** My day and job brief | `src/domain/attendance.ts`, `src/web/routes/field.ts` | Phone-width renders; `workflow.test.ts` brief content |
| **US-041** Attendance execution and evidence | `src/domain/attendance.ts` | `domain.test.ts` execution; `workflow.test.ts` upload |
| **US-042** Temporary restoration and handoff | `src/domain/attendance.ts` (`submitAttendance`, `temporary_restorations`) | `domain.test.ts` closure blockers |
| **US-043** Customer acknowledgement | `src/domain/attendance.ts`, attendance UI | `domain.test.ts` acknowledgement |
| **US-050** Opportunity and revisions | `src/domain/quotes.ts`, migration triggers | `domain.test.ts` revision locking |
| **US-051** Acceptance and release | `src/domain/quotes.ts`, `src/auth/policy.ts` | `domain.test.ts` acceptance and release gating |
| **US-052** Post-award variation | `src/domain/quotes.ts` | `domain.test.ts` variation |
| **US-060** Inventory truth | `src/domain/inventory.ts` | `domain.test.ts` availability; `concurrency.test.ts` |
| **US-061** Reservation and reallocation | `src/domain/inventory.ts` | `domain.test.ts` reallocation; `concurrency.test.ts` |
| **US-062** Receipt and quarantine | `src/domain/inventory.ts` (`receiveGoods`) | `domain.test.ts` quarantine |
| **US-063** Issue, return, custody | `src/domain/inventory.ts` (`assessReturn`, evidence holds) | `domain.test.ts` returns and custody |
| **US-070** Dashboard and search | `src/domain/dashboard.ts`, `src/domain/search.ts` | Dashboard renders from records; search covers identifiers |
| **US-071** Advisory AI | `src/ai/assistant.ts`, `src/web/aipanel.ts` | `workflow.test.ts` AI suite |
| **US-072** Import/export and quality | `src/domain/importexport.ts`, CSS and field views | `workflow.test.ts` CSV; phone-width verification |

## Decisions taken where the pack left implementation open

| Decision | Reasoning |
| --- | --- |
| SQLite rather than PostgreSQL | ADR-002 allows "a repository-supported relational equivalent". This runs with no server to install, which the brief asked for. WAL, foreign keys, `CHECK` constraints, triggers and `BEGIN IMMEDIATE` transactions give the guarantees the architecture wanted; the SQL is ordinary and confined to the domain modules. |
| Server-rendered HTML, no client framework | The design calls for dense desktop tables and a focused mobile flow, not an application shell. Every action is a form that works without JavaScript, which also makes the permission model easy to prove. |
| Attendance outcome codes in a table | Discovery gave a list of honest outcomes but no vocabulary authority. Codes are configuration (label and availability editable in Admin); their behaviour flags stay in code because business rules depend on them. |
| "At risk" defined as <25% of the SLA window left | Q032 warned against vanity metrics, so the threshold is a visible, configurable setting and every dashboard card states its definition. |
| Working-time signal set at 10 hours planned | Q010 lists fatigue and working time as planning considerations without numbers. This is a configurable planning guide that produces a warning, never a block. |
| Van stock as distributed inventory locations | Q030 calls van stock distributed inventory. Each engineer has a van location, so a part used on site leaves that van and lands on the job. |
| Engineers see customer and site context only where they have work | The security model says engineers see work relevant to them plus the context needed to deliver it. Enforced in `crm.ts` and on the evidence file route. |
| Evidence files stored content-addressed on disk | ADR-007 wanted durable attributable evidence, not a particular vendor. Files are written and fsynced before the metadata row commits, and the SHA-256 is recorded. |
| Approval policy seeded with no monetary limits | DISC-D008 and discovery gap 1: the thresholds are a governance decision. Roles are granted actions; every limit is blank and the Admin page says why. |
| Projects kept deliberately thin | Q005 separates projects from jobs, but stage gates, applications for payment and retention are recorded gaps. Release can create a project and jobs can belong to one; nothing further is invented. |

## Verification performed

- `npm run typecheck` — clean.
- `npm test` — 42 tests, all passing, about three seconds.
- `npm run setup` from a clean checkout, then restart, confirming records persist.
- Pages rendered in headless Chromium at 390×844 (phone) and 1440×900 (desktop) for the engineer and
  office journeys: no horizontal overflow, primary field actions are large touch targets.
- Multi-process concurrency exercised with real OS processes against one database file.

Two defects were found by the tests and fixed: multipart bodies were parsed after the CSRF check, so
evidence uploads and CSV imports were rejected as expired forms; and a readiness update submitted
without the planning fields wiped the job's competence requirement.

## Known limitations

- Scheduling shows travel and geography as information; it does not compute travel time or optimise
  routes, because no travel-time source was established.
- Reporting covers the queues and counts discovery asked for; there is no report builder.
- The AI assistant is text-only and advisory. It cannot act, and is not offered as a command bar,
  because discovery placed consequential decisions with attributable humans.
- Attachments are stored on the local filesystem behind an authorised route; no object storage
  adapter is configured.
