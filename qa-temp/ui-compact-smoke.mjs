import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadJSDOM } from '../test-support/jsdom.mjs';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS, decimal } from '../domain.mjs';

const JSDOM=await loadJSDOM(),html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8'),source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const cases=[];const check=(name,run)=>cases.push({name,run});
async function fixture(){
  const repo=new Repository(':memory:','demo'),other=new Repository(':memory:','dukkan');
  const run=(id,command)=>repo.execute({id,revision:repo.state().revision,command});
  const balances=Object.fromEntries(INITIAL_ACCOUNTS.filter(account=>!account.retired).map(account=>[account.id,'0']));Object.assign(balances,{nakit:'10000',gramToplam:'100'});
  run('opening',{type:'opening',date:'2026-10-20',balances});
  for(let i=0;i<2;i++){
    run('stocktake-'+i,{type:'stocktake',date:repo.state().date,counts:{taki14:'0'},reasons:{},approvedBy:'Test'});
    const state=repo.state();run('close-'+i,{type:'close',date:state.date,counts:Object.fromEntries(state.accounts.filter(account=>account.physical&&!account.retired&&account.countPolicy==='daily').map(account=>[account.id,decimal(state.balances[account.id]||0,account.unit)])),reasons:{},approvedBy:'Test'});
  }
  const date=repo.state().date;
  run('early-sale',{type:'sale',date,items:[{accountId:'gramToplam',quantity:'1',value:'500'}],cash:'500',bank:'0',pos:'0',scrapQuantity:'0',scrapValue:'0',note:'Son dört kayıtta olmayan satış'});
  run('early-expense',{type:'movement',date,accountId:'nakit',category:'Gider',direction:'out',quantity:'2',note:'Son dört kayıtta olmayan gider'});
  for(let i=0;i<38;i++)run('movement-'+i,{type:'movement',date,accountId:'nakit',category:'Sermaye',direction:'in',quantity:'1',note:i===0?'Satır bir':i===1?'Satır iki':'Hareket '+i});
  run('original',{type:'movement',date,accountId:'nakit',category:'Sermaye',direction:'in',quantity:'1',note:'Hedef <img src=x>'});
  run('reverse-original',{type:'reverse',date,originalId:'original',note:'Global ters kayıt'});
  for(let i=0;i<4;i++)run('recent-'+i,{type:'movement',date,accountId:'nakit',category:'Sermaye',direction:'in',quantity:'1',note:'Son hareket '+i});
  function compact(reader=repo){
    const full=reader.state(),today=full.journal.filter(event=>event.date===full.date),originals=new Map(full.journal.map(event=>[event.id,event]));
    const sales=today.filter(event=>event.type==='sale'||event.type==='reverse'&&originals.get(event.meta.originalId)?.type==='sale');
    return {...full,view:'compact',journal:full.journal.slice(-4),overview:{todaysCount:today.length,revenue:today.reduce((n,e)=>n+(e.meta.revenue||0),0),expenses:today.reduce((n,e)=>n+(e.meta.expense||0),0),salesCash:sales.flatMap(e=>e.entries).filter(entry=>entry.accountId==='nakit').reduce((n,e)=>n+e.delta,0),closingCount:full.closings.length},journalMeta:{total:full.journal.length,totalEntries:full.journal.reduce((n,e)=>n+e.entries.length,0)}};
  }
  const dom=new JSDOM(html,{url:'http://127.0.0.1:4317/',runScripts:'outside-only'}),{window}=dom,document=window.document;
  Object.defineProperty(window.crypto,'randomUUID',{value:randomUUID});
  const controller={delays:new Map(),overlap:false,native:false},calls=[];
  window.fetch=async(url,options)=>{
    const selected=new URL(url,window.location.href),route=selected.pathname,reader=selected.searchParams.get('workspace')==='dukkan'?other:repo;calls.push(selected);
    const ok=value=>({ok:true,status:200,json:async()=>value});
    try{
      if(route==='/api/state')return ok(controller.native?reader.state({compact:true}):compact(reader));
      if(route==='/api/command'){const result=reader.execute(JSON.parse(options.body),controller.native?{compact:true}:undefined);return ok({...result,state:controller.native?result.state:compact(reader)});}
      if(route==='/api/restore'){reader.restore(JSON.parse(options.body),controller.native?{compact:true}:undefined);return ok({state:controller.native?reader.state({compact:true}):compact(reader)});}
      assert.equal(route,'/api/journal');
      const params=Object.fromEntries(selected.searchParams);delete params.workspace;
      if(controller.native)return ok(reader.journalPage({...params,limit:Number(params.limit||25)}));
      const full=reader.state(),q=(params.q||'').toLocaleLowerCase('tr-TR'),scope=params.scope||'today',type=params.type||'all';
      let offset=0;if(params.cursor){const cursor=JSON.parse(Buffer.from(params.cursor,'base64url'));if(cursor.revision!==full.revision)throw Object.assign(new Error('Veriler değişti.'),{status:409});offset=cursor.offset;}
      const typeGroups={money:['movement','transfer','settlement'],inventory:['stock','stocktake'],setup:['opening','nominalOpening','account','fundAccount','stockAccount','accountUpdate','stockUpdate','close']};
      const all=full.journal.filter(event=>(scope==='all'||event.date===full.date)&&(type==='all'||(typeGroups[type]||[type]).includes(event.type))&&(!q||(event.meta.note||'').toLocaleLowerCase('tr-TR').includes(q))).reverse();
      let items=all.slice(offset,offset+2);if(controller.overlap&&offset>0)items=[all[offset-1],...items];
      const reversed=new Set(full.journal.filter(event=>event.type==='reverse').map(event=>event.meta.originalId));
      const result={items,total:all.length,totalEntries:all.reduce((n,e)=>n+e.entries.length,0),reversedIds:items.filter(event=>reversed.has(event.id)).map(event=>event.id),nextCursor:offset+2<all.length?Buffer.from(JSON.stringify({revision:full.revision,offset:offset+2})).toString('base64url'):null,revision:full.revision};
      if(controller.delays.has(params.q||''))await controller.delays.get(params.q||'');
      return ok(result);
    }catch(error){return{ok:false,status:error.status||400,json:async()=>({error:error.message})};}
  };
  window.eval(source+'\nwindow.__compact={setView,submit};');await tick();
  return{repo,window,document,controller,calls,compact,run,async nav(name){window.__compact.setView(name);await tick();},async input(selector,value,event='input'){const element=document.querySelector(selector);assert.ok(element,selector);element.value=value;element.dispatchEvent(new window.Event(event,{bubbles:true}));await tick();},close(){window.close();repo.close();other.close();}};
}

