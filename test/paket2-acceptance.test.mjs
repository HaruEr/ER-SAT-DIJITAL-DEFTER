import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { createApp } from '../server.mjs';
import { INITIAL_ACCOUNTS } from '../domain.mjs';

const uiKitSource = readFileSync(new URL('../public/ui-kit.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const checkoutSource = readFileSync(new URL('../public/checkout.js', import.meta.url), 'utf8');
const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const checkoutHtml = readFileSync(new URL('../public/checkout.html', import.meta.url), 'utf8');

function setupTestDom(html = '<!doctype html><html lang="tr"><body><div class="shell"><main id="main"><div id="notice" hidden></div><form id="sample-form"><input id="test-input" type="text" value="örnek"></form></main></div></body></html>') {
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:4317/', runScripts: 'outside-only' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.Node = dom.window.Node;
  dom.window.setTimeout = setTimeout;
  dom.window.clearTimeout = clearTimeout;
  dom.window.eval(uiKitSource);
  return { dom, UI: dom.window.DefterUI, doc: dom.window.document };
}

// ============================================================================
// R1.1: Routine success Toast acceptance tests
// ============================================================================

test('R1.1: Routine success Toast appears with role="status", auto-dismisses at 4000ms default, and does not steal focus', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { dom, UI, doc } = setupTestDom();

  const input = doc.getElementById('test-input');
  input.focus();
  assert.equal(doc.activeElement, input, 'Input must initially hold focus');

  // 1. Toast created with default options (kind: success, durationMs: 4000)
  const handle = UI.toast('Müşteri kartı oluşturuldu.');
  assert.ok(handle, 'Toast handle must be returned');

  // Focus preservation check: must NOT steal focus
  assert.equal(doc.activeElement, input, 'Toast must never steal focus from active form input');

  // Element attributes check
  const region = doc.getElementById('defter-toast-region');
  assert.ok(region, 'Toast region container must exist');
  assert.equal(region.getAttribute('aria-live'), 'polite');
  assert.equal(region.getAttribute('aria-atomic'), 'false');
  assert.equal(region.children.length, 1, 'Exactly one toast must be displayed');

  const toastEl = handle.element;
  assert.ok(toastEl.classList.contains('defter-toast--success'), 'Must have success class');
  assert.equal(toastEl.getAttribute('role'), 'status', 'Must have role=status');
  assert.equal(toastEl.querySelector('.defter-toast-body').textContent, 'Müşteri kartı oluşturuldu.');

  // Auto-dismiss check: 3999ms elapsed -> still present
  t.mock.timers.tick(3999);
  assert.equal(region.children.length, 1, 'Toast must remain visible at 3999ms');

  // At 4000ms -> auto-dismisses
  t.mock.timers.tick(1);
  assert.equal(region.children.length, 0, 'Toast must be auto-dismissed after exactly 4000ms');
  assert.equal(toastEl.isConnected, false, 'Toast DOM node must be removed');
});

test('R1.1: Routine success Toast supports immediate manual dismiss via close button', () => {
  const { UI, doc } = setupTestDom();
  const region = doc.getElementById('defter-toast-region') || (() => {
    UI.toast('Init');
    return doc.getElementById('defter-toast-region');
  })();
  UI.clearToasts();

  const handle = UI.toast('Satış işlemi tamamlandı.', { durationMs: 10000 });
  const toastRegion = doc.getElementById('defter-toast-region');
  assert.equal(toastRegion.children.length, 1);

  const closeBtn = handle.element.querySelector('.defter-toast-close');
  assert.ok(closeBtn, 'Close button must exist');
  assert.equal(closeBtn.getAttribute('aria-label'), 'Bildirimi kapat');

  // Click manual dismiss button
  closeBtn.click();
  assert.equal(toastRegion.children.length, 0, 'Toast must be removed immediately on manual close click');
  assert.equal(handle.element.isConnected, false);
});

test('R1.1: Routine success Toast pauses auto-dismiss timer on mouseenter and resumes on mouseleave', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { dom, UI, doc } = setupTestDom();

  const handle = UI.toast('Hover testi bildirimi');
  const region = doc.getElementById('defter-toast-region');
  assert.equal(region.children.length, 1);

  // Advance 2000ms (half of 4000ms)
  t.mock.timers.tick(2000);
  assert.equal(region.children.length, 1);

  // Hover into toast
  handle.element.dispatchEvent(new dom.window.Event('mouseenter'));

  // Advance another 5000ms (total 7000ms elapsed since creation)
  t.mock.timers.tick(5000);
  assert.equal(region.children.length, 1, 'Toast must remain visible while hovered, timer must be paused');

  // Mouse leaves toast -> timer resumes for full duration (4000ms)
  handle.element.dispatchEvent(new dom.window.Event('mouseleave'));

  t.mock.timers.tick(3999);
  assert.equal(region.children.length, 1, 'Toast must remain visible 3999ms after mouseleave');

  t.mock.timers.tick(1);
  assert.equal(region.children.length, 0, 'Toast must be auto-dismissed 4000ms after mouseleave');
});

