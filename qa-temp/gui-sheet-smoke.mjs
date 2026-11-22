// GUI redesign Faz 3 — bottom sheet at phone width, driven by real CDP touch events.
// Run: node --test qa-temp/gui-sheet-smoke.mjs   (set CHROME_PATH if Chrome is not in a default location)
import test from 'node:test';
import assert from 'node:assert/strict';
import { startGuiSession, findChrome, sleep, OWNER_READY, OWNER_NAME } from '../test-support/gui-browser.mjs';

const skip = findChrome() ? false : 'Chrome not available (set CHROME_PATH)';
const PHONE = { width: 390, height: 844, mobile: true };

test('Faz 3 bottom sheet in a real browser', { skip, timeout: 120000 }, async t => {
  const gui = await startGuiSession();
  const { base, page, evaluate, until, navigate, viewport, login, consoleErrors } = gui;

  // A finger: touchStart at `from`, `steps` moves to `to` with `gapMs` between them, touchEnd.
  async function swipe({ from, to, steps = 6, gapMs = 0 }) {
    await page('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
    for (let i = 1; i <= steps; i++) {
      if (gapMs) await sleep(gapMs);
      const y = from.y + ((to.y - from.y) * i) / steps;
      await page('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x, y }] });
    }
    if (gapMs) await sleep(gapMs);
    await page('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  // Opens the sheet and returns finger positions measured after the opening slide has finished.
  const openSheet = () => evaluate(`(async () => {
    window.DefterUI.closeTopLayer('reset');
    const trigger = document.querySelector('[data-create-party]');
    trigger.focus();
    trigger.click();
    const d = document.querySelector('dialog.defter-drawer[open]');
    await Promise.allSettled(d.getAnimations().map(a => a.finished));
    const head = d.querySelector('.defter-dialog-head').getBoundingClientRect();
    const body = d.querySelector('.defter-dialog-body').getBoundingClientRect();
    return { head: { x: head.left + head.width / 3, y: head.top + 14 }, body: { x: body.left + body.width / 2, y: body.top + 40 } };
  })()`);
  const sheetState = () => evaluate(`(() => {
    const d = document.querySelector('dialog.defter-drawer[open]');
    return d ? { open: true, inline: d.style.transform, moving: d.getAnimations().length } : { open: false, focus: document.activeElement?.matches('[data-create-party]') || false };
  })()`);

  try {
    await viewport(PHONE);
    await login(OWNER_NAME);
    await navigate(`${base}/owner`, OWNER_READY);
    await evaluate(`(() => { window.DefterPrefs.setMotion('full'); document.querySelector('[data-view="transaction"]').click(); return true; })()`);
    await until(`${OWNER_READY} && document.querySelector('[data-create-party]')`);
    await evaluate(`(() => { window.__ghosts = sel => [...document.querySelectorAll('.defter-ghost-host')].flatMap(h => [...h.shadowRoot.querySelectorAll(sel)]); return true; })()`);

    await t.test('drawer becomes a bottom sheet: rises from the bottom edge with a grab handle', async () => {
      const state = await evaluate(`(async () => {
        document.querySelector('[data-create-party]').click();
        const d = document.querySelector('dialog.defter-drawer[open]');
        const anim = d.getAnimations().map(a => a.animationName);
        await Promise.allSettled(d.getAnimations().map(a => a.finished));
        const r = d.getBoundingClientRect();
        const cs = getComputedStyle(d);
        const head = d.querySelector('.defter-dialog-head');
        const handle = getComputedStyle(head, '::before');
        return {
          anim,
          bottomGap: Math.round(innerHeight - r.bottom), full: Math.round(r.width) === innerWidth,
          contentSized: r.height < innerHeight * 0.92 + 1,
          radius: cs.borderTopLeftRadius, flatBottom: cs.borderBottomLeftRadius,
          touchAction: getComputedStyle(head).touchAction, handle: handle.content !== 'none' && handle.width === '44px'
        };
      })()`);
      assert.deepEqual(state, { anim: ['defter-sheet-in'], bottomGap: 0, full: true, contentSized: true, radius: '20px', flatBottom: '0px', touchAction: 'none', handle: true });
      await sleep(400);
    });

    await t.test('a short sheet fits its content instead of filling the screen', async () => {
      const state = await evaluate(`(async () => {
        window.DefterUI.closeTopLayer('reset');
        const layer = window.DefterUI.openDrawer({ title: 'Kısa', content: '<p>Tek satır içerik.</p>' });
        await Promise.allSettled(layer.dialog.getAnimations().map(a => a.finished));
        const r = layer.dialog.getBoundingClientRect();
        const result = { bottomGap: Math.round(innerHeight - r.bottom), short: r.height < 260, height: Math.round(r.height) };
        layer.close();
        return result;
      })()`);
      assert.equal(state.bottomGap, 0);
      assert.ok(state.short, `sheet height ${state.height}px should fit one line of content`);
      await sleep(400);
    });

    await t.test('a short, slow pull follows the finger and springs back', async () => {
      const points = await openSheet();
      await page('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [points.head] });
      for (const dy of [10, 20, 30, 40, 50]) {
        await sleep(60);
        await page('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: points.head.x, y: points.head.y + dy }] });
      }
      await sleep(60); // let the last touchMove reach the page
      const during = await sheetState();
      await sleep(60);
      await page('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); // always lift the finger before asserting
      assert.equal(during.inline, 'translateY(50px)', 'sheet tracks the finger');
      const after = await sheetState();
      assert.deepEqual(after, { open: true, inline: '', moving: 1 }, 'released below the threshold: stays open and springs back');
      await sleep(400);
      assert.deepEqual(await sheetState(), { open: true, inline: '', moving: 0 });
    });

    await t.test('pulling past 30% of the height closes it; focus returns; the exit starts where the finger let go', async () => {
      const points = await openSheet();
      const height = await evaluate(`document.querySelector('dialog.defter-drawer[open]').getBoundingClientRect().height`);
      await swipe({ from: points.head, to: { x: points.head.x, y: points.head.y + height * 0.45 }, steps: 8, gapMs: 60 });
      const state = await evaluate(`(() => {
        const ghost = window.__ghosts('.defter-ghost--sheet')[0];
        return { open: Boolean(document.querySelector('dialog[open]')), focus: document.activeElement?.matches('[data-create-party]'), ghost: Boolean(ghost), ghostTop: ghost ? Math.round(ghost.getBoundingClientRect().top) : null, layers: window.DefterUI.getLayerCount() };
      })()`);
      assert.equal(state.open, false);
      assert.equal(state.focus, true);
      assert.equal(state.layers, 0);
      assert.equal(state.ghost, true);
      assert.ok(state.ghostTop > 844 - height + height * 0.3, `ghost starts lower than the resting sheet (top=${state.ghostTop})`);
      await sleep(400);
    });

    await t.test('a quick downward flick closes even a short pull', async () => {
      const points = await openSheet();
      await swipe({ from: points.head, to: { x: points.head.x, y: points.head.y + 60 }, steps: 3, gapMs: 0 });
      assert.equal((await sheetState()).open, false);
      await sleep(400);
    });

    await t.test('dragging the content (not the header) never moves the sheet', async () => {
      const points = await openSheet();
      await swipe({ from: points.body, to: { x: points.body.x, y: points.body.y + 200 }, steps: 6, gapMs: 30 });
      const state = await sheetState();
      assert.equal(state.open, true);
      assert.equal(state.inline, '');
    });

    await t.test('Escape and the close button still close the sheet', async () => {
      let state = await evaluate(`(() => { document.querySelector('dialog.defter-drawer[open]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return { open: Boolean(document.querySelector('dialog[open]')) }; })()`);
      assert.deepEqual(state, { open: false });
      await sleep(400);
      await openSheet();
      state = await evaluate(`(() => { document.querySelector('dialog.defter-drawer[open] .defter-dialog-close').click(); return { open: Boolean(document.querySelector('dialog[open]')) }; })()`);
      assert.deepEqual(state, { open: false });
      await sleep(400);
    });

    await t.test('at desktop width the drawer stays a side panel and ignores drags', async () => {
      await viewport({ width: 1440, height: 900 });
      await sleep(200);
      const points = await openSheet();
      const shape = await evaluate(`(() => { const d = document.querySelector('dialog.defter-drawer[open]'); const r = d.getBoundingClientRect(); return { right: Math.round(innerWidth - r.right), fullHeight: Math.round(r.height) === innerHeight }; })()`);
      assert.deepEqual(shape, { right: 0, fullHeight: true });
      await swipe({ from: points.head, to: { x: points.head.x, y: points.head.y + 400 }, steps: 3, gapMs: 0 });
      const state = await sheetState();
      assert.equal(state.open, true);
      assert.equal(state.inline, '');
      await evaluate(`window.DefterUI.closeTopLayer('reset') || true`);
      await viewport(PHONE);
      await sleep(400);
    });

    await t.test('reduced motion: dragging still works, without the spring or exit animation', async () => {
      await evaluate(`window.DefterPrefs.setMotion('reduced') || true`);
      const points = await openSheet();
      const opening = await evaluate(`document.querySelector('dialog.defter-drawer[open]').getAnimations().length`);
      await swipe({ from: points.head, to: { x: points.head.x, y: points.head.y + 40 }, steps: 4, gapMs: 60 });
      await sleep(120);
      const back = await sheetState();
      await swipe({ from: points.head, to: { x: points.head.x, y: points.head.y + 500 }, steps: 8, gapMs: 40 });
      const closed = await evaluate(`({ open: Boolean(document.querySelector('dialog[open]')), ghosts: document.querySelectorAll('.defter-ghost-host').length })`);
      await evaluate(`window.DefterPrefs.setMotion('full') || true`);
      assert.equal(opening, 0);
      assert.deepEqual(back, { open: true, inline: '', moving: 0 });
      assert.deepEqual(closed, { open: false, ghosts: 0 });
    });

    assert.deepEqual(consoleErrors, [], 'no page errors');
  } finally {
    await gui.close();
  }
});
