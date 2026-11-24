import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { launchChromeSession } from './paket6b-cdp-harness.mjs';
import {
  createIsolatedApp,
  seedBigDataLedger,
  seedFunctionalLedger,
  seedNominalUnconfirmedLedger,
  seedUninitializedLedger
} from './paket6b-e2e-fixtures.mjs';

function parseCliArgs(argv) {
  const opts = { tier: 'all', viewport: 'all', scenario: null };
  for (const arg of argv) {
    if (arg.startsWith('--tier=')) {
      opts.tier = arg.slice('--tier='.length).toLowerCase();
    } else if (arg.startsWith('--viewport=')) {
      opts.viewport = arg.slice('--viewport='.length).toLowerCase();
    } else if (arg.startsWith('--scenario=')) {
      const val = arg.slice('--scenario='.length).trim();
      if (!val) throw new Error('Invalid --scenario= (empty value). Expected e.g. --scenario=T1-F6-5 or --scenario=S12');
      opts.scenario = val;
    } else {
      throw new Error(`Unknown or malformed CLI argument: "${arg}". Expected --tier=1|2|3|4|all, --viewport=1440|1100|390|all, --scenario=<id>`);
    }
  }
  if (!['1', '2', '3', '4', 'all'].includes(opts.tier)) {
    throw new Error(`Invalid --tier=${opts.tier}. Expected 1|2|3|4|all`);
  }
  if (!['1440', '1100', '390', 'all'].includes(opts.viewport)) {
    throw new Error(`Invalid --viewport=${opts.viewport}. Expected 1440|1100|390|all`);
  }
  return opts;
}

const VIEWPORTS = {
  '1440': { width: 1440, height: 900 },
  '1100': { width: 1100, height: 900 },
  '390': { width: 390, height: 844 }
};

function getRequestedViewports(viewportFlag) {
  if (viewportFlag === 'all') return [VIEWPORTS['1440'], VIEWPORTS['1100'], VIEWPORTS['390']];
  return [VIEWPORTS[viewportFlag]];
}

// ---------------------------------------------------------------------------
// Opaque-box Browser Interaction Helpers (strictly derived from PROJECT.md)
// ---------------------------------------------------------------------------

const apiSessionCache = new Map();

async function apiLogin(origin, userId, password) {
  const cacheKey = `${origin}::${userId}`;
  const cached = apiSessionCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return { ...cached, actor: { ...cached.actor } };
  }
  const res = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ id: userId, password })
  });
  assert.equal(res.status, 200, `Expected 200 login for ${userId}, got ${res.status}`);
  const session = await res.json();
  apiSessionCache.set(cacheKey, session);
  return { ...session, actor: { ...session.actor } };
}

