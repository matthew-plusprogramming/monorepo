/**
 * Minimum-Pruning Floor Validator (BIZ-002)
 *
 * Pure validator helper enforcing REQ-001 minimum-pruning floor clause:
 *
 *   At least ONE of {unifier, code-review, security, completion-verifier}
 *   MUST be configured at (required_clean_passes: 1, attestation_mode:
 *   "content-hash") UNLESS .claude/prds/pipeline-efficiency/threshold-
 *   decisions.md contains per-gate baseline evidence showing Medium+
 *   finding rate >= 10% on 2nd pass for ALL four gates.
 *
 * The validator is a pure function over the PerGateThresholdTable and the
 * decisions-file content; it performs no filesystem I/O itself so it is
 * trivially unit-testable (see spec atomicity criterion "Independently
 * Testable"). A thin CLI wrapper (`validate-minimum-pruning-floor.mjs`) and
 * the `/enforce` skill invocation path do the filesystem read and translate
 * structured failures into process exit codes / user-facing errors.
 *
 * Spec: sg-pipeline-efficiency-ws1-convergence-pruning / as-014
 *   - AC14.1: fail when zero of the four content-stable gates is at
 *             (required_clean_passes: 1, attestation_mode: "content-hash").
 *   - AC14.2: accept override when decisions file documents >=10% Medium+
 *             2nd-pass rate for all four gates.
 *   - AC14.3: structured error MINIMUM_PRUNING_FLOOR_VIOLATION with
 *             gate-by-gate summary.
 *   - AC14.4: invoked by /enforce before atomicity-enforcement completes.
 *
 * Requirements: REQ-001 (minimum-pruning floor).
 * Contract ref: contract-per-gate-threshold-table §minimum_pruning_floor.
 */

// =============================================================================
// Constants
// =============================================================================

/**
 * The four content-stable gates whose relaxation is governed by the
 * minimum-pruning floor (BIZ-002). Source: spec.md §Requirements REQ-001 +
 * §Contract Registry §minimum_pruning_floor (line 502).
 *
 * @type {readonly string[]}
 */
export const CONTENT_STABLE_GATES = Object.freeze([
  'unifier',
  'code-review',
  'security',
  'completion-verifier',
]);

/**
 * Structured error code emitted when the floor is violated (AC14.3).
 *
 * @type {string}
 */
export const MINIMUM_PRUNING_FLOOR_VIOLATION = 'MINIMUM_PRUNING_FLOOR_VIOLATION';

/**
 * Canonical decisions-file path (relative to repo root). The spec pins this
 * exact path; any change must be accompanied by a spec amendment.
 *
 * @type {string}
 */
export const THRESHOLD_DECISIONS_PATH =
  '.claude/prds/pipeline-efficiency/threshold-decisions.md';

/**
 * Literal tag the decisions file MUST reference to signal per-gate baseline
 * justification under BIZ-002. Case-insensitive match.
 *
 * @type {string}
 */
const BIZ_002_TAG = 'BIZ-002';

/**
 * Minimum Medium+ 2nd-pass rate required per gate when the decisions file
 * is invoked as an override. The validator requires evidence of this
 * threshold for ALL four content-stable gates.
 *
 * @type {number}
 */
const MIN_MEDIUM_PLUS_SECOND_PASS_RATE_PCT = 10;

// =============================================================================
// Helpers
// =============================================================================

/**
 * Determine whether a single gate entry satisfies the "relaxed" definition
 * used by the floor: required_clean_passes === 1 AND attestation_mode ===
 * "content-hash". Missing entries count as NOT relaxed.
 *
 * @param {{ required_clean_passes?: number, attestation_mode?: string } | undefined} entry
 * @returns {boolean}
 */
function isRelaxed(entry) {
  if (!entry || typeof entry !== 'object') return false;
  return (
    entry.required_clean_passes === 1 &&
    entry.attestation_mode === 'content-hash'
  );
}

/**
 * Build a gate-by-gate summary of how each content-stable gate resolves
 * under the floor check. Used in the structured error payload (AC14.3).
 *
 * @param {Record<string, { required_clean_passes?: number, attestation_mode?: string }>} table
 * @returns {Array<{ gate: string, required_clean_passes: number | null, attestation_mode: string | null, relaxed: boolean }>}
 */
