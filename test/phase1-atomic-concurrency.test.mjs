import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.mjs';
import { Repository } from '../repository.mjs';
import { ReportRepository } from '../report-repository.mjs';
import { INITIAL_ACCOUNTS, decimal, replay } from '../domain.mjs';

const OWNER_ACTOR = { id: 'c8d7225e-5535-49ed-b37f-5f6d0e7d09ef', name: 'Yönetici Hasan', role: 'owner' };
const EMP_ACTOR = { id: '2f22c871-903a-4b4e-8f4d-3496a68d7001', name: 'Kasiyer Ayşe', role: 'employee' };
const DATE = '2026-11-24';

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function removeTempDir(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

function openingBalances(overrides = {}) {
  return Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, overrides[a.id] ?? '0']));
}

function seedDirectRepo(dbPath) {
  const repo = new Repository(dbPath, 'demo');
  repo.execute({
    id: 'open-1',
    revision: 0,
    command: {
      type: 'opening',
      date: DATE,
      balances: openingBalances({ nakit: '100000', kunye: '10', taki14: '100', yuzuk: '2', bilezikAdet: '5', bilezik22: '100', ceyrek: '20' })
    }
  }, { actor: OWNER_ACTOR });
  repo.execute({
    id: 'cust-1',
    revision: 1,
    command: { type: 'account', date: DATE, name: 'Müşteri Fatma', unit: 'TL', partyType: 'customer', opening: '0' }
  }, { actor: EMP_ACTOR });
  return repo;
}

