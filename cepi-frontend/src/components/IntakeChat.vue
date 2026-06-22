<template>
  <div class="ichat">
    <div v-if="patientName" class="ihead">👤 {{ patientName }}</div>

    <div class="ifeed" ref="feedEl">
      <div v-if="!turns.length && !busy" class="iwelcome">
        <p>Escribí o <b>pegá un texto</b> con los datos del paciente y la IA los carga en la ficha.
           También podés chatear normalmente; antes de guardar te pido confirmación.</p>
      </div>

      <div v-for="(t, i) in turns" :key="i" :class="['iturn', t.role]">
        <MessageContent :content="t.content" />
      </div>
      <div v-if="busy" class="iturn assistant"><span class="thinking">escribiendo…</span></div>

      <div v-if="pending" class="ipending">
        <p class="ipending-summary">{{ pending.summary }}</p>
        <div class="ipending-actions">
          <button class="ok" :disabled="busy" @click="send('sí')">✓ Confirmar</button>
          <button class="no" :disabled="busy" @click="send('no')">✗ Cancelar</button>
        </div>
      </div>

      <p v-if="error" class="ierror">{{ error }}</p>
    </div>

    <p v-if="pendingAttachment" class="iattached">
      📎 {{ pendingAttachment.original_name || pendingAttachment.filename }}
      <button type="button" @click="pendingAttachment = null">quitar</button>
    </p>

    <form class="icomposer" @submit.prevent="onSubmit">
      <label class="iupload" :class="{ disabled: busy || uploading }" title="Adjuntar imagen">
        📎<input type="file" accept="image/*" :disabled="busy || uploading" @change="onFile" />
      </label>
      <textarea
        v-model="draft"
        rows="1"
        placeholder="Escribí o pegá un texto largo…"
        @keydown="onKey"
      ></textarea>
      <button type="submit" :disabled="busy || (!draft.trim() && !pendingAttachment)">
        {{ uploading ? '…' : 'Enviar' }}
      </button>
    </form>
  </div>
</template>

<script setup>
import { ref, nextTick } from 'vue';
import { chat, saveSessionId, uploadAttachment } from '../api.js';
import MessageContent from './MessageContent.vue';

defineProps({ user: Object });

const turns = ref([]);
const draft = ref('');
const busy = ref(false);
const uploading = ref(false);
const error = ref('');
const sessionId = ref(null);
const activePatient = ref(null);
const pending = ref(null);
const pendingAttachment = ref(null);
const patientName = ref('');
const feedEl = ref(null);

async function scrollEnd() {
  await nextTick();
  const el = feedEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}

async function send(message) {
  if (!message || !message.trim() || busy.value) return;
  busy.value = true;
  error.value = '';
  turns.value = [...turns.value, { role: 'user', content: message }];
  await scrollEnd();
  try {
    const r = await chat(message, sessionId.value);
    if (r?.session_id) { sessionId.value = r.session_id; saveSessionId(r.session_id); }
    if (typeof r?.active_patient_id !== 'undefined') activePatient.value = r.active_patient_id;
    if (typeof r?.pending_action !== 'undefined') pending.value = r.pending_action;
    if (Array.isArray(r?.history)) turns.value = r.history.filter(t => t.role !== 'system');
    else turns.value = [...turns.value, { role: 'assistant', content: r?.text || '(sin respuesta)' }];
  } catch (e) {
    error.value = e.message || String(e);
  } finally {
    busy.value = false;
    await scrollEnd();
  }
}

function onKey(ev) {
  if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); onSubmit(); }
}
function onSubmit() {
  const t = draft.value.trim();
  let payload = t;
  if (pendingAttachment.value) {
    const a = pendingAttachment.value;
    payload = (t ? t + '\n' : '') + `[adjunto: ${a.original_name || a.filename} · ${a.id}]`;
  }
  draft.value = '';
  pendingAttachment.value = null;
  if (payload) send(payload);
}
async function onFile(ev) {
  const f = ev.target.files?.[0];
  ev.target.value = '';
  if (!f) return;
  uploading.value = true;
  error.value = '';
  try { pendingAttachment.value = await uploadAttachment(f); }
  catch (e) { error.value = 'Subida falló: ' + (e.message || e); }
  finally { uploading.value = false; }
}

