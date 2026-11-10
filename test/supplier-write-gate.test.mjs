import test from 'node:test';
import assert from 'node:assert/strict';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS } from '../domain.mjs';
import { appendHistoricalEvent } from '../test-support/historical-supplier.mjs';
import { supplierDocuments } from '../supplier-ledger.mjs';
import { mkdtempSync, rmSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const date='2026-11-10';
function fixture(t){
  const repo=new Repository(':memory:','demo');t.after(()=>repo.close());
  const run=(id,c,revision=repo.state().revision)=>repo.execute({id,revision,command:{date,...c}});
  run('open',{type:'opening',balances:Object.fromEntries(INITIAL_ACCOUNTS.filter(a=>!a.retired).map(a=>[a.id,a.id==='nakit'?'1000':a.id==='ceyrek'?'10':'0']))});
  run('legacy',{type:'account',name:'Eski firma',partyType:'supplier',unit:'TL',opening:'100'});
  run('child',{type:'account',parentAccountId:'cari-legacy',unit:'USD',opening:'100'});
  run('customer',{type:'account',name:'Müşteri',partyType:'customer',unit:'TL',opening:'100'});
  run('firm',{type:'supplierFirm',name:'Yeni firma'});
  run('unit',{type:'supplierUnit',supplierId:'supplier-firm',unit:'TL'});
  run('advance',{type:'supplierPayment',supplierId:'supplier-firm',given:[{accountId:'nakit',quantity:'100'}],credits:[{accountId:'supplier-unit-unit',quantity:'100'}]});
  return {repo,run};
}
const snapshot=repo=>({events:repo.events(),state:repo.state()});
function rejects(repo,run,id,c){const before=snapshot(repo);assert.throws(()=>run(id,c),/firma kartındaki yeni/);assert.deepEqual(snapshot(repo),before);}

test('current generic supplier trade variants reject root, child and native accounts without affecting retail',t=>{
  const {repo,run}=fixture(t);
  for(const id of ['cari-legacy','cari-child','supplier-unit-unit']){
    rejects(repo,run,'collect-'+id,{type:'collection',customerAccount:id,target:id==='cari-child'?'usd':'nakit',direction:'collect',quantity:'1'});
    rejects(repo,run,'mixed-'+id,{type:'collection',counterpartyId:'cari-legacy',counterpartyType:'supplier',received:[{accountId:'nakit',quantity:'1'}],debts:[{accountId:id,quantity:'1',valueTL:'1'}]});
    rejects(repo,run,'sale-'+id,{type:'sale',items:[{accountId:'ceyrek',quantity:'1',value:'1'}],credits:[{accountId:id,quantity:'1',valueTL:'1'}]});
    rejects(repo,run,'movement-'+id,{type:'movement',accountId:id,direction:'out',quantity:'1',category:'Açılış düzeltmesi',note:'Old path'});
  }
  rejects(repo,run,'supplier-cash',{type:'purchase',source:'supplier',items:[{accountId:'ceyrek',quantity:'1',value:'1'}],payments:[{accountId:'nakit',quantity:'1'}],debts:[]});
  run('retail',{type:'collection',customerAccount:'cari-customer',target:'nakit',direction:'collect',quantity:'1'});
  assert.equal(repo.state().balances['cari-customer'],9900);
});

test('restored supplier command exact retry remains idempotent while changed content and fresh writes fail',t=>{
  const {repo,run}=fixture(t);
  const command={type:'collection',date,customerAccount:'cari-legacy',target:'nakit',direction:'collect',quantity:'10'};
  appendHistoricalEvent(repo,'old-collection',command);
  const before=snapshot(repo);
  assert.equal(repo.execute({id:'old-collection',revision:0,command}).duplicate,true);assert.deepEqual(snapshot(repo),before);
  assert.throws(()=>repo.execute({id:'old-collection',revision:0,command:{...command,quantity:'11'}}),/farklı içerik/);assert.deepEqual(snapshot(repo),before);
  rejects(repo,run,'new-collection',command);
});

test('amend cannot redirect a historical supplier operation into a customer to evade retired route guard',t=>{
  const {repo,run}=fixture(t);
  const command={type:'collection',date,customerAccount:'cari-legacy',target:'nakit',direction:'collect',quantity:'10'};
  appendHistoricalEvent(repo,'old-collection',command);
  rejects(repo,run,'redirect',{type:'amend',originalId:'old-collection',replacement:{...command,customerAccount:'cari-customer'},note:'Old supplier moved to customer'});
});

test('amend from customer into supplier is rejected by replacement references',t=>{
  const {repo,run}=fixture(t);
  const command={type:'collection',date,customerAccount:'cari-customer',target:'nakit',direction:'collect',quantity:'10'};
  run('customer-collection',command);
  rejects(repo,run,'redirect',{type:'amend',originalId:'customer-collection',replacement:{...command,customerAccount:'cari-legacy'},note:'Customer moved to old supplier'});
});

for(const extraReceipt of [false,true])test(`legacy receipt source linking reconciles documentary and ledger debt, new refund=${extraReceipt}`,async t=>{
  const {repo,run}=fixture(t),supplierId='cari-legacy',accountId='cari-legacy';
  appendHistoricalEvent(repo,'old-refund',{type:'collection',date,customerAccount:accountId,target:'nakit',direction:'collect',quantity:'30'});
  run('new-purchase',{type:'supplierPurchase',supplierId,items:[{accountId:'ceyrek',quantity:'1'}],charges:[{accountId,quantity:'70'}]});
  const allocation={type:'supplierAllocation',supplierId,allocations:[{sourceId:'legacy',purchaseId:'new-purchase',accountId,quantity:'70'}]};
  const before=snapshot(repo);
  assert.throws(()=>run('too-early',allocation),/eski tahsilat|eşle/i);assert.deepEqual(snapshot(repo),before);
  if(extraReceipt){
    // The unresolved legacy lot cannot be silently consumed. Its cash receipt
    // produces an explicit new documentary liability, without inventing FIFO.
    run('new-refund',{type:'supplierPayment',supplierId,received:[{accountId:'nakit',quantity:'20'}],debts:[{accountId,quantity:'20'}]});
    assert.equal(supplierDocuments(repo.state(),supplierId).purchases.find(p=>p.id==='new-refund').charges[0].remaining,2000);
  }
  const balances=repo.state().balances,priorEvents=repo.events();
  run('link',{type:'supplierLegacyReceiptLink',supplierId,originalId:'old-refund',uses:[{sourceId:'legacy',accountId,quantity:'30'}]});
  assert.deepEqual(repo.state().balances,balances);assert.deepEqual(repo.events().slice(0,priorEvents.length),priorEvents);
  assert.deepEqual(repo.state().journal.at(-1).entries,[]);
  let docs=supplierDocuments(repo.state(),supplierId);
  assert.equal(docs.unresolvedReceipts.length,0);assert.equal(docs.sources.find(s=>s.id==='legacy').credits[0].remaining,7000);
  run('allocate',allocation);docs=supplierDocuments(repo.state(),supplierId);
  assert.equal(docs.sources.find(s=>s.id==='legacy').credits[0].remaining,0);
  assert.equal(docs.purchases.find(p=>p.id==='new-purchase').charges[0].remaining,0);
  assert.equal(repo.state().balances[accountId],extraReceipt?-2000:0);
  const documentaryNet=docs.sources.flatMap(s=>s.credits).filter(r=>r.accountId===accountId).reduce((s,r)=>s+r.remaining,0)-docs.purchases.flatMap(p=>p.charges).filter(r=>r.accountId===accountId).reduce((s,r)=>s+r.remaining,0);
  assert.equal(documentaryNet,repo.state().balances[accountId]);
  assert.throws(()=>run('undo-link',{type:'supplierReverse',originalId:'link',note:'Used source'}),/kullanılmış|tahsis/);
  const root=resolve(tmpdir()),directory=mkdtempSync(join(root,'supplier-link-replay-'));
  const json=new Repository(':memory:','demo'),archive=new Repository(':memory:','demo');
  try{
    json.restore({backup:repo.backup(),revision:0,confirmation:'GERİ YÜKLE'});
    const file=join(directory,'link.ndjson');repo.exportArchive(file);
    await archive.restoreArchive(createReadStream(file),{revision:0,confirmation:'GERİ YÜKLE',temporaryDirectory:directory});
    for(const target of [json,archive]){assert.deepEqual(target.events(),repo.events());assert.deepEqual(target.state().balances,repo.state().balances);assert.deepEqual(supplierDocuments(target.state(),supplierId),docs);}
  }finally{json.close();archive.close();assert.equal(dirname(resolve(directory)),root);rmSync(directory,{recursive:true,force:true});}
});
