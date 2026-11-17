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
    assert.ok(document.querySelector('.workbench-split')?.classList.contains('has-detail'));
    assert.equal(document.querySelector('#account-detail')?.hidden, false);

    // Tabs switch detail panes cleanly
    document.querySelector('[data-detail-tab="orders"]').click();
    assert.equal(document.querySelector('#statement-filter')?.hidden, true);
    assert.equal(document.querySelector('.customer-orders')?.hidden, false);
    document.querySelector('[data-detail-tab="all"]').click();
    assert.equal(document.querySelector('#statement-filter')?.hidden, false);

    document.querySelector('#statement-back').click();
    assert.equal(document.querySelector('.workbench-split')?.classList.contains('has-detail'), false);

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
