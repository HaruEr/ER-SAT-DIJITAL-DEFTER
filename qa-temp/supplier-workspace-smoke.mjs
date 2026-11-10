import test from 'node:test';
import assert from 'node:assert/strict';
import {loadJSDOM} from '../test-support/jsdom.mjs';
import {renderSupplierWorkspace} from '../public/suppliers.js';
const JSDOM=await loadJSDOM();
function fixture(t,extra={}){
 const dom=new JSDOM('<main id="suppliers"></main>',{url:'http://127.0.0.1/'});
 const root=dom.window.document.querySelector('main'),calls=[];
 const state={revision:3,supplierParties:[
 {id:'firm-empty',name:'İnci <img src=x>',accounts:[]},
 {id:'firm-multi',name:'Altın Firma',phone:'000',accounts:[{id:'has',unit:'HAS',balance:-15000},{id:'usd',unit:'USD',balance:900},{id:'tl',unit:'TL',balance:0}],lastEvent:{id:'event-secret',date:'2026-11-10',label:'Ürün alışı'}}]};
 const ctx={state,memory:new Map(),escape:v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
 format:(n,u)=>String(n)+' '+u,day:v=>'Gün '+v,request:()=>{throw Error('unexpected request')},submit:()=>{throw Error('unexpected write')},refresh:()=>calls.push('refresh'),isPending:()=>false,...extra};
 const api=renderSupplierWorkspace(root,ctx);
 t.after(()=>{api.destroy();dom.window.close();});
 return {root,dom,api,state,calls};
}
test('lists independent accountless firms without inventing a TL account and escapes names',t=>{
 const f=fixture(t),card=f.root.querySelector('[data-firm-card="firm-empty"]');
 assert.match(card.textContent,/İnci <img src=x>/);assert.match(card.textContent,/Henüz hesap birimi yok/);assert.doesNotMatch(card.textContent,/0 TL/);assert.equal(f.root.querySelector('img'),null);
});
test('search handles Turkish names and preserves the query through updates',t=>{
 const f=fixture(t),search=f.root.querySelector('[data-supplier-search]');
 search.value='inci';search.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));
 assert.equal(f.root.querySelectorAll('[data-firm-card]').length,1);
 f.api.update(f.state);assert.equal(f.root.querySelector('[data-supplier-search]').value,'inci');
});
test('detail separates native balances and exposes exactly six business tasks',t=>{
 const f=fixture(t);f.root.querySelector('[data-open-firm="firm-multi"]').click();
 const tasks=[...f.root.querySelectorAll('[data-supplier-task]')];
 assert.deepEqual(tasks.map(b=>b.textContent),['Ürün Al','Ödeme Yap','Hesap Mahsup Et','Ürün İade Et','Hareketleri İncele','Ekstre / Mutabakat']);
 assert.match(f.root.querySelector('[data-balance="has"]').textContent,/Borcumuz.*−15000 HAS/);
 assert.match(f.root.querySelector('[data-balance="usd"]').textContent,/Alacağımız.*\+900 USD/);
 assert.match(f.root.querySelector('[data-balance="tl"]').textContent,/Bakiyesi sıfır.*0 TL/);
 assert.doesNotMatch(f.root.textContent,/Toplam HAS/);
 assert.equal(f.dom.window.document.activeElement,f.root.querySelector('[data-firm-heading]'));
});
test('accountless detail still permits choosing payment and routes exact firm identity',t=>{
 const seen=[],f=fixture(t,{onTask:x=>seen.push(x)});f.root.querySelector('[data-open-firm="firm-empty"]').click();
 f.root.querySelector('[data-supplier-task="payment"]').click();
 assert.equal(seen.length,1);assert.equal(seen[0].partyId,'firm-empty');assert.equal(seen[0].kind,'payment');assert.equal(seen[0].context.submit instanceof Function,true);
});
test('pending guard prevents writes even before refreshed DOM and unavailable shell is explicit',t=>{
 let pending=false;const seen=[],f=fixture(t,{isPending:()=>pending,onTask:x=>seen.push(x)});
 f.root.querySelector('[data-open-firm="firm-multi"]').click();pending=true;
 f.root.querySelector('[data-supplier-task="purchase"]').click();assert.equal(seen.length,0);assert.match(f.root.querySelector('[role="status"]').textContent,/Bekleyen/);
 pending=false;f.api.update(f.state);assert.equal(f.root.querySelector('[data-supplier-task="purchase"]').disabled,false);
});
test('missing projection is not reported as no firms, refresh and empty state stay distinct',t=>{
 const f=fixture(t);f.api.update({revision:4});assert.match(f.root.textContent,/Firma bilgileri alınamadı/);
 f.root.querySelector('[data-refresh-suppliers]').click();assert.deepEqual(f.calls,['refresh']);
 f.api.update({revision:5,supplierParties:[]});assert.match(f.root.textContent,/Henüz firma yok/);
 f.root.querySelector('[data-create-firm]').click();assert.ok(f.root.querySelector('[data-supplier-form="create"]'));
});
test('update removes a departed firm and destroy detaches handlers and task cleanup',t=>{
 let cleaned=0;const f=fixture(t,{onTask:()=>()=>cleaned++});f.root.querySelector('[data-open-firm="firm-empty"]').click();
 f.root.querySelector('[data-supplier-task="history"]').click();f.api.update({revision:4,supplierParties:[]});assert.equal(cleaned,1);assert.equal(f.root.querySelector('[data-firm-heading]'),null);
 f.api.destroy();assert.equal(f.root.children.length,0);
});


