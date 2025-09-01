import '@dotenvx/dotenvx/config';

import { baseConfig } from '@configs/vite-config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, UserConfig } from 'vite';
import z from 'zod';

const lambda = process.env.LAMBDA;
const port = process.env.PORT;

const lambdaParsed = z.stringbool().safeParse(lambda);
const portParsed = z.coerce.number().safeParse(port);

if (!portParsed.success) {
  throw new Error('Environment variable PORT is not set or is not number');
}
if (!lambdaParsed.success) {
  throw new Error('Environment variable LAMBDA is not set or is not boolean');
}

if (isNaN(Number(port))) {
  throw new Error('Environment variable PORT must be a number');
}

export default defineConfig(({ mode, command }) => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

  const config = {
    ...baseConfig,
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
      },
    },
    server: {
      port: portParsed.data,
    },
    define: {
      __BUNDLED__: command === 'build',
    },
    plugins: [],
    build: {
      minify: mode === 'production' ? 'esbuild' : false,
      target: 'es2024',
      ssr: true,
      outDir: 'dist',
      emptyOutDir: mode !== 'dev',
      rollupOptions: {
        input: lambdaParsed.data ? 'src/lambda.ts' : 'src/index.ts',
        output: {
          format: 'cjs',
        },
        external: [
          /^@aws-sdk\//,
          /^@configs\//,
          /^@types\//,
          /^eslint.*/,
          '@node-rs/argon2',
          'concurrently',
          'cross-env',
          'jiti',
        ],
      },
    },
    ssr: {
      noExternal: true,
      external: ['@node-rs/argon2', 'concurrently', 'cross-env', 'jiti'],
    },
  } satisfies UserConfig;

  return config;
});
