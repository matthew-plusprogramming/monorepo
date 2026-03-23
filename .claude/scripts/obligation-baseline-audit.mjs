#!/usr/bin/env node

/**
 * Pre-Ship Baseline Audit: Status Obligation Drift
 *
 * Reads recent spec group manifests and runs validateObligations against each
 * phase that the manifest implies has been completed. Reports the baseline
 * drift rate (percentage of obligations that are not satisfied).
 *
 * Usage:
 *   node obligation-baseline-audit.mjs [--limit N]
 *
 *   --limit N  Maximum number of spec groups to audit (default: 10)
 *
 * Output: Summary table of drift by field to stderr.
 *
 * Implements: REQ-016 of sg-status-obligation-enforcement
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHASE_OBLIGATIONS, validateObligations } from './lib/workflow-dag.mjs';

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_LIMIT = 10;

// =============================================================================
// Utility
// =============================================================================

/**
 * Find the .claude directory by walking up from script location.
 */
function findClaudeDir() {
  const callerPath = fileURLToPath(import.meta.url);
  let currentDir = dirname(resolve(callerPath));
  const root = '/';

  while (currentDir !== root) {
    const claudeDir = join(currentDir, '.claude');
    if (existsSync(claudeDir)) {
      return claudeDir;
    }
    if (basename(currentDir) === '.claude') {
      return currentDir;
    }
    const parent = dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }

  return join(process.cwd(), '.claude');
}

/**
 * Infer completed phases from manifest state.
 * Uses work_state and convergence fields to determine which phases
 * the spec group has passed through.
 *
 * @param {object} manifest - Parsed manifest.json
 * @returns {string[]} Array of phase names that have been completed (exited)
 */
function inferCompletedPhases(manifest) {
  const completed = [];

  // Use work_state as a primary indicator of progress
  const workState = manifest.work_state;
  const reviewState = manifest.review_state;

  // If spec is APPROVED or beyond, spec_authoring and awaiting_approval are done
  if (reviewState === 'APPROVED') {
    completed.push('spec_authoring', 'awaiting_approval');
  } else if (reviewState === 'DRAFT' || reviewState === 'REVIEWED') {
    // Might still be in spec_authoring
    if (manifest.convergence?.spec_complete === true) {
      completed.push('spec_authoring');
    }
  }

  // If work is IMPLEMENTING or beyond, implementing phase entry happened
  if (workState === 'IMPLEMENTING' || workState === 'VERIFYING' || workState === 'READY_TO_MERGE' || workState === 'MERGED') {
    if (!completed.includes('implementing') && manifest.convergence?.all_acs_implemented === true) {
      completed.push('implementing');
    }
  }

  // If work is VERIFYING or beyond
  if (workState === 'VERIFYING' || workState === 'READY_TO_MERGE' || workState === 'MERGED') {
    if (manifest.convergence?.all_tests_passing === true) {
      completed.push('testing');
    }
    if (manifest.convergence?.unifier_passed === true) {
      completed.push('verifying');
    }
  }

  // If work is READY_TO_MERGE or beyond
  if (workState === 'READY_TO_MERGE' || workState === 'MERGED') {
    if (manifest.convergence?.code_review_passed === true && manifest.convergence?.security_review_passed === true) {
      completed.push('reviewing');
    }
    if (manifest.convergence?.completion_verification_passed === true) {
      completed.push('completion_verifying');
    }
    if (manifest.convergence?.docs_generated === true) {
      completed.push('documenting');
    }
  }

  return completed;
}

// =============================================================================
// Main
// =============================================================================

