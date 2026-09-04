<template>
  <div class="cshell" :class="`cshell--${panel}`">
    <div class="cshell-lado">
      <!-- Dos pestañas porque la ficha tiene dos niveles: §1-§2 son del PACIENTE y
           los comparten todas sus visitas; §3 en adelante son de LA VISITA. Buscar
           por caso y buscar por persona son preguntas distintas. -->
      <nav class="cshell-tabs" role="tablist">
        <button role="tab" :aria-selected="tab === 'casos'"
                :class="{ on: tab === 'casos' }" @click="tab = 'casos'">Casos</button>
        <button role="tab" :aria-selected="tab === 'pacientes'"
                :class="{ on: tab === 'pacientes' }" @click="tab = 'pacientes'">Pacientes</button>
      </nav>

      <CasoLista v-show="tab === 'casos'" class="cshell-lista"
                 :active-id="sel.episodeId" @select="(c) => irACaso(c.episodeId)" />
      <PacienteLista v-show="tab === 'pacientes'" class="cshell-lista"
                     :active-id="sel.patientId" @select="(p) => irAPaciente(p.patientId)" />
    </div>

    <div class="cshell-detalle">
      <header v-if="sel.episodeId || sel.patientId" class="cshell-head">
        <button class="cshell-volver" @click="router.push('/casos')" aria-label="Volver a la lista">‹</button>
        <h2 class="cshell-titulo">{{ sel.episodeId ? 'Ficha del caso' : 'Ficha del paciente' }}</h2>
      </header>

      <!-- Las visitas siguen visibles al entrar en una: comparar dos consultas del
           mismo paciente es el movimiento natural, y esconderlas obligaba a volver
           a la lista de pacientes para cambiar de visita. -->
      <section v-if="sel.patientId && visitas.length" class="cshell-visitas">
        <h3>Visitas</h3>
        <p v-if="cargandoVisitas" class="cshell-vacio">Cargando…</p>
        <p v-else-if="!visitas.length" class="cshell-vacio">Sin visitas registradas.</p>
        <ul v-else>
          <li v-for="v in visitas" :key="v.id" :class="{ on: v.id === sel.episodeId }"
              @click="irACaso(v.id)">
            <span class="cshell-v-fecha">{{ String(v.fecha || '').slice(0, 10) || '—' }}</span>
            <span class="cshell-v-estado">{{ v.estado }}</span>
            <span v-if="v.codigo_cie10" class="cshell-v-cie">{{ v.codigo_cie10 }}</span>
            <span class="cshell-v-dx">{{ v.diagnostico || v.motivo_consulta || 'Sin diagnóstico' }}</span>
          </li>
        </ul>
      </section>

      <FichaCompleta
        v-if="sel.episodeId || sel.patientId"
        :episode-id="sel.episodeId" :patient-id="sel.patientId" :visitas="visitas"
        class="cshell-ficha"
        @navegar="irACaso"
      />
      <p v-else class="cshell-vacio">Elige {{ tab === 'casos' ? 'un caso' : 'un paciente' }} de la lista.</p>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import CasoLista from './CasoLista.vue';
import PacienteLista from './PacienteLista.vue';
import FichaCompleta from './FichaCompleta.vue';
import { listarCasosDePaciente, obtenerEntidad } from '../api.js';

defineProps({
  user: Object,
  // Los pasa el router desde /casos/caso/:episodeId y /casos/paciente/:patientId.
  episodeId: { type: String, default: null },
  patientId: { type: String, default: null },
});

const route = useRoute();
const router = useRouter();
const tab = ref('casos');
const sel = ref({ episodeId: null, patientId: null });
const visitas = ref([]);
const cargandoVisitas = ref(false);
// En móvil solo cabe un panel; en escritorio se ven los dos y `panel` no se usa.
const panel = ref('lista');
// Evita recargar las visitas al navegar entre hermanas del mismo paciente.
let ultimoPacienteCargado = null;

// ── La URL es el estado ──────────────────────────────────────────────────────
// Abrir un caso NAVEGA; la ruta es la que decide qué se ve. Así el enlace se puede
// compartir, la recarga no pierde el sitio y el atrás del navegador funciona solo.
function irACaso(episodeId) { router.push(`/casos/caso/${episodeId}`); }
function irAPaciente(patientId) { router.push(`/casos/paciente/${patientId}`); }

