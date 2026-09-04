<template>
  <div class="ficha">
    <div v-if="cargando" class="ficha-estado">Cargando ficha…</div>
    <div v-else-if="error" class="ficha-estado ficha-error">{{ error }}</div>

    <template v-else-if="grupos.length">
      <!-- Cabecera: cuánto de la ficha tiene dato. Es la primera pregunta del
           portal ("¿qué falta?"), así que va arriba y no escondida. -->
      <!-- Que existan fichas anteriores tiene que verse ANTES de leer la actual:
           un dato aislado dice poco si no se sabe que hay con qué compararlo. -->
      <nav v-if="episodeId && visitas.length > 1" class="ficha-nav">
        <button :disabled="!haySiguiente" @click="paso(-1)" title="Visita más reciente">‹</button>
        <span class="ficha-nav-pos">
          Visita {{ visitas.length - idx }} de {{ visitas.length }}
          <em v-if="anterior">· comparando con la del {{ String(anterior.fecha || '').slice(0, 10) }}</em>
          <em v-else>· es la primera</em>
        </span>
        <button :disabled="!hayAnterior" @click="paso(1)" title="Visita anterior">›</button>
      </nav>

      <header class="ficha-head">
        <div class="ficha-progreso">
          <div class="ficha-barra"><div class="ficha-barra-fill" :style="{ width: pct + '%' }" /></div>
          <span class="ficha-pct">{{ completos }} de {{ total }} grupos con dato</span>
        </div>
        <span v-if="avisoGuardado" class="ficha-aviso" :class="{ 'ficha-aviso--error': avisoError }">{{ avisoGuardado }}</span>
        <label class="ficha-toggle">
          <input type="checkbox" v-model="soloFaltantes" />
          <span>Solo lo que falta</span>
        </label>
      </header>

      <section v-for="cat in categorias" :key="cat.nombre" class="ficha-cat">
        <h3 class="ficha-cat-titulo">
          {{ cat.nombre }}
          <span class="ficha-cat-cuenta">{{ cat.completos }}/{{ cat.grupos.length }}</span>
        </h3>

        <article
          v-for="g in cat.visibles" :key="g.id"
          class="ficha-grupo" :class="{ 'ficha-grupo--vacio': !g.done }"
        >
          <h4 class="ficha-grupo-titulo">
            <span class="ficha-marca" :class="g.done ? 'ok' : 'falta'">{{ g.done ? '●' : '○' }}</span>
            {{ g.label }}
            <button
              v-if="editable(g)" class="ficha-editar" type="button"
              @click="editando === g.id ? cancelar() : editar(g)"
            >{{ editando === g.id ? 'Cancelar' : (g.done ? 'Editar' : 'Completar') }}</button>
          </h4>

          <!-- En edición se reusa el MISMO formulario que el chat: mismos campos,
               mismos tipos (CIE-10, mapa corporal), misma validación. -->
          <BotForm
            v-if="editando === g.id && g.form"
            :form="formEditable(g)" :busy="guardando" @submit="guardar($event, g)"
          />
          <template v-else>
            <dl v-if="valores(g).length" class="ficha-campos">
              <template v-for="v in valores(g)" :key="v.key">
                <dt :class="{ 'dt-cambiado': v.cambio }"
                    :title="v.cambio ? 'Valor anterior: ' + textoAnterior(v.cambio.antes) : null">{{ v.label }}</dt>
                <dd>{{ v.texto }}</dd>
              </template>
            </dl>
            <p v-else class="ficha-vacio">Sin dato</p>
          </template>
        </article>

        <p v-if="!cat.visibles.length" class="ficha-cat-vacia">Todo este bloque tiene dato.</p>
      </section>
    </template>

    <div v-else class="ficha-estado">Esta ficha no tiene grupos.</div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { fichaCompleta, guardarGrupoFicha } from '../api.js';
import BotForm from './BotForm.vue';

const props = defineProps({
  episodeId: { type: String, default: null },
  patientId: { type: String, default: null },
  /** Las visitas del paciente, más nuevas primero. Sirven para navegar y comparar. */
  visitas: { type: Array, default: () => [] },
});
const emit = defineEmits(['navegar']);

const grupos = ref([]);
const completos = ref(0);
const total = ref(0);
const cargando = ref(false);
const error = ref('');
const soloFaltantes = ref(false);
const editando = ref(null);
const guardando = ref(false);
const avisoGuardado = ref('');
const avisoError = ref(false);

// Los grupos de imagen (§4.7, §8) no escriben campos: crean registros clinical_image /
// consent al subir la foto. Editarlos desde acá no tendría dónde guardar.
const GRUPOS_IMAGEN = new Set(['g_4_7', 'g_8']);
const editable = (g) => !GRUPOS_IMAGEN.has(g.id) && Boolean(g.form);

function editar(g) { editando.value = g.id; avisoGuardado.value = ''; }

/**
 * El formulario viene del flujo del chat y trae acciones suyas ("Omitir") que emiten
 * un evento de conversación. Acá no hay conversación que las escuche: dejarlas sería
 * un botón que no hace nada sin decirlo.
 */
