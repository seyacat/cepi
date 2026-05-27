/**
 * Telegram Bot API adapter for cepi-bot.
 *
 * Mirrors `whatsapp.ts`: runs a second Express listener (default :9998) that
 * receives Telegram webhook updates and routes every inbound message through
 * the SAME chat brain the medical frontend uses (`invokeChat` in server.ts).
 * Text goes straight through; an inbound photo (or image/* document) is
 * downloaded, uploaded to TodoERP /api/attachments and turned into the
 * `[adjunto: name · uuid]` token the brain recognises — the same path the
 * frontend uses, so it lands as a clinical_image (with the usual gate). The
 * bot's structured reply (text + optional BotForm + quick replies) is degraded
 * to plain Telegram messages, since Telegram can't render inline cepi forms.
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN      Bot API token from @BotFather (SECRET → .env)
 *   TELEGRAM_WEBHOOK_PORT   listen port (default 9998)
 *   TELEGRAM_PUBLIC_URL     public HTTPS base (e.g. the ngrok URL); when set,
 *                           the adapter self-registers the webhook on startup.
 *                           Leave empty to manage the webhook manually.
 *   TELEGRAM_WEBHOOK_SECRET optional token Telegram echoes in the
 *                           X-Telegram-Bot-Api-Secret-Token header (verified)
 *   TELEGRAM_BOT_EMAIL / TELEGRAM_BOT_PASSWORD   service account → JWT per turn
 *                           (falls back to WHATSAPP_BOT_* then CEPI_GUEST_API_KEY)
 *   CEPI_GUEST_API_KEY      identity invokeChat uses when no service JWT
 *
 * Auth model is identical to the WhatsApp adapter: Telegram users have no
 * TodoERP JWT of their own, so the adapter authenticates as a single service
 * account and forwards that JWT on every turn — every write is attributed to
 * that user and goes through the normal permission checks.
 */
import express, { Request, Response } from 'express';
import type { BotForm, BotFormField, QuickReply } from './flowV1.js';

const WEBHOOK_PATH = '/telegram/webhook';

/** Cached service-account JWT + its expiry (epoch seconds). */
let svcJwt: { token: string; exp: number } | null = null;

/**
 * Return a valid service-account JWT, logging in to TodoERP when missing or
 * within 60s of expiry. Returns '' when no service credentials are configured
 * (the caller then falls back to CEPI_GUEST_API_KEY).
 */
