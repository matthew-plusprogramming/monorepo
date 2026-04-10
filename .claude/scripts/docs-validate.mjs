#!/usr/bin/env node

/**
 * Structured Documentation Validator
 *
 * Validates all structured YAML documents against their schemas:
 * - Schema violations (required fields, types, uniqueness, enums)
 * - Cross-reference integrity (flows -> modules, glossary see_also, flow index -> files)
 * - Circular dependency detection (informational)
 * - Freshness detection (source hash comparison for .mmd files)
 * - Input size limits (modules, flows counts)
 * - Path confinement
 *
 * Exit codes:
 *   0 = pass (or warnings only, emitted to stderr)
 *   1 = validation errors found (non-zero for parse/schema failures)
 *
 * When invoked via hook-wrapper.mjs, exit 1 becomes exit 2 (block).
 * Warnings use exit 0 + stderr to match existing hook patterns.
 *
 * Usage:
 *   node .claude/scripts/docs-validate.mjs                    # Validate all docs
 *   node .claude/scripts/docs-validate.mjs --hook             # Hook mode (structured output)
 *   node .claude/scripts/docs-validate.mjs --project-root /p  # Override project root
 *
 * Implements: REQ-004, REQ-003, REQ-005, REQ-006, REQ-007, REQ-008,
 *             REQ-014, REQ-015, REQ-016, REQ-021, REQ-025
 * Spec: sg-structured-docs, Tasks 4-7
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, basename, relative } from 'node:path';
import { execSync } from 'node:child_process';

import {
  safeParseYaml,
  readAndParseYaml,
  confineToProject,
  confineToFlowsDir,
  checkFileSize,
  computeSourceHash,
  extractSourceHash,
  lfNormalize,
  getStructuredDocsDir,
  getGeneratedDir,
  resolveProjectRoot,
  DocsError,
  CURRENT_SCHEMA_VERSION,
  MAX_FILE_SIZE_BYTES,
  MAX_MODULES_COUNT,
  MAX_FLOWS_COUNT,
  SOURCE_HASH_PREFIX,
} from './lib/yaml-utils.mjs';

import {
  matchesGlob,
  HIGH_LEVEL_TRACE_PATH,
} from './lib/trace-utils.mjs';

// =============================================================================
// Constants
// =============================================================================

/** Allowed decision statuses */
const DECISION_STATUSES = ['proposed', 'accepted', 'deprecated', 'superseded'];

/** Allowed runbook severities */
const RUNBOOK_SEVERITIES = ['critical', 'high', 'medium', 'low'];

// =============================================================================
// Result Types
// =============================================================================

/**
 * @typedef {Object} ValidationIssue
 * @property {'error' | 'warning' | 'info'} level
 * @property {string} category - E.g., 'Parse error', 'Schema violation', 'Cross-reference', 'Freshness'
 * @property {string} message
 * @property {string} [filePath]
 * @property {string} [field]
 */

/**
 * @typedef {Object} ValidationResult
 * @property {ValidationIssue[]} errors
 * @property {ValidationIssue[]} warnings
 * @property {ValidationIssue[]} info
 */

/**
 * Create an empty validation result.
 * @returns {ValidationResult}
 */
function createResult() {
  return { errors: [], warnings: [], info: [] };
}

/**
 * Add an issue to the result.
 * @param {ValidationResult} result
 * @param {'error' | 'warning' | 'info'} level
 * @param {string} category
 * @param {string} message
 * @param {string} [filePath]
 * @param {string} [field]
 */
function addIssue(result, level, category, message, filePath, field) {
  const issue = { level, category, message, filePath, field };
  if (level === 'error') result.errors.push(issue);
  else if (level === 'warning') result.warnings.push(issue);
  else result.info.push(issue);
}

// =============================================================================
// Schema Version Validation (AC-2.1, AC-2.2, AC-2.3)
// =============================================================================

/**
 * Validate schema_version field.
 *
 * @param {any} doc - Parsed YAML document
 * @param {string} filePath - File path for error reporting
 * @param {ValidationResult} result
 * @returns {boolean} true if validation can continue
 */
function validateSchemaVersion(doc, filePath, result) {
  if (doc == null || typeof doc !== 'object') {
    addIssue(result, 'error', 'Schema violation', 'Document is empty or not an object', filePath);
    return false;
  }

  if (!('schema_version' in doc)) {
    addIssue(result, 'error', 'Schema violation', 'Missing required field: schema_version', filePath, 'schema_version');
    return false;
  }

  const version = doc.schema_version;

  if (typeof version !== 'number' || !Number.isInteger(version)) {
    addIssue(result, 'error', 'Schema violation', `schema_version must be an integer, got: ${typeof version}`, filePath, 'schema_version');
    return false;
  }

  // AC-2.3: Unknown (future) version
  if (version > CURRENT_SCHEMA_VERSION) {
    addIssue(result, 'error', 'Schema violation', `Unknown schema_version: ${version} (current: ${CURRENT_SCHEMA_VERSION})`, filePath, 'schema_version');
    return false;
  }

  // AC-2.2: Older version
  if (version < CURRENT_SCHEMA_VERSION) {
    addIssue(result, 'warning', 'Schema version', `Older schema_version: ${version} (current: ${CURRENT_SCHEMA_VERSION})`, filePath, 'schema_version');
  }

  // AC-2.1: Current version = no warnings
  return true;
}

