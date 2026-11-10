import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadStream, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS, replay } from '../domain.mjs';

const date='2026-11-10', customer='cari-meryem';
function fixture(t) {
  const repo=new Repository(':memory:','demo');t.after(()=>repo.close());
  const run=(id,command)=>repo.execute({id,revision:repo.state().revision,command:{date,...command}});
  const balances=Object.fromEntries(INITIAL_ACCOUNTS.filter(a=>!a.retired).map(a=>[a.id,'0']));
  Object.assign(balances,{ceyrek:'10',nakit:'10000'});run('open',{type:'opening',balances});
  for(const id of ['meryem','ali'])run(id,{type:'account',partyType:'customer',name:id,unit:'TL',opening:'0'});
  const purchase=(accountId='hurda14',party=customer)=>({type:'purchase',source:'customer',counterpartyType:'customer',counterpartyId:party,
    items:[{accountId,quantity:'2',value:'400'}],received:[],given:[{accountId:'nakit',quantity:'400',valueTL:'400'}],credits:[],debts:[]});
  const sale=(party=customer)=>({type:'sale',counterpartyType:'customer',counterpartyId:party,items:[{accountId:'ceyrek',quantity:'1',value:'600'}],
    received:[{accountId:'nakit',quantity:'600',valueTL:'600'}],given:[],credits:[],debts:[]});
  run('early-sale',sale());run('scrap',purchase());run('other-scrap',purchase('hurda14','cari-ali'));run('coin',purchase('ceyrek'));
  run('sale',sale());run('later-scrap',purchase());run('anonymous-sale',sale(''));
  const link={type:'linkScrapPurchase',saleId:'sale',purchaseId:'scrap'};
  return {repo,run,purchase,sale,link};
}
test('explicit prior scrap linkage adds only a trace, including through backup and streaming replay',async t=>{
  const {repo,run,link}=fixture(t),before=repo.state();
  const after=run('link',link).state,trace=after.journal.at(-1);
  assert.deepEqual(after.balances,before.balances);assert.equal(after.balances[customer],0);
  assert.deepEqual(after.moneyFlow,before.moneyFlow);
  assert.deepEqual(trace.entries,[]);
  assert.deepEqual([trace.meta.saleId,trace.meta.purchaseId,trace.meta.counterpartyId],['sale','scrap',customer]);
  assert.equal(repo.events().at(-1).schemaVersion,12);
  assert.equal(run('link',link).duplicate,true);
  assert.throws(()=>run('again',link));
  assert.equal(repo.state().revision,after.revision);
  assert.deepEqual(replay(repo.backup().events).balances,before.balances);
  const dir=mkdtempSync(join(tmpdir(),'scrap-trace-')),path=join(dir,'ledger.ndjson');
  repo.exportArchive(path);const target=new Repository(':memory:','demo');t.after(()=>target.close());
  await target.restoreArchive(createReadStream(path),{revision:0,confirmation:'GERİ YÜKLE',temporaryDirectory:dir});
  assert.deepEqual(target.state().journal.at(-1),trace);
});
test('reject alternate parties, future and non-scrap records, anonymous sales and settlement amounts atomically',t=>{
  const {repo,run,link}=fixture(t),before=repo.state();
  for(const bad of [{purchaseId:'coin'},{purchaseId:'other-scrap'},{purchaseId:'later-scrap'},{purchaseId:'sale'},
    {saleId:'early-sale'},{saleId:'anonymous-sale'},{saleId:'fake'},{purchaseId:null},{saleId:5},{amountTL:'400'},{counterpartyId:customer},{purchaseId:{id:'scrap'}}])
    assert.throws(()=>run('bad',{...link,...bad}));
  assert.deepEqual(repo.state(),before);
});
test('eligible candidates are revision-bound, same-day ordered and tied to the original commercial date after corrections',t=>{
  const {repo,run,link,purchase,sale}=fixture(t);
  const options={scope:'all',type:'purchase',scrapForSale:'sale'};
  assert.deepEqual(repo.journalPage(options).items.map(e=>e.id),['scrap']);
  run('fix-purchase',{type:'amend',originalId:'scrap',note:'Sentetik düzeltme',replacement:purchase()});
  assert.deepEqual(repo.journalPage(options).items.map(e=>e.id),['fix-purchase']);
  assert.throws(()=>run('bad',link));run('link',{...link,purchaseId:'fix-purchase'});
  assert.deepEqual(repo.journalPage(options).items,[]);
  run('fix-earlysale',{type:'amend',originalId:'early-sale',note:'Sentetik düzeltme',replacement:sale()});
  assert.deepEqual(repo.journalPage({...options,scrapForSale:'fix-earlysale'}).items,[]);
  assert.throws(()=>repo.journalPage({...options,scrapForSale:'scrap'}));
  assert.throws(()=>repo.journalPage({...options,type:'sale'}));
});
test('customer history retains explicit link and cancellation status across pagination without changing the customer statement',t=>{
  const {repo,run,link}=fixture(t);run('linked',link);run('undo',{type:'reverse',originalId:'scrap',note:'Sentetik ters kayıt'});
  const result=repo.journalPage({scope:'all',accountId:customer,type:'linkScrapPurchase',limit:1});
  assert.deepEqual(result.items.map(e=>e.id),['linked']);
  assert.deepEqual(result.receiptContext.map(e=>e.id),['scrap','sale','undo']);
  assert.equal(result.totalEntries,0);
  assert.equal(repo.accountStatement({accountId:customer}).closing,0);
  assert.equal(repo.journalPage({scope:'all',accountId:'cari-ali',type:'linkScrapPurchase'}).total,0);
  assert.throws(()=>run('bad',link));
});

