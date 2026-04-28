/**
 * Unlock-Misuse Detection — as-008 / REQ-005 / AC-005.9
 *
 * Pure-function helper used by `workflow-stop-enforcement.mjs` to detect the
 * misuse pattern described in spec.md EC-WS2-7:
 *
 *   GIVEN an active `session.active_work.test_writer_unlock[<sg-id>]` window
 *   AND   the most recent completed subagent task was `test-writer`
 *   AND   that dispatch produced ZERO new or modified files under the
 *         test-path globs (`__tests__/` or `tests/`)
 *   THEN  the Stop hook SHALL emit an advisory `UNLOCK_USED_NO_TESTS` warning
 *         to stderr AND append a `test_writer_unlock_misuse` audit entry.
 *
 * Non-blocking observability signal (AC8.4): the Stop hook does NOT emit
 * `decision: block`. The warning is appended to existing reasonParts only
 * when other blockers exist; when no other blockers exist the Stop hook still
 * exits 0 and the advisory is emitted to stderr as a side-channel signal.
 *
 * Scope boundaries (Task 8.1-8.3 / as-008):
 *   - Target file: `.claude/scripts/workflow-stop-enforcement.mjs`.
 *   - Edit-list accessor (Task 8.2): the "session-checkpoint edit-list
 *     accessor" is `subagent_tasks.completed_this_session[*].files_edited`
 *     when populated by the dispatch flow — this is the canonical
 *     "which files did the just-completed dispatch edit?" surface. When
 *     that field is absent (legacy / untracked dispatches), the lib falls
 *     back to `git diff --name-only HEAD` + `git ls-files --others` on
 *     the working tree as a best-effort probe.
 *   - Test-file classification: filter either source to paths whose
 *     segments contain `__tests__/` or begin with `tests/`. git probe uses
 *     `execFileSync('git', ...)` per hash-input-manifest.mjs precedent
 *     (no shell, no env leakage, explicit maxBuffer).
 *
 * Import constraints:
 *   - This lib is callable from the Stop hook (`workflow-stop-enforcement.mjs`)
 *     ONLY. `stop-hook-checks.mjs` keeps a minimal import footprint to avoid
 *     hook-time cycles; placing the detection here keeps that constraint intact.
 *   - Imports only `node:child_process` primitives. No coupling to
 *     session-checkpoint.mjs (sole-writer invariant preserved).
 *
 * Determinism:
 *   - `detectUnlockMisuse` is a pure decision helper: it reads session state
 *     and git working-tree state and returns a classification. It does NOT
 *     append to the audit log; emission is the caller's responsibility
 *     (keeps `appendAuditEntry` errors visible to the Stop hook's own error
 *     handler rather than swallowed here).
 *
 * Current contract source:
 *   .claude/docs/design/test-writer-unlock-state-signals.md § Audit Events
 */

import { execFileSync } from 'node:child_process';

// =============================================================================
// Constants
// =============================================================================

/**
 * Test-path globs for unlock misuse detection.
 *
 * A changed path qualifies as a "test file" if ANY path segment is literally
 * `__tests__`, OR the path starts with `tests/`. Matching is done on the
 * slash-normalized path string (git reports forward-slashes on all platforms).
 *
 * Examples that MATCH (test-file changes):
 *   - `__tests__/foo.test.mjs`
 *   - `src/components/__tests__/bar.test.mjs`
 *   - `tests/e2e/logout.test.ts`
 *   - `tests/integration/foo.test.js`
 *
 * Examples that DO NOT MATCH (non-test changes):
 *   - `src/auth.ts`
 *   - `test_helpers.mjs` (singular, no trailing slash)
 *   - `my-tests-dir/foo.md` (not exactly `tests/` at start, not `__tests__`)
 */
const TESTS_DIR_PREFIX = 'tests/';
const TESTS_UNDERSCORE_SEGMENT = '__tests__';

/**
 * Subagent type that this heartbeat applies to. The unlock semantics only
 * permit hybrid-mode reads for `test-writer`; `e2e-test-writer` is always
 * strict (EC-WS2-10) so it is NEVER eligible for misuse detection.
 */
