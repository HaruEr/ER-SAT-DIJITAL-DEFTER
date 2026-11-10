import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadStream, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { Repository } from '../repository.mjs';
import { ARCHIVE_MAX_EVENTS, ARCHIVE_MAX_LINE_BYTES } from '../archive.mjs';
import { INITIAL_ACCOUNTS, replay } from '../domain.mjs';

const event = (id, command) => ({ id, schemaVersion: 3, timestamp: '2026-10-27T10:00:00Z', command });
const opening = () => event('opening', { type: 'opening', date: '2026-10-27', balances: Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, '0'])) });
const movement = index => event(`movement-${index}`, { type: 'movement', date: '2026-10-27', accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '0.01', note: 'İşlem ⚖️ 💍 Türkçe' });
function fixture(t) {
  const root = resolve(tmpdir()), directory = mkdtempSync(join(root, 'defter-archive-')), repos = [];
  t.after(() => { for (const repo of repos) repo.close(); assert.equal(dirname(resolve(directory)), root); rmSync(directory, { recursive: true, force: true }); });
  return { directory, repo(name) { const repo = new Repository(join(directory, `${name}.sqlite`), 'demo'); repos.push(repo); return repo; } };
}
function seed(repo, events) {
  repo.db.exec('BEGIN'); const insert = repo.db.prepare('INSERT INTO events(id,body) VALUES(?,?)');
  for (const row of events) insert.run(row.id, JSON.stringify(row));
  repo.db.exec('UPDATE meta SET revision=1 WHERE id=1; COMMIT');
}
function snapshot(repo) {
  return { events: repo.db.prepare('SELECT * FROM events ORDER BY seq').all(), meta: repo.db.prepare('SELECT * FROM meta').all(), archive: repo.db.prepare('SELECT * FROM restore_archive').all() };
}
const options = directory => ({ revision: 1, confirmation: 'GERİ YÜKLE', temporaryDirectory: directory });

test('UTF-8 survives arbitrary chunk boundaries and invalid byte sequences fail before active writes', async t => {
  const { directory, repo } = fixture(t), source = repo('source'), target = repo('target');
  seed(source, [opening(), movement(1)]); seed(target, [opening()]);
  const filename = join(directory, 'unicode.ndjson'); source.exportArchive(filename);
  const content = readFileSync(filename);
  async function* bytes() { for (const byte of content) yield Buffer.from([byte]); }
  await target.restoreArchive(bytes(), options(directory));
  assert.equal(target.state().journal.at(-1).meta.note, 'İşlem ⚖️ 💍 Türkçe');
  const before = snapshot(target), bad = Buffer.from(content);
  bad[bad.indexOf(Buffer.from('İşlem'))] = 255;
  await assert.rejects(target.restoreArchive(Readable.from([bad]), { ...options(directory), revision: 2 }), error => error.code === 'ARCHIVE_INVALID');
  assert.deepEqual(snapshot(target), before);
  assert.deepEqual(readdirSync(directory).filter(name => name.startsWith('ledger-import-')), []);
});

test('source snapshots remain consistent across another connection commit and never overwrite an existing export', t => {
  const { directory, repo } = fixture(t), source = repo('source'); seed(source, [opening()]);
  const second = new Repository(join(directory, 'source.sqlite'), 'demo');
  const prepare = source.db.prepare.bind(source.db); let wrote = false;
  source.db.prepare = sql => {
    if (!wrote && sql === 'SELECT seq,id,body FROM events ORDER BY seq') {
      wrote = true;
      second.execute({ id: movement(1).id, revision: 1, command: movement(1).command });
    }
    return prepare(sql);
  };
  try {
    const filename = join(directory, 'snapshot.ndjson'), result = source.exportArchive(filename);
    assert.equal(result.revision, 1); assert.equal(result.eventCount, 1);
    assert.equal(source.state().revision, 2);
    const existing = join(directory, 'existing.ndjson'); writeFileSync(existing, 'existing backup must survive');
    assert.throws(() => source.exportArchive(existing), error => error.code === 'EEXIST');
    assert.equal(readFileSync(existing, 'utf8'), 'existing backup must survive');
  } finally { second.close(); }
});

test('interrupted input, archive write failure and later insert failure roll back every active change', async t => {
  const { directory, repo } = fixture(t), source = repo('source'), target = repo('target');
  seed(source, [opening(), movement(1)]); seed(target, [opening()]);
  const filename = join(directory, 'valid.ndjson'); source.exportArchive(filename);
  const content = readFileSync(filename), before = snapshot(target);
  async function* interrupted() { yield content.subarray(0, content.indexOf(10) + 1); throw Object.assign(new Error('Synthetic interrupted input'), { code: 'EIO' }); }
  await assert.rejects(target.restoreArchive(interrupted(), options(directory)), error => error.code === 'EIO');
  assert.deepEqual(snapshot(target), before);
  for (const [name, sql] of [
    ['archive_fault', "CREATE TRIGGER archive_fault BEFORE INSERT ON restore_archive BEGIN SELECT RAISE(ABORT,'Synthetic archive write failure'); END"],
    ['insert_fault', "CREATE TRIGGER insert_fault BEFORE INSERT ON events WHEN NEW.id='movement-1' BEGIN SELECT RAISE(ABORT,'Synthetic later insert failure'); END"]
  ]) {
    target.db.exec(sql);
    await assert.rejects(target.restoreArchive(createReadStream(filename), options(directory)));
    assert.deepEqual(snapshot(target), before);
    assert.equal(target.db.isTransaction, false);
    assert.equal(target.db.prepare('PRAGMA database_list').all().some(row => row.name === 'incoming_archive'), false);
    target.db.exec(`DROP TRIGGER ${name}`);
  }
  assert.deepEqual(readdirSync(directory).filter(name => name.startsWith('ledger-import-')), []);
});