async function httpFixture(t, prefix) {
  const dataDirectory = makeTempDir(prefix);
  const { server, repositories } = createApp({ dataDirectory, logger: () => {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    for (const repo of repositories.values()) {
      try { repo.close(); } catch {}
    }
    removeTempDir(dataDirectory);
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const send = (path, token, body) => {
    const headers = token ? { Authorization: 'Bearer ' + token } : {};
    return fetch(base + path, body === undefined ? { headers } : {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
  };
  return { dataDirectory, send, repositories };
}

test('Faz 1-B: Repository and ReportRepository enforce WAL, FULL, trusted_schema=OFF, and busy_timeout=3000', t => {
  const dir = makeTempDir('p1-pragma-');
  const dbPath = join(dir, 'demo.sqlite');
  const repo = seedDirectRepo(dbPath);
  const reportRepo = new ReportRepository(dbPath, 'demo');
  t.after(() => {
    try { reportRepo.close(); } catch {}
    try { repo.close(); } catch {}
    removeTempDir(dir);
  });

  assert.equal(repo.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(repo.db.prepare('PRAGMA synchronous').get().synchronous, 2);
  assert.equal(repo.db.prepare('PRAGMA busy_timeout').get().timeout ?? repo.db.prepare('PRAGMA busy_timeout').get().busy_timeout, 3000);
  assert.equal(repo.db.prepare('PRAGMA trusted_schema').get().trusted_schema, 0);

  assert.equal(reportRepo.db.prepare('PRAGMA query_only').get().query_only, 1);
  assert.equal(reportRepo.db.prepare('PRAGMA busy_timeout').get().timeout ?? reportRepo.db.prepare('PRAGMA busy_timeout').get().busy_timeout, 3000);
  assert.equal(reportRepo.db.prepare('PRAGMA trusted_schema').get().trusted_schema, 0);
});

test('Faz 1-A: real subprocess SIGKILL mid-approvePending leaves zero partial commits and clean recovery', async t => {
  const dir = makeTempDir('p1-sigkill-');
  const dbPath = join(dir, 'demo.sqlite');
  let reopened;
  t.after(() => {
    try { reopened?.close(); } catch {}
    removeTempDir(dir);
  });

  const setupRepo = seedDirectRepo(dbPath);
  const saleCmd = {
    type: 'sale',
    date: DATE,
    counterpartyType: 'customer',
    counterpartyId: 'cari-cust-1',
    items: [{ accountId: 'kunye', quantity: '1', weightAccount: 'taki14', weight: '6.5', value: '30000' }],
    received: [{ accountId: 'nakit', quantity: '30000', valueTL: '30000' }],
    given: []
  };
  setupRepo.submitPending({ id: 'sub-crash-1', revision: 2, command: saleCmd }, { actor: EMP_ACTOR });
  setupRepo.close();

  const repoModuleUrl = pathToFileURL(join(process.cwd(), 'repository.mjs')).href;
  const childScript = `
    import { Repository } from ${JSON.stringify(repoModuleUrl)};
    const repo = new Repository(process.env.TEST_DB_PATH, 'demo');
    const origPrepare = repo.db.prepare.bind(repo.db);
    let armed = true;
    repo.db.prepare = (sql) => {
      const stmt = origPrepare(sql);
      if (armed && String(sql).includes('UPDATE pending_submissions')) {
        armed = false;
        const origRun = stmt.run.bind(stmt);
        stmt.run = (...args) => {
          const ev = origPrepare("SELECT id FROM events WHERE id = 'approve-sub-crash-1'").get();
          const rev = origPrepare('SELECT revision FROM meta WHERE id = 1').get()?.revision;
          if (!repo.db.isTransaction || !ev || rev !== 3) {
            process.stderr.write('UNEXPECTED_TX_STATE\\n');
            process.exit(2);
          }
          process.stdout.write('READY_FOR_SIGKILL\\n');
          process.kill(process.pid, 'SIGKILL');
          return origRun(...args);
        };
      }
      return stmt;
    };
    repo.approvePending(
      { id: 'sub-crash-1', revision: 2, actor: ${JSON.stringify(OWNER_ACTOR)} },
      { compact: false }
    );
  `;

  const childRes = await new Promise(resolve => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
      env: { ...process.env, TEST_DB_PATH: dbPath },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });

  assert.match(childRes.stdout, /READY_FOR_SIGKILL/, `stderr=${childRes.stderr}`);
  assert.ok(childRes.signal === 'SIGKILL' || childRes.code !== 0, 'Child must terminate via SIGKILL before COMMIT');

  reopened = new Repository(dbPath, 'demo');

  const events = reopened.events();
  assert.equal(events.some(e => e.id === 'approve-sub-crash-1'), false, 'Uncommitted approve event must be rolled back');
  const pendingRow = reopened.db.prepare('SELECT status, approved_event_id FROM pending_submissions WHERE id = ?').get('sub-crash-1');
  assert.equal(pendingRow.status, 'pending');
  assert.equal(pendingRow.approved_event_id, null);
  assert.equal(reopened.pendingCount(), 1);

  const stBefore = reopened.state();
  assert.equal(stBefore.revision, 2);
  assert.equal(stBefore.balances.taki14, 100000);
  assert.equal(stBefore.balances.nakit, 10000000);
  assert.deepEqual(replay(events).balances, stBefore.balances);

  // Subsequent approval on reopened DB succeeds cleanly
  const approved = reopened.approvePending({ id: 'sub-crash-1', revision: 2, actor: OWNER_ACTOR });
  assert.equal(approved.duplicate, false);
  assert.equal(approved.state.revision, 3);
  assert.equal(approved.state.balances.taki14, 93500);
  assert.equal(approved.state.balances.nakit, 13000000);
  assert.equal(reopened.pendingCount(), 0);
});

test('Faz 1-A: in-process ROLLBACK clears Repository #cache and prevents stale in-memory state', t => {
  const dir = makeTempDir('p1-rollback-');
  const dbPath = join(dir, 'demo.sqlite');
  const repo = seedDirectRepo(dbPath);
  t.after(() => {
    try { repo.close(); } catch {}
    removeTempDir(dir);
  });

  // Warm cache
  const initialState = repo.state();
  assert.equal(initialState.revision, 2);

  const saleCmd = {
    type: 'sale',
    date: DATE,
    counterpartyType: 'customer',
    counterpartyId: 'cari-cust-1',
    items: [{ accountId: 'kunye', quantity: '1', weightAccount: 'taki14', weight: '5', value: '20000' }],
    received: [{ accountId: 'nakit', quantity: '20000', valueTL: '20000' }],
    given: []
  };
  repo.submitPending({ id: 'sub-rb-1', revision: 2, command: saleCmd }, { actor: EMP_ACTOR });
  // Ensure cache is warm right before failing approval
  assert.equal(repo.state().revision, 2);

  repo.db.exec(`
    CREATE TRIGGER test_abort_pending_update
    BEFORE UPDATE ON pending_submissions
    BEGIN
      SELECT RAISE(ABORT, 'simulated_ps_update_failure');
    END;
  `);

  assert.throws(
    () => repo.approvePending({ id: 'sub-rb-1', revision: 2, actor: OWNER_ACTOR }),
    /simulated_ps_update_failure/
  );
  assert.equal(repo.db.isTransaction, false, 'Transaction must be rolled back');

  repo.db.exec('DROP TRIGGER test_abort_pending_update;');

  // Same Repository instance must return clean pre-rollback state (not mutated in-memory cache)
  const afterRollback = repo.state();
  assert.equal(afterRollback.revision, 2);
  assert.equal(afterRollback.balances.taki14, 100000);
  assert.equal(afterRollback.balances.nakit, 10000000);
  assert.equal(repo.events().some(e => e.id === 'approve-sub-rb-1'), false);
  assert.equal(repo.pendingCount(), 1);

  // Subsequent approval succeeds
  const ok = repo.approvePending({ id: 'sub-rb-1', revision: 2, actor: OWNER_ACTOR });
  assert.equal(ok.duplicate, false);
  assert.equal(ok.state.revision, 3);
  assert.equal(ok.state.balances.taki14, 95000);
});

test('Faz 1-A: post-commit idempotent re-approval for trade and dailyCount does not duplicate events or advance revision', t => {
  const dir = makeTempDir('p1-idemp-');
  const repo = seedDirectRepo(join(dir, 'demo.sqlite'));
  t.after(() => {
    try { repo.close(); } catch {}
    removeTempDir(dir);
  });

  const saleCmd = {
    type: 'sale',
    date: DATE,
    counterpartyType: 'customer',
    counterpartyId: 'cari-cust-1',
    items: [{ accountId: 'kunye', quantity: '1', weightAccount: 'taki14', weight: '4', value: '18000' }],
    received: [{ accountId: 'nakit', quantity: '18000', valueTL: '18000' }],
    given: []
  };
  repo.submitPending({ id: 'sub-idemp-1', revision: 2, command: saleCmd }, { actor: EMP_ACTOR });
  const first = repo.approvePending({ id: 'sub-idemp-1', revision: 2, actor: OWNER_ACTOR });
  assert.equal(first.duplicate, false);
  assert.equal(first.state.revision, 3);

  const second = repo.approvePending({ id: 'sub-idemp-1', revision: 2, actor: OWNER_ACTOR });
  assert.equal(second.duplicate, true);
  assert.equal(second.approvedEventId, 'approve-sub-idemp-1');
  assert.equal(second.state.revision, 3);
  assert.equal(repo.events().filter(e => e.id === 'approve-sub-idemp-1').length, 1);

  repo.submitPending({
    id: 'sub-dc-1',
    revision: 3,
    command: { type: 'dailyCount', date: DATE, counts: { ceyrek: '20' }, reasons: {} }
  }, { actor: EMP_ACTOR });
  const dc1 = repo.approvePending({ id: 'sub-dc-1', revision: 3, actor: OWNER_ACTOR });
  assert.equal(dc1.duplicate, false);
  assert.equal(dc1.type, 'dailyCount');
  const dc2 = repo.approvePending({ id: 'sub-dc-1', revision: 3, actor: OWNER_ACTOR });
  assert.equal(dc2.duplicate, true);
  assert.equal(dc2.state.revision, 3);
  assert.equal(repo.pendingCount(), 0);
});

test('Faz 1-A: parallel double approval and approve-vs-reject race serialize cleanly', async t => {
  const { send, repositories } = await httpFixture(t, 'p1-dbl-');
  const owner = await (await send('/api/auth/setup', null, { name: 'Yönetici', pin: '112233' })).json();
  const emp = await (await send('/api/auth/employees', owner.token, { name: 'Kasiyer', pin: '445566' })).json();
  const empLogin = await (await send('/api/auth/login', null, { id: emp.id, pin: '445566' })).json();
  await send('/api/auth/change-pin', empLogin.token, { currentPin: '445566', newPin: '778899' });

  await send('/api/command', owner.token, {
    id: 'open-dbl',
    revision: 0,
    command: { type: 'opening', date: DATE, balances: openingBalances({ nakit: '50000', kunye: '10', taki14: '50' }) }
  });
  await send('/api/command', empLogin.token, {
    id: 'cust-dbl',
    revision: 1,
    command: { type: 'account', date: DATE, name: 'Müşteri A', unit: 'TL', partyType: 'customer', opening: '0' }
  });

  const saleCmd = {
    type: 'sale',
    date: DATE,
    counterpartyType: 'customer',
    counterpartyId: 'cari-cust-dbl',
    items: [{ accountId: 'kunye', quantity: '1', weightAccount: 'taki14', weight: '5', value: '25000' }],
    received: [{ accountId: 'nakit', quantity: '25000', valueTL: '25000' }],
    given: []
  };
  assert.equal((await send('/api/pending-approvals', empLogin.token, { id: 'sub-dbl-1', command: saleCmd })).status, 201);

  const [r1, r2] = await Promise.all([
    send('/api/pending-approvals/approve', owner.token, { id: 'sub-dbl-1', revision: 2 }),
    send('/api/pending-approvals/approve', owner.token, { id: 'sub-dbl-1', revision: 2 })
  ]);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  const [b1, b2] = await Promise.all([r1.json(), r2.json()]);
  assert.deepEqual([b1.duplicate, b2.duplicate].sort(), [false, true]);
  const repo = repositories.get('demo');
  assert.equal(repo.events().filter(e => e.id === 'approve-sub-dbl-1').length, 1);
  assert.equal(repo.state().revision, 3);
  assert.equal(repo.state().balances.taki14, 45000);

  // Approve vs Reject race on sub-race-1
  assert.equal((await send('/api/pending-approvals', empLogin.token, { id: 'sub-race-1', command: saleCmd })).status, 201);
  const [apRes, rjRes] = await Promise.all([
    send('/api/pending-approvals/approve', owner.token, { id: 'sub-race-1', revision: 3 }),
    send('/api/pending-approvals/reject', owner.token, { id: 'sub-race-1', reason: 'Eşzamanlı iptal' })
  ]);
  const statuses = [apRes.status, rjRes.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 409]);
  assert.equal(repo.pendingCount(), 0);
  assert.deepEqual(replay(repo.events()).balances, repo.state().balances);
});

test('Faz 1-A: concurrent sales of same inventoryCode item and pooled stock allow only one winner and never go negative', async t => {
  const { send, repositories } = await httpFixture(t, 'p1-inv-');
  const owner = await (await send('/api/auth/setup', null, { name: 'Yönetici', pin: '112233' })).json();
  const emp = await (await send('/api/auth/employees', owner.token, { name: 'Kasiyer', pin: '445566' })).json();
  const empLogin = await (await send('/api/auth/login', null, { id: emp.id, pin: '445566' })).json();
  await send('/api/auth/change-pin', empLogin.token, { currentPin: '445566', newPin: '778899' });

  await send('/api/command', owner.token, {
    id: 'open-inv',
    revision: 0,
    command: { type: 'opening', date: DATE, balances: openingBalances({ nakit: '50000', yuzuk: '1', kunye: '2', taki14: '8.25' }) }
  });
  await send('/api/command', owner.token, {
    id: 'reg-yz-01',
    revision: 1,
    command: { type: 'registerItem', date: DATE, code: 'YZ-01', barcode: '1001', accountId: 'yuzuk', weightAccount: 'taki14', actualWeight: '3.25', description: 'Tekil yüzük' }
  });
  await send('/api/command', empLogin.token, {
    id: 'cust-inv',
    revision: 2,
    command: { type: 'account', date: DATE, name: 'Müşteri B', unit: 'TL', partyType: 'customer', opening: '0' }
  });

  // 1. Concurrent inventoryCode sales (YZ-01)
  const itemSale = {
    type: 'sale', date: DATE, counterpartyType: 'customer', counterpartyId: 'cari-cust-inv',
    items: [{ accountId: 'yuzuk', quantity: '1', weightAccount: 'taki14', weight: '3.25', inventoryCode: 'YZ-01', value: '15000' }],
    received: [{ accountId: 'nakit', quantity: '15000', valueTL: '15000' }], given: []
  };
  assert.equal((await send('/api/pending-approvals', empLogin.token, { id: 'sub-item-a', command: itemSale })).status, 201);
  assert.equal((await send('/api/pending-approvals', empLogin.token, { id: 'sub-item-b', command: itemSale })).status, 201);

  const [itemR1, itemR2] = await Promise.all([
    send('/api/pending-approvals/approve', owner.token, { id: 'sub-item-a', revision: 3 }),
    send('/api/pending-approvals/approve', owner.token, { id: 'sub-item-b', revision: 3 })
  ]);
  assert.deepEqual([itemR1.status, itemR2.status].sort((a, b) => a - b), [200, 409]);

  const loserItemId = itemR1.status === 409 ? 'sub-item-a' : 'sub-item-b';
  const retryItem = await send('/api/pending-approvals/approve', owner.token, { id: loserItemId, revision: 4 });
  assert.equal(retryItem.status, 400, 'Retrying second sale of already-sold inventoryCode must fail');

  const repo = repositories.get('demo');
  let st = repo.state();
  assert.equal(st.balances.yuzuk, 0);
  assert.equal(st.balances.taki14, 5000);
  assert.equal(st.inventoryItems[0].status, 'sold');

  // 2. Concurrent pooled stock sales (each wants 4g of remaining 5g taki14)
  const poolSale = {
    type: 'sale', date: DATE, counterpartyType: 'customer', counterpartyId: 'cari-cust-inv',
    items: [{ accountId: 'kunye', quantity: '1', weightAccount: 'taki14', weight: '4', value: '18000' }],
    received: [{ accountId: 'nakit', quantity: '18000', valueTL: '18000' }], given: []
  };
  assert.equal((await send('/api/pending-approvals', empLogin.token, { id: 'sub-pool-a', command: poolSale })).status, 201);
  assert.equal((await send('/api/pending-approvals', empLogin.token, { id: 'sub-pool-b', command: poolSale })).status, 201);

  const [poolR1, poolR2] = await Promise.all([
    send('/api/pending-approvals/approve', owner.token, { id: 'sub-pool-a', revision: 4 }),
    send('/api/pending-approvals/approve', owner.token, { id: 'sub-pool-b', revision: 4 })
  ]);
  assert.deepEqual([poolR1.status, poolR2.status].sort((a, b) => a - b), [200, 409]);

  const loserPoolId = poolR1.status === 409 ? 'sub-pool-a' : 'sub-pool-b';
  const retryPool = await send('/api/pending-approvals/approve', owner.token, { id: loserPoolId, revision: 5 });
  assert.equal(retryPool.status, 400, 'Retrying pooled sale exceeding remaining stock must fail');

  st = repo.state();
  assert.equal(st.balances.taki14, 1000);
  assert.equal(st.balances.kunye, 1);
  for (const acc of st.accounts) {
    if (acc.kind === 'asset') assert.ok((st.balances[acc.id] || 0) >= 0, `${acc.id} must remain non-negative`);
  }
  assert.deepEqual(replay(repo.events()).balances, st.balances);
});

async function runConcurrentUsersScenario(t, employeeCount) {
  const { send, repositories } = await httpFixture(t, `p1-users-${employeeCount + 1}-`);
  const owner = await (await send('/api/auth/setup', null, { name: 'Yönetici', pin: '112233' })).json();
  const employees = [];
  for (let i = 1; i <= employeeCount; i++) {
    const emp = await (await send('/api/auth/employees', owner.token, { name: `Kasiyer ${i}`, pin: `10000${i}` })).json();
    const login = await (await send('/api/auth/login', null, { id: emp.id, pin: `10000${i}` })).json();
    assert.equal((await send('/api/auth/change-pin', login.token, { currentPin: `10000${i}`, newPin: `20000${i}` })).status, 200);
    employees.push(login);
  }

  assert.equal((await send('/api/command', owner.token, {
    id: 'open-conc',
    revision: 0,
    command: { type: 'opening', date: DATE, balances: openingBalances({ nakit: '500000', kunye: '100', taki14: '1000', ceyrek: '50' }) }
  })).status, 200);

  // Explicit 409 REVISION_CONFLICT test: two concurrent owner commands at revision 1
  const [c1, c2] = await Promise.all([
    send('/api/command', owner.token, {
      id: 'race-rev-1', revision: 1,
      command: { type: 'movement', date: DATE, accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '100', note: 'Yarış 1' }
    }),
    send('/api/command', owner.token, {
      id: 'race-rev-2', revision: 1,
      command: { type: 'movement', date: DATE, accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '200', note: 'Yarış 2' }
    })
  ]);
  const revStatuses = [c1.status, c2.status].sort((a, b) => a - b);
  assert.deepEqual(revStatuses, [200, 409]);
  const conflictBody = await (c1.status === 409 ? c1 : c2).json();
  assert.match(conflictBody.error, /başka sekmede değişti/);
  // Also verify DomainError.code === 'REVISION_CONFLICT' directly at repository boundary
  const directRepo = repositories.get('demo');
  assert.throws(
    () => directRepo.execute({
      id: 'direct-rev-conflict',
      revision: 1,
      command: { type: 'movement', date: DATE, accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '1', note: 'Çakışma' }
    }, { actor: OWNER_ACTOR }),
    err => err.status === 409 && err.code === 'REVISION_CONFLICT'
  );

  // Seed one customer per employee sequentially (or via conflict-aware retry) then mix concurrent submissions, reads, and owner approvals
  const customerIds = [];
  for (let i = 0; i < employees.length; i++) {
    const st = await (await send('/api/state?view=compact', owner.token)).json();
    const cid = `cust-u-${i + 1}`;
    const res = await send('/api/command', employees[i].token, {
      id: cid,
      revision: st.revision,
      command: { type: 'account', date: DATE, name: `Müşteri ${i + 1}`, unit: 'TL', partyType: 'customer', opening: '0' }
    });
    assert.equal(res.status, 200);
    customerIds.push(`cari-${cid}`);
  }

  // Concurrent employee submissions + concurrent reads + concurrent owner state/pending reads
  const submissionTasks = employees.map((emp, idx) => send('/api/pending-approvals', emp.token, {
    id: `sub-u-${idx + 1}`,
    command: {
      type: 'sale',
      date: DATE,
      counterpartyType: 'customer',
      counterpartyId: customerIds[idx],
      items: [{ accountId: 'kunye', quantity: '1', weightAccount: 'taki14', weight: '5', value: '20000' }],
      received: [{ accountId: 'nakit', quantity: '20000', valueTL: '20000' }],
      given: []
    }
  }));
  const readTasks = employees.map(emp => send('/api/checkout', emp.token));
  const ownerReads = [send('/api/state?view=compact', owner.token), send('/api/pending-approvals', owner.token), send('/api/journal?scope=today', owner.token)];
  const wave1 = await Promise.all([...submissionTasks, ...readTasks, ...ownerReads]);
  for (const res of wave1) {
    assert.ok(res.status < 500, `Unexpected 5xx status ${res.status}`);
  }

  // Concurrent wave of extra customer creations (testing 409 serialization) + pending submissions + owner approvals + reads
  const wave2 = await Promise.all([
    ...employees.map((emp, idx) => send('/api/pending-approvals', emp.token, {
      id: `sub-u2-${idx + 1}`,
      command: { type: 'dailyCount', date: DATE, counts: { ceyrek: '50' }, reasons: {} }
    })),
    ...employees.map(emp => send('/api/pending-approvals', emp.token)),
    send('/api/state?view=compact', owner.token),
    send('/api/journal?scope=all', owner.token)
  ]);
  for (const res of wave2) {
    assert.ok(res.status < 500, `Unexpected 5xx status ${res.status}`);
  }

  // Owner approves all pending sales & dailyCounts using concurrent read+approve batches
  let pendingList = await (await send('/api/pending-approvals?status=pending', owner.token)).json();
  assert.equal(pendingList.items.length, employeeCount * 2);

  // Fire parallel approvals on the same revision to prove one wins cleanly and rest get 409 (no 500, no corruption)
  const stNow = await (await send('/api/state?view=compact', owner.token)).json();
  const saleItems = pendingList.items.filter(i => i.type === 'sale');
  const parallelAppr = await Promise.all(
    saleItems.map(item => send('/api/pending-approvals/approve', owner.token, { id: item.id, revision: stNow.revision }))
  );
  const okCount = parallelAppr.filter(r => r.status === 200).length;
  const conflictCount = parallelAppr.filter(r => r.status === 409).length;
  assert.equal(okCount, 1, 'Exactly one concurrent approval at same revision must win');
  assert.equal(conflictCount, saleItems.length - 1, 'Remaining concurrent approvals must fail cleanly with 409');

  // Approve remaining pending items sequentially with fresh revision
  pendingList = await (await send('/api/pending-approvals?status=pending', owner.token)).json();
  for (const item of pendingList.items) {
    const cur = await (await send('/api/state?view=compact', owner.token)).json();
    const ap = await send('/api/pending-approvals/approve', owner.token, { id: item.id, revision: cur.revision });
    assert.equal(ap.status, 200);
  }

  const repo = repositories.get('demo');
  const finalState = repo.state();
  assert.equal(repo.pendingCount(), 0);
  assert.equal(finalState.balances.kunye, 100 - employeeCount);
  assert.equal(finalState.balances.taki14, 1000000 - employeeCount * 5000);
  for (const acc of finalState.accounts) {
    if (acc.kind === 'asset') assert.ok((finalState.balances[acc.id] || 0) >= 0);
  }
  assert.deepEqual(replay(repo.events()).balances, finalState.balances);
}

test('Faz 1-A: 3 concurrent users (1 owner + 2 employees) with mixed operations and 409 conflict', t => runConcurrentUsersScenario(t, 2));
test('Faz 1-A: 7 concurrent users (1 owner + 6 employees) with mixed operations and 409 conflict', t => runConcurrentUsersScenario(t, 6));

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[idx].toFixed(2));
}

test('Faz 1-B: real SQLite lock contention across connections (writes + ReportRepository reads + VACUUM INTO backup) recovers within busy_timeout and enforces 3000ms SQLITE_BUSY', async t => {
  const dir = makeTempDir('p1-lock-');
  const dbPath = join(dir, 'demo.sqlite');
  const backupDir = join(dir, 'backups');
  let repoParent;
  let snapRepo;
  let lockerChild;
  t.after(async () => {
    try { snapRepo?.close(); } catch {}
    try { repoParent?.close(); } catch {}
    if (lockerChild && lockerChild.exitCode === null && lockerChild.signalCode === null) {
      await new Promise(resolve => lockerChild.once('close', resolve));
    }
    removeTempDir(dir);
  });
  const repo = seedDirectRepo(dbPath);
  repo.close();

  const repoUrl = pathToFileURL(join(process.cwd(), 'repository.mjs')).href;
  const reportRepoUrl = pathToFileURL(join(process.cwd(), 'report-repository.mjs')).href;

  // Launch 3 concurrent worker threads:
  // 1) Writer worker performing 12 sequential Repository.execute writes with short contention bursts
  // 2) Reader worker performing 20 ReportRepository overview/summary/journal queries concurrently
  // 3) Backup worker performing 6 VACUUM INTO backups concurrently
  const writerCode = `
    import { parentPort, workerData } from 'node:worker_threads';
    import { performance } from 'node:perf_hooks';
    import { Repository } from ${JSON.stringify(repoUrl)};
    const repo = new Repository(workerData.dbPath, 'demo');
    const latencies = [];
    try {
      for (let i = 0; i < 12; i++) {
        const t0 = performance.now();
        const rev = repo.state().revision;
        repo.execute({
          id: 'w-' + i,
          revision: rev,
          command: { type: 'movement', date: workerData.date, accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '10', note: 'Kilit testi ' + i }
        }, { actor: workerData.actor });
        latencies.push(performance.now() - t0);
      }
      parentPort.postMessage({ ok: true, latencies });
    } finally {
      repo.close();
    }
  `;

  const readerCode = `
    import { parentPort, workerData } from 'node:worker_threads';
    import { performance } from 'node:perf_hooks';
    import { ReportRepository } from ${JSON.stringify(reportRepoUrl)};
    const report = new ReportRepository(workerData.dbPath, 'demo');
    const latencies = [];
    try {
      for (let i = 0; i < 20; i++) {
        const t0 = performance.now();
        const ov = report.overview();
        report.summary(ov.date);
        report.journal({ limit: 10 });
        latencies.push(performance.now() - t0);
      }
      parentPort.postMessage({ ok: true, latencies });
    } finally {
      report.close();
    }
  `;

  const backupCode = `
    import { parentPort, workerData } from 'node:worker_threads';
    import { mkdirSync } from 'node:fs';
    import { join } from 'node:path';
    import { performance } from 'node:perf_hooks';
    import { DatabaseSync } from 'node:sqlite';
    mkdirSync(workerData.backupDir, { recursive: true });
    const db = new DatabaseSync(workerData.dbPath);
    db.exec('PRAGMA busy_timeout=3000;');
    const latencies = [];
    try {
      for (let i = 0; i < 6; i++) {
        const t0 = performance.now();
        const target = join(workerData.backupDir, 'snap-' + i + '.sqlite');
        db.prepare('VACUUM INTO ?').run(target);
        latencies.push(performance.now() - t0);
      }
      parentPort.postMessage({ ok: true, latencies });
    } finally {
      db.close();
    }
  `;

  const runWorker = (code, workerData) => new Promise((resolve, reject) => {
    const w = new Worker(code, { eval: true, workerData });
    let messageResult;
    let hasMessage = false;
    let exited = false;
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const maybeResolve = () => {
      if (hasMessage && exited) settle(resolve, messageResult);
    };
    w.on('message', msg => {
      messageResult = msg;
      hasMessage = true;
      maybeResolve();
    });
    w.on('error', err => settle(reject, err));
    w.on('exit', code => {
      if (code !== 0) {
        settle(reject, new Error(`Worker exited with ${code}`));
        return;
      }
      if (!hasMessage) {
        settle(reject, new Error('Worker exited with code 0 without sending a message'));
        return;
      }
      exited = true;
      maybeResolve();
    });
  });

  const [writeRes, readRes, backupRes] = await Promise.all([
    runWorker(writerCode, { dbPath, date: DATE, actor: OWNER_ACTOR }),
    runWorker(readerCode, { dbPath }),
    runWorker(backupCode, { dbPath, backupDir })
  ]);

  assert.equal(writeRes.ok, true);
  assert.equal(readRes.ok, true);
  assert.equal(backupRes.ok, true);

  for (let i = 0; i < 6; i++) {
    assert.equal(existsSync(join(backupDir, `snap-${i}.sqlite`)), true);
  }

  const summarize = arr => {
    const s = [...arr].sort((a, b) => a - b);
    return { count: s.length, p50Ms: percentile(s, 50), p95Ms: percentile(s, 95), maxMs: percentile(s, 100) };
  };
  const metrics = {
    writes: summarize(writeRes.latencies),
    reportReads: summarize(readRes.latencies),
    vacuumIntoBackups: summarize(backupRes.latencies)
  };
  t.diagnostic(`Lock contention latency metrics: ${JSON.stringify(metrics)}`);
  assert.ok(metrics.writes.maxMs < 3000, 'Writes under contention recovered well within busy_timeout=3000ms');

  // Open parent Repository BEFORE external locker acquires exclusive write lock
  repoParent = new Repository(dbPath, 'demo');
  const revBeforeBusy = repoParent.state().revision;

  // Now explicitly prove SQLITE_BUSY is raised when an external write lock exceeds 3000ms
  const lockerReady = new Promise((resolve, reject) => {
    const lockerScript = `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.env.TEST_DB_PATH);
      db.exec('BEGIN IMMEDIATE; UPDATE meta SET revision = revision WHERE id = 1;');
      process.stdout.write('LOCK_HELD\\n');
      setTimeout(() => {
        try { db.exec('ROLLBACK'); } catch {}
        db.close();
      }, 3500);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', lockerScript], {
      env: { ...process.env, TEST_DB_PATH: dbPath },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', chunk => {
      out += chunk.toString();
      if (out.includes('LOCK_HELD')) resolve(child);
    });
    child.on('error', reject);
  });

  lockerChild = await lockerReady;

  const tBusyStart = performance.now();
  assert.throws(
    () => repoParent.execute({
      id: 'busy-fail-1',
      revision: revBeforeBusy,
      command: { type: 'movement', date: DATE, accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '1', note: 'Busy test' }
    }, { actor: OWNER_ACTOR }),
    err => /SQLITE_BUSY|database is locked/i.test(`${err.code || ''} ${err.message || ''}`)
  );
  const busyElapsedMs = performance.now() - tBusyStart;
  t.diagnostic(`SQLITE_BUSY elapsed time after external 3500ms lock: ${busyElapsedMs.toFixed(1)}ms`);
  assert.ok(busyElapsedMs >= 2700, `Expected busy_timeout wait ~3000ms, got ${busyElapsedMs.toFixed(1)}ms`);

  // Wait for locker to release and verify DB remains healthy & clean
  if (lockerChild.exitCode === null && lockerChild.signalCode === null) {
    await new Promise(resolve => lockerChild.once('close', resolve));
  }
  assert.equal(repoParent.state().revision, revBeforeBusy);
  const afterRelease = repoParent.execute({
    id: 'after-busy-ok',
    revision: revBeforeBusy,
    command: { type: 'movement', date: DATE, accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '1', note: 'After lock' }
  }, { actor: OWNER_ACTOR });
  assert.equal(afterRelease.state.revision, revBeforeBusy + 1);
  assert.deepEqual(replay(repoParent.events()).balances, afterRelease.state.balances);

  // Verify one of the VACUUM INTO snapshots is also a valid replayable SQLite DB
  snapRepo = new Repository(join(backupDir, 'snap-0.sqlite'), 'demo');
  assert.deepEqual(replay(snapRepo.events()).balances, snapRepo.state().balances);
});

test('Faz 1-B: new Repository succeeds without SQLITE_BUSY under ~400ms external write lock and across 35 concurrent WAL close races', async t => {
  const dir = makeTempDir('p1-ctor-lock-');
  const dbPath = join(dir, 'demo.sqlite');
  let openedDuringLock;
  let lockerChild;
  let walWorker;
  t.after(async () => {
    try { openedDuringLock?.close(); } catch {}
    if (walWorker) {
      try {
        walWorker.postMessage('stop');
        await new Promise(resolve => {
          walWorker.once('exit', resolve);
          setTimeout(resolve, 1000);
        });
      } catch {}
    }
    if (lockerChild && lockerChild.exitCode === null && lockerChild.signalCode === null) {
      await new Promise(resolve => lockerChild.once('close', resolve));
    }
    removeTempDir(dir);
  });

  const seed = seedDirectRepo(dbPath);
  const expectedRevision = seed.state().revision;
  const expectedBalances = seed.state().balances;
  seed.close();

  // (a) Short (~400ms < 3000ms) external BEGIN IMMEDIATE write lock during new Repository()
  const lockerReady = new Promise((resolve, reject) => {
    const lockerScript = `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.env.TEST_DB_PATH);
      db.exec('BEGIN IMMEDIATE; UPDATE meta SET revision = revision WHERE id = 1;');
      process.stdout.write('SHORT_LOCK_HELD\\n');
      setTimeout(() => {
        try { db.exec('ROLLBACK'); } catch {}
        db.close();
      }, 400);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', lockerScript], {
      env: { ...process.env, TEST_DB_PATH: dbPath },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', chunk => {
      out += chunk.toString();
      if (out.includes('SHORT_LOCK_HELD')) resolve(child);
    });
    child.on('error', reject);
  });

  lockerChild = await lockerReady;
  const tOpenStart = performance.now();
  openedDuringLock = new Repository(dbPath, 'demo');
  const openElapsedMs = performance.now() - tOpenStart;
  t.diagnostic(`Constructor open under ~400ms external write lock elapsed: ${openElapsedMs.toFixed(1)}ms`);

  assert.ok(openElapsedMs >= 200, `Expected constructor to wait for ~400ms lock, got ${openElapsedMs.toFixed(1)}ms`);
  assert.ok(openElapsedMs < 3000, `Expected constructor to succeed within 3000ms timeout, got ${openElapsedMs.toFixed(1)}ms`);
  assert.equal(openedDuringLock.state().revision, expectedRevision);
  assert.deepEqual(openedDuringLock.state().balances, expectedBalances);
  openedDuringLock.close();
  openedDuringLock = null;

  if (lockerChild.exitCode === null && lockerChild.signalCode === null) {
    await new Promise(resolve => lockerChild.once('close', resolve));
  }

  // (b) 35 repeated concurrent WAL db.close() races while opening new Repository (and ReportRepository)
  const walCloseWorkerCode = `
    import { parentPort, workerData } from 'node:worker_threads';
    import { DatabaseSync } from 'node:sqlite';
    parentPort.on('message', msg => {
      if (msg === 'stop') {
        parentPort.close();
        return;
      }
      const db = new DatabaseSync(workerData.dbPath, { timeout: 3000 });
      db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; BEGIN IMMEDIATE; UPDATE meta SET revision = revision WHERE id = 1; COMMIT;');
      parentPort.postMessage('closing');
      db.close();
    });
  `;

  walWorker = new Worker(walCloseWorkerCode, { eval: true, workerData: { dbPath } });
  const iterations = 35;
  let maxOpenMs = 0;
  for (let i = 0; i < iterations; i++) {
    await new Promise((resolve, reject) => {
      const onMsg = () => {
        walWorker.off('error', onErr);
        const t0 = performance.now();
        const repo = new Repository(dbPath, 'demo');
        const report = new ReportRepository(dbPath, 'demo');
        const dt = performance.now() - t0;
        if (dt > maxOpenMs) maxOpenMs = dt;
        assert.equal(repo.state().revision, expectedRevision);
        assert.equal(report.overview().revision, expectedRevision);
        report.close();
        repo.close();
        resolve();
      };
      const onErr = err => {
        walWorker.off('message', onMsg);
        reject(err);
      };
      walWorker.once('message', onMsg);
      walWorker.once('error', onErr);
      walWorker.postMessage('step');
    });
  }
  walWorker.postMessage('stop');
  await new Promise((resolve, reject) => {
    walWorker.once('exit', code => (code === 0 ? resolve() : reject(new Error(`WAL worker exited with ${code}`))));
    walWorker.once('error', reject);
  });
  walWorker = null;
  t.diagnostic(`35 concurrent WAL db.close() constructor open races passed (maxOpenMs=${maxOpenMs.toFixed(1)}ms)`);
});

