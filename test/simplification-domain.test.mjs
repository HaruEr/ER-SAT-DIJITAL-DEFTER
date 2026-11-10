import test from 'node:test';
import assert from 'node:assert/strict';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS, decimal, replay, workdaySummary, currentCountPolicy } from '../domain.mjs';

const date = '2026-10-28';
function fixture(t, banks) {
  const repo = new Repository(':memory:', 'demo'); t.after(() => repo.close());
  const balances = Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, '0']));
  Object.assign(balances, { nakit: '10000', usd: '200', bilezikAdet: '10', bilezik22: '200', pos: '500' });
  run(repo, 'opening', { type: 'opening', date, balances, ...(banks ? { banks } : {}) });
  return repo;
}
function run(repo, id, command) { return repo.execute({ id, revision: repo.state().revision, command: { date, ...command } }); }
const items = (value = '1000') => [{ accountId: 'bilezikAdet', quantity: '1', weightAccount: 'bilezik22', weight: '20', value }];
const sale = (value = '1000') => ({ type: 'sale', items: items(value), payments: [{ accountId: 'nakit', quantity: value }], credits: [], scrap: [] });

test('opening creates individually named banks with native balances and survives replay and backup', t => {
  const repo = fixture(t, [{ name: 'A Bankası', unit: 'TL', opening: '120' }, { name: 'B Bankası', unit: 'USD', opening: '30' }]);
  const state = repo.state();
  assert.equal(state.balances['bank-opening-0'], 12000);
  assert.equal(state.balances['bank-opening-1'], 3000);
  assert.equal(state.nominalUnconfirmed, false);
  assert.deepEqual(replay(repo.events()).balances, state.balances);
  const target = new Repository(':memory:', 'demo'); t.after(() => target.close());
  target.restore({ backup: repo.backup(), revision: 0, confirmation: 'GERİ YÜKLE' });
  assert.deepEqual(target.state().accounts, state.accounts);
});

test('opening rejects blank required stock and duplicate or invalid named banks atomically', t => {
  const repo = new Repository(':memory:'); t.after(() => repo.close());
  const balances = Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, '0']));
  for (const banks of [null, [{ name: 'Banka', unit: 'TL', opening: '-1' }], [{ name: 'Banka', unit: 'TL', opening: '0' }, { name: 'BANKA', unit: 'TL', opening: '0' }]]) {
    assert.throws(() => run(repo, 'bad-opening', { type: 'opening', balances, banks }));
    assert.equal(repo.state().initialized, false);
  }
  assert.throws(() => run(repo, 'missing', { type: 'opening', balances: { ...balances, taki14: '' }, banks: [] }));
});

test('customer and supplier profiles persist optional contact fields and can be edited without balance changes', t => {
  const repo = fixture(t);
  run(repo, 'customer', { type: 'account', name: 'Test Kişi', unit: 'TL', opening: '100', partyType: 'customer', phone: '0500 000 00 00', taxId: '12345678901', address: 'Sentetik adres' });
  run(repo, 'supplier', { type: 'account', name: 'Test Firma', unit: 'HAS', opening: '-2', partyType: 'supplier' });
  run(repo, 'profile', { type: 'accountUpdate', accountId: 'cari-customer', name: 'Yeni İsim', phone: '', taxId: '', address: '' });
  const a = repo.state().accounts.find(a => a.id === 'cari-customer');
  assert.equal(a.name, 'Yeni İsim'); assert.equal(a.phone, ''); assert.equal(a.partyType, 'customer');
  assert.equal(repo.state().balances[a.id], 10000);
  assert.equal(repo.state().accounts.find(a => a.id === 'cari-supplier').partyType, 'supplier');
  assert.throws(() => run(repo, 'bad-tax', { type: 'account', name: 'Bad', unit: 'TL', opening: '0', partyType: 'customer', taxId: 'abc' }));
  assert.throws(() => run(repo, 'bad-update', { type: 'accountUpdate', accountId: a.id, unit: 'USD', name: 'Bad' }));
  assert.deepEqual(replay(repo.events()).accounts.map(a => a.countPolicy ? { ...a, countPolicy: currentCountPolicy(a) } : a), repo.state().accounts);
});

