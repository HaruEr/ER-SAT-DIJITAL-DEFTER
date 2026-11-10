import { appendHistoricalEvent } from '../test-support/historical-supplier.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS, decimal, replay, workdaySummary } from '../domain.mjs';

// Independent hand-calculated minor-unit oracles; all stores are in memory.
function fixture(t, overrides = {}) {
  const r = new Repository(':memory:', 'exchange-independent');
  t.after(() => r.close());
  run(r, 'opening', { type: 'opening', balances: {
    ...Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, '0'])),
    nakit: '10000', usd: '100', ceyrek: '10', gramToplam: '100', ...overrides
  } });
  return r;
}
function run(r, id, command) {
  if(command.counterpartyType==='supplier')return appendHistoricalEvent(r,id,{date:r.state().date||'2026-10-28',...command});
  return r.execute({ id, revision: r.state().revision, command: { date: r.state().date || '2026-10-28', ...command } });
}
const sale = (overrides = {}) => ({ type: 'sale', items: [{ accountId: 'gramToplam', quantity: '10', value: '40000' }],
  received: [{ accountId: 'ceyrek', quantity: '3', valueTL: '45000' }],
  given: [{ accountId: 'nakit', quantity: '5000' }], credits: [], debts: [], note: 'Synthetic manual exchange', ...overrides });
function unchanged(r, id, command, match) {
  const state = r.state(), events = r.events();
  assert.throws(() => run(r, id, command), match);
  assert.deepEqual(r.state(), state); assert.deepEqual(r.events(), events);
}
function deltas(before, after, expected) {
  for (const id of new Set([...Object.keys(before.balances), ...Object.keys(after.balances)])) {
    assert.equal((after.balances[id] || 0) - (before.balances[id] || 0), expected[id] || 0, id);
  }
}
function party(r, id, unit = 'TL', partyType = 'customer') {
  run(r, id, { type: 'account', name: `Synthetic ${id}`, unit, opening: '0', partyType });
  return `cari-${id}`;
}

test('independent collection: supplier gold payout reduces manual HAS debt without sale or purchase revenue and reverses exactly', t => {
  const r = fixture(t);
  run(r, 'supplier-has', { type: 'account', name: 'Synthetic supplier HAS', unit: 'HAS', opening: '-10', partyType: 'supplier' });
  const id = 'cari-supplier-has', before = r.state();
  run(r, 'pay-supplier', { type: 'collection', counterpartyId: id, counterpartyType: 'supplier',
    received: [], given: [{ accountId: 'gramToplam', quantity: '3.125', valueTL: '12345.67' }],
    credits: [{ accountId: id, quantity: '2.345', valueTL: '12345.67' }], debts: [], note: 'Manually agreed HAS debt settlement' });
  deltas(before, r.state(), { gramToplam: -3125, [id]: 2345 });
  assert.equal(r.state().balances[id], -7655);
  assert.deepEqual(workdaySummary(r.state(), before.date).totals, { sales: 0, purchases: 0 });
  assert.equal(r.state().journal.at(-1).meta.revenue, 0);
  run(r, 'reverse-supplier-payment', { type: 'reverse', originalId: 'pay-supplier', note: 'Synthetic reversal' });
  deltas(before, r.state(), {});
  assert.deepEqual(workdaySummary(r.state(), before.date).totals, { sales: 0, purchases: 0 });
});

test('independent collection: stock received settles customer balance and preserves stock quantity versus manual TL', t => {
  const r = fixture(t);
  run(r, 'collect-customer', { type: 'account', name: 'Synthetic collection customer', unit: 'TL', opening: '50000', partyType: 'customer' });
  const id = 'cari-collect-customer', before = r.state();
  run(r, 'stock-collection', { type: 'collection', counterpartyId: id, counterpartyType: 'customer',
    received: [{ accountId: 'ceyrek', quantity: '3', valueTL: '45000' }], given: [], credits: [],
    debts: [{ accountId: id, quantity: '45000' }], note: 'Stock against existing debt, not a purchase' });
  deltas(before, r.state(), { ceyrek: 3, [id]: -4500000 });
  assert.equal(r.state().balances[id], 500000);
  assert.deepEqual(workdaySummary(r.state(), before.date).totals, { sales: 0, purchases: 0 });
  assert.equal(r.state().journal.at(-1).meta.revenue, 0);
  run(r, 'reverse-stock-collection', { type: 'reverse', originalId: 'stock-collection', note: 'Synthetic reversal' });
  deltas(before, r.state(), {});
});

