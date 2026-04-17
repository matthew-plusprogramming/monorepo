#!/usr/bin/env node

/**
 * SubagentStop hook: Convergence Pass Evidence Recorder
 *
 * Automatically records pass evidence when convergence check agents complete.
 * Extracts findings metadata from the agent's last_assistant_message text via
 * a 4-tier deterministic first-match-wins pipeline, then invokes
 * session-checkpoint.mjs's exported recordPass() function via direct module
 * import.
 *
 * Spec: sg-convergence-recorder-tolerance (v1.2) + v1.3 follow-up
 *
 * Extraction pipeline (first-match-wins):
 *   Path 1 -- severity regex (existing, unchanged on happy path)
 *               non-zero counts -> DIRTY
 *               all-zero counts -> fall through (EDGE-004)
 *   Path 5 -- zero-count severity breakdown (>=2 distinct labels, all 0,
 *               within a 10-line window) -> CLEAN
 *   Path D -- DIRTY-phrase short-circuit ("issues detected", "not ready",
 *               "Status: FAIL" and related) -> DIRTY
 *   Path 2 -- structured finding-list regex (3 alternates + generic cues)
 *               -> DIRTY with finding-count
 *   Path 3 -- severity-word-prose detection (line-anchored, negation-safe,
 *               fenced-code & blockquote stripped) -> DIRTY
 *   Path 4 -- widened success-marker on up to last 3 non-empty lines, or
 *               Status:/Result:/Verdict:/Outcome:/Assessment: prefixed marker
 *               -> CLEAN
 *
 *   No path matches -> source='parse_failed', append metadata-only diagnostic
 *   entry to .claude/context/session.log (no raw bytes), enforce mode 0600.
 *
 * Source values (NFR-5, AC-11):
 *   hook              -- automated SubagentStop, written via module import only
 *   parse_failed      -- all 4 extractor paths missed (streak-breaking)
 *   manual_fallback   -- EC-7 fail-closed after log-write failure (streak-breaking)
 *   hook_manual       -- operator emergency remediation (streak-breaking, CLI-only)
 *   manual            -- operator CLI write (streak-breaking)
 *
 * Pinned fs imports (T-08, chk-test-fsmock): destructured named imports only.
 * Namespace / default / dynamic imports defeat Vitest module-mock determinism.
 *
 * Claude Code SubagentStop event envelope fields:
 *   - input.agent_type: string (agent name from .claude/agents/)
 *   - input.last_assistant_message: string (agent's final text response)
 *   - input.agent_transcript_path: string (JSONL transcript path)
 *   - input.agent_id: string (unique subagent instance ID)
 *
 * Agent type allowlist (AC-3.3):
 *   interface-investigator -> investigation
 *   challenger             -> challenger
 *   code-reviewer          -> code_review
 *   security-reviewer      -> security_review
 *   unifier                -> unifier
 *   completion-verifier    -> completion_verifier
 *
 * Non-convergence agents are silently ignored (exit 0, empty JSON).
 * Top-level errors fail-open (exit 0, empty JSON).
 */

// T-08: pinned destructured named fs imports for vi.mock determinism
import { appendFileSync, statSync, chmodSync, openSync, closeSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { computeFindingsHash } from './lib/findings-hash.mjs';
// T-09 / AC-9: module-import recordPass directly. No CLI subprocess for source='hook'.
import { recordPass } from './session-checkpoint.mjs';

// =============================================================================
// Constants
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPTS_DIR = __dirname;
const CLAUDE_DIR = dirname(SCRIPTS_DIR);
const CONTEXT_DIR = join(CLAUDE_DIR, 'context');
const SESSION_LOG_PATH = join(CONTEXT_DIR, 'session.log');
const SESSION_JSON_PATH = join(CONTEXT_DIR, 'session.json');
const CHECKPOINT_SCRIPT = join(SCRIPTS_DIR, 'session-checkpoint.mjs');

const GATE_MAP = {
  'interface-investigator': 'investigation',
  'challenger': 'challenger',
  'code-reviewer': 'code_review',
  'security-reviewer': 'security_review',
  'unifier': 'unifier',
  'completion-verifier': 'completion_verifier',
};

const HIGH_PLUS_THRESHOLD_GATES = new Set(['code_review']);

// AC-7 streak-reset semantics: degraded threshold for circuit breaker
const CIRCUIT_BREAKER_DEGRADED_THRESHOLD = 3;

// T-08 / AC-16: file mode for session.log (rw-------)
const SESSION_LOG_MODE = 0o600;

// AC-8: extraction paths reported in diagnostic log. Order reflects
// precedence after the v1.3 follow-up expansion (zero-severity-breakdown
// and dirty-phrase short-circuit inserted between path 1 and path 2).
const EXTRACTION_PATHS = [
  'severity',
  'zero_severity_breakdown',
  'dirty_phrase',
  'finding_list',
  'severity_prose',
  'success_marker',
];

// SC-3 authoritative finding-ID prefix inventory (Investigation Findings (b))
// plus seed-list prefixes (AC, NFR, FLOW) commonly used in spec authoring
// per challenger pre-impl pass 1 widening. Collision guard against severity
// header words (Medium-, High-, Critical-, Low-) is preserved by the
// allow-list lookup (none of the severity words appear here).
const PREFIX_ALLOW_LIST = new Set([
  'AC', 'ASM', 'AUTH', 'AUTHZ', 'BIZ', 'CHK', 'CR', 'CVG', 'DATA', 'DEC',
  'EDGE', 'FLOW', 'IMPL', 'INC', 'INPUT', 'LOG', 'NAM', 'NFR', 'REQ',
  'SEC', 'STALE', 'TECH',
]);

// SC-3 list-format alternates (canonical regexes, /gm + matchAll)
const FINDING_LIST_BULLETED = /^\s*[-*]\s+\*{0,2}([A-Z]{2,5}-\d{3,})\*{0,2}/gm;
const FINDING_LIST_NUMBERED = /^\s*\d+[.)]\s+\*{0,2}([A-Z]{2,5}-\d{3,})\*{0,2}/gm;
// Bare-indent widened per Investigation Findings (c): : | ` -- ` | ` — `
const FINDING_LIST_BARE_INDENTED =
  /^\s{2,}\*{0,2}([A-Z]{2,5}-\d{3,})\*{0,2}(\s*:|\s+--\s+|\s+\u2014\s+)/gm;