test('event-line byte bounds reject oversized input and output without replacing or leaving partial archives', async t => {
  const { directory, repo } = fixture(t), source = repo('source'), target = repo('target');
  seed(source, [opening()]); seed(target, [opening()]);
  const valid = join(directory, 'valid.ndjson'); source.exportArchive(valid);
  const header = readFileSync(valid).subarray(0, readFileSync(valid).indexOf(10) + 1), before = snapshot(target);
  await assert.rejects(target.restoreArchive(Readable.from([header, Buffer.alloc(ARCHIVE_MAX_LINE_BYTES + 1, 120), Buffer.from('\n')]), options(directory)), error => error.code === 'ARCHIVE_TOO_LARGE' && error.status === 413);
  assert.deepEqual(snapshot(target), before);
  const large = movement(1); large.padding = 'x'.repeat(ARCHIVE_MAX_LINE_BYTES);
  source.db.prepare('INSERT INTO events(id,body) VALUES(?,?)').run(large.id, JSON.stringify(large));
  const unsupported = join(directory, 'unsupported.ndjson');
  assert.throws(() => source.exportArchive(unsupported), error => error.code === 'ARCHIVE_TOO_LARGE');
  assert.equal(existsSync(unsupported), false);
});

test('a real archive larger than 64 MiB restores with streamed input and a compact receipt', async t => {
  const { directory, repo } = fixture(t), source = repo('source'), target = repo('target');
  function* history() { yield opening(); for (let index = 1; index <= 1000; index++) yield { ...movement(index), padding: 'x'.repeat(70 * 1024) }; }
  seed(source, history()); seed(target, [opening()]);
  const beforeRss = process.memoryUsage().rss, filename = join(directory, 'large.ndjson');
  const exported = source.exportArchive(filename), bytes = statSync(filename).size;
  assert.ok(bytes > 64 * 1024 * 1024); assert.equal(exported.bytes, bytes);
  const receipt = await target.restoreArchive(createReadStream(filename), options(directory));
  const afterImportRss = process.memoryUsage().rss;
  assert.equal(receipt.restoredEvents, 1001); assert.equal(receipt.revision, 2);
  assert.ok(JSON.stringify(receipt).length < 200);
  function* persisted() { for (const row of target.db.prepare('SELECT body FROM events ORDER BY seq').iterate()) yield JSON.parse(row.body); }
  assert.equal(replay(persisted()).balances.nakit, 1000);
  assert.equal(target.db.prepare('SELECT count(*) AS count FROM events').get().count, 1001);
  assert.equal(JSON.parse(target.db.prepare('SELECT body FROM events WHERE id=?').get('movement-1000').body).padding.length, 70 * 1024);
  const archived = JSON.parse(target.db.prepare('SELECT body FROM restore_archive').get().body);
  assert.equal(archived.format, 'kuyumcu-raw-history-v1'); assert.equal(archived.records.length, 1);
  console.log(JSON.stringify({ syntheticArchiveBytes: bytes, events: receipt.restoredEvents, rssBeforeBytes: beforeRss, rssAfterImportBytes: afterImportRss, rssAfterVerificationBytes: process.memoryUsage().rss, observedProcessMaxRssKiB: process.resourceUsage().maxRSS }));
  // Reuse this real >64 MiB history to verify the old JSON path stops early.
  const readEvents = source.events.bind(source); let readCount = 0;
  source.events = options => {
    const rows = readEvents(options);
    if (!options?.stream) { readCount = rows.length; return rows; }
    return (function* () { for (const row of rows) { readCount++; yield row; } })();
  };
  try {
    assert.throws(() => source.backup(), error => error.status === 413 && error.code === 'BACKUP_TOO_LARGE');
    assert.ok(readCount < 1001, `Unsupported JSON export read all ${readCount} stored events.`);
    assert.equal(source.db.prepare('SELECT count(*) AS count FROM events').get().count, 1001);
    assert.equal(source.db.prepare('SELECT revision FROM meta WHERE id=1').get().revision, 1);
  } finally { source.events = readEvents; }
});

test('the explicit event-count ceiling rejects a streamed history before replacement', async t => {
  const { directory, repo } = fixture(t), target = repo('target'), source = repo('source');
  seed(target, [opening()]); seed(source, [opening()]);
  const filename = join(directory, 'header.ndjson'); source.exportArchive(filename);
  const content = readFileSync(filename), header = content.subarray(0, content.indexOf(10) + 1), before = snapshot(target);
  async function* tooMany() {
    yield header; yield Buffer.from(JSON.stringify({ type: 'event', event: opening() }) + '\n');
    for (let index = 1; index <= ARCHIVE_MAX_EVENTS; index++) yield Buffer.from(JSON.stringify({ type: 'event', event: movement(index) }) + '\n');
  }
  await assert.rejects(target.restoreArchive(tooMany(), options(directory)), error => error.code === 'ARCHIVE_TOO_LARGE');
  assert.deepEqual(snapshot(target), before);
  assert.deepEqual(readdirSync(directory).filter(name => name.startsWith('ledger-import-')), []);
});
