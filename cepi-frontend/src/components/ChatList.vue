<template>
  <aside class="clist">
    <div class="clist-head">
      <input v-model="q" class="search" type="search" placeholder="Buscar paciente o cédula…" />
      <button class="reload" :disabled="busy" title="Refrescar" @click="load">↻</button>
    </div>

    <button class="newpat" @click="showCreate = !showCreate">＋ Nuevo paciente</button>
    <form v-if="showCreate" class="createform" @submit.prevent="create">
      <input v-model="cNombre" placeholder="Nombre *" autocomplete="off" />
      <input v-model="cApellido" placeholder="Apellido *" autocomplete="off" />
      <input v-model="cCedula" placeholder="Cédula *" autocomplete="off" />
      <div class="cf-actions">
        <button type="submit" :disabled="creating || !cNombre.trim() || !cApellido.trim() || !cCedula.trim()">{{ creating ? 'Creando…' : 'Crear' }}</button>
        <button type="button" class="cf-cancel" @click="showCreate = false">Cancelar</button>
      </div>
      <p v-if="createError" class="error">{{ createError }}</p>
    </form>

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
        :class="{ active: p.id === activeId, 'to-review': !!reviewQueue[p.id] }"
        @click="$emit('select', p)"
      >
        <span class="avatar">{{ initials(p) }}</span>
        <span class="info">
          <span class="name">{{ fullName(p) }}</span>
          <span class="cc">CC: {{ p.data?.cedula || '—' }}</span>
        </span>
        <span
          v-if="reviewQueue[p.id]"
          class="rev-badge"
          :title="`${reviewQueue[p.id].pending} pendiente(s) de revisión derivada(s) a vos`"
        >🔔 revisar</span>
      </button>
    </div>
    <p v-else-if="!busy" class="empty">{{ q ? 'Sin coincidencias' : 'No hay pacientes' }}</p>
    <p v-if="error" class="error">{{ error }}</p>
  </aside>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { listPatients, createPatient, getReviewQueue } from '../api.js';

defineProps({
  activeId: { type: String, default: null },
  generalActive: { type: Boolean, default: false },
});
const emit = defineEmits(['select', 'general']);

const all = ref([]);
const reviewQueue = ref({});   // { patientId: { pending, earliest_due } } — derived to me
const q = ref('');
const busy = ref(false);
const error = ref('');

const showCreate = ref(false);
const cNombre = ref('');
const cApellido = ref('');
const cCedula = ref('');
const creating = ref(false);
const createError = ref('');

async function create() {
  if (!cNombre.value.trim() || !cApellido.value.trim() || !cCedula.value.trim()) return;
  creating.value = true;
  createError.value = '';
  try {
    const p = await createPatient({ nombre: cNombre.value.trim(), apellidos: cApellido.value.trim(), cedula: cCedula.value.trim() });
    cNombre.value = '';
    cApellido.value = '';
    cCedula.value = '';
    showCreate.value = false;
    await load();
    if (p?.id) emit('select', p);
  } catch (e) {
    createError.value = e.message || String(e);
  } finally {
    creating.value = false;
  }
}

function fullName(p) {
  return [p.data?.nombre, p.data?.apellidos].filter(Boolean).join(' ') || p.title || 'Paciente';
}
function initials(p) {
  const n = fullName(p);
  return n.split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';
}

const filtered = computed(() => {
  const t = q.value.trim().toLowerCase();
  let list = all.value;
  if (t) list = all.value.filter(p => {
    const n = fullName(p).toLowerCase();
    const c = String(p.data?.cedula || '').toLowerCase();
    return n.includes(t) || c.includes(t);
  });
  // Patients with items pending my review (derived to me) come first, soonest
  // due first; everyone else keeps their original order.
  const rq = reviewQueue.value;
  return list.map((p, i) => ({ p, i })).sort((a, b) => {
    const ra = rq[a.p.id], rb = rq[b.p.id];
    if (ra && !rb) return -1;
    if (!ra && rb) return 1;
    if (ra && rb) {
      const da = ra.earliest_due ? new Date(ra.earliest_due).getTime() : Infinity;
      const db = rb.earliest_due ? new Date(rb.earliest_due).getTime() : Infinity;
      if (da !== db) return da - db;
    }
    return a.i - b.i;
  }).map(x => x.p);
});

async function load() {
  busy.value = true;
  error.value = '';
  try {
    const r = await listPatients({});
    all.value = Array.isArray(r?.data) ? r.data : [];
    try {
      const rq = await getReviewQueue();
      reviewQueue.value = rq?.by_patient || {};
    } catch { reviewQueue.value = {}; }
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
.row.to-review { background: #fff7ed; box-shadow: inset 3px 0 0 #f97316; }
.row.to-review.active { background: var(--accent-band, #e8f3f8); }
.rev-badge {
  flex-shrink: 0; margin-left: auto; align-self: center;
  background: #f97316; color: #fff; border-radius: 12px;
  padding: 2px 8px; font-size: 0.66rem; font-weight: 800; white-space: nowrap;
}
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
.newpat {
  margin: 8px 10px 4px; padding: 9px; border: none; border-radius: 20px;
  background: var(--accent); color: #fff; font-weight: 700; font-size: 0.88rem; cursor: pointer;
}
.createform { display: flex; flex-direction: column; gap: 6px; padding: 4px 10px 10px; border-bottom: 1px solid var(--border); }
.createform input { padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); font-size: 14px; }
.cf-actions { display: flex; gap: 6px; }
.cf-actions button { flex: 1; padding: 7px; border: none; border-radius: 6px; background: var(--accent); color: #fff; font-weight: 600; cursor: pointer; }
.cf-actions button[disabled] { opacity: .55; cursor: not-allowed; }
.cf-actions .cf-cancel { background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); }
.empty, .error { padding: 14px; color: var(--text-muted); font-size: 14px; }
.error { color: #dc2626; }
</style>
