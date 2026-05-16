/**
 * MCP client wrapper for the TodoERP MCP server.
 *
 * Spawns todoerp-mcp as a child process over stdio, performs the MCP
 * handshake, and exposes a typed `call(toolName, args)` method that
 * returns either the JSON payload (on success) or an Error (on failure).
 *
 * Auth to TodoERP travels via env vars on the spawned process:
 *   TODOERP_API_URL  – base URL of the running backend (default :3001)
 *   TODOERP_JWT      – JWT bearer token (per-user)
 *   TODOERP_API_KEY  – fallback API key (machine-to-machine)
 *
 * The agent re-creates the client per session when it needs to swap the
 * caller identity, so we keep one client = one identity.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

export interface McpClientOptions {
  apiUrl?: string;
  jwt?: string;
  apiKey?: string;
  /** Path to the compiled MCP server entry. Defaults to TodoERP/mcp/dist/index.js. */
  mcpEntry?: string;
}

export interface ToolCallResult {
  ok: boolean;
  data?: any;
  error?: string;
}

export class TodoErpMcpClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private opts: McpClientOptions;

  constructor(opts: McpClientOptions = {}) {
    this.opts = opts;
  }

  /** Bearer JWT this client authenticates with (for direct REST calls). */
  get jwt(): string { return this.opts.jwt || process.env.TODOERP_JWT || ''; }
  /** API key fallback for machine-to-machine auth. */
  get apiKey(): string { return this.opts.apiKey || process.env.TODOERP_API_KEY || ''; }
  /** Base URL of the running TodoERP backend. */
  get apiUrl(): string {
    return this.opts.apiUrl || process.env.TODOERP_API_URL || 'http://localhost:3001';
  }

  async connect(): Promise<void> {
    if (this.client) return;
    const mcpEntry = this.opts.mcpEntry
      || path.resolve(__dirname, '../../TodoERP/mcp/dist/index.js');

    this.transport = new StdioClientTransport({
      command: process.execPath,
      args: [mcpEntry],
      env: {
        ...process.env,
        TODOERP_API_URL: this.opts.apiUrl || process.env.TODOERP_API_URL || 'http://localhost:3001',
        TODOERP_JWT:     this.opts.jwt    || process.env.TODOERP_JWT    || '',
        TODOERP_API_KEY: this.opts.apiKey || process.env.TODOERP_API_KEY || '',
      },
    });

    this.client = new Client(
      { name: 'cepi-bot', version: '0.1.0' },
      { capabilities: {} }
    );
    await this.client.connect(this.transport);
  }

  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: any }>> {
    if (!this.client) throw new Error('not connected');
    const res = await this.client.listTools();
    return res.tools as any;
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
    if (!this.client) throw new Error('not connected');
    try {
      const res = await this.client.callTool({ name, arguments: args });
      const content = (res.content as any[]) || [];
      const text = content.find((c: any) => c.type === 'text')?.text || '';
      let parsed: any = text;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* keep as text */ }
      if ((res as any).isError) return { ok: false, error: typeof parsed === 'string' ? parsed : JSON.stringify(parsed) };
      return { ok: true, data: parsed };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  async close(): Promise<void> {
    try { await this.client?.close(); } catch { /* */ }
    try { await this.transport?.close(); } catch { /* */ }
    this.client = null;
    this.transport = null;
  }
}
