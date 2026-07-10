const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const STATE_FILE = path.join(ROOT, 'work', 'site-lock-state.json');
const SITE_DATA_FILE = path.join(ROOT, 'work', 'site-data.json');
const UPLOAD_DIR = path.join(ROOT, 'work', 'uploads');
const MAX_BODY_SIZE = 1024 * 1024;
const MAX_SITE_DATA_BODY_SIZE = 20 * 1024 * 1024;
const MAX_UPLOAD_BODY_SIZE = 12 * 1024 * 1024;

const DEFAULT_STATE = {
  ownerDeviceId: '',
  locked: false,
  shareCount: 0,
  devices: {},
  guests: {}
};

function ensureStateDir() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
}

function cleanState(state) {
  return {
    ownerDeviceId: typeof state.ownerDeviceId === 'string' ? state.ownerDeviceId : '',
    locked: Boolean(state.locked),
    shareCount: Number.isFinite(state.shareCount) ? state.shareCount : 0,
    devices: state.devices && typeof state.devices === 'object' ? state.devices : {},
    guests: state.guests && typeof state.guests === 'object' ? state.guests : {}
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

function readSiteData() {
  try {
    const data = JSON.parse(fs.readFileSync(SITE_DATA_FILE, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch (e) {
    return {};
  }
}

function writeSiteData(data) {
  ensureStateDir();
  fs.writeFileSync(SITE_DATA_FILE, JSON.stringify(data && typeof data === 'object' ? data : {}, null, 2));
}

function ensureUploadDir() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

function json(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Secret, X-Reset-Token',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    ...extraHeaders
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

function parseCookies(req) {
  return String(req.headers.cookie || '')
    .split(';')
    .map(cookie => cookie.trim())
    .filter(Boolean)
    .reduce((cookies, cookie) => {
      const separatorIndex = cookie.indexOf('=');
      if (separatorIndex === -1) return cookies;

      const key = cookie.slice(0, separatorIndex);
      const value = cookie.slice(separatorIndex + 1);
      cookies[key] = decodeURIComponent(value);
      return cookies;
    }, {});
}

function isValidDeviceId(deviceId) {
  return typeof deviceId === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(deviceId);
}

function createDeviceId() {
  return `device_${crypto.randomBytes(24).toString('hex')}`;
}

function createInviteCode() {
  return crypto.randomBytes(12).toString('base64url');
}

function isValidInviteCode(code) {
  return typeof code === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(code);
}

function createGuestId() {
  return `guest_${crypto.randomUUID()}`;
}

function cleanGuestInput(body = {}) {
  return {
    fullName: String(body.fullName || body.name || '').trim().slice(0, 160),
    phone: String(body.phone || body.telephone || '').trim().slice(0, 60)
  };
}

function findGuestByToken(state, token) {
  return Object.values(state.guests || {}).find(guest => guest && guest.token === token) || null;
}

function publicOrigin(req) {
  const host = String(req.headers.host || '');
  const proto = req.headers['x-forwarded-proto'] || (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? 'http' : 'https');
  return `${proto}://${req.headers.host}`;
}

function guestLink(req, guest) {
  return `${publicOrigin(req)}/invite/${encodeURIComponent(guest.token)}`;
}

function publicGuest(guest, req) {
  return {
    id: guest.id,
    fullName: guest.fullName,
    phone: guest.phone || '',
    token: guest.token,
    url: guestLink(req, guest),
    active: guest.active !== false,
    createdAt: guest.createdAt || '',
    updatedAt: guest.updatedAt || '',
    tokenCreatedAt: guest.tokenCreatedAt || '',
    firstUsedAt: guest.firstUsedAt || '',
    lastSeen: guest.lastSeen || '',
    blockedAttempts: guest.blockedAttempts || 0
  };
}

function guestList(state, req) {
  return Object.values(state.guests || {})
    .map(guest => publicGuest(guest, req))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function cookieHeader(req, deviceId) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
  const secure = forwardedProto === 'https' ? '; Secure' : '';
  return `siteDeviceId=${encodeURIComponent(deviceId)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`;
}

function resolveClientDevice(req, providedDeviceId) {
  if (isValidDeviceId(providedDeviceId)) {
    return { deviceId: providedDeviceId, headers: {} };
  }

  const cookies = parseCookies(req);
  if (isValidDeviceId(cookies.siteDeviceId)) {
    return { deviceId: cookies.siteDeviceId, headers: {} };
  }

  const deviceId = createDeviceId();
  return {
    deviceId,
    headers: {
      'Set-Cookie': cookieHeader(req, deviceId)
    }
  };
}

function getBody(req, maxSize = MAX_BODY_SIZE) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', chunk => {
      body += chunk;
      if (body.length > maxSize) {
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

function saveUploadedImage(dataUrl) {
  const match = String(dataUrl || '').match(/^data:image\/(png|jpe?g|webp|gif|bmp);base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) return null;

  const ext = match[1].toLowerCase().replace('jpeg', 'jpg');
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > 8 * 1024 * 1024) return null;

  ensureUploadDir();
  const filename = `invitation-qr-${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), buffer);
  return `/uploads/${filename}`;
}

function adminAccess() {
  return {
    allowed: true,
    locked: false,
    mode: 'admin',
    admin: true
  };
}

function inviteAccess(req, providedDeviceId, inviteCode) {
  const resolvedDevice = resolveClientDevice(req, providedDeviceId);
  const deviceId = resolvedDevice.deviceId;
  const state = readState();
  const now = new Date().toISOString();
  const guest = findGuestByToken(state, inviteCode);

  if (!guest) {
    return {
      body: { allowed: false, locked: true, mode: 'invite', reason: 'unknown-invite' },
      headers: resolvedDevice.headers
    };
  }

  if (guest.active === false) {
    return {
      body: { allowed: false, locked: true, mode: 'invite', reason: 'inactive-invite' },
      headers: resolvedDevice.headers
    };
  }

  if (!guest.deviceId) {
    guest.deviceId = deviceId;
    guest.firstUsedAt = now;
    guest.lastSeen = now;
    guest.blockedAttempts = guest.blockedAttempts || 0;
    writeState(state);
    return {
      body: { allowed: true, locked: false, mode: 'invite', inviteCode, guest: publicGuest(guest, req) },
      headers: resolvedDevice.headers
    };
  }

  if (guest.deviceId === deviceId) {
    guest.lastSeen = now;
    writeState(state);
    return {
      body: { allowed: true, locked: false, mode: 'invite', inviteCode, guest: publicGuest(guest, req) },
      headers: resolvedDevice.headers
    };
  }

  guest.blockedAttempts = (guest.blockedAttempts || 0) + 1;
  guest.lastBlockedAt = now;
  writeState(state);
  return {
    body: { allowed: false, locked: true, mode: 'invite', reason: 'already-used' },
    headers: resolvedDevice.headers
  };
}

function clientAccess(req, providedDeviceId) {
  const resolvedDevice = resolveClientDevice(req, providedDeviceId);
  const deviceId = resolvedDevice.deviceId;
  const state = readState();
  const now = new Date().toISOString();

  if (state.locked) {
    return {
      body: {
        allowed: false,
        locked: true,
        mode: 'client',
        reason: 'locked',
        ownerDeviceId: state.ownerDeviceId,
        shareCount: state.shareCount
      },
      headers: resolvedDevice.headers
    };
  }

  if (!state.ownerDeviceId) {
    state.ownerDeviceId = deviceId;
    state.devices[deviceId] = { firstSeen: now, lastSeen: now };
    writeState(state);
    return {
      body: {
        allowed: true,
        locked: false,
        mode: 'client',
        ownerDeviceId: deviceId,
        shareCount: state.shareCount
      },
      headers: resolvedDevice.headers
    };
  }

  if (state.ownerDeviceId === deviceId) {
    state.devices[deviceId] = state.devices[deviceId] || { firstSeen: now };
    state.devices[deviceId].lastSeen = now;
    writeState(state);
    return {
      body: {
        allowed: true,
        locked: false,
        mode: 'client',
        ownerDeviceId: state.ownerDeviceId,
        shareCount: state.shareCount
      },
      headers: resolvedDevice.headers
    };
  }

  state.locked = true;
  state.shareCount = (state.shareCount || 0) + 1;
  state.devices[deviceId] = state.devices[deviceId] || { firstSeen: now };
  state.devices[deviceId].lastSeen = now;
  writeState(state);

  return {
    body: {
      allowed: false,
      locked: true,
      mode: 'client',
      reason: 'new-device',
      ownerDeviceId: state.ownerDeviceId,
      shareCount: state.shareCount
    },
    headers: resolvedDevice.headers
  };
}

function serveFile(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  if (/^\/(?:invite|invitation)\/[A-Za-z0-9_-]{8,64}$/.test(pathname)) {
    pathname = '/index.html';
  }
  const isUpload = pathname.startsWith('/uploads/');
  const filePath = isUpload
    ? path.resolve(UPLOAD_DIR, `.${pathname.slice('/uploads'.length)}`)
    : path.resolve(ROOT, `.${pathname}`);

  if (isUpload && !filePath.startsWith(UPLOAD_DIR + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (!isUpload && !filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
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

    const inviteCode = url.searchParams.get('invite') || '';
    if (isValidInviteCode(inviteCode)) {
      const result = inviteAccess(req, url.searchParams.get('deviceId') || '', inviteCode);
      json(res, 200, result.body, result.headers);
      return;
    }

    const result = clientAccess(req, url.searchParams.get('deviceId') || '');
    json(res, 200, result.body, result.headers);
    return;
  }

  if (url.pathname === '/api/share' && req.method === 'POST') {
    try {
      const body = await getBody(req);

      if (isAdminRequest(req, url, body)) {
        json(res, 200, adminAccess());
        return;
      }

      if (isValidInviteCode(body.invite || '')) {
        const result = inviteAccess(req, body.deviceId || '', body.invite);
        json(res, 200, result.body, result.headers);
        return;
      }

      const result = clientAccess(req, body.deviceId || '');
      json(res, 200, result.body, result.headers);
    } catch (e) {
      json(res, 400, { allowed: false, locked: true, mode: 'client', error: 'bad-request' });
    }
    return;
  }

  if (url.pathname === '/api/site-data' && req.method === 'GET') {
    json(res, 200, {
      ok: true,
      data: readSiteData()
    });
    return;
  }

  if (url.pathname === '/api/site-data' && req.method === 'POST') {
    try {
      const body = await getBody(req, MAX_SITE_DATA_BODY_SIZE);

      if (!isAdminRequest(req, url, body)) {
        json(res, 403, { ok: false, error: 'forbidden' });
        return;
      }

      writeSiteData(body.data || {});
      json(res, 200, { ok: true });
    } catch (e) {
      json(res, 400, { ok: false, error: 'bad-request' });
    }
    return;
  }

  if (url.pathname === '/api/upload-invitation-qr' && req.method === 'POST') {
    try {
      const body = await getBody(req, MAX_UPLOAD_BODY_SIZE);
      if (!isAdminRequest(req, url, body)) {
        json(res, 403, { ok: false, error: 'forbidden' });
        return;
      }

      const uploadedUrl = saveUploadedImage(body.imageData || '');
      if (!uploadedUrl) {
        json(res, 400, { ok: false, error: 'invalid-image' });
        return;
      }

      json(res, 200, { ok: true, url: uploadedUrl });
    } catch (e) {
      json(res, 400, { ok: false, error: 'bad-request' });
    }
    return;
  }

  if (url.pathname === '/api/guest' && req.method === 'GET') {
    const token = url.searchParams.get('token') || '';
    if (!isValidInviteCode(token)) {
      json(res, 404, { ok: false, error: 'unknown-invite' });
      return;
    }

    const result = inviteAccess(req, url.searchParams.get('deviceId') || '', token);
    json(res, result.body.allowed ? 200 : 403, result.body, result.headers);
    return;
  }

  if (url.pathname === '/api/guests' && req.method === 'GET') {
    if (!isAdminRequest(req, url)) {
      json(res, 403, { ok: false, error: 'forbidden' });
      return;
    }

    const state = readState();
    json(res, 200, { ok: true, guests: guestList(state, req) });
    return;
  }

  if (url.pathname === '/api/guests' && req.method === 'POST') {
    try {
      const body = await getBody(req);
      if (!isAdminRequest(req, url, body)) {
        json(res, 403, { ok: false, error: 'forbidden' });
        return;
      }

      const action = String(body.action || 'create');
      const state = readState();
      const now = new Date().toISOString();

      if (action === 'create') {
        const input = cleanGuestInput(body);
        if (!input.fullName) {
          json(res, 400, { ok: false, error: 'missing-full-name' });
          return;
        }

        const id = createGuestId();
        let token = createInviteCode();
        while (findGuestByToken(state, token)) token = createInviteCode();
        state.guests[id] = {
          id,
          fullName: input.fullName,
          phone: input.phone,
          token,
          active: true,
          createdAt: now,
          updatedAt: now,
          tokenCreatedAt: now,
          deviceId: '',
          firstUsedAt: '',
          lastSeen: '',
          blockedAttempts: 0
        };
        writeState(state);
        json(res, 200, { ok: true, guest: publicGuest(state.guests[id], req), guests: guestList(state, req) });
        return;
      }

      const id = String(body.id || '');
      const guest = state.guests[id];
      if (!guest) {
        json(res, 404, { ok: false, error: 'unknown-guest' });
        return;
      }

      if (action === 'update') {
        const input = cleanGuestInput(body);
        if (!input.fullName) {
          json(res, 400, { ok: false, error: 'missing-full-name' });
          return;
        }
        guest.fullName = input.fullName;
        guest.phone = input.phone;
        guest.active = body.active === false ? false : true;
        guest.updatedAt = now;
      } else if (action === 'delete') {
        delete state.guests[id];
      } else if (action === 'regenerate') {
        let token = createInviteCode();
        while (findGuestByToken(state, token)) token = createInviteCode();
        guest.token = token;
        guest.tokenCreatedAt = now;
        guest.updatedAt = now;
        guest.deviceId = '';
        guest.firstUsedAt = '';
        guest.lastSeen = '';
        guest.blockedAttempts = 0;
      } else if (action === 'toggle') {
        guest.active = body.active !== false;
        guest.updatedAt = now;
      } else {
        json(res, 400, { ok: false, error: 'unknown-action' });
        return;
      }

      writeState(state);
      json(res, 200, { ok: true, guests: guestList(state, req) });
    } catch (e) {
      json(res, 400, { ok: false, error: 'bad-request' });
    }
    return;
  }

  if (url.pathname === '/api/reset-lock' && req.method === 'POST') {
    const resetToken = process.env.RESET_LOCK_TOKEN || '';
    if (!resetToken || !safeEqual(req.headers['x-reset-token'] || '', resetToken)) {
      json(res, 403, { ok: false, error: 'forbidden' });
      return;
    }

    writeState({ ...DEFAULT_STATE, devices: {}, guests: {} });
    json(res, 200, { ok: true });
    return;
  }

  serveFile(req, res);
});

server.listen(PORT, () => {
  console.log(`Site protege ouvert sur http://localhost:${PORT}`);
});
