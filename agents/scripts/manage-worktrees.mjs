#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { parseFrontMatter } from './spec-utils.mjs';

const USAGE = `Usage: node agents/scripts/manage-worktrees.mjs <command> [options]

Manage orchestrator worktrees under .worktrees/ for parallel workstreams.

Commands
  ensure    Create missing worktrees for workstreams
  list      List worktrees under .worktrees/
  status    Show branch + clean/dirty status for worktrees
  remove    Remove selected worktrees
  prune     Run git worktree prune

Options
  --spec <path>              MasterSpec path to derive workstreams
  --workstreams "<a,b,c>"    Comma-separated workstream list
  --workstreams-root <path>  Directory containing workstream specs
  --branch-prefix <prefix>   Branch prefix (default: worktree/)
  --base <ref>               Base ref for new branches (default: HEAD)
  --force                    Force removal of dirty worktrees
  --dry-run                  For prune: show what would be pruned
  -h, --help                 Show this help message
`;

const args = process.argv.slice(2);

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(USAGE.trimEnd());
  process.exit(0);
}

const command = args[0];
const validCommands = new Set(['ensure', 'list', 'status', 'remove', 'prune']);

if (!validCommands.has(command)) {
  console.error(`ERROR: Unknown command "${command}".`);
  console.error(USAGE.trimEnd());
  process.exit(1);
}

const options = {
  base: 'HEAD',
  branchPrefix: 'worktree/',
  dryRun: false,
  force: false,
  spec: null,
  workstreams: null,
  workstreamsRoot: null,
};

const popValue = (index, flag) => {
  if (index + 1 >= args.length) {
    console.error(`ERROR: Missing value after "${flag}".`);
    console.error(USAGE.trimEnd());
    process.exit(1);
  }
  return args[index + 1];
};

for (let index = 1; index < args.length; index += 1) {
  const token = args[index];

  if (!token.startsWith('--')) {
    console.error(`ERROR: Unexpected argument "${token}".`);
    console.error(USAGE.trimEnd());
    process.exit(1);
  }

  switch (token) {
    case '--spec':
      options.spec = popValue(index, token);
      index += 1;
      break;
    case '--workstreams':
      options.workstreams = popValue(index, token);
      index += 1;
      break;
    case '--workstreams-root':
      options.workstreamsRoot = popValue(index, token);
      index += 1;
      break;
    case '--branch-prefix':
      options.branchPrefix = popValue(index, token);
      index += 1;
      break;
    case '--base':
      options.base = popValue(index, token);
      index += 1;
      break;
    case '--force':
      options.force = true;
      break;
    case '--dry-run':
      options.dryRun = true;
      break;
    default:
      console.error(`ERROR: Unknown option "${token}".`);
      console.error(USAGE.trimEnd());
      process.exit(1);
  }
}

const runGit = (argsList, { cwd = process.cwd(), stdio = 'pipe' } = {}) =>
  execFileSync('git', argsList, {
    cwd,
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

const normalizeBranchPrefix = (value) => {
  if (!value) {
    return '';
  }
  return value.endsWith('/') ? value : `${value}/`;
};

const parseWorktrees = (text) => {
  const entries = [];
  let current = null;

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;

    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = {
        path: line.slice('worktree '.length).trim(),
        branch: null,
        head: null,
        detached: false,
      };
      continue;
    }

    if (!current) continue;

    if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim();
      continue;
    }

    if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim();
      continue;
    }

    if (line === 'detached') {
      current.detached = true;
    }
  }

  if (current) entries.push(current);
  return entries;
};

const isUnderWorktreesDir = (targetPath, worktreesDir) =>
  resolve(targetPath) === worktreesDir ||
  resolve(targetPath).startsWith(`${worktreesDir}${sep}`);

const parseWorkstreamList = (value) =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

const normalizeWorkstreamId = (value) => value.trim();

const validateWorkstreamId = (id) => /^[a-z0-9-]+$/.test(id);

const coerceWorkstreamId = (entry) => {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object' && entry.id) return entry.id;
  return null;
};

const readFrontMatter = (path) => {
  const content = readFileSync(path, 'utf8');
  const { data, errors } = parseFrontMatter(content);
  if (errors.length > 0) {
    throw new Error(`Failed to parse front matter for ${path}: ${errors.join(' ')}`);
  }
  return data;
};

