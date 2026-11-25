import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { IdentityStore, IdentityError } from '../identity.mjs';

const password = '482910';
const workerTempPin = '123456';
const workerNewPin = '654321';
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'identity-'));
  let now = 10000000;
  const store = new IdentityStore(directory, { now: () => now });
  t.after(() => store.close());
  return { directory, store, advance: ms => { now += ms; } };
}
async function ownerSession(store) {
  const owner = await store.initializeOwner({ name: 'Sahip', password });
  return { owner, ...(await store.login(owner.id, password)) };
}

test('first owner wins once, also across concurrent connections and restart', async t => {
  const { store, directory } = fixture(t);
  const other = new IdentityStore(directory);
  t.after(() => other.close());
  assert.equal(store.needsSetup(), true);
  const attempts = await Promise.allSettled([store, other].map(s => s.initializeOwner({ name: 'Sahip', password })));
  assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(other.needsSetup(), false);
  await assert.rejects(other.initializeOwner({ name: 'Başka', password }), { name: 'IdentityError', status: 409 });
  assert.equal(store.listUsers().length, 1);
});

test('owner provisions employee with a stable id; secrets and roles are absent from selector', async t => {
  const { store, directory } = fixture(t);
  const { token, owner } = await ownerSession(store);
  const employee = await store.createEmployee(token, { name: 'Çalışan', password, role: 'owner' });
  assert.equal(employee.role, 'employee');
  assert.notEqual(owner.id, employee.id);
  assert.deepEqual(store.listUsers().map(u => Object.keys(u).sort()), [['id', 'name'], ['id', 'name']]);
  const signedIn = await store.login(employee.id, password);
  assert.deepEqual(store.session(signedIn.token), employee);
  await assert.rejects(store.createEmployee(signedIn.token, { name: 'Başka', password }));
  await assert.rejects(store.createEmployee('forged', { name: 'Başka', password }), error => error instanceof IdentityError && error.status === 403);
  assert.throws(() => store.disableUser(signedIn.token, owner.id));
  assert.throws(() => store.disableUser(token, owner.id));
  const db = new DatabaseSync(join(directory, 'identity.sqlite'), { readOnly: true });
  t.after(() => db.close());
  const rows = db.prepare('SELECT salt, verifier FROM identity_users').all();
  assert.equal(rows.length, 2);
  assert.notDeepEqual(rows[0].salt, rows[1].salt);
  assert.notDeepEqual(rows[0].verifier, rows[1].verifier);
  const bytes = readFileSync(join(directory, 'identity.sqlite'));
  for (const secret of [password, token, signedIn.token]) assert.equal(bytes.includes(Buffer.from(secret)), false);
});

test('logout, expiry, invalidation, disablement and restart revoke sessions', async t => {
  const { store, advance, directory } = fixture(t);
  const { token, owner, expiresAt } = await ownerSession(store);
  const employee = await store.createEmployee(token, { name: 'Çalışan', password });
  const a = await store.login(employee.id, password);
  const b = await store.login(employee.id, password);
  assert.notEqual(a.token, b.token);
  assert.equal(store.session(a.token + 'x'), null);
  store.logout(a.token);
  assert.equal(store.session(a.token), null);
  const secondStore = new IdentityStore(directory);
  t.after(() => secondStore.close());
  assert.equal(secondStore.session(b.token), null);
  store.disableUser(token, employee.id);
  assert.equal(store.session(b.token), null);
  assert.equal(await store.login(employee.id, password), null);
  assert.equal(store.listUsers().some(u => u.id === employee.id), false);
  advance(expiresAt - 10000000);
  assert.equal(store.session(token), null);
  const c = await store.login(owner.id, password);
  store.invalidateSessions();
  assert.equal(store.session(c.token), null);
});

test('failures are generic and repeated guessing is limited until the window lapses', async t => {
  const { store, advance } = fixture(t);
  const owner = await store.initializeOwner({ name: 'Sahip', password });
  assert.equal(await store.login('a38d735c-1448-4996-a528-dfeaef9146c2', password), null);
  for (let i = 0; i < 5; i++) assert.equal(await store.login(owner.id, '999999'), null);
  assert.equal(await store.login(owner.id, password), null);
  advance(60001);
  assert.equal((await store.login(owner.id, password)).actor.id, owner.id);
});

