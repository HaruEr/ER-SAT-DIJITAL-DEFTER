import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadJSDOM } from '../test-support/jsdom.mjs';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS } from '../domain.mjs';
import { renderSupplierWorkspace } from '../public/suppliers.js';

const JSDOM = await loadJSDOM();
const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const reportsCss = readFileSync(new URL('../public/reports.css', import.meta.url), 'utf8');
const stylesCss = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const draftStoreSource = readFileSync(new URL('../public/draft-store.js', import.meta.url), 'utf8');
const uiKitSource = readFileSync(new URL('../public/ui-kit.js', import.meta.url), 'utf8');
const amountCodecSource = readFileSync(new URL('../public/amount-codec.js', import.meta.url), 'utf8');
const dateFormatSource = readFileSync(new URL('../public/date-format.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

const tick = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));

async function createAppEnv(url = 'http://127.0.0.1:4317/', seedFn = null) {
  const repo = new Repository(':memory:', 'demo');
  repo.execute({
    id: randomUUID(),
    revision: 0,
    command: {
      type: 'opening',
      date: '2026-10-28',
      balances: Object.fromEntries(
        INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [
          a.id,
          a.id === 'nakit' ? '10000' : a.id === 'gramToplam' ? '20' : '0'
        ])
      )
    }
  });
  if (seedFn) seedFn(repo);

  const dom = new JSDOM(indexHtml, { url, runScripts: 'outside-only' });
  const { window } = dom;
  const document = window.document;
  Object.defineProperty(window.crypto, 'randomUUID', { value: randomUUID });
  window.HTMLElement.prototype.scrollIntoView = () => {};

  window.DefterSession = {
    current: () => ({ actor: { id: 'owner', name: 'Patron', role: 'owner' } }),
    headers: () => ({}),
    clear: () => {},
    lock: () => {},
    finishRestore: () => {},
    requireOwner: async () => true,
    api: async (path, body) => {
      const parsed = new URL(path, 'http://127.0.0.1:4317');
      if (parsed.pathname === '/api/state') return repo.state();
      if (parsed.pathname === '/api/journal') {
        return repo.journalPage({
          ...Object.fromEntries(parsed.searchParams),
          limit: Number(parsed.searchParams.get('limit') || 50)
        });
      }
      if (parsed.pathname === '/api/account-statement') {
        return repo.accountStatement({
          accountId: parsed.searchParams.get('accountId'),
          startDate: parsed.searchParams.get('startDate') || '',
          endDate: parsed.searchParams.get('endDate') || ''
        });
      }
      if (parsed.pathname === '/api/suppliers') return { firms: repo.state().accounts.filter(a => a.partyType === 'supplier' && !a.parentAccountId).map(f => ({ ...f, accounts: [f] })), units: [] };
      if (body) return repo.execute(body);
      return repo.state();
    }
  };
  window.fetch = async (reqUrl, init = {}) => {
    const parsed = new URL(String(reqUrl), 'http://127.0.0.1:4317');
    if (parsed.pathname === '/api/state') return { ok: true, status: 200, json: async () => repo.state() };
    if (parsed.pathname === '/api/journal') return { ok: true, status: 200, json: async () => repo.journalPage({ ...Object.fromEntries(parsed.searchParams), limit: Number(parsed.searchParams.get('limit') || 50) }) };
    if (parsed.pathname === '/api/account-statement') return { ok: true, status: 200, json: async () => repo.accountStatement({ accountId: parsed.searchParams.get('accountId'), startDate: parsed.searchParams.get('startDate') || '', endDate: parsed.searchParams.get('endDate') || '' }) };
    if (parsed.pathname === '/api/suppliers') return { ok: true, status: 200, json: async () => ({ firms: [], units: [] }) };
    if (parsed.pathname === '/api/command') return { ok: true, status: 200, json: async () => repo.execute(JSON.parse(init.body || '{}')) };
    return { ok: true, status: 200, json: async () => ({}) };
  };

  window.eval(draftStoreSource);
  window.eval(uiKitSource);
  window.eval(amountCodecSource);
  window.eval(dateFormatSource);
  window.eval(appSource);
  await tick(80);
  return { dom, window, document, repo };
}

