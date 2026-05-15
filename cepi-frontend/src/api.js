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
  if (res?.token) localStorage.setItem('cepi.jwt', res.token);
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
  return call('/api/bot/chat', { method: 'POST', body: JSON.stringify(body) });
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
