import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { replay } from '../domain.mjs';

async function fixture(t) {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'approval-queue-'));
  const { server, repositories } = createApp({ dataDirectory, logger: () => {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    rmSync(dataDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const send = (path, token, body) => {
    const headers = token ? { Authorization: 'Bearer ' + token } : {};
    return fetch(base + path, body === undefined ? { headers } : {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
  };
  return { send, repositories };
}

test('Owner-only username rename and Master PIN access into employee checkout account', async t => {
  const { send } = await fixture(t);
  const owner = await (await send('/api/auth/setup', null, { name: 'Patron Eski', pin: '112233' })).json();
  const emp = await (await send('/api/auth/employees', owner.token, { name: 'Kasiyer Eski', pin: '445566' })).json();

  // Owner renames self
  const r1 = await send('/api/auth/rename', owner.token, { id: owner.actor.id, name: 'Patron Yeni' });
  assert.equal(r1.status, 200);
  assert.equal((await r1.json()).user.name, 'Patron Yeni');

  // Owner renames employee
  const r2 = await send('/api/auth/rename', owner.token, { id: emp.id, name: 'Kasiyer Ayşe' });
  assert.equal(r2.status, 200);
  assert.equal((await r2.json()).user.name, 'Kasiyer Ayşe');

  // Duplicate name fails 409
  const dup = await send('/api/auth/rename', owner.token, { id: emp.id, name: 'patron yeni' });
  assert.equal(dup.status, 409);

  // Master PIN logs into employee account with viaMasterPin=true and mustChangePin=false
  const masterLogin = await send('/api/auth/login', null, { name: 'Kasiyer Ayşe', pin: '112233' });
  assert.equal(masterLogin.status, 200);
  const masterSession = await masterLogin.json();
  assert.equal(masterSession.actor.id, emp.id);
  assert.equal(masterSession.actor.role, 'employee');
  assert.equal(masterSession.actor.viaMasterPin, true);
  assert.equal(masterSession.actor.masterActorId, owner.actor.id);
  assert.equal(masterSession.actor.mustChangePin, false);

  // Employee cannot call /api/auth/rename
  assert.equal((await send('/api/auth/rename', masterSession.token, { id: emp.id, name: 'Kaçak Ad' })).status, 403);
});

test('Maker-Checker approval queue, closing block, edited/direct approval, rejection, category/karat analytics, and journal attribution', async t => {
  const { send, repositories } = await fixture(t);
  const owner = await (await send('/api/auth/setup', null, { name: 'Yönetici Hasan', pin: '102030' })).json();
  const emp1 = await (await send('/api/auth/employees', owner.token, { name: 'Kasiyer Ayşe', pin: '111111' })).json();
  const emp1Login = await (await send('/api/auth/login', null, { name: 'Kasiyer Ayşe', pin: '111111' })).json();
  assert.equal((await send('/api/auth/change-pin', emp1Login.token, { currentPin: '111111', newPin: '222222' })).status, 200);

  const initState = await (await send('/api/state', owner.token)).json();
  const date = '2026-11-24';
  const balances = Object.fromEntries(initState.accounts.filter(a => !a.retired).map(a => [a.id, ({
    nakit: '100000', bilezikAdet: '10', bilezik22: '200', kunye: '10', sahmeran: '10', taki14: '100', taki22: '100', ceyrek: '20', gramToplam: '50'
  })[a.id] || '0']));
  assert.equal((await send('/api/command', owner.token, { id: 'open-1', revision: 0, command: { type: 'opening', date, balances } })).status, 200);

  // Worker CAN create zero-balance customer directly
  const custRes = await send('/api/command', emp1Login.token, {
    id: 'cust-1', revision: 1,
    command: { type: 'account', date, name: 'Müşteri Fatma', unit: 'TL', partyType: 'customer', opening: '0' }
  });
  assert.equal(custRes.status, 200);
  const customerId = 'cari-cust-1';

  // Worker CANNOT post sale directly to /api/command (must go to pending-approvals)
  const directSale = {
    type: 'sale', date, counterpartyType: 'customer', counterpartyId: customerId,
    items: [{ accountId: 'kunye', quantity: '1', weightAccount: 'taki14', weight: '6.5', value: '30000' }],
    received: [{ accountId: 'nakit', quantity: '30000', valueTL: '30000' }], given: []
  };
  assert.equal((await send('/api/command', emp1Login.token, { id: 'direct-blocked', revision: 2, command: directSale })).status, 403);

  // 1. Worker submits 14A Künye sale to approval queue -> ZERO stock/cash change!
  const sub1 = await send('/api/pending-approvals', emp1Login.token, { id: 'sub-kunye-14', command: directSale });
  assert.equal(sub1.status, 201);
  // Idempotent duplicate retry succeeds
  const sub1Dup = await send('/api/pending-approvals', emp1Login.token, { id: 'sub-kunye-14', command: directSale });
  assert.equal(sub1Dup.status, 201);
  assert.equal((await sub1Dup.json()).duplicate, true);

  // Verify stock & cash did NOT change yet (compact view includes pendingApprovalCount)
  let st = await (await send('/api/state?view=compact', owner.token)).json();
  assert.equal(st.balances.taki14, 100000);
  assert.equal(st.balances.nakit, 10000000);
  assert.equal(st.pendingApprovalCount, 1);

  // Closing MUST be blocked while pending submission exists (409)
  const dailyCounts = Object.fromEntries(st.accounts.filter(a => !a.retired && a.physical && a.countPolicy === 'daily').map(a => [a.id, '0']));
  const closeBlocked = await send('/api/command', owner.token, {
    id: 'close-blocked', revision: st.revision,
    command: { type: 'close', date, nextDate: '2026-11-25', counts: dailyCounts, reasons: {}, approvedBy: 'Yönetici Hasan' }
  });
  assert.equal(closeBlocked.status, 409);

  // 2. Worker submits 22A Şahmeran sale & a Bilezik sale (which will be rejected)
  const sahmeranSale = {
    type: 'sale', date, counterpartyType: 'customer', counterpartyId: customerId,
    items: [{ accountId: 'sahmeran', quantity: '1', weightAccount: 'taki22', weight: '7.2', value: '62000' }],
    received: [{ accountId: 'nakit', quantity: '62000', valueTL: '62000' }], given: []
  };
  assert.equal((await send('/api/pending-approvals', emp1Login.token, { id: 'sub-sahmeran-22', command: sahmeranSale })).status, 201);
  const bilezikSale = {
    type: 'sale', date, counterpartyType: 'customer', counterpartyId: customerId,
    items: [{ accountId: 'bilezikAdet', quantity: '1', weightAccount: 'bilezik22', weight: '10', value: '85000' }],
    received: [{ accountId: 'nakit', quantity: '85000', valueTL: '85000' }], given: []
  };
  assert.equal((await send('/api/pending-approvals', emp1Login.token, { id: 'sub-bilezik-rej', command: bilezikSale })).status, 201);

  // Owner directly approves sub-kunye-14 (wasEdited = false)
  const appr1 = await send('/api/pending-approvals/approve', owner.token, { id: 'sub-kunye-14', revision: st.revision });
  assert.equal(appr1.status, 200);
  const appr1Body = await appr1.json();
  assert.equal(appr1Body.wasEdited, false);
  assert.equal(appr1Body.state.balances.taki14, 100000 - 6500);
  assert.equal(appr1Body.state.balances.nakit, 10000000 + 3000000);

  // Owner edits & approves sub-sahmeran-22 (weight changed 7.2 -> 7.35, value 62000 -> 63500)
  const editedSahmeran = {
    ...sahmeranSale,
    items: [{ accountId: 'sahmeran', quantity: '1', weightAccount: 'taki22', weight: '7.35', value: '63500' }],
    received: [{ accountId: 'nakit', quantity: '63500', valueTL: '63500' }]
  };
  const appr2 = await send('/api/pending-approvals/approve', owner.token, { id: 'sub-sahmeran-22', revision: appr1Body.state.revision, command: editedSahmeran });
  assert.equal(appr2.status, 200);
  const appr2Body = await appr2.json();
  assert.equal(appr2Body.wasEdited, true);
  assert.equal(appr2Body.state.balances.taki22, 100000 - 7350);

  // Owner rejects sub-bilezik-rej -> bilezik22 stock remains untouched!
  const rej = await send('/api/pending-approvals/reject', owner.token, { id: 'sub-bilezik-rej', reason: 'Gramaj hatalı girilmiş' });
  assert.equal(rej.status, 200);
  st = await (await send('/api/state?view=compact', owner.token)).json();
  assert.equal(st.balances.bilezik22, 200000, 'Rejected submission must NOT touch stock');
  assert.equal(st.pendingApprovalCount, 0);

  // Verify Analytics: category/karat breakdown + sub-products + direct/edited/rejected counts
  const analyticsRes = await (await send(`/api/pending-approvals?status=all&startDate=${date}&endDate=${date}`, owner.token)).json();
  const totals = analyticsRes.analytics.totals;
  assert.equal(totals.approvedDirectCount, 1);
  assert.equal(totals.approvedEditedCount, 1);
  assert.equal(totals.rejectedCount, 1);
  assert.equal(totals.saleCount, 2);
  assert.equal(totals.saleTotalTL, 3000000 + 6350000);
  assert.equal(totals.saleTotalGram, 6500 + 7350);

  const cat14 = totals.salesByCategory.find(c => c.key === 'taki14');
  assert.equal(cat14.gram, 6500);
  assert.equal(cat14.products[0].name, 'KÜNYE');
  assert.equal(cat14.products[0].gram, 6500);

  const cat22 = totals.salesByCategory.find(c => c.key === 'taki22');
  assert.equal(cat22.gram, 7350);
  assert.equal(cat22.products[0].name, 'ŞAHMERAN');
  assert.equal(cat22.products[0].gram, 7350);

  // Verify employee sees ONLY their own submissions (including rejection reason)
  const workerList = await (await send('/api/pending-approvals', emp1Login.token)).json();
  assert.equal(workerList.items.length, 3);
  assert.equal(workerList.items.find(i => i.id === 'sub-bilezik-rej').rejectionReason, 'Gramaj hatalı girilmiş');
  assert.equal(workerList.analytics, undefined, 'Employee must never see store analytics');

  // Verify Journal attribution (submittedBy + approving owner + wasEdited) & replay parity
  const journal = await (await send('/api/journal?scope=all', owner.token)).json();
  const j1 = journal.items.find(e => e.id === 'approve-sub-kunye-14');
  assert.equal(j1.actor.name, 'Yönetici Hasan');
  assert.equal(j1.actor.submittedBy.name, 'Kasiyer Ayşe');
  assert.equal(Boolean(j1.actor.wasEdited), false);

  const j2 = journal.items.find(e => e.id === 'approve-sub-sahmeran-22');
  assert.equal(j2.actor.name, 'Yönetici Hasan');
  assert.equal(j2.actor.submittedBy.name, 'Kasiyer Ayşe');
  assert.equal(j2.actor.wasEdited, true);

  const repo = repositories.get('demo');
  const replayed = replay(repo.backup().events);
  assert.deepEqual(replayed.balances, repo.state().balances);
});
