import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { INITIAL_ACCOUNTS, eventActor, replay } from '../domain.mjs';
import { Repository } from '../repository.mjs';
import { createApp } from '../server.mjs';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_2_ID = '22222222-2222-4222-8222-222222222222';
const EMP_ID = '33333333-3333-4333-8333-333333333333';

async function httpFixture(t) {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'master-pin-audit-'));
  const { server, repositories } = createApp({ dataDirectory, logger: () => {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    });
    rmSync(dataDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const send = (path, token, body) => {
    const headers = token ? { Authorization: 'Bearer ' + token } : {};
    return fetch(
      base + path,
      body === undefined
        ? { headers }
        : {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          }
    );
  };
  return { send, repositories, dataDirectory, base };
}

function repoFixture(t) {
  const repo = new Repository(':memory:', 'demo');
  t.after(() => repo.close());
  const date = '2026-11-24';
  const balances = Object.fromEntries(
    INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, a.id === 'ceyrek' || a.id === 'nakit' ? '100' : '0'])
  );
  repo.execute({ id: 'open-1', revision: 0, command: { type: 'opening', date, balances } });
  return { repo, date };
}

test('Master PIN login records employee context AND owner masterActorId across direct commands, pending approvals, dailyCount, and replay', async t => {
  const { send, repositories } = await httpFixture(t);
  const owner = await (await send('/api/auth/setup', null, { name: 'Patron', pin: '112233' })).json();
  const emp = await (await send('/api/auth/employees', owner.token, { name: 'Tezgahtar Ali', pin: '445566' })).json();
  assert.equal(emp.mustChangePin, true);

  // Normal employee with mustChangePin=true is blocked by AUD-04 on write routes
  const tempEmpLogin = await (await send('/api/auth/login', null, { id: emp.id, pin: '445566' })).json();
  assert.equal(tempEmpLogin.actor.mustChangePin, true);
  assert.equal((await send('/api/pending-approvals', tempEmpLogin.token, { id: 'blocked-temp', command: { type: 'dailyCount', date: '2026-11-24', counts: { ceyrek: '1' } } })).status, 403);
  assert.equal((await send('/api/command', tempEmpLogin.token, { id: 'blocked-cmd', revision: 0, command: { type: 'account', date: '2026-11-24', name: 'X', unit: 'TL', partyType: 'customer', opening: '0' } })).status, 403);

  // Master PIN login into employee account works even while employee must_change_pin=1
  const masterRes = await send('/api/auth/login', null, { id: emp.id, pin: '112233' });
  assert.equal(masterRes.status, 200);
  const masterSession = await masterRes.json();
  assert.equal(masterSession.actor.id, emp.id);
  assert.equal(masterSession.actor.role, 'employee');
  assert.equal(masterSession.actor.viaMasterPin, true);
  assert.equal(masterSession.actor.masterActorId, owner.actor.id);
  assert.equal(masterSession.actor.mustChangePin, false);

  // Seed demo ledger
  const initState = await (await send('/api/state', owner.token)).json();
  const date = '2026-11-24';
  const balances = Object.fromEntries(
    initState.accounts.filter(a => !a.retired).map(a => [a.id, ({ nakit: '50000', ceyrek: '20' })[a.id] || '0'])
  );
  assert.equal((await send('/api/command', owner.token, { id: 'open-mp', revision: 0, command: { type: 'opening', date, balances } })).status, 200);

  // 1. Direct employee command via Master PIN (isWorkerCustomerCreation)
  const custRes = await send('/api/command', masterSession.token, {
    id: 'mp-cust-1',
    revision: 1,
    command: { type: 'account', date, name: 'Master Müşteri', unit: 'TL', partyType: 'customer', opening: '0' }
  });
  assert.equal(custRes.status, 200);

  // 2. Pending trade submission via Master PIN -> owner approval (direct and edited)
  const saleCmd = {
    type: 'sale',
    date,
    counterpartyType: 'customer',
    counterpartyId: 'cari-mp-cust-1',
    items: [{ accountId: 'ceyrek', quantity: '1', value: '5000' }],
    received: [{ accountId: 'nakit', quantity: '5000', valueTL: '5000' }],
    given: []
  };
  const subTradeRes = await send('/api/pending-approvals', masterSession.token, {
    id: 'mp-sub-sale',
    revision: 2,
    command: saleCmd
  });
  assert.equal(subTradeRes.status, 201);

  // 3. Pending dailyCount submission via Master PIN
  const subCountRes = await send('/api/pending-approvals', masterSession.token, {
    id: 'mp-sub-count',
    revision: 2,
    command: { type: 'dailyCount', date, counts: { ceyrek: '19' }, reasons: { ceyrek: 'Test sayımı' } }
  });
  assert.equal(subCountRes.status, 201);

  // Verify raw SQLite pending_submissions + listPending before approval
  const repo = repositories.get('demo');
  const rawPendingSale = repo.db.prepare('SELECT submitted_by_id, submitted_by_name, submitted_via_master_pin, submitted_master_actor_id FROM pending_submissions WHERE id = ?').get('mp-sub-sale');
  assert.deepEqual(
    { ...rawPendingSale },
    {
      submitted_by_id: emp.id,
      submitted_by_name: 'Tezgahtar Ali',
      submitted_via_master_pin: 1,
      submitted_master_actor_id: owner.actor.id
    }
  );
  const rawPendingCount = repo.db.prepare('SELECT submitted_via_master_pin, submitted_master_actor_id FROM pending_submissions WHERE id = ?').get('mp-sub-count');
  assert.equal(rawPendingCount.submitted_via_master_pin, 1);
  assert.equal(rawPendingCount.submitted_master_actor_id, owner.actor.id);

  const ownerPendingList = await (await send('/api/pending-approvals?status=pending', owner.token)).json();
  const listedSale = ownerPendingList.items.find(i => i.id === 'mp-sub-sale');
  assert.deepEqual(listedSale.submittedBy, {
    id: emp.id,
    name: 'Tezgahtar Ali',
    viaMasterPin: true,
    masterActorId: owner.actor.id
  });

  // Owner approves pending trade (with edit to confirm wasEdited + Master PIN provenance both survive)
  const editedSale = {
    ...saleCmd,
    items: [{ accountId: 'ceyrek', quantity: '1', value: '5200' }],
    received: [{ accountId: 'nakit', quantity: '5200', valueTL: '5200' }]
  };
  const apprRes = await send('/api/pending-approvals/approve', owner.token, {
    id: 'mp-sub-sale',
    revision: 2,
    command: editedSale
  });
  assert.equal(apprRes.status, 200);

  // Verify events.audit, state().journal, and replay()
  const events = repo.events();
  const custEvent = events.find(e => e.id === 'mp-cust-1');
  assert.deepEqual(custEvent.audit, {
    version: 1,
    actor: {
      id: emp.id,
      name: 'Tezgahtar Ali',
      role: 'employee',
      viaMasterPin: true,
      masterActorId: owner.actor.id
    }
  });

  const apprEvent = events.find(e => e.id === 'approve-mp-sub-sale');
  assert.deepEqual(apprEvent.audit, {
    version: 1,
    actor: {
      id: owner.actor.id,
      name: 'Patron',
      role: 'owner'
    },
    submittedBy: {
      id: emp.id,
      name: 'Tezgahtar Ali',
      viaMasterPin: true,
      masterActorId: owner.actor.id
    },
    wasEdited: true
  });

  const stateJournal = repo.state().journal;
  assert.deepEqual(stateJournal.find(e => e.id === 'mp-cust-1').actor, custEvent.audit.actor);
  assert.deepEqual(stateJournal.find(e => e.id === 'approve-mp-sub-sale').actor, {
    id: owner.actor.id,
    name: 'Patron',
    role: 'owner',
    submittedBy: {
      id: emp.id,
      name: 'Tezgahtar Ali',
      viaMasterPin: true,
      masterActorId: owner.actor.id
    },
    wasEdited: true
  });

  const replayed = replay(events);
  assert.deepEqual(replayed.journal.find(e => e.id === 'mp-cust-1').actor, custEvent.audit.actor);
  assert.deepEqual(
    replayed.journal.find(e => e.id === 'approve-mp-sub-sale').actor,
    stateJournal.find(e => e.id === 'approve-mp-sub-sale').actor
  );
});

