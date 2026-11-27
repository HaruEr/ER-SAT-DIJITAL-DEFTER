import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS } from '../domain.mjs';
import { supplierDocuments } from '../supplier-ledger.mjs';

const DATE = '2026-11-27';

function createFixture(t) {
  const repo = new Repository(':memory:', 'dukkan');
  t.after(() => repo.close());
  const OWNER_ACTOR = { id: '11111111-1111-4111-8111-111111111111', name: 'Yönetici', role: 'owner' };
  const run = (id, command, actor = OWNER_ACTOR) =>
    repo.execute({ id, revision: repo.state().revision, command: { date: DATE, ...command } }, { actor });

  const balances = Object.fromEntries(
    INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [
      a.id,
      a.id === 'nakit' ? '500000'
        : a.id === 'usd' ? '10000'
        : a.id === 'eur' ? '5000'
        : a.id === 'banka' ? '250000'
        : a.id === 'ceyrek' ? '50'
        : a.id === 'gramToplam' ? '200'
        : '0'
    ])
  );
  run('open-day', {
    type: 'opening',
    balances,
    banks: [{ name: 'Ziraat IBAN TL', unit: 'TL', opening: '300000' }]
  });
  run('cust-1', { type: 'account', name: 'Ahmet Yılmaz', partyType: 'customer', unit: 'TL', opening: '0' });
  run('firm-1', { type: 'supplierFirm', name: 'Anadolu Altın A.Ş.', autoUnits: true });
  run('firm-2', { type: 'supplierFirm', name: 'Kapalıçarşı Rafineri', autoUnits: true });

  const bankId = repo.state().accounts.find(a => a.name === 'Ziraat IBAN TL').id;
  return { repo, run, bankId, customerId: 'cari-cust-1', firmId: 'supplier-firm-1', firm2Id: 'supplier-firm-2' };
}

function assetSnapshot(state) {
  return Object.fromEntries(
    state.accounts.filter(a => a.kind === 'asset').map(a => [a.id, state.balances[a.id] || 0])
  );
}

