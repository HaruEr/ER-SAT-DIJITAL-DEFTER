// GUI redesign Faz 11 — keyboard-only tour in a real browser (trusted CDP key events).
// Run: node --test qa-temp/gui-keyboard-smoke.mjs   (set CHROME_PATH if Chrome is not in a default location)
import test from 'node:test';
import assert from 'node:assert/strict';
import { startGuiSession, findChrome, sleep, OWNER_READY, OWNER_NAME } from '../test-support/gui-browser.mjs';

const skip = findChrome() ? false : 'Chrome not available (set CHROME_PATH)';
const KEYS = {
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ', unmodifiedText: ' ' },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  k: { key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75 }
};
// What the focused element looks like: identity plus whether a focus indicator is visible.
const FOCUS = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return { id: 'body', visible: false };
  const cs = getComputedStyle(el);
  const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
  const halo = cs.boxShadow !== 'none';
  const track = el.matches('.defter-switch input') ? getComputedStyle(el.nextElementSibling).outlineStyle !== 'none' : false;
  return {
    id: el.id || el.getAttribute('data-view') || el.getAttribute('aria-label') || el.className || el.tagName,
    visible: outline || halo || track,
    inDialog: Boolean(el.closest('dialog[open]')), inPopover: Boolean(el.closest('.defter-popover'))
  };
})()`;

test('Faz 11 keyboard-only tour in a real browser', { skip, timeout: 150000 }, async t => {
  const gui = await startGuiSession();
  const { base, page, evaluate, until, navigate, viewport, login, consoleErrors } = gui;
  const press = async (name, modifiers = 0) => {
    const k = KEYS[name];
    await page('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', modifiers, ...k });
    await page('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode });
  };
  const focus = () => evaluate(FOCUS);

  try {
    await viewport({ width: 1440, height: 900 });
    await login(OWNER_NAME);
    await navigate(`${base}/owner`, OWNER_READY);
    await evaluate(`(() => { window.DefterPrefs.setMotion('full'); document.activeElement?.blur(); window.scrollTo(0, 0); return true; })()`);

    await t.test('first Tab reaches the skip link, which becomes visible and jumps to the content', async () => {
      await press('Tab');
      const skipLink = await evaluate(`(() => { const a = document.activeElement; return { skip: a?.classList.contains('skip-link'), onScreen: a.getBoundingClientRect().top >= 0 }; })()`);
      assert.deepEqual(skipLink, { skip: true, onScreen: true });
      await press('Enter');
      await sleep(100);
      assert.equal(await evaluate(`document.activeElement?.id`), 'main');
    });

    await t.test('Tab walks the sidebar and the top bar; every stop shows a focus indicator', async () => {
      // Start the tour at the top of the document (the skip link), as a fresh page load would.
      await evaluate(`(() => { window.scrollTo(0, 0); document.querySelector('.skip-link').focus(); return true; })()`);
      const stops = [];
      for (let i = 0; i < 40; i++) {
        await press('Tab');
        const f = await focus();
        stops.push(f);
        if (f.id === 'settings-trigger') break;
      }
      const ids = stops.map(s => s.id);
      for (const expected of ['overview', 'transaction', 'stocks', 'backup', 'workspace', 'command-palette-trigger', 'refresh', 'theme-toggle', 'settings-trigger']) {
        assert.ok(ids.includes(expected), `${expected} reachable by Tab (${ids.join(', ')})`);
      }
      const invisible = stops.filter(s => !s.visible).map(s => s.id);
      assert.deepEqual(invisible, [], 'no focus stop without a visible indicator');
    });

    await t.test('settings by keyboard: Enter opens, Tab reaches the switches, Space toggles, Escape closes and returns focus', async () => {
      await evaluate(`(() => { document.querySelector('#settings-trigger').focus(); return true; })()`);
      await press('Enter');
      await sleep(250);
      assert.equal((await focus()).inPopover, true, 'focus moves into the flyout');
      await press('Tab');
      const sw = await focus();
      assert.equal(sw.id, 'setting-theme');
      assert.equal(sw.visible, true, 'switch shows its focus ring');
      await press('Space');
      assert.equal(await evaluate('document.documentElement.dataset.theme'), 'dark');
      await press('Space');
      assert.equal(await evaluate('document.documentElement.dataset.theme'), 'light');
      await press('Escape');
      await sleep(100);
      assert.deepEqual(await evaluate(`({ open: Boolean(document.querySelector('.defter-popover:not(.defter-ghost)')), focus: document.activeElement?.id })`), { open: false, focus: 'settings-trigger' });
    });

    await t.test('the moon/sun button works from the keyboard', async () => {
      await evaluate(`(() => { document.querySelector('#theme-toggle').focus(); return true; })()`);
      await press('Enter');
      assert.equal(await evaluate('document.documentElement.dataset.theme'), 'dark');
      await press('Space');
      assert.equal(await evaluate('document.documentElement.dataset.theme'), 'light');
    });

    await t.test('drawer: Enter opens it, Tab and Shift+Tab stay inside, Escape closes and returns focus', async () => {
      await evaluate(`(() => { document.querySelector('[data-view="transaction"]').click(); return true; })()`);
      await until(`${OWNER_READY} && document.querySelector('[data-create-party]')`);
      await evaluate(`(() => { document.querySelector('[data-create-party]').focus(); return true; })()`);
      await press('Enter');
      await until(`document.querySelector('dialog.defter-drawer[open]')`);
      const inside = [];
      for (let i = 0; i < 14; i++) { await press('Tab'); inside.push(await focus()); }
      for (let i = 0; i < 4; i++) { await press('Tab', 8); inside.push(await focus()); }
      assert.ok(inside.every(f => f.inDialog), 'focus never leaves the drawer');
      assert.ok(inside.every(f => f.visible), 'every focus stop in the drawer is visible');
      await press('Escape');
      await sleep(100);
      assert.deepEqual(await evaluate(`({ open: document.querySelectorAll('dialog[open]').length, back: document.activeElement?.matches('[data-create-party]') })`), { open: 0, back: true });
    });

    await t.test('Ctrl+K opens the command palette with focus in its search; Escape closes it', async () => {
      await press('k', 2);
      await until(`document.querySelector('dialog[data-command-palette][open]')`, 3000);
      assert.equal(await evaluate(`document.activeElement?.matches('[data-command-palette-input]')`), true);
      await press('Escape');
      await sleep(100);
      assert.equal(await evaluate(`Boolean(document.querySelector('dialog[data-command-palette][open]'))`), false);
    });

    assert.deepEqual(consoleErrors, [], 'no page errors');
  } finally {
    await gui.close();
  }
});
