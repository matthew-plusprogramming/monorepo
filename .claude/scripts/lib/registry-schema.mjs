/**
 * Zod schemas for the metaclaude registry (`.claude/metaclaude-registry.json`).
 *
 * Single source of truth for registry validation -- imported by compute-hashes.mjs,
 * validate-orphans.mjs, migrate-orphans-shape.mjs, and any future registry consumer.
 *
 * Spec: sg-sync-registry-gaps §Interfaces & Data Model, REQ-004, REQ-005, REQ-028.
 * See spec §5.1 for notes on memory-bank `_sync_policy` ("agent-assisted", not "never-overwrite").
 */

import { z } from 'zod';

/**
 * Sentinel reason string written by the one-shot migration executor
 * (migrate-orphans-shape.mjs). Entries with this reason are expected to be
 * resolved before the legacy-orphans-backlog deadline (2026-09-30); see AC-6.1,
 * AC-6.2, AC-6.3 and the legacy-orphans-inventory check in compute-hashes.
 */
export const LEGACY_ORPHAN_REASON = 'legacy';

/**
 * Orphans entry schema -- object form with provenance metadata.
 *
 * AC-4.1: `reason` must be >= 20 chars, OR exactly the sentinel `"legacy"` written
 * by the one-shot migration (post-migration exception). `added_by` must be >= 2
 * chars, `added_date` must match `YYYY-MM-DD`.
 *
 * The `"legacy"` exception is motivated by AC-6.x: legacy entries are tracked in
 * `.claude/audit/legacy-orphans-backlog.md` and must be resolved before the
 * deadline. After the deadline, compute-hashes emits a non-blocking WARNING via
 * the legacy-orphans-inventory check, but the Zod schema does NOT fail them --
 * blocking the registry load on a legacy entry would strand the author.
 */
export const orphansEntrySchema = z.object({
  path: z.string().min(1),
  reason: z
    .string()
    .refine(
      (value) => value === LEGACY_ORPHAN_REASON || value.length >= 20,
      { message: 'reason must be >= 20 chars, or exactly "legacy" (migration sentinel)' }
    ),
  added_by: z.string().min(2),
  added_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/**
 * Orphans array schema. Default to empty array (EC-30 first-run bootstrap).
 */
export const orphansSchema = z.array(orphansEntrySchema);

/**
 * Closed enum of observed `_sync_policy` values.
 *
 * - agent-assisted: stage upstream to .claude/sync-pending/ for manual merge
 * - never-overwrite: write once, then never touch
 * - never-sync: excluded from sync entirely
 *
 * Appears at category level AND individual-artifact level.
 */
export const SYNC_POLICY_VALUES = Object.freeze([
  'agent-assisted',
  'never-overwrite',
  'never-sync',
]);

/**
 * Artifact entry schema.
 *
 * Required: version, hash, path (existing registry invariants).
 * Optional fields observed on real artifacts:
 *   - description: human-readable summary
 *   - dependencies: agent-category artifacts carry string[] of deps
 *   - target_path: structured-docs-templates carry consumer destination path
 *   - _sync_policy: per-artifact override of category-level policy
 *   - _sync: `false` means hash-tracked but not shipped
 *   - breaking_changes: historical breakage notes
 *   - merge_strategy: hint for metaclaude-cli.mjs merge handlers
 *
 * `.passthrough()` is appended so any new optional field that future specs introduce
 * flows through unvalidated rather than blocking. Per REQ-028 (additive-only schema
 * evolution) this is safe: additive changes cannot break existing consumers.
 */
export const artifactEntrySchema = z
  .object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    hash: z.string().regex(/^[a-f0-9]{8}$/),
    path: z.string().min(1),
    description: z.string().optional(),
    dependencies: z.array(z.string()).optional(),
    target_path: z.string().optional(),
    _sync_policy: z.enum(SYNC_POLICY_VALUES).optional(),
    _sync: z.boolean().optional(),
    breaking_changes: z.array(z.string()).optional(),
    merge_strategy: z.string().optional(),
  })
  .passthrough();

