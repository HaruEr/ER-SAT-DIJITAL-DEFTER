import * as supplierModule from '../public/suppliers.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadJSDOM } from '../test-support/jsdom.mjs';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS, workdaySummary } from '../domain.mjs';

const JSDOM = await loadJSDOM();
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0)); };
const cases = [];
const check = (name, run) => cases.push({ name, run });
async function fixture() {
  const repo = new Repository(':memory:', 'demo');
  const execute = command => repo.execute({ id: randomUUID(), revision: repo.state().revision, command });
  execute({ type: 'opening', date: '2026-01-02', balances: Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, a.id === 'nakit' ? '1000' : '0'])) });
  execute({ type: 'account', date: '2026-01-02', name: 'İpek <img src=x>', unit: 'TL', opening: '500' });
  execute({ type: 'account', date: '2026-01-02', name: 'Tedarikçi', unit: 'USD', opening: '-20' });
  execute({ type: 'fundAccount', date: '2026-01-02', name: 'Fiziki has', unit: 'HAS', physical: true, opening: '5' });
  const dom = new JSDOM(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), { url: 'http://127.0.0.1:4317/', runScripts: 'outside-only' });
  const { window } = dom, { document } = window;
  Object.defineProperty(window.crypto, 'randomUUID', { value: randomUUID });
  const calls = [], control = { statementFailure: false, statementDelay: null };
  window.fetch = async (url, options = {}) => {
    const parsed = new URL(url, window.location.href), path = parsed.pathname, q = Object.fromEntries(parsed.searchParams);
    calls.push({ path, q, method: options.method || 'GET' });
    try {
      let result;
      if (path === '/api/state') result = repo.state({ compact: true });
      else if (path === '/api/suppliers') result = repo.supplierDetail({...q,limit:Number(q.limit||50)});
      else if (path === '/api/journal') result = repo.journalPage({ ...q, limit: q.limit ? Number(q.limit) : 25 });
      else if (path === '/api/account-statement') {
        if (control.statementDelay) await control.statementDelay;
        if (control.statementFailure) throw new Error('Sentetik ekstre hatası');
        result = repo.accountStatement(q);
      }
      else if (path === '/api/summary') result = workdaySummary(repo.state(), q.date);
      else if (path === '/api/command') result = repo.execute(JSON.parse(options.body), { compact: true });
      else throw new Error('Unexpected synthetic route');
      return { ok: true, status: 200, json: async () => result };
    } catch (error) { return { ok: false, status: error.status || 500, json: async () => ({ error: error.message }) }; }
  };
  window.__supplierModule=supplierModule;
  window.eval(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace("import('./suppliers.js')","Promise.resolve(window.__supplierModule)") + '\nwindow.__workbench = { setView };');
  await tick();
  return { window, document, repo, calls, control, async open(view) { window.__workbench.setView(view); await tick(); }, close() { window.close(); repo.close(); } };
}

check('PC navigation exposes accounts and stock without adding editor routes to the phone portal', async f => {
  assert.ok(f.document.querySelector('#navigation [data-view="accounts"]'));
  assert.ok(f.document.querySelector('#navigation [data-view="stocks"]'));
  await f.open('accounts');
  assert.match(f.document.querySelector('h1').textContent, /Müşteri Ekranı/);
  assert.equal(f.document.querySelector('#main img'), null);
  assert.match(f.document.querySelector('#account-list').textContent, /İpek <img src=x>/);
  const search = f.document.querySelector('#account-search');
  search.value = 'ipek'; search.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  assert.match(f.document.querySelector('#account-list').textContent, /İpek/);
  assert.doesNotMatch(f.document.querySelector('#account-list').textContent, /Tedarikçi/);
});

check('account detail reads all-period statement and opens collection with that account selected', async f => {
  await f.open('accounts');
  const account = f.repo.state().accounts.find(a => a.name.startsWith('İpek'));
  f.document.querySelector(`[data-account-detail="${account.id}"]`).click(); await tick();
  assert.ok(f.calls.some(c => c.path === '/api/account-statement' && c.q.accountId === account.id && c.method === 'GET'));
  assert.match(f.document.querySelector('#account-detail').textContent, /500,00 TL/);
  assert.match(f.document.querySelector('#account-detail').textContent, /Önceden gelen bakiye/);
  assert.match(f.document.querySelector('#account-detail').textContent, /Alacağı artıran.*borcu azaltan/);
  assert.match(f.document.querySelector('#account-detail').textContent, /Seçilen dönem bakiyesi/);
  f.document.querySelector('[data-account-collect]').click(); await tick();
  assert.equal(f.document.querySelector('#f-customerAccount').value, account.id);
  assert.equal(f.document.querySelector('#f-direction').value, 'collect');
  assert.ok(f.calls.filter(c => c.path !== '/api/command').every(c => c.method === 'GET'));
});

