import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { INITIAL_ACCOUNTS } from '../domain.mjs';
import { IdentityError, IdentityStore, sanitizeAuditDetail } from '../identity.mjs';
import { Repository } from '../repository.mjs';
import { createBackupBundle, restoreBackupBundle } from '../scripts/backup-bundle.mjs';

const OWNER_PIN = '482910';
const EMP_TEMP_PIN = '123456';
const EMP_PIN = '654321';
const ALT_PIN = '778899';
const RESET_PIN = '918273';
const WRONG_PIN = '999999';
const PASSWORD_OPTIONS = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const RESET_SCRIPT_PATH = resolve(fileURLToPath(import.meta.url), '../../scripts/reset-owner-pin.mjs');

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function removeTempDir(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

function fixture(t, options = {}) {
  const directory = makeTempDir('p2-pin-audit-');
  let now = options.initialNow ?? 10_000_000;
  const store = new IdentityStore(directory, {
    now: () => now,
    ...(options.allowMasterFallback !== undefined ? { allowMasterFallback: options.allowMasterFallback } : {})
  });
  const closers = [() => store.close()];
  t.after(() => {
    for (const fn of closers.reverse()) {
      try { fn(); } catch {}
    }
    removeTempDir(directory);
  });
  return {
    directory,
    store,
    trackClose: fn => closers.push(fn),
    now: () => now,
    advance: ms => { now += ms; }
  };
}

function openingBalances(overrides = {}) {
  return Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, overrides[a.id] ?? '0']));
}

test('F4: allowMasterFallback=false strictly disables viaMasterPin across login and loginByName while preserving local default', async t => {
  const { directory, store, trackClose } = fixture(t);
  const owner = await store.initializeOwner({ name: 'İşletme Sahibi', pin: OWNER_PIN });
  const ownerLogin = await store.login(owner.id, OWNER_PIN);
  const emp = await store.createEmployee(ownerLogin.token, { name: 'Kasiyer Ali', pin: EMP_TEMP_PIN });
  const empTemp = await store.login(emp.id, EMP_TEMP_PIN);
  await store.changePin(empTemp.token, { currentPin: EMP_TEMP_PIN, newPin: EMP_PIN });

  // Local default (allowMasterFallback: true) permits employee login via owner PIN.
  const localById = await store.login(emp.id, OWNER_PIN);
  assert.ok(localById);
  assert.equal(localById.actor.id, emp.id);
  assert.equal(localById.actor.viaMasterPin, true);
  assert.equal(localById.actor.masterActorId, owner.id);
  assert.equal(localById.actor.mustChangePin, false);

  const localByName = await store.loginByName('kasiyer ali', OWNER_PIN);
  assert.ok(localByName);
  assert.equal(localByName.actor.viaMasterPin, true);
  assert.equal(localByName.actor.masterActorId, owner.id);

  // Cloud/proxy store (allowMasterFallback: false) must reject owner PIN for employees.
  const cloudStore = new IdentityStore(directory, { allowMasterFallback: false });
  trackClose(() => cloudStore.close());

  assert.equal(await cloudStore.login(emp.id, OWNER_PIN), null);
  assert.equal(await cloudStore.loginByName('Kasiyer Ali', OWNER_PIN), null);

  // Owner own login and employee own-PIN login continue to work normally.
  const cloudOwner = await cloudStore.login(owner.id, OWNER_PIN);
  assert.ok(cloudOwner);
  assert.equal(cloudOwner.actor.viaMasterPin, undefined);

  const cloudEmp = await cloudStore.login(emp.id, EMP_PIN);
  assert.ok(cloudEmp);
  assert.equal(cloudEmp.actor.id, emp.id);
  assert.equal(cloudEmp.actor.viaMasterPin, undefined);

  const cloudEmpByName = await cloudStore.loginByName('Kasiyer Ali', EMP_PIN);
  assert.ok(cloudEmpByName);
  assert.equal(cloudEmpByName.actor.viaMasterPin, undefined);

  const failedAudits = cloudStore.listAuthAudit({ eventType: 'login_failed', limit: 10 }).entries;
  assert.equal(failedAudits.length, 2);
  assert.equal(failedAudits[0].targetId, emp.id);
  assert.equal(failedAudits[1].targetId, emp.id);
});

