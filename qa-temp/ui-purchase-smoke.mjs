import * as supplierModule from '../public/suppliers.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadJSDOM } from '../test-support/jsdom.mjs';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS, applyEvent, eventVersion } from '../domain.mjs';

const JSDOM = await loadJSDOM();
const repo = new Repository();
const run = command => repo.execute({id:randomUUID(),revision:repo.state().revision,command});
const opening = Object.fromEntries(INITIAL_ACCOUNTS.filter(a=>!a.retired).map(a=>[a.id,'0']));
Object.assign(opening,{nakit:'10000',banka:'10000',bilezikAdet:'100',bilezik22:'1205',gramToplam:'243'});
run({type:'opening',date:'2026-10-27',balances:opening});
const counterpartyId=randomUUID();
repo.execute({id:counterpartyId,revision:repo.state().revision,command:{type:'supplierFirm',date:repo.state().date,name:'Örnek tedarikçi <img src=x>'}});
const firm='supplier-'+counterpartyId;
run({type:'supplierUnit',date:repo.state().date,supplierId:firm,unit:'TL'});
const supplier=repo.state().accounts.at(-1).id;
const dom=new JSDOM(readFileSync(new URL('../public/index.html',import.meta.url),'utf8'),{url:'http://127.0.0.1:4317/',runScripts:'outside-only'});
const {window}=dom;
Object.defineProperty(window.crypto,'randomUUID',{value:randomUUID});
const commands=[];
window.fetch=async(url,options)=>{
  try{
    if(new URL(url,window.location.href).pathname==='/api/state')return {ok:true,status:200,json:async()=>repo.state()};
    if(new URL(url,window.location.href).pathname==='/api/suppliers')return {ok:true,status:200,json:async()=>repo.supplierDetail({...Object.fromEntries(new URL(url,window.location.href).searchParams),limit:50})};
    if(new URL(url,window.location.href).pathname==='/api/command'){
      const envelope=JSON.parse(options.body);commands.push(envelope);const result=repo.execute(envelope);
      return {ok:true,status:200,json:async()=>result};
    }
    throw Error('Unexpected test route');
  }catch(error){return {ok:false,status:400,json:async()=>({error:error.message})};}
};
window.__supplierModule=supplierModule;
window.eval(readFileSync(new URL('../public/app.js',import.meta.url),'utf8').replace("import(\'./suppliers.js\')","Promise.resolve(window.__supplierModule)")+'\nwindow.__ui={setView};');
await new Promise(resolve=>setTimeout(resolve,0));
window.__ui.setView('transaction');
const document=window.document;
const purchaseTab=document.querySelector('[data-tab="purchase"]');
assert.ok(purchaseTab,'Purchase tab must exist');
purchaseTab.click();
assert.equal(document.querySelector('#f-source'),null,'Customer purchase cannot switch to supplier operations');
assert.ok(document.querySelector('#f-counterpartyId'),'Customer purchase exposes the payee');
assert.equal(document.querySelector('[data-add-allocation="payment"][data-payment-type="pos"]'),null,'Purchase must not present incoming POS as payment');
window.__ui.setView('suppliers');
const tick=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setTimeout(resolve,0));};
await tick();document.querySelector('[data-open-firm]').click();document.querySelector('[data-supplier-task="purchase"]').click();await tick();
const fill=(selector,value,event='input')=>{const e=document.querySelector(selector);assert.ok(e,selector);e.value=value;e.dispatchEvent(new window.Event(event,{bubbles:true}));};
const native=(group,key,value,index=0)=>{const e=document.querySelectorAll(`[data-group="${group}"] [data-row]`)[index].querySelector(`[data-field="${key}"]`);e.value=value;e.dispatchEvent(new window.Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));};
native('items','accountId','bilezikAdet');native('items','quantity','1');native('items','weight','20.22');native('items','referenceTL','10000');
native('charges','accountId',supplier);native('charges','quantity','10000');
for(const [index,id,amount]of [[0,'nakit','3000'],[1,'banka','2000']]){document.querySelector('[data-group="given"] [data-add-row]').click();native('given','accountId',id,index);native('given','quantity',amount,index);}
const fillRow=(kind,index,key,value,event='input')=>{const e=document.querySelectorAll(`[data-allocation-kind="${kind}"]`)[index].querySelector(`[data-allocation-field="${key}"]`);e.value=value;e.dispatchEvent(new window.Event(event,{bubbles:true}));};
document.querySelector('[data-group="credits"] [data-add-row]').click();native('credits','accountId',supplier);native('credits','quantity','5000');
fill('[data-supplier-form] [name="note"]','Örnek alış: 1 bilezik ve ödeme/borç birlikte');
assert.match(document.querySelector('[data-supplier-preview]').textContent,/Borcumuz 5\.000,00 TL/);
assert.equal(document.querySelector('img'),null,'Counterparty name must stay escaped text');
document.querySelector('[data-supplier-form]').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
await tick();
assert.equal(repo.state().journal.at(-1).type,'supplierPurchase',document.querySelector('#notice').textContent);
assert.equal(repo.state().balances.bilezikAdet,101);
assert.equal(repo.state().balances.bilezik22,1225220);
assert.equal(repo.state().balances.nakit,700000);
assert.equal(repo.state().balances.banka,800000);
assert.equal(repo.state().balances[supplier],-500000);
assert.equal(commands.at(-1).command.supplierId,firm);
window.__ui.setView('journal');
assert.match(document.querySelector('#main').textContent,/alış|Alış/);
assert.equal(repo.state().journal.at(-1).meta.chargeLines[0].quantity,1000000,'Gross charge remains separate from payments');
// Native supplier history owns the reversal UI; retain the complete financial
// inverse assertion here without looking for the retired generic reverse form.
const reverseCommand={type:'supplierReverse',date:repo.state().date,originalId:repo.state().journal.at(-1).id,note:'Sentetik tam ters etki kontrolü'};
const reversed=applyEvent(repo.state(),{id:randomUUID(),schemaVersion:eventVersion(reverseCommand,repo.state()),command:reverseCommand});
assert.equal(reversed.balances.bilezikAdet,100);assert.equal(reversed.balances.bilezik22,1205000);
assert.equal(reversed.balances.nakit,1000000);assert.equal(reversed.balances.banka,1000000);assert.equal(reversed.balances[supplier],0);
window.__ui.setView('transaction');
document.querySelector('[data-tab="purchase"]').click();
fill('[data-item-field="accountId"]','gramToplam','change');
assert.match(document.querySelector('[data-item-field="quantity"]').previousElementSibling.textContent,/gr/);
fill('[data-item-field="quantity"]','10');
fill('[data-item-field="value"]','100');document.querySelector('[data-payment-type="cash"]').click();fillRow('payment',0,'quantity','200');
assert.ok(document.querySelector('#sale-equation').classList.contains('error'),'Overpayment must be visibly invalid');
console.log('PASS: UI purchase flow, linked quantities, cash/bank/debt, XSS escaping, nominal units and overpayment preview.');
repo.close();dom.window.close();
