import { appendHistoricalEvent } from '../test-support/historical-supplier.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadStream, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS, replay, quantity, decimal, currentCountPolicy } from '../domain.mjs';

const date = '2026-10-27';
// Legacy family financial contracts must remain replayable after retiring their write routes.
const execute = (repo,id,command) => ['sale','purchase','collection','amend'].includes(command.type)&&!repo.events().some(e=>e.id===id)
  ? appendHistoricalEvent(repo,id,{date,...command})
  : repo.execute({id,revision:repo.state().revision,command:{date,...command}});
function base(t, filename = ':memory:') {
  const repo = new Repository(filename, 'demo'); t.after(() => repo.close());
  const balances = Object.fromEntries(INITIAL_ACCOUNTS.map(a => [a.id, '0']));
  Object.assign(balances, { nakit: '10000', usd: '1000', gramToplam: '20' });
  execute(repo, 'opening', { type: 'opening', balances });
  execute(repo, 'supplier', { type: 'account', name: 'Synthetic Supplier', partyType: 'supplier', phone: '+90 555 111', unit: 'TL', opening: '-1000' });
  return repo;
}
function family(t, filename) {
  const repo = base(t, filename);
  for (const [unit, opening] of [['USD', '-100'], ['HAS', '-10'], ['SILVER', '-500']]) execute(repo, unit, { type: 'account', name: 'Synthetic Supplier', parentAccountId: 'cari-supplier', unit, opening });
  for (const unit of ['HAS', 'SILVER']) execute(repo, 'fund-' + unit, { type: 'fundAccount', name: 'Synthetic ' + unit, unit, physical: true, opening: '1000' });
  return repo;
}
const vector = repo => Object.fromEntries(['cari-supplier', 'cari-USD', 'cari-HAS', 'cari-SILVER', 'nakit', 'usd', 'fund-fund-HAS', 'fund-fund-SILVER', 'gramToplam'].map(id => [id, repo.state().balances[id]]));
function rejectsUnchanged(repo, id, command) {
  const before = { state: repo.state(), events: repo.events() };
  assert.throws(() => execute(repo, id, command));
  assert.deepEqual({ state: repo.state(), events: repo.events() }, before);
}

test('supplier children inherit canonical profile, stay single level and unique per unit', t => {
  const repo = family(t);
  for (const unit of ['USD', 'HAS', 'SILVER']) {
    const child = repo.state().accounts.find(a => a.id === 'cari-' + unit);
    assert.equal(child.parentAccountId, 'cari-supplier'); assert.equal(child.partyType, 'supplier'); assert.equal(child.phone, '+90 555 111');
    assert.equal(repo.events().find(e => e.id === unit).schemaVersion, 7);
  }
  execute(repo, 'rename', { type: 'accountUpdate', accountId: 'cari-supplier', name: 'Renamed Supplier', phone: '+90 555 222' });
  assert.ok(repo.state().accounts.filter(a => a.id === 'cari-supplier' || a.parentAccountId === 'cari-supplier').every(a => a.name === 'Renamed Supplier' && a.phone === '+90 555 222'));
  rejectsUnchanged(repo, 'duplicate-unit', { type: 'account', name: 'Different name', parentAccountId: 'cari-supplier', unit: 'USD', opening: '0' });
  rejectsUnchanged(repo, 'nested', { type: 'account', name: 'Nested', parentAccountId: 'cari-USD', unit: 'EUR', opening: '0' });
  rejectsUnchanged(repo, 'missing', { type: 'account', name: 'Missing', parentAccountId: 'missing', unit: 'EUR', opening: '0' });
  rejectsUnchanged(repo, 'asset-parent', { type: 'account', name: 'Asset', parentAccountId: 'nakit', unit: 'EUR', opening: '0' });
  rejectsUnchanged(repo, 'change-type', { type: 'accountUpdate', accountId: 'cari-supplier', partyType: 'customer' });
  execute(repo, 'customer', { type: 'account', name: 'Customer', partyType: 'customer', unit: 'TL', opening: '0' });
  rejectsUnchanged(repo, 'customer-parent', { type: 'account', name: 'Bad child', parentAccountId: 'cari-customer', unit: 'USD', opening: '0' });
});

