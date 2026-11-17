import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadJSDOM } from '../test-support/jsdom.mjs';
import { INITIAL_ACCOUNTS } from '../domain.mjs';
import { Repository } from '../repository.mjs';
import { projectSupplierDetail, projectSupplierParties } from '../supplier-view.mjs';
import { renderSupplierWorkspace } from '../public/suppliers.js';

const JSDOM = await loadJSDOM();
const AMOUNT_CODEC_SOURCE = readFileSync(new URL('../public/amount-codec.js', import.meta.url), 'utf8');
const tick = () => new Promise(r => setTimeout(r, 0));
async function waitForDocForm(root, kind, needsSources = false) {
  for (let i = 0; i < 30; i++) {
    const form = root.querySelector(`form[data-supplier-document-form="${kind}"]`);
    const status = form?.querySelector('[data-source-status]')?.textContent;
    if (form && (!needsSources || (status && status !== 'Kaynaklar yükleniyor…'))) return form;
    await tick();
  }
  throw new Error(`Timed out waiting for document form ${kind}`);
}

function openingBalances(overrides = {}) {
  const balances = Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, '0']));
  return { ...balances, nakit: '100000', yuzuk: '10', taki14: '100', ceyrek: '10', ...overrides };
}

function createCodecHarness(t, repo) {
  const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', {
    url: 'http://127.0.0.1/',
    runScripts: 'outside-only'
  });
  const savedGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLInputElement: globalThis.HTMLInputElement,
    Event: globalThis.Event
  };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLInputElement = dom.window.HTMLInputElement;
  globalThis.Event = dom.window.Event;
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.eval(AMOUNT_CODEC_SOURCE);
  const codec = dom.window.DefterAmountCodec;

  const root = dom.window.document.querySelector('main');
  const sent = [];
  let seq = 0;

  let api = null;
  function getContextState() {
    const state = repo.state();
    return { ...state, supplierParties: projectSupplierParties(state) };
  }

  const memory = new Map();
  api = renderSupplierWorkspace(root, {
    state: getContextState(),
    memory,
    workspace: 'demo',
    escape: v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    format: codec.formatAmount,
    day: x => x,
    parseAmount: codec.parseInputElement,
    canonicalValue: codec.canonicalInputValue,
    refresh() {
      api.update(getContextState());
    },
    async request(resource, _body, _workspace, { query } = {}) {
      if (resource !== 'suppliers') throw new Error('Unexpected resource: ' + resource);
      const state = repo.state();
      return projectSupplierDetail(state, {
        supplierId: query.supplierId,
        limit: query.limit || 50,
        editOriginalId: query.editOriginalId
      });
    },
    async submit(command, _message, options) {
      sent.push(structuredClone(command));
      const res = repo.execute({
        id: 'cmd-' + (++seq),
        revision: repo.state().revision,
        command
      });
      if (options?.supplierDraftKey) {
        for (const k of [...memory.keys()]) if (k.includes(':draft:')) memory.delete(k);
      }
      api.update({ ...res.state, supplierParties: projectSupplierParties(res.state) }, { completedDraftKey: options?.supplierDraftKey });
      return true;
    }
  });

  t.after(() => {
    api?.destroy();
    dom.window.close();
    for (const [k, v] of Object.entries(savedGlobals)) {
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
    }
  });

  const setValue = (el, value, eventType) => {
    assert.ok(el, 'element must exist');
    el.value = value;
    el.dispatchEvent(new dom.window.Event(eventType || (el.tagName === 'SELECT' ? 'change' : 'input'), { bubbles: true }));
  };

  const fill = (selector, value, eventType) => setValue(root.querySelector(selector), value, eventType);

  return { dom, root, sent, codec, setValue, fill, api };
}

function seedBaseRepo(t, date = '2026-11-10') {
  const repo = new Repository(':memory:', 'demo');
  t.after(() => repo.close());
  repo.execute({
    id: 'open-1',
    revision: 0,
    command: { type: 'opening', date, balances: openingBalances() }
  });
  const firmRes = repo.execute({
    id: 'firm-1',
    revision: 1,
    command: { type: 'supplierFirm', date, name: 'F3 Sentetik Toptancı' }
  });
  const firmId = firmRes.state.journal.at(-1).meta.supplierId;
  const hasRes = repo.execute({
    id: 'unit-has',
    revision: 2,
    command: { type: 'supplierUnit', date, supplierId: firmId, unit: 'HAS' }
  });
  const hasId = hasRes.state.journal.at(-1).meta.accountId;
  const usdRes = repo.execute({
    id: 'unit-usd',
    revision: 3,
    command: { type: 'supplierUnit', date, supplierId: firmId, unit: 'USD' }
  });
  const usdId = usdRes.state.journal.at(-1).meta.accountId;
  return { repo, firmId, hasId, usdId, date };
}