test('independent collection: overpayment, missing party and mixed legacy fields fail atomically', t => {
  const r = fixture(t);
  run(r, 'debt', { type: 'account', name: 'Synthetic small HAS debt', unit: 'HAS', opening: '-1', partyType: 'supplier' });
  const id = 'cari-debt', valid = { type: 'collection', counterpartyId: id, counterpartyType: 'supplier',
    received: [], given: [{ accountId: 'gramToplam', quantity: '0.5', valueTL: '1000' }],
    credits: [{ accountId: id, quantity: '0.5', valueTL: '1000' }], debts: [], note: 'Synthetic rejection fixture' };
  unchanged(r, 'overpayment', { ...valid, credits: [{ accountId: id, quantity: '1.001', valueTL: '1000' }] }, /aşmamalı/i);
  unchanged(r, 'no-party', { ...valid, counterpartyId: '' }, /carisi seçin/i);
  for (const [field, value] of Object.entries({ customerAccount: id, target: 'nakit', direction: 'pay', quantity: '1', cash: '1000' })) {
    unchanged(r, `mixed-${field}`, { ...valid, [field]: value }, /eski ödeme alanları/i);
  }
  assert.deepEqual(workdaySummary(r.state(), r.state().date).totals, { sales: 0, purchases: 0 });
});

test('independent exchange: 40000 sale receives 45000 sarrafiye and gives 5000 TL, exactly once', t => {
  const r = fixture(t), before = r.state(), command = { date: before.date, ...sale() };
  const request = { id: 'exchange', revision: before.revision, command };
  const result = r.execute(request);
  deltas(before, result.state, { gramToplam: -10000, ceyrek: 3, nakit: -500000 });
  assert.equal(result.state.journal.at(-1).meta.revenue, 4000000);
  assert.equal(r.events().at(-1).schemaVersion, 6);
  assert.equal(r.execute(request).duplicate, true);
  assert.deepEqual(r.state(), result.state);
  unchanged(r, 'exchange', sale({ note: 'Changed payload under same key' }), /aynı işlem anahtarı/i);
});

test('independent exchange: USD, physical HAS and gold remain separate with manually entered TL values', t => {
  const r = fixture(t);
  run(r, 'has', { type: 'fundAccount', name: 'Synthetic physical HAS', unit: 'HAS', physical: true, opening: '10' });
  const before = r.state();
  run(r, 'multi', sale({ received: [{ accountId: 'usd', quantity: '20.25', valueTL: '12345.67' },
    { accountId: 'fund-has', quantity: '0.125', valueTL: '7654.33' }, { accountId: 'hurda14', quantity: '2.345', valueTL: '20000' }], given: [] }));
  deltas(before, r.state(), { gramToplam: -10000, usd: 2025, 'fund-has': 125, hurda14: 2345 });
  unchanged(r, 'missing-manual-value', sale({ received: [{ accountId: 'usd', quantity: '1000' }], given: [] }), /miktar|değer|sayı|girin/i);
});

test('independent exchange: large agreed value preserves exact cents without rate inference', t => {
  const r = fixture(t), before = r.state();
  run(r, 'large', sale({ items: [{ accountId: 'gramToplam', quantity: '0.001', value: '9999999999.99' }],
    received: [{ accountId: 'usd', quantity: '0.01', valueTL: '9999999999.99' }], given: [] }));
  deltas(before, r.state(), { gramToplam: -1, usd: 1 });
  assert.equal(r.state().journal.at(-1).meta.revenue, 999999999999);
});

test('independent exchange: insufficient payout or stock rejects the entire exchange and revision', t => {
  const r = fixture(t, { nakit: '4999.99' });
  unchanged(r, 'insufficient-cash', sale(), /yetersiz/i);
  unchanged(r, 'insufficient-stock', sale({ items: [{ accountId: 'gramToplam', quantity: '100.001', value: '40000' }] }), /yetersiz/i);
});

test('independent exchange: selected party owns every receivable/debt row, with exact manual net', t => {
  const r = fixture(t), customer = party(r, 'customer'), other = party(r, 'other');
  const valid = sale({ counterpartyType: 'customer', counterpartyId: customer, received: [], given: [],
    credits: [{ accountId: customer, quantity: '45000' }], debts: [{ accountId: customer, quantity: '5000' }] });
  unchanged(r, 'wrong-party', { ...valid, credits: [{ accountId: other, quantity: '45000' }] }, /seçili işlem carisine/i);
  unchanged(r, 'missing-party', { ...valid, counterpartyId: '' }, /seçili işlem carisine/i);
  const before = r.state(); run(r, 'party-exchange', valid);
  deltas(before, r.state(), { gramToplam: -10000, [customer]: 4000000 });
});