const collectWorkstreamSpecs = (rootPath) => {
  const files = [];
  const walk = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(abs);
      }
    }
  };

  walk(rootPath);
  return files;
};

const resolveWorkstreams = (repoRoot) => {
  const results = new Set();

  if (options.workstreams) {
    parseWorkstreamList(options.workstreams).forEach((entry) =>
      results.add(normalizeWorkstreamId(entry)),
    );
  }

  if (options.spec) {
    const specPath = resolve(repoRoot, options.spec);
    if (!existsSync(specPath)) {
      throw new Error(`Spec file not found: ${options.spec}`);
    }
    const data = readFrontMatter(specPath);
    const list = Array.isArray(data?.workstreams) ? data.workstreams : [];
    list
      .map((entry) => coerceWorkstreamId(entry))
      .filter(Boolean)
      .forEach((entry) => results.add(normalizeWorkstreamId(entry)));
  }

  if (options.workstreamsRoot) {
    const rootPath = resolve(repoRoot, options.workstreamsRoot);
    if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) {
      throw new Error(
        `Workstreams root not found or not a directory: ${options.workstreamsRoot}`,
      );
    }
    const specFiles = collectWorkstreamSpecs(rootPath);
    specFiles.forEach((filePath) => {
      const data = readFrontMatter(filePath);
      const id = normalizeWorkstreamId(data?.id ?? '');
      if (!id) {
        throw new Error(`Missing workstream id in ${filePath}`);
      }
      results.add(id);
    });
  }

  const list = [...results].filter(Boolean);
  if (list.length === 0) {
    throw new Error('No workstreams resolved. Provide --spec, --workstreams, or --workstreams-root.');
  }

  const invalid = list.filter((id) => !validateWorkstreamId(id));
  if (invalid.length > 0) {
    throw new Error(
      `Invalid workstream id(s): ${invalid.join(', ')} (use lowercase letters, numbers, or dashes).`,
    );
  }

  return list;
};

const formatBranchName = (branchRef) => {
  if (!branchRef) return 'detached';
  if (branchRef.startsWith('refs/heads/')) {
    return branchRef.replace('refs/heads/', '');
  }
  return branchRef;
};

const ensureWorktrees = (repoRoot) => {
  const branchPrefix = normalizeBranchPrefix(options.branchPrefix);
  const worktreesDir = resolve(repoRoot, '.worktrees');
  const allWorktrees = parseWorktrees(
    runGit(['worktree', 'list', '--porcelain'], { cwd: repoRoot }),
  );
  const workstreams = resolveWorkstreams(repoRoot);
  const created = [];
  const skipped = [];

  if (!existsSync(worktreesDir)) {
    mkdirSync(worktreesDir, { recursive: true });
  }

  workstreams.forEach((id) => {
    const worktreePath = resolve(worktreesDir, id);
    const existingByPath = allWorktrees.find(
      (entry) => resolve(entry.path) === worktreePath,
    );
    if (existingByPath) {
      skipped.push(id);
      return;
    }

    const branchName = `${branchPrefix}${id}`;
    const branchRef = `refs/heads/${branchName}`;
    const existingByBranch = allWorktrees.find(
      (entry) => entry.branch === branchRef,
    );

    if (existingByBranch) {
      throw new Error(
        `Branch ${branchName} is already checked out at ${existingByBranch.path}`,
      );
    }

    if (existsSync(worktreePath)) {
      throw new Error(
        `${worktreePath} exists but is not registered as a git worktree.`,
      );
    }

    const branchExists = (() => {
      try {
        runGit(['show-ref', '--verify', '--quiet', branchRef], {
          cwd: repoRoot,
          stdio: 'ignore',
        });
        return true;
      } catch {
        return false;
      }
    })();

    if (branchExists) {
      runGit(['worktree', 'add', worktreePath, branchName], {
        cwd: repoRoot,
        stdio: 'inherit',
      });
    } else {
      runGit(['worktree', 'add', '-b', branchName, worktreePath, options.base], {
        cwd: repoRoot,
        stdio: 'inherit',
      });
    }
    created.push(id);
  });

  console.log(
    `Worktrees ensured: ${created.length} created, ${skipped.length} existing.`,
  );
  if (created.length > 0) {
    console.log(`Created: ${created.join(', ')}`);
  }
  if (skipped.length > 0) {
    console.log(`Existing: ${skipped.join(', ')}`);
  }
};