// SC-3 generic-cue signals
const FINDING_LIST_GENERIC_CUES = [
  /^###\s+Findings\b/m,
  /^##\s+Findings\b/m,
  /^###\s+Issues\b/m,
  /^##\s+Issues\b/m,
  /\*\*Severity:\*\*/,
];

// SEC-010 / TECH-015 / EDGE-021 path-3 prose regex.
//
// Spec-canonical form (PRD/spec.md REQ-NFR-2a, AC-4) is line-anchored:
//   /^(?!\s*(?:no|zero|0|without)\s+)(?:[-*]\s+)?\b(critical|...)\b[^\n]{0,40}\b(issue|...)\b/gim
//
// However the AC-4 positive-match test expects mid-line prose like
// "We observed critical issues" to match. The spec's intent (negate
// "no/zero/without/0 + severity" while accepting natural-language mentions of
// severity findings) is preserved by replacing the `^...lookahead` anchor with
// a `\b...lookbehind` form. The lookbehind explicitly rejects negation words
// immediately preceding a severity word, regardless of line position. The
// 40-char gap to a finding-verb keeps meta-discussion false positives bounded.
const SEVERITY_WORD_PROSE =
  /(?<!\b(?:no|zero|0|without)\s)\b(critical|high|medium|low)\b[^\n]{0,40}\b(issue|issues|finding|findings|found|problem|problems|concern|concerns)\b/gim;

// SC-2 / EDGE-016 / EDGE-019 success-marker (matches normalized last non-empty line)
// Widened per sg-convergence-recorder-tolerance v1.3 follow-up to accept a
// broader natural-language vocabulary. Standalone-line anchor and terminator
// constraints preserved: `^\s*<marker>\s*[\.!,\u2026]*\s*$`.
const SUCCESS_MARKER =
  /^\s*(no issues found|no issues detected|no issues|no concerns found|no concerns|no problems found|no problems|no blockers found|no blocking issues|no blocking findings|no findings|no blockers|all checks passed|all clear|all good|all systems go|everything passes|everything looks good|nothing to flag|nothing blocking|verified clean|clean pass|clean|passed|pass|ok|approved|approval granted|looks good|lgtm|ready to ship|ready to merge|ready for merge)\s*[\.!,\u2026]*\s*$/im;

// Status:/Result:/Verdict:/Outcome:/Assessment: prefixed success markers. Accepts
// `:` or `=` as the separator and a constrained positive-outcome vocabulary.
const STATUS_PREFIX_SUCCESS =
  /^\s*(status|result|verdict|outcome|assessment)\s*[:=]\s*(clean|pass|passed|ok|approved|green|ready|clear|good)\s*[\.!,\u2026]*\s*$/im;

// Number of trailing non-empty lines inspected when looking for a success
// marker (path 4). Supports responses that append a closing sentence such as
// "Spec group ready for implementation." after a valid marker line.
const SUCCESS_MARKER_LOOKBACK_LINES = 3;

