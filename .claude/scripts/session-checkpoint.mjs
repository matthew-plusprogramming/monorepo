#!/usr/bin/env node

/**
 * Session Checkpoint Utility
 *
 * Provides atomic updates to session.json for tracking orchestration state.
 * All operations are read-modify-write atomic to prevent corruption.
 *
 * Operations:
 *   init                                          - Initialize session.json if it doesn't exist
 *   start-work <spec_group_id> <workflow> <obj>   - Start tracking work on a spec group
 *   transition-phase <new_phase>                  - Update current phase (with DAG enforcement)
 *   complete-atomic-spec <atomic_spec_id>         - Mark an atomic spec as done
 *   dispatch-subagent <id> <type> <desc> [--stage]- Track subagent dispatch (--stage for challengers)
 *   complete-subagent <task_id> <result_summary>  - Mark subagent as complete
 *   journal-created <path-to-journal>             - Mark journal entry as created
 *   override-skip --phase <p> --rationale "<r>"   - Override a phase skip block (main-agent-only)
 *   reset-enforcement --rationale "<r>"           - Reset all skip counters (main-agent-only)
 *   set-enforcement-level <level>                 - Change enforcement level (main-agent-only)
 *   complete-work                                 - Finalize completed work (with completion checklist)
 *   archive-incomplete                            - Archive incomplete work to history
 *   get-status                                    - Output current session state summary (JSON)
 *
 * Usage:
 *   node session-checkpoint.mjs <operation> [args...]
 *
 * Exit codes:
 *   0 - Success
 *   1 - Validation or operational error
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import {
  ORCHESTRATOR_PREDECESSORS,
  ONEOFF_SPEC_PREDECESSORS,
  EXEMPT_WORKFLOWS,
  VALID_SUBAGENT_TYPES,
  MANDATORY_DISPATCHES,
  REQUIRED_CHALLENGER_STAGES,
  VALID_CONVERGENCE_GATES,
  getWorkflowType,
  getPredecessorGraph,
  wasPredecessorVisited,
  validateObligations,
} from './lib/workflow-dag.mjs';
import {
  loadOverrides,
  findMatchingOverride,
} from './lib/hook-utils.mjs';

// Schema version for session.json
const SESSION_VERSION = '1.0.0';

// Valid phases for workflow lifecycle
const VALID_PHASES = [
  'prd_gathering',
  'spec_authoring',
  'atomizing',
  'enforcing',
  'investigating',
  'awaiting_approval',  // Kept for backwards compatibility (AC-1.12)
  'auto_approval',      // AC-1.9: New transitional phase replacing awaiting_approval
  'implementing',
  'testing',
  'verifying',
  'reviewing',
  'journaling',
  'complete',
  'challenging',
  'completion_verifying',
  'documenting'
];

// Valid workflow types
const VALID_WORKFLOWS = [
  'oneoff-vibe',
  'oneoff-spec',
  'orchestrator',
  'refactor',
  'journal-only'
];

// Valid challenger stage values (REQ-003, DEC-004)
const VALID_STAGES = [
  'pre-implementation',
  'pre-test',
  'pre-review',
  'pre-orchestration'
];

// VALID_SUBAGENT_TYPES imported from ./lib/workflow-dag.mjs

// =============================================================================
// Workflow Enforcement: DAG constants and query functions imported from shared module
// (ORCHESTRATOR_PREDECESSORS, ONEOFF_SPEC_PREDECESSORS, EXEMPT_WORKFLOWS,
//  MANDATORY_DISPATCHES, REQUIRED_CHALLENGER_STAGES imported from ./lib/workflow-dag.mjs)
// =============================================================================

// Per-session override cap shared between override-skip and reset-enforcement (REQ-008, REQ-009)
const MAX_OVERRIDES_PER_SESSION = 3;

// Valid enforcement levels (REQ-010)
const VALID_ENFORCEMENT_LEVELS = ['off', 'warn-only', 'graduated'];

// Magic constant for enforcement_counter integrity checksum (REQ-012, EC-9)
const COUNTER_CHECKSUM_MAGIC = 0xA3F5;

/**
 * Compute a simple checksum for the enforcement_counter to detect out-of-band edits.
 * Returns the expected _counter_checksum value for a given counter.
 */
function computeCounterChecksum(counter) {
  return (counter ^ COUNTER_CHECKSUM_MAGIC);
}

/**
 * Verify enforcement_counter integrity by comparing stored checksum (REQ-012, EC-9).
 * If mismatch detected, emits a warning and degrades enforcement to warn-only mode.
 * Returns true if integrity check passed, false if mismatch detected.
 */
function verifyCounterIntegrity(session) {
  const checkpoint = session.phase_checkpoint;
  if (!checkpoint || checkpoint.enforcement_counter === undefined) {
    return true; // No counter to verify
  }
  const storedChecksum = checkpoint._counter_checksum;
  if (storedChecksum === undefined) {
    // No checksum yet (legacy session) -- initialize it
    checkpoint._counter_checksum = computeCounterChecksum(checkpoint.enforcement_counter);
    return true;
  }
  const expectedChecksum = computeCounterChecksum(checkpoint.enforcement_counter);
  if (storedChecksum !== expectedChecksum) {
    console.error(
      'Warning: Enforcement state integrity check failed: monotonic counter mismatch. ' +
      'Out-of-band session.json edit detected. Degrading to warn-only mode.'
    );
    checkpoint.enforcement_level = 'warn-only';
    // Re-sync checksum to current counter value so future operations are not stuck
    checkpoint._counter_checksum = expectedChecksum;
    return false;
  }
  return true;
}

// MANDATORY_DISPATCHES and REQUIRED_CHALLENGER_STAGES imported from ./lib/workflow-dag.mjs

// getPredecessorGraph and getWorkflowType imported from ./lib/workflow-dag.mjs

/**
 * Get enforcement level from session, with backward-compatible default.
 */
function getEnforcementLevel(session) {
  return session?.phase_checkpoint?.enforcement_level || 'graduated';
}

// wasPredecessorVisited imported from ./lib/workflow-dag.mjs

/**
 * Check if the main agent is calling (no subagents in-flight).
 * Used for access control on override-skip, reset-enforcement, enforcement level changes.
 */
function isMainAgent(session) {
  return (session.subagent_tasks?.in_flight || []).length === 0;
}

