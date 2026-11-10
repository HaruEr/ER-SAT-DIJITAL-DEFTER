import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS, decimal, replay } from '../domain.mjs';

const active = a => !a.retired;
const daily = a => a.physical && active(a) && a.countPolicy === 'daily';
const periodic = a => a.physical && active(a) && a.countPolicy === 'periodic';
const version = a => a.introduced || 1;
const digest = events => createHash('sha256').update(JSON.stringify(events)).digest('hex');
function repository(t) { const repo = new Repository(':memory:', 'test'); t.after(() => repo.close()); return repo; }
function execute(repo, command, id = randomUUID()) { return repo.execute({ id, revision: repo.state().revision, command }); }
function opening(overrides = {}) { return { type: 'opening', date: '2026-10-27', balances: { ...Object.fromEntries(INITIAL_ACCOUNTS.filter(active).map(a => [a.id, '0'])), bilezikAdet: '100', bilezik22: '1205', gramToplam: '243', ...overrides } }; }
function initialized(t, overrides = {}) { const repo = repository(t); execute(repo, opening(overrides)); return repo; }
function closing(repo, overrides = {}, reasons = {}) { const s = repo.state(); return { type: 'close', date: s.date, approvedBy: 'Bağımsız test', counts: { ...Object.fromEntries(s.accounts.filter(daily).map(a => [a.id, decimal(s.balances[a.id] || 0, a.unit)])), ...overrides }, reasons }; }
function stocktake(repo, counts, reasons = {}) { return { type: 'stocktake', date: repo.state().date, counts, reasons, approvedBy: 'Bağımsız test' }; }
function sale(repo, items, cash = '100') { return { type: 'sale', date: repo.state().date, items, scrapQuantity: '0', scrapValue: '0', cash, pos: '0', bank: '0', note: 'Bağımsız kabul senaryosu' }; }
function unchanged(repo, callback) { const before = repo.state(), history = repo.events(); assert.throws(callback); assert.deepEqual(repo.state(), before); assert.deepEqual(repo.events(), history); }
function revenue(s, date = s.date) { return s.journal.filter(e => e.date === date).reduce((sum, e) => sum + (e.meta.revenue || 0), 0); }
function backup(events) { return { format: 'kuyumcu-defter-v1', workspace: 'test', exportedAt: '2026-10-27T12:00:00Z', events, sha256: digest(events) }; }
function restoreEvents(repo, events) { return repo.restore({ backup: backup(events), revision: repo.state().revision, confirmation: 'GERİ YÜKLE' }); }
function legacyV2Events({ withClose = false } = {}) {
  const oldAccounts = INITIAL_ACCOUNTS.filter(a => version(a) <= 2);
  const balances = Object.fromEntries(oldAccounts.map(a => [a.id, '0']));
  Object.assign(balances, { bilezikAdet: '100', bilezik22: '1205', gramAdet: '10', gramaltin: '100' });
  const events = [
    { id: 'legacy-v2-opening', schemaVersion: 2, timestamp: '2026-10-27T09:00:00Z', command: { type: 'opening', date: '2026-10-27', balances } },
    { id: 'legacy-v2-gram-sale', schemaVersion: 2, timestamp: '2026-10-27T10:00:00Z', command: { type: 'sale', date: '2026-10-27', items: [{ accountId: 'gramAdet', quantity: '1', weightAccount: 'gramaltin', weight: '10', value: '100' }], scrapQuantity: '0', scrapValue: '0', cash: '100', pos: '0', bank: '0', note: 'Eski sürümün paket ve gram bağlı kaydı' } }
  ];
  if (withClose) {
    const counts = Object.fromEntries(oldAccounts.filter(a => a.physical).map(a => [a.id, balances[a.id]]));
    Object.assign(counts, { gramAdet: '9', gramaltin: '90', nakit: '100' });
    events.push({ id: 'legacy-v2-closing', schemaVersion: 2, timestamp: '2026-10-27T20:00:00Z', command: { type: 'close', date: '2026-10-27', counts, reasons: {}, approvedBy: 'Eski sayım' } });
  }
  return events;
}

