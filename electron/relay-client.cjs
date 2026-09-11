// ============================================
// RelayClient —— PC 端主动连接云端 Relay
// ============================================
//
// RemoteHub 是「别人连进电脑」,RelayClient 是「电脑连出去到服务器」。
// 这能绕开 NAT/路由器端口转发:手机只连公网 Relay,Relay 再把请求经
// WebSocket 转给这台正在运行 BaseAgent 的电脑。

const WebSocket = require('ws');

function createRelayClient(options) {
  const appApi = options.appApi;
  const logger = options.logger || console;
  const url = String(options.url || '').trim();
  const token = String(options.token || '').trim();
  const deviceId = cleanDeviceId(options.deviceId || 'default');
  const reconnectMs = normalizeReconnectMs(options.reconnectMs);

  let ws = null;
  let closed = false;
  let connectedAt = 0;
  let reconnectTimer = null;
  let relaySeq = 0;
  const relayRequests = new Map();

  function start() {
    if (!url || !token) {
      logger.warn?.('RelayClient 未启动: BASEAGENT_RELAY_URL 或 BASEAGENT_RELAY_TOKEN 为空');
      return false;
    }
    closed = false;
    connect();
    return true;
  }

  function connect() {
    if (closed || ws) return;

    const target = withQuery(url, { deviceId });
    ws = new WebSocket(target, {
      headers: { authorization: `Bearer ${token}` },
    });

    ws.on('open', () => {
      connectedAt = Date.now();
      logger.info?.(`RelayClient connected: ${target}`);
    });
    ws.on('message', raw => {
      void handleMessage(raw);
    });
    ws.on('close', () => {
      ws = null;
      connectedAt = 0;
      scheduleReconnect();
    });
    ws.on('error', err => {
      logger.warn?.('RelayClient error', err);
    });
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectMs);
    reconnectTimer.unref?.();
  }

  function stop() {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    for (const [requestId, record] of relayRequests) {
      clearTimeout(record.timer);
      record.resolve({ ok: false, error: 'RelayClient 已关闭' });
      relayRequests.delete(requestId);
    }
    const current = ws;
    ws = null;
    if (current && current.readyState === WebSocket.OPEN) current.close(1000, 'BaseAgent shutdown');
    else current?.terminate?.();
  }

  function publish(type, payload) {
    send({
      type: 'event',
      eventType: type,
      payload,
      at: Date.now(),
    });
  }

  function info() {
    return {
      enabled: !!url && !!token,
      connected: !!ws && ws.readyState === WebSocket.OPEN,
      url,
      deviceId,
      connectedAt,
    };
  }

  function createPairCode(options = {}) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ ok: false, error: 'Relay 未连接' });
    }

    const requestId = `relay-client-${Date.now()}-${++relaySeq}`;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        relayRequests.delete(requestId);
        resolve({ ok: false, error: 'Relay 生成配对码超时' });
      }, 15000);
      timer.unref?.();

      relayRequests.set(requestId, { resolve, timer });
      send({
        type: 'relay_request',
        requestId,
        action: 'create_pair_code',
        ttlMs: options.ttlMs,
      });
    });
  }

  async function handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (message?.type === 'relay_response' && message.requestId) {
      const requestId = String(message.requestId);
      const record = relayRequests.get(requestId);
      if (!record) return;
      relayRequests.delete(requestId);
      clearTimeout(record.timer);
      if (message.ok) {
        record.resolve({
          ok: true,
          ...(message.result || {}),
          endpoint: message.result?.endpoint || endpointFromRelayUrl(url),
        });
      } else {
        record.resolve({ ok: false, error: message.error || 'Relay 请求失败' });
      }
      return;
    }

    if (message?.type !== 'request' || !message.requestId) return;
    const requestId = String(message.requestId);
    try {
      const result = await routeRequest(
        String(message.method || 'GET').toUpperCase(),
        String(message.path || '/'),
        message.body || {},
      );
      send({ type: 'response', requestId, ok: true, result });
    } catch (err) {
      send({
        type: 'response',
        requestId,
        ok: false,
        error: err && err.message ? err.message : String(err),
      });
    }
  }

  async function routeRequest(method, pathname, body) {
    if (method === 'GET' && pathname === '/api/info') return appApi.info();
    if (method === 'GET' && pathname === '/api/notices') return appApi.notices();
    if (method === 'GET' && pathname === '/api/config') return appApi.configGet();
    if (method === 'GET' && pathname === '/api/history/list') return appApi.listHistory();
    if (method === 'GET' && pathname === '/api/history/current') {
      return appApi.currentHistory({ resumeLatest: true });
    }
    if (method === 'GET' && pathname === '/api/skills/list') return appApi.listSkills();
    if (method === 'GET' && pathname === '/api/confirm/pending') return appApi.confirmPending();

    if (method === 'POST' && pathname === '/api/agent/run') {
      const runId = body.runId || `relay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      return appApi.runAgent(runId, body.input || '', { notifySessionChanged: true });
    }
    if (method === 'POST' && pathname === '/api/agent/abort') return appApi.abortAgent();
    if (method === 'POST' && pathname === '/api/confirm/reply') {
      return appApi.confirmReply(body.reqId, body.ok);
    }
    if (method === 'POST' && pathname === '/api/agent/restart') return appApi.restartSession();
    if (method === 'POST' && pathname === '/api/config/save') return appApi.configSave(body.patch || {});
    if (method === 'POST' && pathname === '/api/config/test-mcp') return appApi.configTestMcp(body);
    if (method === 'POST' && pathname === '/api/config/describe-mcp') return appApi.configDescribeMcp(body);
    if (method === 'POST' && pathname === '/api/history/open') return appApi.openHistory(body.sessionId);
    if (method === 'POST' && pathname === '/api/history/new') return appApi.newHistory();
    if (method === 'POST' && pathname === '/api/skills/approve') return appApi.approveSkill(body.name);
    if (method === 'POST' && pathname === '/api/skills/reject') return appApi.rejectSkill(body.name);
    if (method === 'POST' && pathname === '/api/skills/set-enabled') {
      return appApi.setSkillEnabled(body.name, body.enabled);
    }
    if (method === 'POST' && pathname === '/api/skills/extract-from-turns') {
      return appApi.extractSkillFromTurns(body);
    }
    if (method === 'POST' && pathname === '/api/memory/extract-from-turns') {
      return appApi.extractMemoryFromTurns(body);
    }

    throw new Error(`No relay route for ${method} ${pathname}`);
  }

  function send(message) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(message));
    return true;
  }

  return { start, stop, publish, info, createPairCode };
}

function cleanDeviceId(value) {
  const cleaned = String(value || '').trim().replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
  return cleaned || 'default';
}

function normalizeReconnectMs(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 500 ? n : 2000;
}

function withQuery(rawUrl, params) {
  const u = new URL(rawUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') u.searchParams.set(key, value);
  }
  return u.toString();
}

function endpointFromRelayUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    return `${protocol}//${u.host}`;
  } catch {
    return '';
  }
}

module.exports = { createRelayClient };
