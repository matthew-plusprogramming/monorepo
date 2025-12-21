#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const USAGE = `Usage: node agents/scripts/create-worktree.mjs --name "<worktree-name>" [options]

Create a per-workstream git worktree under .worktrees/.

Options
  --name "<worktree-name>"   Required slug used for the worktree directory
  --branch "<branch-name>"   Optional branch name (default: worktree/<name>)
  --base "<git-ref>"         Optional base ref when creating a new branch (default: HEAD)
  -h, --help                 Show this help message
`;

const args = process.argv.slice(2);

if (args.includes('-h') || args.includes('--help')) {
  console.log(USAGE.trimEnd());
  process.exit(0);
}

const options = {
  base: 'HEAD',
  branch: null,
  name: null,
};

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];

  if (!arg.startsWith('--')) {
    console.error(`ERROR: Unexpected argument: ${arg}`);
    process.exit(1);
  }

  const [flag, inlineValue] = arg.split('=');
  const nextValue = args[index + 1];
  const value = inlineValue ?? nextValue;

  switch (flag) {
    case '--name': {
      if (!value) {
        console.error('ERROR: Missing value for --name');
        process.exit(1);
      }

      if (!/^[a-z0-9-]+$/.test(value)) {
        console.error('ERROR: --name must use lowercase letters, numbers, or dashes only');
        process.exit(1);
      }

      options.name = value;
      if (inlineValue === undefined) index += 1;
      break;
    }
    case '--branch': {
      if (!value) {
        console.error('ERROR: Missing value for --branch');
        process.exit(1);
      }

      options.branch = value;
      if (inlineValue === undefined) index += 1;
      break;
    }
    case '--base': {
      if (!value) {
        console.error('ERROR: Missing value for --base');
        process.exit(1);
      }

      options.base = value;
      if (inlineValue === undefined) index += 1;
      break;
    }
    default:
      console.error(`ERROR: Unknown option: ${flag}`);
      process.exit(1);
  }
}

if (!options.name) {
  console.error('ERROR: --name is required');
  process.exit(1);
}

const runGit = (argsList, { stdio = 'pipe' } = {}) =>
  execFileSync('git', argsList, {
    cwd: process.cwd(),
    stdio,
    encoding: stdio === 'pipe' ? 'utf8' : undefined,
  });

const getRepoRoot = () => {
  try {
    return runGit(['rev-parse', '--show-toplevel']).trim();
  } catch (error) {
    console.error('ERROR: This script must run inside a git repository.');
    process.exit(1);
  }
};

const parseWorktrees = (text) => {
  const entries = [];
  let current = null;

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;

    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { path: line.slice('worktree '.length).trim(), branch: null };
      continue;
    }

    if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).trim();
    }
  }

  if (current) entries.push(current);
  return entries;
};

const main = async () => {
  const root = getRepoRoot();
  const worktreesDir = resolve(root, '.worktrees');
  const worktreePath = resolve(worktreesDir, options.name);
  const branch = options.branch ?? `worktree/${options.name}`;
  const branchRef = `refs/heads/${branch}`;

  const worktreeList = runGit(['worktree', 'list', '--porcelain']);
  const worktrees = parseWorktrees(worktreeList);
  const existingByPath = worktrees.find((entry) => entry.path === worktreePath);

  if (existingByPath) {
    console.log(`Worktree already exists at ${worktreePath}`);
    console.log(`Next: cd ${worktreePath}`);
    return;
  }

  const existingByBranch = worktrees.find((entry) => entry.branch === branchRef);
  if (existingByBranch) {
    console.error(
      `ERROR: Branch ${branch} is already checked out at ${existingByBranch.path}`,
    );
    process.exit(1);
  }

  const pathExists = await access(worktreePath)
    .then(() => true)
    .catch((error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });

  if (pathExists) {
    console.error(
      `ERROR: ${worktreePath} exists but is not registered as a git worktree.`,
    );
    process.exit(1);
  }

  await mkdir(worktreesDir, { recursive: true });

  const branchExists = (() => {
    try {
      runGit(['show-ref', '--verify', '--quiet', branchRef], { stdio: 'ignore' });
      return true;
    } catch (error) {
      return false;
    }
  })();

  if (branchExists) {
    runGit(['worktree', 'add', worktreePath, branch], { stdio: 'inherit' });
  } else {
    runGit(['worktree', 'add', '-b', branch, worktreePath, options.base], {
      stdio: 'inherit',
    });
  }

  console.log(`Worktree ready at ${worktreePath}`);
  console.log(`Next: cd ${worktreePath}`);
};

main().catch((error) => {
  console.error('ERROR: Failed to create the worktree.');
  console.error(error);
  process.exit(1);
});
