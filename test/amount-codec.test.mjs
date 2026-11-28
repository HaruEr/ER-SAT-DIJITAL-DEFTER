import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import '../public/amount-codec.js';
import '../public/date-format.js';
import { quantity, decimal, applyEvent, emptyState, INITIAL_ACCOUNTS } from '../domain.mjs';
import { Repository } from '../repository.mjs';

const codec = globalThis.DefterAmountCodec;
const dateFmt = globalThis.DefterDateFormat;

test('Turkish amount codec matrix: 10.000,50 / 10,500 / 10.500 / 10500 / 10.5 across all units', () => {
  // 10.000,50
  const tlGrouped = codec.parseUserAmount('10.000,50', 'TL', { positive: true });
  assert.equal(tlGrouped.status, 'valid');
  assert.equal(tlGrouped.canonical, '10000.50');
  assert.equal(tlGrouped.scaled, 1000050);
  assert.equal(quantity(tlGrouped.canonical, 'TL'), tlGrouped.scaled);
  assert.equal(tlGrouped.formatted, '10.000,50 TL');

  const hasGrouped = codec.parseUserAmount('10.000,50', 'HAS', { positive: true });
  assert.equal(hasGrouped.status, 'valid');
  assert.equal(hasGrouped.canonical, '10000.50');
  assert.equal(hasGrouped.scaled, 10000500);
  assert.equal(quantity(hasGrouped.canonical, 'HAS'), hasGrouped.scaled);

  assert.equal(codec.parseUserAmount('10.000,50', 'ADET', { positive: true }).status, 'invalid');

  // 10,500
  const hasComma = codec.parseUserAmount('10,500', 'HAS', { positive: true });
  assert.equal(hasComma.status, 'valid');
  assert.equal(hasComma.canonical, '10.500');
  assert.equal(hasComma.scaled, 10500);
  assert.equal(quantity(hasComma.canonical, 'HAS'), 10500);

  assert.equal(codec.parseUserAmount('10,500', 'TL', { positive: true }).status, 'invalid');
  assert.equal(codec.parseUserAmount('10,500', 'USD', { positive: true }).status, 'invalid');
  assert.equal(codec.parseUserAmount('10,500', 'ADET', { positive: true }).status, 'invalid');

  // 10.500: TL/FX/ADET -> thousands; GRAM/HAS/SILVER -> ambiguous unless resolved
  const tlThousands = codec.parseUserAmount('10.500', 'TL', { positive: true });
  assert.equal(tlThousands.status, 'valid');
  assert.equal(tlThousands.canonical, '10500');
  assert.equal(tlThousands.scaled, 1050000);

  const adetThousands = codec.parseUserAmount('10.500', 'ADET', { positive: true });
  assert.equal(adetThousands.status, 'valid');
  assert.equal(adetThousands.canonical, '10500');
  assert.equal(adetThousands.scaled, 10500);

  for (const unit of ['GRAM', 'HAS', 'SILVER']) {
    const ambiguous = codec.parseUserAmount('10.500', unit, { positive: true });
    assert.equal(ambiguous.status, 'ambiguous');
    assert.equal(ambiguous.options.length, 2);

    const asThousands = codec.parseUserAmount('10.500', unit, { positive: true, resolution: 'thousands' });
    assert.equal(asThousands.status, 'valid');
    assert.equal(asThousands.canonical, '10500');
    assert.equal(asThousands.scaled, 10500000);
    assert.equal(quantity(asThousands.canonical, unit), 10500000);

    const asDecimal = codec.parseUserAmount('10.500', unit, { positive: true, resolution: 'decimal' });
    assert.equal(asDecimal.status, 'valid');
    assert.equal(asDecimal.canonical, '10.500');
    assert.equal(asDecimal.scaled, 10500);
    assert.equal(quantity(asDecimal.canonical, unit), 10500);
  }

  // 10.5 and 10500
  const dotDecimal = codec.parseUserAmount('10.5', 'TL', { positive: true });
  assert.equal(dotDecimal.status, 'valid');
  assert.equal(dotDecimal.canonical, '10.5');
  assert.equal(dotDecimal.scaled, 1050);
  assert.equal(codec.parseUserAmount('10.5', 'ADET', { positive: true }).status, 'invalid');
  assert.equal(codec.parseUserAmount('10500', 'HAS', { positive: true }).scaled, 10500000);

  // Negatives, zero, and > 1e12 upper bound
  assert.equal(codec.parseUserAmount('-10', 'TL', { positive: false }).status, 'invalid');
  assert.equal(codec.parseUserAmount('0', 'TL', { positive: true }).status, 'invalid');
  assert.equal(codec.parseUserAmount('0', 'TL', { positive: false, allowZero: true }).scaled, 0);
  assert.equal(codec.parseUserAmount('10000000000000', 'TL', { positive: true }).status, 'invalid');
  assert.equal(codec.parseUserAmount('99999999999999999999', 'TL', { positive: true }).status, 'invalid');
});