// =============================================================================
// Schema Validation per Document Type
// =============================================================================

/**
 * Helper: check a field exists and is a string.
 */
function requireString(obj, field, filePath, context, result) {
  if (obj[field] == null || typeof obj[field] !== 'string' || obj[field].trim() === '') {
    addIssue(result, 'error', 'Schema violation', `${context}: missing or invalid required field "${field}" (expected non-empty string)`, filePath, field);
    return false;
  }
  return true;
}

/**
 * Helper: check a field exists and is a non-empty list.
 */
function requireList(obj, field, filePath, context, result) {
  if (!Array.isArray(obj[field])) {
    addIssue(result, 'error', 'Schema violation', `${context}: missing or invalid required field "${field}" (expected list)`, filePath, field);
    return false;
  }
  return true;
}

/**
 * Helper: check a field is an integer.
 */
function requireInteger(obj, field, filePath, context, result) {
  if (typeof obj[field] !== 'number' || !Number.isInteger(obj[field])) {
    addIssue(result, 'error', 'Schema violation', `${context}: missing or invalid required field "${field}" (expected integer)`, filePath, field);
    return false;
  }
  return true;
}

/**
 * Validate architecture.yaml (AC-1.2)
 *
 * @param {any} doc - Parsed architecture document
 * @param {string} filePath
 * @param {ValidationResult} result
 * @returns {string[]} List of valid module names (for cross-reference)
 */
export function validateArchitecture(doc, filePath, result) {
  const moduleNames = [];

  if (!requireList(doc, 'modules', filePath, 'architecture.yaml', result)) {
    return moduleNames;
  }

  // AC-11.6: Input size limit
  if (doc.modules.length > MAX_MODULES_COUNT) {
    addIssue(result, 'error', 'Size limit', `architecture.yaml has ${doc.modules.length} modules (max: ${MAX_MODULES_COUNT})`, filePath, 'modules');
    return moduleNames;
  }

  const seenNames = new Set();

  for (let i = 0; i < doc.modules.length; i++) {
    const mod = doc.modules[i];
    const ctx = `architecture.yaml modules[${i}]`;

    if (mod == null || typeof mod !== 'object') {
      addIssue(result, 'error', 'Schema violation', `${ctx}: expected object, got ${typeof mod}`, filePath);
      continue;
    }

    requireString(mod, 'name', filePath, ctx, result);
    requireString(mod, 'description', filePath, ctx, result);
    requireString(mod, 'path', filePath, ctx, result);
    requireList(mod, 'responsibilities', filePath, ctx, result);

    if (typeof mod.name === 'string' && mod.name.trim() !== '') {
      if (seenNames.has(mod.name)) {
        addIssue(result, 'error', 'Schema violation', `${ctx}: duplicate module name "${mod.name}"`, filePath, 'name');
      } else {
        seenNames.add(mod.name);
        moduleNames.push(mod.name);
      }
    }

    // Validate depends_on is a list of strings if present.
    // "dependencies" is accepted as an alias for "depends_on" (see schema.yaml).
    if (mod.depends_on != null) {
      if (!Array.isArray(mod.depends_on)) {
        addIssue(result, 'error', 'Schema violation', `${ctx}: "depends_on" must be a list`, filePath, 'depends_on');
      }
    }
    if (mod.dependencies != null && mod.depends_on == null) {
      if (!Array.isArray(mod.dependencies)) {
        addIssue(result, 'error', 'Schema violation', `${ctx}: "dependencies" must be a list`, filePath, 'dependencies');
      }
    }
  }

  return moduleNames;
}

/**
 * Validate flows/index.yaml (AC-1.4)
 *
 * @param {any} doc
 * @param {string} filePath
 * @param {ValidationResult} result
 * @returns {Array<{name: string, file: string}>} List of flow entries
 */
export function validateFlowsIndex(doc, filePath, result) {
  const flowEntries = [];

  if (!requireList(doc, 'flows', filePath, 'flows/index.yaml', result)) {
    return flowEntries;
  }

  // AC-11.7: Input size limit
  if (doc.flows.length > MAX_FLOWS_COUNT) {
    addIssue(result, 'error', 'Size limit', `flows/index.yaml has ${doc.flows.length} flows (max: ${MAX_FLOWS_COUNT})`, filePath, 'flows');
    return flowEntries;
  }

  const seenNames = new Set();

  for (let i = 0; i < doc.flows.length; i++) {
    const flow = doc.flows[i];
    const ctx = `flows/index.yaml flows[${i}]`;

    if (flow == null || typeof flow !== 'object') {
      addIssue(result, 'error', 'Schema violation', `${ctx}: expected object, got ${typeof flow}`, filePath);
      continue;
    }

    requireString(flow, 'name', filePath, ctx, result);
    requireString(flow, 'file', filePath, ctx, result);
    requireString(flow, 'description', filePath, ctx, result);

    if (typeof flow.name === 'string' && flow.name.trim() !== '') {
      if (seenNames.has(flow.name)) {
        addIssue(result, 'error', 'Schema violation', `${ctx}: duplicate flow name "${flow.name}"`, filePath, 'name');
      } else {
        seenNames.add(flow.name);
      }
    }

    if (typeof flow.name === 'string' && typeof flow.file === 'string') {
      flowEntries.push({ name: flow.name, file: flow.file });
    }
  }

  return flowEntries;
}

