import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/v1': {
        target: 'http://localhost:18081',
        changeOrigin: true,
      },
      '/healthz': {
        target: 'http://localhost:18081',
        changeOrigin: true,
      },
    },
  },
});
