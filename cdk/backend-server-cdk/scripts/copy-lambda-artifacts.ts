import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { monorepoRootDir, packageRootDir } from '../src/location';

const lambdaArtifacts = resolve(monorepoRootDir, 'apps/node-server/dist');
const distDirectory = resolve(packageRootDir, 'dist');

if (!existsSync(lambdaArtifacts)) {
  console.error(
    '❌ Lambda artifacts directory not found. Please build node-server and retry',
  );
  process.exit(1);
}

cpSync(lambdaArtifacts, distDirectory, { recursive: true });

const destRoot = resolve(distDirectory, 'cdktf.out');
if (!existsSync(destRoot)) {
  /**
   * Recursively copy only `outputs.json` files from srcRoot to destRoot,
   * preserving the relative directory structure.
   */
  const copyOutputsJson = (srcRoot: string, destRoot: string): number => {
    let copied = 0;
    const stack = [srcRoot];

    while (stack.length) {
      const current = stack.pop()!;
      const entries = readdirSync(current, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(current, entry.name);

        if (entry.isDirectory()) {
          stack.push(fullPath);
        } else if (entry.isFile() && entry.name === 'outputs.json') {
          const rel = relative(srcRoot, fullPath); // e.g. "stackA/outputs.json"
          const destPath = join(destRoot, rel);
          mkdirSync(dirname(destPath), { recursive: true });
          copyFileSync(fullPath, destPath);
          copied++;
        }
      }
    }

    return copied;
  };

  const outputsDirectory = resolve(packageRootDir, 'cdktf.out');

  if (!existsSync(outputsDirectory)) {
    console.error('❌ CDK outputs directory not found. Please pull and retry');
    process.exit(0);
  }

  mkdirSync(destRoot, { recursive: true });
  const count = copyOutputsJson(outputsDirectory, destRoot);

  if (count === 0) {
    console.warn('⚠️ No outputs.json files found to copy.');
  } else {
    console.info(`✅ Copied ${count} outputs.json file(s) to ${destRoot}`);
  }
}
