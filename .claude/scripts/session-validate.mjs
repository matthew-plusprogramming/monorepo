#!/usr/bin/env node

/**
 * Validate session.json against session.schema.json.
 *
 * Logic:
 * 1. Load .claude/context/session.json
 * 2. Load .claude/specs/schema/session.schema.json
 * 3. Validate session against schema
 * 4. Report validation errors
 * 5. Exit 0 on valid or if session.json doesn't exist (graceful degradation)
 * 6. Exit 1 on validation failure or missing schema
 *
 * Usage:
 *   node session-validate.mjs
 *
 * Exit codes:
 *   0 - Validation passed or session.json doesn't exist
 *   1 - Validation failed or schema missing
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

// Find the .claude directory by walking up from script location
function findClaudeDir() {
  let currentDir = dirname(resolve(import.meta.url.replace('file://', '')));
  const root = '/';

  while (currentDir !== root) {
    const claudeDir = join(currentDir, '.claude');
    if (existsSync(claudeDir)) {
      return claudeDir;
    }
    // Check if we're inside .claude
    if (basename(currentDir) === '.claude') {
      return currentDir;
    }
    const parent = dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }

  // Default to relative path from cwd
  return join(process.cwd(), '.claude');
}

const CLAUDE_DIR = findClaudeDir();
const SESSION_PATH = join(CLAUDE_DIR, 'context', 'session.json');
const SCHEMA_PATH = join(CLAUDE_DIR, 'specs', 'schema', 'session.schema.json');

/**
 * Valid workflow values from schema
 */
const VALID_WORKFLOWS = [
  'oneoff-vibe',
  'oneoff-spec',
  'orchestrator',
  'refactor',
  'journal-only'
];

/**
 * Valid phase values from schema
 */
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
  'complete'
];

/**
 * Valid subagent types from schema
 */
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
 * Valid event types from schema
 */
const VALID_EVENT_TYPES = [
  'session_start',
  'session_resume',
  'work_started',
  'phase_transition',
  'subagent_dispatched',
  'subagent_completed',
  'checkpoint_saved',
  'work_completed',
  'work_abandoned',
  'error_occurred'
];

/**
 * Valid task statuses from schema
 */
const VALID_TASK_STATUSES = ['in_flight', 'completed', 'failed', 'cancelled'];

/**
 * Check if a string is a valid ISO 8601 timestamp
 */
function isValidISOTimestamp(str) {
  if (typeof str !== 'string') return false;
  const dateRegex = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;
  if (!dateRegex.test(str)) return false;
  const date = new Date(str);
  return !isNaN(date.getTime());
}

/**
 * Check if a string matches the spec_group_id pattern (sg-<slug>)
 */
function isValidSpecGroupId(str) {
  if (typeof str !== 'string') return false;
  return /^sg-[a-z0-9-]+$/.test(str);
}

/**
 * Check if a string matches the atomic_spec_id pattern (as-NNN or as-NNN-slug)
 */
function isValidAtomicSpecId(str) {
  if (typeof str !== 'string') return false;
  return /^as-[0-9]{3}(-[a-z0-9-]+)?$/.test(str);
}

/**
 * Validate a subagent_task object
 */
