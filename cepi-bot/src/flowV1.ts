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
  /** Omitted for decorative `heading` fields. */
  key?: string;
  label: string;
  type?: 'text' | 'textarea' | 'checkbox' | 'radio' | 'heading' | 'entity_search';
  placeholder?: string;
  required?: boolean;
  /** `radio` only — the available choices. */
  options?: Array<string | { label: string; value: string | number | boolean }>;
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
  /**
   * 'structured' — the form posts a { form_id, data } payload (ficha sections).
   * Default (unset) — interpolates `submit_send` into a plain chat message.
   */
  submit_mode?: 'message' | 'structured';
  actions?: BotFormAction[];
}

export interface FlowResponse {
  text: string;
  quick_replies?: QuickReply[];
  /** present (form or null) ⇒ change the persisted active form; absent ⇒ keep it. */
  form?: BotForm | null;
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
    { key: 'nombre', label: 'Nombres', placeholder: 'Ej: Juan', required: true },
    { key: 'apellidos', label: 'Apellidos', placeholder: 'Ej: Pérez', required: true },
  ],
  submit_label: 'Crear paciente',
  submit_send: '/nuevo-paciente {cedula} || {nombre} || {apellidos}',
};

// ── Ficha clínica (docs/ficha.html) — episode sections §3..§7 ──────────────
// Each section is a structured BotForm; submitting it updates the episode.
export type FichaSection = 's3' | 's4' | 's6' | 's7';
export const FICHA_ORDER: FichaSection[] = ['s3', 's4', 's6', 's7'];
export const FICHA_FIRST_SECTION: FichaSection = 's3';

function nextFichaSection(s: FichaSection): FichaSection | null {
  const i = FICHA_ORDER.indexOf(s);
  return i >= 0 && i < FICHA_ORDER.length - 1 ? FICHA_ORDER[i + 1] : null;
}

const FICHA_SKIP: BotFormAction = { label: 'Omitir sección', send: 'omitir seccion' };

// Closed yes/no question rendered as a single radio (not an ambiguous checkbox).
const SI_NO: Array<{ label: string; value: boolean }> = [
  { label: 'Sí', value: true },
  { label: 'No', value: false },
];

