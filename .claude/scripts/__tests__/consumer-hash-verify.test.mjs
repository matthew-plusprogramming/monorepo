/**
 * Tests for consumer-hash-verify.mjs.
 *
 * Consumers do not ship the author registry, so the post-impl -> pre-unify
 * hash gate verifies exact-sync artifacts against the consumer-local lock.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  runCli,
  verifyConsumerLock,
} from '../consumer-hash-verify.mjs';

let tempRoot;

beforeEach(() => {
  tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'consumer-hash-verify-')));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function shortHash(content) {
  return createHash('sha256').update(content).digest('hex').slice(0, 8);
}

function writeAt(relativePath, content) {
  const absolute = join(tempRoot, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
  return absolute;
}

function writeLock(installed) {
  writeAt(
    '.claude/locks/demo.lock.json',
    JSON.stringify(
      {
        lock_version: '1.0.0',
        project: 'demo',
        installed,
      },
      null,
      2,
    ) + '\n',
  );
}

function fakeIo() {
  let stdout = '';
  let stderr = '';
  return {
    stdout: {
      write(chunk) {
        stdout += chunk;
      },
    },
    stderr: {
      write(chunk) {
        stderr += chunk;
      },
    },
    output() {
      return { stdout, stderr };
    },
  };
}

describe('consumer-hash-verify', () => {
  it('passes exact-sync artifacts and skips local-owned or merge-managed entries', () => {
    const unifier = '# Unifier\n';
    writeAt('.claude/agents/unifier.md', unifier);
    writeAt('.claude/settings.json', '{"local":true}\n');
    writeAt('.claude/memory-bank/project.brief.md', '# Local project\n');
    writeLock({
      'agents/unifier': {
        version: '1.0.0',
        hash: shortHash(unifier),
        path: '.claude/agents/unifier.md',
        target_path: '.claude/agents/unifier.md',
      },
      'config/settings': {
        version: '1.0.0',
        hash: '00000000',
        path: '.claude/settings.json',
        target_path: '.claude/settings.json',
        merge_strategy: 'settings-merge',
      },
      'memory-bank/project-brief': {
        version: '1.0.0',
        hash: '00000000',
        path: '.claude/memory-bank/project.brief.md',
        target_path: '.claude/memory-bank/project.brief.md',
        sync_policy: 'agent-assisted',
      },
    });

    const result = verifyConsumerLock({
      projectRoot: tempRoot,
      projectName: 'demo',
    });

    expect(result.ok).toBe(true);
    expect(result.checked).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.issues).toEqual([]);
  });

  it('fails closed when a locked exact-sync agent is empty or modified', () => {
    writeAt('.claude/agents/unifier.md', '');
    writeLock({
      'agents/unifier': {
        version: '1.0.0',
        hash: shortHash('# Unifier\n'),
        path: '.claude/agents/unifier.md',
        target_path: '.claude/agents/unifier.md',
      },
    });

    const result = verifyConsumerLock({
      projectRoot: tempRoot,
      projectName: 'demo',
    });

    expect(result.ok).toBe(false);
    expect(result.structuralError).toBe(false);
    expect(result.checked).toBe(1);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].type).toBe('hash-mismatch');
    expect(result.issues[0].artifactId).toBe('agents/unifier');
  });

  it('CLI returns drift exit code 1 with readable mismatch output', () => {
    writeAt('.claude/agents/unifier.md', '');
    writeLock({
      'agents/unifier': {
        version: '1.0.0',
        hash: shortHash('# Unifier\n'),
        path: '.claude/agents/unifier.md',
        target_path: '.claude/agents/unifier.md',
      },
    });

    const io = fakeIo();
    const exitCode = runCli(
      ['--verify', `--root=${tempRoot}`, '--project=demo', '--no-audit'],
      io,
    );
    const output = io.output();

    expect(exitCode).toBe(1);
    expect(output.stderr).toContain('Consumer hash verification FAILED');
    expect(output.stderr).toContain('agents/unifier');
    expect(output.stderr).toContain('hash-mismatch');
  });

  it('CLI returns structural exit code 2 when no lock exists', () => {
    mkdirSync(join(tempRoot, '.claude'), { recursive: true });

    const io = fakeIo();
    const exitCode = runCli(
      ['--verify', `--root=${tempRoot}`, '--project=demo', '--no-audit'],
      io,
    );
    const output = io.output();

    expect(exitCode).toBe(2);
    expect(output.stderr).toContain('No consumer lock directory found');
  });

  it('uses the single lock file when package name inference is unavailable', () => {
    const content = '# Code reviewer\n';
    writeAt('.claude/agents/code-reviewer.md', content);
    writeAt('.claude/locks/consumer-one.lock.json', JSON.stringify({
      installed: {
        'agents/code-reviewer': {
          version: '1.0.0',
          hash: shortHash(content),
          path: '.claude/agents/code-reviewer.md',
        },
      },
    }));

    const result = verifyConsumerLock({ projectRoot: tempRoot });

    expect(result.ok).toBe(true);
    expect(result.lockPath).toBe(join(tempRoot, '.claude', 'locks', 'consumer-one.lock.json'));
    expect(readFileSync(result.lockPath, 'utf-8')).toContain('agents/code-reviewer');
  });
});
