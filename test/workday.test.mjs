import { appendHistoricalEvent } from '../test-support/historical-supplier.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { Repository } from '../repository.mjs';
import * as domain from '../domain.mjs';

const active = a => !a.retired;
function execute(r, command, id = randomUUID()) { return (command.source==='supplier' ? appendHistoricalEvent(r,id,command) : r.execute({ id, revision: r.state().revision, command })).state; }
function repository(t, overrides = {}) {
  const r = new Repository(':memory:', 'test'); t.after(() => r.close());
  execute(r, { type: 'opening', date: '2026-10-27', balances: {
    ...Object.fromEntries(domain.INITIAL_ACCOUNTS.filter(active).map(a => [a.id, '0'])),
    nakit: '20000', banka: '15000', bilezikAdet: '100', bilezik22: '1205', gramToplam: '243', ...overrides
  } });
  return r;
}
function account(r, opening = '0', unit = 'TL') {
  const id = randomUUID(); execute(r, { type: 'account', date: r.state().date, name: 'Örnek cari ' + id.slice(0, 6), unit, opening }, id); return 'cari-' + id;
}
function close(r, overrides = {}, reasons = {}) {
  const s = r.state();
  return execute(r, { type: 'close', date: s.date, approvedBy: 'Bağımsız defter kontrolü', reasons, counts: {
    ...Object.fromEntries(s.accounts.filter(a => a.physical && active(a) && a.countPolicy === 'daily').map(a => [a.id, domain.decimal(s.balances[a.id] || 0, a.unit)])), ...overrides
  } });
}
function purchase(r, party, overrides = {}) { return { type: 'purchase', date: r.state().date, source: 'supplier', items: [{ accountId: 'bilezikAdet', quantity: '1', weightAccount: 'bilezik22', weight: '20.22', value: '10000' }], cash: '3000', bank: '2000', counterpartyAccount: party, note: 'Günlük kabul alış kaydı', ...overrides }; }
function sale(r, party, overrides = {}) { return { type: 'sale', date: r.state().date, items: [{ accountId: 'bilezikAdet', quantity: '1', weightAccount: 'bilezik22', weight: '10', value: '6000' }], scrapQuantity: '0', scrapValue: '0', cash: '1000', pos: '2000', bank: '0', customerAccount: party, note: 'Günlük kabul satış kaydı', ...overrides }; }
function summary(r, date = r.state().date) {
  assert.equal(typeof domain.workdaySummary, 'function', 'The workday summary export is missing');
  return domain.workdaySummary(r.state(), date);
}
function row(s, id) { const found = s.accounts.find(a => a.accountId === id); assert.ok(found, 'Summary must include account ' + id); return found; }
function equation(s) { for (const a of s.accounts) assert.equal(a.closing, a.opening + a.incoming - a.outgoing + a.adjustment, 'Account equation: ' + a.accountId); }

test('first-day opening quantities are not normal incoming trade or turnover', t => {
  const r = repository(t), s = summary(r);
  assert.equal(s.date, '2026-10-27');
  assert.deepEqual(s.totals, { sales: 0, purchases: 0 });
  assert.deepEqual(row(s, 'bilezikAdet'), { accountId: 'bilezikAdet', unit: 'ADET', opening: 100, incoming: 0, outgoing: 0, adjustment: 0, closing: 100 });
  assert.equal(row(s, 'bilezik22').opening, 1205000);
  assert.equal(row(s, 'gramToplam').opening, 243000);
  equation(s);
});

test('purchase and sale share the exact same account flow ledger but retain separate TL trade totals', t => {
  const r = repository(t), supplier = account(r), customer = account(r);
  execute(r, purchase(r, supplier)); execute(r, sale(r, customer));
  const s = summary(r);
  assert.deepEqual(s.totals, { sales: 600000, purchases: 1000000 });
  assert.deepEqual(row(s, 'bilezikAdet'), { accountId: 'bilezikAdet', unit: 'ADET', opening: 100, incoming: 1, outgoing: 1, adjustment: 0, closing: 100 });
  assert.equal(row(s, 'bilezik22').incoming, 20220);
  assert.equal(row(s, 'bilezik22').outgoing, 10000);
  assert.equal(row(s, 'bilezik22').closing, 1215220);
  assert.equal(row(s, 'nakit').incoming, 100000); assert.equal(row(s, 'nakit').outgoing, 300000);
  assert.equal(row(s, supplier).closing, -500000); assert.equal(row(s, customer).closing, 300000);
  assert.equal(row(s, 'pos').closing, 200000);
  equation(s);
});