test('R1.1: Routine success Toast pauses auto-dismiss timer on focusin and resumes on focusout', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { dom, UI, doc } = setupTestDom();

  const handle = UI.toast('Focus testi bildirimi');
  const region = doc.getElementById('defter-toast-region');
  assert.equal(region.children.length, 1);

  // Advance 2000ms
  t.mock.timers.tick(2000);

  // Focus moves into toast
  handle.element.dispatchEvent(new dom.window.Event('focusin'));

  // Advance 5000ms
  t.mock.timers.tick(5000);
  assert.equal(region.children.length, 1, 'Toast must remain visible while focused');

  // Focus leaves toast
  handle.element.dispatchEvent(new dom.window.Event('focusout'));

  t.mock.timers.tick(3999);
  assert.equal(region.children.length, 1, 'Toast must remain visible 3999ms after focusout');

  t.mock.timers.tick(1);
  assert.equal(region.children.length, 0, 'Toast must auto-dismiss after focusout timeout completes');
});

// ============================================================================
// R1.2: Critical financial banner acceptance tests
// ============================================================================

test('R1.2: Critical financial banner (409 conflict, error) has NO auto-dismiss timer and persists indefinitely until cleared', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { UI, doc } = setupTestDom();
  const notice = doc.getElementById('notice');

  // Show critical revision conflict error
  UI.showBanner(notice, '409 Revizyon çakışması: Başka sekmede işlem yapıldı. Defteri yenileyin.', { kind: 'error', focus: false });

  assert.equal(notice.hidden, false, 'Banner must be visible');
  assert.equal(notice.getAttribute('role'), 'alert', 'Critical banner must have role=alert');
  assert.equal(notice.getAttribute('aria-live'), 'assertive', 'Critical banner must be assertive');
  assert.equal(notice.getAttribute('aria-atomic'), 'true');
  assert.ok(notice.classList.contains('error'), 'Must have error class');
  assert.match(notice.textContent, /409 Revizyon çakışması/);

  // Advance virtual time by 5s, 30s, 60s, 300s (5 minutes)
  t.mock.timers.tick(5000);
  assert.equal(notice.hidden, false, 'Banner must NOT auto-dismiss after 5s');

  t.mock.timers.tick(25000);
  assert.equal(notice.hidden, false, 'Banner must NOT auto-dismiss after 30s');

  t.mock.timers.tick(270000);
  assert.equal(notice.hidden, false, 'Banner must persist indefinitely without auto-dismiss');

  // Explicit clearing
  UI.clearBanner(notice);
  assert.equal(notice.hidden, true, 'Banner must be hidden after explicit clearBanner call');
  assert.equal(notice.textContent, '', 'Banner content must be cleared');
  assert.equal(notice.className, 'notice', 'Class must reset to base notice');
});

test('R1.2: Daily closing persistent alert banner remains indefinitely until explicitly cleared', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { UI, doc } = setupTestDom();
  const notice = doc.getElementById('notice');

  // Persistent informational closing notice (e.g. backup status verification)
  UI.showBanner(notice, 'GÜN KAPANDI. Dosya yedeği doğrulandı: defter-backup-2026-11-16.sqlite', { kind: 'info' });

  assert.equal(notice.hidden, false);
  assert.equal(notice.getAttribute('role'), 'status');
  assert.equal(notice.getAttribute('aria-live'), 'polite');

  // Advance time by 60 seconds
  t.mock.timers.tick(60000);
  assert.equal(notice.hidden, false, 'Persistent info banner must not auto-dismiss');

  // Now simulate closing backup failure (critical error banner)
  UI.showBanner(notice, 'GÜN KAPANDI ve yeni gün açıldı; ancak YEDEK ALINAMADI: Disk dolu hatası.', { kind: 'error' });
  assert.equal(notice.hidden, false);
  assert.equal(notice.getAttribute('role'), 'alert');
  assert.ok(notice.classList.contains('error'));

  // Advance time by 120 seconds
  t.mock.timers.tick(120000);
  assert.equal(notice.hidden, false, 'Critical closing alert must remain visible until user dismisses it');

  UI.clearBanner(notice);
  assert.equal(notice.hidden, true);
});

