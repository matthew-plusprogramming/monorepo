/**
 * Reviewer-Focus Metadata Assembler
 *
 * Implements: REQ-004, AC24.2, AC24.3, AC24.4, SC-4, EC-10
 * Spec: sg-pipeline-efficiency-ws1-convergence-pruning / as-024
 * Parent spec section: §Task List Phase G — Tasks G6, G7; §Flow 2 (Pre-review); §EC-10
 *
 * Purpose
 * -------
 * Replacement signal for the deleted `challenger pre-review` dispatch. The
 * pre-review challenger previously produced reviewer-focus metadata
 * (riskiest change areas, integration surfaces crossed, review focus
 * recommendations) which downstream `code-reviewer` and `security-reviewer`
 * consumed. This helper assembles the same signal from three passive inputs:
 *
 *   1. Spec evidence table  — each atomic spec's Implementation Evidence
 *      rows (files + line ranges) drive the "changed_files" list.
 *   2. Diff summary         — caller-provided or derived from git; records
 *      which files changed between the spec's baseline and HEAD.
 *   3. Prior findings       — findings from preceding gates (unifier,
 *      investigation, challenger pre-impl/pre-orch) that reviewers should
 *      consult before re-deriving coverage.
 *
 * The output is a dispatch-prompt JSON payload that `code-review` and
 * `/security` skills surface in their reviewer dispatch prompts. On dispatch
 * failure mid-run, `persistDispatchPrompt()` writes the payload to
 * `.claude/coordination/review-dispatch-prompt-<dispatch-id>.json` so retry
 * reads from the artifact (EC-10).
 *
 * Return contract
 * ---------------
 * assembleReviewerFocusMetadata() returns:
 *   {
 *     schema_version: 1,
 *     spec_group_id: string,
 *     dispatch_id: string | null,     // null until persist assigns
 *     generated_at: ISO-8601 string,
 *     focus_areas: FocusArea[],       // ranked riskiest change areas
 *     changed_files: ChangedFile[],   // from evidence + diff summary
 *     prior_findings: PriorFinding[], // carry-forward advisories
 *     integration_surfaces: string[], // cross-boundary annotations
 *     review_recommendations: string[], // reviewer-facing hints
 *   }
 *
 *   FocusArea     = { file, atomic_spec_ids: string[], signal: string,
 *                     severity: 'info'|'advisory'|'attention' }
 *   ChangedFile   = { file, line_ranges: string[], atomic_spec_ids: string[] }
 *   PriorFinding  = { source, severity, message, atomic_spec_id? }
 *
 * Input contract
 * --------------
 * assembleReviewerFocusMetadata({
 *   specGroupDir,       // absolute path to `.claude/specs/groups/<id>`
 *   diffSummary?,       // { changed_files?: string[] } — optional override
 *   priorFindings?,     // PriorFinding[] — optional carry-forward set
 *   fs?, pathLib?,      // DI seams for testing
 * })
 *
 * persistDispatchPrompt(payload, { coordinationDir, dispatchId, fs?, pathLib? })
 *   - writes payload to `<coordinationDir>/review-dispatch-prompt-<dispatchId>.json`
 *   - returns { path, dispatch_id } on success
 *   - throws DispatchPromptPersistError on fs failure (EC-10: retry reads
 *     from artifact; caller is expected to retain the in-memory payload
 *     until the artifact write succeeds)
 *
 * readDispatchPrompt({ coordinationDir, dispatchId, fs?, pathLib? })
 *   - returns parsed payload or null if artifact absent
 *   - EC-10 retry path
 */

import * as defaultFs from 'node:fs';
import * as defaultPath from 'node:path';

// =============================================================================
// Public enums / constants
// =============================================================================

/**
 * Schema version for the reviewer-focus metadata payload. Bump on breaking
 * shape changes. Consumers (code-reviewer / security-reviewer dispatch
 * prompts) SHOULD validate against this value.
 * @type {number}
 */
export const REVIEWER_FOCUS_METADATA_SCHEMA_VERSION = 1;

/**
 * Focus-area severity ladder. Ordered from least-to-most attention-worthy.
 * Kept distinct from unify-preflight's PREFLIGHT_SEVERITY so the review-prompt
 * renderer can differentiate the two streams.
 */
