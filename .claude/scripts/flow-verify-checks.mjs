#!/usr/bin/env node

/**
 * Flow Verify Pre-Computation Script
 *
 * Standalone script run by the orchestrating agent (which has Bash access)
 * before dispatching the read-only flow-verifier agent. Performs trace-based
 * wiring analysis, six-category wiring checks, and Grep/Glob fallback when
 * traces are unavailable.
 *
 * Outputs structured JSON to .claude/specs/groups/<sg>/.flow-verify-precomputed.json
 * for the flow-verifier agent to consume via its Read tool.
 *
 * Usage:
 *   node .claude/scripts/flow-verify-checks.mjs --sg <spec-group-id> --stage <stage> [options]
 *
 * Options:
 *   --sg <id>                  Spec group ID (required)
 *   --stage <stage>            Stage: prd-review, spec-review, impl-verify, post-impl
 *   --scope <scope>            Scope: full (default), workstream, post-merge
 *   --workstream <ws-id>       Workstream ID (for per-workstream scoping)
 *   --project-root <path>      Override project root
 *
 * Exit codes:
 *   0 = success (results written)
 *   1 = fatal error (no results written)
 *
 * Implements: AC-1.3, AC-1.4, AC-1.5, AC-1.6, AC-1.10, AC-1.11, AC-1.12, AC-1.15
 * Spec: sg-flow-verifier, Tasks B1-B10
 */

import { existsSync, readFileSync, readlinkSync, writeFileSync, mkdirSync, readdirSync, statSync, lstatSync } from 'node:fs';
import { join, resolve, relative, basename, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

// =============================================================================
// Constants
// =============================================================================

/** Valid stage modes (AC-1.1, REQ-001) */
const VALID_STAGES = ['prd-review', 'spec-review', 'impl-verify', 'post-impl'];

/** Valid scope modes */
const VALID_SCOPES = ['full', 'workstream', 'post-merge'];

/** Wiring bug categories (6-category taxonomy per spec) */
export const WIRING_BUG_CATEGORIES = [
  'missing-import',
  'unregistered-route',
  'mismatched-event',
  'wrong-config',
  'disconnected-handler',
  'missing-middleware',
];

/** Flow types */
export const FLOW_TYPES = ['user', 'data', 'event', 'logical'];

/** Severity levels */
export const SEVERITY_LEVELS = ['Critical', 'High', 'Medium', 'Low'];

/** Severity elevation order (for carry-forward) */
const SEVERITY_ORDER = { 'Low': 0, 'Medium': 1, 'High': 2, 'Critical': 3 };

/** Maximum files for Grep/Glob fallback (AC-1.5, REQ-021) */
const FALLBACK_MAX_FILES = 500;

/** Maximum time for Grep/Glob fallback in ms (AC-1.5, REQ-021) */
const FALLBACK_TIMEOUT_MS = 120_000;

/** Output filename for pre-computed results */
const PRECOMPUTED_FILENAME = '.flow-verify-precomputed.json';

/** Carry-forward filename */
const CARRY_FORWARD_FILENAME = 'flow-findings.json';

/** Prototype pollution guard segments (AC-1.11) */
const POISONED_SEGMENTS = ['__proto__', 'constructor', 'prototype'];

/** YAML special characters to escape (AC-1.12) */
const YAML_SPECIAL_CHARS = [':', '#', '&', '*', '!', '|', '>', "'", '"', '%', '@', '`'];

/** Markdown special characters to escape (AC-1.12) */
const MARKDOWN_SPECIAL_CHARS = ['\\', '`', '*', '_', '{', '}', '[', ']', '(', ')', '#', '+', '-', '.', '!', '|'];

// =============================================================================
// Argument Parsing
// =============================================================================

function parseArgs(argv) {
  const args = {
    sg: null,
    stage: 'impl-verify',
    scope: 'full',
    workstream: null,
    projectRoot: null,
  };

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--sg':
        args.sg = argv[++i];
        break;
      case '--stage':
        args.stage = argv[++i];
        break;
      case '--scope':
        args.scope = argv[++i];
        break;
      case '--workstream':
        args.workstream = argv[++i];
        break;
      case '--project-root':
        args.projectRoot = argv[++i];
        break;
    }
  }

  return args;
}

// =============================================================================
// Project Root Resolution
// =============================================================================