test('R1.1 & R1.2: app.js inform() routes all routine and error notices to auto-dismissing Toast', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { dom, UI, doc } = setupTestDom(indexHtml);
  const notice = doc.getElementById('notice');

  // Genuine evaluation of public/app.js exporting inform to window
  dom.window.eval(appSource + '\nwindow.__inform = inform;');
  const inform = dom.window.__inform;

  // 1. Error inform fires an error Toast (role="alert", auto-dismisses at 6000ms) and keeps #notice hidden
  inform('Önceki hata mesajı', true);
  assert.equal(notice.hidden, true);
  const region = doc.getElementById('defter-toast-region');
  assert.equal(region.children.length, 1);
  assert.equal(region.children[0].classList.contains('defter-toast--error'), true);
  assert.equal(region.children[0].getAttribute('role'), 'alert');
  t.mock.timers.tick(6000);
  assert.equal(region.children.length, 0, 'Error toast auto-dismisses at 6000ms');

  // 2. Routine success inform fires a success Toast (auto-dismisses at 4000ms)
  inform('Satış kaydı başarıyla oluşturuldu.');
  assert.equal(notice.hidden, true);
  assert.equal(region.children.length, 1, 'Toast must appear for routine success');
  assert.equal(region.children[0].querySelector('.defter-toast-body').textContent, 'Satış kaydı başarıyla oluşturuldu.');
  t.mock.timers.tick(4000);
  assert.equal(region.children.length, 0, 'Routine success toast auto-dismisses at 4000ms');

  // 3. 409 Revision Conflict error also routes to error Toast
  inform('409 Revizyon çakışması: Başka sekmede işlem yapıldı.', true);
  assert.equal(notice.hidden, true);
  assert.equal(region.children.length, 1);
  assert.equal(region.children[0].classList.contains('defter-toast--error'), true);
  t.mock.timers.tick(6000);
  assert.equal(region.children.length, 0);
});

// ============================================================================
// R1.3: Modal/Drawer focus trap, trigger restoration & draft preservation
// ============================================================================

test('R1.3: Modal and Drawer trap Tab and Shift+Tab focus navigation within their interactive boundaries', () => {
  const { dom, UI, doc } = setupTestDom();
  const trigger = doc.createElement('button');
  trigger.id = 'trigger-btn';
  trigger.textContent = 'Müşteri Ekle';
  doc.getElementById('main').append(trigger);
  trigger.focus();

  const drawerContent = doc.createElement('div');
  const input1 = doc.createElement('input');
  input1.id = 'drawer-name';
  const input2 = doc.createElement('input');
  input2.id = 'drawer-phone';
  const saveBtn = doc.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.textContent = 'Kaydet';
  drawerContent.append(input1, input2, saveBtn);

  const drawer = UI.openDrawer({
    title: 'Hızlı Müşteri Kartı',
    content: drawerContent,
    trigger
  });

  assert.equal(UI.getLayerCount(), 1);
  assert.equal(doc.querySelector('.shell').getAttribute('aria-hidden'), 'true', 'Background must be marked inert');

  const closeBtn = drawer.dialog.querySelector('.defter-dialog-close');
  assert.ok(closeBtn, 'Close button must be present in drawer header');

  // Tab navigation from save button (last item) must wrap around to close button or first item
  saveBtn.focus();
  assert.equal(doc.activeElement, saveBtn);
  drawer.dialog.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  assert.ok(drawer.dialog.contains(doc.activeElement), 'Focus must remain trapped inside dialog on Tab from last element');
  assert.equal(doc.activeElement, closeBtn, 'Tab from last element must wrap to first focusable element');

  // Shift+Tab navigation from close button (first item) must wrap to save button (last item)
  closeBtn.focus();
  drawer.dialog.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
  assert.equal(doc.activeElement, saveBtn, 'Shift+Tab from first element must wrap to last focusable element');

  drawer.close();
});

