import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync, createSign, createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CloudflareAccessError,
  createCloudflareAccessVerifier,
  normalizeCfEmail,
  normalizeCfTeamDomain,
  validateCfAud
} from '../cloudflare-access.mjs';
import { createApp, resolveServerDeployConfig, validateServerDeployConfig } from '../server.mjs';
import { authorizeReportRequest, createReportApp, validateReportConfig } from '../report-server.mjs';
import { createReportLauncher, readLauncherConfig, validateLauncherConfig } from '../report-launcher.mjs';
import { ReportRepository } from '../report-repository.mjs';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS } from '../domain.mjs';

const OWNER_HOST = 'yonetim.example.test';
const TAILSCALE_OWNER_HOST = 'owner.synthetic-tailnet.ts.net';
const CHECKOUT_HOST = 'kasa.example.test';
const REPORT_HOST = 'rapor.example.test';
const REPORT_ORIGIN = `https://${REPORT_HOST}`;
const TAILSCALE_REPORT_ORIGIN = 'https://defter.example-tailnet.ts.net';
const OWNER_LOGIN = 'owner@example.test';
const READER_LOGIN = 'reader@example.test';
const STORE_SECRET = 'synthetic-store-proxy-secret-32chars';
const HEALTHZ_SECRET = 'synthetic-healthz-token-32-chars-ok';
const TEST_TEAM = 'synthetic-team';
const TEST_ISSUER = `https://${TEST_TEAM}.cloudflareaccess.com`;
const TEST_AUD = 'synthetic-cf-aud-tag-0123456789abcdef0123456789abcdef';

// Ephemeral RSA keys generated at runtime (zero PEM literals in repository).
const PRIMARY_KEYS = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ROTATED_KEYS = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ROGUE_KEYS = generateKeyPairSync('rsa', { modulusLength: 2048 });
const WEAK_KEYS = generateKeyPairSync('rsa', { modulusLength: 1024 });

function toPublicJwk(publicKey, kid, overrides = {}) {
  const jwk = publicKey.export({ format: 'jwk' });
  return { ...jwk, kid, use: 'sig', alg: 'RS256', ...overrides };
}

function b64uJson(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

function signRs256Jwt(payload, privateKey = PRIMARY_KEYS.privateKey, headerOverrides = {}) {
  const header = { alg: 'RS256', typ: 'JWT', kid: 'kid-1', ...headerOverrides };
  const input = `${b64uJson(header)}.${b64uJson(payload)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(input, 'ascii');
  const sig = signer.sign(privateKey).toString('base64url');
  return `${input}.${sig}`;
}

function signRs384Jwt(payload, privateKey = PRIMARY_KEYS.privateKey, headerOverrides = {}) {
  const header = { alg: 'RS384', typ: 'JWT', kid: 'kid-1', ...headerOverrides };
  const input = `${b64uJson(header)}.${b64uJson(payload)}`;
  const signer = createSign('RSA-SHA384');
  signer.update(input, 'ascii');
  const sig = signer.sign(privateKey).toString('base64url');
  return `${input}.${sig}`;
}

function signHs256Jwt(payload, secretBytes = PRIMARY_KEYS.publicKey.export({ type: 'spki', format: 'der' }), headerOverrides = {}) {
  const header = { alg: 'HS256', typ: 'JWT', kid: 'kid-1', ...headerOverrides };
  const input = `${b64uJson(header)}.${b64uJson(payload)}`;
  const sig = createHmac('sha256', secretBytes).update(input, 'ascii').digest('base64url');
  return `${input}.${sig}`;
}

function signAlgNoneJwt(payload, signature = '', headerOverrides = {}) {
  const header = { alg: 'none', typ: 'JWT', kid: 'kid-1', ...headerOverrides };
  return `${b64uJson(header)}.${b64uJson(payload)}.${signature}`;
}

function buildDefaultClaims(nowSec, overrides = {}) {
  return {
    iss: TEST_ISSUER,
    aud: [TEST_AUD],
    sub: 'user-sub-1',
    email: OWNER_LOGIN,
    iat: nowSec - 10,
    nbf: nowSec - 10,
    exp: nowSec + 300,
    ...overrides
  };
}

function makeRawRequest(port, path, { method = 'GET', rawHeaders = [], body } = {}) {
  const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
  const headers = [...rawHeaders];
  if (payload !== undefined) {
    const hasContentType = headers.some((v, idx) => idx % 2 === 0 && v.toLowerCase() === 'content-type');
    if (!hasContentType) headers.push('Content-Type', 'application/json');
    headers.push('Content-Length', String(Buffer.byteLength(payload)));
  }
  return new Promise((resolveResponse, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method, agent: false, headers },
      res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch {}
          resolveResponse({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Request timed out')));
    req.end(payload);
  });
}

function sendRawTcpRequest(port, lines) {
  return new Promise((resolveResponse, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    const chunks = [];
    sock.on('data', chunk => chunks.push(chunk));
    sock.on('end', () => resolveResponse(Buffer.concat(chunks).toString('utf8')));
    sock.on('error', reject);
    sock.setTimeout(15000, () => sock.destroy(new Error('Raw TCP request timed out')));
  });
}

async function startServerFixture(t, deploy = undefined) {
  const root = resolve(tmpdir());
  const dataDirectory = mkdtempSync(join(root, 'p3-cf-access-'));
  const logs = [];
  const app = createApp({
    dataDirectory,
    logger: record => logs.push(record),
    ...(deploy === undefined ? {} : { deploy })
  });
  await new Promise(resolveListen => app.server.listen(0, '127.0.0.1', resolveListen));
  t.after(async () => {
    await new Promise(resolveClose => {
      app.server.close(resolveClose);
      app.server.closeAllConnections();
    });
    assert.equal(dirname(resolve(dataDirectory)), root);
    rmSync(dataDirectory, { recursive: true, force: true });
  });
  return { ...app, dataDirectory, port: app.server.address().port, logs };
}

function cfOwnerHeaders(extra = [], {
  host = OWNER_HOST,
  origin = `https://${OWNER_HOST}`,
  jwt,
  emailHeader,
  token,
  withTunnelHeaders = true
} = {}) {
  const raw = [];
  if (host !== null) raw.push('Host', host);
  if (origin !== null) raw.push('Origin', origin);
  if (withTunnelHeaders) {
    raw.push(
      'Cf-Connecting-IP', '203.0.113.10',
      'Cf-Ray', '8f00000000000001-IST',
      'Cf-IPCountry', 'TR',
      'Cf-Visitor', '{"scheme":"https"}',
      'X-Forwarded-For', '203.0.113.10',
      'X-Forwarded-Proto', 'https',
      'X-Forwarded-Host', OWNER_HOST
    );
  }
  if (jwt !== undefined && jwt !== null) raw.push('Cf-Access-Jwt-Assertion', jwt);
  if (emailHeader !== undefined && emailHeader !== null) raw.push('Cf-Access-Authenticated-User-Email', emailHeader);
  if (token) raw.push('Authorization', `Bearer ${token}`);
  return [...raw, ...extra];
}

function cfCheckoutHeaders(extra = [], {
  host = CHECKOUT_HOST,
  origin = `https://${CHECKOUT_HOST}`,
  secret = STORE_SECRET,
  ip = '198.51.100.42',
  ipHeaderName = 'CF-Connecting-IP',
  token,
  withTunnelHeaders = true
} = {}) {
  const raw = [];
  if (host !== null) raw.push('Host', host);
  if (origin !== null) raw.push('Origin', origin);
  if (secret !== null) raw.push('X-Store-Proxy-Secret', secret);
  if (ip !== null) raw.push(ipHeaderName, ip);
  if (withTunnelHeaders) {
    raw.push('Cf-Ray', '8f00000000000002-IST', 'X-Forwarded-For', '198.51.100.42');
  }
  if (token) raw.push('Authorization', `Bearer ${token}`);
  return [...raw, ...extra];
}

