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
        <Notifications v-if="user && !isPending" :user="user" @open="onNotifOpen" />
        <button
          v-if="user && (showAdmin || showProfile || !chatHeadActive)" type="button" class="top-burger"
          @click="showTopMenu = !showTopMenu" aria-label="Opciones" :aria-expanded="showTopMenu"
        >☰</button>
        <span v-if="user" class="user" :class="{ open: showTopMenu }">
          <span class="user-id">{{ user.email }} · {{ user.role }}</span>
          <select
            v-if="user.orgs && user.orgs.length > 1"
            class="org-switch" :value="user.org_id" :disabled="orgSwitching"
            title="Organización activa" @change="onSwitchOrg($event.target.value)"
          >
            <option v-for="o in user.orgs" :key="o.id" :value="o.id">🏥 {{ o.name }}</option>
          </select>
          <span v-else-if="user.orgs && user.orgs.length === 1" class="org-chip" title="Organización">🏥 {{ user.orgs[0].name }}</span>
          <button v-if="canInstall" class="install-btn" @click="installApp" title="Instalar la app en tu dispositivo">📲 Instalar app</button>
          <button v-if="showNotifOptin && !isPending" class="notif-optin" @click="enableNotifs(); showTopMenu = false" title="Activar notificaciones push">🔔 Activar</button>
          <button v-if="!isPending && !showProfile" @click="openProfile">👤 Perfil</button>
          <button v-if="isAdmin && !showAdmin" @click="showAdmin = true; showProfile = false; showTopMenu = false">Admin</button>
          <button v-if="showAdmin || showProfile" @click="goChat">Volver</button>
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
        <div v-if="showAdmin" class="admin-wrap">
          <div class="admin-tabs">
            <button :class="{ on: adminTab === 'users' }" @click="adminTab = 'users'">Usuarios</button>
            <button :class="{ on: adminTab === 'orgs' }" @click="adminTab = 'orgs'">Organizaciones</button>
          </div>
          <AdminOrgs v-if="adminTab === 'orgs'" />
          <AdminUsers v-else />
        </div>
        <Profile v-else-if="showProfile" :user="user" @back="goChat" @saved="onProfileSaved" @logout="onLogout" />
        <ChatShell v-else ref="chatShellRef" :user="user" @head="chatHeadActive = $event" />
      </template>
    </main>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted } from 'vue';
import Login from './components/Login.vue';
import Register from './components/Register.vue';
import VerifyEmail from './components/VerifyEmail.vue';
import AdminUsers from './components/AdminUsers.vue';
import Profile from './components/Profile.vue';
import AdminOrgs from './components/AdminOrgs.vue';
import PendingApproval from './components/PendingApproval.vue';
import ChatShell from './components/ChatShell.vue';
import Notifications from './components/Notifications.vue';
import { whoami, logout, switchOrg } from './api.js';
import { enableWebPush } from './pwa.js';
import { bindBackState } from './useBackStack.js';

const user = ref(null);
const authed = ref(false);
const showAdmin = ref(false);
const showProfile = ref(false);          // vista "Mi perfil"
const showTopMenu = ref(false);          // burger de acciones del topbar (mobile)
const chatHeadActive = ref(false);       // el chat muestra su propio burger (paciente abierto)
const chatShellRef = ref(null);          // para abrir un paciente desde una notificación
// Si el chat toma el header, cierra el menú del topbar (su burger desaparece).
watch(chatHeadActive, (v) => { if (v) showTopMenu.value = false; });

function openProfile() {
  showProfile.value = true;
  showAdmin.value = false;
  showTopMenu.value = false;
}
// "Volver" siempre lleva al chat (cierra Admin/Perfil y el menú).
function goChat() {
  showAdmin.value = false;
  showProfile.value = false;
  showTopMenu.value = false;
}
function onProfileSaved(u) {
  // El perfil devolvió el user actualizado (nombre/teléfono/cédula) → refrescar.
  if (u) user.value = { ...user.value, ...u };
}
// Click en una notificación → ir al chat y abrir el paciente que la origina.
async function onNotifOpen({ id, name }) {
  goChat();                              // asegura que ChatShell esté montado
  await nextTick();
  chatShellRef.value?.openPatientById(id, name);
}
const adminTab = ref('users');
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

