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
import { createSession, loadSession, saveSession, BOT_SESSION_ENTITY_ID, BotSession } from './sessionStore.js';
import {
  handleV1Flow, fichaGroupFormFilled, firstIncompleteFichaGroup,
  nextIncompleteFichaGroupId, fichaGroupIsComplete, fichaBookmarks, BotForm,
} from './flowV1.js';
import { icdSearch } from './icdWho.js';
import { listEpisodeImagesWithClassifications, CLINICAL_IMAGE_ENTITY_ID, HAM_TO_ICD } from './episodeImages.js';

dotenv.config();

const PATIENT_ENTITY_ID = '11000000-0000-0000-0000-000000000000';
const EPISODE_ENTITY_ID = '12000000-0000-0000-0000-000000000000';

/**
 * Open a new episode for the active patient and return its id. The episode
 * is the container the ficha clínica sections then fill in via entities.update.
 */
async function openEpisodeFicha(
  mcp: TodoErpMcpClient, _session: BotSession, patientId: string,
): Promise<string | null> {
  const today = new Date().toISOString().slice(0, 10);
  let medicoId: string | null = null;
  try {
    const me = await mcp.call('auth.whoami', {});
    medicoId = ((me as any)?.data?.user?.id as string) || null;
  } catch { /* leave null */ }
  const res = await mcp.call('entities.create', {
    record_type: 'business',
    entity_id: EPISODE_ENTITY_ID,
    title: `episode_${today}`,
    data: {
      [`${PATIENT_ENTITY_ID}:patient_id`]: patientId,
      medico_id: medicoId,
      fecha: today,
      tipo: 'presencial',
      estado: 'en_curso',
    },
  });
  return (res as any)?.ok ? (((res as any).data?.id as string) || null) : null;
}

const app = express();
const PORT = parseInt(process.env.PORT || '3002', 10);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '5mb' }));

app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true, service: 'cepi-bot', port: PORT, ts: new Date().toISOString() });
});

/**
 * /api/bot/sessions — list the caller's saved sessions, most recent first.
 * Used by the frontend sidebar to switch between past conversations.
 */
app.get('/api/bot/sessions', async (req: Request, res: Response, next: NextFunction) => {
  let mcp: TodoErpMcpClient | null = null;
  try {
    const auth = req.header('authorization') || '';
    const jwt    = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : '';
    const apiKey = req.header('x-api-key') || process.env.CEPI_GUEST_API_KEY || '';
    if (!jwt && !apiKey) return res.status(401).json({ ok: false, error: 'Auth required' });

    let userId: string | null = null;
    if (jwt) {
      try {
        const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString('utf8'));
        userId = payload?.sub || null;
      } catch {}
    }

    mcp = new TodoErpMcpClient({ jwt, apiKey });
    await mcp.connect();
    const r = await mcp.call('entities.list', { type: BOT_SESSION_ENTITY_ID, limit: 200 });
    if (!r.ok) return res.status(500).json({ ok: false, error: r.error || 'list failed' });

    const rows: any[] = Array.isArray(r.data?.data) ? r.data.data
                       : Array.isArray(r.data) ? r.data : [];
    const items = rows
      .filter(row => !userId || (row?.data?.user_id ?? '') === userId)
      .map(row => {
        const turnsRaw = row?.data?.turns;
        let preview = '';
        try {
          const turns = typeof turnsRaw === 'string' ? JSON.parse(turnsRaw) : (turnsRaw || []);
          const lastUserTurn = [...turns].reverse().find((t: any) => t?.role === 'user');
          preview = (lastUserTurn?.content || '').slice(0, 80);
        } catch {}
        // Patient name from the persisted context, so the session pill can
        // show who the chat is about.
        let patientName = '';
        try {
          const slotsRaw = row?.data?.extracted_slots;
          const slots = typeof slotsRaw === 'string' ? JSON.parse(slotsRaw) : (slotsRaw || {});
          const pc = slots?.patient_context;
          if (pc) patientName = [pc.nombre, pc.apellidos].filter(Boolean).join(' ');
        } catch {}
        return {
          id:         row.id,
          title:      row.title || '',
          created_at: row.created_at,
          updated_at: row.updated_at,
          estado:     row?.data?.estado || 'abierta',
          preview,
          patient_name: patientName,
        };
      })
      .sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));

    res.json({ ok: true, sessions: items });
  } catch (err) { next(err); }
  finally {
    if (mcp) await mcp.close().catch(() => {});
  }
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

    // Resume the persisted form, but re-evaluate ficha groups: a field shared
    // across sessions (e.g. fecha de nacimiento on the patient) may have been
    // filled elsewhere since this form was staged. If so, auto-skip it.
    let form: BotForm | null = (s.extracted_slots as any)?.active_form ?? null;
    const isFicha = (s.extracted_slots as any)?.form_state?.kind === 'ficha';
    if (isFicha && form && typeof form.id === 'string' && form.id.startsWith('ficha_grp_')) {
      const gid = form.id.slice('ficha_grp_'.length);
      if (await fichaGroupIsComplete(gid, mcp, s)) {
        const nid = await nextIncompleteFichaGroupId(gid, mcp, s);
        form = nid ? await fichaGroupFormFilled(nid, mcp, s) : null;
        s.extracted_slots = {
          ...(s.extracted_slots || {}),
          active_form: form,
          ...(nid ? { ficha_current: nid } : {}),
        };
        await saveSession(mcp, s);
      } else {
        // Refresh the form's pre-filled values from the current DB state.
        form = (await fichaGroupFormFilled(gid, mcp, s)) ?? form;
      }
    }

    res.json({
      ok: true,
      session_id: s.id,
      history: s.turns,
      active_patient_id: s.active_patient_id,
      active_episode_id: s.active_episode_id,
      pending_action: s.pending_action,
      form,
      bookmarks: isFicha ? await fichaBookmarks(mcp, s) : [],
    });
  } catch (err) { next(err); }
  finally {
    if (mcp) await mcp.close().catch(() => {});
  }
});

