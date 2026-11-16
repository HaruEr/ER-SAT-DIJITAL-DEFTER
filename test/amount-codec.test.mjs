import test from 'node:test';
import assert from 'node:assert/strict';
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