test('day closure preserves balances and starts next-day trade and flow totals at zero', t => {
  const r = repository(t), supplier = account(r), customer = account(r);
  execute(r, purchase(r, supplier)); execute(r, sale(r, customer)); const before = r.state(); close(r);
  const s = summary(r);
  assert.equal(s.date, '2026-10-28'); assert.deepEqual(s.totals, { sales: 0, purchases: 0 });
  for (const a of s.accounts) {
    assert.equal(a.opening, before.balances[a.accountId] || 0); assert.equal(a.closing, a.opening);
    assert.equal(a.incoming, 0); assert.equal(a.outgoing, 0); assert.equal(a.adjustment, 0);
  }
  assert.equal(row(s, 'pos').closing, 200000); assert.equal(row(s, supplier).closing, -500000);
  equation(s);
});

test('daily count and periodic scale discrepancies are adjustments, not trade flows or extra purchases', t => {
  const r = repository(t);
  execute(r, { type: 'stocktake', date: r.state().date, counts: { bilezik22: '1204.780' }, reasons: { bilezik22: 'Ölçülmüş terazi farkı' }, approvedBy: 'Test' });
  close(r, { nakit: '19999' }, { nakit: 'Açıklamalı fiziki sayım farkı' });
  const s = summary(r, '2026-10-27');
  assert.equal(row(s, 'bilezik22').adjustment, -220);
  assert.equal(row(s, 'bilezik22').incoming, 0); assert.equal(row(s, 'bilezik22').outgoing, 0);
  assert.equal(row(s, 'nakit').adjustment, -100);
  assert.equal(row(s, 'nakit').incoming, 0); assert.equal(row(s, 'nakit').outgoing, 0);
  assert.deepEqual(s.totals, { sales: 0, purchases: 0 }); equation(s);
  assert.equal(row(summary(r), 'bilezik22').opening, 1204780);
});

test('historical day selection ignores later movements rather than leaking current balances backwards', t => {
  const r = repository(t), party = account(r); execute(r, purchase(r, party)); close(r);
  execute(r, { type: 'movement', date: r.state().date, accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '500', note: 'Ertesi gün sermayesi' });
  const previous = summary(r, '2026-10-27'), current = summary(r, '2026-10-28');
  assert.equal(row(previous, 'nakit').closing, 1700000);
  assert.equal(row(current, 'nakit').opening, 1700000);
  assert.equal(row(current, 'nakit').incoming, 50000);
  assert.equal(row(current, 'nakit').closing, 1750000);
  assert.equal(previous.totals.purchases, 1000000); assert.equal(current.totals.purchases, 0);
  equation(previous); equation(current);
});

test('closed-day purchase reversal appears today as a negative purchase effect and restores all account measures', t => {
  const r = repository(t), party = account(r), before = r.state(), id = randomUUID();
  execute(r, purchase(r, party), id); close(r);
  execute(r, { type: 'reverse', date: r.state().date, originalId: id, note: 'Geçmiş alışın bugüne bağlı iptali' });
  const s = summary(r);
  assert.deepEqual(s.totals, { sales: 0, purchases: -1000000 });
  assert.equal(row(s, 'bilezikAdet').outgoing, 1); assert.equal(row(s, 'bilezik22').outgoing, 20220);
  assert.equal(row(s, 'nakit').incoming, 300000); assert.equal(row(s, 'banka').incoming, 200000);
  for (const a of s.accounts) assert.equal(a.closing, before.balances[a.accountId] || 0);
  assert.equal(summary(r, '2026-10-27').totals.purchases, 1000000); equation(s);
});

