import { appendHistoricalEvent } from '../test-support/historical-supplier.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS, decimal } from '../domain.mjs';

function repository(t, overrides = {}) {
  const r = new Repository(':memory:', 'test');
  t.after(() => r.close());
  execute(r, { type: 'opening', date: '2026-10-27', balances: {
    ...Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, '0'])),
    nakit: '20000', banka: '15000', bilezikAdet: '100', bilezik22: '1205', gramToplam: '243',
    ...overrides
  } });
  return r;
}
function execute(r, command, id = randomUUID()) {
  // Legacy purchase financial oracles are restored history; current writes are tested separately.
  if(command.source==='supplier'&&!r.events().some(e=>e.id===id))return appendHistoricalEvent(r,id,command);
  return r.execute({ id, revision: r.state().revision, command });
}
function cari(r, opening = '0', unit = 'TL') {
  const id = randomUUID();
  execute(r, { type: 'account', date: r.state().date, name: 'Örnek karşı taraf ' + id.slice(0, 6), unit, opening }, id);
  return 'cari-' + id;
}
function purchase(r, counterpartyAccount, overrides = {}) {
  return { type: 'purchase', date: r.state().date, source: 'supplier',
    items: [{ accountId: 'bilezikAdet', quantity: '1', weightAccount: 'bilezik22', weight: '20.22', value: '10000' }],
    cash: '3000', bank: '2000', counterpartyAccount, note: 'Bir adet bilezik; anlaşılmış toplam alış bedeli ve parçalı ödeme', ...overrides };
}
function rejectUnchanged(r, command, matcher) {
  const state = r.state(), events = r.events();
  assert.throws(() => execute(r, command), matcher);
  assert.deepEqual(r.state(), state, 'Rejected purchase must not change any balance or revision');
  assert.deepEqual(r.events(), events, 'Rejected purchase must append no event');
}
function closeCommand(r) {
  const s = r.state();
  return { type: 'close', date: s.date, approvedBy: 'Bağımsız kabul kontrolü', reasons: {},
    counts: Object.fromEntries(s.accounts.filter(a => a.physical && !a.retired && a.countPolicy === 'daily').map(a => [a.id, decimal(s.balances[a.id] || 0, a.unit)])) };
}
const salesTotal = s => s.journal.reduce((n, e) => n + (e.meta.revenue || 0), 0);

test('purchase atomically adds one bracelet and measured grams, pays cash/bank and records our remaining debt', t => {
  const r = repository(t), party = cari(r);
  const s = execute(r, purchase(r, party)).state;
  assert.equal(s.balances.bilezikAdet, 101);
  assert.equal(s.balances.bilezik22, 1225220);
  assert.equal(s.balances.nakit, 1700000);
  assert.equal(s.balances.banka, 1300000);
  assert.equal(s.balances[party], -500000);
  assert.equal(salesTotal(s), 0);
  assert.equal(s.journal.at(-1).meta.purchaseTotal, 1000000);
  assert.equal(s.journal.at(-1).meta.paid, 500000);
  assert.equal(s.journal.at(-1).meta.outstanding, 500000);
  assert.equal(s.journal.at(-1).meta.source, 'supplier');
});

test('fully paid customer purchase needs no receivable account and does not create turnover', t => {
  const r = repository(t);
  const s = execute(r, purchase(r, '', { source: 'customer', cash: '10000', bank: '0' })).state;
  assert.equal(s.balances.nakit, 1000000);
  assert.equal(s.balances.bilezikAdet, 101);
  assert.equal(s.journal.at(-1).meta.source, 'customer');
  assert.equal(s.journal.at(-1).meta.outstanding, 0);
  assert.equal(salesTotal(s), 0);
});

test('fully deferred purchase posts a negative TL net receivable without inventing a cash movement', t => {
  const r = repository(t), party = cari(r);
  const before = r.state();
  const s = execute(r, purchase(r, party, { cash: '0', bank: '0' })).state;
  assert.equal(s.balances[party], -1000000);
  assert.equal(s.balances.nakit, before.balances.nakit);
  assert.equal(s.balances.banka, before.balances.banka);
});

