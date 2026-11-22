// GUI redesign Faz 9 — sale/purchase feedback (check-mark toast + chime) and pill pops, real browser.
// Run: node --test qa-temp/gui-sale-feedback-smoke.mjs   (set CHROME_PATH if Chrome is not in a default location)
import test from 'node:test';
import assert from 'node:assert/strict';
import { startGuiSession, findChrome, sleep, OWNER_READY, CHECKOUT_READY, OWNER_NAME, EMPLOYEE_NAME } from '../test-support/gui-browser.mjs';

const skip = findChrome() ? false : 'Chrome not available (set CHROME_PATH)';

// Counts oscillators started by the Web Audio chime (2 per chime) without changing its sound.
const AUDIO_SPY = `(() => {
  if (window.__chimeNotes !== undefined) return true;
  window.__chimeNotes = 0;
  const Original = window.AudioContext;
  window.AudioContext = class extends Original { createOscillator() { window.__chimeNotes++; return super.createOscillator(); } };
  return true;
})()`;
const SET = `const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };`;

test('Faz 9 sale feedback in a real browser', { skip, timeout: 150000 }, async t => {
  const gui = await startGuiSession();
  const { base, evaluate, until, navigate, viewport, login, logout, consoleErrors } = gui;
  const ownerSale = () => evaluate(`(async () => {
    ${SET}
    const f = document.querySelector('#sale-form');
    set(f.querySelector('[data-item-field="accountId"]'), 'ceyrek');
    set(f.querySelector('[data-item-field="quantity"]'), '1');
    set(f.querySelector('[data-item-field="value"]'), '5200');
    f.querySelector('.payment-chip[data-add-allocation="payment"][data-payment-type="cash"]').click();
    await new Promise(r => setTimeout(r, 100));
    set(f.querySelector('[data-allocation-field="quantity"]'), '5200');
    await new Promise(r => setTimeout(r, 100));
    f.querySelector('button[type="submit"]').click();
    return true;
  })()`);
  const openTransaction = async () => {
    await evaluate(`(() => { document.querySelector('[data-view="transaction"]').click(); return true; })()`);
    await until(`${OWNER_READY} && document.querySelector('#sale-form [data-item-field="accountId"]')`);
  };

  try {
    await viewport({ width: 1440, height: 900 });
    await login(OWNER_NAME);
    await navigate(`${base}/owner`, OWNER_READY);
    await evaluate(`(() => { window.DefterPrefs.setMotion('full'); window.DefterPrefs.setSound(true); return true; })()`);
    await evaluate(AUDIO_SPY);

    await t.test('İşlem Ekranı layout: the form and the live summary share the width half and half (≥1100px)', async () => {
      await openTransaction();
      for (const width of [1440, 1100]) {
        await viewport({ width, height: 900 });
        await sleep(200);
        const cols = await evaluate(`(() => { const f = document.querySelector('#sale-form'); const main = f.querySelector('.trade-main').getBoundingClientRect().width; const side = f.querySelector('.trade-live-summary').getBoundingClientRect().width; return { equal: Math.abs(main - side) < 1, overflow: document.documentElement.scrollWidth > innerWidth }; })()`);
        assert.deepEqual(cols, { equal: true, overflow: false }, `at ${width}px`);
      }
      await viewport({ width: 1440, height: 900 });
    });

    await t.test('owner sale: success toast draws a check mark and the chime plays once', async () => {
      await openTransaction();
      await evaluate(`(() => { window.__chimeNotes = 0; window.DefterUI.clearToasts(); return true; })()`);
      await ownerSale();
      await until(`[...document.querySelectorAll('.defter-toast')].some(t => t.textContent.includes('kaydedildi'))`, 8000);
      const state = await evaluate(`(() => {
        const t = [...document.querySelectorAll('.defter-toast')].find(x => x.textContent.includes('kaydedildi'));
        const path = t.querySelector('.defter-toast-icon path');
        return {
          icon: Boolean(path), announced: t.getAttribute('role'), hidden: t.getAttribute('aria-hidden'),
          draw: path ? path.getAnimations().map(a => a.animationName) : [], notes: window.__chimeNotes
        };
      })()`);
      assert.deepEqual(state, { icon: true, announced: 'status', hidden: null, draw: ['defter-check-draw'], notes: 2 });
    });

    await t.test('sound off: the same sale shows the check mark but stays silent', async () => {
      await evaluate(`(() => { window.DefterPrefs.setSound(false); window.__chimeNotes = 0; window.DefterUI.clearToasts(); return true; })()`);
      await openTransaction();
      await ownerSale();
      await until(`[...document.querySelectorAll('.defter-toast')].some(t => t.textContent.includes('kaydedildi'))`, 8000);
      const state = await evaluate(`({ icon: Boolean(document.querySelector('.defter-toast .defter-toast-icon')), notes: window.__chimeNotes })`);
      assert.deepEqual(state, { icon: true, notes: 0 });
      await evaluate(`window.DefterPrefs.setSound(true) || true`);
    });

    await t.test('non-sale records keep the plain toast (no check mark, no chime)', async () => {
      await evaluate(`(() => { window.__chimeNotes = 0; window.DefterUI.clearToasts(); return true; })()`);
      await evaluate(`(() => { window.DefterUI.toast('Müşteri kartı oluşturuldu.', { kind: 'success' }); return true; })()`);
      const state = await evaluate(`({ icon: Boolean(document.querySelector('.defter-toast .defter-toast-icon')), notes: window.__chimeNotes })`);
      assert.deepEqual(state, { icon: false, notes: 0 });
    });

    await t.test('reduced motion: the check mark is shown complete, with no drawing animation', async () => {
      await evaluate(`(() => { window.DefterPrefs.setMotion('reduced'); window.DefterUI.clearToasts(); window.DefterUI.celebrate('Satış kaydedildi.'); return true; })()`);
      const state = await evaluate(`(() => { const p = document.querySelector('.defter-toast-icon path'); return { anims: p.getAnimations().length, offset: getComputedStyle(p).strokeDashoffset }; })()`);
      assert.deepEqual(state, { anims: 0, offset: '0px' });
      await evaluate(`(() => { window.DefterPrefs.setMotion('full'); window.DefterUI.clearToasts(); return true; })()`);
      await logout();
    });

    await t.test('checkout sale: visual check-mark toast (not announced twice), #status announces, chime plays', async () => {
      await login(EMPLOYEE_NAME);
      await navigate(`${base}/checkout`, CHECKOUT_READY);
      await evaluate(AUDIO_SPY);
      await evaluate(`(() => { window.__chimeNotes = 0; return true; })()`);
      await evaluate(`(async () => {
        ${SET}
        set(document.querySelector('[data-product]'), 'ceyrek');
        set(document.querySelector('[data-item] [data-quantity]'), '1');
        set(document.querySelector('[data-item] [data-value]'), '5200');
        document.querySelector('[data-add="received"][data-category="money"]').click();
        await new Promise(r => setTimeout(r, 100));
        set(document.querySelector('[data-allocation="received"] [data-account]'), 'nakit');
        set(document.querySelector('[data-allocation="received"] [data-quantity]'), '5200');
        document.querySelector('#record').click();
        return true;
      })()`);
      await until(`document.querySelector('#review')?.hidden === false`, 5000);
      await evaluate(`(() => { document.querySelector('#confirm').click(); return true; })()`);
      await until(`document.querySelector('#status')?.textContent.includes('İşlem kaydedildi')`, 10000);
      const state = await evaluate(`(() => {
        const t = [...document.querySelectorAll('.defter-toast')].find(x => x.textContent.includes('İşlem kaydedildi'));
        return { toast: Boolean(t), icon: Boolean(t?.querySelector('.defter-toast-icon')), hidden: t?.getAttribute('aria-hidden'), role: t?.getAttribute('role'), status: document.querySelector('#status').getAttribute('role'), notes: window.__chimeNotes };
      })()`);
      assert.deepEqual(state, { toast: true, icon: true, hidden: 'true', role: null, status: 'status', notes: 2 });
    });

    await t.test('the quick/guided switch pops when pressed', async () => {
      await evaluate(`(() => { document.querySelector('button[data-flow-mode="guided"]').click(); return true; })()`);
      await sleep(30);
      const anims = await evaluate(`document.querySelector('button[data-flow-mode="guided"]').getAnimations().map(a => a.animationName).filter(Boolean)`);
      assert.ok(anims.includes('defter-pill-pop'), `pill pop: ${anims}`);
      await logout();
    });

    assert.deepEqual(consoleErrors, [], 'no page errors');
  } finally {
    await gui.close();
  }
});