function createRepositoryBarrierPool(workerCount) {
  const sab = new SharedArrayBuffer(8);
  const ctrl = new Int32Array(sab);
  const repoUrl = new URL('../repository.mjs', import.meta.url).href;
  const workerCode = `
    import { parentPort, workerData } from 'node:worker_threads';
    const { Repository } = await import(workerData.repoUrl);
    const ctrl = new Int32Array(workerData.sab);
    parentPort.on('message', msg => {
      if (msg?.type === 'stop') {
        parentPort.close();
        return;
      }
      if (Atomics.add(ctrl, 1, 1) + 1 === msg.count) {
        Atomics.store(ctrl, 0, 1);
        Atomics.notify(ctrl, 0);
      } else {
        while (Atomics.load(ctrl, 0) === 0) {
          Atomics.wait(ctrl, 0, 0, 5000);
        }
      }
      let repo;
      let reply;
      try {
        repo = new Repository(msg.dbPath, 'demo');
        reply = {
          ok: true,
          revision: repo.state().revision,
          pendingCount: repo.pendingCount(),
          journalMode: String(repo.db.prepare('PRAGMA journal_mode').get()?.journal_mode || '').toLowerCase(),
          synchronous: repo.db.prepare('PRAGMA synchronous').get()?.synchronous,
          trustedSchema: repo.db.prepare('PRAGMA trusted_schema').get()?.trusted_schema,
          busyTimeout: repo.db.prepare('PRAGMA busy_timeout').get()?.timeout ?? repo.db.prepare('PRAGMA busy_timeout').get()?.busy_timeout
        };
      } catch (err) {
        reply = {
          ok: false,
          name: err?.name,
          code: err?.code,
          errcode: err?.errcode,
          message: err?.message
        };
      } finally {
        try { repo?.close(); } catch {}
      }
      parentPort.postMessage(reply);
    });
  `;

  const workers = Array.from({ length: workerCount }, () =>
    new Worker(workerCode, { eval: true, workerData: { repoUrl, sab } })
  );

  const runTrial = dbPath => {
    Atomics.store(ctrl, 0, 0);
    Atomics.store(ctrl, 1, 0);
    return Promise.all(
      workers.map(worker => new Promise((resolve, reject) => {
        const cleanup = () => {
          worker.off('message', onMsg);
          worker.off('error', onErr);
          worker.off('exit', onExit);
        };
        const onMsg = msg => {
          cleanup();
          resolve(msg);
        };
        const onErr = err => {
          cleanup();
          reject(err);
        };
        const onExit = code => {
          cleanup();
          reject(new Error(`Worker exited unexpectedly with code ${code}`));
        };
        worker.on('message', onMsg);
        worker.on('error', onErr);
        worker.on('exit', onExit);
        worker.postMessage({ dbPath, count: workerCount });
      }))
    );
  };

  const close = async () => {
    await Promise.all(workers.map(worker => new Promise(resolve => {
      const timer = setTimeout(() => {
        worker.terminate().finally(resolve);
      }, 1500);
      worker.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        worker.postMessage({ type: 'stop' });
      } catch {
        clearTimeout(timer);
        resolve();
      }
    })));
  };

  return { runTrial, close };
}

