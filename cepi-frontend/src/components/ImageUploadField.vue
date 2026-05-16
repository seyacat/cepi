<template>
  <div class="img-upload">
    <input
      ref="fileInput"
      type="file"
      accept="image/*"
      :multiple="multiple"
      class="img-upload-input"
      :disabled="busy || uploading"
      @change="onPick"
    />
    <button
      type="button"
      class="img-upload-btn"
      :disabled="busy || uploading"
      @click="fileInput?.click()"
    >
      {{ uploading ? 'Subiendo…' : (multiple ? '+ Elegir imágenes' : '+ Elegir imagen') }}
    </button>

    <ul v-if="items.length" class="img-upload-list">
      <li v-for="it in items" :key="it.uid" class="img-upload-item" :class="it.status">
        <img v-if="it.preview" :src="it.preview" alt="" class="img-upload-thumb" />
        <span class="img-upload-name">{{ it.name }}</span>
        <span class="img-upload-status">
          <template v-if="it.status === 'uploading'">subiendo…</template>
          <template v-else-if="it.status === 'done'">listo</template>
          <template v-else-if="it.status === 'error'">error</template>
        </span>
        <button
          v-if="it.status !== 'uploading'"
          type="button"
          class="img-upload-rm"
          :disabled="busy"
          @click="remove(it.uid)"
          aria-label="Quitar"
        >✕</button>
      </li>
    </ul>
    <p v-else class="img-upload-hint">
      {{ multiple ? 'Subí una o más imágenes.' : 'Subí la imagen.' }}
    </p>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue';
import { uploadAttachment } from '../api.js';

const props = defineProps({
  // CSV of uploaded attachment ids — kept consistent with BodyMapField and
  // the BotForm guard that drops empty strings.
  modelValue: { type: String, default: '' },
  busy: { type: Boolean, default: false },
  multiple: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue']);

const fileInput = ref(null);
// Each item: { uid, name, preview, status: 'uploading'|'done'|'error', id }
const items = ref([]);
const uploading = ref(false);
let uidSeq = 0;

function syncModel() {
  const ids = items.value
    .filter(it => it.status === 'done' && it.id)
    .map(it => it.id);
  emit('update:modelValue', ids.join(','));
}

async function onPick(ev) {
  const files = Array.from(ev.target.files || []);
  ev.target.value = '';
  if (!files.length) return;
  // Single-image field: replace any prior selection.
  if (!props.multiple) items.value = [];

  uploading.value = true;
  for (const file of files) {
    const it = {
      uid: ++uidSeq,
      name: file.name,
      preview: URL.createObjectURL(file),
      status: 'uploading',
      id: null,
    };
    items.value.push(it);
    try {
      const att = await uploadAttachment(file);
      it.id = att?.id || null;
      it.status = it.id ? 'done' : 'error';
    } catch {
      it.status = 'error';
    }
    syncModel();
  }
  uploading.value = false;
}

function remove(uid) {
  const it = items.value.find(x => x.uid === uid);
  if (it?.preview) URL.revokeObjectURL(it.preview);
  items.value = items.value.filter(x => x.uid !== uid);
  syncModel();
}

// If the form is reset/prefilled externally, keep the list coherent.
watch(() => props.modelValue, (v) => {
  if (!v && items.value.some(it => it.status === 'done')) {
    items.value = items.value.filter(it => it.status !== 'done');
  }
});
</script>

<style scoped>
.img-upload { display: flex; flex-direction: column; gap: 6px; }
.img-upload-input { display: none; }
.img-upload-btn {
  align-self: flex-start;
  border: 1.5px solid var(--accent);
  background: #fff;
  color: var(--accent);
  border-radius: 18px;
  padding: 0.4rem 0.9rem;
  font-weight: 600;
  font-size: 0.82rem;
  cursor: pointer;
}
.img-upload-btn:hover:not(:disabled) { background: var(--accent); color: #fff; }
.img-upload-btn:disabled { opacity: .55; cursor: not-allowed; }
.img-upload-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.img-upload-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.8rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 4px 6px;
}
.img-upload-item.error { border-color: #dc2626; }
.img-upload-item.done { border-color: #16a34a; }
.img-upload-thumb {
  width: 36px; height: 36px;
  object-fit: cover; border-radius: 4px; flex-shrink: 0;
}
.img-upload-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.img-upload-status { color: var(--text-muted); font-size: 0.72rem; }
.img-upload-rm {
  border: none; background: transparent; cursor: pointer;
  color: var(--text-muted); font-size: 0.9rem; line-height: 1;
}
.img-upload-rm:hover:not(:disabled) { color: #dc2626; }
.img-upload-hint { margin: 0; font-size: 0.75rem; color: var(--text-muted); }
</style>
