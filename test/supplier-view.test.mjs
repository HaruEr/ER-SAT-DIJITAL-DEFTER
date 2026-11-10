import test from 'node:test';
import assert from 'node:assert/strict';
import { projectSupplierParties, projectSupplierDetail } from '../supplier-view.mjs';
import {Repository} from '../repository.mjs';
import {INITIAL_ACCOUNTS} from '../domain.mjs';

function fixture() {
  return {revision:4, supplierFirms:[{id:'supplier-new',name:'Yeni Firma'}],accounts:[
    {id:'old',name:'Eski Firma',partyType:'supplier',kind:'receivable',unit:'TL'},
    {id:'old-usd',name:'Eski Firma',partyType:'supplier',kind:'receivable',unit:'USD',parentAccountId:'old'},
    {id:'new-has',name:'Yeni Firma',partyType:'supplier',kind:'receivable',unit:'HAS',supplierId:'supplier-new'},
  ],balances:{old:0,'old-usd':-1000,'new-has':500},journal:[
    {id:'opening',type:'account',date:'2026-11-01',label:'Açılış',entries:[{accountId:'old-usd',delta:-1000}],meta:{}},
    {id:'buy',type:'supplierPurchase',date:'2026-11-02',label:'Ürün alımı',entries:[{accountId:'new-has',delta:-1000}],meta:{supplierId:'supplier-new',lines:[{accountId:'ceyrek',quantity:1}]}},
    {id:'pay',type:'supplierPayment',date:'2026-11-03',label:'Ödeme',entries:[{accountId:'new-has',delta:1500}],meta:{supplierId:'supplier-new'}},
    {id:'link',type:'supplierAllocation',date:'2026-11-03',label:'Tahsis',entries:[],meta:{supplierId:'supplier-new'}},
  ]};
}
test('supplier projection includes unitless identities and legacy families without rewriting state',()=>{
  const state=fixture(),before=structuredClone(state);
  state.supplierFirms.push({id:'empty',name:'Henüz hesabı yok'});
  before.supplierFirms.push({id:'empty',name:'Henüz hesabı yok'});
  const firms=projectSupplierParties(state);
  assert.equal(firms.length,3);
  assert.deepEqual(firms.find(f=>f.id==='empty').accounts,[]);
  assert.deepEqual(firms.find(f=>f.id==='old').accounts.map(a=>a.id),['old','old-usd']);
  assert.equal(firms.find(f=>f.id==='supplier-new').lastEvent.id,'link');
  assert.deepEqual(state,before);
});

test('supplier reversal appears in cash flow and amendment replaces rather than duplicates same-day payment',t=>{
  const repo=new Repository(':memory:','demo');t.after(()=>repo.close());
  const post=(id,c)=>repo.execute({id,revision:repo.state().revision,command:{date:'2026-11-10',...c}});
  post('open',{type:'opening',balances:Object.fromEntries(INITIAL_ACCOUNTS.filter(a=>!a.retired).map(a=>[a.id,a.id==='nakit'?'1000':'0']))});
  post('firm',{type:'supplierFirm',name:'Firma'});post('unit',{type:'supplierUnit',supplierId:'supplier-firm',unit:'TL'});
  const payment=n=>({type:'supplierPayment',supplierId:'supplier-firm',given:[{accountId:'nakit',quantity:String(n)}],credits:[{accountId:'supplier-unit-unit',quantity:String(n)}]});
  post('pay',payment(100));post('fix',{type:'supplierAmend',originalId:'pay',replacement:payment(60),note:'Hatalı tutar düzeltildi'});
  assert.deepEqual(repo.supplierDetail({supplierId:'supplier-firm'}).events.find(e=>e.id==='fix').editableCommand,{date:'2026-11-10',...payment(60)});
  const original=repo.supplierDetail({supplierId:'supplier-firm'}).events.find(e=>e.id==='pay');
  assert.equal(original.status,'amended');assert.deepEqual(original.relatedEventIds,['fix:undo','fix']);
  assert.equal(repo.state().moneyFlow.outgoing,6000);
  post('undo',{type:'supplierReverse',originalId:'fix',note:'Hatalı işlem geri alındı'});
  assert.equal(repo.state().moneyFlow.incoming,6000);
});

