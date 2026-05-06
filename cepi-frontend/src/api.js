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
}

export function loadSessionId() {
  return localStorage.getItem('cepi.session_id') || null;
}

export function saveSessionId(id) {
  if (id) localStorage.setItem('cepi.session_id', id);
}

export async function chat(message, sessionId) {
  const body = { message };
  if (sessionId) body.session_id = sessionId;
  return call('/api/bot/chat', { method: 'POST', body: JSON.stringify(body) });
}

export async function whoami() {
  return call('/api/auth/me', { method: 'GET' });
}