test('stock catalog contains six scrap purities and new stock follows its counting policy', t => {
  const repo = fixture(t);
  for (const assay of [8, 14, 18, 21, 22, 24]) assert.equal(repo.state().accounts.find(a => a.id === `hurda${assay}`)?.scrap, true);
  assert.equal(repo.state().accounts.find(a => a.id === 'cumhuriyet').name, 'ATA');
  run(repo, 'silver', { type: 'stockAccount', name: 'gümüş', unit: 'GRAM', opening: '12.5', countPolicy: 'periodic', pairedGroups: [] });
  run(repo, 'rename', { type: 'stockUpdate', accountId: 'stock-silver', name: 'Gümüş ürün' });
  const a = repo.state().accounts.find(a => a.id === 'stock-silver');
  assert.equal(a.name, 'GÜMÜŞ ÜRÜN'); assert.equal(a.countPolicy, 'periodic'); assert.equal(a.isPurchasable, true);
  assert.equal(repo.state().balances[a.id], 12500);
  assert.throws(() => run(repo, 'invalid-stock', { type: 'stockAccount', name: 'Hatalı', unit: 'TL', opening: '0' }));
  assert.throws(() => run(repo, 'invalid-rename', { type: 'stockUpdate', accountId: 'nakit', name: 'Para' }));
  assert.deepEqual(replay(repo.events()).accounts.map(a => a.countPolicy ? { ...a, countPolicy: currentCountPolicy(a) } : a), repo.state().accounts);
});

test('sale accepts several scrap payments and optional explanation without inventing currency conversion', t => {
  const repo = fixture(t);
  run(repo, 'sale', { ...sale(), payments: [{ accountId: 'nakit', quantity: '300' }, { accountId: 'usd', quantity: '2', valueTL: '100' }], scrap: [{ accountId: 'hurda8', quantity: '1', valueTL: '100' }, { accountId: 'hurda24', quantity: '2', valueTL: '500' }] });
  const s = repo.state();
  assert.equal(s.balances.hurda8, 1000); assert.equal(s.balances.hurda24, 2000); assert.equal(s.balances.usd, 20200);
  assert.equal(s.journal.at(-1).meta.scrapLines.length, 2); assert.equal(s.journal.at(-1).meta.note, '');
  assert.deepEqual(s.moneyFlow.byUnit, { TL: { incoming: 30000, outgoing: 0 }, USD: { incoming: 200, outgoing: 0 } });
  const before = repo.state();
  assert.throws(() => run(repo, 'bad-scrap', { ...sale(), payments: [], scrap: [{ accountId: 'taki14', quantity: '1', valueTL: '1000' }] }));
  assert.deepEqual(repo.state(), before);
});

test('purchase tracks fully paid counterparty and disallows mixing typed customer/supplier accounts', t => {
  const repo = fixture(t);
  run(repo, 'customer', { type: 'account', name: 'Kişi', unit: 'TL', opening: '0', partyType: 'customer' });
  run(repo, 'supplier', { type: 'account', name: 'Firma', unit: 'TL', opening: '0', partyType: 'supplier' });
  const purchase = { type: 'purchase', source: 'customer', counterpartyId: 'cari-customer', items: [{ accountId: 'hurda18', quantity: '2.5', value: '500' }], payments: [{ accountId: 'nakit', quantity: '500' }], debts: [] };
  run(repo, 'purchase', purchase);
  assert.equal(repo.state().journal.at(-1).meta.counterpartyId, 'cari-customer');
  assert.equal(repo.state().balances.hurda18, 2500);
  assert.throws(() => run(repo, 'wrong-party', { ...purchase, counterpartyId: 'cari-supplier' }));
  assert.throws(() => run(repo, 'wrong-debt', { ...purchase, payments: [], debts: [{ accountId: 'cari-supplier', quantity: '500' }] }));
  assert.equal(repo.journalPage({ scope: 'all', accountId: 'cari-customer', type: 'purchase' }).total, 1);
});

test('foreign transfer and POS bank settlement allow empty notes and do not double count business flow', t => {
  const repo = fixture(t, [{ name: 'TL Bank', unit: 'TL', opening: '0' }, { name: 'USD Bank', unit: 'USD', opening: '0' }]);
  run(repo, 'sale', sale());
  run(repo, 'transfer', { type: 'transfer', fromAccount: 'usd', toAccount: 'bank-opening-1', quantity: '20' });
  run(repo, 'settlement', { type: 'settlement', gross: '100', fee: '3', bankAccount: 'bank-opening-0' });
  assert.equal(repo.state().balances['bank-opening-1'], 2000);
  assert.equal(repo.state().balances['bank-opening-0'], 9700);
  assert.equal(repo.state().moneyFlow.incoming, 100000); assert.equal(repo.state().moneyFlow.outgoing, 0);
  assert.deepEqual(repo.state({ compact: true }).moneyFlow, repo.state().moneyFlow);
});

