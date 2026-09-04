<template>
  <div class="admin-wrap">
    <div class="admin-tabs">
      <button :class="{ on: tab === 'users' }" @click="tab = 'users'">Usuarios</button>
      <button :class="{ on: tab === 'orgs' }" @click="tab = 'orgs'">Organizaciones</button>
    </div>
    <AdminOrgs v-if="tab === 'orgs'" />
    <AdminUsers v-else />
  </div>
</template>

<script setup>
// Extraído de App.vue al pasar a rutas: /admin necesita ser un componente propio.
import { ref } from 'vue';
import AdminUsers from './AdminUsers.vue';
import AdminOrgs from './AdminOrgs.vue';
const tab = ref('users');
</script>

<style scoped>
.admin-wrap { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.admin-tabs { display: flex; gap: 6px; padding: 8px 10px; border-bottom: 1px solid #e2e8f0; }
.admin-tabs button { padding: 6px 14px; font-size: 13px; font-weight: 600; color: #64748b; background: none; border: 1px solid transparent; border-radius: 6px; cursor: pointer; }
.admin-tabs button.on { color: #0369a1; background: #e0f2fe; border-color: #bae6fd; }
</style>
