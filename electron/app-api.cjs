// ============================================
// App API —— 本地 IPC 与未来 RemoteHub 共用的业务入口
// ============================================
//
// 这里不直接 import Electron,也不保存窗口状态。调用方把会话、配置、模块加载、
// 事件广播这些依赖传进来,本文件只负责“这类 UI 操作应该怎样改业务状态”。
//
// 目标是让:
//   Electron IPC -> AppApi
//   RemoteHub    -> AppApi
// 走同一套逻辑,避免手机端和电脑端各写一份 skill/MCP/memory 处理。

function createAppApi(deps) {
  const {
    ensureSession,
    getSession,
    switchSession,
    restartSession,
    loadEffectiveConfig,
    loadAppConfigOverrides,
    loadConfigStore,
    loadPlatformConfig,
    loadPlatformSecrets,
    loadMcpModule,
    loadDeepSeekModule,
    loadSessionStore,
    getUserDataDir,
    getRemoteHubInfo,
    getRelayClientInfo,
    createRemotePairCode,
    openPath,
    sendAgentEvent,
    sendSessionChanged,
    sendSkillsChanged,
    sendConfigChanged,
    sendMemoryChanged,
  } = deps;

  return {
    async runAgent(runId, input, options = {}) {
      const s = await ensureSession();
      const send = event => sendAgentEvent?.(runId, event);

      try {
        const result = await s.run(input, send);
        return { ok: true, stopReason: result.stopReason, answer: result.answer };
      } catch (err) {
        console.error('本轮执行失败', err);
        return {
          ok: false,
          error: err && err.message ? err.message : String(err),
          detail: err && err.detail ? String(err.detail) : undefined,
          code: err && err.code ? String(err.code) : undefined,
        };
      } finally {
        if (options.notifySessionChanged) sendSessionChanged?.();
      }
    },

    abortAgent() {
      getSession()?.abort();
      return true;
    },

    async info() {
      const s = getSession();
      const c = s ? s.config : await loadEffectiveConfig();
      const main = c.models.main;
      const shellEnabled =
        s ? s.info.shellEnabled : c.shell.enabled && !!c.workspace && c.security.allowDangerousTools;

      return {
        model: s ? s.info.model : main.model,
        baseURL: s ? s.info.baseURL : main.baseURL,
        visionModel: s ? s.info.visionModel || '' : c.models.vision?.model || '',
        workspace: c.workspace || '',
        pythonEnabled: c.python.enabled,
        allowDangerousTools: c.security.allowDangerousTools,
        shellEnabled,
        shellConfigured: c.shell.enabled,
        subAgentEnabled: c.subAgent.enabled,
        memoryEnabled: c.memory.enabled,
        maxTokens: c.models.main.maxTokens,
        maxSteps: c.execution.maxSteps,
        enableThinking: c.models.main.enableThinking,
        userDataDir: getUserDataDir(),
        apiKeyMasked: maskKey(main.apiKey),
        secrets: (c.secrets?.items || []).map(secretMeta),
        mcpServers: c.mcp?.servers || [],
        mcpTools: s ? s.info.mcpTools : [],
        remoteHub: getRemoteHubInfo?.() || null,
        relayClient: getRelayClientInfo?.() || null,
      };
    },

    async notices() {
      const s = getSession();
      if (s) return s.notices;

      const c = await loadEffectiveConfig();
      const notices = [];
      if (!c.models.main.apiKey) {
        notices.push({
          level: 'error',
          message: 'DEEPSEEK_API_KEY 未配置,请先在配置面板填写 API key。',
        });
      }
      if (!c.workspace) {
        notices.push({
          level: 'warn',
          message: 'WORKSPACE 未配置,文件类工具与代码执行将全部被拒绝。',
        });
      }
      return notices;
    },

    async openUserDataDir() {
      await openPath(getUserDataDir());
      return true;
    },

    createRemotePairCode(options) {
      return createRemotePairCode?.(options) || { ok: false, error: 'RemoteHub 未启动' };
    },

    async configGet() {
      const { readConfigFile } = await loadConfigStore();
      const cfg = readConfigFile();
      return {
        ...cfg,
        secrets: (cfg.secrets || []).map(secretMeta),
      };
    },

    async configSave(patch) {
      const { writeConfigFile } = await loadConfigStore();
      const before = getSession() ? await loadEffectiveConfig() : null;

      try {
        writeConfigFile(patch);
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : String(err) };
      }

      sendConfigChanged?.();

      const session = getSession();
      if (session && before) {
        const after = await loadEffectiveConfig();
        if (!requiresFullSessionRestart(before, after)) {
          try {
            await session.refreshConfig(await loadAppConfigOverrides());
            sendSessionChanged?.();
            return { ok: true, needsRestart: false, hotReloaded: true };
          } catch (err) {
            console.error('MCP 配置热刷新失败', err);
            return {
              ok: true,
              needsRestart: true,
              hotReloaded: false,
              warning: err && err.message ? err.message : String(err),
            };
          }
        }
      }

      return { ok: true, needsRestart: true };
    },

    async configTestMcp(payload) {
      const { readConfigFile, validateStored } = await loadConfigStore();
      const { mergeSecretPatches, normalizeSecretName } = await loadPlatformSecrets();
      const { McpRuntime } = await loadMcpModule();

      try {
        const server = normalizeMcpServerForTest(payload?.server, normalizeSecretName);
        const secretPatches = Array.isArray(payload?.secrets) ? payload.secrets : [];

        const errors = validateStored({ mcpServers: [server], secrets: secretPatches });
        if (errors.length > 0) return { ok: false, error: errors.join(';') };

        const stored = readConfigFile();
        const secrets = mergeSecretPatches(stored.secrets || [], secretPatches);
        const loaded = await loadMcpToolsForConfigTest(McpRuntime, server, secrets);
        if (!loaded.ok) return { ok: false, error: loaded.error || 'MCP 测试失败' };

        const data = loaded.data || {};
        const tools = Array.isArray(data.tools) ? data.tools : [];
        return {
          ok: true,
          server: data.server || { id: server.id, name: server.name },
          toolCount: tools.length,
          tools: tools.slice(0, 50).map(t => ({
            name: String(t.name || ''),
            description: String(t.description || ''),
            inputSchema: t.inputSchema,
          })),
          truncated: tools.length > 50,
        };
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : String(err) };
      }
    },

    async configDescribeMcp(payload) {
      const { readConfigFile, validateStored } = await loadConfigStore();
      const { mergeSecretPatches, normalizeSecretName } = await loadPlatformSecrets();
      const { McpRuntime } = await loadMcpModule();

      try {
        const server = normalizeMcpServerForTest(payload?.server, normalizeSecretName);
        const secretPatches = Array.isArray(payload?.secrets) ? payload.secrets : [];

        const errors = validateStored({ mcpServers: [server], secrets: secretPatches });
        if (errors.length > 0) return { ok: false, error: errors.join(';') };

        const stored = readConfigFile();
        const secrets = mergeSecretPatches(stored.secrets || [], secretPatches);
        const loaded = await loadMcpToolsForConfigTest(McpRuntime, server, secrets);
        if (!loaded.ok) return { ok: false, error: loaded.error || 'MCP Server 加载失败' };

        const config = await loadEffectiveConfig();
        const main = config.models.main;
        if (!main.apiKey) {
          return { ok: false, error: '主模型 API key 未配置,无法生成 MCP 用途说明' };
        }

        const { DeepSeekAdapter } = await loadDeepSeekModule();
        const llm = new DeepSeekAdapter({
          apiKey: main.apiKey,
          baseURL: main.baseURL,
          model: main.model,
          enableThinking: !!main.enableThinking,
          maxTokens: Math.min(main.maxTokens || 700, 700),
          temperature: 0.2,
          retry: config.retry,
          logger: console,
        });

        const tools = Array.isArray(loaded.data?.tools) ? loaded.data.tools : [];
        const response = await llm.complete({
          responseFormat: 'json_object',
          traceLabel: 'config:mcp-description',
          messages: [
            {
              role: 'system',
              content: [
                '你负责为 BaseAgent 配置页生成 MCP Server 的用途说明。',
                '只输出 JSON,格式为 {"description":"..."}。',
                'description 用中文,80 到 120 字左右,说明这个 MCP 适合什么任务、主要能力和使用边界。',
                '不要提 token、密钥、认证、HTTP、SSE、实现细节,不要编造工具列表以外的能力。',
              ].join('\n'),
            },
            {
              role: 'user',
              content: JSON.stringify({
                server: {
                  id: server.id,
                  name: server.name,
                  currentDescription: server.description || '',
                  endpoint: safeMcpEndpointLabel(server.url),
                },
                toolCount: tools.length,
                tools: summarizeMcpToolsForPrompt(tools),
                truncated: tools.length > 30,
              }, null, 2),
            },
          ],
        });

        const parsed = JSON.parse(response.content || '{}');
        const description = cleanGeneratedDescription(parsed.description);
        if (!description) return { ok: false, error: '模型没有生成有效说明' };

        return { ok: true, description };
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : String(err) };
      }
    },

    restartSession,

    async listHistory() {
      const { listSessions } = await loadSessionStore();
      const { loadConfig } = await loadPlatformConfig();
      return listSessions(loadConfig(await loadAppConfigOverrides()).trace.dir);
    },

    async currentHistory(options = {}) {
      const s = getSession();
      if (!s) {
        if (options.resumeLatest) {
          const sessions = await this.listHistory();
          const latest = sessions[0]?.sessionId;
          if (latest) return this.openHistory(latest);
        }
        return { sessionId: null, turns: [] };
      }

      const session = await ensureSession();
      return { sessionId: session.sessionId, turns: session.history() };
    },

    async openHistory(sessionId) {
      const s = await switchSession(sessionId);
      return { sessionId: s.sessionId, turns: s.history() };
    },

    async newHistory() {
      const s = await switchSession(undefined);
      return { sessionId: s.sessionId, turns: [] };
    },

    async listSkills() {
      if (!getSession()) return { ok: false, error: '会话尚未启动' };

      const s = await ensureSession();
      if (!s.skills) return { ok: false, error: '技能库未启用' };
      return { ok: true, skills: s.skills.list() };
    },

    async approveSkill(name) {
      if (!getSession()) return { ok: false, error: '会话尚未启动' };

      const s = await ensureSession();
      if (!s.skills) return { ok: false, error: '技能库未启用' };
      if (enabledSkillCount(s.skills.list()) >= 20) {
        return { ok: false, error: '最多只能启用 20 个技能。请先停用一个已启用技能。' };
      }

      const changed = s.skills.approve(name);
      if (changed) sendSkillsChanged?.();
      return { ok: true, changed, skills: s.skills.list() };
    },

    async rejectSkill(name) {
      if (!getSession()) return { ok: false, error: '会话尚未启动' };

      const s = await ensureSession();
      if (!s.skills) return { ok: false, error: '技能库未启用' };

      const changed = s.skills.reject(name);
      if (changed) sendSkillsChanged?.();
      return { ok: true, changed, skills: s.skills.list() };
    },

    async setSkillEnabled(name, enabled) {
      if (!getSession()) return { ok: false, error: '会话尚未启动' };

      const s = await ensureSession();
      if (!s.skills) return { ok: false, error: '技能库未启用' };
      if (enabled === true && enabledSkillCount(s.skills.list()) >= 20) {
        return { ok: false, error: '最多只能启用 20 个技能。请先停用一个已启用技能。' };
      }

      const changed = s.skills.setEnabled(String(name || ''), enabled === true);
      if (changed) sendSkillsChanged?.();
      return { ok: true, changed, skills: s.skills.list() };
    },

    async extractMemoryFromTurns(payload) {
      if (!getSession()) return { ok: false, error: '会话尚未启动' };

      const s = await ensureSession();
      if (!s.memory) return { ok: false, error: '长期记忆未启用' };

      try {
        const selectedTurns = selectTurnsFromHistory(s.history(), payload?.turnIds);
        if (selectedTurns.error) return { ok: false, error: selectedTurns.error };

        const result = await s.memory.extractFromTurns(
          selectedTurns.turns,
          String(payload?.reason || ''),
        );
        sendMemoryChanged?.();
        return { ...result, memories: s.memory.list() };
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : String(err) };
      }
    },

    async extractSkillFromTurns(payload) {
      if (!getSession()) return { ok: false, error: '会话尚未启动' };

      const s = await ensureSession();
      if (!s.skills) return { ok: false, error: '技能库未启用' };

      try {
        const selectedTurns = selectTurnsFromHistory(s.history(), payload?.turnIds);
        if (selectedTurns.error) return { ok: false, error: selectedTurns.error };

        const result = await s.skills.extractFromTurns(
          selectedTurns.turns,
          String(payload?.reason || ''),
        );
        sendSkillsChanged?.();
        return { ...result, skills: s.skills.list() };
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : String(err) };
      }
    },
  };
}

