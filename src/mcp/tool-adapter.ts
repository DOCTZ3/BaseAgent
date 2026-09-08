import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '../tools/index.js';
import type { McpServerConfig, McpToolSpec, McpCallResult } from './client.js';
import { McpClient as DefaultMcpClient } from './client.js';
import type { StoredSecret } from '../platform/secrets.js';

interface McpRuntimeLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

interface McpRuntimeOptions {
  servers: readonly McpServerConfig[];
  secrets: readonly StoredSecret[];
  logger: McpRuntimeLogger;
  clientFactory?: (
    server: McpServerConfig,
    secrets: readonly StoredSecret[],
  ) => McpTransportClient;
}

export interface McpTransportClient {
  initialize(): Promise<void>;
  listTools(): Promise<McpToolSpec[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
  close(): Promise<void>;
}

interface McpEntry {
  server: McpServerConfig;
  client?: McpTransportClient;
  tools?: McpToolSpec[];
}

export class McpRuntime {
  private entries = new Map<string, McpEntry>();
  private clientFactory: (
    server: McpServerConfig,
    secrets: readonly StoredSecret[],
  ) => McpTransportClient;

  constructor(private options: McpRuntimeOptions) {
    this.clientFactory =
      options.clientFactory ?? ((server, secrets) => new DefaultMcpClient({ server, secrets }));

    this.rebuildEntries(options.servers);
  }

  get hasServers(): boolean {
    return this.entries.size > 0;
  }

  listServers() {
    return Array.from(this.entries.values()).map(entry => ({
      id: entry.server.id,
      name: entry.server.name || entry.server.id,
      description: entry.server.description || '',
      loaded: !!entry.tools,
      tool_count: entry.tools?.length,
    }));
  }

  /**
   * 热刷新 MCP 配置。
   *
   * 已加载的远端 client 带着旧 URL / token / session header,不能复用。
   * 所以刷新时先关闭旧连接,再用新配置重建入口表。这样下一次 load_mcp
   * 看到的就是最新 server 清单,下一次 mcp_call 也会用最新 Secret。
   */
  async refresh(
    servers: readonly McpServerConfig[],
    secrets: readonly StoredSecret[],
  ): Promise<void> {
    await this.close();
    this.options = { ...this.options, servers, secrets };
    this.entries.clear();
    this.rebuildEntries(servers);
    this.options.logger.info('MCP Runtime 已刷新配置', {
      servers: this.listServers().map(s => s.id),
    });
  }

  async load(serverId?: string): Promise<ToolResult> {
    if (!serverId) {
      return {
        ok: true,
        data: {
          servers: this.listServers(),
          usage: '先选择 server_id 调 load_mcp({"server_id":"..."}) 查看工具 schema,再在 execute_python 中调用 mcp_call(server_id, tool_name, arguments)。',
        },
      };
    }

    const entry = this.entries.get(serverId);
    if (!entry) {
      return {
        ok: false,
        error: `MCP Server 不存在或未启用: ${serverId}`,
        data: { available: this.listServers() },
      };
    }

    const missingSecret = this.missingBearerSecret(entry.server);
    if (missingSecret) {
      return {
        ok: false,
        error: `MCP Server ${entry.server.name || entry.server.id} 引用的 Secret 不存在或值为空: ${missingSecret}`,
      };
    }

    if (!entry.tools) {
      const client = entry.client ?? this.clientFactory(entry.server, this.options.secrets);
      try {
        await client.initialize();
        entry.tools = await client.listTools();
        entry.client = client;
        this.options.logger.info('MCP Server 已加载工具列表', {
          server: entry.server.id,
          tools: entry.tools.map(t => t.name),
        });
      } catch (e) {
        await client.close().catch(() => {});
        if (entry.client === client) entry.client = undefined;
        return {
          ok: false,
          error: `MCP Server ${entry.server.name || entry.server.id} 加载失败: ${formatMcpLoadError(e)}`,
        };
      }
    }

    return {
      ok: true,
      data: {
        server: {
          id: entry.server.id,
          name: entry.server.name || entry.server.id,
          description: entry.server.description || '',
        },
        tools: entry.tools.map(t => ({
          name: t.name,
          description: t.description || '',
          inputSchema: t.inputSchema ?? {
            type: 'object',
            properties: {},
            additionalProperties: true,
          },
        })),
        usage: '在 execute_python 里调用 mcp_call(server_id, tool_name, arguments)。arguments 必须按对应 inputSchema 传对象。',
      },
    };
  }

  async call(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const loaded = await this.load(serverId);
    if (!loaded.ok) return loaded;

    const entry = this.entries.get(serverId)!;
    if (!entry.client || !entry.tools) {
      return { ok: false, error: `MCP Server ${serverId} 未完成加载` };
    }

    if (!entry.tools.some(t => t.name === toolName)) {
      return {
        ok: false,
        error: `MCP 工具不存在: ${toolName}`,
        data: { available: entry.tools.map(t => t.name) },
      };
    }

    const result = await entry.client.callTool(toolName, args);
    if (result.isError) {
      return {
        ok: false,
        error: stringifyMcpContent(result.content ?? result),
      };
    }

    return { ok: true, data: result };
  }

