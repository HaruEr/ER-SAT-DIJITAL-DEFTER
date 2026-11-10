import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, emptyState, eventVersion, INITIAL_ACCOUNTS, replay } from '../domain.mjs';

const date = '2026-11-10';
const owner = { id:'c8d7225e-5535-49ed-b37f-5f6d0e7d09ef', name:'Sentetik sahip', role:'owner' };
function fixture() {
  let state = emptyState();
  const events = [];
  const write = (id, command, extra = {}) => {
    command = { date, ...command };
    const event = { id, schemaVersion:eventVersion(command,state), command, ...extra };
    state = applyEvent(state,event);
    events.push(event);
    return state;
  };
  const balances = Object.fromEntries(INITIAL_ACCOUNTS.filter(a=>!a.retired).map(a=>[a.id,'0']));
  write('opening',{type:'opening',balances:{...balances,nakit:'1000000',usd:'1000',ceyrek:'20',yuzuk:'2',taki14:'10',hurda22:'30'}});
  return {write,events,get state(){return state;}};
}
function company(f,id='firm') {
  f.write(id,{type:'supplierFirm',name:'Firma '+id,phone:'555 123 4567'});
  for(const unit of ['HAS','TL','USD','SILVER'])f.write(id+'-'+unit,{type:'supplierUnit',supplierId:'supplier-'+id,unit});
  return {id:'supplier-'+id,HAS:'supplier-unit-'+id+'-HAS',TL:'supplier-unit-'+id+'-TL',USD:'supplier-unit-'+id+'-USD',SILVER:'supplier-unit-'+id+'-SILVER'};
}
function rejected(f,id,command,extra) {
  const before=structuredClone(f.state),events=structuredClone(f.events);
  assert.throws(()=>f.write(id,command,extra));
  assert.deepEqual(f.state,before);
  assert.deepEqual(f.events,events);
}

test('supplier identity starts without a forced unit and adding units creates only zero balances', async()=>{
  const f=fixture();
  assert.equal(eventVersion({type:'supplierFirm',name:'A'},f.state),17);
  f.write('firm',{type:'supplierFirm',name:'Firma A',phone:'555 123',address:'Sentetik adres'}, {audit:{version:1,actor:owner}});
  assert.equal(f.state.supplierFirms.length,1);
  assert.equal(f.state.supplierFirms[0].id,'supplier-firm');
  assert.equal(f.state.accounts.filter(a=>a.supplierId).length,0);
  f.write('has',{type:'supplierUnit',supplierId:'supplier-firm',unit:'HAS'});
  const a=f.state.accounts.find(a=>a.id==='supplier-unit-has');
  assert.equal(a.supplierId,'supplier-firm');assert.equal(a.unit,'HAS');assert.equal(f.state.balances[a.id],0);
  assert.equal(f.state.journal.at(-1).meta.supplierId,'supplier-firm');
  rejected(f,'duplicate-unit',{type:'supplierUnit',supplierId:'supplier-firm',unit:'HAS'});
  rejected(f,'fake-opening',{type:'supplierUnit',supplierId:'supplier-firm',unit:'USD',opening:'10'});
  f.write('edit',{type:'supplierFirmUpdate',supplierId:'supplier-firm',name:'Yeni firma adı'});
  assert.equal(f.state.supplierFirms[0].name,'Yeni firma adı');assert.equal(f.state.supplierFirms[0].phone,'555 123');
  const {supplierFirms,supplierAccountIds}=await import('../supplier-ledger.mjs');
  assert.equal(supplierFirms(f.state)[0].id,'supplier-firm');assert.deepEqual(supplierAccountIds(f.state,'supplier-firm'),['supplier-unit-has']);
});

test('purchase records actual pieces and grams and agreed native charges without fabricated TL values',()=>{
  const f=fixture(),firm=company(f);
  f.write('purchase',{type:'supplierPurchase',supplierId:firm.id,
    items:[{accountId:'ceyrek',quantity:'10'},{accountId:'yuzuk',quantity:'2',weightAccount:'taki14',weight:'7.2'}],
    charges:[{accountId:firm.HAS,quantity:'16.530'},{accountId:firm.USD,quantity:'500'}]});
  assert.equal(f.state.balances.ceyrek,30);assert.equal(f.state.balances.yuzuk,4);assert.equal(f.state.balances.taki14,17200);
  assert.equal(f.state.balances[firm.HAS],-16530);assert.equal(f.state.balances[firm.USD],-50000);
  const meta=f.state.journal.at(-1).meta;
  assert.equal(meta.chargeLines[0].quantity,16530);assert.equal(meta.lines[1].weight,7200);
  for(const row of meta.lines){assert.equal(Object.hasOwn(row,'value'),false);assert.equal(Object.hasOwn(row,'referenceTL'),false);}
  assert.equal(Object.hasOwn(meta,'purchaseTotal'),false);assert.equal(Object.hasOwn(meta,'referenceTL'),false);
  assert.deepEqual(replay(f.events),f.state);
});

