import * as supplierModule from '../public/suppliers.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadJSDOM } from '../test-support/jsdom.mjs';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS } from '../domain.mjs';

const JSDOM = await loadJSDOM();
const tick = async () => {for(let i=0;i<4;i++)await new Promise(resolve=>setTimeout(resolve,0));};
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
  const dom = new JSDOM(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), { url: 'http://127.0.0.1:4317/', runScripts: 'outside-only' });
  const { window } = dom, document = window.document, commands = [];
  Object.defineProperty(window.crypto, 'randomUUID', { value: randomUUID });
  window.fetch = async (url, options) => {
    const parsed = new URL(url, window.location.href);
    try {
      let result;
      if (parsed.pathname === '/api/state') result = repo.state();
      else if (parsed.pathname === '/api/suppliers') result = repo.supplierDetail({...Object.fromEntries(parsed.searchParams),limit:50});
      else if (parsed.pathname === '/api/command') { const envelope = JSON.parse(options.body); commands.push(envelope); result = repo.execute(envelope); }
      else if (parsed.pathname === '/api/journal') result = repo.journalPage(Object.fromEntries(parsed.searchParams));
      else if (parsed.pathname === '/api/account-statement') result = repo.accountStatement(Object.fromEntries(parsed.searchParams));
      else throw new Error('Unexpected route ' + parsed.pathname);
      return { ok: true, status: 200, json: async () => result };
    } catch(error) { return { ok: false, status: error.status || 400, json: async () => ({ error: error.message }) }; }
  };
  window.__supplierModule=supplierModule;
window.eval(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace("import(\'./suppliers.js\')","Promise.resolve(window.__supplierModule)") + '\nwindow.__tx = {setView, renderSale, beginTransactionEdit};');
  await tick();
  const set = (selector, value) => { const node = document.querySelector(selector); assert.ok(node, selector); node.value = value; node.dispatchEvent(new window.Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); };
  const tab = name => { if(['transfer','settlement'].includes(name)){window.__tx.setView('banks');document.querySelector(`[data-bank-action="${name}"]`).click();}else{window.__tx.setView('transaction');document.querySelector(`[data-tab="${name}"]`).click();} };
  const submit = id => document.querySelector(id).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  return { repo, run, window, document, commands, claim, debt, bankUSD, set, tab, submit, close() { window.close(); repo.close(); } };
}

