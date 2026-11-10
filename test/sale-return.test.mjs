import { appendHistoricalEvent } from '../test-support/historical-supplier.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadStream, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS, decimal, replay, workdaySummary } from '../domain.mjs';
import { ReportRepository } from '../report-repository.mjs';

function execute(repo, id, command) { return repo.execute({ id, revision: repo.state().revision, command: { date: repo.state().date, ...command } }); }
function fixture(t, { cash = '300', pos = '0', credit = '100', saleQuantity = '4', saleWeight = '40', saleValue = '400', filename = ':memory:' } = {}) {
  const repo = new Repository(filename, 'demo'); t.after(() => repo.close());
  execute(repo, 'opening', { type: 'opening', date: '2026-10-27', balances: Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, ({ nakit: '1000', banka: '1000', usd: '100', bilezikAdet: '10', bilezik22: '100', ceyrek: '10', gramToplam: '100' })[a.id] || '0'])) });
  execute(repo, 'customer', { type: 'account', name: 'Synthetic buyer', unit: 'TL', opening: '0' });
  execute(repo, 'sale', { type: 'sale', items: [{ accountId: 'bilezikAdet', quantity: saleQuantity, weightAccount: 'bilezik22', weight: saleWeight, value: saleValue }], cash, pos, bank: '0', scrapQuantity: '0', scrapValue: '0', customerAccount: Number(credit) ? 'cari-customer' : '', note: 'Synthetic sale' });
  return repo;
}
function command(extra = {}) { return { type: 'saleReturn', originalId: 'sale', items: [{ lineIndex: 0, quantity: '1', weight: '10', value: '100' }], refunds: [{ accountId: 'nakit', quantity: '100', valueTL: '100' }], note: 'Synthetic agreed return', ...extra }; }
function rejectUnchanged(repo, value) { const before = repo.state(); assert.throws(() => execute(repo, 'rejected-return', value), e => e.status === 400); assert.deepEqual(repo.state(), before); }
function reverse(id) { return { type: 'reverse', originalId: id, note: 'Synthetic reversal' }; }
function close(repo) { const s = repo.state(); execute(repo, 'close', { type: 'close', counts: Object.fromEntries(s.accounts.filter(a => a.physical && !a.retired && a.countPolicy === 'daily').map(a => [a.id, decimal(s.balances[a.id] || 0, a.unit)])), reasons: {}, approvedBy: 'Synthetic count' }); }

test('partial and remaining full returns restore exact paired stock and refund only actual fund legs', t => {
  const repo = fixture(t), sold = repo.state();
  const partial = execute(repo, 'return-one', command()).state;
  assert.equal(partial.balances.bilezikAdet, 7); assert.equal(partial.balances.bilezik22, 70000); assert.equal(partial.balances.nakit, 120000);
  assert.equal(partial.balances['cari-customer'], sold.balances['cari-customer'], 'A cash refund must not cancel the outstanding receivable.');
  assert.equal(partial.journal.at(-1).meta.revenue, -10000); assert.equal(partial.journal.at(-1).meta.lines[0].lineIndex, 0);
  const full = execute(repo, 'return-rest', command({ items: [{ lineIndex: 0, quantity: '3', weight: '30', value: '300' }], refunds: [{ accountId: 'banka', quantity: '300', valueTL: '300' }] })).state;
  assert.equal(full.balances.bilezikAdet, 10); assert.equal(full.balances.bilezik22, 100000); assert.equal(full.balances.banka, 70000);
  rejectUnchanged(repo, command());
  assert.equal(repo.events().at(-1).schemaVersion, 4); assert.equal(repo.events()[2].schemaVersion, 3);
});

test('agreed manual return price can exceed original proportion and zero-value return requires no refund', t => {
  const repo = fixture(t);
  execute(repo, 'manual-price', command({ items: [{ lineIndex: 0, quantity: '1', weight: '10', value: '500' }], refunds: [{ accountId: 'nakit', quantity: '500', valueTL: '500' }] }));
  assert.equal(repo.state().journal.at(-1).meta.revenue, -50000);
  execute(repo, 'zero-value', command({ items: [{ lineIndex: 0, quantity: '1', weight: '10', value: '0' }], refunds: [] }));
  assert.equal(repo.state().journal.at(-1).meta.revenue, 0); assert.equal(repo.state().balances.bilezikAdet, 8);
});

