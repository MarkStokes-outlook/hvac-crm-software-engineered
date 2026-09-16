# Claude implementation run — 001

Implement the FrostLine CRM described by the frozen engineering pack in this repository.

Work autonomously until the application is complete, runnable and tested. Treat `reference/`, `discovery/`, `requirements/`, `architecture/`, `design/` and `backlog/` as frozen input: do not modify them. **Do not read or use `.experiment-audit/`; it is experiment-administrator provenance and not implementation context.**

Implement backlog stories in the stated dependency order, making reasonable technical choices where the engineering pack deliberately leaves implementation detail open. Do not invent undiscovered FrostLine business rules to fill documented gaps. Prefer a coherent working vertical product over placeholder breadth.

Verify critical workflows, persistence, permissions, concurrency-sensitive inventory behaviour, responsive field use and automated tests. Document setup/run/test commands. Commit the completed implementation to the current run branch.

Do not modify `main` and do not merge the run branch back to main.
