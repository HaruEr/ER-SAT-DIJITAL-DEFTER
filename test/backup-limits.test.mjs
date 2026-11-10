import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { authenticateTestOwner, renewTestOwner, ownerFetch as fetch } from '../test-support/editor-session.mjs';
import { Repository, BACKUP_MAX_BYTES } from '../repository.mjs';
import { DomainError, INITIAL_ACCOUNTS, replay } from '../domain.mjs';

function history(count, padded = false) {
  const balances = Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, '0']));
  const events = [{ id: 'opening', schemaVersion: 3, timestamp: '2026-10-27T10:00:00Z', command: { type: 'opening', date: '2026-10-27', balances } }];
  for (let i = 1; i < count; i++) events.push({
    id: padded ? `movement-${i}`.padEnd(100, 'x') : `movement-${i}`,
    schemaVersion: 3,
    timestamp: '2026-10-27T10:00:00Z',
    command: { type: 'movement', date: '2026-10-27', accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '0.01', note: padded ? 'a'.repeat(160) : 'Synthetic backup boundary' }
  });
  assert.equal(replay(events).balances.nakit, count - 1);
  return events;
}

function seededRepository(events) {
  const repository = new Repository(':memory:', 'demo');
  repository.db.exec('BEGIN');
  const insert = repository.db.prepare('INSERT INTO events(id,body) VALUES(?,?)');
  for (const event of events) insert.run(event.id, JSON.stringify(event));
  repository.db.exec('COMMIT');
  return repository;
}

test('an exported valid JSON backup larger than 8 MiB can be restored through HTTP', async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'defter-backup-boundary-'));
  const { server, repositories } = createApp({ dataDirectory });
  const repository = seededRepository(history(22001, true));
  repositories.set('demo', repository);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await authenticateTestOwner(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const downloaded = await fetch(`${base}/api/backup?workspace=demo`);
    assert.equal(downloaded.status, 200);
    const content = await downloaded.text();
    assert.ok(Buffer.byteLength(content) > 8 * 1024 * 1024);
    const backup = JSON.parse(content);
    const response = await fetch(`${base}/api/restore?workspace=demo`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backup, revision: 0, confirmation: 'GERİ YÜKLE' })
    });
    assert.equal(response.status, 200, await response.text());
    assert.equal(repository.state().revision, 1);
    assert.equal(repository.state().balances.nakit, 22000);
    assert.deepEqual(repository.events(), backup.events);
    assert.equal(repository.db.prepare('SELECT count(*) AS count FROM restore_archive').get().count, 1);
    await renewTestOwner(base);
    const oversizedCommand = await fetch(`${base}/api/command?workspace=demo`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'oversized-command', revision: 1, command: { type: 'movement', note: 'x'.repeat(8 * 1024 * 1024) } })
    });
    assert.equal(oversizedCommand.status, 413);
    await oversizedCommand.text();
    assert.equal(repository.state().revision, 1);
  } finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test('an exported valid history above 50,000 events retains every event on restore', () => {
  const source = seededRepository(history(50001));
  const target = new Repository(':memory:', 'demo');
  try {
    const backup = source.backup();
    const restored = target.restore({ backup, revision: 0, confirmation: 'GERİ YÜKLE' });
    assert.equal(restored.journal.length, 50001);
    assert.equal(restored.balances.nakit, 50000);
    assert.deepEqual(target.events(), backup.events);
  } finally { source.close(); target.close(); }
});

test('a backup above the supported 64 MiB limit is rejected before restore changes active records', () => {
  const target = seededRepository(history(2));
  try {
    const before = target.state();
    const backup = { ...target.backup(), padding: '' };
    backup.padding = 'x'.repeat(BACKUP_MAX_BYTES + 1 - Buffer.byteLength(JSON.stringify(backup)));
    assert.equal(Buffer.byteLength(JSON.stringify(backup)), BACKUP_MAX_BYTES + 1);
    assert.throws(() => target.restore({ backup, revision: 0, confirmation: 'GERİ YÜKLE' }), error => error.code === 'BACKUP_TOO_LARGE' && error.status === 413 && /64 MiB/.test(error.message));
    assert.deepEqual(target.state(), before);
    assert.equal(target.db.prepare('SELECT count(*) AS count FROM restore_archive').get().count, 0);
  } finally { target.close(); }
});

