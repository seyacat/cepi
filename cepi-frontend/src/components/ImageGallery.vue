<!--
  ImageGallery.vue — modal/overlay that shows the clinical images of an
  episode in a grid. Each cell renders the image plus, in its footer, the
  results of the ISIC AI models (classifications). Read-only.

  Data comes from cepi-bot's GET /api/bot/episode-images. Image binaries are
  fetched as blob URLs (the attachment endpoint needs a Bearer token).
-->
<template>
  <div class="gal-modal" @click.self="$emit('close')">
    <div class="gal-panel">
      <div class="gal-head">
        <strong>Imágenes clínicas del episodio</strong>
        <button type="button" class="gal-close" @click="$emit('close')">Cerrar</button>
      </div>

      <div class="gal-body">
        <div v-if="loading" class="gal-state">Cargando imágenes…</div>
        <div v-else-if="error" class="gal-state gal-error">
          {{ error }}
          <button type="button" class="gal-retry" @click="load">Reintentar</button>
        </div>
        <div v-else-if="!images.length" class="gal-state">
          No hay imágenes clínicas en este episodio.
        </div>

        <div v-else class="gal-grid">
          <figure v-for="img in images" :key="img.id" class="gal-cell">
            <div class="gal-imgwrap">
              <span v-if="img.privada" class="gal-badge" title="La imagen contiene un rostro detectado">
                🔒 Privada — contiene rostro
              </span>
              <img
                v-if="img.objectUrl"
                :src="img.objectUrl"
                :alt="img.field_key || 'imagen clínica'"
                class="gal-img"
              />
              <div v-else-if="img.imgError" class="gal-imgph">Imagen no disponible</div>
              <div v-else class="gal-imgph">Cargando…</div>
            </div>

            <figcaption class="gal-foot">
              <div class="gal-fk">{{ img.field_key || 'imagen' }}</div>

              <div v-if="img.classifications && img.classifications.length" class="gal-models">
                <div v-for="c in img.classifications" :key="c.model_id" class="gal-model">
                  <span class="gal-model-id">{{ c.model_id }}</span>
                  <ul class="gal-labels">
                    <li v-for="l in topLabels(c.labels)" :key="l.label">
                      {{ l.label }}
                      <span class="gal-conf">{{ pct(l.confidence) }}</span>
                    </li>
                    <li v-if="!c.labels || !c.labels.length" class="gal-muted">sin etiquetas</li>
                  </ul>
                </div>
              </div>
              <div v-else-if="img.embedding_status === 'pending'" class="gal-muted">
                Clasificación en proceso…
              </div>
              <div v-else class="gal-muted">Sin resultados aún</div>
            </figcaption>
          </figure>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { getEpisodeImages, fetchAttachmentObjectUrl } from '../api.js';

const props = defineProps({
  episodeId: { type: String, required: true },
});
defineEmits(['close']);

const images = ref([]);
const loading = ref(false);
const error = ref('');

function pct(c) {
  return `${((Number(c) || 0) * 100).toFixed(0)}%`;
}

// Top-3 labels by confidence (covers HAM10000 multiclass; binary models just
// show their two labels).
function topLabels(labels) {
  return [...(labels || [])]
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    .slice(0, 3);
}

function revokeAll() {
  for (const img of images.value) {
    if (img.objectUrl) {
      try { URL.revokeObjectURL(img.objectUrl); } catch { /* ignore */ }
    }
  }
}

async function load() {
  loading.value = true;
  error.value = '';
  revokeAll();
  images.value = [];
  try {
    const r = await getEpisodeImages(props.episodeId);
    images.value = (r?.images || []).map(im => ({
      ...im,
      objectUrl: null,
      imgError: false,
    }));
    // Fetch each binary as a blob URL (auth-aware).
    for (const img of images.value) {
      if (!img.file_url) { img.imgError = true; continue; }
      fetchAttachmentObjectUrl(img.file_url)
        .then(url => { img.objectUrl = url; })
        .catch(() => { img.imgError = true; });
    }
  } catch (e) {
    error.value = e?.message || 'No se pudieron cargar las imágenes.';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
onBeforeUnmount(revokeAll);
</script>

<style scoped>
.gal-modal {
  position: fixed; inset: 0; z-index: 1000;
  background: rgba(15, 23, 42, 0.55);
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
}
.gal-panel {
  background: #fff; border-radius: 12px;
  width: min(960px, 96vw); max-height: 92vh;
  display: flex; flex-direction: column;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.3);
}
.gal-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0.85rem 1.1rem;
  border-bottom: 1px solid var(--border, #e2e8f0);
}
.gal-close {
  border: 1px solid var(--border, #cbd5e1); background: #fff;
  border-radius: 8px; padding: 0.3rem 0.8rem; cursor: pointer;
  font-weight: 600; font-size: 0.82rem;
}
.gal-close:hover { background: #f1f5f9; }
.gal-body { overflow-y: auto; padding: 1rem 1.1rem; }
.gal-state {
  padding: 2rem 1rem; text-align: center; color: #64748b;
  font-size: 0.9rem;
}
.gal-error { color: #b91c1c; }
.gal-retry {
  display: block; margin: 0.8rem auto 0;
  border: 1px solid #b91c1c; background: #fff; color: #b91c1c;
  border-radius: 8px; padding: 0.3rem 0.9rem; cursor: pointer; font-weight: 600;
}
.gal-grid {
  display: grid; gap: 1rem;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
}
.gal-cell {
  margin: 0; border: 1px solid var(--border, #e2e8f0);
  border-radius: 10px; overflow: hidden; background: #f8fafc;
  display: flex; flex-direction: column;
}
.gal-imgwrap { position: relative; background: #0f172a; }
.gal-img { display: block; width: 100%; height: 200px; object-fit: contain; }
.gal-imgph {
  height: 200px; display: flex; align-items: center; justify-content: center;
  color: #94a3b8; font-size: 0.82rem;
}
.gal-badge {
  position: absolute; top: 6px; left: 6px;
  background: rgba(180, 30, 30, 0.92); color: #fff;
  font-size: 0.68rem; font-weight: 700;
  padding: 0.18rem 0.5rem; border-radius: 6px;
}
.gal-foot { padding: 0.6rem 0.7rem; }
.gal-fk {
  font-weight: 700; font-size: 0.78rem; text-transform: capitalize;
  color: #334155; margin-bottom: 0.4rem;
}
.gal-model { margin-bottom: 0.5rem; }
.gal-model:last-child { margin-bottom: 0; }
.gal-model-id {
  display: inline-block; font-size: 0.7rem; font-weight: 700;
  color: #4f46e5; background: #eef2ff;
  padding: 0.1rem 0.4rem; border-radius: 5px;
}
.gal-labels { list-style: none; margin: 0.25rem 0 0; padding: 0; }
.gal-labels li {
  font-size: 0.76rem; color: #334155;
  display: flex; justify-content: space-between; gap: 8px;
  padding: 0.08rem 0;
}
.gal-conf { font-weight: 700; color: #0f172a; }
.gal-muted { font-size: 0.76rem; color: #94a3b8; font-style: italic; }
</style>
