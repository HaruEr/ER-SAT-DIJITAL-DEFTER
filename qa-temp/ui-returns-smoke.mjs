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
  w.eval(readFileSync(new URL('../public/app.js',import.meta.url),'utf8')+'\nwindow.__returnView=setView;window.__returnReceipt=statementReceipt;');await tick();w.__returnView('journal');await tick();
  const set=(selector,value)=>{const el=w.document.querySelector(selector);assert.ok(el,selector);el.value=value;el.dispatchEvent(new w.Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));};
  return {w,doc:w.document,repo,commands,set,close(){w.close();repo.close();}};
}
let failed=0;
for(const [name,run] of [
  ['exchange links two products and collects only the confirmed difference',async f=>{
    f.set('[data-return-quantity="0"]','1');
    f.set('[name=refundProduct]','bilezikAdet');
    f.set('[name=refundProductQuantity]','1');f.set('[name=refundProductWeight]','9');
    f.set('[name=refundProductValue]','130');f.set('[name=returnOperation]','exchange');
    f.set('[data-return-note]','Sentetik değişim');
    const form=f.doc.querySelector('.sale-return-form');form.requestSubmit();
    assert.match(form.querySelector('[data-return-review]').textContent,/Tahsil edilecek.*30,00 TL/);
    assert.equal(f.commands.length,0);
    form.querySelector('[data-confirm-return]').click();await tick();
    assert.equal(f.commands[0].command.type,'retailExchange');
    assert.equal(f.repo.state().balances.nakit,123000);
    assert.equal(f.repo.state().balances.bilezik22,11000);
  }],
  ['mixed refund previews the product and only the remaining cash before posting',async f=>{
    f.set('[data-return-quantity="0"]','1');
    f.set('[name=refundProduct]','bilezikAdet');
    f.set('[name=refundProductQuantity]','1');
    f.set('[name=refundProductGroup]','bilezik22');
    f.set('[name=refundProductWeight]','9');
    f.set('[name=refundProductValue]','70');
    f.set('[data-return-note]','Sentetik karma karşılık');
    const form=f.doc.querySelector('.sale-return-form');
    assert.equal(form.querySelector('[data-return-refund]').value,'30.00');
    form.requestSubmit();assert.equal(f.commands.length,0);
    assert.match(form.querySelector('[data-return-review]').textContent,/9,000 gr/);
    form.querySelector('[data-confirm-return]').click();await tick();
    assert.deepEqual(f.commands[0].command.outgoing.map(r=>r.accountId),['bilezikAdet','nakit']);
    assert.equal(f.repo.state().balances.bilezik22,11000);
    assert.equal(f.repo.state().balances.nakit,117000);
  }],
  ['return and reverse-return receipts preserve actual paired grams and refund direction',async f=>{
    f.repo.execute({id:'paired-receipt-sale',revision:f.repo.state().revision,command:{type:'sale',date:'2026-10-28',items:[{accountId:'bilezikAdet',quantity:'2',weightAccount:'bilezik22',weight:'20',value:'1000'}],received:[{accountId:'nakit',quantity:'1000',valueTL:'1000'}],given:[],credits:[],debts:[]}});
    f.repo.execute({id:'paired-receipt-return',revision:f.repo.state().revision,command:{type:'saleReturn',date:'2026-10-28',originalId:'paired-receipt-sale',items:[{lineIndex:0,quantity:'1',weight:'9',value:'400'}],refunds:[{accountId:'nakit',quantity:'400',valueTL:'400'}],note:'Ölçülen iade'}});
    f.doc.querySelector('#refresh').click();await tick();const returned=f.repo.state().journal.at(-1),node=f.doc.createElement('div');node.innerHTML=f.w.__returnReceipt(returned);
    assert.match(node.querySelector('[data-receipt-direction="in"]').textContent,/9,000 gr/);assert.match(node.querySelector('[data-receipt-direction="out"]').textContent,/400,00 TL/);
    f.repo.execute({id:'paired-receipt-reverse',revision:f.repo.state().revision,command:{type:'reverse',date:'2026-10-28',originalId:returned.id,note:'İadeyi iptal'}});f.doc.querySelector('#refresh').click();await tick();node.innerHTML=f.w.__returnReceipt(f.repo.state().journal.at(-1),f.repo.state().journal);
    assert.match(node.querySelector('[data-receipt-direction="out"]').textContent,/9,000 gr/);assert.match(node.querySelector('[data-receipt-direction="in"]').textContent,/400,00 TL/);
  }],
  ['zero-value return keeps explicit zero TL and no invented outgoing refund',async f=>{
    f.repo.execute({id:'zero-return',revision:f.repo.state().revision,command:{type:'saleReturn',date:'2026-10-28',originalId:'source-sale',items:[{lineIndex:0,quantity:'1',value:'0'}],refunds:[],note:'Sıfır bedelli sentetik iade'}});
    const node=f.doc.createElement('div');node.innerHTML=f.w.__returnReceipt(f.repo.state().journal.at(-1));
    assert.match(node.querySelector('[data-receipt-direction="in"] .receipt-flow-value').textContent,/0,00 TL/);
    assert.equal(node.querySelector('[data-receipt-direction="out"] .receipt-flow-row'),null);
  }],
  ['return proposes proportional price but sends the explicit edited price and actual cash account',async f=>{
    const form=f.doc.querySelector('.sale-return-form');assert.ok(form);
    f.set('[data-return-quantity="0"]','1');
    assert.equal(f.doc.querySelector('[data-return-value="0"]').value,'100.00');
    f.set('[data-return-value="0"]','150');f.set('[data-return-note]','Anlaşılmış iade');
    form.dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));await tick();
    assert.equal(f.commands.length,0);assert.match(form.querySelector('[data-return-review]').textContent,/150,00 TL/);
    form.querySelector('[data-confirm-return]').click();await tick();
    assert.equal(f.commands.length,1);assert.equal(f.commands[0].command.type,'saleReturn');
    assert.equal(f.commands[0].command.refunds[0].accountId,'nakit');assert.equal(f.repo.state().balances.gramToplam,9000);assert.equal(f.repo.state().balances.nakit,105000);
    assert.equal(f.doc.querySelector('[data-return-quantity="0"]').value,'0');
  }],
  ['remaining quantity comes from server history and a new return cannot exceed it',async f=>{
    f.repo.execute({id:'prior-return',revision:f.repo.state().revision,command:{type:'saleReturn',date:'2026-10-28',originalId:'source-sale',items:[{lineIndex:0,quantity:'1',value:'100'}],refunds:[{accountId:'nakit',quantity:'100',valueTL:'100'}],note:'Önceki iade'}});
    f.doc.querySelector('#refresh').click();await tick();
    assert.match(f.doc.querySelector('.sale-return-form').textContent,/1,000 gr/);
    f.set('[data-return-quantity="0"]','2');f.set('[data-return-note]','Fazla iade');
    f.doc.querySelector('.sale-return-form').dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));await tick();
    assert.equal(f.commands.length,0);assert.equal(f.doc.querySelector('[data-confirm-return]'),null);
  }],
  ['an automatically corrected refund clears native validation and permits review',async f=>{
    f.set('[data-return-quantity="0"]','1');f.set('[data-return-note]','Anlaşılmış iade');
    f.set('[data-return-refund]','90');const form=f.doc.querySelector('.sale-return-form');form.requestSubmit();
    assert.equal(f.doc.querySelector('[data-return-refund]').validity.customError,true);
    f.set('[data-return-value="0"]','150');
    assert.equal(f.doc.querySelector('[data-return-refund]').validity.customError,false);
    form.requestSubmit();assert.ok(form.querySelector('[data-confirm-return]'));assert.equal(f.commands.length,0);
  }],
  ['paired returns require actual measured grams rather than an inferred average',async f=>{
    f.repo.execute({id:'paired-sale',revision:f.repo.state().revision,command:{type:'sale',date:'2026-10-28',items:[{accountId:'bilezikAdet',quantity:'2',weightAccount:'bilezik22',weight:'20',value:'200'}],cash:'200',pos:'0',bank:'0',scrapQuantity:'0',scrapValue:'0',note:'Farklı ağırlıklı iki ürün'}});
    f.doc.querySelector('#refresh').click();await tick();
    const form=f.doc.querySelector('#return-form-paired-sale');assert.ok(form);
    const q=form.querySelector('[data-return-quantity]');q.value='1';q.dispatchEvent(new f.w.Event('input',{bubbles:true}));
    const weight=form.querySelector('[data-return-weight]');assert.equal(weight.value,'');assert.equal(weight.required,true);
    form.querySelector('[data-return-note]').value='Gerçek tartımla iade';form.requestSubmit();
    assert.equal(form.querySelector('[data-confirm-return]'),null);assert.equal(f.commands.length,0);
    weight.value='7';weight.dispatchEvent(new f.w.Event('input',{bubbles:true}));form.requestSubmit();
    assert.ok(form.querySelector('[data-confirm-return]'));assert.equal(f.commands.length,0);
  }],
  ['return draft stays in memory on navigation and has no automatic submission',async f=>{
    f.set('[data-return-quantity="0"]','0.5');f.set('[data-return-value="0"]','75');f.set('[data-return-note]','İade taslağı');
    f.w.__returnView('overview');f.w.__returnView('journal');await tick();
    assert.equal(f.doc.querySelector('[data-return-value="0"]').value,'75');
    assert.equal(f.doc.querySelector('[data-return-note]').value,'İade taslağı');assert.equal(f.commands.length,0);
  }]
]){const f=await fixture();try{await run(f);console.log('PASS: '+name);}catch(e){failed++;console.error('FAIL: '+name+'\n'+e.stack);}finally{f.close();}}
if(failed)process.exitCode=1;else console.log('PASS: 9 sale return UI behavior checks using synthetic memory data.');
