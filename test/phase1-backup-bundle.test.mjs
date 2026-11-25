import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createCipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.mjs';
import { INITIAL_ACCOUNTS } from '../domain.mjs';
import { IdentityStore } from '../identity.mjs';
import { Repository } from '../repository.mjs';
import {
  checkResticPilotAvailability,
  createBackupBundle,
  decryptBackupBundle,
  encryptBackupBundle,
  restoreBackupBundle,
  verifyResticBundleEncryption
} from '../scripts/backup-bundle.mjs';

const DATE = '2026-11-24';
const OWNER_PIN = '482910';
const EMP_PIN = '654321';
const PASSPHRASE = 'Sentetik-Kuyumcu-Yedek-Parolasi-2026!';

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function removeTempDir(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function openingBalances(overrides = {}) {
  return Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, overrides[a.id] ?? '0']));
}

function makeSamplePhoto() {
  const bytes = Buffer.alloc(96 * 96 * 3);
  for (let i = 0; i < bytes.length; i += 3) {
    bytes[i] = 212;
    bytes[i + 1] = 175;
    bytes[i + 2] = 55;
  }
  return { version: 1, pixels: bytes.toString('base64') };
}

async function seedFullDataDirectory(dataDir, { includeDemo = true } = {}) {
  const identity = new IdentityStore(dataDir);
  const dukkan = new Repository(join(dataDir, 'dukkan.sqlite'), 'dukkan');
  const demo = includeDemo ? new Repository(join(dataDir, 'demo.sqlite'), 'demo') : null;
  let owner, emp, ownerLogin, empLogin;

  try {
    owner = await identity.initializeOwner({ name: 'İşletme Sahibi', pin: OWNER_PIN });
    ownerLogin = await identity.login(owner.id, OWNER_PIN);
    emp = await identity.createEmployee(ownerLogin.token, { name: 'Kasiyer Zeynep', pin: EMP_PIN });
    const tempEmpLogin = await identity.login(emp.id, EMP_PIN);
    await identity.changePin(tempEmpLogin.token, { currentPin: EMP_PIN, newPin: '778899' });
    empLogin = await identity.login(emp.id, '778899');
    // Record one failed login attempt so login_limits is populated too.
    assert.equal(await identity.login(emp.id, '000000'), null);

    // Seed dukkan: opening -> restore (to populate restore_archive) -> registerItem with photo -> pending submission.
    dukkan.execute({
      id: 'duk-open-1',
      revision: 0,
      command: {
        type: 'opening',
        date: DATE,
        balances: openingBalances({ nakit: '250000', kunye: '10', bilezikAdet: '10', bilezik22: '150', ceyrek: '25', taki14: '50' })
      }
    }, { actor: ownerLogin.actor });

    const preRestoreBackup = dukkan.backup();
    dukkan.restore({ backup: preRestoreBackup, revision: 1, confirmation: 'GERİ YÜKLE' });

    const photo = makeSamplePhoto();
    dukkan.execute({
      id: 'duk-item-1',
      revision: 2,
      command: {
        type: 'registerItem',
        date: DATE,
        code: 'KY-1001',
        accountId: 'kunye',
        weightAccount: 'taki14',
        actualWeight: '8.450',
        description: '14 Ayar Altın Künye',
        photo
      }
    }, { actor: ownerLogin.actor });

    dukkan.execute({
      id: 'duk-cust-1',
      revision: 3,
      command: { type: 'account', date: DATE, name: 'Müşteri Ahmet', unit: 'TL', partyType: 'customer', opening: '0' }
    }, { actor: empLogin.actor });

    dukkan.submitPending({
      id: 'duk-pend-1',
      revision: 4,
      command: {
        type: 'sale',
        date: DATE,
        counterpartyType: 'customer',
        counterpartyId: 'cari-duk-cust-1',
        items: [{ accountId: 'bilezikAdet', quantity: '1', weightAccount: 'bilezik22', weight: '15', value: '45000' }],
        received: [{ accountId: 'nakit', quantity: '45000', valueTL: '45000' }],
        given: []
      }
    }, { actor: empLogin.actor });

    if (demo) {
      demo.execute({
        id: 'demo-open-1',
        revision: 0,
        command: { type: 'opening', date: DATE, balances: openingBalances({ nakit: '50000', ceyrek: '5' }) }
      }, { actor: ownerLogin.actor });
      demo.execute({
        id: 'demo-mov-1',
        revision: 1,
        command: { type: 'movement', date: DATE, accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '1500', note: 'Demo hareket' }
      }, { actor: ownerLogin.actor });
    }

    return {
      owner,
      emp,
      ownerToken: ownerLogin.token,
      empToken: empLogin.token,
      empPin: '778899',
      photo,
      dukkanState: dukkan.state(),
      demoState: demo ? demo.state() : null
    };
  } finally {
    demo?.close();
    dukkan.close();
    identity.close();
  }
}

test('Faz 1-C: createConsistentBackup validates arguments and rejects pre-existing targets', async t => {
  const dir = makeTempDir('p1-ccb-');
  const repo = new Repository(join(dir, 'dukkan.sqlite'), 'dukkan');
  const identity = new IdentityStore(dir);
  t.after(() => {
    try { repo.close(); } catch {}
    try { identity.close(); } catch {}
    removeTempDir(dir);
  });

  await identity.initializeOwner({ name: 'Sahip', pin: OWNER_PIN });
  repo.execute({
    id: 'open-ccb',
    revision: 0,
    command: { type: 'opening', date: DATE, balances: openingBalances({ nakit: '1000' }) }
  });

  for (const bad of ['', '   ', ':memory:', null, undefined, 123, 'bad\0path']) {
    assert.throws(() => repo.createConsistentBackup(bad));
    assert.throws(() => identity.createConsistentBackup(bad));
  }

  const existing = join(dir, 'already.sqlite');
  writeFileSync(existing, 'do-not-overwrite');
  assert.throws(() => repo.createConsistentBackup(existing), { code: 'EEXIST' });
  assert.throws(() => identity.createConsistentBackup(existing), { code: 'EEXIST' });
  assert.equal(readFileSync(existing, 'utf8'), 'do-not-overwrite');

  const repoCopy = join(dir, 'nested', 'dukkan-copy.sqlite');
  const idCopy = join(dir, 'nested', 'identity-copy.sqlite');
  const rRes = repo.createConsistentBackup(repoCopy);
  const iRes = identity.createConsistentBackup(idCopy);
  assert.equal(rRes.method, 'VACUUM INTO');
  assert.ok(rRes.sizeBytes > 0);
  assert.equal(iRes.method, 'VACUUM INTO');
  assert.ok(iRes.sizeBytes > 0);
});

test('Faz 1-C: cross-DB backup captures dukkan (photos, pending, restore_archive), demo, identity, and clean manifest during concurrent writes', async t => {
  const root = makeTempDir('p1-bundle-create-');
  const dataDir = join(root, 'data');
  const outDir = join(root, 'bundles');
  const tempDir = join(root, 'tmp');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  mkdirSync(tempDir, { recursive: true });
  t.after(() => removeTempDir(root));

  const seeded = await seedFullDataDirectory(dataDir, { includeDemo: true });

  // Run backup concurrently with a live Repository financial write.
  const liveDukkan = new Repository(join(dataDir, 'dukkan.sqlite'), 'dukkan');
  let backupResult;
  try {
    const [bRes] = await Promise.all([
      createBackupBundle({ dataDirectory: dataDir, outputDirectory: outDir, tempDirectory: tempDir }),
      (async () => {
        await new Promise(r => setTimeout(r, 5));
        liveDukkan.execute({
          id: 'duk-concurrent-mov',
          revision: 4,
          command: { type: 'movement', date: DATE, accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '250', note: 'Eşzamanlı hareket' }
        }, { actor: { id: seeded.owner.id, name: seeded.owner.name, role: 'owner' } });
      })()
    ]);
    backupResult = bRes;
  } finally {
    liveDukkan.close();
  }

  assert.ok(existsSync(backupResult.bundleDirectory));
  assert.ok(existsSync(backupResult.manifestPath));

  const manifestRaw = readFileSync(backupResult.manifestPath, 'utf8');
  const manifest = JSON.parse(manifestRaw);
  assert.equal(manifest.manifestVersion, 1);
  assert.equal(manifest.method, 'VACUUM INTO');
  assert.ok(manifest.bundleId);
  assert.ok(manifest.startedAt);
  assert.ok(manifest.finishedAt);
  assert.equal(manifest.appVersion, '0.1.0');
  assert.ok(manifest.gitCommit);
  assert.deepEqual(manifest.databases.map(d => d.filename).sort(), ['demo.sqlite', 'dukkan.sqlite', 'identity.sqlite']);

  for (const dbEntry of manifest.databases) {
    assert.ok(dbEntry.sizeBytes > 0);
    assert.match(dbEntry.sha256, /^[a-f0-9]{64}$/);
    assert.equal(dbEntry.integrityCheck, 'ok');
    assert.ok(Number.isSafeInteger(dbEntry.applicationId));
    assert.ok(Number.isSafeInteger(dbEntry.userVersion));
    assert.ok(Number.isSafeInteger(dbEntry.schemaVersion));
  }

  const dukkanEntry = manifest.databases.find(d => d.role === 'dukkan');
  assert.equal(dukkanEntry.pendingCount, 1);
  assert.equal(dukkanEntry.restoreArchiveCount, 1);
  const idEntry = manifest.databases.find(d => d.role === 'identity');
  assert.equal(idEntry.applicationId, 1163086153);
  assert.equal(idEntry.userVersion, 3);
  assert.equal(idEntry.userCount, 2);

  // Never leak PINs, tokens, or passphrases in manifest.
  for (const secret of [OWNER_PIN, EMP_PIN, seeded.empPin, seeded.ownerToken, seeded.empToken, PASSPHRASE]) {
    assert.equal(manifestRaw.includes(secret), false);
  }
});

