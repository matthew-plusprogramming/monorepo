#!/usr/bin/env node

/**
 * verify-audit-chain.mjs — hash-chain verifier for the pipeline-efficiency
 * audit log (REQ-014 / NFR-HASH-CHAIN-VERIFY).
 *
 * Walks `.claude/audit/pipeline-efficiency-genesis.json` (seq=0 anchor) →
 * `.claude/audit/pipeline-efficiency-changes.log` (JSONL; seq 1..N) end-to-
 * end, enforcing:
 *
 *   1. Genesis anchor exists, is well-formed JSON, and matches the REQ-014
 *      shape `{seq:0, hash:<sha256-hex>, signed_by:string, previous_genesis_hash:string|null}`.
 *   2. Genesis commit is signed (via `git verify-commit` on the genesis-
 *      file's introducing commit). Absent / unsigned / mis-signed → distinct
 *      `GENESIS_SIGNATURE_INVALID` code (operator-authorization semantics per
 *      NFR-6 / spec.md:671).
 *   3. For each log entry:
 *        - `seq` is monotonic +1 starting at 1.
 *        - `prev_hash[1]` equals `genesis.hash`.
 *        - `prev_hash[N≥2]` equals SHA-256(canonicalJSON(entry[N-1])) — the
 *          byte-for-byte same canonical form used by the appender at
 *          `pipeline-efficiency-audit-log.mjs:401`.
 *        - Entry hash recomputed (defensive) and compared against the
 *          hash used as prev_hash for the next entry.
 *   4. GIVEN `--include-rotations`, WHEN a rotation genesis is encountered,
 *      THEN `previous_genesis_hash` linking is verified back to the prior
 *      chain's HEAD.
 *
 * Wire contract (see `.claude/scripts/lib/snapshot-capture.mjs:157-178, 289`):
 *   Consumers interpret exit code + stderr JSON. On any structured error the
 *   script emits a single-line JSON object to stderr of the form
 *       {"event":"audit_chain_verification_failed",
 *        "error_code":"CHAIN_BROKEN" | "GENESIS_ANCHOR_INVALID" | "GENESIS_SIGNATURE_INVALID",
 *        "result":"FAIL",
 *        "timestamp":"<iso-8601-utc>",
 *        "broken_seq": <number> | null,
 *        "detail": "<human string>",
 *        "genesis_path": "<path>",
 *        "log_path": "<path>"}
 *   and exits 2 (AC18.6). On success the script emits an analogous
 *   `audit_chain_verified` / `result:"PASS"` line and exits 0.
 *
 *   Exit-code map matches as-006 / `verifyGenesisAnchor()` expectations:
 *     exit 0                              → consumer treats as ok
 *     exit 2 + error_code=CHAIN_BROKEN    → merge blocked (REQ-014 spec.md:188)
 *     exit 2 + error_code=GENESIS_*       → completion-verifier fails OR
 *                                           threshold_snapshot fallback
 *                                           (REQ-014 spec.md:189-194)
 *
 * Quarantine path:
 *   On GENESIS_SIGNATURE_INVALID the consumer is responsible for writing a
 *   quarantine file at `.claude/audit/pipeline-efficiency-genesis-quarantine.json`
 *   (EDGE-020; out-of-scope for this script per as-018 Scope line 42). The
 *   verifier only DETECTS the signature-invalid condition; it does not mutate
 *   the filesystem.
 *
 * Usage:
 *   node .claude/scripts/verify-audit-chain.mjs
 *     [--include-rotations]          # walk previous_genesis_hash rotations
 *     [--genesis <path>]             # override genesis path (default: REQ-014 canonical)
 *     [--log <path>]                 # override log path (default: canonical)
 *     [--skip-signature]             # skip `git verify-commit` (tests/CI
 *                                    #  without signing keys). Off-by-default.
 *     [--json]                       # also emit a single-line JSON PASS/FAIL
 *                                    #  on stdout (subprocess consumers).
 *
 * Triggers (per NFR-HASH-CHAIN-VERIFY context section, spec.md:600-606):
 *   - completion-verifier gate (as-022 F4)
 *   - every baseline-publication gate trip
 *   - session-start advisory (as-006, via spawn-first dispatcher)
 *   - on-demand
 *
 * Spec: sg-pipeline-efficiency-ws1-convergence-pruning / as-018
 * Requirements: REQ-014
 * Parent: spec.md §Phase E Task E5, §Flow 5, §Contract NFR-HASH-CHAIN-VERIFY
 */

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJSON } from './lib/audit-chain.mjs';