export const FOCUS_SEVERITY = Object.freeze({
  INFO: 'info',
  ADVISORY: 'advisory',
  ATTENTION: 'attention',
});

/**
 * Prior-finding source categories — each matches a gate in the pipeline.
 * Reviewers consult these to avoid re-deriving signal the previous gate
 * already surfaced.
 */
export const PRIOR_FINDING_SOURCES = Object.freeze({
  INVESTIGATION: 'investigation',
  CHALLENGER_PRE_IMPL: 'challenger-pre-impl',
  CHALLENGER_PRE_ORCH: 'challenger-pre-orch',
  UNIFIER: 'unifier',
  UNIFY_PREFLIGHT: 'unify-preflight',
});

/**
 * Coordination directory relative path. Callers normally resolve this
 * against the repo root; exported for documentation / test DI.
 * @type {string}
 */
export const COORDINATION_RELATIVE_DIR = '.claude/coordination';

/**
 * Dispatch prompt artifact filename template. `<dispatch-id>` substituted
 * at persist time.
 * @type {string}
 */
export const DISPATCH_PROMPT_FILENAME_TEMPLATE =
  'review-dispatch-prompt-<dispatch-id>.json';

/**
 * Heuristic patterns for integration-surface detection. A file path matching
 * any of these patterns is flagged as crossing an integration boundary.
 * Advisory-only; reviewers judge relevance.
 * @type {readonly RegExp[]}
 */
const INTEGRATION_SURFACE_PATTERNS = Object.freeze([
  /\/api\//i,
  /\/routes?\//i,
  /\/handlers?\//i,
  /\/hooks?\//i,
  /\/middleware\//i,
  /\/services?\//i,
  /\/lib\//i,
  /SKILL\.md$/i,
  /workflow-dag\.mjs$/i,
  /session-checkpoint\.mjs$/i,
]);

// =============================================================================
// Custom errors
// =============================================================================

/**
 * Thrown when artifact persistence fails. Callers catching this error MUST
 * retain the in-memory payload and retry (EC-10 contract).
 */
export class DispatchPromptPersistError extends Error {
  /**
   * @param {string} message
   * @param {object} context
   * @param {string} [context.path]
   * @param {string} [context.dispatch_id]
   * @param {Error}  [context.cause]
   */
  constructor(message, context = {}) {
    super(message);
    this.name = 'DispatchPromptPersistError';
    this.code = 'DISPATCH_PROMPT_PERSIST_FAILED';
    this.path = context.path;
    this.dispatch_id = context.dispatch_id;
    if (context.cause) this.cause = context.cause;
  }
}

// =============================================================================
// Entry point: metadata assembly
// =============================================================================

/**
 * Assemble reviewer-focus metadata from spec evidence + diff summary +
 * prior findings.
 *
 * Pure (aside from filesystem reads of atomic specs) unless `persist` is
 * set, in which case the payload is also written to the coordination
 * artifact (EC-10 retry path).
 *
 * Accepts two input shapes (both snake_case-preferred per as-023 precedent):
 *
 *   A. Spec-group-directory form (used by the pipeline at runtime):
 *      { specGroupDir, diffSummary?, priorFindings?, specGroupId?,
 *        dispatchId?, repoRoot?, persist?, fs?, pathLib? }
 *
 *   B. Pre-extracted-input form (used by tests + direct callers):
 *      { specEvidence, diffSummary?, priorFindings?, dispatchId?,
 *        repoRoot?, persist?, fs?, pathLib? }
 *
 * The two shapes are disambiguated by the presence of `specGroupDir`
 * (form A) vs `specEvidence` (form B). If neither is present, an empty
 * payload is returned with a skipped_reason annotation.
 *
 * Return shape — dispatch-prompt JSON (always snake_case):
 *   {
 *     schema_version, spec_group_id, dispatch_id, generated_at,
 *     spec_evidence,       // full input or evidence pointer
 *     diff_summary,        // full input or diff pointer
 *     prior_findings,      // normalized array
 *     reviewer_focus: {    // aggregate focus block (AC24.2)
 *       focus_areas, changed_files, integration_surfaces,
 *       review_recommendations,
 *     },
 *   }
 *
 * When `persist: true`, the helper also writes the payload to
 * `<repoRoot>/.claude/coordination/review-dispatch-prompt-<dispatchId>.json`.
 *
 * @param {object} opts
 * @returns {ReviewerFocusMetadata}
 */
