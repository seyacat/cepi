<template>
  <div class="chat-wrap" :class="{ 'side-open': sideOpen }">
    <button
      class="side-toggle"
      type="button"
      @click="sideOpen = !sideOpen"
      :aria-label="sideOpen ? 'Cerrar menú' : 'Abrir menú'"
    >☰</button>
    <div class="side-backdrop" @click="sideOpen = false" aria-hidden="true"></div>
    <aside class="side" @click="onSideClick">
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
        <button @click="send('casos similares')"   :disabled="busy || !activeEpisode">casos similares</button>
        <button @click="send('sugerir diagnostico')" :disabled="busy || !activeEpisode">sugerir dx</button>
        <button @click="send('ver chatter')"     :disabled="busy || !(activePatient || activeEpisode)">ver chatter</button>
        <button @click="send('resumen')"         :disabled="busy || !activePatient">resumen paciente</button>
        <button @click="send('exportar')"        :disabled="busy || !activePatient">⤓ exportar</button>
      </div>
    </aside>

    <section
      class="main"
      :class="{ 'drag-over': dragOver }"
      @dragover.prevent="dragOver = true"
      @dragleave.prevent="dragOver = false"
      @drop.prevent="onDrop"
    >
      <div class="scroll-area" ref="feedEl" @scroll.passive="onScrollAreaScroll">
        <div class="inner">
          <div class="welcome">
            <img
              class="welcome-logo"
              src="https://cepi.ec/wp-content/uploads/2022/12/logo-cepi-final-min.png"
              alt="CEPI"
            />
            <p>
              Hola, soy el asistente virtual de<br />
              <strong>CEPI Centro de la Piel</strong>.<br />
              ¿En qué puedo ayudarte hoy?
            </p>
          </div>

          <div class="messages">
            <div v-for="(t, i) in turns" :key="i" :class="['turn', t.role]">
              <span class="role">{{ labelFor(t.role) }}</span>
              <ToolResult v-if="t.role === 'tool'" :tool-name="t.tool_name || ''" :raw-content="t.content" @action="send" />
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

          <form class="composer" @submit.prevent="onSubmit" ref="composerEl">
            <textarea
              v-model="draft"
              rows="2"
              placeholder="Escribe un mensaje. Enter envía, Shift+Enter agrega salto de línea. Adjunta una imagen 📎 o arrástrala al chat."
              @keydown="onKeyDown"
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

          <div class="bottom-spacer" aria-hidden="true"></div>
        </div>
      </div>
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
const dragOver = ref(false);
const feedEl = ref(null);
const composerEl = ref(null);
const sideOpen = ref(false);

function onSideClick(ev) {
  // Auto-close the sidebar on mobile after picking a shortcut.
  if (ev.target.closest('button') && window.matchMedia('(max-width: 768px)').matches) {
    sideOpen.value = false;
  }
}

function labelFor(role) {
  return ({ user: 'Tú', assistant: 'Bot', tool: 'Tool', system: 'Sistema' })[role] || role;
}

// Track whether the user is "stuck to the bottom". If they scroll up to read,
// we stop yanking them down on each turn / streamed chunk.
const STICK_THRESHOLD_PX = 120;
let stickToBottom = true;

function onScrollAreaScroll() {
  const el = feedEl.value;
  if (!el) return;
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  stickToBottom = distanceFromBottom <= STICK_THRESHOLD_PX;
}

async function scrollToEnd({ force = false } = {}) {
  if (!force && !stickToBottom) return;
  await nextTick();
  const el = feedEl.value;
  if (!el) return;
  // Instant scroll — no smooth animation, so streamed updates don't visibly jump.
  el.scrollTop = el.scrollHeight;
}

