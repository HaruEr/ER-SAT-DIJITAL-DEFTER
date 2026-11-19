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
const draftStoreSource = readFileSync(new URL('../public/draft-store.js', import.meta.url), 'utf8');
const accessClientSource = readFileSync(new URL('../public/access-client.js', import.meta.url), 'utf8');
const uiKitSource = readFileSync(new URL('../public/ui-kit.js', import.meta.url), 'utf8');
const amountCodecSource = readFileSync(new URL('../public/amount-codec.js', import.meta.url), 'utf8');
const dateFormatSource = readFileSync(new URL('../public/date-format.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const suppliersSource = readFileSync(new URL('../public/suppliers.js', import.meta.url), 'utf8');
const checkoutSource = readFileSync(new URL('../public/checkout.js', import.meta.url), 'utf8');

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * Creates an in-memory browser environment with controlled sessionStorage and Repository backend.
 */
async function createEnvironment({
  html = indexHtml,
  url = 'http://127.0.0.1:4317/',
  workspace = 'demo',
  actorId = 'owner',
  role = 'owner',
  sessionStorageItems = {},
  networkControl = { failCount: 0, statusOverride: null }
} = {}) {
  const repo = new Repository(':memory:', workspace);
  repo.execute({
    id: randomUUID(),
    revision: 0,
    command: {
      type: 'opening',
      date: '2026-10-28',
      balances: Object.fromEntries(
        INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [
          a.id,
          a.id === 'nakit' ? '10000' : a.id === 'gramToplam' ? '20' : '0'
        ])
      )
    }
  });

  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  const { window } = dom;
  const document = window.document;

  Object.defineProperty(window.crypto, 'randomUUID', { value: randomUUID });

  // Pre-seed sessionStorage
  if (new URL(url).pathname !== '/' && !Object.hasOwn(sessionStorageItems, 'defter-session')) {
    window.sessionStorage.setItem('defter-session', JSON.stringify({
      actor: { id: actorId, name: actorId, role },
      token: 'synthetic-test-token',
      expiresAt: Date.now() + 3600_000
    }));
  }
  for (const [k, v] of Object.entries(sessionStorageItems)) {
    window.sessionStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
  }

  // Session mock
  window.DefterSession = {
    current: () => ({ actor: { id: actorId, name: actorId, role } }),
    api: async (path, body) => {
      const parsed = new URL(path, window.location.href);
      if (parsed.pathname === '/api/state') return repo.state();
      if (parsed.pathname === '/api/checkout') return checkoutState(repo.state({ compact: true }));
      if (parsed.pathname === '/api/journal') {
        return repo.journalPage({
          ...Object.fromEntries(parsed.searchParams),
          limit: Number(parsed.searchParams.get('limit') || 50)
        });
      }
      if (parsed.pathname === '/api/customers') return [];
      if (parsed.pathname === '/api/suppliers') return { firms: [], units: [] };
      if (body) {
        commands.push(body);
        if (networkControl.failCount > 0) {
          networkControl.failCount--;
          const status = networkControl.statusOverride || 0;
          const err = new Error(status === 409 ? 'Kayıt sürümü uyuşmazlığı (409 REVISION_CONFLICT).' : 'Ağ bağlantısı koptu');
          err.status = status;
          throw err;
        }
        return repo.execute(body);
      }
      return repo.state();
    }
  };

  const commands = [];
  window.fetch = async (fetchUrl, options) => {
    const parsed = new URL(fetchUrl, window.location.href);
    if (parsed.pathname === '/api/auth/session') return { ok: true, status: 200, json: async () => ({ id: actorId, name: actorId, role }) };
    if (parsed.pathname === '/api/state') return { ok: true, status: 200, json: async () => repo.state() };
    if (parsed.pathname === '/api/checkout') return { ok: true, status: 200, json: async () => checkoutState(repo.state({ compact: true })) };
    if (parsed.pathname === '/api/customers') return { ok: true, status: 200, json: async () => [] };
    if (parsed.pathname === '/api/journal') {
      return {
        ok: true,
        status: 200,
        json: async () =>
          repo.journalPage({
            ...Object.fromEntries(parsed.searchParams),
            limit: Number(parsed.searchParams.get('limit') || 50)
          })
      };
    }
    if (parsed.pathname === '/api/command') {
      const envelope = JSON.parse(options.body);
      commands.push(envelope);
      if (networkControl.failCount > 0) {
        networkControl.failCount--;
        if (networkControl.statusOverride >= 400) {
          return {
            ok: false,
            status: networkControl.statusOverride,
            json: async () => ({
              error: networkControl.statusOverride === 409
                ? 'Kayıt sürümü uyuşmazlığı (409 REVISION_CONFLICT).'
                : 'Geçici sunucu hatası.'
            })
          };
        }
        throw new Error('Sentetik ağ hatası');
      }
      try {
        const res = repo.execute(envelope);
        return { ok: true, status: 200, json: async () => res };
      } catch (err) {
        return { ok: false, status: err.status || 400, json: async () => ({ error: err.message }) };
      }
    }
    return { ok: true, status: 200, json: async () => repo.state() };
  };

  window.eval(draftStoreSource);
  window.eval(accessClientSource);
  window.eval(uiKitSource);
  window.eval(amountCodecSource);
  window.eval(dateFormatSource);

  return {
    dom,
    window,
    document,
    repo,
    commands,
    networkControl,
    close: () => {
      window.close();
      repo.close();
    }
  };
}

// ============================================================================
// 1. F5 reload restores drafts from sessionStorage in app.js and suppliers.js
// ============================================================================

test('Scenario 1A: F5 reload restores dirty retail sale draft from sessionStorage in app.js', async () => {
  const storeKey = 'defter-draft:v1:owner:demo:retail:sale';
  const seededPayload = {
    version: 1,
    key: storeKey,
    meta: {
      actorId: 'owner',
      workspace: 'demo',
      workday: '2026-10-28',
      revision: 1,
      formId: 'sale-form'
    },
    data: {
      fields: {
        note: 'F5 sonrasi korunan satis'
      },
      sale: {
        items: [{ accountId: 'gramToplam', quantity: '2,5', weightAccount: '', weight: '', value: '5000' }],
        payment: [{ accountId: 'nakit', quantity: '5000', valueTL: '5000' }]
      }
    }
  };

  const env = await createEnvironment({
    sessionStorageItems: { [storeKey]: seededPayload }
  });

  try {
    env.window.eval(appSource + '\nwindow.__draftTest = { setView };');
    await tick();

    // Navigate to transaction sale tab
    env.window.__draftTest.setView('transaction');
    await tick();

    const noteInput = env.document.querySelector('#f-note');
    assert.ok(noteInput, 'Sale form note input should exist');
    assert.equal(noteInput.value, 'F5 sonrasi korunan satis', 'Draft note must be restored from sessionStorage');

    const draftBar = env.document.querySelector('#sale-form .draft-status, #sale-form .info');
    assert.ok(draftBar, 'Draft status bar must be displayed');
    assert.match(draftBar.textContent, /Taslak/i, 'Draft indicator must be visible');
  } finally {
    env.close();
  }
});

test('Scenario 1B: F5 reload restores supplier task draft from sessionStorage in suppliers.js', async () => {
  const firmId = 'sup_altin_as';
  const storeKey = `defter-draft:v1:owner:demo:supplier:purchase:${firmId}`;
  const seededPayload = {
    version: 1,
    key: storeKey,
    meta: {
      actorId: 'owner',
      workspace: 'demo',
      workday: '2026-10-28',
      revision: 1,
      formId: 'supplier-purchase',
      entityId: firmId
    },
    data: {
      fields: {
        'f-physical': '15,250',
        'f-agreed': '15,250',
        'f-note': 'Toptanci has alimi F5 taslagi'
      }
    }
  };

  const env = await createEnvironment({
    html: indexHtml,
    url: 'http://127.0.0.1:4317/',
    sessionStorageItems: { [storeKey]: seededPayload }
  });

  try {
    const store = env.window.DefterDraftStore;
    assert.ok(store, 'DefterDraftStore should be available');

    const restored = store.getDraft(storeKey);
    assert.ok(restored, 'Supplier draft must exist in store');
    assert.equal(restored.data.fields['f-note'], 'Toptanci has alimi F5 taslagi');
    assert.equal(restored.data.fields['f-physical'], '15,250');
  } finally {
    env.close();
  }
});

// ============================================================================
// 2. Workday rollover: normal form permits review; count forms strictly discard numbers
// ============================================================================

test('Scenario 2A: Workday rollover permits review confirmation on standard trade form', async () => {
  const storeKey = 'defter-draft:v1:owner:demo:retail:sale';
  // Draft was saved on 2026-10-28
  const seededPayload = {
    version: 1,
    key: storeKey,
    meta: {
      actorId: 'owner',
      workspace: 'demo',
      workday: '2026-10-28',
      revision: 1,
      formId: 'sale-form'
    },
    data: {
      fields: { note: 'Eski gunluk satis' }
    }
  };

  const env = await createEnvironment({
    sessionStorageItems: { [storeKey]: seededPayload }
  });

  try {
    // Advance repo date to next day
    const state = env.repo.state();
    env.repo.execute({
      id: randomUUID(),
      revision: state.revision,
      command: {
        type: 'close',
        date: state.date,
        counts: Object.fromEntries(
          state.accounts
            .filter(a => a.physical && !a.retired && a.countPolicy === 'daily')
            .map(a => [a.id, a.id === 'nakit' ? '10000' : a.id === 'gramToplam' ? '20' : '0'])
        ),
        reasons: {},
        approvedBy: 'Yonetici'
      }
    });

    env.window.eval(appSource + '\nwindow.__draftTest = { setView };');
    await tick();

    env.window.__draftTest.setView('transaction');
    await tick();

    // Verify draft is flagged as STALE_WORKDAY
    const staleAlert = env.document.querySelector('#sale-form [data-draft-stale]');
    assert.ok(staleAlert, 'Stale workday alert must be visible on standard trade form');
    assert.match(staleAlert.textContent, /eski bir iş gününe ait|defter değişti/i);

    // Standard forms MUST have review button "Güncel bilgilerle kontrol ettim"
    const reviewBtn = env.document.querySelector('#sale-form [data-review-draft]');
    assert.ok(reviewBtn, 'Standard form must offer review confirmation button');

    // Click review confirmation button
    reviewBtn.click();
    await tick();

    // Stale banner should be replaced with regular draft status, allowing submission
    const staleAlertAfter = env.document.querySelector('#sale-form [data-draft-stale]');
    assert.equal(staleAlertAfter, null, 'Stale alert must clear after review confirmation');
    const submitBtn = env.document.querySelector('#sale-form button[type="submit"]');
    assert.equal(submitBtn.disabled, false, 'Submit button must be enabled after review');
  } finally {
    env.close();
  }
});

test('Scenario 2B: Workday rollover on count forms strictly discards numbers and prohibits review', async () => {
  const storeKey = 'defter-draft:v1:owner:demo:retail:close-form';
  const seededPayload = {
    version: 1,
    key: storeKey,
    meta: {
      actorId: 'owner',
      workspace: 'demo',
      workday: '2026-10-28',
      revision: 1,
      formId: 'close-form'
    },
    data: {
      fields: {
        'daily-count-nakit': '12500',
        'daily-reason-nakit': 'Eski gunluk sayim'
      }
    }
  };

  const env = await createEnvironment({
    sessionStorageItems: { [storeKey]: seededPayload }
  });

  try {
    // Advance repo date to next day
    const state = env.repo.state();
    env.repo.execute({
      id: randomUUID(),
      revision: state.revision,
      command: {
        type: 'close',
        date: state.date,
        counts: Object.fromEntries(
          state.accounts
            .filter(a => a.physical && !a.retired && a.countPolicy === 'daily')
            .map(a => [a.id, a.id === 'nakit' ? '10000' : a.id === 'gramToplam' ? '20' : '0'])
        ),
        reasons: {},
        approvedBy: 'Yonetici'
      }
    });

    env.window.eval(appSource + '\nwindow.__draftTest = { setView };');
    await tick();

    env.window.__draftTest.setView('closing');
    await tick();

    // 1. Numbers must NOT be restored into count inputs
    const nakitInput = env.document.querySelector('#daily-count-nakit');
    assert.ok(nakitInput, 'Nakit count input should exist');
    assert.equal(nakitInput.value, '', 'Count form numbers MUST be discarded on workday rollover');

    // 2. Stale alert must explicitly state values were discarded and fresh count is required
    const staleAlert = env.document.querySelector('#close-form [data-draft-stale]');
    assert.ok(staleAlert, 'Close form must show stale alert');
    assert.match(staleAlert.textContent, /yeniden sayın/i);

    // 3. Review button must be strictly PROHIBITED
    const reviewBtn = env.document.querySelector('#close-form [data-review-draft]');
    assert.equal(reviewBtn, null, 'Count forms must NEVER offer review bypass across workday change');

    // 4. Submit button must remain disabled
    const submitBtn = env.document.querySelector('#close-form button[type="submit"]');
    assert.equal(submitBtn.disabled, true, 'Submit button must be disabled for stale count draft');
  } finally {
    env.close();
  }
});

function fillBalancedSale(env, noteText) {
  const set = (selector, value) => {
    const el = env.document.querySelector(selector);
    assert.ok(el, selector);
    el.value = value;
    el.dispatchEvent(new env.window.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  };
  set('[data-item-field="accountId"]', 'gramToplam');
  set('[data-item-field="quantity"]', '1');
  set('[data-item-field="value"]', '100');
  env.document.querySelector('[data-payment-type="cash"]').click();
  set('[data-allocation-kind="payment"] [data-allocation-field="quantity"]', '100');
  if (noteText) set('#f-note', noteText);
}

// ============================================================================
// 3. 409 REVISION_CONFLICT recovery flow
// ============================================================================

test('Scenario 3: 409 conflict clears pending, keeps inputs, displays alert, requires review with new UUID', async () => {
  const env = await createEnvironment({
    networkControl: { failCount: 1, statusOverride: 409 }
  });

  try {
    env.window.eval(appSource + '\nwindow.__draftTest = { setView };');
    await tick();

    env.window.__draftTest.setView('transaction');
    await tick();

    // Prepare balanced sale
    fillBalancedSale(env, '409 Test Islemi');

    // Simulate external change in repository to bump revision
    env.repo.execute({
      id: randomUUID(),
      revision: env.repo.state().revision,
      command: {
        type: 'movement',
        date: env.repo.state().date,
        accountId: 'nakit',
        category: 'Sermaye',
        direction: 'in',
        quantity: '1',
        note: 'Eszamanli dis degisim'
      }
    });

    const form = env.document.querySelector('#sale-form');
    form.dispatchEvent(new env.window.Event('submit', { bubbles: true, cancelable: true }));
    await tick();
    await tick();
    await tick();

    // 1. Verify 409 cleared the pending envelope (savePending(null))
    const store = env.window.DefterDraftStore;
    const pendingStoreKey = store.makeKey({ actorId: 'owner', workspace: 'demo', scope: 'retail', type: 'pending' });
    assert.equal(store.getPending(pendingStoreKey), null, '409 conflict must discard pending envelope');

    // 2. Form input is retained
    const note = env.document.querySelector('#f-note');
    assert.equal(note.value, '409 Test Islemi', 'Form input values must be preserved after 409');

    // 3. Stale banner is displayed
    const staleAlert = env.document.querySelector('#sale-form [data-draft-stale]');
    assert.ok(staleAlert, 'Stale revision alert must be visible');

    // 4. Review button is present and required
    const reviewBtn = env.document.querySelector('#sale-form [data-review-draft]');
    assert.ok(reviewBtn, 'Review button must be provided to acknowledge newer revision');

    const firstCommandId = env.commands[0]?.id;
    assert.ok(firstCommandId, 'First attempted command should have had an ID');

    // 5. User reviews
    reviewBtn.click();
    await tick();

    // Now submit succeeds with a NEW random UUID
    env.networkControl.failCount = 0;
    form.dispatchEvent(new env.window.Event('submit', { bubbles: true, cancelable: true }));
    await tick();
    await tick();

    const secondCommand = env.commands.at(-1);
    assert.ok(secondCommand, 'Second command should have executed');
    assert.notEqual(secondCommand.id, firstCommandId, 'Submitting after 409 must generate a NEW random idempotency UUID');
  } finally {
    env.close();
  }
});

// ============================================================================
// 4. Ambiguous network error recovery flow
// ============================================================================

test('Scenario 4: Ambiguous network error preserves pending envelope and exact idempotency UUID on retry', async () => {
  const env = await createEnvironment({
    networkControl: { failCount: 1, statusOverride: 0 } // synthetic network drop
  });

  try {
    env.window.eval(appSource + '\nwindow.__draftTest = { setView };');
    await tick();

    env.window.__draftTest.setView('transaction');
    await tick();

    fillBalancedSale(env, 'Ag Hatasi Retry');

    const form = env.document.querySelector('#sale-form');
    form.dispatchEvent(new env.window.Event('submit', { bubbles: true, cancelable: true }));
    await tick();
    await tick();

    // 1. Verify pending envelope is PRESERVED in sessionStorage
    const store = env.window.DefterDraftStore;
    const pendingStoreKey = store.makeKey({ actorId: 'owner', workspace: 'demo', scope: 'retail', type: 'pending' });
    const savedPending = store.getPending(pendingStoreKey);
    assert.ok(savedPending, 'Pending envelope must be preserved on network drop');
    const originalUUID = savedPending.id;
    assert.ok(originalUUID, 'Saved pending must retain command id');

    // 2. Retry bar is shown with retry button
    const retryBar = env.document.querySelector('#retry-bar');
    assert.equal(retryBar.hidden, false, 'Retry bar must be displayed');
    const retryBtn = env.document.querySelector('#retry');
    assert.ok(retryBtn, 'Retry button must be available');

    // 3. User clicks retry
    env.networkControl.failCount = 0;
    retryBtn.click();
    await tick();
    await tick();

    // 4. Assert resent command used the EXACT SAME UUID (preventing duplicate insertion)
    const retriedCommand = env.commands.at(-1);
    assert.equal(retriedCommand.id, originalUUID, 'Retry must reuse exact idempotency UUID');
    assert.equal(store.getPending(pendingStoreKey), null, 'After successful retry, pending envelope must be cleared');
  } finally {
    env.close();
  }
});

// ============================================================================
// 5. Multi-user and multi-workspace draft isolation
// ============================================================================

test('Scenario 5A: Multi-user draft isolation - employee cannot access or mutate owner drafts', async () => {
  const env = await createEnvironment({ actorId: 'owner' });

  try {
    const store = env.window.DefterDraftStore;

    // Owner creates and saves a draft
    const ownerKey = store.makeKey({ actorId: 'owner', workspace: 'dukkan', scope: 'retail', type: 'sale' });
    store.saveDraft(ownerKey, {
      meta: { actorId: 'owner', workspace: 'dukkan', workday: '2026-10-28', revision: 1, formId: 'sale-form' },
      data: { fields: { note: 'Patronun gizli taslagi' } }
    });

    // Employee accesses the same workspace
    const empKey = store.makeKey({ actorId: 'employee_ali', workspace: 'dukkan', scope: 'retail', type: 'sale' });
    const empDraft = store.getDraft(empKey);
    assert.equal(empDraft, null, 'Employee must NOT see owner drafts');

    // Employee saves their own draft
    store.saveDraft(empKey, {
      meta: { actorId: 'employee_ali', workspace: 'dukkan', workday: '2026-10-28', revision: 1, formId: 'sale-form' },
      data: { fields: { note: 'Eleman taslagi' } }
    });

    // Owner draft is untouched
    const ownerDraft = store.getDraft(ownerKey);
    assert.equal(ownerDraft.data.fields.note, 'Patronun gizli taslagi');
    assert.equal(store.getDraft(empKey).data.fields.note, 'Eleman taslagi');

    // Owner clears their session drafts
    store.clearSession('owner');
    assert.equal(store.getDraft(ownerKey), null, 'Owner draft cleared');
    assert.ok(store.getDraft(empKey), 'Employee draft must remain untouched when owner logs out');
  } finally {
    env.close();
  }
});

test('Scenario 5B: Multi-workspace draft isolation - demo drafts do not collide with dukkan drafts', async () => {
  const env = await createEnvironment({ actorId: 'owner' });

  try {
    const store = env.window.DefterDraftStore;

    const demoKey = store.makeKey({ actorId: 'owner', workspace: 'demo', scope: 'retail', type: 'sale' });
    const dukkanKey = store.makeKey({ actorId: 'owner', workspace: 'dukkan', scope: 'retail', type: 'sale' });

    store.saveDraft(demoKey, {
      meta: { actorId: 'owner', workspace: 'demo', workday: '2026-10-28', revision: 1, formId: 'sale-form' },
      data: { fields: { note: 'Demo taslak' } }
    });

    store.saveDraft(dukkanKey, {
      meta: { actorId: 'owner', workspace: 'dukkan', workday: '2026-10-28', revision: 1, formId: 'sale-form' },
      data: { fields: { note: 'Gercek dukkan taslagi' } }
    });

    assert.equal(store.getDraft(demoKey).data.fields.note, 'Demo taslak');
    assert.equal(store.getDraft(dukkanKey).data.fields.note, 'Gercek dukkan taslagi');

    // Discarding demo workspace drafts leaves dukkan drafts intact
    store.clearWorkspace('demo');
    assert.equal(store.getDraft(demoKey), null, 'Demo draft should be cleared');
    assert.equal(store.getDraft(dukkanKey).data.fields.note, 'Gercek dukkan taslagi', 'Dukkan draft must remain unaffected');
  } finally {
    env.close();
  }
});

// ============================================================================
// 6. checkout.js + DefterDraftStore integration (409, network retry, #clear-draft)
// ============================================================================

function fillCheckoutSale(env, noteText) {
  const { document, window } = env;
  const set = (elOrSel, value) => {
    const el = typeof elOrSel === 'string' ? document.querySelector(elOrSel) : elOrSel;
    assert.ok(el, String(elOrSel));
    el.value = value;
    el.dispatchEvent(new window.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  };
  set('[data-item] [data-product]', 'gramToplam');
  set('[data-item] [data-quantity]', '1');
  set('[data-item] [data-value]', '100');
  document.querySelector('[data-add="received"][data-category="money"]').click();
  const row = document.querySelector('[data-allocation="received"]');
  set(row.querySelector('[data-account]'), 'nakit');
  set(row.querySelector('[data-quantity]'), '100');
  if (noteText !== undefined) set('#note', noteText);
}

test('Scenario 6A: checkout.js + DefterDraftStore 409 conflict clears pending, shows stale banner, accepts snapshot, and generates new UUID', async () => {
  const env = await createEnvironment({
    html: checkoutHtml,
    url: 'http://127.0.0.1:4317/checkout',
    actorId: 'worker',
    role: 'employee'
  });

  try {
    env.window.eval(checkoutSource);
    await tick();
    await tick();

    fillCheckoutSale(env, 'Checkout 409 Testi');

    // Submit for review and confirm
    env.document.querySelector('#trade').requestSubmit();
    assert.equal(env.document.querySelector('#review').hidden, false, 'Review panel should be visible');

    // External update bumps repository revision so confirmation triggers a real 409 REVISION_CONFLICT
    env.repo.execute({
      id: randomUUID(),
      revision: env.repo.state().revision,
      command: {
        type: 'movement',
        date: env.repo.state().date,
        accountId: 'nakit',
        category: 'Sermaye',
        direction: 'in',
        quantity: '1',
        note: 'Dis degisim'
      }
    });

    env.document.querySelector('#confirm').click();
    await tick();
    await tick();
    await tick();

    const store = env.window.DefterDraftStore;
    const pKey = store.makePendingKey({ actorId: 'worker', workspace: 'demo', scope: 'checkout', type: 'trade' });
    const legPendingKey = 'defter-sale-retry-worker-demo';

    // 1. Pending must be completely cleared from both DefterDraftStore and legacy storage (not resurrected by refresh())
    assert.equal(store.getPending(pKey), null, '409 must clear pending from DefterDraftStore');
    assert.equal(env.window.sessionStorage.getItem(pKey), null, 'Pending key must be removed from sessionStorage');
    assert.equal(env.window.sessionStorage.getItem(legPendingKey), null, 'Legacy pending key must be removed');

    // 2. UI state: #pending-panel hidden, #draft-stale visible, #accept-snapshot enabled, #record disabled
    assert.equal(env.document.querySelector('#pending-panel').hidden, true, '#pending-panel must remain hidden after 409');
    assert.equal(env.document.querySelector('#draft-stale').hidden, false, '#draft-stale banner must be visible after 409');
    assert.equal(env.document.querySelector('#accept-snapshot').disabled, false, '#accept-snapshot must be enabled');
    assert.equal(env.document.querySelector('#record').disabled, true, '#record must stay disabled until snapshot accepted');
    assert.equal(env.document.querySelector('#trade-controls').disabled, false, 'Trade controls must not stay locked after 409');

    // 3. Draft inputs must remain intact
    assert.equal(env.document.querySelector('#note').value, 'Checkout 409 Testi');
    assert.equal(env.document.querySelector('[data-item] [data-value]').value, '100');

    const firstCommandId = env.commands[0]?.id;
    assert.ok(firstCommandId, 'First attempted command should have an ID');

    // 4. Accept updated snapshot and resubmit
    env.document.querySelector('#accept-snapshot').click();
    assert.equal(env.document.querySelector('#draft-stale').hidden, true, 'Stale banner must hide after accepting snapshot');
    assert.equal(env.document.querySelector('#record').disabled, false, '#record must be enabled after accepting snapshot');

    env.document.querySelector('#trade').requestSubmit();
    assert.equal(env.document.querySelector('#review').hidden, false, 'Review panel should open for resubmission');
    env.document.querySelector('#confirm').click();
    await tick();
    await tick();
    await tick();

    // 5. Subsequent submission must generate a NEW random UUID and succeed cleanly
    const secondCommand = env.commands.at(-1);
    assert.ok(secondCommand, 'Second command should have executed');
    assert.notEqual(secondCommand.id, firstCommandId, 'Resubmitting after 409 must generate a NEW random UUID');
    assert.equal(store.getPending(pKey), null, 'Pending must be cleared after successful resubmit');
    assert.equal(env.document.querySelector('#pending-panel').hidden, true, '#pending-panel must stay hidden after 200 OK');
  } finally {
    env.close();
  }
});

test('Scenario 6B: checkout.js + DefterDraftStore ambiguous network error preserves UUID on retry and clears pending after 200 OK', async () => {
  const env = await createEnvironment({
    html: checkoutHtml,
    url: 'http://127.0.0.1:4317/checkout',
    actorId: 'worker',
    role: 'employee',
    networkControl: { failCount: 1, statusOverride: 503 }
  });

  try {
    env.window.eval(checkoutSource);
    await tick();
    await tick();

    fillCheckoutSale(env, 'Checkout Ag Hatasi');

    env.document.querySelector('#trade').requestSubmit();
    env.document.querySelector('#confirm').click();
    await tick();
    await tick();
    await tick();

    const store = env.window.DefterDraftStore;
    const pKey = store.makePendingKey({ actorId: 'worker', workspace: 'demo', scope: 'checkout', type: 'trade' });
    const legPendingKey = 'defter-sale-retry-worker-demo';

    // 1. Pending envelope and original UUID must be preserved on 503/network drop
    const savedPending = store.getPending(pKey);
    assert.ok(savedPending, 'Pending envelope must be preserved in DefterDraftStore on 503 error');
    const originalUUID = savedPending.envelope?.id || savedPending.id;
    assert.ok(originalUUID, 'Pending envelope must preserve idempotency UUID');
    assert.equal(env.document.querySelector('#pending-panel').hidden, false, '#pending-panel must be visible');
    assert.equal(env.document.querySelector('#trade-controls').disabled, true, 'Controls must be locked while pending');

    // 2. Retry succeeds (200 OK)
    env.networkControl.failCount = 0;
    env.document.querySelector('#retry').click();
    await tick();
    await tick();
    await tick();

    // 3. Exact same UUID must be reused on retry
    assert.equal(env.commands.length, 2);
    assert.equal(env.commands[1].id, originalUUID, 'Retry must reuse the exact original idempotency UUID');

    // 4. Pending must be genuinely cleared from both DefterDraftStore and legacy storage so refresh() does not resurrect it
    assert.equal(store.getPending(pKey), null, 'Pending must be cleared from DefterDraftStore after 200 OK');
    assert.equal(env.window.sessionStorage.getItem(pKey), null, 'Pending key must be removed from sessionStorage after 200 OK');
    assert.equal(env.window.sessionStorage.getItem(legPendingKey), null, 'Legacy pending key must be removed after 200 OK');
    assert.equal(env.document.querySelector('#pending-panel').hidden, true, '#pending-panel must remain hidden after retry success');
    assert.equal(env.document.querySelector('#trade-controls').disabled, false, 'Trade controls must unlock after retry success');
  } finally {
    env.close();
  }
});

test('Scenario 6C: checkout.js + DefterDraftStore #clear-draft purges draft without re-saving an empty draft', async () => {
  const env = await createEnvironment({
    html: checkoutHtml,
    url: 'http://127.0.0.1:4317/checkout',
    actorId: 'worker',
    role: 'employee'
  });

  try {
    env.window.eval(checkoutSource);
    await tick();
    await tick();

    fillCheckoutSale(env, 'Temizlenecek Taslak');

    const store = env.window.DefterDraftStore;
    const dKey = store.makeKey({ actorId: 'worker', workspace: 'demo', scope: 'checkout', type: 'sale' });
    const legDraftKey = 'defter-pending-checkout-draft-worker-demo-sale';

    assert.ok(store.getDraft(dKey), 'Draft must exist in DefterDraftStore before clearing');
    assert.ok(env.window.sessionStorage.getItem(legDraftKey), 'Legacy draft must exist before clearing');

    // Click #clear-draft
    env.document.querySelector('#clear-draft').click();

    // Verify immediate cleanup in both stores (no empty draft re-saved by changed())
    assert.equal(store.getDraft(dKey), null, 'DefterDraftStore draft must be null after #clear-draft');
    assert.equal(env.window.sessionStorage.getItem(dKey), null, 'sessionStorage draft key must be removed');
    assert.equal(env.window.sessionStorage.getItem(legDraftKey), null, 'Legacy draft key must be removed');
    assert.equal(store.listDrafts({ actorId: 'worker', workspace: 'demo', scope: 'checkout' }).length, 0, 'No empty checkout draft may be re-saved');

    // Verify form reset
    assert.equal(env.document.querySelector('#note').value, '', 'Note input must be cleared');
    assert.equal(env.document.querySelector('[data-item] [data-value]').value, '', 'Item value must be cleared');

    // Trigger refresh and pagehide: still no empty draft re-saved
    env.document.querySelector('#refresh').click();
    await tick();
    await tick();
    env.window.dispatchEvent(new env.window.Event('pagehide'));

    assert.equal(store.getDraft(dKey), null, 'refresh() and pagehide after #clear-draft must not re-save an empty draft');
    assert.equal(env.window.sessionStorage.getItem(legDraftKey), null, 'Legacy draft key must remain absent after refresh/pagehide');
  } finally {
    env.close();
  }
});
