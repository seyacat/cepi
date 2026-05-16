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
      <button @click="newSession" :disabled="busy">+ Nueva sesión</button>

      <h3 style="margin-top: 16px">Mis sesiones</h3>
      <div class="sessions-filter">
        <label><input type="checkbox" v-model="showOpen" /> abiertas</label>
        <label><input type="checkbox" v-model="showClosed" /> cerradas</label>
      </div>
      <div class="sessions-list" v-if="filteredSessions.length">
        <button
          v-for="s in filteredSessions"
          :key="s.id"
          class="session-item"
          :class="{ active: s.id === sessionId }"
          :disabled="busy"
          :title="s.title"
          @click="openSession(s.id)"
        >
          <div class="session-preview">{{ s.patient_name || s.preview || '(sin mensajes)' }}</div>
          <div class="session-meta">
            <span class="session-date">{{ formatSessionDate(s.updated_at || s.created_at) }}</span>
            <span class="session-state" :class="s.estado">{{ s.estado }}</span>
          </div>
        </button>
      </div>
      <p class="muted" v-else>{{ sessions.length ? 'no hay sesiones que coincidan' : 'no hay sesiones previas' }}</p>

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
      <div v-if="activePatient" class="patient-bar">
        <span class="pb-name">👤 {{ patientLabel || 'Paciente activo' }}</span>
        <div class="pb-right">
          <div v-if="activeEpisode" class="dx-light" title="Diagnóstico — semáforo A/B/C">
            <span class="dx-caption">Dx</span>
            <button
              v-for="opt in dxOptions"
              :key="opt.letra"
              type="button"
              class="dx-dot"
              :class="[opt.cls, { on: diagnosticoLetra === opt.letra }]"
              :title="opt.title"
              :disabled="busy"
              @click="setDiagnostico(opt.letra)"
            >{{ opt.letra }}</button>
          </div>
          <button class="pb-ficha" type="button" @click="openFicha">Mostrar ficha</button>
        </div>
      </div>

      <nav
        v-if="bookmarks.length"
        ref="railEl"
        class="bookmark-rail"
        aria-label="Fichas"
        @mouseenter="cacheRail"
        @mousemove="onRailMove"
        @mouseleave="onRailLeave"
      >
        <template v-for="(grp, gi) in bookmarkGroups" :key="'g' + gi">
          <div v-if="grp.category" class="bookmark-cat">{{ grp.category }}</div>
          <button
            v-for="bm in grp.items"
            :key="bm.id"
            type="button"
            class="bookmark-tab"
            :class="{ done: bm.done === true }"
            :disabled="busy"
            :title="bm.label"
            @click="openBookmark(bm)"
          >{{ bm.label }}</button>
        </template>
      </nav>

      <div class="scroll-area" ref="feedEl" @scroll.passive="onScrollAreaScroll">
        <div class="inner">
          <div class="welcome">
            <img
              class="welcome-logo"
              src="/images/logo-cepi.png"
              alt="CEPI"
            />
            <p>
              Hola, soy el asistente virtual de<br />
              <strong>CEPI Centro de la Piel</strong>.<br />
              ¿En qué puedo ayudarte hoy?
            </p>
            <div v-if="!turns.length" class="initial-mode">
              <p class="initial-mode-q">¿Es una consulta general o atención a un paciente?</p>
              <div class="initial-mode-actions">
                <button @click="send('general')" :disabled="busy">Consulta general</button>
                <button @click="send('paciente')" :disabled="busy">Atención a paciente</button>
                <button @click="send('informacion paciente')" :disabled="busy">Información paciente</button>
              </div>
            </div>
          </div>

          <div class="messages">
            <div v-for="(t, i) in turns" :key="i" :class="['turn', t.role]">
              <span class="role">{{ labelFor(t.role) }}</span>
              <ToolResult v-if="t.role === 'tool'" :tool-name="t.tool_name || ''" :raw-content="t.content" @action="send" />
              <pre v-else class="content">{{ t.content }}</pre>
            </div>
            <div v-if="busy" class="turn assistant"><span class="role">…</span><pre class="content">pensando…</pre></div>
          </div>

          <div v-if="quickReplies.length && !busy" class="quick-replies">
            <button
              v-for="(q, i) in quickReplies"
              :key="i"
              class="quick-reply"
              @click="onQuickReply(q)"
            >{{ q.label }}</button>
          </div>

          <div v-if="botForm && !busy" ref="botFormWrap">
            <BotForm
              :key="botForm.id"
              :form="botForm"
              :busy="busy"
              @send="send"
              @submit="onFormSubmit"
            />
          </div>

          <div v-if="pending" class="pending-card">
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
              placeholder="Escribe un mensaje…"
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

    <div v-if="showFicha" class="ficha-modal" @click.self="showFicha = false">
      <div class="ficha-panel">
        <div class="ficha-head">
          <strong>Ficha clínica — {{ patientLabel || 'Paciente' }}</strong>
          <div class="ficha-head-actions">
            <button type="button" class="fh-save" @click="onSaveFicha">Guardar</button>
            <button type="button" @click="printFicha">Imprimir</button>
            <button type="button" @click="showFicha = false">Cerrar</button>
          </div>
        </div>
        <div class="ficha-pager">
          <button
            type="button"
            :disabled="fichaIndex >= fichaEpisodes.length - 1"
            @click="fichaStep(1)"
          >‹ Anterior</button>
          <span class="fp-label">{{ fichaPagerLabel }}</span>
          <button
            type="button"
            :disabled="fichaIndex <= 0"
            @click="fichaStep(-1)"
          >Siguiente ›</button>
        </div>
        <iframe
          :key="fichaIndex"
          ref="fichaFrame"
          class="ficha-frame"
          src="/ficha.html"
          @load="onFichaLoad"
        ></iframe>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, nextTick, onMounted, watch } from 'vue';
