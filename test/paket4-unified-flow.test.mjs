import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadJSDOM } from '../test-support/jsdom.mjs';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS } from '../domain.mjs';
import { checkoutState } from '../editor-access.mjs';

const JSDOM = await loadJSDOM();
const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const checkoutHtml = readFileSync(new URL('../public/checkout.html', import.meta.url), 'utf8');
const stylesCss = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const accessCss = readFileSync(new URL('../public/access.css', import.meta.url), 'utf8');
const draftStoreSource = readFileSync(new URL('../public/draft-store.js', import.meta.url), 'utf8');
const uiKitSource = readFileSync(new URL('../public/ui-kit.js', import.meta.url), 'utf8');
const accessClientSource = readFileSync(new URL('../public/access-client.js', import.meta.url), 'utf8');
const amountCodecSource = readFileSync(new URL('../public/amount-codec.js', import.meta.url), 'utf8');
const dateFormatSource = readFileSync(new URL('../public/date-format.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const checkoutSource = readFileSync(new URL('../public/checkout.js', import.meta.url), 'utf8');

const tick = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));

function seedRepo(workspace = 'demo', { withCustomerOrder = false, withForeignFund = false } = {}) {
  const repo = new Repository(':memory:', workspace);
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
  repo.execute({
    id: randomUUID(),
    revision: repo.state().revision,
    command: {
      type: 'account',
      date: '2026-11-10',
      name: 'Ayşe Müşteri',
      unit: 'TL',
      opening: '1000',
      partyType: 'customer',
      phone: '05551112233'
    }
  });
  if (withForeignFund) {
    repo.execute({
      id: randomUUID(),
      revision: repo.state().revision,
      command: { type: 'fundAccount', date: '2026-11-10', name: 'HAS Kasası', unit: 'HAS', physical: true, opening: '10' }
    });
  }
  if (withCustomerOrder) {
    const custId = repo.state().accounts.find(a => a.name === 'Ayşe Müşteri').id;
    repo.execute({
      id: randomUUID(),
      revision: repo.state().revision,
      command: { type: 'customerOrder', date: '2026-11-10', customerId: custId, description: 'Özel Bilezik Siparişi' }
    });
    const orderId = repo.state().customerOrders[0].id;
    repo.execute({
      id: randomUUID(),
      revision: repo.state().revision,
      command: { type: 'orderAdvance', date: '2026-11-10', orderId, accountId: 'nakit', amountTL: '2000' }
    });
  }
  return repo;
}

async function createOwnerApp({
  url = 'http://127.0.0.1:4317/#v=transaction',
  failControl = { mode: 'ok' },
  withUiKit = true,
  seededStorage = null,
  reposOverride = null,
  withCustomerOrder = false,
  withForeignFund = false
} = {}) {
  const ownerActor = { id: '00000000-0000-4000-8000-000000000001', name: 'Patron', role: 'owner' };
  const repos = reposOverride || {
    demo: seedRepo('demo', { withCustomerOrder, withForeignFund }),
    dukkan: seedRepo('dukkan')
  };
  const dom = new JSDOM(indexHtml, { url, runScripts: 'outside-only' });
  const { window } = dom;
  const { document } = window;
  window.localStorage.setItem('defter-workspace', 'demo');
  Object.defineProperty(window.crypto, 'randomUUID', { value: randomUUID });
  window.HTMLElement.prototype.scrollIntoView = () => {};

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
    finishRestore: () => {},
    api: async () => ({})
  };

  window.fetch = async (reqUrl, init = {}) => {
    const parsed = new URL(String(reqUrl), 'http://127.0.0.1:4317');
    const ws = parsed.searchParams.get('workspace') || 'demo';
    const repo = repos[ws];
    if (parsed.pathname === '/api/state') {
      if (typeof failControl.waitState === 'function') {
        await failControl.waitState();
      }
      return { ok: true, status: 200, json: async () => repo.state() };
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
    if (parsed.pathname === '/api/customers') {
      return { ok: true, status: 200, json: async () => [] };
    }
    if (parsed.pathname === '/api/command') {
      const env = JSON.parse(init.body || '{}');
      commands.push(env);
      if (failControl.mode === 'network-after-commit') {
        failControl.mode = 'ok';
        repo.execute(env, { version: 1, actor: ownerActor });
        throw new Error('Failed to fetch');
      }
      if (failControl.mode === '503') {
        failControl.mode = 'ok';
        return { ok: false, status: 503, json: async () => ({ error: 'Sunucu geçici olarak meşgul.' }) };
      }
      try {
        return { ok: true, status: 200, json: async () => repo.execute(env, { version: 1, actor: ownerActor }) };
      } catch (err) {
        return { ok: false, status: err.status || 400, json: async () => ({ error: err.message }) };
      }
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  window.eval(draftStoreSource);
  if (withUiKit) window.eval(uiKitSource);
  window.eval(amountCodecSource);
  window.eval(dateFormatSource);
  window.eval(appSource);
  await tick(40);
  await tick(40);

  const setVal = (elOrSel, value) => {
    const el = typeof elOrSel === 'string' ? document.querySelector(elOrSel) : elOrSel;
    assert.ok(el, `Element not found: ${elOrSel}`);
    el.value = value;
    el.dispatchEvent(new window.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  };

  return {
    dom,
    window,
    document,
    repos,
    commands,
    setVal,
    snapshotStorage: () => Object.fromEntries(
      Object.keys(window.sessionStorage).map(k => [k, window.sessionStorage.getItem(k)])
    ),
    close: (keepRepos = false) => {
      window.close();
      if (!keepRepos) {
        repos.demo.close();
        repos.dukkan.close();
      }
    }
  };
}

async function createEmployeeCheckout({
  withUiKit = true,
  failControl = { mode: 'ok' },
  seededStorage = null,
  repoOverride = null
} = {}) {
  const empActor = { id: '00000000-0000-4000-8000-000000000002', name: 'Tezgâh Çalışanı', role: 'employee' };
  const repo = repoOverride || seedRepo('demo', { withForeignFund: true });
  const dom = new JSDOM(checkoutHtml, { url: 'http://127.0.0.1:4317/checkout', runScripts: 'outside-only' });
  const { window } = dom;
  const { document } = window;
  if (document.getElementById('workspace')) document.getElementById('workspace').value = 'demo';
  Object.defineProperty(window.crypto, 'randomUUID', { value: randomUUID });
  window.HTMLElement.prototype.scrollIntoView = () => {};

  if (seededStorage) {
    for (const [k, v] of Object.entries(seededStorage)) {
      window.sessionStorage.setItem(k, v);
    }
  }
  window.sessionStorage.setItem('defter-session', JSON.stringify({
    actor: empActor,
    token: 'emp-tok',
    expiresAt: Date.now() + 3600_000
  }));

  const calls = [];
  const fetchPaths = [];
  window.fetch = async (reqUrl, init = {}) => {
    const parsed = new URL(String(reqUrl), 'http://127.0.0.1:4317');
    fetchPaths.push(parsed.pathname);
    if (parsed.pathname === '/api/auth/session') {
      return { ok: true, status: 200, json: async () => empActor };
    }
    if (parsed.pathname === '/api/checkout') {
      return { ok: true, status: 200, json: async () => checkoutState(repo.state({ compact: true })) };
    }
    if (parsed.pathname === '/api/customers') {
      const id = parsed.searchParams.get('id');
      const q = (parsed.searchParams.get('q') || '').toLocaleLowerCase('tr-TR');
      const st = repo.state({ compact: true });
      const custs = st.accounts.filter(a => a.kind === 'receivable' && (a.partyType || 'customer') === 'customer' && !a.retired);
      if (id) {
        const acc = custs.find(a => a.id === id);
        if (!acc) return { ok: false, status: 404, json: async () => ({ error: 'Bulunamadı' }) };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: acc.id,
            name: acc.name,
            accounts: [{ id: acc.id, name: acc.name, unit: acc.unit, balance: st.balances[acc.id] || 0 }]
          })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => custs
          .filter(a => !q || a.name.toLocaleLowerCase('tr-TR').includes(q))
          .map(a => ({ id: a.id, name: a.name, unit: a.unit }))
      };
    }
    if (parsed.pathname === '/api/pending-approvals') {
      if ((init.method || 'GET').toUpperCase() === 'GET') {
        return { ok: true, status: 200, json: async () => ({ items: repo.listPending({ status: 'all', submittedById: empActor.id }) }) };
      }
      const body = JSON.parse(init.body || '{}');
      calls.push(body);
      if (failControl.mode === '503') {
        failControl.mode = 'ok';
        return { ok: false, status: 503, json: async () => ({ error: 'Sunucu meşgul' }) };
      }
      try {
        const res = repo.submitPending(body, { actor: empActor });
        return { ok: true, status: 201, json: async () => res };
      } catch (err) {
        return { ok: false, status: err.status || 400, json: async () => ({ error: err.message }) };
      }
    }
    if (parsed.pathname === '/api/command') {
      const body = JSON.parse(init.body || '{}');
      calls.push(body);
      if (failControl.mode === '503') {
        failControl.mode = 'ok';
        return { ok: false, status: 503, json: async () => ({ error: 'Sunucu meşgul' }) };
      }
      try {
        const res = repo.execute(body, { version: 1, actor: empActor });
        const createdAcc = body.command?.type === 'account'
          ? res.state.accounts.find(a => a.id === 'cari-' + body.id)
          : null;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: body.id,
            revision: res.state.revision,
            duplicate: res.duplicate,
            ...(createdAcc && { account: { id: createdAcc.id, name: createdAcc.name, unit: createdAcc.unit } })
          })
        };
      } catch (err) {
        return { ok: false, status: err.status || 400, json: async () => ({ error: err.message }) };
      }
    }
    return { ok: false, status: 403, json: async () => ({ error: 'Yetkisiz uç: ' + parsed.pathname }) };
  };

  window.eval(amountCodecSource);
  window.eval(dateFormatSource);
  if (withUiKit) window.eval(uiKitSource);
  window.eval(accessClientSource);
  window.eval(draftStoreSource);
  window.eval(checkoutSource);
  await tick(40);
  await tick(40);

  const setVal = (elOrSel, value) => {
    const el = typeof elOrSel === 'string' ? document.querySelector(elOrSel) : elOrSel;
    assert.ok(el, `Element not found: ${elOrSel}`);
    el.value = value;
    el.dispatchEvent(new window.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  };

  return {
    dom,
    window,
    document,
    repo,
    calls,
    fetchPaths,
    setVal,
    snapshotStorage: () => Object.fromEntries(
      Object.keys(window.sessionStorage).map(k => [k, window.sessionStorage.getItem(k)])
    ),
    close: (keepRepo = false) => {
      window.close();
      if (!keepRepo) repo.close();
    }
  };
}

