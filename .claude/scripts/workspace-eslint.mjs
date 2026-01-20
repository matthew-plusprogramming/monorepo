#!/usr/bin/env node

/**
 * Run ESLint from correct workspace context in monorepos.
 *
 * Logic:
 * 1. Accept file path as argument
 * 2. Walk up from file to find nearest package.json (workspace root)
 * 3. Calculate relative path from workspace root to file
 * 4. Run `npx eslint --quiet <relative-path>` from workspace directory
 * 5. Exit 0 on success, non-zero on lint errors
 *
 * Edge cases:
 * - File is in root (no workspace) - run from root
 * - No package.json found - warn and skip
 * - ESLint not available in workspace - warn and skip
 *
 * Usage:
 *   node workspace-eslint.mjs <file-path>
 *
 * Exit codes:
 *   0 - Lint passed or skipped (no ESLint available)
 *   1 - Lint errors found
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';

/**
 * Walk up from a path to find the nearest package.json.
 * Returns the directory containing package.json, or null if not found.
 */
function findNearestPackageJson(startPath) {
  let currentDir = resolve(startPath);

  // If startPath is a file, start from its directory
  if (existsSync(currentDir) && !existsSync(join(currentDir, 'package.json'))) {
    // Check if it's a file by trying parent
    const parentCheck = dirname(currentDir);
    if (parentCheck !== currentDir) {
      currentDir = dirname(currentDir);
    }
  }

  const root = '/';
  while (currentDir !== root) {
    const packageJsonPath = join(currentDir, 'package.json');
    if (existsSync(packageJsonPath)) {
      return currentDir;
    }
    const parent = dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }

  // Check root as well
  if (existsSync(join(root, 'package.json'))) {
    return root;
  }

  return null;
}

/**
 * Check if ESLint is available in the workspace.
 */
function hasEslintConfig(workspaceDir) {
  const eslintConfigs = [
    '.eslintrc',
    '.eslintrc.js',
    '.eslintrc.cjs',
    '.eslintrc.json',
    '.eslintrc.yaml',
    '.eslintrc.yml',
    'eslint.config.js',
    'eslint.config.mjs',
    'eslint.config.cjs',
  ];

  for (const config of eslintConfigs) {
    if (existsSync(join(workspaceDir, config))) {
      return true;
    }
  }

  // Check package.json for eslintConfig
  const packageJsonPath = join(workspaceDir, 'package.json');
  if (existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      if (packageJson.eslintConfig) {
        return true;
      }
    } catch {
      // Ignore parse errors
    }
  }

  return false;
}

/**
 * Run ESLint on the file from the workspace directory.
 * Returns a promise that resolves to the exit code.
 */
function runEslint(workspaceDir, relativePath) {
  return new Promise((resolve) => {
    const proc = spawn('npx', ['eslint', '--quiet', relativePath], {
      cwd: workspaceDir,
      stdio: 'inherit',
      shell: true,
    });

    proc.on('close', (code) => {
      resolve(code || 0);
    });

    proc.on('error', (err) => {
      console.warn(`Warning: Failed to run ESLint: ${err.message}`);
      resolve(0); // Skip on error
    });
  });
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: workspace-eslint.mjs <file-path>');
    console.log('No file provided, nothing to lint.');
    process.exit(0);
  }

  const filePath = resolve(args[0]);

  if (!existsSync(filePath)) {
    console.warn(`Warning: File not found: ${filePath}`);
    process.exit(0);
  }

  // Find workspace root
  const workspaceDir = findNearestPackageJson(filePath);

  if (!workspaceDir) {
    console.warn('Warning: No package.json found in directory hierarchy. Skipping ESLint.');
    process.exit(0);
  }

  // Check if ESLint is configured
  if (!hasEslintConfig(workspaceDir)) {
    console.log(`No ESLint configuration found in ${workspaceDir}. Skipping.`);
    process.exit(0);
  }

  // Calculate relative path from workspace to file
  const relativePath = relative(workspaceDir, filePath);

  console.log(`Running ESLint from ${workspaceDir}`);
  console.log(`  File: ${relativePath}`);

  const exitCode = await runEslint(workspaceDir, relativePath);

  if (exitCode === 0) {
    console.log('ESLint passed.');
  } else {
    console.error('ESLint found errors.');
  }

  process.exit(exitCode);
}

main();