/**
 * /api/bot/icd/search?q=… — proxy to the WHO ICD-11 MMS search.
 * The OAuth2 token + client_secret stay server-side.
 */
app.get('/api/bot/icd/search', async (req: Request, res: Response) => {
  try {
    const results = await icdSearch(String(req.query.q || ''));
    res.json({ ok: true, results });
  } catch (e: any) {
    res.status(502).json({ ok: false, error: e?.message || 'ICD search failed' });
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

/**
 * /api/bot/episode-images?episode_id=<uuid> — list the clinical images of an
 * episode plus, for each, its AI classifications. Read-only; used by the
 * frontend image gallery. Auth via Bearer JWT or x-api-key, like the other
 * /api/bot GET endpoints.
 */
app.get('/api/bot/episode-images', async (req: Request, res: Response, next: NextFunction) => {
  let mcp: TodoErpMcpClient | null = null;
  try {
    const auth = req.header('authorization') || '';
    const jwt    = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : '';
    const apiKey = req.header('x-api-key') || process.env.CEPI_GUEST_API_KEY || '';
    if (!jwt && !apiKey) return res.status(401).json({ ok: false, error: 'Auth required' });

    const episodeId = String(req.query.episode_id || '').trim();
    if (!episodeId) return res.status(400).json({ ok: false, error: 'episode_id required' });

    mcp = new TodoErpMcpClient({ jwt, apiKey });
    await mcp.connect();
    const images = await listEpisodeImagesWithClassifications(mcp, episodeId);
    res.json({ ok: true, images });
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
      message = '',
      form_submission: formSubmission,
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

    if ((typeof message === 'string' && message.length > 0) || formSubmission) {
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
        const pid = setPatient[1];
        session.active_patient_id = pid;

        // Pull the patient record so the bot has the data in context and can
        // greet with basic info (name, age, sex, weight…) instead of a bare id.
        let patientData: Record<string, any> = {};
        let patientTitle = pid;
        try {
          const pr = await mcp.call('entities.get', { id: pid });
          const rec = (pr as any)?.data || {};
          patientData = rec.data || {};
          patientTitle = rec.title || pid;
        } catch { /* fall back to the id */ }

        const nombre = [patientData.nombre, patientData.apellidos]
          .filter(Boolean).join(' ') || patientTitle;
        const edad = (() => {
          const dob = patientData.fecha_nac;
          if (!dob) return null;
          const d = new Date(dob);
          if (isNaN(d.getTime())) return null;
          const now = new Date();
          let a = now.getFullYear() - d.getFullYear();
          const m = now.getMonth() - d.getMonth();
          if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a--;
          return a >= 0 && a < 150 ? a : null;
        })();
        const info = [
          edad != null ? `${edad} años` : null,
          patientData.sexo ? `sexo ${patientData.sexo}` : null,
          patientData.peso ? `${patientData.peso} kg` : null,
          patientData.cedula ? `cédula ${patientData.cedula}` : null,
          patientData.tipo_sangre ? `grupo ${patientData.tipo_sangre}` : null,
        ].filter(Boolean);

        // Most recent prior episode, summarised in one line for context.
        let prevLine = '';
        let lastEpisodeId: string | null = null;
        try {
          const er = await mcp.call('entities.list', {
            type: '12000000-0000-0000-0000-000000000000',
            filter: { patient_id: pid },
            limit: 50,
          });
          const eps = Array.isArray((er as any)?.data) ? (er as any).data : [];
          if (eps.length) {
            eps.sort((a: any, b: any) =>
              String(b?.data?.fecha || '').localeCompare(String(a?.data?.fecha || '')));
            const last = eps[0];
            lastEpisodeId = (last?.id as string) || null;
            const motivo = last?.data?.motivo_consulta;
            if (motivo) {
              prevLine = `Consulta anterior (${last?.data?.fecha || 's/f'}): ${motivo}.`;
            }
          }
        } catch { /* no prior episode context */ }

        // "patient_info" is a non-presential lookup: show the data and stop.
        // "patient" (atención) assumes the patient is being attended, so the
        // bot opens a new episode and starts the ficha clínica.
        const infoOnly = (session.extracted_slots as any)?.mode === 'patient_info';
        let fichaForm: BotForm | null = null;

        if (infoOnly) {
          // Non-presential lookup: link the session to the patient's most
          // recent episode so "Mostrar ficha" opens that consultation.
          session.active_episode_id = lastEpisodeId;
          session.extracted_slots = {
            ...(session.extracted_slots || {}),
            mode: 'patient_info',
            patient_context: { id: pid, ...patientData },
            active_form: null,
          };
        } else {
          const episodeId = await openEpisodeFicha(mcp, session, pid);
          session.active_episode_id = episodeId;
          // Skip ficha sections already complete (e.g. a returning patient
          // with full contact data) — start at the first one still missing.
          const firstGroup = await firstIncompleteFichaGroup(mcp, session);
          fichaForm = firstGroup
            ? await fichaGroupFormFilled(firstGroup, mcp, session)
            : null;
          session.extracted_slots = {
            ...(session.extracted_slots || {}),
            mode: 'patient',
            patient_context: { id: pid, ...patientData },
            form_state: { kind: 'ficha' },
            ficha_done: [],
            ...(firstGroup ? { ficha_current: firstGroup } : {}),
            active_form: fichaForm,
          };
        }

        const ackText =
          `Paciente activo: ${nombre}` +
          (info.length ? `\n  ${info.join(' · ')}` : '') +
          (prevLine ? `\n  ${prevLine}` : '') +
          (infoOnly
            ? `\n\nModo información (no presencial). ¿Qué querés saber del paciente?`
            : fichaForm
              ? `\n\nAbrí una consulta nueva. Empecemos la ficha clínica:`
              : `\n\nAbrí una consulta nueva. La ficha ya está completa — revisá lo que quieras desde los marcadores.`);
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
          form: fichaForm,
          bookmarks: await fichaBookmarks(mcp, session),
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

      // ── Close-session command: marks estado=cerrada and signals frontend
      //    so it can drop its sessionId and start fresh on next message.
      const closeSession = trimmed.match(/^\/?\s*(cerrar|cierra|finalizar?|terminar?|salir(?!\s+(paciente|episodio)))\s*(la\s+|de\s+)?(sesi[oó]n|chat)\s*$/i);
      if (closeSession) {
        session.estado = 'cerrada';
        session.pending_action = null;
        const ackText = 'Sesión cerrada. Iniciá una nueva cuando quieras.';
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
          session_closed: true,
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

          // ── Multi-step (batch) pending action — run every step in order.
          // Used by the image-upload ficha groups (one create per image).
          if (Array.isArray(pa.batch) && pa.batch.length) {
            const ids: string[] = [];
            const errs: string[] = [];
            const batchCalls: any[] = [];
            for (const step of pa.batch) {
              const r = await mcp.call(step.tool, step.args);
              batchCalls.push({ name: step.tool, args: step.args, result: r });
              if ((r as any)?.ok) {
                const nid = (r as any)?.data?.id || '';
                if (nid) {
                  ids.push(nid);
                  await mcp.call('chatter.add_note', {
                    entity_id: nid,
                    body: `🤖 Acción ejecutada por el agente: \`${step.tool}\` — ${pa.summary}`,
                  }).catch(() => {});
                }
              } else {
                errs.push((r as any)?.error || 'error');
              }
            }
            const ackText = errs.length
              ? `${pa.successMessage.replace(/\{\{count\}\}/g, String(ids.length))}` +
                ` (con ${errs.length} error(es): ${errs.join('; ')})`
              : pa.successMessage.replace(/\{\{count\}\}/g, String(ids.length));
            session.pending_action = null;
            session.turns = [
              ...session.turns,
              { role: 'user',      content: message },
              { role: 'assistant', content: ackText },
            ];
            await saveSession(mcp, session);
            return res.json({
              ok: true, session_id: sessionId, text: ackText,
              history: session.turns, toolCalls: batchCalls,
              active_patient_id: session.active_patient_id,
              active_episode_id: session.active_episode_id,
              bookmarks: ((session.extracted_slots as any)?.form_state?.kind === 'ficha')
                ? await fichaBookmarks(mcp, session) : undefined,
            });
          }

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
          let extraForm: BotForm | null = null;
          if (result.ok && pa.tool === 'entities.create' && newId) {
            const createdType = (pa.args as any)?.entity_id;
            if (createdType === '11000000-0000-0000-0000-000000000000') {
              session.active_patient_id = newId;
              // In atención mode, open a new episode and start the ficha.
              if ((session.extracted_slots as any)?.mode !== 'patient_info') {
                const episodeId = await openEpisodeFicha(mcp, session, newId);
                session.active_episode_id = episodeId;
                const firstGroup = await firstIncompleteFichaGroup(mcp, session);
                extraForm = firstGroup
                  ? await fichaGroupFormFilled(firstGroup, mcp, session)
                  : null;
                session.extracted_slots = {
                  ...(session.extracted_slots || {}),
                  mode: 'patient',
                  form_state: { kind: 'ficha' },
                  ficha_done: [],
                  ...(firstGroup ? { ficha_current: firstGroup } : {}),
                  active_form: extraForm,
                };
              }
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
            form: extraForm,
            bookmarks: ((session.extracted_slots as any)?.form_state?.kind === 'ficha')
              ? await fichaBookmarks(mcp, session) : undefined,
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

      // ── V1 conversational flow gate (docs/CHATBOT_FLOW.md) ─────────────
      // Handles mode handshake, patient search/select and new-patient form.
      // Returns null when the turn should fall through to legacy handlers.
      {
        const v1 = await handleV1Flow({ session, message, mcp, formSubmission });
        if (v1) {
          // session was already mutated + saved by handleV1Flow.
          // Persist the active form on the session so it survives reloads
          // and conversation switches (the form stays until it's filled).
          if ('form' in v1) {
            session.extracted_slots = {
              ...(session.extracted_slots || {}),
              active_form: v1.form ?? null,
            };
            await saveSession(mcp, session);
          }
          return res.json({
            ok: true, session_id: sessionId, text: v1.text,
            history: session.turns,
            toolCalls: [],
            active_patient_id: session.active_patient_id,
            active_episode_id: session.active_episode_id,
            pending_action: session.pending_action,
            quick_replies: v1.quick_replies || [],
            await_isic: v1.await_isic || [],
            form: (session.extracted_slots as any)?.active_form ?? null,
            bookmarks: v1.bookmarks ?? (((session.extracted_slots as any)?.form_state?.kind === 'ficha')
              ? await fichaBookmarks(mcp, session) : undefined),
          });
        }
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
          mcp.call('entities.list', { type: '12000000-0000-0000-0000-000000000000', filter: { patient_id: activePatientId }, limit: 50 }),
          mcp.call('entities.list', { type: '16000000-0000-0000-0000-000000000000', filter: { patient_id: activePatientId }, limit: 50 }),
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

      // ── "/logout" — close the bot session ──────────────────────
      if (/^\s*\/?\s*logout\s*$/i.test(message.trim())) {
        session.estado = 'cerrada';
        session.active_patient_id = null;
        session.active_episode_id = null;
        session.pending_action = null;
        const ackText = 'Sesión cerrada. Hasta luego.';
        session.turns = [...session.turns,
          { role: 'user', content: message }, { role: 'assistant', content: ackText }];
        await saveSession(mcp, session);
        return res.json({ ok: true, session_id: sessionId, text: ackText, history: session.turns,
          toolCalls: [], active_patient_id: null, active_episode_id: null, pending_action: null });
      }

      // ── "/exportar [anonimizado]" — bundle paciente + episodios + diagnósticos + imágenes ──
      const exportMatch = message.trim().match(/^\s*\/?\s*exportar\s*(anonimizado)?\s*$/i);
      if (exportMatch) {
        const anonimizar = !!exportMatch[1];
        if (!activePatientId) {
          const ackText = 'Activa un paciente primero.';
          session.turns = [...session.turns,
            { role: 'user', content: message }, { role: 'assistant', content: ackText }];
          await saveSession(mcp, session);
          return res.json({ ok: true, session_id: sessionId, text: ackText, history: session.turns,
            toolCalls: [], active_patient_id: activePatientId, active_episode_id: activeEpisodeId });
        }
        const [pat, eps, imgs] = await Promise.all([
          mcp.call('entities.get',  { id: activePatientId }),
          mcp.call('entities.list', { type: '12000000-0000-0000-0000-000000000000', filter: { patient_id: activePatientId }, limit: 100 }),
          mcp.call('entities.list', { type: '16000000-0000-0000-0000-000000000000', filter: { patient_id: activePatientId }, limit: 100 }),
        ]);
        const mcpRef = mcp;
        const epIds = (Array.isArray(eps.data) ? eps.data : []).map((e: any) => e.id);
        const dxs   = (await Promise.all(epIds.map(id =>
          mcpRef.call('entities.list', { type: '13000000-0000-0000-0000-000000000000', search: id, limit: 50 })
        ))).flatMap(r => (Array.isArray(r.data) ? r.data : []));

        const rawBundle = {
          exported_at: new Date().toISOString(),
          patient: pat.data || null,
          episodes: eps.data || [],
          clinical_images: imgs.data || [],
          diagnoses: dxs,
        };
        const { redactPiiDeep } = await import('./redact.js');
        const bundle = anonimizar ? redactPiiDeep(rawBundle) : rawBundle;
        const ackText = `Bundle del paciente listo${anonimizar ? ' (anonimizado)' : ''} — ${(eps.data || []).length} episodios, ${(imgs.data || []).length} imágenes, ${dxs.length} diagnósticos.`;
        session.turns = [...session.turns,
          { role: 'user', content: message },
          { role: 'tool', tool_name: 'export.bundle', content: JSON.stringify(bundle) },
          { role: 'assistant', content: ackText }];
        await saveSession(mcp, session);
        return res.json({
          ok: true, session_id: sessionId, text: ackText, history: session.turns,
          toolCalls: [], active_patient_id: activePatientId, active_episode_id: activeEpisodeId,
          download: {
            filename: `paciente_${activePatientId.slice(0,8)}${anonimizar ? '_anon' : ''}.json`,
            content_type: 'application/json',
            content: JSON.stringify(bundle, null, 2),
          },
        });
      }

      // ── "/signs k=v k=v" — update signos_vitales on the active episode ──
      const signsMatch = message.trim().match(/^\/?\s*signs?\s+(.+)$/i);
      if (signsMatch && activeEpisodeId) {
        const pairs = signsMatch[1].split(/\s+/).map((p: string) => p.split('=')).filter((p: string[]) => p.length === 2);
        if (!pairs.length) {
          const ackText = 'Formato: signs PA=120/80 FC=70 T=36.5 SatO2=98';
          session.turns = [...session.turns,
            { role: 'user', content: message }, { role: 'assistant', content: ackText }];
          await saveSession(mcp, session);
          return res.json({ ok: true, session_id: sessionId, text: ackText, history: session.turns,
            toolCalls: [], active_patient_id: activePatientId, active_episode_id: activeEpisodeId });
        }
        const sv: Record<string, string> = {};
        for (const [k, v] of pairs) sv[k] = v;

        const cur = await mcp.call('entities.get', { id: activeEpisodeId });
        const curData = (cur.ok && cur.data?.data) ? { ...cur.data.data } : {};
        delete (curData as any)._relations;
        curData.signos_vitales = JSON.stringify(sv);

        session.pending_action = {
          summary: `Registrar signos vitales (${Object.keys(sv).join(', ')}) en el episodio activo`,
          tool: 'entities.update',
          args: { id: activeEpisodeId, record_type: 'business', data: curData },
          successMessage: `Signos vitales guardados.`,
          createdAt: new Date().toISOString(),
        };
        const ackText =
          `Voy a registrar:\n` +
          Object.entries(sv).map(([k, v]) => `  • ${k}: ${v}`).join('\n') +
          `\n\n¿Confirmas? (sí / no)`;
        session.turns = [...session.turns,
          { role: 'user', content: message }, { role: 'assistant', content: ackText }];
        await saveSession(mcp, session);
        return res.json({ ok: true, session_id: sessionId, text: ackText, history: session.turns,
          toolCalls: [], active_patient_id: activePatientId, active_episode_id: activeEpisodeId,
          pending_action: session.pending_action });
      }

      // ── "mostrar resultados imagen" — classifications, optionally scoped ──
      // Trailing clinical_image UUIDs scope the result to those images (the
      // §4.7 auto-flow passes the new ones); without ids it lists them all.
      // Each image is emitted with an inline [img:<attachment_id>] marker the
      // frontend renders as a thumbnail — no separate tool-result block.
      const mostrarImgMatch = message.trim().match(
        /^\/?\s*mostrar\s+resultados?\s+(?:de\s+(?:las?\s+)?)?im[áa]gen(?:es)?\b\s*(.*)$/i,
      );
      if (mostrarImgMatch) {
        if (!activeEpisodeId) {
          const ackText = 'Activa un episodio primero (activar episodio <uuid>).';
          session.turns = [...session.turns,
            { role: 'user', content: message }, { role: 'assistant', content: ackText }];
          await saveSession(mcp, session);
          return res.json({ ok: true, session_id: sessionId, text: ackText, history: session.turns,
            toolCalls: [], active_patient_id: activePatientId, active_episode_id: activeEpisodeId });
        }
        const wantIds = (mostrarImgMatch[1] || '')
          .split(/\s+/).filter((x: string) => /^[0-9a-f-]{36}$/i.test(x));
        let images = await listEpisodeImagesWithClassifications(mcp, activeEpisodeId);
        if (wantIds.length) images = images.filter(im => wantIds.includes(im.id));
        let text: string;
        if (!images.length) {
          text = wantIds.length
            ? 'No encontré esas imágenes en el episodio.'
            : 'No hay imágenes clínicas en el episodio. Adjuntá una primero (📎).';
        } else {
          const blocks = images.map((img, i) => {
            const head = `**Imagen ${i + 1}**` +
              (img.privada ? ' · 🔒 privada (contiene rostro)' : '');
            const imgTag = img.attachment_id ? `[img:${img.attachment_id}]` : '';
            if (img.embedding_status === 'pending' && !img.classifications.length) {
              return [head, imgTag, '  Clasificación en proceso…'].filter(Boolean).join('\n');
            }
            if (!img.classifications.length) {
              return [head, imgTag, '  Sin resultados aún.'].filter(Boolean).join('\n');
            }
            const clsLines = img.classifications.map((c: any) => {
              const labels = [...c.labels]
                .sort((a: any, b: any) => (b.confidence || 0) - (a.confidence || 0))
                .slice(0, 3)
                .map((l: any) => `${l.label} ${((l.confidence || 0) * 100).toFixed(0)}%`)
                .join(', ');
              return `  • ${c.model_id}: ${labels || '—'}`;
            });
            return [head, imgTag, ...clsLines].filter(Boolean).join('\n');
          });
          text = [
            `**Resultados de los modelos IA** — ${images.length} imagen(es):`,
            '',
            ...blocks,
            '',
            'Recordá: las clasificaciones son informativas. El diagnóstico es decisión del médico (D-Aux-1).',
          ].join('\n');
        }
        const userTurn = wantIds.length
          ? '🔬 Resultados de las imágenes cargadas'
          : 'Mostrar resultados de imagen';
        session.turns = [...session.turns,
          { role: 'user', content: userTurn },
          { role: 'assistant', content: text }];
        await saveSession(mcp, session);
        return res.json({ ok: true, session_id: sessionId, text, history: session.turns,
          toolCalls: [], active_patient_id: activePatientId, active_episode_id: activeEpisodeId });
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
          type: CLINICAL_IMAGE_ENTITY_ID,
          filter: { episode_id: activeEpisodeId },
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
          filter: { episode_id: activeEpisodeId },
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
