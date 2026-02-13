---
type: evidence-table
spec_group: <spec-group-id>
atomic_spec: <as-NNN-slug>
created_at: <ISO timestamp>
---

# Evidence Table: <atomic-spec-title>

## Symbols Verified

| Symbol / Field | Source File | Line(s) | Casing / Shape | Verified |
|---|---|---|---|---|
| `<SymbolName>` | `<file-path>` | <line-numbers> | <casing-note> | Yes/No |

## Missing Symbols

Symbols referenced in the spec that do not yet exist in the codebase:

| Symbol / Field | Expected Location | Action Required |
|---|---|---|
| `<SymbolName>` | `<expected-file-path>` | Create / Add to contract / Clarify with spec |

## Interface Contracts Verified

| Contract | Source | Shape / Signature | Matches Spec |
|---|---|---|---|
| `<InterfaceName>` | `<file-path>:<line>` | `<brief signature>` | Yes/No |

## Notes

- <Any observations about casing conventions, naming patterns, or architectural constraints discovered during evidence gathering>

## Methodology

| Field | Value |
|---|---|
| Tools used | Grep, Glob, Read |
| Files examined | <count> |
| Search patterns used | <list key grep/glob patterns> |
| Directories searched | <list top-level dirs searched> |
| Time spent | <optional: estimated minutes> |

### Search Log

_Record of key searches performed during evidence gathering:_

| Tool | Pattern / Path | Result Count | Key Finding |
|---|---|---|---|
| Grep | `<pattern>` in `<path>` | <N matches> | <what was found> |
| Glob | `<pattern>` | <N files> | <what was found> |
| Read | `<file:lines>` | N/A | <what was confirmed> |
