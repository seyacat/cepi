/**
 * Agent loop (PAPER §12.1). Drives one conversational turn:
 *
 *   1. Loads the persisted session (turns, slots, active patient/episode).
 *   2. Asks the LLM what to do next given history + available tools.
 *   3. If it asked for a tool, calls it via MCP; injects result; loops.
 *   4. Returns the final assistant text plus the updated session id.
 *
 * Safety gates baked in:
 *   - Hard limit on tool-call turns to prevent runaway loops.
 *   - No raw PII echoes: the agent never reads tool result data with PII
 *     fields back to the user without explicit permission (the backend
 *     redacts in transit per R4; this is belt-and-suspenders).
 */
import { TodoErpMcpClient, ToolCallResult } from './mcpClient.js';
import { LLMAdapter, ChatTurn, ToolSpec, getLLMAdapter } from './llm.js';
import { redactPiiInJson } from './redact.js';

const MAX_TOOL_CALLS_PER_TURN = 5;

export interface AgentTurnInput {
  /** Caller identity (forwarded to MCP via JWT). */
  jwt?: string;
  apiKey?: string;
  /** Conversation history so far. The current user turn must be the last entry. */
  history: ChatTurn[];
  /** Optional: tool spec list cache. If not provided, the agent fetches it. */
  tools?: ToolSpec[];
  /** Optional: pre-bound MCP client (saves spawn cost when reused). */
  mcp?: TodoErpMcpClient;
  /** Optional LLM adapter override (tests inject a deterministic one). */
  llm?: LLMAdapter;
}

export interface AgentTurnOutput {
  /** Final assistant text shown to the user. */
  text: string;
  /** Tool calls that were issued during this turn (for audit / debug). */
  toolCalls: Array<{ name: string; args: any; result: ToolCallResult }>;
  /** Updated history after this turn. */
  history: ChatTurn[];
}

export async function runAgentTurn(input: AgentTurnInput): Promise<AgentTurnOutput> {
  const llm = input.llm || await getLLMAdapter();

  // 1. Ensure we have an MCP client connected as the caller.
  let mcp = input.mcp;
  let ownsMcp = false;
  if (!mcp) {
    mcp = new TodoErpMcpClient({ jwt: input.jwt, apiKey: input.apiKey });
    await mcp.connect();
    ownsMcp = true;
  }

  try {
    // 2. Load tool catalog (cheap; cache later if needed).
    const tools = input.tools || (await mcp.listTools());

    let history: ChatTurn[] = [...input.history];
    const toolCalls: AgentTurnOutput['toolCalls'] = [];

    for (let i = 0; i < MAX_TOOL_CALLS_PER_TURN; i++) {
      // PAPER §13.3.1: redact PII from tool results BEFORE the LLM sees the
      // history. The unredacted history is what we return to the caller for
      // rendering in the UI; only this snapshot is fed to the model.
      const llmView: ChatTurn[] = history.map(t =>
        t.role === 'tool' ? { ...t, content: redactPiiInJson(t.content) } : t
      );
      const decision = await llm.step(llmView, tools);

      if (decision.kind === 'message') {
        const text = decision.text || '';
        history = [...history, { role: 'assistant', content: text }];
        return { text, toolCalls, history };
      }

      // tool_call branch
      const toolName = decision.tool?.name || '';
      const args     = decision.tool?.args || {};
      const known = tools.find(t => t.name === toolName);
      if (!known) {
        const text = `Tool desconocida: ${toolName}`;
        history = [...history, { role: 'assistant', content: text }];
        return { text, toolCalls, history };
      }

      const result = await mcp.call(toolName, args);
      toolCalls.push({ name: toolName, args, result });
      const rawJson = JSON.stringify(result.ok ? result.data : { error: result.error });
      history = [
        ...history,
        {
          role: 'tool',
          tool_name: toolName,
          content: rawJson,
        },
      ];
      // Loop: feed the tool result back to the LLM for the next decision.
    }

    // Hit the cap. Return whatever we have.
    const text = `Se alcanzó el límite de ${MAX_TOOL_CALLS_PER_TURN} llamadas a tools en este turno.`;
    history = [...history, { role: 'assistant', content: text }];
    return { text, toolCalls, history };

  } finally {
    if (ownsMcp) await mcp.close();
  }
}