test('R1.3: Modal/Drawer restores focus to the triggering element upon close', () => {
  const { dom, UI, doc } = setupTestDom();
  const trigger = doc.createElement('button');
  trigger.id = 'open-dialog-trigger';
  trigger.textContent = 'Kritik Onay Aç';
  doc.getElementById('main').append(trigger);
  trigger.focus();
  assert.equal(doc.activeElement, trigger);

  const modal = UI.openModal({
    title: 'İşlemi Onaylayın',
    content: '<p>Emin misiniz?</p>',
    trigger
  });

  assert.equal(UI.getLayerCount(), 1);
  assert.notEqual(doc.activeElement, trigger, 'Focus must move into modal');

  // Close via Escape key
  modal.dialog.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(UI.getLayerCount(), 0);
  assert.equal(doc.activeElement, trigger, 'Focus must be restored to trigger button after modal close');
  assert.equal(doc.querySelector('.shell').getAttribute('aria-hidden'), null, 'Background inert state must be removed');
});

test('R1.3: Customer Drawer opening and closing preserves background form drafts in #main completely intact', () => {
  const html = `<!doctype html><html lang="tr"><body>
    <div class="shell">
      <main id="main">
        <form id="transaction-form" data-draft-dirty="true">
          <input id="f-counterpartyId" name="counterpartyId" value="musteri-synth-88">
          <input id="f-item-qty" name="quantity" value="18.750">
          <input id="f-item-price" name="priceTL" value="54300.00">
          <textarea id="f-note" name="note">Özel sipariş avans kaydı</textarea>
          <button id="open-customer-drawer-btn" type="button">Hızlı müşteri kartı oluştur</button>
        </form>
      </main>
    </div>
  </body></html>`;

  const { dom, UI, doc } = setupTestDom(html);
  const triggerBtn = doc.getElementById('open-customer-drawer-btn');
  const counterpartyInput = doc.getElementById('f-counterpartyId');
  const qtyInput = doc.getElementById('f-item-qty');
  const priceInput = doc.getElementById('f-item-price');
  const noteInput = doc.getElementById('f-note');
  const form = doc.getElementById('transaction-form');

  triggerBtn.focus();

  // Create drawer content
  const drawerForm = doc.createElement('form');
  drawerForm.innerHTML = '<input id="drawer-cust-name" value="Mehmet Demir"><button type="button" id="drawer-cancel">Vazgeç</button>';

  const drawer = UI.openDrawer({
    title: 'Yeni Müşteri Kartı',
    content: drawerForm,
    trigger: triggerBtn
  });

  // Verify background is inert during drawer display
  assert.equal(doc.querySelector('.shell').getAttribute('aria-hidden'), 'true');

  // Verify form inputs in background #main are untouched while drawer is open
  assert.equal(counterpartyInput.value, 'musteri-synth-88');
  assert.equal(qtyInput.value, '18.750');
  assert.equal(priceInput.value, '54300.00');
  assert.equal(noteInput.value, 'Özel sipariş avans kaydı');
  assert.equal(form.dataset.draftDirty, 'true');

  // Close drawer (e.g. user cancels or hits Escape)
  drawer.close('cancel');

  // Verify inert removed and focus returned to triggering button
  assert.equal(doc.querySelector('.shell').getAttribute('aria-hidden'), null);
  assert.equal(doc.activeElement, triggerBtn, 'Focus must return to triggering button');

  // Verify all background form inputs retain their draft values verbatim
  assert.equal(counterpartyInput.value, 'musteri-synth-88', 'Counterparty input draft must remain intact');
  assert.equal(qtyInput.value, '18.750', 'Quantity draft must remain intact');
  assert.equal(priceInput.value, '54300.00', 'Price draft must remain intact');
  assert.equal(noteInput.value, 'Özel sipariş avans kaydı', 'Note draft must remain intact');
  assert.equal(form.dataset.draftDirty, 'true', 'Draft dirty attribute must remain intact');
});