function buildGateSummary(table) {
  return CONTENT_STABLE_GATES.map((gate) => {
    const entry = table?.[gate];
    return {
      gate,
      required_clean_passes:
        entry && typeof entry.required_clean_passes === 'number'
          ? entry.required_clean_passes
          : null,
      attestation_mode:
        entry && typeof entry.attestation_mode === 'string'
          ? entry.attestation_mode
          : null,
      relaxed: isRelaxed(entry),
    };
  });
}

/**
 * Parse the decisions file for per-gate baseline evidence that satisfies
 * the BIZ-002 override clause.
 *
 * The spec requires the file to reference:
 *   (1) the BIZ-002 tag (so the override is auditable), AND
 *   (2) per-gate baseline evidence showing Medium+ 2nd-pass rate >= 10%
 *       for ALL four content-stable gates.
 *
 * The validator is a gate-check, not a full parser: it scans for the
 * tag + per-gate mentions, and for a >= 10% numeric claim adjacent to
 * each gate name. Conservative by design -- if the file shape drifts, the
 * validator flags the gate as unverified so the author is forced to revisit
 * the evidence. A dedicated decisions-file schema (as-029/as-033) will
 * tighten this to structured parsing in a follow-up; this validator only
 * enforces the minimum floor semantics.
 *
 * @param {string} content - Raw file contents (UTF-8).
 * @returns {{ has_biz_002_tag: boolean, missing_gates: string[], unverified_gates: string[] }}
 */
export function parseDecisionsOverride(content) {
  const result = {
    has_biz_002_tag: false,
    missing_gates: [],
    unverified_gates: [],
  };
  if (typeof content !== 'string' || content.length === 0) {
    result.missing_gates = [...CONTENT_STABLE_GATES];
    return result;
  }

  const normalized = content.toLowerCase();
  result.has_biz_002_tag = normalized.includes(BIZ_002_TAG.toLowerCase());

  // For each content-stable gate, locate a per-gate evidence block.
  //
  // Per-gate evidence must be anchored: a free-text mention like
  // "(security omitted)" must NOT satisfy the rule. The spec requires
  // "per-gate baseline evidence" — we interpret this as a gate heading
  // (markdown heading or a "Gate:" labeled line) naming the gate, followed
  // by a qualifying Medium+ 2nd-pass rate >= 10% within a bounded window.
  //
  // Accepted anchor patterns (case-insensitive, on a per-line basis):
  //   - Markdown heading containing the gate name:
  //       "# unifier", "## Unifier", "### Gate: unifier", "#### code-review"
  //   - "Gate:" label co-located with the gate name on one line:
  //       "Gate: security", "Gate security"
  //
  // After an anchor is found, the validator scans the next ~400 chars
  // (or until the next top-level heading) for a qualifying rate. If no
  // anchor exists for a gate, the gate is reported in `missing_gates`;
  // if an anchor exists but no qualifying rate is co-located, the gate
  // is reported in `unverified_gates`. Stricter shape enforcement is
  // deferred to as-029.
  for (const gate of CONTENT_STABLE_GATES) {
    const anchorIdx = findGateAnchor(normalized, gate.toLowerCase());
    if (anchorIdx === -1) {
      result.missing_gates.push(gate);
      continue;
    }
    const windowEnd = Math.min(normalized.length, anchorIdx + 400);
    const windowText = normalized.slice(anchorIdx, windowEnd);
    const verified = hasQualifyingRate(windowText);
    if (!verified) {
      result.unverified_gates.push(gate);
    }
  }
  return result;
}

/**
 * Find the character index of a per-gate "evidence anchor" in the
 * decisions document. An anchor is a line that either:
 *   - starts with `#` (markdown heading) and contains the gate name, OR
 *   - contains the literal substring "gate:" followed by the gate name
 *     (possibly with whitespace or punctuation).
 *
 * Returns the starting index of the matching line (after the leading
 * whitespace) or -1 if no anchor is found. Input is expected to be
 * already lowercased by the caller.
 *
 * @param {string} normalizedContent - Lowercased decisions content.
 * @param {string} gateLower - Lowercase gate name (e.g., "security").
 * @returns {number}
 */
