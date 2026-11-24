import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS, replay, currentCountPolicy } from '../domain.mjs';
import { STANDARD_SUPPLIER_UNITS, supplierGivenScrapBalances } from '../supplier-ledger.mjs';

const d0 = '2026-11-23';

function setupRepo(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'er-sat-ux-core-'));
  const repo = new Repository(path.join(dir, 'demo.sqlite'), 'demo');
  t.after(() => { repo.close(); rmSync(dir, { recursive: true, force: true }); });
  const balances = Object.fromEntries(INITIAL_ACCOUNTS.map(a => [a.id, a.retired ? '0' : a.id === 'nakit' ? '500000' : a.id === 'hurda22' ? '50' : a.id === 'gramToplam' ? '100' : '0']));
  repo.execute({ id: 'open-1', revision: 0, command: { type: 'opening', date: d0, balances, banks: [{ name: 'Ziraat TL', unit: 'TL', opening: '100000' }] } });
  return repo;
}

function exec(repo, id, command) {
  return repo.execute({ id, revision: repo.state().revision, command: { date: repo.state().date, ...command } });
}

test('autoUnits on supplierFirm and autoSupplierUnits on fundAccount keep all supplier units synchronized', t => {
  const repo = setupRepo(t);
  exec(repo, 'f1', { type: 'supplierFirm', name: 'Alfa Toptan', autoUnits: true });
  const firm1 = repo.state().supplierParties.find(f => f.id === 'supplier-f1');
  assert.ok(firm1);
  for (const unit of STANDARD_SUPPLIER_UNITS) {
    assert.ok(firm1.accounts.some(a => a.unit === unit), `Alfa Toptan should have ${unit}`);
  }
  // Adding a custom 3-letter currency fund auto-provisions it for existing suppliers
  exec(repo, 'sar-fund', { type: 'fundAccount', name: 'Nakit SAR', unit: 'SAR', physical: true, opening: '1000', autoSupplierUnits: true });
  const firm1After = repo.state().supplierParties.find(f => f.id === 'supplier-f1');
  assert.ok(firm1After.accounts.some(a => a.unit === 'SAR'), 'SAR auto-added to existing supplier');
  // New supplier firm also gets SAR automatically
  exec(repo, 'f2', { type: 'supplierFirm', name: 'Beta Toptan', autoUnits: true });
  const firm2 = repo.state().supplierParties.find(f => f.id === 'supplier-f2');
  assert.ok(firm2.accounts.some(a => a.unit === 'SAR'), 'SAR auto-added to new supplier');
  assert.equal(replay(repo.events()).accounts.length, repo.state().accounts.length);
});

test('supplierTransfer (virman) transfers from receivable or creates debt, allocates cleanly, and reverses', t => {
  const repo = setupRepo(t);
  exec(repo, 'f1', { type: 'supplierFirm', name: 'Firma A', autoUnits: true });
  exec(repo, 'f2', { type: 'supplierFirm', name: 'Firma B', autoUnits: true });
  const aHas = repo.state().supplierParties.find(f => f.id === 'supplier-f1').accounts.find(a => a.unit === 'HAS').id;
  const bHas = repo.state().supplierParties.find(f => f.id === 'supplier-f2').accounts.find(a => a.unit === 'HAS').id;

  // Give Firma A 150 gr HAS receivable (paid with nakit TL)
  exec(repo, 'pay-a', {
    type: 'supplierPayment', supplierId: 'supplier-f1', advanceScope: 'general',
    given: [{ accountId: 'nakit', quantity: '450000' }],
    credits: [{ accountId: aHas, quantity: '150' }],
    received: [], debts: []
  });
  // Buy from Firma B creating 120 gr HAS debt
  exec(repo, 'buy-b', {
    type: 'supplierPurchase', supplierId: 'supplier-f2',
    items: [{ accountId: 'gramToplam', quantity: '120' }],
    charges: [{ accountId: bHas, quantity: '120' }],
    given: [], credits: [], received: [], debts: []
  });
  assert.equal(repo.state().balances[aHas], 150000);
  assert.equal(repo.state().balances[bHas], -120000);

  // Virman 100 gr HAS from Firma A -> Firma B
  exec(repo, 'virman-1', {
    type: 'supplierTransfer', fromSupplierId: 'supplier-f1', toSupplierId: 'supplier-f2',
    unit: 'HAS', quantity: '100', note: '100 gr HAS virman'
  });
  assert.equal(repo.state().balances[aHas], 50000);
  assert.equal(repo.state().balances[bHas], -20000);

  // Virman 80 gr HAS (exceeds remaining 50 gr receivable -> creates 30 gr debt on Firma A, +60 gr receivable on Firma B)
  exec(repo, 'virman-2', {
    type: 'supplierTransfer', fromSupplierId: 'supplier-f1', toSupplierId: 'supplier-f2',
    unit: 'HAS', quantity: '80', note: 'Alacağı aşan borç doğuran virman'
  });
  assert.equal(repo.state().balances[aHas], -30000);
  assert.equal(repo.state().balances[bHas], 60000);

  // Reverse virman-2 cleanly
  exec(repo, 'rev-v2', { type: 'supplierReverse', originalId: 'virman-2', note: 'Virman iptali' });
  assert.equal(repo.state().balances[aHas], 50000);
  assert.equal(repo.state().balances[bHas], -20000);

  // Same-firm virman rejected
  assert.throws(() => exec(repo, 'bad-v', {
    type: 'supplierTransfer', fromSupplierId: 'supplier-f1', toSupplierId: 'supplier-f1',
    unit: 'HAS', quantity: '10', note: 'Geçersiz'
  }));

  // Replay parity
  const replayed = replay(repo.events());
  assert.equal(replayed.balances[aHas], 50000);
  assert.equal(replayed.balances[bHas], -20000);
});

