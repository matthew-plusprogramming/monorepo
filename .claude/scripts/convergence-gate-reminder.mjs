#!/usr/bin/env node

/**
 * SubagentStop hook: Convergence Gate Reminder
 *
 * Reads SubagentStop event data from stdin and, based on the agent type,
 * outputs a JSON object with `additionalContext` reminding the main agent
 * to update the relevant convergence gate in the spec group manifest.
 *
 * Additionally, auto-updates the manifest convergence boolean when the
 * subagent completes with success status (or no status field for backwards
 * compatibility). Falls back to text-only reminder on any error (fail-open).
 *
 * Agent type -> convergence gate mapping:
 *   implementer       -> all_acs_implemented
 *   test-writer       -> all_tests_passing
 *   unifier           -> unifier_passed
 *   code-reviewer     -> code_review_passed
 *   security-reviewer -> security_review_passed
 *   browser-tester    -> browser_tests_passed
 *   documenter        -> docs_generated
 *
 * For any other agent type, outputs empty JSON ({}).
 *
 * Usage (via SubagentStop hook):
 *   echo '{"agent_type":"implementer"}' | node convergence-gate-reminder.mjs
 *
 * Exit codes:
 *   0 - Always (hooks must not block)
 *
 * Implements: REQ-1, AC1.1-AC1.10 from as-001-subagent-stop-hook
 * Implements: REQ-001, AC-1.1 through AC-1.9 from sg-manifest-prd-staleness-fix
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { findClaudeDir, loadSession } from './lib/hook-utils.mjs';

const GATE_MAP = {
  implementer: {
    field: 'all_acs_implemented',
    label: 'implementer',
  },
  'test-writer': {
    field: 'all_tests_passing',
    label: 'test-writer',
  },
  unifier: {
    field: 'unifier_passed',
    label: 'unifier',
  },
  'code-reviewer': {
    field: 'code_review_passed',
    label: 'code-reviewer',
  },
  'security-reviewer': {
    field: 'security_review_passed',
    label: 'security-reviewer',
  },
  'browser-tester': {
    field: 'browser_tests_passed',
    label: 'browser-tester',
  },
  documenter: {
    field: 'docs_generated',
    label: 'documenter',
  },
  'completion-verifier': {
    field: 'completion_verification_passed',
    label: 'completion-verifier',
  },
};

// 9 gate-result fields. The validate-convergence-fields.mjs script accepts a
// superset (11 fields) that includes convergence process fields
// (investigation_converged, challenger_converged) which are not individual gate results.
// GATE_MAP has 8 entries because spec_complete has no corresponding subagent
// (it is set by the spec-authoring workflow, not by a SubagentStop event).
const CANONICAL_FIELDS = [
  'spec_complete',
  'all_acs_implemented',
  'all_tests_passing',
  'unifier_passed',
  'code_review_passed',
  'security_review_passed',
  'browser_tests_passed',
  'docs_generated',
  'completion_verification_passed',
];

function buildReminder(agentType) {
  const gate = GATE_MAP[agentType];
  if (!gate) {
    return null;
  }

  return (
    `CONVERGENCE GATE REMINDER: The ${gate.label} subagent just completed. ` +
    `You should now update the spec group manifest's convergence object to set "${gate.field}": true. ` +
    `Find the active spec group manifest at .claude/specs/groups/<spec-group-id>/manifest.json and update the convergence object. ` +
    `The ${CANONICAL_FIELDS.length} canonical gate fields are: ${CANONICAL_FIELDS.join(', ')}.`
  );
}

async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');

    process.stdin.on('data', (chunk) => {
      data += chunk;
    });

    process.stdin.on('end', () => {
      resolve(data);
    });

    // If stdin is not piped / empty, resolve after a short timeout
    if (process.stdin.isTTY) {
      resolve('');
    }
  });
}

/** SEC-001: Validate spec_group_id format before using in file paths. */
const SPEC_GROUP_ID_PATTERN = /^sg-[a-z0-9-]+$/;

