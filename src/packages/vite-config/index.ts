import type { UserConfig } from 'vite';

export const baseConfig = {
  build: {
    target: 'es2024',
    sourcemap: false,
    minify: 'esbuild',
  },
} satisfies UserConfig;