test('Paket 5A: accounts & stocks Split View, detail tabs, and >50 pagination', async () => {
  const { dom, window, document } = await createAppEnv('http://127.0.0.1:4317/#v=accounts', repo => {
    for (let i = 1; i <= 55; i++) {
      repo.execute({
        id: randomUUID(),
        revision: repo.state().revision,
        command: { type: 'account', date: '2026-10-28', name: `Müşteri ${String(i).padStart(2, '0')}`, unit: 'TL', partyType: 'customer', opening: '100' }
      });
    }
  });
  try {
    const cards = document.querySelectorAll('#account-list .account-card');
    assert.equal(cards.length, 50);
    assert.equal(document.querySelector('#workbench-pagination')?.hidden, false);
    document.querySelector('#workbench-load-more').click();
    assert.equal(document.querySelectorAll('#account-list .account-card').length, 55);

    const firstBtn = document.querySelector('[data-account-detail]');
    firstBtn.click();
    await tick(40);
    assert.ok(document.querySelector('dialog.defter-drawer #account-detail'), 'Customer detail opens in wide Drawer');

    // Tabs switch detail panes cleanly
    document.querySelector('[data-detail-tab="orders"]').click();
    assert.equal(document.querySelector('#statement-filter')?.hidden, true);
    assert.equal(document.querySelector('.customer-orders')?.hidden, false);
    document.querySelector('[data-detail-tab="all"]').click();
    assert.equal(document.querySelector('#statement-filter')?.hidden, false);

    document.querySelector('#statement-back').click();
    assert.equal(document.querySelector('dialog.defter-modal #account-detail'), null);

    // Stocks tabs
    document.querySelector('#navigation [data-view="stocks"]').click();
    await tick(30);
    document.querySelector('[data-stocks-tab="items"]').click();
    assert.equal(document.querySelector('#stock-list-section')?.hidden, true);
    document.querySelector('[data-stocks-tab="all"]').click();
    assert.equal(document.querySelector('#stock-list-section')?.hidden, false);
  } finally {
    dom.window.close();
  }
});

