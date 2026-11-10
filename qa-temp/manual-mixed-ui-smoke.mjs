import * as supplierModule from '../public/suppliers.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadJSDOM } from '../test-support/jsdom.mjs';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS } from '../domain.mjs';

const JSDOM = await loadJSDOM();
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const checks = [];
async function fixture() {
  const repo = new Repository(':memory:', 'demo');
  const run = command => repo.execute({ id: randomUUID(), revision: repo.state().revision, command: { date: repo.state().date, ...command } });
  run({ type: 'opening', date: '2026-10-28', balances: Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, ['nakit','banka'].includes(a.id) ? '10000' : ['gramToplam','usd','eur'].includes(a.id) ? '100' : a.id === 'pos' ? '500' : '0'])) });
  run({ type: 'account', name: 'Alacaklı Müşteri', unit: 'TL', opening: '200', partyType: 'customer', phone: '05550000001' });
  const claim = repo.state().accounts.at(-1).id;
  run({ type: 'account', name: 'Borçlu Müşteri', unit: 'TL', opening: '-300', partyType: 'customer' });
  const debt = repo.state().accounts.at(-1).id;
  run({ type: 'fundAccount', name: 'Örnek USD Bankası', unit: 'USD', opening: '10', physical: false });
  const bankUSD = repo.state().accounts.at(-1).id;
  run({type:'fundAccount',name:'Sentetik mevcut HAS hesabı',unit:'HAS',opening:'10',physical:true});
  const bankHAS=repo.state().accounts.at(-1).id;
  const dom = new JSDOM(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), { url: 'http://127.0.0.1:4317/', runScripts: 'outside-only' });
  const { window } = dom, document = window.document, commands = [], browserErrors=[];
  window.addEventListener('error',event=>browserErrors.push(String(event.error||event.message)));
  Object.defineProperty(window.crypto, 'randomUUID', { value: randomUUID });
  window.fetch = async (url, options) => {
    const parsed = new URL(url, window.location.href);
    try {
      let result;
      if (parsed.pathname === '/api/state') { result = structuredClone(repo.state()); result.accounts.find(a=>a.id===bankHAS).physical=false; } // Synthetic legacy bank presentation; new HAS banks are now rejected by domain.
      else if (parsed.pathname === '/api/command') { const envelope = JSON.parse(options.body); commands.push(envelope); result = repo.execute(envelope); }
      else if (parsed.pathname === '/api/journal') result = repo.journalPage({...Object.fromEntries(parsed.searchParams),limit:Number(parsed.searchParams.get('limit')||25)});
      else if(parsed.pathname === '/api/suppliers') result=repo.supplierDetail(Object.fromEntries(parsed.searchParams));
      else if (parsed.pathname === '/api/account-statement') result = repo.accountStatement(Object.fromEntries(parsed.searchParams));
      else throw new Error('Unexpected route ' + parsed.pathname);
      return { ok: true, status: 200, json: async () => result };
    } catch(error) { return { ok: false, status: error.status || 400, json: async () => ({ error: error.message }) }; }
  };
  window.__supplierModule=supplierModule;
window.eval(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace("import('./suppliers.js')","Promise.resolve(window.__supplierModule)") + '\nwindow.__tx = {setView, renderSale, beginTransactionEdit, journalFinancialMeta, journalItemMarkup, statementReceipt};');
  await tick();
  const set = (selector, value) => { const node = document.querySelector(selector); assert.ok(node, selector); node.value = value; node.dispatchEvent(new window.Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); };
  const tab = name => { if(['transfer','settlement'].includes(name)){window.__tx.setView('banks');document.querySelector(`[data-bank-action="${name}"]`).click();}else{window.__tx.setView('transaction');document.querySelector(`[data-tab="${name}"]`).click();} };
  const submit = id => document.querySelector(id).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  return { repo, run, window, document, commands, browserErrors, claim, debt, bankUSD, bankHAS, set, tab, submit, close() { window.close(); repo.close(); } };
}