test('payment supports debtless reserved advances and mixed physical consideration without conversion',()=>{
  const f=fixture(),firm=company(f);
  f.write('advance',{type:'supplierPayment',supplierId:firm.id,given:[{accountId:'nakit',quantity:'100000'},{accountId:'usd',quantity:'100'},{accountId:'hurda22',quantity:'2.4'}],
    credits:[{accountId:firm.HAS,quantity:'15.000'},{accountId:firm.SILVER,quantity:'20'}],advanceScope:'reserved',agreementId:'Yüzük siparişi',referenceTL:'0'});
  assert.equal(f.state.balances.nakit,90000000);assert.equal(f.state.balances.usd,90000);assert.equal(f.state.balances.hurda22,27600);
  assert.equal(f.state.balances[firm.HAS],15000);assert.equal(f.state.balances[firm.SILVER],20000);
  assert.equal(f.state.journal.at(-1).meta.referenceTL,0);assert.equal(f.state.journal.at(-1).meta.advanceScope,'reserved');
  f.write('collect',{type:'supplierPayment',supplierId:firm.id,received:[{accountId:'usd',quantity:'50'}],debts:[{accountId:firm.HAS,quantity:'3'}],debtUses:[{sourceId:'advance',accountId:firm.HAS,quantity:'3'}],agreementId:'Yüzük siparişi'});
  assert.equal(f.state.balances.usd,95000);assert.equal(f.state.balances[firm.HAS],12000);
  assert.deepEqual(replay(f.events),f.state);
});

test('part-paid purchase keeps gross native obligation and explicit settlement in one event',()=>{
  const f=fixture(),firm=company(f);
  f.write('purchase',{type:'supplierPurchase',supplierId:firm.id,items:[{accountId:'ceyrek',quantity:'3',referenceTL:'60000'}],charges:[{accountId:firm.HAS,quantity:'9.5'}],given:[{accountId:'nakit',quantity:'20000'}],credits:[{accountId:firm.HAS,quantity:'3.25'}],agreementId:'A'});
  assert.equal(f.state.balances.ceyrek,23);assert.equal(f.state.balances[firm.HAS],-6250);
  assert.equal(f.state.balances.nakit,98000000);assert.equal(f.state.journal.at(-1).meta.lines[0].referenceTL,6000000);
  assert.equal(f.state.journal.at(-1).meta.chargeLines[0].quantity,9500);
});

test('malformed, cross-firm, incomplete, forbidden and insufficient physical trades fail atomically',()=>{
  const f=fixture(),firm=company(f),other=company(f,'other');
  const payment={type:'supplierPayment',supplierId:firm.id,given:[{accountId:'nakit',quantity:'1'}],credits:[{accountId:firm.TL,quantity:'1'}]};
  for(const change of [
    {credits:[{accountId:other.TL,quantity:'1'}]}, {credits:[]}, {given:[]}, {advanceScope:'reserved'},
    {given:[{accountId:'pos',quantity:'1'}]}, {given:[{accountId:'nakit',quantity:'1000001'}]},
    {given:[{accountId:'nakit',quantity:'-1'}]}, {credits:[{accountId:firm.HAS,quantity:'0.0001'}]},
    {given:{some:true}}, {given:[{accountId:'nakit',quantity:'1',valueTL:'1'}]}, {surprise:true},
    {given:[{accountId:'taki14',quantity:'1'}]}, {given:[{accountId:'yuzuk',quantity:'1',weightAccount:'taki22',weight:'1'}]}
  ])rejected(f,'bad', {...payment,...change});
  rejected(f,'worker',payment,{audit:{version:1,actor:{...owner,role:'employee'}}});
  rejected(f,'wrong-date',{...payment,date:'2026-11-11'});
  const purchase={type:'supplierPurchase',supplierId:firm.id,items:[{accountId:'ceyrek',quantity:'1'}],charges:[{accountId:firm.TL,quantity:'1'}]};
  rejected(f,'missing-charges',{...purchase,charges:[]});
  rejected(f,'unhandled-item-code',{...purchase,items:[{...purchase.items[0],inventoryCode:'ignored'}]});
});

test('schema17 is exclusive and historical supplier families adapt without changing stored identities',async()=>{
  const f=fixture();
  f.write('legacy',{type:'account',name:'Eski firma',partyType:'supplier',unit:'TL',opening:'-12'});
  f.write('legacy-usd',{type:'account',parentAccountId:'cari-legacy',unit:'USD',opening:'-2'});
  const before=structuredClone(f.state),oldEvents=structuredClone(f.events);
  const {supplierFirms,supplierAccountIds}=await import('../supplier-ledger.mjs');
  assert.deepEqual(supplierAccountIds(f.state,'cari-legacy'),['cari-legacy','cari-legacy-usd']);
  assert.equal(supplierFirms(f.state).find(a=>a.id==='cari-legacy').legacy,true);
  assert.deepEqual(f.state,before);assert.deepEqual(f.events,oldEvents);
  f.write('legacy-has',{type:'supplierUnit',supplierId:'cari-legacy',unit:'HAS'});
  f.write('pay',{type:'supplierPayment',supplierId:'cari-legacy',given:[{accountId:'usd',quantity:'1'}],credits:[{accountId:'cari-legacy',quantity:'5'}]});
  assert.equal(f.state.balances['cari-legacy'],-700);
  const last=f.events.at(-1);
  for(const schemaVersion of [undefined,3,6,7,8,10,11,16])assert.throws(()=>applyEvent(before,{...last,schemaVersion}));
  assert.throws(()=>applyEvent(before,{id:'legacy17',schemaVersion:17,command:{type:'movement',date,accountId:'nakit',direction:'in',category:'Sermaye',quantity:'1'}}));
  assert.deepEqual(replay(oldEvents),before);
});

