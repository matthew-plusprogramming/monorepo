#!/usr/bin/env node

/**
 * @deprecated Replaced by coercive enforcement hooks:
 *   - workflow-gate-enforcement.mjs (PreToolUse Agent hook -- blocks dispatch)
 *   - workflow-stop-enforcement.mjs (Stop hook -- blocks session completion)
 *
 * This advisory SubagentStop hook has been removed from settings.json.
 * It is preserved for reference only. The MANDATORY_DISPATCHES map and
 * dispatch-checking logic have been migrated to:
 *   - .claude/scripts/lib/workflow-dag.mjs (shared constants)
 *   - .claude/scripts/workflow-stop-enforcement.mjs (coercive stop enforcement)
 *
 * See spec: sg-coercive-gate-enforcement, REQ-036
 *
 * --- Original documentation below ---
 *
 * SubagentStop Hook: Workflow Enforcement Check (DEPRECATED)
 *
 * Reads session state to determine the current workflow type and phase,
 * and checks whether mandatory subagent types for the current phase
 * have been dispatched. Emits advisory warnings for missing dispatches.
 *
 * This hook is READ-ONLY against session.json (no writes).
 * SubagentStop hooks cannot block -- all output is advisory.
 *
 * Implements: REQ-015, REQ-016, REQ-017
 *
 * Input: stdin (subagent output JSON from Claude Code)
 * Output: stdout (JSON with additionalContext if warnings, else {})
 * Exit code: Always 0 (advisory only)
 *
 * Usage (via SubagentStop hook):
 *   echo '{"agent_type":"implementer"}' | node workflow-enforcement-check.mjs
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

// Workflow types exempt from enforcement (REQ-013)
const EXEMPT_WORKFLOWS = ['oneoff-vibe', 'refactor'];

// Mandatory dispatches per phase per workflow (mirrors session-checkpoint.mjs)
const MANDATORY_DISPATCHES = {
  orchestrator: {
    'implementing': [{ type: 'challenger', stage: 'pre-orchestration' }],
    'testing': [{ type: 'challenger', stage: 'pre-test' }],
    'reviewing': [{ type: 'challenger', stage: 'pre-review' }, { type: 'code-reviewer' }],
    'complete': [{ type: 'completion-verifier' }, { type: 'documenter' }],
  },
  'oneoff-spec': {
    'implementing': [{ type: 'challenger', stage: 'pre-implementation' }],
    'testing': [{ type: 'challenger', stage: 'pre-test' }],
    'reviewing': [{ type: 'challenger', stage: 'pre-review' }, { type: 'code-reviewer' }],
    'complete': [{ type: 'completion-verifier' }, { type: 'documenter' }],
  },
};

/**
 * Find the .claude directory by walking up from script location (REQ-016).
 * Replicates findClaudeDir() from session-checkpoint.mjs.
 */
function findClaudeDir() {
  let currentDir = dirname(resolve(import.meta.url.replace('file://', '')));
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
 * Load session.json with graceful degradation (REQ-017).
 * Returns null on any read failure.
 */
function loadSession() {
  try {
    const claudeDir = findClaudeDir();
    const sessionPath = join(claudeDir, 'context', 'session.json');

    if (!existsSync(sessionPath)) {
      return null;
    }

    const content = readFileSync(sessionPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Read stdin for SubagentStop event data.
 */
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

    if (process.stdin.isTTY) {
      resolve('');
    }
  });
}

/**
 * Check mandatory dispatches for the current phase (REQ-015).
 * Returns an array of warning strings for missing dispatches.
 */
function checkMandatoryDispatches(session) {
  const warnings = [];

  const workflow = session?.active_work?.workflow;
  if (!workflow) return warnings;

  // Exempt workflows skip enforcement
  if (EXEMPT_WORKFLOWS.includes(workflow)) return warnings;

  // Check enforcement level
  const enforcementLevel = session?.phase_checkpoint?.enforcement_level || 'graduated';
  if (enforcementLevel === 'off') return warnings;

  const currentPhase = session?.active_work?.current_phase;
  if (!currentPhase) return warnings;

  const workflowDispatches = MANDATORY_DISPATCHES[workflow] || MANDATORY_DISPATCHES['orchestrator'];
  const requiredForPhase = workflowDispatches[currentPhase];

  if (!requiredForPhase || requiredForPhase.length === 0) return warnings;

  const allTasks = [
    ...(session.subagent_tasks?.in_flight || []),
    ...(session.subagent_tasks?.completed_this_session || [])
  ];

  for (const required of requiredForPhase) {
    let dispatched;

    if (required.stage) {
      // Per-stage challenger dispatch check (REQ-011)
      dispatched = allTasks.some(
        t => t.subagent_type === required.type && t.stage === required.stage
      );
    } else {
      dispatched = allTasks.some(t => t.subagent_type === required.type);
    }

    if (!dispatched) {
      const label = required.stage
        ? `${required.type} (stage: ${required.stage})`
        : required.type;
      warnings.push(
        `Phase '${currentPhase}' expects '${label}' dispatch before proceeding.`
      );
    }
  }

  return warnings;
}

async function main() {
  try {
    // Read stdin (SubagentStop event data)
    await readStdin();

    // Load session with graceful degradation (REQ-017)
    const session = loadSession();

    if (!session) {
      // Cannot read session state -- graceful degradation
      // Do not emit warning for missing session (common in oneoff-vibe)
      console.log('{}');
      process.exit(0);
    }

    // Check mandatory dispatches
    const warnings = checkMandatoryDispatches(session);

    if (warnings.length > 0) {
      const context = 'WORKFLOW ENFORCEMENT: ' + warnings.join(' ');
      console.log(JSON.stringify({ additionalContext: context }));
    } else {
      console.log('{}');
    }
  } catch {
    // REQ-017: Any unexpected error -- graceful degradation
    console.log('{}');
  }

  process.exit(0);
}

main();