async function send(message) {
  if (!message.trim() || busy.value) return;
  busy.value = true;
  error.value = '';
  // Optimistically render the user turn while waiting.
  turns.value = [...turns.value, { role: 'user', content: message }];
  try {
    const r = await chat(message, sessionId.value);
    if (r?.session_id) {
      sessionId.value = r.session_id;
      saveSessionId(r.session_id);
    }
    if (typeof r?.active_patient_id !== 'undefined') activePatient.value = r.active_patient_id;
    if (typeof r?.active_episode_id !== 'undefined') activeEpisode.value = r.active_episode_id;
    if (typeof r?.pending_action     !== 'undefined') pending.value = r.pending_action;
    if (r?.download && r.download.content) {
      const blob = new Blob([r.download.content], { type: r.download.content_type || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = r.download.filename || 'export.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }
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
  }
}

function onKeyDown(ev) {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    onSubmit();
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

async function uploadOne(file) {
  uploading.value = true;
  error.value = '';
  try {
    pendingAttachment.value = await uploadAttachment(file);
  } catch (e) {
    error.value = `Subida falló: ${e.message || e}`;
  } finally {
    uploading.value = false;
  }
}
async function onFile(ev) {
  const file = ev.target.files?.[0];
  ev.target.value = '';
  if (file) await uploadOne(file);
}
async function onDrop(ev) {
  dragOver.value = false;
  const file = ev.dataTransfer?.files?.[0];
  if (!file) return;
  if (!/^image\//.test(file.type)) {
    error.value = 'Solo imágenes (jpg, png, etc.)';
    return;
  }
  await uploadOne(file);
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
.chat-wrap {
  display: grid;
  grid-template-columns: 220px 1fr;
  gap: 16px;
  height: calc(100dvh - var(--header-h) - 24px);
  position: relative;
}
.side-toggle {
  display: none;
  position: absolute;
  top: 8px; left: 8px;
  z-index: 30;
  width: 38px; height: 38px;
  border-radius: 50%;
  border: 1.5px solid var(--border);
  background: rgba(255,255,255,0.92);
  color: var(--accent);
  font-size: 1.1rem; font-weight: 700;
  box-shadow: 0 2px 6px rgba(0,0,0,0.12);
}
.side-backdrop {
  display: none;
  position: fixed;
  inset: var(--header-h) 0 0 0;
  background: rgba(0,0,0,0.35);
  z-index: 20;
}

@media (max-width: 768px) {
  .chat-wrap {
    grid-template-columns: 1fr;
    gap: 0;
    height: calc(100dvh - var(--header-h));
  }
  .side-toggle { display: flex; align-items: center; justify-content: center; }
  .side {
    position: fixed;
    top: var(--header-h);
    left: 0;
    height: calc(100dvh - var(--header-h));
    width: 80vw; max-width: 300px;
    z-index: 25;
    border-radius: 0;
    border-right: 1px solid var(--border);
    transform: translateX(-100%);
    transition: transform 0.22s ease;
    overflow-y: auto;
  }
  .chat-wrap.side-open .side { transform: translateX(0); }
  .chat-wrap.side-open .side-backdrop { display: block; }
  .main { border-radius: 0; border-left: 0; border-right: 0; }
}
.side {
  background: #fff; border: 1px solid var(--border); border-radius: 12px; padding: 16px;
  font-size: 14px;
  box-shadow: 0 1px 4px rgba(0,0,0,0.04);
}
.side h3 {
  font-size: 12px; text-transform: uppercase; color: var(--accent);
  margin: 0 0 8px; letter-spacing: .04em; font-weight: 700;
}
.shortcuts { display: flex; flex-direction: column; gap: 6px; }
.shortcuts button {
  border: 1.5px solid var(--border); background: #f8fafc; color: var(--text);
  padding: 0.4rem 0.85rem; border-radius: 18px; text-align: left;
  font-weight: 600; font-size: 0.82rem;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.shortcuts button:hover:not(:disabled) {
  background: var(--accent); border-color: var(--accent); color: #fff;
}
.shortcuts button:disabled { opacity: .5; cursor: not-allowed; }
.muted { color: #94a3b8; font-size: 12px; word-break: break-all; }

.ctx { display: flex; flex-direction: column; gap: 6px; }
.ctx-row { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.ctx-label { color: #475569; font-weight: 600; min-width: 60px; }
.ctx code  { font-family: ui-monospace, monospace; color: #1e293b; background: #f1f5f9; padding: 2px 4px; border-radius: 3px; }
.ctx-uuid  { margin-left: 4px; font-size: 10px; color: #64748b; }
.ctx strong { color: #1e293b; font-size: 12px; }
.ctx .link { background: transparent; color: #94a3b8; border: 0; padding: 0; cursor: pointer; }

.main {
  display: flex; flex-direction: column;
  background: #fff; border: 1px solid var(--border); border-radius: 12px;
  min-height: 0; overflow: hidden;
  transition: background 80ms ease;
  box-shadow: 0 1px 4px rgba(0,0,0,0.04);
}
.main.drag-over { background: #fff7ed; border-color: var(--accent); }

/* Scrollable area: holds the centered "inner" wrapper.
   When inner content < scroll height, margin:auto centers it (welcome state).
   When content > scroll height, the bottom-spacer (50dvh) lets the user
   scroll the composer up to the vertical center, leaving room for the
   mobile keyboard. */
.scroll-area {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.inner {
  margin-top: auto;
  margin-bottom: auto;
  width: 100%;
  max-width: 800px;
  align-self: center;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
}
.messages { display: flex; flex-direction: column; gap: 0.85rem; }
.bottom-spacer { height: 50dvh; flex-shrink: 0; }

.welcome {
  display: flex; flex-direction: column; align-items: center; gap: 0.9rem;
  padding: 2rem 1.5rem 1.5rem; text-align: center; margin: auto;
}
.welcome-logo {
  width: 200px; max-width: 55vw; object-fit: contain;
  background: var(--accent-band); border-radius: 10px; padding: 0.6rem 1.2rem;
}
.welcome p { color: var(--text-muted); font-size: 0.95rem; line-height: 1.7; }

.turn {
  display: flex; flex-direction: column; gap: 4px; max-width: 82%;
  padding: 0;
}
.turn .role {
  font-weight: 700; font-size: 11px; text-transform: uppercase;
  color: var(--text-muted); letter-spacing: .04em;
  padding: 0 0.5rem;
}
.turn.user      { align-self: flex-end; align-items: flex-end; }
.turn.assistant { align-self: flex-start; }
.turn.tool      { align-self: flex-start; max-width: 95%; }
.turn.user .role      { color: var(--accent); }
.turn.assistant .role { color: var(--accent); }
.turn.tool .role      { color: #a16207; }

.content {
  margin: 0; white-space: pre-wrap; word-break: break-word;
  font-family: inherit; font-size: 0.93rem; font-weight: 500;
  padding: 0.7rem 1rem; border-radius: var(--radius); line-height: 1.6;
}
.turn.user .content {
  background: var(--user-bg); color: var(--user-text);
  border-bottom-right-radius: 4px;
}
.turn.assistant .content {
  background: var(--bot-bg); color: var(--text);
  border: 1px solid var(--border); border-bottom-left-radius: 4px;
  box-shadow: 0 1px 4px rgba(0,0,0,0.06);
}
.tool-name { font-size: 11px; color: #94a3b8; align-self: start; }

.composer {
  display: flex; gap: 0.5rem;
  padding: 0.75rem 1rem;
  background: var(--accent-band);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  border-radius: 16px;
}
.composer textarea {
  flex: 1; resize: none;
  background: rgba(255,255,255,0.92);
  color: #212121;
  border: 1.5px solid var(--border); border-radius: 24px;
  padding: 0.65rem 1.1rem;
  font-size: 0.95rem; font-weight: 500;
  outline: none;
  max-height: 140px; overflow-y: auto;
  transition: border-color 0.2s;
}
.composer textarea::placeholder { color: var(--text-muted); }
.composer textarea:focus { border-color: var(--accent); }
html[data-theme="dark"] .composer textarea {
  background: rgba(255,255,255,0.92);
  color: #212121;
}
.composer-actions { display: flex; gap: 6px; align-items: flex-end; }
.composer button[type="submit"] {
  background: var(--accent); color: #fff; border: none;
  border-radius: 22px; min-width: 84px; height: 42px;
  padding: 0 1rem; font-weight: 700;
  transition: background 0.2s, transform 0.1s;
}
.composer button[type="submit"]:hover:not(:disabled) {
  background: var(--accent-hover); transform: scale(1.03);
}
.composer button[disabled] { opacity: .55; cursor: not-allowed; transform: none; }
.upload-btn {
  display: flex; align-items: center; justify-content: center;
  width: 42px; height: 42px; cursor: pointer;
  border: 1.5px solid rgba(255,255,255,0.55); border-radius: 50%;
  background: rgba(255,255,255,0.85);
  font-size: 18px;
  transition: background 0.2s;
}
.upload-btn:hover:not(.disabled) { background: #fff; }
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
