import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadJSDOM } from '../test-support/jsdom.mjs';
import { Repository } from '../repository.mjs';
import { ReportRepository } from '../report-repository.mjs';
import { INITIAL_ACCOUNTS } from '../domain.mjs';

const JSDOM=await loadJSDOM(),html=readFileSync(new URL('../public/reports.html',import.meta.url),'utf8'),source=readFileSync(new URL('../public/reports.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const cases=[];const check=(name,run)=>cases.push({name,run});
async function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'defter-report-ui-')),writer=new Repository(join(directory,'demo.sqlite'),'demo'),other=new Repository(join(directory,'dukkan.sqlite'),'dukkan');
  writer.db.exec('PRAGMA synchronous=OFF');
  let key=0;const run=command=>writer.execute({id:'ui-report-'+key++,revision:writer.state().revision,command});
  const balances=Object.fromEntries(INITIAL_ACCOUNTS.filter(account=>!account.retired).map(account=>[account.id,'0']));Object.assign(balances,{nakit:'1000',gramToplam:'20'});
  run({type:'opening',date:'2026-10-27',balances});run({type:'fundAccount',date:'2026-10-27',name:'HAS kasa',unit:'HAS',physical:true,opening:'2.500'});
  run({type:'account',date:'2026-10-27',name:'İstanbul müşteri',unit:'TL',opening:'100'});run({type:'account',date:'2026-10-27',name:'Tedarikçi <img src=x>',unit:'HAS',opening:'-1.125'});
  for(let i=0;i<30;i++)run({type:'movement',date:'2026-10-27',accountId:'nakit',category:'Sermaye',direction:'in',quantity:'1',note:'İstanbul çeyrek '+i});
  const reports=new ReportRepository(join(directory,'demo.sqlite'),'demo'),empty=new ReportRepository(join(directory,'dukkan.sqlite'),'dukkan');
  const dom=new JSDOM(html,{url:'https://defter.example-tailnet.ts.net/',runScripts:'outside-only',pretendToBeVisual:true}),{window}=dom,document=window.document,calls=[];
  const controller={overviewFailure:false,journalFailure:false,journalDelay:null,transform:null,status:503};
  window.fetch=async(url,options)=>{
    assert.ok(!options?.method||options.method==='GET');assert.equal(options?.body,undefined);
    const parsed=new URL(url,window.location.href);assert.ok(['/api/reports/overview','/api/reports/summary','/api/reports/journal'].includes(parsed.pathname));calls.push(parsed);
    const reader=parsed.searchParams.get('workspace')==='dukkan'?empty:reports;
    try{
      let result;
      if(parsed.pathname.endsWith('/overview')){if(controller.overviewFailure)throw new Error('Sentetik rapor hatası <img src=x>');result=reader.overview();}
      else if(parsed.pathname.endsWith('/summary'))result=reader.summary(parsed.searchParams.get('date'));
      else {if(controller.journalDelay)await controller.journalDelay;if(controller.journalFailure)throw new Error('Sentetik hareket hatası');const params=Object.fromEntries(parsed.searchParams);delete params.workspace;result=reader.journal(params);}
      return{ok:true,status:200,json:async()=>controller.transform?controller.transform(result,parsed):result};
    }catch(error){return{ok:false,status:error.status||controller.status,json:async()=>({error:error.message})};}
  };
  window.eval(source);await tick();
  return{window,document,calls,controller,writer,run,async nav(name){document.querySelector('[data-report-view="'+name+'"]').click();await tick();},close(){window.close();reports.close();empty.close();writer.close();other.close();rmSync(directory,{recursive:true,force:true});}};
}

