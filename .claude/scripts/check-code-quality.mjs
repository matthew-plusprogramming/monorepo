import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = process.cwd();
const require = createRequire(import.meta.url);

const scripts = [
  { path: 'agents/scripts/check-effect-run-promise.mjs' },
  { path: 'agents/scripts/check-effect-promise.mjs' },
  { path: 'agents/scripts/check-env-schema-usage.mjs' },
  { path: 'agents/scripts/check-resource-names.mjs' },
  { path: 'agents/scripts/check-console-usage.mjs' },
  { path: 'agents/scripts/check-test-aaa-comments.mjs' },
  { path: 'agents/scripts/find-unsafe-assertions.mjs' },
  { path: 'scripts/convert-to-arrows.ts', runner: 'tsx' },
];

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: node agents/scripts/check-code-quality.mjs

Runs all repository code-quality heuristics (Effect usage, environment schema parity, AWS resource sourcing, console allowlists, unsafe assertions, arrow-function codemode).

Options
  -h, --help    Show this message
`);
  process.exit(0);
}

const failures = [];
let tsxCliPath = null;

const resolveRunner = (runner, scriptPath) => {
  if (runner === 'node') {
    return {
      command: process.execPath,
      args: [scriptPath],
    };
  }

  if (runner === 'tsx') {
    if (!tsxCliPath) {
      try {
        tsxCliPath = require.resolve('tsx/cli');
      } catch (error) {
        console.error('❌ Unable to locate tsx. Did you run npm install?');
        throw error;
      }
    }

    return {
      command: process.execPath,
      args: [tsxCliPath, scriptPath],
    };
  }

  throw new Error(`Unknown runner "${runner}" for ${scriptPath}`);
};

for (const entry of scripts) {
  const normalized =
    typeof entry === 'string' ? { path: entry, runner: 'node' } : { runner: 'node', ...entry };
  const resolvedScript = resolve(root, normalized.path);
  let commandConfig;

  try {
    commandConfig = resolveRunner(normalized.runner, resolvedScript);
  } catch (error) {
    failures.push(normalized.path);
    console.error(error);
    break;
  }

  const { command, args: commandArgs } = commandConfig;

  console.log(`▶️  Running ${normalized.path}...`);
  const result = spawnSync(command, commandArgs, {
    stdio: 'inherit',
    cwd: root,
  });

  if (result.status !== 0) {
    console.error(`❌ ${normalized.path} failed (exit code ${result.status ?? 1}).`);
    failures.push(normalized.path);
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
