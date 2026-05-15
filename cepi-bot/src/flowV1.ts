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
const EPISODE_ENTITY_ID = '12000000-0000-0000-0000-000000000000';

export interface QuickReply { label: string; send: string; }

/** A field of a bot-rendered form. */
export interface BotFormField {
  key: string;
  label: string;
  type?: 'text' | 'entity_search';
  placeholder?: string;
  required?: boolean;
  // `entity_search` only — live autocomplete against /api/entities:
  entity_id?: string;
  min_chars?: number;
  page_size?: number;
  /** Message template sent when an option is picked ({id}, {field}…). */
  on_select_send?: string;
  /** data fields joined to build each option's primary label. */
  result_label?: string[];
  /** data field shown as each option's secondary line. */
  result_sub?: string;
}

/** A secondary action button shown alongside a form's submit button. */
export interface BotFormAction { label: string; send: string; }

/**
 * A form the bot asks the frontend to render inline in the chat.
 * On submit, the frontend interpolates field values into `submit_send`
 * ({key} placeholders) and sends the result as a normal chat message —
 * so no special server-side submission handler is needed.
 */
export interface BotForm {
  id: string;
  title: string;
  fields: BotFormField[];
  submit_label?: string;
  /** When set, a submit button interpolates field values into this template. */
  submit_send?: string;
  actions?: BotFormAction[];
}

export interface FlowResponse {
  text: string;
  quick_replies?: QuickReply[];
  form?: BotForm;
  pending_action_set?: boolean;
}

/**
 * Patient search form: a live autocomplete dropdown. Typing ≥3 chars queries
 * patients by cédula or nombre; picking an option activates that patient.
 */
const PATIENT_SEARCH_FORM: BotForm = {
  id: 'patient_search',
  title: 'Buscar paciente',
  fields: [
    {
      key: 'patient',
      label: 'Cédula o nombre',
      type: 'entity_search',
      entity_id: PATIENT_ENTITY_ID,
      min_chars: 3,
      page_size: 20,
      placeholder: 'Escribí al menos 3 caracteres…',
      on_select_send: 'activar paciente {id}',
      result_label: ['nombre', 'apellidos'],
      result_sub: 'cedula',
    },
  ],
  actions: [{ label: '+ Nuevo paciente', send: 'nuevo paciente' }],
};

/**
 * New-patient form: two required fields submitted in a single turn.
 * The frontend interpolates the values into the `/nuevo-paciente` command
 * (the `||` separator keeps cédula and nombre unambiguous).
 */
const PATIENT_NEW_FORM: BotForm = {
  id: 'patient_new',
  title: 'Nuevo paciente',
  fields: [
    { key: 'cedula', label: 'Cédula', placeholder: 'Ej: 12345678', required: true },
    { key: 'nombre', label: 'Nombre completo', placeholder: 'Ej: Juan Pérez', required: true },
  ],
  submit_label: 'Crear paciente',
  submit_send: '/nuevo-paciente {cedula} || {nombre}',
};

interface Ctx {
  session: BotSession;
  message: string;
  mcp: TodoErpMcpClient;
}

