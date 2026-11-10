import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createReportApp } from '../report-server.mjs';

const launcherURL = new URL('../report-launcher.mjs', import.meta.url), launcherPath = fileURLToPath(launcherURL);
const api = () => import(launcherURL.href);
const marker = 'SYNTHETIC_PRIVATE_LAUNCHER_MARKER';
function fixture(t) {
  const root = resolve(tmpdir()), directory = mkdtempSync(join(root, 'defter-report-launcher-'));
  const dataDirectory = join(directory, 'synthetic-data'); mkdirSync(dataDirectory);
  const config = { schemaVersion: 1, enabled: true, origin: 'https://private-device.synthetic-tailnet.ts.net', allowedLogins: ['synthetic-reader@example.test'], dataDirectory, port: 4318 };
  const filename = join(directory, `${marker}.json`); writeFileSync(filename, JSON.stringify(config));
  t.after(() => { assert.equal(dirname(resolve(directory)), root); rmSync(directory, { recursive: true, force: true }); });
  return { directory, dataDirectory, filename, config };
}
function get(server, config, path = '/') {
  return new Promise((resolveResponse, reject) => {
    const request = http.get(`http://127.0.0.1:${server.address().port}${path}`, { headers: { Host: new URL(config.origin).host, 'Tailscale-User-Login': config.allowedLogins[0] } }, response => {
      let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => resolveResponse({ status: response.statusCode, body }));
    }); request.on('error', reject);
  });
}

test('CLI rejects missing, relative and unknown arguments with a generic error and nonzero exit', t => {
  const { filename, directory } = fixture(t);
  for (const args of [[], ['--config', `${marker}.json`], ['--config', filename, '--enable'], ['--other', filename]]) {
    const result = spawnSync(process.execPath, [launcherPath, ...args], { encoding: 'utf8', cwd: directory, windowsHide: true, timeout: 10000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Rapor portalı başlatılamadı/);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(`${marker}|synthetic-reader|private-device|synthetic-data`));
  }
});

test('launcher configuration is strictly six fields, enabled, versioned and restricted to the report port', async t => {
  const { validateLauncherConfig } = await api(), { config } = fixture(t);
  const normalized = validateLauncherConfig(config);
  assert.equal(normalized.port, 4318); assert.ok(Array.isArray(normalized.allowedLogins)); assert.deepEqual(normalized, config);
  assert.deepEqual(config.allowedLogins, ['synthetic-reader@example.test']);
  for (const value of [null, [], {}, { ...config, schemaVersion: 2 }, { ...config, schemaVersion: '1' }, { ...config, enabled: false }, { ...config, enabled: 1 }, { ...config, port: 4317 }, { ...config, port: 0 }, { ...config, port: '4318' }, { ...config, secret: marker }, { ...config, origin: 'http://private-device.synthetic-tailnet.ts.net' }, { ...config, allowedLogins: ['*'] }, { ...config, dataDirectory: 'relative' }]) {
    assert.throws(() => validateLauncherConfig(value), error => !new RegExp(`${marker}|synthetic-reader|private-device|synthetic-data`).test(String(error)));
  }
});

test('bounded UTF-8 config reads accept exactly 16 KiB and reject oversized, malformed or non-directory inputs', async t => {
  const { readLauncherConfig } = await api(), { filename, config, directory, dataDirectory } = fixture(t);
  const original = JSON.stringify(config), max = 16 * 1024;
  writeFileSync(filename, original + ' '.repeat(max - Buffer.byteLength(original)));
  assert.deepEqual(readLauncherConfig(filename), config);
  writeFileSync(filename, original + ' '.repeat(max + 1 - Buffer.byteLength(original)));
  assert.throws(() => readLauncherConfig(filename));
  for (const content of [Buffer.from([255, 254, 255]), '{', 'null', JSON.stringify({ ...config, dataDirectory: join(directory, 'never-created') })]) {
    writeFileSync(filename, content); assert.throws(() => readLauncherConfig(filename));
  }
  assert.equal(existsSync(join(directory, 'never-created')), false);
  const plainFile = join(directory, 'not-a-directory'); writeFileSync(plainFile, 'synthetic');
  writeFileSync(filename, JSON.stringify({ ...config, dataDirectory: plainFile })); assert.throws(() => readLauncherConfig(filename));
  assert.throws(() => readLauncherConfig('relative.json')); assert.throws(() => readLauncherConfig(join(directory, 'missing.json')));
  assert.deepEqual(readdirSync(dataDirectory), []);
});

