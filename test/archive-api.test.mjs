import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createApp } from '../server.mjs';
import { authenticateTestOwner, renewTestOwner, ownerFetch as fetch } from '../test-support/editor-session.mjs';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS } from '../domain.mjs';

function opening(id = 'opening', amount = '0') {
  const balances = Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, a.id === 'nakit' ? amount : '0']));
  return { id, schemaVersion: 3, timestamp: '2026-10-27T10:00:00Z', command: { type: 'opening', date: '2026-10-27', balances } };
}
function archive(events, workspace = 'demo') {
  const header = { type: 'header', format: 'kuyumcu-ledger-ndjson-v1', workspace, eventSchema: 3, sourceRevision: 1, exportedAt: '2026-10-27T10:00:00Z' };
  const content = [JSON.stringify(header), ...events.map(event => JSON.stringify({ type: 'event', event }))].map(line => line + '\n').join('');
  return content + JSON.stringify({ type: 'trailer', count: events.length, sha256: createHash('sha256').update(content).digest('hex') }) + '\n';
}
function snapshot(repo) {
  return { events: repo.db.prepare('SELECT * FROM events ORDER BY seq').all(), meta: repo.db.prepare('SELECT * FROM meta').all(), archive: repo.db.prepare('SELECT * FROM restore_archive').all() };
}
async function fixture(t, jsonBodyTimeoutMs) {
  const temporaryRoot = resolve(tmpdir()), dataDirectory = mkdtempSync(join(temporaryRoot, 'defter-archive-http-'));
  const logs = [], { server, repositories } = createApp({ dataDirectory, logger: record => logs.push(record), jsonBodyTimeoutMs });
  const repo = new Repository(':memory:', 'demo'); repositories.set('demo', repo);
  repo.execute({ id: 'original', revision: 0, command: opening('original', '5').command });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const authorization = await authenticateTestOwner(server);
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    assert.equal(dirname(resolve(dataDirectory)), temporaryRoot); rmSync(dataDirectory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const restore = (body, overrides = {}) => {
    const params = new URLSearchParams({ workspace: 'demo', revision: '1', confirmation: 'GERİ YÜKLE', ...overrides });
    return fetch(`${base}/archive/restore?${params}`, { method: 'POST', headers: { 'Content-Type': 'application/x-ndjson' }, body });
  };
  return { repo, base, restore, logs, dataDirectory, server, authorization };
}

test('validated NDJSON export and import preserve legacy JSON and archive the exact replaced raw rows', async t => {
  const { repo, base, restore, dataDirectory } = await fixture(t);
  const original = snapshot(repo), legacy = repo.backup();
  const exported = await fetch(`${base}/archive?workspace=demo`);
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-type'), /application\/x-ndjson/);
  assert.match(exported.headers.get('content-disposition'), /\.ndjson/);
  const content = await exported.text();
  const lines = content.trimEnd().split('\n').map(line => JSON.parse(line));
  assert.equal(lines[0].workspace, 'demo');
  assert.equal(lines[0].format, 'kuyumcu-ledger-ndjson-v1');
  assert.deepEqual(lines.filter(line => line.type === 'event').map(line => line.event), legacy.events);
  assert.deepEqual(snapshot(repo), original);
  const restored = await restore(archive([opening('replacement', '125.50')]));
  assert.equal(restored.status, 200, await restored.clone().text());
  const receipt = await restored.json();
  assert.deepEqual(Object.keys(receipt).sort(), ['archiveId', 'reauthenticate', 'restoredEvents', 'revision', 'workspace']);
  assert.equal(receipt.revision, 2); assert.equal(receipt.restoredEvents, 1);
  assert.equal(repo.state().balances.nakit, 12550);
  const rawArchive = JSON.parse(repo.db.prepare('SELECT body FROM restore_archive WHERE id=?').get(receipt.archiveId).body);
  assert.equal(rawArchive.format, 'kuyumcu-raw-history-v1');
  assert.equal(rawArchive.workspace, 'demo'); assert.equal(rawArchive.revision, 1);
  assert.deepEqual(rawArchive.records, original.events.map(row => ({ ...row })));
  await renewTestOwner(base);
  assert.equal((await fetch(`${base}/backup?workspace=demo`)).status, 200);
  assert.deepEqual(readdirSync(dataDirectory, { recursive: true }).filter(name => /(?:stage\.sqlite|\.ndjson)$/.test(name)), []);
});

test('untrusted stream framing, hash, history, workspace and restore controls never change active data', async t => {
  const { repo, restore } = await fixture(t), before = snapshot(repo);
  const valid = archive([opening('replacement')]);
  const badHistory = opening('bad'); badHistory.command.balances.nakit = '-1';
  const candidates = [
    valid.replace(/"sha256":"[a-f0-9]+"/, '"sha256":"wrong"'),
    valid.slice(0, valid.lastIndexOf('{"type":"trailer"')),
    valid + '{"type":"event","event":{}}\n',
    valid.replace('"count":1', '"count":2'),
    valid.replace('kuyumcu-ledger-ndjson-v1', 'unsupported-v2'),
    valid.replace('"eventSchema":3', '"eventSchema":99'),
    archive([opening('duplicate'), opening('duplicate')]),
    archive([badHistory]),
    archive([opening('other')], 'dukkan'),
    valid.replace('"type":"header"', '"type":"header","path":"../dukkan.sqlite"'),
    valid.slice(0, -1)
  ];
  for (const body of candidates) {
    const response = await restore(body); assert.equal(response.status, 400, await response.text());
    assert.deepEqual(snapshot(repo), before);
  }
  for (const overrides of [{ revision: '0' }, { confirmation: '' }, { revision: '-1' }]) {
    const response = await restore(valid, overrides);
    assert.equal(response.status, overrides.revision === '0' ? 409 : 400); await response.text();
    assert.deepEqual(snapshot(repo), before);
  }
});

test('export validates stored history before it sends download success headers', async t => {
  const { repo, base } = await fixture(t);
  repo.db.prepare('INSERT INTO events(id,body) VALUES(?,?)').run('bad', JSON.stringify(opening('bad')));
  const before = snapshot(repo);
  const response = await fetch(`${base}/archive?workspace=demo`);
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /Stored|SELECT|bad|opening|sqlite/i);
  assert.deepEqual(snapshot(repo), before);
});