/**
 * Validate a flow YAML file (AC-1.5)
 *
 * @param {any} doc
 * @param {string} filePath
 * @param {ValidationResult} result
 * @returns {string[]} List of module names referenced in flow steps
 */
export function validateFlow(doc, filePath, result) {
  const referencedModules = [];
  const fileName = basename(filePath);

  requireString(doc, 'name', filePath, `flow ${fileName}`, result);
  requireString(doc, 'description', filePath, `flow ${fileName}`, result);

  if (!requireList(doc, 'steps', filePath, `flow ${fileName}`, result)) {
    return referencedModules;
  }

  for (let i = 0; i < doc.steps.length; i++) {
    const step = doc.steps[i];
    const ctx = `flow ${fileName} steps[${i}]`;

    if (step == null || typeof step !== 'object') {
      addIssue(result, 'error', 'Schema violation', `${ctx}: expected object, got ${typeof step}`, filePath);
      continue;
    }

    requireInteger(step, 'order', filePath, ctx, result);
    requireString(step, 'module', filePath, ctx, result);
    requireString(step, 'action', filePath, ctx, result);

    if (typeof step.module === 'string' && step.module.trim() !== '') {
      referencedModules.push(step.module);
    }
  }

  return referencedModules;
}

/**
 * Check if a flow file is a flow-coverage document (not a standard flow).
 * Flow-coverage files are identified by filename containing "flow-coverage".
 *
 * @param {string} fileName - The filename to check
 * @returns {boolean} true if this is a flow-coverage file
 */
export function isFlowCoverageFile(fileName) {
  return fileName.includes('flow-coverage');
}

/**
 * Validate flow-coverage YAML documents produced by the flow-verifier.
 * These have a distinct schema from standard flow documents (no steps/name/description required).
 *
 * @param {any} doc - Parsed flow-coverage document
 * @param {string} filePath - File path for error reporting
 * @param {ValidationResult} result
 */
export function validateFlowCoverage(doc, filePath, result) {
  const fileName = basename(filePath);
  const ctx = `flow-coverage ${fileName}`;

  requireString(doc, 'spec_group', filePath, ctx, result);
  requireString(doc, 'timestamp', filePath, ctx, result);

  // stage: required enum
  if (requireString(doc, 'stage', filePath, ctx, result)) {
    const validStages = ['prd-review', 'spec-review', 'impl-verify', 'post-impl'];
    if (!validStages.includes(doc.stage)) {
      addIssue(result, 'error', 'Schema violation', `${ctx}: stage must be one of ${validStages.join(', ')}, got "${doc.stage}"`, filePath, 'stage');
    }
  }

  // integration_points: required list of objects
  if (requireList(doc, 'integration_points', filePath, ctx, result)) {
    for (let i = 0; i < doc.integration_points.length; i++) {
      const pt = doc.integration_points[i];
      const ptCtx = `${ctx} integration_points[${i}]`;

      if (pt == null || typeof pt !== 'object') {
        addIssue(result, 'error', 'Schema violation', `${ptCtx}: expected object, got ${typeof pt}`, filePath);
        continue;
      }

      requireString(pt, 'source', filePath, ptCtx, result);
      requireString(pt, 'target', filePath, ptCtx, result);
      requireString(pt, 'flow_type', filePath, ptCtx, result);

      if (typeof pt.verified !== 'boolean') {
        addIssue(result, 'error', 'Schema violation', `${ptCtx}: missing or invalid required field "verified" (expected boolean)`, filePath, 'verified');
      }
    }
  }

  // verified_count: required integer
  requireInteger(doc, 'verified_count', filePath, ctx, result);

  // total_count: required integer
  requireInteger(doc, 'total_count', filePath, ctx, result);

  // coverage_percentage: required number
  if (typeof doc.coverage_percentage !== 'number') {
    addIssue(result, 'error', 'Schema violation', `${ctx}: missing or invalid required field "coverage_percentage" (expected number)`, filePath, 'coverage_percentage');
  }

  // unverified_points: optional list
  if (doc.unverified_points != null && !Array.isArray(doc.unverified_points)) {
    addIssue(result, 'warning', 'Schema violation', `${ctx}: "unverified_points" should be a list if present`, filePath, 'unverified_points');
  }
}

/**
 * Validate glossary.yaml (AC-1.3)
 *
 * @param {any} doc
 * @param {string} filePath
 * @param {ValidationResult} result
 * @returns {string[]} List of term names
 */