/**
 * Full registry schema.
 *
 * Top-level fields: registry_version, updated_at, artifacts, bundles, orphans.
 * - registry_version: semver
 * - updated_at: ISO-8601 timestamp string
 * - artifacts: map of category -> (map of artifact-id -> artifact entry or _sync_policy meta)
 * - bundles: map of bundle-name -> bundle definition with optional `extends` string
 * - orphans: array of provenance-tagged object entries (post-migration)
 *
 * The artifacts field is validated structurally at the top level; individual entries
 * are validated separately via `validateArtifactEntries()` below so that category-level
 * metadata (e.g., `_sync_policy`) does not trigger per-entry validation errors.
 */
/**
 * Coverage telemetry schema (sg-enforcement-layer-gaps Task 15b / REQ-SH-003 /
 * AC-13.2). The `canonical_shape_lint` coverage metric is OPTIONAL — older
 * registries shipped before M1 do not carry it, so the `.optional()` on the
 * outer object preserves backward compatibility. When present, it must be an
 * object with a `count` integer >= 0. Keeping this schema explicit means the
 * registry validation accepts the Task 15 registry edit deterministically
 * instead of relying on `.passthrough()` to swallow unknowns.
 */
export const coverageSchema = z
  .object({
    canonical_shape_lint: z
      .object({
        count: z.number().int().nonnegative(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .optional();

export const registrySchema = z
  .object({
    $schema: z.string().optional(),
    registry_version: z.string().regex(/^\d+\.\d+\.\d+$/),
    updated_at: z.string().min(1),
    artifacts: z.record(z.string(), z.record(z.string(), z.any())),
    bundles: z.record(
      z.string(),
      z
        .object({
          description: z.string(),
          extends: z.string().optional(),
          includes: z.array(z.string()),
        })
        .passthrough()
    ),
    orphans: orphansSchema.default([]),
    coverage: coverageSchema,
  })
  .passthrough();

/**
 * Iterate every real artifact entry under `registry.artifacts`, skipping
 * category-level metadata keys that start with `_`.
 *
 * @param {object} registry - Parsed registry object
 * @yields {{ category: string, id: string, entry: object }} each artifact entry
 */
export function* iterateArtifactEntries(registry) {
  for (const [category, artifacts] of Object.entries(registry.artifacts || {})) {
    if (typeof artifacts !== 'object' || artifacts === null) continue;
    for (const [id, entry] of Object.entries(artifacts)) {
      if (id.startsWith('_')) continue;
      if (typeof entry !== 'object' || entry === null) continue;
      yield { category, id, entry };
    }
  }
}

/**
 * Validate every artifact entry inside the registry.
 *
 * Returns a { passed, violations } shape compatible with the structured-violation
 * contract used by compute-hashes --update (see spec §5.5).
 *
 * @param {object} registry - Parsed registry object
 * @returns {{ passed: boolean, violations: Array<object> }}
 */
export function validateArtifactEntries(registry) {
  const violations = [];
  for (const { category, id, entry } of iterateArtifactEntries(registry)) {
    const result = artifactEntrySchema.safeParse(entry);
    if (!result.success) {
      violations.push({
        rule: 'provenance-invalid',
        file: '.claude/metaclaude-registry.json',
        path: `artifacts.${category}.${id}`,
        message: result.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; '),
      });
    }
  }
  return { passed: violations.length === 0, violations };
}

/**
 * Validate the top-level registry shape + orphans entries.
 *
 * Does NOT validate artifact entries -- call validateArtifactEntries() separately.
 * The split exists so partial registries (e.g., during migration) can be validated
 * without tripping on artifact-level issues.
 *
 * @param {object} registry - Parsed registry object
 * @returns {{ passed: boolean, violations: Array<object> }}
 */
export function validateRegistryShape(registry) {
  const violations = [];
  const result = registrySchema.safeParse(registry);
  if (!result.success) {
    for (const issue of result.error.issues) {
      violations.push({
        rule: 'provenance-invalid',
        file: '.claude/metaclaude-registry.json',
        path: issue.path.join('.') || '<root>',
        message: issue.message,
      });
    }
  }
  return { passed: violations.length === 0, violations };
}