test('purchase nets against an existing claim on the same counterparty and can cross to debt', t => {
  const r = repository(t), party = cari(r, '2000');
  const s = execute(r, purchase(r, party)).state;
  assert.equal(s.balances[party], -300000);
});

test('two differently assayed bracelets share a piece category but preserve both measured gram pools', t => {
  const r = repository(t), party = cari(r);
  const s = execute(r, purchase(r, party, { cash: '0', bank: '0', items: [
    { accountId: 'kunye', quantity: '1', weightAccount: 'taki14', weight: '5.250', value: '25000' },
    { accountId: 'kunye', quantity: '1', weightAccount: 'taki22', weight: '6.750', value: '35000' }
  ] })).state;
  assert.equal(s.balances.kunye, 2);
  assert.equal(s.balances.taki14, 5250);
  assert.equal(s.balances.taki22, 6750);
  assert.equal(s.balances[party], -6000000);
  assert.equal(s.journal.at(-1).meta.purchaseTotal, 6000000);
  assert.equal(salesTotal(s), 0);
});

test('nominal gold purchase increases total grams rather than package counts or a second weight pool', t => {
  const r = repository(t);
  const before = r.state();
  const s = execute(r, purchase(r, '', { cash: '1000', bank: '0', items: [{ accountId: 'gramToplam', quantity: '10', value: '1000' }] })).state;
  assert.equal(s.balances.gramToplam, 253000);
  assert.equal(s.balances.gramAdet, before.balances.gramAdet);
  assert.equal(s.balances.gramaltin, before.balances.gramaltin);
  assert.equal(s.balances.taki22, before.balances.taki22);
});

test('sarrafiye purchase receives whole pieces without changing the measured metal pools', t => {
  const r = repository(t);
  const before = r.state();
  const s = execute(r, purchase(r, '', { cash: '1000', bank: '0', items: [{ accountId: 'ceyrek', quantity: '5', value: '1000' }] })).state;
  assert.equal(s.balances.ceyrek, 5);
  for (const a of s.accounts.filter(a => a.countPolicy === 'periodic')) assert.equal(s.balances[a.id], before.balances[a.id]);
});

test('purchase line weight and value are measured row totals and are not multiplied by pieces', t => {
  const r = repository(t);
  const s = execute(r, purchase(r, '', { cash: '10000', bank: '0', items: [{ accountId: 'bilezikAdet', quantity: '2', weightAccount: 'bilezik22', weight: '20.22', value: '10000' }] })).state;
  assert.equal(s.balances.bilezikAdet, 102);
  assert.equal(s.balances.bilezik22, 1225220);
  assert.equal(s.journal.at(-1).meta.purchaseTotal, 1000000);
});

test('insufficient cash rejects receipt, all payments and debt together', t => {
  const r = repository(t, { nakit: '2999' }), party = cari(r);
  rejectUnchanged(r, purchase(r, party), /yetersiz/i);
});

test('insufficient bank funds reject receipt, all payments and debt together', t => {
  const r = repository(t, { banka: '1999' }), party = cari(r);
  rejectUnchanged(r, purchase(r, party), /yetersiz/i);
});

test('overpayment is rejected instead of creating an implicit advance', t => {
  const r = repository(t), party = cari(r);
  rejectUnchanged(r, purchase(r, party, { cash: '10000', bank: '0.01' }), /aş|fazla|ödeme/i);
});

test('unpaid remainder requires a TL receivable counterparty rather than an asset or foreign unit', t => {
  const r = repository(t), usd = cari(r, '0', 'USD'), has = cari(r, '0', 'HAS');
  for (const party of ['', 'nakit', usd, has, 'missing']) rejectUnchanged(r, purchase(r, party));
});

test('purchase source is explicit and limited to customer or supplier', t => {
  const r = repository(t), party = cari(r);
  for (const source of ['', null, 'other']) rejectUnchanged(r, purchase(r, party, { source }));
});

