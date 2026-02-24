import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import { buildChildEnv } from '../../../scripts/utils/child-env.mjs';
import { processLimiter } from '../../../scripts/utils/process-limiter.mjs';
import { packageRootDir } from '../src/location';

const main = async (): Promise<void> => {
  const distDir = path.resolve(packageRootDir, 'dist');

  if (!existsSync(distDir) || !statSync(distDir).isDirectory()) {
    console.error(`dist directory not found: ${distDir}`);
    process.exit(1);
  }

  const npmCmd = 'env';
  const npmCmdArgs = [
    'npm_config_force=true',
    'npm',
    'i',
    '@node-rs/argon2',
    '@node-rs/argon2-linux-x64-gnu',
    '--prefix',
    '.',
  ];

  // AC5.6: Wrap async subprocess calls with acquire/release (try/finally)
  console.info(`Installing argon2 in ${distDir}...`);
  await processLimiter.acquire();
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(npmCmd, npmCmdArgs, {
        cwd: distDir,
        stdio: 'inherit',
        // AC3.9: Use minimal env allowlist instead of full process.env
        env: buildChildEnv() as NodeJS.ProcessEnv,
      });

      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`npm install exited with code ${code}`));
      });
    });
  } finally {
    processLimiter.release();
  }

  const rmCmd = 'rm';
  const rmCmdArgs = [
    '-rf',
    'package-lock.json',
    'package.json',
    'node_modules/@node-rs/argon2-darwin-arm64',
  ];

  console.info(
    `Removing package.json and package-lock.json from ${distDir}...`,
  );
  await processLimiter.acquire();
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(rmCmd, rmCmdArgs, {
        cwd: distDir,
        stdio: 'inherit',
        // AC3.9: Use minimal env allowlist instead of full process.env
        env: buildChildEnv() as NodeJS.ProcessEnv,
      });

      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`rm exited with code ${code}`));
      });
    });
  } finally {
    processLimiter.release();
  }

  console.info('✅ argon2 installed successfully in dist.');
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