test('mistaken trace can be reversed with a reason and re-linked without any second stock or cash effect',t=>{
  const {repo,run,link}=fixture(t),before=repo.state();
  assert.deepEqual([before.balances.ceyrek,before.balances.hurda14,before.balances.nakit],[9,6000,1020000]);
  run('mistake',link);
  assert.throws(()=>run('missing-reason',{type:'reverse',originalId:'mistake',note:''}));
  run('withdraw',{type:'reverse',originalId:'mistake',note:'Yanlış satış bağlantısı'});
  assert.deepEqual(repo.journalPage({scope:'all',type:'purchase',scrapForSale:'sale'}).items.map(e=>e.id),['scrap']);
  run('corrected',link);
  assert.throws(()=>run('duplicate',link));
  const history=repo.journalPage({scope:'all',type:'linkScrapPurchase',accountId:customer});
  assert.deepEqual(history.items.map(e=>e.id),['corrected','mistake']);
  assert.deepEqual(history.reversedIds,['mistake']);
  assert.deepEqual(repo.state().balances,before.balances);
});

test('classic named cash trades and one positively identified customer leg can link without assigning split or foreign parties', t=>{
  const {repo,run}=fixture(t);
  const buy={type:'purchase',source:'customer',items:[{accountId:'hurda14',quantity:'1',value:'200'}],cash:'200',bank:'0',counterpartyAccount:customer,note:'Önceden ödenmiş eski alış'};
  run('named-buy',buy);
  const classic={type:'sale',items:[{accountId:'ceyrek',quantity:'1',value:'200'}],cash:'200',bank:'0',pos:'0',scrapQuantity:'0',scrapValue:'0',customerAccount:customer,note:'Peşin eski satış'};
  run('named-sale',classic);
  const debt={type:'purchase',source:'customer',items:buy.items,payments:[],debts:[{accountId:customer,quantity:'200',valueTL:'200'}],note:'Açık hesap eski alış'};
  run('single-leg',debt);
  run('split-buy',{...debt,debts:[{accountId:customer,quantity:'100',valueTL:'100'},{accountId:'cari-ali',quantity:'100',valueTL:'100'}]});
  run('not-yet-a-customer',{...buy,counterpartyAccount:'cari-future'});
  run('future',{type:'account',partyType:'customer',name:'Daha sonra açılan kart',unit:'TL',opening:'0'});
  run('future-sale',{...classic,customerAccount:'cari-future'});
  run('after',classic);
  // The archive format predates typed-party attribution. Keep its exact cash and stock amounts.
  const backup=repo.backup();
  for(const e of backup.events.filter(e=>['named-buy','named-sale'].includes(e.id))) e.schemaVersion=3;
  backup.sha256=createHash('sha256').update(JSON.stringify(backup.events)).digest('hex');
  repo.restore({backup,revision:repo.state().revision,confirmation:'GERİ YÜKLE'});
  const history=repo.journalPage({scope:'all',accountId:customer});
  assert.equal(history.items.find(e=>e.id==='named-sale')?.scrapLinkCustomerId,customer);
  const eligible=repo.journalPage({scope:'all',type:'purchase',accountId:customer,scrapForSale:'after'}).items.map(e=>e.id);
  assert.ok(eligible.includes('named-buy'));assert.ok(eligible.includes('single-leg'));assert.ok(!eligible.includes('split-buy'));
  const before=repo.state();
  assert.throws(()=>run('future-alias',{type:'linkScrapPurchase',saleId:'future-sale',purchaseId:'not-yet-a-customer'}));
  run('old-link',{type:'linkScrapPurchase',saleId:'named-sale',purchaseId:'named-buy'});
  run('leg-link',{type:'linkScrapPurchase',saleId:'after',purchaseId:'single-leg'});
  assert.throws(()=>run('split',{type:'linkScrapPurchase',saleId:'after',purchaseId:'split-buy'}));
  assert.deepEqual(repo.state().balances,before.balances);
  assert.equal(repo.state().journal.at(-1).meta.counterpartyId,customer);
});

test('a candidate cursor is scoped to its selected sale and revision',t=>{
  const {repo,run,sale}=fixture(t);
  run('sale-two',sale());run('sale-three',sale());
  const options={scope:'all',type:'purchase',scrapForSale:'sale-two',limit:1};
  const first=repo.journalPage(options);
  assert.equal(first.total,2);assert.ok(first.nextCursor);
  assert.throws(()=>repo.journalPage({...options,scrapForSale:'sale-three',cursor:first.nextCursor}),e=>e.status===409);
  run('association',{type:'linkScrapPurchase',purchaseId:first.items[0].id,saleId:'sale-two'});
  assert.throws(()=>repo.journalPage({...options,cursor:first.nextCursor}),e=>e.status===409);
});