function main() {
  const args = process.argv.slice(2);
  let limit = DEFAULT_LIMIT;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && i + 1 < args.length) {
      limit = parseInt(args[i + 1], 10);
      if (isNaN(limit) || limit < 1) {
        console.error('Error: --limit must be a positive integer');
        process.exit(1);
      }
      i++;
    }
  }

  const claudeDir = findClaudeDir();
  const groupsDir = join(claudeDir, 'specs', 'groups');

  if (!existsSync(groupsDir)) {
    console.error('Error: No spec groups directory found.');
    process.exit(1);
  }

  // Collect spec groups with manifests, sorted by most recent
  const entries = readdirSync(groupsDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => {
      const manifestPath = join(groupsDir, e.name, 'manifest.json');
      if (!existsSync(manifestPath)) return null;
      try {
        const stat = statSync(manifestPath);
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        return { id: e.name, manifestPath, manifest, mtime: stat.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);

  if (entries.length === 0) {
    console.error('No spec group manifests found to audit.');
    process.exit(0);
  }

  // Run audit
  let totalObligations = 0;
  let totalViolations = 0;
  const fieldStats = {}; // field -> { checked: number, violated: number }
  const groupResults = [];

  for (const entry of entries) {
    const completedPhases = inferCompletedPhases(entry.manifest);
    const groupViolations = [];

    for (const phase of completedPhases) {
      const result = validateObligations(phase, entry.manifest);
      const obligations = PHASE_OBLIGATIONS[phase] || [];
      totalObligations += obligations.length;

      for (const obligation of obligations) {
        if (!fieldStats[obligation.field]) {
          fieldStats[obligation.field] = { checked: 0, violated: 0 };
        }
        fieldStats[obligation.field].checked++;
      }

      for (const v of result.violations) {
        totalViolations++;
        if (fieldStats[v.field]) {
          fieldStats[v.field].violated++;
        }
        groupViolations.push({ phase, field: v.field, expected: v.expected, actual: v.actual });
      }
    }

    groupResults.push({
      id: entry.id,
      phases_checked: completedPhases.length,
      violations: groupViolations.length,
      details: groupViolations,
    });
  }

  // Output results
  const driftRate = totalObligations > 0 ? ((totalViolations / totalObligations) * 100).toFixed(1) : '0.0';

  console.error('\n=== Status Obligation Baseline Audit ===\n');
  console.error(`Spec groups audited: ${entries.length}`);
  console.error(`Total obligations checked: ${totalObligations}`);
  console.error(`Total violations found: ${totalViolations}`);
  console.error(`Baseline drift rate: ${driftRate}%\n`);

  // Field-level breakdown
  console.error('Field-level drift:');
  console.error('  Field                                         Checked  Violated  Drift%');
  console.error('  ' + '-'.repeat(74));

  for (const [field, stats] of Object.entries(fieldStats).sort((a, b) => b[1].violated - a[1].violated)) {
    const fieldDrift = stats.checked > 0 ? ((stats.violated / stats.checked) * 100).toFixed(1) : '0.0';
    const paddedField = field.padEnd(46);
    const paddedChecked = String(stats.checked).padStart(7);
    const paddedViolated = String(stats.violated).padStart(8);
    console.error(`  ${paddedField}${paddedChecked}${paddedViolated}  ${fieldDrift}%`);
  }

  console.error('');

  // Per-group breakdown
  console.error('Per-group results:');
  for (const g of groupResults) {
    const status = g.violations === 0 ? 'CLEAN' : `${g.violations} violation(s)`;
    console.error(`  ${g.id}: ${g.phases_checked} phases checked, ${status}`);
    for (const d of g.details) {
      console.error(`    - [${d.phase}] ${d.field}: expected ${JSON.stringify(d.expected)}, actual ${d.actual === null ? 'null (not set)' : JSON.stringify(d.actual)}`);
    }
  }

  console.error('\n=== End Baseline Audit ===\n');

  // Output machine-readable summary to stdout
  const summary = {
    audited_count: entries.length,
    total_obligations: totalObligations,
    total_violations: totalViolations,
    drift_rate_pct: parseFloat(driftRate),
    field_stats: fieldStats,
    group_results: groupResults.map(g => ({
      id: g.id,
      phases_checked: g.phases_checked,
      violations: g.violations,
    })),
  };
  console.log(JSON.stringify(summary, null, 2));
}

main();
