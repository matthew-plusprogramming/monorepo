/**
 * Atomic-Spec ID schema library — single source of truth.
 *
 * Spec: sg-pipeline-efficiency-ws3-orchestrator-hygiene / as-011 / REQ-008 /
 *       NFR-ATOMIC-ID (MasterSpec §Contract Registry §Atomic-Spec Filename Convention).
 *
 * Purpose
 * -------
 * Evidence run produced 3 ID variants under parallel atomization + 12 gravestone
 * placeholder commits. Duplicate inline regex at `session-validate.mjs` L111 and
 * `session-checkpoint.mjs:752` invited drift. This module exports a single
 * authoritative regex constant + filename parser/formatter that all consumers
 * import, preventing future divergence.
 *
 * Five exports (per Interfaces & Contracts §Atomic-Spec ID Schema Contract):
 *   - ATOMIC_ID_REGEX         — canonical ID regex (no workstream prefix)
 *   - ATOMIC_FILENAME_REGEX   — filename regex (accepts three forms)
 *   - parseAtomicFilename     — filename → {workstream_id, id, slug} | null
 *   - formatAtomicFilename    — {workstream_id, id, slug} → filename
 *   - validateAtomicId        — string → boolean (thin wrapper)
 *
 * Filename forms accepted WITHOUT warning (Investigation Pass 1 broadening,
 * inv-atomic-id-7f91e3):
 *   (1) "as-NNN.md"                  plain  (ws-2, ws-3 convention)
 *   (2) "as-NNN-<slug>.md"           slug   (ws-1 convention)
 *   (3) "<ws-id>-as-NNN-<slug>.md"   legacy cross-directory form (optional)
 *
 * When the filename has no workstream prefix, callers with directory context
 * (e.g., `/enforce` validator, `migrate-manifest.mjs`) infer the workstream
 * from the containing spec-group directory by passing `specGroupDir` to
 * `parseAtomicFilename`. Without directory context, the returned workstream_id
 * is `null` for plain/slug forms.
 *
 * Regex semantics preserved identically vs. the prior inline literal — this is
 * a pure extraction, zero behavioral change for `ATOMIC_ID_REGEX` consumers.
 *
 * Acceptable Assumption Domains (per Self-Answer Protocol)
 * --------------------------------------------------------
 * - SELF-RESOLVED(code): regex literal `/^as-[0-9]{3}(-[a-z0-9-]+)?$/` copied
 *   verbatim from `session-validate.mjs:111` and `session-checkpoint.mjs:752`.
 * - SELF-RESOLVED(spec §Interfaces-&-Contracts): filename regex semantics
 *   follow the §Atomic-Spec ID Schema Contract export signature exactly
 *   (workstream prefix OPTIONAL per Pass 1 broadening).
 * - SELF-RESOLVED(spec §AC11.5): workstream inference from spec-group directory
 *   via `sg-<prefix>-ws-<N>-<...>` pattern extraction. Directory context is
 *   the last path segment (basename).
 */

// =============================================================================
// Canonical regex constants
// =============================================================================

/**
 * Canonical atomic-spec ID regex.
 *
 * Accepts:
 *   - "as-NNN"          plain form (required 3-digit zero-padded number)
 *   - "as-NNN-<slug>"   slug form (kebab-case: lowercase alphanumerics + hyphens)
 *
 * Rejects:
 *   - "as-0001" (4 digits)
 *   - "AS-001"  (uppercase)
 *   - "as-01"   (2 digits)
 *   - "as-001_foo" (underscore in slug)
 *   - any string not matching the exact anchored pattern
 *
 * Semantics IDENTICAL to legacy inline regex at session-validate.mjs:111 and
 * session-checkpoint.mjs:752 (pre-extraction).
 */
export const ATOMIC_ID_REGEX = /^as-[0-9]{3}(-[a-z0-9-]+)?$/;

/**
 * Canonical atomic-spec filename regex.
 *
 * Accepts three forms:
 *   (1) "as-NNN.md"                  plain        (group-1 undefined, group-2 undefined)
 *   (2) "as-NNN-<slug>.md"           slug         (group-1 undefined, group-2 = "-<slug>")
 *   (3) "<ws-id>-as-NNN-<slug>.md"   ws-prefixed  (group-1 = "<ws-id>", group-2 = "-<slug>")
 *
 * Capture groups:
 *   1. optional workstream_id prefix (e.g., "ws-1", "ws-3")
 *   2. digits of the atomic id (NNN)
 *   3. optional slug suffix (including leading hyphen: "-foo" or "-foo-bar")
 *
 * Note: the optional prefix group uses non-greedy quantifier `[a-z0-9-]+?` so
 * a filename that already starts with `as-NNN...` does NOT accidentally capture
 * the literal `as` as a workstream prefix. The mandatory `-as-[0-9]{3}` anchor
 * that follows guarantees correct parsing.
 *
 * Rejects:
 *   - "as-0001.md"      (4 digits)
 *   - "AS-001.md"       (uppercase)
 *   - "as-001.txt"      (wrong extension)
 *   - "001.md"          (missing "as-" prefix)
 *   - "as-01.md"        (2 digits)
 */
