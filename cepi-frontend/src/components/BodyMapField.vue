<template>
  <div class="body-map">
    <div class="silhouettes-wrap">
      <img src="/cuerpos.png" alt="Siluetas anterior y posterior" />
      <!-- Mapa de regiones — coords en % del bbox de la imagen, idénticas
           a public/ficha.html. Óvalos que circunscriben cada región. -->
      <div class="region-map">
        <button
          v-for="r in REGIONS"
          :key="r.key"
          type="button"
          class="region"
          :class="{ sel: selected.has(r.key) }"
          :style="r.style"
          :title="r.label"
          :aria-label="r.label"
          :aria-pressed="selected.has(r.key)"
          :disabled="busy"
          @click="toggle(r.key)"
        ></button>
      </div>
    </div>
    <p class="body-map-summary">
      <template v-if="selected.size">
        {{ selected.size }} región(es): {{ selectedLabels }}
      </template>
      <template v-else>Tocá las zonas con lesiones.</template>
    </p>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  modelValue: { type: String, default: '' },
  busy: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue']);

// 36 regiones (18 vista anterior + 18 posterior), igual que ficha.html.
const REGIONS = [
  // ── Vista anterior ──
  { key: 'cabeza_ant',        label: 'Cabeza (frontal)',           style: 'left:19.30%;top:2.00%;width:9.57%;height:12.31%' },
  { key: 'cuello_ant',        label: 'Cuello anterior',            style: 'left:22.00%;top:14.50%;width:4.50%;height:3.50%' },
  { key: 'hombro_der_ant',    label: 'Hombro derecho (ant.)',      style: 'left:13.50%;top:18.00%;width:6.50%;height:4.50%' },
  { key: 'hombro_izq_ant',    label: 'Hombro izquierdo (ant.)',    style: 'left:28.00%;top:18.00%;width:6.50%;height:4.50%' },
  { key: 'torax',             label: 'Tórax',                      style: 'left:16.00%;top:22.50%;width:16.00%;height:13.00%' },
  { key: 'abdomen',           label: 'Abdomen',                    style: 'left:17.00%;top:35.50%;width:14.00%;height:11.00%' },
  { key: 'pelvis_ant',        label: 'Pelvis / genitales',         style: 'left:19.00%;top:46.50%;width:10.00%;height:6.00%' },
  { key: 'brazo_der_ant',     label: 'Brazo derecho (ant.)',       style: 'left:9.00%;top:22.50%;width:6.50%;height:14.00%' },
  { key: 'brazo_izq_ant',     label: 'Brazo izquierdo (ant.)',     style: 'left:32.50%;top:22.50%;width:6.50%;height:14.00%' },
  { key: 'antebrazo_der_ant', label: 'Antebrazo derecho (ant.)',   style: 'left:5.50%;top:36.50%;width:7.00%;height:13.00%' },
  { key: 'antebrazo_izq_ant', label: 'Antebrazo izquierdo (ant.)', style: 'left:35.50%;top:36.50%;width:7.00%;height:13.00%' },
  { key: 'mano_der',          label: 'Mano derecha',               style: 'left:2.15%;top:49.50%;width:6.65%;height:8.50%' },
  { key: 'mano_izq',          label: 'Mano izquierda',             style: 'left:39.20%;top:49.50%;width:9.20%;height:8.50%' },
  { key: 'muslo_der_ant',     label: 'Muslo derecho (ant.)',       style: 'left:15.50%;top:52.50%;width:8.00%;height:21.00%' },
  { key: 'muslo_izq_ant',     label: 'Muslo izquierdo (ant.)',     style: 'left:24.50%;top:52.50%;width:8.00%;height:21.00%' },
  { key: 'pierna_der_ant',    label: 'Pierna derecha (ant.)',      style: 'left:14.00%;top:73.50%;width:7.20%;height:20.50%' },
  { key: 'pierna_izq_ant',    label: 'Pierna izquierda (ant.)',    style: 'left:26.80%;top:73.50%;width:7.20%;height:20.50%' },
  { key: 'pie_der',           label: 'Pie derecho',                style: 'left:11.62%;top:94.00%;width:7.14%;height:6.00%' },
  { key: 'pie_izq',           label: 'Pie izquierdo',              style: 'left:28.12%;top:94.00%;width:7.98%;height:6.00%' },
  // ── Vista posterior ──
  { key: 'cabeza_post',        label: 'Cabeza (posterior)',          style: 'left:69.85%;top:1.56%;width:9.57%;height:11.44%' },
  { key: 'cuello_post',        label: 'Cuello posterior',            style: 'left:72.55%;top:13.00%;width:4.50%;height:3.50%' },
  { key: 'hombro_izq_post',    label: 'Hombro izquierdo (post.)',    style: 'left:64.05%;top:17.50%;width:6.50%;height:4.50%' },
  { key: 'hombro_der_post',    label: 'Hombro derecho (post.)',      style: 'left:78.55%;top:17.50%;width:6.50%;height:4.50%' },
  { key: 'espalda_alta',       label: 'Espalda alta',                style: 'left:66.55%;top:22.00%;width:16.00%;height:13.00%' },
  { key: 'lumbar',             label: 'Espalda baja / lumbar',       style: 'left:67.55%;top:35.00%;width:14.00%;height:11.00%' },
  { key: 'gluteos',            label: 'Glúteos',                     style: 'left:69.55%;top:46.00%;width:10.00%;height:6.50%' },
  { key: 'brazo_izq_post',     label: 'Brazo izquierdo (post.)',     style: 'left:59.55%;top:22.00%;width:6.50%;height:14.00%' },
  { key: 'brazo_der_post',     label: 'Brazo derecho (post.)',       style: 'left:83.05%;top:22.00%;width:6.50%;height:14.00%' },
  { key: 'antebrazo_izq_post', label: 'Antebrazo izquierdo (post.)', style: 'left:56.05%;top:36.00%;width:7.00%;height:13.00%' },
  { key: 'antebrazo_der_post', label: 'Antebrazo derecho (post.)',   style: 'left:86.05%;top:36.00%;width:7.00%;height:13.00%' },
  { key: 'mano_izq_dorso',     label: 'Mano izquierda (dorso)',      style: 'left:52.70%;top:49.00%;width:6.65%;height:8.50%' },
  { key: 'mano_der_dorso',     label: 'Mano derecha (dorso)',        style: 'left:89.32%;top:49.00%;width:8.77%;height:8.50%' },
  { key: 'muslo_izq_post',     label: 'Muslo izquierdo (post.)',     style: 'left:65.19%;top:52.50%;width:7.56%;height:21.00%' },
  { key: 'muslo_der_post',     label: 'Muslo derecho (post.)',       style: 'left:75.90%;top:52.50%;width:8.85%;height:21.00%' },
  { key: 'pierna_izq_post',    label: 'Pierna izquierda (post.)',    style: 'left:64.55%;top:73.50%;width:7.20%;height:20.50%' },
  { key: 'pierna_der_post',    label: 'Pierna derecha (post.)',      style: 'left:77.35%;top:73.50%;width:7.20%;height:20.50%' },
  { key: 'pie_izq_planta',     label: 'Pie izquierdo (planta)',      style: 'left:62.60%;top:94.00%;width:6.30%;height:6.00%' },
  { key: 'pie_der_planta',     label: 'Pie derecho (planta)',        style: 'left:79.10%;top:94.00%;width:7.14%;height:6.00%' },
];

