import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, createReadStream, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS, replay } from '../domain.mjs';

const date = '2026-11-10';
function fixture(t) {
  const repo = new Repository(':memory:', 'demo');
  t.after(() => repo.close());
  const send = (id, command) => repo.execute({ id, revision: repo.state().revision, command: { date, ...command } });
  send('opening', { type:'opening', balances:Object.fromEntries(INITIAL_ACCOUNTS.filter(a=>!a.retired).map(a=>[a.id,a.id==='ceyrek'?'2':'0'])) });
  send('person', { type:'account', name:'Sentetik müşteri', partyType:'customer', unit:'TL', opening:'0' });
  send('supplier', { type:'account', name:'Sentetik firma', partyType:'supplier', unit:'TL', opening:'0' });
  return { repo, send };
}
const open = { type:'customerOrder', customerId:'cari-person', description:'İki çeyrek teslimi' };
const deposit = { type:'orderAdvance', orderId:'order-1', accountId:'nakit', amountTL:'50' };
const refund = { type:'orderRefund', orderId:'order-1', advanceId:'receipt', accountId:'nakit', amountTL:'5' };
const sale = { type:'sale', counterpartyType:'customer', counterpartyId:'cari-person',
  items:[{accountId:'ceyrek', quantity:'1', value:'100'}], received:[{accountId:'nakit',quantity:'60',valueTL:'60'}],
  given:[], orderSettlement:{orderId:'order-1', advances:[{advanceId:'receipt', amountTL:'40'}]} };

test('order, TL receipt, partial refund and final sale reconcile with one revenue and real cash only', async t => {
  const {repo,send}=fixture(t);
  send('order-1',open);
  send('receipt',deposit);
  const initial=repo.state();
  assert.equal(initial.balances.nakit,5000);
  assert.equal(initial.balances['cari-person'],0);
  assert.equal(initial.overview,undefined);
  assert.equal(repo.state({compact:true}).overview.revenue,0);
  send('refund',refund);
  const result=send('final',sale);
  assert.equal(result.state.balances.nakit,10500);
  assert.equal(result.state.balances.ceyrek,1);
  assert.equal(result.state.balances['cari-person'],0);
  assert.equal(repo.state({compact:true}).overview.revenue,10000);
  const order=result.state.customerOrders[0];
  assert.equal(order.status,'fulfilled');
  assert.equal(order.saleId,'final');
  assert.equal(order.availableTL,500);
  assert.deepEqual(order.advances.map(a=>[a.id,a.receivedTL,a.refundedTL,a.appliedTL]),[['receipt',5000,500,4000]]);
  assert.deepEqual(result.state.journal.at(-1).entries,[{accountId:'ceyrek',delta:-1},{accountId:'nakit',delta:6000}]);
  assert.equal(send('final',sale).duplicate,true);
  send('refund-remains',refund);
  assert.equal(repo.state().customerOrders[0].availableTL,0);
  assert.equal(repo.state().balances.nakit,10000);
  assert.equal(repo.state().moneyFlow.incoming,11000);
  assert.equal(repo.state().moneyFlow.outgoing,1000);
  const history=repo.journalPage({scope:'all',accountId:'cari-person'});
  for (const id of ['order-1','receipt','refund','final','refund-remains']) assert.ok(history.items.some(e=>e.id===id),id);
  assert.deepEqual(repo.state().customerOrders,replay(repo.events()).customerOrders);
  const restored=new Repository(':memory:','demo');t.after(()=>restored.close());
  restored.restore({backup:repo.backup(),revision:0,confirmation:'GERİ YÜKLE'});
  assert.deepEqual(restored.state().customerOrders,repo.state().customerOrders);
  const temp = mkdtempSync(join(tmpdir(),'order-archive-'));
  t.after(()=>rmSync(temp,{recursive:true,force:true}));
  const filename=join(temp,'ledger.ndjson'), db=join(temp,'restored.sqlite');
  repo.exportArchive(filename);
  const archive=new Repository(db,'demo');
  try {
    await archive.restoreArchive(createReadStream(filename),{revision:0,confirmation:'GERİ YÜKLE',temporaryDirectory:temp});
  } finally { archive.close(); }
  const reopened=new Repository(db,'demo');
  try { assert.deepEqual(reopened.state().customerOrders,repo.state().customerOrders); assert.deepEqual(reopened.events(),repo.events()); }
  finally { reopened.close(); }
});