import { chat, saveSessionId, uploadAttachment, listBotSessions, loadBotSession } from '../api.js';
import ToolResult from './ToolResult.vue';
import BotForm from './BotForm.vue';

defineProps({ user: Object });

const turns = ref([]);             // ChatTurn[]
const draft = ref('');
const busy  = ref(false);
const uploading = ref(false);
const pendingAttachment = ref(null);
const error = ref('');
const sessionId = ref(null);
const sessions = ref([]);
const showOpen = ref(true);
const showClosed = ref(false);
const filteredSessions = computed(() => sessions.value.filter(s => {
  const isClosed = s.estado === 'cerrada' || s.estado === 'abandonada';
  return isClosed ? showClosed.value : showOpen.value;
}));
const activePatient = ref(null);
const activeEpisode = ref(null);
const pending = ref(null);
const quickReplies = ref([]);
const botForm = ref(null);
const botFormWrap = ref(null);
const bookmarks = ref([]);
// Group bookmarks into ordered category sections. Bookmarks arrive already
// ordered and grouped by category (consecutive), so a single pass suffices.
const bookmarkGroups = computed(() => {
  const out = [];
  for (const bm of bookmarks.value) {
    const last = out[out.length - 1];
    if (last && last.category === (bm.category || '')) last.items.push(bm);
    else out.push({ category: bm.category || '', items: [bm] });
  }
  return out;
});
const showFicha = ref(false);
const fichaFrame = ref(null);
const fichaEpisodes = ref([]);   // patient's episodes, most-recent first
const fichaIndex = ref(0);       // which episode the viewer is showing

const fichaPagerLabel = computed(() => {
  const total = fichaEpisodes.value.length;
  if (!total) return 'Sin episodios registrados';
  const ep = fichaEpisodes.value[fichaIndex.value];
  const fecha = ep?.data?.fecha || 's/f';
  return `${fecha} · episodio ${total - fichaIndex.value} de ${total}`;
});

async function fetchEntity(id) {
  try {
    const res = await fetch(`/api/entities/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('cepi.jwt') || ''}` },
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.data || null;
  } catch {
    return null;
  }
}

// All episodes of a patient, sorted most-recent first (for the ficha paginator).
async function fetchEpisodes(patientId) {
  try {
    const params = new URLSearchParams({
      type: 'business',
      entity_id: '12000000-0000-0000-0000-000000000000',
      'filter[patient_id]': patientId,
      limit: '100',
    });
    const res = await fetch(`/api/entities?${params}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('cepi.jwt') || ''}` },
    });
    if (!res.ok) return [];
    const body = await res.json();
    const rows = Array.isArray(body?.data) ? body.data : [];
    rows.sort((a, b) =>
      String(b?.data?.fecha || '').localeCompare(String(a?.data?.fecha || '')));
    return rows;
  } catch {
    return [];
  }
}

