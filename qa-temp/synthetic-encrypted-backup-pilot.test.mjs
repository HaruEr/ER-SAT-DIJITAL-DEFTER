import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSyntheticEncryptedBackupPilot, validatePilotParent, validatePilotToolCopy } from '../scripts/synthetic-encrypted-backup-pilot.mjs';

const allowedParent = resolve(dirname(fileURLToPath(import.meta.url)), '../../temp');
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(allowedParent, { recursive: true });

test('standalone child rejects out-of-scope, missing and junction targets without creating a database',()=>{
  const helper=fileURLToPath(new URL('../scripts/synthetic-restored-reader.mjs',import.meta.url));
  const artifact=mkdtempSync(join(allowedParent,'encrypted-backup-pilot-')),directory=join(artifact,'restored-database');
  mkdirSync(directory);const missing=join(directory,'absent.sqlite');
  const reject=filename=>{
    const child=spawnSync(process.execPath,[helper,filename],{env:{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,TEMP:allowedParent,TMP:allowedParent},shell:false,windowsHide:true,encoding:'utf8',timeout:10000,maxBuffer:16384});
    assert.equal(child.error,undefined);assert.equal(child.status,1);assert.equal(child.stdout,'');
    assert.equal(child.stderr.trim(),'SYNTHETIC_READER_FAILED');
  };
  for(const path of [resolve(allowedParent,'../outside.sqlite'),join(sourceRoot,'data','real.sqlite'),missing])reject(path);
  assert.equal(existsSync(missing),false);
  const linkedArtifact=mkdtempSync(join(allowedParent,'encrypted-backup-pilot-')),link=join(linkedArtifact,'restored-database');
  symlinkSync(directory,link,'junction');
  try {reject(join(link,'absent.sqlite'));}finally{unlinkSync(link);}
  assert.equal(existsSync(missing),false);
});

test('pilot rejects production and traversal parents before creating any artifacts', () => {
  for (const parentDirectory of [join(sourceRoot,'data'),join(sourceRoot,'.local'),resolve(allowedParent, '..'),resolve(allowedParent,'../temp-other'), 'relative-temp']) {
    assert.throws(() => validatePilotParent(parentDirectory), error => error.code === 'PILOT_PATH_REJECTED');
  }
  assert.equal(validatePilotParent(allowedParent), allowedParent);
});

test('pilot rejects a real junction inside its own synthetic temp area', () => {
  const directory=mkdtempSync(join(allowedParent,'pilot-junction-check-')),target=join(directory,'target'),link=join(directory,'link');
  mkdirSync(target);symlinkSync(target,link,'junction');
  try {assert.throws(()=>validatePilotParent(link),error=>error.code==='PILOT_PATH_REJECTED');}
  finally {unlinkSync(link);}
});

test('pilot rejects an explicitly supplied untrusted binary before execution', async () => {
  const directory=mkdtempSync(join(allowedParent,'pilot-invalid-tool-'));
  const binary=join(directory,'never-executed.exe');
  writeFileSync(binary,'This is deliberately not the pinned restic executable.');
  await assert.rejects(runSyntheticEncryptedBackupPilot({parentDirectory:allowedParent,resticBinary:binary}),
    error=>error.code==='PILOT_TOOL_HASH_MISMATCH');
  await assert.rejects(runSyntheticEncryptedBackupPilot({parentDirectory:allowedParent,resticBinary:join(directory,'missing.exe')}),
    error=>error.code==='PILOT_TOOL_UNAVAILABLE');
});

