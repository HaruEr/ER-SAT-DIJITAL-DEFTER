import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createApp } from '../server.mjs';
import { authenticateTestOwner, renewTestOwner, ownerFetch as fetch } from '../test-support/editor-session.mjs';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS } from '../domain.mjs';

const opening = () => ({ type: 'opening', date: '2026-10-27', balances: Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, '0'])) });
function damagedEvent() {
  const command = opening();
  command.balances.nakit = '-1';
  return { id: 'damaged-opening', schemaVersion: 3, timestamp: '2026-10-27T10:00:00Z', command, privateMarker: 'private-ledger-data-must-stay-local' };
}
function insertRaw(repo, value) {
  repo.db.prepare('INSERT INTO events(id,body) VALUES(?,?)').run('damaged-opening', value);
}
function rawSnapshot(repo) {
  return {
    events: repo.db.prepare('SELECT * FROM events ORDER BY seq').all(),
    meta: repo.db.prepare('SELECT * FROM meta').all(),
    archive: repo.db.prepare('SELECT * FROM restore_archive').all()
  };
}
async function fixture(t) {
  const temporaryRoot = resolve(tmpdir());
  const dataDirectory = mkdtempSync(join(temporaryRoot, 'defter-recovery-api-'));
  const logs = [];
  const { server, repositories } = createApp({ dataDirectory, logger: record => logs.push(record) });
  const repo = new Repository(':memory:', 'demo');
  repositories.set('demo', repo);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await authenticateTestOwner(server);
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    assert.equal(dirname(resolve(dataDirectory)), temporaryRoot);
    rmSync(dataDirectory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const restore = data => fetch(`${base}/restore?workspace=demo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  return { repo, base, logs, restore };
}
function validBackup(t) {
  const source = new Repository(':memory:', 'demo');
  t.after(() => source.close());
  source.execute({ id: 'valid-opening', revision: 0, command: opening() });
  source.execute({ id: 'valid-movement', revision: 1, command: { type: 'movement', date: '2026-10-27', accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '125.50', note: 'Synthetic recovery amount' } });
  return source.backup();
}

test('recovery metadata reads the stored revision without replaying a damaged semantic history or writing records', () => {
  const repo = new Repository(':memory:', 'demo');
  try {
    insertRaw(repo, JSON.stringify(damagedEvent()));
    repo.db.exec('UPDATE meta SET revision=7 WHERE id=1');
    assert.throws(() => repo.state());
    repo.state = () => assert.fail('Recovery metadata must not call state() or replay the ledger.');
    repo.backup = () => assert.fail('Recovery metadata must not validate or export the ledger.');
    const before = rawSnapshot(repo);
    const changes = repo.db.prepare('SELECT total_changes() AS changes').get().changes;
    assert.deepEqual(repo.recoveryInfo(), { workspace: 'demo', revision: 7, canRestore: true });
    assert.deepEqual(rawSnapshot(repo), before);
    assert.equal(repo.db.prepare('SELECT total_changes() AS changes').get().changes, changes);
  } finally { repo.close(); }
});

test('HTTP recovery exposes only safe metadata after the normal state request fails', async t => {
  const { repo, base } = await fixture(t);
  insertRaw(repo, JSON.stringify(damagedEvent()));
  const before = rawSnapshot(repo);
  const state = await fetch(`${base}/state?workspace=demo`);
  assert.ok(state.status >= 400);
  await state.text();
  const response = await fetch(`${base}/recovery?workspace=demo`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
  const content = await response.text();
  assert.deepEqual(JSON.parse(content), { workspace: 'demo', revision: 0, canRestore: true });
  assert.doesNotMatch(content, /private-ledger|events|balances|timestamp|error|path|sqlite/i);
  assert.deepEqual(rawSnapshot(repo), before);
});

test('parseable but semantically invalid event values remain archivable recovery candidates', () => {
  for (const raw of ['null', '[]', '{"private":"synthetic"}']) {
    const repo = new Repository(':memory:', 'demo');
    try {
      insertRaw(repo, raw);
      assert.deepEqual(repo.recoveryInfo(), { workspace: 'demo', revision: 0, canRestore: true });
    } finally { repo.close(); }
  }
});

test('unparseable stored JSON returns canRestore false without exposing or changing the raw history', async t => {
  const { repo, base, logs } = await fixture(t);
  insertRaw(repo, '{"private-ledger-data-must-stay-local":');
  const before = rawSnapshot(repo);
  const response = await fetch(`${base}/recovery?workspace=demo`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { workspace: 'demo', revision: 0, canRestore: false });
  assert.deepEqual(rawSnapshot(repo), before);
  assert.equal(logs.length, 0);
});

test('a physical SQL read failure returns generic 500 and allowlisted recovery diagnostics', async t => {
  const { repo, base, logs } = await fixture(t);
  repo.db.exec('DROP TABLE events');
  const response = await fetch(`${base}/recovery?workspace=demo`);
  assert.equal(response.status, 500);
  const content = await response.text();
  assert.doesNotMatch(content, /SQLITE|table|events|no such|private|[A-Z]:\\/i);
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0], { event: 'request_failed', operation: 'recovery', workspace: 'demo', code: 'ERR_SQLITE_ERROR' });
  assert.equal(repo.db.prepare('SELECT revision FROM meta WHERE id=1').get().revision, 0);
});

test('recovery retains the host, origin, workspace and HTTP method boundaries', async t => {
  const { repo, base, logs } = await fixture(t);
  const before = rawSnapshot(repo);
  const crossOrigin = await fetch(`${base}/recovery?workspace=demo`, { headers: { Origin: 'https://other.example' } });
  assert.equal(crossOrigin.status, 403);
  await crossOrigin.text();
  const badHost = await new Promise((resolveStatus, reject) => {
    const req = http.get(`${base}/recovery?workspace=demo`, { headers: { Host: 'other.example' } }, response => { response.resume(); resolveStatus(response.statusCode); });
    req.on('error', reject);
  });
  assert.equal(badHost, 403);
  const badWorkspace = await fetch(`${base}/recovery?workspace=private-ledger-marker`);
  assert.equal(badWorkspace.status, 400);
  assert.doesNotMatch(await badWorkspace.text(), /private-ledger-marker/);
  const post = await fetch(`${base}/recovery?workspace=demo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(post.status, 404);
  await post.text();
  const normal = await fetch(`${base}/recovery?workspace=demo`);
  assert.equal(normal.status, 200);
  assert.deepEqual(await normal.json(), { workspace: 'demo', revision: 0, canRestore: true });
  assert.deepEqual(rawSnapshot(repo), before);
  assert.equal(logs.length, 0);
});

test('recovery metadata cannot bypass restore confirmation, workspace, checksum, replay or the latest revision', async t => {
  const { repo, base, restore } = await fixture(t);
  insertRaw(repo, JSON.stringify(damagedEvent()));
  const metadataResponse = await fetch(`${base}/recovery?workspace=demo`);
  assert.equal(metadataResponse.status, 200);
  const metadata = await metadataResponse.json();
  const backup = validBackup(t);
  const invalidHistory = structuredClone(backup);
  invalidHistory.events[0].command.balances.nakit = '-1';
  invalidHistory.sha256 = createHash('sha256').update(JSON.stringify(invalidHistory.events)).digest('hex');
  repo.db.exec('UPDATE meta SET revision=1 WHERE id=1');
  const before = rawSnapshot(repo);
  const stale = await restore({ backup, revision: metadata.revision, confirmation: 'GERİ YÜKLE' });
  assert.equal(stale.status, 409);
  await stale.text();
  for (const payload of [
    { backup, revision: 1, confirmation: '' },
    { backup: { ...backup, workspace: 'dukkan' }, revision: 1, confirmation: 'GERİ YÜKLE' },
    { backup: { ...backup, sha256: 'invalid-checksum' }, revision: 1, confirmation: 'GERİ YÜKLE' },
    { backup: invalidHistory, revision: 1, confirmation: 'GERİ YÜKLE' }
  ]) {
    const response = await restore(payload);
    assert.equal(response.status, 400);
    await response.text();
    assert.deepEqual(rawSnapshot(repo), before);
  }
  assert.deepEqual(rawSnapshot(repo), before);
});

test('safe recovery metadata leads to an atomic HTTP restore while preserving the damaged old history', async t => {
  const { repo, base, restore } = await fixture(t);
  const damaged = damagedEvent();
  insertRaw(repo, JSON.stringify(damaged));
  const metadataResponse = await fetch(`${base}/recovery?workspace=demo`);
  assert.equal(metadataResponse.status, 200);
  const metadata = await metadataResponse.json();
  assert.equal(metadata.canRestore, true);
  const backup = validBackup(t);
  const response = await restore({ backup, revision: metadata.revision, confirmation: 'GERİ YÜKLE' });
  assert.equal(response.status, 200);
  const { state } = await response.json();
  assert.equal(state.balances.nakit, 12550);
  assert.equal(state.revision, 1);
  assert.deepEqual(repo.events(), backup.events);
  const archived = repo.db.prepare('SELECT body FROM restore_archive').all();
  assert.equal(archived.length, 1);
  assert.deepEqual(JSON.parse(archived[0].body).events, [damaged]);
  await renewTestOwner(base);
  const after = await fetch(`${base}/recovery?workspace=demo`);
  assert.deepEqual(await after.json(), { workspace: 'demo', revision: 1, canRestore: true });
  assert.equal((await fetch(`${base}/state?workspace=demo`)).status, 200);
});

test('missing revision metadata is a controlled server failure rather than a guessed restore revision', async t => {
  const { repo, base, logs } = await fixture(t);
  repo.db.exec('DELETE FROM meta');
  const response = await fetch(`${base}/recovery?workspace=demo`);
  assert.equal(response.status, 500);
  const content = await response.text();
  assert.doesNotMatch(content, /revision|undefined|SELECT|TypeError/i);
  assert.equal(logs.length, 1);
});

test('negative or fractional revision metadata is never advertised as a safe restore revision', async t => {
  const { repo, base } = await fixture(t);
  for (const revision of [-1, 1.5]) {
    repo.db.prepare('UPDATE meta SET revision=? WHERE id=1').run(revision);
    const response = await fetch(`${base}/recovery?workspace=demo`);
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /revision|safe|integer|SELECT/i);
    assert.equal(repo.db.prepare('SELECT revision FROM meta WHERE id=1').get().revision, revision);
  }
});