test('Faz 1-B: concurrent cold-start Repository initialization on non-existent SQLite file succeeds across 8 barrier-synchronized workers x 20 trials', async t => {
  const root = makeTempDir('p1-cold-pool-');
  const pool = createRepositoryBarrierPool(8);
  t.after(async () => {
    await pool.close();
    removeTempDir(root);
  });

  const expectedTables = [
    'events',
    'ledger_journal',
    'ledger_journal_accounts',
    'ledger_links',
    'ledger_snapshot',
    'meta',
    'pending_submissions',
    'restore_archive'
  ];
  const expectedIndexes = [
    'idx_lj_date',
    'idx_lj_original',
    'idx_lj_supplier',
    'idx_lj_type',
    'idx_ps_status',
    'idx_ps_worker_date'
  ];

  let lastDbPath;
  for (let trial = 0; trial < 20; trial++) {
    const trialDir = join(root, `fresh-${trial}`);
    mkdirSync(trialDir, { recursive: true });
    const dbPath = join(trialDir, 'demo.sqlite');
    lastDbPath = dbPath;

    assert.equal(existsSync(dbPath), false);
    assert.equal(existsSync(`${dbPath}-wal`), false);
    assert.equal(existsSync(`${dbPath}-shm`), false);

    const results = await pool.runTrial(dbPath);
    assert.equal(results.length, 8);
    assert.deepEqual(
      results.filter(r => !r.ok),
      [],
      `Trial ${trial} had unexpected cold-start failures: ${JSON.stringify(results)}`
    );
    for (const r of results) {
      assert.equal(r.revision, 0);
      assert.equal(r.pendingCount, 0);
      assert.equal(r.journalMode, 'wal');
      assert.equal(r.synchronous, 2);
      assert.equal(r.trustedSchema, 0);
      assert.equal(r.busyTimeout, 3000);
    }

    const verifyDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(String(verifyDb.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(), 'wal');
      assert.equal(verifyDb.prepare('PRAGMA synchronous').get().synchronous, 2);
      assert.equal(verifyDb.prepare('SELECT revision FROM meta WHERE id = 1').get().revision, 0);

      const tables = verifyDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
      assert.deepEqual(tables, expectedTables);

      const indexes = verifyDb.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
      assert.deepEqual(indexes, expectedIndexes);

      const psCols = new Set(verifyDb.prepare('PRAGMA table_info(pending_submissions)').all().map(col => col.name));
      assert.equal(psCols.has('submitted_via_master_pin'), true);
      assert.equal(psCols.has('submitted_master_actor_id'), true);

      const psSql = verifyDb.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pending_submissions'").get()?.sql || '';
      assert.equal(psSql.includes("'dailyCount'"), true);
    } finally {
      verifyDb.close();
    }
  }

  const repo = new Repository(lastDbPath, 'demo');
  try {
    const res = repo.execute({
      id: 'cold-open-follow-up-1',
      revision: 0,
      command: { type: 'opening', date: DATE, balances: openingBalances({ nakit: '100000' }) }
    }, { actor: OWNER_ACTOR });
    assert.equal(res.state.revision, 1);
    assert.deepEqual(replay(repo.events()).balances, res.state.balances);
  } finally {
    repo.close();
  }
});