check('compact state is requested and dashboard uses complete server aggregates rather than four recent events',async context=>{
  assert.equal(context.calls[0].searchParams.get('view'),'compact');
  const values=[...context.document.querySelectorAll('.stats .stat-value')].map(node=>node.textContent);
  // 500 sale + 43 capital receipts; the cancelled 1 TL receipt has a separate 1 TL cash exit.
  assert.match(values[0],/10\.540,00 TL/);assert.match(values[1],/543,00 TL/);assert.match(values[2],/3,00 TL/);
  assert.match(context.document.querySelector('#main').textContent,new RegExp(context.compact().overview.todaysCount+' işlem'));
  assert.equal(context.compact().journal.some(event=>event.id==='early-sale'),false,'Older sale is absent from the short event list');
});
check('command and legacy restore request compact views while all closing and stocktake history stays available',async context=>{
  await context.window.__compact.submit({type:'movement',accountId:'nakit',category:'Sermaye',direction:'in',quantity:'1',note:'Compact command'});
  assert.equal(context.calls.find(url=>url.pathname==='/api/command').searchParams.get('view'),'compact');
  await context.nav('closing');assert.equal(context.document.querySelectorAll('.closing-history details').length,4);
  await context.nav('backup');const backup=JSON.stringify(context.repo.backup());
  Object.defineProperty(context.document.querySelector('#f-backupFile'),'files',{value:[{name:'fixture.json',size:backup.length,text:async()=>backup}],configurable:true});context.document.querySelector('#f-confirmation').value='GERİ YÜKLE';
  context.document.querySelector('#restore-form').dispatchEvent(new context.window.Event('submit',{bubbles:true,cancelable:true}));await tick();
  assert.equal(context.calls.find(url=>url.pathname==='/api/restore').searchParams.get('view'),'compact');
});
check('journal pages come from the API and global reversals suppress invalid reverse forms even when filtered',async context=>{
  await context.nav('journal');assert.ok(context.calls.some(url=>url.pathname==='/api/journal'));assert.equal(context.document.querySelectorAll('#journal-list .journal-item').length,2);
  await context.input('#journal-type','money','change');await context.input('#journal-search','Hedef');
  assert.equal(context.document.querySelectorAll('#journal-list .journal-item').length,1);
  assert.match(context.document.querySelector('#journal-list').textContent,/İptal \/ düzeltme işlendi/);assert.equal(context.document.querySelector('#journal-list .reverse-form'),null);assert.equal(context.document.querySelector('img'),null);
});
check('next pages append unique records and filter clear resets pagination',async context=>{
  await context.nav('journal');context.controller.overlap=true;const next=context.document.querySelector('#journal-next');assert.ok(next);next.click();await tick();
  assert.equal(context.document.querySelectorAll('#journal-list .journal-item').length,4);
  await context.input('#journal-search','bulunmayan');assert.equal(context.document.querySelectorAll('#journal-list .journal-item').length,0);assert.ok(context.document.querySelector('#journal-empty-clear'));
  context.document.querySelector('#journal-empty-clear').click();await tick();assert.equal(context.document.querySelector('#journal-search').value,'');assert.equal(context.document.querySelectorAll('#journal-list .journal-item').length,2);
});
check('stale cursor errors remove old reverse forms and refresh state before retrying the journal',async context=>{
  await context.nav('journal');const reads=context.calls.filter(url=>url.pathname==='/api/state').length;
  context.run('outside-change',{type:'movement',date:context.repo.state().date,accountId:'nakit',category:'Sermaye',direction:'in',quantity:'1',note:'Diğer sekme'});
  assert.ok(context.document.querySelector('#journal-next'));context.document.querySelector('#journal-next').click();await tick();
  assert.equal(context.document.querySelectorAll('#journal-list .reverse-form').length,0);assert.ok(context.document.querySelector('#journal-retry'));
  context.document.querySelector('#journal-retry').click();await tick();await tick();
  assert.equal(context.calls.filter(url=>url.pathname==='/api/state').length,reads+1);assert.equal(context.document.querySelectorAll('#journal-list .journal-item').length,2);
});
check('rapid search drops older responses without losing the search focus',async context=>{
  await context.nav('journal');let release;context.controller.delays.set('bir',new Promise(resolve=>{release=resolve;}));
  try{const search=context.document.querySelector('#journal-search');search.focus();await context.input('#journal-search','bir');await context.input('#journal-search','iki');assert.match(context.document.querySelector('#journal-list').textContent,/Satır iki/);release();await tick();assert.doesNotMatch(context.document.querySelector('#journal-list').textContent,/Satır bir/);assert.equal(context.document.activeElement,search);}
  finally{release();}
});
check('workspace changes discard pending pages from the old ledger',async context=>{
  await context.nav('journal');let release;context.controller.delays.set('bir',new Promise(resolve=>{release=resolve;}));
  try{await context.input('#journal-search','bir');await context.input('#workspace','dukkan','change');release();await tick();assert.ok(context.document.querySelector('#opening-form'));assert.equal(context.document.querySelector('#journal-list'),null);assert.equal(context.document.querySelector('#workspace').value,'dukkan');}
  finally{release();}
});
check('navigation rerenders discard a detached journal page response',async context=>{
  await context.nav('journal');let release;context.controller.delays.set('bir',new Promise(resolve=>{release=resolve;}));
  try{await context.input('#journal-search','bir');await context.nav('overview');release();await tick();assert.match(context.document.querySelector('#main h1').textContent,/Günün Görünümü/);assert.equal(context.document.querySelector('#journal-list'),null);}
  finally{release();}
});
check('native repository compact projection and journal pages integrate with dashboard and global reversal UI',async context=>{
  assert.equal(typeof context.repo.journalPage,'function');context.controller.native=true;
  context.document.querySelector('#refresh').click();await tick();
  assert.match(context.document.querySelectorAll('.stats .stat-value')[1].textContent,/543,00 TL/);
  assert.match(context.document.querySelectorAll('.stats .stat-value')[2].textContent,/3,00 TL/);
  await context.nav('journal');assert.equal(context.document.querySelectorAll('#journal-list .journal-item').length,25);
  context.document.querySelector('#journal-next').click();await tick();assert.ok(context.document.querySelectorAll('#journal-list .journal-item').length>25);
  await context.input('#journal-type','money','change');await context.input('#journal-search','Hedef');
  assert.equal(context.document.querySelectorAll('#journal-list .journal-item').length,1);assert.equal(context.document.querySelector('#journal-list .reverse-form'),null);
  assert.match(context.document.querySelector('#journal-list').textContent,/İptal \/ düzeltme işlendi/);
  await context.nav('closing');assert.equal(context.document.querySelectorAll('.closing-history details').length,4);
});
let failed=0;for(const{name,run}of cases){const context=await fixture();try{await run(context);console.log('PASS:',name);}catch(error){failed++;console.error('FAIL:',name,'\n',error.message);}finally{context.close();}}
if(failed){console.error(failed+' compact UI checks failed.');process.exitCode=1;}else console.log('PASS: '+cases.length+' compact UI contract checks using synthetic memory repositories.');