test('F3 purchase & payment: renderSupplierForm canonicalizes row and form-level referenceTL plus disambiguated amounts', async t => {
  const { repo, firmId, hasId } = seedBaseRepo(t);
  const h = createCodecHarness(t, repo);

  h.root.querySelector(`[data-open-firm="${firmId}"]`).click();
  h.root.querySelector('[data-supplier-task="purchase"]').click();
  await tick();
  await tick();

  // Item row 0: paired yuzuk (weight: '1.250' decimal-disambiguated, row referenceTL: '1.500,25')
  h.fill('[data-group="items"] [data-row] [data-field="accountId"]', 'yuzuk', 'change');
  h.fill('[data-group="items"] [data-row] [data-field="quantity"]', '2', 'input');
  const weightInput = h.root.querySelector('[data-group="items"] [data-row] [data-field="weight"]');
  h.setValue(weightInput, '1.250', 'input');
  const weightDecimalBtn = weightInput.closest('label').querySelector('[data-amount-choice="decimal"]');
  assert.ok(weightDecimalBtn, 'weight 1.250 on GRAM should render disambiguation choices');
  weightDecimalBtn.click();
  h.fill('[data-group="items"] [data-row] [data-field="referenceTL"]', '1.500,25', 'input');

  // Charges row 0: HAS '10.500' resolved as 'thousands' -> '10500'
  h.fill('[data-group="charges"] [data-row] [data-field="accountId"]', hasId, 'change');
  const chargeQtyInput = h.root.querySelector('[data-group="charges"] [data-row] [data-field="quantity"]');
  h.setValue(chargeQtyInput, '10.500', 'input');
  const chargeThousandsBtn = chargeQtyInput.closest('label').querySelector('[data-amount-choice="thousands"]');
  assert.ok(chargeThousandsBtn, 'charge 10.500 on HAS should render disambiguation choices');
  chargeThousandsBtn.click();

  // Form-level referenceTL: '25.000,50' -> '25000.50'
  h.fill('form[data-supplier-form="purchase"] input[name="referenceTL"]', '25.000,50', 'input');

  h.root.querySelector('form[data-supplier-form="purchase"]').requestSubmit();
  await tick();
  await tick();

  assert.equal(h.sent.length, 1);
  const purchaseCmd = h.sent[0];
  assert.equal(purchaseCmd.type, 'supplierPurchase');
  assert.equal(purchaseCmd.items[0].quantity, '2');
  assert.equal(purchaseCmd.items[0].weight, '1.250');
  assert.equal(purchaseCmd.items[0].referenceTL, '1500.25');
  assert.equal(purchaseCmd.charges[0].quantity, '10500');
  assert.equal(purchaseCmd.referenceTL, '25000.50');

  let state = repo.state();
  assert.equal(state.balances.yuzuk, 12);
  assert.equal(state.balances.taki14, 101250);
  assert.equal(state.balances[hasId], -10500000);
  assert.equal(state.journal.at(-1).meta.referenceTL, 2500050);

  // Payment: given nakit '30.000,75', credits HAS '10.500' resolved as 'decimal', form-level referenceTL '30.000,75'
  h.root.querySelector('[data-supplier-task="payment"]').click();
  await tick();
  await tick();

  h.fill('[data-group="given"] [data-row] [data-field="accountId"]', 'nakit', 'change');
  h.fill('[data-group="given"] [data-row] [data-field="quantity"]', '30.000,75', 'input');
  h.fill('[data-group="credits"] [data-row] [data-field="accountId"]', hasId, 'change');
  const creditQtyInput = h.root.querySelector('[data-group="credits"] [data-row] [data-field="quantity"]');
  h.setValue(creditQtyInput, '10.500', 'input');
  const creditDecimalBtn = creditQtyInput.closest('label').querySelector('[data-amount-choice="decimal"]');
  assert.ok(creditDecimalBtn, 'credit 10.500 on HAS should render disambiguation choices');
  creditDecimalBtn.click();
  h.fill('form[data-supplier-form="payment"] input[name="referenceTL"]', '30.000,75', 'input');

  h.root.querySelector('form[data-supplier-form="payment"]').requestSubmit();
  await tick();
  await tick();

  assert.equal(h.sent.length, 2);
  const paymentCmd = h.sent[1];
  assert.equal(paymentCmd.type, 'supplierPayment');
  assert.equal(paymentCmd.given[0].quantity, '30000.75');
  assert.equal(paymentCmd.credits[0].quantity, '10.500');
  assert.equal(paymentCmd.referenceTL, '30000.75');

  state = repo.state();
  assert.equal(state.balances.nakit, 10000000 - 3000075);
  assert.equal(state.balances[hasId], -10500000 + 10500);
  assert.equal(state.journal.at(-1).meta.referenceTL, 3000075);
});