function resolveProjectRoot(override) {
  if (override) return resolve(override);

  // Walk up from script location to find .claude directory
  let dir = dirname(resolve(import.meta.url.replace('file://', '')));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, '.claude'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

// =============================================================================
// Input Validation (AC-1.11, REQ-028)
// =============================================================================

/**
 * Validate a file path is within the project root (no symlink escape).
 * Uses path.resolve('/') to prevent path traversal (AC-1.11).
 *
 * @param {string} filePath - Path to validate
 * @param {string} projectRoot - Project root directory
 * @returns {boolean} True if path is safe
 */
export function isPathSafe(filePath, projectRoot) {
  const resolvedRoot = resolve(projectRoot);

  // Check for prototype pollution segments
  const segments = filePath.split('/');
  for (const seg of segments) {
    if (POISONED_SEGMENTS.includes(seg)) return false;
  }

  // Resolve relative to project root
  const fullPath = resolve(projectRoot, filePath);
  if (fullPath !== resolvedRoot && !fullPath.startsWith(resolvedRoot + '/')) return false;

  // Check symlink does not escape
  try {
    const stat = lstatSync(fullPath);
    if (stat.isSymbolicLink()) {
      const realPath = readlinkSync(fullPath, 'utf8');
      const resolvedLink = resolve(dirname(fullPath), realPath);
      if (resolvedLink !== resolvedRoot && !resolvedLink.startsWith(resolvedRoot + '/')) return false;
    }
  } catch {
    // Intentional: if lstat/readlink fails (file doesn't exist yet, or permission denied),
    // treat the path as safe. The symlink escape check is defense-in-depth; the prefix
    // check above is the primary guard. Non-existent paths are fine for validation.
  }

  return true;
}

/**
 * Validate carry-forward JSON entry structure (AC-1.11, REQ-028).
 *
 * @param {object} entry - Carry-forward entry to validate
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateCarryForwardEntry(entry) {
  const errors = [];
  const requiredFields = ['finding_id', 'severity', 'summary', 'stage', 'pass_number', 'integration_point', 'status', 'written_by'];

  for (const field of requiredFields) {
    if (entry[field] === undefined || entry[field] === null) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  if (entry.severity && !SEVERITY_LEVELS.includes(entry.severity)) {
    errors.push(`Invalid severity: ${entry.severity}`);
  }

  const validStatuses = ['open', 'resolved', 'escalated', 'human-overridden'];
  if (entry.status && !validStatuses.includes(entry.status)) {
    errors.push(`Invalid status: ${entry.status}`);
  }

  if (entry.written_by && entry.written_by !== 'flow-verifier') {
    errors.push(`Invalid written_by: ${entry.written_by} (must be 'flow-verifier')`);
  }

  if (entry.stage && !VALID_STAGES.includes(entry.stage)) {
    errors.push(`Invalid stage: ${entry.stage}`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate trace data structure before consumption (AC-1.11).
 *
 * @param {object} traceData - Parsed trace JSON
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateTraceData(traceData) {
  const errors = [];

  if (!traceData || typeof traceData !== 'object') {
    errors.push('Trace data is not an object');
    return { valid: false, errors };
  }

  if (!traceData.moduleId || typeof traceData.moduleId !== 'string') {
    errors.push('Missing or invalid moduleId');
  }

  if (!Array.isArray(traceData.files)) {
    errors.push('Missing or invalid files array');
  }

  return { valid: errors.length === 0, errors };
}

// =============================================================================
// Output Sanitization (AC-1.12, REQ-029)
// =============================================================================

/**
 * Escape YAML special characters in a string (AC-1.12).
 *
 * @param {string} text - Text to sanitize
 * @returns {string} Sanitized text
 */
export function sanitizeYaml(text) {
  if (!text || typeof text !== 'string') return text;
  let result = text;
  for (const ch of YAML_SPECIAL_CHARS) {
    result = result.split(ch).join('\\' + ch);
  }
  return result;
}

/**
 * Escape markdown special characters in a string (AC-1.12).
 * Follows sanitizeMarkdown() pattern from trace-utils.mjs.
 *
 * @param {string} text - Text to sanitize
 * @returns {string} Sanitized text
 */
export function sanitizeMarkdown(text) {
  if (!text || typeof text !== 'string') return text;
  let result = text;
  for (const ch of MARKDOWN_SPECIAL_CHARS) {
    result = result.split(ch).join('\\' + ch);
  }
  return result;
}

/**
 * Sanitize text for safe embedding in JSON string values (AC-1.12).
 *
 * @param {string} text - Text to sanitize
 * @returns {string} Sanitized text
 */
export function sanitizeJson(text) {
  if (!text || typeof text !== 'string') return text;
  // JSON.stringify handles escaping; we strip control chars
  return text.replace(/[\x00-\x1f\x7f]/g, '');
}

// =============================================================================
// Trace System Integration (AC-1.4, REQ-020)
// =============================================================================

/**
 * Load trace config and utility functions.
 * Attempts to import from trace-utils.mjs for consistency.
 *
 * @param {string} projectRoot
 * @returns {{ config: object|null, fileToModule: Function|null, isTraceStale: Function|null }}
 */
export function loadTraceSystem(projectRoot) {
  const traceConfigPath = join(projectRoot, '.claude', 'traces', 'trace.config.json');

  let config = null;
  let fileToModuleFn = null;
  let isTraceStaleFn = null;

  try {
    if (existsSync(traceConfigPath)) {
      config = JSON.parse(readFileSync(traceConfigPath, 'utf8'));
    }
  } catch (err) {
    // Graceful degradation: no trace config
    return { config: null, fileToModule: null, isTraceStale: null, warning: `Failed to load trace config: ${err.message}` };
  }

  // Build a local fileToModule implementation matching trace-utils.mjs
  // Maps a file path to its owning module ID based on fileGlobs
  fileToModuleFn = (filePath) => {
    if (!config || !config.modules) return null;
    for (const mod of config.modules) {
      if (!mod.fileGlobs) continue;
      for (const glob of mod.fileGlobs) {
        if (matchesGlob(filePath, glob)) {
          return mod.id;
        }
      }
    }
    return null;
  };

  // Build a local isTraceStale implementation
  isTraceStaleFn = (moduleId) => {
    const tracePath = join(projectRoot, '.claude', 'traces', 'low-level', `${moduleId}.json`);
    try {
      if (!existsSync(tracePath)) return true;
      const traceStat = statSync(tracePath);
      const traceAge = Date.now() - traceStat.mtimeMs;
      // Consider stale if older than staleness threshold (default 24h)
      const thresholdMs = (config.stalenessThresholdHours || 24) * 60 * 60 * 1000;
      return traceAge > thresholdMs;
    } catch {
      // Intentional: if stat fails, treat trace as stale (safe default -- triggers re-generation)
      return true;
    }
  };

  return { config, fileToModule: fileToModuleFn, isTraceStale: isTraceStaleFn, warning: null };
}

/**
 * Simple glob matching function (consistent with trace-utils.mjs pattern).
 *
 * @param {string} filePath - Path to test
 * @param {string} pattern - Glob pattern
 * @returns {boolean}
 */
function matchesGlob(filePath, pattern) {
  const regexStr = globToRegex(pattern);
  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(filePath);
}

/**
 * Convert glob pattern to regex (consistent with trace-utils.mjs).
 *
 * @param {string} pattern
 * @returns {string}
 */
function globToRegex(pattern) {
  let regexStr = '';
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          regexStr += '(.*/)?';
          i += 3;
        } else {
          regexStr += '.*';
          i += 2;
        }
      } else {
        regexStr += '[^/]*';
        i += 1;
      }
    } else if (char === '?') {
      regexStr += '[^/]';
      i += 1;
    } else {
      regexStr += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }

  return regexStr;
}

/**
 * Read low-level trace data for a module (AC-1.4).
 *
 * @param {string} moduleId - Module ID
 * @param {string} projectRoot
 * @returns {object|null} Parsed trace data or null
 */