test('normal JSON bodies have an active deadline even when the client sends no more chunks', async t => {
  const { repo, base, server, authorization } = await fixture(t, 25), before = snapshot(repo);
  const result = await new Promise(resolveResult => {
    let completed = false;
    const finish = value => { if (!completed) { completed = true; clearTimeout(probe); resolveResult(value); } };
    const request = http.request(`${base}/command?workspace=demo`, { method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json', 'Content-Length': '1000' } }, response => {
      let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => finish({ status: response.statusCode, body }));
    });
    request.on('error', () => {});
    const probe = setTimeout(() => { request.destroy(); finish({ status: 0, body: 'No controlled response within test deadline.' }); }, 500);
    request.write('{');
  });
  assert.equal(result.status, 408, result.body);
  assert.equal(server.requestTimeout, 120000);
  assert.deepEqual(snapshot(repo), before);
});

test('archive streaming is independent of the short normal JSON body deadline', async t => {
  const { repo, base, authorization } = await fixture(t, 20), content = archive([opening('slow-archive')]);
  const params = new URLSearchParams({ workspace: 'demo', revision: '1', confirmation: 'GERİ YÜKLE' });
  const result = await new Promise((resolveResult, reject) => {
    const request = http.request(`${base}/archive/restore?${params}`, { method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/x-ndjson', 'Content-Length': Buffer.byteLength(content) } }, response => {
      let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => resolveResult({ status: response.statusCode, body }));
    });
    request.on('error', reject); request.write(content.slice(0, 1));
    setTimeout(() => request.end(content.slice(1)), 80);
  });
  assert.equal(result.status, 200, result.body);
  assert.equal(repo.state().revision, 2);
});