test('Faz 1-B: Repository(:memory:) preserves memory journal_mode, enforces safety pragmas, and executes cleanly', t => {
  const explicitRepo = new Repository(':memory:', 'demo');
  const defaultRepo = new Repository();
  t.after(() => {
    try { explicitRepo.close(); } catch {}
    try { defaultRepo.close(); } catch {}
  });

  for (const [label, repo] of [['explicit :memory:', explicitRepo], ['default constructor', defaultRepo]]) {
    assert.equal(String(repo.db.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(), 'memory', `${label} should preserve memory journal_mode`);
    assert.equal(repo.db.prepare('PRAGMA synchronous').get().synchronous, 2, `${label} should enforce synchronous=FULL`);
    assert.equal(repo.db.prepare('PRAGMA trusted_schema').get().trusted_schema, 0, `${label} should enforce trusted_schema=OFF`);
    assert.equal(repo.db.prepare('PRAGMA busy_timeout').get().timeout ?? repo.db.prepare('PRAGMA busy_timeout').get().busy_timeout, 3000, `${label} should enforce busy_timeout=3000`);
    assert.equal(repo.state().revision, 0);
    assert.equal(repo.pendingCount(), 0);
  }

  const res = explicitRepo.execute({
    id: 'memory-open-1',
    revision: 0,
    command: { type: 'opening', date: DATE, balances: openingBalances({ nakit: '100000' }) }
  }, { actor: OWNER_ACTOR });
  assert.equal(res.state.revision, 1);
  assert.equal(res.state.balances.nakit, 10000000);
  assert.deepEqual(replay(explicitRepo.events()).balances, res.state.balances);

  const defaultRes = defaultRepo.execute({
    id: 'default-memory-open-1',
    revision: 0,
    command: { type: 'opening', date: DATE, balances: openingBalances({ nakit: '50000' }) }
  }, { actor: OWNER_ACTOR });
  assert.equal(defaultRes.state.revision, 1);
  assert.equal(defaultRes.state.balances.nakit, 5000000);
  assert.deepEqual(replay(defaultRepo.events()).balances, defaultRes.state.balances);
});

function createSubmitPendingBarrierPool(workerCount) {
  const sab = new SharedArrayBuffer(8);
  const ctrl = new Int32Array(sab);
  const repoUrl = new URL('../repository.mjs', import.meta.url).href;
  const workerCode = `
    import { parentPort, workerData } from 'node:worker_threads';
    const { Repository } = await import(workerData.repoUrl);
    const ctrl = new Int32Array(workerData.sab);
    parentPort.on('message', msg => {
      if (msg?.type === 'stop') {
        parentPort.close();
        return;
      }
      let repo;
      let reply;
      try {
        repo = new Repository(msg.dbPath, 'demo');
        if (Atomics.add(ctrl, 1, 1) + 1 === msg.count) {
          Atomics.store(ctrl, 0, 1);
          Atomics.notify(ctrl, 0);
        } else {
          while (Atomics.load(ctrl, 0) === 0) {
            Atomics.wait(ctrl, 0, 0, 5000);
          }
        }
        if (msg.op === 'execute') {
          const res = repo.execute(msg.payload, { actor: msg.actor });
          reply = { ok: true, workerIndex: msg.workerIndex, op: 'execute', duplicate: res.duplicate, revision: res.state.revision };
        } else {
          const res = repo.submitPending(msg.payload, { actor: msg.actor });
          reply = { ok: true, workerIndex: msg.workerIndex, op: 'submitPending', res };
        }
      } catch (err) {
        reply = {
          ok: false,
          workerIndex: msg.workerIndex,
          op: msg.op,
          name: err?.name,
          code: err?.code,
          errcode: err?.errcode,
          status: err?.status,
          message: err?.message
        };
      } finally {
        try { repo?.close(); } catch {}
      }
      parentPort.postMessage(reply);
    });
  `;

  const workers = Array.from({ length: workerCount }, () =>
    new Worker(workerCode, { eval: true, workerData: { repoUrl, sab } })
  );

  const runTrial = tasks => {
    Atomics.store(ctrl, 0, 0);
    Atomics.store(ctrl, 1, 0);
    return Promise.all(
      tasks.map((task, idx) => new Promise((resolve, reject) => {
        const worker = workers[idx];
        const cleanup = () => {
          worker.off('message', onMsg);
          worker.off('error', onErr);
          worker.off('exit', onExit);
        };
        const onMsg = msg => {
          cleanup();
          resolve(msg);
        };
        const onErr = err => {
          cleanup();
          reject(err);
        };
        const onExit = code => {
          cleanup();
          reject(new Error(`Worker exited unexpectedly with code ${code}`));
        };
        worker.on('message', onMsg);
        worker.on('error', onErr);
        worker.on('exit', onExit);
        worker.postMessage({ ...task, workerIndex: idx, count: tasks.length });
      }))
    );
  };

  const close = async () => {
    await Promise.all(workers.map(worker => new Promise(resolve => {
      const timer = setTimeout(() => {
        worker.terminate().finally(resolve);
      }, 1500);
      worker.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        worker.postMessage({ type: 'stop' });
      } catch {
        clearTimeout(timer);
        resolve();
      }
    })));
  };

  return { runTrial, close };
}

