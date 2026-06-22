<template>
  <div class="card">
    <h2>Verificación de cuenta</h2>
    <p v-if="state === 'loading'">Verificando tu cuenta…</p>
    <p v-else-if="state === 'ok'" class="ok">✅ ¡Cuenta verificada! Ya podés ingresar.</p>
    <p v-else class="error">❌ El enlace es inválido o expiró. Registrate de nuevo para recibir uno nuevo.</p>
    <button v-if="state !== 'loading'" @click="$emit('done')">Ir a ingresar</button>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { verifyEmail } from '../api.js';

const props = defineProps({ token: { type: String, required: true } });
defineEmits(['done']);

const state = ref('loading');

onMounted(async () => {
  try {
    const r = await verifyEmail(props.token);
    state.value = r?.ok ? 'ok' : 'error';
  } catch {
    state.value = 'error';
  }
});
</script>

<style scoped>
.card {
  max-width: 360px; margin: 60px auto; padding: 24px;
  background: var(--bot-bg, #fff);
  border: 1px solid var(--border);
  border-radius: 8px;
  display: flex; flex-direction: column; gap: 14px;
  color: var(--text); text-align: center;
}
.card h2 { margin: 0; color: var(--accent); }
.ok { color: var(--text); font-size: 15px; }
.error { color: #dc2626; font-size: 14px; }
button {
  padding: 10px 14px; background: var(--accent); color: #fff; border: none;
  border-radius: 4px; font-weight: 600; cursor: pointer;
}
button:hover { background: var(--accent-hover, #4da8cf); }
</style>
