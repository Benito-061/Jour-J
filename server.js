const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const STATE_FILE = path.join(ROOT, 'work', 'site-lock-state.json');
const SITE_DATA_FILE = path.join(ROOT, 'work', 'site-data.json');
const JOUR_J_DATABASE_FILE = process.env.JOUR_J_DATABASE_FILE || path.join(ROOT, 'work', 'Jour-J.json');
const JOUR_J_DATABASE_BACKUP_FILE = `${JOUR_J_DATABASE_FILE}.backup`;
const SQLITE_DATABASE_FILE = process.env.JOUR_J_SQLITE_FILE || path.join(ROOT, 'work', 'Jour-J.sqlite');
const UPLOADS_DIR = path.join(ROOT, 'work', 'uploads');
const INVITATION_UPLOADS_DIR = path.join(UPLOADS_DIR, 'invitations');
const MAX_BODY_SIZE = 1024 * 1024;
const MAX_SITE_DATA_BODY_SIZE = 20 * 1024 * 1024;
const MAX_INVITATION_IMAGE_SIZE = 8 * 1024 * 1024;
const eventClients = new Set();

const DEFAULT_STATE = {
  ownerDeviceId: '',
  locked: false,
  shareCount: 0,
  devices: {},
  invites: {}
};

const DEFAULT_JOUR_J_DATABASE = {
  name: 'Jour-J',
  version: 2,
  createdAt: '',
  updatedAt: '',
  invitations: {},
  guestbookMessages: [],
  deletedGuestbookMessageIds: [],
  activeCeremonyId: 'default',
  ceremonies: {}
};

function ensureStateDir() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
}

let sqliteDatabase;

function getSqliteDatabase() {
  if (sqliteDatabase) return sqliteDatabase;
  ensureStateDir();
  sqliteDatabase = new DatabaseSync(SQLITE_DATABASE_FILE);
  sqliteDatabase.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS jour_j_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return sqliteDatabase;
}

function readSqliteDatabase() {
  const row = getSqliteDatabase().prepare('SELECT payload FROM jour_j_state WHERE id = 1').get();
  if (!row) return null;
  try { return JSON.parse(row.payload); } catch (error) { throw new Error('sqlite-database-corrupted'); }
}

function writeSqliteDatabase(value) {
  const database = getSqliteDatabase();
  database.prepare(`
    INSERT INTO jour_j_state (id, payload, updated_at) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `).run(JSON.stringify(value), new Date().toISOString());
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
  const legacyInvitations = database?.invitations && typeof database.invitations === 'object'
    ? database.invitations
    : (fallbackInvites && typeof fallbackInvites === 'object' ? fallbackInvites : {});
  const legacyMessages = Array.isArray(database?.guestbookMessages) ? database.guestbookMessages : [];
  const deletedGuestbookMessageIds = Array.isArray(database?.deletedGuestbookMessageIds)
    ? database.deletedGuestbookMessageIds.map(id => String(id)).filter(Boolean)
    : [];
  const ceremonies = database?.ceremonies && typeof database.ceremonies === 'object'
    ? database.ceremonies
    : {};
  if (!Object.keys(ceremonies).length) {
    ceremonies.default = {
      id: 'default',
      name: 'Cérémonie principale',
      date: '',
      details: '',
      status: 'active',
      createdAt: now,
      updatedAt: now,
      siteData: {},
      invitationImage: null,
      invitations: legacyInvitations,
      guestbookMessages: legacyMessages,
      deletedGuestbookMessageIds
    };
  }
  Object.entries(ceremonies).forEach(([id, ceremony]) => {
    ceremonies[id] = {
      id,
      name: String(ceremony?.name || 'Cérémonie sans nom').slice(0, 160),
      date: String(ceremony?.date || '').slice(0, 60),
      details: String(ceremony?.details || '').slice(0, 1000),
      status: ['active', 'draft', 'archived'].includes(ceremony?.status) ? ceremony.status : 'draft',
      createdAt: ceremony?.createdAt || now,
      updatedAt: ceremony?.updatedAt || now,
      siteData: ceremony?.siteData && typeof ceremony.siteData === 'object' ? ceremony.siteData : {},
      invitationImage: cleanInvitationImage(ceremony?.invitationImage),
      invitations: ceremony?.invitations && typeof ceremony.invitations === 'object' ? ceremony.invitations : {},
      guestbookMessages: Array.isArray(ceremony?.guestbookMessages) ? ceremony.guestbookMessages : [],
      deletedGuestbookMessageIds
    };
  });
  const activeCeremonyId = ceremonies[database?.activeCeremonyId] ? database.activeCeremonyId : Object.keys(ceremonies)[0];
  const defaultCeremony = ceremonies.default || ceremonies[activeCeremonyId];
  return {
    name: 'Jour-J',
    version: 2,
    createdAt: typeof database?.createdAt === 'string' && database.createdAt ? database.createdAt : now,
    updatedAt: now,
    // Ces deux champs restent disponibles pour les anciennes routes, mais ils
    // reflètent toujours la cérémonie principale afin de ne pas casser les
    // liens créés avant le passage au multi-cérémonies.
    invitations: defaultCeremony?.invitations || legacyInvitations,
    guestbookMessages: defaultCeremony?.guestbookMessages || legacyMessages,
    deletedGuestbookMessageIds,
    activeCeremonyId,
    ceremonies
  };
}