test('native purchases are discoverable for inventory with returned quantities removed',t=>{
  const repo=new Repository(':memory:','demo');t.after(()=>repo.close());
  const post=(id,c)=>repo.execute({id,revision:repo.state().revision,command:{date:'2026-11-10',...c}});
  post('open',{type:'opening',balances:Object.fromEntries(INITIAL_ACCOUNTS.filter(a=>!a.retired).map(a=>[a.id,'0']))});
  post('firm',{type:'supplierFirm',name:'Firma'});post('unit',{type:'supplierUnit',supplierId:'supplier-firm',unit:'HAS'});
  post('buy',{type:'supplierPurchase',supplierId:'supplier-firm',items:[{accountId:'ceyrek',quantity:'3'}],charges:[{accountId:'supplier-unit-unit',quantity:'6'}]});
  post('ret',{type:'supplierReturn',supplierId:'supplier-firm',originalId:'buy',note:'Kısmi iade',items:[{lineIndex:0,quantity:'1'}],credits:[{accountId:'supplier-unit-unit',quantity:'2'}],reductions:[{accountId:'supplier-unit-unit',quantity:'2'}]});
  const page=repo.journalPage({scope:'all',type:'purchases',q:'',limit:30});
  assert.deepEqual(page.items.map(e=>e.id),['buy']);
  assert.equal(page.supplierPurchaseInfo.buy[0].remainingQuantity,2);
  assert.equal(page.items[0].meta.lines[0].value,undefined);
});

test('amendment preview restores original source capacity without changing the actual ledger',t=>{
  const repo=new Repository(':memory:','demo');t.after(()=>repo.close());
  const post=(id,c)=>repo.execute({id,revision:repo.state().revision,command:{date:'2026-11-10',...c}});
  post('open',{type:'opening',balances:Object.fromEntries(INITIAL_ACCOUNTS.filter(a=>!a.retired).map(a=>[a.id,a.id==='nakit'?'1000':'0']))});
  post('firm',{type:'supplierFirm',name:'Firma'});post('unit',{type:'supplierUnit',supplierId:'supplier-firm',unit:'TL'});
  post('buy',{type:'supplierPurchase',supplierId:'supplier-firm',items:[{accountId:'ceyrek',quantity:'1'}],charges:[{accountId:'supplier-unit-unit',quantity:'100'}]});
  post('pay',{type:'supplierPayment',supplierId:'supplier-firm',given:[{accountId:'nakit',quantity:'100'}],credits:[{accountId:'supplier-unit-unit',quantity:'100'}]});
  post('link',{type:'supplierAllocation',supplierId:'supplier-firm',allocations:[{sourceId:'pay',purchaseId:'buy',accountId:'supplier-unit-unit',quantity:'100'}]});
  const before=repo.backup(),detail=repo.supplierDetail({supplierId:'supplier-firm',editOriginalId:'link'});
  assert.equal(detail.documents.sources[0].credits[0].remaining,0);
  assert.equal(detail.amendment.documents.sources[0].credits[0].remaining,10000);
  assert.equal(detail.amendment.documents.purchases[0].charges[0].remaining,10000);
  assert.deepEqual(repo.events(),before.events);
  assert.throws(()=>repo.supplierDetail({supplierId:'supplier-firm',editOriginalId:'pay'}),/tahsis|bağlı/);
});
test('one trade event once, native before/after, and sign crossing splits debt reduction from credit increase',()=>{
  const view=projectSupplierDetail(fixture(),{supplierId:'supplier-new'});
  assert.deepEqual(view.events.map(e=>e.id),['link','pay','buy']);
  assert.deepEqual(view.events.find(e=>e.id==='pay').balances,[{accountId:'new-has',unit:'HAS',before:-1000,delta:1500,after:500}]);
  assert.equal(view.events.find(e=>e.id==='buy').meta.referenceTL,undefined);
  assert.deepEqual(view.statements[0],{accountId:'new-has',unit:'HAS',opening:0,debtIncrease:1000,debtDecrease:1000,creditIncrease:500,creditDecrease:0,closing:500});
});
test('period balances separate from current; paged history includes metadata-only events and rejects stale cursor',()=>{
  const state=fixture();
  const page=projectSupplierDetail(state,{supplierId:'supplier-new',startDate:'2026-11-03',limit:1});
  assert.equal(page.accounts[0].balance,500);
  assert.equal(page.statements[0].opening,-1000);
  assert.equal(page.events[0].id,'link');
  assert.equal(page.total,2);
  const next=projectSupplierDetail(state,{supplierId:'supplier-new',startDate:'2026-11-03',limit:1,cursor:page.nextCursor});
  assert.equal(next.events[0].id,'pay');
  assert.throws(()=>projectSupplierDetail({...state,revision:5},{supplierId:'supplier-new',cursor:page.nextCursor}),/değişti/);
  assert.throws(()=>projectSupplierDetail(state,{supplierId:'supplier-new',startDate:'2026-11-04',endDate:'2026-11-01'}));
});