function findGateAnchor(normalizedContent, gateLower) {
  const lines = normalizedContent.split('\n');
  let charCursor = 0;
  for (const line of lines) {
    const trimmed = line.trimStart();
    const lineStartInFile =
      charCursor + (line.length - trimmed.length);
    const isHeading = trimmed.startsWith('#');
    const hasGateLabel = /\bgate\b\s*[:=-]?/.test(trimmed);
    if ((isHeading || hasGateLabel) && containsGateToken(trimmed, gateLower)) {
      return lineStartInFile;
    }
    charCursor += line.length + 1; // +1 for the newline delimiter
  }
  return -1;
}

/**
 * Test whether a line contains the gate name as a standalone token
 * rather than as a prose substring. Gate names contain hyphens
 * (`code-review`, `completion-verifier`) so we use a custom word-boundary
 * check: the gate name must appear surrounded by non-alphanumeric chars
 * or line edges. `code-reviewer` would match `code-review` under a naive
 * `includes`, but the actual canonical gate names are pinned so this is
 * acceptable for the decisions-document domain.
 *
 * @param {string} line - Input line (lowercase).
 * @param {string} gateLower - Lowercase gate token.
 * @returns {boolean}
 */
function containsGateToken(line, gateLower) {
  const idx = line.indexOf(gateLower);
  if (idx === -1) return false;
  const before = idx === 0 ? '' : line[idx - 1];
  const afterIdx = idx + gateLower.length;
  const after = afterIdx >= line.length ? '' : line[afterIdx];
  return !isAlphaNum(before) && !isAlphaNum(after);
}

/**
 * Alphanumeric test used by `containsGateToken`. Intentionally narrow:
 * underscore counts as alphanumeric so `unifier_rate` does NOT match
 * `unifier` as a standalone token.
 *
 * @param {string} ch
 * @returns {boolean}
 */
function isAlphaNum(ch) {
  if (!ch) return false;
  return /[a-z0-9_]/.test(ch);
}

/**
 * Scan a text window for a "Medium+ 2nd-pass rate" claim at or above the
 * minimum floor percentage. Matches either:
 *   - an explicit percentage >= 10% ("12%", "15.4%", "10 %"), OR
 *   - a decimal rate >= 0.10 co-located with a "rate" / "2nd-pass" token.
 *
 * Conservative: any hit above the threshold qualifies. A dedicated
 * decisions-file schema (as-029) will replace this with typed parsing.
 *
 * @param {string} windowText - Lowercase substring surrounding the gate name.
 * @returns {boolean}
 */
function hasQualifyingRate(windowText) {
  // Pattern 1: "NN%" or "NN.NN%" where NN >= 10.
  const pctPattern = /(\d+(?:\.\d+)?)\s*%/g;
  let match;
  while ((match = pctPattern.exec(windowText)) !== null) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value >= MIN_MEDIUM_PLUS_SECOND_PASS_RATE_PCT) {
      return true;
    }
  }
  // Pattern 2: decimal rate token (0.10..1.00) near a "rate" or "2nd-pass"
  // keyword. Only counted when co-located so plain decimals elsewhere in
  // the file do not accidentally qualify.
  const decimalPattern = /(0?\.\d+|1\.0+)(?=[^\d]|$)/g;
  const hasRateKeyword =
    windowText.includes('rate') ||
    windowText.includes('2nd-pass') ||
    windowText.includes('second pass') ||
    windowText.includes('medium+');
  if (hasRateKeyword) {
    while ((match = decimalPattern.exec(windowText)) !== null) {
      const value = Number(match[1]);
      if (
        Number.isFinite(value) &&
        value >= MIN_MEDIUM_PLUS_SECOND_PASS_RATE_PCT / 100
      ) {
        return true;
      }
    }
  }
  return false;
}

// =============================================================================
// Public Validator (AC14.1 .. AC14.4)
// =============================================================================

