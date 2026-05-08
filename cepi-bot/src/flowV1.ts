/**
 * V1 conversational flow gate (docs/CHATBOT_FLOW.md).
 *
 * Implements the mode handshake + patient search/create flow in front of
 * the existing slash-command and LLM handlers. Returns a response object
 * when it handled the turn, or `null` to let the rest of the pipeline run.
 */
import { TodoErpMcpClient } from './mcpClient.js';
import { BotSession, saveSession } from './sessionStore.js';

const PATIENT_ENTITY_ID = '11000000-0000-0000-0000-000000000000';

export interface QuickReply { label: string; send: string; }

export interface FlowResponse {
  text: string;
  quick_replies?: QuickReply[];
  pending_action_set?: boolean;
}

interface Ctx {
  session: BotSession;
  message: string;
  mcp: TodoErpMcpClient;
}

function getMode(s: BotSession): 'unset' | 'general' | 'patient' {
  return ((s.extracted_slots as any)?.mode as any) || 'unset';
}
function setSlot(s: BotSession, key: string, value: unknown) {
  s.extracted_slots = { ...(s.extracted_slots || {}), [key]: value };
}
function clearSlot(s: BotSession, key: string) {
  const slots = { ...(s.extracted_slots || {}) };
  delete slots[key];
  s.extracted_slots = slots;
}

function appendAndSave(s: BotSession, userMsg: string, botMsg: string, mcp: TodoErpMcpClient) {
  s.turns = [
    ...s.turns,
    { role: 'user', content: userMsg },
    { role: 'assistant', content: botMsg },
  ];
  return saveSession(mcp, s);
}

/**
 * Returns a response if the V1 flow handled the turn, else null.
 */
export async function handleV1Flow(ctx: Ctx): Promise<FlowResponse | null> {
  const { session, mcp } = ctx;
  const message = ctx.message;
  const trimmed = message.trim();
  const mode = getMode(session);

  // ── mode setters (work in any state) ─────────────────────────────
  if (/^\s*\/?\s*(general|consulta\s+general)\s*$/i.test(trimmed)) {
    setSlot(session, 'mode', 'general');
    clearSlot(session, 'form_state');
    const text = 'Modo consulta general. ¿En qué te ayudo?';
    await appendAndSave(session, message, text, mcp);
    return { text };
  }

  if (mode === 'unset' && /^\s*\/?\s*(paciente|atenci[oó]n)\s*$/i.test(trimmed)) {
    setSlot(session, 'mode', 'patient');
    const text = 'Buscar paciente por cédula o nombre, o crea uno nuevo.';
    await appendAndSave(session, message, text, mcp);
    return {
      text,
      quick_replies: [{ label: '+ Nuevo paciente', send: 'nuevo paciente' }],
    };
  }

  // ── unset mode: the frontend hardcodes the mode question + buttons in
  //    the welcome screen, so we don't ask it from the bot. We assume
  //    "general" by default and fall through to the rest of the pipeline.
  if (mode === 'unset') {
    setSlot(session, 'mode', 'general');
  }

  // ── patient mode without active patient: search / new flow ───────
  if (mode === 'patient' && !session.active_patient_id) {
    const fs = (session.extracted_slots as any)?.form_state as
      | { kind: 'new_patient'; cedula?: string; nombre?: string }
      | undefined;

    // Step-form: new patient
    if (fs?.kind === 'new_patient') {
      if (!fs.cedula) {
        fs.cedula = trimmed;
        setSlot(session, 'form_state', fs);
        const text = `Cédula: ${fs.cedula}\nNombre completo:`;
        await appendAndSave(session, message, text, mcp);
        return { text };
      }
      if (!fs.nombre) {
        fs.nombre = trimmed;
        setSlot(session, 'form_state', fs);
        // Stage confirmation
        session.pending_action = {
          summary: `Crear paciente ${fs.nombre} (cédula ${fs.cedula})`,
          tool: 'entities.create',
          args: {
            record_type: 'business',
            entity_id: PATIENT_ENTITY_ID,
            title: `paciente_${fs.cedula}`,
            data: { cedula: fs.cedula, nombre: fs.nombre },
          },
          successMessage: `Paciente creado (id: {{id}}). Lo activo.`,
          createdAt: new Date().toISOString(),
        };
        clearSlot(session, 'form_state');
        const text =
          `Crear paciente:\n  • Cédula: ${fs.cedula}\n  • Nombre: ${fs.nombre}\n\n¿Confirmas?`;
        await appendAndSave(session, message, text, mcp);
        return {
          text,
          pending_action_set: true,
          quick_replies: [
            { label: '✓ Confirmar', send: 'sí' },
            { label: '✗ Cancelar', send: 'no' },
          ],
        };
      }
    }

    // Trigger new-patient form
    if (/^\s*\/?\s*(nuevo|nuevo\s+paciente|crear\s+paciente)\s*$/i.test(trimmed)) {
      setSlot(session, 'form_state', { kind: 'new_patient' });
      const text = 'Nuevo paciente.\nCédula:';
      await appendAndSave(session, message, text, mcp);
      return { text };
    }

    // Otherwise: search
    const r = await mcp.call('entities.list', {
      type: PATIENT_ENTITY_ID,
      search: trimmed,
      limit: 5,
    });
    const list = Array.isArray(r.data) ? r.data : [];
    if (list.length === 0) {
      const text = `Sin coincidencias para "${trimmed}".`;
      await appendAndSave(session, message, text, mcp);
      return {
        text,
        quick_replies: [
          { label: '+ Nuevo paciente', send: 'nuevo paciente' },
          { label: 'Reintentar', send: '' },
        ].filter(q => q.send !== '') as QuickReply[],
      };
    }
    const lines = list.map((p: any, i: number) => {
      const d = p.data || {};
      const name = [d.nombre, d.apellidos].filter(Boolean).join(' ') || p.title || '(sin nombre)';
      const ced = d.cedula ? ` · ${d.cedula}` : '';
      return `${i + 1}. ${name}${ced}`;
    });
    const text = `Resultados:\n${lines.join('\n')}\nElegí uno o "nuevo paciente".`;
    await appendAndSave(session, message, text, mcp);
    return {
      text,
      quick_replies: [
        ...list.map((p: any) => {
          const d = p.data || {};
          const name = [d.nombre, d.apellidos].filter(Boolean).join(' ') || p.title || p.id.slice(0, 8);
          return { label: name, send: `activar paciente ${p.id}` };
        }),
        { label: '+ Nuevo paciente', send: 'nuevo paciente' },
      ],
    };
  }

  return null;
}
