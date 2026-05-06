/**
 * Agent loop unit tests. Uses a fake MCP client so we don't depend on a
 * running TodoERP backend.
 */
import { describe, it, expect } from 'vitest';
import { runAgentTurn } from '../src/agent.js';
import { ChatTurn, LLMAdapter, ToolSpec } from '../src/llm.js';

class FakeMcp {
  public calls: Array<{ name: string; args: any }> = [];
  private toolList: ToolSpec[];
  private results: Map<string, any>;

  constructor(toolList: ToolSpec[], results: Map<string, any>) {
    this.toolList = toolList;
    this.results  = results;
  }
  async connect() { /* noop */ }
  async listTools() { return this.toolList; }
  async call(name: string, args: any) {
    this.calls.push({ name, args });
    if (this.results.has(name)) return { ok: true, data: this.results.get(name) };
    return { ok: false, error: `unknown tool ${name}` };
  }
  async close() { /* noop */ }
}

const toolList: ToolSpec[] = [
  { name: 'auth.whoami',     description: 'identity'    },
  { name: 'definitions.list',description: 'list defs'   },
  { name: 'entities.list',   description: 'list records'},
];

class ScriptedLLM implements LLMAdapter {
  name = 'scripted';
  private steps: any[];
  private idx = 0;
  constructor(steps: any[]) { this.steps = steps; }
  async step(_h: ChatTurn[], _t: ToolSpec[]) {
    return this.steps[this.idx++] || { kind: 'message', text: 'done' };
  }
}

describe('runAgentTurn', () => {
  const baseHistory: ChatTurn[] = [{ role: 'user', content: 'who am i' }];

  it('returns a plain message when LLM emits kind=message', async () => {
    const mcp = new FakeMcp(toolList, new Map());
    const llm = new ScriptedLLM([{ kind: 'message', text: 'hola' }]);
    const out = await runAgentTurn({ history: baseHistory, mcp: mcp as any, llm, jwt: 'x' });

    expect(out.text).toBe('hola');
    expect(out.toolCalls.length).toBe(0);
    expect(out.history.at(-1)?.role).toBe('assistant');
  });

  it('executes a tool call and feeds its result back before the final message', async () => {
    const mcp = new FakeMcp(toolList, new Map([['auth.whoami', { sub: 'u1', email: 'a@b.com' }]]));
    const llm = new ScriptedLLM([
      { kind: 'tool_call', tool: { name: 'auth.whoami', args: {} } },
      { kind: 'message',   text: 'eres a@b.com' },
    ]);
    const out = await runAgentTurn({ history: baseHistory, mcp: mcp as any, llm, jwt: 'x' });

    expect(mcp.calls).toEqual([{ name: 'auth.whoami', args: {} }]);
    expect(out.toolCalls.length).toBe(1);
    expect(out.toolCalls[0].result.ok).toBe(true);
    expect(out.text).toBe('eres a@b.com');
    // history should have user + tool + assistant
    expect(out.history.map(t => t.role)).toEqual(['user', 'tool', 'assistant']);
  });

  it('rejects an unknown tool gracefully', async () => {
    const mcp = new FakeMcp(toolList, new Map());
    const llm = new ScriptedLLM([{ kind: 'tool_call', tool: { name: 'made.up', args: {} } }]);
    const out = await runAgentTurn({ history: baseHistory, mcp: mcp as any, llm, jwt: 'x' });
    expect(out.text).toMatch(/desconocida/i);
    expect(mcp.calls.length).toBe(0);
  });

  it('caps tool calls at 5 per turn', async () => {
    const mcp = new FakeMcp(toolList, new Map([['auth.whoami', {}]]));
    const llm = new ScriptedLLM(
      Array.from({ length: 10 }, () => ({ kind: 'tool_call', tool: { name: 'auth.whoami', args: {} } }))
    );
    const out = await runAgentTurn({ history: baseHistory, mcp: mcp as any, llm, jwt: 'x' });
    expect(mcp.calls.length).toBe(5);
    expect(out.text).toMatch(/límite/i);
  });

  it('forwards tool errors back into history', async () => {
    const mcp = new FakeMcp(toolList, new Map());           // returns ok:false for everything
    const llm = new ScriptedLLM([
      { kind: 'tool_call', tool: { name: 'entities.list', args: {} } },
      { kind: 'message',   text: 'falló pero seguimos' },
    ]);
    const out = await runAgentTurn({ history: baseHistory, mcp: mcp as any, llm, jwt: 'x' });
    expect(out.toolCalls[0].result.ok).toBe(false);
    expect(out.history.find(t => t.role === 'tool')?.content).toContain('error');
    expect(out.text).toBe('falló pero seguimos');
  });
});