test('supplier scrap policy: blocks hurda8..22 in purchase, allows hurda24, allows given hurda and bounded return', t => {
  const repo = setupRepo(t);
  exec(repo, 'f1', { type: 'supplierFirm', name: 'Hurda Test Firma', autoUnits: true });
  const fHas = repo.state().supplierParties.find(f => f.id === 'supplier-f1').accounts.find(a => a.unit === 'HAS').id;

  // Buying hurda22 from supplier is rejected
  assert.throws(() => exec(repo, 'bad-hurda-buy', {
    type: 'supplierPurchase', supplierId: 'supplier-f1',
    items: [{ accountId: 'hurda22', quantity: '5' }],
    charges: [{ accountId: fHas, quantity: '4.5' }],
    given: [], credits: [], received: [], debts: []
  }), /hurda/i);

  // Buying 24 AYAR HAS (hurda24) IS allowed
  exec(repo, 'ok-has24-buy', {
    type: 'supplierPurchase', supplierId: 'supplier-f1',
    items: [{ accountId: 'hurda24', quantity: '10' }],
    charges: [{ accountId: fHas, quantity: '10' }],
    given: [], credits: [], received: [], debts: []
  });

  // Receiving hurda22 before giving any is rejected
  assert.throws(() => exec(repo, 'bad-hurda-recv', {
    type: 'supplierPayment', supplierId: 'supplier-f1', advanceScope: 'general',
    given: [], credits: [],
    received: [{ accountId: 'hurda22', quantity: '2' }],
    debts: [{ accountId: fHas, quantity: '1.8' }]
  }), /iade/i);

  // Giving 10 gr hurda22 to supplier is allowed
  exec(repo, 'give-hurda', {
    type: 'supplierPayment', supplierId: 'supplier-f1', advanceScope: 'general',
    given: [{ accountId: 'hurda22', quantity: '10' }],
    credits: [{ accountId: fHas, quantity: '9.16' }],
    received: [], debts: []
  });
  assert.deepEqual(supplierGivenScrapBalances(repo.state(), 'supplier-f1'), { hurda22: 10000 });

  // Receiving 4 gr hurda22 back as return is allowed
  exec(repo, 'return-hurda', {
    type: 'supplierPayment', supplierId: 'supplier-f1', advanceScope: 'general',
    given: [], credits: [],
    received: [{ accountId: 'hurda22', quantity: '4' }],
    debts: [{ accountId: fHas, quantity: '3.66' }],
    debtUses: [{ sourceId: 'give-hurda', accountId: fHas, quantity: '3.66' }]
  });
  assert.deepEqual(supplierGivenScrapBalances(repo.state(), 'supplier-f1'), { hurda22: 6000 });

  // Receiving 7 gr more (> remaining 6 gr) is rejected
  assert.throws(() => exec(repo, 'excess-hurda-return', {
    type: 'supplierPayment', supplierId: 'supplier-f1', advanceScope: 'general',
    given: [], credits: [],
    received: [{ accountId: 'hurda22', quantity: '7' }],
    debts: [{ accountId: fHas, quantity: '6.4' }]
  }), /iade/i);
});

