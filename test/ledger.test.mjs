import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS, quantity, decimal, validDate, applyEvent, replay } from '../domain.mjs';

const opening = (overrides = {}, date = '2026-10-27') => ({
  type: 'opening', date,
  balances: { ...Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, '0'])), bilezik22: '100', bilezikAdet: '100', ...overrides }
});
function execute(repo, command, id = randomUUID()) {
  return repo.execute({ id, revision: repo.state().revision, command });
}
function initialized(t, overrides) {
  const repo = new Repository(); t.after(() => repo.close()); execute(repo, opening(overrides)); return repo;
}
function customer(repo, amount = '0', name = 'Örnek Müşteri', unit = 'TL') {
  const id = randomUUID(); execute(repo, { type: 'account', date: repo.state().date, name, unit, opening: amount }, id); return `cari-${id}`;
}
function sale(repo, customerAccount, overrides = {}) {
  const draft = { type: 'sale', date: repo.state().date, outAccount: 'bilezik22', outQuantity: '10', total: '60000',
    scrapQuantity: '6', scrapValue: '30000', cash: '10000', pos: '15000', bank: '0', customerAccount,
    productCategory: 'Bilezik', note: 'Örnek: hurda, nakit, kart ve kalan müşteri borcu', ...overrides };
  let item = { accountId: draft.outAccount, quantity: draft.outQuantity, value: draft.total };
  if (draft.outAccount === 'bilezik22') item = { accountId: 'bilezikAdet', quantity: '1', weightAccount: 'bilezik22', weight: draft.outQuantity, value: draft.total };
  if (draft.outAccount === 'gramToplam') item = { accountId: 'gramToplam', quantity: draft.outQuantity, value: draft.total };
  if (['taki14', 'taki22'].includes(draft.outAccount)) {
    const categoryIds = { Yüzük: 'yuzuk', Küpe: 'kupe', Kolye: 'kolye', Künye: 'kunye', Şahmeran: 'sahmeran', Diğer: 'digerTaki' };
    item = { accountId: categoryIds[draft.productCategory], quantity: '1', weightAccount: draft.outAccount, weight: draft.outQuantity, value: draft.total };
  }
  delete draft.outAccount; delete draft.outQuantity; delete draft.productCategory; delete draft.total;
  return { ...draft, items: overrides.items || [item] };
}
function countCommand(repo, overrides = {}, reasons = {}) {
  const s = repo.state();
  return { type: 'close', date: s.date, approvedBy: 'Test sorumlusu', reasons,
    counts: { ...Object.fromEntries(s.accounts.filter(a => a.physical && !a.retired && a.countPolicy === 'daily').map(a => [a.id, decimal(s.balances[a.id] || 0, a.unit)])), ...overrides } };
}
function unchangedAfterFailure(repo, callback, expected) {
  const before = repo.state(), events = repo.events();
  assert.throws(callback, expected);
  assert.deepEqual(repo.state(), before, 'Rejected transaction must not change state or revision');
  assert.deepEqual(repo.events(), events, 'Rejected transaction must not append any event');
}
const revenue = (s, date = s.date) => s.journal.filter(e => e.date === date).reduce((sum, e) => sum + (e.meta.revenue || 0), 0);

test('quantities use exact integer minor units and reject precision loss', () => {
  assert.equal(quantity('10.10', 'TL'), 1010);
  assert.equal(quantity('10,10', 'TL'), 1010);
  assert.equal(quantity('0.001', 'GRAM'), 1);
  assert.equal(quantity('-3.456', 'HAS', { signed: true }), -3456);
  assert.equal(quantity('12', 'ADET'), 12);
  assert.equal(decimal(1001, 'GRAM'), '1.001');
  for (const [value, unit] of [['1.001','TL'], ['1.0001','GRAM'], ['1.0','ADET'], ['1e3','TL'], ['1,000.00','TL'], ['NaN','TL'], ['Infinity','GRAM'], ['', 'TL'], ['-1','TL'], ['99999999999999999','TL']]) {
    assert.throws(() => quantity(value, unit), undefined, `${value} ${unit} must be rejected`);
  }
  assert.throws(() => quantity('0', 'TL', { zero: false }));
});

test('business date rejects normalization and out-of-range dates', () => {
  assert.equal(validDate('2024-02-29'), '2024-02-29');
  for (const date of ['2025-02-29', '2026-02-30', '2026-13-01', '2026-1-1', '1999-12-31', '2101-01-01']) assert.throws(() => validDate(date));
});