export function validateGlossary(doc, filePath, result) {
  const termNames = [];

  if (!requireList(doc, 'terms', filePath, 'glossary.yaml', result)) {
    return termNames;
  }

  const seenTerms = new Set();

  for (let i = 0; i < doc.terms.length; i++) {
    const term = doc.terms[i];
    const ctx = `glossary.yaml terms[${i}]`;

    if (term == null || typeof term !== 'object') {
      addIssue(result, 'error', 'Schema violation', `${ctx}: expected object, got ${typeof term}`, filePath);
      continue;
    }

    requireString(term, 'term', filePath, ctx, result);
    requireString(term, 'definition', filePath, ctx, result);

    if (typeof term.term === 'string' && term.term.trim() !== '') {
      if (seenTerms.has(term.term)) {
        addIssue(result, 'error', 'Schema violation', `${ctx}: duplicate term "${term.term}"`, filePath, 'term');
      } else {
        seenTerms.add(term.term);
        termNames.push(term.term);
      }
    }

    // Validate see_also is a list if present
    if (term.see_also != null && !Array.isArray(term.see_also)) {
      addIssue(result, 'error', 'Schema violation', `${ctx}: "see_also" must be a list`, filePath, 'see_also');
    }
  }

  return termNames;
}

/**
 * Validate decisions.yaml (AC-1.6)
 *
 * @param {any} doc
 * @param {string} filePath
 * @param {ValidationResult} result
 */
export function validateDecisions(doc, filePath, result) {
  if (!requireList(doc, 'decisions', filePath, 'decisions.yaml', result)) {
    return;
  }

  const seenIds = new Set();

  for (let i = 0; i < doc.decisions.length; i++) {
    const dec = doc.decisions[i];
    const ctx = `decisions.yaml decisions[${i}]`;

    if (dec == null || typeof dec !== 'object') {
      addIssue(result, 'error', 'Schema violation', `${ctx}: expected object, got ${typeof dec}`, filePath);
      continue;
    }

    requireString(dec, 'id', filePath, ctx, result);
    requireString(dec, 'title', filePath, ctx, result);
    requireString(dec, 'date', filePath, ctx, result);
    requireString(dec, 'context', filePath, ctx, result);
    requireString(dec, 'chosen', filePath, ctx, result);
    requireList(dec, 'options', filePath, ctx, result);
    requireList(dec, 'consequences', filePath, ctx, result);

    // Status enum validation
    if (requireString(dec, 'status', filePath, ctx, result)) {
      if (!DECISION_STATUSES.includes(dec.status)) {
        addIssue(result, 'error', 'Schema violation', `${ctx}: status must be one of: ${DECISION_STATUSES.join(', ')} (got: "${dec.status}")`, filePath, 'status');
      }
    }

    if (typeof dec.id === 'string' && dec.id.trim() !== '') {
      if (seenIds.has(dec.id)) {
        addIssue(result, 'error', 'Schema violation', `${ctx}: duplicate decision id "${dec.id}"`, filePath, 'id');
      } else {
        seenIds.add(dec.id);
      }
    }
  }
}

/**
 * Validate runbooks.yaml (AC-1.7)
 *
 * @param {any} doc
 * @param {string} filePath
 * @param {ValidationResult} result
 */
export function validateRunbooks(doc, filePath, result) {
  if (!requireList(doc, 'runbooks', filePath, 'runbooks.yaml', result)) {
    return;
  }

  const seenNames = new Set();

  for (let i = 0; i < doc.runbooks.length; i++) {
    const rb = doc.runbooks[i];
    const ctx = `runbooks.yaml runbooks[${i}]`;

    if (rb == null || typeof rb !== 'object') {
      addIssue(result, 'error', 'Schema violation', `${ctx}: expected object, got ${typeof rb}`, filePath);
      continue;
    }

    requireString(rb, 'name', filePath, ctx, result);
    requireString(rb, 'description', filePath, ctx, result);

    if (!requireList(rb, 'steps', filePath, ctx, result)) {
      continue;
    }

    for (let j = 0; j < rb.steps.length; j++) {
      const step = rb.steps[j];
      const stepCtx = `${ctx} steps[${j}]`;

      if (step == null || typeof step !== 'object') {
        addIssue(result, 'error', 'Schema violation', `${stepCtx}: expected object, got ${typeof step}`, filePath);
        continue;
      }

      requireInteger(step, 'order', filePath, stepCtx, result);
      requireString(step, 'action', filePath, stepCtx, result);
    }

    // Severity enum validation (optional field)
    if (rb.severity != null) {
      if (typeof rb.severity !== 'string' || !RUNBOOK_SEVERITIES.includes(rb.severity)) {
        addIssue(result, 'error', 'Schema violation', `${ctx}: severity must be one of: ${RUNBOOK_SEVERITIES.join(', ')} (got: "${rb.severity}")`, filePath, 'severity');
      }
    }

    if (typeof rb.name === 'string' && rb.name.trim() !== '') {
      if (seenNames.has(rb.name)) {
        addIssue(result, 'error', 'Schema violation', `${ctx}: duplicate runbook name "${rb.name}"`, filePath, 'name');
      } else {
        seenNames.add(rb.name);
      }
    }
  }
}

// =============================================================================
// Cross-Reference Validation (AC-4.1 through AC-4.5)
// =============================================================================

