import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

const CONTROL_OR_INVISIBLE_RE = /[\s\r\n\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
const TEAM_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TEAM_HOST_RE = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.cloudflareaccess\.com$/;
const DNS_HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const EMAIL_LOCAL_RE = /^[a-z0-9.!#$%&'+/=?^_`{|}~-]{1,64}$/i;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const FORBIDDEN_JWT_HEADER_PARAMS = ['jwk', 'jku', 'x5u', 'x5c', 'crit'];
const MAX_JWT_BYTES = 16 * 1024;
const MAX_JWKS_BYTES = 256 * 1024;
const MAX_JWKS_KEYS = 64;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export class CloudflareAccessError extends Error {
  constructor(message, status = 403) {
    super(message);
    this.name = 'CloudflareAccessError';
    this.status = status;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeCfTeamDomain(rawValue, label = 'OWNER_CF_TEAM_DOMAIN') {
  const invalidError = () => new Error(`${label} geçerli bir Cloudflare Access takım adı veya *.cloudflareaccess.com adresi olmalı.`);
  if (typeof rawValue !== 'string' || !rawValue || rawValue !== rawValue.trim() || CONTROL_OR_INVISIBLE_RE.test(rawValue) || /[*\\?#@%_\s]/.test(rawValue)) {
    throw invalidError();
  }
  let teamSlug = null;
  if (rawValue.includes('://') || rawValue.includes('/') || rawValue.includes(':')) {
    let parsed;
    try {
      parsed = new URL(rawValue);
    } catch {
      throw invalidError();
    }
    if (
      parsed.protocol !== 'https:' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.port !== '' ||
      parsed.pathname !== '/' ||
      parsed.search !== '' ||
      parsed.hash !== '' ||
      rawValue.toLowerCase() !== parsed.origin
    ) {
      throw invalidError();
    }
    const match = parsed.hostname.match(TEAM_HOST_RE);
    if (!match) throw invalidError();
    teamSlug = match[1];
  } else if (rawValue.includes('.')) {
    const match = rawValue.toLowerCase().match(TEAM_HOST_RE);
    if (!match) throw invalidError();
    teamSlug = match[1];
  } else {
    const lower = rawValue.toLowerCase();
    if (!TEAM_SLUG_RE.test(lower)) throw invalidError();
    teamSlug = lower;
  }
  const teamHost = `${teamSlug}.cloudflareaccess.com`;
  const issuer = `https://${teamHost}`;
  return Object.freeze({
    teamSlug,
    teamHost,
    issuer,
    certsUrl: `${issuer}/cdn-cgi/access/certs`
  });
}

export function validateCfAud(rawAud, label = 'OWNER_CF_AUD') {
  if (typeof rawAud !== 'string' || rawAud.length < 8 || rawAud.length > 512 || CONTROL_OR_INVISIBLE_RE.test(rawAud)) {
    throw new Error(`${label} geçerli ve en az 8 karakterli bir Cloudflare Access AUD etiketi olmalı.`);
  }
  return rawAud;
}

export function normalizeCfEmail(rawEmail) {
  if (typeof rawEmail !== 'string' || !rawEmail || rawEmail.length > 254 || CONTROL_OR_INVISIBLE_RE.test(rawEmail)) {
    return null;
  }
  const normalized = rawEmail.toLowerCase();
  const parts = normalized.split('@');
  if (parts.length !== 2) return null;
  const [localPart, domainPart] = parts;
  if (
    !EMAIL_LOCAL_RE.test(localPart) ||
    !domainPart ||
    domainPart.length > 253 ||
    !domainPart.includes('.') ||
    !DNS_HOST_RE.test(domainPart) ||
    /\.\d+$/.test(domainPart)
  ) {
    return null;
  }
  return normalized;
}

function parseJwksKeys(payload) {
  if (!isPlainObject(payload) || !Array.isArray(payload.keys) || payload.keys.length > MAX_JWKS_KEYS) {
    throw new CloudflareAccessError('Cloudflare Access doğrulama anahtarları geçersiz.', 503);
  }
  const nextMap = new Map();
  for (const jwk of payload.keys) {
    if (!isPlainObject(jwk)) continue;
    if (typeof jwk.kid !== 'string' || !jwk.kid || jwk.kid.length > 256 || CONTROL_OR_INVISIBLE_RE.test(jwk.kid)) continue;
    if (jwk.kty !== 'RSA') continue;
    if (jwk.use !== undefined && jwk.use !== 'sig') continue;
    if (jwk.alg !== undefined && jwk.alg !== 'RS256') continue;
    if (typeof jwk.n !== 'string' || !jwk.n || typeof jwk.e !== 'string' || !jwk.e) continue;
    let keyObj;
    try {
      keyObj = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
    } catch {
      continue;
    }
    if (keyObj.type !== 'public' || keyObj.asymmetricKeyType !== 'rsa' || (keyObj.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
      continue;
    }
    if (!nextMap.has(jwk.kid)) {
      nextMap.set(jwk.kid, keyObj);
    }
  }
  if (nextMap.size === 0) {
    throw new CloudflareAccessError('Cloudflare Access doğrulama anahtarları geçersiz.', 503);
  }
  return nextMap;
}

async function defaultJwksProvider({ certsUrl, signal }) {
  let response;
  try {
    response = await fetch(certsUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal
    });
  } catch {
    throw new CloudflareAccessError('Cloudflare Access doğrulama anahtarları alınamadı.', 503);
  }
  if (!response?.ok || response.status !== 200) {
    try { await response?.body?.cancel?.(); } catch {}
    throw new CloudflareAccessError('Cloudflare Access doğrulama anahtarları alınamadı.', 503);
  }
  const contentLengthHeader = response.headers?.get?.('content-length');
  if (contentLengthHeader !== null && contentLengthHeader !== undefined && contentLengthHeader !== '') {
    const declaredLength = Number(contentLengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_JWKS_BYTES) {
      try { await response.body?.cancel?.(); } catch {}
      throw new CloudflareAccessError('Cloudflare Access doğrulama anahtarları boyut sınırını aşıyor.', 503);
    }
  }
  let rawBytes;
  try {
    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        total += chunk.byteLength;
        if (total > MAX_JWKS_BYTES) {
          try { await reader.cancel(); } catch {}
          throw new CloudflareAccessError('Cloudflare Access doğrulama anahtarları boyut sınırını aşıyor.', 503);
        }
        chunks.push(chunk);
      }
      rawBytes = Buffer.concat(chunks, total);
    } else {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > MAX_JWKS_BYTES) {
        throw new CloudflareAccessError('Cloudflare Access doğrulama anahtarları boyut sınırını aşıyor.', 503);
      }
      rawBytes = buffer;
    }
    return JSON.parse(utf8Decoder.decode(rawBytes));
  } catch (error) {
    if (error instanceof CloudflareAccessError) throw error;
    throw new CloudflareAccessError('Cloudflare Access doğrulama anahtarları okunamadı.', 503);
  }
}

function decodeJwtSegmentJson(segment) {
  try {
    const decoded = utf8Decoder.decode(Buffer.from(segment, 'base64url'));
    const parsed = JSON.parse(decoded);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function getHeaderValues(req, lowerName) {
  if (Array.isArray(req?.rawHeaders)) {
    const values = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (String(req.rawHeaders[i]).toLowerCase() === lowerName) {
        values.push(req.rawHeaders[i + 1]);
      }
    }
    return values;
  }
  const values = [];
  if (req?.headers && typeof req.headers === 'object') {
    for (const [key, val] of Object.entries(req.headers)) {
      if (String(key).toLowerCase() !== lowerName) continue;
      if (Array.isArray(val)) {
        for (const item of val) values.push(item);
      } else if (val !== undefined) {
        values.push(val);
      }
    }
  }
  return values;
}

export function createCloudflareAccessVerifier({
  cfTeamDomain,
  cfAud,
  jwksProvider = null,
  cacheTtlMs = 300000,
  minRefreshIntervalMs = 10000,
  fetchTimeoutMs = 5000,
  clockSkewSeconds = 60,
  now = Date.now
} = {}) {
  const team = normalizeCfTeamDomain(cfTeamDomain);
  const expectedAud = validateCfAud(cfAud);
  if (jwksProvider !== null && jwksProvider !== undefined && typeof jwksProvider !== 'function') {
    throw new Error('Geçersiz Cloudflare Access JWKS sağlayıcısı.');
  }
  if (typeof cacheTtlMs !== 'number' || !Number.isFinite(cacheTtlMs) || cacheTtlMs <= 0) {
    throw new Error('Geçersiz Cloudflare Access JWKS önbellek süresi.');
  }
  if (typeof minRefreshIntervalMs !== 'number' || !Number.isFinite(minRefreshIntervalMs) || minRefreshIntervalMs < 0) {
    throw new Error('Geçersiz Cloudflare Access JWKS yenileme aralığı.');
  }
  if (typeof fetchTimeoutMs !== 'number' || !Number.isFinite(fetchTimeoutMs) || fetchTimeoutMs <= 0) {
    throw new Error('Geçersiz Cloudflare Access JWKS zaman aşımı.');
  }
  if (typeof clockSkewSeconds !== 'number' || !Number.isFinite(clockSkewSeconds) || clockSkewSeconds < 0 || clockSkewSeconds > 300) {
    throw new Error('Geçersiz Cloudflare Access saat sapması toleransı.');
  }
  if (typeof now !== 'function') {
    throw new Error('Geçersiz saat fonksiyonu.');
  }

  const provider = jwksProvider ?? defaultJwksProvider;
  let keyMap = new Map();
  let fetchedAt = -Infinity;
  let lastRefreshAttemptAt = -Infinity;
  let inFlight = null;

  async function loadKeys({ forceRefresh = false } = {}) {
    const currentMs = Number(now());
    if (!forceRefresh && keyMap.size > 0 && Number.isFinite(currentMs) && (currentMs - fetchedAt) < cacheTtlMs) {
      return keyMap;
    }
    if (inFlight) return inFlight;
    if (forceRefresh && Number.isFinite(currentMs)) {
      lastRefreshAttemptAt = currentMs;
    }
    inFlight = (async () => {
      const ac = new AbortController();
      let timer;
      let onAbort;
      const abortPromise = new Promise((_, reject) => {
        onAbort = () => reject(new CloudflareAccessError('Cloudflare Access doğrulama anahtarları zaman aşımına uğradı.', 503));
        ac.signal.addEventListener('abort', onAbort, { once: true });
      });
      timer = setTimeout(() => ac.abort(), fetchTimeoutMs);
      try {
        const payload = await Promise.race([
          Promise.resolve().then(() => provider({ certsUrl: team.certsUrl, signal: ac.signal })),
          abortPromise
        ]);
        const nextMap = parseJwksKeys(payload);
        const completedMs = Number(now());
        keyMap = nextMap;
        fetchedAt = Number.isFinite(completedMs) ? completedMs : currentMs;
        lastRefreshAttemptAt = fetchedAt;
        return keyMap;
      } catch (error) {
        if (error instanceof CloudflareAccessError) throw error;
        throw new CloudflareAccessError('Cloudflare Access doğrulama anahtarları alınamadı.', 503);
      } finally {
        clearTimeout(timer);
        if (onAbort) ac.signal.removeEventListener('abort', onAbort);
        inFlight = null;
      }
    })();
    return inFlight;
  }

  async function verifyJwt(token) {
    const invalidAuth = () => new CloudflareAccessError('Geçerli Cloudflare Access kimlik doğrulaması gerekli.', 403);
    if (typeof token !== 'string' || !token || token.length > MAX_JWT_BYTES || CONTROL_OR_INVISIBLE_RE.test(token)) {
      throw invalidAuth();
    }
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(part => !part || !BASE64URL_RE.test(part))) {
      throw invalidAuth();
    }
    const header = decodeJwtSegmentJson(parts[0]);
    const payload = decodeJwtSegmentJson(parts[1]);
    if (!header || !payload) throw invalidAuth();

    if (header.alg !== 'RS256') throw invalidAuth();
    if (header.typ !== undefined && (typeof header.typ !== 'string' || header.typ.toUpperCase() !== 'JWT')) {
      throw invalidAuth();
    }
    if (FORBIDDEN_JWT_HEADER_PARAMS.some(param => Object.hasOwn(header, param))) {
      throw invalidAuth();
    }
    if (typeof header.kid !== 'string' || !header.kid || header.kid.length > 256 || CONTROL_OR_INVISIBLE_RE.test(header.kid)) {
      throw invalidAuth();
    }

    let keys = await loadKeys({ forceRefresh: false });
    let publicKey = keys.get(header.kid);
    const currentMs = Number(now());
    if (!publicKey && Number.isFinite(currentMs) && (currentMs - lastRefreshAttemptAt) >= minRefreshIntervalMs) {
      keys = await loadKeys({ forceRefresh: true });
      publicKey = keys.get(header.kid);
    }
    if (!publicKey) throw invalidAuth();

    let signatureOk = false;
    try {
      const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii');
      const signature = Buffer.from(parts[2], 'base64url');
      if (signature.length > 0) {
        signatureOk = cryptoVerify('RSA-SHA256', signingInput, publicKey, signature) === true;
      }
    } catch {
      signatureOk = false;
    }
    if (!signatureOk) throw invalidAuth();

    if (typeof payload.iss !== 'string' || payload.iss !== team.issuer) throw invalidAuth();
    const audMatches =
      (typeof payload.aud === 'string' && payload.aud === expectedAud) ||
      (Array.isArray(payload.aud) &&
        payload.aud.length > 0 &&
        payload.aud.length <= 32 &&
        payload.aud.every(entry => typeof entry === 'string') &&
        payload.aud.includes(expectedAud));
    if (!audMatches) throw invalidAuth();

    const nowSec = Math.floor(Number(now()) / 1000);
    if (!Number.isFinite(nowSec)) throw invalidAuth();
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || nowSec >= payload.exp + clockSkewSeconds) {
      throw invalidAuth();
    }
    if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || !Number.isFinite(payload.nbf) || nowSec + clockSkewSeconds < payload.nbf)) {
      throw invalidAuth();
    }
    if (payload.iat !== undefined && (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat) || payload.iat > nowSec + clockSkewSeconds)) {
      throw invalidAuth();
    }

    const email = normalizeCfEmail(payload.email);
    if (!email) throw invalidAuth();

    if (payload.sub !== undefined && (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 256 || CONTROL_OR_INVISIBLE_RE.test(payload.sub))) {
      throw invalidAuth();
    }

    return {
      email,
      sub: payload.sub ?? null,
      iss: payload.iss
    };
  }

  async function verifyRequest(req) {
    const jwtValues = getHeaderValues(req, 'cf-access-jwt-assertion');
    if (jwtValues.length !== 1 || typeof jwtValues[0] !== 'string' || !jwtValues[0]) {
      throw new CloudflareAccessError('Geçerli Cloudflare Access kimlik doğrulaması gerekli.', 403);
    }
    const emailHeaderValues = getHeaderValues(req, 'cf-access-authenticated-user-email');
    if (emailHeaderValues.length > 1) {
      throw new CloudflareAccessError('Cloudflare Access kimliği ile e-posta başlığı uyuşmuyor.', 403);
    }
    const verified = await verifyJwt(jwtValues[0]);
    if (emailHeaderValues.length === 1) {
      const headerEmail = normalizeCfEmail(emailHeaderValues[0]);
      if (!headerEmail || headerEmail !== verified.email) {
        throw new CloudflareAccessError('Cloudflare Access kimliği ile e-posta başlığı uyuşmuyor.', 403);
      }
    }
    return verified;
  }

  return Object.freeze({
    verifyJwt,
    verifyRequest,
    team,
    certsUrl: team.certsUrl
  });
}
