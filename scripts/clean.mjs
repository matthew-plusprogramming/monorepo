import { rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SAVE_FLAG = '--save-cdk-ouptuts';
const args = process.argv.slice(2);
const saveCdkOutputs =
  process.env.SAVE_CDK_OUPTUTS === 'true' ||
  process.env.SAVE_CDK_OUPTUTS === '1' ||
  args.includes(SAVE_FLAG);
const turboArgs = args.filter((arg) => arg !== SAVE_FLAG);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (saveCdkOutputs) {
  console.log('Preserving cdk/backend-server-cdk/cdktf-outputs (save flag set)');
}

const turboResult = spawnSync('turbo', ['run', 'clean', ...turboArgs], {
  cwd: repoRoot,
  env: {
    ...process.env,
    ...(saveCdkOutputs ? { SAVE_CDK_OUPTUTS: 'true' } : {}),
  },
  stdio: 'inherit',
});

if (turboResult.error) {
  console.error(`Failed to run turbo clean: ${turboResult.error.message}`);
  process.exit(1);
}

if (turboResult.status !== 0) {
  process.exit(turboResult.status ?? 1);
}

['node_modules', '.turbo'].forEach((target) => {
  rmSync(resolve(repoRoot, target), { recursive: true, force: true });
});
