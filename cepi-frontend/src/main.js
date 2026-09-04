import { createApp } from 'vue';
import App from './App.vue';
import router from './router.js';
import './style.css';
import { registerServiceWorker, initWebPush } from './pwa.js';
import { initOfflineQueue } from './api.js';
import { installNativeHttp, readyNative, isNative } from './native/index.js';
import { initNativePush, unregisterNativePush } from './native/push.js';

// Nativo: reescribir /api → backend absoluto ANTES de cualquier request.
installNativeHttp();

createApp(App).use(router).mount('#app');

// Nativo: ocultar splash + avisar a Capgo (OTA) que el bundle arrancó bien.
readyNative();

// PWA (web): service worker (shell offline + push) + cola offline. Web Push
// se suscribe si ya está concedido y tras login ('cepi:auth').
registerServiceWorker();
initOfflineQueue();
window.addEventListener('load', () => { initWebPush().catch(() => {}); });
window.addEventListener('cepi:auth', () => { initWebPush().catch(() => {}); });

// Nativo: push FCM/APNs. Se registra tras login y se desregistra al salir.
if (isNative()) {
  window.addEventListener('cepi:auth', () => { initNativePush().catch(() => {}); });
  window.addEventListener('cepi:logout', () => { unregisterNativePush().catch(() => {}); });
  // si ya hay sesión al abrir la app
  if (localStorage.getItem('cepi.jwt')) initNativePush().catch(() => {});
}