test('firm and unit forms send explicit identity commands without a default opening account',async t=>{
 const sent=[],f=fixture(t,{submit:async c=>{sent.push(c);return true;}});
 f.root.querySelector('[data-create-firm]').click();
 const form=f.root.querySelector('[data-supplier-form]');
 form.elements.name.value='Yeni Firma';form.requestSubmit();await new Promise(r=>setTimeout(r,0));
 assert.equal(sent[0].type,'supplierFirm');assert.equal(sent[0].name,'Yeni Firma');assert.equal('unit' in sent[0],false);assert.equal('opening' in sent[0],false);
 f.root.querySelector('[data-open-firm="firm-empty"]').click();f.root.querySelector('[data-add-supplier-unit]').click();
 const unit=f.root.querySelector('form');unit.elements.unit.value='HAS';unit.requestSubmit();await new Promise(r=>setTimeout(r,0));
 assert.equal(sent[1].supplierId,'firm-empty');assert.equal(sent[1].unit,'HAS');assert.equal('opening' in sent[1],false);
});
test('purchase keeps manual physical quantity and native obligation independent with optional TL',async t=>{
 const sent=[],f=fixture(t,{submit:async c=>{sent.push(c);return false;}});
 f.state.accounts=[{id:'coin',name:'Çeyrek',unit:'ADET',kind:'asset',physical:true,isPurchasable:true},{id:'cash',name:'Nakit',unit:'TL',kind:'asset',physical:true}];
 f.api.update(f.state);f.root.querySelector('[data-open-firm="firm-multi"]').click();f.root.querySelector('[data-supplier-task="purchase"]').click();
 const form=f.root.querySelector('form'),fill=(g,k,v)=>form.querySelector('[data-group="'+g+'"] [data-field="'+k+'"]').value=v;
 fill('items','accountId','coin');fill('items','quantity','10');fill('charges','accountId','has');fill('charges','quantity','16.530');
 form.requestSubmit();await new Promise(r=>setTimeout(r,0));
 assert.equal(sent[0].type,'supplierPurchase');assert.deepEqual(sent[0].items,[{accountId:'coin',quantity:'10'}]);assert.deepEqual(sent[0].charges,[{accountId:'has',quantity:'16.530'}]);
 assert.equal('referenceTL' in sent[0],false);assert.equal(form.querySelector('[data-group="charges"] [data-field="quantity"]').value,'16.530');
});
test('payment can create reserved advance without existing debt and requires agreement',async t=>{
 const sent=[],f=fixture(t,{submit:async c=>{sent.push(c);return false;}});
 f.state.supplierParties[0].accounts=[{id:'native',unit:'HAS',balance:0}];
 f.state.accounts=[{id:'cash',name:'Nakit',unit:'TL',kind:'asset',physical:true}];f.api.update(f.state);
 f.root.querySelector('[data-open-firm="firm-empty"]').click();f.root.querySelector('[data-supplier-task="payment"]').click();
 const form=f.root.querySelector('form');
 for(const [g,id,q] of [['given','cash','100000'],['credits','native','15']]){form.querySelector('[data-group="'+g+'"] [data-field="accountId"]').value=id;form.querySelector('[data-group="'+g+'"] [data-field="quantity"]').value=q;}
 form.elements.advanceScope.value='reserved';form.elements.advanceScope.dispatchEvent(new f.dom.window.Event('change',{bubbles:true}));form.requestSubmit();await new Promise(r=>setTimeout(r,0));assert.equal(sent.length,0);
 form.elements.agreementId.value='Yüzük siparişi';form.requestSubmit();await new Promise(r=>setTimeout(r,0));
 assert.equal(sent[0].advanceScope,'reserved');assert.deepEqual(sent[0].credits,[{accountId:'native',quantity:'15'}]);assert.deepEqual(sent[0].given,[{accountId:'cash',quantity:'100000'}]);
});


