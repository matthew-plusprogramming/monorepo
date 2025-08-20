import { execSync } from 'child_process';
import { resolve } from 'path';

import { packageRootDir } from '../src/location';

const ENV = process.env.ENV;
if (!ENV) {
  console.error('❌ ENV is not set. Please set the ENV environment variable.');
  process.exit(1);
}

const workDir = resolve(packageRootDir, 'cdktf.out/stacks/bootstrap');
const envFile = resolve(packageRootDir, `.env.${ENV}`);

try {
  // Change to working directory
  process.chdir(workDir);

  // Run dotenvx + tofu command
  execSync(`dotenvx run -f ${envFile} -- tofu init -migrate-state`, {
    stdio: 'inherit',
    env: process.env,
  });
} catch (err) {
  console.error('❌ Error during bootstrap migration:', err.message);
  process.exit(1);
}