test('R1.3: Layer stack methods getLayerCount(), topLayer(), and closeTopLayer() operate deterministically', () => {
  const { dom, UI, doc } = setupTestDom();

  assert.equal(UI.getLayerCount(), 0);
  assert.equal(UI.topLayer(), null);
  assert.equal(UI.closeTopLayer(), false);

  const layer1 = UI.openDrawer({ title: 'Layer 1' });
  assert.equal(UI.getLayerCount(), 1);
  assert.equal(UI.topLayer().dialog, layer1.dialog);

  const layer2 = UI.openModal({ title: 'Layer 2' });
  assert.equal(UI.getLayerCount(), 2);
  assert.equal(UI.topLayer().dialog, layer2.dialog);
  assert.equal(layer1.dialog.getAttribute('aria-hidden'), 'true', 'Underlying layer must be aria-hidden');

  // Close topmost layer
  const closedTop = UI.closeTopLayer('test');
  assert.equal(closedTop, true);
  assert.equal(UI.getLayerCount(), 1);
  assert.equal(UI.topLayer().dialog, layer1.dialog);
  assert.equal(layer1.dialog.getAttribute('aria-hidden'), null, 'Resumed top layer must have aria-hidden cleared');

  // Close remaining layer
  assert.equal(UI.closeTopLayer(), true);
  assert.equal(UI.getLayerCount(), 0);
  assert.equal(UI.topLayer(), null);
});

// ============================================================================
// R1.4: Employee vs admin notifications and role isolation
// ============================================================================