function maskKey(k) {
  if (!k) return '(未配置)';
  return k.length <= 8 ? 'sk-••••' : `${k.slice(0, 3)}••••••••${k.slice(-4)}`;
}

function secretMeta(s) {
  return {
    name: s.name,
    description: s.description || '',
    hasValue: !!s.value,
  };
}

function requiresFullSessionRestart(before, after) {
  return JSON.stringify(restartRelevantConfig(before)) !==
    JSON.stringify(restartRelevantConfig(after));
}

function restartRelevantConfig(c) {
  const main = c.models.main || {};
  const vision = c.models.vision || null;
  return {
    main: {
      apiKey: main.apiKey || '',
      baseURL: main.baseURL || '',
      model: main.model || '',
      maxTokens: main.maxTokens ?? null,
      enableThinking: main.enableThinking !== false,
    },
    vision: vision
      ? {
          apiKey: vision.apiKey || '',
          baseURL: vision.baseURL || '',
          model: vision.model || '',
        }
      : null,
    workspace: c.workspace || '',
    pythonEnabled: !!c.python.enabled,
    allowDangerousTools: !!c.security.allowDangerousTools,
    shellEnabled: !!c.shell.enabled,
    subAgentEnabled: !!c.subAgent.enabled,
    memoryEnabled: !!c.memory.enabled,
    maxSteps: c.execution.maxSteps,
  };
}