const FICHA_FORMS: Record<FichaSection, BotForm> = {
  s3: {
    id: 'ficha_s3',
    title: '§3 Anamnesis',
    submit_mode: 'structured',
    submit_label: 'Guardar y seguir',
    actions: [FICHA_SKIP],
    fields: [
      { key: 'motivo_consulta', label: 'Motivo de consulta', type: 'textarea' },
      { key: 'tiempo_evolucion', label: 'Tiempo de evolución', type: 'text', placeholder: 'días, semanas, meses, años' },
      { key: 'curso', label: 'Curso', type: 'radio', options: ['progresivo', 'regresivo', 'continuo', 'intermitente'] },
      { key: 'sintomas_presente', label: '¿Presenta síntomas?', type: 'radio', options: SI_NO },
      { key: 'picor', label: 'Picor (+)', type: 'text' },
      { key: 'dolor', label: 'Dolor (+)', type: 'text' },
      { key: 'causa_aparente_presente', label: '¿Causa aparente?', type: 'radio', options: SI_NO },
      { key: 'causa_aparente', label: 'Detalle causa aparente', type: 'text' },
      { key: 'patologia_asociada_presente', label: '¿Patología asociada / RAS?', type: 'radio', options: SI_NO },
      { key: 'patologia_asociada', label: 'Detalle patología asociada', type: 'text' },
      { key: 'tratamientos_previos_presente', label: '¿Tratamientos previos?', type: 'radio', options: SI_NO },
      { key: 'tratamientos_previos', label: 'Detalle tratamientos previos', type: 'text' },
      { key: 'anamnesis', label: 'Anamnesis (notas)', type: 'textarea' },
    ],
  },
  s4: {
    id: 'ficha_s4',
    title: '§4 Examen físico',
    submit_mode: 'structured',
    submit_label: 'Guardar y seguir',
    actions: [FICHA_SKIP],
    fields: [
      { type: 'heading', label: '4.1 Lesión elemental' },
      { key: 'lesion_macula', label: 'Mácula', type: 'checkbox' },
      { key: 'lesion_papula', label: 'Pápula', type: 'checkbox' },
      { key: 'lesion_placa', label: 'Placa', type: 'checkbox' },
      { key: 'lesion_vesicula', label: 'Vesícula', type: 'checkbox' },
      { key: 'lesion_ampolla', label: 'Ampolla', type: 'checkbox' },
      { key: 'lesion_tumor', label: 'Tumor', type: 'checkbox' },
      { key: 'lesion_nodulo', label: 'Nódulo', type: 'checkbox' },
      { key: 'lesion_ulcera', label: 'Úlcera', type: 'checkbox' },
      { key: 'lesion_otra', label: 'Otra lesión', type: 'text' },
      { type: 'heading', label: '4.2 Características individuales (+)' },
      { key: 'caract_eritema', label: 'Eritema', type: 'text' },
      { key: 'caract_descamacion', label: 'Descamación', type: 'text' },
      { key: 'caract_exudacion', label: 'Exudación', type: 'text' },
      { key: 'caract_liquenificacion', label: 'Liquenificación', type: 'text' },
      { key: 'caract_otra', label: 'Otra característica', type: 'text' },
      { type: 'heading', label: '4.3 Características topográficas' },
      { key: 'topo_unica', label: 'Única', type: 'checkbox' },
      { key: 'topo_multiples', label: 'Múltiples', type: 'checkbox' },
      { key: 'topo_bilateral', label: 'Bilateral', type: 'checkbox' },
      { key: 'topo_simetrico', label: 'Simétrico', type: 'checkbox' },
      { key: 'topo_confluente', label: 'Confluente', type: 'checkbox' },
      { key: 'topo_agrupadas', label: 'Agrupadas', type: 'checkbox' },
      { key: 'topo_circular', label: 'Circular', type: 'checkbox' },
      { key: 'topo_lineal', label: 'Lineal', type: 'checkbox' },
      { key: 'topo_borde', label: 'Borde', type: 'checkbox' },
      { key: 'topo_otra', label: 'Otra topografía', type: 'text' },
      { type: 'heading', label: '4.4 Gravedad (0–3)' },
      { key: 'gravedad_extension', label: 'Extensión', type: 'radio', options: ['0', '1', '2', '3'] },
      { key: 'gravedad_intensidad', label: 'Intensidad', type: 'radio', options: ['0', '1', '2', '3'] },
      { key: 'gravedad_funcionalidad', label: 'Funcionalidad', type: 'radio', options: ['0', '1', '2', '3'] },
      { type: 'heading', label: '4.5 Patrón' },
      { key: 'patron_inflam_epidermica', label: 'Inflamación epidérmica', type: 'checkbox' },
      { key: 'patron_inflam_dermica', label: 'Inflamación dérmica', type: 'checkbox' },
      { key: 'patron_necrosis', label: 'Necrosis', type: 'checkbox' },
      { key: 'patron_tumor', label: 'Tumor', type: 'checkbox' },
      { key: 'patron_color', label: 'Color', type: 'checkbox' },
      { key: 'notas_examen', label: 'Notas del examen', type: 'textarea' },
    ],
  },
  s6: {
    id: 'ficha_s6',
    title: '§6 Estudios complementarios',
    submit_mode: 'structured',
    submit_label: 'Guardar y seguir',
    actions: [FICHA_SKIP],
    fields: [
      { key: 'estudios_complementarios_presente', label: '¿Tiene estudios complementarios?', type: 'radio', options: SI_NO },
      { key: 'estudios_complementarios_resumen', label: 'Resumen de estudios', type: 'textarea' },
    ],
  },
  s7: {
    id: 'ficha_s7',
    title: '§7 Tratamiento y plan',
    submit_mode: 'structured',
    submit_label: 'Finalizar consulta',
    actions: [FICHA_SKIP],
    fields: [
      { key: 'tratamiento_resumen', label: 'Tratamiento', type: 'textarea' },
      { key: 'plan', label: 'Plan', type: 'textarea' },
      { key: 'proximo_control_fecha', label: 'Próximo control', type: 'text', placeholder: 'YYYY-MM-DD' },
      { key: 'proximo_control_motivo', label: 'Motivo del próximo control', type: 'text' },
    ],
  },
};

/** The BotForm for a ficha section (used by server.ts and the flow). */
export function fichaSectionForm(section: FichaSection): BotForm {
  return FICHA_FORMS[section];
}

// Key routing for a full-ficha "Guardar": §1–§2 → paciente, §3–§7 → episodio.
// Identity fields (nombre/apellidos/cedula) are intentionally excluded.
const FICHA_PATIENT_KEYS = new Set<string>([
  'direccion', 'telefono', 'sector_ciudad', 'ocupacion', 'email', 'edad',
  'sexo', 'etnia', 'etnia_otra', 'escolaridad_anios', 'escolaridad_grado',
  'condicion_socioeconomica', 'antecedentes_personales',
  'antecedentes_personales_presente', 'antecedentes_familiares',
  'antecedentes_familiares_presente',
]);
const FICHA_EPISODE_KEYS = new Set<string>([
  ...FICHA_ORDER.flatMap(s =>
    FICHA_FORMS[s].fields.map(f => f.key).filter((k): k is string => !!k)),
  'ficha_num', 'examinador_nombre', 'diagnostico', 'diagnostico_letra',
  'regiones_afectadas',
]);

