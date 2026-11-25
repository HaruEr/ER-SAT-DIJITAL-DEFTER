import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, resolveServerDeployConfig, validateServerDeployConfig } from '../server.mjs';
import { INITIAL_ACCOUNTS } from '../domain.mjs';

const projectDirectory = fileURLToPath(new URL('../', import.meta.url));
const OWNER_HOST = 'owner.synthetic-tailnet.ts.net';
const CHECKOUT_HOST = 'kasa.checkout.example.test';
const OWNER_LOGIN = 'owner@example.test';
const STORE_SECRET = 'synthetic-store-proxy-secret-32chars';
const HEALTHZ_SECRET = 'synthetic-healthz-token-32-chars-ok';

function createCloudDeployConfig(overrides = {}) {
  return validateServerDeployConfig({
    mode: 'cloud-proxy',
    ownerAllowedLogins: [OWNER_LOGIN],
    ownerAllowedHosts: [OWNER_HOST],
    checkoutAllowedHosts: [CHECKOUT_HOST],
    storeProxySecret: STORE_SECRET,
    storeAllowedIps: ['198.51.100.0/24', '2001:db8::/32', '203.0.113.50'],
    healthzToken: HEALTHZ_SECRET,
    ...overrides
  });
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

async function startFixture(t, deploy = undefined) {
  const root = resolve(tmpdir());
  const dataDirectory = mkdtempSync(join(root, 'p2-cloud-proxy-'));
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
  const port = app.server.address().port;
  return { ...app, dataDirectory, port, logs };
}

function ownerHeaders(extra = [], { host = OWNER_HOST, origin = `https://${OWNER_HOST}`, login = OWNER_LOGIN, token } = {}) {
  const raw = [];
  if (host !== null) raw.push('Host', host);
  if (origin !== null) raw.push('Origin', origin);
  if (login !== null) raw.push('Tailscale-User-Login', login);
  if (token) raw.push('Authorization', `Bearer ${token}`);
  return [...raw, ...extra];
}

function checkoutHeaders(extra = [], { host = CHECKOUT_HOST, origin = `https://${CHECKOUT_HOST}`, secret = STORE_SECRET, ip = '198.51.100.42', token } = {}) {
  const raw = [];
  if (host !== null) raw.push('Host', host);
  if (origin !== null) raw.push('Origin', origin);
  if (secret !== null) raw.push('X-Store-Proxy-Secret', secret);
  if (ip !== null) raw.push('X-Real-IP', ip);
  if (token) raw.push('Authorization', `Bearer ${token}`);
  return [...raw, ...extra];
}

const openingCommand = () => ({
  type: 'opening',
  date: '2026-11-24',
  balances: Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, a.id === 'nakit' || a.id === 'ceyrek' ? '100' : '0']))
});

test('T1: local mode ignores ambient process.env, blocks all proxy markers, preserves master fallback, and serves local /healthz', async t => {
  const previousMode = process.env.DEPLOY_MODE;
  process.env.DEPLOY_MODE = 'cloud-proxy';
  let appFixture;
  try {
    appFixture = await startFixture(t);
  } finally {
    if (previousMode === undefined) delete process.env.DEPLOY_MODE;
    else process.env.DEPLOY_MODE = previousMode;
  }

  const { port, repositories, dataDirectory } = appFixture;
  const localHost = `127.0.0.1:${port}`;

  // Proxy-marked traffic is blocked on static, API, and /healthz without touching disk or repos
  const proxyVariants = [
    ['Forwarded', 'for=198.51.100.10'],
    ['X-Forwarded-For', '127.0.0.1'],
    ['X-Forwarded-Host', localHost],
    ['X-Forwarded-Proto', 'https'],
    ['X-Real-IP', '127.0.0.1'],
    ['Tailscale-User-Login', OWNER_LOGIN],
    ['Tailscale-Funnel-Request', ''],
    ['X-Store-Proxy-Secret', STORE_SECRET],
    ['x-store-proxy-secret', '']
  ];
  for (const proxyHeader of proxyVariants) {
    for (const route of ['/', '/api/auth/users', '/api/state', '/healthz']) {
      const res = await makeRawRequest(port, route, { rawHeaders: ['Host', localHost, ...proxyHeader] });
      assert.equal(res.status, 403, `local mode must reject ${proxyHeader[0]} on ${route}`);
    }
  }
  assert.equal(repositories.size, 0);
  assert.deepEqual(readdirSync(dataDirectory), []);

  // Loopback /healthz without proxy markers returns 200 without creating *.sqlite
  const healthGet = await makeRawRequest(port, '/healthz', { rawHeaders: ['Host', localHost] });
  assert.equal(healthGet.status, 200);
  assert.equal(healthGet.json.ok, true);
  assert.equal(healthGet.json.mode, 'local');
  assert.deepEqual(readdirSync(dataDirectory), []);

  const healthPost = await makeRawRequest(port, '/healthz', { method: 'POST', rawHeaders: ['Host', localHost] });
  assert.equal(healthPost.status, 405);
  assert.equal(healthPost.headers.allow, 'GET');

  // allowMasterFallback remains true in local mode
  const setup = await makeRawRequest(port, '/api/auth/setup', {
    method: 'POST',
    rawHeaders: ['Host', localHost, 'Origin', `http://${localHost}`],
    body: { name: 'Yerel Patron', pin: '112233' }
  });
  assert.equal(setup.status, 201);
  const emp = await makeRawRequest(port, '/api/auth/employees', {
    method: 'POST',
    rawHeaders: ['Host', localHost, 'Origin', `http://${localHost}`, 'Authorization', `Bearer ${setup.json.token}`],
    body: { name: 'Yerel Çalışan', pin: '445566' }
  });
  assert.equal(emp.status, 201);
  const masterLogin = await makeRawRequest(port, '/api/auth/login', {
    method: 'POST',
    rawHeaders: ['Host', localHost, 'Origin', `http://${localHost}`],
    body: { id: emp.json.id, pin: '112233' }
  });
  assert.equal(masterLogin.status, 200);
  assert.equal(masterLogin.json.actor.viaMasterPin, true);

  // Header padding > 40 headers with X-Forwarded-For in local mode returns 431 (never 200)
  const localPaddedProxyLines = [
    'GET / HTTP/1.1',
    `Host: ${localHost}`,
    ...Array.from({ length: 38 }, (_, i) => `X-Pad-${i}: v`),
    'X-Forwarded-For: 198.51.100.99',
    'Connection: close'
  ];
  const localPaddedRes = await sendRawTcpRequest(port, localPaddedProxyLines);
  assert.match(localPaddedRes, /^HTTP\/1\.1 431 /);
  assert.match(localPaddedRes, /\r\nConnection: close\r\n/i);

  // <= 40 headers works normally in local mode
  const localOk40Lines = [
    'GET /healthz HTTP/1.1',
    `Host: ${localHost}`,
    ...Array.from({ length: 38 }, (_, i) => `X-Pad-${i}: v`),
    'Connection: close'
  ];
  assert.match(await sendRawTcpRequest(port, localOk40Lines), /^HTTP\/1\.1 200 /);
});

