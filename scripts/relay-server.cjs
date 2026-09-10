#!/usr/bin/env node
// ============================================
// BaseAgent Relay Server
// ============================================
//
// 部署在公网服务器上。手机/网页只连接它;真正的 Agent 仍在电脑端运行。
// Relay 只保存短期 token、在线连接和 in-flight 请求,不保存 workspace 文件、
// Secret 明文、trace 或浏览器登录态。

const crypto = require('crypto');
const fs = require('fs/promises');
const http = require('http');
const path = require('path');
const { URL } = require('url');
const { WebSocket, WebSocketServer } = require('ws');

const root = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(root, '.env'), quiet: true });

const host = process.env.BASEAGENT_RELAY_HOST || '0.0.0.0';
const port = normalizePort(process.env.BASEAGENT_RELAY_PORT || process.env.PORT || 17900);
const relayToken = process.env.BASEAGENT_RELAY_TOKEN || crypto.randomBytes(24).toString('base64url');
const pairCode = normalizePairCode(process.env.BASEAGENT_RELAY_PAIR_CODE) ||
  String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
const requestTimeoutMs = normalizeTimeout(process.env.BASEAGENT_RELAY_REQUEST_TIMEOUT_MS);
const remoteRoot = path.resolve(process.env.BASEAGENT_RELAY_REMOTE_ROOT || path.join(root, 'src', 'interface', 'remote'));
const markdownPath = path.resolve(process.env.BASEAGENT_RELAY_MARKDOWN_PATH || path.join(root, 'src', 'interface', 'app', 'md.js'));

const pcs = new Map();
const pending = new Map();
const clientTokens = new Map();
const sseClients = new Set();

const server = http.createServer((req, res) => {
  void handleHttp(req, res);
});
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/pc') {
    socket.destroy();
    return;
  }
  if (!isMasterAuthorized(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => {
    wss.emit('connection', ws, req, url);
  });
});

wss.on('connection', (ws, _req, url) => {
  const deviceId = cleanDeviceId(url.searchParams.get('deviceId') || 'default');
  const old = pcs.get(deviceId);
  old?.close?.(1012, 'Replaced by a new PC connection');

  const pc = { deviceId, ws, connectedAt: Date.now() };
  pcs.set(deviceId, pc);
  console.log(`PC connected: ${deviceId}`);
  broadcastToDevice(deviceId, 'relay:pc-status', { online: true, deviceId });

  ws.on('message', raw => handlePcMessage(deviceId, raw));
  ws.on('close', () => {
    if (pcs.get(deviceId)?.ws === ws) {
      pcs.delete(deviceId);
      failPendingForDevice(deviceId, 'PC disconnected');
      broadcastToDevice(deviceId, 'relay:pc-status', { online: false, deviceId });
      console.log(`PC disconnected: ${deviceId}`);
    }
  });
});

server.listen(port, host, () => {
  const address = server.address();
  console.log(`BaseAgent Relay listening on http://${host}:${address.port}`);
  console.log(`PC token: ${maskToken(relayToken)}`);
  console.log(`Pair code: ${pairCode}`);
});

async function handleHttp(req, res) {
  writeCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/health') {
    replyJson(res, 200, {
      ok: true,
      service: 'BaseAgent Relay',
      devices: Array.from(pcs.keys()),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/app/md.js') {
    await serveFile(markdownPath, res, 'application/javascript; charset=utf-8');
    return;
  }

  if (req.method === 'GET' && isRemoteClientPath(url.pathname)) {
    await serveRemoteClient(url.pathname, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/pair/claim') {
    await handlePairClaim(req, res);
    return;
  }

  const auth = authorizeClient(req);
  if (!auth.ok) {
    replyJson(res, 401, { ok: false, error: 'Unauthorized' });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    handleEvents(req, res, auth.deviceId);
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    await forwardApi(req, res, url.pathname, auth.deviceId);
    return;
  }

  replyJson(res, 404, { ok: false, error: 'Not found' });
}

async function handlePairClaim(req, res) {
  try {
    const body = await readJson(req);
    const code = normalizePairCode(body.code);
    if (!code || code !== pairCode) {
      replyJson(res, 401, { ok: false, error: 'Pair code is invalid' });
      return;
    }

    const deviceId = cleanDeviceId(body.deviceId || 'default');
    const token = crypto.randomBytes(24).toString('base64url');
    clientTokens.set(token, {
      deviceId,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      label: cleanLabel(body.label),
    });
    replyJson(res, 200, {
      ok: true,
      token,
      endpoint: publicEndpoint(req),
      apiBase: '/api',
      eventsPath: '/events',
      deviceId,
    });
  } catch (err) {
    replyJson(res, err.status || 500, { ok: false, error: errorText(err) });
  }
}

function handleEvents(req, res, deviceId) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const client = { res, deviceId };
  sseClients.add(client);
  res.write(sseFrame({
    type: 'relay:connected',
    payload: {
      deviceId,
      pcOnline: pcs.has(deviceId),
    },
    at: Date.now(),
  }));
  req.on('close', () => sseClients.delete(client));
}

async function forwardApi(req, res, pathname, deviceId) {
  try {
    const body = req.method === 'GET' ? {} : await readJson(req);
    const result = await requestPc(deviceId, {
      method: req.method,
      path: pathname,
      body,
    });
    replyJson(res, 200, result);
  } catch (err) {
    const status = err.status || (err.code === 'PC_OFFLINE' ? 503 : 500);
    replyJson(res, status, { ok: false, error: errorText(err) });
  }
}

function requestPc(deviceId, payload) {
  const pc = pcs.get(deviceId);
  if (!pc || pc.ws.readyState !== WebSocket.OPEN) {
    const err = new Error(`PC is offline: ${deviceId}`);
    err.code = 'PC_OFFLINE';
    throw err;
  }

  const requestId = crypto.randomUUID();
  const message = {
    type: 'request',
    requestId,
    ...payload,
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      const err = new Error(`Relay request timed out: ${payload.method} ${payload.path}`);
      err.status = 504;
      reject(err);
    }, requestTimeoutMs);
    timer.unref?.();

    pending.set(requestId, {
      deviceId,
      resolve,
      reject,
      timer,
    });
    pc.ws.send(JSON.stringify(message));
  });
}

