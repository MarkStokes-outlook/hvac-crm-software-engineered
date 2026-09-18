# FrostLine operations CRM

An internal operations system for FrostLine Mechanical Services: customers, sites and equipment;
reactive and planned service work; scheduling and field attendance; quotations through to controlled
release; stock with honest availability; reporting; and an advisory AI assistant.

Built from the frozen engineering pack in this repository (`discovery/`, `requirements/`,
`architecture/`, `design/`, `backlog/`). Where the pack left something open it is decided here and
noted; where discovery recorded a gap, the gap is preserved rather than invented over.

## Requirements

- Node.js 20.11 or newer (developed on Node 22)
- No database server: the system of record is a SQLite file created on first setup

## Setup, run and test

```bash
cd app
npm install        # install dependencies
npm run setup      # create the database, apply migrations, load the demo dataset
npm start          # http://localhost:3000
```

| Command | What it does |
| --- | --- |
| `npm run setup` / `npm run db:reset` | Rebuild `data/frostline.db` from migrations and reload the demo dataset (destructive) |
| `npm run db:migrate` | Apply any new migrations to the existing database |
| `npm run db:seed` | Load the demo dataset into an empty database |
| `npm start` | Run the application on `PORT` (default 3000) |
| `npm run dev` | Same, restarting on file changes |
| `npm test` | Run the full test suite (~3 seconds) |
| `npm run typecheck` | Type-check without emitting |

`GET /healthz` returns a JSON health check.

### Configuration

All optional; the defaults work out of the box.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATABASE_FILE` | `app/data/frostline.db` | SQLite database file |
| `UPLOAD_DIR` | `app/data/uploads` | Where evidence photos and documents are stored |
| `ANTHROPIC_API_KEY` | unset | When set, the assistant calls Claude; otherwise a deterministic local assistant is used |
| `AI_PROVIDER` | auto | Force `mock` or `anthropic` |
| `NODE_ENV` | unset | `production` enables secure cookies and static caching |

## Signing in

Every demo account uses the password **`frostline`**. The sign-in page lists them all. Roles see
different navigation and are permitted different actions, so it is worth looking at more than one.

| Username | Person | Role | Good place to start |
| --- | --- | --- | --- |
| `dan` | Dan Whitaker | Service coordinator | Dashboard, logging a call, scheduling, closing work |
| `leanne` | Leanne Okafor | Service coordinator | Waiting dependencies and chasing |
| `tom`, `aisha`, `gareth`, `kieran`, `sam`, `jordan` | Engineers | Field engineer | **My day** on a phone-sized window |
| `rachel` | Rachel Booth | Estimating | Quotations, revisions, acceptance |
| `susan`, `martin` | Directors | Manager | Approvals, release, reports, audit |
| `mick` | Mick Taylor | Warehouse / procurement | Stock, goods receipt, returns, evidence holds |
| `helen` | Helen Ashworth | Finance | Financial closure, billing identity |
| `owen` | Owen Clarke | Installation / projects | Project work and variations |
| `priya` | Priya Shah | Administrator | People, approval policy, settings |

The demo dataset is generated relative to the moment you run `npm run setup`, so there is always work
in progress: an engineer travelling to a P1, another on site, an escalation waiting for an answer, a
temporary repair due for review, a part on order, a quote awaiting a customer decision and a delivery
in quarantine. All customers, people and sites are fictional.

## How it is built

TypeScript on Node, run directly with `tsx` (no build step). Express 5 serves server-rendered HTML;
there is no client framework, and every action works without JavaScript — the small script only adds
confirmations, copy-to-clipboard and conditional field reveals.

```
src/
  db/          schema migration, connection, demo seed
  lib/         clock, HTML escaping, form validation, money, errors, refs
  auth/        password hashing, sessions, capability and approval policy
  domain/      the business: jobs, sla, scheduling, attendance, quotes,
               inventory, crm, dashboard, search, admin, import/export, audit
  ai/          advisory assistant, its context builder and providers
  web/         express app, shared UI kit, one route module per area
