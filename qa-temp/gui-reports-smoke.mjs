// GUI redesign Faz 10 — read-only report portal motion in a real browser (via the harness tailnet proxy).
// Run: node --test qa-temp/gui-reports-smoke.mjs   (set CHROME_PATH if Chrome is not in a default location)
import test from 'node:test';
import assert from 'node:assert/strict';
import { startGuiSession, findChrome, sleep } from '../test-support/gui-browser.mjs';

const skip = findChrome() ? false : 'Chrome not available (set CHROME_PATH)';
const READY = `document.querySelector('[data-report-view].active') && !document.querySelector('#report-main .empty-state h1')?.textContent.includes('hazırlanıyor')`;

test('Faz 10 report portal in a real browser', { skip, timeout: 120000 }, async t => {
  const gui = await startGuiSession({ reports: true });
  const { reportBase, page, evaluate, until, navigate, viewport, enableReportProxy, consoleErrors } = gui;
  const click = async selector => {
    const p = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await page('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    await page('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await page('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  };
  const indicatorOnActive = () => evaluate(`(() => {
    const ind = document.querySelector('.report-nav-indicator').getBoundingClientRect();
    const act = document.querySelector('.report-nav [data-report-view].active').getBoundingClientRect();
    return Math.abs(ind.left - act.left) < 1 && Math.abs(ind.top - act.top) < 1 && Math.abs(ind.width - act.width) < 1 && Math.abs(ind.height - act.height) < 1;
  })()`);

  try {
    await enableReportProxy();
    await viewport({ width: 1440, height: 900 });
    await navigate(`${reportBase}/`, READY);
    await sleep(300);

    await t.test('the indicator sits behind the active tab with the existing active look; the tab keeps aria-current', async () => {
      const state = await evaluate(`(() => {
        const ind = document.querySelector('.report-nav-indicator'), active = document.querySelector('.report-nav [data-report-view].active');
        const tokenRgb = name => { const p = document.createElement('i'); p.style.color = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; };
        const is = getComputedStyle(ind), as = getComputedStyle(active);
        return { hidden: ind.getAttribute('aria-hidden'), visible: is.opacity === '1', ground: is.backgroundColor === tokenRgb('--surface'), underline: is.boxShadow.startsWith(tokenRgb('--gold')) && is.boxShadow.includes('inset'), tabClear: as.backgroundColor === 'rgba(0, 0, 0, 0)', current: active.getAttribute('aria-current'), tabs: document.querySelectorAll('[data-report-view]').length };
      })()`);
      assert.deepEqual(state, { hidden: 'true', visible: true, ground: true, underline: true, tabClear: true, current: 'page', tabs: 4 });
      assert.equal(await indicatorOnActive(), true);
    });

    await t.test('switching tabs slides the indicator and the new view rises in, staggered', async () => {
      await click('[data-report-view="stock"]');
      const during = await evaluate(`(() => ({
        sliding: document.querySelector('.report-nav-indicator').getAnimations().some(a => a.transitionProperty === 'transform'),
        rising: [...document.querySelectorAll('#report-main > *')].flatMap(el => el.getAnimations()).map(a => a.animationName),
        delays: [...document.querySelectorAll('#report-main > *')].slice(0, 3).map(el => getComputedStyle(el).animationDelay)
      }))()`);
      assert.equal(during.sliding, true);
      assert.ok(during.rising.length >= 2 && during.rising.every(name => name === 'defter-report-in'), `rising: ${during.rising}`);
      assert.deepEqual(during.delays, ['0s', '0.04s', '0.08s'].slice(0, during.delays.length), 'staggered by child order');
      assert.ok(during.delays.length >= 2);
      await sleep(400);
      assert.equal(await indicatorOnActive(), true);
    });

    await t.test('phone: the bottom tab bar is fixed and the indicator follows inside it', async () => {
      await viewport({ width: 390, height: 844, mobile: true });
      await sleep(300);
      const nav = await evaluate(`(() => { const n = document.querySelector('.report-nav'); return { position: getComputedStyle(n).position, bottom: Math.round(innerHeight - n.getBoundingClientRect().bottom) }; })()`);
      assert.deepEqual(nav, { position: 'fixed', bottom: 0 });
      assert.equal(await indicatorOnActive(), true);
      await click('[data-report-view="cari"]');
      await sleep(400);
      assert.equal(await indicatorOnActive(), true);
      await viewport({ width: 1440, height: 900 });
      await sleep(300);
      assert.equal(await indicatorOnActive(), true, 'back on desktop');
    });

    await t.test('reduced motion (app switch or system): no entrance and no slide', async () => {
      await evaluate(`(() => { localStorage.setItem('defter-motion', 'reduced'); return true; })()`);
      await navigate(`${reportBase}/`, READY);
      await click('[data-report-view="journal"]');
      await sleep(30);
      const state = await evaluate(`(() => ({ main: [...document.querySelectorAll('#report-main > *')].flatMap(el => el.getAnimations()).length, nav: document.querySelector('.report-nav-indicator').getAnimations().length }))()`);
      assert.deepEqual(state, { main: 0, nav: 0 });
      assert.equal(await indicatorOnActive(), true);
      await evaluate(`(() => { localStorage.removeItem('defter-motion'); return true; })()`);
      await page('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await navigate(`${reportBase}/`, READY);
      await click('[data-report-view="stock"]');
      await sleep(30);
      const system = await evaluate(`(() => [...document.querySelectorAll('#report-main > *')].map(el => getComputedStyle(el).animationDuration))()`);
      assert.ok(system.every(d => d === '0s'), `system preference zeroes durations: ${system}`);
      await page('Emulation.setEmulatedMedia', { features: [] });
    });

    assert.deepEqual(consoleErrors, [], 'no page errors');
  } finally {
    await gui.close();
  }
});
