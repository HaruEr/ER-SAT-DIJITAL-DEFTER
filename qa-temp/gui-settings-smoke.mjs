// GUI redesign Faz 7 — top bar, moon/sun theme button and settings flyout in a real browser.
// Run: node --test qa-temp/gui-settings-smoke.mjs   (set CHROME_PATH if Chrome is not in a default location)
import test from 'node:test';
import assert from 'node:assert/strict';
import { startGuiSession, findChrome, sleep, OWNER_READY, CHECKOUT_READY, OWNER_NAME, EMPLOYEE_NAME } from '../test-support/gui-browser.mjs';

const skip = findChrome() ? false : 'Chrome not available (set CHROME_PATH)';

test('Faz 7 top bar and settings in a real browser', { skip, timeout: 150000 }, async t => {
  const gui = await startGuiSession();
  const { base, page, evaluate, until, navigate, viewport, login, logout, consoleErrors } = gui;
  const click = async selector => {
    const p = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await page('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    await page('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await page('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  };
  const settingsOpen = () => evaluate(`Boolean(document.querySelector('.defter-popover.defter-settings:not(.defter-ghost)'))`);

  try {
    await viewport({ width: 1440, height: 900 });
    await login(OWNER_NAME);
    await navigate(`${base}/owner`, OWNER_READY);
    await evaluate(`(() => { window.DefterPrefs.setMotion('full'); window.DefterPrefs.setSound(true); return true; })()`);

    await t.test('top bar: icon-only moon button keeps its accessible name; gear is the right-most control', async () => {
      const state = await evaluate(`(() => {
        const theme = document.querySelector('#theme-toggle'), gear = document.querySelector('#settings-trigger'), refresh = document.querySelector('#refresh');
        const cs = getComputedStyle(theme), before = getComputedStyle(theme, '::before');
        return {
          width: Math.round(theme.getBoundingClientRect().width), textHidden: cs.fontSize === '0px', text: theme.textContent, label: theme.getAttribute('aria-label'),
          icon: before.maskImage.includes('data:image/svg+xml') || before.webkitMaskImage.includes('data:image/svg+xml'),
          gearRightmost: gear.getBoundingClientRect().right > theme.getBoundingClientRect().right && theme.getBoundingClientRect().right > refresh.getBoundingClientRect().right,
          gearName: gear.getAttribute('aria-label'), gearPopup: gear.getAttribute('aria-haspopup')
        };
      })()`);
      assert.deepEqual(state, { width: 46, textHidden: true, text: 'Gece modu', label: 'Gece moduna geç', icon: true, gearRightmost: true, gearName: 'Ayarlar', gearPopup: 'dialog' });
    });

    await t.test('the moon button switches to dark and turns into a sun', async () => {
      await click('#theme-toggle');
      await sleep(500);
      const state = await evaluate(`(() => { const b = document.querySelector('#theme-toggle'); const before = getComputedStyle(b, '::before'); return { theme: document.documentElement.dataset.theme, label: b.getAttribute('aria-label'), sun: (before.maskImage || before.webkitMaskImage).includes('circle'), turned: before.transform !== 'none' }; })()`);
      assert.deepEqual(state, { theme: 'dark', label: 'Gündüz moduna geç', sun: true, turned: true });
      await click('#theme-toggle');
      await sleep(300);
      assert.equal(await evaluate('document.documentElement.dataset.theme'), 'light');
    });

    await t.test('the gear opens the settings flyout with every preference this page has', async () => {
      await click('#settings-trigger');
      await sleep(250);
      const state = await evaluate(`(() => {
        const pop = document.querySelector('.defter-popover.defter-settings');
        const r = pop.getBoundingClientRect();
        return {
          open: Boolean(pop), expanded: document.querySelector('#settings-trigger').getAttribute('aria-expanded'),
          title: pop.querySelector('strong')?.textContent,
          rows: [...pop.querySelectorAll('input[role="switch"]')].map(i => i.id),
          checked: Object.fromEntries([...pop.querySelectorAll('input[role="switch"]')].map(i => [i.id, i.checked])),
          inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
          focus: document.activeElement?.className, anim: pop.getAnimations().map(a => a.animationName)
        };
      })()`);
      assert.deepEqual(state, {
        open: true, expanded: 'true', title: 'Ayarlar',
        rows: ['setting-theme', 'setting-motion', 'setting-sound', 'setting-topbar', 'setting-sidebar'],
        checked: { 'setting-theme': false, 'setting-motion': false, 'setting-sound': true, 'setting-topbar': true, 'setting-sidebar': false },
        inside: true, focus: 'defter-popover-close', anim: []
      });
    });

    await t.test('each switch changes the real preference and stays in sync', async () => {
      await click('#setting-theme');
      await sleep(100);
      assert.deepEqual(await evaluate(`({ theme: document.documentElement.dataset.theme, on: document.querySelector('#setting-theme').checked, open: Boolean(document.querySelector('.defter-settings')) })`), { theme: 'dark', on: true, open: true });
      await click('#setting-theme');
      await click('#setting-motion');
      assert.deepEqual(await evaluate(`({ motion: document.documentElement.dataset.motion, stored: localStorage.getItem('defter-motion') })`), { motion: 'reduced', stored: 'reduced' });
      await click('#setting-motion');
      assert.equal(await evaluate(`document.documentElement.dataset.motion ?? null`), null);
      await click('#setting-sound');
      assert.deepEqual(await evaluate(`({ stored: localStorage.getItem('defter-sound'), pref: window.DefterPrefs.getSound(), silent: window.DefterUI.playChime() })`), { stored: 'off', pref: false, silent: false });
      await click('#setting-sound');
      assert.equal(await evaluate(`window.DefterPrefs.getSound()`), true);
      assert.equal(await evaluate(`window.DefterUI.playChime({ force: true })`), true, 'Web Audio chime plays');
      await click('#setting-sidebar');
      await sleep(300);
      assert.deepEqual(await evaluate(`({ collapsed: document.querySelector('.shell').classList.contains('sidebar-collapsed'), stored: localStorage.getItem('defter-sidebar-collapsed') })`), { collapsed: true, stored: '1' });
      await click('#setting-sidebar');
      await sleep(300);
      assert.equal(await evaluate(`document.querySelector('.shell').classList.contains('sidebar-collapsed')`), false);
    });

    await t.test('Escape closes the flyout and returns focus to the gear; an outside click also closes it', async () => {
      await page('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await page('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await sleep(50);
      assert.deepEqual(await evaluate(`({ open: Boolean(document.querySelector('.defter-popover:not(.defter-ghost)')), focus: document.activeElement?.id, expanded: document.querySelector('#settings-trigger').getAttribute('aria-expanded') })`), { open: false, focus: 'settings-trigger', expanded: 'false' });
      await sleep(200);
      await click('#settings-trigger');
      await sleep(250);
      assert.equal(await settingsOpen(), true);
      await page('Input.dispatchMouseEvent', { type: 'mousePressed', x: 700, y: 600, button: 'left', clickCount: 1 });
      await page('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 700, y: 600, button: 'left', clickCount: 1 });
      await sleep(50);
      assert.equal(await settingsOpen(), false);
    });

    await t.test('top bar stays on top while scrolling and turns to glass; other sticky panels sit below it', async () => {
      await evaluate(`(() => { document.querySelector('[data-view="journal"]').click(); return true; })()`);
      await until(OWNER_READY);
      await evaluate(`window.scrollTo(0, 0) || true`); // setView scrolls the content into view; start from the very top
      await sleep(300);
      const atTop = await evaluate(`({ scrolled: document.querySelector('.topbar').classList.contains('is-scrolled'), h: getComputedStyle(document.documentElement).getPropertyValue('--topbar-h') })`);
      await evaluate(`window.scrollTo(0, 900) || true`);
      await sleep(350);
      const below = await evaluate(`(() => { const bar = document.querySelector('.topbar'); const cs = getComputedStyle(bar); return { top: Math.round(bar.getBoundingClientRect().top), scrolled: bar.classList.contains('is-scrolled'), glass: cs.backdropFilter.includes('blur'), padding: getComputedStyle(document.documentElement).scrollPaddingTop }; })()`);
      await evaluate(`window.scrollTo(0, 0) || true`);
      await sleep(100);
      assert.equal(atTop.scrolled, false);
      assert.match(atTop.h, /^\d+px$/);
      const h = parseInt(atTop.h, 10);
      assert.ok(h >= 70 && h <= 140, `topbar height ${h}`);
      assert.deepEqual(below, { top: 0, scrolled: true, glass: true, padding: `${h + 16}px` });
    });

    await t.test('"Üst barı sabit tut" off: the bar scrolls away with the page, and the choice survives a reload', async () => {
      await click('#settings-trigger');
      await sleep(250);
      await click('#setting-topbar');
      await evaluate(`window.DefterUI.closePopover(false) || true`);
      const off = await evaluate(`(() => { window.scrollTo(0, 900); const bar = document.querySelector('.topbar'); return { attr: document.documentElement.dataset.topbar, stored: localStorage.getItem('defter-topbar'), position: getComputedStyle(bar).position, top: Math.round(bar.getBoundingClientRect().top) < 0, padding: getComputedStyle(document.documentElement).scrollPaddingTop }; })()`);
      assert.deepEqual(off, { attr: 'static', stored: 'static', position: 'static', top: true, padding: '24px' });
      await navigate(`${base}/owner`, OWNER_READY);
      const reloaded = await evaluate(`({ attr: document.documentElement.dataset.topbar, position: getComputedStyle(document.querySelector('.topbar')).position })`);
      assert.deepEqual(reloaded, { attr: 'static', position: 'static' });
      await evaluate(`(() => { window.scrollTo(0, 0); document.querySelector('#settings-trigger').click(); return true; })()`);
      await sleep(250);
      assert.equal(await evaluate(`document.querySelector('#setting-topbar').checked`), false);
      await click('#setting-topbar');
      await evaluate(`window.DefterUI.closePopover(false) || true`);
      assert.deepEqual(await evaluate(`({ attr: document.documentElement.dataset.topbar ?? null, position: getComputedStyle(document.querySelector('.topbar')).position })`), { attr: null, position: 'sticky' });
    });

    await t.test('phone: icons stay 46px, the flyout fits the screen, no sidebar row (no collapse on phones)', async () => {
      await viewport({ width: 390, height: 844, mobile: true });
      await sleep(300);
      await evaluate(`(() => { document.querySelector('#settings-trigger').click(); return true; })()`);
      await sleep(250);
      const state = await evaluate(`(() => {
        const pop = document.querySelector('.defter-popover.defter-settings'); const r = pop.getBoundingClientRect();
        return {
          theme: Math.round(document.querySelector('#theme-toggle').getBoundingClientRect().width), gear: Math.round(document.querySelector('#settings-trigger').getBoundingClientRect().width),
          inside: r.left >= 0 && r.right <= innerWidth, rows: [...pop.querySelectorAll('input[role="switch"]')].map(i => i.id),
          topbarSticky: getComputedStyle(document.querySelector('.topbar')).position
        };
      })()`);
      await evaluate(`window.DefterUI.closePopover(false) || true`);
      assert.deepEqual(state, { theme: 46, gear: 46, inside: true, rows: ['setting-theme', 'setting-motion', 'setting-sound'], topbarSticky: 'static' });
      await viewport({ width: 1440, height: 900 });
      await logout();
    });

    await t.test('checkout: the gear sits right of "Oturumu kapat" and offers theme, motion and sound', async () => {
      await login(EMPLOYEE_NAME);
      await navigate(`${base}/checkout`, CHECKOUT_READY);
      const order = await evaluate(`(() => { const r = id => document.getElementById(id).getBoundingClientRect().right; return r('settings-trigger') > r('logout') && r('theme-toggle') > r('logout'); })()`);
      assert.equal(order, true);
      await click('#settings-trigger');
      await sleep(250);
      const rows = await evaluate(`[...document.querySelectorAll('.defter-settings input[role="switch"]')].map(i => i.id)`);
      assert.deepEqual(rows, ['setting-theme', 'setting-motion', 'setting-sound']);
      await click('#setting-theme');
      assert.equal(await evaluate('document.documentElement.dataset.theme'), 'dark');
      await click('#setting-theme');
      assert.equal(await evaluate('document.documentElement.dataset.theme'), 'light');
    });

    assert.deepEqual(consoleErrors, [], 'no page errors (CSP allows the data: SVG masks)');
  } finally {
    await gui.close();
  }
});
