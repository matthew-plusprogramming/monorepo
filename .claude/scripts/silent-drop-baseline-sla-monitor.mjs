#!/usr/bin/env node

/**
 * silent-drop-baseline-sla-monitor.mjs
 *
 * Maintainer-invoked SLA monitor that emits reassessment recommendations to
 * `.claude/metrics/baseline-sla-recommendation.json` based on baseline state.
 *
 * Never writes a decision (NFR-3 operator-controlled flip discipline) — only
 * recommendation entries. Never modifies the baseline file.
 *
 * Recommendation triggers:
 *   AC-20.1: operator_decision=revert-advisory AND effective_at >90 days ago
 *            AND no prior kill-gate-terminal in reengagement_history.
 *   AC-20.2: prior reassessment recommendation unaddressed for 14 days
 *            (addressed = new reengagement_history entry dated AFTER the
 *            recommendation's created_at).
 *   AC-20.4: kill-gate-terminal in history → suppress all further
 *            recommendations (terminal state).
 *
 * Usage:
 *   node silent-drop-baseline-sla-monitor.mjs \
 *     --baseline <path-to-silent-drop-baseline.json> \
 *     --recommendations <path-to-baseline-sla-recommendation.json>
 *
 * Exit codes:
 *   0 - Success. Recommendations file updated (or unchanged when no trigger).
 *   1 - Baseline validation failure (schema invalid, malformed reengagement).
 *   2 - Invocation error (missing args, unreadable files).
 *
 * Implements: AC-20.1, AC-20.2, AC-20.3, AC-20.4, AC-20.5.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  silentDropBaselineReportSchema,
  reengagementHistoryEntrySchema,
} from './lib/silent-drop-schemas.mjs';

// =============================================================================
// Constants
// =============================================================================

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const REENGAGEMENT_DAYS = 90;
const SECOND_REMINDER_DAYS = 14;

const EXIT_OK = 0;
const EXIT_VALIDATION_FAIL = 1;
const EXIT_USAGE = 2;

// =============================================================================
// Arg parsing
// =============================================================================

function parseArgs(argv) {
  const args = { baseline: null, recommendations: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--baseline' && i + 1 < argv.length) args.baseline = argv[++i];
    else if (a === '--recommendations' && i + 1 < argv.length)
      args.recommendations = argv[++i];
  }
  return args;
}

// =============================================================================
// File helpers
// =============================================================================

function readJson(path) {
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw);
}

function writeJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

// =============================================================================
// Baseline validation
// =============================================================================

/**
 * Validate the baseline, reporting reengagement_history issues with
 * AC-20.3-specific messaging (enum, rationale length) so tests can inspect.
 */
function validateBaseline(parsed) {
  // Iterate reengagement entries first to produce narrow diagnostics.
  const history = Array.isArray(parsed.reengagement_history)
    ? parsed.reengagement_history
    : [];
  for (let i = 0; i < history.length; i++) {
    const result = reengagementHistoryEntrySchema.safeParse(history[i]);
    if (!result.success) {
      const firstIssue = result.error.issues[0];
      const path = firstIssue.path.join('.');
      return {
        valid: false,
        error: `reengagement_history[${i}].${path}: ${firstIssue.message}`,
      };
    }
  }
  // Full schema validation for remaining fields.
  const full = silentDropBaselineReportSchema.safeParse(parsed);
  if (!full.success) {
    const firstIssue = full.error.issues[0];
    const path = firstIssue.path.join('.');
    return {
      valid: false,
      error: `baseline.${path}: ${firstIssue.message}`,
    };
  }
  return { valid: true, data: full.data };
}

// =============================================================================
// Recommendation file
// =============================================================================

function loadRecommendations(path) {
  if (!existsSync(path)) {
    return { entries: [] };
  }
  const parsed = readJson(path);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
    return { entries: [] };
  }
  return parsed;
}

// =============================================================================
// Decision logic
// =============================================================================

/**
 * Return entries that should be appended to the recommendations file based on
 * current baseline + existing recommendations.
 *
 * @param {object} baseline - Validated baseline JSON
 * @param {{entries: Array}} recommendations - Current recommendations file
 * @param {Date} now - Reference time
 * @returns {Array<object>} New entries to append (may be empty)
 */
