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

/**
 * /api/bot/session/:id — hydrate a saved session so the frontend can resume
 * after a page refresh without losing the transcript.
 */
app.get('/api/bot/session/:id', async (req: Request, res: Response, next: NextFunction) => {
  let mcp: TodoErpMcpClient | null = null;
  try {
    const auth = req.header('authorization') || '';
    const jwt    = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : '';
    const apiKey = req.header('x-api-key') || process.env.CEPI_GUEST_API_KEY || '';
    if (!jwt && !apiKey) return res.status(401).json({ ok: false, error: 'Auth required' });

    mcp = new TodoErpMcpClient({ jwt, apiKey });
    await mcp.connect();
    const s = await loadSession(mcp, String(req.params.id));
    if (!s) return res.status(404).json({ ok: false, error: 'Session not found' });

    res.json({
      ok: true,
      session_id: s.id,
      history: s.turns,
      active_patient_id: s.active_patient_id,
      active_episode_id: s.active_episode_id,
      pending_action: s.pending_action,
    });
  } catch (err) { next(err); }
  finally {
    if (mcp) await mcp.close().catch(() => {});
  }
});

/**
 * /api/bot/capabilities — debug helper. Spawns an MCP client with the
 * caller's identity, lists tools, and reports the LLM provider in use.
 */
