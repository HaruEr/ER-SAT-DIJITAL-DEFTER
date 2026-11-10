import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRecoveryPoint } from '../scripts/recovery-point-status.mjs';

const iso = milliseconds => new Date(Date.UTC(2026, 9, 31) + milliseconds).toISOString();
function fixture(age = 900000) {
  const identity = { snapshotId: 'snapshot-1', archiveHash: 'a'.repeat(64), workspace: 'synthetic', sourceRevision: 5 };
  return {
    point: { ...identity, captureAt: iso(0), uploadedAt: iso(1000), verifiedAt: iso(2000), status: 'REMOTE_VERIFIED', remoteObjectId: 'object-1', integrity: { ...identity, remoteObjectId: 'object-1', status: 'HEALTHY', checkedAt: iso(3000) } },
    measurement: { anchor: { wallAt: iso(0), monotonicMs: 100, sessionId: 'session-1' }, now: { wallAt: iso(age), monotonicMs: age + 100, sessionId: 'session-1' } }
  };
}
const evaluate = f => evaluateRecoveryPoint(f.point, f.measurement);
function unknown(f, reason) {
  const result = evaluate(f);
  assert.equal(result.status, 'UNKNOWN'); assert.equal(result.reason, reason);
  assert.equal(result.usable, false); assert.equal(result.remoteRpoMet, false);
}

test('capture age includes upload and verification delay; 900 seconds inclusive, one millisecond over stale', () => {
  const exact = evaluate(fixture());
  assert.equal(exact.ageMs, 900000); assert.equal(exact.remoteRpoMet, true); assert.equal(exact.reason, 'WITHIN_RPO');
  const late = fixture(900001); late.point.uploadedAt = iso(899000); late.point.verifiedAt = iso(900000); late.point.integrity.checkedAt = iso(900000);
  assert.equal(evaluate(late).ageMs, 900001); assert.equal(evaluate(late).remoteRpoMet, false); assert.equal(evaluate(late).reason, 'RPO_EXCEEDED');
});
test('local and unfinished stages never imply remote protection', () => {
  for (const status of ['LOCAL_VERIFIED', 'CAPTURED', 'ENCRYPTED', 'UPLOADED']) {
    const f = fixture(); f.point.status = status; delete f.point.remoteObjectId;
    const result = evaluate(f); assert.equal(result.remoteRpoMet, false);
    assert.equal(result.usable, status === 'LOCAL_VERIFIED');
  }
});
test('current unhealthy or missing integrity downgrades historically verified snapshots', () => {
  for (const health of [undefined, 'MISSING', 'CORRUPT', 'UNKNOWN']) {
    const f = fixture(); if (health) f.point.integrity.status = health; else delete f.point.integrity;
    const result = evaluate(f); assert.equal(result.usable, false); assert.equal(result.remoteRpoMet, false); assert.equal(result.reason, 'INTEGRITY_NOT_HEALTHY');
  }
});
test('health must belong to this exact snapshot identity', () => {
  for (const key of ['snapshotId', 'archiveHash', 'workspace', 'sourceRevision']) {
    const f = fixture(); f.point.integrity[key] = key === 'sourceRevision' ? 6 : 'other'; unknown(f, 'INTEGRITY_IDENTITY_MISMATCH');
  }
});
test('required identity, revision and status reject malformed values', () => {
  for (const [key, value] of [['snapshotId',''],['workspace',''],['archiveHash','bad'],['sourceRevision',-1],['sourceRevision',1.5],['sourceRevision',NaN],['sourceRevision',Infinity],['status','ACK'],['remoteObjectId','']]) {
    const f = fixture(); f.point[key] = value; unknown(f, 'INVALID_POINT');
  }
});
test('invalid, ambiguous and normalized calendar dates fail closed', () => {
  for (const value of ['bad', '2026-10-31T00:00:00', '2026-02-30T00:00:00.000Z', NaN, Infinity, null]) {
    const f = fixture(); f.point.captureAt = value; unknown(f, 'INVALID_TIMESTAMP');
  }
});
test('capture, upload, verification and health timestamps must be ordered and not future', () => {
  for (const alter of [f=>f.point.captureAt=iso(900001),f=>f.point.verifiedAt=iso(-1),f=>f.point.verifiedAt=iso(900001),f=>f.point.uploadedAt=iso(-1),f=>f.point.uploadedAt=iso(2001),f=>f.point.integrity.checkedAt=iso(1999),f=>f.point.integrity.checkedAt=iso(900001)]) {
    const f = fixture(); alter(f); unknown(f, 'TIMESTAMP_ORDER');
  }
});
test('clock rollback and wall/monotonic contradictions fail closed', () => {
  for (const alter of [f=>f.measurement.now.wallAt=iso(-1),f=>f.measurement.now.monotonicMs=99,f=>f.measurement.now.monotonicMs+=1,f=>f.measurement.now.wallAt=iso(900001)]) {
    const f = fixture(); alter(f); unknown(f, 'CLOCK_CONTRADICTION');
  }
});
test('restart, missing clock proof, and post-capture anchor cannot validate elapsed age', () => {
  for (const alter of [f=>f.measurement.now.sessionId='restarted',f=>f.measurement.anchor.sessionId='',f=>f.measurement.anchor=null,f=>f.measurement.now.monotonicMs=NaN,f=>f.measurement.now.monotonicMs=Infinity,f=>f.measurement.anchor.wallAt=iso(1)]) {
    const f=fixture(); alter(f); unknown(f, 'CLOCK_UNCERTAIN');
  }
});
test('earlier same-session anchor is accepted and does not replace capture time', () => {
  const f=fixture(); f.measurement.anchor.wallAt=iso(-100); f.measurement.anchor.monotonicMs=0;
  assert.equal(evaluate(f).ageMs,900000); assert.equal(evaluate(f).remoteRpoMet,true);
});
test('pure evaluation preserves inputs and never infers RTO or operational acceptance', () => {
  const f=fixture(); const before=structuredClone(f);
  const first=evaluate(f), second=evaluate(f);
  assert.deepEqual(f,before); assert.deepEqual(first,second);
  assert.equal(first.rtoAccepted,false); assert.equal(first.operationalAccepted,false);
});