test('order cancellations, overspend, wrong party and repeat/reverse never consume advances twice',t=>{
  const {repo,send}=fixture(t);
  function reject(id,c) {
    const before=repo.state(), events=repo.events();
    assert.throws(()=>send(id,c));
    assert.deepEqual(repo.state(),before);
    assert.deepEqual(repo.events(),events);
  }
  reject('supplier-order',{...open,customerId:'cari-supplier'});
  send('order-1',open);
  send('receipt',deposit);
  reject('cancel',{type:'orderCancel',orderId:'order-1',note:'Müşteri vazgeçti.'});
  reject('excess',{...refund,amountTL:'50.01'});
  reject('foreign-money',{...refund,accountId:'usd'});
  reject('foreign-unit',{...deposit,unit:'USD'});
  reject('wrong-sale',{...sale,counterpartyId:'cari-supplier'});
  reject('duplicate-lots',{...sale,orderSettlement:{orderId:'order-1',advances:[{advanceId:'receipt',amountTL:'20'},{advanceId:'receipt',amountTL:'20'}]}});
  reject('wrong-net',{...sale,received:[{accountId:'nakit',quantity:'100'}]});
  send('final',sale);
  reject('again',sale);
  reject('undo-final',{type:'reverse',originalId:'final',note:'Tekrar deneme'});
  reject('undo-receipt',{type:'reverse',originalId:'receipt',note:'Tekrar deneme'});
  reject('edit-final',{type:'amend',originalId:'final',replacement:sale,note:'Tekrar deneme'});
  send('order-2',open);
  send('cancel-2',{type:'orderCancel',orderId:'order-2',note:'Müşteri vazgeçti.'});
  reject('late',{...deposit,orderId:'order-2'});
  assert.equal(repo.state().customerOrders[1].status,'cancelled');
});

test('one final sale consumes the reserved piece and order advance while retaining the agreed price snapshot', t => {
  const {repo,send}=fixture(t);
  send('piece',{type:'registerItem',code:'Q-1',accountId:'ceyrek'});
  send('order-1',open);
  send('receipt',deposit);
  const request={...sale,items:[{...sale.items[0],inventoryCode:'Q-1'}],salePricing:{version:1,lines:[{source:'Tezgâh',quotedTL:'110',costTL:'70'}]}};
  const final=send('final',request).state;
  assert.equal(final.inventoryItems[0].status,'sold');
  assert.equal(final.customerOrders[0].availableTL,1000);
  assert.equal(final.journal.at(-1).meta.lines[0].pricing.costTL,7000);
  assert.equal(final.journal.at(-1).meta.advanceAppliedTL,4000);
  assert.equal(final.balances.nakit,11000);
  assert.equal(final.balances.ceyrek,1);
  assert.equal(send('final',request).duplicate,true);
  assert.equal(repo.events().at(-1).tradeVersion,11);
  assert.deepEqual(replay(repo.backup().events).inventoryItems,final.inventoryItems);
});

test('historical order-only sales keep inert item metadata while new unknown serialized sales fail', t => {
  const {repo,send}=fixture(t);
  send('order-1',open);send('receipt',deposit);
  const annotated=structuredClone(sale);
  annotated.items[0].inventoryCode='legacy-unused';
  assert.throws(()=>send('bad',annotated));
  send('old',sale);
  const events=repo.events();
  events.at(-1).command.items[0].inventoryCode='legacy-unused';
  const state=replay(events);
  assert.equal(state.inventoryItems,undefined);
  assert.equal(state.journal.at(-1).meta.advanceAppliedTL,4000);
  assert.equal(state.journal.at(-1).meta.lines[0].inventoryCode,undefined);
});