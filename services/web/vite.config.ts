import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, proxy API calls to the local API (dev/docker-compose.yml).
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', rewrite: (p) => p.replace(/^\/api/, '') },
    },
  },
});
