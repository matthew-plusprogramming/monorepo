#!/usr/bin/env node

/**
 * Verify that artifacts are registered in metaclaude-registry.json
 * and included in appropriate bundles.
 *
 * This script is read-only -- it does not modify any files or access the network.
 * Convention-enforced: no mutation, no network.
 *
 * Used by the `bundle-inclusion-verify` completion gate.
 *
 * Usage:
 *   node verify-bundles.mjs [artifact-path1] [artifact-path2] ...
 *
 *   If no artifact paths are provided, the script reads modified files from
 *   `git diff --name-only HEAD~1` as a fallback.
 *
 * Exit codes:
 *   0 - All artifacts are registered and included in bundles
 *   1 - One or more artifacts are missing from registry or bundles
 *   2 - Script error (registry not found, parse error, etc.)
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { execSync } from 'node:child_process';

// Artifact path patterns that should be tracked in the registry
const TRACKED_PATTERNS = [
  /^\.claude\/agents\/.*\.md$/,
  /^\.claude\/skills\/.*\/SKILL\.md$/,
  /^\.claude\/templates\/.*\.md$/,
  /^\.claude\/scripts\/.*\.mjs$/,
  /^\.claude\/memory-bank\/.*\.md$/,
  /^\.claude\/schemas\/.*\.json$/,
  /^\.claude\/docs\/.*\.md$/,
  /^\.claude\/config\/.*\.(yaml|json)$/,
];

function isTrackedArtifact(filePath) {
  const normalized = filePath.startsWith('.claude/')
    ? filePath
    : `.claude/${filePath}`;
  return TRACKED_PATTERNS.some((pattern) => pattern.test(normalized));
}

function findArtifactInRegistry(registry, filePath) {
  const normalized = filePath.startsWith('./')
    ? filePath.slice(2)
    : filePath;

  for (const [category, artifacts] of Object.entries(registry.artifacts || {})) {
    for (const [artifactKey, artifact] of Object.entries(artifacts)) {
      if (artifact.path === normalized) {
        return { key: artifactKey, category, artifact };
      }
    }
  }
  return null;
}

function getEffectiveBundleIncludes(registry, bundleName, visited = new Set()) {
  if (visited.has(bundleName)) return new Set();
  visited.add(bundleName);

  const bundle = (registry.bundles || {})[bundleName];
  if (!bundle) return new Set();

  const includes = new Set(bundle.includes || []);

  // Inherit from parent bundle
  if (bundle.extends) {
    const parentIncludes = getEffectiveBundleIncludes(registry, bundle.extends, visited);
    for (const item of parentIncludes) {
      includes.add(item);
    }
  }

  return includes;
}

function main() {
  const registryPath = resolve('.claude/metaclaude-registry.json');

  if (!existsSync(registryPath)) {
    console.error('ERROR: Registry not found at .claude/metaclaude-registry.json');
    process.exit(2);
  }

  let registry;
  try {
    registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
  } catch (err) {
    console.error(`ERROR: Failed to parse registry: ${err.message}`);
    process.exit(2);
  }

  // Get artifact paths from args or git diff
  let artifactPaths = process.argv.slice(2);

  if (artifactPaths.length === 0) {
    try {
      const gitDiff = execSync('git diff --name-only HEAD~1 2>/dev/null', {
        encoding: 'utf-8',
      }).trim();
      artifactPaths = gitDiff
        .split('\n')
        .filter((line) => line.trim().length > 0);
    } catch {
      // If git diff fails, no files to check
      console.log('No artifact paths provided and git diff unavailable. Nothing to verify.');
      process.exit(0);
    }
  }

  // Filter to only tracked artifact patterns
  const trackedFiles = artifactPaths.filter(isTrackedArtifact);

  if (trackedFiles.length === 0) {
    console.log('No tracked artifacts in modified files. Nothing to verify.');
    process.exit(0);
  }

  const issues = [];

  for (const filePath of trackedFiles) {
    const normalized = filePath.startsWith('./')
      ? filePath.slice(2)
      : filePath;

    // Check 1: Is the artifact registered?
    const found = findArtifactInRegistry(registry, normalized);
    if (!found) {
      issues.push({
        file: normalized,
        type: 'not-registered',
        message: `Artifact "${normalized}" is not registered in metaclaude-registry.json`,
      });
      continue;
    }

    // Check 2: Is the artifact included in at least one bundle?
    const categoryKey = found.category;
    const artifactKey = `${categoryKey}/${found.key}`;
    const fullWorkflowIncludes = getEffectiveBundleIncludes(registry, 'full-workflow');

    if (!fullWorkflowIncludes.has(artifactKey)) {
      issues.push({
        file: normalized,
        type: 'not-in-bundle',
        message: `Artifact "${artifactKey}" is registered but not included in any bundle (checked full-workflow inheritance chain)`,
      });
    }
  }

  if (issues.length === 0) {
    console.log(`Verified ${trackedFiles.length} tracked artifact(s): all registered and bundled.`);
    process.exit(0);
  }

  console.error(`FAILED: ${issues.length} artifact issue(s) found:\n`);
  for (const issue of issues) {
    console.error(`  [${issue.type}] ${issue.message}`);
  }
  console.error('\nFix: Register missing artifacts in .claude/metaclaude-registry.json and add to appropriate bundle includes.');
  process.exit(1);
}

main();
