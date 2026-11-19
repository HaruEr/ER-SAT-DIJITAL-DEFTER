import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

test('2D users.js uses critical confirmation modal on disable and toast on success', async () => {
  const dom = new JSDOM(readFileSync(new URL('../public/users.html', import.meta.url), 'utf8'), { url: 'http://127.0.0.1/users' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.Node = dom.window.Node;
  globalThis.Option = dom.window.Option;
  globalThis.FormData = dom.window.FormData;

  const calls = [];
  dom.window.DefterSession = {
    current: () => ({ actor: { id: 'owner-1', name: 'Yönetici' } }),
    api: async (path, body) => {
      calls.push({ path, body });
      if (path === '/api/auth/users') return { users: [{ id: 'owner-1', name: 'Yönetici' }, { id: 'emp-1', name: 'Ahmet' }] };
      return { ok: true };
    }
  };
  dom.window.eval(readFileSync(new URL('../public/ui-kit.js', import.meta.url), 'utf8'));
  dom.window.eval(readFileSync(new URL('../public/users.js', import.meta.url), 'utf8'));
  await new Promise(r => setTimeout(r, 20));

  const disableForm = dom.window.document.getElementById('disable');
  disableForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 10));

  // Critical modal must be open, and /api/auth/disable must NOT be called yet
  assert.equal(dom.window.DefterUI.getLayerCount(), 1);
  assert.equal(calls.some(c => c.path === '/api/auth/disable'), false);

  // Confirm inside modal
  const confirmForm = dom.window.document.querySelector('.defter-confirm-form');
  confirmForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 20));

  assert.equal(dom.window.DefterUI.getLayerCount(), 0);
  assert.equal(calls.some(c => c.path === '/api/auth/disable' && c.body.id === 'emp-1'), true);
  assert.match(dom.window.document.getElementById('defter-toast-region').textContent, /erişimi kapatıldı/);
});
