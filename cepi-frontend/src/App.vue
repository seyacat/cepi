<template>
  <div class="app">
    <PendingApproval v-if="authed && isPending" @logout="onLogout" />
    <template v-else>
    <header class="topbar">
      <div class="header-left">
        <img
          class="logo"
          src="/images/logo-cepi.png"
          alt="CEPI Centro de la Piel"
        />
      </div>
      <div class="header-center">
        <strong class="brand">Telemedicina</strong>
      </div>
      <div class="header-right">
        <span v-if="user" class="user">
          <span class="user-id">{{ user.email }} · {{ user.role }}</span>
          <Notifications v-if="!isPending" />
          <button v-if="showNotifOptin && !isPending" class="notif-optin" @click="enableNotifs" title="Activar notificaciones push">🔔 Activar</button>
          <button v-if="isAdmin" @click="showAdmin = !showAdmin">{{ showAdmin ? 'Chat' : 'Admin' }}</button>
          <button @click="onLogout">Salir</button>
        </span>
      </div>
    </header>
    <div v-if="notifMsg" class="notif-toast" @click="notifMsg = ''">{{ notifMsg }}</div>
    <main>
      <VerifyEmail v-if="view === 'verify'" :token="verifyToken" @done="goLogin" />
      <template v-else-if="!authed">
        <Register v-if="view === 'register'" @go-login="view = 'login'" />
        <Login v-else @logged-in="onLoggedIn" @go-register="view = 'register'" />
      </template>
      <template v-else>
        <AdminUsers v-if="showAdmin" />
        <ChatShell v-else :user="user" />
      </template>
    </main>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import Login from './components/Login.vue';
import Register from './components/Register.vue';
import VerifyEmail from './components/VerifyEmail.vue';
import AdminUsers from './components/AdminUsers.vue';
import PendingApproval from './components/PendingApproval.vue';
import ChatShell from './components/ChatShell.vue';
import Notifications from './components/Notifications.vue';
import { whoami, logout } from './api.js';
import { enableWebPush } from './pwa.js';
import { bindBackState } from './useBackStack.js';

const user = ref(null);
const authed = ref(false);
const showAdmin = ref(false);
const isAdmin = computed(() => !!user.value?.permissions?.includes('*:*:*:*'));
const isPending = computed(() => authed.value && user.value?.role === 'pendiente');

// ── Notificaciones push (opt-in) ────────────────────────────────────────────
const notifPerm = ref(typeof Notification !== 'undefined' ? Notification.permission : 'denied');
const notifMsg = ref('');
let notifTimer = null;
const isIosDevice = /iphone|ipad|ipod/i.test((typeof navigator !== 'undefined' && navigator.userAgent) || '');
const isStandalone = typeof window !== 'undefined'
  && ((window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true);
// Mostrar "Activar" mientras no esté concedido (y no sea iOS sin instalar, donde primero hay que instalar).
const showNotifOptin = computed(() => !!user.value && notifPerm.value !== 'granted');
function flashNotif(m) { notifMsg.value = m; if (notifTimer) clearTimeout(notifTimer); notifTimer = setTimeout(() => { notifMsg.value = ''; }, 7000); }
async function enableNotifs() {
  if (isIosDevice && !isStandalone) {
    flashNotif('En iPhone/iPad: toca Compartir → "Añadir a pantalla de inicio", abre la app desde el ícono y vuelve a tocar "Activar".');
    return;
  }
  const msg = await enableWebPush();
  notifPerm.value = typeof Notification !== 'undefined' ? Notification.permission : 'denied';
  flashNotif(msg);
}
// Lightweight view routing (no vue-router): a ?verify=<token> link lands on the
// verification view; otherwise the login/register toggle is shown.
const _params = new URLSearchParams(window.location.search);
const verifyToken = ref(_params.get('verify') || '');
const view = ref(verifyToken.value ? 'verify' : 'login');

function goLogin() {
  verifyToken.value = '';
  view.value = 'login';
  try { history.replaceState({}, '', '/'); } catch { /* */ }
}

// Device/browser Back navigates within the app (register/verify/admin) instead
// of leaving the page. The chat list↔detail Back is handled inside ChatShell.
bindBackState(() => view.value === 'register', () => { view.value = 'login'; });
bindBackState(() => view.value === 'verify', () => { goLogin(); }, { immediate: true });
bindBackState(() => showAdmin.value, () => { showAdmin.value = false; });
// Tema claro fijo por ahora (se quitó el toggle de modo oscuro).
document.documentElement.dataset.theme = 'light';

async function refresh() {
  if (!localStorage.getItem('cepi.jwt')) { authed.value = false; return; }
  try {
    const r = await whoami();
    user.value = r?.user || null;
    authed.value = !!user.value;
  } catch {
    authed.value = false;
  }
}

function onLoggedIn() {
  refresh();
}

function onLogout() {
  logout();
  user.value = null;
  authed.value = false;
  showAdmin.value = false;
}

onMounted(refresh);
</script>

<style>
.app {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  width: 100%;
  overflow: hidden;
}
.topbar {
  width: 100%;
  height: var(--header-h);
  flex-shrink: 0;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  padding: 0 1.25rem;
  background: var(--accent-band);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  color: #fff;
}
.header-left  { display: flex; align-items: center; }
.header-center { display: flex; align-items: center; justify-content: center; }
.header-right { display: flex; align-items: center; justify-content: flex-end; }
.notif-optin { border: 1px solid #facc15; background: #fef9c3; color: #854d0e; border-radius: 16px; padding: 4px 12px; font-weight: 700; font-size: 0.82rem; cursor: pointer; white-space: nowrap; }
.notif-optin:hover { background: #fde68a; }
.notif-toast {
  position: fixed; top: 64px; left: 50%; transform: translateX(-50%); z-index: 1200;
  max-width: min(520px, 92vw); background: #1e293b; color: #fff; border-radius: 10px;
  padding: 12px 16px; font-size: 0.88rem; line-height: 1.4; box-shadow: 0 10px 30px rgba(0,0,0,.35); cursor: pointer;
}

.logo { height: 38px; object-fit: contain; display: block; }
.brand { color: #fff; letter-spacing: 0.02em; font-size: 1rem; }

.topbar .user {
  display: flex; gap: 10px; align-items: center;
  font-size: 0.82rem; color: #fff;
}
.user-id { opacity: 0.92; }
.topbar .user button {
  background: rgba(255,255,255,0.18);
  color: #fff;
  border: 1.5px solid rgba(255,255,255,0.45);
  padding: 0.3rem 0.85rem;
  border-radius: 20px;
  font-weight: 700;
  font-size: 0.78rem;
  letter-spacing: 0.01em;
  transition: background 0.2s, border-color 0.2s;
}
.topbar .user button:hover {
  background: rgba(255,255,255,0.30);
  border-color: rgba(255,255,255,0.7);
}

main {
  flex: 1;
  min-height: 0;
  padding: 12px;
  width: 100%;
  overflow: hidden;
}

@media (max-width: 640px) {
  .topbar { padding: 0 0.75rem; }
  .user-id { display: none; }
  main { padding: 0; }
}
</style>