async function serverFixture(t) {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'paket2-employee-boundary-'));
  const { server, repositories } = createApp({ dataDirectory, logger: () => {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  t.after(async () => {
    await new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    });
    rmSync(dataDirectory, { recursive: true, force: true });
  });

  const base = 'http://127.0.0.1:' + server.address().port;
  function api(path, token, body, method = body !== undefined ? 'POST' : 'GET') {
    const headers = token ? { Authorization: 'Bearer ' + token } : {};
    return fetch(base + path, {
      method,
      headers: body !== undefined ? { ...headers, 'Content-Type': 'application/json' } : headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  }

  return { api, repositories, base };
}

test('R1.4: Server-side 403 enforcement strictly blocks employee from accessing store totals, ledgers, suppliers, and admin routes', async t => {
  const { api } = await serverFixture(t);

  // 1. Setup owner
  const setupRes = await api('/api/auth/setup', null, { name: 'Patron', pin: '112233' });
  assert.equal(setupRes.status, 201);
  const owner = await setupRes.json();

  // 2. Create employee
  const createEmpRes = await api('/api/auth/employees', owner.token, { name: 'Tezgâhtar', pin: '445566' });
  assert.equal(createEmpRes.status, 201);
  const empProfile = await createEmpRes.json();

  // 3. Employee login + mandatory first-login PIN change
  const loginRes = await api('/api/auth/login', null, { id: empProfile.id, pin: '445566' });
  assert.equal(loginRes.status, 200);
  const worker = await loginRes.json();
  assert.equal((await api('/api/auth/change-pin', worker.token, { currentPin: '445566', newPin: '778899' })).status, 200);

  // 4. Initialize store ledger with sensitive financial balances
  const initial = await (await api('/api/state', owner.token)).json();
  const openingBalances = Object.fromEntries(initial.accounts.filter(a => !a.retired).map(a => [a.id, a.id === 'nakit' ? '5000000' : a.id === 'ceyrek' ? '20' : '0']));
  await api('/api/command', owner.token, { id: 'init-open', revision: 0, command: { type: 'opening', date: '2026-11-16', balances: openingBalances } });

  // Add a sensitive supplier account
  await api('/api/command', owner.token, {
    id: 'add-supplier',
    revision: 1,
    command: { type: 'account', date: '2026-11-16', name: 'Kapalıçarşı Altın Toptan A.Ş.', unit: 'HAS', opening: '350000', partyType: 'supplier' }
  });

  // 5. Verify server-side 403 Forbidden for employee across all sensitive endpoints
  const sensitiveGetRoutes = [
    '/api/state',
    '/api/journal',
    '/api/suppliers',
    '/api/account-statement',
    '/api/summary',
    '/api/backup',
    '/api/archive',
    '/api/recovery'
  ];

  for (const route of sensitiveGetRoutes) {
    const res = await api(route, worker.token);
    assert.equal(res.status, 403, `Employee access to ${route} must return 403 Forbidden`);
    const data = await res.json();
    assert.match(data.error, /yönetici oturumu gerekli/i, `Error message for ${route} must require owner role`);
  }

  // Verify write routes denied to employee
  const deniedCommands = [
    { type: 'close' },
    { type: 'movement', accountId: 'nakit', direction: 'out', quantity: '1000' },
    { type: 'account', name: 'Kaçak Toptancı', unit: 'TL', opening: '0', partyType: 'supplier' },
    { type: 'amend' },
    { type: 'reverse' },
    { type: 'opening' }
  ];

  for (const command of deniedCommands) {
    const res = await api('/api/command', worker.token, { id: 'denied-cmd', revision: 2, command });
    assert.equal(res.status, 403, `Employee command ${command.type} must return 403 Forbidden`);
  }
});

test('R1.4: Employee GET /api/checkout and POST /api/command never leak store balances, capital, or supplier data', async t => {
  const { api } = await serverFixture(t);

  // Setup owner & employee
  const setupRes = await api('/api/auth/setup', null, { name: 'Patron', pin: '112233' });
  const owner = await setupRes.json();
  const createEmpRes = await api('/api/auth/employees', owner.token, { name: 'Tezgâhtar', pin: '445566' });
  const empProfile = await createEmpRes.json();
  const loginRes = await api('/api/auth/login', null, { id: empProfile.id, pin: '445566' });
  const worker = await loginRes.json();
  assert.equal((await api('/api/auth/change-pin', worker.token, { currentPin: '445566', newPin: '778899' })).status, 200);

  // Ledger with sensitive capital (5,000,000 TL) and supplier
  const initial = await (await api('/api/state', owner.token)).json();
  const openingBalances = Object.fromEntries(initial.accounts.filter(a => !a.retired).map(a => [a.id, a.id === 'nakit' ? '5000000' : a.id === 'ceyrek' ? '15' : '0']));
  await api('/api/command', owner.token, { id: 'init-open', revision: 0, command: { type: 'opening', date: '2026-11-16', balances: openingBalances } });
  await api('/api/command', owner.token, {
    id: 'add-supplier',
    revision: 1,
    command: { type: 'account', date: '2026-11-16', name: 'Gizli Toptancı Ltd.', unit: 'HAS', opening: '750000', partyType: 'supplier' }
  });

  // 1. Employee fetches checkout state
  const checkoutRes = await api('/api/checkout', worker.token);
  assert.equal(checkoutRes.status, 200, 'Employee checkout endpoint must be accessible');
  const checkoutData = await checkoutRes.json();

  // Check top-level keys (includes blind countItems catalog with zero balances)
  const expectedKeys = ['countItems', 'date', 'initialized', 'inventoryItems', 'payments', 'products', 'revision', 'stocks'];
  assert.deepEqual(Object.keys(checkoutData).sort(), expectedKeys, 'Checkout keys must strictly match expected whitelist');
  assert.ok(Array.isArray(checkoutData.countItems), 'countItems must be an array');
  for (const ci of checkoutData.countItems) {
    assert.deepEqual(Object.keys(ci).sort(), ['group', 'id', 'name', 'unit'], `countItem ${ci.id} must omit balances/expected`);
    assert.equal(['bilezik22', 'taki14', 'taki22'].includes(ci.id), false, `Private pool ${ci.id} must never appear in countItems`);
  }

  // Verify NO balances, capital, journal or supplier data are present
  assert.equal(checkoutData.balances, undefined, 'Store balances must NOT be exposed in checkout');
  assert.equal(checkoutData.capital, undefined, 'Store capital must NOT be exposed in checkout');
  assert.equal(checkoutData.journal, undefined, 'Journal entries must NOT be exposed in checkout');
  assert.equal(checkoutData.suppliers, undefined, 'Suppliers must NOT be exposed in checkout');

  // Inspect payments array: must contain only { id, name, unit }, zero balance information
  assert.ok(Array.isArray(checkoutData.payments));
  for (const p of checkoutData.payments) {
    assert.deepEqual(Object.keys(p).sort(), ['id', 'name', 'unit'], `Payment option ${p.id} must omit balances`);
    assert.equal(p.balance, undefined);
    assert.equal(p.quantity, undefined);
  }

  // Inspect raw JSON: secret supplier name and capital amount must never appear anywhere in checkout JSON
  const rawJson = JSON.stringify(checkoutData);
  assert.equal(rawJson.includes('Gizli Toptancı Ltd.'), false, 'Supplier name must not leak into checkout payload');
  assert.equal(rawJson.includes('5000000'), false, 'Sensitive store cash balance must not leak into checkout payload');
  assert.equal(rawJson.includes('750000'), false, 'Supplier debt balance must not leak into checkout payload');

  // 2. Employee cannot bypass approval queue via POST /api/command, and POST /api/pending-approvals never leaks balances
  const saleCommand = {
    type: 'sale',
    date: '2026-11-16',
    counterpartyType: 'customer',
    items: [{ accountId: 'ceyrek', quantity: '1', value: '4500' }],
    received: [{ accountId: 'nakit', quantity: '4500', valueTL: '4500' }]
  };

  const directSaleRes = await api('/api/command', worker.token, { id: 'worker-sale-direct', revision: 2, command: saleCommand });
  assert.equal(directSaleRes.status, 403, 'Employee sale via /api/command must be blocked by Maker-Checker gate');
  assert.equal((await directSaleRes.json()).code, 'APPROVAL_REQUIRED');

  const saleRes = await api('/api/pending-approvals', worker.token, { id: 'worker-sale-1', revision: 2, command: saleCommand });
  assert.equal(saleRes.status, 201);
  const saleResult = await saleRes.json();

  // Response must be strictly limited to submission metadata (no ledger totals, balances, or journal)
  assert.deepEqual(Object.keys(saleResult).sort(), ['duplicate', 'id', 'status', 'submittedAt', 'summary'], 'Pending result must omit ledger totals and journal');
  assert.equal(saleResult.id, 'worker-sale-1');
  assert.equal(saleResult.status, 'pending');
  assert.equal(saleResult.duplicate, false);
  const saleRaw = JSON.stringify(saleResult);
  assert.equal(saleRaw.includes('Gizli Toptancı Ltd.'), false);
  assert.equal(saleRaw.includes('5000000'), false);
  assert.equal(saleRaw.includes('750000'), false);
});

test('R1.4: Employee checkout UI notification channel restricts status messages to operational confirmation and suppresses administrative financial data', async () => {
  const dom = new JSDOM(checkoutHtml, { url: 'http://127.0.0.1:4317/checkout', runScripts: 'outside-only' });
  const pendingData = {
    envelope: { id: 'sale-tx-991', revision: 3, command: { type: 'sale', date: '2026-11-16' } },
    kind: 'trade',
    operation: 'sale',
    workspace: 'demo'
  };
  dom.window.sessionStorage.setItem('defter-sale-retry-worker-1-demo', JSON.stringify(pendingData));

  let approvalCalled = false;
  dom.window.DefterSession = {
    current: () => ({ actor: { id: 'worker-1', name: 'Tezgâhtar', role: 'employee' } }),
    api: async (url, body) => {
      if (url.includes('pending-approvals') && body) {
        approvalCalled = true;
        return { id: 'sale-tx-991', status: 'pending', duplicate: false };
      }
      if (url.includes('pending-approvals')) {
        return { items: [] };
      }
      if (url.includes('checkout')) {
        return { initialized: true, date: '2026-11-16', revision: 4, products: [], inventoryItems: [], payments: [], stocks: [], countItems: [] };
      }
      return {};
    }
  };

  // Genuine evaluation of public/checkout.js
  dom.window.eval(checkoutSource);

  // Trigger retry button click to execute sendPending() from checkout.js
  const retryBtn = dom.window.document.getElementById('retry');
  retryBtn.click();

  // Allow async sendPending -> api -> status to settle
  await new Promise(resolve => setTimeout(resolve, 50));

  assert.ok(approvalCalled, 'sendPending() in checkout.js must call api(pending-approvals) for employee trade');
  const statusEl = dom.window.document.getElementById('status');
  assert.equal(statusEl.getAttribute('role'), 'status');
  assert.equal(statusEl.getAttribute('aria-live'), 'polite');
  assert.equal(statusEl.textContent, 'İşlem bildirimi yönetici onayına gönderildi. Bildirim sale-tx-991');

  // Verify that financial balances, profit/loss, and store capital never leak into the status channel
  assert.doesNotMatch(statusEl.textContent, /kasa|mevcut|bakiye|sermaye|kar|borç|has gr/i);
});

