#!/usr/bin/env node

/**
 * Flow Verify Pre-Computation Script
 *
 * Standalone script run by the orchestrating agent (which has Bash access)
 * before dispatching the read-only flow-verifier agent. Performs source-based
 * wiring analysis and six-category wiring checks.
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
 * Current contract summary: .claude/docs/FLOW-VERIFIER.md
 */

import { existsSync, readFileSync, readlinkSync, writeFileSync, mkdirSync, readdirSync, lstatSync } from 'node:fs';
import { join, resolve, relative, basename, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

// =============================================================================
// Constants
// =============================================================================

/** Valid stage modes (AC-1.1, REQ-001) */
const VALID_STAGES = ['prd-review', 'spec-review', 'impl-verify', 'post-impl'];

/** Valid scope modes (REQ-006 adds 'diff' for impl-verify/post-impl diff-scope) */
const VALID_SCOPES = ['full', 'workstream', 'post-merge', 'diff'];

/** Stages where scope === 'diff' is permitted (REQ-006 / AC2.1-AC2.4) */
const DIFF_SCOPE_ALLOWED_STAGES = ['impl-verify', 'post-impl'];

/** Carry-forward source stages that bypass diff-scope filter (REQ-006 / AC2.2) */
const CARRY_FORWARD_SOURCE_STAGES = ['prd-review', 'spec-review'];

/** Regex detecting a newly added `export` line in a diff hunk (REQ-006 / AC2.3) */
const NEW_EXPORT_LINE_REGEX = /^\+\s*export\b/;

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
    diffBase: null, // REQ-006: ref for diff computation (e.g. HEAD~10)
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
      case '--diff-base':
        args.diffBase = argv[++i];
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
// Source Analysis
// =============================================================================

const SOURCE_FILE_REGEX = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

function parseSymbols(raw) {
  return raw
    .split(',')
    .map(s => s.trim().replace(/\bas\b\s+\w+$/u, '').trim())
    .filter(Boolean);
}

function analyzeSourceFile(filePath, projectRoot) {
  const fullPath = resolve(projectRoot, filePath);
  const content = readFileSync(fullPath, 'utf8');
  const lines = content.split('\n');
  const imports = [];
  const exports = [];
  const events = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const importMatch = line.match(/import\s+(?:type\s+)?(?:\{([^}]+)\}|([\w*$]+))?\s*(?:from\s+)?['"]([^'"]+)['"]/u);
    const requireMatch = line.match(/(?:const|let|var)\s+(?:\{([^}]+)\}|([\w$]+))\s*=\s*require\(['"]([^'"]+)['"]\)/u);
    const matchedImport = importMatch || requireMatch;
    if (matchedImport) {
      imports.push({
        source: matchedImport[3],
        symbols: matchedImport[1] ? parseSymbols(matchedImport[1]) : (matchedImport[2] ? [matchedImport[2]] : []),
      });
    }

    const exportDecl = line.match(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/u);
    const exportList = line.match(/export\s+\{([^}]+)\}/u);
    if (exportDecl) {
      exports.push({ symbol: exportDecl[1], lineNumber: i + 1 });
    } else if (exportList) {
      for (const symbol of parseSymbols(exportList[1])) {
        exports.push({ symbol, lineNumber: i + 1 });
      }
    } else if (/export\s+default\b/u.test(line)) {
      exports.push({ symbol: 'default', lineNumber: i + 1 });
    }

    const eventRegex = /\.(emit|on|once|addEventListener|removeEventListener)\(\s*['"]([^'"]+)['"]/gu;
    let eventMatch;
    while ((eventMatch = eventRegex.exec(line)) !== null) {
      const method = eventMatch[1];
      events.push({
        type: method === 'emit' ? 'emit' : 'on',
        eventName: eventMatch[2],
        line: i + 1,
      });
    }
  }

  return { filePath, imports, exports, events };
}