test('document capacity and reversal status remain visible outside selected history period',()=>{
  const state=fixture();
  state.journal.find(e=>e.id==='buy').meta.chargeLines=[{accountId:'new-has',quantity:1000}];
  state.journal.find(e=>e.id==='pay').meta.creditLines=[{accountId:'new-has',quantity:1500}];
  state.journal.push({id:'undo',type:'supplierReverse',date:'2026-11-04',entries:[{accountId:'new-has',delta:-1500}],meta:{supplierId:'supplier-new',originalId:'pay'}});
  const result=projectSupplierDetail(state,{supplierId:'supplier-new',endDate:'2026-11-03'});
  assert.equal(result.events.find(e=>e.id==='pay').status,'reversed');
  assert.deepEqual(result.events.find(e=>e.id==='pay').relatedEventIds,['undo']);
  assert.equal(result.documents.sources.some(s=>s.id==='pay'),false);
  assert.equal(result.documents.purchases[0].charges[0].remaining,1000);
});

test('historical supplier statement excludes units created after period end while current card remains current',()=>{
 const state=fixture();
 state.accounts.push({id:'later',name:'Yeni Firma',partyType:'supplier',kind:'receivable',unit:'EUR',supplierId:'supplier-new'});
 state.balances.later=0;
 state.journal.push({id:'later-unit',date:'2026-11-05',type:'supplierUnit',entries:[{accountId:'later',delta:0}],meta:{supplierId:'supplier-new',accountId:'later'}});
 const historical=projectSupplierDetail(state,{supplierId:'supplier-new',endDate:'2026-11-04'});
 assert.equal(historical.accounts.some(a=>a.id==='later'),true);
 assert.equal(historical.statements.some(a=>a.accountId==='later'),false);
 const atCreation=projectSupplierDetail(state,{supplierId:'supplier-new',endDate:'2026-11-05'});
 assert.equal(atCreation.statements.find(a=>a.accountId==='later').closing,0);
});

test('read-only history can omit document capacities without changing events, units or totals',()=>{
 const s=fixture(),normal=projectSupplierDetail(s,{supplierId:'supplier-new'});
 const lean=projectSupplierDetail(s,{supplierId:'supplier-new',includeDocuments:false});
 assert.equal(Object.hasOwn(lean,'documents'),false);
 const {documents,...rest}=normal;assert.deepEqual(lean,rest);
 assert.throws(()=>projectSupplierDetail(s,{supplierId:'supplier-new',includeDocuments:'false'}));
});

test('supplier cursors bind capacity mode and past legacy account opening is excluded',()=>{
 const state=fixture();
 const page=projectSupplierDetail(state,{supplierId:'supplier-new',limit:1,includeDocuments:false});
 assert.throws(()=>projectSupplierDetail(state,{supplierId:'supplier-new',limit:1,cursor:page.nextCursor}),/döneme/);
 state.journal[0].meta.accountId='old-usd';
 const old=projectSupplierDetail(state,{supplierId:'old',endDate:'2026-10-31'});
 assert.equal(old.statements.some(row=>row.accountId==='old-usd'),false);
 assert.equal(old.accounts.find(row=>row.id==='old-usd').balance,-1000);
});

test('supplier document display metadata preserves source notes without altering capacities or journal',()=>{
 const s=fixture();s.journal.find(e=>e.id==='buy').meta.note='Alış açıklaması';s.journal.find(e=>e.id==='pay').meta.note='Ödeme açıklaması';s.journal.find(e=>e.id==='pay').meta.creditLines=[{accountId:'new-has',quantity:1500}];const before=JSON.stringify(s);const result=projectSupplierDetail(s,{supplierId:'supplier-new'});assert.equal(result.documents.purchases[0].note,'Alış açıklaması');assert.equal(result.documents.sources[0].note,'Ödeme açıklaması');assert.equal(result.documents.sources[0].label,s.journal.find(e=>e.id==='pay').label);assert.equal(JSON.stringify(s),before);
});
