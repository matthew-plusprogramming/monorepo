import { VitePluginNode } from 'vite-plugin-node';
import { baseConfig } from '@configs/vite-config';
import { defineConfig, loadEnv, UserConfig } from 'vite';

const DEFAULT_PORT = 3000;

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    ...baseConfig,
    define: {
      __PORT__: parseInt(env.PORT) || DEFAULT_PORT,
      __TEST_DEFINE__: JSON.stringify(env.TEST_DEFINE),
    },
    server: {
      port: parseInt(env.PORT) || DEFAULT_PORT,
    },
    plugins: [
      ...VitePluginNode({
        adapter: 'express',
        appPath: './src/index.ts',
        tsCompiler: 'esbuild',
      }),
    ],
  } as UserConfig;
});
