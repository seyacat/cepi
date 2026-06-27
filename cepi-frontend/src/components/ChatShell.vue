<template>
  <div class="shell" :class="`shell--${view}`">
    <ChatList
      class="shell-list"
      :active-id="selectedId"
      :general-active="generalActive"
      @select="onSelect"
      @general="onGeneral"
    />
    <div class="shell-detail">
      <IntakeChat ref="chatRef" :user="user" class="shell-chat" @closed="onChatClosed" @back="view = 'list'" />
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import ChatList from './ChatList.vue';
import IntakeChat from './IntakeChat.vue';
import { bindBackState } from '../useBackStack.js';

defineProps({ user: Object });

const view = ref('list');          // mobile only: 'list' | 'chat' (desktop shows both)
const selectedId = ref(null);
const selectedName = ref('');
const generalActive = ref(false);
const chatRef = ref(null);

const mq = window.matchMedia('(max-width: 768px)');
const isMobile = ref(mq.matches);
const onMq = (e) => { isMobile.value = e.matches; if (!e.matches) view.value = 'list'; };

function fullName(p) {
  return [p.data?.nombre, p.data?.apellidos].filter(Boolean).join(' ') || p.title || 'Paciente';
}

function onSelect(p) {
  selectedId.value = p.id;
  selectedName.value = fullName(p);
  generalActive.value = false;
  chatRef.value?.openPatient(p.id, fullName(p));
  if (isMobile.value) view.value = 'chat';
}

function onGeneral() {
  selectedId.value = null;
  selectedName.value = '';
  generalActive.value = true;
  chatRef.value?.newGeneral();
  if (isMobile.value) view.value = 'chat';
}

// IntakeChat avisa que se cerró (p.ej. tras derivar) → deseleccionar el paciente
// y, en móvil, volver a la lista para elegir otro.
function onChatClosed() {
  selectedId.value = null;
  selectedName.value = '';
  generalActive.value = false;
  if (isMobile.value) view.value = 'list';
}

// Device/browser Back: while in the mobile chat view, go back to the list
// instead of leaving the app.
bindBackState(() => isMobile.value && view.value === 'chat', () => { view.value = 'list'; });

onMounted(() => { mq.addEventListener('change', onMq); });
onUnmounted(() => { mq.removeEventListener('change', onMq); });
</script>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: 340px 1fr;
  gap: 12px;
  height: 100%;
  min-height: 0;
}
.shell-list { min-height: 0; }
.shell-detail { min-height: 0; min-width: 0; display: flex; flex-direction: column; }
.shell-chat { flex: 1; min-height: 0; }
.mchat-bar { display: none; }

@media (max-width: 768px) {
  .shell { grid-template-columns: 1fr; gap: 0; }
  .shell--list .shell-detail { display: none; }
  .shell--chat .shell-list { display: none; }
  .mchat-bar {
    display: flex; align-items: center; gap: 10px;
    flex-shrink: 0; padding: 6px 10px;
    background: var(--accent-band, #f1f5f9); border-bottom: 1px solid var(--border);
  }
  .mback {
    width: 34px; height: 34px; border-radius: 50%;
    border: 1.5px solid var(--border); background: #fff; color: var(--accent);
    font-size: 1.1rem; font-weight: 700; cursor: pointer; flex-shrink: 0;
  }
  .mtitle { font-weight: 700; font-size: 0.95rem; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
}
</style>