check('stock search excludes money and HAS funds and links to an account statement', async f => {
  await f.open('stocks');
  const list = f.document.querySelector('#stock-list');
  assert.match(list.textContent, /BİLEZİK/);
  assert.doesNotMatch(list.textContent, /Fiziki has|Nakit TL/);
  const search = f.document.querySelector('#stock-search'); search.value = 'ceyrek';
  search.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  assert.match(list.textContent, /ÇEYREK/); assert.doesNotMatch(list.textContent, /BİLEZİK/);
  f.document.querySelector('[data-account-detail="ceyrek"]').click(); await tick();
  assert.match(f.document.querySelector('#account-detail').textContent, /Sayım|sayım|ölçüm|tartım/);
});

check('journal date and account filters reach the API and survive leaving the page', async f => {
  await f.open('journal');
  const scope = f.document.querySelector('#journal-scope'); scope.value = 'all'; scope.dispatchEvent(new f.window.Event('change'));
  for (const [id, value] of [['journal-start', '2026-01-01'], ['journal-end', '2026-01-03'], ['journal-account', 'nakit']]) {
    const el = f.document.getElementById(id); el.value = value; el.dispatchEvent(new f.window.Event('change', { bubbles: true }));
  }
  await tick();
  const last = f.calls.filter(c => c.path === '/api/journal').at(-1).q;
  assert.equal(last.startDate, '2026-01-01'); assert.equal(last.endDate, '2026-01-03'); assert.equal(last.accountId, 'nakit');
  await f.open('overview'); await f.open('journal');
  assert.equal(f.document.querySelector('#journal-account').value, 'nakit');
  assert.equal(f.document.querySelector('#journal-start').value, '2026-01-01');
  f.document.querySelector('#journal-clear').click(); await tick();
  assert.equal(f.document.querySelector('#journal-start').value, ''); assert.equal(f.document.querySelector('#journal-account').value, '');
});

check('old open workday is visible without silently changing dates or writing records', async f => {
  assert.match(f.document.querySelector('#workday-warning').textContent, /Açık iş günü|açık iş günü/);
  assert.equal(f.repo.state().date, '2026-01-02');
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
});

check('statement errors remove stale amounts and a successful retry recovers', async f => {
  await f.open('accounts'); f.document.querySelector('[data-account-detail]').click(); await tick();
  assert.ok(f.document.querySelector('.statement-totals'));
  f.control.statementFailure = true;
  f.document.querySelector('#statement-filter').dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true })); await tick();
  assert.equal(f.document.querySelector('.statement-totals'), null);
  assert.equal(f.document.querySelector('[data-current-balance]').textContent,'','failed statement must not retain stale current balance or collection action');
  assert.match(f.document.querySelector('#statement-result').textContent, /alınamadı|hazırlanamadı/);
  f.control.statementFailure = false;
  f.document.querySelector('#statement-filter').dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true })); await tick();
  assert.ok(f.document.querySelector('.statement-totals'));
});

check('a delayed account response cannot overwrite a different screen', async f => {
  await f.open('accounts'); let resolve;
  f.control.statementDelay = new Promise(r => { resolve = r; });
  f.document.querySelector('[data-account-detail]').click(); await tick();
  await f.open('overview'); resolve(); await tick();
  assert.equal(f.document.querySelector('#account-detail'), null);
  assert.match(f.document.querySelector('h1').textContent, /Günün/);
});

