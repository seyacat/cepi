<!--
  Renders a chat turn's text, expanding inline [img:<attachment_id>] markers
  into thumbnails. The bot emits those markers in the "mostrar resultados
  imagen" reply so each clinical image is shown right above its results.

  The root keeps class `content` so the parent (Chat.vue) bubble styling —
  `.turn.user .content` / `.turn.assistant .content` — still applies (Vue
  passes the parent scope id onto a child component's root element).
-->
<template>
  <div class="content">
    <template v-for="(seg, i) in segments" :key="i">
      <span v-if="seg.type === 'text'" class="seg-text">{{ seg.text }}</span>
      <img
        v-else-if="blobUrls[seg.id]"
        class="seg-img"
        :src="blobUrls[seg.id]"
        :alt="seg.name || 'Imagen clínica'"
        :title="seg.name || 'Ampliar'"
        @click="openLightbox(blobUrls[seg.id])"
      />
      <span v-else class="seg-loading">🖼️ cargando imagen…</span>
    </template>

    <Teleport to="body">
      <div v-if="lightbox" class="lightbox" @click.self="closeLightbox" @wheel.prevent="onWheel">
        <button type="button" class="lb-close" @click="closeLightbox" aria-label="Cerrar">✕</button>
        <img
          class="lb-img"
          :src="lightbox"
          :style="{ transform: `translate(${tx}px,${ty}px) scale(${zoom})`, cursor: zoom > 1 ? 'grab' : 'zoom-in' }"
          @click.stop
          @dblclick="onDbl"
          @pointerdown="onPointerDown" @pointermove="onPointerMove"
          @pointerup="onPointerUp" @pointercancel="onPointerUp"
          @touchstart="onTouchStart" @touchmove.prevent="onTouchMove" @touchend="onTouchEnd"
          draggable="false"
        />
        <div class="lb-hint">Doble toque/clic para acercar · pellizca o rueda para zoom · arrastra para mover</div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed, watch, onUnmounted } from 'vue';
import { fetchAttachmentObjectUrl } from '../api.js';

const props = defineProps({ content: { type: String, default: '' } });

// Soporta dos marcadores de imagen: `[img:<uuid>]` (lo emite el bot) y
// `[adjunto: <nombre> · <uuid>]` (lo emite el uploader del chat). Ambos se
// renderizan inline para ver las imágenes (lesión/consentimiento) sin abrirlas.
const SEG_RE = /\[img:([0-9a-f-]{36})\]|\[adjunto:\s*([^·\]]+?)\s*·\s*([0-9a-f-]{36})\s*\]/gi;

// Split the content into ordered text / image segments.
const segments = computed(() => {
  const out = [];
  let last = 0;
  const re = new RegExp(SEG_RE);
  let m;
  while ((m = re.exec(props.content)) !== null) {
    const before = props.content.slice(last, m.index).replace(/\s+$/, '');
    if (before) out.push({ type: 'text', text: before });
    const id = (m[1] || m[3] || '').toLowerCase();
    out.push({ type: 'image', id, name: (m[2] || '').trim() });
    last = m.index + m[0].length;
  }
  const rest = props.content.slice(last).replace(/^\n+/, '');
  if (rest) out.push({ type: 'text', text: rest });
  return out.length ? out : [{ type: 'text', text: props.content }];
});

const blobUrls = ref({});

async function loadImages() {
  for (const seg of segments.value) {
    if (seg.type !== 'image' || blobUrls.value[seg.id]) continue;
    try {
      const url = await fetchAttachmentObjectUrl(`/api/attachments/${seg.id}/file`);
      blobUrls.value = { ...blobUrls.value, [seg.id]: url };
    } catch { /* leave as "cargando…" */ }
  }
}
watch(() => props.content, loadImages, { immediate: true });

// ── Lightbox con zoom/pan (rueda, doble-toque, pinch, arrastrar) ────────────
const lightbox = ref(null);     // object URL de la imagen abierta, o null
const zoom = ref(1);
const tx = ref(0);
const ty = ref(0);
let drag = null;                // arrastre con puntero
let pinch = null;               // pellizco con dos dedos

function clampZoom(z) { return Math.min(6, Math.max(1, z)); }
function setZoom(z) { zoom.value = clampZoom(z); if (zoom.value === 1) { tx.value = 0; ty.value = 0; } }
function openLightbox(url) { lightbox.value = url; zoom.value = 1; tx.value = 0; ty.value = 0; }
function closeLightbox() { lightbox.value = null; }
function onWheel(e) { setZoom(zoom.value * (e.deltaY < 0 ? 1.15 : 0.87)); }
function onDbl() { setZoom(zoom.value > 1 ? 1 : 2.5); }
function onPointerDown(e) { if (zoom.value <= 1) return; drag = { x: e.clientX, y: e.clientY, tx: tx.value, ty: ty.value }; }
function onPointerMove(e) { if (!drag) return; tx.value = drag.tx + (e.clientX - drag.x); ty.value = drag.ty + (e.clientY - drag.y); }
function onPointerUp() { drag = null; }
function tdist(t) { return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY); }
function onTouchStart(e) { if (e.touches.length === 2) { pinch = { d: tdist(e.touches), z: zoom.value }; } }
function onTouchMove(e) { if (pinch && e.touches.length === 2) setZoom(pinch.z * tdist(e.touches) / pinch.d); }
function onTouchEnd(e) { if (e.touches.length < 2) pinch = null; }
function onKey(e) { if (e.key === 'Escape') closeLightbox(); }
watch(lightbox, (v) => {
  if (typeof window === 'undefined') return;
  if (v) window.addEventListener('keydown', onKey);
  else window.removeEventListener('keydown', onKey);
});

onUnmounted(() => {
  if (typeof window !== 'undefined') window.removeEventListener('keydown', onKey);
  for (const u of Object.values(blobUrls.value)) {
    try { URL.revokeObjectURL(u); } catch { /* already revoked */ }
  }
});
</script>

<style scoped>
.seg-text { white-space: pre-wrap; word-break: break-word; }
.seg-img {
  display: block;
  max-width: 240px;
  max-height: 240px;
  margin: 6px 0;
  border-radius: 8px;
  border: 1px solid var(--border, #d4d4d8);
  object-fit: cover;
  cursor: zoom-in;
}
.seg-loading { display: block; margin: 6px 0; color: #94a3b8; font-style: italic; }

/* Lightbox (maximizar imagen con zoom/pan). */
.lightbox {
  position: fixed; inset: 0; z-index: 1000;
  background: rgba(0, 0, 0, 0.9);
  display: flex; align-items: center; justify-content: center;
  overflow: hidden; touch-action: none;
}
.lb-img {
  max-width: 96vw; max-height: 92vh; object-fit: contain;
  transform-origin: center center; will-change: transform;
  user-select: none; -webkit-user-drag: none; touch-action: none;
}
.lb-close {
  position: fixed; top: 14px; right: 16px; z-index: 1001;
  width: 40px; height: 40px; border-radius: 50%; border: none;
  background: rgba(255, 255, 255, 0.2); color: #fff; font-size: 1.2rem; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.lb-close:hover { background: rgba(255, 255, 255, 0.35); }
.lb-hint {
  position: fixed; bottom: 14px; left: 0; right: 0; text-align: center;
  color: rgba(255, 255, 255, 0.7); font-size: 0.78rem; pointer-events: none; padding: 0 12px;
}
</style>