function seedReportWorkspace(t) {
  const root = resolve(tmpdir());
  const directory = mkdtempSync(join(root, 'p3-cf-reports-'));
  const filename = join(directory, 'demo.sqlite');
  const writer = new Repository(filename, 'demo');
  const cleanup = () => {
    try { writer.close(); } catch {}
    assert.equal(dirname(resolve(directory)), root);
    rmSync(directory, { recursive: true, force: true });
  };
  const run = (id, command) => writer.execute({ id, revision: writer.state().revision, command });
  const balances = Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, '0']));
  Object.assign(balances, { nakit: '1000', gramToplam: '10' });
  run('report-opening', { type: 'opening', date: '2026-10-27', balances });
  run('report-cari', { type: 'account', date: '2026-10-27', name: 'Cari Test', unit: 'HAS', opening: '-1.125' });
  run('report-movement', { type: 'movement', date: '2026-10-27', accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '1', note: 'Kasa giris', privateDebug: 'PRIVATE_COMMAND_MARKER' });
  writer.db.prepare('INSERT INTO restore_archive(created_at,body) VALUES(?,?)').run('test', 'PRIVATE_ARCHIVE_MARKER');
  return { directory, filename, writer, cleanup };
}

function defaultJwksProvider(keys = [toPublicJwk(PRIMARY_KEYS.publicKey, 'kid-1')]) {
  return async () => ({ keys });
}

function createCfCloudDeployConfig(overrides = {}) {
  return validateServerDeployConfig({
    mode: 'cloud-proxy',
    ownerAuthProvider: 'cloudflare-access',
    ownerCfTeamDomain: TEST_TEAM,
    ownerCfAud: TEST_AUD,
    ownerAllowedLogins: [OWNER_LOGIN],
    ownerAllowedHosts: [OWNER_HOST],
    checkoutAllowedHosts: [CHECKOUT_HOST],
    storeProxySecret: STORE_SECRET,
    storeIpHeader: 'cf-connecting-ip',
    storeAllowedIps: ['198.51.100.0/24', '2001:db8::/32', '203.0.113.50'],
    healthzToken: HEALTHZ_SECRET,
    jwksProvider: defaultJwksProvider(),
    ...overrides
  });
}

// ============================================================================
// Suite A: cloudflare-access.mjs Unit & Adversarial Verification
// ============================================================================

test('T-CA-1: team domain, AUD, and email normalizers fail closed without echoing inputs', () => {
  for (const input of [
    'synthetic-team',
    'SYNTHETIC-TEAM.cloudflareaccess.com',
    'https://synthetic-team.cloudflareaccess.com',
    'https://SYNTHETIC-TEAM.cloudflareaccess.com'
  ]) {
    const team = normalizeCfTeamDomain(input);
    assert.equal(team.teamSlug, 'synthetic-team');
    assert.equal(team.teamHost, 'synthetic-team.cloudflareaccess.com');
    assert.equal(team.issuer, 'https://synthetic-team.cloudflareaccess.com');
    assert.equal(team.certsUrl, 'https://synthetic-team.cloudflareaccess.com/cdn-cgi/access/certs');
    assert.equal(Object.isFrozen(team), true);
  }

  for (const badTeam of [
    '',
    ' ',
    ' synthetic-team ',
    'http://synthetic-team.cloudflareaccess.com',
    'https://synthetic-team.cloudflareaccess.com/cdn-cgi',
    'https://synthetic-team.cloudflareaccess.com?x=1',
    'https://synthetic-team.cloudflareaccess.com#h',
    'https://synthetic-team.cloudflareaccess.com:443',
    'https://user@synthetic-team.cloudflareaccess.com',
    'evil.example',
    '*.cloudflareaccess.com',
    'team%2e.cloudflareaccess.com',
    'team\u200b',
    null,
    123
  ]) {
    assert.throws(() => normalizeCfTeamDomain(badTeam), err => {
      if (typeof badTeam === 'string' && badTeam.trim().length > 2 && badTeam !== '*.cloudflareaccess.com') {
        assert.equal(err.message.includes(badTeam), false);
      }
      return true;
    });
  }

  assert.equal(validateCfAud(TEST_AUD), TEST_AUD);
  assert.equal(validateCfAud('12345678'), '12345678');
  for (const badAud of [
    '',
    'short',
    'a'.repeat(513),
    'aud with space',
    'aud\u0085secret',
    'aud\u202esecret',
    null,
    42
  ]) {
    assert.throws(() => validateCfAud(badAud), err => {
      if (typeof badAud === 'string' && badAud.length >= 4) {
        assert.equal(err.message.includes(badAud), false);
      }
      return true;
    });
  }

  assert.equal(normalizeCfEmail('Owner@Example.TEST'), 'owner@example.test');
  for (const badEmail of [
    '',
    'no-at',
    'a@b',
    'a@127.0.0.1',
    'a,b@example.test',
    'a*b@example.test',
    'a\u200b@example.test',
    'a b@example.test',
    null
  ]) {
    assert.equal(normalizeCfEmail(badEmail), null);
  }
});

test('T-CA-2: RS256 valid tokens, string/array aud, and exp/nbf/iat clock skew boundaries', async () => {
  let nowMs = 1_760_000_000_000;
  const nowSec = Math.floor(nowMs / 1000);
  const verifier = createCloudflareAccessVerifier({
    cfTeamDomain: TEST_TEAM,
    cfAud: TEST_AUD,
    clockSkewSeconds: 60,
    now: () => nowMs,
    jwksProvider: defaultJwksProvider()
  });

  // String aud + uppercase email normalized
  const jwtStringAud = signRs256Jwt(buildDefaultClaims(nowSec, {
    aud: TEST_AUD,
    email: 'OWNER@EXAMPLE.TEST'
  }));
  const res1 = await verifier.verifyJwt(jwtStringAud);
  assert.deepEqual(res1, { email: OWNER_LOGIN, sub: 'user-sub-1', iss: TEST_ISSUER });

  // Array aud
  const jwtArrayAud = signRs256Jwt(buildDefaultClaims(nowSec, {
    aud: ['other-aud-000', TEST_AUD]
  }));
  const res2 = await verifier.verifyJwt(jwtArrayAud);
  assert.equal(res2.email, OWNER_LOGIN);

  // exp boundary: nowSec - 59 allowed; nowSec - 60 & nowSec - 61 rejected
  await verifier.verifyJwt(signRs256Jwt(buildDefaultClaims(nowSec, { exp: nowSec - 59 })));
  for (const expiredAt of [nowSec - 60, nowSec - 61]) {
    await assert.rejects(
      verifier.verifyJwt(signRs256Jwt(buildDefaultClaims(nowSec, { exp: expiredAt }))),
      err => err instanceof CloudflareAccessError && err.status === 403
    );
  }

  // nbf boundary: nowSec + 59 allowed; nowSec + 61 rejected
  await verifier.verifyJwt(signRs256Jwt(buildDefaultClaims(nowSec, { nbf: nowSec + 59 })));
  await assert.rejects(
    verifier.verifyJwt(signRs256Jwt(buildDefaultClaims(nowSec, { nbf: nowSec + 61 }))),
    err => err instanceof CloudflareAccessError && err.status === 403
  );

  // iat boundary: nowSec + 60 allowed; nowSec + 61 rejected
  await verifier.verifyJwt(signRs256Jwt(buildDefaultClaims(nowSec, { iat: nowSec + 60 })));
  await assert.rejects(
    verifier.verifyJwt(signRs256Jwt(buildDefaultClaims(nowSec, { iat: nowSec + 61 }))),
    err => err instanceof CloudflareAccessError && err.status === 403
  );
});