test('F3 allocation: attachSupplierSources blocks unresolved 10.500, canonicalizes disambiguated 10.500 and 1.000,50', async t => {
  const { repo, firmId, hasId, date } = seedBaseRepo(t);
  const pRes = repo.execute({
    id: 'purch-alloc',
    revision: repo.state().revision,
    command: {
      type: 'supplierPurchase',
      date,
      supplierId: firmId,
      items: [{ accountId: 'ceyrek', quantity: '10' }],
      charges: [{ accountId: hasId, quantity: '2000' }]
    }
  });
  const purchaseId = pRes.state.journal.at(-1).id;
  const payRes = repo.execute({
    id: 'pay-alloc',
    revision: repo.state().revision,
    command: {
      type: 'supplierPayment',
      date,
      supplierId: firmId,
      given: [{ accountId: 'nakit', quantity: '50000' }],
      credits: [{ accountId: hasId, quantity: '2000' }],
      advanceScope: 'general'
    }
  });
  const payId = payRes.state.journal.at(-1).id;

  const h = createCodecHarness(t, repo);
  h.root.querySelector(`[data-open-firm="${firmId}"]`).click();
  h.root.querySelector('[data-supplier-documents]').click();
  await waitForDocForm(h.root, 'allocation', true);

  h.root.querySelector('[data-add-source]').click();
  h.fill('[data-source-field="choice"]', JSON.stringify([payId, hasId]), 'change');
  h.fill('[data-source-field="purchase"]', JSON.stringify([purchaseId, hasId]), 'change');

  // Unresolved '10.500' blocks submit and renders disambiguation
  const qtyEl = h.root.querySelector('[data-source-field="quantity"]');
  h.setValue(qtyEl, '10.500', 'input');
  h.root.querySelector('form[data-supplier-document-form="allocation"]').requestSubmit();
  await tick();
  assert.equal(h.sent.length, 0, 'ambiguous 10.500 must block allocation submit');
  const decimalBtn = qtyEl.closest('label').querySelector('[data-amount-choice="decimal"]');
  assert.ok(decimalBtn, 'allocation must render decimal disambiguation button');
  decimalBtn.click();

  h.root.querySelector('form[data-supplier-document-form="allocation"]').requestSubmit();
  await waitForDocForm(h.root, 'allocation', true);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].type, 'supplierAllocation');
  assert.equal(h.sent[0].allocations[0].quantity, '10.500');
  assert.deepEqual(repo.state().journal.at(-1).entries, []);

  // Second allocation with Turkish grouped '1.000,50' -> '1000.50'
  h.root.querySelector('[data-add-source]').click();
  h.fill('[data-source-field="choice"]', JSON.stringify([payId, hasId]), 'change');
  h.fill('[data-source-field="purchase"]', JSON.stringify([purchaseId, hasId]), 'change');
  h.fill('[data-source-field="quantity"]', '1.000,50', 'input');
  h.root.querySelector('form[data-supplier-document-form="allocation"]').requestSubmit();
  await waitForDocForm(h.root, 'allocation', true);

  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].allocations[0].quantity, '1000.50');
  const detail = projectSupplierDetail(repo.state(), { supplierId: firmId, limit: 50 });
  assert.equal(detail.documents.sources[0].credits[0].remaining, 2000000 - 10500 - 1000500);
  assert.equal(detail.documents.purchases[0].charges[0].remaining, 2000000 - 10500 - 1000500);
});

test('F3 offset: canonicalizes fromQuantity, toQuantity, sourceUses, targetUses (Turkish grouped & disambiguated)', async t => {
  const { repo, firmId, hasId, usdId, date } = seedBaseRepo(t);
  const advRes = repo.execute({
    id: 'adv-has',
    revision: repo.state().revision,
    command: {
      type: 'supplierPayment',
      date,
      supplierId: firmId,
      given: [{ accountId: 'nakit', quantity: '50000' }],
      credits: [{ accountId: hasId, quantity: '20000' }],
      advanceScope: 'general'
    }
  });
  const advId = advRes.state.journal.at(-1).id;
  const usdPurchRes = repo.execute({
    id: 'purch-usd',
    revision: repo.state().revision,
    command: {
      type: 'supplierPurchase',
      date,
      supplierId: firmId,
      items: [{ accountId: 'ceyrek', quantity: '5' }],
      charges: [{ accountId: usdId, quantity: '5000' }]
    }
  });
  const usdPurchId = usdPurchRes.state.journal.at(-1).id;

  const h = createCodecHarness(t, repo);
  h.root.querySelector(`[data-open-firm="${firmId}"]`).click();
  h.root.querySelector('[data-supplier-task="offset"]').click();
  await waitForDocForm(h.root, 'offset', true);

  // Turkish grouped: fromQuantity '1.250,50', toQuantity '2.500,25', targetUses '2.500,25'
  h.fill('[name="fromAccountId"]', hasId, 'change');
  h.fill('[name="fromQuantity"]', '1.250,50', 'input');
  h.fill('[name="toAccountId"]', usdId, 'change');
  h.fill('[name="toQuantity"]', '2.500,25', 'input');
  h.root.querySelector('[data-add-source]').click();
  h.fill('[data-source-field="choice"]', JSON.stringify([advId, hasId]), 'change');
  h.fill('[data-source-field="quantity"]', '1.250,50', 'input');

  const targetDetails = h.root.querySelector('[data-offset-targets]').closest('details');
  targetDetails.open = true;
  h.root.querySelector('[data-add-offset-target]').click();
  h.fill('[data-target-field="purchaseId"]', usdPurchId, 'change');
  h.fill('[data-target-field="quantity"]', '2.500,25', 'input');
  h.fill('[name="note"]', 'Türkçe gruplu mahsup');

  h.root.querySelector('form[data-supplier-document-form="offset"]').requestSubmit();
  await waitForDocForm(h.root, 'offset', true);

  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].type, 'supplierOffset');
  assert.equal(h.sent[0].fromQuantity, '1250.50');
  assert.equal(h.sent[0].toQuantity, '2500.25');
  assert.equal(h.sent[0].sourceUses[0].quantity, '1250.50');
  assert.equal(h.sent[0].targetUses[0].quantity, '2500.25');

  let state = repo.state();
  assert.equal(state.balances[hasId], 20000000 - 1250500);
  assert.equal(state.balances[usdId], -500000 + 250025);
  let detail = projectSupplierDetail(state, { supplierId: firmId, limit: 50 });
  assert.equal(detail.documents.purchases[0].charges[0].remaining, 500000 - 250025);

  // Disambiguated '10.500' as 'thousands' on HAS in offset
  h.fill('[name="fromAccountId"]', hasId, 'change');
  const fromEl = h.root.querySelector('[name="fromQuantity"]');
  h.setValue(fromEl, '10.500', 'input');
  h.fill('[name="toAccountId"]', usdId, 'change');
  h.fill('[name="toQuantity"]', '100', 'input');
  h.root.querySelector('[data-add-source]').click();
  h.fill('[data-source-field="choice"]', JSON.stringify([advId, hasId]), 'change');
  const srcQtyEl = h.root.querySelector('[data-source-field="quantity"]');
  h.setValue(srcQtyEl, '10.500', 'input');
  h.fill('[name="note"]', 'Binlik ayrıştırmalı mahsup');

  // First submit triggers disambiguation on sourceUses quantity (sourcePicker.read runs before fromQuantity)
  h.root.querySelector('form[data-supplier-document-form="offset"]').requestSubmit();
  await tick();
  assert.equal(h.sent.length, 1);
  srcQtyEl.closest('label').querySelector('[data-amount-choice="thousands"]').click();

  // Next submit triggers disambiguation on fromQuantity
  h.root.querySelector('form[data-supplier-document-form="offset"]').requestSubmit();
  await tick();
  assert.equal(h.sent.length, 1);
  fromEl.closest('label').querySelector('[data-amount-choice="thousands"]').click();

  h.root.querySelector('form[data-supplier-document-form="offset"]').requestSubmit();
  await waitForDocForm(h.root, 'offset', true);

  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].fromQuantity, '10500');
  assert.equal(h.sent[1].sourceUses[0].quantity, '10500');
  state = repo.state();
  assert.equal(state.balances[hasId], 20000000 - 1250500 - 10500000);
  assert.equal(state.balances[usdId], -500000 + 250025 + 10000);
});

