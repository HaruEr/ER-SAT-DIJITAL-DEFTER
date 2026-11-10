import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createApp } from '../server.mjs';
import { authenticateTestOwner, renewTestOwner, ownerFetch as fetch } from '../test-support/editor-session.mjs';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS, decimal } from '../domain.mjs';

const opening = () => ({ type: 'opening', date: '2026-10-27', balances: Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, '0'])) });
function movement(date, note = 'İşlem örneği') { return { type: 'movement', date, accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '1', note }; }
function make(t, options) { const repo = new Repository(':memory:', 'demo', options); t.after(() => repo.close()); repo.execute({ id: 'opening', revision: 0, command: opening() }); return repo; }
function execute(repo, id, command) { return repo.execute({ id, revision: repo.state().revision, command }); }
function raw(repo) { return { events: repo.events(), revision: repo.db.prepare('SELECT revision FROM meta WHERE id=1').get().revision }; }

test('one budgeted cache entry serves repeat reads without exposing mutable owned state', t => {
  const repo = make(t); execute(repo, 'move', movement('2026-10-27'));
  const full = repo.state(), expected = structuredClone(full), before = repo.cacheInfo();
  full.accounts[0].name = 'caller mutation'; full.balances.nakit = 999999; full.journal[0].entries[0].delta = 999999; full.journal.push({});
  const events = repo.events.bind(repo); repo.events = () => assert.fail('A warm cache must not read and replay all stored events.');
  try {
    assert.deepEqual(repo.state(), expected);
    assert.equal(repo.state({ compact: true }).view, 'compact');
    const after = repo.cacheInfo(); assert.equal(after.entries, 1); assert.ok(after.hits >= before.hits + 2);
    assert.ok(after.estimatedBytes > 0 && after.estimatedBytes <= after.maxBytes); assert.equal(after.maxBytes, 64 * 1024 * 1024);
  } finally { repo.events = events; }
});

test('over-budget state remains correct without retaining an oversized cache entry', t => {
  const repo = make(t, { cacheMaxBytes: 1 });
  assert.equal(repo.state().initialized, true);
  const before = repo.cacheInfo(); assert.equal(before.entries, 0); assert.equal(before.estimatedBytes, 0);
  repo.state(); assert.ok(repo.cacheInfo().misses > before.misses); assert.equal(repo.cacheInfo().entries, 0);
});

test('same-connection data and schema changes invalidate warm snapshots instead of hiding corruption', t => {
  const repo = make(t); repo.state();
  const event = repo.events()[0]; event.command.balances.nakit = '-1';
  repo.db.prepare('UPDATE events SET body=? WHERE id=?').run(JSON.stringify(event), event.id);
  assert.throws(() => repo.state(), error => error.code === 'STORED_HISTORY_INVALID');
  assert.equal(repo.cacheInfo().entries, 0);
  event.command.balances.nakit = '0'; repo.db.prepare('UPDATE events SET body=? WHERE id=?').run(JSON.stringify(event), event.id);
  repo.state(); repo.db.exec('DROP TABLE events');
  assert.throws(() => repo.state(), error => error.code === 'ERR_SQLITE_ERROR');
});

test('external commits and externally rolled-back transactions cannot leave stale cache results', () => {
  const root = resolve(tmpdir()), directory = mkdtempSync(join(root, 'defter-cache-')), filename = join(directory, 'synthetic.sqlite');
  const first = new Repository(filename, 'demo'), second = new Repository(filename, 'demo');
  try {
    first.execute({ id: 'opening', revision: 0, command: opening() }); first.state();
    second.execute({ id: 'external', revision: 1, command: movement('2026-10-27') });
    assert.equal(first.state().balances.nakit, 100);
    first.db.exec('BEGIN');
    const changed = first.events()[0]; changed.command.balances.nakit = '10';
    first.db.prepare('UPDATE events SET body=? WHERE id=?').run(JSON.stringify(changed), changed.id);
    assert.equal(first.state().balances.nakit, 1100);
    first.db.exec('ROLLBACK');
    assert.equal(first.state().balances.nakit, 100);
  } finally { first.close(); second.close(); assert.equal(dirname(resolve(directory)), root); rmSync(directory, { recursive: true, force: true }); }
});

test('failed live application and SQL insertion evict mutated work state and retain 400 validation behavior', t => {
  const repo = make(t), before = repo.state();
  assert.throws(() => repo.execute({ id: 'bad-fund', revision: 1, command: { type: 'fundAccount', date: before.date, name: 'Rejected fund', unit: 'USD', physical: true, opening: '-1' } }), error => error.status === 400);
  assert.deepEqual(repo.state(), before);
  repo.db.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'Synthetic insertion failure'); END");
  assert.throws(() => repo.execute({ id: 'rejected', revision: 1, command: movement(before.date) }));
  repo.db.exec('DROP TRIGGER fail_insert'); assert.deepEqual(repo.state(), before);
});

