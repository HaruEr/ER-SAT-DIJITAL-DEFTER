import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadJSDOM } from '../test-support/jsdom.mjs';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS } from '../domain.mjs';
const JSDOM=await loadJSDOM();
const tick=async()=>{for(let i=0;i<4;i++)await new Promise(r=>setTimeout(r,0));};
async function fixture(){
  const repo=new Repository(':memory:','demo'),run=command=>repo.execute({id:randomUUID(),revision:repo.state().revision,command});
  const balances=Object.fromEntries(INITIAL_ACCOUNTS.filter(a=>!a.retired).map(a=>[a.id,a.id==='nakit'?'1000':a.id==='gramToplam'?'10':a.id==='bilezikAdet'?'2':a.id==='bilezik22'?'20':'0']));
  run({type:'opening',date:'2026-10-28',balances});
  repo.execute({id:'source-sale',revision:repo.state().revision,command:{type:'sale',date:'2026-10-28',items:[{accountId:'gramToplam',quantity:'2',value:'200'}],cash:'200',pos:'0',bank:'0',scrapQuantity:'0',scrapValue:'0',note:'Sentetik satış'}});
  const dom=new JSDOM(readFileSync(new URL('../public/index.html',import.meta.url),'utf8'),{url:'http://127.0.0.1:4317/',runScripts:'outside-only'}),w=dom.window;
  Object.defineProperty(w.crypto,'randomUUID',{value:randomUUID});const commands=[];
  w.fetch=async(url,options={})=>{const parsed=new URL(url,w.location.href);let result;try{
    if(parsed.pathname==='/api/state')result=repo.state({compact:true});
    else if(parsed.pathname==='/api/journal')result=repo.journalPage({...Object.fromEntries(parsed.searchParams),limit:Number(parsed.searchParams.get('limit')||25)});
    else if(parsed.pathname==='/api/command'){const envelope=JSON.parse(options.body);commands.push(envelope);result=repo.execute(envelope,{compact:true});}
    else throw new Error('Unexpected route');return {ok:true,status:200,json:async()=>result};
  }catch(e){return {ok:false,status:e.status||500,json:async()=>({error:e.message})};}};
  w.eval(readFileSync(new URL('../public/app.js',import.meta.url),'utf8')+'\nwindow.__returnView=setView;');await tick();w.__returnView('journal');await tick();
  const set=(selector,value)=>{const el=w.document.querySelector(selector);assert.ok(el,selector);el.value=value;el.dispatchEvent(new w.Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));};
  return {w,doc:w.document,repo,commands,set,close(){w.close();repo.close();}};
}

