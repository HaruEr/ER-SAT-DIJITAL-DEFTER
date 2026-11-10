/**
 * Pure synthetic recovery-point evaluator; no clock reads, storage or provider.
 * Inputs are trusted validation observations, not proof that remote verification
 * or the latest health check actually happened. No health TTL is invented here.
 *
 * Clock proof is an explicit paired integral-millisecond measurement contract:
 * anchor.wallAt <= captureAt, same nonempty sessionId at anchor and now, and
 * identical nonnegative wall/monotonic elapsed time. Floats, sampling ambiguity,
 * restart and clock drift fail closed. This is NOT a production clock adapter.
 * Dates are canonical UTC ISO strings (YYYY-MM-DDTHH:mm:ss.sssZ).
 * remoteRpoMet evaluates only the supplied snapshot's 900-second age target;
 * it never accepts operational/cloud RPO, an RTO, or a recovery drill.
 */
const statuses = new Set(['CAPTURED', 'ENCRYPTED', 'UPLOADED', 'LOCAL_VERIFIED', 'REMOTE_VERIFIED']);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const timestamp = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : NaN;
};

export function evaluateRecoveryPoint(point, measurement) {
  const result = (status, reason, ageMs = null, usable = false, remoteRpoMet = false) => ({
    status, reason, ageMs, usable, remoteRpoMet, rtoAccepted: false, operationalAccepted: false
  });
  const unknown = reason => result('UNKNOWN', reason);
  if (!point || !statuses.has(point.status) || !nonempty(point.snapshotId) || !nonempty(point.workspace)
      || typeof point.archiveHash !== 'string' || !/^[a-f0-9]{64}$/i.test(point.archiveHash)
      || !Number.isSafeInteger(point.sourceRevision) || point.sourceRevision < 0
      || (point.status === 'REMOTE_VERIFIED' && !nonempty(point.remoteObjectId))) return unknown('INVALID_POINT');
  const verified = point.status === 'LOCAL_VERIFIED' || point.status === 'REMOTE_VERIFIED';
  const capture = timestamp(point.captureAt), verification = timestamp(point.verifiedAt);
  const upload = point.uploadedAt === undefined ? null : timestamp(point.uploadedAt);
  if (!Number.isFinite(capture) || ((verified || point.verifiedAt !== undefined) && !Number.isFinite(verification)) || (upload !== null && !Number.isFinite(upload))) return unknown('INVALID_TIMESTAMP');
  const anchor = measurement?.anchor, now = measurement?.now;
  if (!anchor || !now || !nonempty(anchor.sessionId) || anchor.sessionId !== now.sessionId
      || !Number.isSafeInteger(anchor.monotonicMs) || anchor.monotonicMs < 0
      || !Number.isSafeInteger(now.monotonicMs) || now.monotonicMs < 0) return unknown('CLOCK_UNCERTAIN');
  const anchorWall = timestamp(anchor.wallAt), nowWall = timestamp(now.wallAt);
  if (!Number.isFinite(anchorWall) || !Number.isFinite(nowWall) || anchorWall > capture) return unknown('CLOCK_UNCERTAIN');
  const wallElapsed = nowWall - anchorWall, monoElapsed = now.monotonicMs - anchor.monotonicMs;
  if (!Number.isSafeInteger(wallElapsed) || !Number.isSafeInteger(monoElapsed)
      || wallElapsed < 0 || monoElapsed < 0 || wallElapsed !== monoElapsed) return unknown('CLOCK_CONTRADICTION');
  if (capture > nowWall || (verified && (verification < capture || verification > nowWall))
      || (upload !== null && (upload < capture || upload > nowWall || (verified && upload > verification)))) return unknown('TIMESTAMP_ORDER');
  const ageMs = nowWall - capture;
  if (!verified) return result('UNUSABLE', 'NOT_VERIFIED', ageMs);
  const integrity = point.integrity;
  if (!integrity || integrity.status !== 'HEALTHY') return result('UNUSABLE', 'INTEGRITY_NOT_HEALTHY', ageMs);
  if (['snapshotId', 'archiveHash', 'workspace', 'sourceRevision'].some(key => integrity[key] !== point[key])) return unknown('INTEGRITY_IDENTITY_MISMATCH');
  if (point.status === 'REMOTE_VERIFIED' && integrity.remoteObjectId !== point.remoteObjectId) return unknown('INTEGRITY_IDENTITY_MISMATCH');
  const checked = timestamp(integrity.checkedAt);
  if (!Number.isFinite(checked)) return unknown('INVALID_TIMESTAMP');
  if (checked < verification || checked > nowWall) return unknown('TIMESTAMP_ORDER');
  if (point.status === 'LOCAL_VERIFIED') return result('LOCAL_VERIFIED', 'LOCAL_ONLY', ageMs, true);
  return result('REMOTE_VERIFIED', ageMs <= 900000 ? 'WITHIN_RPO' : 'RPO_EXCEEDED', ageMs, true, ageMs <= 900000);
}