test('T-CA-3: algorithm confusion, malformed JWTs, header injection, bad signatures and claims fail 403', async () => {
  const nowMs = 1_760_000_000_000;
  const nowSec = Math.floor(nowMs / 1000);
  const primaryJwk = toPublicJwk(PRIMARY_KEYS.publicKey, 'kid-1');
  const verifier = createCloudflareAccessVerifier({
    cfTeamDomain: TEST_TEAM,
    cfAud: TEST_AUD,
    now: () => nowMs,
    jwksProvider: defaultJwksProvider([primaryJwk])
  });
  const baseClaims = buildDefaultClaims(nowSec);

  const invalidTokens = [
    // Algorithm confusion
    signAlgNoneJwt(baseClaims, ''),
    signAlgNoneJwt(baseClaims, 'fakesig'),
    signHs256Jwt(baseClaims, PRIMARY_KEYS.publicKey.export({ type: 'spki', format: 'der' })),
    signHs256Jwt(baseClaims, Buffer.from(primaryJwk.n, 'base64url')),
    signRs384Jwt(baseClaims),
    signRs256Jwt(baseClaims, PRIMARY_KEYS.privateKey, { alg: undefined }),
    signRs256Jwt(baseClaims, PRIMARY_KEYS.privateKey, { typ: 'at+jwt' }),
    signRs256Jwt(baseClaims, PRIMARY_KEYS.privateKey, { kid: '' }),
    signRs256Jwt(baseClaims, PRIMARY_KEYS.privateKey, { kid: undefined }),
    // Forbidden header params (even if signed by rogue key matching embedded jwk)
    signRs256Jwt(baseClaims, ROGUE_KEYS.privateKey, { jwk: toPublicJwk(ROGUE_KEYS.publicKey, 'kid-1') }),
    signRs256Jwt(baseClaims, PRIMARY_KEYS.privateKey, { jku: 'https://evil.example/jwks' }),
    signRs256Jwt(baseClaims, PRIMARY_KEYS.privateKey, { x5u: 'https://evil.example/cert' }),
    signRs256Jwt(baseClaims, PRIMARY_KEYS.privateKey, { x5c: ['AAAA'] }),
    signRs256Jwt(baseClaims, PRIMARY_KEYS.privateKey, { crit: ['exp'] }),
    // Malformed strings
    '',
    'not-a-jwt',
    'a.b',
    'a.b.c.d',
    'a..c',
    '###.###.###',
    `${Buffer.from('not-json').toString('base64url')}.${b64uJson(baseClaims)}.sig`,
    `${b64uJson({ alg: 'RS256', kid: 'kid-1' })}.${b64uJson(baseClaims)}.sig\u200b`,
    'a'.repeat(17 * 1024),
    // Wrong signing key
    signRs256Jwt(baseClaims, ROGUE_KEYS.privateKey, { kid: 'kid-1' }),
    // Bad claims
    signRs256Jwt({ ...baseClaims, iss: 'https://evil.cloudflareaccess.com' }),
    signRs256Jwt({ ...baseClaims, aud: 'wrong-aud-0000' }),
    signRs256Jwt({ ...baseClaims, aud: ['wrong-aud-0000'] }),
    signRs256Jwt({ ...baseClaims, aud: [] }),
    signRs256Jwt({ ...baseClaims, exp: undefined }),
    signRs256Jwt({ ...baseClaims, exp: '9999999999' }),
    signRs256Jwt({ ...baseClaims, email: undefined }),
    signRs256Jwt({ ...baseClaims, email: 'invalid-email' }),
    signRs256Jwt({ ...baseClaims, sub: 12345 })
  ];

  // Tampered payload keeping original signature
  const valid = signRs256Jwt(baseClaims);
  const [h, , s] = valid.split('.');
  invalidTokens.push(`${h}.${b64uJson({ ...baseClaims, email: 'attacker@example.test' })}.${s}`);

  for (const token of invalidTokens) {
    await assert.rejects(
      verifier.verifyJwt(token),
      err => err instanceof CloudflareAccessError && err.status === 403
    );
  }
});

test('T-CA-4: JWKS caching, singleflight concurrency, key rotation refresh, timeout 503, and weak key rejection', async () => {
  let nowMs = 1_760_000_000_000;
  const nowSec = Math.floor(nowMs / 1000);
  let providerCalls = 0;
  let activeKeys = [toPublicJwk(PRIMARY_KEYS.publicKey, 'kid-1')];

  const verifier = createCloudflareAccessVerifier({
    cfTeamDomain: TEST_TEAM,
    cfAud: TEST_AUD,
    cacheTtlMs: 300_000,
    minRefreshIntervalMs: 10_000,
    now: () => nowMs,
    jwksProvider: async () => {
      providerCalls++;
      await new Promise(resolveDelay => setTimeout(resolveDelay, 15));
      return { keys: activeKeys };
    }
  });

  const jwt1 = signRs256Jwt(buildDefaultClaims(nowSec));
  // Singleflight: 5 concurrent verifyJwt calls trigger only 1 fetch
  const batch = await Promise.all(Array.from({ length: 5 }, () => verifier.verifyJwt(jwt1)));
  assert.equal(batch.length, 5);
  assert.equal(providerCalls, 1);

  // Cached sequential calls stay at 1 fetch
  await verifier.verifyJwt(jwt1);
  await verifier.verifyJwt(jwt1);
  assert.equal(providerCalls, 1);

  // Unknown kid within minRefreshIntervalMs does NOT trigger fetch
  const jwtRotated = signRs256Jwt(buildDefaultClaims(nowSec), ROTATED_KEYS.privateKey, { kid: 'kid-2' });
  await assert.rejects(verifier.verifyJwt(jwtRotated), err => err instanceof CloudflareAccessError && err.status === 403);
  assert.equal(providerCalls, 1);

  // Advance past minRefreshIntervalMs and rotate keys -> triggers 1 refresh and succeeds
  nowMs += 11_000;
  activeKeys = [toPublicJwk(ROTATED_KEYS.publicKey, 'kid-2')];
  const rotatedRes = await verifier.verifyJwt(jwtRotated);
  assert.equal(rotatedRes.email, OWNER_LOGIN);
  assert.equal(providerCalls, 2);

  // Unknown kid even after refresh -> 403
  nowMs += 11_000;
  await assert.rejects(
    verifier.verifyJwt(signRs256Jwt(buildDefaultClaims(nowSec), PRIMARY_KEYS.privateKey, { kid: 'kid-unknown' })),
    err => err instanceof CloudflareAccessError && err.status === 403
  );
  assert.equal(providerCalls, 3);

  // Provider failures & weak RSA (<2048) keys return 503
  for (const badProvider of [
    async () => { throw new Error('network down'); },
    async () => ({ keys: [] }),
    async () => ({ keys: [toPublicJwk(WEAK_KEYS.publicKey, 'weak-1')] })
  ]) {
    const failingVerifier = createCloudflareAccessVerifier({
      cfTeamDomain: TEST_TEAM,
      cfAud: TEST_AUD,
      now: () => nowMs,
      jwksProvider: badProvider
    });
    await assert.rejects(
      failingVerifier.verifyJwt(jwt1),
      err => err instanceof CloudflareAccessError && err.status === 503
    );
  }

  // Timeout abort triggers 503 promptly
  let sawAbort = false;
  const timeoutVerifier = createCloudflareAccessVerifier({
    cfTeamDomain: TEST_TEAM,
    cfAud: TEST_AUD,
    fetchTimeoutMs: 50,
    now: () => nowMs,
    jwksProvider: ({ signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => {
        sawAbort = true;
        reject(new Error('aborted'));
      }, { once: true });
    })
  });
  await assert.rejects(
    timeoutVerifier.verifyJwt(jwt1),
    err => err instanceof CloudflareAccessError && err.status === 503
  );
  assert.equal(sawAbort, true);
});

test('T-CA-5: verifyRequest enforces rawHeaders, email header exact match, and zero JWT/key/AUD leakage', async () => {
  const nowMs = 1_760_000_000_000;
  const nowSec = Math.floor(nowMs / 1000);
  const primaryJwk = toPublicJwk(PRIMARY_KEYS.publicKey, 'kid-1');
  const verifier = createCloudflareAccessVerifier({
    cfTeamDomain: TEST_TEAM,
    cfAud: TEST_AUD,
    now: () => nowMs,
    jwksProvider: defaultJwksProvider([primaryJwk])
  });
  const jwt = signRs256Jwt(buildDefaultClaims(nowSec));
  const [, , sig] = jwt.split('.');

  // Valid without email header & with matching case-insensitive email header
  assert.equal((await verifier.verifyRequest({ rawHeaders: ['Cf-Access-Jwt-Assertion', jwt] })).email, OWNER_LOGIN);
  assert.equal((await verifier.verifyRequest({
    rawHeaders: ['Cf-Access-Jwt-Assertion', jwt, 'Cf-Access-Authenticated-User-Email', 'OWNER@EXAMPLE.TEST']
  })).email, OWNER_LOGIN);
  // Synthetic mock fallback without rawHeaders
  assert.equal((await verifier.verifyRequest({
    headers: { 'cf-access-jwt-assertion': jwt, 'cf-access-authenticated-user-email': OWNER_LOGIN }
  })).email, OWNER_LOGIN);

  const badRequests = [
    { rawHeaders: [] },
    { rawHeaders: ['Cf-Access-Authenticated-User-Email', OWNER_LOGIN] }, // standalone email header
    { rawHeaders: ['Cf-Access-Jwt-Assertion', jwt, 'cf-access-jwt-assertion', jwt] }, // duplicate JWT
    { rawHeaders: ['Cf-Access-Jwt-Assertion', jwt, 'Cf-Access-Authenticated-User-Email', 'other@example.test'] },
    { rawHeaders: ['Cf-Access-Jwt-Assertion', jwt, 'Cf-Access-Authenticated-User-Email', OWNER_LOGIN, 'Cf-Access-Authenticated-User-Email', OWNER_LOGIN] },
    { rawHeaders: ['Cf-Access-Jwt-Assertion', jwt, 'Cf-Access-Authenticated-User-Email', 'bad-email'] },
    { rawHeaders: ['Cf-Access-Jwt-Assertion', 'bad.jwt.value'] }
  ];
  for (const req of badRequests) {
    await assert.rejects(verifier.verifyRequest(req), err => {
      assert.ok(err instanceof CloudflareAccessError && err.status === 403);
      assert.equal(err.message.includes(jwt), false);
      assert.equal(err.message.includes(sig), false);
      assert.equal(err.message.includes(primaryJwk.n), false);
      assert.equal(err.message.includes(TEST_AUD), false);
      return true;
    });
  }
});