test('Client-spoofed actor/viaMasterPin/masterActorId in HTTP bodies are ignored; normal employee login records zero Master PIN keys', async t => {
  const { send, repositories } = await httpFixture(t);
  const owner = await (await send('/api/auth/setup', null, { name: 'Patron', pin: '112233' })).json();
  const emp = await (await send('/api/auth/employees', owner.token, { name: 'Kasiyer', pin: '445566' })).json();
  const tempLogin = await (await send('/api/auth/login', null, { id: emp.id, pin: '445566' })).json();
  assert.equal((await send('/api/auth/change-pin', tempLogin.token, { currentPin: '445566', newPin: '778899' })).status, 200);
  const normalEmp = await (await send('/api/auth/login', null, { id: emp.id, pin: '778899' })).json();
  assert.equal(Object.hasOwn(normalEmp.actor, 'viaMasterPin'), false);
  assert.equal(Object.hasOwn(normalEmp.actor, 'masterActorId'), false);

  const initState = await (await send('/api/state', owner.token)).json();
  const date = '2026-11-24';
  const balances = Object.fromEntries(
    initState.accounts.filter(a => !a.retired).map(a => [a.id, ({ nakit: '50000', ceyrek: '10' })[a.id] || '0'])
  );
  assert.equal((await send('/api/command', owner.token, { id: 'open-spoof', revision: 0, command: { type: 'opening', date, balances } })).status, 200);

  // Normal employee attempts to spoof actor, viaMasterPin, and masterActorId in POST /api/command
  const spoofPayload = {
    id: 'emp-direct-spoof',
    revision: 1,
    actor: { id: owner.actor.id, name: 'Patron', role: 'owner', viaMasterPin: true, masterActorId: owner.actor.id },
    viaMasterPin: true,
    masterActorId: owner.actor.id,
    command: { type: 'account', date, name: 'Normal Müşteri', unit: 'TL', partyType: 'customer', opening: '0' }
  };
  assert.equal((await send('/api/command', normalEmp.token, spoofPayload)).status, 200);

  // Normal employee attempts to spoof actor, viaMasterPin, and masterActorId in POST /api/pending-approvals
  const saleCmd = {
    type: 'sale',
    date,
    counterpartyType: 'customer',
    counterpartyId: 'cari-emp-direct-spoof',
    items: [{ accountId: 'ceyrek', quantity: '1', value: '5000' }],
    received: [{ accountId: 'nakit', quantity: '5000', valueTL: '5000' }],
    given: []
  };
  const pendingSpoof = await send('/api/pending-approvals', normalEmp.token, {
    id: 'emp-pending-spoof',
    revision: 2,
    actor: { id: owner.actor.id, role: 'owner', viaMasterPin: true, masterActorId: owner.actor.id },
    viaMasterPin: true,
    masterActorId: owner.actor.id,
    command: saleCmd
  });
  assert.equal(pendingSpoof.status, 201);

  assert.equal((await send('/api/pending-approvals/approve', owner.token, { id: 'emp-pending-spoof', revision: 2 })).status, 200);

  const repo = repositories.get('demo');
  const directEv = repo.events().find(e => e.id === 'emp-direct-spoof');
  assert.deepEqual(Object.keys(directEv.audit.actor).sort(), ['id', 'name', 'role']);
  assert.equal(directEv.audit.actor.id, emp.id);
  assert.equal(Object.hasOwn(directEv.audit.actor, 'viaMasterPin'), false);
  assert.equal(Object.hasOwn(directEv.audit.actor, 'masterActorId'), false);

  const rawPending = repo.db.prepare('SELECT submitted_by_id, submitted_via_master_pin, submitted_master_actor_id FROM pending_submissions WHERE id = ?').get('emp-pending-spoof');
  assert.equal(rawPending.submitted_by_id, emp.id);
  assert.equal(rawPending.submitted_via_master_pin, 0);
  assert.equal(rawPending.submitted_master_actor_id, null);

  const listed = repo.listPending({ status: 'approved' }).find(i => i.id === 'emp-pending-spoof');
  assert.deepEqual(Object.keys(listed.submittedBy).sort(), ['id', 'name']);

  const apprEv = repo.events().find(e => e.id === 'approve-emp-pending-spoof');
  assert.deepEqual(Object.keys(apprEv.audit.submittedBy).sort(), ['id', 'name']);

  // Also test Master PIN session trying to spoof a different masterActorId or viaMasterPin: false
  const masterSession = await (await send('/api/auth/login', null, { id: emp.id, pin: '112233' })).json();
  const spoofMasterRes = await send('/api/command', masterSession.token, {
    id: 'mp-spoof-override',
    revision: 3,
    actor: { id: EMP_ID, role: 'employee', viaMasterPin: false, masterActorId: OWNER_2_ID },
    viaMasterPin: false,
    masterActorId: OWNER_2_ID,
    command: { type: 'account', date, name: 'Master Müşteri 2', unit: 'TL', partyType: 'customer', opening: '0' }
  });
  assert.equal(spoofMasterRes.status, 200);
  const mpEv = repo.events().find(e => e.id === 'mp-spoof-override');
  assert.equal(mpEv.audit.actor.viaMasterPin, true);
  assert.equal(mpEv.audit.actor.masterActorId, owner.actor.id);
});

