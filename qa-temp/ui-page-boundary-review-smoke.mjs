import * as supplierModule from '../public/suppliers.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadJSDOM } from '../test-support/jsdom.mjs';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS, workdaySummary } from '../domain.mjs';

const JSDOM = await loadJSDOM();
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const checks = [];
const check = (name, run) => checks.push({ name, run });
async function fixture() {
  const repos = Object.fromEntries(['demo','dukkan'].map(workspace => [workspace, new Repository(':memory:', workspace)]));
  const seed = (repo, id, command) => repo.execute({ id, revision: repo.state().revision, command: { date: '2026-10-28', ...command } });
  for (const [workspace, repo] of Object.entries(repos)) {
    const balances = Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, '0']));
    Object.assign(balances, { nakit: '10000', usd: '100', gramToplam: '100', pos: '500' });
    seed(repo, 'opening', { type: 'opening', balances });
    seed(repo, 'customer', { type: 'account', name: `${workspace} Müşteri`, unit: 'TL', opening: '200', partyType: 'customer' });
    seed(repo, 'supplier', { type: 'account', name: `${workspace} Firma`, unit: 'TL', opening: '-300', partyType: 'supplier' });
  }
  const dom = new JSDOM(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), { url: 'http://127.0.0.1:4317/', runScripts: 'outside-only' });
  const w = dom.window, d = w.document, commands = [];
  Object.defineProperty(w.crypto, 'randomUUID', { value: randomUUID });
  let failNext = null;
  w.fetch = async (url, options = {}) => {
    const u = new URL(url, w.location.href), q = Object.fromEntries(u.searchParams), repo = repos[q.workspace || 'demo'];
    try {
      let result;
      if (u.pathname === '/api/state') result = repo.state({ compact: true });
      else if (u.pathname === '/api/suppliers') result = repo.supplierDetail({...q,limit:Number(q.limit||50)});
      else if (u.pathname === '/api/journal') result = repo.journalPage({ ...q, limit: Number(q.limit || 25) });
      else if (u.pathname === '/api/account-statement') result = repo.accountStatement(q);
      else if (u.pathname === '/api/summary') result = workdaySummary(repo.state(), q.date);
      else if (u.pathname === '/api/command') {
        const envelope = JSON.parse(options.body); commands.push({ ...envelope, workspace: q.workspace });
        const failure = failNext; failNext = null;
        if (failure?.commit) result = repo.execute(envelope, { compact: true });
        if (failure) throw Object.assign(new Error('Sentetik doğrulama hatası'), { status: failure.status });
        if (!result) result = repo.execute(envelope, { compact: true });
      } else throw new Error('Unexpected route: ' + u.pathname);
      return { ok: true, status: 200, json: async () => result };
    } catch (error) { return { ok: false, status: error.status || 400, json: async () => ({ error: error.message }) }; }
  };
  w.__supplierModule=supplierModule;
  w.eval(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace("import('./suppliers.js')","Promise.resolve(window.__supplierModule)"));
  await tick();
  const find = selector => { const element = d.querySelector(selector); assert.ok(element, `Missing control ${selector}`); return element; };
  const click = async selector => { find(selector).click(); await tick(); };
  const set = (selector, value) => { const control = find(selector); control.value = value; control.dispatchEvent(new w.Event(control.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); };
  const nav = view => click(`#navigation [data-view="${view}"]`);
  const submit = async selector => { find(selector).requestSubmit(); await tick(); };
  const activeView = () => find('#navigation [aria-current="page"]').dataset.view;
  const prepareTrade = async (kind = 'sale') => {
    if (kind === 'supplier-purchase') { await nav('suppliers'); await click('[data-open-firm="cari-supplier"]'); await click('[data-supplier-task="purchase"]'); return; }
    else { await nav('transaction'); await click(`[data-tab="${kind}"]`); }
    set('[data-item-field="accountId"]', 'gramToplam'); set('[data-item-field="quantity"]', '2');
    set('[data-item-field="value"]', '120'); set('#f-note', 'Korunan işlem taslağı');
  };
  return { repos, repo: repos.demo, w, d, commands, find, click, set, nav, submit, activeView, prepareTrade, fail(status, commit = false) { failNext = { status, commit }; }, close() { w.close(); Object.values(repos).forEach(repo => repo.close()); } };
}

