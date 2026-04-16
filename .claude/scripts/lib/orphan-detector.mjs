/**
 * Orphan detector for the metaclaude registry sync.
 *
 * Walks the sync-scoped roots (SYNC_SCOPED_ROOTS from sync-constants.mjs) and
 * emits a `{rule: "orphan"}` finding for each file that is neither registered in
 * `artifacts[]`, listed in `orphans[]`, nor matched by `WHITELIST_GLOBS`.
 *
 * Pure synchronous `fs.readdirSync` walk -- no spawn, no async, no glob runtime
 * dependency. Estimated budget: <= 2 s on the metaclaude repo (~3000 files).
 *
 * Spec: sg-sync-registry-gaps T2.1, REQ-008, REQ-011, REQ-021, REQ-022.
 */

import { readdirSync, statSync } from 'node:fs';
import { join, sep as pathSep, relative } from 'node:path';

import {
  SYNC_SCOPED_ROOTS,
  EXCLUDED_ROOTS,
  WHITELIST_GLOBS,
  matchesAnyGlob,
} from './sync-constants.mjs';
import { iterateArtifactEntries } from './registry-schema.mjs';

/**
 * Convert a filesystem path to the posix-form relative path used by the registry.
 *
 * The registry stores paths as `.claude/scripts/foo.mjs` (repo-root relative,
 * posix separators). On macOS the native separator already IS `/`, but we
 * explicitly normalize to `/` so this code ports cleanly to Windows if ever needed.
 *
 * @param {string} absolutePath - Absolute filesystem path
 * @param {string} repoRoot - Absolute path to the repo root
 * @returns {string} posix-form repo-root relative path
 */
function toRelRepoPath(absolutePath, repoRoot) {
  const rel = relative(repoRoot, absolutePath);
  return rel.split(pathSep).join('/');
}

/**
 * Check whether a relative repo path falls under any excluded root.
 *
 * @param {string} relPath - Repo-root relative path (posix form)
 * @returns {boolean} true if the path is excluded from the walk
 */
function isExcluded(relPath) {
  for (const excluded of EXCLUDED_ROOTS) {
    if (relPath === excluded || relPath.startsWith(excluded)) return true;
  }
  return false;
}

/**
 * Recursively walk a directory, collecting all regular files.
 *
 * Respects EXCLUDED_ROOTS at any depth: entering an excluded directory short-circuits
 * the walk for that subtree.
 *
 * @param {string} rootAbsolute - Absolute directory to walk
 * @param {string} repoRoot - Absolute repo root (for relative-path computation)
 * @param {string[]} out - Accumulator (mutated)
 */
function walkDir(rootAbsolute, repoRoot, out) {
  let entries;
  try {
    entries = readdirSync(rootAbsolute, { withFileTypes: true });
  } catch {
    return; // silently skip unreadable dirs (e.g., permission denied)
  }
  for (const dirent of entries) {
    const abs = join(rootAbsolute, dirent.name);
    const rel = toRelRepoPath(abs, repoRoot);
    if (isExcluded(rel + (dirent.isDirectory() ? '/' : ''))) continue;
    if (dirent.isDirectory()) {
      walkDir(abs, repoRoot, out);
    } else if (dirent.isFile()) {
      out.push(rel);
    } else if (dirent.isSymbolicLink()) {
      // Follow symlinks if they resolve to a regular file. Broken symlinks are
      // silently skipped. NOTE: this path does NOT verify the link target is
      // contained within the repo -- containment enforcement is applied later
      // at sync time via `syncTimeContainmentOk()` in metaclaude-cli.mjs and at
      // import resolution time via `assertContainment()` in the import-graph
      // validator. An escaping symlink is therefore reachable here but will be
      // rejected downstream; the orphan walk is a shallow collector, not a
      // security boundary.
      // Spec: sg-sync-registry-gaps cr-observability-77b3de5a.
      try {
        const st = statSync(abs);
        if (st.isFile()) out.push(rel);
      } catch {
        // broken symlink -- skip
      }
    }
  }
}

/**
 * Detect orphaned files in the sync-scoped roots.
 *
 * An orphaned file is one that:
 *   - Exists under a SYNC_SCOPED_ROOTS entry
 *   - Is NOT under any EXCLUDED_ROOTS entry
 *   - Does NOT match any WHITELIST_GLOBS pattern
 *   - Is NOT listed as an artifact path in `registry.artifacts[*][*].path`
 *   - Is NOT listed in `registry.orphans[*].path`
 *
 * @param {object} registry - Parsed metaclaude-registry.json
 * @param {string} repoRoot - Absolute path to the repo root
 * @returns {{findings: Array<object>, duration_ms: number, scanned: number}}
 */
export function detectOrphans(registry, repoRoot) {
  const start = performance.now();

  // Build registered + orphan path sets once.
  const registeredPaths = new Set();
  for (const { entry } of iterateArtifactEntries(registry)) {
    if (typeof entry.path === 'string') registeredPaths.add(entry.path);
  }

  const orphanPaths = new Set();
  for (const orphan of registry.orphans || []) {
    if (orphan && typeof orphan === 'object' && typeof orphan.path === 'string') {
      orphanPaths.add(orphan.path);
    }
  }

  // Walk each sync-scoped root.
  const allFiles = [];
  for (const root of SYNC_SCOPED_ROOTS) {
    const absRoot = join(repoRoot, root);
    walkDir(absRoot, repoRoot, allFiles);
  }

  const findings = [];
  for (const file of allFiles) {
    if (matchesAnyGlob(file, WHITELIST_GLOBS)) continue;
    if (registeredPaths.has(file)) continue;
    if (orphanPaths.has(file)) continue;
    findings.push({
      rule: 'orphan',
      file,
      bundle: null,
      importer: null,
      missingImport: null,
      remediation: `Either register this file via .claude/metaclaude-registry.json or add it to orphans[] with provenance; see .claude/docs/sync-system.md`,
    });
  }

  const duration_ms = Math.round(performance.now() - start);
  return { findings, duration_ms, scanned: allFiles.length };
}
