import * as supplierModule from '../public/suppliers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadJSDOM } from '../test-support/jsdom.mjs';
import { INITIAL_ACCOUNTS } from '../domain.mjs';
import { Repository } from '../repository.mjs';

const JSDOM = await loadJSDOM();
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
async function setup(t, custom = [], overrides = {}) {
  const repo = new Repository(':memory:', 'demo');
  const balances = Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, '0']));
  Object.assign(balances, { ceyrek: '3', gramToplam: '2.125', yuzuk: '2', taki14: '8' }, overrides);
  repo.execute({ id: 'opening', revision: 0, command: { type: 'opening', date: '2026-11-10', balances } });
  for (const [id, name] of custom) {
    repo.execute({ id, revision: repo.state().revision, command: { type: 'stockAccount', date: '2026-11-10', name, unit: 'ADET', opening: '1' } });
  }
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:4317/', runScripts: 'outside-only' });
  const { window } = dom, { document } = window;
  t.after(() => { window.close(); repo.close(); });
  Object.defineProperty(window.crypto, 'randomUUID', { value: randomUUID });
  const commands = [];
  window.fetch = async (url, options = {}) => {
    const path = new URL(url, window.location.href).pathname;
    if (path === '/api/state') return { ok: true, json: async () => repo.state() };
    if (path === '/api/command') {
      commands.push(JSON.parse(options.body));
      return { ok: true, json: async () => repo.execute(commands.at(-1)) };
    }
    throw new Error('Unexpected test route ' + path);
  };
  window.__supplierModule=supplierModule;window.eval(script.replace("import('./suppliers.js')","Promise.resolve(window.__supplierModule)"));
  await new Promise(resolve => setTimeout(resolve, 0));
  const get = selector => document.querySelector(selector);
  get('[data-view="transaction"]').click();
  const input = get('[data-product-search]');
  assert.ok(input, 'retail sale line must expose a keyboard product search');
  const write = (control, value) => {
    control.value = value;
    control.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  const key = (control, name) => control.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
  return { get, input, key, write, commands, document };
}

test('normalized Turkish category and exact stock code select through the existing sale line', async t => {
  const { get, input, write, key, commands, document } = await setup(t);
  write(input, 'yuzuk');
  const ring = get('[data-product-result="yuzuk"]');
  assert.match(ring.textContent, /YÜZÜK/);
  assert.match(ring.textContent, /2 adet/);
  assert.equal(key(input, 'Enter'), false);
  assert.equal(get('[data-item-field="accountId"]').value, 'yuzuk');
  assert.equal(document.activeElement, get('[data-item-field="quantity"]'));
  write(input, 'GrAmToPlAm');
  assert.match(get('[data-product-result="gramToplam"]').textContent, /2,125 gr/);
  key(input, 'Enter');
  assert.equal(get('[data-item-field="accountId"]').value, 'gramToplam');
  assert.equal(get('[data-item-field="weight"]').disabled, true);
  assert.equal(commands.length, 0);
});

test('unavailable, retired and missing products cannot be selected or submit the old line', async t => {
  const { get, input, write, key, commands } = await setup(t);
  const previous = get('[data-item-field="accountId"]').value;
  for (const query of ['saat', 'gramAdet', 'bulunmaz']) {
    write(input, query);
    if (query === 'saat') assert.equal(get('[data-product-result="saat"]').disabled, true);
    else assert.equal(get('[data-product-result]'), null);
    assert.equal(key(input, 'Enter'), false);
    assert.equal(get('[data-item-field="accountId"]').value, previous);
    assert.equal(input.checkValidity(), false);
  }
  key(input, 'Escape');
  assert.equal(input.value, '');
  assert.equal(input.checkValidity(), true);
  assert.equal(commands.length, 0);
});

test('search preserves draft values, supports multiple rows, and stays scoped to retail sales', async t => {
  const { get, input, write, key, document } = await setup(t);
  write(input, 'ceyrek');
  key(input, 'Enter');
  write(get('[data-item-field="value"]'), '2000');
  get('#add-sale-item').click();
  const second = document.querySelectorAll('[data-product-search]')[1];
  write(second, 'yuzuk');
  key(second, 'ArrowDown');
  assert.equal(document.activeElement.dataset.productResult, 'yuzuk');
  document.activeElement.click();
  get('[data-tab="purchase"]').click();
  assert.equal(get('[data-product-search]'), null);
  get('[data-tab="sale"]').click();
  assert.deepEqual([...document.querySelectorAll('[data-item-field="accountId"]')].map(s => s.value), ['ceyrek','yuzuk']);
  assert.equal(get('[data-item-field="value"]').value, '2000');
  get('[data-view="suppliers"]').click();
  await new Promise(resolve=>setTimeout(resolve,0)); assert.ok(get('[data-create-firm]'));
  assert.equal(get('[data-product-search]'), null);
});