check('each operation has one canonical page and overview remains a shortcut', async c => {
  await c.nav('transaction');
  assert.equal(c.d.querySelector('[data-tab="transfer"]'), null);
  assert.equal(c.d.querySelector('[data-tab="settlement"]'), null);
  assert.equal(c.d.querySelector('#inline-account-form'), null);
  await c.click('[data-tab="movement"]'); assert.ok(c.d.querySelector('#movement-form'));
  assert.equal(c.d.querySelector('#transfer-form,#settlement-form'), null);
  await c.nav('banks'); await c.click('[data-bank-action="transfer"]'); assert.ok(c.d.querySelector('#transfer-form'));
  await c.click('[data-bank-action="settlement"]'); assert.ok(c.d.querySelector('#settlement-form')); assert.equal(c.d.querySelector('#transfer-form'), null);
  await c.nav('accounts'); assert.equal(c.d.querySelector('#account-form,#collection-form,#sale-form'), null);
  await c.click('#add-account'); assert.ok(c.d.querySelector('#account-form'));
  await c.nav('suppliers'); await c.click('[data-open-firm="cari-supplier"]'); await c.click('[data-supplier-task="purchase"]'); assert.equal(c.d.querySelector('#inline-account-form'), null);
  await c.nav('stocks'); await c.click('#stock-movement'); assert.ok(c.d.querySelector('#sale-form')); assert.equal(c.d.querySelector('#inline-account-form'), null);
  await c.nav('overview'); assert.equal(c.d.querySelector('#main form'), null);
  for (const kind of ['sale','purchase','collection']) { await c.nav('overview'); await c.click(`[data-quick-action="${kind}"]`); assert.equal(c.activeView(), 'transaction'); assert.ok(c.d.querySelector(kind === 'collection' ? '#collection-form' : '#sale-form')); }
  assert.equal(c.commands.length, 0, 'Navigation never writes the ledger');
});

check('canonical customer creation returns to a sale without losing its draft or auto-posting the sale', async c => {
  await c.prepareTrade();
  await c.click('[data-payment-type="cash"]'); c.set('[data-allocation-kind="payment"] [data-allocation-field="quantity"]', '40');
  await c.click('[data-create-party]'); assert.equal(c.activeView(), 'accounts');
  assert.equal(c.d.querySelector('#sale-form,#inline-account-form'), null);
  const name = '<img src=x onerror=alert(1)> & Test'; c.set('#f-name', name); c.set('#f-phone', '05550000009');
  await c.submit('#account-form');
  const created = c.repo.state().accounts.find(a => a.name === name); assert.ok(created); assert.equal(created.partyType, 'customer');
  assert.equal(c.activeView(), 'transaction'); assert.equal(c.find('[data-item-field="quantity"]').value, '2');
  assert.equal(c.find('[data-item-field="value"]').value, '120'); assert.equal(c.find('#f-note').value, 'Korunan işlem taslağı');
  assert.equal(c.find('[data-allocation-kind="payment"] [data-allocation-field="quantity"]').value, '40');
  assert.equal(c.d.querySelector('#sale-form [data-draft-stale]'), null);
  assert.equal(c.d.querySelector('#main img'), null, 'Party names must render as text');
  assert.equal(c.commands.length, 1); assert.equal(c.commands[0].command.type, 'account');
});

check('customer purchase route selects the new customer and never offers supplier debt accounts', async c => {
  await c.prepareTrade('purchase'); await c.click('[data-create-party]');
  c.set('#f-name', 'Yeni Müşteri'); await c.submit('#account-form');
  const created = c.repo.state().accounts.find(a => a.name === 'Yeni Müşteri'); assert.ok(created);
  assert.equal(c.activeView(), 'transaction'); assert.equal(c.find('#f-counterpartyId').value, created.id);
  assert.equal(c.find('[data-item-field="value"]').value, '120');
  assert.ok([...c.find('#f-counterpartyId').options].every(option => option.value !== 'cari-supplier'));
  assert.equal(c.commands[0].command.partyType, 'customer');
});