const TEST_WRITER_SUBAGENT_TYPE = 'test-writer';

/**
 * Maximum bytes to allocate for `git diff --name-only HEAD` stdout. A full
 * working-tree diff on this repo is ~100 KB of path names; 4 MB is ~40x
 * headroom against an unusually large bulk-rename dispatch.
 */
const GIT_DIFF_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

/**
 * Stop-hook advisory error code emitted to stderr on misuse detection.
 * Matches spec.md REQ-005 EARS clause wording.
 */
export const MISUSE_ADVISORY_CODE = 'UNLOCK_USED_NO_TESTS';

/**
 * Audit-log `event_class` value for this heartbeat. Canonical string in the
 * 9-class enum declared in `lib/schemas/audit-entry.schema.mjs` EVENT_CLASSES.
 */
export const MISUSE_EVENT_CLASS = 'test_writer_unlock_misuse';

// =============================================================================
// Pure helpers
// =============================================================================

/**
 * Classify a git-reported path as a test file per the TESTS_DIR_PREFIX +
 * TESTS_UNDERSCORE_SEGMENT rules above.
 *
 * @param {string} path - Repository-relative path (forward slashes).
 * @returns {boolean} True iff the path falls under `__tests__/` or `tests/`.
 */
export function isTestPath(path) {
  if (typeof path !== 'string' || path.length === 0) return false;
  if (path.startsWith(TESTS_DIR_PREFIX)) return true;
  // Match `__tests__` as a literal path segment (slash-bounded).
  const segments = path.split('/');
  return segments.includes(TESTS_UNDERSCORE_SEGMENT);
}

/**
 * Invoke `git diff --name-only HEAD` and return the list of changed paths
 * in the working tree relative to the last commit.
 *
 * Includes both staged and unstaged modifications; includes untracked files
 * via a second `git ls-files --others --exclude-standard` invocation so
 * brand-new test files count as test-writer output.
 *
 * Returns an empty array on any git failure (fail-open per spec.md "advisory
 * warning only; non-blocking"). The Stop hook should never crash on a git
 * probe failure.
 *
 * @param {string} cwd - Repo root (absolute path).
 * @returns {string[]} Slash-normalized relative paths. Empty on any failure.
 */
export function readWorkingTreeChangedFiles(cwd) {
  const paths = new Set();

  try {
    const stdout = execFileSync(
      'git',
      ['-c', 'color.ui=never', 'diff', '--name-only', 'HEAD'],
      {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: GIT_DIFF_MAX_BUFFER_BYTES,
        encoding: 'utf-8',
      },
    );
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) paths.add(trimmed);
    }
  } catch {
    // Fail-open: advisory-only heartbeat. A git probe failure means the
    // Stop hook cannot determine test-file change status and therefore
    // cannot emit a confident misuse signal; suppress the heartbeat
    // rather than produce a spurious positive.
    return [];
  }

  try {
    const stdout = execFileSync(
      'git',
      ['-c', 'color.ui=never', 'ls-files', '--others', '--exclude-standard'],
      {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: GIT_DIFF_MAX_BUFFER_BYTES,
        encoding: 'utf-8',
      },
    );
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) paths.add(trimmed);
    }
  } catch {
    // Same fail-open rationale as above.
    return [];
  }

  return Array.from(paths);
}

/**
 * Find the most recent completed test-writer dispatch for the given spec
 * group id. Returns `null` if no such dispatch exists in the session.
 *
 * Reads `session.subagent_tasks.completed_this_session` (shape established
 * at session-checkpoint.mjs:2692) and filters on:
 *   - subagent_type === 'test-writer'
 *   - spec_group_id === <sgId>      (when both sides are non-null)
 *   - completed_at is set            (dispatch actually completed)
 *
 * The "most recent" entry is the one with the largest `completed_at`
 * timestamp (ISO-8601 strings sort lexicographically in chronological order).
 *
 * @param {object} session - Session object loaded via loadSession().
 * @param {string} sgId - Spec-group-id the unlock is keyed by.
 * @returns {object|null} The dispatch task record, or null.
 */
