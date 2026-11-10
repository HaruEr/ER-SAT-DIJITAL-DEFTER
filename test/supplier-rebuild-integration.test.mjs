import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadStream, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createApp } from '../server.mjs';
import { Repository } from '../repository.mjs';
import { ReportRepository } from '../report-repository.mjs';
import { INITIAL_ACCOUNTS } from '../domain.mjs';
import { supplierDocuments } from '../supplier-ledger.mjs';
import {appendHistoricalEvent} from '../test-support/historical-supplier.mjs';
import { authenticateTestOwner, ownerFetch } from '../test-support/editor-session.mjs';

const date = '2026-11-10';
const nativeTypes = ['supplierFirm','supplierFirmUpdate','supplierUnit','supplierPurchase','supplierPayment','supplierAllocation','supplierOffset','supplierReturn','supplierReverse','supplierAmend'];
function snapshot(repo) {
  return { events:repo.events(), revision:repo.state().revision, balances:repo.state().balances };
}
async function fixture(t) {
  const root=resolve(tmpdir()), directory=mkdtempSync(join(root,'supplier-integration-'));
  const extraRepos=[];
  const {server,repositories}=createApp({dataDirectory:directory,logger:()=>{}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  await authenticateTestOwner(server);
  const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{
    await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
    for(const extra of extraRepos)extra.close();
    assert.equal(dirname(resolve(directory)),root);
    rmSync(directory,{recursive:true,force:true});
  });
  const post=(path,body)=>ownerFetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const initial=await ownerFetch(base+'/api/state?workspace=demo');assert.equal(initial.status,200);
  const repo=repositories.get('demo');
  async function run(id,command,revision=repo.state().revision) {
    const response=await post('/api/command?workspace=demo',{id,revision,command:{date,...command}});
    assert.equal(response.status,200,await response.clone().text());
    return response.json();
  }
  await run('opening',{type:'opening',balances:Object.fromEntries(INITIAL_ACCOUNTS.filter(a=>!a.retired).map(a=>[a.id,a.id==='nakit'?'10000':'0']))});
  return {repo,base,post,run,directory,extraRepos};
}
async function firm(c) {
  await c.run('firm',{type:'supplierFirm',name:'Sentetik firma <&>'});
  await c.run('has',{type:'supplierUnit',supplierId:'supplier-firm',unit:'HAS'});
  return 'supplier-unit-has';
}
async function nativeTrade(c) {
  const accountId=await firm(c);
  await c.run('purchase',{type:'supplierPurchase',supplierId:'supplier-firm',items:[{accountId:'ceyrek',quantity:'10'}],charges:[{accountId,quantity:'16.530'}]});
  await c.run('payment',{type:'supplierPayment',supplierId:'supplier-firm',advanceScope:'general',given:[{accountId:'nakit',quantity:'1000'}],credits:[{accountId,quantity:'6.000'}]});
  assert.equal(c.repo.state().balances.ceyrek,10);
  assert.equal(c.repo.state().balances.nakit,900000);
  assert.equal(c.repo.state().balances[accountId],-10530);
  return accountId;
}

test('native supplier write is atomic, idempotent and revision protected through HTTP',async t=>{
  const c=await fixture(t), accountId=await nativeTrade(c), before=snapshot(c.repo);
  const stored=before.events.find(e=>e.id==='payment');assert.equal(stored.schemaVersion,17);
  const duplicate=await c.run('payment',stored.command,0);assert.equal(duplicate.duplicate,true);
  assert.deepEqual(snapshot(c.repo),before);
  const changed=await c.post('/api/command',{id:'payment',revision:before.revision,command:{...stored.command,note:'changed'}});
  assert.equal(changed.status,400);assert.deepEqual(snapshot(c.repo),before);
  const stale=await c.post('/api/command',{id:'stale',revision:0,command:stored.command});
  assert.equal(stale.status,409);assert.deepEqual(snapshot(c.repo),before);
  const invalid={...stored.command,given:[{accountId:'nakit',quantity:'9001'}],credits:[{accountId,quantity:'1'}]};
  const rejected=await c.post('/api/command',{id:'overdraw',revision:before.revision,command:invalid});
  assert.equal(rejected.status,400);assert.deepEqual(snapshot(c.repo),before);
  assert.equal(c.repo.state().journal.filter(e=>e.id==='payment').length,1);
  const detailResponse=await ownerFetch(c.base+'/api/suppliers?supplierId=supplier-firm&limit=1');
  assert.equal(detailResponse.status,200);const detail=await detailResponse.json();
  assert.equal(detail.accounts.find(a=>a.id===accountId).balance,-10530);
  assert.equal(detail.events[0].id,'payment');
  assert.equal(detail.statements[0].debtIncrease,16530);
  assert.equal(detail.statements[0].debtDecrease,6000);
  const next=await ownerFetch(c.base+'/api/suppliers?supplierId=supplier-firm&limit=1&cursor='+encodeURIComponent(detail.nextCursor));
  assert.equal(next.status,200);assert.equal((await next.json()).events[0].id,'purchase');
  const invalidDate=await ownerFetch(c.base+'/api/suppliers?supplierId=supplier-firm&startDate=2026-11-11&endDate=2026-11-10');
  assert.equal(invalidDate.status,400);
  await c.run('profile',{type:'supplierFirmUpdate',supplierId:'supplier-firm',name:'Yeni ad <&>'});
  const staleCursor=await ownerFetch(c.base+'/api/suppliers?supplierId=supplier-firm&limit=1&cursor='+encodeURIComponent(detail.nextCursor));
  assert.equal(staleCursor.status,409);
});

test('employee cannot issue supplier commands or reuse an owner command key',async t=>{
  const c=await fixture(t);
  const created=await c.post('/api/auth/employees',{name:'Sentetik çalışan',password:'synthetic-worker-password'});assert.equal(created.status,201);
  const person=await created.json();
  const login=await fetch(c.base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:person.id,password:'synthetic-worker-password'})});
  assert.equal(login.status,200);const {token}=await login.json(),before=snapshot(c.repo);
  const anonymous=await fetch(c.base+'/api/suppliers?supplierId=supplier-firm');assert.equal(anonymous.status,401);
  const employeeRead=await fetch(c.base+'/api/suppliers?supplierId=supplier-firm',{headers:{Authorization:'Bearer '+token}});assert.equal(employeeRead.status,403);
  for(const type of nativeTypes){
    const response=await fetch(c.base+'/api/command',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({id:'opening',revision:before.revision,command:{type,date,name:'forbidden'}})});
    assert.equal(response.status,403,type);assert.deepEqual(snapshot(c.repo),before);
  }
});