test('v3 policies distinguish daily nominal grams from periodic scale grams', () => {
  const a = id => INITIAL_ACCOUNTS.find(x => x.id === id);
  assert.equal(a('gramToplam').unit, 'GRAM'); assert.equal(a('gramToplam').countPolicy, 'daily');
  assert.equal(a('gramToplam').isSaleable, true); assert.deepEqual(a('gramToplam').pairedGroups, []);
  for (const id of ['bilezik22', 'taki14', 'taki22']) assert.equal(a(id).countPolicy, 'periodic');
  assert.equal(a('gramAdet').retired, true); assert.equal(a('gramaltin').retired, true);
});
test('new opening requires explicit nominal total, accepts zero and omits retired fields', t => {
  const repo = repository(t), incomplete = opening(); delete incomplete.balances.gramToplam;
  unchanged(repo, () => execute(repo, incomplete));
  const s = execute(repo, opening({ gramToplam: '0' })).state;
  assert.equal(s.balances.gramToplam, 0); assert.equal(s.nominalUnconfirmed, false); assert.equal(repo.events()[0].schemaVersion, 3);
});
test('user example combines daily pieces, periodic scale carry and nominal gold without false measurements', t => {
  const repo = initialized(t);
  let s = execute(repo, { type: 'stock', date: repo.state().date, direction: 'in', category: 'Stok girişi', note: 'Bir adet 22 ayar, toplam 20,22 gram bilezik', items: [{ accountId: 'bilezikAdet', quantity: '1', weightAccount: 'bilezik22', weight: '20.22' }] }).state;
  assert.equal(s.balances.bilezikAdet, 101); assert.equal(s.balances.bilezik22, 1225220);
  const oldPackage = s.balances.gramAdet, oldWeight = s.balances.gramaltin;
  s = execute(repo, sale(repo, [{ accountId: 'gramToplam', quantity: '10', value: '100' }])).state;
  assert.equal(s.balances.gramToplam, 233000); assert.equal(s.balances.gramAdet, oldPackage); assert.equal(s.balances.gramaltin, oldWeight);
  const before = s; s = execute(repo, closing(repo)).state;
  assert.equal(s.date, '2026-10-28'); assert.equal(s.balances.bilezikAdet, 101); assert.equal(s.balances.bilezik22, 1225220); assert.equal(s.balances.gramToplam, 233000);
  assert.equal(revenue(s), 0); assert.equal(revenue(s, before.date), 10000);
  const carry = s.closings.at(-1).carried.find(x => x.accountId === 'bilezik22');
  assert.equal(carry.expected, 1225220); assert.equal(carry.counted, null); assert.equal(carry.status, 'not-counted');
  assert.equal(s.journal.at(-1).entries.some(e => e.accountId === 'bilezik22'), false);
  s = execute(repo, stocktake(repo, { bilezik22: '1225' }, { bilezik22: 'Dönemsel terazi sayımında 0,22 gram fark' })).state;
  assert.equal(s.date, '2026-10-28'); assert.equal(s.balances.bilezikAdet, 101); assert.equal(s.balances.bilezik22, 1225000); assert.equal(s.balances.gramToplam, 233000);
  assert.equal(s.stocktakes.at(-1).counts[0].difference, -220);
});
test('daily close rejects missing or blank daily counts but requires no scale counts', t => {
  const repo = initialized(t), missing = closing(repo); delete missing.counts.bilezikAdet;
  unchanged(repo, () => execute(repo, missing)); unchanged(repo, () => execute(repo, closing(repo, { gramToplam: '' })));
  const s = execute(repo, closing(repo)).state;
  assert.equal(s.closings.at(-1).counts.some(r => r.accountId === 'gramToplam'), true);
  assert.equal(s.closings.at(-1).counts.some(r => r.accountId === 'bilezik22'), false); assert.equal(s.balances.bilezik22, 1205000);
});
test('daily piece discrepancy never invents a gram conversion', t => {
  const repo = initialized(t); unchanged(repo, () => execute(repo, closing(repo, { bilezikAdet: '99' })));
  const s = execute(repo, closing(repo, { bilezikAdet: '99' }, { bilezikAdet: 'Fiziki adet farkı; eksik ürün araştırılıyor' })).state;
  assert.equal(s.balances.bilezikAdet, 99); assert.equal(s.balances.bilezik22, 1205000);
  assert.equal(s.closings.at(-1).counts.find(r => r.accountId === 'bilezikAdet').difference, -1);
});
test('periodic and retired counts cannot masquerade as a new daily count', t => {
  const repo = initialized(t);
  for (const id of ['bilezik22', 'taki14', 'taki22', 'gramAdet', 'gramaltin']) unchanged(repo, () => execute(repo, closing(repo, { [id]: '0' })));
});
test('periodic stocktake accepts a subset without changing the day or piece count', t => {
  const repo = initialized(t, { taki14: '50', taki22: '60' }), before = repo.state();
  const s = execute(repo, stocktake(repo, { taki14: '49.875' }, { taki14: 'Dönemsel tartım farkı' })).state;
  assert.equal(s.date, before.date); assert.equal(s.closings.length, before.closings.length); assert.equal(s.balances.taki14, 49875);
  assert.equal(s.balances.taki22, before.balances.taki22); assert.equal(s.balances.bilezikAdet, 100);
  assert.equal(s.stocktakes.length, 1); assert.equal(s.stocktakes[0].counts.length, 1); assert.equal(s.journal.at(-1).type, 'stocktake'); assert.equal(revenue(s), 0);
});
test('stocktake rejects empty, blank, negative, imprecise and wrong-policy measurements atomically', t => {
  const repo = initialized(t);
  for (const counts of [{}, { bilezik22: '' }, { bilezik22: '-1' }, { bilezik22: '1.0001' }, { bilezik22: null }, { bilezikAdet: '100' }, { nakit: '0' }, { gramToplam: '243' }, { gramAdet: '0' }, { gramaltin: '0' }, { unknown: '0' }]) unchanged(repo, () => execute(repo, stocktake(repo, counts)));
  unchanged(repo, () => execute(repo, stocktake(repo, { bilezik22: '1204' })));
  const s = execute(repo, stocktake(repo, { bilezik22: '1205' })).state; assert.equal(s.stocktakes[0].counts[0].difference, 0);
});
test('stocktake requires approval and preserves optimistic snapshot boundaries', t => {
  const repo = initialized(t); unchanged(repo, () => execute(repo, { ...stocktake(repo, { bilezik22: '1205' }), approvedBy: '' }));
  const revision = repo.state().revision, command = stocktake(repo, { bilezik22: '1205' });
  execute(repo, { type: 'movement', date: repo.state().date, accountId: 'nakit', quantity: '1', direction: 'in', category: 'Sermaye', note: 'Sayım sırasında hareket' });
  unchanged(repo, () => repo.execute({ id: randomUUID(), revision, command }));
});
test('nominal gold sale reduces total grams without counting packages', t => {
  const repo = initialized(t), before = repo.state();
  const s = execute(repo, sale(repo, [{ accountId: 'gramToplam', quantity: '10.125', value: '100' }])).state;
  assert.equal(s.balances.gramToplam, 232875); assert.equal(s.balances.gramAdet, before.balances.gramAdet); assert.equal(s.balances.gramaltin, before.balances.gramaltin);
  assert.equal(s.journal.at(-1).meta.lines[0].quantity, 10125); assert.equal(s.journal.at(-1).meta.lines[0].weightAccount, null);
});
test('nominal gold rejects a second weight account, overdraw and precision loss', t => {
  const repo = initialized(t);
  for (const item of [{ accountId: 'gramToplam', quantity: '10', weight: '10', value: '100' }, { accountId: 'gramToplam', quantity: '10', weightAccount: 'taki22', value: '100' }, { accountId: 'gramToplam', quantity: '243.001', value: '100' }, { accountId: 'gramToplam', quantity: '0', value: '100' }, { accountId: 'gramToplam', quantity: '0.0001', value: '100' }]) unchanged(repo, () => execute(repo, sale(repo, [item])));
});
test('retired package and weight accounts reject new stock, sales and direct movements', t => {
  const repo = initialized(t);
  for (const id of ['gramAdet', 'gramaltin']) {
    unchanged(repo, () => execute(repo, sale(repo, [{ accountId: id, quantity: '1', value: '100' }])));
    unchanged(repo, () => execute(repo, { type: 'stock', date: repo.state().date, direction: 'in', category: 'Stok girişi', note: 'Eski hesap yeni kayıtta kullanılamaz', items: [{ accountId: id, quantity: '1' }] }));
    unchanged(repo, () => execute(repo, { type: 'movement', date: repo.state().date, accountId: id, direction: 'in', category: 'Açılış düzeltmesi', quantity: '1', note: 'Eski hesap yeni kayıtta kullanılamaz' }));
  }
});
test('v2 gold history keeps its original package and weight semantics', () => {
  const s = replay(legacyV2Events()); assert.equal(s.balances.gramAdet, 9); assert.equal(s.balances.gramaltin, 90000);
  assert.equal(s.nominalUnconfirmed, true); assert.equal(s.balances.gramToplam || 0, 0);
  assert.equal(s.journal.at(-1).entries.some(e => e.accountId === 'gramToplam'), false);
});
test('v2 closings replay without fabricating a nominal gold physical count', () => {
  const s = replay(legacyV2Events({ withClose: true })); assert.equal(s.date, '2026-10-28'); assert.equal(s.balances.gramAdet, 9); assert.equal(s.balances.gramaltin, 90000);
  assert.equal(s.nominalUnconfirmed, true); assert.equal(s.closings[0].counts.some(r => r.accountId === 'gramToplam'), false);
});
test('legacy history requires a deliberate nominal opening and accepts real zero', t => {
  const repo = repository(t); restoreEvents(repo, legacyV2Events());
  unchanged(repo, () => execute(repo, closing(repo)));
  unchanged(repo, () => execute(repo, sale(repo, [{ accountId: 'gramToplam', quantity: '1', value: '100' }])));
  unchanged(repo, () => execute(repo, { type: 'stock', date: repo.state().date, direction: 'in', category: 'Stok girişi', note: 'Teyitsiz nominal miktar', items: [{ accountId: 'gramToplam', quantity: '1' }] }));
  const s = execute(repo, { type: 'nominalOpening', date: repo.state().date, quantity: '0', note: 'Gerçek sayım: gram altın mevcudu sıfır' }).state;
  assert.equal(s.nominalUnconfirmed, false); assert.equal(s.balances.gramToplam, 0); assert.equal(s.balances.gramAdet, 9); assert.equal(s.balances.gramaltin, 90000); assert.equal(revenue(s), 10000);
  execute(repo, closing(repo));
});
test('nominal confirmation preserves measured total and cannot run twice', t => {
  const repo = repository(t); restoreEvents(repo, legacyV2Events());
  for (const quantity of ['', null, '-1', '1.0001']) unchanged(repo, () => execute(repo, { type: 'nominalOpening', date: repo.state().date, quantity, note: 'Geçersiz teyit denetimi' }));
  unchanged(repo, () => execute(repo, { type: 'nominalOpening', date: repo.state().date, quantity: '243', note: '' }));
  const s = execute(repo, { type: 'nominalOpening', date: repo.state().date, quantity: '243', note: 'Gerçek toplam nominal miktar onayı' }).state;
  assert.equal(s.balances.gramToplam, 243000); assert.equal(s.nominalUnconfirmed, false);
  unchanged(repo, () => execute(repo, { type: 'nominalOpening', date: repo.state().date, quantity: '244', note: 'İkinci açılış kabul edilmemeli' }));
});
test('v3 reversal of a historical v2 sale restores historical linked accounts', t => {
  const repo = repository(t); restoreEvents(repo, legacyV2Events());
  const s = execute(repo, { type: 'reverse', date: repo.state().date, originalId: 'legacy-v2-gram-sale', note: 'Eski bağlı satışın açık güne tersi' }).state;
  assert.equal(s.balances.gramAdet, 10); assert.equal(s.balances.gramaltin, 100000); assert.equal(s.balances.gramToplam || 0, 0); assert.equal(s.nominalUnconfirmed, true); assert.equal(revenue(s), 0);
});
test('nominal sale, daily carry and periodic measurement survive backup roundtrip', t => {
  const source = initialized(t); execute(source, sale(source, [{ accountId: 'gramToplam', quantity: '10', value: '100' }])); execute(source, closing(source));
  execute(source, stocktake(source, { bilezik22: '1204.900' }, { bilezik22: 'Dönemsel tartım farkı' }));
  const target = repository(t), result = target.restore({ backup: source.backup(), revision: target.state().revision, confirmation: 'GERİ YÜKLE' });
  assert.deepEqual(target.events(), source.events()); assert.deepEqual(result.balances, source.state().balances); assert.deepEqual(result.closings, source.state().closings); assert.deepEqual(result.stocktakes, source.state().stocktakes);
  assert.equal(result.nominalUnconfirmed, false); assert.equal(result.date, source.state().date);
});
test('v2 history and v3 nominal opening survive replay and backup together', t => {
  const source = repository(t); restoreEvents(source, legacyV2Events({ withClose: true }));
  execute(source, { type: 'nominalOpening', date: source.state().date, quantity: '243', note: 'Geçişte gerçek gram altın toplamı' }); execute(source, closing(source));
  const target = repository(t); target.restore({ backup: source.backup(), revision: target.state().revision, confirmation: 'GERİ YÜKLE' });
  assert.deepEqual(target.events(), source.events()); assert.deepEqual(target.state().balances, source.state().balances);
  assert.equal(target.state().nominalUnconfirmed, false); assert.equal(target.state().balances.gramToplam, 243000); assert.equal(target.state().balances.gramAdet, 9); assert.equal(target.state().balances.gramaltin, 90000);
});
test('sarrafiye still uses whole pieces and never changes scale pools', t => {
  const repo = initialized(t, { ceyrek: '5' }), before = repo.state();
  const s = execute(repo, sale(repo, [{ accountId: 'ceyrek', quantity: '1', value: '100' }])).state;
  assert.equal(s.balances.ceyrek, 4); for (const a of s.accounts.filter(periodic)) assert.equal(s.balances[a.id], before.balances[a.id]);
  unchanged(repo, () => execute(repo, sale(repo, [{ accountId: 'ceyrek', quantity: '0.5', value: '100' }])));
});

