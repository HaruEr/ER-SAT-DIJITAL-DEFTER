import * as supplierModule from '../public/suppliers.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadJSDOM } from '../test-support/jsdom.mjs';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS } from '../domain.mjs';

const JSDOM = await loadJSDOM(), tick = () => new Promise(resolve => setTimeout(resolve, 0));
const cases = [];
async function fixture() {
  const repo = new Repository(':memory:', 'demo');
  const run = command => repo.execute({ id: randomUUID(), revision: repo.state().revision, command: { date: repo.state().date, ...command } });
  run({ type: 'opening', date: '2026-10-28', balances: Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, a.id === 'nakit' ? '10000' : a.id === 'gramToplam' ? '100' : '0'])) });
  const dom = new JSDOM(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), { url: 'http://127.0.0.1:4317/', runScripts: 'outside-only' });
  const { window } = dom, { document } = window;
  Object.defineProperty(window.crypto, 'randomUUID', { value: randomUUID });
  window.fetch = async (url, options) => {
    const parsed = new URL(url, window.location.href), query = Object.fromEntries(parsed.searchParams);
    try {
      const result = parsed.pathname === '/api/state' ? repo.state() : parsed.pathname === '/api/command' ? repo.execute(JSON.parse(options.body)) : parsed.pathname === '/api/journal' ? repo.journalPage({...query, limit:query.limit?Number(query.limit):25}) : parsed.pathname === '/api/account-statement' ? repo.accountStatement(query) : null;
      assert.ok(result, parsed.pathname);
      return { ok: true, status: 200, json: async () => result };
    } catch (error) { return { ok: false, status: error.status || 400, json: async () => ({ error: error.message }) }; }
  };
  window.__supplierModule=supplierModule;
  window.eval(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace("import('./suppliers.js')","Promise.resolve(window.__supplierModule)") + '\nwindow.__owner = {setView, legacy(tab) { transactionTab = tab; setView("transaction"); }, current() { return {view, transactionTab}; }};');
  await tick();
  const set = (selector, value) => { const node = document.querySelector(selector); assert.ok(node, selector); node.value = value; node.dispatchEvent(new window.Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); };
  const click = selector => { assert.ok(document.querySelector(selector), selector); document.querySelector(selector).click(); };
  const submit = selector => { assert.ok(document.querySelector(selector), selector); document.querySelector(selector).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); };
  return { repo, run, window, document, set, click, submit, nav: window.__owner, close() { window.close(); repo.close(); } };
}
cases.push(['legacy operation routes use their single owner', async c => {
  for (const [tab, view, selector] of [['transfer','banks','#transfer-form'], ['settlement','banks','#settlement-form'], ['account','accounts','#account-form'], ['fund','banks','#bank-form'], ['stock','stocks','#sale-form'], ['supplier-purchase','suppliers','[data-create-firm]']]) {
    c.nav.legacy(tab); await tick(); assert.equal(c.nav.current().view, view, tab); assert.ok(c.document.querySelector(selector), tab);
  }
}]);
cases.push(['money tab contains movement and owner shortcuts', async c => {
  c.nav.legacy('movement'); assert.ok(c.document.querySelector('#movement-form'));
  assert.equal(c.document.querySelector('#transfer-form, #settlement-form'), null);
  c.click('[data-owner-operation="transfer"]'); assert.equal(c.nav.current().view, 'banks'); assert.ok(c.document.querySelector('#transfer-form'));
  c.nav.setView('transaction'); assert.ok(c.document.querySelector('#movement-form'));
  c.click('[data-owner-operation="settlement"]'); assert.ok(c.document.querySelector('#settlement-form'));
}]);
cases.push(['bank and stock operation choices do not overwrite customer tab or draft', async c => {
  c.nav.legacy('purchase'); c.set('[data-item-field="accountId"]', 'hurda8'); c.set('[data-item-field="quantity"]', '2.5'); c.set('#f-note', 'Müşteri taslağı');
  c.nav.setView('banks'); c.click('[data-bank-action="settlement"]'); c.nav.setView('stocks'); c.click('#stock-movement');
  c.nav.setView('transaction'); assert.equal(c.document.querySelector('h2').textContent, 'Müşteriden alış'); assert.equal(c.document.querySelector('[data-item-field="quantity"]').value, '2.5'); assert.equal(c.document.querySelector('#f-note').value, 'Müşteri taslağı');
}]);
cases.push(['new customer attaches to preserved sale and only its creation advances draft', async c => {
  c.nav.legacy('sale'); c.set('[data-item-field="accountId"]','gramToplam'); c.set('[data-item-field="value"]','250'); c.set('#f-note','Satış taslağı');
  assert.equal(c.document.querySelector('#inline-account-form'),null); c.click('[data-create-party]');
  assert.equal(c.nav.current().view,'accounts'); c.set('#f-name','Taslak müşterisi'); c.set('#f-phone','05550000001'); c.submit('#account-form'); await tick();
  assert.equal(c.nav.current().view,'transaction'); assert.equal(c.document.querySelector('#f-note').value,'Satış taslağı');
  assert.equal(c.document.querySelector('[data-item-field="value"]').value,'250'); assert.equal(c.document.querySelector('#sale-form').dataset.draftStale,'false');
  const party=c.repo.state().accounts.at(-1); assert.equal(c.document.querySelector('[data-allocation-kind="debt"] select').value,party.id); assert.equal(party.partyType,'customer');
}]);
cases.push(['external change before customer creation retains source stale guard', async c => {
  c.nav.legacy('purchase'); c.set('[data-item-field="value"]','250'); c.click('[data-create-party]');
  c.run({type:'movement',category:'Sermaye',accountId:'nakit',quantity:'10',direction:'in',note:''}); c.click('#refresh'); await tick();
  c.set('#f-name','Sonradan müşteri'); c.submit('#account-form'); await tick();
  assert.equal(c.nav.current().view,'transaction'); assert.equal(c.document.querySelector('#sale-form').dataset.draftStale,'true'); assert.ok(c.document.querySelector('#sale-form button[type="submit"]').disabled);
}]);
cases.push(['customer statement shortcut selects its account despite a previous collection filter', async c => {
  c.run({type:'account',name:'Aranan müşteri',partyType:'customer',unit:'TL',opening:'50'}); const customer=c.repo.state().accounts.at(-1).id;
  c.click('#refresh');await tick();c.nav.legacy('collection');c.set('#collection-search','gizli filtre');c.set('#collection-filter','debt');
  c.nav.setView('accounts');c.click(`[data-account-detail="${customer}"]`);await tick();c.click('[data-account-collect]');
  assert.equal(c.nav.current().view,'transaction');assert.equal(c.document.querySelector('#f-customerAccount').value,customer);assert.equal(c.document.querySelector('#f-direction').value,'collect');assert.equal(c.document.querySelector('#collection-search').value,'');
}]);
cases.push(['dismissing the routed editor ends its automatic return context', async c => {
  c.nav.legacy('purchase');c.set('[data-item-field="value"]','150');c.click('[data-create-party]');
  c.click('#add-account');c.click('#add-account');c.set('#f-name','Bağımsız yeni müşteri');c.submit('#account-form');await tick();
  assert.equal(c.nav.current().view,'accounts');assert.equal(c.document.querySelector('[data-return-operation]'),null);
  c.nav.legacy('purchase');assert.equal(c.document.querySelector('[data-item-field="value"]').value,'150');assert.equal(c.document.querySelector('#f-counterpartyId').value,'');
}]);
let failed=0;
for (const [name,run] of cases) { const c=await fixture(); try { await run(c); console.log('PASS '+name); } catch(error) { failed++; console.error('FAIL '+name+'\n'+error.stack); } finally { c.close(); } }
console.log(`${cases.length-failed}/${cases.length} page ownership checks passed`);
if(failed)process.exitCode=1;
