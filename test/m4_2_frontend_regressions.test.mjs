import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadJSDOM } from '../test-support/jsdom.mjs';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS, quantity, workdaySummary } from '../domain.mjs';
import { checkoutState, customerChoices, customerDetail } from '../editor-access.mjs';
import { projectSupplierDetail, projectSupplierParties } from '../supplier-view.mjs';
import * as suppliersModule from '../public/suppliers.js';

const JSDOM = await loadJSDOM();

const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const checkoutHtml = readFileSync(new URL('../public/checkout.html', import.meta.url), 'utf8');
const reportsHtml = readFileSync(new URL('../public/reports.html', import.meta.url), 'utf8');
const searchNormSource = readFileSync(new URL('../public/search-norm.js', import.meta.url), 'utf8');
const comboboxSource = readFileSync(new URL('../public/combobox.js', import.meta.url), 'utf8');
const commandPaletteSource = readFileSync(new URL('../public/command-palette.js', import.meta.url), 'utf8');
const draftStoreSource = readFileSync(new URL('../public/draft-store.js', import.meta.url), 'utf8');
const uiKitSource = readFileSync(new URL('../public/ui-kit.js', import.meta.url), 'utf8');
const accessClientSource = readFileSync(new URL('../public/access-client.js', import.meta.url), 'utf8');
const amountCodecSource = readFileSync(new URL('../public/amount-codec.js', import.meta.url), 'utf8');
const dateFormatSource = readFileSync(new URL('../public/date-format.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const checkoutSource = readFileSync(new URL('../public/checkout.js', import.meta.url), 'utf8');
const reportsSource = readFileSync(new URL('../public/reports.js', import.meta.url), 'utf8');

const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));

function saveGlobals() {
  const keys = [
    'window', 'document', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PopStateEvent',
    'HTMLInputElement', 'HTMLSelectElement', 'HTMLElement', 'Node',
    'DefterAmountCodec', 'DefterDateFormat', 'DefterUI', 'DefterDraftStore',
    'DefterSearchNorm', 'DefterCombobox', 'DefterCommandPalette'
  ];
  const saved = {};
  for (const k of keys) saved[k] = globalThis[k];
  return () => {
    for (const k of keys) {
      if (saved[k] === undefined) delete globalThis[k];
      else globalThis[k] = saved[k];
    }
  };
}

function seedRepo(workspace = 'demo', { withSale = false, uninitialized = false, stockCount = 0 } = {}) {
  const repo = new Repository(':memory:', workspace);
  if (uninitialized) return repo;

  repo.execute({
    id: randomUUID(),
    revision: 0,
    command: {
      type: 'opening',
      date: '2026-11-10',
      balances: Object.fromEntries(
        INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [
          a.id,
          a.id === 'nakit' ? '100000'
            : a.id === 'usd' ? '100'
            : a.id === 'ceyrek' ? '10'
            : a.id === 'gramToplam' ? '20'
            : a.id === 'bilezik22' ? '100'
            : a.id === 'bilezikAdet' ? '5'
            : a.id === 'taki14' ? '50'
            : a.id === 'yuzuk' ? '10'
            : '0'
        ])
      )
    }
  });

  repo.execute({
    id: randomUUID(),
    revision: repo.state().revision,
    command: {
      type: 'account',
      date: '2026-11-10',
      name: 'İSMAİL ŞAHİN',
      unit: 'TL',
      opening: '1500',
      partyType: 'customer',
      phone: '05551112233'
    }
  });

  repo.execute({
    id: randomUUID(),
    revision: repo.state().revision,
    command: {
      type: 'account',
      date: '2026-11-10',
      name: 'HAS CARİ MÜŞTERİ',
      unit: 'HAS',
      opening: '10',
      partyType: 'customer',
      phone: '05559998877'
    }
  });

  const firmEnv = repo.execute({
    id: randomUUID(),
    revision: repo.state().revision,
    command: {
      type: 'supplierFirm',
      date: '2026-11-10',
      name: 'Çiğdem Toptan'
    }
  });
  const firmId = firmEnv.state.supplierFirms.find(f => f.name === 'Çiğdem Toptan').id;
  repo.execute({
    id: randomUUID(),
    revision: repo.state().revision,
    command: {
      type: 'supplierUnit',
      date: '2026-11-10',
      supplierId: firmId,
      unit: 'HAS'
    }
  });

  for (let i = 1; i <= stockCount; i++) {
    repo.execute({
      id: randomUUID(),
      revision: repo.state().revision,
      command: {
        type: 'stockAccount',
        date: '2026-11-10',
        name: `Katalog Ürün ${String(i).padStart(3, '0')}`,
        unit: 'ADET',
        pairedGroups: ['taki14'],
        opening: '0'
      }
    });
  }

  if (withSale) {
    const cust = repo.state().accounts.find(a => a.name === 'İSMAİL ŞAHİN');
    repo.execute({
      id: randomUUID(),
      revision: repo.state().revision,
      command: {
        type: 'sale',
        date: '2026-11-10',
        counterpartyId: cust.id,
        items: [{ accountId: 'yuzuk', quantity: '2', weightAccount: 'taki14', weight: '10.000', value: '20000' }],
        received: [{ accountId: 'nakit', quantity: '20000', valueTL: '20000' }],
        given: [],
        credits: [],
        debts: []
      }
    });
  }

  return repo;
}

