import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

function setupDom() {
  const dom = new JSDOM('<!doctype html><html lang="tr"><body><div class="shell"><main id="main"><button id="open-btn" type="button">Aç</button><input id="main-draft" value="taslak-deger"></main></div></body></html>', { url: 'http://127.0.0.1/' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.Node = dom.window.Node;
  dom.window.eval(readFileSync(new URL('../public/ui-kit.js', import.meta.url), 'utf8'));
  return { dom, UI: dom.window.DefterUI };
}

test('2B Modal traps Tab/Shift+Tab, closes on Escape, restores focus, and keeps #main draft intact', () => {
  const { dom, UI } = setupDom();
  const doc = dom.window.document;
  const trigger = doc.getElementById('open-btn');
  const draft = doc.getElementById('main-draft');
  trigger.focus();

  const content = doc.createElement('div');
  const firstInput = doc.createElement('input');
  firstInput.id = 'm-input';
  const lastBtn = doc.createElement('button');
  lastBtn.type = 'button';
  lastBtn.textContent = 'Tamam';
  content.append(firstInput, lastBtn);

  const modal = UI.openModal({ title: 'Test Modal', content, trigger });
  assert.equal(UI.getLayerCount(), 1);
  assert.equal(doc.querySelector('.shell').getAttribute('aria-hidden'), 'true');
  assert.equal(doc.activeElement, firstInput);

  // Tab from lastBtn wraps to close button / first focusable inside modal
  lastBtn.focus();
  modal.dialog.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  assert.ok(modal.dialog.contains(doc.activeElement));

  // Shift+Tab from closeBtn wraps to lastBtn
  const closeBtn = modal.dialog.querySelector('.defter-dialog-close');
  closeBtn.focus();
  modal.dialog.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
  assert.equal(doc.activeElement, lastBtn);

  // Escape closes and returns focus to trigger without touching #main draft
  modal.dialog.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(UI.getLayerCount(), 0);
  assert.equal(doc.querySelector('.shell').getAttribute('aria-hidden'), null);
  assert.equal(doc.activeElement, trigger);
  assert.equal(draft.value, 'taslak-deger');
});

test('2B Nested Drawer -> Modal stacks safely and preserves Drawer draft on inner Modal Escape', async () => {
  const { dom, UI } = setupDom();
  const doc = dom.window.document;
  const trigger = doc.getElementById('open-btn');
  trigger.focus();

  const drawerContent = doc.createElement('div');
  const drawerInput = doc.createElement('input');
  drawerInput.value = 'cari-taslak';
  const innerBtn = doc.createElement('button');
  innerBtn.type = 'button';
  innerBtn.textContent = 'Onay Aç';
  drawerContent.append(drawerInput, innerBtn);

  const drawer = UI.openDrawer({ title: 'Müşteri Çekmecesi', content: drawerContent, trigger });
  assert.equal(UI.getLayerCount(), 1);

  const confirmPromise = UI.confirmCritical({
    title: 'Kritik Onay',
    impactText: 'Bu işlem geri alınamaz.',
    requireReason: true,
    trigger: innerBtn
  });
  assert.equal(UI.getLayerCount(), 2);
  assert.equal(drawer.dialog.getAttribute('aria-hidden'), 'true');

  // Escape closes ONLY the top Modal, never confirms, and restores focus to innerBtn
  const topModal = doc.querySelectorAll('.defter-dialog')[1];
  topModal.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const result = await confirmPromise;
  assert.deepEqual(result, { confirmed: false });
  assert.equal(UI.getLayerCount(), 1);
  assert.equal(drawer.dialog.getAttribute('aria-hidden'), null);
  assert.equal(drawerInput.value, 'cari-taslak');
  assert.equal(doc.activeElement, innerBtn);

  drawer.close('done');
  assert.equal(UI.getLayerCount(), 0);
  assert.equal(doc.activeElement, trigger);
});