test('return quantity, original line selection and paired gram limits prevent duplicate or impossible stock', t => {
  const repo = fixture(t);
  for (const items of [[], null, [{ lineIndex: 1, quantity: '1', weight: '10', value: '100' }], [{ lineIndex: '0', quantity: '1', weight: '10', value: '100' }], [{ lineIndex: 0, quantity: '5', weight: '40', value: '100' }], [{ lineIndex: 0, quantity: '1.5', weight: '10', value: '100' }], [{ lineIndex: 0, quantity: '1', value: '100' }], [{ lineIndex: 0, quantity: '1', weight: '40', value: '100' }], [{ lineIndex: 0, quantity: '4', weight: '39', value: '100' }], [{ lineIndex: 0, quantity: '4', weight: '41', value: '100' }], [{ lineIndex: 0, quantity: '1', weight: '10', value: '-1' }], [{ lineIndex: 0, quantity: '1', weight: '10', value: '100' }, { lineIndex: 0, quantity: '1', weight: '10', value: '100' }]]) rejectUnchanged(repo, command({ items }));
  execute(repo, 'first-return', command({ items: [{ lineIndex: 0, quantity: '2', weight: '25', value: '100' }] }));
  rejectUnchanged(repo, command({ items: [{ lineIndex: 0, quantity: '2', weight: '20', value: '100' }] }));
  execute(repo, 'exact-rest', command({ items: [{ lineIndex: 0, quantity: '2', weight: '15', value: '100' }] }));
  assert.equal(repo.state().balances.bilezik22, 100000);
});

test('sarrafiye pieces and nominal gram gold return in native units without an extra gram pool', t => {
  const repo = fixture(t);
  execute(repo, 'other-sale', { type: 'sale', items: [{ accountId: 'ceyrek', quantity: '2', value: '100' }, { accountId: 'gramToplam', quantity: '2.5', value: '100' }], cash: '200', pos: '0', bank: '0', scrapQuantity: '0', scrapValue: '0', note: 'Synthetic unpaired sale' });
  const before = repo.state();
  rejectUnchanged(repo, command({ originalId: 'other-sale', items: [{ lineIndex: 0, quantity: '1', weight: '1', value: '100' }] }));
  execute(repo, 'other-return', command({ originalId: 'other-sale', items: [{ lineIndex: 0, quantity: '1', value: '50' }, { lineIndex: 1, quantity: '0.125', value: '50' }] }));
  const after = repo.state(); assert.equal(after.balances.ceyrek, before.balances.ceyrek + 1); assert.equal(after.balances.gramToplam, before.balances.gramToplam + 125); assert.equal(after.balances.bilezik22, before.balances.bilezik22);
});

test('refund allocations preserve bank, USD and HAS quantities independently from agreed TL reference', t => {
  const repo = fixture(t);
  execute(repo, 'has-fund', { type: 'fundAccount', name: 'Synthetic HAS', unit: 'HAS', physical: true, opening: '1' });
  execute(repo, 'foreign-return', command({ refunds: [{ accountId: 'banka', quantity: '20', valueTL: '20' }, { accountId: 'usd', quantity: '1', valueTL: '30' }, { accountId: 'fund-has-fund', quantity: '0.125', valueTL: '50' }] }));
  const s = repo.state(); assert.equal(s.balances.banka, 98000); assert.equal(s.balances.usd, 9900); assert.equal(s.balances['fund-has-fund'], 875);
  assert.deepEqual(s.journal.at(-1).meta.refunds.map(x => x.unit), ['TL', 'USD', 'HAS']);
});

test('invalid or insufficient refunds reject atomically without returning stock or editing debt', t => {
  const repo = fixture(t);
  for (const refunds of [null, [{ accountId: 'nakit', quantity: '99', valueTL: '99' }], [{ accountId: 'pos', quantity: '100', valueTL: '100' }], [{ accountId: 'cari-customer', quantity: '100', valueTL: '100' }], [{ accountId: 'usd', quantity: '101', valueTL: '100' }], [{ accountId: 'missing', quantity: '100', valueTL: '100' }], [{ accountId: 'nakit', quantity: '100', valueTL: '99' }]]) rejectUnchanged(repo, command({ refunds }));
  rejectUnchanged(repo, command({ items: [{ lineIndex: 0, quantity: '1', weight: '10', value: '2000' }], refunds: [{ accountId: 'nakit', quantity: '2000', valueTL: '2000' }] }));
  execute(repo, 'valid-after-rejections', command()); assert.equal(repo.state().balances.bilezikAdet, 7);
});

