/**
 * PWA layer for the CEPI frontend (TELEMEDICINA.md §6C):
 *   - service worker registration (offline shell + push handling)
 *   - Web Push subscription wired to the generic /api/push/subscribe endpoint
 *
 * Dependency-free: no vite-plugin-pwa. The service worker is a static file in
 * public/sw.js. Web Push degrades to a silent no-op when the backend has no
 * VAPID key configured (GET /api/push/vapid-public-key returns null).
 */

function getJwt() {
  return (typeof localStorage !== 'undefined' && localStorage.getItem('cepi.jwt')) || '';
}

export async function registerServiceWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js');
  } catch (e) {
    console.warn('[pwa] service worker registration failed:', e?.message || e);
    return null;
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function fetchVapidPublicKey() {
  const jwt = getJwt();
  if (!jwt) return null;
  try {
    const r = await fetch('/api/push/vapid-public-key', { headers: { Authorization: `Bearer ${jwt}` } });
    if (!r.ok) return null;
    const b = await r.json();
    return b?.publicKey || null;
  } catch { return null; }
}

async function subscribeAndPersist(publicKey) {
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }
  const json = sub.toJSON();
  const jwt = getJwt();
  await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) },
    body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, user_agent: navigator.userAgent }),
  });
}

/**
 * Silent init: subscribe only if the user already granted notifications.
 * Never prompts on load (avoids the permission-prompt-on-startup anti-pattern).
 */
export async function initWebPush() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
  if (Notification.permission !== 'granted') return;
  const publicKey = await fetchVapidPublicKey();
  if (!publicKey) return;
  try { await subscribeAndPersist(publicKey); }
  catch (e) { console.warn('[pwa] web push subscribe failed:', e?.message || e); }
}

/**
 * Explicit opt-in (call from a button): prompts for permission, then subscribes.
 * Returns a short status string for the UI.
 */
export async function enableWebPush() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    return 'Este navegador no soporta notificaciones push.';
  }
  const publicKey = await fetchVapidPublicKey();
  if (!publicKey) return 'El servidor no tiene notificaciones push configuradas (VAPID).';
  let perm = Notification.permission;
  if (perm === 'default') { try { perm = await Notification.requestPermission(); } catch { return 'No se pudo pedir permiso.'; } }
  if (perm !== 'granted') return 'Permiso de notificaciones denegado.';
  try { await subscribeAndPersist(publicKey); return 'Notificaciones activadas.'; }
  catch (e) { return `No se pudo suscribir: ${e?.message || e}`; }
}