test('domain eventActor and replay preserve legacy events and reject forged/malformed Master PIN fields', () => {
  const balances = Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, '0']));
  const openingEvent = { id: 'open-legacy', schemaVersion: 3, timestamp: '2026-11-24T10:00:00.000Z', command: { type: 'opening', date: '2026-11-24', balances } };
  assert.equal(eventActor(openingEvent), null);

  const custCmd = { type: 'account', date: '2026-11-24', name: 'Müşteri', unit: 'TL', partyType: 'customer', opening: '0' };
  const normalEvent = {
    id: 'normal-cust',
    schemaVersion: 3,
    timestamp: '2026-11-24T10:01:00.000Z',
    command: custCmd,
    audit: {
      version: 1,
      actor: { id: OWNER_ID, name: 'Patron', role: 'owner' },
      submittedBy: { id: EMP_ID, name: 'Kasiyer' }
    }
  };
  const parsedNormal = eventActor(normalEvent);
  assert.deepEqual(Object.keys(parsedNormal).sort(), ['id', 'name', 'role', 'submittedBy']);
  assert.deepEqual(Object.keys(parsedNormal.submittedBy).sort(), ['id', 'name']);

  const replayedNormal = replay([openingEvent, normalEvent]);
  assert.deepEqual(Object.keys(replayedNormal.journal[1].actor).sort(), ['id', 'name', 'role', 'submittedBy']);

  // Malformed audit.actor combinations MUST fail eventActor & replay
  const badActorPayloads = [
    { id: EMP_ID, name: 'Kasiyer', role: 'employee', viaMasterPin: false, masterActorId: OWNER_ID },
    { id: EMP_ID, name: 'Kasiyer', role: 'employee', viaMasterPin: false },
    { id: EMP_ID, name: 'Kasiyer', role: 'employee', viaMasterPin: 'true', masterActorId: OWNER_ID },
    { id: EMP_ID, name: 'Kasiyer', role: 'employee', masterActorId: OWNER_ID },
    { id: EMP_ID, name: 'Kasiyer', role: 'employee', viaMasterPin: true },
    { id: EMP_ID, name: 'Kasiyer', role: 'employee', viaMasterPin: true, masterActorId: 'not-a-uuid' },
    { id: EMP_ID, name: 'Kasiyer', role: 'employee', viaMasterPin: true, masterActorId: null },
    { id: OWNER_ID, name: 'Patron', role: 'owner', viaMasterPin: true, masterActorId: OWNER_2_ID }
  ];
  for (const badActor of badActorPayloads) {
    const forged = {
      id: 'forged-actor',
      schemaVersion: 3,
      timestamp: '2026-11-24T10:02:00.000Z',
      command: custCmd,
      audit: { version: 1, actor: badActor }
    };
    assert.throws(() => eventActor(forged), { name: 'DomainError' });
    assert.throws(() => replay([openingEvent, forged]), { name: 'DomainError' });
  }

  // Malformed audit.submittedBy combinations MUST fail eventActor & replay
  const badSubPayloads = [
    { id: EMP_ID, name: 'Kasiyer', viaMasterPin: false, masterActorId: OWNER_ID },
    { id: EMP_ID, name: 'Kasiyer', viaMasterPin: false },
    { id: EMP_ID, name: 'Kasiyer', masterActorId: OWNER_ID },
    { id: EMP_ID, name: 'Kasiyer', viaMasterPin: true },
    { id: EMP_ID, name: 'Kasiyer', viaMasterPin: true, masterActorId: 'emp-1' },
    { id: EMP_ID, name: 'Kasiyer', viaMasterPin: 1, masterActorId: OWNER_ID }
  ];
  for (const badSub of badSubPayloads) {
    const forged = {
      id: 'forged-sub',
      schemaVersion: 3,
      timestamp: '2026-11-24T10:02:00.000Z',
      command: custCmd,
      audit: { version: 1, actor: { id: OWNER_ID, name: 'Patron', role: 'owner' }, submittedBy: badSub }
    };
    assert.throws(() => eventActor(forged), { name: 'DomainError' });
    assert.throws(() => replay([openingEvent, forged]), { name: 'DomainError' });
  }
});