test('drafts survive controller destruction, remain workspace scoped, and require review after revision change',async t=>{
 const memory=new Map(),sent=[],ctx={memory,workspace:'demo',submit:async c=>{sent.push(c);return false;}};
 const f=fixture(t,ctx);f.root.querySelector('[data-create-firm]').click();
 let form=f.root.querySelector('form');form.elements.name.value='Korunan firma';form.elements.name.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));
 f.api.destroy();
 const next=renderSupplierWorkspace(f.root,{state:{...f.state,revision:4},escape:v=>String(v),format:(n,u)=>n+' '+u,day:x=>x,refresh(){},...ctx});
 t.after(()=>next.destroy());form=f.root.querySelector('form');assert.equal(form.elements.name.value,'Korunan firma');
 form.requestSubmit();await new Promise(r=>setTimeout(r,0));assert.equal(sent.length,0);
 form.querySelector('[data-review-current]').click();form.requestSubmit();await new Promise(r=>setTimeout(r,0));assert.equal(sent[0].name,'Korunan firma');
 next.destroy();
 const other=renderSupplierWorkspace(f.root,{state:f.state,escape:v=>String(v),format:(n,u)=>n+' '+u,day:x=>x,refresh(){},...ctx,workspace:'shop'});
 t.after(()=>other.destroy());assert.equal(f.root.querySelector('form'),null);
});
test('submit passes opaque draft identity and cleanup cannot resurrect a confirmed draft',async t=>{
 const memory=new Map();let effect;const f=fixture(t,{memory,workspace:'demo',submit:async(c,m,e)=>{effect=e;return true;}});
 f.root.querySelector('[data-create-firm]').click();const form=f.root.querySelector('form');form.elements.name.value='Başarılı firma';form.requestSubmit();await new Promise(r=>setTimeout(r,0));
 assert.match(effect.supplierDraftKey,/supplier:draft:/);assert.equal(memory.has(effect.supplierDraftKey),false);
 f.api.destroy();assert.equal(memory.has(effect.supplierDraftKey),false);
});


test('unit creation supports explicit three-letter currency without inventing a balance',async t=>{
 const sent=[],f=fixture(t,{submit:async c=>{sent.push(c);return false;}});
 f.root.querySelector('[data-open-firm="firm-empty"]').click();f.root.querySelector('[data-add-supplier-unit]').click();
 const form=f.root.querySelector('form');form.elements.unit.value='other';form.elements.unit.dispatchEvent(new f.dom.window.Event('change',{bubbles:true}));
 form.elements.currencyCode.value='cad';form.requestSubmit();await new Promise(r=>setTimeout(r,0));assert.equal(sent[0].unit,'CAD');
});


