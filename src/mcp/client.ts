import type { StoredSecret } from '../platform/secrets.js';

export interface McpServerConfig {
  id: string;
  name: string;
  description?: string;
  url: string;
  enabled: boolean;
  bearerSecret?: string;
  headers?: Record<string, string>;
}

export interface McpToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpCallResult {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

interface McpClientOptions {
  server: McpServerConfig;
  secrets: readonly StoredSecret[];
  timeoutMs?: number;
}

declare const fetch: (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export class McpClient {
  private sessionId = '';
  private nextId = 1;

  constructor(private options: McpClientOptions) {}

  async initialize(): Promise<void> {
    const response = await this.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'BaseAgent', version: '0.1.0' },
    }, true);

    if (!response.ok) {
      throw new Error(response.error);
    }

    await this.notification('notifications/initialized').catch(() => {});
  }

  async listTools(): Promise<McpToolSpec[]> {
    const response = await this.rpc('tools/list', undefined, false);
    if (!response.ok) throw new Error(response.error);

    const tools = (response.result as { tools?: unknown[] } | undefined)?.tools ?? [];
    return tools
      .filter(t => t && typeof t === 'object')
      .map(t => t as McpToolSpec)
      .filter(t => typeof t.name === 'string' && t.name.length > 0);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const response = await this.rpc('tools/call', {
      name,
      arguments: args,
    }, false);

    if (!response.ok) {
      return { isError: true, content: [{ type: 'text', text: response.error }] };
    }

    return response.result as McpCallResult;
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);
    try {
      await fetch(this.options.server.url, {
        method: 'DELETE',
        headers: this.headers(),
        signal: controller.signal,
      });
    } catch {
      // Closing is best-effort; a failed MCP teardown must not block session disposal.
    } finally {
      clearTimeout(timer);
      this.sessionId = '';
    }
  }

  private async notification(method: string): Promise<void> {
    await this.post({ jsonrpc: '2.0', method });
  }

  private async rpc(
    method: string,
    params: unknown,
    allowSessionUpdate: boolean,
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
    const id = this.nextId++;
    const payload: Record<string, unknown> = { jsonrpc: '2.0', id, method };
    if (params !== undefined) payload.params = params;

    const response = await this.post(payload, allowSessionUpdate);
    if (!response.ok) return response;

    const body = response.body as { result?: unknown; error?: { message?: string } } | undefined;
    if (body?.error) return { ok: false, error: body.error.message || JSON.stringify(body.error) };
    return { ok: true, result: body?.result };
  }

  private async post(
    payload: unknown,
    allowSessionUpdate = false,
  ): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);

    try {
      const res = await fetch(this.options.server.url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (allowSessionUpdate) {
        const sid = res.headers.get('mcp-session-id');
        if (sid) this.sessionId = sid;
      }

      const text = await res.text();
      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status} ${res.statusText}: ${text.slice(0, 1000)}` };
      }

      const parsed = parseMcpResponse(text, res.headers.get('content-type') || '');
      return { ok: true, body: parsed };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      ...(this.options.server.headers ?? {}),
    };

    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;

    const secretName = this.options.server.bearerSecret;
    if (secretName) {
      const secret = this.options.secrets.find(s => s.name === secretName);
      if (secret?.value) headers.Authorization = `Bearer ${secret.value}`;
    }

    return headers;
  }
}

function parseMcpResponse(text: string, contentType: string): unknown {
  if (!contentType.toLowerCase().includes('text/event-stream')) {
    return text ? JSON.parse(text) : undefined;
  }

  for (const event of splitSse(text)) {
    const data = event
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
      .trim();
    if (!data || data === '[DONE]') continue;
    return JSON.parse(data);
  }

  return undefined;
}

function splitSse(text: string): string[] {
  return text.split(/\r?\n\r?\n/).filter(Boolean);
}