test('physical outgoing cannot consume serialized reservations even when new stock offsets it',()=>{
  const f=fixture(),firm=company(f);
  f.write('reserved',{type:'registerItem',accountId:'yuzuk',code:'R1',weightAccount:'taki14',actualWeight:'8'});
  rejected(f,'masked',{type:'supplierPurchase',supplierId:firm.id,
    items:[{accountId:'yuzuk',quantity:'1',weightAccount:'taki14',weight:'3'}],charges:[{accountId:firm.HAS,quantity:'1'}],
    given:[{accountId:'yuzuk',quantity:'1',weightAccount:'taki14',weight:'3'}],credits:[{accountId:firm.HAS,quantity:'1'}]});
});

test('explicit native allocations consume document capacities without changing any financial balance',async()=>{
  const f=fixture(),firm=company(f);
  f.write('advance',{type:'supplierPayment',supplierId:firm.id,given:[{accountId:'nakit',quantity:'1000'}],credits:[{accountId:firm.HAS,quantity:'10'}],advanceScope:'reserved',agreementId:'A'});
  f.write('buy',{type:'supplierPurchase',supplierId:firm.id,items:[{accountId:'ceyrek',quantity:'3'}],charges:[{accountId:firm.HAS,quantity:'8'}],agreementId:'B'});
  const alloc={type:'supplierAllocation',supplierId:firm.id,allocations:[{sourceId:'advance',purchaseId:'buy',accountId:firm.HAS,quantity:'3'}]};
  rejected(f,'unconfirmed',alloc);
  rejected(f,'no-reason',{...alloc,allocations:[{...alloc.allocations[0],overrideReserved:true}]});
  const before={...f.state.balances};
  f.write('link',{...alloc,allocations:[{...alloc.allocations[0],overrideReserved:true,reason:'Firma ile mutabık farklı sipariş kullanımı'}]});
  assert.deepEqual(f.state.balances,before);assert.deepEqual(f.state.journal.at(-1).entries,[]);
  const {supplierDocuments}=await import('../supplier-ledger.mjs');
  let docs=supplierDocuments(f.state,firm.id);
  assert.equal(docs.sources[0].credits[0].remaining,7000);assert.equal(docs.sources[0].advanceScope,'reserved');
  assert.equal(docs.purchases[0].charges[0].remaining,5000);assert.equal(docs.allocations[0].quantity,3000);
  rejected(f,'double-spend',{...alloc,allocations:[{...alloc.allocations[0],quantity:'6',overrideReserved:true,reason:'Aşan tutar'}]});
  rejected(f,'repeat-rows',{...alloc,allocations:Array.from({length:2},()=>({...alloc.allocations[0],quantity:'3',overrideReserved:true,reason:'Toplam aşımı'}))});
  rejected(f,'missing-source',{...alloc,allocations:[{purchaseId:'buy',accountId:firm.HAS,quantity:'1'}]});
  assert.deepEqual(replay(f.events),f.state);
});

test('embedded purchase allocation explicitly links own simultaneous credit and rejects unmatched units',async()=>{
  const f=fixture(),firm=company(f);
  const buy={type:'supplierPurchase',supplierId:firm.id,items:[{accountId:'ceyrek',quantity:'2'}],charges:[{accountId:firm.HAS,quantity:'6'}],given:[{accountId:'nakit',quantity:'900'}],credits:[{accountId:firm.HAS,quantity:'2'}],allocations:[{accountId:firm.HAS,quantity:'2'}]};
  f.write('own',buy);
  const {supplierDocuments}=await import('../supplier-ledger.mjs');
  const docs=supplierDocuments(f.state,firm.id);
  assert.equal(docs.purchases[0].charges[0].remaining,4000);assert.equal(docs.sources[0].credits[0].remaining,0);
  assert.equal(docs.allocations[0].sourceId,'own');assert.equal(docs.allocations[0].purchaseId,'own');
  assert.equal(f.state.balances[firm.HAS],-4000);
  rejected(f,'over-own',{...buy,allocations:[{accountId:firm.HAS,quantity:'3'}]});
  rejected(f,'unit',{...buy,allocations:[{accountId:firm.USD,quantity:'1'}]});
  assert.deepEqual(replay(f.events),f.state);
});

test('manual cross-unit offset uses only explicit available native balances and no physical movements',()=>{
  const f=fixture(),firm=company(f),other=company(f,'other');
  f.write('advance',{type:'supplierPayment',supplierId:firm.id,given:[{accountId:'nakit',quantity:'1000'}],credits:[{accountId:firm.USD,quantity:'100'}]});
  f.write('buy',{type:'supplierPurchase',supplierId:firm.id,items:[{accountId:'ceyrek',quantity:'3'}],charges:[{accountId:firm.HAS,quantity:'8'}]});
  const c={type:'supplierOffset',supplierId:firm.id,fromAccountId:firm.USD,fromQuantity:'40',toAccountId:firm.HAS,toQuantity:'3',sourceUses:[{sourceId:'advance',quantity:'40'}],targetUses:[{purchaseId:'buy',quantity:'3'}],note:'Elle anlaşılmış mahsup'};
  const physical=Object.fromEntries(f.state.accounts.filter(a=>a.kind==='asset').map(a=>[a.id,f.state.balances[a.id]]));
  f.write('offset',c);
  assert.equal(f.state.balances[firm.USD],6000);assert.equal(f.state.balances[firm.HAS],-5000);
  for(const [id,value] of Object.entries(physical))assert.equal(f.state.balances[id],value);
  assert.equal(f.state.journal.at(-1).entries.length,2);
  for(const change of [{fromQuantity:'61'},{toQuantity:'6'},{toAccountId:other.HAS},{toAccountId:firm.USD},{note:''},{fromQuantity:'-1'}])rejected(f,'invalid',{...c,...change});
  assert.deepEqual(replay(f.events),f.state);
});