test('SILVER is explicit pure grams with three digits and periodic physical funds, XAG remains currency', t => {
  const repo = family(t);
  assert.equal(quantity('125.125', 'SILVER'), 125125); assert.equal(decimal(125125, 'SILVER'), '125.125');
  assert.equal(quantity('1.25', 'XAG'), 125); assert.throws(() => quantity('1.001', 'XAG'));
  assert.throws(() => quantity('1.0001', 'SILVER'));
  assert.equal(repo.state().accounts.find(a => a.id === 'fund-fund-SILVER').countPolicy, 'periodic');
  rejectsUnchanged(repo, 'silver-bank', { type: 'fundAccount', name: 'Silver bank', unit: 'SILVER', physical: false, opening: '0' });
  const bad = { id: 'bad-replay', schemaVersion: 7, command: { type: 'fundAccount', date, name: 'Silver bank', unit: 'SILVER', physical: false, opening: '0' } };
  assert.throws(() => replay([...repo.events(), bad]));
  const prefix = repo.events().slice(0, 2);
  for (const schemaVersion of [3, 5, 6]) {
    assert.throws(() => replay([...prefix, { id: 'forged-child', schemaVersion, command: { type: 'account', date, name: 'Forged', partyType: 'supplier', parentAccountId: 'cari-supplier', unit: 'USD', opening: '0' } }]));
    assert.throws(() => replay([...prefix, { id: 'forged-silver', schemaVersion, command: { type: 'fundAccount', date, name: 'Forged', physical: true, unit: 'SILVER', opening: '1' } }]));
  }
});

test('mixed supplier payment preserves independent quantities and reverses exactly', t => {
  const repo = family(t), before = vector(repo);
  const command = { type: 'collection', counterpartyId: 'cari-supplier', counterpartyType: 'supplier', received: [],
    given: [{ accountId: 'nakit', quantity: '200', valueTL: '200' }, { accountId: 'usd', quantity: '20', valueTL: '600' }, { accountId: 'fund-fund-HAS', quantity: '2', valueTL: '2000' }, { accountId: 'fund-fund-SILVER', quantity: '125.125', valueTL: '1250' }],
    credits: [{ accountId: 'cari-supplier', quantity: '200', valueTL: '200' }, { accountId: 'cari-USD', quantity: '20', valueTL: '600' }, { accountId: 'cari-HAS', quantity: '2', valueTL: '2000' }, { accountId: 'cari-SILVER', quantity: '125.125', valueTL: '1250' }], debts: [] };
  execute(repo, 'payment', command);
  assert.deepEqual(vector(repo), { 'cari-supplier': -80000, 'cari-USD': -8000, 'cari-HAS': -8000, 'cari-SILVER': -374875, nakit: 980000, usd: 98000, 'fund-fund-HAS': 998000, 'fund-fund-SILVER': 874875, gramToplam: 20000 });
  assert.equal(repo.events().at(-1).schemaVersion, 7);
  assert.deepEqual(repo.state({ compact: true }).moneyFlow.byUnit.SILVER, { incoming: 0, outgoing: 125125 });
  const statement = repo.accountStatement({ accountId: 'cari-SILVER', startDate: date, endDate: date });
  assert.deepEqual([statement.account.unit, statement.opening, statement.incoming, statement.outgoing, statement.closing], ['SILVER', 0, 125125, 500000, -374875]);
  execute(repo, 'undo-payment', { type: 'reverse', originalId: 'payment', note: 'Synthetic reversal' });
  assert.deepEqual(vector(repo), before);
});

test('SILVER physical count is periodic, explicit and carried through daily closing', t => {
  const repo = family(t);
  const id = 'fund-fund-SILVER';
  assert.equal(currentCountPolicy(repo.state().accounts.find(a => a.id === id)), 'periodic');
  execute(repo, 'silver-count', { type: 'stocktake', counts: { [id]: '999.875' }, reasons: { [id]: 'Synthetic measured difference' }, approvedBy: 'Synthetic operator' });
  assert.equal(repo.events().at(-1).schemaVersion, 7); assert.equal(repo.state().balances[id], 999875);
  assert.equal(repo.accountStatement({ accountId: id }).lastPhysicalCount.counted, 999875);
  const state = repo.state(), counts = Object.fromEntries(state.accounts.filter(a => a.physical && !a.retired && currentCountPolicy(a) === 'daily').map(a => [a.id, decimal(state.balances[a.id] || 0, a.unit)]));
  rejectsUnchanged(repo, 'bad-daily-silver', { type: 'close', counts: { ...counts, [id]: '999.875' }, reasons: {}, approvedBy: 'Synthetic operator' });
  execute(repo, 'daily-close', { type: 'close', counts, reasons: {}, approvedBy: 'Synthetic operator' });
  assert.equal(repo.state().balances[id], 999875); assert.equal(repo.state().date, '2026-10-28');
  assert.equal(replay(repo.events()).balances[id], 999875);
});

