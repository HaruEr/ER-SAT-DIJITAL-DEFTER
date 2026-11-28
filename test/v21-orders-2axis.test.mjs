import test from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_ACCOUNTS, applyEvent, eventVersion, replay } from '../domain.mjs';
import { hydrateLedger, normalizeJournalOptions, projectJournal, projectLedger } from '../ledger-view.mjs';

function openLedger() {
  const balances = Object.fromEntries(
    INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [
      a.id,
      a.id === 'nakit' ? '500000'
        : a.id === 'usd' ? '10000'
        : a.id === 'bilezikAdet' ? '50'
        : a.id === 'bilezik22' ? '500'
        : a.id === 'ceyrek' ? '30'
        : a.unit === 'ADET' ? '20'
        : a.unit === 'GRAM' ? '200'
        : '0'
    ])
  );
  const events = [
    { id: 'op-1', schemaVersion: 3, timestamp: '2026-11-28T00:00:00Z', command: { type: 'opening', date: '2026-11-28', balances } },
    { id: 'cust-1', schemaVersion: 5, timestamp: '2026-11-28T00:01:00Z', command: { type: 'account', date: '2026-11-28', name: 'Ayşe Yılmaz', partyType: 'customer', unit: 'TL', opening: '0' } },
    { id: 'cust-2', schemaVersion: 5, timestamp: '2026-11-28T00:01:30Z', command: { type: 'account', date: '2026-11-28', name: 'Mehmet Demir', partyType: 'customer', unit: 'TL', opening: '0' } }
  ];
  return { state: replay(events), events };
}

function run(ctx, id, command, explicitVersion) {
  const fullCmd = { date: '2026-11-28', ...command };
  const sv = explicitVersion ?? eventVersion(fullCmd, ctx.state);
  const ev = { id, schemaVersion: sv, timestamp: '2026-11-28T01:00:00Z', command: fullCmd };
  ctx.state = applyEvent(ctx.state, ev);
  ctx.events.push(ev);
  return ev;
}

test('v21 screenshot bug: 50g target / 49.120g kapora / 50g deliver blocks unsettled 0.880g and succeeds when settled', () => {
  const ctx = openLedger();
  run(ctx, 'ord-50', {
    type: 'customerOrder',
    customerId: 'cari-cust-1',
    description: '50 gr 22 ayar bilezik',
    category: 'bilezik',
    productAccountId: 'bilezikAdet',
    weightAccountId: 'bilezik22',
    orderUnit: 'GRAM',
    targetQuantity: '50',
    initialAdvance: { accountId: 'nakit', receivedQuantity: '196480', creditedQuantity: '49.120' }
  });

  // Unsettled 50g delivery MUST fail (0.880g unpaid!)
  assert.throws(() => run(ctx, 'del-fail-1', {
    type: 'orderDeliver',
    orderId: 'ord-50',
    items: [{ accountId: 'bilezikAdet', quantity: '5', weightAccount: 'bilezik22', weight: '50.000' }],
    closeOrder: true
  }), /0\.880 GRAM/);

  // Cross-unit received without settledQuantity MUST fail
  assert.throws(() => run(ctx, 'del-fail-2', {
    type: 'orderDeliver',
    orderId: 'ord-50',
    items: [{ accountId: 'bilezikAdet', quantity: '5', weightAccount: 'bilezik22', weight: '50.000' }],
    closeOrder: true,
    settlement: { received: [{ accountId: 'nakit', quantity: '3520' }] }
  }), /siparişe sayılan miktar/i);

  // Under-settled (0.500g instead of 0.880g) MUST fail
  assert.throws(() => run(ctx, 'del-fail-3', {
    type: 'orderDeliver',
    orderId: 'ord-50',
    items: [{ accountId: 'bilezikAdet', quantity: '5', weightAccount: 'bilezik22', weight: '50.000' }],
    closeOrder: true,
    settlement: { received: [{ accountId: 'nakit', quantity: '2000', settledQuantity: '0.500' }] }
  }), /tam kapatılmalı/i);

  // Exact settlement of 0.880g in cash succeeds and auto-closes
  const ev = run(ctx, 'del-ok', {
    type: 'orderDeliver',
    orderId: 'ord-50',
    items: [{ accountId: 'bilezikAdet', quantity: '5', weightAccount: 'bilezik22', weight: '50.000' }],
    closeOrder: false, // auto-closes because nextDelivered (50) >= target (50)
    settlement: { received: [{ accountId: 'nakit', quantity: '3520', settledQuantity: '0.880' }] },
    note: 'Kalan 0.880 gr nakit tahsil edildi'
  }, 21);
  assert.equal(ev.schemaVersion, 21);

  const ord = ctx.state.customerOrders.find(o => o.id === 'ord-50');
  assert.equal(ord.status, 'fulfilled');
  assert.equal(ord.deliveredQuantity, 50000);
  assert.equal(ord.availableQuantity, 0);
  assert.equal(ord.deliverySettledQuantity, 880);
  assert.equal(ctx.state.balances.nakit, 50000000 + 19648000 + 352000);
  assert.equal(ctx.state.journal.at(-1).meta.revenue, 352000);

  const replayed = replay(ctx.events);
  assert.deepEqual(replayed.customerOrders, ctx.state.customerOrders);
  assert.deepEqual(replayed.balances, ctx.state.balances);
});

