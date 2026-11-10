import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadJSDOM } from '../test-support/jsdom.mjs';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS, workdaySummary } from '../domain.mjs';

const JSDOM = await loadJSDOM();
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const cases = [];
const check = (name, run) => cases.push({ name, run });

async function fixture({ initialFailure = false } = {}) {
  const repo = new Repository(':memory:', 'demo');
  const execute = command => repo.execute({ id: randomUUID(), revision: repo.state().revision, command });
  const balances = Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, '0']));
  Object.assign(balances, { nakit: '10000', gramToplam: '20' });
  execute({ type: 'opening', date: '2026-10-27', balances });
  execute({ type: 'account', date: repo.state().date, name: 'Örnek cari <img src=x>', unit: 'TL', opening: '100' });
  execute({ type: 'movement', date: repo.state().date, accountId: 'nakit', category: 'Sermaye', direction: 'in', quantity: '1', note: 'İstanbul kasa çeyrek <img src=x>' });
  execute({ type: 'sale', date: repo.state().date, items: [{ accountId: 'gramToplam', quantity: '1', value: '100' }], cash: '100', pos: '0', bank: '0', scrapQuantity: '0', scrapValue: '0', note: 'Örnek satış' });
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:4317/', runScripts: 'outside-only' });
  const { window } = dom, document = window.document;
  Object.defineProperty(window.crypto, 'randomUUID', { value: randomUUID });
  const controller = { initialFailure, delay: null, commands: 0, summaryFailure: false };
  window.fetch = async (url, options) => {
    const route = new URL(url, window.location.href).pathname;
    if (route === '/api/state') {
      if (controller.initialFailure) throw new Error('Sentetik bağlantı kesintisi <img src=x>');
      return { ok: true, status: 200, json: async () => repo.state() };
    }
    if (route === '/api/summary') {
      if (controller.summaryFailure) return { ok: false, status: 500, json: async () => ({ error: 'Sentetik özet hatası <img src=x>' }) };
      return { ok: true, status: 200, json: async () => workdaySummary(repo.state(), new URL(url, window.location.href).searchParams.get('date')) };
    }
    assert.equal(route, '/api/command');
    controller.commands++;
    if (controller.delay) await controller.delay;
    try { const result = repo.execute(JSON.parse(options.body)); return { ok: true, status: 200, json: async () => result }; }
    catch (error) { return { ok: false, status: error.status || 400, json: async () => ({ error: error.message }) }; }
  };
  window.eval(source + '\nwindow.__ux = { setView, submit, inform };');
  await tick();
  return { repo, window, document, controller, close() { window.close(); repo.close(); } };
}

check('dashboard quick actions open the matching transaction or daily count', async ({ window, document }) => {
  assert.ok(document.querySelector('.quick-actions').compareDocumentPosition(document.querySelector('.stats')) & window.Node.DOCUMENT_POSITION_FOLLOWING, 'D03 operations precede balance reading');
  for (const [action, selector] of [['sale', '#sale-form'], ['purchase', '#sale-form'], ['collection', '#collection-form'], ['closing', '#close-form']]) {
    window.__ux.setView('overview');
    const button = document.querySelector(`[data-quick-action="${action}"]`);
    assert.ok(button, action);
    button.click();
    assert.ok(document.querySelector(selector));
    if (action !== 'closing') assert.equal(document.querySelector(`[data-tab="${action}"]`).getAttribute('aria-pressed'), 'true');
  }
});

check('initial load stays quiet while explicit refresh reports completion', async ({ window, document }) => {
  assert.equal(document.querySelector('#notice').hidden, true);
  document.querySelector('#refresh').click(); await tick();
  assert.equal(document.querySelector('#notice').hidden, false);
  assert.match(document.querySelector('#notice').textContent, /Defter yenilendi/);
});