test('invalid inputs never create an account or issue a token', async t => {
  const { store } = fixture(t);
  await assert.rejects(store.initializeOwner({ name: '', password }), { name: 'IdentityError', status: 400 });
  await assert.rejects(store.initializeOwner({ name: 'Sahip', password: '12345' }));
  await assert.rejects(store.initializeOwner({ name: 'Sahip', password: '1234567' }));
  await assert.rejects(store.initializeOwner({ name: 'Sahip', password: 'abcdef' }));
  await assert.rejects(store.initializeOwner({ name: 'Sahip', password: 'Sentetik mağaza parolası' }));
  const { owner } = await ownerSession(store);
  for (const invalid of [null, {}, '12345', 'abcdef', 'Sentetik mağaza parolası']) assert.equal(await store.login(owner.id, invalid), null);
  for (const invalid of [null, {}, 'x'.repeat(1000)]) assert.equal(store.session(invalid), null);
});

test('mandatory first-login PIN change, self-service changePin, and owner resetEmployeePin', async t => {
  const { store } = fixture(t);
  const { token: ownerToken, owner } = await ownerSession(store);
  assert.equal(owner.mustChangePin, false);

  const emp = await store.createEmployee(ownerToken, { name: 'Kasiyer', pin: workerTempPin });
  assert.equal(emp.mustChangePin, true);

  const empSession = await store.login(emp.id, workerTempPin);
  assert.equal(empSession.actor.mustChangePin, true);

  // Cannot reuse temporary PIN as new PIN
  await assert.rejects(store.changePin(empSession.token, { currentPin: workerTempPin, newPin: workerTempPin }), { status: 400 });
  // Wrong current PIN returns 401
  await assert.rejects(store.changePin(empSession.token, { currentPin: '000000', newPin: workerNewPin }), { status: 401 });

  // Valid PIN change clears mustChangePin
  const updated = await store.changePin(empSession.token, { currentPin: workerTempPin, newPin: workerNewPin });
  assert.equal(updated.mustChangePin, false);
  assert.equal(await store.login(emp.id, workerTempPin), null);
  const empSession2 = await store.login(emp.id, workerNewPin);
  assert.equal(empSession2.actor.mustChangePin, false);

  // Owner resets employee PIN -> revokes active employee sessions and sets mustChangePin = true
  await store.resetEmployeePin(ownerToken, { id: emp.id, newPin: '777888' });
  assert.equal(store.session(empSession.token), null);
  assert.equal(store.session(empSession2.token), null);
  assert.equal(await store.login(emp.id, workerNewPin), null);
  const afterReset = await store.login(emp.id, '777888');
  assert.equal(afterReset.actor.mustChangePin, true);

  // Owner changes own PIN with old PIN verification
  const ownerUpdated = await store.changePin(ownerToken, { currentPin: password, newPin: '334455' });
  assert.equal(ownerUpdated.role, 'owner');
  assert.equal(await store.login(owner.id, password), null);
  assert.equal((await store.login(owner.id, '334455')).actor.id, owner.id);
  // loginByName supports Turkish case-insensitive match and rejects unknown usernames
  assert.equal((await store.loginByName('  sahip ', '334455')).actor.id, owner.id);
  assert.equal(await store.loginByName('Bilinmeyen Kişi', '334455'), null);
});

test('will not attach identity records to a financial or foreign SQLite database', t => {
  const directory = mkdtempSync(join(tmpdir(), 'identity-foreign-'));
  const db = new DatabaseSync(join(directory, 'identity.sqlite'));
  t.after(() => db.close());
  db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY)');
  assert.throws(() => new IdentityStore(directory));
  assert.deepEqual(db.prepare('SELECT name FROM sqlite_schema').all().map(r => r.name), ['events']);
});

