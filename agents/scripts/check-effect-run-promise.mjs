import {
  formatFinding,
  isTestFile,
  isTsFile,
  listGitTrackedFiles,
  readFile,
  splitLines,
} from './utils.mjs';


const ALLOWLIST = new Set([
  // Approved runtime entry points
  'packages/core/backend-core/src/request.handler.ts',
  'apps/node-server/src/middleware/ipRateLimiting.middleware.ts',
  'apps/node-server/src/middleware/isAuthenticated.middleware.ts',
]);

const args = new Set(process.argv.slice(2));

if (args.has('--help') || args.has('-h')) {
  console.log(`Usage: node agents/scripts/check-effect-run-promise.mjs

Ensures Effect.runPromise is only used in explicitly allowed runtime entry points.

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
  if (!content.includes('Effect.runPromise')) continue;

  if (ALLOWLIST.has(file)) continue;

  const lines = splitLines(content);
  lines.forEach((line, index) => {
    if (line.includes('Effect.runPromise')) {
      findings.push(
        formatFinding(
          file,
          index + 1,
          'Unexpected Effect.runPromise usage (add to allowlist or refactor)',
        ),
      );
    }
  });
}

if (findings.length > 0) {
  console.error('❌ Found disallowed Effect.runPromise usage:');
  for (const finding of findings) {
    console.error(`  ${finding}`);
  }
  process.exit(1);
}

console.log('✅ Effect.runPromise usage confined to approved entry points.');
