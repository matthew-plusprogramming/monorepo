import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import { baseConfig } from '@configs/vite-config';

// TODO: MAKE THE CONFIGS BUILD AS WELL SO THEY CAN BE IMPORTED CROSS PROJECT
export default defineConfig({
  ...baseConfig,
  plugins: [react()],
});