test('active display names remain distinct in the selector under concurrent provisioning', async t => {
  const { store } = fixture(t);
  const { token } = await ownerSession(store);
  await assert.rejects(store.createEmployee(token, { name: ' SAHİP ', password }), { status: 409 });
  const attempts = await Promise.allSettled(['Çalışan', 'çalışan'].map(name => store.createEmployee(token, { name, password })));
  const created = attempts.filter(result => result.status === 'fulfilled');
  assert.equal(created.length, 1);
  assert.equal(attempts.find(result => result.status === 'rejected').reason.status, 409);
  store.disableUser(token, created[0].value.id);
  const replacement = await store.createEmployee(token, { name: 'Çalışan', password });
  assert.notEqual(replacement.id, created[0].value.id);
});

test('restore invalidates other editor connections and logins already computing their password hash', async t => {
  const { store, directory } = fixture(t);
  const { owner, token } = await ownerSession(store);
  const other = new IdentityStore(directory);
  t.after(()=>other.close());
  const session = await other.login(owner.id,password);
  const inFlight = other.login(owner.id,password);
  store.invalidateSessions();
  assert.equal(store.session(token),null);
  assert.equal(other.session(session.token),null);
  assert.equal(await inFlight,null);
  assert.deepEqual((await other.login(owner.id,password)).actor,owner);
});