test('purchase explanation is optional while invalid types and excessive length are rejected', t => {
  const r = repository(t), party = cari(r);
  for (const note of [null, 42, 'x'.repeat(161)]) rejectUnchanged(r, purchase(r, party, { note }));
  for (const note of ['', ' '.repeat(5)]) assert.equal(execute(r, purchase(r, party, { note })).state.journal.at(-1).meta.note, '');
});

test('purchase payment quantities reject negative, blank and fractional kuruş values', t => {
  const r = repository(t), party = cari(r);
  for (const amount of ['', '-1', '1.001', null]) {
    rejectUnchanged(r, purchase(r, party, { cash: amount }));
    rejectUnchanged(r, purchase(r, party, { bank: amount }));
  }
});

test('purchase item validation prevents partial receipt if a later assay row is invalid', t => {
  const r = repository(t), party = cari(r);
  rejectUnchanged(r, purchase(r, party, { items: [
    { accountId: 'kunye', quantity: '1', weightAccount: 'taki14', weight: '5', value: '5000' },
    { accountId: 'kunye', quantity: '1', weightAccount: 'bilezik22', weight: '5', value: '5000' }
  ] }));
});

test('purchase rejects empty item lists and direct receipt into a gram aggregate', t => {
  const r = repository(t), party = cari(r);
  for (const items of [[], null, [{ accountId: 'taki14', quantity: '1', value: '10000' }]]) rejectUnchanged(r, purchase(r, party, { items }));
});

test('purchase rejects missing, zero and sub-kuruş line values', t => {
  const r = repository(t), party = cari(r);
  for (const value of [undefined, '0', '-1', '1.001']) rejectUnchanged(r, purchase(r, party, { items: [{ accountId: 'ceyrek', quantity: '1', value }] }));
});

test('purchase rejects retired gram-gold package and weight accounts', t => {
  const r = repository(t), party = cari(r);
  for (const accountId of ['gramAdet', 'gramaltin']) rejectUnchanged(r, purchase(r, party, { items: [{ accountId, quantity: '1', value: '10000' }] }));
});

test('identical purchase retry writes once and reusing its key for changed payment is rejected', t => {
  const r = repository(t), party = cari(r), id = randomUUID(), revision = r.state().revision;
  const command = purchase(r, party);
  const first = appendHistoricalEvent(r,id,command);
  const count = r.events().length;
  const retry = r.execute({ id, revision, command });
  assert.equal(retry.duplicate, true);
  assert.deepEqual(retry.state, first.state);
  assert.equal(r.events().length, count);
  assert.throws(() => r.execute({ id, revision, command: { ...command, cash: '2999' } }));
  assert.equal(r.events().length, count);
});

test('stale purchase cannot overwrite newer movement and closed dates remain locked', t => {
  const r = repository(t), party = cari(r), revision = r.state().revision, command = purchase(r, party);
  execute(r, { type: 'movement', date: r.state().date, accountId: 'nakit', category: 'Sermaye', direction: 'in', quantity: '1', note: 'Yeni kayıt' });
  const before = r.state();
  assert.throws(() => r.execute({ id: randomUUID(), revision, command }), /değişti/i);
  assert.deepEqual(r.state(), before);
  execute(r, closeCommand(r));
  rejectUnchanged(r, command, /açık iş gününe/i);
});

test('purchase reversal restores both stock measures, cash, bank and counterparty exactly once', t => {
  const r = repository(t), party = cari(r), before = r.state(), id = randomUUID();
  execute(r, purchase(r, party), id);
  const s = execute(r, { type: 'reverse', date: r.state().date, originalId: id, note: 'Alışın tüm bağlı hareketlerinin iptali' }).state;
  assert.deepEqual(s.balances, before.balances);
  assert.equal(salesTotal(s), 0);
  rejectUnchanged(r, { type: 'reverse', date: s.date, originalId: id, note: 'İkinci iptal engeli' }, /zaten/i);
});