// ============================================================================
// Group A: Owner Adaptive Trade Flow
// ============================================================================

test('Paket4 A1: Owner retail sale & purchase start in Quick Mode and quick-fill cash posts clean command', async () => {
  const env = await createOwnerApp();
  const { document, commands, setVal, repos } = env;
  try {
    for (const tab of ['sale', 'purchase']) {
      document.querySelector(`[data-tab="${tab}"]`).click();
      await tick(10);
      const form = document.querySelector('#sale-form');
      assert.equal(form.dataset.flowMode, 'quick');
      assert.equal(form.classList.contains('flow-quick'), true);
      assert.equal(form.classList.contains('stepper-active'), false);
      assert.equal(document.querySelector('#transaction-content > .subtitle').textContent, 'Miktarı kendi biriminde, anlaşılmış bedeli TL olarak girin.');
      assert.equal(document.querySelectorAll('.trade-primary > .context-note, .trade-opposite > .context-note').length, 0);
      assert.equal(document.querySelector('[data-flow-badge]').textContent, 'Hızlı Mod');
      assert.equal(document.querySelectorAll('[data-allocation-kind]').length, 0);
    }

    document.querySelector('[data-tab="sale"]').click();
    await tick(10);
    setVal('[data-item-field="accountId"]', 'ceyrek');
    setVal('[data-item-field="quantity"]', '1');
    setVal('[data-item-field="value"]', '5000');

    const quickFill = document.querySelector('[data-quick-fill-cash]');
    assert.equal(quickFill.hidden, false, 'Quick-fill cash button must appear when total > 0 and no payment rows');
    quickFill.click();
    await tick(10);
    assert.equal(document.querySelector('[data-allocation-kind="payment"] [data-allocation-field="quantity"]').value, '5000.00');
    assert.equal(document.querySelector('#sale-form button[type="submit"]').dataset.balanced, 'true');

    document.querySelector('#sale-form').dispatchEvent(new env.window.Event('submit', { bubbles: true, cancelable: true }));
    await tick(40);
    assert.equal(commands.length, 1);
    assert.deepEqual(commands[0].command.received, [{ accountId: 'nakit', quantity: '5000.00', valueTL: '5000.00' }]);
    assert.equal(repos.demo.state().balances.nakit, 5500000);
  } finally {
    env.close();
  }
});

