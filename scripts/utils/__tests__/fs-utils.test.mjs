import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ensureDir,
  fileExists,
  replaceTokens,
  writeFileSafely,
} from '../fs-utils.mjs';

const createTempDir = async () => mkdtemp(join(tmpdir(), 'scaffold-utils-'));

test('writeFileSafely respects dry-run mode', async () => {
  const base = await createTempDir();
  const target = join(base, 'example.txt');

  const result = await writeFileSafely(target, 'demo', {
    dryRun: true,
    cwd: base,
  });

  assert.equal(result.action, 'would-create');
  assert.equal(result.skipped, true);
  assert.equal(await fileExists(target), false);
});

test('writeFileSafely creates files and directories recursively', async () => {
  const base = await createTempDir();
  const nestedDir = join(base, 'nested', 'path');
  const target = join(nestedDir, 'file.txt');

  await ensureDir(nestedDir);
  const result = await writeFileSafely(target, 'hello', {
    dryRun: false,
    force: false,
    cwd: base,
  });

  assert.equal(result.action, 'created');
  assert.equal(result.skipped, false);
  assert.equal(await fileExists(target), true);
});

test('writeFileSafely refuses overwrite without force', async () => {
  const base = await createTempDir();
  const target = join(base, 'file.txt');

  await writeFileSafely(target, 'initial', { dryRun: false, force: true, cwd: base });

  await assert.rejects(
    () =>
      writeFileSafely(target, 'again', {
        dryRun: false,
        force: false,
        cwd: base,
      }),
    /Refusing to overwrite/,
  );
});

test('replaceTokens swaps all tokens in a string', () => {
  const result = replaceTokens('Hello __NAME__!', { __NAME__: 'World' });
  assert.equal(result, 'Hello World!');
});