test/          domain invariants, HTTP workflows, multi-process concurrency
```

Routes are thin: they parse a form, call one domain service and redirect. The domain services own
permissions, validation, transactions and audit, so the rules hold no matter which route reaches them.

**Persistence.** SQLite in WAL mode with foreign keys, `CHECK` constraints and triggers. The
architecture asked for PostgreSQL "or a repository-supported relational equivalent"; SQLite was chosen
so the system runs locally with no server to install. Nothing depends on it: the SQL is ordinary, and
the data layer is one module. Consequential work runs inside `BEGIN IMMEDIATE` transactions with the
audit record written in the same transaction as the change it describes.

## What the system insists on

These come from the discovery record and are enforced in the domain, not just the interface:

- **An attendance is not a job.** Submitting an attendance never closes the job; it moves it to an
  explicit waiting state with a dependency, an owner and a review point.
- **Operational, financial and commercial closure are separate.** Finishing the work does not invoice
  it, and neither resolves a warranty question.
- **There is no generic "on hold".** Waiting work names its dependency, its FrostLine owner and when
  we chase — the database rejects a waiting job without them.
- **Authorised, ready, scheduled and dispatched are different states.** Readiness is a checklist;
  emergencies may proceed without it, but that is a recorded decision with a reason.
- **Priority, authority, clock stops, overrides, displacement, approvals, stock state and closure all
  carry who, when and why.** Audit events, SLA events, stock movements and custody events are
  append-only, enforced by triggers.
- **SLA clocks stop only where the contract permits it**, and stops start now — they cannot be
  back-dated. Corrections supersede an event and leave the original visible.
- **Customer acknowledgement is acknowledgement**, not approval of charges, warranty or closure.
- **A temporary repair is a future obligation**: it demands limitations, residual risk, a review date,
  an approver and an owner for the permanent fix, and it blocks operational completion until resolved.
- **Quotation approval is not authority to start.** Revisions are immutable outside draft, acceptance
  names an exact revision and its options, and commercial release is a separate, policy-governed step
  behind a validation checklist.
- **Possession is not availability.** Reserved, picked, quarantined, return-pending, evidence-held,
  customer-owned and job-specific stock are all excluded from what can be promised. Availability
  cannot go negative even when several people take the last part at once.

## The AI assistant

Four tasks, taken from what discovery said would genuinely help: summarise history, suggest triage
questions, draft a customer update, and check a handoff for completeness. It is advisory by
construction:

- context is read through a **read-only** database connection, so the assistant cannot write;
- the provider returns text — no tools, no callbacks into the domain;
- suggestions are labelled as suggestions, show the records they were built from, and are applied by
  the person through the ordinary permission-checked form, with the human as the author;
- every suggestion is stored with its task, actor, provider, template version and whether it was
  applied, copied or discarded.

With no `ANTHROPIC_API_KEY` set, a deterministic local assistant produces the same output shapes, so
the feature is fully usable offline — including the handoff completeness check, whose findings are
computed from the records rather than by a model.

## Testing

`npm test` runs 42 tests in about three seconds:

- **`test/domain.test.ts`** — the invariants above, exercised directly against the domain services.
- **`test/workflow.test.ts`** — HTTP journeys: sign-in and role boundaries, CSRF, redaction of
  sensitive site notes, a job from phone call to submitted attendance to office decision, evidence
  upload and retrieval, durability across a restart, the AI boundary, and the CSV seam.
- **`test/concurrency.test.ts`** — eight separate OS processes racing for five parts: exactly five
  succeed, three are cleanly refused, nothing goes negative, and a retried issue moves stock once.

## Deliberately not built

Discovery recorded these as unknown, so they are not invented here: delegated monetary approval
thresholds (the policy is configurable and seeded with **no** limits), warranty claim lifecycle and
recovery accounting, project stage gates and applications for payment, the purchasing approval matrix
and three-way invoice matching, F-Gas statutory reporting fields, complaint and service-credit
calculation, credit control, fleet and training administration, and retention and hosting decisions.
There is no customer portal, no offline-first mobile app and no accounting integration — the CSV
import/export seam is the only external interface, and it does not pretend to be more.