app.get('/api/bot/capabilities', async (req: Request, res: Response, next: NextFunction) => {
  let mcp: TodoErpMcpClient | null = null;
  try {
    const auth = req.header('authorization') || '';
    const jwt    = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : '';
    const apiKey = req.header('x-api-key') || process.env.CEPI_GUEST_API_KEY || '';
    if (!jwt && !apiKey) return res.status(401).json({ ok: false, error: 'Auth required' });

    mcp = new TodoErpMcpClient({ jwt, apiKey });
    await mcp.connect();
    const tools = await mcp.listTools();

    res.json({
      ok: true,
      llm_provider: process.env.CEPI_LLM_PROVIDER || 'stub',
      todoerp_url:  process.env.TODOERP_API_URL  || 'http://localhost:3001',
      tools: tools.map(t => ({ name: t.name, description: t.description })),
    });
  } catch (err) { next(err); }
  finally {
    if (mcp) await mcp.close().catch(() => {});
  }
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

          // PAPER §13.3 — audit: every successful tool call by the bot
          // leaves a chatter note on the affected entity (best-effort).
          if (result.ok) {
            const targetForNote =
              (pa.tool === 'entities.create' && newId) ? newId :
              (pa.tool === 'entities.update' && (pa.args as any)?.id) ? (pa.args as any).id :
              (pa.tool === 'entities.request_review' && (pa.args as any)?.entity_id) ? (pa.args as any).entity_id :
              null;
            if (targetForNote) {
              await mcp.call('chatter.add_note', {
                entity_id: targetForNote,
                body: `🤖 Acción ejecutada por el agente: \`${pa.tool}\` — ${pa.summary}`,
              }).catch(() => {});
            }
          }

          // Convenience: auto-activate newly created clinical entities so the
          // user can keep working without typing UUIDs back at the bot.
          if (result.ok && pa.tool === 'entities.create' && newId) {
            const createdType = (pa.args as any)?.entity_id;
            if (createdType === '11000000-0000-0000-0000-000000000000') {
              session.active_patient_id = newId;
            } else if (createdType === '12000000-0000-0000-0000-000000000000') {
              session.active_episode_id = newId;
            }
          }
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
            active_patient_id: session.active_patient_id,
            active_episode_id: session.active_episode_id,
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

      // ── "resumen" — quick patient summary using entities.list filters ──
      if (/^\s*\/?\s*resumen\s*$/i.test(message.trim())) {
        if (!activePatientId) {
          const ackText = 'Activa un paciente primero (activar paciente <uuid>).';
          session.turns = [...session.turns,
            { role: 'user', content: message }, { role: 'assistant', content: ackText }];
          await saveSession(mcp, session);
          return res.json({ ok: true, session_id: sessionId, text: ackText, history: session.turns,
            toolCalls: [], active_patient_id: activePatientId, active_episode_id: activeEpisodeId });
        }
        const [pat, eps, imgs] = await Promise.all([
          mcp.call('entities.get',  { id: activePatientId }),
          mcp.call('entities.list', { type: '12000000-0000-0000-0000-000000000000', search: activePatientId, limit: 50 }),
          mcp.call('entities.list', { type: '16000000-0000-0000-0000-000000000000', search: activePatientId, limit: 50 }),
        ]);
        const epList   = Array.isArray(eps.data)  ? eps.data  : [];
        const imgList  = Array.isArray(imgs.data) ? imgs.data : [];
        const lastEp   = epList[0];
        const text =
          `Resumen de paciente \`${activePatientId.slice(0,8)}…\`:\n` +
          `  • episodios totales: ${epList.length}\n` +
          `  • imágenes clínicas: ${imgList.length}\n` +
          (lastEp ? `  • último episodio: ${lastEp.data?.fecha || '?'} (${lastEp.data?.estado || '?'})\n` : '') +
          `Para detalle, "ver paciente" o "ver episodio" tras activarlo.`;
        session.turns = [...session.turns,
          { role: 'user', content: message },
          { role: 'tool', tool_name: 'entities.list', content: JSON.stringify({ episodios: epList.length, imagenes: imgList.length, ultimo_episodio: lastEp?.id || null }) },
          { role: 'assistant', content: text }];
        await saveSession(mcp, session);
        return res.json({ ok: true, session_id: sessionId, text, history: session.turns,
          toolCalls: [], active_patient_id: activePatientId, active_episode_id: activeEpisodeId });
      }

      // ── chatter ─────────────────────────────────────────────────
      const noteMatch = message.trim().match(/^\/?\s*nota\s+(.+)$/i);
      if (noteMatch) {
        const target = activeEpisodeId || activePatientId;
        if (!target) {
          const ackText = 'Necesito un paciente o episodio activo para anclar la nota.';
          session.turns = [...session.turns,
            { role: 'user', content: message }, { role: 'assistant', content: ackText }];
          await saveSession(mcp, session);
          return res.json({ ok: true, session_id: sessionId, text: ackText, history: session.turns,
            toolCalls: [], active_patient_id: activePatientId, active_episode_id: activeEpisodeId });
        }
        const r = await mcp.call('chatter.add_note', { entity_id: target, body: noteMatch[1] });
        const text = r.ok ? `Nota agregada al ${activeEpisodeId ? 'episodio' : 'paciente'} ${target}.` : `No pude agregar nota: ${r.error}`;
        session.turns = [...session.turns,
          { role: 'user', content: message }, { role: 'assistant', content: text }];
        await saveSession(mcp, session);
        return res.json({ ok: true, session_id: sessionId, text, history: session.turns,
          toolCalls: [{ name: 'chatter.add_note', args: { entity_id: target }, result: r }],
          active_patient_id: activePatientId, active_episode_id: activeEpisodeId });
      }
      if (/^\s*\/?\s*ver\s+chatter\s*$/i.test(message.trim())) {
        const target = activeEpisodeId || activePatientId;
        if (!target) {
          const ackText = 'Necesito paciente o episodio activo.';
          session.turns = [...session.turns,
            { role: 'user', content: message }, { role: 'assistant', content: ackText }];
          await saveSession(mcp, session);
          return res.json({ ok: true, session_id: sessionId, text: ackText, history: session.turns,
            toolCalls: [], active_patient_id: activePatientId, active_episode_id: activeEpisodeId });
        }
        const r = await mcp.call('chatter.list', { entity_id: target });
        const text = r.ok ? `Feed de actividad del ${activeEpisodeId ? 'episodio' : 'paciente'}.` : `Error: ${r.error}`;
        session.turns = [...session.turns,
          { role: 'user', content: message },
          { role: 'tool', tool_name: 'chatter.list', content: JSON.stringify(r.ok ? r.data : { error: r.error }) },
          { role: 'assistant', content: text }];
        await saveSession(mcp, session);
        return res.json({ ok: true, session_id: sessionId, text, history: session.turns,
          toolCalls: [{ name: 'chatter.list', args: { entity_id: target }, result: r }],
          active_patient_id: activePatientId, active_episode_id: activeEpisodeId });
      }

      // ── reminder actions (no gate; reversible-ish) ──
      const completeRem = message.trim().match(/^\/?\s*completar\s+reminder\s+([0-9a-f-]{36})\s*(.*)$/i);
      if (completeRem) {
        const r = await mcp.call('reminders.complete', { id: completeRem[1], result: completeRem[2] || 'Marcado como completado por el agente' });
        const text = r.ok ? `Recordatorio ${completeRem[1]} marcado como completado.` : `No pude completar: ${r.error}`;
        session.turns = [...session.turns,
          { role: 'user', content: message }, { role: 'assistant', content: text }];
        await saveSession(mcp, session);
        return res.json({ ok: true, session_id: sessionId, text, history: session.turns,
          toolCalls: [{ name: 'reminders.complete', args: { id: completeRem[1] }, result: r }],
          active_patient_id: activePatientId, active_episode_id: activeEpisodeId });
      }
      const cancelRem = message.trim().match(/^\/?\s*cancelar\s+reminder\s+([0-9a-f-]{36})\s*$/i);
      if (cancelRem) {
        const r = await mcp.call('reminders.cancel', { id: cancelRem[1] });
        const text = r.ok ? `Recordatorio ${cancelRem[1]} cancelado.` : `No pude cancelar: ${r.error}`;
        session.turns = [...session.turns,
          { role: 'user', content: message }, { role: 'assistant', content: text }];
        await saveSession(mcp, session);
        return res.json({ ok: true, session_id: sessionId, text, history: session.turns,
          toolCalls: [{ name: 'reminders.cancel', args: { id: cancelRem[1] }, result: r }],
          active_patient_id: activePatientId, active_episode_id: activeEpisodeId });
      }
      const snoozeRem = message.trim().match(/^\/?\s*snooze\s+reminder\s+([0-9a-f-]{36})\s+([0-9]{4}-[0-9]{2}-[0-9]{2})\s*$/i);
      if (snoozeRem) {
        const until = `${snoozeRem[2]}T09:00:00.000Z`;
        const r = await mcp.call('reminders.snooze', { id: snoozeRem[1], until });
        const text = r.ok ? `Recordatorio ${snoozeRem[1]} pospuesto hasta ${snoozeRem[2]}.` : `No pude posponer: ${r.error}`;
        session.turns = [...session.turns,
          { role: 'user', content: message }, { role: 'assistant', content: text }];
        await saveSession(mcp, session);
        return res.json({ ok: true, session_id: sessionId, text, history: session.turns,
          toolCalls: [{ name: 'reminders.snooze', args: { id: snoozeRem[1], until }, result: r }],
          active_patient_id: activePatientId, active_episode_id: activeEpisodeId });
      }

      // ── "sugerir diagnostico" — read classifications + map to CIE-10 ──
      if (/^\s*\/?\s*sugerir\s+diagn[óo]stico\s*$/i.test(message.trim())) {
        if (!activeEpisodeId) {
          const ackText = 'Activa un episodio primero (activar episodio <uuid>).';
          session.turns = [...session.turns,
            { role: 'user', content: message }, { role: 'assistant', content: ackText }];
          await saveSession(mcp, session);
          return res.json({ ok: true, session_id: sessionId, text: ackText, history: session.turns,
            toolCalls: [], active_patient_id: activePatientId, active_episode_id: activeEpisodeId });
        }
        const list = await mcp.call('entities.list', {
          type: '16000000-0000-0000-0000-000000000000',
          search: activeEpisodeId,
          limit: 1,
        });
        const img = Array.isArray(list.data) && list.data.length ? list.data[0] : null;
        if (!img) {
          const ackText = 'No hay imágenes en el episodio. Adjunta una primero.';
          session.turns = [...session.turns,
            { role: 'user', content: message }, { role: 'assistant', content: ackText }];
          await saveSession(mcp, session);
          return res.json({ ok: true, session_id: sessionId, text: ackText, history: session.turns,
            toolCalls: [], active_patient_id: activePatientId, active_episode_id: activeEpisodeId });
        }
        const cls = await mcp.call('classifications.list', { entity_id: img.id });
        const classifList = Array.isArray(cls.data) ? cls.data : [];
        const multi = classifList.find((c: any) => c.model_id === 'isic-multiclass-v1');
        const triage = classifList.find((c: any) => c.model_id === 'isic-bin-triage-v1');
        if (!multi && !triage) {
          const ackText = 'La imagen aún no tiene clasificaciones. Espera a que el worker ISIC procese.';
          session.turns = [...session.turns,
            { role: 'user', content: message }, { role: 'assistant', content: ackText }];
          await saveSession(mcp, session);
          return res.json({ ok: true, session_id: sessionId, text: ackText, history: session.turns,
            toolCalls: [], active_patient_id: activePatientId, active_episode_id: activeEpisodeId });
        }
        // HAM10000 → CIE-10 (dermatology subset), best-effort mapping.
        const HAM_TO_ICD: Record<string, string[]> = {
          akiec: ['L82', 'Queratosis seborreica (queratosis actínica clínica)'],
          bcc:   ['C44.9', 'Cáncer de piel no melanoma (basocelular)'],
          bkl:   ['L82', 'Queratosis seborreica'],
          df:    ['D23.9', 'Dermatofibroma — neoplasia benigna de piel'],
          mel:   ['C43.9', 'Melanoma maligno de piel'],
          nv:    ['D22.9', 'Nevus melanocítico'],
          vasc:  ['L98.9', 'Lesión vascular cutánea'],
        };
        const top = Array.isArray(multi?.labels) && multi.labels.length ? multi.labels[0] : null;
        const triageTop = Array.isArray(triage?.labels) && triage.labels.length ? triage.labels[0] : null;
        const mapped = top && HAM_TO_ICD[top.label] ? HAM_TO_ICD[top.label] : null;
        const text = [
          `**Sugerencia IA** (imagen \`${img.id.slice(0,8)}…\`):`,
          triageTop ? `  • Triage: ${triageTop.label} (${(triageTop.confidence * 100).toFixed(0)}%)` : null,
          top       ? `  • Clase top: ${top.label} (${(top.confidence * 100).toFixed(0)}%)` : null,
          mapped    ? `  • Mapping CIE-10 propuesto: **${mapped[0]}** — ${mapped[1]}` : null,
          '',
          'Recordá: la sugerencia es informativa. El diagnóstico es decisión del médico (D-Aux-1).',
          mapped    ? `Para registrarlo: \`diagnostico ${mapped[0]} ${mapped[1]}\`` : null,
        ].filter(Boolean).join('\n');
        session.turns = [...session.turns,
          { role: 'user', content: message },
          { role: 'tool', tool_name: 'classifications.list', content: JSON.stringify(classifList) },
          { role: 'assistant', content: text }];
        await saveSession(mcp, session);
        return res.json({ ok: true, session_id: sessionId, text, history: session.turns,
          toolCalls: [{ name: 'classifications.list', args: { entity_id: img.id }, result: cls }],
          active_patient_id: activePatientId, active_episode_id: activeEpisodeId });
      }

      // ── "casos similares" — vector search over the latest image of the active episode ──
      if (/^\s*\/?\s*(casos\s+similares|similares)\s*$/i.test(message.trim())) {
        if (!activeEpisodeId) {
          const ackText = 'Necesito un episodio activo. Usa "activar episodio <uuid>" primero.';
          session.turns = [...session.turns,
            { role: 'user', content: message }, { role: 'assistant', content: ackText }];
          await saveSession(mcp, session);
          return res.json({ ok: true, session_id: sessionId, text: ackText, history: session.turns,
            toolCalls: [], active_patient_id: activePatientId, active_episode_id: activeEpisodeId });
        }
        // Find the most recent clinical_image whose data references this episode.
        const list = await mcp.call('entities.list', {
          type: '16000000-0000-0000-0000-000000000000',
          search: activeEpisodeId,
          limit: 5,
        });
        const img = Array.isArray(list.data) && list.data.length ? list.data[0] : null;
        if (!img) {
          const ackText = 'No encontré imágenes clínicas del episodio activo. Adjunta una primero (📎).';
          session.turns = [...session.turns,
            { role: 'user', content: message }, { role: 'assistant', content: ackText }];
          await saveSession(mcp, session);
          return res.json({ ok: true, session_id: sessionId, text: ackText, history: session.turns,
            toolCalls: [], active_patient_id: activePatientId, active_episode_id: activeEpisodeId });
        }
        const search = await mcp.call('vectors.search', {
          model_id: 'isic-resnet50-v1',
          entity_id: img.id,
          k: 5,
        });
        const text = search.ok
          ? `Casos similares a la imagen \`${img.id.slice(0,8)}…\` (modelo isic-resnet50-v1):`
          : `No pude buscar similares: ${search.error || 'sin embedding aún (¿ya corrió el worker ISIC?)'}`;
        session.turns = [...session.turns,
          { role: 'user', content: message },
          { role: 'tool', tool_name: 'vectors.search',
            content: JSON.stringify(search.ok ? search.data : { error: search.error }) },
          { role: 'assistant', content: text }];
        await saveSession(mcp, session);
        return res.json({
          ok: true, session_id: sessionId, text,
          history: session.turns,
          toolCalls: [{ name: 'vectors.search', args: { model_id: 'isic-resnet50-v1', entity_id: img.id, k: 5 }, result: search }],
          active_patient_id: activePatientId, active_episode_id: activeEpisodeId,
        });
      }

      // ── Stage "/diagnostico <CIE10> <descripcion>" (presuntivo by default) ──
      const diagMatch = message.trim().match(/^\/?\s*diagn[óo]stico\s+([A-Z][0-9]{1,2}(?:\.[0-9]{1,2})?)\s+(.+)$/i);
      if (diagMatch && activeEpisodeId) {
        const codigo = diagMatch[1].toUpperCase();
        const desc   = diagMatch[2].trim();
        session.pending_action = {
          summary: `Crear diagnóstico presuntivo (${codigo}) en el episodio ${activeEpisodeId}`,
          tool: 'entities.create',
          args: {
            record_type: 'business',
            entity_id:   '13000000-0000-0000-0000-000000000000',
            title:       `dx_${codigo}`,
            data: {
              ['12000000-0000-0000-0000-000000000000:episode_id']: activeEpisodeId,
              tipo:          'presuntivo',
              codigo_cie10:  codigo,
              descripcion:   desc,
            },
          },
          successMessage: `Diagnóstico presuntivo guardado (id: {{id}}, CIE-10: ${codigo}).`,
          createdAt: new Date().toISOString(),
        };
        const ackText =
          `Voy a crear un diagnóstico presuntivo:\n` +
          `  • episodio: ${activeEpisodeId}\n` +
          `  • CIE-10: ${codigo}\n` +
          `  • descripción: ${desc}\n` +
          `  • tipo: presuntivo\n\n` +
          `¿Confirmas? (sí / no)\n` +
          `_(Para definitivo necesitarás evidencia AP — D-Aux-2.)_`;
        session.turns = [
          ...session.turns,
          { role: 'user',      content: message },
          { role: 'assistant', content: ackText },
        ];
        await saveSession(mcp, session);
        return res.json({
          ok: true, session_id: sessionId, text: ackText,
          history: session.turns, toolCalls: [],
          active_patient_id: activePatientId, active_episode_id: activeEpisodeId,
          pending_action: session.pending_action,
        });
      }

      // ── Stage "/escalar a <user-uuid> <razón>" behind gate ──
      const escalateMatch = message.trim().match(/^\/?\s*escalar\s+a\s+([0-9a-f-]{36})\s+(.+)$/i);
      if (escalateMatch && activeEpisodeId) {
        const reviewer = escalateMatch[1];
        const reason   = escalateMatch[2].trim();
        session.pending_action = {
          summary: `Escalar episodio ${activeEpisodeId} a ${reviewer}`,
          tool: 'entities.request_review',
          args: {
            entity_id: activeEpisodeId,
            reviewers: [reviewer],
            reason,
          },
          successMessage: `Episodio escalado. Recordatorio creado para el reviewer.`,
          createdAt: new Date().toISOString(),
        };
        const ackText =
          `Voy a escalar el episodio ${activeEpisodeId}.\n` +
          `  • reviewer: ${reviewer}\n` +
          `  • motivo: ${reason}\n\n` +
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
          active_patient_id: activePatientId, active_episode_id: activeEpisodeId,
          pending_action: session.pending_action,
        });
      }

      // ── Stage "cerrar episodio [YYYY-MM-DD] [motivo]" behind gate ──
      const closeMatch = message.trim().match(/^\/?\s*cerrar\s+episodio\b\s*([0-9]{4}-[0-9]{2}-[0-9]{2})?\s*(.*)$/i);
      if (closeMatch && activeEpisodeId) {
        const proxFecha   = closeMatch[1] || '';
        const proxMotivo  = (closeMatch[2] || '').trim() || 'Control de seguimiento';

        // PUT replaces `data` wholesale, so we fetch the current episode and
        // merge the close fields on top to preserve patient_id, medico_id,
        // fecha, motivo_consulta, etc.
        const cur = await mcp.call('entities.get', { id: activeEpisodeId });
        const curData = (cur.ok && cur.data?.data) ? { ...cur.data.data } : {};
        delete (curData as any)._relations;
        const merged: Record<string, unknown> = { ...curData, estado: 'cerrado' };
        if (proxFecha) {
          merged.proximo_control_fecha  = proxFecha;
          merged.proximo_control_motivo = proxMotivo;
        }

        session.pending_action = {
          summary: `Cerrar episodio ${activeEpisodeId}`,
          tool: 'entities.update',
          args: {
            id: activeEpisodeId,
            record_type: 'business',
            data: merged,
          },
          successMessage: proxFecha
            ? `Episodio cerrado. Programé recordatorio de control para ${proxFecha} ("${proxMotivo}").`
            : `Episodio cerrado.`,
          createdAt: new Date().toISOString(),
        };
        const ackText =
          `Voy a cerrar el episodio ${activeEpisodeId}.\n` +
          (proxFecha
            ? `  • próximo control: ${proxFecha}\n  • motivo: ${proxMotivo}\n`
            : `  • sin próximo control programado\n`) +
          `\n¿Confirmas? (sí / no)`;
        session.turns = [
          ...session.turns,
          { role: 'user',      content: message },
          { role: 'assistant', content: ackText },
        ];
        await saveSession(mcp, session);
        return res.json({
          ok: true, session_id: sessionId, text: ackText,
          history: session.turns, toolCalls: [],
          active_patient_id: activePatientId, active_episode_id: activeEpisodeId,
          pending_action:    session.pending_action,
        });
      }

      // ── Stage "nuevo episodio <motivo>" behind confirmation gate ──
      const newEpisodeMatch = message.trim().match(/^\/?\s*nuevo\s+episodio\b\s*(.*)$/i);
      if (newEpisodeMatch) {
        if (!activePatientId) {
          const ackText = 'Necesito un paciente activo. Usa "activar paciente <uuid>" primero.';
          session.turns = [
            ...session.turns,
            { role: 'user',      content: message },
            { role: 'assistant', content: ackText },
          ];
          await saveSession(mcp, session);
          return res.json({
            ok: true, session_id: sessionId, text: ackText,
            history: session.turns, toolCalls: [],
            active_patient_id: activePatientId, active_episode_id: activeEpisodeId,
          });
        }
        const motivo = (newEpisodeMatch[1] || '').trim() || 'Consulta general';
        const today  = new Date().toISOString().slice(0, 10);
        const me = await mcp.call('auth.whoami', {});
        const userId = (me.data?.user?.id as string) || null;
        session.pending_action = {
          summary: `Crear episodio para paciente ${activePatientId}`,
          tool: 'entities.create',
          args: {
            record_type: 'business',
            entity_id:   '12000000-0000-0000-0000-000000000000',
            title:       `episode_${today}`,
            data: {
              ['11000000-0000-0000-0000-000000000000:patient_id']: activePatientId,
              medico_id:       userId,
              fecha:           today,
              tipo:            'presencial',
              motivo_consulta: motivo,
              estado:          'en_curso',
            },
          },
          successMessage: `Episodio creado (id: {{id}}). Lo activo automáticamente; puedes ya subir imágenes.`,
          createdAt: new Date().toISOString(),
        };
        const ackText =
          `Voy a crear un episodio:\n` +
          `  • paciente: ${activePatientId}\n` +
          `  • fecha: ${today}\n` +
          `  • tipo: presencial\n` +
          `  • motivo: ${motivo}\n` +
          `  • estado: en_curso\n\n` +
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
          active_patient_id: activePatientId, active_episode_id: activeEpisodeId,
          pending_action:    session.pending_action,
        });
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

    let pendingAction: any = null;
    if (sessionId && mcp) {
      const finalSession = await loadSession(mcp, sessionId);
      pendingAction = finalSession?.pending_action || null;
    }

    res.json({
      ok: true,
      session_id: sessionId,
      active_patient_id: activePatientId,
      active_episode_id: activeEpisodeId,
      pending_action: pendingAction,
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