test('opening is mandatory, every asset requires an explicit value, and it can happen once', t => {
  const repo = new Repository(); t.after(() => repo.close());
  unchangedAfterFailure(repo, () => execute(repo, { type: 'movement', date: '2026-10-27' }), /başlangıç/i);
  const c = opening(); delete c.balances.usd;
  unchangedAfterFailure(repo, () => execute(repo, c), /açılış/i);
  unchangedAfterFailure(repo, () => execute(repo, opening({ usd: '' })), /ondalık|miktar/i);
  execute(repo, opening());
  unchangedAfterFailure(repo, () => execute(repo, opening()), /zaten/i);
  assert.equal(revenue(repo.state()), 0, 'Opening is not turnover');
});

test('mixed sale atomically posts metal, scrap, cash, POS and customer balance', t => {
  const repo = initialized(t); const accountId = customer(repo);
  const s = execute(repo, sale(repo, accountId)).state;
  assert.equal(s.balances.bilezik22, 90000);
  assert.equal(s.balances.bilezikAdet, 99);
  assert.equal(s.balances.hurda22, 6000);
  assert.equal(s.balances.nakit, 1000000);
  assert.equal(s.balances.pos, 1500000);
  assert.equal(s.balances[accountId], 500000);
  assert.equal(revenue(s), 6000000);
  assert.equal(s.journal.at(-1).entries.length, 6);
  assert.equal(s.journal.at(-1).meta.costKnown, false, 'No profit can be inferred without cost');
});

test('failed stock or invalid payment rejects the whole sale with no side effects', t => {
  const repo = initialized(t, { bilezik22: '1' }); const accountId = customer(repo);
  unchangedAfterFailure(repo, () => execute(repo, sale(repo, accountId)), /yetersiz/i);
  unchangedAfterFailure(repo, () => execute(repo, sale(repo, accountId, { outQuantity: '1', cash: '60001' })), /aşıyor/i);
  unchangedAfterFailure(repo, () => execute(repo, sale(repo, accountId, { outQuantity: '1', scrapValue: '0' })), /birlikte/i);
  unchangedAfterFailure(repo, () => execute(repo, sale(repo, 'missing', { outQuantity: '1' })), /bulunamadı/i);
});

test('payment remainder must use TL receivable, not another asset or foreign unit', t => {
  const repo = initialized(t); const has = customer(repo, '0', 'Has Cari', 'HAS');
  unchangedAfterFailure(repo, () => execute(repo, sale(repo, 'nakit')), /TL müşteri/i);
  unchangedAfterFailure(repo, () => execute(repo, sale(repo, has)), /TL müşteri/i);
});

test('idempotent retry returns existing state and conflicting reuse is rejected', t => {
  const repo = initialized(t); const accountId = customer(repo); const c = sale(repo, accountId);
  const id = randomUUID(); const revision = repo.state().revision;
  const first = repo.execute({ id, revision, command: c });
  const retry = repo.execute({ id, revision, command: c });
  assert.equal(first.duplicate, false); assert.equal(retry.duplicate, true);
  assert.deepEqual(first.state, retry.state);
  assert.equal(repo.events().filter(e => e.id === id).length, 1);
  unchangedAfterFailure(repo, () => repo.execute({ id, revision, command: { ...c, cash: '10001' } }), /farklı içerik/i);
});

test('optimistic revision rejects stale writes and stale count snapshots', t => {
  const repo = initialized(t); const revision = repo.state().revision; const close = countCommand(repo);
  execute(repo, { type: 'movement', date: repo.state().date, accountId: 'nakit', direction: 'in', quantity: '10', category: 'Sermaye', note: 'Test sermayesi' });
  unchangedAfterFailure(repo, () => repo.execute({ id: randomUUID(), revision, command: close }), /başka sekmede/i);
});

test('closing requires every count and a reason for each discrepancy', t => {
  const repo = initialized(t); const missing = countCommand(repo); delete missing.counts.nakit;
  unchangedAfterFailure(repo, () => execute(repo, missing), /boş/i);
  unchangedAfterFailure(repo, () => execute(repo, countCommand(repo, { nakit: '' })), /ondalık|miktar/i);
  unchangedAfterFailure(repo, () => execute(repo, countCommand(repo, { bilezikAdet: '99' })), /gerekçesi/i);
  const result = execute(repo, countCommand(repo, { bilezikAdet: '99' }, { bilezikAdet: 'Sayım farkı test gerekçesi' })).state;
  assert.equal(result.balances.bilezikAdet, 99);
  assert.equal(result.balances.bilezik22, 100000);
  assert.equal(result.closings[0].counts.find(x => x.accountId === 'bilezikAdet').difference, -1);
  assert.equal(result.journal.at(-1).date, '2026-10-27');
  assert.equal(result.date, '2026-10-28');
});