function formEditable(g) {
  const { actions, ...resto } = g.form || {};
  return resto;
}
function cancelar() { editando.value = null; }

async function guardar(payload, g) {
  guardando.value = true; avisoGuardado.value = ''; avisoError.value = false;
  try {
    const r = await guardarGrupoFicha({
      groupId: g.id, data: payload.data,
      episodeId: props.episodeId, patientId: props.patientId,
    });
    editando.value = null;
    // Se recarga la ficha entera y no solo el grupo: guardar puede mover campos
    // derivados de otros grupos (gravedad_total, BLINK) y el % de llenado.
    await cargar();
    avisoGuardado.value = r.completitud != null ? `Guardado · ${r.completitud}% de la ficha` : 'Guardado';
  } catch (e) {
    avisoError.value = true;
    avisoGuardado.value = e?.message || 'No se pudo guardar';
  } finally {
    guardando.value = false;
  }
}

const pct = computed(() => (total.value ? Math.round((completos.value / total.value) * 100) : 0));

// ── Navegación entre las visitas del paciente ────────────────────────────────
// `visitas` viene ordenada de más nueva a más vieja, así que la ANTERIOR es la
// siguiente del array. Es la misma convención que el visor de telemedicina.
const idx = computed(() => props.visitas.findIndex(v => v.id === props.episodeId));
const hayAnterior = computed(() => idx.value >= 0 && idx.value < props.visitas.length - 1);
const haySiguiente = computed(() => idx.value > 0);
const anterior = computed(() => (idx.value >= 0 ? props.visitas[idx.value + 1] : null) || null);
function paso(dir) {
  const n = idx.value + dir;
  if (n >= 0 && n < props.visitas.length) emit('navegar', props.visitas[n].id);
}

/**
 * Campos que NO se comparan entre visitas. Misma lista que el visor de telemedicina:
 * son datos de la propia cita (fecha, estado, médico) o derivados, y marcarlos en rojo
 * diría "esto cambió" de algo que cambia SIEMPRE, tapando lo clínico que sí importa.
 */
const SIN_COMPARAR = new Set(['id', 'fecha', 'medico_id', 'patient_id', 'estado', 'tipo',
  'created_at', 'updated_at', 'ficha_num', 'examinador_nombre', 'gravedad_total', 'location',
  'drpro_cita_id', 'tipo_cita', 'ficha_completitud', 'ficha_faltantes', 'ficha_calculada_at',
  'ficha_grupos_con_dato', 'diagnostico_fuente']);

/** Vacío, falso y ausente son lo mismo al comparar. Igual que en telemedicina. */
const norm = (v) => (v === null || v === undefined || v === false || v === '') ? '' : String(v);

/**
 * ¿Este campo difiere de la visita anterior? Devuelve el valor de entonces.
 *
 * Solo se comparan los grupos DEL EPISODIO. Los de §1-§2 viven en el paciente y los
 * comparten todas sus visitas: contrastarlos contra la fila del episodio anterior
 * —que no tiene esas columnas— daba "cambió" en Dirección, Teléfono, Sexo y demás,
 * en cada ficha. Un rojo que sale siempre no señala nada.
 */
function cambio(key, valorActual, target) {
  if (target !== 'episode') return null;
  if (!anterior.value || SIN_COMPARAR.has(key) || key.includes(':')) return null;
  const antes = anterior.value[key];
  if (norm(valorActual) === norm(antes)) return null;
  return { antes };
}

/** El texto del tooltip, con la misma redacción del visor. */
function textoAnterior(v) {
  if (v === null || v === undefined || v === '' || v === false) return '(vacío)';
  if (v === true) return 'Sí';
  return String(v);
}

/**
 * Los grupos vienen planos y en orden; la categoría (§) los agrupa igual que el riel
 * de telemedicina, para que la ficha se lea con la misma estructura en los dos lados.
 */
const categorias = computed(() => {
  const out = [];
  for (const g of grupos.value) {
    const nombre = g.category || 'Otros';
    let cat = out.find(c => c.nombre === nombre);
    if (!cat) { cat = { nombre, grupos: [], completos: 0 }; out.push(cat); }
    cat.grupos.push(g);
    if (g.done) cat.completos++;
  }
  for (const c of out) c.visibles = soloFaltantes.value ? c.grupos.filter(g => !g.done) : c.grupos;
  return soloFaltantes.value ? out.filter(c => c.visibles.length) : out;
});

/** Pares etiqueta/valor de un grupo, legibles: el form trae el schema y los valores. */
function valores(g) {
  const vals = g.form?.values || {};
  return (g.form?.fields || [])
    .filter(f => f.key && vals[f.key] !== undefined && vals[f.key] !== null && vals[f.key] !== '')
    .map(f => ({ key: f.key, label: f.label || f.key, texto: aTexto(vals[f.key], f), cambio: cambio(f.key, vals[f.key], g.target) }));
}

