import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {createApp} from '../server.mjs';
import {INITIAL_ACCOUNTS} from '../domain.mjs';
import {authenticateTestOwner,ownerFetch} from '../test-support/editor-session.mjs';

const date='2026-11-10',supplierId='supplier-firm',accountId='supplier-unit-unit';
const snapshot=repo=>({events:repo.events(),state:repo.state(),meta:repo.db.prepare('SELECT * FROM meta').all(),archives:repo.db.prepare('SELECT * FROM restore_archive').all()});
async function fixture(t){
  const root=resolve(tmpdir()),directory=mkdtempSync(join(root,'supplier-preview-'));
  const {server,repositories}=createApp({dataDirectory:directory,logger:()=>{}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));await authenticateTestOwner(server);
  t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});assert.equal(dirname(resolve(directory)),root);rmSync(directory,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+server.address().port;
  const post=(path,data)=>ownerFetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  await ownerFetch(base+'/api/state');const repo=repositories.get('demo');
  const run=(id,c)=>repo.execute({id,revision:repo.state().revision,command:{date,...c}});
  run('opening',{type:'opening',balances:Object.fromEntries(INITIAL_ACCOUNTS.filter(a=>!a.retired).map(a=>[a.id,a.id==='nakit'?'1000':'0']))});
  run('firm',{type:'supplierFirm',name:'Preview firm'});run('unit',{type:'supplierUnit',supplierId,unit:'TL'});
  const preview=(id,extra='')=>ownerFetch(base+'/api/suppliers?supplierId='+supplierId+'&editOriginalId='+encodeURIComponent(id)+extra);
  return {base,repo,post,run,preview};
}
const purchase={type:'supplierPurchase',supplierId,items:[{accountId:'ceyrek',quantity:'1',referenceTL:'0'}],charges:[{accountId,quantity:'100'}],note:'Exact command <&>',agreementId:'A'};

test('supplier edit preview is owner-only, same-firm and nonmutating for success or rejection',async t=>{
  const c=await fixture(t);c.run('buy',purchase);c.run('other',{type:'supplierFirm',name:'Other'});
  const created=await c.post('/api/auth/employees',{name:'Worker',password:'synthetic-preview-worker'});assert.equal(created.status,201);
  const person=await created.json();const login=await fetch(c.base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:person.id,password:'synthetic-preview-worker'})});
  assert.equal(login.status,200);const {token}=await login.json();
  const url=c.base+'/api/suppliers?supplierId='+supplierId+'&editOriginalId=buy',before=snapshot(c.repo);
  assert.equal((await fetch(url)).status,401);
  assert.equal((await fetch(url,{headers:{Authorization:'Bearer '+token}})).status,403);
  assert.equal((await ownerFetch(c.base+'/api/suppliers?supplierId=supplier-other&editOriginalId=buy')).status,400);
  for(const id of ['opening','firm','missing'])assert.equal((await c.preview(id)).status,400);
  const response=await c.preview('buy');assert.equal(response.status,200);const detail=await response.json();
  assert.deepEqual(detail.events.find(e=>e.id==='buy').editableCommand,{date,...purchase});
  assert.equal(detail.revision,before.state.revision);
  assert.equal(detail.amendment.documents.purchases.some(p=>p.id==='buy'),false);
  assert.deepEqual(snapshot(c.repo),before);
});

test('preview permits temporary negative physical reversal but keeps real revision and final amendment validation',async t=>{
  const c=await fixture(t);c.run('buy',purchase);
  c.run('sold',{type:'sale',items:[{accountId:'ceyrek',quantity:'1',value:'100'}],received:[{accountId:'nakit',quantity:'100'}],credits:[],debts:[]});
  c.run('supplier-amend-preview-0',{type:'movement',accountId:'nakit',direction:'in',category:'Sermaye',quantity:'1'});
  const before=snapshot(c.repo),response=await c.preview('buy');assert.equal(response.status,200);
  const detail=await response.json();assert.equal(detail.amendment.balances.ceyrek,-1);assert.equal(detail.accounts[0].balance,-10000);
  assert.deepEqual(snapshot(c.repo),before);
  c.run('concurrent',{type:'movement',accountId:'nakit',direction:'in',category:'Sermaye',quantity:'1'});
  const stale=await c.post('/api/command',{id:'edit',revision:detail.revision,command:{type:'supplierAmend',date,originalId:'buy',replacement:{...purchase,note:'corrected'},note:'reason'}});
  assert.equal(stale.status,409);
  const current=snapshot(c.repo);
  const invalid=await c.post('/api/command',{id:'edit-invalid',revision:current.state.revision,command:{type:'supplierAmend',date,originalId:'buy',replacement:{...purchase,items:[{accountId:'yarim',quantity:'1'}]},note:'wrong product'}});
  assert.equal(invalid.status,400);assert.deepEqual(snapshot(c.repo),current);
  const valid=await c.post('/api/command',{id:'edit',revision:current.state.revision,command:{type:'supplierAmend',date,originalId:'buy',replacement:{...purchase,note:'corrected'},note:'reason'}});
  assert.equal(valid.status,200);assert.equal(c.repo.state().balances.ceyrek,0);
  assert.equal(c.repo.events().some(e=>e.id==='supplier-amend-preview-1'),false);
});