test('retry success discards old failed-request form before update cleanup',async t=>{
 const memory=new Map();let effect;const f=fixture(t,{memory,workspace:'demo',submit:async(c,m,e)=>{effect=e;return false;}});
 f.root.querySelector('[data-create-firm]').click();const form=f.root.querySelector('form');form.elements.name.value='Yanıtı kaybolan firma';form.requestSubmit();await new Promise(r=>setTimeout(r,0));
 assert.equal(memory.has(effect.supplierDraftKey),true);memory.delete(effect.supplierDraftKey);
 f.api.update({...f.state,revision:4},{completedDraftKey:effect.supplierDraftKey});
 assert.equal(memory.has(effect.supplierDraftKey),false);assert.equal(f.root.querySelector('form').elements.name.value,'');
});


test('purchase source selection preserves explicit reserved override and immutable ids',async t=>{
 const sent=[],f=fixture(t,{request:async()=>({revision:3,supplier:{id:'firm-multi'},documents:{sources:[{id:'paid-source',date:'2026-11-01',kind:'supplierPayment',advanceScope:'reserved',agreementId:'Başka anlaşma',credits:[{accountId:'has',unit:'HAS',remaining:5000}]}]}}),submit:async c=>{sent.push(c);return false;}});
 f.state.accounts=[{id:'coin',name:'Çeyrek',unit:'ADET',kind:'asset',physical:true,isPurchasable:true}];f.api.update(f.state);
 f.root.querySelector('[data-open-firm="firm-multi"]').click();f.root.querySelector('[data-supplier-task="purchase"]').click();await new Promise(r=>setTimeout(r,0));
 const form=f.root.querySelector('form');for(const[g,id,q]of [['items','coin','1'],['charges','has','5']]){form.querySelector('[data-group="'+g+'"] [data-field="accountId"]').value=id;form.querySelector('[data-group="'+g+'"] [data-field="quantity"]').value=q;}
 form.querySelector('[data-add-source]').click();const select=form.querySelector('[data-source-field="choice"]');select.value=JSON.stringify(['paid-source','has']);select.dispatchEvent(new f.dom.window.Event('change',{bubbles:true}));
 form.querySelector('[data-source-field="quantity"]').value='5';form.requestSubmit();await new Promise(r=>setTimeout(r,0));assert.equal(sent.length,0);
 form.querySelector('[data-source-field="overrideReserved"]').checked=true;form.querySelector('[data-source-field="reason"]').value='Bu alış için açık anlaşma';form.requestSubmit();await new Promise(r=>setTimeout(r,0));
 assert.deepEqual(sent[0].allocations,[{sourceId:'paid-source',accountId:'has',quantity:'5',overrideReserved:true,reason:'Bu alış için açık anlaşma'}]);
});


test('source amount custom validity clears on correction before native requestSubmit',async t=>{
 const sent=[],f=fixture(t,{parseAmount:(input,unit)=>{const n=Number(input.value);input.setCustomValidity(!Number.isFinite(n)||n<=0?'Geçersiz':'');return input.validity.valid?n*(unit==='HAS'?1000:1):null;},request:async()=>({revision:3,supplier:{id:'firm-multi'},documents:{sources:[{id:'paid',date:'2026-11-01',credits:[{accountId:'has',unit:'HAS',remaining:5000}]}]}}),submit:async c=>{sent.push(c);return false;}});
 f.state.accounts=[{id:'coin',name:'Çeyrek',unit:'ADET',kind:'asset',isPurchasable:true}];f.api.update(f.state);f.root.querySelector('[data-open-firm="firm-multi"]').click();f.root.querySelector('[data-supplier-task="purchase"]').click();await new Promise(r=>setTimeout(r,0));const form=f.root.querySelector('form');for(const[g,id,q]of [['items','coin','1'],['charges','has','5']]){form.querySelector('[data-group="'+g+'"] select').value=id;form.querySelector('[data-group="'+g+'"] input').value=q;}form.querySelector('[data-add-source]').click();const select=form.querySelector('[data-source-field="choice"]'),amount=form.querySelector('[data-source-field="quantity"]');select.value=JSON.stringify(['paid','has']);select.dispatchEvent(new f.dom.window.Event('change',{bubbles:true}));amount.value='abc';form.requestSubmit();await new Promise(r=>setTimeout(r,0));assert.equal(sent.length,0);assert.equal(amount.validity.customError,true);amount.value='2';amount.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));form.requestSubmit();await new Promise(r=>setTimeout(r,0));assert.equal(sent.length,1);assert.equal(sent[0].allocations[0].quantity,'2');
});

