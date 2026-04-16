#!/usr/bin/env node

/**
 * Pre-commit hook step 2: append-only check on `.claude/audit/skip-gates.jsonl`.
 *
 * Any staged commit that modifies or removes an EXISTING line in skip-gates.jsonl
 * is rejected. Only additions at the end are permitted.
 *
 * The check diffs the staged version of the file against `HEAD:<path>` via `git
 * show` and compares line-by-line. If any prefix line differs (by index) between
 * HEAD and the staged version, the hook exits non-zero.
 *
 * ## Archive exception (sec-append-only-case-d-latent-4a91)
 *
 * A legitimate archive operation truncates `skip-gates.jsonl` and moves its
 * contents to `.claude/audit/archive/skip-gates.<YYYY-MM-DD>.jsonl`. The hook
 * recognizes this by:
 *   1. staged `skip-gates.jsonl` is empty (or missing)
 *   2. a file at `.claude/audit/archive/skip-gates.<YYYY-MM-DD>.jsonl` is
 *      ALSO staged in this commit
 *   3. the staged archive content is byte-equal to the HEAD `skip-gates.jsonl`
 *      content (strict match, no subset acceptance)
 *
 * When all three hold, the hook accepts the commit instead of firing Case D.
 * The strict byte-equal check prevents tampering: the archive must contain
 * EXACTLY what was in HEAD; anything else is rejected.
 *
 * Spec: sg-sync-registry-gaps T1.12, REQ-012, AC-12.3, sec-append-only-case-d-latent-4a91.
 *
 * Exit codes:
 *   0 - No violation (file unchanged, appended-only, absent, or legitimate archive)
 *   1 - Existing line was modified or deleted (append-only violation)
 *   2 - Unexpected structural error (git missing, diff unreadable)
 */

import { execFileSync } from 'node:child_process';

const AUDIT_FILE = '.claude/audit/skip-gates.jsonl';
const ARCHIVE_DIR = '.claude/audit/archive';
const ARCHIVE_PATTERN = /^\.claude\/audit\/archive\/skip-gates\.\d{4}-\d{2}-\d{2}\.jsonl$/;

