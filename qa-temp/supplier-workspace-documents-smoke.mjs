import test from 'node:test';
import assert from 'node:assert/strict';
import {loadJSDOM} from '../test-support/jsdom.mjs';
import {renderSupplierWorkspace} from '../public/suppliers.js';
const JSDOM=await loadJSDOM(),tick=()=>new Promise(r=>setTimeout(r,0));
function fixture(t, mutate=()=>{}){
 const dom=new JSDOM('<main></main>',{url:'http://127.0.0.1/'}),root=dom.window.document.querySelector('main'),sent=[];
 const accounts=[{id:'has',unit:'HAS',balance:10000},{id:'usd',unit:'USD',balance:-20000}],supplier={id:'firm',name:'Firma',accounts};
 const documents={sources:[{id:'source',kind:'supplierPayment',date:'2026-11-01',advanceScope:'general',credits:[{accountId:'has',unit:'HAS',remaining:5000}]}],purchases:[{id:'purchase',kind:'supplierPurchase',date:'2026-11-02',lines:[{lineIndex:1,accountId:'coin',quantity:5,remainingQuantity:4}],charges:[{accountId:'has',unit:'HAS',remaining:5000}]},{id:'usd-buy',kind:'supplierPurchase',date:'2026-11-03',lines:[],charges:[{accountId:'usd',unit:'USD',remaining:20000}]}]};
 mutate(documents,accounts);
 const state={revision:9,date:'2026-11-10',supplierParties:[supplier],accounts:[{id:'coin',name:'Çeyrek',unit:'ADET',kind:'asset',physical:true},{id:'cash',name:'Nakit',unit:'TL',kind:'asset',physical:true}]};
 const api=renderSupplierWorkspace(root,{state,memory:new Map(),workspace:'demo',escape:v=>String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'),format:(n,u)=>n+' '+u,day:x=>x,refresh(){},parseAmount:(input,u)=>input.value.trim()?Number(input.value)*(u==='HAS'||u==='GRAM'?1000:u==='ADET'?1:100):null,
 request:async()=>({revision:9,supplier,accounts,documents}),submit:async c=>{sent.push(c);return false;}});
 t.after(()=>{api.destroy();dom.window.close();});root.querySelector('[data-open-firm="firm"]').click();
 const fill=(selector,value)=>{const input=root.querySelector(selector);assert.ok(input,selector);input.value=value;input.dispatchEvent(new dom.window.Event(input.tagName==='SELECT'?'change':'input',{bubbles:true}));};
 return {root,sent,fill,dom};
}
test('explicit same-unit allocation sends only source and purchase identity, no financial legs',async t=>{
 const f=fixture(t);f.root.querySelector('[data-supplier-documents]').click();await tick();await tick();
 const section=f.root.querySelector('[data-supplier-sources]'),save=f.root.querySelector('[data-supplier-document-form] > button:last-of-type');assert.equal(section.open,true,'required selection must start expanded');assert.ok(section.compareDocumentPosition(save)&f.dom.window.Node.DOCUMENT_POSITION_FOLLOWING,'save follows required source controls');
 f.root.querySelector('[data-add-source]').click();f.fill('[data-source-field="choice"]',JSON.stringify(['source','has']));f.fill('[data-source-field="purchase"]',JSON.stringify(['purchase','has']));f.fill('[data-source-field="quantity"]','2');
 f.root.querySelector('form').requestSubmit();await tick();
 assert.deepEqual(f.sent[0].allocations,[{sourceId:'source',purchaseId:'purchase',accountId:'has',quantity:'2'}]);assert.equal(f.sent[0].type,'supplierAllocation');assert.equal('given' in f.sent[0],false);
});
test('offset keeps independently agreed native quantities and explicit source use',async t=>{
 const f=fixture(t);f.root.querySelector('[data-supplier-task="offset"]').click();await tick();await tick();
 f.fill('[name="fromAccountId"]','has');f.fill('[name="fromQuantity"]','2');f.fill('[name="toAccountId"]','usd');f.fill('[name="toQuantity"]','50');f.fill('[name="note"]','Açık anlaşma');
 f.root.querySelector('[data-add-source]').click();f.fill('[data-source-field="choice"]',JSON.stringify(['source','has']));f.fill('[data-source-field="quantity"]','2');
 f.root.querySelector('form').requestSubmit();await tick();assert.equal(f.sent[0].fromQuantity,'2');assert.equal(f.sent[0].toQuantity,'50');assert.deepEqual(f.sent[0].sourceUses,[{sourceId:'source',quantity:'2'}]);assert.equal('given' in f.sent[0],false);
});
test('return uses authoritative original line index and keeps document reduction distinct from native credit',async t=>{
 const f=fixture(t);f.root.querySelector('[data-supplier-task="return"]').click();await tick();await tick();
 f.fill('[name="originalId"]','purchase');f.fill('[name="returnQty-1"]','1');f.fill('[name="reduction-has"]','2');
 f.root.querySelector('[data-document-group="credits"] [data-add-document-line]').click();f.fill('[data-document-group="credits"] [data-field="accountId"]','has');f.fill('[data-document-group="credits"] [data-field="quantity"]','1.5');f.fill('[name="note"]','Kısmi ürün iadesi');
 f.root.querySelector('form').requestSubmit();await tick();assert.equal(f.sent[0].type,'supplierReturn');assert.deepEqual(f.sent[0].items,[{lineIndex:1,quantity:'1'}]);assert.deepEqual(f.sent[0].reductions,[{accountId:'has',quantity:'2'}]);assert.deepEqual(f.sent[0].credits,[{accountId:'has',quantity:'1.5'}]);
});


