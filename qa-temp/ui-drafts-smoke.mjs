import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadJSDOM } from '../test-support/jsdom.mjs';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS } from '../domain.mjs';

const JSDOM = await loadJSDOM();
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const checks = [];
const check = (name, run) => checks.push({ name, run });
async function fixture() {
  const repos = Object.fromEntries(['demo', 'dukkan'].map(workspace => [workspace, new Repository(':memory:', workspace)]));
  for (const repo of Object.values(repos)) repo.execute({ id: randomUUID(), revision: 0, command: { type: 'opening', date: '2026-10-28', balances: Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, a.id === 'nakit' ? '10000' : a.id === 'gramToplam' ? '20' : '0'])) } });
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:4317/', runScripts: 'outside-only' });
  const { window } = dom, document = window.document, commands = [];
  Object.defineProperty(window.crypto, 'randomUUID', { value: randomUUID });
  const control = { fail: false };
  window.fetch = async (url, options) => {
    const parsed = new URL(url, window.location.href), repo = repos[parsed.searchParams.get('workspace') || 'demo'];
    if (parsed.pathname === '/api/state') return { ok: true, status: 200, json: async () => repo.state() };
    if(parsed.pathname==='/api/journal')return {ok:true,status:200,json:async()=>repo.journalPage({...Object.fromEntries(parsed.searchParams),limit:Number(parsed.searchParams.get('limit'))})};
    if (parsed.pathname !== '/api/command') throw new Error('Unexpected test route: ' + parsed.pathname);
    const envelope = JSON.parse(options.body); commands.push(envelope);
    if (control.fail) throw new Error('Sentetik bağlantı kesildi');
    try { return { ok: true, status: 200, json: async () => repo.execute(envelope) }; }
    catch (error) { return { ok: false, status: error.status || 400, json: async () => ({ error: error.message }) }; }
  };
  window.eval(source + '\nwindow.__draftTest = { setView };'); await tick();
  const set = (selector, value) => { const input = document.querySelector(selector); assert.ok(input, selector); input.value = value; input.dispatchEvent(new window.Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); };
  const tab = name => { window.__draftTest.setView('transaction'); document.querySelector(`[data-tab="${name}"]`).click(); };
  const cash = quantity => { document.querySelector('[data-payment-type="cash"]').click(); set('[data-allocation-kind="payment"] [data-allocation-field="quantity"]', quantity); };
  const submit = selector => document.querySelector(selector).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  const switchWorkspace = async name => { set('#workspace', name); await tick(); };
  return { window, document, repos, commands, control, set, tab, cash, submit, switchWorkspace, nav: window.__draftTest.setView, close() { window.close(); for (const repo of Object.values(repos)) repo.close(); } };
}

