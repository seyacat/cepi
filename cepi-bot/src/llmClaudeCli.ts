/**
 * Claude CLI LLM adapter. Selected via CEPI_LLM_PROVIDER=claude.
 *
 * Shells out to the locally installed `claude` CLI in non-interactive
 * print mode (`claude -p --output-format json`). No API key handling here —
 * the CLI uses whatever credentials it was logged in with.
 *
 * Tool calling: the CLI print mode does not expose OpenAI-style function
 * calling, so we instruct the model to emit a one-line JSON object
 * `{"tool":"name","args":{...}}` when it wants to call an MCP tool, and
 * plain text otherwise. The agent loop feeds the tool result back next turn.
 *
 * Env:
 *   CLAUDE_CLI_BIN     — path to the CLI (default: "claude")
 *   CLAUDE_CLI_MODEL   — optional --model override
 *   CEPI_AGENT_SYSTEM  — system prompt override
 */
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { LLMAdapter, LLMResponse, ChatTurn, ToolSpec } from './llm.js';

const DEFAULT_SYSTEM_PROMPT = `Eres el agente conversacional clínico de CEPI.

Reglas no negociables:
- Eres un AYUDANTE del médico, no un sustituto. Nunca emites un diagnóstico definitivo. Toda sugerencia diagnóstica debe etiquetarse como "Sugerencia IA".
- No inventes datos. Si no sabes algo, dilo o pide ayuda al usuario.
- Trata cualquier dato personal (nombre, cédula, email, teléfono) con discreción.
- Habla en español. Nunca menciones comandos internos ni nombres de herramientas al usuario.`;

function renderHistory(history: ChatTurn[]): string {
  return history
    .map(h => {
      if (h.role === 'tool') return `[resultado de herramienta ${h.tool_name || ''}]\n${h.content}`;
      if (h.role === 'system') return `[contexto]\n${h.content}`;
      if (h.role === 'user') return `[usuario]\n${h.content}`;
      return `[asistente]\n${h.content}`;
    })
    .join('\n\n');
}

function buildPrompt(history: ChatTurn[], tools: ToolSpec[], systemPrompt: string): string {
  const toolList = tools.length
    ? tools.map(t => `- ${t.name}: ${t.description || ''}`).join('\n')
    : '(ninguna)';
  return [
    systemPrompt,
    '',
    'Herramientas MCP disponibles (úsalas para leer o escribir datos):',
    toolList,
    '',
    'FORMATO DE RESPUESTA — elige una de dos:',
    '1. Para llamar una herramienta, responde EXCLUSIVAMENTE con un JSON en una sola línea, sin texto ni markdown alrededor:',
    '   {"tool":"<nombre exacto>","args":{...}}',
    '2. Para responder al usuario, escribe texto plano normal (sin JSON, sin bloques de código).',
    '',
    'Conversación hasta ahora:',
    renderHistory(history),
    '',
    'Tu próxima respuesta:',
  ].join('\n');
}

function runClaude(prompt: string): Promise<string> {
  const bin = process.env.CLAUDE_CLI_BIN || 'claude';
  const args = ['-p', '--output-format', 'json'];
  if (process.env.CLAUDE_CLI_MODEL) args.push('--model', process.env.CLAUDE_CLI_MODEL);
  return new Promise((resolve, reject) => {
    // Run from a neutral cwd so the CLI does not load the cepi project's
    // CLAUDE.md / MCP config into every prompt.
    const child = spawn(bin, args, { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('claude CLI timeout')); }, 90_000);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude CLI exited ${code}: ${err.slice(0, 300)}`));
      resolve(out);
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

export class ClaudeCliLLMAdapter implements LLMAdapter {
  name = 'claude-cli';
  private systemPrompt: string;

  constructor() {
    this.systemPrompt = process.env.CEPI_AGENT_SYSTEM || DEFAULT_SYSTEM_PROMPT;
  }

  async step(history: ChatTurn[], tools: ToolSpec[]): Promise<LLMResponse> {
    const prompt = buildPrompt(history, tools, this.systemPrompt);
    let raw: string;
    try {
      raw = await runClaude(prompt);
    } catch (e: any) {
      return { kind: 'message', text: `No pude consultar al modelo: ${e?.message || e}` };
    }

    // The CLI wraps the answer in {type:"result", result:"..."}.
    let result = '';
    try {
      const parsed = JSON.parse(raw);
      result = typeof parsed?.result === 'string' ? parsed.result : raw;
    } catch {
      result = raw;
    }
    result = result.trim();

    // A tool call: a bare JSON object with a "tool" key (tolerate code fences).
    const jsonText = result.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    if (jsonText.startsWith('{') && jsonText.includes('"tool"')) {
      try {
        const obj = JSON.parse(jsonText);
        if (obj && typeof obj.tool === 'string') {
          const known = tools.find(t => t.name === obj.tool);
          if (known) {
            return {
              kind: 'tool_call',
              tool: { name: obj.tool, args: (obj.args && typeof obj.args === 'object') ? obj.args : {} },
            };
          }
        }
      } catch { /* not a tool call — fall through to plain message */ }
    }

    return { kind: 'message', text: result || '(sin respuesta del modelo)' };
  }
}
