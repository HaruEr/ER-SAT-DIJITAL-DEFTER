// GUI redesign Faz 5 — guided steps and the first-run setup wizard in a real browser.
// Run: node --test qa-temp/gui-steps-smoke.mjs   (set CHROME_PATH if Chrome is not in a default location)
import test from 'node:test';
import assert from 'node:assert/strict';
import { startGuiSession, findChrome, sleep, OWNER_READY, CHECKOUT_READY, LOGIN_READY, OWNER_NAME, EMPLOYEE_NAME } from '../test-support/gui-browser.mjs';

const skip = findChrome() ? false : 'Chrome not available (set CHROME_PATH)';

test('Faz 5 guided steps in a real browser', { skip, timeout: 120000 }, async t => {
  const gui = await startGuiSession();
  const { base, evaluate, until, navigate, viewport, login, logout, consoleErrors } = gui;
  const stepState = () => evaluate(`(() => {
    const f = document.querySelector('#sale-form');
    const bar = f.querySelector('.stepper-bar');
    const fill = bar.querySelector('.stepper-progress i');
    return {
      step: f.querySelector('[data-step-panel].is-active')?.dataset.stepPanel,
      meta: bar.querySelector('.stepper-meta')?.textContent,
      progress: Number(bar.style.getPropertyValue('--step-progress')).toFixed(3),
      tabs: bar.querySelectorAll('[data-step-target]').length,
      current: bar.querySelector('[aria-current="step"]')?.dataset.stepTarget
    };
  })()`);
  const panelSlide = n => evaluate(`(() => {
    const p = document.querySelector('#sale-form [data-step-panel="${n}"]');
    return p.getAnimations().map(a => a.effect.getKeyframes()[0].transform);
  })()`);

  try {
    await viewport({ width: 1440, height: 900 });
    await login(OWNER_NAME);
    await navigate(`${base}/owner`, OWNER_READY);
    await evaluate(`(() => { window.DefterPrefs.setMotion('full'); document.querySelector('[data-view="transaction"]').click(); return true; })()`);
    await until(`${OWNER_READY} && document.querySelector('#sale-form [data-flow-toggle]')`);

    await t.test('guided mode shows "Adım 1 / 3" and a third of the progress line; the meta row is hidden from assistive tech', async () => {
      await evaluate(`(() => { document.querySelector('#sale-form [data-flow-toggle]').click(); return true; })()`);
      await sleep(100);
      assert.deepEqual(await stepState(), { step: '1', meta: 'Adım 1 / 3', progress: '0.333', tabs: 3, current: '1' });
      const a11y = await evaluate(`(() => { const m = document.querySelector('#sale-form .stepper-meta'); return { hidden: m.getAttribute('aria-hidden'), first: m === m.parentElement.firstElementChild }; })()`);
      assert.deepEqual(a11y, { hidden: 'true', first: true });
    });

    await t.test('step validation is unchanged: an empty product row cannot move forward', async () => {
      await evaluate(`(() => { document.querySelector('#sale-form [data-step-target="2"]').click(); return true; })()`);
      await sleep(100);
      assert.equal((await stepState()).step, '1');
    });

    await t.test('moving forward slides the new panel in from the right and fills two thirds', async () => {
      await evaluate(`(() => {
        const f = document.querySelector('#sale-form');
        const set = (sel, v) => { const e = f.querySelector(sel); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };
        set('[data-item-field="accountId"]', 'ceyrek'); set('[data-item-field="quantity"]', '1'); set('[data-item-field="value"]', '5200');
        return true;
      })()`);
      await sleep(100);
      await evaluate(`(() => { document.querySelector('#sale-form [data-step-target="2"]').click(); return true; })()`);
      await sleep(30);
      assert.deepEqual(await panelSlide(2), ['translateX(16px)']);
      assert.deepEqual(await stepState(), { step: '2', meta: 'Adım 2 / 3', progress: '0.667', tabs: 3, current: '2' });
      await sleep(300);
    });

    await t.test('moving back slides the panel in from the left', async () => {
      await evaluate(`(() => { document.querySelector('#sale-form [data-step-target="1"]').click(); return true; })()`);
      await sleep(30);
      assert.deepEqual(await panelSlide(1), ['translateX(-16px)']);
      assert.equal((await stepState()).meta, 'Adım 1 / 3');
      await sleep(300);
    });

    await t.test('reduced motion: the count and progress still update, the panel does not slide', async () => {
      await evaluate(`window.DefterPrefs.setMotion('reduced') || true`);
      await evaluate(`(() => { document.querySelector('#sale-form [data-step-target="2"]').click(); return true; })()`);
      await sleep(30);
      assert.deepEqual(await panelSlide(2), []);
      assert.equal((await stepState()).meta, 'Adım 2 / 3');
      await evaluate(`window.DefterPrefs.setMotion('full') || true`);
    });

    await t.test('quick mode hides the whole stepper (meta included)', async () => {
      await evaluate(`(() => { document.querySelector('#sale-form [data-flow-toggle]').click(); return true; })()`);
      await sleep(100);
      const state = await evaluate(`(() => { const f = document.querySelector('#sale-form'); const bar = f.querySelector('.stepper-bar'); return { mode: f.dataset.flowMode, hidden: bar.hidden, visible: bar.querySelector('.stepper-meta').getClientRects().length > 0 }; })()`);
      assert.equal(state.mode, 'quick', 'single simple product returns to quick mode');
      assert.equal(state.hidden, true);
      assert.equal(state.visible, false);
    });

    await t.test('the employee checkout stepper gets the same count and progress line', async () => {
      await logout();
      await login(EMPLOYEE_NAME);
      await navigate(`${base}/checkout`, CHECKOUT_READY);
      await evaluate(`(() => { document.querySelector('button[data-flow-mode="guided"]').click(); return true; })()`);
      await sleep(100);
      const state = await evaluate(`(() => { const bar = document.querySelector('#trade .stepper-bar'); return { hidden: bar.hidden, meta: bar.querySelector('.stepper-meta')?.textContent, progress: Number(bar.style.getPropertyValue('--step-progress')).toFixed(3) }; })()`);
      assert.deepEqual(state, { hidden: false, meta: 'Adım 1 / 3', progress: '0.333' });
      await logout();
    });

    await t.test('normal sign-in is untouched: no wizard, no minimum length, password and submit visible', async () => {
      await navigate(`${base}/`, LOGIN_READY);
      const state = await evaluate(`(() => ({
        wizard: Boolean(document.querySelector('.setup-progress, #setup-next, .password-meter')),
        passwordVisible: !document.querySelector('#password').closest('label').hidden,
        submitVisible: !document.querySelector('#submit').hidden,
        minlength: document.querySelector('#password').getAttribute('minlength'),
        heading: document.querySelector('#heading').textContent
      }))()`);
      assert.deepEqual(state, { wizard: false, passwordVisible: true, submitVisible: true, minlength: null, heading: 'Oturum aç' });
    });

    assert.deepEqual(consoleErrors, [], 'no page errors');
  } finally {
    await gui.close();
  }
});