test('Paket 5A (R1): customer search, #account-clear reset, 50-record pagination, and selected card preservation', async () => {
  const { dom, window, document } = await createAppEnv('http://127.0.0.1:4317/#v=accounts', repo => {
    const distinct = [
      { name: 'Çiğdem Yılmaz', unit: 'TL', opening: '250', phone: '05551234567', taxId: '98765432101' },
      { name: 'Şakir Borçlu', unit: 'USD', opening: '-75', phone: '05329998877', taxId: '11122233344' },
      { name: 'Sıfır Bakiye', unit: 'TL', opening: '0' }
    ];
    for (const c of distinct) {
      repo.execute({
        id: randomUUID(),
        revision: repo.state().revision,
        command: { type: 'account', date: '2026-10-28', partyType: 'customer', ...c }
      });
    }
    for (let i = 1; i <= 105; i++) {
      repo.execute({
        id: randomUUID(),
        revision: repo.state().revision,
        command: { type: 'account', date: '2026-10-28', name: `Müşteri ${String(i).padStart(3, '0')}`, unit: 'TL', partyType: 'customer', opening: '100' }
      });
    }
  });
  try {
    const search = () => document.querySelector('#account-search');
    const unit = () => document.querySelector('#account-unit');
    const sign = () => document.querySelector('#account-sign');
    const clearBtn = () => document.querySelector('#account-clear');

    // Initial 50-record pagination & clear button disabled state
    assert.equal(document.querySelectorAll('#account-list .account-card').length, 50);
    assert.equal(document.querySelector('#workbench-pagination')?.hidden, false);
    assert.equal(document.querySelector('#workbench-status')?.textContent, '108 / 108 müşteri hesabı');
    assert.match(document.querySelector('#workbench-pagination')?.textContent || '', /Gösterilen:\s*50\s*\/\s*108/);
    assert.equal(clearBtn()?.disabled, true);

    // Load more (50 -> 100) and show all (100 -> 108)
    document.querySelector('#workbench-load-more').click();
    assert.equal(document.querySelectorAll('#account-list .account-card').length, 100);
    assert.equal(document.querySelector('#workbench-pagination')?.hidden, false);
    assert.match(document.querySelector('#workbench-pagination')?.textContent || '', /Gösterilen:\s*100\s*\/\s*108/);
    document.querySelector('#workbench-show-all').click();
    assert.equal(document.querySelectorAll('#account-list .account-card').length, 108);
    assert.equal(document.querySelector('#workbench-pagination')?.hidden, true);

    // Select an initial-50 card (Çiğdem Yılmaz)
    const cigdemBtn = [...document.querySelectorAll('[data-account-detail]')].find(b => b.textContent.includes('Çiğdem Yılmaz'));
    assert.ok(cigdemBtn);
    const cigdemId = cigdemBtn.dataset.accountDetail;
    cigdemBtn.click();
    await tick(40);
    assert.ok(document.querySelector('dialog.defter-drawer #account-detail'), 'Customer detail opens in wide Drawer');
    assert.equal(document.querySelectorAll('#account-list .account-card.is-selected').length, 1);
    assert.equal(document.querySelector('[data-account-detail][aria-current="true"]')?.dataset.accountDetail, cigdemId);

    // Search with Turkish normalization, phone, taxId, and empty-state clear
    search().value = 'cigdem';
    search().dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal(document.querySelectorAll('#account-list .account-card').length, 1);
    assert.equal(document.querySelector('#workbench-status')?.textContent, '1 / 108 müşteri hesabı');
    assert.equal(document.querySelector('#workbench-pagination')?.hidden, true);
    assert.equal(clearBtn()?.disabled, false);
    assert.equal(document.querySelector('[data-account-detail][aria-current="true"]')?.dataset.accountDetail, cigdemId);
    assert.equal(document.querySelector('#account-detail')?.hidden, false);

    search().value = '05329998877';
    search().dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal(document.querySelectorAll('#account-list .account-card').length, 1);
    assert.match(document.querySelector('#account-list')?.textContent || '', /Şakir Borçlu/);
    assert.equal(document.querySelector('#account-detail')?.hidden, false);

    search().value = '98765432101';
    search().dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal(document.querySelectorAll('#account-list .account-card').length, 1);
    assert.equal(document.querySelector('#account-list .account-card.is-selected [data-account-detail]')?.dataset.accountDetail, cigdemId);

    search().value = 'olmayan-musteri-xyz';
    search().dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal(document.querySelectorAll('#account-list .account-card').length, 0);
    assert.ok(document.querySelector('#account-empty-clear'));
    document.querySelector('#account-empty-clear').click();
    assert.equal(search().value, '');
    assert.equal(clearBtn()?.disabled, true);
    assert.equal(document.activeElement, search());
    assert.equal(document.querySelectorAll('#account-list .account-card').length, 50);
    assert.equal(document.querySelector('[data-account-detail][aria-current="true"]')?.dataset.accountDetail, cigdemId);

    // Combined #account-unit + #account-sign + #account-search -> #account-clear reset + workbenchMemory preservation
    document.querySelector('#add-account').click();
    assert.ok(document.querySelector('#account-form'));
    search().value = 'sakir';
    search().dispatchEvent(new window.Event('input', { bubbles: true }));
    unit().value = 'USD';
    unit().dispatchEvent(new window.Event('change', { bubbles: true }));
    sign().value = 'debt';
    sign().dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.equal(document.querySelector('#workbench-status')?.textContent, '1 / 108 müşteri hesabı');
    assert.equal(clearBtn()?.disabled, false);

    clearBtn().click();
    assert.equal(search().value, '');
    assert.equal(unit().value, '');
    assert.equal(sign().value, 'all');
    assert.equal(clearBtn()?.disabled, true);
    assert.equal(document.activeElement, search());
    assert.equal(document.querySelector('[data-account-detail][aria-current="true"]')?.dataset.accountDetail, cigdemId);

    // Switch view and return: cleared filters stay reset while editor memory is preserved
    document.querySelector('#navigation [data-view="overview"]').click();
    await tick(30);
    document.querySelector('#navigation [data-view="accounts"]').click();
    await tick(30);
    assert.equal(search().value, '');
    assert.equal(unit().value, '');
    assert.equal(sign().value, 'all');
    assert.equal(clearBtn()?.disabled, true);
    assert.ok(document.querySelector('#account-form'));

    // Selected card at index >= 50 preserved across search -> #account-clear
    document.querySelector('#workbench-load-more').click();
    const card60Btn = [...document.querySelectorAll('[data-account-detail]')].find(b => b.textContent.includes('Müşteri 060'));
    assert.ok(card60Btn);
    const card60Id = card60Btn.dataset.accountDetail;
    card60Btn.click();
    await tick(40);
    assert.equal(document.querySelector('[data-account-detail][aria-current="true"]')?.dataset.accountDetail, card60Id);

    search().value = 'cigdem';
    search().dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal(document.querySelectorAll('#account-list .account-card').length, 1);
    assert.equal(document.querySelector('#account-detail')?.hidden, false);

    clearBtn().click();
    assert.equal(document.querySelectorAll('#account-list .account-card').length, 100);
    assert.equal(document.querySelector('#account-list .account-card.is-selected [data-account-detail]')?.dataset.accountDetail, card60Id);
    assert.equal(document.querySelector('[data-account-detail][aria-current="true"]')?.dataset.accountDetail, card60Id);

    document.querySelector('#statement-back').click();
    assert.equal(document.querySelector('.workbench-split')?.classList.contains('has-detail'), false);
    assert.equal(document.activeElement?.dataset?.accountDetail, card60Id);
  } finally {
    dom.window.close();
  }
});