// Symmetric DIRTY expansion: natural-language dirty-state phrases and
// Status:/Verdict: FAIL-style markers.
//
// Line-anchored: each pattern requires the phrase to occupy a standalone line
// (optional leading whitespace, optional bullet prefix `-` or `*`, optional
// trailing punctuation). This prevents false-positives from agent responses
// that legitimately quote dirty vocabulary in prose or reference the contract
// (e.g., "any investigator response that echoes `Issues detected.` will...").
// Multiline flag enables `^`/`$` anchors per line.
//
// Negation-safe: each natural-language phrase rejects an immediately preceding
// "no"/"zero"/"0"/"without" qualifier via lookbehind on the anchored prefix.
// This preserves the symmetry with path 3's negation guard and avoids false
// DIRTY on responses that explicitly negate (e.g. "no issues detected").
//
// Scoped to tail: these patterns are matched only within the last N non-empty
// lines (post-normalization) to further reduce mid-response narrative
// false-positives. See DIRTY_PHRASE_LOOKBACK_LINES.
const DIRTY_PHRASE_PATTERNS = [
  /^\s*(?:[-*]\s+)?(?<!\b(?:no|zero|0|without)\s)\bissues\s+detected\b[\.!,\u2026]*\s*$/im,
  /^\s*(?:[-*]\s+)?(?<!\b(?:no|zero|0|without)\s)\bproblems\s+found\b[\.!,\u2026]*\s*$/im,
  /^\s*(?:[-*]\s+)?(?<!\b(?:no|zero|0|without)\s)\bblockers\s+detected\b[\.!,\u2026]*\s*$/im,
  /^\s*(?:[-*]\s+)?(?<!\b(?:no|zero|0|without)\s)\bfailures\s+detected\b[\.!,\u2026]*\s*$/im,
  /^\s*(?:[-*]\s+)?\bnot\s+ready\b[\.!,\u2026]*\s*$/im,
  /^\s*(status|verdict|result|outcome|assessment)\s*[:=]\s*(fail|failed|blocked|red|error)\s*[\.!,\u2026]*\s*$/im,
];

// Mirror path-4 success-marker lookback. Only scan dirty phrases within the
// last N non-empty lines (post-normalization). Set slightly larger than the
// success-marker lookback to tolerate the typical "marker + short rationale"
// response pattern.
const DIRTY_PHRASE_LOOKBACK_LINES = 5;

// Path 5 zero-count severity-breakdown line. Matches list-prefix `- ` or `* `
// (optional), optional `**` emphasis (where the colon may sit inside or
// outside the bold delimiters), severity label, `:` or `=`, zero count,
// optional `finding`/`findings` trailing word.
//
// Accepted bold forms:
//   - Critical: 0                 (no emphasis)
//   - **Critical**: 0             (colon outside bold)
//   - **Critical:** 0             (colon inside bold)
//   - **Critical: 0**             (colon and count inside bold)
const ZERO_COUNT_SEVERITY_LINE =
  /^\s*[-*]?\s*\*{0,2}(critical|high|medium|low|blocker|minor|notable|info)(?:\s*[:=]\s*\*{0,2}|\s*\*{0,2}\s*[:=]\s*)\s*\*{0,2}0\*{0,2}\s*(finding|findings)?\s*\*{0,2}\s*$/im;
const ZERO_COUNT_SEVERITY_LINE_GLOBAL = new RegExp(
  ZERO_COUNT_SEVERITY_LINE.source,
  'gim'
);
// Path 5 sliding window: scan any 10-line segment for >=2 distinct labels.
const ZERO_COUNT_WINDOW_SIZE = 10;
const ZERO_COUNT_MIN_DISTINCT_LABELS = 2;

// TECH-011 trailing metadata-suffix line pattern
const METADATA_SUFFIX_LINE = /^(agentId|<usage>|<\/?\w+>|\w+:\s*\S)/;

// =============================================================================
// Stdin Reader
// =============================================================================

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// =============================================================================
// TECH-011 normalization pipeline (shared by paths 3 & 4)
// =============================================================================

/**
 * Apply TECH-011 normalization in order:
 *   (1) strip trailing Unicode whitespace
 *   (2) remove trailing fenced code blocks
 *   (3) remove trailing HTML comments
 *   (4) remove trailing metadata-suffix lines
 *
 * Returns the normalized text. Used to resolve "last non-empty line" for path 4
 * and to pre-strip trailing noise prior to path 3.
 */
function normalizeForLastLine(text) {
  if (!text || typeof text !== 'string') return '';

  // Step 1: strip trailing Unicode whitespace
  let working = text.replace(/[\s\u00a0\u2028\u2029]+$/u, '');

  // Iteratively strip trailing fenced code, HTML comments, and metadata
  // suffix lines. Loop until no further progress to handle interleaved cases.
  let prev;
  do {
    prev = working;

    // Step 2: remove a single trailing fenced code block.
    // Matches the last non-empty content as ``` ... ``` (optionally with
    // language tag on the opening fence).
    working = working.replace(
      /\n```[^\n]*\n[\s\S]*?\n```\s*$/u,
      ''
    );
    // Also handle case where fence is at very start of remaining text
    working = working.replace(
      /^```[^\n]*\n[\s\S]*?\n```\s*$/u,
      ''
    );

    // Step 3: remove trailing HTML comment(s)
    working = working.replace(/\s*<!--[\s\S]*?-->\s*$/u, '');

    // Step 4: remove trailing metadata-suffix lines until non-matching line.
    // Exception: preserve Status:/Result:/Verdict:/Outcome:/Assessment: success
    // marker lines (and the symmetric DIRTY form), since those look
    // like "metadata" per the generic `\w+:\s*\S` pattern but carry real
    // convergence-classification payload.
    const lines = working.split('\n');
    while (lines.length > 0) {
      const last = lines[lines.length - 1];
      // Skip blank line
      if (last.trim() === '') {
        lines.pop();
        continue;
      }
      // Preserve success-prefixed markers ("Status: CLEAN", "Result: APPROVED")
      // and their DIRTY counterparts ("Status: FAIL").
      if (STATUS_PREFIX_SUCCESS.test(last) || /^\s*(status|verdict|result|outcome|assessment)\s*[:=]\s*(fail|failed|blocked|red|error)\b/i.test(last)) {
        break;
      }
      if (METADATA_SUFFIX_LINE.test(last)) {
        lines.pop();
      } else {
        break;
      }
    }
    working = lines.join('\n');
    // Re-strip trailing whitespace after lines removed
    working = working.replace(/[\s\u00a0\u2028\u2029]+$/u, '');
  } while (working !== prev);

  return working;
}

