import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadJSDOM } from '../test-support/jsdom.mjs';
import { createApp } from '../server.mjs';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS } from '../domain.mjs';
import { appendHistoricalEvent } from '../test-support/historical-supplier.mjs';
import { supplierDocuments } from '../supplier-ledger.mjs';
import * as suppliersModule from '../public/suppliers.js';
import '../public/search-norm.js';

const JSDOM = await loadJSDOM();
const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const checkoutHtml = readFileSync(new URL('../public/checkout.html', import.meta.url), 'utf8');
const searchNormSrc = readFileSync(new URL('../public/search-norm.js', import.meta.url), 'utf8');
const uiKitSrc = readFileSync(new URL('../public/ui-kit.js', import.meta.url), 'utf8');
const comboboxSrc = readFileSync(new URL('../public/combobox.js', import.meta.url), 'utf8');
const paletteSrc = readFileSync(new URL('../public/command-palette.js', import.meta.url), 'utf8');
const amountCodecSrc = readFileSync(new URL('../public/amount-codec.js', import.meta.url), 'utf8');
const draftStoreSrc = readFileSync(new URL('../public/draft-store.js', import.meta.url), 'utf8');
const accessClientSrc = readFileSync(new URL('../public/access-client.js', import.meta.url), 'utf8');
const dateFormatSrc = readFileSync(new URL('../public/date-format.js', import.meta.url), 'utf8');
const appSrc = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const checkoutSrc = readFileSync(new URL('../public/checkout.js', import.meta.url), 'utf8');

function createDom(
  html = '<!doctype html><html lang="tr"><body><div class="shell"><main id="main"><button id="trig" type="button" data-command-palette-trigger>Komut</button></main></div></body></html>',
  url = 'http://127.0.0.1:4317/owner#v=overview'
) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.eval(searchNormSrc);
  dom.window.eval(uiKitSrc);
  dom.window.eval(amountCodecSrc);
  dom.window.eval(draftStoreSrc);
  dom.window.eval(comboboxSrc);
  dom.window.eval(paletteSrc);
  return dom;
}

const tick = (ms = 25) => new Promise(r => setTimeout(r, ms));
const keyEv = (win, key, opts = {}) => new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts });
const inputEv = win => new win.Event('input', { bubbles: true });

// ============================================================================
// PART 1: M2 / M3 / Core Layering / Security Adversarial Suite (T5-1 .. T5-10)
// ============================================================================

// T5-1: Stacked Drawer + Ctrl+K real history.back() (popstate) unwind
test('T5-1. Stacked DefterUI drawer + Ctrl+K real history.back() unwinds only palette, preserves drawer & focus, and cleanly closes drawer on Escape', async () => {
  const dom = createDom();
  const { window } = dom;
  const { document } = window;
  const ui = window.DefterUI;
  const cp = window.DefterCommandPalette;
  cp.registerProvider('nav', [{ id: 'a', title: 'Öğe A' }]);

  const trig = document.getElementById('trig');
  trig.focus();
  const drawerInput = document.createElement('input');
  drawerInput.id = 'drawer-input';
  const drawer = ui.openDrawer({ title: 'Yeni Müşteri', content: drawerInput, trigger: trig });
  drawerInput.focus();
  assert.equal(ui.getLayerCount(), 1);

  cp.open({ trigger: drawerInput });
  assert.equal(ui.getLayerCount(), 2);
  assert.equal(drawer.dialog.getAttribute('aria-hidden'), 'true');
  assert.equal(document.querySelector('.shell').getAttribute('aria-hidden'), 'true');

  let bubblePopCalls = 0;
  window.addEventListener('popstate', () => { bubblePopCalls++; });

  window.history.back();
  await tick(35);

  assert.equal(cp.isOpen(), false, 'popstate must close Command Palette');
  assert.equal(ui.getLayerCount(), 1, 'underlying drawer must stay open');
  assert.equal(drawer.dialog.isConnected, true);
  assert.equal(drawer.dialog.getAttribute('aria-hidden'), null);
  assert.equal(document.querySelector('.shell').getAttribute('aria-hidden'), 'true');
  assert.equal(document.activeElement, drawerInput, 'focus must return to drawer input');
  assert.equal(bubblePopCalls, 0, 'bubble-phase popstate must not fire while drawer remains');

  drawer.dialog.dispatchEvent(keyEv(window, 'Escape'));
  await tick(35);
  assert.equal(ui.getLayerCount(), 0);
  assert.equal(document.querySelector('.shell').getAttribute('aria-hidden'), null);
  assert.equal(document.activeElement, trig, 'focus must return to drawer trigger');

  cp.destroy();
  window.close();
});

// T5-2: Prototype pollution, tampered-DOM disabled click, and Gap 4 disabled setValue / select.value rejection vs allowDisabled
test('T5-2. Prototype-pollution IDs, DOM-tampered disabled items, and disabled setValue()/select.value are rejected by default while {allowDisabled:true} restores explicitly', () => {
  const dom = createDom();
  const { window } = dom;
  const { document } = window;
  const select = document.createElement('select');
  document.querySelector('main').append(select);
  const cb = window.DefterCombobox.enhanceSelect(select, {
    value: 'ok-1',
    items: [
      { id: 'ok-1', label: 'Aktif Kart' },
      { id: 'ret-1', label: 'Emekli Kart', retired: true, disabledReason: 'Pasif' }
    ]
  });

  for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.equal(cb.hasValue(key), false, `hasValue(${key}) must be false`);
    assert.equal(cb.setValue(key), false, `setValue(${key}) must be false`);
    assert.equal(cb.getValue(), 'ok-1');
  }
  assert.equal(({}).polluted, undefined);

  // Gap 4: setValue(disabledId) & select.value = disabledId rejected by default
  assert.equal(cb.setValue('ret-1'), false, 'setValue(disabledId) must return false by default');
  assert.equal(cb.getValue(), 'ok-1');
  assert.equal(select.value, 'ok-1');

  select.value = 'ret-1';
  assert.equal(cb.getValue(), 'ok-1', 'select.value = disabledId must not commit disabled item');
  assert.equal(select.value, 'ok-1', 'backing select.value must remain unchanged');

  // Explicit { allowDisabled: true } permitted for draft restoration
  assert.equal(cb.setValue('ret-1', { allowDisabled: true }), true, 'setValue(disabledId, { allowDisabled: true }) must succeed');
  assert.equal(cb.getValue(), 'ret-1');
  assert.equal(select.value, 'ret-1');
  assert.equal(cb.setValue('ok-1'), true);

  cb.open();
  const retiredBtn = cb.listbox.querySelectorAll('[role="option"]')[1];
  assert.equal(retiredBtn.getAttribute('aria-disabled'), 'true');
  retiredBtn.removeAttribute('aria-disabled');
  retiredBtn.click();
  assert.equal(cb.getValue(), 'ok-1', 'Tampered DOM click must not select retired item');

  const cp = window.DefterCommandPalette;
  let disabledRan = 0;
  cp.registerProvider('sec', [
    { id: '__proto__', title: 'Proto Test', action: () => {} },
    { id: 'disabled-cmd', title: 'Pasif Komut', disabled: true, action: () => { disabledRan++; } }
  ]);
  cp.open();
  const disBtn = document.querySelector('[data-command-id="disabled-cmd"]');
  disBtn.removeAttribute('aria-disabled');
  disBtn.click();
  assert.equal(disabledRan, 0, 'Tampered disabled command must not execute');

  cb.destroy();
  cp.destroy();
  window.close();
});