export function findLatestCompletedTestWriterDispatch(session, sgId) {
  if (!session || !session.subagent_tasks) return null;
  const completed = session.subagent_tasks.completed_this_session;
  if (!Array.isArray(completed) || completed.length === 0) return null;

  let latest = null;
  for (const task of completed) {
    if (!task || task.subagent_type !== TEST_WRITER_SUBAGENT_TYPE) continue;
    if (!task.completed_at) continue;
    // spec_group_id on the task record is optional in older sessions — only
    // filter when present so legacy dispatches are not silently skipped.
    if (task.spec_group_id && sgId && task.spec_group_id !== sgId) continue;

    if (!latest || task.completed_at > latest.completed_at) {
      latest = task;
    }
  }
  return latest;
}

/**
 * Decide whether the misuse heartbeat should fire for the given session.
 *
 * Preconditions for emission (all must hold — see AC8.1, AC8.2, AC8.3):
 *   1. `session.active_work.test_writer_unlock` has at least one entry
 *      whose `unlocked_until` is in the future (AC8.3: skip when no active
 *      unlock).
 *   2. The most recent completed subagent task for that spec-group-id is a
 *      `test-writer` dispatch (AC8.1: "unlock used" means a test-writer
 *      dispatch consumed the window).
 *   3. The working-tree diff since HEAD contains ZERO test-file paths
 *      (AC8.2: skip when ≥1 test-file change).
 *
 * Fail-open on any structural anomaly:
 *   - Missing `active_work` → no unlock → no heartbeat.
 *   - Malformed unlock entry (no `unlocked_until` / non-string / past) →
 *     treated as inactive.
 *   - Git probe failure → treated as "cannot determine" → no heartbeat.
 *
 * @param {object} session - Session object from loadSession().
 * @param {string} projectRoot - Repo root (absolute path; for git diff cwd).
 * @param {object} [deps]
 * @param {() => string[]} [deps.readChangedFiles]
 *   Injectable test-seam: returns the list of working-tree changed paths.
 *   Defaults to `readWorkingTreeChangedFiles(projectRoot)`. Injected by
 *   tests to simulate dispatch edit-list without touching the filesystem.
 * @param {() => string} [deps.now]
 *   Injectable clock for TTL checks. Defaults to `new Date().toISOString()`.
 * @returns {{
 *   fire: boolean,
 *   reason: string,
 *   specGroupId?: string,
 *   dispatchId?: string,
 *   unlockedUntil?: string,
 *   testFileChangeCount?: number,
 *   changedFiles?: string[],
 * }}
 *   `fire: true` means the caller should emit the advisory + audit entry.
 *   `reason` is a short machine-parseable tag; intended for stderr logging.
 */
