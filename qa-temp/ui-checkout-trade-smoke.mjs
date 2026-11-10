import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadJSDOM } from '../test-support/jsdom.mjs';

const base = {
  initialized:true, date:'2026-11-10', revision:1,
  products:[{id:'ceyrek',name:'Çeyrek',unit:'ADET',scrap:false,canBuy:true,canSell:true,quantity:20,freeQuantity:20,weights:[]},
    {id:'hurda14',name:'14 ayar hurda',unit:'GRAM',scrap:true,canBuy:true,canSell:false,quantity:12000,freeQuantity:12000,weights:[]}],
  stocks:[{id:'ceyrek',name:'Çeyrek',unit:'ADET',quantity:20,freeQuantity:20},{id:'hurda14',name:'14 ayar hurda',unit:'GRAM',quantity:12000,freeQuantity:12000}],
  inventoryItems:[], payments:[{id:'nakit',name:'Nakit',unit:'TL'},{id:'usd',name:'Dolar',unit:'USD'},{id:'pos',name:'POS',unit:'TL'}]
};
const person={id:'cari-person',name:'Seçilen müşteri',accounts:[{id:'cari-person',name:'Seçilen müşteri',unit:'USD',balance:200}]};
async function setup(t,handler,seed,initialDraft) {
  const JSDOM=await loadJSDOM();
  const dom=new JSDOM(readFileSync(new URL('../public/checkout.html',import.meta.url),'utf8'),{url:'http://127.0.0.1:4317/checkout',runScripts:'outside-only'});
  const {window}=dom,doc=window.document,get=s=>doc.querySelector(s),tick=()=>new Promise(r=>setTimeout(r,0));
  t.after(()=>window.close());
  Object.defineProperty(window.crypto,'randomUUID',{value:randomUUID});
  if(seed)window.sessionStorage.setItem('defter-sale-retry-worker-demo',JSON.stringify(seed));
  if(initialDraft)window.sessionStorage.setItem('defter-pending-checkout-draft-worker-demo-sale',JSON.stringify(initialDraft));
  const calls=[],snapshot=structuredClone(base);
  window.DefterSession={current:()=>({actor:{id:'worker'}}),api:async(path,body)=>{
    if(body)calls.push(body);
    if(handler) {const result=await handler({path,body,snapshot,calls});if(result!==undefined)return result;}
    if(body){snapshot.revision++;return{id:body.id,revision:snapshot.revision,duplicate:false};}
    if(path.includes('&id='))return person;
    if(path.includes('/customers'))return[{id:person.id,name:person.name,unit:'USD'}];
    return snapshot;
  }};
  window.eval(readFileSync(new URL('../public/checkout.js',import.meta.url),'utf8'));
  const fill=(selector,value)=>{const el=typeof selector==='string'?get(selector):selector;assert.ok(el,String(selector));el.value=value;el.dispatchEvent(new window.Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));};
  await tick();await tick();
  return {window,doc,get,tick,fill,calls,snapshot};
}
function simpleSale(f) {
  f.fill('[data-item] [data-quantity]','1');f.fill('[data-item] [data-value]','100');
  f.get('[data-add="received"][data-category="money"]').click();
  const row=f.get('[data-allocation="received"]');
  f.fill(row.querySelector('[data-account]'),'nakit');f.fill(row.querySelector('[data-quantity]'),'100');
}
test('multi-row checkout retains native quantities and requires review before one command',async t=>{
  const f=await setup(t),{get,fill,doc,tick,calls}=f;
  fill('[data-item] [data-quantity]','1');fill('[data-item] [data-value]','100');
  get('#add-item').click();
  const row=doc.querySelectorAll('[data-item]')[1];fill(row.querySelector('[data-quantity]'),'2');fill(row.querySelector('[data-value]'),'200');
  get('[data-add="received"][data-category="money"]').click();
  const receipt=get('[data-allocation="received"]');fill(receipt.querySelector('[data-account]'),'usd');fill(receipt.querySelector('[data-quantity]'),'10');fill(receipt.querySelector('[data-value]'),'300');
  get('#trade').requestSubmit();assert.equal(calls.length,0);assert.equal(get('#review').hidden,false);
  assert.match(get('#review-content').textContent,/10 USD/);
  get('#confirm').click();await tick();await tick();assert.equal(calls.length,1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].command.items)).map(row=>row.quantity),['1','2']);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].command.received)),[{accountId:'usd',quantity:'10',valueTL:'300'}]);
});
test('uncertain write retries exact id, revision and body across a newer snapshot, with draft edits blocked',async t=>{
  let first=true;
  const f=await setup(t,({body,snapshot})=>{if(body&&first){first=false;snapshot.revision++;throw Object.assign(Error('Bağlantı kesildi'),{status:503});}});
  simpleSale(f);f.get('#trade').requestSubmit();f.get('#confirm').click();await f.tick();await f.tick();
  assert.equal(f.get('#pending-panel').hidden,false);assert.equal(f.get('#trade-controls').disabled,true);
  const request=JSON.stringify(f.calls[0]);
  f.get('#retry').click();await f.tick();await f.tick();
  assert.equal(JSON.stringify(f.calls[1]),request);assert.equal(f.get('#pending-panel').hidden,true);
});
test('legacy ambiguous envelope is retried unchanged after page load',async t=>{
  const legacy={id:'original-request',revision:1,command:{type:'sale',date:'2026-11-10',items:[{accountId:'ceyrek',quantity:'1',value:'100'}],received:[{accountId:'nakit',quantity:'100'}]}};
  const f=await setup(t,undefined,legacy);
  assert.equal(f.get('#pending-panel').hidden,false);
  f.get('#retry').click();await f.tick();await f.tick();
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0])),legacy);
});
test('sale/purchase/workspace drafts survive switches and changed revision requires acknowledgment',async t=>{
  const f=await setup(t);simpleSale(f);
  f.fill('#operation','purchase');assert.equal(f.get('[data-item] [data-value]').value,'');
  f.fill('[data-item] [data-value]','55');
  f.fill('#operation','sale');assert.equal(f.get('[data-item] [data-value]').value,'100');
  f.fill('#workspace','dukkan');await f.tick();await f.tick();assert.equal(f.get('[data-item] [data-value]').value,'');
  f.fill('#workspace','demo');await f.tick();await f.tick();assert.equal(f.get('[data-item] [data-value]').value,'100');
  f.snapshot.revision=4;f.get('#refresh').click();await f.tick();await f.tick();
  assert.equal(f.get('#draft-stale').hidden,false);assert.equal(f.get('#record').disabled,true);
  f.get('#accept-snapshot').click();assert.equal(f.get('#draft-stale').hidden,true);
  f.get('#trade').requestSubmit();assert.equal(f.get('#review').hidden,false);
});
test('deferred customer selection cannot cross operation or workspace',async t=>{
  let resolve;
  const delayed=new Promise(r=>resolve=r);
  const f=await setup(t,({path})=>path.includes('&id=')?delayed:undefined);
  f.fill('#search','müş');await f.tick();f.fill('#customer',person.id);
  f.fill('#operation','purchase');resolve(person);await f.tick();await f.tick();
  assert.equal(f.get('#customer').value,'');assert.equal(f.get('#customer-balance').textContent,'');
  assert.equal(f.get('#record').disabled,false);
});
test('customer creation retains the trade draft and explicitly selects returned native account',async t=>{
  const f=await setup(t,({body,snapshot})=>{
    if(body?.command.type==='account'){snapshot.revision++;return{id:body.id,revision:snapshot.revision,account:{id:person.id,name:person.name,unit:'USD'}};}
  });
  simpleSale(f);f.fill('#customer-form [name="name"]','Seçilen müşteri');f.fill('#customer-form [name="unit"]','USD');
  f.get('#customer-form').requestSubmit();await f.tick();await f.tick();await f.tick();
  assert.equal(f.calls[0].command.opening,'0');assert.equal(f.calls[0].command.partyType,'customer');
  assert.equal(f.get('#customer').value,person.id);assert.equal(f.get('[data-item] [data-value]').value,'100');
  assert.match(f.get('#customer-balance').textContent,/2,00 USD/);
});
test('mixed products, USD cash, TL change and selected USD current account preserve both sides',async t=>{
  const f=await setup(t);
  f.fill('#search','müş');await f.tick();f.fill('#customer',person.id);await f.tick();await f.tick();
  f.fill('[data-item] [data-quantity]','1');f.fill('[data-item] [data-value]','100');
  function add(kind,id,quantity,value) {
    const category=['credits','debts'].includes(kind)?'':id==='hurda14'?'scrap':id==='ceyrek'?'product':'money';
    f.get('[data-add="'+kind+'"]'+(category?'[data-category="'+category+'"]':'')).click();
    const row=[...f.doc.querySelectorAll('[data-allocation="'+kind+'"]')].at(-1);
    f.fill(row.querySelector('[data-account]'),id);f.fill(row.querySelector('[data-quantity]'),quantity);
    if(value)f.fill(row.querySelector('[data-value]'),value);
  }
  add('received','usd','2','50');add('received','hurda14','1.25','40');add('given','nakit','10');add('credits',person.id,'0.8','20');
  f.get('#trade').requestSubmit();assert.equal(f.get('#review').hidden,false);
  assert.match(f.get('#review-content').textContent,/1.25 gr/);
  f.get('#confirm').click();await f.tick();await f.tick();
  const c=f.calls[0].command;
  assert.equal(c.received.length,2);assert.equal(c.given[0].quantity,'10');assert.equal(c.credits[0].quantity,'0.8');assert.equal(c.credits[0].valueTL,'20');
  assert.equal(c.counterpartyId,person.id);
  assert.doesNotMatch(JSON.stringify(c),/costTL|costSource|purchaseLine/);
});
test('stock inspection shows gram balances and no cash balances; negative payment and missing customer block review',async t=>{
  const f=await setup(t);assert.match(f.get('#stock-list').textContent,/12,000 gr/);assert.doesNotMatch(f.get('#stock-list').textContent,/Nakit|Dolar|POS/);
  simpleSale(f);f.fill('[data-allocation="received"] [data-quantity]','-100');
  f.get('#trade').requestSubmit();assert.equal(f.get('#review').hidden,true);
  f.fill('[data-allocation="received"] [data-quantity]','100');
  f.get('[data-add="credits"]').click();f.get('#trade').requestSubmit();assert.equal(f.get('#review').hidden,true);
});

