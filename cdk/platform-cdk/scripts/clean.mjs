import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SAVE_FLAG = '--save-cdk-outputs';
const args = process.argv.slice(2);
const saveCdkOutputs =
  process.env.SAVE_CDK_OUPTUTS === 'true' ||
  process.env.SAVE_CDK_OUPTUTS === '1' ||
  args.includes(SAVE_FLAG);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const targets = ['node_modules', 'cdktf.out', '.turbo', 'dist'];

if (!saveCdkOutputs) {
  targets.push('cdktf-outputs');
} else {
  console.log('Skipping cdktf-outputs (save flag set)');
}

targets.forEach((relativePath) => {
  rmSync(resolve(packageRoot, relativePath), { recursive: true, force: true });
});