check('supplier creation stays in its unitless owner workflow and never selects a customer', async c => {
  await c.nav('suppliers');await c.click('[data-create-firm]');c.set('[name="name"]','Yeni Firma');await c.submit('[data-supplier-form="create"]');
  const created=c.repo.state().supplierParties.find(a=>a.name==='Yeni Firma');assert.ok(created);assert.equal(created.accounts.length,0);
  assert.equal(c.activeView(),'suppliers');assert.equal(c.d.querySelector('#sale-form'),null);
  await c.click('[data-open-firm="'+created.id+'"]');await c.click('[data-supplier-task="purchase"]');
  assert.ok(c.find('[data-supplier-form="purchase"]'));assert.equal(c.d.querySelector('#f-counterpartyId'),null);
  assert.equal(c.commands.length,1);assert.equal(c.commands[0].command.type,'supplierFirm');
});

check('cancel creation returns to the unmodified originating operation with meaningful focus', async c => {
  await c.prepareTrade('purchase'); c.set('#f-counterpartyId', 'cari-customer');
  const route = c.find('[data-create-party]'); assert.equal(route.tagName, 'BUTTON'); assert.notEqual(route.type, 'submit'); route.focus(); assert.equal(c.d.activeElement, route);
  await c.click('[data-create-party]'); c.set('#f-name', 'Kaydedilmeyecek kişi');
  const back = c.find('[data-return-operation]'); assert.equal(back.tagName, 'BUTTON'); back.focus(); await c.click('[data-return-operation]');
  assert.equal(c.activeView(), 'transaction'); assert.equal(c.find('#f-counterpartyId').value, 'cari-customer');
  assert.equal(c.find('[data-item-field="value"]').value, '120'); assert.equal(c.find('#f-note').value, 'Korunan işlem taslağı');
  assert.ok(c.find('#main').contains(c.d.activeElement) || c.d.activeElement === c.find('#main'));
  assert.equal(c.commands.length, 0); assert.ok(!c.repo.state().accounts.some(a => a.name === 'Kaydedilmeyecek kişi'));
});

check('validation failure stays in the canonical editor and preserves caller draft for retry', async c => {
  await c.prepareTrade(); await c.click('[data-create-party]'); c.set('#f-name', 'Tekrar denenecek kişi');
  c.fail(400); await c.submit('#account-form');
  assert.equal(c.activeView(), 'accounts'); assert.equal(c.find('#f-name').value, 'Tekrar denenecek kişi');
  assert.match(c.find('#notice').textContent, /Sentetik doğrulama/);
  assert.ok(!c.repo.state().accounts.some(a => a.name === 'Tekrar denenecek kişi'));
  await c.submit('#account-form'); assert.equal(c.activeView(), 'transaction');
  assert.equal(c.find('[data-item-field="value"]').value, '120');
  assert.equal(c.repo.state().accounts.filter(a => a.name === 'Tekrar denenecek kişi').length, 1);
});

check('uncertain account creation only returns after retry verifies the same request once', async c => {
  await c.prepareTrade('purchase'); await c.click('[data-create-party]'); c.set('#f-name', 'Belirsiz cevap');
  c.fail(500, true); await c.submit('#account-form');
  assert.equal(c.activeView(), 'accounts'); assert.equal(c.find('#retry-bar').hidden, false);
  assert.equal(c.repo.state().accounts.filter(a => a.name === 'Belirsiz cevap').length, 1);
  await c.click('#retry'); assert.equal(c.activeView(), 'transaction');
  assert.equal(c.commands.length,1,'Query resolves committed creation without a second POST'); assert.equal(c.repo.state().accounts.filter(a => a.name === 'Belirsiz cevap').length, 1);
  assert.equal(c.find('[data-item-field="value"]').value, '120'); assert.equal(c.find('#sale-form').dataset.draftStale, 'false');
});

