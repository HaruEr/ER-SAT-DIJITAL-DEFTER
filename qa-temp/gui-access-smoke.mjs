// GUI redesign Faz 8 — sign-in page and employee accounts in a real browser.
// Run: node --test qa-temp/gui-access-smoke.mjs   (set CHROME_PATH if Chrome is not in a default location)
import test from 'node:test';
import assert from 'node:assert/strict';
import { startGuiSession, findChrome, sleep, OWNER_READY, LOGIN_READY, CHECKOUT_READY, OWNER_NAME, EMPLOYEE_NAME } from '../test-support/gui-browser.mjs';

const skip = findChrome() ? false : 'Chrome not available (set CHROME_PATH)';

test('Faz 8 sign-in and employee accounts in a real browser', { skip, timeout: 150000 }, async t => {
  const gui = await startGuiSession();
  const { base, page, evaluate, until, navigate, viewport, login, logout, consoleErrors, fixture } = gui;
  const click = async selector => {
    const p = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: 'center', behavior: 'instant' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await page('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    await page('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await page('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  };

  try {
    await viewport({ width: 1440, height: 900 });

    await t.test('sign-in: card fits its content, rises in on glass, gold light drifts behind it', async () => {
      await navigate(`${base}/`, LOGIN_READY);
      const state = await evaluate(`(() => {
        const card = document.querySelector('main.access-card');
        const content = [...card.children].reduce((sum, el) => sum + el.getBoundingClientRect().height, 0);
        const cs = getComputedStyle(card);
        const bg = document.getAnimations().filter(a => a.effect?.pseudoElement === '::before').map(a => a.animationName);
        // The light layer (z-index -1) must sit inside the body's stacking context, above its --paper ground.
        const layerVisible = getComputedStyle(document.body).isolation === 'isolate' && getComputedStyle(document.body, '::before').zIndex === '-1';
        return { fits: card.getBoundingClientRect().height < content + 160, glass: cs.backdropFilter.includes('blur'), drift: bg, minHeight: cs.minHeight, layerVisible };
      })()`);
      assert.deepEqual(state, { fits: true, glass: true, drift: ['defter-bg-drift'], minHeight: '0px', layerVisible: true });
    });

    await t.test('sign-in behaviour is unchanged: wrong PIN clears the field and shows the error', async () => {
      await evaluate(`(() => { document.querySelector('#user').value = ${JSON.stringify(OWNER_NAME)}; document.querySelector('#password').value = '000000'; document.querySelector('#login').requestSubmit(); return true; })()`);
      await until(`document.querySelector('#feedback').textContent.length > 0`, 5000);
      const state = await evaluate(`({ password: document.querySelector('#password').value, path: location.pathname, feedback: document.querySelector('#feedback').getAttribute('role') })`);
      assert.deepEqual(state, { password: '', path: '/', feedback: 'alert' });
    });

    await t.test('the post-restore message still appears once', async () => {
      await evaluate(`(() => { sessionStorage.setItem('defter-restore-complete', '1'); return true; })()`);
      await navigate(`${base}/`, LOGIN_READY);
      const state = await evaluate(`({ text: document.querySelector('#feedback').textContent, flag: sessionStorage.getItem('defter-restore-complete') })`);
      assert.deepEqual(state, { text: 'Yedek doğrulanarak geri yüklendi. Devam etmek için yeniden giriş yapın.', flag: null });
    });

    await t.test('reduced motion: no card entrance and no drifting background', async () => {
      await evaluate(`(() => { localStorage.setItem('defter-motion', 'reduced'); return true; })()`);
      await navigate(`${base}/`, LOGIN_READY);
      assert.equal(await evaluate(`document.getAnimations().length`), 0);
      await evaluate(`(() => { localStorage.removeItem('defter-motion'); return true; })()`);
    });

    await t.test('users: employees are cards with initials and their own action; the select form is backed, not shown', async () => {
      await login(OWNER_NAME);
      await navigate(`${base}/users`, `document.querySelector('.employee-card, .employee-empty')`);
      const state = await evaluate(`(() => {
        const cards = [...document.querySelectorAll('.employee-card')];
        return {
          names: cards.map(c => c.querySelector('strong').textContent),
          initials: cards.map(c => c.querySelector('.employee-avatar').textContent),
          action: cards[0]?.querySelector('button[aria-label*="erişimi kapat"]')?.getAttribute('aria-label'),
          formShown: getComputedStyle(document.querySelector('#disable')).display !== 'none',
          formInPage: Boolean(document.querySelector('#disable select option')),
          cardFits: document.querySelector('main.access-card').getBoundingClientRect().height < 900
        };
      })()`);
      assert.deepEqual(state, { names: [EMPLOYEE_NAME], initials: ['UÇ'], action: `${EMPLOYEE_NAME} için erişimi kapat`, formShown: false, formInPage: true, cardFits: true });
    });

    await t.test('adding an employee shows a new card that rises in, plus the success toast', async () => {
      await evaluate(`(() => {
        const f = document.querySelector('#employee');
        f.querySelector('[name="name"]').value = 'Deneme Kasiyer';
        f.querySelector('[name="pin"]').value = '654321';
        f.querySelector('[name="pinConfirm"]').value = '654321';
        f.requestSubmit();
        return true;
      })()`);
      await until(`[...document.querySelectorAll('.employee-card strong')].some(s => s.textContent === 'Deneme Kasiyer')`, 8000);
      const state = await evaluate(`(() => {
        const card = [...document.querySelectorAll('.employee-card')].find(c => c.querySelector('strong').textContent === 'Deneme Kasiyer');
        return { isNew: card.classList.contains('is-new'), others: [...document.querySelectorAll('.employee-card.is-new')].length, toast: document.getElementById('defter-toast-region')?.textContent.includes('Çalışan hesabı oluşturuldu') };
      })()`);
      assert.deepEqual(state, { isNew: true, others: 1, toast: true });
    });

    await t.test('"Erişimi kapat" on a card opens the critical confirmation; confirming removes only that card', async () => {
      await sleep(400);
      const selector = `.employee-card[data-employee-id] button[aria-label="Deneme Kasiyer için erişimi kapat"]`;
      await click(selector);
      await sleep(50);
      const dialog = await evaluate(`(() => { const d = document.querySelector('dialog[data-critical-modal][open]'); return { open: Boolean(d), title: d?.querySelector('h2').textContent, danger: d?.classList.contains('defter-dialog--danger'), selected: document.querySelector('#disable select').selectedOptions[0]?.textContent }; })()`);
      assert.deepEqual(dialog, { open: true, title: 'Çalışan erişimini kapat', danger: true, selected: 'Deneme Kasiyer' });
      await sleep(350); // arming window (Faz 4)
      await click('dialog[data-critical-modal][open] button[type="submit"]');
      await until(`![...document.querySelectorAll('.employee-card strong')].some(s => s.textContent === 'Deneme Kasiyer')`, 8000);
      const after = await evaluate(`({ names: [...document.querySelectorAll('.employee-card strong')].map(s => s.textContent), toast: document.getElementById('defter-toast-region')?.textContent.includes('erişimi kapatıldı') })`);
      assert.deepEqual(after, { names: [EMPLOYEE_NAME], toast: true });
    });

    await t.test('the disabled employee can no longer sign in (same server rule)', async () => {
      const result = await evaluate(`(async () => {
        const session = JSON.parse(sessionStorage.getItem('defter-session'));
        const users = await (await fetch('/api/auth/users', { headers: { Authorization: 'Bearer ' + session.token } })).json();
        return users.users.map(u => u.name);
      })()`);
      assert.equal(result.includes('Deneme Kasiyer'), false);
      await logout();
    });

    await t.test('checkout card is untouched by the sign-in page rules', async () => {
      await login(EMPLOYEE_NAME);
      await navigate(`${base}/checkout`, CHECKOUT_READY);
      const state = await evaluate(`(() => { const main = document.querySelector('main.checkout-card'); return { anim: main.getAnimations().length, bg: document.getAnimations().filter(a => a.effect?.pseudoElement === '::before').length }; })()`);
      assert.deepEqual(state, { anim: 0, bg: 0 });
    });

    assert.deepEqual(consoleErrors, [], 'no page errors');
  } finally {
    await gui.close();
  }
});