/** Resolve last non-empty line from the normalized text (path 4 input). */
function lastNonEmptyLine(normalized) {
  if (!normalized) return '';
  const lines = normalized.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/\S/.test(lines[i])) {
      return lines[i];
    }
  }
  return '';
}

/** Strip ALL fenced code blocks from text (path 3 preprocessing). */
function stripFencedCode(text) {
  if (!text) return '';
  return text.replace(/```[\s\S]*?```/g, '');
}

/** Strip lines starting with `>` (markdown blockquotes) (path 3 preprocessing). */
function stripBlockquotes(text) {
  if (!text) return '';
  return text
    .split('\n')
    .filter((line) => !/^\s*>\s/.test(line))
    .join('\n');
}

// =============================================================================
// Path 1: severity regex (existing, byte-identical happy path)
// =============================================================================

/**
 * Parse severity counts from text. Preserved behavior from existing extractor.
 * Returns { critical, high, medium, low } or null if no severity pattern found.
 */
function parseSeverityCounts(text) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  let matched = false;
  const severities = ['critical', 'high', 'medium', 'low'];

  for (const severity of severities) {
    const severityFirst = new RegExp(`${severity}[:\\s]+?(\\d+)`, 'i');
    const m1 = text.match(severityFirst);
    if (m1) {
      counts[severity] = parseInt(m1[1], 10);
      matched = true;
      continue;
    }
    const countFirst = new RegExp(`(\\d+)\\s+${severity}`, 'i');
    const m2 = text.match(countFirst);
    if (m2) {
      counts[severity] = parseInt(m2[1], 10);
      matched = true;
      continue;
    }
    const tablePat = new RegExp(`\\|\\s*${severity}\\s*\\|\\s*(\\d+)\\s*\\|`, 'i');
    const m3 = text.match(tablePat);
    if (m3) {
      counts[severity] = parseInt(m3[1], 10);
      matched = true;
    }
  }

  return matched ? counts : null;
}

/**
 * Path 1 dispatcher.
 * Returns:
 *   - { matched: true, clean, finding_count } when severity regex matches with
 *     non-zero counts (CLEAN if zero per gate threshold; otherwise DIRTY).
 *   - { matched: false } when no severity match OR all counts zero (EDGE-004
 *     fall-through to path 2).
 */
function tryPath1Severity(text, gateName) {
  // Check JSON-block format first (preserved legacy behavior)
  const jsonResult = tryExtractJsonBlock(text);
  if (jsonResult !== null) {
    const count = jsonResult.findings_count ?? jsonResult.findingsCount ?? null;
    if (count !== null) {
      const numCount = Number(count);
      if (numCount > 0) {
        let clean = jsonResult.clean ?? false;
        clean = clean === true || clean === 'true';
        return { matched: true, clean, finding_count: numCount };
      }
      // count === 0: fall through (EDGE-004) to path 2
    }
  }

  const counts = parseSeverityCounts(text);
  if (counts === null) return { matched: false };

  const total = (counts.critical || 0) + (counts.high || 0) + (counts.medium || 0) + (counts.low || 0);
  if (total === 0) {
    // EDGE-004: all-zero severity falls through to path 2
    return { matched: false };
  }

  // Gate threshold determines clean classification on non-zero counts
  const useHighThreshold = HIGH_PLUS_THRESHOLD_GATES.has(gateName);
  let clean;
  if (useHighThreshold) {
    clean = (counts.critical || 0) === 0 && (counts.high || 0) === 0;
  } else {
    clean = (counts.critical || 0) === 0
      && (counts.high || 0) === 0
      && (counts.medium || 0) === 0;
  }

  return { matched: true, clean, finding_count: total };
}

function tryExtractJsonBlock(text) {
  const jsonBlockPattern = /```json(?::findings-summary)?\s*\n([\s\S]*?)```/;
  const match = text.match(jsonBlockPattern);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1].trim());
    if (parsed && typeof parsed === 'object' &&
        ('findings_count' in parsed || 'findingsCount' in parsed ||
         'findings_ids' in parsed || 'findingsIds' in parsed ||
         'clean' in parsed || 'critical' in parsed)) {
      return parsed;
    }
  } catch {
    // Not valid JSON
  }
  return null;
}

// =============================================================================
// Path 2: structured finding-list extractor (3 alternates + generic cues)
// =============================================================================

/**
 * Returns:
 *   { matched: true, finding_count } -- DIRTY classification
 *   { matched: false } -- no finding-list pattern detected
 */