test('Faz 1-C: retries on mid-backup identity/ledger mutation and deletes all staging artifacts without publishing when retries exhaust', async t => {
  const root = makeTempDir('p1-bundle-retry-');
  const dataDir = join(root, 'data');
  const outDir = join(root, 'bundles');
  const failOutDir = join(root, 'bundles-fail');
  const tempDir = join(root, 'tmp');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  mkdirSync(failOutDir, { recursive: true });
  mkdirSync(tempDir, { recursive: true });
  t.after(() => removeTempDir(root));

  const seeded = await seedFullDataDirectory(dataDir, { includeDemo: false });

  // 1) Mutate identity.sqlite during attempt 1, succeed on attempt 2.
  const origIdBackup = IdentityStore.prototype.createConsistentBackup;
  let idCalls = 0;
  IdentityStore.prototype.createConsistentBackup = function wrappedIdBackup(targetFile) {
    const res = origIdBackup.call(this, targetFile);
    idCalls++;
    if (idCalls === 1) {
      const mutator = new IdentityStore(dataDir);
      try {
        mutator.invalidateSessions();
      } finally {
        mutator.close();
      }
    }
    return res;
  };

  let retryBundle;
  try {
    retryBundle = await createBackupBundle({
      dataDirectory: dataDir,
      outputDirectory: outDir,
      maxRetries: 3,
      tempDirectory: tempDir
    });
  } finally {
    IdentityStore.prototype.createConsistentBackup = origIdBackup;
  }
  assert.equal(retryBundle.attempts, 2);
  assert.equal(readdirSync(tempDir).length, 0);

  // 2) Mutate dukkan.sqlite during attempt 1, succeed on attempt 2.
  const origRepoBackup = Repository.prototype.createConsistentBackup;
  let repoCalls = 0;
  Repository.prototype.createConsistentBackup = function wrappedRepoBackup(targetFile) {
    const res = origRepoBackup.call(this, targetFile);
    repoCalls++;
    if (repoCalls === 1) {
      const mutRepo = new Repository(join(dataDir, 'dukkan.sqlite'), 'dukkan');
      try {
        mutRepo.execute({
          id: 'duk-mid-backup-mut',
          revision: mutRepo.state().revision,
          command: { type: 'movement', date: DATE, accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '100', note: 'Mutasyon testi' }
        }, { actor: { id: seeded.owner.id, name: seeded.owner.name, role: 'owner' } });
      } finally {
        mutRepo.close();
      }
    }
    return res;
  };

  let repoRetryBundle;
  try {
    repoRetryBundle = await createBackupBundle({
      dataDirectory: dataDir,
      outputDirectory: outDir,
      maxRetries: 3,
      tempDirectory: tempDir
    });
  } finally {
    Repository.prototype.createConsistentBackup = origRepoBackup;
  }
  assert.equal(repoRetryBundle.attempts, 2);
  assert.equal(readdirSync(tempDir).length, 0);

  // 3) Exhaust retries: mutate identity.sqlite on every attempt -> rejects and publishes NOTHING.
  IdentityStore.prototype.createConsistentBackup = function alwaysMutate(targetFile) {
    const res = origIdBackup.call(this, targetFile);
    const mutator = new IdentityStore(dataDir);
    try {
      mutator.invalidateSessions();
    } finally {
      mutator.close();
    }
    return res;
  };

  try {
    await assert.rejects(
      createBackupBundle({
        dataDirectory: dataDir,
        outputDirectory: failOutDir,
        maxRetries: 3,
        tempDirectory: tempDir
      }),
      error => error.code === 'BACKUP_INCONSISTENT_CROSS_DB'
    );
  } finally {
    IdentityStore.prototype.createConsistentBackup = origIdBackup;
  }

  assert.deepEqual(readdirSync(failOutDir), []);
  assert.deepEqual(readdirSync(tempDir), []);
});

test('Faz 1-D: full isolated restore preserves pending approvals, photos, restore_archive, financial state, identity, and cleans stale sidecars', async t => {
  const root = makeTempDir('p1-restore-full-');
  const dataDir = join(root, 'data');
  const outDir = join(root, 'bundles');
  const targetDir = join(root, 'restored-target');
  const tempDir = join(root, 'tmp');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  mkdirSync(targetDir, { recursive: true });
  mkdirSync(tempDir, { recursive: true });
  t.after(() => removeTempDir(root));

  const seeded = await seedFullDataDirectory(dataDir, { includeDemo: true });
  const bundle = await createBackupBundle({ dataDirectory: dataDir, outputDirectory: outDir, tempDirectory: tempDir });

  // Place stale DB + stale -wal/-shm sidecars in targetDirectory to verify cleanup.
  writeFileSync(join(targetDir, 'dukkan.sqlite'), 'stale-dukkan');
  writeFileSync(join(targetDir, 'dukkan.sqlite-wal'), 'stale-wal');
  writeFileSync(join(targetDir, 'dukkan.sqlite-shm'), 'stale-shm');
  writeFileSync(join(targetDir, 'identity.sqlite-wal'), 'stale-id-wal');

  const restored = await restoreBackupBundle({
    bundleDirectory: bundle.bundleDirectory,
    targetDirectory: targetDir,
    tempDirectory: tempDir
  });
  assert.equal(restored.ok, true);
  assert.equal(restored.sessionGenerationRotated, true);
  assert.equal(existsSync(join(targetDir, 'dukkan.sqlite-wal')), false);
  assert.equal(existsSync(join(targetDir, 'dukkan.sqlite-shm')), false);
  assert.equal(existsSync(join(targetDir, 'identity.sqlite-wal')), false);

  const rDukkan = new Repository(join(targetDir, 'dukkan.sqlite'), 'dukkan');
  const rDemo = new Repository(join(targetDir, 'demo.sqlite'), 'demo');
  const rId = new IdentityStore(targetDir);
  try {
    assert.deepEqual(rDukkan.state().balances, seeded.dukkanState.balances);
    assert.equal(rDukkan.state().revision, seeded.dukkanState.revision);
    assert.deepEqual(rDukkan.itemPhoto('KY-1001'), seeded.photo);
    assert.equal(rDukkan.db.prepare('SELECT COUNT(*) AS c FROM restore_archive').get().c, 1);

    const pendingList = rDukkan.listPending({ status: 'pending' });
    assert.equal(pendingList.length, 1);
    assert.equal(pendingList[0].id, 'duk-pend-1');

    assert.deepEqual(rDemo.state().balances, seeded.demoState.balances);
    assert.equal(rDemo.state().revision, seeded.demoState.revision);

    const users = rId.listUsers();
    assert.equal(users.length, 2);
    const newOwnerSession = await rId.login(seeded.owner.id, OWNER_PIN);
    assert.ok(newOwnerSession?.token);
    const approved = rDukkan.approvePending({
      id: 'duk-pend-1',
      revision: rDukkan.state().revision,
      actor: newOwnerSession.actor
    });
    assert.equal(approved.ok, true);
    assert.equal(rDukkan.pendingCount(), 0);
  } finally {
    try { rDukkan.close(); } catch {}
    try { rDemo.close(); } catch {}
    try { rId.close(); } catch {}
  }
});