test('native counterpart rejects wrong asset kinds and preserves reserved pieces under incoming stock masks',async t=>{
  const c=await fixture(t),accountId=await firm(c);
  await c.run('stock-purchase',{type:'supplierPurchase',supplierId:'supplier-firm',items:[{accountId:'yuzuk',quantity:'2',weightAccount:'taki14',weight:'10'}],charges:[{accountId,quantity:'5'}]});
  await c.run('reserved',{type:'registerItem',accountId:'yuzuk',code:'R1',weightAccount:'taki14',actualWeight:'8'});
  const before=snapshot(c.repo);
  const purchase={type:'supplierPurchase',date,supplierId:'supplier-firm',items:[{accountId:'yuzuk',quantity:'1',weightAccount:'taki14',weight:'3'}],charges:[{accountId,quantity:'1'}],given:[{accountId:'yuzuk',quantity:'1',weightAccount:'taki14',weight:'3'}],credits:[{accountId,quantity:'1'}]};
  const commands=[purchase,...['pos',accountId,'taki14'].map(id=>({type:'supplierPayment',date,supplierId:'supplier-firm',given:[{accountId:id,quantity:'1'}],credits:[{accountId,quantity:'1'}]}))];
  for(const command of commands){
    const response=await c.post('/api/command',{id:'invalid-asset',revision:before.revision,command});
    assert.equal(response.status,400,await response.clone().text());assert.deepEqual(snapshot(c.repo),before);
  }
  assert.equal(c.repo.state().inventoryItems[0].status,'available');
  assert.equal(c.repo.state().inventoryReserved.taki14,8000);
});