test('same-day purchase and its inverse remain visible as movements while their trade effect nets to zero', t => {
  const r = repository(t), party = account(r), id = randomUUID(); execute(r, purchase(r, party), id);
  execute(r, { type: 'reverse', date: r.state().date, originalId: id, note: 'Aynı gün alış iptali' });
  const s = summary(r);
  assert.equal(s.totals.purchases, 0);
  assert.equal(row(s, 'bilezikAdet').incoming, 1); assert.equal(row(s, 'bilezikAdet').outgoing, 1);
  assert.equal(row(s, 'bilezikAdet').closing, 100); equation(s);
});

test('late receivable and financial-fund openings remain opening balances in their original units', t => {
  const r = repository(t), debt = account(r, '-1.250', 'HAS'), id = randomUUID();
  const created = execute(r, { type: 'fundAccount', date: r.state().date, name: 'Örnek has kasası', unit: 'HAS', opening: '2.500', physical: true }, id);
  const fund = created.accounts.find(a => a.name === 'Örnek has kasası').id;
  const s = summary(r);
  assert.deepEqual(row(s, debt), { accountId: debt, unit: 'HAS', opening: -1250, incoming: 0, outgoing: 0, adjustment: 0, closing: -1250 });
  assert.deepEqual(row(s, fund), { accountId: fund, unit: 'HAS', opening: 2500, incoming: 0, outgoing: 0, adjustment: 0, closing: 2500 });
  assert.deepEqual(s.totals, { sales: 0, purchases: 0 }); equation(s);
});

test('nominal gram confirmation is an explicit opening, never a sale, purchase or ordinary incoming flow', t => {
  const r = new Repository(':memory:', 'test'); t.after(() => r.close());
  const balances = Object.fromEntries(domain.INITIAL_ACCOUNTS.filter(a => (a.introduced || 1) <= 2).map(a => [a.id, '0']));
  const events = [{ id: 'legacy-day-open', schemaVersion: 2, timestamp: '2026-10-27T09:00:00Z', command: { type: 'opening', date: '2026-10-27', balances } }];
  r.restore({ backup: { format: 'kuyumcu-defter-v1', workspace: 'test', events, sha256: createHash('sha256').update(JSON.stringify(events)).digest('hex') }, revision: 0, confirmation: 'GERİ YÜKLE' });
  execute(r, { type: 'nominalOpening', date: r.state().date, quantity: '243', note: 'Gerçek nominal gram açılışı' });
  const s = summary(r);
  assert.deepEqual(row(s, 'gramToplam'), { accountId: 'gramToplam', unit: 'GRAM', opening: 243000, incoming: 0, outgoing: 0, adjustment: 0, closing: 243000 });
  assert.deepEqual(s.totals, { sales: 0, purchases: 0 }); equation(s);
});

test('workday summary is read-only and rejects malformed calendar dates', t => {
  const r = repository(t), before = r.state(); const history = r.events();
  summary(r); assert.deepEqual(r.state(), before); assert.deepEqual(r.events(), history);
  assert.throws(() => summary(r, '2026-02-31'));
  assert.throws(() => summary(r, 'not-a-day'));
});

function transfer(r, overrides = {}) { return { type: 'transfer', date: r.state().date, fromAccount: 'nakit', toAccount: 'banka', quantity: '500', note: 'Kasadan bankaya yatırılan tutar', ...overrides }; }
function rejectTransfer(r, overrides) {
  const before = r.state(), history = r.events();
  assert.throws(() => execute(r, transfer(r, overrides)));
  assert.deepEqual(r.state(), before); assert.deepEqual(r.events(), history);
}

test('cash to bank transfer preserves total TL and is a flow without sale or purchase income', t => {
  const r = repository(t); execute(r, transfer(r));
  assert.equal(r.state().balances.nakit, 1950000); assert.equal(r.state().balances.banka, 1550000);
  const s = summary(r);
  assert.equal(row(s, 'nakit').outgoing, 50000); assert.equal(row(s, 'banka').incoming, 50000);
  assert.deepEqual(s.totals, { sales: 0, purchases: 0 }); equation(s);
});

test('transfer enforces same financial unit, distinct accounts and prohibits POS, jewelry and receivables', t => {
  const r = repository(t), party = account(r);
  for (const overrides of [
    { toAccount: 'nakit' }, { toAccount: 'usd' }, { fromAccount: 'pos' },
    { toAccount: 'pos' }, { fromAccount: 'taki14', toAccount: 'bilezik22' },
    { toAccount: party }, { fromAccount: 'missing' }, { toAccount: 'missing' }
  ]) rejectTransfer(r, overrides);
});

