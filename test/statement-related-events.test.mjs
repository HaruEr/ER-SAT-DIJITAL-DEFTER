import test from 'node:test';
import assert from 'node:assert/strict';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS, currentCountPolicy, decimal } from '../domain.mjs';

function fixture(t, { amend = false, paymentAccount = 'nakit' } = {}) {
  const repo = new Repository(':memory:', 'demo'); t.after(() => repo.close());
  const execute = (id, command) => repo.execute({ id, revision: repo.state().revision, command });
  const close = id => {
    const state = repo.state();
    execute(id, { type: 'close', date: state.date, counts: Object.fromEntries(state.accounts.filter(a => a.physical && !a.retired && currentCountPolicy(a) === 'daily').map(a => [a.id, decimal(state.balances[a.id] || 0, a.unit)])), reasons: {}, approvedBy: 'Synthetic fixture' });
  };
  const balances = Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, '0']));
  Object.assign(balances, { nakit: '1000', gramToplam: '20' });
  execute('opening', { type: 'opening', date: '2026-10-27', balances });
  for (const id of ['buyer-a', 'buyer-b']) execute(id, { type: 'account', date: '2026-10-27', name: id, unit: 'TL', partyType: 'customer', opening: '0' });
  const sale = (party, quantity, value) => ({ type: 'sale', date: '2026-10-27', counterpartyId: 'cari-' + party, counterpartyType: 'customer', items: [{ accountId: 'gramToplam', quantity, value }], received: [{ accountId: paymentAccount, quantity: value, valueTL: value }], given: [], credits: [], debts: [], note: 'Synthetic paid sale' });
  execute('cash-a', sale('buyer-a', '2', '200'));
  execute('cash-b', sale('buyer-b', '1', '100'));
  let originalA = 'cash-a';
  if (amend) { execute('amend-a', { type: 'amend', date: '2026-10-27', originalId: 'cash-a', replacement: sale('buyer-a', '2', '200'), note: 'Synthetic correction' }); originalA = 'amend-a'; }
  close('close-27');
  for (const [id, originalId] of [['return-a', originalA], ['return-b', 'cash-b']]) execute(id, { type: 'saleReturn', date: '2026-10-28', originalId, items: [{ lineIndex: 0, quantity: '1', value: '100' }], refunds: [{ accountId: 'nakit', quantity: '100', valueTL: '100' }], note: 'Synthetic linked return' });
  close('close-28');
  execute('reverse-return-a', { type: 'reverse', date: '2026-10-29', originalId: 'return-a', note: 'Synthetic return cancellation' });
  return { repo, execute, sale };
}

test('paid customer journal includes linked return and its cancellation without changing account totals', t => {
  const { repo } = fixture(t), before = repo.state(), events = repo.events();
  const page = repo.journalPage({ scope: 'all', accountId: 'cari-buyer-a' });
  assert.deepEqual(page.items.map(x => x.id), ['reverse-return-a', 'return-a', 'cash-a', 'buyer-a']);
  assert.ok(page.items.filter(x => ['return-a', 'reverse-return-a'].includes(x.id)).every(x => x.entries.every(row => row.accountId !== 'cari-buyer-a')));
  const statement = repo.accountStatement({ accountId: 'cari-buyer-a' });
  assert.deepEqual([statement.opening, statement.incoming, statement.outgoing, statement.closing], [0, 0, 0, 0]);
  assert.equal(before.balances.nakit, 120000); assert.equal(before.balances.gramToplam, 18000);
  assert.deepEqual(repo.state(), before); assert.deepEqual(repo.events(), events);
});

test('asset journal does not inherit original POS legs for cash refunds or their reversals', t => {
  const { repo } = fixture(t, { paymentAccount: 'pos' });
  const posReturns = repo.journalPage({ scope: 'all', accountId: 'pos', type: 'saleReturn' });
  assert.deepEqual(posReturns.items, []); assert.deepEqual(posReturns.receiptContext, []);
  const posReversals = repo.journalPage({ scope: 'all', accountId: 'pos', type: 'reverse' });
  assert.deepEqual(posReversals.items, []); assert.deepEqual(posReversals.receiptContext, []);
  assert.deepEqual(repo.journalPage({ scope: 'all', accountId: 'nakit', type: 'saleReturn' }).items.map(x => x.id), ['return-b', 'return-a']);
  assert.deepEqual(repo.journalPage({ scope: 'all', accountId: 'cari-buyer-a', type: 'saleReturn' }).items.map(x => x.id), ['return-a']);
});

