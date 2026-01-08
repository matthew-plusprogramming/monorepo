#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import process from 'node:process';

import { resolveGitRoots } from './sync-worktree-env-keys.mjs';

const USAGE = `Usage: node .claude/scripts/dotenvx-run.mjs <dotenvx args>

Runs dotenvx and emits a hint when missing private key errors occur.

Example
  node .claude/scripts/dotenvx-run.mjs run -f .env.production -- vite build --mode production
`;

const args = process.argv.slice(2);

if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
  console.log(USAGE.trimEnd());
  process.exit(0);
}

const missingKeyPattern = /MISSING_PRIVATE_KEY|DOTENV_PRIVATE_KEY/i;
let sawMissingKey = false;

const detectMissingKey = (chunk) => {
  const text = chunk.toString();
  if (missingKeyPattern.test(text)) {
    sawMissingKey = true;
  }
};

const child = spawn('dotenvx', args, {
  stdio: ['inherit', 'pipe', 'pipe'],
  env: process.env,
});

child.stdout.on('data', (chunk) => {
  detectMissingKey(chunk);
  process.stdout.write(chunk);
});

child.stderr.on('data', (chunk) => {
  detectMissingKey(chunk);
  process.stderr.write(chunk);
});

child.on('error', (error) => {
  console.error(
    `Error: failed to run dotenvx: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});

const findEnvFilePath = (argv) => {
  const flagIndex = argv.findIndex((token) => token === '-f' || token === '--file');
  if (flagIndex === -1 || flagIndex + 1 >= argv.length) {
    return null;
  }
  return argv[flagIndex + 1];
};

const resolveHintCommand = (repoRoot) => {
  const scriptPath = resolve(repoRoot, '.claude/scripts/sync-worktree-env-keys.mjs');
  const relativePath = relative(process.cwd(), scriptPath);
  if (relativePath === '') {
    return 'node .claude/scripts/sync-worktree-env-keys.mjs';
  }
  const normalized = relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
  return `node ${normalized}`;
};

const isWorktreePath = (pathValue) =>
  pathValue.split(sep).includes('.worktrees');

child.on('close', (code) => {
  if (sawMissingKey) {
    const envFile = findEnvFilePath(args);
    const envFilePath = envFile ? resolve(process.cwd(), envFile) : null;
    const envDir = envFilePath ? dirname(envFilePath) : process.cwd();
    const envKeysPath = resolve(envDir, '.env.keys');
    const hasEnvKeys = existsSync(envKeysPath);
    const inWorktree = isWorktreePath(process.cwd());

    console.error('');
    console.error('dotenvx reported missing private key(s).');

    if (!hasEnvKeys && inWorktree) {
      try {
        const { repoRoot } = resolveGitRoots();
        const command = resolveHintCommand(repoRoot);
        console.error('This looks like a worktree missing .env.keys.');
        console.error(`Run: ${command}`);
      } catch (error) {
        console.error('This looks like a worktree missing .env.keys.');
        console.error(
          'Run: node .claude/scripts/sync-worktree-env-keys.mjs',
        );
      }
    } else if (!hasEnvKeys) {
      console.error('No .env.keys file found next to the env file.');
      console.error('Add .env.keys or re-encrypt envs with your own key.');
    } else {
      console.error(
        'Verify the DOTENV_PRIVATE_KEY values in .env.keys match the encrypted env files.',
      );
    }
  }

  process.exit(code ?? 1);
});