function ceremonyIdFrom(url, body = {}) {
  return String(body.ceremonyId || body.ceremony || url.searchParams.get('ceremony') || url.searchParams.get('ceremonyId') || '').trim();
}

function getCeremony(database, requestedId = '') {
  return database.ceremonies[requestedId] || database.ceremonies[database.activeCeremonyId] || database.ceremonies.default;
}

function cleanInvitationImage(image) {
  if (!image || typeof image !== 'object') return null;
  const fileName = String(image.fileName || '');
  const mimeType = String(image.mimeType || '');
  if (!/^[a-f0-9-]{36}\.(?:jpg|png|webp)$/i.test(fileName)) return null;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) return null;
  return {
    fileName,
    mimeType,
    size: Number.isFinite(image.size) ? image.size : 0,
    updatedAt: typeof image.updatedAt === 'string' ? image.updatedAt : '',
    version: typeof image.version === 'string' ? image.version : ''
  };
}

function publicCeremony(ceremony) {
  return {
    id: ceremony.id,
    name: ceremony.name,
    date: ceremony.date,
    details: ceremony.details,
    status: ceremony.status,
    createdAt: ceremony.createdAt,
    updatedAt: ceremony.updatedAt,
    guestCount: Object.keys(ceremony.invitations).length
  };
}

function assertDatabaseDataPreserved(value, allowDataLoss = false) {
  if (allowDataLoss) return value;
  let current;
  try {
    current = readSqliteDatabase();
    if (!current && fs.existsSync(JOUR_J_DATABASE_FILE)) {
      current = JSON.parse(fs.readFileSync(JOUR_J_DATABASE_FILE, 'utf8'));
    }
  } catch (error) {
    return value;
  }
  if (!current) return value;
  const currentCeremonies = current.ceremonies && typeof current.ceremonies === 'object' ? current.ceremonies : {};
  const nextCeremonies = value.ceremonies && typeof value.ceremonies === 'object' ? value.ceremonies : {};
  const lostCeremony = Object.keys(currentCeremonies).some(id => !Object.prototype.hasOwnProperty.call(nextCeremonies, id));
  const lostInvitation = Object.keys(currentCeremonies).some(id => {
    const currentInvites = currentCeremonies[id]?.invitations || {};
    const nextInvites = nextCeremonies[id]?.invitations || {};
    return Object.keys(currentInvites).some(token => !Object.prototype.hasOwnProperty.call(nextInvites, token));
  });
  if (lostCeremony || lostInvitation) return mergeDatabaseWithoutLoss(current, value);
  return value;
}

function mergeDatabaseWithoutLoss(current, next) {
  const mergedCeremonies = { ...(current.ceremonies || {}) };
  Object.entries(next.ceremonies || {}).forEach(([id, ceremony]) => {
    const previous = mergedCeremonies[id] || {};
    mergedCeremonies[id] = {
      ...previous,
      ...ceremony,
      invitations: { ...(previous.invitations || {}), ...(ceremony.invitations || {}) },
      guestbookMessages: [
        ...(previous.guestbookMessages || []),
        ...(ceremony.guestbookMessages || [])
      ].filter((message, index, list) => list.findIndex(item => String(item.id) === String(message.id)) === index)
    };
  });
  return cleanInvitationDatabase({
    ...current,
    ...next,
    ceremonies: mergedCeremonies,
    invitations: { ...(current.invitations || {}), ...(next.invitations || {}) },
    guestbookMessages: [
      ...(current.guestbookMessages || []),
      ...(next.guestbookMessages || [])
    ].filter((message, index, list) => list.findIndex(item => String(item.id) === String(message.id)) === index)
  });
}

function writeJsonAtomically(file, value, options = {}) {
  ensureStateDir();
  if (file === JOUR_J_DATABASE_FILE) {
    value = assertDatabaseDataPreserved(value, options.allowDataLoss === true);
    writeSqliteDatabase(value);
  }
  if (file === JOUR_J_DATABASE_FILE && fs.existsSync(file)) {
    fs.copyFileSync(file, JOUR_J_DATABASE_BACKUP_FILE);
  }
  const temporaryFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(value, null, 2));
  fs.renameSync(temporaryFile, file);
}