function handlePcMessage(deviceId, raw) {
  let message;
  try {
    message = JSON.parse(String(raw));
  } catch {
    return;
  }

  if (message.type === 'event') {
    broadcastToDevice(deviceId, message.eventType, message.payload);
    return;
  }

  if (message.type !== 'response' || !message.requestId) return;
  const record = pending.get(message.requestId);
  if (!record) return;
  pending.delete(message.requestId);
  clearTimeout(record.timer);

  if (message.ok) record.resolve(message.result);
  else record.reject(new Error(message.error || 'PC request failed'));
}

function broadcastToDevice(deviceId, type, payload) {
  const body = sseFrame({ type, payload, at: Date.now() });
  for (const client of Array.from(sseClients)) {
    if (client.deviceId !== deviceId) continue;
    try {
      client.res.write(body);
    } catch {
      sseClients.delete(client);
    }
  }
}

function failPendingForDevice(deviceId, message) {
  for (const [requestId, record] of Array.from(pending.entries())) {
    if (record.deviceId !== deviceId) continue;
    pending.delete(requestId);
    clearTimeout(record.timer);
    record.reject(new Error(message));
  }
}

async function serveRemoteClient(pathname, res) {
  const relative = pathname === '/remote' || pathname === '/remote/'
    ? 'index.html'
    : decodeURIComponent(pathname.slice('/remote/'.length));
  const sharedMarkdown = relative === 'md.js';
  const target = sharedMarkdown
    ? markdownPath
    : path.resolve(remoteRoot, relative);
  if (!sharedMarkdown && !isInside(remoteRoot, target)) {
    replyJson(res, 403, { ok: false, error: 'Forbidden' });
    return;
  }
  await serveFile(target, res, contentTypeFor(target));
}

async function serveFile(filePath, res, contentType) {
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    replyJson(res, 404, { ok: false, error: 'Not found' });
  }
}

function authorizeClient(req) {
  if (isMasterAuthorized(req)) return { ok: true, deviceId: 'default', master: true };
  const token = bearerToken(req);
  const client = token ? clientTokens.get(token) : null;
  if (!client) return { ok: false };
  client.lastSeenAt = Date.now();
  return { ok: true, deviceId: client.deviceId };
}

function isMasterAuthorized(req) {
  return bearerToken(req) === relayToken || String(req.headers['x-baseagent-token'] || '') === relayToken;
}

function bearerToken(req) {
  const auth = String(req.headers.authorization || '');
  return auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
}

function publicEndpoint(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${port}`;
  return `${proto}://${host}`;
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

function writeCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type,x-baseagent-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}

function replyJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sseFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function isRemoteClientPath(pathname) {
  return pathname === '/remote' || pathname === '/remote/' || pathname.startsWith('/remote/');
}

function isInside(rootDir, target) {
  const relative = path.relative(rootDir, target);
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

function normalizePort(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : 17900;
}

function normalizeTimeout(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1000 ? n : 30 * 60 * 1000;
}

function normalizePairCode(value) {
  return String(value || '').replace(/\D/g, '').slice(0, 6);
}

function cleanDeviceId(value) {
  const cleaned = String(value || '').trim().replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
  return cleaned || 'default';
}

function cleanLabel(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

function maskToken(value) {
  if (!value) return '';
  return value.length <= 8 ? '********' : `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function errorText(err) {
  return err && err.message ? err.message : String(err);
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