test('multi-pool stocktake is atomic when a later measured pool has no explanation', t => {
  const repo = initialized(t, { taki14: '50', taki22: '60' });
  unchanged(repo, () => execute(repo, stocktake(repo,
    { taki14: '49', taki22: '59' }, { taki14: 'İlk havuz farkı açıklandı' }
  )));
  assert.equal(repo.state().balances.taki14, 50000);
  assert.equal(repo.state().stocktakes.length, 0);
});
test('periodic stocktake retry is idempotent and cannot silently reverse a completed measurement', t => {
  const repo = initialized(t), id = randomUUID(), revision = repo.state().revision;
  const command = stocktake(repo, { bilezik22: '1204' }, { bilezik22: 'Açıklamalı tartım farkı' });
  const first = repo.execute({ id, revision, command });
  const retry = repo.execute({ id, revision, command });
  assert.equal(first.duplicate, false); assert.equal(retry.duplicate, true);
  assert.equal(repo.state().stocktakes.length, 1);
  assert.equal(repo.state().balances.bilezik22, 1204000);
  unchanged(repo, () => execute(repo, { type: 'reverse', date: repo.state().date, originalId: id, note: 'Ölçüm sessizce geri çevrilmemeli' }));
});
test('explicit zero scale count is a measurement rather than an omitted or fabricated value', t => {
  const repo = initialized(t);
  const s = execute(repo, stocktake(repo, { bilezik22: '0' }, { bilezik22: 'Bağımsız testte gerçek sıfır ölçümü' })).state;
  assert.equal(s.balances.bilezik22, 0); assert.equal(s.balances.bilezikAdet, 100);
  assert.equal(s.stocktakes.at(-1).counts[0].counted, 0);
  assert.equal(s.stocktakes.at(-1).counts[0].difference, -1205000);
  unchanged(repo, () => execute(repo, sale(repo, [{ accountId: 'bilezikAdet', quantity: '1', weightAccount: 'bilezik22', weight: '1', value: '100' }])));
});
test('periodic measurement rejects a closed business date and never reopens it', t => {
  const repo = initialized(t), oldDate = repo.state().date; execute(repo, closing(repo));
  unchanged(repo, () => execute(repo, { ...stocktake(repo, { bilezik22: '1205' }), date: oldDate }));
  assert.equal(repo.state().date, '2026-10-28'); assert.equal(repo.state().stocktakes.length, 0);
});
test('nominal daily count discrepancy is explicit and does not alter retired or scale pools', t => {
  const repo = initialized(t), before = repo.state();
  unchanged(repo, () => execute(repo, closing(repo, { gramToplam: '242.500' })));
  const s = execute(repo, closing(repo, { gramToplam: '242.500' }, { gramToplam: 'Günlük nominal toplam kontrolünde fark' })).state;
  assert.equal(s.balances.gramToplam, 242500);
  assert.equal(s.closings.at(-1).counts.find(x => x.accountId === 'gramToplam').difference, -500);
  for (const a of before.accounts.filter(a => periodic(a) || a.retired)) assert.equal(s.balances[a.id], before.balances[a.id]);
});
test('legacy nominal confirmation cannot be bypassed with a direct correction movement', t => {
  const repo = repository(t); restoreEvents(repo, legacyV2Events());
  unchanged(repo, () => execute(repo, { type: 'movement', date: repo.state().date, accountId: 'gramToplam', direction: 'in', category: 'Açılış düzeltmesi', quantity: '243', note: 'Açılış teyidini atlama denemesi' }));
  assert.equal(repo.state().nominalUnconfirmed, true);
});