check('return context never jumps into another workspace or attaches a differently typed party', async c => {
  await c.prepareTrade('purchase'); await c.click('[data-create-party]');
  c.set('#workspace', 'dukkan'); await tick();
  assert.equal(c.d.querySelector('[data-return-operation]'), null, 'Demo return context must not be actionable in another ledger');
  await c.nav('suppliers'); await c.click('[data-create-firm]'); c.set('[name="name"]', 'Bağımsız firma'); await c.submit('[data-supplier-form="create"]');
  assert.equal(c.activeView(), 'suppliers'); assert.equal(c.d.querySelector('#sale-form'), null);
  assert.equal(c.repos.dukkan.state().supplierParties.find(a => a.name === 'Bağımsız firma').accounts.length, 0);
  assert.ok(!c.repo.state().supplierParties.some(a => a.name === 'Bağımsız firma'));
  c.set('#workspace', 'demo'); await tick(); await c.nav('transaction'); await c.click('[data-tab="purchase"]');
  assert.equal(c.find('[data-item-field="value"]').value, '120');
  assert.ok([...c.find('#f-counterpartyId').options].every(option => !option.textContent.includes('Bağımsız firma')));
});

check('bank transfer and POS drafts stay on the bank page after a round trip to transaction', async c => {
  await c.nav('banks'); await c.click('[data-bank-action="transfer"]'); c.set('#f-quantity', '25'); c.set('#f-note', 'Banka taslağı');
  await c.click('[data-bank-action="settlement"]'); c.set('#f-gross', '100'); c.set('#f-expected', '97');
  await c.nav('transaction'); await c.click('[data-tab="movement"]'); assert.equal(c.d.querySelector('#transfer-form,#settlement-form'), null);
  await c.nav('banks'); assert.equal(c.find('#f-gross').value, '100'); assert.equal(c.find('#f-expected').value, '97');
  await c.click('[data-bank-action="transfer"]'); assert.equal(c.find('#f-quantity').value, '25'); assert.equal(c.find('#f-note').value, 'Banka taslağı');
  assert.equal(c.commands.length, 0);
});

check('an unrelated supplier creation cannot consume a pending customer return context', async c => {
  await c.prepareTrade('purchase'); await c.click('[data-create-party]');
  await c.nav('suppliers'); await c.click('[data-create-firm]'); c.set('[name="name"]', 'Bağımsız toptancı'); await c.submit('[data-supplier-form="create"]');
  assert.equal(c.activeView(), 'suppliers'); assert.equal(c.d.querySelector('#sale-form'), null);
  assert.equal(c.repo.state().supplierParties.find(a => a.name === 'Bağımsız toptancı').accounts.length, 0);
  await c.nav('transaction'); await c.click('[data-tab="purchase"]');
  assert.equal(c.find('[data-item-field="value"]').value, '120');
  assert.ok([...c.find('#f-counterpartyId').options].every(option => !option.textContent.includes('Bağımsız toptancı')));
});

check('ordinary customer creation stays on its owner page even when another transaction draft exists', async c => {
  await c.prepareTrade(); await c.nav('accounts'); await c.click('#add-account');
  c.set('#f-name', 'Normal eklenen kişi'); await c.submit('#account-form');
  assert.equal(c.activeView(), 'accounts'); assert.equal(c.d.querySelector('#sale-form'), null);
  await c.nav('transaction'); assert.equal(c.find('[data-item-field="value"]').value, '120');
  assert.ok(c.d.querySelector('#sale-form [data-draft-stale]'), 'An unrelated mutation must not silently approve an existing draft');
});