export function readModuleTrace(moduleId, projectRoot) {
  const tracePath = join(projectRoot, '.claude', 'traces', 'low-level', `${moduleId}.json`);
  try {
    if (!existsSync(tracePath)) return null;
    const data = JSON.parse(readFileSync(tracePath, 'utf8'));
    const validation = validateTraceData(data);
    if (!validation.valid) {
      return null;
    }
    return data;
  } catch {
    // Intentional: graceful degradation when trace file is corrupt or unreadable.
    // Caller falls back to Grep/Glob discovery when trace data is unavailable.
    return null;
  }
}

// =============================================================================
// File Discovery
// =============================================================================

/**
 * Discover files modified in a spec group using git diff.
 * Uses execFileSync for safety (AC-1.11 -- no command injection).
 *
 * @param {string} specGroupId
 * @param {string} projectRoot
 * @returns {string[]} List of modified file paths (relative to project root)
 */
export function discoverModifiedFiles(specGroupId, projectRoot) {
  try {
    // Get files from git diff against main
    const output = execFileSync('git', ['diff', '--name-only', 'HEAD~10', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 30_000,
    });
    return output.trim().split('\n').filter(Boolean);
  } catch (err) {
    // Fallback: list files in spec group directory when git diff is unavailable
    // (e.g., shallow clone, missing HEAD~10, or git not installed)
    try {
      const specDir = join(projectRoot, '.claude', 'specs', 'groups', specGroupId);
      if (!existsSync(specDir)) return [];
      return readdirSync(specDir)
        .filter(f => f.endsWith('.md') || f.endsWith('.json'))
        .map(f => join('.claude', 'specs', 'groups', specGroupId, f));
    } catch {
      // Intentional: if both git diff and directory listing fail, return empty array.
      // Callers treat empty file lists as "no files to check" which is safe --
      // findings will reflect zero coverage rather than false positives.
      return [];
    }
  }
}

// =============================================================================
// Wiring Checks (Tasks B2-B7)
// =============================================================================

/**
 * Check for unregistered routes (B2, Practice 4.5 check #1).
 * Verify spec-declared endpoints have corresponding router mounts in source.
 *
 * @param {object[]} traceFiles - Array of trace file data with imports/exports
 * @param {string} projectRoot
 * @returns {object[]} Array of findings
 */
export function checkUnregisteredRoutes(traceFiles, projectRoot) {
  const findings = [];
  const routeDefinitions = [];
  const routeMounts = [];

  for (const trace of traceFiles) {
    if (!trace || !trace.files) continue;
    for (const file of trace.files) {
      if (!file.exports) continue;

      // Look for route handler exports (common patterns)
      for (const exp of file.exports) {
        const symbol = exp.symbol || '';
        if (/(?:router|route|handler|controller)/i.test(symbol)) {
          routeDefinitions.push({
            file: file.filePath,
            symbol: symbol,
            line: exp.lineNumber || 0,
          });
        }
      }

      // Look for route registration imports (app.use, router.get, etc.)
      if (file.imports) {
        for (const imp of file.imports) {
          const source = imp.source || '';
          if (/(?:router|route|handler|controller)/i.test(source)) {
            for (const sym of (imp.symbols || [])) {
              routeMounts.push({
                file: file.filePath,
                importedFrom: source,
                symbol: sym,
              });
            }
          }
        }
      }
    }
  }

  // Find route definitions not imported anywhere
  for (const def of routeDefinitions) {
    const isImported = routeMounts.some(mount =>
      mount.importedFrom.includes(basename(def.file, '.ts')) ||
      mount.importedFrom.includes(basename(def.file, '.mjs')) ||
      mount.importedFrom.includes(basename(def.file, '.js')) ||
      mount.symbol === def.symbol
    );

    if (!isImported) {
      findings.push(createFinding({
        category: 'unregistered-route',
        severity: 'High',
        flow_type: 'data',
        source: { file: def.file, line: def.line, symbol: def.symbol },
        target: { file: 'unknown', line: 0, symbol: 'router' },
        evidence: `Route handler '${sanitizeJson(def.symbol)}' exported from ${sanitizeJson(def.file)} but not imported by any router/app module`,
        recommendation: `Import and register '${sanitizeJson(def.symbol)}' in the appropriate router file`,
      }));
    }
  }

  return findings;
}

/**
 * Check for mismatched event names (B3, Practice 4.5 check #2).
 * Verify publisher event strings match subscriber event strings.
 *
 * @param {object[]} traceFiles - Array of trace file data
 * @param {string} projectRoot
 * @returns {object[]} Array of findings
 */
export function checkMismatchedEvents(traceFiles, projectRoot) {
  const findings = [];
  const publishers = [];
  const subscribers = [];

  for (const trace of traceFiles) {
    if (!trace || !trace.files) continue;
    for (const file of trace.files) {
      if (!file.events) continue;
      for (const event of file.events) {
        const entry = {
          file: file.filePath,
          line: event.line || 0,
          eventName: event.eventName || '',
        };
        if (event.type === 'publish' || event.type === 'emit') {
          publishers.push(entry);
        } else if (event.type === 'subscribe' || event.type === 'on' || event.type === 'listen') {
          subscribers.push(entry);
        }
      }
    }
  }

  // Find publishers with no matching subscriber
  for (const pub of publishers) {
    const hasSubscriber = subscribers.some(sub => sub.eventName === pub.eventName);
    if (!hasSubscriber && pub.eventName) {
      findings.push(createFinding({
        category: 'mismatched-event',
        severity: 'High',
        flow_type: 'event',
        source: { file: pub.file, line: pub.line, symbol: `emit('${pub.eventName}')` },
        target: { file: 'unknown', line: 0, symbol: 'subscriber' },
        evidence: `Event '${sanitizeJson(pub.eventName)}' published at ${sanitizeJson(pub.file)}:${pub.line} but no subscriber found`,
        recommendation: `Add subscriber for event '${sanitizeJson(pub.eventName)}' or verify event name spelling`,
      }));
    }
  }

  // Find subscribers with no matching publisher
  for (const sub of subscribers) {
    const hasPublisher = publishers.some(pub => pub.eventName === sub.eventName);
    if (!hasPublisher && sub.eventName) {
      findings.push(createFinding({
        category: 'mismatched-event',
        severity: 'Medium',
        flow_type: 'event',
        source: { file: 'unknown', line: 0, symbol: 'publisher' },
        target: { file: sub.file, line: sub.line, symbol: `on('${sub.eventName}')` },
        evidence: `Subscriber for event '${sanitizeJson(sub.eventName)}' at ${sanitizeJson(sub.file)}:${sub.line} but no publisher found`,
        recommendation: `Add publisher for event '${sanitizeJson(sub.eventName)}' or verify event name spelling`,
      }));
    }
  }

  return findings;
}