test('F3 return: canonicalizes returnQty, returnWeight (disambiguated), reductions, credits, received, and form-level referenceTL', async t => {
  const { repo, firmId, hasId, date } = seedBaseRepo(t);
  const purchRes = repo.execute({
    id: 'purch-ret',
    revision: repo.state().revision,
    command: {
      type: 'supplierPurchase',
      date,
      supplierId: firmId,
      items: [{ accountId: 'yuzuk', weightAccount: 'taki14', quantity: '4', weight: '20' }],
      charges: [{ accountId: hasId, quantity: '2000' }]
    }
  });
  const purchId = purchRes.state.journal.at(-1).id;
  const beforeState = repo.state();

  const h = createCodecHarness(t, repo);
  h.root.querySelector(`[data-open-firm="${firmId}"]`).click();
  h.root.querySelector('[data-supplier-task="return"]').click();
  await tick();
  await tick();

  h.fill('[name="originalId"]', purchId, 'change');
  h.fill('[name="returnQty-0"]', '2', 'input');
  const rwEl = h.root.querySelector('[name="returnWeight-0"]');
  h.setValue(rwEl, '1.250', 'input');
  const rwDecimalBtn = rwEl.closest('label').querySelector('[data-amount-choice="decimal"]');
  assert.ok(rwDecimalBtn, 'returnWeight-0 1.250 must render disambiguation');
  rwDecimalBtn.click();

  h.fill(`[name="reduction-${hasId}"]`, '1.000,50', 'input');

  h.root.querySelector('[data-document-group="credits"] [data-add-document-line]').click();
  h.fill('[data-document-group="credits"] [data-field="accountId"]', hasId, 'change');
  h.fill('[data-document-group="credits"] [data-field="quantity"]', '1.000,25', 'input');
  h.fill('[data-document-group="credits"] [data-field="referenceTL"]', '45.000,50', 'input');

  h.root.querySelector('[data-document-group="received"] [data-add-document-line]').click();
  h.fill('[data-document-group="received"] [data-field="accountId"]', 'nakit', 'change');
  h.fill('[data-document-group="received"] [data-field="quantity"]', '2.500,75', 'input');
  h.fill('[data-document-group="received"] [data-field="referenceTL"]', '2.500,75', 'input');

  h.fill('[name="note"]', 'F3 kanonik iade');
  h.fill('form[data-supplier-document-form="return"] input[name="referenceTL"]', '47.501,25', 'input');

  h.root.querySelector('form[data-supplier-document-form="return"]').requestSubmit();
  await tick();
  await tick();

  assert.equal(h.sent.length, 1);
  const cmd = h.sent[0];
  assert.equal(cmd.type, 'supplierReturn');
  assert.deepEqual(cmd.items, [{ lineIndex: 0, quantity: '2', weight: '1.250' }]);
  assert.deepEqual(cmd.reductions, [{ accountId: hasId, quantity: '1000.50' }]);
  assert.deepEqual(cmd.credits, [{ accountId: hasId, quantity: '1000.25', referenceTL: '45000.50' }]);
  assert.deepEqual(cmd.received, [{ accountId: 'nakit', quantity: '2500.75', referenceTL: '2500.75' }]);
  assert.equal(cmd.referenceTL, '47501.25');

  const afterState = repo.state();
  assert.equal(afterState.balances.yuzuk - beforeState.balances.yuzuk, -2);
  assert.equal(afterState.balances.taki14 - beforeState.balances.taki14, -1250);
  assert.equal(afterState.balances[hasId] - beforeState.balances[hasId], 1000250);
  assert.equal(afterState.balances.nakit - beforeState.balances.nakit, 250075);
  assert.equal(afterState.journal.at(-1).meta.referenceTL, 4750125);
});