test('launcher starts the existing read-only portal on loopback and closes cleanly for either signal', async t => {
  const { createReportLauncher } = await api(), { config, dataDirectory } = fixture(t);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const signals = new EventEmitter(); let port, received;
    const launcher = createReportLauncher(config, { signals, createApp: options => {
      received = options; const app = createReportApp(options);
      return { ...app, listen: value => { port = value; return app.listen(0); } };
    } });
    try {
      assert.equal(launcher.server.listening, false); await launcher.start();
      assert.equal(port, 4318); assert.equal(launcher.server.address().address, '127.0.0.1');
      assert.ok(Array.isArray(received.allowedLogins)); assert.equal(launcher.repositories.size, 0);
      assert.equal((await get(launcher.server, config)).status, 200);
      assert.equal((await get(launcher.server, config, '/api/command')).status, 404);
      assert.equal((await get(launcher.server, config, '/api/reports/overview?workspace=demo')).status, 503);
      assert.deepEqual(readdirSync(dataDirectory), []);
      signals.emit(signal); await launcher.close();
      assert.equal(launcher.server.listening, false); assert.equal(signals.listenerCount('SIGINT'), 0); assert.equal(signals.listenerCount('SIGTERM'), 0);
    } finally { await launcher.close(); }
  }
});

test('startup errors stay generic, clean up and never kill an existing listener', async t => {
  const { createReportLauncher } = await api(), { config } = fixture(t);
  let closed = 0; const signals = new EventEmitter();
  const launcher = createReportLauncher(config, { signals, createApp: () => ({
    repositories: new Map(), server: { close(callback) { closed++; callback(); } },
    listen: async port => { assert.equal(port, 4318); throw Object.assign(new Error(marker), { code: 'EADDRINUSE' }); }
  }) });
  await assert.rejects(launcher.start(), error => /Rapor portalı başlatılamadı/.test(String(error)) && !String(error).includes(marker));
  assert.equal(closed, 1); assert.equal(signals.listenerCount('SIGTERM'), 0); await launcher.close(); assert.equal(closed, 1);
});

test('CLI handles a genuinely occupied report port with a sanitized failure', async t => {
  const { filename, config } = fixture(t), blocker = http.createServer();
  let owned = false;
  try {
    await new Promise((resolveListen, reject) => { blocker.once('error', error => error.code === 'EADDRINUSE' ? resolveListen() : reject(error)); blocker.listen(4318, '127.0.0.1', () => { owned = true; resolveListen(); }); });
    const result = spawnSync(process.execPath, [launcherPath, '--config', filename], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(result.status, 1); assert.match(result.stderr, /Rapor portalı başlatılamadı/);
    for (const value of [marker, config.origin, config.allowedLogins[0], config.dataDirectory, 'EADDRINUSE']) assert.equal((result.stdout + result.stderr).includes(value), false);
    if (owned) assert.equal(blocker.listening, true);
  } finally { if (owned) await new Promise(resolveClose => blocker.close(resolveClose)); }
});

test('absolute launcher and config paths work from another CWD without creating any database', t => {
  const { filename, directory, dataDirectory } = fixture(t), cwd = join(directory, 'different-cwd'); mkdirSync(cwd);
  const program = `
    import assert from 'node:assert/strict';
    import http from 'node:http';
    import {EventEmitter} from 'node:events';
    import {startReportLauncher,readLauncherConfig} from ${JSON.stringify(launcherURL.href)};
    import {createReportApp} from ${JSON.stringify(new URL('../report-server.mjs', import.meta.url).href)};
    const config=readLauncherConfig(process.argv[1]);
    const launcher=await startReportLauncher(process.argv[1],{signals:new EventEmitter(),createApp:options=>{const app=createReportApp(options);return {...app,listen:port=>{assert.equal(port,4318);return app.listen(0);}};}});
    try{assert.equal(launcher.server.address().address,'127.0.0.1');const status=await new Promise((resolve,reject)=>{const request=http.get('http://127.0.0.1:'+launcher.server.address().port+'/',{headers:{Host:new URL(config.origin).host,'Tailscale-User-Login':config.allowedLogins[0]}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});request.on('error',reject);});assert.equal(status,200);console.log('Synthetic launcher CWD check passed.');}finally{await launcher.close();}
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program, filename], { cwd, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 0, 'Synthetic cross-CWD launch failed.'); assert.match(result.stdout, /CWD check passed/); assert.equal(result.stderr, '');
  assert.deepEqual(readdirSync(dataDirectory), []); assert.deepEqual(readdirSync(cwd), []);
});
