#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const USAGE = `Usage: node agents/scripts/sync-worktree-env-keys.mjs [options]

Copies .env.keys files from the primary repo into a worktree, preserving relative
paths (use --overwrite to replace existing files).

Options
  --target <path>   Target worktree root (defaults to git worktree root)
  --source <path>   Source repo root (defaults to git common dir parent)
  --overwrite      Replace existing .env.keys files in the target
  --dry-run         Print planned copies without writing files
  --force           Allow syncing even if target is not under .worktrees
  -h, --help        Show this help message
`;

const parseArgs = (argv) => {
  const args = argv.slice(2);
  const options = {
    target: null,
    source: null,
    dryRun: false,
    overwrite: false,
    force: false,
    help: false,
  };

  const popValue = (idx, flag) => {
    if (idx + 1 >= args.length) {
      console.error(`Missing value after "${flag}"`);
      console.error(USAGE.trimEnd());
      process.exit(1);
    }
    return args[idx + 1];
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    switch (token) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--overwrite':
        options.overwrite = true;
        break;
      case '--force':
        options.force = true;
        break;
      case '--target':
        options.target = popValue(index, token);
        index += 1;
        break;
      case '--source':
        options.source = popValue(index, token);
        index += 1;
        break;
      default:
        if (token.startsWith('-')) {
          console.error(`Unknown option: ${token}`);
          console.error(USAGE.trimEnd());
          process.exit(1);
        }
    }
  }

  return options;
};

export const isWorktreePath = (pathValue) =>
  pathValue.split(sep).includes('.worktrees');

const runGit = (command) => {
  try {
    return execSync(`git ${command}`, { encoding: 'utf8' }).trim();
  } catch (error) {
    throw new Error(
      `Failed to run "git ${command}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export const resolveGitRoots = () => {
  const worktreeRoot = runGit('rev-parse --show-toplevel');
  const commonDir = runGit('rev-parse --git-common-dir');
  const commonDirAbs = resolve(worktreeRoot, commonDir);
  const repoRoot = resolve(commonDirAbs, '..');

  return { worktreeRoot, repoRoot, commonDir: commonDirAbs };
};

const DEFAULT_IGNORED_DIRS = new Set([
  '.git',
  '.worktrees',
  '.turbo',
  '.next',
  'cdktf.out',
  'dist',
  'build',
  'node_modules',
]);

const toPosix = (value) => value.replace(/\\/g, '/');

const collectEnvKeys = async (rootDir) => {
  const results = [];

  const walk = async (currentDir) => {
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      console.warn(
        `Warning: failed to read directory "${currentDir}": ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }

      const fullPath = resolve(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (DEFAULT_IGNORED_DIRS.has(entry.name)) {
          continue;
        }
        await walk(fullPath);
        continue;
      }

      if (entry.isFile() && entry.name === '.env.keys') {
        results.push(fullPath);
      }
    }
  };

  await walk(rootDir);
  return results;
};

export const syncEnvKeys = async ({
  sourceRoot,
  targetRoot,
  dryRun = false,
  overwrite = false,
}) => {
  const resolvedSource = resolve(sourceRoot);
  const resolvedTarget = resolve(targetRoot);

  const targetStats = await fs.stat(resolvedTarget);
  if (!targetStats.isDirectory()) {
    throw new Error(`Target root is not a directory: ${resolvedTarget}`);
  }

  const envKeyFiles = await collectEnvKeys(resolvedSource);

  if (envKeyFiles.length === 0) {
    return {
      sourceRoot: resolvedSource,
      targetRoot: resolvedTarget,
      found: 0,
      copied: 0,
      overwritten: 0,
      skipped: 0,
      dryRun,
    };
  }

  let copied = 0;
  let overwritten = 0;
  let skipped = 0;

  for (const sourcePath of envKeyFiles) {
    const relativePath = relative(resolvedSource, sourcePath);
    const targetPath = resolve(resolvedTarget, relativePath);

    const targetExists = existsSync(targetPath);
    if (targetExists && !overwrite) {
      skipped += 1;
      continue;
    }

    if (!dryRun) {
      await fs.mkdir(dirname(targetPath), { recursive: true });
      await fs.copyFile(sourcePath, targetPath);
    }

    if (targetExists) {
      overwritten += 1;
    } else {
      copied += 1;
    }
  }

  return {
    sourceRoot: resolvedSource,
    targetRoot: resolvedTarget,
    found: envKeyFiles.length,
    copied,
    overwritten,
    skipped,
    dryRun,
  };
};

const main = async () => {
  const options = parseArgs(process.argv);

  if (options.help) {
    console.log(USAGE.trimEnd());
    process.exit(0);
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

  const targetRoot = options.target
    ? resolve(process.cwd(), options.target)
    : roots.worktreeRoot;
  const sourceRoot = options.source
    ? resolve(process.cwd(), options.source)
    : roots.repoRoot;

  if (!options.force && !isWorktreePath(targetRoot)) {
    console.log(
      'Target path is not under .worktrees. Use --force to sync anyway.',
    );
    process.exit(0);
  }

  let summary;
  try {
    summary = await syncEnvKeys({
      sourceRoot,
      targetRoot,
      dryRun: options.dryRun,
      overwrite: options.overwrite,
    });
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  if (summary.found === 0) {
    console.log(`No .env.keys files found under ${toPosix(sourceRoot)}.`);
    process.exit(0);
  }

  const action = summary.dryRun ? 'Planned' : 'Synced';
  console.log(
    `${action} .env.keys from ${toPosix(sourceRoot)} to ${toPosix(targetRoot)}.`,
  );
  console.log(
    `Found: ${summary.found}, Copied: ${summary.copied}, Overwritten: ${summary.overwritten}, Skipped: ${summary.skipped}`,
  );
};

const isDirectRun = (() => {
  if (!process.argv[1]) {
    return false;
  }
  const scriptPath = resolve(process.argv[1]);
  return import.meta.url === pathToFileURL(scriptPath).href;
})();

if (isDirectRun) {
  main().catch((error) => {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
