import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadJSDOM } from '../test-support/jsdom.mjs';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS } from '../domain.mjs';
const JSDOM=await loadJSDOM();
const tick=async()=>{for(let i=0;i<12;i++)await new Promise(r=>setTimeout(r,0));};
async function fixture(){
 const repo=new Repository(':memory:','demo'),run=(id,command)=>repo.execute({id,revision:repo.state().revision,command:{date:'2026-10-31',...command}});
 run('opening',{type:'opening',balances:Object.fromEntries(INITIAL_ACCOUNTS.filter(a=>!a.retired).map(a=>[a.id,a.id==='nakit'?'10000':a.id==='gramToplam'?'200':'0']))});
 run('buyer',{type:'account',name:'<img src=x> Müşteri',unit:'TL',opening:'100',partyType:'customer'});const accountId='cari-buyer';
 for(let i=0;i<105;i++)run('sale-'+i,{type:'sale',counterpartyId:accountId,counterpartyType:'customer',items:[{accountId:'gramToplam',quantity:'1',value:'10'}],received:[],given:[],credits:[{accountId,quantity:'10',valueTL:'10'}],debts:[],note:i===3?' =1+1':'Satış '+i});
 run('linked-return',{type:'saleReturn',originalId:'sale-0',items:[{lineIndex:0,quantity:'0.5',value:'3'}],refunds:[{accountId:'nakit',quantity:'3',valueTL:'3'}],note:'Bağlı iade'});
 run('reverse-sale',{type:'reverse',originalId:'sale-1',note:'Satış iptali'});
 run('cash-sale',{type:'sale',counterpartyId:accountId,counterpartyType:'customer',items:[{accountId:'gramToplam',quantity:'1',value:'10'}],received:[{accountId:'nakit',quantity:'10',valueTL:'10'}],given:[],credits:[],debts:[],note:'Cari etkisi sıfır peşin satış'});
 run('collection',{type:'collection',customerAccount:accountId,target:'nakit',direction:'collect',quantity:'40',note:'Tahsilat'});
 assert.equal(repo.state().balances[accountId],110000);
 const dom=new JSDOM(readFileSync(new URL('../public/index.html',import.meta.url),'utf8'),{url:'http://127.0.0.1:4317/',runScripts:'outside-only'}),w=dom.window,d=w.document;
 Object.defineProperty(w.crypto,'randomUUID',{value:randomUUID});const calls=[],control={fault:'',printThrow:false},prints=[],downloads=[];
 w.print=()=>{if(control.printThrow)throw Error('synthetic print failure');prints.push(d.querySelector('#statement-print-snapshot')?.outerHTML||'');};
 w.URL.createObjectURL=blob=>{downloads.push(blob);return 'blob:synthetic';};w.URL.revokeObjectURL=()=>{};w.HTMLAnchorElement.prototype.click=function(){};
 w.fetch=async(url)=>{const parsed=new URL(url,w.location.href),q=Object.fromEntries(parsed.searchParams);calls.push({path:parsed.pathname,q});try{
  let result;if(parsed.pathname==='/api/state')result=repo.state({compact:true});
  else if(parsed.pathname==='/api/account-statement'){result=repo.accountStatement(q);if(control.fault==='freshness')result={...result,revision:result.revision+1};}
  else if(parsed.pathname==='/api/journal'){
   result=repo.journalPage({...q,limit:Number(q.limit||25)});
   // Presentation-only transport probes: no ledger event or financial state is changed.
   result={...result,items:result.items.map(event=>event.id==='sale-4'?{...event,meta:{...event.meta,note:' '+String.fromCharCode(9)+'=2+2'}}:event)};
   if(q.limit==='100'&&q.cursor&&control.fault==='duplicate'){const first=repo.journalPage({...q,cursor:undefined,limit:100}).items[0];result={...result,items:[first,...result.items.slice(1)]};}
   if(q.limit==='100'&&q.cursor&&control.fault==='cursor')result={...result,nextCursor:q.cursor};
   if(q.limit==='100'&&control.fault==='empty')result={...result,items:[],nextCursor:result.nextCursor||'not-empty'};
  }else throw Error('unexpected route');return {ok:true,status:200,json:async()=>result};
 }catch(error){return {ok:false,status:400,json:async()=>({error:error.message})};}};
 w.eval(readFileSync(new URL('../public/app.js',import.meta.url),'utf8')+'\nwindow.__receiptTest={setView};');await tick();w.__receiptTest.setView('accounts');d.querySelector(`[data-account-detail="${accountId}"]`).click();await tick();
 return {w,d,repo,calls,control,prints,downloads,accountId,async csv(){return await new Promise((resolve,reject)=>{const reader=new w.FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsText(downloads.at(-1));});},close(){w.close();repo.close();}};
}
const cases=[
 ['screen distinguishes limited rows, native running balance, zero effect and linked context',async f=>{
  assert.equal(f.d.querySelectorAll('#statement-result [data-statement-record]').length,25);
  const outer=f.d.querySelector('.statement-record-table');assert.ok(outer);assert.equal(outer.querySelectorAll(':scope > thead th[scope="col"]') .length,4);
  for(const cell of outer.querySelectorAll(':scope > tbody > tr[data-statement-record] > td')){assert.ok(f.d.getElementById(cell.getAttribute('headers')));assert.ok(cell.dataset.statementLabel);}
  const css=readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');assert.match(css,/@media screen and \(max-width:1100px\)/);assert.match(css,/\.statement-record-table > tbody > tr > td/);
  const latest=f.d.querySelector('#statement-result [data-statement-record="collection"]');assert.equal(latest.dataset.statementBalance,'110000');
  const cash=f.d.querySelector('#statement-result [data-statement-record="cash-sale"]');assert.equal(cash.dataset.statementBalance,'114000');assert.match(cash.textContent,/Cari etkisi yok/);
  const returned=f.d.querySelector('#statement-result [data-statement-record="linked-return"]');assert.ok(returned);assert.match(returned.textContent,/sale-0/);assert.match(returned.textContent,/İade/);
  assert.equal(f.d.querySelector('#statement-result img'),null);
 }],
 ['print loads every page into separate chronological expanded snapshot and cleans up',async f=>{
  const receipt=f.d.querySelector('.statement-receipt');assert.equal(receipt.open,false);f.d.querySelector('#statement-print').click();await tick();assert.equal(f.prints.length,1);
  const snapshot=f.d.querySelector('#statement-print-snapshot');assert.ok(snapshot);const rows=[...snapshot.querySelectorAll('[data-statement-record]')];assert.equal(rows.length,110);
  assert.equal(rows[0].dataset.statementRecord,'buyer');assert.equal(rows[0].dataset.statementBalance,'10000');assert.equal(rows.at(-1).dataset.statementBalance,'110000');
  assert.equal(snapshot.querySelectorAll('details:not([open])').length,0);assert.equal(receipt.open,false);assert.match(snapshot.textContent,/110 işlem/);assert.match(snapshot.textContent,/Sürüm/);assert.match(snapshot.textContent,/Oluşturulma/);
  assert.match(snapshot.querySelector('[data-statement-record="sale-1"]').textContent,/İptal/);assert.match(snapshot.querySelector('[data-statement-record="sale-0"]').textContent,/linked-return/);
  assert.ok(f.calls.filter(c=>c.path==='/api/account-statement').length>=2);assert.ok(f.calls.some(c=>c.q.limit==='100'&&c.q.cursor));
  f.w.dispatchEvent(new f.w.Event('afterprint'));assert.equal(f.d.querySelector('#statement-print-snapshot'),null);assert.equal(f.d.body.dataset.printScope,undefined);
 }],
 ['CSV contains all records, native details, balances, IDs and escaped formula text',async f=>{
  f.d.querySelector('#statement-download').click();await tick();assert.equal(f.downloads.length,1);const csv=await f.csv();
  assert.match(csv,/Kayıt ID/);assert.match(csv,/Kayıt zamanı/);assert.match(csv,/Durum/);assert.match(csv,/Girenler/);assert.match(csv,/Çıkanlar/);assert.match(csv,/İşlem sonrası bakiye/);
  assert.equal(csv.split('\r\n').length,111);assert.match(csv,/linked-return/);assert.match(csv,/0,500 gr/);assert.match(csv,/'=1\+1/);assert.ok(csv.includes("' "+String.fromCharCode(9)+'=2+2'));assert.match(csv,/1100\.00/);
 }],
 ...['freshness','duplicate','cursor','empty'].map(fault=>[`${fault} failure blocks print and CSV instead of exporting an unverified slice`,async f=>{
  f.control.fault=fault;f.d.querySelector('#statement-print').click();await tick();assert.equal(f.prints.length,0);assert.equal(f.d.querySelector('#statement-print-snapshot'),null);
  f.d.querySelector('#statement-download').click();await tick();assert.equal(f.downloads.length,0);assert.match(f.d.querySelector('#notice').textContent,/Ekstre|ekstre|Yazdır/);
 }]),
 ['actual amendment triad distinguishes corrected original, replacement and undo in shared receipts',async f=>{
  f.repo.execute({id:'amend-sale',revision:f.repo.state().revision,command:{type:'amend',date:'2026-10-31',originalId:'sale-2',note:'Bedel aynı; açıklama düzeltildi',replacement:{type:'sale',date:'2026-10-31',counterpartyId:f.accountId,counterpartyType:'customer',items:[{accountId:'gramToplam',quantity:'1',value:'10'}],received:[],given:[],credits:[{accountId:f.accountId,quantity:'10',valueTL:'10'}],debts:[],note:'Düzeltilen açıklama'}}});
  f.d.querySelector('#refresh').click();await tick();f.w.__receiptTest.setView('accounts');f.d.querySelector(`[data-account-detail="${f.accountId}"]`).click();await tick();
  assert.match(f.d.querySelector('[data-statement-record="amend-sale"]').textContent,/Düzeltilmiş kayıt/);
  assert.match(f.d.querySelector('[data-statement-record="amend-sale:undo"]').textContent,/Düzeltmenin ters kaydı/);
  f.d.querySelector('#statement-print').click();await tick();assert.equal(f.prints.length,1);const snapshot=f.d.querySelector('#statement-print-snapshot');
  assert.match(snapshot.querySelector('[data-statement-record="sale-2"]').textContent,/Düzeltilmiş eski kayıt/);
  assert.match(snapshot.querySelector('[data-statement-record="sale-1"]').textContent,/İptal edilmiş kayıt/);
  f.w.dispatchEvent(new f.w.Event('afterprint'));f.d.querySelector('#statement-download').click();await tick();const csv=await f.csv();
  assert.match(csv.split('\r\n').find(line=>line.includes('"sale-2";')),/Düzeltilmiş eski kayıt/);
  f.w.__receiptTest.setView('journal');await tick();const search=f.d.querySelector('#journal-search');search.value='sale-2';search.dispatchEvent(new f.w.Event('input',{bubbles:true}));await tick();
  assert.ok([...f.d.querySelectorAll('.receipt-record-meta')].some(node=>node.textContent.includes('Kayıt: sale-2')&&node.textContent.includes('Düzeltilmiş eski kayıt')));
 }],
 ['long printed receipts retain every line in repeatable direction tables',async f=>{
  f.repo.execute({id:'long-sale',revision:f.repo.state().revision,command:{type:'sale',date:'2026-10-31',counterpartyId:f.accountId,counterpartyType:'customer',items:Array.from({length:30},(_,i)=>({accountId:'gramToplam',quantity:'0.01',value:String(i+1)})),received:[{accountId:'nakit',quantity:'465',valueTL:'465'}],given:[],credits:[],debts:[]}});
  f.d.querySelector('#refresh').click();await tick();f.w.__receiptTest.setView('accounts');f.d.querySelector(`[data-account-detail="${f.accountId}"]`).click();await tick();
  f.d.querySelector('#statement-print').click();await tick();const article=f.d.querySelector('#statement-print-snapshot [data-statement-record="long-sale"]');
  assert.ok(article.classList.contains('long-receipt'));const tables=article.querySelectorAll('.receipt-print-flow-table');assert.equal(tables.length,2);
  assert.equal(tables[0].tBodies[0].rows.length,1);assert.equal(tables[1].tBodies[0].rows.length,30);
  assert.match(tables[0].tHead.textContent,/Mağazaya girenler/);assert.match(tables[1].tHead.textContent,/Mağazadan çıkanlar/);
  for(const table of tables)assert.match(table.tHead.textContent,/long-sale/);
  assert.match(tables[1].tBodies[0].rows[29].textContent,/30,00 TL/);assert.equal(article.querySelectorAll('.receipt-flow-row').length,31);
  assert.equal(f.d.querySelectorAll('.statement-record-table .receipt-print-flow-table').length,0);
 }],
 ['print exceptions remove the isolated snapshot and leave live details collapsed',async f=>{
  f.control.printThrow=true;f.d.querySelector('#statement-print').click();await tick();assert.equal(f.d.querySelector('#statement-print-snapshot'),null);assert.equal(f.d.body.dataset.printScope,undefined);assert.equal(f.d.querySelector('.statement-receipt').open,false);
 }]
];
let failures=0;for(const[name,run]of cases){const f=await fixture();try{await run(f);console.log('PASS: '+name);}catch(error){failures++;console.error('FAIL: '+name+'\n'+error.stack);}finally{f.close();}}
if(failures)process.exitCode=1;else console.log(`PASS: ${cases.length} complete statement/receipt checks.`);