test('legacy receipt requires complete explicit account matching without any balance legs',async t=>{
 const f=fixture(t,d=>{d.unresolvedReceipts=[{id:'receipt',date:'2026-11-03',debts:[{accountId:'has',unit:'HAS',quantity:2000}],sources:[d.sources[0]]}];});
 f.root.querySelector('[data-supplier-documents]').click();await tick();await tick();f.root.querySelector('[data-supplier-legacy]').click();await tick();
 f.fill('[name="originalId"]','receipt');f.root.querySelector('[data-add-legacy-source]').click();f.fill('[data-legacy-rows] select',JSON.stringify(['source','has']));f.fill('[data-legacy-rows] input','1');
 f.root.querySelector('form').requestSubmit();await tick();assert.equal(f.sent.length,0,'partial attribution must not submit');
 f.fill('[data-legacy-rows] input','2');f.root.querySelector('form').requestSubmit();await tick();assert.deepEqual(f.sent[0],{type:'supplierLegacyReceiptLink',date:'2026-11-10',supplierId:'firm',originalId:'receipt',uses:[{sourceId:'source',accountId:'has',quantity:'2'}]});
});

test('firm profile updates stable identity without creating any unit',async t=>{
 const f=fixture(t);f.root.querySelector('[data-edit-supplier]').click();assert.equal(f.root.querySelector('[name="name"]').value,'Firma');f.fill('[name="name"]','Yeni Firma');f.fill('[name="phone"]','555');f.root.querySelector('form').requestSubmit();await tick();assert.deepEqual(f.sent[0],{type:'supplierFirmUpdate',date:'2026-11-10',supplierId:'firm',name:'Yeni Firma',phone:'555',taxId:'',address:''});
});

test('return rejects quantity exceeding authoritative remaining and accepts correction',async t=>{
 const f=fixture(t);f.root.querySelector('[data-supplier-task="return"]').click();await tick();f.fill('[name="originalId"]','purchase');f.fill('[name="returnQty-1"]','5');f.fill('[name="note"]','İade');f.root.querySelector('[data-document-group="credits"] [data-add-document-line]').click();f.fill('[data-document-group="credits"] select','has');f.fill('[data-document-group="credits"] input','1');f.root.querySelector('form').requestSubmit();await tick();assert.equal(f.sent.length,0);f.fill('[name="returnQty-1"]','4');f.root.querySelector('form').requestSubmit();await tick();assert.equal(f.sent.length,1);
});

