#!/usr/bin/env node
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const TASK_SPECS_DIR = '.claude/specs/active';
const TEMPLATE_PATH = '.claude/templates/task-spec.template.md';

const USAGE = `Usage: node .claude/scripts/reset-active-context.mjs --slug "<task-slug>" [options]

Create a new per-task spec from the task-spec template.

Options
  --slug "<task-slug>"     Required slug used in the task spec filename
  --title "<text>"        Optional human-friendly title for the task
  --date "<YYYY-MM-DD>"   Override the date (default: today UTC)
  -h, --help              Show this help message

Examples
  node .claude/scripts/reset-active-context.mjs --slug "add-caching"
  node .claude/scripts/reset-active-context.mjs --slug "add-caching" --title "Add response caching"
`;

const args = process.argv.slice(2);

if (args.includes('-h') || args.includes('--help')) {
  console.log(USAGE.trimEnd());
  process.exit(0);
}

const options = {
  date: null,
  slug: null,
  title: null,
};

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];

  if (!arg.startsWith('--')) {
    console.error(`Unexpected argument: ${arg}`);
    process.exit(1);
  }

  const [flag, inlineValue] = arg.split('=');
  const nextValue = args[index + 1];
  const value = inlineValue ?? nextValue;

  switch (flag) {
    case '--date': {
      if (!value) {
        console.error('Missing value for --date');
        process.exit(1);
      }

      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        console.error('--date must follow YYYY-MM-DD format');
        process.exit(1);
      }

      options.date = value;
      if (inlineValue === undefined) index += 1;
      break;
    }
    case '--slug': {
      if (!value) {
        console.error('Missing value for --slug');
        process.exit(1);
      }

      if (!/^[a-z0-9-]+$/.test(value)) {
        console.error(
          '--slug must use lowercase letters, numbers, or dashes only',
        );
        process.exit(1);
      }

      options.slug = value;
      if (inlineValue === undefined) index += 1;
      break;
    }
    case '--title': {
      if (!value) {
        console.error('Missing value for --title');
        process.exit(1);
      }

      options.title = value;
      if (inlineValue === undefined) index += 1;
      break;
    }
    default:
      console.error(`Unknown option: ${flag}`);
      process.exit(1);
  }
}

if (!options.slug) {
  console.error('--slug is required');
  process.exit(1);
}

const formatDate = (inputDate) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(inputDate);

const toTitleCase = (value) =>
  value
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

const buildFallbackTemplate = ({ title, slug, date }) => `---
id: task-${slug}
title: ${title}
date: ${date}
status: draft
implementation_status: not_started
---

# ${title}

## Context
Brief background and motivation for this task.

## Goal
Clear statement of what success looks like.

## Requirements (EARS Format)
- **WHEN** <trigger condition>
- **THEN** the system shall <required behavior>
- **AND** <additional required behavior>

## Acceptance Criteria
- AC1.1: <Testable criterion that can be verified>
- AC1.2: <Testable criterion that can be verified>
- AC2.1: <Testable criterion that can be verified>

## Design Notes
Brief architecture notes, key design decisions, or approach.

## Task List
- [ ] Task 1: <Concrete outcome with clear completion criteria>
- [ ] Task 2: <Concrete outcome with clear completion criteria>
- [ ] Task 3: <Concrete outcome with clear completion criteria>

## Test Plan
Map each acceptance criterion to specific test cases:

- AC1.1 -> Test: "should <behavior>"
- AC1.2 -> Test: "should <behavior>"
- AC2.1 -> Test: "should <behavior>"

## Decision & Work Log
- ${date}: Spec created
`;

const loadTemplate = async (templatePath, { title, slug, date }) => {
  const absolutePath = resolve(process.cwd(), templatePath);

  try {
    let content = await readFile(absolutePath, 'utf8');

    // Replace template placeholders
    content = content
      .replace(/<slug>/g, slug)
      .replace(/<Task Title>/g, title)
      .replace(/<YYYY-MM-DD>/g, date)
      .replace(/task-<slug>/g, `task-${slug}`);

    return content;
  } catch (error) {
    if (error.code === 'ENOENT') {
      // Template not found, use fallback
      return null;
    }
    throw error;
  }
};

const main = async () => {
  const reviewDate = options.date ?? formatDate(new Date());
  const title = options.title ?? toTitleCase(options.slug);
  const taskSpecFile = `${reviewDate}-${options.slug}.md`;
  const taskSpecPath = `${TASK_SPECS_DIR}/${taskSpecFile}`;

  const absoluteTaskSpecPath = resolve(process.cwd(), taskSpecPath);

  // Try to load from template, fall back to built-in template
  let taskSpecContent = await loadTemplate(TEMPLATE_PATH, {
    title,
    slug: options.slug,
    date: reviewDate,
  });

  if (!taskSpecContent) {
    taskSpecContent = buildFallbackTemplate({
      title,
      slug: options.slug,
      date: reviewDate,
    });
  }

  await mkdir(dirname(absoluteTaskSpecPath), { recursive: true });

  const taskSpecExists = await access(absoluteTaskSpecPath)
    .then(() => true)
    .catch((error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });

  if (!taskSpecExists) {
    await writeFile(absoluteTaskSpecPath, taskSpecContent, 'utf8');
    console.log(`Created task spec at ${taskSpecPath}`);
  } else {
    console.log(
      `Task spec already exists at ${taskSpecPath}; left unchanged.`,
    );
  }

  console.log(
    `Load context with: node .claude/scripts/load-context.mjs --task ${taskSpecPath}`,
  );
};

main().catch((error) => {
  console.error('Failed to create the task spec.');
  console.error(error);
  process.exit(1);
});
