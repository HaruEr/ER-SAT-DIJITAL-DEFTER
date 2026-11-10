import test from 'node:test';
import assert from 'node:assert/strict';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS, replay } from '../domain.mjs';
import { ReportRepository } from '../report-repository.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const date='2026-11-10', customer='cari-person';
const transfer={type:'scrapAdvanceTransfer',orderId:'order',purchaseId:'scrap',customerId:customer,amountTL:'15',note:'Müşteri bu alış borcunu sipariş avansına ayırdı'};
function fixture(t,paid='60') {
 const repo=new Repository(':memory:','demo');t.after(()=>repo.close());
 const post=(id,c)=>repo.execute({id,revision:repo.state().revision,command:{date,...c}});
 post('open',{type:'opening',balances:Object.fromEntries(INITIAL_ACCOUNTS.filter(a=>!a.retired).map(a=>[a.id,a.id==='nakit'?'500':a.id==='ceyrek'?'5':'0']))});
 post('person',{type:'account',partyType:'customer',name:'Müşteri',unit:'TL',opening:'0'});
 const purchase={type:'purchase',source:'customer',counterpartyType:'customer',counterpartyId:customer,items:[{accountId:'hurda14',quantity:'3',value:'100'}],received:[],given:[{accountId:'nakit',quantity:paid}],credits:[],debts:Number(paid)<100?[{accountId:customer,quantity:String(100-Number(paid))}]:[]};
 post('scrap',purchase);
 post('order',{type:'customerOrder',customerId:customer,description:'Sonraki satış'});
 return {repo,post,purchase};
}
test('explicit partial scrap payable conversion posts only customer liability and reusable advance, then one final sale',t=>{
 const {repo,post}=fixture(t), before=repo.state();
 post('transfer',transfer);
 const after=repo.state(),entry=after.journal.at(-1),advance=after.customerOrders[0].advances[0];
 assert.equal(repo.events().at(-1).schemaVersion,16);
 assert.deepEqual(entry.entries,[{accountId:customer,delta:1500}]);
 assert.equal(after.balances[customer],-2500);assert.equal(after.balances.nakit,before.balances.nakit);
 assert.equal(after.balances.hurda14,before.balances.hurda14);assert.equal(after.customerOrders[0].availableTL,1500);
 assert.equal(advance.sourcePurchaseId,'scrap');
 assert.deepEqual(after.moneyFlow,before.moneyFlow);
 assert.equal(post('transfer',transfer).duplicate,true);
 post('sale',{type:'sale',counterpartyType:'customer',counterpartyId:customer,items:[{accountId:'ceyrek',quantity:'1',value:'20'}],received:[{accountId:'nakit',quantity:'5'}],given:[],credits:[],debts:[],orderSettlement:{orderId:'order',advances:[{advanceId:'transfer',amountTL:'15'}]}});
 assert.equal(repo.state().customerOrders[0].availableTL,0);assert.equal(repo.state().balances[customer],-2500);
 assert.equal(repo.state().balances.nakit,before.balances.nakit+500);
 const page=repo.journalPage({scope:'all',type:'sale'}), context=[...page.items,...page.receiptContext];
 for(const id of ['scrap','transfer','order','sale']) assert.ok(context.some(e=>e.id===id),id);
 assert.ok(repo.journalPage({scope:'all',accountId:customer}).items.some(e=>e.id==='transfer'));
 assert.throws(()=>post('undo-used',{type:'scrapAdvanceUndo',orderId:'order',advanceId:'transfer',amountTL:'0.01',note:'İptal'}));
 assert.deepEqual(replay(repo.events()).customerOrders,repo.state().customerOrders);
 const restored=new Repository(':memory:','demo');t.after(()=>restored.close());
 restored.restore({backup:repo.backup(),revision:0,confirmation:'GERİ YÜKLE'});
 assert.deepEqual(restored.state().balances,repo.state().balances);
});
test('partial undo restores payable, cash refunds stay consumed, and source edit/reverse is guarded',t=>{
 const {repo,post,purchase}=fixture(t);
 post('transfer',{...transfer,amountTL:'30'});
 post('undo',{type:'scrapAdvanceUndo',orderId:'order',advanceId:'transfer',amountTL:'10',note:'Avans seçimini geri al'});
 assert.equal(repo.state().balances[customer],-2000);assert.equal(repo.state().customerOrders[0].availableTL,2000);
 assert.throws(()=>post('reverse',{type:'reverse',originalId:'scrap',note:'İptal'}));
 assert.throws(()=>post('amend',{type:'amend',originalId:'scrap',replacement:purchase,note:'Düzelt'}));
 post('cash-refund',{type:'orderRefund',orderId:'order',advanceId:'transfer',accountId:'nakit',amountTL:'5'});
 assert.equal(repo.state().customerOrders[0].availableTL,1500);
 assert.throws(()=>post('over-undo',{type:'scrapAdvanceUndo',orderId:'order',advanceId:'transfer',amountTL:'15.01',note:'İptal'}));
 post('rest-undo',{type:'scrapAdvanceUndo',orderId:'order',advanceId:'transfer',amountTL:'15',note:'Geri al'});
 assert.equal(repo.state().balances[customer],-3500);
 assert.throws(()=>post('reverse-paid',{type:'reverse',originalId:'scrap',note:'İptal'}));
});
test('entire unused transfer can be undone and source then corrected or reversed',t=>{
 const {repo,post}=fixture(t);
 post('transfer',transfer);
 post('undo',{type:'scrapAdvanceUndo',orderId:'order',advanceId:'transfer',amountTL:'15',note:'Geri al'});
 post('cancel',{type:'orderCancel',orderId:'order',note:'Vazgeçildi'});
 post('reverse',{type:'reverse',originalId:'scrap',note:'Yanlış kayıt'});
 assert.equal(repo.state().balances[customer],0);assert.equal(repo.state().balances.nakit,50000);
});
test('paid source, source cap, current net debt cap and ill-typed commands cannot create advance',t=>{
 const {repo,post}=fixture(t);
 for(const changes of [{amountTL:'40.01'},{amountTL:'-1'},{customerId:'other'},{purchaseId:'open'},{purchaseId:{}},{note:''},{orderId:'none'},{amountTL:1500},{accountId:'nakit'}]) {
  const before=repo.state();assert.throws(()=>post('bad',{...transfer,...changes}));assert.deepEqual(repo.state(),before);
 }
 post('payment',{type:'collection',customerAccount:customer,target:'nakit',quantity:'30',direction:'pay'});
 assert.throws(()=>post('too-much',transfer));
 post('limited',{...transfer,amountTL:'10'});
 assert.equal(repo.state().balances[customer],0);
 assert.throws(()=>post('again',{...transfer,amountTL:'0.01'}));
});
test('fully paid scrap cannot be attributed even when another transaction creates net payable',t=>{
 const {post,purchase}=fixture(t,'100');
 post('other-purchase',{...purchase,given:[],debts:[{accountId:customer,quantity:'100'}]});
 assert.throws(()=>post('bad',transfer));
});