/**
 * Validate cross-references between documents.
 *
 * @param {object} docs - Parsed documents { architecture, flowsIndex, flows: Map, glossary }
 * @param {string[]} moduleNames - Valid module names from architecture
 * @param {string[]} termNames - Valid term names from glossary
 * @param {Array<{name: string, file: string}>} flowEntries - Flow index entries
 * @param {string} docsDir - Absolute path to structured docs directory
 * @param {string} projectRoot - Absolute project root
 * @param {ValidationResult} result
 */
export function validateCrossReferences(docs, moduleNames, termNames, flowEntries, docsDir, projectRoot, result) {
  const moduleSet = new Set(moduleNames);
  const termSet = new Set(termNames);
  const flowsDir = join(docsDir, 'flows');

  // AC-4.1: Flow step modules exist in architecture
  if (docs.flows) {
    for (const [flowFile, flowData] of docs.flows) {
      if (flowData.referencedModules) {
        for (const modName of flowData.referencedModules) {
          if (!moduleSet.has(modName)) {
            addIssue(result, 'error', 'Cross-reference', `Flow "${flowFile}" references module "${modName}" which does not exist in architecture.yaml`, join(flowsDir, flowFile), 'module');
          }
        }
      }
    }
  }

  // AC-4.2: Glossary see_also resolves
  if (docs.glossary && Array.isArray(docs.glossary.terms)) {
    for (const term of docs.glossary.terms) {
      if (Array.isArray(term.see_also)) {
        for (const ref of term.see_also) {
          if (!termSet.has(ref)) {
            addIssue(result, 'warning', 'Cross-reference', `Glossary term "${term.term}" references non-existent term "${ref}" in see_also`, join(docsDir, 'glossary.yaml'), 'see_also');
          }
        }
      }
    }
  }

  // AC-4.3: Flow index file references exist
  for (const entry of flowEntries) {
    // Validate flow file confinement (SEC-201)
    try {
      confineToFlowsDir(entry.file, flowsDir, projectRoot);
    } catch (err) {
      addIssue(result, 'error', 'Path confinement', `Flow index references file with path traversal: "${entry.file}"`, join(docsDir, 'flows', 'index.yaml'), 'file');
      continue;
    }

    const flowFilePath = join(flowsDir, entry.file);
    if (!existsSync(flowFilePath)) {
      addIssue(result, 'error', 'Cross-reference', `Flow index references missing file: "${entry.file}" for flow "${entry.name}"`, join(docsDir, 'flows', 'index.yaml'), 'file');
    }
  }

  // AC-4.4: Circular dependency detection
  if (docs.architecture && Array.isArray(docs.architecture.modules)) {
    detectCircularDeps(docs.architecture.modules, join(docsDir, 'architecture.yaml'), result);
  }

  // AC-4.5: Module path glob matches zero files
  if (docs.architecture && Array.isArray(docs.architecture.modules)) {
    checkModuleGlobs(docs.architecture.modules, projectRoot, join(docsDir, 'architecture.yaml'), result);
  }
}

/**
 * Detect circular dependencies using iterative DFS (AC-4.4).
 *
 * @param {Array<{name: string, depends_on?: string[]}>} modules
 * @param {string} filePath
 * @param {ValidationResult} result
 */
export function detectCircularDeps(modules, filePath, result) {
  const graph = new Map();
  for (const mod of modules) {
    if (mod.name) {
      // Support both depends_on and dependencies field names
      const deps = mod.depends_on || mod.dependencies || [];
      graph.set(mod.name, deps.filter(d => typeof d === 'string'));
    }
  }

  const visited = new Set();
  const inStack = new Set();
  const cycles = [];

  for (const [node] of graph) {
    if (visited.has(node)) continue;

    // Iterative DFS with cycle detection
    const stack = [[node, 0, [node]]];

    while (stack.length > 0) {
      const [current, neighborIdx, path] = stack[stack.length - 1];
      const neighbors = graph.get(current) || [];

      if (neighborIdx >= neighbors.length) {
        stack.pop();
        inStack.delete(current);
        visited.add(current);
        continue;
      }

      // Advance to next neighbor
      stack[stack.length - 1][1] = neighborIdx + 1;
      const next = neighbors[neighborIdx];

      if (!graph.has(next)) continue; // Skip references to non-existent modules (caught by cross-ref)

      if (inStack.has(next)) {
        // Found a cycle
        const cycleStart = path.indexOf(next);
        const cycle = [...path.slice(cycleStart), next];
        cycles.push(cycle);
        continue;
      }

      if (!visited.has(next)) {
        inStack.add(next);
        stack.push([next, 0, [...path, next]]);
      }
    }
  }

  // Report cycles as informational notes
  for (const cycle of cycles) {
    const cycleStr = cycle.join(' -> ');
    addIssue(result, 'info', 'Circular dependency', `Circular dependency detected: ${cycleStr}`, filePath);
  }
}

/**
 * Check if module path globs match any files (AC-4.5).
 *
 * @param {Array<{name: string, path: string}>} modules
 * @param {string} projectRoot
 * @param {string} filePath
 * @param {ValidationResult} result
 */