/** Traffic-light label for a §5 diagnosis letter. */
const DX_COLOR: Record<string, string> = { A: 'verde', B: 'amarillo', C: 'rojo' };

/** A structured form submission from the frontend (ficha sections). */
export interface FormSubmission {
  form_id: string;
  data: Record<string, unknown>;
  /** ficha_save only — the episode being saved (paginator may differ from active). */
  episode_id?: string;
}

interface Ctx {
  session: BotSession;
  message: string;
  mcp: TodoErpMcpClient;
  formSubmission?: FormSubmission;
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

  // ── Ficha clínica "Guardar" — full ficha edited in the modal viewer ──
  // Routes §1–§2 keys to the patient and §3–§7 keys to the active episode,
  // then refreshes the patient context held in the session.
  if (ctx.formSubmission?.form_id === 'ficha_save') {
    const data = (ctx.formSubmission.data || {}) as Record<string, unknown>;
    const patientData: Record<string, unknown> = {};
    const episodeData: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (FICHA_PATIENT_KEYS.has(k)) patientData[k] = v;
      else if (FICHA_EPISODE_KEYS.has(k)) episodeData[k] = v;
    }
    const epId = ctx.formSubmission.episode_id || session.active_episode_id;
    const errs: string[] = [];
    if (session.active_patient_id && Object.keys(patientData).length) {
      const r = await mcp.call('entities.update', {
        id: session.active_patient_id, record_type: 'business', data: patientData,
      });
      if (!(r as any)?.ok) errs.push(`paciente: ${(r as any)?.error || 'error'}`);
    }
    if (epId && Object.keys(episodeData).length) {
      const r = await mcp.call('entities.update', {
        id: epId, record_type: 'business', data: episodeData,
      });
      if (!(r as any)?.ok) errs.push(`episodio: ${(r as any)?.error || 'error'}`);
    }
    // Refresh the patient context the session carries for the bot.
    if (session.active_patient_id) {
      try {
        const pr = await mcp.call('entities.get', { id: session.active_patient_id });
        const pd = ((pr as any)?.data?.data) || {};
        setSlot(session, 'patient_context', { id: session.active_patient_id, ...pd });
      } catch { /* keep prior context */ }
    }
    const text = errs.length
      ? `Guardé la ficha con observaciones — ${errs.join('; ')}.`
      : 'Ficha guardada. Los cambios quedaron en el paciente y el episodio.';
    await appendAndSave(session, '📋 Ficha guardada', text, mcp);
    return { text };
  }

  // ── §5 Diagnóstico traffic-light — set A/B/C on the active episode ──
  if (ctx.formSubmission?.form_id === 'set_diagnostico') {
    const letra = String(ctx.formSubmission.data?.diagnostico_letra || '').toUpperCase();
    const epId = ctx.formSubmission.episode_id || session.active_episode_id;
    if (!['A', 'B', 'C'].includes(letra) || !epId) {
      const text = 'No pude registrar el diagnóstico (falta letra o episodio).';
      await appendAndSave(session, 'Diagnóstico', text, mcp);
      return { text };
    }
    const r = await mcp.call('entities.update', {
      id: epId, record_type: 'business', data: { diagnostico_letra: letra },
    });
    const text = (r as any)?.ok
      ? `Diagnóstico del episodio: ${letra} (${DX_COLOR[letra]}).`
      : `No pude registrar el diagnóstico: ${(r as any)?.error || 'error'}.`;
    await appendAndSave(session, `Diagnóstico: ${letra}`, text, mcp);
    return { text };
  }

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
    // New-patient form submission: "/nuevo-paciente <cedula> || <nombre> || <apellidos>".
    const npm = trimmed.match(
      /^\/?\s*nuevo-paciente\s+([\s\S]+?)\s*\|\|\s*([\s\S]+?)\s*\|\|\s*([\s\S]+)$/i,
    );
    if (npm) {
      const cedula = npm[1].trim();
      const nombre = npm[2].trim();
      const apellidos = npm[3].trim();
      if (!cedula || !nombre || !apellidos) {
        const text = 'Faltan datos: cédula, nombres y apellidos son obligatorios.';
        await appendAndSave(session, message, text, mcp);
        return { text, form: PATIENT_NEW_FORM };
      }
      // On confirmation the server auto-activates the patient and, in
      // atención mode, opens a new episode + the ficha clínica (§3 form).
      const isAttention = mode === 'patient';
      session.pending_action = {
        summary: `Crear paciente ${nombre} ${apellidos} (cédula ${cedula})`,
        tool: 'entities.create',
        args: {
          record_type: 'business',
          entity_id: PATIENT_ENTITY_ID,
          title: `paciente_${cedula}`,
          data: { cedula, nombre, apellidos },
        },
        successMessage: isAttention
          ? `Listo, ${nombre} ${apellidos} quedó registrado. Abrimos la consulta — empecemos la ficha clínica:`
          : `Listo, ${nombre} ${apellidos} quedó registrado y es el paciente activo.`,
        createdAt: new Date().toISOString(),
      };
      const userMsg = `Nuevo paciente: ${nombre} ${apellidos} · ${cedula}`;
      const text =
        `Crear paciente:\n  • Cédula: ${cedula}\n  • Nombres: ${nombre}\n` +
        `  • Apellidos: ${apellidos}\n\n¿Confirmas?`;
      await appendAndSave(session, userMsg, text, mcp);
      // The confirmation card already carries ✓/✗ — no duplicate quick replies.
      return { text, pending_action_set: true };
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

  // ── patient mode WITH active patient: ficha clínica section flow ──
  // After the patient is activated and an episode opened (server.ts), the bot
  // walks the ficha section by section. Each section is a structured BotForm;
  // submitting it merges the data into the episode via entities.update.
  if (mode === 'patient' && session.active_patient_id) {
    const fs = (session.extracted_slots as any)?.form_state as
      | { kind: 'ficha'; section: FichaSection }
      | undefined;

    if (fs?.kind === 'ficha') {
      const section: FichaSection = fs.section || 's3';
      const sub = ctx.formSubmission;
      const isSubmit = !!sub && typeof sub.form_id === 'string'
        && sub.form_id.startsWith('ficha_s');
      const isSkip = /^\s*\/?\s*omitir(\s+secci[oó]n)?\s*$/i.test(trimmed);

      if (isSubmit || isSkip) {
        const title = FICHA_FORMS[section].title;
        const userMsg = isSkip ? 'Omitir sección' : `📋 ${title} enviada`;
        let savedNote = `${title} omitida.`;

        if (isSubmit && session.active_episode_id) {
          const data: Record<string, unknown> = { ...(sub!.data || {}) };
          // §4 — gravedad fields are numeric; radio values arrive as strings.
          if (section === 's4') {
            const gKeys = ['gravedad_extension', 'gravedad_intensidad', 'gravedad_funcionalidad'];
            for (const k of gKeys) {
              if (data[k] != null && data[k] !== '') data[k] = Number(data[k]);
            }
            if (gKeys.some(k => data[k] != null)) {
              data.gravedad_total = gKeys.reduce((a, k) => a + (Number(data[k]) || 0), 0);
            }
          }
          if (Object.keys(data).length) {
            const upd = await mcp.call('entities.update', {
              id: session.active_episode_id,
              record_type: 'business',
              data,
            });
            if (!(upd as any)?.ok) {
              const text = `No pude guardar ${title}: ${(upd as any)?.error || 'error desconocido'}.\n` +
                `Revisá los datos y volvé a enviar.`;
              await appendAndSave(session, userMsg, text, mcp);
              return { text, form: FICHA_FORMS[section] };
            }
          }
          savedNote = `${title} guardada.`;
        }

        const next = nextFichaSection(section);
        if (next) {
          setSlot(session, 'form_state', { kind: 'ficha', section: next });
          const text = `${savedNote} Continuemos con ${FICHA_FORMS[next].title}.`;
          await appendAndSave(session, userMsg, text, mcp);
          return { text, form: FICHA_FORMS[next] };
        }
        clearSlot(session, 'form_state');
        const text = `${savedNote}\n\nLa ficha de la consulta quedó registrada. ¿Algo más?`;
        await appendAndSave(session, userMsg, text, mcp);
        return { text, form: null };   // ficha done — clear the persisted form
      }

      // Free text while a ficha section is open — re-show the current section.
      const text = `Completá la sección ${FICHA_FORMS[section].title}, o tocá "Omitir sección".`;
      await appendAndSave(session, message, text, mcp);
      return { text, form: FICHA_FORMS[section] };
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
