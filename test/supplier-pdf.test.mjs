import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {inflateSync} from 'node:zlib';
import {buildSupplierPdf, pdfBytes} from '../public/supplier-pdf.js';
const snapshot=()=>({revision:4,kind:'statement',scope:{startDate:'2026-01-01',endDate:'2026-01-31'},page:{supplier:{id:'f',name:'Şığüş İpek'},total:1,accounts:[{id:'h',name:'HAS hesabı',unit:'HAS',balance:99000}],statements:[{accountId:'h',unit:'HAS',opening:-10000,debtIncrease:0,debtDecrease:4000,creditIncrease:1000,creditDecrease:0,closing:-5000}]},catalog:[{id:'h',name:'HAS hesabı',unit:'HAS'},{id:'p',name:'Yüzük',unit:'ADET'}],events:[{id:'e1',date:'2026-01-02',type:'supplierReturn',label:'İade',status:'active',meta:{lines:[{accountId:'p',quantity:1,weight:1530}],creditLines:[{accountId:'h',quantity:5000}],reductions:[{accountId:'h',quantity:4000}]},balances:[{unit:'HAS',before:-10000,after:-5000,delta:5000}]}]});
test('PDF model preserves native units, unknown TL and period/current distinction as literal text',()=>{
 const s=snapshot();s.page.supplier.name='<img src=x onerror=alert(1)> Şığüş';
 const model=buildSupplierPdf(s),text=JSON.stringify(model);
 assert.doesNotMatch(text,/→/);assert.match(text,/Önce: -10,000 has gr; sonra: -5,000 has gr; etki: 5,000 has gr/);
 assert.match(text,/<img src=x onerror=alert\(1\)> Şığüş/);assert.match(text,/1,530 gr/);assert.match(text,/5,000 has gr/);assert.match(text,/Belirtilmedi/);assert.match(text,/Dönem sonu/);assert.match(text,/99,000 has gr/);assert.doesNotMatch(text,/"html"|"image"|"link"/);
 s.events[0].meta.referenceTL=0;assert.match(JSON.stringify(buildSupplierPdf(s)),/0,00 TL/);
 s.page.statements[0].creditIncrease=1000000000001;assert.match(JSON.stringify(buildSupplierPdf(s)),/1\.000\.000\.000,001 has gr/);
});
test('PDF rejects incomplete or unsafe numeric snapshots',()=>{
 const s=snapshot();s.page.total=2;assert.throws(()=>buildSupplierPdf(s),/tamam/);
 s.page.total=1;s.events[0].meta.creditLines[0].quantity=NaN;assert.throws(()=>buildSupplierPdf(s),/miktar/);
});
test('vendored renderer generates real paginated embedded-font PDF offline',async()=>{
 const require=createRequire(import.meta.url);
 // UMD browser bundle is evaluated in its own CommonJS wrapper for this Node-only test.
 const fs=await import('node:fs');const vm=await import('node:vm');
 const module={exports:{}};const sandbox={module,exports:module.exports,require,console,Buffer,setTimeout,clearTimeout,TextEncoder,TextDecoder};sandbox.global=sandbox;
 vm.runInNewContext(fs.readFileSync(new URL('../public/vendor/pdfmake/pdfmake.min.js',import.meta.url),'utf8'),sandbox);
 const fonts={module:{exports:{}}};vm.runInNewContext(fs.readFileSync(new URL('../public/vendor/pdfmake/vfs_fonts.js',import.meta.url),'utf8'),fonts);
 const engine=module.exports;engine.addVirtualFileSystem(fonts.module.exports);
 const s=snapshot();s.events=Array.from({length:65},(_,i)=>({...s.events[0],id:'e'+i}));s.page.total=65;
 const bytes=await pdfBytes(buildSupplierPdf(s),engine),raw=Buffer.from(bytes).toString('latin1');
 assert.ok(raw.startsWith('%PDF-'));assert.match(raw,/\/FontFile2/);assert.match(raw,/\/ToUnicode/);assert.ok((raw.match(/\/Type \/Page\b/g)||[]).length>1);assert.match(raw,/%%EOF/);
 const decoded=[...raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)].map(m=>{try{return inflateSync(Buffer.from(m[1],'latin1')).toString('latin1');}catch{return '';}}).join('\n');
 for(const code of ['0130','0131','015e','015f','011f','00fc'])assert.ok(decoded.toLowerCase().includes(code),'Turkish Unicode map '+code);
 if(process.env.PDF_EVIDENCE_PATH)fs.writeFileSync(process.env.PDF_EVIDENCE_PATH,bytes);
});
test('renderer errors reject the export rather than claiming success',async()=>{
 await assert.rejects(pdfBytes(buildSupplierPdf(snapshot()),{createPdf(){throw Error('font failure');}}),/font failure/);
});