test('Faz 1-D: restoreBackupBundle rejects corrupt, missing, extra, SHA-256 mismatch, and broken ledger bundles leaving targetDirectory untouched', async t => {
  const root = makeTempDir('p1-restore-reject-');
  const dataDir = join(root, 'data');
  const outDir = join(root, 'bundles');
  const targetDir = join(root, 'protected-target');
  const tempDir = join(root, 'tmp');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  mkdirSync(targetDir, { recursive: true });
  mkdirSync(tempDir, { recursive: true });
  t.after(() => removeTempDir(root));

  await seedFullDataDirectory(dataDir, { includeDemo: false });
  const bundle = await createBackupBundle({ dataDirectory: dataDir, outputDirectory: outDir, tempDirectory: tempDir });

  // Seed protected targetDirectory with distinct state.
  const targetDukkanFile = join(targetDir, 'dukkan.sqlite');
  const targetIdFile = join(targetDir, 'identity.sqlite');
  const pRepo = new Repository(targetDukkanFile, 'dukkan');
  const pId = new IdentityStore(targetDir);
  try {
    await pId.initializeOwner({ name: 'Korunan Sahip', pin: '112233' });
    pRepo.execute({
      id: 'protected-open',
      revision: 0,
      command: { type: 'opening', date: DATE, balances: openingBalances({ nakit: '9999' }) }
    });
  } finally {
    pRepo.close();
    pId.close();
  }
  const beforeDukkanBytes = readFileSync(targetDukkanFile);
  const beforeIdBytes = readFileSync(targetIdFile);

  const assertTargetUntouched = () => {
    assert.deepEqual(readFileSync(targetDukkanFile), beforeDukkanBytes);
    assert.deepEqual(readFileSync(targetIdFile), beforeIdBytes);
  };

  const cloneBundle = name => {
    const copyDir = join(root, `fault-${name}`);
    mkdirSync(copyDir, { recursive: true });
    for (const file of readdirSync(bundle.bundleDirectory)) {
      copyFileSync(join(bundle.bundleDirectory, file), join(copyDir, file));
    }
    return copyDir;
  };

  // 1) Missing manifest
  const missingManifestDir = cloneBundle('missing-manifest');
  unlinkSync(join(missingManifestDir, 'bundle-manifest.json'));
  await assert.rejects(restoreBackupBundle({ bundleDirectory: missingManifestDir, targetDirectory: targetDir, tempDirectory: tempDir }), { code: 'MANIFEST_MISSING' });
  assertTargetUntouched();

  // 2) Malformed manifest JSON
  const malformedManifestDir = cloneBundle('malformed-manifest');
  writeFileSync(join(malformedManifestDir, 'bundle-manifest.json'), '{bad json');
  await assert.rejects(restoreBackupBundle({ bundleDirectory: malformedManifestDir, targetDirectory: targetDir, tempDirectory: tempDir }), { code: 'MANIFEST_INVALID' });
  assertTargetUntouched();

  // 3) Missing DB file
  const missingDbDir = cloneBundle('missing-db');
  unlinkSync(join(missingDbDir, 'identity.sqlite'));
  await assert.rejects(restoreBackupBundle({ bundleDirectory: missingDbDir, targetDirectory: targetDir, tempDirectory: tempDir }), { code: 'BUNDLE_PAYLOAD_INVALID' });
  assertTargetUntouched();

  // 4) Extra unlisted file
  const extraFileDir = cloneBundle('extra-file');
  writeFileSync(join(extraFileDir, 'unexpected.txt'), 'extra');
  await assert.rejects(restoreBackupBundle({ bundleDirectory: extraFileDir, targetDirectory: targetDir, tempDirectory: tempDir }), { code: 'BUNDLE_PAYLOAD_INVALID' });
  assertTargetUntouched();

  // 5) SHA-256 mismatch (tampered manifest hash)
  const badHashDir = cloneBundle('bad-hash');
  const m = JSON.parse(readFileSync(join(badHashDir, 'bundle-manifest.json'), 'utf8'));
  m.databases[0].sha256 = '0'.repeat(64);
  writeFileSync(join(badHashDir, 'bundle-manifest.json'), JSON.stringify(m));
  await assert.rejects(restoreBackupBundle({ bundleDirectory: badHashDir, targetDirectory: targetDir, tempDirectory: tempDir }), { code: 'SHA256_MISMATCH' });
  assertTargetUntouched();

  // 6) Corrupt SQLite bytes even with updated size & sha256 in manifest
  const corruptDbDir = cloneBundle('corrupt-db');
  const corruptBytes = Buffer.from('not a valid sqlite database file at all'.repeat(10));
  writeFileSync(join(corruptDbDir, 'dukkan.sqlite'), corruptBytes);
  const { createHash } = await import('node:crypto');
  const mCorrupt = JSON.parse(readFileSync(join(corruptDbDir, 'bundle-manifest.json'), 'utf8'));
  mCorrupt.databases[0].sizeBytes = corruptBytes.length;
  mCorrupt.databases[0].sha256 = createHash('sha256').update(corruptBytes).digest('hex');
  writeFileSync(join(corruptDbDir, 'bundle-manifest.json'), JSON.stringify(mCorrupt));
  await assert.rejects(restoreBackupBundle({ bundleDirectory: corruptDbDir, targetDirectory: targetDir, tempDirectory: tempDir }), { code: 'SQLITE_HEADER_INVALID' });
  assertTargetUntouched();

  // 7) Financially invalid ledger (replay fails) even with valid SQLite + matching hash
  const badReplayDir = cloneBundle('bad-replay');
  const badDb = new DatabaseSync(join(badReplayDir, 'dukkan.sqlite'));
  badDb.prepare("UPDATE events SET body = '{\"id\":\"bad\",\"schemaVersion\":3,\"command\":{\"type\":\"invalid_type\"}}' WHERE seq = 1").run();
  badDb.close();
  const badDbBytes = readFileSync(join(badReplayDir, 'dukkan.sqlite'));
  const mReplay = JSON.parse(readFileSync(join(badReplayDir, 'bundle-manifest.json'), 'utf8'));
  mReplay.databases[0].sizeBytes = badDbBytes.length;
  mReplay.databases[0].sha256 = createHash('sha256').update(badDbBytes).digest('hex');
  writeFileSync(join(badReplayDir, 'bundle-manifest.json'), JSON.stringify(mReplay));
  await assert.rejects(restoreBackupBundle({ bundleDirectory: badReplayDir, targetDirectory: targetDir, tempDirectory: tempDir }));
  assertTargetUntouched();
});

test('Faz 1-D: AES-256-GCM + scrypt encrypted bundle round-trip, wrong-key/tamper rejection, and transparent Restic probe', async t => {
  const root = makeTempDir('p1-enc-roundtrip-');
  const dataDir = join(root, 'data');
  const outDir = join(root, 'bundles');
  const decDir = join(root, 'decrypted');
  const targetDir = join(root, 'restored');
  const tempDir = join(root, 'tmp');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  mkdirSync(decDir, { recursive: true });
  mkdirSync(targetDir, { recursive: true });
  mkdirSync(tempDir, { recursive: true });
  t.after(() => removeTempDir(root));

  const seeded = await seedFullDataDirectory(dataDir, { includeDemo: true });
  const bundle = await createBackupBundle({ dataDirectory: dataDir, outputDirectory: outDir, tempDirectory: tempDir });
  const encFile = join(root, 'backup.kuyumcu-enc');

  const encInfo = await encryptBackupBundle({
    bundleDirectory: bundle.bundleDirectory,
    outputFile: encFile,
    passphrase: PASSPHRASE,
    tempDirectory: tempDir
  });
  assert.equal(encInfo.algorithm, 'aes-256-gcm');
  assert.equal(encInfo.kdf, 'scrypt');

  const encBytes = readFileSync(encFile);
  assert.equal(encBytes.includes(Buffer.from('SQLite format 3')), false);
  assert.equal(encBytes.includes(Buffer.from(PASSPHRASE)), false);
  assert.equal(encBytes.includes(Buffer.from(OWNER_PIN)), false);

  // Wrong passphrase rejected before touching outputDirectory.
  await assert.rejects(
    decryptBackupBundle({ encryptedFile: encFile, outputDirectory: decDir, passphrase: 'wrong-passphrase', tempDirectory: tempDir }),
    { code: 'BUNDLE_DECRYPT_FAILED' }
  );
  assert.deepEqual(readdirSync(decDir), []);

  // Tampered header (AAD), tampered ciphertext, tampered authTag, and truncated file all rejected.
  const tamperCases = [
    ['tamper-aad', buf => { buf[40] ^= 0xff; }],
    ['tamper-ciphertext', buf => { buf[Math.floor(buf.length / 2)] ^= 0xff; }],
    ['tamper-authtag', buf => { buf[buf.length - 3] ^= 0xff; }],
    ['truncated', buf => buf.subarray(0, 40)]
  ];
  for (const [label, mutate] of tamperCases) {
    const tamperedFile = join(root, `${label}.enc`);
    const copy = Buffer.from(encBytes);
    const result = mutate(copy);
    writeFileSync(tamperedFile, result || copy);
    await assert.rejects(
      decryptBackupBundle({ encryptedFile: tamperedFile, outputDirectory: decDir, passphrase: PASSPHRASE, tempDirectory: tempDir }),
      { code: 'BUNDLE_DECRYPT_FAILED' }
    );
    assert.deepEqual(readdirSync(decDir), []);
  }

  // Wrong passphrase on restoreBackupBundle leaves targetDirectory empty/untouched.
  await assert.rejects(
    restoreBackupBundle({ encryptedFile: encFile, passphrase: 'wrong', targetDirectory: targetDir, tempDirectory: tempDir }),
    { code: 'BUNDLE_DECRYPT_FAILED' }
  );
  assert.deepEqual(readdirSync(targetDir), []);

  // Valid decryption round-trip.
  const decInfo = await decryptBackupBundle({
    encryptedFile: encFile,
    outputDirectory: decDir,
    passphrase: PASSPHRASE,
    tempDirectory: tempDir
  });
  assert.equal(decInfo.bundleId, bundle.bundleId);

  // Valid encrypted restoreBackupBundle.
  const restored = await restoreBackupBundle({
    encryptedFile: encFile,
    passphrase: PASSPHRASE,
    targetDirectory: targetDir,
    tempDirectory: tempDir
  });
  assert.equal(restored.ok, true);
  const rDukkan = new Repository(join(targetDir, 'dukkan.sqlite'), 'dukkan');
  try {
    assert.deepEqual(rDukkan.state().balances, seeded.dukkanState.balances);
  } finally {
    rDukkan.close();
  }

  // Restic availability check: transparent BLOCKED (binary eksik) when absent, or verified when present.
  const probe = checkResticPilotAvailability();
  const resticResult = verifyResticBundleEncryption({
    bundleDirectory: bundle.bundleDirectory,
    passphrase: PASSPHRASE,
    tempDirectory: tempDir
  });
  if (!probe.available) {
    assert.equal(probe.status, 'BLOCKED (binary eksik)');
    assert.equal(resticResult.available, false);
    assert.equal(resticResult.status, 'BLOCKED (binary eksik)');
  } else {
    assert.equal(resticResult.verified, true);
  }
});

