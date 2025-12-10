import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { monorepoRootDir, packageRootDir } from '../src/location';

const ENV = process.env.ENV;
if (!ENV) {
  console.error('❌ ENV is not set. Please set the ENV environment variable.');
  process.exit(1);
}

const outputsDirectory = resolve(
  monorepoRootDir,
  'cdk/platform-cdk/cdktf-outputs',
);

const distDirectory = resolve(packageRootDir, 'dist');
const destRoot = resolve(distDirectory, 'cdktf-outputs');

if (!existsSync(outputsDirectory)) {
  console.error(
    '❌ CDK outputs directory not found. Please build CDK and retry',
  );
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