test('family sale accepts an explicit SILVER refund and its reversal without changing sibling debt', t => {
  const repo = family(t);
  execute(repo, 'silver-sale', { type: 'sale', counterpartyId: 'cari-supplier', counterpartyType: 'supplier',
    items: [{ accountId: 'gramToplam', quantity: '2', value: '1000' }], received: [{ accountId: 'fund-fund-SILVER', quantity: '25.125', valueTL: '500' }], given: [],
    credits: [{ accountId: 'cari-USD', quantity: '10', valueTL: '500' }], debts: [] });
  const sold = vector(repo);
  assert.equal(sold.gramToplam, 18000); assert.equal(sold['fund-fund-SILVER'], 1025125); assert.equal(sold['cari-USD'], -9000);
  execute(repo, 'silver-return', { type: 'saleReturn', originalId: 'silver-sale', items: [{ lineIndex: 0, quantity: '1', value: '500' }],
    refunds: [{ accountId: 'fund-fund-SILVER', quantity: '25.125', valueTL: '500' }], note: 'Synthetic manual pure silver refund' });
  assert.equal(repo.events().at(-1).schemaVersion, 7);
  assert.deepEqual(vector(repo), { ...sold, gramToplam: 19000, 'fund-fund-SILVER': 1000000 });
  assert.equal(repo.state().journal.at(-1).meta.refunds[0].quantity, 25125);
  execute(repo, 'undo-silver-return', { type: 'reverse', originalId: 'silver-return', note: 'Synthetic refund reversal' });
  assert.deepEqual(vector(repo), sold);
  assert.equal(replay(repo.events()).balances['fund-fund-SILVER'], 1025125);
});

test('supplier purchase allocates sibling debts atomically and amendment replaces stock and debt vectors', t => {
  const repo = family(t);
  const command = { type: 'purchase', source: 'supplier', counterpartyType: 'supplier', counterpartyId: 'cari-supplier', items: [{ accountId: 'gramToplam', quantity: '2', value: '1000' }], received: [], given: [], credits: [], debts: [{ accountId: 'cari-USD', quantity: '10', valueTL: '300' }, { accountId: 'cari-SILVER', quantity: '70', valueTL: '700' }] };
  execute(repo, 'purchase', command);
  assert.equal(repo.state().balances.gramToplam, 22000); assert.equal(repo.state().balances['cari-USD'], -11000); assert.equal(repo.state().balances['cari-SILVER'], -570000);
  const replacement = { ...command, items: [{ accountId: 'gramToplam', quantity: '1', value: '500' }], debts: [{ accountId: 'cari-USD', quantity: '5', valueTL: '150' }, { accountId: 'cari-SILVER', quantity: '35', valueTL: '350' }] };
  execute(repo, 'amend', { type: 'amend', originalId: 'purchase', replacement, note: 'Synthetic correction' });
  assert.equal(repo.events().at(-1).schemaVersion, 7);
  assert.equal(repo.state().balances.gramToplam, 21000); assert.equal(repo.state().balances['cari-USD'], -10500); assert.equal(repo.state().balances['cari-SILVER'], -535000);
  assert.equal(repo.state().balances.nakit, 1000000);
});

test('collection checks each affected child balance, foreign family and mismatched value atomically', t => {
  const repo = family(t);
  execute(repo, 'other', { type: 'account', name: 'Other Supplier', partyType: 'supplier', unit: 'USD', opening: '-1000' });
  const payment = (accountId, quantity, valueTL = '100') => ({ type: 'collection', counterpartyId: 'cari-supplier', counterpartyType: 'supplier', received: [], given: [{ accountId: 'nakit', quantity: valueTL, valueTL }], credits: [{ accountId, quantity, valueTL }], debts: [] });
  rejectsUnchanged(repo, 'overpay', payment('cari-USD', '100.01'));
  rejectsUnchanged(repo, 'foreign', payment('cari-other', '1'));
  rejectsUnchanged(repo, 'mismatch', { ...payment('cari-USD', '1'), given: [{ accountId: 'nakit', quantity: '99', valueTL: '99' }] });
  execute(repo, 'child-only', payment('cari-USD', '1'));
  assert.equal(repo.state().balances['cari-USD'], -9900); assert.equal(repo.state().balances['cari-supplier'], -100000);
});