function checkModuleGlobs(modules, projectRoot, filePath, result) {
  let allFiles = null;

  try {
    allFiles = execSync('git ls-files', {
      encoding: 'utf-8',
      cwd: projectRoot,
      timeout: 10_000,
    }).trim().split('\n').filter(Boolean);
  } catch {
    // Git not available -- skip glob checking
    return;
  }

  // INC-007: Use matchesGlob from trace-utils instead of local simpleGlobMatch
  for (const mod of modules) {
    if (!mod.path || typeof mod.path !== 'string') continue;

    const pattern = mod.path;
    let matchCount = 0;

    for (const file of allFiles) {
      if (matchesGlob(file, pattern)) {
        matchCount++;
        break; // Only need to find one match
      }
    }

    if (matchCount === 0) {
      addIssue(result, 'warning', 'Dangling glob', `Module "${mod.name}" path glob "${mod.path}" matches zero files`, filePath, 'path');
    }
  }
}

// =============================================================================
// Freshness Detection (AC-6.3, AC-6.5, AC-7.3)
// =============================================================================

/**
 * Check freshness of generated .mmd files against YAML sources.
 *
 * @param {string} docsDir - Absolute path to structured docs directory
 * @param {ValidationResult} result
 */
export function checkFreshness(docsDir, result) {
  const generatedDir = join(docsDir, 'generated');

  if (!existsSync(generatedDir)) {
    return; // No generated files to check
  }

  // Check architecture.mmd freshness
  const archMmdPath = join(generatedDir, 'architecture.mmd');
  const archYamlPath = join(docsDir, 'architecture.yaml');

  if (existsSync(archMmdPath) && existsSync(archYamlPath)) {
    checkSingleFreshness(archYamlPath, archMmdPath, 'architecture', result);
  }

  // Check flow .mmd freshness
  const flowsDir = join(docsDir, 'flows');
  if (existsSync(flowsDir)) {
    let files;
    try {
      files = readdirSync(generatedDir);
    } catch {
      return;
    }

    for (const file of files) {
      if (file.startsWith('flow-') && file.endsWith('.mmd')) {
        const flowName = file.slice(5, -4); // Remove "flow-" prefix and ".mmd" suffix
        const flowYamlPath = join(flowsDir, `${flowName}.yaml`);
        const flowMmdPath = join(generatedDir, file);

        if (existsSync(flowYamlPath)) {
          checkSingleFreshness(flowYamlPath, flowMmdPath, `flow ${flowName}`, result);
        }
      }
    }
  }
}

/**
 * Check freshness of a single YAML -> .mmd pair.
 *
 * @param {string} yamlPath
 * @param {string} mmdPath
 * @param {string} label
 * @param {ValidationResult} result
 */
function checkSingleFreshness(yamlPath, mmdPath, label, result) {
  try {
    const yamlContent = readFileSync(yamlPath, 'utf-8');
    const mmdContent = readFileSync(mmdPath, 'utf-8');

    const currentHash = computeSourceHash(yamlContent);
    const embeddedHash = extractSourceHash(mmdContent);

    if (embeddedHash === null) {
      addIssue(result, 'warning', 'Freshness', `${label}: generated .mmd file has no source-hash header. Manual edits will be overwritten on next generate.`, mmdPath);
    } else if (embeddedHash !== currentHash) {
      addIssue(result, 'warning', 'Freshness', `${label}: source hash mismatch (yaml: ${currentHash}, mmd: ${embeddedHash}). Generated diagram is stale or was manually edited. Manual edits will be overwritten on next generate.`, mmdPath);
    }
  } catch {
    // File read failures are not freshness issues
  }
}

/**
 * Check for empty architecture (AC-7.3: scaffolder nudge).
 *
 * @param {any} archDoc - Parsed architecture document (may be null)
 * @param {string} filePath
 * @param {ValidationResult} result
 */
export function checkEmptyArchitecture(archDoc, filePath, result) {
  if (archDoc && Array.isArray(archDoc.modules) && archDoc.modules.length === 0) {
    addIssue(result, 'info', 'Scaffolder nudge', 'architecture.yaml has zero modules. Run `node .claude/scripts/docs-scaffold.mjs` to generate a draft from your project structure.', filePath);
  }
}

// =============================================================================
// Main Validation Pipeline
// =============================================================================

/**
 * Run the full validation pipeline on all structured docs.
 *
 * @param {string} projectRoot - Absolute project root path
 * @returns {ValidationResult}
 */
