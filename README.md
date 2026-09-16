# FrostLine CRM — Software Engineered Control

This repository is the frozen **Software Engineered** condition for the Agent Development Benchmark. It contains the same initial stakeholder brief and public website as the YOLO condition, followed by a simulated conventional discovery, BA, architecture and design engagement.

`main` is a control branch. No generated application implementation belongs here. Run branches are never merged back.

## Information boundary

The agency began with only `reference/001-initial-stakeholder-brief.md` and `reference/website/`. During discovery, a simulated FrostLine SME answered explicit questions from canonical business documentation at revision `1732c24654f41849016574a80bc47a10be8090d0`. After discovery closure, engineering artefacts were derived only from elicited answers, decisions and assumptions.

Implementation agents may use `discovery/`, `requirements/`, `architecture/`, `design/`, `backlog/` and `reference/`. They must **not inspect `.experiment-audit/`**, which contains administrator-only provenance.

## Launch

Create `run/001/claude-opus-5-high-001` from frozen main and give Claude `prompts/claude-dev/001-implementation.md`.