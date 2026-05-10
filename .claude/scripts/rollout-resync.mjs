#!/usr/bin/env node

/**
 * Rollout driver for sg-sync-registry-gaps M4 (T4.1).
 *
 * Iterates every project in `.claude/projects.json` and invokes
 * `metaclaude-cli.mjs sync <project> --force` once per project. Per-consumer
 * failures are captured into a `failed[]` array. The script exits non-zero
 * after 3 consecutive failures for the same consumer (AC-18.3) OR after any
 * per-consumer failure (AC-18.2 emits `SYNC FAILED: <project>` to stderr).
 *
 * Spec: sg-sync-registry-gaps REQ-018, AC-18.1, AC-18.2, AC-18.3, AC-18.4.
 *
 * Usage:
 *   node .claude/scripts/rollout-resync.mjs              # Run full rollout
 *   node .claude/scripts/rollout-resync.mjs --dry-run    # Print projects, no sync
 *
 * Exit codes:
 *   0 - All consumers synced successfully
 *   1 - One or more consumers failed
 *   2 - Structural error (projects.json missing, invalid, etc.)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveMetaclaudeRoot() {
  const cwdCandidate = resolve(process.cwd());
  if (existsSync(join(cwdCandidate, '.claude/projects.json'))) {
    return cwdCandidate;
  }
  return resolve(__dirname, '../..');
}

const METACLAUDE_ROOT = resolveMetaclaudeRoot();
const PROJECTS_JSON = join(METACLAUDE_ROOT, '.claude/projects.json');
// CLI_PATH always points at the real metaclaude-cli.mjs colocated with this
// rollout script (`__dirname` is the real on-disk directory of rollout-resync.mjs).
// METACLAUDE_ROOT follows cwd so projects.json / audit / registry come from the
// fixture during tests, but the CLI binary is always the real one.
const CLI_PATH = join(__dirname, 'metaclaude-cli.mjs');
const AUDIT_DIR = join(METACLAUDE_ROOT, '.claude/audit');
const FAILURE_LOG = join(AUDIT_DIR, 'rollout-failures.jsonl');

const CONSECUTIVE_FAILURE_THRESHOLD = 3;

// Structured target-missing marker emitted by metaclaude-cli.mjs when the
// resolved project directory does not exist. Matching this marker (rather than
// the human-readable "Project directory does not exist" string) prevents silent
// false-success when the CLI log is reworded.
// Spec: sg-sync-registry-gaps cr-propagation-a4b79e12.
const TARGET_MISSING_MARKER = '[SYNC:target-missing]';
const MANIFEST_PREFLIGHT_BLOCKED_MARKER = '[SYNC:manifest-preflight-blocked]';

// Allowlist of stderr line prefixes that are safe to persist to
// rollout-failures.jsonl. Lines not matching any entry are dropped.
// Spec: sg-sync-registry-gaps sec-secret-leak-rollout-c3d2.
//
// Rationale: raw stderr from metaclaude-cli sync can contain absolute paths,
// environment-variable values, or stack traces. The audit log lives under
// `.claude/audit/` (git-committed). Filtering before persist prevents
// secrets / paths / env values from landing in a committed file.
const STDERR_ALLOWLIST_PATTERNS = Object.freeze([
  /^\[SYNC:target-missing\]/, // structured marker for missing target dir
  /^\[SYNC:manifest-preflight-blocked\]/, // structured marker for blocked manifest preflight
  /^\[sync\]/i, // sync subsystem prefix
  /^FAILED:/i,
  /^Error:/i,
  /^WARNING/i,
  /^ERROR/i,
  /^gates?\s/i, // "Gates FAILED", "Gate X ..."
]);

function log(msg) {
  console.error(msg);
}

// ANSI color escape sequence pattern. The upstream CLI emits colored stderr
// via `\x1b[<code>m<text>\x1b[0m`; strip those before applying allowlist
// regexes so pattern-anchored prefixes match line content instead of the
// escape byte.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/g;

/**
 * Filter raw stderr through the allowlist and redact absolute paths.
 *
 * Defense-in-depth:
 *   1. Strip ANSI color escapes so pattern anchors match the literal text.
 *   2. Keep only lines that match a safe prefix pattern.
 *   3. Replace absolute path tokens with `<PATH>` placeholder via two passes:
 *      a. Paths preceded by line-start or whitespace.
 *      b. Paths preceded by non-path characters (quotes, `=`, `(`, `:`, etc.)
 *         including paths inside JSON-encoded strings.
 *
 * Empty result means the stderr was entirely unrecognizable; callers should
 * persist a sentinel like "redacted" instead of the original string.
 *
 * Spec: sg-sync-registry-gaps sec-secret-leak-rollout-c3d2,
 *       cr-security-b1e4f228 (JSON-quoted path redaction).
 *
 * @param {string} raw - Raw stderr from metaclaude-cli sync
 * @returns {string} Redacted stderr (newline-joined allowlisted lines)
 */
