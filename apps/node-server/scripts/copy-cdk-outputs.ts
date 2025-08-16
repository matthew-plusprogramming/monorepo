import { cpSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ENV = process.env.ENV;
if (!ENV) {
  console.error('❌ ENV is not set. Please set the ENV environment variable.');
  process.exit(1);
}

const outputsDirectory = resolve(
  __dirname,
  '../../../cdk/monorepo-cdk/cdktf.out',
);

const distDirectory = resolve(__dirname, '../dist');

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

cpSync(outputsDirectory, `${distDirectory}/cdktf.out`, { recursive: true });
