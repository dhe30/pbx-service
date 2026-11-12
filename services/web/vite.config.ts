import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// In dev, proxy API calls to the local API (dev/docker-compose.yml). To try the web (e.g. the
// softphone) against a deployed backend instead:
//   API_PROXY_TARGET=https://<group domain> npm run dev -w @pbx/web
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [tailwindcss(), react()],
  server: {
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
        cookiePathRewrite: { '/auth': '/api/auth' },
        cookieDomainRewrite: '',
      },
    },
  },
});