test('old and native events survive JSON and NDJSON restore without rebasing balances',async t=>{
  const c=await fixture(t);
  await c.run('old-supplier',{type:'account',name:'Eski firma',partyType:'supplier',unit:'USD',opening:'-123.45'});
  await c.run('old-child',{type:'account',parentAccountId:'cari-old-supplier',partyType:'supplier',unit:'HAS',opening:'2.500'});
  const prefix=c.repo.events(),accountId=await nativeTrade(c),expected=c.repo.state();
  assert.deepEqual(c.repo.events().slice(0,prefix.length),prefix);
  const json=new Repository(join(c.directory,'json.sqlite'),'demo'),ndjson=new Repository(join(c.directory,'ndjson.sqlite'),'demo');
  c.extraRepos.push(json,ndjson);
  json.restore({backup:c.repo.backup(),revision:0,confirmation:'GERİ YÜKLE'});
  const filename=join(c.directory,'archive.ndjson');c.repo.exportArchive(filename);
  await ndjson.restoreArchive(createReadStream(filename),{revision:0,confirmation:'GERİ YÜKLE',temporaryDirectory:c.directory});
  for(const restored of [json,ndjson]){
    assert.deepEqual(restored.events(),c.repo.events());
    assert.deepEqual(restored.state().balances,expected.balances);
    assert.equal(restored.state().balances['cari-old-supplier'],-12345);
    assert.equal(restored.state().balances['cari-old-child'],2500);
    assert.equal(restored.state().balances[accountId],-10530);
    assert.deepEqual(restored.state().journal,expected.journal);
  }
  const report=new ReportRepository(join(c.directory,'json.sqlite'),'demo');
  try{
    assert.equal(report.overview().accounts.find(a=>a.id===accountId).balance,-10530);
    assert.throws(()=>report.db.exec('DELETE FROM events'),/readonly|read-only/i);
    assert.deepEqual(json.events(),c.repo.events());
  }finally{report.close();}
});

test('return credit consumes document reduction once and exposes only residual reusable source',async t=>{
  const c=await fixture(t),accountId=await firm(c),supplierId='supplier-firm';
  await c.run('p',{type:'supplierPurchase',supplierId,items:[{accountId:'ceyrek',quantity:'10'}],charges:[{accountId,quantity:'10'}]});
  await c.run('pay',{type:'supplierPayment',supplierId,given:[{accountId:'nakit',quantity:'600'}],credits:[{accountId,quantity:'6'}]});
  await c.run('allocate',{type:'supplierAllocation',supplierId,allocations:[{sourceId:'pay',purchaseId:'p',accountId,quantity:'6'}]});
  await c.run('ret',{type:'supplierReturn',supplierId,originalId:'p',items:[{lineIndex:0,quantity:'5'}],reductions:[{accountId,quantity:'4'}],credits:[{accountId,quantity:'5'}],note:'Sentetik iade'});
  assert.equal(c.repo.state().balances[accountId],1000);
  const docs=supplierDocuments(c.repo.state(),supplierId);
  assert.equal(docs.purchases.find(p=>p.id==='p').charges[0].remaining,0);
  assert.equal(docs.sources.find(p=>p.id==='pay').credits[0].remaining,0);
  assert.equal(docs.sources.find(p=>p.id==='ret').credits[0].remaining,1000);
  await c.run('future',{type:'supplierPurchase',supplierId,items:[{accountId:'ceyrek',quantity:'5'}],charges:[{accountId,quantity:'5'}]});
  const before=snapshot(c.repo);
  const bad=await c.post('/api/command',{id:'double-use',revision:before.revision,command:{type:'supplierAllocation',date,supplierId,allocations:[{sourceId:'ret',purchaseId:'future',accountId,quantity:'5'}]}});
  assert.equal(bad.status,400);assert.deepEqual(snapshot(c.repo),before);
  await c.run('use-residual',{type:'supplierAllocation',supplierId,allocations:[{sourceId:'ret',purchaseId:'future',accountId,quantity:'1'}]});
  assert.equal(c.repo.state().balances[accountId],-4000);
  assert.equal(supplierDocuments(c.repo.state(),supplierId).purchases.find(p=>p.id==='future').charges[0].remaining,4000);
});

test('agreed return9 versus document reduction10 creates linked debt1 with no second balance entry',async t=>{
  const c=await fixture(t),accountId=await firm(c),supplierId='supplier-firm';
  await c.run('p',{type:'supplierPurchase',supplierId,items:[{accountId:'ceyrek',quantity:'10'}],charges:[{accountId,quantity:'10'}]});
  await c.run('ret',{type:'supplierReturn',supplierId,originalId:'p',items:[{lineIndex:0,quantity:'10'}],reductions:[{accountId,quantity:'10'}],credits:[{accountId,quantity:'9'}],note:'Anlaşılan fark'});
  const state=c.repo.state(),docs=supplierDocuments(state,supplierId);
  assert.equal(state.balances[accountId],-1000);assert.equal(state.balances.ceyrek,0);
  assert.equal(state.journal.find(e=>e.id==='ret').entries.filter(e=>e.accountId===accountId).reduce((sum,e)=>sum+e.delta,0),9000);
  assert.equal(docs.purchases.find(p=>p.id==='p').charges[0].remaining,0);
  assert.equal(docs.purchases.find(p=>p.id==='ret').charges[0].remaining,1000);
  assert.equal(docs.sources.some(s=>s.id==='ret'),false);
  await c.run('pay',{type:'supplierPayment',supplierId,given:[{accountId:'nakit',quantity:'100'}],credits:[{accountId,quantity:'1'}]});
  await c.run('settle-difference',{type:'supplierAllocation',supplierId,allocations:[{sourceId:'pay',purchaseId:'ret',accountId,quantity:'1'}]});
  assert.equal(c.repo.state().balances[accountId],0);
  assert.equal(supplierDocuments(c.repo.state(),supplierId).purchases.find(p=>p.id==='ret').charges[0].remaining,0);
});

