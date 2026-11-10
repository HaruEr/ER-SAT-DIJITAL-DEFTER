import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {buildSupplierPdf,pdfBytes} from '../public/supplier-pdf.js';
const module={exports:{}},sandbox={module,exports:module.exports,require:createRequire(import.meta.url),console,Buffer,setTimeout,clearTimeout,TextEncoder,TextDecoder};sandbox.global=sandbox;
vm.runInNewContext(readFileSync(new URL('../public/vendor/pdfmake/pdfmake.min.js',import.meta.url),'utf8'),sandbox);
const fonts={module:{exports:{}}};vm.runInNewContext(readFileSync(new URL('../public/vendor/pdfmake/vfs_fonts.js',import.meta.url),'utf8'),fonts);
const engine=module.exports;engine.addVirtualFileSystem(fonts.module.exports);
const fixture=events=>({revision:1,kind:'history',scope:{},page:{supplier:{id:'f',name:'İpek Firma'},total:events.length,accounts:[],statements:[]},events,catalog:[]});
function pageTexts(model){const stream=engine.createPdf(model).getStream();const pages=stream._pdfMakePages.map(page=>page.items.filter(x=>x.type==='line').map(x=>x.item.inlines.map(i=>i.text).join('')).join('\n'));stream.on('data',()=>{});stream.end();return pages;}
test('ordinary receipts keep heading and last row on the same rendered page',()=>{
 const s=fixture(Array.from({length:18},(_,i)=>({id:'ordinary-'+i,date:'2026-11-10',label:'ORDINARY_'+i,status:'active',actor:{name:'END_'+i},meta:{note:'Normal fiş açıklaması',creditLines:[{accountId:'ag',unit:'SILVER',quantity:12345}]}})));
 const pages=pageTexts(buildSupplierPdf(s));assert.ok(pages.length>1);
 for(let i=0;i<18;i++){const start=pages.findIndex(p=>p.includes('ORDINARY_'+i+'\n')),end=pages.findIndex(p=>p.includes('Kaydeden: END_'+i+'\n')||p.endsWith('Kaydeden: END_'+i));assert.ok(start>=0);assert.equal(start,end,'receipt '+i+' must remain together');}
});
test('long receipts retain every row and repeat firm/date/event context on continuation',async()=>{
 const rows=Array.from({length:180},(_,i)=>({accountId:'ROW_'+String(i).padStart(4,'0'),unit:'ADET',quantity:i+1}));
 const s=fixture([{id:'LONG-ID',date:'2026-11-10',label:'Uzun fiş',status:'active',meta:{lines:rows}}]);
 const model=buildSupplierPdf(s),pages=pageTexts(model),all=pages.join('\n');assert.ok(pages.length>2);
 for(const page of pages.filter(p=>/ROW_/.test(p))){assert.match(page,/İpek Firma/);assert.match(page,/LONG-ID/);assert.match(page,/2026-11-10/);}
 for(const row of rows)assert.equal(all.split(row.accountId+':').length-1,1,'row retained exactly once '+row.accountId);
 const bytes=await pdfBytes(buildSupplierPdf(s),engine);assert.ok(Buffer.from(bytes).toString('latin1').startsWith('%PDF-'));
 if(process.env.PDF_LAYOUT_EVIDENCE)writeFileSync(process.env.PDF_LAYOUT_EVIDENCE,bytes);
});
test('silver section title uses human display without changing underlying unit',()=>{
 const s=fixture([]);s.page.statements=[{unit:'SILVER',opening:0,debtIncrease:0,debtDecrease:0,creditIncrease:0,creditDecrease:0,closing:0}];
 const model=buildSupplierPdf(s);assert.match(JSON.stringify(model),/Ag \/ saf gümüş/);assert.equal(s.page.statements[0].unit,'SILVER');
});
test('optional weight is not invented from absent values or unpaired stock sentinel zero',()=>{
 for(const weight of [undefined,null,'',0]){
   const s=fixture([{id:'quarter',date:'2026-11-10',label:'Çeyrek',meta:{lines:[{accountId:'ceyrek',unit:'ADET',quantity:1,weightAccount:null,weight}]}}]);
   assert.doesNotMatch(JSON.stringify(buildSupplierPdf(s)),/Gerçek ağırlık/,'unpaired or missing weight '+weight);
 }
 for(const [weight,expected] of [[0,'0,000 gr'],[1234,'1,234 gr']]){
   const s=fixture([{id:'measured',date:'2026-11-10',label:'Ölçülen',meta:{lines:[{accountId:'ring',unit:'ADET',quantity:1,weightAccount:'pool',weight}]}}]);
   assert.ok(JSON.stringify(buildSupplierPdf(s)).includes('Gerçek ağırlık '+expected));
 }
});
test('a very long wrapped receipt field remains complete across pages with context',()=>{
 const words=Array.from({length:1400},(_,i)=>'TOKEN'+String(i).padStart(4,'0'));
 const s=fixture([{id:'WRAPPED-ID',date:'2026-11-10',label:'Uzun açıklama',meta:{note:words.join(' ')}}]);
 const pages=pageTexts(buildSupplierPdf(s)),all=pages.join('\n');assert.ok(pages.length>2);
 for(const page of pages.filter(p=>p.includes('TOKEN'))){assert.match(page,/WRAPPED-ID/);assert.match(page,/İpek Firma/);}
 for(const word of words)assert.equal(all.split(word).length-1,1);
});
test('10k receipt PDF performance budget',{skip:!process.env.PDF_LAYOUT_BENCHMARK},async()=>{
 const s=fixture(Array.from({length:10000},(_,i)=>({id:'bench-'+i,date:'2026-11-10',label:'Ödeme',status:'active',meta:{givenLines:[{accountId:'cash',unit:'TL',quantity:1000}],creditLines:[{accountId:'silver',unit:'SILVER',quantity:12345}]}})));
 const start=performance.now(),bytes=await pdfBytes(buildSupplierPdf(s),engine),elapsed=performance.now()-start;
 console.log(JSON.stringify({receipts:10000,elapsedMs:Math.round(elapsed),bytes:bytes.length}));assert.ok(elapsed<60000,'PDF completes within 60 seconds');
});
