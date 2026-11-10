import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../server.mjs';
import { authenticateTestOwner, ownerFetch as fetch } from '../test-support/editor-session.mjs';

test('HTTP: workspace separation, origin/host checks, atomic invalid commands and JSON errors', async () => {
  const dataDirectory = mkdtempSync(path.join(os.tmpdir(), 'kuyumcu-http-'));
  const { server } = createApp({ dataDirectory });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await authenticateTestOwner(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let response = await fetch(`${base}/api/state?workspace=demo`);
    const initial = await response.json();
    assert.equal(initial.revision, 0);
    const balances = Object.fromEntries(initial.accounts.filter(a => !a.retired).map(a => [a.id, '0'])); balances.nakit = '100';
    const send = (workspace, data, headers = {}) => fetch(`${base}/api/command?workspace=${workspace}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof data === 'string' ? data : JSON.stringify(data) });
    response = await send('demo', { id: 'opening-http', revision: 0, command: { type: 'opening', date: '2026-10-27', balances } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).state.balances.nakit, 10000);
    assert.equal((await (await fetch(`${base}/api/state?workspace=dukkan`)).json()).initialized, false);
    assert.equal((await send('demo', {}, { Origin: 'https://other.example' })).status, 403);
    const wrongHostStatus = await new Promise((resolve, reject) => {
      const request = http.get(`${base}/api/state`, { headers: { Host: 'evil.example' } }, r => { r.resume(); resolve(r.statusCode); });
      request.on('error', reject);
    });
    assert.equal(wrongHostStatus, 403);
    assert.equal((await send('other', {})).status, 400);
    assert.equal((await send('demo', '{')).status, 400);
    response = await send('demo', { id: 'stale', revision: 0, command: { type: 'movement', date: '2026-10-27', accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '1', note: 'Test' } });
    assert.equal(response.status, 409);
    response = await fetch(`${base}/api/backup?workspace=demo`);
    assert.match(response.headers.get('content-disposition'), /attachment/);
    const backup = await response.json();
    assert.equal(backup.events.length, 1);
    const state = await (await fetch(`${base}/api/state?workspace=demo`)).json();
    const close = { type: 'close', date: state.date, approvedBy: 'HTTP test', counts: Object.fromEntries(state.accounts.filter(a => a.physical && !a.retired && a.countPolicy === 'daily').map(a => [a.id, a.id === 'nakit' ? '100' : '0'])), reasons: {} };
    response = await send('demo', { id: 'closing-http', revision: state.revision, command: close });
    const closed = await response.json();
    assert.equal(closed.state.date, '2026-10-28');
    assert.equal(closed.backupStatus.saved, true);
    const backupDirectory = path.join(dataDirectory, 'backups', 'demo');
    assert.equal(readdirSync(backupDirectory).length, 1);
    const automaticBackup = JSON.parse(readFileSync(path.join(backupDirectory, closed.backupStatus.filename), 'utf8'));
    assert.equal(automaticBackup.events.length, 2);
    assert.equal(automaticBackup.workspace, 'demo');
    assert.equal((await fetch(`${base}/repository.mjs`)).status, 404);
    assert.equal((await fetch(`${base}/data/demo.sqlite`)).status, 404);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test('a backup write failure reports closing success and backup failure separately', async () => {
  const dataDirectory = mkdtempSync(path.join(os.tmpdir(), 'kuyumcu-backup-fail-'));
  const { server } = createApp({ dataDirectory });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await authenticateTestOwner(server);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const send = body => fetch(`${base}/command?workspace=demo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const initial = await (await fetch(`${base}/state?workspace=demo`)).json();
    const balances = Object.fromEntries(initial.accounts.filter(a => !a.retired).map(a => [a.id, '0']));
    await send({ id: 'open-backup-fail', revision: 0, command: { type: 'opening', date: '2026-10-27', balances } });
    writeFileSync(path.join(dataDirectory, 'backups'), 'This file deliberately prevents directory creation.');
    const response = await send({ id: 'close-backup-fail', revision: 1, command: { type: 'close', date: '2026-10-27', counts: Object.fromEntries(initial.accounts.filter(a => a.physical && !a.retired && a.countPolicy === 'daily').map(a => [a.id, '0'])), reasons: {}, approvedBy: 'Test' } });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.backupStatus.saved, false);
    assert.equal(result.state.date, '2026-10-28');
    assert.equal((await (await fetch(`${base}/state?workspace=demo`)).json()).date, '2026-10-28');
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});
