// ============================================
// 系统工具:manage_agent_config(受控编辑 agent 本地配置)
// ============================================
//
// 这是给模型的“配置协助”口子,不是把 config.json 当普通文件交出去:
// - 读取时只返回 Secret 名称/说明,不返回 value
// - 写入走 config-store 的同一套校验、归一化和 0600 写盘
// - 工具标记为 danger:true,写配置前由 ToolRunner 统一请用户确认
//
// 注意:如果用户把新的 secret 明文直接发在聊天里,模型天然已经看到了它。
// 本工具会用 secret_value 这个字段名,让日志/trace/turns 的字段级脱敏规则
// 能把工具参数里的值遮住;更安全的路径仍然是让用户在配置面板里填写 value。
// ============================================

import { z } from 'zod';
import { Tool, ToolContext, ToolResult } from '../../contract.js';
import {
  readConfigFile,
  validateStored,
  writeConfigFile,
  type StoredConfig,
} from '../../../platform/config-store.js';
import {
  normalizeSecretName,
  redactSensitive,
  type StoredSecret,
} from '../../../platform/secrets.js';
import { McpClient, type McpServerConfig, type McpToolSpec } from '../../../mcp/client.js';

const ManageAgentConfigSchema = z.object({
  action: z
    .enum([
      'list',
      'upsert_secret',
      'delete_secret',
      'upsert_mcp_server',
      'delete_mcp_server',
      'test_mcp_server',
    ])
    .describe('要执行的配置操作'),
  reason: z
    .string()
    .optional()
    .describe('为什么需要修改配置。会展示给用户确认,请写清业务目的'),
  secret: z
    .object({
      name: z.string().describe('Secret 名称,建议用大写字母/数字/下划线'),
      secret_value: z
        .string()
        .optional()
        .describe('新的 Secret 明文值。通常留空来创建待填写槽位;只有用户已经把值明确交给你并要求代写时才填'),
      description: z.string().optional().describe('Secret 的人类可读用途说明'),
    })
    .optional()
    .describe('upsert_secret/delete_secret 使用'),
  mcp_server: z
    .object({
      id: z.string().describe('MCP Server id,供 load_mcp(server_id) 使用'),
      name: z.string().optional().describe('显示名称'),
      description: z
        .string()
        .optional()
        .describe('给模型看的用途说明。有凭证且能 test_mcp_server 时根据 tools/list 总结;凭证未就绪时先写清这个服务的预期用途和待验证边界'),
      url: z.string().optional().describe('HTTP/HTTPS MCP endpoint'),
      enabled: z.boolean().optional().describe('是否启用'),
      bearer_secret: z.string().optional().describe('关联的 Secret 名称,由 BaseAgent 在 TS 侧注入 Authorization Bearer'),
      headers: z.record(z.string()).optional().describe('额外固定 HTTP header,不要在这里放密钥;Bearer token 请用 bearer_secret'),
    })
    .optional()
    .describe('upsert_mcp_server/delete_mcp_server 使用'),
});

type ManageAgentConfigArgs = z.infer<typeof ManageAgentConfigSchema>;

export interface ManageAgentConfigToolConfig {
  /** 配置写盘后的热刷新钩子。失败只作为 warning 回给模型,不回滚已保存配置。 */
  onChanged?: () => Promise<void> | void;
}

export class ManageAgentConfigTool implements Tool {
  name = 'manage_agent_config';
  description = [
    '查看或修改 BaseAgent 的本地配置,主要用于协助用户配置 Secret 与 HTTP MCP Server。',
    '',
    '可做的事:',
    '  · list: 查看当前 Secret 名称/说明和 MCP Server 摘要;不会返回任何 Secret value。',
    '  · upsert_secret: 新增或更新 Secret。secret_value 可选;若不提供,就是创建一个让用户稍后填写的空槽。',
    '  · delete_secret: 删除 Secret。',
    '  · upsert_mcp_server: 新增或更新 MCP Server,可关联 bearer_secret。description 应根据 test_mcp_server 返回的 tools/list 总结,不要只写“某某 MCP”。',
    '  · delete_mcp_server: 删除 MCP Server。',
    '  · test_mcp_server: 不写配置,只初始化指定 MCP Server 并读取 tools/list,用于在凭证已就绪时确认 URL、Bearer Secret 与协议是否可用。',
    '',
    '推荐流程:',
    '  · 用户说“接入某个 MCP”时,优先把它当成配置搭建任务:确定 server id/name/url/用途,再准备 Secret 绑定。',
    '  · 如果这个 MCP 需要 token/API key,而当前 list 里没有可用 Secret value,先用 upsert_secret 创建空槽,并用 upsert_mcp_server 保存关联 bearer_secret 的 MCP 草稿。',
    '  · 然后告诉用户去配置面板给这个 Secret 填值,用户填完并回复后,再 test_mcp_server 读取 tools/list。',
    '  · 只有 test_mcp_server 成功返回 tools/list 后,才把 description 改成基于真实工具 schema 的精确说明。',
    '',
    '敏感信息处理:',
    '  · 每次写入都会请求用户确认。',
    '  · 不要读取、打印、复述 Secret value。',
    '  · 第三方 token/API key 是用户持有的凭证;在配置流程里,默认只为它创建命名清晰的槽位,让用户在配置面板填写值。',
    '  · MCP/Secret 保存后框架会尽量热刷新当前会话;若壳不支持热刷新,再提示用户新建会话。',
  ].join('\n');

