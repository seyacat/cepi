# CLAUDE.md — cepi-bot

This file tells Claude Code how to extend the conversational agent.

## Pillars

The bot is **stateless logic + persisted session**. The HTTP server
(`src/server.ts`) handles a chat turn by:

1. Loading the `bot_session` record (entities.create on first turn).
2. Recognising **slash-style commands** server-side and executing them
   without round-tripping through the LLM (faster, deterministic, audit-
   friendly): activar/salir paciente/episodio, nuevo episodio,
   cerrar episodio, /diagnostico, /escalar, casos similares, ver paciente,
   ver episodio, nota, ver chatter, recordatorios, completar/cancelar/snooze
   reminder, resumen, /help.
3. For **agent/LLM-initiated** sensitive writes (entities.create,
   entities.update, request_review inferred from free text or a command),
   a **confirmation gate**: the action is staged into
   `session.pending_action`, the user replies sí/no, and the bot executes
   on confirm. This does NOT apply to **ficha form submits**: sending a
   structured ficha form (`ficha_grp_*`, including the §4.7/§8 image
   uploads) is already an explicit user action, so it writes directly —
   no extra sí/no card.
4. Anything else falls through to the **LLM adapter** (`src/llm.ts`),
   which is either the keyword-routing stub (default) or DeepSeek via
   `CEPI_LLM_PROVIDER=deepseek`. The agent loop (`src/agent.ts`) lets the
   LLM emit messages or tool calls; tool calls go through the MCP client.
5. After the turn, the bot **PII-redacts tool results** before they would
   reach the LLM next iteration (PAPER §13.3.1) — see `src/redact.ts`.
   The frontend still receives the raw transcript for rendering.

## Invariants

- The agent never writes to the DB off its own free-text/command inference
  without explicit confirmation. A ficha form submit IS that explicit
  action and writes directly (no gate).
- Every successful confirmation leaves a chatter audit note.
- `bot_session` lives in TodoERP like any other record (entity_definition
  17000000-…); it has no special storage path.
- The MCP server is spawned per session (stdio transport) — one client
  = one identity. Authentication travels via `TODOERP_JWT` /
  `TODOERP_API_KEY` env passed at spawn time.

## Adding a new command

```ts
// In src/server.ts, before the LLM fallthrough:
const m = message.trim().match(/^\/?\s*minueva\s+(.+)$/i);
if (m) {
  // Either: 1. directly call the MCP tool and return,
  //         2. stage a pending_action and ask for confirmation.
  session.pending_action = {
    summary: 'Lo que el usuario verá',
    tool: 'entities.create',          // or any registered MCP tool
    args: { /* … */ },
    successMessage: 'Listo. Id: {{id}}',
    createdAt: new Date().toISOString(),
  };
  // append turns + saveSession + return res.json with pending_action
}
```

## Adding a new MCP tool

The catalogue lives in **TodoERP/mcp/src/tools.ts**. Add an entry there;
restart the MCP. The bot picks it up automatically — no change to
`cepi-bot` is required because tools are discovered via `listTools()`.

## Tests

`npx vitest run` from this directory. The agent tests use a fake MCP
client and a scripted LLM (no network).

For end-to-end coverage, the matching test in
`TodoERP/backend/tests/mcp_generality.test.ts` exercises the full
agent + MCP + REST stack via supertest.
