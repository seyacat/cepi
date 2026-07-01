<template>
  <div class="admin">
    <div class="bar">
      <h2>Usuarios</h2>
      <select v-model="filter" @change="loadUsers">
        <option value="pendiente">Pendientes</option>
        <option value="">Todos</option>
      </select>
      <input
        v-model="search"
        class="search"
        type="search"
        placeholder="Buscar nombre, cédula o rol…"
      />
      <button class="refresh" @click="loadUsers" :disabled="busy" title="Refrescar">↻</button>
    </div>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="ok" class="ok">{{ ok }}</p>

    <div class="table-wrap" v-if="filteredRows.length">
      <table>
        <thead>
          <tr><th>Nombre</th><th>Email</th><th>Tel/Cédula</th><th>Rol</th><th>Organizaciones</th><th>Círculos</th><th>Activo</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="u in filteredRows" :key="u.id">
            <td>{{ u.name }}</td>
            <td class="email">{{ u.email }}<span v-if="u.email_verified === 'true'" title="email verificado"> ✅</span></td>
            <td class="muted">{{ u.phone || '—' }} / {{ u.cedula || '—' }}</td>
            <td>
              <select v-model="u.role_id">
                <option v-for="r in roles" :key="r.id" :value="r.id">{{ r.name }}</option>
              </select>
            </td>
            <td class="circles-cell">
              <div class="chips" v-if="orgs.length">
                <button
                  v-for="o in orgs"
                  :key="o.id"
                  type="button"
                  class="chip org"
                  :class="{ on: u.orgs.includes(o.id) }"
                  :title="o.name"
                  @click="toggleOrg(u, o.id)"
                >{{ u.orgs.includes(o.id) ? '✓ ' : '' }}{{ o.name }}</button>
              </div>
              <span v-else class="muted">—</span>
            </td>
            <td class="circles-cell">
              <div class="chips" v-if="circles.length">
                <button
                  v-for="c in circles"
                  :key="c.slug"
                  type="button"
                  class="chip"
                  :class="{ on: u.circles.includes(c.slug) }"
                  :title="c.name + (c.kind === 'specialty' ? ' (especialidad)' : ' (círculo)')"
                  @click="toggleCircle(u, c.slug)"
                >{{ u.circles.includes(c.slug) ? '✓ ' : '' }}{{ c.name }}</button>
              </div>
              <span v-else class="muted">—</span>
            </td>
            <td class="center"><input type="checkbox" v-model="u.active" /></td>
            <td><button @click="save(u)" :disabled="u._saving">{{ u._saving ? '…' : 'Guardar' }}</button></td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else-if="!busy && rows.length" class="muted">Ningún usuario coincide con «{{ search }}».</p>
    <p v-else-if="!busy" class="muted">No hay usuarios{{ filter ? ' con ese filtro' : '' }}.</p>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { adminListUsers, adminListRoles, adminUpdateUser, adminSetUserGroups, adminSetUserOrgs, listGroups, listOrgs } from '../api.js';

const rows = ref([]);
const roles = ref([]);
const circles = ref([]);
const orgs = ref([]);
const filter = ref('pendiente');
const search = ref('');
const busy = ref(false);

// Filtro local sobre las filas ya cargadas: nombre, cédula o rol.
const filteredRows = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return rows.value;
  return rows.value.filter(u =>
    [u.name, u.cedula, u.role].some(v => (v || '').toLowerCase().includes(q))
  );
});
const error = ref('');
const ok = ref('');

async function loadRoles() {
  try {
    const r = await adminListRoles();
    roles.value = r?.roles || [];
  } catch (e) { error.value = e.message || String(e); }
}

async function loadCircles() {
  try {
    const r = await listGroups();
    // Exclude the on-call 'turno' roster and the virtual 'all' group — only real
    // specialties/circles have assignable membership.
    circles.value = (r?.data || []).filter(g => g.kind !== 'roster' && g.kind !== 'all');
  } catch (e) { error.value = e.message || String(e); }
}

async function loadOrgs() {
  try {
    const r = await listOrgs();
    orgs.value = r?.orgs || [];
  } catch (e) { error.value = e.message || String(e); }
}

async function loadUsers() {
  busy.value = true; error.value = ''; ok.value = '';
  try {
    const u = await adminListUsers(filter.value);
    rows.value = (u?.users || []).map(x => ({
      ...x,
      active: !!x.active,
      circles: Array.isArray(x.circle_slugs) ? [...x.circle_slugs] : [],
      orgs: Array.isArray(x.org_ids) ? [...x.org_ids] : [],
    }));
  } catch (e) {
    error.value = e.message || String(e);
  } finally {
    busy.value = false;
  }
}

function toggleCircle(u, slug) {
  const i = u.circles.indexOf(slug);
  if (i >= 0) u.circles.splice(i, 1);
  else u.circles.push(slug);
}

function toggleOrg(u, orgId) {
  const i = u.orgs.indexOf(orgId);
  if (i >= 0) u.orgs.splice(i, 1);
  else u.orgs.push(orgId);
}

async function save(u) {
  u._saving = true; error.value = ''; ok.value = '';
  try {
    await adminUpdateUser(u.id, { role_id: u.role_id, active: u.active });
    await adminSetUserGroups(u.id, u.circles);
    await adminSetUserOrgs(u.id, u.orgs);
    ok.value = `Guardado: ${u.email}`;
  } catch (e) {
    error.value = e.message || String(e);
  } finally {
    u._saving = false;
  }
}

onMounted(async () => { await Promise.all([loadRoles(), loadCircles(), loadOrgs()]); await loadUsers(); });
</script>

<style scoped>
.admin { width: 100%; max-width: none; margin: 14px 0; padding: 0 16px; color: var(--text); height: 100%; overflow: auto; }
.bar { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; }
.bar h2 { margin: 0; color: var(--accent); flex: 1; font-size: 1.1rem; }
.search { padding: 5px 9px; min-width: 200px; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 4px; }
.refresh { padding: 5px 10px; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--border); vertical-align: middle; }
th { color: var(--text-muted); font-weight: 600; }
td.email { word-break: break-all; }
td.center { text-align: center; }
.muted { color: var(--text-muted); }
select { padding: 5px 7px; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 4px; }
button { padding: 5px 12px; background: var(--accent); color: #fff; border: none; border-radius: 4px; font-weight: 600; cursor: pointer; }
button[disabled] { opacity: .6; cursor: not-allowed; }
.error { color: #dc2626; font-size: 13px; }
.ok { color: #16a34a; font-size: 13px; }
.circles-cell { min-width: 180px; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip {
  padding: 3px 9px; border-radius: 12px; font-size: 12px; font-weight: 600; cursor: pointer;
  background: var(--bg); color: var(--text-muted); border: 1px solid var(--border);
}
.chip:hover { border-color: var(--accent); color: var(--accent); }
.chip.on { background: var(--accent); color: #fff; border-color: var(--accent); }
.chip.org.on { background: #0e7490; border-color: #0e7490; }
.chip.org:hover { border-color: #0e7490; color: #0e7490; }
</style>
