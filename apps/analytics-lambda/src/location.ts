import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const srcDir = __dirname;
export const packageRootDir = resolve(__dirname, '..');
export const monorepoRootDir = resolve(packageRootDir, '../..');
