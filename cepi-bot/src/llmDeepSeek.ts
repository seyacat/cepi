/**
 * DeepSeek LLM adapter (OpenAI-compatible Chat Completions API).
 * Selected via CEPI_LLM_PROVIDER=deepseek. Recommended default per
 * PAPER §12.7 — DeepSeek supports tool calling at lower latency than
 * frontier models.
 *
 * Env:
 *   DEEPSEEK_API_KEY   — required
 *   DEEPSEEK_BASE_URL  — default https://api.deepseek.com/v1
 *   DEEPSEEK_MODEL     — default deepseek-chat
 *   CEPI_AGENT_SYSTEM  — system prompt override
 */
import OpenAI from 'openai';
import { LLMAdapter, LLMResponse, ChatTurn, ToolSpec } from './llm.js';

const DEFAULT_SYSTEM_PROMPT = `Eres el agente conversacional clínico de CEPI.

Reglas no negociables:
- Eres un AYUDANTE del médico, no un sustituto. Nunca emites un diagnóstico definitivo. Toda sugerencia diagnóstica debe etiquetarse como "Sugerencia IA".
- No inventes datos. Si no sabes algo, dilo o pide ayuda al usuario.
- Trata cualquier dato personal (nombre, cédula, email, teléfono) con discreción. No los repitas innecesariamente en respuestas.

Capacidades:
- Tienes acceso a las tools del MCP de TodoERP. Úsalas para leer y escribir datos.
- Cuando el usuario pida algo, decide si necesitas llamar una tool o responder directamente.
- Si llamas una tool, recibirás su resultado en el siguiente turno y podrás resumirlo en lenguaje natural.
- Habla en español por defecto.

Captura de datos por TEXTO LIBRE (muy importante):
- Si el usuario PEGA o escribe un texto con datos de un paciente, EXTRAE los campos mencionados y llama \`entities.update\` sobre el PACIENTE activo (o el EPISODIO activo si son datos de la consulta). Mira el "Contexto activo" para saber qué id usar.
- Campos del PACIENTE: nombre, apellidos, cedula, fecha_nac (YYYY-MM-DD), sexo, etnia, escolaridad_grado, condicion_socioeconomica, email, telefono, direccion, ocupacion, alergias, medicacion_actual, antecedentes_personales, antecedentes_familiares.
- Campos del EPISODIO/consulta activa: motivo_consulta, tiempo_evolucion, sintoma_principal, tratamientos_previos.
- Campos de SELECCIÓN — usá EXACTAMENTE uno de estos valores (mapeá el lenguaje natural): sexo = F | M | Otro (hombre→M, mujer→F); etnia = mestiza | blanco | afro | otra (negro/afrodescendiente→afro, mestizo→mestiza); escolaridad_grado = ninguna | básico | superior | tercer nivel | cuarto nivel; condicion_socioeconomica = alto | medio | bajo.
- Reglas: incluye SOLO los campos que el texto menciona explícitamente; NUNCA sobreescribas un campo con vacío; si un dato es ambiguo, pregúntalo en vez de adivinar; fechas en formato YYYY-MM-DD.
- IMPORTANTE: NO resumas en texto pidiendo un "sí" y esperes la respuesta. En el MISMO turno LLAMA \`entities.update\` con TODOS los campos extraídos. El sistema intercepta esa llamada y le muestra al usuario una tarjeta de confirmación (sí/no) automáticamente antes de guardar — esa es la confirmación, no la pidas tú en texto.`;

function toOpenAITools(tools: ToolSpec[]): any[] {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name.replace(/\./g, '_'),       // OpenAI tool names cannot contain dots
      description: t.description || '',
      parameters: t.inputSchema || { type: 'object', properties: {} },
    },
  }));
}

const DOT_MAP_DELIM = '__';
function fromOpenAIToolName(n: string): string {
  // We map "auth.whoami" → "auth_whoami". The reverse needs a lookup
  // because dots and underscores collide. The agent passes tool list, so
  // we do best-effort: try the original name with the first underscore
  // converted to a dot.
  return n.replace(/_/, '.');
}

export function toOpenAIMessages(history: ChatTurn[], systemPrompt: string): any[] {
  const msgs: any[] = [{ role: 'system', content: systemPrompt }];
  let toolSeq = 0;
  for (const h of history) {
    if (h.role === 'tool') {
      // OpenAI/DeepSeek reject a role:'tool' message unless it directly follows
      // an assistant message whose tool_calls includes a matching id. Our stored
      // history never carries that assistant turn (the agent records only the
      // tool result; server-side commands push bare tool turns), so synthesize
      // the pair here — otherwise the API 400s with "Messages with role 'tool'
      // must be a response to a preceding message with 'tool_calls'".
      const id = `call_synth_${toolSeq++}`;
      const fnName = (h.tool_name || 'tool').replace(/\./g, '_');
      msgs.push({
        role: 'assistant',
        content: null,
        tool_calls: [{ id, type: 'function', function: { name: fnName, arguments: '{}' } }],
      });
      msgs.push({ role: 'tool', tool_call_id: id, content: h.content });
    } else if (h.role === 'system') {
      msgs.push({ role: 'system', content: h.content });
    } else if (h.role === 'user') {
      msgs.push({ role: 'user', content: h.content });
    } else if (h.role === 'assistant') {
      msgs.push({ role: 'assistant', content: h.content });
    }
  }
  return msgs;
}

export class DeepSeekLLMAdapter implements LLMAdapter {
  name = 'deepseek';
  private client: OpenAI;
  private model: string;
  private systemPrompt: string;

  constructor() {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) throw new Error('DEEPSEEK_API_KEY is required for DeepSeekLLMAdapter');
    this.client = new OpenAI({
      apiKey,
      baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
      // Force Node's native (undici) fetch. Otherwise the SDK falls back to
      // node-fetch, whose Gunzip path throws ERR_STREAM_PREMATURE_CLOSE on
      // DeepSeek's gzipped responses. Native fetch decodes gzip correctly.
      fetch: (globalThis as any).fetch,
    });
    this.model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
    this.systemPrompt = process.env.CEPI_AGENT_SYSTEM || DEFAULT_SYSTEM_PROMPT;
  }

  async step(history: ChatTurn[], tools: ToolSpec[]): Promise<LLMResponse> {
    const messages = toOpenAIMessages(history, this.systemPrompt);
    const oaiTools = toOpenAITools(tools);

    const resp = await this.client.chat.completions.create({
      model: this.model,
      messages,
      tools: oaiTools.length ? oaiTools : undefined,
      tool_choice: oaiTools.length ? 'auto' : undefined,
      temperature: 0.2,
    } as any);

    const choice = resp.choices?.[0];
    if (!choice) return { kind: 'message', text: '(sin respuesta del modelo)' };

    const tc = choice.message?.tool_calls?.[0];
    if (tc?.type === 'function') {
      const oaiName = tc.function.name;
      // Find the original tool name (with dots) in the tool list.
      const original = tools.find(t => t.name.replace(/\./g, '_') === oaiName)?.name || fromOpenAIToolName(oaiName);
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = {}; }
      return { kind: 'tool_call', tool: { name: original, args } };
    }

    return { kind: 'message', text: choice.message?.content || '' };
  }
}