// ============================================================================
// Suite B: server.mjs Integration
// ============================================================================

test('T-SRV-1: config resolution, createApp pre-mkdir validation, and CLI fail-closed without secret leakage', () => {
  const baseEnv = {
    DEPLOY_MODE: 'cloud-proxy',
    OWNER_ALLOWED_LOGINS: OWNER_LOGIN,
    OWNER_ALLOWED_HOSTS: OWNER_HOST,
    CHECKOUT_ALLOWED_HOSTS: CHECKOUT_HOST,
    STORE_PROXY_SECRET: STORE_SECRET,
    STORE_ALLOWED_IPS: '198.51.100.0/24',
    HEALTHZ_TOKEN: HEALTHZ_SECRET
  };

  // Defaults preserved when omitted or empty
  const defaultResolved = resolveServerDeployConfig(baseEnv);
  assert.equal(defaultResolved.ownerAuthProvider, 'tailscale');
  assert.equal(defaultResolved.storeIpHeader, 'x-real-ip');

  const emptyOverrides = resolveServerDeployConfig({ ...baseEnv, OWNER_AUTH_PROVIDER: '', STORE_IP_HEADER: '' });
  assert.equal(emptyOverrides.ownerAuthProvider, 'tailscale');
  assert.equal(emptyOverrides.storeIpHeader, 'x-real-ip');

  // Valid cloudflare-access + cf-connecting-ip
  const cfResolved = resolveServerDeployConfig({
    ...baseEnv,
    OWNER_AUTH_PROVIDER: 'cloudflare-access',
    OWNER_CF_TEAM_DOMAIN: TEST_TEAM,
    OWNER_CF_AUD: TEST_AUD,
    STORE_IP_HEADER: 'cf-connecting-ip',
    OWNER_ALLOWED_LOGINS: ` ${OWNER_LOGIN.toUpperCase()} `
  });
  assert.equal(cfResolved.ownerAuthProvider, 'cloudflare-access');
  assert.equal(cfResolved.ownerCfTeamDomain, TEST_ISSUER);
  assert.equal(cfResolved.storeIpHeader, 'cf-connecting-ip');
  assert.equal(cfResolved.allowMasterFallback, false);
  assert.equal(cfResolved.ownerAllowedLogins.has(OWNER_LOGIN), true);

  // Invalid configs fail closed without echoing secrets
  for (const badEnv of [
    { ...baseEnv, OWNER_AUTH_PROVIDER: 'oidc' },
    { ...baseEnv, STORE_IP_HEADER: 'x-forwarded-for' },
    { ...baseEnv, OWNER_AUTH_PROVIDER: 'cloudflare-access', OWNER_CF_TEAM_DOMAIN: '', OWNER_CF_AUD: TEST_AUD },
    { ...baseEnv, OWNER_AUTH_PROVIDER: 'cloudflare-access', OWNER_CF_TEAM_DOMAIN: 'http://evil.cloudflareaccess.com', OWNER_CF_AUD: TEST_AUD },
    { ...baseEnv, OWNER_AUTH_PROVIDER: 'cloudflare-access', OWNER_CF_TEAM_DOMAIN: TEST_TEAM, OWNER_CF_AUD: '' },
    { ...baseEnv, OWNER_AUTH_PROVIDER: 'cloudflare-access', OWNER_CF_TEAM_DOMAIN: TEST_TEAM, OWNER_CF_AUD: 'short' },
    { ...baseEnv, OWNER_AUTH_PROVIDER: 'cloudflare-access', OWNER_CF_TEAM_DOMAIN: TEST_TEAM, OWNER_CF_AUD: TEST_AUD, OWNER_ALLOWED_LOGINS: 'not-an-email' }
  ]) {
    assert.throws(() => resolveServerDeployConfig(badEnv), err => {
      assert.equal(err.message.includes(STORE_SECRET), false);
      assert.equal(err.message.includes(HEALTHZ_SECRET), false);
      assert.equal(err.message.includes(TEST_AUD), false);
      return true;
    });
  }

  // createApp fails BEFORE creating dataDirectory
  const root = resolve(tmpdir());
  const tmpRoot = mkdtempSync(join(root, 'p3-srv-fail-'));
  try {
    const neverCreated = join(tmpRoot, 'never-created');
    assert.throws(() => createApp({
      dataDirectory: neverCreated,
      deploy: {
        mode: 'cloud-proxy',
        ownerAuthProvider: 'cloudflare-access',
        ownerCfTeamDomain: TEST_TEAM,
        ownerCfAud: 'short',
        ownerAllowedLogins: [OWNER_LOGIN],
        ownerAllowedHosts: [OWNER_HOST],
        checkoutAllowedHosts: [CHECKOUT_HOST],
        storeProxySecret: STORE_SECRET,
        storeAllowedIps: ['198.51.100.0/24']
      }
    }));
    assert.equal(existsSync(neverCreated), false);

    // CLI spawnSync fail-closed without creating DATA_DIRECTORY or echoing secrets
    const cliResult = spawnSync(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], {
      env: {
        ...process.env,
        ...baseEnv,
        OWNER_AUTH_PROVIDER: 'cloudflare-access',
        OWNER_CF_TEAM_DOMAIN: TEST_TEAM,
        OWNER_CF_AUD: 'short',
        DATA_DIRECTORY: join(tmpRoot, 'cli-never-created')
      },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000
    });
    assert.equal(cliResult.status, 1);
    assert.equal(existsSync(join(tmpRoot, 'cli-never-created')), false);
    const combined = cliResult.stdout + cliResult.stderr;
    assert.equal(combined.includes(STORE_SECRET), false);
    assert.equal(combined.includes(HEALTHZ_SECRET), false);
    assert.equal(combined.includes(TEST_AUD), false);
  } finally {
    assert.equal(dirname(resolve(tmpRoot)), root);
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('T-SRV-2: local mode blocks all cf-* proxy markers and >40 header padding returns 431', async t => {
  const { port, repositories, dataDirectory } = await startServerFixture(t);
  const localHost = `127.0.0.1:${port}`;
  const nowSec = Math.floor(Date.now() / 1000);
  const jwt = signRs256Jwt(buildDefaultClaims(nowSec));

  for (const cfHeader of [
    ['Cf-Access-Jwt-Assertion', jwt],
    ['Cf-Access-Authenticated-User-Email', OWNER_LOGIN],
    ['Cf-Connecting-IP', '198.51.100.42'],
    ['Cf-Ray', '8f00000000000001-IST'],
    ['CF-IPCountry', 'TR'],
    ['Cf-Visitor', '{"scheme":"https"}']
  ]) {
    for (const route of ['/', '/api/auth/users', '/api/state', '/healthz']) {
      const res = await makeRawRequest(port, route, { rawHeaders: ['Host', localHost, ...cfHeader] });
      assert.equal(res.status, 403, `local mode must reject ${cfHeader[0]} on ${route}`);
    }
    const postCmd = await makeRawRequest(port, '/api/command', {
      method: 'POST',
      rawHeaders: ['Host', localHost, ...cfHeader],
      body: {}
    });
    assert.equal(postCmd.status, 403);
  }
  assert.equal(repositories.size, 0);
  assert.deepEqual(readdirSync(dataDirectory), []);

  const paddedRes = await sendRawTcpRequest(port, [
    'GET / HTTP/1.1',
    `Host: ${localHost}`,
    ...Array.from({ length: 38 }, (_, i) => `X-Pad-${i}: v`),
    'Cf-Connecting-IP: 198.51.100.42',
    'Connection: close'
  ]);
  assert.match(paddedRes, /^HTTP\/1\.1 431 /);
  assert.match(paddedRes, /\r\nConnection: close\r\n/i);
});

test('T-SRV-3: cloudflare-owner channel enforces RS256 JWT, tunnel header compatibility, isolation, 503 outage, and backward-compatible tailscale rejection', async t => {
  let jwksFailing = false;
  const deploy = createCfCloudDeployConfig({
    jwksProvider: async () => {
      if (jwksFailing) throw new Error('upstream JWKS down');
      return { keys: [toPublicJwk(PRIMARY_KEYS.publicKey, 'kid-1')] };
    }
  });
  const { port, logs } = await startServerFixture(t, deploy);
  const nowSec = Math.floor(Date.now() / 1000);
  const validJwt = signRs256Jwt(buildDefaultClaims(nowSec));
  const [, , sig] = validJwt.split('.');

  // Tunnel-injected headers + valid RS256 JWT -> 200
  const ownerPage = await makeRawRequest(port, '/owner', {
    rawHeaders: cfOwnerHeaders([], { jwt: validJwt, emailHeader: OWNER_LOGIN.toUpperCase() })
  });
  assert.equal(ownerPage.status, 200);

  // Cross-channel & Tailscale headers rejected 403
  for (const extraHeader of [
    ['X-Store-Proxy-Secret', STORE_SECRET],
    ['X-Real-IP', '198.51.100.42'],
    ['Tailscale-User-Login', OWNER_LOGIN],
    ['Tailscale-User-Name', 'Spoof'],
    ['Tailscale-Funnel-Request', 'true']
  ]) {
    assert.equal((await makeRawRequest(port, '/owner', {
      rawHeaders: cfOwnerHeaders(extraHeader, { jwt: validJwt })
    })).status, 403);
  }

  // Bad JWT / email-header / disallowed-email cases -> 403
  const disallowedJwt = signRs256Jwt(buildDefaultClaims(nowSec, { email: 'outsider@example.test' }));
  for (const badHeaders of [
    cfOwnerHeaders([], { jwt: null }),
    cfOwnerHeaders(['Cf-Access-Jwt-Assertion', validJwt], { jwt: validJwt }),
    cfOwnerHeaders([], { jwt: signAlgNoneJwt(buildDefaultClaims(nowSec)) }),
    cfOwnerHeaders([], { jwt: signHs256Jwt(buildDefaultClaims(nowSec)) }),
    cfOwnerHeaders([], { jwt: signRs256Jwt(buildDefaultClaims(nowSec), ROGUE_KEYS.privateKey) }),
    cfOwnerHeaders([], { jwt: signRs256Jwt(buildDefaultClaims(nowSec, { exp: nowSec - 120 })) }),
    cfOwnerHeaders([], { jwt: signRs256Jwt(buildDefaultClaims(nowSec, { aud: 'other-aud-1234' })) }),
    cfOwnerHeaders([], { jwt: signRs256Jwt(buildDefaultClaims(nowSec), ROGUE_KEYS.privateKey, { jwk: toPublicJwk(ROGUE_KEYS.publicKey, 'kid-1') }) }),
    cfOwnerHeaders([], { jwt: null, emailHeader: OWNER_LOGIN }),
    cfOwnerHeaders([], { jwt: validJwt, emailHeader: 'other@example.test' }),
    cfOwnerHeaders(['Cf-Access-Authenticated-User-Email', OWNER_LOGIN], { jwt: validJwt, emailHeader: OWNER_LOGIN }),
    cfOwnerHeaders([], { jwt: disallowedJwt })
  ]) {
    const res = await makeRawRequest(port, '/owner', { rawHeaders: badHeaders });
    assert.equal(res.status, 403);
    assert.equal(res.text.includes(validJwt), false);
    assert.equal(res.text.includes(sig), false);
    assert.equal(res.text.includes(TEST_AUD), false);
  }

  // > 40 header padding -> 431 with CSP
  for (const trailing of ['Tailscale-Funnel-Request: true', `X-Store-Proxy-Secret: ${STORE_SECRET}`, 'Origin: https://evil.example']) {
    const padded = await sendRawTcpRequest(port, [
      'GET /owner HTTP/1.1',
      `Host: ${OWNER_HOST}`,
      `Cf-Access-Jwt-Assertion: ${validJwt}`,
      ...Array.from({ length: 38 }, (_, i) => `X-Pad-${i}: v`),
      trailing,
      'Connection: close'
    ]);
    assert.match(padded, /^HTTP\/1\.1 431 /);
    assert.match(padded, /\r\nConnection: close\r\n/i);
    assert.match(padded, /\r\nContent-Security-Policy: /i);
  }

  // Owner setup, /api/state, employee creation, role isolation, allowMasterFallback: false, audit
  const setup = await makeRawRequest(port, '/api/auth/setup', {
    method: 'POST',
    rawHeaders: cfOwnerHeaders([], { jwt: validJwt }),
    body: { name: 'Bulut Patron', pin: '112233' }
  });
  assert.equal(setup.status, 201);
  const ownerToken = setup.json.token;

  const stateRes = await makeRawRequest(port, '/api/state?workspace=demo', {
    rawHeaders: cfOwnerHeaders([], { jwt: validJwt, token: ownerToken })
  });
  assert.equal(stateRes.status, 200);

  const empCreate = await makeRawRequest(port, '/api/auth/employees', {
    method: 'POST',
    rawHeaders: cfOwnerHeaders([], { jwt: validJwt, token: ownerToken }),
    body: { name: 'Kasa Çalışanı', pin: '445566' }
  });
  assert.equal(empCreate.status, 201);
  const empId = empCreate.json.id;

  // Employee login on cloudflare-owner -> 403, no token, audit records sourceKey: cf:<email>
  const empOwnerLogin = await makeRawRequest(port, '/api/auth/login', {
    method: 'POST',
    rawHeaders: cfOwnerHeaders([], { jwt: validJwt }),
    body: { id: empId, pin: '445566' }
  });
  assert.equal(empOwnerLogin.status, 403);
  assert.equal(empOwnerLogin.json?.token, undefined);

  // Employee logs in on store-checkout; bearer token rejected on cloudflare-owner
  const empLogin = await makeRawRequest(port, '/api/auth/login', {
    method: 'POST',
    rawHeaders: cfCheckoutHeaders(),
    body: { id: empId, pin: '445566' }
  });
  assert.equal(empLogin.status, 200);
  const empToken = empLogin.json.token;
  assert.equal((await makeRawRequest(port, '/api/auth/session', {
    rawHeaders: cfOwnerHeaders([], { jwt: validJwt, token: empToken })
  })).status, 403);

  // allowMasterFallback: false
  assert.equal((await makeRawRequest(port, '/api/auth/login', {
    method: 'POST',
    rawHeaders: cfCheckoutHeaders(),
    body: { id: empId, pin: '112233' }
  })).status, 401);

  const auditRes = await makeRawRequest(port, '/api/security/audit', {
    rawHeaders: cfOwnerHeaders([], { jwt: validJwt, token: ownerToken })
  });
  assert.equal(auditRes.status, 200);
  assert.ok(auditRes.json.entries.some(e => e.sourceKey === `cf:${OWNER_LOGIN}`));
  assert.equal(auditRes.text.includes(validJwt), false);
  assert.equal(auditRes.text.includes('112233'), false);

  // JWKS outage on cold verifier returns 503 without leaking secrets or logging 500
  jwksFailing = true;
  const outageDeploy = createCfCloudDeployConfig({
    jwksProvider: async () => { throw new Error('upstream JWKS down'); }
  });
  const outageApp = await startServerFixture(t, outageDeploy);
  const outageRes = await makeRawRequest(outageApp.port, '/owner', {
    rawHeaders: cfOwnerHeaders([], { jwt: validJwt })
  });
  assert.equal(outageRes.status, 503);
  assert.equal(outageRes.text.includes(validJwt), false);
  assert.equal(outageRes.text.includes(TEST_AUD), false);
  assert.equal(logs.length, 0);

  // Backward compatibility: tailscale-owner rejects cf-* headers
  const tailscaleDeploy = validateServerDeployConfig({
    mode: 'cloud-proxy',
    ownerAuthProvider: 'tailscale',
    ownerAllowedLogins: [OWNER_LOGIN],
    ownerAllowedHosts: [TAILSCALE_OWNER_HOST],
    checkoutAllowedHosts: [CHECKOUT_HOST],
    storeProxySecret: STORE_SECRET,
    storeAllowedIps: ['198.51.100.0/24']
  });
  const tsApp = await startServerFixture(t, tailscaleDeploy);
  for (const cfHeader of [['Cf-Access-Jwt-Assertion', validJwt], ['Cf-Connecting-IP', '203.0.113.10']]) {
    const res = await makeRawRequest(tsApp.port, '/owner', {
      rawHeaders: ['Host', TAILSCALE_OWNER_HOST, 'Origin', `https://${TAILSCALE_OWNER_HOST}`, 'Tailscale-User-Login', OWNER_LOGIN, ...cfHeader]
    });
    assert.equal(res.status, 403);
  }
});

test('T-SRV-4: store-checkout with STORE_IP_HEADER=cf-connecting-ip enforces IP/CIDR, channel isolation, lockout, and /healthz', async t => {
  const { port, repositories } = await startServerFixture(t, createCfCloudDeployConfig());
  const nowSec = Math.floor(Date.now() / 1000);
  const validJwt = signRs256Jwt(buildDefaultClaims(nowSec));

  // Allowed IPs (IPv4 CIDR, IPv6 CIDR, single IP, ::ffff: mapped) via CF-Connecting-IP
  for (const ip of ['198.51.100.42', '2001:db8::42', '203.0.113.50', '::ffff:198.51.100.42']) {
    const res = await makeRawRequest(port, '/checkout', { rawHeaders: cfCheckoutHeaders([], { ip }) });
    assert.equal(res.status, 200, `IP ${ip} must succeed via CF-Connecting-IP`);
  }

  // Reject missing CF-Connecting-IP (even if X-Real-IP is sent), duplicate CF-Connecting-IP, disallowed IP, Tailscale-*, Cf-Access-*
  for (const badHeaders of [
    cfCheckoutHeaders([], { ip: null }),
    cfCheckoutHeaders(['X-Real-IP', '198.51.100.42'], { ip: null }),
    cfCheckoutHeaders(['CF-Connecting-IP', '198.51.100.42']),
    cfCheckoutHeaders([], { ip: '192.0.2.50' }),
    cfCheckoutHeaders(['Tailscale-User-Login', OWNER_LOGIN]),
    cfCheckoutHeaders(['Cf-Access-Jwt-Assertion', validJwt]),
    cfCheckoutHeaders(['Cf-Access-Authenticated-User-Email', OWNER_LOGIN])
  ]) {
    assert.equal((await makeRawRequest(port, '/checkout', { rawHeaders: badHeaders })).status, 403);
  }

  // > 40 headers with trailing Cf-Access-Jwt-Assertion or Tailscale-User-Login -> 431
  for (const trailing of [`Cf-Access-Jwt-Assertion: ${validJwt}`, `Tailscale-User-Login: ${OWNER_LOGIN}`]) {
    const padded = await sendRawTcpRequest(port, [
      'GET /checkout HTTP/1.1',
      `Host: ${CHECKOUT_HOST}`,
      `X-Store-Proxy-Secret: ${STORE_SECRET}`,
      'CF-Connecting-IP: 198.51.100.42',
      ...Array.from({ length: 38 }, (_, i) => `X-Pad-${i}: v`),
      trailing,
      'Connection: close'
    ]);
    assert.match(padded, /^HTTP\/1\.1 431 /);
  }

  // Blocked owner static/API routes on store-checkout
  assert.equal((await makeRawRequest(port, '/owner', { rawHeaders: cfCheckoutHeaders() })).status, 403);
  assert.equal((await makeRawRequest(port, '/api/state', { rawHeaders: cfCheckoutHeaders() })).status, 403);
  assert.equal((await makeRawRequest(port, '/api/security/audit', { rawHeaders: cfCheckoutHeaders() })).status, 403);
  assert.equal(repositories.size, 0);

  // Setup owner + employee via cloudflare-owner, then test role isolation + per-IP lockout on CF-Connecting-IP
  const setup = await makeRawRequest(port, '/api/auth/setup', {
    method: 'POST',
    rawHeaders: cfOwnerHeaders([], { jwt: validJwt }),
    body: { name: 'Patron', pin: '112233' }
  });
  const ownerToken = setup.json.token;
  const emp = await makeRawRequest(port, '/api/auth/employees', {
    method: 'POST',
    rawHeaders: cfOwnerHeaders([], { jwt: validJwt, token: ownerToken }),
    body: { name: 'Kasiyer', pin: '445566' }
  });
  const empId = emp.json.id;

  // Owner bearer token & owner login rejected on store-checkout
  assert.equal((await makeRawRequest(port, '/api/checkout', { rawHeaders: cfCheckoutHeaders([], { token: ownerToken }) })).status, 403);
  assert.equal((await makeRawRequest(port, '/api/auth/login', {
    method: 'POST',
    rawHeaders: cfCheckoutHeaders(),
    body: { id: setup.json.actor.id, pin: '112233' }
  })).status, 403);

  // Employee works on store-checkout (pending approval + customer creation)
  const opening = {
    type: 'opening',
    date: '2026-11-24',
    balances: Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, a.id === 'nakit' ? '100' : '0']))
  };
  await makeRawRequest(port, '/api/command', {
    method: 'POST',
    rawHeaders: cfOwnerHeaders([], { jwt: validJwt, token: ownerToken }),
    body: { id: 'open-1', revision: 0, command: opening }
  });
  const empLogin = await makeRawRequest(port, '/api/auth/login', {
    method: 'POST',
    rawHeaders: cfCheckoutHeaders(),
    body: { id: empId, pin: '445566' }
  });
  assert.equal(empLogin.status, 200);
  const empToken = empLogin.json.token;
  const empChangePin = await makeRawRequest(port, '/api/auth/change-pin', {
    method: 'POST',
    rawHeaders: cfCheckoutHeaders([], { token: empToken }),
    body: { currentPin: '445566', newPin: '778899' }
  });
  assert.equal(empChangePin.status, 200);
  assert.equal((await makeRawRequest(port, '/api/checkout', {
    rawHeaders: cfCheckoutHeaders([], { token: empToken })
  })).status, 200);
  assert.equal((await makeRawRequest(port, '/api/command', {
    method: 'POST',
    rawHeaders: cfCheckoutHeaders([], { token: empToken }),
    body: { id: 'cust-1', revision: 1, command: { type: 'account', date: '2026-11-24', name: 'Yeni Müşteri', unit: 'TL', partyType: 'customer', opening: '0' } }
  })).status, 200);

  // Per-IP progressive lockout on CF-Connecting-IP (198.51.100.10)
  for (let i = 0; i < 5; i++) {
    const failed = await makeRawRequest(port, '/api/auth/login', {
      method: 'POST',
      rawHeaders: cfCheckoutHeaders([], { ip: '198.51.100.10' }),
      body: { id: empId, pin: '000000' }
    });
    assert.equal(failed.status, 401);
  }
  const locked = await makeRawRequest(port, '/api/auth/login', {
    method: 'POST',
    rawHeaders: cfCheckoutHeaders([], { ip: '198.51.100.10' }),
    body: { id: empId, pin: '778899' }
  });
  assert.equal(locked.status, 401);
  const auditLocked = await makeRawRequest(port, '/api/security/audit?eventType=login_locked', {
    rawHeaders: cfOwnerHeaders([], { jwt: validJwt, token: ownerToken })
  });
  assert.ok(auditLocked.json.entries.some(e => e.sourceKey === 'ip:198.51.100.10'));

  // /healthz loopback & token & funnel rejection
  assert.equal((await makeRawRequest(port, '/healthz', { rawHeaders: ['Host', `127.0.0.1:${port}`] })).status, 200);
  assert.equal((await makeRawRequest(port, '/healthz', { rawHeaders: ['Host', CHECKOUT_HOST, 'X-Healthz-Token', HEALTHZ_SECRET, 'Cf-Ray', '8f-ist'] })).status, 200);
  assert.equal((await makeRawRequest(port, '/healthz', { rawHeaders: ['Host', CHECKOUT_HOST, 'X-Healthz-Token', HEALTHZ_SECRET, 'Tailscale-Funnel-Request', 'true'] })).status, 403);
});

