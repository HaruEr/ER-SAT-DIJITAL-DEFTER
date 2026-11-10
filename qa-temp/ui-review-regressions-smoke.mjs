import * as supplierModule from '../public/suppliers.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadJSDOM } from '../test-support/jsdom.mjs';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS, workdaySummary } from '../domain.mjs';

const JSDOM = await loadJSDOM();
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const cases = [];
const check = (name, run, options) => cases.push({ name, run, options });
async function fixture({ unopened = false } = {}) {
  const repo = new Repository(':memory:', 'demo');
  const execute = command => repo.execute({ id: randomUUID(), revision: repo.state().revision, command: { date: repo.state().date, ...command } });
  let first, second, supplier;
  if (!unopened) {
    execute({ type: 'opening', date: '2026-10-28', balances: Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, a.id === 'nakit' ? '10000' : a.id === 'pos' ? '100' : '0'])) });
    first = execute({ type: 'account', name: 'Birinci Müşteri', phone: '05550000001', unit: 'TL', opening: '100', partyType: 'customer' }).state.accounts.at(-1).id;
    second = execute({ type: 'account', name: 'İkinci Müşteri', phone: '05550000002', unit: 'TL', opening: '200', partyType: 'customer' }).state.accounts.at(-1).id;
    supplier = execute({ type: 'account', name: 'Birinci Firma', unit: 'TL', opening: '-300', partyType: 'supplier' }).state.accounts.at(-1).id;
  }
  const dom = new JSDOM(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), { url: 'http://127.0.0.1:4317/', runScripts: 'outside-only' });
  const w = dom.window, d = w.document, calls = [];
  Object.defineProperty(w.crypto, 'randomUUID', { value: randomUUID });
  w.fetch = async (url, options = {}) => {
    const u = new URL(url, w.location.href), q = Object.fromEntries(u.searchParams);
    try {
      let result;
      if (u.pathname === '/api/state') result = repo.state({ compact: true });
      else if (u.pathname === '/api/suppliers') result = repo.supplierDetail({...q,limit:Number(q.limit||50)});
      else if (u.pathname === '/api/journal') result = repo.journalPage({ ...q, limit: Number(q.limit || 25) });
      else if (u.pathname === '/api/account-statement') result = repo.accountStatement(q);
      else if (u.pathname === '/api/summary') result = workdaySummary(repo.state(), q.date);
      else if (u.pathname === '/api/command') { const envelope = JSON.parse(options.body); calls.push(envelope); result = repo.execute(envelope, { compact: true }); }
      else throw new Error('Unexpected test route ' + u.pathname);
      return { ok: true, status: 200, json: async () => result };
    } catch (error) { return { ok: false, status: error.status || 400, json: async () => ({ error: error.message }) }; }
  };
  w.__supplierModule=supplierModule;
  w.eval(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace("import('./suppliers.js')","Promise.resolve(window.__supplierModule)") + '\nwindow.__review = {setView};');
  await tick();
  const set = (selector, value) => { const control = d.querySelector(selector); assert.ok(control, selector); control.value = value; control.dispatchEvent(new w.Event(control.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); };
  const click = async selector => { const button = d.querySelector(selector); assert.ok(button, selector); button.click(); await tick(); };
  const nav = async view => { w.__review.setView(view); await tick(); };
  const edit = async id => { await click(`[data-account-detail="${id}"]`); await click('#edit-card'); };
  return { repo, execute, first, second, supplier, w, d, calls, set, click, nav, edit, close() { w.close(); repo.close(); } };
}