test('Faz 1-A: concurrent submitPending with identical id across 8 barrier-synchronized workers is idempotent without UNIQUE constraint or SQLITE_BUSY errors', async t => {
  const root = makeTempDir('p1-submit-same-');
  const pool = createSubmitPendingBarrierPool(8);
  t.after(async () => {
    await pool.close();
    removeTempDir(root);
  });

  const saleCmd = {
    type: 'sale',
    date: DATE,
    counterpartyType: 'customer',
    counterpartyId: 'cari-cust-1',
    items: [{ accountId: 'kunye', quantity: '1', weightAccount: 'taki14', weight: '6.5', value: '30000' }],
    received: [{ accountId: 'nakit', quantity: '30000', valueTL: '30000' }],
    given: []
  };
  const countCmd = {
    type: 'dailyCount',
    date: DATE,
    counts: { ceyrek: '20', kunye: '10' },
    reasons: { ceyrek: 'Kasa sayımı' },
    note: 'Eşzamanlı sayım'
  };
  const masterEmpActor = { ...EMP_ACTOR, viaMasterPin: true, masterActorId: OWNER_ACTOR.id };

  for (let trial = 0; trial < 10; trial++) {
    const trialDir = join(root, `same-${trial}`);
    mkdirSync(trialDir, { recursive: true });
    const dbPath = join(trialDir, 'demo.sqlite');
    const seed = seedDirectRepo(dbPath);
    seed.close();

    const useCount = trial >= 7;
    const subId = `concurrent-same-${trial}`;
    const command = useCount ? countCmd : saleCmd;
    const actor = useCount ? masterEmpActor : EMP_ACTOR;

    const results = await pool.runTrial(
      Array.from({ length: 8 }, () => ({
        dbPath,
        op: 'submitPending',
        actor,
        payload: { id: subId, revision: 2, command }
      }))
    );

    assert.equal(results.length, 8);
    assert.deepEqual(
      results.filter(r => !r.ok),
      [],
      `Trial ${trial} had unexpected errors: ${JSON.stringify(results)}`
    );

    const fresh = results.filter(r => r.res.duplicate === false);
    const dups = results.filter(r => r.res.duplicate === true);
    assert.equal(fresh.length, 1, `Expected 1 fresh submitPending, got ${fresh.length}`);
    assert.equal(dups.length, 7, `Expected 7 duplicate submitPending results, got ${dups.length}`);

    const expectedSubmittedAt = fresh[0].res.submittedAt;
    const expectedSummary = fresh[0].res.summary;
    for (const r of results) {
      assert.equal(r.res.id, subId);
      assert.equal(r.res.status, 'pending');
      assert.equal(r.res.submittedAt, expectedSubmittedAt);
      assert.deepEqual(r.res.summary, expectedSummary);
    }

    const verifyDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const countRow = verifyDb.prepare('SELECT COUNT(*) AS c FROM pending_submissions WHERE id = ?').get(subId);
      assert.equal(countRow.c, 1);
      const totalRow = verifyDb.prepare('SELECT COUNT(*) AS c FROM pending_submissions').get();
      assert.equal(totalRow.c, 1);
      const row = verifyDb.prepare('SELECT submitted_via_master_pin, submitted_master_actor_id FROM pending_submissions WHERE id = ?').get(subId);
      assert.equal(row.submitted_via_master_pin, useCount ? 1 : 0);
      assert.equal(row.submitted_master_actor_id, useCount ? OWNER_ACTOR.id : null);
      assert.equal(verifyDb.prepare('SELECT revision FROM meta WHERE id = 1').get().revision, 2);
      assert.equal(verifyDb.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    } finally {
      verifyDb.close();
    }
  }
});