// ============================================================================
// Suite C: report-server.mjs & report-launcher.mjs
// ============================================================================

test('T-REP-1: validateReportConfig & sync/async authorizeReportRequest across tailscale and cloudflare-access', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const validJwt = signRs256Jwt(buildDefaultClaims(nowSec, { email: READER_LOGIN }));

  // Tailscale mode remains synchronous and rejects Cf-* headers
  const tsConfig = validateReportConfig({
    enabled: true,
    origin: TAILSCALE_REPORT_ORIGIN,
    allowedLogins: [READER_LOGIN]
  });
  const tsReq = {
    headers: { host: new URL(TAILSCALE_REPORT_ORIGIN).host, 'tailscale-user-login': READER_LOGIN, origin: TAILSCALE_REPORT_ORIGIN },
    rawHeaders: ['Host', new URL(TAILSCALE_REPORT_ORIGIN).host, 'Tailscale-User-Login', READER_LOGIN],
    socket: { remoteAddress: '127.0.0.1' }
  };
  assert.equal(authorizeReportRequest(tsReq, tsConfig), undefined);
  assert.throws(() => authorizeReportRequest({
    ...tsReq,
    rawHeaders: [...tsReq.rawHeaders, 'Cf-Access-Jwt-Assertion', validJwt]
  }, tsConfig), err => err.status === 403);

  // Invalid cloudflare-access origins/configs fail closed without echoing secrets
  for (const badOrigin of [
    'http://rapor.example.test',
    'https://127.0.0.1',
    'https://localhost',
    'https://*.example.test',
    'https://rapor.example.test/path',
    'https://rapor.example.test?a=1',
    'https://rapor.example.test:8443',
    'https://rapor.example.test:443'
  ]) {
    assert.throws(() => validateReportConfig({
      enabled: true,
      authProvider: 'cloudflare-access',
      origin: badOrigin,
      cfTeamDomain: TEST_TEAM,
      cfAud: TEST_AUD,
      allowedLogins: [READER_LOGIN]
    }));
  }
  assert.throws(() => validateReportConfig({
    enabled: true,
    authProvider: 'cloudflare-access',
    origin: REPORT_ORIGIN,
    cfTeamDomain: TEST_TEAM,
    cfAud: 'short',
    allowedLogins: [READER_LOGIN]
  }), err => !err.message.includes('short'));
  assert.throws(() => validateReportConfig({
    enabled: true,
    authProvider: 'cloudflare-access',
    origin: REPORT_ORIGIN,
    cfTeamDomain: TEST_TEAM,
    cfAud: TEST_AUD,
    allowedLogins: ['not-an-email']
  }));

  const cfConfig = validateReportConfig({
    enabled: true,
    authProvider: 'cloudflare-access',
    origin: REPORT_ORIGIN,
    cfTeamDomain: TEST_TEAM,
    cfAud: TEST_AUD,
    allowedLogins: [READER_LOGIN.toUpperCase()],
    jwksProvider: defaultJwksProvider()
  });

  // Valid async request with tunnel headers
  const validReq = {
    headers: { host: REPORT_HOST, origin: REPORT_ORIGIN },
    rawHeaders: [
      'Host', REPORT_HOST,
      'Origin', REPORT_ORIGIN,
      'Cf-Connecting-IP', '203.0.113.10',
      'Cf-Ray', '8f-ist',
      'X-Forwarded-For', '203.0.113.10',
      'Cf-Access-Jwt-Assertion', validJwt,
      'Cf-Access-Authenticated-User-Email', READER_LOGIN.toUpperCase()
    ],
    socket: { remoteAddress: '127.0.0.1' }
  };
  const identity = await authorizeReportRequest(validReq, cfConfig);
  assert.equal(identity.email, READER_LOGIN);

  // Rejected cases
  const disallowedJwt = signRs256Jwt(buildDefaultClaims(nowSec, { email: 'outsider@example.test' }));
  for (const badReq of [
    { ...validReq, socket: { remoteAddress: '192.0.2.1' } },
    { ...validReq, headers: { host: 'evil.example', origin: REPORT_ORIGIN }, rawHeaders: ['Host', 'evil.example', 'Cf-Access-Jwt-Assertion', validJwt] },
    { ...validReq, headers: { host: REPORT_HOST, origin: 'https://evil.example' }, rawHeaders: ['Host', REPORT_HOST, 'Origin', 'https://evil.example', 'Cf-Access-Jwt-Assertion', validJwt] },
    { ...validReq, rawHeaders: [...validReq.rawHeaders, 'Tailscale-User-Login', READER_LOGIN] },
    { ...validReq, rawHeaders: ['Host', REPORT_HOST, 'Cf-Access-Authenticated-User-Email', READER_LOGIN] },
    { ...validReq, rawHeaders: ['Host', REPORT_HOST, 'Cf-Access-Jwt-Assertion', validJwt, 'Cf-Access-Authenticated-User-Email', 'other@example.test'] },
    { ...validReq, rawHeaders: ['Host', REPORT_HOST, 'Cf-Access-Jwt-Assertion', disallowedJwt] }
  ]) {
    await assert.rejects(
      Promise.resolve().then(() => authorizeReportRequest(badReq, cfConfig)),
      err => err.status === 403
    );
  }
});

