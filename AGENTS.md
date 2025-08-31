## 🔑 Memory Bank (for llm agents & contributors)

This repo includes a **memory bank** that summarizes the architecture, conventions, and workflows.

- **Core file:** [`agents/memory-bank.core.md`](./agents/memory-bank.core.md)

LLM agents should read the core file first, it provides a high-level map and links to deeper details.

### Agent Workflow

- Read first: `agents/memory-bank.core.md` (then `agents/memory-bank.deep.md` as needed).
- After each task, update the memory bank:
  - Review and adjust `agents/memory-bank.deep.md` to reflect changes.
  - Update front matter in `agents/memory-bank.core.md`:
    - `generated_at`: today's date (YYYY-MM-DD)
    - `repo_git_sha`: output of `git rev-parse HEAD`
- Validate and check drift before finishing:
  - `npm run memory:validate` — verify referenced paths exist.
  - `npm run memory:drift` — ensure `repo_git_sha` matches or intentionally update.
- Include memory bank updates in the same PR as your changes.

See also: `agents/memory-bank.md` for script details.
