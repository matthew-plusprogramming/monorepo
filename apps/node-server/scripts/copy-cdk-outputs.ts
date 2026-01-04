import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { exists } from '@utils/ts-utils';

import { monorepoRootDir, packageRootDir } from '../src/location';

const LAMBDA = process.env.LAMBDA;
const ENV = process.env.ENV;
const SKIP_OUTPUTS = process.env.SKIP_CDK_OUTPUTS === 'true';

if (!ENV) {
  console.error('❌ ENV is not set. Please set the ENV environment variable.');
  process.exit(1);
}
if (!exists(LAMBDA)) {
  console.error(
    '❌ LAMBDA is not set. Please set the LAMBDA environment variable.',
  );
}

const outputsDirectory = resolve(
  monorepoRootDir,
  'cdk/platform-cdk/cdktf-outputs',
);

const distDirectory = resolve(packageRootDir, 'dist');
const destRoot = resolve(distDirectory, 'cdktf-outputs');

if (!existsSync(outputsDirectory)) {
  if (SKIP_OUTPUTS) {
    console.warn('⚠️  CDK outputs directory not found (skipped via SKIP_CDK_OUTPUTS)');
    process.exit(0);
  }
  console.warn('⚠️  CDK outputs directory not found.');
  console.warn('');
  console.warn('   This is expected on first build before infrastructure is deployed.');
  console.warn('   The Lambda will work once you deploy infrastructure and pull outputs.');
  console.warn('');
  console.warn('   To deploy and pull outputs, run:');
  console.warn('     node scripts/deploy-orchestrator.mjs deploy infra');
  console.warn('');
  // Exit 0 during build phase - runtime will fail with clear error if outputs missing
  process.exit(0);
}

if (!existsSync(distDirectory)) {
  console.error('❌ Dist directory not found. Did you build?');
  process.exit(1);
}

/**
 * Recursively copy only `outputs.json` files from srcRoot to destRoot,
 * preserving the relative directory structure.
 */
const copyOutputsJson = (srcRoot: string, destRoot: string): number => {
  let copied = 0;
  const stack = [srcRoot];

  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    const entries = readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(current, entry.name);

      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name === 'outputs.json') {
        const rel = relative(srcRoot, fullPath);
        const destPath = join(destRoot, rel);
        mkdirSync(dirname(destPath), { recursive: true });
        copyFileSync(fullPath, destPath);
        copied++;
      }
    }
  }

  return copied;
};

mkdirSync(destRoot, { recursive: true });
const count = copyOutputsJson(outputsDirectory, destRoot);

if (count === 0) {
  console.warn('⚠️ No outputs.json files found to copy.');
} else {
  console.info(`✅ Copied ${count} outputs.json file(s) to ${destRoot}`);
}