function tryPath2FindingList(text) {
  const matches = [];
  const seenLines = new Set(); // dedupe per-line matches across alternates

  for (const re of [FINDING_LIST_BULLETED, FINDING_LIST_NUMBERED, FINDING_LIST_BARE_INDENTED]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const prefix = m[1].split('-')[0];
      // SC-3 collision guard: only allow-listed prefixes count
      if (!PREFIX_ALLOW_LIST.has(prefix)) continue;
      // Dedupe: same line shouldn't be counted twice across alternates
      const lineKey = `${m.index}:${m[1]}`;
      if (seenLines.has(lineKey)) continue;
      seenLines.add(lineKey);
      matches.push(m[1]);
    }
  }

  if (matches.length > 0) {
    return { matched: true, finding_count: matches.length, finding_ids: matches };
  }

  // Generic-cue path: a heading or bold-label cue with no finding-IDs.
  // Count bulleted items beneath the cue until next heading of equal/higher
  // depth or end of response.
  for (const cue of FINDING_LIST_GENERIC_CUES) {
    const cueMatch = text.match(cue);
    if (cueMatch) {
      const after = text.slice(cueMatch.index + cueMatch[0].length);
      // Count bulleted lines until next heading
      const lines = after.split('\n');
      let count = 0;
      for (const ln of lines) {
        // Stop at heading of equal/higher depth (## or ###)
        if (/^#{1,3}\s/.test(ln)) break;
        if (/^\s*[-*]\s+\S/.test(ln)) count++;
      }
      // Generic cue with no items still counts as DIRTY (cue itself implies findings)
      return { matched: true, finding_count: count > 0 ? count : 1 };
    }
  }

  return { matched: false };
}

// =============================================================================
// Path 3: severity-word-prose detection
// =============================================================================

/**
 * Returns:
 *   { matched: true, finding_count } -- DIRTY
 *   { matched: false } -- no prose match
 */
function tryPath3SeverityProse(text) {
  // Preprocess: TECH-011 normalize -> strip fenced code (whole response) -> strip blockquotes
  let working = normalizeForLastLine(text);
  working = stripFencedCode(working);
  working = stripBlockquotes(working);

  SEVERITY_WORD_PROSE.lastIndex = 0;
  const matches = Array.from(working.matchAll(SEVERITY_WORD_PROSE));
  if (matches.length === 0) return { matched: false };
  return { matched: true, finding_count: matches.length };
}

// =============================================================================
// Path 4: success-marker on normalized last non-empty line
// =============================================================================

/** Resolve the last N non-empty lines from normalized text (path 4 input). */
function lastNNonEmptyLines(normalized, n) {
  if (!normalized) return [];
  const lines = normalized.split('\n');
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    if (/\S/.test(lines[i])) {
      out.push(lines[i]);
    }
  }
  return out; // ordered tail-first: idx 0 is the last non-empty line
}

/**
 * Returns:
 *   { matched: true } -- CLEAN
 *   { matched: false, normalized_length } -- no marker (normalized_length used
 *     for EC-13 "normalize-to-empty" diagnostic)
 *
 * Walks the last SUCCESS_MARKER_LOOKBACK_LINES non-empty lines, tail-first.
 * Accepts either the widened SUCCESS_MARKER vocabulary or a Status:/Result:/
 * Verdict:/Outcome:/Assessment: prefixed success marker.
 */
function tryPath4SuccessMarker(text) {
  const normalized = normalizeForLastLine(text);
  const tailLines = lastNNonEmptyLines(normalized, SUCCESS_MARKER_LOOKBACK_LINES);
  if (tailLines.length === 0) {
    // EC-13: normalization reduced response to empty / no non-empty lines
    return { matched: false, normalized_length: normalized.length };
  }
  for (const line of tailLines) {
    if (SUCCESS_MARKER.test(line) || STATUS_PREFIX_SUCCESS.test(line)) {
      return { matched: true };
    }
  }
  return { matched: false, normalized_length: normalized.length };
}

// =============================================================================
// Path 5: all-zero severity breakdown (CLEAN)
// =============================================================================

/**
 * Scan the response for zero-count severity-breakdown lines. Labels drawn from
 * {critical, high, medium, low, blocker, minor, notable, info}.
 *
 * Match semantics:
 *   1. Locate every zero-count severity-label line in the response.
 *   2. All zero-count hits must fit within a single ZERO_COUNT_WINDOW_SIZE
 *      (10) line window -- i.e., last.idx - first.idx < window. This ensures
 *      that a single compact breakdown matches while scattered mentions
 *      across the response do not.
 *   3. Match requires >= 2 distinct labels among the hits.
 *
 * Returns:
 *   { matched: true }  -- CLEAN (compact zero-count breakdown found)
 *   { matched: false } -- no breakdown, or hits spread beyond window
 */
function tryPath5ZeroSeverityBreakdown(text) {
  if (!text) return { matched: false };
  const lines = text.split('\n');

  // Collect every zero-count severity-label line with its line index.
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(ZERO_COUNT_SEVERITY_LINE);
    if (m) {
      hits.push({ idx: i, label: m[1].toLowerCase() });
    }
  }
  if (hits.length < ZERO_COUNT_MIN_DISTINCT_LABELS) return { matched: false };

  // All hits must fit within one window; otherwise the signal is scattered
  // and we do not treat it as a structured breakdown.
  const span = hits[hits.length - 1].idx - hits[0].idx;
  if (span >= ZERO_COUNT_WINDOW_SIZE) return { matched: false };

  const distinct = new Set(hits.map((h) => h.label));
  if (distinct.size >= ZERO_COUNT_MIN_DISTINCT_LABELS) {
    return { matched: true };
  }
  return { matched: false };
}