// ── PWA: instalar la app (Add to Home Screen) ───────────────────────────────
// El navegador emite 'beforeinstallprompt' cuando la PWA es instalable; lo
// guardamos para dispararlo desde el botón. En iOS no existe ese evento → se
// muestra igual y se dan las instrucciones manuales.
const deferredInstall = ref(null);
const canInstall = computed(() => !isStandalone && (!!deferredInstall.value || isIosDevice));
// Registrar temprano (en setup, no en onMounted) para no perder el evento, que
// el navegador puede emitir apenas carga la página.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall.value = e; });
  window.addEventListener('appinstalled', () => { deferredInstall.value = null; flashNotif('App instalada ✔'); });
}
async function installApp() {
  showTopMenu.value = false;
  if (deferredInstall.value) {
    deferredInstall.value.prompt();
    try { await deferredInstall.value.userChoice; } catch { /* usuario canceló */ }
    deferredInstall.value = null;
    return;
  }
  if (isIosDevice) {
    flashNotif('En iPhone/iPad: toca Compartir → "Añadir a pantalla de inicio" para instalar la app.');
  }
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
    // Conservar/renovar el token en cada carga (sesión deslizante): así el
    // refresco NO fuerza un re-login y no se golpea el rate-limit de /login.
    if (r?.token) localStorage.setItem('cepi.jwt', r.token);
    user.value = r?.user || null;
    authed.value = !!user.value;
  } catch {
    authed.value = false;
  }
}

function onLoggedIn() {
  refresh();
}

// Cambiar de organización activa → reemite token y recarga (refetch por org).
const orgSwitching = ref(false);
async function onSwitchOrg(orgId) {
  if (!orgId || orgId === user.value?.org_id || orgSwitching.value) return;
  orgSwitching.value = true;
  try { await switchOrg(orgId); window.location.reload(); }
  catch (e) { orgSwitching.value = false; flashNotif('No se pudo cambiar de organización.'); }
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
.header-right { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.org-switch { border: 1px solid rgba(255,255,255,.55); background: rgba(255,255,255,.15); color: #fff; border-radius: 14px; padding: 4px 10px; font-size: 0.82rem; font-weight: 600; cursor: pointer; max-width: 200px; }
.org-switch option { color: #1e293b; }
.org-chip { font-size: 0.8rem; font-weight: 600; opacity: .9; white-space: nowrap; }
.admin-wrap { height: 100%; overflow: auto; }
.admin-tabs { display: flex; gap: 8px; padding: 12px 16px 0; }
.admin-tabs button { border: 1px solid var(--border); background: #fff; color: var(--text); border-radius: 8px 8px 0 0; padding: 8px 16px; font-weight: 600; cursor: pointer; }
.admin-tabs button.on { background: var(--accent); color: #fff; border-color: var(--accent); }
.install-btn { border: 1px solid #34d399; background: #d1fae5; color: #065f46; border-radius: 16px; padding: 4px 12px; font-weight: 700; font-size: 0.82rem; cursor: pointer; white-space: nowrap; }
.install-btn:hover { background: #a7f3d0; }
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
/* Burger de acciones del topbar — solo móvil. */
.top-burger {
  display: none; flex-shrink: 0;
  border: 1.5px solid rgba(255,255,255,.45); background: rgba(255,255,255,.18); color: #fff;
  border-radius: 8px; width: 34px; height: 32px; font-size: 1.05rem; line-height: 1; cursor: pointer;
}
.top-burger:hover { background: rgba(255,255,255,.3); }
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

  /* Las acciones del topbar pasan a un menú desplegable (burger). */
  .header-right { position: relative; }
  .top-burger { display: inline-flex; align-items: center; justify-content: center; }
  .topbar .user {
    display: none;
    position: absolute; top: calc(100% + 6px); right: 0; z-index: 90;
    flex-direction: column; align-items: stretch; gap: 6px;
    background: #fff; border: 1px solid var(--border); border-radius: 10px;
    box-shadow: 0 12px 30px rgba(0,0,0,.28); padding: 8px; min-width: 210px; max-width: 84vw;
  }
  .topbar .user.open { display: flex; }
  /* Controles del menú: texto oscuro sobre blanco (ya no la banda del header). */
  .topbar .user .org-switch,
  .topbar .user button {
    color: var(--text); background: #fff; border: 1px solid var(--border);
    border-radius: 8px; text-align: left; width: 100%; max-width: none; padding: 8px 10px; font-weight: 600;
  }
  .topbar .user .org-switch option { color: var(--text); }
  .topbar .user button:hover { background: var(--bg); border-color: var(--border); }
  .topbar .user .org-chip { color: var(--text-muted); }
}
</style>