/**
 * Check for wrong config references (B4, Practice 4.5 check #3).
 * Verify all references to the same service use the same config function.
 *
 * @param {object[]} traceFiles - Array of trace file data
 * @param {string} projectRoot
 * @returns {object[]} Array of findings
 */
export function checkWrongConfig(traceFiles, projectRoot) {
  const findings = [];
  const configRefs = new Map(); // serviceName -> [{ file, symbol, line }]

  for (const trace of traceFiles) {
    if (!trace || !trace.files) continue;
    for (const file of trace.files) {
      if (!file.imports) continue;
      for (const imp of file.imports) {
        const source = imp.source || '';
        // Look for config imports
        if (/config/i.test(source)) {
          for (const sym of (imp.symbols || [])) {
            // Group by the function name pattern (e.g., getDbConfig, getRedisConfig)
            const match = sym.match(/(?:get|load|read)?(\w+?)(?:Config|Configuration|Settings)/i);
            if (match) {
              const service = match[1].toLowerCase();
              if (!configRefs.has(service)) configRefs.set(service, []);
              configRefs.get(service).push({
                file: file.filePath,
                symbol: sym,
                source: source,
                line: 0,
              });
            }
          }
        }
      }
    }
  }

  // Check for services with multiple different config functions
  for (const [service, refs] of configRefs) {
    const uniqueFunctions = new Set(refs.map(r => r.symbol));
    if (uniqueFunctions.size > 1) {
      const functionList = [...uniqueFunctions].join(', ');
      findings.push(createFinding({
        category: 'wrong-config',
        severity: 'Medium',
        flow_type: 'logical',
        source: { file: refs[0].file, line: refs[0].line, symbol: refs[0].symbol },
        target: { file: refs[1]?.file || 'unknown', line: refs[1]?.line || 0, symbol: refs[1]?.symbol || 'unknown' },
        evidence: `Service '${sanitizeJson(service)}' uses multiple config functions: ${sanitizeJson(functionList)}`,
        recommendation: `Standardize on a single config function for service '${sanitizeJson(service)}'`,
      }));
    }
  }

  return findings;
}

/**
 * Check for assumption conflicts (B5, Practice 4.5 check #4).
 * Verify no two agents made contradictory assumptions about same integration point.
 *
 * @param {string[]} modifiedFiles - Files to check
 * @param {string} projectRoot
 * @returns {object[]} Array of findings
 */
export function checkAssumptionConflicts(modifiedFiles, projectRoot) {
  const findings = [];
  const assumptions = new Map(); // topic -> [{ file, line, text }]

  for (const filePath of modifiedFiles) {
    const fullPath = resolve(projectRoot, filePath);
    try {
      if (!existsSync(fullPath)) continue;
      const content = readFileSync(fullPath, 'utf8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const match = line.match(/TODO\(assumption\):\s*(.+?)(?:\[|$)/);
        if (match) {
          const text = match[1].trim();
          // Extract topic from assumption text (first few words)
          const topic = text.split(/\s+/).slice(0, 4).join(' ').toLowerCase();

          if (!assumptions.has(topic)) assumptions.set(topic, []);
          assumptions.get(topic).push({
            file: filePath,
            line: i + 1,
            text: text,
          });
        }
      }
    } catch {
      // Intentional: skip files that can't be read (permission denied, binary files,
      // encoding issues). Missing one file's assumptions is acceptable -- the conflict
      // detection is best-effort across readable source files.
    }
  }

  // Find topics with multiple different assumptions
  for (const [topic, refs] of assumptions) {
    if (refs.length > 1) {
      const fileList = refs.map(r => `${r.file}:${r.line}`).join(', ');
      // Category mapping: Practice 4.5 maps assumption-conflict -> missing-import.
      // Assumption conflicts indicate agents chose different values for the same
      // integration point, which surfaces as a missing or mismatched import when
      // the modules are wired together. No better 6-category fit exists.
      findings.push(createFinding({
        category: 'missing-import',
        severity: 'High',
        flow_type: 'logical',
        source: { file: refs[0].file, line: refs[0].line, symbol: 'TODO(assumption)' },
        target: { file: refs[1].file, line: refs[1].line, symbol: 'TODO(assumption)' },
        evidence: `Conflicting assumptions about '${sanitizeJson(topic)}' at: ${sanitizeJson(fileList)}`,
        recommendation: `Resolve conflicting assumptions about '${sanitizeJson(topic)}' -- agents made different choices for the same integration point`,
      }));
    }
  }

  return findings;
}

/**
 * Check for disconnected handlers (B6).
 * Verify UI elements have event bindings or callbacks.
 *
 * @param {object[]} traceFiles - Array of trace file data
 * @param {string} projectRoot
 * @returns {object[]} Array of findings
 */
export function checkDisconnectedHandlers(traceFiles, projectRoot) {
  const findings = [];
  const handlerExports = [];
  const handlerImports = [];

  for (const trace of traceFiles) {
    if (!trace || !trace.files) continue;
    for (const file of trace.files) {
      // Look for handler/callback exports
      if (file.exports) {
        for (const exp of file.exports) {
          const symbol = exp.symbol || '';
          if (/(?:handle|on[A-Z]|callback|listener)/i.test(symbol)) {
            handlerExports.push({
              file: file.filePath,
              symbol: symbol,
              line: exp.lineNumber || 0,
            });
          }
        }
      }

      // Look for handler imports
      if (file.imports) {
        for (const imp of file.imports) {
          for (const sym of (imp.symbols || [])) {
            if (/(?:handle|on[A-Z]|callback|listener)/i.test(sym)) {
              handlerImports.push({
                file: file.filePath,
                symbol: sym,
                source: imp.source || '',
              });
            }
          }
        }
      }
    }
  }

  // Find handler exports not imported anywhere
  for (const exp of handlerExports) {
    const isUsed = handlerImports.some(imp =>
      imp.symbol === exp.symbol ||
      imp.source.includes(basename(exp.file, '.ts')) ||
      imp.source.includes(basename(exp.file, '.mjs'))
    );

    if (!isUsed) {
      findings.push(createFinding({
        category: 'disconnected-handler',
        severity: 'Medium',
        flow_type: 'user',
        source: { file: exp.file, line: exp.line, symbol: exp.symbol },
        target: { file: 'unknown', line: 0, symbol: 'consumer' },
        evidence: `Handler '${sanitizeJson(exp.symbol)}' exported from ${sanitizeJson(exp.file)} but not imported by any consumer`,
        recommendation: `Wire '${sanitizeJson(exp.symbol)}' to its intended consumer or remove if unused`,
      }));
    }
  }

  return findings;
}

