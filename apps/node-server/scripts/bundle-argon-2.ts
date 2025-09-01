import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import { packageRootDir } from '../src/location';

const main = async (): Promise<void> => {
  const distDir = path.resolve(packageRootDir, 'dist');

  if (!existsSync(distDir) || !statSync(distDir).isDirectory()) {
    console.error(`dist directory not found: ${distDir}`);
    process.exit(1);
  }

  const npmCmd = 'npm';
  const npmCmdArgs = ['i', 'argon2', '--prefix', '.'];

  console.info(`Installing argon2 in ${distDir}...`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(npmCmd, npmCmdArgs, {
      cwd: distDir,
      stdio: 'inherit',
      env: { ...process.env },
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`❌ npm install exited with code ${code}`));
    });
  });

  const rmCmd = 'rm';
  const rmCmdArgs = ['-rf', 'package-lock.json', 'package.json'];

  console.info(
    `Removing package.json and package-lock.json from ${distDir}...`,
  );
  await new Promise<void>((resolve, reject) => {
    const child = spawn(rmCmd, rmCmdArgs, {
      cwd: distDir,
      stdio: 'inherit',
      env: { ...process.env },
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`❌ rm exited with code ${code}`));
    });
  });

  console.info('✅ argon2 installed successfully in dist.');
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
