#!/usr/bin/env node

/**
 * Import Graph Reachability Check (Advisory)
 *
 * Traces static imports from entry point(s) and checks whether specified files
 * are reachable through the import chain. Also supports wiring-task detection
 * mode via --spec flag.
 *
 * Usage:
 *   node import-graph-check.mjs --entry <path> [--entry <path2>] --check <file1> <file2> ...
 *   node import-graph-check.mjs --spec <spec-path>
 *
 * Exit code: Always 0 (advisory, never blocking)
 *
 * Standard mode output (JSON to stdout):
 *   { reachable: string[], unreachable: string[], warnings: string[] }
 *
 * Spec/wiring-task detection mode output (JSON to stdout):
 *   { init_methods_found: Array<{file, methods}>, wiring_task_found: boolean,
 *     advisory?: string, warnings: string[] }
 *
 * Implements: AC-2.2, AC-2.3, AC-2.4, AC-2.5, AC-2.6, AC-2.7, AC-2.10, AC-1.5
 * Spec: sg-pipeline-integration-gaps
 */

import { readFileSync, existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve, extname, relative, isAbsolute } from 'node:path';
import { extractSpecFilePaths } from './lib/spec-utils.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Extensions to try when resolving imports without explicit extension (AC-2.3) */
const EXTENSION_RESOLUTION_ORDER = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js'];