test('offset consumes selected credit sources and exposes only unallocated target credit',async()=>{
  const f=fixture(),firm=company(f);
  f.write('advance',{type:'supplierPayment',supplierId:firm.id,given:[{accountId:'nakit',quantity:'1000'}],credits:[{accountId:firm.USD,quantity:'100'}],advanceScope:'reserved',agreementId:'A'});
  f.write('buy',{type:'supplierPurchase',supplierId:firm.id,items:[{accountId:'ceyrek',quantity:'2'}],charges:[{accountId:firm.HAS,quantity:'8'},{accountId:firm.USD,quantity:'20'}],agreementId:'A'});
  const c={type:'supplierOffset',supplierId:firm.id,fromAccountId:firm.USD,fromQuantity:'40',toAccountId:firm.HAS,toQuantity:'3',sourceUses:[{sourceId:'advance',quantity:'40'}],targetUses:[{purchaseId:'buy',quantity:'2'}],agreementId:'A',note:'A anlaşması için manuel mahsup'};
  rejected(f,'no-uses',{...c,sourceUses:[]});
  rejected(f,'wrong-total',{...c,sourceUses:[{sourceId:'advance',quantity:'20'}]});
  rejected(f,'target-over',{...c,targetUses:[{purchaseId:'buy',quantity:'4'}]});
  rejected(f,'reservation',{...c,agreementId:'B'});
  f.write('offset',c);
  const {supplierDocuments}=await import('../supplier-ledger.mjs');
  const docs=supplierDocuments(f.state,firm.id);
  assert.equal(docs.sources.find(s=>s.id==='advance').credits[0].remaining,6000);
  const converted=docs.sources.find(s=>s.id==='offset');
  assert.equal(converted.advanceScope,'reserved');assert.equal(converted.credits[0].remaining,1000);
  assert.equal(docs.purchases[0].charges.find(r=>r.accountId===firm.HAS).remaining,6000);
  f.write('rest-link',{type:'supplierAllocation',supplierId:firm.id,allocations:[{sourceId:'offset',purchaseId:'buy',accountId:firm.HAS,quantity:'1'}]});
  rejected(f,'reuse',{type:'supplierAllocation',supplierId:firm.id,allocations:[{sourceId:'offset',purchaseId:'buy',accountId:firm.HAS,quantity:'0.001'}]});
  assert.deepEqual(replay(f.events),f.state);
});

test('legacy supplier purchases and payments permit explicit allocation but linked legacy reversal cannot bypass provenance',async()=>{
  const f=fixture();
  f.write('legacy',{type:'account',name:'Eski toptancı',partyType:'supplier',unit:'TL',opening:'0'});
  f.write('old-buy',{type:'purchase',source:'supplier',counterpartyId:'cari-legacy',items:[{accountId:'ceyrek',quantity:'2',value:'1000'}],debts:[{accountId:'cari-legacy',quantity:'1000',valueTL:'1000'}],given:[],received:[],credits:[]});
  f.write('old-pay',{type:'collection',customerAccount:'cari-legacy',target:'nakit',direction:'pay',quantity:'300'});
  f.write('link',{type:'supplierAllocation',supplierId:'cari-legacy',allocations:[{sourceId:'old-pay',purchaseId:'old-buy',accountId:'cari-legacy',quantity:'300'}]});
  const {supplierDocuments}=await import('../supplier-ledger.mjs');
  const docs=supplierDocuments(f.state,'cari-legacy');
  assert.equal(docs.purchases[0].legacy,true);assert.equal(docs.purchases[0].charges[0].remaining,70000);
  assert.equal(docs.sources[0].credits[0].remaining,0);
  for(const originalId of ['old-buy','old-pay'])rejected(f,'reverse-'+originalId,{type:'reverse',originalId,note:'Bağlı belge terslenemez'});
  assert.deepEqual(replay(f.events),f.state);
});