test('Pre-migration 6d68c3e pending_submissions schema upgrades cleanly without losing existing rows', t => {
  const dir = mkdtempSync(join(tmpdir(), 'master-pin-migrate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const dbPath = join(dir, 'legacy.sqlite');

  // Seed a 6d68c3e database WITHOUT submitted_via_master_pin / submitted_master_actor_id
  const legacyDb = new DatabaseSync(dbPath);
  try {
    const balances = Object.fromEntries(
      INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, a.id === 'ceyrek' || a.id === 'nakit' ? '100' : '0'])
    );
    const openEvent = { id: 'open-mig', schemaVersion: 3, timestamp: '2026-11-24T09:00:00.000Z', command: { type: 'opening', date: '2026-11-24', balances } };
    legacyDb.exec(`
      CREATE TABLE events(seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, body TEXT NOT NULL);
      CREATE TABLE meta(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
      INSERT INTO meta VALUES(1, 1);
      CREATE TABLE pending_submissions(
        id TEXT PRIMARY KEY NOT NULL,
        workspace TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
        date TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('sale','purchase','dailyCount')),
        submitted_by_id TEXT NOT NULL,
        submitted_by_name TEXT NOT NULL,
        submitted_at TEXT NOT NULL,
        command_json TEXT NOT NULL,
        approved_command_json TEXT,
        summary_json TEXT NOT NULL,
        reviewed_by_id TEXT,
        reviewed_by_name TEXT,
        reviewed_at TEXT,
        was_edited INTEGER NOT NULL DEFAULT 0 CHECK(was_edited IN (0, 1)),
        rejection_reason TEXT,
        approved_event_id TEXT
      );
    `);
    legacyDb.prepare('INSERT INTO events(id, body) VALUES(?, ?)').run(openEvent.id, JSON.stringify(openEvent));
    const legacySale = {
      type: 'sale',
      date: '2026-11-24',
      counterpartyType: 'customer',
      items: [{ accountId: 'ceyrek', quantity: '1', value: '5000' }],
      received: [{ accountId: 'nakit', quantity: '5000', valueTL: '5000' }],
      given: []
    };
    const legacySummary = { type: 'sale', date: '2026-11-24', customerId: '', customerName: 'Peşin', totalTL: 500000, totalGram: 0, note: '', lines: [], received: [], given: [], credits: [], debts: [] };
    legacyDb.prepare(`
      INSERT INTO pending_submissions(
        id, workspace, status, date, type, submitted_by_id, submitted_by_name, submitted_at, command_json, summary_json
      ) VALUES(?, 'demo', 'pending', '2026-11-24', 'sale', ?, 'Eski Kasiyer', '2026-11-24T09:10:00.000Z', ?, ?)
    `).run('legacy-sub-1', EMP_ID, JSON.stringify(legacySale), JSON.stringify(legacySummary));
  } finally {
    legacyDb.close();
  }

  // Reopen with Repository -> triggers PRAGMA table_info migration
  const repo = new Repository(dbPath, 'demo');
  try {
    const cols = new Set(repo.db.prepare('PRAGMA table_info(pending_submissions)').all().map(c => c.name));
    assert.equal(cols.has('submitted_via_master_pin'), true);
    assert.equal(cols.has('submitted_master_actor_id'), true);

    const row = repo.db.prepare('SELECT id, submitted_via_master_pin, submitted_master_actor_id FROM pending_submissions WHERE id = ?').get('legacy-sub-1');
    assert.equal(row.id, 'legacy-sub-1');
    assert.equal(row.submitted_via_master_pin, 0);
    assert.equal(row.submitted_master_actor_id, null);

    const listed = repo.listPending({ status: 'pending' });
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0].submittedBy, { id: EMP_ID, name: 'Eski Kasiyer' });

    // Approve pre-migration row cleanly
    const approved = repo.approvePending({ id: 'legacy-sub-1', revision: 1, actor: { id: OWNER_ID, name: 'Patron', role: 'owner' } });
    assert.equal(approved.ok, true);
    assert.deepEqual(repo.events().find(e => e.id === 'approve-legacy-sub-1').audit.submittedBy, {
      id: EMP_ID,
      name: 'Eski Kasiyer'
    });

    // New Master PIN submission after migration works cleanly
    const newSub = repo.submitPending(
      {
        id: 'post-mig-mp',
        revision: 2,
        command: { type: 'dailyCount', date: '2026-11-24', counts: { ceyrek: '99' } }
      },
      { actor: { id: EMP_ID, name: 'Eski Kasiyer', role: 'employee', viaMasterPin: true, masterActorId: OWNER_ID } }
    );
    assert.equal(newSub.status, 'pending');
    const postRow = repo.listPending({ status: 'pending' }).find(r => r.id === 'post-mig-mp');
    assert.deepEqual(postRow.submittedBy, {
      id: EMP_ID,
      name: 'Eski Kasiyer',
      viaMasterPin: true,
      masterActorId: OWNER_ID
    });
  } finally {
    repo.close();
  }
});