test('offset rejects unmatched source total before sending and accepts exact correction',async t=>{
 const f=fixture(t);f.root.querySelector('[data-supplier-task="offset"]').click();await tick();await tick();for(const[k,v]of Object.entries({fromAccountId:'has',fromQuantity:'3',toAccountId:'usd',toQuantity:'50',note:'Mahsup'}))f.fill('[name="'+k+'"]',v);f.root.querySelector('[data-add-source]').click();f.fill('[data-source-field="choice"]',JSON.stringify(['source','has']));f.fill('[data-source-field="quantity"]','2');f.root.querySelector('form').requestSubmit();await tick();assert.equal(f.sent.length,0);f.fill('[name="fromQuantity"]','2');f.root.querySelector('form').requestSubmit();await tick();assert.equal(f.sent.length,1);
});

test('allocation duplicate source rows cannot exceed shared capacity',async t=>{
 const f=fixture(t);f.root.querySelector('[data-supplier-documents]').click();await tick();await tick();for(let i=0;i<2;i++){f.root.querySelector('[data-add-source]').click();const row=f.root.querySelectorAll('[data-source-rows] > div')[i];const select=row.querySelector('[data-source-field="choice"]');select.value=JSON.stringify(['source','has']);select.dispatchEvent(new f.dom.window.Event('change',{bubbles:true}));row.querySelector('[data-source-field="purchase"]').value=JSON.stringify(['purchase','has']);row.querySelector('[data-source-field="quantity"]').value='3';}f.root.querySelector('form').requestSubmit();await tick();assert.equal(f.sent.length,0);assert.match(f.root.textContent,/Toplam kullanım/);
});
test('return rejects malformed native agreement before sending',async t=>{
 const f=fixture(t);f.root.querySelector('[data-supplier-task="return"]').click();await tick();f.fill('[name="originalId"]','purchase');f.fill('[name="returnQty-1"]','1');f.fill('[name="note"]','İade');f.root.querySelector('[data-document-group="credits"] [data-add-document-line]').click();f.fill('[data-document-group="credits"] select','has');f.fill('[data-document-group="credits"] input','abc');f.root.querySelector('form').requestSubmit();await tick();assert.equal(f.sent.length,0);f.fill('[data-document-group="credits"] input','1');f.root.querySelector('form').requestSubmit();await tick();assert.equal(f.sent.length,1);
});

