<template>
  <div class="chat-wrap">
    <aside class="side">
      <h3>Sesión</h3>
      <p class="muted" v-if="sessionId">id: {{ sessionId.slice(0, 8) }}…</p>
      <p class="muted" v-else>nueva</p>
      <button @click="newSession" :disabled="busy">Iniciar otra sesión</button>

      <h3 style="margin-top: 16px">Contexto</h3>
      <div class="ctx">
        <div class="ctx-row">
          <span class="ctx-label">Paciente</span>
          <span v-if="activePatient">
            <strong v-if="patientLabel">{{ patientLabel }}</strong>
            <code class="ctx-uuid">{{ activePatient.slice(0, 8) }}…</code>
          </span>
          <span v-else class="muted">(ninguno)</span>
          <button v-if="activePatient" class="link" @click="send('salir paciente')">×</button>
        </div>
        <div class="ctx-row">
          <span class="ctx-label">Episodio</span>
          <span v-if="activeEpisode">
            <strong v-if="episodeLabel">{{ episodeLabel }}</strong>
            <code class="ctx-uuid">{{ activeEpisode.slice(0, 8) }}…</code>
          </span>
          <span v-else class="muted">(ninguno)</span>
          <button v-if="activeEpisode" class="link" @click="send('salir episodio')">×</button>
        </div>
      </div>

      <h3 style="margin-top: 16px">Atajos</h3>
      <div class="shortcuts">
        <button @click="send('/help')"        :disabled="busy">/help</button>
        <button @click="send('whoami')"       :disabled="busy">whoami</button>
        <button @click="send('definitions')"  :disabled="busy">definitions</button>
        <button @click="send('pacientes')"    :disabled="busy">pacientes</button>
        <button @click="send('episodios')"    :disabled="busy">episodios</button>
        <button @click="send('diagnósticos')" :disabled="busy">diagnósticos</button>
        <button @click="send('cie10 melanoma')" :disabled="busy">cie10 melanoma</button>
        <button @click="send('ver paciente')"   :disabled="busy || !activePatient">ver paciente</button>
        <button @click="send('ver episodio')"   :disabled="busy || !activeEpisode">ver episodio</button>
        <button @click="send('revisiones')"     :disabled="busy">bandeja revisión</button>
        <button @click="send('recordatorios')"  :disabled="busy">recordatorios</button>
        <button @click="send('casos similares')" :disabled="busy || !activeEpisode">casos similares</button>
        <button @click="send('ver chatter')"     :disabled="busy || !(activePatient || activeEpisode)">ver chatter</button>
        <button @click="send('resumen')"         :disabled="busy || !activePatient">resumen paciente</button>
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

      <div v-if="pending" class="pending-card">
        <div class="pending-head">
          <span class="pending-tag">Pendiente</span>
          <code class="pending-tool">{{ pending.tool }}</code>
        </div>
        <p class="pending-summary">{{ pending.summary }}</p>
        <div class="pending-actions">
          <button class="confirm" @click="send('sí')" :disabled="busy">✓ Confirmar</button>
          <button class="cancel"  @click="send('no')" :disabled="busy">✗ Cancelar</button>
        </div>
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
import { ref, nextTick, onMounted, watch } from 'vue';
import { chat, loadSessionId, saveSessionId, uploadAttachment, loadBotSession } from '../api.js';
import ToolResult from './ToolResult.vue';

defineProps({ user: Object });

const turns = ref([]);             // ChatTurn[]
const draft = ref('');
const busy  = ref(false);
const uploading = ref(false);
const pendingAttachment = ref(null);
const error = ref('');
const sessionId = ref(loadSessionId());
const activePatient = ref(null);
const activeEpisode = ref(null);
const pending = ref(null);
const patientLabel = ref('');
const episodeLabel = ref('');
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
    if (typeof r?.active_patient_id !== 'undefined') activePatient.value = r.active_patient_id;
    if (typeof r?.active_episode_id !== 'undefined') activeEpisode.value = r.active_episode_id;
    if (typeof r?.pending_action     !== 'undefined') pending.value = r.pending_action;
    if (Array.isArray(r?.history)) {
      // Filter out internal system context turns the server prepends.
      turns.value = r.history.filter(t => t.role !== 'system');
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

async function resolveLabel(id, fields) {
  try {
    const res = await fetch(`/api/entities/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('cepi.jwt') || ''}` },
    });
    if (!res.ok) return '';
    const body = await res.json();
    const data = body?.data?.data || {};
    const parts = fields.map(f => data[f]).filter(Boolean);
    return parts.length ? parts.join(' ') : (body?.data?.title || '');
  } catch {
    return '';
  }
}
watch(activePatient, async (v) => {
  patientLabel.value = v ? await resolveLabel(v, ['nombre', 'apellidos']) : '';
});
watch(activeEpisode, async (v) => {
  episodeLabel.value = v ? await resolveLabel(v, ['fecha', 'motivo_consulta']) : '';
});

function newSession() {
  sessionId.value = null;
  saveSessionId('');
  turns.value = [];
  activePatient.value = null;
  activeEpisode.value = null;
  pending.value = null;
}

onMounted(async () => {
  if (!sessionId.value) return;
  try {
    const s = await loadBotSession(sessionId.value);
    if (Array.isArray(s.history)) turns.value = s.history.filter(t => t.role !== 'system');
    activePatient.value = s.active_patient_id || null;
    activeEpisode.value = s.active_episode_id || null;
    pending.value       = s.pending_action     || null;
  } catch {
    // stale session id; clear so next message creates a fresh one
    saveSessionId('');
    sessionId.value = null;
  }
});
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

.ctx { display: flex; flex-direction: column; gap: 6px; }
.ctx-row { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.ctx-label { color: #475569; font-weight: 600; min-width: 60px; }
.ctx code  { font-family: ui-monospace, monospace; color: #1e293b; background: #f1f5f9; padding: 2px 4px; border-radius: 3px; }
.ctx-uuid  { margin-left: 4px; font-size: 10px; color: #64748b; }
.ctx strong { color: #1e293b; font-size: 12px; }
.ctx .link { background: transparent; color: #94a3b8; border: 0; padding: 0; cursor: pointer; }

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

.pending-card {
  background: #fefce8; border: 2px solid #facc15; border-radius: 8px;
  padding: 12px 14px; display: flex; flex-direction: column; gap: 8px;
}
.pending-head { display: flex; gap: 8px; align-items: center; }
.pending-tag {
  background: #facc15; color: #713f12; font-size: 10px; text-transform: uppercase;
  padding: 2px 6px; border-radius: 3px; letter-spacing: .04em; font-weight: 700;
}
.pending-tool { font-family: ui-monospace, monospace; color: #713f12; font-size: 12px; }
.pending-summary { margin: 0; color: #422006; font-size: 14px; }
.pending-actions { display: flex; gap: 8px; }
.pending-actions button {
  flex: 1; padding: 8px 14px; border: none; border-radius: 4px; font-weight: 600;
  cursor: pointer;
}
.pending-actions .confirm { background: #16a34a; color: #fff; }
.pending-actions .cancel  { background: #f1f5f9; color: #475569; border: 1px solid #cbd5e1; }
.pending-actions button[disabled] { opacity: .5; cursor: not-allowed; }
</style>
