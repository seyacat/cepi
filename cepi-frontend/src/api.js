/**
 * Thin JSON client. The Vite dev server proxies /api/auth and
 * /api/entities to TodoERP (:3001) and /api/bot to cepi-bot (:3002).
 */

function getJwt() {
  return localStorage.getItem('cepi.jwt') || '';
}

async function call(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const jwt = getJwt();
  if (jwt) headers['Authorization'] = `Bearer ${jwt}`;
  const res = await fetch(path, { ...opts, headers });
  let body = null;
  try { body = await res.json(); } catch { /* */ }
  if (!res.ok) {
    const msg = body?.error || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

export async function login(email, password) {
  const res = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  if (res?.token) {
    localStorage.setItem('cepi.jwt', res.token);
    // Let the PWA layer (re)subscribe to web push now that we have a token.
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('cepi:auth'));
  }
  return res;
}

export function logout() {
  localStorage.removeItem('cepi.jwt');
  localStorage.removeItem('cepi.session_id');
  // Future: hit a /api/bot/logout to mark bot_session.estado = 'cerrada'.
}

export function loadSessionId() {
  return localStorage.getItem('cepi.session_id') || null;
}

export function saveSessionId(id) {
  if (id) localStorage.setItem('cepi.session_id', id);
}

export async function chat(message, sessionId, extra = {}) {
  const body = { message };
  if (sessionId) body.session_id = sessionId;
  // Structured form submission ({ form_id, data }) — used by ficha sections.
  if (extra.formSubmission) body.form_submission = extra.formSubmission;
  try {
    return await call('/api/bot/chat', { method: 'POST', body: JSON.stringify(body) });
  } catch (e) {
    // Offline / network failure → queue the turn and flush on reconnect (PWA
    // offline send queue, TELEMEDICINA.md §6C). Only queue real connectivity
    // failures, not server-side 4xx/5xx.
    if (isNetworkError(e)) {
      enqueueOutbox(body);
      return {
        text: '📥 Sin conexión: tu mensaje quedó en cola y se enviará automáticamente al reconectar.',
        offline_queued: true,
      };
    }
    throw e;
  }
}

// ── Offline send queue (PWA) ──────────────────────────────────────────────
const OUTBOX_KEY = 'cepi.outbox';

function isNetworkError(e) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  const m = String(e?.message || e || '');
  return /Failed to fetch|NetworkError|network|HTTP 0\b/i.test(m);
}

function readOutbox() {
  try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); } catch { return []; }
}

function enqueueOutbox(body) {
  const q = readOutbox();
  q.push({ body, ts: Date.now() });
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(q));
}

export function outboxSize() {
  return readOutbox().length;
}

/** Re-send every queued chat turn in order; keep the ones that still fail. */
export async function flushOutbox() {
  const q = readOutbox();
  if (!q.length) return 0;
  const remaining = [];
  for (const item of q) {
    try {
      await call('/api/bot/chat', { method: 'POST', body: JSON.stringify(item.body) });
    } catch (e) {
      if (isNetworkError(e)) remaining.push(item); // still offline — keep
      // a non-network error means the turn was processed/invalid: drop it
    }
  }
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(remaining));
  return q.length - remaining.length;
}

/** Wire the queue to flush whenever the browser regains connectivity. */
export function initOfflineQueue() {
  if (typeof window === 'undefined') return;
  window.addEventListener('online', () => { flushOutbox().catch(() => {}); });
  // Opportunistic flush on startup in case we came back online while closed.
  if (navigator.onLine) flushOutbox().catch(() => {});
}

export async function whoami() {
  return call('/api/auth/me', { method: 'GET' });
}

export async function loadBotSession(sessionId) {
  return call(`/api/bot/session/${encodeURIComponent(sessionId)}`, { method: 'GET' });
}

export async function listBotSessions() {
  return call('/api/bot/sessions', { method: 'GET' });
}

/**
 * Fetch the clinical images of an episode plus their AI classifications.
 * Read-only; backed by cepi-bot's /api/bot/episode-images endpoint.
 */
export async function getEpisodeImages(episodeId) {
  return call(`/api/bot/episode-images?episode_id=${encodeURIComponent(episodeId)}`, { method: 'GET' });
}

/**
 * Fetch an attachment binary as an object URL. The /api/attachments/:id/file
 * endpoint needs a Bearer token, which a plain <img src> cannot carry — so we
 * fetch with auth headers and wrap the response in a blob URL. Callers must
 * revoke the URL when done.
 */
export async function fetchAttachmentObjectUrl(fileUrl) {
  const headers = {};
  const jwt = getJwt();
  if (jwt) headers['Authorization'] = `Bearer ${jwt}`;
  const res = await fetch(fileUrl, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

/**
 * Upload a single file to TodoERP /api/attachments. Optional entity_id
 * links the attachment to a record. Returns the attachment row.
 */
export async function uploadAttachment(file, { entityId, fieldKey } = {}) {
  const fd = new FormData();
  fd.append('file', file);
  if (entityId) fd.append('entity_id', entityId);
  if (fieldKey) fd.append('field_key', fieldKey);

  const headers = {};
  const jwt = localStorage.getItem('cepi.jwt');
  if (jwt) headers['Authorization'] = `Bearer ${jwt}`;

  const res = await fetch('/api/attachments', { method: 'POST', headers, body: fd });
  let body = null; try { body = await res.json(); } catch {}
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  return Array.isArray(body) ? body[0] : body;
}
