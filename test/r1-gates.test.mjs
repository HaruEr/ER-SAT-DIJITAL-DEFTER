import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadJSDOM } from '../test-support/jsdom.mjs';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS } from '../domain.mjs';
import { checkoutState } from '../editor-access.mjs';
import { renderSupplierWorkspace } from '../public/suppliers.js';

const JSDOM = await loadJSDOM();
const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const usersHtml = readFileSync(new URL('../public/users.html', import.meta.url), 'utf8');
const checkoutHtml = readFileSync(new URL('../public/checkout.html', import.meta.url), 'utf8');
const draftStoreSource = readFileSync(new URL('../public/draft-store.js', import.meta.url), 'utf8');
const uiKitSource = readFileSync(new URL('../public/ui-kit.js', import.meta.url), 'utf8');
const accessClientSource = readFileSync(new URL('../public/access-client.js', import.meta.url), 'utf8');
const amountCodecSource = readFileSync(new URL('../public/amount-codec.js', import.meta.url), 'utf8');
const dateFormatSource = readFileSync(new URL('../public/date-format.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const usersSource = readFileSync(new URL('../public/users.js', import.meta.url), 'utf8');
const checkoutSource = readFileSync(new URL('../public/checkout.js', import.meta.url), 'utf8');

const tick = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));

