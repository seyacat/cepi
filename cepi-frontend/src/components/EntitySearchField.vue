<template>
  <div class="es-field" ref="rootEl">
    <input
      v-model="query"
      type="text"
      :placeholder="field.placeholder || ''"
      :disabled="busy"
      autocomplete="off"
      @input="onInput"
      @focus="open = true"
    />
    <div
      v-if="open"
      class="es-dropdown"
      ref="dropEl"
      @scroll.passive="onScroll"
    >
      <div v-if="query.trim().length < minChars" class="es-hint">
        Escribí al menos {{ minChars }} caracteres…
      </div>
      <template v-else>
        <button
          v-for="opt in results"
          :key="opt.id"
          type="button"
          class="es-option"
          @click="pick(opt)"
        >
          <span class="es-opt-label">{{ opt._label }}</span>
          <span v-if="opt._sub" class="es-opt-sub">{{ opt._sub }}</span>
        </button>
        <div v-if="loading" class="es-hint">Buscando…</div>
        <div v-else-if="!results.length" class="es-hint">Sin coincidencias.</div>
        <div v-else-if="!hasMore" class="es-hint es-end">— fin de resultados —</div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';

const props = defineProps({
  field: { type: Object, required: true },
  busy: { type: Boolean, default: false },
});
const emit = defineEmits(['select']);

const minChars = props.field.min_chars || 3;
const pageSize = props.field.page_size || 20;
const entityId = props.field.entity_id;

const query = ref('');
const results = ref([]);
const loading = ref(false);
const open = ref(false);
const hasMore = ref(false);
let offset = 0;
let debounceT = null;
let reqSeq = 0;

const rootEl = ref(null);
const dropEl = ref(null);

function buildLabel(rec) {
  const d = rec.data || {};
  const keys = props.field.result_label || ['title'];
  const parts = keys.map(k => d[k]).filter(Boolean);
  return parts.join(' ') || rec.title || String(rec.id || '').slice(0, 8);
}
function buildSub(rec) {
  const k = props.field.result_sub;
  return k ? ((rec.data || {})[k] || '') : '';
}

// Fetch one page. `reset` restarts pagination; otherwise appends (lazy load).
async function fetchPage(reset) {
  const q = query.value.trim();
  if (q.length < minChars) {
    results.value = [];
    hasMore.value = false;
    return;
  }
  if (loading.value) return;
  if (reset) offset = 0;
  loading.value = true;
  const seq = ++reqSeq;
  try {
    const params = new URLSearchParams({
      type: 'business',
      entity_id: entityId,
      q,
      limit: String(pageSize),
      offset: String(offset),
    });
    const res = await fetch(`/api/entities?${params}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('cepi.jwt') || ''}` },
    });
    const body = await res.json();
    if (seq !== reqSeq) return; // a newer query superseded this one
    const rows = (body && body.ok && Array.isArray(body.data)) ? body.data : [];
    const mapped = rows.map(r => ({ ...r, _label: buildLabel(r), _sub: buildSub(r) }));
    results.value = reset ? mapped : [...results.value, ...mapped];
    hasMore.value = rows.length === pageSize;
    offset += rows.length;
  } catch {
    if (seq === reqSeq) hasMore.value = false;
  } finally {
    if (seq === reqSeq) loading.value = false;
  }
}

function onInput() {
  open.value = true;
  if (debounceT) clearTimeout(debounceT);
  debounceT = setTimeout(() => fetchPage(true), 250);
}

function onScroll() {
  const el = dropEl.value;
  if (!el || loading.value || !hasMore.value) return;
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 48) {
    fetchPage(false);
  }
}

function pick(opt) {
  open.value = false;
  query.value = opt._label;
  const tpl = props.field.on_select_send || '{id}';
  const msg = tpl.replace(
    /\{(\w+)\}/g,
    (_, k) => opt[k] ?? (opt.data || {})[k] ?? '',
  );
  emit('select', msg);
}

function onDocClick(ev) {
  if (rootEl.value && !rootEl.value.contains(ev.target)) open.value = false;
}
onMounted(() => document.addEventListener('click', onDocClick));
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick);
  if (debounceT) clearTimeout(debounceT);
});
</script>

<style scoped>
.es-field { position: relative; }
.es-field input {
  width: 100%;
  border: 1.5px solid var(--border);
  border-radius: 8px;
  padding: 0.55rem 0.85rem;
  font-size: 0.92rem;
  outline: none;
  transition: border-color 0.15s;
}
.es-field input:focus { border-color: var(--accent); }
.es-dropdown {
  position: absolute;
  z-index: 40;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  max-height: 260px;
  overflow-y: auto;
  background: #fff;
  border: 1.5px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.12);
}
.es-option {
  display: flex;
  flex-direction: column;
  gap: 1px;
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--border);
  padding: 0.5rem 0.8rem;
  cursor: pointer;
}
.es-option:last-child { border-bottom: none; }
.es-option:hover { background: var(--accent-band, #f1f5f9); }
.es-opt-label { font-weight: 600; font-size: 0.88rem; color: var(--text); }
.es-opt-sub { font-size: 0.78rem; color: var(--text-muted); }
.es-hint {
  padding: 0.55rem 0.8rem;
  font-size: 0.8rem;
  color: var(--text-muted);
  text-align: center;
}
.es-end { font-style: italic; }
</style>
