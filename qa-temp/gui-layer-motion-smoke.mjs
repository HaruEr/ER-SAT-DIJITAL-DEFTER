// GUI redesign Faz 2 — real-browser checks for layer motion (headless Chrome, synthetic ledger).
// Run: node --test qa-temp/gui-layer-motion-smoke.mjs   (set CHROME_PATH if Chrome is not in a default location)
// Verifies the visual layer without changing the behavioural contract: dialogs still close and leave
// the DOM synchronously, focus returns to the trigger, and reduced motion removes every animation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startGuiSession, findChrome, sleep, OWNER_READY, OWNER_NAME } from '../test-support/gui-browser.mjs';

const skip = findChrome() ? false : 'Chrome not available (set CHROME_PATH)';

test('Faz 2 layer motion in a real browser', { skip, timeout: 120000 }, async t => {
  const gui = await startGuiSession();
  const { base, evaluate, until, navigate, viewport, login, closeLayers, consoleErrors } = gui;
  // Each case starts from a clean layer stack so one failure cannot cascade.
  const reset = () => evaluate(`(() => { let n = 0; while (window.DefterUI.closeTopLayer('reset') && n < 10) n++; window.DefterUI.closePopover(false); window.DefterUI.clearToasts(); window.DefterPrefs.setMotion('full'); return true; })()`).then(() => sleep(400));
  try {
    await viewport({ width: 1440, height: 900 });
    await login(OWNER_NAME);
    await navigate(`${base}/owner`, OWNER_READY);
    await evaluate(`(() => { window.DefterPrefs.setMotion('full'); document.querySelector('[data-view="transaction"]').click(); return true; })()`);
    await until(`${OWNER_READY} && document.querySelector('[data-create-party]')`);
    // Ghost copies live in shadow roots; this test helper looks inside them explicitly.
    await evaluate(`(() => { window.__ghosts = sel => [...document.querySelectorAll('.defter-ghost-host')].flatMap(h => [...h.shadowRoot.querySelectorAll(sel)]); return true; })()`);

    await t.test('drawer slides in on a glass surface and closes synchronously behind a ghost', async () => {
      const opened = await evaluate(`(() => {
        document.querySelector('[data-create-party]').click();
        const d = document.querySelector('dialog.defter-drawer[open]');
        const own = d.getAnimations().map(a => ({ name: a.animationName, duration: a.effect.getComputedTiming().duration }));
        const scrim = document.getAnimations().filter(a => a.effect?.pseudoElement === '::backdrop').map(a => a.animationName);
        const cs = getComputedStyle(d);
        // Input is never blocked by motion: the first field already has focus while the drawer slides in.
        const focusInside = d.contains(document.activeElement) && document.activeElement.matches('input, select');
        return { own, scrim, background: cs.backgroundColor, blur: cs.backdropFilter, focusInside };
      })()`);
      assert.deepEqual(opened.own.map(a => a.name), ['defter-drawer-in']);
      assert.equal(opened.own[0].duration, 250);
      assert.equal(opened.focusInside, true);
      assert.ok(opened.scrim.includes('defter-fade-in'), 'backdrop fades in');
      assert.match(opened.blur, /blur\(16px\)/);
      assert.match(opened.background, /color\(srgb .* \/ 0\.9\)|rgba\(.*, 0\.9\)/, `glass background: ${opened.background}`);

      await sleep(400);
      const closed = await evaluate(`(() => {
        const trigger = document.querySelector('[data-create-party]');
        document.querySelector('dialog.defter-drawer[open] .defter-dialog-close').click();
        const host = document.querySelector('.defter-ghost-host');
        const ghost = window.__ghosts('.defter-ghost.defter-drawer')[0];
        return {
          openDialogs: document.querySelectorAll('dialog[open]').length,
          dialogsInDom: document.querySelectorAll('dialog.defter-drawer').length,
          focusReturned: document.activeElement === trigger,
          ghost: Boolean(ghost),
          ghostIsDialog: ghost?.tagName === 'DIALOG',
          ghostHidden: host?.getAttribute('aria-hidden') === 'true' && host?.hasAttribute('inert'),
          // Nothing from the copy is reachable by document queries (app code or tests).
          leaked: document.querySelectorAll('.defter-drawer, .defter-ghost, #f-name, [name="name"]').length,
          ghostStyled: ghost ? getComputedStyle(ghost).display === 'flex' && getComputedStyle(ghost).backdropFilter.includes('blur') : false,
          ghostIds: ghost ? ghost.querySelectorAll('[id],[name]').length : -1,
          ghostAnimating: ghost ? ghost.getAnimations().length : 0,
          scrim: window.__ghosts('.defter-ghost-backdrop:not(.defter-ghost-backdrop--plain)').length === 1,
          layers: window.DefterUI.getLayerCount()
        };
      })()`);
      assert.deepEqual(closed, { openDialogs: 0, dialogsInDom: 0, focusReturned: true, ghost: true, ghostIsDialog: false, ghostHidden: true, leaked: 0, ghostStyled: true, ghostIds: 0, ghostAnimating: 1, scrim: true, layers: 0 });
      await sleep(450);
      assert.equal(await evaluate(`document.querySelectorAll('.defter-ghost-host').length`), 0, 'ghosts are removed after the exit');
    });

    await t.test('modal opens with a spring scale; nested layers keep a single blur', async () => {
      await reset();
      const state = await evaluate(`(() => {
        const ui = window.DefterUI;
        const first = ui.openModal({ title: 'Birinci', content: '<p>Bir</p>' });
        const firstAnim = first.dialog.getAnimations().map(a => [a.animationName, getComputedStyle(first.dialog).animationTimingFunction]);
        const second = ui.openDrawer({ title: 'İkinci', content: '<p>İki</p>' });
        const covered = getComputedStyle(first.dialog);
        const coveredScrim = getComputedStyle(first.dialog, '::backdrop');
        const top = getComputedStyle(second.dialog);
        return { firstAnim, coveredHidden: first.dialog.getAttribute('aria-hidden'), coveredBlur: covered.backdropFilter, coveredScrimBlur: coveredScrim.backdropFilter, topBlur: top.backdropFilter };
      })()`);
      assert.equal(state.firstAnim[0][0], 'defter-modal-in');
      assert.match(state.firstAnim[0][1], /cubic-bezier\(0\.34, 1\.32, 0\.64, 1\)/);
      assert.equal(state.coveredHidden, 'true');
      assert.equal(state.coveredBlur, 'none');
      assert.equal(state.coveredScrimBlur, 'none');
      assert.match(state.topBlur, /blur\(16px\)/);
      const afterTopClose = await evaluate(`(() => {
        window.DefterUI.closeTopLayer('test');
        return { layers: window.DefterUI.getLayerCount(), scrim: window.__ghosts('.defter-ghost-backdrop').length, ghost: window.__ghosts('.defter-ghost.defter-drawer').length };
      })()`);
      assert.deepEqual(afterTopClose, { layers: 1, scrim: 0, ghost: 1 }, 'no extra scrim while a layer remains below');
      await closeLayers();
    });

    await t.test('command palette: scale-in from the top, plain scrim on exit', async () => {
      await reset();
      const opened = await evaluate(`(() => {
        const trigger = document.querySelector('#command-palette-trigger');
        trigger.focus();
        trigger.click();
        const d = document.querySelector('dialog[data-command-palette][open]');
        return { anim: d.getAnimations().map(a => a.animationName), origin: getComputedStyle(d).transformOrigin };
      })()`);
      assert.deepEqual(opened.anim, ['defter-modal-in']);
      assert.match(opened.origin, /^\d+(\.\d+)?px 0px$/);
      await sleep(300);
      const closed = await evaluate(`(() => {
        const input = document.querySelector('dialog[data-command-palette][open] input');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        return {
          open: Boolean(document.querySelector('dialog[data-command-palette][open]')),
          ghost: window.__ghosts('.defter-ghost.defter-command-palette').length,
          plainScrim: window.__ghosts('.defter-ghost-backdrop--plain').length,
          leakedInput: document.querySelectorAll('[data-command-palette-input], [data-command-palette-list]').length,
          focus: document.activeElement?.id
        };
      })()`);
      assert.deepEqual(closed, { open: false, ghost: 1, plainScrim: 1, leakedInput: 0, focus: 'command-palette-trigger' });
      // Re-opening while the previous ghost is still fading finds the live input (regression: paket6b T1-F4-5).
      const reopened = await evaluate(`(() => {
        document.querySelector('#command-palette-trigger').click();
        const input = document.querySelector('[data-command-palette-input]');
        const result = { inputs: document.querySelectorAll('[data-command-palette-input]').length, focused: document.activeElement === input };
        window.DefterUI.closeTopLayer('test');
        return result;
      })()`);
      assert.deepEqual(reopened, { inputs: 1, focused: true });
      await sleep(450);
    });

    await t.test('popover flies out and fades away', async () => {
      await reset();
      const state = await evaluate(`(() => {
        const anchor = document.querySelector('#refresh');
        const handle = window.DefterUI.openPopover(anchor, { title: 'Bilgi', content: '<p>Deneme</p>' });
        const anim = handle.element.getAnimations().map(a => a.animationName);
        handle.close();
        return { anim, stillThere: Boolean(document.querySelector('.defter-popover:not(.defter-ghost)')), ghost: window.__ghosts('.defter-popover.defter-ghost').length };
      })()`);
      assert.deepEqual(state, { anim: ['defter-flyout-in'], stillThere: false, ghost: 1 });
      await sleep(400);
    });

    await t.test('toasts stack bottom-right with a timer bar and glide when one leaves', async () => {
      await reset();
      const state = await evaluate(`(() => {
        const ui = window.DefterUI;
        ui.clearToasts();
        const a = ui.toast('Birinci bildirim', { durationMs: 5000 });
        const b = ui.toast('İkinci bildirim', { durationMs: 5000 });
        const region = document.getElementById('defter-toast-region').getBoundingClientRect();
        const bar = a.element.querySelector('.defter-toast-progress');
        const barAnim = bar.getAnimations()[0];
        const entry = a.element.getAnimations().map(x => x.animationName);
        const text = document.getElementById('defter-toast-region').textContent;
        // The stack is anchored at the bottom: when the lower (newer) toast leaves, the one above glides down.
        b.element.querySelector('.defter-toast-close').click();
        const glide = a.element.getAnimations().filter(x => !('animationName' in x)).length;
        return {
          rightGap: Math.round(innerWidth - region.right), bottomGap: Math.round(innerHeight - region.bottom),
          bar: barAnim?.animationName, barMs: barAnim?.effect.getComputedTiming().duration,
          barHidden: bar.getAttribute('aria-hidden'), entry, text,
          removed: !b.element.isConnected, ghost: window.__ghosts('.defter-toast.defter-ghost').length, glide
        };
      })()`);
      assert.equal(state.rightGap, 24);
      assert.equal(state.bottomGap, 24);
      assert.equal(state.bar, 'defter-toast-time');
      assert.equal(state.barMs, 5000);
      assert.equal(state.barHidden, 'true');
      assert.deepEqual(state.entry, ['defter-toast-in']);
      assert.equal(state.text, 'Birinci bildirim×İkinci bildirim×', 'timer bar adds no text');
      assert.equal(state.removed, true);
      assert.equal(state.ghost, 1);
      assert.equal(state.glide, 1, 'remaining toast glides into place');
      await evaluate('window.DefterUI.clearToasts() || true');
      await sleep(400);
    });

    await t.test('"Animasyonları azalt" removes every animation and ghost', async () => {
      await reset();
      const state = await evaluate(`(() => {
        window.DefterPrefs.setMotion('reduced');
        const ui = window.DefterUI;
        const modal = ui.openModal({ title: 'Sade', content: '<p>Sade</p>' });
        const modalAnims = modal.dialog.getAnimations().length;
        modal.close();
        const t = ui.toast('Sade bildirim', { durationMs: 5000 });
        const toastAnims = t.element.getAnimations().length;
        const barShown = getComputedStyle(t.element.querySelector('.defter-toast-progress')).display !== 'none';
        t.dismiss();
        const ghosts = document.querySelectorAll('.defter-ghost-host').length;
        window.DefterPrefs.setMotion('full');
        return { modalAnims, toastAnims, barShown, ghosts, open: document.querySelectorAll('dialog[open]').length };
      })()`);
      assert.deepEqual(state, { modalAnims: 0, toastAnims: 0, barShown: false, ghosts: 0, open: 0 });
    });

    await t.test('phone width: toasts span the bottom edge and rise from below', async () => {
      await reset();
      await viewport({ width: 390, height: 844, mobile: true });
      await sleep(200);
      const state = await evaluate(`(() => {
        const t = window.DefterUI.toast('Telefon bildirimi', { durationMs: 5000 });
        const r = document.getElementById('defter-toast-region').getBoundingClientRect();
        const anim = t.element.getAnimations().map(a => a.animationName);
        t.dismiss();
        return { left: Math.round(r.left), right: Math.round(innerWidth - r.right), bottom: Math.round(innerHeight - r.bottom), anim };
      })()`);
      assert.deepEqual(state, { left: 12, right: 12, bottom: 12, anim: ['defter-toast-up'] });
    });

    assert.deepEqual(consoleErrors, [], 'no page errors');
  } finally {
    await gui.close();
  }
});