export function redactStderr(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  const stripped = raw.replace(ANSI_ESCAPE_PATTERN, '');
  const lines = stripped.split('\n');
  const kept = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    const matched = STDERR_ALLOWLIST_PATTERNS.some((re) => re.test(line));
    if (!matched) continue;
    // Pass 1: redact any absolute path tokens preceded by line-start or
    // whitespace. Match `/` followed by one or more path segments.
    let redacted = line.replace(/(^|\s)(\/[^\s]+)/g, '$1<PATH>');
    // Pass 2: redact paths preceded by a single non-path character. Catches
    // paths inside JSON-quoted strings (`"/Users/alice/secret.mjs"`), paths
    // after `=` (`path=/var/log/foo.log`), paths in parens (`(/etc/passwd)`),
    // and paths after colons (`file:/tmp/secret.json`). The preceding char is
    // preserved; the trailing `"` / `)` / `]` terminator is preserved.
    //
    // Class `[^A-Za-z0-9_/.<\s]` prevents matches mid-path-segment and skips
    // leading whitespace (Pass 1's territory) and `<` (avoids re-matching the
    // `<PATH>` placeholder, though that placeholder has no `/` anyway).
    //
    // Path-body class `[^\s"')\]]+` stops at the first whitespace or closing
    // delimiter, so quoted paths truncate cleanly at the closing `"`.
    //
    // Spec: sg-sync-registry-gaps cr-security-b1e4f228.
    redacted = redacted.replace(
      /([^A-Za-z0-9_/.<\s])(\/[^\s"')\]]+)/g,
      '$1<PATH>'
    );
    kept.push(redacted);
  }
  return kept.join('\n');
}

function parseArgs(argv) {
  return {
    dryRun: argv.includes('--dry-run'),
  };
}

function loadFailureCounts() {
  if (!existsSync(FAILURE_LOG)) return new Map();
  const raw = readFileSync(FAILURE_LOG, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const counts = new Map();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      counts.set(entry.project, (counts.get(entry.project) || 0) + 1);
    } catch {
      // ignore malformed
    }
  }
  return counts;
}

function recordFailure(project, error) {
  mkdirSync(AUDIT_DIR, { recursive: true });
  // Redact through the allowlist before persisting. Unrecognizable stderr
  // collapses to 'redacted' so the audit log still records that a failure
  // occurred even when the upstream error format is unknown.
  // Spec: sg-sync-registry-gaps sec-secret-leak-rollout-c3d2.
  const filtered = redactStderr(error || '');
  const sanitized = filtered.length > 0 ? filtered.slice(0, 500) : 'redacted';
  const entry = {
    timestamp: new Date().toISOString(),
    project,
    error: sanitized,
  };
  // Atomic append via O_APPEND (POSIX-atomic for writes < PIPE_BUF).
  // Replaces the prior read-modify-write that raced on concurrent invocation.
  // Spec: sg-sync-registry-gaps cr-other-c8123f4e.
  appendFileSync(FAILURE_LOG, JSON.stringify(entry) + '\n');
}