test('Paket 5B: suppliers.js Split View, purchase 3-step Stepper, and explicit commercial labels', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { runScripts: 'outside-only' });
  const { window } = dom;
  const document = window.document;
  try {
    const firms = [{ id: 'sup-1', name: 'Örnek Toptancı', accounts: [{ id: 'sup-1', unit: 'HAS', balance: 0 }] }];
    const ctl = renderSupplierWorkspace(document.querySelector('#root'), {
      state: { revision: 1, date: '2026-10-28', accounts: [{ id: 'bilezik22', name: '22 Ayar Bilezik', unit: 'GRAM', kind: 'asset', isPurchasable: true, isSaleable: true }], balances: {}, supplierParties: firms },
      escape: v => String(v ?? ''),
      format: (v, u) => `${v} ${u}`,
      day: d => String(d),
      parseAmount: input => (Number(input.value) > 0 ? Number(input.value) * 1000 : null),
      isPending: () => false,
      request: async () => ({ revision: 1, supplier: firms[0], documents: { sources: [], purchases: [] } }),
      submit: async () => true,
      memory: new Map(),
      workspace: 'demo'
    });
    document.querySelector('[data-open-firm="sup-1"]').click();
    document.querySelector('[data-supplier-task="purchase"]').click();
    await tick(20);

    assert.ok(document.querySelector('.workbench-split')?.classList.contains('has-detail'));
    assert.match(document.body.textContent, /Anlaşılan Borç \(HAS \/ Döviz \/ TL — Otomatik Çevrilmez\)/);
    assert.match(document.body.textContent, /Anlaşılan TL Referansı \(Kasadan Çıkmaz\)/);

    document.querySelector('[data-supplier-step="2"]').click();
    assert.equal(document.querySelector('[data-group="items"]').hidden, true);
    assert.equal(document.querySelector('[data-group="charges"]').hidden, false);
    document.querySelector('[data-supplier-step="all"]').click();
    assert.equal(document.querySelector('[data-group="items"]').hidden, false);
    ctl.destroy();
  } finally {
    dom.window.close();
  }
});

test('Paket 5C: journal Split View + advanced filters and closing Sticky Action Bar', async () => {
  const { dom, document } = await createAppEnv('http://127.0.0.1:4317/#v=journal');
  try {
    assert.ok(document.querySelector('.journal-advanced-filters'));
    const inspectBtn = document.querySelector('[data-journal-inspect]');
    assert.ok(inspectBtn);
    inspectBtn.click();
    assert.equal(document.querySelector('#journal-detail-pane')?.hidden, false);
    assert.ok(document.querySelector('.journal-split')?.classList.contains('has-detail'));
    document.querySelector('#journal-detail-close').click();
    assert.equal(document.querySelector('#journal-detail-pane')?.hidden, true);

    document.querySelector('#navigation [data-view="closing"]').click();
    await tick(30);
    assert.ok(document.querySelector('#close-form .sticky-action-bar'));
    assert.ok(document.querySelector('[data-sticky-diff-summary]')?.textContent.includes('sayıldı'));
  } finally {
    dom.window.close();
  }
});

