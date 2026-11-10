import test from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_ACCOUNTS, replay } from '../domain.mjs';
import { Repository } from '../repository.mjs';
import { createReadStream, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const date = '2026-11-10';
const product = { type: 'registerItem', code: 'YZ-01', barcode: '001234', accountId: 'yuzuk', weightAccount: 'taki14', actualWeight: '3.25', description: 'Taşlı yüzük' };
const sale = { type: 'sale', items: [{ accountId: 'yuzuk', quantity: '1', weightAccount: 'taki14', weight: '3.25', inventoryCode: 'YZ-01', value: '100' }], received: [{ accountId: 'nakit', quantity: '100' }], given: [], debts: [], credits: [] };
const refund = { type: 'saleReturn', originalId: 'sale', items: [{ lineIndex: 0, quantity: '1', weight: '3.25', value: '95' }], refunds: [{ accountId: 'nakit', quantity: '95' }], note: 'İade' };
const reverse = originalId => ({ type: 'reverse', originalId, note: 'Hatalı kayıt' });
function fixture(t) {
  const repo = new Repository(':memory:', 'demo');
  t.after(() => repo.close());
  const balances = Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, '0']));
  Object.assign(balances, { yuzuk: '2', taki14: '6.55', nakit: '500' });
  const write = (id, command) => repo.execute({ id, revision: repo.state().revision, command: { date, ...command } });
  write('opening', { type: 'opening', balances });
  return { repo, write };
}

test('registering a counted piece identifies existing stock and preserves exact measured weight', t => {
  const { repo, write } = fixture(t);
  const before = repo.state().balances;
  write('register', { ...product, grossWeight: '3.5', netWeight: '3.0', fineness: '585' });
  const state = repo.state();
  assert.deepEqual(state.balances, before);
  assert.equal(repo.events().at(-1).schemaVersion, 8);
  assert.deepEqual(state.journal.at(-1).entries, []);
  assert.equal(state.inventoryItems[0].actualWeight, 3250);
  assert.equal(state.inventoryItems[0].status, 'available');
  assert.equal(state.inventoryItems[0].fineness, 585);
  assert.equal(state.inventoryItems[0].netWeight, 3000);
  for (const override of [{ code: ' yz-01 ', barcode: '' }, { code: '001234', barcode: '' }, { code: 'B', barcode: 'yz-01' },
    { code: 'B', barcode: '', actualWeight: '4' }, { code: 'B', barcode: '', weightAccount: 'hurda14' },
    { code: 'B', barcode: '', grossWeight: '2', netWeight: '3' }, { code: 'B', barcode: '', photo: 'https://unknown.invalid/img' }]) {
    assert.throws(() => write('bad', { ...product, ...override }));
  }
  assert.equal(repo.state().revision, 2);
});

test('identified lines are single exact pieces and bulk stock cannot consume their reserved count or weight', t => {
  const { repo, write } = fixture(t);
  write('register', product);
  const row = sale.items[0];
  for (const changes of [{ inventoryCode: 'missing' }, { quantity: '2' }, { weight: '3.251' }, { weightAccount: 'taki22' }]) {
    assert.throws(() => write('bad', { ...sale, items: [{ ...row, ...changes }] }));
  }
  const bulk = { ...row }; delete bulk.inventoryCode;
  assert.throws(() => write('bulk-count', { ...sale, items: [{ ...bulk, quantity: '2' }] }));
  assert.throws(() => write('bulk-weight', { ...sale, items: [{ ...bulk, weight: '3.31' }] }));
  assert.throws(() => write('count', { type: 'stocktake', counts: { taki14: '3.1' }, reasons: { taki14: 'Sayım farkı' }, approvedBy: 'Yetkili' }));
  write('bulk', { ...sale, items: [{ ...bulk, weight: '3.30' }] });
  write('sale', sale);
  assert.equal(repo.state().balances.yuzuk, 0);
  assert.equal(repo.state().balances.taki14, 0);
  assert.equal(repo.state().inventoryItems[0].status, 'sold');
  assert.throws(() => write('second', sale));
  assert.equal(repo.state().journal.find(e => e.id === 'sale').meta.lines[0].inventoryCode, 'YZ-01');
});

test('returns and reversals track the original piece, including resale and undo of the return', t => {
  const { repo, write } = fixture(t);
  write('register', product);
  write('sale', sale);
  write('returned', refund);
  assert.equal(repo.state().inventoryItems[0].status, 'available');
  write('new-sale', sale);
  assert.throws(() => write('bad', reverse('returned')));
  write('undo-new', reverse('new-sale'));
  write('undo-return', reverse('returned'));
  assert.equal(repo.state().inventoryItems[0].status, 'sold');
  write('undo-sale', reverse('sale'));
  assert.equal(repo.state().inventoryItems[0].status, 'available');
  const reconstructed = replay(repo.backup().events);
  assert.deepEqual(reconstructed.inventoryItems, repo.state().inventoryItems);
  assert.equal(reconstructed.balances.yuzuk, 2);
  assert.equal(reconstructed.balances.taki14, 6550);
});

