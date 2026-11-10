import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server.mjs';
import { authenticateTestOwner, ownerFetch as fetch } from '../test-support/editor-session.mjs';

test('HTTP summary exposes historical original-unit equations without changing records', async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'defter-summary-api-'));
  const { server } = createApp({ dataDirectory });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await authenticateTestOwner(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const state = await (await fetch(`${base}/api/state?workspace=demo`)).json();
    const opening = { type: 'opening', date: '2026-10-27', balances: Object.fromEntries(state.accounts.filter(a => !a.retired).map(a => [a.id, a.id === 'nakit' ? '20000' : '0'])) };
    const response = await fetch(`${base}/api/command?workspace=demo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'summary-opening', revision: state.revision, command: opening }) });
    assert.equal(response.status, 200);
    const summaryResponse = await fetch(`${base}/api/summary?workspace=demo&date=2026-10-27`);
    assert.equal(summaryResponse.status, 200);
    const summary = await summaryResponse.json();
    assert.deepEqual(summary.totals, { sales: 0, purchases: 0 });
    assert.deepEqual(summary.accounts.find(a => a.accountId === 'nakit'), { accountId: 'nakit', unit: 'TL', opening: 2000000, incoming: 0, outgoing: 0, adjustment: 0, closing: 2000000 });
    for (const date of ['2026-02-31', '2026-10-28', '2026-10-26']) assert.equal((await fetch(`${base}/api/summary?workspace=demo&date=${date}`)).status, 400);
    assert.equal((await fetch(`${base}/api/summary?workspace=dukkan`)).status, 400);
    const after = await (await fetch(`${base}/api/state?workspace=demo`)).json();
    assert.equal(after.revision, 1); assert.equal(after.journal.length, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});