export function assembleReviewerFocusMetadata(opts = {}) {
  const {
    specGroupDir = null,
    specEvidence = null,
    diffSummary = null,
    priorFindings = [],
    specGroupId = null,
    dispatchId = null,
    repoRoot = null,
    persist = false,
    fs = defaultFs,
    pathLib = defaultPath,
  } = opts;

  // ---- Resolve input: form A (specGroupDir) vs form B (specEvidence) ----
  let resolvedSpecGroupId;
  let atomicSpecs;
  let resolvedSpecEvidence;

  if (specGroupDir && typeof specGroupDir === 'string') {
    if (!fs.existsSync(specGroupDir)) {
      return finalizePayload({
        payload: buildEmptyPayload({
          specGroupId: specGroupId || pathLib.basename(specGroupDir),
          skippedReason: `specGroupDir does not exist: ${specGroupDir}`,
          dispatchId,
          specEvidence: null,
          diffSummary,
          priorFindings,
        }),
        persist,
        repoRoot,
        dispatchId,
        fs,
        pathLib,
      });
    }
    resolvedSpecGroupId = specGroupId || pathLib.basename(specGroupDir);
    const atomicDir = pathLib.join(specGroupDir, 'atomic');
    atomicSpecs = loadAtomicSpecs({ atomicDir, fs, pathLib });
    resolvedSpecEvidence = buildSpecEvidencePointer({
      specGroupDir,
      specGroupId: resolvedSpecGroupId,
      atomicSpecs,
    });
  } else if (specEvidence && typeof specEvidence === 'object') {
    resolvedSpecGroupId =
      specGroupId ||
      (typeof specEvidence.spec_id === 'string'
        ? specEvidence.spec_id
        : typeof specEvidence.specId === 'string'
          ? specEvidence.specId
          : '<unknown>');
    atomicSpecs = atomicSpecsFromSpecEvidence(specEvidence);
    resolvedSpecEvidence = specEvidence;
  } else {
    return finalizePayload({
      payload: buildEmptyPayload({
        specGroupId: specGroupId || '<unknown>',
        skippedReason:
          'neither specGroupDir nor specEvidence provided — cannot assemble reviewer-focus metadata',
        dispatchId,
        specEvidence: null,
        diffSummary,
        priorFindings,
      }),
      persist,
      repoRoot,
      dispatchId,
      fs,
      pathLib,
    });
  }

  // ---- Derive reviewer_focus aggregate ----
  const changedFiles = deriveChangedFiles({ atomicSpecs, diffSummary });
  const focusAreas = deriveFocusAreas({
    atomicSpecs,
    changedFiles,
    priorFindings,
  });
  const integrationSurfaces = deriveIntegrationSurfaces({ changedFiles });
  const reviewRecommendations = deriveReviewRecommendations({
    focusAreas,
    priorFindings,
    integrationSurfaces,
  });
  const normalizedPriorFindings = normalizePriorFindings(priorFindings);

  const payload = {
    schema_version: REVIEWER_FOCUS_METADATA_SCHEMA_VERSION,
    spec_group_id: resolvedSpecGroupId,
    dispatch_id: dispatchId || null,
    generated_at: new Date().toISOString(),
    spec_evidence: resolvedSpecEvidence,
    diff_summary: diffSummary || null,
    prior_findings: normalizedPriorFindings,
    reviewer_focus: {
      focus_areas: focusAreas,
      changed_files: changedFiles,
      integration_surfaces: integrationSurfaces,
      review_recommendations: reviewRecommendations,
    },
    // Duplicated at top-level for backward compatibility with earlier
    // callers that consumed the flat layout.
    focus_areas: focusAreas,
    changed_files: changedFiles,
    integration_surfaces: integrationSurfaces,
    review_recommendations: reviewRecommendations,
  };

  return finalizePayload({
    payload,
    persist,
    repoRoot,
    dispatchId,
    fs,
    pathLib,
  });
}

