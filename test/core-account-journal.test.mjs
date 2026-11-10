import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Repository } from '../repository.mjs';
import { createApp } from '../server.mjs';
import { authenticateTestOwner, ownerFetch as fetch } from '../test-support/editor-session.mjs';
import { INITIAL_ACCOUNTS, decimal } from '../domain.mjs';

function fixture(t, { serverOwned = false } = {}) {
  const repo = new Repository(':memory:', 'demo'); if (!serverOwned) t.after(() => repo.close());
  const execute = (id, command) => repo.execute({ id, revision: repo.state().revision, command });
  const close = id => { const s = repo.state(); execute(id, { type: 'close', date: s.date, counts: Object.fromEntries(s.accounts.filter(a => a.physical && !a.retired && a.countPolicy === 'daily').map(a => [a.id, decimal(s.balances[a.id] || 0, a.unit)])), reasons: {}, approvedBy: 'Synthetic count' }); };
  execute('opening', { type: 'opening', date: '2026-10-27', balances: Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, ({ nakit: '1000', bilezikAdet: '10', bilezik22: '200' })[a.id] || '0'])) });
  execute('customer', { type: 'account', date: '2026-10-27', name: 'Synthetic customer', unit: 'TL', opening: '0' });
  execute('usd-customer', { type: 'account', date: '2026-10-27', name: 'Synthetic customer', unit: 'USD', opening: '17.25' });
  execute('sale', { type: 'sale', date: '2026-10-27', items: [{ accountId: 'bilezikAdet', quantity: '1', weightAccount: 'bilezik22', weight: '20', value: '200' }], cash: '100', pos: '0', bank: '0', scrapQuantity: '0', scrapValue: '0', customerAccount: 'cari-customer', note: 'Synthetic sale' });
  close('close-first');
  execute('collection', { type: 'collection', date: '2026-10-28', customerAccount: 'cari-customer', target: 'nakit', direction: 'collect', quantity: '50', note: 'Synthetic collection' });
  execute('capital', { type: 'movement', date: '2026-10-28', accountId: 'nakit', category: 'Sermaye', direction: 'in', quantity: '10', note: 'Synthetic capital' });
  execute('measurement', { type: 'stocktake', date: '2026-10-28', counts: { bilezik22: '190' }, reasons: { bilezik22: 'Synthetic physical difference' }, approvedBy: 'Synthetic count' });
  close('close-second');
  execute('reverse', { type: 'reverse', date: '2026-10-29', originalId: 'sale', note: 'Synthetic later reversal' });
  return repo;
}

test('journal date/account filters intersect scope and keep complete linked events and global reversal markers', t => {
  const repo = fixture(t), before = repo.state();
  const page = repo.journalPage({ scope: 'all', startDate: '2026-10-27', endDate: '2026-10-27', accountId: 'cari-customer' });
  assert.deepEqual(page.items.map(x => x.id), ['sale', 'customer']);
  assert.equal(page.total, 2); assert.equal(page.totalEntries, 5);
  assert.deepEqual(page.reversedIds, ['sale']);
  assert.equal(page.items[0].entries.length, 4, 'Account selection must retain all linked event legs.');
  assert.equal(repo.journalPage({ scope: 'today', startDate: '2026-10-27', endDate: '2026-10-28' }).total, 0);
  assert.equal(repo.journalPage({ scope: 'all', startDate: '2026-10-28', endDate: '2026-10-28', accountId: 'nakit', q: 'SYNTHETIC', type: 'collection' }).total, 1);
  assert.deepEqual(repo.journalPage({ scope: 'all', accountId: 'gramAdet' }).items.map(x => x.id), ['opening'], 'Retired accounts remain valid history filters, including explicit zero opening legs.');
  assert.deepEqual(repo.state(), before);
});

test('journal rejects invalid real dates, reversed intervals and unknown account ids', t => {
  const repo = fixture(t);
  for (const options of [{ startDate: '2026-02-30' }, { endDate: '2026-13-01' }, { startDate: '2026-1-01' }, { endDate: '2026-10-28junk' }, { startDate: 42 }, { endDate: null }, { startDate: '2026-10-29', endDate: '2026-10-28' }, { accountId: 'missing' }, { accountId: ['nakit'] }]) {
    assert.throws(() => repo.journalPage({ scope: 'all', ...options }), e => e.status === 400);
  }
  assert.deepEqual(repo.journalPage({ scope: 'all', startDate: '', endDate: '', accountId: '' }), repo.journalPage({ scope: 'all' }));
});

test('journal cursors bind date/account filters while old unfiltered cursor hashes stay compatible', t => {
  const repo = fixture(t), options = { scope: 'all', startDate: '2026-10-27', endDate: '2026-10-29', accountId: 'nakit', limit: 1 };
  const first = repo.journalPage(options); assert.ok(first.nextCursor);
  const second = repo.journalPage({ ...options, cursor: first.nextCursor }); assert.notEqual(first.items[0].id, second.items[0].id);
  for (const changes of [{ startDate: '2026-10-28' }, { endDate: '2026-10-28' }, { accountId: 'cari-customer' }, { accountId: '' }]) {
    assert.throws(() => repo.journalPage({ ...options, ...changes, cursor: first.nextCursor }), e => e.status === 409);
  }
  const oldHash = createHash('sha256').update(JSON.stringify({ scope: 'all', q: '', type: 'all', limit: 1 })).digest('hex');
  const cursor = Buffer.from(JSON.stringify({ revision: repo.state().revision, offset: 1, filterHash: oldHash })).toString('base64url');
  assert.equal(repo.journalPage({ scope: 'all', limit: 1, cursor }).items[0].id, 'close-second');
});

