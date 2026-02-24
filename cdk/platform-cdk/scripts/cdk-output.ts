import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

import { buildChildEnv } from '../../../scripts/utils/child-env.mjs';

const stack = process.argv[2];
if (!stack) {
  console.error('Usage: npm run cdk:output:<stage> <stack-name>');
  process.exit(1);
}

process.env.STACK = stack;

mkdirSync(`cdktf-outputs/stacks/${stack}`, { recursive: true });
// AC3.7: Use minimal env allowlist instead of full process.env
execSync('npm run cdk:output', {
  stdio: 'inherit',
  env: buildChildEnv(['STACK']),
});
