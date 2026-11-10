import test from 'node:test';
import assert from 'node:assert/strict';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS, decimal, replay, workdaySummary } from '../domain.mjs';

// Cross-slice synthetic acceptance: no application data directory is opened.
test('multi-product/currency return, POS settlement, amendment and restore preserve each account and dated equation', t => {
  const repo = new Repository(':memory:', 'master-synthetic');
  const restored = new Repository(':memory:', 'master-synthetic');
  t.after(() => { repo.close(); restored.close(); });
  const execute = (id, command) => repo.execute({ id, revision: repo.state().revision,
    command: { date: repo.state().date || '2026-10-27', ...command } });
  const equation = date => {
    const summary = workdaySummary(repo.state(), date);
    for (const row of summary.accounts) {
      assert.equal(row.opening + row.incoming - row.outgoing + row.adjustment, row.closing, row.accountId);
      assert.ok(Number.isSafeInteger(row.closing));
    }
    assert.deepEqual(repo.state().balances, replay(repo.events()).balances);
    return summary;
  };
  execute('opening', { type: 'opening', balances: Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired)
    .map(a => [a.id, ({ nakit: '10000', usd: '100', gramToplam: '100', ceyrek: '10' })[a.id] || '0'])) });
  execute('sale', { type: 'sale', items: [
    { accountId: 'gramToplam', quantity: '2', value: '300' },
    { accountId: 'ceyrek', quantity: '2', value: '300' }
  ], payments: [{ accountId: 'nakit', quantity: '200' }, { accountId: 'pos', quantity: '200' },
    { accountId: 'usd', quantity: '5', valueTL: '200' }], credits: [], scrapQuantity: '0', scrapValue: '0', note: 'Same-day multi-unit sale' });
  execute('return', { type: 'saleReturn', originalId: 'sale', items: [
    { lineIndex: 0, quantity: '1', value: '150' }, { lineIndex: 1, quantity: '1', value: '100' }
  ], refunds: [{ accountId: 'nakit', quantity: '50', valueTL: '50' },
    { accountId: 'usd', quantity: '4', valueTL: '200' }], note: 'Actual USD and TL refunds; no automatic rate conversion' });
  assert.equal(repo.state().balances.gramToplam, 99000);
  assert.equal(repo.state().balances.ceyrek, 9);
  assert.equal(repo.state().balances.usd, 10100);
  assert.equal(repo.state().balances.nakit, 1015000);
  execute('settlement', { type: 'settlement', bankAccount: 'banka', gross: '200', fee: '5', note: 'Selected bank net settlement' });
  assert.equal(repo.state().balances.pos, 0);
  assert.equal(repo.state().balances.banka, 19500);
  const firstDay = equation('2026-10-27');
  assert.equal(firstDay.totals.sales, 35000);
  // Independent, hand-calculated minor-unit oracles: do not derive expectations
  // from balances, replay or the summary implementation under test.
  const expectedRows = {
    nakit: [1000000, 20000, 5000, 0, 1015000],
    usd: [10000, 500, 400, 0, 10100],
    gramToplam: [100000, 1000, 2000, 0, 99000],
    ceyrek: [10, 1, 2, 0, 9],
    pos: [0, 20000, 20000, 0, 0],
    banka: [0, 19500, 0, 0, 19500]
  };
  for (const [accountId, expected] of Object.entries(expectedRows)) {
    const row = firstDay.accounts.find(account => account.accountId === accountId);
    assert.ok(row, `Missing summary account: ${accountId}`);
    assert.deepEqual([row.opening, row.incoming, row.outgoing, row.adjustment, row.closing],
      expected, `${accountId}: opening / incoming / outgoing / adjustment / closing`);
  }
  const count = repo.state();
  execute('close', { type: 'close', counts: Object.fromEntries(count.accounts.filter(a => a.physical && !a.retired && a.countPolicy === 'daily')
    .map(a => [a.id, decimal(count.balances[a.id] || 0, a.unit)])), reasons: {}, approvedBy: 'Synthetic acceptance' });
  const transfer = { type: 'transfer', fromAccount: 'banka', toAccount: 'nakit', quantity: '100', note: 'Synthetic transfer' };
  execute('transfer', transfer);
  execute('amend', { type: 'amend', originalId: 'transfer', replacement: { ...transfer, quantity: '90' }, note: 'Corrected transferred amount' });
  assert.equal(repo.state().balances.banka, 10500);
  execute('undo-return', { type: 'reverse', originalId: 'return', note: 'Undo only the mistaken return' });
  assert.equal(repo.state().balances.gramToplam, 98000);
  assert.equal(repo.state().balances.ceyrek, 8);
  assert.equal(repo.state().balances.usd, 10500);
  assert.deepEqual(workdaySummary(repo.state(), '2026-10-27'), firstDay);
  assert.equal(equation('2026-10-28').totals.sales, 25000);
  const beforeRejected = repo.state();
  assert.throws(() => execute('invalid-sale-reverse', { type: 'reverse', originalId: 'sale', note: 'POS claim already settled' }), /yetersiz/i);
  assert.deepEqual(repo.state(), beforeRejected, 'A rejected inverse cannot partially change stock or cash.');
  const backup = repo.backup();
  restored.restore({ backup, revision: 0, confirmation: 'GERİ YÜKLE' });
  assert.deepEqual(restored.state().balances, repo.state().balances);
  assert.deepEqual(restored.events(), repo.events());
  for (const date of ['2026-10-27', '2026-10-28']) assert.deepEqual(workdaySummary(restored.state(), date), workdaySummary(repo.state(), date));
  assert.equal(restored.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});
