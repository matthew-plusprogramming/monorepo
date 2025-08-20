import { cpSync, existsSync } from 'fs';
import { resolve } from 'path';

import { packageRootDir } from '../../../cdk/backend-server-cdk/src/location';

const envFile = resolve(packageRootDir, '.env');
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

cpSync(envFile, `${distDirectory}/.env`);
console.info('✅ .env file copied to dist directory');