check('daily count shows progress and differences without filling physical counts automatically', async f => {
  await f.open('closing');
  const count = f.document.querySelector('#daily-count-nakit');
  assert.equal(count.value, '');
  assert.match(f.document.querySelector('#count-progress').textContent, /0\s*\//);
  count.value = '999'; count.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  assert.match(f.document.querySelector('#count-progress').textContent, /1\s*\//);
  const filter = f.document.querySelector('#count-differences-only'); filter.checked = true; filter.dispatchEvent(new f.window.Event('change'));
  assert.equal(count.closest('tr').hidden, false);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
});

check('printing an account statement uses an isolated scope and clears it after printing', async f => {
  await f.open('accounts'); f.document.querySelector('[data-account-detail]').click(); await tick();
  let printed=false;
  f.window.print=()=>{ printed=true; assert.equal(f.document.body.dataset.printScope,'statement'); };
  f.document.querySelector('#statement-print').click(); await tick(); assert.ok(printed);
  f.window.dispatchEvent(new f.window.Event('afterprint'));
  assert.equal(f.document.body.dataset.printScope,undefined);
  const css=readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');
  assert.match(css,/data-print-scope="statement"/);
});

check('daily sale keeps multi-unit payment choices and moves setup into dedicated pages', async f => {
  await f.open('transaction');
  assert.equal(f.document.querySelector('[data-tab="sale"]').textContent, 'Satış');
  assert.equal(f.document.querySelector('[data-tab="sale-multi"], [data-tab="fund"], [data-tab="account"]'), null);
  assert.ok(f.document.querySelector('[data-payment-type="foreign"]'));
  assert.equal(f.document.querySelectorAll('[data-allocation-kind="payment"]').length, 0);
  f.document.querySelector('[data-payment-type="foreign"]').click();
  assert.ok(f.document.querySelector('[data-allocation-kind="payment"]'));
  await f.open('accounts'); assert.equal(f.document.querySelector('#account-form'), null);
  f.document.querySelector('#add-account').click(); assert.ok(f.document.querySelector('#account-form'));
  await f.open('banks'); assert.equal(f.document.querySelector('#bank-form'), null);
  f.document.querySelector('#add-bank').click(); assert.ok(f.document.querySelector('#bank-form'));
});

check('reversing a recorded transaction requires reviewing its effects before sending', async f => {
  f.repo.execute({id:'synthetic-movement',revision:f.repo.state().revision,command:{type:'movement',date:'2026-01-02',accountId:'nakit',category:'Sermaye',direction:'in',quantity:'10',note:'Sentetik hareket'}});
  f.document.querySelector('#refresh').click(); await tick(); await f.open('journal');
  const form=f.document.querySelector('.reverse-form'); assert.ok(form);
  form.querySelector('[name="note"]').value='Yanlış giriş';
  form.dispatchEvent(new f.window.Event('submit',{bubbles:true,cancelable:true})); await tick();
  assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
  assert.match(form.querySelector('[data-reverse-review]').textContent,/Nakit TL/);
  assert.match(form.querySelector('[data-reverse-review]').textContent,/2026-01-02/);
  form.querySelector('[data-confirm-reverse]').click(); await tick();
  assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});

check('closing offers the next open workday without assuming a Sunday holiday', async f => {
  await f.open('closing');
  const next=f.document.querySelector('#f-nextDate');assert.ok(next);assert.equal(next.value,'2026-01-03');
  assert.equal(next.min,'2026-01-03');next.value='2026-01-05';
  assert.equal(f.repo.state().date,'2026-01-02');
});

check('POS settlement names the selected bank rather than silently using the default', async f => {
  f.repo.execute({id:'second-bank',revision:f.repo.state().revision,command:{type:'fundAccount',date:'2026-01-02',name:'İkinci banka',unit:'TL',physical:false,opening:'0'}});
  f.document.querySelector('#refresh').click();await tick();await f.open('banks');
  f.document.querySelector('[data-bank-action="settlement"]').click();
  const select=f.document.querySelector('#f-bankAccount');assert.ok(select);
  assert.ok([...select.options].some(o=>o.textContent.includes('İkinci banka')));
  assert.equal([...select.options].some(o=>o.value==='nakit'||o.value==='pos'),false);
});

for (const view of ['stocks','accounts']) {
  check(`${view}: statement opens before the list, takes focus and returns to the selected filtered card`, async f => {
    await f.open(view);
    const prefix=view==='stocks'?'stock':'account',list=f.document.querySelector(`#${prefix}-list`);
    const search=f.document.querySelector(`#${prefix}-search`);
    search.value=view==='stocks'?'bilezik':view==='accounts'?'ipek':'sentetik';
    search.dispatchEvent(new f.window.Event('input',{bubbles:true}));
    const selected=list.querySelector('[data-account-detail]');assert.ok(selected);selected.click();await tick();
    const panel=f.document.querySelector('#account-detail');
    assert.equal(f.document.activeElement,panel,'focus must enter the opened statement');
    assert.ok(panel.compareDocumentPosition(list.closest('section')) & f.window.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.ok(panel.querySelector('#statement-result table'));
    panel.querySelector('#statement-back').click();
    assert.equal(panel.hidden,true);assert.equal(f.document.activeElement,selected);
    assert.equal(search.value,view==='stocks'?'bilezik':view==='accounts'?'ipek':'sentetik');
    assert.equal(f.calls.filter(c=>c.method==='POST').length,0,'statement browsing never writes');
    selected.click();await tick();f.document.querySelector('#edit-card').click();
    assert.equal(f.document.activeElement,f.document.querySelector('#card-editor input'));
  });
}
check('supplier search opens the firm before native statement and returns without writing',async f=>{
  f.repo.execute({id:'firm',revision:f.repo.state().revision,command:{type:'supplierFirm',date:'2026-01-02',name:'Sentetik firma'}});
  f.repo.execute({id:'unit',revision:f.repo.state().revision,command:{type:'supplierUnit',date:'2026-01-02',supplierId:'supplier-firm',unit:'HAS'}});
  f.document.querySelector('#refresh').click();await tick();await f.open('suppliers');
  const search=f.document.querySelector('[data-supplier-search]');search.value='sentetik';search.dispatchEvent(new f.window.Event('input',{bubbles:true}));
  f.document.querySelector('[data-open-firm="supplier-firm"]').click();await tick();assert.equal(f.document.activeElement,f.document.querySelector('[data-firm-heading]'));
  f.document.querySelector('[data-supplier-task="statement"]').click();await tick();assert.ok(f.document.querySelector('[data-supplier-read-result] table'));
  f.document.querySelector('[data-back-suppliers]').click();await tick();assert.equal(f.document.querySelector('[data-supplier-search]').value,'sentetik');
  assert.equal(f.document.activeElement,f.document.querySelector('[data-supplier-search]'));assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});
check('closing a statement ignores an in-flight response and keeps return focus',async f=>{
  await f.open('stocks');let release;f.control.statementDelay=new Promise(resolve=>release=resolve);
  const selected=f.document.querySelector('[data-account-detail]');selected.click();
  f.document.querySelector('#statement-back').click();release();await tick();
  assert.equal(f.document.querySelector('#account-detail').hidden,true);
  assert.equal(f.document.querySelector('#account-detail').textContent,'');
  assert.equal(f.document.activeElement,selected);
});

check('D03 exposes operations before KPI reading and recent records before stock without losing data',async f=>{
 await f.open('overview');const d=f.document;
 assert.ok(d.querySelector('.quick-actions').compareDocumentPosition(d.querySelector('.stats')) & f.window.Node.DOCUMENT_POSITION_FOLLOWING);
 assert.equal(d.querySelectorAll('.stat-value').length,4);assert.equal(d.querySelectorAll('.inventory-table tbody tr').length,23);
 assert.equal(d.querySelector('.split h2').textContent,'Son hareketler');
 assert.equal(d.querySelectorAll('.split .balance-row').length,4);
 assert.deepEqual([...d.querySelectorAll('[data-quick-action]')].map(x=>x.dataset.quickAction),['sale','purchase','collection','closing']);
});
check('D03 shortcuts keep their existing destinations and never write on navigation',async f=>{
 for(const [id,form] of [['sale','#sale-form'],['purchase','#sale-form[data-operation="purchase"]'],['collection','#collection-form'],['closing','#close-form']]){
  await f.open('overview');f.document.querySelector('[data-quick-action="'+id+'"]').click();await tick();assert.ok(f.document.querySelector(form),id+' destination');
 }
 assert.equal(f.calls.filter(x=>x.method!=='GET').length,0);
});


check('zero-balance active customer uses balance terminology in filter, card and statement', async f => {
  f.repo.execute({id:'zero-customer',revision:f.repo.state().revision,command:{type:'account',date:'2026-01-02',name:'Sıfır bakiye müşteri',unit:'TL',opening:'0',partyType:'customer'}});
  f.document.querySelector('#refresh').click(); await tick(); await f.open('accounts');
  const filter=f.document.querySelector('#account-sign');
  assert.equal(filter.querySelector('[value="zero"]').textContent,'Bakiyesi sıfır');
  filter.value='zero';filter.dispatchEvent(new f.window.Event('change'));
  const card=f.document.querySelector('[data-account-detail="cari-zero-customer"]');
  assert.ok(card);assert.match(card.closest('article').textContent,/Bakiyesi sıfır/);
  assert.doesNotMatch(card.closest('article').textContent,/Hesap kapalı/);
  card.click();await tick();
  assert.match(f.document.querySelector('.statement-totals').textContent,/Bakiyesi sıfır/);
  assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});

check('collection target label follows selected customer direction and empty search', async f => {
  f.repo.execute({id:'owed-customer',revision:f.repo.state().revision,command:{type:'account',date:'2026-01-02',name:'Borçlu olduğumuz müşteri',unit:'TL',opening:'-100',partyType:'customer'}});
  f.document.querySelector('#refresh').click();await tick();await f.open('accounts');
  const claim=f.repo.state().accounts.find(a=>a.name.startsWith('İpek'));
  f.document.querySelector('[data-account-detail="'+claim.id+'"]').click();await tick();
  f.document.querySelector('[data-account-collect]').click();await tick();
  const select=f.document.querySelector('#f-customerAccount');
  const label=()=>f.document.querySelector('#f-target').previousElementSibling.firstChild.textContent;
  assert.equal(f.document.querySelector('#f-direction').value,'collect');
  assert.equal(label(),'Tahsilatın gireceği kasa / banka');
  select.value='cari-owed-customer';select.dispatchEvent(new f.window.Event('change'));
  assert.equal(f.document.querySelector('#f-direction').value,'pay');
  assert.equal(label(),'Ödemenin yapılacağı kasa / banka');
  select.value=claim.id;select.dispatchEvent(new f.window.Event('change'));
  assert.equal(label(),'Tahsilatın gireceği kasa / banka');
  const search=f.document.querySelector('#collection-search');search.value='eşleşmeyen-ad';search.dispatchEvent(new f.window.Event('input'));
  assert.equal(label(),'Kasa / banka');
  assert.equal(f.document.querySelector('#collection-form button[type="submit"]').disabled,true);
  assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});

check('customer detail leads with current balance and keeps orders and explanation collapsed after movements', async f => {
  await f.open('accounts');f.document.querySelector('[data-account-detail]').click();await tick();
  const panel=f.document.querySelector('#account-detail'),balance=panel.querySelector('[data-current-balance]'),orders=panel.querySelector('details.customer-orders');
  assert.ok(balance);assert.match(balance.textContent,/Güncel net bakiye.*500,00 TL.*Alacağımız/s);
  assert.ok(balance.querySelector('[data-account-collect]'));
  assert.ok(balance.compareDocumentPosition(panel.querySelector('#statement-filter')) & f.window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.ok(orders);assert.equal(orders.open,false);
  assert.ok(panel.querySelector('#statement-result').compareDocumentPosition(orders) & f.window.Node.DOCUMENT_POSITION_FOLLOWING);
  const help=panel.querySelector('[data-statement-help]');assert.equal(help.open,false);assert.equal(help.querySelector('summary').textContent,'Ekstre nasıl okunur?');
  assert.match(panel.querySelector('[data-statement-scope]').textContent,/Yazdırma ve CSV.*tamamı/);
  assert.equal(panel.querySelectorAll('[data-account-collect]').length,1);
  const start=panel.querySelector('#statement-start');start.value='2026-01-01';
  panel.querySelector('#statement-end').value='2026-01-01';
  panel.querySelector('#statement-filter').dispatchEvent(new f.window.Event('submit',{bubbles:true,cancelable:true}));await tick();
  assert.match(panel.querySelector('[data-current-balance]').textContent,/500,00 TL/);
  assert.match(panel.querySelector('.statement-totals').textContent,/Seçilen dönem bakiyesi.*0,00 TL/s);
});

let failed = 0;
for (const { name, run } of cases) {
  const f = await fixture();
  try { await run(f); console.log(`PASS: ${name}`); }
  catch (error) { failed++; console.error(`FAIL: ${name}\n${error.stack}`); }
  finally { f.close(); }
}
if (failed) process.exitCode = 1;
else console.log(`PASS: ${cases.length} PC workbench behavior checks using synthetic memory repositories.`);