test('return preview separates physical flows, native credit and document residual without treating blanks as zero',async t=>{
 const f=fixture(t);f.root.querySelector('[data-supplier-task="return"]').click();await tick();f.fill('[name="originalId"]','purchase');f.fill('[name="returnQty-1"]','1');
 let preview=f.root.querySelector('[data-return-preview]');assert.ok(preview);assert.match(preview.textContent,/Belgeden düşüm girilmedi/);assert.doesNotMatch(preview.textContent,/Sonra:/);
 f.fill('[name="reduction-has"]','2');f.root.querySelector('[data-document-group="credits"] [data-add-document-line]').click();f.fill('[data-document-group="credits"] select','has');f.fill('[data-document-group="credits"] input','1.5');
 f.root.querySelector('[data-document-group="received"] [data-add-document-line]').click();f.fill('[data-document-group="received"] select','cash');f.fill('[data-document-group="received"] input','10');
 assert.match(preview.textContent,/Firmaya çıkan.*Çeyrek.*1 ADET/);assert.match(preview.textContent,/Firmadan giren.*Nakit.*1000 TL/);assert.match(preview.textContent,/Önce: Alacağımız 10000 HAS.*Sonra: Alacağımız 11500 HAS/);assert.match(preview.textContent,/Belgeden düşüm: 2000 HAS.*Cari alacak: 1500 HAS.*İade sonrası kalan borç: 500 HAS/);
 f.fill('[data-document-group="credits"] input','abc');assert.match(preview.textContent,/Eksik veya geçersiz/);assert.doesNotMatch(preview.textContent,/Sonra:|İade sonrası kalan borç: 500/);
 f.fill('[data-document-group="credits"] input','0');assert.match(preview.textContent,/Eksik veya geçersiz/);
 f.fill('[data-document-group="credits"] input','1.5');f.fill('[name="reduction-has"]','');assert.match(preview.textContent,/Belgeden düşüm girilmedi/);assert.match(preview.textContent,/Kullanılabilir iade alacağı: 1500 HAS/);
});
test('offset required sources are open before save while optional target disclosure stays closed',async t=>{
 const f=fixture(t);f.root.querySelector('[data-supplier-task="offset"]').click();await tick();await tick();const sources=f.root.querySelector('[data-supplier-sources]'),save=f.root.querySelector('[data-supplier-document-form] > button:last-of-type');assert.equal(sources.open,true);assert.ok(sources.compareDocumentPosition(save)&f.dom.window.Node.DOCUMENT_POSITION_FOLLOWING);assert.equal(f.root.querySelector('[data-offset-targets]').closest('details').open,false);
});

test('paired return preview rejects mismatched final or exhausted partial weight',async t=>{
 const f=fixture(t,d=>{Object.assign(d.purchases[0].lines[0],{weightAccount:'scale',remainingWeight:5000});});f.root.querySelector('[data-supplier-task="return"]').click();await tick();f.fill('[name="originalId"]','purchase');f.fill('[name="returnQty-1"]','4');f.fill('[name="returnWeight-1"]','4');const preview=f.root.querySelector('[data-return-preview]');assert.match(preview.textContent,/Eksik veya geçersiz/);f.fill('[name="returnQty-1"]','3');f.fill('[name="returnWeight-1"]','5');assert.match(preview.textContent,/Eksik veya geçersiz/);f.fill('[name="returnQty-1"]','4');assert.doesNotMatch(preview.textContent,/Eksik veya geçersiz/);assert.match(preview.textContent,/4 ADET.*5000 GRAM/);
});
test('return preview suppresses native balance exceeding domain bound',async t=>{
 const f=fixture(t,(d,a)=>{a[0].balance=999999999999;});f.root.querySelector('[data-supplier-task="return"]').click();await tick();f.fill('[name="originalId"]','purchase');f.fill('[name="returnQty-1"]','1');f.root.querySelector('[data-document-group="credits"] [data-add-document-line]').click();f.fill('[data-document-group="credits"] select','has');f.fill('[data-document-group="credits"] input','0.002');const preview=f.root.querySelector('[data-return-preview]');assert.match(preview.textContent,/Bakiye ve fark hesaplanmadı/);assert.doesNotMatch(preview.textContent,/Sonra:/);
});

test('equal-date equal-amount sources have distinct readable notes and stable receipt labels',async t=>{
 const f=fixture(t,d=>{d.sources[0].note='Birinci sipariş <img>';d.sources.push({...d.sources[0],id:'other-source',note:'İkinci sipariş'});});f.root.querySelector('[data-supplier-documents]').click();await tick();await tick();f.root.querySelector('[data-add-source]').click();const options=[...f.root.querySelector('[data-source-field="choice"]').options].slice(1);assert.equal(options.length,2);assert.notEqual(options[0].textContent,options[1].textContent);assert.match(options[0].textContent,/Birinci sipariş <img>.*Fiş/);assert.match(options[1].textContent,/İkinci sipariş.*Fiş/);assert.equal(f.root.querySelector('img'),null);assert.deepEqual(options.map(o=>JSON.parse(o.value)[0]),['source','other-source']);
});