// =============================================================================
// Constants
// =============================================================================

/**
 * Canonical genesis anchor path (REQ-014, spec.md:185).
 * Relative to the project root (cwd or CLAUDE_PROJECT_DIR).
 */
const DEFAULT_GENESIS_RELATIVE_PATH =
  '.claude/audit/pipeline-efficiency-genesis.json';

/**
 * Canonical audit-log path. Matches the appender at
 * `pipeline-efficiency-audit-log.mjs:66-67`.
 */
const DEFAULT_LOG_RELATIVE_PATH =
  '.claude/audit/pipeline-efficiency-changes.log';

/** 64 lowercase hex chars = SHA-256 digest. Defensive regex; matches schema. */
const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;

/** Structured error codes (REQ-014 verbatim; spec.md:608-610). */
const CHAIN_BROKEN = 'CHAIN_BROKEN';
const GENESIS_ANCHOR_INVALID = 'GENESIS_ANCHOR_INVALID';
const GENESIS_SIGNATURE_INVALID = 'GENESIS_SIGNATURE_INVALID';

/** Exit codes (AC18.6). */
const EXIT_OK = 0;
const EXIT_STRUCTURED_ERROR = 2;

/**
 * `git verify-commit` spawn timeout (ms). Verification at session-start /
 * completion-verifier must not hang the caller; a timeout is treated as
 * GENESIS_SIGNATURE_INVALID (advisory callers can then surface / fall back).
 */
const GIT_VERIFY_TIMEOUT_MS = 5000;

// =============================================================================
// Structured-error helpers
// =============================================================================

/**
 * Carry verifier failure context from deep in the walk up to main() without
 * throwing through hot-path loops.
 */
class ChainVerificationError extends Error {
  /**
   * @param {'CHAIN_BROKEN' | 'GENESIS_ANCHOR_INVALID' | 'GENESIS_SIGNATURE_INVALID'} code
   * @param {string} detail
   * @param {{ broken_seq?: number | null }} [ctx]
   */
  constructor(code, detail, ctx = {}) {
    super(detail);
    this.name = 'ChainVerificationError';
    this.code = code;
    this.broken_seq =
      typeof ctx.broken_seq === 'number' ? ctx.broken_seq : null;
  }
}

/**
 * Emit the standard stderr JSON envelope then exit.
 *
 * @param {'PASS' | 'FAIL'} result
 * @param {object} fields — merged into envelope (error_code, detail, paths, etc.)
 * @param {number} exitCode
 */
function emitAndExit(result, fields, exitCode, emitStdoutJson = false) {
  const envelope = {
    event:
      result === 'PASS'
        ? 'audit_chain_verified'
        : 'audit_chain_verification_failed',
    result,
    timestamp: new Date().toISOString(),
    ...fields,
  };
  const line = JSON.stringify(envelope) + '\n';
  process.stderr.write(line);
  if (emitStdoutJson) {
    process.stdout.write(line);
  }
  process.exit(exitCode);
}

// =============================================================================
// Genesis-anchor parsing (AC18.1, AC18.5)
// =============================================================================