check('sale draft survives navigation, operation changes and explicit refresh without persistent storage', async c => {
  c.tab('sale'); c.set('#f-note', 'Satış taslağı'); c.set('[data-item-field="quantity"]', '2');
  c.nav('overview'); c.nav('transaction'); assert.equal(c.document.querySelector('#f-note').value, 'Satış taslağı');
  c.document.querySelector('[data-tab="purchase"]').click(); c.document.querySelector('[data-tab="sale"]').click();
  assert.equal(c.document.querySelector('[data-item-field="quantity"]').value, '2');
  c.document.querySelector('#refresh').click(); await tick(); assert.equal(c.document.querySelector('#f-note').value, 'Satış taslağı');
  assert.deepEqual({ ...c.window.localStorage }, { 'defter-theme': 'light' }, 'Only the display preference may persist; no draft fields'); assert.equal(c.window.sessionStorage.length, 0);
});
check('dynamic purchase products and HAS payment rows survive round trip', async c => {
  const repo = c.repos.demo; repo.execute({ id: randomUUID(), revision: repo.state().revision, command: { type: 'fundAccount', date: repo.state().date, name: 'Has kasa', unit: 'HAS', opening: '20', physical: true } });
  c.document.querySelector('#refresh').click(); await tick(); c.tab('purchase');
  c.set('#f-note', 'Çok satırlı alış'); c.document.querySelector('#add-sale-item').click();
  const rows = c.document.querySelectorAll('.sale-item'); c.set('#' + rows[1].querySelector('[data-item-field="accountId"]').id, 'gramToplam'); c.set('#' + rows[1].querySelector('[data-item-field="quantity"]').id, '3,5'); c.set('#' + rows[1].querySelector('[data-item-field="value"]').id, '7000');
  c.cash('1000');
  const has = repo.state().accounts.find(a => a.kind === 'asset' && a.unit === 'HAS'); c.document.querySelector('[data-payment-type="has"]').click();
  const allocation = c.document.querySelectorAll('[data-allocation-kind="payment"]')[1]; c.set('#' + allocation.querySelector('select').id, has.id); c.set('#' + allocation.querySelector('[data-allocation-field="quantity"]').id, '2,1'); c.set('#' + allocation.querySelector('[data-allocation-field="valueTL"]').id, '6000');
  c.nav('overview'); c.nav('transaction');
  assert.equal(c.document.querySelectorAll('.sale-item').length, 2); assert.equal(c.document.querySelectorAll('[data-allocation-kind="payment"]').length, 2);
  assert.equal(c.document.querySelectorAll('[data-item-field="quantity"]')[1].value, '3,5'); assert.equal(c.document.querySelectorAll('[data-allocation-field="valueTL"]')[1].value, '6000');
  assert.equal(c.document.querySelectorAll('[data-allocation-kind="payment"]')[1].querySelector('select').value,has.id);
});
check('workspaces and operation types keep independent in-memory drafts', async c => {
  c.tab('sale'); c.set('#f-note', 'Örnek satış'); c.document.querySelector('[data-tab="purchase"]').click(); c.set('#f-note', 'Örnek alış');
  await c.switchWorkspace('dukkan'); assert.equal(c.document.querySelector('#f-note').value, ''); c.set('#f-note', 'Dükkân alış');
  await c.switchWorkspace('demo'); assert.equal(c.document.querySelector('#f-note').value, 'Örnek alış'); c.document.querySelector('[data-tab="sale"]').click(); assert.equal(c.document.querySelector('#f-note').value, 'Örnek satış');
});
check('explicit clear removes only the current operation draft', async c => {
  c.tab('purchase'); c.set('#f-note', 'Alış kalır'); c.document.querySelector('[data-tab="sale"]').click(); c.set('#f-note', 'Silinecek');
  c.document.querySelector('[data-clear-draft]').click(); assert.equal(c.document.querySelector('#f-note').value, '');
  c.document.querySelector('[data-tab="purchase"]').click(); assert.equal(c.document.querySelector('#f-note').value, 'Alış kalır');
});
check('successful sale clears its draft while an unrelated purchase draft remains', async c => {
  c.tab('purchase'); c.set('#f-note', 'Alış taslağı'); c.document.querySelector('[data-tab="sale"]').click();
  c.set('[data-item-field="accountId"]', 'gramToplam'); c.set('[data-item-field="quantity"]', '1'); c.set('[data-item-field="value"]', '100'); c.cash('100'); c.set('#f-note', 'Tamamlanan satış'); c.submit('#sale-form'); await tick();
  assert.equal(c.commands.at(-1).command.type, 'sale'); assert.equal(c.document.querySelector('#f-note').value, '');
  c.document.querySelector('[data-tab="purchase"]').click(); assert.equal(c.document.querySelector('#f-note').value, 'Alış taslağı');
});
check('stale count draft stays visible but cannot close the new revision', async c => {
  c.nav('closing'); c.set('#daily-count-nakit', '9999'); c.set('#daily-reason-nakit', 'Tekrar sayılacak'); c.nav('overview');
  const repo = c.repos.demo; repo.execute({ id: randomUUID(), revision: repo.state().revision, command: { type: 'movement', date: repo.state().date, accountId: 'nakit', category: 'Sermaye', direction: 'in', quantity: '1', note: 'Dış değişim' } });
  c.document.querySelector('#refresh').click(); await tick(); c.nav('closing');
  assert.equal(c.document.querySelector('#daily-count-nakit').value, '9999'); assert.ok(c.document.querySelector('#close-form [data-draft-stale]'));
  const before = c.commands.length; c.submit('#close-form'); await tick(); assert.equal(c.commands.length, before);
  c.document.querySelector('#close-form [data-clear-draft]').click(); assert.equal(c.document.querySelector('#daily-count-nakit').value, '');
});
check('pending uncertain command retains its identity and blocks account-creation shortcut', async c => {
  c.tab('sale'); c.set('[data-item-field="accountId"]', 'gramToplam'); c.set('[data-item-field="value"]', '100'); c.cash('100'); c.set('#f-note', 'Belirsiz satış'); c.control.fail = true; c.submit('#sale-form'); await tick();
  assert.equal(c.document.querySelector('#inline-account-form'),null); const before = c.commands.length; c.document.querySelector('[data-create-party]').click(); await tick(); assert.ok(c.document.querySelector('#sale-form')); assert.equal(c.document.querySelector('#account-form'),null); assert.equal(c.commands.length, before);
  c.document.querySelector('#retry').click(); await tick(); assert.equal(c.commands.at(-1).id, c.commands[0].id);
});
check('TL customer opens on its owner page without losing sale and is selected safely', async c => {
  c.tab('sale'); c.set('[data-item-field="accountId"]', 'gramToplam'); c.set('[data-item-field="value"]', '200'); c.set('#f-note', 'Cari bekleyen satış');
  assert.equal(c.document.querySelector('#inline-account-form'),null); c.document.querySelector('[data-create-party]').click(); c.set('#f-name', 'Yeni <img src=x> kişi'); c.submit('#account-form'); await tick();
  assert.equal(c.commands.at(-1).command.type, 'account'); assert.equal(c.commands.at(-1).command.opening, '0');
  assert.equal(c.document.querySelector('#f-note').value, 'Cari bekleyen satış'); assert.equal(c.document.querySelector('[data-item-field="value"]').value, '200');
  const id = c.repos.demo.state().accounts.find(a => a.name === 'Yeni <img src=x> kişi').id; assert.equal(c.document.querySelector('[data-allocation-kind="debt"] select').value, id); assert.equal(c.document.querySelectorAll('img').length, 0);
  c.set('[data-allocation-kind="debt"] [data-allocation-field="quantity"]', '200');
  assert.equal(c.document.querySelector('#sale-form [data-draft-stale]'), null); c.submit('#sale-form'); await tick(); assert.equal(c.commands.at(-1).command.type, 'sale'); assert.equal(c.commands.at(-1).command.credits[0].accountId, id); assert.equal(c.commands.at(-1).command.credits[0].quantity, '200');
});
check('HAS customer created on its owner page returns to purchase debt with original amounts preserved', async c => {
  c.tab('purchase'); c.set('#f-note', 'HAS borçlu alış'); c.set('[data-item-field="value"]', '500');
  c.document.querySelector('[data-create-party]').click(); c.set('#f-name', 'Has tedarikçi'); c.set('#f-unit', 'HAS'); c.submit('#account-form'); await tick();
  assert.equal(c.document.querySelector('#f-note').value, 'HAS borçlu alış'); const account = c.repos.demo.state().accounts.find(a => a.name === 'Has tedarikçi');
  assert.equal(c.document.querySelector('#f-counterpartyId').value, account.id);assert.equal(c.document.querySelector('[data-allocation-kind="debt"]'),null,'Opening a payee must not create an unwanted debt row');c.document.querySelector('[data-add-allocation="debt"]').click();assert.equal(c.document.querySelector('[data-allocation-kind="debt"] select').value, account.id);assert.equal(c.document.querySelector('[data-allocation-kind="debt"] [data-allocation-field="quantity"]').value, '');
});
check('committed routed account retries the same identity without duplicating cari or losing sale', async c => {
  c.tab('sale'); c.set('#f-note', 'Cari yanıtı bekleniyor'); c.document.querySelector('[data-create-party]').click(); c.set('#f-name', 'Tek cari');
  const originalFetch = c.window.fetch; let lost = true;
  c.window.fetch = async (url, options) => { const result = await originalFetch(url, options); if (lost && options && JSON.parse(options.body).command.type === 'account') { lost = false; await result.json(); throw new Error('Yanıt kayboldu'); } return result; };
  c.submit('#account-form'); await tick(); const id = c.commands.at(-1).id;
  assert.equal(c.repos.demo.state().accounts.filter(a => a.name === 'Tek cari').length, 1);
  c.document.querySelector('#retry').click(); await tick(); assert.equal(c.commands.at(-1).id, id); assert.equal(c.repos.demo.state().accounts.filter(a => a.name === 'Tek cari').length, 1);
  assert.equal(c.document.querySelector('#f-note').value, 'Cari yanıtı bekleniyor'); assert.equal(c.document.querySelector('[data-allocation-kind="debt"] select').value, 'cari-' + id);
  c.document.querySelector('[data-create-party]').click(); assert.equal(c.document.querySelector('#f-name').value, ''); c.document.querySelector('[data-return-operation]').click();
});
check('successful periodic count clears only periodic draft, not daily count values', async c => {
  c.nav('closing'); c.set('#daily-count-nakit', '9999'); c.set('#daily-reason-nakit', 'Gün sonu tekrar');
  c.set('#periodic-count-bilezik22', '0'); c.set('#f-stockApprovedBy', 'Sentetik'); c.submit('#stocktake-form'); await tick();
  assert.equal(c.commands.at(-1).command.type, 'stocktake'); assert.equal(c.document.querySelector('#periodic-count-bilezik22').value, ''); assert.equal(c.document.querySelector('#daily-count-nakit').value, '9999');
  assert.ok(c.document.querySelector('#close-form [data-draft-stale]'));
});
check('routed account cannot silently validate a sale draft already stale before account creation', async c => {
  c.tab('sale'); c.set('#f-note', 'Eski sürüm satış'); c.nav('overview');
  const repo = c.repos.demo; repo.execute({ id: randomUUID(), revision: repo.state().revision, command: { type: 'movement', date: repo.state().date, accountId: 'nakit', category: 'Sermaye', direction: 'in', quantity: '1', note: 'Dış değişim' } });
  c.document.querySelector('#refresh').click(); await tick(); c.nav('transaction'); assert.ok(c.document.querySelector('#sale-form [data-draft-stale]'));
  c.document.querySelector('[data-create-party]').click(); c.set('#f-name', 'Yeni cari eski satış'); c.submit('#account-form'); await tick();
  assert.ok(c.document.querySelector('#sale-form [data-draft-stale]')); const before = c.commands.length; c.submit('#sale-form'); await tick(); assert.equal(c.commands.length, before);
});
check('leaving a dirty page warns without persisting draft content', async c => {
  c.tab('sale'); c.set('#f-note', 'Yalnız RAM'); const event = new c.window.Event('beforeunload', { cancelable: true }); c.window.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true); assert.deepEqual({ ...c.window.localStorage }, { 'defter-theme': 'light' }, 'No draft payload may persist'); assert.equal(c.window.sessionStorage.length, 0);
});
check('restore is blocked until current workspace drafts are explicitly discarded', async c => {
  c.tab('sale'); c.set('#f-note', 'Korunacak taslak'); c.nav('backup');
  assert.ok(c.document.querySelector('[data-clear-workspace-drafts]')); assert.equal(c.document.querySelector('#restore-form button[type="submit"]').disabled, true);
  c.document.querySelector('[data-clear-workspace-drafts]').click(); assert.equal(c.document.querySelector('#restore-form button[type="submit"]').disabled, false);
  c.nav('transaction'); assert.equal(c.document.querySelector('#f-note').value, '');
});
check('count values remain blocked across business day change and fresh count starts blank', async c => {
  c.nav('closing'); c.set('#daily-count-nakit', '10000'); c.nav('overview');
  const repo = c.repos.demo, state = repo.state(); repo.execute({ id: randomUUID(), revision: state.revision, command: { type: 'close', date: state.date, counts: Object.fromEntries(state.accounts.filter(a => a.physical && !a.retired && a.countPolicy === 'daily').map(a => [a.id, a.id === 'nakit' ? '10000' : a.id === 'gramToplam' ? '20' : '0'])), reasons: {}, approvedBy: 'Sentetik' } });
  c.document.querySelector('#refresh').click(); await tick(); c.nav('closing'); const before = c.commands.length; c.submit('#close-form'); await tick(); assert.equal(c.commands.length, before); assert.ok(c.document.querySelector('#close-form [data-draft-stale]'));
});

