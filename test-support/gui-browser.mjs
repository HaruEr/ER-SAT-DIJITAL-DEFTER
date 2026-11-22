// Real-browser harness for GUI work: fresh synthetic ledger + local servers + headless Chrome (CDP).
// Never reads data/ or .local/; the seed (same as `npm run sandbox`) creates a new directory in TMPDIR.
// Used by scripts/gui-screenshots.mjs and qa-temp/gui-*-smoke.mjs.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { createApp } from '../server.mjs';
import { createReportApp } from '../report-server.mjs';

export const sleep = ms => new Promise(done => setTimeout(done, ms));
export const OWNER_READY = `document.querySelector('#main') && !document.querySelector('#main > .loading') && document.querySelector('#business-date')?.textContent !== 'Yükleniyor…'`;
export const LOGIN_READY = `document.querySelector('#login') && !document.querySelector('#login').hidden`;
export const CHECKOUT_READY = `document.querySelector('#trade') && !document.querySelector('#trade').hidden`;
export const OWNER_NAME = 'UAT Yönetici';
export const EMPLOYEE_NAME = 'UAT Çalışan';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export function findChrome() {
  return process.env.CHROME_PATH || [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium'
  ].find(existsSync) || null;
}

export async function startGuiSession({ reports = false, empty = false } = {}) {
  const chromePath = findChrome();
  if (!chromePath) throw new Error('Chrome not found; set CHROME_PATH.');

  // 1. Fresh synthetic ledger and the editor server. `empty: true` starts a brand-new install
  // (no owner, no ledger) for first-run setup screens.
  let fixture;
  if (empty) {
    fixture = { directory: mkdtempSync(join(tmpdir(), 'gui-harness-empty-')), password: null };
  } else {
    const seed = spawnSync(process.execPath, [join(repoRoot, 'qa-temp', 'supplier-uat-seed.mjs')], { encoding: 'utf8', windowsHide: true });
    if (seed.status !== 0) throw new Error(seed.stderr || 'Synthetic seed failed');
    fixture = JSON.parse(seed.stdout);
  }
  const { server } = createApp({ dataDirectory: fixture.directory });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;

  // 2. Optional read-only report server. It only accepts an HTTPS tailnet origin, so the browser
  // is pointed at a fictitious tailnet host and requests are answered locally via CDP Fetch.
  const reportLogin = 'gui-harness@local';
  let reportApp = null, reportBase = null, reportPort = null;
  if (reports) {
    const probe = createServer();
    reportPort = await new Promise(done => probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => done(port)); }));
    reportBase = 'https://gui-harness.example.ts.net';
    reportApp = createReportApp({ enabled: true, origin: reportBase, allowedLogins: [reportLogin], dataDirectory: fixture.directory });
    await reportApp.listen(reportPort);
  }

  // 3. Headless Chrome over the DevTools protocol (Node 24 global WebSocket).
  const profile = mkdtempSync(join(tmpdir(), 'gui-harness-chrome-'));
  const chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none', 'about:blank'], { stdio: 'ignore' });
  let wsUrl;
  for (let i = 0; i < 100 && !wsUrl; i++) {
    await sleep(100);
    const file = join(profile, 'DevToolsActivePort');
    if (existsSync(file)) { const [port, path] = readFileSync(file, 'utf8').trim().split('\n'); if (path) wsUrl = `ws://127.0.0.1:${port}${path}`; }
  }
  if (!wsUrl) { chrome.kill(); throw new Error('Chrome DevTools did not start.'); }
  const ws = new WebSocket(wsUrl);
  await new Promise((done, fail) => { ws.onopen = done; ws.onerror = fail; });

  let seq = 0;
  const pending = new Map();
  const consoleErrors = [];
  const send = (method, params = {}, sessionId) => new Promise((done, fail) => { const id = ++seq; pending.set(id, { done, fail }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  async function proxyReportRequest({ requestId, request }, sid) {
    const url = new URL(request.url);
    const body = await new Promise((done, fail) => {
      const req = httpRequest({ host: '127.0.0.1', port: reportPort, method: request.method, path: url.pathname + url.search,
        headers: { host: url.host, 'tailscale-user-login': reportLogin, accept: request.headers.Accept || '*/*' } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => done({ status: res.statusCode, headers: res.headers, data: Buffer.concat(chunks) }));
      });
      req.on('error', fail); req.end();
    });
    const responseHeaders = Object.entries(body.headers).filter(([name]) => !['content-length', 'connection', 'transfer-encoding'].includes(name)).map(([name, value]) => ({ name, value: String(value) }));
    await send('Fetch.fulfillRequest', { requestId, responseCode: body.status, responseHeaders, body: body.data.toString('base64') }, sid);
  }
  ws.onmessage = message => {
    const data = JSON.parse(message.data);
    if (data.id && pending.has(data.id)) { const { done, fail } = pending.get(data.id); pending.delete(data.id); data.error ? fail(new Error(data.error.message)) : done(data.result); }
    else if (data.method === 'Fetch.requestPaused') proxyReportRequest(data.params, data.sessionId).catch(error => consoleErrors.push('proxy: ' + error.message));
    else if (data.method === 'Runtime.exceptionThrown') consoleErrors.push(data.params.exceptionDetails?.exception?.description || data.params.exceptionDetails?.text);
  };

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const page = (method, params) => send(method, params, sessionId);
  await page('Page.enable');
  await page('Runtime.enable');

  async function evaluate(expression) {
    const result = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`${expression.slice(0, 80)} → ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
    return result.result.value;
  }
  async function until(expression, timeout = 10000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await evaluate(`Boolean(${expression})`).catch(() => false)) return; await sleep(50); }
    const where = await evaluate(`location.href + ' | ' + (document.body?.innerText || '').slice(0, 300).replace(/\\s+/g, ' ')`).catch(error => error.message);
    throw new Error(`Timed out waiting for ${expression}\n  page: ${where}\n  errors: ${consoleErrors.join(' / ')}`);
  }
  async function settle(ms = 450) {
    await evaluate('document.fonts ? document.fonts.ready.then(() => true) : true');
    await sleep(ms);
  }
  async function navigate(url, ready) {
    await page('Page.navigate', { url });
    await until(`document.readyState === 'complete'`);
    if (ready) await until(ready, 15000);
    await settle();
  }
  async function viewport({ width, height, mobile = false }) {
    await page('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    await page('Emulation.setTouchEmulationEnabled', { enabled: mobile });
  }
  async function setTheme(theme) {
    await evaluate(`(() => { try { localStorage.setItem('defter-theme', ${JSON.stringify(theme)}); } catch {} document.documentElement.dataset.theme = ${JSON.stringify(theme)}; return true; })()`);
  }
  async function login(userName = OWNER_NAME) {
    await navigate(`${base}/`, LOGIN_READY);
    await evaluate(`(() => {
      const select = document.querySelector('#user');
      const option = [...select.options].find(o => o.textContent === ${JSON.stringify(userName)});
      if (!option) throw new Error('user not found');
      select.value = option.value;
      document.querySelector('#password').value = ${JSON.stringify(fixture.password)};
      document.querySelector('#login').requestSubmit();
      return true;
    })()`);
    // Wait until the redirected app has fully loaded (session validated, first render done).
    // Navigating again immediately after location.replace could start a browser-initiated load
    // before the tab's sessionStorage write is committed, and the session would be lost.
    await until(`(location.pathname === '/owner' && (${OWNER_READY})) || (location.pathname === '/checkout' && (${CHECKOUT_READY}))`, 15000);
    await sleep(100);
  }
  async function logout() {
    await evaluate(`(() => { sessionStorage.clear(); return true; })()`);
  }
  async function closeLayers() {
    await evaluate(`(() => { let n = 0; while (window.DefterUI?.closeTopLayer?.() && n < 10) n++; document.querySelectorAll('dialog[open]').forEach(d => d.close()); return true; })()`);
    await sleep(400); // let exit ghosts finish
  }
  async function enableReportProxy() {
    if (!reportBase) throw new Error('Session started without reports.');
    await page('Fetch.enable', { patterns: [{ urlPattern: `${reportBase}/*`, requestStage: 'Request' }] });
  }
  async function close() {
    try { ws.close(); } catch {}
    chrome.kill();
    server.close();
    reportApp?.server.close();
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
    rmSync(fixture.directory, { recursive: true, force: true });
  }

  return { base, reportBase, fixture, page, send, evaluate, until, settle, navigate, viewport, setTheme, login, logout, closeLayers, enableReportProxy, consoleErrors, close };
}