test('v19 supplierOpening: multi-unit carryover leaves cash/stock untouched, reconciles documents, supports allocation/transfer/reverse and restore', async t => {
  const { repo, run, firmId, firm2Id } = createFixture(t);
  const assetsBefore = assetSnapshot(repo.state());

  // 1. Multi-unit opening carryover (HAS debt + TL credit + USD debt)
  const hasAcc = repo.state().accounts.find(a => a.supplierId === firmId && a.unit === 'HAS');
  const tlAcc = repo.state().accounts.find(a => a.supplierId === firmId && a.unit === 'TL');
  const usdAcc = repo.state().accounts.find(a => a.supplierId === firmId && a.unit === 'USD');

  run('sup-open-1', {
    type: 'supplierOpening',
    supplierId: firmId,
    balances: [
      { accountId: hasAcc.id, direction: 'debt', quantity: '150.250' },
      { accountId: tlAcc.id, direction: 'credit', quantity: '25000.50' },
      { accountId: usdAcc.id, direction: 'debt', quantity: '500.00' }
    ],
    note: 'Sistem öncesi mutabakat devri'
  });

  // Assets must be completely untouched
  assert.deepEqual(assetSnapshot(repo.state()), assetsBefore);
  assert.equal(repo.state().balances[hasAcc.id], -150250);
  assert.equal(repo.state().balances[tlAcc.id], 2500050);
  assert.equal(repo.state().balances[usdAcc.id], -50000);
  assert.equal(repo.events().at(-1).schemaVersion, 19);

  // 2. Multiple supplierOpening entries allowed on same firm (e.g. forgotten EUR credit)
  const eurAcc = repo.state().accounts.find(a => a.supplierId === firmId && a.unit === 'EUR');
  run('sup-open-2', {
    type: 'supplierOpening',
    supplierId: firmId,
    balances: [{ accountId: eurAcc.id, direction: 'credit', quantity: '1200.00' }],
    note: 'Sonradan eklenen EUR devir alacağı'
  });
  assert.equal(repo.state().balances[eurAcc.id], 120000);
  assert.deepEqual(assetSnapshot(repo.state()), assetsBefore);

  // 3. Documentary net === ledger balance invariant
  let docs = supplierDocuments(repo.state(), firmId);
  for (const acc of [hasAcc, tlAcc, usdAcc, eurAcc]) {
    const docNet =
      docs.sources.flatMap(s => s.credits).filter(r => r.accountId === acc.id).reduce((s, r) => s + r.remaining, 0) -
      docs.purchases.flatMap(p => p.charges).filter(r => r.accountId === acc.id).reduce((s, r) => s + r.remaining, 0);
    assert.equal(docNet, repo.state().balances[acc.id], `Documentary net mismatch for ${acc.unit}`);
  }

  // 4. Reverse unused opening (EUR) succeeds
  run('sup-open-2-rev', { type: 'supplierReverse', originalId: 'sup-open-2', note: 'Hatalı EUR devri iptali' });
  assert.equal(repo.state().balances[eurAcc.id], 0);

  // 5. Pay USD debt and allocate against opening debt document
  run('pay-usd', {
    type: 'supplierPayment',
    supplierId: firmId,
    given: [{ accountId: 'usd', quantity: '500.00' }],
    credits: [{ accountId: usdAcc.id, quantity: '500.00' }],
    note: 'Devir USD borcu ödemesi'
  });
  run('alloc-usd', {
    type: 'supplierAllocation',
    supplierId: firmId,
    allocations: [{ sourceId: 'pay-usd', purchaseId: 'sup-open-1', accountId: usdAcc.id, quantity: '500.00' }],
    note: 'Devir USD borcuna tahsis'
  });
  assert.equal(repo.state().balances[usdAcc.id], 0);

  // Reversing an opening that already has an active allocation must fail
  assert.throws(
    () => run('sup-open-1-rev-fail', { type: 'supplierReverse', originalId: 'sup-open-1', note: 'Tahsisli iptal denemesi' }),
    /tahsis|bağlı/i
  );

  // 6. Transfer part of TL opening credit to firm-2
  run('transfer-tl', {
    type: 'supplierTransfer',
    fromSupplierId: firmId,
    toSupplierId: firm2Id,
    unit: 'TL',
    quantity: '10000.00',
    note: 'Devir TL alacağından virman'
  });
  assert.equal(repo.state().balances[tlAcc.id], 1500050);

  // 7. Validation errors: duplicate unit, missing note, invalid direction
  assert.throws(
    () => run('bad-dup', {
      type: 'supplierOpening',
      supplierId: firmId,
      balances: [
        { accountId: tlAcc.id, direction: 'debt', quantity: '10' },
        { accountId: tlAcc.id, direction: 'credit', quantity: '20' }
      ],
      note: 'Çift birim'
    }),
    /en fazla bir kez/
  );
  assert.throws(
    () => run('bad-note', {
      type: 'supplierOpening',
      supplierId: firmId,
      balances: [{ accountId: tlAcc.id, direction: 'debt', quantity: '10' }],
      note: '   '
    }),
    /Devir açıklaması/
  );

  // 8. Backup / restore & archive roundtrip
  const root = resolve(tmpdir());
  const dir = mkdtempSync(join(root, 'v19-sup-open-'));
  const jsonRepo = new Repository(':memory:', 'dukkan');
  const arcRepo = new Repository(':memory:', 'dukkan');
  try {
    jsonRepo.restore({ backup: repo.backup(), revision: 0, confirmation: 'GERİ YÜKLE' });
    const file = join(dir, 'v19.ndjson');
    repo.exportArchive(file);
    await arcRepo.restoreArchive(createReadStream(file), { revision: 0, confirmation: 'GERİ YÜKLE', temporaryDirectory: dir });
    for (const target of [jsonRepo, arcRepo]) {
      assert.deepEqual(target.state().balances, repo.state().balances);
      assert.deepEqual(supplierDocuments(target.state(), firmId), supplierDocuments(repo.state(), firmId));
    }
  } finally {
    jsonRepo.close();
    arcRepo.close();
    assert.equal(dirname(resolve(dir)), root);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v19 order carryover: prior advance & full prepayment settle without touching cash, plus carryoverVoid vs real refund', async t => {
  const { repo, run, customerId } = createFixture(t);
  const assetsBefore = assetSnapshot(repo.state());

  // 1. Fully prepaid historical TL order (40.000 TL) — cash must NOT increase
  run('ord-full', {
    type: 'customerOrder',
    customerId,
    category: 'sarrafiye',
    productAccountId: 'ceyrek',
    orderUnit: 'TL',
    targetQuantity: '40000',
    description: '8 adet Çeyrek (ödemesi önceden alınmış)',
    initialAdvance: {
      carryover: true,
      creditedQuantity: '40000',
      note: '18.11.2026 fiş #101 tam ön ödeme'
    }
  });
  assert.deepEqual(assetSnapshot(repo.state()), assetsBefore);
  assert.equal(repo.events().at(-1).schemaVersion, 19);
  const ordFull = repo.state().customerOrders.find(o => o.id === 'ord-full');
  assert.equal(ordFull.availableTL, 4000000);
  assert.equal(ordFull.advances[0].carryover, true);

  // Reject carryover with accountId
  assert.throws(
    () => run('ord-bad-carry', {
      type: 'customerOrder',
      customerId,
      category: 'gram',
      orderUnit: 'TL',
      description: 'Hatalı devir',
      initialAdvance: { carryover: true, accountId: 'nakit', creditedQuantity: '100', note: 'Hatalı' }
    }),
    /kasa\/stok seçilmez/i
  );

  // Reject employee role for carryover order
  assert.throws(
    () => run('ord-emp', {
      type: 'customerOrder',
      customerId,
      category: 'gram',
      orderUnit: 'TL',
      description: 'Çalışan devir denemesi',
      initialAdvance: { carryover: true, creditedQuantity: '100', note: 'Yetkisiz' }
    }, { id: '22222222-2222-4222-8222-222222222222', name: 'Çalışan', role: 'employee' }),
    /yönetici/i
  );

  // 2. Deliver fully prepaid order: 8 ceyrek stock out, 0 TL new cash in!
  run('deliver-full', {
    type: 'sale',
    counterpartyType: 'customer',
    counterpartyId: customerId,
    items: [{ accountId: 'ceyrek', quantity: '8', value: '40000' }],
    received: [],
    given: [],
    credits: [],
    debts: [],
    orderSettlement: {
      orderId: 'ord-full',
      advances: [{ advanceId: 'ord-full', appliedQuantity: '40000', appliedValueTL: '40000' }]
    },
    note: 'Tamamı önceden ödenmiş sipariş teslimi'
  });
  assert.equal(repo.state().balances.ceyrek, 42); // 50 - 8
  assert.equal(repo.state().balances.nakit, assetsBefore.nakit); // 0 TL cash added
  assert.equal(repo.state().customerOrders.find(o => o.id === 'ord-full').status, 'fulfilled');

  // 3. Partial GRAM carryover order + extra carryover advance + carryoverVoid (wrong entry) + cancel
  run('ord-gram', {
    type: 'customerOrder',
    customerId,
    category: 'gram',
    productAccountId: 'gramToplam',
    orderUnit: 'GRAM',
    targetQuantity: '20.000',
    description: '20 gr Gram Altın siparişi',
    initialAdvance: { carryover: true, creditedQuantity: '10.000', note: 'Önceki defter 10 gr devir' }
  });
  run('ord-gram-add', {
    type: 'orderAdvance',
    orderId: 'ord-gram',
    carryover: true,
    creditedQuantity: '5.000',
    note: 'Ek 5 gr devir'
  });
  assert.equal(repo.state().balances.gramToplam, assetsBefore.gramToplam);
  assert.equal(repo.state().customerOrders.find(o => o.id === 'ord-gram').availableQuantity, 15000);

  // Void wrong carryover (5 gr) without touching cash/stock
  run('ord-gram-void-1', {
    type: 'orderRefund',
    orderId: 'ord-gram',
    advanceId: 'ord-gram-add',
    carryoverVoid: true,
    note: '5 gr mükerrer girildi, kasa etkisiz iptal'
  });
  assert.equal(repo.state().balances.gramToplam, assetsBefore.gramToplam);
  assert.equal(repo.state().customerOrders.find(o => o.id === 'ord-gram').availableQuantity, 10000);

  // Real cash refund of remaining carryover (customer cancelled and received cash back)
  run('ord-gram-real-refund', {
    type: 'orderRefund',
    orderId: 'ord-gram',
    advanceId: 'ord-gram',
    accountId: 'nakit',
    refundedQuantity: '30000',
    creditedQuantity: '10.000',
    note: 'Müşteri vazgeçti, nakit iade edildi'
  });
  assert.equal(repo.state().balances.nakit, assetsBefore.nakit - 3000000);
  assert.equal(repo.state().customerOrders.find(o => o.id === 'ord-gram').availableQuantity, 0);

  // Normal (non-carryover) advance must reject carryoverVoid
  run('ord-normal', {
    type: 'customerOrder',
    customerId,
    category: 'urun',
    orderUnit: 'TL',
    description: 'Bugünkü normal sipariş',
    initialAdvance: { accountId: 'nakit', receivedQuantity: '1000' }
  });
  assert.throws(
    () => run('bad-void-normal', {
      type: 'orderRefund',
      orderId: 'ord-normal',
      advanceId: 'ord-normal',
      carryoverVoid: true,
      note: 'Normal kaporada yasak'
    }),
    /devir kaporası/i
  );

  // Backup / restore roundtrip
  const copy = new Repository(':memory:', 'dukkan');
  t.after(() => copy.close());
  copy.restore({ backup: repo.backup(), revision: 0, confirmation: 'GERİ YÜKLE' });
  assert.deepEqual(copy.state().balances, repo.state().balances);
  assert.deepEqual(copy.state().customerOrders, repo.state().customerOrders);
});

test('v19 currencyExchange: USD->TL, mixed Cash+IBAN payout, USD->EUR cross, guards, reverse and restore', async t => {
  const { repo, run, bankId } = createFixture(t);
  const before = assetSnapshot(repo.state());

  // 1. Mixed payout: 1000 USD in -> 20.000 TL cash + 14.500 TL IBAN out
  run('fx-1', {
    type: 'currencyExchange',
    received: [{ accountId: 'usd', quantity: '1000.00' }],
    given: [
      { accountId: 'nakit', quantity: '20000.00' },
      { accountId: bankId, quantity: '14500.00' }
    ],
    note: '1000 USD bozdurma (nakit + IBAN)'
  });
  assert.equal(repo.events().at(-1).schemaVersion, 19);
  assert.equal(repo.state().balances.usd, before.usd + 100000);
  assert.equal(repo.state().balances.nakit, before.nakit - 2000000);
  assert.equal(repo.state().balances[bankId], before[bankId] - 1450000);
  assert.equal(repo.state().journal.at(-1).meta.revenue || 0, 0);

  // 2. Cross currency: 500 USD in -> 460 EUR out
  run('fx-2', {
    type: 'currencyExchange',
    received: [{ accountId: 'usd', quantity: '500.00' }],
    given: [{ accountId: 'eur', quantity: '460.00' }]
  });
  assert.equal(repo.state().balances.usd, before.usd + 150000);
  assert.equal(repo.state().balances.eur, before.eur - 46000);

  // 3. Guards: same currency rejected, POS rejected, employee rejected, insufficient balance rejected
  assert.throws(
    () => run('fx-same', {
      type: 'currencyExchange',
      received: [{ accountId: 'nakit', quantity: '100' }],
      given: [{ accountId: bankId, quantity: '100' }]
    }),
    /farklı para birimleri/i
  );
  assert.throws(
    () => run('fx-pos', {
      type: 'currencyExchange',
      received: [{ accountId: 'usd', quantity: '10' }],
      given: [{ accountId: 'pos', quantity: '340' }]
    }),
    /POS|para birimi/i
  );
  assert.throws(
    () => run('fx-emp', {
      type: 'currencyExchange',
      received: [{ accountId: 'usd', quantity: '10' }],
      given: [{ accountId: 'nakit', quantity: '340' }]
    }, { id: '22222222-2222-4222-8222-222222222222', name: 'Çalışan', role: 'employee' }),
    /yönetici/i
  );
  assert.throws(
    () => run('fx-overdraft', {
      type: 'currencyExchange',
      received: [{ accountId: 'usd', quantity: '10' }],
      given: [{ accountId: 'eur', quantity: '999999' }]
    }),
    /yetersiz/i
  );

  // 4. Reverse restores exact balances
  run('fx-2-rev', { type: 'reverse', originalId: 'fx-2', note: 'Yanlış çapraz kur' });
  assert.equal(repo.state().balances.usd, before.usd + 100000);
  assert.equal(repo.state().balances.eur, before.eur);

  // 5. Restore roundtrip
  const copy = new Repository(':memory:', 'dukkan');
  t.after(() => copy.close());
  copy.restore({ backup: repo.backup(), revision: 0, confirmation: 'GERİ YÜKLE' });
  assert.deepEqual(copy.state().balances, repo.state().balances);
});

test('v19 movement Tamir / Hizmet Geliri: supports Cash/IBAN/POS/FX, adds TL to revenue, reverses and amends cleanly', async t => {
  const { repo, run, bankId } = createFixture(t);
  const before = assetSnapshot(repo.state());

  // 1. Cash TL repair income -> adds to cash and revenue
  run('rep-cash', {
    type: 'movement',
    category: 'Tamir / Hizmet Geliri',
    direction: 'in',
    accountId: 'nakit',
    quantity: '750.00',
    note: 'Yüzük kaynak ve parlatma'
  });
  assert.equal(repo.events().at(-1).schemaVersion, 19);
  assert.equal(repo.state().balances.nakit, before.nakit + 75000);
  assert.equal(repo.state().journal.at(-1).meta.revenue, 75000);
  assert.equal(repo.state().journal.at(-1).meta.expense, 0);

  // 2. POS card repair income -> allowed on POS and adds to revenue
  run('rep-pos', {
    type: 'movement',
    category: 'Tamir / Hizmet Geliri',
    direction: 'in',
    accountId: 'pos',
    quantity: '1250.00',
    note: 'Saat kordonu ve pil değişimi (kart)'
  });
  assert.equal(repo.state().balances.pos, before.pos + 125000);
  assert.equal(repo.state().journal.at(-1).meta.revenue, 125000);

  // 3. Bank/IBAN TL & FX USD repair income (FX does not pollute TL revenue)
  run('rep-bank', {
    type: 'movement',
    category: 'Tamir / Hizmet Geliri',
    direction: 'in',
    accountId: bankId,
    quantity: '500.00',
    note: 'IBAN tamir ücreti'
  });
  run('rep-usd', {
    type: 'movement',
    category: 'Tamir / Hizmet Geliri',
    direction: 'in',
    accountId: 'usd',
    quantity: '25.00',
    note: 'Turist tamir ücreti (USD)'
  });
  assert.equal(repo.state().balances[bankId], before[bankId] + 50000);
  assert.equal(repo.state().balances.usd, before.usd + 2500);
  assert.equal(repo.state().journal.at(-1).meta.revenue || 0, 0);

  // 4. Guards: direction 'out' rejected, employee rejected
  assert.throws(
    () => run('rep-out', {
      type: 'movement',
      category: 'Tamir / Hizmet Geliri',
      direction: 'out',
      accountId: 'nakit',
      quantity: '100',
      note: 'Hatalı çıkış'
    }),
    /girişi olmalı/i
  );
  assert.throws(
    () => run('rep-emp', {
      type: 'movement',
      category: 'Tamir / Hizmet Geliri',
      direction: 'in',
      accountId: 'nakit',
      quantity: '100',
      note: 'Yetkisiz'
    }, { id: '22222222-2222-4222-8222-222222222222', name: 'Çalışan', role: 'employee' }),
    /yönetici/i
  );

  // 5. Amend and Reverse both work and keep revenue/balances exact
  run('rep-amend', {
    type: 'amend',
    originalId: 'rep-cash',
    note: 'Tutar düzeltmesi',
    replacement: {
      type: 'movement',
      category: 'Tamir / Hizmet Geliri',
      direction: 'in',
      accountId: 'nakit',
      quantity: '900.00',
      note: 'Yüzük kaynak + taş takma'
    }
  });
  assert.equal(repo.state().balances.nakit, before.nakit + 90000);

  run('rep-pos-rev', { type: 'reverse', originalId: 'rep-pos', note: 'Kart iptali' });
  assert.equal(repo.state().balances.pos, before.pos);
  assert.equal(repo.state().journal.at(-1).meta.revenue, -125000);

  // 6. Backup / restore roundtrip
  const copy = new Repository(':memory:', 'dukkan');
  t.after(() => copy.close());
  copy.restore({ backup: repo.backup(), revision: 0, confirmation: 'GERİ YÜKLE' });
  assert.deepEqual(copy.state().balances, repo.state().balances);
});