test('day carry preserves POS, customer, bank and physical balances without new sales', t => {
  const repo = initialized(t, { banka: '250', usd: '1.25' }); const accountId = customer(repo, '100');
  execute(repo, sale(repo, accountId)); const before = repo.state();
  const s = execute(repo, countCommand(repo)).state;
  assert.equal(s.date, '2026-10-28');
  assert.deepEqual(s.balances, before.balances);
  assert.equal(s.balances.pos, 1500000);
  assert.equal(s.balances[accountId], 510000);
  assert.equal(revenue(s), 0);
  assert.equal(s.journal.length, before.journal.length + 1);
  unchangedAfterFailure(repo, () => execute(repo, { type: 'movement', date: '2026-10-27', accountId: 'nakit', direction: 'in', quantity: '1', category: 'Sermaye', note: 'Kapalı güne yazma' }), /açık iş gününe/i);
});

test('POS settlement next day transfers receivable to bank, fee is expense and no new turnover', t => {
  const repo = initialized(t); const accountId = customer(repo); execute(repo, sale(repo, accountId)); execute(repo, countCommand(repo));
  const s = execute(repo, { type: 'settlement', date: repo.state().date, gross: '15000', fee: '300', note: 'Ertesi gün yüzde iki komisyon örneği' }).state;
  assert.equal(s.balances.pos, 0);
  assert.equal(s.balances.banka, 1470000);
  assert.equal(s.journal.at(-1).meta.expense, 30000);
  assert.equal(revenue(s), 0);
  unchangedAfterFailure(repo, () => execute(repo, { type: 'settlement', date: s.date, gross: '1', fee: '0', note: 'Yetersiz POS' }), /yetersiz/i);
  unchangedAfterFailure(repo, () => execute(repo, { type: 'settlement', date: s.date, gross: '1', fee: '2', note: 'Fazla kesinti' }), /büyük/i);
});

test('reversal of closed-day sale affects all linked movements on current day exactly once', t => {
  const repo = initialized(t); const accountId = customer(repo); const initial = repo.state().balances;
  const id = randomUUID(); execute(repo, sale(repo, accountId), id); execute(repo, countCommand(repo));
  const s = execute(repo, { type: 'reverse', date: repo.state().date, originalId: id, note: 'Kapalı gün satışının bugüne ters kaydı' }).state;
  for (const [key, value] of Object.entries(initial)) assert.equal(s.balances[key], value, key);
  assert.equal(s.balances[accountId], 0);
  assert.equal(s.journal.at(-1).date, '2026-10-28');
  assert.equal(s.journal.at(-1).entries.length, 6);
  assert.equal(revenue(s), -6000000);
  unchangedAfterFailure(repo, () => execute(repo, { type: 'reverse', date: s.date, originalId: id, note: 'İkinci ters kayıt' }), /zaten/i);
});

test('reversal rejects if later consumption makes a linked asset insufficient', t => {
  const repo = initialized(t); const accountId = customer(repo); const id = randomUUID(); execute(repo, sale(repo, accountId), id);
  execute(repo, { type: 'settlement', date: repo.state().date, gross: '15000', fee: '0', note: 'POS kapandı' });
  unchangedAfterFailure(repo, () => execute(repo, { type: 'reverse', date: repo.state().date, originalId: id, note: 'POS geri alınmadan iptal' }), /yetersiz/i);
});

test('customer collection and supplier payment are linked and do not create turnover', t => {
  const repo = initialized(t, { nakit: '1000' }); const buyer = customer(repo, '500'), supplier = customer(repo, '-250', 'Örnek Toptancı');
  const s1 = execute(repo, { type: 'collection', date: repo.state().date, customerAccount: buyer, target: 'nakit', quantity: '200', direction: 'collect', note: 'Eski borç tahsilatı' }).state;
  assert.equal(s1.balances[buyer], 30000); assert.equal(s1.balances.nakit, 120000); assert.equal(revenue(s1), 0);
  const s2 = execute(repo, { type: 'collection', date: repo.state().date, customerAccount: supplier, target: 'nakit', quantity: '100', direction: 'pay', note: 'Toptancıya kısmi ödeme' }).state;
  assert.equal(s2.balances[supplier], -15000); assert.equal(s2.balances.nakit, 110000); assert.equal(revenue(s2), 0);
  unchangedAfterFailure(repo, () => execute(repo, { type: 'collection', date: repo.state().date, customerAccount: buyer, target: 'nakit', quantity: '301', direction: 'collect', note: 'Borcu aşan tahsilat' }), /aşamaz/i);
  unchangedAfterFailure(repo, () => execute(repo, { type: 'collection', date: repo.state().date, customerAccount: buyer, target: 'nakit', quantity: '1', direction: 'pay', note: 'Yanlış yön' }), /aşamaz/i);
});