  parameters = ManageAgentConfigSchema;
  needs = [] as const;
  danger = false;

  constructor(private config: ManageAgentConfigToolConfig = {}) {}

  async run(args: ManageAgentConfigArgs, ctx: ToolContext): Promise<ToolResult> {
    ctx.logger.info('准备编辑 agent 配置', {
      action: args.action,
      reason: args.reason,
    });

    try {
      if (args.action === 'list') return this.list();
      if (args.action === 'test_mcp_server') return await this.testMcpServer(args.mcp_server);
      const confirmed = await ctx.confirm({
        toolName: this.name,
        reason: args.reason || `确认执行配置操作: ${args.action}`,
        args: redactSensitive(args) as Record<string, unknown>,
      });
      if (!confirmed) return { ok: false, error: '用户拒绝修改配置' };

      let result: ToolResult;
      if (args.action === 'upsert_secret') result = this.upsertSecret(args.secret);
      else if (args.action === 'delete_secret') result = this.deleteSecret(args.secret);
      else if (args.action === 'upsert_mcp_server') result = this.upsertMcpServer(args.mcp_server);
      else if (args.action === 'delete_mcp_server') result = this.deleteMcpServer(args.mcp_server);
      else return { ok: false, error: `未知配置操作: ${(args as { action?: string }).action}` };

      if (result.ok) return await this.afterChange(result);
      return result;
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async afterChange(result: ToolResult): Promise<ToolResult> {
    if (!this.config.onChanged) return result;

    try {
      await this.config.onChanged();
      const data = result.data && typeof result.data === 'object'
        ? { ...(result.data as Record<string, unknown>), hot_reloaded: true, needs_restart: false }
        : { value: result.data, hot_reloaded: true, needs_restart: false };
      return { ...result, data };
    } catch (e) {
      const data = result.data && typeof result.data === 'object'
        ? {
            ...(result.data as Record<string, unknown>),
            hot_reloaded: false,
            needs_restart: true,
            hot_reload_warning: e instanceof Error ? e.message : String(e),
          }
        : {
            value: result.data,
            hot_reloaded: false,
            needs_restart: true,
            hot_reload_warning: e instanceof Error ? e.message : String(e),
          };
      return { ...result, data };
    }
  }

  private list(): ToolResult {
    const stored = readConfigFile();
    return {
      ok: true,
      data: sanitizeConfigForModel(stored),
    };
  }

  private upsertSecret(secret: ManageAgentConfigArgs['secret']): ToolResult {
    if (!secret?.name) return { ok: false, error: 'upsert_secret 需要 secret.name' };

    writeConfigFile({
      secrets: [{
        name: secret.name,
        value: secret.secret_value,
        description: secret.description,
      }],
    });

    return {
      ok: true,
      data: {
        changed: 'secret',
        name: secret.name.trim().toUpperCase(),
        has_value: !!secret.secret_value,
        placeholder: !secret.secret_value,
        needs_restart: !this.config.onChanged,
        summary: `Secret ${secret.name.trim().toUpperCase()} 已保存`,
        note: secret.secret_value
          ? '配置已保存。Secret value 不会返回;当前会话会尽量热刷新。'
          : 'Secret 空槽已创建。请告诉用户在配置面板填写该 Secret 的值,保存后再测试依赖它的 MCP Server。',
        next_step: secret.secret_value
          ? 'restart_session_if_needed'
          : 'ask_user_to_fill_secret_value_then_test_mcp_server',
      },
    };
  }

  private deleteSecret(secret: ManageAgentConfigArgs['secret']): ToolResult {
    if (!secret?.name) return { ok: false, error: 'delete_secret 需要 secret.name' };

    writeConfigFile({
      secrets: [{ name: secret.name, delete: true }],
    });

    return {
      ok: true,
      data: {
        changed: 'secret',
        name: secret.name.trim().toUpperCase(),
        deleted: true,
        needs_restart: !this.config.onChanged,
        summary: `Secret ${secret.name.trim().toUpperCase()} 已删除`,
      },
    };
  }

  private upsertMcpServer(server: ManageAgentConfigArgs['mcp_server']): ToolResult {
    if (!server?.id) return { ok: false, error: 'upsert_mcp_server 需要 mcp_server.id' };

    const stored = readConfigFile();
    const secrets = storedSecrets(stored);
    const current = stored.mcpServers ?? [];
    const existing = current.find(s => s.id === server.id);
    const nextServer = {
      ...(existing ?? {}),
      id: server.id,
      name: server.name ?? existing?.name ?? server.id,
      description: server.description ?? existing?.description,
      url: server.url ?? existing?.url ?? '',
      enabled: server.enabled ?? existing?.enabled ?? true,
      bearerSecret: server.bearer_secret ?? existing?.bearerSecret,
      headers: server.headers ?? existing?.headers,
    };

    const next = [
      ...current.filter(s => s.id !== server.id),
      nextServer,
    ];
    writeConfigFile({ mcpServers: next });

    return {
      ok: true,
      data: {
        changed: 'mcp_server',
        server: sanitizeMcpServer(nextServer, secrets),
        warnings: mcpServerWarnings(nextServer, secrets),
        next_step: mcpServerNextStep(nextServer, secrets),
        needs_restart: !this.config.onChanged,
        summary: `MCP Server ${nextServer.id} 已保存`,
        note: mcpServerNextStep(nextServer, secrets) === 'ask_user_to_fill_secret_value_then_test_mcp_server'
          ? 'MCP Server 草稿已保存并绑定 Secret 空槽。请告诉用户填写 Secret 值后再测试。'
          : '配置已保存。当前会话会尽量热加载 MCP Server,之后可用 load_mcp 查看。',
      },
    };
  }

  private deleteMcpServer(server: ManageAgentConfigArgs['mcp_server']): ToolResult {
    if (!server?.id) return { ok: false, error: 'delete_mcp_server 需要 mcp_server.id' };

    const stored = readConfigFile();
    const current = stored.mcpServers ?? [];
    writeConfigFile({
      mcpServers: current.filter(s => s.id !== server.id),
    });

    return {
      ok: true,
      data: {
        changed: 'mcp_server',
        id: server.id,
        deleted: true,
        needs_restart: !this.config.onChanged,
        summary: `MCP Server ${server.id} 已删除`,
      },
    };
  }

  private async testMcpServer(serverPatch: ManageAgentConfigArgs['mcp_server']): Promise<ToolResult> {
    const stored = readConfigFile();
    const secrets = storedSecrets(stored);
    const resolved = resolveMcpServerForTest(serverPatch, stored);
    if (!resolved.ok) return { ok: false, error: resolved.error };

    const server = resolved.server;
    const errors = validateStored({ mcpServers: [server] });
    if (errors.length > 0) return { ok: false, error: errors.join(';') };

    const warnings = mcpServerWarnings(server, secrets);
    if (warnings.length > 0) {
      return {
        ok: false,
        error: warnings.join(';'),
        data: {
          server: sanitizeMcpServer(server, secrets),
          next_step: mcpServerNextStep(server, secrets),
          guidance: '这个 MCP Server 的凭证还没就绪。先创建或绑定 Secret 槽位,请用户在配置面板填写值;填完后再测试连接。',
        },
      };
    }

    const client = new McpClient({ server, secrets });
    try {
      await client.initialize();
      const tools = await client.listTools();
      return {
        ok: true,
        data: {
          server: sanitizeMcpServer(server, secrets),
          tool_count: tools.length,
          tools: tools.slice(0, 50).map(sanitizeMcpTool),
          truncated: tools.length > 50,
          usage: '测试已读取 tools/list。请根据 tools[].name/description/inputSchema 总结这个 MCP 适合什么任务、主要能力和边界,写成 80-120 字 description 后调用 upsert_mcp_server 保存。需要实际调用时,先 load_mcp(server_id),再在 execute_python 中调用 mcp_call(server_id, tool_name, arguments)。',
          next_step: 'summarize_description_then_upsert_mcp_server',
        },
      };
    } catch (e) {
      return {
        ok: false,
        error: `MCP Server ${server.name || server.id} 测试失败: ${formatMcpError(e)}`,
        data: { server: sanitizeMcpServer(server, secrets) },
      };
    } finally {
      await client.close().catch(() => {});
    }
  }
}

function sanitizeConfigForModel(stored: StoredConfig): Record<string, unknown> {
  const secrets = storedSecrets(stored);
  return {
    secrets: secrets.map(s => ({
      name: s.name,
      description: s.description || '',
      has_value: !!s.value,
    })),
    mcp_servers: (stored.mcpServers ?? []).map(s => sanitizeMcpServer(s, secrets)),
  };
}

function sanitizeMcpServer(
  server: NonNullable<StoredConfig['mcpServers']>[number],
  secrets: readonly StoredSecret[] = [],
): Record<string, unknown> {
  const bearerSecret = server.bearerSecret ? normalizeSecretName(server.bearerSecret) : '';
  const secret = bearerSecret ? secrets.find(s => normalizeSecretName(s.name) === bearerSecret) : undefined;
  return {
    id: server.id,
    name: server.name || server.id,
    description: server.description || '',
    url: server.url,
    enabled: server.enabled !== false,
    bearer_secret: bearerSecret,
    bearer_secret_status: bearerSecret
      ? secret?.value ? 'ready' : secret ? 'empty' : 'missing'
      : 'unused',
    headers: server.headers ? Object.keys(server.headers) : [],
  };
}

function resolveMcpServerForTest(
  patch: ManageAgentConfigArgs['mcp_server'],
  stored: StoredConfig,
): { ok: true; server: McpServerConfig } | { ok: false; error: string } {
  if (!patch?.id) return { ok: false, error: 'test_mcp_server 需要 mcp_server.id' };

  const existing = (stored.mcpServers ?? []).find(s => s.id === patch.id);
  const merged = {
    ...(existing ?? {}),
    id: patch.id,
    name: patch.name ?? existing?.name ?? patch.id,
    description: patch.description ?? existing?.description,
    url: patch.url ?? existing?.url ?? '',
    enabled: patch.enabled ?? existing?.enabled ?? true,
    bearerSecret: patch.bearer_secret
      ? normalizeSecretName(patch.bearer_secret)
      : existing?.bearerSecret ? normalizeSecretName(existing.bearerSecret) : undefined,
    headers: patch.headers ?? existing?.headers,
  };

  if (!merged.url) {
    return {
      ok: false,
      error: `MCP Server ${patch.id} 没有 URL。请传入 mcp_server.url,或先保存完整配置。`,
    };
  }

  return { ok: true, server: merged };
}

function mcpServerWarnings(
  server: NonNullable<StoredConfig['mcpServers']>[number],
  secrets: readonly StoredSecret[],
): string[] {
  const warnings: string[] = [];
  if (!server.bearerSecret) return warnings;

  const name = normalizeSecretName(server.bearerSecret);
  const secret = secrets.find(s => normalizeSecretName(s.name) === name);
  if (!secret) warnings.push(`MCP Server ${server.name || server.id} 引用的 Secret 不存在: ${name}`);
  else if (!secret.value) warnings.push(`MCP Server ${server.name || server.id} 引用的 Secret 值为空: ${name}`);
  return warnings;
}

function mcpServerNextStep(
  server: NonNullable<StoredConfig['mcpServers']>[number],
  secrets: readonly StoredSecret[],
): string {
  if (!server.bearerSecret) return 'test_mcp_server';

  const name = normalizeSecretName(server.bearerSecret);
  const secret = secrets.find(s => normalizeSecretName(s.name) === name);
  if (!secret || !secret.value) return 'ask_user_to_fill_secret_value_then_test_mcp_server';
  return 'test_mcp_server';
}

function sanitizeMcpTool(tool: McpToolSpec): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description || '',
    inputSchema: tool.inputSchema ?? {
      type: 'object',
      properties: {},
      additionalProperties: true,
    },
  };
}

function formatMcpError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b401\b/.test(message)) {
    return `${message}。认证失败:请检查这个 MCP Server 的 Bearer Secret 是否选对,Secret 值是否过期。`;
  }
  return message;
}

function storedSecrets(stored: StoredConfig): StoredSecret[] {
  return (stored.secrets ?? []).map(s => ({
    name: normalizeSecretName(s.name),
    value: 'value' in s && typeof s.value === 'string' ? s.value : '',
    description: typeof s.description === 'string' ? s.description : undefined,
  }));
}