test('legacy purchase cannot evade allocation provenance through generic reverse or amendment',async t=>{
  const c=await fixture(t);
  await c.run('legacy',{type:'account',name:'Eski tedarikçi',partyType:'supplier',unit:'TL',opening:'100'});
  const command={type:'purchase',date,source:'supplier',counterpartyId:'cari-legacy',items:[{accountId:'ceyrek',quantity:'1',value:'100'}],payments:[],debts:[{accountId:'cari-legacy',quantity:'100'}]};
  appendHistoricalEvent(c.repo,'p',command);
  await c.run('a',{type:'supplierAllocation',supplierId:'cari-legacy',allocations:[{sourceId:'legacy',purchaseId:'p',accountId:'cari-legacy',quantity:'100'}]});
  const before=snapshot(c.repo);
  for(const command of [{type:'reverse',originalId:'p',note:'Bypass'}, {type:'amend',originalId:'p',replacement:{...c.repo.events().find(e=>e.id==='p').command,note:'changed'},note:'Bypass'}]){
    const response=await c.post('/api/command',{id:'bypass',revision:before.revision,command:{date,...command}});
    assert.equal(response.status,400);assert.match((await response.json()).error,/tahsis/);assert.deepEqual(snapshot(c.repo),before);
  }
});

test('offset explicitly consumes a reserved source and leaves only unused converted target capacity',async t=>{
  const c=await fixture(t),accountId=await firm(c),supplierId='supplier-firm';
  await c.run('usd',{type:'supplierUnit',supplierId,unit:'USD'});
  await c.run('advance',{type:'supplierPayment',supplierId,advanceScope:'reserved',agreementId:'A',given:[{accountId:'nakit',quantity:'1000'}],credits:[{accountId:'supplier-unit-usd',quantity:'100'}]});
  await c.run('p',{type:'supplierPurchase',supplierId,agreementId:'A',items:[{accountId:'ceyrek',quantity:'2'}],charges:[{accountId,quantity:'8'}]});
  const command={type:'supplierOffset',date,supplierId,fromAccountId:'supplier-unit-usd',fromQuantity:'40',toAccountId:accountId,toQuantity:'3',sourceUses:[{sourceId:'advance',quantity:'40'}],targetUses:[{purchaseId:'p',quantity:'2'}],agreementId:'A',note:'Elle anlaşılmış'};
  const before=snapshot(c.repo);
  for(const modified of [{...command,agreementId:'B'},{...command,sourceUses:[{sourceId:'advance',quantity:'20'}]},{...command,targetUses:[{purchaseId:'p',quantity:'4'}]}]){
    const response=await c.post('/api/command',{id:'bad-offset',revision:before.revision,command:modified});assert.equal(response.status,400);assert.deepEqual(snapshot(c.repo),before);
  }
  await c.run('offset',command);
  const docs=supplierDocuments(c.repo.state(),supplierId);
  assert.equal(c.repo.state().balances.nakit,900000);assert.equal(c.repo.state().balances.ceyrek,2);
  assert.equal(c.repo.state().balances[accountId],-5000);assert.equal(c.repo.state().balances['supplier-unit-usd'],6000);
  assert.equal(docs.sources.find(s=>s.id==='advance').credits[0].remaining,6000);
  assert.equal(docs.sources.find(s=>s.id==='offset').credits[0].remaining,1000);
  assert.equal(docs.sources.find(s=>s.id==='offset').advanceScope,'reserved');
  assert.equal(docs.purchases.find(p=>p.id==='p').charges[0].remaining,6000);
});