test('Idempotency rejects differing viaMasterPin or masterActorId on duplicate execute and submitPending IDs', t => {
  const { repo, date } = repoFixture(t);
  const custCmd = { type: 'account', date, name: 'Idemp Müşteri', unit: 'TL', partyType: 'customer', opening: '0' };
  const empNormal = { id: EMP_ID, name: 'Kasiyer', role: 'employee' };
  const empMaster1 = { id: EMP_ID, name: 'Kasiyer', role: 'employee', viaMasterPin: true, masterActorId: OWNER_ID };
  const empMaster2 = { id: EMP_ID, name: 'Kasiyer', role: 'employee', viaMasterPin: true, masterActorId: OWNER_2_ID };

  // 1. Direct execute idempotency with Master PIN
  const first = repo.execute({ id: 'ev-mp-1', revision: 1, command: custCmd }, { actor: empMaster1 });
  assert.equal(first.duplicate, false);
  const same = repo.execute({ id: 'ev-mp-1', revision: 1, command: custCmd }, { actor: empMaster1 });
  assert.equal(same.duplicate, true);
  assert.throws(() => repo.execute({ id: 'ev-mp-1', revision: 1, command: custCmd }, { actor: empNormal }), { name: 'DomainError' });
  assert.throws(() => repo.execute({ id: 'ev-mp-1', revision: 1, command: custCmd }, { actor: empMaster2 }), { name: 'DomainError' });

  // 2. Direct execute idempotency starting from normal employee
  const normFirst = repo.execute({ id: 'ev-norm-1', revision: 2, command: { ...custCmd, name: 'Normal Müşteri' } }, { actor: empNormal });
  assert.equal(normFirst.duplicate, false);
  assert.throws(() => repo.execute({ id: 'ev-norm-1', revision: 2, command: { ...custCmd, name: 'Normal Müşteri' } }, { actor: empMaster1 }), { name: 'DomainError' });

  // 3. submitPending idempotency with Master PIN
  const saleCmd = {
    type: 'sale',
    date,
    counterpartyType: 'customer',
    items: [{ accountId: 'ceyrek', quantity: '1', value: '5000' }],
    received: [{ accountId: 'nakit', quantity: '5000', valueTL: '5000' }],
    given: []
  };
  assert.equal(repo.submitPending({ id: 'sub-mp-1', revision: 3, command: saleCmd }, { actor: empMaster1 }).duplicate, false);
  assert.equal(repo.submitPending({ id: 'sub-mp-1', revision: 3, command: saleCmd }, { actor: empMaster1 }).duplicate, true);
  assert.throws(() => repo.submitPending({ id: 'sub-mp-1', revision: 3, command: saleCmd }, { actor: empNormal }), { name: 'DomainError' });
  assert.throws(() => repo.submitPending({ id: 'sub-mp-1', revision: 3, command: saleCmd }, { actor: empMaster2 }), { name: 'DomainError' });

  // 4. submitPending starting from normal employee rejects Master PIN retry
  assert.equal(repo.submitPending({ id: 'sub-norm-1', revision: 3, command: saleCmd }, { actor: empNormal }).duplicate, false);
  assert.throws(() => repo.submitPending({ id: 'sub-norm-1', revision: 3, command: saleCmd }, { actor: empMaster1 }), { name: 'DomainError' });

  // 5. submitPending rejects invalid Master PIN actor metadata
  assert.throws(
    () => repo.submitPending({ id: 'sub-bad-mp', revision: 3, command: saleCmd }, { actor: { id: OWNER_ID, name: 'Patron', role: 'owner', viaMasterPin: true, masterActorId: OWNER_2_ID } }),
    { name: 'DomainError' }
  );
  assert.throws(
    () => repo.submitPending({ id: 'sub-bad-uuid', revision: 3, command: saleCmd }, { actor: { id: EMP_ID, name: 'Kasiyer', role: 'employee', viaMasterPin: true, masterActorId: 'not-uuid' } }),
    { name: 'DomainError' }
  );
});