const listWorktrees = (repoRoot) => {
  const worktreesDir = resolve(repoRoot, '.worktrees');
  const allWorktrees = parseWorktrees(
    runGit(['worktree', 'list', '--porcelain'], { cwd: repoRoot }),
  );
  const managed = allWorktrees.filter((entry) =>
    isUnderWorktreesDir(entry.path, worktreesDir),
  );

  if (managed.length === 0) {
    console.log('No worktrees under .worktrees/.');
    return;
  }

  console.log('Worktrees under .worktrees/:');
  managed.forEach((entry) => {
    const name = basename(entry.path);
    const branch = formatBranchName(entry.branch);
    console.log(`- ${name} (${branch}) ${entry.path}`);
  });
};

const statusWorktrees = (repoRoot) => {
  const worktreesDir = resolve(repoRoot, '.worktrees');
  const allWorktrees = parseWorktrees(
    runGit(['worktree', 'list', '--porcelain'], { cwd: repoRoot }),
  );
  const managed = allWorktrees.filter((entry) =>
    isUnderWorktreesDir(entry.path, worktreesDir),
  );

  if (managed.length === 0) {
    console.log('No worktrees under .worktrees/.');
    return;
  }

  console.log('Worktree status:');
  managed.forEach((entry) => {
    const name = basename(entry.path);
    const branch = formatBranchName(entry.branch);
    const statusOutput = runGit(['-C', entry.path, 'status', '--porcelain'], {
      cwd: repoRoot,
    });
    const lines = statusOutput.trim() ? statusOutput.trim().split('\n') : [];
    const dirty = lines.length > 0;
    const label = dirty ? `dirty (${lines.length})` : 'clean';
    console.log(`- ${name} (${branch}) ${label}`);
  });
};

const removeWorktrees = (repoRoot) => {
  const worktreesDir = resolve(repoRoot, '.worktrees');
  const allWorktrees = parseWorktrees(
    runGit(['worktree', 'list', '--porcelain'], { cwd: repoRoot }),
  );
  const managed = allWorktrees.filter((entry) =>
    isUnderWorktreesDir(entry.path, worktreesDir),
  );
  const workstreams = resolveWorkstreams(repoRoot);
  const managedByName = new Map(
    managed.map((entry) => [basename(entry.path), entry]),
  );
  let hadError = false;

  workstreams.forEach((id) => {
    const entry = managedByName.get(id);
    if (!entry) {
      console.warn(`WARN: No managed worktree found for ${id}`);
      return;
    }

    const statusOutput = runGit(['-C', entry.path, 'status', '--porcelain'], {
      cwd: repoRoot,
    });
    const dirty = Boolean(statusOutput.trim());
    if (dirty && !options.force) {
      console.error(
        `ERROR: Worktree ${id} has uncommitted changes. Use --force to remove.`,
      );
      hadError = true;
      return;
    }

    const argsList = ['worktree', 'remove'];
    if (options.force) argsList.push('--force');
    argsList.push(entry.path);
    runGit(argsList, { cwd: repoRoot, stdio: 'inherit' });
  });

  if (hadError) {
    process.exitCode = 1;
  }
};

const pruneWorktrees = (repoRoot) => {
  const argsList = ['worktree', 'prune'];
  if (options.dryRun) {
    argsList.push('--dry-run');
  }
  runGit(argsList, { cwd: repoRoot, stdio: 'inherit' });
};

const main = () => {
  const repoRoot = getRepoRoot();

  try {
    switch (command) {
      case 'ensure':
        ensureWorktrees(repoRoot);
        break;
      case 'list':
        listWorktrees(repoRoot);
        break;
      case 'status':
        statusWorktrees(repoRoot);
        break;
      case 'remove':
        removeWorktrees(repoRoot);
        break;
      case 'prune':
        pruneWorktrees(repoRoot);
        break;
      default:
        console.error(`ERROR: Unsupported command "${command}".`);
        process.exit(1);
    }
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  }
};

main();
