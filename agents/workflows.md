Workflows

It is very important you strictly follow the agent workflows.

- Orchestrator workflow: `agents/workflows/orchestrator.workflow.md`
- Spec author workflow: `agents/workflows/spec-author.workflow.md`
- Implementer workflow: `agents/workflows/implementer.workflow.md`
- One-off overview: `agents/workflows/oneoff.workflow.md`
- One-off spec workflow: `agents/workflows/oneoff-spec.workflow.md`
- One-off vibe workflow: `agents/workflows/oneoff-vibe.workflow.md`
- Purpose: define the spec-first run-loop and the one-off paths; spec workflows follow the four-phase loop with gates.

Usage

- Select the workflow based on the assigned role (or one-off mode), then start at the current phase.
- Follow the checklist, produce outputs, and update the phase state in the file.
- After each phase, log a short reflection in the task spec and record approvals in the Decision & Work Log.
- Reference `agents/tools.md` for script helpers that support each phase.
- Retrieval tooling and single-pass rules live in `agents/memory-bank.md#retrieval-policy`; defer to that section for discovery commands and numbered output expectations.

Policies

- Retrieval: Follow the Retrieval Policy in `agents/memory-bank.md`.
- Commit proposal: Format commit proposals using conventional commit format under 70 chars and a brief body preview.
- Markdown: use Prettier (`npm run format:markdown`) to format Markdown in `agents/**`.
- Memory validation: run `npm run memory:validate` (or `npm run agent:finalize`) once canonical updates are ready to ensure referenced paths exist.
