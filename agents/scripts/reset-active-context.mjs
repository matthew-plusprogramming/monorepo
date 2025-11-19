#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const ACTIVE_CONTEXT_PATH = 'agents/ephemeral/active.context.md';

const USAGE = `Usage: node agents/scripts/reset-active-context.mjs [options]

Reset the active context file to the default template with an updated date.

Options
  --date "<YYYY-MM-DD>"   Override the review date (default: today UTC)
  -h, --help              Show this help message
`;

const args = process.argv.slice(2);

if (args.includes('-h') || args.includes('--help')) {
  console.log(USAGE.trimEnd());
  process.exit(0);
}

const options = {
  date: null,
};

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];

  if (!arg.startsWith('--')) {
    console.error(`❌ Unexpected argument: ${arg}`);
    process.exit(1);
  }

  if (arg.startsWith('--date')) {
    const value = arg.includes('=') ? arg.split('=')[1] : args[index + 1];

    if (!value) {
      console.error('❌ Missing value for --date');
      process.exit(1);
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      console.error('❌ --date must follow YYYY-MM-DD format');
      process.exit(1);
    }

    options.date = value;
    if (!arg.includes('=')) {
      index += 1;
    }
    continue;
  }

  console.error(`❌ Unknown option: ${arg}`);
  process.exit(1);
}

const formatDate = (inputDate) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(inputDate);

const buildTemplate = (date) => `---
last_reviewed: ${date}
---

# Active Context

## Current Focus

## Next Steps

## Open Decisions

## Reflection
- XXXX-XX-XX —
  Plan phase:
  Build phase:
  Verify phase:
`;

const main = async () => {
  const reviewDate = options.date ?? formatDate(new Date());
  const content = buildTemplate(reviewDate);
  const absolutePath = resolve(process.cwd(), ACTIVE_CONTEXT_PATH);

  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, 'utf8');

  console.log(`✅ Reset ${ACTIVE_CONTEXT_PATH} (last_reviewed: ${reviewDate})`);
};

main().catch((error) => {
  console.error('❌ Failed to reset the active context.');
  console.error(error);
  process.exit(1);
});
