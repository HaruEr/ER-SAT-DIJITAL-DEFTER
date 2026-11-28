import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Repository } from '../repository.mjs';
import { applyEvent, eventVersion, replay } from '../domain.mjs';

function openLedger(t) {
  const dir = mkdtempSync(join(tmpdir(), 'orders-page-'));
  const repo = new Repository(join(dir, 'ledger.sqlite'));
  t.after(() => {
    repo.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const balances = Object.fromEntries(repo.state().accounts.map(a => [a.id, '0']));
  balances.nakit = '50000';
  balances.usd = '500';
  balances.bilezik22 = '100';
  balances.bilezikAdet = '10';
  balances.hurda22 = '20';
  repo.execute({
    id: 'open-1',
    revision: 0,
    command: { type: 'opening', date: '2026-11-24', balances, banks: [] }
  });
  repo.execute({
    id: 'cust-1',
    revision: repo.state().revision,
    command: { type: 'account', date: '2026-11-24', name: 'Ayşe Yılmaz', unit: 'TL', opening: '0', partyType: 'customer' }
  });
  return { repo, customerId: 'cari-cust-1' };
}

function exec(repo, id, command) {
  return repo.execute({ id, revision: repo.state().revision, command: { date: repo.state().date, ...command } });
}

test('10 gr Bilezik multi-unit order: atomic TL deposit -> USD deposit -> delivery sale with delivery-day TL settlement', t => {
  const { repo, customerId } = openLedger(t);
  const cashBefore = repo.state().balances.nakit;
  const usdBefore = repo.state().balances.usd;
  const bilezikBefore = repo.state().balances.bilezik22;

  // Day 1: 10 gr Bilezik order with atomic 20.000 TL cash deposit credited as 4,000 gr
  exec(repo, 'ord-1', {
    type: 'customerOrder',
    customerId,
    category: 'bilezik',
    orderUnit: 'GRAM',
    targetQuantity: '10',
    deliveryDate: '2026-11-30',
    targetSpec: '22 ayar burma',
    estimatedTotalTL: '55000',
    description: '10 gr 22 ayar burma bilezik',
    initialAdvance: {
      accountId: 'nakit',
      receivedQuantity: '20000',
      creditedQuantity: '4'
    }
  });

  let st = repo.state();
  assert.equal(st.balances.nakit, cashBefore + 2000000, 'Cash increases by 20.000 TL immediately');
  assert.equal(st.journal.at(-1).meta.revenue, 2000000, 'v22 cash-basis: non-carryover TL deposit adds receivedTL to revenue');
  let order = st.customerOrders.find(o => o.id === 'ord-1');
  assert.equal(order.category, 'bilezik');
  assert.equal(order.orderUnit, 'GRAM');
  assert.equal(order.targetQuantity, 10000);
  assert.equal(order.availableQuantity, 4000);
  assert.equal(order.deliveryDate, '2026-11-30');
  assert.equal(order.estimatedTotalTL, 5500000);

  // Additional deposit: 200 USD credited as 1,000 gr (no automatic FX conversion)
  exec(repo, 'adv-2', {
    type: 'orderAdvance',
    orderId: 'ord-1',
    accountId: 'usd',
    receivedQuantity: '200',
    creditedQuantity: '1',
    note: 'Ek döviz kapora'
  });
  st = repo.state();
  assert.equal(st.balances.usd, usdBefore + 20000, 'USD cash increases by 200 USD');
  assert.equal(st.journal.at(-1).meta.revenue, 0);
  order = st.customerOrders.find(o => o.id === 'ord-1');
  assert.equal(order.availableQuantity, 5000, '5,000 gr paid; 5,000 gr remains');

  // Delivery day: gold price is now 6.000 TL/gr -> 10 gr = 60.000 TL total.
  // 5,000 gr deposits settle for 30.000 TL (24.000 + 6.000); remaining 30.000 TL paid in cash.
  exec(repo, 'sale-deliver-1', {
    type: 'sale',
    counterpartyType: 'customer',
    counterpartyId: customerId,
    items: [{ accountId: 'bilezikAdet', quantity: '1', weightAccount: 'bilezik22', weight: '10', value: '60000' }],
    received: [{ accountId: 'nakit', quantity: '30000', valueTL: '30000' }],
    given: [],
    credits: [],
    debts: [],
    note: '10 gr bilezik teslimatı',
    orderSettlement: {
      orderId: 'ord-1',
      advances: [
        { advanceId: 'ord-1', appliedQuantity: '4', appliedValueTL: '24000' },
        { advanceId: 'adv-2', appliedQuantity: '1', appliedValueTL: '6000' }
      ]
    }
  });

  st = repo.state();
  assert.equal(st.balances.bilezik22, bilezikBefore - 10000, '10 gr deducted from bilezik22 stock');
  assert.equal(st.balances.nakit, cashBefore + 2000000 + 3000000, 'Cash has initial 20k + final 30k = +50k TL');
  assert.equal(st.balances.usd, usdBefore + 20000, 'USD deposit remains intact');
  assert.equal(st.journal.at(-1).meta.revenue, 6000000, 'Single delivery-day revenue of 60.000 TL');
  assert.equal(st.journal.at(-1).meta.advanceAppliedTL, 3000000);
  order = st.customerOrders.find(o => o.id === 'ord-1');
  assert.equal(order.status, 'fulfilled');
  assert.equal(order.availableQuantity, 0);
  assert.equal(order.saleId, 'sale-deliver-1');
});

test('Multi-unit order enforces explicit cross-unit credit, refund bounds, cancel guard, employee lockout, and replay/restore parity', t => {
  const { repo, customerId } = openLedger(t);

  // Reject cross-unit deposit without explicit creditedQuantity (no implicit FX)
  assert.throws(() => exec(repo, 'bad-fx', {
    type: 'customerOrder',
    customerId,
    category: 'gram',
    orderUnit: 'HAS',
    targetQuantity: '5',
    description: '5 gr HAS sipariş',
    initialAdvance: { accountId: 'nakit', receivedQuantity: '10000' }
  }), /açıkça girin/);

  // Create valid HAS order with 2,000 HAS credited from 10.000 TL cash
  exec(repo, 'ord-has', {
    type: 'customerOrder',
    customerId,
    category: 'gram',
    orderUnit: 'HAS',
    targetQuantity: '5',
    description: '5 gr HAS sipariş',
    initialAdvance: { accountId: 'nakit', receivedQuantity: '10000', creditedQuantity: '2' }
  });

  // Cannot cancel while unused deposit exists
  assert.throws(() => exec(repo, 'bad-cancel', {
    type: 'orderCancel',
    orderId: 'ord-has',
    note: 'Vazgeçti'
  }), /kullanılmamış avansı iade edin/);

  // Cannot refund more than credited quantity
  assert.throws(() => exec(repo, 'bad-refund', {
    type: 'orderRefund',
    orderId: 'ord-has',
    advanceId: 'ord-has',
    accountId: 'nakit',
    refundedQuantity: '12000',
    creditedQuantity: '2.5'
  }), /kullanılmamış tutarı aşıyor/);

  // Valid refund of 2,000 HAS credit by paying 11.000 TL cash -> then cancel succeeds
  const cashBeforeRefund = repo.state().balances.nakit;
  exec(repo, 'ref-1', {
    type: 'orderRefund',
    orderId: 'ord-has',
    advanceId: 'ord-has',
    accountId: 'nakit',
    refundedQuantity: '11000',
    creditedQuantity: '2',
    note: 'Güncel fiyattan iade'
  });
  assert.equal(repo.state().balances.nakit, cashBeforeRefund - 1100000);
  assert.equal(repo.state().customerOrders.find(o => o.id === 'ord-has').availableQuantity, 0);

  exec(repo, 'can-1', {
    type: 'orderCancel',
    orderId: 'ord-has',
    note: 'Müşteri vazgeçti'
  });
  assert.equal(repo.state().customerOrders.find(o => o.id === 'ord-has').status, 'cancelled');

  // Legacy v11 TL order still works alongside v18 orders
  exec(repo, 'ord-legacy', {
    type: 'customerOrder',
    customerId,
    description: 'Eski TL sipariş'
  });
  exec(repo, 'adv-legacy', {
    type: 'orderAdvance',
    orderId: 'ord-legacy',
    accountId: 'nakit',
    amountTL: '1500'
  });

  // Replay & JSON backup restore parity
  const exported = repo.backup();
  const replayed = replay(exported.events);
  assert.deepEqual(replayed.balances, repo.state().balances);
  assert.equal(replayed.customerOrders.length, 2);
  assert.equal(replayed.customerOrders.find(o => o.id === 'ord-legacy').availableTL, 150000);

  // Employee lockout on v18 customerOrder
  const cmd = { type: 'customerOrder', date: '2026-11-24', customerId, category: 'sarrafiye', orderUnit: 'ADET', description: 'Çeyrek' };
  assert.throws(() => applyEvent(repo.state(), {
    id: 'emp-ord',
    timestamp: new Date().toISOString(),
    schemaVersion: eventVersion(cmd, repo.state()),
    command: cmd,
    audit: { actor: { id: 'emp-1', name: 'Çalışan', role: 'employee' } }
  }), /yönetici gerekli/);
});

test('Order product/weight binding and orderUpdate editing rules with replay parity', t => {
  const { repo, customerId } = openLedger(t);

  // Reject invalid weightAccountId for product
  assert.throws(() => exec(repo, 'bad-weight', {
    type: 'customerOrder',
    customerId,
    category: 'bilezik',
    productAccountId: 'bilezikAdet',
    weightAccountId: 'taki14',
    orderUnit: 'GRAM',
    description: 'Uyumsuz terazi grubu'
  }), /geçerli bir bağlı ayar \/ terazi grubu seçin/);

  // Create open order without advance, bound to bilezikAdet + bilezik22
  exec(repo, 'ord-edit-1', {
    type: 'customerOrder',
    customerId,
    category: 'bilezik',
    productAccountId: 'bilezikAdet',
    weightAccountId: 'bilezik22',
    orderUnit: 'GRAM',
    targetQuantity: '10',
    deliveryDate: '2026-11-28',
    targetSpec: '22 ayar burma',
    estimatedTotalTL: '55000',
    description: 'BİLEZİK ADET · BİLEZİK TERAZİ · 10 gr · 22 ayar burma'
  });

  let order = repo.state().customerOrders.find(o => o.id === 'ord-edit-1');
  assert.equal(order.productAccountId, 'bilezikAdet');
  assert.equal(order.weightAccountId, 'bilezik22');

  // Edit open order with 0 advances: orderUnit CAN be changed, along with category/product/weight/spec
  exec(repo, 'upd-1', {
    type: 'orderUpdate',
    orderId: 'ord-edit-1',
    category: 'urun',
    productAccountId: 'yuzuk',
    weightAccountId: 'taki14',
    orderUnit: 'HAS',
    targetQuantity: '3.5',
    deliveryDate: '2026-12-05',
    targetSpec: '14 ayar taşlı yüzük',
    estimatedTotalTL: '28000',
    description: 'YÜZÜK · 14 AYAR TAKI · 3,5 HAS · 14 ayar taşlı yüzük'
  });

  order = repo.state().customerOrders.find(o => o.id === 'ord-edit-1');
  assert.equal(order.category, 'urun');
  assert.equal(order.productAccountId, 'yuzuk');
  assert.equal(order.weightAccountId, 'taki14');
  assert.equal(order.orderUnit, 'HAS');
  assert.equal(order.targetQuantity, 3500);
  assert.equal(order.deliveryDate, '2026-12-05');
  assert.equal(order.targetSpec, '14 ayar taşlı yüzük');
  assert.equal(order.estimatedTotalTL, 2800000);
  assert.equal(repo.state().journal.at(-1).meta.revenue, 0);

  // Add a deposit -> now orderUnit MUST be locked on orderUpdate
  exec(repo, 'adv-edit-1', {
    type: 'orderAdvance',
    orderId: 'ord-edit-1',
    accountId: 'nakit',
    receivedQuantity: '10000',
    creditedQuantity: '1.5',
    note: 'Kapora'
  });

  assert.throws(() => exec(repo, 'upd-bad-unit', {
    type: 'orderUpdate',
    orderId: 'ord-edit-1',
    category: 'urun',
    productAccountId: 'yuzuk',
    weightAccountId: 'taki14',
    orderUnit: 'GRAM',
    targetQuantity: '3.5',
    description: 'Birim değiştirme denemesi'
  }), /Kapora alınmış veya teslimatı yapılmış siparişin takip birimi değiştirilemez/);

  // Editing other fields with same orderUnit succeeds even after advance
  exec(repo, 'upd-2', {
    type: 'orderUpdate',
    orderId: 'ord-edit-1',
    category: 'bilezik',
    productAccountId: 'bilezikAdet',
    weightAccountId: 'bilezik22',
    orderUnit: 'HAS',
    targetQuantity: '4',
    deliveryDate: '2026-12-10',
    targetSpec: '22 ayar mega bilezik',
    estimatedTotalTL: '32000',
    description: 'BİLEZİK ADET · BİLEZİK TERAZİ · 4 HAS · 22 ayar mega bilezik'
  });

  order = repo.state().customerOrders.find(o => o.id === 'ord-edit-1');
  assert.equal(order.productAccountId, 'bilezikAdet');
  assert.equal(order.weightAccountId, 'bilezik22');
  assert.equal(order.targetQuantity, 4000);
  assert.equal(order.deliveryDate, '2026-12-10');

  // Employee lockout on orderUpdate
  const empUpd = { type: 'orderUpdate', date: '2026-11-24', orderId: 'ord-edit-1', description: 'Yetkisiz düzenleme' };
  assert.throws(() => applyEvent(repo.state(), {
    id: 'emp-upd',
    timestamp: new Date().toISOString(),
    schemaVersion: eventVersion(empUpd, repo.state()),
    command: empUpd,
    audit: { actor: { id: 'emp-1', name: 'Çalışan', role: 'employee' } }
  }), /yönetici gerekli/);

  // Replay & backup parity
  const exported = repo.backup();
  const replayed = replay(exported.events);
  assert.deepEqual(replayed.balances, repo.state().balances);
  const replayedOrder = replayed.customerOrders.find(o => o.id === 'ord-edit-1');
  assert.equal(replayedOrder.productAccountId, 'bilezikAdet');
  assert.equal(replayedOrder.weightAccountId, 'bilezik22');
  assert.equal(replayedOrder.targetQuantity, 4000);
  assert.equal(replayedOrder.availableQuantity, 1500);

  // Fulfill the order -> orderUpdate must be rejected on closed order
  exec(repo, 'sale-close-edit', {
    type: 'sale',
    counterpartyType: 'customer',
    counterpartyId: customerId,
    items: [{ accountId: 'bilezikAdet', quantity: '1', weightAccount: 'bilezik22', weight: '4', value: '30000' }],
    received: [{ accountId: 'nakit', quantity: '18000', valueTL: '18000' }],
    given: [],
    credits: [],
    debts: [],
    note: 'Teslimat',
    orderSettlement: {
      orderId: 'ord-edit-1',
      advances: [{ advanceId: 'adv-edit-1', appliedQuantity: '1.5', appliedValueTL: '12000' }]
    }
  });

  assert.throws(() => exec(repo, 'upd-closed', {
    type: 'orderUpdate',
    orderId: 'ord-edit-1',
    description: 'Kapalı sipariş düzenlenemez'
  }), /İşleme uygun açık sipariş seçin/);
});

test('Excess deposit delivery (lighter weighed product): deducts exact weighed stock, settles full deposit, balances change in cash with replay parity', t => {
  const { repo, customerId } = openLedger(t);
  const cashStart = repo.state().balances.nakit;
  const bilezikStart = repo.state().balances.bilezik22;

  // Customer pays 60.000 TL for 7,20 gr target
  exec(repo, 'ord-excess', {
    type: 'customerOrder',
    customerId,
    category: 'bilezik',
    productAccountId: 'bilezikAdet',
    weightAccountId: 'bilezik22',
    orderUnit: 'GRAM',
    targetQuantity: '7.2',
    description: 'BİLEZİK ADET · BİLEZİK TERAZİ · 7,2 gr',
    initialAdvance: { accountId: 'nakit', receivedQuantity: '60000', creditedQuantity: '7.2' }
  });

  // Delivery day: weighed 7,00 gr (0,20 gr lighter -> 58.300 TL sale, 1.700 TL cash change returned)
  // Unbalanced attempt MUST still fail
  assert.throws(() => exec(repo, 'sale-excess-unbalanced', {
    type: 'sale',
    counterpartyType: 'customer',
    counterpartyId: customerId,
    items: [{ accountId: 'bilezikAdet', quantity: '1', weightAccount: 'bilezik22', weight: '7', value: '58300' }],
    received: [],
    given: [],
    credits: [],
    debts: [],
    note: 'Dengesiz fazla kapora',
    orderSettlement: {
      orderId: 'ord-excess',
      advances: [{ advanceId: 'ord-excess', appliedQuantity: '7.2', appliedValueTL: '60000' }]
    }
  }), /TL dengesi eşleşmeli/);

  // Balanced with 1.700 TL cash change in given
  exec(repo, 'sale-excess-ok', {
    type: 'sale',
    counterpartyType: 'customer',
    counterpartyId: customerId,
    items: [{ accountId: 'bilezikAdet', quantity: '1', weightAccount: 'bilezik22', weight: '7', value: '58300' }],
    received: [],
    given: [{ accountId: 'nakit', quantity: '1700', valueTL: '1700' }],
    credits: [],
    debts: [],
    note: '7,00 gr teslim + 1.700 TL para üstü iade',
    orderSettlement: {
      orderId: 'ord-excess',
      advances: [{ advanceId: 'ord-excess', appliedQuantity: '7.2', appliedValueTL: '60000' }]
    }
  });

  const st = repo.state();
  assert.equal(st.balances.bilezik22, bilezikStart - 7000, 'Exact weighed 7,000 gr deducted from stock (NOT 7,200 gr)');
  assert.equal(st.balances.nakit, cashStart + 6000000 - 170000, 'Net cash = +58.300 TL');
  assert.equal(st.journal.at(-1).meta.revenue, 5830000, 'Revenue = 58.300 TL');
  const order = st.customerOrders.find(o => o.id === 'ord-excess');
  assert.equal(order.status, 'fulfilled');
  assert.equal(order.availableQuantity, 0);

  const exported = repo.backup();
  const replayed = replay(exported.events);
  assert.deepEqual(replayed.balances, st.balances);
});
