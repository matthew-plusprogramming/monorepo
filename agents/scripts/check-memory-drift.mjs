import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

const root = process.cwd();
const corePath = resolve(root, 'memory-bank.core.md');

if (!existsSync(corePath)) {
  console.warn('⚠️ memory-bank.core.md not found. Skipping drift check.');
  process.exit(0);
}

const text = readFileSync(corePath, 'utf-8');

// Parse simple front matter block
const fmMatch = text.match(/^---[\s\S]*?---/);
if (!fmMatch) {
  console.warn('⚠️ No front matter found. Skipping drift check.');
  process.exit(0);
}

const fm = fmMatch[0];
const shaMatch = fm.match(/repo_git_sha:\s*([a-f0-9]{7,40})/);
if (!shaMatch) {
  console.warn('⚠️ repo_git_sha not found in front matter. Skipping drift check.');
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
  changed = execSync(
    `git diff --name-only ${stampedSha} ${headSha} -- apps cdk packages`,
  )
    .toString()
    .trim();
} catch (e) {
  // Even if diff fails (unrelated history), treat as drift to be safe
  console.error('❌ Could not compute git diff. Treating as drift.');
  process.exit(1);
}

if (changed) {
  console.error('❌ Memory bank drift detected in tracked areas since stamped SHA:');
  console.error(changed);
  console.error(
    '\nUpdate memory-bank.core.md (repo_git_sha/generated_at) and review memory-bank.deep.md.',
  );
  process.exit(1);
}

console.info('✅ No impactful changes under apps/ cdk/ packages/ since stamped SHA.');

