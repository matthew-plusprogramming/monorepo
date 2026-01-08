import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

import { STACK_PREFIX } from '../src/constants';
import { monorepoRootDir, packageRootDir } from '../src/location';

const ENV = process.env.ENV;
if (!ENV) {
  console.error('❌ ENV is not set. Please set the ENV environment variable.');
  process.exit(1);
}

const workDir = resolve(
  packageRootDir,
  `cdktf.out/stacks/${STACK_PREFIX}-bootstrap-stack`,
);
const envFile = resolve(packageRootDir, `.env.${ENV}`);
const dotenvxRunner = resolve(
  monorepoRootDir,
  '.claude/scripts/dotenvx-run.mjs',
);

try {
  // Change to working directory
  process.chdir(workDir);

  // Run dotenvx + tofu command
  execSync(
    `node "${dotenvxRunner}" run -f "${envFile}" -- tofu init -migrate-state`,
    {
      stdio: 'inherit',
      env: process.env,
    },
  );
} catch (err) {
  console.error(
    `❌ Error during bootstrap migration${err instanceof Error ? `: ${err.message}` : ''}`,
  );
  process.exit(1);
}
