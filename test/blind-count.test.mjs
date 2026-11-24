import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { replay } from '../domain.mjs';

async function fixture(t) {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'blind-count-'));
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

test('Private weight pools (bilezik22, taki14, taki22) are hidden from employee checkout and blind count enforces strict privacy and owner review', async t => {
  const { send, repositories } = await fixture(t);
  const owner = await (await send('/api/auth/setup', null, { name: 'Yönetici', pin: '112233' })).json();
  const emp = await (await send('/api/auth/employees', owner.token, { name: 'Kasiyer', pin: '445566' })).json();
  const empLogin = await (await send('/api/auth/login', null, { id: emp.id, pin: '445566' })).json();
  assert.equal((await send('/api/auth/change-pin', empLogin.token, { currentPin: '445566', newPin: '778899' })).status, 200);

  const init = await (await send('/api/state', owner.token)).json();
  const date = '2026-11-24';
  const balances = Object.fromEntries(init.accounts.filter(a => !a.retired).map(a => [a.id, ({
    nakit: '500000', bilezik22: '1500', taki14: '800', taki22: '950',
    bilezikAdet: '25', kunye: '12', ceyrek: '30', gramToplam: '100', hurda22: '45.5'
  })[a.id] || '0']));
  assert.equal((await send('/api/command', owner.token, { id: 'open-bc', revision: 0, command: { type: 'opening', date, balances } })).status, 200);

  // 1. Employee GET /api/checkout hides bilezik22, taki14, taki22 from stocks AND products[].weights
  const workerCheckout = await (await send('/api/checkout', empLogin.token)).json();
  const stockIds = new Set(workerCheckout.stocks.map(s => s.id));
  for (const hidden of ['bilezik22', 'taki14', 'taki22']) {
    assert.equal(stockIds.has(hidden), false, `${hidden} must NOT appear in employee stocks`);
  }
  const kunyeProd = workerCheckout.products.find(p => p.id === 'kunye');
  assert.equal(kunyeProd.weights.length, 2);
  for (const w of kunyeProd.weights) {
    assert.deepEqual(Object.keys(w).sort(), ['id', 'name'], 'Weight pool quantities must be hidden from employee');
  }

  // countItems contains products, sarrafiye, gram, hurda with ZERO expected/quantity fields
  assert.ok(workerCheckout.countItems.some(c => c.id === 'kunye' && c.group === 'urun'));
  assert.ok(workerCheckout.countItems.some(c => c.id === 'ceyrek' && c.group === 'sarrafiye'));
  assert.ok(workerCheckout.countItems.some(c => c.id === 'gramToplam' && c.group === 'gram'));
  assert.ok(workerCheckout.countItems.some(c => c.id === 'hurda22' && c.group === 'hurda'));
  for (const item of workerCheckout.countItems) {
    assert.equal(Object.hasOwn(item, 'quantity'), false);
    assert.equal(Object.hasOwn(item, 'expected'), false);
    assert.equal(['bilezik22', 'taki14', 'taki22', 'nakit', 'banka'].includes(item.id), false);
  }

  // 2. Employee trying to count private pool or cash MUST fail 403
  for (const forbidden of ['bilezik22', 'taki14', 'taki22', 'nakit']) {
    const bad = await send('/api/pending-approvals', empLogin.token, {
      id: `bad-${forbidden}`,
      command: { type: 'dailyCount', date, counts: { [forbidden]: '10' }, reasons: {} }
    });
    assert.equal(bad.status, 403, `${forbidden} must be rejected 403`);
  }

  // 3. Employee submits valid Blind Count (ceyrek: 29 instead of 30 with reason; kunye: 12 exact; hurda22: 45.5 exact)
  const submitRes = await send('/api/pending-approvals', empLogin.token, {
    id: 'bc-1',
    command: {
      type: 'dailyCount',
      date,
      counts: { ceyrek: '29', kunye: '12', hurda22: '45.5', gramToplam: '100' },
      reasons: { ceyrek: '1 adet vitrin arkasında kontrol edilecek' },
      note: 'Akşam vardiya sayımı'
    }
  });
  assert.equal(submitRes.status, 201);
  const submitBody = await submitRes.json();
  assert.equal(submitBody.status, 'pending');
  assert.equal(submitBody.comparison, undefined, 'Employee response must never leak expected/comparison');

  // Stock balances remain untouched; closing is blocked while count is pending
  let st = await (await send('/api/state?view=compact', owner.token)).json();
  assert.equal(st.balances.ceyrek, 30);
  assert.equal(st.pendingApprovalCount, 1);

  // Employee GET /api/pending-approvals NEVER leaks comparison/expected
  const workerList = await (await send('/api/pending-approvals', empLogin.token)).json();
  assert.equal(workerList.items.length, 1);
  assert.equal(workerList.items[0].comparison, undefined);

  // 4. Owner GET /api/pending-approvals sees full Expected vs Counted vs Difference
  const ownerList = await (await send('/api/pending-approvals?status=pending&type=dailyCount', owner.token)).json();
  assert.equal(ownerList.items.length, 1);
  const comp = ownerList.items[0].comparison;
  assert.equal(comp.diffCount, 1);
  assert.equal(comp.matchCount, 3);
  const ceyrekRow = comp.rows.find(r => r.accountId === 'ceyrek');
  assert.equal(ceyrekRow.expected, 30);
  assert.equal(ceyrekRow.counted, 29);
  assert.equal(ceyrekRow.difference, -1);
  assert.equal(ceyrekRow.reason, '1 adet vitrin arkasında kontrol edilecek');

  // 5. Owner approves Blind Count standalone (day remains open, returns counts/reasons for optional Closing prefill)
  const appr = await send('/api/pending-approvals/approve', owner.token, { id: 'bc-1', revision: st.revision });
  assert.equal(appr.status, 200);
  const apprBody = await appr.json();
  assert.equal(apprBody.type, 'dailyCount');
  assert.equal(apprBody.counts.ceyrek, '29');
  assert.equal(apprBody.reasons.ceyrek, '1 adet vitrin arkasında kontrol edilecek');
  assert.equal(apprBody.state.pendingApprovalCount, 0);
  assert.equal(apprBody.state.date, date, 'Approving blind count standalone must NOT close the day');

  // 6. Second Blind Count rejected by Owner -> employee sees rejection reason
  assert.equal((await send('/api/pending-approvals', empLogin.token, {
    id: 'bc-2',
    command: { type: 'dailyCount', date, counts: { kunye: '10' }, reasons: {} }
  })).status, 201);
  assert.equal((await send('/api/pending-approvals/reject', owner.token, { id: 'bc-2', reason: 'Künye tepsisini tekrar sayın' })).status, 200);
  const workerAfterRej = await (await send('/api/pending-approvals', empLogin.token)).json();
  assert.equal(workerAfterRej.items.find(i => i.id === 'bc-2').rejectionReason, 'Künye tepsisini tekrar sayın');

  // Replay parity: pending_submissions never pollutes financial events
  const repo = repositories.get('demo');
  assert.deepEqual(replay(repo.backup().events).balances, repo.state().balances);
});