// Open the ficha viewer: load the patient's episodes and start on the
// session's active episode (the last one in patient-info mode).
async function openFicha() {
  fichaEpisodes.value = [];
  fichaIndex.value = 0;
  if (activePatient.value) {
    const eps = await fetchEpisodes(activePatient.value);
    fichaEpisodes.value = eps;
    const i = eps.findIndex(e => e.id === activeEpisode.value);
    fichaIndex.value = i >= 0 ? i : 0;
  }
  showFicha.value = true;
}

// Paginate: dir +1 → older episode, -1 → newer. The iframe :key reloads it.
function fichaStep(dir) {
  const n = fichaIndex.value + dir;
  if (n >= 0 && n < fichaEpisodes.value.length) fichaIndex.value = n;
}

// Fill docs/ficha.html (served from /ficha.html) with patient + episode data.
async function onFichaLoad() {
  const frame = fichaFrame.value;
  if (!frame?.contentWindow?.fillFicha) return;
  let pdata = {};
  if (activePatient.value) {
    const p = await fetchEntity(activePatient.value);
    pdata = p?.data || {};
  }
  const edata = fichaEpisodes.value[fichaIndex.value]?.data || {};
  const data = { ...pdata, ...edata };
  data.nombre = [pdata.nombre, pdata.apellidos].filter(Boolean).join(' ') || data.nombre;
  if (!data.edad && pdata.fecha_nac) {
    const d = new Date(pdata.fecha_nac);
    if (!isNaN(d.getTime())) {
      const now = new Date();
      let a = now.getFullYear() - d.getFullYear();
      const m = now.getMonth() - d.getMonth();
      if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a--;
      if (a >= 0 && a < 150) data.edad = a;
    }
  }
  try { frame.contentWindow.fillFicha(data); } catch { /* ficha API not ready */ }

  // Highlight (red + bold) the labels of fields whose value differs from the
  // previous (older) episode's ficha.
  try {
    const cur = fichaEpisodes.value[fichaIndex.value]?.data || {};
    const prev = fichaEpisodes.value[fichaIndex.value + 1]?.data;
    const changed = [];
    if (prev) {
      const SKIP = new Set([
        'id', 'fecha', 'medico_id', 'patient_id', 'estado', 'tipo',
        'created_at', 'updated_at', 'ficha_num', 'examinador_nombre',
        'gravedad_total', 'location',
      ]);
      const norm = v =>
        (v === null || v === undefined || v === false || v === '') ? '' : String(v);
      const keys = new Set([...Object.keys(cur), ...Object.keys(prev)]);
      for (const k of keys) {
        if (SKIP.has(k) || k.includes(':')) continue;
        if (norm(cur[k]) !== norm(prev[k])) changed.push(k);
      }
    }
    frame.contentWindow.markChanges?.(changed);
  } catch { /* diff is best-effort */ }
}

function printFicha() {
  fichaFrame.value?.contentWindow?.print();
}

// Read the edited ficha and persist it through the bot (updates both the
// patient + episode records and the chat's patient context).
function onSaveFicha() {
  const frame = fichaFrame.value;
  if (!frame?.contentWindow?.readFicha) return;
  let data;
  try { data = frame.contentWindow.readFicha(); } catch { return; }
  const ep = fichaEpisodes.value[fichaIndex.value];
  showFicha.value = false;
  send('', { formSubmission: { form_id: 'ficha_save', episode_id: ep?.id || null, data } });
}

function onQuickReply(q) {
  quickReplies.value = [];
  send(q.send);
}
const patientLabel = ref('');
const episodeLabel = ref('');
const diagnosticoLetra = ref('');   // §5 traffic-light: '', 'A', 'B' or 'C'
const dxOptions = [
  { letra: 'A', cls: 'dx-a', title: 'A — verde' },
  { letra: 'B', cls: 'dx-b', title: 'B — amarillo' },
  { letra: 'C', cls: 'dx-c', title: 'C — rojo' },
];

// Bookmark rail — Dock-style magnifier. Affects at most 5 elements (the one
// under the cursor + 2 above + 2 below). Optimised: layout positions are
// cached once per hover, and the DOM is only written when the centre changes.
const railEl = ref(null);
let railItems = [];          // [{ el, top, h }] — rest layout, cached once
let railCenter = -1;         // index currently magnified as the centre
const RAIL_SCALE = [2, 1.55, 1.22];   // centre, ±1, ±2
const RAIL_PULL = [1, 0.5, 0.2];      // fraction of the tab pulled into view
const RAIL_W = 40;                    // visible strip width (rail width, px)
const RAIL_REST_MARGIN = 0;           // tabs share the rail height via flex

