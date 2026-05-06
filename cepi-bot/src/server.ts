/**
 * cepi-bot HTTP server. Wraps the agent loop behind a minimal REST API
 * the medical frontend (Fase 5+) can call.
 *
 * Endpoints:
 *   POST /api/bot/chat
 *     body: { history: ChatTurn[], jwt?, apiKey?, mode? }
 *     resp: { text, history, toolCalls }
 *
 *   GET /health
 *     resp: { ok, service, mcpEntry }
 *
 * Auth model: the frontend forwards the user's TodoERP JWT in
 * Authorization: Bearer ... (or x-api-key); the bot uses it on every
 * MCP call so all permission checks happen as that user.
 *
 * Future (Fase 5+): SSE streaming, role-based dispatcher (guest path
 * keeps current legacy behavior, others route through the agent).
 */
import dotenv from 'dotenv';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { runAgentTurn } from './agent.js';
import { ChatTurn } from './llm.js';
import { TodoErpMcpClient } from './mcpClient.js';
import { createSession, loadSession, saveSession } from './sessionStore.js';

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || '3002', 10);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '5mb' }));

app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true, service: 'cepi-bot', port: PORT, ts: new Date().toISOString() });
});

app.post('/api/bot/chat', async (req: Request, res: Response, next: NextFunction) => {
  let mcp: TodoErpMcpClient | null = null;
  try {
    const {
      history,
      jwt: jwtFromBody,
      apiKey: keyFromBody,
      session_id: incomingSessionId,
      message,
    } = req.body || {};

    const auth = req.header('authorization') || '';
    const headerJwt = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : '';
    const headerKey = req.header('x-api-key') || '';

    const jwt    = jwtFromBody || headerJwt || '';
    const apiKey = keyFromBody || headerKey || process.env.CEPI_GUEST_API_KEY || '';
    if (!jwt && !apiKey) {
      return res.status(401).json({ ok: false, error: 'Missing JWT or API key (and no CEPI_GUEST_API_KEY configured)' });
    }

    // Two input modes:
    //   - history:  full transcript (caller manages state itself)
    //   - session_id + message: server loads session, appends, persists
    let inputHistory: ChatTurn[];
    let sessionId: string | null = null;

    mcp = new TodoErpMcpClient({ jwt, apiKey });
    await mcp.connect();

    let activePatientId: string | null = null;
    let activeEpisodeId: string | null = null;

    if (typeof message === 'string' && message.length > 0) {
      // Session-managed path.
      let session = incomingSessionId ? await loadSession(mcp, incomingSessionId) : null;
      if (!session) {
        const me = await mcp.call('auth.whoami', {});
        const userId = (me.data?.user?.id as string) || null;
        session = await createSession(mcp, userId);
      }
      sessionId = session.id;

      // ── slash-style state commands handled server-side, no LLM needed ──
      const trimmed = message.trim();
      const setPatient = trimmed.match(/^\/?\s*activar\s+paciente\s+([0-9a-f-]{36})\s*$/i);
      const clrPatient = trimmed.match(/^\/?\s*(salir|cerrar|olvidar)\s+paciente\s*$/i);
      const setEpisode = trimmed.match(/^\/?\s*activar\s+episodio\s+([0-9a-f-]{36})\s*$/i);
      const clrEpisode = trimmed.match(/^\/?\s*(salir|cerrar|olvidar)\s+episodio\s*$/i);

      if (setPatient) {
        session.active_patient_id = setPatient[1];
        const ackText = `Paciente activo: ${setPatient[1]}.`;
        session.turns = [
          ...session.turns,
          { role: 'user',      content: message },
          { role: 'assistant', content: ackText },
        ];
        await saveSession(mcp, session);
        return res.json({
          ok: true, session_id: sessionId, text: ackText,
          history: session.turns, toolCalls: [],
          active_patient_id: session.active_patient_id,
          active_episode_id: session.active_episode_id,
        });
      }
      if (clrPatient) {
        session.active_patient_id = null;
        const ackText = `Paciente activo limpiado.`;
        session.turns = [
          ...session.turns,
          { role: 'user',      content: message },
          { role: 'assistant', content: ackText },
        ];
        await saveSession(mcp, session);
        return res.json({
          ok: true, session_id: sessionId, text: ackText,
          history: session.turns, toolCalls: [],
          active_patient_id: null,
          active_episode_id: session.active_episode_id,
        });
      }
      if (setEpisode) {
        session.active_episode_id = setEpisode[1];
        const ackText = `Episodio activo: ${setEpisode[1]}.`;
        session.turns = [
          ...session.turns,
          { role: 'user',      content: message },
          { role: 'assistant', content: ackText },
        ];
        await saveSession(mcp, session);
        return res.json({
          ok: true, session_id: sessionId, text: ackText,
          history: session.turns, toolCalls: [],
          active_patient_id: session.active_patient_id,
          active_episode_id: session.active_episode_id,
        });
      }
      if (clrEpisode) {
        session.active_episode_id = null;
        const ackText = `Episodio activo limpiado.`;
        session.turns = [
          ...session.turns,
          { role: 'user',      content: message },
          { role: 'assistant', content: ackText },
        ];
        await saveSession(mcp, session);
        return res.json({
          ok: true, session_id: sessionId, text: ackText,
          history: session.turns, toolCalls: [],
          active_patient_id: session.active_patient_id,
          active_episode_id: null,
        });
      }

      activePatientId = session.active_patient_id;
      activeEpisodeId = session.active_episode_id;

      // ── Confirmation gate: handle "sí/no" against a pending_action ────
      const confirmYes = /^\s*(s[ií]|si|confirmar|ok|adelante|yes)\s*$/i;
      const confirmNo  = /^\s*(no|cancelar|cancel|abort)\s*$/i;
      if (session.pending_action) {
        if (confirmYes.test(message.trim())) {
          const pa = session.pending_action;
          const result = await mcp.call(pa.tool, pa.args);
          const newId  = result.ok ? (result.data?.id || '') : '';
          const ackText = result.ok
            ? pa.successMessage.replace(/\{\{id\}\}/g, newId)
            : `No pude completar la acción: ${result.error}`;
          session.pending_action = null;
          session.turns = [
            ...session.turns,
            { role: 'user',      content: message },
            { role: 'assistant', content: ackText },
          ];
          await saveSession(mcp, session);
          return res.json({
            ok: true, session_id: sessionId, text: ackText,
            history: session.turns,
            toolCalls: [{ name: pa.tool, args: pa.args, result }],
            active_patient_id: activePatientId,
            active_episode_id: activeEpisodeId,
          });
        }
        if (confirmNo.test(message.trim())) {
          session.pending_action = null;
          const ackText = 'Acción cancelada.';
          session.turns = [
            ...session.turns,
            { role: 'user',      content: message },
            { role: 'assistant', content: ackText },
          ];
          await saveSession(mcp, session);
          return res.json({
            ok: true, session_id: sessionId, text: ackText,
            history: session.turns, toolCalls: [],
            active_patient_id: activePatientId,
            active_episode_id: activeEpisodeId,
          });
        }
        // Other input while a pending_action exists: keep the pending; the
        // LLM still sees state context, but user might be reconsidering.
        // Fall through to the normal LLM path below.
      }

      // ── Auto-stage clinical_image creation behind confirmation gate ──
      const attachMatch = message.match(/\[adjunto:\s*([^·]+)·\s*([0-9a-f-]{36})\s*\]/i);
      if (attachMatch && activePatientId && activeEpisodeId) {
        const fileName     = attachMatch[1].trim();
        const attachmentId = attachMatch[2];
        session.pending_action = {
          summary: `Crear clinical_image '${fileName}' ligada al episodio ${activeEpisodeId}`,
          tool: 'entities.create',
          args: {
            record_type: 'business',
            entity_id:   '16000000-0000-0000-0000-000000000000',
            title:       `clinical_image_${fileName}`,
            data: {
              ['12000000-0000-0000-0000-000000000000:episode_id']: activeEpisodeId,
              ['11000000-0000-0000-0000-000000000000:patient_id']: activePatientId,
              attachment_id: attachmentId,
              field_key:     'lesion',
              consentimiento_uso_imagen: true,
              embedding_status: 'pending',
            },
          },
          successMessage: `Imagen registrada como clinical_image (id: {{id}}) ligada al episodio activo.`,
          createdAt: new Date().toISOString(),
        };
        const ackText =
          `Voy a crear una imagen clínica con estos datos:\n` +
          `  • episodio: ${activeEpisodeId}\n` +
          `  • paciente: ${activePatientId}\n` +
          `  • attachment: ${attachmentId}\n` +
          `  • field_key: lesion\n` +
          `  • consentimiento_uso_imagen: true\n\n` +
          `¿Confirmas? (sí / no)`;
        session.turns = [
          ...session.turns,
          { role: 'user',      content: message },
          { role: 'assistant', content: ackText },
        ];
        await saveSession(mcp, session);
        return res.json({
          ok: true, session_id: sessionId, text: ackText,
          history: session.turns, toolCalls: [],
          active_patient_id: activePatientId,
          active_episode_id: activeEpisodeId,
        });
      }

      // Inject current state as a system turn so the LLM is aware.
      const stateNote: ChatTurn = {
        role: 'system',
        content: `Contexto activo: paciente=${activePatientId ?? '(ninguno)'}, episodio=${activeEpisodeId ?? '(ninguno)'}. ` +
                 `Comandos: "activar paciente <uuid>", "salir paciente", "activar episodio <uuid>", "salir episodio".`,
      };
      inputHistory = [...session.turns, stateNote, { role: 'user', content: message }];
    } else if (Array.isArray(history)) {
      inputHistory = history as ChatTurn[];
    } else {
      return res.status(400).json({ ok: false, error: 'Provide either { message, session_id? } or { history }' });
    }

    const out = await runAgentTurn({ jwt, apiKey, history: inputHistory, mcp });

    if (sessionId && mcp) {
      const session = await loadSession(mcp, sessionId);
      if (session) {
        // Don't persist the synthetic system note — strip it before saving.
        session.turns = out.history.filter(t => t.role !== 'system');
        session.tool_calls = [
          ...session.tool_calls,
          ...out.toolCalls.map(tc => ({
            name: tc.name, args: tc.args, ok: tc.result.ok, t: new Date().toISOString(),
          })),
        ];
        await saveSession(mcp, session);
        activePatientId = session.active_patient_id;
        activeEpisodeId = session.active_episode_id;
      }
    }

    res.json({
      ok: true,
      session_id: sessionId,
      active_patient_id: activePatientId,
      active_episode_id: activeEpisodeId,
      ...out,
    });
  } catch (err) { next(err); }
  finally {
    if (mcp) await mcp.close().catch(() => {});
  }
});

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[cepi-bot] error:', err);
  res.status(500).json({ ok: false, error: err?.message || 'Internal error' });
});

const server = app.listen(PORT, () => {
  console.log(`🤖 cepi-bot listening on :${PORT}`);
});

async function shutdown(signal: string) {
  console.log(`[${signal}] shutting down cepi-bot`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export default app;