function gitShow(ref, path) {
  try {
    return execFileSync('git', ['show', `${ref}:${path}`], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    // git show exits non-zero when the file does not exist at that ref.
    return null;
  }
}

function readStagedFromIndex(path) {
  // Read the version in the git index (staged version) via `git show :<path>`.
  try {
    return execFileSync('git', ['show', `:${path}`], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return null;
  }
}

function listStagedFiles() {
  // `git diff --cached --name-only` returns every path staged for the current
  // commit. Includes adds, modifications, deletes, and renames (in both A and M
  // form). We only need the current names.
  try {
    const out = execFileSync(
      'git',
      ['diff', '--cached', '--name-only', '--diff-filter=ACMR'],
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function findStagedArchiveFiles() {
  // Return the subset of staged files that match the archive path pattern.
  const all = listStagedFiles();
  return all.filter((path) => ARCHIVE_PATTERN.test(path));
}

/**
 * Check whether a legitimate archive operation is in progress.
 *
 * Returns true iff:
 *   1. The staged skip-gates.jsonl is empty (or absent), AND
 *   2. At least one archive file is staged in this commit, AND
 *   3. That archive's staged content is byte-equal to the HEAD skip-gates.jsonl content.
 *
 * The equality check is strict: no subset match, no ordering relaxation.
 * Multiple archive files may be staged (edge case); if ANY one matches HEAD
 * byte-for-byte, accept. Otherwise fall through to the standard Case D path.
 *
 * @param {string | null} headContent - HEAD content of skip-gates.jsonl
 * @param {string | null} stagedContent - Staged content of skip-gates.jsonl
 * @returns {boolean} true if the diff is a legitimate archive operation
 */
function isLegitimateArchiveOperation(headContent, stagedContent) {
  // Archive operation truncates the file. Staged content must be empty or null.
  if (stagedContent !== null && stagedContent.length > 0) {
    // Staged file has content; if it's a proper prefix of HEAD this would
    // still be Case D (removed lines). Not an archive.
    return false;
  }

  // HEAD must have had content (otherwise there's nothing to archive).
  if (headContent === null || headContent.length === 0) {
    return false;
  }

  const archiveFiles = findStagedArchiveFiles();
  if (archiveFiles.length === 0) {
    return false;
  }

  // Check each staged archive file. Accept if ANY one's staged content matches
  // HEAD exactly. Multiple archive files staged simultaneously is legal (edge
  // case: archiving twice in one day, though normally each day gets one file).
  for (const archivePath of archiveFiles) {
    const archiveContent = readStagedFromIndex(archivePath);
    if (archiveContent === null) continue;
    // Strict byte-equal match: no subset, no trimming. The archive must
    // contain the HEAD audit log verbatim.
    if (archiveContent === headContent) {
      return true;
    }
  }

  return false;
}

function splitLines(content) {
  if (content === null || content === undefined) return [];
  // Normalize trailing newline: the file is JSONL, each line ends with \n.
  // Split by \n and drop a trailing empty element if present.
  const parts = content.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function main() {
  const head = gitShow('HEAD', AUDIT_FILE);
  const staged = readStagedFromIndex(AUDIT_FILE);

  const headLines = splitLines(head);
  const stagedLines = splitLines(staged);

  // Case A: both absent -> nothing to check.
  if (head === null && staged === null) {
    process.exit(0);
  }

  // Case B: file new in staging (head is null) -> pure addition, allowed.
  if (head === null) {
    process.exit(0);
  }

  // Case C: file deleted from staging -> check for archive operation first.
  if (staged === null) {
    if (isLegitimateArchiveOperation(head, staged)) {
      // Archived to .claude/audit/archive/skip-gates.<date>.jsonl with
      // byte-equal content; treat as no-op.
      process.exit(0);
    }
    console.error(
      JSON.stringify({
        rule: 'provenance-invalid',
        file: AUDIT_FILE,
        message: 'Append-only violation: skip-gates audit log removed from staging',
        remediation: 'Restore .claude/audit/skip-gates.jsonl and only append new entries',
      })
    );
    process.exit(1);
  }

  // Case D: staged is shorter than head -> lines were removed OR truncated
  // as part of an archive operation. Check archive-op first.
  if (stagedLines.length < headLines.length) {
    if (isLegitimateArchiveOperation(head, staged)) {
      // Legitimate archive: HEAD content has been preserved byte-equal in a
      // staged archive file, and the working file has been truncated.
      // Spec: sg-sync-registry-gaps sec-append-only-case-d-latent-4a91.
      process.exit(0);
    }
    console.error(
      JSON.stringify({
        rule: 'provenance-invalid',
        file: AUDIT_FILE,
        message: `Append-only violation: staged file has ${stagedLines.length} lines, HEAD had ${headLines.length}`,
        remediation:
          'Revert the deletion; skip-gates audit log may only grow. To archive, move contents byte-equal to .claude/audit/archive/skip-gates.<YYYY-MM-DD>.jsonl and stage both files together.',
      })
    );
    process.exit(1);
  }

  // Case E: compare each HEAD line against the staged line at the same index.
  for (let i = 0; i < headLines.length; i++) {
    if (headLines[i] !== stagedLines[i]) {
      console.error(
        JSON.stringify({
          rule: 'provenance-invalid',
          file: AUDIT_FILE,
          line: i + 1,
          message: `Append-only violation: line ${i + 1} was modified`,
          remediation: 'Restore original line content; new audit entries may only be appended',
        })
      );
      process.exit(1);
    }
  }

  // All HEAD lines present and unchanged; any extra staged lines are appends -> OK.
  process.exit(0);
}

// Export helpers for unit testing. main() runs only on direct invocation so the
// test file can import `isLegitimateArchiveOperation` / `splitLines` etc. without
// triggering the hook against the host repo.
export {
  isLegitimateArchiveOperation,
  splitLines,
  findStagedArchiveFiles,
  ARCHIVE_PATTERN,
  AUDIT_FILE,
};

import { fileURLToPath } from 'node:url';
const __isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  fileURLToPath(import.meta.url) === process.argv[1];
if (__isDirectInvocation) {
  main();
}