function seedRepo(workspace = 'demo') {
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
          a.id === 'nakit' ? '50000' : a.id === 'ceyrek' ? '10' : a.id === 'gramToplam' ? '20' : '0'
        ])
      )
    }
  });
  repo.execute({
    id: randomUUID(),
    revision: 1,
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
  const supRes = repo.execute({
    id: randomUUID(),
    revision: 2,
    command: { type: 'supplierFirm', date: '2026-11-10', name: 'Altın Toptan AŞ' }
  });
  const supId = supRes.state.supplierParties[0].id;
  repo.execute({
    id: randomUUID(),
    revision: 3,
    command: { type: 'supplierUnit', date: '2026-11-10', supplierId: supId, unit: 'TL' }
  });
  return repo;
}

async function createOwnerApp({ url = 'http://127.0.0.1:4317/#v=overview', failControl = { mode: 'ok' }, withSuppliers = false } = {}) {
  const ownerActor = { id: '00000000-0000-4000-8000-000000000001', name: 'Patron', role: 'owner' };
  const repos = { demo: seedRepo('demo'), dukkan: seedRepo('dukkan') };
  const dom = new JSDOM(indexHtml, { url, runScripts: 'outside-only' });
  const { window } = dom;
  const document = window.document;
  const prevGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    Node: globalThis.Node
  };
  if (withSuppliers) {
    globalThis.window = window;
    globalThis.document = document;
    globalThis.Node = window.Node;
    window.__supplierModule = { renderSupplierWorkspace };
  }
  Object.defineProperty(window.crypto, 'randomUUID', { value: randomUUID });
  window.HTMLElement.prototype.scrollIntoView = () => {};

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
    if (parsed.pathname === '/api/suppliers') {
      return { ok: true, status: 200, json: async () => ({ revision: repo.state().revision, supplier: repo.state().supplierParties[0], accounts: repo.state().supplierParties[0]?.accounts || [], documents: { sources: [], purchases: [] } }) };
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
  window.eval(uiKitSource);
  window.eval(amountCodecSource);
  window.eval(dateFormatSource);
  if (withSuppliers) {
    window.eval(
      appSource.replace("import('./suppliers.js')", 'Promise.resolve(window.__supplierModule)') +
      '\nwindow.__r1TestHooks = { clearWorkspaceDrafts, supplierMemory };'
    );
  } else {
    window.eval(appSource);
  }
  await tick(40);
  await tick(40);

  return {
    dom,
    window,
    document,
    repos,
    commands,
    close: () => {
      window.close();
      repos.demo.close();
      repos.dukkan.close();
      if (withSuppliers) {
        globalThis.window = prevGlobals.window;
        globalThis.document = prevGlobals.document;
        globalThis.Node = prevGlobals.Node;
      }
    }
  };
}

test('R1 Suppliers: remember() keeps stamp.revision/date, disables stale submit, and sets data-draft-dirty', async () => {
  const dom = new JSDOM('<main></main>', { url: 'http://127.0.0.1/owner' });
  const { window } = dom;
  const { document } = window;
  globalThis.window = window;
  globalThis.document = document;
  globalThis.Node = window.Node;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.eval(draftStoreSource);

  const firmId = 'firm-1';
  const baseState = {
    revision: 5,
    date: '2026-11-10',
    supplierParties: [{ id: firmId, name: 'Test Toptancı', accounts: [{ id: 'sup-tl', unit: 'TL', balance: -1000 }] }],
    accounts: [
      { id: 'ceyrek', name: 'Çeyrek', unit: 'ADET', kind: 'asset', physical: true, isPurchasable: true },
      { id: 'nakit', name: 'Nakit', unit: 'TL', kind: 'asset', physical: true }
    ]
  };
  const root = document.querySelector('main');
  const sent = [];
  const memory = new Map();
  const store = window.DefterDraftStore;
  const ctx = {
    actorId: 'owner-1',
    state: baseState,
    memory,
    workspace: 'demo',
    escape: v => String(v ?? ''),
    format: (n, u) => `${n} ${u}`,
    day: d => d,
    request: async () => ({
      revision: 6,
      supplier: baseState.supplierParties[0],
      accounts: baseState.supplierParties[0].accounts,
      documents: {
        sources: [],
        purchases: [{ id: 'p1', kind: 'supplierPurchase', date: '2026-11-10', lines: [{ lineIndex: 0, accountId: 'ceyrek', quantity: 5, remainingQuantity: 5 }], charges: [{ accountId: 'sup-tl', unit: 'TL', remaining: 5000 }] }]
      }
    }),
    submit: async cmd => { sent.push(cmd); return false; },
    refresh: () => {},
    isPending: () => false
  };

  let api = renderSupplierWorkspace(root, ctx);
  try {
    root.querySelector(`[data-open-firm="${firmId}"]`).click();
    root.querySelector('[data-supplier-task="purchase"]').click();
    let form = root.querySelector('form[data-supplier-form="purchase"]');
    assert.equal(form.dataset.draftDirty, 'false');

    const note = form.querySelector('input[name="note"]');
    note.value = 'taslak-not';
    note.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal(form.dataset.draftDirty, 'true');

    const draftKey = store.makeKey({ actorId: 'owner-1', workspace: 'demo', scope: 'supplier', type: 'purchase', entityId: firmId });
    assert.equal(store.getDraft(draftKey).meta.revision, 5);

    // Bump state revision to 6 (stale!)
    const bumpedState = { ...baseState, revision: 6 };
    api.update(bumpedState);
    form = root.querySelector('form[data-supplier-form="purchase"]');
    const reviewBtn = form.querySelector('[data-review-current]');
    const saveBtn = form.querySelector('button[type="submit"]');
    assert.equal(reviewBtn.hidden, false);
    assert.equal(saveBtn.disabled, true);
    assert.equal(form.querySelector('[data-draft-stale]') !== null, true);

    // Edit while stale must NOT overwrite meta.revision with 6
    const note2 = form.querySelector('input[name="note"]');
    note2.value = 'taslak-not-2';
    note2.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal(store.getDraft(draftKey).meta.revision, 5);

    // Destroy & re-render (simulating F5) -> must STILL be stale and disabled
    api.destroy();
    api = renderSupplierWorkspace(root, { ...ctx, state: bumpedState });
    form = root.querySelector('form[data-supplier-form="purchase"]');
    assert.equal(form.querySelector('[data-review-current]').hidden, false);
    assert.equal(form.querySelector('button[type="submit"]').disabled, true);

    // Clicking review updates stamp and enables submit
    form.querySelector('[data-review-current]').click();
    assert.equal(form.querySelector('[data-review-current]').hidden, true);
    assert.equal(form.querySelector('button[type="submit"]').disabled, false);
    assert.equal(store.getDraft(draftKey).meta.revision, 6);

    // Also verify renderSupplierDocumentTask ('return') sets save.type='submit' and reviewBtn.dataset.reviewCurrent
    root.querySelector('[data-supplier-task="return"]').click();
    await tick(30);
    let retForm = root.querySelector('form[data-supplier-document-form="return"]');
    const retNote = retForm.querySelector('input[name="note"]');
    retNote.value = 'iade-not';
    retNote.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal(retForm.dataset.draftDirty, 'true');

    const retState7 = { ...baseState, revision: 7 };
    api.destroy();
    api = renderSupplierWorkspace(root, {
      ...ctx,
      state: retState7,
      request: async () => ({
        revision: 7,
        supplier: baseState.supplierParties[0],
        accounts: baseState.supplierParties[0].accounts,
        documents: {
          sources: [],
          purchases: [{ id: 'p1', kind: 'supplierPurchase', date: '2026-11-10', lines: [{ lineIndex: 0, accountId: 'ceyrek', quantity: 5, remainingQuantity: 5 }], charges: [{ accountId: 'sup-tl', unit: 'TL', remaining: 5000 }] }]
        }
      })
    });
    await tick(30);
    retForm = root.querySelector('form[data-supplier-document-form="return"]');
    const retSave = retForm.querySelector('button[type="submit"]');
    const retReviews = [...retForm.querySelectorAll('[data-review-current]')];
    assert.ok(retSave, 'Document task must have explicit button[type="submit"]');
    assert.equal(retForm.dataset.draftDirty, 'true');
    assert.equal(retSave.disabled, true);
    assert.equal(retReviews.length >= 2, true);
    assert.equal(root.querySelector('[data-draft-stale]') !== null, true);

    // Edit while stale keeps return draft revision at 6
    const retKey = store.makeKey({ actorId: 'owner-1', workspace: 'demo', scope: 'supplier', type: 'return', entityId: firmId });
    retForm.querySelector('input[name="note"]').value = 'iade-not-2';
    retForm.querySelector('input[name="note"]').dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal(store.getDraft(retKey).meta.revision, 6);

    retReviews[1].click();
    assert.equal(retSave.disabled, false);
    assert.equal(retReviews.every(b => b.hidden === true), true);
    assert.equal(store.getDraft(retKey).meta.revision, 7);
  } finally {
    api.destroy();
    window.close();
  }
});

test('R1 Quick Customer Drawer: pending guard, conditional revision advance, 5xx retry idempotency, 400 inline', async () => {
  const failControl = { mode: 'ok' };
  const env = await createOwnerApp({ url: 'http://127.0.0.1:4317/#v=transaction', failControl });
  const { window, document, repos, commands } = env;
  try {
    // 1. Non-stale dirty #sale-form -> Quick Customer Drawer -> keeps valid & selects 'cari-' + id without unwanted debt row
    const saleForm = document.querySelector('#sale-form');
    const note = saleForm.querySelector('#f-note');
    note.value = 'Hızlı müşteri taslağı';
    note.dispatchEvent(new window.Event('input', { bubbles: true }));

    document.querySelector('[data-create-party]').click();
    await tick(20);
    let drawer = document.querySelector('dialog.defter-drawer');
    assert.ok(drawer && drawer.open);

    // 400 validation error (duplicate customer name 'Ayşe Müşteri') keeps Drawer open with inline banner
    drawer.querySelector('#f-name').value = 'Ayşe Müşteri';
    drawer.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await tick(30);
    assert.ok(document.querySelector('dialog.defter-drawer')?.open, '400 error must keep Drawer open');
    assert.equal(drawer.querySelector('.notice').hidden, false);

    // Valid name succeeds, closes Drawer, preserves #sale-form non-stale, selects customer, no unwanted empty debt row
    drawer.querySelector('#f-name').value = 'Yeni Çekmece Müşterisi';
    drawer.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await tick(40);
    assert.equal(document.querySelector('dialog.defter-drawer'), null);
    const updatedForm = document.querySelector('#sale-form');
    assert.equal(updatedForm.dataset.draftStale, 'false');
    assert.equal(updatedForm.querySelector('[data-draft-stale]'), null);
    assert.equal(updatedForm.querySelector('button[type="submit"]').disabled, false);
    assert.equal(updatedForm.querySelector('#f-note').value, 'Hızlı müşteri taslağı');
    assert.equal(updatedForm.querySelector('[data-allocation-kind="debt"]'), null);
    const createdAcc = repos.demo.state().accounts.find(a => a.name === 'Yeni Çekmece Müşterisi');
    assert.equal(updatedForm.querySelector('#f-counterpartyId').value, createdAcc.id);

    // 2. Network failure after commit on Drawer submit -> closes Drawer, shows #retry-bar, #retry reconciles without duplicate
    failControl.mode = 'network-after-commit';
    document.querySelector('[data-create-party]').click();
    await tick(20);
    drawer = document.querySelector('dialog.defter-drawer');
    drawer.querySelector('#f-name').value = 'Tekrarlı Çekmece Müşterisi';
    drawer.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await tick(40);
    assert.equal(document.querySelector('dialog.defter-drawer'), null, '5xx/network error must close Drawer');
    assert.equal(document.querySelector('#retry-bar').hidden, false);

    // Pending blocks opening Quick Customer Drawer again
    const beforeCmdCount = commands.length;
    document.querySelector('[data-create-party]').click();
    await tick(20);
    assert.equal(document.querySelector('dialog.defter-drawer'), null);
    assert.equal(commands.length, beforeCmdCount);

    // Retry reconciles via /api/journal without re-POSTing /api/command
    document.querySelector('#retry').click();
    await tick(40);
    assert.equal(document.querySelector('#retry-bar').hidden, true);
    assert.equal(commands.length, beforeCmdCount, 'Retry must find committed command in journal without duplicate POST');
    const retriedAcc = repos.demo.state().accounts.find(a => a.name === 'Tekrarlı Çekmece Müşterisi');
    assert.equal(document.querySelector('#f-counterpartyId').value, retriedAcc.id);
    assert.equal(document.querySelector('#sale-form').dataset.draftStale, 'false');

    // 3. Already-stale #sale-form stays stale even after Quick Customer Drawer succeeds
    repos.demo.execute({
      id: randomUUID(),
      revision: repos.demo.state().revision,
      command: { type: 'movement', date: '2026-11-10', accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '1', note: 'Harici' }
    });
    document.querySelector('#refresh').click();
    await tick(40);
    assert.equal(document.querySelector('#sale-form').dataset.draftStale, 'true');
    assert.equal(document.querySelector('#sale-form button[type="submit"]').disabled, true);

    document.querySelector('[data-create-party]').click();
    await tick(20);
    drawer = document.querySelector('dialog.defter-drawer');
    drawer.querySelector('#f-name').value = 'Eski Taslak Müşterisi';
    drawer.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await tick(40);
    assert.equal(document.querySelector('#sale-form').dataset.draftStale, 'true', 'Already-stale draft must remain stale');
    assert.ok(document.querySelector('#sale-form [data-draft-stale]'));
    assert.equal(document.querySelector('#sale-form button[type="submit"]').disabled, true);
  } finally {
    env.close();
  }
});

test('R1 Popover cleanup on render() & tab switch, plus cross-workspace beforeunload', async () => {
  const env = await createOwnerApp({ url: 'http://127.0.0.1:4317/#v=transaction' });
  const { window, document } = env;
  try {
    const partySelect = document.querySelector('#f-counterpartyId');
    const infoBtn = document.querySelector('[data-party-popover]');
    assert.equal(infoBtn.getAttribute('aria-haspopup'), 'dialog');
    assert.equal(infoBtn.getAttribute('aria-expanded'), 'false');

    const custId = [...partySelect.options].find(o => o.value).value;
    partySelect.value = custId;
    partySelect.dispatchEvent(new window.Event('change', { bubbles: true }));
    infoBtn.click();
    assert.ok(document.querySelector('.defter-popover'), 'Popover should open');

    // Refresh (render()) closes active popover cleanly
    document.querySelector('#refresh').click();
    await tick(40);
    assert.equal(document.querySelector('.defter-popover'), null, 'render() must close orphaned popover');

    // Tab switch closes active popover cleanly
    document.querySelector('[data-party-popover]').click();
    assert.ok(document.querySelector('.defter-popover'));
    document.querySelector('[data-tab="purchase"]').click();
    await tick(20);
    assert.equal(document.querySelector('.defter-popover'), null, 'Tab switch must close popover');

    // Cross-workspace beforeunload: dirty demo -> switch to clean dukkan -> beforeunload still warns
    const note = document.querySelector('#sale-form #f-note');
    note.value = 'demo-cross-ws-dirty';
    note.dispatchEvent(new window.Event('input', { bubbles: true }));

    const ws = document.querySelector('#workspace');
    ws.value = 'dukkan';
    ws.dispatchEvent(new window.Event('change', { bubbles: true }));
    await tick(40);

    const evWarn = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(evWarn);
    assert.equal(evWarn.defaultPrevented, true, 'beforeunload must warn for dirty demo draft while viewing clean dukkan');

    // Clear demo drafts -> beforeunload does not warn
    window.DefterDraftStore.clearWorkspace('demo');
    const evClean = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(evClean);
    assert.equal(evClean.defaultPrevented, false);

    // Dirty + pending #logout on /owner -> beforeunload + pagehide must NOT prevent and must leave zero draft/pending keys
    const noteLogout = document.querySelector('#sale-form #f-note');
    noteLogout.value = 'owner-logout-dirty';
    noteLogout.dispatchEvent(new window.Event('input', { bubbles: true }));
    window.sessionStorage.setItem('defter-pending-dukkan', JSON.stringify({ id: 'p-owner', revision: 1 }));
    const evPreLogout = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(evPreLogout);
    assert.equal(evPreLogout.defaultPrevented, true);

    window.sessionStorage.removeItem('defter-session');
    for (const k of Object.keys(window.sessionStorage)) {
      if (k.startsWith('defter-pending-') || k.startsWith('defter-sale-retry-') || k.startsWith('defter-draft:v1:')) {
        window.sessionStorage.removeItem(k);
      }
    }
    window.DefterDraftStore.clearSession();
    const evLogoutBeforeUnload = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(evLogoutBeforeUnload);
    assert.equal(evLogoutBeforeUnload.defaultPrevented, false, '/owner beforeunload after #logout must not prevent');
    window.dispatchEvent(new window.Event('pagehide', { cancelable: true }));
    const remainingOwnerKeys = Object.keys(window.sessionStorage).filter(
      k => k.startsWith('defter-draft:') || k.startsWith('defter-pending-')
    );
    assert.deepEqual(remainingOwnerKeys, [], '/owner #logout + pagehide must leave zero draft/pending keys');
  } finally {
    env.close();
  }
});

test('R1 History unwind: single Back after non-popstate close, stacked layers, rapid reopen, and pending safety', async () => {
  const env = await createOwnerApp({ url: 'http://127.0.0.1:4317/#v=overview' });
  const { window, document } = env;
  try {
    document.querySelector('#navigation [data-view="transaction"]').click();
    await tick(30);
    assert.equal(window.location.hash, '#v=transaction&tab=sale');

    // 1. Open drawer, close via Escape -> 1st Back returns directly to #v=overview
    document.querySelector('[data-create-party]').click();
    await tick(20);
    const drawer1 = document.querySelector('dialog.defter-drawer');
    drawer1.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick(50);
    assert.equal(window.DefterUI.getLayerCount(), 0);
    assert.equal(window.location.hash, '#v=transaction&tab=sale');

    window.history.back();
    await tick(50);
    assert.equal(window.location.hash, '#v=overview', 'Single Back after non-popstate close must navigate to previous view');

    // Forward back to transaction, test stacked Drawer -> confirmCritical, then rapid reopen
    document.querySelector('#navigation [data-view="transaction"]').click();
    await tick(30);
    const d2 = window.DefterUI.openDrawer({ title: 'D2', content: '<p>2</p>' });
    const pConfirm = window.DefterUI.confirmCritical({ title: 'Onay', impactText: 'Test' });
    assert.equal(window.DefterUI.getLayerCount(), 2);
    document.querySelectorAll('.defter-dialog')[1].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await pConfirm;
    d2.close('done');
    await tick(50);
    assert.equal(window.DefterUI.getLayerCount(), 0);
    window.history.back();
    await tick(50);
    assert.equal(window.location.hash, '#v=overview', 'Single Back after closing stacked layers must navigate to #v=overview');

    // Rapid close -> immediate openDrawer must keep second drawer open
    document.querySelector('#navigation [data-view="transaction"]').click();
    await tick(30);
    const d3 = window.DefterUI.openDrawer({ title: 'D3', content: '<p>3</p>' });
    d3.close('done');
    const d4 = window.DefterUI.openDrawer({ title: 'D4', content: '<p>4</p>' });
    await tick(60);
    assert.equal(window.DefterUI.getLayerCount(), 1, 'Rapid reopen must not be closed by prior unwind popstate');
    d4.close('done');
    await tick(50);

    // Pre-seeded pending must NOT produce false pending banner on synthetic unwind popstate
    const pKey = window.DefterDraftStore.makeKey({ actorId: '00000000-0000-4000-8000-000000000001', workspace: 'demo', scope: 'retail', type: 'pending' });
    window.DefterDraftStore.savePending(pKey, { id: 'p-1', revision: 1, command: { type: 'sale' } });
    const notice = document.querySelector('#notice');
    notice.hidden = true;
    notice.textContent = '';
    const d5 = window.DefterUI.openDrawer({ title: 'D5', content: '<p>5</p>' });
    d5.close('escape');
    await tick(50);
    assert.equal(notice.hidden, true, 'Synthetic unwind popstate must not trigger pending error banner');
  } finally {
    env.close();
  }
});

test('R1 users.js: shadowed form.id uses getAttribute("id") and popstate closes confirmCritical modal on /users', async () => {
  const dom = new JSDOM(usersHtml, { url: 'http://127.0.0.1/users' });
  const { window } = dom;
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.Node = window.Node;
  globalThis.Option = window.Option;
  globalThis.FormData = window.FormData;

  const calls = [];
  window.DefterSession = {
    current: () => ({ actor: { id: 'owner-1', name: 'Patron', role: 'owner' } }),
    api: async (path, body) => {
      calls.push({ path, body });
      if (path === '/api/auth/users') return { users: [{ id: 'owner-1', name: 'Patron' }, { id: 'emp-1', name: 'Ali' }] };
      return { ok: true };
    }
  };
  window.eval(uiKitSource);
  window.eval(usersSource);
  await tick(30);

  try {
    const disableForm = window.document.getElementById('disable');
    // Explicitly simulate Chrome HTMLFormElement shadowing where form.id returns the <select name="id">
    Object.defineProperty(disableForm, 'id', { value: disableForm.querySelector('select[name="id"]'), configurable: true });
    assert.notEqual(disableForm.id, 'disable');

    disableForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await tick(20);
    assert.equal(window.DefterUI.getLayerCount(), 1, 'Shadowed form.id must still open confirmCritical modal');
    assert.equal(calls.some(c => c.path.includes('/disable') || c.path.includes('/employees')), false);

    // Back button closes modal and keeps pathname === '/users' without disabling employee
    window.history.back();
    await tick(50);
    assert.equal(window.DefterUI.getLayerCount(), 0);
    assert.equal(window.location.pathname, '/users');
    assert.equal(calls.some(c => c.path === '/api/auth/disable'), false);
  } finally {
    window.close();
  }
});

test('R1 access-client.js: synchronous role mismatch locks immediately with 0 fetch calls', async () => {
  const { VirtualConsole } = await import('jsdom');
  for (const path of ['/owner', '/users']) {
    const dom = new JSDOM('<!doctype html><html><body><main>secret</main></body></html>', { url: `http://127.0.0.1${path}`, runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
    const { window } = dom;
    window.sessionStorage.setItem('defter-session', JSON.stringify({
      actor: { id: 'emp-1', name: 'Çalışan', role: 'employee' },
      token: 'emp-tok',
      expiresAt: Date.now() + 60_000
    }));
    let fetchCount = 0;
    window.fetch = async () => { fetchCount++; return { ok: true, status: 200, json: async () => ({}) }; };
    try {
      window.eval(accessClientSource);
      assert.equal(window.sessionStorage.getItem('defter-session'), null, `Session must be cleared synchronously on ${path}`);
      assert.equal(window.document.body.hidden, true, `Body must be hidden synchronously on ${path}`);
      assert.equal(fetchCount, 0, `Zero fetch calls allowed when employee opens ${path}`);
    } finally {
      window.close();
    }
  }
});

test('R1 checkout.js: beforeunload protects dirty/pending/other-op drafts without blocking #logout, and popstate closes layers', async () => {
  const repo = seedRepo('demo');
  const dom = new JSDOM(checkoutHtml, { url: 'http://127.0.0.1/checkout', runScripts: 'outside-only' });
  const { window } = dom;
  const { document } = window;
  Object.defineProperty(window.crypto, 'randomUUID', { value: randomUUID });
  window.HTMLElement.prototype.scrollIntoView = () => {};

  window.sessionStorage.setItem('defter-session', JSON.stringify({
    actor: { id: 'emp-1', name: 'Çalışan', role: 'employee' },
    token: 'emp-tok',
    expiresAt: Date.now() + 3600_000
  }));

  let failTrade = false;
  window.fetch = async (reqUrl, init = {}) => {
    const parsed = new URL(String(reqUrl), 'http://127.0.0.1/checkout');
    if (parsed.pathname === '/api/auth/session') return { ok: true, status: 200, json: async () => ({ id: 'emp-1', name: 'Çalışan', role: 'employee' }) };
    if (parsed.pathname === '/api/checkout') return { ok: true, status: 200, json: async () => checkoutState(repo.state({ compact: true })) };
    if (parsed.pathname === '/api/command') {
      if (failTrade) return { ok: false, status: 503, json: async () => ({ error: 'Sunucu hatası' }) };
      return { ok: true, status: 200, json: async () => repo.execute(JSON.parse(init.body)) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  window.eval(amountCodecSource);
  window.eval(dateFormatSource);
  window.eval(uiKitSource);
  window.eval(accessClientSource);
  window.eval(draftStoreSource);
  window.eval(checkoutSource);
  await tick(40);
  await tick(40);

  try {
    // 1. Fresh load -> beforeunload NOT prevented
    let ev = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, false);

    // 2. Dirty trade -> beforeunload prevented
    const qty = document.querySelector('[data-item] [data-quantity]');
    const val = document.querySelector('[data-item] [data-value]');
    qty.value = '1';
    qty.dispatchEvent(new window.Event('input', { bubbles: true }));
    val.value = '5000';
    val.dispatchEvent(new window.Event('input', { bubbles: true }));
    ev = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true);

    // 3. Switch operation to clean 'purchase' -> still warns for stored 'sale' draft
    document.querySelector('#operation').value = 'purchase';
    document.querySelector('#operation').dispatchEvent(new window.Event('change', { bubbles: true }));
    ev = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true);

    // 4. Switch back and clear draft -> beforeunload NOT prevented
    document.querySelector('#operation').value = 'sale';
    document.querySelector('#operation').dispatchEvent(new window.Event('change', { bubbles: true }));
    document.querySelector('#clear-draft').click();
    ev = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, false);

    // 5. Pending (503) -> beforeunload prevented
    const prod = document.querySelector('[data-item] [data-product]');
    prod.value = 'ceyrek';
    prod.dispatchEvent(new window.Event('change', { bubbles: true }));
    const qty5 = document.querySelector('[data-item] [data-quantity]');
    const val5 = document.querySelector('[data-item] [data-value]');
    qty5.value = '1';
    qty5.dispatchEvent(new window.Event('input', { bubbles: true }));
    val5.value = '5000';
    val5.dispatchEvent(new window.Event('input', { bubbles: true }));
    document.querySelector('[data-add="received"][data-category="money"]').click();
    const rec = document.querySelector('[data-allocation="received"]');
    rec.querySelector('[data-account]').value = 'nakit';
    rec.querySelector('[data-account]').dispatchEvent(new window.Event('change', { bubbles: true }));
    rec.querySelector('[data-quantity]').value = '5000';
    rec.querySelector('[data-quantity]').dispatchEvent(new window.Event('input', { bubbles: true }));
    failTrade = true;
    document.querySelector('#trade').requestSubmit();
    await tick(10);
    assert.equal(document.querySelector('#review').hidden, false, 'Review panel should open: ' + document.querySelector('#status').textContent);
    document.querySelector('#confirm').click();
    await tick(40);
    assert.equal(document.querySelector('#pending-panel').hidden, false, 'Pending panel should show: ' + document.querySelector('#status').textContent);
    ev = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true);

    // 6. popstate closes open DefterUI layer on /checkout
    window.DefterUI.openDrawer({ title: 'Tezgâh Detay', content: '<p>Test</p>' });
    assert.equal(window.DefterUI.getLayerCount(), 1);
    window.history.back();
    await tick(50);
    assert.equal(window.DefterUI.getLayerCount(), 0);
    assert.equal(window.location.pathname, '/checkout');

    // 7. Logout (clear session) while draftDirty/pending was true -> beforeunload must NOT block lock() and pagehide must NOT re-persist drafts
    window.DefterSession.clear();
    ev = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, false);
    window.dispatchEvent(new window.Event('pagehide', { cancelable: true }));
    const leakedKeysPending = Object.keys(window.sessionStorage).filter(
      k => k.startsWith('defter-draft:') || k.startsWith('defter-pending-') || k.startsWith('defter-sale-retry-')
    );
    assert.deepEqual(leakedKeysPending, [], 'checkout.js pagehide after #logout (dirty+pending) must leave zero draft/pending keys');
  } finally {
    window.close();
    repo.close();
  }
});