/**
 * Load and structurally validate the genesis anchor.
 *
 * Shape per REQ-014 (spec.md §Contract NFR-HASH-CHAIN-VERIFY, context block):
 *   { seq: 0,
 *     hash: <sha256-hex>,
 *     signed_by: <string>,
 *     previous_genesis_hash: string | null }
 *
 * @param {string} genesisPath — absolute path to genesis anchor
 * @returns {{seq: 0, hash: string, signed_by: string, previous_genesis_hash: string | null}}
 * @throws {ChainVerificationError} GENESIS_ANCHOR_INVALID
 */
function readGenesisAnchor(genesisPath) {
  if (!existsSync(genesisPath)) {
    throw new ChainVerificationError(
      GENESIS_ANCHOR_INVALID,
      `genesis anchor missing at ${genesisPath}`
    );
  }

  let raw;
  try {
    raw = readFileSync(genesisPath, 'utf-8');
  } catch (err) {
    throw new ChainVerificationError(
      GENESIS_ANCHOR_INVALID,
      `cannot read genesis anchor: ${err?.message || String(err)}`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ChainVerificationError(
      GENESIS_ANCHOR_INVALID,
      `genesis anchor not valid JSON: ${err?.message || String(err)}`
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ChainVerificationError(
      GENESIS_ANCHOR_INVALID,
      'genesis anchor is not a JSON object'
    );
  }

  if (parsed.seq !== 0) {
    throw new ChainVerificationError(
      GENESIS_ANCHOR_INVALID,
      `genesis.seq expected 0, got ${JSON.stringify(parsed.seq)}`
    );
  }

  if (typeof parsed.hash !== 'string' || !SHA256_HEX_REGEX.test(parsed.hash)) {
    throw new ChainVerificationError(
      GENESIS_ANCHOR_INVALID,
      'genesis.hash must be 64-char lowercase hex SHA-256'
    );
  }

  if (typeof parsed.signed_by !== 'string' || parsed.signed_by.length === 0) {
    throw new ChainVerificationError(
      GENESIS_ANCHOR_INVALID,
      'genesis.signed_by must be non-empty string'
    );
  }

  if (
    parsed.previous_genesis_hash !== null &&
    (typeof parsed.previous_genesis_hash !== 'string' ||
      !SHA256_HEX_REGEX.test(parsed.previous_genesis_hash))
  ) {
    throw new ChainVerificationError(
      GENESIS_ANCHOR_INVALID,
      'genesis.previous_genesis_hash must be null or 64-char hex SHA-256'
    );
  }

  return parsed;
}

// =============================================================================
// Genesis-commit signature verification (AC18.2)
// =============================================================================

/**
 * Determine the git commit SHA that introduced the genesis anchor file, then
 * assert `git verify-commit` reports a valid signature for that SHA.
 *
 * Two-step (instead of a single `git log --show-signature`) so signature-
 * verification failures are distinguishable from genesis-not-yet-committed
 * failures; the former maps to GENESIS_SIGNATURE_INVALID, the latter to
 * GENESIS_ANCHOR_INVALID (genesis may exist in the working tree but not yet
 * be committed in test harnesses).
 *
 * Operator-only signing: `git verify-commit` relies on the local GPG / SSH
 * allowed-signers store. In environments lacking either (CI without a signing
 * key configured, sandbox tests), callers should pass `--skip-signature`.
 *
 * @param {string} genesisPath — absolute path to the genesis file
 * @param {string} projectRoot — git repo root
 * @returns {{ sha: string }} commit SHA whose signature was verified
 * @throws {ChainVerificationError}
 *   GENESIS_ANCHOR_INVALID   — file not tracked by git / no commit history
 *   GENESIS_SIGNATURE_INVALID — git verify-commit rejected the signature
 */
function verifyGenesisSignature(genesisPath, projectRoot) {
  // Locate the introducing commit. `git log -n 1 --format=%H -- <file>` prints
  // the most-recent commit that touches the file; `--diff-filter=A` would
  // restrict to additions only, but operators may re-sign via amend + force
  // commit, so HEAD-touching commit is the authoritative anchor.
  const logResult = spawnSync(
    'git',
    ['-C', projectRoot, 'log', '-n', '1', '--format=%H', '--', genesisPath],
    { encoding: 'utf-8', timeout: GIT_VERIFY_TIMEOUT_MS }
  );

  if (logResult.error) {
    throw new ChainVerificationError(
      GENESIS_ANCHOR_INVALID,
      `git log spawn failed for genesis path: ${logResult.error.message}`
    );
  }
  if (logResult.status !== 0) {
    // Not a git repo, or genesis not tracked yet.
    const stderr = (logResult.stderr || '').trim();
    throw new ChainVerificationError(
      GENESIS_ANCHOR_INVALID,
      `git log exit ${logResult.status} for genesis: ${stderr || '<no stderr>'}`
    );
  }

  const sha = (logResult.stdout || '').trim();
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new ChainVerificationError(
      GENESIS_ANCHOR_INVALID,
      `no commit found for genesis file (stdout=${JSON.stringify(sha)})`
    );
  }

  // Verify signature on that commit.
  const verifyResult = spawnSync(
    'git',
    ['-C', projectRoot, 'verify-commit', sha],
    { encoding: 'utf-8', timeout: GIT_VERIFY_TIMEOUT_MS }
  );

  if (verifyResult.error) {
    throw new ChainVerificationError(
      GENESIS_SIGNATURE_INVALID,
      `git verify-commit spawn failed: ${verifyResult.error.message}`
    );
  }
  if (verifyResult.status !== 0) {
    const stderr = (verifyResult.stderr || '').trim();
    throw new ChainVerificationError(
      GENESIS_SIGNATURE_INVALID,
      `git verify-commit exit ${verifyResult.status} for ${sha}: ${stderr || '<no stderr>'}`
    );
  }

  return { sha };
}

// =============================================================================
// Log-entry parsing + chain walk (AC18.3)
// =============================================================================

/**
 * Read the audit log as an array of parsed entries.
 *
 * An absent or empty log is VALID — it means zero events have been appended
 * since genesis (bootstrap state). Chain verification still succeeds; the
 * walk simply returns genesis.hash as the running-HEAD hash.
 *
 * @param {string} logPath
 * @returns {Array<Record<string, unknown>>}
 * @throws {ChainVerificationError} CHAIN_BROKEN — malformed JSON line
 */
function readLogEntries(logPath) {
  if (!existsSync(logPath)) {
    return [];
  }

  let raw;
  try {
    raw = readFileSync(logPath, 'utf-8');
  } catch (err) {
    throw new ChainVerificationError(
      CHAIN_BROKEN,
      `cannot read log file ${logPath}: ${err?.message || String(err)}`
    );
  }

  if (raw.length === 0) {
    return [];
  }

  const lines = raw.split('\n').filter((l) => l.length > 0);
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      entries.push(JSON.parse(lines[i]));
    } catch (err) {
      throw new ChainVerificationError(
        CHAIN_BROKEN,
        `log line ${i + 1} is not valid JSON: ${err?.message || String(err)}`,
        { broken_seq: i + 1 }
      );
    }
  }
  return entries;
}