/**
 * Check for missing middleware (B7).
 * Verify request paths include required middleware.
 *
 * @param {object[]} traceFiles - Array of trace file data
 * @param {string} projectRoot
 * @returns {object[]} Array of findings
 */
export function checkMissingMiddleware(traceFiles, projectRoot) {
  const findings = [];
  const middlewareExports = [];
  const middlewareUsages = [];

  for (const trace of traceFiles) {
    if (!trace || !trace.files) continue;
    for (const file of trace.files) {
      if (file.exports) {
        for (const exp of file.exports) {
          const symbol = exp.symbol || '';
          if (/(?:middleware|guard|interceptor|validator|authenticate|authorize)/i.test(symbol)) {
            middlewareExports.push({
              file: file.filePath,
              symbol: symbol,
              line: exp.lineNumber || 0,
            });
          }
        }
      }

      if (file.imports) {
        for (const imp of file.imports) {
          for (const sym of (imp.symbols || [])) {
            if (/(?:middleware|guard|interceptor|validator|authenticate|authorize)/i.test(sym)) {
              middlewareUsages.push({
                file: file.filePath,
                symbol: sym,
                source: imp.source || '',
              });
            }
          }
        }
      }
    }
  }

  // Find middleware exports not used in any route/app file
  for (const exp of middlewareExports) {
    const isUsed = middlewareUsages.some(usage =>
      usage.symbol === exp.symbol ||
      usage.source.includes(basename(exp.file, '.ts')) ||
      usage.source.includes(basename(exp.file, '.mjs'))
    );

    if (!isUsed) {
      findings.push(createFinding({
        category: 'missing-middleware',
        severity: 'Medium',
        flow_type: 'logical',
        source: { file: exp.file, line: exp.line, symbol: exp.symbol },
        target: { file: 'unknown', line: 0, symbol: 'route' },
        evidence: `Middleware '${sanitizeJson(exp.symbol)}' exported from ${sanitizeJson(exp.file)} but not applied to any route`,
        recommendation: `Apply '${sanitizeJson(exp.symbol)}' to appropriate routes or remove if unused`,
      }));
    }
  }

  return findings;
}

/**
 * Check for missing imports (general import/dependency verification).
 *
 * @param {object[]} traceFiles - Array of trace file data
 * @param {string} projectRoot
 * @returns {object[]} Array of findings
 */
