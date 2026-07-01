// Capa nativa (Capacitor). En web todo esto es no-op — el build web sigue igual.
import { Capacitor } from '@capacitor/core';

// En la app nativa el bundle corre en capacitor://localhost, así que las
// llamadas relativas /api NO llegan al backend: apuntamos al backend real.
export const API_BASE = Capacitor.getPlatform() === 'web'
  ? ''
  : (import.meta.env.VITE_NATIVE_API_BASE || 'https://telemedicina.cepi.ec');

export const isNative = () => Capacitor.getPlatform() !== 'web';

// Reescribe cualquier fetch('/api…') → `${API_BASE}/api…` cuando corre nativo.
// Un solo interceptor cubre TODOS los fetch de la app (api.js + fetches sueltos)
// sin tocar cada archivo. Debe instalarse antes del primer request.
export function installNativeHttp() {
  if (!isNative() || typeof window === 'undefined') return;
  const orig = window.fetch.bind(window);
  window.fetch = (input, init) => {
    try {
      if (typeof input === 'string' && input.startsWith('/api')) {
        input = API_BASE + input;
      } else if (input instanceof Request && input.url.startsWith('/api')) {
        input = new Request(API_BASE + input.url, input);
      }
    } catch { /* deja pasar tal cual */ }
    return orig(input, init);
  };
}

// Splash + OTA: oculta el splash y avisa a Capgo que el bundle arrancó bien
// (si no se llama notifyAppReady, el updater hace rollback del OTA).
export async function readyNative() {
  if (!isNative()) return;
  try {
    const { SplashScreen } = await import('@capacitor/splash-screen');
    await SplashScreen.hide();
  } catch { /* plugin ausente */ }
  try {
    const { CapacitorUpdater } = await import('@capgo/capacitor-updater');
    await CapacitorUpdater.notifyAppReady();
  } catch { /* updater ausente */ }
}