test('v21 zero-kapora delivery and partial delivery exceeding kapora', () => {
  const ctx = openLedger();
  // Zero-kapora order
  run(ctx, 'ord-zero', {
    type: 'customerOrder',
    customerId: 'cari-cust-1',
    description: 'Kaporasız 20 gr sipariş',
    category: 'bilezik',
    productAccountId: 'bilezikAdet',
    weightAccountId: 'bilezik22',
    orderUnit: 'GRAM',
    targetQuantity: '20'
  });

  assert.throws(() => run(ctx, 'del-z-fail', {
    type: 'orderDeliver',
    orderId: 'ord-zero',
    items: [{ accountId: 'bilezikAdet', quantity: '2', weightAccount: 'bilezik22', weight: '20.000' }]
  }), /20\.000 GRAM/);

  // Settle zero-kapora order via customer debt
  run(ctx, 'del-z-ok', {
    type: 'orderDeliver',
    orderId: 'ord-zero',
    items: [{ accountId: 'bilezikAdet', quantity: '2', weightAccount: 'bilezik22', weight: '20.000' }],
    settlement: { customerDelta: { accountId: 'cari-cust-1', direction: 'debt', quantity: '80000', settledQuantity: '20.000' } },
    note: 'Tamamı cari borç yazıldı'
  });
  assert.equal(ctx.state.customerOrders.find(o => o.id === 'ord-zero').status, 'fulfilled');
  assert.equal(ctx.state.balances['cari-cust-1'], 8000000);

  // Partial delivery exceeding kapora (100g target, 30g kapora, deliver 50g -> 20g unpaid)
  run(ctx, 'ord-part', {
    type: 'customerOrder',
    customerId: 'cari-cust-1',
    description: '100 gr sipariş',
    category: 'bilezik',
    productAccountId: 'bilezikAdet',
    weightAccountId: 'bilezik22',
    orderUnit: 'GRAM',
    targetQuantity: '100',
    initialAdvance: { accountId: 'nakit', receivedQuantity: '120000', creditedQuantity: '30' }
  });

  assert.throws(() => run(ctx, 'del-p-fail', {
    type: 'orderDeliver',
    orderId: 'ord-part',
    items: [{ accountId: 'bilezikAdet', quantity: '5', weightAccount: 'bilezik22', weight: '50.000' }],
    closeOrder: false
  }), /20\.000 GRAM/);

  run(ctx, 'del-p-ok', {
    type: 'orderDeliver',
    orderId: 'ord-part',
    items: [{ accountId: 'bilezikAdet', quantity: '5', weightAccount: 'bilezik22', weight: '50.000' }],
    closeOrder: false,
    settlement: { received: [{ accountId: 'nakit', quantity: '80000', settledQuantity: '20.000' }] },
    note: 'Kısmi teslim 20 gr fark tahsil edildi'
  });

  const ordP = ctx.state.customerOrders.find(o => o.id === 'ord-part');
  assert.equal(ordP.status, 'open');
  assert.equal(ordP.deliveredQuantity, 50000);
  assert.equal(ordP.availableQuantity, 0);
  assert.equal(ordP.deliverySettledQuantity, 20000);
});

