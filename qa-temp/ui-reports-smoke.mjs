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
  const controller={overviewFailure:false,journalDelay:null,transform:null,status:503};
  window.fetch=async(url,options)=>{
    assert.ok(!options?.method||options.method==='GET');assert.equal(options?.body,undefined);
    const parsed=new URL(url,window.location.href);assert.ok(['/api/reports/overview','/api/reports/summary','/api/reports/journal'].includes(parsed.pathname));calls.push(parsed);
    const reader=parsed.searchParams.get('workspace')==='dukkan'?empty:reports;
    try{
      let result;
      if(parsed.pathname.endsWith('/overview')){if(controller.overviewFailure)throw new Error('Sentetik rapor hatası <img src=x>');result=reader.overview();}
      else if(parsed.pathname.endsWith('/summary'))result=reader.summary(parsed.searchParams.get('date'));
      else {if(controller.journalDelay)await controller.journalDelay;const params=Object.fromEntries(parsed.searchParams);delete params.workspace;result=reader.journal(params);}
      return{ok:true,status:200,json:async()=>controller.transform?controller.transform(result,parsed):result};
    }catch(error){return{ok:false,status:error.status||controller.status,json:async()=>({error:error.message})};}
  };
  window.eval(source);await tick();
  return{window,document,calls,controller,writer,run,async nav(name){document.querySelector('[data-report-view="'+name+'"]').click();await tick();},close(){window.close();reports.close();empty.close();writer.close();other.close();rmSync(directory,{recursive:true,force:true});}};
}
check('a distinct read-only dashboard shows accessible TL charts and no editor actions',async({document,calls})=>{
  assert.match(document.querySelector('.readonly-badge').textContent,/Salt okunur/);assert.ok(document.querySelector('#trade-chart svg'));
  assert.match(document.querySelector('#trade-chart').textContent,/Net satış/);assert.match(document.querySelector('#report-meta').textContent,/Veri sürümü/);
  assert.equal(document.querySelector('a[href*="4317"],a[href="/app.js"],form[action*="command"]'),null);
  assert.ok([...document.querySelectorAll('button')].every(button=>!/kaydet|geri yükle|düzelt|hesap aç/i.test(button.textContent)));
  assert.ok(calls.every(call=>call.pathname.startsWith('/api/reports/')));
});
check('stock classification excludes the physical HAS fund and stock search preserves focus',async context=>{
  await context.nav('stock');const{document,window}=context;
  assert.doesNotMatch(document.querySelector('#report-stock-list').textContent,/HAS kasa/);assert.match(document.querySelector('#report-stock-list').textContent,/GRAM ALTIN/);
  const search=document.querySelector('#stock-search');search.focus();search.value='CEYREK';search.dispatchEvent(new window.Event('input',{bubbles:true}));
  assert.match(document.querySelector('#report-stock-list').textContent,/çeyrek/i);assert.equal(document.activeElement,search);
  search.value='<img>';search.dispatchEvent(new window.Event('input',{bubbles:true}));assert.match(document.querySelector('#report-stock-list').textContent,/bulunamadı/);assert.equal(document.querySelector('img'),null);
});
check('receivables preserve signs, original units, name search and escaped text',async context=>{
  await context.nav('cari');const{document,window}=context;
  const filter=document.querySelector('#cari-filter');filter.value='debt';filter.dispatchEvent(new window.Event('change',{bubbles:true}));
  assert.match(document.querySelector('#report-cari-list').textContent,/Borcumuz/);assert.match(document.querySelector('#report-cari-list').textContent,/1,125 has gr/);assert.equal(document.querySelector('img'),null);
  filter.value='claim';filter.dispatchEvent(new window.Event('change',{bubbles:true}));const search=document.querySelector('#cari-search');search.value='ISTANBUL';search.dispatchEvent(new window.Event('input',{bubbles:true}));assert.match(document.querySelector('#report-cari-list').textContent,/Alacağımız/);assert.match(document.querySelector('#report-cari-list').textContent,/100,00 TL/);
});
check('dated summary is historical, keyboard readable and outside the short live status',async({document,window})=>{
  document.querySelector('#report-summary-form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await tick();
  const target=document.querySelector('#dated-summary');assert.ok(target.querySelector('table'));assert.equal(target.querySelector('.table-wrap').tabIndex,0);assert.equal(target.closest('[aria-live]'),null);assert.match(document.querySelector('#dated-summary-status').textContent,/hazır/);
});
check('journal pagination uses GET, has unique records and stale revisions require a fresh list',async context=>{
  await context.nav('journal');const{document}=context;
  assert.equal(document.querySelectorAll('.movement-card').length,25);document.querySelector('#report-more').click();await tick();
  const records=[...document.querySelectorAll('[data-record]')].map(node=>node.dataset.record);assert.equal(new Set(records).size,records.length);assert.ok(records.length>25);
  document.querySelector('#report-journal-form').dispatchEvent(new context.window.Event('submit',{bubbles:true,cancelable:true}));await tick();
  context.run({type:'movement',date:'2026-10-27',accountId:'nakit',category:'Sermaye',direction:'in',quantity:'1',note:'Yeni kayıt'});
  document.querySelector('#report-more').click();await tick();assert.equal(document.querySelectorAll('.movement-card').length,0);assert.ok(document.querySelector('#journal-reload'));assert.match(document.querySelector('#journal-status').textContent,/doğrulanamadı/);
});
check('a journal request spawned by refresh retains its own busy lock until completion',async context=>{
  await context.nav('journal');let release;context.controller.journalDelay=new Promise(resolve=>{release=resolve;});
  try{context.document.querySelector('#report-refresh').click();await tick();assert.equal(context.document.body.getAttribute('aria-busy'),'true');assert.equal(context.document.querySelector('#report-refresh').disabled,true);}
  finally{release();await tick();}
  assert.equal(context.document.body.getAttribute('aria-busy'),'false');assert.equal(context.document.querySelector('#report-refresh').disabled,false);
});
check('report errors discard stale totals, escape details and recover without writes',async context=>{
  const{document}=context;context.controller.overviewFailure=true;document.querySelector('#report-refresh').click();await tick();
  assert.equal(document.querySelector('#trade-chart'),null);assert.ok(document.querySelector('#report-retry'));assert.equal(document.querySelector('#report-status').getAttribute('role'),'alert');assert.equal(document.querySelector('img'),null);
  context.controller.overviewFailure=false;document.querySelector('#report-retry').click();await tick();assert.ok(document.querySelector('#trade-chart'));
});
check('an unopened workspace is an explicit empty state rather than fabricated balances',async({document,window})=>{
  document.querySelector('#report-workspace').value='dukkan';document.querySelector('#report-workspace').dispatchEvent(new window.Event('change',{bubbles:true}));await tick();assert.match(document.querySelector('#report-main').textContent,/Henüz açılış yapılmadı/);assert.equal(document.querySelector('#trade-chart'),null);
});

check('filter context survives navigation and is isolated between workspaces',async c=>{
 await c.nav('cari');c.document.querySelector('#cari-search').value='istanbul';c.document.querySelector('#cari-filter').value='claim';
 await c.nav('stock');c.document.querySelector('#stock-search').value='ceyrek';await c.nav('cari');
 assert.equal(c.document.querySelector('#cari-search').value,'istanbul');assert.equal(c.document.querySelector('#cari-filter').value,'claim');assert.equal(c.document.querySelectorAll('.cari-card').length,1);
 const select=c.document.querySelector('#report-workspace');select.value='dukkan';select.dispatchEvent(new c.window.Event('change'));await tick();select.value='demo';select.dispatchEvent(new c.window.Event('change'));await tick();assert.equal(c.document.querySelector('#cari-search').value,'istanbul');
});
check('missing totals or revision do not become zero KPIs',async c=>{
 c.controller.transform=r=>{const copy={...r};delete copy.revision;return copy;};c.document.querySelector('#report-refresh').click();await tick();assert.equal(c.document.querySelector('#trade-chart'),null);assert.match(c.document.querySelector('#report-main').textContent,/eksik/);
});
check('permission denial is distinguished from report transport failure',async c=>{
 c.controller.overviewFailure=true;c.controller.status=403;c.document.querySelector('#report-refresh').click();await tick();assert.match(c.document.querySelector('h1').textContent,/erişim izni yok/);assert.equal(c.document.querySelector('#trade-chart'),null);
});
check('HAS funds remain labeled HAS rather than foreign currency or TL',async c=>{
 assert.match(c.document.querySelector('#report-main').textContent,/HAS hesapları/);assert.match(c.document.querySelector('#report-main').textContent,/2,500 has gr/);
});

check('journal filters and historical date survive section navigation without stale cursors',async c=>{
 await c.nav('journal');
 c.document.querySelector('#journal-date').value='2026-10-27';c.document.querySelector('#journal-type').value='movement';c.document.querySelector('#journal-search').value='İstanbul';
 await c.nav('stock');await c.nav('journal');
 const request=c.calls.filter(x=>x.pathname.endsWith('/journal')).at(-1);
 assert.equal(request.searchParams.get('date'),'2026-10-27');assert.equal(request.searchParams.get('type'),'movement');assert.equal(request.searchParams.get('q'),'İstanbul');assert.equal(request.searchParams.has('cursor'),false);
 await c.nav('overview');c.document.querySelector('#report-date').value='2026-10-26';await c.nav('stock');await c.nav('overview');
 assert.equal(c.document.querySelector('#report-date').value,'2026-10-26');assert.equal(c.document.querySelector('#dated-summary').textContent,'');
});
check('large signed KPIs retain formatted values and select the long-value layout',async c=>{
 c.controller.transform=r=>({...r,totals:{sales:99999999999999,purchases:-99999999999999,expenses:0}});
 c.document.querySelector('#report-refresh').click();await tick();
 const values=c.document.querySelectorAll('.long-amount strong');assert.equal(values.length,2);assert.equal(values[0].textContent,'999.999.999.999,99 TL');assert.equal(values[1].textContent,'-999.999.999.999,99 TL');assert.equal(values[1].tabIndex,0);
});

check('pure silver reports retain milligram precision without mixing currency balances',async c=>{
 c.controller.transform=r=>({...r,accounts:r.accounts.map(a=>a.category==='receivable'?{...a,unit:'SILVER',balance:a.balance<0?-374875:125125}:a)});
 c.document.querySelector('#report-refresh').click();await tick();await c.nav('cari');
 const text=c.document.querySelector('#report-main').textContent;
 assert.match(text,/374,875 saf gümüş gr/);assert.match(text,/125,125 saf gümüş gr/);assert.doesNotMatch(text,/3\.748,75 SILVER/);
 assert.equal(c.document.querySelector('form[action*="command"]'),null);
});
let failed=0;for(const{name,run}of cases){const context=await fixture();try{await run(context);console.log('PASS:',name);}catch(error){failed++;console.error('FAIL:',name,'\n',error.message);}finally{context.close();}}
if(failed){console.error(failed+' report UI checks failed.');process.exitCode=1;}else console.log('PASS: '+cases.length+' read-only report UI checks; actual Android Chrome and iPhone Safari were not tested.');
