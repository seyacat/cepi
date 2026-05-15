<template>
  <form class="bot-form" @submit.prevent="onSubmit">
    <h4 class="bot-form-title">{{ form.title }}</h4>
    <div v-for="f in form.fields" :key="f.key" class="bot-form-field">
      <label :for="`bf-${form.id}-${f.key}`">
        {{ f.label }}<span v-if="f.required" class="bf-req">*</span>
      </label>
      <EntitySearchField
        v-if="f.type === 'entity_search'"
        :field="f"
        :busy="busy"
        @select="$emit('send', $event)"
      />
      <input
        v-else
        :id="`bf-${form.id}-${f.key}`"
        v-model="values[f.key]"
        type="text"
        :placeholder="f.placeholder || ''"
        :disabled="busy"
        autocomplete="off"
      />
    </div>
    <div class="bot-form-actions">
      <button
        v-if="form.submit_send"
        type="submit"
        class="bf-submit"
        :disabled="busy || !canSubmit"
      >
        {{ form.submit_label || 'Enviar' }}
      </button>
      <button
        v-for="(a, i) in form.actions || []"
        :key="i"
        type="button"
        class="bf-action"
        :disabled="busy"
        @click="$emit('send', a.send)"
      >{{ a.label }}</button>
    </div>
  </form>
</template>

<script setup>
import { reactive, computed } from 'vue';
import EntitySearchField from './EntitySearchField.vue';

const props = defineProps({
  form: { type: Object, required: true },
  busy: { type: Boolean, default: false },
});
const emit = defineEmits(['send']);

const values = reactive(
  Object.fromEntries((props.form.fields || []).map(f => [f.key, ''])),
);

// Submit is enabled when every required field is filled. If the form has
// no required fields (e.g. the search form), any single value is enough.
const canSubmit = computed(() => {
  const fields = props.form.fields || [];
  const required = fields.filter(f => f.required);
  if (required.length) {
    return required.every(f => (values[f.key] || '').trim());
  }
  return fields.some(f => (values[f.key] || '').trim());
});

function onSubmit() {
  if (!canSubmit.value || props.busy) return;
  // Interpolate {key} placeholders in submit_send with field values.
  const msg = (props.form.submit_send || '').replace(
    /\{(\w+)\}/g,
    (_, k) => (values[k] || '').trim(),
  );
  if (msg.trim()) emit('send', msg.trim());
}
</script>

<style scoped>
.bot-form {
  background: var(--bot-bg, #fff);
  border: 1.5px solid var(--accent);
  border-radius: 10px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.bot-form-title {
  margin: 0;
  font-size: 0.9rem;
  font-weight: 700;
  color: var(--accent);
}
.bot-form-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.bot-form-field label {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text-muted);
}
.bot-form-field input {
  border: 1.5px solid var(--border);
  border-radius: 8px;
  padding: 0.55rem 0.85rem;
  font-size: 0.92rem;
  outline: none;
  transition: border-color 0.15s;
}
.bot-form-field input:focus { border-color: var(--accent); }
.bf-req { color: #dc2626; margin-left: 2px; }
.bot-form-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.bf-submit {
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: 18px;
  padding: 0.45rem 1.1rem;
  font-weight: 700;
  font-size: 0.85rem;
  cursor: pointer;
}
.bf-submit:hover:not(:disabled) { background: var(--accent-hover); }
.bf-submit:disabled { opacity: .55; cursor: not-allowed; }
.bf-action {
  border: 1.5px solid var(--accent);
  background: #fff;
  color: var(--accent);
  border-radius: 18px;
  padding: 0.45rem 0.95rem;
  font-weight: 600;
  font-size: 0.85rem;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.bf-action:hover:not(:disabled) { background: var(--accent); color: #fff; }
.bf-action:disabled { opacity: .55; cursor: not-allowed; }
</style>