test('same customer can retain original currency units independently', t => {
  const repo = initialized(t); const tl = customer(repo, '100', 'Aynı Kişi'), has = customer(repo, '-10.125', 'Aynı Kişi', 'HAS');
  execute(repo, countCommand(repo)); const s = repo.state();
  assert.equal(s.balances[tl], 10000); assert.equal(s.balances[has], -10125);
  unchangedAfterFailure(repo, () => customer(repo, '0', 'Aynı Kişi', 'TL'), /zaten/i);
});

test('backup roundtrip restores the entire valid history and archives replaced data', t => {
  const source = initialized(t); const a = customer(source); execute(source, sale(source, a)); execute(source, countCommand(source));
  const backup = source.backup(); const target = initialized(t, { nakit: '9' }); const replaced = target.backup(); const rev = target.state().revision;
  const state = target.restore({ backup, revision: rev, confirmation: 'GERİ YÜKLE' });
  assert.deepEqual(target.events(), source.events());
  assert.equal(state.date, source.state().date); assert.deepEqual(state.balances, source.state().balances);
  assert.equal(state.revision, rev + 1);
  const archive = target.db.prepare('SELECT body FROM restore_archive').all();
  assert.equal(archive.length, 1);
  const saved = JSON.parse(archive[0].body);
  assert.deepEqual(saved.events, replaced.events);
  assert.equal(saved.sha256, replaced.sha256);
});

test('tampered, invalid-history, unconfirmed and stale backups never replace active data', t => {
  const repo = initialized(t); const backup = repo.backup();
  const tampered = structuredClone(backup); tampered.events[0].command.balances.nakit = '999';
  unchangedAfterFailure(repo, () => repo.restore({ backup: tampered, revision: repo.state().revision, confirmation: 'GERİ YÜKLE' }), /bütünlük/i);
  const invalid = structuredClone(backup); invalid.events[0].command.balances.nakit = '-1';
  invalid.sha256 = createHash('sha256').update(JSON.stringify(invalid.events)).digest('hex');
  unchangedAfterFailure(repo, () => repo.restore({ backup: invalid, revision: repo.state().revision, confirmation: 'GERİ YÜKLE' }), /ondalık|miktar/i);
  unchangedAfterFailure(repo, () => repo.restore({ backup, revision: repo.state().revision, confirmation: '' }), /onayı/i);
  unchangedAfterFailure(repo, () => repo.restore({ backup, revision: repo.state().revision - 1, confirmation: 'GERİ YÜKLE' }), /değişti/i);
  assert.equal(repo.db.prepare('SELECT count(*) AS n FROM restore_archive').get().n, 0);
});

test('backup replay rejects duplicate identifiers even if its checksum was recomputed', t => {
  const repo = initialized(t); const backup = repo.backup();
  backup.events.push(structuredClone(backup.events[0]));
  backup.sha256 = createHash('sha256').update(JSON.stringify(backup.events)).digest('hex');
  unchangedAfterFailure(repo, () => repo.restore({ backup, revision: repo.state().revision, confirmation: 'GERİ YÜKLE' }), /Tekrarlanan/i);
});

test('reversal of a settlement restores POS and fee without inventing sales', t => {
  const repo = initialized(t, { pos: '15000' });
  const id = randomUUID();
  execute(repo, { type: 'settlement', date: repo.state().date, gross: '15000', fee: '300', note: 'POS tahsilatı örneği' }, id);
  const s = execute(repo, { type: 'reverse', date: repo.state().date, originalId: id, note: 'Yanlış bankaya geçiş kaydının tersi' }).state;
  assert.equal(s.balances.pos, 1500000);
  assert.equal(s.balances.banka, 0);
  assert.equal(s.journal.at(-1).meta.expense, -30000);
  assert.equal(revenue(s), 0);
});

