<template>
  <div class="tool-result">
    <div class="tool-header">
      <span class="tool-tag">tool</span>
      <code class="tool-name">{{ toolName }}</code>
      <span v-if="parsed?.error" class="tool-error">error</span>
    </div>

    <!-- Error path -->
    <pre v-if="parsed?.error" class="err">{{ parsed.error }}</pre>

    <!-- List of records (entities, classifications, ...) -->
    <table v-else-if="isRecordList" class="records">
      <thead>
        <tr>
          <th v-for="c in columns" :key="c">{{ c }}</th>
          <th class="actions" v-if="quickAction"></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, i) in rows" :key="i">
          <td v-for="c in columns" :key="c">{{ format(row[c]) }}</td>
          <td v-if="quickAction" class="actions">
            <button class="quick-btn" @click="$emit('action', quickAction.replace('{{id}}', row.id || ''))">
              {{ quickActionLabel }}
            </button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-else-if="isEmptyArray" class="muted">(0 resultados)</p>

    <!-- Single object → key/value -->
    <dl v-else-if="isObject" class="kv">
      <template v-for="(v, k) in flatObject" :key="k">
        <dt>{{ k }}</dt><dd>{{ format(v) }}</dd>
      </template>
    </dl>

    <!-- Fallback raw -->
    <pre v-else class="raw">{{ rawContent }}</pre>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  toolName: { type: String, default: '' },
  rawContent: { type: String, default: '' },
});

defineEmits(['action']);

// Suggest a per-row quick action depending on the entity type. The label
// is what the button shows; the templated string is what the parent will
// receive on click ({{id}} replaced with the row's UUID).
const ENTITY_DEF_PATIENT = '11000000-0000-0000-0000-000000000000';
const ENTITY_DEF_EPISODE = '12000000-0000-0000-0000-000000000000';

const quickAction = computed(() => {
  if (!Array.isArray(parsed.value) || !parsed.value.length) return null;
  const e = parsed.value[0]?.entity_id;
  if (e === ENTITY_DEF_PATIENT) return 'activar paciente {{id}}';
  if (e === ENTITY_DEF_EPISODE) return 'activar episodio {{id}}';
  return null;
});
const quickActionLabel = computed(() => {
  if (!quickAction.value) return '';
  if (quickAction.value.includes('paciente')) return 'activar';
  return 'activar';
});

const parsed = computed(() => {
  try { return JSON.parse(props.rawContent); } catch { return null; }
});

const isEmptyArray = computed(() => Array.isArray(parsed.value) && parsed.value.length === 0);
const isRecordList = computed(() =>
  Array.isArray(parsed.value) && parsed.value.length > 0 && typeof parsed.value[0] === 'object'
);

const PREFERRED_COLS = [
  'codigo','title','tipo','descripcion','nombre','apellidos','fecha','estado','field_key','body_region','due_at','status',
];

const columns = computed(() => {
  if (!isRecordList.value) return [];
  const allKeys = new Set();
  for (const r of parsed.value) {
    for (const k of Object.keys(r)) {
      if (k === 'data' || k === '_relations' || k.startsWith('_')) continue;
      allKeys.add(k);
    }
    // Also flatten one level of `data` for record_type='business' rows.
    if (r.data && typeof r.data === 'object') {
      for (const k of Object.keys(r.data)) {
        if (k.startsWith('_')) continue;
        allKeys.add('data.' + k);
      }
    }
  }
  const keys = [...allKeys];
  // sort with preferred first
  keys.sort((a, b) => {
    const ia = PREFERRED_COLS.findIndex(p => a === p || a === 'data.' + p);
    const ib = PREFERRED_COLS.findIndex(p => b === p || b === 'data.' + p);
    const ra = ia === -1 ? 999 : ia;
    const rb = ib === -1 ? 999 : ib;
    return ra - rb;
  });
  return keys.slice(0, 6);
});

const rows = computed(() => {
  return (parsed.value || []).map(r => {
    const out = { ...r };
    if (r.data) {
      for (const k of Object.keys(r.data)) out['data.' + k] = r.data[k];
    }
    return out;
  });
});

const isObject = computed(() => parsed.value && !Array.isArray(parsed.value) && typeof parsed.value === 'object');

const flatObject = computed(() => {
  if (!isObject.value) return {};
  const out = {};
  for (const [k, v] of Object.entries(parsed.value)) {
    if (k.startsWith('_')) continue;
    out[k] = v;
  }
  return out;
});

function format(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') {
    if (v.length > 80) return v.slice(0, 80) + '…';
    return v;
  }
  if (typeof v === 'object') {
    try { return JSON.stringify(v).slice(0, 80); } catch { return String(v); }
  }
  return String(v);
}
</script>

<style scoped>
.tool-result {
  background: #fffbeb; border: 1px solid #fde68a; border-radius: 6px; padding: 10px 12px;
  font-size: 13px;
}
.tool-header { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
.tool-tag { background: #fde68a; color: #92400e; font-size: 10px; text-transform: uppercase; padding: 2px 6px; border-radius: 3px; letter-spacing: .04em; }
.tool-name { font-family: ui-monospace, monospace; color: #92400e; }
.tool-error { background: #fecaca; color: #991b1b; font-size: 10px; text-transform: uppercase; padding: 2px 6px; border-radius: 3px; }
.err { color: #991b1b; white-space: pre-wrap; margin: 0; }
.records { width: 100%; border-collapse: collapse; }
.records th, .records td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #fde68a; }
.records th { color: #92400e; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .03em; }
.records td { color: #422006; font-family: ui-monospace, monospace; font-size: 12px; }
.records th.actions, .records td.actions { width: 1%; white-space: nowrap; }
.quick-btn {
  background: #14532d; color: #fff; border: none; padding: 2px 8px;
  border-radius: 3px; font-size: 11px; cursor: pointer;
}
.quick-btn:hover { background: #166534; }
.muted { color: #a16207; font-style: italic; margin: 0; }
.kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 0; }
.kv dt { color: #92400e; font-weight: 600; font-size: 12px; }
.kv dd { margin: 0; font-family: ui-monospace, monospace; font-size: 12px; color: #422006; word-break: break-word; }
.raw { white-space: pre-wrap; margin: 0; font-family: ui-monospace, monospace; font-size: 12px; color: #422006; }
</style>