function removeTempDir(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

function createBarrierWorkerPool(workerCount) {
  const sab = new SharedArrayBuffer(8);
  const ctrl = new Int32Array(sab);
  const identityUrl = new URL('../identity.mjs', import.meta.url).href;
  const workerCode = `
    import { parentPort, workerData } from 'node:worker_threads';
    const { IdentityStore } = await import(workerData.identityUrl);
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
      let store;
      let reply;
      try {
        store = new IdentityStore(msg.dir);
        reply = {
          ok: true,
          needsSetup: store.needsSetup(),
          users: store.listUsers()
        };
      } catch (err) {
        reply = {
          ok: false,
          name: err?.name,
          code: err?.code,
          message: err?.message
        };
      } finally {
        try { store?.close(); } catch {}
      }
      parentPort.postMessage(reply);
    });
  `;

  const workers = Array.from({ length: workerCount }, () =>
    new Worker(workerCode, { eval: true, workerData: { identityUrl, sab } })
  );

  const runTrial = dir => {
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
        worker.postMessage({ dir, count: workerCount });
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

test('concurrent cold-start IdentityStore initialization succeeds across 8 barrier-synchronized workers x 20 trials', async t => {
  const root = mkdtempSync(join(tmpdir(), 'identity-cold-pool-'));
  const pool = createBarrierWorkerPool(8);
  t.after(async () => {
    await pool.close();
    removeTempDir(root);
  });

  for (let trial = 0; trial < 20; trial++) {
    const trialDir = join(root, `fresh-${trial}`);
    mkdirSync(trialDir, { recursive: true });
    const results = await pool.runTrial(trialDir);
    assert.equal(results.length, 8);
    assert.deepEqual(
      results.filter(r => !r.ok),
      [],
      `Trial ${trial} had unexpected cold-start failures: ${JSON.stringify(results)}`
    );
    for (const r of results) {
      assert.equal(r.needsSetup, true);
      assert.deepEqual(r.users, []);
    }

    const db = new DatabaseSync(join(trialDir, 'identity.sqlite'), { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA application_id').get().application_id, 1163086153);
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4);
      assert.equal(String(db.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(), 'wal');
      assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 2);
    } finally {
      db.close();
    }
  }
});

test('concurrent v1->v4 DELETE-mode upgrade succeeds across 4 barrier-synchronized workers x 20 trials', async t => {
  const root = mkdtempSync(join(tmpdir(), 'identity-v1-pool-'));
  const pool = createBarrierWorkerPool(4);
  t.after(async () => {
    await pool.close();
    removeTempDir(root);
  });

  for (let trial = 0; trial < 20; trial++) {
    const trialDir = join(root, `v1-${trial}`);
    mkdirSync(trialDir, { recursive: true });
    const dbFile = join(trialDir, 'identity.sqlite');
    const ownerId = `owner-${trial}`;
    const seedDb = new DatabaseSync(dbFile);
    try {
      seedDb.exec(`
        PRAGMA journal_mode = DELETE;
        CREATE TABLE identity_users (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('owner', 'employee')),
          enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
          salt BLOB NOT NULL CHECK(length(salt) = 16),
          verifier BLOB NOT NULL CHECK(length(verifier) = 32)
        ) STRICT;
        CREATE TABLE login_limits (
          bucket TEXT PRIMARY KEY NOT NULL, until_ms INTEGER NOT NULL, attempts INTEGER NOT NULL
        ) STRICT;
        PRAGMA application_id = 1163086153;
        PRAGMA user_version = 1;
      `);
      seedDb.prepare(
        "INSERT INTO identity_users (id, name, role, enabled, salt, verifier) VALUES (?, 'Sahip', 'owner', 1, ?, ?)"
      ).run(ownerId, randomBytes(16), randomBytes(32));
    } finally {
      seedDb.close();
    }

    const seededBytes = readFileSync(dbFile);
    assert.equal(seededBytes[18], 1);
    assert.equal(seededBytes[19], 1);

    const results = await pool.runTrial(trialDir);
    assert.equal(results.length, 4);
    assert.deepEqual(
      results.filter(r => !r.ok),
      [],
      `Trial ${trial} had unexpected v1->v4 upgrade failures: ${JSON.stringify(results)}`
    );
    for (const r of results) {
      assert.equal(r.needsSetup, false);
      assert.deepEqual(r.users, [{ id: ownerId, name: 'Sahip' }]);
    }

    const verifyDb = new DatabaseSync(dbFile, { readOnly: true });
    try {
      assert.equal(verifyDb.prepare('PRAGMA application_id').get().application_id, 1163086153);
      assert.equal(verifyDb.prepare('PRAGMA user_version').get().user_version, 4);
      assert.equal(String(verifyDb.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(), 'wal');
      assert.equal(verifyDb.prepare('PRAGMA synchronous').get().synchronous, 2);
      const genRows = verifyDb.prepare('SELECT generation FROM session_generation').all();
      assert.equal(genRows.length, 1);
      assert.ok(typeof genRows[0].generation === 'string' && genRows[0].generation.length > 0);
      const userRow = verifyDb.prepare('SELECT must_change_pin FROM identity_users WHERE id = ?').get(ownerId);
      assert.equal(userRow.must_change_pin, 0);
    } finally {
      verifyDb.close();
    }
  }
});

test('4-variant foreign DELETE-mode SQLite databases reject concurrently without mutating header [18..19] or creating WAL sidecars', async t => {
  const root = mkdtempSync(join(tmpdir(), 'identity-foreign-pool-'));
  const pool = createBarrierWorkerPool(4);
  t.after(async () => {
    await pool.close();
    removeTempDir(root);
  });

  const variants = [
    ['table-no-appid', 'PRAGMA journal_mode = DELETE; CREATE TABLE foreign_tbl (id INTEGER PRIMARY KEY);'],
    ['foreign-appid', 'PRAGMA journal_mode = DELETE; PRAGMA application_id = 999999; PRAGMA user_version = 1; CREATE TABLE custom (x TEXT);'],
    ['empty-nonzero-uv', 'PRAGMA journal_mode = DELETE; PRAGMA user_version = 1;'],
    ['unsupported-uv-99', 'PRAGMA journal_mode = DELETE; PRAGMA application_id = 1163086153; PRAGMA user_version = 99;']
  ];

  for (const [label, sql] of variants) {
    const variantDir = join(root, label);
    mkdirSync(variantDir, { recursive: true });
    const dbFile = join(variantDir, 'identity.sqlite');
    const db = new DatabaseSync(dbFile);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }

    const beforeBytes = readFileSync(dbFile);
    assert.equal(beforeBytes[18], 1, `${label} header[18] should start in DELETE mode`);
    assert.equal(beforeBytes[19], 1, `${label} header[19] should start in DELETE mode`);

    const results = await pool.runTrial(variantDir);
    assert.equal(results.length, 4);
    for (const r of results) {
      assert.equal(r.ok, false);
      assert.equal(r.name, 'Error');
      assert.match(r.message, /Desteklenmeyen kimlik veritabanı/);
    }

    const afterBytes = readFileSync(dbFile);
    assert.deepEqual(afterBytes, beforeBytes);
    assert.equal(afterBytes[18], 1);
    assert.equal(afterBytes[19], 1);
    assert.equal(existsSync(`${dbFile}-wal`), false);
    assert.equal(existsSync(`${dbFile}-shm`), false);
  }
});