test('amendment atomically reverses old effect and posts replacement while keeping edit provenance', t => {
  const repo = fixture(t); run(repo, 'sale', sale());
  const edited = run(repo, 'amend', { type: 'amend', originalId: 'sale', replacement: sale('750'), note: 'Yanlış tutar düzeltildi' }).state;
  assert.equal(edited.balances.nakit, 1075000); assert.equal(edited.balances.bilezikAdet, 9);
  assert.equal(edited.journal.at(-2).type, 'reverse'); assert.equal(edited.journal.at(-1).type, 'sale');
  assert.equal(edited.journal.at(-1).meta.amendsOriginalId, 'sale');
  assert.equal(repo.journalPage({ scope: 'all', type: 'sale' }).items.find(e => e.id === 'amend').editableCommand.items[0].value, '750');
  assert.ok(repo.journalPage({ scope: 'all' }).reversedIds.includes('sale'));
  assert.deepEqual(replay(repo.events()).balances, edited.balances);
  assert.equal(workdaySummary(edited).totals.sales, 75000);
  assert.equal(edited.moneyFlow.incoming, 75000); assert.equal(edited.moneyFlow.outgoing, 0);
});

test('amendment rejects invalid replacement, reversed sales and active returns without partial history', t => {
  const repo = fixture(t); run(repo, 'sale', sale());
  const before = repo.state(), events = repo.events();
  assert.throws(() => run(repo, 'bad', { type: 'amend', originalId: 'sale', replacement: { ...sale(), payments: [] }, note: 'Düzeltme' }));
  assert.deepEqual(repo.state(), before); assert.deepEqual(repo.events(), events);
  run(repo, 'return', { type: 'saleReturn', originalId: 'sale', items: [{ lineIndex: 0, quantity: '1', weight: '20', value: '1000' }], refunds: [{ accountId: 'nakit', quantity: '1000' }], note: 'İade' });
  assert.throws(() => run(repo, 'returned', { type: 'amend', originalId: 'sale', replacement: sale('750'), note: 'Düzeltme' }));
});

test('legacy event fields retain legacy meaning until explicit new schema opts in', t => {
  const repo = fixture(t); run(repo, 'account', { type: 'account', name: 'Old', unit: 'TL', opening: '0' });
  const events = repo.events(); events.at(-1).command.partyType = 'supplier'; events.at(-1).command.phone = 'legacy ignored';
  assert.equal(replay(events).accounts.find(a => a.id === 'cari-account').partyType, undefined);
  assert.throws(() => replay([{ ...events[0], schemaVersion: 6 }]));
});

test('amendment validates final balances instead of requiring temporary reversal cash to remain available', t => {
  const repo = fixture(t); run(repo, 'sale', sale());
  run(repo, 'spent', { type: 'movement', accountId: 'nakit', direction: 'out', category: 'İşletmeden çekiş', quantity: '11000' });
  assert.equal(repo.state().balances.nakit, 0);
  run(repo, 'amend-note', { type: 'amend', originalId: 'sale', replacement: { ...sale(), note: 'Düzeltilen açıklama' }, note: 'Yalnız açıklama değişti' });
  assert.equal(repo.state().balances.nakit, 0);
  const before = repo.state();
  assert.throws(() => run(repo, 'bad-final', { type: 'amend', originalId: 'amend-note', replacement: sale('999'), note: 'Yetersiz bakiye' }));
  assert.deepEqual(repo.state(), before);
  assert.deepEqual(replay(repo.events()).balances, before.balances);
});

test('ordinary money and stock notes are optional but opening correction and reversal reasons remain mandatory', t => {
  const repo = fixture(t, [{ name: 'Döviz Bankası', unit: 'USD', opening: '20' }]);
  run(repo, 'expense', { type: 'movement', accountId: 'bank-opening-0', category: 'Gider', direction: 'out', quantity: '5' });
  run(repo, 'stock', { type: 'stock', items: items(), category: 'Stok girişi', direction: 'in' });
  assert.equal(repo.state().balances['bank-opening-0'], 1500);
  assert.deepEqual(repo.state().moneyFlow.byUnit.USD, { incoming: 0, outgoing: 500 });
  assert.throws(() => run(repo, 'correction', { type: 'movement', accountId: 'nakit', category: 'Açılış düzeltmesi', direction: 'in', quantity: '1' }));
  assert.throws(() => run(repo, 'reverse', { type: 'reverse', originalId: 'expense', note: '' }));
  assert.equal(repo.journalPage({ type: 'money' }).total, 1);
  assert.equal(repo.journalPage({ type: 'inventory' }).total, 1);
  assert.equal(repo.journalPage({ type: 'setup' }).total, 1);
});

