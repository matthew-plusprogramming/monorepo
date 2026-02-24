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
 *   transition-phase <new_phase>                  - Update current phase
 *   complete-atomic-spec <atomic_spec_id>         - Mark an atomic spec as done
 *   dispatch-subagent <task_id> <type> <desc>     - Track subagent dispatch
 *   complete-subagent <task_id> <result_summary>  - Mark subagent as complete
 *   journal-created <path-to-journal>             - Mark journal entry as created
 *   complete-work                                 - Finalize completed work
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

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

// Schema version for session.json
const SESSION_VERSION = '1.0.0';

// Valid phases for workflow lifecycle
const VALID_PHASES = [
  'pm_interview',
  'spec_authoring',
  'atomizing',
  'enforcing',
  'investigating',
  'awaiting_approval',
  'implementing',
  'testing',
  'verifying',
  'reviewing',
  'journaling',
  'complete'
];

// Valid workflow types
const VALID_WORKFLOWS = [
  'oneoff-vibe',
  'oneoff-spec',
  'orchestrator',
  'refactor',
  'journal-only'
];

// Valid subagent types
const VALID_SUBAGENT_TYPES = [
  'explore',
  'product-manager',
  'spec-author',
  'atomizer',
  'atomicity-enforcer',
  'interface-investigator',
  'implementer',
  'test-writer',
  'unifier',
  'code-reviewer',
  'security-reviewer',
  'documenter',
  'refactorer',
  'facilitator',
  'browser-tester',
  'prd-author',
  'prd-reader',
  'prd-writer'
];

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
 * Save session.json atomically.
 */
function saveSession(session) {
  ensureContextDir();
  session.updated_at = now();
  writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2) + '\n');
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
      initialPhase = 'pm_interview';
      break;
    case 'refactor':
      initialPhase = 'spec_authoring';
      break;
    case 'journal-only':
      initialPhase = 'journaling';
      break;
    default:
      initialPhase = 'pm_interview';
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
    next_actions: []
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

  // Validate phase transition makes sense (basic ordering)
  const oldIndex = VALID_PHASES.indexOf(oldPhase);
  const newIndex = VALID_PHASES.indexOf(newPhase);

  // Allow forward progression or staying in same phase
  // Allow backward only for certain cases (e.g., returning to spec_authoring after review feedback)
  if (newIndex < oldIndex && newPhase !== 'spec_authoring' && newPhase !== 'atomizing') {
    console.error(
      `Warning: Transitioning backward from '${oldPhase}' to '${newPhase}'. ` +
      `Ensure this is intentional.`
    );
  }

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
 */
function opDispatchSubagent(taskId, subagentType, description) {
  if (!subagentType || !description) {
    throw new Error('Usage: dispatch-subagent <task_id> <subagent_type> <description>');
  }

  // If taskId not provided, generate one
  const finalTaskId = taskId || generateTaskId();

  validateSubagentType(subagentType);

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

  session.subagent_tasks.in_flight.push(task);

  addHistoryEntry(session, 'subagent_dispatched', {
    task_id: finalTaskId,
    subagent_type: subagentType,
    spec_group_id: session.active_work?.spec_group_id,
    message: `Dispatched ${subagentType}: ${description}`
  });

  saveSession(session);
  console.error(`Dispatched subagent '${subagentType}' with task_id '${finalTaskId}'`);
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

  // Ensure we're in a completion state
  if (session.active_work.current_phase !== 'complete') {
    console.error(
      `Warning: Completing work while phase is '${session.active_work.current_phase}'. ` +
      `Consider transitioning to 'complete' first.`
    );
  }

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
  dispatch-subagent <task_id> <type> <desc>       Track subagent dispatch
  complete-subagent <task_id> <result_summary>    Mark subagent complete
  journal-created <path-to-journal>               Mark journal entry as created
  complete-work                                   Finalize completed work
  archive-incomplete                              Archive incomplete work
  get-status                                      Output session state (JSON)

Phases:
  ${VALID_PHASES.join(', ')}

Workflows:
  ${VALID_WORKFLOWS.join(', ')}

Subagent Types:
  ${VALID_SUBAGENT_TYPES.join(', ')}
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

      case 'dispatch-subagent':
        opDispatchSubagent(args[1], args[2], args.slice(3).join(' '));
        break;

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
