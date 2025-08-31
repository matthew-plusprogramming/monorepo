---
applyTo: '**'
---

Read the [agent documentation](../../agents/memory-bank.md) first.

After each task:
- Update the memory bank:
  - Edit `agents/memory-bank.deep.md` if behavior/architecture changed.
  - Refresh front matter in `agents/memory-bank.core.md`:
    - `generated_at`: today's date (YYYY-MM-DD)
    - `repo_git_sha`: `git rev-parse HEAD`
- Run the validation scripts and resolve issues:
  - `npm run memory:validate`
  - `npm run memory:drift`
- Commit memory bank updates with your changes in the same PR.