test('compact projection retains all closing and stocktake history and only the latest four journal items', t => {
  const repo = make(t);
  for (let day = 0; day < 5; day++) {
    const state = repo.state();
    execute(repo, `stocktake-${day}`, { type: 'stocktake', date: state.date, counts: { bilezik22: '0' }, reasons: {}, approvedBy: 'Synthetic test' });
    execute(repo, `close-${day}`, { type: 'close', date: state.date, counts: Object.fromEntries(state.accounts.filter(a => a.physical && !a.retired && a.countPolicy === 'daily').map(a => [a.id, decimal(state.balances[a.id] || 0, a.unit)])), reasons: {}, approvedBy: 'Synthetic test' });
  }
  const full = repo.state(), compact = repo.state({ compact: true });
  assert.equal(compact.view, 'compact'); assert.deepEqual(compact.journal, full.journal.slice(-4));
  assert.deepEqual(compact.closings, full.closings); assert.equal(compact.closings.length, 5);
  assert.deepEqual(compact.stocktakes, full.stocktakes); assert.equal(compact.stocktakes.length, 5);
  assert.deepEqual(compact.accounts, full.accounts); assert.deepEqual(compact.balances, full.balances);
  assert.deepEqual(compact.overview, { todaysCount: 0, revenue: 0, expenses: 0, salesCash: 0, closingCount: 5 });
  assert.deepEqual(compact.journalMeta, { total: full.journal.length, totalEntries: full.journal.reduce((sum, entry) => sum + entry.entries.length, 0) });
});

test('compact live commands clone only their projected journal and keep aggregate totals exact', t => {
  const repo = make(t); for (let index = 0; index < 20; index++) execute(repo, `move-${index}`, movement('2026-10-27'));
  const clone = globalThis.structuredClone;
  globalThis.structuredClone = value => { if (value?.journal) assert.ok(value.journal.length <= 4, 'Compact responses must not deep-clone the entire journal.'); return clone(value); };
  let result;
  try { result = repo.execute({ id: 'final', revision: 21, command: movement('2026-10-27') }, { compact: true }); }
  finally { globalThis.structuredClone = clone; }
  assert.equal(result.state.view, 'compact'); assert.equal(result.state.journal.length, 4);
  assert.equal(result.state.overview.todaysCount, 22); assert.equal(result.state.journalMeta.total, 22);
  assert.equal(result.state.balances.nakit, 2100);
});

test('compact overview preserves sale cash, expenses and next-day reversal signs', t => {
  const repo = new Repository(':memory:', 'demo'); t.after(() => repo.close());
  const start = opening(); Object.assign(start.balances, { nakit: '1000', bilezikAdet: '10', bilezik22: '200' });
  repo.execute({ id: 'opening', revision: 0, command: start });
  execute(repo, 'customer', { type: 'account', date: start.date, name: 'Synthetic customer', unit: 'TL', opening: '0' });
  execute(repo, 'sale', { type: 'sale', date: start.date, items: [{ accountId: 'bilezikAdet', quantity: '1', weightAccount: 'bilezik22', weight: '20', value: '1000' }], cash: '600', pos: '300', bank: '0', scrapQuantity: '0', scrapValue: '0', customerAccount: 'cari-customer', note: 'Synthetic sale' });
  execute(repo, 'expense', { type: 'movement', date: start.date, accountId: 'nakit', direction: 'out', category: 'Gider', quantity: '5', note: 'Synthetic expense' });
  assert.deepEqual(repo.state({ compact: true }).overview, { todaysCount: 4, revenue: 100000, expenses: 500, salesCash: 60000, closingCount: 0 });
  const beforeClose = repo.state();
  execute(repo, 'close', { type: 'close', date: beforeClose.date, counts: Object.fromEntries(beforeClose.accounts.filter(a => a.physical && !a.retired && a.countPolicy === 'daily').map(a => [a.id, decimal(beforeClose.balances[a.id] || 0, a.unit)])), reasons: {}, approvedBy: 'Synthetic test' });
  execute(repo, 'reverse-sale', { type: 'reverse', date: repo.state().date, originalId: 'sale', note: 'Synthetic next-day reversal' });
  assert.deepEqual(repo.state({ compact: true }).overview, { todaysCount: 1, revenue: -100000, expenses: 0, salesCash: -60000, closingCount: 1 });
  assert.equal(repo.state({ compact: true }).balances.nakit, 99500);
});