test('purchase linkage requires active matching source quantity and weight; release preserves audit', t => {
  const { repo, write } = fixture(t);
  write('purchase', { type: 'purchase', source: 'customer', items: [{ accountId: 'yuzuk', quantity: '1', weightAccount: 'taki14', weight: '3.25', value: '25' }], received: [], given: [{ accountId: 'nakit', quantity: '25' }], credits: [], debts: [] });
  for (const link of [{ id: 'opening', lineIndex: 0 }, { id: 'purchase', lineIndex: 1 }]) {
    assert.throws(() => write('bad', { ...product, purchaseLine: link }));
  }
  write('register', { ...product, purchaseLine: { id: 'purchase', lineIndex: 0 } });
  assert.throws(() => write('overflow', { ...product, code: 'YZ-2', barcode: '', purchaseLine: { id: 'purchase', lineIndex: 0 } }));
  assert.throws(() => write('bad-reverse', reverse('purchase')));
  write('release', { type: 'releaseItem', inventoryCode: product.code, note: 'Hatalı eşleme' });
  write('undo-purchase', reverse('purchase'));
  assert.equal(repo.state().inventoryItems[0].status, 'released');
  assert.equal(repo.state().balances.yuzuk, 2);
  assert.throws(() => write('unavailable', sale));
});

test('legacy arbitrary line metadata never fabricates an item; amendments preserve identity and constraints', t => {
  const { repo, write } = fixture(t);
  const [opening] = repo.events();
  const historic = { id: 'legacy', schemaVersion: 6, command: { ...sale, date } };
  const recovered = replay([opening, historic]);
  assert.equal(recovered.inventoryItems, undefined);
  assert.equal(recovered.journal.at(-1).editableCommand.items[0].inventoryCode, undefined);
  assert.equal(historic.command.items[0].inventoryCode, product.code);
  write('register', product);
  write('sale', sale);
  write('amend', { type: 'amend', originalId: 'sale', note: 'Bedel', replacement: { ...sale, items: [{ ...sale.items[0], value: '105' }], received: [{ accountId: 'nakit', quantity: '105' }] } });
  assert.equal(repo.state().inventoryItems[0].status, 'sold');
  assert.equal(repo.state().inventoryItems[0].lastEventId, 'amend');
  assert.equal(repo.state().balances.nakit, 60500);
});

test('same-event stock received as payment cannot mask an untracked delivery of a reserved piece', t => {
  const { write, repo } = fixture(t);
  write('one', product);
  write('two', { ...product, code: 'YZ-02', barcode: '', actualWeight: '3.3' });
  const anonymous = { ...sale.items[0] };
  delete anonymous.inventoryCode;
  assert.throws(() => write('swap', { ...sale, items: [anonymous], received: [{
    accountId: 'yuzuk', quantity: '1', weightAccount: 'taki14', weight: '3.25', valueTL: '100'
  }] }));
  assert.equal(repo.state().revision, 3);
  assert.throws(() => write('invalid', { ...sale, items: {some: true} }), { name:'DomainError' });
});
test('both backup formats restore the original thumbnail outside the compact state and journal', async t => {
  const { repo, write } = fixture(t);
  const photo = { version:1, pixels:Buffer.alloc(96*96*3,12).toString('base64') };
  write('reg', { ...product, photo });
  const root = resolve(tmpdir()), dir = mkdtempSync(join(root,'item-photo-'));
  t.after(() => { assert.equal(dirname(resolve(dir)),root); rmSync(dir,{recursive:true,force:true}); });
  const archive = join(dir,'photo.ndjson');
  repo.exportArchive(archive);
  for (const format of ['json','ndjson']) {
    const path = join(dir,format+'.sqlite'), target = new Repository(path,'demo');
    try {
      if (format==='json') target.restore({ revision:0, confirmation:'GERİ YÜKLE', backup:repo.backup() });
      else await target.restoreArchive(createReadStream(archive),{revision:0,confirmation:'GERİ YÜKLE',temporaryDirectory:dir});
    } finally { target.close(); }
    const reopened = new Repository(path,'demo');
    try {
      assert.deepEqual(reopened.itemPhoto(product.code),photo);
      assert.ok(!JSON.stringify(reopened.state({compact:true})).includes(photo.pixels));
      assert.deepEqual(reopened.state().balances,repo.state().balances);
    } finally { reopened.close(); }
  }
});
function exchangeFixture(t) {
  const f = fixture(t);
  f.write('first', product);
  f.write('second', { ...product, code:'YZ-02', barcode:'0002', actualWeight:'3.30' });
  f.write('sale', sale);
  const replacement = { accountId:'yuzuk',quantity:'1',weightAccount:'taki14',weight:'3.30',inventoryCode:'YZ-02',value:'130' };
  const swap = { type:'retailExchange', originalId:'sale', returnItems:refund.items, newItems:[replacement],
    received:[{accountId:'nakit',quantity:'35'}], refunds:[], note:'Değişim' };
  return { ...f, swap, replacement };
}

