<template>
  <form class="bot-form" @submit.prevent="onSubmit">
    <h4 class="bot-form-title">{{ form.title }}</h4>

    <template v-for="(f, i) in form.fields" :key="f.key || `_${i}`">
      <!-- Decorative sub-heading inside a long form. -->
      <p v-if="f.type === 'heading'" class="bf-heading">{{ f.label }}</p>

      <!-- Single checkbox (boolean field). -->
      <label v-else-if="f.type === 'checkbox'" class="bf-check">
        <input type="checkbox" v-model="values[f.key]" :disabled="busy" />
        <span>{{ f.label }}</span>
      </label>

      <!-- Radio group (single choice). -->
      <div v-else-if="f.type === 'radio'" class="bot-form-field">
        <label>{{ f.label }}<span v-if="f.required" class="bf-req">*</span></label>
        <div class="bf-radio-row">
          <label v-for="opt in normOptions(f)" :key="opt.value" class="bf-radio">
            <input
              type="radio"
              :name="`bf-${form.id}-${f.key}`"
              :value="opt.value"
              v-model="values[f.key]"
              :disabled="busy"
              @change="onRadioPick"
            />
            <span>{{ opt.label }}</span>
          </label>
        </div>
      </div>

      <!-- Textarea. -->
      <div v-else-if="f.type === 'textarea'" class="bot-form-field">
        <label :for="`bf-${form.id}-${f.key}`">
          {{ f.label }}<span v-if="f.required" class="bf-req">*</span>
        </label>
        <textarea
          :id="`bf-${form.id}-${f.key}`"
          v-model="values[f.key]"
          rows="2"
          :placeholder="f.placeholder || ''"
          :disabled="busy"
        />
      </div>

      <!-- Entity autocomplete. -->
      <div v-else-if="f.type === 'entity_search'" class="bot-form-field">
        <label>{{ f.label }}<span v-if="f.required" class="bf-req">*</span></label>
        <EntitySearchField :field="f" :busy="busy" @select="$emit('send', $event)" />
      </div>

      <!-- Plain text (default). -->
      <div v-else class="bot-form-field">
        <label :for="`bf-${form.id}-${f.key}`">
          {{ f.label }}<span v-if="f.required" class="bf-req">*</span>
        </label>
        <input
          :id="`bf-${form.id}-${f.key}`"
          v-model="values[f.key]"
          type="text"
          :placeholder="f.placeholder || ''"
          :disabled="busy"
          autocomplete="off"
        />
      </div>
    </template>

    <div class="bot-form-actions">
      <button
        v-if="(form.submit_send || form.submit_mode === 'structured') && !autoSubmit"
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
const emit = defineEmits(['send', 'submit']);

const DATA_FIELDS = (props.form.fields || []).filter(
  f => f.key && f.type !== 'heading' && f.type !== 'entity_search',
);

// Initialise from form.values (pre-filled on revisit), else field default.
const initial = props.form.values || {};
const values = reactive(
  Object.fromEntries(DATA_FIELDS.map(f => {
    const def = f.type === 'checkbox' ? false : '';
    const v = initial[f.key];
    return [f.key, v !== undefined && v !== null ? v : def];
  })),
);

function normOptions(f) {
  return (f.options || []).map(o =>
    typeof o === 'string' ? { label: o, value: o } : o,
  );
}

const isStructured = computed(() => props.form.submit_mode === 'structured');

// A "closed" form — every field is a single-choice radio. Picking an option
// submits immediately (no Guardar button).
const autoSubmit = computed(() =>
  isStructured.value && DATA_FIELDS.length > 0 &&
  DATA_FIELDS.every(f => f.type === 'radio'),
);

function onRadioPick() {
  if (autoSubmit.value && !props.busy) onSubmit();
}

// Structured forms (ficha sections) can always be submitted — every field is
// optional. Message-template forms need their required fields filled.
const canSubmit = computed(() => {
  if (isStructured.value) return true;
  const required = DATA_FIELDS.filter(f => f.required);
  if (required.length) {
    return required.every(f => String(values[f.key] || '').trim());
  }
  return DATA_FIELDS.some(f => String(values[f.key] || '').trim());
});

function onSubmit() {
  if (!canSubmit.value || props.busy) return;
  if (isStructured.value) {
    // Send the whole field map; drop empty strings, keep booleans/numbers.
    const data = {};
    for (const f of DATA_FIELDS) {
      const v = values[f.key];
      if (v === '' || v === null || v === undefined) continue;
      data[f.key] = v;
    }
    emit('submit', { form_id: props.form.id, data });
    return;
  }
  // Interpolate {key} placeholders in submit_send with field values.
  const msg = (props.form.submit_send || '').replace(
    /\{(\w+)\}/g,
    (_, k) => String(values[k] || '').trim(),
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
.bf-heading {
  margin: 6px 0 0;
  font-size: 0.82rem;
  font-weight: 700;
  color: var(--text);
  border-bottom: 1px solid var(--border);
  padding-bottom: 2px;
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
.bot-form-field input,
.bot-form-field textarea {
  border: 1.5px solid var(--border);
  border-radius: 8px;
  padding: 0.55rem 0.85rem;
  font-size: 0.92rem;
  outline: none;
  font-family: inherit;
  color: #111;
  background: var(--bg, #f1f5f9);
  transition: border-color 0.15s;
}
.bot-form-field input::placeholder,
.bot-form-field textarea::placeholder { color: #94a3b8; }
.bot-form-field input:focus,
.bot-form-field textarea:focus { border-color: var(--accent); }
.bf-req { color: #dc2626; margin-left: 2px; }

.bf-check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--text);
  cursor: pointer;
}
.bf-check input { width: 15px; height: 15px; accent-color: var(--accent); }

.bf-radio-row { display: flex; flex-wrap: wrap; gap: 4px 14px; }
.bf-radio {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.85rem;
  color: var(--text);
  cursor: pointer;
}
.bf-radio input { accent-color: var(--accent); }

.bot-form-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
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
