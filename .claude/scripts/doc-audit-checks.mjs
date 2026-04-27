#!/usr/bin/env node

/**
 * Doc Audit Pre-Computation Script
 *
 * Standalone script run by the orchestrating agent (which has Bash access)
 * before dispatching the read-only doc-auditor agent. Performs git-correlated
 * staleness detection, accuracy checks, and other shell-dependent operations.
 *
 * Outputs structured JSON to .claude/audit-reports/.audit-precomputed.json
 * for the auditor to consume via its Read tool.
 *
 * Usage:
 *   node .claude/scripts/doc-audit-checks.mjs [options]
 *
 * Options:
 *   --scope <feature|multi|full>   Audit scope (default: full)
 *   --level <quick|deep>           Audit level (default: quick)
 *   --paths <path1,path2,...>      Comma-separated target paths
 *   --exclude <path1,path2,...>    Comma-separated exclude paths
 *   --project-root <path>          Override project root
 *
 * Exit codes:
 *   0 = success (results written)
 *   1 = fatal error (no results written)
 *
   * Implements: AC-1.1, AC-1.3, AC-1.9, AC-1.10, AC-1.11, AC-1.12
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative, basename, extname } from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { getCanonicalProjectDir } from './lib/hook-utils.mjs';

// =============================================================================
// Constants
// =============================================================================

/** Canonical documentation directories (AC-1.6, spec Context section) */
const KNOWN_DOC_DIRECTORIES = [
  '.claude/docs/',
  '.claude/memory-bank/',
  'docs/',
  '.claude/prds/',
];

/** Valid scope types per contract-audit-scope-input */
const VALID_SCOPES = ['feature', 'multi', 'full'];

/** Valid level types per contract-audit-scope-input */
const VALID_LEVELS = ['quick', 'deep'];

/** Output path for pre-computed results (AC-1.5) */
const PRECOMPUTED_OUTPUT_RELATIVE = '.claude/audit-reports/.audit-precomputed.json';

/** Performance budget in milliseconds (AC-1.10: 60s for ~25 files) */
const PERFORMANCE_BUDGET_MS = 60_000;

// =============================================================================
// Argument Parsing
// =============================================================================

function parseArgs(argv) {
  const args = {
    scope: 'full',
    level: 'quick',
    paths: null,
    exclude: null,
    projectRoot: null,
  };

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--scope':
        args.scope = argv[++i];
        break;
      case '--level':
        args.level = argv[++i];
        break;
      case '--paths':
        args.paths = argv[++i]?.split(',').map(p => p.trim()).filter(Boolean) || [];
        break;
      case '--exclude':
        args.exclude = argv[++i]?.split(',').map(p => p.trim()).filter(Boolean) || [];
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

  // as-012 (REQ-003.6): delegate to canonicalizer; fall back to git/cwd on failure.
  try {
    return getCanonicalProjectDir();
  } catch {
    /* fall through */
  }

  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    if (gitRoot) return gitRoot;
  } catch {
    // Silent catch: git may not be installed or cwd may not be a repo.
    // This is a best-effort root resolution -- falling through to cwd() is the intended fallback.
  }

  return process.cwd();
}

// =============================================================================
// Scope Validation (AC-1.6)
// =============================================================================

/**
 * Validate scope input per contract-audit-scope-input.
 * @param {object} input - { scope, level, paths?, exclude? }
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateScopeInput(input) {
  const errors = [];

  if (!input.scope || !VALID_SCOPES.includes(input.scope)) {
    errors.push(`Invalid scope: ${input.scope}. Must be one of: ${VALID_SCOPES.join(', ')}`);
  }
  if (input.level && !VALID_LEVELS.includes(input.level)) {
    errors.push(`Invalid level: ${input.level}. Must be one of: ${VALID_LEVELS.join(', ')}`);
  }

  // Path validation: must be within KNOWN_DOC_DIRECTORIES
  // Resolve paths against a synthetic root to prevent traversal bypass (e.g., .claude/docs/../../etc/passwd)
  if (Array.isArray(input.paths)) {
    for (const p of input.paths) {
      const resolved = resolve('/', p);
      const withinKnown = KNOWN_DOC_DIRECTORIES.some(dir => resolved.startsWith(resolve('/', dir)));
      if (!withinKnown) {
        errors.push(`Path outside known doc directories: ${p}`);
      }
    }
  }
  if (Array.isArray(input.exclude)) {
    for (const p of input.exclude) {
      const resolved = resolve('/', p);
      const withinKnown = KNOWN_DOC_DIRECTORIES.some(dir => resolved.startsWith(resolve('/', dir)));
      if (!withinKnown) {
        errors.push(`Exclude path outside known doc directories: ${p}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// =============================================================================
// File Discovery
// =============================================================================

/**
 * Recursively discover documentation files within known directories.
 * @param {string} projectRoot - Absolute project root
 * @param {string[]} targetPaths - Optional specific paths to scan
 * @param {string[]} excludePaths - Optional paths to exclude
 * @param {string[]} warnings - Mutable array to collect warnings
 * @returns {string[]} Relative file paths
 */