test('Paket4 A2: Owner Quick -> Guided escalation on complexity preserves draft and validates steps', async () => {
  const env = await createOwnerApp({ withForeignFund: true });
  const { window, document, setVal } = env;
  try {
    const custId = [...document.querySelector('#f-counterpartyId').options].find(o => o.value).value;
    setVal('#f-counterpartyId', custId);
    setVal('[data-item-field="accountId"]', 'ceyrek');
    setVal('[data-item-field="quantity"]', '1');
    setVal('[data-item-field="value"]', '5000');
    document.querySelector('[data-payment-type="cash"]').click();
    setVal('[data-allocation-kind="payment"] [data-allocation-field="quantity"]', '2000');
    setVal('#f-note', 'Karma escalation notu');

    assert.equal(document.querySelector('#sale-form').dataset.flowMode, 'quick');

    // Trigger escalation via scrap
    document.querySelector('[data-add-allocation="scrap"]').click();
    await tick(10);
    const form = document.querySelector('#sale-form');
    assert.equal(form.dataset.flowMode, 'guided');
    assert.equal(form.classList.contains('stepper-active'), true);
    assert.equal(document.querySelector('[data-flow-toggle]').disabled, true);
    assert.equal(document.querySelector('[data-flow-reason]').hidden, false);
    assert.match(document.querySelector('[data-flow-reason]').textContent, /hurda/i);

    // Draft values preserved
    assert.equal(document.querySelector('#f-counterpartyId').value, custId);
    assert.equal(document.querySelector('[data-item-field="value"]').value, '5000');
    assert.equal(document.querySelector('[data-allocation-kind="payment"] [data-allocation-field="quantity"]').value, '2000');
    assert.equal(document.querySelector('#f-note').value, 'Karma escalation notu');

    // Step 2 currently active; clicking Step 3 tab validates required scrap fields and stays on Step 2
    assert.equal(document.querySelector('[data-step-panel="2"]').classList.contains('is-active'), true);
    document.querySelector('[data-step-target="3"]').click();
    assert.equal(document.querySelector('[data-step-panel="2"]').classList.contains('is-active'), true, 'Invalid Step 2 must block advancing to Step 3');

    // Hazard 3: adding debt with empty counterpartyId focuses #f-counterpartyId and reveals Step 1
    setVal('#f-counterpartyId', '');
    document.querySelector('[data-add-allocation="debt"]').click();
    assert.equal(document.querySelector('[data-step-panel="1"]').classList.contains('is-active'), true);
    assert.equal(document.activeElement.id, 'f-counterpartyId');

    // Hazard 4: adding 2nd item keeps Step 1 active and focuses new select
    document.querySelector('#add-sale-item').click();
    const items = document.querySelectorAll('.sale-item');
    assert.equal(items.length, 2);
    assert.equal(document.querySelector('[data-step-panel="1"]').classList.contains('is-active'), true);
    assert.equal(document.activeElement, items[1].querySelector('[data-item-field="accountId"]'));

    // HAS / non-TL payment also escalates Quick -> Guided Step 2
    document.querySelector('[data-clear-draft]').click();
    await tick(20);
    assert.equal(document.querySelector('#sale-form').dataset.flowMode, 'quick');
    document.querySelector('[data-payment-type="has"]').click();
    await tick(10);
    assert.equal(document.querySelector('#sale-form').dataset.flowMode, 'guided');
    assert.equal(document.querySelector('[data-step-panel="2"]').classList.contains('is-active'), true);
    assert.match(document.querySelector('[data-flow-reason]').textContent, /TL dışı ödeme/i);
  } finally {
    env.close();
  }
});

test('Paket4 A3: Manual mode toggle clean-draft safety and DefterDraftStore F5 persistence', async () => {
  const env1 = await createOwnerApp();
  let storageSnap;
  try {
    const form = env1.document.querySelector('#sale-form');
    assert.equal(form.dataset.draftDirty, 'false');

    // Toggling on clean form must NOT set draftDirty or save a draft
    env1.document.querySelector('[data-flow-toggle]').click();
    assert.equal(form.dataset.flowMode, 'guided');
    assert.equal(form.dataset.draftDirty, 'false');
    assert.equal(env1.window.DefterDraftStore.listDrafts({ workspace: 'demo' }).length, 0);

    // Dirty the form (select non-paired item so Step 1 is valid) and move to Step 2
    env1.setVal('[data-item-field="accountId"]', 'ceyrek');
    env1.setVal('[data-item-field="value"]', '3500');
    env1.setVal('#f-note', 'F5 Guided Draft');
    env1.document.querySelector('[data-step-target="2"]').click();
    assert.equal(env1.document.querySelector('[data-step-panel="2"]').classList.contains('is-active'), true);
    env1.window.dispatchEvent(new env1.window.Event('beforeunload'));
    storageSnap = env1.snapshotStorage();
  } finally {
    env1.close(true);
  }

  // F5 simulation with same repos & sessionStorage
  const env2 = await createOwnerApp({ seededStorage: storageSnap, reposOverride: env1.repos });
  let env2Closed = false;
  try {
    const form = env2.document.querySelector('#sale-form');
    assert.equal(form.dataset.flowMode, 'guided');
    assert.equal(form.classList.contains('stepper-active'), true);
    assert.equal(env2.document.querySelector('[data-step-panel="2"]').classList.contains('is-active'), true);
    assert.equal(env2.document.querySelector('[data-item-field="value"]').value, '3500');
    assert.equal(env2.document.querySelector('#f-note').value, 'F5 Guided Draft');

    // Clear draft -> resets to Quick Mode, clean
    env2.document.querySelector('[data-clear-draft]').click();
    await tick(20);
    assert.equal(env2.document.querySelector('#sale-form').dataset.flowMode, 'quick');
    assert.equal(env2.document.querySelector('#sale-form').dataset.draftDirty, 'false');

    // Simple Quick draft persists & restores as Quick (no spurious escalation)
    env2.setVal('[data-item-field="accountId"]', 'ceyrek');
    env2.setVal('[data-item-field="value"]', '1500');
    env2.setVal('#f-note', 'Simple Quick F5');
    env2.window.dispatchEvent(new env2.window.Event('beforeunload'));
    const quickSnap = env2.snapshotStorage();
    env2.close(true);
    env2Closed = true;

    const env3 = await createOwnerApp({ seededStorage: quickSnap, reposOverride: env2.repos });
    try {
      assert.equal(env3.document.querySelector('#sale-form').dataset.flowMode, 'quick');
      assert.equal(env3.document.querySelector('#sale-form').classList.contains('flow-quick'), true);
      assert.equal(env3.document.querySelector('[data-item-field="value"]').value, '1500');
      assert.equal(env3.document.querySelector('#f-note').value, 'Simple Quick F5');
    } finally {
      env3.close();
    }
  } finally {
    if (!env2Closed) env2.close();
  }
});

// ============================================================================
// Group B: Owner Live Summary & CSS Grid Fix
// ============================================================================