/**
 * DIRTY symmetric-expansion short-circuit.
 *
 * Preprocesses input identically to path 3 (severity prose):
 *   1. TECH-011 normalize (strip trailing fences / HTML comments / metadata)
 *   2. Strip ALL fenced code blocks (defeats regression where agent markdown
 *      files quoting `Issues detected.` inside ``` fences false-positive)
 *   3. Strip blockquotes (`> ` prefix lines)
 *
 * Then scopes matching to the last DIRTY_PHRASE_LOOKBACK_LINES non-empty
 * lines, mirroring path-4 success-marker behavior. Finally, each pattern is
 * line-anchored so mid-response narrative does not fire.
 *
 * Runs after path 1 (severity) so that a response carrying both explicit
 * severity counts and a "not ready" phrase is handled by path 1 per spec.
 * Runs before path 4 (success marker) so an unambiguous dirty declaration
 * overrides a trailing CLEAN marker.
 */
function tryDirtyPhrase(text) {
  if (!text) return { matched: false };
  // Preprocess: same normalization as path 3 so fenced code & blockquotes
  // don't trigger DIRTY classification on agent markdown that quotes the
  // dirty vocabulary.
  let working = normalizeForLastLine(text);
  working = stripFencedCode(working);
  working = stripBlockquotes(working);
  if (!working.trim()) return { matched: false };

  // Scope to last N non-empty lines (post-normalization). This matches the
  // path-4 success-marker lookback strategy so that only declarative tail
  // statements trigger the short-circuit.
  const tailLines = lastNNonEmptyLines(working, DIRTY_PHRASE_LOOKBACK_LINES);
  if (tailLines.length === 0) return { matched: false };
  const scoped = tailLines.join('\n');

  for (const re of DIRTY_PHRASE_PATTERNS) {
    if (re.test(scoped)) {
      return { matched: true, finding_count: 1 };
    }
  }
  return { matched: false };
}

// =============================================================================
// 4-tier dispatcher
// =============================================================================

/**
 * Run the extraction pipeline. Returns:
 *   { source: 'hook', clean: boolean, finding_count: number|null } -- one of
 *     paths 1-5 matched
 *   { source: 'parse_failed', clean: false, normalized_length } -- all paths missed
 *
 * Precedence (first-match-wins):
 *   1. severity regex (non-zero counts) -> DIRTY
 *   2. zero-count severity breakdown (>=2 distinct labels, all zero) -> CLEAN
 *   3. DIRTY-phrase short-circuit ("issues detected", "Status: FAIL", ...) -> DIRTY
 *   4. finding-list -> DIRTY
 *   5. severity-word prose -> DIRTY
 *   6. success marker on tail (up to 3 lines) -> CLEAN
 */
function classify(text, gateName) {
  // Path 1: severity regex (non-zero counts)
  const p1 = tryPath1Severity(text, gateName);
  if (p1.matched) {
    return { source: 'hook', clean: p1.clean, finding_count: p1.finding_count, path: 'severity' };
  }

  // Path 5 (precedence-wise between old path 1 and old path 2): all-zero
  // severity breakdown -> CLEAN. Path 1 already short-circuited on non-zero
  // counts, so reaching here means either no severity-regex match or all
  // severity counts were zero (EDGE-004 fall-through).
  const p5 = tryPath5ZeroSeverityBreakdown(text);
  if (p5.matched) {
    return { source: 'hook', clean: true, finding_count: 0, path: 'zero_severity_breakdown' };
  }

  // DIRTY symmetric-expansion short-circuit. Catches "issues detected",
  // "Status: FAIL", etc. Runs before finding-list / prose / success-marker
  // so that an unambiguous dirty signal anywhere in the response classifies
  // DIRTY without false CLEAN from a trailing marker.
  const dirty = tryDirtyPhrase(text);
  if (dirty.matched) {
    return { source: 'hook', clean: false, finding_count: dirty.finding_count, path: 'dirty_phrase' };
  }

  // Path 2: structured finding-list
  const p2 = tryPath2FindingList(text);
  if (p2.matched) {
    return { source: 'hook', clean: false, finding_count: p2.finding_count, path: 'finding_list', finding_ids: p2.finding_ids };
  }

  // Path 3: severity-word prose
  const p3 = tryPath3SeverityProse(text);
  if (p3.matched) {
    return { source: 'hook', clean: false, finding_count: p3.finding_count, path: 'severity_prose' };
  }

  // Path 4: success marker on tail (up to 3 non-empty lines)
  const p4 = tryPath4SuccessMarker(text);
  if (p4.matched) {
    return { source: 'hook', clean: true, finding_count: 0, path: 'success_marker' };
  }

  // All paths missed -> parse_failed
  return {
    source: 'parse_failed',
    clean: false,
    finding_count: null,
    path: null,
    normalized_length: p4.normalized_length ?? 0,
  };
}