test('approvePending idempotency enforces reviewer actor and commandOverride parity while preserving valid retries', t => {
  const { repo, date } = repoFixture(t);
  const owner1 = { id: OWNER_ID, name: 'Patron', role: 'owner' };
  const owner2 = { id: OWNER_2_ID, name: 'Ortak', role: 'owner' };
  const emp = { id: EMP_ID, name: 'Kasiyer', role: 'employee', viaMasterPin: true, masterActorId: OWNER_ID };

  const saleCmd = {
    type: 'sale',
    date,
    counterpartyType: 'customer',
    items: [{ accountId: 'ceyrek', quantity: '1', value: '5000' }],
    received: [{ accountId: 'nakit', quantity: '5000', valueTL: '5000' }],
    given: []
  };

  // 1. Unedited trade approval + valid retries + tampered actor/command rejections
  repo.submitPending({ id: 'sub-ap-plain', revision: 1, command: saleCmd }, { actor: emp });
  const firstPlain = repo.approvePending({ id: 'sub-ap-plain', revision: 1, actor: owner1 });
  assert.equal(firstPlain.duplicate, false);
  assert.equal(firstPlain.wasEdited, false);
  assert.equal(firstPlain.state.revision, 2);

  // Valid retry without commandOverride
  const retryPlain = repo.approvePending({ id: 'sub-ap-plain', revision: 1, actor: owner1 });
  assert.equal(retryPlain.duplicate, true);
  assert.equal(retryPlain.approvedEventId, 'approve-sub-ap-plain');
  assert.equal(retryPlain.wasEdited, false);

  // Valid retry with structurally identical commandOverride (reordered keys, omitted date)
  const reorderedCmd = {
    given: [],
    received: [{ valueTL: '5000', quantity: '5000', accountId: 'nakit' }],
    items: [{ value: '5000', quantity: '1', accountId: 'ceyrek' }],
    counterpartyType: 'customer',
    type: 'sale'
  };
  assert.equal(repo.approvePending({ id: 'sub-ap-plain', revision: 1, actor: owner1, commandOverride: reorderedCmd }).duplicate, true);

  // Different owner actor rejected (409)
  assert.throws(
    () => repo.approvePending({ id: 'sub-ap-plain', revision: 1, actor: owner2 }),
    err => err.name === 'DomainError' && err.status === 409
  );

  // Tampered commandOverride rejected (409)
  const tamperedSale = {
    ...saleCmd,
    items: [{ accountId: 'ceyrek', quantity: '2', value: '10000' }],
    received: [{ accountId: 'nakit', quantity: '10000', valueTL: '10000' }]
  };
  assert.throws(
    () => repo.approvePending({ id: 'sub-ap-plain', revision: 1, actor: owner1, commandOverride: tamperedSale }),
    err => err.name === 'DomainError' && err.status === 409
  );
  assert.throws(
    () => repo.approvePending({ id: 'sub-ap-plain', revision: 1, actor: owner1, commandOverride: 'tampered' }),
    err => err.name === 'DomainError' && err.status === 409
  );
  assert.throws(
    () => repo.approvePending({ id: 'sub-ap-plain', revision: 1, actor: owner1, commandOverride: [] }),
    err => err.name === 'DomainError' && err.status === 409
  );
  assert.throws(
    () => repo.rejectPending({ id: 'sub-ap-plain', reason: 'Sonradan ret', actor: owner1 }),
    err => err.name === 'DomainError' && err.status === 409
  );

  // 2. Edited trade approval + valid retries (with and without commandOverride) + mismatched override rejections
  const editedSale = {
    ...saleCmd,
    items: [{ accountId: 'ceyrek', quantity: '1', value: '5200' }],
    received: [{ accountId: 'nakit', quantity: '5200', valueTL: '5200' }]
  };
  repo.submitPending({ id: 'sub-ap-edit', revision: 2, command: saleCmd }, { actor: emp });
  const firstEdit = repo.approvePending({ id: 'sub-ap-edit', revision: 2, actor: owner1, commandOverride: editedSale });
  assert.equal(firstEdit.duplicate, false);
  assert.equal(firstEdit.wasEdited, true);
  assert.equal(firstEdit.state.revision, 3);

  assert.equal(repo.approvePending({ id: 'sub-ap-edit', revision: 2, actor: owner1, commandOverride: editedSale }).duplicate, true);
  assert.equal(repo.approvePending({ id: 'sub-ap-edit', revision: 2, actor: owner1 }).duplicate, true);
  assert.throws(
    () => repo.approvePending({ id: 'sub-ap-edit', revision: 2, actor: owner2, commandOverride: editedSale }),
    err => err.name === 'DomainError' && err.status === 409
  );
  assert.throws(
    () => repo.approvePending({ id: 'sub-ap-edit', revision: 2, actor: owner1, commandOverride: saleCmd }),
    err => err.name === 'DomainError' && err.status === 409
  );
  assert.throws(
    () => repo.approvePending({ id: 'sub-ap-edit', revision: 2, actor: owner1, commandOverride: tamperedSale }),
    err => err.name === 'DomainError' && err.status === 409
  );

  // 3. dailyCount approval idempotency checks
  repo.submitPending({ id: 'sub-ap-dc', revision: 3, command: { type: 'dailyCount', date, counts: { ceyrek: '100' } } }, { actor: emp });
  assert.equal(repo.approvePending({ id: 'sub-ap-dc', revision: 3, actor: owner1 }).duplicate, false);
  assert.equal(repo.approvePending({ id: 'sub-ap-dc', revision: 3, actor: owner1 }).duplicate, true);
  assert.throws(
    () => repo.approvePending({ id: 'sub-ap-dc', revision: 3, actor: owner2 }),
    err => err.name === 'DomainError' && err.status === 409
  );
  assert.throws(
    () => repo.approvePending({ id: 'sub-ap-dc', revision: 3, actor: owner1, commandOverride: { type: 'dailyCount', date, counts: { ceyrek: '999' } } }),
    err => err.name === 'DomainError' && err.status === 409
  );

  // 4. Stray Master PIN fields on direct JS Repository calls are rejected consistently with eventActor
  const strayActor = { id: EMP_ID, name: 'Kasiyer', role: 'employee', viaMasterPin: false, masterActorId: OWNER_ID };
  assert.throws(
    () => repo.execute({ id: 'ev-stray', revision: 3, command: { type: 'account', date, name: 'Stray', unit: 'TL', partyType: 'customer', opening: '0' } }, { actor: strayActor }),
    { name: 'DomainError' }
  );
  assert.throws(
    () => repo.submitPending({ id: 'sub-stray', revision: 3, command: saleCmd }, { actor: strayActor }),
    { name: 'DomainError' }
  );
  assert.throws(
    () => repo.approvePending({ id: 'sub-ap-plain', revision: 3, actor: { ...owner1, viaMasterPin: true, masterActorId: OWNER_2_ID } }),
    err => err.name === 'DomainError' && err.status === 403
  );
  assert.throws(
    () => repo.rejectPending({ id: 'sub-ap-plain', reason: 'X', actor: { ...owner1, viaMasterPin: true, masterActorId: OWNER_2_ID } }),
    err => err.name === 'DomainError' && err.status === 403
  );

  assert.equal(repo.events().filter(e => e.id === 'approve-sub-ap-plain').length, 1);
  assert.equal(repo.state().revision, 3);
  assert.deepEqual(replay(repo.events()).balances, repo.state().balances);
});