test('T-REP-2: createReportApp (cloudflare-access) preserves DB isolation, GET-only, PRAGMA query_only=ON, CSP, 431, and CLI fail-closed', async t => {
  const { directory, filename, writer, cleanup } = seedReportWorkspace(t);
  const beforeBytes = readFileSync(filename);
  const beforeEvents = writer.events();
  const nowSec = Math.floor(Date.now() / 1000);
  const validJwt = signRs256Jwt(buildDefaultClaims(nowSec, { email: READER_LOGIN }));
  const disallowedJwt = signRs256Jwt(buildDefaultClaims(nowSec, { email: 'outsider@example.test' }));

  const app = createReportApp({
    enabled: true,
    authProvider: 'cloudflare-access',
    origin: REPORT_ORIGIN,
    cfTeamDomain: TEST_TEAM,
    cfAud: TEST_AUD,
    allowedLogins: [READER_LOGIN],
    dataDirectory: directory,
    jwksProvider: defaultJwksProvider()
  });
  await app.listen(0);
  t.after(async () => {
    await new Promise(resolveClose => {
      app.server.close(resolveClose);
      app.server.closeAllConnections();
    });
    writer.close();
    cleanup();
  });
  const port = app.server.address().port;

  // Unauthenticated / disallowed / Tailscale requests fail 403 before DB open
  for (const extra of [
    [],
    ['Cf-Access-Jwt-Assertion', disallowedJwt],
    ['Cf-Access-Jwt-Assertion', validJwt, 'Tailscale-User-Login', READER_LOGIN],
    ['Cf-Access-Authenticated-User-Email', READER_LOGIN]
  ]) {
    const denied = await makeRawRequest(port, '/api/reports/overview?workspace=demo', {
      rawHeaders: ['Host', REPORT_HOST, ...extra]
    });
    assert.equal(denied.status, 403);
  }
  assert.equal(app.repositories.size, 0);

  // > 40 headers -> 431 (never silent truncation)
  const paddedReportRes = await sendRawTcpRequest(port, [
    'GET /api/reports/overview?workspace=demo HTTP/1.1',
    `Host: ${REPORT_HOST}`,
    `Cf-Access-Jwt-Assertion: ${validJwt}`,
    ...Array.from({ length: 38 }, (_, i) => `X-Pad-${i}: v`),
    'Origin: https://evil.example',
    'Connection: close'
  ]);
  assert.match(paddedReportRes, /^HTTP\/1\.1 431 /);
  assert.match(paddedReportRes, /\r\nConnection: close\r\n/i);

  const authHeaders = [
    'Host', REPORT_HOST,
    'Origin', REPORT_ORIGIN,
    'Cf-Connecting-IP', '203.0.113.10',
    'Cf-Ray', '8f-ist',
    'Cf-Access-Jwt-Assertion', validJwt
  ];

  // Authenticated GET / + reports endpoints + strict security headers
  const rootRes = await makeRawRequest(port, '/', { rawHeaders: authHeaders });
  assert.equal(rootRes.status, 200);
  assert.match(rootRes.headers['cache-control'], /no-store/);
  assert.equal(rootRes.headers['x-content-type-options'], 'nosniff');
  assert.equal(rootRes.headers['referrer-policy'], 'no-referrer');
  assert.equal(rootRes.headers['cross-origin-resource-policy'], 'same-origin');
  assert.match(rootRes.headers['content-security-policy'], /script-src 'self'/);
  assert.match(rootRes.headers['content-security-policy'], /frame-ancestors 'none'/);

  for (const route of [
    '/api/reports/overview?workspace=demo',
    '/api/reports/summary?workspace=demo&date=2026-10-27',
    '/api/reports/journal?workspace=demo&limit=100'
  ]) {
    const res = await makeRawRequest(port, route, { rawHeaders: authHeaders });
    assert.equal(res.status, 200, res.text);
    assert.doesNotMatch(res.text, /PRIVATE_COMMAND_MARKER|PRIVATE_ARCHIVE_MARKER|"command"|restore_archive|sqlite/i);
    assert.equal(res.text.includes(filename), false);
    assert.equal(res.text.includes(validJwt), false);
  }
  assert.deepEqual(writer.events(), beforeEvents);
  assert.deepEqual(readFileSync(filename), beforeBytes);

  // PRAGMA query_only=ON still enforced
  const reader = new ReportRepository(filename, 'demo');
  try {
    assert.equal(reader.db.prepare('PRAGMA query_only').get().query_only, 1);
  } finally {
    reader.close();
  }

  // Non-GET -> 405 Allow: GET; CONNECT -> 405; Upgrade -> 403; editor/recovery routes -> 404
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE']) {
    const res = await makeRawRequest(port, '/api/reports/overview', { method, rawHeaders: authHeaders });
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, 'GET');
  }
  for (const route of ['/api/state', '/api/command', '/api/restore', '/api/backup', '/api/recovery', '/data/demo.sqlite']) {
    assert.equal((await makeRawRequest(port, route, { rawHeaders: authHeaders })).status, 404);
  }
  const connectRes = await new Promise((resolveRes, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(`CONNECT ${REPORT_HOST}:443 HTTP/1.1\r\nHost: ${REPORT_HOST}:443\r\n\r\n`);
    });
    let data = '';
    sock.setEncoding('utf8');
    sock.on('data', chunk => { data += chunk; });
    sock.on('end', () => resolveRes(data));
    sock.on('error', reject);
  });
  assert.match(connectRes, /^HTTP\/1\.1 405 /);
  const upgradeRes = await sendRawTcpRequest(port, [
    'GET / HTTP/1.1',
    `Host: ${REPORT_HOST}`,
    'Connection: Upgrade',
    'Upgrade: websocket'
  ]);
  assert.match(upgradeRes, /^HTTP\/1\.1 403 /);

  // CLI fail-closed with invalid REPORT_CF_AUD without creating REPORT_DATA_DIRECTORY or leaking markers
  const root = resolve(tmpdir());
  const cliRoot = mkdtempSync(join(root, 'p3-cf-rep-cli-'));
  try {
    const neverCreated = join(cliRoot, 'never-created');
    const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../report-server.mjs', import.meta.url))], {
      env: {
        ...process.env,
        REPORT_ENABLED: '1',
        REPORT_AUTH_PROVIDER: 'cloudflare-access',
        REPORT_ORIGIN: REPORT_ORIGIN,
        REPORT_CF_TEAM_DOMAIN: TEST_TEAM,
        REPORT_CF_AUD: 'short',
        REPORT_ALLOWED_LOGINS: READER_LOGIN,
        REPORT_DATA_DIRECTORY: neverCreated
      },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000
    });
    assert.equal(cli.status, 1);
    assert.equal(existsSync(neverCreated), false);
    assert.equal((cli.stdout + cli.stderr).includes(TEST_TEAM), false);
    assert.equal((cli.stdout + cli.stderr).includes(READER_LOGIN), false);
  } finally {
    assert.equal(dirname(resolve(cliRoot)), root);
    rmSync(cliRoot, { recursive: true, force: true });
  }
});