test('a modified copy fails the pinned tool digest check without execution', () => {
  const pin=JSON.parse(readFileSync(new URL('../scripts/restic-pilot-tool.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));
  const directory=mkdtempSync(join(allowedParent,'pilot-tool-check-')),copy=join(directory,'not-executed.exe');
  copyFileSync(resolve(sourceRoot,process.env.RESTIC_PILOT_BINARY || pin.binaryPath),copy);assert.equal(validatePilotToolCopy(copy),true);
  const bytes=readFileSync(copy);bytes[0]^=0xff;writeFileSync(copy,bytes);
  assert.throws(()=>validatePilotToolCopy(copy),error=>error.code==='PILOT_TOOL_HASH_MISMATCH');
});

test('explicit synthetic restic pilot verifies exact snapshot and fails closed under real failures', { timeout: 180000 }, async t => {
  // This file is outside test/*.test.mjs. The opt-in command fails explicitly
  // when the pinned local tool is absent; it never silently skips encryption.
  const { evidence, inspection } = await runSyntheticEncryptedBackupPilot({ parentDirectory: allowedParent, exerciseFailures: true });
  await t.test('consistent archive restores the independent fixed financial oracle', () => {
    const expected = { bilezikAdet: 9, bilezik22: 89000, ceyrek: 1, nakit: 950000, 'cari-buyer': 20000 };
    for (const [id, value] of Object.entries(expected)) {
      assert.equal(inspection.sourceBalances[id], value);
      assert.equal(inspection.restoredBalances[id], value);
      assert.equal(inspection.reopenedBalances[id], value);
    }
    assert.equal(inspection.previousRevenue, 100000); assert.equal(inspection.currentRevenue, -40000);
    assert.equal(evidence.status, 'LOCAL_VERIFIED'); assert.equal(evidence.localOnly, true); assert.equal(evidence.syntheticOnly, true);
    assert.match(evidence.snapshotId, /^[a-f0-9]{64}$/);
    assert.equal(evidence.sourceRevision, 5); assert.equal(evidence.restoredRevision, 1);
    assert.equal(evidence.archiveByteHash, evidence.restoredArchiveByteHash);
    assert.equal(inspection.sourceEventsHash, inspection.restoredEventsHash);
    assert.equal(evidence.sourceUnchanged, true);
    assert.ok(Date.parse(evidence.captureAt) <= Date.parse(evidence.verifiedAt));
  });
  await t.test('fresh read-only Node process independently verifies restored database before publication', () => {
    const child=inspection.childVerification;
    assert.equal(child.verified,true);assert.ok(Number.isSafeInteger(child.pid)&&child.pid>0);
    assert.notEqual(child.pid,process.pid);assert.equal(child.integrity,'ok');
    assert.equal(child.date,'2026-10-28');assert.equal(child.revision,1);
    assert.equal(child.eventsHash,inspection.sourceEventsHash);
    assert.deepEqual(child.balances,{bilezikAdet:9,bilezik22:89000,ceyrek:1,nakit:950000,'cari-buyer':20000});
    assert.equal(child.previousRevenue,100000);assert.equal(child.currentRevenue,-40000);
    assert.equal(child.databaseBytesUnchanged,true);
    assert.equal(evidence.freshProcessVerified,true);
  });
  for(const [name,code] of Object.entries({childCorruptDatabase:'CHILD_READER_FAILED',childMalformedResult:'CHILD_RESULT_INVALID',childOracleMismatch:'CHILD_ORACLE_MISMATCH'})) {
    await t.test(`${name} rejects shared verification pipeline and preserves the prior recovery point`,()=>{
      const result=evidence.failureChecks[name];
      assert.equal(result.code,code);assert.equal(result.rejected,true);
      assert.equal(result.lastVerifiedPointUnchanged,true);assert.equal(result.targetUnchanged,true);
      assert.equal(result.childAttempted,true);assert.equal(result.faultStage,'fresh-process-validation');
      if(name==='childCorruptDatabase')assert.ok(result.childExit>0);
    });
  }
  await t.test('encrypted manifest describes exact active-ledger scope and binds the restored archive', () => {
    const manifest = inspection.restoredManifest;
    assert.equal(manifest.manifestVersion, 1);
    assert.equal(manifest.syntheticOnly, true); assert.equal(manifest.localOnly, true);
    assert.equal(manifest.coverage, 'active-ledger-only');
    assert.deepEqual(manifest.exclusions, ['restore_archive', 'identity', 'settings']);
    assert.deepEqual(manifest.archive, { filename: 'ledger.ndjson', byteHash: evidence.archiveByteHash,
      workspace: 'demo', sourceRevision: 5, captureAt: evidence.captureAt, eventSchema: 3 });
    assert.equal(Object.hasOwn(manifest, 'snapshotId'), false);
    assert.deepEqual(inspection.snapshotPayloadFiles, ['backup-manifest.json', 'ledger.ndjson']);
  });
  const manifestFaults = {
    manifestMissing: 'MANIFEST_MISSING', manifestMalformed: 'MANIFEST_INVALID',
    manifestOversized: 'MANIFEST_TOO_LARGE', manifestVersion: 'MANIFEST_VERSION_UNSUPPORTED',
    manifestScope: 'MANIFEST_SCOPE_INVALID', manifestPath: 'MANIFEST_ARCHIVE_NAME_INVALID',
    manifestRevision: 'MANIFEST_BINDING_MISMATCH', manifestWorkspace: 'MANIFEST_BINDING_MISMATCH',
    manifestHash: 'MANIFEST_BINDING_MISMATCH', manifestCapture: 'MANIFEST_BINDING_MISMATCH',
    manifestEventSchema: 'MANIFEST_BINDING_MISMATCH', manifestUnknownField: 'MANIFEST_INVALID',
    manifestExclusions: 'MANIFEST_SCOPE_INVALID', manifestExtraPayload: 'MANIFEST_PAYLOAD_INVALID',
    manifestCoherentHeader: 'MANIFEST_BINDING_MISMATCH'
  };
  for (const [name, code] of Object.entries(manifestFaults)) {
    await t.test(`${name} rejects restored manifest before target creation and point publication`, () => {
      const failure = evidence.failureChecks[name];
      assert.equal(failure.code, code); assert.equal(failure.rejected, true);
      assert.equal(failure.targetCreated, false); assert.equal(failure.targetUnchanged, true);
      assert.equal(failure.lastVerifiedPointUnchanged, true);
      assert.equal(failure.restoredFromSnapshot, true);
      assert.equal(failure.faultStage, 'decrypted-manifest-validation');
    });
  }
  const expectedCodes={wrongPassword:'RESTIC_WRONG_PASSWORD_FAILED',corruptEncryptedCopy:'RESTIC_CORRUPT_COPY_FAILED',unavailableTool:'PILOT_TOOL_UNAVAILABLE',unavailableRepository:'RESTIC_UNAVAILABLE_REPOSITORY_FAILED',failedBackup:'RESTIC_BACKUP_FAILED',successfulBackupFailedVerification:'ARCHIVE_BYTE_HASH_MISMATCH',wrongWorkspace:'WORKSPACE_MISMATCH',staleRevision:'REVISION_CONFLICT',truncatedArchive:'ARCHIVE_INVALID'};
  for (const name of Object.keys(expectedCodes)) {
    await t.test(`${name} fails and preserves the last verified point`, () => {
      const failure = evidence.failureChecks[name];
      assert.equal(failure.rejected, true, name); assert.equal(failure.lastVerifiedPointUnchanged, true, name);
      assert.equal(failure.targetUnchanged, true, name);
      assert.equal(failure.code,expectedCodes[name],name);
      if(name.startsWith('wrongPassword')||name==='corruptEncryptedCopy'||name==='unavailableRepository'||name==='failedBackup')assert.ok(failure.childExit>0,name);
      if(['wrongWorkspace','staleRevision','truncatedArchive'].includes(name)){
        assert.equal(failure.protectedEventCount,1);assert.equal(failure.protectedArchiveCount,1);assert.equal(failure.protectedRevision,2);assert.equal(failure.reopenedTargetUnchanged,true);
      }
      if(name==='successfulBackupFailedVerification'){
        assert.equal(failure.candidateSnapshotCreated,true);assert.match(failure.candidateSnapshotId,/^[a-f0-9]{64}$/);
        assert.equal(failure.code,'ARCHIVE_BYTE_HASH_MISMATCH');
      }
    });
  }
  await t.test('saved evidence contains no credential or ledger payload and no cloud acceptance claim', () => {
    const saved = readFileSync(evidence.evidenceFile, 'utf8');
    assert.equal(inspection.evidenceContainsCredential, false);
    assert.equal(inspection.encryptedRepoContainsSentinel, false);
    assert.doesNotMatch(saved, /passwordFile|password-file|RESTIC_PASSWORD|PRIVATE_SYNTHETIC_LEDGER_MARKER/);
    assert.equal(evidence.cloudVerified, false); assert.equal(evidence.rpoAccepted, false); assert.equal(evidence.rtoAccepted, false);
  });
});
