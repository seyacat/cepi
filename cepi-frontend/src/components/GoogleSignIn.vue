<template>
  <!-- Nativo (Capacitor): botón propio + Credential Manager. El script web de
       Google (GIS) no sirve acá: el origen del WebView es https://localhost y
       Google además bloquea el flujo OAuth dentro de WebViews embebidos. -->
  <button v-if="isNative" type="button" class="gnative" :disabled="busy" @click="loginNative">
    <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/>
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/>
      <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"/>
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/>
    </svg>
    <span>{{ busy ? 'Conectando…' : 'Continuar con Google' }}</span>
  </button>

  <!-- Web: botón renderizado por Google Identity Services -->
  <div v-else ref="btn" class="gbtn"></div>

  <p v-if="error" class="gerr">{{ error }}</p>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { Capacitor } from '@capacitor/core';

const emit = defineEmits(['credential']);
const btn = ref(null);
const error = ref('');
const busy = ref(false);
const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';
const isNative = Capacitor.isNativePlatform();

// ── Nativo ────────────────────────────────────────────────────────────────
// El idToken que devuelve Credential Manager lleva aud = webClientId, que es
// justo lo que valida el backend (authService.verifyGoogleIdToken). Por eso
// se pasa el client id WEB, no uno de Android.
let socialReady = null;

async function initNative() {
  if (!socialReady) {
    socialReady = (async () => {
      const { SocialLogin } = await import('@capgo/capacitor-social-login');
      await SocialLogin.initialize({ google: { webClientId: CLIENT_ID } });
      return SocialLogin;
    })();
  }
  return socialReady;
}

async function loginNative() {
  if (!CLIENT_ID) { error.value = 'Falta configurar el ID de cliente de Google.'; return; }
  error.value = '';
  busy.value = true;
  try {
    const SocialLogin = await initNative();
    // Sin `scopes`: pedirlos explícitamente exige modificar MainActivity (el plugin
    // lanza "You CANNOT use scopes without modifying the main activity"). El flujo
    // por defecto ya devuelve un idToken con email y perfil, que es lo que valida
    // el backend, así que no hacen falta.
    const res = await SocialLogin.login({ provider: 'google', options: {} });
    const idToken = res?.result?.idToken;
    if (!idToken) throw new Error('Google no devolvió un token de identidad.');
    emit('credential', idToken);
  } catch (e) {
    if (e?.code === 'USER_CANCELLED') { busy.value = false; return; }  // cancelar no es error
    error.value = 'No se pudo ingresar con Google. Intenta de nuevo o usa tu email.';
    // Sin volcar el objeto completo: puede arrastrar tokens al log.
    console.error('[GoogleSignIn nativo] code=' + (e?.code ?? 'n/a') +
                  ' message=' + (e?.message ?? 'n/a'));
  } finally {
    busy.value = false;
  }
}

// ── Web ───────────────────────────────────────────────────────────────────
function loadGis() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve();
    let s = document.getElementById('gis-script');
    if (s) { s.addEventListener('load', () => resolve()); s.addEventListener('error', reject); return; }
    s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true; s.defer = true; s.id = 'gis-script';
    s.onload = () => resolve();
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

onMounted(async () => {
  if (isNative) return;
  if (!CLIENT_ID) return;  // Google deshabilitado si no hay client id en build time
  try {
    await loadGis();
    window.google.accounts.id.initialize({
      client_id: CLIENT_ID,
      callback: (resp) => { if (resp?.credential) emit('credential', resp.credential); },
    });
    window.google.accounts.id.renderButton(btn.value, {
      theme: 'outline', size: 'large', width: 300, text: 'continue_with', shape: 'pill',
    });
  } catch (e) {
    // Antes esto se tragaba el fallo en silencio y dejaba un hueco vacío.
    error.value = 'El ingreso con Google no está disponible en este momento.';
    console.error('[GoogleSignIn web]', e);
  }
});
</script>

<style scoped>
.gbtn { display: flex; justify-content: center; min-height: 40px; }
.gnative {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: .6rem;
  width: 100%;
  max-width: 300px;
  margin: 0 auto;
  padding: .7rem 1rem;
  background: #fff;
  color: #3c4043;
  border: 1px solid #dadce0;
  border-radius: 999px;
  font: 500 .95rem/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  cursor: pointer;
}
.gnative:disabled { opacity: .6; cursor: default; }
.gerr {
  margin: .5rem 0 0;
  text-align: center;
  font-size: .85rem;
  color: #b3261e;
}
</style>