type FlowMode = 'unset' | 'general' | 'patient' | 'patient_info';
function getMode(s: BotSession): FlowMode {
  return ((s.extracted_slots as any)?.mode as FlowMode) || 'unset';
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

  if (mode === 'unset' && /^\s*\/?\s*(informaci[oó]n\s+paciente|info\s+paciente)\s*$/i.test(trimmed)) {
    setSlot(session, 'mode', 'patient_info');
    const text = 'Información de paciente (consulta no presencial). Buscá el paciente.';
    await appendAndSave(session, message, text, mcp);
    return { text, form: PATIENT_SEARCH_FORM };
  }

  if (mode === 'unset' && /^\s*\/?\s*(paciente|atenci[oó]n)\s*$/i.test(trimmed)) {
    setSlot(session, 'mode', 'patient');
    const text = 'Buscar paciente por cédula o nombre, o crea uno nuevo.';
    await appendAndSave(session, message, text, mcp);
    return { text, form: PATIENT_SEARCH_FORM };
  }

  // ── unset mode: the frontend hardcodes the mode question + buttons in
  //    the welcome screen, so we don't ask it from the bot. We assume
  //    "general" by default and fall through to the rest of the pipeline.
  if (mode === 'unset') {
    setSlot(session, 'mode', 'general');
  }

  // ── patient / patient_info mode without active patient: search/new ───────
  if ((mode === 'patient' || mode === 'patient_info') && !session.active_patient_id) {
    // New-patient form submission: "/nuevo-paciente <cedula> || <nombre>".
    const npm = trimmed.match(
      /^\/?\s*nuevo-paciente\s+([\s\S]+?)\s*\|\|\s*([\s\S]+)$/i,
    );
    if (npm) {
      const cedula = npm[1].trim();
      const nombre = npm[2].trim();
      if (!cedula || !nombre) {
        const text = 'Faltan datos: cédula y nombre son obligatorios.';
        await appendAndSave(session, message, text, mcp);
        return { text, form: PATIENT_NEW_FORM };
      }
      session.pending_action = {
        summary: `Crear paciente ${nombre} (cédula ${cedula})`,
        tool: 'entities.create',
        args: {
          record_type: 'business',
          entity_id: PATIENT_ENTITY_ID,
          title: `paciente_${cedula}`,
          data: { cedula, nombre },
        },
        successMessage: `Paciente creado (id: {{id}}). Lo activo.`,
        createdAt: new Date().toISOString(),
      };
      const userMsg = `Nuevo paciente: ${nombre} · ${cedula}`;
      const text =
        `Crear paciente:\n  • Cédula: ${cedula}\n  • Nombre: ${nombre}\n\n¿Confirmas?`;
      await appendAndSave(session, userMsg, text, mcp);
      return {
        text,
        pending_action_set: true,
        quick_replies: [
          { label: '✓ Confirmar', send: 'sí' },
          { label: '✗ Cancelar', send: 'no' },
        ],
      };
    }

    // Trigger new-patient form
    if (/^\s*\/?\s*(nuevo|nuevo\s+paciente|crear\s+paciente)\s*$/i.test(trimmed)) {
      const text = 'Completá los datos del nuevo paciente.';
      await appendAndSave(session, message, text, mcp);
      return { text, form: PATIENT_NEW_FORM };
    }

    // Otherwise: search
    const r = await mcp.call('entities.list', {
      type: PATIENT_ENTITY_ID,
      search: trimmed,
      limit: 5,
    });
    const list = Array.isArray(r.data) ? r.data : [];
    if (list.length === 0) {
      const text = `Sin coincidencias para "${trimmed}". Probá de nuevo o crea uno.`;
      await appendAndSave(session, message, text, mcp);
      return { text, form: PATIENT_SEARCH_FORM };
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

  // ── patient mode WITH active patient, no episode: guided episode intake ──
  // After a patient is activated (server.ts), the bot keeps the conversation
  // going: it collects the episode fields one question at a time and stages
  // the creation behind the confirmation gate.
  if (mode === 'patient' && session.active_patient_id && !session.active_episode_id) {
    const fs = (session.extracted_slots as any)?.form_state as
      | { kind: 'episode'; motivo?: string; tipo?: string }
      | undefined;

    if (fs?.kind === 'episode') {
      // Step 1 — motivo de consulta (what's wrong with the patient).
      if (!fs.motivo) {
        fs.motivo = trimmed;
        setSlot(session, 'form_state', fs);
        const text = `Motivo: ${fs.motivo}\n¿Tipo de consulta?`;
        await appendAndSave(session, message, text, mcp);
        return {
          text,
          quick_replies: [
            { label: 'Presencial', send: 'presencial' },
            { label: 'Virtual', send: 'virtual' },
          ],
        };
      }
      // Step 2 — tipo, then stage the episode behind the confirmation gate.
      if (!fs.tipo) {
        const tipo = /virtual/i.test(trimmed) ? 'virtual' : 'presencial';
        const today = new Date().toISOString().slice(0, 10);
        let medicoId: string | null = null;
        try {
          const me = await mcp.call('auth.whoami', {});
          medicoId = ((me as any)?.data?.user?.id as string) || null;
        } catch { /* leave null */ }
        session.pending_action = {
          summary: `Crear episodio para el paciente activo (motivo: ${fs.motivo})`,
          tool: 'entities.create',
          args: {
            record_type: 'business',
            entity_id: EPISODE_ENTITY_ID,
            title: `episode_${today}`,
            data: {
              [`${PATIENT_ENTITY_ID}:patient_id`]: session.active_patient_id,
              medico_id: medicoId,
              fecha: today,
              tipo,
              motivo_consulta: fs.motivo,
              estado: 'en_curso',
            },
          },
          successMessage: `Episodio creado (id: {{id}}). Lo activo automáticamente.`,
          createdAt: new Date().toISOString(),
        };
        clearSlot(session, 'form_state');
        const text =
          `Voy a crear el episodio:\n` +
          `  • motivo: ${fs.motivo}\n` +
          `  • tipo: ${tipo}\n` +
          `  • fecha: ${today}\n\n` +
          `¿Confirmas?`;
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
  }

  // ── patient_info mode WITH active patient: answer questions about the
  // patient deterministically (no LLM, no command suggestions exposed). ──
  if (mode === 'patient_info' && session.active_patient_id) {
    const t = trimmed.toLowerCase();
    const pid = session.active_patient_id;
    const ctx = ((session.extracted_slots as any)?.patient_context || {}) as Record<string, any>;
    const nombre = [ctx.nombre, ctx.apellidos].filter(Boolean).join(' ') || 'el paciente';

    // Intent — prior consultations / clinical history.
    if (/consulta|atend|episodi|historial|visit|anterior|previo|antes|vino|vez/.test(t)) {
      let eps: any[] = [];
      try {
        const er = await mcp.call('entities.list', {
          type: EPISODE_ENTITY_ID, search: pid, limit: 50,
        });
        eps = Array.isArray((er as any)?.data) ? (er as any).data : [];
      } catch { /* treat as none */ }
      if (!eps.length) {
        const text = `${nombre} no tiene consultas registradas previamente.`;
        await appendAndSave(session, message, text, mcp);
        return { text };
      }
      eps.sort((a, b) =>
        String(b?.data?.fecha || '').localeCompare(String(a?.data?.fecha || '')));
      const lines = eps.slice(0, 10).map((e: any) => {
        const d = e.data || {};
        return `• ${d.fecha || 's/f'} — ${d.motivo_consulta || '(sin motivo)'}` +
          (d.estado ? ` [${d.estado}]` : '');
      });
      const text =
        `Sí, ${nombre} tiene ${eps.length} consulta(s) registrada(s):\n${lines.join('\n')}`;
      await appendAndSave(session, message, text, mcp);
      return { text };
    }

    // Intent — patient demographics / contact data.
    if (/dato|info|edad|sexo|sangre|c[eé]dula|tel[eé]fono|tel\b|direcci|email|correo|naci|qui[eé]n/.test(t)) {
      const edad = (() => {
        const dob = ctx.fecha_nac;
        if (!dob) return null;
        const d = new Date(dob);
        if (isNaN(d.getTime())) return null;
        const now = new Date();
        let a = now.getFullYear() - d.getFullYear();
        const m = now.getMonth() - d.getMonth();
        if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a--;
        return a >= 0 && a < 150 ? a : null;
      })();
      const rows = [
        ['Nombre', [ctx.nombre, ctx.apellidos].filter(Boolean).join(' ')],
        ['Edad', edad != null ? `${edad} años` : null],
        ['Sexo', ctx.sexo],
        ['Cédula', ctx.cedula],
        ['Grupo sanguíneo', ctx.tipo_sangre],
        ['Teléfono', ctx.telefono],
        ['Email', ctx.email],
        ['Dirección', ctx.direccion],
      ].filter(([, v]) => v) as [string, string][];
      const text = `Datos de ${nombre}:\n` +
        rows.map(([k, v]) => `  • ${k}: ${v}`).join('\n');
      await appendAndSave(session, message, text, mcp);
      return { text };
    }

    // Fallback — stay conversational, never surface internal commands.
    const text =
      `En modo información puedo contarte el historial de consultas de ${nombre} ` +
      `o sus datos (edad, contacto, etc.). ¿Qué necesitás saber?`;
    await appendAndSave(session, message, text, mcp);
    return { text };
  }

  return null;
}