checks.push(['four clear categories, optional notes and hidden unused fields', async c => {
  c.tab('sale');
  assert.equal(c.document.querySelectorAll('.transaction-primary [data-tab]').length, 4);
  assert.equal(c.document.querySelector('[data-tab="account"]'), null);
  assert.equal(c.document.querySelector('[data-tab="fund"]'), null);
  assert.equal(c.document.querySelector('#f-note').required, false);
  assert.equal(c.document.querySelectorAll('[data-allocation-kind]').length, 0);
  c.set('[data-item-field="accountId"]', 'gramToplam');
  assert.ok(c.document.querySelector('[data-item-field="weight"]').closest('label').hidden);
  assert.ok(c.document.querySelector('[data-item-field="weightAccount"]').closest('label').hidden);
  assert.equal(c.document.querySelector('[data-remove-item]').disabled, true);
  assert.equal(c.document.querySelector('#inline-account-form'),null);
  c.document.querySelector('[data-create-party]').click();assert.equal(c.document.querySelector('#f-phone').required,false);c.document.querySelector('[data-return-operation]').click();
}]);
checks.push(['selected split payment records a balanced sale without description', async c => {
  c.tab('sale'); c.set('[data-item-field="accountId"]','gramToplam'); c.set('[data-item-field="quantity"]','1'); c.set('[data-item-field="value"]','100');
  c.document.querySelector('[data-payment-type="cash"]').click(); c.set('[data-allocation-kind="payment"] [data-allocation-field="quantity"]','60');
  assert.ok(c.document.querySelector('[data-allocation-field="valueTL"]').closest('label').hidden);
  c.document.querySelector('[data-payment-type="pos"]').click();
  const pos = c.document.querySelectorAll('[data-allocation-kind="payment"]')[1].querySelector('[data-allocation-field="quantity"]'); c.set('#'+pos.id,'40');
  assert.match(c.document.querySelector('#sale-remainder').textContent,/Tam dengeli/);
  c.submit('#sale-form'); await tick();
  assert.equal(c.repo.state().journal.at(-1).type,'sale',c.document.querySelector('#notice').textContent);
  assert.equal(c.commands.at(-1).command.note,''); assert.equal(c.commands.at(-1).command.received.length,2);
}]);
checks.push(['purchase customer choice and no stock balances in product options', async c => {
  c.tab('purchase'); assert.equal(c.document.querySelector('#f-source'),null);
  assert.ok(c.document.querySelector('#f-counterpartyId'));
  const product=c.document.querySelector('[data-item-field="accountId"]');
  assert.ok([...product.options].every(option=>!option.textContent.includes(' · ')));
  for(const id of ['hurda8','hurda14','hurda18','hurda21','hurda22','hurda24']) assert.ok([...product.options].some(option=>option.value===id),id);
  assert.equal(c.document.querySelector('[data-add-allocation="payment"][data-payment-type="pos"]'),null);
}]);
checks.push(['collection filters determine the only valid direction', async c => {
  c.tab('collection'); c.set('#f-customerAccount',c.claim);
  assert.deepEqual([...c.document.querySelector('#f-direction').options].map(o=>o.value),['collect']);
  c.set('#collection-filter','debt'); assert.equal(c.document.querySelector('#f-customerAccount').value,c.debt);
  assert.deepEqual([...c.document.querySelector('#f-direction').options].map(o=>o.value),['pay']);
  c.set('#collection-search','eşleşmeyen'); assert.equal(c.document.querySelector('#collection-form button[type="submit"]').disabled,true);
}]);
checks.push(['foreign bank transfer and expected POS amount derive commission', async c => {
  c.tab('transfer'); c.set('#f-fromAccount','usd');
  assert.ok([...c.document.querySelector('#f-toAccount').options].some(o=>o.value===c.bankUSD));
  c.tab('settlement'); c.set('#f-gross','200'); c.set('#f-expected','195');
  assert.equal(c.document.querySelector('#f-fee').value,'5.00'); assert.equal(c.document.querySelector('#f-fee').readOnly,true);
  c.submit('#settlement-form'); await tick(); assert.equal(c.commands.at(-1).command.fee,'5.00');
  assert.equal(c.repo.state().journal.at(-1).type,'settlement',c.document.querySelector('#notice').textContent);
}]);
checks.push(['multiple scrap purities and split foreign payment preserve their units', async c => {
  c.tab('sale');c.set('[data-item-field="accountId"]','gramToplam');c.set('[data-item-field="quantity"]','1');c.set('[data-item-field="value"]','100');
  const add=(kind,id,quantity,value)=>{c.document.querySelector(kind==='payment'?'[data-payment-type="foreign"]':`[data-add-allocation="${kind}"]`).click();const row=c.document.querySelectorAll(`[data-allocation-kind="${kind}"]`);const last=row[row.length-1];c.set('#'+last.querySelector('select').id,id);c.set('#'+last.querySelector('[data-allocation-field="quantity"]').id,quantity);c.set('#'+last.querySelector('[data-allocation-field="valueTL"]').id,value);};
  add('scrap','hurda8','1.2','20');add('scrap','hurda21','0.8','30');add('payment','usd','1','50');
  c.window.__tx.setView('overview');c.window.__tx.setView('transaction');
  assert.equal(c.document.querySelectorAll('[data-allocation-kind="scrap"]').length,2);
  assert.equal(c.document.querySelector('[data-allocation-kind="payment"] select').value,'usd');
  c.submit('#sale-form');await tick();
  assert.equal(c.repo.state().journal.at(-1).type,'sale',c.document.querySelector('#notice').textContent);
  assert.equal(c.repo.state().balances.hurda8,1200);assert.equal(c.repo.state().balances.hurda21,800);assert.equal(c.repo.state().balances.usd,10100);
}]);
checks.push(['cash customer purchase stores payee and cannot overpay', async c => {
  c.tab('purchase');c.set('#f-counterpartyId',c.claim);c.set('[data-item-field="accountId"]','hurda14');c.set('[data-item-field="quantity"]','1');c.set('[data-item-field="value"]','100');
  c.document.querySelector('[data-payment-type="cash"]').click();c.set('[data-allocation-kind="payment"] [data-allocation-field="quantity"]','110');c.submit('#sale-form');await tick();assert.equal(c.commands.length,0);
  c.set('[data-allocation-kind="payment"] [data-allocation-field="quantity"]','100');c.submit('#sale-form');await tick();
  assert.equal(c.commands.at(-1).command.counterpartyId,c.claim);assert.equal(c.commands.at(-1).command.source,'customer');assert.equal(c.repo.state().balances.hurda14,1000);
}]);
checks.push(['supplier purchase only offers firm accounts and remains separate', async c => {
  c.run({type:'supplierFirm',name:'Örnek Firma'});const firm=c.repo.state().supplierFirms.at(-1).id;
  c.run({type:'supplierUnit',supplierId:firm,unit:'TL'});const supplier=c.repo.state().accounts.at(-1).id;
  c.document.querySelector('#refresh').click();await tick();c.window.__tx.setView('suppliers');await tick();c.document.querySelector('[data-open-firm]').click();c.document.querySelector('[data-supplier-task="purchase"]').click();await tick();
  const choices=[...c.document.querySelector('[data-group="charges"] select').options].map(option=>option.value);assert.ok(choices.includes(supplier));assert.ok(!choices.includes(c.claim));
  const native=(group,key,value)=>c.set(`[data-group="${group}"] [data-field="${key}"]`,value);
  native('items','accountId','gramToplam');native('items','quantity','2');native('charges','accountId',supplier);native('charges','quantity','100');c.submit('[data-supplier-form]');await tick();
  assert.equal(c.commands.at(-1).command.type,'supplierPurchase');assert.equal(c.commands.at(-1).command.supplierId,firm);assert.equal(c.repo.state().balances[supplier],-10000);
  c.window.__tx.setView('transaction');c.document.querySelector('[data-tab="collection"]').click();assert.ok(![...c.document.querySelector('#f-customerAccount').options].some(option=>option.value===supplier));
}]);
checks.push(['quick customer phone preserves sale rows and selects new credit', async c => {
  c.tab('sale');c.set('[data-item-field="accountId"]','gramToplam');c.set('[data-item-field="value"]','200');
  c.document.querySelector('[data-create-party]').click();c.set('#f-name','Yeni <img src=x> kişi');c.set('#f-phone','05550000002');c.submit('#account-form');await tick();
  assert.equal(c.commands.at(-1).command.phone,'05550000002');assert.equal(c.commands.at(-1).command.partyType,'customer');
  assert.equal(c.document.querySelector('[data-item-field="value"]').value,'200');assert.ok(c.document.querySelector('[data-allocation-kind="debt"]'));
  assert.equal(c.document.querySelector('img'),null);c.set('[data-allocation-kind="debt"] [data-allocation-field="quantity"]','200');c.submit('#sale-form');await tick();assert.equal(c.repo.state().journal.at(-1).type,'sale');
}]);
checks.push(['legacy sale editing fills every payment and atomically saves amendment', async c => {
  c.run({type:'sale',items:[{accountId:'gramToplam',quantity:'1',value:'100'}],cash:'60',pos:'40',bank:'0',scrapQuantity:'0',scrapValue:'0',customerAccount:'',note:'Eski satış'});
  const original=c.repo.state().journal.at(-1);c.document.querySelector('#refresh').click();await tick();c.window.__tx.beginTransactionEdit(original);
  assert.equal(c.document.querySelectorAll('[data-allocation-kind="payment"]').length,2);assert.equal(c.document.querySelector('[data-item-field="quantity"]').value,'1');
  c.set('[data-item-field="quantity"]','2');c.set('#amend-reason','Adet düzeltildi');c.submit('#sale-form');await tick();
  assert.equal(c.commands.at(-1).command.type,'amend');assert.equal(c.repo.state().balances.gramToplam,98000,c.document.querySelector('#notice').textContent);
}]);
checks.push(['editing fully settled collection uses balance before original payment', async c => {
  c.run({type:'collection',customerAccount:c.claim,direction:'collect',target:'nakit',quantity:'200',note:''});const original=c.repo.state().journal.at(-1);
  assert.equal(c.repo.state().balances[c.claim],0);c.document.querySelector('#refresh').click();await tick();c.window.__tx.beginTransactionEdit(original);
  assert.equal(c.document.querySelector('#f-customerAccount').value,c.claim);assert.equal(c.document.querySelector('#f-direction').value,'collect');assert.equal(c.document.querySelector('#collection-form button[type="submit"]').disabled,false);
  c.set('#f-quantity','100');c.set('#amend-reason','Tahsilat tutarı düzeltildi');c.submit('#collection-form');await tick();
  assert.equal(c.commands.at(-1).command.type,'amend');assert.equal(c.repo.state().balances[c.claim],10000,c.document.querySelector('#notice').textContent);
}]);
checks.push(['POS invalid expected amount cannot submit and named foreign expense works', async c => {
  c.tab('settlement');c.set('#f-gross','200');c.set('#f-expected','abc');assert.equal(c.document.querySelector('#f-expected').checkValidity(),false);c.submit('#settlement-form');await tick();assert.equal(c.commands.length,0);
  c.set('#f-expected','250');assert.equal(c.document.querySelector('#f-expected').checkValidity(),false);c.submit('#settlement-form');await tick();assert.equal(c.commands.length,0);
  c.tab('movement');c.set('#f-accountId',c.bankUSD);c.set('#f-quantity','1');c.submit('#movement-form');await tick();assert.equal(c.repo.state().balances[c.bankUSD],900,c.document.querySelector('#notice').textContent);
}]);
checks.push(['purchase stock transfer settlement and correction editors preserve complete values', async c => {
  const commands=[
    {type:'purchase',source:'customer',counterpartyId:c.claim,items:[{accountId:'hurda14',quantity:'1.2',value:'100'}],payments:[{accountId:'nakit',quantity:'100',valueTL:'100'}],debts:[],note:''},
    {type:'stock',items:[{accountId:'gramToplam',quantity:'1.5'}],category:'Stok girişi',direction:'in',note:''},
    // Deliberately put the destination before the source to test dependency-aware filling.
    {type:'transfer',toAccount:c.bankUSD,fromAccount:'usd',quantity:'2.3',note:''},
    {type:'settlement',gross:'100',fee:'4',bankAccount:'banka',note:''},
    {type:'movement',category:'Açılış düzeltmesi',accountId:'ceyrek',direction:'in',quantity:'2',note:'Başlangıç sayımı düzeltildi'}
  ];
  for(const command of commands){
    c.run(command);const original=c.repo.state().journal.at(-1),before={...c.repo.state().balances};
    c.document.querySelector('#refresh').click();await tick();c.window.__tx.beginTransactionEdit(original);
    const form=c.document.querySelector('#edit-operation form');assert.ok(form,command.type);c.set('#amend-reason','Bilgiler kontrol edildi');c.submit('#'+form.id);await tick();
    assert.equal(c.commands.at(-1).command.type,'amend',command.type);assert.deepEqual(c.repo.state().balances,before,command.type+': '+c.document.querySelector('#notice').textContent);
  }
}]);

