import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

function setupDom() {
  const dom = new JSDOM('<!doctype html><html lang="tr"><body><button id="info-btn" type="button">Bilgi</button><div id="panel"></div></body></html>', { url: 'http://127.0.0.1/' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.Node = dom.window.Node;
  dom.window.eval(readFileSync(new URL('../public/ui-kit.js', import.meta.url), 'utf8'));
  return { dom, UI: dom.window.DefterUI };
}

test('2C Popover clamps within viewport, closes on Escape, and restores focus to anchor', () => {
  const { dom, UI } = setupDom();
  const doc = dom.window.document;
  const anchor = doc.getElementById('info-btn');
  anchor.getBoundingClientRect = () => ({ left: 2000, right: 2060, top: 10, bottom: 40 });
  anchor.focus();

  const pop = UI.openPopover(anchor, {
    title: 'Cari Özeti',
    content: '<p>Telefon: 0500 000 00 00</p>'
  });
  assert.ok(pop);
  assert.equal(anchor.getAttribute('aria-expanded'), 'true');
  const left = parseInt(pop.element.style.left, 10);
  assert.ok(left <= dom.window.innerWidth - 8, `Expected clamped left <= viewport, got ${left}`);

  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(doc.querySelector('.defter-popover'), null);
  assert.equal(anchor.getAttribute('aria-expanded'), 'false');
  assert.equal(doc.activeElement, anchor);
});

test('2C Skeleton renders accessible placeholder bars with zero fake currency amounts', () => {
  const { dom, UI } = setupDom();
  const panel = dom.window.document.getElementById('panel');
  const skel = UI.renderSkeleton(panel, { variant: 'table', rows: 3 });
  assert.equal(skel.getAttribute('aria-busy'), 'true');
  assert.equal(skel.children.length, 3);
  assert.doesNotMatch(panel.textContent, /TL|HAS|USD|EUR|\d/);
});