test('SQLite survives restart and reads the committed state from an independent connection', t => {
  const folder = mkdtempSync(join(tmpdir(), 'kuyumcu-test-')); const filename = join(folder, 'test.sqlite');
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  let repo = new Repository(filename); execute(repo, opening({ nakit: '123.45' }));
  const a = customer(repo); execute(repo, sale(repo, a)); const expected = repo.state(); repo.close();
  repo = new Repository(filename);
  try { assert.deepEqual(repo.state(), expected); } finally { repo.close(); }
});

test('two database connections cannot overwrite one another using a stale revision', t => {
  const folder = mkdtempSync(join(tmpdir(), 'kuyumcu-concurrency-')); const filename = join(folder, 'test.sqlite');
  const first = new Repository(filename), second = new Repository(filename);
  t.after(() => { first.close(); second.close(); rmSync(folder, { recursive: true, force: true }); });
  execute(first, opening()); const revision = second.state().revision;
  execute(first, { type: 'movement', date: first.state().date, accountId: 'nakit', direction: 'in', quantity: '100', category: 'Sermaye', note: 'İlk bağlantı' });
  unchangedAfterFailure(second, () => second.execute({ id: randomUUID(), revision, command: { type: 'movement', date: second.state().date, accountId: 'nakit', direction: 'in', quantity: '100', category: 'Sermaye', note: 'Eski ekrandan ikinci bağlantı' } }), /başka sekmede/i);
  assert.equal(second.state().balances.nakit, 10000);
});

test('movement labels cannot bypass linked receivable rules or misclassify direction and units', t => {
  const repo = initialized(t, { nakit: '100', usd: '10', pos: '10' }); const a = customer(repo, '10');
  const move = (accountId, direction, category) => ({ type: 'movement', date: repo.state().date, accountId, direction, category, quantity: '1', note: 'Kategori koruması denetimi' });
  for (const command of [move(a, 'in', 'Sermaye'), move(a, 'out', 'Gider'), move('nakit', 'in', 'Gider'), move('pos', 'out', 'Gider'), move('nakit', 'in', 'Stok girişi'), move('bilezik22', 'out', 'Stok girişi'), move('nakit', 'out', 'Sermaye'), move('nakit', 'in', 'İşletmeden çekiş'), move('pos', 'in', 'Sermaye'), move('pos', 'out', 'İşletmeden çekiş')]) {
    unchangedAfterFailure(repo, () => execute(repo, command));
  }
  execute(repo, move(a, 'out', 'Açılış düzeltmesi'));
  assert.equal(repo.state().balances[a], 900);
  execute(repo, move('nakit', 'out', 'Gider'));
  assert.equal(repo.state().journal.at(-1).meta.expense, 100);
  execute(repo, move('usd', 'out', 'Gider'));
  assert.equal(repo.state().balances.usd, 900);
  assert.equal(repo.state().journal.at(-1).meta.expense, 0, 'USD expense is not silently added to the TL expense total.');
});

test('public event reducer leaves its input state unchanged on success and rejection', () => {
  const previous = replay([{ id: 'open-immutable', schemaVersion: 3, timestamp: '2026-10-27T10:00:00Z', command: opening() }]);
  const snapshot = structuredClone(previous);
  function freeze(value) {
    if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
    return value;
  }
  freeze(previous);
  const next = applyEvent(previous, { id: 'move-immutable', schemaVersion: 3, timestamp: '2026-10-27T10:01:00Z', command: { type: 'movement', date: previous.date, accountId: 'nakit', direction: 'in', quantity: '10', category: 'Sermaye', note: 'Immutable reducer denetimi' } });
  assert.deepEqual(previous, snapshot);
  assert.equal(next.balances.nakit, 1000);
  assert.equal(next.journal.length, previous.journal.length + 1);
  assert.throws(() => applyEvent(previous, { id: 'invalid-immutable', schemaVersion: 3, timestamp: '2026-10-27T10:02:00Z', command: { type: 'movement', date: previous.date, accountId: 'nakit', direction: 'out', quantity: '10', category: 'İşletmeden çekiş', note: 'Yetersiz varlık denetimi' } }));
  assert.deepEqual(previous, snapshot);
});

