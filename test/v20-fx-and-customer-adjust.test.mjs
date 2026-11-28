import test from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_ACCOUNTS, applyEvent, eventVersion, replay } from '../domain.mjs';

function openLedger() {
  const balances = Object.fromEntries(
    INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [
      a.id,
      a.id === 'nakit' ? '500000' : a.id === 'usd' ? '10000' : a.id === 'eur' ? '5000' : '0'
    ])
  );
  const events = [
    { id: 'op-1', schemaVersion: 3, timestamp: '2026-11-28T00:00:00Z', command: { type: 'opening', date: '2026-11-28', balances } },
    { id: 'cust-1', timestamp: '2026-11-28T00:01:00Z', command: { type: 'account', date: '2026-11-28', name: 'Mehmet Demir', partyType: 'customer', unit: 'TL', opening: '0' } }
  ];
  return { state: replay(events), events };
}

const OWNER_ACTOR = { id: '11111111-1111-4111-8111-111111111111', name: 'Yönetici', role: 'owner' };
const EMP_ACTOR = { id: '22222222-2222-4222-8222-222222222222', name: 'Çalışan', role: 'employee' };

function run(ctx, id, command, actor = OWNER_ACTOR) {
  const sv = eventVersion(command, ctx.state);
  const ev = { id, schemaVersion: sv, timestamp: '2026-11-28T01:00:00Z', command: { date: '2026-11-28', ...command }, audit: { version: 1, actor } };
  ctx.state = applyEvent(ctx.state, ev);
  ctx.events.push(ev);
  return ev;
}

test('v20 customerAdjustment (kasasız) and collection allowAdvance (kasalı) on 0-balance customer', () => {
  const ctx = openLedger();

  // 1. Direct kasasız debt on 0-balance customer (owner-only)
  assert.throws(
    () => run(ctx, 'adj-emp', { type: 'customerAdjustment', customerAccount: 'cari-cust-1', direction: 'debt', quantity: '5000', note: 'Çalışan denemesi' }, EMP_ACTOR),
    /yönetici/i
  );

  run(ctx, 'adj-1', {
    type: 'customerAdjustment',
    customerAccount: 'cari-cust-1',
    direction: 'debt',
    quantity: '5000',
    note: 'Eski defterden mutabakat borcu'
  });
  assert.equal(ctx.state.balances['cari-cust-1'], 500000);
  assert.equal(ctx.state.balances.nakit, 50000000); // kasasız: cash untouched

  // 2. Kasalı collection exceeding balance (allowAdvance: true) -> customer gets credit!
  run(ctx, 'col-adv', {
    type: 'collection',
    customerAccount: 'cari-cust-1',
    direction: 'collect',
    target: 'nakit',
    quantity: '8000',
    allowAdvance: true,
    note: '5000 borç kapatma + 3000 emanet avans'
  });
  assert.equal(ctx.state.balances['cari-cust-1'], -300000); // 3,000 TL customer credit
  assert.equal(ctx.state.balances.nakit, 50800000);

  // 3. Reverse customerAdjustment works cleanly
  run(ctx, 'rev-adj', { type: 'reverse', originalId: 'adj-1', note: 'Düzeltme iptali' });
  assert.equal(ctx.state.balances['cari-cust-1'], -800000);

  const replayed = replay(ctx.events);
  assert.deepEqual(replayed.balances, ctx.state.balances);
});

test('v20 currencyExchange supports amend and reverse', () => {
  const ctx = openLedger();
  run(ctx, 'fx-1', {
    type: 'currencyExchange',
    received: [{ accountId: 'usd', quantity: '1000' }],
    given: [{ accountId: 'nakit', quantity: '38500' }],
    note: '1000 USD alış'
  });
  assert.equal(ctx.state.balances.usd, 1100000);
  assert.equal(ctx.state.balances.nakit, 46150000);

  run(ctx, 'fx-rev', { type: 'reverse', originalId: 'fx-1', note: 'Kur düzeltmesi için iptal' });
  assert.equal(ctx.state.balances.usd, 1000000);
  assert.equal(ctx.state.balances.nakit, 50000000);
});