async function getServiceJwt(): Promise<string> {
  const email = process.env.TELEGRAM_BOT_EMAIL || process.env.WHATSAPP_BOT_EMAIL;
  const password = process.env.TELEGRAM_BOT_PASSWORD || process.env.WHATSAPP_BOT_PASSWORD;
  if (!email || !password) return '';

  const now = Math.floor(Date.now() / 1000);
  if (svcJwt && svcJwt.exp - 60 > now) return svcJwt.token;

  const base = process.env.TODOERP_API_URL || 'http://localhost:3001';
  try {
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data: any = await r.json().catch(() => ({}));
    const token = data?.token || data?.data?.token || '';
    if (!token) { console.error('[telegram] login: no token in response'); return ''; }
    let exp = now + 3600;
    try { exp = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8')).exp || exp; } catch {}
    svcJwt = { token, exp };
    return token;
  } catch (e: any) {
    console.error('[telegram] service login failed:', e?.message || e);
    return '';
  }
}

type InvokeChat = (input: {
  body: any;
  headers?: Record<string, string>;
}) => Promise<{ status: number; body: any }>;

/** chat_id → cepi-bot session_id. In-memory: fine for testing. */
const chatSessions = new Map<number, string>();

/** chat_id → epoch ms of the last interaction (for the idle "new chat" reset). */
const lastSeen = new Map<number, number>();

/** chat_id → last active patient (to offer "paciente anterior" after a reset). */
const lastPatient = new Map<number, { id: string; name: string }>();

/** chat_id → pending idle timer that proactively sends the menu after IDLE_MS. */
const idleTimers = new Map<number, ReturnType<typeof setTimeout>>();

/** Idle window after which the chat is proactively reset to the "new chat" menu. */
const IDLE_MS = 5 * 60 * 1000;

/**
 * Mark activity on a chat and (re)arm its idle timer. After IDLE_MS with no
 * further activity the timer fires and proactively sends the "new chat" menu —
 * the message goes out AT the 5-minute mark, not on the user's next message.
 */
function touch(chatId: number): void {
  lastSeen.set(chatId, Date.now());
  const existing = idleTimers.get(chatId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => { void onIdle(chatId); }, IDLE_MS);
  if (typeof (t as any).unref === 'function') (t as any).unref();  // don't keep the process alive
  idleTimers.set(chatId, t);
}

/** Idle timer fired: proactively show the menu and reset the chat's session. */
async function onIdle(chatId: number): Promise<void> {
  idleTimers.delete(chatId);
  await sendWelcomeMenu(chatId);
  // The menu was just shown; treat the user's next message as a normal turn.
  lastSeen.set(chatId, Date.now());
}

/** Render a BotForm as plain text so a Telegram user can still answer it. */
function renderForm(form: BotForm): string {
  const lines: string[] = ['', `📋 ${form.title}`];
  for (const f of form.fields as BotFormField[]) {
    if (f.type === 'heading') { lines.push(`\n${f.label}`); continue; }
    const req = f.required ? ' (requerido)' : '';
    let opts = '';
    if (Array.isArray(f.options) && f.options.length) {
      const labels = f.options.map(o => (typeof o === 'string' ? o : o.label));
      opts = ` [${labels.join(' / ')}]`;
    }
    lines.push(`• ${f.label}${req}${opts}`);
  }
  if (form.submit_send) {
    lines.push('', 'Respondé con los datos y los registro.');
  }
  return lines.join('\n');
}

/**
 * Quick-reply `send` payloads can exceed Telegram's 64-byte callback_data
 * limit (e.g. "activar paciente <uuid>"), so we keep a short id → send map and
 * put only the id in callback_data. Bounded FIFO to avoid unbounded growth.
 */
const callbackSends = new Map<string, string>();
let cbCounter = 0;
function registerCallback(send: string): string {
  const id = `q${(cbCounter++).toString(36)}`;
  callbackSends.set(id, send);
  if (callbackSends.size > 2000) {
    const oldest = callbackSends.keys().next().value;
    if (oldest !== undefined) callbackSends.delete(oldest);
  }
  return id;
}

/**
 * Build an inline keyboard (one button per row) from the brain's quick replies.
 * `callback_data` carries the `send` payload directly when it fits Telegram's
 * 64-byte limit (stateless → survives bot restarts); longer payloads fall back
 * to the in-memory id map.
 */
function buildKeyboard(qr: QuickReply[] | undefined): any | undefined {
  if (!Array.isArray(qr) || !qr.length) return undefined;
  return {
    inline_keyboard: qr.map(q => [{
      text: q.label,
      callback_data: Buffer.byteLength(q.send, 'utf8') <= 64 ? q.send : registerCallback(q.send),
    }]),
  };
}

/**
 * Build the outbound Telegram text from a chat-brain response body. The first
 * line is the status header (active patient name, or chat state). Quick replies
 * are NOT inlined here — they become inline keyboard buttons (see buildKeyboard).
 */
function composeReply(body: any): string {
  const header = String(body?.status_header || '').trim();
  let text = String(body?.text || '').trim();
  if (body?.form) text += '\n' + renderForm(body.form);
  text = text || '…';
  return header ? `${header}\n${text}` : text;
}

/**
 * Send a message back through the Telegram Bot API (best-effort). Telegram caps
 * messages at 4096 chars; we slice to stay under it. We send without parse_mode
 * so the plain-text form rendering can't trip entity parsing. `replyMarkup`
 * attaches an inline keyboard when provided.
 */
async function sendTelegramText(chatId: number, text: string, replyMarkup?: any): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log(`[telegram] (dry-run, no TELEGRAM_BOT_TOKEN) → ${chatId}: ${text}`);
    return;
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 4096),
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
    });
    if (!r.ok) console.error(`[telegram] send failed ${r.status}: ${await r.text()}`);
  } catch (e: any) {
    console.error('[telegram] send error:', e?.message || e);
  }
}

