import http from 'node:http';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReportRepository, ReportError } from './report-repository.mjs';
import { CloudflareAccessError, createCloudflareAccessVerifier, normalizeCfEmail } from './cloudflare-access.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const staticFiles = new Map([['/',['reports.html','text/html; charset=utf-8']],['/amount-codec.js',['amount-codec.js','text/javascript; charset=utf-8']],['/date-format.js',['date-format.js','text/javascript; charset=utf-8']],['/reports.js',['reports.js','text/javascript; charset=utf-8']],['/reports.css',['reports.css','text/css; charset=utf-8']],['/motion.css',['motion.css','text/css; charset=utf-8']],['/ui-prefs.js',['ui-prefs.js','text/javascript; charset=utf-8']]]);
const routes = new Set(['/api/reports/overview','/api/reports/summary','/api/reports/journal']);
const responseHeaders = { 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer', 'Cross-Origin-Resource-Policy':'same-origin', 'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" };
const TAILSCALE_ORIGIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.ts\.net$/;
const DNS_HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

function countRawHeader(req, lowerName) {
  const raw = req?.rawHeaders || [];
  let count = 0;
  for (let i = 0; i < raw.length; i += 2) {
    if (String(raw[i]).toLowerCase() === lowerName) count++;
  }
  return count;
}

function hasHeaderPrefix(req, prefixLower) {
  const raw = req?.rawHeaders || [];
  for (let i = 0; i < raw.length; i += 2) {
    if (String(raw[i]).toLowerCase().startsWith(prefixLower)) return true;
  }
  if (req?.headers && typeof req.headers === 'object') {
    for (const name of Object.keys(req.headers)) {
      if (String(name).toLowerCase().startsWith(prefixLower)) return true;
    }
  }
  return false;
}

export function validateReportConfig({
  enabled = false,
  authProvider = 'tailscale',
  origin,
  allowedLogins,
  dataDirectory = path.join(directory, 'data'),
  cfTeamDomain = undefined,
  cfAud = undefined,
  jwksProvider = null,
  cfCacheTtlMs = undefined,
  cfMinRefreshIntervalMs = undefined,
  cfFetchTimeoutMs = undefined,
  cfClockSkewSeconds = undefined,
  cfNow = undefined
} = {}) {
  if (enabled !== true) throw new ReportError('Rapor portalı varsayılan olarak kapalı.', 503);
  if (authProvider !== 'tailscale' && authProvider !== 'cloudflare-access') {
    throw new ReportError('Rapor kimlik sağlayıcısı yalnız "tailscale" veya "cloudflare-access" olabilir.');
  }
  let publicURL;
  try { publicURL = new URL(origin); } catch { throw new ReportError('Rapor için açık ve geçerli HTTPS adresi gerekli.'); }
  if (authProvider === 'tailscale') {
    if (publicURL.protocol !== 'https:' || publicURL.username || publicURL.password || origin !== publicURL.origin || !TAILSCALE_ORIGIN_RE.test(publicURL.hostname) || (publicURL.port && publicURL.port !== '443')) {
      throw new ReportError('Rapor için yalnız tam HTTPS tailnet adresi desteklenir.');
    }
    if (!Array.isArray(allowedLogins) || !allowedLogins.length || allowedLogins.length > 100 || allowedLogins.some(login => typeof login !== 'string' || !/^[^\s,*\r\n]{1,254}$/.test(login))) {
      throw new ReportError('Rapor kullanıcıları açık bir izin listesiyle belirtilmeli.');
    }
    if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory)) {
      throw new ReportError('Rapor veri klasörü tam bir yerel yol olmalı.');
    }
    return {
      authProvider: 'tailscale',
      origin: publicURL.origin,
      host: publicURL.host,
      allowedLogins: new Set(allowedLogins),
      dataDirectory
    };
  }

  if (
    publicURL.protocol !== 'https:' ||
    publicURL.username ||
    publicURL.password ||
    publicURL.port !== '' ||
    origin !== publicURL.origin ||
    !publicURL.hostname.includes('.') ||
    isIP(publicURL.hostname) !== 0 ||
    !DNS_HOST_RE.test(publicURL.hostname)
  ) {
    throw new ReportError('Rapor için yalnız geçerli tam HTTPS alan adı desteklenir.');
  }
  if (!Array.isArray(allowedLogins) || !allowedLogins.length || allowedLogins.length > 100) {
    throw new ReportError('Rapor kullanıcıları açık bir e-posta izin listesiyle belirtilmeli.');
  }
  const normalizedLogins = new Set();
  for (const login of allowedLogins) {
    const email = normalizeCfEmail(login);
    if (!email) {
      throw new ReportError('Rapor kullanıcıları açık bir e-posta izin listesiyle belirtilmeli.');
    }
    normalizedLogins.add(email);
  }
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory)) {
    throw new ReportError('Rapor veri klasörü tam bir yerel yol olmalı.');
  }
  let cfVerifier;
  try {
    const verifierOptions = { cfTeamDomain, cfAud };
    if (jwksProvider !== undefined) verifierOptions.jwksProvider = jwksProvider;
    if (cfCacheTtlMs !== undefined) verifierOptions.cacheTtlMs = cfCacheTtlMs;
    if (cfMinRefreshIntervalMs !== undefined) verifierOptions.minRefreshIntervalMs = cfMinRefreshIntervalMs;
    if (cfFetchTimeoutMs !== undefined) verifierOptions.fetchTimeoutMs = cfFetchTimeoutMs;
    if (cfClockSkewSeconds !== undefined) verifierOptions.clockSkewSeconds = cfClockSkewSeconds;
    if (cfNow !== undefined) verifierOptions.now = cfNow;
    cfVerifier = createCloudflareAccessVerifier(verifierOptions);
  } catch {
    throw new ReportError('Cloudflare Access rapor yapılandırması geçersiz.');
  }
  return {
    authProvider: 'cloudflare-access',
    origin: publicURL.origin,
    host: publicURL.host,
    allowedLogins: normalizedLogins,
    dataDirectory,
    cfTeamDomain: cfVerifier.team.issuer,
    cfVerifier
  };
}