function cacheRail() {
  railItems = railEl.value
    ? [...railEl.value.querySelectorAll('.bookmark-tab, .bookmark-cat')]
        .map(el => ({ el, top: el.offsetTop, h: el.offsetHeight, w: el.offsetWidth }))
    : [];
  railCenter = -1;
}

// How far a tab at distance `d` from the centre must be pushed so the
// magnified tabs don't overlap. Pure visual translate — never shifts layout,
// so the cached rest positions stay exact and the centre is always correct.
function railPush(h, d) {
  const step = h + RAIL_REST_MARGIN;          // rest centre-to-centre spacing
  let push = 0;
  for (let k = 1; k <= d; k++) {
    const needed = (h * (RAIL_SCALE[k - 1] + RAIL_SCALE[k])) / 2;
    push += needed - step;
  }
  return push;
}

function onRailMove(e) {
  if (!railEl.value) return;
  if (!railItems.length) cacheRail();
  const rect = railEl.value.getBoundingClientRect();   // one rect read per move
  const y = e.clientY - rect.top;
  let idx = railItems.findIndex(it => y >= it.top && y < it.top + it.h);
  if (idx < 0) idx = y < 0 ? 0 : railItems.length - 1;
  if (idx === railCenter) return;                      // cursor still in same tab
  railCenter = idx;
  railItems.forEach((it, i) => {
    const d = i - idx;
    const ad = Math.abs(d);
    if (ad > 2) {
      it.el.style.transform = '';
      it.el.style.zIndex = '';
      return;
    }
    const s = RAIL_SCALE[ad];
    // Tabs rest right-aligned, tucked off the left edge. Pull them rightwards
    // into view: the centre fully (just enough to read), neighbours partly.
    const tx = Math.max(0, it.w - RAIL_W) * RAIL_PULL[ad];
    const ty = ad === 0 ? 0 : Math.sign(d) * railPush(it.h, ad);
    it.el.style.transform =
      `translateX(${tx.toFixed(1)}px) translateY(${ty.toFixed(1)}px) scale(${s})`;
    it.el.style.zIndex = String(30 - ad);
  });
}

function onRailLeave() {
  railItems.forEach(it => { it.el.style.transform = ''; it.el.style.zIndex = ''; });
  railCenter = -1;
}

// Set the §5 diagnosis letter on the active episode (optimistic + persisted).
function setDiagnostico(letra) {
  if (busy.value || !activeEpisode.value) return;
  diagnosticoLetra.value = letra;
  send('', {
    formSubmission: {
      form_id: 'set_diagnostico',
      episode_id: activeEpisode.value,
      data: { diagnostico_letra: letra },
    },
  });
}

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

// Structured form submission ({ form_id, data }) from a BotForm ficha section.
function onFormSubmit(payload) {
  send('', { formSubmission: payload });
}

