import { appendHistoricalEvent } from '../test-support/historical-supplier.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS, decimal, replay } from '../domain.mjs';

function fixture(t, cached) {
  const repo = new Repository(':memory:', 'demo', cached ? {} : { cacheMaxBytes: 0 });
  t.after(() => repo.close());
  const balances = Object.fromEntries(INITIAL_ACCOUNTS.filter(account => !account.retired).map(account => [account.id, '0']));
  Object.assign(balances, { nakit: '10000', banka: '1000', bilezikAdet: '10', bilezik22: '200', gramToplam: '100' });
  repo.execute({ id: 'opening', revision: 0, command: { type: 'opening', date: '2026-10-27', balances } }, { compact: true });
  return repo;
}
function run(repo, id, command) {
  const current = repo.state({ compact: true });
  if(command.source==='supplier'){appendHistoricalEvent(repo,id,{...command,date:current.date});return repo.state({compact:true});}
  return repo.execute({ id, revision: current.revision, command: { ...command, date: current.date } }, { compact: true }).state;
}
function close(repo, id) {
  const current = repo.state({ compact: true });
  return run(repo, id, { type: 'close', approvedBy: 'Synthetic financial regression', reasons: {}, counts: Object.fromEntries(current.accounts.filter(account => account.physical && !account.retired && account.countPolicy === 'daily').map(account => [account.id, decimal(current.balances[account.id] || 0, account.unit)])) });
}
const jewelry = value => [{ accountId: 'bilezikAdet', quantity: '1', weightAccount: 'bilezik22', weight: '20', value }];
const reverse = originalId => ({ type: 'reverse', originalId, note: 'Synthetic linked reversal' });

// These are the pre-compact renderOverview formulas, evaluated against a fresh
// domain replay rather than the Repository's cached full or compact projection.
function legacyOverview(state) {
  const today = state.journal.filter(event => event.date === state.date);
  const isSaleReversal = event => event.type === 'reverse' && state.journal.find(original => original.id === event.meta.originalId)?.type === 'sale';
  return {
    todaysCount: today.length,
    revenue: today.reduce((sum, event) => sum + (event.meta.revenue || 0), 0),
    expenses: today.reduce((sum, event) => sum + (event.meta.expense || 0), 0),
    salesCash: today.filter(event => event.type === 'sale' || isSaleReversal(event)).flatMap(event => event.entries).filter(entry => entry.accountId === 'nakit').reduce((sum, entry) => sum + entry.delta, 0),
    closingCount: state.closings.length
  };
}
function verify(repo, expected) {
  const replayed = replay(repo.events());
  const compact = repo.state({ compact: true });
  assert.deepEqual(compact.overview, legacyOverview(replayed));
  assert.deepEqual(compact.overview, expected);
  assert.deepEqual(compact.balances, replayed.balances);
  assert.deepEqual(compact.journal, replayed.journal.slice(-4));
  assert.deepEqual(compact.journalMeta, { total: replayed.journal.length, totalEntries: replayed.journal.reduce((sum, event) => sum + event.entries.length, 0) });
  return compact;
}

