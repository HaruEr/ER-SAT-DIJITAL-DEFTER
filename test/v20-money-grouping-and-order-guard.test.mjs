import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/amount-codec.js';
import { INITIAL_ACCOUNTS, applyEvent, eventVersion, replay } from '../domain.mjs';

const codec = globalThis.DefterAmountCodec;

test('v20.2 money grouping: 3-digit thousands, kuruş comma max 2 digits, backspace, mid-edit cursor, and gram isolation', () => {
  assert.equal(codec.isMoneyUnit('TL'), true);
  assert.equal(codec.isMoneyUnit('USD'), true);
  assert.equal(codec.isMoneyUnit('EUR'), true);
  assert.equal(codec.isMoneyUnit('GBP'), true);
  assert.equal(codec.isMoneyUnit('GRAM'), false);
  assert.equal(codec.isMoneyUnit('HAS'), false);
  assert.equal(codec.isMoneyUnit('SILVER'), false);
  assert.equal(codec.isMoneyUnit('ADET'), false);

  // Basic grouping
  assert.deepEqual(codec.formatLiveMoneyValue('100', 3), { value: '100', cursor: 3 });
  assert.deepEqual(codec.formatLiveMoneyValue('1000', 4), { value: '1.000', cursor: 5 });
  assert.deepEqual(codec.formatLiveMoneyValue('100000', 6), { value: '100.000', cursor: 7 });
  assert.deepEqual(codec.formatLiveMoneyValue('1250000', 7), { value: '1.250.000', cursor: 9 });

  // Kuruş with comma (max 2 digits, no dots after comma)
  assert.deepEqual(codec.formatLiveMoneyValue('1250000,', 8), { value: '1.250.000,', cursor: 10 });
  assert.deepEqual(codec.formatLiveMoneyValue('1250000,5', 9), { value: '1.250.000,5', cursor: 11 });
  assert.deepEqual(codec.formatLiveMoneyValue('1250000,50', 10), { value: '1.250.000,50', cursor: 12 });
  assert.deepEqual(codec.formatLiveMoneyValue('1250000,509', 11), { value: '1.250.000,50', cursor: 12 });

  // Critical Backspace safety: "1.000" -> backspace -> "1.00" MUST become "100" (100 TL), NEVER "1,00" (1 TL)!
  assert.deepEqual(codec.formatLiveMoneyValue('1.00', 4), { value: '100', cursor: 3 });
  assert.deepEqual(codec.formatLiveMoneyValue('10.00', 5), { value: '1.000', cursor: 5 });

  // Mid-number insertion preserves cursor position
  assert.deepEqual(codec.formatLiveMoneyValue('1050.000', 3), { value: '1.050.000', cursor: 4 });

  // Round-trip into parseUserAmount produces exact integer kuruş
  const parsed = codec.parseUserAmount('1.250.000,50', 'TL', { positive: true });
  assert.equal(parsed.status, 'valid');
  assert.equal(parsed.scaled, 125000050);
  assert.equal(parsed.canonical, '1250000.50');

  // Gram input is untouched by applyLiveMoneyGrouping
  const fakeGramInput = { value: '81,220', selectionStart: 6 };
  assert.equal(codec.applyLiveMoneyGrouping(fakeGramInput, 'GRAM'), false);
  assert.equal(fakeGramInput.value, '81,220');
  const parsedGram = codec.parseUserAmount('81,220', 'GRAM', { positive: true });
  assert.equal(parsedGram.status, 'valid');
  assert.equal(parsedGram.scaled, 81220);
});

test('v20.2 orderDeliver financial guard: blocks unsettled excess delivery (+1.000g over 81.220g) and auto-closes when settled', () => {
  const balances = Object.fromEntries(
    INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [
      a.id,
      a.id === 'nakit' ? '100000' : a.id === 'bilezikAdet' ? '50' : a.id === 'bilezik22' ? '500' : '0'
    ])
  );
  const events = [
    { id: 'op-1', schemaVersion: 3, timestamp: '2026-11-28T00:00:00Z', command: { type: 'opening', date: '2026-11-28', balances } },
    { id: 'cust-1', timestamp: '2026-11-28T00:01:00Z', command: { type: 'account', date: '2026-11-28', name: 'Test', partyType: 'customer', unit: 'TL', opening: '0' } }
  ];
  let state = replay(events);
  const run = (id, command) => {
    const sv = command.type === 'orderDeliver' ? 20 : eventVersion(command, state);
    const ev = { id, schemaVersion: sv, timestamp: '2026-11-28T01:00:00Z', command: { date: '2026-11-28', ...command } };
    state = applyEvent(state, ev);
    events.push(ev);
  };

  run('ord-1', {
    type: 'customerOrder',
    customerId: 'cari-cust-1',
    description: 'BİLEZİK ADET · 81,22 gr',
    category: 'bilezik',
    productAccountId: 'bilezikAdet',
    weightAccountId: 'bilezik22',
    orderUnit: 'GRAM',
    targetQuantity: '81.220',
    initialAdvance: { accountId: 'nakit', receivedQuantity: '100000', creditedQuantity: '81.220' }
  });

  // Partial delivery 1: 70.000g (5 adet) -> stays open with 11.220g remaining
  run('del-1', {
    type: 'orderDeliver',
    orderId: 'ord-1',
    items: [{ accountId: 'bilezikAdet', quantity: '5', weightAccount: 'bilezik22', weight: '70.000' }],
    closeOrder: false
  });
  assert.equal(state.customerOrders.find(o => o.id === 'ord-1').status, 'open');
  assert.equal(state.customerOrders.find(o => o.id === 'ord-1').deliveredQuantity, 70000);

  // Delivery 2: 12.220g (total 82.220g = +1.000g EXCESS!) WITHOUT settlement MUST FAIL!
  assert.throws(
    () => run('del-2-fail', {
      type: 'orderDeliver',
      orderId: 'ord-1',
      items: [{ accountId: 'bilezikAdet', quantity: '2', weightAccount: 'bilezik22', weight: '12.220' }],
      closeOrder: false
    }),
    /hedefini aşıyor/i
  );

  // Delivery 2 WITH explicit cash settlement for the +1.000g excess SUCCEEDS and AUTO-CLOSES!
  run('del-2-ok', {
    type: 'orderDeliver',
    orderId: 'ord-1',
    items: [{ accountId: 'bilezikAdet', quantity: '2', weightAccount: 'bilezik22', weight: '12.220' }],
    closeOrder: false, // even if false, reaching/exceeding target auto-closes!
    settlement: { received: [{ accountId: 'nakit', quantity: '3500' }] },
    note: '+1 gr fazla fark tahsil edildi'
  });

  const closedOrder = state.customerOrders.find(o => o.id === 'ord-1');
  assert.equal(closedOrder.status, 'fulfilled');
  assert.equal(closedOrder.deliveredQuantity, 82220);
  assert.equal(state.balances.nakit, 10000000 + 10000000 + 350000); // 100k opening + 100k kapora + 3.5k excess

  const replayed = replay(events);
  assert.deepEqual(replayed.balances, state.balances);
  assert.deepEqual(replayed.customerOrders, state.customerOrders);
});