function clearFailuresFor(project) {
  // NOTE: Read-modify-write race is acceptable under the sole-developer trust
  // model documented in memory-bank/org-context.md. Concurrent rollout-resync
  // invocations are not expected in practice (the rollout is a manual single-
  // operator task). Introducing a file lock here would add complexity without
  // mitigating an actual observed race. If the trust model changes (CI-driven
  // concurrent rollouts, multi-operator workflows), replace with proxmark-style
  // advisory lock or move to an append-only tombstone log.
  // Spec: sg-sync-registry-gaps cr-other-5d8a2e71.
  if (!existsSync(FAILURE_LOG)) return;
  const raw = readFileSync(FAILURE_LOG, 'utf-8');
  const lines = raw.split('\n').filter((l) => {
    if (l.trim().length === 0) return false;
    try {
      const entry = JSON.parse(l);
      return entry.project !== project;
    } catch {
      return false;
    }
  });
  writeFileSync(FAILURE_LOG, lines.length > 0 ? lines.join('\n') + '\n' : '');
}

function syncProject(projectName) {
  const result = spawnSync('node', [CLI_PATH, 'sync', projectName, '--force'], {
    cwd: METACLAUDE_ROOT,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export function isSyncFailure(result) {
  const stderr = result?.stderr || '';
  return (
    result?.exitCode !== 0 ||
    stderr.includes(TARGET_MISSING_MARKER) ||
    stderr.includes(MANIFEST_PREFLIGHT_BLOCKED_MARKER)
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(PROJECTS_JSON)) {
    log(`projects.json not found at ${PROJECTS_JSON}`);
    process.exit(2);
  }

  let projects;
  try {
    const cfg = JSON.parse(readFileSync(PROJECTS_JSON, 'utf-8'));
    projects = Object.keys(cfg.projects || {});
  } catch (err) {
    log(`Invalid projects.json: ${err.message}`);
    process.exit(2);
  }

  log(`Rollout: ${projects.length} project(s)`);

  if (args.dryRun) {
    for (const p of projects) log(`  - ${p}`);
    process.exit(0);
  }

  const failureCounts = loadFailureCounts();
  const failed = [];

  for (const project of projects) {
    // Check consecutive failure count BEFORE attempting this project.
    const priorCount = failureCounts.get(project) || 0;
    if (priorCount >= CONSECUTIVE_FAILURE_THRESHOLD) {
      log(`SYNC FAILED (${priorCount}x): ${project}, skipping`);
      failed.push(project);
      continue;
    }

    log(`Syncing: ${project}`);
    const result = syncProject(project);
    // Structured target-missing detection (cr-propagation-a4b79e12). The
    // downstream CLI now emits `[SYNC:target-missing] <path>` whenever the
    // resolved project directory is missing. Matching on the marker prevents
    // silent false-success when the human-readable log line is reworded.
    const syncFailed = isSyncFailure(result);
    if (!syncFailed) {
      // Clear past failures for this consumer on success.
      clearFailuresFor(project);
      log(`  OK: ${project}`);
    } else {
      // Find the marker line if present; otherwise use redacted stderr head.
      const markerLine = result.stderr
        .split('\n')
        .find(
          (l) =>
            l.includes(TARGET_MISSING_MARKER) ||
            l.includes(MANIFEST_PREFLIGHT_BLOCKED_MARKER)
        );
      const rawMsg = markerLine || result.stderr.slice(0, 500);
      const msg = redactStderr(rawMsg) || 'redacted';
      log(`SYNC FAILED: ${project}`);
      recordFailure(project, rawMsg);
      failed.push(project);
      const newCount = priorCount + 1;
      if (newCount >= CONSECUTIVE_FAILURE_THRESHOLD) {
        log(
          `SYNC FAILED (${newCount}x): ${project}, last error: ${msg.trim().slice(0, 120)}`
        );
      }
    }
  }

  if (failed.length > 0) {
    log(`\nRollout complete with ${failed.length} failure(s): ${failed.join(', ')}`);
    process.exit(1);
  }

  log(`\nRollout complete: ${projects.length} project(s) synced`);
  process.exit(0);
}

// Run main() only on direct invocation so unit tests can import `redactStderr`
// without spawning the rollout loop.
const __isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  fileURLToPath(import.meta.url) === process.argv[1];
if (__isDirectInvocation) {
  main();
}