test('purchase reversal fails atomically when later consumption leaves insufficient received stock', t => {
  const r = repository(t, { bilezikAdet: '0', bilezik22: '0' }), party = cari(r), id = randomUUID();
  execute(r, purchase(r, party), id);
  execute(r, { type: 'sale', date: r.state().date, items: [{ accountId: 'bilezikAdet', quantity: '1', weightAccount: 'bilezik22', weight: '20.22', value: '10000' }], cash: '10000', bank: '0', pos: '0', scrapQuantity: '0', scrapValue: '0', note: 'Sonradan satılan ürün' });
  rejectUnchanged(r, { type: 'reverse', date: r.state().date, originalId: id, note: 'Mal geri gelmeden alış iptali' }, /yetersiz/i);
});

test('remaining purchase debt survives daily carry and later payment is not a new purchase or sale', t => {
  const r = repository(t), party = cari(r);
  execute(r, purchase(r, party));
  const before = r.state();
  let s = execute(r, closeCommand(r)).state;
  assert.deepEqual(s.balances, before.balances);
  assert.equal(s.date, '2026-10-28');
  assert.equal(s.closings.at(-1).carried.find(x => x.accountId === 'bilezik22').counted, null);
  s = execute(r, { type: 'collection', date: s.date, customerAccount: party, direction: 'pay', target: 'nakit', quantity: '2000', note: 'Önceki alış borcunun kısmi ödemesi' }).state;
  assert.equal(s.balances[party], -300000);
  assert.equal(s.balances.nakit, 1500000);
  assert.equal(s.journal.filter(e => e.date === s.date).reduce((n, e) => n + (e.meta.purchaseTotal || 0), 0), 0);
  assert.equal(salesTotal(s), 0);
});

test('purchase, supplier payment, daily carry and later gram count survive backup restoration', t => {
  const r = repository(t), party = cari(r);
  execute(r, purchase(r, party));
  execute(r, closeCommand(r));
  execute(r, { type: 'stocktake', date: r.state().date, counts: { bilezik22: '1225' }, reasons: { bilezik22: 'Dönemsel terazi farkı' }, approvedBy: 'Test' });
  const target = new Repository(':memory:', 'test'); t.after(() => target.close());
  const restored = target.restore({ backup: r.backup(), revision: 0, confirmation: 'GERİ YÜKLE' });
  assert.deepEqual(target.events(), r.events());
  assert.deepEqual(restored.balances, r.state().balances);
  assert.deepEqual(restored.closings, r.state().closings);
  assert.deepEqual(restored.stocktakes, r.state().stocktakes);
});

function allocatedPurchase(r, overrides = {}) {
  const { cash, bank, counterpartyAccount, ...command } = purchase(r, '');
  return { ...command, payments: [], debts: [], ...overrides };
}
function fund(r, unit, opening = '0', physical = true) {
  const id = randomUUID();
  const result = execute(r, { type: 'fundAccount', date: r.state().date, name: 'Örnek fon ' + id.slice(0, 6), unit, opening, physical }, id);
  const created = result.state.accounts.find(a => a.name === 'Örnek fon ' + id.slice(0, 6));
  assert.ok(created, 'Explicit fund creation must return the new own-unit asset');
  return created.id;
}

test('allocated purchase preserves USD cash and HAS debt independently using explicit agreed TL values', t => {
  const r = repository(t, { usd: '200' }), has = cari(r, '0', 'HAS');
  const s = execute(r, allocatedPurchase(r, { payments: [{ accountId: 'usd', quantity: '100', valueTL: '4000' }], debts: [{ accountId: has, quantity: '1', valueTL: '6000' }] })).state;
  assert.equal(s.balances.usd, 10000);
  assert.equal(s.balances[has], -1000);
  assert.equal(s.balances.bilezikAdet, 101);
  assert.equal(s.balances.bilezik22, 1225220);
  assert.equal(s.balances.nakit, 2000000);
  assert.equal(s.journal.at(-1).meta.purchaseTotal, 1000000);
  assert.equal(salesTotal(s), 0);
});

test('allocated purchase may divide debt among several original currencies without combining quantities', t => {
  const r = repository(t), has = cari(r, '0', 'HAS'), usd = cari(r, '0', 'USD'), eur = cari(r, '0', 'EUR');
  const s = execute(r, allocatedPurchase(r, { debts: [
    { accountId: has, quantity: '0.500', valueTL: '3000' },
    { accountId: usd, quantity: '100', valueTL: '4000' },
    { accountId: eur, quantity: '50', valueTL: '3000' }
  ] })).state;
  assert.equal(s.balances[has], -500);
  assert.equal(s.balances[usd], -10000);
  assert.equal(s.balances[eur], -5000);
  assert.equal(s.journal.at(-1).meta.purchaseTotal, 1000000);
});