async function send(message, opts = {}) {
  const fs = opts.formSubmission || null;
  if ((!message || !message.trim()) && !fs) return;
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  // Optimistically render the user turn while waiting.
  turns.value = [...turns.value, { role: 'user', content: message || '📋 Formulario enviado' }];
  try {
    const r = await chat(message || '', sessionId.value, fs ? { formSubmission: fs } : {});
    if (r?.session_id) {
      sessionId.value = r.session_id;
      saveSessionId(r.session_id);
    }
    if (typeof r?.active_patient_id !== 'undefined') activePatient.value = r.active_patient_id;
    if (typeof r?.active_episode_id !== 'undefined') activeEpisode.value = r.active_episode_id;
    if (typeof r?.pending_action     !== 'undefined') pending.value = r.pending_action;
    quickReplies.value = Array.isArray(r?.quick_replies) ? r.quick_replies : [];
    // Only touch the form when the response explicitly carries one — other
    // turns leave it in place so it persists until filled.
    if (r && 'form' in r) botForm.value = r.form || null;
    if (r && 'bookmarks' in r) bookmarks.value = Array.isArray(r.bookmarks) ? r.bookmarks : [];
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
    // Bot signaled it closed the session — drop our id so the next message
    // creates a fresh one, and refresh the sidebar so the closed entry shows.
    if (r?.session_closed) {
      sessionId.value = null;
      localStorage.removeItem('cepi.session_id');
      activePatient.value = null;
      activeEpisode.value = null;
      pending.value = null;
      quickReplies.value = [];
      botForm.value = null;
      bookmarks.value = [];
      refreshSessions();
    }
  } catch (e) {
    error.value = e.message || String(e);
  } finally {
    busy.value = false;
    // Once the DOM has rendered the form (BotForm has v-if="botForm && !busy"),
    // smooth-scroll it into view so a newly shown form (e.g. after clicking a
    // bookmark) is visible without manual scrolling.
    await nextTick();
    if (botForm.value && botFormWrap.value) {
      botFormWrap.value.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
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
  showFicha.value = false;
  patientLabel.value = v ? await resolveLabel(v, ['nombre', 'apellidos']) : '';
});
watch(activeEpisode, async (v) => {
  if (!v) { episodeLabel.value = ''; diagnosticoLetra.value = ''; return; }
  const e = await fetchEntity(v);
  const d = e?.data || {};
  episodeLabel.value = [d.fecha, d.motivo_consulta].filter(Boolean).join(' · ');
  diagnosticoLetra.value = d.diagnostico_letra || '';
});

function newSession() {
  sessionId.value = null;
  localStorage.removeItem('cepi.session_id');
  turns.value = [];
  activePatient.value = null;
  activeEpisode.value = null;
  pending.value = null;
  quickReplies.value = [];
  botForm.value = null;
  bookmarks.value = [];
}

function openBookmark(bm) {
  if (busy.value) return;
  send('', { formSubmission: { form_id: 'ficha_goto', data: { group: bm.id } } });
}

async function refreshSessions() {
  try {
    const r = await listBotSessions();
    sessions.value = Array.isArray(r?.sessions) ? r.sessions : [];
  } catch {
    sessions.value = [];
  }
}

async function openSession(id) {
  if (busy.value || id === sessionId.value) return;
  busy.value = true;
  try {
    const s = await loadBotSession(id);
    sessionId.value = s.session_id || id;
    saveSessionId(sessionId.value);
    turns.value = Array.isArray(s.history) ? s.history.filter(t => t.role !== 'system') : [];
    activePatient.value = s.active_patient_id || null;
    activeEpisode.value = s.active_episode_id || null;
    pending.value       = s.pending_action     || null;
    quickReplies.value  = [];
    botForm.value       = s.form || null;   // restore the persisted form
    bookmarks.value     = Array.isArray(s.bookmarks) ? s.bookmarks : [];
  } catch (e) {
    error.value = e.message || String(e);
  } finally {
    busy.value = false;
  }
}

function formatSessionDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
}

onMounted(() => {
  // Always boot with a fresh, empty session view. The sidebar lists the
  // user's previous sessions so they can resume one explicitly.
  localStorage.removeItem('cepi.session_id');
  refreshSessions();
});

// Refresh the sidebar list whenever the active session id changes (new
// session created on first message, or user switches sessions).
watch(sessionId, () => { refreshSessions(); });
</script>