test('F5: progressive PIN lockout escalates 5->60s, 10->5m, 15+->15m without resetting on expiry and clears on success', async t => {
  const { store, advance, directory, trackClose } = fixture(t);
  const owner = await store.initializeOwner({ name: 'Sahip', pin: OWNER_PIN });

  // Failures 1..4 do not lock.
  for (let i = 0; i < 4; i++) {
    assert.equal(await store.login(owner.id, WRONG_PIN), null);
  }
  const checkBeforeLock = await store.login(owner.id, OWNER_PIN);
  assert.ok(checkBeforeLock);
  store.logout(checkBeforeLock.token);

  // Escalate from 1..5 -> 60s lock.
  for (let i = 0; i < 5; i++) {
    assert.equal(await store.login(owner.id, WRONG_PIN), null);
  }
  assert.equal(await store.login(owner.id, OWNER_PIN), null);
  advance(59_999);
  assert.equal(await store.login(owner.id, OWNER_PIN), null);
  advance(2); // total 60_001ms elapsed
  // Failures 6..9 keep 60s lock without resetting attempts to 0.
  for (let i = 6; i <= 9; i++) {
    assert.equal(await store.login(owner.id, WRONG_PIN), null);
    assert.equal(await store.login(owner.id, OWNER_PIN), null);
    advance(60_001);
  }

  // Failure 10 triggers 5-minute (300_000ms) lock.
  assert.equal(await store.login(owner.id, WRONG_PIN), null);
  advance(60_001);
  assert.equal(await store.login(owner.id, OWNER_PIN), null); // still locked after 60s!
  advance(239_998); // total 299_999ms elapsed
  assert.equal(await store.login(owner.id, OWNER_PIN), null); // still locked 1ms before 5m
  advance(2); // total 300_001ms elapsed

  // Failures 11..14 each lock 5m:
  for (let i = 11; i <= 14; i++) {
    assert.equal(await store.login(owner.id, WRONG_PIN), null);
    advance(299_999);
    assert.equal(await store.login(owner.id, OWNER_PIN), null);
    advance(2); // total 300_001ms
  }

  // Failure 15 triggers 15-minute (900_000ms) lock.
  assert.equal(await store.login(owner.id, WRONG_PIN), null);
  advance(300_001);
  assert.equal(await store.login(owner.id, OWNER_PIN), null); // still locked after 5m!
  advance(599_998); // total 899_999ms
  assert.equal(await store.login(owner.id, OWNER_PIN), null);
  advance(2); // total 900_001ms

  // Valid login succeeds and clears the user bucket back to 0.
  const recovered = await store.login(owner.id, OWNER_PIN);
  assert.ok(recovered);

  const db = new DatabaseSync(join(directory, 'identity.sqlite'), { readOnly: true });
  trackClose(() => db.close());
  assert.equal(db.prepare('SELECT * FROM login_limits WHERE bucket = ?').get(owner.id), undefined);

  // Confirm reset: 4 new failures do NOT lock on attempt 4.
  for (let i = 0; i < 4; i++) {
    assert.equal(await store.login(owner.id, WRONG_PIN), null);
  }
  assert.ok(await store.login(owner.id, OWNER_PIN));
});

test('F5: progressive lockout also protects changePin (429) and loginByName, and prunes stale buckets after 24h', async t => {
  const { store, advance, directory, trackClose } = fixture(t);
  const owner = await store.initializeOwner({ name: 'Sahip', pin: OWNER_PIN });
  const ownerLogin = await store.login(owner.id, OWNER_PIN);

  // 5 failed changePin attempts lock the user and raise 429 on 6th attempt.
  for (let i = 0; i < 5; i++) {
    await assert.rejects(
      store.changePin(ownerLogin.token, { currentPin: WRONG_PIN, newPin: ALT_PIN }, { clientKey: 'ip:198.51.100.5' }),
      error => error instanceof IdentityError && error.status === 401
    );
  }
  await assert.rejects(
    store.changePin(ownerLogin.token, { currentPin: OWNER_PIN, newPin: ALT_PIN }, { clientKey: 'ip:198.51.100.5' }),
    error => error instanceof IdentityError && error.status === 429 && error.retryAfterSeconds === 60
  );

  // After 60s, valid changePin succeeds and clears both user and clientKey buckets.
  advance(60_001);
  const updated = await store.changePin(
    ownerLogin.token,
    { currentPin: OWNER_PIN, newPin: ALT_PIN },
    { clientKey: 'ip:198.51.100.5' }
  );
  assert.equal(updated.id, owner.id);

  // Verify 24h stale-bucket retention works even when injected now < 24h (10_000_000ms).
  assert.equal(await store.loginByName('Bilinmeyen Kişi', WRONG_PIN, { clientKey: 'ip:203.0.113.99' }), null);
  const db = new DatabaseSync(join(directory, 'identity.sqlite'), { readOnly: true });
  trackClose(() => db.close());
  assert.ok(db.prepare("SELECT * FROM login_limits WHERE bucket = 'client:ip:203.0.113.99'").get());

  // Advance < 24h -> bucket retained; advance >= 24h -> stale bucket pruned.
  advance(23 * 60 * 60_000);
  assert.ok(await store.loginByName('Sahip', ALT_PIN));
  assert.ok(db.prepare("SELECT * FROM login_limits WHERE bucket = 'client:ip:203.0.113.99'").get());

  advance(60 * 60_000 + 1);
  assert.ok(await store.loginByName('Sahip', ALT_PIN));
  assert.equal(db.prepare("SELECT * FROM login_limits WHERE bucket = 'client:ip:203.0.113.99'").get(), undefined);
});

test('F5: clientKey bucket isolates source brute force and prevents bucket-namespace collisions', async t => {
  const { store, advance } = fixture(t);
  const owner = await store.initializeOwner({ name: 'Sahip', pin: OWNER_PIN });
  const ownerLogin = await store.login(owner.id, OWNER_PIN);
  const emp = await store.createEmployee(ownerLogin.token, { name: 'Kasiyer', pin: EMP_TEMP_PIN });

  // 5 failures from client A on owner lock client A across ALL users, while client B can still log in as emp.
  for (let i = 0; i < 5; i++) {
    assert.equal(await store.login(owner.id, WRONG_PIN, { clientKey: 'ip:203.0.113.10' }), null);
  }
  assert.equal(await store.login(emp.id, EMP_TEMP_PIN, { clientKey: 'ip:203.0.113.10' }), null);

  // Client B cannot log in as locked owner, but CAN log in as untouched emp.
  assert.equal(await store.login(owner.id, OWNER_PIN, { clientKey: 'ip:198.51.100.20' }), null);
  const empOk = await store.login(emp.id, EMP_TEMP_PIN, { clientKey: 'ip:198.51.100.20' });
  assert.ok(empOk);

  // Collision safety: literal '*', user UUID, 'name:sahip', and oversized/control-char clientKeys map to disjoint buckets.
  assert.equal(await store.loginByName('Bilinmeyen', WRONG_PIN, { clientKey: '*' }), null);
  assert.equal(await store.loginByName('Bilinmeyen', WRONG_PIN, { clientKey: emp.id }), null);
  assert.equal(await store.loginByName('Bilinmeyen', WRONG_PIN, { clientKey: 'name:sahip' }), null);
  assert.equal(await store.loginByName('Bilinmeyen', WRONG_PIN, { clientKey: 'bad\nkey\u0000' + 'x'.repeat(200) }), null);

  // Emp can still log in from a clean client despite clientKey = emp.id having had 1 failed unknown-name attempt.
  assert.ok(await store.login(emp.id, EMP_TEMP_PIN, { clientKey: 'ip:198.51.100.21' }));

  // '*' global 60s burst window stays independent of 24h retention and clears after 60s.
  advance(60_001);
  assert.ok(await store.login(owner.id, OWNER_PIN, { clientKey: 'ip:203.0.113.10' }));
});