test('receipt context supplies only the linked family across date filters and one-item pages', t => {
  const { repo } = fixture(t), before = repo.state();
  const page = repo.journalPage({ scope: 'all', accountId: 'cari-buyer-a', startDate: '2026-10-29', endDate: '2026-10-29', limit: 1 });
  assert.deepEqual(page.items.map(x => x.id), ['reverse-return-a']);
  assert.deepEqual(page.receiptContext.map(x => x.id), ['cash-a', 'return-a']);
  assert.equal(page.total, 1); assert.equal(page.nextCursor, null);
  const original = repo.journalPage({ scope: 'all', type: 'sale', startDate: '2026-10-27', endDate: '2026-10-27', accountId: 'cari-buyer-a', limit: 1 });
  assert.deepEqual(original.items.map(x => x.id), ['cash-a']);
  assert.deepEqual(original.receiptContext.map(x => x.id), ['return-a', 'reverse-return-a']);
  original.receiptContext[0].meta.note = 'Caller mutation'; original.receiptContext[0].entries[0].delta = 999;
  assert.deepEqual(repo.state(), before);
  const other = repo.journalPage({ scope: 'all', accountId: 'cari-buyer-b', type: 'saleReturn' });
  assert.deepEqual(other.items.map(x => x.id), ['return-b']); assert.deepEqual(other.receiptContext.map(x => x.id), ['cash-b']);
  const empty = repo.journalPage({ scope: 'all', startDate: '2027-01-01' }); assert.deepEqual(empty.receiptContext, []);
});

test('related customer pagination stays unique and revision-bound while context never affects totals', t => {
  const { repo, execute } = fixture(t), options = { scope: 'all', accountId: 'cari-buyer-a', limit: 1 };
  const first = repo.journalPage(options), ids = []; let page = first;
  while (true) { ids.push(...page.items.map(x => x.id)); assert.equal(page.total, 4); assert.ok(page.receiptContext.every(x => !page.items.some(item => item.id === x.id))); if (!page.nextCursor) break; page = repo.journalPage({ ...options, cursor: page.nextCursor }); }
  assert.deepEqual(ids, ['reverse-return-a', 'return-a', 'cash-a', 'buyer-a']);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(first.totalEntries, repo.journalPage({ ...options, limit: 100 }).items.reduce((sum, item) => sum + item.entries.length, 0));
  assert.throws(() => repo.journalPage({ ...options, accountId: 'cari-buyer-b', cursor: first.nextCursor }), error => error.status === 409);
  execute('later-capital', { type: 'movement', date: '2026-10-29', accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '1', note: 'Synthetic later revision' });
  assert.throws(() => repo.journalPage({ ...options, cursor: first.nextCursor }), error => error.status === 409);
});

test('amendment dependencies and status are available recursively without assigning replacement to old customer', t => {
  const { repo } = fixture(t, { amend: true });
  const page = repo.journalPage({ scope: 'all', accountId: 'cari-buyer-a', type: 'reverse', startDate: '2026-10-29' });
  assert.deepEqual(page.items.map(x => x.id), ['reverse-return-a']);
  assert.deepEqual(page.receiptContext.map(x => x.id), ['cash-a', 'amend-a:undo', 'amend-a', 'return-a']);
  const second = new Repository(':memory:', 'demo'); t.after(() => second.close());
  const history = repo.events().slice(0, 5); for (const event of history) second.execute({ id: event.id, revision: second.state().revision, command: event.command });
  const replacement = structuredClone(history.find(x => x.id === 'cash-a').command); replacement.counterpartyId = 'cari-buyer-b';
  second.execute({ id: 'reassign', revision: second.state().revision, command: { type: 'amend', date: '2026-10-27', originalId: 'cash-a', replacement, note: 'Synthetic reassigned customer' } });
  assert.ok(!second.journalPage({ scope: 'all', accountId: 'cari-buyer-a', type: 'sale' }).items.some(x => x.id === 'reassign'));
  assert.ok(second.journalPage({ scope: 'all', accountId: 'cari-buyer-b', type: 'sale' }).items.some(x => x.id === 'reassign'));
});