test('purchase product selector names its stock-only scope',t=>{
 const f=fixture(t);f.state.accounts=[{id:'coin',name:'Çeyrek',unit:'ADET',kind:'asset',isPurchasable:true}];f.api.update(f.state);f.root.querySelector('[data-open-firm="firm-multi"]').click();f.root.querySelector('[data-supplier-task="purchase"]').click();assert.equal(f.root.querySelector('[data-group="items"] label span').textContent,'Ürün');
});

test('supplier interactions notify owner wrapper and SILVER is presentation-only',t=>{
 const interactions=[],sent=[],f=fixture(t,{onInteraction:()=>interactions.push(1),submit:async c=>{sent.push(c);return false;}});f.state.supplierParties[1].accounts.push({id:'silver',unit:'SILVER',balance:25000});f.api.update(f.state);assert.match(f.root.textContent,/Ag.*saf gümüş/);f.root.querySelector('[data-open-firm="firm-multi"]').click();assert.ok(interactions.length);f.root.querySelector('[data-edit-supplier]').click();const before=interactions.length;f.root.querySelector('[name="name"]').dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));assert.ok(interactions.length>before);assert.equal(f.state.supplierParties[1].accounts.at(-1).unit,'SILVER');
});
test('invalid physical quantity suppresses all financial prediction until corrected',t=>{
 const f=fixture(t,{parseAmount:(input,u)=>{const n=Number(input.value);return input.value.trim()&&Number.isFinite(n)&&n>0?n*(u==='ADET'?1:1000):null;}});f.state.accounts=[{id:'coin',name:'Çeyrek',unit:'ADET',kind:'asset',isPurchasable:true}];f.api.update(f.state);f.root.querySelector('[data-open-firm="firm-multi"]').click();f.root.querySelector('[data-supplier-task="purchase"]').click();const form=f.root.querySelector('form');for(const[g,id,q]of [['items','coin','-1'],['charges','has','5']]){form.querySelector('[data-group="'+g+'"] select').value=id;form.querySelector('[data-group="'+g+'"] input').value=q;}form.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));const preview=form.querySelector('[data-supplier-preview]');assert.match(preview.textContent,/Eksik veya geçersiz/);assert.doesNotMatch(preview.textContent,/önce → sonra/);const qty=form.querySelector('[data-group="items"] input');qty.value='1';qty.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));assert.match(preview.textContent,/önce → sonra/);
});
test('current payment availability help follows entered credit rather than empty prior documents',async t=>{
 const f=fixture(t,{parseAmount:(input,u)=>input.value.trim()&&Number(input.value)>0?Number(input.value)*1000:null,request:async()=>({revision:3,supplier:{id:'firm-multi'},documents:{sources:[],purchases:[]}})});f.state.accounts=[{id:'coin',name:'Çeyrek',unit:'ADET',kind:'asset',isPurchasable:true}];f.api.update(f.state);f.root.querySelector('[data-open-firm="firm-multi"]').click();f.root.querySelector('[data-supplier-task="purchase"]').click();await new Promise(r=>setTimeout(r,0));const form=f.root.querySelector('form');form.querySelector('[data-group="credits"] [data-add-row]').click();const select=form.querySelector('[data-group="credits"] select'),qty=form.querySelector('[data-group="credits"] input');select.value='has';qty.value='5';qty.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));const text=form.querySelector('[data-supplier-sources="purchase"] [data-source-status]').textContent;assert.match(text,/Bu işlemdeki ödeme/);assert.doesNotMatch(text,/kaynağı yok/);qty.value='';qty.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));assert.match(form.querySelector('[data-supplier-sources="purchase"] [data-source-status]').textContent,/kaynağı yok/);qty.value='5';qty.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));form.querySelector('[data-group="credits"] [data-remove-row]').click();assert.match(form.querySelector('[data-supplier-sources="purchase"] [data-source-status]').textContent,/kaynağı yok/);
});

