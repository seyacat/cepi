import { createApp } from 'vue';
import App from './App.vue';
import './style.css';
import { registerServiceWorker, initWebPush } from './pwa.js';
import { initOfflineQueue } from './api.js';

createApp(App).mount('#app');

// PWA: install the service worker (offline shell + push) and wire the offline
// send queue. Web Push subscribes silently if already granted, and re-subscribes
// after login (api.js dispatches 'cepi:auth').
registerServiceWorker();
initOfflineQueue();
window.addEventListener('load', () => { initWebPush().catch(() => {}); });
window.addEventListener('cepi:auth', () => { initWebPush().catch(() => {}); });