test('independent exchange: purchase gives sarrafiye, receives change, and keeps purchase total separate', t => {
  const r = fixture(t), before = r.state();
  run(r, 'purchase-exchange', { type: 'purchase', source: 'customer',
    items: [{ accountId: 'hurda22', quantity: '12.345', value: '40000' }],
    given: [{ accountId: 'ceyrek', quantity: '3', valueTL: '45000' }], received: [{ accountId: 'nakit', quantity: '5000' }],
    credits: [], debts: [], note: 'Synthetic manual purchase' });
  deltas(before, r.state(), { hurda22: 12345, ceyrek: -3, nakit: 500000 });
  assert.equal(r.state().journal.at(-1).meta.purchaseTotal, 4000000);
  assert.equal(r.state().journal.at(-1).meta.revenue || 0, 0);
});

test('independent exchange: six scrap counts are mandatory for new closure, missing count is atomic', t => {
  const r = fixture(t), s = r.state();
  const counts = Object.fromEntries(s.accounts.filter(a => a.physical && !a.retired && a.countPolicy === 'daily').map(a => [a.id, decimal(s.balances[a.id] || 0, a.unit)]));
  const close = { type: 'close', counts, reasons: {}, approvedBy: 'Synthetic acceptance' };
  for (const id of ['hurda8', 'hurda14', 'hurda18', 'hurda21', 'hurda22', 'hurda24']) {
    assert.ok(Object.hasOwn(counts, id));
    const missing = { ...counts }; delete missing[id];
    unchanged(r, `missing-${id}`, { ...close, counts: missing }, /sayım boş/i);
  }
  run(r, 'close', close);
  deltas(s, r.state(), {});
  assert.equal(r.state().date, '2026-10-29');
});

test('independent exchange: stale revision and correctly hashed invalid restore cannot partially overwrite a ledger', t => {
  const r = fixture(t); run(r, 'valid', sale());
  const state = r.state(), events = r.events();
  assert.throws(() => r.execute({ id: 'stale', revision: state.revision - 1, command: { date: state.date, ...sale() } }), /başka sekmede/i);
  assert.deepEqual(r.state(), state); assert.deepEqual(r.events(), events);
  const invalid = r.backup();
  invalid.events.at(-1).command.given[0].quantity = '4999.99';
  invalid.sha256 = createHash('sha256').update(JSON.stringify(invalid.events)).digest('hex');
  assert.throws(() => r.restore({ backup: invalid, revision: state.revision, confirmation: 'GERİ YÜKLE' }), /dengesi eşleşmeli/i);
  assert.deepEqual(r.state(), state); assert.deepEqual(r.events(), events);
  const valid = r.backup();
  assert.throws(() => r.restore({ backup: valid, revision: state.revision - 1, confirmation: 'GERİ YÜKLE' }), /veriler değişti/i);
  assert.deepEqual(r.state(), state); assert.deepEqual(r.events(), events);
});

test('independent exchange: old closure without scrap counts replays/restores; new exchange survives restore', t => {
  const r = fixture(t);
  const raw = replay(r.events());
  const oldClose = { id: 'old-close', schemaVersion: 4, timestamp: '2026-10-28T12:00:00.000Z', command: {
    type: 'close', date: '2026-10-28', approvedBy: 'Legacy synthetic', reasons: {},
    counts: Object.fromEntries(raw.accounts.filter(a => a.physical && !a.retired && a.countPolicy === 'daily').map(a => [a.id, decimal(raw.balances[a.id] || 0, a.unit)])) } };
  const backup = r.backup(); backup.events.push(oldClose);
  backup.sha256 = createHash('sha256').update(JSON.stringify(backup.events)).digest('hex');
  const restored = new Repository(':memory:', 'exchange-independent'); t.after(() => restored.close());
  restored.restore({ backup, revision: 0, confirmation: 'GERİ YÜKLE' });
  assert.equal(restored.state().date, '2026-10-29');
  assert.deepEqual(restored.state().balances, r.state().balances);
  const before = restored.state(); run(restored, 'post-legacy-exchange', sale());
  deltas(before, restored.state(), { gramToplam: -10000, ceyrek: 3, nakit: -500000 });
  const finalBackup = restored.backup();
  r.restore({ backup: finalBackup, revision: r.state().revision, confirmation: 'GERİ YÜKLE' });
  assert.deepEqual(r.events(), restored.events());
  assert.deepEqual(r.state().balances, restored.state().balances);
  assert.equal(r.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});