test('preview releases its own allocation capacities but cannot bypass payment or return dependencies',async t=>{
  const c=await fixture(t);c.run('buy',purchase);
  c.run('pay',{type:'supplierPayment',supplierId,given:[{accountId:'nakit',quantity:'60'}],credits:[{accountId,quantity:'60'}]});
  c.run('allocate',{type:'supplierAllocation',supplierId,allocations:[{sourceId:'pay',purchaseId:'buy',accountId,quantity:'60'}]});
  const before=snapshot(c.repo);assert.equal((await c.preview('pay')).status,400);assert.equal((await c.preview('buy')).status,400);
  const response=await c.preview('allocate');assert.equal(response.status,200);const detail=await response.json();
  assert.equal(detail.amendment.documents.sources.find(s=>s.id==='pay').credits[0].remaining,6000);
  assert.equal(detail.amendment.documents.purchases.find(p=>p.id==='buy').charges[0].remaining,10000);
  assert.equal(detail.documents.purchases.find(p=>p.id==='buy').charges[0].remaining,4000);
  assert.deepEqual(snapshot(c.repo),before);
  c.run('return',{type:'supplierReturn',supplierId,originalId:'buy',items:[{lineIndex:0,quantity:'1'}],reductions:[{accountId,quantity:'40'}],credits:[{accountId,quantity:'40'}],note:'returned'});
  const returned=snapshot(c.repo);assert.equal((await c.preview('allocate')).status,400);assert.deepEqual(snapshot(c.repo),returned);
  assert.equal((await c.preview('return')).status,200);assert.deepEqual(snapshot(c.repo),returned);
});

test('payment and offset previews restore native source quantities without changing physical money',async t=>{
  const c=await fixture(t);c.run('buy',purchase);c.run('usd',{type:'supplierUnit',supplierId,unit:'USD'});
  c.run('pay',{type:'supplierPayment',supplierId,given:[{accountId:'nakit',quantity:'40'}],credits:[{accountId:'supplier-unit-usd',quantity:'20'}]});
  const before=snapshot(c.repo),payment=await c.preview('pay');assert.equal(payment.status,200);
  const paymentDetail=await payment.json();assert.equal(paymentDetail.amendment.balances['supplier-unit-usd'],0);
  assert.equal(paymentDetail.amendment.balances.nakit,100000);assert.deepEqual(snapshot(c.repo),before);
  c.run('offset',{type:'supplierOffset',supplierId,fromAccountId:'supplier-unit-usd',fromQuantity:'10',toAccountId:accountId,toQuantity:'30',sourceUses:[{sourceId:'pay',quantity:'10'}],targetUses:[{purchaseId:'buy',quantity:'30'}],note:'Manual agreement'});
  const committed=snapshot(c.repo),response=await c.preview('offset');assert.equal(response.status,200);
  const detail=await response.json();
  assert.equal(detail.amendment.balances['supplier-unit-usd'],2000);assert.equal(detail.amendment.balances[accountId],-10000);
  assert.equal(detail.amendment.balances.nakit,committed.state.balances.nakit);
  assert.equal(detail.amendment.documents.sources.find(s=>s.id==='pay').credits[0].remaining,2000);
  assert.equal(detail.amendment.documents.purchases.find(p=>p.id==='buy').charges[0].remaining,10000);
  assert.deepEqual(snapshot(c.repo),committed);assert.equal((await c.preview('pay')).status,400);
});
