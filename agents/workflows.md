Workflows

- Default workflow: `agents/workflows/default.workflow.md`
- Purpose: drive multi-phase execution (planner → retriever → architect → implementer → reviewer → tester → documenter) with explicit inputs/outputs and gates.

Usage
- Open the workflow file and start at the current phase.
- Follow the checklist, produce outputs, and update the phase state in the file.
- After each phase, log a 3-line Reflexion to `agents/memory-bank/active.context.md` and append a brief entry to `agents/memory-bank/progress.log.md`.
- For system-impacting changes, open an ADR stub using `agents/memory-bank/decisions/ADR-0000-template.md`.

Policies
- Retrieval: always consult `project.brief.md`, recent `progress.log.md`, and `active.context.md`; include additional canonical files as needed for task type.
- External tools: prefer GitHub MCP for git actions (branching, commits, PRs).

