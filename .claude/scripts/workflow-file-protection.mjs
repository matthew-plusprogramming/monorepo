#!/usr/bin/env node

/**
 * PreToolUse Write Protection Hook for Enforcement Files
 *
 * Blocks agent writes to gate-override.json, gate-enforcement-disabled, and session.json.
 * Only human terminal writes are permitted for these files.
 *
 * Matches both Write and Bash tools:
 *   - Write tool: checks tool_input.file_path directly
 *   - Bash tool: checks tool_input.command for write-like operations (cp, mv, tee, >)
 *     targeting protected filenames (defense in depth, not exhaustive)
 *
 * CRITICAL: This hook does NOT check the kill switch (AC-3.4).
 * Write protection remains active regardless of gate-enforcement-disabled state.
 * This prevents agents from self-bypassing enforcement.
 *
 * Invocation: Receives stdin JSON from Claude Code PreToolUse hook system.
 * Input format (Write): { session_id: string, tool_name: string, tool_input: { file_path: string } }
 * Input format (Bash):  { session_id: string, tool_name: string, tool_input: { command: string } }
 *
 * Exit codes:
 *   0 - Allow (not a protected file / no write to protected file detected)
 *   2 - Block (write to protected enforcement file detected)
 *
 * Implements: REQ-012, AC-14.9 (deployment trust root protection)
 */

