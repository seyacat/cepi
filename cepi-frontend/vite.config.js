import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Frontend talks to three backends, all proxied so the browser (and the
// ngrok tunnel) sees a single same-origin app:
//   - TodoERP (3001)  for /api/auth, /api/entities, /api/attachments
//   - cepi-bot (3002) for /api/bot/chat
//   - cepi-bot WhatsApp webhook (9997) for /whatsapp
//   - cepi-bot Telegram webhook (9998) for /telegram
// ngrok points at this dev server (5174), which fans out by path — so a
// single ngrok domain serves the frontend, the API and the chat webhooks
// without nginx.
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5174,
    // Allow the ngrok dev domain to reach the Vite server (Vite blocks
    // unknown Host headers by default).
    allowedHosts: ['.ngrok-free.app'],
    proxy: {
      // El chat va a cepi-bot (3002). Debe ir ANTES del catch-all /api.
      '/api/bot':  { target: 'http://localhost:3002', changeOrigin: true },
      // Resto del API (auth, entities, attachments, security, api-keys,
      // chatter, accounting, forms…) → TodoERP (3001).
      '/api':      { target: 'http://localhost:3001', changeOrigin: true },
      // Webhook de WhatsApp → listener de cepi-bot (9997).
      '/whatsapp': { target: 'http://localhost:9997', changeOrigin: true },
      // Webhook de Telegram → listener de cepi-bot (9998).
      '/telegram': { target: 'http://localhost:9998', changeOrigin: true },
      // UI de TodoERP servida bajo /erp/ (corre con VITE_BASE=/erp/ en :5173).
      '/erp':      { target: 'http://localhost:5173', changeOrigin: true, ws: true },
    },
  },
});
