<template>
  <aside class="clist">
    <div class="clist-head">
      <input v-model="q" class="search" type="search" placeholder="Buscar paciente o cédula…" />
      <button class="reload" :disabled="busy" title="Refrescar" @click="load">↻</button>
    </div>

    <button
      class="general"
      :class="{ active: activeId === null && generalActive }"
      @click="$emit('general')"
    >
      <span class="avatar gen">＋</span>
      <span class="info"><span class="name">Consulta general</span><span class="cc">sin paciente</span></span>
    </button>

    <div class="rows" v-if="filtered.length">
      <button
        v-for="p in filtered"
        :key="p.id"
        class="row"
        :class="{ active: p.id === activeId }"
        @click="$emit('select', p)"
      >
        <span class="avatar">{{ initials(p) }}</span>
        <span class="info">
          <span class="name">{{ fullName(p) }}</span>
          <span class="cc">CC: {{ p.data?.cedula || '—' }}</span>
        </span>
      </button>
    </div>
    <p v-else-if="!busy" class="empty">{{ q ? 'Sin coincidencias' : 'No hay pacientes' }}</p>
    <p v-if="error" class="error">{{ error }}</p>
  </aside>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { listPatients } from '../api.js';

defineProps({
  activeId: { type: String, default: null },
  generalActive: { type: Boolean, default: false },
});
defineEmits(['select', 'general']);

const all = ref([]);
const q = ref('');
const busy = ref(false);
const error = ref('');

function fullName(p) {
  return [p.data?.nombre, p.data?.apellidos].filter(Boolean).join(' ') || p.title || 'Paciente';
}
function initials(p) {
  const n = fullName(p);
  return n.split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';
}

const filtered = computed(() => {
  const t = q.value.trim().toLowerCase();
  if (!t) return all.value;
  return all.value.filter(p => {
    const n = fullName(p).toLowerCase();
    const c = String(p.data?.cedula || '').toLowerCase();
    return n.includes(t) || c.includes(t);
  });
});

async function load() {
  busy.value = true;
  error.value = '';
  try {
    const r = await listPatients({});
    all.value = Array.isArray(r?.data) ? r.data : [];
  } catch (e) {
    error.value = e.message || String(e);
  } finally {
    busy.value = false;
  }
}

onMounted(load);
defineExpose({ reload: load });
</script>

<style scoped>
.clist {
  display: flex; flex-direction: column;
  height: 100%; min-height: 0;
  background: #fff; border: 1px solid var(--border); border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 1px 4px rgba(0,0,0,0.04);
}
.clist-head { display: flex; gap: 6px; padding: 10px; border-bottom: 1px solid var(--border); }
.search {
  flex: 1; padding: 8px 12px; border: 1px solid var(--border); border-radius: 20px;
  background: var(--bg); color: var(--text); font-size: 14px; outline: none;
}
.search:focus { border-color: var(--accent); }
.reload { width: 36px; border: 1px solid var(--border); border-radius: 50%; background: var(--bg); color: var(--accent); cursor: pointer; }
.rows { flex: 1; min-height: 0; overflow-y: auto; }
.row, .general {
  width: 100%; display: flex; align-items: center; gap: 10px;
  padding: 10px 12px; border: none; border-bottom: 1px solid var(--border);
  background: transparent; color: var(--text); cursor: pointer; text-align: left;
  transition: background 0.12s;
}
.row:hover, .general:hover { background: var(--bg); }
.row.active, .general.active { background: var(--accent-band, #e8f3f8); }
.general { border-bottom: 6px solid var(--bg); }
.avatar {
  flex-shrink: 0; width: 40px; height: 40px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: var(--accent); color: #fff; font-weight: 700; font-size: 0.85rem;
}
.avatar.gen { background: var(--text-muted); }
.info { display: flex; flex-direction: column; min-width: 0; }
.name { font-weight: 600; font-size: 0.92rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cc { font-size: 0.78rem; color: var(--text-muted); }
.empty, .error { padding: 14px; color: var(--text-muted); font-size: 14px; }
.error { color: #dc2626; }
</style>