check('existing return and POS settlement filters are reachable and keep read-only requests',async c=>{
 c.run({type:'sale',date:'2026-10-27',items:[{accountId:'gramToplam',quantity:'2',value:'200'}],cash:'100',pos:'100',bank:'0',scrapQuantity:'0',scrapValue:'0',note:'Sentetik satış'});
 const sale=c.writer.state().journal.find(e=>e.type==='sale');
 c.run({type:'saleReturn',date:'2026-10-27',originalId:sale.id,items:[{lineIndex:0,quantity:'1',value:'100'}],refunds:[{accountId:'nakit',quantity:'100',valueTL:'100'}],note:'Sentetik ürün iadesi'});
 c.run({type:'settlement',date:'2026-10-27',bankAccount:'banka',gross:'100',fee:'2',note:'Sentetik POS'});
 await c.nav('journal');const select=c.document.querySelector('#journal-type');
 for(const type of ['saleReturn','settlement']){
  assert.ok([...select.options].some(o=>o.value===type),'Supported report filter must be selectable: '+type);
  select.value=type;c.document.querySelector('#report-journal-form').dispatchEvent(new c.window.Event('submit',{bubbles:true,cancelable:true}));await tick();
  assert.equal(c.calls.at(-1).searchParams.get('type'),type);assert.equal(c.document.querySelectorAll('.movement-card').length,1);
 }
});
check('applied scope stays truthful while draft filters change and old pages append',async c=>{
 await c.nav('journal');const summary=c.document.querySelector('#journal-applied-filters');assert.ok(summary,'Applied filter scope must be visible');
 const before=summary.textContent,search=c.document.querySelector('#journal-search');search.value='Henüz uygulanmadı';search.dispatchEvent(new c.window.Event('input',{bubbles:true}));
 assert.equal(summary.textContent,before);assert.match(c.document.querySelector('#journal-filter-draft').textContent,/Filtre değişti/);
 c.document.querySelector('#report-more').click();await tick();assert.equal(c.calls.at(-1).searchParams.get('q'),'');assert.ok(c.calls.at(-1).searchParams.get('cursor'));
 assert.equal(summary.textContent,before);assert.match(c.document.querySelector('#journal-filter-draft').textContent,/Filtre değişti/);
 c.document.querySelector('#report-journal-form').dispatchEvent(new c.window.Event('submit',{bubbles:true,cancelable:true}));await tick();
 assert.match(summary.textContent,/Henüz uygulanmadı/);assert.equal(c.document.querySelector('#journal-filter-draft').textContent,'');assert.equal(c.calls.at(-1).searchParams.has('cursor'),false);
});
check('reset clears all journal filters and cursor while restoring useful keyboard focus',async c=>{
 await c.nav('journal');c.document.querySelector('#journal-date').value='2026-10-27';c.document.querySelector('#journal-type').value='movement';c.document.querySelector('#journal-search').value='İstanbul';
 c.document.querySelector('#report-journal-form').dispatchEvent(new c.window.Event('submit',{bubbles:true,cancelable:true}));await tick();
 const reset=c.document.querySelector('#journal-clear');assert.ok(reset,'One clear action must exist');assert.equal(reset.type,'button');reset.focus();reset.click();await tick();
 for(const key of ['date','type','q'])assert.equal(c.calls.at(-1).searchParams.get(key),'');assert.equal(c.calls.at(-1).searchParams.has('cursor'),false);
 assert.equal(c.document.activeElement.id,'journal-search');assert.match(c.document.querySelector('#journal-applied-filters').textContent,/Bütün günler.*Bütün türler.*Arama yok/);
 await c.nav('stock');await c.nav('journal');assert.equal(c.document.querySelector('#journal-search').value,'');
});
check('failed and pending queries never announce an unverified applied scope',async c=>{
 await c.nav('journal');const summary=c.document.querySelector('#journal-applied-filters');assert.ok(summary);
 let release;c.controller.journalDelay=new Promise(resolve=>{release=resolve;});c.document.querySelector('#journal-search').value='yeni kapsam';
 c.document.querySelector('#report-journal-form').dispatchEvent(new c.window.Event('submit',{bubbles:true,cancelable:true}));await tick();assert.equal(summary.textContent,'');
 c.controller.journalFailure=true;release();await tick();assert.equal(summary.textContent,'');assert.equal(c.document.querySelectorAll('.movement-card').length,0);
 assert.match(c.document.querySelector('#journal-status').textContent,/doğrulanamadı/);c.controller.journalFailure=false;c.controller.journalDelay=null;c.document.querySelector('#journal-reload').click();await tick();
 assert.match(summary.textContent,/yeni kapsam/);assert.equal(c.document.querySelector('#journal-filter-draft').textContent,'');
});
check('single-account movements include physical stock and retain distinct stock-entry filters',async c=>{
 c.run({type:'stock',date:'2026-10-27',direction:'in',category:'Stok girişi',note:'Sentetik stok',items:[{accountId:'gramToplam',quantity:'1'}]});
 c.run({type:'movement',date:'2026-10-27',accountId:'gramToplam',direction:'in',category:'Stok girişi',quantity:'2',note:'Tek hesap fiziksel stok girişi'});
 await c.nav('journal');const select=c.document.querySelector('#journal-type');assert.equal(select.querySelector('[value="movement"]').textContent,'Tek hesap hareketi / düzeltme');assert.equal(select.querySelector('[value="stock"]')?.textContent,'Stok giriş / çıkışı');
 for(const [type,count] of [['stock',1],['movement',25]]){select.value=type;c.document.querySelector('#report-journal-form').dispatchEvent(new c.window.Event('submit',{bubbles:true,cancelable:true}));await tick();assert.equal(c.calls.at(-1).searchParams.get('type'),type);assert.equal(c.document.querySelectorAll('.movement-card').length,count);}
 const first=c.document.querySelector('.movement-card');assert.match(first.textContent,/Tek hesap fiziksel stok girişi/);assert.match(first.textContent,/\+2,000 gr/);assert.doesNotMatch(c.document.querySelector('#report-journal-list').textContent,/Sentetik stok/);
});
check('journal draft and applied scope remain isolated on workspace navigation',async c=>{
 await c.nav('journal');const search=c.document.querySelector('#journal-search');search.value='İstanbul';search.dispatchEvent(new c.window.Event('input',{bubbles:true}));
 const workspace=c.document.querySelector('#report-workspace');workspace.value='dukkan';workspace.dispatchEvent(new c.window.Event('change',{bubbles:true}));await tick();assert.equal(c.document.querySelector('#journal-applied-filters'),null);
 workspace.value='demo';workspace.dispatchEvent(new c.window.Event('change',{bubbles:true}));await tick();assert.equal(c.document.querySelector('#journal-search').value,'İstanbul');assert.match(c.document.querySelector('#journal-applied-filters')?.textContent||'',/İstanbul/);
});
let failed=0;for(const{name,run}of cases){const context=await fixture();try{await run(context);console.log('PASS:',name);}catch(error){failed++;console.error('FAIL:',name,'\n',error.message);}finally{context.close();}}
if(failed){console.error(failed+' report UI checks failed.');process.exitCode=1;}else console.log('PASS: '+cases.length+' read-only report UI checks; actual Android Chrome and iPhone Safari were not tested.');