test('Date formatting module is independent of financial amount codec', () => {
  assert.equal(typeof dateFmt.formatTurkishDate, 'function');
  assert.equal(typeof dateFmt.todayIstanbul, 'function');
  assert.match(dateFmt.todayIstanbul(), /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(dateFmt.formatTurkishDate('2026-11-16').includes('2026'));
});

test('Server domain rejects uncanonical grouped input while accepting canonical disambiguated amount and preserving legacy replay', () => {
  assert.throws(() => quantity('10.000,50', 'TL'));

  const repo = new Repository(':memory:', 'codec-test');
  try {
    const balances = Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, '0']));
    balances.nakit = '50000';
    repo.execute({ id: 'op-1', revision: 0, command: { type: 'opening', date: '2026-11-16', balances } });

    // Multi-unit supplier + mixed payment using canonical values from codec
    const firm = repo.execute({
      id: 'sup-1', revision: 1,
      command: { type: 'supplierFirm', date: '2026-11-16', name: 'Test Toptancı' }
    });
    const firmId = firm.state.journal.at(-1).meta.supplierId;
    assert.ok(firmId);

    const hasUnit = repo.execute({
      id: 'sup-u1', revision: 2,
      command: { type: 'supplierUnit', date: '2026-11-16', supplierId: firmId, unit: 'HAS' }
    });
    const firmHasId = hasUnit.state.journal.at(-1).meta.accountId;
    assert.ok(firmHasId);

    // User entered "10.500" HAS and explicitly chose 'decimal' (10,500 has gr -> 10500 mg)
    const resolvedHas = codec.parseUserAmount('10.500', 'HAS', { positive: true, resolution: 'decimal' });
    const resolvedTL = codec.parseUserAmount('10.000,50', 'TL', { positive: true });
    const payment = repo.execute({
      id: 'sup-pay-1', revision: 3,
      command: {
        type: 'supplierPayment',
        date: '2026-11-16',
        supplierId: firmId,
        given: [{ accountId: 'nakit', quantity: resolvedTL.canonical, referenceTL: resolvedTL.canonical }],
        credits: [{ accountId: firmHasId, quantity: resolvedHas.canonical, referenceTL: resolvedTL.canonical }],
        note: 'Paket 1B test'
      }
    });
    assert.equal(payment.state.balances[firmHasId], 10500);
    assert.equal(decimal(payment.state.balances.nakit, 'TL'), '39999.50');

    // Legacy event replay compatibility (v2/v3 event with dot-decimal string)
    const legacyState = emptyState();
    const nextLegacy = applyEvent(legacyState, { id: 'leg-1', schemaVersion: 3, timestamp: '2025-01-01T10:00:00Z', command: { type: 'opening', date: '2025-01-01', balances: { ...balances, bilezik22: '10.500' } } });
    assert.equal(nextLegacy.balances.bilezik22, 10500);
  } finally {
    repo.close();
  }
});

test('Paket 1B extra regressions: table-driven multi-unit matrix, resolution invalidation on user edit, and v16/v17 replay independence', () => {
  const cases = [
    ['TL', '1.250,75', 'valid', '1250.75', 125075, '1.250,75 TL'],
    ['USD', '2.500,50', 'valid', '2500.50', 250050, '2.500,50 USD'],
    ['EUR', '100,05', 'valid', '100.05', 10005, '100,05 EUR'],
    ['GBP', '45.000', 'valid', '45000', 4500000, '45.000,00 GBP'],
    ['ADET', '1.250', 'valid', '1250', 1250, '1.250 adet'],
    ['ADET', '1,5', 'invalid', null, null, null],
    ['GRAM', '0,125', 'valid', '0.125', 125, '0,125 gr'],
    ['HAS', '10.500', 'ambiguous', null, null, null],
    ['SILVER', '10.500', 'ambiguous', null, null, null]
  ];
  for (const [unit, rawInput, expectedStatus, expectedCanonical, expectedScaled, expectedFormatted] of cases) {
    const res = codec.parseUserAmount(rawInput, unit, { positive: true });
    assert.equal(res.status, expectedStatus, `${unit} ${rawInput}`);
    if (expectedStatus === 'valid') {
      assert.equal(res.canonical, expectedCanonical);
      assert.equal(res.scaled, expectedScaled);
      assert.equal(res.formatted, expectedFormatted);
      assert.equal(quantity(res.canonical, unit), expectedScaled);
    }
  }

  // Resolution invalidation when user edits input value after disambiguating 10.500
  const dom = new JSDOM('<!doctype html><html><body><label class="field"><input id="w" type="text"></label></body></html>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.Event = dom.window.Event;
  globalThis.HTMLInputElement = dom.window.HTMLInputElement;
  dom.window.eval(readFileSync(new URL('../public/amount-codec.js', import.meta.url), 'utf8'));
  const input = dom.window.document.getElementById('w');
  input.value = '10.500';
  assert.equal(dom.window.DefterAmountCodec.parseInputElement(input, 'HAS', true), null);
  dom.window.document.querySelector('[data-amount-choice="decimal"]').click();
  assert.equal(input.dataset.amountResolution, 'decimal');
  assert.equal(dom.window.DefterAmountCodec.parseInputElement(input, 'HAS', true), 10500);

  // User edits input -> trusted input clears prior resolution so new 10.500 is ambiguous again
  input.value = '10.500';
  delete input.dataset.amountResolution;
  assert.equal(dom.window.DefterAmountCodec.parseInputElement(input, 'HAS', true), null);
  assert.ok(dom.window.document.querySelector('.amount-disambiguation'));

  // Historical v16/v17-style stored events replay identically independent of UI codec
  const repo = new Repository(':memory:', 'legacy-v16-v17');
  try {
    const balances = Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, '0']));
    balances.nakit = '10000';
    balances.bilezik22 = '10.500';
    repo.execute({ id: 'v16-open', revision: 0, command: { type: 'opening', date: '2026-05-01', balances } });
    const backup = repo.backup();
    const restored = new Repository(':memory:', 'legacy-v16-v17');
    try {
      restored.restore({ backup, revision: 0, confirmation: 'GERİ YÜKLE' });
      assert.equal(restored.state().balances.bilezik22, 10500);
      assert.equal(restored.state().balances.nakit, 1000000);
    } finally {
      restored.close();
    }
  } finally {
    repo.close();
  }
});

