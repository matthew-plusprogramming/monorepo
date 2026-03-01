#!/usr/bin/env node

/**
 * High-Level Trace Generation Library
 *
 * Produces `.claude/traces/high-level.json` and `.claude/traces/high-level.md`
 * from trace.config.json and existing dependency data.
 *
 * Implements: REQ-AT-001, REQ-AT-002, REQ-AT-006
 * Spec: as-003-high-level-trace
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  loadTraceConfig,
  formatTimestamp,
  resolveProjectRoot,
  HIGH_LEVEL_TRACE_PATH,
} from './trace-utils.mjs';

/** Allowed relationship types per the HighLevelTrace schema */
const VALID_RELATIONSHIP_TYPES = [
  'imports',
  'calls',
  'publishes-to',
  'subscribes-from',
  'reads-from',
  'writes-to',
  'configures',
];

/**
 * Validate a dependency object against the HighLevelTrace schema.
 *
 * @param {object} dep - Dependency object to validate
 * @param {string} context - Context string for error messages (e.g., "module 'dev-team' dependency[0]")
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateDependency(dep, context) {
  const errors = [];

  if (!dep || typeof dep !== 'object') {
    return { valid: false, errors: [`${context}: must be an object`] };
  }
  if (typeof dep.targetId !== 'string' || dep.targetId.length === 0) {
    errors.push(`${context}: targetId must be a non-empty string`);
  }
  if (typeof dep.relationshipType !== 'string') {
    errors.push(`${context}: relationshipType must be a string`);
  } else if (!VALID_RELATIONSHIP_TYPES.includes(dep.relationshipType)) {
    errors.push(
      `${context}: relationshipType "${dep.relationshipType}" is not valid. Must be one of: ${VALID_RELATIONSHIP_TYPES.join(', ')}`,
    );
  }
  if (typeof dep.description !== 'string') {
    errors.push(`${context}: description must be a string`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate a high-level trace JSON object against the HighLevelTrace schema.
 *
 * AC-2.1: Validates all required fields on the root and each module node.
 *
 * @param {object} trace - High-level trace object to validate
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateHighLevelTrace(trace) {
  const errors = [];

  if (!trace || typeof trace !== 'object') {
    return { valid: false, errors: ['Trace must be an object'] };
  }

  // Root-level required fields
  if (typeof trace.version !== 'number' || !Number.isInteger(trace.version)) {
    errors.push('version must be an integer');
  }
  if (typeof trace.lastGenerated !== 'string') {
    errors.push('lastGenerated must be a string');
  } else {
    const parsed = new Date(trace.lastGenerated);
    if (Number.isNaN(parsed.getTime())) {
      errors.push('lastGenerated must be a valid ISO 8601 timestamp');
    }
  }
  if (typeof trace.generatedBy !== 'string' || trace.generatedBy.length === 0) {
    errors.push('generatedBy must be a non-empty string');
  }
  if (typeof trace.projectRoot !== 'string') {
    errors.push('projectRoot must be a string');
  }
  if (!Array.isArray(trace.modules)) {
    errors.push('modules must be an array');
    return { valid: false, errors };
  }

  // Validate each module node
  for (let i = 0; i < trace.modules.length; i++) {
    const mod = trace.modules[i];
    const prefix = `modules[${i}]`;

    if (!mod || typeof mod !== 'object') {
      errors.push(`${prefix}: must be an object`);
      continue;
    }
    if (typeof mod.id !== 'string' || mod.id.length === 0) {
      errors.push(`${prefix}.id must be a non-empty string`);
    }
    if (typeof mod.name !== 'string' || mod.name.length === 0) {
      errors.push(`${prefix}.name must be a non-empty string`);
    }
    if (typeof mod.description !== 'string') {
      errors.push(`${prefix}.description must be a string`);
    }
    if (!Array.isArray(mod.fileGlobs)) {
      errors.push(`${prefix}.fileGlobs must be an array`);
    }
    if (!Array.isArray(mod.dependencies)) {
      errors.push(`${prefix}.dependencies must be an array`);
    } else {
      for (let j = 0; j < mod.dependencies.length; j++) {
        const result = validateDependency(mod.dependencies[j], `${prefix}.dependencies[${j}]`);
        errors.push(...result.errors);
      }
    }
    if (!Array.isArray(mod.dependents)) {
      errors.push(`${prefix}.dependents must be an array`);
    } else {
      for (let j = 0; j < mod.dependents.length; j++) {
        const result = validateDependency(mod.dependents[j], `${prefix}.dependents[${j}]`);
        errors.push(...result.errors);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Read the existing high-level trace JSON, if it exists.
 *
 * @param {string} projectRoot - Absolute path to the project root
 * @returns {object | null} Parsed high-level trace or null if not found/invalid
 */
