#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';

import { resolveGitRoots, syncEnvKeys } from './sync-worktree-env-keys.mjs';

const USAGE = `Usage: node agents/scripts/manage-worktrees.mjs add --path <path> [options]

Creates a git worktree and syncs .env.keys into it.

Options
  -p, --path <path>     Path for the worktree (required)
  -b, --branch <name>   Create a new branch for the worktree
  -r, --ref <ref>       Branch/commit to check out (default: HEAD when creating)
  -f, --force           Pass --force to git worktree add
  -h, --help            Show this help message
`;

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === '-h' || command === '--help') {
  console.log(USAGE.trimEnd());
  process.exit(0);
}

if (command !== 'add') {
  console.error(`Unknown command: ${command}`);
  console.error(USAGE.trimEnd());
  process.exit(1);
}

const options = {
  path: null,
  branch: null,
  ref: null,
  force: false,
};

const popValue = (idx, flag) => {
  if (idx + 1 >= args.length) {
    console.error(`Missing value after "${flag}"`);
    console.error(USAGE.trimEnd());
    process.exit(1);
  }
  return args[idx + 1];
};

for (let index = 1; index < args.length; index += 1) {
  const token = args[index];
  switch (token) {
    case '-h':
    case '--help':
      console.log(USAGE.trimEnd());
      process.exit(0);
    case '-p':
    case '--path':
      options.path = popValue(index, token);
      index += 1;
      break;
    case '-b':
    case '--branch':
      options.branch = popValue(index, token);
      index += 1;
      break;
    case '-r':
    case '--ref':
      options.ref = popValue(index, token);
      index += 1;
      break;
    case '-f':
    case '--force':
      options.force = true;
      break;
    default:
      if (token.startsWith('-')) {
        console.error(`Unknown option: ${token}`);
        console.error(USAGE.trimEnd());
        process.exit(1);
      }
  }
}

if (!options.path) {
  console.error('Error: --path is required.');
  console.error(USAGE.trimEnd());
  process.exit(1);
}

let roots;
try {
  roots = resolveGitRoots();
} catch (error) {
  console.error(
    `Error: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

const targetRoot = resolve(roots.repoRoot, options.path);

const gitArgs = ['worktree', 'add'];
if (options.force) {
  gitArgs.push('--force');
}
if (options.branch) {
  gitArgs.push('-b', options.branch);
}
gitArgs.push(targetRoot);

if (options.ref) {
  gitArgs.push(options.ref);
} else if (options.branch) {
  gitArgs.push('HEAD');
}

const result = spawnSync('git', gitArgs, {
  cwd: roots.repoRoot,
  stdio: 'inherit',
});

if (result.error) {
  console.error(
    `Error: failed to run git worktree add: ${result.error.message}`,
  );
  process.exit(1);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

try {
  const summary = await syncEnvKeys({
    sourceRoot: roots.repoRoot,
    targetRoot,
  });

  if (summary.found === 0) {
    console.log('No .env.keys files found to sync.');
  } else {
    console.log(
      `Synced .env.keys. Found: ${summary.found}, Copied: ${summary.copied}, Skipped: ${summary.skipped}`,
    );
  }
} catch (error) {
  console.error(
    `Error: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