test('same request id returns the committed return without a second stock or refund movement', t => {
  const repo = fixture(t), c = command();
  const first = execute(repo, 'one-return', c), duplicate = execute(repo, 'one-return', c);
  assert.equal(first.duplicate, false); assert.equal(duplicate.duplicate, true); assert.deepEqual(duplicate.state, first.state);
});

test('active return blocks whole original reversal; reversing return restores remaining availability', t => {
  const repo = fixture(t);
  execute(repo, 'return', command()); rejectUnchanged(repo, reverse('sale'));
  execute(repo, 'undo-return', reverse('return'));
  assert.equal(repo.state().balances.bilezikAdet, 6); assert.equal(repo.state().balances.nakit, 130000);
  execute(repo, 'return-again', command({ items: [{ lineIndex: 0, quantity: '4', weight: '40', value: '400' }], refunds: [{ accountId: 'nakit', quantity: '400', valueTL: '400' }] }));
  execute(repo, 'undo-again', reverse('return-again')); execute(repo, 'undo-sale', reverse('sale'));
  rejectUnchanged(repo, command());
  assert.equal(repo.state().balances.bilezikAdet, 10); assert.equal(repo.state().balances.nakit, 100000);
});

test('return reversal fails atomically when returned stock has already been sold again', t => {
  const repo = fixture(t, { cash: '400', credit: '0' });
  execute(repo, 'return', command());
  execute(repo, 'sell-all', { type: 'sale', items: [{ accountId: 'bilezikAdet', quantity: '7', weightAccount: 'bilezik22', weight: '70', value: '700' }], cash: '700', pos: '0', bank: '0', scrapQuantity: '0', scrapValue: '0', note: 'Synthetic reuse' });
  rejectUnchanged(repo, reverse('return'));
});

test('next-day return and its reversal affect current-day revenue and actual sales cash without rewriting prior day', t => {
  const repo = fixture(t); close(repo);
  execute(repo, 'return', command());
  assert.equal(workdaySummary(repo.state(), '2026-10-27').totals.sales, 40000);
  assert.equal(workdaySummary(repo.state()).totals.sales, -10000);
  assert.equal(repo.state({ compact: true }).overview.revenue, -10000); assert.equal(repo.state({ compact: true }).overview.salesCash, -10000);
  execute(repo, 'undo-return', reverse('return'));
  assert.equal(repo.state({ compact: true }).overview.revenue, 0); assert.equal(repo.state({ compact: true }).overview.salesCash, 0);
  assert.equal(repo.journalPage({ scope: 'all', type: 'saleReturn' }).total, 1);
});

test('saleReturn is version-four only and requires an original non-reversed sale with indexed lines', t => {
  const repo = fixture(t);
  for (const originalId of ['missing', 'opening', 'customer']) rejectUnchanged(repo, command({ originalId }));
  execute(repo, 'return', command());
  const events = repo.events(); assert.equal(events.at(-1).schemaVersion, 4);
  assert.throws(() => replay([...events.slice(0, -1), { ...events.at(-1), schemaVersion: 3 }]), /sürüm/i);
  assert.throws(() => replay([...events.slice(0, -1), { ...events.at(-1), schemaVersion: 5 }]), /sürüm/i);
});

test('legacy single-dimension sale without indexed lines is not guessed into a return', t => {
  const repo = fixture(t);
  const legacy = { id: 'legacy-sale', timestamp: '2026-10-27T10:00:00Z', command: { type: 'sale', date: repo.state().date, outAccount: 'bilezik22', outQuantity: '10', total: '100', cash: '100', pos: '0', bank: '0', scrapQuantity: '0', scrapValue: '0', note: 'Synthetic legacy sale' } };
  repo.db.prepare('INSERT INTO events(id,body) VALUES(?,?)').run(legacy.id, JSON.stringify(legacy)); repo.db.exec('UPDATE meta SET revision=revision+1 WHERE id=1');
  assert.equal(repo.state().journal.at(-1).meta.lines.length, 0);
  rejectUnchanged(repo, command({ originalId: 'legacy-sale' }));
});

