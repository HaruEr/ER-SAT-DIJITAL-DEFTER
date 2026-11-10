import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {loadJSDOM} from '../test-support/jsdom.mjs';
import {Repository} from '../repository.mjs';
import {INITIAL_ACCOUNTS} from '../domain.mjs';
const JSDOM=await loadJSDOM(),tick=()=>new Promise(r=>setTimeout(r,0));
async function fixture(t,committed=true){
 const repo=new Repository();repo.execute({id:randomUUID(),revision:0,command:{type:'opening',date:'2026-11-10',balances:Object.fromEntries(INITIAL_ACCOUNTS.filter(a=>!a.retired).map(a=>[a.id,'0']))}});
 const dom=new JSDOM(readFileSync(new URL('../public/index.html',import.meta.url),'utf8'),{url:'http://127.0.0.1/',runScripts:'outside-only'}),w=dom.window,calls=[];
 Object.defineProperty(w.crypto,'randomUUID',{value:randomUUID});let first=true,lookupFails=false;
 w.fetch=async(url,options)=>{const u=new URL(url,w.location.href);calls.push({path:u.pathname,body:options?.body});let data;
   if(u.pathname==='/api/state')data=repo.state({compact:true});
   else if(u.pathname==='/api/journal'){if(lookupFails)throw TypeError('Failed to fetch');data=repo.journalPage({...Object.fromEntries(u.searchParams),limit:Number(u.searchParams.get('limit'))});}
   else if(u.pathname==='/api/command'){if(first){first=false;if(committed)repo.execute(JSON.parse(options.body));throw TypeError('Failed to fetch');}data=repo.execute(JSON.parse(options.body));}
   else throw Error('unexpected route '+u.pathname);
   return {ok:true,status:200,json:async()=>data};};
 w.eval(readFileSync(new URL('../public/app.js',import.meta.url),'utf8')+'\nwindow.__test={submit,refresh};');await tick();
 t.after(()=>{repo.close();w.close();});
 await w.__test.submit({type:'movement',accountId:'nakit',direction:'in',category:'Sermaye',quantity:'2',note:'lost response'});
 return {w,repo,calls,failLookup:()=>{lookupFails=true;}};
}
test('committed lost response is queried and completed without a second POST',async t=>{
 const f=await fixture(t);f.w.document.querySelector('#retry').click();await tick();await tick();
 assert.equal(f.calls.filter(c=>c.path==='/api/command').length,1);assert.ok(f.calls.some(c=>c.path==='/api/journal'));assert.equal(f.w.document.querySelector('#retry-bar').hidden,true);assert.equal(f.repo.state().balances.nakit,200);
});
test('known absent record is queried before same-key POST',async t=>{
 const f=await fixture(t,false);f.w.document.querySelector('#retry').click();await tick();await tick();
 const posts=f.calls.filter(c=>c.path==='/api/command');assert.equal(posts.length,2);assert.equal(posts[0].body,posts[1].body);assert.ok(f.calls.findIndex(c=>c.path==='/api/journal')<f.calls.lastIndexOf(posts[1]));assert.equal(f.repo.state().balances.nakit,200);
});
test('failed lookup keeps uncertain envelope and never resends',async t=>{
 const f=await fixture(t);f.failLookup();f.w.document.querySelector('#retry').click();await tick();await tick();assert.equal(f.calls.filter(c=>c.path==='/api/command').length,1);assert.equal(f.w.document.querySelector('#retry-bar').hidden,false);assert.ok(f.w.sessionStorage.getItem('defter-pending-demo'));
});
test('manual refresh reconciles committed ID without retrying mutation',async t=>{
 const f=await fixture(t);await f.w.__test.refresh();assert.equal(f.calls.filter(c=>c.path==='/api/command').length,1);assert.ok(f.calls.some(c=>c.path==='/api/journal'));assert.equal(f.w.document.querySelector('#retry-bar').hidden,true);
});
for(const mode of ['denied','revision','actor'])test(mode+' lookup preserves pending and cannot resend',async t=>{
 const f=await fixture(t),original=f.w.fetch;
 if(mode==='actor')f.w.DefterSession={current:()=>({token:'synthetic',actor:{id:'different-owner'}})};
 f.w.fetch=async(url,options)=>{const path=new URL(url,f.w.location.href).pathname;if(mode==='denied'&&path==='/api/journal')return {ok:false,status:403,json:async()=>({error:'Erişim reddedildi'})};const response=await original(url,options);if(mode==='revision'&&path==='/api/state'){const state=await response.json();return {...response,json:async()=>({...state,revision:state.revision+1})};}return response;};
 f.w.document.querySelector('#retry').click();await tick();await tick();assert.equal(f.calls.filter(c=>c.path==='/api/command').length,1);assert.equal(f.w.document.querySelector('#retry-bar').hidden,false);assert.ok(f.w.sessionStorage.getItem('defter-pending-demo'));
});
test('refresh of absent pending ID performs no write',async t=>{
 const f=await fixture(t,false);await f.w.__test.refresh();assert.equal(f.calls.filter(c=>c.path==='/api/command').length,1);assert.equal(f.w.document.querySelector('#retry-bar').hidden,false);assert.equal(f.repo.state().balances.nakit,0);
});