test('journal pagination is revision and filter bound and marks reversed originals beyond the current page', t => {
  const repo = make(t); execute(repo, 'first', movement('2026-10-27', 'İşlem bir')); execute(repo, 'second', movement('2026-10-27', 'İşlem iki'));
  execute(repo, 'reverse-first', { type: 'reverse', date: '2026-10-27', originalId: 'first', note: 'Synthetic reversal' });
  const first = repo.journalPage({ scope: 'all', limit: 1 });
  assert.equal(first.items[0].id, 'reverse-first'); assert.equal(first.total, 4); assert.equal(first.items.length, 1);
  const second = repo.journalPage({ scope: 'all', limit: 1, cursor: first.nextCursor });
  const third = repo.journalPage({ scope: 'all', limit: 1, cursor: second.nextCursor });
  assert.equal(third.items[0].id, 'first'); assert.deepEqual(third.reversedIds, ['first']);
  const filtered = repo.journalPage({ scope: 'all', q: 'işlem', type: 'movement', limit: 100 });
  assert.deepEqual(filtered.items.map(entry => entry.id), ['second', 'first']); assert.equal(filtered.totalEntries, 2);
  assert.throws(() => repo.journalPage({ scope: 'all', q: 'changed', limit: 1, cursor: first.nextCursor }), error => error.status === 409);
  assert.throws(() => repo.journalPage({ scope: 'all', limit: 101 }), error => error.status === 400);
  assert.throws(() => repo.journalPage({ scope: 'all', cursor: 'not-a-cursor' }), error => error.status === 400);
  execute(repo, 'later', movement('2026-10-27'));
  assert.throws(() => repo.journalPage({ scope: 'all', limit: 1, cursor: first.nextCursor }), error => error.status === 409);
});

test('server journal search preserves Turkish accent folding plus date and legacy category search', t => {
  const repo = make(t);
  execute(repo, 'stock', { type: 'stock', date: '2026-10-27', direction: 'in', category: 'Stok girişi', items: [{ accountId: 'ceyrek', quantity: '2' }], note: 'Preparation' });
  execute(repo, 'istanbul', movement('2026-10-27', 'İstanbul çeyrek'));
  const legacy = { id: 'legacy-category', timestamp: '2026-10-27T10:00:00Z', command: { type: 'sale', date: '2026-10-27', outAccount: 'ceyrek', outQuantity: '1', total: '10', cash: '10', pos: '0', bank: '0', scrapQuantity: '0', scrapValue: '0', productCategory: 'Özel tahlil kategorisi', note: 'Legacy example' } };
  repo.db.prepare('INSERT INTO events(id,body) VALUES(?,?)').run(legacy.id, JSON.stringify(legacy)); repo.db.exec('UPDATE meta SET revision=revision+1 WHERE id=1');
  for (const q of ['ISTANBUL', 'İstanbul']) assert.equal(repo.journalPage({ scope: 'all', q }).items[0].id, 'istanbul');
  for (const q of ['ceyrek', 'çeyrek']) assert.ok(repo.journalPage({ scope: 'all', q }).items.some(entry => entry.id === 'istanbul'));
  assert.equal(repo.journalPage({ scope: 'all', q: '2026-10-27' }).total, 4);
  assert.deepEqual(repo.journalPage({ scope: 'all', q: 'ozel tahlil kategorisi' }).items.map(entry => entry.id), ['legacy-category']);
});

test('compact state, command and JSON restore HTTP views are opt-in while the legacy shape remains unchanged', async t => {
  const root = resolve(tmpdir()), dataDirectory = mkdtempSync(join(root, 'defter-view-http-'));
  const { server, repositories } = createApp({ dataDirectory, logger: () => {} });
  const repo = new Repository(':memory:', 'demo'); repositories.set('demo', repo); repo.execute({ id: 'opening', revision: 0, command: opening() });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await authenticateTestOwner(server);
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); assert.equal(dirname(resolve(dataDirectory)), root); rmSync(dataDirectory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const legacy = await (await fetch(`${base}/state?workspace=demo`)).json(); assert.equal(legacy.view, undefined);
  const compact = await (await fetch(`${base}/state?workspace=demo&view=compact`)).json(); assert.equal(compact.view, 'compact');
  const sent = await fetch(`${base}/command?workspace=demo&view=compact`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'posted', revision: 1, command: movement('2026-10-27') }) });
  assert.equal(sent.status, 200); assert.equal((await sent.json()).state.view, 'compact');
  const backup = repo.backup();
  const restored = await fetch(`${base}/restore?workspace=demo&view=compact`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ backup, revision: 2, confirmation: 'GERİ YÜKLE' }) });
  assert.equal(restored.status, 200); assert.equal((await restored.json()).state.view, 'compact');
  await renewTestOwner(base);
  const page = await fetch(`${base}/journal?workspace=demo&scope=all&limit=1`); assert.equal(page.status, 200);
  assert.equal((await page.json()).items.length, 1);
  assert.equal((await fetch(`${base}/journal?workspace=demo&limit=101`)).status, 400);
  assert.deepEqual(await (await fetch(`${base}/state?workspace=demo`)).json(), repo.state());
});
