#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const USAGE = `Usage: node agents/scripts/git-diff-with-lines.mjs [options]

Outputs the diff between the working tree (and index) and HEAD with old/new line numbers.

Options
  -c, --cached   Show only staged changes (diff index vs HEAD)
  -h, --help     Show this message
`;

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE.trimEnd());
  process.exit(0);
}

const includeCached = args.includes('--cached') || args.includes('-c');
const gitArgs = ['diff', '--no-color'];

if (includeCached) {
  gitArgs.push('--cached');
}

gitArgs.push('HEAD');

const diffResult = spawnSync('git', gitArgs, {
  encoding: 'utf8',
  stdio: ['inherit', 'pipe', 'pipe'],
});

if (diffResult.status !== 0) {
  console.error('❌ Failed to compute git diff.');
  if (diffResult.stderr) {
    console.error(diffResult.stderr.trim());
  }
  process.exit(diffResult.status ?? 1);
}

const diffOutput = diffResult.stdout;

if (!diffOutput.trim()) {
  console.log('✅ No changes relative to HEAD.');
  process.exit(0);
}

const hunkPattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;
const headerPattern = /^diff --git /;

const formatNumber = (value) => {
  if (typeof value !== 'number') {
    return ' '.repeat(6);
  }

  return String(value).padStart(6, ' ');
};

const formatDiffLine = (marker, oldNumber, newNumber, content) => {
  const oldPart = formatNumber(oldNumber ?? null);
  const newPart = formatNumber(newNumber ?? null);
  return `${marker} ${oldPart} ${newPart} | ${content}`;
};

let currentOld = null;
let currentNew = null;

const lines = diffOutput.split('\n');

for (const rawLine of lines) {
  const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

  if (headerPattern.test(line)) {
    currentOld = null;
    currentNew = null;
    console.log('');
    console.log(line);
    continue;
  }

  if (line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
    currentOld = null;
    currentNew = null;
    console.log(line);
    continue;
  }

  const hunkMatch = line.match(hunkPattern);

  if (hunkMatch) {
    currentOld = Number.parseInt(hunkMatch[1], 10);
    currentNew = Number.parseInt(hunkMatch[3], 10);
    console.log(line);
    continue;
  }

  if (line.startsWith(' ')) {
    console.log(formatDiffLine(' ', currentOld, currentNew, line.slice(1)));
    if (typeof currentOld === 'number') {
      currentOld += 1;
    }
    if (typeof currentNew === 'number') {
      currentNew += 1;
    }
    continue;
  }

  if (line.startsWith('-')) {
    console.log(formatDiffLine('-', currentOld, null, line.slice(1)));
    if (typeof currentOld === 'number') {
      currentOld += 1;
    }
    continue;
  }

  if (line.startsWith('+')) {
    console.log(formatDiffLine('+', null, currentNew, line.slice(1)));
    if (typeof currentNew === 'number') {
      currentNew += 1;
    }
    continue;
  }

  if (line.startsWith('\\ No newline at end of file')) {
    console.log(line);
    continue;
  }

  console.log(line);
}