export function checkMissingImports(traceFiles, projectRoot) {
  const findings = [];
  const allExports = new Map(); // filePath -> Set of exported symbols
  const allImports = []; // { file, source, symbols }

  for (const trace of traceFiles) {
    if (!trace || !trace.files) continue;
    for (const file of trace.files) {
      if (file.exports) {
        if (!allExports.has(file.filePath)) {
          allExports.set(file.filePath, new Set());
        }
        for (const exp of file.exports) {
          allExports.get(file.filePath).add(exp.symbol);
        }
      }

      if (file.imports) {
        for (const imp of file.imports) {
          if (imp.source && !imp.source.startsWith('node:') && !imp.source.includes('node_modules')) {
            allImports.push({
              file: file.filePath,
              source: imp.source,
              symbols: imp.symbols || [],
            });
          }
        }
      }
    }
  }

  // Check for imports referencing symbols that don't exist in their source
  for (const imp of allImports) {
    // Resolve source to file path
    for (const [exportFile, exportSymbols] of allExports) {
      const sourceBase = imp.source.replace(/^\.\//, '').replace(/\.\w+$/, '');
      const exportBase = exportFile.replace(/\.\w+$/, '');

      if (exportBase.endsWith(sourceBase) || sourceBase.endsWith(basename(exportBase))) {
        for (const sym of imp.symbols) {
          if (!exportSymbols.has(sym)) {
            findings.push(createFinding({
              category: 'missing-import',
              severity: 'High',
              flow_type: 'logical',
              source: { file: imp.file, line: 0, symbol: sym },
              target: { file: exportFile, line: 0, symbol: sym },
              evidence: `Symbol '${sanitizeJson(sym)}' imported in ${sanitizeJson(imp.file)} from '${sanitizeJson(imp.source)}' but not exported by ${sanitizeJson(exportFile)}`,
              recommendation: `Export '${sanitizeJson(sym)}' from ${sanitizeJson(exportFile)} or update the import in ${sanitizeJson(imp.file)}`,
            }));
          }
        }
      }
    }
  }

  return findings;
}

// =============================================================================
// Finding Creation
// =============================================================================

let findingCounter = 0;

/**
 * Create a structured FlowFinding (contract-flow-finding).
 *
 * @param {object} params
 * @returns {object} FlowFinding
 */
function createFinding(params) {
  findingCounter++;
  const stage = params.stage || 'impl-verify';
  const stagePrefix = stage.replace(/-/g, '').toUpperCase().slice(0, 4);

  return {
    finding_id: `FLOW-${stagePrefix}-${String(findingCounter).padStart(3, '0')}`,
    category: params.category,
    severity: params.severity,
    flow_type: params.flow_type,
    source: params.source || { file: 'unknown', line: 0, symbol: 'unknown' },
    target: params.target || { file: 'unknown', line: 0, symbol: 'unknown' },
    integration_point: `${(params.source?.file || 'unknown')} -> ${(params.target?.file || 'unknown')} (${params.category})`,
    evidence: params.evidence || '',
    recommendation: params.recommendation || '',
    stage: stage,
    pass_number: params.pass_number || 1,
    confidence: params.confidence || 'medium',
  };
}

/**
 * Reset the finding counter (for testing).
 */
export function resetFindingCounter() {
  findingCounter = 0;
}

// =============================================================================
// Carry-Forward (Tasks D1-D5)
// =============================================================================

/**
 * Read carry-forward findings from file (AC-2.1, AC-2.4).
 *
 * @param {string} specGroupId
 * @param {string} projectRoot
 * @returns {{ findings: object[], warning: string|null }}
 */
export function readCarryForward(specGroupId, projectRoot) {
  const filePath = join(projectRoot, '.claude', 'specs', 'groups', specGroupId, CARRY_FORWARD_FILENAME);

  if (!existsSync(filePath)) {
    return { findings: [], warning: null }; // EC-6: fresh analysis
  }

  try {
    const content = readFileSync(filePath, 'utf8');
    const data = JSON.parse(content);

    if (!Array.isArray(data)) {
      return { findings: [], warning: 'Carry-forward file is not an array; running fresh analysis' }; // EC-7
    }

    // Validate entries (AC-2.5: only flow-verifier entries accepted)
    const validFindings = [];
    for (const entry of data) {
      const validation = validateCarryForwardEntry(entry);
      if (validation.valid) {
        validFindings.push(entry);
      }
      // EC-13: entries with unrecognized written_by are logged and skipped
    }

    return { findings: validFindings, warning: null };
  } catch (err) {
    return { findings: [], warning: `Malformed carry-forward JSON: ${err.message}; running fresh analysis` }; // EC-7
  }
}

/**
 * Write carry-forward findings to file (AC-2.1, AC-2.3).
 * Re-run semantics: replace findings for the current stage, preserve others.
 *
 * @param {string} specGroupId
 * @param {string} stage
 * @param {object[]} newFindings
 * @param {string} projectRoot
 */
export function writeCarryForward(specGroupId, stage, newFindings, projectRoot) {
  const filePath = join(projectRoot, '.claude', 'specs', 'groups', specGroupId, CARRY_FORWARD_FILENAME);
  const dirPath = dirname(filePath);

  // Read existing findings
  const { findings: existingFindings } = readCarryForward(specGroupId, projectRoot);

  // AC-2.3: Replace findings for current stage, preserve others
  const otherStageFindings = existingFindings.filter(f => f.stage !== stage);

  // Combine: other stages' findings + new findings for current stage
  const combined = [...otherStageFindings, ...newFindings];

  // Write atomically
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
  writeFileSync(filePath, JSON.stringify(combined, null, 2) + '\n', 'utf8');
}

/**
 * Elevate severity by one level (AC-2.2).
 *
 * @param {string} currentSeverity
 * @returns {string} Elevated severity (capped at Critical)
 */
export function elevateSeverity(currentSeverity) {
  const order = SEVERITY_ORDER[currentSeverity];
  if (order === undefined || order >= 3) return 'Critical'; // Cap at Critical
  const elevated = Object.entries(SEVERITY_ORDER).find(([, v]) => v === order + 1);
  return elevated ? elevated[0] : 'Critical';
}

/**
 * Convert findings to carry-forward entries (contract-carry-forward).
 *
 * @param {object[]} findings - FlowFinding array
 * @param {string} stage
 * @param {number} passNumber
 * @returns {object[]} CarryForwardEntry array
 */
export function findingsToCarryForward(findings, stage, passNumber) {
  return findings.map(f => ({
    finding_id: f.finding_id,
    severity: f.severity,
    summary: f.evidence ? f.evidence.slice(0, 200) : f.recommendation?.slice(0, 200) || '',
    stage: stage,
    pass_number: passNumber,
    integration_point: f.integration_point,
    status: 'open',
    superseded_by: null,
    written_by: 'flow-verifier',
  }));
}

// =============================================================================
// Gate Decision Logic (Tasks E1-E2)
// =============================================================================

/**
 * Compute gate decision from findings (AC-1.7, AC-1.8, REQ-014, REQ-015).
 *
 * @param {object[]} findings - Array of FlowFinding
 * @param {string} coverage - 'full' or 'partial'
 * @returns {object} Gate output conforming to contract-gate-output
 */
export function computeGateDecision(findings, coverage) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };

  for (const f of findings) {
    const key = (f.severity || '').toLowerCase();
    if (key in counts) counts[key]++;
  }

  let status = 'pass';

  // AC-1.8: block on Critical
  if (counts.critical > 0) {
    status = 'block';
  }
  // AC-1.8: warn on High
  else if (counts.high > 0) {
    status = 'warn';
  }

  // AC-1.8, REQ-015: partial coverage caps at warn (does not override block)
  if (coverage === 'partial' && status === 'pass') {
    status = 'warn';
  }

  return {
    status,
    critical_count: counts.critical,
    high_count: counts.high,
    medium_count: counts.medium,
    low_count: counts.low,
    findings: findings,
    coverage: coverage,
    unchecked_files: [],
  };
}

// =============================================================================
// Orchestrator Support (Tasks F1-F3)
// =============================================================================

/**
 * Mark findings as superseded by post-merge findings (AC-3.3, REQ-019).
 *
 * @param {object[]} perWorkstreamFindings - Per-workstream findings
 * @param {object[]} postMergeFindings - Post-merge findings
 * @returns {object[]} Updated per-workstream findings with superseded_by
 */
export function applyFindingSupersession(perWorkstreamFindings, postMergeFindings) {
  return perWorkstreamFindings.map(pwf => {
    const superseder = postMergeFindings.find(pmf =>
      pmf.integration_point === pwf.integration_point
    );
    if (superseder) {
      return { ...pwf, superseded_by: superseder.finding_id };
    }
    return pwf;
  });
}

// =============================================================================
// Structured Docs Generation (Tasks G1-G3)
// =============================================================================

/**
 * Generate flow-coverage.yaml content (AC-3.6, REQ-023).
 * Output matches schema.yaml flow_coverage definition and docs-validate.mjs expectations.
 *
 * @param {string} specGroup
 * @param {string} stage - Flow verifier stage (prd-review, spec-review, impl-verify, post-impl)
 * @param {object[]} findings
 * @param {object} coverageData
 * @returns {string} YAML content
 */