function readJourJDatabase(fallbackInvites = {}) {
  try {
    const sqliteValue = readSqliteDatabase();
    if (sqliteValue) return cleanInvitationDatabase(sqliteValue, fallbackInvites);
  } catch (sqliteError) {
    console.error('Base SQLite illisible, tentative de migration depuis le JSON:', sqliteError.message);
  }

  try {
    const database = JSON.parse(fs.readFileSync(JOUR_J_DATABASE_FILE, 'utf8'));
    const cleaned = cleanInvitationDatabase(database, fallbackInvites);
    writeSqliteDatabase(cleaned);
    return cleaned;
  } catch (e) {
    try {
      const backup = JSON.parse(fs.readFileSync(JOUR_J_DATABASE_BACKUP_FILE, 'utf8'));
      const database = cleanInvitationDatabase(backup, fallbackInvites);
      ensureStateDir();
      const temporaryFile = `${JOUR_J_DATABASE_FILE}.${process.pid}.${Date.now()}.restore.tmp`;
      fs.writeFileSync(temporaryFile, JSON.stringify(database, null, 2));
      fs.renameSync(temporaryFile, JOUR_J_DATABASE_FILE);
      writeSqliteDatabase(database);
      return database;
    } catch (backupError) {
      const database = cleanInvitationDatabase(DEFAULT_JOUR_J_DATABASE, fallbackInvites);
      writeJsonAtomically(JOUR_J_DATABASE_FILE, database);
      return database;
    }
  }
}

function writeJourJDatabase(invitations, guestbookMessages) {
  const current = readJourJDatabase();
  const defaultCeremony = getCeremony(current, 'default');
  if (defaultCeremony) {
    defaultCeremony.invitations = invitations;
    defaultCeremony.guestbookMessages = Array.isArray(guestbookMessages) ? guestbookMessages : current.guestbookMessages;
    defaultCeremony.updatedAt = new Date().toISOString();
  }
  const database = cleanInvitationDatabase({
    ...current,
    invitations,
    guestbookMessages: Array.isArray(guestbookMessages) ? guestbookMessages : current.guestbookMessages,
    ceremonies: current.ceremonies
  });
  writeJsonAtomically(JOUR_J_DATABASE_FILE, database);
}