test('account statement uses full selected history in native units and includes opening before the period', t => {
  const repo = fixture(t), before = repo.state();
  const statement = repo.accountStatement({ accountId: 'nakit', startDate: '2026-10-28', endDate: '2026-10-28' });
  assert.equal(statement.account.unit, 'TL'); assert.equal(statement.revision, before.revision);
  assert.deepEqual([statement.opening, statement.incoming, statement.outgoing, statement.closing], [110000, 6000, 0, 116000]);
  assert.equal(statement.startDate, '2026-10-28'); assert.equal(statement.endDate, '2026-10-28');
  const receivable = repo.accountStatement({ accountId: 'cari-customer', startDate: '2026-10-28' });
  assert.deepEqual([receivable.opening, receivable.incoming, receivable.outgoing, receivable.closing], [10000, 0, 15000, -5000]);
  const dollars = repo.accountStatement({ accountId: 'cari-usd-customer' });
  assert.equal(dollars.account.unit, 'USD'); assert.equal(dollars.closing, 1725);
  assert.equal(dollars.lastPhysicalCount, null);
  assert.deepEqual(repo.state(), before);
});

test('account statements distinguish actual measurement from carried gram balances and preserve historical period end', t => {
  const repo = fixture(t);
  const beforeMeasurement = repo.accountStatement({ accountId: 'bilezik22', endDate: '2026-10-27' });
  assert.equal(beforeMeasurement.closing, 180000); assert.equal(beforeMeasurement.lastPhysicalCount, null);
  const measured = repo.accountStatement({ accountId: 'bilezik22', endDate: '2026-10-28' });
  assert.equal(measured.closing, 190000);
  assert.deepEqual(measured.lastPhysicalCount, { eventId: 'measurement', date: '2026-10-28', type: 'stocktake', unit: 'GRAM', counted: 190000, expected: 180000, difference: 10000 });
  const daily = repo.accountStatement({ accountId: 'bilezikAdet', endDate: '2026-10-28' });
  assert.equal(daily.lastPhysicalCount.eventId, 'close-second'); assert.equal(daily.lastPhysicalCount.counted, 9);
  const future = repo.accountStatement({ accountId: 'nakit', startDate: '2027-01-01', endDate: '2027-12-31' });
  assert.deepEqual([future.opening, future.incoming, future.outgoing, future.closing], [106000, 0, 0, 106000]);
  assert.equal(repo.accountStatement({ accountId: 'gramAdet' }).account.retired, true);
});

test('statement validates filters and returns independent data without exposing mutable cached state', t => {
  const repo = fixture(t);
  for (const options of [{}, { accountId: '' }, { accountId: 'missing' }, { accountId: 'nakit', startDate: '2026-02-30' }, { accountId: 'nakit', startDate: '2027-01-01', endDate: '2026-01-01' }]) assert.throws(() => repo.accountStatement(options), e => e.status === 400);
  const value = repo.accountStatement({ accountId: 'bilezik22' }); value.account.name = 'Caller mutation'; value.lastPhysicalCount.counted = 0;
  const fresh = repo.accountStatement({ accountId: 'bilezik22' }); assert.notEqual(fresh.account.name, 'Caller mutation'); assert.equal(fresh.lastPhysicalCount.counted, 190000);
  assert.equal(repo.accountStatement({ accountId: 'nakit', endDate: '2020-01-01' }).closing, 0);
  const events = repo.events.bind(repo); repo.events = () => assert.fail('Warm statement reads must reuse the owned full ledger, without rereading events.');
  try { assert.equal(repo.accountStatement({ accountId: 'nakit' }).closing, 106000); }
  finally { repo.events = events; }
});

test('local HTTP journal/statement endpoints validate filters, retain read boundaries and do not mutate the ledger', async t => {
  const root = resolve(tmpdir()), directory = mkdtempSync(join(root, 'defter-account-api-'));
  const { server, repositories } = createApp({ dataDirectory: directory, logger: () => {} });
  const repo = fixture(t, { serverOwned: true }); repositories.set('demo', repo); const before = repo.state();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await authenticateTestOwner(server);
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); assert.equal(dirname(resolve(directory)), root); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const journal = await fetch(`${base}/journal?scope=all&accountId=nakit&startDate=2026-10-28&endDate=2026-10-28`);
  assert.equal(journal.status, 200); assert.deepEqual((await journal.json()).items.map(x => x.id), ['capital', 'collection']);
  const response = await fetch(`${base}/account-statement?accountId=nakit&startDate=2026-10-28&endDate=2026-10-28`);
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal((await response.json()).closing, 116000);
  for (const query of ['accountId=missing', 'accountId=nakit&startDate=2026-02-30', 'accountId=nakit&startDate=2026-10-29&endDate=2026-10-28', '']) assert.equal((await fetch(`${base}/account-statement?${query}`)).status, 400);
  assert.equal((await fetch(`${base}/journal?accountId=missing`)).status, 400);
  assert.equal((await fetch(`${base}/journal?endDate=2026-02-30`)).status, 400);
  assert.equal((await fetch(`${base}/account-statement?accountId=nakit`, { headers: { Origin: 'https://foreign.example' } })).status, 403);
  assert.equal((await fetch(`${base}/account-statement?accountId=nakit`, { headers: { 'Tailscale-User-Login': 'synthetic@example.test' } })).status, 403);
  assert.equal((await fetch(`${base}/account-statement?accountId=nakit`, { method: 'POST' })).status, 404);
  assert.deepEqual(repo.state(), before);
});