test('daily product categories retain piece counts and grams in separate 14 and 22 assay stock groups', t => {
  const repo = initialized(t, { taki14: '20.000', taki22: '30.000', yuzuk: '10', kolye: '10' });
  for (const [outAccount, productCategory, outQuantity] of [['taki14', 'Yüzük', '1.234'], ['taki22', 'Kolye', '2.345']]) {
    const s = execute(repo, sale(repo, '', { outAccount, outQuantity, productCategory, total: '1000', scrapQuantity: '0', scrapValue: '0', cash: '1000', pos: '0', bank: '0' })).state;
    assert.equal(s.accounts.find(a => a.id === outAccount).unit, 'GRAM');
  }
  const s = repo.state();
  assert.equal(s.balances.taki14, 18766);
  assert.equal(s.balances.taki22, 27655);
  assert.equal(s.balances.yuzuk, 9);
  assert.equal(s.balances.kolye, 9);
  assert.equal(s.balances.bilezik22, 100000);
  execute(repo, countCommand(repo));
  assert.equal(repo.state().balances.taki14, 18766);
  assert.equal(repo.state().balances.taki22, 27655);
});

test('sarrafiye and watch stock keep whole pieces while gram gold keeps milligram precision', t => {
  const repo = initialized(t, { yarim: '5', ziynet: '5', cumhuriyet: '5', resat: '5', gramToplam: '5.000', saat: '5' });
  for (const [outAccount, productCategory] of [['yarim', 'Yarım'], ['ziynet', 'Ziynet'], ['cumhuriyet', 'Cumhuriyet'], ['resat', 'Reşat'], ['saat', 'Saat']]) {
    execute(repo, sale(repo, '', { outAccount, productCategory, outQuantity: '1', total: '100', scrapQuantity: '0', scrapValue: '0', cash: '100', pos: '0', bank: '0' }));
    assert.equal(repo.state().balances[outAccount], 4);
    unchangedAfterFailure(repo, () => execute(repo, sale(repo, '', { outAccount, productCategory, outQuantity: '0.5', total: '100', scrapQuantity: '0', scrapValue: '0', cash: '100', pos: '0', bank: '0' })), /ondalık/i);
  }
  execute(repo, sale(repo, '', { outAccount: 'gramToplam', productCategory: 'Gram', outQuantity: '0.125', total: '100', scrapQuantity: '0', scrapValue: '0', cash: '100', pos: '0', bank: '0' }));
  assert.equal(repo.state().balances.gramToplam, 4875);
  assert.equal(repo.state().balances.gramAdet, 0);
  assert.equal(repo.state().balances.gramaltin, 0);
});

test('jewelry sales require their paired assay group and a positive measured total weight', t => {
  const repo = initialized(t, { taki14: '10', taki22: '20', yuzuk: '10' });
  for (const item of [
    { accountId: 'yuzuk', quantity: '1', value: '10' },
    { accountId: 'yuzuk', quantity: '1', weightAccount: 'bilezik22', weight: '1', value: '10' },
    { accountId: 'yuzuk', quantity: '1', weightAccount: 'taki14', weight: '0', value: '10' },
    { accountId: 'taki14', quantity: '1', value: '10' }
  ]) {
    unchangedAfterFailure(repo, () => execute(repo, sale(repo, '', { items: [item], total: '10', cash: '10', pos: '0', scrapQuantity: '0', scrapValue: '0' })));
  }
  assert.equal(repo.state().accounts.find(a => a.id === 'taki14').countGroup, 'ana-terazi');
  assert.equal(repo.state().accounts.find(a => a.id === 'taki22').countGroup, 'ana-terazi');
  assert.equal(repo.state().accounts.find(a => a.id === 'bilezik22').countGroup, 'ana-terazi');
  assert.notEqual(repo.state().accounts.find(a => a.id === 'hurda22').countGroup, 'ana-terazi');
});

const twoBraceletsSale = repo => ({ type: 'sale', date: repo.state().date, items: [
  { accountId: 'kunye', quantity: '1', weightAccount: 'taki14', weight: '5.250', value: '25000' },
  { accountId: 'kunye', quantity: '1', weightAccount: 'taki22', weight: '6.000', value: '35000' }
], scrapQuantity: '0', scrapValue: '0', cash: '60000', pos: '0', bank: '0', note: 'İki künye: biri 14, biri 22 ayar; ölçülmüş toplam gramlar' });

test('one sale of two bracelets posts two daily pieces and both assay gram movements once', t => {
  const repo = initialized(t, { kunye: '10', taki14: '50.000', taki22: '60.000' });
  const s = execute(repo, twoBraceletsSale(repo)).state;
  assert.equal(s.balances.kunye, 8);
  assert.equal(s.balances.taki14, 44750);
  assert.equal(s.balances.taki22, 54000);
  assert.equal(s.balances.nakit, 6000000);
  assert.equal(revenue(s), 6000000, 'Sum line values once; do not repeat price for count and gram dimensions');
  assert.equal(s.journal.at(-1).entries.filter(e => e.accountId === 'kunye').reduce((sum, e) => sum + e.delta, 0), -2);
  assert.equal(s.journal.at(-1).entries.filter(e => e.accountId === 'taki14').reduce((sum, e) => sum + e.delta, 0), -5250);
  assert.equal(s.journal.at(-1).entries.filter(e => e.accountId === 'taki22').reduce((sum, e) => sum + e.delta, 0), -6000);
});