async function loadMcpToolsForConfigTest(McpRuntime, server, secrets) {
  const runtime = new McpRuntime({
    servers: [{ ...server, enabled: true }],
    secrets,
    logger: console,
  });

  try {
    return await runtime.load(server.id);
  } finally {
    await runtime.close();
  }
}

function normalizeMcpServerForTest(raw, normalizeSecretName) {
  if (!raw || typeof raw !== 'object') throw new Error('MCP Server 配置格式不正确');
  const id = String(raw.id || '').trim();
  const name = String(raw.name || id).trim();
  const description = String(raw.description || '').trim();
  const bearerSecret = raw.bearerSecret ? normalizeSecretName(String(raw.bearerSecret)) : undefined;
  const headers = raw.headers && typeof raw.headers === 'object'
    ? Object.fromEntries(
        Object.entries(raw.headers)
          .filter(([k, v]) => String(k).trim() && typeof v === 'string')
          .map(([k, v]) => [String(k).trim(), v]),
      )
    : undefined;

  return {
    id,
    name,
    ...(description ? { description } : {}),
    url: String(raw.url || '').trim(),
    enabled: true,
    ...(bearerSecret ? { bearerSecret } : {}),
    ...(headers ? { headers } : {}),
  };
}

function summarizeMcpToolsForPrompt(tools) {
  return tools.slice(0, 30).map(tool => ({
    name: String(tool.name || '').slice(0, 120),
    description: clipForPrompt(tool.description || '', 320),
    input: summarizeMcpInputSchema(tool.inputSchema),
  }));
}

