import test from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_ACCOUNTS, applyEvent, eventVersion, replay } from '../domain.mjs';

function openLedger() {
  const balances = Object.fromEntries(
    INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [
      a.id,
      a.id === 'nakit' ? '2000000' : a.id === 'banka' ? '1000000' : a.unit === 'ADET' ? '10' : a.unit === 'GRAM' ? '100' : '0'
    ])
  );
  const events = [
    { id: 'op-1', schemaVersion: 3, timestamp: '2026-11-28T00:00:00Z', command: { type: 'opening', date: '2026-11-28', balances } }
  ];
  return { state: replay(events), events };
}

function run(ctx, id, command) {
  const sv = eventVersion(command, ctx.state);
  const ev = { id, schemaVersion: sv, timestamp: '2026-11-28T01:00:00Z', command: { date: '2026-11-28', ...command } };
  ctx.state = applyEvent(ctx.state, ev);
  ctx.events.push(ev);
  return ev;
}

test('v20 supplierBind: forward lock (+200g HAS receivable / -1,200,000 TL payable) without cash in hand, then pay TL down', () => {
  const ctx = openLedger();
  run(ctx, 'cny', { type: 'supplierFirm', name: 'CNY KIYMETLİ MADENLER', autoUnits: true });
  const supplierId = 'supplier-cny';
  const hasAcc = ctx.state.accounts.find(a => a.supplierId === supplierId && a.unit === 'HAS');
  const tlAcc = ctx.state.accounts.find(a => a.supplierId === supplierId && a.unit === 'TL');

  // 1. Forward lock: +200g HAS receivable, -1,200,000 TL payable (zero cash moved!)
  run(ctx, 'bind-1', {
    type: 'supplierBind',
    supplierId,
    receiveAccountId: hasAcc.id,
    receiveQuantity: '200',
    oweAccountId: tlAcc.id,
    oweQuantity: '1200000',
    note: '200 gr HAS 6000 TL/gr fiyatından bağlandı'
  });

  assert.equal(ctx.state.balances[hasAcc.id], 200000); // +200.000g HAS receivable
  assert.equal(ctx.state.balances[tlAcc.id], -120000000); // -1,200,000.00 TL payable
  assert.equal(ctx.state.balances.nakit, 200000000); // Cash untouched!

  // 2. Pay 500,000 TL using autoSameUnit (no forced cross-unit conversion!)
  run(ctx, 'pay-tl-1', {
    type: 'supplierPayment',
    supplierId,
    given: [{ accountId: 'nakit', quantity: '500000' }],
    autoSameUnit: true,
    note: 'Bağlanan TL borcuna 500.000 TL kısmi ödeme'
  });

  assert.equal(ctx.state.balances.nakit, 150000000); // 2M - 500k = 1.5M TL
  assert.equal(ctx.state.balances[tlAcc.id], -70000000); // -1.2M + 500k = -700k TL debt remaining
  assert.equal(ctx.state.balances[hasAcc.id], 200000); // Still +200g HAS receivable

  const replayed = replay(ctx.events);
  assert.deepEqual(replayed.balances, ctx.state.balances);
});

test('v20 supplierPurchase openAccount + supplierPayment open same-unit credit + supplierAdjust', () => {
  const ctx = openLedger();
  run(ctx, 'firm-a', { type: 'supplierFirm', name: 'Firma A', autoUnits: true });
  const supplierId = 'supplier-firm-a';
  const tlAcc = ctx.state.accounts.find(a => a.supplierId === supplierId && a.unit === 'TL');

  // Open-account purchase without forced charges
  run(ctx, 'buy-open', {
    type: 'supplierPurchase',
    supplierId,
    items: [{ accountId: 'ceyrek', quantity: '15' }],
    openAccount: true,
    note: 'Fiyat sonradan bağlanacak 15 çeyrek'
  });
  assert.equal(ctx.state.balances.ceyrek, 25);

  // Open-unit payment: 100,000 TL stays as +100,000 TL open credit on Firma A
  run(ctx, 'pay-open', {
    type: 'supplierPayment',
    supplierId,
    given: [{ accountId: 'nakit', quantity: '100000' }],
    autoSameUnit: true,
    note: 'Açık hesap 100.000 TL ödeme'
  });
  assert.equal(ctx.state.balances[tlAcc.id], 10000000);

  // Reasoned balance adjustment (separate from supplierOpening)
  run(ctx, 'adj-1', {
    type: 'supplierAdjust',
    supplierId,
    accountId: tlAcc.id,
    direction: 'debt',
    quantity: '500',
    note: 'Mutabakat kuruş/komisyon düzeltmesi'
  });
  assert.equal(ctx.state.balances[tlAcc.id], 9950000);

  // Reverse supplierAdjust
  run(ctx, 'rev-adj', { type: 'supplierReverse', originalId: 'adj-1', note: 'Yanlış düzeltme geri alındı' });
  assert.equal(ctx.state.balances[tlAcc.id], 10000000);
});
