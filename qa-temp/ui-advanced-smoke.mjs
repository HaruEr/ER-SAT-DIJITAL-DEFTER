import * as supplierModule from '../public/suppliers.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadJSDOM } from '../test-support/jsdom.mjs';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS, workdaySummary, decimal } from '../domain.mjs';

const JSDOM = await loadJSDOM();
const repo = new Repository();
const run = command => repo.execute({id:randomUUID(),revision:repo.state().revision,command});
const opening = Object.fromEntries(INITIAL_ACCOUNTS.filter(a=>!a.retired).map(a=>[a.id,'0']));
Object.assign(opening,{nakit:'10000',banka:'10000',bilezikAdet:'100',bilezik22:'1205',gramToplam:'243'});
run({type:'opening',date:'2026-10-27',balances:opening});
const counterpartyId=randomUUID();
repo.execute({id:counterpartyId,revision:repo.state().revision,command:{type:'account',date:repo.state().date,name:'Örnek tedarikçi <img src=x>',unit:'TL',opening:'0'}});
const supplier='cari-'+counterpartyId;
const dom=new JSDOM(readFileSync(new URL('../public/index.html',import.meta.url),'utf8'),{url:'http://127.0.0.1:4317/',runScripts:'outside-only'});
const {window}=dom;
Object.defineProperty(window.crypto,'randomUUID',{value:randomUUID});
const commands=[];
let uncertain=false;
window.fetch=async(url,options)=>{
  try{
    if(new URL(url,window.location.href).pathname==='/api/summary')return {ok:true,status:200,json:async()=>workdaySummary(repo.state(),new URL(url,window.location.href).searchParams.get('date'))};
    if(new URL(url,window.location.href).pathname==='/api/state')return {ok:true,status:200,json:async()=>repo.state()};
    if(new URL(url,window.location.href).pathname==='/api/journal'){const query=new URL(url,window.location.href).searchParams;return {ok:true,status:200,json:async()=>repo.journalPage({...Object.fromEntries(query),limit:Number(query.get('limit')||50)})};}
    if(new URL(url,window.location.href).pathname==='/api/suppliers')return {ok:true,status:200,json:async()=>repo.supplierDetail({...Object.fromEntries(new URL(url,window.location.href).searchParams),limit:50})};
    if(new URL(url,window.location.href).pathname==='/api/command'){
      const envelope=JSON.parse(options.body);commands.push(envelope);const result=repo.execute(envelope);
      if(uncertain){uncertain=false;return {ok:false,status:500,json:async()=>({error:'Simulated lost response after commit'})};}
      return {ok:true,status:200,json:async()=>result};
    }
    throw Error('Unexpected test route');
  }catch(error){return {ok:false,status:400,json:async()=>({error:error.message})};}
};
window.__supplierModule=supplierModule;
window.eval(readFileSync(new URL('../public/app.js',import.meta.url),'utf8').replace("import(\'./suppliers.js\')","Promise.resolve(window.__supplierModule)")+'\nwindow.__ui={setView,beginTransactionEdit};');
const tick=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setTimeout(resolve,0));};
await tick();
const document=window.document;
const fill=(selector,value,event='input')=>{const e=document.querySelector(selector);assert.ok(e,selector);e.value=value;e.dispatchEvent(new window.Event(event,{bubbles:true}));};
const tab=name=>{if(['transfer','settlement'].includes(name)){window.__ui.setView('banks');document.querySelector(`[data-bank-action="${name}"]`).click();}else{window.__ui.setView('transaction');document.querySelector(`[data-tab="${name}"]`).click();}};
const openFund=()=>{window.__ui.setView('banks');if(!document.querySelector('#bank-form'))document.querySelector('#add-bank').click();};
const openCari=()=>{window.__ui.setView('accounts');document.querySelector('#add-account').click();};
const send=async(selector)=>{document.querySelector(selector).dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await tick();};
const allocation=(kind,index,key,value,event='input')=>{const e=document.querySelectorAll(`[data-allocation-kind="${kind}"]`)[index].querySelector(`[data-allocation-field="${key}"]`);e.value=value;e.dispatchEvent(new window.Event(event,{bubbles:true}));};
openFund();assert.ok(![...document.querySelector('#f-unit').options].some(o=>o.value==='HAS'));repo.execute({id:randomUUID(),revision:repo.state().revision,command:{type:'fundAccount',date:repo.state().date,name:'Has kasa',unit:'HAS',physical:true,opening:'10'}});document.querySelector('#refresh').click();await tick();
const hasFund=repo.state().accounts.find(a=>a.name==='Has kasa');assert.equal(hasFund.unit,'HAS');assert.equal(hasFund.countPolicy,'periodic');
openFund();fill('#f-name','GBP banka');fill('#f-unit','other','change');fill('#f-currencyCode','gbp');fill('#f-physical','false','change');fill('#f-opening','50');await send('#bank-form');
const gbpFund=repo.state().accounts.find(a=>a.name==='GBP banka');assert.equal(gbpFund.unit,'GBP');assert.equal(gbpFund.countPolicy,'none');
openCari();fill('#f-name','Has müşteri');fill('#f-unit','HAS','change');fill('#f-opening','0');await send('#account-form');
const hasCari=repo.state().accounts.find(a=>a.name==='Has müşteri');
openCari();fill('#f-name','Dolar tedarikçi');fill('#f-unit','USD','change');fill('#f-opening','0');await send('#account-form');
const usdCari=repo.state().accounts.find(a=>a.name==='Dolar tedarikçi');
openCari();fill('#f-name','Euro tedarikçi');fill('#f-unit','EUR','change');fill('#f-opening','0');await send('#account-form');
const eurCari=repo.state().accounts.find(a=>a.name==='Euro tedarikçi');
// Historical multi-cari purchase remains editable; new v6 single-party UI is covered separately.
repo.execute({id:randomUUID(),revision:repo.state().revision,command:{type:'purchase',date:repo.state().date,source:'customer',items:[{accountId:'gramToplam',quantity:'10',value:'1500'}],payments:[{accountId:hasFund.id,quantity:'0.250',valueTL:'500'}],debts:[{accountId:hasCari.id,quantity:'0.125',valueTL:'500'},{accountId:usdCari.id,quantity:'10',valueTL:'300'},{accountId:eurCari.id,quantity:'5',valueTL:'200'}],note:'Eski çok birimli alış'}});
const legacyPurchase=repo.state().journal.at(-1);document.querySelector('#refresh').click();await tick();window.__ui.beginTransactionEdit(legacyPurchase);await tick();
assert.equal(document.querySelectorAll('[data-allocation-kind="debt"]').length,3);assert.equal(document.querySelector('[data-add-allocation="counterpayment"]').disabled,true);fill('#amend-reason','Eski kaydı kontrol');fill('#f-note','Çok birimli alış');
assert.equal(document.querySelector('#sale-remainder').textContent,'Tam dengeli');document.querySelector('#add-sale-item').click();assert.equal(document.querySelector('[data-item-field="quantity"]').value,'10');document.querySelectorAll('[data-remove-item]')[1].click();
await send('#sale-form');assert.equal(commands.at(-1).command.type,'amend');assert.equal(commands.at(-1).command.replacement.received,undefined);assert.equal(commands.at(-1).command.replacement.debts.length,3);assert.equal(repo.state().journal.at(-1).meta.amendsOriginalId,legacyPurchase.id,document.querySelector('#notice').textContent);assert.equal(repo.state().balances.gramToplam,253000);assert.equal(repo.state().balances[hasFund.id],9750);assert.equal(repo.state().balances[hasCari.id],-125);assert.equal(repo.state().balances[usdCari.id],-1000);assert.equal(repo.state().balances[eurCari.id],-500);

