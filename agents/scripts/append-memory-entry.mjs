#!/usr/bin/env node
const USAGE = `Usage: node agents/scripts/append-memory-entry.mjs [options]

Deprecated: format a reflection entry for task specs. This script no longer writes to disk.

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
      '❌ At least one of --requirements, --design, --implementation, or --execution is required to build a reflection entry.',
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
  console.warn(
    '⚠️  Deprecated: log reflections in the task spec (Execution progress log or Decision & Work Log).',
  );
  if (options.dryRun) {
    console.log('ℹ️  Dry run: entry preview');
  } else {
    console.log('Suggested entry:');
  }
  console.log(entry);
};

main().catch((error) => {
  console.error('❌ Unexpected error while appending memory entry.');
  console.error(error);
  process.exit(1);
});