test('restored optional note and agreement reopen their metadata disclosures',t=>{
 const memory=new Map();memory.set('supplier:view:default',{partyId:'firm-multi',kind:'purchase'});memory.set('supplier:draft:'+JSON.stringify(['default','firm-multi','purchase']),{fields:{note:'Korunan açıklama',agreementId:'Anlaşma'},rows:{items:[],charges:[]},stamp:{revision:3,date:undefined}});const f=fixture(t,{memory});const note=f.root.querySelector('[name="note"]');assert.equal(note.value,'Korunan açıklama');assert.equal(note.closest('details').open,true);assert.equal(f.root.querySelector('[name="agreementId"]').closest('details')?.open,true);assert.ok(f.root.querySelector('.supplier-active-header .supplier-balances'));assert.ok(f.root.querySelector('.supplier-task-form[data-kind="purchase"]'));
});

test('missing payment agreement suppresses balance and reveals the exact native quantity on submit',async t=>{
 const sent=[],f=fixture(t,{submit:async c=>{sent.push(c);return false;},parseAmount:(input,u)=>input.value.trim()&&Number(input.value)>0?Number(input.value)*(u==='TL'?100:1000):null,format:(n,u)=>new Intl.NumberFormat('tr-TR').format(n/(u==='TL'?100:1000))+' '+u});
 f.state.supplierParties[1].accounts=[{id:'has',unit:'HAS',balance:-10000}];
 f.state.accounts=[{id:'gram',name:'GRAM ALTIN',unit:'GRAM',kind:'asset',isPurchasable:true},{id:'cash',name:'Nakit',unit:'TL',kind:'asset',physical:true}];f.api.update(f.state);
 f.root.querySelector('[data-open-firm="firm-multi"]').click();f.root.querySelector('[data-supplier-task="purchase"]').click();const form=f.root.querySelector('form');
 for(const[g,id,q]of [['items','gram','50'],['charges','has','49'],['given','cash','700000']]){
  if(!form.querySelector('[data-group="'+g+'"] [data-row]'))form.querySelector('[data-group="'+g+'"] [data-add-row]').click();
  for(const[k,v]of [['accountId',id],['quantity',q]]){const input=form.querySelector('[data-group="'+g+'"] [data-field="'+k+'"]');input.value=v;input.dispatchEvent(new f.dom.window.Event(k==='accountId'?'change':'input',{bubbles:true}));}
 }
 const preview=form.querySelector('[data-supplier-preview]');assert.doesNotMatch(preview.textContent,/önce → sonra/);
 const help=[...form.querySelectorAll('[data-payment-help]')].map(n=>n.textContent).join(' ');assert.match(help,/700[.\s]?000.*TL/);assert.match(help,/HAS/);assert.match(help,/belirt|gir|kapat/i);
 form.requestSubmit();await new Promise(r=>setTimeout(r,0));assert.equal(sent.length,0);
 const quantity=form.querySelector('[data-group="credits"] [data-field="quantity"]');assert.ok(quantity);assert.equal(quantity.closest('details').open,true);assert.equal(f.dom.window.document.activeElement,quantity);assert.equal(form.querySelector('[data-group="credits"] [data-field="accountId"]').value,'has');
 quantity.value='49';quantity.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));form.requestSubmit();await new Promise(r=>setTimeout(r,0));assert.equal(sent.length,1);assert.deepEqual(sent[0].credits,[{accountId:'has',quantity:'49'}]);
});

