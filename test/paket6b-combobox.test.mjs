import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadJSDOM } from '../test-support/jsdom.mjs';
import { createApp } from '../server.mjs';
import { customerChoices, customerDetail } from '../editor-access.mjs';
import '../public/search-norm.js';

const JSDOM = await loadJSDOM();
const NodeSearchNorm = globalThis.DefterSearchNorm;

const searchNormSource = readFileSync(new URL('../public/search-norm.js', import.meta.url), 'utf8');
const comboboxSource = readFileSync(new URL('../public/combobox.js', import.meta.url), 'utf8');
const uiKitSource = readFileSync(new URL('../public/ui-kit.js', import.meta.url), 'utf8');
const amountCodecSource = readFileSync(new URL('../public/amount-codec.js', import.meta.url), 'utf8');
const draftStoreSource = readFileSync(new URL('../public/draft-store.js', import.meta.url), 'utf8');
const stylesCss = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

function createDom(html = '<!doctype html><html lang="tr"><body><main class="shell"></main></body></html>') {
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:4317/', runScripts: 'outside-only' });
  dom.window.eval(searchNormSource);
  dom.window.eval(uiKitSource);
  dom.window.eval(amountCodecSource);
  dom.window.eval(draftStoreSource);
  dom.window.eval(comboboxSource);
  return dom;
}

function keyEvent(window, key, opts = {}) {
  return new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts });
}

function inputEvent(window) {
  return new window.Event('input', { bubbles: true });
}

function clickEvent(window) {
  return new window.MouseEvent('click', { bubbles: true, cancelable: true });
}