function discoverDocFiles(projectRoot, targetPaths, excludePaths, warnings) {
  const files = [];
  const excludeSet = new Set(excludePaths || []);

  if (targetPaths && targetPaths.length > 0) {
    // Use specified paths directly
    for (const p of targetPaths) {
      if (excludeSet.has(p)) continue;
      const fullPath = join(projectRoot, p);
      if (existsSync(fullPath)) {
        const stat = statSync(fullPath);
        if (stat.isFile()) {
          files.push(p);
        } else if (stat.isDirectory()) {
          files.push(...walkDir(fullPath, projectRoot, excludeSet, warnings));
        }
      }
    }
  } else {
    // Scan all KNOWN_DOC_DIRECTORIES
    for (const dir of KNOWN_DOC_DIRECTORIES) {
      const fullDir = join(projectRoot, dir);
      if (existsSync(fullDir)) {
        files.push(...walkDir(fullDir, projectRoot, excludeSet, warnings));
      }
    }
  }

  return files;
}

/**
 * Walk a directory recursively collecting file paths.
 * @param {string} dirPath - Absolute directory path to walk
 * @param {string} projectRoot - Project root for relative path computation
 * @param {Set<string>} excludeSet - Relative paths to exclude
 * @param {string[]} warnings - Mutable array to collect warnings
 * @returns {string[]} Relative file paths found
 */
function walkDir(dirPath, projectRoot, excludeSet, warnings) {
  const results = [];
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      const relPath = relative(projectRoot, fullPath);
      if (excludeSet.has(relPath)) continue;

      if (entry.isDirectory()) {
        // Skip node_modules and hidden dirs (except .claude)
        if (entry.name === 'node_modules' || (entry.name.startsWith('.') && entry.name !== '.claude')) {
          continue;
        }
        results.push(...walkDir(fullPath, projectRoot, excludeSet, warnings));
      } else if (entry.isFile()) {
        // Include markdown and yaml files
        const ext = extname(entry.name).toLowerCase();
        if (['.md', '.yaml', '.yml'].includes(ext)) {
          results.push(relPath);
        }
      }
    }
  } catch (err) {
    warnings.push(`[walkDir] Skipped ${dirPath}: ${err.message}`);
  }
  return results;
}

// =============================================================================
// Doc-to-Source Mapping (AC-1.9)
// =============================================================================

/**
 * Resolve doc-to-source mapping via three methods in priority order.
 * @param {string} docPath - Relative doc path
 * @param {string} projectRoot - Project root
 * @param {object|null} traceConfig - Parsed trace.config.json
 * @param {string[]} warnings - Mutable array to collect warnings
 * @returns {{ method: string, sources: string[] }}
 */