// =============================================================================
// Persistence (EC-10 retry artifact)
// =============================================================================

/**
 * Persist a reviewer-focus metadata payload to the coordination artifact.
 * Stamps the dispatch_id on the payload (mutation is returned in the
 * on-disk copy only — the in-memory payload is cloned before mutation).
 *
 * Throws `DispatchPromptPersistError` on fs failure; callers retry per EC-10.
 *
 * @param {ReviewerFocusMetadata} payload
 * @param {object} opts
 * @param {string} opts.coordinationDir - Absolute path to `.claude/coordination`.
 * @param {string} opts.dispatchId - Stable dispatch identifier.
 * @param {typeof defaultFs} [opts.fs]
 * @param {typeof defaultPath} [opts.pathLib]
 * @returns {{ path: string, dispatch_id: string }}
 */
export function persistDispatchPrompt(
  payload,
  { coordinationDir, dispatchId, fs = defaultFs, pathLib = defaultPath } = {},
) {
  if (!payload || typeof payload !== 'object') {
    throw new DispatchPromptPersistError('payload is required and must be an object', {
      dispatch_id: dispatchId,
    });
  }
  if (!coordinationDir || typeof coordinationDir !== 'string') {
    throw new DispatchPromptPersistError('coordinationDir is required', {
      dispatch_id: dispatchId,
    });
  }
  if (!dispatchId || typeof dispatchId !== 'string') {
    throw new DispatchPromptPersistError('dispatchId is required', {
      dispatch_id: dispatchId,
    });
  }

  const filename = DISPATCH_PROMPT_FILENAME_TEMPLATE.replace(
    '<dispatch-id>',
    sanitizeDispatchId(dispatchId),
  );
  const artifactPath = pathLib.join(coordinationDir, filename);

  const stamped = {
    ...payload,
    dispatch_id: dispatchId,
    persisted_at: new Date().toISOString(),
  };

  try {
    if (!fs.existsSync(coordinationDir)) {
      fs.mkdirSync(coordinationDir, { recursive: true });
    }
    fs.writeFileSync(
      artifactPath,
      JSON.stringify(stamped, null, 2) + '\n',
      'utf8',
    );
  } catch (err) {
    throw new DispatchPromptPersistError(
      `Failed to write dispatch prompt artifact: ${err.message}`,
      { path: artifactPath, dispatch_id: dispatchId, cause: err },
    );
  }

  return { path: artifactPath, dispatch_id: dispatchId };
}

/**
 * Read a previously-persisted dispatch prompt artifact. Returns null when
 * the artifact is absent (fresh run / retry before first write).
 *
 * Used by the reviewer retry path (EC-10): if a reviewer dispatch failed
 * mid-run, the retry reads the persisted payload rather than re-deriving.
 *
 * @param {object} opts
 * @param {string} opts.coordinationDir
 * @param {string} opts.dispatchId
 * @param {typeof defaultFs} [opts.fs]
 * @param {typeof defaultPath} [opts.pathLib]
 * @returns {ReviewerFocusMetadata | null}
 */
