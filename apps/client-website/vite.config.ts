import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import { baseConfig } from '@configs/vite-config';

export default defineConfig({
  ...baseConfig,
  plugins: [react()],
  css: {
    modules: {
      localsConvention: 'camelCaseOnly',
    },
  },
});
