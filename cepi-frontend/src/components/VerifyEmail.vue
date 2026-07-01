<template>
  <div class="card">
    <h2>Verificá tu cuenta</h2>
    <p class="lead">Te enviamos un <b>código de 6 dígitos</b> a<br><b>{{ email }}</b>. Ingresalo acá:</p>

    <input
      v-model="code"
      inputmode="numeric" autocomplete="one-time-code" maxlength="6"
      placeholder="000000" class="code-input"
      @input="code = code.replace(/\D/g, '').slice(0, 6)"
      @keyup.enter="submit"
    />

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="okMsg" class="ok">{{ okMsg }}</p>

    <button :disabled="busy || code.length !== 6" @click="submit">{{ busy ? 'Verificando…' : 'Verificar' }}</button>

    <p class="hint">
      ¿No te llegó? <a href="#" @click.prevent="resend">Reenviar código</a>
      · <a href="#" @click.prevent="$emit('done')">Volver a ingresar</a>
    </p>
    <p class="note">Nunca te pediremos que hagas click en enlaces del email para verificar.</p>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { verifyEmail, resendVerifyCode } from '../api.js';

const props = defineProps({ email: { type: String, required: true } });
const emit = defineEmits(['done']);

const code = ref('');
const busy = ref(false);
const error = ref('');
const okMsg = ref('');

async function submit() {
  if (code.value.length !== 6) return;
  busy.value = true; error.value = ''; okMsg.value = '';
  try {
    await verifyEmail(props.email, code.value);
    okMsg.value = '✅ ¡Cuenta verificada! Redirigiendo…';
    setTimeout(() => emit('done'), 1200);
  } catch (e) {
    const msg = e?.message || '';
    error.value = /expired/.test(msg) ? 'El código venció. Pedí uno nuevo.'
      : /too_many/.test(msg) ? 'Demasiados intentos. Pedí un código nuevo.'
      : 'Código incorrecto. Revisá e intentá de nuevo.';
  } finally {
    busy.value = false;
  }
}

async function resend() {
  error.value = ''; okMsg.value = '';
  try {
    await resendVerifyCode(props.email);
    okMsg.value = 'Te reenviamos el código. Revisá tu correo (y spam).';
    code.value = '';
  } catch {
    okMsg.value = 'Si el correo es válido, te reenviamos el código.';
  }
}
</script>

<style scoped>
.card {
  max-width: 360px; margin: 60px auto; padding: 24px;
  background: var(--bot-bg, #fff); border: 1px solid var(--border); border-radius: 8px;
  display: flex; flex-direction: column; gap: 14px; color: var(--text); text-align: center;
}
.card h2 { margin: 0; color: var(--accent); }
.lead { font-size: 14px; color: var(--text-muted); line-height: 1.5; margin: 0; }
.code-input {
  font-size: 30px; letter-spacing: 12px; text-align: center; font-weight: 700;
  padding: 12px; border: 1.5px solid var(--border); border-radius: 8px;
  background: var(--bg); color: var(--text); width: 100%;
}
.code-input:focus { outline: none; border-color: var(--accent); }
.error { color: #dc2626; font-size: 13px; margin: 0; }
.ok { color: #16a34a; font-size: 13px; margin: 0; }
button {
  padding: 11px 14px; background: var(--accent); color: #fff; border: none;
  border-radius: 6px; font-weight: 700; cursor: pointer;
}
button[disabled] { opacity: .55; cursor: not-allowed; }
.hint { color: var(--text-muted); font-size: 13px; margin: 0; }
.hint a { color: var(--accent); text-decoration: none; }
.note { color: var(--text-muted); font-size: 11px; margin: 4px 0 0; }
</style>
