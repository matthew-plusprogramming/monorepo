/**
 * Stale Artifact Detection Helpers (AS-003)
 *
 * Pure utility functions for detecting when built artifacts are older
 * than their source files. Used by scripts/cdk.mjs to prevent
 * deploying stale artifacts.
 *
 * AC1.1: getNewestFileInDir returns { path, mtime } or null
 * AC1.2: Excludes node_modules and .git from traversal
 * AC1.3: Uses visited Set with realpathSync for symlink loop protection
 * AC1.4: formatTimeDelta returns human-readable strings
 * AC1.5: formatTimestamp returns YYYY-MM-DD HH:mm:ss format
 * AC2.1: checkArtifactFreshness compares artifact vs source mtimes
 * AC2.2: Missing artifact returns { stale: true, artifactMtime: null }
 * AC2.3: ARTIFACT_SOURCE_DIRS maps monorepo artifacts to source dirs
 */

import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Recursively find the most recently modified file in a directory (AC1.1).
 * Excludes node_modules and .git directories (AC1.2).
 * Uses a visited Set with realpathSync to detect and skip symlink loops (AC1.3).
 *
 * @param {string} dirPath - Absolute path to the directory
 * @returns {{ path: string, mtime: Date } | null} Newest file info or null if empty/missing
 */
export const getNewestFileInDir = (dirPath) => {
  if (!existsSync(dirPath)) {
    return null;
  }

  let newest = null;
  const visited = new Set();

  const walk = (currentDir) => {
    // AC1.3: Resolve symlinks and detect loops
    let realDir;
    try {
      realDir = realpathSync(currentDir);
    } catch {
      return;
    }
    if (visited.has(realDir)) return;
    visited.add(realDir);

    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      // AC1.2: Skip node_modules and .git
      if (entry.name === 'node_modules' || entry.name === '.git') {
        continue;
      }

      const fullPath = join(currentDir, entry.name);
      let fileStat;
      try {
        fileStat = statSync(fullPath);
      } catch {
        continue;
      }

      if (fileStat.isDirectory()) {
        walk(fullPath);
      } else {
        if (!newest || fileStat.mtime > newest.mtime) {
          newest = { path: fullPath, mtime: fileStat.mtime };
        }
      }
    }
  };

  walk(dirPath);
  return newest;
};

/**
 * Format a millisecond delta into human-readable form (AC1.4).
 *
 * @param {number} deltaMs - Difference in milliseconds
 * @returns {string} e.g., "23h 15m", "2d 5h", "45m", "30s"
 */
export const formatTimeDelta = (deltaMs) => {
  if (deltaMs <= 0) return '0s';
  const totalSeconds = Math.floor(deltaMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
};

/**
 * Format a Date as a human-readable local timestamp string (AC1.5).
 *
 * @param {Date} date
 * @returns {string} e.g., "2026-02-08 10:00:00"
 */
export const formatTimestamp = (date) => {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
};

/**
 * Compare artifact mtime against the newest source file mtime (AC2.1).
 * This is a NEW function (not ported from the reference -- the reference
 * has this logic inline in cdk.mjs).
 *
 * @param {string} artifactPath - Absolute path to the built artifact
 * @param {string[]} sourceDirs - Array of source directory paths to check
 * @param {number} [thresholdMs=0] - Optional staleness threshold in ms
 * @returns {{ stale: boolean, artifactMtime: Date|null, newestSourceMtime: Date|null, delta: number, newestSourcePath: string|null }}
 */
export const checkArtifactFreshness = (artifactPath, sourceDirs, thresholdMs = 0) => {
  // AC2.2: Missing artifact is treated as stale
  if (!existsSync(artifactPath)) {
    return {
      stale: true,
      artifactMtime: null,
      newestSourceMtime: null,
      delta: 0,
      newestSourcePath: null,
    };
  }

  let artifactMtime;
  try {
    artifactMtime = statSync(artifactPath).mtime;
  } catch {
    return {
      stale: true,
      artifactMtime: null,
      newestSourceMtime: null,
      delta: 0,
      newestSourcePath: null,
    };
  }

  let newestSourceMtime = null;
  let newestSourcePath = null;

  for (const sourceDir of sourceDirs) {
    const result = getNewestFileInDir(sourceDir);
    if (result && (!newestSourceMtime || result.mtime > newestSourceMtime)) {
      newestSourceMtime = result.mtime;
      newestSourcePath = result.path;
    }
  }

  // If no source files found, artifact is considered fresh
  if (!newestSourceMtime) {
    return {
      stale: false,
      artifactMtime,
      newestSourceMtime: null,
      delta: 0,
      newestSourcePath: null,
    };
  }

  const delta = newestSourceMtime.getTime() - artifactMtime.getTime();
  const stale = delta > thresholdMs;

  return {
    stale,
    artifactMtime,
    newestSourceMtime,
    delta,
    newestSourcePath,
  };
};

/**
 * Monorepo artifact-to-source directory mappings (AC2.3).
 * Maps each built artifact (relative to dist/) to the source directories
 * that contribute to it.
 *
 * @type {Record<string, string[]>}
 */
export const ARTIFACT_SOURCE_DIRS = {
  'lambdas/api/lambda.zip': [
    'apps/node-server/src',
    'packages/core/backend-core/src',
  ],
  'lambdas/analytics/analytics-processor-lambda.zip': [
    'apps/analytics-lambda/src',
    'packages/core/backend-core/src',
  ],
};
