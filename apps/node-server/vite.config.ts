import '@dotenvx/dotenvx/config';

import { baseConfig } from '@configs/vite-config';
import { defineConfig, UserConfig } from 'vite';

const port = process.env.PORT;

if (!port) {
  throw new Error('Environment variable PORT is not set');
}

if (isNaN(Number(port))) {
  throw new Error('Environment variable PORT must be a number');
}

export default defineConfig(({ mode, command }) => {
  const config = {
    ...baseConfig,
    server: {
      port: parseInt(port),
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
      rollupOptions: {
        input: 'src/index.ts',
        output: {
          format: 'cjs',
        },
      },
    },
  } satisfies UserConfig;

  return config;
});
