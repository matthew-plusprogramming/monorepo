import {
  formatFinding,
  isTestFile,
  isTsFile,
  listGitTrackedFiles,
  readFile,
  splitLines,
} from './utils.mjs';

const ALLOWLIST = new Set([
  'apps/node-server/src/index.ts',
  'apps/node-server/src/services/logger.service.ts',
]);

const args = new Set(process.argv.slice(2));

if (args.has('--help') || args.has('-h')) {
  console.log(`Usage: node agents/scripts/check-console-usage.mjs

Ensures console logging stays inside approved entry points and logger adapters.

Options
  -h, --help        Show this message
  --list-allowed    Print the current allowlist
`);
  if (args.has('--list-allowed')) {
    for (const entry of ALLOWLIST) {
      console.log(`- ${entry}`);
    }
  }
  process.exit(0);
}

const trackedFiles = listGitTrackedFiles().filter(
  (file) =>
    isTsFile(file) &&
    !isTestFile(file),
);

const findings = [];

for (const file of trackedFiles) {
  const content = readFile(file);
  if (!content.includes('console.')) continue;

  if (ALLOWLIST.has(file)) continue;

  const lines = splitLines(content);
  lines.forEach((line, index) => {
    if (line.includes('console.')) {
      findings.push(
        formatFinding(
          file,
          index + 1,
          'Route logging through LoggerService instead of console.*',
        ),
      );
    }
  });
}

if (findings.length > 0) {
  console.error('❌ Found console usage outside approved files:');
  for (const finding of findings) {
    console.error(`  ${finding}`);
  }
  process.exit(1);
}

console.log('✅ Console usage limited to approved entry points.');