test('missing inputs, unsafe revisions, fractional clocks and absent proof timestamps fail closed', () => {
  for (const point of [null, undefined]) assert.equal(evaluateRecoveryPoint(point, fixture().measurement).reason, 'INVALID_POINT');
  for (const measurement of [null, undefined]) assert.equal(evaluateRecoveryPoint(fixture().point, measurement).reason, 'CLOCK_UNCERTAIN');
  const unsafe=fixture(); unsafe.point.sourceRevision=Number.MAX_SAFE_INTEGER+1; unknown(unsafe,'INVALID_POINT');
  const fractional=fixture(); fractional.measurement.now.monotonicMs+=0.5; unknown(fractional,'CLOCK_UNCERTAIN');
  for (const key of ['verifiedAt','checkedAt']) {
    const f=fixture(); if(key==='verifiedAt')delete f.point.verifiedAt;else delete f.point.integrity.checkedAt;
    unknown(f,'INVALID_TIMESTAMP');
  }
});

test('remote health observation binds the exact remote object; local observation needs no remote object', () => {
  for (const value of [undefined, 'other-object']) {
    const f=fixture(); f.point.integrity.remoteObjectId=value;
    unknown(f, 'INTEGRITY_IDENTITY_MISMATCH');
  }
  const redirected=fixture(); redirected.point.remoteObjectId='missing-object-2';
  unknown(redirected, 'INTEGRITY_IDENTITY_MISMATCH');
  const local=fixture(); local.point.status='LOCAL_VERIFIED';
  delete local.point.remoteObjectId; delete local.point.integrity.remoteObjectId;
  assert.equal(evaluate(local).usable,true); assert.equal(evaluate(local).remoteRpoMet,false);
});