test('journalPage supports supplier group, supplierTransfer, unit, and status filters', t => {
  const repo = setupRepo(t);
  exec(repo, 'f1', { type: 'supplierFirm', name: 'Firma 1', autoUnits: true });
  exec(repo, 'f2', { type: 'supplierFirm', name: 'Firma 2', autoUnits: true });
  exec(repo, 'ag-fund', { type: 'fundAccount', name: 'Gümüş Kasa', unit: 'SILVER', physical: true, opening: '250', autoSupplierUnits: true });
  assert.equal(currentCountPolicy(repo.state().accounts.find(a => a.id === 'fund-ag-fund')), 'daily');

  exec(repo, 'v1', { type: 'supplierTransfer', fromSupplierId: 'supplier-f1', toSupplierId: 'supplier-f2', unit: 'SILVER', quantity: '25', note: 'Gümüş virman' });
  exec(repo, 'rv1', { type: 'supplierReverse', originalId: 'v1', note: 'Gümüş virman iptal' });

  const supAll = repo.journalPage({ scope: 'all', type: 'supplier' });
  assert.ok(supAll.items.some(e => e.id === 'v1'));
  assert.ok(supAll.items.some(e => e.id === 'rv1'));

  const onlyTransfer = repo.journalPage({ scope: 'all', type: 'supplierTransfer' });
  assert.deepEqual(onlyTransfer.items.map(e => e.id), ['v1']);

  const silverOnly = repo.journalPage({ scope: 'all', unit: 'SILVER' });
  assert.ok(silverOnly.items.some(e => e.id === 'v1'));
  assert.ok(silverOnly.items.some(e => e.id === 'ag-fund'));
  assert.ok(!silverOnly.items.some(e => e.id === 'open-1'));

  const activeOnly = repo.journalPage({ scope: 'all', type: 'supplier', status: 'active' });
  assert.ok(!activeOnly.items.some(e => e.id === 'v1'));
  assert.ok(!activeOnly.items.some(e => e.id === 'rv1'));

  const reversedOnly = repo.journalPage({ scope: 'all', type: 'supplier', status: 'reversed' });
  assert.ok(reversedOnly.items.some(e => e.id === 'v1'));
  assert.ok(reversedOnly.items.some(e => e.id === 'rv1'));
});

test('createWizardStepper uses nav/ol/aria-current="step" and reveals hidden required fields on submit', async () => {
  const { readFileSync } = await import('node:fs');
  const { JSDOM } = await import('jsdom');
  const uiKitSrc = readFileSync(new URL('../public/ui-kit.js', import.meta.url), 'utf8');
  const dom = new JSDOM('<!doctype html><html><body><form id="f"></form></body></html>', { runScripts: 'outside-only', url: 'http://127.0.0.1:4317/' });
  try {
    dom.window.eval(uiKitSrc);
    const { document } = dom.window;
    const form = document.getElementById('f');
    const p1 = document.createElement('section');
    const i1 = document.createElement('input');
    i1.name = 'first';
    i1.required = true;
    p1.append(i1);
    const p2 = document.createElement('section');
    const i2 = document.createElement('input');
    i2.name = 'second';
    i2.required = true;
    p2.append(i2);
    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.textContent = 'Kaydet';
    form.append(p1, p2);

    const wiz = dom.window.DefterUI.createWizardStepper({
      form,
      steps: [
        { id: 's1', title: 'Birinci Adım', panel: p1 },
        { id: 's2', title: 'İkinci Adım', panel: p2 }
      ],
      submitButton: submitBtn,
      navLabel: 'Test sihirbazı'
    });
    form.prepend(wiz.nav, wiz.live);
    form.append(wiz.footer);

    // Accessibility contract: nav + ol + aria-current="step", never role="tablist"
    assert.equal(wiz.nav.tagName, 'NAV');
    assert.equal(wiz.nav.getAttribute('role'), null);
    assert.ok(wiz.nav.querySelector('ol.wizard-stepper-list'));
    assert.equal(wiz.nav.querySelector('[data-wizard-step-btn="0"]').getAttribute('aria-current'), 'step');
    assert.equal(wiz.nav.querySelector('[data-wizard-step-btn="1"]').getAttribute('aria-current'), null);

    // Step 1 hidden field remains required & enabled
    assert.equal(p2.hidden, true);
    assert.equal(i2.required, true);
    assert.equal(i2.disabled, false);

    // Trying to advance with empty required input in Step 0 stays on Step 0
    wiz.nextBtn.click();
    assert.equal(wiz.getCurrentStep(), 0);
    assert.equal(p1.hidden, false);

    // Fill Step 0, advance to Step 1, then clear Step 0 while on Step 1 -> validateAllSteps jumps back to Step 0
    i1.value = '100';
    wiz.nextBtn.click();
    assert.equal(wiz.getCurrentStep(), 1);
    assert.equal(p1.hidden, true);
    assert.equal(p2.hidden, false);
    assert.equal(i1.required, true);
    assert.equal(i1.disabled, false);

    i1.value = '';
    i2.value = '200';
    assert.equal(wiz.validateAllSteps(), false);
    assert.equal(wiz.getCurrentStep(), 0);
    assert.equal(p1.hidden, false);

    // Fill both -> validateAllSteps passes
    i1.value = '100';
    assert.equal(wiz.validateAllSteps(), true);
    wiz.destroy();
  } finally {
    dom.window.close();
  }
});
