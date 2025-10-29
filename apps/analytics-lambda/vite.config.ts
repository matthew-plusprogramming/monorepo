import '@dotenvx/dotenvx/config';

import { baseConfig } from '@configs/vite-config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, UserConfig } from 'vite';

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
        input: 'src/index.ts',
        output: {
          format: 'cjs',
        },
        external: [
          /^@configs\//,
          /^@types\//,
          /^eslint.*/,
          /^@aws-sdk.*/,
          'concurrently',
          'cross-env',
          'jiti',
        ],
      },
    },
    ssr: {
      noExternal: true,
      external: ['concurrently', 'cross-env', 'jiti'],
    },
  } satisfies UserConfig;

  return config;
});