check('summary announces short loading, success and safe error states outside its table', async ({ controller, window, document }) => {
  window.__ux.setView('summary');
  const status = document.querySelector('#summary-status'), result = document.querySelector('#summary-result');
  assert.ok(status);
  assert.equal(status.getAttribute('role'), 'status'); assert.equal(status.getAttribute('aria-live'), 'polite');
  assert.equal(status.getAttribute('aria-atomic'), 'true'); assert.match(status.textContent, /hazırlanıyor/);
  assert.equal(result.hasAttribute('aria-live'), false); assert.equal(result.closest('[aria-live]'), null);
  assert.equal(result.contains(status), false); assert.equal(result.getAttribute('role'), 'region');
  assert.ok(result.getAttribute('aria-label'));
  await tick();
  assert.match(status.textContent, /özet.*hazır/i); assert.ok(status.textContent.length < 100);
  assert.equal(status.querySelector('table'), null); assert.ok(result.querySelector('table'));
  assert.equal(result.querySelector('.table-wrap').tabIndex, 0);
  controller.summaryFailure = true;
  document.querySelector('#summary-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  assert.match(status.textContent, /hazırlanıyor/); await tick();
  assert.match(status.textContent, /Özet alınamadı/); assert.ok(status.textContent.length < 100);
  assert.match(result.textContent, /<img src=x>/); assert.equal(document.querySelector('img'), null);
});

check('four primary operation choices keep keyboard focus and move setup to its own pages', async ({ window, document }) => {
  window.__ux.setView('transaction');
  assert.equal(document.querySelectorAll('.transaction-primary [data-tab]').length, 4);
  assert.deepEqual([...document.querySelectorAll('.transaction-primary [data-tab]')].map(button => button.dataset.tab), ['sale', 'purchase', 'movement', 'collection']);
  assert.equal(document.querySelector('[data-tab="account"], [data-tab="fund"]'), null);
  document.querySelector('[data-tab="purchase"]').focus();
  document.querySelector('[data-tab="purchase"]').click();
  assert.equal(document.activeElement.dataset.tab, 'purchase');
  assert.equal(document.activeElement.getAttribute('aria-controls'), 'transaction-content');
});

check('journal search, operation filter and clear preserve scope and escape user text', async ({ window, document }) => {
  window.__ux.setView('journal');
  const search = document.querySelector('#journal-search'), type = document.querySelector('#journal-type');
  assert.ok(search); assert.ok(type);
  search.value = 'istanbul'; search.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(document.querySelectorAll('.journal-item').length, 1);
  assert.match(document.querySelector('#journal-results-count').textContent, /1/);
  assert.equal(document.querySelector('img'), null);
  for (const [query, count] of [['ISTANBUL', 1], ['ceyrek', 2], ['satis', 1]]) {
    search.value = query; search.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal(document.querySelectorAll('.journal-item').length, count, query);
  }
  search.value = '<img src=x>'; search.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(document.querySelectorAll('.journal-item').length, 2);
  type.value = 'sale'; type.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(document.querySelectorAll('.journal-item').length, 0);
  assert.match(document.querySelector('#journal-list').textContent, /bulunamadı/i);
  assert.ok(document.querySelector('#journal-empty-clear'));
  assert.equal(document.querySelector('img'), null);
  document.querySelector('#journal-scope').value = 'all';
  document.querySelector('#journal-empty-clear').click();
  assert.equal(document.querySelector('#journal-scope').value, 'all');
  assert.equal(search.value, ''); assert.equal(type.value, 'all');
  assert.equal(document.querySelectorAll('.journal-item').length, 4);
  type.value = 'sale'; type.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(document.querySelectorAll('.journal-item').length, 1);
  const tableRegion = document.querySelector('.table-wrap');
  assert.equal(tableRegion.tabIndex, 0); assert.equal(tableRegion.getAttribute('role'), 'region');
  assert.match(tableRegion.getAttribute('aria-label'), /tablo/);
});

check('required fields expose connected hints and native invalid feedback', async ({ window, document }) => {
  window.__ux.setView('accounts'); document.querySelector('#add-account').click();
  const input = document.querySelector('#f-opening');
  assert.equal(input.getAttribute('aria-required'), 'true');
  const hint = document.getElementById(input.getAttribute('aria-describedby'));
  assert.ok(hint); assert.match(hint.textContent, /pozitif/i);
  assert.match(document.querySelector('label[for="f-opening"]').textContent, /zorunlu/);
  const name = document.querySelector('#f-name'); name.value = '';
  name.dispatchEvent(new window.Event('invalid', { cancelable: true }));
  assert.equal(name.getAttribute('aria-invalid'), 'true');
  assert.equal(document.querySelector('#notice').getAttribute('role'), 'alert');
  name.value = 'Geçerli isim'; name.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(name.hasAttribute('aria-invalid'), false);
  window.__ux.setView('closing');
  assert.match(document.querySelector('#daily-count-nakit').getAttribute('aria-label'), /TL/);
  assert.match(document.querySelector('#daily-count-nakit').getAttribute('aria-label'), /günlük/);
});

check('notices use safe live semantics and preserve a focused form field', async ({ window, document }) => {
  window.__ux.setView('accounts'); document.querySelector('#add-account').click();
  const input = document.querySelector('#f-name'); input.focus();
  window.__ux.inform('Alanı kontrol edin <img src=x>', true);
  assert.equal(document.querySelector('#notice').getAttribute('role'), 'alert');
  assert.equal(document.querySelector('#notice').getAttribute('aria-live'), 'assertive');
  assert.equal(document.activeElement, input); assert.equal(document.querySelector('img'), null);
  window.__ux.inform('İşlem kaydedildi.');
  assert.equal(document.querySelector('#notice').getAttribute('role'), 'status');
  assert.equal(document.querySelector('#notice').getAttribute('aria-live'), 'polite');
});

check('request busy state protects drafts and error/success focus is recoverable', async ({ repo, controller, window, document }) => {
  window.__ux.setView('accounts'); document.querySelector('#add-account').click();
  const input = document.querySelector('#f-name'); input.value = 'Taslak korunur'; input.focus();
  let release; controller.delay = new Promise(resolve => { release = resolve; });
  const command = window.__ux.submit({ type: 'movement', accountId: 'nakit', category: 'Sermaye', direction: 'in', quantity: '0', note: 'Reddedilecek' });
  assert.equal(input.disabled, true);
  release(); await command; controller.delay = null;
  assert.equal(input.disabled, false); assert.equal(input.value, 'Taslak korunur'); assert.equal(document.activeElement, input);
  const revision = repo.state().revision;
  await window.__ux.submit({ type: 'account', name: 'Yeni cari', unit: 'TL', opening: '0' });
  assert.equal(repo.state().revision, revision + 1);
  assert.equal(document.activeElement.id, 'main');
});

check('dynamic product rows retain draft values and focus the added or surviving control', async ({ window, document }) => {
  window.__ux.setView('transaction');
  const quantity = document.querySelector('[data-item-field="quantity"]'); quantity.value = '2';
  document.querySelector('#add-sale-item').click();
  const rows = document.querySelectorAll('.sale-item'); assert.equal(rows.length, 2);
  assert.equal(document.activeElement, rows[1].querySelector('[data-item-field="accountId"]'));
  const remove = rows[1].querySelector('[data-remove-item]'); remove.focus(); remove.click();
  assert.equal(document.querySelectorAll('.sale-item').length, 1);
  assert.equal(document.activeElement, document.querySelector('[data-item-field="accountId"]'));
  assert.equal(quantity.value, '2');
});

let failed = 0;
for (const { name, run } of cases) {
  const context = await fixture();
  try { await run(context); console.log('PASS:', name); }
  catch (error) { failed++; console.error('FAIL:', name, '\n', error.message); }
  finally { context.close(); }
}
const failure = await fixture({ initialFailure: true });
try {
  assert.ok(failure.document.querySelector('#load-retry'));
  assert.match(failure.document.querySelector('#main').textContent, /Defter açılamadı/);
  assert.equal(failure.document.querySelector('img'), null);
  failure.controller.initialFailure = false;
  failure.document.querySelector('#load-retry').click(); await tick();
  assert.equal(failure.document.querySelector('#load-retry'), null);
  assert.match(failure.document.querySelector('#main h1').textContent, /Günün Görünümü/);
  assert.equal(failure.document.body.getAttribute('aria-busy'), 'false');
  console.log('PASS: initial load failure has an accessible retry panel and refresh recovers');
} catch (error) { failed++; console.error('FAIL: load error recovery\n', error.message); }
finally { failure.close(); }
if (failed) { console.error(`${failed} UX checks failed.`); process.exitCode = 1; }
else console.log('PASS: 10 UX behavior checks; JSDOM verifies interactions and semantics, not rendered layout or contrast.');