test('recovery metadata uses one read snapshot while another connection changes the ledger', () => {
  const temporaryRoot = resolve(tmpdir());
  const dataDirectory = mkdtempSync(join(temporaryRoot, 'defter-recovery-snapshot-'));
  const filename = join(dataDirectory, 'synthetic.sqlite');
  const first = new Repository(filename, 'demo'), second = new Repository(filename, 'demo');
  const events = first.events.bind(first);
  let changed = false;
  first.events = () => {
    if (!changed) {
      changed = true;
      second.db.exec('BEGIN IMMEDIATE');
      insertRaw(second, 'unparseable synthetic JSON');
      second.db.exec('UPDATE meta SET revision=1 WHERE id=1; COMMIT');
    }
    return events();
  };
  try {
    assert.deepEqual(first.recoveryInfo(), { workspace: 'demo', revision: 0, canRestore: true });
    assert.deepEqual(first.recoveryInfo(), { workspace: 'demo', revision: 1, canRestore: false });
  } finally {
    first.close(); second.close();
    assert.equal(dirname(resolve(dataDirectory)), temporaryRoot);
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test('damaged stored history is a safe 500 state failure while SQL read error codes remain intact', async t => {
  const { repo, base, logs } = await fixture(t);
  insertRaw(repo, JSON.stringify(damagedEvent()));
  const before = rawSnapshot(repo);
  const response = await fetch(`${base}/state?workspace=demo`);
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /private-ledger|nakit|opening|Stored|ondalık|miktar/i);
  assert.deepEqual(logs, [{ event: 'request_failed', operation: 'state', workspace: 'demo', code: 'STORED_HISTORY_INVALID' }]);
  assert.deepEqual(rawSnapshot(repo), before);
  const readFailure = Object.assign(new Error('private-ledger-physical-read'), { code: 'EIO' });
  repo.events = () => { throw readFailure; };
  assert.throws(() => repo.state(), error => error === readFailure && error.code === 'EIO');
});

test('same-ID retry after committed command and later stored damage stays 500 without duplicating or clearing the result uncertainty', async t => {
  const { repo, base, logs } = await fixture(t);
  repo.execute({ id: 'opening-before-pending', revision: 0, command: opening() });
  const pending = {
    id: 'committed-pending-movement', revision: 1,
    command: { type: 'movement', date: '2026-10-27', accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '10', note: 'Synthetic committed pending command' }
  };
  const first = await fetch(`${base}/command?workspace=demo`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pending)
  });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).duplicate, false);
  insertRaw(repo, JSON.stringify(damagedEvent()));
  const before = rawSnapshot(repo);
  const response = await fetch(`${base}/command?workspace=demo`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pending)
  });
  assert.equal(response.status, 500, 'The UI preserves the pending request for 5xx instead of clearing it as a rejected input.');
  assert.doesNotMatch(await response.text(), /private-ledger|opening|Stored|zaten|başlangıç/i);
  assert.equal(repo.db.prepare('SELECT count(*) AS count FROM events WHERE id=?').get(pending.id).count, 1);
  assert.deepEqual(rawSnapshot(repo), before);
  assert.deepEqual(logs, [{ event: 'request_failed', operation: 'command', workspace: 'demo', code: 'STORED_HISTORY_INVALID' }]);
  assert.deepEqual(repo.recoveryInfo(), { workspace: 'demo', revision: 2, canRestore: true });
});