/** Acknowledge a tapped inline button so Telegram stops the loading spinner. */
async function answerCallback(callbackQueryId: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId }),
    });
  } catch { /* best-effort */ }
}

/**
 * Download a Telegram file by file_id: resolve its path via getFile, then
 * fetch the bytes from the file CDN. Returns null on any failure.
 */
async function downloadTelegramFile(fileId: string): Promise<{ buffer: Buffer; mime: string } | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  try {
    const info: any = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`)
      .then(r => r.json());
    const filePath = info?.result?.file_path;
    if (!filePath) { console.error('[telegram] getFile: no file_path', JSON.stringify(info)); return null; }
    const r = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
    if (!r.ok) { console.error(`[telegram] file download ${r.status}`); return null; }
    const buffer = Buffer.from(await r.arrayBuffer());
    // Infer mime from the extension Telegram gave the stored path.
    const ext = (filePath.split('.').pop() || 'jpg').toLowerCase();
    const mime = ext === 'png' ? 'image/png'
      : ext === 'webp' ? 'image/webp'
      : ext === 'heic' ? 'image/heic'
      : 'image/jpeg';
    return { buffer, mime };
  } catch (e: any) {
    console.error('[telegram] downloadTelegramFile error:', e?.message || e);
    return null;
  }
}

/** Upload bytes to TodoERP /api/attachments as the service account. Returns the attachment id. */
async function uploadAttachment(jwt: string, buffer: Buffer, filename: string, mime: string): Promise<string | null> {
  const base = process.env.TODOERP_API_URL || 'http://localhost:3001';
  try {
    // Copy into a fresh Uint8Array so the Blob is backed by a plain
    // ArrayBuffer (TS rejects Buffer's ArrayBufferLike as a BlobPart).
    const bytes = new Uint8Array(buffer.byteLength);
    bytes.set(buffer);
    const fd = new FormData();
    fd.append('file', new Blob([bytes], { type: mime }), filename);
    const r = await fetch(`${base}/api/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}` },
      body: fd,
    });
    if (!r.ok) { console.error(`[telegram] attachment upload ${r.status}: ${await r.text()}`); return null; }
    const data: any = await r.json().catch(() => ({}));
    const att = Array.isArray(data) ? data[0] : data;
    return att?.id || null;
  } catch (e: any) {
    console.error('[telegram] uploadAttachment error:', e?.message || e);
    return null;
  }
}

/**
 * If the message carries an image (photo, or an image/* document), download it,
 * upload it to TodoERP and return the `[adjunto: name · uuid]` token the chat
 * brain recognises (same path the frontend uses). Returns '' when there's no
 * image; returns null on a failure the caller should report to the user.
 */
async function resolveImageToken(message: any, jwt: string): Promise<string | null | ''> {
  // photo = array of progressively larger sizes; the last is the largest.
  const photo = Array.isArray(message?.photo) && message.photo.length
    ? message.photo[message.photo.length - 1]
    : null;
  const doc = message?.document && typeof message.document?.mime_type === 'string'
    && message.document.mime_type.startsWith('image/')
    ? message.document : null;
  if (!photo && !doc) return '';

  const fileId = photo?.file_id || doc?.file_id;
  const file = await downloadTelegramFile(fileId);
  if (!file) return null;

  // Filename must not contain '·' (the token delimiter the brain parses).
  const rawName = doc?.file_name || `telegram_${photo?.file_unique_id || Date.now()}.jpg`;
  const name = rawName.replace(/·/g, '-');
  const id = await uploadAttachment(jwt, file.buffer, name, doc?.mime_type || file.mime);
  if (!id) return null;
  return `[adjunto: ${name} · ${id}]`;
}

/**
 * Show the "new chat" menu: New patient / Search patient / (Previous patient).
 * Resets the chat's session so the next turn starts fresh (unset mode).
 */
async function sendWelcomeMenu(chatId: number): Promise<void> {
  chatSessions.delete(chatId);   // fresh session on the next turn
  const buttons: QuickReply[] = [
    { label: '➕ Nuevo paciente', send: 'nuevo paciente' },
    { label: '🔍 Buscar paciente', send: 'paciente' },
  ];
  const prev = lastPatient.get(chatId);
  if (prev) buttons.push({ label: `↩️ Anterior: ${prev.name}`, send: `activar paciente ${prev.id}` });
  await sendTelegramText(chatId, 'Hola 👋 ¿Qué querés hacer?', buildKeyboard(buttons));
}

/** True when this chat has been idle long enough to count as a new conversation. */
function isNewChat(chatId: number): boolean {
  const seen = lastSeen.get(chatId);
  return seen === undefined || (Date.now() - seen) > IDLE_MS;
}

/** Process one inbound message object from the webhook update. */
async function handleInbound(invokeChat: InvokeChat, message: any): Promise<void> {
  const chatId = message?.chat?.id;
  if (typeof chatId !== 'number') return;

  // After 5 min idle (or on first contact) treat it as a new chat: show the
  // menu and don't route this message — the user picks an option via buttons.
  const fresh = isNewChat(chatId);
  touch(chatId);
  if (fresh) {
    await sendWelcomeMenu(chatId);
    return;
  }

  const jwt = await getServiceJwt();
  const apiKey = process.env.CEPI_GUEST_API_KEY || '';

  // An image arrives as `photo`/`document`; its text (if any) is in `caption`.
  const hasImage = (Array.isArray(message?.photo) && message.photo.length)
    || (message?.document && String(message.document?.mime_type || '').startsWith('image/'));
  let imageToken: string | null | '' = '';
  if (hasImage) {
    if (!jwt) {
      // Attachments require a JWT identity; the api-key fallback can't upload.
      await sendTelegramText(chatId, 'No puedo guardar imágenes: falta la cuenta de servicio (TELEGRAM_BOT_EMAIL/PASSWORD).');
      return;
    }
    imageToken = await resolveImageToken(message, jwt);
    if (imageToken === null) {
      await sendTelegramText(chatId, 'No pude procesar la imagen. Probá de nuevo.');
      return;
    }
  }

  const caption = String(message?.text || message?.caption || '').trim();
  // Build the turn text: caption + image token (either may be empty).
  const turnText = [caption, imageToken].filter(Boolean).join('\n').trim();
  if (!turnText) {
    await sendTelegramText(chatId, 'Por ahora proceso texto e imágenes. Mandame un mensaje o una foto.');
    return;
  }

  await routeTurn(invokeChat, chatId, turnText, jwt, apiKey);
}

/**
 * Run one chat turn for a chat and send the reply (text + status header +
 * inline-keyboard buttons for any quick replies). Shared by text/image
 * messages and by tapped-button callbacks.
 */
async function routeTurn(
  invokeChat: InvokeChat, chatId: number, turnText: string, jwt: string, apiKey: string,
): Promise<void> {
  const headers: Record<string, string> = {};
  if (jwt) headers['authorization'] = `Bearer ${jwt}`;
  else if (apiKey) headers['x-api-key'] = apiKey;
  const sessionId = chatSessions.get(chatId) || undefined;

  const { body } = await invokeChat({
    headers,
    body: { message: turnText, session_id: sessionId },
  });

  touch(chatId);

  // Remember the session for this chat; drop it when the session closes.
  if (body?.session_id) {
    if (body?.session_closed) chatSessions.delete(chatId);
    else chatSessions.set(chatId, body.session_id);
  }

  // Cache the active patient so a later "new chat" can offer "paciente anterior".
  if (body?.active_patient_id) {
    const hdr = String(body?.status_header || '');
    const m = hdr.match(/^👤\s*(.+?)(?:\s+—\s+|\s+\(|$)/);
    const name = (m ? m[1].trim() : '') || String(body.active_patient_id).slice(0, 8);
    lastPatient.set(chatId, { id: body.active_patient_id, name });
  }

  await sendTelegramText(chatId, composeReply(body), buildKeyboard(body?.quick_replies));
}

/** Handle a tapped inline button: resolve its `send` payload and route it. */
async function handleCallback(invokeChat: InvokeChat, cq: any): Promise<void> {
  await answerCallback(cq?.id);
  const chatId = cq?.message?.chat?.id;
  if (typeof chatId !== 'number') return;
  touch(chatId);
  const send = callbackSends.get(cq?.data) || cq?.data;
  if (typeof send !== 'string' || !send.trim()) return;
  const jwt = await getServiceJwt();
  const apiKey = process.env.CEPI_GUEST_API_KEY || '';
  await routeTurn(invokeChat, chatId, send, jwt, apiKey);
}

/**
 * Register the webhook with Telegram so updates are POSTed to PUBLIC_URL.
 * No-op when TELEGRAM_PUBLIC_URL is unset (manual management). Best-effort.
 */
async function registerWebhook(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const publicUrl = process.env.TELEGRAM_PUBLIC_URL;
  if (!token || !publicUrl) {
    if (!token) console.log('[telegram] no TELEGRAM_BOT_TOKEN → webhook not registered');
    else console.log('[telegram] no TELEGRAM_PUBLIC_URL → manage webhook manually');
    return;
  }
  const url = publicUrl.replace(/\/+$/, '') + WEBHOOK_PATH;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        ...(secret ? { secret_token: secret } : {}),
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: true,
      }),
    });
    const data: any = await r.json().catch(() => ({}));
    if (data?.ok) console.log(`[telegram] webhook registered → ${url}`);
    else console.error('[telegram] setWebhook failed:', JSON.stringify(data));
  } catch (e: any) {
    console.error('[telegram] setWebhook error:', e?.message || e);
  }
}

/**
 * Start the Telegram webhook listener. Returns the http.Server so the caller
 * can close it on shutdown.
 */
export function startTelegram(invokeChat: InvokeChat) {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  app.get('/health', (_req: Request, res: Response) =>
    res.json({ ok: true, service: 'cepi-bot-telegram' }));

  app.post(WEBHOOK_PATH, async (req: Request, res: Response) => {
    // Verify the optional shared secret Telegram echoes back.
    const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (expected && req.header('x-telegram-bot-api-secret-token') !== expected) {
      return res.sendStatus(401);
    }
    // Ack immediately so Telegram doesn't retry; process asynchronously.
    res.sendStatus(200);
    try {
      const message = req.body?.message || req.body?.edited_message;
      const callback = req.body?.callback_query;
      if (callback) {
        await handleCallback(invokeChat, callback).catch(e =>
          console.error('[telegram] callback error:', e?.message || e));
      } else if (message) {
        await handleInbound(invokeChat, message).catch(e =>
          console.error('[telegram] handle error:', e?.message || e));
      }
    } catch (e: any) {
      console.error('[telegram] webhook error:', e?.message || e);
    }
  });

  const port = parseInt(process.env.TELEGRAM_WEBHOOK_PORT || '9998', 10);
  const server = app.listen(port, () => {
    console.log(`💬 cepi-bot Telegram webhook listening on :${port}`);
    void registerWebhook();
  });
  return server;
}