test('read-only report projection reads returns and their negative trade values without mutating the ledger', t => {
  const root = resolve(tmpdir()), directory = mkdtempSync(join(root, 'defter-return-reports-')), filename = join(directory, 'synthetic.sqlite');
  const repo = fixture(t, { filename });
  t.after(() => { assert.equal(dirname(resolve(directory)), root); rmSync(directory, { recursive: true, force: true }); });
  execute(repo, 'return', command()); const before = repo.state(), reader = new ReportRepository(filename, 'demo');
  try {
    const page = reader.journal({ type: 'saleReturn' });
    assert.equal(page.items.length, 1); assert.equal(page.items[0].type, 'saleReturn'); assert.equal(page.items[0].sales, -10000);
    assert.equal(reader.summary(before.date).totals.sales, 30000); assert.deepEqual(repo.state(), before);
  } finally { reader.close(); }
});

test('return and cancelled return survive complete JSON and streamed archive backup replay', async t => {
  const repo = fixture(t); execute(repo, 'return', command()); execute(repo, 'undo-return', reverse('return')); execute(repo, 'new-return', command());
  const expected = repo.state(), jsonTarget = new Repository(':memory:', 'demo'); t.after(() => jsonTarget.close());
  jsonTarget.restore({ backup: repo.backup(), revision: 0, confirmation: 'GERİ YÜKLE' });
  assert.deepEqual(jsonTarget.state().balances, expected.balances); assert.deepEqual(jsonTarget.state().journal, expected.journal);
  const root = resolve(tmpdir()), directory = mkdtempSync(join(root, 'defter-return-')), filename = join(directory, 'synthetic.ndjson');
  t.after(() => { assert.equal(dirname(resolve(directory)), root); rmSync(directory, { recursive: true, force: true }); }); repo.exportArchive(filename);
  const archived = new Repository(':memory:', 'demo'); t.after(() => archived.close());
  await archived.restoreArchive(createReadStream(filename), { revision: 0, confirmation: 'GERİ YÜKLE', temporaryDirectory: directory });
  assert.deepEqual(archived.state().balances, expected.balances); assert.deepEqual(archived.state().journal, expected.journal);
});

test('paged sales expose immutable remaining return info from all active history, not the filtered page or compact tail', t => {
  const repo = fixture(t); execute(repo, 'return', command());
  for (let i = 0; i < 6; i++) execute(repo, `extra-${i}`, { type: 'movement', accountId: 'nakit', category: 'Sermaye', direction: 'in', quantity: '1', note: 'Synthetic later entry' });
  assert.ok(!repo.state({ compact: true }).journal.some(event => event.type === 'saleReturn'));
  const before = repo.state(), page = repo.journalPage({ scope: 'all', type: 'sale', q: 'Synthetic sale', limit: 1 });
  assert.deepEqual(page.items[0].returnInfo, { eligible: true, lines: [{ lineIndex: 0, remainingQuantity: 3, remainingWeight: 30000 }] });
  page.items[0].returnInfo.lines[0].remainingQuantity = 999; assert.deepEqual(repo.state(), before);
  assert.equal(repo.state().journal.find(event => event.id === 'sale').returnInfo, undefined);
  execute(repo, 'undo-return', reverse('return'));
  assert.equal(repo.journalPage({ scope: 'all', type: 'sale' }).items[0].returnInfo.lines[0].remainingQuantity, 4);
  execute(repo, 'full-return', command({ items: [{ lineIndex: 0, quantity: '4', weight: '40', value: '400' }], refunds: [{ accountId: 'nakit', quantity: '400', valueTL: '400' }] }));
  assert.deepEqual(repo.journalPage({ scope: 'all', type: 'sale' }).items[0].returnInfo, { eligible: false, lines: [{ lineIndex: 0, remainingQuantity: 0, remainingWeight: 0 }] });
  execute(repo, 'undo-full', reverse('full-return')); execute(repo, 'undo-sale', reverse('sale'));
  assert.equal(repo.journalPage({ scope: 'all', type: 'sale' }).items[0].returnInfo.eligible, false);
});

test('legacy sales without indexed product lines advertise no return eligibility', t => {
  const repo = fixture(t);
  const legacy = { id: 'legacy-sale', timestamp: '2026-10-27T10:00:00Z', command: { type: 'sale', date: repo.state().date, outAccount: 'ceyrek', outQuantity: '1', total: '100', cash: '100', pos: '0', bank: '0', scrapQuantity: '0', scrapValue: '0', note: 'Legacy return info' } };
  repo.db.prepare('INSERT INTO events(id,body) VALUES(?,?)').run(legacy.id, JSON.stringify(legacy)); repo.db.exec('UPDATE meta SET revision=revision+1 WHERE id=1');
  assert.deepEqual(repo.journalPage({ scope: 'all', type: 'sale', q: 'Legacy return info' }).items[0].returnInfo, { eligible: false, lines: [] });
});