test('family events survive JSON and archive restore and disk reopen with idempotency and stale revisions', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'supplier-multi-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repo = family(t), filename = join(directory, 'restored.sqlite');
  const command = { type: 'collection', date, counterpartyId: 'cari-supplier', counterpartyType: 'supplier', received: [], given: [{ accountId: 'nakit', quantity: '30', valueTL: '30' }], credits: [{ accountId: 'cari-USD', quantity: '1', valueTL: '30' }], debts: [] };
  execute(repo, 'pay', command); const before = repo.backup();
  assert.equal(repo.execute({ id: 'pay', revision: 0, command: repo.events().at(-1).command }).duplicate, true); assert.deepEqual(repo.events(), before.events); assert.equal(repo.backup().sha256, before.sha256);
  assert.throws(() => repo.execute({ id: 'stale', revision: 0, command }), error => error.status === 409);
  const restored = new Repository(filename, 'demo');
  try { restored.restore({ backup: before, revision: 0, confirmation: 'GERİ YÜKLE' }); assert.deepEqual(restored.events(), repo.events()); assert.deepEqual(vector(restored), vector(repo)); } finally { restored.close(); }
  const reopened = new Repository(filename, 'demo');
  try { assert.deepEqual(vector(reopened), vector(repo)); assert.deepEqual(reopened.state().accounts, repo.state().accounts); } finally { reopened.close(); }
  const archive = join(directory, 'family.ndjson'); repo.exportArchive(archive);
  const target = new Repository(':memory:', 'demo');
  try { await target.restoreArchive(createReadStream(archive), { revision: 0, confirmation: 'GERİ YÜKLE', temporaryDirectory: directory }); assert.deepEqual(target.events(), repo.events()); assert.deepEqual(vector(target), vector(repo)); } finally { target.close(); }
});

test('historical v6 trade and amendment replay and old nonphysical HAS remain unchanged', t => {
  const repo = base(t);
  const command = { type: 'purchase', source: 'supplier', counterpartyType: 'supplier', counterpartyId: 'cari-supplier', items: [{ accountId: 'gramToplam', quantity: '1', value: '100' }], received: [], given: [], credits: [], debts: [{ accountId: 'cari-supplier', quantity: '100', valueTL: '100' }] };
  execute(repo, 'old-purchase', command);
  execute(repo, 'old-amend', { type: 'amend', originalId: 'old-purchase', replacement: command, note: 'Historical correction' });
  assert.equal(repo.events().find(e => e.id === 'old-purchase').schemaVersion, 6); assert.equal(repo.events().at(-1).schemaVersion, 6);
  const history = repo.events(), snapshot = replay(history);
  assert.equal(snapshot.balances['cari-supplier'], -110000); assert.equal(snapshot.balances.gramToplam, 21000);
  const oldFund = { id: 'legacy-has-bank', schemaVersion: 3, command: { type: 'fundAccount', date, name: 'Legacy HAS', unit: 'HAS', physical: false, opening: '2' } };
  assert.equal(replay([...history, oldFund]).balances['fund-legacy-has-bank'], 2000);
  assert.deepEqual(replay(history), snapshot);
});

test('adding a supplier child preserves legacy multicari purchase amendments and root-only v6 edits', t => {
  const repo = base(t);
  execute(repo, 'legacy-other', { type: 'account', name: 'Legacy second supplier', partyType: 'supplier', unit: 'USD', opening: '0' });
  const legacy = { type: 'purchase', source: 'supplier', counterpartyId: 'cari-supplier', items: [{ accountId: 'gramToplam', quantity: '1', value: '200' }],
    payments: [{ accountId: 'nakit', quantity: '100', valueTL: '100' }], debts: [{ accountId: 'cari-supplier', quantity: '50', valueTL: '50' }, { accountId: 'cari-legacy-other', quantity: '1', valueTL: '50' }], note: 'Historical multicari purchase' };
  execute(repo, 'legacy-purchase', legacy);
  assert.equal(repo.events().at(-1).schemaVersion, 5);
  const modern = { type: 'purchase', source: 'supplier', counterpartyId: 'cari-supplier', counterpartyType: 'supplier', items: [{ accountId: 'gramToplam', quantity: '1', value: '100' }], received: [], given: [], credits: [], debts: [{ accountId: 'cari-supplier', quantity: '100', valueTL: '100' }] };
  execute(repo, 'modern-purchase', modern);
  assert.equal(repo.events().at(-1).schemaVersion, 6);
  execute(repo, 'new-child', { type: 'account', parentAccountId: 'cari-supplier', unit: 'USD', opening: '0' });
  const before = repo.state().balances;
  execute(repo, 'legacy-edit', { type: 'amend', originalId: 'legacy-purchase', replacement: legacy, note: 'Historical payload edit after linking' });
  assert.equal(repo.events().at(-1).schemaVersion, 5); assert.deepEqual(repo.state().balances, before);
  execute(repo, 'modern-edit', { type: 'amend', originalId: 'modern-purchase', replacement: modern, note: 'Root-only modern edit after linking' });
  assert.equal(repo.events().at(-1).schemaVersion, 6); assert.deepEqual(repo.state().balances, before);
  assert.deepEqual(replay(repo.events()).balances, before);
});