test('reversal restores daily pieces and both assay groups together without double value', t => {
  const repo = initialized(t, { kunye: '10', taki14: '50.000', taki22: '60.000' });
  const before = repo.state(), id = randomUUID();
  execute(repo, twoBraceletsSale(repo), id);
  const s = execute(repo, { type: 'reverse', date: repo.state().date, originalId: id, note: 'İki ayarlı künye satışının tamamının tersi' }).state;
  assert.deepEqual(s.balances, before.balances);
  assert.equal(revenue(s), 0);
  assert.equal(s.journal.at(-1).meta.revenue, -6000000);
});

test('day carry preserves daily pieces and two assay grams and next day turnover starts at zero', t => {
  const repo = initialized(t, { kunye: '10', taki14: '50.000', taki22: '60.000' });
  execute(repo, twoBraceletsSale(repo)); const before = repo.state();
  const s = execute(repo, countCommand(repo)).state;
  assert.deepEqual(s.balances, before.balances);
  assert.equal(s.balances.kunye, 8); assert.equal(s.balances.taki14, 44750); assert.equal(s.balances.taki22, 54000);
  assert.equal(revenue(s), 0);
  assert.equal(revenue(s, before.date), 6000000);
});

test('line weight is the measured total and is never automatically multiplied by piece quantity', t => {
  const repo = initialized(t, { kunye: '10', taki14: '50.000' });
  const c = twoBraceletsSale(repo);
  c.items = [{ accountId: 'kunye', quantity: '2', weightAccount: 'taki14', weight: '5.250', value: '60000' }];
  const s = execute(repo, c).state;
  assert.equal(s.balances.kunye, 8);
  assert.equal(s.balances.taki14, 44750);
  assert.equal(revenue(s), 6000000);
});

test('multi-line sale rejects insufficient shared piece or assay totals without partial posting', t => {
  const repo = initialized(t, { kunye: '1', taki14: '50', taki22: '60' });
  unchangedAfterFailure(repo, () => execute(repo, twoBraceletsSale(repo)), /yetersiz/i);
  execute(repo, { type: 'movement', date: repo.state().date, accountId: 'kunye', direction: 'in', category: 'Açılış düzeltmesi', quantity: '9', note: 'Örnek adet açılışının düzeltilmesi' });
  const c = twoBraceletsSale(repo); c.items[1].weight = '60.001';
  unchangedAfterFailure(repo, () => execute(repo, c), /yetersiz/i);
});

test('stock introduction and owner withdrawal move daily pieces and measured grams together', t => {
  const repo = initialized(t); const before = repo.state(); const id = randomUUID();
  const command = { type: 'stock', date: before.date, direction: 'in', category: 'Stok girişi', note: 'İki farklı ayarda künye stok girişi', items: twoBraceletsSale(repo).items.map(({ value, ...item }) => item) };
  const s = execute(repo, command, id).state;
  assert.equal(s.balances.kunye, 2); assert.equal(s.balances.taki14, 5250); assert.equal(s.balances.taki22, 6000);
  assert.equal(revenue(s), 0); assert.equal(s.balances.nakit, before.balances.nakit);
  const withdrawn = execute(repo, { ...command, direction: 'out', category: 'İşletmeden çekiş', note: 'Bağlı stok çıkış örneği' }).state;
  assert.equal(withdrawn.balances.kunye, 0); assert.equal(withdrawn.balances.taki14, 0); assert.equal(withdrawn.balances.taki22, 0);
  assert.equal(revenue(withdrawn), 0);
  unchangedAfterFailure(repo, () => execute(repo, { ...command, direction: 'out' }), /uyumsuz/i);
});

test('v2 simple movements cannot silently update one side of paired piece and gram stock', t => {
  const repo = initialized(t);
  for (const accountId of ['bilezikAdet', 'bilezik22', 'kunye', 'taki14', 'taki22']) {
    unchangedAfterFailure(repo, () => execute(repo, { type: 'movement', date: repo.state().date, accountId, direction: 'in', category: 'Stok girişi', quantity: '1', note: 'Tek boyutla giriş engeli' }), /birlikte izlenir/i);
  }
});