function legacyPairedFixture(t, mixed = false) {
  const repo = new Repository(':memory:', 'demo'); t.after(() => repo.close());
  const opening = { id: 'legacy-opening', schemaVersion: 2, timestamp: '2026-10-27T10:00:00Z', command: { type: 'opening', date: '2026-10-27', balances: Object.fromEntries(INITIAL_ACCOUNTS.filter(a => a.id !== 'gramToplam').map(a => [a.id, ({ nakit: '1000', gramAdet: '2', gramaltin: '10', bilezikAdet: '2', bilezik22: '20' })[a.id] || '0'])) } };
  const items = [{ accountId: 'gramAdet', quantity: '1', weightAccount: 'gramaltin', weight: '5', value: '100' }];
  if (mixed) items.push({ accountId: 'bilezikAdet', quantity: '1', weightAccount: 'bilezik22', weight: '10', value: '100' });
  const sale = { id: 'sale', schemaVersion: 2, timestamp: '2026-10-27T10:01:00Z', command: { type: 'sale', date: '2026-10-27', items, cash: mixed ? '200' : '100', pos: '0', bank: '0', scrapQuantity: '0', scrapValue: '0', note: 'Legacy paired sale' } };
  for (const event of [opening, sale]) repo.db.prepare('INSERT INTO events(id,body) VALUES(?,?)').run(event.id, JSON.stringify(event));
  repo.db.exec('UPDATE meta SET revision=2 WHERE id=1'); return repo;
}

test('retired legacy package and paired weight cannot receive a new sale return or implicit nominal conversion', t => {
  const repo = legacyPairedFixture(t), before = repo.state();
  assert.equal(before.balances.gramAdet, 1); assert.equal(before.balances.gramaltin, 5000);
  rejectUnchanged(repo, command({ items: [{ lineIndex: 0, quantity: '1', weight: '5', value: '100' }] }));
  assert.deepEqual(repo.journalPage({ scope: 'all', type: 'sale' }).items[0].returnInfo, { eligible: false, lines: [] });
  assert.equal(repo.state().balances.gramToplam, 0); assert.equal(repo.state().nominalUnconfirmed, true);
});

test('mixed legacy sale exposes only active original indices and active bracelet returns still work', t => {
  const repo = legacyPairedFixture(t, true);
  assert.deepEqual(repo.journalPage({ scope: 'all', type: 'sale' }).items[0].returnInfo, { eligible: true, lines: [{ lineIndex: 1, remainingQuantity: 1, remainingWeight: 10000 }] });
  rejectUnchanged(repo, command({ items: [{ lineIndex: 1, quantity: '1', weight: '10', value: '100' }, { lineIndex: 0, quantity: '1', weight: '5', value: '100' }], refunds: [{ accountId: 'nakit', quantity: '200', valueTL: '200' }] }));
  execute(repo, 'active-return', command({ items: [{ lineIndex: 1, quantity: '1', weight: '10', value: '100' }] }));
  assert.deepEqual(repo.journalPage({ scope: 'all', type: 'sale' }).items[0].returnInfo, { eligible: false, lines: [{ lineIndex: 1, remainingQuantity: 0, remainingWeight: 0 }] });
  assert.equal(repo.state().balances.bilezikAdet, 2); assert.equal(repo.state().balances.bilezik22, 20000);
  assert.equal(repo.state().balances.gramAdet, 1); assert.equal(repo.state().balances.gramaltin, 5000); assert.equal(repo.state().balances.gramToplam, 0);
});

