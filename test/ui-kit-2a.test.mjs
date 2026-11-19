import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

function setupDom() {
  const dom = new JSDOM('<!doctype html><html lang="tr"><body><div id="notice" hidden></div><form><label class="field"><span>Tutar</span><input id="qty" type="text"></label></form></body></html>', { url: 'http://127.0.0.1/' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  dom.window.eval(readFileSync(new URL('../public/ui-kit.js', import.meta.url), 'utf8'));
  return { dom, UI: dom.window.DefterUI };
}

test('2A toast auto-dismisses, supports manual close, never steals focus, and clears on navigation', async () => {
  const { dom, UI } = setupDom();
  const input = dom.window.document.getElementById('qty');
  input.focus();

  const handle = UI.toast('Müşteri kartı oluşturuldu.', { kind: 'success', durationMs: 60 });
  assert.ok(handle);
  assert.equal(dom.window.document.activeElement, input);
  const region = dom.window.document.getElementById('defter-toast-region');
  assert.equal(region.getAttribute('aria-live'), 'polite');
  assert.equal(region.children.length, 1);

  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(region.children.length, 0);

  const manual = UI.toast('Satış kaydedildi.', { kind: 'info', durationMs: 5000 });
  assert.equal(region.children.length, 1);
  manual.element.querySelector('.defter-toast-close').click();
  assert.equal(region.children.length, 0);

  UI.toast('Stale test', { durationMs: 5000 });
  assert.equal(region.children.length, 1);
  UI.clearToasts();
  assert.equal(region.children.length, 0);
});

test('2A field error binds role=alert and aria-describedby to the exact input and clears cleanly', () => {
  const { dom, UI } = setupDom();
  const input = dom.window.document.getElementById('qty');
  UI.showFieldError(input, '700.000 TL ödemenin kaç HAS borcu kapatacağını girin.');
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.equal(input.getAttribute('aria-describedby'), 'qty-error');
  const errEl = dom.window.document.getElementById('qty-error');
  assert.equal(errEl.getAttribute('role'), 'alert');
  assert.match(errEl.textContent, /700\.000 TL/);

  UI.clearFieldError(input);
  assert.equal(input.getAttribute('aria-invalid'), null);
  assert.equal(input.getAttribute('aria-describedby'), null);
  assert.equal(dom.window.document.getElementById('qty-error'), null);
});

test('2A critical banner stays persistent with role=alert until explicitly cleared', async () => {
  const { dom, UI } = setupDom();
  const notice = dom.window.document.getElementById('notice');
  UI.showBanner(notice, '409 Revizyon çakışması: defteri yenileyin.', { kind: 'error', focus: true });
  assert.equal(notice.hidden, false);
  assert.equal(notice.getAttribute('role'), 'alert');
  assert.equal(notice.getAttribute('aria-live'), 'assertive');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(notice.hidden, false);

  UI.clearBanner(notice);
  assert.equal(notice.hidden, true);
});
