// ============================================
// RemoteHub —— future mobile/relay entrypoint
// ============================================
//
// This is deliberately a thin transport layer. It owns HTTP parsing, auth and
// SSE fan-out; business operations still go through appApi, the same object
// used by Electron IPC.

const crypto = require('crypto');
const fs = require('fs/promises');
const http = require('http');
const path = require('path');
const { URL } = require('url');

function createRemoteHub(options) {
  const appApi = options.appApi;
  const logger = options.logger || console;
  const host = options.host || '127.0.0.1';
  const port = normalizePort(options.port);
  const token = options.token || crypto.randomBytes(24).toString('base64url');
  const staticRoot = options.staticRoot ? path.resolve(options.staticRoot) : '';
  const clients = new Set();
  const pairCodes = new Map();
  const clientTokens = new Map();

  let server = null;
  let address = null;

  async function start() {
    if (server) return address;

    server = http.createServer((req, res) => {
      void handle(req, res);
    });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        address = server.address();
        resolve();
      });
    });

    logger.info?.(
      `RemoteHub listening on ${host}:${address.port} ` +
      `(token ${maskToken(token)})`,
    );
    return address;
  }

  async function stop() {
    for (const res of clients) {
      try { res.end(); } catch { /* ignore closing client */ }
    }
    clients.clear();

    const current = server;
    server = null;
    address = null;
    if (!current) return;

    current.closeAllConnections?.();
    await new Promise(resolve => current.close(() => resolve()));
  }

  function publish(type, payload) {
    if (!server) return;
    const body = sseFrame({ type, payload, at: Date.now() });
    for (const res of Array.from(clients)) {
      try {
        res.write(body);
      } catch {
        clients.delete(res);
      }
    }
  }

  function info() {
    return {
      enabled: !!server,
      host,
      port: address && typeof address === 'object' ? address.port : null,
      tokenMasked: maskToken(token),
      pairCodeTtlSec: 120,
      remoteClientPath: '/remote/',
    };
  }

  function isRunning() {
    return !!server;
  }

  function createPairCode(options = {}) {
    if (!server || !address || typeof address !== 'object') {
      return { ok: false, error: 'RemoteHub 未启动' };
    }

    prunePairCodes();
    const ttlMs = normalizeTtlMs(options.ttlMs);
    let code = '';
    for (let i = 0; i < 10; i++) {
      code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      if (!pairCodes.has(code)) break;
    }

    const expiresAt = Date.now() + ttlMs;
    pairCodes.set(code, { expiresAt });

    return {
      ok: true,
      code,
      expiresAt,
      expiresInMs: ttlMs,
      endpoint: endpointFor(host, address.port),
    };
  }

  async function handle(req, res) {
    writeCors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/health' && req.method === 'GET') {
      replyJson(res, 200, { ok: true, service: 'BaseAgent RemoteHub' });
      return;
    }

    if (url.pathname === '/app/md.js' && req.method === 'GET' && options.markdownPath) {
      await serveSharedMarkdown(res);
      return;
    }

    if (req.method === 'GET' && isRemoteClientPath(url.pathname)) {
      await serveRemoteClient(url.pathname, res);
      return;
    }

    if (url.pathname === '/pair/claim' && req.method === 'POST') {
      await handlePairClaim(req, res);
      return;
    }

    if (!isAuthorized(req, token, clientTokens)) {
      replyJson(res, 401, { ok: false, error: 'Unauthorized' });
      return;
    }

    if (url.pathname === '/events' && req.method === 'GET') {
      handleEvents(req, res);
      return;
    }

    try {
      const result = await routeRequest(url.pathname, req);
      replyJson(res, 200, result);
    } catch (err) {
      const status = err && err.status ? err.status : 500;
      replyJson(res, status, {
        ok: false,
        error: err && err.message ? err.message : String(err),
      });
    }
  }

  function handleEvents(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    clients.add(res);
    res.write(sseFrame({ type: 'remote:connected', payload: info(), at: Date.now() }));
    req.on('close', () => clients.delete(res));
  }

  async function handlePairClaim(req, res) {
    try {
      const body = await readJson(req);
      const code = normalizePairCode(body.code);
      prunePairCodes();
      const record = code ? pairCodes.get(code) : null;
      if (!record) {
        replyJson(res, 401, { ok: false, error: 'Pair code is invalid or expired' });
        return;
      }

      pairCodes.delete(code);
      const clientToken = crypto.randomBytes(24).toString('base64url');
      clientTokens.set(clientToken, {
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
        label: cleanClientLabel(body.label),
      });
      replyJson(res, 200, {
        ok: true,
        token: clientToken,
        endpoint: endpointFor(host, address.port),
        apiBase: '/api',
        eventsPath: '/events',
      });
      publish('remote:paired', { label: cleanClientLabel(body.label) });
    } catch (err) {
      const status = err && err.status ? err.status : 500;
      replyJson(res, status, {
        ok: false,
        error: err && err.message ? err.message : String(err),
      });
    }
  }

  async function serveRemoteClient(pathname, res) {
    if (!staticRoot) {
      replyJson(res, 404, { ok: false, error: 'Remote client is not bundled' });
      return;
    }

    try {
      const relative = pathname === '/remote' || pathname === '/remote/'
        ? 'index.html'
        : decodeURIComponent(pathname.slice('/remote/'.length));
      const sharedMarkdown = relative === 'md.js' && options.markdownPath;
      const target = sharedMarkdown
        ? path.resolve(options.markdownPath)
        : path.resolve(staticRoot, relative);
      if (!sharedMarkdown && !isInside(staticRoot, target)) {
        replyJson(res, 403, { ok: false, error: 'Forbidden' });
        return;
      }

      const data = await fs.readFile(target);
      res.writeHead(200, {
        'Content-Type': contentTypeFor(target),
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    } catch {
      replyJson(res, 404, { ok: false, error: 'Not found' });
    }
  }

  async function serveSharedMarkdown(res) {
    try {
      const target = path.resolve(options.markdownPath);
      const data = await fs.readFile(target);
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    } catch {
      replyJson(res, 404, { ok: false, error: 'Not found' });
    }
  }

  async function routeRequest(pathname, req) {
    if (req.method === 'GET' && pathname === '/api/info') return appApi.info();
    if (req.method === 'GET' && pathname === '/api/notices') return appApi.notices();
    if (req.method === 'GET' && pathname === '/api/config') return appApi.configGet();
    if (req.method === 'GET' && pathname === '/api/history/list') return appApi.listHistory();
    if (req.method === 'GET' && pathname === '/api/history/current') {
      return appApi.currentHistory({ resumeLatest: true });
    }
    if (req.method === 'GET' && pathname === '/api/skills/list') return appApi.listSkills();
    if (req.method === 'GET' && pathname === '/api/confirm/pending') return appApi.confirmPending();

    const body = await readJson(req);

    if (req.method === 'POST' && pathname === '/api/agent/run') {
      const runId = body.runId || `remote-${Date.now()}-${crypto.randomUUID()}`;
      return appApi.runAgent(runId, body.input || '', { notifySessionChanged: true });
    }
    if (req.method === 'POST' && pathname === '/api/agent/abort') return appApi.abortAgent();
    if (req.method === 'POST' && pathname === '/api/confirm/reply') {
      return appApi.confirmReply(body.reqId, body.ok);
    }
    if (req.method === 'POST' && pathname === '/api/agent/restart') return appApi.restartSession();
    if (req.method === 'POST' && pathname === '/api/config/save') return appApi.configSave(body.patch || {});
    if (req.method === 'POST' && pathname === '/api/config/test-mcp') return appApi.configTestMcp(body);
    if (req.method === 'POST' && pathname === '/api/config/describe-mcp') return appApi.configDescribeMcp(body);
    if (req.method === 'POST' && pathname === '/api/history/open') return appApi.openHistory(body.sessionId);
    if (req.method === 'POST' && pathname === '/api/history/new') return appApi.newHistory();
    if (req.method === 'POST' && pathname === '/api/skills/approve') return appApi.approveSkill(body.name);
    if (req.method === 'POST' && pathname === '/api/skills/reject') return appApi.rejectSkill(body.name);
    if (req.method === 'POST' && pathname === '/api/skills/set-enabled') {
      return appApi.setSkillEnabled(body.name, body.enabled);
    }
    if (req.method === 'POST' && pathname === '/api/skills/extract-from-turns') {
      return appApi.extractSkillFromTurns(body);
    }
    if (req.method === 'POST' && pathname === '/api/memory/extract-from-turns') {
      return appApi.extractMemoryFromTurns(body);
    }

    throw httpError(404, `No route for ${req.method} ${pathname}`);
  }

  function prunePairCodes() {
    const now = Date.now();
    for (const [code, record] of pairCodes) {
      if (record.expiresAt <= now) pairCodes.delete(code);
    }
  }

  return { start, stop, publish, info, isRunning, createPairCode };
}

function normalizePort(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : 0;
}

function normalizeTtlMs(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 30000 && n <= 10 * 60 * 1000 ? n : 120000;
}

function normalizePairCode(value) {
  return String(value || '').replace(/\D/g, '').slice(0, 6);
}

function endpointFor(host, port) {
  return `http://${host}:${port}`;
}

function isRemoteClientPath(pathname) {
  return pathname === '/remote' || pathname === '/remote/' || pathname.startsWith('/remote/');
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.png') return 'image/png';
  return 'application/octet-stream';
}

function cleanClientLabel(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

function writeCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type,x-baseagent-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}

function isAuthorized(req, token, clientTokens = new Map()) {
  const auth = String(req.headers.authorization || '');
  if (auth === `Bearer ${token}`) return true;
  const headerToken = String(req.headers['x-baseagent-token'] || '');
  if (headerToken === token) return true;

  const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  const clientToken = bearer || headerToken;
  const client = clientToken ? clientTokens.get(clientToken) : null;
  if (!client) return false;
  client.lastSeenAt = Date.now();
  return true;
}

function replyJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sseFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(httpError(413, 'Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(httpError(400, 'Request body must be valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function maskToken(value) {
  if (!value) return '';
  return value.length <= 8 ? '••••' : `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

module.exports = { createRemoteHub };