test('R1 checkout.js: dirty-only #logout clears drafts and pagehide does not re-persist under owner fallback', async () => {
  const repo = seedRepo('demo');
  const dom = new JSDOM(checkoutHtml, { url: 'http://127.0.0.1/checkout', runScripts: 'outside-only' });
  const { window } = dom;
  const { document } = window;
  Object.defineProperty(window.crypto, 'randomUUID', { value: randomUUID });
  window.HTMLElement.prototype.scrollIntoView = () => {};

  window.sessionStorage.setItem('defter-session', JSON.stringify({
    actor: { id: 'emp-1', name: 'Çalışan', role: 'employee' },
    token: 'emp-tok',
    expiresAt: Date.now() + 3600_000
  }));

  window.fetch = async reqUrl => {
    const parsed = new URL(String(reqUrl), 'http://127.0.0.1/checkout');
    if (parsed.pathname === '/api/auth/session') return { ok: true, status: 200, json: async () => ({ id: 'emp-1', name: 'Çalışan', role: 'employee' }) };
    if (parsed.pathname === '/api/checkout') return { ok: true, status: 200, json: async () => checkoutState(repo.state({ compact: true })) };
    return { ok: true, status: 200, json: async () => ({}) };
  };

  window.eval(amountCodecSource);
  window.eval(dateFormatSource);
  window.eval(uiKitSource);
  window.eval(accessClientSource);
  window.eval(draftStoreSource);
  window.eval(checkoutSource);
  await tick(40);
  await tick(40);

  try {
    const val = document.querySelector('[data-item] [data-value]');
    val.value = '7777';
    val.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.ok(
      Object.keys(window.sessionStorage).some(k => k.startsWith('defter-draft:v1:emp-1:') || k.startsWith('defter-pending-checkout-draft-emp-1-')),
      'Dirty draft must exist before #logout'
    );

    // Simulate #logout (DefterSession.clear() -> beforeunload -> pagehide)
    window.DefterSession.clear();
    const evBefore = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(evBefore);
    assert.equal(evBefore.defaultPrevented, false, 'beforeunload after #logout must not prevent');

    window.dispatchEvent(new window.Event('pagehide', { cancelable: true }));
    const leakedKeys = Object.keys(window.sessionStorage).filter(
      k => k.startsWith('defter-draft:') || k.startsWith('defter-pending-') || k.startsWith('defter-sale-retry-')
    );
    assert.deepEqual(leakedKeys, [], 'pagehide after dirty-only #logout must leave zero draft/pending keys in sessionStorage');
  } finally {
    window.close();
    repo.close();
  }
});