// =============================================================================
// T-08: session.log diagnostic writer + chmod 0600 enforcement (AC-8, AC-16)
// =============================================================================

/**
 * Ensure session.log exists with mode 0o600. On every invocation, statSync the
 * file; if mode != 0o600, chmod and emit SESSION_LOG_CHMOD_CORRECTED stderr.
 * Throws on filesystem errors (caught by writeSessionLogEntry retry path).
 */
function ensureSessionLogMode() {
  if (existsSync(SESSION_LOG_PATH)) {
    const st = statSync(SESSION_LOG_PATH);
    const mode = st.mode & 0o777;
    if (mode !== SESSION_LOG_MODE) {
      const oldMode = mode.toString(8).padStart(4, '0');
      chmodSync(SESSION_LOG_PATH, SESSION_LOG_MODE);
      process.stderr.write(`SESSION_LOG_CHMOD_CORRECTED: mode 0${oldMode}->0600\n`);
    }
  } else {
    // Create file with explicit mode 0o600 via openSync, then close.
    const fd = openSync(SESSION_LOG_PATH, 'a', SESSION_LOG_MODE);
    closeSync(fd);
    // Some platforms ignore mode arg if file already exists from a race;
    // double-check and chmod if needed.
    const st = statSync(SESSION_LOG_PATH);
    const mode = st.mode & 0o777;
    if (mode !== SESSION_LOG_MODE) {
      chmodSync(SESSION_LOG_PATH, SESSION_LOG_MODE);
    }
  }
}

/**
 * Append a metadata-only diagnostic JSON record to session.log.
 * Schema (AC-8):
 *   {
 *     timestamp, gate, agent_type, agent_id?,
 *     response_length, response_length_normalized?,
 *     response_sha256_prefix16,
 *     extraction_paths_tried: [...]
 *   }
 *
 * Retry once on first failure with 100ms backoff. On retry failure, throws
 * (caller invokes circuit-breaker fail-closed path).
 */
function writeSessionLogEntry(entry) {
  ensureSessionLogMode();
  const line = JSON.stringify(entry) + '\n';
  try {
    appendFileSync(SESSION_LOG_PATH, line);
  } catch (err) {
    // Retry once with 100ms backoff
    const start = Date.now();
    while (Date.now() - start < 100) {
      // busy-wait 100ms (no async sleep -- keep call-site sync for vi.mock)
    }
    try {
      // Re-ensure mode in case the failure was permission-related
      ensureSessionLogMode();
      appendFileSync(SESSION_LOG_PATH, line);
    } catch (retryErr) {
      // Propagate the retry error with errno preserved
      const wrapped = new Error(`SESSION_LOG_WRITE_FAIL: errno=${retryErr.code || 'UNKNOWN'}`);
      wrapped.code = retryErr.code;
      wrapped.cause = retryErr;
      throw wrapped;
    }
  }
}

/**
 * Build the diagnostic log entry from the parse_failed result.
 */
function buildDiagnosticEntry(opts) {
  const { gateName, agentType, agentId, responseText, normalizedLength } = opts;
  const sha = createHash('sha256').update(responseText, 'utf8').digest('hex').slice(0, 16);
  const entry = {
    timestamp: new Date().toISOString(),
    gate: gateName,
    agent_type: agentType,
    response_length: Buffer.byteLength(responseText, 'utf8'),
    response_sha256_prefix16: sha,
    extraction_paths_tried: [...EXTRACTION_PATHS],
  };
  if (agentId) entry.agent_id = agentId;
  // EC-13: include response_length_normalized only when normalization-to-empty
  if (normalizedLength === 0) {
    entry.response_length_normalized = 0;
  }
  return entry;
}

// =============================================================================
// T-07: circuit-breaker integration (AC-13, AC-15)
// =============================================================================

/**
 * Read circuit-breaker state for a gate from session.json.
 * Returns the gate state object or null if no state present.
 */
function readCircuitBreakerState(gateName) {
  if (!existsSync(SESSION_JSON_PATH)) return null;
  try {
    const session = JSON.parse(readFileSync(SESSION_JSON_PATH, 'utf8'));
    return session?.convergence_log_failures?.[gateName] ?? null;
  } catch {
    return null;
  }
}

/**
 * Invoke the update-circuit-breaker CLI op via subprocess (origin-insensitive
 * state per design notes). Spawning a subprocess for circuit-breaker state
 * updates is acceptable; only `source='hook'` writes require module import.
 */