export function validateAll(projectRoot) {
  const result = createResult();
  const docsDir = getStructuredDocsDir(projectRoot);

  if (!existsSync(docsDir)) {
    addIssue(result, 'info', 'Setup', 'No structured docs directory found. Run docs-scaffold.mjs to get started.');
    return result;
  }

  // Track parsed docs for cross-reference validation
  const parsedDocs = {
    architecture: null,
    flowsIndex: null,
    flows: new Map(),
    glossary: null,
  };
  let moduleNames = [];
  let termNames = [];
  let flowEntries = [];

  // --- Validate architecture.yaml ---
  const archPath = join(docsDir, 'architecture.yaml');
  if (existsSync(archPath)) {
    try {
      const { data } = readAndParseYaml(archPath);
      if (validateSchemaVersion(data, archPath, result)) {
        moduleNames = validateArchitecture(data, archPath, result);
        parsedDocs.architecture = data;
        checkEmptyArchitecture(data, archPath, result);
      }
    } catch (err) {
      if (err instanceof DocsError) {
        addIssue(result, 'error', err.category, err.message, err.filePath);
      } else {
        addIssue(result, 'error', 'Parse error', `Unexpected error validating architecture.yaml: ${err.message}`, archPath);
      }
    }
  }

  // --- Validate flows/index.yaml ---
  const flowsIndexPath = join(docsDir, 'flows', 'index.yaml');
  if (existsSync(flowsIndexPath)) {
    try {
      const { data } = readAndParseYaml(flowsIndexPath);
      if (validateSchemaVersion(data, flowsIndexPath, result)) {
        flowEntries = validateFlowsIndex(data, flowsIndexPath, result);
        parsedDocs.flowsIndex = data;
      }
    } catch (err) {
      if (err instanceof DocsError) {
        addIssue(result, 'error', err.category, err.message, err.filePath);
      } else {
        addIssue(result, 'error', 'Parse error', `Unexpected error validating flows/index.yaml: ${err.message}`, flowsIndexPath);
      }
    }
  }

  // --- Validate individual flow files ---
  const flowsDir = join(docsDir, 'flows');
  if (existsSync(flowsDir)) {
    try {
      const flowFiles = readdirSync(flowsDir).filter(f => f.endsWith('.yaml') && f !== 'index.yaml');
      for (const flowFile of flowFiles) {
        const flowPath = join(flowsDir, flowFile);
        try {
          const { data } = readAndParseYaml(flowPath);
          if (validateSchemaVersion(data, flowPath, result)) {
            // Flow-coverage files have a distinct schema from standard flow documents
            if (isFlowCoverageFile(flowFile)) {
              validateFlowCoverage(data, flowPath, result);
            } else {
              const referencedModules = validateFlow(data, flowPath, result);
              parsedDocs.flows.set(flowFile, { doc: data, referencedModules });
            }
          }
        } catch (err) {
          if (err instanceof DocsError) {
            addIssue(result, 'error', err.category, err.message, err.filePath);
          } else {
            addIssue(result, 'error', 'Parse error', `Unexpected error validating ${flowFile}: ${err.message}`, flowPath);
          }
        }
      }
    } catch {
      // Directory read failure
    }
  }

  // --- Validate glossary.yaml ---
  const glossaryPath = join(docsDir, 'glossary.yaml');
  if (existsSync(glossaryPath)) {
    try {
      const { data } = readAndParseYaml(glossaryPath);
      if (validateSchemaVersion(data, glossaryPath, result)) {
        termNames = validateGlossary(data, glossaryPath, result);
        parsedDocs.glossary = data;
      }
    } catch (err) {
      if (err instanceof DocsError) {
        addIssue(result, 'error', err.category, err.message, err.filePath);
      } else {
        addIssue(result, 'error', 'Parse error', `Unexpected error validating glossary.yaml: ${err.message}`, glossaryPath);
      }
    }
  }

  // --- Validate decisions.yaml (extension, optional) ---
  const decisionsPath = join(docsDir, 'decisions.yaml');
  if (existsSync(decisionsPath)) {
    try {
      const { data } = readAndParseYaml(decisionsPath);
      if (validateSchemaVersion(data, decisionsPath, result)) {
        validateDecisions(data, decisionsPath, result);
      }
    } catch (err) {
      if (err instanceof DocsError) {
        addIssue(result, 'error', err.category, err.message, err.filePath);
      } else {
        addIssue(result, 'error', 'Parse error', `Unexpected error validating decisions.yaml: ${err.message}`, decisionsPath);
      }
    }
  }

  // --- Validate runbooks.yaml (extension, optional) ---
  const runbooksPath = join(docsDir, 'runbooks.yaml');
  if (existsSync(runbooksPath)) {
    try {
      const { data } = readAndParseYaml(runbooksPath);
      if (validateSchemaVersion(data, runbooksPath, result)) {
        validateRunbooks(data, runbooksPath, result);
      }
    } catch (err) {
      if (err instanceof DocsError) {
        addIssue(result, 'error', err.category, err.message, err.filePath);
      } else {
        addIssue(result, 'error', 'Parse error', `Unexpected error validating runbooks.yaml: ${err.message}`, runbooksPath);
      }
    }
  }

  // --- Cross-reference validation ---
  validateCrossReferences(parsedDocs, moduleNames, termNames, flowEntries, docsDir, projectRoot, result);

  // --- Freshness detection ---
  checkFreshness(docsDir, result);

  // --- Trace cross-reference validation (REQ-017) ---
  if (moduleNames.length > 0) {
    validateTraceCrossReferences(moduleNames, projectRoot, archPath, result);
  }

  // --- Path confinement for architecture module paths ---
  if (parsedDocs.architecture && Array.isArray(parsedDocs.architecture.modules)) {
    for (const mod of parsedDocs.architecture.modules) {
      if (mod.path && typeof mod.path === 'string') {
        try {
          // Path globs can contain wildcards, so we check the base path
          // Only reject explicit traversal patterns
          if (mod.path.includes('..')) {
            throw new DocsError(
              `Path confinement violation: module "${mod.name}" path "${mod.path}" contains ".."`,
              'Path confinement',
              archPath,
            );
          }
        } catch (err) {
          if (err instanceof DocsError) {
            addIssue(result, 'error', err.category, err.message, err.filePath);
          }
        }
      }
    }
  }

  return result;
}

