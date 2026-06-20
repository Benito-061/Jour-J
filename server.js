const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const STATE_FILE = path.join(ROOT, 'work', 'site-lock-state.json');

function ensureStateDir() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    return {
      ownerDeviceId: '',
      locked: false,
      shareCount: 0,
      devices: {}
    };
  }
}

function writeState(state) {
  ensureStateDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(JSON.stringify(body));
}

function getBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body ? JSON.parse(body) : {}));
    req.on('error', reject);
  });
}

function checkDevice(deviceId) {
  const state = readState();
  const now = new Date().toISOString();

  if (!deviceId) {
    state.locked = true;
    writeState(state);
    return { allowed: false, locked: true, reason: 'missing-device' };
  }

  if (!state.ownerDeviceId) {
    state.ownerDeviceId = deviceId;
    state.devices[deviceId] = { firstSeen: now, lastSeen: now };
    writeState(state);
    return { allowed: true, locked: false, ownerDeviceId: deviceId, shareCount: state.shareCount };
  }

  if (state.ownerDeviceId === deviceId && !state.locked) {
    state.devices[deviceId] = state.devices[deviceId] || { firstSeen: now };
    state.devices[deviceId].lastSeen = now;
    writeState(state);
    return { allowed: true, locked: false, ownerDeviceId: state.ownerDeviceId, shareCount: state.shareCount };
  }

  state.locked = true;
  state.devices[deviceId] = state.devices[deviceId] || { firstSeen: now };
  state.devices[deviceId].lastSeen = now;
  writeState(state);
  return { allowed: false, locked: true, reason: 'new-device', ownerDeviceId: state.ownerDeviceId };
}

function serveFile(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const filePath = path.resolve(ROOT, `.${pathname}`);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const type = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml'
    }[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    json(res, 200, { ok: true });
    return;
  }

  if (url.pathname === '/api/share' && req.method === 'GET') {
    json(res, 200, checkDevice(url.searchParams.get('deviceId') || ''));
    return;
  }

  if (url.pathname === '/api/share' && req.method === 'POST') {
    try {
      const body = await getBody(req);
      const state = readState();
      state.shareCount = (state.shareCount || 0) + 1;
      writeState(state);
      const result = checkDevice(body.deviceId || '');
      json(res, 200, {
        ...result,
        shareCount: readState().shareCount,
        allowed: result.allowed && readState().shareCount <= 1,
        locked: result.locked || readState().shareCount > 1
      });
    } catch (e) {
      json(res, 400, { allowed: false, locked: true, error: 'bad-request' });
    }
    return;
  }

  if (url.pathname === '/api/reset-lock' && req.method === 'POST') {
    const resetToken = process.env.RESET_LOCK_TOKEN || '';
    if (!resetToken || req.headers['x-reset-token'] !== resetToken) {
      json(res, 403, { ok: false, error: 'forbidden' });
      return;
    }
    writeState({ ownerDeviceId: '', locked: false, shareCount: 0, devices: {} });
    json(res, 200, { ok: true });
    return;
  }

  serveFile(req, res);
});

server.listen(PORT, () => {
  console.log(`Site protege ouvert sur http://localhost:${PORT}`);
});