export function readExistingHighLevelTrace(projectRoot) {
  const tracePath = join(projectRoot, HIGH_LEVEL_TRACE_PATH);

  try {
    const raw = readFileSync(tracePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Generate the high-level trace JSON object.
 *
 * Reads module definitions from trace.config.json, merges with existing
 * dependency data (if any), and produces a HighLevelTrace-compliant object.
 *
 * AC-2.1: JSON validates against HighLevelTrace schema
 * AC-2.3: Version is incremented from existing (or starts at 1)
 * AC-2.4: lastGenerated is a valid ISO 8601 timestamp
 *
 * @param {object} [options]
 * @param {string} [options.projectRoot] - Project root override
 * @param {string} [options.generatedBy] - Generator identifier (default: "trace generate")
 * @param {object} [options.existingTrace] - Existing trace data to merge from (for version increment)
 * @param {object} [options.dependencyData] - Manual dependency data keyed by module ID
 * @param {object} [options.config] - Pre-loaded trace config (avoids re-reading from disk)
 * @returns {object} HighLevelTrace-compliant JSON object
 */
export function generateHighLevelTraceJSON(options = {}) {
  const projectRoot = options.projectRoot || resolveProjectRoot();
  const generatedBy = options.generatedBy || 'trace generate';

  // Load config
  const config = options.config || loadTraceConfig(projectRoot);

  // Read existing trace for version incrementing (AC-2.3)
  const existing = options.existingTrace ?? readExistingHighLevelTrace(projectRoot);
  const previousVersion = existing && typeof existing.version === 'number' ? existing.version : 0;
  const newVersion = previousVersion + 1;

  // Build a lookup of existing dependency data (from prior trace or manual input)
  const dependencyData = options.dependencyData || {};
  const existingModuleMap = new Map();
  if (existing && Array.isArray(existing.modules)) {
    for (const mod of existing.modules) {
      existingModuleMap.set(mod.id, mod);
    }
  }

  // AC-2.4: Generate ISO 8601 timestamp
  const lastGenerated = formatTimestamp();

  // Build module nodes from config
  const modules = config.modules.map(configMod => {
    // Priority: manual dependency data > existing trace data > empty
    const manualDeps = dependencyData[configMod.id];
    const existingMod = existingModuleMap.get(configMod.id);

    let dependencies = [];
    let dependents = [];

    if (manualDeps) {
      dependencies = Array.isArray(manualDeps.dependencies) ? manualDeps.dependencies : [];
      dependents = Array.isArray(manualDeps.dependents) ? manualDeps.dependents : [];
    } else if (existingMod) {
      dependencies = Array.isArray(existingMod.dependencies) ? existingMod.dependencies : [];
      dependents = Array.isArray(existingMod.dependents) ? existingMod.dependents : [];
    }

    return {
      id: configMod.id,
      name: configMod.name,
      description: configMod.description || '',
      fileGlobs: configMod.fileGlobs,
      dependencies,
      dependents,
    };
  });

  const trace = {
    version: newVersion,
    lastGenerated,
    generatedBy,
    projectRoot: config.projectRoot || '.',
    modules,
  };

  return trace;
}

/**
 * Generate the high-level trace markdown from a JSON trace object.
 *
 * AC-2.2: Contains HTML comment metadata (trace-id, trace-version, last-generated, generated-by)
 *         and pipe-delimited dependency/dependent sections for each module.
 *
 * @param {object} trace - HighLevelTrace JSON object
 * @returns {string} Markdown string
 */
export function generateHighLevelTraceMarkdown(trace) {
  const lines = [];

  // HTML comment metadata (AC-2.2)
  lines.push(`<!-- trace-id: high-level -->`);
  lines.push(`<!-- trace-version: ${trace.version} -->`);
  lines.push(`<!-- last-generated: ${trace.lastGenerated} -->`);
  lines.push(`<!-- generated-by: ${trace.generatedBy} -->`);
  lines.push('');
  lines.push('# Architecture Trace: High-Level');
  lines.push('');

  for (const mod of trace.modules) {
    lines.push(`## Module: ${mod.name}`);
    lines.push('');
    lines.push(`**ID**: ${mod.id}`);
    lines.push(`**Description**: ${mod.description || '(none)'}`);
    lines.push(`**File Globs**: ${mod.fileGlobs.map(g => '`' + g + '`').join(', ')}`);
    lines.push('');

    // Dependencies section (pipe-delimited per spec)
    lines.push('### Dependencies');
    lines.push('');
    if (mod.dependencies.length > 0) {
      lines.push('target | relationship-type | description');
      for (const dep of mod.dependencies) {
        lines.push(`${dep.targetId} | ${dep.relationshipType} | ${dep.description}`);
      }
    } else {
      lines.push('(none)');
    }
    lines.push('');

    // Dependents section (pipe-delimited per spec)
    lines.push('### Dependents');
    lines.push('');
    if (mod.dependents.length > 0) {
      lines.push('target | relationship-type | description');
      for (const dep of mod.dependents) {
        lines.push(`${dep.targetId} | ${dep.relationshipType} | ${dep.description}`);
      }
    } else {
      lines.push('(none)');
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Generate and write both high-level.json and high-level.md to disk.
 *
 * AC-2.1: JSON validates against HighLevelTrace schema
 * AC-2.2: Markdown has HTML comment metadata + pipe-delimited sections
 * AC-2.3: Version incremented from existing
 * AC-2.4: lastGenerated is valid ISO 8601
 *
 * @param {object} [options]
 * @param {string} [options.projectRoot] - Project root override
 * @param {string} [options.generatedBy] - Generator identifier
 * @param {object} [options.dependencyData] - Manual dependency data keyed by module ID
 * @param {object} [options.config] - Pre-loaded trace config
 * @returns {{ json: object, jsonPath: string, mdPath: string, version: number }}
 */
export function generateHighLevelTrace(options = {}) {
  const projectRoot = options.projectRoot || resolveProjectRoot();

  // Generate JSON
  const trace = generateHighLevelTraceJSON({ ...options, projectRoot });

  // Validate before writing (AC-2.1)
  const validation = validateHighLevelTrace(trace);
  if (!validation.valid) {
    throw new Error(
      `Generated high-level trace failed schema validation:\n${validation.errors.join('\n')}`,
    );
  }

  // Generate markdown (AC-2.2)
  const markdown = generateHighLevelTraceMarkdown(trace);

  // Ensure directory exists
  const tracesDir = join(projectRoot, '.claude', 'traces');
  if (!existsSync(tracesDir)) {
    mkdirSync(tracesDir, { recursive: true });
  }

  // Write files
  const jsonPath = join(tracesDir, 'high-level.json');
  const mdPath = join(tracesDir, 'high-level.md');

  writeFileSync(jsonPath, JSON.stringify(trace, null, 2) + '\n');
  writeFileSync(mdPath, markdown);

  return {
    json: trace,
    jsonPath,
    mdPath,
    version: trace.version,
  };
}

// Export constants for external use
export { VALID_RELATIONSHIP_TYPES };