test('negotiated refund can deliver actual gold and cash atomically at separate references', t => {
  const repo = fixture(t);
  const outgoing = [{ accountId: 'ceyrek', quantity: '1', valueTL: '70' }, { accountId: 'nakit', quantity: '30', valueTL: '30' }];
  const request = { type: 'saleReturn', date: repo.state().date, originalId: 'sale', items: [{ lineIndex: 0, quantity: '1', weight: '10', value: '100' }], outgoing, note: 'Sentetik karma karşılık' };
  rejectUnchanged(repo, { ...request, refunds: [] });
  rejectUnchanged(repo, { ...request, outgoing: [outgoing[0]] });
  execute(repo, 'scrap-in', { type: 'purchase', source: 'customer', items: [{ accountId: 'hurda22', quantity: '1', value: '10' }], given: [{accountId:'nakit',quantity:'10',valueTL:'10'}], received: [], credits: [], debts: [] });
  const funded = repo.state();
  rejectUnchanged(repo, { ...request, outgoing: [{ accountId: 'hurda22', quantity: '1', valueTL: '100' }] });
  const after = execute(repo, 'gold-refund', request).state;
  assert.equal(after.balances.ceyrek, funded.balances.ceyrek - 1);
  assert.equal(after.balances.nakit, funded.balances.nakit - 3000);
  assert.equal(after.balances.bilezik22, funded.balances.bilezik22 + 10000);
  assert.equal(after.balances['cari-customer'], funded.balances['cari-customer']);
  assert.deepEqual(after.journal.at(-1).meta.refunds.map(row => row.kind), ['stock', 'money']);
  assert.equal(repo.events().at(-1).schemaVersion, 9);
  assert.equal(execute(repo, 'gold-refund', request).duplicate, true);
  assert.deepEqual(replay(repo.backup().events).balances, after.balances);
  assert.deepEqual(execute(repo, 'undo-gold-refund', reverse('gold-refund')).state.balances, funded.balances);
});

test('retail mixed return does not extend supplier sale workflows', t => {
  const repo = fixture(t);
  execute(repo, 'supplier', { type: 'account', partyType: 'supplier', name: 'Sentetik firma', unit: 'TL', opening: '0' });
  appendHistoricalEvent(repo, 'supplier-sale', { date:repo.state().date,type: 'sale', counterpartyType: 'supplier', counterpartyId: 'cari-supplier',
    items: [{ accountId: 'ceyrek', quantity: '1', value: '100' }],
    received: [{ accountId: 'nakit', quantity: '100', valueTL: '100' }], given: [], credits: [], debts: [] });
  const items = [{ lineIndex: 0, quantity: '1', value: '100' }];
  rejectUnchanged(repo, { type: 'saleReturn', originalId: 'supplier-sale', items, outgoing: [{ accountId: 'ceyrek', quantity: '1', valueTL: '100' }], note: 'Sentetik' });
  rejectUnchanged(repo, { type:'retailExchange', originalId:'supplier-sale', returnItems:items, newItems:[{accountId:'ceyrek',quantity:'1',value:'100'}], received:[], refunds:[], note:'Sentetik' });
  execute(repo, 'legacy-supplier-refund', command({ originalId: 'supplier-sale', items }));
});

test('retail exchange posts linked return and replacement with only the actual cash difference', t => {
  const repo = fixture(t), before = repo.state();
  const request = { type:'retailExchange', originalId:'sale', returnItems:[{lineIndex:0,quantity:'1',weight:'10',value:'100'}],
    newItems:[{accountId:'ceyrek',quantity:'1',value:'130'}], received:[{accountId:'nakit',quantity:'30',valueTL:'30'}],
    refunds:[], note:'Sentetik değişim' };
  rejectUnchanged(repo, { ...request, received:[] });
  const after = execute(repo,'swap',request).state;
  assert.deepEqual(after.journal.slice(-2).map(row=>[row.type,row.meta.exchangeId,row.meta.revenue]),[['saleReturn','swap',-10000],['sale','swap',13000]]);
  assert.equal(after.balances.nakit,before.balances.nakit+3000);
  assert.equal(after.balances.ceyrek,before.balances.ceyrek-1);
  assert.equal(after.balances.bilezik22,before.balances.bilezik22+10000);
  assert.equal(after.balances['cari-customer'],before.balances['cari-customer']);
  assert.equal(execute(repo,'swap',request).duplicate,true);
  rejectUnchanged(repo,reverse('swap'));
  rejectUnchanged(repo,reverse('swap:return'));
  assert.deepEqual(replay(repo.backup().events).balances,after.balances);
  const undo=execute(repo,'undo-swap',{type:'undoExchange',originalId:'swap',note:'Hatalı değişim'}).state;
  assert.deepEqual(undo.balances,before.balances);
  rejectUnchanged(repo,{type:'undoExchange',originalId:'swap',note:'Tekrar'});
});