test('Faz 5 first-run setup wizard in a real browser', { skip, timeout: 120000 }, async t => {
  const gui = await startGuiSession({ empty: true });
  const { base, page, evaluate, until, navigate, viewport, consoleErrors } = gui;
  const typeInto = async (selector, text) => {
    await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.select?.(); return true; })()`);
    await page('Input.insertText', { text });
  };
  const pressEnter = async () => {
    await page('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
    await page('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  };
  const wizardState = () => evaluate(`(() => {
    const vis = sel => { const el = document.querySelector(sel); return Boolean(el) && !el.hidden && !el.closest('[hidden]'); };
    return {
      step: document.querySelector('#login').dataset.setupStep,
      count: document.querySelector('.setup-count')?.textContent,
      name: vis('#name'), next: vis('#setup-next'), password: vis('#password'), back: vis('#setup-back'), submit: vis('#submit'),
      focus: document.activeElement?.id
    };
  })()`);

  try {
    await viewport({ width: 1440, height: 900 });
    await navigate(`${base}/`, LOGIN_READY);

    await t.test('step 1 asks only for the owner name', async () => {
      assert.equal(await evaluate(`document.querySelector('#heading').textContent`), 'İşletme sahibi hesabını oluştur');
      assert.deepEqual(await wizardState(), { step: '1', count: 'Adım 1 / 2 · İşletme sahibi', name: true, next: true, password: false, back: false, submit: false, focus: 'name' });
    });

    await t.test('"Devam et" with an empty name stays on step 1', async () => {
      await evaluate(`(() => { document.querySelector('#setup-next').click(); return true; })()`);
      await sleep(50);
      assert.equal((await wizardState()).step, '1');
    });

    await t.test('Enter in the name field moves to the password step and slides it in', async () => {
      await typeInto('#name', 'Deneme Kuyumcu');
      await pressEnter();
      await sleep(30);
      const state = await wizardState();
      assert.deepEqual(state, { step: '2', count: 'Adım 2 / 2 · Yönetici PIN', name: false, next: false, password: true, back: true, submit: true, focus: 'password' });
      const anim = await evaluate(`[...document.querySelectorAll('#login > *')].flatMap(el => el.getAnimations()).map(a => a.animationName)`);
      assert.ok(anim.includes('defter-step-forward'), `forward slide: ${anim}`);
      assert.equal(await evaluate(`document.querySelector('#password').getAttribute('aria-describedby')`), 'password-count');
    });

    await t.test('the PIN meter counts toward 6 digits', async () => {
      await typeInto('#password', '1234');
      let meter = await evaluate(`({ text: document.querySelector('#password-count').textContent, done: document.querySelector('.password-meter').classList.contains('is-complete') })`);
      assert.deepEqual(meter, { text: '4 / 6 hane', done: false });
      await page('Input.insertText', { text: '56' });
      meter = await evaluate(`({ text: document.querySelector('#password-count').textContent, done: document.querySelector('.password-meter').classList.contains('is-complete'), valid: document.querySelector('#password').validity.valid })`);
      assert.deepEqual(meter, { text: '6 / 6 hane · hazır', done: true, valid: true });
    });

    await t.test('"Geri" returns to the name step with the name kept, sliding from the left', async () => {
      await evaluate(`(() => { document.querySelector('#setup-back').click(); return true; })()`);
      await sleep(30);
      const state = await wizardState();
      assert.equal(state.step, '1');
      assert.equal(state.focus, 'name');
      assert.equal(await evaluate(`document.querySelector('#name').value`), 'Deneme Kuyumcu');
      const anim = await evaluate(`[...document.querySelectorAll('#login > *')].flatMap(el => el.getAnimations()).map(a => a.animationName)`);
      assert.ok(anim.includes('defter-step-back'), `back slide: ${anim}`);
    });

    await t.test('an already-filled password (password manager) submits straight from step 1', async () => {
      const call = await evaluate(`(async () => {
        const realFetch = window.fetch;
        let seen = null;
        window.fetch = (url, options) => {
          if (String(url).includes('/api/auth/setup')) { seen = JSON.parse(options.body); return Promise.resolve(new Response(JSON.stringify({ error: 'test engeli' }), { status: 400, headers: { 'Content-Type': 'application/json' } })); }
          return realFetch(url, options);
        };
        document.querySelector('#name').focus();
        return true;
      })()`);
      assert.equal(call, true);
      await pressEnter(); // password already holds 23 characters from the previous step
      await until(`document.querySelector('#feedback').textContent.length > 0`, 5000);
      const seen = await evaluate(`document.querySelector('#feedback').textContent`);
      assert.match(seen, /test engeli/);
      await evaluate(`(() => { location.reload(); return true; })()`);
      await until(`document.readyState === 'complete' && document.querySelector('#login') && !document.querySelector('#login').hidden`);
    });

    await t.test('completing step 2 creates the owner and signs in (same /api/auth/setup call)', async () => {
      await typeInto('#name', 'Deneme Kuyumcu');
      await evaluate(`(() => { document.querySelector('#setup-next').click(); return true; })()`);
      await typeInto('#password', '246810');
      await typeInto('#pin-confirm', '246810');
      await evaluate(`(() => { document.querySelector('#submit').click(); return true; })()`);
      await until(`location.pathname === '/owner'`, 15000);
      const session = await evaluate(`JSON.parse(sessionStorage.getItem('defter-session'))?.actor`);
      assert.equal(session.role, 'owner');
      assert.equal(session.name, 'Deneme Kuyumcu');
    });

    assert.deepEqual(consoleErrors, [], 'no page errors');
  } finally {
    await gui.close();
  }
});
