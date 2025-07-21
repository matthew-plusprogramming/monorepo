import '@dotenvx/dotenvx/config';

import { VitePluginNode } from 'vite-plugin-node';
import { baseConfig } from '@configs/vite-config';
import { defineConfig, UserConfig } from 'vite';

const port = process.env.PORT;

if (!port) {
  throw new Error('Environment variable PORT is not set');
}

if (isNaN(Number(port))) {
  throw new Error('Environment variable PORT must be a number');
}

export default defineConfig(({ mode }) => {
  return {
    ...baseConfig,
    server: {
      port: parseInt(port),
    },
    plugins: [
      ...VitePluginNode({
        adapter: 'express',
        appPath: './src/index.ts',
        tsCompiler: 'esbuild',
        initAppOnBoot: true,
      }),
    ],
    build: {
      minify: mode === 'production' ? 'esbuild' : false,
    },
  } as UserConfig;
});
