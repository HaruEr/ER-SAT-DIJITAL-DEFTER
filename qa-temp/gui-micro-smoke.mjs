// GUI redesign Faz 6 — micro-interactions in a real browser (trusted CDP mouse input).
// Run: node --test qa-temp/gui-micro-smoke.mjs   (set CHROME_PATH if Chrome is not in a default location)
import test from 'node:test';
import assert from 'node:assert/strict';
import { startGuiSession, findChrome, sleep, OWNER_READY, OWNER_NAME } from '../test-support/gui-browser.mjs';

const skip = findChrome() ? false : 'Chrome not available (set CHROME_PATH)';

test('Faz 6 micro-interactions in a real browser', { skip, timeout: 120000 }, async t => {
  const gui = await startGuiSession();
  const { base, page, evaluate, until, navigate, viewport, login, consoleErrors } = gui;
  const centre = selector => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: 'center', behavior: 'instant' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const move = ({ x, y }) => page('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  const transformOf = selector => evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).transform`);
  const indicatorMatchesActive = () => evaluate(`(() => {
    const nav = document.querySelector('#navigation');
    const ind = nav.querySelector('.nav-indicator').getBoundingClientRect();
    const act = nav.querySelector('button.active').getBoundingClientRect();
    return Math.abs(ind.top - act.top) < 1 && Math.abs(ind.left - act.left) < 1 && Math.abs(ind.height - act.height) < 1 && Math.abs(ind.width - act.width) < 1;
  })()`);
  const goTo = async viewName => {
    await evaluate(`(() => { document.querySelector('[data-view="${viewName}"]').click(); return true; })()`);
    await until(OWNER_READY);
  };

  try {
    await viewport({ width: 1440, height: 900 });
    await login(OWNER_NAME);
    await navigate(`${base}/owner`, OWNER_READY);
    await evaluate(`window.DefterPrefs.setMotion('full') || true`);

    await t.test('sidebar: one indicator with the existing active look sits exactly behind the active item', async () => {
      const state = await evaluate(`(() => {
        const nav = document.querySelector('#navigation');
        const ind = nav.querySelector('.nav-indicator');
        const active = nav.querySelector('button.active');
        const cs = getComputedStyle(active);
        const tokenRgb = name => { const p = document.createElement('i'); p.style.color = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; };
        const is = getComputedStyle(ind);
        return {
          visible: is.opacity === '1', hidden: ind.getAttribute('aria-hidden'),
          ground: is.backgroundColor === tokenRgb('--sidebar-hover'), goldEdge: is.boxShadow.includes('inset') && is.boxShadow.startsWith(tokenRgb('--gold')),
          buttonClear: cs.backgroundColor === 'rgba(0, 0, 0, 0)' && cs.boxShadow === 'none', lightText: cs.color === tokenRgb('--sidebar-ink'),
          views: nav.querySelectorAll('[data-view]').length
        };
      })()`);
      assert.deepEqual(state, { visible: true, hidden: 'true', ground: true, goldEdge: true, buttonClear: true, lightText: true, views: 10 });
      assert.equal(await indicatorMatchesActive(), true);
    });

    await t.test('changing section slides the indicator and fades the new view in; same-view refresh does not', async () => {
      await evaluate(`(() => { document.querySelector('[data-view="stocks"]').click(); return true; })()`);
      const during = await evaluate(`(() => ({
        sliding: document.querySelector('.nav-indicator').getAnimations().some(a => a.transitionProperty === 'transform'),
        entering: document.querySelector('#main').getAnimations().length
      }))()`);
      assert.deepEqual(during, { sliding: true, entering: 1 });
      await until(OWNER_READY);
      await sleep(350);
      assert.equal(await indicatorMatchesActive(), true);
      await evaluate(`(() => { document.querySelector('#refresh').click(); return true; })()`);
      await sleep(60);
      await until(OWNER_READY);
      assert.equal(await evaluate(`document.querySelector('#main').getAnimations().length`), 0, 'refresh of the same view does not replay the entrance');
    });

    await t.test('primary (gold) buttons lift with a glow on hover and press down; secondary buttons only press', async () => {
      await goTo('transaction');
      await sleep(300);
      await move({ x: 5, y: 5 });
      const gold = await evaluate(`(() => { const b = [...document.querySelectorAll('#main .button')].find(el => !el.matches('.secondary, .text, .danger') && el.offsetParent); b.id ||= 'gui-gold-probe'; return '#' + b.id; })()`);
      const point = await centre(gold);
      await move(point);
      // Poll instead of fixed sleeps: under full-suite load a frame can land late.
      await until(`getComputedStyle(document.querySelector(${JSON.stringify(gold)})).transform === 'matrix(1, 0, 0, 1, 0, -2)'`, 1500).catch(() => {});
      const hovered = await evaluate(`(() => { const cs = getComputedStyle(document.querySelector(${JSON.stringify(gold)})); return { transform: cs.transform, glow: cs.boxShadow !== 'none' }; })()`);
      assert.deepEqual(hovered, { transform: 'matrix(1, 0, 0, 1, 0, -2)', glow: true });
      await page('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      await until(`getComputedStyle(document.querySelector(${JSON.stringify(gold)})).transform === 'matrix(0.97, 0, 0, 0.97, 0, 0)'`, 1500).catch(() => {});
      assert.equal(await transformOf(gold), 'matrix(0.97, 0, 0, 0.97, 0, 0)');
      await move({ x: 5, y: 5 });
      await page('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 5, y: 5, button: 'left', clickCount: 1 });
      await sleep(200);
      const secondary = '#refresh';
      await move(await centre(secondary));
      await sleep(200);
      assert.equal(await transformOf(secondary), 'none', 'secondary buttons do not lift');
      await move({ x: 5, y: 5 });
    });

    await t.test('overview quick-action tiles rise on hover', async () => {
      await goTo('overview');
      await sleep(300);
      const point = await centre('.quick-action');
      await move(point);
      await sleep(250);
      const state = await evaluate(`(() => { const cs = getComputedStyle(document.querySelector('.quick-action')); return { transform: cs.transform, glow: cs.boxShadow !== 'none' }; })()`);
      assert.deepEqual(state, { transform: 'matrix(1, 0, 0, 1, 0, -2)', glow: true });
      await move({ x: 5, y: 5 });
      await sleep(200);
    });

    await t.test('information cards (hesap/stok) do not pretend to be clickable', async () => {
      await goTo('accounts');
      await sleep(300);
      const card = await evaluate(`Boolean(document.querySelector('.account-card'))`);
      if (card) {
        await move(await centre('.account-card'));
        await sleep(250);
        assert.equal(await transformOf('.account-card'), 'none');
        assert.equal(await evaluate(`getComputedStyle(document.querySelector('.account-card .numeric') || document.body).fontVariantNumeric`).then(v => v === 'tabular-nums' || v === 'normal'), true);
        await move({ x: 5, y: 5 });
      }
    });

    await t.test('focused fields keep the outline and gain a soft gold halo', async () => {
      const state = await evaluate(`(() => { const input = document.querySelector('#main input:not([type=hidden])'); input.focus(); const cs = getComputedStyle(input); return { outline: cs.outlineStyle, halo: cs.boxShadow !== 'none' }; })()`);
      assert.deepEqual(state, { outline: 'solid', halo: true });
    });

    await t.test('reduced motion: no lift, no press, no view entrance, indicator jumps', async () => {
      await evaluate(`window.DefterPrefs.setMotion('reduced') || true`);
      await goTo('transaction');
      assert.equal(await evaluate(`document.querySelector('#main').getAnimations().length`), 0);
      await sleep(100);
      const gold = await evaluate(`(() => { const b = [...document.querySelectorAll('#main .button')].find(el => !el.matches('.secondary, .text, .danger') && el.offsetParent); b.id ||= 'gui-gold-probe-2'; return '#' + b.id; })()`);
      await move(await centre(gold));
      await sleep(150);
      const lifted = await transformOf(gold);
      assert.ok(lifted === 'none' || lifted === 'matrix(1, 0, 0, 1, 0, 0)', `no lift: ${lifted}`);
      await move({ x: 5, y: 5 });
      await evaluate(`(() => { document.querySelector('[data-view="banks"]').click(); return true; })()`);
      assert.equal(await evaluate(`document.querySelector('.nav-indicator').getAnimations().length`), 0);
      await until(OWNER_READY);
      assert.equal(await indicatorMatchesActive(), true);
      await evaluate(`window.DefterPrefs.setMotion('full') || true`);
    });

    await t.test('collapsed sidebar and phone strip: indicator follows the collapse; the phone strip keeps its own highlight', async () => {
      await evaluate(`(() => { document.querySelector('#sidebar-collapse').click(); return true; })()`);
      await sleep(450);
      assert.equal(await indicatorMatchesActive(), true, 'collapsed sidebar');
      await evaluate(`(() => { document.querySelector('#sidebar-collapse').click(); return true; })()`);
      await sleep(450);
      await viewport({ width: 390, height: 844, mobile: true });
      await sleep(300);
      const phone = await evaluate(`(() => {
        const ind = document.querySelector('.nav-indicator');
        const active = document.querySelector('#navigation button.active');
        const tokenRgb = name => { const p = document.createElement('i'); p.style.color = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; };
        return { indicator: getComputedStyle(ind).display, activeOwnStyle: getComputedStyle(active).backgroundColor === tokenRgb('--sidebar-hover') };
      })()`);
      assert.deepEqual(phone, { indicator: 'none', activeOwnStyle: true });
      await viewport({ width: 1440, height: 900 });
    });

    assert.deepEqual(consoleErrors, [], 'no page errors');
  } finally {
    await gui.close();
  }
});
