import { cpSync, existsSync } from 'node:fs';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { packageRootDir } from '../src/location';

const envFile = resolve(packageRootDir, '.env');
const additionalEnvFile =
  process.env.ENV === 'production'
    ? resolve(packageRootDir, '.env.production')
    : resolve(packageRootDir, '.env.dev');
const distDirectory = resolve(packageRootDir, 'dist');

if (!existsSync(distDirectory)) {
  console.error('❌ Dist directory not found. Did you build?');
  process.exit(1);
}

if (!existsSync(envFile)) {
  console.error('❌ .env file not found');
  // Do not cause build to fail
  process.exit(0);
}

if (!existsSync(additionalEnvFile)) {
  console.error(`❌ ${additionalEnvFile} file not found`);
  // Do not cause build to fail
  process.exit(0);
}

cpSync(envFile, `${distDirectory}/.env`);

// Append to .env
const additionalEnvContent = readFileSync(additionalEnvFile, 'utf-8');
appendFileSync(`${distDirectory}/.env`, `\n${additionalEnvContent}`);

console.info('✅ .env file copied to dist directory');
