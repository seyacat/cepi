/**
 * Telegram Bot API adapter for cepi-bot.
 *
 * Mirrors `whatsapp.ts`: runs a second Express listener (default :9998) that
 * receives Telegram webhook updates and routes every inbound text message
 * through the SAME chat brain the medical frontend uses (`invokeChat` in
 * server.ts). The bot's structured reply (text + optional BotForm + quick
 * replies) is degraded to plain Telegram messages, since Telegram can't render
 * inline cepi forms.
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

/** Append quick replies as a numbered hint (Telegram text fallback). */
function renderQuickReplies(qr: QuickReply[]): string {
  if (!qr?.length) return '';
  return '\n\n' + qr.map((q, i) => `${i + 1}. ${q.label}`).join('\n');
}

/** Build the outbound Telegram text from a chat-brain response body. */
function composeReply(body: any): string {
  let text = String(body?.text || '').trim();
  if (body?.form) text += '\n' + renderForm(body.form);
  if (Array.isArray(body?.quick_replies)) text += renderQuickReplies(body.quick_replies);
  return text || '…';
}

/**
 * Send a text message back through the Telegram Bot API (best-effort).
 * Telegram caps messages at 4096 chars; we slice to stay under it. We send
 * without parse_mode so the plain-text form rendering can't trip entity parsing.
 */
async function sendTelegramText(chatId: number, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log(`[telegram] (dry-run, no TELEGRAM_BOT_TOKEN) → ${chatId}: ${text}`);
    return;
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4096) }),
    });
    if (!r.ok) console.error(`[telegram] send failed ${r.status}: ${await r.text()}`);
  } catch (e: any) {
    console.error('[telegram] send error:', e?.message || e);
  }
}

/** Process one inbound message object from the webhook update. */
async function handleInbound(invokeChat: InvokeChat, message: any): Promise<void> {
  const chatId = message?.chat?.id;
  if (typeof chatId !== 'number') return;
  // Only plain text is routed for now (photos/voice would map to attachments).
  const text = message?.text;
  if (typeof text !== 'string' || !text.trim()) {
    await sendTelegramText(chatId, 'Por ahora solo proceso mensajes de texto.');
    return;
  }

  const jwt = await getServiceJwt();
  const apiKey = process.env.CEPI_GUEST_API_KEY || '';
  const headers: Record<string, string> = {};
  if (jwt) headers['authorization'] = `Bearer ${jwt}`;
  else if (apiKey) headers['x-api-key'] = apiKey;
  const sessionId = chatSessions.get(chatId) || undefined;

  const { body } = await invokeChat({
    headers,
    body: { message: text, session_id: sessionId },
  });

  // Remember the session for this chat; drop it when the session closes.
  if (body?.session_id) {
    if (body?.session_closed) chatSessions.delete(chatId);
    else chatSessions.set(chatId, body.session_id);
  }

  await sendTelegramText(chatId, composeReply(body));
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
        allowed_updates: ['message'],
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
      if (message) {
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
