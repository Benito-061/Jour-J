const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const STATE_FILE = path.join(ROOT, 'work', 'site-lock-state.json');
const MAX_BODY_SIZE = 1024 * 1024;

const DEFAULT_STATE = {
  ownerDeviceId: '',
  locked: false,
  shareCount: 0,
  devices: {}
};

function ensureStateDir() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
}

function cleanState(state) {
  return {
    ownerDeviceId: typeof state.ownerDeviceId === 'string' ? state.ownerDeviceId : '',
    locked: Boolean(state.locked),
    shareCount: Number.isFinite(state.shareCount) ? state.shareCount : 0,
    devices: state.devices && typeof state.devices === 'object' ? state.devices : {}
  };
}

function readState() {
  try {
    return cleanState(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
  } catch (e) {
    return { ...DEFAULT_STATE, devices: {} };
  }
}

function writeState(state) {
  ensureStateDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(cleanState(state), null, 2));
}

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Secret, X-Reset-Token',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(JSON.stringify(body));
}

function safeEqual(a, b) {
  if (!a || !b) return false;

  const aBuffer = Buffer.from(String(a));
  const bBuffer = Buffer.from(String(b));

  if (aBuffer.length !== bBuffer.length) return false;
  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

function getBearerToken(req) {
  const authorization = req.headers.authorization || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function getAdminSecretFromRequest(req, url, body = {}) {
  return (
    req.headers['x-admin-secret'] ||
    getBearerToken(req) ||
    url.searchParams.get('adminSecret') ||
    url.searchParams.get('admin_secret') ||
    body.adminSecret ||
    body.admin_secret ||
    ''
  );
}

function isAdminRequest(req, url, body = {}) {
  const adminSecret = process.env.ADMIN_SECRET || '';
  const requestSecret = getAdminSecretFromRequest(req, url, body);
  return safeEqual(adminSecret, requestSecret);
}

function getBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_BODY_SIZE) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error('invalid json'));
      }
    });

    req.on('error', reject);
  });
}

function adminAccess() {
  return {
    allowed: true,
    locked: false,
    mode: 'admin',
    admin: true
  };
}

function clientAccess(deviceId) {
  const state = readState();
  const now = new Date().toISOString();

  if (state.locked) {
    return {
      allowed: false,
      locked: true,
      mode: 'client',
      reason: 'locked',
      ownerDeviceId: state.ownerDeviceId,
      shareCount: state.shareCount
    };
  }

  if (!deviceId || typeof deviceId !== 'string') {
    state.locked = true;
    writeState(state);
    return {
      allowed: false,
      locked: true,
      mode: 'client',
      reason: 'missing-device',
      ownerDeviceId: state.ownerDeviceId,
      shareCount: state.shareCount
    };
  }

  if (!state.ownerDeviceId) {
    state.ownerDeviceId = deviceId;
    state.devices[deviceId] = { firstSeen: now, lastSeen: now };
    writeState(state);
    return {
      allowed: true,
      locked: false,
      mode: 'client',
      ownerDeviceId: deviceId,
      shareCount: state.shareCount
    };
  }

  if (state.ownerDeviceId === deviceId) {
    state.devices[deviceId] = state.devices[deviceId] || { firstSeen: now };
    state.devices[deviceId].lastSeen = now;
    writeState(state);
    return {
      allowed: true,
      locked: false,
      mode: 'client',
      ownerDeviceId: state.ownerDeviceId,
      shareCount: state.shareCount
    };
  }

  state.locked = true;
  state.shareCount = (state.shareCount || 0) + 1;
  state.devices[deviceId] = state.devices[deviceId] || { firstSeen: now };
  state.devices[deviceId].lastSeen = now;
  writeState(state);

  return {
    allowed: false,
    locked: true,
    mode: 'client',
    reason: 'new-device',
    ownerDeviceId: state.ownerDeviceId,
    shareCount: state.shareCount
  };
}

function serveFile(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const filePath = path.resolve(ROOT, `.${pathname}`);

  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
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
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.json': 'application/json; charset=utf-8'
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
    if (isAdminRequest(req, url)) {
      json(res, 200, adminAccess());
      return;
    }

    json(res, 200, clientAccess(url.searchParams.get('deviceId') || ''));
    return;
  }

  if (url.pathname === '/api/share' && req.method === 'POST') {
    try {
      const body = await getBody(req);

      if (isAdminRequest(req, url, body)) {
        json(res, 200, adminAccess());
        return;
      }

      json(res, 200, clientAccess(body.deviceId || ''));
    } catch (e) {
      json(res, 400, { allowed: false, locked: true, mode: 'client', error: 'bad-request' });
    }
    return;
  }

  if (url.pathname === '/api/reset-lock' && req.method === 'POST') {
    const resetToken = process.env.RESET_LOCK_TOKEN || '';
    if (!resetToken || !safeEqual(req.headers['x-reset-token'] || '', resetToken)) {
      json(res, 403, { ok: false, error: 'forbidden' });
      return;
    }

    writeState({ ...DEFAULT_STATE, devices: {} });
    json(res, 200, { ok: true });
    return;
  }

  serveFile(req, res);
});

server.listen(PORT, () => {
  console.log(`Site protege ouvert sur http://localhost:${PORT}`);
});
