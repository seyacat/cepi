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

export async function register({ name, email, password, phone, cedula }) {
  return call('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name, email, password, phone, cedula }),
  });
}

export async function verifyEmail(token) {
  return call(`/api/auth/verify-email?token=${encodeURIComponent(token)}`, { method: 'GET' });
}

export async function googleLogin(credential) {
  const res = await call('/api/auth/google', {
    method: 'POST',
    body: JSON.stringify({ credential }),
  });
  if (res?.token) {
    localStorage.setItem('cepi.jwt', res.token);
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('cepi:auth'));
  }
  return res;
}

// ── Admin (user management) ────────────────────────────────────────────────
export async function adminListUsers(role) {
  const q = role ? `?role=${encodeURIComponent(role)}` : '';
  return call(`/api/admin/users${q}`, { method: 'GET' });
}

export async function adminListRoles() {
  return call('/api/admin/roles', { method: 'GET' });
}

// ── Telemedicina: destinos de derivación (círculos + sus miembros) ──────────────
export async function listGroups(kind) {
  const q = kind ? `?kind=${encodeURIComponent(kind)}` : '';
  return call(`/api/groups${q}`, { method: 'GET' });
}

export async function listGroupMembers(idOrSlug) {
  return call(`/api/groups/${encodeURIComponent(idOrSlug)}/members`, { method: 'GET' });
}

export async function adminUpdateUser(id, patch) {
  return call(`/api/admin/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function adminSetUserGroups(id, slugs) {
  return call(`/api/admin/users/${encodeURIComponent(id)}/groups`, {
    method: 'PUT',
    body: JSON.stringify({ slugs }),
  });
}

export async function adminSetUserOrgs(id, orgIds) {
  return call(`/api/admin/users/${encodeURIComponent(id)}/orgs`, {
    method: 'PUT',
    body: JSON.stringify({ org_ids: orgIds }),
  });
}

// ── Notificaciones (recordatorios del usuario) ──────────────────────────────
// Backed by TodoERP /api/reminders. Clinical roles have `reminders:read_own`,
// so this returns only the caller's own reminders (derivaciones recibidas,
// recordatorios de próximo control, etc.).
export async function listReminders(params = {}) {
  const q = new URLSearchParams();
  if (params.status) q.set('status', params.status);
  if (params.entity_id) q.set('entity_id', params.entity_id);
  // La campana es personal: aunque el rol tenga reminders:read_all, se limita al
  // dueño para no ver notificaciones de otros.
  if (params.owner_user_id) q.set('owner_user_id', params.owner_user_id);
  const qs = q.toString();
  return call(`/api/reminders${qs ? '?' + qs : ''}`, { method: 'GET' });
}

// Patients with reminders pending the caller's review (derived to me). Used to
// surface "to review" patients at the top of the list.
export async function getReviewQueue() {
  return call('/api/review-queue', { method: 'GET' });
}

// Resuelve la entidad de un recordatorio (episodio/paciente) → { patient_id,
// patient_name } para abrir su chat al hacer click en la notificación.
export async function resolveReminderPatient(entityId) {
  return call(`/api/review-queue/patient/${encodeURIComponent(entityId)}`, { method: 'GET' });
}

// Quién tiene "a cargo" a cada paciente (responsable del episodio más reciente).
export async function getPatientAssignments() {
  return call('/api/patient-assignments', { method: 'GET' });
}

export async function completeReminder(id, result) {
  return call(`/api/reminders/${encodeURIComponent(id)}/complete`, {
    method: 'POST',
    body: JSON.stringify(result ? { result } : {}),
  });
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

// El usuario edita su propio perfil (nombre, teléfono, cédula, contraseña).
// Devuelve { token, user } con el token reemitido (el nombre viaja en el JWT).
export async function updateProfile(patch) {
  const res = await call('/api/auth/me', { method: 'PATCH', body: JSON.stringify(patch) });
  if (res?.token) localStorage.setItem('cepi.jwt', res.token);
  return res;
}

// Multi-tenancy: organizaciones del usuario + cambio de org activa.
export async function listOrgs() {
  return call('/api/orgs', { method: 'GET' });
}
export async function switchOrg(orgId) {
  const res = await call('/api/orgs/switch', { method: 'POST', body: JSON.stringify({ org_id: orgId }) });
  if (res?.token) localStorage.setItem('cepi.jwt', res.token);  // nueva org activa
  return res;
}
export async function createOrg(slug, name) {
  return call('/api/orgs', { method: 'POST', body: JSON.stringify({ slug, name }) });
}
export async function updateOrg(id, patch) {
  return call(`/api/orgs/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) });
}
export async function listOrgMembers(id) {
  return call(`/api/orgs/${encodeURIComponent(id)}/members`, { method: 'GET' });
}
export async function addOrgMember(id, userId, roleInOrg) {
  return call(`/api/orgs/${encodeURIComponent(id)}/members`, { method: 'POST', body: JSON.stringify({ user_id: userId, role_in_org: roleInOrg }) });
}
export async function removeOrgMember(id, userId) {
  return call(`/api/orgs/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' });
}
export async function listUsers() {
  return call('/api/security?type=user&active=all', { method: 'GET' });
}

// List patients (entity_definition 11000000-…) for the WhatsApp-style chat list.
// PII is redacted server-side per the caller's role.
export async function listPatients({ limit = 500 } = {}) {
  const params = new URLSearchParams({
    type: 'business',
    entity_id: '11000000-0000-0000-0000-000000000000',
    limit: String(limit),
  });
  return call(`/api/entities?${params.toString()}`, { method: 'GET' });
}

// Create a patient (contact). Schema requires only nombre; cédula is enforced
// client-side. Returns the created record { id, data, ... }.
export async function createPatient({ nombre, apellidos, cedula }) {
  const res = await call('/api/entities', {
    method: 'POST',
    body: JSON.stringify({
      record_type: 'business',
      entity_id: '11000000-0000-0000-0000-000000000000',
      title: `${nombre} ${apellidos}`.trim(),
      data: { nombre, apellidos, cedula },
      active: true,
    }),
  });
  return res?.data || res;
}

export async function loadBotSession(sessionId) {
  return call(`/api/bot/session/${encodeURIComponent(sessionId)}`, { method: 'GET' });
}

export async function listBotSessions(patientId) {
  const q = patientId ? `?patient_id=${encodeURIComponent(patientId)}` : '';
  return call(`/api/bot/sessions${q}`, { method: 'GET' });
}

// Merged "group thread" for a patient: all clinicians' messages + the bot,
// chronological and attributed by author. Backed by TodoERP (cross-user read
// behind a patient-view gate) since the bot only sees the caller's own sessions.
export async function getPatientThread(patientId) {
  return call(`/api/patient-thread?patient_id=${encodeURIComponent(patientId)}`, { method: 'GET' });
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