/**
 * Validate the minimum-pruning floor against the PerGateThresholdTable
 * and (optionally) the decisions-file content.
 *
 * The function is total: it never throws for domain errors. Callers receive
 * a structured result `{ ok: boolean, error: object | null }`. When
 * `ok === false` the error is a tagged `MINIMUM_PRUNING_FLOOR_VIOLATION`
 * object (AC14.3); when `ok === true` the error field is `null` so the
 * shape is stable across success/failure (matches test-writer contract).
 *
 * Semantics:
 *   - If at least one of the four content-stable gates is relaxed
 *     ((required_clean_passes: 1, attestation_mode: "content-hash")), PASS.
 *   - Else if the decisions file exists AND content references BIZ-002
 *     AND contains qualifying evidence for all four gates, PASS.
 *   - Otherwise FAIL with a structured gate-by-gate summary + remediation.
 *
 * The validator accepts BOTH positional-style and named-style invocation:
 *   - `validateMinimumPruningFloor(table, decisionsContent)`   (positional)
 *   - `validateMinimumPruningFloor({ table, decisionsContent })` (named,
 *      test-writer contract: `decisionsContent: string | null`)
 *   - `validateMinimumPruningFloor({ table, decisionsFileContent, ... })`
 *     (CLI contract: explicit `decisionsFileExists` + `decisionsFileContent`)
 *
 * Callers that want to distinguish "file missing" from "file empty" may
 * pass `decisionsFileExists: false` explicitly; when only content is
 * provided (string vs null), "file exists" is inferred from content
 * being a non-null string.
 *
 * @param {...any} rawArgs
 * @returns {{
 *   ok: boolean,
 *   via?: 'relaxed-gate' | 'decisions-override',
 *   relaxed_gates?: string[],
 *   error: null | {
 *     code: string,
 *     message: string,
 *     gate_summary: Array<{ gate: string, required_clean_passes: number | null, attestation_mode: string | null, relaxed: boolean }>,
 *     failing_gates: string[],
 *     decisions_file: { path: string, exists: boolean, has_biz_002_tag: boolean, missing_gates: string[], unverified_gates: string[] },
 *     remediation: string,
 *   },
 * }}
 */
export function validateMinimumPruningFloor(...rawArgs) {
  const {
    table,
    decisionsFileExists,
    decisionsFileContent,
    decisionsFilePath,
  } = normalizeArgs(rawArgs);

  const summary = buildGateSummary(table || {});
  const relaxedGates = summary.filter((s) => s.relaxed).map((s) => s.gate);

  // Primary floor satisfied: at least one gate is at 1 pass + content-hash.
  if (relaxedGates.length > 0) {
    return {
      ok: true,
      via: 'relaxed-gate',
      relaxed_gates: relaxedGates,
      error: null,
    };
  }

  // Secondary path: decisions-file override per BIZ-002.
  const override = decisionsFileExists
    ? parseDecisionsOverride(decisionsFileContent)
    : {
        has_biz_002_tag: false,
        missing_gates: [...CONTENT_STABLE_GATES],
        unverified_gates: [],
      };

  const overrideOk =
    decisionsFileExists &&
    override.has_biz_002_tag &&
    override.missing_gates.length === 0 &&
    override.unverified_gates.length === 0;

  if (overrideOk) {
    return {
      ok: true,
      via: 'decisions-override',
      relaxed_gates: [],
      error: null,
    };
  }

  // Failure path (AC14.1, AC14.3): structured error with gate-by-gate summary.
  const failingGates = summary.filter((s) => !s.relaxed).map((s) => s.gate);
  const remediationLines = [
    'Remediation options:',
    `  (1) Relax at least one of ${CONTENT_STABLE_GATES.join(', ')} to ` +
      'required_clean_passes: 1, attestation_mode: "content-hash" in ' +
      '.claude/scripts/lib/per-gate-threshold-table.mjs.',
    `  (2) Document per-gate baseline evidence (Medium+ 2nd-pass rate ` +
      `>= ${MIN_MEDIUM_PLUS_SECOND_PASS_RATE_PCT}% for all four gates) ` +
      `referencing ${BIZ_002_TAG} in ${decisionsFilePath}.`,
  ];
  const message =
    `Minimum-pruning floor (BIZ-002) violated: zero of ` +
    `{${CONTENT_STABLE_GATES.join(', ')}} is configured at ` +
    `(required_clean_passes: 1, attestation_mode: "content-hash") ` +
    `and the decisions-file override is ` +
    (decisionsFileExists
      ? 'present but incomplete.'
      : `missing (${decisionsFilePath}).`);
  return {
    ok: false,
    error: {
      code: MINIMUM_PRUNING_FLOOR_VIOLATION,
      message,
      gate_summary: summary,
      failing_gates: failingGates,
      decisions_file: {
        path: decisionsFilePath,
        exists: decisionsFileExists,
        has_biz_002_tag: override.has_biz_002_tag,
        missing_gates: override.missing_gates,
        unverified_gates: override.unverified_gates,
      },
      remediation: remediationLines.join('\n'),
    },
  };
}