test('part-paid supplier return preserves paid allocation and exposes only genuine residual credit',async()=>{
  const f=fixture(),firm=company(f);
  f.write('buy',{type:'supplierPurchase',supplierId:firm.id,items:[{accountId:'yuzuk',quantity:'2',weightAccount:'taki14',weight:'8'}],charges:[{accountId:firm.HAS,quantity:'10'}],given:[{accountId:'nakit',quantity:'1000'}],credits:[{accountId:firm.HAS,quantity:'6'}],allocations:[{accountId:firm.HAS,quantity:'6'}]});
  const ret={type:'supplierReturn',supplierId:firm.id,originalId:'buy',items:[{lineIndex:0,quantity:'2',weight:'8'}],reductions:[{accountId:firm.HAS,quantity:'4'}],credits:[{accountId:firm.HAS,quantity:'5'}],note:'Anlaşılan alış iadesi'};
  rejected(f,'over-reduction',{...ret,reductions:[{accountId:firm.HAS,quantity:'5'}]});
  rejected(f,'wrong-weight',{...ret,items:[{lineIndex:0,quantity:'2',weight:'7'}]});
  f.write('return',ret);
  assert.equal(f.state.balances[firm.HAS],1000);assert.equal(f.state.balances.yuzuk,2);assert.equal(f.state.balances.taki14,10000);
  const {supplierDocuments}=await import('../supplier-ledger.mjs');
  const docs=supplierDocuments(f.state,firm.id);
  assert.equal(docs.purchases.find(d=>d.id==='buy').charges[0].remaining,0);
  assert.equal(docs.sources.find(d=>d.id==='return').credits[0].remaining,1000);
  assert.equal(docs.allocations[0].quantity,6000);
  rejected(f,'repeat',ret);
  assert.deepEqual(replay(f.events),f.state);
});

test('return agreement shortfall remains a linked obligation without extra ledger entries',async()=>{
  const f=fixture(),firm=company(f);
  f.write('buy',{type:'supplierPurchase',supplierId:firm.id,items:[{accountId:'ceyrek',quantity:'2'}],charges:[{accountId:firm.HAS,quantity:'10'}]});
  f.write('return',{type:'supplierReturn',supplierId:firm.id,originalId:'buy',items:[{lineIndex:0,quantity:'2'}],reductions:[{accountId:firm.HAS,quantity:'10'}],credits:[{accountId:firm.HAS,quantity:'9'}],note:'İade anlaşma farkı'});
  assert.equal(f.state.balances[firm.HAS],-1000);
  assert.deepEqual(f.state.journal.at(-1).entries,[{accountId:'ceyrek',delta:-2},{accountId:firm.HAS,delta:9000}]);
  const {supplierDocuments}=await import('../supplier-ledger.mjs');
  let docs=supplierDocuments(f.state,firm.id);
  assert.equal(docs.purchases.find(d=>d.id==='buy').charges[0].remaining,0);
  assert.equal(docs.purchases.find(d=>d.id==='return').charges[0].remaining,1000);
  assert.equal(docs.sources.some(d=>d.id==='return'),false);
  f.write('pay-difference',{type:'supplierPayment',supplierId:firm.id,given:[{accountId:'nakit',quantity:'100'}],credits:[{accountId:firm.HAS,quantity:'1'}]});
  f.write('link-difference',{type:'supplierAllocation',supplierId:firm.id,allocations:[{sourceId:'pay-difference',purchaseId:'return',accountId:firm.HAS,quantity:'1'}]});
  docs=supplierDocuments(f.state,firm.id);
  assert.equal(docs.purchases.find(d=>d.id==='return').charges[0].remaining,0);assert.equal(f.state.balances[firm.HAS],0);
  assert.deepEqual(replay(f.events),f.state);
});

test('fully paid purchase refund preserves its paid history and makes no artificial native source',async()=>{
  const f=fixture(),firm=company(f);
  f.write('buy',{type:'supplierPurchase',supplierId:firm.id,items:[{accountId:'ceyrek',quantity:'2'}],charges:[{accountId:firm.TL,quantity:'1000'}],given:[{accountId:'nakit',quantity:'1000'}],credits:[{accountId:firm.TL,quantity:'1000'}],allocations:[{accountId:firm.TL,quantity:'1000'}]});
  f.write('return',{type:'supplierReturn',supplierId:firm.id,originalId:'buy',items:[{lineIndex:0,quantity:'1'}],reductions:[],received:[{accountId:'nakit',quantity:'450'}],note:'Kısmi fiziksel para iadesi'});
  const {supplierDocuments}=await import('../supplier-ledger.mjs'),docs=supplierDocuments(f.state,firm.id);
  assert.equal(f.state.balances[firm.TL],0);assert.equal(f.state.balances.nakit,99945000);
  assert.equal(docs.sources.some(d=>d.id==='return'),false);assert.equal(docs.purchases[0].charges[0].allocated,100000);
  assert.deepEqual(replay(f.events),f.state);
});