async function createHttpFixture(t) {
  const dataDirectory = mkdtempSync(path.join(tmpdir(), 'kuyumcu-m2-combobox-'));
  const { server } = createApp({ dataDirectory, logger: () => {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    });
    rmSync(dataDirectory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (route, token, body) => {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    return fetch(`${base}${route}`, body === undefined ? { headers } : {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  };
  return { base, send };
}

// 1. Turkish Normalization (DefterSearchNorm)
test('1. DefterSearchNorm handles Turkish characters, ASCII fast-path parity, multi-token, and nullish values', () => {
  const { normalizeSearch, tokenizeSearch, searchHaystack, matchesSearch } = NodeSearchNorm;

  assert.equal(normalizeSearch('İSMAİL'), 'ismail');
  assert.equal(normalizeSearch('ismail'), 'ismail');
  assert.equal(normalizeSearch('Ismail'), 'ismail');
  assert.equal(normalizeSearch('IŞIK'), 'isik');
  assert.equal(normalizeSearch('ŞAHİN'), 'sahin');
  assert.equal(normalizeSearch('ÇİĞDEM'), 'cigdem');
  assert.equal(normalizeSearch('GÖKHAN'), 'gokhan');
  assert.equal(normalizeSearch('ÜMİT'), 'umit');
  assert.equal(normalizeSearch('  Çoklu   Boşluk\t\nTest  '), 'coklu bosluk test');
  assert.equal(normalizeSearch(null), '');
  assert.equal(normalizeSearch(undefined), '');
  assert.equal(normalizeSearch(''), '');
  assert.equal(normalizeSearch(0), '0');

  // Verify ASCII fast-path matches full tr-TR NFD path across all printable ASCII including 'I'
  for (let code = 32; code <= 126; code++) {
    const ch = String.fromCharCode(code);
    const sample = `A${ch}I${ch}Z`;
    const canonical = sample
      .toLocaleLowerCase('tr-TR')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/ı/g, 'i')
      .replace(/\s+/g, ' ')
      .trim();
    assert.equal(normalizeSearch(sample), canonical, `ASCII parity failed for char code ${code}`);
  }

  assert.deepEqual(tokenizeSearch('  Ahmet   YILMAZ '), ['ahmet', 'yilmaz']);
  assert.deepEqual(tokenizeSearch('   '), []);
  assert.equal(searchHaystack(['İsmail', null, 'Işık', 0]), 'ismail isik 0');
  assert.equal(matchesSearch('Ahmet Yılmaz 05321110001', 'yilmaz 0532'), true);
  assert.equal(matchesSearch('Ahmet Yılmaz 05321110001', '0532 AHMET'), true);
  assert.equal(matchesSearch('Ahmet Yılmaz', 'mehmet'), false);
  assert.equal(matchesSearch('Ahmet Yılmaz', ''), true);

  // JSDOM window.eval parity & isolation from globalThis.window overrides
  const dom = createDom();
  const winNorm = dom.window.DefterSearchNorm;
  assert.equal(winNorm.normalizeSearch('İsmail IŞIK Şahin'), 'ismail isik sahin');
  assert.equal(winNorm.matchesSearch(['Çiğdem', '0541 123 45 67'], 'cigdem 0541'), true);
});

// 2. Static Allowlist & CSP Hygiene
test('2. Static allowlist serves /search-norm.js and /combobox.js with strict CSP and CSS/JS hygiene', async t => {
  const { base } = await createHttpFixture(t);

  for (const asset of ['/search-norm.js', '/combobox.js']) {
    const res = await fetch(`${base}${asset}`);
    assert.equal(res.status, 200, `${asset} status`);
    assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const csp = res.headers.get('content-security-policy') || '';
    assert.match(csp, /\bscript-src 'self'/);
    assert.match(csp, /\bstyle-src 'self'/);
    const body = await res.text();
    assert.ok(body.length > 0);
  }

  assert.match(stylesCss, /\.defter-combobox\b/);
  assert.match(stylesCss, /\.defter-combobox-panel--portal\b/);
  assert.match(stylesCss, /\.defter-combobox-native\b/);
  assert.doesNotMatch(stylesCss, /var\(--accent\)/);

  for (const [name, src] of [['public/combobox.js', comboboxSource], ['public/search-norm.js', searchNormSource]]) {
    assert.doesNotMatch(src, /innerHTML/, `${name} must not use innerHTML`);
    assert.doesNotMatch(src, /\beval\s*\(/, `${name} must not use eval`);
    assert.doesNotMatch(src, /\bstyle\s*=/, `${name} must not embed style= attributes`);
    assert.doesNotMatch(src, /\bonclick\s*=/i, `${name} must not embed onclick= attributes`);
  }
});

// 3. /api/customers Upgrade & Role Boundaries
test('3. /api/customers supports Turkish folding, phone/taxId search, &meta=1, &limit=, and strict employee isolation', async t => {
  const { send } = await createHttpFixture(t);
  const setup = await send('/api/auth/setup', null, { name: 'Sahip', password: 'example-owner-test-2026' });
  assert.equal(setup.status, 201);
  const owner = await setup.json();

  const empRes = await send('/api/auth/employees', owner.token, { name: 'Tezgahtar', password: 'example-worker-test-2026' });
  assert.equal(empRes.status, 201);
  const emp = await empRes.json();
  const workerLogin = await send('/api/auth/login', null, { id: emp.id, password: 'example-worker-test-2026' });
  assert.equal(workerLogin.status, 200);
  const worker = await workerLogin.json();

  const initState = await (await send('/api/state', owner.token)).json();
  let rev = initState.revision;
  const openRes = await send('/api/command', owner.token, {
    id: randomUUID(),
    revision: rev,
    command: {
      type: 'opening',
      date: '2026-11-10',
      balances: Object.fromEntries(initState.accounts.filter(a => !a.retired).map(a => [a.id, a.id === 'nakit' ? '10000' : '0']))
    }
  });
  assert.equal(openRes.status, 200);
  rev = (await openRes.json()).state.revision;

  const createAcc = async cmd => {
    const res = await send('/api/command', owner.token, { id: randomUUID(), revision: rev, command: cmd });
    const data = await res.json();
    assert.equal(res.status, 200, JSON.stringify(data));
    rev = data.state.revision;
    return data.state;
  };

  await createAcc({ type: 'account', date: '2026-11-10', name: 'İsmail Koç', unit: 'TL', opening: '500', partyType: 'customer', phone: '0541 123 45 67', taxId: '44444444444' });
  await createAcc({ type: 'account', date: '2026-11-10', name: 'Işık Aydın', unit: 'HAS', opening: '10', partyType: 'customer', phone: '05321112233', taxId: '11111111115' });
  await createAcc({ type: 'account', date: '2026-11-10', name: 'Şahin Çelik', unit: 'TL', opening: '0', partyType: 'customer' });
  await createAcc({ type: 'account', date: '2026-11-10', name: 'Toptancı Yıldız', unit: 'HAS', opening: '0', partyType: 'supplier' });

  // 3a. Turkish folding
  const rIsmail = await send('/api/customers?workspace=demo&q=ismail', worker.token);
  assert.equal(rIsmail.status, 200);
  const aIsmail = await rIsmail.json();
  assert.ok(Array.isArray(aIsmail), 'Default /api/customers must return an Array');
  assert.equal(aIsmail.length, 1);
  assert.equal(aIsmail[0].name, 'İsmail Koç');
  assert.equal(Object.hasOwn(aIsmail[0], 'balance'), false);
  assert.equal(Object.hasOwn(aIsmail[0], 'costTL'), false);
  assert.equal(Object.hasOwn(aIsmail[0], 'opening'), false);
  assert.equal(Object.hasOwn(aIsmail[0], 'address'), false);
  assert.ok(aIsmail[0].disambiguationLabel.includes('TL'));

  const rIsik = await (await send('/api/customers?workspace=demo&q=isik', worker.token)).json();
  assert.equal(rIsik.length, 1);
  assert.equal(rIsik[0].name, 'Işık Aydın');

  const rSahin = await (await send('/api/customers?workspace=demo&q=sahin', worker.token)).json();
  assert.equal(rSahin.length, 1);
  assert.equal(rSahin[0].name, 'Şahin Çelik');

  // 3b. Phone (with and without spaces), taxId, and exact ID
  const rPhoneNoSpace = await (await send('/api/customers?workspace=demo&q=05411234567', worker.token)).json();
  assert.equal(rPhoneNoSpace.length, 1);
  assert.equal(rPhoneNoSpace[0].name, 'İsmail Koç');

  const rTax = await (await send('/api/customers?workspace=demo&q=11111111115', worker.token)).json();
  assert.equal(rTax.length, 1);
  assert.equal(rTax[0].name, 'Işık Aydın');

  const rExactId = await (await send(`/api/customers?workspace=demo&q=${encodeURIComponent(aIsmail[0].id)}`, worker.token)).json();
  assert.equal(rExactId.length, 1);
  assert.equal(rExactId[0].id, aIsmail[0].id);

  // 3c. Query < 2 chars or > 100 chars
  assert.deepEqual(await (await send('/api/customers?workspace=demo&q=', worker.token)).json(), []);
  assert.deepEqual(await (await send('/api/customers?workspace=demo&q=a', worker.token)).json(), []);
  assert.deepEqual(await (await send('/api/customers?workspace=demo&q=%C4%B0', worker.token)).json(), []);
  assert.deepEqual(await (await send(`/api/customers?workspace=demo&q=${'x'.repeat(120)}`, worker.token)).json(), []);

  // 3d. &meta=1 and &limit= pagination + invalid limit 400
  for (let i = 0; i < 6; i++) {
    await createAcc({ type: 'account', date: '2026-11-10', name: `Müşteri Seri ${i}`, unit: 'TL', opening: '0', partyType: 'customer' });
  }
  const metaRes = await send('/api/customers?workspace=demo&q=seri&limit=3&meta=1', worker.token);
  assert.equal(metaRes.status, 200);
  const metaBody = await metaRes.json();
  assert.equal(metaBody.items.length, 3);
  assert.equal(metaBody.total, 6);
  assert.equal(metaBody.limit, 3);
  assert.equal(metaBody.truncated, true);

  const clampedRes = await (await send('/api/customers?workspace=demo&q=seri&limit=999&meta=1', worker.token)).json();
  assert.equal(clampedRes.limit, 50);

  assert.equal((await send('/api/customers?workspace=demo&q=seri&limit=0', worker.token)).status, 400);
  assert.equal((await send('/api/customers?workspace=demo&q=seri&limit=abc', worker.token)).status, 400);

  // 3e. Strict employee exclusions (retired, supplier, parentAccountId child, asset accounts)
  assert.deepEqual(await (await send('/api/customers?workspace=demo&q=Toptanc', worker.token)).json(), []);
  assert.deepEqual(await (await send('/api/customers?workspace=demo&q=nakit', worker.token)).json(), []);
  assert.deepEqual(await (await send('/api/customers?workspace=demo&q=gramAdet', worker.token)).json(), []);
  assert.deepEqual(await (await send('/api/customers?workspace=demo&q=banka', worker.token)).json(), []);

  // Synthetic state check for retired receivable & parentAccountId child isolation
  const childBlocked = customerChoices({
    accounts: [
      { id: 'cari-retired', name: 'Alt Hesap Emekli', unit: 'TL', kind: 'receivable', retired: true },
      { id: 'cari-child', name: 'Alt Hesap Çocuk', unit: 'TL', kind: 'receivable', retired: false, parentAccountId: 'sup-1' },
      { id: 'cari-ok', name: 'Alt Hesap Normal', unit: 'TL', kind: 'receivable', retired: false }
    ]
  }, 'Alt Hesap');
  assert.deepEqual(childBlocked.map(c => c.id), ['cari-ok']);

  // 10,000-customer customerChoices scale & latency check
  const bigAccounts = [];
  for (let i = 0; i < 9999; i++) {
    bigAccounts.push({ id: `cari-bd-${i}`, name: `Sentetik Müşteri ${i}`, unit: 'TL', kind: 'receivable', retired: false, partyType: 'customer', phone: `0530${String(i).padStart(7, '0')}` });
  }
  bigAccounts.push({ id: 'cari-bd-needle-ismail', name: 'İsmail Hedef', unit: 'HAS', kind: 'receivable', retired: false, partyType: 'customer', phone: '05419998877', taxId: '77777777777' });
  const tBig = performance.now();
  const bigMeta = customerChoices({ accounts: bigAccounts }, 'hedef', { limit: 20, meta: true });
  const bigMs = performance.now() - tBig;
  assert.equal(bigMeta.items.length, 1);
  assert.equal(bigMeta.items[0].id, 'cari-bd-needle-ismail');
  assert.ok(bigMs < 100, `10k customerChoices took ${bigMs.toFixed(2)}ms`);

  // Employee remains 403 on owner routes
  for (const ownerRoute of ['/api/state', '/api/suppliers', '/api/journal']) {
    assert.equal((await send(ownerRoute, worker.token)).status, 403, ownerRoute);
  }
  const det = customerDetail(await (await send('/api/state', owner.token)).json(), aIsmail[0].id);
  assert.equal(det.name, 'İsmail Koç');
});

// 4. Combobox ARIA Contract
test('4. Combobox maintains ARIA attributes, status summary, and option semantics', () => {
  const dom = createDom();
  const { window } = dom;
  const { document } = window;
  const host = document.querySelector('main');

  const cb = window.DefterCombobox.create({
    container: host,
    label: 'Müşteri',
    items: [
      { id: 'c1', label: 'Ali Veli', unit: 'TL' },
      { id: 'c2', label: 'Pasif Kart', unit: 'TL', disabled: true, disabledReason: 'Emekli' },
      { id: 'c3', label: 'Zeynep Kaya', unit: 'HAS' }
    ]
  });

  assert.equal(cb.input.getAttribute('role'), 'combobox');
  assert.equal(cb.input.getAttribute('aria-autocomplete'), 'list');
  assert.equal(cb.input.getAttribute('aria-expanded'), 'false');
  assert.equal(cb.input.getAttribute('aria-controls'), cb.listbox.id);
  assert.equal(cb.input.getAttribute('aria-activedescendant'), null);
  assert.equal(cb.listbox.getAttribute('role'), 'listbox');
  assert.equal(cb.statusEl.getAttribute('role'), 'status');
  assert.equal(cb.statusEl.getAttribute('aria-live'), 'polite');

  cb.open();
  assert.equal(cb.input.getAttribute('aria-expanded'), 'true');
  const opts = [...cb.listbox.querySelectorAll('[role="option"]')];
  assert.equal(opts.length, 3);
  assert.equal(opts[0].tagName, 'BUTTON');
  assert.equal(opts[0].type, 'button');
  assert.equal(opts[0].getAttribute('tabindex'), '-1');
  assert.equal(opts[1].getAttribute('aria-disabled'), 'true');
  assert.equal(cb.input.getAttribute('aria-activedescendant'), opts[0].id);
  assert.match(cb.statusEl.textContent, /3 \/ 3 kayıt/);

  cb.input.value = 'olmayan-kisi';
  cb.input.dispatchEvent(inputEvent(window));
  assert.equal(cb.listbox.querySelectorAll('[role="option"]').length, 0);
  assert.equal(cb.input.getAttribute('aria-activedescendant'), null);
  assert.equal(cb.statusEl.textContent, 'Sonuç bulunamadı.');

  cb.close({ restoreText: true });
  assert.equal(cb.input.getAttribute('aria-expanded'), 'false');
  assert.equal(cb.input.getAttribute('aria-activedescendant'), null);
});

// 5. Keyboard Navigation & Form Submit Guard
test('5. Keyboard navigation skips disabled items, commits on Enter without form submit, preserves committed on Escape, and closes on Tab', () => {
  const dom = createDom('<!doctype html><html lang="tr"><body><form id="f"><div id="mount"></div><button type="submit">Kaydet</button></form></body></html>');
  const { window } = dom;
  const { document } = window;
  const form = document.getElementById('f');
  let submitted = 0;
  form.addEventListener('submit', e => {
    e.preventDefault();
    submitted++;
  });

  let changeCount = 0;
  const cb = window.DefterCombobox.create({
    container: document.getElementById('mount'),
    items: [
      { id: 'd0', label: 'Başta Pasif', disabled: true },
      { id: 'e1', label: 'Birinci Aktif' },
      { id: 'd2', label: 'Ortada Pasif', disabled: true },
      { id: 'e3', label: 'İkinci Aktif' },
      { id: 'd4', label: 'Sonda Pasif', disabled: true }
    ],
    onChange: () => { changeCount++; }
  });

  cb.open();
  const opts = [...cb.listbox.querySelectorAll('[role="option"]')];
  assert.equal(cb.input.getAttribute('aria-activedescendant'), opts[1].id, 'Should skip disabled first item');

  cb.input.dispatchEvent(keyEvent(window, 'ArrowDown'));
  assert.equal(cb.input.getAttribute('aria-activedescendant'), opts[3].id, 'ArrowDown should skip middle disabled item');

  cb.input.dispatchEvent(keyEvent(window, 'ArrowDown'));
  assert.equal(cb.input.getAttribute('aria-activedescendant'), opts[3].id, 'ArrowDown should not move onto disabled tail item');

  cb.input.dispatchEvent(keyEvent(window, 'ArrowUp'));
  assert.equal(cb.input.getAttribute('aria-activedescendant'), opts[1].id, 'ArrowUp should skip middle disabled item');

  cb.input.dispatchEvent(keyEvent(window, 'End'));
  assert.equal(cb.input.getAttribute('aria-activedescendant'), opts[3].id, 'End jumps to last enabled');

  cb.input.dispatchEvent(keyEvent(window, 'Home'));
  assert.equal(cb.input.getAttribute('aria-activedescendant'), opts[1].id, 'Home jumps to first enabled');

  const enterEv = keyEvent(window, 'Enter');
  cb.input.dispatchEvent(enterEv);
  assert.equal(enterEv.defaultPrevented, true);
  assert.equal(submitted, 0, 'Enter while open must NOT submit enclosing form');
  assert.equal(cb.getValue(), 'e1');
  assert.equal(changeCount, 1);
  assert.equal(cb.input.getAttribute('aria-expanded'), 'false');

  // Escape while typing uncommitted text restores committed label without clearing committed value
  cb.open();
  cb.input.value = 'İkinci';
  cb.input.dispatchEvent(inputEvent(window));
  const escEv = keyEvent(window, 'Escape');
  cb.input.dispatchEvent(escEv);
  assert.equal(escEv.defaultPrevented, true);
  assert.equal(cb.getValue(), 'e1');
  assert.equal(cb.input.value, 'Birinci Aktif');
  assert.equal(cb.input.getAttribute('aria-expanded'), 'false');

  // Tab closes without preventDefault
  cb.open();
  const tabEv = keyEvent(window, 'Tab');
  cb.input.dispatchEvent(tabEv);
  assert.equal(tabEv.defaultPrevented, false);
  assert.equal(cb.input.getAttribute('aria-expanded'), 'false');
});

// 6. Similar-Name Disambiguation
test('6. Similar-name items display distinct badges/metadata and select exact ID', () => {
  const dom = createDom();
  const { window } = dom;
  const cb = window.DefterCombobox.create({
    container: window.document.querySelector('main'),
    items: [
      { id: 'cari-ahmet-tl', label: 'Ahmet Yılmaz', unit: 'TL', phone: '05321110001', taxId: '10000000001' },
      { id: 'cari-ahmet-has', label: 'Ahmet Yılmaz', unit: 'HAS', phone: '05329998877', taxId: '90000000009' },
      { id: 'cari-mehmet-1', label: 'Mehmet Yılmaz', unit: 'TL', phone: '05441112233' },
      { id: 'cari-mehmet-2', label: 'Mehmet Yılmaz (Merkez)', unit: 'USD', phone: '05441112244' }
    ]
  });

  cb.open();
  cb.input.value = 'Ahmet Yılmaz';
  cb.input.dispatchEvent(inputEvent(window));
  const opts = [...cb.listbox.querySelectorAll('[role="option"]')];
  assert.equal(opts.length, 2);
  assert.equal(opts[0].querySelector('.defter-combobox-badge--unit').textContent, 'TL');
  assert.equal(opts[1].querySelector('.defter-combobox-badge--unit').textContent, 'HAS');
  assert.match(opts[0].querySelector('.defter-combobox-meta').textContent, /05321110001/);
  assert.match(opts[1].querySelector('.defter-combobox-meta').textContent, /05329998877/);

  opts[1].dispatchEvent(clickEvent(window));
  assert.equal(cb.getValue(), 'cari-ahmet-has');
});

// 7. Disabled/Retired & Invalid Free-Text Rejection
test('7. Disabled/retired items cannot be selected and invalid free text never becomes committed value', () => {
  const dom = createDom();
  const { window } = dom;
  const cb = window.DefterCombobox.create({
    container: window.document.querySelector('main'),
    value: 'active-1',
    items: [
      { id: 'active-1', label: 'Aktif Müşteri', unit: 'TL' },
      { id: 'retired-1', label: 'Emekli Müşteri', unit: 'TL', retired: true, disabledReason: 'Pasif' },
      { id: 'zero-stock', label: 'Çeyrek Altın', unit: 'ADET', disabled: true, disabledReason: 'Stok Yok' }
    ]
  });

  cb.open();
  const opts = [...cb.listbox.querySelectorAll('[role="option"]')];
  assert.equal(opts[1].getAttribute('aria-disabled'), 'true');
  assert.equal(opts[1].querySelector('.defter-combobox-badge--retired').textContent, 'Pasif');
  assert.equal(opts[2].getAttribute('aria-disabled'), 'true');
  assert.equal(opts[2].querySelector('.defter-combobox-badge--retired').textContent, 'Stok Yok');

  // Clicking disabled item does not change committed value
  opts[1].dispatchEvent(clickEvent(window));
  assert.equal(cb.getValue(), 'active-1');

  // Typing disabled-only query and pressing Enter does not commit disabled item
  cb.input.value = 'Emekli';
  cb.input.dispatchEvent(inputEvent(window));
  assert.equal(cb.input.getAttribute('aria-activedescendant'), null);
  cb.input.dispatchEvent(keyEvent(window, 'Enter'));
  assert.equal(cb.getValue(), 'active-1');

  // Typing invalid free text and blurring keeps committed value intact and flags invalid
  cb.input.value = 'olmayan-musteri-xyz';
  cb.input.dispatchEvent(inputEvent(window));
  cb.input.dispatchEvent(new window.FocusEvent('blur'));
  assert.equal(cb.getValue(), 'active-1');
  assert.notEqual(cb.getValue(), 'olmayan-musteri-xyz');
  assert.equal(cb.input.getAttribute('aria-invalid'), 'true');
  assert.equal(cb.input.validity.customError, true);

  // Revert behavior test
  const cbRevert = window.DefterCombobox.create({
    container: window.document.querySelector('main'),
    value: 'active-1',
    invalidTextBehavior: 'revert',
    items: [{ id: 'active-1', label: 'Aktif Müşteri' }]
  });
  cbRevert.input.value = 'gecersiz-yazi';
  cbRevert.input.dispatchEvent(new window.FocusEvent('blur'));
  assert.equal(cbRevert.getValue(), 'active-1');
  assert.equal(cbRevert.input.value, 'Aktif Müşteri');
  assert.equal(cbRevert.input.validity.valid, true);
});

// 8. XSS Injection Safety
test('8. XSS payloads in item labels, metadata, badges, and search queries are rendered strictly via textContent', () => {
  const dom = createDom();
  const { window } = dom;
  const host = window.document.querySelector('main');
  const xssName = '<img src=x onerror=window.__xss=1>';
  const xssMeta = '<script>window.__xss=2</script>';
  const xssBadge = '"><svg onload=window.__xss=3>';
  const xssQuery = '<img src=x onerror=alert(1)>';

  const cb = window.DefterCombobox.create({
    container: host,
    items: [
      { id: 'xss-1', label: xssName, meta: xssMeta, badge: xssBadge }
    ]
  });

  cb.open();
  assert.equal(window.__xss, undefined);
  assert.equal(cb.panel.querySelectorAll('img, script, svg').length, 0);
  const opt = cb.listbox.querySelector('[role="option"]');
  assert.equal(opt.querySelector('.defter-combobox-label').textContent, xssName);
  assert.match(opt.querySelector('.defter-combobox-meta').textContent, /<script>window\.__xss=2<\/script>/);
  assert.equal(opt.querySelector('.defter-combobox-badge').textContent, xssBadge);

  cb.input.value = xssQuery;
  cb.input.dispatchEvent(inputEvent(window));
  assert.equal(window.__xss, undefined);
  assert.equal(cb.panel.querySelectorAll('img, script, svg').length, 0);
});

// 9. 10,000-Item R4 Performance & DOM Cap
test('9. 10,000-item dataset enforces <= 20 [role="option"], <= 2 <option>, accurate tail lookup, and bounded latency', () => {
  const dom = createDom('<!doctype html><html lang="tr"><body><label class="field"><span>Müşteri</span><select id="big-sel"><option value="">Seçiniz</option></select></label></body></html>');
  const { window } = dom;
  const select = window.document.getElementById('big-sel');

  const items = [];
  for (let i = 0; i < 9999; i++) {
    items.push({ id: `cust-${i}`, label: `Müşteri Kaydı ${i}`, unit: i % 2 === 0 ? 'TL' : 'HAS', phone: `0530${String(i).padStart(7, '0')}` });
  }
  items.push({ id: 'cust-tail', label: 'İsmail Hedef Son', unit: 'HAS', phone: '05419998877' });

  const cb = window.DefterCombobox.enhanceSelect(select, { items });
  assert.ok(select.options.length <= 2, `Expected <= 2 <option> nodes, got ${select.options.length}`);

  cb.open();
  assert.ok(cb.listbox.querySelectorAll('[role="option"]').length <= 20);
  assert.match(cb.statusEl.textContent, /20 \/ 10\.000 kayıt/);

  // Broad query still capped at <= 20
  cb.input.value = 'müşteri';
  cb.input.dispatchEvent(inputEvent(window));
  assert.ok(cb.listbox.querySelectorAll('[role="option"]').length <= 20);
  assert.match(cb.statusEl.textContent, /20 \/ 10\.000 kayıt/);

  // Cold tail search latency check
  const t0 = performance.now();
  cb.input.value = 'hedef';
  cb.input.dispatchEvent(inputEvent(window));
  const coldMs = performance.now() - t0;
  const tailOpts = [...cb.listbox.querySelectorAll('[role="option"]')];
  assert.equal(tailOpts.length, 1);
  assert.match(tailOpts[0].textContent, /İsmail Hedef Son/);
  assert.ok(coldMs < 85, `Cold 10k search took ${coldMs.toFixed(2)}ms (>= 85ms)`);

  // Warm repeat query latency check
  const t1 = performance.now();
  cb.input.value = 'müşteri';
  cb.input.dispatchEvent(inputEvent(window));
  const warmMs = performance.now() - t1;
  assert.ok(warmMs < 35, `Warm 10k search took ${warmMs.toFixed(2)}ms (>= 35ms)`);

  // ArrowDown O(1) step latency
  const t2 = performance.now();
  cb.input.dispatchEvent(keyEvent(window, 'ArrowDown'));
  const stepMs = performance.now() - t2;
  assert.ok(stepMs < 16.6, `ArrowDown step took ${stepMs.toFixed(2)}ms (>= 16.6ms)`);
});

// 10. <dialog> Top-Layer Mounting, Escape Isolation, Tab Skip & reportValidity()
test('10. Inside <dialog>, listbox mounts inside dialog subtree, Escape closes listbox before dialog, Tab skips hidden select, and reportValidity() focuses input', () => {
  const dom = createDom();
  const { window } = dom;
  const { document } = window;
  const UI = window.DefterUI;

  const form = document.createElement('form');
  const label = document.createElement('label');
  label.className = 'field';
  const span = document.createElement('span');
  span.textContent = 'Cari Seçimi';
  const select = document.createElement('select');
  select.id = 'dlg-select';
  select.name = 'counterpartyId';
  select.required = true;
  const emptyOpt = document.createElement('option');
  emptyOpt.value = '';
  emptyOpt.textContent = 'Seçin';
  const opt1 = document.createElement('option');
  opt1.value = 'c-1';
  opt1.textContent = 'Birinci Cari';
  select.append(emptyOpt, opt1);
  label.append(span, select);
  const afterBtn = document.createElement('button');
  afterBtn.type = 'submit';
  afterBtn.textContent = 'Kaydet';
  form.append(label, afterBtn);

  const layer = UI.openModal({ title: 'Modal Test', content: form });
  assert.equal(UI.getLayerCount(), 1);

  const cb = window.DefterCombobox.enhanceSelect(select);
  cb.open();

  // 10a. Listbox inside dialog subtree (never outside on body directly)
  assert.equal(layer.dialog.contains(cb.listbox), true);
  assert.equal(layer.dialog.contains(cb.panel), true);
  assert.equal(cb.panel.classList.contains('defter-combobox-panel--portal'), true);

  // 10b. First Escape closes ONLY combobox
  const esc1 = keyEvent(window, 'Escape');
  cb.input.dispatchEvent(esc1);
  assert.equal(cb.input.getAttribute('aria-expanded'), 'false');
  assert.equal(UI.getLayerCount(), 1);
  assert.equal(layer.dialog.hasAttribute('open'), true);

  // 10c. Second Escape closes dialog
  const esc2 = keyEvent(window, 'Escape');
  cb.input.dispatchEvent(esc2);
  assert.equal(UI.getLayerCount(), 0);

  // Reopen modal for Tab & reportValidity checks
  const form2 = document.createElement('form');
  const lbl2 = document.createElement('label');
  lbl2.className = 'field';
  const sel2 = document.createElement('select');
  sel2.id = 'dlg-select-2';
  sel2.required = true;
  const eOpt2 = document.createElement('option');
  eOpt2.value = '';
  eOpt2.textContent = 'Seçin';
  const o2 = document.createElement('option');
  o2.value = 'c-2';
  o2.textContent = 'İkinci Cari';
  sel2.append(eOpt2, o2);
  lbl2.append(sel2);
  form2.append(lbl2);
  const layer2 = UI.openModal({ title: 'Validasyon', content: form2 });
  const cb2 = window.DefterCombobox.enhanceSelect(sel2);

  // 10d. Tab and Shift+Tab trap skips .defter-combobox-native and tabindex="-1" buttons
  const closeBtn = layer2.dialog.querySelector('.defter-dialog-close');
  cb2.input.focus();
  assert.equal(document.activeElement, cb2.input);
  cb2.input.dispatchEvent(keyEvent(window, 'Tab'));
  assert.equal(document.activeElement, closeBtn, 'Forward Tab from cb.input must wrap to closeBtn');
  closeBtn.dispatchEvent(keyEvent(window, 'Tab', { shiftKey: true }));
  assert.equal(document.activeElement, cb2.input, 'Shift+Tab from closeBtn must wrap to cb.input, skipping toggleBtn/clearBtn');

  // 10e. reportValidity() works without "not focusable" error and invalid focuses visible combobox input
  assert.equal(form2.checkValidity(), false);
  const invalidEv = new window.Event('invalid', { cancelable: true });
  sel2.dispatchEvent(invalidEv);
  assert.equal(invalidEv.defaultPrevented, true, 'invalid on backing select must preventDefault so native focus does not steal from cb.input');
  assert.equal(form2.reportValidity(), false);
  assert.equal(document.activeElement, cb2.input);
  assert.equal(cb2.input.getAttribute('aria-invalid'), 'true');
  layer2.close();
});

// 11. Async Debounced Search & AbortController Race Safety
test('11. Async provider debounces rapid typing, aborts stale requests, discards out-of-order responses, and shows errors safely', async () => {
  const dom = createDom();
  const { window } = dom;
  const calls = [];
  const resolvers = new Map();

  const cb = window.DefterCombobox.create({
    container: window.document.querySelector('main'),
    debounceMs: 30,
    minQueryLength: 2,
    provider: (query, { signal }) => {
      const idx = calls.length;
      calls.push({ query, signal });
      return new Promise((resolve, reject) => {
        resolvers.set(idx, { resolve, reject, signal });
      });
    }
  });

  // 11a. Rapid typing within debounce window triggers only 1 call
  for (const q of ['m', 'me', 'meh', 'mehm']) {
    cb.input.value = q;
    cb.input.dispatchEvent(inputEvent(window));
  }
  await new Promise(r => setTimeout(r, 60));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].query, 'mehm');
  resolvers.get(0).resolve([{ id: 'm1', label: 'Mehmet Öz', unit: 'TL' }]);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(cb.listbox.querySelectorAll('[role="option"]').length, 1);
  assert.match(cb.listbox.textContent, /Mehmet Öz/);

  // 11b. Out-of-order resolution: slow request A aborted & resolved after request B
  cb.input.value = 'ab';
  cb.input.dispatchEvent(inputEvent(window));
  await new Promise(r => setTimeout(r, 50));
  assert.equal(calls.length, 2);
  const reqA = calls[1];
  assert.equal(reqA.signal.aborted, false);

  cb.input.value = 'ahmet';
  cb.input.dispatchEvent(inputEvent(window));
  await new Promise(r => setTimeout(r, 50));
  assert.equal(calls.length, 3);
  assert.equal(reqA.signal.aborted, true, 'Prior async request AbortSignal must be aborted');

  // Resolve newer B first
  resolvers.get(2).resolve({ items: [{ id: 'a1', label: 'Ahmet Yeni', unit: 'HAS' }], total: 1 });
  await new Promise(r => setTimeout(r, 10));
  assert.match(cb.listbox.textContent, /Ahmet Yeni/);

  // Resolve stale A afterwards — must be ignored
  resolvers.get(1).resolve([{ id: 'ab1', label: 'Eski Sonuç', unit: 'TL' }]);
  await new Promise(r => setTimeout(r, 10));
  assert.doesNotMatch(cb.listbox.textContent, /Eski Sonuç/);
  assert.match(cb.listbox.textContent, /Ahmet Yeni/);

  // 11c. Active request rejection shows error state cleanly
  cb.input.value = 'hata';
  cb.input.dispatchEvent(inputEvent(window));
  await new Promise(r => setTimeout(r, 50));
  assert.equal(calls.length, 4);
  resolvers.get(3).reject(new Error('Sunucu yanıt vermedi.'));
  await new Promise(r => setTimeout(r, 10));
  const errBox = cb.panel.querySelector('[data-combobox-error].defter-combobox-empty--error');
  assert.ok(errBox);
  assert.equal(errBox.hidden, false);
  assert.equal(errBox.textContent, 'Sunucu yanıt vermedi.');
  assert.equal(cb.statusEl.textContent, 'Sunucu yanıt vermedi.');
});

// 12. DefterDraftStore & DefterAmountCodec (10.500) Non-Interference
test('12. Preserves DefterDraftStore select sync and DefterAmountCodec 10.500 disambiguation without interference', () => {
  const dom = createDom(`<!doctype html><html lang="tr"><body>
    <form id="trade-form" data-draft-key="sale">
      <label class="field"><span>Müşteri</span><select id="f-counterpartyId" name="counterpartyId"><option value="">Seçilmedi</option></select></label>
      <label class="field"><span>Miktar</span><input id="qty" name="qty" type="text"></label>
      <button type="submit">Kaydet</button>
    </form>
  </body></html>`);
  const { window } = dom;
  const { document } = window;
  const select = document.getElementById('f-counterpartyId');
  const qtyInput = document.getElementById('qty');

  const items = [];
  for (let i = 0; i < 60; i++) {
    items.push({ id: `cust-${i}`, label: `Cari ${i}`, unit: 'GRAM' });
  }
  const cb = window.DefterCombobox.enhanceSelect(select, { items });
  assert.ok(select.options.length <= 2);

  // Combobox input has no id/name so draftFields only captures canonical select
  assert.equal(cb.input.hasAttribute('id'), false);
  assert.equal(cb.input.hasAttribute('name'), false);

  let changeFired = 0;
  select.addEventListener('change', () => { changeFired++; });
  cb.setValue('cust-42', { emitChange: true });
  assert.equal(select.value, 'cust-42');
  assert.equal(cb.input.value, 'Cari 42');
  assert.equal(changeFired, 1);
  assert.ok(select.options.length <= 2);

  // Direct select.value = ... (draft-store restore pattern) syncs combobox display
  select.value = 'cust-15';
  assert.equal(select.value, 'cust-15');
  assert.equal(cb.getValue(), 'cust-15');
  assert.equal(cb.input.value, 'Cari 15');

  // setBusy simulation: disabling native select disables combobox synchronously
  select.disabled = true;
  assert.equal(cb.input.disabled, true);
  select.disabled = false;
  assert.equal(cb.input.disabled, false);

  // DefterAmountCodec 10.500 disambiguation non-interference while combobox is open
  cb.open();
  assert.equal(cb.input.getAttribute('aria-expanded'), 'true');
  qtyInput.value = '10.500';
  const parsed = window.DefterAmountCodec.parseInputElement(qtyInput, 'GRAM', true);
  assert.equal(parsed, null);
  assert.equal(qtyInput.validity.valid, false);
  const box = qtyInput.parentElement.querySelector('.amount-disambiguation');
  assert.ok(box, '.amount-disambiguation box must render');
  assert.ok(box.querySelector('[data-amount-choice="thousands"]'));
  const decimalBtn = box.querySelector('[data-amount-choice="decimal"]');
  assert.ok(decimalBtn);

  // Clicking disambiguation button resolves 10.500 cleanly without combobox interference
  decimalBtn.dispatchEvent(new window.Event('pointerdown', { bubbles: true, cancelable: true }));
  decimalBtn.dispatchEvent(clickEvent(window));
  const resolved = window.DefterAmountCodec.parseInputElement(qtyInput, 'GRAM', true);
  assert.equal(resolved, 10500);
  assert.equal(qtyInput.dataset.canonicalAmount, '10.500');
  assert.equal(qtyInput.validity.valid, true);
  assert.equal(cb.input.getAttribute('aria-expanded'), 'false');
});

// 13. Regression: selectEl focus forwarding (label click / native focus) -> combobox.input
test('13. Native focus on backing select forwards to combobox.input and preserves destroy() cleanup', () => {
  const dom = createDom('<!doctype html><html lang="tr"><body><label class="field"><span>Cari</span><select id="lbl-sel"><option value="">Seç</option><option value="c1">Ali</option></select></label></body></html>');
  const { window } = dom;
  const { document } = window;
  const select = document.getElementById('lbl-sel');
  const cb = window.DefterCombobox.enhanceSelect(select);

  select.dispatchEvent(new window.FocusEvent('focus'));
  assert.equal(document.activeElement, cb.input, 'Focus on backing select must forward to combobox.input');

  cb.destroy();
  const prevActive = document.activeElement;
  select.dispatchEvent(new window.FocusEvent('focus'));
  assert.equal(document.activeElement, prevActive, 'Destroyed combobox must no longer forward select focus');
});

// 14. Regression: 10,000 realistic Turkish items cold build+search < 85ms (create & enhanceSelect)
test('14. 10,000 realistic Turkish items cold create+search and enhanceSelect+search stay under 85ms with full SearchNorm parity', () => {
  const { normalizeSearch } = NodeSearchNorm;
  const canonical = s => String(s ?? '').toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i').replace(/\s+/g, ' ').trim();
  for (let cp = 0; cp <= 0x02ff; cp++) {
    const ch = String.fromCharCode(cp);
    assert.equal(normalizeSearch(`A${ch}İ${ch}Ş`), canonical(`A${ch}İ${ch}Ş`), `SearchNorm parity failed at 0x${cp.toString(16)}`);
  }

  const dom = createDom('<!doctype html><html lang="tr"><body><main></main><select id="tr-sel"><option value="">Seç</option></select></body></html>');
  const { window } = dom;

  const createItems = [];
  for (let i = 0; i < 9999; i++) {
    createItems.push({ id: `tr-c-${i}`, label: `Şükrü Çağlar Öztürk ${i}`, unit: i % 2 === 0 ? 'TL' : 'HAS', phone: `0530${String(i).padStart(7, '0')}` });
  }
  createItems.push({ id: 'tr-c-tail', label: 'İsmail Hedef Şahin', unit: 'HAS', phone: '05419998877' });

  const t0 = performance.now();
  const cbCreate = window.DefterCombobox.create({ container: window.document.querySelector('main'), items: createItems });
  cbCreate.open();
  cbCreate.input.value = 'hedef sahin';
  cbCreate.input.dispatchEvent(inputEvent(window));
  const coldCreateMs = performance.now() - t0;
  assert.equal(cbCreate.listbox.querySelectorAll('[role="option"]').length, 1);
  assert.ok(coldCreateMs < 85, `Cold Turkish 10k create+search took ${coldCreateMs.toFixed(2)}ms (>= 85ms)`);

  const enhanceItems = [];
  for (let i = 0; i < 9999; i++) {
    enhanceItems.push({ id: `tr-e-${i}`, label: `Gökhan Ünal Çiçek ${i}`, unit: 'TL', phone: `0542${String(i).padStart(7, '0')}` });
  }
  enhanceItems.push({ id: 'tr-e-tail', label: 'Işık Özgün Yıldız', unit: 'HAS', phone: '05418887766' });

  const t1 = performance.now();
  const cbEnhance = window.DefterCombobox.enhanceSelect(window.document.getElementById('tr-sel'), { items: enhanceItems });
  cbEnhance.open();
  cbEnhance.input.value = 'isik ozgun';
  cbEnhance.input.dispatchEvent(inputEvent(window));
  const coldEnhanceMs = performance.now() - t1;
  assert.equal(cbEnhance.listbox.querySelectorAll('[role="option"]').length, 1);
  assert.ok(coldEnhanceMs < 85, `Cold Turkish 10k enhanceSelect+search took ${coldEnhanceMs.toFixed(2)}ms (>= 85ms)`);
});

// 15. Regression: enhanceSelect(...).destroy() restores > 50 pre-populated <select> options & .value mutability
test('15. enhanceSelect().destroy() restores full <option> list and .value mutability on > 50-option <select>', () => {
  const dom = createDom('<!doctype html><html lang="tr"><body><select id="prepop"></select></body></html>');
  const { window } = dom;
  const { document } = window;
  const select = document.getElementById('prepop');

  const emptyOpt = document.createElement('option');
  emptyOpt.value = '';
  emptyOpt.textContent = 'Seçiniz';
  select.append(emptyOpt);
  for (let i = 0; i < 80; i++) {
    const opt = document.createElement('option');
    opt.value = `opt-${i}`;
    opt.textContent = `Seçenek ${i}`;
    select.append(opt);
  }
  assert.equal(select.options.length, 81);

  const cb = window.DefterCombobox.enhanceSelect(select);
  assert.ok(select.options.length <= 2, 'Should compact options while enhanced');
  cb.setValue('opt-25', { emitChange: false });
  assert.equal(select.value, 'opt-25');

  cb.destroy();
  assert.equal(select.options.length, 81, 'destroy() must restore all 81 original <option> elements');
  assert.equal(select.value, 'opt-25', 'destroy() must preserve committed value');
  select.value = 'opt-50';
  assert.equal(select.value, 'opt-50', 'Native .value setter must work on restored options after destroy()');
});

// 16. Regression: allowEmpty: false + > 50 compact <select> rejects invalid/empty value without desync
test('16. allowEmpty: false on > 50 compact <select> prevents desync when invalid or empty value is assigned', () => {
  const dom = createDom('<!doctype html><html lang="tr"><body><select id="no-empty"></select></body></html>');
  const { window } = dom;
  const select = window.document.getElementById('no-empty');

  const items = [];
  for (let i = 0; i < 60; i++) {
    items.push({ id: `k-${i}`, label: `Kalem ${i}`, unit: 'ADET' });
  }
  const cb = window.DefterCombobox.enhanceSelect(select, { items, allowEmpty: false, value: 'k-5' });
  assert.equal(select.value, 'k-5');
  assert.equal(cb.getValue(), 'k-5');

  select.value = 'nonexistent-id';
  assert.equal(cb.getValue(), 'k-5');
  assert.equal(select.value, 'k-5', 'Invalid select.value must not leave compact select desynced as empty string');

  select.value = '';
  assert.equal(cb.getValue(), 'k-5');
  assert.equal(select.value, 'k-5', 'Empty select.value with allowEmpty: false must not desync compact select');

  select.value = 'k-12';
  assert.equal(select.value, 'k-12');
  assert.equal(cb.getValue(), 'k-12');
});