test('TL allocations can default their TL reference to quantity, while non-TL cannot', t => {
  const r = repository(t, { usd: '200' });
  const s = execute(r, allocatedPurchase(r, { payments: [{ accountId: 'nakit', quantity: '10000' }] })).state;
  assert.equal(s.balances.nakit, 1000000);
  rejectUnchanged(r, allocatedPurchase(r, { payments: [{ accountId: 'usd', quantity: '100' }] }));
});

test('allocated purchase requires exact TL allocation equality, not a silent exchange rate or leftover guess', t => {
  const r = repository(t, { usd: '200' }), has = cari(r, '0', 'HAS');
  for (const valueTL of ['5999.99', '6000.01']) rejectUnchanged(r, allocatedPurchase(r, {
    payments: [{ accountId: 'usd', quantity: '100', valueTL: '4000' }],
    debts: [{ accountId: has, quantity: '1', valueTL }]
  }));
});

test('allocation arrays reject legacy payment or counterparty fields even if their values are zero', t => {
  const r = repository(t);
  for (const extra of [{ cash: '0' }, { bank: '0' }, { counterpartyAccount: '' }]) rejectUnchanged(r, allocatedPurchase(r, {
    payments: [{ accountId: 'nakit', quantity: '10000' }], ...extra
  }));
});

test('allocation direction and account kind are enforced instead of treating a stock or receivable as spendable cash', t => {
  const r = repository(t), has = cari(r, '0', 'HAS');
  for (const payments of [[{ accountId: has, quantity: '1', valueTL: '10000' }], [{ accountId: 'bilezik22', quantity: '1', valueTL: '10000' }]]) rejectUnchanged(r, allocatedPurchase(r, { payments }));
  for (const debts of [[{ accountId: 'nakit', quantity: '10000' }], [{ accountId: 'taki14', quantity: '1', valueTL: '10000' }]]) rejectUnchanged(r, allocatedPurchase(r, { debts }));
});

test('HAS and USD purchase allocations preserve precision and reject negatives or invalid agreed values atomically', t => {
  const r = repository(t, { usd: '200' }), has = cari(r, '0', 'HAS');
  for (const row of [
    { accountId: has, quantity: '-1', valueTL: '10000' },
    { accountId: has, quantity: '1.0001', valueTL: '10000' },
    { accountId: has, quantity: '1', valueTL: '-1' },
    { accountId: has, quantity: '1', valueTL: '10000.001' }
  ]) rejectUnchanged(r, allocatedPurchase(r, { debts: [row] }));
  rejectUnchanged(r, allocatedPurchase(r, { payments: [{ accountId: 'usd', quantity: '100.001', valueTL: '10000' }] }));
});

test('insufficient foreign funds reject the whole receipt and every associated debt', t => {
  const r = repository(t, { usd: '99.99' }), has = cari(r, '0', 'HAS');
  rejectUnchanged(r, allocatedPurchase(r, {
    payments: [{ accountId: 'usd', quantity: '100', valueTL: '4000' }],
    debts: [{ accountId: has, quantity: '1', valueTL: '6000' }]
  }), /yetersiz/i);
});

test('new GBP fund and receivable retain their own unit through purchase and partial debt settlement', t => {
  const r = repository(t), gbpFund = fund(r, 'GBP', '200'), gbpDebt = cari(r, '0', 'GBP');
  let s = execute(r, allocatedPurchase(r, { payments: [{ accountId: gbpFund, quantity: '100', valueTL: '5000' }], debts: [{ accountId: gbpDebt, quantity: '100', valueTL: '5000' }] })).state;
  assert.equal(s.balances[gbpFund], 10000); assert.equal(s.balances[gbpDebt], -10000);
  s = execute(r, { type: 'collection', date: s.date, customerAccount: gbpDebt, direction: 'pay', target: gbpFund, quantity: '20', note: 'Aynı birimde kısmi GBP borç ödemesi' }).state;
  assert.equal(s.balances[gbpFund], 8000); assert.equal(s.balances[gbpDebt], -8000);
});