// T5-3 (Gap 1): Combobox setItems() mid-open & committed item removal
test('T5-3. Combobox setItems() while open preserves full list on renamed committed label and clears removed committed value', () => {
  const dom = createDom();
  const { window } = dom;
  const { document } = window;
  const select = document.createElement('select');
  document.querySelector('main').append(select);

  const cb = window.DefterCombobox.enhanceSelect(select, {
    items: [
      { id: 'c1', label: 'Birinci Müşteri' },
      { id: 'c2', label: 'İkinci Müşteri' }
    ],
    value: 'c1'
  });

  cb.open();
  cb.setItems([
    { id: 'c1', label: 'Birinci Müşteri (Güncel)' },
    { id: 'c2', label: 'İkinci Müşteri' },
    { id: 'c3', label: 'Üçüncü Müşteri' }
  ]);
  assert.equal(cb.input.value, 'Birinci Müşteri (Güncel)', 'Committed label rename must sync input.value');
  assert.equal(cb.listbox.querySelectorAll('[role="option"]').length, 3, 'All 3 items must remain visible while open without stale-label filtering');

  cb.setItems([{ id: 'c2', label: 'İkinci Müşteri' }]);
  assert.equal(cb.getValue(), '', 'Removed committed ID must be cleared');
  assert.equal(select.value, '', 'Backing <select> must not keep removed option');

  cb.destroy();
  window.close();
});

// T5-4 (Gap 2): CommandPalette executeItem() re-evaluates item.when() and provider.when() at execution time
test('T5-4. CommandPalette executeItem() re-evaluates item.when() and provider.when() at execution time and blocks stale gated items', () => {
  const dom = createDom();
  const { window } = dom;
  const { document } = window;
  const cp = window.DefterCommandPalette;
  let itemAllowed = true;
  let providerAllowed = true;
  let ran = 0;

  cp.registerProvider('gated', [
    { id: 'gated-cmd', title: 'Kritik İşlem', when: () => itemAllowed, action: () => { ran++; } }
  ]);
  cp.registerProvider({
    id: 'gated-prov',
    when: () => providerAllowed,
    items: [
      { id: 'prov-cmd', title: 'Sağlayıcı Kapısı', action: () => { ran++; } }
    ]
  });

  cp.open();
  itemAllowed = false;
  document.querySelector('[data-command-id="gated-cmd"]').click();
  assert.equal(ran, 0, 'Command whose item.when() became false must NOT execute');
  assert.equal(document.querySelector('[data-command-id="gated-cmd"]'), null, 'Stale item removed after refresh');

  providerAllowed = false;
  document.querySelector('[data-command-id="prov-cmd"]').click();
  assert.equal(ran, 0, 'Command whose provider.when() became false must NOT execute');
  assert.equal(document.querySelector('[data-command-id="prov-cmd"]'), null, 'Stale provider items removed after refresh');

  cp.destroy();
  window.close();
});

// T5-5 (Gap 3): CommandPalette detached dialog mid-async search
test('T5-5. CommandPalette detached <dialog> mid-async search releases DefterUI layer and discards late results', async () => {
  const dom = createDom();
  const { window } = dom;
  const { document } = window;
  const ui = window.DefterUI;
  const cp = window.DefterCommandPalette;
  cp.configure({ debounceMs: 0 });

  let resolveSearch;
  cp.registerProvider('async', {
    search: () => new Promise(r => { resolveSearch = r; })
  });

  cp.open({ initialQuery: 'abc' });
  assert.equal(ui.getLayerCount(), 1);
  const dlg = document.querySelector('[data-command-palette]');
  dlg.remove();

  resolveSearch([{ id: 'late-1', title: 'Geç Sonuç' }]);
  await tick(20);

  assert.equal(dlg.querySelectorAll('[data-command-id="late-1"]').length, 0, 'Detached dialog must not be populated after removal');
  assert.equal(ui.getLayerCount(), 0, 'Detached palette must release DefterUI layer stack');
  assert.equal(document.querySelector('.shell').getAttribute('aria-hidden'), null);

  cp.destroy();
  window.close();
});

// T5-6 (Gap 5): CommandPalette configure({ title }) while open updates cachedDom heading & aria-label
test('T5-6. CommandPalette configure({ title, placeholder }) while open updates cachedDom heading, aria-label, and placeholder', () => {
  const dom = createDom();
  const { window } = dom;
  const { document } = window;
  const cp = window.DefterCommandPalette;
  cp.registerProvider('nav', [{ id: 'a', title: 'Öğe' }]);
  cp.configure({ title: 'İlk Başlık', placeholder: 'İlk Ara' });
  cp.open();
  cp.configure({ title: 'Yeni Başlık', placeholder: 'Yeni Ara' });

  assert.equal(document.querySelector('[data-command-palette] h2').textContent, 'Yeni Başlık');
  assert.equal(document.querySelector('[data-command-palette-input]').getAttribute('aria-label'), 'Yeni Başlık');
  assert.equal(document.querySelector('[data-command-palette-input]').placeholder, 'Yeni Ara');

  cp.destroy();
  window.close();
});

// T5-7: Combobox docPointerRegistry cross-Document isolation, lazy hasValue/setValue, and destroy({ restoreOptions: false })
test('T5-7. docPointerRegistry isolates across two Documents, lazy hasValue/setValue work before open(), and destroy({restoreOptions:false}) skips rebuild', () => {
  const dom1 = createDom();
  const dom2 = createDom();
  const doc1 = dom1.window.document;
  const doc2 = dom2.window.document;

  const cb1 = dom1.window.DefterCombobox.create({ container: doc1.querySelector('main'), items: [{ id: '1', label: 'A' }] });
  const cb2 = dom1.window.DefterCombobox.create({ container: doc2.querySelector('main'), items: [{ id: '2', label: 'B' }] });
  cb1.open();
  cb2.open();
  doc1.body.dispatchEvent(new dom1.window.Event('pointerdown', { bubbles: true }));
  assert.equal(cb1.input.getAttribute('aria-expanded'), 'false');
  assert.equal(cb2.input.getAttribute('aria-expanded'), 'true', 'pointerdown in doc1 must not close cb2 in doc2');

  const sel = doc1.createElement('select');
  for (let i = 0; i < 60; i++) {
    const opt = doc1.createElement('option');
    opt.value = `id-${i}`;
    opt.textContent = `Kart ${i}`;
    sel.append(opt);
  }
  doc1.querySelector('main').append(sel);
  const enhanced = dom1.window.DefterCombobox.enhanceSelect(sel);
  assert.equal(enhanced.hasValue('id-58'), true);
  assert.equal(enhanced.setValue('id-58'), true);
  assert.equal(sel.value, 'id-58');
  enhanced.destroy({ restoreOptions: false });
  assert.ok(sel.options.length <= 2, 'restoreOptions:false must not reconstruct 60 <option> nodes');

  dom1.window.close();
  dom2.window.close();
});

