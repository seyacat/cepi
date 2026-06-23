<template>
  <div class="ichat">
    <div v-if="patientName" class="ihead">
      <span class="ihead-name">👤 {{ patientName }}</span>
      <div class="ihead-actions">
        <button type="button" :disabled="busy" @click="openDerivar" title="Derivar el episodio a un círculo o a una persona">↪️ Derivar</button>
        <button type="button" :disabled="busy" @click="send('cerrar episodio')" title="Cerrar el episodio activo (estado cerrado)">✅ Cerrar</button>
      </div>
    </div>

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
        ref="taEl"
        v-model="draft"
        rows="1"
        placeholder="Escribí o pegá un texto largo…"
        @keydown="onKey"
      ></textarea>
      <button type="submit" :disabled="busy || (!draft.trim() && !pendingAttachment)">
        {{ uploading ? '…' : 'Enviar' }}
      </button>
    </form>

    <div v-if="showDerivar" class="derivar-modal" @click.self="showDerivar = false">
      <div class="derivar-panel">
        <div class="derivar-head">
          <strong>Derivar episodio</strong>
          <button type="button" @click="showDerivar = false">Cerrar</button>
        </div>
        <p class="derivar-hint">Elegí un <b>círculo</b> o una <b>persona</b>. Luego podés agregar el motivo y enviar.</p>
        <p v-if="derivarError" class="derivar-error">{{ derivarError }}</p>
        <p v-if="derivarLoading" class="derivar-muted">Cargando destinos…</p>
        <ul v-else class="derivar-list">
          <li v-if="!derivarGroups.length" class="derivar-muted">No hay círculos disponibles.</li>
          <li v-for="g in derivarGroups" :key="g.id" class="derivar-group">
            <div class="dg-row">
              <button type="button" class="dg-pick" @click="pickCircle(g)" :title="'Derivar al círculo ' + g.name">
                <span class="dg-name">⭕ {{ g.name }}</span>
                <span class="dg-kind">{{ g.kind }}</span>
              </button>
              <button type="button" class="dg-expand" @click="toggleMembers(g)" title="Ver personas">
                {{ expandedGroup === g.slug ? '▾' : '▸' }} 👤{{ g.member_count }}
              </button>
            </div>
            <ul v-if="expandedGroup === g.slug" class="derivar-members">
              <li v-if="!(groupMembers[g.slug] || []).length" class="derivar-muted">(sin miembros)</li>
              <li v-for="m in (groupMembers[g.slug] || [])" :key="m.user_id">
                <button type="button" class="dm-pick" @click="pickPerson(m)" :title="'Derivar a ' + (m.name || m.email)">
                  👤 {{ m.name || m.email }}
                  <span v-if="m.role_in_group" class="dm-role">{{ m.role_in_group }}</span>
                </button>
              </li>
            </ul>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, nextTick } from 'vue';
import { chat, saveSessionId, uploadAttachment, listGroups, listGroupMembers } from '../api.js';
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
const taEl = ref(null);

// ── Derivar: picker of circles (user_groups) and their members ────────────────
const showDerivar    = ref(false);
const derivarGroups  = ref([]);
const derivarLoading = ref(false);
const derivarError   = ref('');
const expandedGroup  = ref('');          // slug currently expanded to show members
const groupMembers   = ref({});          // slug → members[] (cached)

function prefillCommand(text) {
  draft.value = text;
  nextTick(() => {
    const ta = taEl.value;
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  });
}

async function openDerivar() {
  showDerivar.value = true;
  derivarError.value = '';
  expandedGroup.value = '';
  if (derivarGroups.value.length) return;   // cached from a previous open
  derivarLoading.value = true;
  try {
    const r = await listGroups();
    // Exclude the on-call 'turno' roster — that's "enviar caso", not derivar.
    derivarGroups.value = (r?.data || []).filter(g => g.kind !== 'roster');
  } catch (e) {
    derivarError.value = e?.message || 'No se pudieron cargar los destinos.';
  } finally {
    derivarLoading.value = false;
  }
}