test('v21 early close leftover kapora: 100g paid / 98.780g delivered (refund, credit, forfeit, leaveUnusedKapora)', () => {
  // Case A: cash refund of leftover 1.220g
  {
    const ctx = openLedger();
    run(ctx, 'ord-a', {
      type: 'customerOrder',
      customerId: 'cari-cust-1',
      description: '100 gr bilezik',
      category: 'bilezik',
      productAccountId: 'bilezikAdet',
      weightAccountId: 'bilezik22',
      orderUnit: 'GRAM',
      targetQuantity: '100',
      initialAdvance: { accountId: 'nakit', receivedQuantity: '400000', creditedQuantity: '100' }
    });

    // Closing without handling 1.220g leftover kapora MUST fail!
    assert.throws(() => run(ctx, 'del-a-fail', {
      type: 'orderDeliver',
      orderId: 'ord-a',
      items: [{ accountId: 'bilezikAdet', quantity: '10', weightAccount: 'bilezik22', weight: '98.780' }],
      closeOrder: true
    }), /1\.220 GRAM/);

    // Refund 1.220g in cash
    run(ctx, 'del-a-ok', {
      type: 'orderDeliver',
      orderId: 'ord-a',
      items: [{ accountId: 'bilezikAdet', quantity: '10', weightAccount: 'bilezik22', weight: '98.780' }],
      closeOrder: true,
      settlement: { given: [{ accountId: 'nakit', quantity: '4880', settledQuantity: '1.220' }] },
      note: '1.220 gr eksik kapora iade edildi'
    });
    const ord = ctx.state.customerOrders.find(o => o.id === 'ord-a');
    assert.equal(ord.status, 'fulfilled');
    assert.equal(ord.availableQuantity, 0);
    assert.equal(ord.advances[0].appliedQuantity, 98780);
    assert.equal(ord.advances[0].refundedQuantity, 1220);
    assert.equal(ctx.state.balances.nakit, 50000000 + 40000000 - 488000);
  }

  // Case B: customer credit + forfeit + reversal
  {
    const ctx = openLedger();
    run(ctx, 'ord-b', {
      type: 'customerOrder',
      customerId: 'cari-cust-1',
      description: '100 gr bilezik',
      category: 'bilezik',
      productAccountId: 'bilezikAdet',
      weightAccountId: 'bilezik22',
      orderUnit: 'GRAM',
      targetQuantity: '100',
      initialAdvance: { accountId: 'nakit', receivedQuantity: '400000', creditedQuantity: '100' }
    });

    // forfeitQuantity without note fails
    assert.throws(() => run(ctx, 'del-b-nonote', {
      type: 'orderDeliver',
      orderId: 'ord-b',
      items: [{ accountId: 'bilezikAdet', quantity: '10', weightAccount: 'bilezik22', weight: '98.780' }],
      closeOrder: true,
      settlement: { forfeitQuantity: '1.220' }
    }), /açıklaması girin/i);

    // Split: 1.000g to customer credit, 0.220g forfeited with note
    run(ctx, 'del-b-ok', {
      type: 'orderDeliver',
      orderId: 'ord-b',
      items: [{ accountId: 'bilezikAdet', quantity: '10', weightAccount: 'bilezik22', weight: '98.780' }],
      closeOrder: true,
      settlement: {
        customerDelta: { accountId: 'cari-cust-1', direction: 'credit', quantity: '4000', settledQuantity: '1.000' },
        forfeitQuantity: '0.220'
      },
      note: '1 gr cari alacak, 0.220 gr işçilik mahsup'
    });
    let ord = ctx.state.customerOrders.find(o => o.id === 'ord-b');
    assert.equal(ord.availableQuantity, 0);
    assert.equal(ord.advances[0].appliedQuantity, 98780 + 220);
    assert.equal(ord.advances[0].refundedQuantity, 1000);
    assert.equal(ctx.state.balances['cari-cust-1'], -400000);

    // Reverse restores everything losslessly
    run(ctx, 'rev-b', { type: 'reverse', originalId: 'del-b-ok', note: 'Düzeltme' });
    ord = ctx.state.customerOrders.find(o => o.id === 'ord-b');
    assert.equal(ord.status, 'open');
    assert.equal(ord.deliveredQuantity, 0);
    assert.equal(ord.availableQuantity, 100000);
    assert.equal(ord.advances[0].appliedQuantity, 0);
    assert.equal(ord.advances[0].refundedQuantity, 0);
    assert.equal(ctx.state.balances['cari-cust-1'], 0);
    assert.equal(ctx.state.journal.at(-1).meta.orderId, 'ord-b');

    const replayed = replay(ctx.events);
    assert.deepEqual(replayed.customerOrders, ctx.state.customerOrders);
    assert.deepEqual(replayed.balances, ctx.state.balances);
  }

  // Case C: leaveUnusedKapora: true leaves 1.220g available for later orderRefund
  {
    const ctx = openLedger();
    run(ctx, 'ord-c', {
      type: 'customerOrder',
      customerId: 'cari-cust-1',
      description: '100 gr bilezik',
      category: 'bilezik',
      productAccountId: 'bilezikAdet',
      weightAccountId: 'bilezik22',
      orderUnit: 'GRAM',
      targetQuantity: '100',
      initialAdvance: { accountId: 'nakit', receivedQuantity: '400000', creditedQuantity: '100' }
    });
    run(ctx, 'del-c-ok', {
      type: 'orderDeliver',
      orderId: 'ord-c',
      items: [{ accountId: 'bilezikAdet', quantity: '10', weightAccount: 'bilezik22', weight: '98.780' }],
      closeOrder: true,
      leaveUnusedKapora: true,
      note: 'Kalan 1.220 gr daha sonra iade edilecek'
    });
    let ord = ctx.state.customerOrders.find(o => o.id === 'ord-c');
    assert.equal(ord.status, 'fulfilled');
    assert.equal(ord.availableQuantity, 1220);

    // Later orderRefund works on fulfilled order with remaining availableQuantity
    run(ctx, 'ref-c', {
      type: 'orderRefund',
      orderId: 'ord-c',
      advanceId: 'ord-c',
      accountId: 'nakit',
      refundedQuantity: '4880',
      creditedQuantity: '1.220',
      note: 'Kalan kapora iadesi'
    });
    ord = ctx.state.customerOrders.find(o => o.id === 'ord-c');
    assert.equal(ord.availableQuantity, 0);
    assert.equal(ctx.state.balances.nakit, 50000000 + 40000000 - 488000);
  }
});

