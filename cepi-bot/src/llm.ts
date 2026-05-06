/**
 * Pluggable LLM interface. The agent calls one of these to plan tool calls
 * and produce final answers; concrete adapters wrap DeepSeek (recommended
 * for v1 per PAPER §12.7), OpenAI, Claude, etc.
 *
 * For now we ship a `stub` adapter that returns canned responses so the
 * rest of the agent — MCP wiring, session persistence, role dispatch —
 * can be developed and tested without burning API credit.
 */

export interface ChatTurn {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  /** For role:'tool', the corresponding tool name. */
  tool_name?: string;
}

export interface ToolSpec {
  name: string;
  description?: string;
  inputSchema?: any;
}

export interface LLMResponse {
  /** Either an assistant message or a tool call instruction. */
  kind: 'message' | 'tool_call';
  /** Plain text answer when kind=message. */
  text?: string;
  /** Tool name + args when kind=tool_call. */
  tool?: { name: string; args: Record<string, unknown> };
}

export interface LLMAdapter {
  name: string;
  /** Single round-trip: given history+tools, return the next move. */
  step(history: ChatTurn[], tools: ToolSpec[]): Promise<LLMResponse>;
}

/**
 * Stub adapter — keyword routing. Useful for unit tests and as a safety
 * net when the real provider is unreachable.
 *
 * Recognized intents:
 *   "tools"  / "/tools"      → list available tools
 *   "whoami" / "/whoami"     → call auth.whoami
 *   "definitions" / "/defs"  → call definitions.list
 *   "patients" / "/patients" → call entities.list with patient slug
 *   anything else            → echo
 */
export class StubLLMAdapter implements LLMAdapter {
  name = 'stub';

  async step(history: ChatTurn[], tools: ToolSpec[]): Promise<LLMResponse> {
    // If the very last history entry is a tool result, summarise and stop —
    // never chain more than one tool call in stub mode.
    const tail = history[history.length - 1];
    if (tail?.role === 'tool') {
      let preview = tail.content;
      if (preview.length > 800) preview = preview.slice(0, 800) + '...';
      return {
        kind: 'message',
        text: `Resultado de \`${tail.tool_name}\`:\n\`\`\`json\n${preview}\n\`\`\``,
      };
    }

    const last = [...history].reverse().find(t => t.role === 'user');
    const msg = (last?.content || '').toLowerCase().trim();
    const has = (...needles: string[]) => needles.some(n => msg.includes(n));

    if (has('tools', '/tools')) {
      return {
        kind: 'message',
        text: 'Tools disponibles:\n' + tools.map(t => `- ${t.name}: ${t.description || ''}`).join('\n'),
      };
    }
    if (has('whoami', '/whoami')) {
      return { kind: 'tool_call', tool: { name: 'auth.whoami', args: {} } };
    }
    if (has('definitions', '/defs', 'definiciones')) {
      return { kind: 'tool_call', tool: { name: 'definitions.list', args: {} } };
    }
    if (has('pacientes', 'patients', '/patients')) {
      // patient entity_definition has UUID prefix 11000000-...
      return { kind: 'tool_call', tool: { name: 'entities.list', args: { type: '11000000-0000-0000-0000-000000000000', limit: 20 } } };
    }
    if (has('episodios', 'episodes')) {
      return { kind: 'tool_call', tool: { name: 'entities.list', args: { type: '12000000-0000-0000-0000-000000000000', limit: 20 } } };
    }
    if (has('diagnosticos', 'diagnósticos', 'diagnoses')) {
      return { kind: 'tool_call', tool: { name: 'entities.list', args: { type: '13000000-0000-0000-0000-000000000000', limit: 20 } } };
    }
    // CIE-10 catalog search: "cie10 melanoma", "código psoriasis"
    const cieMatch = msg.match(/^\s*(?:cie[- ]?10|c[óo]digo|icd[- ]?10)\s*[:]?\s*(.+)$/i);
    if (cieMatch) {
      const q = cieMatch[1].trim();
      return { kind: 'tool_call', tool: { name: 'entities.list', args: { type: '19000000-0000-0000-0000-000000000000', search: q, limit: 10 } } };
    }
    return {
      kind: 'message',
      text: `Eco: "${last?.content || ''}". Sugerencias: "tools", "whoami", "definitions", "pacientes".`,
    };
  }
}

/** Async because real adapters live in side modules to keep tests fast. */
export async function getLLMAdapter(): Promise<LLMAdapter> {
  const provider = (process.env.CEPI_LLM_PROVIDER || 'stub').toLowerCase();
  if (provider === 'deepseek') {
    const mod = await import('./llmDeepSeek.js');
    return new mod.DeepSeekLLMAdapter();
  }
  return new StubLLMAdapter();
}