test('return keeps different-unit agreement differences separate and rejects forged or reserved stock returns',async()=>{
  const f=fixture(),firm=company(f),other=company(f,'other');
  f.write('buy',{type:'supplierPurchase',supplierId:firm.id,items:[{accountId:'yuzuk',quantity:'1',weightAccount:'taki14',weight:'3'}],charges:[{accountId:firm.HAS,quantity:'2'}]});
  const ret={type:'supplierReturn',supplierId:firm.id,originalId:'buy',items:[{lineIndex:0,quantity:'1',weight:'3'}],reductions:[{accountId:firm.HAS,quantity:'2'}],credits:[{accountId:firm.USD,quantity:'40'}],note:'Birimler birbirine çevrilmez'};
  for(const change of [{supplierId:other.id},{items:[]},{items:[{lineIndex:1,quantity:'1'}]},{items:[ret.items[0],ret.items[0]]},{credits:[{accountId:other.USD,quantity:'1'}]},{credits:[],received:[]},{reductions:[{accountId:firm.HAS,quantity:'3'}]},{originalId:'missing'},{items:[{...ret.items[0],inventoryCode:'ignored'}]}])rejected(f,'bad-return',{...ret,...change});
  f.write('return',ret);
  const {supplierDocuments}=await import('../supplier-ledger.mjs'),docs=supplierDocuments(f.state,firm.id);
  assert.equal(docs.purchases.find(d=>d.id==='return').charges[0].quantity,2000);
  assert.equal(docs.sources.find(d=>d.id==='return').credits[0].quantity,4000);
  assert.equal(f.state.balances[firm.HAS],-2000);assert.equal(f.state.balances[firm.USD],4000);
  const g=fixture(),gf=company(g);
  g.write('buy',{type:'supplierPurchase',supplierId:gf.id,items:[{accountId:'yuzuk',quantity:'1',weightAccount:'taki14',weight:'3'}],charges:[{accountId:gf.HAS,quantity:'2'}]});
  g.write('reserved',{type:'registerItem',accountId:'yuzuk',code:'R1',weightAccount:'taki14',actualWeight:'11'});
  rejected(g,'reserved-return',{...ret,supplierId:gf.id});
  assert.deepEqual(replay(f.events),f.state);
});

test('supplier reversal preserves history and enforces allocations, returns and offset source dependencies',()=>{
  const f=fixture(),firm=company(f);
  f.write('buy',{type:'supplierPurchase',supplierId:firm.id,items:[{accountId:'ceyrek',quantity:'2'}],charges:[{accountId:firm.HAS,quantity:'10'}]});
  f.write('pay',{type:'supplierPayment',supplierId:firm.id,given:[{accountId:'nakit',quantity:'100'}],credits:[{accountId:firm.HAS,quantity:'6'}]});
  f.write('link',{type:'supplierAllocation',supplierId:firm.id,allocations:[{sourceId:'pay',purchaseId:'buy',accountId:firm.HAS,quantity:'6'}]});
  for(const originalId of ['buy','pay'])rejected(f,'blocked',{type:'supplierReverse',originalId,note:'Bağımlı kayıt'});
  f.write('return',{type:'supplierReturn',supplierId:firm.id,originalId:'buy',items:[{lineIndex:0,quantity:'1'}],reductions:[{accountId:firm.HAS,quantity:'4'}],credits:[{accountId:firm.HAS,quantity:'4'}],note:'Kısmi iade'});
  rejected(f,'unlink-too-early',{type:'supplierReverse',originalId:'link',note:'Önce iade'});
  for(const originalId of ['return','link','pay','buy'])f.write('undo-'+originalId,{type:'supplierReverse',originalId,note:'Kontrollü ters kayıt'});
  assert.equal(f.state.balances[firm.HAS],0);assert.equal(f.state.balances.ceyrek,20);assert.equal(f.state.balances.nakit,100000000);
  assert.equal(f.state.journal.filter(e=>e.id==='buy').length,1);
  rejected(f,'twice',{type:'supplierReverse',originalId:'buy',note:'Tekrar'});
  rejected(f,'identity',{type:'supplierReverse',originalId:'firm',note:'Kimlik terslenmez'});
  assert.deepEqual(replay(f.events),f.state);
});

test('supplier amendment atomically replaces the same operation and rolls back invalid replacement',()=>{
  const f=fixture(),firm=company(f);
  const purchase={type:'supplierPurchase',supplierId:firm.id,items:[{accountId:'ceyrek',quantity:'3'}],charges:[{accountId:firm.HAS,quantity:'10'}],given:[{accountId:'nakit',quantity:'100'}],credits:[{accountId:firm.HAS,quantity:'2'}],allocations:[{accountId:firm.HAS,quantity:'2'}]};
  f.write('buy',purchase);
  const amendment={type:'supplierAmend',originalId:'buy',replacement:{...purchase,items:[{accountId:'ceyrek',quantity:'2'}],charges:[{accountId:firm.HAS,quantity:'7'}]},note:'Yanlış miktar düzeltildi'};
  rejected(f,'invalid',{...amendment,replacement:{...amendment.replacement,given:[{accountId:'nakit',quantity:'1000001'}]}});
  rejected(f,'wrong-type',{...amendment,replacement:{type:'supplierPayment',supplierId:firm.id}});
  f.write('edit',amendment);
  assert.equal(f.state.balances.ceyrek,22);assert.equal(f.state.balances[firm.HAS],-5000);assert.equal(f.state.balances.nakit,99990000);
  assert.equal(f.state.journal.at(-2).type,'supplierReverse');assert.equal(f.state.journal.at(-1).meta.amendsOriginalId,'buy');
  assert.equal(f.state.journal.at(-1).id,'edit');
  assert.deepEqual(replay(f.events),f.state);
});