test('T-REP-3: report-launcher supports 6-field, 7-field tailscale, and 9-field cloudflare-access schemas and port 4318 lifecycle', async t => {
  const root = resolve(tmpdir());
  const dir = mkdtempSync(join(root, 'p3-cf-launcher-'));
  const dataDirectory = join(dir, 'data');
  mkdirSync(dataDirectory);
  t.after(() => {
    assert.equal(dirname(resolve(dir)), root);
    rmSync(dir, { recursive: true, force: true });
  });

  // 6-field legacy tailscale
  const cfg6 = {
    schemaVersion: 1,
    enabled: true,
    origin: TAILSCALE_REPORT_ORIGIN,
    allowedLogins: [READER_LOGIN],
    dataDirectory,
    port: 4318
  };
  assert.deepEqual(validateLauncherConfig(cfg6), cfg6);

  // 7-field explicit tailscale
  const cfg7 = {
    schemaVersion: 1,
    enabled: true,
    authProvider: 'tailscale',
    origin: TAILSCALE_REPORT_ORIGIN,
    allowedLogins: [READER_LOGIN],
    dataDirectory,
    port: 4318
  };
  assert.deepEqual(validateLauncherConfig(cfg7), cfg7);
  assert.throws(() => validateLauncherConfig({ ...cfg7, cfAud: TEST_AUD }), err => !err.message.includes(TEST_AUD));
  assert.throws(() => validateLauncherConfig({ ...cfg7, secret: 'MARKER_SECRET' }), err => !err.message.includes('MARKER_SECRET'));

  // 9-field cloudflare-access
  const cfg9Raw = {
    schemaVersion: 1,
    enabled: true,
    authProvider: 'cloudflare-access',
    origin: REPORT_ORIGIN,
    cfTeamDomain: TEST_TEAM,
    cfAud: TEST_AUD,
    allowedLogins: [READER_LOGIN.toUpperCase()],
    dataDirectory,
    port: 4318
  };
  const cfg9Norm = validateLauncherConfig(cfg9Raw);
  assert.deepEqual(cfg9Norm, {
    schemaVersion: 1,
    enabled: true,
    authProvider: 'cloudflare-access',
    origin: REPORT_ORIGIN,
    cfTeamDomain: TEST_ISSUER,
    cfAud: TEST_AUD,
    allowedLogins: [READER_LOGIN],
    dataDirectory,
    port: 4318
  });

  // Reject invalid 9-field variants without leaking values
  for (const badCfg of [
    { ...cfg9Raw, secret: 'LEAK_MARKER' },
    { ...cfg9Raw, port: 4317 },
    { ...cfg9Raw, schemaVersion: 2 },
    { ...cfg9Raw, enabled: false },
    { ...cfg9Raw, cfTeamDomain: 'http://evil.cloudflareaccess.com' },
    { ...cfg9Raw, cfAud: 'short' },
    (() => { const copy = { ...cfg9Raw }; delete copy.cfAud; return copy; })()
  ]) {
    assert.throws(() => validateLauncherConfig(badCfg), err => {
      assert.equal(err.message.includes(TEST_AUD), false);
      assert.equal(err.message.includes('LEAK_MARKER'), false);
      return true;
    });
  }

  // readLauncherConfig accepts 9-field JSON up to 16 KiB
  const cfgFile = join(dir, 'launcher-cf.json');
  const jsonText = JSON.stringify(cfg9Raw);
  writeFileSync(cfgFile, jsonText + ' '.repeat(16 * 1024 - Buffer.byteLength(jsonText)));
  assert.deepEqual(readLauncherConfig(cfgFile), cfg9Norm);

  // createReportLauncher with port-0 wrapper + injected jwksProvider
  const nowSec = Math.floor(Date.now() / 1000);
  const validJwt = signRs256Jwt(buildDefaultClaims(nowSec, { email: READER_LOGIN }));
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const signals = new EventEmitter();
    let requestedPort;
    const launcher = createReportLauncher(cfg9Raw, {
      signals,
      jwksProvider: defaultJwksProvider(),
      createApp: options => {
        const app = createReportApp(options);
        return { ...app, listen: p => { requestedPort = p; return app.listen(0); } };
      }
    });
    try {
      await launcher.start();
      assert.equal(requestedPort, 4318);
      assert.equal(launcher.server.address().address, '127.0.0.1');
      assert.equal(launcher.repositories.size, 0);
      const port = launcher.server.address().port;

      assert.equal((await makeRawRequest(port, '/', { rawHeaders: ['Host', REPORT_HOST] })).status, 403);
      assert.equal((await makeRawRequest(port, '/', {
        rawHeaders: ['Host', REPORT_HOST, 'Cf-Access-Jwt-Assertion', validJwt]
      })).status, 200);
      assert.equal((await makeRawRequest(port, '/api/command', {
        rawHeaders: ['Host', REPORT_HOST, 'Cf-Access-Jwt-Assertion', validJwt]
      })).status, 404);
      assert.equal((await makeRawRequest(port, '/api/reports/overview?workspace=demo', {
        rawHeaders: ['Host', REPORT_HOST, 'Cf-Access-Jwt-Assertion', validJwt]
      })).status, 503);

      signals.emit(signal);
      await launcher.close();
      assert.equal(launcher.server.listening, false);
    } finally {
      await launcher.close();
    }
  }
});