test('R1 Suppliers + app.js: clearing drafts (clearWorkspaceDrafts / clearWorkspace / clearSession / clearDraft) prevents supplierMemory resurrection', async () => {
  const env = await createOwnerApp({ url: 'http://127.0.0.1:4317/#v=overview', withSuppliers: true });
  const { window, document, repos } = env;
  try {
    const firmId = repos.demo.state().supplierParties[0].id;
    const store = window.DefterDraftStore;
    const hooks = window.__r1TestHooks;

    const openPurchaseAndType = async noteText => {
      document.querySelector('#navigation [data-view="suppliers"]').click();
      await tick(30);
      if (document.querySelector('[data-back-suppliers]')) {
        document.querySelector('[data-back-suppliers]').click();
        await tick(20);
      }
      document.querySelector(`[data-open-firm="${firmId}"]`).click();
      await tick(20);
      document.querySelector('[data-supplier-task="purchase"]').click();
      await tick(20);
      const form = document.querySelector('form[data-supplier-form="purchase"]');
      assert.ok(form);
      const note = form.querySelector('input[name="note"]');
      note.value = noteText;
      note.dispatchEvent(new window.Event('input', { bubbles: true }));
      assert.equal(form.dataset.draftDirty, 'true');
      return form;
    };

    const reopenPurchaseAndAssertClean = async label => {
      document.querySelector('#navigation [data-view="suppliers"]').click();
      await tick(30);
      if (!document.querySelector('form[data-supplier-form="purchase"]')) {
        if (document.querySelector(`[data-open-firm="${firmId}"]`)) {
          document.querySelector(`[data-open-firm="${firmId}"]`).click();
          await tick(20);
        }
        document.querySelector('[data-supplier-task="purchase"]').click();
        await tick(20);
      }
      const form = document.querySelector('form[data-supplier-form="purchase"]');
      assert.ok(form, `${label}: purchase form should render`);
      assert.equal(form.dataset.draftDirty, 'false', `${label}: data-draft-dirty must be false`);
      assert.equal(form.querySelector('input[name="note"]').value, '', `${label}: note input must be blank`);
      assert.equal(form.querySelector('[data-review-current]').hidden, true, `${label}: [data-review-current] must be hidden`);
      assert.equal(form.querySelector('button[type="submit"]').disabled, false, `${label}: submit must be enabled`);
    };

    // 1. DefterDraftStore.clearSession() after stale supplier draft must NOT resurrect from supplierMemory
    await openPurchaseAndType('stale-session-note');
    document.querySelector('#navigation [data-view="overview"]').click();
    await tick(30);
    repos.demo.execute({
      id: randomUUID(),
      revision: repos.demo.state().revision,
      command: { type: 'account', date: '2026-11-10', name: 'Bump 1', unit: 'TL', opening: '0', partyType: 'customer' }
    });
    store.clearSession();
    await reopenPurchaseAndAssertClean('clearSession');

    // 2. DefterDraftStore.clearWorkspace('demo') after stale supplier draft must NOT resurrect
    await openPurchaseAndType('stale-workspace-note');
    document.querySelector('#navigation [data-view="overview"]').click();
    await tick(30);
    repos.demo.execute({
      id: randomUUID(),
      revision: repos.demo.state().revision,
      command: { type: 'account', date: '2026-11-10', name: 'Bump 2', unit: 'TL', opening: '0', partyType: 'customer' }
    });
    store.clearWorkspace('demo');
    await reopenPurchaseAndAssertClean('clearWorkspace');

    // 3. DefterDraftStore.clearDraft(key) after stale supplier draft must NOT resurrect
    await openPurchaseAndType('stale-single-note');
    document.querySelector('#navigation [data-view="overview"]').click();
    await tick(30);
    repos.demo.execute({
      id: randomUUID(),
      revision: repos.demo.state().revision,
      command: { type: 'account', date: '2026-11-10', name: 'Bump 3', unit: 'TL', opening: '0', partyType: 'customer' }
    });
    for (const k of store.listDrafts({ workspace: 'demo', scope: 'supplier' })) store.clearDraft(k);
    await reopenPurchaseAndAssertClean('clearDraft');

    // 4. Backup UI [data-clear-workspace-drafts] / clearWorkspaceDrafts('demo') purges both defter-draft:v1: and supplier:draft: keys for 'demo' without touching 'dukkan'
    await openPurchaseAndType('stale-ui-clear-note');
    hooks.supplierMemory.set('defter-draft:v1:00000000-0000-4000-8000-000000000001:demo:supplier:create', { fields: { name: 'Leak' } });
    hooks.supplierMemory.set('supplier:draft:' + JSON.stringify(['demo', firmId, 'purchase']), { fields: { note: 'LegacyLeak' } });
    hooks.supplierMemory.set('defter-draft:v1:00000000-0000-4000-8000-000000000001:dukkan:supplier:purchase:' + firmId, { fields: { note: 'KeepDukkan' } });
    hooks.supplierMemory.set('supplier:draft:' + JSON.stringify(['dukkan', firmId, 'purchase']), { fields: { note: 'KeepDukkanLegacy' } });

    document.querySelector('#navigation [data-view="backup"]').click();
    await tick(30);
    repos.demo.execute({
      id: randomUUID(),
      revision: repos.demo.state().revision,
      command: { type: 'account', date: '2026-11-10', name: 'Bump 4', unit: 'TL', opening: '0', partyType: 'customer' }
    });
    const clearBtn = document.querySelector('[data-clear-workspace-drafts]');
    assert.ok(clearBtn, 'Backup view should offer workspace draft clear button');
    clearBtn.click();
    await tick(30);

    const demoSupplierMemKeys = [...hooks.supplierMemory.keys()].filter(
      k => k.includes(':demo:supplier:') || k.startsWith('supplier:draft:["demo"')
    );
    assert.deepEqual(demoSupplierMemKeys, [], 'clearWorkspaceDrafts must purge both defter-draft:v1: and supplier:draft: keys for demo');
    assert.equal(hooks.supplierMemory.has('defter-draft:v1:00000000-0000-4000-8000-000000000001:dukkan:supplier:purchase:' + firmId), true, 'dukkan defter-draft:v1: key must remain untouched');
    assert.equal(hooks.supplierMemory.has('supplier:draft:' + JSON.stringify(['dukkan', firmId, 'purchase'])), true, 'dukkan supplier:draft: key must remain untouched');
    assert.deepEqual([...store.listDrafts({ workspace: 'demo' })], []);

    await reopenPurchaseAndAssertClean('clearWorkspaceDrafts');
  } finally {
    env.close();
  }
});