  async close(): Promise<void> {
    for (const entry of this.entries.values()) {
      await entry.client?.close().catch(() => {});
      entry.client = undefined;
      entry.tools = undefined;
    }
  }

  private missingBearerSecret(server: McpServerConfig): string | undefined {
    if (!server.bearerSecret) return undefined;
    const found = this.options.secrets.find(s => s.name === server.bearerSecret);
    return found?.value ? undefined : server.bearerSecret;
  }

  private rebuildEntries(servers: readonly McpServerConfig[]): void {
    for (const server of servers.filter(s => s.enabled)) {
      this.entries.set(server.id, { server });
    }
  }
}

export class LoadMcpTool implements Tool {
  name = 'load_mcp';
  parameters = z.object({
    server_id: z.string().optional().describe('MCP Server id。留空则只列出已配置的 server'),
  });
  needs = [] as const;
  danger = false;

  constructor(private runtime: McpRuntime) {}

  get description(): string {
    const servers = this.runtime.listServers()
      .map(s => {
        const label = `${s.id}${s.name && s.name !== s.id ? ` (${s.name})` : ''}`;
        return `  - ${label}${s.description ? `: ${s.description}` : ''}`;
      })
      .join('\n');
    return [
      '按需加载一个已配置 MCP Server 的工具列表与 JSON Schema。',
      '不执行远程业务动作,只返回可用工具说明。MCP 的认证、session header、SSE 解析由 BaseAgent 处理。',
      '当前已配置并启用的 MCP Server:',
      servers || '  (无)',
      '先选一个 server_id 调 load_mcp({ "server_id": "..." }) 获取工具 schema。',
      '拿到 schema 后,在 execute_python 里调用 mcp_call(server_id, tool_name, arguments) 执行具体 MCP 工具。',
    ].join('\n');
  }

  async run(args: { server_id?: string }, _ctx: ToolContext): Promise<ToolResult> {
    return this.runtime.load(args.server_id);
  }
}

export class McpCallTool implements Tool {
  name = 'mcp_call';
  description = [
    '在 Python 代码里调用已配置 MCP Server 的具体工具。',
    '先用 load_mcp(server_id) 查看工具列表和 inputSchema,再按 schema 传 arguments。',
    'Secret value 不会暴露给 Python;BaseAgent 会在 TS 框架侧为 MCP 请求附加认证信息。',
  ].join('\n');
  parameters = z.object({
    server_id: z.string().describe('MCP Server id'),
    tool_name: z.string().describe('MCP 工具名,必须来自 load_mcp 返回的 tools[].name'),
    arguments: z.record(z.unknown()).optional().describe('传给 MCP 工具的参数对象'),
  });
  needs = [] as const;
  danger = true;

  constructor(private runtime: McpRuntime) {}

  async run(
    args: { server_id: string; tool_name: string; arguments?: Record<string, unknown> },
    _ctx: ToolContext,
  ): Promise<ToolResult> {
    return this.runtime.call(args.server_id, args.tool_name, args.arguments ?? {});
  }
}

export class McpProxyTool implements Tool {
  name: string;
  description: string;
  parameters = z.object({}).passthrough();
  parameterSchema: Record<string, unknown>;
  needs = [] as const;
  danger = true;

  constructor(
    private server: McpServerConfig,
    private remoteTool: McpToolSpec,
    private client: McpTransportClient,
    localName: string,
  ) {
    this.name = localName;
    this.description = [
      `MCP tool from ${server.name || server.id}: ${remoteTool.name}.`,
      remoteTool.description || '',
      'Protocol, authentication, session headers, and SSE parsing are handled by BaseAgent.',
    ].filter(Boolean).join('\n');
    this.parameterSchema = remoteTool.inputSchema ?? {
      type: 'object',
      properties: {},
      additionalProperties: true,
    };
  }

  async run(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const result = await this.client.callTool(this.remoteTool.name, args);

    if (result.isError) {
      return {
        ok: false,
        error: stringifyMcpContent(result.content ?? result),
      };
    }

    return {
      ok: true,
      data: result,
    };
  }
}

export function localMcpToolName(serverId: string, remoteName: string): string {
  const sid = sanitizeName(serverId);
  const tool = sanitizeName(remoteName);
  return `mcp_${sid}_${tool}`.slice(0, 64);
}

export function sanitizeName(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)
    || 'tool';
}

function stringifyMcpContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(item => {
        if (item && typeof item === 'object' && 'text' in item) {
          return String((item as { text?: unknown }).text ?? '');
        }
        return JSON.stringify(item);
      })
      .filter(Boolean)
      .join('\n');
  }
  return JSON.stringify(content);
}

function formatMcpLoadError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b401\b/.test(message)) {
    return `${message}。认证失败:请检查这个 MCP Server 的 Bearer Secret 是否选对,Secret 值是否过期。`;
  }
  return message;
}
