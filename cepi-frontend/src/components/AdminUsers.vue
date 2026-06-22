<template>
  <div class="admin">
    <div class="bar">
      <h2>Usuarios</h2>
      <select v-model="filter" @change="loadUsers">
        <option value="pendiente">Pendientes</option>
        <option value="">Todos</option>
      </select>
      <button class="refresh" @click="loadUsers" :disabled="busy" title="Refrescar">↻</button>
    </div>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="ok" class="ok">{{ ok }}</p>

    <div class="table-wrap" v-if="rows.length">
      <table>
        <thead>
          <tr><th>Nombre</th><th>Email</th><th>Tel/Cédula</th><th>Rol</th><th>Activo</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="u in rows" :key="u.id">
            <td>{{ u.name }}</td>
            <td class="email">{{ u.email }}<span v-if="u.email_verified === 'true'" title="email verificado"> ✅</span></td>
            <td class="muted">{{ u.phone || '—' }} / {{ u.cedula || '—' }}</td>
            <td>
              <select v-model="u.role_id">
                <option v-for="r in roles" :key="r.id" :value="r.id">{{ r.name }}</option>
              </select>
            </td>
            <td class="center"><input type="checkbox" v-model="u.active" /></td>
            <td><button @click="save(u)" :disabled="u._saving">{{ u._saving ? '…' : 'Guardar' }}</button></td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else-if="!busy" class="muted">No hay usuarios{{ filter ? ' con ese filtro' : '' }}.</p>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { adminListUsers, adminListRoles, adminUpdateUser } from '../api.js';

const rows = ref([]);
const roles = ref([]);
const filter = ref('pendiente');
const busy = ref(false);
const error = ref('');
const ok = ref('');

async function loadRoles() {
  try {
    const r = await adminListRoles();
    roles.value = r?.roles || [];
  } catch (e) { error.value = e.message || String(e); }
}

async function loadUsers() {
  busy.value = true; error.value = ''; ok.value = '';
  try {
    const u = await adminListUsers(filter.value);
    rows.value = (u?.users || []).map(x => ({ ...x, active: !!x.active }));
  } catch (e) {
    error.value = e.message || String(e);
  } finally {
    busy.value = false;
  }
}

async function save(u) {
  u._saving = true; error.value = ''; ok.value = '';
  try {
    await adminUpdateUser(u.id, { role_id: u.role_id, active: u.active });
    ok.value = `Guardado: ${u.email}`;
  } catch (e) {
    error.value = e.message || String(e);
  } finally {
    u._saving = false;
  }
}

onMounted(async () => { await loadRoles(); await loadUsers(); });
</script>

<style scoped>
.admin { max-width: 880px; margin: 14px auto; padding: 0 12px; color: var(--text); height: 100%; overflow: auto; }
.bar { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; }
.bar h2 { margin: 0; color: var(--accent); flex: 1; font-size: 1.1rem; }
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
</style>
