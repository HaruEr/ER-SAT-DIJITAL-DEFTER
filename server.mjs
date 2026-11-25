import { IdentityStore, IdentityError } from './identity.mjs';
import { deny, requireSession, DownloadTickets, checkoutState, customerChoices, customerDetail, requireWorkerTrade, requireWorkerAccounts } from './editor-access.mjs';
import http from 'node:http';
import { accessSync, constants as fsConstants, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { Repository, BACKUP_MAX_BYTES } from './repository.mjs';
import { DomainError, fail, isWorkerCustomerCreation } from './domain.mjs';
const directory = path.dirname(fileURLToPath(import.meta.url));
const diagnosticCodes = new Set(['EACCES', 'EPERM', 'ENOENT', 'ENOSPC', 'EIO', 'EMFILE', 'ENFILE', 'ERR_SQLITE_ERROR', 'SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_CORRUPT', 'SQLITE_FULL', 'SQLITE_CANTOPEN', 'SQLITE_IOERR', 'BACKUP_HISTORY_INVALID', 'STORED_HISTORY_INVALID']);
const operations = new Map(['state', 'summary', 'backup', 'command', 'restore', 'recovery'].map(name => [`/api/${name}`, name]));
operations.set('/api/archive', 'archive');
operations.set('/api/archive/restore', 'archive-restore');
operations.set('/api/journal', 'journal');
operations.set('/api/item-photo', 'item-photo');
operations.set('/api/account-statement', 'account-statement');
const staticFiles = new Map([
  ['/', ['login.html', 'text/html; charset=utf-8']],
  ['/login.js', ['login.js', 'text/javascript; charset=utf-8']],
  ['/access-client.js', ['access-client.js', 'text/javascript; charset=utf-8']],
  ['/draft-store.js', ['draft-store.js', 'text/javascript; charset=utf-8']],
  ['/amount-codec.js', ['amount-codec.js', 'text/javascript; charset=utf-8']],
  ['/date-format.js', ['date-format.js', 'text/javascript; charset=utf-8']],
  ['/ui-kit.js', ['ui-kit.js', 'text/javascript; charset=utf-8']],
  ['/search-norm.js', ['search-norm.js', 'text/javascript; charset=utf-8']],
  ['/combobox.js', ['combobox.js', 'text/javascript; charset=utf-8']],
  ['/command-palette.js', ['command-palette.js', 'text/javascript; charset=utf-8']],
  ['/users', ['users.html', 'text/html; charset=utf-8']],
  ['/users.js', ['users.js', 'text/javascript; charset=utf-8']],
  ['/access.css', ['access.css', 'text/css; charset=utf-8']],
  ['/motion.css', ['motion.css', 'text/css; charset=utf-8']],
  ['/ui-prefs.js', ['ui-prefs.js', 'text/javascript; charset=utf-8']],
  ['/checkout', ['checkout.html', 'text/html; charset=utf-8']],
  ['/checkout.js', ['checkout.js', 'text/javascript; charset=utf-8']],
  ['/owner', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/suppliers.js', ['suppliers.js', 'text/javascript; charset=utf-8']],
  ['/supplier-pdf.js', ['supplier-pdf.js', 'text/javascript; charset=utf-8']],
  ['/vendor/pdfmake/pdfmake.min.js', ['vendor/pdfmake/pdfmake.min.js', 'text/javascript; charset=utf-8']],
  ['/vendor/pdfmake/vfs_fonts.js', ['vendor/pdfmake/vfs_fonts.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]
]);
const PROXY_MARKER_RE = /^(?:forwarded$|x-forwarded-|x-real-ip$|tailscale-|x-store-proxy-secret$)/i;
const CONTROL_OR_INVISIBLE_RE = /[\s\r\n\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
const LOGIN_ENTRY_RE = /^[^\s,*\r\n\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]{1,254}$/;
const DNS_HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const CHECKOUT_BLOCKED_STATIC = new Set([
  '/owner',
  '/users',
  '/app.js',
  '/suppliers.js',
  '/supplier-pdf.js',
  '/users.js',
  '/vendor/pdfmake/pdfmake.min.js',
  '/vendor/pdfmake/vfs_fonts.js'
]);
const CHECKOUT_BLOCKED_API = new Set([
  '/api/state',
  '/api/suppliers',
  '/api/backup',
  '/api/archive',
  '/api/archive/restore',
  '/api/restore',
  '/api/recovery',
  '/api/journal',
  '/api/summary',
  '/api/account-statement',
  '/api/item-photo',
  '/api/download-ticket',
  '/api/pending-approvals/approve',
  '/api/pending-approvals/reject',
  '/api/auth/setup',
  '/api/auth/employees',
  '/api/auth/disable',
  '/api/auth/reset-pin',
  '/api/auth/rename'
]);
const CHECKOUT_ALLOWED_API = new Set([
  '/api/auth/users',
  '/api/auth/session',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/change-pin',
  '/api/checkout',
  '/api/customers',
  '/api/pending-approvals',
  '/api/command'
]);
const validatedDeployConfigs = new WeakSet();

function sha256Buffer(value) {
  return createHash('sha256').update(String(value), 'utf8').digest();
}

function constantTimeTokenMatch(provided, expectedDigest) {
  if (typeof provided !== 'string' || !provided || !expectedDigest) return false;
  return timingSafeEqual(sha256Buffer(provided), expectedDigest);
}

function validateSecretValue(value, label) {
  if (typeof value !== 'string' || value.length < 16 || CONTROL_OR_INVISIBLE_RE.test(value)) {
    throw new Error(`${label} en az 16 karakter olmalı ve boşluk veya kontrol karakteri içermemelidir.`);
  }
  return value;
}

function normalizeAllowedHost(entry, label = 'İzinli alan adı') {
  if (typeof entry !== 'string' || !entry || entry !== entry.trim()) {
    throw new Error(`${label} boşluksuz geçerli bir alan adı olmalı.`);
  }
  if (/[\s*\/\\?#@%\r\n\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff_]/.test(entry) || entry.startsWith('.') || entry.endsWith('.') || entry.includes('..') || /:\s*$/.test(entry)) {
    throw new Error(`${label} geçersiz karakter veya biçim içeriyor.`);
  }
  let parsed;
  try {
    parsed = new URL(`https://${entry}`);
  } catch {
    throw new Error(`${label} geçerli bir alan adı olmalı.`);
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '' || !parsed.hostname || parsed.port === '0') {
    throw new Error(`${label} yalnız alan adı ve isteğe bağlı port içerebilir.`);
  }
  if (parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')) {
    if (isIP(parsed.hostname.slice(1, -1)) !== 6) {
      throw new Error(`${label} geçerli bir IPv6 adresi olmalı.`);
    }
  } else if (!DNS_HOST_RE.test(parsed.hostname)) {
    throw new Error(`${label} geçerli bir alan adı olmalı.`);
  }
  if (parsed.port !== '') {
    const portNum = Number(parsed.port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      throw new Error(`${label} geçerli bir port numarası içermeli.`);
    }
  }
  return parsed.host;
}

function toEntryList(value, label) {
  if (value instanceof Set) return [...value];
  if (Array.isArray(value)) return value;
  throw new Error(`${label} boş olmayan bir liste olmalı.`);
}

function parseCsvEnv(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  if (typeof raw !== 'string') return [];
  return raw.split(',').map(item => item.replace(/^[ \t]+|[ \t]+$/g, ''));
}

function normalizeClientIp(rawIp) {
  if (typeof rawIp !== 'string' || !rawIp || /[\s,\r\n\u0000-\u001f\u007f%]/.test(rawIp)) return null;
  const mapped = rawIp.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped && isIP(mapped[1]) === 4) return mapped[1];
  const family = isIP(rawIp);
  if (family === 4) return rawIp;
  if (family === 6) return rawIp.toLowerCase();
  return null;
}

function buildAllowedBlockList(entries) {
  const list = toEntryList(entries, 'STORE_ALLOWED_IPS');
  if (!list.length || list.length > 500) {
    throw new Error('STORE_ALLOWED_IPS 1 ile 500 arasında geçerli IP veya CIDR içermeli.');
  }
  const blockList = new BlockList();
  for (const rawEntry of list) {
    if (typeof rawEntry !== 'string' || !rawEntry || /[\s,\r\n\u0000-\u001f\u007f%]/.test(rawEntry)) {
      throw new Error('STORE_ALLOWED_IPS geçersiz IP veya CIDR girişi içeriyor.');
    }
    if (rawEntry.includes('/')) {
      const parts = rawEntry.split('/');
      if (parts.length !== 2 || !/^\d{1,3}$/.test(parts[1])) {
        throw new Error('STORE_ALLOWED_IPS geçersiz CIDR öneki içeriyor.');
      }
      const [ipPart, prefixStr] = parts;
      const prefix = Number(prefixStr);
      const familyNum = isIP(ipPart);
      if (familyNum === 4) {
        if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
          throw new Error('STORE_ALLOWED_IPS IPv4 CIDR öneki 0–32 arasında olmalı.');
        }
        blockList.addSubnet(ipPart, prefix, 'ipv4');
      } else if (familyNum === 6) {
        if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) {
          throw new Error('STORE_ALLOWED_IPS IPv6 CIDR öneki 0–128 arasında olmalı.');
        }
        blockList.addSubnet(ipPart.toLowerCase(), prefix, 'ipv6');
      } else {
        throw new Error('STORE_ALLOWED_IPS geçersiz CIDR IP adresi içeriyor.');
      }
    } else {
      const normalized = normalizeClientIp(rawEntry);
      if (!normalized) {
        throw new Error('STORE_ALLOWED_IPS geçersiz IP adresi içeriyor.');
      }
      const familyNum = isIP(normalized);
      blockList.addAddress(normalized, familyNum === 4 ? 'ipv4' : 'ipv6');
    }
  }
  return blockList;
}

export function validateServerDeployConfig(config = {}) {
  if (validatedDeployConfigs.has(config)) return config;
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Geçersiz sunucu dağıtım yapılandırması.');
  }
  const mode = config.mode === undefined ? 'local' : config.mode;
  if (mode !== 'local' && mode !== 'cloud-proxy') {
    throw new Error('DEPLOY_MODE yalnız "local" veya "cloud-proxy" olabilir.');
  }
  let healthzTokenDigest = null;
  if (config.healthzToken !== undefined && config.healthzToken !== null && config.healthzToken !== '') {
    healthzTokenDigest = sha256Buffer(validateSecretValue(config.healthzToken, 'HEALTHZ_TOKEN'));
  }
  if (mode === 'local') {
    const validatedLocal = Object.freeze({
      mode: 'local',
      allowMasterFallback: true,
      hasHealthzToken: Boolean(healthzTokenDigest),
      healthzTokenDigest
    });
    validatedDeployConfigs.add(validatedLocal);
    return validatedLocal;
  }

  const rawLogins = toEntryList(config.ownerAllowedLogins, 'OWNER_ALLOWED_LOGINS');
  if (!rawLogins.length || rawLogins.length > 100) {
    throw new Error('OWNER_ALLOWED_LOGINS 1 ile 100 arasında geçerli Tailscale kullanıcısı içermeli.');
  }
  const ownerAllowedLogins = new Set();
  for (const login of rawLogins) {
    if (typeof login !== 'string' || !LOGIN_ENTRY_RE.test(login)) {
      throw new Error('OWNER_ALLOWED_LOGINS geçersiz kullanıcı girişi içeriyor.');
    }
    ownerAllowedLogins.add(login.toLowerCase());
  }

  const rawOwnerHosts = toEntryList(config.ownerAllowedHosts, 'OWNER_ALLOWED_HOSTS');
  if (!rawOwnerHosts.length || rawOwnerHosts.length > 100) {
    throw new Error('OWNER_ALLOWED_HOSTS 1 ile 100 arasında alan adı içermeli.');
  }
  const ownerAllowedHosts = new Set(rawOwnerHosts.map(entry => normalizeAllowedHost(entry, 'OWNER_ALLOWED_HOSTS')));

  const rawCheckoutHosts = toEntryList(config.checkoutAllowedHosts, 'CHECKOUT_ALLOWED_HOSTS');
  if (!rawCheckoutHosts.length || rawCheckoutHosts.length > 100) {
    throw new Error('CHECKOUT_ALLOWED_HOSTS 1 ile 100 arasında alan adı içermeli.');
  }
  const checkoutAllowedHosts = new Set(rawCheckoutHosts.map(entry => normalizeAllowedHost(entry, 'CHECKOUT_ALLOWED_HOSTS')));

  for (const host of ownerAllowedHosts) {
    if (checkoutAllowedHosts.has(host)) {
      throw new Error('OWNER_ALLOWED_HOSTS ve CHECKOUT_ALLOWED_HOSTS birbirinden tamamen ayrık olmalı.');
    }
  }

  const storeProxySecretDigest = sha256Buffer(validateSecretValue(config.storeProxySecret, 'STORE_PROXY_SECRET'));
  const storeAllowedBlockList = buildAllowedBlockList(config.storeAllowedIps);

  const validatedCloud = Object.freeze({
    mode: 'cloud-proxy',
    allowMasterFallback: false,
    ownerAllowedLogins,
    ownerAllowedHosts,
    checkoutAllowedHosts,
    storeProxySecretDigest,
    storeAllowedBlockList,
    hasHealthzToken: Boolean(healthzTokenDigest),
    healthzTokenDigest
  });
  validatedDeployConfigs.add(validatedCloud);
  return validatedCloud;
}

export function resolveServerDeployConfig(env = process.env) {
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    throw new Error('Geçersiz ortam yapılandırması.');
  }
  const rawMode = env.DEPLOY_MODE;
  const mode = rawMode === undefined || rawMode === null || rawMode === '' ? 'local' : rawMode;
  if (mode !== 'local' && mode !== 'cloud-proxy') {
    throw new Error('DEPLOY_MODE yalnız "local" veya "cloud-proxy" olabilir.');
  }
  const healthzToken = env.HEALTHZ_TOKEN !== undefined && env.HEALTHZ_TOKEN !== '' ? env.HEALTHZ_TOKEN : null;
  if (mode === 'local') {
    return validateServerDeployConfig({ mode: 'local', healthzToken });
  }
  return validateServerDeployConfig({
    mode: 'cloud-proxy',
    ownerAllowedLogins: parseCsvEnv(env.OWNER_ALLOWED_LOGINS),
    ownerAllowedHosts: parseCsvEnv(env.OWNER_ALLOWED_HOSTS),
    checkoutAllowedHosts: parseCsvEnv(env.CHECKOUT_ALLOWED_HOSTS),
    storeProxySecret: env.STORE_PROXY_SECRET,
    storeAllowedIps: parseCsvEnv(env.STORE_ALLOWED_IPS),
    healthzToken
  });
}

function rawHeaderValues(req, lowerName) {
  const raw = req.rawHeaders || [];
  const values = [];
  for (let i = 0; i < raw.length; i += 2) {
    if (String(raw[i]).toLowerCase() === lowerName) {
      values.push(raw[i + 1]);
    }
  }
  return values;
}

function hasRawHeader(req, lowerName) {
  const raw = req.rawHeaders || [];
  for (let i = 0; i < raw.length; i += 2) {
    if (String(raw[i]).toLowerCase() === lowerName) return true;
  }
  return false;
}

function hasRawHeaderPrefix(req, prefixLower) {
  const raw = req.rawHeaders || [];
  for (let i = 0; i < raw.length; i += 2) {
    if (String(raw[i]).toLowerCase().startsWith(prefixLower)) return true;
  }
  return false;
}

function isRoleAllowedOnChannel(channel, role) {
  if (channel === 'tailscale-owner') return role === 'owner';
  if (channel === 'store-checkout') return role === 'employee';
  return role === 'owner' || role === 'employee';
}

function probeSqliteFile(filePath, probeSql, openHandle = null) {
  let exists = false;
  try {
    exists = existsSync(filePath);
  } catch {
    return { present: true, accessible: false };
  }
  if (!exists) {
    if (openHandle?.db) {
      try {
        openHandle.db.prepare('SELECT 1 AS ok').get();
        return { present: false, memory: true, accessible: true };
      } catch {
        return { present: false, memory: true, accessible: false };
      }
    }
    return { present: false, accessible: null };
  }
  let st;
  try {
    st = statSync(filePath);
  } catch {
    return { present: true, accessible: false };
  }
  if (!st.isFile() || st.size < 100) {
    return { present: true, accessible: false };
  }
  let probeDb;
  try {
    probeDb = new DatabaseSync(filePath, { readOnly: true, timeout: 1000 });
    probeDb.exec('PRAGMA busy_timeout = 1000; PRAGMA trusted_schema = OFF; PRAGMA query_only = ON;');
    probeDb.prepare(probeSql).get();
    return { present: true, accessible: true };
  } catch {
    return { present: true, accessible: false };
  } finally {
    try { probeDb?.close(); } catch {}
  }
}

function checkHealthStatus(dataDirectory, repositories, mode) {
  let dirOk = false;
  try {
    const st = statSync(dataDirectory);
    if (st.isDirectory()) {
      accessSync(dataDirectory, fsConstants.R_OK);
      dirOk = true;
    }
  } catch {
    dirOk = false;
  }
  if (!dirOk) {
    return {
      ok: false,
      mode,
      db: {
        dataDirectory: false,
        identity: { present: false, accessible: false },
        workspaces: {
          dukkan: { present: false, accessible: false },
          demo: { present: false, accessible: false }
        }
      }
    };
  }
  const identity = probeSqliteFile(path.join(dataDirectory, 'identity.sqlite'), 'SELECT 1 FROM identity_users LIMIT 1');
  const dukkan = probeSqliteFile(path.join(dataDirectory, 'dukkan.sqlite'), 'SELECT 1 FROM meta WHERE id = 1', repositories.get('dukkan'));
  const demo = probeSqliteFile(path.join(dataDirectory, 'demo.sqlite'), 'SELECT 1 FROM meta WHERE id = 1', repositories.get('demo'));
  const ok = dirOk && identity.accessible !== false && dukkan.accessible !== false && demo.accessible !== false;
  return {
    ok,
    mode,
    db: {
      dataDirectory: dirOk,
      identity,
      workspaces: { dukkan, demo }
    }
  };
}

export function createApp({ dataDirectory = path.join(directory, 'data'), logger = record => console.error(JSON.stringify(record)), jsonBodyTimeoutMs = 15000, deploy = undefined } = {}) {
  const deployConfig = deploy === undefined ? validateServerDeployConfig({ mode: 'local' }) : validateServerDeployConfig(deploy);
  mkdirSync(dataDirectory, { recursive: true });
  let identities;
  function ensureIdentities() {
    return (identities ??= new IdentityStore(dataDirectory, { allowMasterFallback: deployConfig.allowMasterFallback }));
  }
  const downloads = new DownloadTickets();
  const repositories = new Map();
  function repo(workspace) {
    if (!['demo', 'dukkan'].includes(workspace)) fail('Çalışma alanı demo veya dukkan olmalı.');
    if (!repositories.has(workspace)) repositories.set(workspace, new Repository(path.join(dataDirectory, `${workspace}.sqlite`), workspace));
    return repositories.get(workspace);
  }
  const server = http.createServer(async (req, res) => {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" };
    let operation = 'request', workspace = null;
    function json(status, value, extra = {}) {
      // Serialization can fail; do it before committing response headers.
      const content = JSON.stringify(value);
      if (res.destroyed || res.headersSent) return;
      res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', ...extra });
      res.end(content);
    }
    async function readJson(bodyLimit) {
      const chunks = []; let length = 0;
      const expired = Symbol('json-body-timeout'); let bodyTimer;
      const deadline = new Promise(resolve => { bodyTimer = setTimeout(() => resolve(expired), jsonBodyTimeoutMs); });
      const iterator = req[Symbol.asyncIterator]();
      try {
        while (true) {
          const next = await Promise.race([iterator.next(), deadline]);
          if (next === expired) {
            res.once('finish', () => req.destroy());
            json(408, { error: 'İstek zamanında tamamlanmadı. Kayıt oluşturulmadı.' }, { Connection: 'close' });
            return;
          }
          if (next.done) break;
          length += next.value.length;
          if (length > bodyLimit) {
            res.once('finish', () => req.destroy());
            json(413, { error: bodyLimit > 8 * 1024 * 1024 ? 'Geri yükleme isteği desteklenen 64 MiB yedek ve işlem bilgisi sınırını aşıyor.' : 'İstek boyut sınırını aşıyor.' }, { Connection: 'close' });
            return;
          }
          chunks.push(next.value);
        }
      } finally { clearTimeout(bodyTimer); }
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('JSON dosyası okunamadı.'); }
      if (!data || Array.isArray(data) || typeof data !== 'object') fail('Geçersiz işlem içeriği.');
      return data;
    }
    try {
      if ((req.rawHeaders?.length || 0) > 80) {
        return json(431, { error: 'İstek başlık sayısı sınırı aşıldı.' }, { Connection: 'close' });
      }
      // Unconditionally reject Tailscale Funnel traffic across every mode and route.
      if (hasRawHeader(req, 'tailscale-funnel-request')) {
        return json(403, { error: 'Funnel üzerinden erişime izin verilmiyor.' });
      }
      if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) {
        return json(400, { error: 'Geçersiz istek adresi.' });
      }
      const hostValues = rawHeaderValues(req, 'host');
      if (hostValues.length !== 1 || typeof hostValues[0] !== 'string' || !hostValues[0]) {
        return json(403, { error: 'Geçersiz Host başlığı.' });
      }
      const rawHost = hostValues[0];
      const originValues = rawHeaderValues(req, 'origin');
      if (originValues.length > 1) {
        return json(403, { error: 'Farklı kaynaktan isteğe izin verilmiyor.' });
      }
      const proxyMarked = (req.rawHeaders || []).some((name, index) => index % 2 === 0 && PROXY_MARKER_RE.test(name));
      const localPeer = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress);
      const port = server.address()?.port;
      const localAllowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

      const parsedUrlPreview = new URL(req.url, 'http://localhost');
      if (parsedUrlPreview.pathname === '/healthz') {
        if (deployConfig.mode === 'local') {
          if (!localPeer || proxyMarked || !localAllowedHosts.has(rawHost)) {
            return json(403, { error: 'Bu adres yalnız ana bilgisayarda düzenleme içindir. Uzak erişimde rapor portalını kullanın.' });
          }
          if (originValues.length === 1 && originValues[0] !== `http://${rawHost}`) {
            return json(403, { error: 'Farklı kaynaktan isteğe izin verilmiyor.' });
          }
        } else {
          let healthzAuthorized = false;
          if (localPeer && !proxyMarked && localAllowedHosts.has(rawHost)) {
            if (originValues.length === 1 && originValues[0] !== `http://${rawHost}`) {
              return json(403, { error: 'Farklı kaynaktan isteğe izin verilmiyor.' });
            }
            healthzAuthorized = true;
          } else if (deployConfig.healthzTokenDigest) {
            const authHeaders = rawHeaderValues(req, 'authorization');
            const tokenHeaders = rawHeaderValues(req, 'x-healthz-token');
            if (authHeaders.length <= 1 && tokenHeaders.length <= 1 && !(authHeaders.length === 1 && tokenHeaders.length === 1) && (authHeaders.length === 1 || tokenHeaders.length === 1)) {
              const candidateToken = tokenHeaders.length === 1
                ? tokenHeaders[0]
                : authHeaders[0].match(/^Bearer ([^\s]+)$/)?.[1];
              if (candidateToken && !CONTROL_OR_INVISIBLE_RE.test(candidateToken) && constantTimeTokenMatch(candidateToken, deployConfig.healthzTokenDigest)) {
                if (localAllowedHosts.has(rawHost)) {
                  if (originValues.length === 1 && originValues[0] !== `http://${rawHost}`) {
                    return json(403, { error: 'Farklı kaynaktan isteğe izin verilmiyor.' });
                  }
                  healthzAuthorized = true;
                } else {
                  let normalizedHealthHost = null;
                  try { normalizedHealthHost = normalizeAllowedHost(rawHost); } catch { normalizedHealthHost = null; }
                  if (normalizedHealthHost && (deployConfig.ownerAllowedHosts.has(normalizedHealthHost) || deployConfig.checkoutAllowedHosts.has(normalizedHealthHost))) {
                    if (originValues.length === 1 && originValues[0] !== `https://${normalizedHealthHost}`) {
                      return json(403, { error: 'Farklı kaynaktan isteğe izin verilmiyor.' });
                    }
                    healthzAuthorized = true;
                  }
                }
              }
            }
          }
          if (!healthzAuthorized) {
            return json(403, { error: 'Sağlık kontrolüne erişim reddedildi.' });
          }
        }
        if (req.method !== 'GET') {
          return json(405, { error: 'Sağlık kontrolü yalnız GET ile desteklenir.' }, { Allow: 'GET' });
        }
        const health = checkHealthStatus(dataDirectory, repositories, deployConfig.mode);
        return json(health.ok ? 200 : 503, health);
      }

      let channel = 'local';
      let clientKey = 'local';
      let source = 'local';
      let base;
      if (deployConfig.mode === 'local') {
        // Editing is local-only. Serve/proxy traffic belongs to the separate reader.
        if (!localPeer || proxyMarked) return json(403, { error: 'Bu adres yalnız ana bilgisayarda düzenleme içindir. Uzak erişimde rapor portalını kullanın.' });
        if (!localAllowedHosts.has(rawHost)) return json(403, { error: 'Yalnız bu cihazdaki yerel adres destekleniyor.' });
        base = `http://${rawHost}`;
        if (originValues.length === 1 && originValues[0] !== base) return json(403, { error: 'Farklı kaynaktan isteğe izin verilmiyor.' });
      } else {
        if (!localPeer) return json(403, { error: 'Bu adres yalnız güvenilir yerel vekil üzerinden erişilebilir.' });
        let normalizedHost = null;
        try { normalizedHost = normalizeAllowedHost(rawHost); } catch { normalizedHost = null; }
        if (!normalizedHost) return json(403, { error: 'Geçersiz Host başlığı.' });
        if (deployConfig.ownerAllowedHosts.has(normalizedHost)) {
          channel = 'tailscale-owner';
        } else if (deployConfig.checkoutAllowedHosts.has(normalizedHost)) {
          channel = 'store-checkout';
        } else {
          return json(403, { error: 'Bu alan adı yapılandırılmış kanallarla eşleşmiyor.' });
        }
        base = `https://${normalizedHost}`;
        if (originValues.length === 1 && originValues[0] !== base) {
          return json(403, { error: 'Farklı kaynaktan isteğe izin verilmiyor.' });
        }
        if (channel === 'tailscale-owner') {
          if (hasRawHeader(req, 'x-store-proxy-secret') || hasRawHeader(req, 'x-real-ip')) {
            return json(403, { error: 'Bu kanalda mağaza vekil başlıklarına izin verilmiyor.' });
          }
          const loginValues = rawHeaderValues(req, 'tailscale-user-login');
          if (loginValues.length !== 1 || typeof loginValues[0] !== 'string' || !LOGIN_ENTRY_RE.test(loginValues[0])) {
            return json(403, { error: 'Geçerli Tailscale kullanıcı kimliği gerekli.' });
          }
          const normalizedLogin = loginValues[0].toLowerCase();
          if (!deployConfig.ownerAllowedLogins.has(normalizedLogin)) {
            return json(403, { error: 'Bu Tailscale kullanıcısı yönetici kanalına yetkili değil.' });
          }
          clientKey = `tailscale:${normalizedLogin}`;
          source = 'tailscale-owner';
        } else {
          if (hasRawHeaderPrefix(req, 'tailscale-')) {
            return json(403, { error: 'Bu kanalda Tailscale başlıklarına izin verilmiyor.' });
          }
          const secretValues = rawHeaderValues(req, 'x-store-proxy-secret');
          if (secretValues.length !== 1 || !constantTimeTokenMatch(secretValues[0], deployConfig.storeProxySecretDigest)) {
            return json(403, { error: 'Geçersiz mağaza vekil doğrulaması.' });
          }
          const ipValues = rawHeaderValues(req, 'x-real-ip');
          if (ipValues.length !== 1) {
            return json(403, { error: 'Tekil istemci IP başlığı gerekli.' });
          }
          const clientIp = normalizeClientIp(ipValues[0]);
          const ipFamily = clientIp ? isIP(clientIp) : 0;
          if (!clientIp || (ipFamily !== 4 && ipFamily !== 6) || !deployConfig.storeAllowedBlockList.check(clientIp, ipFamily === 4 ? 'ipv4' : 'ipv6')) {
            return json(403, { error: 'Bu istemci IP adresi mağaza kasa kanalına yetkili değil.' });
          }
          clientKey = `ip:${clientIp}`;
          source = 'store-checkout';
        }
      }
      const identityContext = { clientKey, source };
      const url = new URL(req.url, base);
      if (url.origin !== base) return json(403, { error: 'Geçersiz istek adresi.' });
      operation = operations.get(url.pathname) || 'request';
      const requestedWorkspace = url.searchParams.get('workspace') || 'demo';
      if (['demo', 'dukkan'].includes(requestedWorkspace)) workspace = requestedWorkspace;
      if (channel === 'store-checkout' && CHECKOUT_BLOCKED_STATIC.has(url.pathname)) {
        return json(403, { error: 'Bu sayfa veya varlık mağaza kasa kanalında kullanılamaz.' });
      }
      if (req.method === 'GET' && staticFiles.has(url.pathname)) {
        const [file, type] = staticFiles.get(url.pathname);
        const content = readFileSync(path.join(directory, 'public', file));
        res.writeHead(200, { ...headers, 'Content-Type': type }); return res.end(content);
      }
      if (!url.pathname.startsWith('/api/')) return json(404, { error: 'Sayfa bulunamadı.' });
      if (channel === 'store-checkout' && (CHECKOUT_BLOCKED_API.has(url.pathname) || url.pathname === '/api/security' || url.pathname.startsWith('/api/security/') || !CHECKOUT_ALLOWED_API.has(url.pathname))) {
        return json(403, { error: 'Bu işlem mağaza kasa kanalında kullanılamaz.' });
      }
      const authHeaderValues = rawHeaderValues(req, 'authorization');
      let token = authHeaderValues.length === 1 ? authHeaderValues[0]?.match(/^Bearer ([-_A-Za-z0-9]+)$/)?.[1] : undefined;
      if (req.method === 'GET' && (operation === 'backup' || operation === 'archive') && url.searchParams.has('ticket')) {
        token = downloads.consume(url.searchParams.get('ticket'), operation, requestedWorkspace);
      }
      if (url.pathname === '/api/auth/users' && req.method === 'GET') {
        if (channel === 'store-checkout') {
          if (token && SESSION_TOKEN_RE.test(token) && (identities || existsSync(path.join(dataDirectory, 'identity.sqlite')))) {
            const currentActor = ensureIdentities().session(token);
            if (currentActor && !isRoleAllowedOnChannel(channel, currentActor.role)) {
              return json(403, { error: 'Bu oturum bu kanalda kullanılamaz.' });
            }
          }
          return json(200, { setup: false, users: [] });
        }
        const idStore = ensureIdentities();
        const currentActor = idStore.session(token);
        if (currentActor && !isRoleAllowedOnChannel(channel, currentActor.role)) {
          return json(403, { error: 'Bu oturum bu kanalda kullanılamaz.' });
        }
        const canList = Boolean(currentActor && currentActor.role === 'owner' && !currentActor.mustChangePin);
        return json(200, { setup: idStore.needsSetup(), users: canList ? idStore.listUsers() : [] });
      }
      const idStore = ensureIdentities();
      const authAction = url.pathname.slice('/api/auth/'.length);
      if (url.pathname.startsWith('/api/auth/')) {
        if (authAction === 'session' && req.method === 'GET') {
          const actor = requireSession(idStore, token);
          if (!isRoleAllowedOnChannel(channel, actor.role)) fail('Bu oturum bu kanalda kullanılamaz.', { status: 403 });
          return json(200, actor);
        }
        if (req.method !== 'POST' || !['setup','login','logout','employees','disable','change-pin','reset-pin','rename'].includes(authAction)) {
          return json(404, { error: 'İşlem bulunamadı.' });
        }
        if (['employees','disable','reset-pin','rename','logout','change-pin'].includes(authAction)) {
          const actor = requireSession(idStore, token);
          if (!isRoleAllowedOnChannel(channel, actor.role)) fail('Bu oturum bu kanalda kullanılamaz.', { status: 403 });
          if (['employees','disable','reset-pin','rename'].includes(authAction) && (actor.role !== 'owner' || actor.mustChangePin)) deny();
        }
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return json(415, { error: 'JSON içeriği gerekli.' });
        const data = await readJson(8192);
        if (!data) return;
        if (authAction === 'logout') { idStore.logout(token, identityContext); return json(200, { ok: true }); }
        if (authAction === 'change-pin') return json(200, { actor: await idStore.changePin(token, data, identityContext) });
        if (authAction === 'reset-pin') return json(200, await idStore.resetEmployeePin(token, data, identityContext));
        if (authAction === 'rename') return json(200, { user: idStore.renameUser(token, data, identityContext) });
        if (authAction === 'employees') return json(201, await idStore.createEmployee(token, data, identityContext));
        if (authAction === 'disable') { idStore.disableUser(token, data.id, identityContext); return json(200, { ok: true }); }
        const pin = data.pin ?? data.password;
        let session;
        if (authAction === 'setup') {
          const owner = await idStore.initializeOwner(data, identityContext);
          session = await idStore.login(owner.id, pin, identityContext);
        } else if (typeof data.id === 'string' && data.id.trim()) {
          session = await idStore.login(data.id, pin, identityContext);
        } else {
          session = await idStore.loginByName(data.name, pin, identityContext);
        }
        if (!session) return json(401, { error: 'Giriş başarısız. Kullanıcı adı ve 6 haneli PIN kodunu kontrol edip yeniden deneyin.' });
        if (!isRoleAllowedOnChannel(channel, session.actor.role)) {
          idStore.logout(session.token, identityContext);
          return json(403, { error: 'Bu kullanıcı hesabı bu kanal üzerinden oturum açamaz.' });
        }
        return json(authAction === 'setup' ? 201 : 200, session);
      }
      let actor = requireSession(idStore, token);
      if (!isRoleAllowedOnChannel(channel, actor.role)) fail('Bu oturum bu kanalda kullanılamaz.', { status: 403 });
      if (actor.mustChangePin) return json(403, { error: 'Devam etmek için geçici PIN kodunuzu değiştirmeniz gerekiyor.', code: 'PIN_CHANGE_REQUIRED' });
      const revokeForRestore = () => {
        const current = requireSession(idStore, token);
        if (!isRoleAllowedOnChannel(channel, current.role)) fail('Bu oturum bu kanalda kullanılamaz.', { status: 403 });
        if (current.role !== 'owner') deny();
        if (current.mustChangePin) fail('Devam etmek için geçici PIN kodunuzu değiştirmeniz gerekiyor.', { status: 403, code: 'PIN_CHANGE_REQUIRED' });
        // Invalidate before financial COMMIT: a process crash must not preserve a stale writer.
        idStore.invalidateSessions(identityContext);
      };
      const worker = actor.role === 'employee';
      if (actor.role !== 'owner' && !worker) deny();
      if (worker && !(req.method === 'POST' && (operation === 'command' || url.pathname === '/api/pending-approvals')) &&
          !(req.method === 'GET' && ['/api/checkout','/api/customers','/api/pending-approvals'].includes(url.pathname))) deny();
      if (url.pathname === '/api/security/audit' || url.pathname.startsWith('/api/security/')) {
        if (url.pathname !== '/api/security/audit') return json(404, { error: 'İşlem bulunamadı.' });
        if (req.method !== 'GET') return json(405, { error: 'Denetim günlüğü yalnız GET ile okunabilir.' }, { Allow: 'GET' });
        if (actor.role !== 'owner') deny();
        const allowedParams = new Set(['limit', 'offset', 'eventType']);
        for (const key of url.searchParams.keys()) {
          if (!allowedParams.has(key) || url.searchParams.getAll(key).length !== 1) {
            throw new IdentityError('Geçersiz denetim sorgu parametresi.', 400);
          }
        }
        const limitParam = url.searchParams.get('limit');
        const offsetParam = url.searchParams.get('offset');
        const eventTypeParam = url.searchParams.get('eventType');
        let limit = 100;
        if (limitParam !== null) {
          if (!/^\d+$/.test(limitParam)) throw new IdentityError('Geçersiz denetim sınırı.', 400);
          limit = Number(limitParam);
          if (!Number.isSafeInteger(limit) || limit < 1) throw new IdentityError('Geçersiz denetim sınırı.', 400);
          limit = Math.min(500, limit);
        }
        let offset = 0;
        if (offsetParam !== null) {
          if (!/^\d+$/.test(offsetParam)) throw new IdentityError('Geçersiz denetim başlangıcı.', 400);
          offset = Number(offsetParam);
          if (!Number.isSafeInteger(offset) || offset < 0) throw new IdentityError('Geçersiz denetim başlangıcı.', 400);
        }
        let eventType = null;
        if (eventTypeParam !== null) {
          const trimmed = eventTypeParam.trim();
          if (!trimmed || !/^[a-z0-9_:-]{1,64}$/i.test(trimmed)) {
            throw new IdentityError('Geçersiz olay türü filtresi.', 400);
          }
          eventType = trimmed;
        }
        const auditResult = idStore.listAuthAudit({ limit, offset, eventType });
        return json(200, { entries: auditResult.entries, total: auditResult.total, limit, offset });
      }
      if (req.method === 'GET' && url.pathname === '/api/pending-approvals') {
        const repository = repo(requestedWorkspace);
        if (worker) {
          const userNamesById = new Map([[actor.id, actor.name]]);
          const items = repository.listPending({ status: 'all', submittedById: actor.id, limit: 30, userNamesById });
          return json(200, { items });
        }
        const userNamesById = new Map(idStore.listUsers().map(u => [u.id, u.name]));
        const status = url.searchParams.get('status') || 'pending';
        const submittedById = url.searchParams.get('employeeId') || '';
        const type = url.searchParams.get('type') || 'all';
        const startDate = url.searchParams.get('startDate') || '';
        const endDate = url.searchParams.get('endDate') || '';
        const summaryOnly = url.searchParams.get('summary') === '1';
        const pendingCount = repository.pendingCount();
        if (summaryOnly) return json(200, { pendingCount });
        const items = repository.listPending({ status, submittedById, type, startDate, endDate, limit: 200, userNamesById, includeComparison: true });
        const analytics = repository.employeeAnalytics({ submittedById, startDate, endDate, userNamesById });
        const knownEmployees = new Map();
        for (const u of idStore.listUsers()) if (u.id !== actor.id) knownEmployees.set(u.id, u.name);
        for (const emp of analytics.byEmployee) if (!knownEmployees.has(emp.id)) knownEmployees.set(emp.id, emp.name);
        const employees = [...knownEmployees.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'tr'));
        return json(200, { pendingCount, items, analytics, employees });
      }
      if (req.method === 'POST' && ['/api/pending-approvals', '/api/pending-approvals/approve', '/api/pending-approvals/reject'].includes(url.pathname)) {
        if (!req.headers['content-type']?.startsWith('application/json')) return json(415, { error: 'JSON içeriği gerekli.' });
        const data = await readJson(2 * 1024 * 1024);
        if (!data) return;
        actor = requireSession(idStore, token);
        if (!isRoleAllowedOnChannel(channel, actor.role)) fail('Bu oturum bu kanalda kullanılamaz.', { status: 403 });
        if (actor.mustChangePin) return json(403, { error: 'Devam etmek için geçici PIN kodunuzu değiştirmeniz gerekiyor.', code: 'PIN_CHANGE_REQUIRED' });
        const repository = repo(requestedWorkspace);
        if (url.pathname === '/api/pending-approvals') {
          if (data.command?.type === 'dailyCount') {
            const submitted = repository.submitPending(data, { actor });
            return json(201, submitted);
          }
          requireWorkerTrade(data.command);
          if (data.command?.type === 'account') fail('Yeni müşteri kartı doğrudan kaydedilir.');
          requireWorkerAccounts(data.command, repository.state({ compact: true }));
          const submitted = repository.submitPending(data, { actor });
          return json(201, submitted);
        }
        if (actor.role !== 'owner') deny();
        if (url.pathname === '/api/pending-approvals/approve') {
          const compact = url.searchParams.get('view') === 'compact';
          const result = repository.approvePending({ id: data.id, commandOverride: data.command || null, revision: data.revision, actor }, { compact });
          result.state.pendingApprovalCount = repository.pendingCount();
          return json(200, result);
        }
        return json(200, repository.rejectPending({ id: data.id, reason: data.reason, actor }));
      }
      if (req.method === 'POST' && url.pathname === '/api/download-ticket') {
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return json(415, { error: 'JSON içeriği gerekli.' });
        const data = await readJson(1024);
        if (!data) return;
        actor = requireSession(idStore, token);
        if (!isRoleAllowedOnChannel(channel, actor.role)) fail('Bu oturum bu kanalda kullanılamaz.', { status: 403 });
        if (actor.mustChangePin) return json(403, { error: 'Devam etmek için geçici PIN kodunuzu değiştirmeniz gerekiyor.', code: 'PIN_CHANGE_REQUIRED' });
        if (actor.role !== 'owner') deny();
        return json(200, { url: downloads.issue(token, data.operation, requestedWorkspace) });
      }
      // Defer opening financial files until write authorization is decided.
      const repository = operation === 'command' ? null : repo(requestedWorkspace);
      if (req.method === 'GET' && url.pathname === '/api/item-photo') return json(200, repository.itemPhoto(url.searchParams.get('code')));
      if (req.method === 'GET' && url.pathname === '/api/checkout') return json(200, checkoutState(repository.state({ compact: true }), { hidePrivatePools: worker }));
      if (req.method === 'GET' && url.pathname === '/api/customers') {
        const state = repository.state({ compact:true });
        if (url.searchParams.has('id')) return json(200, customerDetail(state, url.searchParams.get('id')));
        const limitParam = url.searchParams.get('limit');
        if (limitParam !== null && (!/^\d+$/.test(limitParam) || Number(limitParam) < 1)) fail('Geçerli sayfa boyutu seçin.');
        const limit = limitParam === null ? 20 : Math.min(50, Number(limitParam));
        const meta = url.searchParams.get('meta') === '1';
        return json(200, customerChoices(state, url.searchParams.get('q') || '', { limit, meta }));
      }
      const compact = url.searchParams.get('view') === 'compact';
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const st = repository.state({ compact });
        if (compact) st.pendingApprovalCount = repository.pendingCount();
        return json(200, st);
      }
      if (req.method === 'GET' && url.pathname === '/api/suppliers') {
        const limit = url.searchParams.get('limit');
        if (limit !== null && !/^\d+$/.test(limit)) fail('Geçerli sayfa boyutu seçin.');
        const documents=url.searchParams.get('documents');
        if(documents!==null&&documents!=='omit')fail('Belge görünümü geçersiz.');
        return json(200, repository.supplierDetail({ supplierId:url.searchParams.get('supplierId') || '', editOriginalId:url.searchParams.get('editOriginalId') || undefined, startDate:url.searchParams.get('startDate') || '', endDate:url.searchParams.get('endDate') || '', limit:limit === null ? 50 : Number(limit), cursor:url.searchParams.get('cursor') || undefined, includeDocuments:documents!=='omit' }));
      }
      if (req.method === 'GET' && url.pathname === '/api/journal') {
        const limit = url.searchParams.get('limit');
        if (limit !== null && !/^\d+$/.test(limit)) fail('Geçerli defter sayfa boyutu seçin.');
        return json(200, repository.journalPage({ scope: url.searchParams.get('scope') || 'today', q: url.searchParams.get('q') || '', type: url.searchParams.get('type') || 'all', limit: limit === null ? 50 : Number(limit), cursor: url.searchParams.get('cursor') || undefined, startDate: url.searchParams.get('startDate') || '', endDate: url.searchParams.get('endDate') || '', accountId: url.searchParams.get('accountId') || '', unit: url.searchParams.get('unit') || '', status: url.searchParams.get('status') || 'all', scrapForSale:url.searchParams.get('scrapForSale') || '', scrapForAdvance:url.searchParams.get('scrapForAdvance') || '' }));
      }
      if (req.method === 'GET' && url.pathname === '/api/account-statement') return json(200, repository.accountStatement({ accountId: url.searchParams.get('accountId') || '', startDate: url.searchParams.get('startDate') || '', endDate: url.searchParams.get('endDate') || '' }));
      if (req.method === 'GET' && url.pathname === '/api/recovery') return json(200, repository.recoveryInfo());
      if (req.method === 'GET' && url.pathname === '/api/archive') {
        const temporaryRoot = path.join(dataDirectory, '.archive-temp'); mkdirSync(temporaryRoot, { recursive: true });
        const temporaryDirectory = mkdtempSync(path.join(temporaryRoot, 'ledger-export-'));
        try {
          const filename = path.join(temporaryDirectory, 'ledger.ndjson');
          const result = repository.exportArchive(filename);
          res.writeHead(200, { ...headers, 'Content-Type': 'application/x-ndjson', 'Content-Length': result.bytes, 'Content-Disposition': `attachment; filename="kuyumcu-${repository.workspace}-${new Date().toISOString().slice(0, 10)}.ndjson"` });
          await pipeline(createReadStream(filename), res);
        } finally {
          if (path.dirname(path.resolve(temporaryDirectory)) !== path.resolve(temporaryRoot)) throw new Error('Invalid temporary archive directory.');
          rmSync(temporaryDirectory, { recursive: true, force: true });
        }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/archive/restore') {
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/x-ndjson') return json(415, { error: 'NDJSON arşiv içeriği gerekli.' });
        const revision = url.searchParams.get('revision');
        if (!revision || !/^\d+$/.test(revision)) fail('Geçerli ekran sürümü gerekli.');
        const receipt = await repository.restoreArchive(req, { beforeCommit: revokeForRestore, revision: Number(revision), confirmation: url.searchParams.get('confirmation'), temporaryDirectory: path.join(dataDirectory, '.archive-temp') });
        return json(200, { ...receipt, reauthenticate:true });
      }
      if (req.method === 'GET' && url.pathname === '/api/summary') {
        const paginated = url.searchParams.get('paginated') === '1' || url.searchParams.has('page') || url.searchParams.has('pageSize');
        if (!paginated) return json(200, repository.workdaySummary(url.searchParams.get('date') || undefined));
        const pageParam = url.searchParams.get('page');
        const pageSizeParam = url.searchParams.get('pageSize');
        if (pageParam !== null && (!/^\d+$/.test(pageParam) || Number(pageParam) < 1)) fail('Geçerli sayfa numarası seçin.');
        if (pageSizeParam !== null && (!/^\d+$/.test(pageSizeParam) || Number(pageSizeParam) < 1)) fail('Geçerli sayfa boyutu seçin.');
        return json(200, repository.workdaySummary(url.searchParams.get('date') || undefined, {
          paginated: true,
          page: pageParam ? Number(pageParam) : 1,
          pageSize: pageSizeParam ? Math.min(200, Number(pageSizeParam)) : 50,
          kind: url.searchParams.get('kind') || 'all',
          unit: url.searchParams.get('unit') || '',
          q: url.searchParams.get('q') || '',
          active: url.searchParams.get('active') === '1' || url.searchParams.get('active') === 'true'
        }));
      }
      if (req.method === 'GET' && url.pathname === '/api/backup') return json(200, repository.backup(), { 'Content-Disposition': `attachment; filename="kuyumcu-${url.searchParams.get('workspace') || 'demo'}-${new Date().toISOString().slice(0, 10)}.json"` });
      if (req.method !== 'POST' || !['/api/command', '/api/restore'].includes(url.pathname)) return json(404, { error: 'İşlem bulunamadı.' });
      if (!req.headers['content-type']?.startsWith('application/json')) return json(415, { error: 'JSON içeriği gerekli.' });
      // Restore includes a small JSON envelope around a supported backup file.
      const bodyLimit = url.pathname === '/api/restore' ? BACKUP_MAX_BYTES + 64 * 1024 : 8 * 1024 * 1024;
      const data = await readJson(bodyLimit);
      if (!data) return;
      actor = requireSession(idStore, token);
      if (!isRoleAllowedOnChannel(channel, actor.role)) fail('Bu oturum bu kanalda kullanılamaz.', { status: 403 });
      if (actor.mustChangePin) return json(403, { error: 'Devam etmek için geçici PIN kodunuzu değiştirmeniz gerekiyor.', code: 'PIN_CHANGE_REQUIRED' });
      if (url.pathname === '/api/command') {
        if (worker) {
          if (!isWorkerCustomerCreation(data.command)) {
            return json(403, { error: 'Çalışan satış ve alış işlemleri doğrudan deftere işlenemez; Yönetici Onay Kuyruğuna gönderilmelidir.', code: 'APPROVAL_REQUIRED' });
          }
          requireWorkerTrade(data.command);
        }
        const repository = repo(requestedWorkspace);
        if (!worker && data.command?.type === 'close' && repository.pendingCount() > 0) {
          return json(409, { error: 'Onay bekleyen çalışan işlemleri var. Gün kapanışından önce Onay Bekleyenler ekranından tüm bildirimleri onaylayın veya reddedin.', code: 'PENDING_APPROVALS_EXIST' });
        }
        if (worker) requireWorkerAccounts(data.command, repository.state({ compact: true }));
        const result = repository.execute(data, { compact: compact || worker, actor });
        if (!worker && compact && result?.state) result.state.pendingApprovalCount = repository.pendingCount();
        if (worker) {
          const account = data.command.type === 'account' ? result.state.accounts.find(a => a.id === 'cari-' + data.id) : null;
          return json(200, { id:data.id, revision:result.state.revision, duplicate:result.duplicate,
            ...(account && {account:{id:account.id,name:account.name,unit:account.unit}}) });
        }
        if (data.command.type === 'close') {
          // Closing is already durable. A backup failure must never pretend it rolled back.
          try {
            const backupDirectory = path.join(dataDirectory, 'backups', repository.workspace);
            mkdirSync(backupDirectory, { recursive: true });
            const filename = `kapanis-${data.command.date}-${randomUUID()}.json`;
            const backup = repository.backup();
            const fullPath = path.join(backupDirectory, filename);
            // The exact file uses the same compact representation checked by backup().
            writeFileSync(fullPath, JSON.stringify(backup), { encoding: 'utf8', flag: 'wx', flush: true });
            if (JSON.stringify(JSON.parse(readFileSync(fullPath, 'utf8'))) !== JSON.stringify(backup)) throw new Error('Yedek doğrulaması başarısız.');
            result.backupStatus = { saved: true, filename };
          } catch (backupError) {
            result.backupStatus = { saved: false, error: backupError instanceof DomainError && backupError.code === 'BACKUP_TOO_LARGE'
              ? 'Gün kapandı ve kayıtlar SQLite’a işlendi; geçmiş desteklenen 64 MiB JSON yedek sınırını aşıyor. Bu geçmiş için ayrı kurtarma desteği gerekir; kayıtları silmeyin veya kaynak veritabanını değiştirmeyin.'
              : 'Gün kapandı ve kayıtlar SQLite’a işlendi; dosya yedeği alınamadı. Yedek indir düğmesiyle hemen ayrı bir kopya alın.' };
          }
        }
        return json(200, result);
      }
      return json(200, { state: repository.restore(data, { compact, beforeCommit:revokeForRestore }), reauthenticate:true });
    } catch (e) {
      const expected = e instanceof DomainError || e instanceof IdentityError;
      if (!expected) {
        // Never log raw messages, stacks, file paths, request IDs or ledger data.
        try {
          const code = diagnosticCodes.has(e?.code) ? e.code : 'INTERNAL_ERROR';
          logger({ event: 'request_failed', operation, workspace, code });
        } catch { /* A failed diagnostic sink cannot alter the request outcome. */ }
      }
      if (res.destroyed || res.headersSent) { res.destroy(); return; }
      return json(expected ? e.status : 500, {
        error: expected ? e.message : 'İşlem tamamlanamadı. Son isteğin sonucunu Yenile ile kontrol edin; gerekirse aynı işlem anahtarıyla yeniden deneyin.',
        ...(expected && e.code === 'PIN_CHANGE_REQUIRED' ? { code: e.code } : {})
      });
    }
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 100;
  server.on('connect', (req, socket) => socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n'));
  server.on('upgrade', (req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
  server.on('close', () => { identities?.close(); for (const r of repositories.values()) r.close(); });
  return { server, repositories };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const port = Number(process.env.PORT || 4317);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error('PORT 1024–65535 arasında olmalı.');
    }
    const deploy = resolveServerDeployConfig(process.env);
    let dataDirectory;
    if (process.env.DATA_DIRECTORY !== undefined && process.env.DATA_DIRECTORY !== '') {
      const rawDir = process.env.DATA_DIRECTORY;
      if (/[\r\n\u0000-\u001f\u007f]/.test(rawDir) || !rawDir.trim()) {
        throw new Error('DATA_DIRECTORY geçerli bir klasör yolu olmalı.');
      }
      dataDirectory = rawDir.trim();
    }
    const { server } = createApp({ ...(dataDirectory ? { dataDirectory } : {}), deploy });
    server.on('error', e => {
      console.error(`Yerel sunucu başlatılamadı (${e?.code || 'ERR'}).`);
      process.exitCode = 1;
    });
    server.listen(port, '127.0.0.1', () => {
      console.log(`Kuyumcu günlük defter (${deploy.mode}): http://127.0.0.1:${port}\nÖrnek ve dükkân verileri ayrı SQLite dosyalarındadır. Kapatmak için Ctrl+C.`);
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
  } catch (error) {
    console.error(`Sunucu yapılandırması geçersiz: ${error?.message || 'Başlatılamadı.'}`);
    process.exitCode = 1;
  }
}