test('serialized refund consideration delivers the selected distinct piece and undoes both item movements', t => {
  const { repo, write, replacement } = exchangeFixture(t);
  const command = { type:'saleReturn', originalId:'sale',items:refund.items,outgoing:[{...replacement,valueTL:'95'}],note:'Mal karşılık' };
  delete command.outgoing[0].value;
  write('payout',command);
  const s=repo.state();
  assert.deepEqual(s.inventoryItems.map(i=>i.status),['available','issued']);
  assert.equal(s.journal.at(-1).meta.refunds[0].inventoryCode,'YZ-02');
  assert.equal(s.balances.taki14,3250);
  assert.equal(s.balances.nakit,60000);
  write('undo',reverse('payout'));
  assert.deepEqual(repo.state().inventoryItems.map(i=>i.status),['sold','available']);
  assert.deepEqual(replay(repo.events()).inventoryItems,repo.state().inventoryItems);
});

test('linked exchange needs a different replacement and actual settlement; replacement return blocks undo until reversed', t => {
  const { repo, write, swap } = exchangeFixture(t);
  const before=repo.state();
  const same={...swap.newItems[0],inventoryCode:' yz-01 ',weight:'3.25'};
  for (const invalid of [{...swap,newItems:[same]}, {...swap,received:[{accountId:'nakit',quantity:'36'}]},
    {...swap,received:[]}, {...swap,refunds:[{accountId:'nakit',quantity:'1'}]}, {...swap,newItems:[null]}]) {
    assert.throws(()=>write('bad',invalid), { name:'DomainError' });
    assert.deepEqual(repo.state(),before);
  }
  write('exchange',swap);
  assert.deepEqual(repo.state().inventoryItems.map(i=>i.status),['available','sold']);
  assert.equal(repo.state().balances.nakit,63500);
  write('refund-replacement',{ ...refund, originalId:'exchange',items:[{lineIndex:0,quantity:'1',weight:'3.30',value:'90'}],refunds:[{accountId:'nakit',quantity:'90'}] });
  assert.throws(()=>write('bad-undo',{type:'undoExchange',originalId:'exchange',note:'Tekrar'}));
  write('undo-second-return',reverse('refund-replacement'));
  write('undo-exchange',{type:'undoExchange',originalId:'exchange',note:'Hatalı seçim'});
  assert.deepEqual(repo.state().inventoryItems.map(i=>i.status),['sold','available']);
  assert.deepEqual(repo.state().balances,before.balances);
});
test('v8 amendment replays the original serialized sale dialect despite later command field names', t => {
  const { repo, write } = fixture(t);
  write('reg',product);
  write('sale',sale);
  const replacement = { ...sale, salePricing:'old annotation', orderSettlement:{orderId:'never-issued'} };
  const history = [...repo.events(),{id:'amend',schemaVersion:8,command:{type:'amend',date,originalId:'sale',note:'Açıklama',replacement}}];
  const recovered=replay(history);
  assert.equal(recovered.balances.nakit,60000);
  assert.equal(recovered.inventoryItems[0].lastEventId,'amend');
  assert.equal(recovered.journal.at(-1).meta.lines[0].pricing,undefined);
  assert.equal(recovered.journal.at(-1).meta.advanceAppliedTL,undefined);
  assert.equal(recovered.journal.at(-1).editableCommand.salePricing,undefined);
  assert.equal(recovered.journal.at(-1).editableCommand.orderSettlement,undefined);
  assert.equal(recovered.journal.at(-1).editableCommand.items[0].inventoryCode,product.code);
});
test('priced v8 sale keeps its captured dialect when an old payload includes a later advance field', t => {
  const {repo,write}=fixture(t);
  write('reg',product);
  write('priced',{...sale,salePricing:{version:1,lines:[{quotedTL:'110'}]}});
  const events=repo.events();
  assert.equal(events.at(-1).tradeVersion,8);
  events.at(-1).command.orderSettlement={orderId:'formerly-ignored'};
  const s=replay(events);
  assert.equal(s.inventoryItems[0].status,'sold');
  assert.equal(s.journal.at(-1).meta.lines[0].pricing.quotedTL,11000);
  assert.equal(s.journal.at(-1).meta.advanceAppliedTL,undefined);
});