test('amended sales remain returnable, replayable and idempotent across a JSON restore', t => {
  const repo = fixture(t); run(repo, 'sale', sale());
  const amendment = { type: 'amend', originalId: 'sale', replacement: sale('900'), note: 'Bedel düzeltmesi' };
  run(repo, 'amend', amendment);
  assert.equal(run(repo, 'amend', amendment).duplicate, true);
  assert.throws(() => run(repo, 'old-again', { ...amendment, replacement: sale('800') }));
  assert.throws(() => run(repo, 'missing-reason', { ...amendment, originalId: 'amend', note: '' }));
  const target = new Repository(':memory:', 'demo'); t.after(() => target.close());
  target.restore({ backup: repo.backup(), revision: 0, confirmation: 'GERİ YÜKLE' });
  assert.deepEqual(target.state().balances, repo.state().balances);
  assert.deepEqual(target.state().moneyFlow, repo.state().moneyFlow);
  run(target, 'return-new', { type: 'saleReturn', originalId: 'amend', items: [{ lineIndex: 0, quantity: '1', weight: '20', value: '900' }], refunds: [{ accountId: 'nakit', quantity: '900' }], note: 'Düzeltilen satışın iadesi' });
  assert.equal(target.state().balances.bilezikAdet, 10);
  assert.equal(target.state().balances.nakit, 1000000);
});

test('new profile and stock commands reject invalid inputs without mutating stored state', t => {
  const repo = fixture(t);
  for (const changes of [{ phone: null }, { phone: '<script>' }, { address: 'x'.repeat(301) }, { partyType: 'other' }, { taxId: '1' }]) {
    const before = repo.state();
    assert.throws(() => run(repo, 'bad-profile', { type: 'account', name: 'Test', unit: 'TL', opening: '0', partyType: 'customer', ...changes }));
    assert.deepEqual(repo.state(), before);
  }
  for (const changes of [{ pairedGroups: ['taki14'], opening: '1' }, { pairedGroups: ['unknown'] }, { isSaleable: 'false' }, { countPolicy: 'none' }]) {
    const before = repo.state();
    assert.throws(() => run(repo, 'bad-stock', { type: 'stockAccount', name: 'Yeni', unit: 'ADET', opening: '0', ...changes }));
    assert.deepEqual(repo.state(), before);
  }
});

test('new named-bank opening retires the unused generic bank while legacy bank can be renamed', t => {
  const fresh = fixture(t, [{ name: 'A Bankası', unit: 'TL', opening: '10' }]);
  assert.equal(fresh.state().accounts.find(a => a.id === 'banka').retired, true);
  assert.throws(() => run(fresh, 'generic-transfer', { type: 'transfer', fromAccount: 'nakit', toAccount: 'banka', quantity: '1' }));
  const legacy = fixture(t);
  assert.equal(legacy.state().accounts.find(a => a.id === 'banka').retired, false);
  run(legacy, 'rename-bank', { type: 'fundUpdate', accountId: 'banka', name: 'Yerel Banka' });
  assert.equal(legacy.state().accounts.find(a => a.id === 'banka').name, 'Yerel Banka');
  assert.equal(legacy.state().balances.banka, 0);
  assert.equal(legacy.journalPage({ type: 'setup' }).total, 2);
  assert.deepEqual(replay(legacy.events()).accounts.map(a => a.countPolicy ? { ...a, countPolicy: currentCountPolicy(a) } : a), legacy.state().accounts);
  for (const command of [{ accountId: 'pos', name: 'POS' }, { accountId: 'nakit', name: 'Nakit USD', unit: 'USD' }, { accountId: 'banka', name: 'Nakit TL' }, { accountId: 'bilezikAdet', name: 'Stok' }]) {
    assert.throws(() => run(legacy, 'invalid-fund', { type: 'fundUpdate', ...command }));
  }
});

test('same and prior day cancellations show actual opposite flow instead of negative receipt cards', t => {
  const repo = fixture(t); run(repo, 'sale', sale());
  run(repo, 'cancel', { type: 'reverse', originalId: 'sale', note: 'Ürün ve ödeme geri verildi' });
  assert.equal(repo.state().moneyFlow.incoming, 100000); assert.equal(repo.state().moneyFlow.outgoing, 100000);
  run(repo, 'sale-two', sale());
  const state = repo.state();
  run(repo, 'close', { type: 'close', counts: Object.fromEntries(state.accounts.filter(a => a.physical && !a.retired && a.countPolicy === 'daily').map(a => [a.id, decimal(state.balances[a.id] || 0, a.unit)])), reasons: {}, approvedBy: 'Test' });
  run(repo, 'cancel-prior', { type: 'reverse', date: repo.state().date, originalId: 'sale-two', note: 'Önceki günün işlemi geri alındı' });
  assert.equal(repo.state().moneyFlow.incoming, 0); assert.equal(repo.state().moneyFlow.outgoing, 100000);
});

