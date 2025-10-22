import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();

const scripts = [
  'agents/scripts/check-effect-run-promise.mjs',
  'agents/scripts/check-effect-promise.mjs',
  'agents/scripts/check-env-schema-usage.mjs',
  'agents/scripts/check-resource-names.mjs',
  'agents/scripts/check-console-usage.mjs',
  'agents/scripts/check-test-aaa-comments.mjs',
  'agents/scripts/find-unsafe-assertions.mjs',
];

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: node agents/scripts/check-code-quality.mjs

Runs all repository code-quality heuristics (Effect usage, environment schema parity, AWS resource sourcing, console allowlists, unsafe assertions).

Options
  -h, --help    Show this message
`);
  process.exit(0);
}

const failures = [];

for (const script of scripts) {
  console.log(`▶️  Running ${script}...`);
  const result = spawnSync(process.execPath, [resolve(root, script)], {
    stdio: 'inherit',
    cwd: root,
  });

  if (result.status !== 0) {
    console.error(`❌ ${script} failed (exit code ${result.status ?? 1}).`);
    failures.push(script);
  }
}

if (failures.length > 0) {
  console.error('');
  console.error('❌ Code quality checks finished with failures:');
  for (const script of failures) {
    console.error(`  - ${script}`);
  }
  process.exit(1);
}

console.log('✅ All code quality checks passed.');