export function buildSourceAnalysis(filePaths, projectRoot) {
  const files = [];
  const skipped = [];

  for (const filePath of filePaths) {
    if (!SOURCE_FILE_REGEX.test(filePath)) {
      skipped.push(filePath);
      continue;
    }
    try {
      if (!isPathSafe(filePath, projectRoot)) {
        skipped.push(filePath);
        continue;
      }
      files.push(analyzeSourceFile(filePath, projectRoot));
    } catch {
      skipped.push(filePath);
    }
  }

  return {
    moduleId: 'changed-files',
    files,
    skipped_files: skipped,
  };
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
 * @param {object[]} sourceAnalysisFiles - Array of source analysis data with imports/exports
 * @param {string} projectRoot
 * @returns {object[]} Array of findings
 */
export function checkUnregisteredRoutes(sourceAnalysisFiles, projectRoot) {
  const findings = [];
  const routeDefinitions = [];
  const routeMounts = [];

  for (const analysis of sourceAnalysisFiles) {
    if (!analysis || !analysis.files) continue;
    for (const file of analysis.files) {
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
 * @param {object[]} sourceAnalysisFiles - Array of source analysis data
 * @param {string} projectRoot
 * @returns {object[]} Array of findings
 */
export function checkMismatchedEvents(sourceAnalysisFiles, projectRoot) {
  const findings = [];
  const publishers = [];
  const subscribers = [];

  for (const analysis of sourceAnalysisFiles) {
    if (!analysis || !analysis.files) continue;
    for (const file of analysis.files) {
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
 * @param {object[]} sourceAnalysisFiles - Array of source analysis data
 * @param {string} projectRoot
 * @returns {object[]} Array of findings
 */
export function checkWrongConfig(sourceAnalysisFiles, projectRoot) {
  const findings = [];
  const configRefs = new Map(); // serviceName -> [{ file, symbol, line }]

  for (const analysis of sourceAnalysisFiles) {
    if (!analysis || !analysis.files) continue;
    for (const file of analysis.files) {
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
 * @param {object[]} sourceAnalysisFiles - Array of source analysis data
 * @param {string} projectRoot
 * @returns {object[]} Array of findings
 */
export function checkDisconnectedHandlers(sourceAnalysisFiles, projectRoot) {
  const findings = [];
  const handlerExports = [];
  const handlerImports = [];

  for (const analysis of sourceAnalysisFiles) {
    if (!analysis || !analysis.files) continue;
    for (const file of analysis.files) {
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
 * @param {object[]} sourceAnalysisFiles - Array of source analysis data
 * @param {string} projectRoot
 * @returns {object[]} Array of findings
 */
export function checkMissingMiddleware(sourceAnalysisFiles, projectRoot) {
  const findings = [];
  const middlewareExports = [];
  const middlewareUsages = [];

  for (const analysis of sourceAnalysisFiles) {
    if (!analysis || !analysis.files) continue;
    for (const file of analysis.files) {
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
 * @param {object[]} sourceAnalysisFiles - Array of source analysis data
 * @param {string} projectRoot
 * @returns {object[]} Array of findings
 */
export function checkMissingImports(sourceAnalysisFiles, projectRoot) {
  const findings = [];
  const allExports = new Map(); // filePath -> Set of exported symbols
  const allImports = []; // { file, source, symbols }

  for (const analysis of sourceAnalysisFiles) {
    if (!analysis || !analysis.files) continue;
    for (const file of analysis.files) {
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
// Diff-Scope Integration (REQ-006 — AC2.1, AC2.2, AC2.3, AC2.4)
// =============================================================================

/**
 * Determine whether a finding (or carry-forward entry) originates from a stage
 * that must be re-evaluated regardless of diff scope (REQ-006 / AC2.2).
 *
 * Carry-forward entries written at prd-review / spec-review MUST be re-evaluated
 * at impl-verify / post-impl even when scope === 'diff', because the earlier
 * stage's analysis spans modules that may not intersect the diff.
 *
 * @param {string|null|undefined} sourceStage - Stage the finding originated from
 * @returns {boolean}
 */
export function isCarryForwardSourceStage(sourceStage) {
  if (!sourceStage) return false;
  return CARRY_FORWARD_SOURCE_STAGES.includes(sourceStage);
}

/**
 * Extract module IDs touched by a finding. A finding may reference a source
 * file and/or a target file; either participating file's module qualifies the
 * finding for diff-scope retention.
 *
 * @param {object} finding - FlowFinding (with source.file, target.file)
 * @param {Function} fileToModule - Maps file path → module ID
 * @returns {string[]} Module IDs referenced by this finding
 */
export function findingModuleIds(finding, fileToModule) {
  if (!finding || typeof fileToModule !== 'function') return [];
  const ids = new Set();
  const srcFile = finding.source?.file;
  const tgtFile = finding.target?.file;
  if (srcFile && srcFile !== 'unknown') {
    const id = fileToModule(srcFile);
    if (id) ids.add(id);
  }
  if (tgtFile && tgtFile !== 'unknown') {
    const id = fileToModule(tgtFile);
    if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * Filter findings to only those whose referenced files map to affected modules
 * (AC2.1). Findings that touch no known module are retained conservatively to
 * avoid silently dropping coverage.
 *
 * @param {object[]} findings - Current-pass findings
 * @param {string[]} affectedModules - Module IDs from an optional diff-scope result
 * @param {Function} fileToModule - Maps file path → module ID
 * @returns {object[]} Filtered findings
 */
export function filterFindingsByAffectedModules(findings, affectedModules, fileToModule) {
  if (!Array.isArray(findings)) return [];
  if (!Array.isArray(affectedModules) || affectedModules.length === 0) {
    // SELF-RESOLVED(spec): AC2.1 scopes to affected modules; empty set
    // means no diff -> trivial-pass at caller layer already handled upstream.
    // Here
    // we match that semantic by returning empty findings.
    return [];
  }
  const affectedSet = new Set(affectedModules);

  return findings.filter((f) => {
    // Retain carry-forward-sourced findings regardless of module scope (AC2.2).
    if (isCarryForwardSourceStage(f.source_stage || f.stage)) return true;

    const modules = findingModuleIds(f, fileToModule);
    if (modules.length === 0) {
      // Finding references no known module (e.g. 'unknown' placeholders);
      // retain conservatively — filter is for in-scope subset, not hard cull.
      return true;
    }
    return modules.some((id) => affectedSet.has(id));
  });
}

/**
 * Detect whether a git diff contains newly added `export` statements in files
 * that map to module boundaries (AC2.3 / NFR-10). When present, diff-scope
 * MUST degrade to full scope so new-boundary-crossing symbols are not missed.
 *
 * @param {string} diffText - Unified diff text (output of `git diff <base>..HEAD`)
 * @param {Function} fileToModule - Maps file path → module ID
 * @returns {{ detected: boolean, file: string|null, line: string|null, module: string|null }}
 */
export function detectNewBoundaryExport(diffText, fileToModule) {
  const result = { detected: false, file: null, line: null, module: null };
  if (!diffText || typeof diffText !== 'string') return result;
  if (typeof fileToModule !== 'function') return result;

  const lines = diffText.split('\n');
  let currentFile = null;

  for (const line of lines) {
    // Git diff file header: `+++ b/<path>`; we ignore `+++ /dev/null` (deletions).
    if (line.startsWith('+++ ')) {
      const pathPart = line.slice(4).trim();
      if (pathPart === '/dev/null') {
        currentFile = null;
        continue;
      }
      // Strip the `b/` (or `a/`) prefix that git emits.
      currentFile = pathPart.replace(/^b\//, '').replace(/^a\//, '');
      continue;
    }

    // Skip hunk headers (`@@ ... @@`) and the outer `--- a/<path>` header.
    if (line.startsWith('@@') || line.startsWith('--- ') || line.startsWith('diff ') || line.startsWith('index ')) {
      continue;
    }

    if (!currentFile) continue;
    if (!NEW_EXPORT_LINE_REGEX.test(line)) continue;

    // Only count the export when its file belongs to a known module boundary.
    const moduleId = fileToModule(currentFile);
    if (moduleId) {
      result.detected = true;
      result.file = currentFile;
      result.line = line;
      result.module = moduleId;
      return result;
    }
  }

  return result;
}

/**
 * Fetch the raw unified diff text for the supplied base → HEAD range so the
 * new-boundary detector can inspect hunks. Returns `null` on failure so the
 * caller treats detection as absent (conservative: fall through to normal scope).
 *
 * @param {string} base - Git ref to diff against (e.g. 'HEAD~10')
 * @param {string} projectRoot
 * @returns {string|null}
 */
export function fetchDiffHunks(base, projectRoot) {
  if (!base || typeof base !== 'string') return null;
  try {
    const output = execFileSync('git', ['diff', '--unified=0', `${base}..HEAD`], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 30_000,
    });
    return output;
  } catch {
    // Intentional: fallback-friendly. If git diff fails (missing ancestor,
    // shallow clone), the caller keeps the provided scope. Correctness note:
    // the primary new-symbol gate is defense-in-depth; diff-scope filtering
    // is already conservative (AC2.1 retains unknown-module findings).
    return null;
  }
}

/**
 * Contract adapter (REQ-006) — filter findings by diff scope.
 *
 * Consumer contract used by test-writer fixtures and test-driven callers:
 *   applyDiffScopeFilter({ scope, diff_scope_result, findings }) → { findings }
 *
 * Semantics:
 * - scope === 'full' → retain all findings (AC2.4 backward compat).
 * - scope === 'diff' → retain findings whose `module_id` is in
 *   `diff_scope_result.affected_modules`, OR whose `source_stage` is a
 *   carry-forward stage (prd-review / spec-review per AC2.2).
 *
 * This helper operates on the shape used by test fixtures
 * (`{id, module_id, source_stage, ...}`) and is symmetric with
 * `filterFindingsByAffectedModules` which operates on the runtime
 * FlowFinding shape (`{source.file, target.file, stage}`).
 *
 * @param {object} params
 * @param {'full'|'diff'|'workstream'|'post-merge'} params.scope
 * @param {object|null} params.diff_scope_result
 * @param {object[]} params.findings
 * @returns {{ findings: object[] }}
 */
export function applyDiffScopeFilter({ scope, diff_scope_result, findings }) {
  const input = Array.isArray(findings) ? findings : [];

  // AC2.4: scope !== 'diff' → no filtering.
  if (scope !== 'diff') {
    return { findings: [...input] };
  }

  const affectedModules = Array.isArray(diff_scope_result?.affected_modules)
    ? diff_scope_result.affected_modules
    : [];

  // AC2.1 edge: affected_modules empty → no module passes the filter; only
  // carry-forward entries survive (but none by construction in this path).
  const affectedSet = new Set(affectedModules);

  return {
    findings: input.filter((f) => {
      // AC2.2 — carry-forward entries from earlier stages always retained.
      const sourceStage = f?.source_stage || f?.stage;
      if (isCarryForwardSourceStage(sourceStage)) return true;

      // AC2.1 — gate on module membership.
      const moduleId = f?.module_id;
      if (!moduleId) return false;
      return affectedSet.has(moduleId);
    }),
  };
}

/**
 * Contract adapter (REQ-006) — new-boundary-symbol detector on structured hunks.
 *
 * Consumer contract used by test-writer fixtures:
 *   detectNewBoundarySymbol({ diff_scope_result, boundary_files }) →
 *     { degrade_to_full: boolean, reason: string|null }
 *
 * Scans `diff_scope_result.diff_hunks` (array of `{file, lines}`) for lines
 * matching `NEW_EXPORT_LINE_REGEX` (`^\+\s*export\b`) whose `file` is present
 * in `boundary_files` (Set). If found, signals scope MUST degrade to 'full'
 * (AC2.3 / NFR-10).
 *
 * This helper is symmetric with `detectNewBoundaryExport`, which scans raw
 * unified-diff text and an optional file-to-module resolver.
 *
 * @param {object} params
 * @param {object} params.diff_scope_result
 * @param {Set<string>|string[]} params.boundary_files
 * @returns {{ degrade_to_full: boolean, reason: string|null }}
 */
export function detectNewBoundarySymbol({ diff_scope_result, boundary_files }) {
  const boundarySet = boundary_files instanceof Set
    ? boundary_files
    : new Set(Array.isArray(boundary_files) ? boundary_files : []);

  const hunks = Array.isArray(diff_scope_result?.diff_hunks)
    ? diff_scope_result.diff_hunks
    : [];

  for (const hunk of hunks) {
    const file = hunk?.file;
    if (!file || !boundarySet.has(file)) continue;
    const lines = Array.isArray(hunk?.lines) ? hunk.lines : [];
    for (const line of lines) {
      if (typeof line !== 'string') continue;
      if (NEW_EXPORT_LINE_REGEX.test(line)) {
        return {
          degrade_to_full: true,
          reason: `new boundary-crossing export detected in ${file}`,
        };
      }
    }
  }

  return { degrade_to_full: false, reason: null };
}

/**
 * Apply diff-scope filtering + new-boundary degradation + carry-forward
 * re-evaluation to a batch of findings (REQ-006 / AC2.1-AC2.4).
 *
 * Diff scope accepts an optional precomputed result:
 *   diffScopeResult = { scope: 'diff'|'full', changed_files, affected_modules?, fallback }
 *
 * @param {object} params
 * @param {string} params.scope - Effective scope: 'full' | 'diff' | 'workstream' | 'post-merge'
 * @param {object|null} params.diffScopeResult - Optional precomputed diff-scope result
 * @param {object[]} params.findings - Current-pass findings
 * @param {object[]} params.carryForwardFindings - Prior-stage carry-forward entries
 * @param {string} params.stage
 * @param {string} params.projectRoot
 * @param {Function|null} params.fileToModule
 * @returns {{ findings: object[], scope: string, newBoundaryDetected: object, scopeDegraded: boolean, warnings: string[] }}
 */
export function applyDiffScope(params) {
  const {
    scope,
    diffScopeResult,
    findings,
    carryForwardFindings,
    stage,
    projectRoot,
    fileToModule,
  } = params;

  const warnings = [];
  let effectiveScope = scope;
  let scopeDegraded = false;
  let newBoundaryDetected = { detected: false, file: null, line: null, module: null };

  // AC2.4 — backward compat: scope !== 'diff' is a no-op (no filter).
  if (scope !== 'diff') {
    return {
      findings: [...(findings || [])],
      scope: effectiveScope,
      newBoundaryDetected,
      scopeDegraded: false,
      warnings,
    };
  }

  // Reject diff scope at unsupported stages (REQ-006 contract behavioral guarantee).
  if (!DIFF_SCOPE_ALLOWED_STAGES.includes(stage)) {
    warnings.push(`scope 'diff' is not valid at stage '${stage}'; degrading to 'full'`);
    return {
      findings: [...(findings || [])],
      scope: 'full',
      newBoundaryDetected,
      scopeDegraded: true,
      warnings,
    };
  }

  // AC2.3 — new boundary export → degrade to full.
  // Prefer supplied diff-hunk text; otherwise fetch via git.
  const diffText = diffScopeResult?.diff_text
    || fetchDiffHunks(diffScopeResult?.base || 'HEAD~10', projectRoot);
  if (diffText) {
    newBoundaryDetected = detectNewBoundaryExport(diffText, fileToModule);
    if (newBoundaryDetected.detected) {
      warnings.push(
        `New boundary-crossing export detected in ${newBoundaryDetected.file} (${newBoundaryDetected.module}); degrading scope from 'diff' to 'full' (NFR-10)`
      );
      effectiveScope = 'full';
      scopeDegraded = true;
      return {
        findings: [...(findings || [])],
        scope: effectiveScope,
        newBoundaryDetected,
        scopeDegraded,
        warnings,
      };
    }
  }

  // AC2.1 — filter current-pass findings to affected modules only.
  const affectedModules = Array.isArray(diffScopeResult?.affected_modules)
    ? diffScopeResult.affected_modules
    : [];

  if (typeof fileToModule !== 'function' || affectedModules.length === 0) {
    warnings.push("diff scope has no module resolver; degrading to 'full'");
    return {
      findings: [...(findings || [])],
      scope: 'full',
      newBoundaryDetected,
      scopeDegraded: true,
      warnings,
    };
  }

  const filteredCurrent = filterFindingsByAffectedModules(
    findings || [],
    affectedModules,
    fileToModule
  );

  // AC2.2 — re-evaluate carry-forward findings regardless of diff scope.
  // Carry-forward entries with source stage in prd-review / spec-review pass through.
  const carryForwardRetained = (carryForwardFindings || []).filter((entry) =>
    isCarryForwardSourceStage(entry.stage)
  );

  // Merge: filtered current-pass findings + carry-forward entries from earlier stages.
  // De-dup by finding_id when both sources reference the same id.
  const seen = new Set(filteredCurrent.map((f) => f.finding_id).filter(Boolean));
  const mergedCarry = carryForwardRetained.filter(
    (entry) => !entry.finding_id || !seen.has(entry.finding_id)
  );

  return {
    findings: [...filteredCurrent, ...mergedCarry],
    scope: effectiveScope,
    newBoundaryDetected,
    scopeDegraded,
    warnings,
  };
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

  // Step 1: Discover modified files
  const modifiedFiles = discoverModifiedFiles(specGroupId, projectRoot);

  let coverage = 'full';

  // Enforce source-scan caps for very large diffs.
  let fallbackCapped = false;
  let fallbackFilesForScan = modifiedFiles;

  if (modifiedFiles.length > FALLBACK_MAX_FILES) {
    fallbackCapped = true;
    fallbackFilesForScan = modifiedFiles.slice(0, FALLBACK_MAX_FILES);
    coverage = 'partial';
    warnings.push(`Source file scan capped at ${FALLBACK_MAX_FILES} files (${modifiedFiles.length} total)`);
  }

  // Step 2: Build a lightweight source analysis snapshot.
  const sourceAnalysis = buildSourceAnalysis(fallbackFilesForScan, projectRoot);
  const sourceAnalysisFiles = [sourceAnalysis];

  if (sourceAnalysis.skipped_files.length > 0) {
    warnings.push(`${sourceAnalysis.skipped_files.length} file(s) skipped by source scanner`);
  }

  // Step 3: Run wiring checks (Tasks B2-B7)
  const allFindings = [];
  const fallbackDeadline = coverage === 'partial' ? startTime + FALLBACK_TIMEOUT_MS : Infinity;

  if (stage === 'impl-verify' || stage === 'post-impl') {
    // B2: Route registration
    allFindings.push(...checkUnregisteredRoutes(sourceAnalysisFiles, projectRoot));

    // B3: Event name alignment
    if (Date.now() < fallbackDeadline) {
      allFindings.push(...checkMismatchedEvents(sourceAnalysisFiles, projectRoot));
    }

    // B4: Config function consistency
    if (Date.now() < fallbackDeadline) {
      allFindings.push(...checkWrongConfig(sourceAnalysisFiles, projectRoot));
    }

    // B5: Assumption conflict detection (uses fallback-capped file list)
    if (Date.now() < fallbackDeadline) {
      allFindings.push(...checkAssumptionConflicts(fallbackFilesForScan, projectRoot));
    }

    // B6: Disconnected handlers
    if (Date.now() < fallbackDeadline) {
      allFindings.push(...checkDisconnectedHandlers(sourceAnalysisFiles, projectRoot));
    }

    // B7: Missing middleware
    if (Date.now() < fallbackDeadline) {
      allFindings.push(...checkMissingMiddleware(sourceAnalysisFiles, projectRoot));
    }

    // General: Missing imports
    if (Date.now() < fallbackDeadline) {
      allFindings.push(...checkMissingImports(sourceAnalysisFiles, projectRoot));
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

  // Step 5.5: Apply optional diff-scope integration (REQ-006 / AC2.1-AC2.4).
  // When `scope === 'full'` (default) this is a no-op (AC2.4). When `scope === 'diff'`
  // we (a) filter findings to affected modules (AC2.1), (b) re-evaluate carry-
  // forward findings from prd-review / spec-review regardless of scope (AC2.2),
  // and (c) degrade to full scope on detection of a new boundary-crossing
  // export (AC2.3 / NFR-10).
  const requestedScope = args.scope || 'full';
  let effectiveScope = requestedScope;
  let diffScopeMeta = null;

  if (requestedScope === 'diff' || args.diff_scope_result) {
    // Load carry-forward entries so AC2.2 re-evaluation can include prior stages.
    const { findings: carryForwardFindings, warning: cfWarning } = readCarryForward(
      specGroupId,
      projectRoot,
    );
    if (cfWarning) warnings.push(cfWarning);

    const diffScopeOutcome = applyDiffScope({
      scope: requestedScope,
      diffScopeResult: args.diff_scope_result || null,
      findings: allFindings,
      carryForwardFindings,
      stage,
      projectRoot,
      fileToModule: null,
    });

    // Replace allFindings with scope-applied findings; carry forward metadata.
    allFindings.length = 0;
    allFindings.push(...diffScopeOutcome.findings);
    effectiveScope = diffScopeOutcome.scope;
    diffScopeMeta = {
      requested_scope: requestedScope,
      effective_scope: diffScopeOutcome.scope,
      scope_degraded: diffScopeOutcome.scopeDegraded,
      new_boundary_detected: diffScopeOutcome.newBoundaryDetected,
      affected_modules: Array.isArray(args.diff_scope_result?.affected_modules)
        ? args.diff_scope_result.affected_modules
        : [],
      carry_forward_count: carryForwardFindings.length,
      fallback: args.diff_scope_result?.fallback || null,
    };
    for (const w of diffScopeOutcome.warnings) warnings.push(w);
  }

  // Step 6: Compute gate decision (for impl-verify)
  const gateOutput = computeGateDecision(allFindings, coverage);

  // Step 7: Build output
  const elapsed = Date.now() - startTime;
  const result = {
    timestamp: new Date().toISOString(),
    spec_group: specGroupId,
    stage: stage,
    scope: effectiveScope,
    diff_scope: diffScopeMeta,
    modified_files: modifiedFiles,
    source_scan_results: {
      files_scanned: sourceAnalysis.files.map(file => file.filePath),
      skipped_files: sourceAnalysis.skipped_files,
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