test('T2: deploy config validator and CLI startup fail closed without leaking secrets or creating directories', async t => {
  assert.equal(resolveServerDeployConfig({}).mode, 'local');
  assert.equal(resolveServerDeployConfig({ DEPLOY_MODE: '' }).mode, 'local');
  assert.equal(resolveServerDeployConfig({ DEPLOY_MODE: 'local' }).mode, 'local');

  for (const badMode of ['LOCAL', ' local ', 'cloud', 'proxy', 'tunnel']) {
    assert.throws(() => resolveServerDeployConfig({ DEPLOY_MODE: badMode }));
  }

  const validEnv = {
    DEPLOY_MODE: 'cloud-proxy',
    OWNER_ALLOWED_LOGINS: ` ${OWNER_LOGIN.toUpperCase()} `,
    OWNER_ALLOWED_HOSTS: `${OWNER_HOST}:443`,
    CHECKOUT_ALLOWED_HOSTS: `${CHECKOUT_HOST}:8443`,
    STORE_PROXY_SECRET: STORE_SECRET,
    STORE_ALLOWED_IPS: '198.51.100.0/24, 2001:db8::/32',
    HEALTHZ_TOKEN: HEALTHZ_SECRET
  };
  const resolved = resolveServerDeployConfig(validEnv);
  assert.equal(resolved.mode, 'cloud-proxy');
  assert.equal(resolved.allowMasterFallback, false);
  assert.equal(resolved.ownerAllowedLogins.has(OWNER_LOGIN), true);
  assert.equal(resolved.ownerAllowedHosts.has(OWNER_HOST), true);
  assert.equal(resolved.checkoutAllowedHosts.has(`${CHECKOUT_HOST}:8443`), true);

  // Invalid OWNER_ALLOWED_LOGINS (including C1 control and invisible Unicode characters)
  for (const badLogins of [
    '',
    'a@example.test,,b@example.test',
    'a@example.test,',
    '*',
    'user name@example.test',
    'user\r\n@example.test',
    'owner\u0085@example.test',
    'owner\u009b@example.test',
    'owner\u200b@example.test',
    'owner\u202e@example.test'
  ]) {
    assert.throws(() => resolveServerDeployConfig({ ...validEnv, OWNER_ALLOWED_LOGINS: badLogins }));
  }

  // Invalid / overlapping hosts (including percent-encoding)
  for (const badHost of ['', 'evil.example/path', 'evil.example?a=1', 'evil.example#h', 'user@evil.example', '*.example.test', 'bad_host.example.test', 'evil.example.', 'evil.example:0', 'a.example.test,,b.example.test', 'owner%2eexample.test']) {
    assert.throws(() => resolveServerDeployConfig({ ...validEnv, OWNER_ALLOWED_HOSTS: badHost }));
    assert.throws(() => resolveServerDeployConfig({ ...validEnv, CHECKOUT_ALLOWED_HOSTS: badHost }));
  }
  assert.throws(() => resolveServerDeployConfig({
    ...validEnv,
    OWNER_ALLOWED_HOSTS: 'Shared.Example.Test:443',
    CHECKOUT_ALLOWED_HOSTS: 'shared.example.test'
  }));

  // Invalid STORE_PROXY_SECRET (never echoed in Error; rejects C1/invisible Unicode)
  for (const badSecret of [
    '',
    'short-secret',
    ` ${STORE_SECRET}`,
    `${STORE_SECRET} `,
    `${STORE_SECRET}\r\n`,
    `${STORE_SECRET}\u0085`,
    `${STORE_SECRET}\u009b`,
    `${STORE_SECRET}\u200b`,
    `${STORE_SECRET}\u202e`
  ]) {
    assert.throws(
      () => resolveServerDeployConfig({ ...validEnv, STORE_PROXY_SECRET: badSecret }),
      err => !err.message.includes(badSecret.trim() || '---')
    );
  }

  // Invalid STORE_ALLOWED_IPS
  for (const badIps of ['', 'not-an-ip', '198.51.100.0/33', '2001:db8::/129', 'fe80::1%eth0', '198.51.100.1,,198.51.100.2']) {
    assert.throws(() => resolveServerDeployConfig({ ...validEnv, STORE_ALLOWED_IPS: badIps }));
  }

  // Invalid HEALTHZ_TOKEN fails in BOTH local and cloud-proxy modes without echoing token
  for (const mode of ['local', 'cloud-proxy']) {
    for (const badToken of [
      'short-token',
      ` ${HEALTHZ_SECRET}`,
      `${HEALTHZ_SECRET}\n`,
      `${HEALTHZ_SECRET}\u0085`,
      `${HEALTHZ_SECRET}\u009b`,
      `${HEALTHZ_SECRET}\u200b`,
      `${HEALTHZ_SECRET}\u202e`
    ]) {
      assert.throws(
        () => resolveServerDeployConfig({ ...(mode === 'cloud-proxy' ? validEnv : { DEPLOY_MODE: 'local' }), HEALTHZ_TOKEN: badToken }),
        err => !err.message.includes('short-token') && !err.message.includes(HEALTHZ_SECRET)
      );
    }
  }

  // createApp fails before creating dataDirectory
  const root = resolve(tmpdir());
  const nonExistentDir = join(root, `p2-never-created-${Date.now()}`);
  assert.throws(() => createApp({ dataDirectory: nonExistentDir, deploy: { mode: 'cloud-proxy' } }));
  assert.equal(existsSync(nonExistentDir), false);

  // CLI spawn fails closed on invalid config without creating DATA_DIRECTORY or echoing secrets
  const cliDir = join(root, `p2-cli-fail-${Date.now()}`);
  const failChild = spawnSync(process.execPath, ['server.mjs'], {
    cwd: projectDirectory,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      PORT: '4399',
      DATA_DIRECTORY: cliDir,
      DEPLOY_MODE: 'cloud-proxy',
      OWNER_ALLOWED_LOGINS: '',
      OWNER_ALLOWED_HOSTS: OWNER_HOST,
      CHECKOUT_ALLOWED_HOSTS: CHECKOUT_HOST,
      STORE_PROXY_SECRET: STORE_SECRET,
      STORE_ALLOWED_IPS: '198.51.100.0/24',
      HEALTHZ_TOKEN: HEALTHZ_SECRET
    }
  });
  assert.equal(failChild.status, 1);
  assert.equal(existsSync(cliDir), false);
  assert.equal(failChild.stderr.includes(STORE_SECRET), false);
  assert.equal(failChild.stderr.includes(HEALTHZ_SECRET), false);

  // Valid CLI startup listens on loopback and responds 200 on /healthz
  const probeSocket = net.createServer();
  await new Promise(r => probeSocket.listen(0, '127.0.0.1', r));
  const freePort = probeSocket.address().port;
  await new Promise(r => probeSocket.close(r));

  const validCliDir = mkdtempSync(join(root, 'p2-cli-ok-'));
  t.after(() => rmSync(validCliDir, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      PORT: String(freePort),
      DATA_DIRECTORY: validCliDir,
      ...validEnv
    }
  });
  t.after(() => { if (!child.killed) child.kill('SIGTERM'); });

  const deadline = Date.now() + 10000;
  let healthOk = false;
  while (Date.now() < deadline) {
    try {
      const res = await makeRawRequest(freePort, '/healthz', { rawHeaders: ['Host', `127.0.0.1:${freePort}`] });
      if (res.status === 200 && res.json?.ok === true && res.json?.mode === 'cloud-proxy') {
        healthOk = true;
        break;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(healthOk, true);
  const exitPromise = new Promise(r => child.once('exit', (code, signal) => r({ code, signal })));
  child.kill('SIGTERM');
  await exitPromise;
});

test('T3: tailscale-owner channel enforces owner-only sessions, funnel rejection, origin/host checks, protocol hardening, and disables master fallback', async t => {
  const { port } = await startFixture(t, createCloudDeployConfig());

  // Protocol hardening: CONNECT 405, Upgrade 403
  const connectRes = await new Promise((resolveRes, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(`CONNECT ${OWNER_HOST}:443 HTTP/1.1\r\nHost: ${OWNER_HOST}:443\r\n\r\n`);
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
    `Host: ${OWNER_HOST}`,
    'Connection: Upgrade',
    'Upgrade: websocket'
  ]);
  assert.match(upgradeRes, /^HTTP\/1\.1 403 /);

  // Backslash in req.url returns 400 (never 500 TypeError or 200), percent-encoded Host returns 403
  assert.match(await sendRawTcpRequest(port, [
    'GET /\\127.0.0.1:99999/foo HTTP/1.1',
    `Host: ${OWNER_HOST}`,
    `Tailscale-User-Login: ${OWNER_LOGIN}`,
    'Connection: close'
  ]), /^HTTP\/1\.1 400 /);
  assert.match(await sendRawTcpRequest(port, [
    'GET /\\evil.com/healthz HTTP/1.1',
    `Host: 127.0.0.1:${port}`,
    'Connection: close'
  ]), /^HTTP\/1\.1 400 /);
  assert.equal((await makeRawRequest(port, '/owner', {
    rawHeaders: ownerHeaders([], { host: 'owner%2esynthetic-tailnet.ts.net', origin: `https://${OWNER_HOST}` })
  })).status, 403);

  // Header padding > 40 headers (and > maxHeadersCount=100) never truncates trailing security headers -> 431
  for (const padCount of [38, 102]) {
    const paddedRes = await sendRawTcpRequest(port, [
      'GET /owner HTTP/1.1',
      `Host: ${OWNER_HOST}`,
      `Tailscale-User-Login: ${OWNER_LOGIN}`,
      ...Array.from({ length: padCount }, (_, i) => `X-Pad-${i}: v`),
      'Tailscale-Funnel-Request: true',
      'Connection: close'
    ]);
    assert.match(paddedRes, /^HTTP\/1\.1 431 /);
    assert.match(paddedRes, /\r\nConnection: close\r\n/i);
    assert.match(paddedRes, /\r\nContent-Security-Policy: /i);
  }
  assert.match(await sendRawTcpRequest(port, [
    'GET /healthz HTTP/1.1',
    `Host: ${OWNER_HOST}`,
    `X-Healthz-Token: ${HEALTHZ_SECRET}`,
    ...Array.from({ length: 38 }, (_, i) => `X-Pad-${i}: v`),
    'Tailscale-Funnel-Request: true',
    'Connection: close'
  ]), /^HTTP\/1\.1 431 /);
  assert.match(await sendRawTcpRequest(port, [
    'GET /owner HTTP/1.1',
    `Host: ${OWNER_HOST}`,
    `Tailscale-User-Login: ${OWNER_LOGIN}`,
    ...Array.from({ length: 38 }, (_, i) => `X-Pad-${i}: v`),
    'Origin: https://evil.example',
    'Connection: close'
  ]), /^HTTP\/1\.1 431 /);
  assert.match(await sendRawTcpRequest(port, [
    'GET /owner HTTP/1.1',
    `Host: ${OWNER_HOST}`,
    `Tailscale-User-Login: ${OWNER_LOGIN}`,
    ...Array.from({ length: 38 }, (_, i) => `X-Pad-${i}: v`),
    `X-Store-Proxy-Secret: ${STORE_SECRET}`,
    'Connection: close'
  ]), /^HTTP\/1\.1 431 /);

  // Exactly 40 headers works normally (valid -> 200; trailing Funnel at #40 -> 403)
  assert.match(await sendRawTcpRequest(port, [
    'GET /owner HTTP/1.1',
    `Host: ${OWNER_HOST}`,
    `Tailscale-User-Login: ${OWNER_LOGIN}`,
    ...Array.from({ length: 37 }, (_, i) => `X-Pad-${i}: v`),
    'Connection: close'
  ]), /^HTTP\/1\.1 200 /);
  assert.match(await sendRawTcpRequest(port, [
    'GET /owner HTTP/1.1',
    `Host: ${OWNER_HOST}`,
    `Tailscale-User-Login: ${OWNER_LOGIN}`,
    ...Array.from({ length: 36 }, (_, i) => `X-Pad-${i}: v`),
    'Tailscale-Funnel-Request: true',
    'Connection: close'
  ]), /^HTTP\/1\.1 403 /);

  // Funnel unconditionally rejected across all routes including /healthz
  for (const funnelHeader of ['Tailscale-Funnel-Request', 'tailscale-funnel-request', 'TAILSCALE-FUNNEL-REQUEST']) {
    assert.equal((await makeRawRequest(port, '/', { rawHeaders: ownerHeaders([funnelHeader, '']) })).status, 403);
    assert.equal((await makeRawRequest(port, '/api/auth/users', { rawHeaders: ownerHeaders([funnelHeader, 'true']) })).status, 403);
    assert.equal((await makeRawRequest(port, '/healthz', { rawHeaders: ['Host', OWNER_HOST, 'X-Healthz-Token', HEALTHZ_SECRET, funnelHeader, 'true'] })).status, 403);
  }

  // Bad login / duplicate login / cross-channel headers / bad Origin / loopback Host rejected
  for (const badHeaders of [
    ownerHeaders([], { login: null }),
    ownerHeaders([], { login: '' }),
    ownerHeaders([], { login: 'outsider@example.test' }),
    ownerHeaders([], { login: `${OWNER_LOGIN},outsider@example.test` }),
    ownerHeaders(['Tailscale-User-Login', OWNER_LOGIN]),
    ownerHeaders(['X-Store-Proxy-Secret', STORE_SECRET]),
    ownerHeaders(['X-Real-IP', '198.51.100.42']),
    ownerHeaders([], { origin: `http://${OWNER_HOST}` }),
    ownerHeaders([], { origin: 'null' }),
    ownerHeaders([], { origin: 'https://evil.example' }),
    ownerHeaders(['Origin', `https://${OWNER_HOST}`]),
    ownerHeaders([], { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` })
  ]) {
    assert.equal((await makeRawRequest(port, '/owner', { rawHeaders: badHeaders })).status, 403);
  }

  // Valid owner access (with Tailscale Serve X-Forwarded-* present and ignored for trust)
  const ownerPage = await makeRawRequest(port, '/owner', {
    rawHeaders: ownerHeaders(['X-Forwarded-For', '203.0.113.99', 'X-Forwarded-Host', 'evil.example', 'X-Forwarded-Proto', 'http'], { login: OWNER_LOGIN.toUpperCase() })
  });
  assert.equal(ownerPage.status, 200);

  // Setup owner and create employee
  const setup = await makeRawRequest(port, '/api/auth/setup', {
    method: 'POST',
    rawHeaders: ownerHeaders(),
    body: { name: 'Bulut Patron', pin: '112233' }
  });
  assert.equal(setup.status, 201);
  const ownerToken = setup.json.token;

  const stateRes = await makeRawRequest(port, '/api/state?workspace=demo', { rawHeaders: ownerHeaders([], { token: ownerToken }) });
  assert.equal(stateRes.status, 200);

  const empCreate = await makeRawRequest(port, '/api/auth/employees', {
    method: 'POST',
    rawHeaders: ownerHeaders([], { token: ownerToken }),
    body: { name: 'Kasa Çalışanı', pin: '445566' }
  });
  assert.equal(empCreate.status, 201);
  const empId = empCreate.json.id;

  // Employee login on tailscale-owner rejected with 403 (no session issued / immediately logged out)
  const empOwnerLogin = await makeRawRequest(port, '/api/auth/login', {
    method: 'POST',
    rawHeaders: ownerHeaders(),
    body: { id: empId, pin: '445566' }
  });
  assert.equal(empOwnerLogin.status, 403);
  assert.equal(empOwnerLogin.json?.token, undefined);
  const ownerAuditAfterReject = await makeRawRequest(port, '/api/security/audit?eventType=logout', {
    rawHeaders: ownerHeaders([], { token: ownerToken })
  });
  assert.equal(ownerAuditAfterReject.status, 200);
  assert.ok(ownerAuditAfterReject.json.entries.some(e => e.actorId === empId && e.sourceKey === `tailscale:${OWNER_LOGIN}`));

  // allowMasterFallback: false -> employee login with owner's PIN rejected 401
  const masterAttemptCheckout = await makeRawRequest(port, '/api/auth/login', {
    method: 'POST',
    rawHeaders: checkoutHeaders(),
    body: { id: empId, pin: '112233' }
  });
  assert.equal(masterAttemptCheckout.status, 401);

  // Employee logs in legitimately on store-checkout, then bearer token is rejected on tailscale-owner
  const empLogin = await makeRawRequest(port, '/api/auth/login', {
    method: 'POST',
    rawHeaders: checkoutHeaders(),
    body: { id: empId, pin: '445566' }
  });
  assert.equal(empLogin.status, 200);
  const empToken = empLogin.json.token;

  assert.equal((await makeRawRequest(port, '/api/auth/session', { rawHeaders: ownerHeaders([], { token: empToken }) })).status, 403);
  assert.equal((await makeRawRequest(port, '/api/auth/change-pin', {
    method: 'POST',
    rawHeaders: ownerHeaders([], { token: empToken }),
    body: { currentPin: '445566', newPin: '778899' }
  })).status, 403);
  assert.equal((await makeRawRequest(port, '/api/auth/logout', {
    method: 'POST',
    rawHeaders: ownerHeaders([], { token: empToken }),
    body: {}
  })).status, 403);
  assert.equal((await makeRawRequest(port, '/api/checkout', { rawHeaders: ownerHeaders([], { token: empToken }) })).status, 403);
});

test('T4: store-checkout channel enforces proxy secret, IP/CIDR allowlist, strict surface isolation, role isolation, and per-IP lockout', async t => {
  const { port, dataDirectory, repositories } = await startFixture(t, createCloudDeployConfig());

  // Unauthenticated GET /api/auth/users (including bogus or non-existent Bearer token) returns { setup: false, users: [] } WITHOUT creating files
  for (const token of [undefined, 'invalid-token-123', 'A'.repeat(43)]) {
    const preSetupUsers = await makeRawRequest(port, '/api/auth/users', { rawHeaders: checkoutHeaders([], { token }) });
    assert.equal(preSetupUsers.status, 200);
    assert.deepEqual(preSetupUsers.json, { setup: false, users: [] });
  }
  assert.deepEqual(readdirSync(dataDirectory), []);

  // All blocked static assets, admin APIs, and non-allowlisted /api/* variants return 403 before DB open
  const blockedStatic = ['/owner', '/users', '/app.js', '/suppliers.js', '/supplier-pdf.js', '/users.js', '/vendor/pdfmake/pdfmake.min.js', '/vendor/pdfmake/vfs_fonts.js'];
  for (const path of blockedStatic) {
    assert.equal((await makeRawRequest(port, path, { rawHeaders: checkoutHeaders() })).status, 403, `blocked static ${path}`);
  }
  const blockedGetApis = [
    '/api/state',
    '/api/state/',
    '/api/%73tate',
    '/api/suppliers',
    '/api/backup',
    '/api/backup/',
    '/api/%62ackup',
    '/api/archive',
    '/api/recovery',
    '/api/journal',
    '/api/summary',
    '/api/account-statement',
    '/api/item-photo',
    '/api/security',
    '/api/security/audit',
    '/api/%73ecurity/audit',
    '/api/security/other',
    '/api/unknown-route'
  ];
  for (const path of blockedGetApis) {
    assert.equal((await makeRawRequest(port, path, { rawHeaders: checkoutHeaders() })).status, 403, `blocked GET ${path}`);
  }
  const blockedPostApis = ['/api/archive/restore', '/api/restore', '/api/download-ticket', '/api/pending-approvals/approve', '/api/pending-approvals/reject', '/api/auth/setup', '/api/auth/employees', '/api/auth/disable', '/api/auth/reset-pin', '/api/auth/rename'];
  for (const path of blockedPostApis) {
    assert.equal((await makeRawRequest(port, path, { method: 'POST', rawHeaders: checkoutHeaders(), body: {} })).status, 403, `blocked POST ${path}`);
  }
  assert.equal(repositories.size, 0);
  assert.deepEqual(readdirSync(dataDirectory), []);

  // Header padding > 40 headers with trailing Tailscale-User-Login on store-checkout returns 431 (never 200)
  assert.match(await sendRawTcpRequest(port, [
    'GET /checkout HTTP/1.1',
    `Host: ${CHECKOUT_HOST}`,
    `X-Store-Proxy-Secret: ${STORE_SECRET}`,
    'X-Real-IP: 198.51.100.42',
    ...Array.from({ length: 38 }, (_, i) => `X-Pad-${i}: v`),
    `Tailscale-User-Login: ${OWNER_LOGIN}`,
    'Connection: close'
  ]), /^HTTP\/1\.1 431 /);

  // Spoofed/invalid proxy headers on store-checkout are rejected 403
  for (const badHeaders of [
    checkoutHeaders([], { secret: null }),
    checkoutHeaders([], { secret: 'wrong-secret-000000000000' }),
    checkoutHeaders(['X-Store-Proxy-Secret', STORE_SECRET]),
    checkoutHeaders([], { ip: null }),
    checkoutHeaders([], { ip: '198.51.100.42, 203.0.113.50' }),
    checkoutHeaders(['X-Real-IP', '198.51.100.42']),
    checkoutHeaders([], { ip: '192.0.2.50' }),
    checkoutHeaders([], { ip: 'fe80::1%eth0' }),
    checkoutHeaders(['Tailscale-User-Login', OWNER_LOGIN]),
    checkoutHeaders(['Tailscale-User-Name', 'Spoofed']),
    checkoutHeaders([], { origin: `http://${CHECKOUT_HOST}` }),
    checkoutHeaders([], { origin: 'null' })
  ]) {
    assert.equal((await makeRawRequest(port, '/checkout', { rawHeaders: badHeaders })).status, 403);
  }

  // Allowed IPs (IPv4 CIDR, IPv6 CIDR, single IP, ::ffff: IPv4-mapped) work for checkout UI
  for (const ip of ['198.51.100.42', '2001:db8::42', '203.0.113.50', '::ffff:198.51.100.42']) {
    const res = await makeRawRequest(port, '/checkout', { rawHeaders: checkoutHeaders([], { ip }) });
    assert.equal(res.status, 200, `IP ${ip} must be allowed on store-checkout`);
  }

  // Setup owner and two employees via tailscale-owner
  const owner = (await makeRawRequest(port, '/api/auth/setup', {
    method: 'POST',
    rawHeaders: ownerHeaders(),
    body: { name: 'Mağaza Sahibi', pin: '112233' }
  })).json;
  const emp1 = (await makeRawRequest(port, '/api/auth/employees', {
    method: 'POST',
    rawHeaders: ownerHeaders([], { token: owner.token }),
    body: { name: 'Kasiyer Bir', pin: '445566' }
  })).json;
  const emp2 = (await makeRawRequest(port, '/api/auth/employees', {
    method: 'POST',
    rawHeaders: ownerHeaders([], { token: owner.token }),
    body: { name: 'Kasiyer İki', pin: '556677' }
  })).json;
  await makeRawRequest(port, '/api/command?workspace=demo', {
    method: 'POST',
    rawHeaders: ownerHeaders([], { token: owner.token }),
    body: { id: 'open-store', revision: 0, command: openingCommand() }
  });

  // Post-setup GET /api/auth/users on store-checkout still returns { setup: false, users: [] }
  const postSetupUsers = await makeRawRequest(port, '/api/auth/users', { rawHeaders: checkoutHeaders() });
  assert.equal(postSetupUsers.status, 200);
  assert.deepEqual(postSetupUsers.json, { setup: false, users: [] });

  // Owner login & owner bearer token are blocked on store-checkout
  const ownerLoginOnCheckout = await makeRawRequest(port, '/api/auth/login', {
    method: 'POST',
    rawHeaders: checkoutHeaders(),
    body: { name: 'Mağaza Sahibi', pin: '112233' }
  });
  assert.equal(ownerLoginOnCheckout.status, 403);
  assert.equal(ownerLoginOnCheckout.json?.token, undefined);

  for (const path of ['/api/auth/users', '/api/auth/session', '/api/checkout', '/api/pending-approvals']) {
    assert.equal((await makeRawRequest(port, path, { rawHeaders: checkoutHeaders([], { token: owner.token }) })).status, 403);
  }

  // Employee logs in, changes temporary PIN, and runs allowed checkout operations
  const emp1Login = await makeRawRequest(port, '/api/auth/login', {
    method: 'POST',
    rawHeaders: checkoutHeaders(['X-Forwarded-For', '192.0.2.99']),
    body: { name: 'Kasiyer Bir', pin: '445566' }
  });
  assert.equal(emp1Login.status, 200);
  const emp1Token = emp1Login.json.token;

  const pinChanged = await makeRawRequest(port, '/api/auth/change-pin', {
    method: 'POST',
    rawHeaders: checkoutHeaders([], { token: emp1Token }),
    body: { currentPin: '445566', newPin: '778899' }
  });
  assert.equal(pinChanged.status, 200);

  const checkoutData = await makeRawRequest(port, '/api/checkout?workspace=demo', { rawHeaders: checkoutHeaders([], { token: emp1Token }) });
  assert.equal(checkoutData.status, 200);
  assert.ok(Array.isArray(checkoutData.json.products));

  const customerCreate = await makeRawRequest(port, '/api/command?workspace=demo', {
    method: 'POST',
    rawHeaders: checkoutHeaders([], { token: emp1Token }),
    body: { id: 'cust-store-1', revision: 1, command: { type: 'account', date: '2026-11-24', name: 'Kasa Müşterisi', unit: 'TL', partyType: 'customer', opening: '0' } }
  });
  assert.equal(customerCreate.status, 200);

  const disallowedCmd = await makeRawRequest(port, '/api/command?workspace=demo', {
    method: 'POST',
    rawHeaders: checkoutHeaders([], { token: emp1Token }),
    body: { id: 'bad-store-cmd', revision: 2, command: { type: 'movement', date: '2026-11-24', accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '1', note: 'x' } }
  });
  assert.equal(disallowedCmd.status, 403);

  const submitPending = await makeRawRequest(port, '/api/pending-approvals?workspace=demo', {
    method: 'POST',
    rawHeaders: checkoutHeaders([], { token: emp1Token }),
    body: { id: 'pend-store-1', command: { type: 'dailyCount', date: '2026-11-24', counts: { ceyrek: '100' } } }
  });
  assert.equal(submitPending.status, 201);

  const listPending = await makeRawRequest(port, '/api/pending-approvals?workspace=demo', {
    rawHeaders: checkoutHeaders([], { token: emp1Token })
  });
  assert.equal(listPending.status, 200);
  assert.equal(listPending.json.items.length, 1);
  assert.equal(listPending.json.employees, undefined);
  assert.doesNotMatch(listPending.text, /Mağaza Sahibi|Kasiyer İki/);

  // Per-IP progressive lockout isolation: 5 bad PINs from 198.51.100.10 locks that client IP bucket
  // (login returns generic 401 and records login_locked with sourceKey=ip:198.51.100.10),
  // while 198.51.100.11 can still log in as emp2.
  for (let i = 0; i < 5; i++) {
    const failed = await makeRawRequest(port, '/api/auth/login', {
      method: 'POST',
      rawHeaders: checkoutHeaders([], { ip: '198.51.100.10' }),
      body: { id: emp1.id, pin: '000000' }
    });
    assert.equal(failed.status, 401);
  }
  const lockedSameIpOtherUser = await makeRawRequest(port, '/api/auth/login', {
    method: 'POST',
    rawHeaders: checkoutHeaders([], { ip: '::ffff:198.51.100.10' }),
    body: { id: emp2.id, pin: '556677' }
  });
  assert.equal(lockedSameIpOtherUser.status, 401);
  assert.equal(lockedSameIpOtherUser.json?.token, undefined);

  const lockedAudit = await makeRawRequest(port, '/api/security/audit?eventType=login_locked', {
    rawHeaders: ownerHeaders([], { token: owner.token })
  });
  assert.equal(lockedAudit.status, 200);
  assert.ok(lockedAudit.json.entries.some(e => e.sourceKey === 'ip:198.51.100.10' && e.detail?.lockedBucket === 'client'));

  const otherIpSuccess = await makeRawRequest(port, '/api/auth/login', {
    method: 'POST',
    rawHeaders: checkoutHeaders([], { ip: '198.51.100.11' }),
    body: { id: emp2.id, pin: '556677' }
  });
  assert.equal(otherIpSuccess.status, 200);

  // changePin progressive lockout returns 429 on the 6th attempt from the same IP bucket
  for (let i = 0; i < 5; i++) {
    const badChange = await makeRawRequest(port, '/api/auth/change-pin', {
      method: 'POST',
      rawHeaders: checkoutHeaders([], { ip: '198.51.100.11', token: otherIpSuccess.json.token }),
      body: { currentPin: '000000', newPin: '889900' }
    });
    assert.equal(badChange.status, 401);
  }
  const lockedChange = await makeRawRequest(port, '/api/auth/change-pin', {
    method: 'POST',
    rawHeaders: checkoutHeaders([], { ip: '198.51.100.11', token: otherIpSuccess.json.token }),
    body: { currentPin: '556677', newPin: '889900' }
  });
  assert.equal(lockedChange.status, 429);
});

test('T5: GET /api/security/audit enforces owner + !mustChangePin, query validation, channel boundary, and zero secret leakage', async t => {
  const { port } = await startFixture(t, createCloudDeployConfig());

  // Unauthenticated -> 401 on tailscale-owner, 403 on store-checkout
  assert.equal((await makeRawRequest(port, '/api/security/audit', { rawHeaders: ownerHeaders() })).status, 401);
  assert.equal((await makeRawRequest(port, '/api/security/audit', { rawHeaders: checkoutHeaders() })).status, 403);

  const owner = (await makeRawRequest(port, '/api/auth/setup', {
    method: 'POST',
    rawHeaders: ownerHeaders(),
    body: { name: 'Denetim Sahibi', pin: '112233' }
  })).json;
  const emp = (await makeRawRequest(port, '/api/auth/employees', {
    method: 'POST',
    rawHeaders: ownerHeaders([], { token: owner.token }),
    body: { name: 'Denetim Çalışan', pin: '445566' }
  })).json;

  // Trigger a failed login from store-checkout to populate sourceKey = ip:198.51.100.77
  await makeRawRequest(port, '/api/auth/login', {
    method: 'POST',
    rawHeaders: checkoutHeaders([], { ip: '198.51.100.77' }),
    body: { id: emp.id, pin: '999999' }
  });

  // POST /api/security/audit -> 405
  const postAudit = await makeRawRequest(port, '/api/security/audit', {
    method: 'POST',
    rawHeaders: ownerHeaders([], { token: owner.token }),
    body: {}
  });
  assert.equal(postAudit.status, 405);
  assert.equal(postAudit.headers.allow, 'GET');

  // Query param validation -> 400
  for (const badQuery of ['?unknown=1', '?limit=0', '?limit=-1', '?limit=abc', '?offset=-1', '?offset=abc', '?limit=10&limit=20', '?eventType=bad*pattern']) {
    assert.equal((await makeRawRequest(port, `/api/security/audit${badQuery}`, { rawHeaders: ownerHeaders([], { token: owner.token }) })).status, 400, badQuery);
  }

  // Valid owner query
  const auditRes = await makeRawRequest(port, '/api/security/audit?limit=10&offset=0', {
    rawHeaders: ownerHeaders([], { token: owner.token })
  });
  assert.equal(auditRes.status, 200);
  assert.ok(Array.isArray(auditRes.json.entries));
  assert.ok(auditRes.json.total >= 3);
  assert.equal(auditRes.json.limit, 10);
  assert.equal(auditRes.json.offset, 0);
  assert.ok(auditRes.json.entries.some(e => e.sourceKey === `tailscale:${OWNER_LOGIN}`));
  assert.ok(auditRes.json.entries.some(e => e.sourceKey === 'ip:198.51.100.77' && e.eventType === 'login_failed'));
  assert.doesNotMatch(auditRes.text, /112233|445566|999999|salt|verifier|balances/i);
  assert.equal(auditRes.text.includes(owner.token), false);

  // Filtered query
  const filteredRes = await makeRawRequest(port, '/api/security/audit?eventType=login_failed', {
    rawHeaders: ownerHeaders([], { token: owner.token })
  });
  assert.equal(filteredRes.status, 200);
  assert.ok(filteredRes.json.entries.length >= 1);
  assert.ok(filteredRes.json.entries.every(e => e.eventType === 'login_failed'));

  // Local mode: verify employee is 403 and owner with mustChangePin=true is 403 PIN_CHANGE_REQUIRED
  const localApp = await startFixture(t);
  const localHost = `127.0.0.1:${localApp.port}`;
  const localOwner = (await makeRawRequest(localApp.port, '/api/auth/setup', {
    method: 'POST',
    rawHeaders: ['Host', localHost, 'Origin', `http://${localHost}`],
    body: { name: 'Yerel Sahip', pin: '112233' }
  })).json;
  const localEmp = (await makeRawRequest(localApp.port, '/api/auth/employees', {
    method: 'POST',
    rawHeaders: ['Host', localHost, 'Origin', `http://${localHost}`, 'Authorization', `Bearer ${localOwner.token}`],
    body: { name: 'Yerel Çalışan', pin: '445566' }
  })).json;
  const localEmpSession = (await makeRawRequest(localApp.port, '/api/auth/login', {
    method: 'POST',
    rawHeaders: ['Host', localHost, 'Origin', `http://${localHost}`],
    body: { id: localEmp.id, pin: '445566' }
  })).json;
  await makeRawRequest(localApp.port, '/api/auth/change-pin', {
    method: 'POST',
    rawHeaders: ['Host', localHost, 'Origin', `http://${localHost}`, 'Authorization', `Bearer ${localEmpSession.token}`],
    body: { currentPin: '445566', newPin: '654321' }
  });
  assert.equal((await makeRawRequest(localApp.port, '/api/security/audit', {
    rawHeaders: ['Host', localHost, 'Authorization', `Bearer ${localEmpSession.token}`]
  })).status, 403);

  // Flip owner must_change_pin via resetOwnerPin in identity store & verify 403 PIN_CHANGE_REQUIRED
  const idRes = await makeRawRequest(localApp.port, '/api/security/audit', {
    rawHeaders: ['Host', localHost, 'Authorization', `Bearer ${localOwner.token}`]
  });
  assert.equal(idRes.status, 200);
  // Reset owner PIN with mustChangePin: true directly through IdentityStore API via dynamic import
  const { IdentityStore } = await import('../identity.mjs');
  const tempIdStore = new IdentityStore(localApp.dataDirectory);
  try {
    await tempIdStore.resetOwnerPin({ pin: '998877', mustChangePin: true });
  } finally {
    tempIdStore.close();
  }
  const mustChangeLogin = (await makeRawRequest(localApp.port, '/api/auth/login', {
    method: 'POST',
    rawHeaders: ['Host', localHost, 'Origin', `http://${localHost}`],
    body: { name: 'Yerel Sahip', pin: '998877' }
  })).json;
  assert.equal(mustChangeLogin.actor.mustChangePin, true);
  const blockedMustChange = await makeRawRequest(localApp.port, '/api/security/audit', {
    rawHeaders: ['Host', localHost, 'Authorization', `Bearer ${mustChangeLogin.token}`]
  });
  assert.equal(blockedMustChange.status, 403);
  assert.equal(blockedMustChange.json.code, 'PIN_CHANGE_REQUIRED');
});

test('T6: GET /healthz enforces auth, probes DBs read-only without creating files, stays independent of backups, and returns 503 on corrupt or missing DB', async t => {
  const { port, dataDirectory } = await startFixture(t, createCloudDeployConfig());
  const localHost = `127.0.0.1:${port}`;

  // Unauthorized / proxy-marked without token / wrong token / both headers / duplicate headers / foreign Host -> 403, zero files created
  for (const badHealthz of [
    ['Host', OWNER_HOST],
    ['Host', localHost, 'X-Forwarded-For', '198.51.100.1'],
    ['Host', OWNER_HOST, 'X-Healthz-Token', 'wrong-healthz-token-000000'],
    ['Host', OWNER_HOST, 'Authorization', `Bearer ${HEALTHZ_SECRET}`, 'X-Healthz-Token', HEALTHZ_SECRET],
    ['Host', OWNER_HOST, 'X-Healthz-Token', HEALTHZ_SECRET, 'X-Healthz-Token', HEALTHZ_SECRET],
    ['Host', OWNER_HOST, 'Authorization', `Bearer ${HEALTHZ_SECRET}`, 'Authorization', `Bearer ${HEALTHZ_SECRET}`],
    ['Host', 'evil.example', 'X-Healthz-Token', HEALTHZ_SECRET],
    ['Host', 'owner%2esynthetic-tailnet.ts.net', 'X-Healthz-Token', HEALTHZ_SECRET],
    ['Host', OWNER_HOST, 'X-Healthz-Token', HEALTHZ_SECRET, 'Origin', `http://${OWNER_HOST}`],
    ['Host', OWNER_HOST, 'X-Healthz-Token', HEALTHZ_SECRET, 'Tailscale-Funnel-Request', 'true']
  ]) {
    assert.equal((await makeRawRequest(port, '/healthz', { rawHeaders: badHealthz })).status, 403);
    assert.equal((await makeRawRequest(port, '/healthz', { method: 'POST', rawHeaders: badHealthz })).status, 403);
  }
  assert.deepEqual(readdirSync(dataDirectory), []);

  // Authorized loopback (127.0.0.1 & localhost) -> 200 without creating *.sqlite
  for (const host of [localHost, `localhost:${port}`]) {
    const res = await makeRawRequest(port, '/healthz', { rawHeaders: ['Host', host] });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.mode, 'cloud-proxy');
    assert.deepEqual(res.json.db, {
      dataDirectory: true,
      identity: { present: false, accessible: null },
      workspaces: {
        dukkan: { present: false, accessible: null },
        demo: { present: false, accessible: null }
      }
    });
  }
  assert.deepEqual(readdirSync(dataDirectory), []);

  // Authorized via Bearer or X-Healthz-Token
  const bearerHealth = await makeRawRequest(port, '/healthz', {
    rawHeaders: ['Host', OWNER_HOST, 'Authorization', `Bearer ${HEALTHZ_SECRET}`, 'X-Forwarded-For', '198.51.100.5']
  });
  assert.equal(bearerHealth.status, 200);
  const headerHealth = await makeRawRequest(port, '/healthz', {
    rawHeaders: ['Host', CHECKOUT_HOST, 'X-Healthz-Token', HEALTHZ_SECRET, 'Origin', `https://${CHECKOUT_HOST}`]
  });
  assert.equal(headerHealth.status, 200);

  // Authorized POST /healthz -> 405 Allow: GET
  const postAuthHealth = await makeRawRequest(port, '/healthz', {
    method: 'POST',
    rawHeaders: ['Host', localHost]
  });
  assert.equal(postAuthHealth.status, 405);
  assert.equal(postAuthHealth.headers.allow, 'GET');

  // Initialize DBs, break backups directory with a file, close workday (backup fails) -> /healthz still 200 and zero sensitive leakage
  const owner = (await makeRawRequest(port, '/api/auth/setup', {
    method: 'POST',
    rawHeaders: ownerHeaders(),
    body: { name: 'Sağlık Patron', pin: '112233' }
  })).json;
  const openRes = await makeRawRequest(port, '/api/command?workspace=demo', {
    method: 'POST',
    rawHeaders: ownerHeaders([], { token: owner.token }),
    body: { id: 'health-open', revision: 0, command: openingCommand() }
  });
  assert.equal(openRes.status, 200);
  writeFileSync(join(dataDirectory, 'backups'), 'block-backups-dir');
  const closeCounts = Object.fromEntries(openRes.json.state.accounts.filter(a => a.physical && !a.retired && a.countPolicy === 'daily').map(a => [a.id, a.id === 'nakit' || a.id === 'ceyrek' ? '100' : '0']));
  const closeRes = await makeRawRequest(port, '/api/command?workspace=demo', {
    method: 'POST',
    rawHeaders: ownerHeaders([], { token: owner.token }),
    body: { id: 'health-close', revision: 1, command: { type: 'close', date: '2026-11-24', counts: closeCounts, reasons: {}, approvedBy: 'Sağlık Patron' } }
  });
  assert.equal(closeRes.status, 200);
  assert.equal(closeRes.json.backupStatus.saved, false);

  const healthyAfterBackupFail = await makeRawRequest(port, '/healthz', { rawHeaders: ['Host', localHost] });
  assert.equal(healthyAfterBackupFail.status, 200);
  assert.equal(healthyAfterBackupFail.json.ok, true);
  assert.equal(healthyAfterBackupFail.json.db.identity.accessible, true);
  assert.equal(healthyAfterBackupFail.json.db.workspaces.demo.accessible, true);
  assert.doesNotMatch(healthyAfterBackupFail.text, /Sağlık Patron|nakit|ceyrek|112233|backups|sqlite/i);
  assert.equal(healthyAfterBackupFail.text.includes(dataDirectory), false);

  // Corrupt dukkan.sqlite & 0-byte file check -> 503 without leaking paths or SQLite errors
  writeFileSync(join(dataDirectory, 'dukkan.sqlite'), 'corrupted-not-a-sqlite-header');
  const corruptDukkan = await makeRawRequest(port, '/healthz', { rawHeaders: ['Host', localHost] });
  assert.equal(corruptDukkan.status, 503);
  assert.equal(corruptDukkan.json.ok, false);
  assert.equal(corruptDukkan.json.db.workspaces.dukkan.accessible, false);
  assert.doesNotMatch(corruptDukkan.text, /SQLITE|ERR_SQLITE|file is not a database/i);
  assert.equal(corruptDukkan.text.includes(dataDirectory), false);

  // 0-byte dukkan.sqlite -> 503
  writeFileSync(join(dataDirectory, 'dukkan.sqlite'), '');
  const emptyDukkan = await makeRawRequest(port, '/healthz', { rawHeaders: ['Host', localHost] });
  assert.equal(emptyDukkan.status, 503);
  assert.equal(emptyDukkan.json.ok, false);
  assert.equal(emptyDukkan.json.db.workspaces.dukkan.accessible, false);

  // Removed dataDirectory -> 503
  const missingFixture = await startFixture(t, createCloudDeployConfig());
  rmSync(missingFixture.dataDirectory, { recursive: true, force: true });
  const missingDirHealth = await makeRawRequest(missingFixture.port, '/healthz', {
    rawHeaders: ['Host', `127.0.0.1:${missingFixture.port}`]
  });
  assert.equal(missingDirHealth.status, 503);
  assert.equal(missingDirHealth.json.ok, false);
  assert.equal(missingDirHealth.json.db.dataDirectory, false);
});
