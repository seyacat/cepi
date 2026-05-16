<template>
  <div class="icdf" ref="rootEl">
    <input
      type="text"
      :value="modelValue"
      :disabled="busy"
      :placeholder="field.placeholder || 'Buscar diagnóstico en ICD-11 (OMS)…'"
      autocomplete="off"
      @input="onInput"
      @focus="open = results.length > 0"
    />
    <div v-if="open" class="icdf-drop">
      <div v-if="loading" class="icdf-msg">Buscando en ICD-11…</div>
      <template v-else>
        <button
          v-for="(r, i) in results"
          :key="i"
          type="button"
          class="icdf-opt"
          @click="pick(r)"
        ><b>{{ r.code || '—' }}</b> {{ r.title }}</button>
        <div v-if="!results.length" class="icdf-msg">Sin coincidencias.</div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';

const props = defineProps({
  field: { type: Object, required: true },
  modelValue: { type: String, default: '' },
  busy: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue']);

const rootEl = ref(null);
const results = ref([]);
const loading = ref(false);
const open = ref(false);
let debounceT = null;
let reqSeq = 0;

function onInput(e) {
  const q = e.target.value;
  emit('update:modelValue', q);            // typing edits the field value
  if (debounceT) clearTimeout(debounceT);
  if (q.trim().length < 3) { open.value = false; results.value = []; return; }
  open.value = true;
  loading.value = true;
  debounceT = setTimeout(async () => {
    const seq = ++reqSeq;
    try {
      const res = await fetch('/api/bot/icd/search?q=' + encodeURIComponent(q.trim()));
      const body = await res.json();
      if (seq !== reqSeq) return;            // a newer query superseded this
      results.value = (body && body.results) || [];
    } catch {
      if (seq === reqSeq) results.value = [];
    } finally {
      if (seq === reqSeq) loading.value = false;
    }
  }, 280);
}

function pick(r) {
  emit('update:modelValue', (r.code ? r.code + ' — ' : '') + r.title);
  open.value = false;
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
.icdf { position: relative; }
.icdf input {
  width: 100%;
  border: 1.5px solid var(--border);
  border-radius: 8px;
  padding: 0.55rem 0.85rem;
  font-size: 0.92rem;
  font-family: inherit;
  color: #111;
  background: var(--bg, #f1f5f9);
  outline: none;
  transition: border-color 0.15s;
}
.icdf input:focus { border-color: var(--accent); }
.icdf-drop {
  position: absolute;
  z-index: 40;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  max-height: 230px;
  overflow-y: auto;
  background: #fff;
  border: 1.5px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.12);
}
.icdf-opt {
  display: block;
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--border);
  padding: 0.45rem 0.7rem;
  font-size: 0.85rem;
  color: var(--text);
  cursor: pointer;
}
.icdf-opt:last-child { border-bottom: none; }
.icdf-opt:hover { background: var(--accent-band, #f1f5f9); }
.icdf-opt b { color: var(--accent); }
.icdf-msg { padding: 0.5rem 0.7rem; font-size: 0.82rem; color: var(--text-muted); }
</style>
