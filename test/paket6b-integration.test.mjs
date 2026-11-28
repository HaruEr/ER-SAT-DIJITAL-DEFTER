import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadJSDOM } from '../test-support/jsdom.mjs';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS, workdaySummary } from '../domain.mjs';
import { checkoutState, customerChoices, customerDetail } from '../editor-access.mjs';
import * as suppliersModule from '../public/suppliers.js';

const JSDOM = await loadJSDOM();

const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const checkoutHtml = readFileSync(new URL('../public/checkout.html', import.meta.url), 'utf8');
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

const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));

function seedRepo(workspace = 'demo', { withManyItems = false, withSale = false, uninitialized = false, nominalUnconfirmed = false } = {}) {
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
          a.id === 'nakit' ? '50000'
            : a.id === 'usd' ? '100'
            : a.id === 'ceyrek' ? '10'
            : a.id === 'gramToplam' ? '20'
            : a.id === 'bilezik22' ? '100'
            : a.id === 'bilezikAdet' ? '5'
            : '0'
        ])
      )
    }
  });

  if (nominalUnconfirmed) {
    // Re-open or leave nominal as false? Actually nominalUnconfirmed is derived in state when opening hasn't confirmed nominal;
    // we test nominalUnconfirmed via state override in test if needed.
  }

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

  repo.execute({
    id: randomUUID(),
    revision: repo.state().revision,
    command: {
      type: 'stockAccount',
      date: '2026-11-10',
      name: 'Sırma Bilezik 22A',
      unit: 'GRAM',
      opening: '25'
    }
  });

  repo.execute({
    id: randomUUID(),
    revision: repo.state().revision,
    command: {
      type: 'stockAccount',
      date: '2026-11-10',
      name: 'Tükenen Yüzük',
      unit: 'ADET',
      opening: '0'
    }
  });

  if (withManyItems) {
    for (let i = 1; i <= 55; i++) {
      repo.execute({
        id: randomUUID(),
        revision: repo.state().revision,
        command: {
          type: 'stockAccount',
          date: '2026-11-10',
          name: `Katalog Ürün ${String(i).padStart(3, '0')}`,
          unit: 'ADET',
          opening: '5'
        }
      });
    }
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
        items: [{ accountId: 'ceyrek', quantity: '1', value: '5000' }],
        received: [{ accountId: 'nakit', quantity: '5000', valueTL: '5000' }],
        given: [],
        credits: [],
        debts: []
      }
    });
  }

  return repo;
}

async function createOwnerApp({
  url = 'http://127.0.0.1:4317/#v=transaction',
  reposOverride = null,
  seededStorage = null,
  compact = false,
  withManyItems = false,
  withSale = false,
  uninitialized = false,
  confirmResult = true,
  stateMutator = null,
  journalDelayMs = 0
} = {}) {
  const ownerActor = { id: '00000000-0000-4000-8000-000000000001', name: 'Patron', role: 'owner' };
  const repos = reposOverride || {
    demo: seedRepo('demo', { withManyItems, withSale, uninitialized }),
    dukkan: seedRepo('dukkan')
  };
  const dom = new JSDOM(indexHtml, { url, runScripts: 'outside-only' });
  const { window } = dom;
  const { document } = window;
  window.localStorage.setItem('defter-workspace', 'demo');
  Object.defineProperty(window.crypto, 'randomUUID', { value: randomUUID });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.confirm = () => confirmResult;

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
  const journalRequests = [];

  window.DefterSession = {
    current: () => JSON.parse(window.sessionStorage.getItem('defter-session') || 'null'),
    clear: () => window.sessionStorage.removeItem('defter-session'),
    lock: () => {},
    finishRestore: () => {},
    api: async () => ({})
  };

  window.fetch = async (reqUrl, init = {}) => {
    const parsed = new URL(String(reqUrl), 'http://127.0.0.1:4317');
    const ws = parsed.searchParams.get('workspace') || 'demo';
    const repo = repos[ws];

    if (parsed.pathname === '/api/state') {
      let st = repo.state({ compact });
      if (stateMutator) st = stateMutator(st);
      return { ok: true, status: 200, json: async () => st };
    }
    if (parsed.pathname === '/api/journal') {
      const rec = {
        params: Object.fromEntries(parsed.searchParams),
        signal: init.signal || null,
        aborted: Boolean(init.signal?.aborted)
      };
      journalRequests.push(rec);
      if (init.signal) {
        init.signal.addEventListener('abort', () => { rec.aborted = true; });
      }
      if (journalDelayMs > 0) {
        await tick(journalDelayMs);
        if (init.signal?.aborted) {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          throw err;
        }
      }
      return {
        ok: true,
        status: 200,
        json: async () => repo.journalPage({
          ...Object.fromEntries(parsed.searchParams),
          limit: Number(parsed.searchParams.get('limit') || 50)
        })
      };
    }
    if (parsed.pathname === '/api/account-statement') {
      return {
        ok: true,
        status: 200,
        json: async () => repo.accountStatement({
          accountId: parsed.searchParams.get('accountId'),
          startDate: parsed.searchParams.get('startDate') || '',
          endDate: parsed.searchParams.get('endDate') || ''
        })
      };
    }
    if (parsed.pathname === '/api/summary') {
      const st = repo.state();
      return { ok: true, status: 200, json: async () => workdaySummary(st, parsed.searchParams.get('date') || st.date) };
    }
    if (parsed.pathname === '/api/suppliers') {
      const st = repo.state();
      const firms = (st.supplierFirms || []).map(f => ({
        ...f,
        accounts: st.accounts.filter(a => a.partyType === 'supplier' && (a.parentAccountId === f.id || a.id === f.id))
      }));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          firms,
          units: st.accounts.filter(a => a.partyType === 'supplier')
        })
      };
    }
    if (parsed.pathname === '/api/customers') {
      return { ok: true, status: 200, json: async () => [] };
    }
    if (parsed.pathname === '/api/command') {
      const env = JSON.parse(init.body || '{}');
      commands.push(env);
      try {
        return { ok: true, status: 200, json: async () => repo.execute(env, { version: 1, actor: ownerActor }) };
      } catch (err) {
        return { ok: false, status: err.status || 400, json: async () => ({ error: err.message }) };
      }
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const prevCb = globalThis.DefterCombobox;
  const prevNorm = globalThis.DefterSearchNorm;
  window.__testSuppliersModule = suppliersModule;

  window.eval(searchNormSource);
  window.eval(draftStoreSource);
  window.eval(uiKitSource);
  window.eval(amountCodecSource);
  window.eval(dateFormatSource);
  window.eval(comboboxSource);
  window.eval(commandPaletteSource);
  globalThis.DefterCombobox = window.DefterCombobox;
  globalThis.DefterSearchNorm = window.DefterSearchNorm;
  window.eval(appSource.replace("import('./suppliers.js')", 'Promise.resolve(window.__testSuppliersModule)'));
  await tick(60);

  return {
    dom,
    window,
    document,
    repos,
    commands,
    journalRequests,
    snapshotStorage: () => Object.fromEntries(
      Object.keys(window.sessionStorage).map(k => [k, window.sessionStorage.getItem(k)])
    ),
    close: (keepRepos = false) => {
      delete window.__testSuppliersModule;
      globalThis.DefterCombobox = prevCb;
      globalThis.DefterSearchNorm = prevNorm;
      window.close();
      if (!keepRepos) {
        repos.demo.close();
        repos.dukkan.close();
      }
    }
  };
}