function listGuestbookMessages() {
  const database = readJourJDatabase();
  const deletedIds = new Set(database.deletedGuestbookMessageIds || []);
  return database.guestbookMessages
    .filter(message => !deletedIds.has(String(message.id)))
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

function listCeremonyGuestbookMessages(ceremonyId = '') {
  const database = readJourJDatabase();
  const ceremony = getCeremony(database, ceremonyId);
  const deletedIds = new Set(database.deletedGuestbookMessageIds || []);
  return (ceremony?.guestbookMessages || [])
    .filter(message => !deletedIds.has(String(message.id)))
    .slice()
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

function addCeremonyGuestbookMessage(ceremonyId, input) {
  const name = String(input?.name || '').trim().slice(0, 120);
  const message = String(input?.message || '').trim().slice(0, 500);
  if (!name || !message) return null;
  const database = readJourJDatabase();
  const ceremony = getCeremony(database, ceremonyId);
  if (!ceremony) return null;
  const entry = { id: crypto.randomUUID(), name, message, attending: Boolean(input?.attending), created_at: new Date().toISOString() };
  ceremony.guestbookMessages = [entry, ...ceremony.guestbookMessages].slice(0, 300);
  ceremony.updatedAt = entry.created_at;
  writeJsonAtomically(JOUR_J_DATABASE_FILE, cleanInvitationDatabase(database));
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

function readCeremonySiteData(ceremonyId = '') {
  const database = readJourJDatabase();
  const ceremony = getCeremony(database, ceremonyId);
  if (ceremony && Object.keys(ceremony.siteData).length) return ceremony.siteData;
  return ceremony?.id === 'default' ? readSiteData() : {};
}

function writeCeremonySiteData(ceremonyId, data) {
  const database = readJourJDatabase();
  const ceremony = getCeremony(database, ceremonyId);
  if (!ceremony) throw new Error('ceremony-not-found');
  ceremony.siteData = {
    ...(ceremony.siteData && typeof ceremony.siteData === 'object' ? ceremony.siteData : {}),
    ...(data && typeof data === 'object' ? data : {})
  };
  ceremony.updatedAt = new Date().toISOString();
  if (ceremony.id === 'default') writeSiteData(ceremony.siteData);
  writeJsonAtomically(JOUR_J_DATABASE_FILE, cleanInvitationDatabase(database));
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

function saveUploadedImage(imageData, category = 'image') {
  const match = String(imageData || '').match(/^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) throw new Error('invalid-image');
  const extension = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
  const binary = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!binary.length || binary.length > 12 * 1024 * 1024) throw new Error('image-too-large');

  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const safeCategory = String(category || 'image').replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'image';
  const filename = `${safeCategory}-${crypto.randomUUID()}.${extension}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), binary);
  // URL publique stable. Les anciennes images /work/uploads restent servies
  // pour ne pas casser les invitations déjà enregistrées.
  return `/uploads/${filename}`;
}

function decodeInvitationImage(imageData) {
  const match = String(imageData || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) throw new Error('invalid-image-format');
  const mimeType = match[1].toLowerCase();
  const binary = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!binary.length || binary.length > MAX_INVITATION_IMAGE_SIZE) throw new Error('image-too-large');
  const signatures = {
    'image/jpeg': buffer => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
    'image/png': buffer => buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    'image/webp': buffer => buffer.length >= 12 && buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP'
  };
  if (!signatures[mimeType](binary)) throw new Error('invalid-image-content');
  return { binary, mimeType, extension: mimeType === 'image/jpeg' ? 'jpg' : mimeType.slice('image/'.length) };
}

function saveInvitationImage(imageData) {
  const decoded = decodeInvitationImage(imageData);
  fs.mkdirSync(INVITATION_UPLOADS_DIR, { recursive: true });
  const fileName = `${crypto.randomUUID()}.${decoded.extension}`;
  const target = path.join(INVITATION_UPLOADS_DIR, fileName);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, decoded.binary);
  fs.renameSync(temporary, target);
  if (!fs.existsSync(target)) throw new Error('image-write-failed');
  return { fileName, mimeType: decoded.mimeType, size: decoded.binary.length, updatedAt: new Date().toISOString(), version: crypto.randomUUID() };
}

function removeInvitationImage(image) {
  const metadata = cleanInvitationImage(image);
  if (!metadata) return;
  const target = path.resolve(INVITATION_UPLOADS_DIR, metadata.fileName);
  if (target.startsWith(INVITATION_UPLOADS_DIR + path.sep) && fs.existsSync(target)) fs.unlinkSync(target);
}

function publicInvitationImage(image) {
  const metadata = cleanInvitationImage(image);
  if (!metadata) return null;
  const target = path.join(INVITATION_UPLOADS_DIR, metadata.fileName);
  if (!fs.existsSync(target)) return null;
  // Route dédiée : elle sert l'image depuis son dossier protégé, sans dépendre du
  // routage général des fichiers statiques.
  return { url: `/media/invitations/${metadata.fileName}?v=${encodeURIComponent(metadata.version || metadata.updatedAt)}`, updatedAt: metadata.updatedAt, version: metadata.version };
}

function json(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Secret, X-Reset-Token',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    ...extraHeaders
  });
  res.end(JSON.stringify(body));
}

function publishDataEvent(type, ceremonyId, payload = {}) {
  const event = `event: ${type}\ndata: ${JSON.stringify({ type, ceremonyId, ...payload })}\n\n`;
  for (const client of eventClients) {
    if (client.ceremonyId && client.ceremonyId !== ceremonyId) continue;
    try { client.res.write(event); } catch (error) { eventClients.delete(client); }
  }
}

function guestTokenFromRequest(url, body = {}) {
  return String(body.invite || body.token || url.searchParams.get('invite') || url.searchParams.get('token') || '').trim();
}

function findInviteContext(database, ceremonyId, token) {
  if (!token) return null;
  let ceremony = getCeremony(database, ceremonyId);
  if (!ceremony?.invitations?.[token]) {
    ceremony = Object.values(database.ceremonies).find(item => item.invitations?.[token]);
  }
  const invite = ceremony?.invitations?.[token];
  return invite ? { ceremony, invite, token } : null;
}

function guestbookEntryForInvite(input, invite, ceremonyId) {
  const message = String(input?.message || '').trim().slice(0, 500);
  if (!invite || !message) return null;
  const status = ['confirmed', 'pending', 'delegated', 'declined'].includes(input.status)
    ? input.status
    : (input.attending ? 'confirmed' : 'pending');
  return {
    id: crypto.randomUUID(),
    guestId: invite.id || '',
    name: String(invite.fullName || 'Invité').trim().slice(0, 160),
    message,
    attending: status === 'confirmed',
    status,
    delegateName: String(input.delegateName || '').trim().slice(0, 160),
    delegatePhone: String(input.delegatePhone || '').trim().slice(0, 60),
    ceremonyId,
    created_at: new Date().toISOString()
  };
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

function inviteAccess(req, providedDeviceId, inviteCode, requestedCeremonyId = '') {
  const resolvedDevice = resolveClientDevice(req, providedDeviceId);
  const deviceId = resolvedDevice.deviceId;
  const database = readJourJDatabase();
  let ceremony = getCeremony(database, requestedCeremonyId);
  // Les anciens liens ne contiennent pas de paramètre cérémonie. On retrouve
  // alors le bon lien dans toutes les cérémonies sans les mélanger.
  if (!ceremony?.invitations?.[inviteCode]) {
    ceremony = Object.values(database.ceremonies).find(item => item.invitations?.[inviteCode]);
  }
  const now = new Date().toISOString();
  const invite = ceremony?.invitations?.[inviteCode];

  if (!invite) {
    return {
      body: { allowed: false, locked: true, mode: 'invite', reason: 'unknown-invite' },
      headers: resolvedDevice.headers
    };
  }

  if (invite.revoked || invite.active === false) {
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
    ceremony.updatedAt = now;
    writeJsonAtomically(JOUR_J_DATABASE_FILE, cleanInvitationDatabase(database));
    return {
      body: { allowed: true, locked: false, mode: 'invite', inviteCode, ceremonyId: ceremony.id, guest: { id: invite.id || inviteCode, fullName: invite.fullName || '', phone: invite.phone || '' } },
      headers: resolvedDevice.headers
    };
  }

  if (invite.deviceId === deviceId) {
    invite.lastSeen = now;
    ceremony.updatedAt = now;
    writeJsonAtomically(JOUR_J_DATABASE_FILE, cleanInvitationDatabase(database));
    return {
      body: { allowed: true, locked: false, mode: 'invite', inviteCode, ceremonyId: ceremony.id, guest: { id: invite.id || inviteCode, fullName: invite.fullName || '', phone: invite.phone || '' } },
      headers: resolvedDevice.headers
    };
  }

  invite.blockedAttempts = (invite.blockedAttempts || 0) + 1;
  invite.lastBlockedAt = now;
  ceremony.updatedAt = now;
  writeJsonAtomically(JOUR_J_DATABASE_FILE, cleanInvitationDatabase(database));
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

function guestPublicView(invite, token, req, ceremonyId = '') {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const origin = `${proto}://${req.headers.host}`;
  return {
    id: invite.id || token,
    ceremonyId,
    fullName: invite.fullName || 'Invité',
    phone: invite.phone || '',
    token,
    url: `${origin}/?invite=${encodeURIComponent(token)}${ceremonyId ? `&ceremony=${encodeURIComponent(ceremonyId)}` : ''}`,
    active: invite.active !== false && !invite.revoked,
    createdAt: invite.createdAt || '',
    updatedAt: invite.updatedAt || '',
    firstUsedAt: invite.firstUsedAt || '',
    lastSeen: invite.lastSeen || '',
    blockedAttempts: invite.blockedAttempts || 0
  };
}

function guestList(state, req, ceremonyId = '') {
  return Object.entries(state.invites)
    .map(([token, invite]) => guestPublicView(invite, token, req, ceremonyId))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function findGuestToken(state, id) {
  if (state.invites[id]) return id;
  return Object.entries(state.invites).find(([, invite]) => invite.id === id)?.[0] || '';
}

function serveFile(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const isPublicUpload = pathname.startsWith('/uploads/');
  const filePath = isPublicUpload
    ? path.resolve(UPLOADS_DIR, pathname.slice('/uploads/'.length))
    : path.resolve(ROOT, `.${pathname}`);
  const allowedRoot = isPublicUpload ? UPLOADS_DIR : ROOT;

  if (!filePath.startsWith(allowedRoot + path.sep) && filePath !== allowedRoot) {
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
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.json': 'application/json; charset=utf-8'
    }[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

function serveInvitationImage(res, fileName) {
  if (!/^[a-f0-9-]{36}\.(?:jpg|png|webp)$/i.test(fileName)) {
    res.writeHead(404); res.end('Not found'); return;
  }
  const target = path.resolve(INVITATION_UPLOADS_DIR, fileName);
  if (!target.startsWith(INVITATION_UPLOADS_DIR + path.sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(target, (error, data) => {
    if (error) { res.writeHead(404); res.end('Not found'); return; }
    const extension = path.extname(target).toLowerCase();
    const type = extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    json(res, 200, { ok: true });
    return;
  }

  if (url.pathname === '/api/events' && req.method === 'GET') {
    const ceremonyId = ceremonyIdFrom(url);
    const inviteCode = guestTokenFromRequest(url);
    const admin = isAdminRequest(req, url);
    if (!admin && !findInviteContext(readJourJDatabase(), ceremonyId, inviteCode)) {
      json(res, 403, { ok: false, error: 'forbidden' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write(': connected\n\n');
    const client = { res, ceremonyId, admin };
    eventClients.add(client);
    const heartbeat = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch (error) { clearInterval(heartbeat); eventClients.delete(client); }
    }, 25000);
    req.on('close', () => { clearInterval(heartbeat); eventClients.delete(client); });
    return;
  }

  if (url.pathname.startsWith('/media/invitations/') && req.method === 'GET') {
    serveInvitationImage(res, decodeURIComponent(url.pathname.slice('/media/invitations/'.length)));
    return;
  }

  if (url.pathname === '/api/share' && req.method === 'GET') {
    if (isAdminRequest(req, url)) {
      json(res, 200, adminAccess());
      return;
    }

    const inviteCode = url.searchParams.get('invite') || '';
    if (isValidInviteCode(inviteCode)) {
      const result = inviteAccess(req, url.searchParams.get('deviceId') || '', inviteCode, ceremonyIdFrom(url));
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
        const result = inviteAccess(req, body.deviceId || '', body.invite, ceremonyIdFrom(url, body));
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
      ceremonyId: getCeremony(readJourJDatabase(), ceremonyIdFrom(url)).id,
      data: readCeremonySiteData(ceremonyIdFrom(url))
    });
    return;
  }

  if (url.pathname === '/api/invitation-image' && req.method === 'GET') {
    const ceremony = getCeremony(readJourJDatabase(), ceremonyIdFrom(url));
    json(res, 200, { ok: true, ceremonyId: ceremony.id, image: publicInvitationImage(ceremony.invitationImage) });
    return;
  }

  if (url.pathname === '/api/invitation-image' && req.method === 'POST') {
    try {
      const body = await getBody(req, Math.ceil(MAX_INVITATION_IMAGE_SIZE * 1.4));
      if (!isAdminRequest(req, url, body)) { json(res, 403, { ok: false, error: 'forbidden' }); return; }
      const database = readJourJDatabase();
      const ceremony = getCeremony(database, ceremonyIdFrom(url, body));
      const previousImage = ceremony.invitationImage;
      const image = saveInvitationImage(body.imageData);
      ceremony.invitationImage = image;
      ceremony.updatedAt = image.updatedAt;
      writeJsonAtomically(JOUR_J_DATABASE_FILE, cleanInvitationDatabase(database));
      try { removeInvitationImage(previousImage); } catch (e) { console.warn('Ancienne image invitation non supprimée', e.message); }
      json(res, 201, { ok: true, ceremonyId: ceremony.id, image: publicInvitationImage(image) });
    } catch (e) {
      const errors = ['image-too-large', 'invalid-image-format', 'invalid-image-content', 'image-write-failed'];
      json(res, 400, { ok: false, error: errors.includes(e.message) ? e.message : 'upload-failed' });
    }
    return;
  }

  if (url.pathname === '/api/invitation-image' && req.method === 'DELETE') {
    try {
      const body = await getBody(req);
      if (!isAdminRequest(req, url, body)) { json(res, 403, { ok: false, error: 'forbidden' }); return; }
      if (body.confirmed !== true) { json(res, 400, { ok: false, error: 'explicit-confirmation-required' }); return; }
      const database = readJourJDatabase();
      const ceremony = getCeremony(database, ceremonyIdFrom(url, body));
      const previousImage = ceremony.invitationImage;
      ceremony.invitationImage = null;
      ceremony.updatedAt = new Date().toISOString();
      writeJsonAtomically(JOUR_J_DATABASE_FILE, cleanInvitationDatabase(database));
      try { removeInvitationImage(previousImage); } catch (e) { console.warn('Image invitation non supprimée', e.message); }
      json(res, 200, { ok: true, ceremonyId: ceremony.id });
    } catch (e) { json(res, 400, { ok: false, error: 'bad-request' }); }
    return;
  }

  if (url.pathname === '/api/upload-image' && req.method === 'POST') {
    try {
      const body = await getBody(req, MAX_SITE_DATA_BODY_SIZE);
      if (!isAdminRequest(req, url, body)) {
        json(res, 403, { ok: false, error: 'forbidden' });
        return;
      }
      json(res, 201, { ok: true, url: saveUploadedImage(body.imageData, body.category) });
    } catch (e) {
      json(res, 400, { ok: false, error: e.message === 'image-too-large' ? 'image-too-large' : 'invalid-image' });
    }
    return;
  }

  if (url.pathname === '/api/site-data' && req.method === 'POST') {
    try {
      const body = await getBody(req, MAX_SITE_DATA_BODY_SIZE);

      if (!isAdminRequest(req, url, body)) {
        json(res, 403, { ok: false, error: 'forbidden' });
        return;
      }

      writeCeremonySiteData(ceremonyIdFrom(url, body), body.data || {});
      publishDataEvent('site-data-changed', ceremonyIdFrom(url, body));
      json(res, 200, { ok: true });
    } catch (e) {
      json(res, 400, { ok: false, error: 'bad-request' });
    }
    return;
  }

  if (url.pathname === '/api/ceremonies' && req.method === 'GET') {
    if (!isAdminRequest(req, url)) {
      json(res, 403, { ok: false, error: 'forbidden' });
      return;
    }
    const database = readJourJDatabase();
    json(res, 200, {
      ok: true,
      activeCeremonyId: database.activeCeremonyId,
      ceremonies: Object.values(database.ceremonies).map(publicCeremony).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    });
    return;
  }

  if (url.pathname === '/api/ceremonies' && req.method === 'POST') {
    try {
      const body = await getBody(req);
      if (!isAdminRequest(req, url, body)) {
        json(res, 403, { ok: false, error: 'forbidden' });
        return;
      }
      const database = readJourJDatabase();
      const action = String(body.action || '').trim();
      const now = new Date().toISOString();
      const id = String(body.id || '').trim();

      if (action === 'delete' && body.confirmed !== true) {
        json(res, 400, { ok: false, error: 'explicit-confirmation-required' });
        return;
      }

      if (action === 'create') {
        const name = String(body.name || '').trim().slice(0, 160);
        if (!name) {
          json(res, 400, { ok: false, error: 'invalid-name' });
          return;
        }
        const ceremonyId = `ceremony_${crypto.randomUUID()}`;
        database.ceremonies[ceremonyId] = {
          id: ceremonyId, name, date: String(body.date || '').slice(0, 60), details: String(body.details || '').slice(0, 1000),
          status: 'draft', createdAt: now, updatedAt: now, siteData: {}, invitations: {}, guestbookMessages: []
        };
        database.activeCeremonyId = ceremonyId;
      } else if (!database.ceremonies[id]) {
        json(res, 404, { ok: false, error: 'ceremony-not-found' });
        return;
      } else if (action === 'select') {
        database.activeCeremonyId = id;
      } else if (action === 'update') {
        const ceremony = database.ceremonies[id];
        const name = String(body.name || '').trim().slice(0, 160);
        if (!name) {
          json(res, 400, { ok: false, error: 'invalid-name' });
          return;
        }
        ceremony.name = name;
        ceremony.date = String(body.date || '').slice(0, 60);
        ceremony.details = String(body.details || '').slice(0, 1000);
        ceremony.status = ['active', 'draft', 'archived'].includes(body.status) ? body.status : ceremony.status;
        ceremony.updatedAt = now;
      } else if (action === 'delete') {
        if (Object.keys(database.ceremonies).length === 1) {
          json(res, 400, { ok: false, error: 'last-ceremony' });
          return;
        }
        const imageToRemove = database.ceremonies[id].invitationImage;
        delete database.ceremonies[id];
        if (database.activeCeremonyId === id) database.activeCeremonyId = Object.keys(database.ceremonies)[0];
        try { removeInvitationImage(imageToRemove); } catch (e) { console.warn('Image de cérémonie non supprimée', e.message); }
      } else {
        json(res, 400, { ok: false, error: 'invalid-action' });
        return;
      }
      writeJsonAtomically(JOUR_J_DATABASE_FILE, cleanInvitationDatabase(database), { allowDataLoss: action === 'delete' });
      publishDataEvent('ceremony-changed', database.activeCeremonyId, { ceremonies: Object.values(database.ceremonies).map(publicCeremony) });
      json(res, 200, { ok: true, activeCeremonyId: database.activeCeremonyId, ceremonies: Object.values(database.ceremonies).map(publicCeremony) });
    } catch (e) {
      json(res, 400, { ok: false, error: 'bad-request' });
    }
    return;
  }

  if (url.pathname === '/api/guestbook' && req.method === 'GET') {
    const database = readJourJDatabase();
    const requestedCeremonyId = url.searchParams.get('ceremony') || url.searchParams.get('ceremonyId') || '';
    if (requestedCeremonyId === 'all') {
      if (!isAdminRequest(req, url)) {
        json(res, 403, { ok: false, error: 'forbidden' });
        return;
      }
      const messages = Object.values(database.ceremonies)
        .flatMap(ceremony => listCeremonyGuestbookMessages(ceremony.id).map(message => ({ ...message, ceremonyId: message.ceremonyId || ceremony.id })));
      json(res, 200, { ok: true, ceremonyId: 'all', messages });
      return;
    }
    const ceremony = getCeremony(database, requestedCeremonyId);
    json(res, 200, { ok: true, ceremonyId: ceremony.id, messages: listCeremonyGuestbookMessages(ceremony.id) });
    return;
  }

  if (url.pathname === '/api/guestbook' && req.method === 'POST') {
    try {
      const body = await getBody(req);
      const database = readJourJDatabase();
      const ceremonyId = ceremonyIdFrom(url, body);
      const ceremony = getCeremony(database, ceremonyId);
      const adminRequest = isAdminRequest(req, url, body);
      const inviteContext = findInviteContext(database, ceremony.id, guestTokenFromRequest(url, body));
      if (!adminRequest && !inviteContext) {
        json(res, 403, { ok: false, error: 'invitation-required' });
        return;
      }
      const entry = adminRequest
        ? addCeremonyGuestbookMessage(ceremony.id, body)
        : guestbookEntryForInvite(body, inviteContext.invite, inviteContext.ceremony.id);
      if (!entry) {
        json(res, 400, { ok: false, error: 'invalid-message' });
        return;
      }
      if (!adminRequest) {
        inviteContext.ceremony.guestbookMessages = [entry, ...inviteContext.ceremony.guestbookMessages].slice(0, 300);
        inviteContext.ceremony.updatedAt = entry.created_at;
        writeJsonAtomically(JOUR_J_DATABASE_FILE, cleanInvitationDatabase(database));
      }
      publishDataEvent('guestbook-changed', ceremony.id, { message: entry });
      json(res, 201, { ok: true, message: entry });
    } catch (e) {
      json(res, 400, { ok: false, error: 'bad-request' });
    }
    return;
  }

  if (url.pathname === '/api/guestbook' && req.method === 'DELETE') {
    try {
      const body = await getBody(req);
      if (!isAdminRequest(req, url, body)) {
        json(res, 403, { ok: false, error: 'forbidden' });
        return;
      }
      if (body.confirmed !== true) {
        json(res, 400, { ok: false, error: 'explicit-confirmation-required' });
        return;
      }
      const database = readJourJDatabase();
      const ceremony = getCeremony(database, ceremonyIdFrom(url, body));
      const messageId = String(body.id || '').trim();
      if (!messageId) {
        json(res, 400, { ok: false, error: 'message-id-required' });
        return;
      }
      const matchingMessage = Object.values(database.ceremonies)
        .flatMap(item => item.guestbookMessages || [])
        .find(message => String(message.id) === messageId);
      if (!matchingMessage) {
        json(res, 404, { ok: false, error: 'message-not-found' });
        return;
      }
      const deletedAt = new Date().toISOString();
      database.deletedGuestbookMessageIds = Array.from(new Set([
        ...(database.deletedGuestbookMessageIds || []),
        messageId
      ])).slice(-2000);
      Object.values(database.ceremonies).forEach(item => {
        item.guestbookMessages = (item.guestbookMessages || []).filter(message => String(message.id) !== messageId);
        item.updatedAt = deletedAt;
      });
      writeJsonAtomically(JOUR_J_DATABASE_FILE, cleanInvitationDatabase(database), { allowDataLoss: action === 'delete' || action === 'regenerate' });
      publishDataEvent('guestbook-changed', matchingMessage.ceremonyId || ceremony.id, { deletedId: messageId });
      json(res, 200, { ok: true, ceremonyId: matchingMessage.ceremonyId || ceremony.id, messages: listCeremonyGuestbookMessages(matchingMessage.ceremonyId || ceremony.id) });
    } catch (e) { json(res, 400, { ok: false, error: 'bad-request' }); }
    return;
  }

  if (url.pathname === '/api/guests' && req.method === 'GET') {
    if (!isAdminRequest(req, url)) {
      json(res, 403, { ok: false, error: 'forbidden' });
      return;
    }
    const database = readJourJDatabase();
    const requestedCeremonyId = url.searchParams.get('ceremony') || url.searchParams.get('ceremonyId') || '';
    if (requestedCeremonyId === 'all') {
      const guests = Object.values(database.ceremonies)
        .flatMap(ceremony => guestList({ invites: ceremony.invitations }, req, ceremony.id));
      json(res, 200, { ok: true, ceremonyId: 'all', guests });
      return;
    }
    const ceremony = getCeremony(database, requestedCeremonyId);
    json(res, 200, { ok: true, ceremonyId: ceremony.id, guests: guestList({ invites: ceremony.invitations }, req, ceremony.id) });
    return;
  }

  if (url.pathname === '/api/guests' && req.method === 'POST') {
    try {
      const body = await getBody(req);
      if (!isAdminRequest(req, url, body)) {
        json(res, 403, { ok: false, error: 'forbidden' });
        return;
      }

      const database = readJourJDatabase();
      const ceremony = getCeremony(database, ceremonyIdFrom(url, body));
      const state = { invites: ceremony.invitations };
      const action = String(body.action || '').trim();
      const now = new Date().toISOString();
      let token = findGuestToken(state, String(body.id || ''));

      if (action === 'create') {
        const fullName = String(body.fullName || '').trim().slice(0, 160);
        const phone = String(body.phone || '').trim().slice(0, 60);
        if (!fullName) {
          json(res, 400, { ok: false, error: 'invalid-name' });
          return;
        }
        token = createInviteCode();
        while (state.invites[token]) token = createInviteCode();
        state.invites[token] = {
          id: token,
          fullName,
          phone,
          createdAt: now,
          updatedAt: now,
          active: true,
          revoked: false,
          deviceId: '',
          firstUsedAt: '',
          lastSeen: '',
          blockedAttempts: 0
        };
      } else if (!token) {
        json(res, 404, { ok: false, error: 'guest-not-found' });
        return;
      } else if (action === 'update') {
        const fullName = String(body.fullName || '').trim().slice(0, 160);
        if (!fullName) {
          json(res, 400, { ok: false, error: 'invalid-name' });
          return;
        }
        state.invites[token].fullName = fullName;
        state.invites[token].phone = String(body.phone || '').trim().slice(0, 60);
        state.invites[token].updatedAt = now;
      } else if (action === 'toggle') {
        const active = Boolean(body.active);
        state.invites[token].active = active;
        state.invites[token].revoked = !active;
        state.invites[token].updatedAt = now;
      } else if (action === 'delete') {
        if (body.confirmed !== true) {
          json(res, 400, { ok: false, error: 'explicit-confirmation-required' });
          return;
        }
        delete state.invites[token];
      } else if (action === 'regenerate') {
        const guest = { ...state.invites[token], id: '' };
        let nextToken = createInviteCode();
        while (state.invites[nextToken]) nextToken = createInviteCode();
        delete state.invites[token];
        state.invites[nextToken] = {
          ...guest,
          id: nextToken,
          active: true,
          revoked: false,
          deviceId: '',
          firstUsedAt: '',
          lastSeen: '',
          blockedAttempts: 0,
          updatedAt: now
        };
      } else {
        json(res, 400, { ok: false, error: 'invalid-action' });
        return;
      }

      ceremony.invitations = state.invites;
      ceremony.updatedAt = now;
      writeJsonAtomically(JOUR_J_DATABASE_FILE, cleanInvitationDatabase(database));
      publishDataEvent('guest-changed', ceremony.id, { guests: guestList({ invites: ceremony.invitations }, req, ceremony.id) });
      json(res, 200, { ok: true, ceremonyId: ceremony.id, guests: guestList({ invites: ceremony.invitations }, req, ceremony.id) });
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