async function toggleMembers(g) {
  if (expandedGroup.value === g.slug) { expandedGroup.value = ''; return; }
  expandedGroup.value = g.slug;
  if (groupMembers.value[g.slug]) return;   // cached
  try {
    const r = await listGroupMembers(g.slug);
    groupMembers.value = { ...groupMembers.value, [g.slug]: r?.data || [] };
  } catch {
    groupMembers.value = { ...groupMembers.value, [g.slug]: [] };
  }
}

// Circle → "derivar a <slug>" (motivo optional). Person → "escalar a <uuid>".
function pickCircle(g) {
  showDerivar.value = false;
  prefillCommand(`derivar a ${g.slug} `);
}
function pickPerson(m) {
  showDerivar.value = false;
  prefillCommand(`escalar a ${m.user_id} `);
}

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
  flex-shrink: 0; padding: 8px 12px; font-weight: 700; font-size: 0.92rem;
  color: #fff; background: var(--accent-band, var(--accent)); border-bottom: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
}
.ihead-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ihead-actions { display: flex; gap: 6px; flex-shrink: 0; }
.ihead-actions button {
  border: 1px solid rgba(255,255,255,.55); background: rgba(255,255,255,.15); color: #fff;
  border-radius: 14px; padding: 4px 10px; font-size: 0.78rem; font-weight: 600; cursor: pointer;
  white-space: nowrap;
}
.ihead-actions button:hover:not(:disabled) { background: rgba(255,255,255,.28); }
.ihead-actions button:disabled { opacity: .5; cursor: not-allowed; }

/* Derivar picker modal. */
.derivar-modal {
  position: fixed; inset: 0; z-index: 60;
  background: rgba(0,0,0,.5); display: flex; align-items: center; justify-content: center; padding: 16px;
}
.derivar-panel {
  background: #fff; color: var(--text); border-radius: 10px;
  width: min(460px, 96vw); max-height: min(86vh, 760px);
  display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 8px 30px rgba(0,0,0,.3);
}
.derivar-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 14px; border-bottom: 1px solid var(--border); font-size: 0.95rem;
}
.derivar-head button {
  border: 1.5px solid var(--border); background: #f8fafc; color: var(--text);
  border-radius: 6px; padding: 4px 12px; cursor: pointer; font-weight: 600;
}
.derivar-head button:hover { border-color: var(--accent); color: var(--accent); }
.derivar-hint { margin: 10px 14px 4px; font-size: 0.82rem; color: var(--text-muted); }
.derivar-error { margin: 6px 14px; color: #c43d3d; font-size: 0.82rem; }
.derivar-muted { color: var(--text-muted); font-size: 0.84rem; padding: 4px 6px; list-style: none; }
.derivar-list { list-style: none; margin: 6px 0 10px; padding: 0 8px; overflow-y: auto; }
.derivar-group { border-bottom: 1px solid var(--border); }
.dg-row { display: flex; align-items: stretch; gap: 6px; padding: 4px 0; }
.dg-pick {
  flex: 1; text-align: left; border: 1px solid var(--border); background: #f8fafc; color: var(--text);
  border-radius: 7px; padding: 8px 10px; cursor: pointer;
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
}
.dg-pick:hover { border-color: var(--accent); color: var(--accent); }
.dg-name { font-weight: 600; font-size: 0.9rem; }
.dg-kind { font-size: 0.7rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: .04em; }
.dg-expand {
  border: 1px solid var(--border); background: #fff; color: var(--text);
  border-radius: 7px; padding: 0 10px; cursor: pointer; font-size: 0.8rem; white-space: nowrap;
}
.dg-expand:hover { border-color: var(--accent); color: var(--accent); }
.derivar-members { list-style: none; margin: 0 0 6px; padding: 0 0 0 14px; }
.derivar-members li { padding: 2px 0; }
.dm-pick {
  width: 100%; text-align: left; border: 1px dashed var(--border); background: transparent; color: var(--text);
  border-radius: 6px; padding: 6px 10px; cursor: pointer; font-size: 0.86rem;
  display: flex; align-items: center; gap: 8px;
}
.dm-pick:hover { border-color: var(--accent); color: var(--accent); border-style: solid; }
.dm-role { font-size: 0.68rem; color: var(--text-muted); text-transform: uppercase; }
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
