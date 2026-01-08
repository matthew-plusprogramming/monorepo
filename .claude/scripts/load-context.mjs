#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const USAGE = `Usage: node .claude/scripts/load-context.mjs [options]

Loads context files and prints each file with a section header and line numbers
so agents can review everything at once.

Options
  -o, --include-optional   Include optional Memory Bank context files
  -l, --list               Only list the resolved file paths (no contents)
  --task <path>            Include a specific task spec path
  --task-spec <path>       Alias for --task
  --files <path[,path]>    Comma-separated list of additional files to include
  -h, --help               Show this help message

Examples
  node .claude/scripts/load-context.mjs --task .claude/specs/active/2026-01-01-my-feature.md
  node .claude/scripts/load-context.mjs --list
  node .claude/scripts/load-context.mjs --files .claude/memory-bank/project.brief.md
`;

const args = process.argv.slice(2);

if (args.includes('-h') || args.includes('--help')) {
  console.log(USAGE.trimEnd());
  process.exit(0);
}

const includeOptional =
  args.includes('-o') || args.includes('--include-optional');
const listOnly = args.includes('-l') || args.includes('--list');

const getOptionValue = (flag) => {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === flag) {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) {
        console.error(`Missing value for ${flag}`);
        process.exit(1);
      }
      return value;
    }
    if (arg.startsWith(`${flag}=`)) {
      const value = arg.slice(flag.length + 1);
      if (!value) {
        console.error(`Missing value for ${flag}`);
        process.exit(1);
      }
      return value;
    }
  }
  return null;
};

const taskSpecPath =
  getOptionValue('--task') ?? getOptionValue('--task-spec');
const additionalFiles = getOptionValue('--files');

// Core context files that are always relevant
const ALWAYS_INCLUDE = [
  '.claude/memory-bank/project.brief.md',
];

// Optional context files loaded with -o flag
const OPTIONAL = [
  '.claude/memory-bank/tech.context.md',
  '.claude/memory-bank/testing.guidelines.md',
];

const root = process.cwd();

const collectPaths = () => {
  const base = [...ALWAYS_INCLUDE];

  // Add task spec if provided
  if (taskSpecPath) {
    base.push(taskSpecPath);
  } else {
    console.warn(
      'Warning: No task spec provided. Use --task <path> to include the current task spec.',
    );
  }

  // Add additional files if provided
  if (additionalFiles) {
    const files = additionalFiles.split(',').map((f) => f.trim()).filter(Boolean);
    base.push(...files);
  }

  return includeOptional ? [...base, ...OPTIONAL] : base;
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
    console.warn(`Warning: Missing file: ${relativePath}`);
    return null;
  }

  try {
    return readFileSync(absolutePath, 'utf8');
  } catch (error) {
    console.warn(`Warning: Failed to read ${relativePath}: ${error.message}`);
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
    const exists = existsSync(absolutePath) ? '[exists]' : '[missing]';
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