test('transfer rejects insufficient funds, zero and invalid quantities without partial postings', t => {
  const r = repository(t);
  for (const quantity of ['20000.01', '0', '-1', '0.001', '', null]) rejectTransfer(r, { quantity });
});

test('same-unit HAS transfer preserves three decimal precision between separate funds', t => {
  const r = repository(t), funds = [];
  for (const [name, opening] of [['Has kasa A', '2.000'], ['Has kasa B', '0']]) {
    const s = execute(r, { type: 'fundAccount', date: r.state().date, name, opening, unit: 'HAS', physical: true });
    funds.push(s.accounts.find(a => a.name === name).id);
  }
  execute(r, transfer(r, { fromAccount: funds[0], toAccount: funds[1], quantity: '0.125' }));
  assert.equal(r.state().balances[funds[0]], 1875); assert.equal(r.state().balances[funds[1]], 125);
  const s = summary(r); assert.equal(row(s, funds[0]).outgoing, 125); assert.equal(row(s, funds[1]).incoming, 125); equation(s);
});

test('transfer reversal restores both accounts and next-day opening carries the exact result', t => {
  const r = repository(t), id = randomUUID(), before = r.state(); execute(r, transfer(r), id);
  execute(r, { type: 'reverse', date: r.state().date, originalId: id, note: 'Yanlış hesaba havale iptali' });
  assert.deepEqual(r.state().balances, before.balances); close(r);
  const s = summary(r); assert.equal(row(s, 'nakit').opening, 2000000); assert.equal(row(s, 'banka').opening, 1500000);
  assert.deepEqual(s.totals, { sales: 0, purchases: 0 }); equation(s);
});

test('transfer cannot be reversed after destination funds have been spent below the required amount', t => {
  const r = repository(t, { banka: '0' }), id = randomUUID(); execute(r, transfer(r), id);
  execute(r, { type: 'movement', date: r.state().date, accountId: 'banka', direction: 'out', category: 'Gider', quantity: '500', note: 'Banka bakiyesinin kullanılması' });
  const before = r.state(), history = r.events();
  assert.throws(() => execute(r, { type: 'reverse', date: r.state().date, originalId: id, note: 'Artık bakiyesi olmayan transfer iptali' }), /yetersiz/i);
  assert.deepEqual(r.state(), before); assert.deepEqual(r.events(), history);
});

function allocatedSale(r, overrides = {}) {
  const command = sale(r, undefined, overrides);
  for (const key of ['cash', 'pos', 'bank', 'customerAccount']) delete command[key];
  return { ...command, payments: [], credits: [], ...overrides };
}
function rejectCommand(r, command) {
  const before = r.state(), history = r.events(); assert.throws(() => execute(r, command));
  assert.deepEqual(r.state(), before); assert.deepEqual(r.events(), history);
}

test('sale receives USD payment and creates HAS claim in original units at explicitly agreed TL values', t => {
  const r = repository(t), has = account(r, '0', 'HAS');
  execute(r, allocatedSale(r, { payments: [{ accountId: 'usd', quantity: '100', valueTL: '4000' }], credits: [{ accountId: has, quantity: '0.250', valueTL: '2000' }] }));
  assert.equal(r.state().balances.usd, 10000); assert.equal(r.state().balances[has], 250);
  assert.equal(r.state().balances.bilezikAdet, 99); assert.equal(r.state().balances.bilezik22, 1195000);
  assert.equal(r.state().journal.at(-1).meta.revenue, 600000);
});

test('allocated sale reconciles gross sale against scrap and financial consideration without counting scrap twice', t => {
  const r = repository(t), usd = account(r, '0', 'USD');
  execute(r, allocatedSale(r, { scrapQuantity: '2.125', scrapValue: '1000', payments: [{ accountId: 'nakit', quantity: '2000' }], credits: [{ accountId: usd, quantity: '75', valueTL: '3000' }] }));
  assert.equal(r.state().balances.hurda22, 2125); assert.equal(r.state().balances.nakit, 2200000);
  assert.equal(r.state().balances[usd], 7500); assert.equal(r.state().journal.at(-1).meta.revenue, 600000);
  const s = summary(r); assert.deepEqual(s.totals, { sales: 600000, purchases: 0 }); equation(s);
});