for (const cached of [true, false]) {
  const mode = cached ? 'warm cache' : 'uncached replay';
  test(`compact finance matches legacy formulas for mixed sale, non-sale cash and POS fees (${mode})`, t => {
    const repo = fixture(t, cached);
    run(repo, 'tl', { type: 'account', name: 'Synthetic TL counterparty', unit: 'TL', opening: '0' });
    run(repo, 'mixed-sale', { type: 'sale', items: jewelry('1000'), cash: '300', pos: '200', bank: '100', scrapQuantity: '1', scrapValue: '100', customerAccount: 'cari-tl', note: 'Synthetic mixed sale' });
    verify(repo, { todaysCount: 3, revenue: 100000, expenses: 0, salesCash: 30000, closingCount: 0 });
    run(repo, 'collection', { type: 'collection', customerAccount: 'cari-tl', target: 'nakit', direction: 'collect', quantity: '100', note: 'Synthetic collection' });
    run(repo, 'transfer', { type: 'transfer', fromAccount: 'nakit', toAccount: 'banka', quantity: '200', note: 'Synthetic transfer' });
    run(repo, 'capital', { type: 'movement', accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '50', note: 'Synthetic capital' });
    run(repo, 'expense', { type: 'movement', accountId: 'nakit', direction: 'out', category: 'Gider', quantity: '10', note: 'Synthetic expense' });
    run(repo, 'purchase', { type: 'purchase', source: 'supplier', items: jewelry('500'), cash: '100', bank: '100', counterpartyAccount: 'cari-tl', note: 'Synthetic purchase' });
    run(repo, 'settlement', { type: 'settlement', gross: '200', fee: '5', note: 'Synthetic POS fee' });
    verify(repo, { todaysCount: 9, revenue: 100000, expenses: 1500, salesCash: 30000, closingCount: 0 });
    run(repo, 'undo-settlement', reverse('settlement'));
    verify(repo, { todaysCount: 10, revenue: 100000, expenses: 1000, salesCash: 30000, closingCount: 0 });
    run(repo, 'undo-purchase', reverse('purchase'));
    run(repo, 'undo-sale', reverse('mixed-sale'));
    verify(repo, { todaysCount: 12, revenue: 0, expenses: 1000, salesCash: 0, closingCount: 0 });
  });

  test(`compact finance preserves prior-day sale and expense reversals after POS settlement (${mode})`, t => {
    const repo = fixture(t, cached);
    run(repo, 'sale', { type: 'sale', items: jewelry('1000'), cash: '400', pos: '600', bank: '0', scrapQuantity: '0', scrapValue: '0', customerAccount: '', note: 'Synthetic prior-day sale' });
    run(repo, 'expense', { type: 'movement', accountId: 'nakit', direction: 'out', category: 'Gider', quantity: '10', note: 'Synthetic prior-day expense' });
    close(repo, 'close');
    verify(repo, { todaysCount: 0, revenue: 0, expenses: 0, salesCash: 0, closingCount: 1 });
    run(repo, 'settlement', { type: 'settlement', gross: '600', fee: '12', note: 'Synthetic next-day commission' });
    verify(repo, { todaysCount: 1, revenue: 0, expenses: 1200, salesCash: 0, closingCount: 1 });
    run(repo, 'undo-settlement', reverse('settlement'));
    run(repo, 'undo-old-sale', reverse('sale'));
    verify(repo, { todaysCount: 3, revenue: -100000, expenses: 0, salesCash: -40000, closingCount: 1 });
    run(repo, 'undo-old-expense', reverse('expense'));
    const state = verify(repo, { todaysCount: 4, revenue: -100000, expenses: -1000, salesCash: -40000, closingCount: 1 });
    assert.equal(state.date, '2026-10-28');
    assert.equal(state.balances.nakit, 1000000);
    assert.equal(state.balances.pos, 0);
  });

  test(`compact finance keeps foreign and HAS amounts distinct from TL trade references (${mode})`, t => {
    const repo = fixture(t, cached);
    run(repo, 'has-party', { type: 'account', name: 'Synthetic HAS counterparty', unit: 'HAS', opening: '0' });
    run(repo, 'has-fund', { type: 'fundAccount', name: 'Synthetic physical HAS fund', unit: 'HAS', physical: true, opening: '0' });
    run(repo, 'usd-bank', { type: 'fundAccount', name: 'Synthetic USD bank', unit: 'USD', physical: false, opening: '0' });
    run(repo, 'foreign-sale', { type: 'sale', items: jewelry('1000'), payments: [{ accountId: 'nakit', quantity: '150' }, { accountId: 'usd', quantity: '10', valueTL: '400' }], credits: [{ accountId: 'cari-has-party', quantity: '0.250', valueTL: '450' }], scrapQuantity: '0', scrapValue: '0', note: 'Synthetic original-unit sale' });
    const sold = verify(repo, { todaysCount: 5, revenue: 100000, expenses: 0, salesCash: 15000, closingCount: 0 });
    assert.equal(sold.balances.usd, 1000); assert.equal(sold.balances['cari-has-party'], 250);
    run(repo, 'has-collection', { type: 'collection', customerAccount: 'cari-has-party', target: 'fund-has-fund', direction: 'collect', quantity: '0.125', note: 'Synthetic HAS collection' });
    run(repo, 'usd-transfer', { type: 'transfer', fromAccount: 'usd', toAccount: 'fund-usd-bank', quantity: '1', note: 'Synthetic USD transfer' });
    run(repo, 'foreign-purchase', { type: 'purchase', source: 'supplier', items: [{ accountId: 'gramToplam', quantity: '5', value: '500' }], payments: [{ accountId: 'usd', quantity: '5', valueTL: '200' }], debts: [{ accountId: 'cari-has-party', quantity: '0.500', valueTL: '300' }], note: 'Synthetic original-unit purchase' });
    const purchased = verify(repo, { todaysCount: 8, revenue: 100000, expenses: 0, salesCash: 15000, closingCount: 0 });
    assert.equal(purchased.balances.usd, 400); assert.equal(purchased.balances['cari-has-party'], -375);
    for (const [id, originalId] of [['undo-purchase', 'foreign-purchase'], ['undo-transfer', 'usd-transfer'], ['undo-collection', 'has-collection'], ['undo-sale', 'foreign-sale']]) run(repo, id, reverse(originalId));
    const restored = verify(repo, { todaysCount: 12, revenue: 0, expenses: 0, salesCash: 0, closingCount: 0 });
    assert.equal(restored.balances.usd, 0); assert.equal(restored.balances['cari-has-party'], 0);
    assert.equal(restored.balances['fund-has-fund'], 0); assert.equal(restored.balances.gramToplam, 100000);
  });
}
