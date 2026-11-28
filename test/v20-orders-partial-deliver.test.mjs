import test from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_ACCOUNTS, applyEvent, eventVersion, replay } from '../domain.mjs';

function openLedger() {
  const balances = Object.fromEntries(
    INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [
      a.id,
      a.id === 'nakit' ? '100000' : a.id === 'usd' ? '5000' : a.id === 'bilezikAdet' ? '50' : a.id === 'bilezik22' ? '500' : a.unit === 'ADET' ? '20' : a.unit === 'GRAM' ? '200' : '0'
    ])
  );
  const events = [
    { id: 'op-1', schemaVersion: 3, timestamp: '2026-11-28T00:00:00Z', command: { type: 'opening', date: '2026-11-28', balances } },
    { id: 'cust-1', timestamp: '2026-11-28T00:01:00Z', command: { type: 'account', date: '2026-11-28', name: 'Ayşe Yılmaz', partyType: 'customer', unit: 'TL', opening: '0' } }
  ];
  return { state: replay(events), events };
}

function run(ctx, id, command) {
  const sv = command.type === 'orderDeliver' ? 20 : eventVersion(command, ctx.state);
  const ev = { id, schemaVersion: sv, timestamp: '2026-11-28T01:00:00Z', command: { date: '2026-11-28', ...command } };
  ctx.state = applyEvent(ctx.state, ev);
  ctx.events.push(ev);
  return ev;
}

test('v20 orderDeliver: pre-paid carryover order delivers at 0 TL (pure stock exit, no forced TL price)', () => {
  const ctx = openLedger();
  run(ctx, 'ord-carry', {
    type: 'customerOrder',
    customerId: 'cari-cust-1',
    description: '10 adet 10g ajda devir siparişi',
    category: 'bilezik',
    productAccountId: 'bilezikAdet',
    weightAccountId: 'bilezik22',
    orderUnit: 'GRAM',
    targetQuantity: '100',
    initialAdvance: { carryover: true, creditedQuantity: '100', note: 'Eski defter fiş #412 tam ödendi' }
  });

  // Partial delivery 1: 7 adet, 69.780 gr — order stays OPEN with 30.220 gr remaining!
  run(ctx, 'deliv-1', {
    type: 'orderDeliver',
    orderId: 'ord-carry',
    items: [{ accountId: 'bilezikAdet', quantity: '7', weightAccount: 'bilezik22', weight: '69.780' }],
    closeOrder: false,
    note: '7 adet 69,78 gr teslim edildi'
  });

  let order = ctx.state.customerOrders.find(o => o.id === 'ord-carry');
  assert.equal(order.status, 'open');
  assert.equal(order.deliveredQuantity, 69780);
  assert.equal(order.deliveredPieces, 7);
  assert.equal(order.availableQuantity, 30220);
  assert.equal(ctx.state.balances.bilezikAdet, 43);
  assert.equal(ctx.state.balances.bilezik22, 430220);
  assert.equal(ctx.state.balances.nakit, 10000000); // untouched!

  // Final delivery 2: 3 adet, 30.220 gr — exact match, 0 TL settlement, closes order!
  run(ctx, 'deliv-2', {
    type: 'orderDeliver',
    orderId: 'ord-carry',
    items: [{ accountId: 'bilezikAdet', quantity: '3', weightAccount: 'bilezik22', weight: '30.220' }],
    closeOrder: true,
    note: 'Kalan 3 adet 30,22 gr teslim edildi'
  });

  order = ctx.state.customerOrders.find(o => o.id === 'ord-carry');
  assert.equal(order.status, 'fulfilled');
  assert.equal(order.deliveredQuantity, 100000);
  assert.equal(order.deliveredPieces, 10);
  assert.equal(order.availableQuantity, 0);
  assert.equal(ctx.state.balances.bilezikAdet, 40);
  assert.equal(ctx.state.balances.bilezik22, 400000);

  // Replay produces identical state
  const replayed = replay(ctx.events);
  assert.deepEqual(replayed.balances, ctx.state.balances);
  assert.deepEqual(replayed.customerOrders, ctx.state.customerOrders);
});

test('v20 multi-unit kapora + final delivery difference settlement + delivery reversal', () => {
  const ctx = openLedger();
  run(ctx, 'ord-multi', {
    type: 'customerOrder',
    customerId: 'cari-cust-1',
    description: '20g bilezik çoklu kapora',
    category: 'bilezik',
    productAccountId: 'bilezikAdet',
    weightAccountId: 'bilezik22',
    orderUnit: 'GRAM',
    targetQuantity: '20',
    initialAdvances: [
      { accountId: 'nakit', receivedQuantity: '50000', creditedQuantity: '10' },
      { accountId: 'usd', receivedQuantity: '1000', creditedQuantity: '10' }
    ]
  });

  assert.equal(ctx.state.balances.nakit, 10000000 + 5000000);
  assert.equal(ctx.state.balances.usd, 500000 + 100000);
  assert.equal(ctx.state.customerOrders.find(o => o.id === 'ord-multi').availableQuantity, 20000);

  // Deliver 20.500g (0.500g heavier) and settle +2500 TL extra in cash
  run(ctx, 'deliv-final', {
    type: 'orderDeliver',
    orderId: 'ord-multi',
    items: [{ accountId: 'bilezikAdet', quantity: '2', weightAccount: 'bilezik22', weight: '20.500' }],
    closeOrder: true,
    settlement: { received: [{ accountId: 'nakit', quantity: '2500' }] },
    note: '0.5g fark tahsil edildi'
  });

  assert.equal(ctx.state.customerOrders.find(o => o.id === 'ord-multi').status, 'fulfilled');
  assert.equal(ctx.state.balances.nakit, 10000000 + 5000000 + 250000);

  // Reverse the delivery -> order returns to open and stock/cash restore cleanly!
  run(ctx, 'rev-deliv', { type: 'reverse', originalId: 'deliv-final', note: 'Yanlış tartım düzeltme' });
  const restoredOrder = ctx.state.customerOrders.find(o => o.id === 'ord-multi');
  assert.equal(restoredOrder.status, 'open');
  assert.equal(restoredOrder.deliveredQuantity, 0);
  assert.equal(restoredOrder.availableQuantity, 20000);
  assert.equal(ctx.state.balances.nakit, 10000000 + 5000000);
  assert.equal(ctx.state.balances.bilezik22, 500000);
});