/** Non-JS extensions treated as leaf nodes (AC-2.3) */
const LEAF_EXTENSIONS = new Set(['.css', '.scss', '.less', '.sass', '.json', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.mp4', '.webm', '.ogg', '.wav']);

/**
 * Regex for static import/require statements.
 * Captures the module specifier from:
 *   import ... from 'specifier'
 *   import 'specifier'
 *   export ... from 'specifier'
 *   require('specifier')
 */
const STATIC_IMPORT_RE = /(?:import\s+(?:[^;]*?\s+from\s+)?['"]([^'"]+)['"]|export\s+(?:[^;]*?\s+from\s+)?['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;

/** Regex for dynamic import() expressions (AC-2.7) */
const DYNAMIC_IMPORT_RE = /(?<!\w)import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Init-method detection regex for wiring-task mode (AC-1.5).
 * Matches module-level initialization patterns:
 *   init(), initialize(), configure(), setup(), register()
 *   set*() where * suggests module wiring (setContextPipeline, setResolverRegistry, etc.)
 *
 * Excludes simple property setters by checking for uppercase letter after "set"
 * that suggests a subsystem name (e.g., setResolverRegistry) vs. a simple property
 * (e.g., setWidth, setColor).
 */
const INIT_METHOD_RE = /\b(init|initialize|configure|setup|register)\s*\(/g;

/**
 * Set* methods that look like module initialization wiring (not property setters).
 * A set*() is considered initialization if:
 *   - It's followed by a compound name suggesting subsystem wiring
 *     (e.g., setContextPipeline, setResolverRegistry, setLogger, setConfig)
 *   - NOT simple property setters (e.g., setWidth, setColor, setValue)
 *
 * Heuristic: set<UpperCase><rest>() where <rest> contains another uppercase letter
 * or known subsystem keywords (Pipeline, Registry, Logger, Config, Provider, Factory,
 * Handler, Manager, Service, Client, Connection, Store, Cache, Queue, Router, Resolver)
 */
const SET_INIT_RE = /\bset([A-Z]\w*)\s*\(/g;
const SUBSYSTEM_KEYWORDS = /(?:Pipeline|Registry|Logger|Config|Provider|Factory|Handler|Manager|Service|Client|Connection|Store|Cache|Queue|Router|Resolver)/;

/** Wiring task reference keywords in spec task list (AC-1.5) */
const WIRING_KEYWORDS_RE = /\b(wire|wiring|register|connect|bootstrap|entry.?point|index\.ts|index\.js|main\.ts|main\.js)\b/i;

// ---------------------------------------------------------------------------
// Parse CLI arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { entries: [], checkFiles: [], specPath: null };
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--entry' && i + 1 < argv.length) {
      args.entries.push(argv[++i]);
    } else if (arg === '--check') {
      // Consume all remaining args that don't start with --
      i++;
      while (i < argv.length && !argv[i].startsWith('--')) {
        args.checkFiles.push(argv[i]);
        i++;
      }
      continue; // Don't increment i again
    } else if (arg === '--spec' && i + 1 < argv.length) {
      args.specPath = argv[++i];
    }
    i++;
  }

  return args;
}

// ---------------------------------------------------------------------------
// tsconfig path resolution (AC-2.3, AC-2.4)
// ---------------------------------------------------------------------------

/**
 * Load tsconfig.json paths config from the project root.
 * Returns null if tsconfig.json is missing or has no paths (AC-2.4).
 */
function loadTsconfigPaths(projectRoot) {
  const tsconfigPath = join(projectRoot, 'tsconfig.json');
  if (!existsSync(tsconfigPath)) return null;

  try {
    const content = readFileSync(tsconfigPath, 'utf-8');
    const tsconfig = JSON.parse(content);
    const paths = tsconfig?.compilerOptions?.paths;
    const baseUrl = tsconfig?.compilerOptions?.baseUrl || '.';

    if (!paths || Object.keys(paths).length === 0) return null;

    return { paths, baseUrl: resolve(projectRoot, baseUrl) };
  } catch {
    return null; // Invalid tsconfig -- fall back to Node resolution (AC-2.4)
  }
}

/**
 * Resolve a module specifier using tsconfig paths.
 * Returns resolved absolute path or null if no match.
 */
function resolveTsconfigPath(specifier, tsconfigInfo) {
  if (!tsconfigInfo) return null;

  const { paths, baseUrl } = tsconfigInfo;

  for (const [pattern, targets] of Object.entries(paths)) {
    // Convert tsconfig path pattern to regex
    // e.g., "@utils/*" -> /^@utils\/(.*)$/
    const patternRegex = new RegExp(
      '^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '(.*)') + '$'
    );
    const match = specifier.match(patternRegex);

    if (match) {
      const captured = match[1] || '';
      for (const target of targets) {
        const resolvedTarget = target.replace('*', captured);
        const fullPath = resolve(baseUrl, resolvedTarget);
        const resolved = resolveFileExtension(fullPath);
        if (resolved) return resolved;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// File resolution helpers
// ---------------------------------------------------------------------------

/**
 * Try resolving a path by appending known extensions (AC-2.3).
 * Returns the first existing file path, or null.
 */
function resolveFileExtension(filePath) {
  // Try exact path first
  if (existsSync(filePath) && !isDirectory(filePath)) return filePath;

  // Try each extension in order
  for (const ext of EXTENSION_RESOLUTION_ORDER) {
    const candidate = filePath + ext;
    if (existsSync(candidate) && !isDirectory(candidate)) return candidate;
  }

  // Try as directory with index file (barrel re-export, AC-2.3)
  if (isDirectory(filePath)) {
    for (const indexFile of ['index.ts', 'index.tsx', 'index.js', 'index.jsx']) {
      const candidate = join(filePath, indexFile);
      if (existsSync(candidate)) return candidate;
    }
  }

  return null;
}

/** Check if path is a directory (safe -- returns false on error) */
function isDirectory(filePath) {
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Normalize a path, resolving symlinks where possible (macOS: /var -> /private/var).
 * Falls back to resolve() if realpathSync fails (file may not exist yet).
 */
function normalizePath(filePath) {
  try {
    return realpathSync(filePath);
  } catch {
    return resolve(filePath);
  }
}

/**
 * Determine project root from entry point or cwd.
 * Looks for package.json or tsconfig.json walking up from the given path.
 *
 * Uses the same path form as the input (no symlink resolution) to maintain
 * consistency between entry paths and resolved paths. This avoids
 * /var -> /private/var mismatches on macOS.
 */
function findProjectRoot(startPath) {
  const startDir = isAbsolute(startPath)
    ? dirname(startPath)
    : resolve(dirname(startPath));

  let current = startDir;

  while (current !== dirname(current)) {
    if (existsSync(join(current, 'package.json')) || existsSync(join(current, 'tsconfig.json'))) {
      return current;
    }
    current = dirname(current);
  }

  // Fallback: use parent of start path's first directory.
  // Prefer the input path form to avoid symlink mismatch with cwd.
  return startDir;
}

/**
 * Validate that a path is within the project root (AC-2.5).
 * Tries both resolve() and realpathSync() to handle symlinks (e.g., /var -> /private/var on macOS).
 */
function isWithinProjectRoot(filePath, projectRoot) {
  try {
    const fileResolved = resolve(filePath);
    const rootResolved = resolve(projectRoot);

    // Direct prefix match
    if (fileResolved.startsWith(rootResolved + '/') || fileResolved === rootResolved) {
      return true;
    }

    // Symlink-resolved prefix match (e.g., /var/folders vs /private/var/folders)
    const fileNorm = normalizePath(filePath);
    const rootNorm = normalizePath(projectRoot);
    return fileNorm.startsWith(rootNorm + '/') || fileNorm === rootNorm;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Import graph traversal (AC-2.2, AC-2.6, AC-2.7)
// ---------------------------------------------------------------------------

/**
 * Parse static and dynamic imports from a file's content.
 * Returns { staticImports: string[], dynamicImports: string[] }
 */
function parseImports(content) {
  const staticImports = [];
  const dynamicImports = [];

  // Reset regex lastIndex
  STATIC_IMPORT_RE.lastIndex = 0;
  DYNAMIC_IMPORT_RE.lastIndex = 0;

  let match;

  // Static imports
  while ((match = STATIC_IMPORT_RE.exec(content)) !== null) {
    const specifier = match[1] || match[2] || match[3];
    if (specifier) staticImports.push(specifier);
  }

  // Dynamic imports (AC-2.7)
  while ((match = DYNAMIC_IMPORT_RE.exec(content)) !== null) {
    if (match[1]) dynamicImports.push(match[1]);
  }

  return { staticImports, dynamicImports };
}

/**
 * Resolve a module specifier to an absolute file path.
 * Returns null if unresolvable.
 */
function resolveImport(specifier, fromFile, projectRoot, tsconfigInfo) {
  // Bare specifiers (no ./ or ../ or /) -> node_modules leaf node (AC-2.3)
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    // Try tsconfig path alias first (AC-2.3)
    const tsconfigResolved = resolveTsconfigPath(specifier, tsconfigInfo);
    if (tsconfigResolved) return tsconfigResolved;

    // Otherwise it's a node_modules import -- leaf node
    return null;
  }

  // Relative or absolute specifier
  const fromDir = dirname(fromFile);
  const targetPath = resolve(fromDir, specifier);

  return resolveFileExtension(targetPath);
}

/**
 * Build the reachability set by walking the import graph from entry points.
 *
 * @param {string[]} entryPoints - Absolute paths to entry point files
 * @param {string} projectRoot - Project root directory
 * @param {object|null} tsconfigInfo - tsconfig paths info or null
 * @returns {{ reachableSet: Set<string>, warnings: string[] }}
 */
function buildReachabilitySet(entryPoints, projectRoot, tsconfigInfo) {
  const reachableSet = new Set();
  const warnings = [];
  const visiting = new Set(); // For circular import detection

  function walk(filePath) {
    const resolved = resolve(filePath);

    // Circular import detection (AC-2.6) -- check before reachableSet
    if (visiting.has(resolved)) {
      warnings.push(`Circular import detected: ${resolved}`);
      return;
    }

    // Already visited -- skip
    if (reachableSet.has(resolved)) return;

    // Path validation (AC-2.5)
    if (!isWithinProjectRoot(resolved, projectRoot)) {
      warnings.push(`Path outside project root: ${resolved}`);
      return;
    }

    // Non-JS leaf node check (AC-2.3)
    const ext = extname(resolved).toLowerCase();
    if (LEAF_EXTENSIONS.has(ext)) return;

    // Mark as visiting (for circular detection)
    visiting.add(resolved);
    reachableSet.add(resolved);

    // Read file content
    let content;
    try {
      content = readFileSync(resolved, 'utf-8');
    } catch {
      // Unresolvable file -- emit warning but continue (AC-2.6)
      warnings.push(`Cannot read file: ${resolved}`);
      visiting.delete(resolved);
      return;
    }

    // Parse imports
    const { staticImports, dynamicImports } = parseImports(content);

    // Flag dynamic imports (AC-2.7)
    for (const dynImport of dynamicImports) {
      warnings.push(`Dynamic import boundary: ${dynImport} in ${resolved}`);
    }

    // Recurse into static imports
    for (const specifier of staticImports) {
      const resolvedImport = resolveImport(specifier, resolved, projectRoot, tsconfigInfo);
      if (resolvedImport) {
        walk(resolvedImport);
      }
      // null = node_modules or unresolvable -- skip silently
    }

    visiting.delete(resolved);
  }

  // Walk from each entry point
  for (const entry of entryPoints) {
    if (existsSync(entry)) {
      walk(entry);
    } else {
      warnings.push(`Entry point does not exist: ${entry}`);
    }
  }

  return { reachableSet, warnings };
}

// ---------------------------------------------------------------------------
// Standard mode: --entry + --check (AC-2.2)
// ---------------------------------------------------------------------------

function runStandardMode(entries, checkFiles, projectRoot) {
  const tsconfigInfo = loadTsconfigPaths(projectRoot);

  // Resolve entries to absolute paths (resolve for output, normalizePath for comparison)
  const resolvedEntries = entries.map(e => resolve(e));

  // Validate entry paths within project root (AC-2.5)
  const validEntries = [];
  const warnings = [];
  for (const entry of resolvedEntries) {
    if (isWithinProjectRoot(entry, projectRoot)) {
      validEntries.push(entry);
    } else {
      warnings.push(`Entry point outside project root, skipped: ${entry}`);
    }
  }

  // Build reachability set (uses normalizePath internally)
  const { reachableSet, warnings: walkWarnings } = buildReachabilitySet(
    validEntries, projectRoot, tsconfigInfo
  );
  warnings.push(...walkWarnings);

  // Classify check files (AC-2.2)
  const reachable = [];
  const unreachable = [];

  for (const checkFile of checkFiles) {
    const resolvedCheck = resolve(checkFile);

    // Validate within project root (AC-2.5)
    if (!isWithinProjectRoot(resolvedCheck, projectRoot)) {
      warnings.push(`Check file outside project root, skipped: ${resolvedCheck}`);
      continue;
    }

    if (reachableSet.has(resolvedCheck)) {
      reachable.push(resolvedCheck);
    } else {
      unreachable.push(resolvedCheck);
    }
  }

  return { reachable, unreachable, warnings };
}

// ---------------------------------------------------------------------------
// Spec/wiring-task detection mode: --spec (AC-1.5)
// ---------------------------------------------------------------------------

// extractSpecFilePaths imported from ./lib/spec-utils.mjs

/**
 * Scan a file for init-method definitions (AC-1.5).
 * Returns array of method names found, or empty array.
 *
 * Applies heuristic to exclude simple property setters (EC-13):
 * - init(), initialize(), configure(), setup(), register() always match
 * - set*() only matches if the name suggests subsystem wiring
 */
function scanForInitMethods(content) {
  const methods = [];

  // Check for standard init methods
  INIT_METHOD_RE.lastIndex = 0;
  let match;
  while ((match = INIT_METHOD_RE.exec(content)) !== null) {
    methods.push(match[1] + '()');
  }

  // Check for set*() methods with subsystem wiring heuristic (EC-13)
  SET_INIT_RE.lastIndex = 0;
  while ((match = SET_INIT_RE.exec(content)) !== null) {
    const methodName = match[1]; // Part after "set"
    if (SUBSYSTEM_KEYWORDS.test(methodName)) {
      methods.push('set' + methodName + '()');
    }
  }

  return [...new Set(methods)]; // Deduplicate
}

/**
 * Check if the spec task list contains wiring references (AC-1.5).
 */
function hasWiringTask(specContent) {
  // Extract task list section
  const taskListMatch = specContent.match(/##\s+Task List([\s\S]*?)(?=\n## |\n---|$)/i);
  if (!taskListMatch) return false;

  const taskSection = taskListMatch[1];
  return WIRING_KEYWORDS_RE.test(taskSection);
}

/**
 * Run wiring-task detection mode.
 */
function runSpecMode(specPath, projectRoot) {
  const warnings = [];

  // Read spec
  let specContent;
  try {
    specContent = readFileSync(specPath, 'utf-8');
  } catch {
    return {
      init_methods_found: [],
      wiring_task_found: false,
      warnings: [`Cannot read spec file: ${specPath}`],
    };
  }

  // Extract file paths from spec
  const specFilePaths = extractSpecFilePaths(specContent);

  // Scan referenced files for init methods
  const initMethodsFound = [];
  for (const relPath of specFilePaths) {
    const absPath = resolve(projectRoot, relPath);
    if (!existsSync(absPath)) continue;

    try {
      const content = readFileSync(absPath, 'utf-8');
      const methods = scanForInitMethods(content);
      if (methods.length > 0) {
        initMethodsFound.push({ file: relPath, methods });
      }
    } catch {
      warnings.push(`Cannot read referenced file: ${relPath}`);
    }
  }

  // Check for wiring task in spec
  const wiringTaskFound = initMethodsFound.length > 0 ? hasWiringTask(specContent) : false;

  // Build result
  const result = {
    init_methods_found: initMethodsFound,
    wiring_task_found: wiringTaskFound,
    warnings,
  };

  // Add advisory only when init methods exist but no wiring task found
  if (initMethodsFound.length > 0 && !wiringTaskFound) {
    result.advisory = 'Spec creates files with init/register methods but no wiring task references the entry point';
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));

    // Determine project root
    const refPath = args.specPath || args.entries[0] || process.cwd();
    const projectRoot = findProjectRoot(refPath);

    let result;

    if (args.specPath) {
      // Wiring-task detection mode (AC-1.5)
      result = runSpecMode(args.specPath, projectRoot);
    } else {
      // Standard reachability mode (AC-2.2)
      result = runStandardMode(args.entries, args.checkFiles, projectRoot);
    }

    // Output JSON to stdout
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    // Graceful failure (AC-2.6) -- always exit 0
    console.log(JSON.stringify({
      reachable: [],
      unreachable: [],
      warnings: [`Script error: ${error.message}`],
    }));
  }

  // Always exit 0 (advisory, AC-2.2)
  process.exit(0);
}

main();