// =============================================================================
// Trace Cross-Reference Validation (M3: REQ-017)
// =============================================================================

/**
 * Validate that module names in architecture.yaml correspond to modules
 * present in the trace system.
 *
 * Task 3.4 (REQ-017): Reports modules referenced in docs but not found in
 * traces (error) and traced modules not referenced in docs (informational).
 * Skips silently if trace data is not available.
 *
 * @param {string[]} docsModuleNames - Module names from architecture.yaml
 * @param {string} projectRoot - Absolute project root path
 * @param {string} archPath - Path to architecture.yaml for error reporting
 * @param {ValidationResult} result
 */
function validateTraceCrossReferences(docsModuleNames, projectRoot, archPath, result) {
  // Load high-level trace JSON to get traced module list
  let traceData;
  try {
    const tracePath = join(projectRoot, HIGH_LEVEL_TRACE_PATH);
    if (!existsSync(tracePath)) {
      // No trace data -- skip silently (trace integration is additive)
      return;
    }
    const raw = readFileSync(tracePath, 'utf-8');
    traceData = JSON.parse(raw);
  } catch {
    // Failed to read/parse trace data -- skip silently
    return;
  }

  if (!traceData || !Array.isArray(traceData.modules)) {
    return;
  }

  // Build sets for comparison
  const tracedModuleIds = new Set(traceData.modules.map(m => m.id));
  const tracedModuleNames = new Set(traceData.modules.map(m => m.name));
  const docsModuleSet = new Set(docsModuleNames);

  // Check for docs modules not found in traces
  for (const docModule of docsModuleNames) {
    if (!tracedModuleIds.has(docModule) && !tracedModuleNames.has(docModule)) {
      addIssue(
        result,
        'warning',
        'Trace cross-reference',
        `Module "${docModule}" is defined in architecture.yaml but not found in trace data`,
        archPath,
        'modules',
      );
    }
  }

  // Check for traced modules not found in docs (informational)
  for (const tracedModule of traceData.modules) {
    if (!docsModuleSet.has(tracedModule.id) && !docsModuleSet.has(tracedModule.name)) {
      addIssue(
        result,
        'info',
        'Trace cross-reference',
        `Traced module "${tracedModule.id}" (${tracedModule.name}) is not referenced in architecture.yaml`,
        archPath,
        'modules',
      );
    }
  }
}

// =============================================================================
// CLI Entry Point
// =============================================================================

/**
 * Format issues for human-readable output.
 */
function formatIssues(issues) {
  return issues.map(i => {
    const loc = i.filePath ? ` [${i.filePath}]` : '';
    const field = i.field ? ` (field: ${i.field})` : '';
    return `  ${i.level.toUpperCase()}: [${i.category}]${loc}${field} ${i.message}`;
  }).join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const hookMode = args.includes('--hook');

  try {
    const projectRoot = resolveProjectRoot();
    const result = validateAll(projectRoot);

    const hasErrors = result.errors.length > 0;
    const hasWarnings = result.warnings.length > 0;
    const hasInfo = result.info.length > 0;

    if (hookMode) {
      // Hook mode: structured output for PostToolUse integration
      if (hasErrors) {
        // Errors -> stderr + exit 1 (hook-wrapper converts to exit 2)
        console.error(`Structured docs validation: ${result.errors.length} error(s)`);
        console.error(formatIssues(result.errors));
        process.exit(1);
      }
      if (hasWarnings) {
        // Warnings -> stderr + exit 0 (matching existing hook patterns)
        console.error(`Structured docs validation: ${result.warnings.length} warning(s)`);
        console.error(formatIssues(result.warnings));
        process.exit(0);
      }
      if (hasInfo) {
        console.error(formatIssues(result.info));
      }
      process.exit(0);
    } else {
      // CLI mode: full human-readable output
      if (hasErrors) {
        console.log(`\nErrors (${result.errors.length}):`);
        console.log(formatIssues(result.errors));
      }
      if (hasWarnings) {
        console.log(`\nWarnings (${result.warnings.length}):`);
        console.log(formatIssues(result.warnings));
      }
      if (hasInfo) {
        console.log(`\nInfo (${result.info.length}):`);
        console.log(formatIssues(result.info));
      }
      if (!hasErrors && !hasWarnings && !hasInfo) {
        console.log('Structured docs validation: all checks passed.');
      }

      const total = result.errors.length + result.warnings.length + result.info.length;
      console.log(`\nSummary: ${result.errors.length} errors, ${result.warnings.length} warnings, ${result.info.length} info`);

      process.exit(hasErrors ? 1 : 0);
    }
  } catch (err) {
    console.error(`Validation failed: ${err.message}`);
    process.exit(1);
  }
}

// Run main only if executed directly
const isMainModule = process.argv[1] &&
  process.argv[1].endsWith('docs-validate.mjs') &&
  !process.argv[1].endsWith('.test.mjs');

if (isMainModule) {
  main();
}