/**
 * Walk the chain: enforce monotonic seq, prev_hash linking, and entry shape.
 *
 * Appender linkage contract (see `pipeline-efficiency-audit-log.mjs:232-235,
 * 400-402`):
 *   prev_hash[1]   = genesis.hash
 *   prev_hash[N+1] = SHA-256(canonicalJSON(entry[N]))
 *
 * Therefore our running-HEAD computation MUST use the exact same
 * canonicalization — hence the shared `canonicalJSON` import. Any drift
 * between writer and verifier canonicalizers would produce false-positive
 * CHAIN_BROKEN reports on every entry.
 *
 * @param {string} startHash — genesis.hash (seeds prev_hash for seq=1)
 * @param {Array<Record<string, unknown>>} entries
 * @returns {{ headHash: string, entryCount: number }}
 *   headHash = SHA-256(canonicalJSON(last entry)) — suitable for rotation
 *   linking. For an empty log, headHash = startHash (genesis.hash).
 * @throws {ChainVerificationError} CHAIN_BROKEN
 */
function walkChain(startHash, entries) {
  let runningHeadHash = startHash;
  let expectedSeq = 1;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const lineNumber = i + 1; // 1-indexed for stderr ergonomics

    // Shape preflight (mirrors appender's `deriveChainHeadFromLine` at
    // pipeline-efficiency-audit-log.mjs:208-231 — structural checks without
    // full Zod; the goal here is chain integrity, not schema re-validation
    // which is the appender's job).
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ChainVerificationError(
        CHAIN_BROKEN,
        `log entry ${lineNumber} is not a JSON object`,
        { broken_seq: lineNumber }
      );
    }
    if (
      typeof entry.seq !== 'number' ||
      !Number.isInteger(entry.seq) ||
      entry.seq < 1
    ) {
      throw new ChainVerificationError(
        CHAIN_BROKEN,
        `log entry ${lineNumber} missing integer seq ≥ 1 (got ${JSON.stringify(entry.seq)})`,
        { broken_seq: lineNumber }
      );
    }
    if (typeof entry.prev_hash !== 'string') {
      throw new ChainVerificationError(
        CHAIN_BROKEN,
        `log entry seq=${entry.seq} prev_hash must be string`,
        { broken_seq: entry.seq }
      );
    }

    // AC18.3 (monotonic +1). Genesis is seq=0; first log entry is seq=1.
    if (entry.seq !== expectedSeq) {
      throw new ChainVerificationError(
        CHAIN_BROKEN,
        `seq gap at line ${lineNumber}: expected ${expectedSeq}, got ${entry.seq}`,
        { broken_seq: entry.seq }
      );
    }

    // AC18.3 (prev_hash linkage).
    if (entry.prev_hash !== runningHeadHash) {
      throw new ChainVerificationError(
        CHAIN_BROKEN,
        `prev_hash mismatch at seq=${entry.seq}: expected ${runningHeadHash}, got ${entry.prev_hash}`,
        { broken_seq: entry.seq }
      );
    }

    // Recompute this entry's canonical hash — becomes the running head for
    // the next iteration (and feeds rotation linking if this is the last
    // entry before a rotation anchor).
    runningHeadHash = createHash('sha256')
      .update(canonicalJSON(entry))
      .digest('hex');

    expectedSeq += 1;
  }

  return { headHash: runningHeadHash, entryCount: entries.length };
}