test('Paket 5D: overview 4-block unit-isolated summary, status strip, popover, and reports.css theme', async () => {
  const { dom, document } = await createAppEnv('http://127.0.0.1:4317/#v=overview');
  try {
    assert.ok(document.querySelector('.overview-status-strip'));
    const blocks = document.querySelectorAll('.overview-blocks .overview-block');
    assert.equal(blocks.length, 4);
    const popBtn = document.querySelector('[data-overview-popover]');
    assert.ok(popBtn);
    popBtn.click();
    assert.ok(document.querySelector('.defter-popover'));
    assert.match(reportsCss, /html\[data-theme="dark"\]/);
    assert.match(stylesCss, /\.workbench-split\.has-detail/);
    assert.match(stylesCss, /\.sticky-action-bar/);
  } finally {
    dom.window.close();
  }
});

test('Paket 5C (R3): form-level sticky bar, bounded table-wrap CSS, 5 diff states, focus-safe filter & disambiguation canonical submit', async () => {
  const { dom, window, document, repo } = await createAppEnv('http://127.0.0.1:4317/#v=closing');
  try {
    // 1. Form-level .sticky-action-bar & CSS contracts
    const closeForm = document.querySelector('#close-form');
    const stockForm = document.querySelector('#stocktake-form');
    assert.ok(closeForm.querySelector(':scope > .sticky-action-bar'));
    assert.ok(stockForm.querySelector(':scope > .sticky-action-bar'));
    assert.equal(closeForm.querySelector('.count-approval .sticky-action-bar'), null);
    assert.equal(stockForm.querySelector('.count-approval .sticky-action-bar'), null);
    assert.ok(closeForm.querySelector('.count-approval #f-dailyApprovedBy'));
    assert.ok(closeForm.querySelector('.count-approval #f-nextDate'));

    assert.match(stylesCss, /\.closing-screen #close-form \.table-wrap[\s\S]*max-height:\s*min\(58vh,\s*520px\);\s*overflow:\s*auto;/);
    assert.match(stylesCss, /\.sticky-action-bar \.form-actions\s*\{[^}]*padding-top:\s*0;\s*border-top:\s*0;/);
    assert.match(stylesCss, /\.count-diff\.invalid\s*\{/);
    assert.doesNotMatch(stylesCss, /var\(--accent\)/);

    const totalDaily = closeForm.querySelectorAll('[data-measure]').length;
    const stickySummary = closeForm.querySelector('[data-sticky-diff-summary]');
    const setInput = (el, val) => {
      el.value = val;
      el.dispatchEvent(new window.Event('input', { bubbles: true }));
    };

    // 2. All 5 .count-diff states + syncSticky() accuracy
    const nakit = document.querySelector('#daily-count-nakit');
    const nakitDiff = document.querySelector('#daily-diff-nakit');
    const nakitReason = document.querySelector('#daily-reason-nakit');
    assert.equal(nakitDiff.dataset.diffState, 'empty');
    assert.equal(nakitReason.required, false);
    assert.equal(stickySummary.textContent, `0 / ${totalDaily} sayıldı · 0 fark`);

    setInput(nakit, '9000');
    assert.equal(nakitDiff.dataset.diffState, 'negative');
    assert.equal(nakitDiff.classList.contains('negative'), true);
    assert.equal(nakitDiff.classList.contains('positive'), false);
    assert.equal(nakitReason.required, true);
    assert.equal(stickySummary.textContent, `1 / ${totalDaily} sayıldı · 1 fark`);

    const usd = document.querySelector('#daily-count-usd');
    const usdDiff = document.querySelector('#daily-diff-usd');
    const usdReason = document.querySelector('#daily-reason-usd');
    setInput(usd, '25');
    assert.equal(usdDiff.dataset.diffState, 'positive');
    assert.equal(usdDiff.classList.contains('positive'), true);
    assert.equal(usdDiff.classList.contains('negative'), false);
    assert.equal(usdReason.required, true);
    assert.equal(stickySummary.textContent, `2 / ${totalDaily} sayıldı · 2 fark`);

    const eur = document.querySelector('#daily-count-eur');
    const eurDiff = document.querySelector('#daily-diff-eur');
    const eurReason = document.querySelector('#daily-reason-eur');
    setInput(eur, '0');
    assert.equal(eurDiff.dataset.diffState, 'zero');
    assert.equal(eurDiff.classList.contains('negative'), false);
    assert.equal(eurDiff.classList.contains('positive'), false);
    assert.equal(eurDiff.classList.contains('invalid'), false);
    assert.equal(eurReason.required, false);
    assert.equal(stickySummary.textContent, `3 / ${totalDaily} sayıldı · 2 fark`);

    const ceyrek = document.querySelector('#daily-count-ceyrek');
    const ceyrekDiff = document.querySelector('#daily-diff-ceyrek');
    const ceyrekReason = document.querySelector('#daily-reason-ceyrek');
    setInput(ceyrek, 'abc');
    assert.equal(ceyrekDiff.dataset.diffState, 'invalid');
    assert.equal(ceyrekDiff.classList.contains('invalid'), true);
    assert.equal(ceyrekDiff.classList.contains('negative'), false);
    assert.equal(ceyrekReason.required, false);
    assert.equal(stickySummary.textContent, `3 / ${totalDaily} sayıldı · 2 fark`);

    const gram = document.querySelector('#daily-count-gramToplam');
    const gramDiff = document.querySelector('#daily-diff-gramToplam');
    setInput(gram, '10.500');
    assert.equal(gramDiff.dataset.diffState, 'invalid');
    assert.equal(gramDiff.classList.contains('invalid'), true);
    assert.equal(stickySummary.textContent, `3 / ${totalDaily} sayıldı · 2 fark`);
    assert.match(document.querySelector('#count-progress').textContent, new RegExp(`^3 / ${totalDaily} hesap sayıldı .* 2 fark\\.`));

    // Periodic stocktake syncSticky() check
    const totalPeriodic = stockForm.querySelectorAll('[data-measure]').length;
    const stockSummary = stockForm.querySelector('[data-sticky-diff-summary]');
    setInput(document.querySelector('#periodic-count-bilezik22'), '5');
    setInput(document.querySelector('#periodic-count-taki14'), 'xyz');
    assert.equal(document.querySelector('#periodic-diff-bilezik22').dataset.diffState, 'positive');
    assert.equal(document.querySelector('#periodic-diff-taki14').dataset.diffState, 'invalid');
    assert.equal(stockSummary.textContent, `1 / ${totalPeriodic} sayıldı · 1 fark`);

    // 3. #count-differences-only focus safety
    const diffFilter = document.querySelector('#count-differences-only');
    nakit.focus();
    diffFilter.checked = true;
    diffFilter.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.equal(nakit.closest('tr').hidden, false);

    setInput(nakit, '10000');
    assert.equal(document.activeElement, nakit);
    assert.equal(nakit.closest('tr').hidden, false);

    setInput(nakit, '');
    assert.equal(document.activeElement, nakit);
    assert.equal(nakit.closest('tr').hidden, false);

    nakitReason.focus();
    assert.equal(document.activeElement, nakitReason);
    assert.equal(nakitReason.closest('tr').hidden, false);

    diffFilter.focus();
    nakitReason.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true, relatedTarget: diffFilter }));
    await tick(15);
    assert.equal(nakit.closest('tr').hidden, true);

    diffFilter.checked = false;
    diffFilter.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.equal(nakit.closest('tr').hidden, false);

    // 4. .amount-disambiguation focus restoration & canonical submit
    const thousandsBtn = gram.closest('label').querySelector('[data-amount-choice="thousands"]');
    assert.ok(thousandsBtn);
    thousandsBtn.focus();
    thousandsBtn.click();
    assert.equal(document.activeElement, gram);
    assert.equal(gramDiff.dataset.diffState, 'positive');
    assert.equal(gramDiff.classList.contains('positive'), true);
    assert.equal(document.querySelector('#daily-reason-gramToplam').required, true);

    // Complete remaining required daily counts and submit
    const scales = { TL: 100, USD: 100, EUR: 100, HAS: 1000, GRAM: 1000, ADET: 1 };
    const st = repo.state();
    for (const input of closeForm.querySelectorAll('[data-measure]')) {
      if (input.id === 'daily-count-gramToplam' || input.id === 'daily-count-usd') continue;
      const a = st.accounts.find(x => x.id === input.dataset.measure);
      setInput(input, String((st.balances[a.id] || 0) / scales[a.unit]));
    }
    document.querySelector('#daily-reason-usd').value = 'Sentetik döviz fazlası';
    document.querySelector('#daily-reason-gramToplam').value = 'Binlik çözünürlük testi';
    document.querySelector('#f-dailyApprovedBy').value = 'Patron';
    assert.equal(closeForm.checkValidity(), true);
    closeForm.requestSubmit();
    await tick(50);

    assert.equal(repo.state().closings.length, 1);
    assert.equal(repo.state().balances.gramToplam, 10500000);
  } finally {
    dom.window.close();
  }
});

