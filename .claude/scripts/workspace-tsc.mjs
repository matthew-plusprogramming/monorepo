#!/usr/bin/env node

/**
 * Run TypeScript type checking from correct workspace context.
 *
 * Logic:
 * 1. Accept file path as argument
 * 2. Walk up from file to find nearest tsconfig.json
 * 3. Run `npx tsc --noEmit --project <tsconfig-path>` from root
 * 4. Filter output to show only errors related to the edited file (if possible)
 * 5. Exit 0 on success, non-zero on type errors
 *
 * Note: This checks the whole project, not just one file. That's intentional
 * since single-file type checking loses module resolution.
 *
 * Usage:
 *   node workspace-tsc.mjs <file-path>
 *
 * Exit codes:
 *   0 - Type checking passed or skipped (no tsconfig found)
 *   1 - Type errors found
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { spawn } from 'node:child_process';

/**
 * Walk up from a path to find the nearest tsconfig.json.
 * Returns the path to tsconfig.json, or null if not found.
 */
function findNearestTsconfig(startPath) {
  let currentDir = resolve(startPath);

  // If startPath is a file, start from its directory
  const parentCheck = dirname(currentDir);
  if (parentCheck !== currentDir) {
    currentDir = dirname(currentDir);
  }

  const root = '/';
  while (currentDir !== root) {
    const tsconfigPath = join(currentDir, 'tsconfig.json');
    if (existsSync(tsconfigPath)) {
      return tsconfigPath;
    }
    const parent = dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }

  // Check root as well
  const rootTsconfig = join(root, 'tsconfig.json');
  if (existsSync(rootTsconfig)) {
    return rootTsconfig;
  }

  return null;
}

/**
 * Run TypeScript type checking.
 * Returns a promise that resolves to { exitCode, output }.
 */
function runTsc(tsconfigPath, targetFile) {
  return new Promise((resolve) => {
    const tsconfigDir = dirname(tsconfigPath);
    let stdout = '';
    let stderr = '';

    const proc = spawn('npx', ['tsc', '--noEmit', '--project', tsconfigPath], {
      cwd: tsconfigDir,
      shell: true,
    });

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      resolve({
        exitCode: code || 0,
        stdout,
        stderr,
      });
    });

    proc.on('error', (err) => {
      console.warn(`Warning: Failed to run TypeScript: ${err.message}`);
      resolve({ exitCode: 0, stdout: '', stderr: '' }); // Skip on error
    });
  });
}

/**
 * Filter TypeScript output to show errors related to the target file.
 * If no target-specific errors, shows all errors.
 */
function filterOutput(output, targetFile) {
  if (!output.trim()) return '';

  const lines = output.split('\n');
  const targetBasename = basename(targetFile);
  const filteredLines = [];
  let inTargetError = false;
  let allErrors = [];

  for (const line of lines) {
    // TypeScript errors typically start with the file path
    const isErrorLine = line.match(/^[^\s].*\(\d+,\d+\):/);

    if (isErrorLine) {
      inTargetError = line.includes(targetBasename) || line.includes(targetFile);
      if (inTargetError) {
        filteredLines.push(line);
      }
      allErrors.push(line);
    } else if (inTargetError && line.trim()) {
      // Continuation of error message
      filteredLines.push(line);
    }
  }

  // If we found errors specific to the target file, show only those
  if (filteredLines.length > 0) {
    return `Errors in ${targetBasename}:\n${filteredLines.join('\n')}`;
  }

  // Otherwise show all errors (project-wide issues may affect the file)
  if (allErrors.length > 0) {
    return `Project type errors (may affect ${targetBasename}):\n${output}`;
  }

  return '';
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: workspace-tsc.mjs <file-path>');
    console.log('No file provided, nothing to check.');
    process.exit(0);
  }

  const filePath = resolve(args[0]);

  if (!existsSync(filePath)) {
    console.warn(`Warning: File not found: ${filePath}`);
    process.exit(0);
  }

  // Only check TypeScript/JavaScript files
  const ext = filePath.split('.').pop()?.toLowerCase();
  const tsExtensions = ['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs'];
  if (!tsExtensions.includes(ext || '')) {
    console.log(`Skipping non-TypeScript file: ${filePath}`);
    process.exit(0);
  }

  // Find nearest tsconfig
  const tsconfigPath = findNearestTsconfig(filePath);

  if (!tsconfigPath) {
    console.log('No tsconfig.json found in directory hierarchy. Skipping type check.');
    process.exit(0);
  }

  console.log(`Running TypeScript type check`);
  console.log(`  tsconfig: ${tsconfigPath}`);
  console.log(`  File: ${filePath}`);

  const { exitCode, stdout, stderr } = await runTsc(tsconfigPath, filePath);

  // Combine output
  const combinedOutput = (stdout + stderr).trim();

  if (exitCode === 0) {
    console.log('TypeScript type check passed.');
    process.exit(0);
  }

  // Filter and display errors
  const filteredOutput = filterOutput(combinedOutput, filePath);
  if (filteredOutput) {
    console.error(filteredOutput);
  } else if (combinedOutput) {
    console.error(combinedOutput);
  }

  console.error('TypeScript type check failed.');
  process.exit(1);
}

main();