test('selected source and target descriptions remain visible outside native select and update or clear',async t=>{
 const f=fixture(t,d=>{d.sources[0].note='İlk ödeme açıklaması';d.sources.push({...d.sources[0],id:'second-source',note:'İkinci ödeme açıklaması'});d.purchases[0].note='Alış açıklaması';});f.root.querySelector('[data-supplier-documents]').click();await tick();await tick();f.root.querySelector('[data-add-source]').click();const source=f.root.querySelector('[data-source-field="choice"]'),target=f.root.querySelector('[data-source-field="purchase"]');f.fill('[data-source-field="choice"]',JSON.stringify(['source','has']));f.fill('[data-source-field="purchase"]',JSON.stringify(['purchase','has']));const summary=source.closest('label').querySelector('.supplier-selection-summary');assert.ok(summary);assert.equal(summary.textContent,source.selectedOptions[0].textContent);assert.equal(summary.hidden,false);assert.match(target.closest('label').querySelector('.supplier-selection-summary').textContent,/Alış açıklaması/);f.fill('[data-source-field="choice"]',JSON.stringify(['second-source','has']));assert.match(summary.textContent,/İkinci ödeme açıklaması/);f.fill('[data-source-field="choice"]','');assert.equal(summary.hidden,true);assert.equal(summary.textContent,'');assert.equal(target.closest('label').querySelector('.supplier-selection-summary').textContent,'');
});

for(const kind of ['return','offset','legacyLink'])test(kind+' restored selected receipt summary is visible without changing selection',async t=>{
 const f=fixture(t,d=>{d.unresolvedReceipts=[{id:'receipt',date:'2026-11-03',debts:[{accountId:'has',unit:'HAS',quantity:2000}],sources:[d.sources[0]]}];});
 async function open(){if(kind==='legacyLink'){f.root.querySelector('[data-supplier-task="payment"]').click();await tick();await tick();f.root.querySelector('[data-supplier-legacy]').click();}else f.root.querySelector('[data-supplier-task="'+kind+'"]').click();await tick();await tick();}
 await open();let selector;
 if(kind==='return'){selector='[name="originalId"]';f.fill(selector,'purchase');f.fill('[name="returnQty-1"]','1');}
 if(kind==='offset'){f.fill('[name="toAccountId"]','usd');f.root.querySelector('[data-add-offset-target]').click();selector='[data-target-field="purchaseId"]';f.fill(selector,'usd-buy');f.fill('[data-target-field="quantity"]','1');}
 if(kind==='legacyLink'){f.fill('[name="originalId"]','receipt');f.root.querySelector('[data-add-legacy-source]').click();selector='[data-field="source"]';f.fill(selector,JSON.stringify(['source','has']));f.fill('[data-legacy-rows] input','1');}
 const expected=f.root.querySelector(selector).value;f.root.querySelector('[data-supplier-task="payment"]').click();await tick();await open();const select=f.root.querySelector(selector),summary=select.closest('label').querySelector('.supplier-selection-summary');assert.equal(select.value,expected);assert.ok(summary,'initial summary exists after restoring draft');assert.equal(summary.hidden,false);assert.equal(summary.textContent,select.selectedOptions[0].textContent);
});

test('return receipt summary lists repeated products once while preserving individual return lines',async t=>{
 const f=fixture(t,d=>{d.purchases[0].lines=Array.from({length:30},(_,lineIndex)=>({lineIndex,accountId:'coin',quantity:1,remainingQuantity:1}));});f.root.querySelector('[data-supplier-task="return"]').click();await tick();await tick();f.fill('[name="originalId"]','purchase');const select=f.root.querySelector('[name="originalId"]'),name=f.root.querySelector('[data-return-line] legend').textContent.split(' · ')[0];assert.equal(select.selectedOptions[0].textContent.split(name).length-1,1);assert.equal(select.value,'purchase');assert.equal(f.root.querySelectorAll('[data-return-line]').length,30);
});
