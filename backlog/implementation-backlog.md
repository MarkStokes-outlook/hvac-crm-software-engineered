# Implementation backlog

Stories are vertical slices. Acceptance IDs are stable and trace back to requirements/discovery.

## EPIC-01 Foundation & identity

**US-001 Application shell, persistence and seed data** ← NFR-003/008. Build runnable app, relational migrations, deterministic realistic FrostLine demo dataset and test harness. **AC-001-01** fresh setup starts from documented command; **AC-001-02** restart preserves records; **AC-001-03** tests run unattended.

**US-002 Authentication/RBAC/audit foundation** ← FR-029/030, Q033/034. **AC-002-01** unauthenticated operational routes blocked; **AC-002-02** protected mutations server-authorised; **AC-002-03** consequential change records actor/time/reason.

## EPIC-02 CRM & asset context

**US-010 Customer/site/contact workspace** ← BR-001, FR-001/002 ← Q001–003. **AC-010-01** multi-site customer supported; **AC-010-02** legal/billing identity separate from trading/site; **AC-010-03** typed contacts/access notes searchable.

**US-011 Asset register/history** ← FR-003/004 ← Q004. **AC-011-01** asset linked to site with manufacturer/model/serial/ref; **AC-011-02** history links jobs/attendances without duplicating records.

## EPIC-03 Service control & SLA

**US-020 Reactive intake/triage** ← FR-005/006 ← Q006/007. **AC-020-01** reported facts/impact/safety captured; **AC-020-02** P1–P4 reason visible; **AC-020-03** priority changes audited.

**US-021 SLA event timeline** ← FR-007/008 ← Q008/009. **AC-021-01** event types remain distinct; **AC-021-02** clock stop requires basis/reason/evidence/owner/review; **AC-021-03** restart preserved; **AC-021-04** no retroactive silent clock manipulation.

**US-022 Readiness and next-action control** ← FR-009/013 ← Q011/013/017. **AC-022-01** authorised/ready/scheduled are distinct; **AC-022-02** waiting requires dependency+owner+review; **AC-022-03** overdue dependencies queryable.

## EPIC-04 Scheduling

**US-030 Schedule board and assignment** ← FR-010/011 ← Q010. **AC-030-01** day/week and ready-unscheduled views; **AC-030-02** assignment displays competence/clearance/readiness signals; **AC-030-03** warnings require acknowledged override where applicable.

**US-031 Commitment displacement** ← FR-012 ← Q012. **AC-031-01** changing/displacing committed work captures reason/authoriser/customer communication; **AC-031-02** displaced work retains new owner/next action.

## EPIC-05 Field attendance

**US-040 Engineer My Day/job brief** ← FR-014 ← Q014. **AC-040-01** phone-width usable; **AC-040-02** scope/authority, asset/history, access/safety and expected resources visible before work.

**US-041 Attendance execution/evidence** ← FR-015/016 ← Q015–018. **AC-041-01** travel/arrival/work events persisted; **AC-041-02** stop/escalate available; **AC-041-03** structured outcome/evidence/time/materials captured; **AC-041-04** submission survives reload/restart.

**US-042 Temporary restoration and handoff** ← FR-017, RULE-001/005 ← Q017/019. **AC-042-01** temporary outcome requires limits/residual risk/review/owner; **AC-042-02** incomplete work requires controlled handoff; **AC-042-03** attendance submission does not auto-close all job dimensions.

**US-043 Customer acknowledgement** ← Q020. **AC-043-01** acknowledgement stored; **AC-043-02** UI states it is not unquoted-charge/warranty/final-closure approval.

## EPIC-06 Commercial / quoting

**US-050 Opportunity and quote revisions** ← FR-019 ← Q022/023/025. **AC-050-01** maturity represented; **AC-050-02** revisions immutable/history retained; **AC-050-03** scope/assumptions/exclusions/options/price/VAT/validity represented.

**US-051 Acceptance and release** ← FR-020/022 ← Q024/026. **AC-051-01** acceptance references exact revision/options; **AC-051-02** validation checklist gates release; **AC-051-03** quote approval alone cannot imply purchase/start; **AC-051-04** approval policy configurable with no invented thresholds.

**US-052 Controlled post-award change** ← FR-021 ← Q025. **AC-052-01** change classification required; **AC-052-02** approval/value/scope impact retained without rewriting accepted quote.

## EPIC-07 Inventory & custody

**US-060 Inventory truth** ← FR-023 ← Q027. **AC-060-01** available/reserved/quarantine/evidence/ownership distinguishable; **AC-060-02** availability cannot go legitimately negative under concurrent issue.

**US-061 Reservation/reallocation** ← FR-024 ← Q028. **AC-061-01** reservation fields complete; **AC-061-02** atomic contested allocation; **AC-061-03** reallocation captures decision and displaced owner notification.

**US-062 Receipt/quarantine** ← FR-025 ← Q029. **AC-062-01** damaged/incorrect receipt can be quarantined; **AC-062-02** quarantined quantity not available; **AC-062-03** PO/delivery evidence and next action retained.

**US-063 Issue/return/evidence custody** ← FR-026/027 ← Q030/031. **AC-063-01** movements append history; **AC-063-02** return assessment precedes availability; **AC-063-03** evidence hold preserves custody and blocks casual disposal/use.

## EPIC-08 Dashboard, search, AI & hardening

**US-070 Operations dashboard/search** ← FR-028/032 ← Q032/036. **AC-070-01** urgent/at-risk/waiting/committed/ready-unscheduled queues derive from records; **AC-070-02** search spans core identifiers; **AC-070-03** dashboard values drill through.

**US-071 Advisory AI** ← FR-031 ← Q035. **AC-071-01** four discovered assistive tasks available; **AC-071-02** suggestions require human apply/copy; **AC-071-03** AI cannot call protected mutation path; **AC-071-04** mock provider works without key.

**US-072 Import/export and quality pass** ← FR-033,NFRs ← Q036/039. **AC-072-01** documented CSV seam for useful master data; **AC-072-02** no fictional external integration; **AC-072-03** keyboard/mobile/error/empty/loading states reviewed; **AC-072-04** critical workflows have automated tests.

## Implementation order

1. US-001/002; 2. US-010/011; 3. US-020/021/022; 4. US-030/031; 5. US-040..043; 6. US-050..052; 7. US-060..063; 8. US-070..072. Build vertical UI+domain+persistence+tests together; do not postpone persistence or permissions until the end.

## Definition of done

A story is done only when its acceptance criteria are demonstrable in the UI/API as appropriate, persistence survives restart, permissions are enforced server-side, consequential transitions are audited, and automated tests cover its business invariants. Placeholder buttons, fake counters and browser-only state do not satisfy acceptance.