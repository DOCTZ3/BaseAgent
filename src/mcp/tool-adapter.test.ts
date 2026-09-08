import { describe, it, expect, vi } from 'vitest';
import { McpRuntime, LoadMcpTool, McpCallTool, type McpTransportClient } from './tool-adapter.js';
import type { McpServerConfig, McpToolSpec } from './client.js';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const server: McpServerConfig = {
  id: 'luckin',
  name: 'Luckin',
  description: 'Luckin ordering MCP',
  url: 'https://example.com/mcp',
  enabled: true,
  bearerSecret: 'LUCKIN_TOKEN',
};

const tools: McpToolSpec[] = [{
  name: 'list_stores',
  description: 'List Luckin stores',
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
}];

function fakeClient() {
  const client: McpTransportClient = {
    initialize: vi.fn(async () => {}),
    listTools: vi.fn(async () => tools),
    callTool: vi.fn(async (_name, args) => ({
      content: [{ type: 'text', text: `ok:${args.city}` }],
    })),
    close: vi.fn(async () => {}),
  };
  return client;
}

describe('MCP CodeAct adapter', () => {
  it('load_mcp lists configured servers before fetching remote schemas', async () => {
    const client = fakeClient();
    const runtime = new McpRuntime({
      servers: [server],
      secrets: [{ name: 'LUCKIN_TOKEN', value: 'token' }],
      logger,
      clientFactory: () => client,
    });
    const tool = new LoadMcpTool(runtime);

    expect(tool.description).toContain('luckin (Luckin): Luckin ordering MCP');

    const result = await tool.run({}, {} as never);

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      servers: [{
        id: 'luckin',
        name: 'Luckin',
        description: 'Luckin ordering MCP',
        loaded: false,
      }],
    });
    expect(client.initialize).not.toHaveBeenCalled();
  });

  it('load_mcp fetches and caches tools/list schemas for a server', async () => {
    const client = fakeClient();
    const runtime = new McpRuntime({
      servers: [server],
      secrets: [{ name: 'LUCKIN_TOKEN', value: 'token' }],
      logger,
      clientFactory: () => client,
    });

    const first = await runtime.load('luckin');
    const second = await runtime.load('luckin');

    expect(first.ok).toBe(true);
    expect(first.data).toMatchObject({
      server: {
        id: 'luckin',
        name: 'Luckin',
        description: 'Luckin ordering MCP',
      },
      tools: [{ name: 'list_stores', description: 'List Luckin stores' }],
    });
    expect(second.ok).toBe(true);
    expect(client.initialize).toHaveBeenCalledTimes(1);
    expect(client.listTools).toHaveBeenCalledTimes(1);
  });

  it('mcp_call invokes remote MCP tools through the runtime without exposing token to Python', async () => {
    const client = fakeClient();
    const runtime = new McpRuntime({
      servers: [server],
      secrets: [{ name: 'LUCKIN_TOKEN', value: 'token' }],
      logger,
      clientFactory: () => client,
    });
    const tool = new McpCallTool(runtime);

    const result = await tool.run({
      server_id: 'luckin',
      tool_name: 'list_stores',
      arguments: { city: 'Shanghai' },
    }, {} as never);

    expect(result.ok).toBe(true);
    expect(client.callTool).toHaveBeenCalledWith('list_stores', { city: 'Shanghai' });
  });

  it('reports missing bearer secrets before sending MCP requests', async () => {
    const client = fakeClient();
    const runtime = new McpRuntime({
      servers: [server],
      secrets: [],
      logger,
      clientFactory: () => client,
    });

    const result = await runtime.load('luckin');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('LUCKIN_TOKEN');
    expect(client.initialize).not.toHaveBeenCalled();
  });

  it('refreshes configured servers and closes stale MCP clients', async () => {
    const oldClient = fakeClient();
    const newClient = fakeClient();
    const runtime = new McpRuntime({
      servers: [server],
      secrets: [{ name: 'LUCKIN_TOKEN', value: 'old-token' }],
      logger,
      clientFactory: vi.fn()
        .mockReturnValueOnce(oldClient)
        .mockReturnValueOnce(newClient),
    });
    const tool = new LoadMcpTool(runtime);

    expect((await runtime.load('luckin')).ok).toBe(true);
    expect(oldClient.initialize).toHaveBeenCalledTimes(1);

    await runtime.refresh([
      {
        ...server,
        id: 'luckin_v2',
        description: 'Updated Luckin MCP',
      },
    ], [{ name: 'LUCKIN_TOKEN', value: 'new-token' }]);

    expect(oldClient.close).toHaveBeenCalledTimes(1);
    expect(tool.description).toContain('luckin_v2 (Luckin): Updated Luckin MCP');
    expect(await runtime.load('luckin')).toMatchObject({
      ok: false,
      error: expect.stringContaining('luckin'),
    });
    expect((await runtime.load('luckin_v2')).ok).toBe(true);
    expect(newClient.initialize).toHaveBeenCalledTimes(1);
  });
});
