#!/usr/bin/env node

/**
 * Pre-commit hook step 1: validate `orphans[]` in the metaclaude registry.
 *
 * Reads `.claude/metaclaude-registry.json`, parses it via the Zod `orphansSchema`
 * from `lib/registry-schema.mjs`, and exits non-zero on any violation. A single
 * structured JSON finding is printed to stderr per violation.
 *
 * Spec: sg-sync-registry-gaps T1.11, REQ-004, AC-4.1, AC-7.1, AC-7.2.
 *
 * Exit codes:
 *   0 - orphans[] is valid (or missing / empty -- EC-30 bootstrap)
 *   1 - one or more orphans entries failed validation
 *   2 - structural error (registry missing, invalid JSON, unreadable)
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { orphansSchema } from './lib/registry-schema.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Prefer a CWD-relative registry when one is present (test fixture), else
// fall back to the executable-relative path (normal author use).
function resolveRegistryPath() {
  const cwdCandidate = join(resolve(process.cwd()), '.claude/metaclaude-registry.json');
  if (existsSync(cwdCandidate)) return cwdCandidate;
  return resolve(__dirname, '..', 'metaclaude-registry.json');
}
const REGISTRY_PATH = resolveRegistryPath();

function emit(violation) {
  console.error(JSON.stringify(violation));
}

function main() {
  if (!existsSync(REGISTRY_PATH)) {
    // Fail-open on structural errors: the hook should not block commits when the
    // registry file itself is absent (e.g., first commit on a fresh branch).
    emit({
      rule: 'provenance-invalid',
      file: '.claude/metaclaude-registry.json',
      message: 'Registry file not found; skipping orphans validation',
      level: 'warn',
    });
    process.exit(0);
  }

  let raw;
  try {
    raw = readFileSync(REGISTRY_PATH, 'utf-8');
  } catch (err) {
    emit({
      rule: 'provenance-invalid',
      file: '.claude/metaclaude-registry.json',
      message: `Unable to read registry: ${err.message}`,
    });
    process.exit(2);
  }

  let registry;
  try {
    registry = JSON.parse(raw);
  } catch (err) {
    emit({
      rule: 'provenance-invalid',
      file: '.claude/metaclaude-registry.json',
      message: `Invalid JSON: ${err.message}`,
    });
    process.exit(2);
  }

  const orphans = Array.isArray(registry.orphans) ? registry.orphans : [];
  const result = orphansSchema.safeParse(orphans);
  if (!result.success) {
    for (const issue of result.error.issues) {
      emit({
        rule: 'provenance-invalid',
        file: '.claude/metaclaude-registry.json',
        path: `orphans.${issue.path.join('.')}`,
        message: issue.message,
        remediation:
          'Update the orphans[] entry to include { path, reason >= 20 chars, added_by >= 2 chars, added_date YYYY-MM-DD }',
      });
    }
    process.exit(1);
  }

  process.exit(0);
}

main();