test('editing legacy contact details does not silently lock an unclassified supplier into customers', t => {
  const repo = fixture(t);
  run(repo, 'legacy-firm', { type: 'account', name: 'Eski firma', unit: 'TL', opening: '-250' });
  run(repo, 'phone-only', { type: 'accountUpdate', accountId: 'cari-legacy-firm', phone: '0500 000 00 00' });
  assert.equal(repo.state().accounts.find(a => a.id === 'cari-legacy-firm').partyType, undefined);
  run(repo, 'classify', { type: 'accountUpdate', accountId: 'cari-legacy-firm', partyType: 'supplier' });
  assert.equal(repo.state().accounts.find(a => a.id === 'cari-legacy-firm').partyType, 'supplier');
  assert.equal(repo.state().balances['cari-legacy-firm'], -25000);
  assert.throws(() => run(repo, 'change-history-kind', { type: 'accountUpdate', accountId: 'cari-legacy-firm', partyType: 'customer' }));
  assert.deepEqual(replay(repo.events()).accounts.map(a => a.countPolicy ? { ...a, countPolicy: currentCountPolicy(a) } : a), repo.state().accounts);
});

test('current legacy-shaped trade commands cannot bypass typed customer and supplier separation', t => {
  const repo = fixture(t);
  run(repo, 'customer', { type: 'account', name: 'Müşteri', unit: 'TL', opening: '0', partyType: 'customer' });
  run(repo, 'supplier', { type: 'account', name: 'Firma', unit: 'TL', opening: '0', partyType: 'supplier' });
  const oldSale = { type: 'sale', items: items(), cash: '0', pos: '0', bank: '0', scrapQuantity: '0', scrapValue: '0', customerAccount: 'cari-supplier', note: 'Eski biçim' };
  assert.throws(() => run(repo, 'wrong-sale', oldSale));
  assert.throws(() => run(repo, 'wrong-purchase', { type: 'purchase', source: 'supplier', items: items(), cash: '0', bank: '0', counterpartyAccount: 'cari-customer', note: 'Eski biçim' }));
  run(repo, 'right-sale', { ...oldSale, customerAccount: 'cari-customer' });
  assert.equal(repo.events().at(-1).schemaVersion, 5);
  assert.deepEqual(replay(repo.events()).balances, repo.state().balances);
});

test('undefined optional update and purchase fields retain identical cached and persisted meaning', t => {
  const repo = fixture(t);
  run(repo, 'customer', { type: 'account', name: 'Müşteri', unit: 'TL', opening: '0', partyType: 'customer', phone: '0500 000 00 00' });
  run(repo, 'undefined-contact', { type: 'accountUpdate', accountId: 'cari-customer', phone: undefined });
  run(repo, 'purchase', { type: 'purchase', source: 'customer', counterpartyId: undefined, items: items('500'), cash: '500', bank: '0', note: 'Peşin alış' });
  assert.equal(repo.state().accounts.find(a => a.id === 'cari-customer').phone, '0500 000 00 00');
  assert.deepEqual(replay(repo.events()).accounts.map(a => a.countPolicy ? { ...a, countPolicy: currentCountPolicy(a) } : a), repo.state().accounts);
  assert.doesNotThrow(() => repo.backup());
});

test('fully paid purchase cancellation stays in the named counterparty journal', t => {
  const repo = fixture(t);
  run(repo, 'party', { type: 'account', name: 'Özgün kişi', unit: 'TL', opening: '0', partyType: 'customer' });
  run(repo, 'purchase', { type: 'purchase', source: 'customer', counterpartyId: 'cari-party', items: items('500'), payments: [{ accountId: 'nakit', quantity: '500' }], debts: [] });
  run(repo, 'cancel-purchase', { type: 'reverse', originalId: 'purchase', note: 'İşlem geri alındı' });
  assert.equal(repo.journalPage({ scope: 'all', accountId: 'cari-party' }).items[0].id, 'cancel-purchase');
  assert.equal(repo.journalPage({ scope: 'all', q: 'ozgun kisi', type: 'reverse' }).total, 1);
  assert.equal(repo.state().balances['cari-party'], 0);
});