test('cross-currency debt settlement is rejected without an explicit exchange transaction', t => {
  const r = repository(t), has = cari(r, '-1', 'HAS'), usd = cari(r, '-100', 'USD');
  rejectUnchanged(r, { type: 'collection', date: r.state().date, customerAccount: has, direction: 'pay', target: 'usd', quantity: '1', note: 'Yanlış birimli ödeme' });
  rejectUnchanged(r, { type: 'collection', date: r.state().date, customerAccount: usd, direction: 'pay', target: 'nakit', quantity: '100', note: 'Yanlış birimli ödeme' });
});

test('HAS physical fund can pay HAS debt and remains a measured periodic balance rather than ciro', t => {
  const r = repository(t), hasFund = fund(r, 'HAS', '2'), hasDebt = cari(r, '-1', 'HAS');
  const s = execute(r, { type: 'collection', date: r.state().date, customerAccount: hasDebt, direction: 'pay', target: hasFund, quantity: '0.250', note: 'Has borcuna has ödeme' }).state;
  assert.equal(s.balances[hasFund], 1750); assert.equal(s.balances[hasDebt], -750);
  assert.equal(s.accounts.find(a => a.id === hasFund).countPolicy, 'periodic');
  assert.equal(salesTotal(s), 0);
});

test('allocated purchase reversal restores each currency and HAS balance without applying its TL reference as quantity', t => {
  const r = repository(t, { usd: '200' }), has = cari(r, '0', 'HAS'), id = randomUUID(), before = r.state();
  execute(r, allocatedPurchase(r, { payments: [{ accountId: 'usd', quantity: '100', valueTL: '4000' }], debts: [{ accountId: has, quantity: '1', valueTL: '6000' }] }), id);
  const s = execute(r, { type: 'reverse', date: r.state().date, originalId: id, note: 'Çok birimli alışın tüm bağlı hareketlerinin iptali' }).state;
  assert.deepEqual(s.balances, before.balances);
});

test('customer scrap purchase increases its separate weight pool without inventing jewelry pieces or paired mass', t => {
  const r = repository(t), before = r.state();
  const s = execute(r, purchase(r, '', { source: 'customer', items: [{ accountId: 'hurda22', quantity: '8.125', value: '10000' }], cash: '10000', bank: '0' })).state;
  assert.equal(s.balances.hurda22, 8125);
  for (const id of ['bilezikAdet', 'bilezik22', 'taki14', 'taki22', 'gramToplam']) assert.equal(s.balances[id], before.balances[id]);
  assert.equal(s.journal.at(-1).meta.purchaseTotal, 1000000); assert.equal(salesTotal(s), 0);
});

test('malformed purchase product and payment rows reject atomically with no partial stock or debt', t => {
  const r = repository(t);
  for (const items of [[null], [17], [['not-a-product']]]) rejectUnchanged(r, purchase(r, '', { items }));
  for (const payments of [null, {}, [null], [17], [['not-a-payment']]]) rejectUnchanged(r, allocatedPurchase(r, { payments }));
});

test('purchase cannot spend a POS receivable as cash or ignore a declared POS payment', t => {
  const r = repository(t, { pos: '10000' });
  rejectUnchanged(r, allocatedPurchase(r, { payments: [{ accountId: 'pos', quantity: '10000' }] }));
  rejectUnchanged(r, purchase(r, '', { cash: '0', bank: '0', pos: '10000' }));
});

test('explicit null purchase allocation arrays cannot be treated as omitted empty arrays', t => {
  const r = repository(t), party = cari(r);
  rejectUnchanged(r, allocatedPurchase(r, { payments: null, debts: [{ accountId: party, quantity: '10000' }] }));
  rejectUnchanged(r, allocatedPurchase(r, { payments: [{ accountId: 'nakit', quantity: '10000' }], debts: null }));
});