async function authorizeCloudflareReportRequest(req, config) {
  const identity = await config.cfVerifier.verifyRequest(req);
  if (!config.allowedLogins.has(identity.email)) {
    throw new ReportError('Bu kullanıcı raporlara yetkili değil.', 403);
  }
  return identity;
}

export function authorizeReportRequest(req, config) {
  const address = req.socket?.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) throw new ReportError('Erişime izin verilmedi.', 403);
  const provider = config?.authProvider || 'tailscale';
  if (provider === 'cloudflare-access') {
    if (hasHeaderPrefix(req, 'tailscale-')) throw new ReportError('Erişime izin verilmedi.', 403);
    if (Array.isArray(req?.rawHeaders) && countRawHeader(req, 'host') !== 1) throw new ReportError('Erişime izin verilmedi.', 403);
    if (req.headers?.host !== config.host) throw new ReportError('Erişime izin verilmedi.', 403);
    if (Array.isArray(req?.rawHeaders) && countRawHeader(req, 'origin') > 1) throw new ReportError('Erişime izin verilmedi.', 403);
    if (req.headers && 'origin' in req.headers && req.headers.origin !== config.origin) throw new ReportError('Erişime izin verilmedi.', 403);
    return authorizeCloudflareReportRequest(req, config);
  }
  if (hasHeaderPrefix(req, 'cf-')) throw new ReportError('Erişime izin verilmedi.', 403);
  if (countRawHeader(req, 'tailscale-user-login') !== 1 || countRawHeader(req, 'host') !== 1 || req.headers.host !== config.host || ('origin' in req.headers && (countRawHeader(req, 'origin') > 1 || req.headers.origin !== config.origin)) || 'tailscale-funnel-request' in req.headers || countRawHeader(req, 'tailscale-funnel-request') > 0) throw new ReportError('Erişime izin verilmedi.', 403);
  const login = req.headers['tailscale-user-login'];
  if (!login) throw new ReportError('Özel ağ kimliği gerekli.', 401);
  if (typeof login !== 'string' || login.includes(',') || !config.allowedLogins.has(login)) throw new ReportError('Bu kullanıcı raporlara yetkili değil.', 403);
}