test('POST /api/download-ticket and POST /api/archive/restore block requests when mustChangePin flips mid-body', async t => {
  const { send, repositories, dataDirectory, base } = await httpFixture(t);
  const owner = await (await send('/api/auth/setup', null, { name: 'Patron', pin: '112233' })).json();
  const idDbPath = join(dataDirectory, 'identity.sqlite');

  const flipMustChangePin = value => {
    const db = new DatabaseSync(idDbPath);
    try {
      db.prepare('UPDATE identity_users SET must_change_pin = ? WHERE id = ?').run(value, owner.actor.id);
    } finally {
      db.close();
    }
  };

  // 1. Slow chunked POST /api/download-ticket: flip must_change_pin=1 during await readJson(1024)
  const ticketRes = await new Promise((resolve, reject) => {
    const req = httpRequest(
      new URL('/api/download-ticket?workspace=demo', base),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${owner.token}`,
          'Content-Type': 'application/json'
        }
      },
      res => {
        let body = '';
        res.on('data', chunk => { body += chunk.toString(); });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      }
    );
    req.once('error', reject);
    req.write('{"oper');
    setTimeout(() => {
      try {
        flipMustChangePin(1);
      } catch (err) {
        req.destroy(err);
        return;
      }
      req.end('ation":"backup"}');
    }, 40);
  });
  assert.equal(ticketRes.status, 403);
  assert.equal(ticketRes.body.code, 'PIN_CHANGE_REQUIRED');
  assert.equal(ticketRes.body.url, undefined);

  // 2. Slow chunked POST /api/archive/restore: flip must_change_pin=1 before final line triggers revokeForRestore
  flipMustChangePin(0);
  const archive = await send('/api/archive', owner.token);
  assert.equal(archive.status, 200);
  const lines = (await archive.text()).trimEnd().split('\n');
  const restoreUrl = new URL('/api/archive/restore?' + new URLSearchParams({ revision: '0', confirmation: 'GERİ YÜKLE' }), base);
  const archiveTempDir = join(dataDirectory, '.archive-temp');

  let archiveReq;
  const restorePromise = new Promise((resolve, reject) => {
    archiveReq = httpRequest(
      restoreUrl,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${owner.token}`,
          'Content-Type': 'application/x-ndjson'
        }
      },
      res => {
        let body = '';
        res.on('data', chunk => { body += chunk.toString(); });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      }
    );
    archiveReq.once('error', reject);
    archiveReq.write(lines.slice(0, -1).join('\n') + '\n');
  });

  const deadline = Date.now() + 5000;
  try {
    while (
      Date.now() < deadline &&
      !(existsSync(archiveTempDir) && readdirSync(archiveTempDir, { recursive: true }).some(p => p.endsWith('stage.sqlite')))
    ) {
      await new Promise(r => setTimeout(r, 20));
    }
    assert.ok(existsSync(archiveTempDir) && readdirSync(archiveTempDir, { recursive: true }).some(p => p.endsWith('stage.sqlite')));
    flipMustChangePin(1);
  } finally {
    archiveReq.end(lines.at(-1) + '\n');
  }

  const restoreRes = await restorePromise;
  assert.equal(restoreRes.status, 403);
  assert.equal(restoreRes.body.code, 'PIN_CHANGE_REQUIRED');
  assert.equal(repositories.get('demo').state().revision, 0);

  // Confirm revokeForRestore failed BEFORE invalidateSessions()
  flipMustChangePin(0);
  assert.equal((await send('/api/auth/session', owner.token)).status, 200);
});