// =============================================================================
// Rotation handling (AC18.4)
// =============================================================================

/**
 * When `--include-rotations` is set and the current genesis has
 * `previous_genesis_hash != null`, the prior chain's HEAD must match that
 * hash. Walking the prior chain requires locating the prior genesis + log
 * pair, which is an operator-archive concern outside this script's default
 * working set.
 *
 * Per as-018 §Scope, the MVP verifier accepts the following rotation
 * artifacts (either form is valid; both surface via the same config block
 * which an operator stages alongside a rotation commit):
 *
 *   Form A: `prior_genesis_path` + `prior_log_path` fields ON the current
 *           genesis object. Verifier loads them, walks, and asserts the
 *           resulting HEAD hash == current genesis.previous_genesis_hash.
 *
 *   Form B: Legacy / bootstrap — genesis has `previous_genesis_hash: null`.
 *           No rotation to verify; this is the origin chain.
 *
 * Rationale: tying rotation metadata to the genesis object (rather than
 * a side-car) keeps the rotation chain self-describing and verifiable in
 * one `--include-rotations` pass. When an operator rotates, the new
 * signed-commit pairs a new genesis with explicit archive paths.
 *
 * TODO(assumption) medium — The `prior_genesis_path` / `prior_log_path`
 * fields are added to the genesis shape here (NOT in the Zod schema, since
 * as-016 ships with `previous_genesis_hash: null` only). When a real
 * rotation ships, confirm field names with the operator flow in a follow-on
 * spec. Present-day genesis has `previous_genesis_hash: null`, so this
 * branch is inert for the origin chain.
 *
 * @param {object} currentGenesis — already validated by readGenesisAnchor
 * @param {string} projectRoot
 * @param {object} options
 * @param {boolean} options.skipSignature
 * @throws {ChainVerificationError}
 */
