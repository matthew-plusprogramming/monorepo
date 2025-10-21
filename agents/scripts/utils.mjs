import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const root = process.cwd();

export const listGitTrackedFiles = () => {
  try {
    return execSync('git ls-files', { cwd: root })
      .toString()
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch (error) {
    console.error('❌ Failed to run "git ls-files". Ensure the script runs inside the repository.');
    console.error(error.message);
    process.exit(1);
  }
};

export const isTsFile = (file) =>
  /\.(cts|mts|tsx|ts)$/i.test(file) && !file.endsWith('.d.ts');

export const isTestFile = (file) =>
  file.includes('__tests__/') ||
  /\.test\.(?:cts|mts|tsx|ts)$/i.test(file) ||
  /\.spec\.(?:cts|mts|tsx|ts)$/i.test(file);

export const readFile = (relativePath) =>
  readFileSync(resolve(root, relativePath), 'utf8');

export const splitLines = (text) => text.split(/\r?\n/);

export const formatFinding = (file, line, message) =>
  `${file}:${line} — ${message}`;