import { resolve, basename, sep } from 'node:path';
import { realpathSync, lstatSync, existsSync, readFileSync, writeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { platform } from 'node:os';
import {
  readStdin,
  getCanonicalProjectDir,
  CanonicalProjectDirError,
} from './lib/hook-utils.mjs';
import { isSentinelMatchExecTime } from './lib/kill-switch.mjs';
// sg-pipeline-efficiency-ws3-orchestrator-hygiene / as-008 / REQ-007 / AC8.1:
// Worktree-canon enforcement wired BEFORE existing FULL_BLOCK basename check.
// Canonicalizes the write-target path against the session-level
// project_dir_pin (captured at start-work by as-006). Rejects writes that
// resolve outside the pinned root with `WORKTREE_PATH_VIOLATION`. Legacy-
// session guard: when the pin is absent (pre-as-006 session, or consumer
// without active_work), enforcement is skipped and the existing FULL_BLOCK
// flow continues. Violations emit an audit-log entry + exit 2.
import {
  checkWorktreePathViolation,
  loadProjectDirPin,
  appendWorktreeAuditEntry,
  WORKTREE_PATH_VIOLATION,
} from './lib/worktree-enforcement.mjs';
// Structured classifier replaces substring-scan over-matcher. Re-export the
// legacy string helper from this file so existing test consumers
// (read-intent-hint.test.mjs, hook-friction-phase-a-file-protection.test.mjs)
// continue to import
// `classifyBashCommandIntent` from this file without change, while the
// hook's write-detection path consumes the structured object form via
// `classifyBashCommandIntentStructured`.
import {
  classifyBashCommandIntent as classifyBashCommandIntentStructured,
  classifyBashCommandIntentString,
  MAX_COMMAND_BYTES,
} from './lib/bash-intent-classifier.mjs';

/**
 * sec-authz-e7f3a12d (HIGH, CWE-807/345) — PPID attestation.
 *
 * Replaces the env-marker exemption (`AUDIT_APPEND_AUTHORIZED=1`) which was
 * trust-on-env and could be spoofed by any agent prefixing the var in a Bash
 * command. Instead, resolve the hook's parent process argv and require
 * `argv[0]` to be a node binary AND `argv[1]` to be `audit-append.mjs`.
 *
 * code-review pass 2 / M1 (hook-friction-phase-c-review-fixes.test.mjs):
 *   Earlier implementations walked ALL argv tokens looking for ANY token whose
 *   basename matched `audit-append.mjs`. Two exploitable edge cases:
 *
 *     (a) Wrapper-directory bypass: `node /tmp/audit-append.mjs/wrapper.sh`
 *         — the script lives INSIDE a directory named `audit-append.mjs`,
 *         not AT that path. The walk-any-token form matched the directory
 *         component, allowing a shell wrapper to impersonate the CLI.
 *
 *     (b) Middle-token injection on macOS: `ps -o command= -p <ppid>` returns
 *         a single whitespace-delimited line. A parent process whose argv
 *         includes a fragment ending in `audit-append.mjs` past position 1
 *         (e.g., `some-prefix node /tmp/malicious.sh audit-append.mjs`)
 *         would false-match on the terminal token.
 *
 *   Hardened contract:
 *     - Take exactly the first TWO tokens (argv[0], argv[1]).
 *     - Require argv[0] basename to be `node` (or `.node` on some pkg wrappers).
 *     - Require argv[1] basename to be `audit-append.mjs`.
 *     - Reject if any path component of argv[1] OTHER than the final basename
 *       is literally `audit-append.mjs` (so `/tmp/audit-append.mjs/wrapper.sh`
 *       where `audit-append.mjs` is a directory fails closed).
 *
 *   This is strictly narrower than the prior acceptance set. The legitimate
 *   invocation shape (`node /path/to/audit-append.mjs --action ...`) is
 *   unchanged. Paths with spaces in argv[1] on macOS will correctly fail
 *   closed (no way to recover argv word boundaries from ps output); this
 *   is acceptable per SEC-010 (audit integrity > availability).
 *
 * Platform handling:
 *   macOS:   `ps -o args= -p <ppid>` (alias of `command=`; clearer naming).
 *            Shell cost ~5-20ms, acceptable.
 *   Linux:   `/proc/<ppid>/cmdline` (NUL-separated argv). Sync read, <1ms.
 *   Other:   unsupported → attestation returns false (fail-closed).
 *
 * Fail-closed contract: any platform read failure, fewer than 2 tokens, or
 * anchor-shape mismatch returns `false`. Upstream callers MUST treat `false`
 * as "refuse the write", not "allow by default".
 *
 * @returns {boolean} true iff the hook's parent process argv[0..1] attest
 *   the caller is `node /path/to/audit-append.mjs`.
 */
function isCalledByAuditAppendCli() {
  const ppid = process.ppid;
  if (typeof ppid !== 'number' || ppid <= 0) return false;
  try {
    const argv = readParentArgv(ppid);
    if (!argv || argv.length < 2) return false;

    // Anchor check #1: argv[0] must be the node runtime. Accept basenames
    // `node` or `.node` (some packaged wrappers add a leading dot). Reject
    // anything else — shells, wrappers, python, etc. cannot attest for
    // audit-append.
    const runtimeBase = basename(stripQuotes(argv[0]));
    if (runtimeBase !== 'node' && runtimeBase !== '.node') return false;

    // Anchor check #2: argv[1] must resolve to audit-append.mjs by basename
    // AND no earlier path component may be literally `audit-append.mjs`
    // (defeats `node /tmp/audit-append.mjs/wrapper.sh` where
    // `audit-append.mjs` is a directory, not the script).
    const scriptPath = stripQuotes(argv[1]);
    const scriptBase = basename(scriptPath);
    if (scriptBase !== 'audit-append.mjs') return false;

    // Parse path components. Reject if any component OTHER than the final
    // basename is literally `audit-append.mjs` — that would indicate the
    // script name was smuggled into a parent directory name.
    const components = scriptPath.split(/[/\\]/).filter(c => c.length > 0);
    for (let i = 0; i < components.length - 1; i++) {
      if (components[i] === 'audit-append.mjs') return false;
    }

    return true;
  } catch {
    // Any platform read failure → fail-closed.
    return false;
  }
}

/**
 * Strip surrounding ASCII single/double quotes some ps implementations insert.
 * Idempotent for unquoted input.
 * @param {string} tok
 * @returns {string}
 */
function stripQuotes(tok) {
  return tok.replace(/^['"]|['"]$/g, '');
}

/**
 * Platform-specific parent argv reader. Returns an array of argv tokens or
 * null on failure. Does NOT throw — caller treats any falsy result as
 * fail-closed.
 *
 * Linux: `/proc/<ppid>/cmdline` is NUL-separated (reliable word boundaries).
 * macOS: `ps -o args= -p <ppid>` emits whitespace-delimited tokens. The
 *   downstream caller (isCalledByAuditAppendCli) consumes only argv[0] and
 *   argv[1]; embedded spaces within argv[2..N] cannot affect the anchor
 *   check. Paths with spaces in argv[1] itself will correctly fail closed
 *   on macOS (no way to recover argv word boundaries from ps output).
 */
function readParentArgv(ppid) {
  const osName = platform();
  if (osName === 'linux') {
    try {
      const raw = readFileSync(`/proc/${ppid}/cmdline`, 'utf-8');
      // /proc/<pid>/cmdline is NUL-separated, often with a trailing NUL.
      // Native argv boundary — no heuristic splitting required.
      return raw.split('\0').filter(t => t.length > 0);
    } catch {
      return null;
    }
  }
  if (osName === 'darwin') {
    // `ps -o args= -p <ppid>` is an alias of `-o command=` — emits the full
    // command line without header. Renamed `command=` → `args=` for clarity:
    // the downstream consumer only reads argv[0] and argv[1], so embedded
    // spaces within argv[2..N] (e.g., a rationale string with whitespace)
    // cannot false-match the anchor check. Short timeout keeps hook latency
    // bounded.
    const res = spawnSync('ps', ['-o', 'args=', '-p', String(ppid)], {
      encoding: 'utf-8',
      timeout: 2_000,
    });
    if (res.status !== 0 || !res.stdout) return null;
    // Split on any whitespace; consumer takes only the first 2 tokens.
    // Coarse for positions 2..N (unused) but sufficient for the anchor
    // check at positions 0..1 when invoked as `node /path/to/script.mjs`.
    return res.stdout.trim().split(/\s+/);
  }
  // Unsupported platform → fail-closed.
  return null;
}

/**
 * Protected file basenames that agents must not write to.
 *
 * Exported so `.claude/scripts/lib/bash-intent-classifier.mjs` can re-export
 * this authoritative declaration. The classifier is filename-list-agnostic;
 * it consumes whatever set the hook exposes at call time.
 *
 * @type {string[]}
 */
export const PROTECTED_FILENAMES = [
  'gate-override.json',
  'gate-enforcement-disabled',
  'session.json',
  // AC-14.9.a: Deployment intervention audit log (trust root)
  'deployment-interventions.log',
  // AC-14.9.b: Chain verifier script (trust root)
  'verify-deployment-audit-chain.mjs',
  // Convergence recorder tolerance T-10 / AC-17 / AC-23:
  // Diagnostic log for convergence-pass-recorder. Treated as FULL_BLOCK so
  // Claude agent Write/Edit tool calls cannot tamper with it. Direct
  // fs.appendFileSync from in-repo Node scripts is intentionally outside
  // this hook's vantage (it observes only Claude tool-call stdin JSON).
  'session.log',
  // sg-enforcement-layer-gaps Task 10 / AC-5.1 / REQ-M1-011:
  // Shape-lint PostToolUse hook's kill-switch sentinel. Protecting this file
  // from agent writes/deletes prevents self-disabling of the shape-lint hook.
  // Bash destructive vectors are additionally covered by the canonical
  // realpath match in detectBashWriteToProtectedFile() (AC-5.2, AC-5.3, AC-5.6).
  'shape-lint-disabled',
  // Silent-drop observability REQ-F-011 / AC-11:
  // Operator-controlled enforcement flag. Agent writes MUST be blocked so
  // the advisory→coercive flip cannot be performed by an agent (NFR-3).
  'silent-drop-enforcement.json',
  'enforcement-changes.log',
  // Silent-drop observability REQ-F-017 / AC-17:
  // Baseline report that gates the coercive flip. A forgeable baseline
  // means forgeable flip approval; agent writes blocked.
  'silent-drop-baseline.json',
  // Silent-drop observability REQ-F-021 / AC-21:
  // Audit-chain verifier. NFR-10 hash-chain integrity depends on the
  // verifier itself being tamper-proof — an unprotected verifier defeats
  // the entire chain.
  'verify-enforcement-audit-chain.mjs',
  // Silent-drop observability REQ-F-023 / AC-23:
  // SLA recommendation file. Only the maintainer-invoked SLA monitor (or
  // the operator via signed commit) may write; agent writes blocked.
  'baseline-sla-recommendation.json',
  // sg-pipeline-efficiency-ws1-convergence-pruning REQ-013 / AC15.2:
  // Operator-controlled pipeline-efficiency enforcement flag. Agent writes
  // MUST be blocked so the advisory→coercive flip cannot be performed by
  // an agent. Operator bootstrap via `git commit -S` under EDGE-019 carve-out.
  'pipeline-efficiency-enforcement.json',
  // sg-pipeline-efficiency-ws1-convergence-pruning REQ-014 / AC16.1 / AC16.2:
  // Hash-chain genesis anchor for pipeline-efficiency audit log. An agent-
  // forged genesis defeats the entire NFR-HASH-CHAIN-VERIFY trust chain;
  // anchor MUST be operator-signed via `git commit -S` (EDGE-019 carve-out).
  // Lives at `.claude/audit/pipeline-efficiency-genesis.json`.
  'pipeline-efficiency-genesis.json',
  // sg-pipeline-efficiency-ws1-convergence-pruning NFR-14 / AC16.2 / AC16.3:
  // Kill-switch sentinel. Presence bypasses ALL pipeline-efficiency
  // enforcement (EC-3); write AND delete must be blocked so agents cannot
  // self-disable enforcement. Only operator signed commits create/delete.
  // Lives at `.claude/coordination/pipeline-efficiency-disabled`.
  'pipeline-efficiency-disabled',
  'runtime-connectivity-enforcement.json',
  'rtc-enforcement-changes.log',
  'verify-rtc-enforcement-chain.mjs',
];

/**
 * Protected-filename regex patterns — evaluated alongside PROTECTED_FILENAMES
 * with UNION semantics. A target basename is protected iff it appears in the
 * exact-name list OR matches any pattern here.
 *
 * Kill-switch audit rotation protection:
 *   The audit log rotates (`kill-switch.log.jsonl`, `kill-switch.log.1.jsonl`,
 *   ..., `kill-switch.log.10.jsonl`). An exact-basename list cannot express
 *   the rotated-sibling coverage that DEC-CHK-005 mandates. A compiled regex
 *   does — anchored end-to-end so `kill-switch.log.jsonl.bak` and
 *   `kill-switch.log.old` deliberately DO NOT match (AC1.1.c).
 *
 *   The pattern directory is `.claude/audit/` — enforced via PROTECTED_PATTERN_DIRS
 *   below (kept in sync with PROTECTED_FILE_DIRS for exact-name entries).
 *
 * @type {Array<{ patternId: string, pattern: RegExp, dirSegment: string }>}
 *
 * Exported alongside PROTECTED_FILENAMES so lib/bash-intent-classifier.mjs
 * can re-export the single source of truth.
 */
export const PROTECTED_FILENAME_PATTERNS = [
  {
    // as-019 AC1.1: matches base file and rotated siblings N = 1..10 (the
    // regex deliberately accepts any \d+ sequence so future rotation counts
    // remain covered).
    patternId: 'kill-switch-log',
    pattern: /^kill-switch\.log(\.\d+)?\.jsonl$/,
    dirSegment: 'audit',
  },
  {
    // sec-input-3b4c8f21: protect the persistent rate-limit bucket state from
    // agent tampering. If an agent can forge tokens or a future refill_at, the
    // audit rate limiter collapses (either DOS by zeroing tokens, or
    // amplification by forging a full bucket). Only audit-append.mjs may write
    // this file — enforced via the same PPID attestation exemption used for
    // the log pattern (see isCalledByAuditAppendCli()).
    patternId: 'rate-limit-state',
    pattern: /^rate-limit\.state$/,
    dirSegment: 'audit',
  },
  {
    // sg-pipeline-efficiency-ws2-practice-2.4 / SEC-WS2-001 (security-review
    // Pass 1): per-session HMAC secret files live at
    // `.claude/coordination/.session-hmac-<session-id>` and are bootstrapped
    // with `O_EXCL` + mode 0600 by `readOrBootstrapSessionHmacSecret` in
    // session-checkpoint.mjs. The secret protects test-writer-unlock marker
    // integrity (AC-005.8); agent writes MUST be blocked so a hostile
    // dispatch cannot forge a new secret and mint markers against it. The
    // basename set is unbounded (one file per session-id) so a regex pattern
    // is required — exact-name enumeration is not feasible.
    //
    // Leading-dot prefix matches the on-disk convention (hidden file so
    // accidental `ls` doesn't surface the secret). `.+` requires a
    // non-empty session-id suffix; `.session-hmac-` alone is not a valid
    // secret path and should NOT match.
    patternId: 'session-hmac-secret',
    pattern: /^\.session-hmac-.+$/,
    dirSegment: 'coordination',
  },
];

/**
 * Directory segment (relative to `.claude/`) for each regex-matched protected
 * pattern. Mirrors PROTECTED_FILE_DIRS. Writes to a matching basename only
 * block when the containing directory matches.
 */
const PROTECTED_PATTERN_DIRS = PROTECTED_FILENAME_PATTERNS.reduce(
  (acc, entry) => {
    acc[entry.patternId] = entry.dirSegment;
    return acc;
  },
  /** @type {Record<string,string>} */ ({})
);

/**
 * Return the first pattern entry whose regex matches `basename_`, or null.
 *
 * @param {string} basename_
 * @returns {{patternId:string,pattern:RegExp,dirSegment:string}|null}
 */
function matchProtectedPattern(basename_) {
  for (const entry of PROTECTED_FILENAME_PATTERNS) {
    if (entry.pattern.test(basename_)) return entry;
  }
  return null;
}

/**
 * Protected path prefixes for directory-level protection.
 * Files whose .claude/-relative path starts with any prefix are protected.
 * AC-14.9.c: deployment-manifests/ prefix match (~5 lines, no glob dependency).
 * @type {string[]}
 */
const PROTECTED_PATH_PREFIXES = [
  'deployment-manifests/',
];

/**
 * Shell command patterns that indicate a write operation.
 * Used for defense-in-depth Bash tool checking (not exhaustive).
 *
 * sec-cmdinj-a7c21e08: extended to cover additional scripting-language write
 * vectors. Any interpreter that can open files for writing via fs APIs is
 * treated as a destructive candidate when paired with a protected filename
 * reference. Also covers `exec <` (redirect stdin to file) which can be used
 * to truncate a file when combined with `>`.
 *
 * @type {RegExp[]}
 */
const BASH_WRITE_PATTERNS = [
  /\bcp\b/,
  /\bmv\b/,
  /\btee\b/,
  /\bdd\b/,
  /\binstall\b/,
  /\brsync\b/,
  /\bln\b/,
  />/,              // redirect (covers > and >>)
  /\bsed\b.*-i/,   // in-place sed
  /\bchmod\b/,
  /\bchown\b/,
  /\brm\b/,
  /\bunlink\b/,
  /\btouch\b/,
  /\btruncate\b/,   // AC-5.2 (sg-enforcement-layer-gaps): truncate -s 0 sentinel destroys content
  /\bmkdir\b/,      // could create parent dirs for protected files
  /\bcat\b.*>/,     // cat with output redirect
  /\becho\b.*>/,    // echo with output redirect
  /\bprintf\b.*>/,  // printf with output redirect
  /\bnode\b.*-e\b/, // node -e can write files via fs module
  /\bpython\b/,     // python can write files
  // sec-cmdinj-a7c21e08: additional scripting-language write vectors
  /\bperl\b/,       // perl one-liners can open files for write (perl -e 'open ...')
  /\bruby\b/,       // ruby -e 'File.write ...'
  /\bphp\s+-r\b/,   // php -r '...' one-liner
  /\bexec\s+</,     // exec redirect — stdin open to file, paired with > truncates
];

/**
 * Directory (relative to `.claude/`) where each protected filename lives.
 * sec-cmdinj-a7c21e08: Centralizing this lets the realpath inode-match gate
 * apply uniformly to every entry in PROTECTED_FILENAMES, not just the
 * shape-lint sentinel. The Write-branch already had per-file directory
 * context (see `isCoordinationFile`/`isContextFile`/`isAuditFile`/
 * `isScriptsFile` below); this table mirrors that so Bash-branch protection
 * stays in sync without duplication.
 * @type {Record<string, string>}
 */
const PROTECTED_FILE_DIRS = {
  'gate-override.json': 'coordination',
  'gate-enforcement-disabled': 'coordination',
  'shape-lint-disabled': 'coordination',
  'session.json': 'context',
  'session.log': 'context',
  'deployment-interventions.log': 'audit',
  'verify-deployment-audit-chain.mjs': 'scripts',
  // Silent-drop observability REQ-F-011, REQ-F-017, REQ-F-021, REQ-F-023:
  // Each protected silent-drop artifact has a distinct directory. The
  // data-driven lookup below (see Write-branch) dispatches by basename so
  // writes to `.claude/config/silent-drop-enforcement.json` are NOT
  // mis-routed to the `coordination/` fallback (DEC-004 regression guard).
  'silent-drop-enforcement.json': 'config',
  'enforcement-changes.log': 'audit',
  'silent-drop-baseline.json': 'metrics',
  'verify-enforcement-audit-chain.mjs': 'scripts',
  'baseline-sla-recommendation.json': 'metrics',
  // sg-pipeline-efficiency-ws1-convergence-pruning REQ-013 / AC15.2:
  // Mirrors silent-drop-enforcement.json routing — lives at
  // `.claude/config/pipeline-efficiency-enforcement.json`.
  'pipeline-efficiency-enforcement.json': 'config',
  // sg-pipeline-efficiency-ws1-convergence-pruning REQ-014 / AC16.1 / AC16.2:
  // Genesis anchor lives at `.claude/audit/pipeline-efficiency-genesis.json`
  // (alongside other audit-root artifacts). Routes basename to `audit/` dir
  // so Write-branch PROTECTED_FILE_DIRS lookup and Bash-branch
  // buildRealpathProtectedMap sentinel both fire on the correct path.
  'pipeline-efficiency-genesis.json': 'audit',
  // sg-pipeline-efficiency-ws1-convergence-pruning NFR-14 / AC16.2 / AC16.3:
  // Kill-switch sentinel lives at `.claude/coordination/pipeline-efficiency-disabled`.
  // Write AND delete protection required (NFR-14): the delete path is
  // covered by the Bash-branch canonical realpath inode-match + BASH_WRITE_PATTERNS
  // destructive-verb gate (rm / unlink / mv / truncate) which routes through
  // the same PROTECTED_FILE_DIRS mapping via buildRealpathProtectedMap.
  'pipeline-efficiency-disabled': 'coordination',
  'runtime-connectivity-enforcement.json': 'config',
  'rtc-enforcement-changes.log': 'audit',
  'verify-rtc-enforcement-chain.mjs': 'scripts',
};

/**
 * Protected files for which Bash destructive operations must use canonical
 * realpath matching per AC-5.3 / AC-5.6. When a command references one of these
 * names, we also scan the command for candidate path tokens and resolve them
 * to canonical real paths via `isSentinelMatchExecTime` (lib/kill-switch.mjs),
 * blocking on any inode-level match. This protects against symlink-based
 * bypasses that pure substring matching would miss.
 *
 * sec-cmdinj-a7c21e08: Map is now built from PROTECTED_FILE_DIRS so every
 * protected filename (not only shape-lint-disabled) flows through the
 * canonical realpath gate. This closes the asymmetry where e.g.
 * session.log could be bypassed via a symlink where shape-lint-disabled
 * could not.
 *
 * @type {Map<string, string>} Maps basename -> absolute sentinel path.
 *   The sentinel path is resolved at invocation time so this hook continues
 *   to work when the project root moves.
 */
function buildRealpathProtectedMap(claudeDir) {
  const entries = [];
  for (const [basename_, dirSegment] of Object.entries(PROTECTED_FILE_DIRS)) {
    entries.push([basename_, `${claudeDir}${sep}${dirSegment}${sep}${basename_}`]);
  }
  return new Map(entries);
}

/**
 * Extract path-like tokens from a Bash command string. Tokens are split on
 * whitespace and common shell metacharacters; we strip surrounding quotes and
 * redirection operators. This is defense-in-depth — a full shell parser would
 * be overkill here, and the downstream realpath check is fail-safe (mismatch
 * ⇒ no block).
 */
function extractCandidatePathTokens(command) {
  // Split on whitespace AND on shell metacharacters we care about for redirection.
  const rough = command.split(/[\s|&;()<>]+/);
  const tokens = [];
  for (let t of rough) {
    if (!t) continue;
    // Strip leading redirection operators (>/>>/<).
    t = t.replace(/^>>?|^<<?/, '');
    // Strip surrounding quotes.
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      t = t.slice(1, -1);
    }
    if (t.length === 0) continue;
    tokens.push(t);
  }
  return tokens;
}

/**
 * Legacy string-returning classifier. Delegates to the structured classifier
 * in `lib/bash-intent-classifier.mjs`. Preserved as an exported name from
 * this file so existing test consumers
 * (`hook-friction-phase-a-file-protection.test.mjs`,
 * `workflow-file-protection/read-intent-hint.test.mjs`) continue to import
 * `classifyBashCommandIntent` from the hook module without modification
 * (NFR-013 / OQ-7 — test-only backward compat).
 *
 * The primary structured entry point is `classifyBashCommandIntentStructured`
 * (imported above under an alias). All new call sites consume the object
 * shape; only this legacy wrapper preserves the string contract.
 *
 * @param {string} command
 * @returns {'read'|'write'|'ambiguous'}
 */
export function classifyBashCommandIntent(command) {
  return classifyBashCommandIntentString(command);
}

// Re-export the legacy string helper from this module so callers can migrate
// piecewise (NFR-013 / OQ-7).
export { classifyBashCommandIntentString };

/**
 * Structured-classifier-driven detection of Bash writes to protected files.
 *
 * Replaces the legacy substring-scan over-matcher. Flow:
 *   1. Length guard (byte-length > MAX_COMMAND_BYTES) — fail-closed
 *      (handled in the structured classifier; it returns reason=length_exceeded).
 *   2. classifyBashCommandIntentStructured(command) returns
 *      {intent, targets, reason?}.
 *   3. intent='read'       -> no block (return null + emit no telemetry).
 *   4. intent='write'      -> return { classification, firstBasename }
 *                            so caller can apply PPID exemption and block.
 *   5. intent='ambiguous'  -> return { classification, firstBasename } with
 *                            classification.intent='ambiguous'. Caller emits
 *                            HOOK_CLASSIFIER_FAIL_CLOSED stderr telemetry
 *                            and blocks.
 *
 * A supplementary symlink-resolution pass (preserved from sec-cmdinj-a7c21e08)
 * runs AFTER the classifier in the write-intent branch only: if the classifier
 * returns read (no protected basename in the command tokens), we additionally
 * scan candidate path tokens for symlinks that resolve to a protected
 * sentinel. This closes the symlink-bypass hole for commands that name only a
 * non-protected symlink alias. The scan is gated by the legacy
 * BASH_WRITE_PATTERNS regex for performance — it only runs when the command
 * plausibly has a write operator.
 *
 * @param {string} command - The shell command string
 * @param {string} claudeDir - Resolved .claude/ directory path for sentinel lookup
 * @returns {{ firstBasename: string, classification: import('./lib/bash-intent-classifier.mjs').ClassificationResult } | null}
 */
function detectBashWriteToProtectedFile(command, claudeDir) {
  const classification = classifyBashCommandIntentStructured(command);

  if (classification.intent === 'write' && classification.targets.length > 0) {
    return {
      firstBasename: classification.targets[0].basename,
      classification,
    };
  }

  if (classification.intent === 'ambiguous') {
    // Fail-closed path: the classifier already sets `reason`. We do not have
    // a concrete target basename (the classifier could not resolve one); use
    // a sentinel label so the BLOCKED message is still meaningful.
    return {
      firstBasename: '<ambiguous>',
      classification,
    };
  }

  // intent='read' or 'write' with no targets: fall through to symlink scan
  // as defense-in-depth. The scan detects cases the classifier's basename-
  // match alone cannot resolve — e.g., `rm <symlink>` where the symlink
  // aliases a protected file (sec-cmdinj-a7c21e08).
  //
  // Gate the scan so it only runs when the command contains a destructive verb
  // (rm/mv/dd/ln/truncate/chmod/chown) OR a non-stderr-only write redirect.
  // Running the legacy BASH_WRITE_PATTERNS scan unconditionally re-
  // introduced the over-match the classifier was designed to fix: stderr
  // redirects like `2>/dev/null`, `>&2`, `2>&1` share the `>` character
  // with true write redirects, and matched BASH_WRITE_PATTERNS. Classifier
  // correctly returns 'read' for those cases, so we short-circuit the
  // defense-in-depth scan unless a destructive verb is present.
  const DESTRUCTIVE_VERB_RE =
    /(^|[\s;&|(])(rm|rmdir|mv|dd|truncate|ln|chmod|chown)(\s|$)/;
  if (
    classification.intent === 'read' &&
    !DESTRUCTIVE_VERB_RE.test(command)
  ) {
    return null;
  }

  // Only perform the symlink-resolution sweep when the command plausibly
  // performs a write operation (perf gate).
  let hasPossibleWrite = false;
  for (const p of BASH_WRITE_PATTERNS) {
    if (p.test(command)) { hasPossibleWrite = true; break; }
  }
  if (hasPossibleWrite) {
    const realpathProtected = buildRealpathProtectedMap(claudeDir);
    const tokens = extractCandidatePathTokens(command);
    for (const tok of tokens) {
      for (const [basename_, sentinelPath] of realpathProtected) {
        if (!tok.includes('/') && !tok.includes('\\') && tok !== basename_) continue;
        if (!existsSync(tok)) continue;
        try {
          if (isSentinelMatchExecTime(sentinelPath, tok)) {
            return {
              firstBasename: basename_,
              classification: {
                intent: 'write',
                targets: [{ basename: basename_, matchType: 'exact', source: 'positional' }],
              },
            };
          }
          const stat = lstatSync(tok);
          if (stat.isSymbolicLink()) {
            return {
              firstBasename: `${basename_} (symlink)`,
              classification: {
                intent: 'write',
                targets: [{ basename: basename_, matchType: 'exact', source: 'positional' }],
              },
            };
          }
        } catch {
          // Fail-safe — continue scanning.
        }
      }
    }

    // AC-14.9.c: Prefix-based directory protection for Bash commands.
    for (const prefix of PROTECTED_PATH_PREFIXES) {
      if (command.includes(prefix)) {
        return {
          firstBasename: `.claude/${prefix}*`,
          classification: {
            intent: 'write',
            targets: [{ basename: `.claude/${prefix}*`, matchType: 'exact', source: 'positional' }],
          },
        };
      }
    }
  }

  return null;
}

/**
 * Emit a single stderr telemetry line synchronously before a fail-closed exit.
 *
 * Format: `HOOK_CLASSIFIER_FAIL_CLOSED: reason=<r> verb=<v> length=<N>`
 *
 * Emitted from the caller (the hook), not the classifier — preserves the
 * library's pure/stateless invariant (SEC-008). Uses `fs.writeSync(2, ...)`
 * so the line is flushed before `process.exit(2)`.
 *
 * @param {string} reason  parse_failure | ambiguous | bypass_suspected | length_exceeded
 * @param {string} verb    best-effort first verb or 'unknown'
 * @param {number} byteLength byte length of the command
 */
function emitFailClosedTelemetry(reason, verb, byteLength) {
  try {
    const line = `HOOK_CLASSIFIER_FAIL_CLOSED: reason=${reason} verb=${verb || 'unknown'} length=${byteLength}\n`;
    writeSync(2, line);
  } catch {
    // Best-effort; never throw from telemetry.
  }
}

/**
 * Best-effort first-verb extractor for telemetry labeling. Does NOT classify —
 * just returns a short identifier. Tolerant of quote state; returns 'unknown'
 * on failure.
 */
function extractFirstVerbForTelemetry(command) {
  if (typeof command !== 'string') return 'unknown';
  const trimmed = command.trim();
  const m = trimmed.match(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(\S+)/);
  if (!m) return 'unknown';
  const tok = m[1];
  const base = tok.split(/[/\\]/).pop() || tok;
  // Strip quotes
  return base.replace(/^['"]|['"]$/g, '').slice(0, 32) || 'unknown';
}

/**
 * Typed target-to-CLI-remediation mapping. Adding a new protected file that
 * has a canonical writer CLI SHALL also add a mapping entry here — the
 * structural lint test `mapping-completeness.test.mjs` fails otherwise
 * (AC-008.5: completeness-by-construction).
 *
 * Semantics:
 *   - kind='cli'   — file has a dedicated writer CLI. Error names the CLI +
 *                    doc pointer.
 *   - kind='override' — file is an override-only sentinel. Error names the
 *                    override mechanism instead of the generic fallback.
 *   - kind='audit-log' — file is an append-only audit log. Error points to
 *                    the dedicated audit-append CLI.
 *   - unmapped files fall back to the generic `BLOCKED: Protected Enforcement
 *                    File` + doc pointer (AC-008.4).
 *
 * AC-008.6: all emitted errors begin with `BLOCKED:` (log-scraping
 * backward compatibility).
 *
 * @type {Record<string, { kind: string, remediation: string, docSection?: string }>}
 */
const PROTECTED_FILE_REMEDIATION = {
  'session.json': {
    kind: 'cli',
    remediation:
      'Use: node .claude/scripts/session-checkpoint.mjs <subcommand> (see --help for valid operations)',
    docSection: '.claude/docs/WORKFLOW-ENFORCEMENT.md § Session Checkpoint CLI',
  },
  'session.log': {
    kind: 'cli',
    remediation:
      'session.log is a diagnostic log written by convergence-pass-recorder.mjs (SubagentStop hook). Direct writes are FULL_BLOCK; the recorder is the sole writer.',
    docSection: '.claude/docs/HOOKS.md § Convergence Pass Recorder',
  },
  'gate-override.json': {
    kind: 'override',
    remediation:
      'Use: gate-override.json is the phase-scoped override sentinel. Create it via your shell, then use `session-checkpoint.mjs override-skip --phase <p> --rationale "<r>"` to record the audit entry.',
    docSection: '.claude/docs/WORKFLOW-ENFORCEMENT.md § Override Mechanism',
  },
  'gate-enforcement-disabled': {
    kind: 'override',
    remediation:
      'Use: gate-enforcement-disabled is the global kill switch. Toggle via `node .claude/scripts/audit-append.mjs create|remove --rationale "<r>"` so the change is recorded in the tamper-evident audit log.',
    docSection: '.claude/docs/WORKFLOW-ENFORCEMENT.md § Kill Switch',
  },
  'shape-lint-disabled': {
    kind: 'override',
    remediation:
      'Use: shape-lint-disabled is the shape-lint kill switch sentinel. Toggle via your shell (operator action only).',
    docSection: '.claude/docs/HOOKS.md § Shape Lint Hook',
  },
  'deployment-interventions.log': {
    kind: 'audit-log',
    remediation:
      'deployment-interventions.log is an append-only audit log for deployment interventions. Writes go through the chain-verifier / intervention CLI, not direct fs writes.',
    docSection: '.claude/docs/WORKFLOW-ENFORCEMENT.md § Deployment Verification Gate',
  },
  'verify-deployment-audit-chain.mjs': {
    kind: 'cli',
    remediation:
      'verify-deployment-audit-chain.mjs is a trust-root verifier script. Modifications require a human terminal change + review.',
    docSection: '.claude/docs/WORKFLOW-ENFORCEMENT.md § Deployment Verification Gate',
  },
  // Silent-drop observability REQ-F-011 / SC-11 / NFR-3: operator-controlled
  // mode flag; writes must use the atomic-rename pattern (NFR-15) and pass
  // through the coercive-flip preflight. Agent writes are FULL_BLOCK.
  'silent-drop-enforcement.json': {
    kind: 'override',
    remediation:
      'silent-drop-enforcement.json is the operator-controlled enforcement mode flag (advisory/coercive/off). Only the human operator may edit via a signed commit; direct agent writes are REJECTED. See the coercive-flip preflight script before modifying.',
    docSection: '.claude/prds/silent-drop-observability/prd.md § SC-11, NFR-3',
  },
  'enforcement-changes.log': {
    kind: 'audit-log',
    remediation:
      'enforcement-changes.log is the silent-drop enforcement audit log. Direct agent writes are REJECTED; append through the owning audit writer.',
    docSection: '.claude/prds/silent-drop-observability/prd.md § SC-21, NFR-10',
  },
  // Silent-drop observability REQ-F-017 / SC-17: baseline gates the coercive
  // flip (forgeable baseline = forgeable flip approval). Only the
  // maintainer-invoked silent-drop-baseline-sla-monitor.mjs (maintainer
  // identity) or the operator (via signed commit) may publish.
  'silent-drop-baseline.json': {
    kind: 'audit-log',
    remediation:
      'silent-drop-baseline.json is the published baseline that gates the advisory→coercive flip. Only the maintainer-invoked silent-drop-baseline-sla-monitor.mjs or the operator (via signed commit) may publish; direct agent writes are REJECTED.',
    docSection: '.claude/prds/silent-drop-observability/prd.md § SC-17, NFR-3',
  },
  // Silent-drop observability REQ-F-021 / SC-21 / SEC-001-P2: verifier
  // integrity is foundational to the NFR-10 hash chain — an unprotected
  // verifier defeats the entire chain. Modifications require a human terminal
  // change + review.
  'verify-enforcement-audit-chain.mjs': {
    kind: 'cli',
    remediation:
      'verify-enforcement-audit-chain.mjs is the audit-chain integrity verifier. Modifications require a human terminal change + review; direct agent writes are REJECTED (an unprotected verifier defeats the NFR-10 hash chain).',
    docSection: '.claude/prds/silent-drop-observability/prd.md § SC-21, NFR-10',
  },
  // Silent-drop observability REQ-F-023 / SC-23 / SEC-002-P3: recommendation
  // file informs the operator's decision for the coercive flip; an unprotected
  // recommendation is a tampering surface. Only the maintainer-invoked monitor
  // or the operator (via signed commit) may write.
  'baseline-sla-recommendation.json': {
    kind: 'audit-log',
    remediation:
      'baseline-sla-recommendation.json is the SLA recommendation file consumed by the operator. Only the maintainer-invoked silent-drop-baseline-sla-monitor.mjs or the operator (via signed commit) may write; direct agent writes are REJECTED.',
    docSection: '.claude/prds/silent-drop-observability/prd.md § SC-23, NFR-3',
  },
  // sg-pipeline-efficiency-ws1-convergence-pruning REQ-013 / AC15.2:
  // Operator-controlled pipeline-efficiency enforcement mode flag
  // (advisory/coercive/off). Session-scoped overrides are narrowed to
  // {advisory, coercive}; `off` requires a signed commit to the on-disk file.
  'pipeline-efficiency-enforcement.json': {
    kind: 'override',
    remediation:
      'pipeline-efficiency-enforcement.json is the operator-controlled enforcement mode flag (advisory/coercive/off). Only the human operator may edit via a signed commit; direct agent writes are REJECTED. For session-scoped advisory↔coercive flips, use `session-checkpoint.mjs override-enforcement <advisory|coercive>`.',
    docSection: '.claude/specs/groups/sg-pipeline-efficiency-ws1-convergence-pruning/spec.md § REQ-013',
  },
  // sg-pipeline-efficiency-ws1-convergence-pruning REQ-014 / AC16.1 / AC16.2:
  // Hash-chain genesis anchor. Content `{seq: 0, hash, signed_by,
  // previous_genesis_hash}`; tampering collapses the NFR-HASH-CHAIN-VERIFY
  // trust chain. Only the operator may create / modify via signed commit
  // (EDGE-019 carve-out); rotation uses `previous_genesis_hash` linking.
  'pipeline-efficiency-genesis.json': {
    kind: 'audit-log',
    remediation:
      'pipeline-efficiency-genesis.json is the hash-chain genesis anchor for the pipeline-efficiency audit log. Only the human operator may write via `git commit -S`; direct agent writes are REJECTED. An unprotected genesis defeats the entire NFR-HASH-CHAIN-VERIFY trust chain — rotation must preserve `previous_genesis_hash` linking.',
    docSection: '.claude/specs/groups/sg-pipeline-efficiency-ws1-convergence-pruning/spec.md § REQ-014',
  },
  // sg-pipeline-efficiency-ws1-convergence-pruning NFR-14 / AC16.2 / AC16.3 / AC16.5:
  // Kill-switch sentinel. Presence bypasses ALL pipeline-efficiency
  // enforcement (EC-3). Write AND delete protection required — an agent
  // that can create the sentinel silently disables coercive enforcement;
  // an agent that can delete it silently re-enables coercive enforcement
  // the operator intended to suppress. Only signed commits create/delete.
  'pipeline-efficiency-disabled': {
    kind: 'override',
    remediation:
      'pipeline-efficiency-disabled is the kill-switch sentinel for pipeline-efficiency enforcement. Presence bypasses ALL enforcement (NFR-14). Only the human operator may create/delete via `git commit -S`; direct agent writes or deletes are REJECTED. For session-scoped advisory↔coercive flips, use `session-checkpoint.mjs override-enforcement <advisory|coercive>` instead of touching the sentinel.',
    docSection: '.claude/docs/WORKFLOW-ENFORCEMENT.md § Kill Switch',
  },
  'runtime-connectivity-enforcement.json': {
    kind: 'override',
    remediation:
      'runtime-connectivity-enforcement.json is operator-controlled runtime-connectivity enforcement state. Direct agent writes are REJECTED.',
    docSection: '.claude/specs/groups/sg-e2e-enforcement-flag-audit/atomic/as-006-file-protection-extension.md',
  },
  'rtc-enforcement-changes.log': {
    kind: 'audit-log',
    remediation:
      'rtc-enforcement-changes.log is the runtime-connectivity enforcement audit log. Direct agent writes are REJECTED; append through the owning audit path.',
    docSection: '.claude/specs/groups/sg-e2e-enforcement-flag-audit/atomic/as-006-file-protection-extension.md',
  },
  'verify-rtc-enforcement-chain.mjs': {
    kind: 'cli',
    remediation:
      'verify-rtc-enforcement-chain.mjs is a trust-root verifier script. Modifications require human review; direct agent writes are REJECTED.',
    docSection: '.claude/specs/groups/sg-e2e-enforcement-flag-audit/atomic/as-006-file-protection-extension.md',
  },
  // as-019 AC1.3 / DEC-CHK-009: pattern-matched audit log entry. The mapping
  // key is the pattern identifier (`kill-switch-log`) so regex-matched targets
  // resolve to the same remediation regardless of exact basename (base file
  // or any rotated sibling). getProtectedFileRemediation() also accepts raw
  // basenames that match the pattern — see dispatcher below.
  'kill-switch-log': {
    kind: 'audit-log',
    remediation:
      'kill-switch.log.jsonl (+ rotated siblings) is the kill-switch audit trail. Only `node .claude/scripts/audit-append.mjs` may write; direct writes via node/sed/tee/etc. are REJECTED.',
    docSection: '.claude/docs/WORKFLOW-ENFORCEMENT.md § Kill Switch Audit Log',
  },
  // sec-input-3b4c8f21: rate-limit state file. Persistent token bucket for the
  // audit-append CLI (see audit-append.mjs loadRateLimitState). Agent writes
  // are REJECTED; only the audit-append CLI (via PPID attestation) may modify.
  'rate-limit-state': {
    kind: 'audit-log',
    remediation:
      'rate-limit.state is the persistent rate-limit bucket for audit-append.mjs. Only `node .claude/scripts/audit-append.mjs` may write; forging this file collapses the rate limiter.',
    docSection: '.claude/docs/WORKFLOW-ENFORCEMENT.md § Kill Switch Audit Log',
  },
  // sg-pipeline-efficiency-ws2-practice-2.4 / SEC-WS2-001: per-session HMAC
  // secret file (`.claude/coordination/.session-hmac-<session-id>`). Bootstrapped
  // with O_EXCL + mode 0600 by session-checkpoint.mjs; agent writes (Bash/Write)
  // are FULL_BLOCK so a hostile dispatch cannot forge a secret to mint
  // test-writer-unlock markers. The file is session-scoped and regenerated on
  // first read of a new session-id.
  'session-hmac-secret': {
    kind: 'override',
    remediation:
      '.session-hmac-<session-id> is a per-session HMAC secret used to sign test-writer-unlock markers. Bootstrapped automatically by session-checkpoint.mjs on first use (O_EXCL + mode 0600); direct agent writes are REJECTED (forging this file enables test-writer-unlock marker spoofing).',
    docSection: '.claude/specs/groups/sg-pipeline-efficiency-ws2-practice-2.4/spec.md § REQ-005',
  },
};

/**
 * Look up the remediation record for a protected filename. Returns null for
 * unmapped files (triggers the generic-fallback error message in AC-008.4).
 *
 * as-019 AC1.3: When the input basename matches a PROTECTED_FILENAME_PATTERN
 * (e.g., `kill-switch.log.5.jsonl`), resolve it to the pattern's remediation
 * entry (`kill-switch-log`). This guarantees a regex-matched target receives
 * the same error shape as the exact-name case.
 *
 * Exported for test consumption (mapping-completeness lint).
 */
export function getProtectedFileRemediation(protectedName) {
  if (PROTECTED_FILE_REMEDIATION[protectedName]) {
    return PROTECTED_FILE_REMEDIATION[protectedName];
  }
  const patEntry = matchProtectedPattern(protectedName);
  if (patEntry && PROTECTED_FILE_REMEDIATION[patEntry.patternId]) {
    return PROTECTED_FILE_REMEDIATION[patEntry.patternId];
  }
  return null;
}

/**
 * Enumerate the keys of the mapping — used by the mapping-completeness lint
 * to assert a 1:1 relationship with PROTECTED_FILENAMES.
 *
 * as-019: pattern-identifier keys (e.g., `kill-switch-log`) are EXCLUDED from
 * this enumeration because they are not basenames — they represent a regex
 * target that matches multiple basenames. The lint treats patterns separately.
 */
export function listMappedProtectedFiles() {
  const patternIds = new Set(PROTECTED_FILENAME_PATTERNS.map(p => p.patternId));
  return Object.keys(PROTECTED_FILE_REMEDIATION).filter(k => !patternIds.has(k));
}

/**
 * Expose the PROTECTED_FILENAMES list for lint tests.
 */
export function listProtectedFilenames() {
  return [...PROTECTED_FILENAMES];
}

/**
 * Block a tool invocation with a descriptive error message.
 *
 * Protected-file block message contract:
 *   - Mapped files -> `BLOCKED: <file>. Use: <CLI>. See: <doc>` (AC-008.2)
 *   - Override-only -> name the override mechanism (AC-008.3)
 *   - Unmapped -> generic `BLOCKED: Protected Enforcement File` + See doc (AC-008.4)
 *   - All paths preserve the `BLOCKED:` prefix (AC-008.6)
 *
 * Exported for unit test coverage; called by main() on detection.
 *
 * @param {string} protectedName - The protected file that was targeted
 * @param {string} toolName - The tool that was used (Write, Bash, etc.)
 * @param {{ readIntent?: boolean, exit?: boolean }} [opts]
 *   readIntent - see as-007; when true, append a "read-only usage detected"
 *                hint (write block remains active per AC-008.7 / SEC-001).
 *   exit - when false, return the assembled message instead of calling
 *          process.exit(2). Default true. Used by tests only.
 */
export function blockProtectedFileWrite(protectedName, toolName, opts = {}) {
  const { exit = true, readIntent = false } = opts;
  const remediation = getProtectedFileRemediation(protectedName);
  const lines = [];
  lines.push('');
  lines.push('========================================');
  // AC-008.6: BLOCKED: prefix on EVERY path (mapped + unmapped).
  if (remediation) {
    lines.push(`BLOCKED: Protected Enforcement File: ${protectedName}`);
  } else {
    lines.push('BLOCKED: Protected Enforcement File');
  }
  lines.push('========================================');
  lines.push('');
  lines.push(`Cannot write to '${protectedName}' via ${toolName} -- this file is protected.`);
  if (remediation) {
    lines.push(remediation.remediation);
    if (remediation.docSection) {
      lines.push(`See: ${remediation.docSection}`);
    }
  } else {
    lines.push('Only human terminal writes are permitted for enforcement files.');
    lines.push('See: .claude/docs/WORKFLOW-ENFORCEMENT.md');
  }
  if (readIntent) {
    // as-007 AC-008.7: appended only when intent classifier returns read.
    // Write block stays active (SEC-001); hint is advisory.
    lines.push('');
    lines.push(
      'Note: read-only usage detected. If this Bash command was intended to READ ' +
        'the file only, consider: `cat <path>` piped to stdout, `jq` without write ' +
        'flags, or the file-viewer tool. The write block remains active regardless.'
    );
  }
  lines.push('');
  lines.push('========================================');
  lines.push('');
  const message = lines.join('\n');
  if (exit) {
    process.stderr.write(message);
    process.exit(2);
  }
  return message;
}

async function main() {
  try {
    // Read and parse stdin
    const stdinContent = await readStdin();

    if (!stdinContent.trim()) {
      process.exit(0);
    }

    let inputData;
    try {
      inputData = JSON.parse(stdinContent);
    } catch {
      process.exit(0); // Malformed input -- fail-open
    }

    const toolName = inputData.tool_name || '';
    const toolInput = inputData.tool_input || {};

    // as-019 AC1.2 / sec-authz-e7f3a12d: dedicated audit-append CLI exemption.
    // PPID attestation replaces the prior env-marker check
    // (`AUDIT_APPEND_AUTHORIZED=1`) which was trust-on-env and could be spoofed
    // by an agent prefixing the var in a Bash command. Now the hook resolves
    // its parent process argv and requires a token with basename
    // `audit-append.mjs`. See isCalledByAuditAppendCli() for platform-specific
    // details. Fail-closed: platform read failures return false.
    //
    // Computed lazily (only consulted when a protected-pattern write is
    // detected) to avoid per-invocation ps / /proc overhead on the common path.
    let auditAppendAuthorizedCache = null;
    function auditAppendAuthorized() {
      if (auditAppendAuthorizedCache === null) {
        auditAppendAuthorizedCache = isCalledByAuditAppendCli();
      }
      return auditAppendAuthorizedCache;
    }

    // Resolve project's .claude dir via the canonicalizer (as-012 / REQ-003.6).
    // getCanonicalProjectDir() realpath-resolves CLAUDE_PROJECT_DIR and asserts
    // repo-root containment to defeat symlink traversal.
    //
    // cr-quality-f4a71c22: STRENGTHENED error handling around SEC-003 containment.
    // Prior behavior fell back to `cwd/.claude` unconditionally on any
    // CanonicalProjectDirError, which an attacker could steer by invoking the
    // hook from a controlled working directory — bypassing SEC-003 inode
    // checks. The replacement behavior:
    //
    //   1) Canonicalizer succeeds → use its result (strongest path).
    //   2) CLAUDE_PROJECT_DIR unset BUT `cwd/.claude` exists as a real dir →
    //      use cwd/.claude and emit a WARN (legacy test-harness compat path —
    //      the cwd is implicitly trust-rooted because vitest invokes the hook
    //      from the real repo root; an attacker cannot manipulate vitest cwd).
    //   3) Canonicalizer fails AND no plausible cwd fallback exists → FAIL-CLOSED
    //      exit 2 with diagnostic. This is the path that would previously have
    //      let an attacker-controlled cwd be trusted.
    //
    // Rationale for the narrow fallback in (2): the SEC-003 attack requires an
    // attacker to choose cwd. Tests and real sessions invoke from a known
    // directory that genuinely owns .claude/. Validating that .claude/ exists
    // under cwd is a cheap integrity check that distinguishes "unset env in a
    // legitimate invocation" from "adversarially chosen cwd pointing at an
    // unrelated tree without a .claude directory".
    let claudeDir;
    let claudeDirFromFallback = false;
    try {
      const projectRoot = getCanonicalProjectDir();
      claudeDir = `${projectRoot}${sep}.claude`;
    } catch (err) {
      if (!(err instanceof CanonicalProjectDirError)) throw err;
      const cwdClaude = `${process.cwd()}${sep}.claude`;
      if (existsSync(cwdClaude)) {
        // Path (2): legacy fallback with integrity check. Silent — many
        // test-harness invocations land here and the behavior is safe
        // (attacker cannot control vitest cwd).
        claudeDir = cwdClaude;
        claudeDirFromFallback = true;
      } else {
        // Path (3): fail-CLOSED with diagnostic. No plausible trust root
        // can be derived; refuse the write to preserve SEC-003.
        process.stderr.write(
          `[workflow-file-protection] BLOCKED: canonical project dir unresolved (${err.message}) ` +
            `and cwd (${process.cwd()}) contains no .claude/ directory. ` +
            `Refusing write to preserve SEC-003 containment. ` +
            `Fix: set CLAUDE_PROJECT_DIR to the repo root.\n`
        );
        process.exit(2);
      }
    }
    // Advisory breadcrumb for observability; emitted only when the fallback
    // fires AND the current tool invocation is about to touch a .claude/
    // pathway (where the trust root actually matters).
    void claudeDirFromFallback;

    // --- Bash tool handling (defense in depth) ---
    if (toolName === 'Bash') {
      const command = toolInput.command;
      if (!command || typeof command !== 'string') {
        process.exit(0); // No command -- fail-open
      }

      // Structured-classifier-driven detection. Returns
      // { firstBasename, classification } on protected-write detection OR
      // ambiguous fail-closed; null on read-intent pass-through.
      const detected = detectBashWriteToProtectedFile(command, claudeDir);
      if (detected) {
        const { firstBasename, classification } = detected;

        // Fail-closed (ambiguous) path: emit telemetry + BLOCK (T-07, NFR-004).
        if (classification.intent === 'ambiguous') {
          emitFailClosedTelemetry(
            classification.reason || 'ambiguous',
            extractFirstVerbForTelemetry(command),
            Buffer.byteLength(command, 'utf8')
          );
          blockProtectedFileWrite(firstBasename, 'Bash', { readIntent: false });
        }

        // PPID exemption with mixed exact+pattern denial.
        //   exempt = ppidAttestationPass && targets.every(t => t.matchType === 'pattern')
        // Any exact-match target in the array denies the exemption for ALL
        // targets regardless of PPID attestation.
        const allPattern =
          classification.targets.length > 0 &&
          classification.targets.every(t => t.matchType === 'pattern');
        if (allPattern && auditAppendAuthorized()) {
          process.exit(0);
        }

        // Intent=write, non-exempt -> BLOCK. No read-intent hint (classifier
        // already determined this is a write; the hint is only relevant when
        // the hook's own classifier-overload disagrees, which no longer
        // happens under the structured classifier — Write-intent is always
        // non-read).
        blockProtectedFileWrite(firstBasename, 'Bash', { readIntent: false });
      }

      // No protected file reference detected in Bash command
      process.exit(0);
    }

    // --- Write tool handling (original logic) ---
    const filePath = toolInput.file_path;

    if (!filePath || typeof filePath !== 'string') {
      process.exit(0); // No file path -- fail-open
    }

    // Check if the target file is a protected enforcement file
    // Security fix H1: normalize path to prevent traversal bypasses
    // M3 fix: resolve symlinks before prefix comparison to prevent symlink-based bypass.
    // Falls back to resolve() if file doesn't exist yet (realpathSync requires existing path).
    let normalizedPath;
    try {
      normalizedPath = realpathSync(resolve(filePath));
    } catch {
      normalizedPath = resolve(filePath);
    }
    const fileName = basename(normalizedPath);

    // sg-pipeline-efficiency-ws3-orchestrator-hygiene / as-008 / AC8.1:
    // Worktree-canon check BEFORE the FULL_BLOCK basename loop. Rejects
    // writes that resolve outside the pinned worktree root with reason
    // `path-escape` (or `symlink-component` when any ancestor is a symlink).
    //
    // Legacy-session guard: loadProjectDirPin() returns null when the session
    // was started before as-006 shipped (no project_dir_pin field) OR when
    // session.json is absent/malformed. We treat null as "no enforcement" and
    // fall through to the existing protected-basename checks below. This is
    // additive-only — no existing session is blocked by this new rule.
    //
    // Audit trail: on rejection we emit a `worktree_path_violation` event
    // class entry to the pipeline-efficiency audit log (best-effort; the
    // enforcement path is NOT gated on audit-log availability).
    const { pin: projectDirPin, session: sessionState } = loadProjectDirPin();
    if (projectDirPin) {
      const violation = checkWorktreePathViolation(
        normalizedPath,
        projectDirPin,
        { session: sessionState }
      );
      if (violation) {
        // Audit entry — best-effort, silent on failure (enforcement wins).
        // Fire-and-forget via void so we emit the violation + exit without
        // awaiting the audit write. The audit-append runs synchronously
        // (fs.openSync + fs.writeSync) so the entry lands before exit when
        // the genesis anchor is present.
        void appendWorktreeAuditEntry(
          violation.reason,
          {
            attempted_path: violation.attempted_path,
            pinned_root: violation.pinned_root,
            consumer: 'workflow-file-protection.mjs',
            tool_name: 'Write',
          }
        );
        const msg =
          '\n========================================\n' +
          `BLOCKED: ${WORKTREE_PATH_VIOLATION}: ${violation.reason}\n` +
          '========================================\n\n' +
          `Target path ${violation.attempted_path} resolves outside the ` +
          `session-pinned worktree root ${violation.pinned_root}.\n` +
          `Reason: ${violation.reason} (exit ${violation.exit_code}).\n\n` +
          'See: .claude/specs/groups/sg-pipeline-efficiency-ws3-orchestrator-hygiene/' +
          'spec.md § Interfaces & Contracts › Worktree Canonicalization Contract\n\n' +
          '========================================\n\n';
        process.stderr.write(msg);
        process.exit(violation.exit_code);
      }
    }

    for (const protectedName of PROTECTED_FILENAMES) {
      // Silent-drop observability DEC-004: data-driven directory dispatch.
      // Previously an if/else chain with `else { isProtectedPath = isCoordinationFile }`
      // which silently mis-routed `.claude/config/*.json` and
      // `.claude/metrics/*.json` writes into the coordination branch,
      // defeating NFR-3 when new protected entries landed under non-coordination
      // directories. The PROTECTED_FILE_DIRS map is now the single source of
      // truth for both Bash and Write branches.
      //
      // Unknown entries (missing from PROTECTED_FILE_DIRS) fall back to the
      // legacy coordination/ check to preserve backward compatibility for any
      // older protected basename not yet migrated.
      const expectedDir = PROTECTED_FILE_DIRS[protectedName];
      let isProtectedPath = false;
      if (expectedDir) {
        // Directory-explicit entries: path must contain /<dir>/ segment.
        isProtectedPath = normalizedPath.includes(sep + expectedDir + sep);
      } else {
        // Backward-compat fallback for legacy entries not in the map.
        isProtectedPath = normalizedPath.includes(sep + 'coordination' + sep);
      }

      if (fileName === protectedName && isProtectedPath) {
        // AC-3.1, AC-3.2, AC-14.9, AC-11.2/4/5, AC-17.2, AC-21.2, AC-23.2:
        // Block the write
        blockProtectedFileWrite(protectedName, 'Write');
      }
    }

    // as-019 AC1.1 / DEC-CHK-009 / sec-authz-e7f3a12d: PROTECTED_FILENAME_PATTERNS
    // union check for Write tool. Pattern-matched basenames (audit log + rotated
    // siblings) are blocked unless the audit-append CLI is the caller (PPID
    // attestation, not env-marker).
    const patEntry = matchProtectedPattern(fileName);
    if (patEntry) {
      const expectedDirMarker = sep + patEntry.dirSegment + sep;
      const pathRouted = normalizedPath.includes(expectedDirMarker);
      if (pathRouted) {
        if (!auditAppendAuthorized()) {
          blockProtectedFileWrite(fileName, 'Write');
        }
      }
    }

    // AC-14.9.c: Prefix-based directory protection for deployment-manifests/
    //
    // The .claude/-relative path is computed from the canonical claudeDir
    // anchor (set via getCanonicalProjectDir() above). A prior implementation
    // used `normalizedPath.indexOf(sep + '.claude' + sep)` which silently
    // matched the wrong segment on paths containing `.claude/` more than
    // once (e.g., git worktrees at `.claude/worktrees/<ws>/.claude/...`); the
    // first match points at the outer worktree ancestor instead of the
    // project-owned `.claude/` and the prefix check fails. Anchoring on the
    // canonical `claudeDir` avoids that ambiguity and matches the
    // PROTECTED_FILE_DIRS/PATTERN_DIRS logic above.
    const claudePrefix = claudeDir + sep;
    if (normalizedPath.startsWith(claudePrefix)) {
      const relativePath = normalizedPath.substring(claudePrefix.length);
      for (const prefix of PROTECTED_PATH_PREFIXES) {
        if (relativePath.startsWith(prefix)) {
          blockProtectedFileWrite(`.claude/${prefix}*`, 'Write');
        }
      }
    }

    // AC-3.3: Not a protected file -- allow
    process.exit(0);
  } catch (err) {
    // Fail-open on any error
    process.stderr.write(`Error in workflow-file-protection hook: ${err.message}\n`);
    process.exit(0);
  }
}

main();