test('F3 compatibility: mock context without canonicalValue remains compatible and legacyLink canonicalizes when present', async t => {
  // Part A: Mock context omitting canonicalValue (like qa-temp/supplier-*.mjs)
  {
    const dom = new JSDOM('<main></main>', { url: 'http://127.0.0.1/' });
    const root = dom.window.document.querySelector('main');
    const sent = [];
    const accounts = [{ id: 'has', unit: 'HAS', balance: 10000 }, { id: 'usd', unit: 'USD', balance: -20000 }];
    const supplier = { id: 'firm', name: 'Mock Firma', accounts };
    const documents = {
      sources: [{ id: 'source', kind: 'supplierPayment', date: '2026-11-01', advanceScope: 'general', credits: [{ accountId: 'has', unit: 'HAS', remaining: 5000 }] }],
      purchases: [{ id: 'purchase', kind: 'supplierPurchase', date: '2026-11-02', lines: [{ lineIndex: 1, accountId: 'coin', quantity: 5, remainingQuantity: 4 }], charges: [{ accountId: 'has', unit: 'HAS', remaining: 5000 }, { accountId: 'usd', unit: 'USD', remaining: 20000 }] }],
      unresolvedReceipts: [{ id: 'receipt', date: '2026-11-03', debts: [{ accountId: 'has', unit: 'HAS', quantity: 2000 }], sources: [{ id: 'source', kind: 'supplierPayment', date: '2026-11-01', credits: [{ accountId: 'has', unit: 'HAS', remaining: 5000 }] }] }]
    };
    const state = {
      revision: 9,
      date: '2026-11-10',
      supplierParties: [supplier],
      accounts: [{ id: 'coin', name: 'Çeyrek', unit: 'ADET', kind: 'asset', physical: true }, { id: 'cash', name: 'Nakit', unit: 'TL', kind: 'asset', physical: true }]
    };
    const api = renderSupplierWorkspace(root, {
      state,
      memory: new Map(),
      workspace: 'demo',
      escape: v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
      format: (n, u) => n + ' ' + u,
      day: x => x,
      refresh() {},
      parseAmount: (input, u) => input.value.trim() ? Math.round(Number(input.value) * (u === 'HAS' || u === 'GRAM' ? 1000 : u === 'ADET' ? 1 : 100)) : null,
      request: async () => ({ revision: 9, supplier, accounts, documents }),
      submit: async c => { sent.push(c); return false; }
    });
    t.after(() => { api.destroy(); dom.window.close(); });
    const fill = (sel, val) => {
      const el = root.querySelector(sel);
      el.value = val;
      el.dispatchEvent(new dom.window.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    };

    root.querySelector('[data-open-firm="firm"]').click();
    root.querySelector('[data-supplier-task="offset"]').click();
    await tick(); await tick();
    fill('[name="fromAccountId"]', 'has');
    fill('[name="fromQuantity"]', '2');
    fill('[name="toAccountId"]', 'usd');
    fill('[name="toQuantity"]', '50');
    fill('[name="note"]', 'Mock offset');
    root.querySelector('[data-add-source]').click();
    fill('[data-source-field="choice"]', JSON.stringify(['source', 'has']));
    fill('[data-source-field="quantity"]', '2');
    root.querySelector('[data-offset-targets]').closest('details').open = true;
    root.querySelector('[data-add-offset-target]').click();
    fill('[data-target-field="purchaseId"]', 'purchase');
    fill('[data-target-field="quantity"]', '10');
    root.querySelector('form').requestSubmit();
    await tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].fromQuantity, '2');
    assert.equal(sent[0].toQuantity, '50');
    assert.deepEqual(sent[0].targetUses, [{ purchaseId: 'purchase', quantity: '10' }]);

    root.querySelector('[data-supplier-task="return"]').click();
    await tick(); await tick();
    fill('[name="originalId"]', 'purchase');
    fill('[name="returnQty-1"]', '1');
    fill('[name="reduction-has"]', '2');
    root.querySelector('[data-document-group="credits"] [data-add-document-line]').click();
    fill('[data-document-group="credits"] select', 'has');
    fill('[data-document-group="credits"] input', '1.5');
    fill('[name="note"]', 'Mock return');
    root.querySelector('form').requestSubmit();
    await tick();
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1].credits, [{ accountId: 'has', quantity: '1.5' }]);
  }

  // Part B: legacyLink canonicalizes '1.000,50' -> '1000.50' when canonicalValue is supplied
  {
    const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', {
      url: 'http://127.0.0.1/',
      runScripts: 'outside-only'
    });
    const savedGlobals = {
      window: globalThis.window,
      document: globalThis.document,
      HTMLInputElement: globalThis.HTMLInputElement,
      Event: globalThis.Event
    };
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.HTMLInputElement = dom.window.HTMLInputElement;
    globalThis.Event = dom.window.Event;
    dom.window.eval(AMOUNT_CODEC_SOURCE);
    const codec = dom.window.DefterAmountCodec;

    const root = dom.window.document.querySelector('main');
    const sent = [];
    const accounts = [{ id: 'has', unit: 'HAS', balance: 0 }];
    const supplier = { id: 'firm', name: 'Legacy Firma', accounts };
    const documents = {
      sources: [{ id: 'source', kind: 'supplierPayment', date: '2026-11-01', advanceScope: 'general', credits: [{ accountId: 'has', unit: 'HAS', remaining: 5000000 }] }],
      purchases: [],
      unresolvedReceipts: [{ id: 'receipt', date: '2026-11-03', debts: [{ accountId: 'has', unit: 'HAS', quantity: 1000500 }], sources: [{ id: 'source', kind: 'supplierPayment', date: '2026-11-01', credits: [{ accountId: 'has', unit: 'HAS', remaining: 5000000 }] }] }]
    };
    const state = { revision: 9, date: '2026-11-10', supplierParties: [supplier], accounts: [] };
    const api = renderSupplierWorkspace(root, {
      state,
      memory: new Map(),
      workspace: 'demo',
      escape: v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
      format: codec.formatAmount,
      day: x => x,
      parseAmount: codec.parseInputElement,
      canonicalValue: codec.canonicalInputValue,
      refresh() {},
      request: async () => ({ revision: 9, supplier, accounts, documents }),
      submit: async c => { sent.push(c); return false; }
    });
    t.after(() => {
      api.destroy();
      dom.window.close();
      for (const [k, v] of Object.entries(savedGlobals)) {
        if (v === undefined) delete globalThis[k];
        else globalThis[k] = v;
      }
    });

    root.querySelector('[data-open-firm="firm"]').click();
    root.querySelector('[data-supplier-documents]').click();
    await tick(); await tick();
    root.querySelector('[data-supplier-legacy]').click();
    await tick(); await tick();
    const fill = (sel, val) => {
      const el = root.querySelector(sel);
      el.value = val;
      el.dispatchEvent(new dom.window.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    };
    fill('[name="originalId"]', 'receipt');
    root.querySelector('[data-add-legacy-source]').click();
    fill('[data-legacy-rows] select', JSON.stringify(['source', 'has']));
    fill('[data-legacy-rows] input', '1.000,50');
    root.querySelector('form').requestSubmit();
    await tick();

    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'supplierLegacyReceiptLink');
    assert.deepEqual(sent[0].uses, [{ sourceId: 'source', accountId: 'has', quantity: '1000.50' }]);
  }
});