function validateSubagentTask(task, path) {
  const errors = [];

  if (typeof task !== 'object' || task === null) {
    errors.push(`${path}: expected object, got ${typeof task}`);
    return errors;
  }

  // Required fields
  if (typeof task.task_id !== 'string' || !task.task_id) {
    errors.push(`${path}.task_id: required string field is missing or invalid`);
  }

  if (!VALID_SUBAGENT_TYPES.includes(task.subagent_type)) {
    errors.push(`${path}.subagent_type: '${task.subagent_type}' is not a valid subagent type`);
  }

  if (typeof task.description !== 'string' || !task.description) {
    errors.push(`${path}.description: required string field is missing or invalid`);
  }

  if (!isValidISOTimestamp(task.dispatched_at)) {
    errors.push(`${path}.dispatched_at: '${task.dispatched_at}' is not a valid ISO 8601 timestamp`);
  }

  if (!VALID_TASK_STATUSES.includes(task.status)) {
    errors.push(`${path}.status: '${task.status}' is not a valid task status`);
  }

  // Optional fields with type checking
  if (task.completed_at !== undefined && task.completed_at !== null) {
    if (!isValidISOTimestamp(task.completed_at)) {
      errors.push(`${path}.completed_at: '${task.completed_at}' is not a valid ISO 8601 timestamp`);
    }
  }

  if (task.result_summary !== undefined && task.result_summary !== null) {
    if (typeof task.result_summary !== 'string') {
      errors.push(`${path}.result_summary: expected string or null, got ${typeof task.result_summary}`);
    }
  }

  if (task.spec_group_id !== undefined && task.spec_group_id !== null) {
    if (!isValidSpecGroupId(task.spec_group_id)) {
      errors.push(`${path}.spec_group_id: '${task.spec_group_id}' does not match pattern sg-<slug>`);
    }
  }

  if (task.atomic_spec_id !== undefined && task.atomic_spec_id !== null) {
    if (!isValidAtomicSpecId(task.atomic_spec_id)) {
      errors.push(`${path}.atomic_spec_id: '${task.atomic_spec_id}' does not match pattern as-NNN or as-NNN-slug`);
    }
  }

  return errors;
}

/**
 * Validate a history_entry object
 */
function validateHistoryEntry(entry, path) {
  const errors = [];

  if (typeof entry !== 'object' || entry === null) {
    errors.push(`${path}: expected object, got ${typeof entry}`);
    return errors;
  }

  // Required fields
  if (!isValidISOTimestamp(entry.timestamp)) {
    errors.push(`${path}.timestamp: '${entry.timestamp}' is not a valid ISO 8601 timestamp`);
  }

  if (!VALID_EVENT_TYPES.includes(entry.event_type)) {
    errors.push(`${path}.event_type: '${entry.event_type}' is not a valid event type`);
  }

  // Optional details field
  if (entry.details !== undefined && typeof entry.details !== 'object') {
    errors.push(`${path}.details: expected object, got ${typeof entry.details}`);
  }

  return errors;
}

/**
 * Validate session.json structure without external dependencies.
 * Checks types, required fields, patterns, and enums based on schema.
 */