function computeNewEntries(baseline, recommendations, now) {
  const newEntries = [];

  // AC-20.4: kill-gate-terminal is terminal.
  const terminal = (baseline.reengagement_history || []).some(
    (e) => e.decision === 'kill-gate-terminal',
  );
  if (terminal) {
    return newEntries;
  }

  // AC-20.1: only applicable when operator_decision=revert-advisory.
  if (baseline.operator_decision !== 'revert-advisory') {
    return newEntries;
  }

  // Need an effective_at to compute the 90-day clock. If absent, skip —
  // advisory mode that never had an effective_at has no reengagement clock.
  const effAt = baseline.effective_at ? new Date(baseline.effective_at) : null;
  if (!effAt || Number.isNaN(effAt.getTime())) {
    return newEntries;
  }

  // Most recent reengagement_history date (post-effective) — extensions reset
  // the 90-day window.
  const history = baseline.reengagement_history || [];
  const historyDates = history
    .map((e) => new Date(e.date))
    .filter((d) => !Number.isNaN(d.getTime()));
  const latestHistoryDate = historyDates.length
    ? new Date(Math.max(...historyDates.map((d) => d.getTime())))
    : null;
  const clockAnchor =
    latestHistoryDate && latestHistoryDate > effAt ? latestHistoryDate : effAt;

  const daysSinceAnchor = (now.getTime() - clockAnchor.getTime()) / MS_PER_DAY;

  // Pending prior recommendations we might extend.
  const existingEntries = recommendations.entries || [];
  const latestRecommendation = existingEntries
    .filter((e) => e.kind === 'reengagement-trigger')
    .sort((a, b) => {
      const da = new Date(a.created_at || 0).getTime();
      const db = new Date(b.created_at || 0).getTime();
      return db - da;
    })[0];

  // AC-20.1: emit the 90-day reengagement trigger when applicable.
  if (daysSinceAnchor >= REENGAGEMENT_DAYS) {
    // Suppress if a recent recommendation already exists that hasn't had an
    // operator response yet (we'll still emit the 14-day reminder separately).
    const shouldEmit = !latestRecommendation;
    if (shouldEmit) {
      newEntries.push({
        entry_id: randomUUID(),
        kind: 'reengagement-trigger',
        created_at: now.toISOString(),
        baseline_effective_at: baseline.effective_at,
        days_since_anchor: Math.floor(daysSinceAnchor),
        message:
          '90-day reassessment trigger: operator_decision=revert-advisory has exceeded 90-day window. Operator SHALL record a reengagement_history entry (extend-revert-90d, attempt-coercive-flip, or kill-gate-terminal).',
      });
    }
  }

  // AC-20.2: emit the 14-day second-level reminder when a prior recommendation
  // is unaddressed for ≥14 days (no newer reengagement_history entry).
  if (latestRecommendation) {
    const recCreated = new Date(latestRecommendation.created_at || 0);
    const addressedSince =
      latestHistoryDate && latestHistoryDate >= recCreated;
    if (!addressedSince) {
      const ageDays = (now.getTime() - recCreated.getTime()) / MS_PER_DAY;
      if (ageDays >= SECOND_REMINDER_DAYS) {
        // Suppress duplicate reminders: only one second-reminder per
        // outstanding trigger.
        const alreadyReminded = existingEntries.some(
          (e) =>
            (e.kind && /second-reminder|second-level|14-day/i.test(e.kind)) ||
            (e.reason &&
              /second-reminder|second-level|14-day/i.test(e.reason)),
        );
        if (!alreadyReminded) {
          newEntries.push({
            entry_id: randomUUID(),
            kind: 'second-reminder',
            created_at: now.toISOString(),
            references_recommendation: latestRecommendation.entry_id || null,
            age_days: Math.floor(ageDays),
            message:
              '14-day second-level reminder: prior reengagement recommendation unaddressed for >=14 days. Operator action required.',
          });
        }
      }
    }
  }

  return newEntries;
}

// =============================================================================
// Main
// =============================================================================

function emitError(code, detail) {
  process.stderr.write(
    JSON.stringify({ error: code, detail: detail ?? null }) + '\n',
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.baseline || !args.recommendations) {
    emitError(
      'usage',
      'required: --baseline <path> --recommendations <path>',
    );
    process.exit(EXIT_USAGE);
  }

  if (!existsSync(args.baseline)) {
    emitError('baseline-missing', args.baseline);
    process.exit(EXIT_USAGE);
  }

  let baselineRaw;
  try {
    baselineRaw = readJson(args.baseline);
  } catch (err) {
    emitError(
      'baseline-unreadable',
      err instanceof Error ? err.message : String(err),
    );
    process.exit(EXIT_USAGE);
  }

  const validation = validateBaseline(baselineRaw);
  if (!validation.valid) {
    emitError('baseline-invalid', validation.error);
    process.exit(EXIT_VALIDATION_FAIL);
  }

  const recommendations = loadRecommendations(args.recommendations);
  const before = JSON.stringify(recommendations);

  const now = new Date();
  const newEntries = computeNewEntries(validation.data, recommendations, now);

  if (newEntries.length > 0) {
    recommendations.entries.push(...newEntries);
  }

  // Always write to ensure the file exists; unchanged content is harmless.
  writeJson(args.recommendations, recommendations);

  process.stdout.write(
    JSON.stringify({
      appended: newEntries.length,
      total_entries: recommendations.entries.length,
      baseline_effective_at: validation.data.effective_at ?? null,
    }) + '\n',
  );
  // Exit 0 whether or not entries changed (AC-20.5: monitor is idempotent).
  // Emit "changed=false" notice via log if unchanged.
  if (before === JSON.stringify(recommendations)) {
    process.stderr.write(
      JSON.stringify({
        event: 'no_recommendations_appended',
        baseline_effective_at: validation.data.effective_at ?? null,
      }) + '\n',
    );
  }
  process.exit(EXIT_OK);
}

main();