async function createEmployeeCheckout({
  withManyItems = false,
  failCustomers500 = false,
  repoOverride = null
} = {}) {
  const empActor = { id: '00000000-0000-4000-8000-000000000002', name: 'Tezgâh Çalışanı', role: 'employee' };
  const repo = repoOverride || seedRepo('demo', { withManyItems });
  const dom = new JSDOM(checkoutHtml, { url: 'http://127.0.0.1:4317/checkout', runScripts: 'outside-only' });
  const { window } = dom;
  const { document } = window;
  if (document.getElementById('workspace')) document.getElementById('workspace').value = 'demo';
  Object.defineProperty(window.crypto, 'randomUUID', { value: randomUUID });
  window.HTMLElement.prototype.scrollIntoView = () => {};

  window.sessionStorage.setItem('defter-session', JSON.stringify({
    actor: empActor,
    token: 'emp-tok',
    expiresAt: Date.now() + 3600_000
  }));

  const calls = [];
  const customerRequests = [];

  window.fetch = async (reqUrl, init = {}) => {
    const parsed = new URL(String(reqUrl), 'http://127.0.0.1:4317');
    if (parsed.pathname === '/api/auth/session') {
      return { ok: true, status: 200, json: async () => empActor };
    }
    if (parsed.pathname === '/api/checkout') {
      return { ok: true, status: 200, json: async () => checkoutState(repo.state({ compact: true })) };
    }
    if (parsed.pathname === '/api/customers') {
      customerRequests.push({
        q: parsed.searchParams.get('q'),
        id: parsed.searchParams.get('id'),
        meta: parsed.searchParams.get('meta'),
        limit: parsed.searchParams.get('limit')
      });
      if (failCustomers500) {
        return { ok: false, status: 500, json: async () => ({ error: 'Müşteri servisi hatası' }) };
      }
      const st = repo.state({ compact: true });
      const id = parsed.searchParams.get('id');
      if (id) {
        const detail = customerDetail(st, id);
        if (!detail) return { ok: false, status: 404, json: async () => ({ error: 'Bulunamadı' }) };
        return { ok: true, status: 200, json: async () => detail };
      }
      const choices = customerChoices(st, parsed.searchParams.get('q') || '', {
        limit: Number(parsed.searchParams.get('limit') || 20),
        meta: parsed.searchParams.get('meta') === '1'
      });
      return { ok: true, status: 200, json: async () => choices };
    }
    if (parsed.pathname === '/api/command') {
      const env = JSON.parse(init.body || '{}');
      calls.push(env);
      try {
        return { ok: true, status: 200, json: async () => repo.execute(env, { version: 1, actor: empActor }) };
      } catch (err) {
        return { ok: false, status: err.status || 400, json: async () => ({ error: err.message }) };
      }
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  window.eval(searchNormSource);
  window.eval(draftStoreSource);
  window.eval(uiKitSource);
  window.eval(accessClientSource);
  window.eval(amountCodecSource);
  window.eval(dateFormatSource);
  window.eval(comboboxSource);
  window.eval(commandPaletteSource);
  window.eval(checkoutSource);
  await tick(60);

  return {
    dom,
    window,
    document,
    repo,
    calls,
    customerRequests,
    close: (keepRepo = false) => {
      window.close();
      if (!keepRepo) repo.close();
    }
  };
}

// ============================================================================
// 1. Escalation #1: amount-codec.js idempotent renderDisambiguation + mousedown
// ============================================================================
test('1. amount-codec.js renderDisambiguation is idempotent and mousedown prevents blur cancellation', () => {
  const dom = new JSDOM('<!doctype html><html lang="tr"><body><label>Tutar<input id="amt" type="text"></label></body></html>', {
    url: 'http://127.0.0.1:4317/',
    runScripts: 'outside-only'
  });
  const { window } = dom;
  const { document } = window;
  window.eval(amountCodecSource);

  const input = document.querySelector('#amt');
  input.value = '2.500';
  const parsed = window.DefterAmountCodec.parseInputElement(input, 'GRAM');
  assert.equal(parsed, null);
  assert.ok(input.validationMessage.length > 0, 'ambiguous input sets validationMessage');

  const box = document.querySelector('.amount-disambiguation');
  const firstBtn = document.querySelector('[data-amount-choice]');
  assert.ok(box && firstBtn, 'disambiguation buttons rendered');
  assert.ok(box.dataset.disambigKey, 'box.dataset.disambigKey set');

  // Re-running parseInputElement with same ambiguous input/unit must keep identical DOM nodes (idempotent)
  const parsedAgain = window.DefterAmountCodec.parseInputElement(input, 'GRAM');
  assert.equal(parsedAgain, null);
  assert.equal(document.querySelector('[data-amount-choice]'), firstBtn, 'button node preserved by idempotency');

  // mousedown must call preventDefault() so real browser focus doesn't blur before click fires
  const mdEvent = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  firstBtn.dispatchEvent(mdEvent);
  assert.equal(mdEvent.defaultPrevented, true, 'mousedown on [data-amount-choice] calls preventDefault()');

  firstBtn.click();
  assert.equal(document.querySelector('[data-amount-choice]'), null, 'disambiguation box removed after choice click');
  assert.equal(document.querySelector('.amount-disambiguation'), null, '.amount-disambiguation removed');
  assert.ok(window.DefterAmountCodec.canonicalInputValue(input, 'GRAM'));
  dom.window.close();
});

// ============================================================================
// 2. Owner (/owner) Comboboxes, Turkish Search, #journal-search Debounce/Abort & R4 Lazy Returns
// ============================================================================
test('2. /owner Comboboxes (#f-counterpartyId, item accountId, #f-customerAccount, #journal-account), Turkish search & R4 lazy returns', async () => {
  const env = await createOwnerApp({ withSale: true, compact: true });
  const { window, document, repos } = env;
  try {
    // Comboboxes mounted on #f-counterpartyId and [data-item-field="accountId"]
    const cpSelect = document.querySelector('#f-counterpartyId');
    assert.ok(window.DefterCombobox.getInstance(cpSelect), '#f-counterpartyId enhanced with DefterCombobox');

    const itemSelect = document.querySelector('[data-item-field="accountId"]');
    const itemCb = window.DefterCombobox.getInstance(itemSelect);
    assert.ok(itemCb, '[data-item-field="accountId"] enhanced with DefterCombobox');
    assert.ok(document.querySelector('[data-product-search]'), '[data-product-search] preserved in sale mode when !editingCommand');

    // Turkish search folding in Combobox on #f-counterpartyId ('ismail' -> 'İSMAİL ŞAHİN')
    const cpCb = window.DefterCombobox.getInstance(cpSelect);
    cpCb.input.focus();
    cpCb.input.value = 'ismail';
    cpCb.input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await tick(20);
    const cpOptions = [...document.querySelectorAll('.defter-combobox-listbox [role="option"]')].map(el => el.textContent);
    assert.ok(cpOptions.some(t => /İSMAİL ŞAHİN/.test(t)), 'Turkish query "ismail" finds "İSMAİL ŞAHİN"');

    // Selecting product in sale mode via Combobox updates select and focuses quantity via microtask
    itemCb.input.focus();
    itemCb.input.value = 'sirma';
    itemCb.input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await tick(20);
    const sirmOpt = itemCb.input.closest('.defter-combobox')?.querySelector('.defter-combobox-listbox [role="option"]');
    assert.ok(sirmOpt && /SIRMA BİLEZİK/i.test(sirmOpt.textContent));
    sirmOpt.click();
    await tick(20);
    const sirmAcc = repos.demo.state().accounts.find(a => a.name.toLocaleUpperCase('tr-TR').startsWith('SIRMA'));
    assert.equal(itemSelect.value, sirmAcc.id);

    // Collection tab -> #f-customerAccount combobox
    document.querySelector('[data-tab="collection"]').click();
    await tick(20);
    assert.ok(window.DefterCombobox.getInstance(document.querySelector('#f-customerAccount')), '#f-customerAccount enhanced');

    // Summary Turkish search (#summary-search)
    document.querySelector('[data-view="summary"]').click();
    await tick(20);
    const sumSearch = document.querySelector('#summary-search');
    sumSearch.value = 'ismail';
    sumSearch.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.match(document.querySelector('#main').textContent, /İSMAİL ŞAHİN/);

    // Journal view: #journal-account combobox & R4 lazy <details data-sale-return> in detailed card view
    document.querySelector('[data-view="journal"]').click();
    await tick(30);
    assert.ok(window.DefterCombobox.getInstance(document.querySelector('#journal-account')), '#journal-account enhanced');
    document.querySelector('[data-journal-mode="detailed"]')?.click();
    await tick(20);

    const detailsEl = document.querySelector('details[data-sale-return]');
    assert.ok(detailsEl, 'sale journal entry renders details[data-sale-return]');
    assert.equal(document.querySelectorAll('.sale-return-form').length, 0, 'R4: 0 .sale-return-form before opening details');

    // Opening details lazily mounts .sale-return-form and enhances refundProduct combobox
    detailsEl.open = true;
    detailsEl.dispatchEvent(new window.Event('toggle'));
    await tick(20);
    const returnForm = detailsEl.querySelector('.sale-return-form');
    assert.ok(returnForm, 'R4: toggling details mounts .sale-return-form');
    assert.ok(
      window.DefterCombobox.getInstance(returnForm.querySelector('[name="refundProduct"]')),
      'refundProduct select enhanced with DefterCombobox'
    );

    // Journal draft auto-mounts .sale-return-form synchronously on render
    const saleId = returnForm.id.replace('return-form-', '');
    const qtyInput = returnForm.querySelector('[data-return-quantity]');
    qtyInput.value = '1';
    qtyInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    // Navigate away and back to journal
    document.querySelector('[data-view="overview"]').click();
    await tick(20);
    document.querySelector('[data-view="journal"]').click();
    await tick(50);
    const restoredForm = document.getElementById(`return-form-${saleId}`);
    assert.ok(restoredForm, 'R4: saved return-form-* draft auto-mounts synchronously on journal render');
    assert.equal(restoredForm.closest('details[data-sale-return]').open, true);
  } finally {
    env.close();
  }
});

test('3. /owner compact journal-search uses 180ms debounce, AbortController, aria-busy, and Enter immediate flush', async () => {
  const env = await createOwnerApp({
    url: 'http://127.0.0.1:4317/#v=journal',
    compact: true,
    withSale: true,
    journalDelayMs: 50
  });
  const { window, document, journalRequests } = env;
  try {
    const initialCount = journalRequests.length;
    const searchEl = document.querySelector('#journal-search');
    assert.ok(searchEl);

    // Rapid typing should not fire immediately (180ms debounce)
    searchEl.value = 'is';
    searchEl.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal(journalRequests.length, initialCount, 'debounce holds request immediately after input');

    // Second keystroke within debounce window resets timer and fires once
    await tick(80);
    searchEl.value = 'ismail';
    searchEl.dispatchEvent(new window.Event('input', { bubbles: true }));
    await tick(60);
    assert.equal(journalRequests.length, initialCount, 'debounce still waiting after 60ms of second keystroke');

    // Wait past 180ms debounce
    await tick(160);
    assert.equal(journalRequests.length, initialCount + 1, 'debounced search fires once after 180ms');
    assert.equal(journalRequests.at(-1).params.q, 'ismail');

    // Immediate flush on Enter aborts overlapping in-flight request
    searchEl.value = 'ceyrek';
    searchEl.dispatchEvent(new window.Event('input', { bubbles: true }));
    await tick(200); // fires in-flight request (50ms delay)
    const inflightReq = journalRequests.at(-1);
    searchEl.value = 'sirma';
    searchEl.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    assert.equal(inflightReq.aborted, true, 'previous in-flight journal request aborted when newer search flushes');
    await tick(80);
    assert.equal(document.querySelector('#journal-list').getAttribute('aria-busy'), 'false');
  } finally {
    env.close();
  }
});

// ============================================================================
// 4. Unified Hash Detail ID (#v=accounts|stocks|suppliers&id=...) & Invalid Fallback
// ============================================================================
test('4. Unified Hash Detail ID (#v=accounts|stocks|suppliers&id=...) F5 restore, popstate, and invalid ID fallback', async () => {
  const env1 = await createOwnerApp({ url: 'http://127.0.0.1:4317/#v=accounts' });
  let custId;
  let stockId;
  let firmId;
  try {
    const st = env1.repos.demo.state();
    custId = st.accounts.find(a => a.name === 'İSMAİL ŞAHİN').id;
    stockId = st.accounts.find(a => a.name.startsWith('SIRMA BİLEZİK')).id;
    firmId = st.supplierFirms.find(f => f.name === 'Çiğdem Toptan').id;

    // Select account -> hash updates to #v=accounts&id=<custId>
    const custBtn = env1.document.querySelector(`#account-list [data-account-detail="${custId}"]`);
    assert.ok(custBtn);
    custBtn.click();
    await tick(30);
    assert.equal(env1.window.location.hash, `#v=accounts&id=${encodeURIComponent(custId)}`);

    // Switch to stocks & select stock -> #v=stocks&id=<stockId>
    env1.document.querySelector('[data-view="stocks"]').click();
    await tick(20);
    const stockBtn = env1.document.querySelector(`#stock-list [data-account-detail="${stockId}"]`);
    assert.ok(stockBtn);
    stockBtn.click();
    await tick(30);
    assert.equal(env1.window.location.hash, `#v=stocks&id=${encodeURIComponent(stockId)}`);

    // Switch to suppliers & select firm -> #v=suppliers&id=<firmId>
    env1.document.querySelector('[data-view="suppliers"]').click();
    await tick(50);
    const firmBtn = env1.document.querySelector(`#main [data-open-firm="${firmId}"]`);
    assert.ok(firmBtn, 'firm button rendered in suppliers view');
    firmBtn.click();
    await tick(40);
    assert.equal(env1.window.location.hash, `#v=suppliers&id=${encodeURIComponent(firmId)}`);

    // popstate back to stocks&id=<stockId>
    env1.window.location.hash = `#v=stocks&id=${encodeURIComponent(stockId)}`;
    env1.window.dispatchEvent(new env1.window.HashChangeEvent('hashchange'));
    env1.window.dispatchEvent(new env1.window.PopStateEvent('popstate'));
    await tick(40);
    assert.ok(env1.document.querySelector('#stock-list'), 'stocks view rendered after popstate');
    assert.match(env1.document.querySelector('#account-detail').textContent, /SIRMA BİLEZİK 22A/);
  } finally {
    env1.close(true);
  }

  // F5 fresh load directly on #v=suppliers&id=<firmId>
  const envF5Sup = await createOwnerApp({
    url: `http://127.0.0.1:4317/#v=suppliers&id=${encodeURIComponent(firmId)}`,
    reposOverride: env1.repos
  });
  try {
    await tick(60);
    assert.ok(envF5Sup.document.querySelector('[data-supplier-list]') || envF5Sup.document.querySelector('[data-back-suppliers]'), 'suppliers view mounted on F5');
    assert.match(envF5Sup.document.querySelector('#main').textContent, /Çiğdem Toptan/);
  } finally {
    envF5Sup.close(true);
  }

  // Invalid ID degrades gracefully without throwing
  const envInvalid = await createOwnerApp({
    url: 'http://127.0.0.1:4317/#v=accounts&id=nonexistent-id-999',
    reposOverride: env1.repos
  });
  try {
    assert.ok(envInvalid.document.querySelector('#account-list'), 'accounts view mounted cleanly on invalid id');
    assert.equal(envInvalid.window.location.hash, '#v=accounts');
  } finally {
    envInvalid.close();
  }
});

// ============================================================================
// 5. /owner DefterCommandPalette (gates, nav, record jump, dirty draft confirm, zero auto-commit)
// ============================================================================
test('5. /owner DefterCommandPalette obeys initialization/nominal/busy gates, preserves drafts, and never auto-commits', async () => {
  // Uninitialized gate: palette is blocked when !state.initialized
  const uninitEnv = await createOwnerApp({ uninitialized: true });
  try {
    assert.equal(uninitEnv.window.DefterCommandPalette.isBlocked(), true, 'palette blocked when !state.initialized');
    assert.equal(uninitEnv.window.DefterCommandPalette.open(), false, 'palette refuses to open when !state.initialized');
  } finally {
    uninitEnv.close();
  }

  // Nominal unconfirmed gate: hides sale/purchase/quick-stock/closing and shows act-nominal-confirm
  const nomEnv = await createOwnerApp({
    stateMutator: st => ({ ...st, nominalUnconfirmed: true })
  });
  try {
    nomEnv.window.DefterCommandPalette.open();
    await tick(20);
    const opts = [...nomEnv.document.querySelectorAll('[data-command-palette-list] [role="option"]')].map(el => el.getAttribute('data-command-id'));
    assert.equal(opts.includes('act-sale'), false, 'act-sale hidden when nominalUnconfirmed');
    assert.equal(opts.includes('act-nominal-confirm'), true, 'act-nominal-confirm shown when nominalUnconfirmed');
    nomEnv.window.DefterCommandPalette.close();
  } finally {
    nomEnv.close();
  }

  // Normal initialized owner: Ctrl+K record jump & dirty draft preservation
  const env = await createOwnerApp();
  try {
    const { window, document, commands, repos } = env;
    assert.equal(window.DefterCommandPalette.isBlocked(), false);

    // Dirty note + palette navigation captures draft via captureDrafts() so returning preserves it
    const noteEl = document.querySelector('#f-note');
    noteEl.value = 'Korunan taslak notu';
    noteEl.dispatchEvent(new window.Event('input', { bubbles: true }));
    window.DefterCommandPalette.open();
    await tick(20);
    const navAccBtn = document.querySelector('[data-command-id="nav-accounts"]');
    assert.ok(navAccBtn);
    navAccBtn.click();
    await tick(30);
    assert.equal(window.location.hash, '#v=accounts');
    document.querySelector('[data-view="transaction"]').click();
    await tick(20);
    assert.equal(document.querySelector('#f-note').value, 'Korunan taslak notu', 'palette setView preserves dirty sale draft via captureDrafts');

    // Ctrl+K record jump navigates without auto-committing
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
    await tick(20);
    assert.equal(window.DefterCommandPalette.isOpen(), true, 'Ctrl+K opens owner command palette');

    const palInput = document.querySelector('[data-command-palette-input]');
    assert.ok(palInput);
    palInput.value = 'ismail';
    palInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    await tick(30);
    const items = [...document.querySelectorAll('[data-command-palette-list] [role="option"]')];
    const custItem = items.find(el => /İSMAİL ŞAHİN/.test(el.textContent));
    assert.ok(custItem, 'owner palette lists customer record for Turkish query "ismail"');
    custItem.click();
    await tick(40);
    const custId = repos.demo.state().accounts.find(a => a.name === 'İSMAİL ŞAHİN').id;
    assert.equal(window.location.hash, `#v=accounts&id=${encodeURIComponent(custId)}`);
    assert.equal(commands.length, 0, 'command palette never auto-commits financial commands');
  } finally {
    env.close();
  }
});

// ============================================================================
// 6. Suppliers 2000-item Combobox bounded DOM & cleanup
// ============================================================================
test('6. suppliers.js Combobox keeps <= 2 native <option>s on 2000-item catalog and <= 20 rendered listbox options', async () => {
  const env = await createOwnerApp({ url: 'http://127.0.0.1:4317/#v=suppliers' });
  const { window, document, repos } = env;
  const prevCb = globalThis.DefterCombobox;
  const prevNorm = globalThis.DefterSearchNorm;
  try {
    globalThis.DefterCombobox = window.DefterCombobox;
    globalThis.DefterSearchNorm = window.DefterSearchNorm;
    const { renderSupplierWorkspace } = await import('../public/suppliers.js');
    const host = document.createElement('section');
    document.body.appendChild(host);

    const manyItems = [];
    for (let i = 1; i <= 2000; i++) {
      manyItems.push({
        id: `stock-item-${i}`,
        name: `Toptan Ürün ${i}`,
        unit: 'GRAM',
        kind: 'asset',
        physical: true,
        isPurchasable: true,
        isSaleable: true,
        pairedGroups: [],
        retired: false
      });
    }
    const baseState = repos.demo.state();
    const firm = baseState.supplierFirms.find(f => f.name === 'Çiğdem Toptan');
    const firmUnit = baseState.accounts.find(a => a.partyType === 'supplier' && a.supplierId === firm.id);
    const customState = {
      ...baseState,
      accounts: [...baseState.accounts, ...manyItems],
      balances: { ...baseState.balances, ...Object.fromEntries(manyItems.map(x => [x.id, '10'])) },
      supplierParties: [{ ...firm, accounts: firmUnit ? [{ ...firmUnit, balance: baseState.balances[firmUnit.id] || 0 }] : [] }]
    };

    const handle = renderSupplierWorkspace(host, {
      state: customState,
      escape: s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
      format: (n, u) => `${n} ${u}`,
      day: d => String(d || ''),
      initialPartyId: firm.id,
      workspace: 'demo',
      execute: async () => ({})
    });
    handle.selectParty(firm.id, { task: 'purchase' });

    const rowSelect = host.querySelector('[data-field="accountId"]');
    assert.ok(rowSelect, 'supplier purchase row accountId select exists');
    const cb = window.DefterCombobox.getInstance(rowSelect);
    assert.ok(cb, 'supplier row select enhanced with DefterCombobox');
    assert.ok(rowSelect.options.length <= 2, `native <option> count (${rowSelect.options.length}) stays <= 2 on 2000 catalog`);

    cb.input.focus();
    cb.input.value = 'Toptan Ürün 19';
    cb.input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await tick(20);
    const renderedOpts = document.querySelectorAll('.defter-combobox-listbox [role="option"]');
    assert.ok(renderedOpts.length > 0 && renderedOpts.length <= 20, `rendered options (${renderedOpts.length}) bounded <= 20`);

    handle.destroy?.();
  } finally {
    globalThis.DefterCombobox = prevCb;
    globalThis.DefterSearchNorm = prevNorm;
    env.close();
  }
});

// ============================================================================
// 7. /checkout (Escalation #2 #search Combobox, Product Combobox, Quick-Fill Cash, Employee Palette + Static Check)
// ============================================================================
test('7. /checkout Combobox (#search preserves value, 0-stock disabled, quick-fill-cash) & Employee Palette strict isolation + 500 error', async () => {
  // Static check: zero forbidden owner substrings anywhere in checkout.js
  const forbiddenOwnerStrings = [
    'data-create-stock', 'stockAccount', 'stockUpdate', 'registerItem',
    'fundAccount', 'costTL', 'orderSettlement', 'supplierFirm',
    '/api/state', '/api/journal', '/api/suppliers', '/api/backup'
  ];
  for (const s of forbiddenOwnerStrings) {
    assert.equal(checkoutSource.includes(s), false, `checkout.js must not contain forbidden owner string "${s}"`);
  }

  const env = await createEmployeeCheckout({ withManyItems: true });
  const { window, document, repo, calls, customerRequests } = env;
  try {
    // Customer Combobox bound directly on #search; #customer select hidden via wrapper label
    const searchEl = document.querySelector('#search');
    const customerSelect = document.querySelector('#customer');
    assert.ok(window.DefterCombobox.getInstance(searchEl), '#search has DefterCombobox instance');
    assert.equal(customerSelect.closest('label').hidden, true, '#customer wrapper label hidden when Combobox active');

    // Typing 'ismail' in #search queries /api/customers?q=ismail&...&meta=1 and preserves searchEl.value
    searchEl.focus();
    searchEl.value = 'ismail';
    searchEl.dispatchEvent(new window.Event('input', { bubbles: true }));
    await tick(250);
    assert.ok(customerRequests.some(r => r.q === 'ismail' && r.meta === '1'), 'debounced /api/customers?q=ismail&meta=1 called');
    assert.equal(searchEl.value, 'ismail', 'Escalation #2: #search.value is NOT cleared during lookupCustomer');

    const custOpt = document.querySelector('.defter-combobox-listbox [role="option"]');
    assert.ok(custOpt && /İSMAİL ŞAHİN/.test(custOpt.textContent));
    custOpt.click();
    await tick(40);
    const custAcc = repo.state().accounts.find(a => a.name === 'İSMAİL ŞAHİN');
    assert.equal(customerSelect.value, custAcc.id);
    assert.match(document.querySelector('#summary-customer').textContent, /İSMAİL ŞAHİN/);

    // Product Combobox: bounded <select>, 0-stock disabled in sale mode, Enter focuses [data-quantity]
    const prodSelect = document.querySelector('[data-product]');
    const prodSearch = document.querySelector('[data-product-search]');
    assert.ok(window.DefterCombobox.getInstance(prodSearch), '[data-product-search] wrapped with DefterCombobox');
    assert.ok(prodSelect.options.length <= 2, `checkout native <option> count (${prodSelect.options.length}) <= 2 on >50 catalog`);

    // Blind-count protection: workerCountCatalog items mask stock count so 0-stock is not leaked via aria-disabled
    prodSearch.focus();
    prodSearch.value = 'tukenen';
    prodSearch.dispatchEvent(new window.Event('input', { bubbles: true }));
    await tick(20);
    const prodRoot = prodSearch.closest('.defter-combobox');
    const zeroOpt = prodRoot?.querySelector('.defter-combobox-listbox [role="option"]');
    assert.ok(zeroOpt && /TÜKENEN YÜZÜK/i.test(zeroOpt.textContent));
    assert.equal(zeroOpt.getAttribute('aria-disabled'), null, 'blind-count item does not leak 0-stock via aria-disabled');

    // Select active item via Enter -> focuses [data-quantity] synchronously
    prodSearch.value = 'sirma';
    prodSearch.dispatchEvent(new window.Event('input', { bubbles: true }));
    await tick(20);
    prodSearch.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    assert.equal(document.activeElement, document.querySelector('[data-quantity]'), 'Enter selection moves focus to [data-quantity]');

    // #received starts with 0 rows on startup; quick-fill-cash adds Nakit row matching item total
    assert.equal(document.querySelectorAll('#received [data-allocation]').length, 0, '#received starts with 0 rows');
    const qtyInput = document.querySelector('[data-quantity]');
    qtyInput.value = '1';
    qtyInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    const valInput = document.querySelector('[data-value]');
    valInput.value = '3500';
    valInput.dispatchEvent(new window.Event('input', { bubbles: true }));

    const quickFillBtn = document.querySelector('[data-quick-fill-cash]');
    assert.ok(quickFillBtn, '[data-quick-fill-cash] button rendered dynamically');
    quickFillBtn.click();
    assert.equal(document.querySelectorAll('#received [data-allocation]').length, 1, 'quick-fill creates 1 Nakit allocation row');
    assert.equal(document.querySelector('#received [data-account]').value, 'nakit');
    assert.equal(document.querySelector('#received [data-quantity]').value, '3.500,00');
    assert.equal(document.querySelector('#received [data-value]').value, '3.500,00');
    assert.equal(calls.length, 0, 'quick-fill does not auto-submit trade');

    // 2-stage #record -> #review -> #confirm still required; while in review, palette is safely blocked
    document.querySelector('#record').click();
    assert.equal(document.querySelector('#review').hidden, false);
    assert.equal(calls.length, 0);
    assert.equal(window.DefterCommandPalette.isBlocked(), true, 'palette blocked during review');

    // Return to editing (#cancel-review / input change clears review) and open Employee Command Palette via Ctrl+K
    document.querySelector('#note').value = 'Tezgâh inceleme sonrası';
    document.querySelector('#note').dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal(document.querySelector('#review').hidden, true);
    assert.equal(window.DefterCommandPalette.isBlocked(), false);
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
    await tick(20);
    assert.equal(window.DefterCommandPalette.isOpen(), true);
    const palInput = document.querySelector('[data-command-palette-input]');
    palInput.value = 'ismail';
    palInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    await tick(220);
    const palOpts = [...document.querySelectorAll('[data-command-palette-list] [role="option"]')];
    assert.ok(palOpts.some(el => /İSMAİL ŞAHİN/.test(el.textContent)), 'employee palette async customer search finds İSMAİL ŞAHİN');
    window.DefterCommandPalette.close();
  } finally {
    env.close();
  }

  // HTTP 500 on /api/customers surfaces [data-command-palette-error]
  const errEnv = await createEmployeeCheckout({ failCustomers500: true });
  try {
    errEnv.document.dispatchEvent(new errEnv.window.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
    await tick(20);
    const palInput = errEnv.document.querySelector('[data-command-palette-input]');
    palInput.value = 'ismail';
    palInput.dispatchEvent(new errEnv.window.Event('input', { bubbles: true }));
    await tick(220);
    const errEl = errEnv.document.querySelector('[data-command-palette-error]');
    assert.ok(errEl && !errEl.hidden && errEl.textContent.trim().length > 0, '500 /api/customers displays [data-command-palette-error]');
  } finally {
    errEnv.close();
  }
});

// ============================================================================
// 8. Regression: suppliers.js document task draft restore (return, offset, legacyLink)
// ============================================================================
test('8. suppliers.js preserves originalId, fromAccountId, toAccountId and mounts dependent fields on draft restore', async () => {
  const env = await createOwnerApp({ url: 'http://127.0.0.1:4317/#v=suppliers' });
  const { window, document, repos } = env;
  const prevCb = globalThis.DefterCombobox;
  const prevNorm = globalThis.DefterSearchNorm;
  const prevDraftStore = globalThis.DefterDraftStore;
  try {
    globalThis.DefterCombobox = window.DefterCombobox;
    globalThis.DefterSearchNorm = window.DefterSearchNorm;
    globalThis.DefterDraftStore = window.DefterDraftStore;
    const { renderSupplierWorkspace } = await import('../public/suppliers.js');

    const baseState = repos.demo.state();
    const firm = baseState.supplierFirms.find(f => f.name === 'Çiğdem Toptan');
    const supHas = baseState.accounts.find(a => a.partyType === 'supplier' && a.supplierId === firm.id && a.unit === 'HAS');
    const supTl = { id: 'sup-tl-unit-1', name: 'Çiğdem Toptan · TL', unit: 'TL', kind: 'receivable', partyType: 'supplier', supplierId: firm.id, parentAccountId: firm.id };
    const bilezik = baseState.accounts.find(a => a.id === 'bilezik22');
    assert.ok(firm && supHas && bilezik);

    const firmAccounts = [
      { id: supHas.id, name: supHas.name, unit: 'HAS', balance: 5000 },
      { id: supTl.id, name: supTl.name, unit: 'TL', balance: -100000 }
    ];
    const customState = {
      ...baseState,
      accounts: [...baseState.accounts, supTl],
      balances: { ...baseState.balances, [supHas.id]: 5000, [supTl.id]: -100000 },
      supplierParties: [{ ...firm, accounts: firmAccounts }]
    };

    const mockDocuments = {
      purchases: [{
        id: 'pur-1',
        kind: 'supplierPurchase',
        date: baseState.date,
        agreementId: '',
        note: 'Alış 1',
        lines: [{ lineIndex: 0, accountId: bilezik.id, unit: bilezik.unit, remainingQuantity: 10000, weightAccount: '', remainingWeight: 0 }],
        charges: [{ accountId: supTl.id, unit: 'TL', remaining: 100000 }]
      }],
      sources: [{
        id: 'pay-1',
        kind: 'supplierPayment',
        date: baseState.date,
        advanceScope: 'general',
        agreementId: '',
        note: 'Avans 1',
        credits: [{ accountId: supHas.id, unit: 'HAS', remaining: 5000 }]
      }],
      unresolvedReceipts: [{
        id: 'rec-1',
        date: baseState.date,
        note: 'Eski tahsilat',
        debts: [{ accountId: supTl.id, unit: 'TL', quantity: 50000 }],
        sources: [{
          id: 'pay-1',
          date: baseState.date,
          note: 'Avans 1',
          credits: [{ accountId: supHas.id, unit: 'HAS', remaining: 5000 }]
        }]
      }]
    };

    const requestMock = async () => ({
      revision: customState.revision,
      supplier: firm,
      accounts: firmAccounts,
      documents: mockDocuments,
      statements: [],
      events: [],
      total: 0
    });

    const saveDraftFor = (kind, data) => {
      const key = window.DefterDraftStore.makeKey({
        actorId: '00000000-0000-4000-8000-000000000001',
        workspace: 'demo',
        scope: 'supplier',
        type: kind,
        entityId: firm.id
      });
      window.DefterDraftStore.saveDraft(key, {
        meta: {
          actorId: '00000000-0000-4000-8000-000000000001',
          workspace: 'demo',
          workday: customState.date,
          revision: customState.revision,
          formId: kind,
          entityId: firm.id
        },
        data
      });
    };

    saveDraftFor('return', {
      fields: { originalId: 'pur-1', 'returnQty-0': '2', note: 'iade taslağı' },
      arrays: { credits: [], received: [] },
      targets: [],
      links: [],
      stamp: { revision: customState.revision, date: customState.date }
    });
    saveDraftFor('offset', {
      fields: { fromAccountId: supHas.id, toAccountId: supTl.id, fromQuantity: '1', toQuantity: '100', note: 'mahsup taslağı' },
      arrays: {},
      targets: [{ purchaseId: 'pur-1', quantity: '100', overrideReserved: false, reason: '' }],
      links: [],
      stamp: { revision: customState.revision, date: customState.date }
    });
    saveDraftFor('legacyLink', {
      fields: { originalId: 'rec-1', note: 'eski tahsilat taslağı' },
      arrays: { legacyUses: [{ source: JSON.stringify(['pay-1', supHas.id]), quantity: '1' }] },
      targets: [],
      links: [],
      stamp: { revision: customState.revision, date: customState.date }
    });

    const host = document.createElement('section');
    document.body.appendChild(host);
    const handle = renderSupplierWorkspace(host, {
      state: customState,
      actorId: '00000000-0000-4000-8000-000000000001',
      escape: s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
      format: (n, u) => `${n} ${u}`,
      day: d => String(d || ''),
      initialPartyId: firm.id,
      workspace: 'demo',
      request: requestMock,
      submit: async () => true
    });

    // 1) return draft restore
    handle.selectParty(firm.id, { task: 'return' });
    await tick(40);
    const returnForm = host.querySelector('[data-supplier-document-form="return"]');
    assert.ok(returnForm, 'return form mounted');
    assert.equal(returnForm.elements.originalId.value, 'pur-1', 'return originalId select restored');
    assert.equal(window.DefterCombobox.getInstance(returnForm.elements.originalId)?.getValue(), 'pur-1', 'return originalId combobox restored');
    const returnQty0 = returnForm.querySelector('[name="returnQty-0"]');
    assert.ok(returnQty0, 'returnQty-0 input mounted from restored originalId');
    assert.equal(returnQty0.value, '2', 'returnQty-0 restored value preserved');

    // 2) offset draft restore
    handle.selectParty(firm.id, { task: 'offset' });
    await tick(40);
    const offsetForm = host.querySelector('[data-supplier-document-form="offset"]');
    assert.ok(offsetForm, 'offset form mounted');
    assert.equal(offsetForm.elements.fromAccountId.value, supHas.id, 'offset fromAccountId select restored');
    assert.equal(offsetForm.elements.toAccountId.value, supTl.id, 'offset toAccountId select restored');
    assert.equal(window.DefterCombobox.getInstance(offsetForm.elements.fromAccountId)?.getValue(), supHas.id, 'offset fromAccountId combobox restored');
    assert.equal(window.DefterCombobox.getInstance(offsetForm.elements.toAccountId)?.getValue(), supTl.id, 'offset toAccountId combobox restored');
    const targetPurchase = offsetForm.querySelector('[data-target-field="purchaseId"]');
    assert.ok(targetPurchase, 'offset target purchase row mounted');
    assert.equal(targetPurchase.value, 'pur-1', 'offset target purchaseId restored using restored toAccountId');

    // 3) legacyLink draft restore
    handle.selectParty(firm.id, { task: 'legacyLink' });
    await tick(40);
    const legacyForm = host.querySelector('[data-supplier-document-form="legacyLink"]');
    assert.ok(legacyForm, 'legacyLink form mounted');
    assert.equal(legacyForm.elements.originalId.value, 'rec-1', 'legacyLink originalId select restored');
    assert.equal(window.DefterCombobox.getInstance(legacyForm.elements.originalId)?.getValue(), 'rec-1', 'legacyLink originalId combobox restored');
    assert.match(legacyForm.querySelector('[data-legacy-amounts]').textContent, /Eşleştirilecek:/, 'legacy amounts rendered for restored receipt');
    const legacySrc = legacyForm.querySelector('[data-legacy-rows] [data-field="source"]');
    assert.ok(legacySrc, 'legacy source row restored');
    assert.equal(legacySrc.value, JSON.stringify(['pay-1', supHas.id]), 'legacy source selection restored');

    handle.destroy?.();
  } finally {
    globalThis.DefterCombobox = prevCb;
    globalThis.DefterSearchNorm = prevNorm;
    globalThis.DefterDraftStore = prevDraftStore;
    env.close();
  }
});

// ============================================================================
// 9. Regression: /checkout Enter selection focuses [data-value] on serial and [data-quantity] on normal
// ============================================================================
test('9. /checkout product Combobox Enter focuses [data-value] for serial items and [data-quantity] for normal items', async () => {
  const repo = seedRepo('demo');
  repo.execute({
    id: randomUUID(),
    revision: repo.state().revision,
    command: {
      type: 'registerItem',
      date: '2026-11-10',
      code: 'SN-1',
      accountId: 'ceyrek'
    }
  });
  const env = await createEmployeeCheckout({ repoOverride: repo });
  const { window, document } = env;
  try {
    const row = document.querySelector('#items [data-item]');
    assert.ok(row, 'initial checkout item row exists');
    const prodSelect = row.querySelector('[data-product]');
    const prodSearch = row.querySelector('[data-product-search]');
    const qtyInput = row.querySelector('[data-quantity]');
    const valInput = row.querySelector('[data-value]');
    assert.equal(qtyInput.readOnly, false, 'normal product starts with editable quantity');

    // Switch normal -> serial:SN-1 via keyboard Enter
    prodSearch.focus();
    prodSearch.value = 'SN-1';
    prodSearch.dispatchEvent(new window.Event('input', { bubbles: true }));
    await tick(20);
    prodSearch.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    assert.equal(prodSelect.value, 'serial:SN-1', 'serial item committed to [data-product]');
    assert.equal(qtyInput.readOnly, true, 'serial item marks [data-quantity] readOnly');
    assert.equal(document.activeElement, valInput, 'Enter on serial item focuses [data-value] synchronously (not readOnly [data-quantity])');

    // Switch serial:SN-1 -> normal product via keyboard Enter
    prodSearch.focus();
    prodSearch.value = 'sirma';
    prodSearch.dispatchEvent(new window.Event('input', { bubbles: true }));
    await tick(20);
    prodSearch.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    const sirmaAcc = repo.state().accounts.find(a => a.name.toLocaleUpperCase('tr-TR').startsWith('SIRMA'));
    assert.equal(prodSelect.value, sirmaAcc.id, 'normal item committed to [data-product]');
    assert.equal(qtyInput.readOnly, false, 'normal item clears readOnly on [data-quantity]');
    assert.equal(document.activeElement, qtyInput, 'Enter on normal item after serial focuses [data-quantity] synchronously');
  } finally {
    env.close();
  }
});