async function createOwnerApp(t, {
  url = 'http://127.0.0.1:4317/#v=transaction',
  reposOverride = null,
  seededStorage = null,
  compact = false,
  withSale = false,
  uninitialized = false,
  stockCount = 0,
  summaryOverride = null,
  stateMutator = null,
  fetchInterceptor = null,
  onFinishRestore = null
} = {}) {
  const restoreGlobals = saveGlobals();
  const ownerActor = { id: '00000000-0000-4000-8000-000000000001', name: 'Patron', role: 'owner' };
  const repos = reposOverride || {
    demo: seedRepo('demo', { withSale, uninitialized, stockCount }),
    dukkan: seedRepo('dukkan')
  };
  const dom = new JSDOM(indexHtml, { url, runScripts: 'outside-only' });
  const { window } = dom;
  const { document } = window;
  window.localStorage.setItem('defter-workspace', 'demo');
  Object.defineProperty(window.crypto, 'randomUUID', { value: randomUUID });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.confirm = () => true;

  if (seededStorage) {
    for (const [k, v] of Object.entries(seededStorage)) {
      window.sessionStorage.setItem(k, v);
    }
  }
  window.sessionStorage.setItem('defter-session', JSON.stringify({
    actor: ownerActor,
    token: 'tok-owner',
    expiresAt: Date.now() + 3600_000
  }));

  const commands = [];
  window.DefterSession = {
    current: () => JSON.parse(window.sessionStorage.getItem('defter-session') || 'null'),
    clear: () => window.sessionStorage.removeItem('defter-session'),
    lock: () => {},
    finishRestore: () => { onFinishRestore?.(); },
    api: async () => ({})
  };

  window.fetch = async (reqUrl, init = {}) => {
    const parsed = new URL(String(reqUrl), 'http://127.0.0.1:4317');
    if (fetchInterceptor) {
      const intercepted = await fetchInterceptor(parsed, init, repos);
      if (intercepted) return intercepted;
    }
    const ws = parsed.searchParams.get('workspace') || 'demo';
    const repo = repos[ws];

    if (parsed.pathname === '/api/state') {
      let st = repo.state({ compact });
      if (stateMutator) st = stateMutator(st);
      return { ok: true, status: 200, json: async () => st };
    }
    if (parsed.pathname === '/api/journal') {
      return {
        ok: true,
        status: 200,
        json: async () => repo.journalPage({
          ...Object.fromEntries(parsed.searchParams),
          limit: Number(parsed.searchParams.get('limit') || 50)
        })
      };
    }
    if (parsed.pathname === '/api/summary') {
      if (summaryOverride) return { ok: true, status: 200, json: async () => summaryOverride(repo.state(), parsed) };
      const st = repo.state();
      return { ok: true, status: 200, json: async () => workdaySummary(st, parsed.searchParams.get('date') || st.date) };
    }
    if (parsed.pathname === '/api/suppliers') {
      const st = repo.state();
      const supplierId = parsed.searchParams.get('supplierId');
      if (supplierId) {
        return {
          ok: true,
          status: 200,
          json: async () => projectSupplierDetail(st, {
            supplierId,
            limit: Number(parsed.searchParams.get('limit') || 50),
            startDate: parsed.searchParams.get('startDate') || '',
            endDate: parsed.searchParams.get('endDate') || ''
          })
        };
      }
      const firms = projectSupplierParties(st);
      return {
        ok: true,
        status: 200,
        json: async () => ({ firms, units: st.accounts.filter(a => a.partyType === 'supplier') })
      };
    }
    if (parsed.pathname === '/api/command') {
      const env = JSON.parse(init.body || '{}');
      commands.push(env);
      try {
        const res = repo.execute(env, { version: 1, actor: ownerActor });
        if (parsed.searchParams.get('view') === 'compact') {
          return { ok: true, status: 200, json: async () => ({ ...res, state: repo.state({ compact: true }) }) };
        }
        return { ok: true, status: 200, json: async () => res };
      } catch (err) {
        return { ok: false, status: err.status || 400, json: async () => ({ error: err.message }) };
      }
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  window.__testSuppliersModule = suppliersModule;
  for (const key of ['Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PopStateEvent', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLElement', 'Node']) {
    globalThis[key] = window[key];
  }
  globalThis.window = window;
  globalThis.document = document;

  window.eval(searchNormSource);
  window.eval(draftStoreSource);
  window.eval(uiKitSource);
  window.eval(amountCodecSource);
  window.eval(dateFormatSource);
  window.eval(comboboxSource);
  window.eval(commandPaletteSource);
  for (const key of ['DefterAmountCodec', 'DefterDateFormat', 'DefterUI', 'DefterDraftStore', 'DefterSearchNorm', 'DefterCombobox', 'DefterCommandPalette']) {
    globalThis[key] = window[key];
  }
  window.eval(appSource.replace("import('./suppliers.js')", 'Promise.resolve(window.__testSuppliersModule)'));
  await tick(70);

  t.after(() => {
    delete window.__testSuppliersModule;
    window.close();
    if (!reposOverride) {
      repos.demo.close();
      repos.dukkan.close();
    }
    restoreGlobals();
  });

  return { dom, window, document, repos, commands };
}

async function createEmployeeCheckout(t, { repoOverride = null, withCodec = true } = {}) {
  const restoreGlobals = saveGlobals();
  const empActor = { id: '00000000-0000-4000-8000-000000000002', name: 'Tezgâh Çalışanı', role: 'employee' };
  const repo = repoOverride || seedRepo('demo');
  const dom = new JSDOM(checkoutHtml, { url: 'http://127.0.0.1:4317/checkout', runScripts: 'outside-only' });
  const { window } = dom;
  const { document } = window;
  if (document.getElementById('workspace')) document.getElementById('workspace').value = 'demo';
  Object.defineProperty(window.crypto, 'randomUUID', { value: randomUUID });
  window.HTMLElement.prototype.scrollIntoView = () => {};

  window.sessionStorage.setItem('defter-session', JSON.stringify({
    actor: empActor,
    token: 'tok-emp',
    expiresAt: Date.now() + 3600_000
  }));

  const commands = [];
  window.DefterSession = {
    current: () => JSON.parse(window.sessionStorage.getItem('defter-session') || 'null'),
    clear: () => window.sessionStorage.removeItem('defter-session'),
    lock: () => {},
    api: async () => ({})
  };

  window.fetch = async (reqUrl, init = {}) => {
    const parsed = new URL(String(reqUrl), 'http://127.0.0.1:4317');
    if (parsed.pathname === '/api/auth/session') {
      return { ok: true, status: 200, json: async () => empActor };
    }
    if (parsed.pathname === '/api/checkout') {
      return { ok: true, status: 200, json: async () => checkoutState(repo.state({ compact: true })) };
    }
    if (parsed.pathname === '/api/customers') {
      const st = repo.state({ compact: true });
      const id = parsed.searchParams.get('id');
      if (id) {
        const detail = customerDetail(st, id);
        return detail ? { ok: true, status: 200, json: async () => detail } : { ok: false, status: 404, json: async () => ({ error: 'Bulunamadı' }) };
      }
      const q = parsed.searchParams.get('q') || '';
      const limit = Number(parsed.searchParams.get('limit') || 20);
      const meta = parsed.searchParams.get('meta') === '1';
      return { ok: true, status: 200, json: async () => customerChoices(st, q, { limit, meta }) };
    }
    if (parsed.pathname === '/api/pending-approvals') {
      if ((init.method || 'GET').toUpperCase() === 'GET') {
        return { ok: true, status: 200, json: async () => ({ items: repo.listPending({ status: 'all', submittedById: empActor.id }) }) };
      }
      const env = JSON.parse(init.body || '{}');
      commands.push(env);
      try {
        const res = repo.submitPending(env, { actor: empActor });
        return { ok: true, status: 201, json: async () => res };
      } catch (err) {
        return { ok: false, status: err.status || 400, json: async () => ({ error: err.message }) };
      }
    }
    if (parsed.pathname === '/api/command') {
      const env = JSON.parse(init.body || '{}');
      commands.push(env);
      try {
        const res = repo.execute(env, { version: 1, actor: empActor });
        return { ok: true, status: 200, json: async () => res };
      } catch (err) {
        return { ok: false, status: err.status || 400, json: async () => ({ error: err.message }) };
      }
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  for (const key of ['Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PopStateEvent', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLElement', 'Node']) {
    globalThis[key] = window[key];
  }
  globalThis.window = window;
  globalThis.document = document;

  window.eval(searchNormSource);
  window.eval(draftStoreSource);
  window.eval(uiKitSource);
  window.eval(accessClientSource);
  if (withCodec) window.eval(amountCodecSource);
  window.eval(dateFormatSource);
  window.eval(comboboxSource);
  window.eval(commandPaletteSource);
  for (const key of ['DefterAmountCodec', 'DefterDateFormat', 'DefterUI', 'DefterDraftStore', 'DefterSearchNorm', 'DefterCombobox', 'DefterCommandPalette']) {
    if (!withCodec && key === 'DefterAmountCodec') {
      delete globalThis.DefterAmountCodec;
      continue;
    }
    globalThis[key] = window[key];
  }
  window.eval(checkoutSource);
  await tick(70);

  t.after(() => {
    window.close();
    if (!repoOverride) repo.close();
    restoreGlobals();
  });

  return { dom, window, document, repo, commands };
}

function setFieldValue(window, el, value, eventType = 'input') {
  el.value = value;
  el.dispatchEvent(new window.Event(eventType, { bubbles: true }));
}

function clickDecimalDisambig(el) {
  const container = el.closest('label, .field, td, div') || el.parentElement;
  const btn = container?.querySelector('[data-amount-choice="decimal"]');
  assert.ok(btn, `Expected decimal disambiguation button for ${el.name || el.id || el.dataset?.priceField}`);
  btn.click();
}

test('M2-F01 & M2-F06: Combobox focus({ open: false }), prebound cari allocation focus, and quick customer drawer return', async t => {
  const app = await createOwnerApp(t, { url: 'http://127.0.0.1:4317/#v=transaction&tab=sale' });
  const { window, document } = app;

  const partySelect = document.querySelector('#f-counterpartyId');
  const partyCb = window.DefterCombobox.getInstance(partySelect);
  assert.ok(partyCb);

  // focus({ open: false }) keeps panel closed even though openOnFocus is true
  partyCb.focus({ open: false });
  assert.equal(document.activeElement, partyCb.input);
  assert.equal(partyCb.panel.hidden, true);
  assert.equal(partyCb.input.getAttribute('aria-expanded'), 'false');

  // selectEl.focus({ open: false }) forwards { open: false }
  partySelect.focus({ open: false });
  assert.equal(partyCb.panel.hidden, true);

  // Select customer, then add debt & counterdebt allocations -> focuses quantity input and keeps panel closed
  const cust = app.repos.demo.state().accounts.find(a => a.name === 'İSMAİL ŞAHİN');
  partyCb.setValue(cust.id, { emitChange: true });

  document.querySelector('[data-add-allocation="debt"]').click();
  const debtRow = document.querySelector('#debt-lines .allocation-row');
  const debtSelect = debtRow.querySelector('select');
  const debtCb = window.DefterCombobox.getInstance(debtSelect);
  const debtQty = debtRow.querySelector('[data-allocation-field="quantity"]');
  assert.equal(debtSelect.value, cust.id);
  assert.equal(document.activeElement, debtQty, 'Prebound cari allocation must focus quantity input directly');
  assert.equal(debtCb.panel.hidden, true);
  assert.equal(debtCb.input.getAttribute('aria-expanded'), 'false');

  // Adding non-cari payment focuses combobox without opening panel when >50 or keeps panel closed
  document.querySelector('[data-add-allocation="counterdebt"]').click();
  const cdebtRow = document.querySelector('#counterdebt-lines .allocation-row');
  const cdebtCb = window.DefterCombobox.getInstance(cdebtRow.querySelector('select'));
  assert.equal(cdebtCb.panel.hidden, true);

  // M2-F06: Quick customer drawer creation returns focus to #f-counterpartyId with panel closed
  document.querySelector('[data-create-party]').click();
  await tick(20);
  const drawerForm = document.querySelector('dialog.defter-drawer form');
  assert.ok(drawerForm, 'Quick party drawer form should mount');
  drawerForm.elements.name.value = 'Yeni Çekmece Müşterisi';
  drawerForm.elements.unit.value = 'TL';
  drawerForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(70);

  const afterPartySelect = document.querySelector('#f-counterpartyId');
  const afterPartyCb = window.DefterCombobox.getInstance(afterPartySelect);
  assert.ok(afterPartySelect.value.startsWith('cari-'), 'Newly created customer should be selected');
  assert.equal(document.activeElement, afterPartyCb.input);
  assert.equal(afterPartyCb.panel.hidden, true, 'Drawer return must NOT pop open combobox over action buttons');
  assert.equal(afterPartyCb.input.getAttribute('aria-expanded'), 'false');

  // Checkout M2-F01 parity: prebound customer credit allocation focuses quantity input
  const emp = await createEmployeeCheckout(t);
  const empCust = emp.repo.state().accounts.find(a => a.name === 'İSMAİL ŞAHİN');
  const empCustCb = emp.window.DefterCombobox.getInstance(emp.document.querySelector('#search'));
  empCustCb.setValue(empCust.id, {
    emitChange: true,
    item: { id: empCust.id, label: empCust.name, unit: 'TL' }
  });
  await tick(50);
  emp.document.querySelector('[data-add="credits"]').click();
  const creditRow = emp.document.querySelector('#credits [data-allocation]');
  assert.equal(emp.document.activeElement, creditRow.querySelector('[data-quantity]'));
  assert.equal(creditRow._accountCombobox.panel.hidden, true);
});

test('M2-F02 & M2-F14: /checkout blocks invalid or unblurred #search text on #trade submit, allows cash sale when cleared, and sets accessible names on guided allocations', async t => {
  const emp = await createEmployeeCheckout(t);
  const { window, document } = emp;

  const firstItem = document.querySelector('#items [data-item]');
  setFieldValue(window, firstItem.querySelector('[data-quantity]'), '1');
  setFieldValue(window, firstItem.querySelector('[data-value]'), '1000');

  document.querySelector('[data-add="received"][data-category="money"]').click();
  const payRow = document.querySelector('#received [data-allocation]');
  payRow._accountCombobox.setValue('nakit', { emitChange: true });
  setFieldValue(window, payRow.querySelector('[data-quantity]'), '1000');

  // M2-F14: check accessible names on guided allocation comboboxes
  document.querySelector('[data-add="received"][data-category="product"]').click();
  document.querySelector('[data-add="received"][data-category="scrap"]').click();
  document.querySelector('[data-add="given"][data-category="money"]').click();
  const expectedLabels = ['Para hesabı', 'Ürün', 'Hurda hesabı', 'Para hesabı'];
  const allocInputs = [...document.querySelectorAll('[data-allocation] .defter-combobox-input')];
  assert.equal(allocInputs.length, 4);
  allocInputs.forEach((inp, idx) => {
    assert.equal(inp.getAttribute('aria-label'), expectedLabels[idx]);
  });
  // Clean up extra 3 allocation rows so totals balance
  for (const row of [...document.querySelectorAll('[data-allocation]')].slice(1)) {
    row.querySelector('[data-remove]').click();
  }

  // Also check TEXT_NODE fallback in combobox.js enhanceSelect
  const probeLabel = document.createElement('label');
  probeLabel.textContent = 'Serbest Metin Etiketi';
  const probeSelect = document.createElement('select');
  probeSelect.innerHTML = '<option value="a">A</option>';
  probeLabel.append(probeSelect);
  document.body.append(probeLabel);
  const probeCb = window.DefterCombobox.enhanceSelect(probeSelect);
  assert.equal(probeCb.input.getAttribute('aria-label'), 'Serbest Metin Etiketi');
  probeCb.destroy();
  probeLabel.remove();

  // M2-F02 (a): blurred invalid #search text blocks submit
  const search = document.querySelector('#search');
  setFieldValue(window, search, 'OlmayanMusteri999', 'input');
  search.dispatchEvent(new window.Event('blur'));
  assert.equal(search.getAttribute('aria-invalid'), 'true');
  document.querySelector('#trade').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(document.querySelector('#review').hidden, true);
  assert.match(document.querySelector('#status').textContent, /Müşteri aramasında/i);
  assert.equal(document.activeElement, search);

  // M2-F02 (b): unblurred uncommitted text ALSO blocks submit
  setFieldValue(window, search, 'UnblurredText', 'input');
  document.querySelector('#trade').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(document.querySelector('#review').hidden, true);
  assert.equal(search.getAttribute('aria-invalid'), 'true');
  assert.equal(document.activeElement, search);

  // M2-F02 (c): cleared #search allows valid cash sale to proceed to #review
  setFieldValue(window, search, '', 'input');
  document.querySelector('#trade').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(document.querySelector('#review').hidden, false);
});

test('M2-F07: /checkout parseReadOnlyAmount and renderReview honor 10.500 disambiguation and clear metadata on trusted input', async t => {
  const emp = await createEmployeeCheckout(t);
  const { window, document, commands } = emp;

  const cust = emp.repo.state().accounts.find(a => a.name === 'HAS CARİ MÜŞTERİ');
  const custCb = window.DefterCombobox.getInstance(document.querySelector('#search'));
  custCb.setValue(cust.id, { emitChange: true, item: { id: cust.id, label: cust.name, unit: 'HAS' } });
  await tick(50);

  const itemRow = document.querySelector('#items [data-item]');
  itemRow._productCombobox.setValue('gramToplam', { emitChange: true });
  const qtyEl = itemRow.querySelector('[data-quantity]');
  setFieldValue(window, qtyEl, '10.500');
  setFieldValue(window, itemRow.querySelector('[data-value]'), '25000');

  document.querySelector('[data-add="credits"]').click();
  const creditRow = document.querySelector('#credits [data-allocation]');
  const creditQtyEl = creditRow.querySelector('[data-quantity]');
  setFieldValue(window, creditQtyEl, '10.500');
  setFieldValue(window, creditRow.querySelector('[data-value]'), '25000');

  // Submitting triggers validation & spawns disambiguation choices on both 10.500 fields
  document.querySelector('#trade').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  clickDecimalDisambig(qtyEl);
  clickDecimalDisambig(creditQtyEl);

  // Live summary should show formatted 10,500 gr / has gr (NOT Eksik)
  const summaryLinesText = document.querySelector('#summary-lines').textContent;
  assert.doesNotMatch(summaryLinesText, /Eksik/);
  assert.match(summaryLinesText, /10,500 gr/);
  assert.match(summaryLinesText, /10,500 has gr/);
  assert.doesNotMatch(document.querySelector('#summary-customer').textContent, /Eksik/);
  assert.match(document.querySelector('#summary-customer').textContent, /20,500 has gr/);

  // Review should display '10,500 gr' instead of raw '10.500 GRAM'
  document.querySelector('#trade').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(document.querySelector('#review').hidden, false);
  assert.match(document.querySelector('#review-content').textContent, /10,500 gr/);
  assert.doesNotMatch(document.querySelector('#review-content').textContent, /10\.500 GRAM/);

  // Confirm executes command with canonical '10.500'
  document.querySelector('#confirm').click();
  await tick(70);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].command.items[0].quantity, '10.500');
  assert.equal(commands[0].command.credits[0].quantity, '10.500');

  // Trusted user edit clears dataset.amountResolution, canonicalAmount, and formattedPreview
  const editDom = new JSDOM('<!doctype html><html><body><label class="field"><input id="x" type="text"></label></body></html>');
  const prevWin = globalThis.window;
  const prevDoc = globalThis.document;
  const prevInput = globalThis.HTMLInputElement;
  globalThis.window = editDom.window;
  globalThis.document = editDom.window.document;
  globalThis.HTMLInputElement = editDom.window.HTMLInputElement;
  try {
    editDom.window.eval(amountCodecSource);
    const inp = editDom.window.document.getElementById('x');
    inp.value = '10.500';
    inp.dataset.amountResolution = 'decimal';
    inp.dataset.canonicalAmount = '10.500';
    inp.dataset.formattedPreview = '10,500 gr';
    // Verify clearInputState & parseInputElement
    assert.equal(editDom.window.DefterAmountCodec.parseInputElement(inp, 'GRAM', true), 10500);
    // Simulate clearing resolution as trusted input does
    editDom.window.DefterAmountCodec.clearInputState(inp);
    assert.equal(inp.dataset.amountResolution, undefined);
    assert.equal(inp.dataset.canonicalAmount, undefined);
    assert.equal(inp.dataset.formattedPreview, undefined);
  } finally {
    editDom.window.close();
    globalThis.window = prevWin;
    globalThis.document = prevDoc;
    globalThis.HTMLInputElement = prevInput;
  }
});

test('M2-F03: Successful #retry after F5 clears matching draft (including purchase on #v=transaction) while keeping unrelated drafts', async t => {
  const actorId = '00000000-0000-4000-8000-000000000001';
  const repo = seedRepo('demo');
  const rev = repo.state().revision;
  const pendingId = randomUUID();

  const saleKey = `defter-draft:v1:${actorId}:demo:retail:sale`;
  const purchaseKey = `defter-draft:v1:${actorId}:demo:retail:purchase`;
  const pendingKey = `defter-draft:v1:${actorId}:demo:retail:pending`;

  const seededStorage = {
    [saleKey]: JSON.stringify({
      version: 1,
      key: saleKey,
      meta: { actorId, workspace: 'demo', workday: '2026-11-10', revision: rev, formId: 'sale-form' },
      data: { fields: { note: 'Satış taslağı' }, sale: { items: [{ accountId: 'ceyrek', quantity: '1', value: '5000' }] } }
    }),
    [purchaseKey]: JSON.stringify({
      version: 1,
      key: purchaseKey,
      meta: { actorId, workspace: 'demo', workday: '2026-11-10', revision: rev, formId: 'sale-form' },
      data: { fields: { note: 'Alış taslağı' }, sale: { items: [{ accountId: 'ceyrek', quantity: '2', value: '8000' }] } }
    }),
    [pendingKey]: JSON.stringify({
      version: 1,
      key: pendingKey,
      id: pendingId,
      revision: rev,
      command: {
        type: 'purchase',
        date: '2026-11-10',
        source: 'customer',
        counterpartyType: 'customer',
        counterpartyId: '',
        items: [{ accountId: 'ceyrek', quantity: '2', value: '8000' }],
        received: [],
        given: [{ accountId: 'nakit', quantity: '8000', valueTL: '8000' }],
        credits: [],
        debts: []
      }
    })
  };

  let failFirstCommand = true;
  const app = await createOwnerApp(t, {
    url: 'http://127.0.0.1:4317/#v=transaction',
    reposOverride: { demo: repo, dukkan: seedRepo('dukkan') },
    seededStorage,
    fetchInterceptor: async parsed => {
      if (parsed.pathname === '/api/command' && failFirstCommand) {
        failFirstCommand = false;
        throw new Error('Failed to fetch');
      }
      return null;
    }
  });
  t.after(() => repo.close());

  // On boot, lookupOnly failed so #retry-bar is visible and #sale-form is on 'sale' tab
  assert.equal(app.document.querySelector('#retry-bar').hidden, false);
  assert.equal(app.document.querySelector('#sale-form').dataset.operation, 'sale');

  // First #retry hits simulated network drop -> #retry-bar stays visible and both drafts remain
  app.document.querySelector('#retry').click();
  await tick(80);
  assert.equal(app.document.querySelector('#retry-bar').hidden, false);
  assert.notEqual(app.window.sessionStorage.getItem(purchaseKey), null);

  // Second #retry -> 200 OK -> purchase draft cleared, sale draft preserved!
  app.document.querySelector('#retry').click();
  await tick(80);
  assert.equal(app.document.querySelector('#retry-bar').hidden, true);
  assert.equal(app.window.sessionStorage.getItem(purchaseKey), null, 'Purchase draft must be cleared on #retry success');
  assert.notEqual(app.window.sessionStorage.getItem(saleKey), null, 'Unrelated sale draft must NOT be cleared');
});

test('M2-F04: handleBrowserNavigation guards busy state and bindRestoreForm calls finishRestore even if form unmounts', async t => {
  let restoreFinishCount = 0;
  let resolveRestore;
  const restorePromise = new Promise(r => { resolveRestore = r; });

  const app = await createOwnerApp(t, {
    url: 'http://127.0.0.1:4317/#v=backup',
    onFinishRestore: () => { restoreFinishCount++; },
    fetchInterceptor: async parsed => {
      if (parsed.pathname === '/api/restore') {
        await restorePromise;
        return { ok: true, status: 200, json: async () => ({ state: app.repos.demo.state(), reauthenticate: true }) };
      }
      return null;
    }
  });
  const { window, document } = app;

  const restoreForm = document.querySelector('#restore-form');
  const fileInput = document.querySelector('#f-backupFile');
  const backupObj = app.repos.demo.backup();
  const fakeFile = new window.File([JSON.stringify(backupObj)], 'backup.json', { type: 'application/json' });
  Object.defineProperty(fakeFile, 'text', { value: async () => JSON.stringify(backupObj), configurable: true });
  Object.defineProperty(fileInput, 'files', { value: [fakeFile], configurable: true });
  document.querySelector('#f-confirmation').value = 'GERİ YÜKLE';

  restoreForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(20);
  assert.equal(document.body.getAttribute('aria-busy'), 'true');

  // Mid-restore popstate while busy === true must be blocked
  window.location.hash = '#v=overview';
  window.dispatchEvent(new window.PopStateEvent('popstate'));
  assert.ok(restoreForm.isConnected, '#restore-form must stay connected while busy');
  assert.equal(window.location.hash, '#v=backup');

  // Even if form is detached before /api/restore resolves with reauthenticate: true, finishRestore() must run
  restoreForm.remove();
  resolveRestore();
  await tick(50);
  assert.equal(restoreFinishCount, 1);
});

test('M2-F10 & M2-F15: Dirty draft toast fires on sidebar & Command Palette nav; Back closes Command Palette without navigating underlying view', async t => {
  const app = await createOwnerApp(t, { url: 'http://127.0.0.1:4317/#v=overview' });
  const { window, document } = app;

  // Boot should not emit dirty-draft info toast
  assert.equal(document.querySelectorAll('.defter-toast--info').length, 0);

  // Navigate overview -> accounts -> transaction
  document.querySelector('#navigation [data-view="accounts"]').click();
  await tick(20);
  assert.equal(window.location.hash, '#v=accounts');
  document.querySelector('#navigation [data-view="transaction"]').click();
  await tick(20);

  // Dirty the sale form, then navigate via sidebar -> .defter-toast--info fires
  const noteEl = document.querySelector('#sale-form #f-note');
  setFieldValue(window, noteEl, 'Taslak notu');
  document.querySelector('#navigation [data-view="accounts"]').click();
  await tick(20);
  const sidebarToast = document.querySelector('.defter-toast--info');
  assert.ok(sidebarToast, 'Sidebar navigation from dirty form must emit info toast');
  assert.match(sidebarToast.textContent, /taslak geçici olarak saklandı/i);

  // Navigate back to transaction, dirty again, open Command Palette & jump to overview -> info toast fires
  document.querySelector('#navigation [data-view="transaction"]').click();
  await tick(20);
  setFieldValue(window, document.querySelector('#sale-form #f-note'), 'Taslak notu 2');
  window.DefterCommandPalette.open();
  await tick(20);
  const navOverviewOpt = [...document.querySelectorAll('.defter-command-palette-option')].find(el => el.textContent.includes('Günün Görünümü'));
  navOverviewOpt.click();
  await tick(20);
  const cpToast = document.querySelector('.defter-toast--info');
  assert.ok(cpToast, 'Command Palette navigation from dirty form must emit info toast');

  // M2-F15: Navigate overview -> accounts, open Command Palette (sole overlay), simulate Back popstate
  document.querySelector('#navigation [data-view="accounts"]').click();
  await tick(20);
  assert.equal(window.location.hash, '#v=accounts');
  window.DefterCommandPalette.open();
  assert.equal(window.DefterCommandPalette.isOpen(), true);
  assert.equal(window.DefterUI.getLayerCount(), 1);

  window.location.hash = '#v=overview';
  window.dispatchEvent(new window.PopStateEvent('popstate'));
  await tick(20);
  assert.equal(window.DefterCommandPalette.isOpen(), false, 'Back must close Command Palette');
  assert.equal(window.location.hash, '#v=accounts', 'Underlying view hash must remain #v=accounts');
  assert.ok(document.querySelector('#account-search'), 'Underlying accounts view must stay mounted');

  // Second Back (palette closed) navigates to overview
  window.location.hash = '#v=overview';
  window.dispatchEvent(new window.PopStateEvent('popstate'));
  await tick(20);
  assert.equal(window.location.hash, '#v=overview');
  assert.ok(document.querySelector('.overview-screen'));
});

test('M2-F11: STALE_WORKDAY stocktake banner honestly states values were not restored while STALE_REVISION restores for inspection', async t => {
  const actorId = '00000000-0000-4000-8000-000000000001';
  const repo = seedRepo('demo');
  const rev = repo.state().revision;
  const stocktakeKey = `defter-draft:v1:${actorId}:demo:retail:stocktake-form`;

  // Case 1: STALE_WORKDAY
  const app1 = await createOwnerApp(t, {
    url: 'http://127.0.0.1:4317/#v=closing',
    reposOverride: { demo: repo, dukkan: seedRepo('dukkan') },
    seededStorage: {
      [stocktakeKey]: JSON.stringify({
        version: 1,
        key: stocktakeKey,
        meta: { actorId, workspace: 'demo', workday: '2026-11-09', revision: rev, formId: 'stocktake-form' },
        data: { fields: { 'count-taki14': '50' } }
      })
    }
  });
  const periodicInput1 = app1.document.querySelector('#stocktake-form [name="count-taki14"]');
  assert.equal(periodicInput1.value, '', 'STALE_WORKDAY count input must stay blank');
  const staleAlert1 = app1.document.querySelector('#stocktake-form [data-draft-stale]');
  assert.match(staleAlert1.textContent, /geri yüklenmedi/i);
  assert.match(staleAlert1.textContent, /yeniden sayın/i);
  assert.equal(app1.document.querySelector('#stocktake-form [data-review-draft]'), null);
  assert.equal(app1.document.querySelector('#stocktake-form button[type="submit"]').disabled, true);

  // Case 2: STALE_REVISION (same workday, older revision)
  const app2 = await createOwnerApp(t, {
    url: 'http://127.0.0.1:4317/#v=closing',
    reposOverride: { demo: repo, dukkan: seedRepo('dukkan') },
    seededStorage: {
      [stocktakeKey]: JSON.stringify({
        version: 1,
        key: stocktakeKey,
        meta: { actorId, workspace: 'demo', workday: '2026-11-10', revision: Math.max(0, rev - 1), formId: 'stocktake-form' },
        data: { fields: { 'count-taki14': '49' } }
      })
    }
  });
  t.after(() => repo.close());
  const periodicInput2 = app2.document.querySelector('#stocktake-form [name="count-taki14"]');
  assert.equal(periodicInput2.value, '49', 'STALE_REVISION count input restores for inspection');
  assert.match(app2.document.querySelector('#stocktake-form [data-draft-stale]').textContent, /yalnız inceleme için korundu/i);
  assert.equal(app2.document.querySelector('#stocktake-form button[type="submit"]').disabled, true);
});

test('F-M3-005 & M2-F09 (Codec): amount-codec.js matches domain.mjs quantity() across 0.500, 1000.500, 1e12, leading zeros, and signed mode', () => {
  const restore = saveGlobals();
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  dom.window.eval(amountCodecSource);
  const codec = dom.window.DefterAmountCodec;

  try {
    // 0.500 / 00.500 / 000.000
    for (const u of ['TL', 'USD', 'ADET']) {
      for (const s of ['0.500', '00.500', '000.000', '1000.500']) {
        assert.equal(codec.parseUserAmount(s, u, { positive: true }).status, 'invalid', `${u} ${s}`);
        assert.throws(() => quantity(s, u));
      }
    }
    for (const u of ['GRAM', 'HAS', 'SILVER']) {
      const r05 = codec.parseUserAmount('0.500', u, { positive: true });
      assert.equal(r05.status, 'valid');
      assert.equal(r05.scaled, 500);
      assert.equal(r05.canonical, '0.500');
      assert.equal(quantity(r05.canonical, u), 500);

      const r1000 = codec.parseUserAmount('1000.500', u, { positive: true });
      assert.equal(r1000.status, 'valid');
      assert.equal(r1000.scaled, 1000500);
      assert.equal(quantity(r1000.canonical, u), 1000500);

      const rMax = codec.parseUserAmount('1000000000.000', u, { positive: true });
      assert.equal(rMax.status, 'valid');
      assert.equal(rMax.scaled, 1e12);
      assert.equal(quantity(rMax.canonical, u), 1e12);

      assert.equal(codec.parseUserAmount('1000000000.001', u, { positive: true }).status, 'invalid');
    }

    // Leading zeros up to 1e12
    const lz = codec.parseUserAmount('00000000000001', 'TL', { positive: true });
    assert.equal(lz.status, 'valid');
    assert.equal(lz.scaled, 100);
    assert.equal(lz.canonical, '1');
    assert.equal(quantity(lz.canonical, 'TL'), 100);

    // Signed mode
    const neg = codec.parseUserAmount('-10.000,50', 'TL', { signed: true });
    assert.equal(neg.status, 'valid');
    assert.equal(neg.scaled, -1000050);
    assert.equal(neg.canonical, '-10000.50');
    assert.equal(quantity(neg.canonical, 'TL', { signed: true }), -1000050);

    const negZero = codec.parseUserAmount('-0', 'TL', { signed: true });
    assert.equal(negZero.status, 'valid');
    assert.equal(Object.is(negZero.scaled, 0), true);
    assert.equal(negZero.canonical, '0');

    const negAmbig = codec.parseUserAmount('-10.500', 'HAS', { signed: true });
    assert.equal(negAmbig.status, 'ambiguous');
    assert.equal(negAmbig.options[0].canonical, '-10500');
    assert.equal(negAmbig.options[1].canonical, '-10.500');

    assert.equal(codec.parseUserAmount('-10', 'TL', { signed: false }).status, 'invalid');
    assert.equal(codec.parseUserAmount('- 10', 'TL', { signed: true }).status, 'invalid');
    assert.equal(codec.parseUserAmount('-', 'TL', { signed: true }).status, 'invalid');
  } finally {
    dom.window.close();
    restore();
  }
});

test('M2-F09 & F-M3-005 (Owner Forms): All 8 Owner forms, attachSaleLinePricing, and bindSaleReturn canonicalize Turkish & disambiguated inputs against Repository', async t => {
  // 1. #opening-form
  const uninit = await createOwnerApp(t, { url: 'http://127.0.0.1:4317/#v=overview', uninitialized: true });
  {
    const { window, document } = uninit;
    const form = document.querySelector('#opening-form');
    for (const el of form.querySelectorAll('input[name^="balance-"]')) {
      if (el.name === 'balance-nakit') setFieldValue(window, el, '10.000,50');
      else if (el.name === 'balance-bilezik22') {
        setFieldValue(window, el, '10.500');
        clickDecimalDisambig(el);
      } else setFieldValue(window, el, '0');
    }
    document.querySelector('#opening-bank-add').click();
    setFieldValue(window, form.querySelector('[name="bankName0"]'), 'Deneme Banka');
    setFieldValue(window, form.querySelector('[name="bankOpening0"]'), '25.000,75');
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await tick(70);
    assert.equal(uninit.repos.demo.state().initialized, true);
    assert.equal(uninit.repos.demo.state().balances.nakit, 1000050);
    assert.equal(uninit.repos.demo.state().balances.bilezik22, 10500);
  }

  // 2-9 on initialized repo
  const app = await createOwnerApp(t, { url: 'http://127.0.0.1:4317/#v=accounts', withSale: true, compact: true });
  const { window, document, repos } = app;

  // 2. #account-form with negative Turkish grouped & negative disambiguated HAS
  document.querySelector('#add-account').click();
  let accForm = document.querySelector('#account-form');
  setFieldValue(window, accForm.elements.name, 'Negatif TL Müşteri');
  setFieldValue(window, accForm.elements.opening, '-10.000,50');
  accForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(60);
  assert.equal(repos.demo.state().balances[repos.demo.state().accounts.find(a => a.name === 'Negatif TL Müşteri').id], -1000050);

  document.querySelector('#add-account').click();
  accForm = document.querySelector('#account-form');
  setFieldValue(window, accForm.elements.name, 'Negatif HAS Müşteri');
  setFieldValue(window, accForm.elements.unit, 'HAS', 'change');
  setFieldValue(window, accForm.elements.opening, '-10.500');
  clickDecimalDisambig(accForm.elements.opening);
  accForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(60);
  assert.equal(repos.demo.state().balances[repos.demo.state().accounts.find(a => a.name === 'Negatif HAS Müşteri').id], -10500);

  // 3. #stock-form
  document.querySelector('#navigation [data-view="stocks"]').click();
  await tick(30);
  document.querySelector('#add-stock').click();
  const stockForm = document.querySelector('#stock-form');
  setFieldValue(window, stockForm.elements.name, 'Yeni Gram Stok');
  setFieldValue(window, stockForm.elements.unit, 'GRAM', 'change');
  setFieldValue(window, stockForm.elements.opening, '1.250,500');
  stockForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(60);
  assert.equal(repos.demo.state().balances[repos.demo.state().accounts.find(a => a.name === 'YENİ GRAM STOK').id], 1250500);

  // 4. #inventory-register-form
  document.querySelector('#inventory-register').open = true;
  const regForm = document.querySelector('#inventory-register-form');
  const itemCb = window.DefterCombobox.getInstance(regForm.elements.itemAccount);
  itemCb.setValue('yuzuk', { emitChange: true });
  setFieldValue(window, regForm.elements.itemCode, 'YZK-M4-01');
  setFieldValue(window, regForm.elements.itemWeight, '10.500');
  clickDecimalDisambig(regForm.elements.itemWeight);
  setFieldValue(window, regForm.elements.itemGross, '1.000,500');
  setFieldValue(window, regForm.elements.itemNet, '1.000,250');
  regForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(60);
  const regItem = repos.demo.state().inventoryItems.find(i => i.code === 'YZK-M4-01');
  assert.equal(regItem.actualWeight, 10500);
  assert.equal(regItem.grossWeight, 1000500);
  assert.equal(regItem.netWeight, 1000250);

  // 5. #bank-form
  document.querySelector('#navigation [data-view="banks"]').click();
  await tick(30);
  document.querySelector('#add-bank').click();
  const bankForm = document.querySelector('#bank-form');
  setFieldValue(window, bankForm.elements.name, 'Yeni Banka M4');
  setFieldValue(window, bankForm.elements.opening, '25.000,75');
  bankForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(60);
  assert.equal(repos.demo.state().balances[repos.demo.state().accounts.find(a => a.name === 'Yeni Banka M4').id], 2500075);

  // 6. customerOrders (orderAdvance, orderRefund, scrapAdvanceTransfer, scrapAdvanceUndo)
  const scrapCustRes = repos.demo.execute({
    id: randomUUID(),
    revision: repos.demo.state().revision,
    command: { type: 'account', date: '2026-11-10', name: 'Hurda Avans Müşterisi', unit: 'TL', opening: '0', partyType: 'customer' }
  });
  const scrapCust = scrapCustRes.state.accounts.find(a => a.name === 'Hurda Avans Müşterisi');
  repos.demo.execute({
    id: randomUUID(),
    revision: repos.demo.state().revision,
    command: {
      type: 'purchase',
      date: '2026-11-10',
      source: 'customer',
      counterpartyType: 'customer',
      counterpartyId: scrapCust.id,
      items: [{ accountId: 'hurda22', quantity: '2.000', value: '5000' }],
      received: [],
      given: [],
      credits: [],
      debts: [{ accountId: scrapCust.id, quantity: '5000', valueTL: '5000' }]
    }
  });
  document.querySelector('#refresh').click();
  await tick(50);
  document.querySelector('#navigation [data-view="accounts"]').click();
  await tick(30);
  document.querySelector(`[data-account-detail="${scrapCust.id}"]`).click();
  await tick(40);
  const orderOpenForm = document.querySelector('form[data-order-action="customerOrder"]');
  setFieldValue(window, orderOpenForm.elements.description, 'Özel Yüzük Siparişi');
  orderOpenForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(60);

  const advForm = document.querySelector('form[data-order-action="orderAdvance"]');
  setFieldValue(window, advForm.elements.amountTL, '1.500,50');
  advForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(60);
  assert.equal(repos.demo.state().customerOrders[0].availableTL, 150050);

  const refForm = document.querySelector('form[data-order-action="orderRefund"]');
  setFieldValue(window, refForm.elements.amountTL, '500,25');
  refForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(60);
  assert.equal(repos.demo.state().customerOrders[0].availableTL, 100025);

  const scrapDetails = document.querySelector('[data-scrap-transfer]');
  scrapDetails.open = true;
  scrapDetails.dispatchEvent(new window.Event('toggle'));
  await tick(50);
  const scrapForm = scrapDetails.querySelector('form[data-order-action="scrapAdvanceTransfer"]');
  const purOpt = [...scrapForm.elements.purchaseId.options].find(o => o.value);
  assert.ok(purOpt, 'Expected scrap purchase option');
  setFieldValue(window, scrapForm.elements.purchaseId, purOpt.value, 'change');
  setFieldValue(window, scrapForm.elements.amountTL, '1.500,50');
  setFieldValue(window, scrapForm.elements.note, 'Hurda borçtan avansa aktarım');
  scrapForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(60);
  assert.equal(repos.demo.state().customerOrders[0].availableTL, 250075);

  const undoForm = document.querySelector('form[data-order-action="scrapAdvanceUndo"]');
  setFieldValue(window, undoForm.elements.amountTL, '500,25');
  setFieldValue(window, undoForm.elements.note, 'Kısmi geri alma');
  undoForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(60);
  assert.equal(repos.demo.state().customerOrders[0].availableTL, 200050);

  // 7. attachSaleLinePricing (preserve raw draft + canonicalize on submit)
  document.querySelector('#navigation [data-view="transaction"]').click();
  await tick(30);
  const saleForm = document.querySelector('#sale-form');
  const saleRow = saleForm.querySelector('.sale-item');
  window.DefterCombobox.getInstance(saleRow.querySelector('[data-item-field="accountId"]')).setValue('ceyrek', { emitChange: true });
  setFieldValue(window, saleRow.querySelector('[data-item-field="quantity"]'), '1');
  setFieldValue(window, saleRow.querySelector('[data-item-field="value"]'), '5.000,00');
  saleRow.querySelector('[data-add-price-component]').click();
  setFieldValue(window, saleRow.querySelector('[data-price-field="quotedTL"]'), '12.500,50');
  setFieldValue(window, saleRow.querySelector('[data-price-field="costTL"]'), '10.000,25');
  setFieldValue(window, saleRow.querySelector('[data-price-field="label"]'), 'İskonto');
  setFieldValue(window, saleRow.querySelector('[data-price-field="amountTL"]'), '-1.250,50');
  assert.equal(saleForm.draftAdapter.read().salePricing.lines[0].quotedTL, '12.500,50', 'Draft preserves raw user string');

  document.querySelector('[data-add-allocation="payment"][data-payment-type="cash"]').click();
  setFieldValue(window, saleForm.querySelector('#payment-lines [data-allocation-field="quantity"]'), '5.000,00');
  saleForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(70);
  const saleCmd = app.commands.at(-1).command;
  assert.equal(saleCmd.salePricing.lines[0].quotedTL, '12500.50');
  assert.equal(saleCmd.salePricing.lines[0].costTL, '10000.25');
  assert.equal(saleCmd.salePricing.lines[0].components[0].amountTL, '-1250.50');

  // 8. bindSaleReturn canonicalization (wait for journal list & pick the sale with weightAccount)
  document.querySelector('#navigation [data-view="journal"]').click();
  await tick(80);
  const saleReturnDetails = [...document.querySelectorAll('[data-sale-return]')];
  const retDetails = saleReturnDetails.find(el => {
    el.open = true;
    el.dispatchEvent(new window.Event('toggle'));
    return Boolean(el.querySelector('[data-return-weight="0"]'));
  });
  assert.ok(retDetails, `Expected sale return form with weight input (details=${saleReturnDetails.length}, status=${document.querySelector('#journal-results-count')?.textContent})`);
  await tick(30);
  const retForm = retDetails.querySelector('.sale-return-form');
  setFieldValue(window, retForm.querySelector('[data-return-quantity="0"]'), '1');
  const retWeightEl = retForm.querySelector('[data-return-weight="0"]');
  setFieldValue(window, retWeightEl, '5.500');
  clickDecimalDisambig(retWeightEl);
  setFieldValue(window, retForm.querySelector('[data-return-value="0"]'), '10.000,50');
  setFieldValue(window, retForm.querySelector('[data-return-note]'), 'Kısmi iade');
  retForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(20);
  retForm.querySelector('[data-confirm-return]').click();
  await tick(70);
  const retCmd = app.commands.at(-1).command;
  assert.equal(retCmd.type, 'saleReturn');
  assert.equal(retCmd.items[0].weight, '5.500');
  assert.equal(retCmd.items[0].value, '10000.50');
  assert.equal(retCmd.refunds[0].quantity, '10000.50');

  // 9. #nominal-opening-form
  const nomApp = await createOwnerApp(t, {
    url: 'http://127.0.0.1:4317/#v=overview',
    reposOverride: { demo: repos.demo, dukkan: repos.dukkan },
    stateMutator: st => ({ ...st, nominalUnconfirmed: true })
  });
  const nomForm = nomApp.document.querySelector('#nominal-opening-form');
  setFieldValue(nomApp.window, nomForm.querySelector('#nominal-quantity'), '243,500');
  setFieldValue(nomApp.window, nomForm.querySelector('#nominal-note'), 'Gerçek tartım');
  nomForm.dispatchEvent(new nomApp.window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(60);
  assert.equal(nomApp.commands.at(-1).command.quantity, '243.500');
});

test('F-M3-006 (UI) & F-M3-007: #summary-result paginates at 50 rows/page and #f-itemAccount uses DefterCombobox at >150 stocks', async t => {
  const baseRepo = seedRepo('demo', { stockCount: 140 });
  const app = await createOwnerApp(t, {
    url: 'http://127.0.0.1:4317/#v=summary',
    reposOverride: { demo: baseRepo, dukkan: seedRepo('dukkan') },
    summaryOverride: st => workdaySummary(st, st.date)
  });
  t.after(() => baseRepo.close());
  const { window, document } = app;

  const stNow = baseRepo.state();
  const summaryRowsTotal = workdaySummary(stNow, stNow.date).accounts.filter(row => {
    const acc = stNow.accounts.find(a => a.id === row.accountId);
    return acc && !(acc.retired && ['opening', 'incoming', 'outgoing', 'adjustment', 'closing'].every(k => row[k] === 0));
  }).length;
  assert.ok(summaryRowsTotal > 140);
  assert.equal(document.querySelectorAll('#summary-result tbody tr').length, 50);
  assert.ok(document.querySelector('#summary-page-info'));
  assert.equal(document.querySelector('#summary-prev').disabled, true);
  assert.equal(document.querySelector('#summary-next').disabled, false);

  // Advance through all pages to reach the last page and verify row count + focus preservation
  const totalPages = Math.ceil(summaryRowsTotal / 50);
  for (let p = 2; p <= totalPages; p++) {
    document.querySelector('#summary-next').click();
    if (p < totalPages) {
      assert.equal(document.querySelectorAll('#summary-result tbody tr').length, 50);
      assert.equal(document.activeElement, document.querySelector('#summary-next'));
    }
  }
  const lastPageCount = summaryRowsTotal - (totalPages - 1) * 50;
  assert.equal(document.querySelectorAll('#summary-result tbody tr').length, lastPageCount);
  assert.equal(document.querySelector('#summary-next').disabled, true);

  // Filter resets to page 1
  setFieldValue(window, document.querySelector('#summary-search'), 'Katalog Ürün');
  assert.equal(document.querySelectorAll('#summary-result tbody tr').length, 50);
  assert.match(document.querySelector('#summary-page-info').textContent, /140/);

  // Zero match hides pagination
  setFieldValue(window, document.querySelector('#summary-search'), 'BöyleBirHesapYok999');
  assert.equal(document.querySelector('#summary-page-info'), null);
  assert.match(document.querySelector('#summary-result tbody').textContent, /eşleşen hesap yok/i);

  // F-M3-007: #f-itemAccount in stocks view uses DefterCombobox with <= 1 native <option>
  document.querySelector('#navigation [data-view="stocks"]').click();
  await tick(40);
  const itemSelect = document.querySelector('#f-itemAccount');
  const itemCb = window.DefterCombobox.getInstance(itemSelect);
  assert.ok(itemCb, '#f-itemAccount must be enhanced with DefterCombobox');
  assert.ok(itemSelect.options.length <= 1, `Expected <= 1 native option, got ${itemSelect.options.length}`);
  assert.equal(itemCb.input.getAttribute('aria-label'), 'Stok kartı');

  const tailAcc = baseRepo.state().accounts.find(a => a.name === 'KATALOG ÜRÜN 140');
  itemCb.setValue(tailAcc.id, { emitChange: true });
  assert.equal(itemSelect.value, tailAcc.id);
  assert.equal(document.querySelector('#f-itemGroup').value, 'taki14');
});

test('M2-F20: All data tables in app.js, suppliers.js, and reports.js expose explicit th[scope=col|row]', async t => {
  const app = await createOwnerApp(t, { url: 'http://127.0.0.1:4317/#v=overview', withSale: true });
  const { window, document } = app;

  const assertTableScopes = (root, ctx) => {
    const tables = [...root.querySelectorAll('table')];
    assert.ok(tables.length > 0, `Expected tables in ${ctx}`);
    for (const table of tables) {
      for (const th of table.querySelectorAll('thead th')) {
        assert.equal(th.getAttribute('scope'), 'col', `Missing scope="col" in ${ctx}: ${th.textContent}`);
      }
      for (const th of table.querySelectorAll('tbody th')) {
        assert.equal(th.getAttribute('scope'), 'row', `Missing scope="row" in ${ctx}: ${th.textContent}`);
      }
    }
  };

  assertTableScopes(document, 'overview');

  document.querySelector('#navigation [data-view="banks"]').click();
  await tick(50);
  assertTableScopes(document, 'banks');

  // Seed a legacy-shaped purchase so journalItemMarkup and journalFinancialMeta tables both render
  app.repos.demo.execute({
    id: randomUUID(),
    revision: app.repos.demo.state().revision,
    command: {
      type: 'purchase',
      date: '2026-11-10',
      source: 'customer',
      items: [{ accountId: 'yuzuk', quantity: '1', weightAccount: 'taki14', weight: '5.000', value: '8000' }],
      payments: [{ accountId: 'nakit', quantity: '8000', valueTL: '8000' }],
      debts: []
    }
  });
  document.querySelector('#refresh').click();
  await tick(50);
  document.querySelector('#navigation [data-view="journal"]').click();
  await tick(50);
  assertTableScopes(document, 'journal');

  // Seed closing history via repository so measurementRows renders in closing view
  app.repos.demo.execute({
    id: randomUUID(),
    revision: app.repos.demo.state().revision,
    command: {
      type: 'stocktake',
      date: '2026-11-10',
      counts: { taki14: '50' },
      reasons: { taki14: 'Test sayım farkı' },
      approvedBy: 'Patron'
    }
  });
  await tick(10);
  document.querySelector('#refresh').click();
  await tick(50);
  document.querySelector('#navigation [data-view="closing"]').click();
  await tick(40);
  assertTableScopes(document, 'closing');

  // Suppliers statement tab
  document.querySelector('#navigation [data-view="suppliers"]').click();
  await tick(50);
  const firmId = app.repos.demo.state().supplierFirms[0].id;
  document.querySelector(`[data-open-firm="${firmId}"]`).click();
  await tick(30);
  document.querySelector('[data-supplier-task="statement"]').click();
  await tick(50);
  assertTableScopes(document, 'suppliers statement');

  // Reports portal summary table
  const restoreRepGlobals = saveGlobals();
  const repDom = new JSDOM(reportsHtml, { url: 'http://127.0.0.1:4318/', runScripts: 'outside-only' });
  const repWin = repDom.window;
  const repDoc = repWin.document;
  repWin.HTMLElement.prototype.scrollIntoView = () => {};
  const repState = app.repos.demo.state();
  const repSummary = { ...workdaySummary(repState, repState.date), workspace: 'dukkan', revision: repState.revision };
  repSummary.accounts = repSummary.accounts.slice(0, 5).map(row => ({ ...row, name: row.accountId }));
  repWin.fetch = async reqUrl => {
    const p = new URL(String(reqUrl), 'http://127.0.0.1:4318');
    if (p.pathname === '/api/reports/overview') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          workspace: 'dukkan',
          revision: repState.revision,
          initialized: true,
          date: repState.date,
          accounts: repState.accounts.slice(0, 5).map(a => ({ name: a.name, unit: a.unit, category: a.kind === 'receivable' ? 'receivable' : 'financial', balance: 0 })),
          totals: { sales: 0, purchases: 0, expenses: 0 }
        })
      };
    }
    if (p.pathname === '/api/reports/summary') {
      return { ok: true, status: 200, json: async () => repSummary };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  globalThis.window = repWin;
  globalThis.document = repDoc;
  repWin.eval(reportsSource);
  await tick(40);
  repDoc.querySelector('#report-summary-form').dispatchEvent(new repWin.Event('submit', { bubbles: true, cancelable: true }));
  await tick(40);
  assertTableScopes(repDoc, 'reports.js summary');
  repWin.close();
  restoreRepGlobals();
});

test('M2-F03 (Iter 2): F5 + #retry of amend on mixed collection (customer-exchange) clears edit_<id>_sale-form while preserving unrelated drafts', async t => {
  const actorId = '00000000-0000-4000-8000-000000000001';
  const repo = seedRepo('demo');
  t.after(() => repo.close());
  const cust = repo.state().accounts.find(a => a.name === 'İSMAİL ŞAHİN');

  const origRes = repo.execute({
    id: randomUUID(),
    revision: repo.state().revision,
    command: {
      type: 'collection',
      date: '2026-11-10',
      counterpartyType: 'customer',
      counterpartyId: cust.id,
      received: [{ accountId: 'nakit', quantity: '1000', valueTL: '1000' }],
      given: [],
      credits: [],
      debts: [{ accountId: cust.id, quantity: '1000', valueTL: '1000' }],
      note: 'İlk cari tahsilat'
    }
  });
  const origId = origRes.event?.id || origRes.state.journal.at(-1).id;
  assert.ok(origId);
  const rev = origRes.state.revision;

  const editExchangeKey = `defter-draft:v1:${actorId}:demo:retail:edit_${origId}_sale-form`;
  const unrelatedSaleKey = `defter-draft:v1:${actorId}:demo:retail:sale`;
  const pendingKey = `defter-draft:v1:${actorId}:demo:retail:pending`;

  const seededStorage = {
    [editExchangeKey]: JSON.stringify({
      version: 1,
      key: editExchangeKey,
      meta: { actorId, workspace: 'demo', workday: '2026-11-10', revision: rev, formId: 'sale-form' },
      data: { fields: { note: 'Düzeltilmiş cari tahsilat' }, sale: { payment: [{ accountId: 'nakit', quantity: '1200', valueTL: '1200' }] } }
    }),
    [unrelatedSaleKey]: JSON.stringify({
      version: 1,
      key: unrelatedSaleKey,
      meta: { actorId, workspace: 'demo', workday: '2026-11-10', revision: rev, formId: 'sale-form' },
      data: { fields: { note: 'Bağımsız satış taslağı' }, sale: { items: [{ accountId: 'ceyrek', quantity: '1', value: '5000' }] } }
    }),
    [pendingKey]: JSON.stringify({
      version: 1,
      key: pendingKey,
      id: randomUUID(),
      revision: rev,
      command: {
        type: 'amend',
        date: '2026-11-10',
        originalId: origId,
        note: 'Tutar düzeltmesi',
        replacement: {
          type: 'collection',
          date: '2026-11-10',
          counterpartyType: 'customer',
          counterpartyId: cust.id,
          received: [{ accountId: 'nakit', quantity: '1200', valueTL: '1200' }],
          given: [],
          credits: [],
          debts: [{ accountId: cust.id, quantity: '1200', valueTL: '1200' }],
          note: 'Düzeltilmiş cari tahsilat'
        }
      }
    })
  };

  const app = await createOwnerApp(t, {
    url: 'http://127.0.0.1:4317/#v=edit',
    reposOverride: { demo: repo, dukkan: seedRepo('dukkan') },
    seededStorage
  });

  assert.equal(app.document.querySelector('#retry-bar').hidden, false);
  app.document.querySelector('#retry').click();
  await tick(80);

  assert.equal(app.document.querySelector('#retry-bar').hidden, true);
  assert.equal(app.window.sessionStorage.getItem(editExchangeKey), null, 'edit_<originalId>_sale-form draft must be cleared');
  assert.notEqual(app.window.sessionStorage.getItem(unrelatedSaleKey), null, 'Unrelated sale draft must be preserved');
  const journalTypes = repo.state().journal.map(e => e.type);
  assert.deepEqual(journalTypes.slice(-3), ['collection', 'reverse', 'collection']);
});

test('M2-F03 (Iter 2): F5 + #retry clears matching supplier drafts (supplierPurchase, supplierAmend, supplierReverse) and partyReturn account draft safely', async t => {
  const actorId = '00000000-0000-4000-8000-000000000001';
  const repo = seedRepo('demo');
  t.after(() => repo.close());
  const firmId = repo.state().supplierFirms[0].id;
  const firmHasUnit = repo.state().accounts.find(a => a.partyType === 'supplier' && a.supplierId === firmId && a.unit === 'HAS');
  assert.ok(firmHasUnit);

  const pendingKey = `defter-draft:v1:${actorId}:demo:retail:pending`;
  const supPurchaseKey = `defter-draft:v1:${actorId}:demo:supplier:purchase:${firmId}`;
  const supPaymentKey = `defter-draft:v1:${actorId}:demo:supplier:payment:${firmId}`;
  const supReverseKey = `defter-draft:v1:${actorId}:demo:supplier:reverse:${firmId}`;
  const supReturnKey = `defter-draft:v1:${actorId}:demo:supplier:return:${firmId}`;

  // 1. supplierPurchase F5 + #retry
  const rev1 = repo.state().revision;
  const app1 = await createOwnerApp(t, {
    url: 'http://127.0.0.1:4317/#v=overview',
    reposOverride: { demo: repo, dukkan: seedRepo('dukkan') },
    seededStorage: {
      [supPurchaseKey]: JSON.stringify({
        version: 1,
        key: supPurchaseKey,
        meta: { actorId, workspace: 'demo', workday: '2026-11-10', revision: rev1, formId: 'purchase', entityId: firmId },
        data: { fields: { note: 'Toptancı alış taslağı' }, rows: {} }
      }),
      [supPaymentKey]: JSON.stringify({
        version: 1,
        key: supPaymentKey,
        meta: { actorId, workspace: 'demo', workday: '2026-11-10', revision: rev1, formId: 'payment', entityId: firmId },
        data: { fields: { note: 'Bağımsız ödeme taslağı' }, rows: {} }
      }),
      [pendingKey]: JSON.stringify({
        version: 1,
        key: pendingKey,
        id: randomUUID(),
        revision: rev1,
        command: {
          type: 'supplierPurchase',
          date: '2026-11-10',
          supplierId: firmId,
          items: [{ accountId: 'gramToplam', quantity: '5.000' }],
          charges: [{ accountId: firmHasUnit.id, quantity: '5.000' }]
        }
      })
    }
  });
  app1.document.querySelector('#retry').click();
  await tick(80);
  assert.equal(app1.document.querySelector('#retry-bar').hidden, true);
  assert.equal(app1.window.sessionStorage.getItem(supPurchaseKey), null, 'supplierPurchase draft must be cleared');
  assert.notEqual(app1.window.sessionStorage.getItem(supPaymentKey), null, 'Unrelated supplier payment draft must stay');

  const purchaseEvent = repo.state().journal.findLast(e => e.type === 'supplierPurchase');
  assert.ok(purchaseEvent);

  // 2. supplierAmend F5 + #retry
  const rev2 = repo.state().revision;
  const app2 = await createOwnerApp(t, {
    url: 'http://127.0.0.1:4317/#v=overview',
    reposOverride: { demo: repo, dukkan: seedRepo('dukkan') },
    seededStorage: {
      [supPurchaseKey]: JSON.stringify({
        version: 1,
        key: supPurchaseKey,
        meta: { actorId, workspace: 'demo', workday: '2026-11-10', revision: rev2, formId: 'purchase', entityId: firmId },
        data: { fields: { amendNote: 'Gram düzeltme' }, amend: { originalId: purchaseEvent.id, note: 'Gram düzeltme' }, rows: {} }
      }),
      [supPaymentKey]: JSON.stringify({
        version: 1,
        key: supPaymentKey,
        meta: { actorId, workspace: 'demo', workday: '2026-11-10', revision: rev2, formId: 'payment', entityId: firmId },
        data: { fields: { note: 'Bağımsız ödeme taslağı' }, rows: {} }
      }),
      [pendingKey]: JSON.stringify({
        version: 1,
        key: pendingKey,
        id: randomUUID(),
        revision: rev2,
        command: {
          type: 'supplierAmend',
          date: '2026-11-10',
          originalId: purchaseEvent.id,
          note: 'Gram düzeltme',
          replacement: {
            type: 'supplierPurchase',
            date: '2026-11-10',
            supplierId: firmId,
            items: [{ accountId: 'gramToplam', quantity: '6.000' }],
            charges: [{ accountId: firmHasUnit.id, quantity: '6.000' }]
          }
        }
      })
    }
  });
  app2.document.querySelector('#retry').click();
  await tick(80);
  assert.equal(app2.document.querySelector('#retry-bar').hidden, true);
  assert.equal(app2.window.sessionStorage.getItem(supPurchaseKey), null, 'supplierAmend draft must be cleared');
  assert.notEqual(app2.window.sessionStorage.getItem(supPaymentKey), null, 'Unrelated supplier payment draft must stay');

  const amendedPurchaseEvent = repo.state().journal.findLast(e => e.type === 'supplierPurchase');
  assert.ok(amendedPurchaseEvent);

  // 3. supplierReverse F5 + #retry (must NOT wipe supplier:return draft sharing the same originalId!)
  const rev3 = repo.state().revision;
  const app3 = await createOwnerApp(t, {
    url: 'http://127.0.0.1:4317/#v=overview',
    reposOverride: { demo: repo, dukkan: seedRepo('dukkan') },
    seededStorage: {
      [supReturnKey]: JSON.stringify({
        version: 1,
        key: supReturnKey,
        meta: { actorId, workspace: 'demo', workday: '2026-11-10', revision: rev3, formId: 'return', entityId: firmId },
        data: { fields: { originalId: amendedPurchaseEvent.id, note: 'İade taslağı' }, arrays: {} }
      }),
      [supReverseKey]: JSON.stringify({
        version: 1,
        key: supReverseKey,
        meta: { actorId, workspace: 'demo', workday: '2026-11-10', revision: rev3, formId: 'reverse', entityId: firmId },
        data: { fields: { originalId: amendedPurchaseEvent.id, note: 'Yanlış firma seçimi' }, rows: {} }
      }),
      [pendingKey]: JSON.stringify({
        version: 1,
        key: pendingKey,
        id: randomUUID(),
        revision: rev3,
        command: {
          type: 'supplierReverse',
          date: '2026-11-10',
          originalId: amendedPurchaseEvent.id,
          note: 'Yanlış firma seçimi'
        }
      })
    }
  });
  app3.document.querySelector('#retry').click();
  await tick(80);
  assert.equal(app3.document.querySelector('#retry-bar').hidden, true);
  assert.equal(app3.window.sessionStorage.getItem(supReverseKey), null, 'supplierReverse draft must be cleared');
  assert.notEqual(app3.window.sessionStorage.getItem(supReturnKey), null, 'supplierReturn draft with same originalId must NOT be wiped');
  assert.equal(repo.state().journal.at(-1).type, 'supplierReverse');

  // 4. account partyReturn (entityId: 'operation:sale') F5 + #retry clears matching operation draft without wiping accounts:account-form:new
  const rev4 = repo.state().revision;
  const opPartyKey = `defter-draft:v1:${actorId}:demo:retail:accounts_account-form:operation:sale`;
  const newPartyKey = `defter-draft:v1:${actorId}:demo:retail:accounts_account-form:new`;
  const app4 = await createOwnerApp(t, {
    url: 'http://127.0.0.1:4317/#v=transaction',
    reposOverride: { demo: repo, dukkan: seedRepo('dukkan') },
    seededStorage: {
      [newPartyKey]: JSON.stringify({
        version: 1,
        key: newPartyKey,
        meta: { actorId, workspace: 'demo', workday: '2026-11-10', revision: rev4, formId: 'account-form', entityId: 'new' },
        data: { fields: { name: 'Ayrı Cari Taslak', unit: 'TL', opening: '0' } }
      }),
      [opPartyKey]: JSON.stringify({
        version: 1,
        key: opPartyKey,
        meta: { actorId, workspace: 'demo', workday: '2026-11-10', revision: rev4, formId: 'account-form', entityId: 'operation:sale' },
        data: { fields: { name: 'Hızlı Çekmece Müşteri', unit: 'TL', opening: '0' } }
      }),
      [pendingKey]: JSON.stringify({
        version: 1,
        key: pendingKey,
        id: randomUUID(),
        revision: rev4,
        command: {
          type: 'account',
          date: '2026-11-10',
          name: 'Hızlı Çekmece Müşteri',
          unit: 'TL',
          opening: '0',
          partyType: 'customer'
        }
      })
    }
  });
  app4.document.querySelector('#retry').click();
  await tick(80);
  assert.equal(app4.document.querySelector('#retry-bar').hidden, true);
  assert.equal(app4.window.sessionStorage.getItem(opPartyKey), null, 'Matching operation:sale party draft must be cleared');
  assert.notEqual(app4.window.sessionStorage.getItem(newPartyKey), null, 'Unrelated new party draft must NOT be wiped');
});

test('checkout.js parseSignedTL (Iter 2): rejects whitespace after minus (- 5) while accepting -5 and -1.250,50', async t => {
  const emp = await createEmployeeCheckout(t);
  const { window, document, commands } = emp;

  const firstItem = document.querySelector('#items [data-item]');
  setFieldValue(window, firstItem.querySelector('[data-quantity]'), '1');
  setFieldValue(window, firstItem.querySelector('[data-value]'), '5000');

  document.querySelector('[data-add="received"][data-category="money"]').click();
  const payRow = document.querySelector('#received [data-allocation]');
  payRow._accountCombobox.setValue('nakit', { emitChange: true });
  setFieldValue(window, payRow.querySelector('[data-quantity]'), '5000');

  firstItem.querySelector('[data-add-component]').click();
  const compName = firstItem.querySelector('[data-component-name]');
  const compVal = firstItem.querySelector('[data-component-value]');
  setFieldValue(window, compName, 'İskonto');

  // 1. '- 5' must be rejected consistently with DefterAmountCodec.parseUserAmount
  setFieldValue(window, compVal, '- 5');
  document.querySelector('#trade').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(compVal.checkValidity(), false, 'parseSignedTL must reject "- 5"');
  assert.equal(compVal.dataset.canonicalAmount, undefined);
  assert.equal(document.querySelector('#review').hidden, true);

  // 2. '-5' must be accepted and canonicalized to '-5'
  setFieldValue(window, compVal, '-5');
  document.querySelector('#trade').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(compVal.checkValidity(), true, 'parseSignedTL must accept "-5"');
  assert.equal(compVal.dataset.canonicalAmount, '-5');
  assert.equal(document.querySelector('#review').hidden, false);

  // 3. Edit back and verify '-1.250,50' is accepted, canonicalized to '-1250.50', and submitted
  document.querySelector('#edit').click();
  setFieldValue(window, compVal, '-1.250,50');
  document.querySelector('#trade').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(compVal.checkValidity(), true, 'parseSignedTL must accept "-1.250,50"');
  assert.equal(compVal.dataset.canonicalAmount, '-1250.50');
  assert.equal(document.querySelector('#review').hidden, false);

  document.querySelector('#confirm').click();
  await tick(70);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].command.salePricing.lines[0].components[0].amountTL, '-1250.50');
});

test('M4.2 Iter 3: Quick Customer Drawer (direct submit AND F5 + #retry) preserves unrelated accounts_account-form:new draft', async t => {
  const actorId = '00000000-0000-4000-8000-000000000001';
  const repo = seedRepo('demo');
  t.after(() => repo.close());
  const rev = repo.state().revision;
  const unrelatedNewPartyKey = `defter-draft:v1:${actorId}:demo:retail:accounts_account-form:new`;
  const pendingKey = `defter-draft:v1:${actorId}:demo:retail:pending`;

  // 1. Direct submit from Quick Customer Drawer on #v=transaction
  const appDirect = await createOwnerApp(t, {
    url: 'http://127.0.0.1:4317/#v=transaction',
    reposOverride: { demo: repo, dukkan: seedRepo('dukkan') },
    seededStorage: {
      [unrelatedNewPartyKey]: JSON.stringify({
        version: 1,
        key: unrelatedNewPartyKey,
        meta: { actorId, workspace: 'demo', workday: '2026-11-10', revision: rev, formId: 'account-form', entityId: 'new' },
        data: { fields: { name: 'Unrelated Accounts Draft', unit: 'TL', opening: '0' } }
      })
    }
  });
  appDirect.document.querySelector('[data-create-party]').click();
  await tick(40);
  const drawerForm = appDirect.document.querySelector('.defter-drawer form');
  assert.ok(drawerForm, 'Quick Customer Drawer form should open');
  setFieldValue(appDirect.window, drawerForm.querySelector('#f-name'), 'Drawer Customer Direct');
  drawerForm.dispatchEvent(new appDirect.window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(80);
  assert.notEqual(appDirect.window.sessionStorage.getItem(unrelatedNewPartyKey), null, 'Direct Quick Customer Drawer submit must preserve unrelated accounts_account-form:new draft');
  assert.ok(repo.state().accounts.some(a => a.name === 'Drawer Customer Direct'));

  // 2. F5 + #retry after Quick Customer Drawer failure
  const rev2 = repo.state().revision;
  const appRetry = await createOwnerApp(t, {
    url: 'http://127.0.0.1:4317/#v=transaction',
    reposOverride: { demo: repo, dukkan: seedRepo('dukkan') },
    seededStorage: {
      [unrelatedNewPartyKey]: JSON.stringify({
        version: 1,
        key: unrelatedNewPartyKey,
        meta: { actorId, workspace: 'demo', workday: '2026-11-10', revision: rev2, formId: 'account-form', entityId: 'new' },
        data: { fields: { name: 'Unrelated Accounts Draft', unit: 'TL', opening: '0' } }
      }),
      [pendingKey]: JSON.stringify({
        version: 1,
        key: pendingKey,
        id: randomUUID(),
        revision: rev2,
        command: {
          type: 'account',
          date: '2026-11-10',
          name: 'Drawer Customer Retry',
          unit: 'TL',
          opening: '0',
          partyType: 'customer'
        }
      })
    }
  });
  assert.equal(appRetry.document.querySelector('#retry-bar').hidden, false);
  appRetry.document.querySelector('#retry').click();
  await tick(80);
  assert.equal(appRetry.document.querySelector('#retry-bar').hidden, true);
  assert.notEqual(appRetry.window.sessionStorage.getItem(unrelatedNewPartyKey), null, 'F5 + #retry of Quick Customer Drawer must preserve unrelated accounts_account-form:new draft');
  assert.ok(repo.state().accounts.some(a => a.name === 'Drawer Customer Retry'));
});

test('M4.2 Iter 3: Quick Stock Drawer (direct submit AND F5 + #retry) preserves unrelated stock-form:new draft, while matching stock-form:new retry clears it', async t => {
  const actorId = '00000000-0000-4000-8000-000000000001';
  const repo = seedRepo('demo');
  t.after(() => repo.close());
  const rev = repo.state().revision;
  const unrelatedStockKey = `defter-draft:v1:${actorId}:demo:retail:stock-form:new`;
  const pendingKey = `defter-draft:v1:${actorId}:demo:retail:pending`;

  // 1. Direct submit from Quick Stock Drawer on #v=transaction
  const appDirect = await createOwnerApp(t, {
    url: 'http://127.0.0.1:4317/#v=transaction',
    reposOverride: { demo: repo, dukkan: seedRepo('dukkan') },
    seededStorage: {
      [unrelatedStockKey]: JSON.stringify({
        version: 1,
        key: unrelatedStockKey,
        meta: { actorId, workspace: 'demo', workday: '2026-11-10', revision: rev, formId: 'stock-form', entityId: 'new' },
        data: { fields: { name: 'Unrelated Stock Draft', unit: 'ADET', opening: '0' } }
      })
    }
  });
  appDirect.document.querySelector('[data-create-stock]').click();
  await tick(40);
  const drawerForm = appDirect.document.querySelector('.defter-drawer form');
  assert.ok(drawerForm, 'Quick Stock Drawer form should open');
  setFieldValue(appDirect.window, drawerForm.querySelector('#f-name'), 'Drawer Stock Direct');
  drawerForm.dispatchEvent(new appDirect.window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(80);
  assert.notEqual(appDirect.window.sessionStorage.getItem(unrelatedStockKey), null, 'Direct Quick Stock Drawer submit must preserve unrelated stock-form:new draft');
  assert.ok(repo.state().accounts.some(a => a.name === 'DRAWER STOCK DİRECT' || a.name === 'DRAWER STOCK DIRECT'));

  // 2. F5 + #retry after Quick Stock Drawer failure
  const rev2 = repo.state().revision;
  const appRetry = await createOwnerApp(t, {
    url: 'http://127.0.0.1:4317/#v=transaction',
    reposOverride: { demo: repo, dukkan: seedRepo('dukkan') },
    seededStorage: {
      [unrelatedStockKey]: JSON.stringify({
        version: 1,
        key: unrelatedStockKey,
        meta: { actorId, workspace: 'demo', workday: '2026-11-10', revision: rev2, formId: 'stock-form', entityId: 'new' },
        data: { fields: { name: 'Unrelated Stock Draft', unit: 'ADET', opening: '0' } }
      }),
      [pendingKey]: JSON.stringify({
        version: 1,
        key: pendingKey,
        id: randomUUID(),
        revision: rev2,
        command: {
          type: 'stockAccount',
          date: '2026-11-10',
          name: 'DRAWER STOCK RETRY',
          unit: 'ADET',
          pairedGroups: [],
          opening: '0',
          isSaleable: true,
          countPolicy: 'daily'
        }
      })
    }
  });
  assert.equal(appRetry.document.querySelector('#retry-bar').hidden, false);
  appRetry.document.querySelector('#retry').click();
  await tick(80);
  assert.equal(appRetry.document.querySelector('#retry-bar').hidden, true);
  assert.notEqual(appRetry.window.sessionStorage.getItem(unrelatedStockKey), null, 'F5 + #retry of Quick Stock Drawer must preserve unrelated stock-form:new draft');
  assert.ok(repo.state().accounts.some(a => a.name === 'DRAWER STOCK RETRY'));

  // 3. Matching stock-form:new F5 + #retry (lowercase Turkish input -> uppercase cmd.name) MUST clear stock-form:new
  const rev3 = repo.state().revision;
  const appMatchingRetry = await createOwnerApp(t, {
    url: 'http://127.0.0.1:4317/#v=overview',
    reposOverride: { demo: repo, dukkan: seedRepo('dukkan') },
    seededStorage: {
      [unrelatedStockKey]: JSON.stringify({
        version: 1,
        key: unrelatedStockKey,
        meta: { actorId, workspace: 'demo', workday: '2026-11-10', revision: rev3, formId: 'stock-form', entityId: 'new' },
        data: { fields: { name: 'yeni bilezik', unit: 'ADET', opening: '0' } }
      }),
      [pendingKey]: JSON.stringify({
        version: 1,
        key: pendingKey,
        id: randomUUID(),
        revision: rev3,
        command: {
          type: 'stockAccount',
          date: '2026-11-10',
          name: 'YENİ BİLEZİK',
          unit: 'ADET',
          pairedGroups: [],
          opening: '0',
          isSaleable: true,
          countPolicy: 'daily'
        }
      })
    }
  });
  appMatchingRetry.document.querySelector('#retry').click();
  await tick(80);
  assert.equal(appMatchingRetry.document.querySelector('#retry-bar').hidden, true);
  assert.equal(appMatchingRetry.window.sessionStorage.getItem(unrelatedStockKey), null, 'Matching stock-form:new draft must be cleared on retry');
  assert.ok(repo.state().accounts.some(a => a.name === 'YENİ BİLEZİK'));
});

test('M4.2 Iter 3: fundAccount F5 + #retry clears matching bank-form:other-cash while preserving unrelated bank-form draft', async t => {
  const actorId = '00000000-0000-4000-8000-000000000001';
  const repo = seedRepo('demo');
  t.after(() => repo.close());
  const rev = repo.state().revision;

  const bankFormKey = `defter-draft:v1:${actorId}:demo:retail:bank-form`;
  const otherCashKey = `defter-draft:v1:${actorId}:demo:retail:bank-form:other-cash`;
  const pendingKey = `defter-draft:v1:${actorId}:demo:retail:pending`;

  const app = await createOwnerApp(t, {
    url: 'http://127.0.0.1:4317/#v=overview',
    reposOverride: { demo: repo, dukkan: seedRepo('dukkan') },
    seededStorage: {
      [bankFormKey]: JSON.stringify({
        version: 1,
        key: bankFormKey,
        meta: { actorId, workspace: 'demo', workday: '2026-11-10', revision: rev, formId: 'bank-form' },
        data: { fields: { name: 'Ziraat Bankası', unit: 'TL', physical: 'false', opening: '0' } }
      }),
      [otherCashKey]: JSON.stringify({
        version: 1,
        key: otherCashKey,
        meta: { actorId, workspace: 'demo', workday: '2026-11-10', revision: rev, formId: 'bank-form', entityId: 'other-cash' },
        data: { fields: { name: 'Nakit Diğer (SAR)', unit: 'other', currencyCode: 'SAR', physical: 'true', opening: '0' } }
      }),
      [pendingKey]: JSON.stringify({
        version: 1,
        key: pendingKey,
        id: randomUUID(),
        revision: rev,
        command: {
          type: 'fundAccount',
          date: '2026-11-10',
          name: 'Nakit Diğer (SAR)',
          unit: 'SAR',
          physical: true,
          opening: '0'
        }
      })
    }
  });

  assert.equal(app.document.querySelector('#retry-bar').hidden, false);
  app.document.querySelector('#retry').click();
  await tick(80);

  assert.equal(app.document.querySelector('#retry-bar').hidden, true);
  assert.equal(app.window.sessionStorage.getItem(otherCashKey), null, 'Matching bank-form:other-cash draft must be cleared');
  assert.notEqual(app.window.sessionStorage.getItem(bankFormKey), null, 'Unrelated bank-form draft must be preserved');
  assert.ok(repo.state().accounts.some(a => a.name === 'Nakit Diğer (SAR)' && a.unit === 'SAR'));
});

test('M4.2 Iter 3: checkout.js parseSignedTL non-codec fallback normalizes -0 to +0 when allowZero is true and rejects "- 5"', async t => {
  const emp = await createEmployeeCheckout(t, { withCodec: false });
  const { window, document } = emp;
  const input = document.createElement('input');
  document.body.append(input);

  input.value = '-0';
  const zeroAmount = window.parseSignedTL(input, false, true);
  assert.equal(zeroAmount, 0);
  assert.equal(Object.is(zeroAmount, -0), false, 'Non-codec parseSignedTL("-0", false, true) must not return -0');
  assert.equal(input.checkValidity(), true);

  input.value = '- 5';
  const invalidAmount = window.parseSignedTL(input, false, false);
  assert.equal(invalidAmount, null);
  assert.equal(input.checkValidity(), false);
});

test('Scale C summary heap fix: renderSummary consumes server-paginated /api/summary responses and triggers page/filter requests', async t => {
  const baseRepo = seedRepo('demo');
  t.after(() => baseRepo.close());
  const seenQueries = [];
  const app = await createOwnerApp(t, {
    url: 'http://127.0.0.1:4317/#v=summary',
    reposOverride: { demo: baseRepo, dukkan: seedRepo('dukkan') },
    summaryOverride: (st, parsed) => {
      seenQueries.push(Object.fromEntries(parsed.searchParams.entries()));
      const baseSummary = workdaySummary(st, parsed.searchParams.get('date') || st.date);
      const page = Number(parsed.searchParams.get('page') || '1');
      const q = (parsed.searchParams.get('q') || '').toLowerCase();
      const filtered = q
        ? baseSummary.accounts.filter(r => r.accountId.toLowerCase().includes(q))
        : baseSummary.accounts;
      const pageSize = Number(parsed.searchParams.get('pageSize') || '50');
      const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
      return {
        date: baseSummary.date,
        accounts: filtered.slice((page - 1) * pageSize, page * pageSize),
        totals: baseSummary.totals,
        paginated: true,
        totalAccounts: baseSummary.accounts.length,
        filteredAccounts: filtered.length,
        page,
        pageSize,
        totalPages
      };
    }
  });
  await tick(40);
  assert.ok(seenQueries.length >= 1);
  assert.equal(seenQueries[0].paginated, '1');
  assert.equal(seenQueries[0].pageSize, '50');
  assert.equal(seenQueries[0].page, '1');
  assert.ok(app.document.querySelectorAll('#summary-result tbody tr').length > 0);
  const searchEl = app.document.querySelector('#summary-search');
  setFieldValue(app.window, searchEl, 'nakit');
  await tick(40);
  assert.equal(seenQueries.at(-1).q, 'nakit');
  assert.equal(app.document.querySelectorAll('#summary-result tbody tr').length, 1);
});