test('Paket 5C (R3): #count-differences-only + disambiguation Case A/B focus safety and defensive reportValidity', async () => {
  let matchAccountId;
  const { dom, window, document, repo } = await createAppEnv('http://127.0.0.1:4317/#v=closing', r => {
    const res = r.execute({
      id: randomUUID(),
      revision: r.state().revision,
      command: {
        type: 'stockAccount',
        date: '2026-10-28',
        name: 'Test On Bucuk Gram',
        unit: 'GRAM',
        countPolicy: 'daily',
        pairedGroups: [],
        opening: '10.500'
      }
    });
    matchAccountId = res.state.accounts.find(a => a.name.toLocaleUpperCase('tr-TR') === 'TEST ON BUCUK GRAM').id;
  });
  try {
    const closeForm = document.querySelector('#close-form');
    const diffFilter = document.querySelector('#count-differences-only');
    const matchInput = document.getElementById('daily-count-' + matchAccountId);
    const matchRow = matchInput.closest('tr');
    const matchDiff = document.getElementById('daily-diff-' + matchAccountId);
    const setInput = (el, val) => {
      el.value = val;
      el.dispatchEvent(new window.Event('input', { bubbles: true }));
    };

    // Case A: #count-differences-only checked + click [data-amount-choice="decimal"] matching expected (10.500)
    matchInput.focus();
    setInput(matchInput, '10.500');
    diffFilter.checked = true;
    diffFilter.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.equal(matchRow.hidden, false);

    const decBtn = matchInput.closest('label').querySelector('[data-amount-choice="decimal"]');
    assert.ok(decBtn);
    decBtn.focus();
    decBtn.click();
    assert.equal(matchRow.hidden, false);
    assert.equal(document.activeElement, matchInput);
    assert.equal(matchDiff.dataset.diffState, 'zero');
    assert.equal(document.getElementById('daily-reason-' + matchAccountId).required, false);

    // Leaving the row hides it only after focus moves outside
    diffFilter.focus();
    matchInput.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true, relatedTarget: diffFilter }));
    diffFilter.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true, relatedTarget: matchInput }));
    await tick(15);
    assert.equal(matchRow.hidden, true);

    // Case B: #count-differences-only checked + Tab/focusout onto [data-amount-choice="thousands"]
    const gramInput = document.querySelector('#daily-count-gramToplam');
    const gramRow = gramInput.closest('tr');
    gramInput.focus();
    setInput(gramInput, '10.500');
    const thBtn = gramInput.closest('label').querySelector('[data-amount-choice="thousands"]');
    assert.ok(thBtn);
    assert.equal(gramRow.hidden, false);

    gramInput.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true, relatedTarget: thBtn }));
    thBtn.focus();
    thBtn.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true, relatedTarget: gramInput }));
    await tick(15);
    assert.equal(thBtn.isConnected, true);
    assert.equal(document.activeElement, thBtn);
    assert.equal(gramRow.hidden, false);
    assert.equal(gramInput.closest('label').querySelector('[data-amount-choice="thousands"]'), thBtn);

    // Defensive reportValidity() check: direct new Event('submit') blocked while unresolved "10.500" is present
    diffFilter.checked = false;
    diffFilter.dispatchEvent(new window.Event('change', { bubbles: true }));
    const scales = { TL: 100, USD: 100, EUR: 100, HAS: 1000, GRAM: 1000, ADET: 1 };
    const st = repo.state();
    for (const input of closeForm.querySelectorAll('[data-measure]')) {
      if (input.id === 'daily-count-gramToplam') continue;
      const a = st.accounts.find(x => x.id === input.dataset.measure);
      setInput(input, String((st.balances[a.id] || 0) / scales[a.unit]));
    }
    document.querySelector('#f-dailyApprovedBy').value = 'Patron';
    assert.equal(gramInput.validity.valid, false);
    closeForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await tick(30);
    assert.equal(repo.state().closings.length, 0);
  } finally {
    dom.window.close();
  }
});