function verifyRotation(currentGenesis, projectRoot, options) {
  const prevHash = currentGenesis.previous_genesis_hash;
  if (prevHash === null) {
    // Origin chain — nothing to walk.
    return;
  }

  const priorGenesisRel =
    typeof currentGenesis.prior_genesis_path === 'string'
      ? currentGenesis.prior_genesis_path
      : null;
  const priorLogRel =
    typeof currentGenesis.prior_log_path === 'string'
      ? currentGenesis.prior_log_path
      : null;

  if (!priorGenesisRel || !priorLogRel) {
    throw new ChainVerificationError(
      GENESIS_ANCHOR_INVALID,
      `--include-rotations: current genesis has previous_genesis_hash=${prevHash} ` +
        `but missing prior_genesis_path / prior_log_path archive references`
    );
  }

  const priorGenesisPath = resolve(projectRoot, priorGenesisRel);
  const priorLogPath = resolve(projectRoot, priorLogRel);

  // Recurse — walk the prior chain and obtain its HEAD hash. Each prior
  // genesis is itself signature-verified (AC18.2 extends to rotation anchors
  // unless --skip-signature set).
  const priorGenesis = readGenesisAnchor(priorGenesisPath);

  if (!options.skipSignature) {
    // Signature failure on the prior genesis is a GENESIS_SIGNATURE_INVALID
    // — the rotation chain's trust root is broken.
    verifyGenesisSignature(priorGenesisPath, projectRoot);
  }

  // Walk prior log to get its HEAD hash.
  const priorEntries = readLogEntries(priorLogPath);
  const { headHash: priorHeadHash } = walkChain(
    priorGenesis.hash,
    priorEntries
  );

  // Rotation contract: current genesis.previous_genesis_hash ==
  // SHA-256(canonicalJSON(last-entry-of-prior-log))   (or priorGenesis.hash
  // if the prior log was empty).
  if (priorHeadHash !== prevHash) {
    throw new ChainVerificationError(
      CHAIN_BROKEN,
      `rotation linkage broken: prior HEAD hash=${priorHeadHash} but current ` +
        `genesis.previous_genesis_hash=${prevHash}`
    );
  }

  // Recurse further if the prior genesis itself is a rotation.
  verifyRotation(priorGenesis, projectRoot, options);
}

// =============================================================================
// CLI argument parsing
// =============================================================================

/**
 * Parse argv. Keeps the parser intentionally simple — no framework, no
 * short-flags — so the script stays a zero-dep mjs.
 *
 * @param {string[]} argv — process.argv.slice(2)
 * @returns {{
 *   includeRotations: boolean,
 *   genesisPath: string | null,
 *   logPath: string | null,
 *   skipSignature: boolean,
 *   emitStdoutJson: boolean,
 * }}
 */
function parseArgs(argv) {
  let includeRotations = false;
  let genesisPath = null;
  let logPath = null;
  let skipSignature = false;
  let emitStdoutJson = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--include-rotations':
        includeRotations = true;
        break;
      case '--genesis':
        genesisPath = argv[++i] || null;
        break;
      case '--log':
        logPath = argv[++i] || null;
        break;
      case '--skip-signature':
        skipSignature = true;
        break;
      case '--json':
        emitStdoutJson = true;
        break;
      default:
        // Unknown flag — ignored rather than fatal; upstream callers may
        // pass future flags which older script copies should tolerate.
        break;
    }
  }

  return {
    includeRotations,
    genesisPath,
    logPath,
    skipSignature,
    emitStdoutJson,
  };
}