test('explicit same-unit shortcut copies payment only in its own native unit',t=>{
 const f=fixture(t,{parseAmount:(input,u)=>input.value.trim()&&Number(input.value)>0?Number(input.value)*(u==='HAS'?1000:100):null});f.state.accounts=[{id:'cash',name:'Nakit',unit:'TL',kind:'asset',physical:true}];f.api.update(f.state);
 f.root.querySelector('[data-open-firm="firm-multi"]').click();f.root.querySelector('[data-supplier-task="payment"]').click();const form=f.root.querySelector('form');
 for(const[g,k,v]of [['given','accountId','cash'],['given','quantity','123.45'],['credits','accountId','tl']]){const input=form.querySelector('[data-group="'+g+'"] [data-field="'+k+'"]');input.value=v;input.dispatchEvent(new f.dom.window.Event(k==='accountId'?'change':'input',{bubbles:true}));}
 const credit=form.querySelector('[data-group="credits"] [data-field="quantity"]');assert.equal(credit.value,'');const copy=form.querySelector('[data-copy-payment]');assert.ok(copy);assert.equal(copy.disabled,false);copy.click();assert.equal(Number(credit.value),123.45);
 const account=form.querySelector('[data-group="credits"] [data-field="accountId"]');account.value='has';account.dispatchEvent(new f.dom.window.Event('change',{bubbles:true}));credit.value='7';credit.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));
 const unlike=form.querySelector('[data-copy-payment]');assert.ok(!unlike||unlike.disabled||unlike.hidden,'unlike-unit payment must not expose automatic conversion');if(unlike)unlike.click();assert.equal(credit.value,'7');
});

test('opposing payment groups are secondary and valued drafts reopen without dropping lines',t=>{
 const memory=new Map(),f=fixture(t,{memory});f.state.accounts=[{id:'cash',name:'Nakit',unit:'TL',kind:'asset',physical:true}];f.api.update(f.state);
 f.root.querySelector('[data-open-firm="firm-multi"]').click();f.root.querySelector('[data-supplier-task="payment"]').click();let form=f.root.querySelector('form');
 for(const name of ['received','debts'])assert.equal(form.querySelector('[data-group="'+name+'"]').closest('details')?.open,false);
 for(const[g,id,q]of [['received','cash','12'],['debts','tl','12']]){form.querySelector('[data-group="'+g+'"] [data-add-row]').click();for(const[k,v]of [['accountId',id],['quantity',q]]){const input=form.querySelector('[data-group="'+g+'"] [data-field="'+k+'"]');input.value=v;input.dispatchEvent(new f.dom.window.Event(k==='accountId'?'change':'input',{bubbles:true}));}}
 f.root.querySelector('[data-supplier-task="purchase"]').click();f.root.querySelector('[data-supplier-task="payment"]').click();form=f.root.querySelector('form');
 for(const name of ['received','debts']){const section=form.querySelector('[data-group="'+name+'"]');assert.equal(section.closest('details').open,true);assert.equal(section.querySelector('[data-field="quantity"]').value,'12');}
});

test('new purchase optional agreement metadata starts collapsed',t=>{
 const f=fixture(t);f.root.querySelector('[data-open-firm="firm-multi"]').click();f.root.querySelector('[data-supplier-task="purchase"]').click();const form=f.root.querySelector('form');assert.equal(form.elements.agreementId.closest('details')?.open,false);assert.equal(form.querySelector('[data-group="items"]').closest('details'),null);assert.equal(form.querySelector('[data-group="charges"]').closest('details'),null);
});

