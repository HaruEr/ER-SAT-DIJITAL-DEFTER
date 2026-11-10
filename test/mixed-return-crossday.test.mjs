import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadStream, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Repository } from '../repository.mjs';
import { ReportRepository } from '../report-repository.mjs';
import { INITIAL_ACCOUNTS, currentCountPolicy, workdaySummary } from '../domain.mjs';

const saleDay = '2026-10-27', returnDay = '2026-10-28', customer = 'cari-buyer';
// Independently supplied financial oracle, in native scaled units. Do not
// derive these expected balances from replay or the implementation's entries.
const opening = { bilezikAdet: 10, bilezik22: 100000, ceyrek: 0, nakit: 1000000, [customer]: 0 };
const sold = { bilezikAdet: 8, bilezik22: 80000, ceyrek: 1, nakit: 990000, [customer]: 20000 };
const returned = { bilezikAdet: 9, bilezik22: 89000, ceyrek: 1, nakit: 950000, [customer]: 20000 };

function execute(repo, id, command) {
  return repo.execute({ id, revision: repo.state().revision, command });
}
function assertBalances(balances, expected) {
  for (const [id, value] of Object.entries(expected)) assert.equal(balances[id], value, id);
}
function assertHistory(repo, expected, currentSales) {
  const state = repo.state();
  assert.equal(state.date, returnDay);
  assertBalances(state.balances, expected);
  const previous = workdaySummary(state, saleDay), current = workdaySummary(state, returnDay);
  assert.equal(previous.totals.sales, 100000, 'The original sale day remains 1,000 TL');
  assert.equal(current.totals.sales, currentSales);
  assert.equal(repo.state({ compact: true }).overview.revenue, currentSales);
  for (const [id, value] of Object.entries(sold)) {
    assert.equal(previous.accounts.find(row => row.accountId === id).closing, value, `Original day ${id}`);
    assert.equal(current.accounts.find(row => row.accountId === id).opening, value, `Next day opening ${id}`);
  }
  for (const [id, value] of Object.entries(expected)) assert.equal(current.accounts.find(row => row.accountId === id).closing, value, `Next day closing ${id}`);
}
function assertReader(reader, expected, currentSales) {
  const overview = reader.overview();
  assert.equal(overview.date, returnDay);
  assert.equal(overview.totals.sales, currentSales);
  assertBalances(Object.fromEntries(overview.accounts.map(account => [account.id, account.balance])), expected);
  assert.equal(reader.summary(saleDay).totals.sales, 100000);
  const summary = reader.summary(returnDay);
  assert.equal(summary.totals.sales, currentSales);
  for (const [id, value] of Object.entries(expected)) assert.equal(summary.accounts.find(row => row.accountId === id).closing, value, `Reader ${id}`);
  const sale = reader.journal({ date: saleDay, type: 'sale' }).items;
  assert.equal(sale.length, 1); assert.equal(sale[0].sales, 100000);
  const refunds = reader.journal({ date: returnDay, type: 'saleReturn' }).items;
  assert.equal(refunds.length, 1); assert.equal(refunds[0].sales, -40000, 'Reversal preserves the original return record');
}

test('v6 stock consideration and change survive a cross-day measured partial return, reversal, reader and restores', async () => {
  const root = resolve(tmpdir()), directory = mkdtempSync(join(root, 'defter-mixed-return-'));
  const filename = join(directory, 'synthetic.sqlite');
  let repo, reader;
  try {
    repo = new Repository(filename, 'demo');
    const balances = Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, '0']));
    Object.assign(balances, { bilezikAdet: '10', bilezik22: '100', nakit: '10000' });
    execute(repo, 'opening', { type: 'opening', date: saleDay, balances });
    execute(repo, 'buyer', { type: 'account', date: saleDay, name: 'Synthetic mixed-return buyer', unit: 'TL', partyType: 'customer', opening: '0' });
    assertBalances(repo.state().balances, opening);
    execute(repo, 'mixed-sale', {
      type: 'sale', date: saleDay, counterpartyId: customer, counterpartyType: 'customer',
      items: [{ accountId: 'bilezikAdet', quantity: '2', weightAccount: 'bilezik22', weight: '20', value: '1000' }],
      received: [{ accountId: 'ceyrek', quantity: '1', valueTL: '900' }],
      given: [{ accountId: 'nakit', quantity: '100', valueTL: '100' }],
      credits: [{ accountId: customer, quantity: '200', valueTL: '200' }], debts: [],
      note: 'Synthetic 900 stock - 100 change + 200 receivable'
    });
    assertBalances(repo.state().balances, sold);
    assert.equal(repo.events().at(-1).schemaVersion, 6);
    // Explicit known counts, not a read-back of actual balances. All other
    // daily accounts were opened at zero; periodic grams are not counted here.
    const counts = Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired && a.physical && currentCountPolicy(a) === 'daily').map(a => [a.id, '0']));
    Object.assign(counts, { bilezikAdet: '8', ceyrek: '1', nakit: '9900' });
    execute(repo, 'close-sale-day', { type: 'close', date: saleDay, nextDate: returnDay, counts, reasons: {}, approvedBy: 'Synthetic independent count' });
    assertHistory(repo, sold, 0);
    assert.equal(repo.events().at(-1).schemaVersion, 6);
    reader = new ReportRepository(filename, 'demo');

    async function verifyCheckpoint(name, expected, currentSales, remainingQuantity, remainingWeight) {
      assertHistory(repo, expected, currentSales);
      const revision = repo.state().revision, eventCount = repo.events().length;
      assertReader(reader, expected, currentSales);
      assert.equal(repo.state().revision, revision); assert.equal(repo.events().length, eventCount);
      assert.deepEqual(repo.journalPage({ scope: 'all', type: 'sale' }).items[0].returnInfo.lines,
        [{ lineIndex: 0, remainingQuantity, remainingWeight }]);
      const jsonTarget = new Repository(':memory:', 'demo'), archiveTarget = new Repository(':memory:', 'demo');
      try {
        jsonTarget.restore({ backup: repo.backup(), revision: 0, confirmation: 'GERİ YÜKLE' });
        assertHistory(jsonTarget, expected, currentSales);
        const archive = join(directory, `${name}.ndjson`); repo.exportArchive(archive);
        await archiveTarget.restoreArchive(createReadStream(archive), { revision: 0, confirmation: 'GERİ YÜKLE', temporaryDirectory: directory });
        assertHistory(archiveTarget, expected, currentSales);
      } finally { jsonTarget.close(); archiveTarget.close(); }
    }

    execute(repo, 'partial-return', {
      type: 'saleReturn', date: returnDay, originalId: 'mixed-sale',
      items: [{ lineIndex: 0, quantity: '1', weight: '9', value: '400' }],
      refunds: [{ accountId: 'nakit', quantity: '400', valueTL: '400' }],
      note: 'Synthetic measured 9g return with agreed 400 TL cash refund'
    });
    assert.equal(repo.events().at(-1).schemaVersion, 4);
    await verifyCheckpoint('returned', returned, -40000, 1, 11000);
    execute(repo, 'undo-return', { type: 'reverse', date: returnDay, originalId: 'partial-return', note: 'Synthetic return cancellation' });
    await verifyCheckpoint('return-reversed', sold, 0, 2, 20000);
  } finally {
    reader?.close(); repo?.close();
    assert.equal(dirname(resolve(directory)), root);
    rmSync(directory, { recursive: true, force: true });
  }
});
