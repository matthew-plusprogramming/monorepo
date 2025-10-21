import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { MEMORY_OVERVIEW, DRIFT_TRACKED_DIRS } from './constants.js';

const root = process.cwd();
const stampPath = resolve(root, MEMORY_OVERVIEW);

if (!existsSync(stampPath)) {
  console.warn('⚠️ agents/memory-bank.md not found. Skipping drift check.');
  process.exit(0);
}

const text = readFileSync(stampPath, 'utf-8');

// Parse simple front matter block
const fmMatch = text.match(/^---[\s\S]*?---/);
if (!fmMatch) {
  console.warn('⚠️ No front matter found. Skipping drift check.');
  process.exit(0);
}

const fm = fmMatch[0];
const shaMatch = fm.match(/repo_git_sha:\s*([a-f0-9]{7,40})/);
if (!shaMatch) {
  console.warn(
    '⚠️ repo_git_sha not found in agents/memory-bank.md front matter. Skipping drift check.',
  );
  process.exit(0);
}

const stampedSha = shaMatch[1];
const headSha = execSync('git rev-parse HEAD').toString().trim();

if (stampedSha === headSha) {
  console.info('✅ Memory bank SHA matches HEAD. No drift.');
  process.exit(0);
}

// Check if there are changes under these dirs between stampedSha and HEAD
let changed = '';
try {
  const tracked = DRIFT_TRACKED_DIRS.join(' ');
  changed = execSync(
    `git diff --name-only ${stampedSha} ${headSha} -- ${tracked}`,
  )
    .toString()
    .trim();
} catch (e) {
  // Even if diff fails (unrelated history), treat as drift to be safe
  console.error('❌ Could not compute git diff. Treating as drift.');
  process.exit(1);
}

if (changed) {
  console.error(
    '❌ Memory bank drift detected in tracked areas since stamped SHA:',
  );
  console.error(changed);
  console.error(
    `\nUpdate ${MEMORY_OVERVIEW} front matter (repo_git_sha/generated_at) and review canonical files under ${DRIFT_TRACKED_DIRS.join(', ')}.`,
  );
  process.exit(1);
}

console.info(
  `✅ No impactful changes under ${DRIFT_TRACKED_DIRS.join('/ ')} since stamped SHA.`,
);