// =============================================================================
// Main
// =============================================================================

function main() {
  const opts = parseArgs(process.argv.slice(2));

  // Resolve project root. Prefer CLAUDE_PROJECT_DIR (hook / wrapper context),
  // fall back to cwd. Same resolution policy as the appender
  // (`pipeline-efficiency-audit-log.mjs:122-124`) so invocations from either
  // context target the same audit artifacts.
  const projectRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  const genesisPath = opts.genesisPath
    ? resolve(opts.genesisPath)
    : join(projectRoot, DEFAULT_GENESIS_RELATIVE_PATH);
  const logPath = opts.logPath
    ? resolve(opts.logPath)
    : join(projectRoot, DEFAULT_LOG_RELATIVE_PATH);

  try {
    // AC18.1 — load + shape-validate genesis.
    const genesis = readGenesisAnchor(genesisPath);

    // AC18.2 — verify signed-commit signature (unless explicitly skipped).
    if (!opts.skipSignature) {
      verifyGenesisSignature(genesisPath, projectRoot);
    }

    // AC18.3 — walk log, assert prev_hash linking + seq monotonicity.
    const entries = readLogEntries(logPath);
    const { headHash, entryCount } = walkChain(genesis.hash, entries);

    // AC18.4 — rotation walk (opt-in).
    if (opts.includeRotations) {
      verifyRotation(genesis, projectRoot, {
        skipSignature: opts.skipSignature,
      });
    }

    // Success.
    emitAndExit(
      'PASS',
      {
        entry_count: entryCount,
        head_hash: headHash,
        include_rotations: opts.includeRotations,
        skip_signature: opts.skipSignature,
        genesis_path: genesisPath,
        log_path: logPath,
      },
      EXIT_OK,
      opts.emitStdoutJson
    );
  } catch (err) {
    if (err instanceof ChainVerificationError) {
      emitAndExit(
        'FAIL',
        {
          error_code: err.code,
          detail: err.message,
          broken_seq: err.broken_seq,
          genesis_path: genesisPath,
          log_path: logPath,
        },
        EXIT_STRUCTURED_ERROR,
        opts.emitStdoutJson
      );
    } else {
      // Unexpected — map to GENESIS_ANCHOR_INVALID (most conservative code;
      // downstream consumers (as-006) fall back to hardcoded-default on
      // this). Include the error message for operator diagnosis.
      emitAndExit(
        'FAIL',
        {
          error_code: GENESIS_ANCHOR_INVALID,
          detail: `unexpected verifier error: ${err?.message || String(err)}`,
          broken_seq: null,
          genesis_path: genesisPath,
          log_path: logPath,
        },
        EXIT_STRUCTURED_ERROR,
        opts.emitStdoutJson
      );
    }
  }
}

// Run main only when executed as a script (not when imported by tests).
const THIS_FILE = fileURLToPath(import.meta.url);
const INVOKED_FILE = process.argv[1] ? resolve(process.argv[1]) : null;
if (INVOKED_FILE === THIS_FILE) {
  main();
}

// =============================================================================
// Exports for testing
// =============================================================================
//
// Tests import these helpers directly (per Test Strategy line 55). The main()
// / CLI surface is also invokable via `spawnSync(node, [script, ...])` for
// end-to-end tests with temp-dir fixtures.
//

export {
  CHAIN_BROKEN,
  GENESIS_ANCHOR_INVALID,
  GENESIS_SIGNATURE_INVALID,
  EXIT_OK,
  EXIT_STRUCTURED_ERROR,
  DEFAULT_GENESIS_RELATIVE_PATH,
  DEFAULT_LOG_RELATIVE_PATH,
  ChainVerificationError,
  readGenesisAnchor,
  verifyGenesisSignature,
  readLogEntries,
  walkChain,
  verifyRotation,
  parseArgs,
  main,
};