test('direction change discards saved source links even when the old request resolves last',async t=>{
 const memory=new Map(),pending=[];memory.set('supplier:view:default',{partyId:'firm-multi',kind:'payment'});
 memory.set('supplier:draft:'+JSON.stringify(['default','firm-multi','payment']),{fields:{direction:'pay',advanceScope:'reserved',agreementId:'Eski anlaşma'},rows:{given:[],credits:[],received:[],debts:[]},links:[{choice:JSON.stringify(['old-source','has']),quantity:'2'}],stamp:{revision:3,date:undefined}});
 const f=fixture(t,{memory,request:()=>new Promise(resolve=>pending.push(resolve))}),form=f.root.querySelector('form');assert.equal(pending.length,1);
 form.elements.direction.value='collect';form.elements.direction.dispatchEvent(new f.dom.window.Event('change',{bubbles:true}));assert.equal(pending.length,2);
 const response={revision:3,supplier:{id:'firm-multi'},documents:{purchases:[],sources:[{id:'old-source',date:'2026-11-10',kind:'supplierPayment',advanceScope:'general',credits:[{accountId:'has',unit:'HAS',remaining:10000}]}]}};
 pending[1](response);await new Promise(r=>setTimeout(r,0));pending[0](response);await new Promise(r=>setTimeout(r,0));
 assert.equal(form.querySelectorAll('[data-source-rows] > *').length,0);assert.equal(form.elements.agreementId.value,'');assert.equal(form.elements.advanceScope.value,'general');
 form.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));assert.deepEqual(memory.get('supplier:draft:'+JSON.stringify(['default','firm-multi','payment'])).links,[]);
});

test('general payment can explicitly supply an optional agreement without reserving the advance',async t=>{
 const sent=[],f=fixture(t,{submit:async c=>{sent.push(c);return false;}});f.state.accounts=[{id:'cash',name:'Nakit',unit:'TL',kind:'asset',physical:true}];f.api.update(f.state);
 f.root.querySelector('[data-open-firm="firm-multi"]').click();f.root.querySelector('[data-supplier-task="payment"]').click();const form=f.root.querySelector('form'),agreement=form.elements.agreementId,details=agreement.closest('details');assert.ok(details);assert.equal(agreement.required,false);details.open=true;assert.equal(agreement.closest('label').hidden,false);assert.equal(agreement.disabled,false);
 for(const[g,id,q]of [['given','cash','100'],['credits','tl','100']])for(const[k,v]of [['accountId',id],['quantity',q]]){const input=form.querySelector('[data-group="'+g+'"] [data-field="'+k+'"]');input.value=v;input.dispatchEvent(new f.dom.window.Event(k==='accountId'?'change':'input',{bubbles:true}));}
 agreement.value='Genel ödeme notu';agreement.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));form.requestSubmit();await new Promise(r=>setTimeout(r,0));assert.equal(sent.length,1);assert.equal(sent[0].agreementId,'Genel ödeme notu');assert.equal(sent[0].advanceScope,'general');
});

test('missing payment agreement does not steal focus from an invalid product quantity',t=>{
 const sent=[],f=fixture(t,{submit:async c=>{sent.push(c);return false;}});f.state.accounts=[{id:'gram',name:'GRAM ALTIN',unit:'GRAM',kind:'asset',isPurchasable:true},{id:'cash',name:'Nakit',unit:'TL',kind:'asset',physical:true}];f.api.update(f.state);
 f.root.querySelector('[data-open-firm="firm-multi"]').click();f.root.querySelector('[data-supplier-task="purchase"]').click();const form=f.root.querySelector('form');
 for(const[g,id,q]of [['items','gram',''],['charges','has','49'],['given','cash','700000']]){if(!form.querySelector('[data-group="'+g+'"] [data-row]'))form.querySelector('[data-group="'+g+'"] [data-add-row]').click();form.querySelector('[data-group="'+g+'"] select').value=id;form.querySelector('[data-group="'+g+'"] [data-field="quantity"]').value=q;}
 form.requestSubmit();assert.equal(sent.length,0);assert.equal(f.dom.window.document.activeElement,form.querySelector('[data-group="items"] [data-field="quantity"]'));assert.equal(form.querySelectorAll('[data-group="credits"] [data-row]').length,0);
});