test('receipt consumes explicit credit lots even when net cari is negative and records excess debt separately',async()=>{
  const f=fixture(),firm=company(f);
  f.write('advance',{type:'supplierPayment',supplierId:firm.id,given:[{accountId:'nakit',quantity:'1000'}],credits:[{accountId:firm.HAS,quantity:'10'}]});
  f.write('buy',{type:'supplierPurchase',supplierId:firm.id,items:[{accountId:'ceyrek',quantity:'2'}],charges:[{accountId:firm.HAS,quantity:'8'}]});
  const receipt={type:'supplierPayment',supplierId:firm.id,received:[{accountId:'nakit',quantity:'500'}],debts:[{accountId:firm.HAS,quantity:'5'}]};
  rejected(f,'missing-use',receipt);
  rejected(f,'net-only',{...receipt,debtUses:[{sourceId:'advance',accountId:firm.HAS,quantity:'2'}]});
  f.write('receipt',{...receipt,debtUses:[{sourceId:'advance',accountId:firm.HAS,quantity:'5'}]});
  const {supplierDocuments}=await import('../supplier-ledger.mjs');
  let docs=supplierDocuments(f.state,firm.id);
  assert.equal(f.state.balances[firm.HAS],-3000);assert.equal(docs.sources.find(d=>d.id==='advance').credits[0].remaining,5000);
  f.write('receipt2',{...receipt,debts:[{accountId:firm.HAS,quantity:'7'}],debtUses:[{sourceId:'advance',accountId:firm.HAS,quantity:'5'}]});
  docs=supplierDocuments(f.state,firm.id);
  assert.equal(docs.sources.find(d=>d.id==='advance').credits[0].remaining,0);
  assert.equal(docs.purchases.find(d=>d.id==='receipt2').charges[0].remaining,2000);
  assert.equal(f.state.balances[firm.HAS],-10000);
  rejected(f,'reverse-consumed',{type:'supplierReverse',originalId:'advance',note:'Tahsilatta kullanıldı'});
  rejected(f,'reuse',{type:'supplierAllocation',supplierId:firm.id,allocations:[{sourceId:'advance',purchaseId:'buy',accountId:firm.HAS,quantity:'1'}]});
  assert.deepEqual(replay(f.events),f.state);
});

test('legacy firm identity edits preserve root IDs, balances and historical journal contacts',async()=>{
  const f=fixture();
  f.write('legacy',{type:'account',name:'Eski firma',partyType:'supplier',unit:'TL',opening:'-12',phone:'555 111'});
  f.write('legacy-usd',{type:'account',parentAccountId:'cari-legacy',unit:'USD',opening:'3'});
  const previous=structuredClone(f.state.journal),balances={...f.state.balances};
  f.write('edit',{type:'supplierFirmUpdate',supplierId:'cari-legacy',name:'Yeni unvan',phone:'555 222'});
  const {supplierFirms,supplierAccountIds}=await import('../supplier-ledger.mjs');
  assert.equal(supplierFirms(f.state).filter(f=>f.id==='cari-legacy').length,1);
  assert.equal(supplierFirms(f.state)[0].name,'Yeni unvan');
  assert.deepEqual(supplierAccountIds(f.state,'cari-legacy'),['cari-legacy','cari-legacy-usd']);
  assert.equal(f.state.accounts.find(a=>a.id==='cari-legacy-usd').phone,'555 222');
  assert.deepEqual(f.state.balances,balances);assert.deepEqual(f.state.journal.slice(0,-1),previous);
  assert.deepEqual(replay(f.events),f.state);
});

test('unresolved historical receipt blocks old credit reuse until explicit metadata-only source matching',async()=>{
  const f=fixture();
  f.write('legacy',{type:'account',name:'Eski firma',partyType:'supplier',unit:'TL',opening:'100'});
  f.write('refund',{type:'collection',customerAccount:'cari-legacy',target:'nakit',direction:'collect',quantity:'30'});
  f.write('buy',{type:'supplierPurchase',supplierId:'cari-legacy',items:[{accountId:'ceyrek',quantity:'1'}],charges:[{accountId:'cari-legacy',quantity:'70'}]});
  const allocate={type:'supplierAllocation',supplierId:'cari-legacy',allocations:[{sourceId:'legacy',purchaseId:'buy',accountId:'cari-legacy',quantity:'70'}]};
  rejected(f,'unresolved',allocate);
  const {supplierDocuments}=await import('../supplier-ledger.mjs');
  let docs=supplierDocuments(f.state,'cari-legacy');
  assert.equal(docs.unresolvedReceipts[0].id,'refund');assert.equal(docs.unresolvedReceipts[0].debts[0].quantity,3000);
  assert.deepEqual(docs.sources.find(s=>s.id==='legacy').blockedAccounts,['cari-legacy']);
  const link={type:'supplierLegacyReceiptLink',supplierId:'cari-legacy',originalId:'refund',uses:[{sourceId:'legacy',accountId:'cari-legacy',quantity:'30'}]};
  for(const quantity of ['20','31'])rejected(f,'wrong-sum',{...link,uses:[{...link.uses[0],quantity}]});
  const balances={...f.state.balances};f.write('match',link);
  assert.deepEqual(f.state.balances,balances);assert.deepEqual(f.state.journal.at(-1).entries,[]);
  docs=supplierDocuments(f.state,'cari-legacy');
  assert.equal(docs.unresolvedReceipts.length,0);assert.equal(docs.sources.find(s=>s.id==='legacy').credits[0].remaining,7000);
  rejected(f,'duplicate-match',link);
  rejected(f,'undo-refund',{type:'reverse',originalId:'refund',note:'Eşleşmiş tahsilat'});
  f.write('allocate',allocate);
  rejected(f,'undo-match',{type:'supplierReverse',originalId:'match',note:'Önce bağlı kullanımı geri al'});
  f.write('undo-allocate',{type:'supplierReverse',originalId:'allocate',note:'Tahsis kaldırıldı'});
  f.write('undo-match',{type:'supplierReverse',originalId:'match',note:'Eşleme kaldırıldı'});
  assert.equal(supplierDocuments(f.state,'cari-legacy').unresolvedReceipts.length,1);
  rejected(f,'still-blocked',allocate);
  assert.deepEqual(replay(f.events),f.state);
});