test('v21 unit rules: TL, USD, HAS, ADET deliveries & revenue calculation', () => {
  const ctx = openLedger();

  // TL order: requires explicit deliveredQuantity, revenue = deliveredQty - waiveQty
  run(ctx, 'ord-tl', {
    type: 'customerOrder',
    customerId: 'cari-cust-1',
    description: 'TL sipariş',
    category: 'urun',
    orderUnit: 'TL',
    targetQuantity: '10000',
    initialAdvance: { accountId: 'nakit', receivedQuantity: '4000' }
  });
  assert.throws(() => run(ctx, 'del-tl-fail', {
    type: 'orderDeliver',
    orderId: 'ord-tl',
    items: [{ accountId: 'ceyrek', quantity: '1' }],
    closeOrder: true
  }), /TL takipli siparişte/);

  run(ctx, 'del-tl-ok', {
    type: 'orderDeliver',
    orderId: 'ord-tl',
    items: [{ accountId: 'ceyrek', quantity: '1' }],
    deliveredQuantity: '10000',
    closeOrder: true,
    settlement: {
      received: [{ accountId: 'nakit', quantity: '5500' }], // same-unit defaults settledQuantity to 5500
      waiveQuantity: '500'
    },
    note: '500 TL indirim'
  }, 21);
  assert.equal(ctx.state.journal.at(-1).meta.revenue, 950000); // 10000 - 500 = 9500 TL

  // USD order: requires explicit deliveredQuantity, non-TL revenue = sum(received TL)
  run(ctx, 'ord-usd', {
    type: 'customerOrder',
    customerId: 'cari-cust-1',
    description: 'USD sipariş',
    category: 'urun',
    orderUnit: 'USD',
    targetQuantity: '1000',
    initialAdvance: { accountId: 'usd', receivedQuantity: '600' }
  });
  assert.throws(() => run(ctx, 'del-usd-fail', {
    type: 'orderDeliver',
    orderId: 'ord-usd',
    items: [{ accountId: 'ceyrek', quantity: '1' }],
    closeOrder: true
  }), /USD takipli siparişte/);

  run(ctx, 'del-usd-ok', {
    type: 'orderDeliver',
    orderId: 'ord-usd',
    items: [{ accountId: 'ceyrek', quantity: '1' }],
    deliveredQuantity: '1000',
    closeOrder: true,
    settlement: {
      received: [
        { accountId: 'usd', quantity: '200' }, // same-unit -> 200 USD
        { accountId: 'nakit', quantity: '7000', settledQuantity: '200' } // cross-unit -> 200 USD
      ]
    },
    note: 'Kalan 400 USD yarısı döviz yarısı TL'
  });
  assert.equal(ctx.state.journal.at(-1).meta.revenue, 700000);

  // HAS order: MUST NOT auto-sum GRAM weight (unit isolation!), requires explicit deliveredQuantity
  run(ctx, 'ord-has', {
    type: 'customerOrder',
    customerId: 'cari-cust-1',
    description: 'HAS sipariş',
    category: 'bilezik',
    orderUnit: 'HAS',
    targetQuantity: '10',
    initialAdvance: { carryover: true, creditedQuantity: '10', note: 'Devir 10 HAS' }
  });
  assert.throws(() => run(ctx, 'del-has-fail', {
    type: 'orderDeliver',
    orderId: 'ord-has',
    items: [{ accountId: 'bilezikAdet', quantity: '1', weightAccount: 'bilezik22', weight: '10.910' }],
    closeOrder: true
  }), /HAS dışı ürün/);

  run(ctx, 'del-has-ok', {
    type: 'orderDeliver',
    orderId: 'ord-has',
    items: [{ accountId: 'bilezikAdet', quantity: '1', weightAccount: 'bilezik22', weight: '10.910' }],
    deliveredQuantity: '10',
    closeOrder: true
  });
  assert.equal(ctx.state.customerOrders.find(o => o.id === 'ord-has').status, 'fulfilled');

  // ADET order: auto-sums pieces
  run(ctx, 'ord-adet', {
    type: 'customerOrder',
    customerId: 'cari-cust-1',
    description: '3 Çeyrek sipariş',
    category: 'sarrafiye',
    orderUnit: 'ADET',
    targetQuantity: '3',
    initialAdvance: { accountId: 'nakit', receivedQuantity: '15000', creditedQuantity: '3' }
  });
  run(ctx, 'del-adet-ok', {
    type: 'orderDeliver',
    orderId: 'ord-adet',
    items: [{ accountId: 'ceyrek', quantity: '3' }],
    closeOrder: true
  });
  assert.equal(ctx.state.customerOrders.find(o => o.id === 'ord-adet').deliveredQuantity, 3);
  assert.equal(ctx.state.customerOrders.find(o => o.id === 'ord-adet').status, 'fulfilled');
});