<style scoped>
.chat-wrap {
  display: grid;
  grid-template-columns: 220px 1fr;
  gap: 16px;
  height: 100%;
  min-height: 0;
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
  min-height: 0; overflow-y: auto;
}
.side h3 {
  font-size: 12px; text-transform: uppercase; color: var(--accent);
  margin: 0 0 8px; letter-spacing: .04em; font-weight: 700;
}
.sessions-filter {
  display: flex; gap: 12px;
  margin-bottom: 8px;
  font-size: 12px; color: var(--text-muted);
}
.sessions-filter label {
  display: inline-flex; align-items: center; gap: 4px;
  cursor: pointer;
}
.sessions-filter input[type="checkbox"] {
  accent-color: var(--accent);
  cursor: pointer;
}
.sessions-list {
  display: flex; flex-direction: column; gap: 4px;
  margin-bottom: 8px;
}
.session-item {
  background: var(--bot-bg, #fff);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
  text-align: left;
  cursor: pointer;
  font-size: 12px;
  transition: background 0.15s, border-color 0.15s;
}
.session-item:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--bg);
}
.session-item.active {
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
}
.session-item.active .session-meta { color: rgba(255,255,255,0.85); }
.session-item:disabled { opacity: .55; cursor: not-allowed; }
.session-preview {
  font-weight: 500;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  margin-bottom: 2px;
}
.session-meta {
  display: flex; justify-content: space-between; align-items: center;
  font-size: 10px; color: var(--text-muted);
}
.session-state {
  text-transform: uppercase; letter-spacing: .04em; font-weight: 600;
  padding: 1px 5px; border-radius: 8px;
  background: rgba(0,0,0,0.06);
}
.session-state.cerrada   { background: rgba(220, 38, 38, 0.12); color: #b91c1c; }
.session-state.abandonada { background: rgba(148, 163, 184, 0.18); color: #64748b; }
.session-item.active .session-state { background: rgba(255,255,255,0.22); color: #fff; }

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
.muted { color: var(--text-muted); font-size: 12px; word-break: break-all; }

.ctx { display: flex; flex-direction: column; gap: 6px; }
.ctx-row { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.ctx-label { color: #475569; font-weight: 600; min-width: 60px; }
.ctx code  { font-family: ui-monospace, monospace; color: #1e293b; background: #f1f5f9; padding: 2px 4px; border-radius: 3px; }
.ctx-uuid  { margin-left: 4px; font-size: 10px; color: #64748b; }
.ctx strong { color: #1e293b; font-size: 12px; }
.ctx .link { background: transparent; color: var(--text-muted); border: 0; padding: 0; cursor: pointer; }

.main {
  display: flex; flex-direction: column;
  background: #fff; border: 1px solid var(--border); border-radius: 12px;
  min-height: 0; overflow: hidden;
  transition: background 80ms ease;
  box-shadow: 0 1px 4px rgba(0,0,0,0.04);
  position: relative;
}

/* Bookmark rail — fills the chat height exactly, no scroll. The 67 tabs +
   category headers share the height via flex; the magnifier (JS) scales
   the cursor's neighbourhood without shifting layout. */
.bookmark-rail {
  position: absolute;
  left: 0;
  top: 56px;
  bottom: 20%;          /* shorter rail → each tab ~20% shorter */
  z-index: 15;
  width: 40px;
  display: flex;
  flex-direction: column;
  align-items: flex-end;          /* tabs anchored to the right edge */
  overflow: visible;
}
/* Tabs + category headers — equal slices of the rail height. */
.bookmark-tab,
.bookmark-cat {
  box-sizing: border-box;
  flex: 1 1 0;
  min-height: 0;
  width: max-content;
  min-width: 40px;          /* never narrower than the rail strip */
  border: 1px solid var(--border);
  border-left: 0;
  border-top-width: 0;
  border-radius: 0 4px 4px 0;
  font-size: 0.34rem;
  line-height: 1;
  padding: 0 6px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  text-align: right;
  white-space: nowrap;
  overflow: visible;
  /* Rest: right-aligned, tucked off the left edge (only the right strip
     shows). The magnifier pulls the cursor's neighbourhood into view. */
  transform-origin: left center;
  transition: background 0.12s, opacity 0.12s, transform 0.08s ease-out;
}
.bookmark-tab {
  background: var(--accent);
  color: #fff;
  font-weight: 600;
  cursor: pointer;
}
.bookmark-cat {
  background: #e4e8ec;
  color: var(--accent);
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: .02em;
}
.bookmark-tab:first-child,
.bookmark-cat:first-child { border-top-width: 1px; }
.bookmark-tab.done {
  opacity: 0.35;
}
.bookmark-tab.done:hover:not(:disabled) {
  opacity: 0.6;
}
.bookmark-tab:disabled { cursor: not-allowed; }
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
.initial-mode {
  display: flex; flex-direction: column; align-items: center; gap: 0.75rem;
  margin-top: 0.5rem;
}
.initial-mode-q {
  color: var(--text); font-weight: 600; font-size: 1rem; margin: 0;
}
.initial-mode-actions { display: flex; gap: 0.6rem; flex-wrap: wrap; justify-content: center; }
.initial-mode-actions button {
  background: var(--accent); color: #fff; border: none;
  border-radius: 22px; padding: 0.55rem 1.2rem;
  font-weight: 700; font-size: 0.9rem; cursor: pointer;
  transition: background .15s, transform .1s;
}
.initial-mode-actions button:hover:not(:disabled) {
  background: var(--accent-hover); transform: scale(1.03);
}
.initial-mode-actions button:disabled { opacity: .55; cursor: not-allowed; }

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
.turn.tool .role      { color: #835000; }

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
.tool-name { font-size: 11px; color: var(--text-muted); align-self: start; }

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

.quick-replies {
  display: flex; flex-wrap: wrap; gap: 6px;
  padding: 4px 0;
}
.quick-reply {
  border: 1.5px solid var(--accent); background: #fff; color: var(--accent);
  padding: 0.4rem 0.85rem; border-radius: 18px;
  font-size: 0.85rem; font-weight: 600; cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.quick-reply:hover { background: var(--accent); color: #fff; }

/* Sticky patient bar at the top of the chat. */
.patient-bar {
  display: flex; align-items: center; justify-content: space-between;
  gap: 8px; padding: 8px 14px; flex-shrink: 0;
  background: var(--accent-band, #f1f5f9);
  border-bottom: 1px solid var(--border);
}
.pb-name { font-weight: 700; font-size: 0.9rem; color: #fff; }
.pb-ficha {
  border: 1.5px solid var(--accent); background: #fff; color: var(--accent);
  border-radius: 16px; padding: 0.32rem 0.9rem;
  font-weight: 700; font-size: 0.8rem; cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.pb-ficha:hover { background: var(--accent); color: #fff; }

.pb-right { display: flex; align-items: center; gap: 12px; }
.dx-light { display: flex; align-items: center; gap: 4px; }
.dx-caption {
  font-size: 0.68rem; font-weight: 700; text-transform: uppercase;
  letter-spacing: .05em; color: #fff; margin-right: 2px;
}
.dx-dot {
  width: 24px; height: 24px; border-radius: 50%;
  border: 1.6px solid currentColor; background: #fff;
  display: flex; align-items: center; justify-content: center;
  font-weight: 800; font-size: 0.74rem;
  opacity: .5; transition: opacity .12s, transform .1s;
}
.dx-dot:hover:not(:disabled) { opacity: 1; transform: scale(1.08); }
.dx-dot:disabled { cursor: not-allowed; }
.dx-dot.on { opacity: 1; color: #fff; box-shadow: 0 0 0 2px rgba(0,0,0,.12); }
.dx-a { color: #1f9d57; }
.dx-b { color: #b9881a; }
.dx-c { color: #c43d3d; }
.dx-a.on { background: #1f9d57; border-color: #1f9d57; }
.dx-b.on { background: #d8a01f; border-color: #d8a01f; }
.dx-c.on { background: #c43d3d; border-color: #c43d3d; }

/* Ficha clínica modal viewer. */
.ficha-modal {
  position: fixed; inset: 0; z-index: 50;
  background: rgba(0, 0, 0, 0.5);
  display: flex; align-items: center; justify-content: center;
  padding: 16px;
}
.ficha-panel {
  background: #fff; border-radius: 10px; overflow: hidden;
  width: min(840px, 96vw); height: min(96vh, 1200px);
  display: flex; flex-direction: column;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.3);
}
.ficha-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px; border-bottom: 1px solid var(--border);
  font-size: 0.9rem;
}
.ficha-head-actions { display: flex; gap: 6px; }
.ficha-head button {
  border: 1.5px solid var(--border); background: #f8fafc; color: var(--text);
  border-radius: 6px; padding: 4px 12px; cursor: pointer;
  font-weight: 600; font-size: 0.82rem;
}
.ficha-head button:hover { border-color: var(--accent); color: var(--accent); }
.ficha-head button.fh-save {
  background: var(--accent); color: #fff; border-color: var(--accent);
}
.ficha-head button.fh-save:hover { background: var(--accent-hover); color: #fff; }
.ficha-pager {
  display: flex; align-items: center; justify-content: center; gap: 14px;
  padding: 6px 12px; flex-shrink: 0;
  background: var(--bg); border-bottom: 1px solid var(--border);
}
.ficha-pager button {
  border: 1.5px solid var(--border); background: #fff; color: var(--text);
  border-radius: 6px; padding: 3px 12px; cursor: pointer;
  font-weight: 600; font-size: 0.8rem;
}
.ficha-pager button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.ficha-pager button:disabled { opacity: .4; cursor: not-allowed; }
.fp-label { font-size: 0.82rem; color: var(--text-muted); font-weight: 600; }
.ficha-frame { flex: 1; width: 100%; border: 0; background: #e8e8e8; }
</style>
