#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const USAGE = `Usage: node agents/scripts/load-context.mjs [options]

Loads the required Memory Bank and workflow context for a new task and prints
each file with a section header so agents can review everything at once.

Options
  -o, --include-optional   Include optional Memory Bank context files
  -l, --list               Only list the resolved file paths (no contents)
  -h, --help               Show this help message
`;

const args = process.argv.slice(2);

if (args.includes('-h') || args.includes('--help')) {
  console.log(USAGE.trimEnd());
  process.exit(0);
}

const includeOptional =
  args.includes('-o') || args.includes('--include-optional');
const listOnly = args.includes('-l') || args.includes('--list');

const ACTIVE_CONTEXT_PATH = 'agents/ephemeral/active.context.md';

const alwaysInclude = [
  'agents/memory-bank.md',
  'agents/workflows.md',
  'agents/tools.md',
  'agents/workflows/default.workflow.md',
  'agents/memory-bank/project.brief.md',
  ACTIVE_CONTEXT_PATH,
];

const optional = ['agents/memory-bank/tech.context.md'];

const root = process.cwd();

const collectPaths = () => {
  return includeOptional ? [...alwaysInclude, ...optional] : alwaysInclude;
};

const formatWithLineNumbers = (content) => {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const width = String(lines.length).length;

  return lines
    .map((line, index) => `${String(index + 1).padStart(width, ' ')} | ${line}`)
    .join('\n');
};

const printSectionHeader = (relativePath) => {
  const divider = '='.repeat(relativePath.length + 8);
  console.log(divider);
  console.log(`=== ${relativePath} ===`);
  console.log(divider);
};

const readFileSafely = (relativePath) => {
  const absolutePath = resolve(root, relativePath);

  if (!existsSync(absolutePath)) {
    const missingMessage =
      relativePath === ACTIVE_CONTEXT_PATH
        ? `⚠️  Missing file: ${relativePath}. Run "node agents/scripts/reset-active-context.mjs" to create the template.`
        : `⚠️  Missing file: ${relativePath}`;
    console.warn(missingMessage);
    return null;
  }

  try {
    return readFileSync(absolutePath, 'utf8');
  } catch (error) {
    console.warn(`⚠️  Failed to read ${relativePath}: ${error.message}`);
    return null;
  }
};

const selectedPaths = collectPaths();

if (selectedPaths.length === 0) {
  console.log('No context files selected.');
  process.exit(0);
}

if (listOnly) {
  for (const relativePath of selectedPaths) {
    const absolutePath = resolve(root, relativePath);
    const exists = existsSync(absolutePath) ? '✅' : '⚠️';
    console.log(`${exists} ${relativePath}`);
  }
  process.exit(0);
}

for (const relativePath of selectedPaths) {
  const content = readFileSafely(relativePath);

  if (content === null) {
    continue;
  }

  printSectionHeader(relativePath);
  console.log(formatWithLineNumbers(content));
  console.log('');
}