test('v21 split settlement, strict validation, cancel/update guards, and customerOrder/orderAdvance guards', () => {
  const ctx = openLedger();

  // Simultaneous initialAdvance + initialAdvances rejected
  assert.throws(() => run(ctx, 'ord-bad-1', {
    type: 'customerOrder',
    customerId: 'cari-cust-1',
    description: 'Bad',
    orderUnit: 'TL',
    initialAdvance: { accountId: 'nakit', receivedQuantity: '100' },
    initialAdvances: [{ accountId: 'nakit', receivedQuantity: '100' }]
  }), /aynı anda gönderilemez/i);

  // Stray keys in initialAdvances row rejected
  assert.throws(() => run(ctx, 'ord-bad-2', {
    type: 'customerOrder',
    customerId: 'cari-cust-1',
    description: 'Bad',
    orderUnit: 'TL',
    initialAdvances: [{ accountId: 'nakit', receivedQuantity: '100', bogus: 1 }]
  }), /desteklenmeyen alan/i);

  run(ctx, 'ord-g', {
    type: 'customerOrder',
    customerId: 'cari-cust-1',
    description: 'Guard testi',
    category: 'bilezik',
    orderUnit: 'GRAM',
    targetQuantity: '50'
  });

  // Simultaneous advances + single field in orderAdvance rejected
  assert.throws(() => run(ctx, 'adv-bad-1', {
    type: 'orderAdvance',
    orderId: 'ord-g',
    accountId: 'nakit',
    advances: [{ accountId: 'nakit', receivedQuantity: '1000', creditedQuantity: '1' }]
  }), /aynı anda gönderilemez/i);

  // Stray key in orderAdvance.advances row rejected
  assert.throws(() => run(ctx, 'adv-bad-2', {
    type: 'orderAdvance',
    orderId: 'ord-g',
    advances: [{ accountId: 'nakit', receivedQuantity: '1000', creditedQuantity: '1', extra: true }]
  }), /desteklenmeyen alan/i);

  // Wrong customerDelta.accountId rejected
  assert.throws(() => run(ctx, 'del-wrong-cust', {
    type: 'orderDeliver',
    orderId: 'ord-g',
    items: [{ accountId: 'bilezikAdet', quantity: '1', weightAccount: 'bilezik22', weight: '10.000' }],
    settlement: { customerDelta: { accountId: 'cari-cust-2', direction: 'debt', quantity: '40000', settledQuantity: '10.000' } }
  }), /kendi müşteri carisine/i);

  // Split settlement: cash + USD + customer debt + reasoned waiveQuantity = 10.000g
  run(ctx, 'del-split', {
    type: 'orderDeliver',
    orderId: 'ord-g',
    items: [{ accountId: 'bilezikAdet', quantity: '1', weightAccount: 'bilezik22', weight: '10.000' }],
    closeOrder: false,
    settlement: {
      received: [
        { accountId: 'nakit', quantity: '16000', settledQuantity: '4.000' },
        { accountId: 'usd', quantity: '300', settledQuantity: '3.000' }
      ],
      customerDelta: { accountId: 'cari-cust-1', direction: 'debt', quantity: '10000', settledQuantity: '2.500' },
      waiveQuantity: '0.500'
    },
    note: 'Karma mahsup + 0.500 gr iskonto'
  });

  // orderCancel rejected when deliveredQuantity > 0
  assert.throws(() => run(ctx, 'cancel-fail', {
    type: 'orderCancel',
    orderId: 'ord-g',
    note: 'İptal denemesi'
  }), /teslimatı yapılmış sipariş iptal edilemez/i);

  // orderUpdate rejects unit change when deliveries.length > 0
  assert.throws(() => run(ctx, 'upd-unit-fail', {
    type: 'orderUpdate',
    orderId: 'ord-g',
    orderUnit: 'TL'
  }), /takip birimi değiştirilemez/i);

  // orderUpdate rejects targetQuantity < deliveredQuantity (10g)
  assert.throws(() => run(ctx, 'upd-target-fail', {
    type: 'orderUpdate',
    orderId: 'ord-g',
    targetQuantity: '9.000'
  }), /teslim edilen miktardan küçük olamaz/i);

  // orderUpdate raising targetQuantity succeeds
  run(ctx, 'upd-ok', {
    type: 'orderUpdate',
    orderId: 'ord-g',
    targetQuantity: '60.000'
  });
  assert.equal(ctx.state.customerOrders.find(o => o.id === 'ord-g').targetQuantity, 60000);
});

