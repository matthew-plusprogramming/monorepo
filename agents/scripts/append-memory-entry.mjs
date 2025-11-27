#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const ACTIVE_CONTEXT_PATH = 'agents/ephemeral/active.context.md';
const RESET_COMMAND = 'node agents/scripts/reset-active-context.mjs';

const USAGE = `Usage: node agents/scripts/append-memory-entry.mjs [options]

Append a formatted entry to the Memory Bank active context.

Options
  --requirements "<text>"     Requirements phase summary
  --design "<text>"           Design phase summary
  --implementation "<text>"   Implementation Planning phase summary
  --execution "<text>"        Execution phase summary
  --dry-run          Preview the entry without writing to disk
  -h, --help         Show this help message
`;

const args = process.argv.slice(2);

const toKeyValue = (arg, next) => {
  const [flag, value] = arg.split('=');
  if (value !== undefined) {
    return { flag, value };
  }
  if (!next) {
    console.error(`❌ Missing value for ${flag}`);
    process.exit(1);
  }
  return { flag, value: next };
};

const options = {
  requirements: null,
  design: null,
  implementation: null,
  execution: null,
  dryRun: false,
};

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];

  if (arg === '-h' || arg === '--help') {
    console.log(USAGE.trimEnd());
    process.exit(0);
  }

  if (arg === '--dry-run') {
    options.dryRun = true;
    continue;
  }

  if (arg.startsWith('--')) {
    const { flag, value } = toKeyValue(arg, args[index + 1]);

    switch (flag) {
      case '--requirements':
        options.requirements = value;
        index += arg.includes('=') ? 0 : 1;
        break;
      case '--design':
        options.design = value;
        index += arg.includes('=') ? 0 : 1;
        break;
      case '--implementation':
        options.implementation = value;
        index += arg.includes('=') ? 0 : 1;
        break;
      case '--execution':
        options.execution = value;
        index += arg.includes('=') ? 0 : 1;
        break;
      default:
        console.error(`❌ Unknown option: ${flag}`);
        process.exit(1);
    }
    continue;
  }

  console.error(`❌ Unexpected argument: ${arg}`);
  process.exit(1);
}

const normalize = (value) =>
  value
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const formatDate = (date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(date);

const ensureEndsWithNewline = (text) =>
  text.endsWith('\n') ? text : `${text}\n`;

const insertEntry = (content, entry) => {
  const marker = '## Legacy Reflections';
  const contentWithNewline = ensureEndsWithNewline(content);
  const markerIndex = contentWithNewline.indexOf(marker);

  if (markerIndex === -1) {
    return `${contentWithNewline}${entry}\n`;
  }

  const before = contentWithNewline.slice(0, markerIndex).trimEnd();
  const after = contentWithNewline.slice(markerIndex);

  const beforeBlock = before ? `${before}\n` : '';
  return `${beforeBlock}${entry}\n\n${after}`;
};

const appendEntry = async (filePath, entry, dryRun) => {
  const absolutePath = resolve(process.cwd(), filePath);
  let originalContent;

  try {
    originalContent = await readFile(absolutePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error(
        `❌ Missing active context at ${filePath}. Run "${RESET_COMMAND}" to regenerate it.`,
      );
      process.exit(1);
    }

    throw error;
  }

  const updatedContent = insertEntry(originalContent, entry);

  if (dryRun) {
    console.log('ℹ️  Dry run: entry preview');
    console.log(entry);
    return;
  }

  await writeFile(absolutePath, updatedContent, 'utf8');
  console.log(`✅ Appended entry to ${filePath}`);
};

const buildActiveEntry = (
  date,
  { requirements, design, implementation, execution },
) => {
  const segments = [];
  if (requirements)
    segments.push({ label: 'Requirements', text: normalize(requirements) });
  if (design) segments.push({ label: 'Design', text: normalize(design) });
  if (implementation)
    segments.push({ label: 'Implementation Planning', text: normalize(implementation) });
  if (execution) segments.push({ label: 'Execution', text: normalize(execution) });

  if (segments.length === 0) {
    console.error(
      '❌ At least one of --requirements, --design, --implementation, or --execution is required for the active context.',
    );
    process.exit(1);
  }

  const [first, ...rest] = segments;

  let entry = `- ${date} — ${first.label} phase: ${first.text}`;

  for (const segment of rest) {
    entry += `\n  ${segment.label} phase: ${segment.text}`;
  }

  return entry;
};

const main = async () => {
  const date = formatDate(new Date());

  const entry = buildActiveEntry(date, options);
  await appendEntry(ACTIVE_CONTEXT_PATH, entry, options.dryRun);
};

main().catch((error) => {
  console.error('❌ Unexpected error while appending memory entry.');
  console.error(error);
  process.exit(1);
});
