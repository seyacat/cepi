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
  type?: 'text' | 'textarea' | 'checkbox' | 'radio' | 'heading' | 'entity_search' | 'icd_search' | 'date';
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
  /** Pre-filled field values, keyed by field key. */
  values?: Record<string, unknown>;
}

export interface FlowResponse {
  text: string;
  quick_replies?: QuickReply[];
  /** present (form or null) ⇒ change the persisted active form; absent ⇒ keep it. */
  form?: BotForm | null;
  pending_action_set?: boolean;
  bookmarks?: FichaBookmark[];
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

// ── Ficha clínica (docs/ficha.html) — campos agrupados ─────────────────────
// La ficha se recorre como grupos atómicos: un formulario por grupo, y cada
// grupo es un "bookmark" en el riel lateral del chat.

// Closed yes/no question rendered as a single radio (not an ambiguous checkbox).
const SI_NO: Array<{ label: string; value: boolean }> = [
  { label: 'Sí', value: true },
  { label: 'No', value: false },
];

export interface FichaGroup {
  id: string;
  label: string;
  category: string;
  target: 'patient' | 'episode';
  fields: BotFormField[];
}

interface FichaFieldDef {
  category: string;
  target: 'patient' | 'episode';
  field: BotFormField;
}

// Todos los campos de la ficha, en orden — un bookmark / un formulario
// atómico por campo (una pregunta por formulario), agrupados por categoría.
const FICHA_FIELD_DEFS: FichaFieldDef[] = [
  // §1 Filiación (paciente)
  { category: 'Filiación', target: 'patient', field: { key: 'direccion', label: 'Dirección', type: 'text' } },
  { category: 'Filiación', target: 'patient', field: { key: 'telefono', label: 'Teléfono', type: 'text' } },
  { category: 'Filiación', target: 'patient', field: { key: 'sector_ciudad', label: 'Sector / Ciudad', type: 'text' } },
  { category: 'Filiación', target: 'patient', field: { key: 'ocupacion', label: 'Ocupación', type: 'text' } },
  { category: 'Filiación', target: 'patient', field: { key: 'email', label: 'Correo', type: 'text' } },
  { category: 'Filiación', target: 'patient', field: { key: 'fecha_nac', label: 'Fecha de nacimiento', type: 'date' } },
  { category: 'Filiación', target: 'patient', field: { key: 'sexo', label: 'Sexo', type: 'radio', options: ['M', 'F', 'Otro'] } },
  { category: 'Filiación', target: 'patient', field: { key: 'etnia', label: 'Etnia', type: 'radio', options: ['mestiza', 'blanco', 'afro', 'otra'] } },
  { category: 'Filiación', target: 'patient', field: { key: 'escolaridad_grado', label: 'Escolaridad', type: 'radio', options: ['ninguna', 'básico', 'superior', 'tercer nivel', 'cuarto nivel'] } },
  { category: 'Filiación', target: 'patient', field: { key: 'condicion_socioeconomica', label: 'Condición socioeconómica', type: 'radio', options: ['alto', 'medio', 'bajo'] } },
  // §2 Antecedentes (paciente)
  { category: 'Antecedentes', target: 'patient', field: { key: 'antecedentes_personales_presente', label: '¿Antecedentes personales?', type: 'radio', options: SI_NO } },
  { category: 'Antecedentes', target: 'patient', field: { key: 'antecedentes_personales', label: 'Detalle antecedentes personales', type: 'textarea' } },
  { category: 'Antecedentes', target: 'patient', field: { key: 'antecedentes_familiares_presente', label: '¿Antecedentes familiares?', type: 'radio', options: SI_NO } },
  { category: 'Antecedentes', target: 'patient', field: { key: 'antecedentes_familiares', label: 'Detalle antecedentes familiares', type: 'textarea' } },
  // §3 Anamnesis (episodio)
  ...([
  { key: 'motivo_consulta', label: 'Motivo de consulta', type: 'textarea' },
  { key: 'tiempo_evolucion', label: 'Tiempo de evolución', type: 'text', placeholder: 'días, semanas, meses, años' },
  { key: 'curso', label: 'Curso', type: 'radio', options: ['progresivo', 'regresivo', 'continuo', 'intermitente'] },
  { key: 'sintomas_presente', label: '¿Presenta síntomas?', type: 'radio', options: SI_NO },
  { key: 'picor', label: 'Picor', type: 'radio', options: ['leve', 'moderado', 'severo'] },
  { key: 'dolor', label: 'Dolor', type: 'radio', options: ['leve', 'moderado', 'severo'] },
  { key: 'causa_aparente_presente', label: '¿Causa aparente?', type: 'radio', options: SI_NO },
  { key: 'causa_aparente', label: 'Detalle causa aparente', type: 'text' },
  { key: 'patologia_asociada_presente', label: '¿Patología asociada / RAS?', type: 'radio', options: SI_NO },
  { key: 'patologia_asociada', label: 'Detalle patología asociada', type: 'text' },
  { key: 'tratamientos_previos_presente', label: '¿Tratamientos previos?', type: 'radio', options: SI_NO },
  { key: 'tratamientos_previos', label: 'Detalle tratamientos previos', type: 'text' },
  { key: 'anamnesis', label: 'Anamnesis (notas)', type: 'textarea' },
  ] as BotFormField[]).map(field => ({ category: 'Anamnesis', target: 'episode' as const, field })),
  // §4 Examen físico (episodio)
  ...([
  // §4.1 Lesión elemental
  { key: 'lesion_macula', label: 'Lesión: Mácula', type: 'radio', options: SI_NO },
  { key: 'lesion_papula', label: 'Lesión: Pápula', type: 'radio', options: SI_NO },
  { key: 'lesion_placa', label: 'Lesión: Placa', type: 'radio', options: SI_NO },
  { key: 'lesion_vesicula', label: 'Lesión: Vesícula', type: 'radio', options: SI_NO },
  { key: 'lesion_ampolla', label: 'Lesión: Ampolla', type: 'radio', options: SI_NO },
  { key: 'lesion_tumor', label: 'Lesión: Tumor', type: 'radio', options: SI_NO },
  { key: 'lesion_nodulo', label: 'Lesión: Nódulo', type: 'radio', options: SI_NO },
  { key: 'lesion_ulcera', label: 'Lesión: Úlcera', type: 'radio', options: SI_NO },
  { key: 'lesion_otra', label: 'Lesión: Otra', type: 'text' },
  // §4.2 Características
  { key: 'caract_eritema', label: 'Caract.: Eritema', type: 'text' },
  { key: 'caract_descamacion', label: 'Caract.: Descamación', type: 'text' },
  { key: 'caract_exudacion', label: 'Caract.: Exudación', type: 'text' },
  { key: 'caract_liquenificacion', label: 'Caract.: Liquenificación', type: 'text' },
  { key: 'caract_otra', label: 'Caract.: Otra', type: 'text' },
  // §4.3 Topografía
  { key: 'topo_unica', label: 'Topo.: Única', type: 'radio', options: SI_NO },
  { key: 'topo_multiples', label: 'Topo.: Múltiples', type: 'radio', options: SI_NO },
  { key: 'topo_bilateral', label: 'Topo.: Bilateral', type: 'radio', options: SI_NO },
  { key: 'topo_simetrico', label: 'Topo.: Simétrico', type: 'radio', options: SI_NO },
  { key: 'topo_confluente', label: 'Topo.: Confluente', type: 'radio', options: SI_NO },
  { key: 'topo_agrupadas', label: 'Topo.: Agrupadas', type: 'radio', options: SI_NO },
  { key: 'topo_circular', label: 'Topo.: Circular', type: 'radio', options: SI_NO },
  { key: 'topo_lineal', label: 'Topo.: Lineal', type: 'radio', options: SI_NO },
  { key: 'topo_borde', label: 'Topo.: Borde', type: 'radio', options: SI_NO },
  { key: 'topo_otra', label: 'Topo.: Otra', type: 'text' },
  // §4.4 Gravedad
  { key: 'gravedad_extension', label: 'Gravedad: Extensión (0-3)', type: 'radio', options: ['0', '1', '2', '3'] },
  { key: 'gravedad_intensidad', label: 'Gravedad: Intensidad (0-3)', type: 'radio', options: ['0', '1', '2', '3'] },
  { key: 'gravedad_funcionalidad', label: 'Gravedad: Funcionalidad (0-3)', type: 'radio', options: ['0', '1', '2', '3'] },
  // §4.5 Patrón
  { key: 'patron_inflam_epidermica', label: 'Patrón: Inflam. epidérmica', type: 'radio', options: SI_NO },
  { key: 'patron_inflam_dermica', label: 'Patrón: Inflam. dérmica', type: 'radio', options: SI_NO },
  { key: 'patron_necrosis', label: 'Patrón: Necrosis', type: 'radio', options: SI_NO },
  { key: 'patron_tumor', label: 'Patrón: Tumor', type: 'radio', options: SI_NO },
  { key: 'patron_color', label: 'Patrón: Color', type: 'radio', options: SI_NO },
  { key: 'notas_examen', label: 'Notas del examen', type: 'textarea' },
  ] as BotFormField[]).map(field => ({ category: 'Examen físico', target: 'episode' as const, field })),
  // §5 Diagnóstico (episodio)
  ...([
  { key: 'diagnostico', label: 'Diagnóstico (ICD-11 OMS)', type: 'icd_search' },
  { key: 'diagnostico_letra', label: 'Semáforo A/B/C', type: 'radio', options: ['A', 'B', 'C'] },
  ] as BotFormField[]).map(field => ({ category: 'Diagnóstico', target: 'episode' as const, field })),
  // §6 Estudios (episodio)
  ...([
  { key: 'estudios_complementarios_presente', label: '¿Estudios complementarios?', type: 'radio', options: SI_NO },
  { key: 'estudios_complementarios_resumen', label: 'Resumen de estudios', type: 'textarea' },
  ] as BotFormField[]).map(field => ({ category: 'Estudios', target: 'episode' as const, field })),
  // §7 Tratamiento y plan (episodio)
  ...([
  { key: 'tratamiento_resumen', label: 'Tratamiento', type: 'textarea' },
  { key: 'plan', label: 'Plan', type: 'textarea' },
  { key: 'proximo_control_fecha', label: 'Próximo control', type: 'date' },
  { key: 'proximo_control_motivo', label: 'Motivo del próximo control', type: 'text' },
  ] as BotFormField[]).map(field => ({ category: 'Tratamiento', target: 'episode' as const, field })),
];

/** La ficha se agrupa por sección/subsección: un formulario por grupo. */
const byKey: Record<string, FichaFieldDef> =
  Object.fromEntries(FICHA_FIELD_DEFS.map(d => [d.field.key as string, d]));

// Un grupo = un ítem numerado de la ficha (1.1, 1.2, … 3.1, 3.2 …),
// no la sección entera. La categoría (§) sigue agrupando el riel.
const FICHA_GROUP_SPEC: { id: string; label: string; keys: string[] }[] = [
  { id: 'g_1_1', label: '1.1 Datos de contacto',     keys: ['direccion','telefono','sector_ciudad','ocupacion','email'] },
  { id: 'g_1_2', label: '1.2 Fecha de nacimiento',   keys: ['fecha_nac'] },
  { id: 'g_1_3', label: '1.3 Sexo',                  keys: ['sexo'] },
  { id: 'g_1_4', label: '1.4 Etnia',                 keys: ['etnia'] },
  { id: 'g_1_5', label: '1.5 Escolaridad',           keys: ['escolaridad_grado'] },
  { id: 'g_1_6', label: '1.6 Condición socioeconómica', keys: ['condicion_socioeconomica'] },
  { id: 'g_2_1', label: '2.1 Antecedentes personales',  keys: ['antecedentes_personales_presente','antecedentes_personales'] },
  { id: 'g_2_2', label: '2.2 Antecedentes familiares',  keys: ['antecedentes_familiares_presente','antecedentes_familiares'] },
  { id: 'g_3_1', label: '3.1 Motivo de consulta',     keys: ['motivo_consulta','anamnesis'] },
  { id: 'g_3_2', label: '3.2 Tiempo de evolución',    keys: ['tiempo_evolucion'] },
  { id: 'g_3_3', label: '3.3 Curso',                  keys: ['curso'] },
  { id: 'g_3_4', label: '3.4 Síntomas',               keys: ['sintomas_presente','picor','dolor'] },
  { id: 'g_3_5', label: '3.5 Causa aparente',         keys: ['causa_aparente_presente','causa_aparente'] },
  { id: 'g_3_6', label: '3.6 Patología asociada / RAS', keys: ['patologia_asociada_presente','patologia_asociada'] },
  { id: 'g_3_7', label: '3.7 Tratamientos previos',   keys: ['tratamientos_previos_presente','tratamientos_previos'] },
  { id: 'g_4_1', label: '4.1 Lesión elemental',       keys: ['lesion_macula','lesion_papula','lesion_placa','lesion_vesicula','lesion_ampolla','lesion_tumor','lesion_nodulo','lesion_ulcera','lesion_otra'] },
  { id: 'g_4_2', label: '4.2 Características',         keys: ['caract_eritema','caract_descamacion','caract_exudacion','caract_liquenificacion','caract_otra'] },
  { id: 'g_4_3', label: '4.3 Topografía',             keys: ['topo_unica','topo_multiples','topo_bilateral','topo_simetrico','topo_confluente','topo_agrupadas','topo_circular','topo_lineal','topo_borde','topo_otra'] },
  { id: 'g_4_4', label: '4.4 Gravedad',               keys: ['gravedad_extension','gravedad_intensidad','gravedad_funcionalidad'] },
  { id: 'g_4_5', label: '4.5 Patrón',                 keys: ['patron_inflam_epidermica','patron_inflam_dermica','patron_necrosis','patron_tumor','patron_color','notas_examen'] },
  { id: 'g_5',   label: '5 Diagnóstico',              keys: ['diagnostico','diagnostico_letra'] },
  { id: 'g_6',   label: '6 Estudios complementarios', keys: ['estudios_complementarios_presente','estudios_complementarios_resumen'] },
  { id: 'g_7',   label: '7 Tratamiento y plan',       keys: ['tratamiento_resumen','plan','proximo_control_fecha','proximo_control_motivo'] },
];

export const FICHA_GROUPS: FichaGroup[] = FICHA_GROUP_SPEC.map(g => ({
  id: g.id,
  label: g.label,
  category: byKey[g.keys[0]].category,
  target: byKey[g.keys[0]].target,
  fields: g.keys.map(k => byKey[k].field),
}));

export const FICHA_FIRST_GROUP = FICHA_GROUPS[0].id;

/** The atomic BotForm for one ficha group (one form per bookmark). */
export function fichaGroupForm(id: string): BotForm | null {
  const g = FICHA_GROUPS.find(x => x.id === id);
  if (!g) return null;
  return {
    id: 'ficha_grp_' + g.id,
    title: g.label,
    submit_mode: 'structured',
    submit_label: 'Guardar',
    fields: g.fields,
    actions: [{ label: 'Omitir', send: 'omitir ficha' }],
  };
}

/**
 * Same as fichaGroupForm, but pre-filled with the field's current value from
 * the target entity (patient or episode) so revisiting a bookmark shows what
 * was already entered.
 */
export async function fichaGroupFormFilled(
  id: string, mcp: TodoErpMcpClient, session: BotSession,
): Promise<BotForm | null> {
  const form = fichaGroupForm(id);
  const g = FICHA_GROUPS.find(x => x.id === id);
  if (!form || !g) return form;
  const entityId = g.target === 'patient'
    ? session.active_patient_id : session.active_episode_id;
  if (!entityId) return form;
  try {
    const r = await mcp.call('entities.get', { id: entityId });
    const data = ((r as any)?.data?.data) || {};
    const values: Record<string, unknown> = {};
    for (const f of g.fields) {
      if (f.key && data[f.key] !== undefined && data[f.key] !== null && data[f.key] !== '') {
        values[f.key] = data[f.key];
      }
    }
    if (Object.keys(values).length) form.values = values;
  } catch { /* no prefill */ }
  return form;
}

/** The group shown after `id` in ficha order (or null if it was the last). */
export function nextFichaGroupId(id: string): string | null {
  const i = FICHA_GROUPS.findIndex(g => g.id === id);
  return i >= 0 && i < FICHA_GROUPS.length - 1 ? FICHA_GROUPS[i + 1].id : null;
}

export interface FichaBookmark { id: string; label: string; category: string; done: boolean; }

/**
 * The bookmark rail: every ficha group + whether its field actually holds a
 * value on the target entity (patient or episode), regardless of whether it
 * was submitted in this session.
 */
export async function fichaBookmarks(
  mcp: TodoErpMcpClient, session: BotSession,
): Promise<FichaBookmark[]> {
  let patientData: Record<string, unknown> = {};
  let episodeData: Record<string, unknown> = {};
  if (session.active_patient_id) {
    try {
      const pr = await mcp.call('entities.get', { id: session.active_patient_id });
      patientData = ((pr as any)?.data?.data) || {};
    } catch { patientData = {}; }
  }
  if (session.active_episode_id) {
    try {
      const er = await mcp.call('entities.get', { id: session.active_episode_id });
      episodeData = ((er as any)?.data?.data) || {};
    } catch { episodeData = {}; }
  }
  return FICHA_GROUPS.map(g => {
    const src = g.target === 'patient' ? patientData : episodeData;
    const key = g.fields[0].key as string;
    const v = src[key];
    const done = v !== undefined && v !== null && v !== '';
    return { id: g.id, label: g.label, category: g.category, done };
  });
}

/**
 * First ficha group still missing a value, so the flow can skip sections that
 * are already complete (e.g. a returning patient with full contact data).
 * Returns null when every group is already filled.
 */
export async function firstIncompleteFichaGroup(
  mcp: TodoErpMcpClient, session: BotSession,
): Promise<string | null> {
  const marks = await fichaBookmarks(mcp, session);
  return marks.find(m => !m.done)?.id ?? null;
}

// Key routing for a full-ficha "Guardar": §1–§2 → paciente, resto → episodio.
// Identity fields (nombre/apellidos/cedula) are intentionally excluded.
const FICHA_PATIENT_KEYS = new Set<string>([
  'direccion', 'telefono', 'sector_ciudad', 'ocupacion', 'email', 'edad',
  'sexo', 'etnia', 'etnia_otra', 'escolaridad_anios', 'escolaridad_grado',
  'condicion_socioeconomica', 'antecedentes_personales',
  'antecedentes_personales_presente', 'antecedentes_familiares',
  'antecedentes_familiares_presente',
]);
const FICHA_EPISODE_KEYS = new Set<string>([
  ...FICHA_GROUPS.flatMap(g =>
    g.fields.map(f => f.key).filter((k): k is string => !!k)),
  'gravedad_total', 'ficha_num', 'examinador_nombre', 'regiones_afectadas',
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
      // Never let an empty field clear stored data — entities.update merges
      // field-by-field, so an empty string would overwrite the existing value.
      // (Same guard the group forms apply in BotForm.onSubmit.)
      if (v === '' || v === null || v === undefined) continue;
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
          title: `${nombre} ${apellidos}`.trim(),
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

  // ── patient mode WITH active patient: ficha clínica group flow ──
  // The ficha is walked as atomic groups: one structured BotForm per group,
  // each group a bookmark in the chat's left rail. Submitting a group form
  // merges its data into the active episode via entities.update.
  if ((session.extracted_slots as any)?.form_state?.kind === 'ficha') {
    const sub = ctx.formSubmission;
    const current: string =
      ((session.extracted_slots as any)?.ficha_current as string) || FICHA_GROUPS[0].id;

    // Jump to a group via the bookmark rail.
    if (sub?.form_id === 'ficha_goto') {
      const group = String(sub.data?.group);
      const form = await fichaGroupFormFilled(group, mcp, session);
      if (form) {
        setSlot(session, 'ficha_current', group);
        await appendAndSave(session, message, `${form.title}:`, mcp);
        return { text: `${form.title}:`, form, bookmarks: await fichaBookmarks(mcp, session) };
      }
    }

    // "Omitir" — skip the current form, move to the next one (nothing saved).
    if (/^\s*\/?\s*omitir(\s+ficha)?\s*$/i.test(trimmed)) {
      const nid = nextFichaGroupId(current);
      if (nid) {
        const form = (await fichaGroupFormFilled(nid, mcp, session))!;
        setSlot(session, 'ficha_current', nid);
        const text = `Omitido. Siguiente: ${form.title}.`;
        await appendAndSave(session, 'Omitir', text, mcp);
        return { text, form, bookmarks: await fichaBookmarks(mcp, session) };
      }
      const text = 'Última sección. Revisá lo que falte desde los marcadores.';
      await appendAndSave(session, 'Omitir', text, mcp);
      return { text, form: null, bookmarks: await fichaBookmarks(mcp, session) };
    }

    // Submit a group form.
    if (typeof sub?.form_id === 'string' && sub.form_id.startsWith('ficha_grp_')) {
      const gid = sub.form_id.slice('ficha_grp_'.length);
      const grp = FICHA_GROUPS.find(g => g.id === gid);
      const data: Record<string, unknown> = { ...(sub.data || {}) };
      const isPatient = grp?.target === 'patient';
      const targetId = isPatient ? session.active_patient_id : session.active_episode_id;
      // Numeric column — coerce the text input before persisting.
      if (data.edad != null && data.edad !== '') data.edad = Number(data.edad);
      if (!isPatient) {
        const gKeys = ['gravedad_extension', 'gravedad_intensidad', 'gravedad_funcionalidad'];
        for (const k of gKeys) {
          if (data[k] != null && data[k] !== '') data[k] = Number(data[k]);
        }
        // Forms are atomic (one field each), so a single submit never carries
        // all three gravedad fields — re-derive the total from the episode.
        if (gKeys.some(k => data[k] != null) && session.active_episode_id) {
          try {
            const er = await mcp.call('entities.get', { id: session.active_episode_id });
            const cur = ((er as any)?.data?.data) || {};
            data.gravedad_total = gKeys.reduce(
              (a, k) => a + (Number(data[k] ?? cur[k]) || 0), 0);
          } catch { /* skip total */ }
        }
      }
      // Human-readable record of what the form submitted — written into chat.
      const fmt = (v: unknown) => v === true ? 'Sí' : v === false ? 'No' : String(v);
      const summaryLines = (grp?.fields || [])
        .filter(f => f.key && data[f.key] !== undefined && data[f.key] !== null && data[f.key] !== '')
        .map(f => `  • ${f.label}: ${fmt(data[f.key!])}`);
      const summary = `📋 ${grp?.label || 'Formulario'}\n` +
        (summaryLines.length ? summaryLines.join('\n') : '  (sin datos)');

      if (targetId && Object.keys(data).length) {
        const upd = await mcp.call('entities.update', {
          id: targetId, record_type: 'business', data,
        });
        if (!(upd as any)?.ok) {
          const text = `No pude guardar: ${(upd as any)?.error || 'error desconocido'}.\n` +
            `Revisá los datos y volvé a enviar.`;
          await appendAndSave(session, summary, text, mcp);
          return { text, form: await fichaGroupFormFilled(gid, mcp, session), bookmarks: await fichaBookmarks(mcp, session) };
        }
        if (isPatient) {
          try {
            const pr = await mcp.call('entities.get', { id: session.active_patient_id! });
            const pd = ((pr as any)?.data?.data) || {};
            setSlot(session, 'patient_context', { id: session.active_patient_id, ...pd });
          } catch { /* skip refresh */ }
        }
      }
      const done: string[] = ((session.extracted_slots as any)?.ficha_done as string[]) || [];
      if (!done.includes(gid)) done.push(gid);
      setSlot(session, 'ficha_done', done);
      const nid = nextFichaGroupId(gid);
      if (nid) {
        const form = (await fichaGroupFormFilled(nid, mcp, session))!;
        setSlot(session, 'ficha_current', nid);
        const text = `Guardado. Siguiente: ${form.title}.`;
        await appendAndSave(session, summary, text, mcp);
        return { text, form, bookmarks: await fichaBookmarks(mcp, session) };
      }
      const text = 'Ficha completa. Podés revisar cualquier sección desde los marcadores.';
      await appendAndSave(session, summary, text, mcp);
      return { text, form: null, bookmarks: await fichaBookmarks(mcp, session) };
    }

    // Free text while the ficha is open — fall through to the rest of the pipeline.
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