export function detectUnlockMisuse(session, projectRoot, deps = {}) {
  const readChangedFiles =
    deps.readChangedFiles || (() => readWorkingTreeChangedFiles(projectRoot));
  const now = deps.now || (() => new Date().toISOString());

  if (!session || !session.active_work) {
    return { fire: false, reason: 'no_active_work' };
  }
  // Canonical location per session-checkpoint.mjs:3391-3399 is
  // `session.active_work.test_writer_unlock`. The top-level fallback
  // (`session.test_writer_unlock`) was removed per ws-2 code-review Pass 1
  // finding M2: fixture-robustness ambiguity is not worth the canonical-path
  // drift risk. Older sessions / ad-hoc fixtures must migrate to the
  // canonical location.
  const unlocks =
    (session.active_work && session.active_work.test_writer_unlock) || null;
  if (!unlocks || typeof unlocks !== 'object' || Array.isArray(unlocks)) {
    return { fire: false, reason: 'no_unlock_map' };
  }

  const nowIso = now();

  // Iterate unlock entries; emit at most ONE heartbeat per Stop-hook run
  // (the first active+test-writer+no-test-changes combination found).
  // Multiple concurrent unlocks would produce separate heartbeats on
  // separate Stop-hook firings, which is desirable: each misuse is a
  // distinct observability event.
  for (const [sgId, entry] of Object.entries(unlocks)) {
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.unlocked_until !== 'string') continue;
    // AC8.3 guard: TTL expired → unlock inactive → skip.
    if (entry.unlocked_until <= nowIso) continue;

    // AC8.1 guard: the dispatch that consumed this unlock must be a
    // test-writer. Without a confirmed test-writer dispatch we cannot
    // claim "unlock used" — fail-open (skip heartbeat).
    const dispatch = findLatestCompletedTestWriterDispatch(session, sgId);
    if (!dispatch) continue;

    // Resolve the edit list. Primary source: the dispatch record's
    // `files_edited` field (the session-checkpoint edit-list accessor per
    // Task 8.2). Secondary source: the injected `readChangedFiles` seam,
    // which defaults to a git probe. The dispatch-recorded list is
    // preferred because it scopes to the just-completed dispatch window
    // whereas `git diff HEAD` conflates ALL uncommitted changes in the
    // working tree (see EC-WS2-7; also prevents false suppression by
    // unrelated test files in an orchestrator worktree).
    let changed;
    if (Array.isArray(dispatch.files_edited)) {
      changed = dispatch.files_edited;
    } else {
      changed = readChangedFiles();
      if (!Array.isArray(changed)) continue;
    }
    const testFileChanges = changed.filter((p) => isTestPath(p));
    if (testFileChanges.length > 0) {
      // At least one test-file change → legitimate dispatch.
      return {
        fire: false,
        reason: 'test_files_changed',
        specGroupId: sgId,
        dispatchId: entry.dispatch_id,
        unlockedUntil: entry.unlocked_until,
        testFileChangeCount: testFileChanges.length,
      };
    }

    // All preconditions met — emit the heartbeat.
    return {
      fire: true,
      reason: 'unlock_used_no_tests',
      specGroupId: sgId,
      dispatchId: entry.dispatch_id,
      unlockedUntil: entry.unlocked_until,
      testFileChangeCount: 0,
      changedFiles: changed,
    };
  }

  return { fire: false, reason: 'no_active_unlock' };
}

/**
 * Build the advisory stderr line emitted by the Stop hook.
 *
 * Format is stable for grep-based operator tooling (e.g., post-hoc log
 * analysis): fixed prefix `[workflow-stop-enforcement]`, fixed code token
 * `UNLOCK_USED_NO_TESTS`, followed by key=value fields.
 *
 * @param {{ specGroupId: string, dispatchId?: string, unlockedUntil: string }} d
 * @returns {string} Single line suitable for stderr.write (no trailing \n).
 */
export function formatMisuseStderrLine(d) {
  const parts = [
    '[workflow-stop-enforcement]',
    `advisory=${MISUSE_ADVISORY_CODE}`,
    `spec_group_id=${d.specGroupId}`,
  ];
  if (d.dispatchId) parts.push(`dispatch_id=${d.dispatchId}`);
  if (d.unlockedUntil) parts.push(`unlocked_until=${d.unlockedUntil}`);
  return parts.join(' ');
}

/**
 * Build the `appendAuditEntry` payload for the misuse event class. Shape
 * matches spec.md §Audit log entry shape (`event_class:
 * test_writer_unlock_misuse`; dispatch_id present when available; no
 * first_failure_ref / no unlocked_until requirement per AC-005.10 note
 * "dispatch_id present on unlock; absent on misuse" — we include it when
 * the session recorded it so operators can correlate).
 *
 * @param {{
 *   specGroupId: string,
 *   dispatchId?: string,
 *   unlockedUntil?: string,
 *   actorFallback?: string,
 * }} d
 * @returns {{ event_subtype: string, payload: Record<string, unknown> }}
 */
export function buildMisuseAuditPayload(d) {
  const payload = {
    spec_group_id: d.specGroupId,
    operator_or_agent: d.actorFallback || 'agent',
  };
  if (d.dispatchId) payload.dispatch_id = d.dispatchId;
  if (d.unlockedUntil) payload.unlocked_until = d.unlockedUntil;
  return {
    event_subtype: 'stop-hook-unlock-used-no-tests',
    payload,
  };
}
