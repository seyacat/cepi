/**
 * bot_session persistence (PAPER §11.5). Stores conversational state as a
 * regular entity in TodoERP so it gets all the platform features for free
 * (chatter, audit, attachments, future search).
 *
 * The session is keyed by entity id (UUID). The agent reads turns + slots
 * at start of turn and writes back at end of turn. Failures during write
 * do not block the response (logged, retried best-effort).
 *
 * The bot_session entity_definition is seeded by medical-seed/001
 * (entity_id 17000000-0000-0000-0000-000000000000).
 */
import { TodoErpMcpClient, ToolCallResult } from './mcpClient.js';
import { ChatTurn } from './llm.js';

const BOT_SESSION_ENTITY_ID = '17000000-0000-0000-0000-000000000000';

export interface BotSession {
  id: string;
  user_id: string | null;
  active_patient_id: string | null;
  active_episode_id: string | null;
  turns: ChatTurn[];
  extracted_slots: Record<string, unknown>;
  pending_slots: string[];
  tool_calls: Array<{ name: string; args: any; ok: boolean; t: string }>;
  estado: 'abierta' | 'cerrada' | 'abandonada';
}

export function emptySession(userId: string | null = null): Omit<BotSession, 'id'> {
  return {
    user_id: userId,
    active_patient_id: null,
    active_episode_id: null,
    turns: [],
    extracted_slots: {},
    pending_slots: [],
    tool_calls: [],
    estado: 'abierta',
  };
}

/** Convert an in-memory session into the JSONB shape declared by the
 *  bot_session entity_definition (textarea fields hold serialized JSON). */
function toPersistedShape(s: Omit<BotSession, 'id'>): Record<string, unknown> {
  return {
    user_id:           s.user_id ?? '',
    active_patient_id: s.active_patient_id ?? '',
    active_episode_id: s.active_episode_id ?? '',
    turns:             JSON.stringify(s.turns ?? []),
    extracted_slots:   JSON.stringify(s.extracted_slots ?? {}),
    pending_slots:     JSON.stringify(s.pending_slots ?? []),
    tool_calls:        JSON.stringify(s.tool_calls ?? []),
    estado:            s.estado,
  };
}

function safeParseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string') return (raw as T) ?? fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

export async function createSession(
  mcp: TodoErpMcpClient,
  userId: string | null
): Promise<BotSession> {
  const data = emptySession(userId);
  const r: ToolCallResult = await mcp.call('entities.create', {
    record_type: 'business',
    entity_id: BOT_SESSION_ENTITY_ID,
    title: `bot_session_${new Date().toISOString()}`,
    data: toPersistedShape(data),
  });
  if (!r.ok) throw new Error(`createSession failed: ${r.error}`);
  return { id: r.data.id, ...data };
}

export async function loadSession(
  mcp: TodoErpMcpClient,
  sessionId: string
): Promise<BotSession | null> {
  const r: ToolCallResult = await mcp.call('entities.get', { id: sessionId });
  if (!r.ok || !r.data) return null;
  const d = r.data.data || {};
  return {
    id: r.data.id,
    user_id:           d.user_id || null,
    active_patient_id: d.active_patient_id || null,
    active_episode_id: d.active_episode_id || null,
    turns:             safeParseJson<ChatTurn[]>(d.turns, []),
    extracted_slots:   safeParseJson<Record<string, unknown>>(d.extracted_slots, {}),
    pending_slots:     safeParseJson<string[]>(d.pending_slots, []),
    tool_calls:        safeParseJson<BotSession['tool_calls']>(d.tool_calls, []),
    estado:            (d.estado as BotSession['estado']) || 'abierta',
  };
}

export async function saveSession(mcp: TodoErpMcpClient, session: BotSession): Promise<void> {
  const { id, ...rest } = session;
  const r = await mcp.call('entities.update', {
    id,
    record_type: 'business',
    data: toPersistedShape(rest),
  });
  if (!r.ok) {
    console.warn(`[sessionStore] save failed for ${id}: ${r.error}`);
  }
}