test('F6: user_version = 4 migrations from v1, v2, and v3 DELETE-mode databases preserve credentials and migrate cleanly', async () => {
  // v1 DB
  {
    const dir = makeTempDir('p2-mig-v1-');
    let store;
    let db;
    try {
      const salt = randomBytes(16);
      const verifier = scryptSync(OWNER_PIN, salt, 32, PASSWORD_OPTIONS);
      const seed = new DatabaseSync(join(dir, 'identity.sqlite'));
      seed.exec(`
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
      seed.prepare("INSERT INTO identity_users (id, name, role, enabled, salt, verifier) VALUES (?, 'Sahip v1', 'owner', 1, ?, ?)")
        .run('11111111-1111-4111-8111-111111111111', salt, verifier);
      seed.close();

      store = new IdentityStore(dir);
      const s = await store.login('11111111-1111-4111-8111-111111111111', OWNER_PIN);
      assert.ok(s);
      assert.equal(s.actor.mustChangePin, false);
      db = new DatabaseSync(join(dir, 'identity.sqlite'), { readOnly: true });
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4);
      assert.equal(store.listAuthAudit({ eventType: 'login_success' }).total, 1);
    } finally {
      try { db?.close(); } catch {}
      try { store?.close(); } catch {}
      removeTempDir(dir);
    }
  }

  // v2 DB
  {
    const dir = makeTempDir('p2-mig-v2-');
    let store;
    let db;
    try {
      const salt = randomBytes(16);
      const verifier = scryptSync(OWNER_PIN, salt, 32, PASSWORD_OPTIONS);
      const seed = new DatabaseSync(join(dir, 'identity.sqlite'));
      seed.exec(`
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
        CREATE TABLE session_generation (id INTEGER PRIMARY KEY CHECK(id = 1), generation TEXT NOT NULL) STRICT;
        INSERT INTO session_generation VALUES (1, 'gen-v2');
        PRAGMA application_id = 1163086153;
        PRAGMA user_version = 2;
      `);
      seed.prepare("INSERT INTO identity_users (id, name, role, enabled, salt, verifier) VALUES (?, 'Sahip v2', 'owner', 1, ?, ?)")
        .run('22222222-2222-4222-8222-222222222222', salt, verifier);
      seed.close();

      store = new IdentityStore(dir);
      assert.ok(await store.login('22222222-2222-4222-8222-222222222222', OWNER_PIN));
      db = new DatabaseSync(join(dir, 'identity.sqlite'), { readOnly: true });
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4);
      assert.ok(db.prepare('PRAGMA table_info(login_limits)').all().some(c => c.name === 'last_attempt_ms'));
    } finally {
      try { db?.close(); } catch {}
      try { store?.close(); } catch {}
      removeTempDir(dir);
    }
  }

  // v3 DB with legacy login_limits row
  {
    const dir = makeTempDir('p2-mig-v3-');
    let store;
    let db;
    try {
      const salt = randomBytes(16);
      const verifier = scryptSync(OWNER_PIN, salt, 32, PASSWORD_OPTIONS);
      const seed = new DatabaseSync(join(dir, 'identity.sqlite'));
      seed.exec(`
        PRAGMA journal_mode = DELETE;
        CREATE TABLE identity_users (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('owner', 'employee')),
          enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
          must_change_pin INTEGER NOT NULL DEFAULT 0 CHECK(must_change_pin IN (0, 1)),
          salt BLOB NOT NULL CHECK(length(salt) = 16),
          verifier BLOB NOT NULL CHECK(length(verifier) = 32)
        ) STRICT;
        CREATE TABLE login_limits (
          bucket TEXT PRIMARY KEY NOT NULL, until_ms INTEGER NOT NULL, attempts INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE session_generation (id INTEGER PRIMARY KEY CHECK(id = 1), generation TEXT NOT NULL) STRICT;
        INSERT INTO session_generation VALUES (1, 'gen-v3');
        INSERT INTO login_limits VALUES ('33333333-3333-4333-8333-333333333333', 9000000, 3);
        PRAGMA application_id = 1163086153;
        PRAGMA user_version = 3;
      `);
      seed.prepare("INSERT INTO identity_users (id, name, role, enabled, must_change_pin, salt, verifier) VALUES (?, 'Sahip v3', 'owner', 1, 0, ?, ?)")
        .run('33333333-3333-4333-8333-333333333333', salt, verifier);
      seed.close();

      let now = 10_000_000;
      store = new IdentityStore(dir, { now: () => now });
      assert.ok(await store.login('33333333-3333-4333-8333-333333333333', OWNER_PIN));
      db = new DatabaseSync(join(dir, 'identity.sqlite'), { readOnly: true });
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4);
      assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='auth_audit_log'").get().name, 'auth_audit_log');
    } finally {
      try { db?.close(); } catch {}
      try { store?.close(); } catch {}
      removeTempDir(dir);
    }
  }
});

test('F6: backup-bundle supports v4 bundles, restores legacy v3 bundles to v4, and rejects v4 bundles missing auth_audit_log', async () => {
  const root = makeTempDir('p2-backup-v3-v4-');
  let restoredId;
  let upgradedV3Db;
  try {
    const dataDir = join(root, 'data');
    const bundleOut = join(root, 'bundles');
    const restoreDir = join(root, 'restored');
    const tempDir = join(root, 'tmp');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(bundleOut, { recursive: true });
    mkdirSync(tempDir, { recursive: true });

    // Seed v4 identity + minimal dukkan ledger
    const identity = new IdentityStore(dataDir);
    const owner = await identity.initializeOwner({ name: 'Sahip', pin: OWNER_PIN });
    const ownerLogin = await identity.login(owner.id, OWNER_PIN);
    identity.close();

    const dukkan = new Repository(join(dataDir, 'dukkan.sqlite'), 'dukkan');
    dukkan.execute({
      id: 'p2-open-1',
      revision: 0,
      command: { type: 'opening', date: '2026-11-24', balances: openingBalances({ nakit: '10000' }) }
    }, { actor: ownerLogin.actor });
    dukkan.close();

    // 1) Create and restore v4 bundle
    const created = await createBackupBundle({ dataDirectory: dataDir, outputDirectory: bundleOut, tempDirectory: tempDir });
    const restored = await restoreBackupBundle({
      bundleDirectory: created.bundleDirectory,
      targetDirectory: restoreDir,
      tempDirectory: tempDir
    });
    assert.equal(restored.ok, true);
    assert.equal(restored.sessionGenerationRotated, true);

    restoredId = new IdentityStore(restoreDir);
    assert.ok(restoredId.listAuthAudit({ limit: 50 }).total >= 2);
    restoredId.close();
    restoredId = null;

    // 2) Tamper v4 bundle copy by dropping auth_audit_log and updating its sha256/manifest -> must fail IDENTITY_SCHEMA_INVALID
    const tamperedBundle = join(root, 'tampered-v4');
    mkdirSync(tamperedBundle, { recursive: true });
    for (const name of ['dukkan.sqlite', 'identity.sqlite', 'bundle-manifest.json']) {
      writeFileSync(join(tamperedBundle, name), readFileSync(join(created.bundleDirectory, name)));
    }
    const tamperDb = new DatabaseSync(join(tamperedBundle, 'identity.sqlite'));
    tamperDb.exec('DROP TABLE auth_audit_log;');
    tamperDb.close();
    const manifest = JSON.parse(readFileSync(join(tamperedBundle, 'bundle-manifest.json'), 'utf8'));
    const idEntry = manifest.databases.find(d => d.role === 'identity');
    const idBytes = readFileSync(join(tamperedBundle, 'identity.sqlite'));
    idEntry.sizeBytes = idBytes.length;
    idEntry.sha256 = createHash('sha256').update(idBytes).digest('hex');
    writeFileSync(join(tamperedBundle, 'bundle-manifest.json'), JSON.stringify(manifest, null, 2));

    await assert.rejects(
      restoreBackupBundle({ bundleDirectory: tamperedBundle, targetDirectory: join(root, 'tampered-target'), tempDirectory: tempDir }),
      error => error.code === 'IDENTITY_SCHEMA_INVALID'
    );

    // 3) Legacy v3 bundle without auth_audit_log restores cleanly and upgrades to v4
    const v3Bundle = join(root, 'legacy-v3');
    mkdirSync(v3Bundle, { recursive: true });
    writeFileSync(join(v3Bundle, 'dukkan.sqlite'), readFileSync(join(created.bundleDirectory, 'dukkan.sqlite')));
    const salt = randomBytes(16);
    const verifier = scryptSync(OWNER_PIN, salt, 32, PASSWORD_OPTIONS);
    const v3Db = new DatabaseSync(join(v3Bundle, 'identity.sqlite'));
    v3Db.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE identity_users (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('owner', 'employee')),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
        must_change_pin INTEGER NOT NULL DEFAULT 0 CHECK(must_change_pin IN (0, 1)),
        salt BLOB NOT NULL CHECK(length(salt) = 16),
        verifier BLOB NOT NULL CHECK(length(verifier) = 32)
      ) STRICT;
      CREATE TABLE login_limits (
        bucket TEXT PRIMARY KEY NOT NULL, until_ms INTEGER NOT NULL, attempts INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE session_generation (id INTEGER PRIMARY KEY CHECK(id = 1), generation TEXT NOT NULL) STRICT;
      INSERT INTO session_generation VALUES (1, 'legacy-v3-gen');
      PRAGMA application_id = 1163086153;
      PRAGMA user_version = 3;
    `);
    v3Db.prepare("INSERT INTO identity_users VALUES (?, 'Eski Sahip', 'owner', 1, 0, ?, ?)").run(owner.id, salt, verifier);
    v3Db.close();

    const v3Inspect = new DatabaseSync(join(v3Bundle, 'identity.sqlite'), { readOnly: true });
    const v3SchemaVersion = v3Inspect.prepare('PRAGMA schema_version').get().schema_version;
    v3Inspect.close();
    const v3Bytes = readFileSync(join(v3Bundle, 'identity.sqlite'));
    const v3Manifest = JSON.parse(readFileSync(join(created.bundleDirectory, 'bundle-manifest.json'), 'utf8'));
    const v3IdEntry = v3Manifest.databases.find(d => d.role === 'identity');
    v3IdEntry.userVersion = 3;
    v3IdEntry.schemaVersion = v3SchemaVersion;
    v3IdEntry.sizeBytes = v3Bytes.length;
    v3IdEntry.sha256 = createHash('sha256').update(v3Bytes).digest('hex');
    writeFileSync(join(v3Bundle, 'bundle-manifest.json'), JSON.stringify(v3Manifest, null, 2));

    const v3Target = join(root, 'restored-v3-target');
    const v3Restored = await restoreBackupBundle({ bundleDirectory: v3Bundle, targetDirectory: v3Target, tempDirectory: tempDir });
    assert.equal(v3Restored.ok, true);

    upgradedV3Db = new DatabaseSync(join(v3Target, 'identity.sqlite'), { readOnly: true });
    assert.equal(upgradedV3Db.prepare('PRAGMA user_version').get().user_version, 4);
    assert.equal(upgradedV3Db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='auth_audit_log'").get().name, 'auth_audit_log');
  } finally {
    try { upgradedV3Db?.close(); } catch {}
    try { restoredId?.close(); } catch {}
    removeTempDir(root);
  }
});

test('F6: auth_audit_log records all lifecycle events, supports pagination/filtering, and leaks zero secrets or financial data', async t => {
  const { store, directory, advance, trackClose } = fixture(t);
  const unknownTypedName = 'GizliPinTahmini987654';
  const unknownLowerSecret = 'gizlipinlowercase987654';
  const owner = await store.initializeOwner({ name: 'Sahip', pin: OWNER_PIN }, { source: 'local-setup' });
  const ownerLogin = await store.login(owner.id, OWNER_PIN, { clientKey: 'ip:127.0.0.1' });
  const emp = await store.createEmployee(ownerLogin.token, { name: 'Kasiyer', pin: EMP_TEMP_PIN });
  const empMasterLogin = await store.login(emp.id, OWNER_PIN, { clientKey: 'ip:127.0.0.1' });
  const empSelfLogin = await store.loginByName('Kasiyer', EMP_TEMP_PIN, { clientKey: 'ip:127.0.0.2' });

  // Failed & locked login attempts on emp, plus accidental 6-digit PIN and lowercase unknown username
  assert.equal(await store.loginByName(unknownTypedName, WRONG_PIN, { clientKey: 'ip:203.0.113.50' }), null);
  assert.equal(await store.loginByName(OWNER_PIN, WRONG_PIN, { clientKey: 'ip:203.0.113.52' }), null);
  assert.equal(await store.loginByName(unknownLowerSecret, WRONG_PIN, { clientKey: 'ip:203.0.113.53' }), null);
  for (let i = 0; i < 5; i++) {
    assert.equal(await store.login(emp.id, WRONG_PIN, { clientKey: 'ip:203.0.113.51' }), null);
  }
  assert.equal(await store.login(emp.id, EMP_TEMP_PIN, { clientKey: 'ip:203.0.113.51' }), null);

  const dbPreReset = new DatabaseSync(join(directory, 'identity.sqlite'), { readOnly: true });
  trackClose(() => dbPreReset.close());
  const limitBuckets = dbPreReset.prepare('SELECT bucket FROM login_limits').all().map(r => r.bucket);
  const expectedOwnerPinBucket = `name:sha256:${createHash('sha256').update(OWNER_PIN).digest('hex').slice(0, 32)}`;
  const expectedLowerBucket = `name:sha256:${createHash('sha256').update(unknownLowerSecret).digest('hex').slice(0, 32)}`;
  assert.ok(limitBuckets.includes(expectedOwnerPinBucket));
  assert.ok(limitBuckets.includes(expectedLowerBucket));
  for (const bucket of limitBuckets) {
    assert.equal(bucket.includes(OWNER_PIN), false);
    assert.equal(bucket.includes(unknownLowerSecret), false);
    assert.equal(bucket.includes(unknownTypedName.toLowerCase()), false);
  }
  dbPreReset.close();

  // While emp.id is locked, changePin throws 429 and logs pin_change_locked; after 60s, wrong currentPin logs pin_change_failed (401), then after 60s valid changePin succeeds.
  await assert.rejects(store.changePin(empSelfLogin.token, { currentPin: WRONG_PIN, newPin: EMP_PIN }), { status: 429 });
  advance(60_001);
  await assert.rejects(store.changePin(empSelfLogin.token, { currentPin: WRONG_PIN, newPin: EMP_PIN }), { status: 401 });
  advance(60_001);
  await store.changePin(empSelfLogin.token, { currentPin: EMP_TEMP_PIN, newPin: EMP_PIN }, { clientKey: 'ip:127.0.0.2' });

  // resetEmployeePin, renameUser, disableUser, logout, invalidateSessions, resetOwnerPin
  await store.resetEmployeePin(ownerLogin.token, { id: emp.id, newPin: ALT_PIN });
  store.renameUser(ownerLogin.token, { id: emp.id, name: 'Kasiyer Yeni' });
  store.disableUser(ownerLogin.token, emp.id);
  store.logout(empMasterLogin.token);
  store.logout(ownerLogin.token);
  store.invalidateSessions({ reason: 'manual_test' });
  await store.resetOwnerPin({ pin: RESET_PIN, mustChangePin: false, source: 'cli:reset-owner-pin' });

  const all = store.listAuthAudit({ limit: 500 });
  assert.equal(all.entries.length, all.total);
  const eventTypes = new Set(all.entries.map(e => e.eventType));
  for (const expected of [
    'owner_setup',
    'login_success',
    'login_failed',
    'login_locked',
    'employee_created',
    'pin_change_locked',
    'pin_change_failed',
    'pin_changed',
    'employee_pin_reset',
    'user_renamed',
    'user_disabled',
    'logout',
    'sessions_invalidated',
    'owner_pin_reset'
  ]) {
    assert.ok(eventTypes.has(expected), `Expected audit eventType: ${expected}`);
  }

  const masterAudit = all.entries.find(e => e.eventType === 'login_success' && e.viaMasterPin);
  assert.ok(masterAudit);
  assert.equal(masterAudit.masterActorId, owner.id);
  assert.equal(masterAudit.actorId, emp.id);

  // Pagination & eventType filtering
  const page1 = store.listAuthAudit({ limit: 4, offset: 0 });
  const page2 = store.listAuthAudit({ limit: 4, offset: 4 });
  assert.equal(page1.entries.length, 4);
  assert.equal(page2.entries.length, 4);
  assert.equal(page1.total, all.total);
  const p1Ids = new Set(page1.entries.map(e => e.id));
  assert.equal(page2.entries.some(e => p1Ids.has(e.id)), false);

  const filtered = store.listAuthAudit({ eventType: 'login_locked', limit: 10 });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.entries[0].outcome, 'locked');

  assert.throws(() => store.listAuthAudit({ limit: 0 }), { status: 400 });
  assert.throws(() => store.listAuthAudit({ offset: -1 }), { status: 400 });
  assert.throws(() => store.listAuthAudit({ eventType: 'bad;sql' }), { status: 400 });

  // Zero secret or typed-username leakage in audit JSON and persisted SQLite/WAL bytes
  const auditSerialized = JSON.stringify(all);
  const db = new DatabaseSync(join(directory, 'identity.sqlite'), { readOnly: true });
  trackClose(() => db.close());
  const credRows = db.prepare('SELECT salt, verifier FROM identity_users').all();
  for (const cred of credRows) {
    assert.equal(auditSerialized.includes(cred.salt.toString('hex')), false);
    assert.equal(auditSerialized.includes(cred.verifier.toString('hex')), false);
    assert.equal(auditSerialized.includes(cred.salt.toString('base64')), false);
    assert.equal(auditSerialized.includes(cred.verifier.toString('base64')), false);
  }
  const secrets = [
    OWNER_PIN,
    EMP_TEMP_PIN,
    EMP_PIN,
    ALT_PIN,
    RESET_PIN,
    WRONG_PIN,
    ownerLogin.token,
    empMasterLogin.token,
    empSelfLogin.token,
    unknownTypedName,
    unknownLowerSecret
  ];
  const sqliteBytes = readFileSync(join(directory, 'identity.sqlite'));
  const walFile = join(directory, 'identity.sqlite-wal');
  const walBytes = existsSync(walFile) ? readFileSync(walFile) : Buffer.alloc(0);
  for (const secret of secrets) {
    assert.equal(auditSerialized.includes(secret), false, `Audit leaked secret: ${secret}`);
    assert.equal(sqliteBytes.includes(Buffer.from(secret)), false, `SQLite leaked secret: ${secret}`);
    assert.equal(walBytes.includes(Buffer.from(secret)), false, `WAL leaked secret: ${secret}`);
  }
});

test('F6: unknown loginByName buckets are hashed (zero SQLite/WAL leakage) and still lock across Turkish/NFC/case variants at 5 attempts', async t => {
  const { store, directory, advance, trackClose } = fixture(t);
  await store.initializeOwner({ name: 'Sahip', pin: OWNER_PIN });

  const accidentalPinName = '739152';
  const lowerSecret = 'gizlipinlowercase987654';
  const lowerVariants = [
    lowerSecret,
    '  GİZLİPİNLOWERCASE987654  ',
    'GizliPinLowercase987654',
    'gizlipinlowercase987654 ',
    'GİZLİPİNLOWERCASE987654'
  ];
  const nfcCanonical = 'çalışangizli987654';
  const nfcVariants = [
    'C\u0327alıs\u0327anGizli987654',
    '  ÇALIŞANGİZLİ987654  ',
    'c\u0327alıs\u0327angizli987654',
    'ÇalışanGizli987654',
    '  C\u0327ALIS\u0327ANGİZLİ987654'
  ];

  // Accidental 6-digit PIN typed as username
  assert.equal(await store.loginByName(accidentalPinName, WRONG_PIN), null);

  // 5 attempts on lowercase secret variants lock at attempt 5 under the same name:sha256 bucket
  for (let i = 0; i < lowerVariants.length; i++) {
    assert.equal(await store.loginByName(lowerVariants[i], WRONG_PIN, { clientKey: `ip:198.51.100.${10 + i}` }), null);
  }
  assert.equal(await store.loginByName(lowerSecret, WRONG_PIN, { clientKey: 'ip:198.51.100.99' }), null);

  // 5 attempts across NFD/NFC Turkish case variants also share one name:sha256 bucket and lock at 5
  for (let i = 0; i < nfcVariants.length; i++) {
    assert.equal(await store.loginByName(nfcVariants[i], WRONG_PIN, { clientKey: `ip:198.51.100.${30 + i}` }), null);
  }
  assert.equal(await store.loginByName(nfcCanonical, WRONG_PIN, { clientKey: 'ip:198.51.100.98' }), null);

  const db = new DatabaseSync(join(directory, 'identity.sqlite'), { readOnly: true });
  trackClose(() => db.close());
  const rows = db.prepare('SELECT bucket, attempts, until_ms FROM login_limits').all();
  const expectedPinBucket = `name:sha256:${createHash('sha256').update(accidentalPinName).digest('hex').slice(0, 32)}`;
  const expectedLowerBucket = `name:sha256:${createHash('sha256').update(lowerSecret).digest('hex').slice(0, 32)}`;
  const expectedNfcBucket = `name:sha256:${createHash('sha256').update(nfcCanonical).digest('hex').slice(0, 32)}`;

  const lowerRow = rows.find(r => r.bucket === expectedLowerBucket);
  const nfcRow = rows.find(r => r.bucket === expectedNfcBucket);
  const pinRow = rows.find(r => r.bucket === expectedPinBucket);
  assert.ok(pinRow);
  assert.equal(pinRow.attempts, 1);
  assert.ok(lowerRow);
  assert.equal(lowerRow.attempts, 5);
  assert.equal(lowerRow.until_ms, 10_000_000 + 60_000);
  assert.ok(nfcRow);
  assert.equal(nfcRow.attempts, 5);
  assert.equal(nfcRow.until_ms, 10_000_000 + 60_000);

  const lockedAudits = store.listAuthAudit({ eventType: 'login_locked', limit: 10 }).entries;
  assert.equal(lockedAudits.length, 2);
  assert.ok(lockedAudits.every(e => e.detail?.lockedBucket === 'user' && e.detail?.knownUser === false));

  // After 60s lock expires, 6th attempt proceeds (still unknown) and increments attempts to 6
  advance(60_001);
  assert.equal(await store.loginByName(lowerSecret, WRONG_PIN, { clientKey: 'ip:198.51.100.99' }), null);
  assert.equal(db.prepare('SELECT attempts FROM login_limits WHERE bucket = ?').get(expectedLowerBucket).attempts, 6);

  const auditSerialized = JSON.stringify(store.listAuthAudit({ limit: 100 }));
  const sqliteBytes = readFileSync(join(directory, 'identity.sqlite'));
  const walFile = join(directory, 'identity.sqlite-wal');
  const walBytes = existsSync(walFile) ? readFileSync(walFile) : Buffer.alloc(0);
  for (const secret of [accidentalPinName, lowerSecret, nfcCanonical, ...nfcVariants, ...lowerVariants.map(v => v.trim())]) {
    assert.equal(auditSerialized.includes(secret), false, `Audit leaked unknown name: ${secret}`);
    assert.equal(sqliteBytes.includes(Buffer.from(secret)), false, `SQLite leaked unknown name: ${secret}`);
    assert.equal(walBytes.includes(Buffer.from(secret)), false, `WAL leaked unknown name: ${secret}`);
  }
});

test('F6: sanitizeAuditDetail always returns valid JSON <= 1024 bytes and listAuthAudit parses oversized audit inputs safely', async t => {
  assert.equal(sanitizeAuditDetail(null), null);
  assert.equal(sanitizeAuditDetail([]), null);
  assert.equal(sanitizeAuditDetail({ pin: '482910', password: 'secret', amount: 100 }), null);

  // Many large fields -> capped safely as valid JSON <= 1024 UTF-8 bytes
  const manyFields = {};
  for (let i = 0; i < 30; i++) {
    manyFields[`field_${i}`] = `value_${i}_` + 'x'.repeat(120);
  }
  const capped = sanitizeAuditDetail(manyFields);
  assert.equal(typeof capped, 'string');
  assert.ok(Buffer.byteLength(capped, 'utf8') <= 1024);
  const parsedMany = JSON.parse(capped);
  assert.equal(parsedMany.truncated, true);

  // Multi-byte UTF-8 boundary stays <= 1024 bytes (not just <= 1024 UTF-16 code units)
  const utf8Heavy = {};
  for (let i = 0; i < 12; i++) {
    utf8Heavy[`turkce_${i}`] = 'şğüöçİ'.repeat(25);
  }
  const cappedUtf8 = sanitizeAuditDetail(utf8Heavy);
  assert.equal(typeof cappedUtf8, 'string');
  assert.ok(Buffer.byteLength(cappedUtf8, 'utf8') <= 1024);
  const parsedUtf8 = JSON.parse(cappedUtf8);
  assert.equal(parsedUtf8.truncated, true);

  // Single oversized key -> fallback to valid '{"truncated":true}'
  const singleOversizedKey = { ['k'.repeat(2000)]: 'val' };
  const singleRes = sanitizeAuditDetail(singleOversizedKey);
  assert.equal(singleRes, '{"truncated":true}');
  assert.ok(Buffer.byteLength(singleRes, 'utf8') <= 1024);
  assert.deepEqual(JSON.parse(singleRes), { truncated: true });

  // Integration check via IdentityStore.invalidateSessions + listAuthAudit + raw DB inspection
  const { store, directory, trackClose } = fixture(t);
  await store.initializeOwner({ name: 'Sahip', pin: OWNER_PIN });
  store.invalidateSessions({ reason: 'A'.repeat(2000) });
  const audits = store.listAuthAudit({ eventType: 'sessions_invalidated', limit: 10 });
  assert.equal(audits.total, 1);
  assert.equal(audits.entries[0].detail.reason, 'A'.repeat(128));

  const db = new DatabaseSync(join(directory, 'identity.sqlite'), { readOnly: true });
  trackClose(() => db.close());
  for (const row of db.prepare('SELECT detail_json FROM auth_audit_log WHERE detail_json IS NOT NULL').all()) {
    assert.ok(Buffer.byteLength(row.detail_json, 'utf8') <= 1024);
    assert.doesNotThrow(() => JSON.parse(row.detail_json));
  }
});

test('F7: scripts/reset-owner-pin.mjs fails closed on invalid paths/DBs, supports --pin/--pin-env/stdin, and revokes live sessions across instances', async () => {
  const root = makeTempDir('p2-cli-reset-');
  let liveStore;
  try {
    // 1) Missing / non-existent / empty data-dir must fail closed WITHOUT creating identity.sqlite
    const missingDir = join(root, 'does-not-exist');
    const missingRes = spawnSync(process.execPath, [RESET_SCRIPT_PATH, '--data-dir', missingDir, '--pin', RESET_PIN], { encoding: 'utf8' });
    assert.equal(missingRes.status, 1);
    assert.equal(existsSync(missingDir), false);

    const emptyDir = join(root, 'empty-dir');
    mkdirSync(emptyDir, { recursive: true });
    const emptyRes = spawnSync(process.execPath, [RESET_SCRIPT_PATH, '--data-dir', emptyDir, '--pin', RESET_PIN], { encoding: 'utf8' });
    assert.equal(emptyRes.status, 1);
    assert.equal(existsSync(join(emptyDir, 'identity.sqlite')), false);

    // 2) Foreign SQLite DB must fail closed without mutating bytes or creating WAL/SHM sidecars
    const foreignDir = join(root, 'foreign-dir');
    mkdirSync(foreignDir, { recursive: true });
    const foreignDbFile = join(foreignDir, 'identity.sqlite');
    const fdb = new DatabaseSync(foreignDbFile);
    fdb.exec('PRAGMA journal_mode = DELETE; CREATE TABLE custom (id INTEGER PRIMARY KEY);');
    fdb.close();
    const beforeForeign = readFileSync(foreignDbFile);
    const foreignRes = spawnSync(process.execPath, [RESET_SCRIPT_PATH, '--data-dir', foreignDir, '--pin', RESET_PIN], { encoding: 'utf8' });
    assert.equal(foreignRes.status, 1);
    assert.deepEqual(readFileSync(foreignDbFile), beforeForeign);
    assert.equal(existsSync(`${foreignDbFile}-wal`), false);
    assert.equal(existsSync(`${foreignDbFile}-shm`), false);

    // 3) Conflicting flags / invalid PIN fail without leaking PIN
    const dataDir = join(root, 'live-data');
    mkdirSync(dataDir, { recursive: true });
    liveStore = new IdentityStore(dataDir);
    const owner = await liveStore.initializeOwner({ name: 'Sahip', pin: OWNER_PIN });
    const ownerSession = await liveStore.login(owner.id, OWNER_PIN);
    const emp = await liveStore.createEmployee(ownerSession.token, { name: 'Kasiyer', pin: EMP_TEMP_PIN });
    const empSession = await liveStore.login(emp.id, EMP_TEMP_PIN);

    // Lock out owner on liveStore before CLI recovery
    for (let i = 0; i < 5; i++) {
      assert.equal(await liveStore.login(owner.id, WRONG_PIN), null);
    }
    assert.equal(await liveStore.login(owner.id, OWNER_PIN), null);

    const conflictRes = spawnSync(
      process.execPath,
      [RESET_SCRIPT_PATH, '--data-dir', dataDir, '--pin', RESET_PIN, '--pin-env', 'TEST_OWNER_PIN'],
      { env: { ...process.env, TEST_OWNER_PIN: RESET_PIN }, encoding: 'utf8' }
    );
    assert.equal(conflictRes.status, 1);
    assert.equal(conflictRes.stdout.includes(RESET_PIN), false);
    assert.equal(conflictRes.stderr.includes(RESET_PIN), false);

    const badPinRes = spawnSync(
      process.execPath,
      [RESET_SCRIPT_PATH, '--data-dir', dataDir, '--pin', '12ab56'],
      { encoding: 'utf8' }
    );
    assert.equal(badPinRes.status, 1);
    assert.equal(badPinRes.stdout.includes('12ab56'), false);
    assert.equal(badPinRes.stderr.includes('12ab56'), false);

    // 4) Valid --pin-env recovery clears lockout, updates owner PIN, and immediately revokes live sessions on liveStore!
    const envResetRes = spawnSync(
      process.execPath,
      [RESET_SCRIPT_PATH, '--data-dir', dataDir, '--pin-env', 'NEW_OWNER_PIN'],
      { env: { ...process.env, NEW_OWNER_PIN: RESET_PIN }, encoding: 'utf8' }
    );
    assert.equal(envResetRes.status, 0, envResetRes.stderr);
    assert.equal(envResetRes.stdout.includes(RESET_PIN), false);
    assert.equal(envResetRes.stderr.includes(RESET_PIN), false);
    const parsedEnvOut = JSON.parse(envResetRes.stdout);
    assert.equal(parsedEnvOut.ok, true);
    assert.equal(parsedEnvOut.ownerId, owner.id);
    assert.equal(parsedEnvOut.mustChangePin, false);
    assert.equal(parsedEnvOut.invalidatedSessions, true);

    // Cross-instance session_generation invalidation on the still-open liveStore:
    assert.equal(liveStore.session(ownerSession.token), null);
    assert.equal(liveStore.session(empSession.token), null);
    assert.equal(await liveStore.login(owner.id, OWNER_PIN), null);
    const recovered = await liveStore.login(owner.id, RESET_PIN);
    assert.ok(recovered);
    assert.equal(recovered.actor.mustChangePin, false);

    // 5) Piped stdin + --must-change-pin + --pin also work cleanly without echoing PIN
    const stdinPin = '556677';
    const stdinRes = spawnSync(
      process.execPath,
      [RESET_SCRIPT_PATH, '--data-dir', dataDir, '--must-change-pin'],
      { input: `${stdinPin}\n`, encoding: 'utf8' }
    );
    assert.equal(stdinRes.status, 0, stdinRes.stderr);
    assert.equal(stdinRes.stdout.includes(stdinPin), false);
    assert.equal(stdinRes.stderr.includes(stdinPin), false);
    assert.equal(JSON.parse(stdinRes.stdout).mustChangePin, true);
    assert.equal(liveStore.session(recovered.token), null);
    const mustChangeSession = await liveStore.login(owner.id, stdinPin);
    assert.ok(mustChangeSession);
    assert.equal(mustChangeSession.actor.mustChangePin, true);

    const pinFlag = '334411';
    const flagRes = spawnSync(
      process.execPath,
      [RESET_SCRIPT_PATH, `--data-dir=${dataDir}`, `--pin=${pinFlag}`],
      { encoding: 'utf8' }
    );
    assert.equal(flagRes.status, 0, flagRes.stderr);
    assert.equal(flagRes.stdout.includes(pinFlag), false);
    assert.equal(flagRes.stderr.includes(pinFlag), false);
    assert.ok(await liveStore.login(owner.id, pinFlag));

    const cliAudits = liveStore.listAuthAudit({ eventType: 'owner_pin_reset', limit: 10 });
    assert.equal(cliAudits.total, 3);
    assert.equal(cliAudits.entries[0].sourceKey, 'cli:reset-owner-pin');
  } finally {
    try { liveStore?.close(); } catch {}
    removeTempDir(root);
  }
});