function reset() {
  sessionId.value = null;
  localStorage.removeItem('cepi.session_id');
  turns.value = [];
  activePatient.value = null;
  pending.value = null;
  pendingAttachment.value = null;
  error.value = '';
}
// Driven by ChatShell: open a patient (binds the session) or start a general chat.
function openPatient(uuid, name) {
  if (!uuid) return;
  reset();
  patientName.value = name || '';
  send('activar paciente ' + uuid);
}
function newGeneral() {
  reset();
  patientName.value = '';
}
defineExpose({ openPatient, newGeneral });
</script>

<style scoped>
.ichat {
  display: flex; flex-direction: column;
  height: 100%; min-height: 0;
  background: #fff; border: 1px solid var(--border); border-radius: 12px;
  overflow: hidden;
}
.ihead {
  flex-shrink: 0; padding: 10px 14px; font-weight: 700; font-size: 0.92rem;
  color: #fff; background: var(--accent-band, var(--accent)); border-bottom: 1px solid var(--border);
}
.ifeed { flex: 1; min-height: 0; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
.iwelcome { margin: auto; max-width: 460px; text-align: center; color: var(--text-muted); font-size: 0.92rem; line-height: 1.6; }
.iturn { max-width: 82%; padding: 0.6rem 0.9rem; border-radius: var(--radius, 12px); font-size: 0.93rem; line-height: 1.5; word-break: break-word; }
.iturn.user { align-self: flex-end; background: var(--user-bg, #2596be); color: var(--user-text, #fff); border-bottom-right-radius: 4px; }
.iturn.assistant, .iturn.tool { align-self: flex-start; background: var(--bot-bg, #f1f5f9); color: var(--text); border: 1px solid var(--border); border-bottom-left-radius: 4px; }
.thinking { color: var(--text-muted); font-style: italic; }
.ipending { align-self: stretch; background: #fefce8; border: 2px solid #facc15; border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.ipending-summary { margin: 0; color: #422006; font-size: 0.9rem; }
.ipending-actions { display: flex; gap: 8px; }
.ipending-actions button { flex: 1; padding: 8px; border: none; border-radius: 4px; font-weight: 600; cursor: pointer; }
.ipending-actions .ok { background: #16a34a; color: #fff; }
.ipending-actions .no { background: #f1f5f9; color: #475569; border: 1px solid #cbd5e1; }
.ierror { color: #dc2626; font-size: 13px; }
.iattached { flex-shrink: 0; margin: 0; padding: 6px 14px; font-size: 13px; color: #3730a3; background: #eef2ff; border-top: 1px solid #c7d2fe; }
.iattached button { background: none; border: 0; color: #6366f1; text-decoration: underline; cursor: pointer; }
.icomposer { flex-shrink: 0; display: flex; gap: 8px; align-items: flex-end; padding: 10px 12px; border-top: 1px solid var(--border); background: var(--bg); }
.icomposer textarea {
  flex: 1; resize: none; max-height: 160px; min-height: 40px;
  padding: 9px 12px; border: 1.5px solid var(--border); border-radius: 20px;
  font-size: 0.95rem; font-family: inherit; background: #fff; color: #212121; outline: none;
}
.icomposer textarea:focus { border-color: var(--accent); }
.iupload { display: flex; align-items: center; justify-content: center; width: 40px; height: 40px; flex-shrink: 0; border: 1.5px solid var(--border); border-radius: 50%; background: #fff; cursor: pointer; }
.iupload input { display: none; }
.iupload.disabled { opacity: .5; cursor: not-allowed; }
.icomposer button[type="submit"] { flex-shrink: 0; height: 40px; min-width: 78px; padding: 0 1rem; border: none; border-radius: 20px; background: var(--accent); color: #fff; font-weight: 700; cursor: pointer; }
.icomposer button[disabled] { opacity: .55; cursor: not-allowed; }
</style>