test('disabled exact code cannot fall through to a different available product', async t => {
  const { get, input, write, key } = await setup(t, [['watch-band', 'SAAT KAYIŞI']]);
  const product = get('[data-item-field="accountId"]'), previous = product.value;
  write(input, 'saat');
  key(input, 'Enter');
  assert.equal(product.value, previous);
  assert.equal(input.value, 'saat');
});

test('literal code takes precedence over normalized collisions and capped prefix matches', async t => {
  const accounts = Array.from({length: 16}, (_, i) => ['abc-' + i, 'Diğer ürün ' + i]);
  accounts.push(['ABC', 'Kod bir'], ['abc', 'Kod iki']);
  const { get, input, write, key, document } = await setup(t, accounts);
  write(input, 'stock-abc');
  const displayed = [...document.querySelectorAll('[data-product-result]')];
  assert.ok(displayed.length <= 12);
  assert.equal(displayed[0].dataset.productResult, 'stock-abc');
  key(input, 'Enter');
  assert.equal(get('[data-item-field="accountId"]').value, 'stock-abc');
});

test('linked assay-group search shows matching eligible product categories', async t => {
  const { get, input, write, key } = await setup(t, [], {taki14: '0', taki22: '8'});
  write(input, '14 ayar taki');
  assert.match(get('[data-product-result="yuzuk"]').textContent, /2 adet/);
  assert.equal(get('[data-product-result="ceyrek"]'), null);
  assert.equal(get('[data-product-result="yuzuk"]').disabled, true);
  write(input, '22 ayar taki');
  const result = get('[data-product-result="yuzuk"]');
  assert.match(result.textContent, /22 AYAR TAKI.*8,000 gr/);
  result.click();
  assert.equal(get('[data-item-field="weightAccount"]').value, 'taki22');
});

test('employee checkout shows unreserved stock and caps search without hiding an exact barcode', async t => {
  const { checkoutState } = await import('../editor-access.mjs');
  const account = { id:'yuzuk', name:'Yüzük', unit:'ADET', isSaleable:true, pairedGroups:['taki14'] };
  const pieces = Array.from({length:25}, (_, index) => ({
    accountId:'yuzuk', weightAccount:'taki14', actualWeight:1000, code:'Y-' + index,
    barcode:'TR-' + index, status:'available', description:'İşçilikli'
  }));
  const state = checkoutState({
    initialized:true, date:'2026-11-10', revision:4, inventoryItems:pieces,
    inventoryReserved:{yuzuk:25, taki14:25000}, balances:{yuzuk:26,taki14:25001},
    accounts:[account,{id:'taki14',name:'14 ayar',unit:'GRAM'}]
  });
  const dom = new JSDOM(readFileSync(new URL('../public/checkout.html', import.meta.url),'utf8'),
    {url:'http://127.0.0.1:4317/',runScripts:'outside-only'});
  t.after(() => dom.window.close());
  const {window} = dom, get = selector => window.document.querySelector(selector);
  window.DefterSession = {current:()=>({actor:{id:'employee'}}),api:async()=>state};
  window.eval(readFileSync(new URL('../public/checkout.js', import.meta.url),'utf8'));
  await new Promise(resolve=>setTimeout(resolve,0));
  const find = value => {get('[data-product-search]').value=value; get('[data-product-search]').dispatchEvent(new window.Event('input'));};
  find('yuzuk');
  assert.equal(get('[data-product]').options.length,12);
  assert.match(get('[data-available]').textContent,/1 adet/);
  assert.match(get('[data-pool]').selectedOptions[0].textContent,/0,001 gr/);
  find('TR-24');
  assert.equal(get('[data-product]').selectedOptions[0].dataset.code,'Y-24');
  assert.equal(get('[data-weight]').value,'1.000');
});