test('v22 hardening: 100x dot-decimal inflation prevention, dataset.amountUnit reset, 4-decimal kur & Turkish boundaries', () => {
  // K1: Canonical dot-decimal inputs NEVER inflate 100x
  assert.deepEqual(codec.formatLiveMoneyValue('100000.00', 9), { value: '100.000,00', cursor: 10 });
  assert.deepEqual(codec.formatLiveMoneyValue('4500.50', 7), { value: '4.500,50', cursor: 8 });
  assert.deepEqual(codec.formatLiveMoneyValue('0.50', 4), { value: '0,50', cursor: 4 });
  assert.deepEqual(codec.formatLiveMoneyValue('12.50', 5, { treatDotAsDecimal: true }), { value: '12,50', cursor: 5 });
  // Backspace safety preserved: "1.000" -> "1.00" => "100"
  assert.deepEqual(codec.formatLiveMoneyValue('1.00', 4), { value: '100', cursor: 3 });
  assert.deepEqual(codec.formatLiveMoneyValue('10.00', 5), { value: '1.000', cursor: 5 });

  // K2: isMoneyUnit rejects RATE; clearInputState resets dataset.amountUnit; inferInputUnit handles kur, Turkish chars, ISO-3
  assert.equal(codec.isMoneyUnit('RATE'), false);
  assert.equal(codec.isMoneyUnit('SAR'), true);
  assert.equal(codec.isMoneyUnit('AED'), true);

  const dom = new JSDOM(`<!doctype html><html><body>
    <label>Tutar (TL)<input id="m" inputmode="decimal"></label>
    <label>Anlaşılan birim fiyat / kur<input id="bind-calc-rate" inputmode="decimal"></label>
    <label>Döviz kuru<input id="r" inputmode="decimal"></label>
    <label>Saf gümüş miktarı<input id="g" inputmode="decimal"></label>
    <label>Tartı sonucu<input id="t" inputmode="decimal"></label>
    <label>Tutar (SAR)<input id="sar" inputmode="decimal"></label>
  </body></html>`);
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLInputElement = dom.window.HTMLInputElement;
  dom.window.eval(readFileSync(new URL('../public/amount-codec.js', import.meta.url), 'utf8'));
  const domCodec = dom.window.DefterAmountCodec;

  const m = dom.window.document.getElementById('m');
  domCodec.setFormattedInputValue(m, 10000000, 'TL');
  assert.equal(m.value, '100.000,00');
  assert.equal(m.dataset.amountUnit, 'TL');
  domCodec.setFormattedInputValue(m, '12.50', 'TL');
  assert.equal(m.value, '12,50');

  // Switching TL -> clearInputState MUST clear dataset.amountUnit
  domCodec.clearInputState(m);
  assert.equal(m.dataset.amountUnit, undefined);

  // 4-decimal kur is NOT treated as 2-decimal money
  const rateEl = dom.window.document.getElementById('bind-calc-rate');
  const kurEl = dom.window.document.getElementById('r');
  assert.equal(domCodec.inferInputUnit(rateEl), 'RATE');
  assert.equal(domCodec.inferInputUnit(kurEl), 'RATE');
  assert.equal(domCodec.isMoneyUnit(domCodec.inferInputUnit(kurEl)), false);
  kurEl.value = '38,5450';
  assert.equal(domCodec.applyLiveMoneyGrouping(kurEl, domCodec.inferInputUnit(kurEl)), false);
  assert.equal(kurEl.value, '38,5450');

  // Turkish boundaries (gümüş, tartı) -> GRAM, ISO-3 (SAR) -> TL money
  assert.equal(domCodec.inferInputUnit(dom.window.document.getElementById('g')), 'GRAM');
  assert.equal(domCodec.inferInputUnit(dom.window.document.getElementById('t')), 'GRAM');
  assert.equal(domCodec.inferInputUnit(dom.window.document.getElementById('sar')), 'TL');
});
