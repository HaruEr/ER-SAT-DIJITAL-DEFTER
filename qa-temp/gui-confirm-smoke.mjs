// GUI redesign Faz 4 — critical confirmations in a real browser (trusted CDP mouse/keyboard input).
// Run: node --test qa-temp/gui-confirm-smoke.mjs   (set CHROME_PATH if Chrome is not in a default location)
import test from 'node:test';
import assert from 'node:assert/strict';
import { startGuiSession, findChrome, sleep, OWNER_READY, OWNER_NAME } from '../test-support/gui-browser.mjs';

const skip = findChrome() ? false : 'Chrome not available (set CHROME_PATH)';

test('Faz 4 critical confirmations in a real browser', { skip, timeout: 120000 }, async t => {
  const gui = await startGuiSession();
  const { base, page, evaluate, until, navigate, viewport, login, consoleErrors } = gui;

  const mouseClick = async ({ x, y }) => {
    await page('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await page('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await page('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const pressEnter = async () => {
    await page('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
    await page('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  };
  // Opens confirmCritical and records its result on window.__confirm; returns the confirm button centre.
  const openConfirm = (options = {}) => evaluate(`(() => {
    window.__confirm = 'pending';
    window.DefterUI.confirmCritical(${JSON.stringify({ title: 'Kaydı ters çevir', impactText: 'Bu işlem geri alınamaz.', confirmLabel: 'Ters çevir', ...options })})
      .then(result => { window.__confirm = result; });
    const d = document.querySelector('dialog[data-critical-modal][open]');
    const r = d.querySelector('button[type="submit"]').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  const result = () => evaluate('window.__confirm');
  const reset = async () => { await evaluate(`(() => { while (window.DefterUI.closeTopLayer('reset')); window.DefterPrefs.setMotion('full'); return true; })()`); await sleep(400); };

  try {
    await viewport({ width: 1440, height: 900 });
    await login(OWNER_NAME);
    await navigate(`${base}/owner`, OWNER_READY);

    await t.test('danger confirmation: red stripe, icon, impact callout; title text and focus unchanged', async () => {
      await openConfirm();
      const state = await evaluate(`(() => {
        const d = document.querySelector('dialog[data-critical-modal][open]');
        const cs = getComputedStyle(d);
        const red = getComputedStyle(document.documentElement).getPropertyValue('--red').trim();
        const probe = document.createElement('i'); probe.style.color = red; document.body.append(probe);
        const redRgb = getComputedStyle(probe).color; probe.remove();
        const icon = d.querySelector('.defter-critical-icon');
        const impact = getComputedStyle(d.querySelector('.defter-confirm-impact'));
        return {
          stripe: cs.borderTopWidth, stripeIsRed: cs.borderTopColor === redRgb,
          icon: Boolean(icon?.querySelector('svg')), iconHidden: icon?.getAttribute('aria-hidden'),
          title: d.querySelector('h2').textContent, labelled: document.getElementById(d.getAttribute('aria-labelledby'))?.textContent,
          impactBoxed: impact.borderTopStyle === 'solid' && impact.paddingTop === '12px',
          focus: document.activeElement?.textContent, arming: d.querySelector('button[type="submit"]').classList.contains('is-arming')
        };
      })()`);
      assert.deepEqual(state, { stripe: '4px', stripeIsRed: true, icon: true, iconHidden: 'true', title: 'Kaydı ters çevir', labelled: 'Kaydı ters çevir', impactBoxed: true, focus: 'Vazgeç', arming: true });
      await reset();
    });

    await t.test('a real click inside the arming window is ignored; the same click after it confirms', async () => {
      await reset();
      const button = await openConfirm();
      await mouseClick(button);
      assert.equal(await result(), 'pending', 'stray click (double-click second half) does nothing');
      assert.equal(await evaluate(`Boolean(document.querySelector('dialog[data-critical-modal][open]'))`), true);
      await sleep(350);
      assert.equal(await evaluate(`document.querySelector('dialog[data-critical-modal][open] button[type="submit"]').classList.contains('is-arming')`), false);
      await mouseClick(button);
      await sleep(50);
      assert.deepEqual(await result(), { confirmed: true });
      await reset();
    });

    await t.test('a held/repeated Enter on the confirm button cannot confirm before it is armed', async () => {
      await reset();
      await openConfirm();
      await evaluate(`(() => { document.querySelector('dialog[data-critical-modal][open] button[type="submit"]').focus(); return true; })()`);
      await pressEnter();
      await pressEnter();
      assert.equal(await result(), 'pending');
      await sleep(350);
      await pressEnter();
      await sleep(50);
      assert.deepEqual(await result(), { confirmed: true });
      await reset();
    });

    await t.test('programmatic activation is never delayed (existing contracts and tests)', async () => {
      await reset();
      const state = await evaluate(`(async () => {
        const p = window.DefterUI.confirmCritical({ title: 'Hemen', impactText: 'x' });
        document.querySelector('dialog[data-critical-modal][open] button[type="submit"]').click();
        return await p;
      })()`);
      assert.deepEqual(state, { confirmed: true });
      await reset();
    });

    await t.test('missing reason: browser validation blocks submit and the dialog shakes; blank text gets the field error; reduced motion keeps the guard but drops the shake', async () => {
      await reset();
      await openConfirm({ requireReason: true, reasonLabel: 'Gerekçe' });
      await sleep(350);
      const empty = await evaluate(`(() => {
        const d = document.querySelector('dialog[data-critical-modal][open]');
        d.querySelector('.defter-confirm-form').requestSubmit();
        return { valid: d.querySelector('input[name="reason"]').validity.valid, shaking: d.getAnimations().some(a => !('animationName' in a)), pending: window.__confirm === 'pending' };
      })()`);
      assert.deepEqual(empty, { valid: false, shaking: true, pending: true });
      await sleep(400);
      const blank = await evaluate(`(() => {
        const d = document.querySelector('dialog[data-critical-modal][open]');
        d.querySelector('input[name="reason"]').value = '   ';
        d.querySelector('.defter-confirm-form').requestSubmit();
        return { error: d.querySelector('.field-error')?.textContent, shaking: d.getAnimations().some(a => !('animationName' in a)), pending: window.__confirm === 'pending' };
      })()`);
      assert.deepEqual(blank, { error: 'Gerekçe yazın.', shaking: true, pending: true });
      await reset();
      await evaluate(`window.DefterPrefs.setMotion('reduced') || true`);
      const button = await openConfirm({ requireReason: true });
      const reduced = await evaluate(`(() => {
        const d = document.querySelector('dialog[data-critical-modal][open]');
        d.querySelector('.defter-confirm-form').requestSubmit();
        return { shaking: d.getAnimations().length };
      })()`);
      await evaluate(`(() => { document.querySelector('dialog[data-critical-modal][open] input[name="reason"]').value = 'Hatalı giriş'; return true; })()`);
      await mouseClick(button);
      const guarded = await result();
      await evaluate(`window.DefterPrefs.setMotion('full') || true`);
      assert.deepEqual(reduced, { shaking: 0 });
      assert.equal(guarded, 'pending', 'the arming guard is a safety rule, not motion');
      await reset();
    });

    await t.test('caution variant (danger: false) uses the gold stripe', async () => {
      await reset();
      await openConfirm({ danger: false });
      const state = await evaluate(`(() => {
        const d = document.querySelector('dialog[data-critical-modal][open]');
        const gold = getComputedStyle(document.documentElement).getPropertyValue('--gold').trim();
        const probe = document.createElement('i'); probe.style.color = gold; document.body.append(probe);
        const goldRgb = getComputedStyle(probe).color; probe.remove();
        return { caution: d.classList.contains('defter-dialog--caution'), stripeIsGold: getComputedStyle(d).borderTopColor === goldRgb, dangerIcon: Boolean(d.querySelector('.defter-critical-icon.is-danger')) };
      })()`);
      assert.deepEqual(state, { caution: true, stripeIsGold: true, dangerIcon: false });
      await reset();
    });

    await t.test('in-page review panels: rise-in animation and a soft red ground for reverse', async () => {
      const state = await evaluate(`(() => {
        const host = document.querySelector('#main');
        host.insertAdjacentHTML('beforeend', '<div data-reverse-review class="info neutral" id="probe-reverse"><button class="button danger" type="button">Onayla</button></div><div data-return-review class="info neutral" id="probe-return"></div>');
        const rev = document.getElementById('probe-reverse'), ret = document.getElementById('probe-return');
        const tokenRgb = name => { const p = document.createElement('i'); p.style.color = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; };
        const out = {
          reverseTinted: getComputedStyle(rev).backgroundColor !== getComputedStyle(ret).backgroundColor,
          anim: [...rev.getAnimations(), ...ret.getAnimations()].map(a => a.animationName)
        };
        rev.remove(); ret.remove();
        return out;
      })()`);
      assert.deepEqual(state, { reverseTinted: true, anim: ['defter-review-in', 'defter-review-in'] });
    });

    await t.test('real journal reverse flow: the in-page confirm ignores a stray click, then sends exactly one command', async () => {
      await reset();
      await evaluate(`(() => { document.querySelector('[data-view="journal"]').click(); return true; })()`);
      await until(`${OWNER_READY} && document.querySelector('.reverse-form')`);
      const point = await evaluate(`(async () => {
        window.__commands = 0;
        const realFetch = window.fetch;
        window.fetch = (url, options) => { if (String(url).includes('/api/command')) window.__commands++; return realFetch(url, options); };
        const form = document.querySelector('.reverse-form');
        form.closest('details').open = true;
        form.querySelector('[name="note"]').value = 'Yanlış girilen kayıt';
        form.requestSubmit();
        const panel = form.querySelector('[data-reverse-review]');
        const button = panel.querySelector('[data-confirm-reverse]');
        button.scrollIntoView({ block: 'center', behavior: 'instant' });
        await Promise.allSettled(panel.getAnimations().map(a => a.finished));
        const r = button.getBoundingClientRect();
        const tokenRgb = name => { const p = document.createElement('i'); p.style.color = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; };
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, focused: document.activeElement === button, armed: button.classList.contains('is-arming'), redFrame: getComputedStyle(panel).borderTopColor === tokenRgb('--red') };
      })()`);
      assert.equal(point.focused, true, 'confirm button receives focus as before');
      assert.equal(point.armed, true);
      assert.equal(point.redFrame, true, 'existing D07 red frame is kept');
      await mouseClick(point);
      await sleep(100);
      assert.equal(await evaluate('window.__commands'), 0, 'stray click inside the arming window sends nothing');
      await sleep(300);
      await mouseClick(point);
      await until('window.__commands === 1', 5000);
      await sleep(300);
      assert.equal(await evaluate('window.__commands'), 1);
    });

    assert.deepEqual(consoleErrors, [], 'no page errors');
  } finally {
    await gui.close();
  }
});
