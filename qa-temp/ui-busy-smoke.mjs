import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadJSDOM } from '../test-support/jsdom.mjs';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS } from '../domain.mjs';

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
window.fetch=async(url,options)=>{
  try{
    if(new URL(url,window.location.href).pathname==='/api/state')return {ok:true,status:200,json:async()=>repo.state()};
    if(new URL(url,window.location.href).pathname==='/api/journal'){const u=new URL(url,window.location.href);return {ok:true,status:200,json:async()=>repo.journalPage({...Object.fromEntries(u.searchParams),limit:Number(u.searchParams.get('limit'))})};}
    if(new URL(url,window.location.href).pathname==='/api/command'){
      const envelope=JSON.parse(options.body);commands.push(envelope);const result=repo.execute(envelope);
      return {ok:true,status:200,json:async()=>result};
    }
    throw Error('Unexpected test route');
  }catch(error){return {ok:false,status:400,json:async()=>({error:error.message})};}
};
window.eval(readFileSync(new URL('../public/app.js',import.meta.url),'utf8')+'\nwindow.__ui={setView,setBusy,submit};');
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));await tick();
const select=window.document.querySelector('#workspace');
const checkEnabled=()=>{assert.equal(select.disabled,false);assert.equal(select.matches(':disabled'),false);assert.deepEqual([...select.options].map(option=>option.disabled),[false,false]);assert.equal(select.outerHTML.includes('disabled'),false);};
checkEnabled();
window.document.querySelector('#refresh').click();await tick();checkEnabled();
window.__ui.setBusy(true);assert.equal(select.disabled,true);window.__ui.setBusy(true);window.__ui.setBusy(false);checkEnabled();
select.value='dukkan';select.dispatchEvent(new window.Event('change',{bubbles:true}));await tick();checkEnabled();
assert.equal(select.value,'dukkan');
window.__ui.setView('transaction');window.document.querySelector('[data-tab="purchase"]').click();
const remove=window.document.querySelector('[data-remove-item]');assert.equal(remove.disabled,true);window.__ui.setBusy(true);window.__ui.setBusy(false);assert.equal(remove.disabled,true);checkEnabled();
console.log('PASS: Workspace select/options enabled after initial load, refresh, repeated busy, workspace change; initially disabled row removal remains disabled.');const originalFetch=window.fetch;
const retryBar=window.document.querySelector('#retry-bar'),retry=window.document.querySelector('#retry');
const movement={type:'movement',accountId:'nakit',direction:'in',category:'Sermaye',quantity:'1',note:'Synthetic pending status'};
let complete;
window.fetch=(url,options)=>new URL(url,window.location.href).pathname==='/api/command'?new Promise((resolve,reject)=>{complete={resolve,reject,url,options};}):originalFetch(url,options);
const saving=window.__ui.submit(movement);
assert.equal(retryBar.hidden,false);
assert.equal(retry.disabled,true);
assert.match(retryBar.textContent,/İşlem kaydediliyor/);
assert.doesNotMatch(retryBar.textContent,/doğrulanamadı/);
complete.resolve(await originalFetch(complete.url,complete.options));await saving;
assert.equal(retryBar.hidden,true);
const uncertain=window.__ui.submit(movement);
assert.match(retryBar.textContent,/İşlem kaydediliyor/);
const originalEnvelope=JSON.parse(complete.options.body);
complete.reject(Error('Synthetic disconnected transport'));await uncertain;
assert.equal(retryBar.hidden,false);assert.equal(retry.disabled,false);
assert.match(retryBar.textContent,/Son isteğin sonucu doğrulanamadı/);
retry.click();
assert.match(retryBar.textContent,/sorgulanıyor/);await tick();
assert.match(retryBar.textContent,/İşlem kaydediliyor/);assert.equal(retry.disabled,true);
assert.deepEqual(JSON.parse(complete.options.body),originalEnvelope);
complete.resolve(await originalFetch(complete.url,complete.options));await tick();
assert.equal(retryBar.hidden,true);
console.log('PASS: In-flight writes show saving, uncertain responses show safe retry, and retries preserve identity.');
repo.close();window.close();
