import { VitePluginNode } from 'vite-plugin-node';
import { baseConfig } from '@configs/vite-config';
import { defineConfig, loadEnv, UserConfig } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    ...baseConfig,
    plugins: [
      ...VitePluginNode({
        adapter: 'express',
        appPath: './src/index.ts',
        tsCompiler: 'esbuild',
      }),
    ],
  } as UserConfig;
});