test('legacy single-dimension history is replayed without fabricating daily piece quantities', () => {
  const balances = Object.fromEntries(INITIAL_ACCOUNTS.filter(a => (a.introduced || 1) <= 1).map(a => [a.id, a.id === 'bilezik22' ? '100' : '0']));
  const events = [
    { id: 'legacy-opening', timestamp: '2026-10-27T09:00:00Z', command: { type: 'opening', date: '2026-10-27', balances } },
    { id: 'legacy-sale', timestamp: '2026-10-27T10:00:00Z', command: { type: 'sale', date: '2026-10-27', outAccount: 'bilezik22', outQuantity: '10', total: '60000', scrapQuantity: '0', scrapValue: '0', cash: '60000', pos: '0', bank: '0', productCategory: 'Bilezik', note: 'Eski yalnız gramlı örnek satış' } }
  ];
  const s = replay(events);
  assert.equal(s.balances.bilezik22, 90000); assert.equal(s.balances.bilezikAdet, 0);
  assert.equal(s.journal.at(-1).meta.legacySingleDimension, true);
  assert.equal(revenue(s), 6000000);
  assert.throws(() => replay([{ ...events[0], schemaVersion: 2 }]), /açılışını girin/i, 'New openings cannot silently default missing daily quantities to zero');
});

test('new live requests cannot invoke the legacy single-dimension sale path', t => {
  const repo = initialized(t);
  unchangedAfterFailure(repo, () => execute(repo, { type: 'sale', date: repo.state().date, outAccount: 'bilezik22', outQuantity: '10', total: '60000', scrapQuantity: '0', scrapValue: '0', cash: '60000', pos: '0', bank: '0', note: 'Eski istek yeni kayıtta kabul edilmez' }), /ürün satırı/i);
});

test('old daily closings replay without fabricating measurements for newly introduced piece accounts', () => {
  const oldAccounts = INITIAL_ACCOUNTS.filter(a => (a.introduced || 1) <= 1);
  const balances = Object.fromEntries(oldAccounts.map(a => [a.id, a.id === 'bilezik22' ? '100' : '0']));
  const oldCounts = Object.fromEntries(oldAccounts.filter(a => a.physical).map(a => [a.id, balances[a.id]]));
  const events = [
    { id: 'legacy-open-before-close', timestamp: '2026-10-27T09:00:00Z', command: { type: 'opening', date: '2026-10-27', balances } },
    { id: 'legacy-close', timestamp: '2026-10-27T20:00:00Z', command: { type: 'close', date: '2026-10-27', counts: oldCounts, reasons: {}, approvedBy: 'Eski sürüm sayım sorumlusu' } }
  ];
  const s = replay(events);
  assert.equal(s.date, '2026-10-28');
  assert.equal(s.balances.bilezik22, 100000);
  assert.equal(s.balances.bilezikAdet, 0);
  assert.equal(s.closings[0].counts.some(row => row.accountId === 'bilezikAdet'), false);
  assert.throws(() => replay([events[0], { ...events[1], schemaVersion: 2 }]), /sayım boş/i);
});

test('reversing a paired stock introduction restores daily pieces and gram pools together', t => {
  const repo = initialized(t); const before = repo.state(); const id = randomUUID();
  execute(repo, { type: 'stock', date: before.date, direction: 'in', category: 'Stok girişi', note: 'Ters kayıt denetimi için bağlı stok', items: twoBraceletsSale(repo).items.map(({ value, ...item }) => item) }, id);
  const s = execute(repo, { type: 'reverse', date: repo.state().date, originalId: id, note: 'Stok girişinin tamamının iptali' }).state;
  assert.deepEqual(s.balances, before.balances);
  assert.equal(revenue(s), 0);
});

test('sample backup cannot replace the real-shop workspace or vice versa', t => {
  const demo = new Repository(':memory:', 'demo'), shop = new Repository(':memory:', 'dukkan');
  t.after(() => { demo.close(); shop.close(); });
  execute(demo, opening({ nakit: '100' })); execute(shop, opening({ nakit: '50' }));
  unchangedAfterFailure(shop, () => shop.restore({ backup: demo.backup(), revision: shop.state().revision, confirmation: 'GERİ YÜKLE' }), /çalışma alanı eşleşmiyor/i);
  unchangedAfterFailure(demo, () => demo.restore({ backup: shop.backup(), revision: demo.state().revision, confirmation: 'GERİ YÜKLE' }), /çalışma alanı eşleşmiyor/i);
});
