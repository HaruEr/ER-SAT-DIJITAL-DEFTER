import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createApp } from '../server.mjs';
import { authenticateTestOwner } from '../test-support/editor-session.mjs';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS } from '../domain.mjs';

const opening = () => ({ type: 'opening', date: '2026-10-27', balances: Object.fromEntries(INITIAL_ACCOUNTS.filter(account => !account.retired).map(account => [account.id, '0'])) });
const proxyHeaders = [
  ['Forwarded', 'for=198.51.100.10;proto=https'],
  ['fOrWaRdEd', ''],
  ['X-Forwarded-For', '127.0.0.1'],
  ['X-Forwarded-Host', 'localhost'],
  ['X-Forwarded-Proto', 'http'],
  ['x-FoRwArDeD-Future', ''],
  ['X-Real-IP', '127.0.0.1'],
  ['Tailscale-User-Login', 'audit@example.test'],
  ['Tailscale-User-Name', 'Synthetic reader'],
  ['Tailscale-User-Profile-Pic', ''],
  ['Tailscale-App-Capabilities', '{}'],
  ['tAiLsCaLe-Future-Marker', ''],
  ['Forwarded', '', 'FORWARDED', 'for=127.0.0.1'],
  ['TAILSCALE-USER-LOGIN', '', 'tailscale-user-login', 'audit@example.test']
];

async function fixture(t) {
  const temporaryRoot = resolve(tmpdir());
  const dataDirectory = mkdtempSync(join(temporaryRoot, 'defter-editor-boundary-'));
  const { server, repositories } = createApp({ dataDirectory, logger: () => {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const authorization = await authenticateTestOwner(server);
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    assert.equal(dirname(resolve(dataDirectory)), temporaryRoot);
    rmSync(dataDirectory, { recursive: true, force: true });
  });
  const host = `127.0.0.1:${server.address().port}`, origin = `http://${host}`;
  function request(path, { method = 'GET', headers = [], body, requestHost = host } = {}) {
    const content = body === undefined ? undefined : JSON.stringify(body);
    const rawHeaders = ['Host', requestHost, 'Authorization', authorization, ...headers];
    if (content !== undefined) rawHeaders.push('Content-Type', 'application/json', 'Content-Length', String(Buffer.byteLength(content)));
    return new Promise((resolveResponse, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers: rawHeaders }, response => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { text += chunk; });
        response.on('end', () => resolveResponse({ status: response.statusCode, text }));
      });
      req.on('error', reject);
      // A watchdog for stalled test clients. The dedicated archive/API tests enforce request deadlines.
      req.setTimeout(20000, () => req.destroy(new Error('Synthetic boundary request exceeded its deadline.')));
      req.end(content);
    });
  }
  return { repositories, request, origin };
}

test('editor rejects proxy header names on static requests even with blank, duplicate or mixed-case headers', async t => {
  const { repositories, request } = await fixture(t);
  for (const headers of proxyHeaders) {
    const response = await request('/', { headers });
    assert.equal(response.status, 403, `Proxy header ${headers[0]} must never reach the editor.`);
    assert.equal(repositories.size, 0, 'Rejected traffic must not open a ledger.');
  }
});

test('proxy markers block every editor API and write request before repository creation', async t => {
  const { repositories, request, origin } = await fixture(t);
  for (const path of ['/api/state', '/api/backup', '/api/recovery', '/api/summary', '/api/archive']) {
    const response = await request(`${path}?workspace=demo`, { headers: ['Origin', origin, 'X-Forwarded-For', '127.0.0.1'] });
    assert.equal(response.status, 403);
    assert.equal(repositories.size, 0);
  }
  for (const path of ['/api/command', '/api/restore', '/api/archive/restore']) {
    const response = await request(`${path}?workspace=demo`, { method: 'POST', headers: ['Origin', origin, 'Tailscale-User-Login', 'audit@example.test'], body: { id: 'must-not-write', revision: 0, command: opening() } });
    assert.equal(response.status, 403);
    assert.equal(repositories.size, 0);
  }
});

test('proxy-marked requests cannot change an already open ledger or its recovery archive', async t => {
  const { repositories, request, origin } = await fixture(t);
  const repo = new Repository(':memory:', 'demo');
  repositories.set('demo', repo);
  repo.execute({ id: 'existing-opening', revision: 0, command: opening() });
  const snapshot = () => ({ events: repo.db.prepare('SELECT * FROM events ORDER BY seq').all(), meta: repo.db.prepare('SELECT * FROM meta').all(), archive: repo.db.prepare('SELECT * FROM restore_archive').all() });
  const before = snapshot();
  const response = await request('/api/command?workspace=demo', { method: 'POST', headers: ['Origin', origin, 'X-Forwarded-Proto', 'http'], body: { id: 'must-not-commit', revision: 1, command: { type: 'movement', date: '2026-10-27', accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '1', note: 'Synthetic denied proxy request' } } });
  assert.equal(response.status, 403);
  assert.deepEqual(snapshot(), before);
});

test('ordinary localhost browser traffic remains usable regardless of words in non-proxy header values', async t => {
  const { repositories, request, origin } = await fixture(t);
  const headers = ['User-Agent', 'Synthetic browser mentioning Forwarded X-Forwarded-For Tailscale-User-Login', 'X-Local-Note', 'X-Real-IP'];
  assert.equal((await request('/', { headers })).status, 200);
  assert.equal(repositories.size, 0);
  const initial = await request('/api/state?workspace=demo', { headers });
  assert.equal(initial.status, 200);
  const revision = JSON.parse(initial.text).revision;
  const response = await request('/api/command?workspace=demo', { method: 'POST', headers: [...headers, 'Origin', origin], body: { id: 'normal-local-opening', revision, command: opening() } });
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.text).state.initialized, true);
});

test('existing Host and Origin boundaries continue rejecting foreign browser requests', async t => {
  const { repositories, request } = await fixture(t);
  assert.equal((await request('/api/state?workspace=demo', { requestHost: 'reader.tailnet.ts.net' })).status, 403);
  assert.equal((await request('/api/state?workspace=demo', { headers: ['Origin', 'https://reader.tailnet.ts.net'] })).status, 403);
  assert.equal(repositories.size, 0);
});
