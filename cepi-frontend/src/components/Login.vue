<template>
  <form class="card" @submit.prevent="submit">
    <h2>Ingresar</h2>
    <label>Email
      <input v-model="email" type="email" autocomplete="username" required />
    </label>
    <label>Contraseña
      <input v-model="password" type="password" autocomplete="current-password" required />
    </label>
    <button type="submit" :disabled="busy">{{ busy ? 'Ingresando…' : 'Ingresar' }}</button>
    <p v-if="error" class="error">{{ error }}</p>
    <p class="hint">Dev: admin@erp.com / Admin123!</p>
  </form>
</template>

<script setup>
import { ref } from 'vue';
import { login } from '../api.js';

const emit = defineEmits(['logged-in']);
const email = ref('admin@erp.com');
const password = ref('Admin123!');
const busy  = ref(false);
const error = ref('');

async function submit() {
  busy.value = true;
  error.value = '';
  try {
    await login(email.value, password.value);
    emit('logged-in');
  } catch (e) {
    error.value = e.message || String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.card {
  max-width: 360px; margin: 60px auto; padding: 24px;
  background: var(--bot-bg, #fff);
  border: 1px solid var(--border);
  border-radius: 8px;
  display: flex; flex-direction: column; gap: 12px;
  color: var(--text);
}
.card h2 { margin: 0 0 8px; color: var(--accent); }
label { display: flex; flex-direction: column; gap: 4px; font-size: 14px; color: var(--text-muted); }
input {
  padding: 8px 10px; border: 1px solid var(--border); border-radius: 4px;
  font-size: 14px; background: var(--bg); color: var(--text);
}
input:focus { outline: none; border-color: var(--accent); }
button {
  padding: 10px 14px; background: var(--accent); color: #fff; border: none;
  border-radius: 4px; font-weight: 600; cursor: pointer;
  transition: background .15s ease;
}
button:hover:not([disabled]) { background: var(--accent-hover, #4da8cf); }
button[disabled] { opacity: .6; cursor: not-allowed; }
.error { color: #dc2626; font-size: 13px; margin: 4px 0 0; }
.hint  { color: var(--text-muted); font-size: 12px; margin: 4px 0 0; }
</style>