/** Los valores guardados son strings, booleanos, arrays de región o JSON del body map. */
function aTexto(v, f) {
  if (typeof v === 'boolean') return v ? 'Sí' : 'No';
  if (Array.isArray(v)) return v.map(x => (typeof x === 'object' ? (x?.label ?? x?.value ?? JSON.stringify(x)) : x)).join(', ');
  if (v && typeof v === 'object') return JSON.stringify(v);
  const opt = (f?.options || []).find(o => (typeof o === 'object' ? o.value : o) === v);
  if (opt) return typeof opt === 'object' ? (opt.label ?? opt.value) : opt;
  return String(v);
}

async function cargar() {
  if (!props.episodeId && !props.patientId) { grupos.value = []; return; }
  cargando.value = true; error.value = '';
  try {
    const r = await fichaCompleta({ episodeId: props.episodeId, patientId: props.patientId });
    grupos.value = r.grupos || [];
    completos.value = r.completos ?? 0;
    total.value = r.total ?? grupos.value.length;
  } catch (e) {
    error.value = e?.message || 'No se pudo cargar la ficha';
    grupos.value = [];
  } finally {
    cargando.value = false;
  }
}

watch(() => [props.episodeId, props.patientId], cargar, { immediate: true });
defineExpose({ recargar: cargar });
</script>

<style scoped>
.ficha { padding: 12px 14px 40px; overflow-y: auto; }
.ficha-estado { padding: 24px; color: #64748b; font-size: 14px; }
.ficha-error { color: #b91c1c; }

.ficha-head {
  position: sticky; top: 0; z-index: 2;
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 10px 2px 12px; margin-bottom: 8px;
  background: var(--cepi-bg, #fff); border-bottom: 1px solid #e2e8f0;
}
.ficha-progreso { flex: 1; min-width: 0; }
.ficha-barra { height: 6px; border-radius: 3px; background: #e2e8f0; overflow: hidden; }
.ficha-barra-fill { height: 100%; background: #0ea5e9; transition: width .2s; }
.ficha-pct { display: block; margin-top: 5px; font-size: 12px; color: #64748b; }
.ficha-toggle { display: flex; align-items: center; gap: 6px; font-size: 13px; color: #334155; white-space: nowrap; cursor: pointer; }

.ficha-cat { margin-bottom: 22px; }
.ficha-cat-titulo {
  display: flex; align-items: baseline; gap: 8px;
  margin: 0 0 8px; font-size: 13px; font-weight: 700;
  text-transform: uppercase; letter-spacing: .04em; color: #475569;
}
.ficha-cat-cuenta { font-weight: 500; letter-spacing: 0; text-transform: none; color: #94a3b8; }
.ficha-cat-vacia { margin: 0; font-size: 13px; color: #94a3b8; }

.ficha-grupo { padding: 10px 12px; margin-bottom: 8px; border: 1px solid #e2e8f0; border-radius: 8px; }
/* Un grupo vacío no es un error: puede ser data que el origen nunca tuvo (fichas
   espejadas de DrPro). Se marca sin alarma, en gris, no en rojo. */
.ficha-grupo--vacio { background: #f8fafc; border-style: dashed; }
.ficha-grupo-titulo { display: flex; align-items: center; gap: 7px; margin: 0 0 6px; font-size: 14px; font-weight: 600; color: #0f172a; }
.ficha-marca { font-size: 11px; }
.ficha-marca.ok { color: #0ea5e9; }
.ficha-marca.falta { color: #cbd5e1; }

.ficha-editar { margin-left: auto; padding: 2px 9px; font-size: 12px; color: #0369a1; background: none; border: 1px solid #bae6fd; border-radius: 5px; cursor: pointer; }
.ficha-editar:hover { background: #e0f2fe; }
.ficha-aviso { font-size: 12px; color: #15803d; }
.ficha-aviso--error { color: #b91c1c; }

.ficha-campos { display: grid; grid-template-columns: minmax(120px, 30%) 1fr; gap: 4px 14px; margin: 0; }
.ficha-campos dt { font-size: 12px; color: #64748b; }
/* Mismo rojo y misma negrita que el visor de telemedicina, para que la señal
   signifique lo mismo en los dos sitios. */
.ficha-campos dt.dt-cambiado { color: #c8102e; font-weight: 800; cursor: help; }

.ficha-nav { display: flex; align-items: center; gap: 10px; padding: 8px 2px; border-bottom: 1px solid #f1f5f9; }
.ficha-nav button { padding: 2px 11px; font-size: 17px; line-height: 1.2; color: #0369a1; background: none; border: 1px solid #bae6fd; border-radius: 6px; cursor: pointer; }
.ficha-nav button:disabled { color: #cbd5e1; border-color: #e2e8f0; cursor: default; }
.ficha-nav-pos { font-size: 12px; color: #475569; }
.ficha-nav-pos em { color: #94a3b8; font-style: normal; }
.ficha-campos dd { margin: 0; font-size: 14px; color: #0f172a; white-space: pre-wrap; overflow-wrap: anywhere; }
.ficha-vacio { margin: 0; font-size: 13px; color: #94a3b8; font-style: italic; }

@media (max-width: 560px) {
  .ficha-campos { grid-template-columns: 1fr; gap: 1px 0; }
  .ficha-campos dd { margin-bottom: 7px; }
}
</style>