test('legacy receipt resolution requires earlier genuine same-account sources and leaves new sources usable',async()=>{
  const f=fixture();
  f.write('legacy',{type:'account',name:'Eski firma',partyType:'supplier',unit:'TL',opening:'100'});
  f.write('negative-opening',{type:'account',parentAccountId:'cari-legacy',unit:'USD',opening:'-10'});
  f.write('refund',{type:'collection',customerAccount:'cari-legacy',target:'nakit',direction:'collect',quantity:'30'});
  f.write('later-sale',{type:'sale',counterpartyType:'supplier',counterpartyId:'cari-legacy',items:[{accountId:'ceyrek',quantity:'1',value:'20'}],credits:[{accountId:'cari-legacy',quantity:'20',valueTL:'20'}],debts:[],given:[],received:[]});
  f.write('new-source',{type:'supplierPayment',supplierId:'cari-legacy',given:[{accountId:'nakit',quantity:'20'}],credits:[{accountId:'cari-legacy',quantity:'20'}]});
  f.write('buy',{type:'supplierPurchase',supplierId:'cari-legacy',items:[{accountId:'ceyrek',quantity:'1'}],charges:[{accountId:'cari-legacy',quantity:'20'}]});
  f.write('new-allocate',{type:'supplierAllocation',supplierId:'cari-legacy',allocations:[{sourceId:'new-source',purchaseId:'buy',accountId:'cari-legacy',quantity:'20'}]});
  for(const sourceId of ['later-sale','new-source','negative-opening','refund'])rejected(f,'bad-source',{type:'supplierLegacyReceiptLink',supplierId:'cari-legacy',originalId:'refund',uses:[{sourceId,accountId:'cari-legacy',quantity:'30'}]});
  rejected(f,'not-receipt',{type:'supplierLegacyReceiptLink',supplierId:'cari-legacy',originalId:'negative-opening',uses:[{sourceId:'legacy',accountId:'cari-legacy',quantity:'10'}]});
  const {supplierDocuments}=await import('../supplier-ledger.mjs'),docs=supplierDocuments(f.state,'cari-legacy');
  assert.equal(docs.unresolvedReceipts.length,1);assert.equal(docs.unresolvedReceipts[0].sources.length,1);
  assert.equal(docs.unresolvedReceipts[0].sources[0].id,'legacy');
  assert.deepEqual(docs.sources.find(s=>s.id==='new-source').blockedAccounts,[]);
  assert.deepEqual(replay(f.events),f.state);
});

test('unresolved legacy receipts cannot be bypassed through offsets or receipt debt uses; mixed receipts use native net',async()=>{
  const f=fixture();
  f.write('legacy',{type:'account',name:'Eski firma',partyType:'supplier',unit:'TL',opening:'100'});
  f.write('usd-debt',{type:'account',parentAccountId:'cari-legacy',unit:'USD',opening:'-10'});
  f.write('refund',{type:'collection',counterpartyId:'cari-legacy',counterpartyType:'supplier',received:[{accountId:'nakit',quantity:'10',valueTL:'10'}],given:[{accountId:'nakit',quantity:'5',valueTL:'5'}],credits:[{accountId:'cari-legacy',quantity:'5',valueTL:'5'}],debts:[{accountId:'cari-legacy',quantity:'10',valueTL:'10'}]});
  const {supplierDocuments}=await import('../supplier-ledger.mjs');
  let docs=supplierDocuments(f.state,'cari-legacy');
  assert.equal(docs.unresolvedReceipts[0].debts[0].quantity,500);assert.equal(docs.sources.some(s=>s.id==='refund'),false);
  rejected(f,'offset',{type:'supplierOffset',supplierId:'cari-legacy',fromAccountId:'cari-legacy',fromQuantity:'10',toAccountId:'cari-usd-debt',toQuantity:'2',sourceUses:[{sourceId:'legacy',quantity:'10'}],note:'Eski kaynak çözülmedi'});
  rejected(f,'receipt',{type:'supplierPayment',supplierId:'cari-legacy',received:[{accountId:'nakit',quantity:'10'}],debts:[{accountId:'cari-legacy',quantity:'10'}],debtUses:[{sourceId:'legacy',accountId:'cari-legacy',quantity:'10'}]});
  f.write('link',{type:'supplierLegacyReceiptLink',supplierId:'cari-legacy',originalId:'refund',uses:[{sourceId:'legacy',accountId:'cari-legacy',quantity:'5'}]});
  docs=supplierDocuments(f.state,'cari-legacy');
  assert.equal(docs.sources.find(s=>s.id==='legacy').credits[0].remaining,9500);assert.equal(f.state.balances['cari-legacy'],9500);
  assert.deepEqual(replay(f.events),f.state);
});
