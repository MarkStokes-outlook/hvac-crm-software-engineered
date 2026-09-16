# Traceability

The primary chain is `DISC-Qxxx → BR/FR/RULE/NFR → US-xxx → AC-xxx`. Requirements and backlog carry inline source arrows so the chain remains readable without hidden provenance.

Examples:
- `DISC-Q017 → FR-013/016/017 + RULE-001/005 → US-042 → AC-042-01..03`
- `DISC-Q024/Q026 → FR-020/022 → US-051 → AC-051-01..04`
- `DISC-Q027/Q028 → FR-023/024 → US-060/061 → AC-060/061-*`
- `DISC-Q035 → BR-008/FR-031/RULE-011 → US-071 → AC-071-01..04`

Canonical-source provenance stops at discovery and exists only under `.experiment-audit/`; downstream artefacts intentionally never cite hidden source paths.