export function readDispatchPrompt({
  coordinationDir,
  dispatchId,
  fs = defaultFs,
  pathLib = defaultPath,
} = {}) {
  if (!coordinationDir || !dispatchId) return null;
  const filename = DISPATCH_PROMPT_FILENAME_TEMPLATE.replace(
    '<dispatch-id>',
    sanitizeDispatchId(dispatchId),
  );
  const artifactPath = pathLib.join(coordinationDir, filename);
  if (!fs.existsSync(artifactPath)) return null;
  try {
    const raw = fs.readFileSync(artifactPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    // Corrupt artifact — caller falls back to re-assembly.
    return null;
  }
}

// =============================================================================
// Derivation helpers
// =============================================================================

/**
 * Extract changed files from atomic-spec evidence + optional diff summary.
 * Atomic specs are the authoritative source of "what was implemented"; the
 * diff summary (when provided) augments with paths that may not yet be
 * recorded in evidence (e.g., in-flight commits).
 */
function deriveChangedFiles({ atomicSpecs, diffSummary }) {
  /** @type {Map<string, ChangedFile>} */
  const byFile = new Map();

  for (const spec of atomicSpecs) {
    for (const row of spec.evidenceRows) {
      if (!row.file) continue;
      const existing = byFile.get(row.file);
      if (existing) {
        if (row.lineRange && !existing.line_ranges.includes(row.lineRange)) {
          existing.line_ranges.push(row.lineRange);
        }
        if (!existing.atomic_spec_ids.includes(spec.id)) {
          existing.atomic_spec_ids.push(spec.id);
        }
      } else {
        byFile.set(row.file, {
          file: row.file,
          line_ranges: row.lineRange ? [row.lineRange] : [],
          atomic_spec_ids: [spec.id],
        });
      }
    }
  }

  // Augment with diff-summary files that evidence does not yet cover.
  const diffFiles = Array.isArray(diffSummary?.changed_files)
    ? diffSummary.changed_files
    : [];
  for (const file of diffFiles) {
    if (!file || typeof file !== 'string') continue;
    if (!byFile.has(file)) {
      byFile.set(file, {
        file,
        line_ranges: [],
        atomic_spec_ids: [],
      });
    }
  }

  return [...byFile.values()];
}

/**
 * Derive ranked focus areas. Rules (heuristic, advisory):
 *   - A file referenced by more than one atomic spec → severity 'attention'.
 *   - A file matching an integration-surface pattern → severity 'advisory'.
 *   - A file with 3+ line-range entries → severity 'advisory'.
 *   - Otherwise → severity 'info'.
 */
function deriveFocusAreas({ atomicSpecs: _atomicSpecs, changedFiles, priorFindings }) {
  const priorFindingFiles = new Set(
    (priorFindings || [])
      .map((f) => f && typeof f.file === 'string' ? f.file : null)
      .filter(Boolean),
  );

  const focusAreas = [];
  for (const entry of changedFiles) {
    let severity = FOCUS_SEVERITY.INFO;
    const signals = [];

    if (entry.atomic_spec_ids.length >= 2) {
      severity = FOCUS_SEVERITY.ATTENTION;
      signals.push(
        `Touches ${entry.atomic_spec_ids.length} atomic specs (${entry.atomic_spec_ids.join(', ')}).`,
      );
    }

    if (matchesIntegrationSurface(entry.file)) {
      if (severity === FOCUS_SEVERITY.INFO) severity = FOCUS_SEVERITY.ADVISORY;
      signals.push('Integration-surface path — cross-boundary review suggested.');
    }

    if (entry.line_ranges.length >= 3) {
      if (severity === FOCUS_SEVERITY.INFO) severity = FOCUS_SEVERITY.ADVISORY;
      signals.push(
        `${entry.line_ranges.length} distinct line ranges recorded — broad surface.`,
      );
    }

    if (priorFindingFiles.has(entry.file)) {
      if (severity === FOCUS_SEVERITY.INFO) severity = FOCUS_SEVERITY.ADVISORY;
      signals.push('Prior gate flagged this file — consult carry-forward findings.');
    }

    focusAreas.push({
      file: entry.file,
      atomic_spec_ids: [...entry.atomic_spec_ids],
      signal: signals.length > 0 ? signals.join(' ') : 'Standard review.',
      severity,
    });
  }

  // Sort: attention first, then advisory, then info; stable-by-file within.
  const severityRank = {
    [FOCUS_SEVERITY.ATTENTION]: 0,
    [FOCUS_SEVERITY.ADVISORY]: 1,
    [FOCUS_SEVERITY.INFO]: 2,
  };
  focusAreas.sort((a, b) => {
    const diff = severityRank[a.severity] - severityRank[b.severity];
    if (diff !== 0) return diff;
    return a.file.localeCompare(b.file);
  });

  return focusAreas;
}

/**
 * Flag integration surfaces. A file whose path matches any
 * INTEGRATION_SURFACE_PATTERNS is included. De-duplicated.
 */
function deriveIntegrationSurfaces({ changedFiles }) {
  const surfaces = new Set();
  for (const entry of changedFiles) {
    if (matchesIntegrationSurface(entry.file)) {
      surfaces.add(entry.file);
    }
  }
  return [...surfaces].sort();
}

/**
 * Build reviewer-facing recommendations from focus areas + prior findings +
 * integration surfaces. Intentionally short, free-form strings — reviewer
 * renderer surfaces them as bullet points.
 */
function deriveReviewRecommendations({
  focusAreas,
  priorFindings,
  integrationSurfaces,
}) {
  const recommendations = [];

  const attentionAreas = focusAreas.filter(
    (a) => a.severity === FOCUS_SEVERITY.ATTENTION,
  );
  if (attentionAreas.length > 0) {
    recommendations.push(
      `Prioritize ${attentionAreas.length} attention-level focus area(s): ${attentionAreas
        .map((a) => a.file)
        .join(', ')}.`,
    );
  }

  if (integrationSurfaces.length > 0) {
    recommendations.push(
      `${integrationSurfaces.length} integration surface(s) crossed — verify contract stability and wire-protocol shape.`,
    );
  }

  if (Array.isArray(priorFindings) && priorFindings.length > 0) {
    const severeCount = priorFindings.filter(
      (f) => f && (f.severity === 'high' || f.severity === 'critical'),
    ).length;
    if (severeCount > 0) {
      recommendations.push(
        `${severeCount} prior high/critical finding(s) — confirm remediation before approving.`,
      );
    } else {
      recommendations.push(
        `${priorFindings.length} prior finding(s) carried forward — cross-reference before re-flagging.`,
      );
    }
  }

  if (recommendations.length === 0) {
    recommendations.push(
      'No elevated focus signal detected — proceed with standard review checklist.',
    );
  }

  return recommendations;
}

/**
 * Normalize caller-provided prior findings into the canonical shape. Unknown
 * fields preserved; required fields defaulted conservatively.
 */
function normalizePriorFindings(priorFindings) {
  if (!Array.isArray(priorFindings)) return [];
  return priorFindings
    .filter((f) => f && typeof f === 'object')
    .map((f) => ({
      source: typeof f.source === 'string' ? f.source : '<unknown>',
      severity: typeof f.severity === 'string' ? f.severity : 'info',
      message: typeof f.message === 'string' ? f.message : '',
      ...(typeof f.atomic_spec_id === 'string'
        ? { atomic_spec_id: f.atomic_spec_id }
        : {}),
      ...(typeof f.file === 'string' ? { file: f.file } : {}),
    }));
}

function matchesIntegrationSurface(file) {
  if (!file || typeof file !== 'string') return false;
  return INTEGRATION_SURFACE_PATTERNS.some((re) => re.test(file));
}

// =============================================================================
// Atomic spec loading (lightweight, markdown-aware)
// =============================================================================

function loadAtomicSpecs({ atomicDir, fs, pathLib }) {
  if (!fs.existsSync(atomicDir)) return [];
  let entries;
  try {
    entries = fs.readdirSync(atomicDir).filter((n) => n.endsWith('.md'));
  } catch {
    return [];
  }
  const specs = [];
  for (const name of entries) {
    const absPath = pathLib.join(atomicDir, name);
    let content;
    try {
      content = fs.readFileSync(absPath, 'utf8');
    } catch {
      continue;
    }
    specs.push(parseAtomicSpec({ content, filename: name }));
  }
  return specs;
}

function parseAtomicSpec({ content, filename }) {
  const id = extractId({ content, filename });
  const evidenceRows = extractEvidenceRows(content);
  return { id, evidenceRows };
}

function extractId({ content, filename }) {
  const m = content.match(/^id:\s*([^\n]+)/m);
  if (m) return m[1].trim();
  return filename.replace(/\.md$/, '');
}

/**
 * Extract Implementation Evidence rows. The evidence table format is:
 *
 *   | AC     | File                    | Line(s) | Description |
 *   | ------ | ----------------------- | ------- | ----------- |
 *   | AC1.1  | path/to/file.ts         | 42-58   | ...         |
 *
 * The parser is intentionally forgiving: unheadered tables are supported;
 * the first cell containing a path-shaped string is taken as `file` and any
 * subsequent line-number-like cell as `line_range`.
 *
 * @returns {EvidenceRow[]}
 */
function extractEvidenceRows(content) {
  const section = extractSection(content, 'Implementation Evidence');
  if (!section) return [];
  const lines = section.split(/\r?\n/);
  const rows = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    if (/^\|\s*-+/.test(line)) continue;
    if (/^\|\s*(ac|file|line|description)\b/i.test(line)) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim().replace(/`/g, ''));
    if (cells.length === 0) continue;

    const file = cells.find(
      (c) =>
        c &&
        (c.includes('/') ||
          c.endsWith('.mjs') ||
          c.endsWith('.ts') ||
          c.endsWith('.tsx') ||
          c.endsWith('.js') ||
          c.endsWith('.jsx') ||
          c.endsWith('.md') ||
          c.endsWith('.json')),
    );
    if (!file) continue;

    // Look for a line-range-shaped cell (e.g., "42", "42-58", "42, 60-80").
    const lineRange = cells.find((c) =>
      /^\d+(\s*[-–,]\s*\d+)*(\s*,\s*\d+(\s*[-–,]\s*\d+)*)*$/.test(c),
    );

    rows.push({ file, lineRange: lineRange || null });
  }
  return rows;
}

function extractSection(content, sectionName) {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `^##\\s+${escaped}\\s*$([\\s\\S]*?)(?=^##\\s|\\Z)`,
    'm',
  );
  const match = content.match(re);
  return match ? match[1].trim() : '';
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * Sanitize a dispatch id for filesystem safety. Non-alphanumeric characters
 * (other than '-' and '_') are replaced with '_'. Prevents path traversal
 * and invalid filename characters from a caller-provided dispatch id.
 */
function sanitizeDispatchId(dispatchId) {
  return String(dispatchId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
}

function buildEmptyPayload({
  specGroupId,
  skippedReason,
  dispatchId = null,
  specEvidence = null,
  diffSummary = null,
  priorFindings = [],
}) {
  const normalizedPriorFindings = normalizePriorFindings(priorFindings);
  const emptyReviewerFocus = {
    focus_areas: [],
    changed_files: [],
    integration_surfaces: [],
    review_recommendations: [
      'No reviewer-focus metadata assembled — fall back to standard review checklist.',
    ],
  };
  return {
    schema_version: REVIEWER_FOCUS_METADATA_SCHEMA_VERSION,
    spec_group_id: specGroupId,
    dispatch_id: dispatchId || null,
    generated_at: new Date().toISOString(),
    spec_evidence: specEvidence,
    diff_summary: diffSummary || null,
    prior_findings: normalizedPriorFindings,
    reviewer_focus: emptyReviewerFocus,
    // Duplicated at top-level for backward compatibility.
    focus_areas: emptyReviewerFocus.focus_areas,
    changed_files: emptyReviewerFocus.changed_files,
    integration_surfaces: emptyReviewerFocus.integration_surfaces,
    review_recommendations: emptyReviewerFocus.review_recommendations,
    skipped_reason: skippedReason,
  };
}

/**
 * Finalize an assembled payload. When `persist: true` and a dispatchId +
 * either repoRoot or coordinationDir is available, the payload is written
 * to the EC-10 retry artifact before being returned.
 *
 * Persistence failure is swallowed (fail-open): the caller receives the
 * in-memory payload with `persistence_error` annotated so downstream
 * observers can detect it. This matches the EC-10 contract — the retry
 * path only activates when the artifact actually exists.
 */
function finalizePayload({
  payload,
  persist,
  repoRoot,
  dispatchId,
  fs,
  pathLib,
}) {
  if (!persist) return payload;
  if (!dispatchId || typeof dispatchId !== 'string') return payload;

  const coordinationDir =
    repoRoot && typeof repoRoot === 'string'
      ? pathLib.join(repoRoot, COORDINATION_RELATIVE_DIR)
      : null;
  if (!coordinationDir) return payload;

  try {
    persistDispatchPrompt(payload, {
      coordinationDir,
      dispatchId,
      fs,
      pathLib,
    });
    // Mutate the in-memory payload to reflect the assigned dispatch_id +
    // persisted_at (mirrors the on-disk shape so callers round-trip).
    payload.dispatch_id = dispatchId;
    payload.persisted_at = new Date().toISOString();
  } catch (err) {
    payload.persistence_error = {
      code: err && err.code ? err.code : 'UNKNOWN',
      message: err && err.message ? err.message : String(err),
    };
  }
  return payload;
}

/**
 * Build a compact spec_evidence pointer from atomic-spec data. Used when the
 * caller provides a spec-group directory rather than a pre-extracted
 * specEvidence structure. Downstream consumers can use the pointer to
 * re-load evidence on demand.
 */
function buildSpecEvidencePointer({
  specGroupDir,
  specGroupId,
  atomicSpecs,
}) {
  return {
    spec_id: specGroupId,
    spec_group_dir: specGroupDir,
    atomic_spec_count: atomicSpecs.length,
    atomic_spec_ids: atomicSpecs.map((s) => s.id),
    evidence: atomicSpecs.flatMap((spec) =>
      spec.evidenceRows.map((row) => ({
        atomic_spec_id: spec.id,
        file: row.file,
        line_range: row.lineRange,
      })),
    ),
  };
}

/**
 * Adapt caller-provided specEvidence into the internal atomic-spec shape
 * that the deriveChangedFiles / deriveFocusAreas helpers expect.
 *
 * The caller's shape is intentionally flexible (form B):
 *   {
 *     spec_id?, acceptance_criteria?, evidence?: [{ac, impl, test}],
 *     atomic_specs?: [{ id, evidenceRows: [{file, lineRange}] }],
 *   }
 *
 * When `atomic_specs` is provided it is used verbatim; otherwise a single
 * synthetic "bundle" atomic spec is produced from `evidence[*].impl`.
 */
function atomicSpecsFromSpecEvidence(specEvidence) {
  if (Array.isArray(specEvidence.atomic_specs)) {
    return specEvidence.atomic_specs
      .filter((s) => s && typeof s === 'object')
      .map((s) => ({
        id: typeof s.id === 'string' ? s.id : '<unknown>',
        evidenceRows: Array.isArray(s.evidenceRows)
          ? s.evidenceRows.filter((r) => r && typeof r === 'object')
          : [],
      }));
  }

  const evidence = Array.isArray(specEvidence.evidence)
    ? specEvidence.evidence
    : [];
  const evidenceRows = evidence
    .filter((e) => e && typeof e === 'object')
    .map((e) => {
      const raw =
        typeof e.impl === 'string'
          ? e.impl
          : typeof e.file === 'string'
            ? e.file
            : null;
      if (!raw) return null;
      // Accept "path:line" or "path:line-range" shape.
      const colonIdx = raw.lastIndexOf(':');
      if (colonIdx > 0 && /^\d/.test(raw.slice(colonIdx + 1))) {
        return {
          file: raw.slice(0, colonIdx),
          lineRange: raw.slice(colonIdx + 1),
        };
      }
      return { file: raw, lineRange: null };
    })
    .filter(Boolean);

  const syntheticId =
    typeof specEvidence.spec_id === 'string'
      ? specEvidence.spec_id
      : 'synthetic-bundle';
  return [{ id: syntheticId, evidenceRows }];
}

// =============================================================================
// Type definitions (JSDoc)
// =============================================================================

/**
 * @typedef {object} EvidenceRow
 * @property {string} file
 * @property {string|null} lineRange
 */

/**
 * @typedef {object} ChangedFile
 * @property {string} file
 * @property {string[]} line_ranges
 * @property {string[]} atomic_spec_ids
 */

/**
 * @typedef {object} FocusArea
 * @property {string} file
 * @property {string[]} atomic_spec_ids
 * @property {string} signal
 * @property {"info"|"advisory"|"attention"} severity
 */

/**
 * @typedef {object} PriorFinding
 * @property {string} source
 * @property {string} severity
 * @property {string} message
 * @property {string} [atomic_spec_id]
 * @property {string} [file]
 */

/**
 * @typedef {object} ReviewerFocusMetadata
 * @property {number} schema_version
 * @property {string} spec_group_id
 * @property {string|null} dispatch_id
 * @property {string} generated_at
 * @property {FocusArea[]} focus_areas
 * @property {ChangedFile[]} changed_files
 * @property {PriorFinding[]} prior_findings
 * @property {string[]} integration_surfaces
 * @property {string[]} review_recommendations
 * @property {string} [skipped_reason]
 * @property {string} [persisted_at]
 */
