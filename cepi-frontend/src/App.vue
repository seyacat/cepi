<template>
  <div class="app">
    <header class="topbar">
      <strong>CEPI · Asistente clínico</strong>
      <span v-if="user" class="user">{{ user.email }} ({{ user.role }})
        <button @click="toggleDark" :title="dark ? 'Modo claro' : 'Modo oscuro'">{{ dark ? '☀' : '☾' }}</button>
        <button @click="onLogout">Salir</button>
      </span>
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
.app { max-width: 960px; margin: 0 auto; }
.topbar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 20px; border-bottom: 1px solid #e2e8f0; background: #fff;
}
.topbar .user { font-size: 14px; color: #64748b; display: flex; gap: 12px; align-items: center; }
.topbar .user button {
  background: transparent; border: 1px solid #cbd5e1; padding: 4px 10px; border-radius: 4px; color: #475569;
}
main { padding: 24px 20px; }
</style>