test('Paket 5C (R3): clearing ambiguous or invalid optional #stocktake-form input restores validity and allows submit', async () => {
  const { dom, window, document, repo } = await createAppEnv('http://127.0.0.1:4317/#v=closing');
  try {
    document.querySelector('[data-count-mode="periodic"]')?.click();
    const stockForm = document.querySelector('#stocktake-form');
    const bilezikInput = document.querySelector('#periodic-count-bilezik22');
    const bilezikDiff = document.querySelector('#periodic-diff-bilezik22');
    const taki14Input = document.querySelector('#periodic-count-taki14');
    const setInput = (el, val) => {
      el.value = val;
      el.dispatchEvent(new window.Event('input', { bubbles: true }));
    };

    // 1. Ambiguous "10.500" -> "" clears disambiguation, customError, and diffState
    setInput(bilezikInput, '10.500');
    assert.ok(bilezikInput.closest('label').querySelector('.amount-disambiguation'));
    assert.equal(bilezikInput.validity.customError, true);

    setInput(bilezikInput, '');
    assert.equal(bilezikInput.closest('label').querySelector('.amount-disambiguation'), null);
    assert.equal(bilezikInput.validity.customError, false);
    assert.equal(bilezikInput.validity.valid, true);
    assert.equal(bilezikDiff.dataset.diffState, 'empty');

    // 2. Invalid "abc" -> "" clears customError and diffState
    setInput(bilezikInput, 'abc');
    assert.equal(bilezikInput.validity.customError, true);

    setInput(bilezikInput, '');
    assert.equal(bilezikInput.closest('label').querySelector('.amount-disambiguation'), null);
    assert.equal(bilezikInput.validity.customError, false);
    assert.equal(bilezikInput.validity.valid, true);
    assert.equal(bilezikDiff.dataset.diffState, 'empty');

    // 3. Submitting #stocktake-form with another valid count succeeds
    setInput(taki14Input, '0');
    document.querySelector('#f-stockApprovedBy').value = 'Patron';
    assert.equal(stockForm.checkValidity(), true);
    stockForm.requestSubmit();
    await tick(50);

    assert.equal(repo.state().stocktakes.length, 1);
    assert.deepEqual(repo.state().stocktakes[0].counts.map(c => c.accountId), ['taki14']);
  } finally {
    dom.window.close();
  }
});

test('Paket 5C (R3): clearing ambiguous #close-form input removes disambiguation and clears customError', async () => {
  const { dom, window, document } = await createAppEnv('http://127.0.0.1:4317/#v=closing');
  try {
    const gramInput = document.querySelector('#daily-count-gramToplam');
    const gramDiff = document.querySelector('#daily-diff-gramToplam');
    const setInput = (el, val) => {
      el.value = val;
      el.dispatchEvent(new window.Event('input', { bubbles: true }));
    };

    setInput(gramInput, '10.500');
    assert.ok(gramInput.closest('label').querySelector('.amount-disambiguation'));
    assert.equal(gramInput.validity.customError, true);

    setInput(gramInput, '');
    assert.equal(gramInput.closest('label').querySelector('.amount-disambiguation'), null);
    assert.equal(gramInput.validity.customError, false);
    assert.equal(gramInput.validity.valueMissing, true);
    assert.equal(gramDiff.dataset.diffState, 'empty');
  } finally {
    dom.window.close();
  }
});