export function createReportApp(options = {}) {
  const config = validateReportConfig(options), repositories = new Map();
  const server = http.createServer(async (req, res) => {
    const json = (status, value, extra = {}) => {
      const body = JSON.stringify(value);
      if (res.destroyed || res.headersSent) return;
      res.writeHead(status, { ...responseHeaders, 'Content-Type': 'application/json; charset=utf-8', ...extra });
      res.end(body);
    };
    let workspace;
    try {
      if ((req.rawHeaders?.length || 0) > 80) {
        return json(431, { error: 'İstek başlık sayısı sınırı aşıldı.' }, { Connection: 'close' });
      }
      await authorizeReportRequest(req, config);
      if (req.method !== 'GET') return json(405, { error: 'Bu portal yalnız rapor okumak içindir.' }, { Allow: 'GET' });
      const url = new URL(req.url, config.origin);
      if (url.pathname === '/favicon.ico') {
        if (res.destroyed || res.headersSent) return;
        res.writeHead(204, responseHeaders);
        return res.end();
      }
      if (staticFiles.has(url.pathname)) {
        const [file, type] = staticFiles.get(url.pathname);
        const content = readFileSync(path.join(directory, 'public', file));
        if (res.destroyed || res.headersSent) return;
        res.writeHead(200, { ...responseHeaders, 'Content-Type': type });
        return res.end(content);
      }
      if (!routes.has(url.pathname)) return json(404, { error: 'Rapor bulunamadı.' });
      const permitted = url.pathname.endsWith('/journal') ? ['workspace', 'date', 'type', 'q', 'limit', 'cursor'] : url.pathname.endsWith('/summary') ? ['workspace', 'date'] : ['workspace'];
      if ([...url.searchParams.keys()].some(key => !permitted.includes(key) || url.searchParams.getAll(key).length !== 1)) throw new ReportError('Geçersiz rapor filtresi.');
      workspace = url.searchParams.get('workspace') || 'demo';
      if (!['demo', 'dukkan'].includes(workspace)) throw new ReportError('Geçerli bir çalışma alanı seçin.');
      if (!repositories.has(workspace)) repositories.set(workspace, new ReportRepository(path.join(config.dataDirectory, workspace + '.sqlite'), workspace));
      const repository = repositories.get(workspace);
      if (url.pathname.endsWith('/overview')) return json(200, repository.overview());
      if (url.pathname.endsWith('/summary')) return json(200, repository.summary(url.searchParams.get('date')));
      const params = Object.fromEntries(url.searchParams);
      delete params.workspace;
      return json(200, repository.journal(params));
    } catch (error) {
      const expected = error instanceof ReportError || error instanceof CloudflareAccessError;
      const status = expected ? error.status : 503;
      if (status === 503 && workspace && repositories.has(workspace)) {
        try { repositories.get(workspace).close(); } catch {}
        repositories.delete(workspace);
      }
      if (res.destroyed || res.headersSent) { res.destroy(); return; }
      return json(status, { error: expected ? error.message : 'Rapor verileri şu anda okunamıyor. Ana bilgisayardaki defteri kontrol edin.' });
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxHeadersCount = 100;
  server.on('connect', (req, socket) => socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n'));
  server.on('upgrade', (req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
  server.on('close', () => { for (const repository of repositories.values()) repository.close(); repositories.clear(); });
  return { server, repositories, listen: (port = 4318) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server.address()); }); }) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const port = Number(process.env.REPORT_PORT || 4318);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid report port');
    const rawProvider = process.env.REPORT_AUTH_PROVIDER;
    const authProvider = rawProvider === undefined || rawProvider === null || rawProvider === '' ? 'tailscale' : rawProvider;
    const app = createReportApp({
      enabled: process.env.REPORT_ENABLED === '1',
      authProvider,
      origin: process.env.REPORT_ORIGIN,
      allowedLogins: process.env.REPORT_ALLOWED_LOGINS?.split(',').map(value => value.trim()),
      dataDirectory: process.env.REPORT_DATA_DIRECTORY || path.join(directory, 'data'),
      cfTeamDomain: process.env.REPORT_CF_TEAM_DOMAIN,
      cfAud: process.env.REPORT_CF_AUD
    });
    await app.listen(port);
    console.log('Salt okunur rapor sunucusu yalnız yerel arayüzde hazır. Özel HTTPS erişimi ayrıca yapılandırılmalı.');
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.server.close());
  } catch {
    console.error('Rapor portalı başlatılmadı. Açık etkinleştirme, HTTPS adresi, izin listesi, veri klasörü ve port ayarlarını kontrol edin.');
    process.exitCode = 1;
  }
}