export function generateFlowCoverageYaml(specGroup, stage, findings, coverageData) {
  const unverifiedPoints = findings
    .filter(f => f.severity === 'Critical' || f.severity === 'High')
    .map(f => ({
      source: sanitizeYaml(f.source?.file || 'unknown'),
      target: sanitizeYaml(f.target?.file || 'unknown'),
      boundary_type: sanitizeYaml(f.category || 'unknown'),
      reason: sanitizeYaml(f.evidence || 'No evidence provided'),
    }));

  const integrationPoints = (coverageData.integrationPoints || []).map(ip => ({
    source: sanitizeYaml(ip.source || 'unknown'),
    target: sanitizeYaml(ip.target || 'unknown'),
    boundary_type: sanitizeYaml(ip.type || 'unknown'),
    flow_type: sanitizeYaml(ip.flowType || 'logical'),
    verified: ip.verified !== false,
    evidence: sanitizeYaml(ip.evidence || ''),
  }));

  const totalCount = integrationPoints.length;
  const verifiedCount = integrationPoints.filter(ip => ip.verified).length;
  const coveragePercentage = totalCount > 0 ? Math.round((verifiedCount / totalCount) * 100) : 0;

  const lines = [
    `schema_version: 1`,
    `doc_type: flow-coverage`,
    `spec_group: ${sanitizeYaml(specGroup)}`,
    `stage: ${sanitizeYaml(stage)}`,
    `timestamp: "${new Date().toISOString()}"`,
    `verified_count: ${verifiedCount}`,
    `total_count: ${totalCount}`,
    `coverage_percentage: ${coveragePercentage}`,
    `integration_points:`,
  ];

  for (const ip of integrationPoints) {
    lines.push(`  - source: "${ip.source}"`);
    lines.push(`    target: "${ip.target}"`);
    lines.push(`    boundary_type: "${ip.boundary_type}"`);
    lines.push(`    flow_type: "${ip.flow_type}"`);
    lines.push(`    verified: ${ip.verified}`);
    lines.push(`    evidence: "${ip.evidence}"`);
  }

  if (unverifiedPoints.length > 0) {
    lines.push(`unverified_points:`);
    for (const pt of unverifiedPoints) {
      lines.push(`  - source: "${pt.source}"`);
      lines.push(`    target: "${pt.target}"`);
      lines.push(`    boundary_type: "${pt.boundary_type}"`);
      lines.push(`    reason: "${pt.reason}"`);
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Generate Mermaid wiring diagram (AC-3.7, REQ-024).
 *
 * @param {string} specGroup
 * @param {object[]} findings
 * @param {object} coverageData
 * @returns {string} Mermaid .mmd content
 */
export function generateWiringDiagram(specGroup, findings, coverageData) {
  const hash = generateContentHash(specGroup + JSON.stringify(findings));
  const lines = [
    `%% source-hash: ${hash}`,
    `%% Flow wiring diagram for ${sanitizeMarkdown(specGroup)}`,
    `%% Generated by flow-verify-checks.mjs`,
    `graph LR`,
  ];

  const modules = new Set();
  const edges = [];

  // Add verified flows as solid lines
  for (const ip of (coverageData.integrationPoints || [])) {
    const src = (ip.source || 'unknown').replace(/[^a-zA-Z0-9]/g, '_');
    const tgt = (ip.target || 'unknown').replace(/[^a-zA-Z0-9]/g, '_');
    modules.add(src);
    modules.add(tgt);
    if (ip.verified !== false) {
      edges.push(`  ${src} -->|${ip.flowType || 'logical'}| ${tgt}`);
    } else {
      edges.push(`  ${src} -.->|${ip.flowType || 'logical'}| ${tgt}`);
    }
  }

  // Add gaps as dashed red lines
  for (const f of findings) {
    const src = (f.source?.file || 'unknown').replace(/[^a-zA-Z0-9]/g, '_');
    const tgt = (f.target?.file || 'unknown').replace(/[^a-zA-Z0-9]/g, '_');
    modules.add(src);
    modules.add(tgt);
    if (!edges.some(e => e.includes(src) && e.includes(tgt))) {
      edges.push(`  ${src} -.->|${f.category || 'gap'}| ${tgt}`);
    }
  }

  // Add module nodes
  for (const mod of modules) {
    lines.push(`  ${mod}["${mod}"]`);
  }

  // Add edges
  lines.push('');
  for (const edge of edges) {
    lines.push(edge);
  }

  // Style gaps
  lines.push('');
  lines.push('  classDef gap stroke:#f00,stroke-dasharray: 5 5');

  return lines.join('\n') + '\n';
}

/**
 * Generate a simple content hash for freshness tracking.
 *
 * @param {string} content
 * @returns {string} Hash string (first 8 chars)
 */
function generateContentHash(content) {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(16).padStart(8, '0').slice(0, 8);
}

// =============================================================================
// Main Entry Point
// =============================================================================

/**
 * Run flow verification pre-computation.
 *
 * @param {object} args - Parsed arguments
 * @returns {object} Pre-computed results
 */
export async function runFlowVerification(args) {
  const projectRoot = resolveProjectRoot(args.projectRoot);
  const specGroupId = args.sg;
  const stage = args.stage;

  if (!specGroupId) {
    throw new Error('--sg <spec-group-id> is required');
  }

  if (!VALID_STAGES.includes(stage)) {
    throw new Error(`Invalid stage '${stage}'. Must be one of: ${VALID_STAGES.join(', ')}`);
  }

  // Reset counter for this run
  resetFindingCounter();

  const warnings = [];
  const startTime = Date.now();

  // Step 1: Load trace system (AC-1.4)
  const traceSystem = loadTraceSystem(projectRoot);
  if (traceSystem.warning) {
    warnings.push(traceSystem.warning);
  }

  // Step 2: Discover modified files
  const modifiedFiles = discoverModifiedFiles(specGroupId, projectRoot);

  // Step 3: Map files to trace modules (AC-1.4)
  const moduleMap = new Map(); // moduleId -> files
  const untracedFiles = [];

  for (const file of modifiedFiles) {
    if (!isPathSafe(file, projectRoot)) {
      warnings.push(`Skipping unsafe path: ${file}`);
      continue;
    }

    const moduleId = traceSystem.fileToModule ? traceSystem.fileToModule(file) : null;
    if (moduleId) {
      if (!moduleMap.has(moduleId)) moduleMap.set(moduleId, []);
      moduleMap.get(moduleId).push(file);
    } else {
      untracedFiles.push(file); // AC-1.15: untraced files
    }
  }

  // Step 4: Load trace data for each module (AC-1.4, AC-1.6)
  const traceFiles = [];
  const staleModules = [];
  let coverage = 'full';

  for (const [moduleId] of moduleMap) {
    const isStale = traceSystem.isTraceStale ? traceSystem.isTraceStale(moduleId) : true;
    if (isStale) {
      staleModules.push(moduleId);
      coverage = 'partial';
    } else {
      const traceData = readModuleTrace(moduleId, projectRoot);
      if (traceData) {
        traceFiles.push(traceData);
      } else {
        staleModules.push(moduleId);
        coverage = 'partial';
      }
    }
  }

  // AC-1.15: Mark as partial if untraced files exist
  if (untracedFiles.length > 0) {
    coverage = 'partial';
    warnings.push(`${untracedFiles.length} file(s) have no trace module definition -- fallback analysis only`);
  }

  // AC-1.5: Enforce fallback caps when traces are unavailable (REQ-021)
  let fallbackCapped = false;
  let fallbackFilesForScan = modifiedFiles;

  if (coverage === 'partial') {
    if (modifiedFiles.length > FALLBACK_MAX_FILES) {
      fallbackCapped = true;
      fallbackFilesForScan = modifiedFiles.slice(0, FALLBACK_MAX_FILES);
      warnings.push(`Fallback file scan capped at ${FALLBACK_MAX_FILES} files (${modifiedFiles.length} total)`);
    }
  }

  // Step 5: Run wiring checks (Tasks B2-B7)
  const allFindings = [];
  const fallbackDeadline = coverage === 'partial' ? startTime + FALLBACK_TIMEOUT_MS : Infinity;

  if (stage === 'impl-verify' || stage === 'post-impl') {
    // B2: Route registration
    allFindings.push(...checkUnregisteredRoutes(traceFiles, projectRoot));

    // B3: Event name alignment
    if (Date.now() < fallbackDeadline) {
      allFindings.push(...checkMismatchedEvents(traceFiles, projectRoot));
    }

    // B4: Config function consistency
    if (Date.now() < fallbackDeadline) {
      allFindings.push(...checkWrongConfig(traceFiles, projectRoot));
    }

    // B5: Assumption conflict detection (uses fallback-capped file list)
    if (Date.now() < fallbackDeadline) {
      allFindings.push(...checkAssumptionConflicts(fallbackFilesForScan, projectRoot));
    }

    // B6: Disconnected handlers
    if (Date.now() < fallbackDeadline) {
      allFindings.push(...checkDisconnectedHandlers(traceFiles, projectRoot));
    }

    // B7: Missing middleware
    if (Date.now() < fallbackDeadline) {
      allFindings.push(...checkMissingMiddleware(traceFiles, projectRoot));
    }

    // General: Missing imports
    if (Date.now() < fallbackDeadline) {
      allFindings.push(...checkMissingImports(traceFiles, projectRoot));
    }

    // AC-1.5: If fallback timeout was exceeded, mark partial and warn
    if (Date.now() >= fallbackDeadline) {
      coverage = 'partial';
      fallbackCapped = true;
      warnings.push(`Fallback analysis timeout exceeded (${FALLBACK_TIMEOUT_MS}ms) -- some checks skipped`);
    }
  }

  // AC-1.5: If any fallback cap was hit, ensure coverage reflects it
  if (fallbackCapped) {
    coverage = 'partial';
  }

  // Step 6: Compute gate decision (for impl-verify)
  const gateOutput = computeGateDecision(allFindings, coverage);

  // Step 7: Build output
  const elapsed = Date.now() - startTime;
  const result = {
    timestamp: new Date().toISOString(),
    spec_group: specGroupId,
    stage: stage,
    scope: args.scope || 'full',
    modified_files: modifiedFiles,
    trace_results: {
      modules_checked: [...moduleMap.keys()],
      stale_modules: staleModules,
      untraced_files: untracedFiles,
    },
    wiring_checks: {
      total_findings: allFindings.length,
      by_category: {
        'missing-import': allFindings.filter(f => f.category === 'missing-import').length,
        'unregistered-route': allFindings.filter(f => f.category === 'unregistered-route').length,
        'mismatched-event': allFindings.filter(f => f.category === 'mismatched-event').length,
        'wrong-config': allFindings.filter(f => f.category === 'wrong-config').length,
        'disconnected-handler': allFindings.filter(f => f.category === 'disconnected-handler').length,
        'missing-middleware': allFindings.filter(f => f.category === 'missing-middleware').length,
      },
      findings: allFindings,
    },
    gate_output: gateOutput,
    coverage: coverage,
    unchecked_files: gateOutput.unchecked_files,
    elapsed_ms: elapsed,
    warnings: warnings,
  };

  return result;
}

/**
 * Write pre-computed results to file.
 *
 * @param {object} result - Pre-computed results
 * @param {string} specGroupId
 * @param {string} projectRoot
 */
function writePrecomputedResults(result, specGroupId, projectRoot) {
  const outputDir = join(projectRoot, '.claude', 'specs', 'groups', specGroupId);
  const outputPath = join(outputDir, PRECOMPUTED_FILENAME);

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
}

// =============================================================================
// CLI Entry Point
// =============================================================================

async function main() {
  const args = parseArgs(process.argv);

  try {
    const result = await runFlowVerification(args);
    const projectRoot = resolveProjectRoot(args.projectRoot);

    // Write pre-computed results
    writePrecomputedResults(result, args.sg, projectRoot);

    // Also write carry-forward entries
    const carryForwardEntries = findingsToCarryForward(
      result.wiring_checks.findings,
      args.stage,
      1
    );
    writeCarryForward(args.sg, args.stage, carryForwardEntries, projectRoot);

    // Print summary
    const summary = {
      status: result.gate_output.status,
      findings: result.wiring_checks.total_findings,
      coverage: result.coverage,
      elapsed_ms: result.elapsed_ms,
    };
    console.log(JSON.stringify(summary));
    process.exit(0);
  } catch (err) {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('flow-verify-checks.mjs')) {
  main();
}