for (const lostResponse of [false,true]) check('completed customer gold collection clears only its draft, response lost=' + lostResponse, async c => {
  const repo=c.repos.demo;
  repo.execute({id:'gold-customer',revision:repo.state().revision,command:{type:'account',date:repo.state().date,name:'Gold settlement',partyType:'customer',unit:'TL',opening:'-3000'}});
  c.document.querySelector('#refresh').click();await tick();
  c.tab('purchase');c.set('#f-note','Unrelated purchase');
  c.tab('collection');c.set('#f-customerAccount','cari-gold-customer');
  c.document.querySelector('[data-open-exchange]').click();
  c.document.querySelector('[data-add-allocation="counterpayment"][data-payment-type="asset"]').click();
  c.set('[data-allocation-kind="counterpayment"] select','gramToplam');
  c.set('[data-allocation-kind="counterpayment"] [data-allocation-field="quantity"]','0.2');
  c.set('[data-allocation-kind="counterpayment"] [data-allocation-field="valueTL"]','1000');
  c.document.querySelector('[data-add-allocation="debt"]').click();
  c.set('[data-allocation-kind="debt"] [data-allocation-field="quantity"]','1000');
  const originalFetch=c.window.fetch;let first=lostResponse;
  c.window.fetch=async(url,options)=>{
    const result=await originalFetch(url,options);
    if(first&&options){first=false;await result.json();throw Error('Committed response lost');}
    return result;
  };
  c.submit('#sale-form');await tick();
  if(lostResponse){
    assert.equal(c.document.querySelectorAll('[data-allocation-kind="counterpayment"]').length,1);
    c.document.querySelector('#retry').click();await tick();
    assert.equal(c.commands.length,1,'Committed record is found without another POST');
  }
  assert.equal(repo.state().balances['cari-gold-customer'],-200000);
  assert.equal(repo.state().balances.gramToplam,19800);
  assert.equal(repo.state().journal.filter(e=>e.type==='collection').length,1);
  assert.equal(c.document.querySelectorAll('[data-allocation-kind]').length,0);
  assert.equal(c.document.querySelector('#sale-form [data-draft-stale]'),null);
  c.nav('overview');c.nav('transaction');
  assert.equal(c.document.querySelectorAll('[data-allocation-kind]').length,0);
  c.tab('purchase');assert.equal(c.document.querySelector('#f-note').value,'Unrelated purchase');
});
check('anonymous retail asks for an explicit customer before adding a receivable', async c => {
  const repo=c.repos.demo;
  for(const id of ['first','chosen'])repo.execute({id,revision:repo.state().revision,command:{type:'account',date:repo.state().date,name:id,partyType:'customer',unit:'TL',opening:'0'}});
  c.document.querySelector('#refresh').click();await tick();
  for(const mode of ['sale','purchase']){
    c.tab(mode);
    assert.equal(c.document.querySelector('#f-counterpartyId').value,'');
    c.document.querySelector('[data-add-allocation="debt"]').click();
    assert.equal(c.document.querySelector('#f-counterpartyId').value,'');
    assert.equal(c.document.querySelector('[data-allocation-kind="debt"]'),null);
    assert.equal(c.document.activeElement.id,'f-counterpartyId');
    c.set('#f-counterpartyId','cari-chosen');
    c.document.querySelector('[data-add-allocation="debt"]').click();
    assert.equal(c.document.querySelector('[data-allocation-kind="debt"] select').value,'cari-chosen');
  }
  assert.equal(c.commands.length,0);
});
check('unavailable consideration is visibly disabled and a real HAS account enables it', async c => {
  c.tab('sale');
  for(const type of ['has','silver']){
    const button=c.document.querySelector('[data-payment-type="'+type+'"]');
    assert.equal(button.disabled,true);
    assert.match(button.textContent,/hesap yok/i);
    button.click();assert.equal(c.document.querySelector('[data-allocation-kind="payment"]'),null);
  }
  const repo=c.repos.demo;
  repo.execute({id:'new-has',revision:repo.state().revision,command:{type:'fundAccount',date:repo.state().date,name:'HAS kasası',unit:'HAS',physical:true,opening:'1'}});
  c.document.querySelector('#refresh').click();await tick();
  const has=c.document.querySelector('[data-payment-type="has"]');
  assert.equal(has.disabled,false);has.click();
  assert.equal(c.document.querySelector('[data-allocation-kind="payment"] select').value,'fund-new-has');
});
check('retail introduction and draft guidance stay brief while financial preview remains', async c => {
  for(const mode of ['sale','purchase']){
    c.tab(mode);
    assert.equal(c.document.querySelector('#transaction-content > .subtitle').textContent,'Miktarı kendi biriminde, anlaşılmış bedeli TL olarak girin.');
    assert.ok(c.document.querySelector('#sale-equation'));
    assert.ok(c.document.querySelector('#trade-effects'));
    assert.match(c.document.querySelector('#sale-form').textContent,/Taslak · Bu sayfa kapanınca silinir/);
    assert.equal(c.document.querySelectorAll('.trade-primary > .context-note,.trade-opposite > .context-note').length,0);
  }
});
let failed = 0;
for (const { name, run } of checks) { const context = await fixture(); try { await run(context); console.log('PASS:', name); } catch (error) { failed++; console.error('FAIL:', name, '\n', error.message); } finally { context.close(); } }
if (failed) { console.error(`${failed}/${checks.length} draft checks failed.`); process.exitCode = 1; }
else console.log(`PASS: ${checks.length} in-memory draft and owner-page account behavior checks; no real data or service used.`);