export const ATOMIC_FILENAME_REGEX = /^(?:([a-z0-9-]+?)-)?as-([0-9]{3})(-[a-z0-9-]+)?\.md$/;

// =============================================================================
// Helpers
// =============================================================================

/**
 * Validate a string against ATOMIC_ID_REGEX.
 *
 * @param {unknown} id
 * @returns {boolean}
 */
export function validateAtomicId(id) {
  if (typeof id !== 'string') return false;
  return ATOMIC_ID_REGEX.test(id);
}

/**
 * Extract workstream_id from a spec-group directory basename.
 *
 * Spec-group directory naming convention per MasterSpec:
 *   sg-<prd-slug>-ws-<N>-<workstream-slug>
 *
 * Examples:
 *   "sg-pipeline-efficiency-ws3-orchestrator-hygiene"  → "ws-3"
 *   "sg-pipeline-efficiency-ws1-convergence-pruning"   → "ws-1"
 *   "sg-pipeline-efficiency-ws2-practice-2.4"          → "ws-2"
 *
 * SELF-RESOLVED(code): directory containment pattern `ws<N>` embedded in
 * slug; matches the convention used by existing spec-group dirs under
 * `.claude/specs/groups/`. Returns null if pattern does not match.
 *
 * @param {string|null|undefined} specGroupDir — directory basename (not full path)
 * @returns {string|null} — workstream id like "ws-3", or null if unparseable
 */
function extractWorkstreamFromDir(specGroupDir) {
  if (typeof specGroupDir !== 'string' || !specGroupDir) return null;
  // Strip any trailing path separators the caller may have passed, then take basename.
  const basename = specGroupDir.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || '';
  // Match the ws-<N> infix. Anchored to `-ws<N>-` or `-ws<N>` at end as a safety net.
  const match = basename.match(/-ws(\d+)(?:-|$)/);
  if (!match) return null;
  return `ws-${match[1]}`;
}

/**
 * Parse an atomic-spec filename into its components.
 *
 * Three filename forms accepted (see ATOMIC_FILENAME_REGEX docstring):
 *   (1) "as-NNN.md"                  → workstream_id inferred from specGroupDir, slug = null
 *   (2) "as-NNN-<slug>.md"           → workstream_id inferred from specGroupDir, slug = "<slug>"
 *   (3) "<ws-id>-as-NNN-<slug>.md"   → workstream_id from prefix, slug = "<slug>"
 *
 * Returns null if the filename does not match ATOMIC_FILENAME_REGEX.
 *
 * @param {string} filename — basename only (e.g. "as-001-foo.md")
 * @param {string} [specGroupDir] — optional containing spec-group directory basename
 *                                  (used to infer workstream for forms 1 and 2)
 * @returns {{ workstream_id: string|null, id: string, slug: string|null } | null}
 */
export function parseAtomicFilename(filename, specGroupDir) {
  if (typeof filename !== 'string') return null;
  const match = filename.match(ATOMIC_FILENAME_REGEX);
  if (!match) return null;

  const prefixGroup = match[1]; // "ws-1" etc, or undefined
  const idDigits = match[2];    // "001" etc
  const slugGroup = match[3];   // "-foo" or "-foo-bar", or undefined

  const id = `as-${idDigits}`;
  const slug = slugGroup ? slugGroup.slice(1) : null; // strip leading hyphen

  let workstream_id;
  if (prefixGroup) {
    // Form (3): explicit workstream prefix.
    workstream_id = prefixGroup;
  } else if (specGroupDir) {
    // Form (1)/(2) with directory context: infer from spec-group dir.
    workstream_id = extractWorkstreamFromDir(specGroupDir);
  } else {
    // Form (1)/(2) without directory context: workstream unknown.
    workstream_id = null;
  }

  return { workstream_id, id, slug };
}

/**
 * Format an atomic-spec filename from components.
 *
 * Round-trip inverse of `parseAtomicFilename`. Behavior:
 *   - Both `workstream_id` and `slug` present → "<ws-id>-<id>-<slug>.md" (form 3)
 *   - Only `slug` present (workstream null/undefined) → "<id>-<slug>.md" (form 2)
 *   - Neither `workstream_id` prefix nor `slug` → "<id>.md" (form 1)
 *   - Only `workstream_id` present, no slug → "<ws-id>-<id>.md"
 *     (not a canonical form in current spec, but accepted by the filename regex
 *      and serves round-trip symmetry)
 *
 * The caller controls which form by omitting or providing each field.
 *
 * @param {{ workstream_id?: string|null, id: string, slug?: string|null }} parts
 * @returns {string} filename (basename)
 * @throws {Error} if `parts.id` is missing or not a valid atomic-spec ID
 */
export function formatAtomicFilename(parts) {
  if (!parts || typeof parts !== 'object') {
    throw new Error('formatAtomicFilename: parts must be an object');
  }
  const { workstream_id, id, slug } = parts;
  if (!validateAtomicId(id)) {
    throw new Error(`formatAtomicFilename: invalid id '${id}' (must match ATOMIC_ID_REGEX)`);
  }

  const prefix = workstream_id ? `${workstream_id}-` : '';
  const suffix = slug ? `-${slug}` : '';
  return `${prefix}${id}${suffix}.md`;
}
