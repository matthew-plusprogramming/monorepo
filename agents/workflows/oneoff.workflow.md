---
Title: One-off Workflow Overview
---

Intent

- Route one-off work to the correct workflow based on mode selection (vibe vs spec).

Decision Guide

- One-off vibe (no spec, small scope): use `agents/workflows/oneoff-vibe.workflow.md`.
- One-off spec (single spec + approvals): use `agents/workflows/oneoff-spec.workflow.md`.
- If unsure, default to one-off spec.

Notes

- Follow `agents/memory-bank.md#retrieval-policy` for required context.
- Run `npm run agent:finalize` before concluding any one-off task.