test('a JSON backup exactly at 64 MiB exports and restores without a boundary off-by-one', () => {
  const source = seededRepository(history(1));
  const target = new Repository(':memory:', 'demo');
  const event = { ...source.events()[0], padding: '' };
  const shape = { ...source.backup(), events: [event] };
  event.padding = 'x'.repeat(BACKUP_MAX_BYTES - Buffer.byteLength(JSON.stringify(shape)));
  source.events = () => [event];
  try {
    const backup = source.backup();
    assert.equal(Buffer.byteLength(JSON.stringify(backup)), BACKUP_MAX_BYTES);
    const restored = target.restore({ backup, revision: 0, confirmation: 'GERİ YÜKLE' });
    assert.equal(restored.revision, 1);
    assert.equal(restored.journal.length, 1);
    assert.equal(target.events()[0].padding.length, event.padding.length);
  } finally { source.close(); target.close(); }
});

test('export refuses an unsupported oversized history rather than producing an unrestorable success', () => {
  const source = seededRepository(history(1));
  const before = source.state();
  const originalEvents = source.events.bind(source);
  try {
    // Exercise export sizing without storing a 64 MiB synthetic unknown field in SQLite.
    source.events = () => [{ ...originalEvents()[0], padding: 'x'.repeat(64 * 1024 * 1024) }];
    assert.throws(() => source.backup(), /64 MiB/);
  } finally {
    source.events = originalEvents;
    assert.deepEqual(source.state(), before);
    source.close();
  }
});

test('closing above the backup limit reports durable closing and an actionable size limitation separately', async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'defter-closing-backup-limit-'));
  const { server, repositories } = createApp({ dataDirectory });
  const repository = seededRepository(history(1));
  repositories.set('demo', repository);
  repository.backup = () => { throw new DomainError('Boyut sınırı aşıldı.', { status: 413, code: 'BACKUP_TOO_LARGE' }); };
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await authenticateTestOwner(server);
  try {
    const state = repository.state();
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/command?workspace=demo`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'closing-limit', revision: 0, command: {
        type: 'close', date: state.date, approvedBy: 'Synthetic test', reasons: {},
        counts: Object.fromEntries(state.accounts.filter(a => a.physical && !a.retired && a.countPolicy === 'daily').map(a => [a.id, '0']))
      } })
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.state.date, '2026-10-28');
    assert.equal(repository.state().revision, 1);
    assert.equal(result.backupStatus.saved, false);
    assert.match(result.backupStatus.error, /64 MiB/);
    assert.match(result.backupStatus.error, /kurtarma desteği/);
    assert.doesNotMatch(result.backupStatus.error, /Yedek indir/);
  } finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test('export rejects a semantically invalid stored history without changing its raw records or revision', () => {
  const events = history(1);
  events[0].command.balances.nakit = '-1';
  const repository = seededRepository(events);
  try {
    const before = repository.events();
    const revision = repository.db.prepare('SELECT revision FROM meta WHERE id=1').get().revision;
    assert.throws(() => repository.backup());
    assert.deepEqual(repository.events(), before);
    assert.equal(repository.db.prepare('SELECT revision FROM meta WHERE id=1').get().revision, revision);
    assert.equal(repository.db.prepare('SELECT count(*) AS count FROM restore_archive').get().count, 0);
  } finally { repository.close(); }
});

test('HTTP export never reports success for a semantically invalid stored history', async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'defter-invalid-backup-'));
  const { server, repositories } = createApp({ dataDirectory, logger: () => {} });
  const events = history(1);
  events[0].command.balances.nakit = '-1';
  const repository = seededRepository(events);
  repositories.set('demo', repository);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await authenticateTestOwner(server);
  try {
    const before = repository.events();
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/backup?workspace=demo`);
    const content = await response.text();
    assert.equal(response.status, 500);
    assert.doesNotMatch(content, /ondalık|açılış|miktar|Nakit TL/);
    assert.deepEqual(repository.events(), before);
    assert.equal(repository.db.prepare('SELECT revision FROM meta WHERE id=1').get().revision, 0);
    assert.equal(repository.db.prepare('SELECT count(*) AS count FROM restore_archive').get().count, 0);
  } finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test('a valid backup can recover a semantically damaged active history while archiving it intact', () => {
  const invalid = history(1);
  invalid[0].command.balances.nakit = '-1';
  const damaged = seededRepository(invalid);
  const source = seededRepository(history(3));
  try {
    const backup = source.backup();
    const recovered = damaged.restore({ backup, revision: 0, confirmation: 'GERİ YÜKLE' });
    assert.equal(recovered.revision, 1);
    assert.equal(recovered.balances.nakit, 2);
    assert.deepEqual(damaged.events(), backup.events);
    const archive = damaged.db.prepare('SELECT body FROM restore_archive').all();
    assert.equal(archive.length, 1);
    assert.deepEqual(JSON.parse(archive[0].body).events, invalid);
  } finally { damaged.close(); source.close(); }
});
