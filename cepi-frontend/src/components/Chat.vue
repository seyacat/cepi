<template>
  <div class="chat-wrap">
    <aside class="side">
      <h3>Sesión</h3>
      <p class="muted" v-if="sessionId">id: {{ sessionId }}</p>
      <p class="muted" v-else>nueva</p>
      <button @click="newSession" :disabled="busy">Iniciar otra sesión</button>

      <h3 style="margin-top: 24px">Atajos</h3>
      <div class="shortcuts">
        <button @click="send('whoami')"      :disabled="busy">whoami</button>
        <button @click="send('definitions')" :disabled="busy">definitions</button>
        <button @click="send('pacientes')"   :disabled="busy">pacientes</button>
        <button @click="send('episodios')"   :disabled="busy">episodios</button>
        <button @click="send('diagnósticos')" :disabled="busy">diagnósticos</button>
      </div>
    </aside>

    <section class="main">
      <div class="feed" ref="feedEl">
        <div v-for="(t, i) in turns" :key="i" :class="['turn', t.role]">
          <span class="role">{{ labelFor(t.role) }}</span>
          <ToolResult v-if="t.role === 'tool'" :tool-name="t.tool_name || ''" :raw-content="t.content" />
          <pre v-else class="content">{{ t.content }}</pre>
        </div>
        <div v-if="busy" class="turn assistant"><span class="role">…</span><pre class="content">pensando…</pre></div>
      </div>

      <form class="composer" @submit.prevent="onSubmit">
        <textarea
          v-model="draft"
          rows="2"
          placeholder="Escribe un mensaje. Ctrl+Enter para enviar. Adjunta una imagen para procesarla como imagen clínica."
          @keydown.ctrl.enter.prevent="onSubmit"
        />
        <div class="composer-actions">
          <label class="upload-btn" :class="{ disabled: busy || uploading }">
            📎
            <input type="file" accept="image/*" @change="onFile" :disabled="busy || uploading" />
          </label>
          <button type="submit" :disabled="busy || (!draft.trim() && !pendingAttachment)">
            {{ uploading ? 'Subiendo…' : 'Enviar' }}
          </button>
        </div>
      </form>

      <p v-if="pendingAttachment" class="attached">
        Adjunto listo: <strong>{{ pendingAttachment.original_name || pendingAttachment.filename }}</strong>
        ({{ Math.round(pendingAttachment.size / 1024) }} KB)
        <button type="button" @click="pendingAttachment = null" class="link">quitar</button>
      </p>

      <p v-if="error" class="error">{{ error }}</p>
    </section>
  </div>
</template>

<script setup>
import { ref, nextTick, onMounted } from 'vue';
import { chat, loadSessionId, saveSessionId, uploadAttachment } from '../api.js';
import ToolResult from './ToolResult.vue';

defineProps({ user: Object });

const turns = ref([]);             // ChatTurn[]
const draft = ref('');
const busy  = ref(false);
const uploading = ref(false);
const pendingAttachment = ref(null);
const error = ref('');
const sessionId = ref(loadSessionId());
const feedEl = ref(null);

function labelFor(role) {
  return ({ user: 'Tú', assistant: 'Bot', tool: 'Tool', system: 'Sistema' })[role] || role;
}

async function scrollToEnd() {
  await nextTick();
  if (feedEl.value) feedEl.value.scrollTop = feedEl.value.scrollHeight;
}

async function send(message) {
  if (!message.trim() || busy.value) return;
  busy.value = true;
  error.value = '';
  // Optimistically render the user turn while waiting.
  turns.value = [...turns.value, { role: 'user', content: message }];
  scrollToEnd();
  try {
    const r = await chat(message, sessionId.value);
    if (r?.session_id) {
      sessionId.value = r.session_id;
      saveSessionId(r.session_id);
    }
    if (Array.isArray(r?.history)) {
      turns.value = r.history;
    } else {
      turns.value = [...turns.value, { role: 'assistant', content: r?.text || '(sin respuesta)' }];
    }
  } catch (e) {
    error.value = e.message || String(e);
  } finally {
    busy.value = false;
    scrollToEnd();
  }
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
  send(payload);
}

async function onFile(ev) {
  const file = ev.target.files?.[0];
  ev.target.value = '';
  if (!file) return;
  uploading.value = true;
  error.value = '';
  try {
    const att = await uploadAttachment(file);
    pendingAttachment.value = att;
  } catch (e) {
    error.value = `Subida falló: ${e.message || e}`;
  } finally {
    uploading.value = false;
  }
}

function newSession() {
  sessionId.value = null;
  saveSessionId('');
  turns.value = [];
}

onMounted(() => { /* hydrate from session_id later if needed */ });
</script>

<style scoped>
.chat-wrap { display: grid; grid-template-columns: 220px 1fr; gap: 16px; height: calc(100vh - 80px); }
.side {
  background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px;
  font-size: 14px;
}
.side h3 { font-size: 13px; text-transform: uppercase; color: #64748b; margin: 0 0 8px; letter-spacing: .04em; }
.shortcuts { display: flex; flex-direction: column; gap: 6px; }
.shortcuts button {
  border: 1px solid #cbd5e1; background: #f8fafc; color: #334155;
  padding: 6px 10px; border-radius: 4px; text-align: left;
}
.muted { color: #94a3b8; font-size: 12px; word-break: break-all; }

.main {
  display: flex; flex-direction: column; gap: 12px;
  background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px;
  min-height: 0;
}
.feed { flex: 1; overflow: auto; padding-right: 4px; }
.turn { display: flex; gap: 12px; padding: 10px 0; border-bottom: 1px dashed #e2e8f0; }
.turn .role {
  flex: 0 0 60px; font-weight: 600; font-size: 12px; text-transform: uppercase;
  color: #64748b; padding-top: 2px;
}
.turn.user .role      { color: #1d4ed8; }
.turn.assistant .role { color: #15803d; }
.turn.tool .role      { color: #a16207; }
.content { flex: 1; margin: 0; white-space: pre-wrap; word-break: break-word; font-family: inherit; font-size: 14px; }
.tool-name { font-size: 11px; color: #94a3b8; align-self: start; }

.composer { display: flex; gap: 8px; }
.composer textarea {
  flex: 1; resize: vertical; min-height: 56px;
  padding: 8px 10px; border: 1px solid #cbd5e1; border-radius: 4px;
}
.composer-actions { display: flex; flex-direction: column; gap: 6px; }
.composer button {
  padding: 8px 16px; background: #6366f1; color: #fff; border: none;
  border-radius: 4px; font-weight: 600;
}
.composer button[disabled] { opacity: .5; cursor: not-allowed; }
.upload-btn {
  display: flex; align-items: center; justify-content: center;
  width: 40px; height: 36px; cursor: pointer;
  border: 1px solid #cbd5e1; border-radius: 4px; background: #f8fafc;
  font-size: 18px;
}
.upload-btn input { display: none; }
.upload-btn.disabled { opacity: .5; cursor: not-allowed; }
.attached {
  background: #eef2ff; border: 1px solid #c7d2fe; padding: 8px 12px;
  border-radius: 6px; font-size: 13px; color: #3730a3; margin: 0;
  display: flex; gap: 8px; align-items: center;
}
.attached strong { color: #1e1b4b; }
.attached .link { background: transparent; color: #6366f1; border: 0; padding: 0; cursor: pointer; text-decoration: underline; }
.error { color: #dc2626; font-size: 13px; margin: 0; }
</style>
