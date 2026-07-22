const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const STATE_FILE = path.join(ROOT, 'work', 'site-lock-state.json');
const SITE_DATA_FILE = path.join(ROOT, 'work', 'site-data.json');
const JOUR_J_DATABASE_FILE = path.join(ROOT, 'work', 'Jour-J.json');
const MAX_BODY_SIZE = 1024 * 1024;
const MAX_SITE_DATA_BODY_SIZE = 20 * 1024 * 1024;

const DEFAULT_STATE = {
  ownerDeviceId: '',
  locked: false,
  shareCount: 0,
  devices: {},
  invites: {}
};

const DEFAULT_JOUR_J_DATABASE = {
  name: 'Jour-J',
  version: 1,
  createdAt: '',
  updatedAt: '',
  invitations: {},
  guestbookMessages: []
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
    invites: state.invites && typeof state.invites === 'object' ? state.invites : {}
  };
}

function cleanInvitationDatabase(database, fallbackInvites = {}) {
  const now = new Date().toISOString();
  return {
    name: 'Jour-J',
    version: 1,
    createdAt: typeof database?.createdAt === 'string' && database.createdAt ? database.createdAt : now,
    updatedAt: now,
    invitations: database?.invitations && typeof database.invitations === 'object'
      ? database.invitations
      : (fallbackInvites && typeof fallbackInvites === 'object' ? fallbackInvites : {}),
    guestbookMessages: Array.isArray(database?.guestbookMessages) ? database.guestbookMessages : []
  };
}

function writeJsonAtomically(file, value) {
  ensureStateDir();
  const temporaryFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(value, null, 2));
  fs.renameSync(temporaryFile, file);
}

function readJourJDatabase(fallbackInvites = {}) {
  try {
    const database = JSON.parse(fs.readFileSync(JOUR_J_DATABASE_FILE, 'utf8'));
    return cleanInvitationDatabase(database, fallbackInvites);
  } catch (e) {
    const database = cleanInvitationDatabase(DEFAULT_JOUR_J_DATABASE, fallbackInvites);
    writeJsonAtomically(JOUR_J_DATABASE_FILE, database);
    return database;
  }
}

function writeJourJDatabase(invitations, guestbookMessages) {
  const current = readJourJDatabase();
  const database = cleanInvitationDatabase({
    ...current,
    invitations,
    guestbookMessages: Array.isArray(guestbookMessages) ? guestbookMessages : current.guestbookMessages
  });
  writeJsonAtomically(JOUR_J_DATABASE_FILE, database);
}

function listGuestbookMessages() {
  return readJourJDatabase().guestbookMessages
    .slice()
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

function addGuestbookMessage(input) {
  const name = String(input?.name || '').trim().slice(0, 120);
  const message = String(input?.message || '').trim().slice(0, 500);
  if (!name || !message) return null;

  const database = readJourJDatabase();
  const entry = {
    id: crypto.randomUUID(),
    name,
    message,
    attending: Boolean(input?.attending),
    created_at: new Date().toISOString()
  };
  const messages = [entry, ...database.guestbookMessages].slice(0, 300);
  writeJourJDatabase(database.invitations, messages);
  return entry;
}

function readState() {
  let state;
  try {
    state = cleanState(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
  } catch (e) {
    state = { ...DEFAULT_STATE, devices: {}, invites: {} };
  }
  state.invites = readJourJDatabase(state.invites).invitations;
  return state;
}

function writeState(state) {
  const clean = cleanState(state);
  writeJourJDatabase(clean.invites);
  writeJsonAtomically(STATE_FILE, { ...clean, invites: {} });
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
  const invite = state.invites[inviteCode];

  if (!invite) {
    return {
      body: { allowed: false, locked: true, mode: 'invite', reason: 'unknown-invite' },
      headers: resolvedDevice.headers
    };
  }

  if (invite.revoked) {
    return {
      body: { allowed: false, locked: true, mode: 'invite', reason: 'revoked-invite' },
      headers: resolvedDevice.headers
    };
  }

  if (!invite.deviceId) {
    invite.deviceId = deviceId;
    invite.firstUsedAt = now;
    invite.lastSeen = now;
    invite.blockedAttempts = invite.blockedAttempts || 0;
    writeState(state);
    return {
      body: { allowed: true, locked: false, mode: 'invite', inviteCode },
      headers: resolvedDevice.headers
    };
  }

  if (invite.deviceId === deviceId) {
    invite.lastSeen = now;
    writeState(state);
    return {
      body: { allowed: true, locked: false, mode: 'invite', inviteCode },
      headers: resolvedDevice.headers
    };
  }

  invite.blockedAttempts = (invite.blockedAttempts || 0) + 1;
  invite.lastBlockedAt = now;
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

function invitePublicView(state, req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const origin = `${proto}://${req.headers.host}`;
  return Object.entries(state.invites)
    .map(([code, invite]) => ({
      code,
      url: `${origin}/?invite=${encodeURIComponent(code)}`,
      used: Boolean(invite.deviceId),
      revoked: Boolean(invite.revoked),
      createdAt: invite.createdAt || '',
      firstUsedAt: invite.firstUsedAt || '',
      lastSeen: invite.lastSeen || '',
      blockedAttempts: invite.blockedAttempts || 0
    }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
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

  if (url.pathname === '/api/guestbook' && req.method === 'GET') {
    json(res, 200, { ok: true, messages: listGuestbookMessages() });
    return;
  }

  if (url.pathname === '/api/guestbook' && req.method === 'POST') {
    try {
      const body = await getBody(req);
      const entry = addGuestbookMessage(body);
      if (!entry) {
        json(res, 400, { ok: false, error: 'invalid-message' });
        return;
      }
      json(res, 201, { ok: true, message: entry });
    } catch (e) {
      json(res, 400, { ok: false, error: 'bad-request' });
    }
    return;
  }

  if (url.pathname === '/api/invites' && req.method === 'GET') {
    if (!isAdminRequest(req, url)) {
      json(res, 403, { ok: false, error: 'forbidden' });
      return;
    }

    const state = readState();
    json(res, 200, { ok: true, invites: invitePublicView(state, req) });
    return;
  }

  if (url.pathname === '/api/invites' && req.method === 'POST') {
    try {
      const body = await getBody(req);
      if (!isAdminRequest(req, url, body)) {
        json(res, 403, { ok: false, error: 'forbidden' });
        return;
      }

      const count = Math.max(1, Math.min(200, Number.parseInt(body.count || '1', 10) || 1));
      const state = readState();
      const now = new Date().toISOString();
      for (let i = 0; i < count; i += 1) {
        let code = createInviteCode();
        while (state.invites[code]) code = createInviteCode();
        state.invites[code] = {
          createdAt: now,
          deviceId: '',
          firstUsedAt: '',
          lastSeen: '',
          revoked: false,
          blockedAttempts: 0
        };
      }
      writeState(state);
      json(res, 200, { ok: true, invites: invitePublicView(state, req) });
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

    writeState({ ...DEFAULT_STATE, devices: {}, invites: {} });
    json(res, 200, { ok: true });
    return;
  }

  serveFile(req, res);
});

// Initialise la base locale des liens d'invitation dès le démarrage.
readJourJDatabase();

server.listen(PORT, () => {
  console.log(`Site protege ouvert sur http://localhost:${PORT}`);
});
