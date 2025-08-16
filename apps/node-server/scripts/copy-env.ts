import { cpSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const envFile = resolve(__dirname, '../.env');
const distDirectory = resolve(__dirname, '../dist');

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