/** Pinta lo que diga la ruta. Es el único sitio donde se toca `sel`. */
async function aplicarRuta() {
  const ep = route.params.episodeId || null;
  const pa = route.params.patientId || null;

  if (pa && !ep) {
    tab.value = 'pacientes';
    sel.value = { episodeId: null, patientId: pa };
    panel.value = 'detalle';
    if (pa !== ultimoPacienteCargado) await cargarVisitas(pa);
    return;
  }
  if (ep) {
    // Un caso necesita saber de quién es: sin el paciente no hay visitas hermanas
    // que listar ni contra qué comparar.
    let dueño = sel.value.patientId;
    if (!dueño || sel.value.episodeId !== ep) {
      try { dueño = (await obtenerEntidad(ep))?.patient_id || null; } catch { dueño = null; }
    }
    sel.value = { episodeId: ep, patientId: dueño };
    panel.value = 'detalle';
    if (dueño && dueño !== ultimoPacienteCargado) await cargarVisitas(dueño);
    return;
  }
  sel.value = { episodeId: null, patientId: null };
  visitas.value = [];
  panel.value = 'lista';
}

async function cargarVisitas(patientId) {
  ultimoPacienteCargado = patientId;
  visitas.value = []; cargandoVisitas.value = true;
  try { visitas.value = (await listarCasosDePaciente(patientId)).data || []; }
  catch { visitas.value = []; }
  finally { cargandoVisitas.value = false; }
}


watch(() => route.fullPath, aplicarRuta);
onMounted(aplicarRuta);
</script>

<style scoped>
.cshell { display: grid; grid-template-columns: minmax(280px, 360px) 1fr; height: 100%; min-height: 0; }
.cshell-lado { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid #e2e8f0; }
.cshell-lista { flex: 1; min-height: 0; }
.cshell-detalle { display: flex; flex-direction: column; min-height: 0; overflow-y: auto; }
.cshell-ficha { flex: 1; min-height: 0; }
.cshell-vacio { margin: auto; padding: 24px; font-size: 14px; color: #94a3b8; text-align: center; }

.cshell-tabs { display: flex; flex-shrink: 0; border-bottom: 1px solid #e2e8f0; }
.cshell-tabs button {
  flex: 1; padding: 9px 8px; font-size: 13px; font-weight: 600; color: #64748b;
  background: none; border: 0; border-bottom: 2px solid transparent; cursor: pointer;
}
.cshell-tabs button.on { color: #0369a1; border-bottom-color: #0ea5e9; }

.cshell-visitas { padding: 12px 14px 0; }
.cshell-visitas h3 { margin: 0 0 8px; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: #475569; }
.cshell-visitas ul { list-style: none; margin: 0 0 14px; padding: 0; }
.cshell-visitas li { display: flex; align-items: center; gap: 8px; padding: 7px 10px; margin-bottom: 5px; font-size: 13px; border: 1px solid #e2e8f0; border-radius: 7px; cursor: pointer; }
.cshell-visitas li:hover { background: #f8fafc; }
.cshell-visitas li.on { background: #e0f2fe; border-color: #7dd3fc; }
.cshell-v-fecha { color: #64748b; font-size: 12px; }
.cshell-v-estado { padding: 1px 6px; font-size: 10px; text-transform: uppercase; color: #475569; background: #f1f5f9; border-radius: 999px; }
.cshell-v-cie { padding: 0 5px; font-size: 11px; font-weight: 700; color: #0369a1; background: #e0f2fe; border-radius: 4px; }
.cshell-v-dx { flex: 1; min-width: 0; color: #0f172a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.cshell-head { display: none; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid #e2e8f0; }
.cshell-volver { padding: 2px 10px; font-size: 20px; line-height: 1; color: #0369a1; background: none; border: 0; cursor: pointer; }
.cshell-titulo { margin: 0; font-size: 15px; font-weight: 600; color: #0f172a; }

@media (max-width: 768px) {
  .cshell { grid-template-columns: 1fr; }
  .cshell-head { display: flex; }
  .cshell--lista .cshell-detalle { display: none; }
  .cshell--detalle .cshell-lado { display: none; }
}
</style>
