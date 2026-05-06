import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Frontend talks to two backends:
//   - TodoERP (3001) for /api/auth and /api/entities
//   - cepi-bot (3002) for /api/bot/chat
// In dev we proxy both so the browser sees a same-origin app.
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5174,
    proxy: {
      '/api/auth':     { target: 'http://localhost:3001', changeOrigin: true },
      '/api/entities': { target: 'http://localhost:3001', changeOrigin: true },
      '/api/bot':      { target: 'http://localhost:3002', changeOrigin: true },
    },
  },
});
