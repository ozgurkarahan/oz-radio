import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Test servers shared by parallel Playwright runs set OZ_VITE_HMR=off, so an edit never reloads a page under test.
    ...(process.env.OZ_VITE_HMR === 'off' ? { hmr: false, ws: false as const } : {}),
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