test('Faz 1-A: concurrent submitPending with distinct IDs at same revision and concurrent execute() serialize cleanly under BEGIN IMMEDIATE', async t => {
  const root = makeTempDir('p1-submit-uniq-');
  const pool = createSubmitPendingBarrierPool(8);
  t.after(async () => {
    await pool.close();
    removeTempDir(root);
  });

  const saleCmd = {
    type: 'sale',
    date: DATE,
    counterpartyType: 'customer',
    counterpartyId: 'cari-cust-1',
    items: [{ accountId: 'kunye', quantity: '1', weightAccount: 'taki14', weight: '6.5', value: '30000' }],
    received: [{ accountId: 'nakit', quantity: '30000', valueTL: '30000' }],
    given: []
  };
  const countCmd = {
    type: 'dailyCount',
    date: DATE,
    counts: { ceyrek: '20' },
    reasons: {},
    note: 'Paralel sayım'
  };

  // (a) 8 barrier-synchronized workers submitting distinct IDs at identical revision 2
  const uniqDir = join(root, 'distinct');
  mkdirSync(uniqDir, { recursive: true });
  const uniqDbPath = join(uniqDir, 'demo.sqlite');
  const seedA = seedDirectRepo(uniqDbPath);
  seedA.close();

  const uniqResults = await pool.runTrial(
    Array.from({ length: 8 }, (_, idx) => ({
      dbPath: uniqDbPath,
      op: 'submitPending',
      actor: EMP_ACTOR,
      payload: {
        id: `concurrent-uniq-${idx}`,
        revision: 2,
        command: idx % 2 === 0 ? saleCmd : countCmd
      }
    }))
  );

  assert.deepEqual(
    uniqResults.filter(r => !r.ok),
    [],
    `Distinct-ID concurrent submitPending failed: ${JSON.stringify(uniqResults)}`
  );
  for (const r of uniqResults) {
    assert.equal(r.res.duplicate, false);
    assert.equal(r.res.status, 'pending');
  }

  const verifyRepo = new Repository(uniqDbPath, 'demo');
  try {
    assert.equal(verifyRepo.pendingCount(), 8);
    assert.equal(verifyRepo.state().revision, 2);
    assert.equal(verifyRepo.db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  } finally {
    verifyRepo.close();
  }

  // (b) Concurrent execute() (rev 2 -> 3) racing against 7 submitPending(..., revision: 2)
  for (let trial = 0; trial < 5; trial++) {
    const raceDir = join(root, `race-${trial}`);
    mkdirSync(raceDir, { recursive: true });
    const raceDbPath = join(raceDir, 'demo.sqlite');
    const seedB = seedDirectRepo(raceDbPath);
    seedB.close();

    const tasks = [
      {
        dbPath: raceDbPath,
        op: 'execute',
        actor: OWNER_ACTOR,
        payload: {
          id: `race-exec-${trial}`,
          revision: 2,
          command: { type: 'movement', date: DATE, accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '100', note: 'Race execute' }
        }
      },
      ...Array.from({ length: 7 }, (_, idx) => ({
        dbPath: raceDbPath,
        op: 'submitPending',
        actor: EMP_ACTOR,
        payload: { id: `race-sub-${trial}-${idx}`, revision: 2, command: saleCmd }
      }))
    ];

    const raceResults = await pool.runTrial(tasks);
    const execRes = raceResults.find(r => r.op === 'execute');
    assert.equal(execRes?.ok, true, `execute() failed in race trial ${trial}: ${JSON.stringify(execRes)}`);
    assert.equal(execRes.revision, 3);

    const subResults = raceResults.filter(r => r.op === 'submitPending');
    assert.equal(subResults.length, 7);
    let accepted = 0;
    for (const r of subResults) {
      if (r.ok) {
        assert.equal(r.res.duplicate, false);
        assert.equal(r.res.status, 'pending');
        accepted++;
      } else {
        assert.equal(r.status, 409, `Expected 409 REVISION_CONFLICT, got: ${JSON.stringify(r)}`);
        assert.equal(r.code, 'REVISION_CONFLICT', `Expected REVISION_CONFLICT, got: ${JSON.stringify(r)}`);
      }
    }

    const postRaceRepo = new Repository(raceDbPath, 'demo');
    try {
      assert.equal(postRaceRepo.state().revision, 3);
      assert.equal(postRaceRepo.pendingCount(), accepted);
      assert.throws(
        () => postRaceRepo.submitPending({ id: `stale-after-race-${trial}`, revision: 2, command: saleCmd }, { actor: EMP_ACTOR }),
        err => err?.status === 409 && err?.code === 'REVISION_CONFLICT'
      );
      assert.equal(postRaceRepo.db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    } finally {
      postRaceRepo.close();
    }
  }
});

test('Faz 1-A: sequential submitPending enforces command payload parity while preserving canonical and dailyCount retries', t => {
  const repo = seedDirectRepo(':memory:');
  t.after(() => repo.close());

  const saleCmdA = {
    type: 'sale',
    date: DATE,
    counterpartyType: 'customer',
    counterpartyId: 'cari-cust-1',
    items: [{ accountId: 'kunye', quantity: '1', weightAccount: 'taki14', weight: '6.5', value: '30000' }],
    received: [{ accountId: 'nakit', quantity: '30000', valueTL: '30000' }],
    given: []
  };
  const saleCmdAReordered = {
    given: [],
    received: [{ valueTL: '30000', quantity: '30000', accountId: 'nakit' }],
    items: [{ value: '30000', weight: '6.5', weightAccount: 'taki14', quantity: '1', accountId: 'kunye' }],
    counterpartyId: 'cari-cust-1',
    counterpartyType: 'customer',
    date: DATE,
    type: 'sale',
    note: undefined
  };
  const saleCmdB = {
    ...saleCmdA,
    items: [{ accountId: 'kunye', quantity: '1', weightAccount: 'taki14', weight: '6.5', value: '99000' }],
    received: [{ accountId: 'nakit', quantity: '99000', valueTL: '99000' }]
  };

  const firstSale = repo.submitPending({ id: 'seq-sale-1', revision: 2, command: saleCmdA }, { actor: EMP_ACTOR });
  assert.equal(firstSale.duplicate, false);

  const dupSale = repo.submitPending({ id: 'seq-sale-1', revision: 2, command: saleCmdAReordered }, { actor: EMP_ACTOR });
  assert.equal(dupSale.duplicate, true);
  assert.equal(dupSale.submittedAt, firstSale.submittedAt);
  assert.deepEqual(dupSale.summary, firstSale.summary);

  for (const conflictingCmd of [
    saleCmdB,
    { type: 'dailyCount', date: DATE, counts: { ceyrek: '20' } },
    { ...saleCmdA, type: 'purchase', paid: saleCmdA.received, received: [], given: [] }
  ]) {
    assert.throws(
      () => repo.submitPending({ id: 'seq-sale-1', revision: 2, command: conflictingCmd }, { actor: EMP_ACTOR }),
      err => err?.name === 'DomainError' && err?.status === 409 && err?.code === 'IDEMPOTENCY_CONFLICT'
    );
    assert.equal(repo.db.isTransaction, false);
  }
  assert.equal(repo.state().revision, 2);
  assert.equal(JSON.parse(repo.db.prepare('SELECT summary_json FROM pending_submissions WHERE id = ?').get('seq-sale-1').summary_json).totalTL, 3000000);

  // dailyCount normalization parity + post-close retry check
  const countCmdRaw = {
    type: 'dailyCount',
    date: DATE,
    counts: { ceyrek: ' 20 ', kunye: '10', yarim: '  ' },
    reasons: { ceyrek: '  Kasa sayımı  ', yarim: 'ignored' },
    note: '  İlk sayım  '
  };
  const countCmdReordered = {
    note: 'İlk sayım',
    reasons: { ceyrek: 'Kasa sayımı' },
    counts: { kunye: '10', ceyrek: '20' },
    date: DATE,
    type: 'dailyCount'
  };
  const firstCount = repo.submitPending({ id: 'seq-dc-1', revision: 2, command: countCmdRaw }, { actor: EMP_ACTOR });
  assert.equal(firstCount.duplicate, false);

  const dupCount = repo.submitPending({ id: 'seq-dc-1', revision: 2, command: countCmdReordered }, { actor: EMP_ACTOR });
  assert.equal(dupCount.duplicate, true);
  assert.equal(dupCount.submittedAt, firstCount.submittedAt);
  assert.deepEqual(dupCount.summary, firstCount.summary);

  for (const badCountCmd of [
    { ...countCmdReordered, counts: { kunye: '10', ceyrek: '21' } },
    { ...countCmdReordered, counts: { ceyrek: '20' } },
    { ...countCmdReordered, reasons: { ceyrek: 'Farklı sebep' } },
    { ...countCmdReordered, note: 'Farklı not' },
    { ...countCmdReordered, date: '2026-11-25' },
    saleCmdA
  ]) {
    assert.throws(
      () => repo.submitPending({ id: 'seq-dc-1', revision: 2, command: badCountCmd }, { actor: EMP_ACTOR }),
      err => err?.name === 'DomainError' && err?.status === 409 && err?.code === 'IDEMPOTENCY_CONFLICT'
    );
    assert.equal(repo.db.isTransaction, false);
  }

  // Reject pending submissions, close workday to 2026-11-25, then verify original dailyCount retry STILL succeeds
  repo.rejectPending({ id: 'seq-sale-1', reason: 'Test', actor: OWNER_ACTOR });
  repo.rejectPending({ id: 'seq-dc-1', reason: 'Test', actor: OWNER_ACTOR });
  const dailyCounts = Object.fromEntries(
    repo.state().accounts.filter(a => !a.retired && a.physical && a.countPolicy === 'daily').map(a => [a.id, decimal(repo.state().balances[a.id] || 0, a.unit)])
  );
  repo.execute({
    id: 'close-for-dc-retry',
    revision: 2,
    command: { type: 'close', date: DATE, nextDate: '2026-11-25', counts: dailyCounts, reasons: {}, approvedBy: OWNER_ACTOR.name }
  }, { actor: OWNER_ACTOR });

  const postCloseDup = repo.submitPending({ id: 'seq-dc-1', revision: 2, command: countCmdReordered }, { actor: EMP_ACTOR });
  assert.equal(postCloseDup.duplicate, true);
  assert.equal(postCloseDup.status, 'rejected');
  assert.throws(
    () => repo.submitPending({ id: 'seq-dc-1', revision: 2, command: { ...countCmdReordered, date: '2026-11-25' } }, { actor: EMP_ACTOR }),
    err => err?.name === 'DomainError' && err?.status === 409 && err?.code === 'IDEMPOTENCY_CONFLICT'
  );
});

test('Faz 1-A: concurrent submitPending with identical id and conflicting command payloads across 8 barrier-synchronized workers', async t => {
  const root = makeTempDir('p1-submit-conflict-');
  const pool = createSubmitPendingBarrierPool(8);
  t.after(async () => {
    await pool.close();
    removeTempDir(root);
  });

  const saleCmdA = {
    type: 'sale',
    date: DATE,
    counterpartyType: 'customer',
    counterpartyId: 'cari-cust-1',
    items: [{ accountId: 'kunye', quantity: '1', weightAccount: 'taki14', weight: '6.5', value: '30000' }],
    received: [{ accountId: 'nakit', quantity: '30000', valueTL: '30000' }],
    given: []
  };
  const saleCmdB = {
    type: 'sale',
    date: DATE,
    counterpartyType: 'customer',
    counterpartyId: 'cari-cust-1',
    items: [{ accountId: 'kunye', quantity: '1', weightAccount: 'taki14', weight: '6.5', value: '99000' }],
    received: [{ accountId: 'nakit', quantity: '99000', valueTL: '99000' }],
    given: []
  };
  const countCmdA = {
    type: 'dailyCount',
    date: DATE,
    counts: { ceyrek: '20', kunye: '10' },
    reasons: { ceyrek: 'Kasa sayımı' },
    note: 'Sayım A'
  };

  for (let trial = 0; trial < 6; trial++) {
    const trialDir = join(root, `conflict-${trial}`);
    mkdirSync(trialDir, { recursive: true });
    const dbPath = join(trialDir, 'demo.sqlite');
    const seed = seedDirectRepo(dbPath);
    seed.close();

    const subId = `concurrent-conflict-${trial}`;
    const cmdA = trial < 4 ? saleCmdA : countCmdA;
    const cmdB = saleCmdB;

    const tasks = Array.from({ length: 8 }, (_, idx) => ({
      dbPath,
      op: 'submitPending',
      actor: EMP_ACTOR,
      payload: {
        id: subId,
        revision: 2,
        command: idx < 4 ? cmdA : cmdB
      }
    }));

    const results = await pool.runTrial(tasks);
    const fresh = results.filter(r => r.ok && r.res.duplicate === false);
    const dups = results.filter(r => r.ok && r.res.duplicate === true);
    const rejected = results.filter(r => !r.ok);

    assert.equal(fresh.length, 1, `Trial ${trial}: expected 1 winner, got ${JSON.stringify(results)}`);
    assert.equal(dups.length, 3, `Trial ${trial}: expected 3 matching duplicates, got ${JSON.stringify(results)}`);
    assert.equal(rejected.length, 4, `Trial ${trial}: expected 4 conflict rejections, got ${JSON.stringify(results)}`);

    const winnerGroup = fresh[0].workerIndex < 4 ? 'A' : 'B';
    for (const d of dups) {
      assert.equal(d.workerIndex < 4 ? 'A' : 'B', winnerGroup);
      assert.equal(d.res.submittedAt, fresh[0].res.submittedAt);
      assert.deepEqual(d.res.summary, fresh[0].res.summary);
    }
    for (const r of rejected) {
      assert.notEqual(r.workerIndex < 4 ? 'A' : 'B', winnerGroup);
      assert.equal(r.name, 'DomainError');
      assert.equal(r.status, 409);
      assert.equal(r.code, 'IDEMPOTENCY_CONFLICT');
    }

    const verifyDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(verifyDb.prepare('SELECT COUNT(*) AS c FROM pending_submissions WHERE id = ?').get(subId).c, 1);
      const row = verifyDb.prepare('SELECT command_json, summary_json FROM pending_submissions WHERE id = ?').get(subId);
      assert.deepEqual(JSON.parse(row.summary_json), fresh[0].res.summary);
      assert.equal(JSON.parse(row.command_json).type, winnerGroup === 'A' ? cmdA.type : cmdB.type);
      assert.equal(verifyDb.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    } finally {
      verifyDb.close();
    }
  }
});