test('optional zero price quote remains distinct from unknown and never adds a cost field',async t=>{
  const f=await setup(t);simpleSale(f);
  f.fill('[data-quoted]','0');f.fill('[data-source]','Müşteri teklifi');
  f.get('#trade').requestSubmit();assert.equal(f.get('#review').hidden,false);
  f.get('#confirm').click();await f.tick();await f.tick();
  assert.equal(f.calls[0].command.salePricing.lines[0].quotedTL,'0');
  assert.equal(f.calls[0].command.salePricing.lines[0].costTL,undefined);
});

test('correcting an invalid item quantity permits a new native submit',async t=>{
 const f=await setup(t);simpleSale(f);
 f.fill('[data-item] [data-quantity]','1.2');
 f.get('#trade').requestSubmit();
 assert.equal(f.get('[data-item] [data-quantity]').validity.customError,true);
 assert.match(f.get('#status').textContent,/satırlarını tamamlayın/);
 f.fill('[data-item] [data-quantity]','1');
 f.get('#trade').requestSubmit();
 assert.equal(f.get('#review').hidden,false);
 assert.equal(f.get('#status').textContent,'');
});
test('creating a customer cannot acknowledge an already stale trade draft',async t=>{
 const f=await setup(t,({body,snapshot})=>{if(body?.command.type==='account'){snapshot.revision++;return {id:body.id,revision:snapshot.revision,account:{id:person.id}};}});
 simpleSale(f);f.snapshot.revision=4;f.get('#refresh').click();await f.tick();await f.tick();
 assert.equal(f.get('#draft-stale').hidden,false);
 f.fill('#customer-form [name=name]','New customer');f.get('#customer-form').requestSubmit();await f.tick();await f.tick();await f.tick();
 assert.equal(f.get('#draft-stale').hidden,false);
 assert.equal(f.get('#record').disabled,true);
});
test('a search superseding customer detail load releases its loading gate',async t=>{
 let resolve;const delayed=new Promise(r=>resolve=r);
 const f=await setup(t,({path})=>path.includes('&id=')?delayed:undefined);
 f.fill('#search','müş');await f.tick();f.fill('#customer',person.id);
 f.fill('#search','other');await f.tick();resolve(person);await f.tick();await f.tick();
 assert.equal(f.get('#record').disabled,false);
});
test('reloading a selected foreign customer preserves manually agreed TL references after a rejected write',async t=>{
 const f=await setup(t,({body})=>{if(body)throw Object.assign(Error('Yetersiz mevcut'),{status:400});});
 f.fill('#search','müş');await f.tick();f.fill('#customer',person.id);await f.tick();await f.tick();
 f.fill('[data-item] [data-quantity]','1');f.fill('[data-item] [data-value]','100');
 f.get('[data-add="received"][data-category="money"]').click();
 f.fill('[data-allocation="received"] [data-account]','usd');f.fill('[data-allocation="received"] [data-quantity]','2');f.fill('[data-allocation="received"] [data-value]','80');
 f.get('[data-add="credits"]').click();
 f.fill('[data-allocation="credits"] [data-account]',person.id);f.fill('[data-allocation="credits"] [data-quantity]','0.8');f.fill('[data-allocation="credits"] [data-value]','20');
 f.get('#trade').requestSubmit();f.get('#confirm').click();await f.tick();await f.tick();await f.tick();
 assert.equal(f.get('[data-allocation="credits"] [data-value]').value,'20');
 assert.equal(f.get('[data-allocation="credits"] [data-quantity]').value,'0.8');
 f.get('#trade').requestSubmit();assert.equal(f.get('#review').hidden,false);
});
test('received and given categories expose only money, non-scrap product or flagged scrap',async t=>{
 const f=await setup(t);
 for(const direction of ['received','given'])for(const category of ['money','product','scrap']){
  const button=f.get('[data-add="'+direction+'"][data-category="'+category+'"]');assert.ok(button);
  button.click();const row=[...f.doc.querySelectorAll('[data-allocation="'+direction+'"]')].at(-1);
  const ids=[...row.querySelector('[data-account]').options].map(o=>o.value).filter(Boolean);
  assert.deepEqual(ids,category==='money'?(direction==='received'?['nakit','usd','pos']:['nakit','usd']):category==='product'?['ceyrek']:['hurda14']);
  assert.equal(row.dataset.category,category);
 }
});
test('old untyped draft rows infer category from account and preserve manual references without changing wire schema',async t=>{
 const initialDraft={revision:1,date:base.date,items:[{selection:'ceyrek',quantity:'1',value:'100'}],
  received:[{accountId:'usd',quantity:'2',valueTL:'50'},{accountId:'hurda14',quantity:'1.25',valueTL:'40'},{accountId:'ceyrek',quantity:'1',valueTL:'10'}],given:[],credits:[],debts:[]};
 const f=await setup(t,undefined,undefined,initialDraft);
 assert.deepEqual([...f.doc.querySelectorAll('[data-allocation]')].map(row=>row.dataset.category),['money','scrap','product']);
 assert.deepEqual([...f.doc.querySelectorAll('[data-allocation] [data-value]')].map(input=>input.value),['50','40','10']);
 f.get('#trade').requestSubmit();assert.equal(f.get('#review').hidden,false);
 f.get('#confirm').click();await f.tick();await f.tick();
 assert.doesNotMatch(JSON.stringify(f.calls[0].command),/category/);
 assert.equal(f.calls[0].command.received[1].valueTL,'40');
});
test('a stale cash selection in a current-account draft cannot resolve as a valid receivable',async t=>{
 const initialDraft={revision:1,date:base.date,customer:person,items:[{selection:'ceyrek',quantity:'1',value:'100'}],
  received:[],given:[],credits:[{accountId:'nakit',quantity:'100',valueTL:'100'}],debts:[]};
 const f=await setup(t,undefined,undefined,initialDraft);
 f.get('#trade').requestSubmit();assert.equal(f.get('#review').hidden,true);
 assert.equal(f.get('[data-allocation="credits"] [data-account]').validity.customError,true);
 assert.equal(f.calls.length,0);
 f.fill('[data-allocation="credits"] [data-account]',person.id);
 f.fill('[data-allocation="credits"] [data-quantity]','2');f.fill('[data-allocation="credits"] [data-value]','100');
 f.get('#trade').requestSubmit();assert.equal(f.get('#review').hidden,false);
});
test('after creating an other-currency customer, a new TL customer has no hidden required currency field',async t=>{
 const f=await setup(t,({body,snapshot})=>{
  if(body?.command.type==='account'){snapshot.revision++;return{id:body.id,revision:snapshot.revision,account:{id:person.id,name:person.name,unit:body.command.unit}};}
 });
 f.fill('#customer-form [name="name"]','İlk müşteri');f.fill('#customer-form [name="unit"]','other');f.fill('#customer-form [name="currencyCode"]','CAD');
 f.get('#customer-form').requestSubmit();await f.tick();await f.tick();await f.tick();
 assert.equal(f.calls[0].command.unit,'CAD');
 f.fill('#customer-form [name="name"]','İkinci müşteri');
 assert.equal(f.get('#customer-form [name="unit"]').value,'TL');
 assert.equal(f.get('#other-unit-field').hidden,true);
 assert.equal(f.get('#customer-form [name="currencyCode"]').required,false);
 f.get('#customer-form').requestSubmit();await f.tick();await f.tick();await f.tick();
 assert.equal(f.calls.length,2);assert.equal(f.calls[1].command.unit,'TL');
});
for (const operation of ['sale','purchase']) test('completed '+operation+' clears the customer search while draft refresh preserves it',async t=>{
 const f=await setup(t);
 f.fill('#operation',operation);
 f.fill('#search','Deneme USD');await f.tick();f.fill('#customer',person.id);await f.tick();await f.tick();
 f.get('#refresh').click();await f.tick();await f.tick();
 assert.equal(f.get('#search').value,'Deneme USD');
 assert.equal(f.get('#customer').value,person.id);
 f.fill('[data-item] [data-quantity]','1');f.fill('[data-item] [data-value]','100');
 const direction=operation==='sale'?'received':'given';
 f.get('[data-add="'+direction+'"][data-category="money"]').click();
 const row=f.get('[data-allocation="'+direction+'"]');
 f.fill(row.querySelector('[data-account]'),'nakit');f.fill(row.querySelector('[data-quantity]'),'100');
 f.get('#trade').requestSubmit();f.get('#confirm').click();await f.tick();await f.tick();await f.tick();
 assert.equal(f.calls.length,1);
 assert.equal(f.get('#customer').value,'');
 assert.equal(f.get('#search').value,'');
});