test('Paket4 B1: Owner sticky live summary stays outside step panels and styles.css removes display:block collision', async () => {
  const env = await createOwnerApp();
  const { document, setVal } = env;
  try {
    const summary = document.querySelector('#sale-form > aside.trade-live-summary');
    assert.ok(summary, 'aside.trade-live-summary must be direct child of #sale-form');
    assert.equal(summary.closest('[data-step-panel]'), null, 'Live summary must live outside [data-step-panel]');
    assert.ok(summary.querySelector('#sale-equation'));
    assert.ok(summary.querySelector('#sale-total'));
    assert.ok(summary.querySelector('#sale-remainder'));
    assert.ok(summary.querySelector('#trade-live-cari'));
    assert.ok(summary.querySelector('#trade-effects'));
    assert.equal(document.querySelectorAll('#sale-form button[type="submit"]').length, 1, 'Exactly one submit button in #sale-form');
    assert.ok(summary.querySelector('button[type="submit"]'));

    // Select customer and add debt in guided mode -> live cari summary updates before/after
    const custId = [...document.querySelector('#f-counterpartyId').options].find(o => o.value).value;
    setVal('#f-counterpartyId', custId);
    assert.match(summary.querySelector('#trade-live-cari').textContent, /1\.000,00 TL · Alacağımız/);
    setVal('[data-item-field="value"]', '2500');
    document.querySelector('[data-add-allocation="debt"]').click();
    setVal('[data-allocation-kind="debt"] [data-allocation-field="quantity"]', '2500');
    assert.match(summary.querySelector('#trade-live-cari').textContent, /3\.500,00 TL · Alacağımız/);
    assert.ok(summary.querySelector('#trade-effects [data-draft-direction="in"]'));
    assert.ok(summary.querySelector('#trade-effects [data-draft-direction="out"]'));
    assert.ok(summary.querySelector('#trade-effects .receipt-cari'));

    // CSS structural checks
    assert.equal(/#sale-form\.trade-form\.stepper-active\s*\{\s*display\s*:\s*block\s*;?\s*\}/.test(stylesCss), false, 'Old display:block collision must be removed');
    assert.match(stylesCss, /@media screen and \(min-width: 1100px\)\s*\{[\s\S]*#sale-form\.trade-form:not\(\[data-operation="stock"\]\)/);
    assert.match(stylesCss, /\.trade-live-summary\s*\{\s*position:\s*sticky;/);
  } finally {
    env.close();
  }
});

// ============================================================================
// Group C: Owner Customer Drawer Full Units + Fallback
// ============================================================================

test('Paket4 C1: Owner Customer Drawer supports full units (GBP/CHF/other) and !uiKit fallback works', async () => {
  const env = await createOwnerApp();
  const { window, document, repos, commands, setVal } = env;
  try {
    setVal('#f-note', 'Müşteri drawer notu');
    document.querySelector('[data-create-party]').click();
    await tick(20);
    const drawer = document.querySelector('dialog.defter-drawer');
    assert.ok(drawer && drawer.open);
    const unitOpts = [...drawer.querySelector('#f-unit').options].map(o => o.value);
    for (const u of ['TL', 'HAS', 'USD', 'EUR', 'GBP', 'CHF', 'other']) {
      assert.ok(unitOpts.includes(u), `Missing unit option ${u}`);
    }

    // Selecting 'other' enables 3-letter currencyCode validation
    setVal(drawer.querySelector('#f-unit'), 'other');
    assert.equal(drawer.querySelector('#drawer-party-other-unit').hidden, false);
    const curInput = drawer.querySelector('#f-currencyCode');
    assert.equal(curInput.required, true);
    setVal(curInput, 'try');
    assert.equal(curInput.validity.valid, false, 'TRY must be rejected as other FX code');
    setVal(curInput, 'cad');
    assert.equal(curInput.value, 'CAD');
    assert.equal(curInput.validity.valid, true);
    setVal(drawer.querySelector('#f-name'), 'Kanada Müşterisi');
    drawer.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await tick(40);

    assert.equal(document.querySelector('dialog.defter-drawer'), null);
    const created = repos.demo.state().accounts.find(a => a.name === 'Kanada Müşterisi');
    assert.equal(created.unit, 'CAD');
    assert.equal(commands.at(-1).command.opening, '0');
    assert.equal(document.querySelector('#f-counterpartyId').value, created.id);
    assert.equal(document.querySelector('#f-note').value, 'Müşteri drawer notu');
    assert.equal(document.querySelector('#sale-form').dataset.draftStale, 'false');
  } finally {
    env.close();
  }

  // !uiKit fallback navigates to #account-form
  const noUiEnv = await createOwnerApp({ withUiKit: false });
  try {
    noUiEnv.document.querySelector('[data-create-party]').click();
    await tick(20);
    assert.ok(noUiEnv.document.querySelector('#account-form'), '!uiKit must fall back to #account-form');
  } finally {
    noUiEnv.close();
  }
});

// ============================================================================
// Group D: Owner Stock Drawer ([data-create-stock])
// ============================================================================

test('Paket4 D1: Owner Stock Drawer creates GRAM & paired ADET (opening=0), auto-selects, preserves draft', async () => {
  const env = await createOwnerApp();
  const { window, document, repos, commands, setVal } = env;
  try {
    setVal('#f-note', 'Stok drawer taslağı');
    setVal('[data-item-field="value"]', '4500');

    const btn = document.querySelector('[data-create-stock]');
    assert.ok(btn, '[data-create-stock] must render in retail sale');
    btn.click();
    await tick(20);

    // GRAM hides weightGroup & canonicalizes tr-TR opening '12,500' -> '12.500'
    let drawer = document.querySelector('dialog.defter-drawer');
    assert.ok(drawer && drawer.open);
    setVal(drawer.querySelector('#f-name'), 'Has İşçiliksiz Gram');
    setVal(drawer.querySelector('#f-unit'), 'GRAM');
    assert.equal(drawer.querySelector('#f-weightGroup').disabled, true);
    assert.equal(drawer.querySelector('#f-weightGroup').closest('.field').hidden, true);
    setVal(drawer.querySelector('#f-opening'), '12,500');
    drawer.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await tick(40);

    assert.equal(document.querySelector('dialog.defter-drawer'), null);
    const gramCmd = commands.at(-1).command;
    assert.equal(gramCmd.type, 'stockAccount');
    assert.equal(gramCmd.unit, 'GRAM');
    assert.equal(gramCmd.opening, '12.500');
    assert.equal(gramCmd.countPolicy, 'periodic');
    const createdGram = repos.demo.state().accounts.find(a => a.id === 'stock-' + commands.at(-1).id);
    assert.ok(createdGram);
    assert.equal(document.querySelector('[data-item-field="accountId"]').value, createdGram.id);
    assert.equal(document.querySelector('#f-note').value, 'Stok drawer taslağı');
    assert.equal(document.querySelector('[data-item-field="value"]').value, '4500');
    assert.equal(document.querySelector('#sale-form').dataset.draftStale, 'false');

    // ADET + pairedGroups enforces opening='0' (domain.mjs:696) and selects weightAccount
    document.querySelector('[data-create-stock]').click();
    await tick(20);
    drawer = document.querySelector('dialog.defter-drawer');
    setVal(drawer.querySelector('#f-name'), '22 Ayar Adana Burması');
    setVal(drawer.querySelector('#f-unit'), 'ADET');
    setVal(drawer.querySelector('#f-opening'), '5');
    setVal(drawer.querySelector('#f-weightGroup'), 'bilezik22');
    assert.equal(drawer.querySelector('#f-opening').value, '0', 'Paired ADET stock must force opening=0');
    assert.equal(drawer.querySelector('#f-opening').readOnly, true);

    drawer.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await tick(40);

    const adetCmd = commands.at(-1).command;
    assert.equal(adetCmd.type, 'stockAccount');
    assert.deepEqual(adetCmd.pairedGroups, ['bilezik22']);
    assert.equal(adetCmd.opening, '0');
    assert.equal(adetCmd.countPolicy, 'daily');
    const createdAdet = repos.demo.state().accounts.find(a => a.id === 'stock-' + commands.at(-1).id);
    assert.ok(createdAdet);
    assert.equal(document.querySelector('[data-item-field="accountId"]').value, createdAdet.id);
    assert.equal(document.querySelector('[data-item-field="weightAccount"]').value, 'bilezik22');
    assert.equal(document.querySelector('#sale-form').dataset.draftStale, 'false');
  } finally {
    env.close();
  }
});

test('Paket4 D2: Stock Drawer handles 400 inline, 5xx retry, pending guard, stale preservation, and visibility guards', async () => {
  const failControl = { mode: 'ok' };
  const env = await createOwnerApp({ failControl });
  const { window, document, repos, commands, setVal } = env;
  try {
    setVal('#f-note', 'Stok hata testi');
    document.querySelector('[data-create-stock]').click();
    await tick(20);
    let drawer = document.querySelector('dialog.defter-drawer');
    // Duplicate name ('Çeyrek' already exists) -> 400 keeps drawer open with inline notice
    setVal(drawer.querySelector('#f-name'), 'Çeyrek');
    drawer.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await tick(40);
    assert.ok(document.querySelector('dialog.defter-drawer')?.open, '400 error must keep Stock Drawer open');
    assert.equal(drawer.querySelector('.notice').hidden, false);

    // Network failure after commit -> closes drawer, shows #retry-bar, pending blocks reopen, #retry reconciles
    failControl.mode = 'network-after-commit';
    setVal(drawer.querySelector('#f-name'), 'Sentetik Yüzük');
    drawer.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await tick(40);
    assert.equal(document.querySelector('dialog.defter-drawer'), null);
    assert.equal(document.querySelector('#retry-bar').hidden, false);

    const beforeCount = commands.length;
    document.querySelector('[data-create-stock]').click();
    await tick(20);
    assert.equal(document.querySelector('dialog.defter-drawer'), null, 'Pending must block opening Stock Drawer');

    document.querySelector('#retry').click();
    await tick(40);
    assert.equal(document.querySelector('#retry-bar').hidden, true);
    assert.equal(commands.length, beforeCount, 'Retry must reconcile stockAccount without duplicate POST');
    const retriedStock = repos.demo.state().accounts.find(a => a.name === 'SENTETİK YÜZÜK');
    assert.ok(retriedStock);
    assert.equal(document.querySelector('[data-item-field="accountId"]').value, retriedStock.id);
    assert.equal(document.querySelector('#sale-form').dataset.draftStale, 'false');

    // Pre-stale draft remains stale after Stock Drawer succeeds
    repos.demo.execute({
      id: randomUUID(),
      revision: repos.demo.state().revision,
      command: { type: 'movement', date: '2026-11-10', accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '1', note: 'Harici' }
    });
    document.querySelector('#refresh').click();
    await tick(40);
    assert.equal(document.querySelector('#sale-form').dataset.draftStale, 'true');
    assert.equal(document.querySelector('#sale-form button[type="submit"]').disabled, true);

    document.querySelector('[data-create-stock]').click();
    await tick(20);
    drawer = document.querySelector('dialog.defter-drawer');
    setVal(drawer.querySelector('#f-name'), 'Stale Sonrası Stok');
    drawer.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await tick(40);
    assert.equal(document.querySelector('#sale-form').dataset.draftStale, 'true', 'Pre-stale draft must remain stale');
    assert.equal(document.querySelector('#sale-form button[type="submit"]').disabled, true);

    // Clear draft & check visibility guards: hidden in exchange, stock, edit
    document.querySelector('[data-clear-draft]').click();
    await tick(20);
    document.querySelector('[data-tab="collection"]').click();
    await tick(10);
    document.querySelector('[data-open-exchange]').click();
    await tick(10);
    assert.equal(document.querySelector('[data-create-stock]'), null, 'Hidden in customer-exchange');

    document.querySelector('[data-view="stocks"]').click();
    await tick(20);
    document.querySelector('#stock-movement').click();
    await tick(10);
    assert.equal(document.querySelector('[data-create-stock]'), null, 'Hidden in stock movement');

    // Edit view check
    const saleEv = repos.demo.execute({
      id: randomUUID(),
      revision: repos.demo.state().revision,
      command: { type: 'sale', date: '2026-11-10', items: [{ accountId: 'ceyrek', quantity: '1', value: '100' }], received: [{ accountId: 'nakit', quantity: '100', valueTL: '100' }], given: [], credits: [], debts: [] }
    }).state.journal.at(-1);
    document.querySelector('#refresh').click();
    await tick(40);
    document.querySelector('[data-view="journal"]').click();
    await tick(20);
    document.querySelector('[data-edit-transaction]').click();
    await tick(20);
    assert.equal(document.querySelector('#edit-operation [data-create-stock]'), null, 'Hidden in edit view');
    assert.equal(document.querySelector('#edit-operation [data-create-party]'), null, 'Party create hidden in edit view');
    assert.ok(saleEv);
  } finally {
    env.close();
  }

  // !uiKit check
  const noUiEnv = await createOwnerApp({ withUiKit: false });
  try {
    assert.equal(noUiEnv.document.querySelector('[data-create-stock]'), null, 'Hidden when !uiKit');
  } finally {
    noUiEnv.close();
  }
});

// ============================================================================
// Group E: Owner orderSettlement.advances Canonicalization
// ============================================================================

test('Paket4 E1: Owner orderSettlement.advances canonicalizes tr-TR grouped amounts (1.250,50 -> 1250.50)', async () => {
  const env = await createOwnerApp({ withCustomerOrder: true });
  const { window, document, repos, commands, setVal } = env;
  try {
    const custId = repos.demo.state().accounts.find(a => a.name === 'Ayşe Müşteri').id;
    const orderId = repos.demo.state().customerOrders[0].id;
    setVal('#f-counterpartyId', custId);
    setVal('#trade-order', orderId);
    assert.equal(document.querySelector('#sale-form').dataset.flowMode, 'guided', 'Selecting order escalates to guided');

    const advInput = document.querySelector('[data-advance-id]');
    assert.ok(advInput);
    setVal(advInput, '1.250,50');
    setVal('[data-item-field="accountId"]', 'ceyrek');
    setVal('[data-item-field="quantity"]', '1');
    setVal('[data-item-field="value"]', '1.250,50');

    document.querySelector('#sale-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await tick(40);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].command.orderSettlement.advances[0].amountTL, '1250.50');
    assert.equal(repos.demo.state().journal.at(-1).type, 'sale');
  } finally {
    env.close();
  }
});

// ============================================================================
// Group F: Employee Counter Flow, Live Summary, Customer Drawer, Pricing Codec & Isolation
// ============================================================================

test('Paket4 F1: Employee checkout Quick -> Guided escalation without draft loss & F5 persistence', async () => {
  const env1 = await createEmployeeCheckout();
  let storageSnap;
  try {
    const trade = env1.document.querySelector('#trade');
    assert.equal(trade.dataset.flowMode, 'quick');
    assert.equal(trade.classList.contains('checkout-trade-quick'), true);
    assert.equal(env1.document.querySelector('#open-customer-drawer').hidden, false);
    assert.equal(env1.document.querySelector('#new-customer').hidden, true);

    // Live summary stays outside [data-step-panel]
    const summary = env1.document.querySelector('#checkout-live-summary');
    assert.ok(summary);
    assert.equal(summary.closest('[data-step-panel]'), null);
    assert.ok(summary.querySelector('#summary-customer'));
    assert.ok(summary.querySelector('#checkout-equation'));
    assert.ok(summary.querySelector('#summary-lines'));
    assert.ok(summary.querySelector('#record'));
    assert.ok(summary.querySelector('#clear-draft'));

    // Toggling on clean form must NOT set draftDirty or persist draft
    env1.document.querySelector('[data-flow-mode="guided"]').click();
    assert.equal(trade.dataset.flowMode, 'guided');
    assert.equal(env1.window.DefterDraftStore.listDrafts({ workspace: 'demo', scope: 'checkout' }).length, 0);
    env1.document.querySelector('[data-flow-mode="quick"]').click();
    assert.equal(trade.dataset.flowMode, 'quick');

    // Fill simple Quick sale
    env1.setVal('[data-item] [data-product]', 'ceyrek');
    env1.setVal('[data-item] [data-quantity]', '1');
    env1.setVal('[data-item] [data-value]', '5000');
    env1.document.querySelector('[data-add="received"][data-category="money"]').click();
    env1.setVal('[data-allocation="received"] [data-account]', 'nakit');
    env1.setVal('[data-allocation="received"] [data-quantity]', '3000');
    env1.setVal('#note', 'Tezgâh escalation notu');
    assert.equal(trade.dataset.flowMode, 'quick');

    // Escalate via scrap row -> Guided Step 2, draft preserved
    env1.document.querySelector('[data-add="received"][data-category="scrap"]').click();
    assert.equal(trade.dataset.flowMode, 'guided');
    assert.equal(trade.classList.contains('checkout-trade-stepper'), true);
    assert.equal(env1.document.querySelector('[data-flow-mode="quick"]').disabled, true);
    assert.equal(env1.document.querySelector('[data-step-panel="2"]').classList.contains('is-active'), true);
    assert.equal(env1.document.querySelector('[data-item] [data-value]').value, '5000');
    assert.equal(env1.document.querySelector('[data-allocation="received"] [data-quantity]').value, '3000');
    assert.equal(env1.document.querySelector('#note').value, 'Tezgâh escalation notu');
    assert.match(summary.querySelector('#summary-lines').textContent, /ÇEYREK/i);

    // Switch to Step 1 and save snapshot for F5 simulation
    env1.document.querySelector('[data-step-target="1"]').click();
    assert.equal(env1.document.querySelector('[data-step-panel="1"]').classList.contains('is-active'), true);
    storageSnap = env1.snapshotStorage();
  } finally {
    env1.close(true);
  }

  const env2 = await createEmployeeCheckout({ seededStorage: storageSnap, repoOverride: env1.repo });
  try {
    const trade = env2.document.querySelector('#trade');
    assert.equal(trade.dataset.flowMode, 'guided');
    assert.equal(env2.document.querySelector('[data-step-panel="1"]').classList.contains('is-active'), true);
    assert.equal(env2.document.querySelector('[data-item] [data-value]').value, '5000');
    assert.equal(env2.document.querySelector('#note').value, 'Tezgâh escalation notu');
  } finally {
    env2.close();
  }
});

test('Paket4 F2: Employee Customer Drawer (#open-customer-drawer, popstate, 400/200/503) & !uiKit fallback', async () => {
  const failControl = { mode: 'ok' };
  const env = await createEmployeeCheckout({ failControl });
  const { window, document, repo, calls, setVal } = env;
  try {
    setVal('[data-item] [data-quantity]', '1');
    setVal('[data-item] [data-value]', '2500');

    // Open Drawer, verify #customer-form moved in and popstate unwinds cleanly
    document.querySelector('#open-customer-drawer').click();
    await tick(20);
    let drawer = document.querySelector('dialog.defter-drawer');
    assert.ok(drawer && drawer.open);
    assert.ok(drawer.querySelector('#customer-form'));
    assert.equal(window.DefterUI.getLayerCount(), 1);

    window.history.back();
    await tick(50);
    assert.equal(window.DefterUI.getLayerCount(), 0);
    assert.equal(window.location.pathname, '/checkout');
    assert.ok(document.querySelector('#new-customer #customer-form'), '#customer-form must return to #new-customer on close');

    // Reopen -> 400 validation error (duplicate 'Ayşe Müşteri') keeps Drawer open with inline notice
    document.querySelector('#open-customer-drawer').click();
    await tick(20);
    drawer = document.querySelector('dialog.defter-drawer');
    setVal(drawer.querySelector('[name="name"]'), 'Ayşe Müşteri');
    drawer.querySelector('#customer-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await tick(40);
    assert.ok(document.querySelector('dialog.defter-drawer')?.open, '400 must keep customer drawer open');
    assert.equal(document.querySelector('#customer-drawer-notice').hidden, false);

    // Valid submit -> 200 closes drawer, selects customer, updates #summary-customer, preserves non-stale draft
    setVal(drawer.querySelector('[name="name"]'), 'Tezgâh Drawer Müşterisi');
    drawer.querySelector('#customer-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await tick(40);
    assert.equal(document.querySelector('dialog.defter-drawer'), null);
    const createdAcc = repo.state().accounts.find(a => a.name === 'Tezgâh Drawer Müşterisi');
    assert.equal(document.querySelector('#customer').value, createdAcc.id);
    assert.equal(calls[0].command.opening, '0');
    assert.match(document.querySelector('#summary-customer').textContent, /Tezgâh Drawer Müşterisi/);
    assert.equal(document.querySelector('#draft-stale').hidden, true);
    assert.equal(document.querySelector('[data-item] [data-value]').value, '2500');

    // Pre-stale trade draft must remain stale after Customer Drawer succeeds
    repo.execute({
      id: randomUUID(),
      revision: repo.state().revision,
      command: { type: 'movement', date: '2026-11-10', accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '1', note: 'Harici' }
    });
    document.querySelector('#refresh').click();
    await tick(40);
    assert.equal(document.querySelector('#draft-stale').hidden, false);
    assert.equal(document.querySelector('#record').disabled, true);
    document.querySelector('#open-customer-drawer').click();
    await tick(20);
    drawer = document.querySelector('dialog.defter-drawer');
    setVal(drawer.querySelector('[name="name"]'), 'Stale Tezgâh Müşterisi');
    drawer.querySelector('#customer-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await tick(40);
    assert.equal(document.querySelector('#draft-stale').hidden, false, 'Pre-stale checkout draft must stay stale');
    assert.equal(document.querySelector('#record').disabled, true);

    // 503 closes Drawer so #pending-panel is not trapped behind backdrop
    failControl.mode = '503';
    document.querySelector('#open-customer-drawer').click();
    await tick(20);
    drawer = document.querySelector('dialog.defter-drawer');
    setVal(drawer.querySelector('[name="name"]'), 'Bekleyen Müşteri');
    drawer.querySelector('#customer-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await tick(40);
    assert.equal(document.querySelector('dialog.defter-drawer'), null);
    assert.equal(document.querySelector('#pending-panel').hidden, false);
  } finally {
    env.close();
  }

  // !uiKit fallback keeps <details id="new-customer"> visible and #open-customer-drawer hidden
  const noUiEnv = await createEmployeeCheckout({ withUiKit: false });
  try {
    assert.equal(noUiEnv.document.querySelector('#open-customer-drawer').hidden, true);
    assert.equal(noUiEnv.document.querySelector('#new-customer').hidden, false);
    noUiEnv.setVal('#customer-form [name="name"]', 'Fallback Müşterisi');
    noUiEnv.document.querySelector('#customer-form').requestSubmit();
    await tick(40);
    assert.equal(noUiEnv.calls[0].command.type, 'account');
  } finally {
    noUiEnv.close();
  }
});

test('Paket4 F3: Employee checkout pricing(row) canonicalizes unsigned & signed tr-TR amounts via DefterAmountCodec', async () => {
  const env = await createEmployeeCheckout();
  const { document, repo, calls, setVal } = env;
  try {
    setVal('[data-item] [data-product]', 'ceyrek');
    setVal('[data-item] [data-quantity]', '1');
    setVal('[data-item] [data-value]', '1.250,50');
    document.querySelector('[data-add="received"][data-category="money"]').click();
    setVal('[data-allocation="received"] [data-account]', 'nakit');
    setVal('[data-allocation="received"] [data-quantity]', '1.250,50');

    setVal('[data-quoted]', '1.250,50');
    setVal('[data-source]', 'Vitrin etiketi');
    document.querySelector('[data-add-component]').click();
    document.querySelector('[data-add-component]').click();
    const comps = document.querySelectorAll('[data-components] > div');
    setVal(comps[0].querySelector('[data-component-name]'), 'İndirim');
    setVal(comps[0].querySelector('[data-component-value]'), '-25,50');
    setVal(comps[1].querySelector('[data-component-name]'), 'İşçilik');
    setVal(comps[1].querySelector('[data-component-value]'), '100,25');

    document.querySelector('#trade').requestSubmit();
    assert.equal(document.querySelector('#review').hidden, false);
    document.querySelector('#confirm').click();
    await tick(40);

    assert.equal(calls.length, 1);
    const pricingLine = calls[0].command.salePricing.lines[0];
    assert.equal(pricingLine.quotedTL, '1250.50');
    assert.deepEqual(pricingLine.components, [
      { label: 'İndirim', amountTL: '-25.50' },
      { label: 'İşçilik', amountTL: '100.25' }
    ]);
    assert.equal(pricingLine.costTL, undefined);
    repo.approvePending({ id: calls[0].id, revision: repo.state().revision, actor: { id: '00000000-0000-4000-8000-000000000001', name: 'Patron', role: 'owner' } });
    assert.equal(repo.state().journal.at(-1).meta.lines[0].pricing.components[0].amountTL, -2550);

    // Zero quotedTL stays '0'
    setVal('[data-item] [data-product]', 'ceyrek');
    setVal('[data-item] [data-quantity]', '1');
    setVal('[data-item] [data-value]', '500');
    document.querySelector('[data-add="received"][data-category="money"]').click();
    setVal('[data-allocation="received"] [data-account]', 'nakit');
    setVal('[data-allocation="received"] [data-quantity]', '500');
    setVal('[data-quoted]', '0');
    document.querySelector('#trade').requestSubmit();
    document.querySelector('#confirm').click();
    await tick(40);
    assert.equal(calls.at(-1).command.salePricing.lines[0].quotedTL, '0');
  } finally {
    env.close();
  }
});

test('Paket4 F4 & G: Strict employee isolation, access.css layout rules, and strict CSP hygiene', async () => {
  // Static isolation checks on checkout.html & checkout.js
  for (const forbidden of [
    'data-create-stock',
    'stockAccount',
    'stockUpdate',
    'registerItem',
    'fundAccount',
    'costTL',
    'orderSettlement',
    'supplierFirm',
    '/api/state',
    '/api/journal',
    '/api/suppliers',
    '/api/backup'
  ]) {
    assert.equal(checkoutHtml.includes(forbidden), false, `checkout.html must not include ${forbidden}`);
    assert.equal(checkoutSource.includes(forbidden), false, `checkout.js must not include ${forbidden}`);
  }

  // Runtime fetch boundary check
  const env = await createEmployeeCheckout();
  try {
    const allowed = new Set(['/api/auth/session', '/api/checkout', '/api/customers', '/api/command', '/api/pending-approvals']);
    for (const p of env.fetchPaths) {
      assert.ok(allowed.has(p), `Unexpected employee fetch path: ${p}`);
    }
  } finally {
    env.close();
  }

  // access.css structural checks
  assert.match(accessCss, /\.checkout-trade-layout/);
  assert.match(accessCss, /@media \(min-width: 1100px\)/);
  assert.match(accessCss, /\.checkout-live-summary\s*\{\s*position:\s*sticky;/);
  assert.match(accessCss, /\.defter-drawer #customer-form/);

  // Strict CSP & user-path hygiene across modified files
  assert.doesNotMatch(checkoutHtml, /\sstyle=|\sonclick=/i);
  assert.doesNotMatch(appSource, /\sstyle=|\sonclick=/i);
  assert.doesNotMatch(checkoutSource, /\sstyle=|\sonclick=/i);
  assert.doesNotMatch(appSource + checkoutSource + checkoutHtml, /[A-Z]:[\\/]Users[\\/]/i);
});

// ============================================================================
// Group H: Iteration 2 Verifier Regressions (productTouched, order deselection, edit Guided, 409 aria-busy)
// ============================================================================

test('Paket4 H1: Untouched Row 0 survives [data-create-party] and F5 without false productTouched, while touched Row 0 appends Row 1 across F5', async () => {
  // 1) Dirty note + [data-create-party] -> focus & click [data-create-stock] -> Row 0 auto-selected, rows=1, flowMode=quick
  const env1 = await createOwnerApp();
  try {
    env1.setVal('#f-note', 'Party sonra stok');
    env1.document.querySelector('[data-create-party]').click();
    await tick(20);
    let drawer = env1.document.querySelector('dialog.defter-drawer');
    env1.setVal(drawer.querySelector('#f-name'), 'Yeni Müşteri');
    drawer.querySelector('form').dispatchEvent(new env1.window.Event('submit', { bubbles: true, cancelable: true }));
    await tick(40);
    assert.equal(env1.document.querySelector('.sale-item').dataset.productTouched, undefined);

    const stockBtn = env1.document.querySelector('[data-create-stock]');
    stockBtn.focus();
    stockBtn.click();
    await tick(20);
    drawer = env1.document.querySelector('dialog.defter-drawer');
    env1.setVal(drawer.querySelector('#f-name'), 'Pırlanta Yüzük');
    drawer.querySelector('form').dispatchEvent(new env1.window.Event('submit', { bubbles: true, cancelable: true }));
    await tick(40);

    const stockCmd = env1.commands.at(-1);
    assert.equal(env1.document.querySelectorAll('.sale-item').length, 1);
    assert.equal(env1.document.querySelector('#sale-form').dataset.flowMode, 'quick');
    assert.equal(env1.document.querySelector('[data-item-field="accountId"]').value, 'stock-' + stockCmd.id);
    assert.equal(env1.document.querySelector('#f-note').value, 'Party sonra stok');
  } finally {
    env1.close();
  }

  // 2) Dirty note + F5 reload -> focus & click [data-create-stock] -> Row 0 auto-selected, rows=1, flowMode=quick
  const env2a = await createOwnerApp();
  let untouchedSnap;
  try {
    env2a.setVal('#f-note', 'F5 untouched notu');
    env2a.window.dispatchEvent(new env2a.window.Event('beforeunload'));
    untouchedSnap = env2a.snapshotStorage();
  } finally {
    env2a.close(true);
  }
  const env2b = await createOwnerApp({ seededStorage: untouchedSnap, reposOverride: env2a.repos });
  try {
    assert.equal(env2b.document.querySelector('.sale-item').dataset.productTouched, undefined);
    const stockBtn = env2b.document.querySelector('[data-create-stock]');
    stockBtn.focus();
    stockBtn.click();
    await tick(20);
    const drawer = env2b.document.querySelector('dialog.defter-drawer');
    env2b.setVal(drawer.querySelector('#f-name'), 'F5 İlk Stok');
    drawer.querySelector('form').dispatchEvent(new env2b.window.Event('submit', { bubbles: true, cancelable: true }));
    await tick(40);

    const stockCmd = env2b.commands.at(-1);
    assert.equal(env2b.document.querySelectorAll('.sale-item').length, 1);
    assert.equal(env2b.document.querySelector('#sale-form').dataset.flowMode, 'quick');
    assert.equal(env2b.document.querySelector('[data-item-field="accountId"]').value, 'stock-' + stockCmd.id);
  } finally {
    env2b.close();
  }

  // 3) Explicitly touched Row 0 + F5 reload -> focus & click [data-create-stock] -> preserves Row 0 and appends Row 1
  const env3a = await createOwnerApp();
  let touchedSnap;
  try {
    env3a.setVal('[data-item-field="accountId"]', 'ceyrek');
    env3a.setVal('[data-item-field="value"]', '2000');
    env3a.window.dispatchEvent(new env3a.window.Event('beforeunload'));
    touchedSnap = env3a.snapshotStorage();
  } finally {
    env3a.close(true);
  }
  const env3b = await createOwnerApp({ seededStorage: touchedSnap, reposOverride: env3a.repos });
  try {
    assert.equal(env3b.document.querySelector('.sale-item').dataset.productTouched, 'true');
    const stockBtn = env3b.document.querySelector('[data-create-stock]');
    stockBtn.focus();
    stockBtn.click();
    await tick(20);
    const drawer = env3b.document.querySelector('dialog.defter-drawer');
    env3b.setVal(drawer.querySelector('#f-name'), 'İkinci Satır Stok');
    drawer.querySelector('form').dispatchEvent(new env3b.window.Event('submit', { bubbles: true, cancelable: true }));
    await tick(40);

    const stockCmd = env3b.commands.at(-1);
    const itemRows = [...env3b.document.querySelectorAll('.sale-item')];
    assert.equal(itemRows.length, 2);
    assert.equal(itemRows[0].querySelector('[data-item-field="accountId"]').value, 'ceyrek');
    assert.equal(itemRows[1].querySelector('[data-item-field="accountId"]').value, 'stock-' + stockCmd.id);
    assert.equal(env3b.document.querySelector('#sale-form').dataset.flowMode, 'guided');
  } finally {
    env3b.close();
  }
});

test('Paket4 H2: Deselecting #trade-order back to "" re-enables [data-flow-toggle] and clears [data-flow-reason]', async () => {
  const env = await createOwnerApp({ withCustomerOrder: true });
  const { document, repos, setVal } = env;
  try {
    const custId = repos.demo.state().accounts.find(a => a.name === 'Ayşe Müşteri').id;
    const orderId = repos.demo.state().customerOrders[0].id;
    setVal('#f-counterpartyId', custId);
    setVal('#trade-order', orderId);

    const form = document.querySelector('#sale-form');
    const toggle = document.querySelector('[data-flow-toggle]');
    const reason = document.querySelector('[data-flow-reason]');
    assert.equal(form.dataset.flowMode, 'guided');
    assert.equal(toggle.disabled, true);
    assert.equal(reason.hidden, false);
    assert.match(reason.textContent, /sipariş mahsubu/i);

    // Deselect order back to "" ("Bağımsız satış")
    setVal('#trade-order', '');
    assert.equal(toggle.disabled, false, '[data-flow-toggle] must re-enable when #trade-order is cleared');
    assert.equal(reason.hidden, true, '[data-flow-reason] must hide when #trade-order is cleared');
    assert.equal(reason.textContent, '');

    toggle.click();
    assert.equal(form.dataset.flowMode, 'quick');
  } finally {
    env.close();
  }
});

test('Paket4 H3: view === "edit" on simple retail sale stays in Guided Mode (.stepper-active)', async () => {
  const env = await createOwnerApp();
  const { document, repos } = env;
  try {
    repos.demo.execute({
      id: randomUUID(),
      revision: repos.demo.state().revision,
      command: {
        type: 'sale',
        date: '2026-11-10',
        items: [{ accountId: 'ceyrek', quantity: '1', value: '5000' }],
        received: [{ accountId: 'nakit', quantity: '5000', valueTL: '5000' }],
        given: [],
        credits: [],
        debts: []
      }
    });
    document.querySelector('#refresh').click();
    await tick(40);
    document.querySelector('[data-view="journal"]').click();
    await tick(20);
    document.querySelector('[data-edit-transaction]').click();
    await tick(20);

    const form = document.querySelector('#edit-operation #sale-form');
    assert.ok(form, 'Edit form must render');
    assert.equal(form.dataset.flowMode, 'guided');
    assert.equal(form.classList.contains('stepper-active'), true);
    assert.equal(form.classList.contains('flow-quick'), false);
    assert.equal(form.querySelector('[data-flow-toggle]'), null);
  } finally {
    env.close();
  }
});

test('Paket4 H4: HTTP 409 keeps aria-busy="true" until deferred /api/state refresh resolves', async () => {
  const failControl = { mode: 'ok', waitState: null };
  const env = await createOwnerApp({ failControl });
  const { window, document, repos, setVal } = env;
  try {
    setVal('#f-note', '409 aria-busy notu');
    document.querySelector('[data-create-party]').click();
    await tick(20);
    const drawer = document.querySelector('dialog.defter-drawer');
    setVal(drawer.querySelector('#f-name'), 'Çakışma Müşterisi');

    // Advance server revision externally so drawer submit hits a real 409
    repos.demo.execute({
      id: randomUUID(),
      revision: repos.demo.state().revision,
      command: { type: 'movement', date: '2026-11-10', accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '1', note: 'Harici revizyon' }
    });

    let resolveState;
    let markStateRequested;
    const stateRequested = new Promise(r => { markStateRequested = r; });
    const stateGate = new Promise(r => { resolveState = r; });
    failControl.waitState = () => {
      markStateRequested();
      return stateGate;
    };

    drawer.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await stateRequested;
    await tick(40);

    assert.equal(document.querySelector('dialog.defter-drawer'), null, 'Drawer must close on 409');
    assert.equal(document.body.getAttribute('aria-busy'), 'true', 'aria-busy must remain true while refresh(false) /api/state is in flight');
    assert.equal(document.querySelector('#refresh').disabled, true, 'Controls must remain disabled during 409 refresh');

    resolveState();
    await tick(40);

    assert.equal(document.body.getAttribute('aria-busy'), 'false', 'aria-busy must clear after refresh(false) completes');
    assert.equal(document.querySelector('#refresh').disabled, false);
    assert.equal(document.querySelector('#sale-form').dataset.draftStale, 'true');
  } finally {
    env.close();
  }
});
