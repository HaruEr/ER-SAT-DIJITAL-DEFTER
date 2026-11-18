import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadJSDOM } from '../test-support/jsdom.mjs';
import { createApp } from '../server.mjs';

const JSDOM = await loadJSDOM();

const searchNormSource = readFileSync(new URL('../public/search-norm.js', import.meta.url), 'utf8');
const uiKitSource = readFileSync(new URL('../public/ui-kit.js', import.meta.url), 'utf8');
const commandPaletteSource = readFileSync(new URL('../public/command-palette.js', import.meta.url), 'utf8');
const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const checkoutHtml = readFileSync(new URL('../public/checkout.html', import.meta.url), 'utf8');
const stylesCss = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

const tick = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));

function createDom({
  html = '<!doctype html><html lang="tr"><body><div class="shell"><main id="main" tabindex="-1"><button id="trigger-btn" type="button" data-command-palette-trigger aria-haspopup="dialog" aria-expanded="false">Komutlar</button><button id="other-btn" type="button">Diğer</button></main></div></body></html>',
  withSearchNorm = true,
  withUiKit = true,
  url = 'http://127.0.0.1:4317/owner#v=overview'
} = {}) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  if (withSearchNorm) dom.window.eval(searchNormSource);
  if (withUiKit) dom.window.eval(uiKitSource);
  dom.window.eval(commandPaletteSource);
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
  const dataDirectory = mkdtempSync(path.join(tmpdir(), 'kuyumcu-m3-cp-'));
  const { server } = createApp({ dataDirectory, logger: () => {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    });
    rmSync(dataDirectory, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${server.address().port}` };
}

// 1. Static Allowlist, HTML Wiring & CSP/XSS Hygiene
test('1. Static allowlist, HTML script/trigger wiring, and strict CSP/XSS hygiene', async t => {
  const { base } = await createHttpFixture(t);

  for (const asset of ['/search-norm.js', '/combobox.js', '/command-palette.js']) {
    const res = await fetch(`${base}${asset}`);
    assert.equal(res.status, 200, `${asset} status`);
    assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const csp = res.headers.get('content-security-policy') || '';
    assert.match(csp, /\bscript-src 'self'/);
    assert.match(csp, /\bstyle-src 'self'/);
    const body = await res.text();
    assert.ok(body.length > 0, `${asset} non-empty`);
  }

  for (const [name, html, entryScript] of [
    ['index.html', indexHtml, '/app.js'],
    ['checkout.html', checkoutHtml, '/checkout.js']
  ]) {
    const idxNorm = html.indexOf('<script defer src="/search-norm.js"></script>');
    const idxCombo = html.indexOf('<script defer src="/combobox.js"></script>');
    const idxPalette = html.indexOf('<script defer src="/command-palette.js"></script>');
    const idxEntry = html.indexOf(entryScript);
    assert.ok(idxNorm !== -1, `${name} loads /search-norm.js`);
    assert.ok(idxCombo !== -1, `${name} loads /combobox.js`);
    assert.ok(idxPalette !== -1, `${name} loads /command-palette.js`);
    assert.ok(idxEntry !== -1, `${name} loads ${entryScript}`);
    assert.ok(idxNorm < idxCombo && idxCombo < idxPalette && idxPalette < idxEntry, `${name} script defer order`);
    assert.match(html, /data-command-palette-trigger/, `${name} includes trigger button`);
    assert.doesNotMatch(html, /\sstyle=|\sonclick=/i, `${name} has zero inline style/onclick`);
  }

  // Zero forbidden owner strings in command-palette.js & checkout.html
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
    assert.equal(commandPaletteSource.includes(forbidden), false, `command-palette.js must not include ${forbidden}`);
    assert.equal(checkoutHtml.includes(forbidden), false, `checkout.html must not include ${forbidden}`);
  }

  // Zero unsafe DOM/script patterns in command-palette.js
  assert.doesNotMatch(commandPaletteSource, /innerHTML|outerHTML|insertAdjacentHTML/);
  assert.doesNotMatch(commandPaletteSource, /\beval\s*\(/);
  assert.doesNotMatch(commandPaletteSource, /\bstyle\s*=|\bonclick\s*=/i);
  assert.doesNotMatch(commandPaletteSource, /^\s*(?:import|export)\b/m);

  // CSS tokens & mobile topbar grid placement
  assert.match(stylesCss, /\.defter-command-palette\b/);
  assert.match(stylesCss, /\.button\.defter-command-palette-trigger\b/);
  assert.match(stylesCss, /\.topbar:has\(\[data-command-palette-trigger\]\)/);
  assert.match(stylesCss, /#command-palette-trigger\s*\{\s*grid-area:\s*palette;\s*\}/);
  assert.doesNotMatch(stylesCss, /var\(--accent\)/);
});

// 2. Ctrl+K & Cmd+K Global Toggle + Trigger Button
test('2. Ctrl+K / Cmd+K global shortcut, trigger click, repeat ignore, and rapid toggle', () => {
  const dom = createDom();
  const { window } = dom;
  const { document } = window;
  const palette = window.DefterCommandPalette;
  palette.registerProvider('nav', {
    group: 'navigation',
    groupLabel: 'Ekranlar',
    items: [{ id: 'overview', title: 'Günün Görünümü' }]
  });

  const trigger = document.querySelector('[data-command-palette-trigger]');
  trigger.focus();

  // Ctrl+K opens
  const evOpen = keyEvent(window, 'k', { ctrlKey: true });
  document.dispatchEvent(evOpen);
  assert.equal(evOpen.defaultPrevented, true);
  assert.equal(palette.isOpen(), true);
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(document.querySelectorAll('[data-command-palette]').length, 1);

  // e.repeat ignored while keeping preventDefault
  const evRepeat = keyEvent(window, 'k', { ctrlKey: true, repeat: true });
  document.dispatchEvent(evRepeat);
  assert.equal(evRepeat.defaultPrevented, true);
  assert.equal(palette.isOpen(), true);

  // Ctrl+K closes
  const evClose = keyEvent(window, 'k', { ctrlKey: true });
  document.dispatchEvent(evClose);
  assert.equal(evClose.defaultPrevented, true);
  assert.equal(palette.isOpen(), false);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(document.querySelectorAll('[data-command-palette]').length, 0);

  // Cmd+K (metaKey) with uppercase K toggles cleanly
  const evMeta = keyEvent(window, 'K', { metaKey: true });
  document.dispatchEvent(evMeta);
  assert.equal(evMeta.defaultPrevented, true);
  assert.equal(palette.isOpen(), true);
  document.dispatchEvent(keyEvent(window, 'k', { metaKey: true }));
  assert.equal(palette.isOpen(), false);

  // Alt+K / Ctrl+Shift+K ignored
  document.dispatchEvent(keyEvent(window, 'k', { ctrlKey: true, altKey: true }));
  assert.equal(palette.isOpen(), false);
  document.dispatchEvent(keyEvent(window, 'k', { ctrlKey: true, shiftKey: true }));
  assert.equal(palette.isOpen(), false);

  // Trigger click toggles
  trigger.dispatchEvent(clickEvent(window));
  assert.equal(palette.isOpen(), true);
  palette.close();

  // Rapid toggles leave zero duplicate dialogs
  for (let i = 0; i < 6; i++) {
    document.dispatchEvent(keyEvent(window, 'k', { ctrlKey: true }));
  }
  assert.equal(palette.isOpen(), false);
  assert.equal(document.querySelectorAll('[data-command-palette]').length, 0);
  palette.destroy();
  window.close();
});

// 3. ARIA Contract & Semantic Roles
test('3. ARIA contract & semantic roles match PROJECT.md Interface Contracts #4', () => {
  const dom = createDom();
  const { window } = dom;
  const { document } = window;
  const palette = window.DefterCommandPalette;
  palette.registerProvider('p1', {
    group: 'navigation',
    groupLabel: 'Ekranlar',
    items: [
      { id: 'v1', title: 'Müşteri Ekranı', subtitle: 'Cari kartlar', badge: 'Alt+1' },
      { id: 'v2', title: 'Devre Dışı', disabled: true, disabledReason: 'Pasif' }
    ]
  });

  palette.open();
  const dlg = document.querySelector('[data-command-palette]');
  const input = document.querySelector('[data-command-palette-input]');
  const list = document.querySelector('[data-command-palette-list]');
  const status = document.querySelector('[data-command-palette-status]');
  const empty = document.querySelector('[data-command-palette-empty]');
  const error = document.querySelector('[data-command-palette-error]');
  const group = list.querySelector('[role="group"]');
  const options = [...list.querySelectorAll('[role="option"]')];

  assert.equal(dlg.tagName, 'DIALOG');
  assert.equal(dlg.getAttribute('role'), 'dialog');
  assert.equal(dlg.getAttribute('aria-modal'), 'true');
  const labelledBy = dlg.getAttribute('aria-labelledby');
  assert.ok(labelledBy && document.getElementById(labelledBy));

  assert.equal(input.getAttribute('role'), 'combobox');
  assert.equal(input.getAttribute('aria-autocomplete'), 'list');
  assert.equal(input.getAttribute('aria-expanded'), 'true');
  assert.equal(input.getAttribute('aria-controls'), list.id);
  assert.equal(input.getAttribute('aria-activedescendant'), options[0].id);

  assert.equal(list.getAttribute('role'), 'listbox');
  assert.equal(group.getAttribute('aria-label'), 'Ekranlar');

  assert.equal(options.length, 2);
  assert.equal(options[0].tagName, 'BUTTON');
  assert.equal(options[0].type, 'button');
  assert.equal(options[0].getAttribute('data-command-id'), 'v1');
  assert.equal(options[0].getAttribute('data-command-group'), 'navigation');
  assert.equal(options[0].tabIndex, -1);
  assert.equal(options[0].getAttribute('aria-selected'), 'true');
  assert.equal(options[0].getAttribute('aria-disabled'), null);

  assert.equal(options[1].getAttribute('aria-selected'), 'false');
  assert.equal(options[1].getAttribute('aria-disabled'), 'true');

  assert.ok(status);
  assert.equal(empty.hidden, true);
  assert.equal(error.hidden, true);

  palette.destroy();
  window.close();
});

// 4. Focus Trap & Exact Focus Restoration
test('4. Tab/Shift+Tab focus trap and exact focus restoration across close paths', () => {
  const dom = createDom();
  const { window } = dom;
  const { document } = window;
  const palette = window.DefterCommandPalette;
  palette.registerProvider('nav', [{ id: 'a', title: 'Öğe A' }]);

  const otherBtn = document.getElementById('other-btn');
  otherBtn.focus();
  assert.equal(document.activeElement, otherBtn);

  // Open via Ctrl+K -> focus moves into input
  document.dispatchEvent(keyEvent(window, 'k', { ctrlKey: true }));
  const dlg = document.querySelector('[data-command-palette]');
  const input = document.querySelector('[data-command-palette-input]');
  const closeBtn = document.querySelector('[data-command-palette-close]');
  assert.equal(document.activeElement, input);

  // Shift+Tab from first focusable (input) wraps to last (closeBtn)
  const shiftTabEv = keyEvent(window, 'Tab', { shiftKey: true });
  dlg.dispatchEvent(shiftTabEv);
  assert.equal(shiftTabEv.defaultPrevented, true);
  assert.equal(document.activeElement, closeBtn);

  // Tab from last focusable (closeBtn) wraps to first (input)
  const tabEv = keyEvent(window, 'Tab', { shiftKey: false });
  dlg.dispatchEvent(tabEv);
  assert.equal(tabEv.defaultPrevented, true);
  assert.equal(document.activeElement, input);

  // Escape restores focus to otherBtn
  dlg.dispatchEvent(keyEvent(window, 'Escape'));
  assert.equal(palette.isOpen(), false);
  assert.equal(document.activeElement, otherBtn);

  // Close button restores focus
  palette.open({ trigger: otherBtn });
  document.querySelector('[data-command-palette-close]').click();
  assert.equal(palette.isOpen(), false);
  assert.equal(document.activeElement, otherBtn);

  // Backdrop click restores focus
  palette.open({ trigger: otherBtn });
  const dlg2 = document.querySelector('[data-command-palette]');
  dlg2.dispatchEvent(clickEvent(window));
  assert.equal(palette.isOpen(), false);
  assert.equal(document.activeElement, otherBtn);

  // Disconnected returnTarget degrades safely without throwing
  const tempBtn = document.createElement('button');
  document.body.append(tempBtn);
  tempBtn.focus();
  palette.open({ trigger: tempBtn });
  tempBtn.remove();
  assert.doesNotThrow(() => palette.close({ restoreFocus: true }));
  assert.equal(palette.isOpen(), false);

  palette.destroy();
  window.close();
});

// 5. Keyboard Navigation & Disabled Item Skipping
test('5. ArrowDown/ArrowUp/Home/End skip disabled options and disabled items cannot be executed', () => {
  const dom = createDom();
  const { window } = dom;
  const { document } = window;
  const palette = window.DefterCommandPalette;
  const executed = [];
  palette.registerProvider('cmds', [
    { id: 'd0', title: 'Başta Pasif', disabled: true, action: () => executed.push('d0') },
    { id: 'e1', title: 'İlk Etkin', action: () => executed.push('e1') },
    { id: 'd2', title: 'Ortada Pasif', disabled: true, action: () => executed.push('d2') },
    { id: 'e3', title: 'İkinci Etkin', action: () => executed.push('e3') },
    { id: 'd4', title: 'Sonda Pasif', disabled: true, action: () => executed.push('d4') }
  ]);

  palette.open();
  const dlg = document.querySelector('[data-command-palette]');
  const input = document.querySelector('[data-command-palette-input]');
  const options = [...document.querySelectorAll('[role="option"]')];

  // Initial active skips d0 -> e1
  assert.equal(input.getAttribute('aria-activedescendant'), options[1].id);
  assert.equal(options[1].getAttribute('aria-selected'), 'true');

  // ArrowDown skips d2 -> e3
  dlg.dispatchEvent(keyEvent(window, 'ArrowDown'));
  assert.equal(input.getAttribute('aria-activedescendant'), options[3].id);
  assert.equal(options[3].getAttribute('aria-selected'), 'true');
  assert.equal(options[1].getAttribute('aria-selected'), 'false');

  // ArrowDown at last enabled stays on e3 (does not move to d4)
  dlg.dispatchEvent(keyEvent(window, 'ArrowDown'));
  assert.equal(input.getAttribute('aria-activedescendant'), options[3].id);

  // ArrowUp skips d2 -> e1
  dlg.dispatchEvent(keyEvent(window, 'ArrowUp'));
  assert.equal(input.getAttribute('aria-activedescendant'), options[1].id);

  // End jumps to last enabled e3; Home jumps to first enabled e1
  dlg.dispatchEvent(keyEvent(window, 'End'));
  assert.equal(input.getAttribute('aria-activedescendant'), options[3].id);
  dlg.dispatchEvent(keyEvent(window, 'Home'));
  assert.equal(input.getAttribute('aria-activedescendant'), options[1].id);

  // Clicking disabled option does nothing and keeps palette open
  options[2].dispatchEvent(clickEvent(window));
  assert.equal(palette.isOpen(), true);
  assert.deepEqual(executed, []);

  // Enter on active enabled e1 executes e1
  dlg.dispatchEvent(keyEvent(window, 'Enter'));
  assert.equal(palette.isOpen(), false);
  assert.deepEqual(executed, ['e1']);

  palette.destroy();
  window.close();
});

// 6. Zero Form Auto-Submit on Enter
test('6. Enter in palette calls preventDefault + stopPropagation and never submits enclosing or background form', () => {
  const dom = createDom({
    html: '<!doctype html><html lang="tr"><body><main><form id="trade-form"><input id="form-input" type="text"><button id="submit-btn" type="submit">Kaydet</button></form></main></body></html>'
  });
  const { window } = dom;
  const { document } = window;
  const palette = window.DefterCommandPalette;
  let formSubmitCount = 0;
  let formKeydownCount = 0;
  let actionCount = 0;

  const form = document.getElementById('trade-form');
  form.addEventListener('submit', e => {
    e.preventDefault();
    formSubmitCount++;
  });
  form.addEventListener('keydown', () => {
    formKeydownCount++;
  });

  palette.registerProvider('nav', [
    { id: 'go', title: 'Müşteriler', action: () => { actionCount++; } }
  ]);

  const formInput = document.getElementById('form-input');
  formInput.focus();
  document.dispatchEvent(keyEvent(window, 'k', { ctrlKey: true }));
  assert.equal(palette.isOpen(), true);

  const dlg = document.querySelector('[data-command-palette]');
  const enterEv = keyEvent(window, 'Enter');
  dlg.dispatchEvent(enterEv);
  assert.equal(enterEv.defaultPrevented, true);
  assert.equal(actionCount, 1);
  assert.equal(formSubmitCount, 0);
  assert.equal(formKeydownCount, 0);

  palette.destroy();
  window.close();
});

// 7. Turkish Normalization & Multi-Token Search (with and without DefterSearchNorm)
test('7. Turkish character folding (İ/I/ı/ğ/ş/ç/ö/ü) & multi-token search with and without DefterSearchNorm', () => {
  for (const withSearchNorm of [true, false]) {
    const dom = createDom({ withSearchNorm });
    const { window } = dom;
    const { document } = window;
    const palette = window.DefterCommandPalette;
    palette.registerProvider('cards', {
      group: 'records',
      groupLabel: 'Kayıtlar',
      items: [
        { id: 'c1', title: 'İsmail Işık', subtitle: '0532 111 22 33', keywords: ['altın', 'müşteri'] },
        { id: 'c2', title: 'Şahin Çiğdem', subtitle: '0541 222 33 44', keywords: 'gümüş' },
        { id: 'c3', title: 'Gökhan Ümit', subtitle: 'Tedarikçi', keywords: 'toptan' }
      ]
    });
    palette.open();
    const input = document.querySelector('[data-command-palette-input]');

    const checkQuery = (q, expectedIds) => {
      input.value = q;
      input.dispatchEvent(inputEvent(window));
      const ids = [...document.querySelectorAll('[role="option"]')].map(el => el.getAttribute('data-command-id'));
      assert.deepEqual(ids, expectedIds, `withSearchNorm=${withSearchNorm} query=${q}`);
    };

    checkQuery('ismail', ['c1']);
    checkQuery('ISIK', ['c1']);
    checkQuery('sahin cigdem', ['c2']);
    checkQuery('gokhan umit', ['c3']);
    checkQuery('0532 ismail', ['c1']);
    checkQuery('gumus', ['c2']);

    palette.destroy();
    window.close();
  }
});

// 8. Grouped Results, Empty State & Provider/Item when() Filtering
test('8. Grouped results follow groupOrder, when() hides gated items, and empty state displays cleanly', () => {
  const dom = createDom();
  const { window } = dom;
  const { document } = window;
  const palette = window.DefterCommandPalette;
  palette.configure({ groupOrder: ['actions', 'navigation', 'commands'] });

  let showAdminCmd = false;
  palette.registerProvider('cmds', {
    group: 'commands',
    groupLabel: 'Komutlar',
    items: [
      { id: 'cmd-1', title: 'Kasa Sayımı' },
      { id: 'cmd-secret', title: 'Gizli Komut', when: () => showAdminCmd }
    ]
  });
  palette.registerProvider('acts', {
    group: 'actions',
    groupLabel: 'Hızlı İşlemler',
    items: [{ id: 'act-1', title: 'Yeni Satış' }]
  });
  palette.registerProvider('nav', {
    group: 'navigation',
    groupLabel: 'Ekranlar',
    items: [{ id: 'nav-1', title: 'Müşteriler' }]
  });

  palette.open();
  const groupLabels = [...document.querySelectorAll('[role="group"]')].map(g => g.getAttribute('aria-label'));
  assert.deepEqual(groupLabels, ['Hızlı İşlemler', 'Ekranlar', 'Komutlar']);
  assert.equal(document.querySelector('[data-command-id="cmd-secret"]'), null);

  // Flip when() -> refresh() reveals gated item
  showAdminCmd = true;
  palette.refresh();
  assert.ok(document.querySelector('[data-command-id="cmd-secret"]'));

  // Empty search result shows empty banner, hides groups, clears aria-activedescendant
  const input = document.querySelector('[data-command-palette-input]');
  input.value = 'zzzz-olmayan-kayit';
  input.dispatchEvent(inputEvent(window));
  assert.equal(document.querySelectorAll('[role="group"]').length, 0);
  assert.equal(document.querySelectorAll('[role="option"]').length, 0);
  assert.equal(document.querySelector('[data-command-palette-empty]').hidden, false);
  assert.equal(input.getAttribute('aria-activedescendant'), null);

  palette.destroy();
  window.close();
});

// 9. Sync & Static Provider Lifecycle
test('9. registerProvider replaces matching id, supports shorthand & disposer, unregisterProvider, and refresh', () => {
  const dom = createDom();
  const { window } = dom;
  const { document } = window;
  const palette = window.DefterCommandPalette;

  let dynamicLabel = 'İlk Başlık';
  palette.registerProvider('dyn', () => [{ id: 'd1', title: dynamicLabel }]);
  const disposeOld = palette.registerProvider('p1', [{ id: 'a', title: 'Eski A' }]);
  // Replace p1 with new registration; calling disposeOld must NOT remove the replacement
  palette.registerProvider('p1', { items: [{ id: 'b', title: 'Yeni B' }] });
  disposeOld();

  palette.open();
  assert.ok(document.querySelector('[data-command-id="b"]'));
  assert.equal(document.querySelector('[data-command-id="a"]'), null);
  assert.equal(document.querySelector('[data-command-id="d1"]').textContent.includes('İlk Başlık'), true);

  dynamicLabel = 'Güncel Başlık';
  palette.refresh();
  assert.equal(document.querySelector('[data-command-id="d1"]').textContent.includes('Güncel Başlık'), true);

  palette.unregisterProvider('dyn');
  assert.equal(document.querySelector('[data-command-id="d1"]'), null);

  palette.destroy();
  window.close();
});

// 10. Async Provider: Debounce, AbortController, Stale Guard & Error Banner
test('10. Async provider debounces, aborts superseded queries, ignores AbortError, and surfaces non-abort errors safely', async () => {
  const dom = createDom();
  const { window } = dom;
  const { document } = window;
  const palette = window.DefterCommandPalette;
  palette.configure({ debounceMs: 40 });

  palette.registerProvider('sync-nav', {
    group: 'navigation',
    groupLabel: 'Ekranlar',
    items: [{ id: 'sync-1', title: 'Günün Görünümü' }]
  });

  const calls = [];
  const signals = [];
  palette.registerProvider('remote', {
    group: 'records',
    groupLabel: 'Müşteriler',
    minQueryLength: 2,
    search: (q, { signal }) => {
      calls.push(q);
      signals.push(signal);
      if (q === 'err') {
        return Promise.reject(new Error('Müşteri servisi yanıt vermedi'));
      }
      if (q === 'abort-err') {
        const ae = new Error('Aborted');
        ae.name = 'AbortError';
        return Promise.reject(ae);
      }
      if (q === 'slow') {
        return new Promise(resolve => {
          setTimeout(() => resolve({ items: [{ id: 'stale-item', title: 'Bayat Sonuç' }], total: 1 }), 120);
        });
      }
      return Promise.resolve({
        items: [{ id: `res-${q}`, title: `Günün Sonucu ${q}` }],
        total: 1
      });
    }
  });

  palette.open();
  const input = document.querySelector('[data-command-palette-input]');

  // Rapid typing debounces intermediate queries
  input.value = 'sl';
  input.dispatchEvent(inputEvent(window));
  input.value = 'slo';
  input.dispatchEvent(inputEvent(window));
  input.value = 'slow';
  input.dispatchEvent(inputEvent(window));
  await tick(70);
  assert.deepEqual(calls, ['slow']);

  // Type new query while 'slow' is in flight -> aborts slow's signal & discards stale resolution
  input.value = 'gün';
  input.dispatchEvent(inputEvent(window));
  await tick(160);
  assert.equal(signals[0].aborted, true, 'prior AbortSignal must be aborted');
  assert.equal(document.querySelector('[data-command-id="stale-item"]'), null);
  assert.ok(document.querySelector('[data-command-id="res-gün"]'));

  // AbortError rejection is ignored silently
  input.value = 'abort-err';
  input.dispatchEvent(inputEvent(window));
  await tick(70);
  assert.equal(document.querySelector('[data-command-palette-error]').hidden, true);

  // Non-abort error shows error banner while keeping working sync group intact
  input.value = 'err';
  input.dispatchEvent(inputEvent(window));
  await tick(70);
  const errEl = document.querySelector('[data-command-palette-error]');
  assert.equal(errEl.hidden, false);
  assert.match(errEl.textContent, /Müşteri servisi yanıt vermedi/);
  // Verify working sync item remains visible when query matches sync item too
  palette.unregisterProvider('remote');
  palette.registerProvider('remote-fail-match', {
    group: 'records',
    groupLabel: 'Müşteriler',
    search: () => Promise.reject(new Error('Bağlantı hatası'))
  });
  input.value = 'Günün';
  input.dispatchEvent(inputEvent(window));
  await tick(70);
  assert.ok(document.querySelector('[data-command-id="sync-1"]'), 'working sync item survives async error');
  assert.equal(document.querySelector('[data-command-palette-error]').hidden, false);

  palette.destroy();
  window.close();
});

// 11. R4 Scale: 12,120 Items (< 35ms search, <= 25 DOM nodes, tail needle)
test('11. R4 Scale: 10,000+ items open & search < 35ms median, <= 25 DOM nodes, and tail needle found', () => {
  const dom = createDom();
  const { window } = dom;
  const { document } = window;
  const palette = window.DefterCommandPalette;

  const bigCustomers = [];
  for (let i = 0; i < 9999; i++) {
    bigCustomers.push({
      id: `cust-${i}`,
      title: `Sentetik Müşteri ${i}`,
      subtitle: `TL · 0530${String(i).padStart(7, '0')}`
    });
  }
  bigCustomers.push({
    id: 'cust-tail-needle',
    title: 'İsmail Işık Hedef',
    subtitle: 'HAS · 05419998877'
  });

  const bigStocks = [];
  for (let i = 0; i < 2000; i++) {
    bigStocks.push({ id: `stk-${i}`, title: `Stok Kartı ${i}`, subtitle: 'GRAM' });
  }
  const bigSuppliers = [];
  for (let i = 0; i < 120; i++) {
    bigSuppliers.push({ id: `sup-${i}`, title: `Toptancı Firma ${i}`, subtitle: 'HAS' });
  }

  palette.registerProvider('customers', { group: 'records', groupLabel: 'Müşteriler', priority: 10, items: bigCustomers });
  palette.registerProvider('stocks', { group: 'stocks', groupLabel: 'Stoklar', priority: 20, items: bigStocks });
  palette.registerProvider('suppliers', { group: 'other', groupLabel: 'Firmalar', priority: 30, items: bigSuppliers });

  const tOpen = performance.now();
  palette.open();
  const openMs = performance.now() - tOpen;

  const openOptions = document.querySelectorAll('[role="option"]');
  assert.ok(openOptions.length >= 1 && openOptions.length <= 25, `Rendered options=${openOptions.length}`);
  assert.match(document.querySelector('[data-command-palette-status]').textContent, /12\.120/);
  assert.ok(openMs < 100, `open() on 12,120 items took ${openMs.toFixed(2)}ms`);

  const input = document.querySelector('[data-command-palette-input]');
  const searchDurations = [];
  for (const q of ['sentetik', 'ismail isik hedef', 'stok', 'hedef']) {
    const t0 = performance.now();
    input.value = q;
    input.dispatchEvent(inputEvent(window));
    searchDurations.push(performance.now() - t0);
  }
  searchDurations.sort((a, b) => a - b);
  const medianMs = searchDurations[Math.floor(searchDurations.length / 2)];
  assert.ok(medianMs < 35, `Median search over 12,120 items was ${medianMs.toFixed(2)}ms (target < 35ms)`);

  // Tail needle at index 9999+ is always found
  assert.ok(document.querySelector('[data-command-id="cust-tail-needle"]'));
  assert.ok(document.querySelectorAll('[role="option"]').length <= 25);

  // Broad query matching 10,000 rows still caps DOM options <= 25
  input.value = 'sentetik';
  input.dispatchEvent(inputEvent(window));
  assert.ok(document.querySelectorAll('[role="option"]').length <= 25);

  palette.destroy();
  window.close();
});

// 12. Blocking Guards
test('12. Blocking guards prevent opening during busy/pending/lock/critical-modal while allowing close if already open', () => {
  const dom = createDom({
    html: '<!doctype html><html lang="tr"><body><main><div id="lock-screen" hidden></div><div id="retry-bar" hidden></div><div id="pending-panel" hidden></div><button id="trg" data-command-palette-trigger type="button">Aç</button></main></body></html>'
  });
  const { window } = dom;
  const { document } = window;
  const palette = window.DefterCommandPalette;
  const blockedEvents = [];
  let customBlocked = false;

  palette.configure({
    isBlocked: () => customBlocked ? { blocked: true, reason: 'Özel engel' } : false,
    onBlocked: (reason, ctx) => blockedEvents.push({ reason, source: ctx.source })
  });
  palette.registerProvider('nav', [{ id: 'a', title: 'Öğe A' }]);

  const assertBlocked = (setup, teardown, label) => {
    setup();
    assert.equal(palette.isBlocked(), true, `${label}: isBlocked()`);
    const ev = keyEvent(window, 'k', { ctrlKey: true });
    document.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true, `${label}: preventDefault on Ctrl+K`);
    assert.equal(palette.isOpen(), false, `${label}: palette stays closed`);
    teardown();
    assert.equal(palette.isBlocked(), false, `${label}: unblocked after teardown`);
  };

  assertBlocked(() => document.body.setAttribute('aria-busy', 'true'), () => document.body.removeAttribute('aria-busy'), 'body[aria-busy]');
  assertBlocked(() => document.documentElement.setAttribute('aria-busy', 'true'), () => document.documentElement.removeAttribute('aria-busy'), 'html[aria-busy]');
  assertBlocked(() => { document.body.hidden = true; }, () => { document.body.hidden = false; }, 'body.hidden');
  assertBlocked(() => document.body.setAttribute('data-busy', 'true'), () => document.body.removeAttribute('data-busy'), '[data-busy]');
  assertBlocked(() => { document.getElementById('lock-screen').hidden = false; }, () => { document.getElementById('lock-screen').hidden = true; }, '#lock-screen');
  assertBlocked(() => { document.getElementById('retry-bar').hidden = false; }, () => { document.getElementById('retry-bar').hidden = true; }, '#retry-bar');
  assertBlocked(() => { document.getElementById('pending-panel').hidden = false; }, () => { document.getElementById('pending-panel').hidden = true; }, '#pending-panel');
  assertBlocked(() => document.body.setAttribute('data-pending-blocking', 'true'), () => document.body.removeAttribute('data-pending-blocking'), '[data-pending-blocking]');
  assertBlocked(() => document.body.setAttribute('data-command-palette-blocked', 'true'), () => document.body.removeAttribute('data-command-palette-blocked'), '[data-command-palette-blocked]');
  assertBlocked(() => { customBlocked = true; }, () => { customBlocked = false; }, 'custom isBlocked');

  // Critical modal (.defter-confirm-form inside open dialog) blocks opening
  const critDlg = document.createElement('dialog');
  critDlg.className = 'defter-dialog defter-modal';
  critDlg.setAttribute('open', '');
  const form = document.createElement('form');
  form.className = 'defter-confirm-form';
  critDlg.append(form);
  document.body.append(critDlg);
  assert.equal(palette.isBlocked(), true);
  document.getElementById('trg').dispatchEvent(clickEvent(window));
  assert.equal(palette.isOpen(), false);
  critDlg.remove();

  // If already open and isBlocked becomes true mid-session, Ctrl+K STILL closes cleanly
  assert.equal(palette.open(), true);
  assert.equal(palette.isOpen(), true);
  document.body.setAttribute('aria-busy', 'true');
  document.dispatchEvent(keyEvent(window, 'k', { ctrlKey: true }));
  assert.equal(palette.isOpen(), false);
  assert.ok(blockedEvents.length >= 5);

  palette.destroy();
  window.close();
});

// 13. Top-Layer Stacking Over DefterUI Drawer & popstate Unwind
test('13. Top-layer stacking over DefterUI Drawer: Escape, Ctrl+K, aria-hidden, focus restore & popstate unwind', () => {
  const dom = createDom();
  const { window } = dom;
  const { document } = window;
  const ui = window.DefterUI;
  const palette = window.DefterCommandPalette;

  palette.registerProvider('nav', [{ id: 'a', title: 'Öğe A' }]);

  const drawerInput = document.createElement('input');
  drawerInput.id = 'drawer-inner-input';
  const drawer = ui.openDrawer({
    title: 'Yeni Müşteri',
    content: drawerInput
  });
  assert.equal(ui.getLayerCount(), 1);
  assert.equal(document.querySelector('.shell').getAttribute('aria-hidden'), 'true');
  drawerInput.focus();
  assert.equal(document.activeElement, drawerInput);

  // Open palette over drawer
  document.dispatchEvent(keyEvent(window, 'k', { ctrlKey: true }));
  assert.equal(palette.isOpen(), true);
  assert.equal(ui.getLayerCount(), 2);
  assert.equal(drawer.dialog.getAttribute('aria-hidden'), 'true');
  assert.equal(document.querySelector('.shell').getAttribute('aria-hidden'), 'true');

  // Escape closes ONLY palette; drawer remains open with aria-hidden cleared and focus restored
  const palDlg = document.querySelector('[data-command-palette]');
  palDlg.dispatchEvent(keyEvent(window, 'Escape'));
  assert.equal(palette.isOpen(), false);
  assert.equal(ui.getLayerCount(), 1);
  assert.equal(drawer.dialog.isConnected, true);
  assert.equal(drawer.dialog.getAttribute('aria-hidden'), null);
  assert.equal(document.querySelector('.shell').getAttribute('aria-hidden'), 'true');
  assert.equal(document.activeElement, drawerInput);

  // Re-open palette over drawer, then simulate popstate -> closes ONLY palette without closing drawer
  document.dispatchEvent(keyEvent(window, 'k', { ctrlKey: true }));
  assert.equal(palette.isOpen(), true);
  let bubblePopstateCalls = 0;
  window.addEventListener('popstate', () => { bubblePopstateCalls++; });
  window.dispatchEvent(new window.PopStateEvent('popstate'));
  assert.equal(palette.isOpen(), false);
  assert.equal(ui.getLayerCount(), 1, 'underlying drawer must stay open on first popstate');
  assert.equal(bubblePopstateCalls, 0, 'bubble-phase app popstate must be stopped when drawer remains open');
  assert.equal(drawer.dialog.getAttribute('aria-hidden'), null);
  assert.equal(document.activeElement, drawerInput);

  // Escape closes drawer now
  drawer.dialog.dispatchEvent(keyEvent(window, 'Escape'));
  assert.equal(ui.getLayerCount(), 0);
  assert.equal(document.querySelector('.shell').getAttribute('aria-hidden'), null);

  // Palette open ALONE + popstate: closes palette WITHOUT stopImmediatePropagation so app.js navigation proceeds
  palette.open();
  assert.equal(palette.isOpen(), true);
  window.dispatchEvent(new window.PopStateEvent('popstate'));
  assert.equal(palette.isOpen(), false);
  assert.equal(bubblePopstateCalls, 1, 'app bubble-phase popstate must fire when palette was sole layer');
  assert.equal(document.querySelector('.shell').getAttribute('aria-hidden'), null);

  palette.destroy();
  window.close();
});

// 13b. Standalone Fallback Without DefterUI
test('13b. Standalone aria-hidden and popstate fallback when DefterUI is absent', () => {
  const dom = createDom({ withUiKit: false });
  const { window } = dom;
  const { document } = window;
  const palette = window.DefterCommandPalette;
  palette.registerProvider('nav', [{ id: 'a', title: 'Öğe A' }]);

  palette.open();
  assert.equal(document.querySelector('.shell').getAttribute('aria-hidden'), 'true');
  let appPop = 0;
  window.addEventListener('popstate', () => { appPop++; });
  window.dispatchEvent(new window.PopStateEvent('popstate'));
  assert.equal(palette.isOpen(), false);
  assert.equal(document.querySelector('.shell').getAttribute('aria-hidden'), null);
  assert.equal(appPop, 1);

  palette.destroy();
  window.close();
});

// 14. Shimmed showModal / close & native cancel Event
test('14. Uses HTMLDialogElement showModal() / close() and handles native cancel event cleanly', () => {
  const dom = createDom();
  const { window } = dom;
  const { document } = window;
  let showModalCalls = 0;
  let closeCalls = 0;

  window.HTMLDialogElement.prototype.showModal = function showModal() {
    showModalCalls++;
    this.setAttribute('open', '');
  };
  window.HTMLDialogElement.prototype.close = function close() {
    closeCalls++;
    this.removeAttribute('open');
  };

  const palette = window.DefterCommandPalette;
  palette.registerProvider('nav', [{ id: 'a', title: 'Öğe' }]);
  const trigger = document.querySelector('[data-command-palette-trigger]');
  trigger.focus();

  palette.open({ trigger });
  assert.equal(showModalCalls, 1);
  const dlg = document.querySelector('[data-command-palette]');
  const cancelEv = new window.Event('cancel', { cancelable: true });
  dlg.dispatchEvent(cancelEv);
  assert.equal(cancelEv.defaultPrevented, true);
  assert.equal(closeCalls, 1);
  assert.equal(palette.isOpen(), false);
  assert.equal(document.activeElement, trigger);

  palette.destroy();
  window.close();
});

// 15. XSS Payload Injection Safety
test('15. XSS payloads in command fields, error messages, and queries render strictly as textContent', async () => {
  const dom = createDom();
  const { window } = dom;
  const { document } = window;
  const palette = window.DefterCommandPalette;
  palette.configure({ debounceMs: 0 });

  const xssTitle = '<img src=x onerror="window.__xss=1">';
  const xssSub = '"><svg onload="window.__xss=2">';
  const xssGroup = '<script>window.__xss=3</script>';
  const xssErr = '<img src=y onerror="window.__xss=4">';

  palette.registerProvider('xss', {
    group: 'xss',
    groupLabel: xssGroup,
    items: [
      { id: 'x1', title: xssTitle, subtitle: xssSub, badge: '<b>TL</b>', disabled: true, disabledReason: '<i>Pasif</i>' }
    ],
    search: () => Promise.reject(new Error(xssErr))
  });

  palette.open({ initialQuery: '<img' });
  await tick(20);

  const dlg = document.querySelector('[data-command-palette]');
  assert.equal(window.__xss, undefined);
  assert.equal(dlg.querySelectorAll('img, script, svg, b, i').length, 0);
  assert.ok(dlg.textContent.includes(xssTitle));
  assert.ok(dlg.textContent.includes(xssSub));
  assert.ok(dlg.textContent.includes(xssErr));

  palette.destroy();
  window.close();
});

// 16. Action Execution Focus Semantics (restoreFocus: false vs true)
test('16. Action execution closes palette before action on navigation (restoreFocus: false) and supports restoreFocus: true', () => {
  const dom = createDom();
  const { window } = dom;
  const { document } = window;
  const palette = window.DefterCommandPalette;
  const trigger = document.querySelector('[data-command-palette-trigger]');
  const mainEl = document.getElementById('main');
  let ariaHiddenDuringAction = null;

  palette.registerProvider('nav', [
    {
      id: 'go-main',
      title: 'Görünüme Geç',
      action: () => {
        ariaHiddenDuringAction = mainEl.getAttribute('aria-hidden');
        mainEl.focus();
      }
    },
    {
      id: 'stay-here',
      title: 'Yerinde İşlem',
      restoreFocus: true,
      action: () => {}
    }
  ]);

  trigger.focus();
  palette.open({ trigger });
  document.querySelector('[data-command-id="go-main"]').click();
  assert.equal(ariaHiddenDuringAction, null, 'palette must close and remove aria-hidden before navigation action focuses #main');
  assert.equal(document.activeElement, mainEl);

  trigger.focus();
  palette.open({ trigger });
  document.querySelector('[data-command-id="stay-here"]').click();
  assert.equal(document.activeElement, trigger);

  palette.destroy();
  window.close();
});

// 17. Role-Filtered Provider Isolation
test('17. Role-filtered provider isolation leaves zero owner-only commands on employee screen', () => {
  const dom = createDom({ html: checkoutHtml, url: 'http://127.0.0.1:4317/checkout' });
  const { window } = dom;
  const { document } = window;
  const palette = window.DefterCommandPalette;

  const role = 'employee';
  const allCommands = [
    { id: 'emp-sale', title: 'Müşteriye Satış', roles: ['employee', 'owner'] },
    { id: 'emp-purchase', title: 'Müşteriden Alış', roles: ['employee', 'owner'] },
    { id: 'owner-closing', title: 'Sayım ve Kapanış', roles: ['owner'] },
    { id: 'owner-backup', title: 'Yedek ve Çalışma Alanı', roles: ['owner'] }
  ];

  palette.registerProvider('role-cmds', {
    group: 'actions',
    groupLabel: 'İşlemler',
    getItems: () => allCommands.filter(c => c.roles.includes(role))
  });

  palette.open();
  const text = document.querySelector('[data-command-palette]').textContent;
  assert.match(text, /Müşteriye Satış/);
  assert.doesNotMatch(text, /Sayım ve Kapanış|Yedek ve Çalışma Alanı/);

  const input = document.querySelector('[data-command-palette-input]');
  input.value = 'kapanış';
  input.dispatchEvent(inputEvent(window));
  assert.equal(document.querySelectorAll('[role="option"]').length, 0);

  palette.destroy();
  window.close();
});

// 18. destroy() Lifecycle & Leak-Free Cleanup
test('18. destroy() removes listeners, aborts in-flight async search, removes dialog, and ignores subsequent Ctrl+K', async () => {
  const dom = createDom();
  const { window } = dom;
  const { document } = window;
  const palette = window.DefterCommandPalette;
  palette.configure({ debounceMs: 0 });

  let capturedSignal = null;
  palette.registerProvider('async', {
    search: (q, { signal }) => {
      capturedSignal = signal;
      return new Promise(() => {});
    }
  });

  palette.open({ initialQuery: 'test' });
  assert.ok(capturedSignal);
  assert.equal(capturedSignal.aborted, false);
  assert.equal(palette.isOpen(), true);

  palette.destroy();
  assert.equal(capturedSignal.aborted, true);
  assert.equal(palette.isOpen(), false);
  assert.equal(document.querySelectorAll('[data-command-palette]').length, 0);

  // Subsequent Ctrl+K or trigger click must do nothing and not throw
  assert.doesNotThrow(() => {
    document.dispatchEvent(keyEvent(window, 'k', { ctrlKey: true }));
    document.querySelector('[data-command-palette-trigger]').dispatchEvent(clickEvent(window));
  });
  assert.equal(palette.isOpen(), false);
  await tick(10);
  window.close();
});

// 19. Drawer with .defter-confirm-form Does NOT Block Ctrl+K; confirmCritical Modal DOES Block
test('19. dialog.defter-drawer[open] .defter-confirm-form does NOT block Ctrl+K, whereas DefterUI.confirmCritical and modal confirm forms DO block', async () => {
  const dom = createDom();
  const { window } = dom;
  const { document } = window;
  const ui = window.DefterUI;
  const palette = window.DefterCommandPalette;
  palette.registerProvider('nav', [{ id: 'a', title: 'Öğe A' }]);

  const drawerForm = document.createElement('form');
  drawerForm.className = 'defter-confirm-form';
  const drawerInput = document.createElement('input');
  drawerForm.append(drawerInput);
  const drawer = ui.openDrawer({ title: 'Hızlı Kart', content: drawerForm });
  assert.ok(drawer.dialog.classList.contains('defter-drawer'));
  assert.equal(palette.isBlocked(), false);

  drawerInput.focus();
  document.dispatchEvent(keyEvent(window, 'k', { ctrlKey: true }));
  assert.equal(palette.isOpen(), true);
  assert.equal(ui.getLayerCount(), 2);

  // Escape closes only palette and returns focus to drawerInput
  document.querySelector('[data-command-palette]').dispatchEvent(keyEvent(window, 'Escape'));
  assert.equal(palette.isOpen(), false);
  assert.equal(document.activeElement, drawerInput);
  drawer.close('done');
  assert.equal(ui.getLayerCount(), 0);

  // DefterUI.confirmCritical sets data-critical-modal="true" and blocks Ctrl+K
  const confirmPromise = ui.confirmCritical({ title: 'Onay', impactText: 'Emin misiniz?' });
  const critDialog = document.querySelector('dialog.defter-modal[open]');
  assert.ok(critDialog);
  assert.equal(critDialog.getAttribute('data-critical-modal'), 'true');
  assert.equal(palette.isBlocked(), true);
  document.dispatchEvent(keyEvent(window, 'k', { ctrlKey: true }));
  assert.equal(palette.isOpen(), false);
  critDialog.dispatchEvent(keyEvent(window, 'Escape'));
  await confirmPromise;
  assert.equal(palette.isBlocked(), false);

  // Standalone [data-critical-modal="true"] on any open dialog also blocks
  const customCrit = document.createElement('dialog');
  customCrit.setAttribute('open', '');
  customCrit.setAttribute('data-critical-modal', 'true');
  document.body.append(customCrit);
  assert.equal(palette.isBlocked(), true);
  assert.equal(palette.open(), false);
  customCrit.remove();

  palette.destroy();
  window.close();
});

// 20. config.isBlocked() Throwing Fails CLOSED
test('20. config.isBlocked() throwing fails CLOSED on isBlocked(), open(), and Enter execution', () => {
  const dom = createDom();
  const { window } = dom;
  const { document } = window;
  const palette = window.DefterCommandPalette;
  let executed = 0;
  let shouldThrow = true;

  palette.configure({
    isBlocked: () => {
      if (shouldThrow) throw new Error('Guard check error');
      return false;
    }
  });
  palette.registerProvider('nav', [{ id: 'a', title: 'Öğe A', action: () => { executed++; } }]);

  assert.equal(palette.isBlocked(), true);
  assert.equal(palette.open(), false);
  assert.equal(palette.isOpen(), false);

  // Mid-session throw during Enter execution also fails closed
  shouldThrow = false;
  assert.equal(palette.open(), true);
  shouldThrow = true;
  const dlg = document.querySelector('[data-command-palette]');
  dlg.dispatchEvent(keyEvent(window, 'Enter'));
  assert.equal(executed, 0);
  assert.equal(palette.isOpen(), true);
  assert.equal(document.querySelector('[data-command-palette-error]').hidden, false);

  palette.destroy();
  window.close();
});

// 21. In-Place Array & Item Mutation Reflects After refresh(), Re-open(), and Keystroke Filtering
test('21. In-place array (.push/.splice) and item (.disabled/.title) mutations reflect on refresh(), re-open(), and between keystrokes', () => {
  const dom = createDom();
  const { window } = dom;
  const { document } = window;
  const palette = window.DefterCommandPalette;
  const executed = [];
  const mutableList = [
    { id: 'm1', title: 'İlk Öğe', action: () => executed.push('m1') },
    { id: 'm2', title: 'Silinecek Öğe', action: () => executed.push('m2') }
  ];

  palette.registerProvider('dyn', {
    getItems: () => mutableList
  });

  palette.open();
  assert.ok(document.querySelector('[data-command-id="m1"]'));
  assert.ok(document.querySelector('[data-command-id="m2"]'));

  // Mutate array and item in place, then refresh()
  mutableList.splice(1, 1);
  mutableList.push({ id: 'm3', title: 'Eklenen Öğe', action: () => executed.push('m3') });
  mutableList[0].disabled = true;
  mutableList[0].title = 'Güncel Pasif Öğe';
  palette.refresh();

  assert.equal(document.querySelector('[data-command-id="m2"]'), null);
  const m1Btn = document.querySelector('[data-command-id="m1"]');
  const m3Btn = document.querySelector('[data-command-id="m3"]');
  assert.ok(m1Btn);
  assert.ok(m3Btn);
  assert.equal(m1Btn.getAttribute('aria-disabled'), 'true');
  assert.match(m1Btn.textContent, /Güncel Pasif Öğe/);
  m1Btn.click();
  assert.deepEqual(executed, []);

  // Mutate again while closed and verify re-open() picks up both item field and array changes
  palette.close();
  mutableList.push({ id: 'm4', title: 'Yeniden Açılış Öğesi', action: () => executed.push('m4') });
  mutableList[0].disabled = false;
  mutableList[0].title = 'Tekrar Etkin Öğe';
  palette.open();

  const m1Reopen = document.querySelector('[data-command-id="m1"]');
  assert.equal(m1Reopen.getAttribute('aria-disabled'), null);
  assert.match(m1Reopen.textContent, /Tekrar Etkin Öğe/);
  assert.ok(document.querySelector('[data-command-id="m4"]'));

  // Length mutation between keystrokes while open is detected without refresh()
  mutableList.push({ id: 'm5', title: 'Anlık Eklenen', action: () => executed.push('m5') });
  const input = document.querySelector('[data-command-palette-input]');
  input.value = 'Anlık';
  input.dispatchEvent(inputEvent(window));
  assert.ok(document.querySelector('[data-command-id="m5"]'));

  palette.destroy();
  window.close();
});

// 22. Tab to Close/Clear Button + Enter Does Not Execute Active Command
test('22. Tab to [data-command-palette-close] or [data-command-palette-clear] + Enter does not intercept Enter or execute active command', () => {
  const dom = createDom();
  const { window } = dom;
  const { document } = window;
  const palette = window.DefterCommandPalette;
  let executed = 0;

  palette.registerProvider('nav', [{ id: 'go', title: 'Aktif Komut', action: () => { executed++; } }]);
  const trigger = document.querySelector('[data-command-palette-trigger]');
  trigger.focus();

  document.dispatchEvent(keyEvent(window, 'k', { ctrlKey: true }));
  const dlg = document.querySelector('[data-command-palette]');
  const input = document.querySelector('[data-command-palette-input]');
  const closeBtn = document.querySelector('[data-command-palette-close]');
  const clearBtn = document.querySelector('[data-command-palette-clear]');

  // Focus clearBtn (when visible) and press Enter -> not intercepted
  input.value = 'Aktif';
  input.dispatchEvent(inputEvent(window));
  assert.equal(clearBtn.hidden, false);
  clearBtn.focus();
  const clearEnterEv = keyEvent(window, 'Enter');
  clearBtn.dispatchEvent(clearEnterEv);
  assert.equal(clearEnterEv.defaultPrevented, false);
  assert.equal(executed, 0);
  clearBtn.click();
  assert.equal(input.value, '');

  // Shift+Tab from input wraps to closeBtn; Enter on closeBtn is not intercepted and executes 0 commands
  input.focus();
  dlg.dispatchEvent(keyEvent(window, 'Tab', { shiftKey: true }));
  assert.equal(document.activeElement, closeBtn);
  const closeEnterEv = keyEvent(window, 'Enter');
  closeBtn.dispatchEvent(closeEnterEv);
  assert.equal(closeEnterEv.defaultPrevented, false);
  assert.equal(executed, 0);
  // Native button activation triggers click when Enter is not prevented
  if (!closeEnterEv.defaultPrevented) closeBtn.click();
  assert.equal(palette.isOpen(), false);
  assert.equal(executed, 0);
  assert.equal(document.activeElement, trigger);

  palette.destroy();
  window.close();
});

// 23. Sync search() Throw Aborts Earlier Async Providers & Preserves Sync Items
test('23. Sync throw in second search() provider aborts earlier async AbortSignal, preserves sync items, and shows error banner', async () => {
  const dom = createDom();
  const { window } = dom;
  const { document } = window;
  const palette = window.DefterCommandPalette;
  palette.configure({ debounceMs: 0 });

  let firstSignal = null;
  palette.registerProvider('p0-sync', {
    group: 'navigation',
    groupLabel: 'Ekranlar',
    priority: 1,
    search: () => [{ id: 'sync-kept', title: 'Korunan Senkron Öğe' }]
  });
  palette.registerProvider('p1-async', {
    group: 'records',
    groupLabel: 'Müşteriler',
    priority: 2,
    search: (q, { signal }) => {
      firstSignal = signal;
      return new Promise(() => {});
    }
  });
  palette.registerProvider('p2-throw', {
    group: 'other',
    groupLabel: 'Diğer',
    priority: 3,
    search: () => {
      throw new Error('Senkron sağlayıcı hatası');
    }
  });

  palette.open({ initialQuery: 'test' });
  await tick(10);

  assert.ok(firstSignal);
  assert.equal(firstSignal.aborted, true);
  assert.ok(document.querySelector('[data-command-id="sync-kept"]'));
  const errEl = document.querySelector('[data-command-palette-error]');
  assert.equal(errEl.hidden, false);
  assert.match(errEl.textContent, /Senkron sağlayıcı hatası/);

  palette.destroy();
  window.close();
});

// 24. Recovery After External <dialog>.remove() Detachment
test('24. open() and toggle() recover cleanly if <dialog data-command-palette> is externally detached', () => {
  const dom = createDom();
  const { window } = dom;
  const { document } = window;
  const palette = window.DefterCommandPalette;
  palette.registerProvider('nav', [{ id: 'a', title: 'Öğe A' }]);

  assert.equal(palette.open(), true);
  assert.equal(palette.isOpen(), true);
  document.querySelector('[data-command-palette]').remove();
  assert.equal(palette.isOpen(), false);

  assert.equal(palette.open(), true);
  assert.equal(palette.isOpen(), true);
  assert.equal(document.querySelectorAll('[data-command-palette]').length, 1);

  document.querySelector('[data-command-palette]').remove();
  assert.equal(palette.isOpen(), false);
  assert.equal(palette.toggle(), true);
  assert.equal(palette.isOpen(), true);
  assert.equal(document.querySelectorAll('[data-command-palette]').length, 1);

  palette.destroy();
  window.close();
});

// 25. Out-of-Order Underlying Drawer close() Does Not Steal Focus From Open Palette
test('25. Out-of-order DefterUI drawer.close() while Command Palette is open keeps focus inside [data-command-palette]', () => {
  const dom = createDom();
  const { window } = dom;
  const { document } = window;
  const ui = window.DefterUI;
  const palette = window.DefterCommandPalette;
  palette.registerProvider('nav', [{ id: 'a', title: 'Öğe A' }]);

  const trigger = document.getElementById('trigger-btn');
  trigger.focus();
  const drawer = ui.openDrawer({ title: 'Alt Çekmece', content: document.createElement('input'), trigger });
  assert.equal(ui.getLayerCount(), 1);

  assert.equal(palette.open(), true);
  assert.equal(ui.getLayerCount(), 2);
  const palDlg = document.querySelector('[data-command-palette]');
  assert.ok(palDlg.contains(document.activeElement));

  drawer.close('programmatic');
  assert.equal(ui.getLayerCount(), 1);
  assert.equal(palette.isOpen(), true);
  assert.ok(palDlg.contains(document.activeElement), 'focus must remain inside open command palette');
  assert.equal(document.querySelector('.shell').getAttribute('aria-hidden'), 'true');

  palette.close({ restoreFocus: false });
  assert.equal(ui.getLayerCount(), 0);
  assert.equal(document.querySelector('.shell').getAttribute('aria-hidden'), null);

  palette.destroy();
  window.close();
});

// 26. Same-Length In-Place getItems Mutation During onInput Without refresh()
test('26. Same-length in-place getItems mutation (disabled, disabledReason, title, keywords.push, splice) reflects on input without refresh()', () => {
  const dom = createDom();
  const { window } = dom;
  const { document } = window;
  const palette = window.DefterCommandPalette;
  const executed = [];
  const arr = [
    { id: 'm1', title: 'İlk Öğe', keywords: ['alfa'], action: () => executed.push('m1') },
    { id: 'm2', title: 'İkinci Öğe', action: () => executed.push('m2') }
  ];

  palette.registerProvider('dyn', {
    getItems: () => arr
  });

  palette.open();
  assert.ok(document.querySelector('[data-command-id="m1"]'));

  // Same-length in-place mutation while open (no refresh())
  arr[0].disabled = true;
  arr[0].disabledReason = 'Yasak';
  arr[0].title = 'Kısıtlanmış Öğe';
  arr[0].keywords.push('beta');
  assert.equal(arr.length, 2);

  const input = document.querySelector('[data-command-palette-input]');

  input.value = 'İlk';
  input.dispatchEvent(inputEvent(window));
  assert.equal(document.querySelector('[data-command-id="m1"]'), null);

  input.value = 'Kısıtlanmış';
  input.dispatchEvent(inputEvent(window));
  const m1Btn = document.querySelector('[data-command-id="m1"]');
  assert.ok(m1Btn);
  assert.equal(m1Btn.getAttribute('aria-disabled'), 'true');
  assert.match(m1Btn.textContent, /Yasak/);
  m1Btn.click();
  assert.deepEqual(executed, []);

  input.value = 'beta';
  input.dispatchEvent(inputEvent(window));
  assert.ok(document.querySelector('[data-command-id="m1"]'));

  // Same-length element replacement via splice(1, 1, replacement)
  arr.splice(1, 1, { id: 'm99', title: 'Değişmiş Hedef', action: () => executed.push('m99') });
  assert.equal(arr.length, 2);
  input.value = 'Değişmiş';
  input.dispatchEvent(inputEvent(window));
  const m99Btn = document.querySelector('[data-command-id="m99"]');
  assert.ok(m99Btn);
  m99Btn.click();
  assert.deepEqual(executed, ['m99']);

  palette.destroy();
  window.close();
});

// 27. Same-Length Static items Mutation Across close()+open() and During onInput
test('27. Same-length static items mutation reflects across close()+open() and during onInput', () => {
  const dom = createDom();
  const { window } = dom;
  const { document } = window;
  const palette = window.DefterCommandPalette;
  const executed = [];
  const staticArr = [
    { id: 's1', title: 'Sabit İlk', action: () => executed.push('s1') },
    { id: 's2', title: 'Sabit İkinci', action: () => executed.push('s2') }
  ];

  palette.registerProvider('stat', {
    items: staticArr
  });

  palette.open();
  palette.close();

  staticArr[0].disabled = true;
  staticArr[0].title = 'Devre Dışı Sabit';
  assert.equal(staticArr.length, 2);

  palette.open();
  const s1Btn = document.querySelector('[data-command-id="s1"]');
  assert.ok(s1Btn);
  assert.match(s1Btn.textContent, /Devre Dışı Sabit/);
  assert.equal(s1Btn.getAttribute('aria-disabled'), 'true');
  s1Btn.click();
  assert.deepEqual(executed, []);

  staticArr[1].title = 'Anlık Sabit Güncel';
  const input = document.querySelector('[data-command-palette-input]');
  input.value = 'Anlık Sabit';
  input.dispatchEvent(inputEvent(window));
  assert.ok(document.querySelector('[data-command-id="s2"]'));

  palette.destroy();
  window.close();
});

// 28. R4 Scale for getItems (12,120 items) + Sync AbortError Loading Reset
test('28. 12,120-item getItems warm open/search < 35ms median and sync AbortError resets loading indicator', async () => {
  // Part A: 12,120-item getItems warm open/search latency
  {
    const dom = createDom();
    const { window } = dom;
    const { document } = window;
    const palette = window.DefterCommandPalette;

    const bigCustomers = [];
    for (let i = 0; i < 9999; i++) {
      bigCustomers.push({
        id: `cust-${i}`,
        title: `Sentetik Müşteri ${i}`,
        subtitle: `TL · 0530${String(i).padStart(7, '0')}`
      });
    }
    bigCustomers.push({
      id: 'cust-tail-needle',
      title: 'İsmail Işık Hedef',
      subtitle: 'HAS · 05419998877'
    });
    const bigStocks = [];
    for (let i = 0; i < 2000; i++) {
      bigStocks.push({ id: `stk-${i}`, title: `Stok Kartı ${i}`, subtitle: 'GRAM' });
    }
    const bigSuppliers = [];
    for (let i = 0; i < 120; i++) {
      bigSuppliers.push({ id: `sup-${i}`, title: `Toptancı Firma ${i}`, subtitle: 'HAS' });
    }

    palette.registerProvider('customers', { group: 'records', groupLabel: 'Müşteriler', priority: 10, getItems: () => bigCustomers });
    palette.registerProvider('stocks', { group: 'stocks', groupLabel: 'Stoklar', priority: 20, getItems: () => bigStocks });
    palette.registerProvider('suppliers', { group: 'other', groupLabel: 'Firmalar', priority: 30, getItems: () => bigSuppliers });

    // Cold open warms itemRecordCache
    assert.equal(palette.open(), true);
    palette.close();

    const openDurations = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      assert.equal(palette.open(), true);
      openDurations.push(performance.now() - t0);
      if (i < 4) palette.close();
    }
    openDurations.sort((a, b) => a - b);
    const openMedianMs = openDurations[Math.floor(openDurations.length / 2)];
    assert.ok(openMedianMs < 35, `Warm getItems openMedianMs=${openMedianMs.toFixed(2)}ms (target < 35ms)`);

    const input = document.querySelector('[data-command-palette-input]');
    const searchDurations = [];
    for (const q of ['sentetik', 'ismail isik hedef', 'stok', 'hedef']) {
      const t0 = performance.now();
      input.value = q;
      input.dispatchEvent(inputEvent(window));
      searchDurations.push(performance.now() - t0);
    }
    searchDurations.sort((a, b) => a - b);
    const searchMedianMs = searchDurations[Math.floor(searchDurations.length / 2)];
    assert.ok(searchMedianMs < 35, `getItems searchMedianMs=${searchMedianMs.toFixed(2)}ms (target < 35ms)`);
    assert.ok(document.querySelector('[data-command-id="cust-tail-needle"]'));
    assert.ok(document.querySelectorAll('[role="option"]').length <= 25);

    palette.destroy();
    window.close();
  }

  // Part B: sync AbortError with debounceMs > 0 resets loading state
  {
    const dom = createDom();
    const { window } = dom;
    const { document } = window;
    const palette = window.DefterCommandPalette;
    palette.configure({ debounceMs: 15 });

    palette.registerProvider('p1-sync', {
      group: 'records',
      groupLabel: 'Müşteriler',
      priority: 1,
      search: () => [{ id: 'kept', title: 'Korunan' }]
    });
    palette.registerProvider('p2-abort', {
      group: 'other',
      groupLabel: 'Diğer',
      priority: 2,
      search: () => {
        throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
      }
    });

    palette.open();
    const input = document.querySelector('[data-command-palette-input]');
    input.value = 'Korunan';
    input.dispatchEvent(inputEvent(window));
    await tick(40);

    const statusEl = document.querySelector('[data-command-palette-status]');
    const errorEl = document.querySelector('[data-command-palette-error]');
    assert.notEqual(statusEl.textContent, 'Aranıyor…');
    assert.equal(errorEl.hidden, true);
    assert.ok(document.querySelector('[data-command-id="kept"]'));

    palette.destroy();
    window.close();
  }
});