/**
 * Normalize the validator's input into a single shape. Accepts:
 *   - `(table, decisionsContent)` — positional; decisionsContent may be
 *     a raw string (file content) or null (file absent).
 *   - `(table, { decisionsContent })` — positional table + options object.
 *   - `({ table, decisionsContent })` — single options object; the
 *     test-writer contract.
 *   - `({ table, decisions: string | null })` — alternate key name.
 *   - `({ table, decisionsFileExists, decisionsFileContent, ... })` — CLI
 *     contract with explicit existence flag.
 *
 * When `decisionsFileExists` is not explicitly provided, it is inferred
 * from `decisionsContent` / `decisionsFileContent`: a non-null string means
 * "exists", `null` or `undefined` means "absent". An empty string `""` is
 * treated as `exists: true, content: ""` (i.e., an empty file) so callers
 * that read files into strings before calling the validator behave
 * predictably.
 *
 * @param {any[]} rawArgs
 * @returns {{ table: object, decisionsFileExists: boolean, decisionsFileContent: string, decisionsFilePath: string }}
 */
function normalizeArgs(rawArgs) {
  const args = rawArgs || [];
  let tableArg = null;
  let optsArg = null;

  if (args.length === 0) {
    tableArg = null;
    optsArg = {};
  } else if (args.length === 1) {
    // Shape C/D/CLI: single options object. If it has a `table` key, treat
    // as named-style input; otherwise treat as the table itself.
    const a0 = args[0];
    if (a0 && typeof a0 === 'object' && 'table' in a0) {
      tableArg = a0.table;
      optsArg = a0;
    } else {
      tableArg = a0;
      optsArg = {};
    }
  } else {
    // Shape A/B: positional (table, decisions...)
    tableArg = args[0];
    const a1 = args[1];
    if (a1 && typeof a1 === 'object') {
      optsArg = a1;
    } else {
      optsArg = { decisionsContent: a1 };
    }
  }

  const opts = optsArg || {};
  // Resolve decisions content. Priority: decisionsFileContent (CLI) >
  // decisionsContent (test-writer) > decisions (alt). `null`/`undefined`
  // means "file absent".
  let rawDecisions;
  if ('decisionsFileContent' in opts) {
    rawDecisions = opts.decisionsFileContent;
  } else if ('decisionsContent' in opts) {
    rawDecisions = opts.decisionsContent;
  } else if ('decisions' in opts) {
    rawDecisions = opts.decisions;
  } else {
    rawDecisions = undefined;
  }

  const explicitExists =
    'decisionsFileExists' in opts
      ? Boolean(opts.decisionsFileExists)
      : undefined;
  const inferredExists = typeof rawDecisions === 'string';

  const decisionsFileExists =
    explicitExists !== undefined ? explicitExists : inferredExists;
  const decisionsFileContent =
    typeof rawDecisions === 'string' ? rawDecisions : '';

  const decisionsFilePath =
    typeof opts.decisionsFilePath === 'string' && opts.decisionsFilePath.length > 0
      ? opts.decisionsFilePath
      : THRESHOLD_DECISIONS_PATH;

  return {
    table: tableArg,
    decisionsFileExists,
    decisionsFileContent,
    decisionsFilePath,
  };
}