function resolveDocToSource(docPath, projectRoot, traceConfig, warnings) {
  // Method 1: Explicit _source_modules frontmatter
  // Note: Frontmatter parsing uses regex rather than a full YAML parser.
  // Supported formats: inline array `_source_modules: [a, b]` and YAML list
  // `_source_modules:\n  - a\n  - b`. Nested or multi-line quoted values are
  // not handled -- extend if those formats are needed.
  try {
    const content = readFileSync(join(projectRoot, docPath), 'utf-8');
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (frontmatterMatch) {
      const fm = frontmatterMatch[1];
      const sourceModulesMatch = fm.match(/_source_modules:\s*\[(.*?)\]/s);
      if (sourceModulesMatch) {
        const modules = sourceModulesMatch[1]
          .split(',')
          .map(m => m.trim().replace(/['"]/g, ''))
          .filter(Boolean);
        if (modules.length > 0) {
          return { method: 'frontmatter', sources: modules };
        }
      }
      // Also check YAML list format
      const yamlListMatch = fm.match(/_source_modules:\s*\n((?:\s*-\s*.+\n?)*)/);
      if (yamlListMatch) {
        const modules = yamlListMatch[1]
          .split('\n')
          .map(line => line.replace(/^\s*-\s*/, '').trim().replace(/['"]/g, ''))
          .filter(Boolean);
        if (modules.length > 0) {
          return { method: 'frontmatter', sources: modules };
        }
      }
    }
  } catch (err) {
    warnings.push(`[resolveDocToSource] Skipped frontmatter parsing for ${docPath}: ${err.message}`);
  }

  // Method 2: Trace config fileToModule() matching
  if (traceConfig && Array.isArray(traceConfig.modules)) {
    const docBaseName = basename(docPath, extname(docPath)).toLowerCase();
    for (const mod of traceConfig.modules) {
      // Check if the doc name suggests a relationship with this module
      const modNameLower = mod.id.toLowerCase();
      if (docBaseName.includes(modNameLower) || modNameLower.includes(docBaseName)) {
        return { method: 'trace_config', sources: [mod.id] };
      }
    }
  }

  // Method 3: Naming convention fallback
  const docName = basename(docPath, extname(docPath)).toLowerCase();
  // Common patterns: HOOKS.md -> hooks, tech.context.md -> tech-context
  const normalizedName = docName.replace(/\./g, '-').replace(/_/g, '-');

  // Check if a matching script or module directory exists
  const conventionPaths = [
    `.claude/scripts/${normalizedName}.mjs`,
    `.claude/scripts/lib/${normalizedName}.mjs`,
    `src/${normalizedName}/`,
  ];

  for (const cp of conventionPaths) {
    if (existsSync(join(projectRoot, cp))) {
      return { method: 'naming_convention', sources: [cp] };
    }
  }

  // No match -- orphan
  return { method: 'orphan', sources: [] };
}

// =============================================================================
// Git-Correlated Staleness Detection (AC-1.3, AC-1.11, AC-1.12)
// =============================================================================

/**
 * Check if git is available.
 * @param {string[]} warnings - Mutable array to collect warnings
 * @returns {boolean}
 */
function isGitAvailable(warnings) {
  try {
    execSync('git --version', { encoding: 'utf-8', timeout: 5000 });
    return true;
  } catch (err) {
    warnings.push(`[isGitAvailable] Git CLI not available: ${err.message}`);
    return false;
  }
}

/**
 * Get the last modified date of a file via git log.
 * Returns ISO timestamp or null if not tracked.
 * @param {string} filePath - Relative file path
 * @param {string} projectRoot - Project root
 * @param {string[]} warnings - Mutable array to collect warnings
 * @returns {string|null} ISO timestamp
 */
function getGitLastModified(filePath, projectRoot, warnings) {
  try {
    // SEC-1: Use execFileSync to avoid shell interpolation of filePath
    const result = execFileSync(
      'git', ['log', '-1', '--format=%aI', '--', filePath],
      { encoding: 'utf-8', timeout: 10000, cwd: projectRoot },
    ).trim();
    return result || null;
  } catch (err) {
    warnings.push(`[getGitLastModified] Skipped ${filePath}: ${err.message}`);
    return null;
  }
}

/**
 * Perform git-correlated staleness detection for a doc file.
 * Compares doc last-modified against source last-modified.
 * @param {string} docPath - Relative doc path
 * @param {string[]} sourcePaths - Related source file/module paths
 * @param {string} projectRoot - Project root
 * @param {string[]} warnings - Mutable array to collect warnings
 * @returns {{ stale: boolean, doc_last_modified: string|null, source_last_modified: string|null, warning: string|null }}
 */
function checkStaleness(docPath, sourcePaths, projectRoot, warnings) {
  const docLastModified = getGitLastModified(docPath, projectRoot, warnings);
  if (!docLastModified) {
    return {
      stale: false,
      doc_last_modified: null,
      source_last_modified: null,
      warning: `Staleness detection skipped for ${docPath}: no git history available`,
    };
  }

  if (sourcePaths.length === 0) {
    return {
      stale: false,
      doc_last_modified: docLastModified,
      source_last_modified: null,
      warning: `Staleness detection limited for ${docPath}: no source correlation (orphan)`,
    };
  }

  // Find the most recent source modification
  let latestSourceModified = null;
  for (const sourcePath of sourcePaths) {
    // Source path might be a module ID -- try to find files
    const sourceDate = getGitLastModified(sourcePath, projectRoot, warnings);
    if (sourceDate && (!latestSourceModified || sourceDate > latestSourceModified)) {
      latestSourceModified = sourceDate;
    }
  }

  if (!latestSourceModified) {
    return {
      stale: false,
      doc_last_modified: docLastModified,
      source_last_modified: null,
      warning: `Source files not tracked in git for ${docPath}`,
    };
  }

  const stale = new Date(latestSourceModified) > new Date(docLastModified);
  return {
    stale,
    doc_last_modified: docLastModified,
    source_last_modified: latestSourceModified,
    warning: null,
  };
}

// =============================================================================
// Accuracy Checks (deep level only)
// =============================================================================

/**
 * Check file path references in doc content.
 * Extracts paths from code blocks and verifies they resolve.
 * @param {string} docPath - Relative doc path
 * @param {string} projectRoot - Project root
 * @param {string[]} warnings - Mutable array to collect warnings
 * @returns {{ path: string, exists: boolean }[]}
 */
function checkFilePathAccuracy(docPath, projectRoot, warnings) {
  const results = [];
  try {
    const content = readFileSync(join(projectRoot, docPath), 'utf-8');
    // Extract file paths from code blocks
    const pathRegex = /(?:\.claude\/|src\/|docs\/)[\w./-]+\.\w+/g;
    const paths = content.match(pathRegex) || [];
    const seen = new Set();

    for (const p of paths) {
      if (seen.has(p)) continue;
      seen.add(p);
      results.push({
        path: p,
        exists: existsSync(join(projectRoot, p)),
      });
    }
  } catch (err) {
    warnings.push(`[checkFilePathAccuracy] Skipped ${docPath}: ${err.message}`);
  }
  return results;
}

// =============================================================================
// Main Execution
// =============================================================================

async function main() {
  const startTime = Date.now();
  const args = parseArgs(process.argv);
  const projectRoot = resolveProjectRoot(args.projectRoot);

  // Validate scope input (AC-1.6)
  const validation = validateScopeInput({
    scope: args.scope,
    level: args.level,
    paths: args.paths,
    exclude: args.exclude,
  });

  if (!validation.valid) {
    console.error('Scope validation failed:', validation.errors.join('; '));
    process.exit(1);
  }

  // Check git availability (AC-1.11)
  const warnings = [];
  const gitAvailable = isGitAvailable(warnings);

  if (!gitAvailable) {
    warnings.push('Git CLI not available -- staleness detection disabled for all files');
  }

  // Load trace config for doc-to-source mapping (AC-1.9)
  let traceConfig = null;
  try {
    const configPath = join(projectRoot, '.claude/traces/trace.config.json');
    if (existsSync(configPath)) {
      traceConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    }
  } catch (err) {
    warnings.push(`[loadTraceConfig] trace.config.json not available -- falling back to naming conventions: ${err.message}`);
  }

  // Discover doc files
  const docFiles = discoverDocFiles(projectRoot, args.paths, args.exclude, warnings);

  // Perform staleness detection (AC-1.3)
  const stalenessResults = [];
  if (gitAvailable) {
    for (const docPath of docFiles) {
      const mapping = resolveDocToSource(docPath, projectRoot, traceConfig, warnings);
      const staleness = checkStaleness(docPath, mapping.sources, projectRoot, warnings);

      stalenessResults.push({
        doc_path: docPath,
        doc_last_modified: staleness.doc_last_modified,
        source_last_modified: staleness.source_last_modified,
        stale: staleness.stale,
        source_modules: mapping.sources,
        mapping_method: mapping.method,
      });

      if (staleness.warning) {
        warnings.push(staleness.warning);
      }
    }
  } else {
    for (const docPath of docFiles) {
      warnings.push(`Staleness detection skipped for ${docPath}: no git history available`);
    }
  }

  // Perform accuracy checks if deep level
  const accuracyResults = [];
  if (args.level === 'deep') {
    for (const docPath of docFiles) {
      const pathResults = checkFilePathAccuracy(docPath, projectRoot, warnings);
      if (pathResults.length > 0) {
        accuracyResults.push({
          doc_path: docPath,
          path_checks: pathResults,
        });
      }
    }
  }

  // Build output (AC-1.5)
  const output = {
    timestamp: new Date().toISOString(),
    scope: args.scope,
    level: args.level,
    doc_files: docFiles,
    staleness_results: stalenessResults,
    accuracy_results: accuracyResults,
    warnings,
    performance_ms: Date.now() - startTime,
  };

  // Ensure output directory exists
  const outputPath = join(projectRoot, PRECOMPUTED_OUTPUT_RELATIVE);
  const outputDir = join(projectRoot, '.claude/audit-reports');
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // Write output (AC-1.5)
  writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');

  // Performance check (AC-1.10)
  const elapsed = Date.now() - startTime;
  if (elapsed > PERFORMANCE_BUDGET_MS) {
    console.warn(`Warning: Pre-computation took ${elapsed}ms, exceeding ${PERFORMANCE_BUDGET_MS}ms budget`);
  }

  console.log(`Pre-computation complete: ${docFiles.length} files, ${stalenessResults.filter(s => s.stale).length} stale, ${warnings.length} warnings, ${elapsed}ms`);
}

main().catch(err => {
  console.error('Fatal error in doc-audit-checks.mjs:', err.message);
  process.exit(1);
});