checks.push(['cash sale carries selected customer and exposes both asset directions',async c=>{
 c.tab('sale');assert.ok(c.document.querySelector('#f-counterpartyId'));c.set('#f-counterpartyId',c.claim);
 c.set('[data-item-field="accountId"]','gramToplam');c.set('[data-item-field="quantity"]','1');c.set('[data-item-field="value"]','200');
 c.document.querySelector('[data-add-allocation="payment"][data-payment-type="cash"]').click();c.set('[data-allocation-kind="payment"] [data-allocation-field="quantity"]','250');
 c.document.querySelector('[data-add-allocation="counterpayment"][data-payment-type="cash"]').click();c.set('[data-allocation-kind="counterpayment"] [data-allocation-field="quantity"]','50');
 assert.match(c.document.querySelector('#sale-remainder').textContent,/Tam dengeli/);assert.match(c.document.querySelector('#trade-effects').textContent,/Alınan/);assert.match(c.document.querySelector('#trade-effects').textContent,/Verilen/);assert.match(c.document.querySelector('#trade-effects').textContent,/200,00 TL/);
 c.submit('#sale-form');await tick();const cmd=c.commands.at(-1).command;assert.equal(cmd.counterpartyId,c.claim);assert.equal(cmd.received[0].quantity,'250');assert.equal(cmd.given[0].quantity,'50');for(const field of ['payments','scrap','cash','pos','bank'])assert.equal(Object.hasOwn(cmd,field),false);assert.equal(c.repo.state().journal.at(-1).type,'sale');const receipt=c.window.__tx.journalFinancialMeta(c.repo.state().journal.at(-1));assert.match(receipt,/Alınan karşılık/);assert.match(receipt,/Verilen karşılık/);assert.equal((receipt.match(/250,00 TL/g)||[]).length,2);
 const sale=c.repo.state().journal.at(-1);c.window.__tx.setView('accounts');c.document.querySelector(`[data-account-detail="${c.claim}"]`).click();await tick();await tick();const detail=[...c.document.querySelectorAll('.statement-receipt')].find(d=>d.textContent.includes(sale.id));assert.ok(detail,'cash sale with zero customer delta must remain in statement: '+c.document.querySelector('#statement-status')?.textContent);assert.match(detail.textContent,/Mağazaya girenler/);assert.match(detail.textContent,/Mağazadan çıkanlar/);assert.match(detail.textContent,/250,00 TL/);assert.match(detail.closest('tr').lastElementChild.textContent,/0,00 TL/);assert.equal(detail.querySelector('[data-edit-transaction],.reverse-form,.sale-return-form'),null);
}]);
checks.push(['native supplier mixed purchase receipt preserves opposing physical and native amounts',async c=>{
 c.run({type:'supplierFirm',name:'Karma firma'});const supplierId=c.repo.state().supplierParties.at(-1).id;
 c.run({type:'supplierUnit',supplierId,unit:'TL'});const id=c.repo.state().accounts.at(-1).id;
 c.run({type:'supplierPurchase',supplierId,items:[{accountId:'gramToplam',quantity:'1'}],charges:[{accountId:id,quantity:'100'}],given:[{accountId:'nakit',quantity:'120'}],credits:[{accountId:id,quantity:'120'}],received:[{accountId:'nakit',quantity:'20'}],debts:[{accountId:id,quantity:'20'}],debtUses:[{accountId:id,quantity:'20'}]});
 c.document.querySelector('#refresh').click();await tick();const event=c.repo.state().journal.at(-1),receipt=c.document.createElement('div');receipt.innerHTML=c.window.__tx.statementReceipt(event);
 assert.match(receipt.querySelector('[data-receipt-direction="in"]').textContent,/20,00 TL/);assert.match(receipt.querySelector('[data-receipt-direction="out"]').textContent,/120,00 TL/);
 assert.match(receipt.querySelector('.receipt-cari').textContent,/100,00 TL/);assert.equal(c.repo.state().balances[id],0);assert.equal(receipt.querySelector('.receipt-trade-summary'),null,'unknown TL reference is not a fabricated total');
}]);
checks.push(['supplier HAS debt paid with gold uses native payment without sale revenue',async c=>{
 c.run({type:'account',name:'Sentetik HAS Firma',unit:'HAS',opening:'-10',partyType:'supplier'});const id=c.repo.state().accounts.at(-1).id;
 c.document.querySelector('#refresh').click();await tick();c.window.__tx.setView('suppliers');await tick();c.document.querySelector('[data-open-firm="'+id+'"]').click();c.document.querySelector('[data-supplier-task="payment"]').click();
 const row=(group,field)=>'[data-group="'+group+'"] [data-field="'+field+'"]';c.set(row('given','accountId'),'gramToplam');c.set(row('given','quantity'),'1');c.set(row('credits','accountId'),id);c.set(row('credits','quantity'),'2.345');c.set('[name="advanceScope"]','general');
 c.submit('[data-supplier-form="payment"]');await tick();const event=c.repo.state().journal.at(-1);assert.equal(event.type,'supplierPayment');assert.equal(c.repo.state().balances[id],-7655);assert.equal(event.meta.revenue||0,0);
 const receipt=c.document.createElement('div');receipt.innerHTML=c.window.__tx.statementReceipt(event);assert.equal(receipt.querySelector('[data-receipt-direction="in"] .receipt-flow-row'),null);assert.match(receipt.querySelector('[data-receipt-direction="out"] .receipt-flow-row').textContent,/1,000 gr/);assert.match(receipt.querySelector('.receipt-cari').textContent,/2,345 has gr/);
}]);
checks.push(['paired stock counterleg and selected party survive draft and v6 edit; mismatch blocked',async c=>{
 c.tab('sale');c.set('#f-counterpartyId',c.claim);c.set('[data-item-field="accountId"]','gramToplam');c.set('[data-item-field="value"]','100');c.document.querySelector('[data-add-allocation="payment"][data-payment-type="asset"]').click();c.set('[data-allocation-kind="payment"] select','bilezikAdet');c.set('[data-allocation-kind="payment"] [data-allocation-field="quantity"]','1');c.set('[data-allocation-kind="payment"] [data-allocation-field="weight"]','7');c.set('[data-allocation-kind="payment"] [data-allocation-field="valueTL"]','100');c.window.__tx.setView('overview');c.tab('sale');assert.equal(c.document.querySelector('[data-allocation-field="weight"]').value,'7');assert.equal(c.document.querySelector('#f-counterpartyId').value,c.claim);
 c.submit('#sale-form');await tick();const event=c.repo.state().journal.at(-1);assert.equal(event.type,'sale');assert.equal(event.meta.receivedLines[0].weight,7000);c.window.__tx.beginTransactionEdit(event);await tick();assert.equal(c.document.querySelector('[data-allocation-field="weight"]').value,'7');assert.equal(c.document.querySelector('[data-allocation-field="weightAccount"]').value,'bilezik22');
 c.tab('sale');c.set('#f-counterpartyId',c.claim);c.document.querySelector('[data-add-allocation="debt"]').click();c.set('#f-counterpartyId',c.debt);assert.equal(c.document.querySelector('[data-allocation-kind="debt"] select').validity.valid,false);
}]);
checks.push(['journal primary/secondary filters retain scope and clear only active narrowing filters',async c=>{
 c.window.__tx.setView('journal');await tick();assert.equal(c.document.querySelectorAll('.journal-filters-primary input,.journal-filters-primary select').length,2);assert.equal(c.document.querySelectorAll('.journal-filters-secondary input,.journal-filters-secondary select').length,4);c.set('#journal-scope','all');c.set('#journal-search','Sentetik');c.set('#journal-account',c.claim);await tick();assert.match(c.document.querySelector('#journal-active-filters').textContent,/Bütün geçmiş/);assert.match(c.document.querySelector('#journal-active-filters').textContent,/Alacaklı Müşteri/);c.window.__tx.setView('overview');c.window.__tx.setView('journal');await tick();assert.equal(c.document.querySelector('#journal-account').value,c.claim);c.document.querySelector('#journal-clear').click();await tick();assert.equal(c.document.querySelector('#journal-scope').value,'all');assert.equal(c.document.querySelector('#journal-account').value,'');assert.equal(c.document.querySelector('#journal-search').value,'');assert.equal(c.document.activeElement.id,'journal-search');
}]);
checks.push(['mixed receipt groups all incoming and outgoing assets with attached weights in journal and statement',async c=>{
 c.run({type:'purchase',source:'customer',items:[{accountId:'bilezikAdet',quantity:'1',weightAccount:'bilezik22',weight:'17.330',value:'100'},{accountId:'kupe',quantity:'1',weightAccount:'taki14',weight:'1.740',value:'100'}],payments:[{accountId:'nakit',quantity:'200',valueTL:'200'}],debts:[]});
 c.run({type:'sale',counterpartyId:c.claim,counterpartyType:'customer',items:[{accountId:'bilezikAdet',quantity:'1',weightAccount:'bilezik22',weight:'17.330',value:'18550'}],received:[{accountId:'nakit',quantity:'12500',valueTL:'12500'},{accountId:'ceyrek',quantity:'2',valueTL:'21000'}],given:[{accountId:'kupe',quantity:'1',weightAccount:'taki14',weight:'1.740',valueTL:'14500'},{accountId:'nakit',quantity:'450',valueTL:'450'}],credits:[],debts:[]});
 c.document.querySelector('#refresh').click();await tick();const event=c.repo.state().journal.at(-1);
 const roots=[c.window.__tx.journalItemMarkup(event,new Set()),c.window.__tx.statementReceipt(event)].map(html=>{const node=c.document.createElement('div');node.innerHTML=html;return node;});
 for(const root of roots){
  const incoming=root.querySelector('[data-receipt-direction="in"]'),outgoing=root.querySelector('[data-receipt-direction="out"]');assert.ok(incoming);assert.ok(outgoing);
  assert.match(incoming.textContent,/Mağazaya girenler/);assert.match(outgoing.textContent,/Mağazadan çıkanlar/);
  assert.equal(incoming.querySelectorAll('.receipt-flow-row').length,2);assert.equal(outgoing.querySelectorAll('.receipt-flow-row').length,3);
  const row=(group,id)=>group.querySelector(`[data-receipt-account="${id}"]`);
  assert.match(row(incoming,'nakit').textContent,/12.500,00 TL/);assert.match(row(incoming,'ceyrek').textContent,/2 adet/);assert.match(row(incoming,'ceyrek').textContent,/21.000,00 TL/);
  assert.match(row(outgoing,'bilezikAdet').textContent,/17,330 gr/);assert.match(row(outgoing,'bilezikAdet').textContent,/18.550,00 TL/);
  assert.match(row(outgoing,'kupe').textContent,/1,740 gr/);assert.match(row(outgoing,'kupe').textContent,/14.500,00 TL/);assert.match(row(outgoing,'nakit').textContent,/450,00 TL/);
  assert.equal(root.querySelectorAll('[data-receipt-account="bilezikAdet"]').length,1);assert.equal(root.querySelectorAll('[data-receipt-account="taki14"]').length,0);
 }
 assert.equal(roots[0].querySelector('.receipt-flow').innerHTML,roots[1].querySelector('.receipt-flow').innerHTML);
 assert.ok(roots[0].querySelector('.receipt-account-effects summary'));
}]);
checks.push(['purchase direction and cari are distinct; unsupported records retain neutral fallback',async c=>{
 const event={id:'synthetic-receipt',type:'purchase',label:'Karma alış',date:'2026-10-28',timestamp:'2026-10-28T12:00:00Z',entries:[],meta:{source:'customer',counterpartyId:c.claim,lines:[{accountId:'bilezikAdet',quantity:1,weightAccount:'bilezik22',weight:17330,value:10000}],receivedLines:[{accountId:'ceyrek',quantity:1,valueTL:5000}],givenLines:[{accountId:'nakit',quantity:14000,valueTL:14000}],creditLines:[{accountId:c.claim,quantity:1000,valueTL:1000}],debtLines:[{accountId:c.claim,quantity:2000,valueTL:2000}],purchaseTotal:10000,outstanding:1000}};
 const root=c.document.createElement('div');root.innerHTML=c.window.__tx.statementReceipt(event);
 assert.equal(root.querySelector('[data-receipt-direction="in"]').querySelectorAll('.receipt-flow-row').length,2);
 assert.equal(root.querySelector('[data-receipt-direction="out"]').querySelectorAll('.receipt-flow-row').length,1);
 assert.equal(root.querySelector('.receipt-flow').textContent.includes('Alacaklı Müşteri'),false);assert.match(root.querySelector('.receipt-cari').textContent,/Alacaklı Müşteri/);assert.match(root.querySelector('.receipt-cari').textContent,/Borcumuz artar/);
 for(const type of ['movement']){root.innerHTML=c.window.__tx.statementReceipt({...event,type});assert.equal(root.querySelector('.receipt-flow'),null,type);}
 const legacy=structuredClone(event);legacy.type='sale';delete legacy.meta.receivedLines;delete legacy.meta.givenLines;
 root.innerHTML=c.window.__tx.statementReceipt(legacy);assert.equal(root.querySelector('.receipt-flow'),null,'legacy safe fallback');assert.match(root.textContent,/İşlem ürünleri/);
}]);
checks.push(['partial preview keeps completed TL difference while blank rows prevent saving',async c=>{
 c.tab('sale');c.set('#f-counterpartyId',c.claim);c.set('[data-item-field="accountId"]','yuzuk');c.set('[data-item-field="weight"]','9.040');c.set('[data-item-field="value"]','72500');
 c.document.querySelector('[data-add-allocation="payment"][data-payment-type="cash"]').click();c.set('[data-allocation-kind="payment"] [data-allocation-field="quantity"]','500');
 c.document.querySelector('[data-add-allocation="scrap"]').click();c.set('[data-allocation-kind="scrap"] [data-allocation-field="quantity"]','15.040');c.set('[data-allocation-kind="scrap"] [data-allocation-field="valueTL"]','98000');
 c.document.querySelector('[data-add-allocation="debt"]').click();
 const preview=()=>c.document.querySelector('#sale-remainder').textContent,balanced=()=>c.document.querySelector('#sale-form button[type="submit"]').dataset.balanced;
 assert.match(preview(),/Geçici/);assert.match(preview(),/26.000,00 TL/);assert.match(preview(),/1 eksik/);assert.equal(balanced(),'false');assert.equal(c.document.querySelector('[data-allocation-kind="debt"] [data-allocation-field="quantity"]').value,'');
 c.document.querySelector('[data-add-allocation="counterpayment"][data-payment-type="cash"]').click();c.set('[data-allocation-kind="counterpayment"] [data-allocation-field="quantity"]','26000');assert.match(preview(),/Geçici/);assert.match(preview(),/0,00 TL/);assert.equal(balanced(),'false');c.submit('#sale-form');await tick();assert.equal(c.commands.length,0);
 c.document.querySelector('[data-allocation-kind="debt"] [data-remove-allocation]').click();assert.equal(preview(),'Tam dengeli');assert.equal(balanced(),'true');
 c.set('[data-item-field="weight"]','');assert.match(preview(),/1 eksik/);assert.equal(balanced(),'false');
 c.set('[data-item-field="weight"]','9.040');c.set('[data-allocation-kind="scrap"] [data-allocation-field="valueTL"]','bad');assert.match(preview(),/1 eksik/);assert.equal(balanced(),'false');assert.doesNotMatch(preview(),/NaN|Infinity/);assert.match(preview(),/98.000,00 TL/);
}]);
checks.push(['purchase and collection partial previews require explicit non-TL values and reject overflow',async c=>{
 c.tab('purchase');c.set('[data-item-field="accountId"]','gramToplam');c.set('[data-item-field="value"]','100');
 c.document.querySelector('[data-add-allocation="payment"][data-payment-type="foreign"]').click();c.set('[data-allocation-kind="payment"] select','usd');c.set('[data-allocation-kind="payment"] [data-allocation-field="quantity"]','2');
 assert.match(c.document.querySelector('#sale-remainder').textContent,/Geçici/);assert.match(c.document.querySelector('#sale-remainder').textContent,/100,00 TL/);assert.equal(c.document.querySelector('[data-allocation-kind="payment"] [data-allocation-field="valueTL"]').value,'');
 c.set('[data-allocation-kind="payment"] [data-allocation-field="valueTL"]','100');assert.equal(c.document.querySelector('#sale-form button[type="submit"]').dataset.balanced,'true');
 c.set('[data-item-field="value"]','10000000000');c.document.querySelector('#add-sale-item').click();const items=c.document.querySelectorAll('.sale-item');const last=items[1];last.querySelector('[data-item-field="accountId"]') .value='gramToplam';last.querySelector('[data-item-field="accountId"]') .dispatchEvent(new c.window.Event('change',{bubbles:true}));last.querySelector('[data-item-field="value"]').value='10000000000';last.querySelector('[data-item-field="value"]').dispatchEvent(new c.window.Event('input',{bubbles:true}));assert.equal(c.document.querySelector('#sale-form button[type="submit"]').dataset.balanced,'false');assert.match(c.document.querySelector('#sale-remainder').textContent,/sınır/);
 c.tab('collection');c.set('#f-customerAccount',c.claim);c.document.querySelector('[data-open-exchange]').click();
 c.document.querySelector('[data-add-allocation="payment"][data-payment-type="cash"]').click();c.set('[data-allocation-kind="payment"] [data-allocation-field="quantity"]','50');c.document.querySelector('[data-add-allocation="counterdebt"]').click();
 assert.match(c.document.querySelector('#sale-remainder').textContent,/Geçici/);assert.match(c.document.querySelector('#sale-remainder').textContent,/50,00 TL/);assert.equal(c.document.querySelector('#sale-form button[type="submit"]').dataset.balanced,'false');
}]);
checks.push(['reversal preserves verified original gross legs and falls back to signed entries without invented prices',async c=>{
 c.run({type:'sale',items:[{accountId:'gramToplam',quantity:'1',value:'200'}],received:[{accountId:'nakit',quantity:'250',valueTL:'250'}],given:[{accountId:'nakit',quantity:'50',valueTL:'50'}],credits:[],debts:[]});const original=c.repo.state().journal.at(-1);c.run({type:'reverse',originalId:original.id,note:'Sentetik iptal'});c.document.querySelector('#refresh').click();await tick();const reverse=c.repo.state().journal.at(-1);
 const node=c.document.createElement('div');node.innerHTML=c.window.__tx.statementReceipt(reverse);
 assert.match(node.querySelector('[data-receipt-direction="in"]').textContent,/50,00 TL/);assert.match(node.querySelector('[data-receipt-direction="out"]').textContent,/250,00 TL/);assert.match(node.querySelector('[data-receipt-direction="in"]').textContent,/1,000 gr/);
 for(const record of [{...reverse,meta:{...reverse.meta,originalId:'unavailable'}},{...reverse,entries:[{accountId:'nakit',delta:123},{accountId:c.claim,delta:-200}]}]){
  node.innerHTML=c.window.__tx.statementReceipt(record);assert.ok(node.querySelector('.receipt-flow'));assert.match(node.textContent,/Hesap hareketlerinden/);assert.doesNotMatch(node.querySelector('.receipt-flow').textContent,/Anlaşılmış TL karşılığı/);
  if(record.entries.length===2){assert.match(node.querySelector('.receipt-cari').textContent,/Alacaklı Müşteri/);assert.equal(node.querySelector('.receipt-flow').textContent.includes('Alacaklı Müşteri'),false);}
 }
}]);
checks.push(['draft preview groups sale product/counterpayment out, cash/scrap in and incomplete cari separately',async c=>{
 c.run({type:'account',name:'<img src=x onerror=alert(1)>',unit:'TL',opening:'0',partyType:'customer'});const party=c.repo.state().accounts.at(-1).id;c.document.querySelector('#refresh').click();await tick();
 c.tab('sale');c.set('#f-counterpartyId',party);c.set('[data-item-field="accountId"]','yuzuk');c.set('[data-item-field="value"]','72500');
 c.document.querySelector('[data-add-allocation="payment"][data-payment-type="cash"]').click();c.set('[data-allocation-kind="payment"] [data-allocation-field="quantity"]','500');
 c.document.querySelector('[data-add-allocation="scrap"]').click();c.set('[data-allocation-kind="scrap"] [data-allocation-field="quantity"]','15.040');c.set('[data-allocation-kind="scrap"] [data-allocation-field="valueTL"]','98000');
 c.document.querySelector('[data-add-allocation="counterpayment"][data-payment-type="cash"]').click();c.set('[data-allocation-kind="counterpayment"] [data-allocation-field="quantity"]','26000');c.document.querySelector('[data-add-allocation="debt"]').click();
 const preview=c.document.querySelector('#trade-effects'),incoming=preview.querySelector('[data-draft-direction="in"]'),outgoing=preview.querySelector('[data-draft-direction="out"]');
 assert.ok(incoming);assert.ok(outgoing);assert.equal(incoming.querySelectorAll('.draft-flow-row').length,2);assert.equal(outgoing.querySelectorAll('.draft-flow-row').length,2);
 assert.match(incoming.textContent,/500,00 TL/);assert.match(incoming.textContent,/15,040 gr/);assert.match(incoming.textContent,/98.000,00 TL/);assert.match(outgoing.textContent,/72.500,00 TL/);assert.match(outgoing.textContent,/Ağırlık: Eksik/);assert.match(outgoing.textContent,/26.000,00 TL/);
 assert.match(preview.querySelector('.receipt-cari').textContent,/Cari alacağımız/);assert.match(preview.querySelector('.receipt-cari').textContent,/Eksik/);assert.match(preview.querySelector('.receipt-cari').textContent,/Cari bakiye:/);
 assert.equal(preview.querySelector('.draft-flow').textContent.includes('<img'),false);assert.equal(preview.querySelector('img'),null);assert.equal(preview.querySelectorAll('.draft-party').length,1);assert.match(preview.querySelector('.draft-party').textContent,/<img src=x onerror=alert\(1\)>/);
 c.set('[data-item-field="weight"]','9.040');assert.match(preview.querySelector('[data-draft-direction="out"]').textContent,/9,040 gr/);c.document.querySelector('[data-allocation-kind="debt"] [data-remove-allocation]').click();assert.equal(c.document.querySelector('#sale-form button[type="submit"]').dataset.balanced,'true');
}]);
checks.push(['draft purchase and collection keep directions, explicit foreign TL and cari balance transitions',async c=>{
 c.tab('purchase');c.set('#f-counterpartyId',c.claim);c.set('[data-item-field="accountId"]','gramToplam');c.set('[data-item-field="value"]','100');
 c.document.querySelector('[data-add-allocation="payment"][data-payment-type="foreign"]').click();c.set('[data-allocation-kind="payment"] select','usd');c.set('[data-allocation-kind="payment"] [data-allocation-field="quantity"]','2');
 c.document.querySelector('[data-add-allocation="counterpayment"][data-payment-type="cash"]').click();c.set('[data-allocation-kind="counterpayment"] [data-allocation-field="quantity"]','20');
 let preview=c.document.querySelector('#trade-effects');assert.equal(preview.querySelector('[data-draft-direction="in"]').querySelectorAll('.draft-flow-row').length,2);assert.match(preview.querySelector('[data-draft-direction="in"]').textContent,/100,00 TL/);assert.match(preview.querySelector('[data-draft-direction="out"]').textContent,/2,00 USD/);assert.match(preview.querySelector('[data-draft-direction="out"]').textContent,/Eksik/);
 c.tab('collection');c.set('#f-customerAccount',c.claim);c.document.querySelector('[data-open-exchange]').click();c.document.querySelector('[data-add-allocation="payment"][data-payment-type="cash"]').click();c.set('[data-allocation-kind="payment"] [data-allocation-field="quantity"]','50');c.document.querySelector('[data-add-allocation="counterdebt"]').click();c.set('[data-allocation-kind="counterdebt"] [data-allocation-field="quantity"]','50');
 preview=c.document.querySelector('#trade-effects');assert.match(preview.querySelector('[data-draft-direction="in"]').textContent,/50,00 TL/);assert.equal(preview.querySelector('[data-draft-direction="out"] .draft-flow-row'),null);assert.match(preview.querySelector('[data-draft-direction="out"]').textContent,/Bu yönde/);assert.match(preview.querySelector('.receipt-cari').textContent,/200,00 TL · Alacağımız → 150,00 TL · Alacağımız/);assert.equal(preview.querySelector('.draft-flow').textContent.includes('Alacaklı Müşteri'),false);
}]);
let failures=0;for(const [name,check] of checks){const c=await fixture();try{await check(c);assert.deepEqual(c.browserErrors,[],'No swallowed browser event errors');console.log('PASS:',name);}catch(error){failures++;console.error('FAIL:',name,error.stack);}finally{c.close();}}if(failures)process.exitCode=1;else console.log(`PASS: ${checks.length} mixed UI checks.`);

