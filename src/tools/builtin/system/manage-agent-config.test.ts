import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ManageAgentConfigTool } from './manage-agent-config.js';
import { readConfigFile } from '../../../platform/config-store.js';
import type { ToolContext } from '../../contract.js';
import type { Logger } from '../../../platform/index.js';

let tmpDir: string;
const saved: Record<string, string | undefined> = {};

const logger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
} as unknown as Logger;

const ctx = {
  sessionId: 'test',
  logger,
  signal: new AbortController().signal,
  confirm: async () => true,
  executors: {},
} as ToolContext;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseagent-tool-cfg-'));
  for (const k of ['APPDATA', 'XDG_CONFIG_HOME', 'HOME']) {
    saved[k] = process.env[k];
    process.env[k] = tmpDir;
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('ManageAgentConfigTool', () => {
  it('writes secrets and never returns the secret value', async () => {
    const tool = new ManageAgentConfigTool();

    const savedSecret = await tool.run({
      action: 'upsert_secret',
      secret: {
        name: 'luckin_token',
        secret_value: 'secret-value',
        description: 'Luckin MCP token',
      },
    }, ctx);

    expect(savedSecret.ok).toBe(true);
    expect(JSON.stringify(savedSecret)).not.toContain('secret-value');
    expect(readConfigFile().secrets).toEqual([{
      name: 'LUCKIN_TOKEN',
      value: 'secret-value',
      description: 'Luckin MCP token',
    }]);

    const listed = await tool.run({ action: 'list' }, ctx);
    expect(JSON.stringify(listed)).not.toContain('secret-value');
    expect(listed.data).toEqual({
      secrets: [{
        name: 'LUCKIN_TOKEN',
        description: 'Luckin MCP token',
        has_value: true,
      }],
      mcp_servers: [],
    });
  });

  it('upserts MCP servers while preserving other servers', async () => {
    const tool = new ManageAgentConfigTool();

    await tool.run({
      action: 'upsert_mcp_server',
      mcp_server: {
        id: 'demo',
        name: 'Demo',
        description: 'Demo MCP',
        url: 'https://example.com/mcp',
        enabled: true,
      },
    }, ctx);
    await tool.run({
      action: 'upsert_mcp_server',
      mcp_server: {
        id: 'luckin',
        name: 'Luckin',
        description: 'Luckin ordering',
        url: 'https://luckin.example/mcp',
        bearer_secret: 'luckin_token',
      },
    }, ctx);

    expect(readConfigFile().mcpServers).toEqual([
      {
        id: 'demo',
        name: 'Demo',
        description: 'Demo MCP',
        url: 'https://example.com/mcp',
        enabled: true,
      },
      {
        id: 'luckin',
        name: 'Luckin',
        description: 'Luckin ordering',
        url: 'https://luckin.example/mcp',
        enabled: true,
        bearerSecret: 'LUCKIN_TOKEN',
      },
    ]);
  });

  it('can create a secret placeholder without receiving the value', async () => {
    const tool = new ManageAgentConfigTool();

    const result = await tool.run({
      action: 'upsert_secret',
      secret: {
        name: 'mcp_token',
        description: 'Token filled by user in the config drawer',
      },
    }, ctx);

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      has_value: false,
      placeholder: true,
      next_step: 'ask_user_to_fill_secret_value_then_test_mcp_server',
    });
    expect(readConfigFile().secrets).toEqual([{
      name: 'MCP_TOKEN',
      value: '',
      description: 'Token filled by user in the config drawer',
    }]);

    const listed = await tool.run({ action: 'list' }, ctx);
    expect(listed.data).toEqual({
      secrets: [{
        name: 'MCP_TOKEN',
        description: 'Token filled by user in the config drawer',
        has_value: false,
      }],
      mcp_servers: [],
    });
  });

  it('guides MCP setup toward a user-filled secret slot before testing', async () => {
    const tool = new ManageAgentConfigTool();

    await tool.run({
      action: 'upsert_secret',
      secret: {
        name: 'LUCKIN_MCP_TOKEN',
        description: 'Luckin MCP token filled in the config drawer',
      },
    }, ctx);

    const saved = await tool.run({
      action: 'upsert_mcp_server',
      mcp_server: {
        id: 'luckin',
        name: 'Luckin',
        description: 'Luckin MCP draft, pending credential verification',
        url: 'https://open.lkcoffee.com/mcp',
        bearer_secret: 'luckin_mcp_token',
      },
    }, ctx);

    expect(saved.ok).toBe(true);
    expect(saved.data).toMatchObject({
      next_step: 'ask_user_to_fill_secret_value_then_test_mcp_server',
      warnings: ['MCP Server Luckin 引用的 Secret 值为空: LUCKIN_MCP_TOKEN'],
    });

    const tested = await tool.run({
      action: 'test_mcp_server',
      mcp_server: { id: 'luckin' },
    }, ctx);

    expect(tested.ok).toBe(false);
    expect(tested.data).toMatchObject({
      next_step: 'ask_user_to_fill_secret_value_then_test_mcp_server',
      guidance: expect.stringContaining('配置面板填写值'),
      server: {
        id: 'luckin',
        bearer_secret_status: 'empty',
      },
    });
  });

  it('does not confirm reads, but confirms writes with secret values redacted', async () => {
    const confirm = vi.fn<ToolContext['confirm']>(async () => true);
    const localCtx = { ...ctx, confirm } as ToolContext;
    const tool = new ManageAgentConfigTool();

    await tool.run({ action: 'list' }, localCtx);
    expect(confirm).not.toHaveBeenCalled();

    await tool.run({
      action: 'upsert_secret',
      secret: {
        name: 'TOKEN',
        secret_value: 'do-not-show',
      },
    }, localCtx);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(confirm.mock.calls[0][0])).not.toContain('do-not-show');
    expect(JSON.stringify(confirm.mock.calls[0][0])).toContain('<secret:field-redacted>');
  });

  it('lists MCP bearer secret status without exposing values', async () => {
    const tool = new ManageAgentConfigTool();

    await tool.run({
      action: 'upsert_secret',
      secret: {
        name: 'MCP_TOKEN',
        description: 'Token placeholder',
      },
    }, ctx);
    await tool.run({
      action: 'upsert_mcp_server',
      mcp_server: {
        id: 'demo',
        name: 'Demo',
        description: 'Demo MCP',
        url: 'https://example.com/mcp',
        bearer_secret: 'mcp_token',
      },
    }, ctx);

    const listed = await tool.run({ action: 'list' }, ctx);

    expect(JSON.stringify(listed)).not.toContain('secret-value');
    expect(listed.data).toMatchObject({
      mcp_servers: [{
        id: 'demo',
        bearer_secret: 'MCP_TOKEN',
        bearer_secret_status: 'empty',
      }],
    });
  });

  it('tests MCP servers by reading tools/list without writing config or returning token', async () => {
    const confirm = vi.fn<ToolContext['confirm']>(async () => true);
    const localCtx = { ...ctx, confirm } as ToolContext;
    const tool = new ManageAgentConfigTool();
    const calls: Array<{ headers: Record<string, string>; body?: string; method?: string }> = [];
    const fetchMock = vi.fn(async (_url: string, init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    }) => {
      calls.push({
        method: init?.method,
        headers: init?.headers ?? {},
        body: init?.body,
      });

      const body = JSON.parse(init?.body || '{}') as { method?: string };
      const responseBody = body.method === 'tools/list'
        ? {
            jsonrpc: '2.0',
            id: 2,
            result: {
              tools: [{
                name: 'query_menu',
                description: 'Query menu items',
                inputSchema: {
                  type: 'object',
                  properties: { keyword: { type: 'string' } },
                },
              }],
            },
          }
        : { jsonrpc: '2.0', id: 1, result: {} };

      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: (name: string) => name.toLowerCase() === 'mcp-session-id' ? 'sid-1' : 'application/json' },
        text: async () => JSON.stringify(responseBody),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    await tool.run({
      action: 'upsert_secret',
      secret: {
        name: 'MCP_TOKEN',
        secret_value: 'secret-value',
      },
    }, localCtx);

    const result = await tool.run({
      action: 'test_mcp_server',
      mcp_server: {
        id: 'demo',
        name: 'Demo',
        url: 'https://example.com/mcp',
        bearer_secret: 'mcp_token',
      },
    }, localCtx);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('secret-value');
    expect(result.data).toMatchObject({
      tool_count: 1,
      next_step: 'summarize_description_then_upsert_mcp_server',
      tools: [{ name: 'query_menu' }],
    });
    expect(JSON.stringify(result.data)).toContain('description');
    expect(calls.some(c => c.headers.Authorization === 'Bearer secret-value')).toBe(true);
    expect(readConfigFile().mcpServers).toBeUndefined();
  });
});