/**
 * Find the .claude directory by walking up from script location.
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

const CLAUDE_DIR = findClaudeDir();
const CONTEXT_DIR = join(CLAUDE_DIR, 'context');
const SESSION_PATH = join(CONTEXT_DIR, 'session.json');

/**
 * Get current ISO 8601 timestamp.
 */
function now() {
  return new Date().toISOString();
}

/**
 * Generate a unique task ID.
 */
function generateTaskId() {
  return `task-${randomUUID()}`;
}

/**
 * Ensure the context directory exists.
 */
function ensureContextDir() {
  if (!existsSync(CONTEXT_DIR)) {
    mkdirSync(CONTEXT_DIR, { recursive: true });
  }
}

/**
 * Load session.json, returning null if it doesn't exist.
 */
function loadSession() {
  if (!existsSync(SESSION_PATH)) {
    return null;
  }

  try {
    const content = readFileSync(SESSION_PATH, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    console.error(`Error loading session.json: ${err.message}`);
    return null;
  }
}

/**
 * Save session.json atomically using write-to-temp-then-rename pattern (AC-1.9).
 * Writes to a temporary file first, then atomically renames to prevent partial writes.
 */
function saveSession(session) {
  ensureContextDir();
  session.updated_at = now();
  const data = JSON.stringify(session, null, 2) + '\n';
  const tempPath = SESSION_PATH + '.tmp.' + process.pid;
  writeFileSync(tempPath, data);
  renameSync(tempPath, SESSION_PATH);
}

/**
 * Create a new empty session object.
 */
function createEmptySession() {
  return {
    version: SESSION_VERSION,
    updated_at: now(),
    active_work: null,
    phase_checkpoint: null,
    subagent_tasks: {
      in_flight: [],
      completed_this_session: []
    },
    history: []
  };
}

/**
 * Add a history entry to the session.
 */
function addHistoryEntry(session, eventType, details = {}) {
  session.history.push({
    timestamp: now(),
    event_type: eventType,
    details
  });
}

/**
 * Validate phase is a valid phase enum value.
 */
function validatePhase(phase) {
  if (!VALID_PHASES.includes(phase)) {
    throw new Error(`Invalid phase '${phase}'. Valid phases: ${VALID_PHASES.join(', ')}`);
  }
}

/**
 * Validate workflow is a valid workflow enum value.
 */
function validateWorkflow(workflow) {
  if (!VALID_WORKFLOWS.includes(workflow)) {
    throw new Error(`Invalid workflow '${workflow}'. Valid workflows: ${VALID_WORKFLOWS.join(', ')}`);
  }
}

/**
 * Validate subagent type is a valid enum value.
 */
function validateSubagentType(type) {
  if (!VALID_SUBAGENT_TYPES.includes(type)) {
    throw new Error(`Invalid subagent type '${type}'. Valid types: ${VALID_SUBAGENT_TYPES.join(', ')}`);
  }
}

/**
 * Validate spec group ID format.
 */
function validateSpecGroupId(id) {
  if (!id || !/^sg-[a-z0-9-]+$/.test(id)) {
    throw new Error(`Invalid spec_group_id '${id}'. Must match pattern 'sg-[a-z0-9-]+'`);
  }
}

/**
 * Validate atomic spec ID format.
 */
function validateAtomicSpecId(id) {
  if (!id || !/^as-[0-9]{3}(-[a-z0-9-]+)?$/.test(id)) {
    throw new Error(`Invalid atomic_spec_id '${id}'. Must match pattern 'as-NNN' or 'as-NNN-slug'`);
  }
}

// =============================================================================
// Operations
// =============================================================================

/**
 * init - Initialize session.json if it doesn't exist.
 */
function opInit() {
  ensureContextDir();

  if (existsSync(SESSION_PATH)) {
    const session = loadSession();
    if (session) {
      console.error('session.json already exists and is valid.');
      return;
    }
    // File exists but is invalid - recreate
    console.error('session.json exists but is invalid. Recreating...');
  }

  const session = createEmptySession();
  addHistoryEntry(session, 'session_start', {
    message: 'Session initialized'
  });
  saveSession(session);
  console.error(`Initialized session.json at ${SESSION_PATH}`);
}

/**
 * start-work - Start tracking work on a spec group.
 */
function opStartWork(specGroupId, workflow, objective) {
  if (!specGroupId || !workflow || !objective) {
    throw new Error('Usage: start-work <spec_group_id> <workflow> <objective>');
  }

  validateSpecGroupId(specGroupId);
  validateWorkflow(workflow);

  let session = loadSession();
  if (!session) {
    session = createEmptySession();
  }

  // Check if there's already active work
  if (session.active_work) {
    throw new Error(
      `Active work already exists for '${session.active_work.spec_group_id}'. ` +
      `Use 'complete-work' or 'archive-incomplete' first.`
    );
  }

  // Determine initial phase based on workflow
  let initialPhase;
  switch (workflow) {
    case 'oneoff-vibe':
      initialPhase = 'implementing';
      break;
    case 'oneoff-spec':
    case 'orchestrator':
      initialPhase = 'prd_gathering';
      break;
    case 'refactor':
      initialPhase = 'spec_authoring';
      break;
    case 'journal-only':
      initialPhase = 'journaling';
      break;
    default:
      initialPhase = 'prd_gathering';
  }

  session.active_work = {
    spec_group_id: specGroupId,
    workflow,
    current_phase: initialPhase,
    objective
  };

  session.phase_checkpoint = {
    phase: initialPhase,
    atomic_specs_completed: [],
    atomic_specs_pending: [],
    next_actions: [],
    // Enforcement fields (REQ-005) -- backward-compatible defaults
    phase_skip_warnings: {},
    enforcement_counter: 0,
    _counter_checksum: computeCounterChecksum(0),
    enforcement_level: 'graduated',
    override_count: 0
  };

  // Initialize journal tracking fields for journal-only workflow
  if (workflow === 'journal-only') {
    session.phase_checkpoint.journal_required = true;
    session.phase_checkpoint.journal_created = false;
    session.phase_checkpoint.journal_entry_path = null;
  }

  addHistoryEntry(session, 'work_started', {
    spec_group_id: specGroupId,
    workflow,
    message: `Started work: ${objective}`
  });

  saveSession(session);
  console.error(`Started work on '${specGroupId}' with workflow '${workflow}'`);
}

/**
 * transition-phase - Update current phase.
 */
function opTransitionPhase(newPhase) {
  if (!newPhase) {
    throw new Error('Usage: transition-phase <new_phase>');
  }

  validatePhase(newPhase);

  const session = loadSession();
  if (!session) {
    throw new Error('No session.json exists. Run "init" first.');
  }

  if (!session.active_work) {
    throw new Error('No active work. Run "start-work" first.');
  }

  const oldPhase = session.active_work.current_phase;

  // Warn if transitioning from journaling to complete without journal created
  if (oldPhase === 'journaling' && newPhase === 'complete') {
    if (session.phase_checkpoint?.journal_required === true &&
        session.phase_checkpoint?.journal_created !== true) {
      console.error(
        `Warning: Transitioning from 'journaling' to 'complete' but journal_created is not true. ` +
        `A journal entry should be created before completing journal-only workflow.`
      );
    }
  }

  // --- DAG-based predecessor validation (DEC-001: replaces linear index ordering) ---
  const workflow = getWorkflowType(session);
  const enforcementLevel = getEnforcementLevel(session);

  // Ensure enforcement fields exist (backward compatibility)
  if (!session.phase_checkpoint.phase_skip_warnings) {
    session.phase_checkpoint.phase_skip_warnings = {};
  }
  if (session.phase_checkpoint.enforcement_counter === undefined) {
    session.phase_checkpoint.enforcement_counter = 0;
    session.phase_checkpoint._counter_checksum = computeCounterChecksum(0);
  }

  // Verify enforcement_counter integrity before processing (REQ-012, EC-9)
  verifyCounterIntegrity(session);
  // Re-read enforcement level in case integrity check degraded it to warn-only
  const effectiveEnforcementLevel = getEnforcementLevel(session);

  // Check enforcement: exempt workflows skip entirely (REQ-013)
  if (!EXEMPT_WORKFLOWS.includes(workflow) && effectiveEnforcementLevel !== 'off') {
    const graph = getPredecessorGraph(workflow);

    if (graph) {
      // Find all mandatory predecessors for the target phase
      const predecessors = graph[newPhase] || [];
      const skippedPredecessors = [];

      for (const pred of predecessors) {
        if (!wasPredecessorVisited(pred, session)) {
          skippedPredecessors.push(pred);
        }
      }

      if (skippedPredecessors.length > 0) {
        // Format skipped predecessors for human-readable output
        const skippedNames = skippedPredecessors.map(p => {
          const match = p.match(/^challenging:(.+)$/);
          return match ? `challenging (${match[1]})` : p;
        });

        // Check if any of these have been warned about before (graduated enforcement)
        let shouldBlock = false;

        for (const pred of skippedPredecessors) {
          const currentCount = session.phase_checkpoint.phase_skip_warnings[pred] || 0;

          if (currentCount > 0 && effectiveEnforcementLevel === 'graduated') {
            // Repeated skip in graduated mode: block (REQ-007)
            shouldBlock = true;
          }

          // Increment skip counter
          session.phase_checkpoint.phase_skip_warnings[pred] = currentCount + 1;
          session.phase_checkpoint.enforcement_counter++;
          session.phase_checkpoint._counter_checksum = computeCounterChecksum(session.phase_checkpoint.enforcement_counter);
        }

        if (shouldBlock) {
          // Save updated counters before blocking
          saveSession(session);
          console.error(
            `Error: Mandatory predecessor phase(s) skipped repeatedly: ${skippedNames.join(', ')}. ` +
            `Cannot transition to '${newPhase}'. Use 'override-skip' to bypass or 'reset-enforcement' to clear.`
          );
          process.exit(1);
        }

        // First occurrence: warn but allow (REQ-007)
        console.error(
          `Warning: Skipping mandatory predecessor phase(s) for '${newPhase}': ${skippedNames.join(', ')}. ` +
          `Transition allowed (first occurrence). Repeated skips will be blocked.`
        );
      }
    }
  }
  // --- End DAG validation ---

  // --- Obligation validation (status-obligation-enforcement) ---
  // Check outgoing phase obligations BEFORE executing the transition.
  // Runs after DAG validation so predecessor violations are caught first.
  // Implements: REQ-003, REQ-004, REQ-005, REQ-008, REQ-009, REQ-010, REQ-013, REQ-014, REQ-015
  const killSwitchPath = join(CLAUDE_DIR, 'coordination', 'gate-enforcement-disabled');
  const killSwitchActive = existsSync(killSwitchPath);
  if (!EXEMPT_WORKFLOWS.includes(workflow) && effectiveEnforcementLevel !== 'off' && !killSwitchActive) {
    const specGroupId = session.active_work?.spec_group_id;
    if (specGroupId) {
      const manifestPath = join(CLAUDE_DIR, 'specs', 'groups', specGroupId, 'manifest.json');

      try {
        if (existsSync(manifestPath)) {
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

          // Check for phase-scoped override (REQ-014)
          // CR-M1: Use shared loadOverrides/findMatchingOverride from hook-utils.mjs
          // session-checkpoint.mjs is a CLI utility, not a hook, so no stdin data.
          // Use active_work.spec_group_id as session identifier for override matching (AC-8.5).
          const overrideGateName = `status_obligations:${oldPhase}`;
          let overrideActive = false;

          const overridePath = join(CLAUDE_DIR, 'coordination', 'gate-override.json');
          const overrideList = loadOverrides(overridePath);
          if (overrideList) {
            const matchingOverride = findMatchingOverride(overrideList, overrideGateName, specGroupId);
            if (matchingOverride) {
              overrideActive = true;
            }
          }

          if (overrideActive) {
            // AC-9.4: Record overridden event for each obligation
            const result = validateObligations(oldPhase, manifest);
            for (const v of result.violations) {
              addHistoryEntry(session, 'obligation_violation', {
                phase: oldPhase,
                field: v.field,
                expected_value: v.expected,
                actual_value: v.actual,
                resolution: 'overridden',
              });
            }
          } else {
            // AC-9.3: Check if this is a successful re-attempt after a previous block
            const hadPriorBlock = (session.history || []).some(
              h => h.event_type === 'obligation_violation' &&
                   h.details?.phase === oldPhase &&
                   h.details?.resolution === 'blocked'
            );

            const result = validateObligations(oldPhase, manifest);

            if (!result.passed) {
              // Record violation events (REQ-015: written by enforcement script, not agent)
              for (const v of result.violations) {
                addHistoryEntry(session, 'obligation_violation', {
                  phase: oldPhase,
                  field: v.field,
                  expected_value: v.expected,
                  actual_value: v.actual,
                  resolution: effectiveEnforcementLevel === 'graduated' ? 'blocked' : 'warned',
                });
              }

              if (effectiveEnforcementLevel === 'graduated') {
                // AC-4.4: Block immediately on first occurrence (no grace period)
                saveSession(session);
                const violationLines = result.violations.map(
                  v => `  - ${v.field}: expected ${JSON.stringify(v.expected)}, actual ${v.actual === null ? 'null (not set)' : JSON.stringify(v.actual)}`
                ).join('\n');
                console.error(
                  `Error: Manifest status obligations not satisfied for phase '${oldPhase}'.\n` +
                  `Manifest status inconsistency:\n${violationLines}\n` +
                  `Update the manifest fields listed above before transitioning from '${oldPhase}'.`
                );
                process.exit(1);
              } else {
                // warn-only: emit warning, allow transition (AC-4.2)
                const violationLines = result.violations.map(
                  v => `  - ${v.field}: expected ${JSON.stringify(v.expected)}, actual ${v.actual === null ? 'null (not set)' : JSON.stringify(v.actual)}`
                ).join('\n');
                console.error(
                  `Warning: Manifest status obligations not satisfied for phase '${oldPhase}'.\n` +
                  `Manifest status inconsistency:\n${violationLines}\n` +
                  `Transition allowed (warn-only mode).`
                );
              }
            } else if (hadPriorBlock) {
              // AC-9.3: Successful re-attempt after prior block -- record "updated" events
              // The obligations for this phase now all pass after agent corrected the manifest
              const priorViolations = (session.history || []).filter(
                h => h.event_type === 'obligation_violation' &&
                     h.details?.phase === oldPhase &&
                     h.details?.resolution === 'blocked'
              );
              // Record one "updated" event per field that was previously blocked
              const seenFields = new Set();
              for (const h of priorViolations) {
                const fieldName = h.details?.field;
                if (fieldName && !seenFields.has(fieldName)) {
                  seenFields.add(fieldName);
                  addHistoryEntry(session, 'obligation_violation', {
                    phase: oldPhase,
                    field: fieldName,
                    expected_value: h.details?.expected_value,
                    actual_value: h.details?.expected_value, // now matches expected
                    resolution: 'updated',
                  });
                }
              }
            }
          }
        } else {
          // AC-7.1: Missing manifest file -- fail-open with warning
          console.error(`Warning: Obligation validation skipped -- manifest not found at ${manifestPath}`);
        }
      } catch (err) {
        // AC-7.2: Fail-open on structural errors (malformed JSON, read failure) (REQ-010)
        console.error(`Warning: Obligation validation skipped (structural error): ${err.message}`);
      }
    }
    // No spec_group_id: skip silently (REQ-009, AC-6.5)
  }
  // --- End obligation validation ---

  session.active_work.current_phase = newPhase;
  session.phase_checkpoint.phase = newPhase;

  // Clear next_actions on phase transition (they'll need to be re-evaluated)
  session.phase_checkpoint.next_actions = [];

  addHistoryEntry(session, 'phase_transition', {
    from_phase: oldPhase,
    to_phase: newPhase,
    spec_group_id: session.active_work.spec_group_id,
    message: `Phase transition: ${oldPhase} -> ${newPhase}`
  });

  saveSession(session);
  console.error(`Transitioned from '${oldPhase}' to '${newPhase}'`);
}

/**
 * complete-atomic-spec - Mark an atomic spec as done.
 */
function opCompleteAtomicSpec(atomicSpecId) {
  if (!atomicSpecId) {
    throw new Error('Usage: complete-atomic-spec <atomic_spec_id>');
  }

  validateAtomicSpecId(atomicSpecId);

  const session = loadSession();
  if (!session) {
    throw new Error('No session.json exists. Run "init" first.');
  }

  if (!session.active_work) {
    throw new Error('No active work. Run "start-work" first.');
  }

  if (!session.phase_checkpoint) {
    throw new Error('No phase checkpoint. This should not happen.');
  }

  // Check if already completed
  if (session.phase_checkpoint.atomic_specs_completed.includes(atomicSpecId)) {
    console.error(`Atomic spec '${atomicSpecId}' is already marked as completed.`);
    return;
  }

  // Remove from pending if present
  const pendingIndex = session.phase_checkpoint.atomic_specs_pending.indexOf(atomicSpecId);
  if (pendingIndex !== -1) {
    session.phase_checkpoint.atomic_specs_pending.splice(pendingIndex, 1);
  }

  // Add to completed
  session.phase_checkpoint.atomic_specs_completed.push(atomicSpecId);

  addHistoryEntry(session, 'checkpoint_saved', {
    spec_group_id: session.active_work.spec_group_id,
    message: `Completed atomic spec: ${atomicSpecId}`
  });

  saveSession(session);
  console.error(`Marked atomic spec '${atomicSpecId}' as completed.`);
}

/**
 * dispatch-subagent - Track subagent dispatch.
 *
 * Supports optional --stage flag for challenger subagent dispatches (DEC-004).
 * Usage: dispatch-subagent <task_id> <type> <description> [--stage <stage>]
 */
function opDispatchSubagent(taskId, subagentType, description, stage) {
  if (!subagentType || !description) {
    throw new Error('Usage: dispatch-subagent <task_id> <subagent_type> <description> [--stage <stage>]');
  }

  // If taskId not provided, generate one
  const finalTaskId = taskId || generateTaskId();

  validateSubagentType(subagentType);

  // Validate stage if provided (REQ-003)
  if (stage) {
    if (!VALID_STAGES.includes(stage)) {
      throw new Error(`Invalid stage '${stage}'. Valid stages: ${VALID_STAGES.join(', ')}`);
    }
  }

  const session = loadSession();
  if (!session) {
    throw new Error('No session.json exists. Run "init" first.');
  }

  // Check for duplicate task_id
  const existingInFlight = session.subagent_tasks.in_flight.find(t => t.task_id === finalTaskId);
  const existingCompleted = session.subagent_tasks.completed_this_session.find(t => t.task_id === finalTaskId);

  if (existingInFlight || existingCompleted) {
    throw new Error(`Task with ID '${finalTaskId}' already exists.`);
  }

  const task = {
    task_id: finalTaskId,
    subagent_type: subagentType,
    description,
    dispatched_at: now(),
    completed_at: null,
    status: 'in_flight',
    result_summary: null,
    spec_group_id: session.active_work?.spec_group_id || null,
    atomic_spec_id: null
  };

  // Store stage on dispatch record for challenger subagents (REQ-003, DEC-004)
  if (stage) {
    task.stage = stage;
  }

  session.subagent_tasks.in_flight.push(task);

  const historyDetails = {
    task_id: finalTaskId,
    subagent_type: subagentType,
    spec_group_id: session.active_work?.spec_group_id,
    message: `Dispatched ${subagentType}: ${description}`
  };

  // Include stage in history for traceability
  if (stage) {
    historyDetails.stage = stage;
    historyDetails.message = `Dispatched ${subagentType} (stage: ${stage}): ${description}`;
  }

  addHistoryEntry(session, 'subagent_dispatched', historyDetails);

  saveSession(session);
  console.error(`Dispatched subagent '${subagentType}' with task_id '${finalTaskId}'${stage ? ` (stage: ${stage})` : ''}`);
}

/**
 * complete-subagent - Mark subagent as complete.
 */
function opCompleteSubagent(taskId, resultSummary) {
  if (!taskId) {
    throw new Error('Usage: complete-subagent <task_id> <result_summary>');
  }

  const session = loadSession();
  if (!session) {
    throw new Error('No session.json exists. Run "init" first.');
  }

  // Find task in in_flight
  const taskIndex = session.subagent_tasks.in_flight.findIndex(t => t.task_id === taskId);

  if (taskIndex === -1) {
    // Check if already completed
    const completedTask = session.subagent_tasks.completed_this_session.find(t => t.task_id === taskId);
    if (completedTask) {
      console.error(`Task '${taskId}' is already completed.`);
      return;
    }
    throw new Error(`Task '${taskId}' not found in in_flight tasks.`);
  }

  const task = session.subagent_tasks.in_flight[taskIndex];

  // Remove from in_flight
  session.subagent_tasks.in_flight.splice(taskIndex, 1);

  // Update task
  task.completed_at = now();
  task.status = 'completed';
  task.result_summary = resultSummary || 'Completed successfully';

  // Add to completed
  session.subagent_tasks.completed_this_session.push(task);

  addHistoryEntry(session, 'subagent_completed', {
    task_id: taskId,
    subagent_type: task.subagent_type,
    spec_group_id: task.spec_group_id,
    message: `Completed ${task.subagent_type}: ${resultSummary || 'No summary'}`
  });

  saveSession(session);
  console.error(`Completed subagent task '${taskId}'`);
}

/**
 * complete-work - Finalize completed work.
 */
function opCompleteWork() {
  const session = loadSession();
  if (!session) {
    throw new Error('No session.json exists. Run "init" first.');
  }

  if (!session.active_work) {
    console.error('No active work to complete.');
    return;
  }

  const specGroupId = session.active_work.spec_group_id;
  const objective = session.active_work.objective;
  const workflow = getWorkflowType(session);

  // Ensure we're in a completion state
  if (session.active_work.current_phase !== 'complete') {
    console.error(
      `Warning: Completing work while phase is '${session.active_work.current_phase}'. ` +
      `Consider transitioning to 'complete' first.`
    );
  }

  // --- Completion checklist (REQ-018, REQ-019, REQ-020) ---
  // Must read enforcement fields from phase_checkpoint BEFORE clearing it (INC-008)
  const enforcementLevel = getEnforcementLevel(session);
  const overrideCount = session.phase_checkpoint?.override_count || 0;
  const enforcementCounter = session.phase_checkpoint?.enforcement_counter || 0;
  const isInformationalOnly = enforcementLevel === 'off';

  if (!EXEMPT_WORKFLOWS.includes(workflow)) {
    const checklistItems = [];
    const allTasks = [
      ...(session.subagent_tasks?.in_flight || []),
      ...(session.subagent_tasks?.completed_this_session || [])
    ];

    // Build override history from session events
    const overrideHistory = (session.history || []).filter(
      h => h.event_type === 'override_skip'
    );
    const overriddenPhases = new Set(overrideHistory.map(h => h.details?.phase));

    // Check per-stage challenger dispatches (REQ-011)
    const requiredStages = REQUIRED_CHALLENGER_STAGES[workflow] || REQUIRED_CHALLENGER_STAGES['orchestrator'];
    for (const stage of requiredStages) {
      const dispatched = allTasks.some(
        t => t.subagent_type === 'challenger' && t.stage === stage
      );

      const phaseKey = `challenging:${stage}`;
      if (dispatched) {
        checklistItems.push({ label: `challenger (${stage})`, status: 'completed' });
      } else if (overriddenPhases.has(phaseKey) || overriddenPhases.has('challenging')) {
        const override = overrideHistory.find(
          h => h.details?.phase === phaseKey || h.details?.phase === 'challenging'
        );
        checklistItems.push({
          label: `challenger (${stage})`,
          status: 'overridden',
          rationale: override?.details?.rationale || 'No rationale recorded'
        });
      } else {
        checklistItems.push({ label: `challenger (${stage})`, status: 'missing' });
      }
    }

    // Check other mandatory dispatches
    const mandatoryTypes = [
      { type: 'code-reviewer', label: 'code-reviewer' },
      { type: 'security-reviewer', label: 'security-reviewer' },
      { type: 'completion-verifier', label: 'completion-verifier' },
      { type: 'documenter', label: 'documenter' }
    ];

    for (const { type, label } of mandatoryTypes) {
      const dispatched = allTasks.some(t => t.subagent_type === type);
      if (dispatched) {
        checklistItems.push({ label, status: 'completed' });
      } else if (overriddenPhases.has(type)) {
        const override = overrideHistory.find(h => h.details?.phase === type);
        checklistItems.push({
          label,
          status: 'overridden',
          rationale: override?.details?.rationale || 'No rationale recorded'
        });
      } else {
        checklistItems.push({ label, status: 'missing' });
      }
    }

    // Check for enforcement resets
    const enforcementResets = (session.history || []).filter(
      h => h.event_type === 'reset_enforcement'
    ).length;

    // Apply informational-only mode (REQ-020)
    if (isInformationalOnly) {
      for (const item of checklistItems) {
        if (item.status === 'missing') {
          item.status = 'informational';
        }
      }
    }

    // Output checklist (advisory -- does not block complete-work)
    const prefix = isInformationalOnly ? 'INFO' : 'COMPLETION CHECKLIST';
    console.error(`\n${prefix} (workflow: ${workflow}):`);
    for (const item of checklistItems) {
      switch (item.status) {
        case 'completed':
          console.error(`  [x] ${item.label}`);
          break;
        case 'overridden':
          console.error(`  [OVERRIDE] ${item.label} -- overridden: "${item.rationale}"`);
          break;
        case 'missing':
          console.error(`  [ ] ${item.label} -- MISSING`);
          break;
        case 'informational':
          console.error(`  [i] ${item.label} -- not dispatched (informational)`);
          break;
      }
    }
    if (enforcementResets > 0) {
      console.error(`  Enforcement resets: ${enforcementResets}`);
    }
    if (overrideCount > 0) {
      console.error(`  Overrides used: ${overrideCount}/${MAX_OVERRIDES_PER_SESSION}`);
    }
    console.error('');

    // Record checklist as completion_checklist event in session history (DEC-007, REQ-018)
    addHistoryEntry(session, 'completion_checklist', {
      workflow,
      items: checklistItems,
      enforcement_level: enforcementLevel,
      enforcement_resets: enforcementResets,
      override_count: overrideCount,
      enforcement_counter: enforcementCounter,
      spec_group_id: specGroupId,
      message: `Completion checklist generated for workflow '${workflow}'`
    });
  }
  // --- End completion checklist ---

  addHistoryEntry(session, 'work_completed', {
    spec_group_id: specGroupId,
    workflow: session.active_work.workflow,
    atomic_specs_completed: session.phase_checkpoint?.atomic_specs_completed || [],
    tasks_completed: session.subagent_tasks.completed_this_session.length,
    message: `Completed work: ${objective}`
  });

  // Clear active state
  session.active_work = null;
  session.phase_checkpoint = null;

  // Keep completed_this_session for reference but clear in_flight
  // Any in_flight tasks are considered abandoned
  for (const task of session.subagent_tasks.in_flight) {
    task.status = 'cancelled';
    task.completed_at = now();
    task.result_summary = 'Cancelled: work completed';
    session.subagent_tasks.completed_this_session.push(task);
  }
  session.subagent_tasks.in_flight = [];

  saveSession(session);
  console.error(`Completed work on '${specGroupId}'`);
}

/**
 * archive-incomplete - Archive incomplete work to history.
 */
function opArchiveIncomplete() {
  const session = loadSession();
  if (!session) {
    throw new Error('No session.json exists. Run "init" first.');
  }

  if (!session.active_work) {
    console.error('No active work to archive.');
    return;
  }

  const specGroupId = session.active_work.spec_group_id;
  const objective = session.active_work.objective;
  const currentPhase = session.active_work.current_phase;

  addHistoryEntry(session, 'work_abandoned', {
    spec_group_id: specGroupId,
    workflow: session.active_work.workflow,
    abandoned_at_phase: currentPhase,
    atomic_specs_completed: session.phase_checkpoint?.atomic_specs_completed || [],
    atomic_specs_pending: session.phase_checkpoint?.atomic_specs_pending || [],
    in_flight_tasks: session.subagent_tasks.in_flight.map(t => t.task_id),
    message: `Abandoned work at phase '${currentPhase}': ${objective}`
  });

  // Clear active state
  session.active_work = null;
  session.phase_checkpoint = null;

  // Cancel in_flight tasks
  for (const task of session.subagent_tasks.in_flight) {
    task.status = 'cancelled';
    task.completed_at = now();
    task.result_summary = 'Cancelled: work archived incomplete';
    session.subagent_tasks.completed_this_session.push(task);
  }
  session.subagent_tasks.in_flight = [];

  saveSession(session);
  console.error(`Archived incomplete work on '${specGroupId}' (was at phase '${currentPhase}')`);
}

/**
 * journal-created - Mark that a journal entry has been created.
 */
function opJournalCreated(journalPath) {
  if (!journalPath) {
    throw new Error('Usage: journal-created <path-to-journal>');
  }

  const session = loadSession();
  if (!session) {
    throw new Error('No session.json exists. Run "init" first.');
  }

  if (!session.phase_checkpoint) {
    throw new Error('No phase checkpoint. This should not happen.');
  }

  session.phase_checkpoint.journal_created = true;
  session.phase_checkpoint.journal_entry_path = journalPath;

  addHistoryEntry(session, 'checkpoint_saved', {
    spec_group_id: session.active_work?.spec_group_id,
    message: `Journal entry created: ${journalPath}`
  });

  saveSession(session);
  console.error(`Marked journal entry as created: ${journalPath}`);
}

/**
 * override-skip - Clear skip counter for a specific phase with audit trail (REQ-008).
 * Main-agent-only, subject to per-session override cap (shared with reset-enforcement).
 */
function opOverrideSkip(phase, rationale) {
  if (!phase || !rationale) {
    throw new Error('Usage: override-skip --phase <phase> --rationale "<reason>"');
  }

  const session = loadSession();
  if (!session) {
    throw new Error('No session.json exists. Run "init" first.');
  }

  if (!session.active_work) {
    throw new Error('No active work. Run "start-work" first.');
  }

  // Access control: main-agent-only (REQ-008)
  if (!isMainAgent(session)) {
    throw new Error('Only the main agent (no subagents in-flight) may override-skip.');
  }

  // Ensure enforcement fields exist (backward compatibility)
  if (!session.phase_checkpoint) {
    throw new Error('No phase checkpoint. Run "start-work" first.');
  }
  const overrideCount = session.phase_checkpoint.override_count || 0;

  // Check per-session cap (shared with reset-enforcement, max 3) (REQ-008)
  if (overrideCount >= MAX_OVERRIDES_PER_SESSION) {
    console.error(`Error: Override cap reached (${MAX_OVERRIDES_PER_SESSION}/${MAX_OVERRIDES_PER_SESSION}). Escalate to human with full context.`);
    process.exit(1);
  }

  // Clear skip counter for the specified phase
  if (!session.phase_checkpoint.phase_skip_warnings) {
    session.phase_checkpoint.phase_skip_warnings = {};
  }
  delete session.phase_checkpoint.phase_skip_warnings[phase];

  // Increment counters
  session.phase_checkpoint.enforcement_counter = (session.phase_checkpoint.enforcement_counter || 0) + 1;
  session.phase_checkpoint._counter_checksum = computeCounterChecksum(session.phase_checkpoint.enforcement_counter);
  session.phase_checkpoint.override_count = overrideCount + 1;

  // Log to session history (DEC-007)
  addHistoryEntry(session, 'override_skip', {
    phase,
    rationale,
    override_number: overrideCount + 1,
    cap: MAX_OVERRIDES_PER_SESSION,
    spec_group_id: session.active_work.spec_group_id,
    message: `Override-skip for phase '${phase}': ${rationale}`
  });

  saveSession(session);
  console.error(`Override-skip applied for phase '${phase}' (${overrideCount + 1}/${MAX_OVERRIDES_PER_SESSION} overrides used).`);
}

/**
 * reset-enforcement - Clear ALL skip counters with audit trail (REQ-009).
 * Main-agent-only, subject to per-session override cap (shared with override-skip).
 */
function opResetEnforcement(rationale) {
  if (!rationale) {
    throw new Error('Usage: reset-enforcement --rationale "<reason>"');
  }

  const session = loadSession();
  if (!session) {
    throw new Error('No session.json exists. Run "init" first.');
  }

  if (!session.active_work) {
    throw new Error('No active work. Run "start-work" first.');
  }

  // Access control: main-agent-only (REQ-009)
  if (!isMainAgent(session)) {
    throw new Error('Only the main agent (no subagents in-flight) may reset-enforcement.');
  }

  if (!session.phase_checkpoint) {
    throw new Error('No phase checkpoint. Run "start-work" first.');
  }
  const overrideCount = session.phase_checkpoint.override_count || 0;

  // Check per-session cap (shared with override-skip, max 3) (REQ-009)
  if (overrideCount >= MAX_OVERRIDES_PER_SESSION) {
    console.error(`Error: Override cap reached (${MAX_OVERRIDES_PER_SESSION}/${MAX_OVERRIDES_PER_SESSION}). Escalate to human with full context.`);
    process.exit(1);
  }

  // Clear ALL skip counters
  session.phase_checkpoint.phase_skip_warnings = {};

  // Increment counters
  session.phase_checkpoint.enforcement_counter = (session.phase_checkpoint.enforcement_counter || 0) + 1;
  session.phase_checkpoint._counter_checksum = computeCounterChecksum(session.phase_checkpoint.enforcement_counter);
  session.phase_checkpoint.override_count = overrideCount + 1;

  // Log to session history (DEC-007)
  addHistoryEntry(session, 'reset_enforcement', {
    rationale,
    override_number: overrideCount + 1,
    cap: MAX_OVERRIDES_PER_SESSION,
    spec_group_id: session.active_work.spec_group_id,
    message: `Reset enforcement: ${rationale}`
  });

  saveSession(session);
  console.error(`Enforcement reset applied (${overrideCount + 1}/${MAX_OVERRIDES_PER_SESSION} overrides used). All skip counters cleared.`);
}

/**
 * set-enforcement-level - Change enforcement level with audit trail (REQ-010).
 * Main-agent-only. Does NOT count toward override cap. Does NOT reset skip counters.
 */
function opSetEnforcementLevel(level) {
  if (!level) {
    throw new Error('Usage: set-enforcement-level <off|warn-only|graduated>');
  }

  if (!VALID_ENFORCEMENT_LEVELS.includes(level)) {
    throw new Error(`Invalid enforcement level '${level}'. Valid levels: ${VALID_ENFORCEMENT_LEVELS.join(', ')}`);
  }

  const session = loadSession();
  if (!session) {
    throw new Error('No session.json exists. Run "init" first.');
  }

  if (!session.active_work) {
    throw new Error('No active work. Run "start-work" first.');
  }

  // Access control: main-agent-only (REQ-010)
  if (!isMainAgent(session)) {
    throw new Error('Only the main agent (no subagents in-flight) may change enforcement level.');
  }

  if (!session.phase_checkpoint) {
    throw new Error('No phase checkpoint. Run "start-work" first.');
  }

  const oldLevel = session.phase_checkpoint.enforcement_level || 'graduated';

  if (oldLevel === level) {
    console.error(`Enforcement level is already '${level}'.`);
    return;
  }

  // Change level -- does NOT reset skip counters (EC-11)
  session.phase_checkpoint.enforcement_level = level;

  // Log to session history (DEC-007) -- does NOT count toward override cap
  addHistoryEntry(session, 'enforcement_level_change', {
    from_level: oldLevel,
    to_level: level,
    spec_group_id: session.active_work.spec_group_id,
    message: `Enforcement level changed from '${oldLevel}' to '${level}'`
  });

  saveSession(session);
  console.error(`Enforcement level changed from '${oldLevel}' to '${level}'.`);
}

/**
 * get-status - Output current session state summary as JSON.
 */
function opGetStatus() {
  const session = loadSession();

  if (!session) {
    const status = {
      exists: false,
      has_active_work: false,
      message: 'No session.json found. Run "init" to create one.'
    };
    console.error(JSON.stringify(status, null, 2));
    return;
  }

  const status = {
    exists: true,
    version: session.version,
    updated_at: session.updated_at,
    has_active_work: session.active_work !== null,
    active_work: session.active_work ? {
      spec_group_id: session.active_work.spec_group_id,
      workflow: session.active_work.workflow,
      current_phase: session.active_work.current_phase,
      objective: session.active_work.objective
    } : null,
    phase_checkpoint: session.phase_checkpoint ? {
      phase: session.phase_checkpoint.phase,
      atomic_specs_completed_count: session.phase_checkpoint.atomic_specs_completed?.length || 0,
      atomic_specs_pending_count: session.phase_checkpoint.atomic_specs_pending?.length || 0,
      next_actions: session.phase_checkpoint.next_actions || []
    } : null,
    subagent_tasks: {
      in_flight_count: session.subagent_tasks.in_flight.length,
      completed_this_session_count: session.subagent_tasks.completed_this_session.length,
      in_flight: session.subagent_tasks.in_flight.map(t => ({
        task_id: t.task_id,
        subagent_type: t.subagent_type,
        status: t.status
      }))
    },
    history_count: session.history.length,
    recent_history: session.history.slice(-5).map(h => ({
      timestamp: h.timestamp,
      event_type: h.event_type,
      message: h.details?.message
    }))
  };

  console.error(JSON.stringify(status, null, 2));
}

/**
 * update-convergence - Write convergence state to session.json (AC-5.1 through AC-5.6).
 *
 * Usage: update-convergence <gate_name> <clean_pass_count>
 * Valid gate_name: code_review, security_review, investigation, challenger
 * clean_pass_count: non-negative integer
 *
 * Implements: REQ-016, REQ-017, REQ-018, REQ-019
 */
function opUpdateConvergence(gateName, countStr) {
  if (!gateName || countStr === undefined || countStr === null || countStr === '') {
    throw new Error('Usage: update-convergence <gate_name> <clean_pass_count>');
  }

  // AC-5.3: Validate gate_name against enum (REQ-018)
  if (!VALID_CONVERGENCE_GATES.includes(gateName)) {
    throw new Error(
      `Invalid gate_name '${gateName}'. Valid gate names: ${VALID_CONVERGENCE_GATES.join(', ')}`
    );
  }

  // AC-5.4: Validate clean_pass_count is non-negative integer (REQ-018)
  const cleanPassCount = Number(countStr);
  if (!Number.isInteger(cleanPassCount) || cleanPassCount < 0) {
    throw new Error(
      `Invalid clean_pass_count '${countStr}'. Must be a non-negative integer.`
    );
  }

  // AC-5.5: Atomic read-modify-write via saveSession (REQ-019)
  const session = loadSession();
  if (!session) {
    throw new Error('No session.json exists. Run "init" first.');
  }

  // AC-5.6: Create convergence object if it doesn't exist (backward compatibility)
  if (!session.convergence) {
    session.convergence = {};
  }

  if (!session.convergence[gateName]) {
    session.convergence[gateName] = {};
  }

  session.convergence[gateName].clean_pass_count = cleanPassCount;

  addHistoryEntry(session, 'convergence_update', {
    gate_name: gateName,
    clean_pass_count: cleanPassCount,
    spec_group_id: session.active_work?.spec_group_id,
    message: `Updated convergence: ${gateName}.clean_pass_count = ${cleanPassCount}`
  });

  saveSession(session);
  console.error(`Updated convergence: ${gateName}.clean_pass_count = ${cleanPassCount}`);
}

// =============================================================================
// Main
// =============================================================================

function printUsage() {
  console.error(`
Session Checkpoint Utility

Usage: node session-checkpoint.mjs <operation> [args...]

Operations:
  init                                            Initialize session.json
  start-work <spec_group_id> <workflow> <obj>     Start tracking work
  transition-phase <new_phase>                    Update current phase
  complete-atomic-spec <atomic_spec_id>           Mark atomic spec as done
  dispatch-subagent <id> <type> <desc> [--stage]  Track subagent dispatch
  complete-subagent <task_id> <result_summary>    Mark subagent complete
  journal-created <path-to-journal>               Mark journal entry as created
  override-skip --phase <p> --rationale "<r>"     Override a phase skip block
  reset-enforcement --rationale "<r>"             Reset all skip counters
  set-enforcement-level <off|warn-only|graduated> Change enforcement level
  complete-work                                   Finalize completed work
  archive-incomplete                              Archive incomplete work
  update-convergence <gate_name> <count>           Update convergence state
  get-status                                      Output session state (JSON)

Phases:
  ${VALID_PHASES.join(', ')}

Workflows:
  ${VALID_WORKFLOWS.join(', ')}

Subagent Types:
  ${VALID_SUBAGENT_TYPES.join(', ')}

Stages (for --stage flag with dispatch-subagent):
  ${VALID_STAGES.join(', ')}

Enforcement Levels:
  ${VALID_ENFORCEMENT_LEVELS.join(', ')}
`);
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    printUsage();
    process.exit(0);
  }

  const operation = args[0];

  try {
    switch (operation) {
      case 'init':
        opInit();
        break;

      case 'start-work':
        opStartWork(args[1], args[2], args.slice(3).join(' '));
        break;

      case 'transition-phase':
        opTransitionPhase(args[1]);
        break;

      case 'complete-atomic-spec':
        opCompleteAtomicSpec(args[1]);
        break;

      case 'dispatch-subagent': {
        // Parse --stage flag from args before joining remainder as description (DEC-004)
        const dispatchArgs = args.slice(1);
        const stageIdx = dispatchArgs.indexOf('--stage');
        let dispatchStage = null;
        const filteredArgs = [];

        for (let i = 0; i < dispatchArgs.length; i++) {
          if (dispatchArgs[i] === '--stage' && i + 1 < dispatchArgs.length) {
            dispatchStage = dispatchArgs[i + 1];
            i++; // skip the stage value
          } else {
            filteredArgs.push(dispatchArgs[i]);
          }
        }

        opDispatchSubagent(
          filteredArgs[0],
          filteredArgs[1],
          filteredArgs.slice(2).join(' '),
          dispatchStage
        );
        break;
      }

      case 'complete-subagent':
        opCompleteSubagent(args[1], args.slice(2).join(' '));
        break;

      case 'journal-created':
        opJournalCreated(args[1]);
        break;

      case 'complete-work':
        opCompleteWork();
        break;

      case 'archive-incomplete':
        opArchiveIncomplete();
        break;

      case 'override-skip': {
        // Parse --phase and --rationale flags
        const osArgs = args.slice(1);
        let osPhase = null;
        let osRationale = null;

        for (let i = 0; i < osArgs.length; i++) {
          if (osArgs[i] === '--phase' && i + 1 < osArgs.length) {
            osPhase = osArgs[i + 1];
            i++;
          } else if (osArgs[i] === '--rationale' && i + 1 < osArgs.length) {
            osRationale = osArgs.slice(i + 1).join(' ');
            break;
          }
        }

        opOverrideSkip(osPhase, osRationale);
        break;
      }

      case 'reset-enforcement': {
        // Parse --rationale flag
        const reArgs = args.slice(1);
        let reRationale = null;

        for (let i = 0; i < reArgs.length; i++) {
          if (reArgs[i] === '--rationale' && i + 1 < reArgs.length) {
            reRationale = reArgs.slice(i + 1).join(' ');
            break;
          }
        }

        opResetEnforcement(reRationale);
        break;
      }

      case 'set-enforcement-level':
        opSetEnforcementLevel(args[1]);
        break;

      case 'update-convergence':
        opUpdateConvergence(args[1], args[2]);
        break;

      case 'get-status':
        opGetStatus();
        break;

      case '--help':
      case '-h':
      case 'help':
        printUsage();
        break;

      default:
        console.error(`Unknown operation: ${operation}`);
        printUsage();
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