checks.push(['native form submission recovers after invalid collection transfer and expense amounts', async c => {
  c.tab('collection');c.set('#f-customerAccount',c.claim);c.set('#f-target','nakit');c.set('#f-quantity','300');
  c.document.querySelector('#collection-form').requestSubmit();await tick();
  assert.equal(c.commands.length,0);
  c.set('#f-quantity','100');c.document.querySelector('#collection-form').requestSubmit();await tick();
  assert.equal(c.commands.length,1,'corrected collection must no longer be blocked by stale custom validity');
  for(const [tab,form] of [['transfer','transfer-form'],['movement','movement-form']]){
    c.tab(tab);if(tab==='transfer'){c.set('#f-fromAccount','nakit');c.set('#f-toAccount','banka');}else c.set('#f-accountId','nakit');
    c.set('#f-quantity','geçersiz');const count=c.commands.length;c.document.querySelector('#'+form).requestSubmit();await tick();assert.equal(c.commands.length,count);
    c.set('#f-quantity','10');c.document.querySelector('#'+form).requestSubmit();await tick();assert.equal(c.commands.length,count+1,'corrected '+tab+' must submit');
  }
}]);

for (const [name, check] of checks) { const c=await fixture(); try { await check(c); console.log('PASS:',name); } finally { c.close(); } }
console.log(`PASS: ${checks.length} simplified transaction acceptance checks.`);

