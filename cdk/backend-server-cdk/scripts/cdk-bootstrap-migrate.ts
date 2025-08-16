import { execSync } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ENV = process.env.ENV;
if (!ENV) {
  console.error('❌ ENV is not set. Please set the ENV environment variable.');
  process.exit(1);
}

const workDir = resolve(__dirname, '../cdktf.out/stacks/bootstrap');

try {
  // Change to working directory
  process.chdir(workDir);

  // Run dotenvx + tofu command
  execSync(`dotenvx run -f ../../../.env.${ENV} -- tofu init -migrate-state`, {
    stdio: 'inherit',
    env: process.env,
  });
} catch (err) {
  console.error('❌ Error during bootstrap migration:', err.message);
  process.exit(1);
}
