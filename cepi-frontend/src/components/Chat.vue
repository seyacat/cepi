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
          <pre class="content">{{ t.content }}</pre>
          <span v-if="t.tool_name" class="tool-name">{{ t.tool_name }}</span>
        </div>
        <div v-if="busy" class="turn assistant"><span class="role">…</span><pre class="content">pensando…</pre></div>
      </div>

      <form class="composer" @submit.prevent="onSubmit">
        <textarea
          v-model="draft"
          rows="2"
          placeholder="Escribe un mensaje. Ctrl+Enter para enviar."
          @keydown.ctrl.enter.prevent="onSubmit"
        />
        <button type="submit" :disabled="busy || !draft.trim()">Enviar</button>
      </form>

      <p v-if="error" class="error">{{ error }}</p>
    </section>
  </div>
</template>

<script setup>
import { ref, nextTick, onMounted } from 'vue';
import { chat, loadSessionId, saveSessionId } from '../api.js';

defineProps({ user: Object });

const turns = ref([]);             // ChatTurn[]
const draft = ref('');
const busy  = ref(false);
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
  const t = draft.value;
  draft.value = '';
  send(t);
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
.composer button {
  padding: 0 18px; background: #6366f1; color: #fff; border: none;
  border-radius: 4px; font-weight: 600;
}
.composer button[disabled] { opacity: .5; cursor: not-allowed; }
.error { color: #dc2626; font-size: 13px; margin: 0; }
</style>