function invokeCircuitBreakerUpdate(gateName, event) {
  try {
    execFileSync(
      'node',
      [CHECKPOINT_SCRIPT, 'update-circuit-breaker', '--gate', gateName, '--event', event],
      { cwd: process.cwd(), timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
  } catch (err) {
    // Best-effort: warn but don't fail the hook
    process.stderr.write(
      `[convergence-pass-recorder] WARNING: update-circuit-breaker ${event} failed: ${err.message}\n`
    );
  }
}

// =============================================================================
// Main extract-and-record entry point (callable for tests, AC-15)
// =============================================================================

/**
 * Top-level extract-and-record entry point.
 *
 * Exported so tests (AC-15 stub) can drive the recorder via vi.mock.
 *
 * @param {Object} opts
 * @param {string} opts.responseText
 * @param {string} opts.agentType
 * @param {string} opts.gateName
 * @param {string} [opts.agentId]
 */
export async function extractAndRecord(opts) {
  const { responseText, agentType, gateName, agentId } = opts;

  const result = classify(responseText, gateName);

  if (result.source === 'hook') {
    // Paths 1/2/3/4 hit -- module-import recordPass (AC-9)
    await recordPass({
      source: 'hook',
      gate: gateName,
      clean: result.clean,
      findingCount: result.finding_count,
      findingsHash: result.finding_ids
        ? computeFindingsHash(result.finding_ids)
        : (result.finding_count === 0 ? computeFindingsHash([]) : null),
      agentType,
      agentId,
    });
    return;
  }

  // result.source === 'parse_failed': diagnostic log + circuit-breaker logic
  const cbState = readCircuitBreakerState(gateName);
  const inDegradedMode = cbState?.degraded_mode === true;

  // Build diagnostic entry once (used for both paths)
  const entry = buildDiagnosticEntry({
    gateName,
    agentType,
    agentId,
    responseText,
    normalizedLength: result.normalized_length,
  });

  if (inDegradedMode) {
    // Degraded mode: stderr-only, skip session.log write entirely, record parse_failed
    process.stderr.write(
      `[convergence-pass-recorder] DEGRADED_MODE: gate=${gateName} skipping session.log write; ` +
      `recording source=parse_failed (entry=${JSON.stringify(entry)})\n`
    );
    await recordPass({
      source: 'parse_failed',
      gate: gateName,
      clean: false,
      findingCount: null,
      agentType,
      agentId,
    });
    return;
  }

  // Normal parse_failed path: append diagnostic log, then record parse_failed.
  // On log-write failure (after retry): emit SESSION_LOG_WRITE_FAIL stderr,
  // record manual_fallback, increment circuit-breaker.
  try {
    writeSessionLogEntry(entry);
    // Successful log write: exit degraded mode if it was set (best-effort).
    if (cbState && (cbState.consecutive_count > 0 || cbState.degraded_mode)) {
      invokeCircuitBreakerUpdate(gateName, 'success');
    }
    await recordPass({
      source: 'parse_failed',
      gate: gateName,
      clean: false,
      findingCount: null,
      agentType,
      agentId,
    });
  } catch (logErr) {
    // EC-7 fail-closed: emit stderr, record manual_fallback, bump circuit breaker
    process.stderr.write(`${logErr.message}\n`);
    await recordPass({
      source: 'manual_fallback',
      gate: gateName,
      clean: false,
      findingCount: null,
      agentType,
      agentId,
    });
    invokeCircuitBreakerUpdate(gateName, 'failure');
  }
}

// =============================================================================
// Hook envelope handler
// =============================================================================

async function processSubagentStop(input) {
  const agentType = input.agent_type;
  if (!agentType || typeof agentType !== 'string' || agentType.trim() === '') {
    if (agentType !== undefined) {
      process.stderr.write(
        `[convergence-pass-recorder] WARNING: agent_type is empty or invalid -- ignoring event\n`
      );
    }
    return;
  }
  const gateName = GATE_MAP[agentType];
  if (!gateName) {
    // Non-convergence agent -- silently ignore
    return;
  }

  const status = input.status;
  const isSuccessful = status === undefined || status === 'success';
  if (!isSuccessful) {
    process.stderr.write(
      `[convergence-pass-recorder] WARNING: Skipping pass recording for ${agentType} -- ` +
      `subagent status is "${status}" (expected "success" or absent)\n`
    );
    return;
  }

  // Resolve response text (preferring last_assistant_message; fall back to
  // legacy agent_output if ever supplied)
  let responseText = '';
  if (input.last_assistant_message && typeof input.last_assistant_message === 'string') {
    responseText = input.last_assistant_message;
  } else if (typeof input.agent_output === 'string') {
    responseText = input.agent_output;
  }

  const agentId = input.agent_id;

  if (!responseText) {
    // No response text at all -- emit a parse_failed entry with empty body
    // diagnostics so operators can see the missing-input case.
    process.stderr.write(
      `[convergence-pass-recorder] WARNING: No last_assistant_message for ${agentType} -- ` +
      `recording as parse_failed\n`
    );
    await extractAndRecord({
      responseText: '',
      agentType,
      gateName,
      agentId,
    });
    return;
  }

  await extractAndRecord({
    responseText,
    agentType,
    gateName,
    agentId,
  });
}

// =============================================================================
// CLI entry (subagent stop hook)
// =============================================================================

async function main() {
  try {
    const raw = await readStdin();
    if (!raw || !raw.trim()) {
      console.log('{}');
      process.exit(0);
    }

    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      console.log('{}');
      process.exit(0);
    }

    await processSubagentStop(input);
    console.log('{}');
  } catch (err) {
    process.stderr.write(`[convergence-pass-recorder] Error: ${err.message}\n`);
    console.log('{}');
  }
  process.exit(0);
}

// Dual-mode guard: only run main() when this file is the entry point.
// (Test harnesses can `await import` the module and call extractAndRecord
// directly without triggering stdin reads.)
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