tab('collection');fill('#f-customerAccount',hasCari.id,'change');assert.equal(document.querySelector('#f-target').options.length,1);assert.equal(document.querySelector('#f-target').value,hasFund.id);fill('#f-direction','pay','change');fill('#f-quantity','0.125');fill('#f-note','Has borç kapama');await send('#collection-form');assert.equal(repo.state().balances[hasCari.id],0);assert.equal(repo.state().balances[hasFund.id],9625);
tab('transfer');fill('#f-fromAccount','nakit','change');fill('#f-toAccount','banka','change');fill('#f-quantity','100');fill('#f-note','Kasa bankaya');await send('#transfer-form');assert.equal(repo.state().balances.nakit,990000);assert.equal(repo.state().balances.banka,1010000);
tab('sale');fill('[data-item-field="accountId"]','gramToplam','change');fill('[data-item-field="quantity"]','10');fill('[data-item-field="value"]','200');document.querySelector('[data-payment-type="foreign"]').click();allocation('payment',0,'accountId',gbpFund.id,'change');allocation('payment',0,'quantity','2');allocation('payment',0,'valueTL','200');fill('#f-note','GBP tahsilatlı gram satış');uncertain=true;await send('#sale-form');
assert.equal(repo.state().balances.gramToplam,243000);assert.equal(repo.state().balances[gbpFund.id],5200);assert.equal(document.querySelector('#retry-bar').hidden,false,'5xx must retain pending ID');
const uncertainId=commands.at(-1).id;document.querySelector('#retry').click();await tick();assert.equal(commands.at(-1).id,uncertainId);assert.equal(repo.state().balances[gbpFund.id],5200,'Retry cannot duplicate committed sale');assert.equal(document.querySelector('#retry-bar').hidden,true);
window.__ui.setView('summary');await tick();assert.match(document.querySelector('#summary-result').textContent,/GBP banka/);assert.match(document.querySelector('#summary-result').textContent,/1\.500,00 TL/);
window.__ui.setView('journal');assert.equal(document.querySelector('img'),null);assert.match(document.querySelector('#main').textContent,/0,125 has gr/);assert.match(document.querySelector('#main').textContent,/Anlaşılmış TL karşılığı/);
// CASH-OTHER01: one physical cash fund per explicit currency, never a mixed balance.
const otherFunds={};
for(const code of ['SAR','AED']){
 window.__ui.setView('banks');const add=document.querySelector('#add-other-cash');assert.ok(add,'Nakit Diğer entry point');add.click();
 assert.equal(document.querySelector('#f-unit').value,'other');assert.equal(document.querySelector('#f-physical').value,'true');assert.equal(document.querySelector('#f-currencyCode').required,true);
 const before=commands.length;await send('#bank-form');assert.equal(commands.length,before,'blank currency cannot create account');
 fill('#f-currencyCode',code.toLowerCase());assert.equal(document.querySelector('#f-name').value,`Nakit Diğer (${code})`);await send('#bank-form');
 const fund=repo.state().accounts.find(a=>a.name===`Nakit Diğer (${code})`);assert.ok(fund);assert.equal(fund.unit,code);assert.equal(fund.physical,true);assert.equal(fund.countPolicy,'daily');otherFunds[code]=fund;
 assert.ok(document.querySelector(`[data-bank-rename="${fund.id}"]`),'physical cash remains discoverable');
}
assert.notEqual(otherFunds.SAR.id,otherFunds.AED.id);
window.__ui.setView('banks');document.querySelector(`[data-bank-rename="${otherFunds.SAR.id}"]`).click();fill('#f-name','Nakit Diğer SAR kasa');await send('#bank-rename-form');assert.equal(repo.state().accounts.find(a=>a.id===otherFunds.SAR.id).unit,'SAR');
window.__ui.setView('closing');const countState=repo.state();
for(const control of document.querySelectorAll('#close-form [data-measure]')){const a=countState.accounts.find(a=>a.id===control.dataset.measure);fill('#'+control.id,decimal(countState.balances[a.id],a.unit));}
fill('#f-dailyApprovedBy','Sentetik sayım');fill('#daily-count-'+otherFunds.SAR.id,'');const beforeClose=commands.length;document.querySelector('#close-form').requestSubmit();await tick();assert.equal(commands.length,beforeClose,'blank SAR daily count rejects close');
fill('#daily-count-'+otherFunds.SAR.id,'0');assert.equal(document.querySelector('#daily-count-'+otherFunds.AED.id).value,'0.00');await send('#close-form');assert.equal(commands.at(-1).command.type,'close');assert.equal(repo.state().balances[otherFunds.SAR.id],0);assert.equal(repo.state().balances[otherFunds.AED.id],0);
for(const [code,quantity] of [['SAR','1000'],['AED','500']])run({type:'movement',date:repo.state().date,accountId:otherFunds[code].id,direction:'in',category:'Sermaye',quantity,note:'Sentetik döviz açılış desteği'});
document.querySelector('#refresh').click();await tick();window.__ui.setView('suppliers');await tick();document.querySelector('[data-create-firm]').click();fill('[data-supplier-form] [name="name"]','SAR Firma');await send('[data-supplier-form]');
const sarFirm=repo.state().supplierFirms.find(a=>a.name==='SAR Firma');assert.ok(sarFirm);
document.querySelector('[data-open-firm="'+sarFirm.id+'"]').click();document.querySelector('[data-add-supplier-unit]').click();fill('[data-supplier-form] [name="unit"]','other','change');fill('[data-supplier-form] [name="currencyCode"]','SAR');await send('[data-supplier-form]');
const sarSupplier=repo.state().accounts.find(a=>a.supplierId===sarFirm.id);assert.equal(sarSupplier.unit,'SAR');assert.equal(sarSupplier.partyType,'supplier');
// Establish real unpaid native purchase rather than invent an opening balance on a new firm.
run({type:'supplierPurchase',date:repo.state().date,supplierId:sarFirm.id,items:[{accountId:'gramToplam',quantity:'1'}],charges:[{accountId:sarSupplier.id,quantity:'100'}]});document.querySelector('#refresh').click();await tick();
const native=(group,index,key,value)=>{const e=document.querySelectorAll('[data-group="'+group+'"] [data-row]')[index].querySelector('[data-field="'+key+'"]');assert.ok(e);e.value=value;e.dispatchEvent(new window.Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));};
document.querySelector('[data-supplier-task="payment"]').click();await tick();native('given',0,'accountId',otherFunds.SAR.id);native('given',0,'quantity','40');assert.equal(document.querySelector('[data-group="given"] [data-field="referenceTL"]').value,'');native('given',0,'referenceTL','400');native('credits',0,'accountId',sarSupplier.id);native('credits',0,'quantity','40');
assert.match(document.querySelector('[data-supplier-preview]').textContent,/40 SAR/);assert.match(document.querySelector('[data-supplier-preview]').textContent,/TL referansı 400/);await send('[data-supplier-form]');assert.equal(repo.state().balances[otherFunds.SAR.id],96000);assert.equal(repo.state().balances[otherFunds.AED.id],50000);assert.equal(repo.state().balances[sarSupplier.id],-6000);assert.equal(repo.state().journal.at(-1).meta.revenue||0,0);
document.querySelector('[data-supplier-task="purchase"]').click();await tick();native('items',0,'accountId','ceyrek');native('items',0,'quantity','1');native('items',0,'referenceTL','3000');native('charges',0,'accountId',sarSupplier.id);native('charges',0,'quantity','300');
for(const [index,code,value]of [[0,'SAR','1000'],[1,'AED','2000']]){document.querySelector('[data-group="given"] [data-add-row]').click();native('given',index,'accountId',otherFunds[code].id);native('given',index,'quantity','100');native('given',index,'referenceTL',value);}
document.querySelector('[data-group="credits"] [data-add-row]').click();native('credits',0,'accountId',sarSupplier.id);native('credits',0,'quantity','300');assert.match(document.querySelector('[data-supplier-preview]').textContent,/100 SAR/);assert.match(document.querySelector('[data-supplier-preview]').textContent,/100 AED/);await send('[data-supplier-form]');assert.equal(repo.state().balances[otherFunds.SAR.id],86000);assert.equal(repo.state().balances[otherFunds.AED.id],40000);assert.equal(repo.state().balances[sarSupplier.id],-6000);assert.equal(repo.state().balances.ceyrek,1);
window.__ui.setView('closing');assert.match(document.querySelector('#daily-expected-'+otherFunds.SAR.id).textContent,/860,00 SAR/);assert.match(document.querySelector('#daily-expected-'+otherFunds.AED.id).textContent,/400,00 AED/);
const restored=new Repository();try{restored.restore({backup:repo.backup(),revision:0,confirmation:'GERİ YÜKLE'});assert.equal(restored.state().balances[otherFunds.SAR.id],86000);assert.equal(restored.state().balances[otherFunds.AED.id],40000);assert.equal(restored.state().accounts.find(a=>a.id===sarSupplier.id).unit,'SAR');}finally{restored.close();}
console.log('PASS: Nakit Diğer SAR/AED creation, discovery/rename, zero/blank daily counts, supplier native currency and manual TL collection/purchase, JSON restore/replay.');
console.log('PASS: Fund/cari creation, multi-unit purchase, draft preservation, HAS collection, transfer, multi-unit sale, committed HTTP500 same-ID retry, day summary, escaped journal.');repo.close();window.close();