test('v21 reverse immutability, non-closing reversal guard, serialized inventory, and ledger-view integration', () => {
  const ctx = openLedger();

  // Register a serialized bracelet item
  run(ctx, 'reg-1', {
    type: 'registerItem',
    code: 'BLZ-001',
    accountId: 'bilezikAdet',
    weightAccount: 'bilezik22',
    actualWeight: '10.000',
    description: '22 ayar ajda 10 gr'
  });

  run(ctx, 'ord-inv', {
    type: 'customerOrder',
    customerId: 'cari-cust-1',
    description: '20 gr seri no testi',
    category: 'bilezik',
    orderUnit: 'GRAM',
    targetQuantity: '20',
    initialAdvance: { accountId: 'nakit', receivedQuantity: '80000', creditedQuantity: '20' }
  });

  // Partial delivery 1 with inventoryCode
  run(ctx, 'del-inv-1', {
    type: 'orderDeliver',
    orderId: 'ord-inv',
    items: [{ accountId: 'bilezikAdet', quantity: '1', weightAccount: 'bilezik22', weight: '10.000', inventoryCode: 'BLZ-001' }],
    closeOrder: false
  });
  assert.equal(ctx.state.inventoryItems.find(i => i.code === 'BLZ-001').status, 'sold');
  assert.equal(ctx.state.inventoryReserved.bilezikAdet, 0);

  // Final delivery 2 (closes order)
  run(ctx, 'del-inv-2', {
    type: 'orderDeliver',
    orderId: 'ord-inv',
    items: [{ accountId: 'bilezikAdet', quantity: '1', weightAccount: 'bilezik22', weight: '10.000' }],
    closeOrder: true
  });
  assert.equal(ctx.state.customerOrders.find(o => o.id === 'ord-inv').status, 'fulfilled');

  // Reversing non-closing del-inv-1 while order is fulfilled MUST fail
  assert.throws(() => run(ctx, 'rev-nonclose-fail', {
    type: 'reverse',
    originalId: 'del-inv-1',
    note: 'Ara teslimat iptal denemesi'
  }), /ara teslimatı doğrudan ters çevrilemez/i);

  // Reverse closing del-inv-2 first -> reopens order
  run(ctx, 'rev-close', { type: 'reverse', originalId: 'del-inv-2', note: 'Kapanış iptal' });
  assert.equal(ctx.state.customerOrders.find(o => o.id === 'ord-inv').status, 'open');

  // Now reversing del-inv-1 succeeds and restores BLZ-001 to available!
  run(ctx, 'rev-inv-1', { type: 'reverse', originalId: 'del-inv-1', note: 'İlk teslimat iptal' });
  assert.equal(ctx.state.inventoryItems.find(i => i.code === 'BLZ-001').status, 'available');
  assert.equal(ctx.state.inventoryReserved.bilezikAdet, 1);

  // Immutability check: failed reverse (insufficient cash) must NOT mutate previous.customerOrders
  run(ctx, 'ord-imm', {
    type: 'customerOrder',
    customerId: 'cari-cust-1',
    description: 'İmmutability testi',
    orderUnit: 'GRAM',
    targetQuantity: '10'
  });
  run(ctx, 'del-imm', {
    type: 'orderDeliver',
    orderId: 'ord-imm',
    items: [{ accountId: 'bilezikAdet', quantity: '1', weightAccount: 'bilezik22', weight: '10.000' }],
    settlement: { received: [{ accountId: 'nakit', quantity: '40000', settledQuantity: '10.000' }] }
  });
  // Drain cash so reversing del-imm fails in entriesApply
  const cashNow = (ctx.state.balances.nakit / 100).toFixed(2);
  run(ctx, 'drain', { type: 'movement', accountId: 'nakit', direction: 'out', quantity: cashNow, category: 'İşletmeden çekiş', note: 'Kasa boşalt' });
  const snapBefore = structuredClone(ctx.state.customerOrders);
  assert.throws(() => applyEvent(ctx.state, {
    id: 'rev-imm-fail', schemaVersion: 3, timestamp: '2026-11-28T02:00:00Z',
    command: { type: 'reverse', date: '2026-11-28', originalId: 'del-imm', note: 'Yetersiz kasa ile ters kayıt' }
  }), /yetersiz mevcut/i);
  assert.deepEqual(ctx.state.customerOrders, snapBefore);

  // Ledger-view integration: moneyFlow includes customerOrder + orderDeliver, journal filter accepts orderDeliver & orders group
  const ledger = hydrateLedger(ctx.events);
  const projected = projectLedger(ledger, false);
  assert.ok(projected.moneyFlow.incoming >= 8000000 + 4000000);
  const optsSingle = normalizeJournalOptions({ scope: 'all', type: 'orderDeliver' });
  const jSingle = projectJournal(ledger, optsSingle);
  assert.ok(jSingle.items.some(e => e.id === 'del-imm'));
  const optsGroup = normalizeJournalOptions({ scope: 'all', type: 'orders' });
  const jGroup = projectJournal(ledger, optsGroup);
  assert.ok(jGroup.items.some(e => e.id === 'del-imm'));
});

test('v20 legacy orderDeliver replays cleanly alongside v21', () => {
  const ctx = openLedger();
  run(ctx, 'ord-leg', {
    type: 'customerOrder',
    customerId: 'cari-cust-1',
    description: 'Legacy v20 sipariş',
    orderUnit: 'GRAM',
    targetQuantity: '20',
    initialAdvance: { accountId: 'nakit', receivedQuantity: '80000', creditedQuantity: '20' }
  });
  // Historical v20 event without settledQuantity on cross-unit received
  run(ctx, 'del-leg', {
    type: 'orderDeliver',
    orderId: 'ord-leg',
    items: [{ accountId: 'bilezikAdet', quantity: '2', weightAccount: 'bilezik22', weight: '20.500' }],
    closeOrder: true,
    settlement: { received: [{ accountId: 'nakit', quantity: '2500' }] },
    note: 'Legacy v20 teslimat'
  }, 20);
  const replayed = replay(ctx.events);
  assert.equal(replayed.customerOrders.find(o => o.id === 'ord-leg').status, 'fulfilled');
  assert.equal(replayed.balances.nakit, 50000000 + 8000000 + 250000);
});
