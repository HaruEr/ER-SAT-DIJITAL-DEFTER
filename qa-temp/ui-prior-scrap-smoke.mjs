import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadJSDOM } from '../test-support/jsdom.mjs';
import { INITIAL_ACCOUNTS } from '../domain.mjs';
import { Repository } from '../repository.mjs';

test('owner finds the prior purchase on a named sale and the customer journal shows the trace only once',async t=>{
  const repo=new Repository(':memory:','demo'),date='2026-11-10';
  const run=(id,c)=>repo.execute({id,revision:repo.state().revision,command:{date,...c}});
  const balances=Object.fromEntries(INITIAL_ACCOUNTS.filter(a=>!a.retired).map(a=>[a.id,'0']));
  Object.assign(balances,{nakit:'500',ceyrek:'2'});run('open',{type:'opening',balances});
  run('ayse',{type:'account',name:'Ayşe',partyType:'customer',unit:'TL',opening:'0'});
  const common={counterpartyId:'cari-ayse',counterpartyType:'customer',credits:[],debts:[]};
  run('hurda',{...common,type:'purchase',source:'customer',items:[{accountId:'hurda14',quantity:'2',value:'400'}],given:[{accountId:'nakit',quantity:'400',valueTL:'400'}],received:[]});
  run('satis',{...common,type:'sale',items:[{accountId:'ceyrek',quantity:'1',value:'610'}],received:[{accountId:'nakit',quantity:'610',valueTL:'610'}],given:[]});
  const before=repo.state(),JSDOM=await loadJSDOM();
  const dom=new JSDOM(readFileSync(new URL('../public/index.html',import.meta.url),'utf8'),{url:'http://127.0.0.1:4317/owner',runScripts:'outside-only'});
  const {window}=dom,{document}=window,get=s=>document.querySelector(s),tick=()=>new Promise(resolve=>setTimeout(resolve,10));
  t.after(()=>{window.close();repo.close();});
  Object.defineProperty(window.crypto,'randomUUID',{value:randomUUID});
  const calls=[];let stale=true;
  window.fetch=async(url,opts={})=>{
    const u=new URL(url,window.location.href),q=Object.fromEntries(u.searchParams);
    let body;
    if(u.pathname==='/api/state')body=repo.state({compact:true});
    else if(u.pathname==='/api/command'){const e=JSON.parse(opts.body);calls.push(e.command);body=repo.execute(e,{compact:true});}
    else if(u.pathname==='/api/journal'){
      body=repo.journalPage({...q,limit:Number(q.limit||50)});
      if(stale && q.scrapForSale)body.revision--;
    }else throw Error('Unexpected test route '+u.pathname);
    return {ok:true,json:async()=>body};
  };
  window.eval(readFileSync(new URL('../public/app.js',import.meta.url),'utf8'));
  await tick();get('[data-view="journal"]').click();await tick();
  const panel=get('[data-scrap-link]');
  assert.ok(panel,'named customer sale offers prior scrap linkage');
  panel.querySelector('summary').click();await tick();
  assert.equal(panel.querySelector('[data-link-purchase]').disabled,true);
  assert.match(panel.textContent,/yenile/i);
  stale=false;panel.querySelector('summary').click();await tick();panel.querySelector('summary').click();await tick();
  const select=panel.querySelector('select');
  assert.equal(select.value,'');
  assert.match(select.options[1].textContent,/14 AYAR HURDA/);
  assert.match(select.options[1].textContent,/2,000 gr/);
  select.value='hurda';select.dispatchEvent(new window.Event('change',{bubbles:true}));
  panel.querySelector('[data-link-purchase]').click();await tick();await tick();
  assert.equal(calls.length,1);
  assert.deepEqual(calls[0],{type:'linkScrapPurchase',saleId:'satis',purchaseId:'hurda',date});
  assert.deepEqual(repo.state().balances,before.balances);
  assert.match(document.body.textContent,/Önceki hurda alışı satışa bağlandı/);
  assert.match(document.body.textContent,/Hurda alışı.*hurda/);
  const afterPanel=get('[data-scrap-link]');afterPanel.querySelector('summary').click();await tick();
  assert.equal(afterPanel.querySelector('[data-link-purchase]').disabled,true);
  assert.equal(afterPanel.querySelector('select').options.length,1);
});