/**
 * Attempt to auto-update the manifest convergence boolean for the given gate.
 * Returns true if the update succeeded, false otherwise.
 * Never throws -- all errors are caught and logged to stderr.
 *
 * AC-1.1: Locate manifest via session.json active_work.spec_group_id
 * AC-1.4: Append decision_log entry with convergence_auto_updated action
 * AC-1.6: Fail-open on any error
 * AC-1.7: Fall back when session has no spec_group_id
 * AC-1.8: Fall back when spec_group_id fails format validation
 *
 * @param {object} gate - The GATE_MAP entry with field and label
 * @param {string} agentType - The subagent type string
 * @returns {boolean} true if manifest was successfully updated
 */
function tryUpdateManifest(gate, agentType) {
  try {
    const claudeDir = findClaudeDir(import.meta.url);
    const sessionPath = join(claudeDir, 'context', 'session.json');
    const session = loadSession(sessionPath);

    // AC-1.7: No session or no spec_group_id -- fall back
    if (!session || !session.active_work || !session.active_work.spec_group_id) {
      return false;
    }

    const specGroupId = session.active_work.spec_group_id;

    // AC-1.8: Validate spec_group_id format (SEC-001 path traversal prevention)
    if (!SPEC_GROUP_ID_PATTERN.test(specGroupId)) {
      process.stderr.write(
        `[convergence-gate-reminder] WARNING: Invalid spec_group_id format '${specGroupId}' -- manifest update skipped\n`
      );
      return false;
    }

    const manifestPath = join(claudeDir, 'specs', 'groups', specGroupId, 'manifest.json');

    if (!existsSync(manifestPath)) {
      return false;
    }

    // Read and parse manifest
    const manifestContent = readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestContent);

    // AC-1.1: Set convergence boolean
    if (!manifest.convergence) {
      manifest.convergence = {};
    }
    manifest.convergence[gate.field] = true;

    // AC-1.4: Append decision_log entry
    if (!Array.isArray(manifest.decision_log)) {
      manifest.decision_log = [];
    }
    manifest.decision_log.push({
      timestamp: new Date().toISOString(),
      actor: 'agent',
      action: 'convergence_auto_updated',
      details: `Auto-set convergence.${gate.field} = true after ${agentType} subagent completion.`,
    });

    manifest.updated_at = new Date().toISOString();

    // Atomic write: write to temp file then rename over original
    const tmpPath = manifestPath + '.tmp.' + process.pid;
    writeFileSync(tmpPath, JSON.stringify(manifest, null, 2) + '\n');
    renameSync(tmpPath, manifestPath);

    return true;
  } catch (err) {
    // AC-1.6: Fail-open on any error -- fall back to text-only reminder
    process.stderr.write(
      `[convergence-gate-reminder] WARNING: Manifest auto-update failed: ${err.message}\n`
    );
    return false;
  }
}

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
      // AC1.6: Malformed JSON -- no reminder
      console.log('{}');
      process.exit(0);
    }

    // AC1.2: Extract agent_type field (DEC-001)
    const agentType = input.agent_type || '';
    const gate = GATE_MAP[agentType];

    if (!gate) {
      // AC-1.9: Unmapped agent type -- output {} with no manifest interaction
      console.log('{}');
      process.exit(0);
    }

    // AC-1.2, AC-1.3: Check status field for manifest update eligibility
    // Absent/undefined status is treated as success (backwards compatibility)
    const status = input.status;
    const shouldUpdateManifest = status === undefined || status === 'success';

    if (shouldUpdateManifest) {
      // AC-1.1: Attempt manifest auto-update (fail-open via tryUpdateManifest)
      tryUpdateManifest(gate, agentType);
    }

    // AC-1.5: Always emit text reminder regardless of manifest update result
    const reminder = buildReminder(agentType);
    console.log(JSON.stringify({ additionalContext: reminder }));
  } catch {
    // AC1.7: Any unexpected error -- output empty JSON and exit cleanly
    console.log('{}');
  }

  process.exit(0);
}

main();
