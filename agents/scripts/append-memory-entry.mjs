#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const USAGE = `Usage: node agents/scripts/append-memory-entry.mjs --target <active|progress> [options]

Append a formatted entry to the Memory Bank active context or progress log.

Options
  --target <active|progress>   Select which file to update (required)
  --plan "<text>"              Plan phase summary (active context only)
  --build "<text>"             Build phase summary (active context only)
  --verify "<text>"            Verify phase summary (active context only)
  --message "<text>"           Progress log message (progress target only)
  --dry-run                    Preview the entry without writing to disk
  -h, --help                   Show this help message
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
  target: null,
  plan: null,
  build: null,
  verify: null,
  message: null,
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

  if (arg === '--active' || arg === '--progress') {
    options.target = arg.slice(2);
    continue;
  }

  if (arg.startsWith('--')) {
    const { flag, value } = toKeyValue(arg, args[index + 1]);

    switch (flag) {
      case '--target':
        options.target = value;
        index += arg.includes('=') ? 0 : 1;
        break;
      case '--plan':
        options.plan = value;
        index += arg.includes('=') ? 0 : 1;
        break;
      case '--build':
        options.build = value;
        index += arg.includes('=') ? 0 : 1;
        break;
      case '--verify':
        options.verify = value;
        index += arg.includes('=') ? 0 : 1;
        break;
      case '--message':
        options.message = value;
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

const appendEntry = async (filePath, entry, dryRun) => {
  const absolutePath = resolve(process.cwd(), filePath);
  const originalContent = await readFile(absolutePath, 'utf8');
  const contentWithNewline = ensureEndsWithNewline(originalContent);
  const updatedContent = `${contentWithNewline}${entry}\n`;

  if (dryRun) {
    console.log('ℹ️  Dry run: entry preview');
    console.log(entry);
    return;
  }

  await writeFile(absolutePath, updatedContent, 'utf8');
  console.log(`✅ Appended entry to ${filePath}`);
};

const buildActiveEntry = (date, { plan, build, verify }) => {
  const segments = [];
  if (plan) segments.push({ label: 'Plan', text: normalize(plan) });
  if (build) segments.push({ label: 'Build', text: normalize(build) });
  if (verify) segments.push({ label: 'Verify', text: normalize(verify) });

  if (segments.length === 0) {
    console.error(
      '❌ At least one of --plan, --build, or --verify is required for the active context.',
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

const buildProgressEntry = (date, message) => {
  if (!message) {
    console.error('❌ --message is required when targeting the progress log.');
    process.exit(1);
  }

  return `- ${date}: ${normalize(message)}`;
};

const main = async () => {
  if (!options.target) {
    console.error('❌ --target <active|progress> is required.');
    process.exit(1);
  }

  const target = options.target.toLowerCase();
  const date = formatDate(new Date());

  if (target !== 'active' && target !== 'progress') {
    console.error('❌ --target must be either "active" or "progress".');
    process.exit(1);
  }

  if (target === 'active') {
    const entry = buildActiveEntry(date, options);
    await appendEntry('agents/memory-bank/active.context.md', entry, options.dryRun);
    return;
  }

  const entry = buildProgressEntry(date, options.message);
  await appendEntry('agents/memory-bank/progress.log.md', entry, options.dryRun);
};

main().catch((error) => {
  console.error('❌ Unexpected error while appending memory entry.');
  console.error(error);
  process.exit(1);
});