async function uiLogin(cdp, origin, user, expectedPath) {
  await cdp.navigate(origin + '/');
  await cdp.until("document.querySelector('#login')?.hidden === false", { label: 'login form visible' });
  await cdp.evaluate('sessionStorage.clear()');
  await cdp.evaluate(`(() => {
    const sel = document.querySelector('#user');
    sel.value = ${JSON.stringify(user.id)};
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await cdp.typeText(user.password, { selector: '#password', clear: true });
  await cdp.clickSelector('#submit');
  await cdp.until(`location.pathname === ${JSON.stringify(expectedPath)}`, {
    timeoutMs: 12000,
    label: `redirect to ${expectedPath}`
  });
  if (expectedPath === '/owner') {
    await cdp.until("document.querySelector('#business-date')?.textContent.includes('2026') && !document.querySelector('#main .loading')", {
      timeoutMs: 15000,
      label: 'owner workspace ready'
    });
  } else if (expectedPath === '/checkout') {
    await cdp.until("document.querySelector('#trade') && document.querySelector('#trade').hidden === false", {
      timeoutMs: 15000,
      label: 'checkout trade ready'
    });
  }
}

async function fastSessionLogin(cdp, origin, user, targetPath, { clearStorage = true } = {}) {
  const session = await apiLogin(origin, user.id, user.password);
  await cdp.navigate(origin + '/');
  await cdp.until('Boolean(window.DefterSession)', { label: 'DefterSession ready' });
  await cdp.evaluate(`(() => {
    ${clearStorage ? 'sessionStorage.clear(); localStorage.clear();' : ''}
    window.DefterSession.store(${JSON.stringify(session)});
  })()`);
  await cdp.navigate(origin + targetPath);
  if (targetPath.startsWith('/owner')) {
    await cdp.until("location.pathname === '/owner' && Boolean(document.querySelector('#business-date')) && !document.querySelector('#main .loading')", {
      timeoutMs: 15000,
      label: 'owner ready after session store'
    });
  } else if (targetPath.startsWith('/checkout')) {
    await cdp.until("location.pathname === '/checkout' && document.querySelector('#trade') && document.querySelector('#trade').hidden === false", {
      timeoutMs: 15000,
      label: 'checkout ready after session store'
    });
  }
  return session;
}

async function resetOwnerToView(cdp, viewName, tabName = null, app = null) {
  let onOwnerOrigin = false;
  try {
    onOwnerOrigin = await cdp.evaluate(`(() => {
      const s = window.DefterSession?.current?.();
      return ${app ? `location.origin === ${JSON.stringify(app.origin)} && ` : ''}location.pathname === '/owner' && s?.actor?.role === 'owner';
    })()`);
  } catch {
    onOwnerOrigin = false;
  }
  if (!onOwnerOrigin && app) {
    await fastSessionLogin(cdp, app.origin, app.owner, '/owner');
  }
  await cdp.evaluate(`(() => {
    for (const d of document.querySelectorAll('dialog[open]')) { try { d.close(); } catch {} }
    for (const f of document.querySelectorAll('form[data-draft-dirty]')) { f.dataset.draftDirty = 'false'; }
    const keep = sessionStorage.getItem('defter-session');
    sessionStorage.clear();
    if (keep) sessionStorage.setItem('defter-session', keep);
    localStorage.setItem('defter-workspace', 'demo');
  })()`);
  const hash = tabName && ['sale', 'movement'].includes(tabName) ? `#v=${viewName}&tab=${tabName}` : `#v=${viewName}`;
  await cdp.evaluate(`location.hash = ${JSON.stringify(hash)}`);
  await cdp.reload();
  await cdp.until("location.pathname === '/owner' && Boolean(document.querySelector('#business-date')) && !document.querySelector('#main .loading')", {
    timeoutMs: 15000,
    label: `owner view ${viewName} ready`
  });
  if (viewName === 'suppliers') {
    await cdp.until("Boolean(document.querySelector('[data-supplier-search], [data-firm-heading]'))", {
      timeoutMs: 8000,
      label: 'suppliers module rendered'
    });
  }
  if (viewName === 'transaction' && tabName) {
    await cdp.until(`Boolean(document.querySelector('[data-tab="${tabName}"]'))`, {
      timeoutMs: 8000,
      label: `transaction tab button ${tabName}`
    });
    const isActive = await cdp.evaluate(`document.querySelector('[data-tab="${tabName}"]')?.classList.contains('active')`);
    if (!isActive) {
      await cdp.clickSelector(`[data-tab="${tabName}"]`);
      await cdp.until(`Boolean(document.querySelector('[data-tab="${tabName}"].active'))`, {
        timeoutMs: 5000,
        label: `transaction tab ${tabName} active`
      });
    }
  }
}

async function openOwnerNavView(cdp, viewName) {
  await cdp.evaluate(`(() => {
    const btn = document.querySelector('#navigation [data-view="' + ${JSON.stringify(viewName)} + '"]');
    if (!btn) throw new Error('Nav button not found for ' + ${JSON.stringify(viewName)});
    btn.click();
  })()`);
  await cdp.until(`document.querySelector('#navigation [data-view="${viewName}"]')?.classList.contains('active')`, {
    label: `nav view ${viewName} active`
  });
}

async function openCommandPalette(cdp, { useMeta = false } = {}) {
  const t0 = performance.now();
  await cdp.pressKey('k', useMeta ? { meta: true } : { ctrl: true });
  await cdp.until(
    "Boolean(document.querySelector('dialog[data-command-palette][open], [data-command-palette][aria-modal=\"true\"]'))",
    { timeoutMs: 3000, label: 'Command Palette open ([data-command-palette])' }
  );
  await cdp.waitForDoubleRaf();
  const elapsedMs = performance.now() - t0;
  const info = await cdp.evaluate(`(() => {
    const dlg = document.querySelector('[data-command-palette]');
    const input = document.querySelector('[data-command-palette-input]');
    const list = document.querySelector('[data-command-palette-list]');
    return {
      isDialog: dlg?.tagName === 'DIALOG',
      isOpen: Boolean(dlg?.hasAttribute('open')),
      ariaModal: dlg?.getAttribute('aria-modal'),
      hasInput: Boolean(input),
      inputRole: input?.getAttribute('role'),
      inputFocused: document.activeElement === input,
      hasList: Boolean(list),
      listRole: list?.getAttribute('role')
    };
  })()`);
  assert.equal(info.ariaModal, 'true', 'Command Palette must have aria-modal="true"');
  assert.equal(info.hasInput, true, 'Command Palette must render [data-command-palette-input]');
  assert.equal(info.inputRole, 'combobox', 'Command Palette input must have role="combobox"');
  assert.equal(info.hasList, true, 'Command Palette must render [data-command-palette-list]');
  assert.equal(info.listRole, 'listbox', 'Command Palette list must have role="listbox"');
  assert.equal(info.inputFocused, true, 'Command Palette input must receive focus on open');
  return { elapsedMs, info };
}

async function selectCommandPaletteOption(cdp, query, matchText, { excludeTexts = [] } = {}) {
  const matchLower = matchText.toLocaleLowerCase('tr-TR');
  const excludesLower = excludeTexts.map(s => s.toLocaleLowerCase('tr-TR'));
  if (query !== null && query !== undefined) {
    await cdp.typeText(query, { clear: true });
  }
  await cdp.until(
    `(() => {
      const match = ${JSON.stringify(matchLower)};
      const excludes = ${JSON.stringify(excludesLower)};
      const opts = [...document.querySelectorAll('[data-command-palette-list] [role="option"]')];
      return opts.some(o => {
        if (o.getAttribute('aria-disabled') === 'true') return false;
        const full = ((o.dataset.commandId || '') + ' ' + o.textContent).toLocaleLowerCase('tr-TR');
        return full.includes(match) && !excludes.some(ex => full.includes(ex));
      });
    })()`,
    { timeoutMs: 5000, label: `command palette option "${matchText}"` }
  );

  const checkActiveJs = `(() => {
    const input = document.querySelector('[data-command-palette-input]');
    const activeId = input?.getAttribute('aria-activedescendant');
    const activeEl = (activeId && document.getElementById(activeId)) || document.querySelector('[data-command-palette-list] [role="option"][aria-selected="true"]');
    const opts = [...document.querySelectorAll('[data-command-palette-list] [role="option"]')];
    const match = ${JSON.stringify(matchLower)};
    const excludes = ${JSON.stringify(excludesLower)};
    const isMatch = o => {
      if (!o || o.getAttribute('aria-disabled') === 'true') return false;
      const full = ((o.dataset.commandId || '') + ' ' + o.textContent).toLocaleLowerCase('tr-TR');
      return full.includes(match) && !excludes.some(ex => full.includes(ex));
    };
    return {
      optionCount: opts.length,
      activeId: activeId || '',
      activeMatched: isMatch(activeEl)
    };
  })()`;

  let nav = await cdp.evaluate(checkActiveJs);
  const maxSteps = Math.max(1, nav.optionCount) + 1;
  for (let step = 0; step < maxSteps && !nav.activeMatched; step++) {
    await cdp.pressKey('ArrowDown');
    nav = await cdp.evaluate(checkActiveJs);
  }
  assert.equal(
    nav.activeMatched,
    true,
    `Command Palette failed to activate option "${matchText}" via ArrowDown / aria-activedescendant (last activeId=${JSON.stringify(nav.activeId)})`
  );
  await cdp.pressKey('Enter');
}

function resolveComboboxScript(backingSelectorExpr) {
  return `(() => {
    const backing = document.querySelector(${backingSelectorExpr});
    if (!backing) return { backing: null, combo: null, scope: null, listbox: null, statusEl: null, controlsId: '' };
    const pick = root => {
      if (!root) return null;
      if (backing.matches('[data-product], [data-item-field="accountId"]')) {
        return root.querySelector('[data-product-search][role="combobox"], .sale-product-search [role="combobox"], [role="combobox"]');
      }
      if (backing.id === 'customer') {
        return root.querySelector('#search[role="combobox"], [role="combobox"]');
      }
      if (backing.id === 'f-customerAccount') {
        return root.querySelector('#collection-search[role="combobox"], [role="combobox"]');
      }
      return root.querySelector('[role="combobox"]');
    };
    let scope = null;
    let combo = backing.getAttribute('role') === 'combobox' ? backing : null;
    if (combo) scope = combo.closest('.defter-combobox, .combobox-wrap, .combobox, .field, label') || combo.parentElement;
    if (!combo) {
      scope = backing.closest('.defter-combobox, .combobox-wrap, .combobox');
      combo = pick(scope);
    }
    if (!combo) {
      scope = backing.closest('.field, label');
      combo = pick(scope);
    }
    if (!combo) {
      scope = backing.closest('.access-columns, .checkout-customer, .sale-item, .checkout-line, [data-item], [data-row], .allocation-row, #collection-form') || backing.parentElement;
      combo = pick(scope);
    }
    const comboScope = combo ? (combo.closest('.defter-combobox, .combobox-wrap, .combobox, .field, label') || scope) : scope;
    const controlsId = combo?.getAttribute('aria-controls') || '';
    const listbox = controlsId
      ? document.getElementById(controlsId)
      : (comboScope?.querySelector('[role="listbox"]') || scope?.querySelector('[role="listbox"]') || null);
    const statusEl =
      listbox?.querySelector('[data-combobox-status]') ||
      (listbox?.parentElement && listbox.parentElement !== document.body ? listbox.parentElement.querySelector('[data-combobox-status]') : null) ||
      comboScope?.querySelector('[data-combobox-status]') ||
      scope?.querySelector('[data-combobox-status]') ||
      null;
    return { backing, combo, scope: comboScope || scope, listbox, statusEl, controlsId };
  })()`;
}

async function waitForComboboxState(cdp, backingSelector, predicateFnExpr, { timeoutMs = 4000, label } = {}) {
  return cdp.until(
    `(() => {
      const { backing, combo, listbox, statusEl } = ${resolveComboboxScript(JSON.stringify(backingSelector))};
      if (!backing || !combo) return false;
      const options = listbox ? [...listbox.querySelectorAll('[role="option"]')] : [];
      const statusText = statusEl ? statusEl.textContent.trim() : '';
      const ariaExpanded = combo.getAttribute('aria-expanded') || '';
      const comboValue = 'value' in combo ? String(combo.value ?? '') : '';
      return (${predicateFnExpr})({ backing, combo, listbox, statusEl, options, statusText, ariaExpanded, comboValue });
    })()`,
    { timeoutMs, label: label || `combobox state for ${backingSelector}` }
  );
}

async function getComboboxListboxRect(cdp, backingSelector) {
  return cdp.evaluate(`(() => {
    const { listbox } = ${resolveComboboxScript(JSON.stringify(backingSelector))};
    if (!listbox || listbox.hidden) return null;
    const r = listbox.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, innerWidth: window.innerWidth, innerHeight: window.innerHeight };
  })()`);
}

async function getComboboxContractInfo(cdp, backingSelector) {
  return cdp.evaluate(`(() => {
    const { backing, combo, listbox, statusEl, controlsId } = ${resolveComboboxScript(JSON.stringify(backingSelector))};
    if (!backing) return { backingFound: false };
    if (!combo) return { backingFound: true, comboboxFound: false, backingTag: backing.tagName, backingId: backing.id };
    const options = listbox ? [...listbox.querySelectorAll('[role="option"]')] : [];
    return {
      backingFound: true,
      comboboxFound: true,
      backingValue: backing.value,
      backingOptionCount: backing.tagName === 'SELECT' ? backing.options.length : null,
      role: combo.getAttribute('role'),
      ariaAutocomplete: combo.getAttribute('aria-autocomplete'),
      ariaExpanded: combo.getAttribute('aria-expanded'),
      ariaControls: controlsId,
      ariaActiveDescendant: combo.getAttribute('aria-activedescendant'),
      listboxFound: Boolean(listbox),
      listboxVisible: Boolean(listbox && !listbox.hidden && listbox.getBoundingClientRect().height > 0),
      optionCount: options.length,
      options: options.map(o => ({
        id: o.id || '',
        text: o.textContent.trim(),
        ariaSelected: o.getAttribute('aria-selected'),
        ariaDisabled: o.getAttribute('aria-disabled'),
        value: o.dataset.value || o.dataset.id || ''
      })),
      statusText: statusEl ? statusEl.textContent.trim() : null
    };
  })()`);
}

async function focusComboboxFor(cdp, backingSelector) {
  const info = await getComboboxContractInfo(cdp, backingSelector);
  assert.equal(info.backingFound, true, `Backing element not found: ${backingSelector}`);
  assert.equal(
    info.comboboxFound,
    true,
    `Expected [role="combobox"] integrated with ${backingSelector} per PROJECT.md § Interface Contracts #3`
  );
  await cdp.evaluate(`(() => {
    const { combo } = ${resolveComboboxScript(JSON.stringify(backingSelector))};
    const focusEl = combo.matches('input, button, select, textarea, [tabindex]') ? combo : (combo.querySelector('input') || combo);
    focusEl.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    focusEl.click();
    focusEl.focus();
  })()`);
  return info;
}

async function searchAndSelectCombobox(cdp, backingSelector, query, matchText, { perCharDelayMs = 0 } = {}) {
  await focusComboboxFor(cdp, backingSelector);
  await cdp.typeText(query, { clear: true, perCharDelayMs });
  await cdp.until(
    `(() => {
      const { listbox: lb } = ${resolveComboboxScript(JSON.stringify(backingSelector))};
      const opts = lb ? [...lb.querySelectorAll('[role="option"]')] : [];
      return opts.some(o => o.textContent.toLocaleLowerCase('tr-TR').includes(${JSON.stringify(matchText.toLocaleLowerCase('tr-TR'))}));
    })()`,
    { timeoutMs: 6000, label: `combobox match "${matchText}" for ${backingSelector}` }
  );
  const idx = await cdp.evaluate(`(() => {
    const { listbox: lb } = ${resolveComboboxScript(JSON.stringify(backingSelector))};
    const opts = lb ? [...lb.querySelectorAll('[role="option"]')] : [];
    return opts.findIndex(o => o.textContent.toLocaleLowerCase('tr-TR').includes(${JSON.stringify(matchText.toLocaleLowerCase('tr-TR'))}) && o.getAttribute('aria-disabled') !== 'true');
  })()`);
  assert.ok(idx >= 0, `No enabled combobox option matching "${matchText}"`);

  // Navigate with ArrowDown from start/home and press Enter
  await cdp.pressKey('Home');
  for (let i = 0; i < idx; i++) {
    await cdp.pressKey('ArrowDown');
  }
  const activeText = await cdp.evaluate(`(() => {
    const { combo } = ${resolveComboboxScript(JSON.stringify(backingSelector))};
    const activeId = combo?.getAttribute('aria-activedescendant');
    return activeId ? document.getElementById(activeId)?.textContent.trim() : '';
  })()`);
  if (!activeText.toLocaleLowerCase('tr-TR').includes(matchText.toLocaleLowerCase('tr-TR'))) {
    await cdp.pressKey('ArrowDown');
  }
  await cdp.pressKey('Enter');
  await cdp.waitForDoubleRaf();
  return getComboboxContractInfo(cdp, backingSelector);
}

// ---------------------------------------------------------------------------
// Test Registry Builder (82 total cases across Tiers 1-4)
// ---------------------------------------------------------------------------

function buildTestCases(opts) {
  const tests = [];
  const add = (tier, id, scenarios, title, fn) => {
    tests.push({ tier, id, scenarios, title, fn });
  };

  // =========================================================================
  // TIER 1 — Feature Coverage (33 cases)
  // =========================================================================

  // F2: Shared Turkish Normalization & /api/customers (5 cases)
  add(1, 'T1-F2-1', ['S11'], 'Turkish İ/I/ı folding in owner account search (#account-search)', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('accounts');
    for (const [q, expected] of [
      ['ismail', 'İsmail Işık'],
      ['ISIK', 'İsmail Işık'],
      ['igdir', 'Iğdır Kuyumculuk'],
      ['ISTANBUL', 'İstanbul Sarrafiye']
    ]) {
      await cdp.typeText(q, { selector: '#account-search', clear: true });
      await cdp.until(
        `[...document.querySelectorAll('#account-list [data-account-detail]')].some(b => b.textContent.includes(${JSON.stringify(expected)}))`,
        { timeoutMs: 3000, label: `#account-search "${q}" -> ${expected}` }
      ).catch(() => {});
      const cards = await cdp.evaluate("[...document.querySelectorAll('#account-list [data-account-detail]')].map(b => b.textContent)");
      assert.ok(cards.some(t => t.includes(expected)), `Query "${q}" expected "${expected}" in ${JSON.stringify(cards)}`);
    }
    await cdp.assertCleanTelemetry();
  });

  add(1, 'T1-F2-2', ['S11'], 'Turkish ğ/ş/ç/ö/ü folding in stock & supplier search', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('stocks');
    await cdp.typeText('agri', { selector: '#stock-search', clear: true });
    await cdp.until(
      "[...document.querySelectorAll('#stock-list [data-account-detail]')].some(b => b.textContent.includes('AĞRI HAS ALTIN'))",
      { timeoutMs: 3000, label: '#stock-search "agri"' }
    ).catch(() => {});
    let stockCards = await cdp.evaluate("[...document.querySelectorAll('#stock-list [data-account-detail]')].map(b => b.textContent)");
    assert.ok(stockCards.some(t => t.includes('AĞRI HAS ALTIN')), `Stock query "agri" missing AĞRI HAS ALTIN: ${JSON.stringify(stockCards)}`);

    await cdp.typeText('gumus', { selector: '#stock-search', clear: true });
    await cdp.until(
      "[...document.querySelectorAll('#stock-list [data-account-detail]')].some(b => b.textContent.includes('GÜMÜŞ BİLEZİK'))",
      { timeoutMs: 3000, label: '#stock-search "gumus"' }
    ).catch(() => {});
    stockCards = await cdp.evaluate("[...document.querySelectorAll('#stock-list [data-account-detail]')].map(b => b.textContent)");
    assert.ok(stockCards.some(t => t.includes('GÜMÜŞ BİLEZİK')), `Stock query "gumus" missing GÜMÜŞ BİLEZİK: ${JSON.stringify(stockCards)}`);

    await ctx.resetOwner('suppliers');
    await cdp.typeText('ozgur celik', { selector: '[data-supplier-search]', clear: true });
    await cdp.until(
      "[...document.querySelectorAll('[data-open-firm]')].some(b => b.textContent.includes('Özgür Çelik Toptan'))",
      { timeoutMs: 3000, label: '[data-supplier-search] "ozgur celik"' }
    ).catch(() => {});
    const firms = await cdp.evaluate("[...document.querySelectorAll('[data-open-firm]')].map(b => b.textContent)");
    assert.ok(firms.some(t => t.includes('Özgür Çelik Toptan')), `Supplier query "ozgur celik" missing Özgür Çelik Toptan: ${JSON.stringify(firms)}`);
    await cdp.assertCleanTelemetry();
  });

  add(1, 'T1-F2-3', ['S11'], '/checkout /api/customers?q= Turkish folding (ismail, ayse, isik)', async ctx => {
    const { origin, employee } = ctx.app;
    const session = await apiLogin(origin, employee.id, employee.password);
    for (const [q, expectedName] of [
      ['ismail', 'İsmail Işık'],
      ['ayse', 'Ayşe Şahin'],
      ['isik', 'İsmail Işık']
    ]) {
      const res = await fetch(`${origin}/api/customers?workspace=demo&q=${encodeURIComponent(q)}`, {
        headers: { Authorization: `Bearer ${session.token}` }
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      const items = Array.isArray(body) ? body : body.items;
      assert.ok(Array.isArray(items), 'Expected array or { items }');
      assert.ok(
        items.some(p => p.name === expectedName),
        `/api/customers?q=${q} failed Turkish folding; expected "${expectedName}", got ${JSON.stringify(items)}`
      );
    }
  });

  add(1, 'T1-F2-4', ['S2'], '/api/customers?q= phone and taxId matching', async ctx => {
    const { origin, employee } = ctx.app;
    const session = await apiLogin(origin, employee.id, employee.password);
    for (const [q, expectedId] of [
      ['05411234567', 'cari-cust-ismail'],
      ['44444444444', 'cari-cust-ismail'],
      ['05324445566', 'cari-cust-ahmet-usd']
    ]) {
      const res = await fetch(`${origin}/api/customers?workspace=demo&q=${encodeURIComponent(q)}`, {
        headers: { Authorization: `Bearer ${session.token}` }
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      const items = Array.isArray(body) ? body : body.items;
      assert.ok(
        items.some(p => p.id === expectedId),
        `/api/customers?q=${q} must match phone/taxId -> ${expectedId}, got ${JSON.stringify(items)}`
      );
    }
  });

  add(1, 'T1-F2-5', ['S3', 'S10'], '/checkout /api/customers disambiguation metadata & employee-safe payload', async ctx => {
    const { origin, employee } = ctx.app;
    const session = await apiLogin(origin, employee.id, employee.password);
    const res = await fetch(`${origin}/api/customers?workspace=demo&q=${encodeURIComponent('Ahmet Yılmaz')}`, {
      headers: { Authorization: `Bearer ${session.token}` }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    const items = Array.isArray(body) ? body : body.items;
    assert.ok(items.length >= 3, `Expected >= 3 Ahmet Yılmaz matches, got ${items.length}`);
    for (const item of items) {
      assert.equal(Object.hasOwn(item, 'balance'), false, 'Customer choice list must NOT leak owner balance');
      assert.equal(Object.hasOwn(item, 'costTL'), false, 'Customer choice list must NOT leak costTL');
      assert.ok(
        item.disambiguationLabel || item.phone || item.taxId,
        `Expected disambiguation metadata (disambiguationLabel/phone/taxId) on ${JSON.stringify(item)}`
      );
    }
    assert.ok(!items.some(i => String(i.id).startsWith('supplier-')), 'Must never return supplier firms');
  });

  // F3: Smart Searchable Combobox Component (6 cases)
  add(1, 'T1-F3-1', ['S2'], 'Combobox ARIA contract on #f-counterpartyId', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('transaction', 'sale');
    const before = await getComboboxContractInfo(cdp, '#f-counterpartyId');
    assert.equal(before.comboboxFound, true, 'Missing [role="combobox"] on #f-counterpartyId');
    assert.equal(before.ariaAutocomplete, 'list', 'aria-autocomplete must be "list"');
    assert.ok(before.ariaControls, 'aria-controls must reference listbox ID');

    await focusComboboxFor(cdp, '#f-counterpartyId');
    await cdp.typeText('Ahmet', { clear: true });
    await waitForComboboxState(cdp, '#f-counterpartyId', "s => s.ariaExpanded === 'true' && s.options.length >= 2", {
      label: '#f-counterpartyId open with Ahmet options'
    });
    const open = await getComboboxContractInfo(cdp, '#f-counterpartyId');
    assert.equal(open.ariaExpanded, 'true', 'aria-expanded must be "true" when open');
    assert.equal(open.listboxFound, true, 'Associated [role="listbox"] must exist');
    assert.ok(open.optionCount >= 2, 'Expected matching [role="option"] entries');

    await cdp.pressKey('ArrowDown');
    const navigated = await getComboboxContractInfo(cdp, '#f-counterpartyId');
    assert.ok(navigated.ariaActiveDescendant, 'aria-activedescendant must update on ArrowDown');
    await cdp.assertCleanTelemetry();
  });

  add(1, 'T1-F3-2', ['S4', 'S11'], 'Product Combobox on [data-item-field="accountId"] in sale (agri & gumus)', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('transaction', 'sale');
    const selected1 = await searchAndSelectCombobox(cdp, '[data-item-field="accountId"]', 'agri', 'AĞRI HAS ALTIN');
    assert.equal(selected1.backingValue, 'stock-stk-agri', 'Expected stock-stk-agri committed');

    const selected2 = await searchAndSelectCombobox(cdp, '[data-item-field="accountId"]', 'gumus', 'GÜMÜŞ BİLEZİK');
    assert.equal(selected2.backingValue, 'stock-stk-gumus', 'Expected stock-stk-gumus committed');
    await cdp.assertCleanTelemetry();
  });

  add(1, 'T1-F3-3', ['S4'], 'Combobox full keyboard nav (ArrowDown/ArrowUp/Home/End/Enter/Escape/Tab)', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('transaction', 'sale');
    await searchAndSelectCombobox(cdp, '#f-counterpartyId', 'İsmail', 'İsmail Işık');
    const committedId = await cdp.evaluate("document.querySelector('#f-counterpartyId').value");
    assert.equal(committedId, 'cari-cust-ismail');
    // Enter must NOT submit #sale-form
    assert.equal(await cdp.evaluate("Boolean(document.querySelector('#sale-form'))"), true);
    assert.equal(cdp.getRequests().filter(r => r.url.includes('/api/command') && r.method === 'POST').length, 0);

    // Reopen, test ArrowDown / End / Home / ArrowUp, then Escape preserves committed value
    await focusComboboxFor(cdp, '#f-counterpartyId');
    await cdp.typeText('Ahmet', { clear: true });
    await waitForComboboxState(cdp, '#f-counterpartyId', 's => s.options.length >= 2', {
      label: '#f-counterpartyId Ahmet options for Home/End'
    });
    await cdp.pressKey('End');
    const atEnd = await getComboboxContractInfo(cdp, '#f-counterpartyId');
    await cdp.pressKey('Home');
    const atHome = await getComboboxContractInfo(cdp, '#f-counterpartyId');
    assert.notEqual(atEnd.ariaActiveDescendant, atHome.ariaActiveDescendant, 'Home and End should navigate distinct options');
    await cdp.pressKey('Escape');
    await cdp.waitForDoubleRaf();
    const afterEsc = await getComboboxContractInfo(cdp, '#f-counterpartyId');
    assert.equal(afterEsc.ariaExpanded, 'false', 'Escape must close listbox');
    assert.equal(afterEsc.backingValue, committedId, 'Escape must NOT clear committed backing value');

    // Reopen and Tab closes cleanly
    await focusComboboxFor(cdp, '#f-counterpartyId');
    await cdp.pressKey('ArrowDown');
    await cdp.pressKey('Tab');
    await cdp.waitForDoubleRaf();
    const afterTab = await getComboboxContractInfo(cdp, '#f-counterpartyId');
    assert.equal(afterTab.ariaExpanded, 'false', 'Tab must close listbox cleanly');
    await cdp.assertCleanTelemetry();
  });

  add(1, 'T1-F3-4', ['S12'], '[data-combobox-status] displays visible vs total searchable count', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('transaction', 'sale');
    await focusComboboxFor(cdp, '#f-counterpartyId');
    await cdp.typeText('Ahmet', { clear: true });
    await waitForComboboxState(cdp, '#f-counterpartyId', 's => s.options.length >= 1 && /\\d+\\s*\\/\\s*\\d+/.test(s.statusText)', {
      label: '#f-counterpartyId [data-combobox-status]'
    });
    const info = await getComboboxContractInfo(cdp, '#f-counterpartyId');
    assert.ok(info.statusText && /\d+\s*\/\s*\d+/.test(info.statusText), `Expected [data-combobox-status] "shown / total", got ${JSON.stringify(info.statusText)}`);
    await cdp.assertCleanTelemetry();
  });

  add(1, 'T1-F3-5', ['S4'], 'Backing control .value & change sync + [data-item-field="quantity"] focus progression', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('transaction', 'sale');
    await cdp.evaluate(`(() => {
      window.__e2eChangeEvents = 0;
      document.querySelector('[data-item-field="accountId"]').addEventListener('change', () => window.__e2eChangeEvents++);
    })()`);
    const selectedInfo = await searchAndSelectCombobox(cdp, '[data-item-field="accountId"]', 'agri', 'AĞRI HAS ALTIN');
    assert.equal(selectedInfo.ariaExpanded, 'false', 'Enter commit must close Combobox listbox');
    const state = await cdp.evaluate(`(() => ({
      val: document.querySelector('[data-item-field="accountId"]').value,
      changes: window.__e2eChangeEvents,
      qtyLabel: document.querySelector('[data-item-field="quantity"]').previousElementSibling.textContent,
      activeField: document.activeElement?.getAttribute('data-item-field') || ''
    }))()`);
    assert.equal(state.val, 'stock-stk-agri');
    assert.ok(state.changes >= 1, 'Expected change event dispatched on backing select');
    assert.ok(state.qtyLabel.includes('gr'), `Expected unit label updated for GRAM stock, got ${state.qtyLabel}`);
    // PROJECT.md § Interface Contracts #3 guarantees Enter commits & closes cleanly (auto-focus or Tab reaches quantity)
    for (let i = 0; i < 2 && state.activeField !== 'quantity'; i++) {
      await cdp.pressKey('Tab');
      await cdp.waitForDoubleRaf();
      state.activeField = await cdp.evaluate("document.activeElement?.getAttribute('data-item-field') || ''");
    }
    assert.equal(state.activeField, 'quantity', 'Expected focus to reach [data-item-field="quantity"] directly or via Tab');
    await cdp.assertCleanTelemetry();
  });

  add(1, 'T1-F3-6', ['S3'], 'Combobox coverage in purchase, collection (#f-customerAccount), and journal (#journal-account)', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('transaction', 'purchase');
    const purParty = await getComboboxContractInfo(cdp, '#f-counterpartyId');
    assert.equal(purParty.comboboxFound, true, 'Missing Combobox on purchase #f-counterpartyId');
    const purProduct = await getComboboxContractInfo(cdp, '[data-item-field="accountId"]');
    assert.equal(purProduct.comboboxFound, true, 'Missing Combobox on purchase [data-item-field="accountId"]');

    await cdp.clickSelector('[data-tab="collection"]');
    await cdp.until("Boolean(document.querySelector('#f-customerAccount'))", { label: 'collection form' });
    const colCust = await getComboboxContractInfo(cdp, '#f-customerAccount');
    assert.equal(colCust.comboboxFound, true, 'Missing Combobox on #f-customerAccount');

    await openOwnerNavView(cdp, 'journal');
    await cdp.until("Boolean(document.querySelector('#journal-account'))", { label: 'journal view' });
    const jrnAcc = await getComboboxContractInfo(cdp, '#journal-account');
    assert.equal(jrnAcc.comboboxFound, true, 'Missing Combobox on #journal-account');
    await cdp.assertCleanTelemetry();
  });

  // F4: Ctrl+K / Cmd+K Command Palette (6 cases)
  add(1, 'T1-F4-1', ['S1'], 'Ctrl+K opens [data-command-palette] <dialog> in top layer & Escape restores exact trigger focus', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('overview');
    await cdp.focusSelector('#refresh');
    await openCommandPalette(cdp, { useMeta: false });
    await cdp.pressKey('Escape');
    await cdp.until("!document.querySelector('[data-command-palette][open]')", { label: 'palette closed' });
    const active = await cdp.getActiveElementInfo();
    assert.equal(active.id, 'refresh', `Escape must restore exact trigger focus (#refresh), got ${JSON.stringify(active)}`);
    await cdp.assertCleanTelemetry();
  });

  add(1, 'T1-F4-2', ['S1'], 'Cmd+K (Meta+K) toggles Command Palette open and closed', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('overview');
    await openCommandPalette(cdp, { useMeta: true });
    await cdp.pressKey('k', { meta: true });
    await cdp.until("!document.querySelector('[data-command-palette][open]')", { label: 'Cmd+K closed palette' });
    await cdp.assertCleanTelemetry();
  });

  add(1, 'T1-F4-3', ['S1'], 'Grouped commands & navigating to Müşteriler (accounts) via Ctrl+K', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('overview');
    await openCommandPalette(cdp);
    const groups = await cdp.evaluate("[...document.querySelectorAll('[data-command-palette-list] [role=\"group\"][aria-label]')].map(g => g.getAttribute('aria-label'))");
    assert.ok(groups.length >= 2, `Expected >= 2 command groups with aria-label, got ${JSON.stringify(groups)}`);

    await selectCommandPaletteOption(cdp, 'musteri', 'Müşteri', { excludeTexts: ['alış', 'ekle', 'yeni'] });
    await cdp.until("location.hash.includes('v=accounts') && Boolean(document.querySelector('#account-search'))", {
      label: 'navigated to accounts via Ctrl+K'
    });
    await cdp.assertCleanTelemetry();
  });

  add(1, 'T1-F4-4', ['S2', 'S11'], 'Customer search in Ctrl+K palette navigates directly to #account-detail', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('overview');
    await openCommandPalette(cdp);
    await selectCommandPaletteOption(cdp, 'ismail isik', 'İsmail Işık');
    await cdp.until("location.hash.includes('v=accounts') && document.querySelector('#account-detail:not([hidden]) #statement-title')?.textContent.includes('İsmail Işık')", {
      label: 'jumped to İsmail Işık detail'
    });
    await cdp.assertCleanTelemetry();
  });

  add(1, 'T1-F4-5', ['S5'], 'Stock & supplier jump via Ctrl+K (#v=stocks, #v=suppliers)', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('overview');
    await openCommandPalette(cdp);
    await selectCommandPaletteOption(cdp, 'agri has', 'AĞRI HAS ALTIN');
    await cdp.until("location.hash.includes('v=stocks') && document.querySelector('#account-detail:not([hidden]) #statement-title')?.textContent.includes('AĞRI HAS ALTIN')", {
      label: 'jumped to AĞRI HAS ALTIN detail'
    });

    await openCommandPalette(cdp);
    await selectCommandPaletteOption(cdp, 'ozgur celik', 'Özgür Çelik Toptan');
    await cdp.until("location.hash.includes('v=suppliers') && document.querySelector('[data-firm-heading]')?.textContent.includes('Özgür Çelik Toptan')", {
      label: 'jumped to Özgür Çelik Toptan detail'
    });
    await cdp.assertCleanTelemetry();
  });

  add(1, 'T1-F4-6', ['S8'], 'Ctrl+K execution NEVER auto-commits financial commands (POST /api/command = 0)', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('overview');
    cdp.clearRequests();
    await openCommandPalette(cdp);
    await selectCommandPaletteOption(cdp, 'satis', 'Satış', { excludeTexts: ['toptancı', 'alış'] });
    await cdp.until("location.hash.includes('v=transaction')", { label: 'transaction screen open' });
    await delay(150);
    const postCommands = cdp.getRequests().filter(r => r.url.includes('/api/command') && r.method === 'POST');
    assert.equal(postCommands.length, 0, 'Command Palette must NEVER auto-submit /api/command');
    await cdp.assertCleanTelemetry();
  });

  // F5: Owner Screens Integration & Hash Detail Restore (6 cases)
  add(1, 'T1-F5-1', ['S3'], '#f-counterpartyId disambiguation of similarly named customers (TL vs USD vs Kuyumcu)', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('transaction', 'sale');
    await focusComboboxFor(cdp, '#f-counterpartyId');
    await cdp.typeText('Ahmet Yılmaz', { clear: true });
    await waitForComboboxState(cdp, '#f-counterpartyId', 's => s.options.length >= 3', {
      label: '#f-counterpartyId 3 Ahmet Yılmaz matches'
    });
    const open = await getComboboxContractInfo(cdp, '#f-counterpartyId');
    const texts = open.options.map(o => o.text);
    assert.ok(texts.some(t => t.includes('Ahmet Yılmaz') && t.includes('TL')), `Missing TL label in ${JSON.stringify(texts)}`);
    assert.ok(texts.some(t => t.includes('Ahmet Yılmaz') && t.includes('USD')), `Missing USD label in ${JSON.stringify(texts)}`);
    assert.ok(texts.some(t => t.includes('Ahmet Yılmaz Kuyumcu')), `Missing Kuyumcu label in ${JSON.stringify(texts)}`);

    await searchAndSelectCombobox(cdp, '#f-counterpartyId', 'Ahmet Yılmaz', 'USD');
    assert.equal(await cdp.evaluate("document.querySelector('#f-counterpartyId').value"), 'cari-cust-ahmet-usd');
    await cdp.assertCleanTelemetry();
  });

  add(1, 'T1-F5-2', ['S5'], 'Supplier firm & unit selection in #v=suppliers (Özgür Çelik Toptan HAS/TL)', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('suppliers');
    await cdp.clickSelector('[data-open-firm="supplier-sup-ozgur"]');
    await cdp.until("document.querySelector('[data-firm-heading]')?.textContent.includes('Özgür Çelik Toptan')", {
      label: 'Özgür Çelik Toptan open'
    });
    await cdp.clickSelector('[data-supplier-task="purchase"]');
    await cdp.until("Boolean(document.querySelector('form[data-supplier-form=\"purchase\"]'))", {
      label: 'supplier purchase form open'
    });
    await cdp.clickSelector('[data-group="items"] [data-add-row]');
    const itemRows = await cdp.evaluate("document.querySelectorAll('[data-group=\"items\"] [data-row]').length");
    assert.ok(itemRows >= 2, `Expected >= 2 item rows after clicking [data-add-row], got ${itemRows}`);
    for (let i = 1; i <= itemRows; i++) {
      const itemCombo = await getComboboxContractInfo(cdp, `[data-group="items"] [data-row]:nth-of-type(${i}) select[data-field="accountId"]`);
      assert.equal(itemCombo.comboboxFound, true, `Supplier purchase item row ${i} must have Combobox`);
    }
    if (await cdp.evaluate("Boolean(document.querySelector('form[data-supplier-form=\"purchase\"] [data-wizard-next]'))")) {
      await searchAndSelectCombobox(cdp, '[data-group="items"] [data-row]:nth-of-type(1) select[data-field="accountId"]', 'ceyrek', 'ÇEYREK');
      await cdp.typeText('1', { selector: '[data-group="items"] [data-row]:nth-of-type(1) input[data-field="quantity"]', clear: true });
      await cdp.clickSelector('[data-group="items"] [data-row]:nth-of-type(2) [data-remove-row]');
      await cdp.clickSelector('form[data-supplier-form="purchase"] [data-wizard-next]');
      await cdp.until("document.querySelector('[data-group=\"charges\"]')?.closest('section')?.hidden === false", { label: 'purchase wizard step 2 visible' });
    }
    await cdp.clickSelector('[data-group="charges"] [data-add-row]');
    const chargeRows = await cdp.evaluate("document.querySelectorAll('[data-group=\"charges\"] [data-row]').length");
    assert.ok(chargeRows >= 2, `Expected >= 2 charge rows after clicking [data-add-row], got ${chargeRows}`);
    for (let i = 1; i <= chargeRows; i++) {
      const chargeCombo = await getComboboxContractInfo(cdp, `[data-group="charges"] [data-row]:nth-of-type(${i}) select[data-field="accountId"]`);
      assert.equal(chargeCombo.comboboxFound, true, `Supplier purchase charge row ${i} must have Combobox`);
    }
    await cdp.assertCleanTelemetry();
  });

  add(1, 'T1-F5-3', ['S9'], '#v=accounts&id=... hash synchronization & F5 Page.reload restore', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('accounts');
    await cdp.clickSelector('[data-account-detail="cari-cust-ismail"]');
    await cdp.until("document.querySelector('#account-detail:not([hidden]) #statement-title')?.textContent.includes('İsmail Işık')", {
      label: 'account detail open'
    });
    const hash = await cdp.evaluate('location.hash');
    assert.ok(hash.includes('v=accounts') && hash.includes('id=cari-cust-ismail'), `Expected #v=accounts&id=cari-cust-ismail, got ${hash}`);

    await cdp.reload();
    await cdp.until("location.pathname === '/owner' && document.querySelector('#account-detail:not([hidden]) #statement-title')?.textContent.includes('İsmail Işık')", {
      timeoutMs: 12000,
      label: 'account detail restored after F5'
    });
    await cdp.assertCleanTelemetry();
  });

  add(1, 'T1-F5-4', ['S9'], '#v=stocks&id=... & #v=suppliers&id=... hash sync & F5 Page.reload restore', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('stocks');
    await cdp.clickSelector('[data-account-detail="stock-stk-agri"]');
    await cdp.until("document.querySelector('#account-detail:not([hidden]) #statement-title')?.textContent.includes('AĞRI HAS ALTIN')", {
      label: 'stock detail open'
    });
    assert.ok((await cdp.evaluate('location.hash')).includes('id=stock-stk-agri'), 'Expected id=stock-stk-agri in hash');
    await cdp.reload();
    await cdp.until("document.querySelector('#account-detail:not([hidden]) #statement-title')?.textContent.includes('AĞRI HAS ALTIN')", {
      timeoutMs: 12000,
      label: 'stock detail restored after F5'
    });

    await ctx.resetOwner('suppliers');
    await cdp.clickSelector('[data-open-firm="supplier-sup-ozgur"]');
    await cdp.until("document.querySelector('[data-firm-heading]')?.textContent.includes('Özgür Çelik Toptan')", {
      label: 'supplier detail open'
    });
    assert.ok((await cdp.evaluate('location.hash')).includes('id=supplier-sup-ozgur'), 'Expected id=supplier-sup-ozgur in hash');
    await cdp.reload();
    await cdp.until("document.querySelector('[data-firm-heading]')?.textContent.includes('Özgür Çelik Toptan')", {
      timeoutMs: 12000,
      label: 'supplier detail restored after F5'
    });
    await cdp.assertCleanTelemetry();
  });

  add(1, 'T1-F5-5', ['S11'], '#journal-search debounced query avoids per-keystroke network flood', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('journal');
    await cdp.until(
      "document.querySelector('#journal-list')?.getAttribute('aria-busy') === 'false' && document.querySelectorAll('#journal-list .journal-item').length >= 1",
      { label: 'initial journal loaded' }
    );
    await delay(250);
    cdp.clearRequests();
    await cdp.typeText('ismailisik', { selector: '#journal-search', clear: true, perCharDelayMs: 25 });
    await delay(500);
    await cdp.until("document.querySelector('#journal-list')?.getAttribute('aria-busy') === 'false'", {
      timeoutMs: 10000,
      label: 'journal search settled'
    }).catch(() => {});
    const journalCalls = cdp.getRequests().filter(r => r.url.includes('/api/journal'));
    assert.ok(
      journalCalls.length >= 1 && journalCalls.length <= 3,
      `Expected debounced #journal-search (1..3 requests for 10 rapid chars), got ${journalCalls.length}`
    );
    await cdp.assertCleanTelemetry();
  });

  add(1, 'T1-F5-6', ['S4'], 'Owner quick-sale end-to-end via Combobox + submit persists in SQLite', async ctx => {
    const { cdp, app } = ctx;
    await ctx.resetOwner('transaction', 'sale');
    await searchAndSelectCombobox(cdp, '#f-counterpartyId', 'Ümit Erdoğan', 'Ümit Erdoğan');
    await searchAndSelectCombobox(cdp, '[data-item-field="accountId"]', 'ceyrek', 'ÇEYREK');
    await cdp.typeText('1', { selector: '[data-item-field="quantity"]', clear: true });
    await cdp.typeText('5100', { selector: '[data-item-field="value"]', clear: true });
    await cdp.clickSelector('[data-quick-fill-cash]');
    await cdp.clickSelector('#sale-form button[type="submit"]');
    await cdp.until("document.querySelector('#defter-toast-region')?.textContent.includes('kaydedildi') || document.querySelector('#notice')?.textContent.includes('kaydedildi')", {
      timeoutMs: 10000,
      label: 'owner quick sale committed'
    });
    const repo = app.openRepo('demo');
    try {
      const last = repo.state().journal.at(-1);
      assert.equal(last.type, 'sale');
      assert.equal(last.meta.counterpartyId, 'cari-cust-umit');
    } finally {
      repo.close();
    }
    await cdp.assertCleanTelemetry();
  });

  // F6: Employee Workbench (/checkout) Integration & Isolation (5 cases)
  add(1, 'T1-F6-1', ['S10'], 'Employee login lands on /checkout & Ctrl+K opens employee-only palette', async ctx => {
    const { cdp, app } = ctx;
    await uiLogin(cdp, app.origin, app.employee, '/checkout');
    const { info } = await openCommandPalette(cdp);
    assert.equal(info.isOpen, true);
    await cdp.pressKey('Escape');
    await cdp.until("!document.querySelector('[data-command-palette][open]')", { label: 'checkout palette closed' });
    await cdp.assertCleanTelemetry();
  });

  add(1, 'T1-F6-2', ['S2', 'S11'], '/checkout #search/#customer Combobox selects İsmail Işık and loads balance', async ctx => {
    const { cdp, app } = ctx;
    await fastSessionLogin(cdp, app.origin, app.employee, '/checkout');
    await searchAndSelectCombobox(cdp, '#customer', 'ismail', 'İsmail Işık');
    await cdp.until("!document.querySelector('#trade-controls')?.disabled && document.querySelector('#customer-balance')?.textContent.includes('İsmail Işık')", {
      label: 'customer balance loaded on checkout'
    });
    assert.equal(await cdp.evaluate("document.querySelector('#customer').value"), 'cari-cust-ismail');
    await cdp.assertCleanTelemetry();
  });

  add(1, 'T1-F6-3', ['S4'], '/checkout [data-product-search]/[data-product] Combobox selects product & focuses [data-quantity]', async ctx => {
    const { cdp, app } = ctx;
    await fastSessionLogin(cdp, app.origin, app.employee, '/checkout');
    const selectedProd = await searchAndSelectCombobox(cdp, '[data-product]', 'agri', 'AĞRI HAS ALTIN');
    assert.equal(selectedProd.ariaExpanded, 'false', 'Enter commit must close /checkout product Combobox listbox');
    assert.equal(await cdp.evaluate("document.querySelector('[data-product]').value"), 'stock-stk-agri');
    let active = await cdp.getActiveElementInfo();
    for (let i = 0; i < 2 && !active?.hasDataQuantity; i++) {
      await cdp.pressKey('Tab');
      await cdp.waitForDoubleRaf();
      active = await cdp.getActiveElementInfo();
    }
    assert.equal(active?.hasDataQuantity, true, 'Expected focus on [data-quantity] directly or via Tab after product selection');
    await cdp.assertCleanTelemetry();
  });

  add(1, 'T1-F6-4', ['S10'], '/checkout #open-customer-drawer creates zero-opening customer & selects it', async ctx => {
    const { cdp, app } = ctx;
    await fastSessionLogin(cdp, app.origin, app.employee, '/checkout');
    await cdp.clickSelector('#open-customer-drawer');
    await cdp.until("Boolean(document.querySelector('dialog.defter-drawer[open] #customer-form'))", {
      label: 'customer drawer open'
    });
    const newName = `Tezgah Yeni ${randomUUID().slice(0, 6)}`;
    await cdp.typeText(newName, { selector: '#customer-form input[name="name"]', clear: true });
    await cdp.typeText('05331110099', { selector: '#customer-form input[name="phone"]', clear: true });
    await cdp.clickSelector('#customer-form button.button');
    await cdp.until(
      `document.querySelector('#customer-balance')?.textContent.includes(${JSON.stringify(newName)})`,
      { timeoutMs: 10000, label: 'new customer created & selected' }
    );
    await cdp.assertCleanTelemetry();
  });

  add(1, 'T1-F6-5', ['S10'], 'Employee 2-stage #record -> #review -> #confirm commits sale with actor.role === employee', async ctx => {
    const { cdp, app } = ctx;
    await fastSessionLogin(cdp, app.origin, app.employee, '/checkout');
    await cdp.evaluate(`(() => {
      const prod = document.querySelector('[data-product]');
      prod.value = 'ceyrek';
      prod.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await cdp.typeText('1', { selector: '[data-item] [data-quantity]', clear: true });
    await cdp.typeText('5200', { selector: '[data-item] [data-value]', clear: true });
    await cdp.clickSelector('[data-add="received"][data-category="money"]');
    await cdp.evaluate(`(() => {
      const acc = document.querySelector('[data-allocation="received"] [data-account]');
      acc.value = 'nakit';
      acc.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await cdp.typeText('5200', { selector: '[data-allocation="received"] [data-quantity]', clear: true });
    await cdp.clickSelector('#record');
    await cdp.until("document.querySelector('#review')?.hidden === false", { label: 'checkout review visible' });
    await cdp.clickSelector('#confirm');
    await cdp.until("document.querySelector('#status')?.textContent.includes('İşlem kaydedildi')", {
      timeoutMs: 10000,
      label: 'checkout sale persisted'
    });
    const repo = app.openRepo('demo');
    try {
      const last = repo.state().journal.at(-1);
      assert.equal(last.type, 'sale');
      assert.equal(last.actor.role, 'employee');
    } finally {
      repo.close();
    }
    await cdp.assertCleanTelemetry();
  });

  // F7: Big Data Scale & Multi-Viewport Layout (5 cases)
  add(1, 'T1-F7-1', ['S12'], '5k customer + 2k stock + 120 supplier DOM option cap (<= 20 visible, backing select bounded)', async ctx => {
    const { cdp, bigApp5k } = ctx;
    await fastSessionLogin(cdp, bigApp5k.origin, bigApp5k.owner, '/owner#v=transaction');
    await focusComboboxFor(cdp, '#f-counterpartyId');
    await cdp.typeText('Sentetik', { clear: true });
    await waitForComboboxState(cdp, '#f-counterpartyId', 's => s.options.length >= 1', {
      label: '5k #f-counterpartyId options'
    });
    const partyInfo = await getComboboxContractInfo(cdp, '#f-counterpartyId');
    assert.ok(partyInfo.optionCount > 0 && partyInfo.optionCount <= 20, `Customer listbox options must be 1..20, got ${partyInfo.optionCount}`);
    assert.ok((partyInfo.backingOptionCount ?? 0) <= 50, `Backing <select> must NOT materialize 5,000 <option> nodes, got ${partyInfo.backingOptionCount}`);

    await focusComboboxFor(cdp, '[data-item-field="accountId"]');
    await cdp.typeText('SENTETIK', { clear: true });
    await waitForComboboxState(cdp, '[data-item-field="accountId"]', 's => s.options.length >= 1', {
      label: '2k [data-item-field="accountId"] options'
    });
    const stkInfo = await getComboboxContractInfo(cdp, '[data-item-field="accountId"]');
    assert.ok(stkInfo.optionCount > 0 && stkInfo.optionCount <= 20, `Stock listbox options must be 1..20, got ${stkInfo.optionCount}`);
    assert.ok((stkInfo.backingOptionCount ?? 0) <= 50, `Stock backing <select> must NOT materialize 2,000 <option> nodes, got ${stkInfo.backingOptionCount}`);
    await cdp.assertCleanTelemetry();
  });

  add(1, 'T1-F7-2', ['S12'], 'Total DOM node count remains bounded on 10k dataset', async ctx => {
    const { cdp, bigApp10k } = ctx;
    await fastSessionLogin(cdp, bigApp10k.origin, bigApp10k.owner, '/owner#v=transaction');
    const stats = await cdp.getDomStats();
    assert.ok(stats.elementCount < 3500, `DOM element explosion on 10k dataset: ${stats.elementCount}`);
    assert.ok(stats.domCounters.nodes < 8000, `DOM counter explosion on 10k dataset: ${stats.domCounters.nodes}`);
    await cdp.assertCleanTelemetry();
  });

  add(1, 'T1-F7-3', ['S12'], '1440x900 layout zero horizontal overflow with Palette & Combobox', async ctx => {
    const { cdp, app } = ctx;
    await cdp.setViewport(1440, 900);
    await fastSessionLogin(cdp, app.origin, app.owner, '/owner#v=transaction');
    await cdp.assertNoHorizontalOverflow('owner-1440');
    await openCommandPalette(cdp);
    await cdp.assertNoHorizontalOverflow('palette-1440');
    await cdp.pressKey('Escape');
    await cdp.assertCleanTelemetry();
  });

  add(1, 'T1-F7-4', ['S12'], '1100x900 layout zero horizontal overflow with Palette & Combobox', async ctx => {
    const { cdp, app } = ctx;
    await cdp.setViewport(1100, 900);
    await fastSessionLogin(cdp, app.origin, app.owner, '/owner#v=transaction');
    await cdp.assertNoHorizontalOverflow('owner-1100');
    await openCommandPalette(cdp);
    await cdp.assertNoHorizontalOverflow('palette-1100');
    await cdp.pressKey('Escape');
    await cdp.setViewport(1440, 900);
    await cdp.assertCleanTelemetry();
  });

  add(1, 'T1-F7-5', ['S12'], '390x844 mobile layout & Command Palette / Combobox bounding-box fit', async ctx => {
    const { cdp, app } = ctx;
    await cdp.setViewport(390, 844);
    await fastSessionLogin(cdp, app.origin, app.owner, '/owner#v=transaction');
    await cdp.assertNoHorizontalOverflow('owner-390');
    await openCommandPalette(cdp);
    const rect = await cdp.getBoundingRect('[data-command-palette]');
    assert.ok(rect && rect.left >= 0 && rect.right <= 390, `Command Palette overflows 390px viewport: ${JSON.stringify(rect)}`);
    await cdp.pressKey('Escape');
    await cdp.setViewport(1440, 900);
    await cdp.assertCleanTelemetry();
  });

  // =========================================================================
  // TIER 2 — Boundary & Corner Cases (34 cases)
  // =========================================================================

  // F2 (5 cases)
  add(2, 'T2-F2-1', ['S11'], 'Mixed Turkish/ASCII upper/lower pairs (İ/i, I/ı, Ğ/ğ, Ş/ş, Ç/ç, Ö/ö, Ü/ü)', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('transaction', 'sale');
    const pairs = [
      ['İSMAİL', 'İsmail Işık'],
      ['isik', 'İsmail Işık'],
      ['SEYMA GUNES', 'Şeyma Güneş'],
      ['OMER CELIK', 'Ömer Çelik'],
      ['UMIT ERDOGAN', 'Ümit Erdoğan']
    ];
    for (const [q, expected] of pairs) {
      await focusComboboxFor(cdp, '#f-counterpartyId');
      await cdp.typeText(q, { clear: true });
      await waitForComboboxState(
        cdp,
        '#f-counterpartyId',
        `s => s.options.some(o => o.textContent.includes(${JSON.stringify(expected)}))`,
        { timeoutMs: 3000, label: `Turkish pair "${q}" -> ${expected}` }
      ).catch(() => {});
      const info = await getComboboxContractInfo(cdp, '#f-counterpartyId');
      assert.ok(info.options.some(o => o.text.includes(expected)), `Pair "${q}" missed "${expected}": ${JSON.stringify(info.options)}`);
      await cdp.pressKey('Escape');
    }
    await cdp.assertCleanTelemetry();
  });

  add(2, 'T2-F2-2', ['S11'], '0-1 char short query vs 2+ char query on /api/customers?q=', async ctx => {
    const { origin, employee } = ctx.app;
    const session = await apiLogin(origin, employee.id, employee.password);
    for (const shortQ of ['', 'a', 'İ']) {
      const res = await fetch(`${origin}/api/customers?workspace=demo&q=${encodeURIComponent(shortQ)}`, {
        headers: { Authorization: `Bearer ${session.token}` }
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      const items = Array.isArray(body) ? body : body.items;
      assert.equal(items.length, 0, `Short query "${shortQ}" must return 0 matches`);
    }
    const res2 = await fetch(`${origin}/api/customers?workspace=demo&q=${encodeURIComponent('is')}`, {
      headers: { Authorization: `Bearer ${session.token}` }
    });
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    const items2 = Array.isArray(body2) ? body2 : body2.items;
    assert.ok(items2.some(i => i.name === 'İsmail Işık'), `2-char query "is" must match İsmail Işık`);
  });

  add(2, 'T2-F2-3', ['S11'], '100+ char overlong query truncation/rejection without crash', async ctx => {
    const { cdp, app } = ctx;
    const session = await apiLogin(app.origin, app.employee.id, app.employee.password);
    const longQ = 'İsmail'.repeat(30); // 180 chars
    const res = await fetch(`${app.origin}/api/customers?workspace=demo&q=${encodeURIComponent(longQ)}`, {
      headers: { Authorization: `Bearer ${session.token}` }
    });
    assert.ok([200, 400].includes(res.status), `Unexpected status ${res.status} for overlong /api/customers query`);

    await ctx.resetOwner('transaction', 'sale');
    await openCommandPalette(cdp);
    await cdp.typeText(longQ);
    await cdp.waitForDoubleRaf();
    await cdp.pressKey('Escape');
    await cdp.assertCleanTelemetry();
  });

  add(2, 'T2-F2-4', ['S11'], 'XSS payloads in search query & matching card names (zero execution, zero CSP violation)', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('accounts');
    await cdp.typeText('<img src=x', { selector: '#account-search', clear: true });
    await cdp.until(
      "(document.querySelector('#account-list [data-account-detail=\"cari-cust-xss-img\"]')?.textContent || '').includes('<img src=x')",
      { timeoutMs: 3000, label: 'XSS card rendered safely' }
    ).catch(() => {});
    const cardText = await cdp.evaluate("document.querySelector('#account-list [data-account-detail=\"cari-cust-xss-img\"]')?.textContent || ''");
    assert.ok(cardText.includes('<img src=x'), 'XSS card name must render safely as literal text');

    await ctx.resetOwner('transaction', 'sale');
    await openCommandPalette(cdp);
    await cdp.typeText('<img src=x onerror="window.__xss=99">');
    await cdp.waitForDoubleRaf();
    await cdp.pressKey('Escape');
    await cdp.assertCleanTelemetry();
  });

  add(2, 'T2-F2-5', ['S11'], '#summary-search Turkish normalization parity (gumus -> GÜMÜŞ, igdir -> Iğdır)', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('summary');
    await cdp.until("Boolean(document.querySelector('#summary-search')) && document.querySelectorAll('#summary-result tbody tr').length > 0", {
      label: 'summary loaded'
    });
    for (const [q, expected] of [
      ['gumus', 'GÜMÜŞ BİLEZİK'],
      ['igdir', 'Iğdır Kuyumculuk'],
      ['istanbul', 'İstanbul Sarrafiye']
    ]) {
      await cdp.typeText(q, { selector: '#summary-search', clear: true });
      await cdp.until(
        `(document.querySelector('#summary-result')?.textContent || '').includes(${JSON.stringify(expected)})`,
        { timeoutMs: 3000, label: `#summary-search "${q}" -> ${expected}` }
      ).catch(() => {});
      const rowsText = await cdp.evaluate("document.querySelector('#summary-result')?.textContent || ''");
      assert.ok(rowsText.includes(expected), `#summary-search "${q}" must match "${expected}"`);
    }
    await cdp.assertCleanTelemetry();
  });

  // F3 (7 cases)
  add(2, 'T2-F3-1', ['S6'], 'Empty / no-match Combobox state shows clear empty message', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('transaction', 'sale');
    await focusComboboxFor(cdp, '#f-counterpartyId');
    await cdp.typeText('ZZZ_OLMAYAN_MUSTERI_999', { clear: true });
    await waitForComboboxState(
      cdp,
      '#f-counterpartyId',
      "s => s.comboValue === 'ZZZ_OLMAYAN_MUSTERI_999' && s.options.length === 0 && /bulunamad|eşleş|0\\s*\\//i.test(s.statusText)",
      { timeoutMs: 3000, label: 'no-match combobox status' }
    ).catch(() => {});
    const info = await getComboboxContractInfo(cdp, '#f-counterpartyId');
    assert.equal(info.optionCount, 0, 'No-match query must render 0 [role="option"] items');
    assert.ok(
      info.statusText && /bulunamad|eşleş|0\s*\//i.test(info.statusText),
      `Expected clear empty message in [data-combobox-status], got ${JSON.stringify(info.statusText)}`
    );
    await cdp.assertCleanTelemetry();
  });

  add(2, 'T2-F3-2', ['S6'], 'Retired accounts (gramAdet, gramaltin, banka) cannot be selected in sale/purchase Combobox', async ctx => {
    const { cdp } = ctx;
    const assertRetiredProductExcluded = async (modeLabel) => {
      const selector = '[data-item-field="accountId"]';
      const searchGram = async () => {
        await focusComboboxFor(cdp, selector);
        await cdp.typeText('gram', { clear: true });
        await waitForComboboxState(
          cdp,
          selector,
          "s => s.ariaExpanded === 'true' && s.comboValue === 'gram' && (s.options.length >= 1 || /bulunamad|0\\s*\\//i.test(s.statusText))",
          { timeoutMs: 3000, label: `retired gram search (${modeLabel})` }
        ).catch(() => {});
      };
      await searchGram();
      const productInfo = await getComboboxContractInfo(cdp, selector);
      const enabledIndices = [];
      productInfo.options.forEach((opt, idx) => {
        if (opt.ariaDisabled !== 'true') {
          assert.ok(
            opt.value !== 'gramAdet' && opt.value !== 'gramaltin',
            `Retired product ${opt.value} must NOT be selectable in ${modeLabel}`
          );
          assert.equal(
            /günlük\s*adet|gramadet|gramaltin/i.test(opt.text),
            false,
            `Retired product "${opt.text}" must NOT be enabled in ${modeLabel}`
          );
          enabledIndices.push(idx);
        }
      });
      if (enabledIndices.length === 0) {
        await cdp.pressKey('Enter');
        await cdp.waitForDoubleRaf();
        const committed = await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).value`);
        assert.ok(
          committed !== 'gramAdet' && committed !== 'gramaltin',
          `Enter must NOT commit retired "${committed}" in ${modeLabel}`
        );
      } else {
        for (let k = 0; k < enabledIndices.length; k++) {
          if (k > 0) await searchGram();
          await cdp.pressKey('Home');
          for (let step = 0; step < k; step++) await cdp.pressKey('ArrowDown');
          await cdp.pressKey('Enter');
          await cdp.waitForDoubleRaf();
          const committed = await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).value`);
          assert.ok(
            committed !== 'gramAdet' && committed !== 'gramaltin',
            `Keyboard commit in ${modeLabel} selected retired product "${committed}" (option: ${JSON.stringify(productInfo.options[enabledIndices[k]])})`
          );
        }
      }
      await cdp.pressKey('Escape');
    };

    await ctx.resetOwner('transaction', 'sale');
    await assertRetiredProductExcluded('sale');

    await cdp.clickSelector('[data-add-allocation="payment"][data-payment-type="bank"]');
    const bankSel = '[data-allocation-kind="payment"] [data-allocation-field="accountId"]';
    const payCombo = await getComboboxContractInfo(cdp, bankSel);
    if (payCombo.comboboxFound) {
      const searchBank = async () => {
        await focusComboboxFor(cdp, bankSel);
        await cdp.typeText('Banka', { clear: true });
        await waitForComboboxState(
          cdp,
          bankSel,
          "s => s.ariaExpanded === 'true' && s.comboValue === 'Banka' && (s.options.length >= 1 || /bulunamad|0\\s*\\//i.test(s.statusText))",
          { timeoutMs: 3000, label: 'retired banka search' }
        ).catch(() => {});
      };
      await searchBank();
      const bankOpts = await getComboboxContractInfo(cdp, bankSel);
      const enabledBankIndices = [];
      bankOpts.options.forEach((o, idx) => {
        if (o.ariaDisabled !== 'true') {
          assert.notEqual(o.value, 'banka', 'Retired banka must NOT be selectable');
          assert.equal(
            /^(?:banka(?:\s*tl)?)(?:\s*·.*)?$/i.test(o.text),
            false,
            `Retired Banka TL option "${o.text}" must NOT be enabled`
          );
          enabledBankIndices.push(idx);
        }
      });
      if (enabledBankIndices.length === 0) {
        await cdp.pressKey('Enter');
        await cdp.waitForDoubleRaf();
        const committed = await cdp.evaluate(`document.querySelector(${JSON.stringify(bankSel)}).value`);
        assert.notEqual(committed, 'banka', 'Enter must NOT commit retired banka');
      } else {
        for (let k = 0; k < enabledBankIndices.length; k++) {
          if (k > 0) await searchBank();
          await cdp.pressKey('Home');
          for (let step = 0; step < k; step++) await cdp.pressKey('ArrowDown');
          await cdp.pressKey('Enter');
          await cdp.waitForDoubleRaf();
          const committed = await cdp.evaluate(`document.querySelector(${JSON.stringify(bankSel)}).value`);
          assert.notEqual(
            committed,
            'banka',
            `Keyboard commit selected retired banka (${JSON.stringify(bankOpts.options[enabledBankIndices[k]])})`
          );
        }
      }
      await cdp.pressKey('Escape');
    }

    await ctx.resetOwner('transaction', 'purchase');
    await assertRetiredProductExcluded('purchase');
    await cdp.assertCleanTelemetry();
  });

  add(2, 'T2-F3-3', ['S6'], '0-stock (saat, Sıfır Stok Kolye) & non-saleable (Alış Özel Ürün) non-selectable in sale Combobox', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('transaction', 'sale');
    for (const [q, forbiddenId] of [
      ['saat', 'saat'],
      ['Sıfır Stok', 'stock-stk-sifir'],
      ['Alış Özel', 'stock-stk-non-sale']
    ]) {
      await focusComboboxFor(cdp, '[data-item-field="accountId"]');
      await cdp.typeText(q, { clear: true });
      await waitForComboboxState(
        cdp,
        '[data-item-field="accountId"]',
        `s => s.comboValue === ${JSON.stringify(q)} && s.ariaExpanded === 'true' && (s.options.length >= 1 || /bulunamad|eşleş|0\\s*\\//i.test(s.statusText))`,
        { timeoutMs: 3000, label: `sale combobox "${q}"` }
      ).catch(() => {});
      const info = await getComboboxContractInfo(cdp, '[data-item-field="accountId"]');
      const enabledMatch = info.options.find(
        o => (o.value === forbiddenId || o.text.toLocaleLowerCase('tr-TR').includes(q.toLocaleLowerCase('tr-TR'))) && o.ariaDisabled !== 'true'
      );
      assert.equal(enabledMatch, undefined, `Item "${q}" (${forbiddenId}) must be excluded or aria-disabled="true" in sale Combobox`);
      await cdp.pressKey('Enter');
      await cdp.waitForDoubleRaf();
      const committed = await cdp.evaluate("document.querySelector('[data-item-field=\"accountId\"]').value");
      assert.notEqual(committed, forbiddenId, `Enter must NOT commit disabled/0-stock/non-saleable "${forbiddenId}"`);
      await cdp.pressKey('Escape');
    }
    await cdp.assertCleanTelemetry();
  });

  add(2, 'T2-F3-4', ['S3'], 'Same-name + same-prefix disambiguation selects exact intended ID', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('transaction', 'sale');
    await searchAndSelectCombobox(cdp, '#f-counterpartyId', 'Ahmet Yılmaz', 'Ahmet Yılmaz Kuyumcu');
    assert.equal(await cdp.evaluate("document.querySelector('#f-counterpartyId').value"), 'cari-cust-ahmet-kuyumcu');

    await searchAndSelectCombobox(cdp, '#f-counterpartyId', '05321112233', 'Ahmet Yılmaz');
    assert.equal(await cdp.evaluate("document.querySelector('#f-counterpartyId').value"), 'cari-cust-ahmet-tl');
    await cdp.assertCleanTelemetry();
  });

  add(2, 'T2-F3-5', ['S4'], '10.500 gram ambiguity still renders .amount-disambiguation & is NEVER bypassed by Combobox Enter', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('transaction', 'sale');
    await searchAndSelectCombobox(cdp, '[data-item-field="accountId"]', 'agri', 'AĞRI HAS ALTIN');
    await cdp.typeText('10.500', { selector: '[data-item-field="quantity"]', clear: true });
    await cdp.waitForDoubleRaf();
    const disambig = await cdp.evaluate(`(() => ({
      box: Boolean(document.querySelector('.amount-disambiguation')),
      hasThousands: Boolean(document.querySelector('[data-amount-choice="thousands"]')),
      hasDecimal: Boolean(document.querySelector('[data-amount-choice="decimal"]')),
      balanced: document.querySelector('#sale-form button[type="submit"]')?.dataset.balanced
    }))()`);
    assert.equal(disambig.box, true, '.amount-disambiguation must appear for 10.500');
    assert.equal(disambig.hasThousands, true);
    assert.equal(disambig.hasDecimal, true);
    assert.notEqual(disambig.balanced, 'true', 'Ambiguous 10.500 must NOT be treated as balanced');

    await cdp.clickSelector('[data-amount-choice="decimal"]');
    await cdp.waitForDoubleRaf();
    const resolved = await cdp.evaluate(`({
      boxGone: !document.querySelector('.amount-disambiguation'),
      res: document.querySelector('[data-item-field="quantity"]').dataset.amountResolution,
      canonical: document.querySelector('[data-item-field="quantity"]').dataset.canonicalAmount
    })`);
    assert.equal(resolved.boxGone, true);
    assert.equal(resolved.res, 'decimal');
    assert.equal(resolved.canonical, '10.500');
    await cdp.assertCleanTelemetry();
  });

  add(2, 'T2-F3-6', ['S11'], 'XSS payload inside stock/supplier card name renders via textContent safely', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('transaction', 'sale');
    await focusComboboxFor(cdp, '[data-item-field="accountId"]');
    await cdp.typeText('onerror', { clear: true });
    await waitForComboboxState(
      cdp,
      '[data-item-field="accountId"]',
      "s => s.options.some(o => o.textContent.toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').includes('<img'))",
      { timeoutMs: 3000, label: 'XSS option rendered safely' }
    ).catch(() => {});
    const info = await getComboboxContractInfo(cdp, '[data-item-field="accountId"]');
    const foldTr = s => String(s ?? '').toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i');
    assert.ok(
      info.options.some(o => foldTr(o.text).includes('<img src=x') && (o.text.includes('<İMG') || o.text.includes('<IMG') || o.text.includes('<img'))),
      `XSS stock name must appear as escaped text: ${JSON.stringify(info.options)}`
    );
    assert.equal(
      await cdp.evaluate("Boolean(document.querySelector('[role=\"listbox\"] img'))"),
      false,
      'XSS payload must not inject an <img> element into listbox DOM'
    );
    await cdp.pressKey('Escape');
    await cdp.assertCleanTelemetry();
  });

  add(2, 'T2-F3-7', ['S6'], 'Enter on invalid typed text in Combobox never mutates backing ID or submits form', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('transaction', 'sale');
    await searchAndSelectCombobox(cdp, '#f-counterpartyId', 'İsmail', 'İsmail Işık');
    const beforeId = await cdp.evaluate("document.querySelector('#f-counterpartyId').value");
    await focusComboboxFor(cdp, '#f-counterpartyId');
    await cdp.typeText('GECERSIZ_METIN_XYZ', { clear: true });
    await cdp.pressKey('Enter');
    await cdp.waitForDoubleRaf();
    const afterId = await cdp.evaluate("document.querySelector('#f-counterpartyId').value");
    assert.equal(afterId, beforeId, 'Invalid typed text + Enter must not corrupt committed backing ID');
    assert.equal(cdp.getRequests().filter(r => r.url.includes('/api/command') && r.method === 'POST').length, 0);
    await cdp.assertCleanTelemetry();
  });

  // F4 (6 cases)
  add(2, 'T2-F4-1', ['S1'], 'Command Palette empty search state [data-command-palette-empty]', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('overview');
    await openCommandPalette(cdp);
    await cdp.typeText('OLMAYAN_KOMUT_XYZ_987');
    await cdp.until(
      "Boolean(document.querySelector('[data-command-palette-empty]:not([hidden])'))",
      { timeoutMs: 3000, label: '[data-command-palette-empty] visible' }
    );
    await cdp.pressKey('Escape');
    await cdp.assertCleanTelemetry();
  });

  add(2, 'T2-F4-2', ['S10'], 'Command Palette error state [data-command-palette-error] when async search fails', async ctx => {
    const { cdp, app } = ctx;
    await fastSessionLogin(cdp, app.origin, app.employee, '/checkout');
    let checkoutIntercepted = 0;
    await cdp.withAllowedHttpStatuses([500], async () => {
      await cdp.call('Fetch.enable', { patterns: [{ urlPattern: '*/api/customers*' }] });
      const off = cdp.on('Fetch.requestPaused', p => {
        checkoutIntercepted++;
        void cdp.call('Fetch.fulfillRequest', {
          requestId: p.requestId,
          responseCode: 500,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
          body: Buffer.from(JSON.stringify({ error: 'Sentetik arama hatası' })).toString('base64')
        }).catch(() => {});
      });
      try {
        await openCommandPalette(cdp);
        await cdp.typeText('ismail');
        await delay(400);
        if (checkoutIntercepted > 0) {
          await cdp.until(
            "Boolean(document.querySelector('[data-command-palette-error]:not([hidden])')?.textContent.trim())",
            { timeoutMs: 4000, label: '[data-command-palette-error] visible on /checkout API 500' }
          );
        }
        await cdp.pressKey('Escape');
      } finally {
        off();
        await cdp.call('Fetch.disable').catch(() => {});
      }
    });

    if (checkoutIntercepted === 0) {
      await ctx.resetOwner('overview');
      let ownerIntercepted = 0;
      await cdp.withAllowedHttpStatuses([500], async () => {
        await cdp.call('Fetch.enable', { patterns: [{ urlPattern: '*/api/*' }] });
        const off = cdp.on('Fetch.requestPaused', p => {
          ownerIntercepted++;
          void cdp.call('Fetch.fulfillRequest', {
            requestId: p.requestId,
            responseCode: 500,
            responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
            body: Buffer.from(JSON.stringify({ error: 'Sentetik arama hatası' })).toString('base64')
          }).catch(() => {});
        });
        try {
          await openCommandPalette(cdp);
          await cdp.typeText('ismail');
          await delay(400);
          if (ownerIntercepted > 0) {
            await cdp.until(
              "Boolean(document.querySelector('[data-command-palette-error]:not([hidden])')?.textContent.trim())",
              { timeoutMs: 4000, label: '[data-command-palette-error] visible on /owner API 500' }
            );
          } else {
            const hasErrorSlot = await cdp.evaluate("Boolean(document.querySelector('[data-command-palette] [data-command-palette-error]'))");
            assert.equal(hasErrorSlot, true, 'Static Command Palette must still expose [data-command-palette-error] contract container');
            await cdp.typeText('OLMAYAN_999', { clear: true });
            await cdp.until(
              "Boolean(document.querySelector('[data-command-palette-empty]:not([hidden])'))",
              { timeoutMs: 3000, label: '[data-command-palette-empty] visible for no-match query' }
            );
          }
          await cdp.pressKey('Escape');
        } finally {
          off();
          await cdp.call('Fetch.disable').catch(() => {});
        }
      });
    }
    await cdp.assertCleanTelemetry();
  });

  add(2, 'T2-F4-3', ['S7'], 'Ctrl+K blocked or safely inert when body[aria-busy="true"]', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('overview');
    await openCommandPalette(cdp);
    await cdp.pressKey('Escape');
    await cdp.until("!document.querySelector('[data-command-palette][open]')", { label: 'palette closed before busy' });
    await cdp.call('Fetch.enable', { patterns: [{ urlPattern: '*/api/state*' }] });
    let pausedId = null;
    const off = cdp.on('Fetch.requestPaused', p => {
      pausedId = p.requestId;
    });
    try {
      await cdp.evaluate("document.querySelector('#refresh').click()");
      await cdp.until("document.body.getAttribute('aria-busy') === 'true'", { label: 'aria-busy true' });
      await cdp.pressKey('k', { ctrl: true });
      await delay(150);
      const openedDuringBusy = await cdp.evaluate("Boolean(document.querySelector('[data-command-palette][open]'))");
      assert.equal(openedDuringBusy, false, 'Ctrl+K must NOT open Command Palette while body[aria-busy="true"]');
    } finally {
      off();
      if (pausedId) await cdp.call('Fetch.continueRequest', { requestId: pausedId }).catch(() => {});
      await cdp.call('Fetch.disable').catch(() => {});
    }
    await cdp.until("document.body.getAttribute('aria-busy') !== 'true'", { label: 'busy cleared' });
    await cdp.assertCleanTelemetry();
  });

  add(2, 'T2-F4-4', ['S8'], 'Ctrl+K blocks navigation when pending uncertain transaction exists', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('transaction', 'sale');
    // Verify palette works before pending exists (non-vacuous guard)
    await openCommandPalette(cdp);
    await cdp.pressKey('Escape');
    await cdp.until("!document.querySelector('[data-command-palette][open]')", { label: 'palette closed before pending' });

    await searchAndSelectCombobox(cdp, '[data-item-field="accountId"]', 'ceyrek', 'ÇEYREK');
    await cdp.typeText('1', { selector: '[data-item-field="quantity"]', clear: true });
    await cdp.typeText('5000', { selector: '[data-item-field="value"]', clear: true });
    await cdp.clickSelector('[data-quick-fill-cash]');

    await cdp.withAllowedNetworkFailures(async () => {
      await cdp.call('Fetch.enable', { patterns: [{ urlPattern: '*/api/command*' }] });
      const failPromises = [];
      let sawPaused = false;
      const seenNetworkIds = new Set();
      let resolveLoadingFailed;
      const loadingFailedPromise = new Promise(resolve => { resolveLoadingFailed = resolve; });
      const offFail = cdp.on('Network.loadingFailed', params => {
        if (!params || params.canceled || params.errorText === 'net::ERR_ABORTED') return;
        if (seenNetworkIds.size === 0 || seenNetworkIds.has(params.requestId)) {
          resolveLoadingFailed();
        }
      });
      const off = cdp.on('Fetch.requestPaused', p => {
        sawPaused = true;
        if (p.networkId) seenNetworkIds.add(p.networkId);
        failPromises.push(cdp.call('Fetch.failRequest', { requestId: p.requestId, errorReason: 'Failed' }).catch(() => {}));
      });
      try {
        await cdp.clickSelector('#sale-form button[type="submit"]');
        await cdp.until("document.querySelector('#retry-bar')?.hidden === false", {
          timeoutMs: 8000,
          label: 'pending retry-bar visible'
        });
        await cdp.until("document.body.getAttribute('aria-busy') !== 'true'", {
          timeoutMs: 8000,
          label: 'aria-busy cleared after failed command'
        });
        await Promise.all(failPromises);
        if (sawPaused) {
          await Promise.race([loadingFailedPromise, delay(2000)]);
        }
      } finally {
        off();
        offFail();
        await cdp.call('Fetch.disable').catch(() => {});
      }
    });

    const hashBefore = await cdp.evaluate('location.hash');
    await cdp.pressKey('k', { ctrl: true });
    await delay(150);
    const open = await cdp.evaluate("Boolean(document.querySelector('[data-command-palette][open]'))");
    if (open) {
      await cdp.typeText('musteri');
      await delay(100);
      await cdp.pressKey('ArrowDown');
      await cdp.pressKey('Enter');
      await delay(150);
    }
    const hashAfter = await cdp.evaluate('location.hash');
    assert.equal(hashAfter, hashBefore, 'Pending uncertain transaction must block Ctrl+K navigation');
    await cdp.evaluate(`(() => {
      const keep = sessionStorage.getItem('defter-session');
      sessionStorage.clear();
      if (keep) sessionStorage.setItem('defter-session', keep);
    })()`);
    await cdp.assertCleanTelemetry();
  });

  add(2, 'T2-F4-5', ['S10'], 'Ctrl+K gates unauthorized views when !state.initialized or state.nominalUnconfirmed', async ctx => {
    const uninitApp = await createIsolatedApp({ prefix: 'paket6b-uninit-', seedFn: seedUninitializedLedger });
    try {
      await fastSessionLogin(ctx.cdp, uninitApp.origin, uninitApp.owner, '/owner');
      await ctx.cdp.pressKey('k', { ctrl: true });
      await delay(200);
      const uninitPal = await ctx.cdp.evaluate(`(() => {
        const dlg = document.querySelector('[data-command-palette][open]');
        const opts = dlg ? [...dlg.querySelectorAll('[data-command-palette-list] [role="option"]')].map(o => ({
          text: ((o.dataset.commandId || '') + ' ' + o.textContent.trim()).trim(),
          disabled: o.getAttribute('aria-disabled') === 'true'
        })) : [];
        const emptyVisible = Boolean(dlg?.querySelector('[data-command-palette-empty]:not([hidden])'));
        const errorVisible = Boolean(dlg?.querySelector('[data-command-palette-error]:not([hidden])'));
        return { open: Boolean(dlg), opts, emptyVisible, errorVisible };
      })()`);
      if (uninitPal.open) {
        const enabledOpts = uninitPal.opts.filter(o => !o.disabled);
        assert.ok(
          enabledOpts.length >= 1 || uninitPal.emptyVisible || uninitPal.errorVisible || uninitPal.opts.every(o => o.disabled),
          `Uninitialized palette opened in blank/invalid state: ${JSON.stringify(uninitPal)}`
        );
        assert.ok(
          !enabledOpts.some(o => /transaction|closing|satis|alis|kapanis|satış|alış|kapanış/i.test(o.text)),
          `Uninitialized ledger must not expose trade/closing commands: ${JSON.stringify(enabledOpts)}`
        );
        await ctx.cdp.typeText('satis');
        await ctx.cdp.waitForDoubleRaf();
        const afterSearch = await ctx.cdp.evaluate(`[...document.querySelectorAll('[data-command-palette-list] [role="option"]')].filter(o => o.getAttribute('aria-disabled') !== 'true').map(o => ((o.dataset.commandId || '') + ' ' + o.textContent.trim()).trim())`);
        assert.ok(
          !afterSearch.some(t => /transaction|closing|satis|alis|kapanis|satış|alış|kapanış/i.test(t)),
          `Uninitialized ledger leaked trade/closing command on search "satis": ${JSON.stringify(afterSearch)}`
        );
        await ctx.cdp.pressKey('Escape');
      }
      await ctx.cdp.assertCleanTelemetry();
    } finally {
      await ctx.cdp.navigate('about:blank').catch(() => {});
      await uninitApp.close();
    }

    const nomApp = await createIsolatedApp({ prefix: 'paket6b-nom-', seedFn: seedNominalUnconfirmedLedger });
    try {
      await fastSessionLogin(ctx.cdp, nomApp.origin, nomApp.owner, '/owner');
      await ctx.cdp.until("Boolean(document.querySelector('#nominal-opening-form'))", { label: 'nominal gate visible' });
      await openCommandPalette(ctx.cdp);
      await ctx.cdp.typeText('gram');
      await ctx.cdp.waitForDoubleRaf();
      const opts = await ctx.cdp.evaluate("[...document.querySelectorAll('[data-command-palette-list] [role=\"option\"]')].map(o => (o.dataset.commandId || '') + ' ' + o.textContent)");
      assert.ok(!opts.some(t => /gramToplam|GRAM ALTIN/i.test(t)), `Nominal unconfirmed must gate gramToplam: ${JSON.stringify(opts)}`);
      await ctx.cdp.pressKey('Escape');
      await ctx.cdp.assertCleanTelemetry();
    } finally {
      await ctx.cdp.navigate('about:blank').catch(() => {});
      await nomApp.close();
    }
  });

  add(2, 'T2-F4-6', ['S1'], 'Ctrl+K rapid repeated toggle leaves clean focus & history stack', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('overview');
    const histBefore = await cdp.evaluate('history.length');
    await cdp.focusSelector('#refresh');
    for (let i = 0; i < 3; i++) {
      await openCommandPalette(cdp);
      await cdp.pressKey('k', { ctrl: true });
      await cdp.until("!document.querySelector('[data-command-palette][open]')", { label: 'toggled closed' });
    }
    await delay(300);
    const active = await cdp.getActiveElementInfo();
    const histAfter = await cdp.evaluate('history.length');
    assert.equal(active.id, 'refresh', 'Trigger focus must stay intact after rapid toggles');
    assert.ok(Math.abs(histAfter - histBefore) <= 1, `History stack leaked across rapid toggles: ${histBefore} -> ${histAfter}`);
    await cdp.assertCleanTelemetry();
  });

  // F5 (6 cases)
  add(2, 'T2-F5-1', ['S8'], 'Dirty sale draft preserved across Ctrl+K navigation + return, zero /api/command sent', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('transaction', 'sale');
    await searchAndSelectCombobox(cdp, '#f-counterpartyId', 'İsmail', 'İsmail Işık');
    await cdp.typeText('Taslak Notu 6B', { selector: '#f-note', clear: true });
    cdp.clearRequests();

    await openCommandPalette(cdp);
    await selectCommandPaletteOption(cdp, 'musteri', 'Müşteri', { excludeTexts: ['alış', 'ekle', 'yeni'] });
    await cdp.until("location.hash.includes('v=accounts')", { label: 'navigated away' });

    assert.equal(cdp.getRequests().filter(r => r.url.includes('/api/command') && r.method === 'POST').length, 0);

    await openCommandPalette(cdp);
    await selectCommandPaletteOption(cdp, 'satis', 'Satış', { excludeTexts: ['toptancı', 'alış'] });
    await cdp.until("Boolean(document.querySelector('#sale-form'))", { label: 'returned to sale' });

    const restored = await cdp.evaluate(`({
      party: document.querySelector('#f-counterpartyId')?.value,
      note: document.querySelector('#f-note')?.value
    })`);
    assert.equal(restored.party, 'cari-cust-ismail', 'Selected customer must persist across Ctrl+K navigation');
    assert.equal(restored.note, 'Taslak Notu 6B', 'Sale note draft must persist across Ctrl+K navigation');
    await cdp.assertCleanTelemetry();
  });

  add(2, 'T2-F5-2', ['S9'], 'Dirty sale draft preserved across F5 (Page.reload + beforeunload handling)', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('transaction', 'sale');
    await searchAndSelectCombobox(cdp, '#f-counterpartyId', 'İsmail', 'İsmail Işık');
    await cdp.typeText('F5 Taslak Notu', { selector: '#f-note', clear: true });
    cdp.clearDialogs();
    await cdp.reload();
    await cdp.until("Boolean(document.querySelector('#sale-form'))", { label: 'sale form reloaded' });
    const dialogs = cdp.getDialogs();
    assert.ok(dialogs.some(d => d.type === 'beforeunload'), 'Expected beforeunload dialog on dirty draft reload');
    const restored = await cdp.evaluate(`({
      party: document.querySelector('#f-counterpartyId')?.value,
      note: document.querySelector('#f-note')?.value
    })`);
    assert.equal(restored.party, 'cari-cust-ismail', 'Customer selection must restore after F5');
    assert.equal(restored.note, 'F5 Taslak Notu', 'Note draft must restore after F5');
    await cdp.assertCleanTelemetry();
  });

  add(2, 'T2-F5-3', ['S8'], '409 REVISION_CONFLICT during stale draft triggers [data-draft-stale] and blocks submit until review', async ctx => {
    const { cdp, app } = ctx;
    await ctx.resetOwner('transaction', 'sale');
    await searchAndSelectCombobox(cdp, '#f-counterpartyId', 'Ümit', 'Ümit Erdoğan');
    await searchAndSelectCombobox(cdp, '[data-item-field="accountId"]', 'ceyrek', 'ÇEYREK');
    await cdp.typeText('1', { selector: '[data-item-field="quantity"]', clear: true });
    await cdp.typeText('4900', { selector: '[data-item-field="value"]', clear: true });
    await cdp.clickSelector('[data-quick-fill-cash]');

    // Mutate revision out-of-band
    const repo = app.openRepo('demo');
    try {
      const s = repo.state();
      repo.execute({
        id: `oob-rev-${randomUUID()}`,
        revision: s.revision,
        command: { type: 'movement', date: s.date, accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '1', note: 'OOB bump' }
      });
    } finally {
      repo.close();
    }

    await cdp.withAllowedHttpStatuses([409], async () => {
      await cdp.clickSelector('#sale-form button[type="submit"]');
      await cdp.until("Boolean(document.querySelector('p[data-draft-stale]')) && document.querySelector('#sale-form')?.dataset.draftStale === 'true'", {
        timeoutMs: 10000,
        label: 'p[data-draft-stale] shown after 409'
      });
    });
    const submitDisabled = await cdp.evaluate("document.querySelector('#sale-form button[type=\"submit\"]')?.disabled");
    assert.equal(submitDisabled, true, 'Submit must be disabled while draft is stale');
    await cdp.clickSelector('[data-review-draft]');
    await cdp.until("!document.querySelector('p[data-draft-stale]') && document.querySelector('#sale-form')?.dataset.draftStale !== 'true' && document.querySelector('#sale-form button[type=\"submit\"]')?.disabled === false", {
      label: 'stale cleared after review'
    });
    await cdp.assertCleanTelemetry();
  });

  add(2, 'T2-F5-4', ['S6'], 'DISABLED_ENTITY draft restoration flags retired/disabled entity without allowing submit', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('transaction', 'sale');
    await cdp.evaluate(`(() => {
      for (const f of document.querySelectorAll('form[data-draft-dirty]')) f.dataset.draftDirty = 'false';
      const actorId = window.DefterSession.current().actor.id;
      const key = window.DefterDraftStore.makeKey({ actorId, workspace: 'demo', scope: 'retail', type: 'sale' });
      window.DefterDraftStore.saveDraft(key, {
        meta: { actorId, workspace: 'demo', workday: '2026-11-10', revision: 999999, formId: 'sale-form' },
        data: { fields: { counterpartyId: 'banka', note: 'Devre dışı' }, sale: { items: [{ accountId: 'gramAdet', quantity: '1', value: '100' }], payment: [] } }
      });
    })()`);
    await cdp.reload();
    await cdp.until("Boolean(document.querySelector('p[data-draft-stale]')) && document.querySelector('#sale-form')?.dataset.draftStale === 'true'", { label: 'DISABLED_ENTITY stale bar shown' });
    const state = await cdp.evaluate(`({
      submitDisabled: document.querySelector('#sale-form button[type="submit"]')?.disabled,
      hasReviewBtn: Boolean(document.querySelector('[data-review-draft]'))
    })`);
    assert.equal(state.submitDisabled, true, 'DISABLED_ENTITY draft must disable submit');
    assert.equal(state.hasReviewBtn, false, 'DISABLED_ENTITY draft must not offer review bypass');
    await cdp.clickSelector('[data-clear-draft]');
    await cdp.assertCleanTelemetry();
  });

  add(2, 'T2-F5-5', ['S9'], 'Invalid/missing #v=accounts&id=nonexistent or #v=edit on F5 degrades gracefully without crash', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('accounts');
    await cdp.evaluate("location.hash = '#v=accounts&id=nonexistent_id_999'");
    await cdp.reload();
    await cdp.until("location.pathname === '/owner' && !document.querySelector('#main .loading')", { label: 'accounts degraded cleanly' });
    assert.equal(await cdp.evaluate("document.querySelector('#account-detail')?.hidden"), true);

    await cdp.evaluate("location.hash = '#v=edit'");
    await cdp.reload();
    await cdp.until("location.pathname === '/owner' && !document.querySelector('#main .loading')", { label: 'edit degraded cleanly' });
    await cdp.assertCleanTelemetry();
  });

  add(2, 'T2-F5-6', ['S8'], 'Workspace switch (demo <-> dukkan) isolates Combobox/Palette datasets and drafts', async ctx => {
    const dualApp = await createIsolatedApp({ prefix: 'paket6b-dual-', seedFn: seedFunctionalLedger, dualWorkspace: true });
    try {
      await fastSessionLogin(ctx.cdp, dualApp.origin, dualApp.owner, '/owner#v=transaction');
      await searchAndSelectCombobox(ctx.cdp, '#f-counterpartyId', 'İsmail', 'İsmail Işık');
      await ctx.cdp.evaluate(`(() => {
        const ws = document.querySelector('#workspace');
        ws.value = 'dukkan';
        ws.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await ctx.cdp.until(
        "localStorage.getItem('defter-workspace') === 'dukkan' && document.body.getAttribute('aria-busy') !== 'true' && !document.querySelector('#main .loading') && Boolean(document.querySelector('#f-counterpartyId'))",
        { label: 'switched to dukkan' }
      );
      await ctx.cdp.waitForDoubleRaf();
      await focusComboboxFor(ctx.cdp, '#f-counterpartyId');
      await ctx.cdp.typeText('Dükkân Özel', { clear: true });
      await waitForComboboxState(
        ctx.cdp,
        '#f-counterpartyId',
        "s => s.options.some(o => o.textContent.includes('Dükkân Özel Müşteri'))",
        { timeoutMs: 3000, label: 'dukkan customer option' }
      ).catch(() => {});
      const dukkanInfo = await getComboboxContractInfo(ctx.cdp, '#f-counterpartyId');
      assert.ok(dukkanInfo.options.some(o => o.text.includes('Dükkân Özel Müşteri')), 'dukkan workspace must show Dükkân Özel Müşteri');
      assert.equal(dukkanInfo.backingValue, '', 'dukkan workspace must NOT inherit demo selected counterparty');
      await ctx.cdp.pressKey('Escape');

      await openCommandPalette(ctx.cdp);
      await ctx.cdp.typeText('İsmail Işık');
      await ctx.cdp.waitForDoubleRaf();
      const crossLeak = await ctx.cdp.evaluate("[...document.querySelectorAll('[data-command-palette-list] [role=\"option\"]')].some(o => o.textContent.includes('İsmail Işık'))");
      assert.equal(crossLeak, false, 'dukkan palette must NOT leak demo customer İsmail Işık');
      await ctx.cdp.pressKey('Escape');

      await ctx.cdp.evaluate(`(() => {
        const ws = document.querySelector('#workspace');
        ws.value = 'demo';
        ws.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await ctx.cdp.until(
        "localStorage.getItem('defter-workspace') === 'demo' && document.body.getAttribute('aria-busy') !== 'true' && !document.querySelector('#main .loading') && Boolean(document.querySelector('#f-counterpartyId'))",
        { label: 'switched back to demo' }
      );
      await ctx.cdp.waitForDoubleRaf();
      const demoRestored = await getComboboxContractInfo(ctx.cdp, '#f-counterpartyId');
      assert.equal(demoRestored.backingValue, 'cari-cust-ismail', 'switching back to demo must restore demo draft counterparty');
      await openCommandPalette(ctx.cdp);
      await ctx.cdp.typeText('Dükkân Özel');
      await ctx.cdp.waitForDoubleRaf();
      const backLeak = await ctx.cdp.evaluate("[...document.querySelectorAll('[data-command-palette-list] [role=\"option\"]')].some(o => o.textContent.includes('Dükkân Özel'))");
      assert.equal(backLeak, false, 'demo palette must NOT leak dukkan customer Dükkân Özel Müşteri');
      await ctx.cdp.pressKey('Escape');
      await ctx.cdp.assertCleanTelemetry();
    } finally {
      await ctx.cdp.navigate('about:blank').catch(() => {});
      await dualApp.close();
    }
  });

  // F6 (5 cases)
  add(2, 'T2-F6-1', ['S10'], 'Employee Ctrl+K excludes ALL owner views (suppliers, journal, closing, summary, backup, users, banks)', async ctx => {
    const { cdp, app } = ctx;
    await fastSessionLogin(cdp, app.origin, app.employee, '/checkout');
    await openCommandPalette(cdp);
    const forbidden = ['Toptancı', 'Günlük İşlem', 'Kapanış', 'Özet', 'Yedek', 'Çalışan', 'Banka/Pos/Kasa', 'suppliers', 'journal', 'closing', 'summary', 'backup', 'users', 'banks'];
    const getPalOpts = () => cdp.evaluate("[...document.querySelectorAll('[data-command-palette-list] [role=\"option\"]')].map(o => ((o.dataset.commandId || '') + ' ' + o.textContent.trim()).trim())");
    const initialOpts = await getPalOpts();
    assert.ok(initialOpts.length >= 1, 'Employee Command Palette must render >= 1 allowed command on open (non-vacuous check)');
    const assertNoForbidden = (opts, contextLabel) => {
      const joined = opts.join('\n').toLocaleLowerCase('tr-TR');
      for (const term of forbidden) {
        assert.equal(joined.includes(term.toLocaleLowerCase('tr-TR')), false, `Employee palette leaked forbidden item "${term}" (${contextLabel}): ${JSON.stringify(opts)}`);
      }
    };
    assertNoForbidden(initialOpts, 'initial open');
    for (const kw of ['toptan', 'kapanis', 'gunluk', 'ozet', 'yedek']) {
      await cdp.typeText(kw, { clear: true });
      await cdp.waitForDoubleRaf();
      const filteredOpts = await getPalOpts();
      assertNoForbidden(filteredOpts, `query="${kw}"`);
    }
    await cdp.pressKey('Escape');
    await cdp.assertCleanTelemetry();
  });

  add(2, 'T2-F6-2', ['S10'], 'Employee /checkout Combobox & /api/customers NEVER return suppliers, retired accounts, or fund balances', async ctx => {
    const { cdp, app } = ctx;
    const empSession = await apiLogin(app.origin, app.employee.id, app.employee.password);
    // 1. Direct API non-vacuous positive + negative isolation checks
    const posRes = await fetch(`${app.origin}/api/customers?workspace=demo&q=${encodeURIComponent('ismail')}`, {
      headers: { Authorization: `Bearer ${empSession.token}` }
    });
    assert.equal(posRes.status, 200);
    const posBody = await posRes.json();
    const posItems = Array.isArray(posBody) ? posBody : posBody.items;
    assert.ok(posItems.some(i => i.id === 'cari-cust-ismail'), 'Positive /api/customers check failed for "ismail"');

    for (const q of ['Özgür', 'Gram', 'gramAdet', 'Banka', 'Nakit']) {
      const res = await fetch(`${app.origin}/api/customers?workspace=demo&q=${encodeURIComponent(q)}`, {
        headers: { Authorization: `Bearer ${empSession.token}` }
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      const items = Array.isArray(body) ? body : body.items;
      assert.equal(
        items.some(i =>
          /özgür|ozgur|gram|banka|nakit/i.test(String(i.name || '')) ||
          String(i.id).includes('supplier') ||
          ['gramAdet', 'gramaltin', 'gramToplam', 'banka', 'nakit', 'fund-ziraat'].includes(i.id)
        ),
        false,
        `Direct /api/customers?q=${q} leaked non-customer entity: ${JSON.stringify(items)}`
      );
    }

    // 2. UI Combobox check waiting for actual /api/customers network completion (no brittle 250ms sleep)
    await fastSessionLogin(cdp, app.origin, app.employee, '/checkout');
    const custReqIds = new Set();
    let custFinished = 0;
    const offReq = cdp.on('Network.requestWillBeSent', p => {
      if (p?.request?.url?.includes('/api/customers')) custReqIds.add(p.requestId);
    });
    const offFin = cdp.on('Network.loadingFinished', p => {
      if (custReqIds.has(p?.requestId)) custFinished++;
    });
    try {
      for (const q of ['Özgür', 'Gram', 'Banka', 'Nakit']) {
        const beforeFin = custFinished;
        await focusComboboxFor(cdp, '#customer');
        await cdp.typeText(q, { clear: true });
        await cdp.waitFor(() => custFinished > beforeFin, { timeoutMs: 3000, label: `/api/customers completion for "${q}"` });
        await cdp.waitForDoubleRaf();
        const info = await getComboboxContractInfo(cdp, '#customer');
        const leaked = info.options.filter(o =>
          o.ariaDisabled !== 'true' && (
            /özgür|ozgur|gram\s*alt[ıi]n|gramadet|banka|nakit/i.test(o.text) ||
            o.value.includes('supplier') ||
            ['gramAdet', 'gramaltin', 'gramToplam', 'banka', 'nakit', 'fund-ziraat'].includes(o.value)
          )
        );
        assert.equal(
          leaked.length,
          0,
          `Employee customer Combobox leaked enabled non-customer option for "${q}": ${JSON.stringify(leaked)}`
        );
        if (info.options.length > 0) {
          await cdp.pressKey('ArrowDown');
          await cdp.pressKey('Enter');
          await cdp.waitForDoubleRaf();
          const committed = await cdp.evaluate("document.querySelector('#customer').value");
          assert.equal(committed, '', `Employee #customer committed unexpected value "${committed}" for probe "${q}"`);
        }
        await cdp.pressKey('Escape');
      }
    } finally {
      offReq();
      offFin();
    }
    await cdp.assertCleanTelemetry();
  });

  add(2, 'T2-F6-3', ['S10'], 'Direct API probes with employee token to /api/state, /api/journal, /api/suppliers, close, costTL return 403', async ctx => {
    const { origin, employee } = ctx.app;
    const session = await apiLogin(origin, employee.id, employee.password);
    const headers = { Authorization: `Bearer ${session.token}` };

    for (const path of ['/api/state?workspace=demo', '/api/journal?workspace=demo', '/api/suppliers?workspace=demo', '/api/summary?workspace=demo']) {
      const r = await fetch(origin + path, { headers });
      assert.equal(r.status, 403, `Expected 403 on ${path} for employee, got ${r.status}`);
    }
    const rClose = await fetch(`${origin}/api/command?workspace=demo`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ id: randomUUID(), revision: 1, command: { type: 'close', date: '2026-11-10', counts: {}, reasons: {} } })
    });
    assert.equal(rClose.status, 403, 'Expected 403 for employee close command');

    const rCost = await fetch(`${origin}/api/command?workspace=demo`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({
        id: randomUUID(),
        revision: 1,
        command: {
          type: 'sale',
          date: '2026-11-10',
          counterpartyType: 'customer',
          counterpartyId: 'cari-cust-ismail',
          items: [{ accountId: 'ceyrek', quantity: '1', value: '5000' }],
          salePricing: { version: 1, lines: [{ quotedTL: '5000', costTL: '4000' }] },
          received: [{ accountId: 'nakit', quantity: '5000', valueTL: '5000' }],
          given: [],
          credits: [],
          debts: []
        }
      })
    });
    assert.equal(rCost.status, 403, 'Expected 403 for employee costTL injection');
  });

  add(2, 'T2-F6-4', ['S10'], 'Employee navigating to /owner or /users is locked out to /', async ctx => {
    const { cdp, app } = ctx;
    await fastSessionLogin(cdp, app.origin, app.employee, '/checkout');
    await cdp.navigate(app.origin + '/owner');
    await cdp.until("location.pathname === '/'", { timeoutMs: 8000, label: 'employee redirected from /owner' });
    await fastSessionLogin(cdp, app.origin, app.employee, '/checkout');
    await cdp.navigate(app.origin + '/users');
    await cdp.until("location.pathname === '/'", { timeoutMs: 8000, label: 'employee redirected from /users' });
    await cdp.assertCleanTelemetry();
  });

  add(2, 'T2-F6-5', ['S8'], 'Employee /checkout external revision / 409 stale draft triggers #draft-stale and disables #record', async ctx => {
    const { cdp, app } = ctx;
    await fastSessionLogin(cdp, app.origin, app.employee, '/checkout');
    await cdp.typeText('1', { selector: '[data-item] [data-quantity]', clear: true });
    await cdp.typeText('5000', { selector: '[data-item] [data-value]', clear: true });
    await cdp.clickSelector('[data-add="received"][data-category="money"]');
    await cdp.evaluate("const a = document.querySelector('[data-allocation=\"received\"] [data-account]'); a.value='nakit'; a.dispatchEvent(new Event('change',{bubbles:true}));");
    await cdp.typeText('5000', { selector: '[data-allocation="received"] [data-quantity]', clear: true });
    await cdp.clickSelector('#record');
    await cdp.until("document.querySelector('#review')?.hidden === false", { label: 'review open before 409' });

    const repo = app.openRepo('demo');
    try {
      const s = repo.state();
      repo.execute({
        id: `t2-f6-5-oob-${randomUUID()}`,
        revision: s.revision,
        command: { type: 'movement', date: s.date, accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '1', note: 'Checkout OOB bump' }
      });
    } finally {
      repo.close();
    }

    await cdp.withAllowedHttpStatuses([409], async () => {
      await cdp.clickSelector('#confirm');
      await cdp.until("document.querySelector('#draft-stale')?.hidden === false", {
        timeoutMs: 8000,
        label: '#draft-stale visible after 409'
      });
    });
    assert.equal(await cdp.evaluate("document.querySelector('#record').disabled"), true, '#record must be disabled when stale');
    await cdp.clickSelector('#accept-snapshot');
    await cdp.until("document.querySelector('#draft-stale')?.hidden === true", { label: 'stale cleared on #accept-snapshot' });
    await cdp.assertCleanTelemetry();
  });

  // F7 (5 cases)
  add(2, 'T2-F7-1', ['S12'], '10k customer + 2k stock + 120 supplier tail needles (> 10,000) reachable & selectable', async ctx => {
    const { cdp, bigApp10k } = ctx;
    await fastSessionLogin(cdp, bigApp10k.origin, bigApp10k.owner, '/owner#v=transaction');
    await searchAndSelectCombobox(cdp, '#f-counterpartyId', 'İsmail Işık Hedef', 'İsmail Işık Hedef');
    assert.equal(await cdp.evaluate("document.querySelector('#f-counterpartyId').value"), 'cari-bd-needle-ismail');

    await searchAndSelectCombobox(cdp, '[data-item-field="accountId"]', 'AĞRI HEDEF', 'AĞRI HEDEF BİLEZİK');
    assert.equal(await cdp.evaluate("document.querySelector('[data-item-field=\"accountId\"]').value"), 'stock-bd-needle-stock');

    await openCommandPalette(cdp);
    await selectCommandPaletteOption(cdp, 'Şeyma Hedef Toptancı', 'Şeyma Hedef Toptancı');
    await cdp.until("location.hash.includes('v=suppliers') && document.querySelector('[data-firm-heading]')?.textContent.includes('Şeyma Hedef Toptancı')", {
      label: 'tail supplier needle opened'
    });
    await cdp.assertCleanTelemetry();
  });

  add(2, 'T2-F7-2', ['S12'], '/checkout /api/customers?q=Hedef on 10k dataset finds tail needle quickly with bounded payload', async ctx => {
    const { origin, employee } = ctx.bigApp10k;
    const session = await apiLogin(origin, employee.id, employee.password);
    // Warm lazy Repository open & compact state snapshot (server.mjs:49) just as /checkout page load does
    const warmup = await fetch(`${origin}/api/checkout?workspace=demo`, {
      headers: { Authorization: `Bearer ${session.token}` }
    });
    assert.equal(warmup.status, 200);
    await warmup.json();

    const t0 = performance.now();
    const res = await fetch(`${origin}/api/customers?workspace=demo&q=${encodeURIComponent('Hedef')}`, {
      headers: { Authorization: `Bearer ${session.token}` }
    });
    const elapsedMs = performance.now() - t0;
    assert.equal(res.status, 200);
    const body = await res.json();
    const items = Array.isArray(body) ? body : body.items;
    assert.ok(items.some(i => i.id === 'cari-bd-needle-ismail'), 'Tail needle missing on 10k /api/customers');
    assert.ok(items.length <= 20, `Payload must remain bounded (<= 20), got ${items.length}`);
    assert.ok(elapsedMs < 200, `Warm /api/customers 10k search took ${elapsedMs.toFixed(1)}ms (budget < 200ms)`);
  });

  add(2, 'T2-F7-3', ['S12'], 'Ctrl+K open latency <= 150ms on 10k dataset', async ctx => {
    const { cdp, bigApp10k } = ctx;
    await fastSessionLogin(cdp, bigApp10k.origin, bigApp10k.owner, '/owner#v=overview');
    const inPageMs = await cdp.evaluate(`new Promise(resolve => {
      const t0 = performance.now();
      (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true, cancelable: true }));
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - t0)));
    })`);
    const isOpen = await cdp.evaluate("Boolean(document.querySelector('[data-command-palette][open]'))");
    assert.equal(isOpen, true, 'Command Palette did not open on Ctrl+K');
    assert.ok(inPageMs <= 150, `Ctrl+K open latency on 10k dataset exceeded 150ms: ${inPageMs.toFixed(2)}ms`);
    await cdp.pressKey('Escape');
    await cdp.assertCleanTelemetry();
  });

  add(2, 'T2-F7-4', ['S12'], 'Combobox search + render <= 150ms & keyboard select <= 100ms on 10k dataset', async ctx => {
    const { cdp, bigApp10k } = ctx;
    await fastSessionLogin(cdp, bigApp10k.origin, bigApp10k.owner, '/owner#v=transaction');
    await focusComboboxFor(cdp, '#f-counterpartyId');
    const searchMs = await cdp.evaluate(`new Promise((resolve, reject) => {
      const { combo, listbox } = ${resolveComboboxScript(JSON.stringify('#f-counterpartyId'))};
      const target = combo.matches('input, button, select, textarea, [tabindex]') ? combo : (combo.querySelector('input') || combo);
      const t0 = performance.now();
      target.value = 'İsmail Işık Hedef';
      target.dispatchEvent(new Event('input', { bubbles: true }));
      const deadline = performance.now() + 2000;
      const tick = () => {
        const cid = combo.getAttribute('aria-controls');
        const lb = cid ? document.getElementById(cid) : listbox;
        const opts = lb ? [...lb.querySelectorAll('[role="option"]')] : [];
        if (opts.some(o => o.textContent.includes('İsmail Işık Hedef'))) {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - t0)));
          return;
        }
        if (performance.now() > deadline) return reject(new Error('Timeout waiting for 10k Combobox match'));
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })`);
    const info = await getComboboxContractInfo(cdp, '#f-counterpartyId');
    assert.ok(info.options.some(o => o.text.includes('İsmail Işık Hedef')), 'Expected İsmail Işık Hedef in 10k Combobox results');
    assert.ok(info.optionCount > 0 && info.optionCount <= 20, `Option count ${info.optionCount} must be 1..20`);
    assert.ok((info.backingOptionCount ?? 0) <= 50, `Backing <select> exploded to ${info.backingOptionCount} options`);
    assert.ok(searchMs <= 150, `10k Combobox search+render exceeded 150ms: ${searchMs.toFixed(1)}ms`);

    const selectRes = await cdp.evaluate(`new Promise(resolve => {
      const t0 = performance.now();
      const { backing, combo } = ${resolveComboboxScript(JSON.stringify('#f-counterpartyId'))};
      const target = combo.matches('input, button, select, textarea, [tabindex]') ? combo : (combo.querySelector('input') || combo);
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true, cancelable: true }));
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
      requestAnimationFrame(() => requestAnimationFrame(() => resolve({
        ms: performance.now() - t0,
        value: backing.value
      })));
    })`);
    assert.equal(selectRes.value, 'cari-bd-needle-ismail', `Expected #f-counterpartyId.value === 'cari-bd-needle-ismail', got ${JSON.stringify(selectRes.value)}`);
    assert.ok(selectRes.ms <= 100, `10k Combobox keyboard selection latency = ${selectRes.ms.toFixed(1)}ms > 100ms`);
    await cdp.assertCleanTelemetry();
  });

  add(2, 'T2-F7-5', ['S12'], 'Zero horizontal overflow & clipped popup checks on 390px mobile with open Palette & Combobox', async ctx => {
    const { cdp, app } = ctx;
    await cdp.setViewport(390, 844);
    await fastSessionLogin(cdp, app.origin, app.owner, '/owner#v=transaction');
    await focusComboboxFor(cdp, '#f-counterpartyId');
    await cdp.typeText('Ahmet', { clear: true });
    await waitForComboboxState(cdp, '#f-counterpartyId', 's => Boolean(s.listbox && !s.listbox.hidden && s.options.length >= 1)', {
      label: '390px combobox listbox open'
    }).catch(() => {});
    await cdp.assertNoHorizontalOverflow('390-combobox');
    const lbRect = await getComboboxListboxRect(cdp, '#f-counterpartyId');
    assert.ok(lbRect && lbRect.left >= 0 && lbRect.right <= 390, `Combobox listbox clipped at 390px: ${JSON.stringify(lbRect)}`);
    await cdp.pressKey('Escape');
    await openCommandPalette(cdp);
    const palRect = await cdp.getBoundingRect('[data-command-palette]');
    assert.ok(palRect && palRect.left >= 0 && palRect.right <= 390, `Palette clipped at 390px: ${JSON.stringify(palRect)}`);
    await cdp.pressKey('Escape');
    await cdp.setViewport(1440, 900);
    await cdp.assertCleanTelemetry();
  });

  // =========================================================================
  // TIER 3 — Cross-Feature Pairwise Combinations (8 cases)
  // =========================================================================

  add(3, 'T3-1', ['S7'], 'Ctrl+K + Open Modal/Drawer Top-Layer stacking & Escape unwind', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('transaction', 'sale');
    // Non-vacuous guard: Command Palette must exist and open normally
    await openCommandPalette(cdp);
    await cdp.pressKey('Escape');
    await cdp.until("!document.querySelector('[data-command-palette][open]')", { label: 'palette closed before drawer' });
    await cdp.clickSelector('[data-create-party]');
    await cdp.until("Boolean(document.querySelector('dialog.defter-drawer[open]'))", { label: 'create-party drawer open' });
    await cdp.pressKey('k', { ctrl: true });
    await delay(150);
    const layer = await cdp.evaluate(`(() => {
      const drawer = document.querySelector('dialog.defter-drawer[open]');
      const palette = document.querySelector('[data-command-palette][open]');
      if (!palette) return { paletteOpened: false, drawerOpen: Boolean(drawer) };
      const r = palette.getBoundingClientRect();
      const topEl = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        paletteOpened: true,
        drawerOpen: Boolean(drawer),
        paletteInTopLayer: Boolean(palette.contains(topEl) || palette === topEl)
      };
    })()`);
    if (layer.paletteOpened) {
      assert.equal(layer.paletteInTopLayer, true, 'Command Palette must NEVER be trapped behind open Drawer backdrop');
      await cdp.pressKey('Escape');
      await cdp.until("!document.querySelector('[data-command-palette][open]')", { label: 'palette closed first' });
    }
    await cdp.pressKey('Escape');
    await cdp.until("!document.querySelector('dialog.defter-drawer[open]')", { label: 'drawer closed' });
    await cdp.assertCleanTelemetry();
  });

  add(3, 'T3-2', ['S4'], 'Combobox + amount-codec 10.500 disambiguation + Submit', async ctx => {
    const { cdp, app } = ctx;
    await ctx.resetOwner('transaction', 'sale');
    await searchAndSelectCombobox(cdp, '#f-counterpartyId', 'Ayşe', 'Ayşe Şahin');
    await searchAndSelectCombobox(cdp, '[data-item-field="accountId"]', 'agri', 'AĞRI HAS ALTIN');
    await cdp.typeText('10.500', { selector: '[data-item-field="quantity"]', clear: true });
    await cdp.waitForDoubleRaf();
    assert.equal(await cdp.evaluate("Boolean(document.querySelector('.amount-disambiguation'))"), true);
    await cdp.clickSelector('[data-amount-choice="decimal"]');
    await cdp.typeText('31500', { selector: '[data-item-field="value"]', clear: true });
    await cdp.clickSelector('[data-quick-fill-cash]');
    await cdp.clickSelector('#sale-form button[type="submit"]');
    await cdp.until("document.querySelector('#defter-toast-region')?.textContent.includes('kaydedildi') || document.querySelector('#notice')?.textContent.includes('kaydedildi')", {
      timeoutMs: 10000,
      label: '10.500 sale submitted'
    });
    const repo = app.openRepo('demo');
    try {
      const last = repo.state().journal.at(-1);
      assert.equal(last.meta.lines[0].quantity, 10500, 'Expected 10500 mg (10.500 gr) in persisted sale');
    } finally {
      repo.close();
    }
    await cdp.assertCleanTelemetry();
  });

  add(3, 'T3-3', ['S8', 'S9'], 'Ctrl+K + Dirty Sale Draft + Browser Back (popstate) + Forward + F5 restore', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('overview');

    await openCommandPalette(cdp);
    await selectCommandPaletteOption(cdp, 'satis', 'Satış', { excludeTexts: ['toptancı', 'alış'] });
    await cdp.until("location.hash.includes('v=transaction') && Boolean(document.querySelector('#sale-form'))", { label: 'at sale form via Ctrl+K' });

    await searchAndSelectCombobox(cdp, '#f-counterpartyId', 'İsmail', 'İsmail Işık');
    await cdp.typeText('Geri/İleri Taslak', { selector: '#f-note', clear: true });

    // (a) Browser Back leaving dirty transaction must display draft preservation toast
    await cdp.historyBack();
    await cdp.until("location.hash.includes('v=overview')", { label: 'popstate back to overview from dirty sale' });
    const noticeVisible = await cdp.evaluate("Boolean(document.querySelector('#defter-toast-region')?.textContent.includes('taslak') || (!document.querySelector('#notice')?.hidden && document.querySelector('#notice')?.textContent.includes('taslak')))");
    assert.equal(noticeVisible, true, 'Browser Back leaving dirty draft must show draft preservation message in #defter-toast-region or #notice');

    await cdp.historyForward();
    await cdp.until("location.hash.includes('v=transaction') && Boolean(document.querySelector('#sale-form'))", { label: 'popstate forward back to sale' });
    assert.equal(await cdp.evaluate("document.querySelector('#f-note')?.value"), 'Geri/İleri Taslak');
    assert.equal(await cdp.evaluate("document.querySelector('#f-counterpartyId')?.value"), 'cari-cust-ismail');

    // (b) Ctrl+K jump to account detail -> Back/Forward -> F5 restore -> return to sale with draft intact
    await openCommandPalette(cdp);
    await selectCommandPaletteOption(cdp, 'İsmail Işık', 'İsmail Işık');
    await cdp.until("location.hash.includes('v=accounts') && location.hash.includes('id=cari-cust-ismail')", { label: 'at accounts detail' });

    await cdp.historyBack();
    await cdp.until("location.hash.includes('v=transaction') && Boolean(document.querySelector('#sale-form'))", { label: 'popstate back from clean accounts to transaction' });
    assert.equal(await cdp.evaluate("document.querySelector('#f-note')?.value"), 'Geri/İleri Taslak');
    assert.equal(await cdp.evaluate("document.querySelector('#f-counterpartyId')?.value"), 'cari-cust-ismail');

    await cdp.historyForward();
    await cdp.until("location.hash.includes('v=accounts') && location.hash.includes('id=cari-cust-ismail')", { label: 'forward to accounts detail' });
    await cdp.reload();
    await cdp.until("document.querySelector('#account-detail:not([hidden]) #statement-title')?.textContent.includes('İsmail Işık')", { label: 'detail restored on F5' });

    await openCommandPalette(cdp);
    await selectCommandPaletteOption(cdp, 'satis', 'Satış', { excludeTexts: ['toptancı', 'alış'] });
    await cdp.until("Boolean(document.querySelector('#sale-form'))", { label: 'back at sale form' });
    assert.equal(await cdp.evaluate("document.querySelector('#f-note')?.value"), 'Geri/İleri Taslak');
    assert.equal(await cdp.evaluate("document.querySelector('#f-counterpartyId')?.value"), 'cari-cust-ismail');
    await cdp.assertCleanTelemetry();
  });

  add(3, 'T3-4', ['S3', 'S4', 'S10', 'S11'], 'Employee /checkout + Ctrl+K + Turkish Combobox + Ahmet disambiguation + 10.500 + 2-stage commit', async ctx => {
    const { cdp, app } = ctx;
    await fastSessionLogin(cdp, app.origin, app.employee, '/checkout');
    await openCommandPalette(cdp);
    await selectCommandPaletteOption(cdp, 'müşteri', 'müşteri', { excludeTexts: ['yeni', 'kart'] });
    await cdp.waitForDoubleRaf();

    await searchAndSelectCombobox(cdp, '#customer', 'ahmet', 'USD');
    await cdp.until(
      "!document.querySelector('#trade-controls')?.disabled && document.querySelector('#customer-balance')?.textContent.includes('Ahmet Yılmaz')",
      { timeoutMs: 8000, label: 'checkout customer lookup settled (T3-4)' }
    );
    assert.equal(await cdp.evaluate("document.querySelector('#customer').value"), 'cari-cust-ahmet-usd');

    await searchAndSelectCombobox(cdp, '[data-product]', 'agri', 'AĞRI HAS ALTIN');
    await cdp.typeText('10.500', { selector: '[data-item] [data-quantity]', clear: true });
    await cdp.typeText('32000', { selector: '[data-item] [data-value]', clear: true });
    await cdp.clickSelector('[data-add="received"][data-category="money"]');
    await cdp.evaluate(`(() => {
      const acc = document.querySelector('[data-allocation="received"] [data-account]');
      acc.value = 'nakit';
      acc.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await cdp.typeText('32000', { selector: '[data-allocation="received"] [data-quantity]', clear: true });
    await cdp.clickSelector('#record');
    await cdp.waitForDoubleRaf();
    assert.equal(
      await cdp.evaluate("Boolean(document.querySelector('.amount-disambiguation'))"),
      true,
      'Expected .amount-disambiguation when clicking #record with ambiguous 10.500 GRAM quantity'
    );
    assert.equal(
      await cdp.evaluate("document.querySelector('#review')?.hidden === true"),
      true,
      'Ambiguous 10.500 must block #review until resolved'
    );
    await cdp.clickSelector('[data-amount-choice="decimal"]');
    await cdp.waitForDoubleRaf();
    assert.equal(
      await cdp.evaluate("!document.querySelector('.amount-disambiguation') && document.querySelector('[data-item] [data-quantity]')?.dataset.amountResolution === 'decimal'"),
      true,
      'Expected .amount-disambiguation to clear and decimal resolution to be stored after single click'
    );
    await cdp.clickSelector('#record');
    await cdp.until("document.querySelector('#review')?.hidden === false", { label: 'checkout review' });
    await cdp.clickSelector('#confirm');
    await cdp.until("document.querySelector('#status')?.textContent.includes('İşlem kaydedildi')", { timeoutMs: 10000, label: 'committed' });

    const repo = app.openRepo('demo');
    try {
      const last = repo.state().journal.at(-1);
      assert.equal(last.actor.role, 'employee');
      assert.equal(last.meta.counterpartyId, 'cari-cust-ahmet-usd');
      assert.equal(last.meta.lines[0].quantity, 10500);
    } finally {
      repo.close();
    }
    await cdp.assertCleanTelemetry();
  });

  add(3, 'T3-5', ['S5', 'S9'], 'Ctrl+K -> Supplier + F5 restore + Combobox product & HAS unit + 2.500 + Commit', async ctx => {
    const { cdp, app } = ctx;
    await ctx.resetOwner('overview');
    await openCommandPalette(cdp);
    await selectCommandPaletteOption(cdp, 'ozgur celik', 'Özgür Çelik Toptan');
    await cdp.until("location.hash.includes('v=suppliers') && location.hash.includes('id=supplier-sup-ozgur')", { label: 'supplier hash' });
    await cdp.reload();
    await cdp.until("document.querySelector('[data-firm-heading]')?.textContent.includes('Özgür Çelik Toptan')", { label: 'supplier restored on F5' });

    await cdp.clickSelector('[data-supplier-task="purchase"]');
    await cdp.until("Boolean(document.querySelector('form[data-supplier-form=\"purchase\"]'))", { label: 'supplier purchase form' });
    if (!(await cdp.evaluate("Boolean(document.querySelector('[data-group=\"items\"] [data-row]'))"))) {
      await cdp.clickSelector('[data-group="items"] [data-add-row]');
    }
    await searchAndSelectCombobox(cdp, '[data-group="items"] select[data-field="accountId"]', 'ceyrek', 'ÇEYREK');
    await cdp.typeText('2', { selector: '[data-group="items"] input[data-field="quantity"]', clear: true });
    if (await cdp.evaluate("Boolean(document.querySelector('form[data-supplier-form=\"purchase\"] [data-wizard-next]:not([hidden])'))")) {
      await cdp.clickSelector('form[data-supplier-form="purchase"] [data-wizard-next]');
      await cdp.until("document.querySelector('[data-group=\"charges\"]')?.closest('section')?.hidden === false", { label: 'T3-5 step 2 visible' });
    }

    if (!(await cdp.evaluate("Boolean(document.querySelector('[data-group=\"charges\"] [data-row]'))"))) {
      await cdp.clickSelector('[data-group="charges"] [data-add-row]');
    }
    await searchAndSelectCombobox(cdp, '[data-group="charges"] select[data-field="accountId"]', 'HAS', 'HAS');
    await cdp.typeText('2.500', { selector: '[data-group="charges"] input[data-field="quantity"]', clear: true });
    await cdp.waitForDoubleRaf();
    const hasDisambig = await cdp.evaluate("Boolean(document.querySelector('.amount-disambiguation'))");
    assert.equal(hasDisambig, true, 'Expected .amount-disambiguation for ambiguous 2.500 HAS charge quantity');
    await cdp.clickSelector('[data-amount-choice="decimal"]');
    if (await cdp.evaluate("Boolean(document.querySelector('form[data-supplier-form=\"purchase\"] [data-wizard-next]:not([hidden])'))")) {
      await cdp.clickSelector('form[data-supplier-form="purchase"] [data-wizard-next]');
      await cdp.until("document.querySelector('form[data-supplier-form=\"purchase\"] button[type=\"submit\"]')?.hidden === false", { label: 'T3-5 step 3 submit visible' });
    }
    await cdp.clickSelector('form[data-supplier-form="purchase"] button[type="submit"]');
    await cdp.until("document.querySelector('[data-supplier-status]')?.textContent.includes('kaydedildi') || document.querySelector('#defter-toast-region')?.textContent.includes('kaydedildi')", {
      timeoutMs: 10000,
      label: 'supplier purchase saved'
    });
    const repo = app.openRepo('demo');
    try {
      const last = repo.state().journal.at(-1);
      assert.equal(last.type, 'supplierPurchase');
      assert.equal(last.meta.supplierId, 'supplier-sup-ozgur');
      assert.equal(last.meta.chargeLines?.[0]?.quantity, 2500, 'Expected 2500 mg (2.500 HAS gr) in persisted supplierPurchase chargeLines');
    } finally {
      repo.close();
    }
    await cdp.assertCleanTelemetry();
  });

  add(3, 'T3-6', ['S8'], 'Ctrl+K + 409 REVISION_CONFLICT + Dirty Draft + Stale Recovery', async ctx => {
    const { cdp, app } = ctx;
    await ctx.resetOwner('transaction', 'sale');
    await searchAndSelectCombobox(cdp, '#f-counterpartyId', 'Ayşe', 'Ayşe Şahin');
    await searchAndSelectCombobox(cdp, '[data-item-field="accountId"]', 'ceyrek', 'ÇEYREK');
    await cdp.typeText('1', { selector: '[data-item-field="quantity"]', clear: true });
    await cdp.typeText('4800', { selector: '[data-item-field="value"]', clear: true });
    await cdp.clickSelector('[data-quick-fill-cash]');

    const repo = app.openRepo('demo');
    try {
      const s = repo.state();
      repo.execute({
        id: `t3-6-oob-${randomUUID()}`,
        revision: s.revision,
        command: { type: 'movement', date: s.date, accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '1', note: 'T3-6 bump' }
      });
    } finally {
      repo.close();
    }

    await cdp.withAllowedHttpStatuses([409], async () => {
      await cdp.clickSelector('#sale-form button[type="submit"]');
      await cdp.until("Boolean(document.querySelector('p[data-draft-stale]')) && document.querySelector('#sale-form')?.dataset.draftStale === 'true'", { timeoutMs: 10000, label: 'stale on 409' });
    });

    await openCommandPalette(cdp);
    await selectCommandPaletteOption(cdp, 'musteri', 'Müşteri', { excludeTexts: ['alış', 'ekle', 'yeni'] });
    await cdp.until("location.hash.includes('v=accounts')", { label: 'at accounts' });

    await openCommandPalette(cdp);
    await selectCommandPaletteOption(cdp, 'satis', 'Satış', { excludeTexts: ['toptancı', 'alış'] });
    await cdp.until("Boolean(document.querySelector('[data-review-draft]'))", { label: 'stale recovery preserved' });
    await cdp.clickSelector('[data-review-draft]');
    await cdp.until("!document.querySelector('p[data-draft-stale]') && document.querySelector('#sale-form')?.dataset.draftStale !== 'true'", { label: 'reviewed' });
    await cdp.clickSelector('#sale-form button[type="submit"]');
    await cdp.until("document.querySelector('#defter-toast-region')?.textContent.includes('kaydedildi') || document.querySelector('#notice')?.textContent.includes('kaydedildi')", {
      timeoutMs: 10000,
      label: 'sale succeeded after stale recovery'
    });
    await cdp.assertCleanTelemetry();
  });

  add(3, 'T3-7', ['S11', 'S12'], 'Big-Data 10k + #journal-search debounce + #journal-account Combobox + XSS safety', async ctx => {
    const { cdp, bigApp10k } = ctx;
    await fastSessionLogin(cdp, bigApp10k.origin, bigApp10k.owner, '/owner#v=journal');
    await cdp.until(
      "Boolean(document.querySelector('#journal-search')) && document.querySelector('#journal-list')?.getAttribute('aria-busy') === 'false'",
      { timeoutMs: 12000, label: '10k journal loaded' }
    );
    await delay(200);
    cdp.clearRequests();
    await cdp.typeText('seyma celik', { selector: '#journal-search', clear: true, perCharDelayMs: 20 });
    await delay(500);
    await cdp.until("document.querySelector('#journal-list')?.getAttribute('aria-busy') === 'false'", {
      timeoutMs: 10000,
      label: '10k journal search settled'
    }).catch(() => {});
    const jCalls = cdp.getRequests().filter(r => r.url.includes('/api/journal'));
    assert.ok(jCalls.length >= 1 && jCalls.length <= 3, `Expected debounced journal search on 10k (1..3 requests), got ${jCalls.length} requests`);

    await cdp.evaluate("const det = document.querySelector('.journal-advanced-filters'); if (det) det.open = true;");
    await searchAndSelectCombobox(cdp, '#journal-account', 'onerror', 'Hedef');
    await cdp.until(
      "document.querySelector('#journal-list')?.getAttribute('aria-busy') === 'false' && !document.querySelector('#journal-list .loading')",
      { timeoutMs: 10000, label: '10k journal settled after account filter' }
    );
    await cdp.assertCleanTelemetry();
  });

  add(3, 'T3-8', ['S7', 'S12'], 'Responsive 390px + Sidebar Mobile Drawer + Ctrl+K + Combobox inside Drawer', async ctx => {
    const { cdp, app } = ctx;
    await cdp.setViewport(390, 844);
    await fastSessionLogin(cdp, app.origin, app.owner, '/owner#v=transaction');
    await cdp.clickSelector('#navigation-toggle');
    await cdp.waitForDoubleRaf();
    assert.equal(await cdp.evaluate("document.body.classList.contains('navigation-open')"), true);
    await cdp.clickSelector('#navigation-toggle');

    await cdp.clickSelector('[data-create-party]');
    await cdp.until("Boolean(document.querySelector('dialog.defter-drawer[open]'))", { label: 'drawer at 390px' });
    await cdp.assertNoHorizontalOverflow('390-drawer');
    await cdp.pressKey('Escape');
    await openCommandPalette(cdp);
    await cdp.assertNoHorizontalOverflow('390-palette');
    await cdp.pressKey('Escape');
    await cdp.setViewport(1440, 900);
    await cdp.assertCleanTelemetry();
  });

  // =========================================================================
  // TIER 4 — Real-World Application Scenarios (7 scenarios)
  // =========================================================================

  add(4, 'T4-1', ['S1', 'S2', 'S3', 'S4', 'S11'], 'Owner peak-hour multi-item retail sale with disambiguation & Ctrl+K statement check', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('overview');
    await openCommandPalette(cdp);
    await selectCommandPaletteOption(cdp, 'satis', 'Satış', { excludeTexts: ['toptancı', 'alış'] });
    await cdp.until("Boolean(document.querySelector('#sale-form'))", { label: 'sale open' });

    await searchAndSelectCombobox(cdp, '#f-counterpartyId', '05321112233', 'Ahmet Yılmaz');
    assert.equal(await cdp.evaluate("document.querySelector('#f-counterpartyId').value"), 'cari-cust-ahmet-tl');

    // Line 1: ceyrek
    await searchAndSelectCombobox(cdp, '.sale-item:nth-of-type(1) [data-item-field="accountId"]', 'ceyrek', 'ÇEYREK');
    await cdp.typeText('1', { selector: '.sale-item:nth-of-type(1) [data-item-field="quantity"]', clear: true });
    await cdp.typeText('5000', { selector: '.sale-item:nth-of-type(1) [data-item-field="value"]', clear: true });

    // Line 2: Ağrı Has Altın with 10.500 disambiguation
    await cdp.clickSelector('#add-sale-item');
    await searchAndSelectCombobox(cdp, '.sale-item:nth-of-type(2) [data-item-field="accountId"]', 'agri', 'AĞRI HAS ALTIN');
    await cdp.typeText('10.500', { selector: '.sale-item:nth-of-type(2) [data-item-field="quantity"]', clear: true });
    await cdp.waitForDoubleRaf();
    await cdp.clickSelector('[data-amount-choice="decimal"]');
    await cdp.typeText('30000', { selector: '.sale-item:nth-of-type(2) [data-item-field="value"]', clear: true });

    if (await cdp.evaluate("Boolean(document.querySelector('#sale-form.stepper-active'))")) {
      await cdp.clickSelector('[data-step-next="2"]');
      await cdp.until("Boolean(document.querySelector('[data-step-panel=\"2\"].is-active'))", {
        timeoutMs: 5000,
        label: 'T4-1 advanced to step 2'
      });
    }
    await cdp.clickSelector('[data-add-allocation="payment"][data-payment-type="cash"]');
    await cdp.typeText('35000', { selector: '[data-allocation-kind="payment"] [data-allocation-field="quantity"]', clear: true });
    await cdp.clickSelector('#sale-form button[type="submit"]');
    await cdp.until("document.querySelector('#defter-toast-region')?.textContent.includes('kaydedildi') || document.querySelector('#notice')?.textContent.includes('kaydedildi')", {
      timeoutMs: 10000,
      label: 'T4-1 multi-item sale saved'
    });

    await openCommandPalette(cdp);
    await selectCommandPaletteOption(cdp, '05321112233', 'Ahmet Yılmaz');
    await cdp.until("document.querySelector('#account-detail:not([hidden]) #statement-result')?.textContent.includes('Karma satış')", {
      timeoutMs: 8000,
      label: 'Ahmet statement shows sale'
    });
    await cdp.assertCleanTelemetry();
  });

  add(4, 'T4-2', ['S10', 'S11'], 'Employee tezgah Turkish walk-in + quick customer create + 2-stage sale + 403 check', async ctx => {
    const { cdp, app } = ctx;
    await uiLogin(cdp, app.origin, app.employee, '/checkout');
    await searchAndSelectCombobox(cdp, '#customer', 'ismail isik', 'İsmail Işık');
    await cdp.until(
      "!document.querySelector('#trade-controls')?.disabled && document.querySelector('#customer-balance')?.textContent.includes('İsmail Işık')",
      { timeoutMs: 8000, label: 'checkout customer lookup settled (T4-2)' }
    );
    await cdp.clickSelector('#open-customer-drawer');
    await cdp.until("Boolean(document.querySelector('dialog.defter-drawer[open] #customer-form'))", { label: 'drawer' });
    const name = `Müşteri ÇŞĞ ${randomUUID().slice(0, 5)}`;
    await cdp.typeText(name, { selector: '#customer-form input[name="name"]', clear: true });
    await cdp.clickSelector('#customer-form button.button');
    await cdp.until(`document.querySelector('#customer-balance')?.textContent.includes(${JSON.stringify(name)})`, {
      timeoutMs: 10000,
      label: 'new Turkish customer selected'
    });

    await searchAndSelectCombobox(cdp, '[data-product]', 'gumus', 'GÜMÜŞ BİLEZİK');
    await cdp.typeText('2', { selector: '[data-item] [data-quantity]', clear: true });
    await cdp.typeText('2400', { selector: '[data-item] [data-value]', clear: true });
    await cdp.clickSelector('[data-add="received"][data-category="money"]');
    await cdp.evaluate("const a = document.querySelector('[data-allocation=\"received\"] [data-account]'); a.value='nakit'; a.dispatchEvent(new Event('change',{bubbles:true}));");
    await cdp.typeText('2400', { selector: '[data-allocation="received"] [data-quantity]', clear: true });
    await cdp.clickSelector('#record');
    await cdp.until("document.querySelector('#review')?.hidden === false", { label: 'review' });
    await cdp.clickSelector('#confirm');
    await cdp.until("document.querySelector('#status')?.textContent.includes('İşlem kaydedildi')", { timeoutMs: 10000, label: 'saved' });

    const status = await cdp.withAllowedHttpStatuses([403], () =>
      cdp.evaluate("fetch('/api/state?workspace=demo', { headers: { Authorization: 'Bearer ' + DefterSession.current().token } }).then(r => r.status)")
    );
    assert.equal(status, 403);
    await cdp.assertCleanTelemetry();
  });

  add(4, 'T4-3', ['S5', 'S9'], 'Supplier multi-unit purchase workflow with F5 interruption & draft recovery', async ctx => {
    const { cdp, app } = ctx;
    await ctx.resetOwner('overview');
    await openCommandPalette(cdp);
    await selectCommandPaletteOption(cdp, 'ozgur celik', 'Özgür Çelik Toptan');
    await cdp.until("document.querySelector('[data-firm-heading]')?.textContent.includes('Özgür Çelik Toptan')", { label: 'firm open' });

    await cdp.clickSelector('[data-supplier-task="purchase"]');
    await cdp.until("Boolean(document.querySelector('form[data-supplier-form=\"purchase\"]'))", { label: 'form' });
    if (!(await cdp.evaluate("Boolean(document.querySelector('[data-group=\"items\"] [data-row]'))"))) {
      await cdp.clickSelector('[data-group="items"] [data-add-row]');
    }
    await searchAndSelectCombobox(cdp, '[data-group="items"] select[data-field="accountId"]', 'ceyrek', 'ÇEYREK');
    await cdp.typeText('1', { selector: '[data-group="items"] input[data-field="quantity"]', clear: true });
    if (await cdp.evaluate("Boolean(document.querySelector('form[data-supplier-form=\"purchase\"] [data-wizard-next]:not([hidden])'))")) {
      await cdp.clickSelector('form[data-supplier-form="purchase"] [data-wizard-next]');
      await cdp.until("document.querySelector('[data-group=\"charges\"]')?.closest('section')?.hidden === false", { label: 'T4-3 step 2 visible' });
    }
    if (!(await cdp.evaluate("Boolean(document.querySelector('[data-group=\"charges\"] [data-row]'))"))) {
      await cdp.clickSelector('[data-group="charges"] [data-add-row]');
    }
    await searchAndSelectCombobox(cdp, '[data-group="charges"] select[data-field="accountId"]', 'TL', 'TL');
    await cdp.typeText('4950', { selector: '[data-group="charges"] input[data-field="quantity"]', clear: true });

    await cdp.reload();
    await cdp.until("document.querySelector('[data-firm-heading]')?.textContent.includes('Özgür Çelik Toptan')", {
      timeoutMs: 12000,
      label: 'supplier detail restored after F5'
    });
    if (!(await cdp.evaluate("Boolean(document.querySelector('form[data-supplier-form=\"purchase\"]'))"))) {
      await cdp.clickSelector('[data-supplier-task="purchase"]');
      await cdp.until("Boolean(document.querySelector('form[data-supplier-form=\"purchase\"]'))", {
        timeoutMs: 8000,
        label: 'supplier purchase form reopened after F5'
      });
    }
    const restoredSup = await cdp.evaluate(`({
      itemAcc: document.querySelector('[data-group="items"] select[data-field="accountId"]')?.value || '',
      itemQty: document.querySelector('[data-group="items"] input[data-field="quantity"]')?.value || '',
      chargeQty: document.querySelector('[data-group="charges"] input[data-field="quantity"]')?.value || ''
    })`);
    assert.equal(restoredSup.itemAcc, 'ceyrek', 'Supplier purchase draft item must restore after F5');
    assert.equal(restoredSup.itemQty, '1', 'Supplier purchase draft quantity must restore after F5');
    assert.equal(restoredSup.chargeQty, '4950', 'Supplier purchase draft charge quantity must restore after F5');
    while (await cdp.evaluate("Boolean(document.querySelector('form[data-supplier-form=\"purchase\"] [data-wizard-next]:not([hidden])'))")) {
      await cdp.clickSelector('form[data-supplier-form="purchase"] [data-wizard-next]');
      await cdp.waitForDoubleRaf();
    }
    await cdp.clickSelector('form[data-supplier-form="purchase"] button[type="submit"]');
    await cdp.until("document.querySelector('[data-supplier-status]')?.textContent.includes('kaydedildi') || document.querySelector('#defter-toast-region')?.textContent.includes('kaydedildi')", {
      timeoutMs: 10000,
      label: 'supplier purchase committed'
    });
    const repo = app.openRepo('demo');
    try {
      assert.equal(repo.state().journal.at(-1).type, 'supplierPurchase');
    } finally {
      repo.close();
    }
    await cdp.assertCleanTelemetry();
  });

  add(4, 'T4-4', ['S1', 'S7', 'S8'], 'Interrupted cashier flow: dirty sale -> Ctrl+K customer lookup -> Modal check -> return & complete', async ctx => {
    const { cdp } = ctx;
    await ctx.resetOwner('transaction', 'sale');
    await searchAndSelectCombobox(cdp, '#f-counterpartyId', 'İsmail', 'İsmail Işık');
    await cdp.typeText('Kesintili Kasa', { selector: '#f-note', clear: true });
    cdp.clearRequests();

    await openCommandPalette(cdp);
    await selectCommandPaletteOption(cdp, 'musteri', 'Müşteri', { excludeTexts: ['alış', 'ekle', 'yeni'] });
    await cdp.until("location.hash.includes('v=accounts')", { label: 'at accounts' });
    assert.equal(cdp.getRequests().filter(r => r.url.includes('/api/command') && r.method === 'POST').length, 0);

    await openCommandPalette(cdp);
    await selectCommandPaletteOption(cdp, 'satis', 'Satış', { excludeTexts: ['toptancı', 'alış'] });
    await cdp.until("Boolean(document.querySelector('#sale-form'))", { label: 'back to sale' });

    await cdp.clickSelector('[data-create-party]');
    await cdp.until("Boolean(document.querySelector('dialog.defter-drawer[open]'))", { label: 'drawer open' });
    await cdp.pressKey('Escape');
    await cdp.until("!document.querySelector('dialog.defter-drawer[open]')", { label: 'drawer closed' });

    assert.equal(await cdp.evaluate("document.querySelector('#f-note')?.value"), 'Kesintili Kasa');
    await searchAndSelectCombobox(cdp, '[data-item-field="accountId"]', 'ceyrek', 'ÇEYREK');
    await cdp.typeText('1', { selector: '[data-item-field="quantity"]', clear: true });
    await cdp.typeText('5150', { selector: '[data-item-field="value"]', clear: true });
    await cdp.clickSelector('[data-quick-fill-cash]');
    await cdp.clickSelector('#sale-form button[type="submit"]');
    await cdp.until("document.querySelector('#defter-toast-region')?.textContent.includes('kaydedildi') || document.querySelector('#notice')?.textContent.includes('kaydedildi')", {
      timeoutMs: 10000,
      label: 'interrupted sale completed'
    });
    await cdp.assertCleanTelemetry();
  });

  add(4, 'T4-5', ['S11'], 'End-of-day journal search (debounced Turkish), stocktake 10.500 & summary audit across 1440px and 1100px', async ctx => {
    const { cdp } = ctx;
    const targetVps = opts.viewport === 'all' ? [VIEWPORTS['1440'], VIEWPORTS['1100']] : getRequestedViewports(opts.viewport);
    for (const vp of targetVps) {
      await cdp.setViewport(vp.width, vp.height);
      await ctx.resetOwner('journal');
      await cdp.until("document.querySelector('#journal-list')?.getAttribute('aria-busy') === 'false'", {
        timeoutMs: 10000,
        label: `T4-5 initial journal loaded at ${vp.width}px`
      });
      await delay(150);
      cdp.clearRequests();
      await cdp.typeText('ismail isik', { selector: '#journal-search', clear: true, perCharDelayMs: 20 });
      await delay(500);
      await cdp.until("document.querySelector('#journal-list')?.getAttribute('aria-busy') === 'false'", {
        timeoutMs: 10000,
        label: `T4-5 journal search settled at ${vp.width}px`
      }).catch(() => {});
      const jCalls = cdp.getRequests().filter(r => r.url.includes('/api/journal'));
      assert.ok(jCalls.length >= 1 && jCalls.length <= 3, `Expected debounced journal search (1..3 requests) at ${vp.width}px, got ${jCalls.length}`);
      await cdp.assertNoHorizontalOverflow(`T4-5-journal-${vp.width}`);

      await openCommandPalette(cdp);
      await selectCommandPaletteOption(cdp, 'kapanis', 'Kapanış');
      await cdp.until("Boolean(document.querySelector('#close-form'))", { label: 'closing open' });
      await cdp.clickSelector('[data-count-mode="periodic"]');
      await cdp.typeText('10.500', { selector: '#periodic-count-taki14', clear: true });
      await cdp.waitForDoubleRaf();
      assert.equal(await cdp.evaluate("Boolean(document.querySelector('.amount-disambiguation'))"), true);
      await cdp.clickSelector('[data-amount-choice="decimal"]');
      await cdp.assertNoHorizontalOverflow(`T4-5-closing-${vp.width}`);

      await openCommandPalette(cdp);
      await selectCommandPaletteOption(cdp, 'ozet', 'Özet');
      await cdp.until("Boolean(document.querySelector('#summary-search')) && document.querySelectorAll('#summary-result tbody tr').length > 0", { label: 'summary open' });
      await cdp.typeText('gumus', { selector: '#summary-search', clear: true });
      await cdp.until(
        "(document.querySelector('#summary-result')?.textContent || '').includes('GÜMÜŞ BİLEZİK')",
        { timeoutMs: 3000, label: 'summary gumus filtered' }
      ).catch(() => {});
      assert.ok((await cdp.evaluate("document.querySelector('#summary-result').textContent")).includes('GÜMÜŞ BİLEZİK'));
      await cdp.assertNoHorizontalOverflow(`T4-5-summary-${vp.width}`);
    }
    const resetVp = opts.viewport === 'all' ? VIEWPORTS['1440'] : VIEWPORTS[opts.viewport];
    await cdp.setViewport(resetVp.width, resetVp.height);
    await cdp.assertCleanTelemetry();
  });

  add(4, 'T4-6', ['S12'], 'Big-Data 5k & 10k Scale & 3-Viewport (1440/1100/390px) Acceptance Gate', async ctx => {
    const { cdp, bigApp5k, bigApp10k } = ctx;
    const requestedVps = getRequestedViewports(opts.viewport);

    for (const [scaleLabel, targetApp, expectedMinCustomers] of [
      ['5k', bigApp5k, 5000],
      ['10k', bigApp10k, 10000]
    ]) {
      for (const vp of requestedVps) {
        await cdp.setViewport(vp.width, vp.height);
        await fastSessionLogin(cdp, targetApp.origin, targetApp.owner, '/owner#v=transaction');
        await cdp.assertNoHorizontalOverflow(`${scaleLabel}-${vp.width}`);

        // 1. Ctrl+K open latency <= 150ms
        const openMs = await cdp.evaluate(`new Promise(resolve => {
          const t0 = performance.now();
          (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true, cancelable: true }));
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - t0)));
        })`);
        assert.equal(await cdp.evaluate("Boolean(document.querySelector('[data-command-palette][open]'))"), true, `Palette failed to open (${scaleLabel}/${vp.width})`);
        assert.ok(openMs <= 150, `Ctrl+K open latency (${scaleLabel}/${vp.width}) = ${openMs.toFixed(1)}ms > 150ms`);

        const palRect = await cdp.getBoundingRect('[data-command-palette]');
        assert.ok(palRect && palRect.left >= 0 && palRect.right <= vp.width, `Palette overflow at ${vp.width}px`);
        await cdp.pressKey('Escape');
        await cdp.until("!document.querySelector('[data-command-palette][open]')", { label: 'palette closed' });

        // 2. Combobox search+render <= 150ms, DOM cap <= 20, status count, tail needle reachability
        await focusComboboxFor(cdp, '#f-counterpartyId');
        const searchMs = await cdp.evaluate(`new Promise((resolve, reject) => {
          const { combo, listbox } = ${resolveComboboxScript(JSON.stringify('#f-counterpartyId'))};
          const target = combo.matches('input, button, select, textarea, [tabindex]') ? combo : (combo.querySelector('input') || combo);
          const t0 = performance.now();
          target.value = 'İsmail Işık Hedef';
          target.dispatchEvent(new Event('input', { bubbles: true }));
          const deadline = performance.now() + 2000;
          const tick = () => {
            const cid = combo.getAttribute('aria-controls');
            const lb = cid ? document.getElementById(cid) : listbox;
            const opts = lb ? [...lb.querySelectorAll('[role="option"]')] : [];
            if (opts.some(o => o.textContent.includes('İsmail Işık Hedef'))) {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - t0)));
              return;
            }
            if (performance.now() > deadline) return reject(new Error('Timeout waiting for big-data Combobox match'));
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        })`);
        const info = await getComboboxContractInfo(cdp, '#f-counterpartyId');
        const domStats = await cdp.getDomStats();
        assert.ok(info.optionCount > 0 && info.optionCount <= 20, `Option count ${info.optionCount} must be 1..20 (${scaleLabel})`);
        assert.ok((info.backingOptionCount ?? 0) <= 50, `Backing <select> exploded to ${info.backingOptionCount} options`);
        assert.ok(info.options.some(o => o.text.includes('İsmail Işık Hedef')), `Tail needle (> ${expectedMinCustomers}) missing`);
        assert.ok(info.statusText && /\d+\s*\//.test(info.statusText), `Missing [data-combobox-status] on ${scaleLabel}`);
        assert.ok(searchMs <= 150, `Combobox search+render (${scaleLabel}/${vp.width}) = ${searchMs.toFixed(1)}ms > 150ms`);
        assert.ok(domStats.elementCount < 3500, `DOM node explosion: ${domStats.elementCount}`);

        const selectRes = await cdp.evaluate(`new Promise(resolve => {
          const t0 = performance.now();
          const { backing, combo } = ${resolveComboboxScript(JSON.stringify('#f-counterpartyId'))};
          const target = combo.matches('input, button, select, textarea, [tabindex]') ? combo : (combo.querySelector('input') || combo);
          target.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true, cancelable: true }));
          target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
          requestAnimationFrame(() => requestAnimationFrame(() => resolve({
            ms: performance.now() - t0,
            value: backing.value
          })));
        })`);
        assert.equal(
          selectRes.value,
          'cari-bd-needle-ismail',
          `Expected committed needle ID after keyboard select (${scaleLabel}/${vp.width}), got ${JSON.stringify(selectRes.value)}`
        );
        assert.ok(selectRes.ms <= 100, `Keyboard selection latency (${scaleLabel}/${vp.width}) = ${selectRes.ms.toFixed(1)}ms > 100ms`);
        await cdp.assertNoHorizontalOverflow(`${scaleLabel}-after-select-${vp.width}`);
      }
    }
    const resetVp = opts.viewport === 'all' ? VIEWPORTS['1440'] : VIEWPORTS[opts.viewport];
    await cdp.setViewport(resetVp.width, resetVp.height);
    await cdp.assertCleanTelemetry();
  });

  add(4, 'T4-7', ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11'], 'Multi-viewport S1-S11 acceptance sweep (1440x900, 1100x900, 390x844 across /owner & /checkout)', async ctx => {
    const { cdp, app } = ctx;
    const requestedVps = getRequestedViewports(opts.viewport);

    for (const vp of requestedVps) {
      await cdp.setViewport(vp.width, vp.height);

      // Owner leg (S1-S9, S11)
      await fastSessionLogin(cdp, app.origin, app.owner, '/owner#v=overview');
      await cdp.assertNoHorizontalOverflow(`T4-7-owner-overview-${vp.width}`);

      // S1 + S2 + S11: Ctrl+K bounding box & jump to İsmail Işık
      await openCommandPalette(cdp);
      const palRect = await cdp.getBoundingRect('[data-command-palette]');
      assert.ok(palRect && palRect.left >= 0 && palRect.right <= vp.width, `Owner palette overflows ${vp.width}px: ${JSON.stringify(palRect)}`);
      await selectCommandPaletteOption(cdp, 'ismail', 'İsmail Işık');
      await cdp.until(
        "location.hash.includes('v=accounts') && location.hash.includes('id=cari-cust-ismail') && document.querySelector('#account-detail:not([hidden]) #statement-title')?.textContent.includes('İsmail Işık')",
        { timeoutMs: 8000, label: `T4-7 owner jumped to İsmail Işık (${vp.width})` }
      );
      await cdp.assertNoHorizontalOverflow(`T4-7-account-${vp.width}`);

      // S9: F5 reload restores selected account detail
      await cdp.reload();
      await cdp.until(
        "document.querySelector('#account-detail:not([hidden]) #statement-title')?.textContent.includes('İsmail Işık')",
        { timeoutMs: 12000, label: `T4-7 F5 restored İsmail Işık (${vp.width})` }
      );
      await cdp.assertNoHorizontalOverflow(`T4-7-account-f5-${vp.width}`);

      // S5: Ctrl+K jump to supplier firm
      await openCommandPalette(cdp);
      await selectCommandPaletteOption(cdp, 'ozgur celik', 'Özgür Çelik Toptan');
      await cdp.until(
        "location.hash.includes('v=suppliers') && document.querySelector('[data-firm-heading]')?.textContent.includes('Özgür Çelik Toptan')",
        { timeoutMs: 8000, label: `T4-7 supplier opened (${vp.width})` }
      );
      await cdp.assertNoHorizontalOverflow(`T4-7-supplier-${vp.width}`);

      // S3 + S4 + S6: Ctrl+K to Satış, customer disambiguation, product select, non-saleable block
      await openCommandPalette(cdp);
      await selectCommandPaletteOption(cdp, 'satis', 'Satış', { excludeTexts: ['toptancı', 'alış'] });
      await cdp.until("Boolean(document.querySelector('#sale-form'))", { label: `T4-7 sale form (${vp.width})` });
      await focusComboboxFor(cdp, '#f-counterpartyId');
      await cdp.typeText('Ahmet Yılmaz', { clear: true });
      await waitForComboboxState(cdp, '#f-counterpartyId', 's => s.options.length >= 2', { label: `T4-7 Ahmet options (${vp.width})` });
      const lbRect = await getComboboxListboxRect(cdp, '#f-counterpartyId');
      if (lbRect && lbRect.width > 0) {
        assert.ok(lbRect.left >= 0 && lbRect.right <= vp.width, `Combobox listbox overflows ${vp.width}px: ${JSON.stringify(lbRect)}`);
      }
      await cdp.pressKey('Escape');
      await searchAndSelectCombobox(cdp, '#f-counterpartyId', 'Ahmet Yılmaz', 'USD');
      assert.equal(await cdp.evaluate("document.querySelector('#f-counterpartyId').value"), 'cari-cust-ahmet-usd');

      await searchAndSelectCombobox(cdp, '[data-item-field="accountId"]', 'agri', 'AĞRI HAS ALTIN');
      assert.equal(await cdp.evaluate("document.querySelector('[data-item-field=\"accountId\"]').value"), 'stock-stk-agri');

      await focusComboboxFor(cdp, '[data-item-field="accountId"]');
      await cdp.typeText('Alış Özel', { clear: true });
      await waitForComboboxState(
        cdp,
        '[data-item-field="accountId"]',
        "s => s.comboValue === 'Alış Özel' && s.ariaExpanded === 'true' && (s.options.length >= 1 || /bulunamad|eşleş|0\\s*\\//i.test(s.statusText))",
        { timeoutMs: 3000, label: `T4-7 non-saleable guard (${vp.width})` }
      ).catch(() => {});
      await cdp.pressKey('Enter');
      await cdp.waitForDoubleRaf();
      assert.notEqual(
        await cdp.evaluate("document.querySelector('[data-item-field=\"accountId\"]').value"),
        'stock-stk-non-sale',
        `Non-saleable item committed at ${vp.width}px`
      );
      await cdp.pressKey('Escape');

      // S7: Drawer + Ctrl+K layering
      await cdp.clickSelector('[data-create-party]');
      await cdp.until("Boolean(document.querySelector('dialog.defter-drawer[open]'))", { label: `T4-7 drawer (${vp.width})` });
      await cdp.assertNoHorizontalOverflow(`T4-7-drawer-${vp.width}`);
      await cdp.pressKey('k', { ctrl: true });
      await delay(120);
      const layer = await cdp.evaluate(`(() => {
        const palette = document.querySelector('[data-command-palette][open]');
        if (!palette) return { paletteOpened: false };
        const r = palette.getBoundingClientRect();
        const topEl = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { paletteOpened: true, paletteInTopLayer: Boolean(palette.contains(topEl) || palette === topEl) };
      })()`);
      if (layer.paletteOpened) {
        assert.equal(layer.paletteInTopLayer, true, `Palette trapped behind drawer at ${vp.width}px`);
        await cdp.pressKey('Escape');
        await cdp.until("!document.querySelector('[data-command-palette][open]')", { label: 'palette closed' });
      }
      await cdp.pressKey('Escape');
      await cdp.until("!document.querySelector('dialog.defter-drawer[open]')", { label: 'drawer closed' });

      // S8: Dirty draft preserved across Ctrl+K nav & return
      await cdp.typeText('Taslak Sweep', { selector: '#f-note', clear: true });
      cdp.clearRequests();
      await openCommandPalette(cdp);
      await selectCommandPaletteOption(cdp, 'musteri', 'Müşteri', { excludeTexts: ['alış', 'ekle', 'yeni'] });
      await cdp.until("location.hash.includes('v=accounts')", { label: `T4-7 nav away (${vp.width})` });
      assert.equal(cdp.getRequests().filter(r => r.url.includes('/api/command') && r.method === 'POST').length, 0);
      await openCommandPalette(cdp);
      await selectCommandPaletteOption(cdp, 'satis', 'Satış', { excludeTexts: ['toptancı', 'alış'] });
      await cdp.until("Boolean(document.querySelector('#sale-form'))", { label: `T4-7 nav back (${vp.width})` });
      assert.equal(await cdp.evaluate("document.querySelector('#f-note')?.value"), 'Taslak Sweep');
      assert.equal(await cdp.evaluate("document.querySelector('#f-counterpartyId')?.value"), 'cari-cust-ahmet-usd');

      // Employee /checkout leg (S10 + S2 + S3 + S4 + S6 + S11)
      await fastSessionLogin(cdp, app.origin, app.employee, '/checkout');
      await cdp.assertNoHorizontalOverflow(`T4-7-checkout-${vp.width}`);
      await openCommandPalette(cdp);
      const empPalRect = await cdp.getBoundingRect('[data-command-palette]');
      assert.ok(empPalRect && empPalRect.left >= 0 && empPalRect.right <= vp.width, `Employee palette overflows ${vp.width}px: ${JSON.stringify(empPalRect)}`);
      const empOpts = await cdp.evaluate("[...document.querySelectorAll('[data-command-palette-list] [role=\"option\"]')].map(o => ((o.dataset.commandId || '') + ' ' + o.textContent.trim()).trim())");
      assert.ok(empOpts.length >= 1, `Employee palette empty at ${vp.width}px`);
      const empJoined = empOpts.join('\n').toLocaleLowerCase('tr-TR');
      for (const forbidden of ['Toptancı', 'Günlük İşlem', 'Kapanış', 'Özet', 'Yedek', 'Çalışan', 'Banka/Pos/Kasa', 'suppliers', 'journal', 'closing', 'summary', 'backup', 'users', 'banks']) {
        assert.equal(empJoined.includes(forbidden.toLocaleLowerCase('tr-TR')), false, `Employee palette leaked "${forbidden}" at ${vp.width}px`);
      }
      await cdp.pressKey('Escape');

      await searchAndSelectCombobox(cdp, '#customer', 'ahmet', 'USD');
      await cdp.until(
        "!document.querySelector('#trade-controls')?.disabled && document.querySelector('#customer-balance')?.textContent.includes('Ahmet Yılmaz')",
        { timeoutMs: 8000, label: `checkout customer lookup settled (${vp.width})` }
      );
      assert.equal(await cdp.evaluate("document.querySelector('#customer').value"), 'cari-cust-ahmet-usd');
      await searchAndSelectCombobox(cdp, '[data-product]', 'gumus', 'GÜMÜŞ BİLEZİK');
      assert.equal(await cdp.evaluate("document.querySelector('[data-product]').value"), 'stock-stk-gumus');
      await cdp.assertNoHorizontalOverflow(`T4-7-checkout-after-${vp.width}`);
    }

    const resetVp = opts.viewport === 'all' ? VIEWPORTS['1440'] : VIEWPORTS[opts.viewport];
    await cdp.setViewport(resetVp.width, resetVp.height);
    await cdp.assertCleanTelemetry();
  });

  return tests;
}

// ---------------------------------------------------------------------------
// Runner Orchestration
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  const allTests = buildTestCases(opts);

  const selectedTests = allTests.filter(t => {
    if (opts.tier !== 'all' && String(t.tier) !== opts.tier) return false;
    if (opts.scenario) {
      const target = opts.scenario.toUpperCase();
      if (t.id.toUpperCase() !== target && !t.scenarios.includes(target)) return false;
    }
    return true;
  });

  if (selectedTests.length === 0) {
    throw new Error(`No test cases matched CLI options: ${JSON.stringify(opts)}`);
  }

  const needsBig5k = selectedTests.some(t => ['T1-F7-1', 'T4-6'].includes(t.id));
  const needsBig10k = selectedTests.some(t => ['T1-F7-2', 'T2-F7-1', 'T2-F7-2', 'T2-F7-3', 'T2-F7-4', 'T3-7', 'T4-6'].includes(t.id));

  let app = null;
  let bigApp5k = null;
  let bigApp10k = null;
  let cdp = null;
  let primaryError = null;
  const activeVp = opts.viewport === 'all' ? VIEWPORTS['1440'] : VIEWPORTS[opts.viewport];

  const results = [];
  const startedAt = Date.now();

  try {
    app = await createIsolatedApp({ prefix: 'paket6b-fn-', seedFn: seedFunctionalLedger });
    if (needsBig5k) {
      bigApp5k = await createIsolatedApp({
        prefix: 'paket6b-5k-',
        seedFn: (dbPath, ws) => seedBigDataLedger(dbPath, { customers: 5000, stocks: 2000, suppliers: 120, workspace: ws })
      });
    }
    if (needsBig10k) {
      bigApp10k = await createIsolatedApp({
        prefix: 'paket6b-10k-',
        seedFn: (dbPath, ws) => seedBigDataLedger(dbPath, { customers: 10000, stocks: 2000, suppliers: 120, workspace: ws })
      });
    }

    cdp = await launchChromeSession({
      userDataDir: join(app.profileDir, 'chrome'),
      width: activeVp.width,
      height: activeVp.height,
      watchdogMs: 600000
    });

    await fastSessionLogin(cdp, app.origin, app.owner, '/owner');

    for (const t of selectedTests) {
      const t0 = performance.now();
      cdp.resetTelemetry();
      try {
        await cdp.setViewport(activeVp.width, activeVp.height);
        await t.fn({
          cdp,
          app,
          bigApp5k,
          bigApp10k,
          opts,
          resetOwner: (v, tab = null) => resetOwnerToView(cdp, v, tab, app)
        });
        const durationMs = Number((performance.now() - t0).toFixed(1));
        results.push({ tier: t.tier, id: t.id, scenarios: t.scenarios, status: 'PASS', durationMs, title: t.title });
        console.log(`[PASS] ${t.id} (${durationMs}ms) — ${t.title}`);
      } catch (err) {
        const durationMs = Number((performance.now() - t0).toFixed(1));
        const message = err?.message || String(err);
        results.push({ tier: t.tier, id: t.id, scenarios: t.scenarios, status: 'FAIL', durationMs, title: t.title, error: message });
        console.log(`[FAIL] ${t.id} (${durationMs}ms) — ${t.title}\n       ${message.split('\n')[0]}`);
        try {
          await cdp.call('Fetch.disable').catch(() => {});
          await cdp.evaluate('for (const d of document.querySelectorAll("dialog[open]")) try { d.close(); } catch {}').catch(() => {});
        } catch {}
      }
    }
  } catch (err) {
    primaryError = err;
    throw err;
  } finally {
    const cleanupErrors = [];
    for (const [label, resource] of [
      ['cdp', cdp],
      ['bigApp10k', bigApp10k],
      ['bigApp5k', bigApp5k],
      ['app', app]
    ]) {
      if (!resource) continue;
      try {
        await resource.close();
      } catch (err) {
        cleanupErrors.push(new Error(`${label}.close() failed: ${err?.message || err}`, { cause: err }));
      }
    }
    if (cleanupErrors.length > 0) {
      for (const err of cleanupErrors) console.error('Cleanup failure:', err);
      process.exitCode = 1;
      if (!primaryError) {
        throw cleanupErrors.length === 1
          ? cleanupErrors[0]
          : new AggregateError(cleanupErrors, 'E2E teardown cleanup failed');
      }
    }
  }

  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const summary = {
    tier: opts.tier,
    viewport: opts.viewport,
    scenario: opts.scenario,
    total: results.length,
    passed,
    failed,
    durationMs: Date.now() - startedAt
  };
  console.log('\n=== PAKET 6B E2E SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
  if (failed > 0) process.exitCode = 1;
}

main().catch(err => {
  console.error('Fatal E2E runner error:', err);
  process.exitCode = 1;
});