test('Faz 1-D: post-restore session_generation rotation invalidates pre-restore and in-backup sessions', async t => {
  const root = makeTempDir('p1-session-rotate-');
  const sourceDir = join(root, 'source');
  const outDir = join(root, 'bundles');
  const targetDir = join(root, 'restored');
  const tempDir = join(root, 'tmp');
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  mkdirSync(targetDir, { recursive: true });
  mkdirSync(tempDir, { recursive: true });
  t.after(() => removeTempDir(root));

  // Start HTTP app on sourceDir, initialize owner, keep active session token while taking backup.
  const app1 = createApp({ dataDirectory: sourceDir, logger: () => {} });
  await new Promise(resolve => app1.server.listen(0, '127.0.0.1', resolve));
  const base1 = `http://127.0.0.1:${app1.server.address().port}`;
  let preRestoreToken;
  let bundle;

  try {
    const setupRes = await fetch(`${base1}/api/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Sahip', pin: OWNER_PIN })
    });
    assert.equal(setupRes.status, 201);
    const setupData = await setupRes.json();
    preRestoreToken = setupData.token;

    const openRes = await fetch(`${base1}/api/command?workspace=dukkan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${preRestoreToken}` },
      body: JSON.stringify({ id: 'open-sess', revision: 0, command: { type: 'opening', date: DATE, balances: openingBalances({ nakit: '5000' }) } })
    });
    assert.equal(openRes.status, 200);

    // Pre-restore session is valid.
    const sessCheck = await fetch(`${base1}/api/auth/session`, {
      headers: { Authorization: `Bearer ${preRestoreToken}` }
    });
    assert.equal(sessCheck.status, 200);

    // Take backup while session is active in sourceDir.
    bundle = await createBackupBundle({ dataDirectory: sourceDir, outputDirectory: outDir, tempDirectory: tempDir });
  } finally {
    await new Promise(resolve => { app1.server.close(resolve); app1.server.closeAllConnections(); });
  }

  // Read session_generation captured in the backup.
  const backupIdDb = new DatabaseSync(join(bundle.bundleDirectory, 'identity.sqlite'), { readOnly: true });
  const backupGeneration = backupIdDb.prepare('SELECT generation FROM session_generation WHERE id = 1').get().generation;
  backupIdDb.close();

  // Restore into targetDir.
  const restored = await restoreBackupBundle({
    bundleDirectory: bundle.bundleDirectory,
    targetDirectory: targetDir,
    tempDirectory: tempDir
  });
  assert.notEqual(restored.newSessionGeneration, backupGeneration);

  const restoredIdDb = new DatabaseSync(join(targetDir, 'identity.sqlite'), { readOnly: true });
  const restoredGeneration = restoredIdDb.prepare('SELECT generation FROM session_generation WHERE id = 1').get().generation;
  restoredIdDb.close();
  assert.equal(restoredGeneration, restored.newSessionGeneration);
  assert.notEqual(restoredGeneration, backupGeneration);

  // Start HTTP app on restored targetDir -> preRestoreToken MUST be rejected with 401; fresh login works.
  const app2 = createApp({ dataDirectory: targetDir, logger: () => {} });
  await new Promise(resolve => app2.server.listen(0, '127.0.0.1', resolve));
  const base2 = `http://127.0.0.1:${app2.server.address().port}`;
  try {
    const staleRes = await fetch(`${base2}/api/auth/session`, {
      headers: { Authorization: `Bearer ${preRestoreToken}` }
    });
    assert.equal(staleRes.status, 401);

    const freshLogin = await fetch(`${base2}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Sahip', pin: OWNER_PIN })
    });
    assert.equal(freshLogin.status, 200);
    const freshData = await freshLogin.json();
    assert.ok(freshData.token);

    const stateRes = await fetch(`${base2}/api/state?workspace=dukkan`, {
      headers: { Authorization: `Bearer ${freshData.token}` }
    });
    assert.equal(stateRes.status, 200);
    const state = await stateRes.json();
    assert.equal(state.balances.nakit, 500000);
  } finally {
    await new Promise(resolve => { app2.server.close(resolve); app2.server.closeAllConnections(); });
  }
});

test('Faz 1-C/D: CLI entry point, application_id mismatch rejection, and rollback-safe target swap', async t => {
  const root = makeTempDir('p1-cli-rollback-');
  const dataDir = join(root, 'data');
  const outDir = join(root, 'bundles');
  const targetDir = join(root, 'target');
  const tempDir = join(root, 'tmp');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  mkdirSync(targetDir, { recursive: true });
  mkdirSync(tempDir, { recursive: true });
  t.after(() => removeTempDir(root));

  const seeded = await seedFullDataDirectory(dataDir, { includeDemo: false });

  // 1) CLI create + encrypt + restore + check-restic
  const cliPath = join(process.cwd(), 'scripts', 'backup-bundle.mjs');
  const cliEnv = { ...process.env, TEST_BUNDLE_PASS: PASSPHRASE };

  const createRun = spawnSync(process.execPath, [cliPath, 'create', '--data-dir', dataDir, '--out-dir', outDir], {
    env: cliEnv, encoding: 'utf8', timeout: 15000
  });
  assert.equal(createRun.status, 0, createRun.stderr);
  const created = JSON.parse(createRun.stdout);
  assert.ok(existsSync(created.manifestPath));

  const encPath = join(root, 'cli-bundle.enc');
  const encRun = spawnSync(process.execPath, [
    cliPath, 'encrypt', '--bundle-dir', created.bundleDirectory, '--out-file', encPath, '--passphrase-env', 'TEST_BUNDLE_PASS'
  ], { env: cliEnv, encoding: 'utf8', timeout: 15000 });
  assert.equal(encRun.status, 0, encRun.stderr);

  const resticRun = spawnSync(process.execPath, [cliPath, 'check-restic'], {
    env: cliEnv, encoding: 'utf8', timeout: 15000
  });
  assert.equal(resticRun.status, 0, resticRun.stderr);
  const resticJson = JSON.parse(resticRun.stdout);
  assert.equal(typeof resticJson.status, 'string');

  const restoreRun = spawnSync(process.execPath, [
    cliPath, 'restore', '--encrypted-file', encPath, '--passphrase-env', 'TEST_BUNDLE_PASS', '--target-dir', targetDir
  ], { env: cliEnv, encoding: 'utf8', timeout: 15000 });
  assert.equal(restoreRun.status, 0, restoreRun.stderr);
  const restoreJson = JSON.parse(restoreRun.stdout);
  assert.equal(restoreJson.ok, true);

  // 2) application_id mismatch in identity.sqlite rejected before touching targetDir
  const badAppIdDir = join(root, 'bad-appid-bundle');
  mkdirSync(badAppIdDir, { recursive: true });
  for (const file of readdirSync(created.bundleDirectory)) {
    copyFileSync(join(created.bundleDirectory, file), join(badAppIdDir, file));
  }
  const idDb = new DatabaseSync(join(badAppIdDir, 'identity.sqlite'));
  idDb.exec('PRAGMA application_id = 999999');
  idDb.close();
  const idBytes = readFileSync(join(badAppIdDir, 'identity.sqlite'));
  const manifest = JSON.parse(readFileSync(join(badAppIdDir, 'bundle-manifest.json'), 'utf8'));
  const idEntry = manifest.databases.find(d => d.role === 'identity');
  idEntry.applicationId = 999999;
  idEntry.sizeBytes = idBytes.length;
  idEntry.sha256 = createHash('sha256').update(idBytes).digest('hex');
  writeFileSync(join(badAppIdDir, 'bundle-manifest.json'), JSON.stringify(manifest));

  const targetDukkanBefore = readFileSync(join(targetDir, 'dukkan.sqlite'));
  await assert.rejects(
    restoreBackupBundle({ bundleDirectory: badAppIdDir, targetDirectory: targetDir, tempDirectory: tempDir }),
    { code: 'IDENTITY_SCHEMA_INVALID' }
  );
  assert.deepEqual(readFileSync(join(targetDir, 'dukkan.sqlite')), targetDukkanBefore);

  // 3) Rollback-safe swap: open lock on target identity.sqlite causes swap failure after dukkan.sqlite is moved; dukkan.sqlite must roll back intact.
  const lockedId = new DatabaseSync(join(targetDir, 'identity.sqlite'));
  try {
    await assert.rejects(
      restoreBackupBundle({ bundleDirectory: created.bundleDirectory, targetDirectory: targetDir, tempDirectory: tempDir })
    );
  } finally {
    lockedId.close();
  }
  assert.deepEqual(readFileSync(join(targetDir, 'dukkan.sqlite')), targetDukkanBefore);

  // Verify restored target still opens cleanly with original balances.
  const verifyRepo = new Repository(join(targetDir, 'dukkan.sqlite'), 'dukkan');
  try {
    assert.deepEqual(verifyRepo.state().balances, seeded.dukkanState.balances);
  } finally {
    verifyRepo.close();
  }
});

function craftEncryptedArchiveFromEntries(entries, passphrase) {
  const chunks = [];
  const countBuf = Buffer.alloc(4);
  countBuf.writeUInt32BE(entries.length, 0);
  chunks.push(countBuf);
  for (const [filename, dataBytes] of entries) {
    const nameBytes = Buffer.from(filename, 'utf8');
    const metaBuf = Buffer.alloc(2 + nameBytes.length + 8);
    metaBuf.writeUInt16BE(nameBytes.length, 0);
    nameBytes.copy(metaBuf, 2);
    metaBuf.writeBigUInt64BE(BigInt(dataBytes.length), 2 + nameBytes.length);
    chunks.push(metaBuf, dataBytes);
  }
  const plaintext = Buffer.concat(chunks);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const header = Buffer.alloc(57);
  Buffer.from('KUYUMCU-BUNDLE1\0', 'ascii').copy(header, 0);
  header.writeUInt8(1, 16);
  header.writeUInt32BE(32768, 17);
  header.writeUInt32BE(8, 21);
  header.writeUInt32BE(3, 25);
  salt.copy(header, 29);
  iv.copy(header, 45);
  const key = scryptSync(Buffer.from(passphrase, 'utf8'), salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([header, ciphertext, cipher.getAuthTag()]);
}

function craftEncryptedArchiveFromDir(bundleDir, passphrase) {
  const filenames = readdirSync(bundleDir).sort();
  return craftEncryptedArchiveFromEntries(
    filenames.map(filename => [filename, readFileSync(join(bundleDir, filename))]),
    passphrase
  );
}

test('Faz 1-C/D regression: rejects path-traversal and invalid manifest.bundleId values across encrypt, decrypt, and restore without escaping outputDirectory', async t => {
  const root = makeTempDir('p1-bundleid-traversal-');
  const dataDir = join(root, 'data');
  const outDir = join(root, 'bundles');
  const targetDir = join(root, 'protected-target');
  const tempDir = join(root, 'tmp');
  const sandbox = join(root, 'sandbox');
  const nestedDecOut = join(sandbox, 'nested1', 'nested2', 'dec_out');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  mkdirSync(targetDir, { recursive: true });
  mkdirSync(tempDir, { recursive: true });
  mkdirSync(nestedDecOut, { recursive: true });
  t.after(() => removeTempDir(root));

  await seedFullDataDirectory(dataDir, { includeDemo: false });
  const bundle = await createBackupBundle({ dataDirectory: dataDir, outputDirectory: outDir, tempDirectory: tempDir });

  // Seed protected target to verify restore rejections leave it byte-identical.
  const pRepo = new Repository(join(targetDir, 'dukkan.sqlite'), 'dukkan');
  const pId = new IdentityStore(targetDir);
  try {
    await pId.initializeOwner({ name: 'Korunan', pin: '112233' });
    pRepo.execute({
      id: 'prot-open-1',
      revision: 0,
      command: { type: 'opening', date: DATE, balances: openingBalances({ nakit: '1234' }) }
    });
  } finally {
    pRepo.close();
    pId.close();
  }
  const beforeDukkan = readFileSync(join(targetDir, 'dukkan.sqlite'));
  const beforeId = readFileSync(join(targetDir, 'identity.sqlite'));

  const isManifestOrFilenameRejection = err => err?.code === 'MANIFEST_INVALID' || err?.code === 'INVALID_FILENAME';
  const badBundleIds = [
    '../../escaped_pwned_dir',
    '..\\..\\escaped_win',
    '..',
    '.',
    'C:evil',
    'bundle:ads',
    'sub/dir',
    'sub\\dir'
  ];

  for (let i = 0; i < badBundleIds.length; i++) {
    const badId = badBundleIds[i];
    const tamperedDir = join(root, `tampered-bundleid-${i}`);
    mkdirSync(tamperedDir, { recursive: true });
    for (const file of readdirSync(bundle.bundleDirectory)) {
      copyFileSync(join(bundle.bundleDirectory, file), join(tamperedDir, file));
    }
    const manifest = JSON.parse(readFileSync(join(tamperedDir, 'bundle-manifest.json'), 'utf8'));
    manifest.bundleId = badId;
    writeFileSync(join(tamperedDir, 'bundle-manifest.json'), JSON.stringify(manifest));

    const encAttemptFile = join(root, `should-not-exist-${i}.enc`);
    await assert.rejects(
      encryptBackupBundle({ bundleDirectory: tamperedDir, outputFile: encAttemptFile, passphrase: PASSPHRASE, tempDirectory: tempDir }),
      isManifestOrFilenameRejection
    );
    assert.equal(existsSync(encAttemptFile), false);

    await assert.rejects(
      restoreBackupBundle({ bundleDirectory: tamperedDir, targetDirectory: targetDir, tempDirectory: tempDir }),
      isManifestOrFilenameRejection
    );

    const craftedEnc = join(root, `crafted-traversal-${i}.enc`);
    writeFileSync(craftedEnc, craftEncryptedArchiveFromDir(tamperedDir, PASSPHRASE));

    await assert.rejects(
      decryptBackupBundle({ encryptedFile: craftedEnc, outputDirectory: nestedDecOut, passphrase: PASSPHRASE, tempDirectory: tempDir }),
      isManifestOrFilenameRejection
    );
    assert.deepEqual(readdirSync(nestedDecOut), []);
    assert.deepEqual(readdirSync(join(sandbox, 'nested1', 'nested2')), ['dec_out']);
    assert.deepEqual(readdirSync(join(sandbox, 'nested1')), ['nested2']);
    assert.deepEqual(readdirSync(sandbox), ['nested1']);
    assert.equal(existsSync(join(sandbox, 'nested1', 'escaped_pwned_dir')), false);
    assert.equal(existsSync(join(sandbox, 'nested1', 'escaped_win')), false);

    await assert.rejects(
      restoreBackupBundle({ encryptedFile: craftedEnc, passphrase: PASSPHRASE, targetDirectory: targetDir, tempDirectory: tempDir }),
      isManifestOrFilenameRejection
    );
    assert.deepEqual(readFileSync(join(targetDir, 'dukkan.sqlite')), beforeDukkan);
    assert.deepEqual(readFileSync(join(targetDir, 'identity.sqlite')), beforeId);
  }
});

test('Faz 1-C/D regression: rejects missing/null ledger eventCount and preserves foreign rollback-journal DB header', async t => {
  const root = makeTempDir('p1-minor-hardening-');
  const dataDir = join(root, 'data');
  const outDir = join(root, 'bundles');
  const targetDir = join(root, 'target');
  const tempDir = join(root, 'tmp');
  const foreignDir = join(root, 'foreign-db');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  mkdirSync(targetDir, { recursive: true });
  mkdirSync(tempDir, { recursive: true });
  mkdirSync(foreignDir, { recursive: true });
  t.after(() => removeTempDir(root));

  await seedFullDataDirectory(dataDir, { includeDemo: false });
  const bundle = await createBackupBundle({ dataDirectory: dataDir, outputDirectory: outDir, tempDirectory: tempDir });

  for (const [label, mutateEventCount] of [
    ['null-eventcount', d => { d.eventCount = null; }],
    ['missing-eventcount', d => { delete d.eventCount; }],
    ['negative-eventcount', d => { d.eventCount = -1; }]
  ]) {
    const badDir = join(root, label);
    mkdirSync(badDir, { recursive: true });
    for (const file of readdirSync(bundle.bundleDirectory)) {
      copyFileSync(join(bundle.bundleDirectory, file), join(badDir, file));
    }
    const manifest = JSON.parse(readFileSync(join(badDir, 'bundle-manifest.json'), 'utf8'));
    const dukkanEntry = manifest.databases.find(d => d.role === 'dukkan');
    mutateEventCount(dukkanEntry);
    writeFileSync(join(badDir, 'bundle-manifest.json'), JSON.stringify(manifest));

    await assert.rejects(
      encryptBackupBundle({ bundleDirectory: badDir, outputFile: join(root, `${label}.enc`), passphrase: PASSPHRASE, tempDirectory: tempDir }),
      { code: 'MANIFEST_INVALID' }
    );
    await assert.rejects(
      restoreBackupBundle({ bundleDirectory: badDir, targetDirectory: targetDir, tempDirectory: tempDir }),
      { code: 'MANIFEST_INVALID' }
    );
    assert.deepEqual(readdirSync(targetDir), []);
  }

  // Foreign rollback-journal SQLite database must be rejected without mutating journal_mode header bytes.
  const foreignFile = join(foreignDir, 'identity.sqlite');
  const fDb = new DatabaseSync(foreignFile);
  fDb.exec('PRAGMA journal_mode = DELETE; CREATE TABLE foreign_tbl (id INTEGER PRIMARY KEY);');
  fDb.close();
  const beforeForeignBytes = readFileSync(foreignFile);
  assert.equal(beforeForeignBytes[18], 1);
  assert.equal(beforeForeignBytes[19], 1);

  assert.throws(() => new IdentityStore(foreignDir), /Desteklenmeyen kimlik veritabanı/);
  assert.deepEqual(readFileSync(foreignFile), beforeForeignBytes);
  assert.equal(existsSync(`${foreignFile}-wal`), false);
  assert.equal(existsSync(`${foreignFile}-shm`), false);
});

test('Faz 1-C/D regression: rejects Windows reserved DOS device names across API, CLI, and packed archive payloads while permitting safe lookalikes', async t => {
  const root = makeTempDir('p1-win-reserved-');
  const dataDir = join(root, 'data');
  const outDir = join(root, 'bundles');
  const targetDir = join(root, 'protected-target');
  const decOutDir = join(root, 'dec-out');
  const tempDir = join(root, 'tmp');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  mkdirSync(targetDir, { recursive: true });
  mkdirSync(decOutDir, { recursive: true });
  mkdirSync(tempDir, { recursive: true });
  t.after(() => removeTempDir(root));

  await seedFullDataDirectory(dataDir, { includeDemo: false });
  const bundle = await createBackupBundle({ dataDirectory: dataDir, outputDirectory: outDir, tempDirectory: tempDir });

  // Seed protected target to verify rejections leave it byte-identical.
  const pRepo = new Repository(join(targetDir, 'dukkan.sqlite'), 'dukkan');
  const pId = new IdentityStore(targetDir);
  try {
    await pId.initializeOwner({ name: 'Korunan', pin: '112233' });
    pRepo.execute({
      id: 'prot-win-open-1',
      revision: 0,
      command: { type: 'opening', date: DATE, balances: openingBalances({ nakit: '2500' }) }
    });
  } finally {
    pRepo.close();
    pId.close();
  }
  const beforeDukkan = readFileSync(join(targetDir, 'dukkan.sqlite'));
  const beforeId = readFileSync(join(targetDir, 'identity.sqlite'));
  const assertTargetUntouched = () => {
    assert.deepEqual(readFileSync(join(targetDir, 'dukkan.sqlite')), beforeDukkan);
    assert.deepEqual(readFileSync(join(targetDir, 'identity.sqlite')), beforeId);
  };

  const isManifestOrFilenameRejection = err => err?.code === 'MANIFEST_INVALID' || err?.code === 'INVALID_FILENAME';
  const cliPath = join(process.cwd(), 'scripts', 'backup-bundle.mjs');
  const cliEnv = { ...process.env, TEST_BUNDLE_PASS: PASSPHRASE, TEMP: tempDir, TMP: tempDir };

  const reservedVectors = ['CON', 'con', 'COM1', 'PRN', 'AUX', 'NUL', 'LPT1', 'CON.bak', 'COM0', 'LPT0'];
  for (let i = 0; i < reservedVectors.length; i++) {
    const reserved = reservedVectors[i];
    const tamperedDir = join(root, `tampered-win-${i}`);
    mkdirSync(tamperedDir, { recursive: true });
    for (const file of readdirSync(bundle.bundleDirectory)) {
      copyFileSync(join(bundle.bundleDirectory, file), join(tamperedDir, file));
    }
    const manifest = JSON.parse(readFileSync(join(tamperedDir, 'bundle-manifest.json'), 'utf8'));
    manifest.bundleId = reserved;
    writeFileSync(join(tamperedDir, 'bundle-manifest.json'), JSON.stringify(manifest));

    const encAttemptFile = join(root, `should-not-exist-win-${i}.enc`);
    await assert.rejects(
      encryptBackupBundle({ bundleDirectory: tamperedDir, outputFile: encAttemptFile, passphrase: PASSPHRASE, tempDirectory: tempDir }),
      isManifestOrFilenameRejection
    );
    assert.equal(existsSync(encAttemptFile), false);

    await assert.rejects(
      restoreBackupBundle({ bundleDirectory: tamperedDir, targetDirectory: targetDir, tempDirectory: tempDir }),
      isManifestOrFilenameRejection
    );
    assertTargetUntouched();

    const craftedEnc = join(root, `crafted-win-${i}.enc`);
    writeFileSync(craftedEnc, craftEncryptedArchiveFromDir(tamperedDir, PASSPHRASE));

    await assert.rejects(
      decryptBackupBundle({ encryptedFile: craftedEnc, outputDirectory: decOutDir, passphrase: PASSPHRASE, tempDirectory: tempDir }),
      isManifestOrFilenameRejection
    );
    assert.deepEqual(readdirSync(decOutDir), []);

    await assert.rejects(
      restoreBackupBundle({ encryptedFile: craftedEnc, passphrase: PASSPHRASE, targetDirectory: targetDir, tempDirectory: tempDir }),
      isManifestOrFilenameRejection
    );
    assertTargetUntouched();

    const cliDec = spawnSync(process.execPath, [
      cliPath, 'decrypt', '--encrypted-file', craftedEnc, '--out-dir', decOutDir, '--passphrase-env', 'TEST_BUNDLE_PASS'
    ], { env: cliEnv, encoding: 'utf8', timeout: 15000 });
    assert.equal(cliDec.status, 1);
    const cliDecErr = JSON.parse(cliDec.stderr);
    assert.equal(cliDecErr.ok, false);
    assert.ok(isManifestOrFilenameRejection(cliDecErr), `Unexpected CLI decrypt error: ${cliDec.stderr}`);
    assert.deepEqual(readdirSync(decOutDir), []);

    const cliResEnc = spawnSync(process.execPath, [
      cliPath, 'restore', '--encrypted-file', craftedEnc, '--passphrase-env', 'TEST_BUNDLE_PASS', '--target-dir', targetDir
    ], { env: cliEnv, encoding: 'utf8', timeout: 15000 });
    assert.equal(cliResEnc.status, 1);
    const cliResEncErr = JSON.parse(cliResEnc.stderr);
    assert.equal(cliResEncErr.ok, false);
    assert.ok(isManifestOrFilenameRejection(cliResEncErr), `Unexpected CLI restore (enc) error: ${cliResEnc.stderr}`);
    assertTargetUntouched();

    const cliResPlain = spawnSync(process.execPath, [
      cliPath, 'restore', '--bundle-dir', tamperedDir, '--target-dir', targetDir
    ], { env: cliEnv, encoding: 'utf8', timeout: 15000 });
    assert.equal(cliResPlain.status, 1);
    const cliResPlainErr = JSON.parse(cliResPlain.stderr);
    assert.equal(cliResPlainErr.ok, false);
    assert.ok(isManifestOrFilenameRejection(cliResPlainErr), `Unexpected CLI restore (plain) error: ${cliResPlain.stderr}`);
    assertTargetUntouched();

    assert.deepEqual(readdirSync(tempDir), []);
  }

  // Crafted encrypted archive with reserved/illegal payload entry names and valid bundleId.
  const baseEntries = readdirSync(bundle.bundleDirectory)
    .sort()
    .map(filename => [filename, readFileSync(join(bundle.bundleDirectory, filename))]);
  const badPayloadEntries = [
    'CON',
    'CON.bak',
    'CON ',
    'CON.',
    'CON .bak',
    'nul .sqlite',
    'CONIN$',
    'CONOUT$',
    'CON..',
    'foo*bar',
    'foo?bar'
  ];
  for (let i = 0; i < badPayloadEntries.length; i++) {
    const payloadName = badPayloadEntries[i];
    const payloadEnc = join(root, `payload-bad-${i}.enc`);
    writeFileSync(payloadEnc, craftEncryptedArchiveFromEntries([...baseEntries, [payloadName, Buffer.from('x')]], PASSPHRASE));

    await assert.rejects(
      decryptBackupBundle({ encryptedFile: payloadEnc, outputDirectory: decOutDir, passphrase: PASSPHRASE, tempDirectory: tempDir }),
      { code: 'INVALID_FILENAME' }
    );
    assert.deepEqual(readdirSync(decOutDir), []);

    await assert.rejects(
      restoreBackupBundle({ encryptedFile: payloadEnc, passphrase: PASSPHRASE, targetDirectory: targetDir, tempDirectory: tempDir }),
      { code: 'INVALID_FILENAME' }
    );
    assertTargetUntouched();
    assert.deepEqual(readdirSync(tempDir), []);
  }

  // Crafted encrypted archive with safe-named non-allowlisted entry or undeclared demo.sqlite rejects before staging write.
  for (let i = 0; i < 2; i++) {
    const [extraName, extraBytes] = i === 0
      ? ['unexpected.txt', Buffer.from('extra')]
      : ['demo.sqlite', Buffer.from('SQLite format 3\0undeclared-demo-placeholder')];
    const extraEnc = join(root, `payload-unlisted-${i}.enc`);
    writeFileSync(extraEnc, craftEncryptedArchiveFromEntries([...baseEntries, [extraName, extraBytes]], PASSPHRASE));

    await assert.rejects(
      decryptBackupBundle({ encryptedFile: extraEnc, outputDirectory: decOutDir, passphrase: PASSPHRASE, tempDirectory: tempDir }),
      { code: 'BUNDLE_PAYLOAD_INVALID' }
    );
    assert.deepEqual(readdirSync(decOutDir), []);

    await assert.rejects(
      restoreBackupBundle({ encryptedFile: extraEnc, passphrase: PASSPHRASE, targetDirectory: targetDir, tempDirectory: tempDir }),
      { code: 'BUNDLE_PAYLOAD_INVALID' }
    );
    assertTargetUntouched();
    assert.deepEqual(readdirSync(tempDir), []);
  }

  // Whitespace, trailing-dot, dotdot, and overlength bundleId rejections.
  for (let i = 0; i < 5; i++) {
    const extraBadId = ['bundle-1 ', ' bundle-1', 'bundle-1.', 'a..b', 'a'.repeat(129)][i];
    const extraDir = join(root, `tampered-extra-${i}`);
    mkdirSync(extraDir, { recursive: true });
    for (const file of readdirSync(bundle.bundleDirectory)) {
      copyFileSync(join(bundle.bundleDirectory, file), join(extraDir, file));
    }
    const manifest = JSON.parse(readFileSync(join(extraDir, 'bundle-manifest.json'), 'utf8'));
    manifest.bundleId = extraBadId;
    writeFileSync(join(extraDir, 'bundle-manifest.json'), JSON.stringify(manifest));

    await assert.rejects(
      encryptBackupBundle({ bundleDirectory: extraDir, outputFile: join(root, `extra-${i}.enc`), passphrase: PASSPHRASE, tempDirectory: tempDir }),
      isManifestOrFilenameRejection
    );
    await assert.rejects(
      restoreBackupBundle({ bundleDirectory: extraDir, targetDirectory: targetDir, tempDirectory: tempDir }),
      isManifestOrFilenameRejection
    );
    assertTargetUntouched();
  }

  // Positive checks: lookalike bundleIds ('con-123', 'com10', 'null') and standard bundleId succeed cleanly.
  for (const safeId of ['con-123', 'com10', 'null']) {
    const safeDir = join(root, `safe-src-${safeId}`);
    mkdirSync(safeDir, { recursive: true });
    for (const file of readdirSync(bundle.bundleDirectory)) {
      copyFileSync(join(bundle.bundleDirectory, file), join(safeDir, file));
    }
    const manifest = JSON.parse(readFileSync(join(safeDir, 'bundle-manifest.json'), 'utf8'));
    manifest.bundleId = safeId;
    writeFileSync(join(safeDir, 'bundle-manifest.json'), JSON.stringify(manifest));

    const safeEnc = join(root, `safe-${safeId}.enc`);
    const safeDecOut = join(root, `safe-dec-${safeId}`);
    const safeRestoreTarget = join(root, `safe-restore-${safeId}`);
    mkdirSync(safeDecOut, { recursive: true });
    mkdirSync(safeRestoreTarget, { recursive: true });

    const encRes = await encryptBackupBundle({
      bundleDirectory: safeDir,
      outputFile: safeEnc,
      passphrase: PASSPHRASE,
      tempDirectory: tempDir
    });
    assert.equal(encRes.bundleId, safeId);

    const decRes = await decryptBackupBundle({
      encryptedFile: safeEnc,
      outputDirectory: safeDecOut,
      passphrase: PASSPHRASE,
      tempDirectory: tempDir
    });
    assert.equal(decRes.bundleId, safeId);
    assert.ok(existsSync(join(safeDecOut, safeId, 'bundle-manifest.json')));

    const restRes = await restoreBackupBundle({
      encryptedFile: safeEnc,
      passphrase: PASSPHRASE,
      targetDirectory: safeRestoreTarget,
      tempDirectory: tempDir
    });
    assert.equal(restRes.ok, true);
    assert.equal(restRes.bundleId, safeId);
  }

  // restoreBackupBundle pre-scan rejects non-file entries (e.g. directory) in MANAGED_DB_FILES without mutating targetDir.
  const badTargetDir = join(root, 'bad-managed-target');
  mkdirSync(badTargetDir, { recursive: true });
  copyFileSync(join(targetDir, 'dukkan.sqlite'), join(badTargetDir, 'dukkan.sqlite'));
  copyFileSync(join(targetDir, 'identity.sqlite'), join(badTargetDir, 'identity.sqlite'));
  mkdirSync(join(badTargetDir, 'dukkan.sqlite-wal'), { recursive: true });
  await assert.rejects(
    restoreBackupBundle({ bundleDirectory: bundle.bundleDirectory, targetDirectory: badTargetDir, tempDirectory: tempDir }),
    { code: 'INVALID_FILE' }
  );
  assert.deepEqual(readFileSync(join(badTargetDir, 'dukkan.sqlite')), beforeDukkan);
  assert.deepEqual(readFileSync(join(badTargetDir, 'identity.sqlite')), beforeId);
});

test('Faz 1-C/D regression: rejects Windows DOS device names and invalid segments in caller-supplied API, CLI, and createConsistentBackup paths with INVALID_PATH and zero NTFS artifacts', async t => {
  const root = makeTempDir('p1-caller-paths-');
  const dataDir = join(root, 'data');
  const outDir = join(root, 'bundles');
  const targetDir = join(root, 'protected-target');
  const decOutDir = join(root, 'dec-out');
  const tempDir = join(root, 'tmp');
  const probeDir = join(root, 'probe');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  mkdirSync(targetDir, { recursive: true });
  mkdirSync(decOutDir, { recursive: true });
  mkdirSync(tempDir, { recursive: true });
  mkdirSync(probeDir, { recursive: true });
  t.after(() => removeTempDir(root));

  await seedFullDataDirectory(dataDir, { includeDemo: false });
  const bundle = await createBackupBundle({ dataDirectory: dataDir, outputDirectory: outDir, tempDirectory: tempDir });
  const validEncFile = join(root, 'valid.enc');
  await encryptBackupBundle({
    bundleDirectory: bundle.bundleDirectory,
    outputFile: validEncFile,
    passphrase: PASSPHRASE,
    tempDirectory: tempDir
  });

  // Seed protected target to verify rejections leave it byte-identical.
  const pRepo = new Repository(join(targetDir, 'dukkan.sqlite'), 'dukkan');
  const pId = new IdentityStore(targetDir);
  try {
    await pId.initializeOwner({ name: 'Korunan', pin: '112233' });
    pRepo.execute({
      id: 'prot-caller-open',
      revision: 0,
      command: { type: 'opening', date: DATE, balances: openingBalances({ nakit: '3100' }) }
    });
  } finally {
    pRepo.close();
    pId.close();
  }
  const beforeDukkan = readFileSync(join(targetDir, 'dukkan.sqlite'));
  const beforeId = readFileSync(join(targetDir, 'identity.sqlite'));
  const assertTargetUntouched = () => {
    assert.deepEqual(readFileSync(join(targetDir, 'dukkan.sqlite')), beforeDukkan);
    assert.deepEqual(readFileSync(join(targetDir, 'identity.sqlite')), beforeId);
  };

  const relativeBadSegments = [
    'NUL',
    'CON.enc',
    'COM1.kuyumcu',
    'CONIN$',
    'CONOUT$',
    'CON .bak',
    'AUX/',
    'trailing.',
    'trailing ',
    join('CON', 'nested'),
    'ads:stream',
    'bad*name',
    'bad?name'
  ];
  const rawOnlyBadPaths = [
    `${probeDir}\\CON\\..\\safe`,
    'CON/../safe',
    'C:CON',
    '\\\\.\\CON',
    '\\\\?\\C:\\tmp\\bad'
  ];
  const apiBadPaths = [
    ...relativeBadSegments.map(seg => join(probeDir, seg)),
    ...rawOnlyBadPaths
  ];

  // 1) API path validation across all backup-bundle functions.
  for (const badPath of apiBadPaths) {
    await assert.rejects(
      createBackupBundle({ dataDirectory: badPath, outputDirectory: outDir, tempDirectory: tempDir }),
      { code: 'INVALID_PATH' }
    );
    await assert.rejects(
      createBackupBundle({ dataDirectory: dataDir, outputDirectory: badPath, tempDirectory: tempDir }),
      { code: 'INVALID_PATH' }
    );
    await assert.rejects(
      createBackupBundle({ dataDirectory: dataDir, outputDirectory: outDir, tempDirectory: badPath }),
      { code: 'INVALID_PATH' }
    );

    await assert.rejects(
      encryptBackupBundle({ bundleDirectory: badPath, outputFile: join(probeDir, 'never.enc'), passphrase: PASSPHRASE, tempDirectory: tempDir }),
      { code: 'INVALID_PATH' }
    );
    await assert.rejects(
      encryptBackupBundle({ bundleDirectory: bundle.bundleDirectory, outputFile: badPath, passphrase: PASSPHRASE, tempDirectory: tempDir }),
      { code: 'INVALID_PATH' }
    );
    await assert.rejects(
      encryptBackupBundle({ bundleDirectory: bundle.bundleDirectory, outputFile: join(probeDir, 'never2.enc'), passphrase: PASSPHRASE, tempDirectory: badPath }),
      { code: 'INVALID_PATH' }
    );

    await assert.rejects(
      decryptBackupBundle({ encryptedFile: badPath, outputDirectory: decOutDir, passphrase: PASSPHRASE, tempDirectory: tempDir }),
      { code: 'INVALID_PATH' }
    );
    await assert.rejects(
      decryptBackupBundle({ encryptedFile: validEncFile, outputDirectory: badPath, passphrase: PASSPHRASE, tempDirectory: tempDir }),
      { code: 'INVALID_PATH' }
    );
    await assert.rejects(
      decryptBackupBundle({ encryptedFile: validEncFile, outputDirectory: decOutDir, passphrase: PASSPHRASE, tempDirectory: badPath }),
      { code: 'INVALID_PATH' }
    );

    await assert.rejects(
      restoreBackupBundle({ bundleDirectory: badPath, targetDirectory: targetDir, tempDirectory: tempDir }),
      { code: 'INVALID_PATH' }
    );
    await assert.rejects(
      restoreBackupBundle({ encryptedFile: badPath, passphrase: PASSPHRASE, targetDirectory: targetDir, tempDirectory: tempDir }),
      { code: 'INVALID_PATH' }
    );
    await assert.rejects(
      restoreBackupBundle({ bundleDirectory: bundle.bundleDirectory, targetDirectory: badPath, tempDirectory: tempDir }),
      { code: 'INVALID_PATH' }
    );
    await assert.rejects(
      restoreBackupBundle({ encryptedFile: validEncFile, passphrase: PASSPHRASE, targetDirectory: targetDir, tempDirectory: badPath }),
      { code: 'INVALID_PATH' }
    );

    assert.throws(
      () => verifyResticBundleEncryption({ bundleDirectory: badPath, passphrase: PASSPHRASE, tempDirectory: tempDir }),
      { code: 'INVALID_PATH' }
    );
    assert.throws(
      () => verifyResticBundleEncryption({ bundleDirectory: bundle.bundleDirectory, passphrase: PASSPHRASE, tempDirectory: badPath }),
      { code: 'INVALID_PATH' }
    );
    assert.throws(
      () => checkResticPilotAvailability({ resticBinary: badPath }),
      { code: 'INVALID_PATH' }
    );
  }

  // 2) Repository & IdentityStore createConsistentBackup direct validation.
  const liveRepo = new Repository(join(dataDir, 'dukkan.sqlite'), 'dukkan');
  const liveId = new IdentityStore(dataDir);
  try {
    for (const badPath of apiBadPaths) {
      assert.throws(() => liveRepo.createConsistentBackup(badPath), { code: 'INVALID_PATH' });
      assert.throws(() => liveId.createConsistentBackup(badPath), { code: 'INVALID_PATH' });
    }
  } finally {
    liveRepo.close();
    liveId.close();
  }

  // 3) CLI calls (including bare relative vectors inside cwd: probeDir).
  const cliPath = join(process.cwd(), 'scripts', 'backup-bundle.mjs');
  const cliEnv = { ...process.env, TEST_BUNDLE_PASS: PASSPHRASE, TEMP: tempDir, TMP: tempDir };
  const runCliExpectInvalidPath = args => {
    const run = spawnSync(process.execPath, [cliPath, ...args], {
      cwd: probeDir,
      env: cliEnv,
      encoding: 'utf8',
      timeout: 15000
    });
    assert.equal(run.status, 1, `Expected CLI failure for [${args.join(' ')}], got stdout=${run.stdout} stderr=${run.stderr}`);
    const errJson = JSON.parse(run.stderr);
    assert.equal(errJson.ok, false);
    assert.equal(errJson.code, 'INVALID_PATH', `Expected INVALID_PATH for [${args.join(' ')}], got ${run.stderr}`);
  };

  const cliVectors = [
    'NUL',
    'CON.enc',
    'COM1.kuyumcu',
    'CONIN$',
    'CONOUT$',
    'CON .bak',
    'AUX/',
    'trailing.',
    'trailing ',
    'CON/../safe',
    'C:CON',
    'ads:stream',
    'bad*name',
    'bad?name',
    '\\\\.\\CON'
  ];
  for (const vec of cliVectors) {
    runCliExpectInvalidPath(['create', '--data-dir', dataDir, '--out-dir', vec]);
    runCliExpectInvalidPath(['create', '--data-dir', vec, '--out-dir', probeDir]);
    runCliExpectInvalidPath(['encrypt', '--bundle-dir', bundle.bundleDirectory, '--out-file', vec, '--passphrase-env', 'TEST_BUNDLE_PASS']);
    runCliExpectInvalidPath(['encrypt', '--bundle-dir', vec, '--out-file', join(probeDir, 'ok.enc'), '--passphrase-env', 'TEST_BUNDLE_PASS']);
    runCliExpectInvalidPath(['decrypt', '--encrypted-file', validEncFile, '--out-dir', vec, '--passphrase-env', 'TEST_BUNDLE_PASS']);
    runCliExpectInvalidPath(['decrypt', '--encrypted-file', vec, '--out-dir', decOutDir, '--passphrase-env', 'TEST_BUNDLE_PASS']);
    runCliExpectInvalidPath(['restore', '--bundle-dir', bundle.bundleDirectory, '--target-dir', vec]);
    runCliExpectInvalidPath(['restore', '--encrypted-file', validEncFile, '--passphrase-env', 'TEST_BUNDLE_PASS', '--target-dir', vec]);
    runCliExpectInvalidPath(['restore', '--bundle-dir', vec, '--target-dir', targetDir]);
    runCliExpectInvalidPath(['check-restic', '--restic-bin', vec]);
  }

  assert.deepEqual(readdirSync(probeDir), []);
  assert.deepEqual(readdirSync(decOutDir), []);
  assert.deepEqual(readdirSync(tempDir), []);
  assertTargetUntouched();
});

test('Faz 1-C/D regression: positive compatibility round-trip with spaces, Turkish characters, and safe lookalikes across API and CLI', async t => {
  const root = makeTempDir('p1-compat-paths-');
  const spacedBase = join(root, 'my backup dir', 'Şube Müşteri İğüşöç');
  const dataDir = join(spacedBase, 'con-123');
  const outDir = join(spacedBase, 'com10');
  const encFile = join(spacedBase, 'null', 'con-123.kuyumcu-enc');
  const decDir = join(spacedBase, 'Şube Açılım', 'dec');
  const restoreDir = join(spacedBase, 'null-restored');
  const cliOutDir = join(spacedBase, 'cli-com10');
  const cliEncFile = join(spacedBase, 'cli-null', 'con-123.enc');
  const cliDecDir = join(spacedBase, 'cli-dec');
  const cliRestoreDir = join(spacedBase, 'cli-restored');
  const tempDir = join(spacedBase, 'geçici temp');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  mkdirSync(decDir, { recursive: true });
  mkdirSync(restoreDir, { recursive: true });
  mkdirSync(cliOutDir, { recursive: true });
  mkdirSync(cliDecDir, { recursive: true });
  mkdirSync(cliRestoreDir, { recursive: true });
  mkdirSync(tempDir, { recursive: true });
  t.after(() => removeTempDir(root));

  const seeded = await seedFullDataDirectory(dataDir, { includeDemo: true });

  // API round-trip
  const bundle = await createBackupBundle({ dataDirectory: dataDir, outputDirectory: outDir, tempDirectory: tempDir });
  assert.ok(existsSync(bundle.manifestPath));
  const enc = await encryptBackupBundle({
    bundleDirectory: bundle.bundleDirectory,
    outputFile: encFile,
    passphrase: PASSPHRASE,
    tempDirectory: tempDir
  });
  assert.ok(existsSync(enc.encryptedFile));
  const dec = await decryptBackupBundle({
    encryptedFile: enc.encryptedFile,
    outputDirectory: decDir,
    passphrase: PASSPHRASE,
    tempDirectory: tempDir
  });
  assert.ok(existsSync(dec.manifestPath));
  const rest = await restoreBackupBundle({
    encryptedFile: enc.encryptedFile,
    passphrase: PASSPHRASE,
    targetDirectory: restoreDir,
    tempDirectory: tempDir
  });
  assert.equal(rest.ok, true);

  const apiRepo = new Repository(join(restoreDir, 'dukkan.sqlite'), 'dukkan');
  try {
    assert.deepEqual(apiRepo.state().balances, seeded.dukkanState.balances);
  } finally {
    apiRepo.close();
  }

  // CLI round-trip
  const cliPath = join(process.cwd(), 'scripts', 'backup-bundle.mjs');
  const cliEnv = { ...process.env, TEST_BUNDLE_PASS: PASSPHRASE, TEMP: tempDir, TMP: tempDir };

  const cRun = spawnSync(process.execPath, [cliPath, 'create', '--data-dir', dataDir, '--out-dir', cliOutDir], {
    env: cliEnv, encoding: 'utf8', timeout: 15000
  });
  assert.equal(cRun.status, 0, cRun.stderr);
  const cJson = JSON.parse(cRun.stdout);

  const eRun = spawnSync(process.execPath, [
    cliPath, 'encrypt', '--bundle-dir', cJson.bundleDirectory, '--out-file', cliEncFile, '--passphrase-env', 'TEST_BUNDLE_PASS'
  ], { env: cliEnv, encoding: 'utf8', timeout: 15000 });
  assert.equal(eRun.status, 0, eRun.stderr);

  const dRun = spawnSync(process.execPath, [
    cliPath, 'decrypt', '--encrypted-file', cliEncFile, '--out-dir', cliDecDir, '--passphrase-env', 'TEST_BUNDLE_PASS'
  ], { env: cliEnv, encoding: 'utf8', timeout: 15000 });
  assert.equal(dRun.status, 0, dRun.stderr);

  const rRun = spawnSync(process.execPath, [
    cliPath, 'restore', '--encrypted-file', cliEncFile, '--passphrase-env', 'TEST_BUNDLE_PASS', '--target-dir', cliRestoreDir
  ], { env: cliEnv, encoding: 'utf8', timeout: 15000 });
  assert.equal(rRun.status, 0, rRun.stderr);

  const cliRepo = new Repository(join(cliRestoreDir, 'dukkan.sqlite'), 'dukkan');
  try {
    assert.deepEqual(cliRepo.state().balances, seeded.dukkanState.balances);
  } finally {
    cliRepo.close();
  }
});