async function waitForSelector(root, selector, predicate = () => true) {
  for (let i = 0; i < 40; i++) {
    const el = root.querySelector(selector);
    if (el && predicate(el)) return el;
    await tick();
  }
  throw new Error(`Timed out waiting for selector ${selector}`);
}

test('F3 edit round-trip: onRecordAction converts canonical dot-decimals back to comma notation across purchase, payment, offset, and return without mangling non-amount fields', async t => {
  // Part A: Challenger Probe 7 reproduction & amend round-trip on purchase ('1.250,125' -> '1250.125' -> '1250,125' -> amend to '1.250,250')
  {
    const { repo, firmId, hasId } = seedBaseRepo(t);
    const h = createCodecHarness(t, repo);

    h.root.querySelector(`[data-open-firm="${firmId}"]`).click();
    h.root.querySelector('[data-supplier-task="purchase"]').click();
    const pForm = await waitForSelector(h.root, 'form[data-supplier-form="purchase"]');

    h.fill('[data-group="items"] [data-row] [data-field="accountId"]', 'hurda22', 'change');
    h.fill('[data-group="items"] [data-row] [data-field="quantity"]', '1.250,125', 'input');
    h.fill('[data-group="items"] [data-row] [data-field="referenceTL"]', '1.500,25', 'input');
    h.fill('[data-group="charges"] [data-row] [data-field="accountId"]', hasId, 'change');
    h.fill('[data-group="charges"] [data-row] [data-field="quantity"]', '1.250,125', 'input');
    h.fill('form[data-supplier-form="purchase"] input[name="agreementId"]', 'AGR.10.500', 'input');
    h.fill('form[data-supplier-form="purchase"] input[name="note"]', 'Not 1.500 ve 10.500 korunmalı', 'input');
    h.fill('form[data-supplier-form="purchase"] input[name="referenceTL"]', '25.000,50', 'input');

    pForm.requestSubmit();
    await tick();
    await tick();
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].items[0].quantity, '1250.125');
    assert.equal(h.sent[0].charges[0].quantity, '1250.125');
    const purchId = repo.state().journal.at(-1).id;

    // Open history and click "İşlemi düzelt"
    h.root.querySelector('[data-supplier-task="history"]').click();
    const editBtn = await waitForSelector(h.root, `[data-edit-supplier-event="${purchId}"]`);
    editBtn.click();

    const editForm = await waitForSelector(h.root, 'form[data-supplier-form="purchase"]');
    const editItemQty = editForm.querySelector('[data-group="items"] [data-row] [data-field="quantity"]');
    const editItemRef = editForm.querySelector('[data-group="items"] [data-row] [data-field="referenceTL"]');
    const editChargeQty = editForm.querySelector('[data-group="charges"] [data-row] [data-field="quantity"]');
    const editRef = editForm.elements.referenceTL;

    assert.equal(editItemQty.value, '1250,125');
    assert.equal(editItemQty.checkValidity(), true, 'Probe 7: edited 3-decimal >=1000 input must be valid');
    assert.equal(editChargeQty.value, '1250,125');
    assert.equal(editChargeQty.checkValidity(), true);
    assert.equal(editItemRef.value, '1500,25');
    assert.equal(editItemRef.checkValidity(), true);
    assert.equal(editRef.value, '25000,50');
    assert.equal(editRef.checkValidity(), true);
    assert.equal(editForm.elements.note.value, 'Not 1.500 ve 10.500 korunmalı');
    assert.equal(editForm.elements.agreementId.value, 'AGR.10.500');
    const previewText = editForm.querySelector('[data-supplier-preview]').textContent;
    assert.ok(!previewText.includes('Eksik veya geçersiz miktarlar var'), `Preview must calculate cleanly: ${previewText}`);
    assert.ok(previewText.includes('1.250,125'), `Preview must display formatted 1.250,125: ${previewText}`);

    // Amend to '1.250,250' and re-submit
    h.setValue(editItemQty, '1.250,250', 'input');
    h.setValue(editChargeQty, '1.250,250', 'input');
    h.setValue(editForm.elements.amendNote, 'Probe 7 düzeltme', 'input');
    editForm.requestSubmit();
    await tick();
    await tick();

    assert.equal(h.sent.length, 2);
    assert.equal(h.sent[1].type, 'supplierAmend');
    assert.equal(h.sent[1].originalId, purchId);
    assert.equal(h.sent[1].replacement.items[0].quantity, '1250.250');
    assert.equal(h.sent[1].replacement.charges[0].quantity, '1250.250');
    assert.equal(h.sent[1].replacement.note, 'Not 1.500 ve 10.500 korunmalı');
    assert.equal(h.sent[1].replacement.agreementId, 'AGR.10.500');
    assert.equal(repo.state().balances.hurda22, 1250250);
    assert.equal(repo.state().balances[hasId], -1250250);
  }

  // Part B: payment ('10.500' decimal without re-disambiguation), offset (sourceUses/targetUses + reasons), and return (weight/reduction/credits/referenceTL)
  {
    const { repo, firmId, hasId, usdId, date } = seedBaseRepo(t);
    const h = createCodecHarness(t, repo);

    h.root.querySelector(`[data-open-firm="${firmId}"]`).click();
    h.root.querySelector('[data-supplier-task="payment"]').click();
    const payForm = await waitForSelector(h.root, 'form[data-supplier-form="payment"]');
    h.fill('[data-group="given"] [data-row] [data-field="accountId"]', 'nakit', 'change');
    h.fill('[data-group="given"] [data-row] [data-field="quantity"]', '5.000,50', 'input');
    h.fill('[data-group="credits"] [data-row] [data-field="accountId"]', hasId, 'change');
    const payCreditInput = h.root.querySelector('[data-group="credits"] [data-row] [data-field="quantity"]');
    h.setValue(payCreditInput, '10.500', 'input');
    payCreditInput.closest('label').querySelector('[data-amount-choice="decimal"]').click();
    h.fill('form[data-supplier-form="payment"] input[name="agreementId"]', 'AG.1.2', 'input');
    h.fill('form[data-supplier-form="payment"] input[name="note"]', 'Avans 10.500', 'input');
    payForm.requestSubmit();
    await tick();
    await tick();
    const payId = repo.state().journal.at(-1).id;

    // Edit payment: '10.500' -> '10,500' (no disambiguation prompt), amend to '1.250,125'
    h.root.querySelector('[data-supplier-task="history"]').click();
    (await waitForSelector(h.root, `[data-edit-supplier-event="${payId}"]`)).click();
    const editPayForm = await waitForSelector(h.root, 'form[data-supplier-form="payment"]');
    const editPayCredit = editPayForm.querySelector('[data-group="credits"] [data-row] [data-field="quantity"]');
    assert.equal(editPayCredit.value, '10,500');
    assert.equal(editPayCredit.checkValidity(), true);
    assert.equal(editPayForm.querySelectorAll('.amount-disambiguation').length, 0, '10,500 must not re-trigger disambiguation');
    assert.equal(editPayForm.querySelector('[data-group="given"] [data-row] [data-field="quantity"]').value, '5000,50');
    assert.equal(editPayForm.elements.note.value, 'Avans 10.500');
    assert.equal(editPayForm.elements.agreementId.value, 'AG.1.2');

    h.setValue(editPayCredit, '1.250,125', 'input');
    h.setValue(editPayForm.elements.amendNote, 'Avans düzeltme', 'input');
    editPayForm.requestSubmit();
    await tick();
    await tick();
    assert.equal(repo.state().balances[hasId], 1250125);
    const activePayId = repo.state().journal.at(-1).id;

    // Seed USD purchase + offset, then test offset edit round-trip
    const usdPurchId = repo.execute({
      id: 'seed-usd-purch',
      revision: repo.state().revision,
      command: {
        type: 'supplierPurchase',
        date,
        supplierId: firmId,
        items: [{ accountId: 'yuzuk', weightAccount: 'taki14', quantity: '4', weight: '20' }],
        charges: [{ accountId: usdId, quantity: '5000' }],
        agreementId: 'AG.9'
      }
    }).state.journal.at(-1).id;
    const offsetId = repo.execute({
      id: 'seed-offset',
      revision: repo.state().revision,
      command: {
        type: 'supplierOffset',
        date,
        supplierId: firmId,
        fromAccountId: hasId,
        fromQuantity: '1250.125',
        toAccountId: usdId,
        toQuantity: '1000.50',
        sourceUses: [{ sourceId: activePayId, quantity: '1250.125' }],
        targetUses: [{ purchaseId: usdPurchId, quantity: '1000.50', overrideReserved: true, reason: 'Hedef 2.5 uyarlandı' }],
        note: 'Mahsup 1.250'
      }
    }).state.journal.at(-1).id;
    h.api.update({ ...repo.state(), supplierParties: projectSupplierParties(repo.state()) });

    // Edit offset
    h.root.querySelector('[data-supplier-task="history"]').click();
    (await waitForSelector(h.root, `[data-edit-supplier-event="${offsetId}"]`)).click();
    const editOffsetForm = await waitForDocForm(h.root, 'offset', true);
    assert.equal(editOffsetForm.elements.fromQuantity.value, '1250,125');
    assert.equal(editOffsetForm.elements.toQuantity.value, '1000,50');
    assert.equal(editOffsetForm.querySelector('[data-source-field="quantity"]').value, '1250,125');
    assert.equal(editOffsetForm.querySelector('[data-target-field="quantity"]').value, '1000,50');
    assert.equal(editOffsetForm.querySelector('[data-target-field="reason"]').value, 'Hedef 2.5 uyarlandı');
    assert.equal(editOffsetForm.elements.note.value, 'Mahsup 1.250');

    h.setValue(editOffsetForm.elements.toQuantity, '1.000,75', 'input');
    h.setValue(editOffsetForm.querySelector('[data-target-field="quantity"]'), '1.000,75', 'input');
    h.setValue(editOffsetForm.elements.amendNote, 'Mahsup tutar düzeltme', 'input');
    editOffsetForm.requestSubmit();
    await tick();
    await tick();
    assert.equal(repo.state().balances[usdId], -500000 + 100075);

    // Seed return and test return edit round-trip
    const retId = repo.execute({
      id: 'seed-return',
      revision: repo.state().revision,
      command: {
        type: 'supplierReturn',
        date,
        supplierId: firmId,
        originalId: usdPurchId,
        items: [{ lineIndex: 0, quantity: '2', weight: '10.500' }],
        reductions: [{ accountId: usdId, quantity: '500.50' }],
        credits: [{ accountId: usdId, quantity: '500.50', referenceTL: '15000.25' }],
        referenceTL: '15000.25',
        note: 'İade 10.500'
      }
    }).state.journal.at(-1).id;
    h.api.update({ ...repo.state(), supplierParties: projectSupplierParties(repo.state()) });

    // Edit return
    h.root.querySelector('[data-supplier-task="history"]').click();
    (await waitForSelector(h.root, `[data-edit-supplier-event="${retId}"]`)).click();
    const editReturnForm = await waitForDocForm(h.root, 'return', false);
    const editRetWeight = editReturnForm.elements['returnWeight-0'];
    assert.equal(editRetWeight.value, '10,500');
    assert.equal(editRetWeight.checkValidity(), true);
    assert.equal(editReturnForm.querySelectorAll('.amount-disambiguation').length, 0);
    assert.equal(editReturnForm.elements[`reduction-${usdId}`].value, '500,50');
    assert.equal(editReturnForm.querySelector('[data-document-group="credits"] [data-field="quantity"]').value, '500,50');
    assert.equal(editReturnForm.querySelector('[data-document-group="credits"] [data-field="referenceTL"]').value, '15000,25');
    assert.equal(editReturnForm.elements.referenceTL.value, '15000,25');
    assert.equal(editReturnForm.elements.note.value, 'İade 10.500');

    h.setValue(editRetWeight, '11,250', 'input');
    h.setValue(editReturnForm.elements.amendNote, 'İade gram düzeltme', 'input');
    editReturnForm.requestSubmit();
    await tick();
    await tick();
    assert.equal(repo.state().balances[usdId], -500000 + 100075 + 50050);
    assert.equal(repo.state().balances.taki14, 100000 + 20000 - 11250);
  }
});