check('customer profile drafts never cross account identity', async c => {
  await c.nav('accounts'); await c.edit(c.first); c.set('#f-name', 'Birinci taslak');
  await c.nav('overview'); await c.nav('accounts'); await c.edit(c.second);
  assert.equal(c.d.querySelector('#f-name').value, 'İkinci Müşteri');
  assert.equal(c.d.querySelector('#f-phone').value, '05550000002');
  await c.edit(c.first); assert.equal(c.d.querySelector('#f-name').value, 'Birinci taslak');
  assert.equal(c.calls.length, 0);
});
check('new stock draft cannot overwrite a different existing stock name', async c => {
  await c.nav('stocks'); await c.click('#add-stock'); c.set('#f-name', 'YENİ STOK TASLAĞI');
  await c.nav('overview'); await c.nav('stocks'); await c.edit('ceyrek');
  assert.equal(c.d.querySelector('#f-name').value, 'ÇEYREK');
  c.set('#f-name', 'ÇEYREK TASLAĞI'); await c.edit('yarim'); assert.equal(c.d.querySelector('#f-name').value, 'YARIM');
  assert.equal(c.calls.length, 0);
});
check('supplier operation switches and navigation retain the native purchase draft', async c => {
  await c.nav('suppliers'); await c.click('[data-open-firm="'+c.supplier+'"]'); await c.click('[data-supplier-task="purchase"]');
  await c.click('[data-group="items"] [data-add-row]');c.set('[data-group="items"] [data-field="accountId"]','gramToplam');c.set('[data-group="items"] [data-field="quantity"]','2');c.set('[name="note"]','Firma alış taslağı');
  await c.click('[data-supplier-task="payment"]');c.set('[name="note"]','Ödeme taslağı');
  await c.click('[data-supplier-task="purchase"]');assert.equal(c.d.querySelector('[data-group="items"] [data-field="quantity"]').value,'2');
  await c.nav('overview'); await c.nav('suppliers');assert.ok(c.d.querySelector('[data-supplier-form="purchase"]'));assert.equal(c.d.querySelector('[name="note"]').value,'Firma alış taslağı');assert.equal(c.calls.length,0);
});
check('new supplier identity is unitless and does not adopt another firm purchase draft', async c => {
  await c.nav('suppliers');await c.click('[data-open-firm="'+c.supplier+'"]');await c.click('[data-supplier-task="purchase"]');c.set('[name="note"]','Önceki firmanın taslağı');
  await c.click('[data-back-suppliers]');await c.click('[data-create-firm]');c.set('[name="name"]','Yeni Firma');c.set('[name="phone"]','05550000003');
  c.d.querySelector('[data-supplier-form="create"]').requestSubmit();await tick();
  const created=c.repo.state().supplierParties.find(a=>a.name==='Yeni Firma');assert.ok(created);assert.equal(created.accounts.length,0);
  await c.click('[data-open-firm="'+created.id+'"]');await c.click('[data-supplier-task="purchase"]');assert.equal(c.d.querySelector('[name="note"]').value,'');
  await c.click('[data-back-suppliers]');await c.click('[data-open-firm="'+c.supplier+'"]');await c.click('[data-supplier-task="purchase"]');assert.equal(c.d.querySelector('[name="note"]').value,'Önceki firmanın taslağı');assert.equal(c.calls.length,1);
});
check('bank operation switches preserve transfer and settlement drafts independently', async c => {
  await c.nav('banks'); await c.click('[data-bank-action="transfer"]'); c.set('#f-quantity', '25'); c.set('#f-note', 'Aktarım taslağı');
  await c.click('[data-bank-action="settlement"]'); c.set('#f-gross', '100'); c.set('#f-expected', '97');
  await c.click('[data-bank-action="transfer"]'); assert.equal(c.d.querySelector('#f-quantity').value, '25');
  await c.click('[data-bank-action="settlement"]'); assert.equal(c.d.querySelector('#f-expected').value, '97');
  await c.nav('overview'); await c.nav('banks'); assert.equal(c.d.querySelector('#f-fee')?.value, '3.00');
});
check('bank create collapse and reopen preserves fields and rename drafts are per bank', async c => {
  const bank2 = c.execute({ type: 'fundAccount', name: 'İkinci Banka', unit: 'TL', physical: false, opening: '0' }).state.accounts.at(-1).id;
  await c.click('#refresh'); await c.nav('banks'); await c.click('#add-bank'); c.set('#f-name', 'Banka taslağı');
  await c.click('#add-bank'); await c.click('#add-bank'); assert.equal(c.d.querySelector('#f-name').value, 'Banka taslağı');
  await c.click('[data-bank-rename="banka"]'); c.set('#f-name', 'Birinci Banka taslağı');
  await c.nav('overview'); await c.nav('banks'); await c.click(`[data-bank-rename="${bank2}"]`);
  assert.equal(c.d.querySelector('#f-name').value, 'İkinci Banka'); assert.equal(c.calls.length, 0);
});
check('opening bank rows survive refresh with explicit zero and foreign currency', async c => {
  await c.click('#opening-bank-add'); c.set('#f-bankName0', 'Banka A'); c.set('#f-bankOpening0', '0');
  await c.click('#opening-bank-add'); c.set('#f-bankName1', 'Banka B'); c.set('#f-bankUnit1', 'USD'); c.set('#f-bankOpening1', '75');
  await c.click('#refresh'); const rows = c.d.querySelectorAll('[data-opening-bank]'); assert.equal(rows.length, 2);
  assert.equal(rows[0].querySelector('[name^="bankOpening"]').value, '0'); assert.equal(rows[1].querySelector('select').value, 'USD');
  assert.equal(rows[1].querySelector('[name^="bankOpening"]').value, '75');
}, { unopened: true });
check('supplier identity and operation forms never keep duplicate IDs after switching', async c => {
  await c.nav('suppliers');await c.click('[data-create-firm]');
  const ids=[...c.d.querySelectorAll('[id]')].map(el=>el.id);assert.equal(new Set(ids).size,ids.length);
  await c.click('[data-open-firm="'+c.supplier+'"]');await c.click('[data-supplier-task="payment"]');
  const names=[...c.d.querySelectorAll('#main [id]')].map(el=>el.id);assert.equal(new Set(names).size,names.length);assert.equal(c.d.querySelector('[data-supplier-form="create"]'),null);
});
check('paid customer purchase remains visible in payee statement with no receivable delta', async c => {
  c.execute({ type: 'purchase', source: 'customer', counterpartyId: c.first, items: [{ accountId: 'hurda14', quantity: '1', value: '100' }], payments: [{ accountId: 'nakit', quantity: '100', valueTL: '100' }], debts: [], note: 'Peşin müşteriden alış' });
  await c.click('#refresh'); await c.nav('accounts'); await c.click(`[data-account-detail="${c.first}"]`);
  assert.match(c.d.querySelector('#statement-result').textContent, /Peşin müşteriden alış/);
  assert.equal(c.repo.state().balances[c.first], 10000);
});
check('customer server validation error preserves editable fields for retry', async c => {
  await c.nav('accounts'); await c.click('#add-account'); c.set('#f-name', 'Doğrulama Müşterisi'); c.set('#f-taxId', 'invalid');
  c.d.querySelector('#account-form').requestSubmit(); await tick(); assert.equal(c.repo.state().accounts.some(a => a.name === 'Doğrulama Müşterisi'), false);
  assert.equal(c.d.querySelector('#f-name').value, 'Doğrulama Müşterisi'); c.set('#f-taxId', '12345678901');
  c.d.querySelector('#account-form').requestSubmit(); await tick(); assert.ok(c.repo.state().accounts.some(a => a.name === 'Doğrulama Müşterisi'));
});
check('legacy untyped supplier can be classified without changing balance or old events', async c => {
  const legacy = c.execute({ type: 'account', name: 'Eski Toptancı', unit: 'TL', opening: '-450' }).state.accounts.at(-1).id;
  const before = c.repo.state(), original = before.journal.find(event => event.meta.accountId === legacy);
  assert.equal(before.accounts.find(a => a.id === legacy).partyType, undefined);
  await c.click('#refresh'); await c.nav('accounts'); await c.edit(legacy);
  assert.ok(c.d.querySelector('#f-partyType')); c.set('#f-partyType', 'supplier');
  c.d.querySelector('#account-edit-form').requestSubmit(); await tick();
  const after = c.repo.state(); assert.equal(after.accounts.find(a => a.id === legacy).partyType, 'supplier');
  assert.equal(after.balances[legacy], before.balances[legacy]); assert.deepEqual(after.journal.find(event => event.id === original.id), original);
  assert.equal(c.d.querySelector(`[data-account-detail="${legacy}"]`), null);
  await c.nav('suppliers'); assert.ok(c.d.querySelector(`[data-open-firm="${legacy}"]`));
});
check('bank rename saves one identity and does not resurrect the submitted draft', async c => {
  await c.nav('banks'); await c.click('[data-bank-rename="banka"]'); c.set('#f-name', 'İsimli Banka');
  c.d.querySelector('#bank-rename-form').requestSubmit(); await tick();
  assert.equal(c.repo.state().accounts.find(a => a.id === 'banka').name, 'İsimli Banka');
  assert.equal(c.d.querySelector('#bank-rename-form'), null);
  await c.click('[data-bank-rename="banka"]'); assert.equal(c.d.querySelector('#f-name').value, 'İsimli Banka');
  assert.equal(c.d.querySelector('[data-draft-stale="true"],[role="alert"][data-draft-stale]'), null);
});

let failures = 0;
for (const { name, run, options } of cases) {
  const context = await fixture(options);
  try { await run(context); console.log('PASS:', name); }
  catch (error) { failures++; console.error('FAIL:', name, '\n', error.stack); }
  finally { context.close(); }
}
if (failures) { console.error(`${failures}/${cases.length} independent review regression checks failed.`); process.exitCode = 1; }
else console.log(`PASS: ${cases.length} independent review regressions, synthetic memory repositories only.`);