const tests=[
 ['Edit commits an amendment with the same financial values and keeps the source',async f=>{
 const before=f.repo.state();f.doc.querySelector('[data-edit-transaction]').click();await tick();f.set('#amend-reason','Açıklama kontrolü');const form=f.doc.querySelector('#edit-operation form');form.requestSubmit();await tick();assert.equal(f.commands.length,1);assert.equal(f.commands[0].command.type,'amend');assert.deepEqual(f.repo.state().balances,before.balances);assert.ok(f.repo.state().journal.some(e=>e.id==='source-sale'));assert.ok(f.repo.state().journal.some(e=>e.meta.amendsOriginalId==='source-sale'));
 }],
 ['Active partial return blocks full sale reversal with no balance change',async f=>{
 f.set('[data-return-quantity="0"]','1');f.set('[data-return-note]','Kısmi iade');let form=f.doc.querySelector('.sale-return-form');form.requestSubmit();form.querySelector('[data-confirm-return]').click();await tick();const before=f.repo.state();form=[...f.doc.querySelectorAll('.reverse-form')].find(x=>x.dataset.original==='source-sale');assert.ok(form);form.querySelector('input').value='Tam iptal denemesi';form.requestSubmit();form.querySelector('[data-confirm-reverse]').click();await tick();assert.deepEqual(f.repo.state().balances,before.balances);assert.equal(f.repo.state().revision,before.revision);assert.match(f.doc.body.textContent,/Aktif iadesi/);
 }],
 ['Reversing the return restores only its effects and leaves source sale active',async f=>{
 const before=f.repo.state();f.set('[data-return-quantity="0"]','1');f.set('[data-return-note]','Yanlış iade');let form=f.doc.querySelector('.sale-return-form');form.requestSubmit();form.querySelector('[data-confirm-return]').click();await tick();const returned=f.repo.state().journal.find(e=>e.type==='saleReturn');form=[...f.doc.querySelectorAll('.reverse-form')].find(x=>x.dataset.original===returned.id);form.querySelector('input').value='İadeyi geri al';form.requestSubmit();form.querySelector('[data-confirm-reverse]').click();await tick();assert.deepEqual(f.repo.state().balances,before.balances);assert.ok(!f.repo.state().journal.some(e=>e.type==='reverse'&&e.meta.originalId==='source-sale'));
 }],

 ['Action context distinguishes edit, return and full reversal without a write',async f=>{
 const article=f.doc.querySelector('.journal-item');assert.match(article.querySelector('.journal-record-context').textContent,/source-sale/);
 assert.match(article.querySelector('.journal-actions').textContent,/Eski etkiler/);
 assert.match(article.querySelector('.sale-return-form').closest('details').textContent,/cari borcunu kapatmaz/);
 assert.ok(article.querySelector('.journal-action-return').compareDocumentPosition(article.querySelector('.operation-more'))&f.w.Node.DOCUMENT_POSITION_FOLLOWING);assert.equal(f.commands.length,0);
 }],
 ['Full reversal requires review, shows original identity and reverses every original delta',async f=>{
 const original=f.repo.state().journal.find(e=>e.id==='source-sale'),before=f.repo.state();const form=f.doc.querySelector('.reverse-form');form.querySelector('input').value='Yanlış kayıt';form.requestSubmit();
 assert.equal(f.commands.length,0);assert.match(form.querySelector('[data-reverse-review]').textContent,/source-sale/);
 form.querySelector('[data-confirm-reverse]').click();await tick();assert.equal(f.commands[0].command.type,'reverse');for(const row of original.entries)assert.equal(f.repo.state().balances[row.accountId],before.balances[row.accountId]-row.delta);
 assert.ok(f.repo.state().journal.some(e=>e.id==='source-sale'));
 }],
 ['Return remains partial; changing review invalidates approval and preserves original sale',async f=>{
 f.set('[data-return-quantity="0"]','1');f.set('[data-return-note]','Bir gram iade');const form=f.doc.querySelector('.sale-return-form');form.requestSubmit();assert.equal(f.commands.length,0);assert.match(form.querySelector('[data-return-review]').textContent,/source-sale/);
 f.set('[data-return-value="0"]','120');assert.equal(form.querySelector('[data-confirm-return]'),null);form.requestSubmit();form.querySelector('[data-confirm-return]').click();await tick();assert.equal(f.commands[0].command.type,'saleReturn');assert.equal(f.repo.state().balances.gramToplam,9000);assert.equal(f.repo.state().balances.nakit,108000);assert.ok(f.repo.state().journal.some(e=>e.id==='source-sale'));
 }],
 ['Edit preserves record context and filter on return without committing',async f=>{
 const type=f.doc.querySelector('#journal-type');type.value='sale';type.dispatchEvent(new f.w.Event('change'));await tick();f.doc.querySelector('[data-edit-transaction]').click();await tick();assert.match(f.doc.querySelector('.edit-record-context').textContent,/source-sale/);assert.match(f.doc.querySelector('#main').textContent,/Eski kayıt korunur/);f.doc.querySelector('#cancel-edit').click();await tick();assert.equal(f.doc.querySelector('#journal-type').value,'sale');assert.equal(f.commands.length,0);
 }]
];
let failed=0;for(const [name,run] of tests){const f=await fixture();try{await run(f);console.log('PASS: '+name);}catch(e){failed++;console.error('FAIL: '+name+'\n'+e.stack);}finally{f.close();}}if(failed)process.exitCode=1;else console.log('PASS: '+tests.length+' D07 synthetic task checks.');