const LABELS = Object.fromEntries(REGIONS.map(r => [r.key, r.label]));

// modelValue is a CSV of region keys — parsed into a Set for O(1) lookup.
const selected = computed(() => new Set(
  (props.modelValue || '').split(',').map(s => s.trim()).filter(Boolean),
));

const selectedLabels = computed(() =>
  REGIONS.filter(r => selected.value.has(r.key)).map(r => r.label).join(', '),
);

function toggle(key) {
  if (props.busy) return;
  const next = new Set(selected.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  // Keep CSV order stable by following REGIONS order.
  emit('update:modelValue',
    REGIONS.filter(r => next.has(r.key)).map(r => r.key).join(','));
}
</script>

<style scoped>
.body-map { display: flex; flex-direction: column; gap: 4px; }
.silhouettes-wrap { position: relative; width: 100%; line-height: 0; }
.silhouettes-wrap img { width: 100%; height: auto; display: block; }
.region-map { position: absolute; inset: 0; line-height: normal; }
.region {
  position: absolute;
  border: 1px solid transparent;
  background: transparent;
  padding: 0;
  cursor: pointer;
  box-sizing: border-box;
  border-radius: 50%;
  /* El óvalo circunscribe el rectángulo de la región (lo cubre por
     completo) en vez de quedar inscrito dentro de él — igual que la ficha. */
  transform: scale(1.414);
}
.region:hover:not(:disabled) { border-color: #d33; background: rgba(221, 51, 51, .10); }
.region.sel { border-color: #c8102e; background: rgba(200, 16, 46, .34); }
.region.sel:hover:not(:disabled) { background: rgba(200, 16, 46, .46); }
.region:disabled { cursor: default; }
.body-map-summary {
  margin: 2px 0 0;
  font-size: 0.75rem;
  color: var(--text-muted);
  line-height: 1.3;
}
</style>
