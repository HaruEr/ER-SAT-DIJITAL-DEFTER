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
  const { window } = dom, document = window.document, commands = [];
  Object.defineProperty(window.crypto, 'randomUUID', { value: randomUUID });
  window.fetch = async (url, options) => {
    const parsed = new URL(url, window.location.href);
    try {
      let result;
      if (parsed.pathname === '/api/state') { result = structuredClone(repo.state()); result.accounts.find(a=>a.id===bankHAS).physical=false; } // Synthetic legacy bank presentation; new HAS banks are now rejected by domain.
      else if (parsed.pathname === '/api/command') { const envelope = JSON.parse(options.body); commands.push(envelope); result = repo.execute(envelope); }
      else if (parsed.pathname === '/api/journal') result = repo.journalPage(Object.fromEntries(parsed.searchParams));
      else if (parsed.pathname === '/api/account-statement') result = repo.accountStatement(Object.fromEntries(parsed.searchParams));
      else throw new Error('Unexpected route ' + parsed.pathname);
      return { ok: true, status: 200, json: async () => result };
    } catch(error) { return { ok: false, status: error.status || 400, json: async () => ({ error: error.message }) }; }
  };
  window.eval(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8') + '\nwindow.__tx = {setView, renderSale, beginTransactionEdit};');
  await tick();
  const set = (selector, value) => { const node = document.querySelector(selector); assert.ok(node, selector); node.value = value; node.dispatchEvent(new window.Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); };
  const tab = name => { if(['transfer','settlement'].includes(name)){window.__tx.setView('banks');document.querySelector(`[data-bank-action="${name}"]`).click();}else{window.__tx.setView('transaction');document.querySelector(`[data-tab="${name}"]`).click();} };
  const submit = id => document.querySelector(id).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  return { repo, run, window, document, commands, claim, debt, bankUSD, bankHAS, set, tab, submit, close() { window.close(); repo.close(); } };
}

checks.push(['new bank currency excludes HAS including custom code; existing HAS remains reachable',async c=>{
 c.window.__tx.setView('banks');assert.ok(c.document.body.textContent.includes('Sentetik mevcut HAS hesabı'));
 c.document.querySelector('#add-bank').click();assert.ok(![...c.document.querySelector('#f-unit').options].some(o=>o.value==='HAS'));
 c.set('#f-unit','other');c.set('#f-currencyCode','HAS');assert.equal(c.document.querySelector('#f-currencyCode').checkValidity(),false);
 c.set('#f-currencyCode','CAD');assert.equal(c.document.querySelector('#f-currencyCode').checkValidity(),true);
 c.tab('transfer');assert.ok([...c.document.querySelector('#f-fromAccount').options].some(o=>o.value===c.bankHAS));assert.equal(c.commands.length,0);
}]);
checks.push(['foreign and has chips keep units distinct and TL agreed value visible',async c=>{
 c.tab('sale');c.document.querySelector('[data-payment-type="foreign"]').click();let row=c.document.querySelector('[data-allocation-kind="payment"]');assert.ok(![...row.querySelector('select').options].some(o=>o.value===c.bankHAS));
 c.document.querySelector('[data-payment-type="has"]').click();row=c.document.querySelectorAll('[data-allocation-kind="payment"]')[1];assert.deepEqual([...row.querySelector('select').options].map(o=>o.value),[c.bankHAS]);assert.match(row.textContent,/has gr/);assert.equal(row.querySelector('[data-allocation-field="valueTL"]').closest('label').hidden,false);
}]);
checks.push(['legacy foreign HAS draft and existing transaction restore preserve amount/account',async c=>{
 c.tab('sale');const form=c.document.querySelector('#sale-form');form.draftAdapter.restore({items:[{accountId:'gramToplam',quantity:'1',value:'100'}],payment:[{paymentType:'foreign',accountId:c.bankHAS,quantity:'0.250',valueTL:'100'}]});
 let row=c.document.querySelector('[data-allocation-kind="payment"]');assert.equal(row.querySelector('select').value,c.bankHAS);assert.equal(row.dataset.paymentType,'has');assert.equal(row.querySelector('[data-allocation-field="quantity"]').value,'0.250');
 c.submit('#sale-form');await tick();const entry=c.repo.state().journal.at(-1);assert.equal(entry.type,'sale');assert.equal(c.commands.at(-1).command.received[0].accountId,c.bankHAS);assert.equal(c.repo.state().balances[c.bankHAS],10250);
 c.window.__tx.beginTransactionEdit(entry);await tick();row=c.document.querySelector('[data-allocation-kind="payment"]');assert.equal(row.querySelector('select').value,c.bankHAS);assert.equal(row.querySelector('[data-allocation-field="quantity"]').value,'0.250');
}]);
let failures=0;for(const [name,check] of checks){const c=await fixture();try{await check(c);console.log('PASS:',name);}catch(error){failures++;console.error('FAIL:',name,error.stack);}finally{c.close();}}if(failures)process.exitCode=1;else console.log(`PASS: ${checks.length} HAS UI checks.`);