function validateSession(data) {
  const errors = [];

  if (typeof data !== 'object' || data === null) {
    errors.push('Session data must be an object');
    return errors;
  }

  // version: required string matching semver pattern
  if (typeof data.version !== 'string') {
    errors.push('version: required field must be a string');
  } else if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(data.version)) {
    errors.push(`version: '${data.version}' does not match semantic version pattern (X.Y.Z)`);
  }

  // updated_at: required ISO 8601 timestamp
  if (!isValidISOTimestamp(data.updated_at)) {
    errors.push(`updated_at: '${data.updated_at}' is not a valid ISO 8601 timestamp`);
  }

  // active_work: required, can be null or object with specific fields
  if (data.active_work === undefined) {
    errors.push('active_work: required field is missing');
  } else if (data.active_work !== null) {
    if (typeof data.active_work !== 'object') {
      errors.push(`active_work: expected object or null, got ${typeof data.active_work}`);
    } else {
      // Validate active_work fields
      const aw = data.active_work;

      if (!isValidSpecGroupId(aw.spec_group_id)) {
        errors.push(`active_work.spec_group_id: '${aw.spec_group_id}' does not match pattern sg-<slug>`);
      }

      if (!VALID_WORKFLOWS.includes(aw.workflow)) {
        errors.push(`active_work.workflow: '${aw.workflow}' is not a valid workflow type`);
      }

      if (!VALID_PHASES.includes(aw.current_phase)) {
        errors.push(`active_work.current_phase: '${aw.current_phase}' is not a valid phase`);
      }

      if (typeof aw.objective !== 'string' || !aw.objective) {
        errors.push('active_work.objective: required string field is missing or invalid');
      }
    }
  }

  // phase_checkpoint: required, can be null or object
  if (data.phase_checkpoint === undefined) {
    errors.push('phase_checkpoint: required field is missing');
  } else if (data.phase_checkpoint !== null) {
    if (typeof data.phase_checkpoint !== 'object') {
      errors.push(`phase_checkpoint: expected object or null, got ${typeof data.phase_checkpoint}`);
    } else {
      const pc = data.phase_checkpoint;

      // phase is required
      if (!VALID_PHASES.includes(pc.phase)) {
        errors.push(`phase_checkpoint.phase: '${pc.phase}' is not a valid phase`);
      }

      // Optional arrays with pattern validation
      if (pc.atomic_specs_completed !== undefined) {
        if (!Array.isArray(pc.atomic_specs_completed)) {
          errors.push('phase_checkpoint.atomic_specs_completed: expected array');
        } else {
          pc.atomic_specs_completed.forEach((id, i) => {
            if (!isValidAtomicSpecId(id)) {
              errors.push(`phase_checkpoint.atomic_specs_completed[${i}]: '${id}' does not match pattern as-NNN or as-NNN-slug`);
            }
          });
        }
      }

      if (pc.atomic_specs_pending !== undefined) {
        if (!Array.isArray(pc.atomic_specs_pending)) {
          errors.push('phase_checkpoint.atomic_specs_pending: expected array');
        } else {
          pc.atomic_specs_pending.forEach((id, i) => {
            if (!isValidAtomicSpecId(id)) {
              errors.push(`phase_checkpoint.atomic_specs_pending[${i}]: '${id}' does not match pattern as-NNN or as-NNN-slug`);
            }
          });
        }
      }

      if (pc.next_actions !== undefined) {
        if (!Array.isArray(pc.next_actions)) {
          errors.push('phase_checkpoint.next_actions: expected array');
        } else {
          pc.next_actions.forEach((action, i) => {
            if (typeof action !== 'string') {
              errors.push(`phase_checkpoint.next_actions[${i}]: expected string, got ${typeof action}`);
            }
          });
        }
      }
    }
  }

  // subagent_tasks: required object with in_flight and completed_this_session arrays
  if (data.subagent_tasks === undefined) {
    errors.push('subagent_tasks: required field is missing');
  } else if (typeof data.subagent_tasks !== 'object' || data.subagent_tasks === null) {
    errors.push(`subagent_tasks: expected object, got ${typeof data.subagent_tasks}`);
  } else {
    const st = data.subagent_tasks;

    if (!Array.isArray(st.in_flight)) {
      errors.push('subagent_tasks.in_flight: required array is missing or invalid');
    } else {
      st.in_flight.forEach((task, i) => {
        errors.push(...validateSubagentTask(task, `subagent_tasks.in_flight[${i}]`));
      });
    }

    if (!Array.isArray(st.completed_this_session)) {
      errors.push('subagent_tasks.completed_this_session: required array is missing or invalid');
    } else {
      st.completed_this_session.forEach((task, i) => {
        errors.push(...validateSubagentTask(task, `subagent_tasks.completed_this_session[${i}]`));
      });
    }
  }

  // history: required array
  if (!Array.isArray(data.history)) {
    errors.push('history: required array is missing or invalid');
  } else {
    data.history.forEach((entry, i) => {
      errors.push(...validateHistoryEntry(entry, `history[${i}]`));
    });
  }

  return errors;
}

/**
 * Load and validate session.json
 */
function main() {
  // Check if session.json exists - graceful degradation if not
  if (!existsSync(SESSION_PATH)) {
    console.log(`Session file not found: ${SESSION_PATH}`);
    console.log('No session.json to validate (graceful degradation).');
    process.exit(0);
  }

  // Check if schema exists - error if not
  if (!existsSync(SCHEMA_PATH)) {
    console.error(`Schema file not found: ${SCHEMA_PATH}`);
    console.error('Cannot validate without schema.');
    process.exit(1);
  }

  // Load session.json
  let sessionData;
  try {
    const content = readFileSync(SESSION_PATH, 'utf-8');
    sessionData = JSON.parse(content);
  } catch (err) {
    console.error(`Error reading session.json: ${err.message}`);
    process.exit(1);
  }

  // Validate
  const errors = validateSession(sessionData);

  if (errors.length > 0) {
    console.error('Session validation failed:');
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  console.log('Session validation passed.');
  process.exit(0);
}

main();
