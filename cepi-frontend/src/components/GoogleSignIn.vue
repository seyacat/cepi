<template>
  <div ref="btn" class="gbtn"></div>
</template>

<script setup>
import { ref, onMounted } from 'vue';

const emit = defineEmits(['credential']);
const btn = ref(null);
const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';

// Load the Google Identity Services script once, on demand.
function loadGis() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve();
    let s = document.getElementById('gis-script');
    if (s) { s.addEventListener('load', () => resolve()); s.addEventListener('error', reject); return; }
    s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true; s.defer = true; s.id = 'gis-script';
    s.onload = () => resolve();
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

onMounted(async () => {
  if (!CLIENT_ID) return; // Google login disabled if no client id configured at build time
  try {
    await loadGis();
    window.google.accounts.id.initialize({
      client_id: CLIENT_ID,
      callback: (resp) => { if (resp?.credential) emit('credential', resp.credential); },
    });
    window.google.accounts.id.renderButton(btn.value, {
      theme: 'outline', size: 'large', width: 300, text: 'continue_with', shape: 'pill',
    });
  } catch {
    /* GIS unavailable (offline / origin not authorized) — silently skip */
  }
});
</script>

<style scoped>
.gbtn { display: flex; justify-content: center; min-height: 40px; }
</style>
