#!/usr/bin/env node

/**
 * Consumer-local hash verifier for synced MetaClaude artifacts.
 *
 * Author checkouts use compute-hashes.mjs against the full registry. Consumer
 * checkouts intentionally do not receive that registry, so this CLI verifies
 * exact-sync artifacts against the consumer-local sync lock instead.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  emitComputeHashesAuditEntry,
  FALLBACK_LABELS,
} from './lib/compute-hashes-lock.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const VERIFY_FLAG = '--verify';
const LOCKS_RELATIVE_DIR = '.claude/locks';
const EXIT_OK = 0;
const EXIT_DRIFT = 1;
const EXIT_STRUCTURAL = 2;

const LOCAL_OWNED_POLICIES = new Set([
  'agent-assisted',
  'never-overwrite',
  'never-sync',
]);

function shortHash(buffer) {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 8);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function isPathInsideRoot(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function inferProjectName(projectRoot) {
  const packageJsonPath = join(projectRoot, 'package.json');
  if (existsSync(packageJsonPath)) {
    try {
      const packageJson = readJson(packageJsonPath);
      if (typeof packageJson.name === 'string' && packageJson.name.trim()) {
        return packageJson.name.trim();
      }
    } catch {
      // Fall back to directory name below.
    }
  }
  return basename(projectRoot);
}

export function resolveProjectRoot(options = {}) {
  if (options.projectRoot) return resolve(options.projectRoot);
  if (process.env.CLAUDE_PROJECT_DIR) {
    return resolve(process.env.CLAUDE_PROJECT_DIR);
  }
  return resolve(__dirname, '../..');
}

export function resolveLockPath(projectRoot, options = {}) {
  if (options.lockPath) {
    return isAbsolute(options.lockPath)
      ? options.lockPath
      : resolve(projectRoot, options.lockPath);
  }

  const locksDir = join(projectRoot, LOCKS_RELATIVE_DIR);
  if (!existsSync(locksDir)) {
    return {
      error: `No consumer lock directory found at ${LOCKS_RELATIVE_DIR}`,
    };
  }

  const projectName = options.projectName || inferProjectName(projectRoot);
  const namedLock = join(locksDir, `${projectName}.lock.json`);
  if (existsSync(namedLock)) return namedLock;

  const lockFiles = readdirSync(locksDir)
    .filter((entry) => entry.endsWith('.lock.json'))
    .sort();

  if (lockFiles.length === 1) return join(locksDir, lockFiles[0]);
  if (lockFiles.length === 0) {
    return { error: `No *.lock.json files found at ${LOCKS_RELATIVE_DIR}` };
  }

  return {
    error:
      `Multiple consumer lock files found at ${LOCKS_RELATIVE_DIR}; ` +
      'pass --project=<name> or --lock=<path>',
  };
}

export function shouldVerifyLockEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (!entry.hash) return false;
  if (entry.sync === false) return false;
  if (entry.sync_policy && LOCAL_OWNED_POLICIES.has(entry.sync_policy)) {
    return false;
  }
  if (entry.merge_strategy) return false;
  return true;
}

export function verifyConsumerLock(options = {}) {
  const projectRoot = resolveProjectRoot(options);
  const resolvedLockPath = resolveLockPath(projectRoot, options);
  if (resolvedLockPath && typeof resolvedLockPath === 'object') {
    return {
      ok: false,
      structuralError: true,
      projectRoot,
      lockPath: null,
      checked: 0,
      skipped: 0,
      issues: [{ type: 'lock-not-found', message: resolvedLockPath.error }],
    };
  }

  let lock;
  try {
    lock = readJson(resolvedLockPath);
  } catch (err) {
    return {
      ok: false,
      structuralError: true,
      projectRoot,
      lockPath: resolvedLockPath,
      checked: 0,
      skipped: 0,
      issues: [
        {
          type: 'lock-invalid-json',
          message: err?.message || 'Failed to parse consumer lock JSON',
        },
      ],
    };
  }

  const installed = lock?.installed;
  if (!installed || typeof installed !== 'object') {
    return {
      ok: false,
      structuralError: true,
      projectRoot,
      lockPath: resolvedLockPath,
      checked: 0,
      skipped: 0,
      issues: [
        {
          type: 'lock-missing-installed',
          message: 'Consumer lock is missing installed artifact entries',
        },
      ],
    };
  }

  const issues = [];
  let checked = 0;
  let skipped = 0;

  for (const [artifactId, entry] of Object.entries(installed).sort()) {
    if (!shouldVerifyLockEntry(entry)) {
      skipped++;
      continue;
    }

    const targetPath = entry.target_path || entry.targetPath || entry.path;
    if (!targetPath || typeof targetPath !== 'string') {
      checked++;
      issues.push({
        type: 'missing-target-path',
        artifactId,
        message: 'Lock entry has no target path',
      });
      continue;
    }

    const absoluteTarget = resolve(projectRoot, targetPath);
    if (!isPathInsideRoot(projectRoot, absoluteTarget)) {
      checked++;
      issues.push({
        type: 'target-path-escape',
        artifactId,
        targetPath,
        message: 'Lock target path resolves outside the project root',
      });
      continue;
    }

    if (!existsSync(absoluteTarget)) {
      checked++;
      issues.push({
        type: 'missing-file',
        artifactId,
        targetPath,
        expected: entry.hash,
        message: 'Locked artifact is missing from the consumer checkout',
      });
      continue;
    }

    const actual = shortHash(readFileSync(absoluteTarget));
    checked++;
    if (actual !== entry.hash) {
      issues.push({
        type: 'hash-mismatch',
        artifactId,
        targetPath,
        expected: entry.hash,
        actual,
        message: 'Locked artifact hash does not match the consumer file',
      });
    }
  }

  if (checked === 0 && skipped === 0) {
    issues.push({
      type: 'lock-empty',
      message: 'Consumer lock has no installed artifact entries',
    });
  }

  return {
    ok: issues.length === 0,
    structuralError: checked === 0 && skipped === 0,
    projectRoot,
    lockPath: resolvedLockPath,
    checked,
    skipped,
    issues,
  };
}

function parseArgs(args) {
  const options = {};
  for (const arg of args) {
    if (arg === VERIFY_FLAG) {
      options.verify = true;
    } else if (arg === '--no-audit') {
      options.noAudit = true;
    } else if (arg.startsWith('--root=')) {
      options.projectRoot = arg.slice('--root='.length);
    } else if (arg.startsWith('--lock=')) {
      options.lockPath = arg.slice('--lock='.length);
    } else if (arg.startsWith('--project=')) {
      options.projectName = arg.slice('--project='.length);
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      options.unknown = arg;
    }
  }
  return options;
}

function printHelp(stdout) {
  stdout.write(
    [
      'Usage: node .claude/scripts/consumer-hash-verify.mjs --verify [options]',
      '',
      'Options:',
      '  --root=<path>     Project root override',
      '  --lock=<path>     Consumer lock path override',
      '  --project=<name>  Consumer lock name override',
      '  --no-audit        Skip compute_hashes audit emission',
      '',
    ].join('\n'),
  );
}

function writeResult(result, io) {
  const { stdout, stderr } = io;
  if (result.ok) {
    stdout.write(
      `Consumer hash verification PASSED (${result.checked} checked, ${result.skipped} skipped)\n`,
    );
    return;
  }

  stderr.write('Consumer hash verification FAILED\n');
  if (result.lockPath) stderr.write(`Lock: ${result.lockPath}\n`);
  for (const issue of result.issues) {
    const location = issue.artifactId ? `${issue.artifactId}: ` : '';
    const expected = issue.expected ? ` expected=${issue.expected}` : '';
    const actual = issue.actual ? ` actual=${issue.actual}` : '';
    const target = issue.targetPath ? ` path=${issue.targetPath}` : '';
    stderr.write(
      `- ${location}${issue.type}${target}${expected}${actual}: ${issue.message}\n`,
    );
  }
}

function emitAudit(result, exitCode) {
  emitComputeHashesAuditEntry({
    projectRoot: result.projectRoot,
    spec_group_id: null,
    hashes_count: result.checked,
    drift_detected: exitCode !== EXIT_OK,
    exit_code: exitCode,
    lock_wait_ms: 0,
    fallback_applied: FALLBACK_LABELS.NONE,
  });
}

export function runCli(args = process.argv.slice(2), io = process) {
  const options = parseArgs(args);
  if (options.help) {
    printHelp(io.stdout);
    return EXIT_OK;
  }
  if (options.unknown) {
    io.stderr.write(`Unknown argument: ${options.unknown}\n`);
    return EXIT_STRUCTURAL;
  }
  if (!options.verify) {
    io.stderr.write(`Missing required ${VERIFY_FLAG} flag\n`);
    return EXIT_STRUCTURAL;
  }

  const result = verifyConsumerLock(options);
  const exitCode = result.ok
    ? EXIT_OK
    : result.structuralError
      ? EXIT_STRUCTURAL
      : EXIT_DRIFT;
  writeResult(result, io);
  if (!options.noAudit) {
    emitAudit(result, exitCode);
  }
  return exitCode;
}

if (resolve(process.argv[1] || '') === __filename) {
  process.exit(runCli());
}