check('a routed creation cannot silently approve a caller draft changed by another ledger update', async c => {
  await c.prepareTrade(); await c.click('[data-create-party]'); c.set('#f-name', 'Sonradan eklenen kişi');
  const state = c.repo.state();
  c.repo.execute({ id: 'external-change', revision: state.revision, command: { type: 'movement', date: state.date, accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '1' } });
  await c.click('#refresh');
  const review = c.d.querySelector('#account-form [data-review-draft]'); if (review) { review.click(); await tick(); }
  await c.submit('#account-form');
  assert.equal(c.activeView(), 'transaction'); assert.equal(c.find('[data-item-field="value"]').value, '120');
  assert.ok(c.d.querySelector('#sale-form [data-draft-stale]'), 'Only the creation itself may advance a current draft; unrelated changes still require review');
  assert.equal(c.find('#sale-form button[type="submit"]').disabled, true);
});

check('journal amendment does not offer an owner-creation route that changes its captured revision', async c => {
  const state = c.repo.state();
  c.repo.execute({ id: 'editable-sale', revision: state.revision, command: { type: 'sale', date: state.date, items: [{ accountId: 'gramToplam', quantity: '2', value: '120' }], payments: [{ accountId: 'nakit', quantity: '120', valueTL: '120' }], credits: [], scrap: [], note: 'Düzenlenecek kayıt' } });
  await c.click('#refresh'); await c.nav('journal'); await c.click('[data-edit-transaction]');
  assert.ok(c.d.querySelector('#edit-operation #sale-form'));
  assert.equal(c.d.querySelector('#edit-operation [data-create-party]'), null, 'Amendment must keep its original revision and only offer existing parties');
  assert.equal(c.commands.length, 0);
});

check('routed customer creation cannot adopt a different unfinished owner profile draft', async c => {
  await c.nav('accounts'); await c.click('#add-account');
  c.set('#f-name', 'Önceki kişi taslağı'); c.set('#f-phone', '05551112233'); c.set('#f-address', 'Önceki kişinin adresi');
  await c.prepareTrade(); await c.click('[data-create-party]');
  assert.equal(c.find('#f-name').value, '', 'A different operation must not silently reuse the unfinished profile');
  assert.equal(c.find('#f-phone').value, ''); assert.equal(c.find('#f-address').value, '');
  c.set('#f-name', 'Satıştaki yeni kişi'); await c.submit('#account-form');
  const created = c.repo.state().accounts.find(a => a.name === 'Satıştaki yeni kişi');
  assert.ok(created); assert.ok(!created.phone && !created.address, 'Unrelated PII must not leak into the new account');
  await c.nav('accounts'); if (!c.d.querySelector('#account-form')) await c.click('#add-account');
  assert.equal(c.find('#f-name').value, 'Önceki kişi taslağı'); assert.equal(c.find('#f-phone').value, '05551112233');
  assert.equal(c.commands.length, 1);
});

check('editing an existing customer inside the owner page cannot consume the new-customer return route', async c => {
  await c.prepareTrade(); await c.click('[data-create-party]');
  await c.click('[data-account-detail="cari-customer"]'); await c.click('#edit-card');
  c.set('#f-phone', '05554445566'); await c.submit('#account-edit-form');
  assert.equal(c.activeView(), 'accounts'); assert.equal(c.d.querySelector('#sale-form'), null);
  assert.equal(c.repo.state().accounts.find(a => a.id === 'cari-customer').phone, '05554445566');
  assert.equal(c.commands.length, 1); assert.equal(c.commands[0].command.type, 'accountUpdate');
  await c.nav('transaction'); assert.equal(c.find('[data-item-field="value"]').value, '120');
  assert.ok(c.d.querySelector('#sale-form [data-draft-stale]'), 'Unrelated profile edits cannot approve a sale draft');
});

let failed = 0;
for (const { name, run } of checks) {
  const c = await fixture();
  try { await run(c); console.log('PASS:', name); }
  catch (error) { failed++; console.error('FAIL:', name, '\n', error.stack); }
  finally { c.close(); }
}
if (failed) { console.error(`${failed}/${checks.length} independent page-boundary checks failed.`); process.exitCode = 1; }
else console.log(`PASS: ${checks.length} independent page-boundary checks; synthetic memory repositories only.`);
