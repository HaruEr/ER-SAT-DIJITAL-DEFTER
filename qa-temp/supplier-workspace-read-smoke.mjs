import test from 'node:test';
import assert from 'node:assert/strict';
import {loadJSDOM} from '../test-support/jsdom.mjs';
import {renderSupplierWorkspace} from '../public/suppliers.js';
const JSDOM=await loadJSDOM(),tick=()=>new Promise(r=>setTimeout(r,0));
function fixture(t,mode='normal'){
 const dom=new JSDOM('<main></main>',{url:'http://127.0.0.1/'}),root=dom.window.document.querySelector('main'),prints=[],calls=[];
 const supplier={id:'firm',name:'Firma <img>'},accounts=[{id:'has',unit:'HAS',balance:-1500}];
 const statements=[{accountId:'has',unit:'HAS',opening:0,debtIncrease:2000,debtDecrease:500,creditIncrease:0,creditDecrease:0,closing:-1500}];
 const events=[1,2].map(i=>({id:'event-'+i,date:'2026-11-10',label:'Alış '+i,type:'supplierPurchase',entries:[],meta:{},balances:[{accountId:'has',unit:'HAS',before:i===1?0:-2000,delta:i===1?-2000:500,after:i===1?-2000:-1500}]}));
 let requests=0;
 const context={workspace:'demo',memory:new Map(),state:{revision:7,accounts:[],supplierParties:[{...supplier,accounts}]},escape:v=>String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'),format:(n,u)=>n+' '+u,day:x=>x,refresh(){},submit(){throw Error('No financial write');},printReport:html=>{assert.equal(root.querySelector('[data-supplier-read-status]').textContent,'Tam dönem çıktısı hazır.');prints.push(html);},parseAmount:(input)=>Number(input.value),
 request:async(route,body,w,{query})=>{calls.push(query);requests++;const cursor=query.cursor;
 return {revision:mode==='stale'&&cursor?8:7,supplier,accounts,statements,startDate:query.startDate,endDate:query.endDate,total:2,events:[cursor?(mode==='duplicate'?events[0]:events[1]):events[0]],...(cursor?{}:{nextCursor:'page2'})};}};
 const api=renderSupplierWorkspace(root,context);t.after(()=>{api.destroy();dom.window.close();});
 root.querySelector('[data-open-firm="firm"]').click();
 return {root,dom,api,prints,calls,context,events,statements};
}
test('history loads one page and append keeps each event once with unknown reference explicit',async t=>{
 const f=fixture(t);f.root.querySelector('[data-supplier-task="history"]').click();await tick();await tick();
 assert.equal(f.root.querySelectorAll('[data-supplier-event]').length,1);assert.match(f.root.textContent,/Belirtilmedi/);assert.equal(f.root.querySelector('img'),null);
 f.root.querySelector('[data-supplier-more]').click();await tick();assert.equal(f.root.querySelectorAll('[data-supplier-event]').length,2);assert.ok(f.calls.every(query=>query.documents==='omit'),'read pages never request financial source capacities');
});
test('statement comparison uses explicit sign and print verifies all pages first',async t=>{
 const f=fixture(t);f.root.querySelector('[data-supplier-task="statement"]').click();await tick();await tick();
 const form=f.root.querySelector('[data-reconcile-form]');form.elements.amount.value='1200';form.elements.sign.value='debt';form.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));
 assert.match(f.root.querySelector('[data-reconcile-result]').textContent,/−?300/);
 f.root.querySelector('[data-supplier-print]').click();await tick();await tick();assert.equal(f.prints.length,1);
 assert.match(f.prints[0],/event-1/);assert.match(f.prints[0],/event-2/);assert.match(f.prints[0],/Mutabakat/);assert.equal(f.calls.filter(x=>x.cursor).length,1);
});
for(const mode of ['stale','duplicate'])test(mode+' full output fails closed without printing',async t=>{
 const f=fixture(t,mode);f.root.querySelector('[data-supplier-task="statement"]').click();await tick();await tick();f.root.querySelector('[data-supplier-print]').click();await tick();await tick();
 assert.equal(f.prints.length,0);assert.match(f.root.querySelector('[data-supplier-read-status]').textContent,/değişti|tekrar|doğrulanamadı/i);
});


test('active native history reversal preserves selected identity and requires explicit reason',async t=>{
 const f=fixture(t);f.events[0].status='active';f.context.state.date='2026-11-10';const sent=[];f.context.submit=async c=>{sent.push(c);return false;};
 // Recreate to install the actual submission callback supplied by the owner wrapper.
 f.api.destroy();f.api=renderSupplierWorkspace(f.root,f.context);f.root.querySelector('[data-open-firm="firm"]')?.click();f.root.querySelector('[data-supplier-task="history"]').click();await tick();f.root.querySelector('[data-reverse-supplier-event]').click();const form=f.root.querySelector('[data-supplier-form="reverse"]');assert.ok(form);form.requestSubmit();await tick();assert.equal(sent.length,0);form.elements.note.value='Yanlış kayıt';form.requestSubmit();await tick();assert.deepEqual(sent[0],{type:'supplierReverse',date:'2026-11-10',originalId:'event-1',note:'Yanlış kayıt'});
});