function summarizeMcpInputSchema(schema) {
  if (!schema || typeof schema !== 'object') return {};
  const properties = schema.properties && typeof schema.properties === 'object'
    ? Object.keys(schema.properties).slice(0, 24)
    : [];
  const required = Array.isArray(schema.required)
    ? schema.required.filter(v => typeof v === 'string').slice(0, 24)
    : [];
  return { properties, required };
}

function clipForPrompt(value, max) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function cleanGeneratedDescription(value) {
  const text = clipForPrompt(value, 240);
  return text.length >= 8 ? text : '';
}

function safeMcpEndpointLabel(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ''));
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

function enabledSkillCount(skills) {
  return (skills || []).filter(s => !s.pending && s.enabled !== false).length;
}

function selectTurnsFromHistory(history, rawIds) {
  const ids = Array.isArray(rawIds)
    ? rawIds
        .map(n => Number(n))
        .filter(n => Number.isInteger(n) && n > 0)
    : [];
  if (ids.length === 0) return { error: '请先选择对话轮次', turns: [] };

  const selectedIds = new Set(ids);
  const turns = history.filter(t => selectedIds.has(t.turn_id));
  if (turns.length === 0) {
    return { error: '选中的轮次不在当前会话历史中', turns: [] };
  }

  return { turns };
}

module.exports = { createAppApi };
