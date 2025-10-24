#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const USAGE = `Usage: node agents/scripts/update-memory-stamp.mjs [options]

Updates the front-matter stamp in agents/memory-bank.md with the current date
and HEAD git SHA.

Options
  --dry-run   Preview the changes without writing to disk
  -h, --help  Show this help message
`;

const args = process.argv.slice(2);
const showHelp = args.includes('-h') || args.includes('--help');

if (showHelp) {
  console.log(USAGE.trimEnd());
  process.exit(0);
}

const dryRun = args.includes('--dry-run');
const root = process.cwd();
const memoryPath = resolve(root, 'agents/memory-bank.md');

const formatDate = (date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(date);

const getGitSha = () => {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    console.error('❌ Failed to read HEAD commit SHA via git rev-parse HEAD.');
    if (result.stderr) {
      console.error(result.stderr.trim());
    }
    process.exit(result.status ?? 1);
  }

  return result.stdout.trim();
};

const replaceField = (content, field, value) => {
  const pattern = new RegExp(`^(${field}:\\s*)(.+)$`, 'm');
  const match = content.match(pattern);

  if (!match) {
    console.error(
      `❌ Unable to locate "${field}" inside agents/memory-bank.md.`,
    );
    process.exit(1);
  }

  if (match[2] === value) {
    return { updated: false, content };
  }

  const updatedContent = content.replace(pattern, `$1${value}`);
  return { updated: true, content: updatedContent };
};

const main = async () => {
  const date = formatDate(new Date());
  const sha = getGitSha();

  const originalContent = await readFile(memoryPath, 'utf8');

  let didUpdate = false;
  let workingContent = originalContent;

  const fields = [
    { key: 'generated_at', value: date },
    { key: 'repo_git_sha', value: sha },
  ];

  for (const field of fields) {
    const { updated, content } = replaceField(
      workingContent,
      field.key,
      field.value,
    );
    workingContent = content;
    didUpdate = didUpdate || updated;
  }

  if (!didUpdate) {
    console.log('✅ agents/memory-bank.md already has the current stamp.');
    return;
  }

  if (dryRun) {
    console.log('ℹ️  Dry run: the following stamp would be applied:');
    for (const field of fields) {
      console.log(`  - ${field.key}: ${field.value}`);
    }
    return;
  }

  await writeFile(memoryPath, workingContent, 'utf8');

  console.log('✅ Updated agents/memory-bank.md with:');
  for (const field of fields) {
    console.log(`  - ${field.key}: ${field.value}`);
  }
};

main().catch((error) => {
  console.error('❌ Unexpected error while updating memory bank stamp.');
  console.error(error);
  process.exit(1);
});