test('return history separates outgoing products, agreed native credit and residual document debt',async t=>{
 const f=fixture(t);Object.assign(f.events[0],{type:'supplierReturn',status:'active',meta:{lines:[{accountId:'coin',unit:'ADET',quantity:1}],reductions:[{accountId:'has',unit:'HAS',quantity:2000}],creditLines:[{accountId:'has',unit:'HAS',quantity:1500}],chargeLines:[{accountId:'has',unit:'HAS',quantity:500}],debtLines:[{accountId:'has',unit:'HAS',quantity:300}],relatedEventIds:['original']}});f.root.querySelector('[data-supplier-task="history"]').click();await tick();const card=f.root.querySelector('[data-supplier-event]');assert.match(card.textContent,/Firmaya iade edilen ürünler/);assert.doesNotMatch(card.textContent,/Alınan ürünler/);assert.match(card.textContent,/Kaynak alış belgesinden düşülen.*2000 HAS/);assert.match(card.textContent,/Anlaşılmış cari alacak.*1500 HAS/);assert.match(card.textContent,/İade sonrası kalan borç.*500 HAS/);assert.match(card.textContent,/Tahsilatın cari borç etkisi.*300 HAS/);
});

test('CSV downloads the verified full snapshot with native summaries and neutralized spreadsheet formulas',async t=>{
 const f=fixture(t),blobs=[],links=[];f.dom.window.Blob=Blob;f.dom.window.URL.createObjectURL=blob=>{blobs.push(blob);return 'blob:test';};f.dom.window.URL.revokeObjectURL=()=>{};f.dom.window.HTMLAnchorElement.prototype.click=function(){links.push(this.download);};f.events[0].label='=SUM(1;2)';f.events[0].meta.note='  @EVIL;"x"\nnext';f.root.querySelector('[data-supplier-task="statement"]').click();await tick();await tick();f.root.querySelector('[data-supplier-csv]').click();await tick();await tick();assert.equal(blobs.length,1);const csv=await blobs[0].text();assert.match(csv,/"Özet"/);assert.match(csv,/"event-1"/);assert.match(csv,/"event-2"/);assert.match(csv,/"HAS"/);assert.match(csv,/"'-1500"/);assert.match(csv,/"'=SUM\(1;2\)"/);assert.match(csv,/'  @EVIL/);assert.equal(f.calls.filter(x=>x.cursor).length,1);assert.match(links[0],/\.csv$/);
});
for(const mode of ['stale','duplicate'])test('CSV '+mode+' snapshot produces no download',async t=>{
 const f=fixture(t,mode),blobs=[];f.dom.window.URL.createObjectURL=b=>{blobs.push(b);return 'blob:test';};f.root.querySelector('[data-supplier-task="statement"]').click();await tick();f.root.querySelector('[data-supplier-csv]').click();await tick();await tick();assert.equal(blobs.length,0);assert.match(f.root.querySelector('[data-supplier-read-status]').textContent,/değişti|tekrar|doğrulanamadı/);
});

test('PDF callback receives the same complete filtered revision and native summary snapshot',async t=>{
 const f=fixture(t),exports=[];f.context.exportPdf=async value=>exports.push(value);f.root.querySelector('[data-supplier-task="statement"]').click();await tick();const form=f.root.querySelector('[data-supplier-period]');form.elements.startDate.value='2026-11-01';form.elements.endDate.value='2026-11-10';form.requestSubmit();await tick();f.root.querySelector('[data-supplier-pdf]').click();await tick();await tick();assert.equal(exports.length,1);assert.equal(exports[0].events.length,2);assert.deepEqual(exports[0].scope,{supplierId:'firm',startDate:'2026-11-01',endDate:'2026-11-10',limit:50,documents:'omit'});assert.equal(exports[0].revision,7);assert.equal(exports[0].page.statements[0].closing,-1500);assert.equal(exports[0].page.statements[0].unit,'HAS');
});
test('inconsistent native summary blocks CSV and PDF before file creation',async t=>{
 const f=fixture(t),exports=[];f.context.exportPdf=async x=>exports.push(x);f.dom.window.URL.createObjectURL=x=>{exports.push(x);return 'blob:test';};f.statements[0].closing=-1400;f.root.querySelector('[data-supplier-task="statement"]').click();await tick();for(const kind of ['csv','pdf']){f.root.querySelector('[data-supplier-'+kind+']').click();await tick();await tick();assert.equal(exports.length,0);assert.match(f.root.querySelector('[data-supplier-read-status]').textContent,/Özet ve hareket/);}
});

test('CSV preserves reserved scope and explicit override reason with formula neutralization',async t=>{
 const f=fixture(t),blobs=[];f.dom.window.Blob=Blob;f.dom.window.URL.createObjectURL=b=>{blobs.push(b);return 'blob:test';};f.dom.window.URL.revokeObjectURL=()=>{};f.dom.window.HTMLAnchorElement.prototype.click=function(){};
 Object.assign(f.events[0].meta,{agreementId:'A-01',advanceScope:'reserved',allocations:[{sourceId:'source',purchaseId:'purchase',accountId:'has',unit:'HAS',quantity:1000,overrideReserved:true,reason:'=HYPERLINK("evil")'}]});Object.assign(f.events[1].meta,{agreementId:'B-02',advanceScope:'general'});
 f.root.querySelector('[data-supplier-task="statement"]').click();await tick();f.root.querySelector('[data-supplier-csv]').click();await tick();await tick();assert.equal(blobs.length,1);const csv=await blobs[0].text();assert.match(csv,/"Anlaşma ID";"Avans kapsamı";"Ayrılmış kaynak kullanım onayı";"Kullanım gerekçesi"/);assert.match(csv,/"A-01";"reserved";"true";"'=HYPERLINK\(""evil""\)"/);assert.match(csv,/"B-02";"general";"";""/);
});