test('cash receipt must consume explicit credit provenance even when open purchases offset net credit',async t=>{
  const c=await fixture(t),accountId=await firm(c),supplierId='supplier-firm';
  await c.run('advance',{type:'supplierPayment',supplierId,given:[{accountId:'nakit',quantity:'1000'}],credits:[{accountId,quantity:'10'}]});
  await c.run('p',{type:'supplierPurchase',supplierId,items:[{accountId:'ceyrek',quantity:'2'}],charges:[{accountId,quantity:'8'}]});
  assert.equal(c.repo.state().balances[accountId],2000);
  const before=snapshot(c.repo);
  const command={type:'supplierPayment',date,supplierId,received:[{accountId:'nakit',quantity:'500'}],debts:[{accountId,quantity:'5'}]};
  const response=await c.post('/api/command',{id:'refund',revision:before.revision,command});
  assert.equal(response.status,400,'Unspecified source consumption must not leave all 10 HAS reusable after refund5');
  assert.deepEqual(snapshot(c.repo),before);
  await c.run('refund',{...command,debtUses:[{sourceId:'advance',accountId,quantity:'5'}]});
  assert.equal(c.repo.state().balances[accountId],-3000);
  assert.equal(supplierDocuments(c.repo.state(),supplierId).sources.find(s=>s.id==='advance').credits[0].remaining,5000);
  await c.run('surplus',{...command,debts:[{accountId,quantity:'7'}],debtUses:[{sourceId:'advance',accountId,quantity:'5'}]});
  const docs=supplierDocuments(c.repo.state(),supplierId);
  assert.equal(c.repo.state().balances[accountId],-10000);
  assert.equal(docs.sources.find(s=>s.id==='advance').credits[0].remaining,0);
  assert.equal(docs.purchases.find(s=>s.id==='surplus').charges[0].remaining,2000);
});

test('receipt current-event source is consumed before embedded allocation and reserved sources need explicit consent',async t=>{
  const c=await fixture(t),accountId=await firm(c),supplierId='supplier-firm';
  const mixed={type:'supplierPurchase',date,supplierId,items:[{accountId:'ceyrek',quantity:'1'}],charges:[{accountId,quantity:'10'}],given:[{accountId:'nakit',quantity:'1000'}],credits:[{accountId,quantity:'10'}],received:[{accountId:'nakit',quantity:'500'}],debts:[{accountId,quantity:'5'}],debtUses:[{accountId,quantity:'5'}]};
  const before=snapshot(c.repo);
  const bad=await c.post('/api/command',{id:'mixed',revision:before.revision,command:{...mixed,allocations:[{accountId,quantity:'6'}]}});
  assert.equal(bad.status,400);assert.deepEqual(snapshot(c.repo),before);
  await c.run('mixed',{...mixed,allocations:[{accountId,quantity:'5'}]});
  assert.equal(c.repo.state().balances[accountId],-5000);
  assert.equal(supplierDocuments(c.repo.state(),supplierId).sources.find(s=>s.id==='mixed').credits[0].remaining,0);
  await c.run('reserved',{type:'supplierPayment',supplierId,advanceScope:'reserved',agreementId:'A',given:[{accountId:'nakit',quantity:'200'}],credits:[{accountId,quantity:'2'}]});
  const receipt={type:'supplierPayment',date,supplierId,received:[{accountId:'nakit',quantity:'100'}],debts:[{accountId,quantity:'1'}],debtUses:[{sourceId:'reserved',accountId,quantity:'1'}],agreementId:'B'};
  const unchanged=snapshot(c.repo);
  for(const debtUses of [receipt.debtUses,[{...receipt.debtUses[0],overrideReserved:true}]]){
    const response=await c.post('/api/command',{id:'receipt',revision:unchanged.revision,command:{...receipt,debtUses}});
    assert.equal(response.status,400);assert.deepEqual(snapshot(c.repo),unchanged);
  }
  await c.run('receipt',{...receipt,debtUses:[{...receipt.debtUses[0],overrideReserved:true,reason:'Bu tahsilata özel onay'}]});
  const source=supplierDocuments(c.repo.state(),supplierId).sources.find(s=>s.id==='reserved');
  assert.equal(source.credits[0].remaining,1000);assert.equal(source.advanceScope,'reserved');assert.equal(source.agreementId,'A');
});

test('legacy collection cannot bypass native source consumption after supplier redesign',async t=>{
  const c=await fixture(t),supplierId='supplier-firm';await firm(c);
  await c.run('tl',{type:'supplierUnit',supplierId,unit:'TL'});
  await c.run('advance',{type:'supplierPayment',supplierId,given:[{accountId:'nakit',quantity:'100'}],credits:[{accountId:'supplier-unit-tl',quantity:'100'}]});
  const before=snapshot(c.repo);
  const response=await c.post('/api/command',{id:'legacy-refund',revision:before.revision,command:{type:'collection',date,customerAccount:'supplier-unit-tl',target:'nakit',direction:'collect',quantity:'100',note:'Legacy bypass'}});
  assert.equal(response.status,400,'Legacy write must not refund money while leaving native source100 reusable');
  assert.deepEqual(snapshot(c.repo),before);
});