test('same-unit foreign claim collection adds to its matching fund without creating a second sale', t => {
  const r = repository(t), usd = account(r, '0', 'USD');
  execute(r, allocatedSale(r, { credits: [{ accountId: usd, quantity: '150', valueTL: '6000' }] }));
  execute(r, { type: 'collection', date: r.state().date, customerAccount: usd, direction: 'collect', target: 'usd', quantity: '50', note: 'Dolar alacağının kısmi tahsilatı' });
  assert.equal(r.state().balances[usd], 10000); assert.equal(r.state().balances.usd, 5000);
  assert.equal(summary(r).totals.sales, 600000);
});

test('sale accepts POS as incoming claim but keeps its later bank settlement separate from turnover', t => {
  const r = repository(t); execute(r, allocatedSale(r, { payments: [{ accountId: 'pos', quantity: '6000' }] }));
  execute(r, { type: 'settlement', date: r.state().date, gross: '6000', fee: '60', note: 'POS banka net valörü' });
  assert.equal(r.state().balances.pos, 0); assert.equal(r.state().balances.banka, 2094000);
  assert.equal(summary(r).totals.sales, 600000);
});

test('sale allocation rejects mixed legacy fields, incorrect reference totals and unsupported payment account roles', t => {
  const r = repository(t), party = account(r);
  for (const command of [
    allocatedSale(r, { cash: '0', payments: [{ accountId: 'nakit', quantity: '6000' }] }),
    allocatedSale(r, { credits: [{ accountId: party, quantity: '5999.99' }] }),
    allocatedSale(r, { payments: [{ accountId: 'usd', quantity: '100' }] }),
    allocatedSale(r, { payments: [{ accountId: party, quantity: '6000' }] }),
    allocatedSale(r, { credits: [{ accountId: 'nakit', quantity: '6000' }] }),
    allocatedSale(r, { payments: [null] })
  ]) rejectCommand(r, command);
});

test('allocated sale reversal restores original physical and foreign balances rather than converting TL references', t => {
  const r = repository(t), has = account(r, '0', 'HAS'), before = r.state(), id = randomUUID();
  execute(r, allocatedSale(r, { payments: [{ accountId: 'usd', quantity: '100', valueTL: '4000' }], credits: [{ accountId: has, quantity: '0.250', valueTL: '2000' }] }), id);
  execute(r, { type: 'reverse', date: r.state().date, originalId: id, note: 'Döviz ve has alacaklı satış iptali' });
  assert.deepEqual(r.state().balances, before.balances); assert.equal(summary(r).totals.sales, 0);
});

test('opening correction and its reversal are adjustments rather than sale or normal cash flows', t => {
  const r = repository(t), id = randomUUID();
  execute(r, { type: 'movement', date: r.state().date, accountId: 'nakit', direction: 'in', category: 'Açılış düzeltmesi', quantity: '1', note: 'Açılışta kaydedilmemiş bir lira' }, id);
  let s = summary(r); assert.equal(row(s, 'nakit').adjustment, 100); assert.equal(row(s, 'nakit').incoming, 0);
  execute(r, { type: 'reverse', date: r.state().date, originalId: id, note: 'Düzeltmenin geri alınması' });
  s = summary(r); assert.equal(row(s, 'nakit').adjustment, 0); assert.equal(row(s, 'nakit').incoming, 0); assert.equal(row(s, 'nakit').outgoing, 0); equation(s);
});

test('summary rejects dates outside the initialized ledger instead of fabricating an opening or future carry', t => {
  const r = repository(t); assert.throws(() => summary(r, '2026-10-26')); assert.throws(() => summary(r, '2026-10-28'));
});

test('explicit null sale allocation arrays cannot be treated as omitted empty arrays', t => {
  const r = repository(t), party = account(r);
  rejectCommand(r, allocatedSale(r, { payments: null, credits: [{ accountId: party, quantity: '6000' }] }));
  rejectCommand(r, allocatedSale(r, { payments: [{ accountId: 'nakit', quantity: '6000' }], credits: null }));
});
