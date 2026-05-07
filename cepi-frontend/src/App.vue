<template>
  <div class="app">
    <header class="topbar">
      <div class="header-left">
        <img
          class="logo"
          src="https://cepi.ec/wp-content/uploads/2022/12/logo-cepi-final-min.png"
          alt="CEPI Centro de la Piel"
        />
      </div>
      <div class="header-center">
        <strong class="brand">Asistente clínico</strong>
      </div>
      <div class="header-right">
        <span v-if="user" class="user">
          <span class="user-id">{{ user.email }} · {{ user.role }}</span>
          <button @click="toggleDark" :title="dark ? 'Modo claro' : 'Modo oscuro'">{{ dark ? '☀' : '☾' }}</button>
          <button @click="onLogout">Salir</button>
        </span>
      </div>
    </header>
    <main>
      <Login v-if="!authed" @logged-in="onLoggedIn" />
      <Chat   v-else        :user="user" />
    </main>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import Login from './components/Login.vue';
import Chat  from './components/Chat.vue';
import { whoami, logout } from './api.js';

const user = ref(null);
const authed = ref(false);
const dark = ref(localStorage.getItem('cepi.theme') === 'dark');

function applyTheme() {
  document.documentElement.dataset.theme = dark.value ? 'dark' : 'light';
}
function toggleDark() {
  dark.value = !dark.value;
  localStorage.setItem('cepi.theme', dark.value ? 'dark' : 'light');
  applyTheme();
}
applyTheme();

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
}

onMounted(refresh);
</script>

<style>
.app {
  display: flex;
  flex-direction: column;
  min-height: 100dvh;
  width: 100%;
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
}

@media (max-width: 640px) {
  .topbar { padding: 0 0.75rem; }
  .user-id { display: none; }
  main { padding: 0; }
}
</style>
