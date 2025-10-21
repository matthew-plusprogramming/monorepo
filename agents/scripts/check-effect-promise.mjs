import {
  formatFinding,
  isTestFile,
  isTsFile,
  listGitTrackedFiles,
  readFile,
  splitLines,
} from './utils.mjs';

const ALLOWLIST = new Set([]);

const args = new Set(process.argv.slice(2));

if (args.has('--help') || args.has('-h')) {
  console.log(`Usage: node agents/scripts/check-effect-promise.mjs

Flags Effect.promise usages outside the explicit allowlist so callers prefer Effect.tryPromise with typed error channels.

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

const trackedFiles = listGitTrackedFiles()
  .filter(isTsFile)
  .filter((file) => !isTestFile(file));

const findings = [];

for (const file of trackedFiles) {
  const content = readFile(file);
  if (!content.includes('Effect.promise')) continue;

  if (ALLOWLIST.has(file)) continue;

  const lines = splitLines(content);
  lines.forEach((line, index) => {
    if (line.includes('Effect.promise')) {
      findings.push(
        formatFinding(
          file,
          index + 1,
          'Prefer Effect.tryPromise with explicit error handling',
        ),
      );
    }
  });
}

if (findings.length > 0) {
  console.error('❌ Found disallowed Effect.promise usage:');
  for (const finding of findings) {
    console.error(`  ${finding}`);
  }
  process.exit(1);
}

console.log('✅ Effect.promise usage limited to the transitional allowlist.');