// T5-8: Turkish folding (<İMG> canonical stock uppercase) + XSS + Employee server boundary enforcement
test('T5-8. Turkish folding matches tr-TR uppercased XSS strings safely via textContent and server enforces strict employee boundaries', async t => {
  const { normalizeSearch, matchesSearch } = globalThis.DefterSearchNorm;
  const trUpperXss = '<img src=x onerror="window.__xss=3">'.toLocaleUpperCase('tr-TR');
  assert.equal(trUpperXss.includes('<İMG'), true);
  assert.equal(normalizeSearch(trUpperXss).includes('<img'), true);
  assert.equal(matchesSearch(trUpperXss, '<img'), true);

  const dataDirectory = mkdtempSync(path.join(process.env.TEMP || tmpdir(), 't5-sec-'));
  const { server } = createApp({ dataDirectory, logger: () => {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    rmSync(dataDirectory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (route, token, body) => {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    return fetch(`${base}${route}`, body === undefined ? { headers } : {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
  };
  const owner = await (await send('/api/auth/setup', null, { name: 'Sahip', password: 'example-owner-test-2026' })).json();
  const emp = await (await send('/api/auth/employees', owner.token, { name: 'Tezgahtar', password: 'example-worker-test-2026' })).json();
  const worker = await (await send('/api/auth/login', null, { id: emp.id, password: 'example-worker-test-2026' })).json();
  const st = await (await send('/api/state', owner.token)).json();
  const openRes = await (await send('/api/command', owner.token, {
    id: randomUUID(), revision: st.revision,
    command: { type: 'opening', date: '2026-11-10', balances: Object.fromEntries(st.accounts.filter(a => !a.retired).map(a => [a.id, a.id === 'nakit' ? '5000' : '0'])) }
  })).json();
  const supRes = await (await send('/api/command', owner.token, {
    id: randomUUID(), revision: openRes.state.revision,
    command: { type: 'account', date: '2026-11-10', name: 'Gizli Toptancı', unit: 'HAS', opening: '0', partyType: 'supplier' }
  })).json();
  const supAcc = supRes.state.accounts.find(a => a.partyType === 'supplier');

  for (const r of ['/api/state', '/api/journal', '/api/suppliers', '/api/summary', '/api/backup', '/api/archive', '/api/recovery', '/api/account-statement', '/api/item-photo']) {
    assert.equal((await send(`${r}?workspace=demo`, worker.token)).status, 403, `${r} must be 403 for employee`);
  }
  assert.equal((await send(`/api/customers?workspace=demo&id=${encodeURIComponent(supAcc.id)}`, worker.token)).status, 403);
  assert.deepEqual(await (await send('/api/customers?workspace=demo&q=Gizli', worker.token)).json(), []);
  assert.equal((await send('/api/command?workspace=demo', worker.token, {
    id: randomUUID(), revision: supRes.state.revision,
    command: { type: 'account', date: '2026-11-10', name: 'Açılışlı', unit: 'TL', opening: '100', partyType: 'customer' }
  })).status, 403);
});

// T5-9 (Gap 6): docPointerRegistry detached cleanup on sibling close() & open-before-attach
test('T5-9. docPointerRegistry prunes detached combobox on sibling close() and tracks late-attached comboboxes', () => {
  const dom = createDom();
  const { window } = dom;
  const { document } = window;
  const main = document.querySelector('main');

  let docPointerDownAdds = 0;
  let docPointerDownRemoves = 0;
  const origAdd = document.addEventListener.bind(document);
  const origRem = document.removeEventListener.bind(document);
  document.addEventListener = (type, fn, opts) => {
    if (type === 'pointerdown') docPointerDownAdds++;
    return origAdd(type, fn, opts);
  };
  document.removeEventListener = (type, fn, opts) => {
    if (type === 'pointerdown') docPointerDownRemoves++;
    return origRem(type, fn, opts);
  };

  const cb1 = window.DefterCombobox.create({ container: main, items: [{ id: '1', label: 'Bir' }] });
  const cb2 = window.DefterCombobox.create({ container: main, items: [{ id: '2', label: 'İki' }] });
  cb1.open();
  cb2.open();
  assert.equal(docPointerDownAdds, 1);

  cb1.root.remove();
  cb2.close();
  assert.equal(docPointerDownRemoves, 1, 'Detached cb1 must be pruned when last connected cb2 closes');
  assert.equal(cb1.input.getAttribute('aria-expanded'), 'false');

  const lateHost = document.createElement('div');
  const cbLate = window.DefterCombobox.create({ container: lateHost, items: [{ id: '3', label: 'Üç' }] });
  cbLate.open();
  main.append(lateHost);
  lateHost.remove();
  cb2.open();
  cb2.input.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  assert.equal(cbLate.input.getAttribute('aria-expanded'), 'false', 'Late-attached then detached combobox must prune');

  cb2.destroy();
  window.close();
});

// T5-10 (Gap 7): Async combobox with allowEmpty:true clears committed value on Enter when cleared while open
test('T5-10. Async combobox with allowEmpty:true clears committed value on Enter when input is cleared while listbox is open', async () => {
  const dom = createDom();
  const { window } = dom;
  const changeCalls = [];
  const cb = window.DefterCombobox.create({
    container: window.document.querySelector('main'),
    minQueryLength: 2,
    debounceMs: 0,
    allowEmpty: true,
    provider: async () => [{ id: 'a1', label: 'Ahmet' }],
    onChange: val => changeCalls.push(val)
  });

  cb.setValue('a1', { item: { id: 'a1', label: 'Ahmet' } });
  cb.open({ searchQuery: 'ah', immediate: true });
  await tick(15);
  assert.equal(cb.getValue(), 'a1');

  cb.input.value = '';
  cb.input.dispatchEvent(inputEv(window));
  cb.input.dispatchEvent(keyEv(window, 'Enter'));

  assert.equal(cb.getValue(), '', 'Enter on empty input with allowEmpty:true must clear committed value');
  assert.equal(cb.input.getAttribute('aria-expanded'), 'false');
  assert.deepEqual(changeCalls, ['']);

  cb.destroy();
  window.close();
});

// ============================================================================
// PART 2: M4 Screen Integrations, Financial & Draft Integrity (T5-11 .. T5-21)
// ============================================================================

async function bootLiveServerPart2(t, { withManyStocks = false } = {}) {
  const dataDir = mkdtempSync(path.join(process.env.TEMP || tmpdir(), 't5-p2-srv-'));
  const { server } = createApp({ dataDirectory: dataDir, logger: () => {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (route, token, body) => {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await fetch(`${base}${route}`, body === undefined ? { headers } : {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    return { status: res.status, data: await res.json() };
  };

  const owner = (await req('/api/auth/setup', null, { name: 'Patron', password: 'example-owner-test-2026' })).data;
  const empInfo = (await req('/api/auth/employees', owner.token, { name: 'Tezgahtar', password: 'example-emp-test-2026' })).data;
  const emp = (await req('/api/auth/login', null, { id: empInfo.id, password: 'example-emp-test-2026' })).data;

  let st = (await req('/api/state', owner.token)).data;
  const balances = Object.fromEntries(st.accounts.filter(a => !a.retired).map(a => [
    a.id,
    a.id === 'nakit' ? '200000'
      : a.id === 'usd' ? '500'
      : a.id === 'ceyrek' ? '20'
      : a.id === 'bilezikAdet' ? '10'
      : a.id === 'bilezik22' ? '200'
      : a.id === 'taki14' ? '100'
      : a.id === 'gramToplam' ? '50'
      : '0'
  ]));
  st = (await req('/api/command', owner.token, {
    id: randomUUID(), revision: st.revision,
    command: { type: 'opening', date: '2026-11-10', balances }
  })).data.state;

  st = (await req('/api/command', owner.token, {
    id: randomUUID(), revision: st.revision,
    command: { type: 'stockAccount', date: '2026-11-10', name: 'Sırma Gram Altın', unit: 'GRAM', opening: '25' }
  })).data.state;

  st = (await req('/api/command', owner.token, {
    id: randomUUID(), revision: st.revision,
    command: { type: 'account', date: '2026-11-10', name: 'Ayşe Yılmaz', unit: 'TL', opening: '1000', partyType: 'customer' }
  })).data.state;

  st = (await req('/api/command', owner.token, {
    id: randomUUID(), revision: st.revision,
    command: { type: 'supplierFirm', date: '2026-11-10', name: 'Merkez Toptan' }
  })).data.state;
  const firmId = st.supplierFirms.find(f => f.name === 'Merkez Toptan').id;
  st = (await req('/api/command', owner.token, {
    id: randomUUID(), revision: st.revision,
    command: { type: 'supplierUnit', date: '2026-11-10', supplierId: firmId, unit: 'HAS' }
  })).data.state;
  st = (await req('/api/command', owner.token, {
    id: randomUUID(), revision: st.revision,
    command: { type: 'supplierUnit', date: '2026-11-10', supplierId: firmId, unit: 'TL' }
  })).data.state;

  if (withManyStocks) {
    for (let i = 1; i <= 52; i++) {
      st = (await req('/api/command', owner.token, {
        id: randomUUID(), revision: st.revision,
        command: {
          type: 'stockAccount', date: '2026-11-10',
          name: i === 52 ? '<img src=x onerror="window.__xssOverview=1">' : `Ek Stok ${String(i).padStart(3, '0')}`,
          unit: 'ADET', opening: '3'
        }
      })).data.state;
    }
  }

  return { base, owner, emp, firmId, req };
}

function attachLiveFetchPart2(window, base, token, interceptor = null) {
  window.fetch = async (reqUrl, init = {}) => {
    const full = String(reqUrl).startsWith('http') ? String(reqUrl) : `${base}${reqUrl}`;
    const headers = { ...(init.headers || {}) };
    if (token && !headers.Authorization) headers.Authorization = `Bearer ${token}`;
    const { signal: jsdomSignal, ...rest } = init;
    let nodeAc = null;
    if (jsdomSignal) {
      nodeAc = new AbortController();
      if (jsdomSignal.aborted) nodeAc.abort();
      else jsdomSignal.addEventListener?.('abort', () => nodeAc.abort(), { once: true });
    }
    const finalInit = { ...rest, headers, ...(nodeAc ? { signal: nodeAc.signal } : {}) };
    if (interceptor) return interceptor(reqUrl, finalInit, full);
    return globalThis.fetch(full, finalInit);
  };
}

async function mountOwnerPart2(srv, { url = 'http://127.0.0.1:4317/owner#v=suppliers', seededStorage = {}, fetchInterceptor = null } = {}) {
  const dom = new JSDOM(indexHtml, { url, runScripts: 'outside-only' });
  const { window } = dom;
  Object.defineProperty(window.crypto, 'randomUUID', { value: randomUUID });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.confirm = () => true;
  for (const [k, v] of Object.entries(seededStorage)) window.sessionStorage.setItem(k, v);
  window.sessionStorage.setItem('defter-session', JSON.stringify({
    actor: srv.owner.actor, token: srv.owner.token, expiresAt: Date.now() + 3600_000
  }));
  window.DefterSession = {
    current: () => JSON.parse(window.sessionStorage.getItem('defter-session') || 'null'),
    clear: () => window.sessionStorage.removeItem('defter-session'),
    lock: () => {}, finishRestore: () => {}, api: async () => ({})
  };
  attachLiveFetchPart2(window, srv.base, srv.owner.token, fetchInterceptor);

  const prev = [globalThis.DefterCombobox, globalThis.DefterSearchNorm, globalThis.DefterDraftStore, globalThis.DefterAmountCodec, globalThis.DefterSession];
  window.__testSuppliersModule = suppliersModule;
  window.eval(searchNormSrc);
  window.eval(draftStoreSrc);
  window.eval(uiKitSrc);
  window.eval(amountCodecSrc);
  window.eval(dateFormatSrc);
  window.eval(comboboxSrc);
  window.eval(paletteSrc);
  globalThis.DefterCombobox = window.DefterCombobox;
  globalThis.DefterSearchNorm = window.DefterSearchNorm;
  globalThis.DefterDraftStore = window.DefterDraftStore;
  globalThis.DefterAmountCodec = window.DefterAmountCodec;
  globalThis.DefterSession = window.DefterSession;
  window.eval(appSrc.replace("import('./suppliers.js')", 'Promise.resolve(window.__testSuppliersModule)'));
  await tick(100);

  return {
    dom, window, document: window.document,
    close: () => {
      delete window.__testSuppliersModule;
      [globalThis.DefterCombobox, globalThis.DefterSearchNorm, globalThis.DefterDraftStore, globalThis.DefterAmountCodec, globalThis.DefterSession] = prev;
      window.close();
    }
  };
}

async function mountCheckoutPart2(srv, { seededStorage = {}, fetchInterceptor = null } = {}) {
  const dom = new JSDOM(checkoutHtml, { url: 'http://127.0.0.1:4317/checkout', runScripts: 'outside-only' });
  const { window } = dom;
  Object.defineProperty(window.crypto, 'randomUUID', { value: randomUUID });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  for (const [k, v] of Object.entries(seededStorage)) window.sessionStorage.setItem(k, v);
  window.sessionStorage.setItem('defter-session', JSON.stringify({
    actor: srv.emp.actor, token: srv.emp.token, expiresAt: Date.now() + 3600_000
  }));
  attachLiveFetchPart2(window, srv.base, srv.emp.token, fetchInterceptor);

  const prev = [globalThis.DefterCombobox, globalThis.DefterSearchNorm, globalThis.DefterDraftStore, globalThis.DefterAmountCodec];
  window.eval(searchNormSrc);
  window.eval(draftStoreSrc);
  window.eval(uiKitSrc);
  window.eval(accessClientSrc);
  window.eval(amountCodecSrc);
  window.eval(dateFormatSrc);
  window.eval(comboboxSrc);
  window.eval(paletteSrc);
  globalThis.DefterCombobox = window.DefterCombobox;
  globalThis.DefterSearchNorm = window.DefterSearchNorm;
  globalThis.DefterDraftStore = window.DefterDraftStore;
  globalThis.DefterAmountCodec = window.DefterAmountCodec;
  window.eval(checkoutSrc);
  await tick(100);

  return {
    dom, window, document: window.document,
    close: () => {
      [globalThis.DefterCombobox, globalThis.DefterSearchNorm, globalThis.DefterDraftStore, globalThis.DefterAmountCodec] = prev;
      window.close();
    }
  };
}

// T5-11: suppliers.js returnWeight-0 and offset drafts restore and submit cleanly via POST /api/command
test('T5-11. suppliers.js returnWeight-0 and offset drafts restore and submit cleanly via POST /api/command', async t => {
  const srv = await bootLiveServerPart2(t);
  let st = (await srv.req('/api/state', srv.owner.token)).data;
  const supHas = st.accounts.find(a => a.partyType === 'supplier' && a.supplierId === srv.firmId && a.unit === 'HAS');
  const supTl = st.accounts.find(a => a.partyType === 'supplier' && a.supplierId === srv.firmId && a.unit === 'TL');

  const pId = randomUUID();
  st = (await srv.req('/api/command', srv.owner.token, {
    id: pId, revision: st.revision,
    command: {
      type: 'supplierPurchase', date: '2026-11-10', supplierId: srv.firmId,
      items: [{ accountId: 'bilezikAdet', quantity: '4', weightAccount: 'bilezik22', weight: '40' }],
      charges: [{ accountId: supHas.id, quantity: '36.64' }, { accountId: supTl.id, quantity: '50000' }],
      note: 'Paired alış'
    }
  })).data.state;
  const payId = randomUUID();
  st = (await srv.req('/api/command', srv.owner.token, {
    id: payId, revision: st.revision,
    command: {
      type: 'supplierPayment', date: '2026-11-10', supplierId: srv.firmId,
      given: [{ accountId: 'nakit', quantity: '50000' }],
      credits: [{ accountId: supHas.id, quantity: '40' }],
      note: 'HAS avans'
    }
  })).data.state;

  const setSel = (w, sel, val) => {
    const cb = w.DefterCombobox.getInstance(sel);
    if (cb) { cb.setValue(val, { emitChange: false }); sel.dispatchEvent(new w.Event('change', { bubbles: true })); }
    else { sel.value = val; sel.dispatchEvent(new w.Event('change', { bubbles: true })); }
  };

  // 1) returnWeight-0 restore + live supplierReturn submit
  const app1 = await mountOwnerPart2(srv, { url: `http://127.0.0.1:4317/owner#v=suppliers&id=${srv.firmId}` });
  app1.document.querySelector('[data-supplier-task="return"]').click();
  await tick(80);
  const rf1 = app1.document.querySelector('[data-supplier-document-form="return"]');
  setSel(app1.window, rf1.elements.originalId, pId);
  rf1.elements['returnQty-0'].value = '2';
  rf1.elements['returnQty-0'].dispatchEvent(new app1.window.Event('input', { bubbles: true }));
  rf1.elements['returnWeight-0'].value = '20,000';
  rf1.elements['returnWeight-0'].dispatchEvent(new app1.window.Event('input', { bubbles: true }));
  rf1.elements['reduction-' + supHas.id].value = '18,320';
  rf1.elements['reduction-' + supHas.id].dispatchEvent(new app1.window.Event('input', { bubbles: true }));
  rf1.querySelector('[data-document-group="credits"] [data-add-document-line]').click();
  const cRow = rf1.querySelector('[data-document-group="credits"] .form-grid');
  app1.window.DefterCombobox.getInstance(cRow.querySelector('[data-field="accountId"]')).setValue(supHas.id);
  cRow.querySelector('[data-field="quantity"]').value = '18,320';
  cRow.querySelector('[data-field="quantity"]').dispatchEvent(new app1.window.Event('input', { bubbles: true }));
  rf1.elements.note.value = 'İade taslağı';
  rf1.elements.note.dispatchEvent(new app1.window.Event('input', { bubbles: true }));
  const retStorage = Object.fromEntries(Object.keys(app1.window.sessionStorage).map(k => [k, app1.window.sessionStorage.getItem(k)]));
  app1.close();

  const app2 = await mountOwnerPart2(srv, { url: `http://127.0.0.1:4317/owner#v=suppliers&id=${srv.firmId}`, seededStorage: retStorage });
  app2.document.querySelector('[data-supplier-task="return"]').click();
  await tick(80);
  const rf2 = app2.document.querySelector('[data-supplier-document-form="return"]');
  assert.equal(rf2.elements['returnWeight-0'].value, '20,000');
  rf2.dispatchEvent(new app2.window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(120);
  const stAfterRet = (await srv.req('/api/state', srv.owner.token)).data;
  assert.equal(stAfterRet.journal.filter(e => e.type === 'supplierReturn').length, 1);
  assert.equal(stAfterRet.balances.bilezik22, 220000);
  app2.close();

  // 2) offset draft restore + live supplierOffset submit
  const app3 = await mountOwnerPart2(srv, { url: `http://127.0.0.1:4317/owner#v=suppliers&id=${srv.firmId}` });
  app3.document.querySelector('[data-supplier-task="offset"]').click();
  await tick(80);
  const of1 = app3.document.querySelector('[data-supplier-document-form="offset"]');
  setSel(app3.window, of1.elements.fromAccountId, supHas.id);
  setSel(app3.window, of1.elements.toAccountId, supTl.id);
  of1.elements.fromQuantity.value = '1';
  of1.elements.fromQuantity.dispatchEvent(new app3.window.Event('input', { bubbles: true }));
  of1.elements.toQuantity.value = '5000';
  of1.elements.toQuantity.dispatchEvent(new app3.window.Event('input', { bubbles: true }));
  of1.querySelector('[data-add-source]').click();
  setSel(app3.window, of1.querySelector('[data-source-field="choice"]'), JSON.stringify([payId, supHas.id]));
  of1.querySelector('[data-source-field="quantity"]').value = '1';
  of1.querySelector('[data-source-field="quantity"]').dispatchEvent(new app3.window.Event('input', { bubbles: true }));
  of1.querySelector('[data-add-offset-target]').click();
  setSel(app3.window, of1.querySelector('[data-target-field="purchaseId"]'), pId);
  of1.querySelector('[data-target-field="quantity"]').value = '5000';
  of1.querySelector('[data-target-field="quantity"]').dispatchEvent(new app3.window.Event('input', { bubbles: true }));
  of1.elements.note.value = 'Mahsup taslağı';
  of1.elements.note.dispatchEvent(new app3.window.Event('input', { bubbles: true }));
  const offStorage = Object.fromEntries(Object.keys(app3.window.sessionStorage).map(k => [k, app3.window.sessionStorage.getItem(k)]));
  app3.close();

  const app4 = await mountOwnerPart2(srv, { url: `http://127.0.0.1:4317/owner#v=suppliers&id=${srv.firmId}`, seededStorage: offStorage });
  app4.document.querySelector('[data-supplier-task="offset"]').click();
  await tick(80);
  const of2 = app4.document.querySelector('[data-supplier-document-form="offset"]');
  assert.equal(of2.elements.fromAccountId.value, supHas.id);
  assert.equal(of2.elements.toAccountId.value, supTl.id);
  assert.equal(of2.querySelector('[data-target-field="purchaseId"]').value, pId);
  of2.dispatchEvent(new app4.window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(120);
  const stAfterOff = (await srv.req('/api/state', srv.owner.token)).data;
  assert.equal(stAfterOff.journal.filter(e => e.type === 'supplierOffset').length, 1);
  app4.close();
});

// T5-12 (Gap 10): suppliers.js document task renders only one [data-review-current] button when stale
test('T5-12. suppliers.js document task renders only one [data-review-current] button when draft is stale', async t => {
  const srv = await bootLiveServerPart2(t);
  let st = (await srv.req('/api/state', srv.owner.token)).data;
  const supTl = st.accounts.find(a => a.partyType === 'supplier' && a.supplierId === srv.firmId && a.unit === 'TL');
  const pId = randomUUID();
  st = (await srv.req('/api/command', srv.owner.token, {
    id: pId, revision: st.revision,
    command: { type: 'supplierPurchase', date: '2026-11-10', supplierId: srv.firmId, items: [{ accountId: 'ceyrek', quantity: '1' }], charges: [{ accountId: supTl.id, quantity: '5000' }], note: 'Alış' }
  })).data.state;

  const actorId = srv.owner.actor.id;
  const draftKey = `defter-draft:v1:${actorId}:demo:supplier:return:${srv.firmId}`;
  const staleDraft = {
    version: 1, key: draftKey,
    meta: { actorId, workspace: 'demo', workday: st.date, revision: st.revision - 1, formId: 'return', entityId: srv.firmId },
    data: { fields: { originalId: pId, 'returnQty-0': '1', note: 'stale' }, arrays: {}, targets: [], links: [], stamp: { revision: st.revision - 1, date: st.date } }
  };
  const app = await mountOwnerPart2(srv, {
    url: `http://127.0.0.1:4317/owner#v=suppliers&id=${srv.firmId}`,
    seededStorage: { [draftKey]: JSON.stringify(staleDraft) }
  });
  try {
    app.document.querySelector('[data-supplier-task="return"]').click();
    await tick(80);
    const rForm = app.document.querySelector('[data-supplier-document-form="return"]');
    const btns = rForm.querySelectorAll('[data-review-current]');
    assert.equal(btns.length, 1, `Expected 1 [data-review-current] button, found ${btns.length}`);
  } finally {
    app.close();
  }
});

// T5-13: Checkout & Owner drawers preserve trade drafts across custom JPY, 400, and 409 retry flows
test('T5-13. Checkout #open-customer-drawer and Owner [data-create-party] preserve unsaved trade drafts across 400 and 409 retry flows', async t => {
  const srv = await bootLiveServerPart2(t);
  let force409Once = false;
  const co = await mountCheckoutPart2(srv, {
    fetchInterceptor: async (reqUrl, finalInit, full) => {
      if (force409Once && String(reqUrl).includes('/api/command')) {
        force409Once = false;
        const st = (await srv.req('/api/state', srv.owner.token)).data;
        await srv.req('/api/command', srv.owner.token, {
          id: randomUUID(), revision: st.revision,
          command: { type: 'account', date: '2026-11-10', name: 'Rakip Müşteri', unit: 'TL', opening: '0', partyType: 'customer' }
        });
      }
      return globalThis.fetch(full, finalInit);
    }
  });
  try {
    const { window: cw, document: cd } = co;
    const row = cd.querySelector('#items [data-item]');
    row.querySelector('[data-quantity]').value = '1';
    row.querySelector('[data-quantity]').dispatchEvent(new cw.Event('input', { bubbles: true }));
    row.querySelector('[data-value]').value = '15000';
    row.querySelector('[data-value]').dispatchEvent(new cw.Event('input', { bubbles: true }));
    cd.querySelector('#note').value = 'Çekmece taslağı';
    cd.querySelector('#note').dispatchEvent(new cw.Event('input', { bubbles: true }));

    cd.querySelector('#open-customer-drawer').click();
    await tick(20);
    const cf = cd.querySelector('#customer-form');
    cf.elements.name.value = 'Ayşe Yılmaz';
    cf.elements.unit.value = 'TL';
    cf.dispatchEvent(new cw.Event('submit', { bubbles: true, cancelable: true }));
    await tick(100);
    assert.equal(cd.querySelector('.defter-drawer')?.open, true);
    assert.equal(cd.querySelector('#customer-drawer-notice').hidden, false);
    assert.equal(cd.querySelector('#note').value, 'Çekmece taslağı');

    cf.elements.name.value = 'Yen Müşterisi';
    cf.elements.unit.value = 'other';
    cf.elements.unit.dispatchEvent(new cw.Event('change', { bubbles: true }));
    cf.elements.currencyCode.value = 'jpy';
    force409Once = true;
    cf.dispatchEvent(new cw.Event('submit', { bubbles: true, cancelable: true }));
    for (let i = 0; i < 40 && cd.querySelector('.defter-drawer'); i++) await tick(25);
    assert.equal(cd.querySelector('.defter-drawer'), null);
    for (let i = 0; i < 40 && cd.querySelector('#draft-stale').hidden; i++) await tick(25);
    assert.equal(cd.querySelector('#draft-stale').hidden, false);
    assert.equal(cd.querySelector('#record').disabled, true);
    assert.equal(cd.querySelector('#note').value, 'Çekmece taslağı');
    assert.equal(cf.elements.name.value, 'Yen Müşterisi');
    assert.equal(cf.elements.currencyCode.value, 'jpy');

    cd.querySelector('#open-customer-drawer').click();
    await tick(20);
    cf.dispatchEvent(new cw.Event('submit', { bubbles: true, cancelable: true }));
    for (let i = 0; i < 40 && cd.querySelector('.defter-drawer'); i++) await tick(25);
    for (let i = 0; i < 40 && !cd.querySelector('#customer').value.startsWith('cari-'); i++) await tick(25);
    assert.equal(cd.querySelector('.defter-drawer'), null);
    assert.ok(cd.querySelector('#customer').value.startsWith('cari-'));
    assert.equal(cd.querySelector('#draft-stale').hidden, false);
  } finally {
    co.close();
  }

  let owner409 = false;
  const app = await mountOwnerPart2(srv, {
    url: 'http://127.0.0.1:4317/owner#v=transaction',
    fetchInterceptor: async (reqUrl, finalInit, full) => {
      if (owner409 && String(reqUrl).includes('/api/command')) {
        owner409 = false;
        const st = (await srv.req('/api/state', srv.owner.token)).data;
        await srv.req('/api/command', srv.owner.token, {
          id: randomUUID(), revision: st.revision,
          command: { type: 'account', date: '2026-11-10', name: 'Owner Rakip', unit: 'TL', opening: '0', partyType: 'customer' }
        });
      }
      return globalThis.fetch(full, finalInit);
    }
  });
  try {
    app.document.querySelector('#f-note').value = 'Owner taslak notu';
    app.document.querySelector('#f-note').dispatchEvent(new app.window.Event('input', { bubbles: true }));
    app.document.querySelector('[data-create-party]').click();
    await tick(20);
    const df = app.document.querySelector('.defter-drawer form');
    df.elements.name.value = 'Ayşe Yılmaz';
    df.dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    await tick(100);
    assert.equal(app.document.querySelector('.defter-drawer')?.open, true);
    assert.equal(app.document.querySelector('.defter-drawer .notice').hidden, false);
    assert.equal(app.document.querySelector('#f-note').value, 'Owner taslak notu');

    df.elements.name.value = 'Owner Başarılı';
    owner409 = true;
    df.dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    for (let i = 0; i < 30 && app.document.querySelector('#sale-form')?.dataset.draftStale !== 'true'; i++) await tick(25);
    assert.equal(app.document.querySelector('.defter-drawer'), null);
    assert.equal(app.document.querySelector('#f-note').value, 'Owner taslak notu');
    assert.equal(app.document.querySelector('#sale-form').dataset.draftStale, 'true');
  } finally {
    app.close();
  }
});

// T5-14 (Gap 16): Checkout #customer-form rejects TRY/HAS in custom 'other' currencyCode client-side
test('T5-14. Checkout #customer-form rejects TRY and HAS in custom currencyCode client-side before hitting server', async t => {
  const srv = await bootLiveServerPart2(t);
  const co = await mountCheckoutPart2(srv);
  try {
    const { window: cw, document: cd } = co;
    cd.querySelector('#open-customer-drawer').click();
    await tick(20);
    const cf = cd.querySelector('#customer-form');
    cf.elements.unit.value = 'other';
    cf.elements.unit.dispatchEvent(new cw.Event('change', { bubbles: true }));

    for (const bad of ['try', 'HAS']) {
      cf.elements.currencyCode.value = bad;
      cf.elements.currencyCode.dispatchEvent(new cw.Event('input', { bubbles: true }));
      assert.equal(cf.elements.currencyCode.validity.valid, false, `currencyCode=${bad} must be rejected client-side`);
    }
    cf.elements.currencyCode.value = 'jpy';
    cf.elements.currencyCode.dispatchEvent(new cw.Event('input', { bubbles: true }));
    assert.equal(cf.elements.currencyCode.value, 'JPY');
    assert.equal(cf.elements.currencyCode.validity.valid, true);
  } finally {
    co.close();
  }
});

// T5-15 (Gap 11): amount-codec.js dataset.amountResolution resets when row product/account changes
test('T5-15. Changing row product/account clears prior dataset.amountResolution so 10.500 is re-disambiguated', async t => {
  const srv = await bootLiveServerPart2(t);
  const app = await mountOwnerPart2(srv, { url: 'http://127.0.0.1:4317/owner#v=transaction' });
  try {
    const { window: ow, document: od } = app;
    const st = (await srv.req('/api/state', srv.owner.token)).data;
    const sirma = st.accounts.find(a => a.name.toLocaleUpperCase('tr-TR').startsWith('SIRMA'));
    const row = od.querySelector('#sale-form .sale-item');
    const prodSelect = row.querySelector('[data-item-field="accountId"]');
    const prodCb = ow.DefterCombobox.getInstance(prodSelect);
    prodCb.setValue(sirma.id, { emitChange: true });

    const qty = row.querySelector('[data-item-field="quantity"]');
    qty.value = '10.500';
    qty.dispatchEvent(new ow.Event('input', { bubbles: true }));
    row.querySelector('[data-amount-choice="decimal"]').click();
    assert.equal(qty.dataset.amountResolution, 'decimal');

    prodCb.setValue('gramToplam', { emitChange: true });
    await tick(15);
    assert.equal(qty.dataset.amountResolution, undefined, 'amountResolution must be cleared on product change');
    assert.equal(row.querySelectorAll('[data-amount-choice]').length, 2, '10.500 must re-trigger disambiguation for new product');
  } finally {
    app.close();
  }
});

// T5-16 (Gap 12): Checkout Guided Step 1 -> Step 2 blocks unresolved 10.500 gram input
test('T5-16. Checkout Guided Step 1 -> Step 2 blocks unresolved 10.500 gram input and blur/Enter cannot bypass disambiguation', async t => {
  const srv = await bootLiveServerPart2(t);
  const co = await mountCheckoutPart2(srv);
  try {
    const { window: cw, document: cd } = co;
    const row = cd.querySelector('#items [data-item]');
    const prodSearch = row.querySelector('[data-product-search]');
    prodSearch.focus();
    prodSearch.value = 'Sırma';
    prodSearch.dispatchEvent(new cw.Event('input', { bubbles: true }));
    await tick(20);
    cd.querySelector('#items .defter-combobox-listbox [role="option"]').click();

    const qty = row.querySelector('[data-quantity]');
    const val = row.querySelector('[data-value]');
    qty.value = '10.500';
    qty.dispatchEvent(new cw.Event('input', { bubbles: true }));
    qty.dispatchEvent(new cw.Event('blur', { bubbles: true }));
    val.value = '30000';
    val.dispatchEvent(new cw.Event('input', { bubbles: true }));

    cd.querySelector('#trade').dispatchEvent(new cw.Event('submit', { bubbles: true, cancelable: true }));
    assert.equal(cd.querySelector('#review').hidden, true);
    assert.equal(row.querySelectorAll('[data-amount-choice]').length, 2);

    cd.querySelector('[data-flow-mode="guided"]').click();
    await tick(10);
    qty.setCustomValidity('');
    cd.querySelector('.amount-disambiguation')?.remove();
    cd.querySelector('[data-step-next="2"]').click();
    await tick(10);
    assert.equal(cd.querySelector('[data-step-panel].is-active')?.dataset.stepPanel, '1', 'Guided Step 1 must not advance with unresolved 10.500');
  } finally {
    co.close();
  }
});

// T5-17: Overview >50 pagination/XSS/metrics, compact bindSaleReturn submit, rapid switch cleanup, hash detail edge IDs
test('T5-17. Overview >50 pagination/XSS/metrics, compact bindSaleReturn restore+submit, rapid view switch cleanup, and hash detail edge IDs', async t => {
  const srv = await bootLiveServerPart2(t, { withManyStocks: true });
  let st = (await srv.req('/api/state', srv.owner.token)).data;
  const saleId = randomUUID();
  st = (await srv.req('/api/command', srv.owner.token, {
    id: saleId, revision: st.revision,
    command: {
      type: 'sale', date: '2026-11-10',
      items: [{ accountId: 'ceyrek', quantity: '2', value: '10000' }],
      received: [{ accountId: 'nakit', quantity: '10000', valueTL: '10000' }],
      given: [], credits: [], debts: []
    }
  })).data.state;

  const app = await mountOwnerPart2(srv, { url: 'http://127.0.0.1:4317/owner#v=overview' });
  try {
    const { window: ow, document: od } = app;
    assert.equal(od.querySelectorAll('.overview-screen .inventory-table tbody tr').length, 50);
    assert.equal(od.querySelectorAll('.overview-screen img').length, 0);
    od.querySelector('#overview-show-all-stocks').click();
    assert.ok(od.querySelectorAll('.overview-screen .inventory-table tbody tr').length > 70);
    assert.equal(od.querySelectorAll('.overview-screen img').length, 0);

    for (const v of ['accounts', 'stocks', 'suppliers', 'journal', 'transaction', 'overview']) {
      od.querySelector(`[data-view="${v}"]`).click();
    }
    await tick(100);
    assert.equal(od.querySelectorAll('.overview-screen .inventory-table tbody tr').length, 50);

    od.querySelector('[data-view="journal"]').click();
    let retDet = null;
    for (let i = 0; i < 40 && !retDet; i++) { await tick(25); retDet = od.querySelector(`details[data-sale-return="${saleId}"]`); }
    assert.ok(retDet);
    retDet.open = true;
    retDet.dispatchEvent(new ow.Event('toggle'));
    await tick(20);
    const rf = retDet.querySelector('.sale-return-form');
    rf.querySelector('[data-return-quantity="0"]').value = '1';
    rf.querySelector('[data-return-quantity="0"]').dispatchEvent(new ow.Event('input', { bubbles: true }));
    rf.querySelector('[data-return-note]').value = 'Compact iade';
    rf.querySelector('[data-return-note]').dispatchEvent(new ow.Event('input', { bubbles: true }));
    ow.DefterCombobox.getInstance(rf.elements.refundProduct).setValue('ceyrek');
    rf.elements.refundProductQuantity.value = '1';
    rf.elements.refundProductQuantity.dispatchEvent(new ow.Event('input', { bubbles: true }));
    rf.elements.refundProductValue.value = '5000';
    rf.elements.refundProductValue.dispatchEvent(new ow.Event('input', { bubbles: true }));

    od.querySelector('[data-view="overview"]').click();
    await tick(25);
    od.querySelector('[data-view="journal"]').click();
    let rf2 = null;
    for (let i = 0; i < 40 && !rf2; i++) { await tick(25); rf2 = od.getElementById(`return-form-${saleId}`); }
    assert.ok(rf2 && rf2.querySelector('[data-clear-draft]'));
    assert.equal(rf2.elements.refundProduct.value, 'ceyrek');
    rf2.dispatchEvent(new ow.Event('submit', { bubbles: true, cancelable: true }));
    await tick(20);
    rf2.querySelector('[data-confirm-return]').click();
    await tick(120);
    const stAfter = (await srv.req('/api/state', srv.owner.token)).data;
    assert.equal(stAfter.journal.filter(e => e.type === 'saleReturn').length, 1);
  } finally {
    app.close();
  }

  for (const [hash, expected] of [
    ['#v=stocks&id=gramAdet', '#v=stocks'],
    ['#v=accounts&id=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E', '#v=accounts'],
    ['#v=accounts&id=%E0%A4%A', '#v=accounts'],
    ['#v=suppliers&id=__proto__', '#v=suppliers']
  ]) {
    const hApp = await mountOwnerPart2(srv, { url: `http://127.0.0.1:4317/owner${hash}` });
    assert.equal(hApp.window.location.hash, expected);
    assert.equal(hApp.document.querySelectorAll('#main img').length, 0);
    hApp.close();
  }
});

// T5-18 (Gap 15): bindSaleReturn restores serial refundProduct (item:<code>) when refundItemSearch is empty
test('T5-18. bindSaleReturn restores serial refundProduct (item:<code>) draft even when refundItemSearch is empty', async t => {
  const srv = await bootLiveServerPart2(t);
  let st = (await srv.req('/api/state', srv.owner.token)).data;
  const saleId = randomUUID();
  st = (await srv.req('/api/command', srv.owner.token, {
    id: saleId, revision: st.revision,
    command: {
      type: 'sale', date: '2026-11-10',
      items: [{ accountId: 'ceyrek', quantity: '1', value: '5000' }],
      received: [{ accountId: 'nakit', quantity: '5000', valueTL: '5000' }],
      given: [], credits: [], debts: []
    }
  })).data.state;
  st = (await srv.req('/api/command', srv.owner.token, {
    id: randomUUID(), revision: st.revision,
    command: { type: 'registerItem', date: '2026-11-10', code: 'SN-SER1', accountId: 'ceyrek' }
  })).data.state;

  const actorId = srv.owner.actor.id;
  const key = `defter-draft:v1:${actorId}:demo:retail:return-form-${saleId}`;
  const seeded = {
    [key]: JSON.stringify({
      version: 1, key,
      meta: { actorId, workspace: 'demo', workday: st.date, revision: st.revision, formId: `return-form-${saleId}` },
      data: {
        fields: {
          'quantity-0': '1', 'value-0': '5000',
          refundItemSearch: '', refundProduct: 'item:SN-SER1',
          refundProductQuantity: '1', returnOperation: 'refund', refundProductValue: '5000', note: 'Tekil iade'
        }
      }
    })
  };
  const app = await mountOwnerPart2(srv, { url: 'http://127.0.0.1:4317/owner#v=journal', seededStorage: seeded });
  try {
    let rf = null;
    for (let i = 0; i < 40 && !rf; i++) { await tick(25); rf = app.document.getElementById(`return-form-${saleId}`); }
    assert.ok(rf);
    assert.equal(rf.elements.refundProduct.value, 'item:SN-SER1');
  } finally {
    app.close();
  }
});

// T5-19 (Gap 13): DefterDraftStore flags retired nested row accountIds as DISABLED_ENTITY
test('T5-19. DefterDraftStore.validateDraft flags retired accountId inside nested sale/allocation rows as DISABLED_ENTITY', async t => {
  const srv = await bootLiveServerPart2(t);
  const st = (await srv.req('/api/state', srv.owner.token)).data;
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1:4317/', runScripts: 'outside-only' });
  dom.window.eval(draftStoreSrc);
  const res = dom.window.DefterDraftStore.validateDraft({
    version: 1,
    meta: { actorId: srv.owner.actor.id, workspace: 'demo', workday: st.date, revision: st.revision, formId: 'sale-form' },
    data: {
      fields: { counterpartyId: '' },
      sale: { items: [{ accountId: 'gramAdet', quantity: '1', value: '1000' }], payment: [], counterpayment: [], debt: [], counterdebt: [], scrap: [] }
    }
  }, { ...st, workspace: 'demo', actorId: srv.owner.actor.id });
  dom.window.close();
  assert.equal(res.status, 'DISABLED_ENTITY');
});

// T5-20 (Gap 14): Checkout forwards invalid/retired product validity to visible [data-product-search]
test('T5-20. Checkout forwards invalid/retired drafted product validity to visible [data-product-search]', async t => {
  const srv = await bootLiveServerPart2(t);
  const st = (await srv.req('/api/state', srv.owner.token)).data;
  const empId = srv.emp.actor.id;
  const coKey = `defter-draft:v1:${empId}:demo:checkout:sale`;
  const co = await mountCheckoutPart2(srv, {
    seededStorage: {
      [coKey]: JSON.stringify({
        version: 1, key: coKey,
        meta: { actorId: empId, workspace: 'demo', workday: st.date, revision: st.revision, formId: 'checkout-sale' },
        data: {
          revision: st.revision, date: st.date, customer: null, note: 'poisoned',
          items: [{ selection: 'gramAdet', search: 'gramAdet', quantity: '1', value: '1000', weight: '', weightAccount: '' }],
          received: [{ category: 'money', accountId: 'nakit', quantity: '1000', valueTL: '1000', weight: '', weightAccount: '' }],
          given: [], credits: [], debts: []
        }
      })
    }
  });
  try {
    co.document.querySelector('#record').click();
    await tick(30);
    assert.equal(co.document.querySelector('#review').hidden, true);
    const searchInput = co.document.querySelector('#items [data-product-search]');
    assert.ok(searchInput.validationMessage.length > 0);
    assert.equal(searchInput.getAttribute('aria-invalid'), 'true');
  } finally {
    co.close();
  }
});

// T5-21 (Gap 9): suppliers.js legacyLink [data-field="quantity"] restore/submit & Kaldır button vs DefterCombobox
test('T5-21. suppliers.js legacyLink restores [data-field="quantity"] (not combobox input) and Kaldır button removes offset/legacy rows', async t => {
  const srv = await bootLiveServerPart2(t);
  let st = (await srv.req('/api/state', srv.owner.token)).data;
  const supHas = st.accounts.find(a => a.partyType === 'supplier' && a.supplierId === srv.firmId && a.unit === 'HAS');
  const supTl = st.accounts.find(a => a.partyType === 'supplier' && a.supplierId === srv.firmId && a.unit === 'TL');
  await srv.req('/api/command', srv.owner.token, {
    id: randomUUID(), revision: st.revision,
    command: { type: 'supplierPurchase', date: '2026-11-10', supplierId: srv.firmId, items: [{ accountId: 'ceyrek', quantity: '1' }], charges: [{ accountId: supTl.id, quantity: '5000' }], note: 'Alış' }
  });
  st = (await srv.req('/api/state', srv.owner.token)).data;
  await srv.req('/api/command', srv.owner.token, {
    id: randomUUID(), revision: st.revision,
    command: { type: 'supplierPayment', date: '2026-11-10', supplierId: srv.firmId, given: [{ accountId: 'nakit', quantity: '10000' }], credits: [{ accountId: supHas.id, quantity: '5' }], note: 'Avans' }
  });

  const offApp = await mountOwnerPart2(srv, { url: `http://127.0.0.1:4317/owner#v=suppliers&id=${srv.firmId}` });
  try {
    offApp.document.querySelector('[data-supplier-task="offset"]').click();
    await tick(80);
    const of = offApp.document.querySelector('[data-supplier-document-form="offset"]');
    offApp.window.DefterCombobox.getInstance(of.elements.toAccountId).setValue(supTl.id);
    of.querySelector('[data-add-offset-target]').click();
    const targetRow = of.querySelector('[data-offset-targets] > div');
    const removeBtn = [...targetRow.querySelectorAll('button')].find(b => b.textContent.trim() === 'Kaldır');
    removeBtn.click();
    assert.equal(of.querySelectorAll('[data-offset-targets] > div').length, 0, 'Clicking Kaldır on offset target row must remove the row');
  } finally {
    offApp.close();
  }

  const repo = new Repository(':memory:', 'demo');
  t.after(() => repo.close());
  repo.execute({
    id: 'open', revision: 0,
    command: { type: 'opening', date: '2026-11-10', balances: Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, a.id === 'nakit' ? '10000' : '0'])) }
  });
  repo.execute({ id: 'leg-sup', revision: repo.state().revision, command: { type: 'account', date: '2026-11-10', name: 'Eski Toptancı', partyType: 'supplier', unit: 'TL', opening: '100' } });
  appendHistoricalEvent(repo, 'old-refund', { type: 'collection', date: '2026-11-10', customerAccount: 'cari-leg-sup', target: 'nakit', direction: 'collect', quantity: '30' });
  const legState = repo.state();
  const legDom = new JSDOM('<!doctype html><html lang="tr"><body><section id="host"></section></body></html>', { url: 'http://127.0.0.1:4317/owner', runScripts: 'outside-only' });
  t.after(() => legDom.window.close());
  const lw = legDom.window;
  lw.eval(searchNormSrc); lw.eval(draftStoreSrc); lw.eval(amountCodecSrc); lw.eval(comboboxSrc);
  const prevL = [globalThis.DefterCombobox, globalThis.DefterSearchNorm, globalThis.DefterDraftStore];
  globalThis.DefterCombobox = lw.DefterCombobox; globalThis.DefterSearchNorm = lw.DefterSearchNorm; globalThis.DefterDraftStore = lw.DefterDraftStore;
  t.after(() => { [globalThis.DefterCombobox, globalThis.DefterSearchNorm, globalThis.DefterDraftStore] = prevL; });

  const legParty = legState.accounts.find(a => a.id === 'cari-leg-sup');
  const custLegState = {
    ...legState,
    supplierParties: [{ id: legParty.id, name: legParty.name, accounts: [{ id: legParty.id, name: legParty.name, unit: 'TL', balance: legState.balances[legParty.id] }] }]
  };
  const draftKey = lw.DefterDraftStore.makeKey({ actorId: 'owner', workspace: 'demo', scope: 'supplier', type: 'legacyLink', entityId: legParty.id });
  lw.DefterDraftStore.saveDraft(draftKey, {
    meta: { actorId: 'owner', workspace: 'demo', workday: legState.date, revision: legState.revision, formId: 'legacyLink', entityId: legParty.id },
    data: {
      fields: { originalId: 'old-refund', note: 'Eski eşleştirme' },
      arrays: { legacyUses: [{ source: JSON.stringify(['leg-sup', legParty.id]), quantity: '30' }] },
      targets: [], links: [], stamp: { revision: legState.revision, date: legState.date }
    }
  });
  let submittedLeg = null;
  const handle = suppliersModule.renderSupplierWorkspace(lw.document.querySelector('#host'), {
    state: custLegState,
    actorId: 'owner',
    escape: s => String(s ?? ''),
    format: (n, u) => `${n} ${u}`,
    day: d => String(d || ''),
    initialPartyId: legParty.id,
    workspace: 'demo',
    parseAmount: lw.DefterAmountCodec.parseInputElement,
    canonicalValue: lw.DefterAmountCodec.canonicalInputValue,
    request: async () => ({
      revision: legState.revision,
      supplier: legParty,
      accounts: [{ id: legParty.id, name: legParty.name, unit: 'TL', balance: legState.balances[legParty.id] }],
      documents: supplierDocuments(legState, legParty.id),
      statements: [], events: [], total: 0
    }),
    submit: async cmd => {
      repo.execute({ id: randomUUID(), revision: repo.state().revision, command: cmd });
      submittedLeg = cmd;
      return true;
    }
  });
  handle.selectParty(legParty.id, { task: 'legacyLink' });
  await tick(40);
  const legForm = lw.document.querySelector('[data-supplier-document-form="legacyLink"]');
  assert.equal(legForm.querySelector('[data-legacy-rows] [data-field="quantity"]').value, '30');
  legForm.dispatchEvent(new lw.Event('submit', { bubbles: true, cancelable: true }));
  await tick(40);
  assert.equal(submittedLeg?.type, 'supplierLegacyReceiptLink');
  assert.equal(supplierDocuments(repo.state(), legParty.id).unresolvedReceipts.length, 0);
  handle.destroy();
});