test('source capacity is explicit attribution bounded by current pooled debt, across orders and prior payments',t=>{
 const {repo,post,purchase}=fixture(t);
 post('pay-first',{type:'collection',customerAccount:customer,target:'nakit',quantity:'40',direction:'pay'});
 assert.throws(()=>post('without-debt',transfer));
 post('second-purchase',purchase);
 const choices=repo.journalPage({scope:'all',type:'purchase',scrapForAdvance:customer});
 assert.equal(choices.items.find(e=>e.id==='scrap').scrapAdvanceCapacityTL,4000);
 post('transfer',{...transfer,amountTL:'30'});
 post('order2',{type:'customerOrder',customerId:customer,description:'İkinci sipariş'});
 assert.throws(()=>post('exceed-source',{...transfer,orderId:'order2',amountTL:'10.01'}));
 post('last-capacity',{...transfer,orderId:'order2',amountTL:'10'});
 assert.equal(repo.state().balances[customer],0);
 assert.ok(!repo.journalPage({scope:'all',type:'purchase',scrapForAdvance:customer}).items.some(e=>e.id==='scrap'));
});

test('new event version and employee audit cannot bypass owner-only transfer; malformed dates and mixed scrap are rejected',t=>{
 const {repo,post,purchase}=fixture(t);
 post('mixed',{...purchase,items:[{accountId:'hurda14',quantity:'1',value:'50'},{accountId:'ceyrek',quantity:'1',value:'50'}]});
 assert.throws(()=>post('mixed-transfer',{...transfer,purchaseId:'mixed'}));
 assert.throws(()=>post('closed-date',{...transfer,date:'2026-11-09'}));
 post('transfer',transfer);
 const history=repo.events();
 const mutate=fn=>{const events=structuredClone(history);fn(events.at(-1));assert.throws(()=>replay(events));};
 mutate(e=>e.schemaVersion=11);
 mutate(e=>e.command.type='orderAdvance');
 mutate(e=>e.audit={version:1,actor:{id:'10000000-0000-0000-0000-000000000001',name:'Çalışan',role:'employee'}});
});

test('read-only mobile repository replays transfer and undo with correct balances and no cash income',t=>{
 const {repo,post}=fixture(t);
 post('transfer',transfer);
 post('undo',{type:'scrapAdvanceUndo',orderId:'order',advanceId:'transfer',amountTL:'5',note:'Kısmi geri alma'});
 const dir=mkdtempSync(join(tmpdir(),'scrap-advance-report-')),path=join(dir,'demo.sqlite');
 try {
  const target=new Repository(path,'demo');
  try {target.restore({backup:repo.backup(),revision:0,confirmation:'GERİ YÜKLE'});} finally {target.close();}
  const report=new ReportRepository(path);
  try {
   assert.equal(report.overview().accounts.find(a=>a.id===customer).balance,-3000);
   assert.equal(report.journal({type:'scrapAdvanceTransfer'}).items[0].entries[0].delta,1500);
   assert.equal(report.journal({type:'scrapAdvanceUndo'}).items[0].entries[0].delta,-500);
   assert.equal(report.overview().totals.sales,0);
  } finally {report.close();}
 } finally {rmSync(dir,{recursive:true,force:true});}
});
