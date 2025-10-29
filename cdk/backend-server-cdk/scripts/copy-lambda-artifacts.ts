import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import {
  listLambdaArtifactDefinitions,
  resolveSourceDistPath,
  resolveStagingDirectory,
  resolveZipPath,
} from '../src/lambda/artifacts';
import { packageRootDir } from '../src/location';

const lambdaDefinitions = listLambdaArtifactDefinitions();
const distDirectory = resolve(packageRootDir, 'dist');

if (existsSync(distDirectory)) {
  rmSync(distDirectory, { recursive: true });
}

mkdirSync(distDirectory, { recursive: true });

interface ManifestEntry {
  id: string;
  stackName: string;
  status: 'prepared' | 'missing';
  description: string;
  sourceDist: string;
  stagingDir: string;
  zipPath?: string;
  reason?: string;
}

const manifestEntries: ManifestEntry[] = [];

for (const definition of lambdaDefinitions) {
  const sourceDir = resolveSourceDistPath(definition);
  const stagingDir = resolveStagingDirectory(definition);
  const zipPath = resolveZipPath(definition);

  if (!existsSync(sourceDir)) {
    console.warn(
      `⚠️  Skipping ${definition.description}: source directory not found (${sourceDir})`,
    );
    manifestEntries.push({
      id: definition.id,
      stackName: definition.stackName,
      description: definition.description,
      status: 'missing',
      sourceDist: sourceDir,
      stagingDir,
      reason: 'source-missing',
    });
    continue;
  }

  if (existsSync(stagingDir)) {
    rmSync(stagingDir, { recursive: true });
  }

  mkdirSync(stagingDir, { recursive: true });
  cpSync(sourceDir, stagingDir, { recursive: true });

  if (existsSync(zipPath)) {
    rmSync(zipPath);
  }

  const zipResult = spawnSync('zip', ['-rq', zipPath, '.'], {
    cwd: stagingDir,
    stdio: 'inherit',
  });

  if (zipResult.status !== 0) {
    console.error(`❌ Failed to create zip at ${zipPath}`);
    process.exit(zipResult.status ?? 1);
  }

  console.info(`✅ Prepared ${definition.description} assets at ${zipPath}`);

  manifestEntries.push({
    id: definition.id,
    stackName: definition.stackName,
    description: definition.description,
    status: 'prepared',
    sourceDist: sourceDir,
    stagingDir,
    zipPath,
  });
}

const destRoot = resolve(distDirectory, 'cdktf-outputs');
/**
 * Recursively copy only `outputs.json` files from srcRoot to destRoot,
 * preserving the relative directory structure.
 */
const copyOutputsJson = (srcRoot: string, dest: string): number => {
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
        const rel = relative(srcRoot, fullPath); // e.g. "stackA/outputs.json"
        const destPath = join(dest, rel);
        mkdirSync(dirname(destPath), { recursive: true });
        copyFileSync(fullPath, destPath);
        copied++;
      }
    }
  }

  return copied;
};

const outputsDirectory = resolve(packageRootDir, 'cdktf-outputs');
if (existsSync(outputsDirectory)) {
  mkdirSync(destRoot, { recursive: true });
  const count = copyOutputsJson(outputsDirectory, destRoot);

  if (count === 0) {
    console.warn('⚠️ No outputs.json files found to copy.');
  } else {
    console.info(`✅ Copied ${count} outputs.json file(s) to ${destRoot}`);
  }
} else {
  console.warn(
    '⚠️ cdktf-outputs directory not found. Skipping outputs.json copy.',
  );
}

const manifestPath = resolve(distDirectory, 'lambda-artifacts.manifest.json');
writeFileSync(
  manifestPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      artifacts: manifestEntries.map((entry) => ({
        ...entry,
        stagingDir: relative(packageRootDir, entry.stagingDir),
        sourceDist: relative(packageRootDir, entry.sourceDist),
        zipPath: entry.zipPath ? relative(packageRootDir, entry.zipPath) : null,
      })),
    },
    null,
    2,
  ),
  'utf8',
);
console.info(`🗂️  Wrote artifact manifest to ${manifestPath}`);
