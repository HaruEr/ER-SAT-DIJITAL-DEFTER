import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { applyEvent, emptyState, fail } from './domain.mjs';

export const ARCHIVE_MAX_BYTES = 512 * 1024 * 1024;
export const ARCHIVE_MAX_EVENTS = 250000;
export const ARCHIVE_MAX_LINE_BYTES = 8 * 1024 * 1024 + 64 * 1024;
const FORMAT = 'kuyumcu-ledger-ndjson-v1';
const invalid = () => fail('Arşiv biçimi, sırası veya bütünlük doğrulaması geçersiz.', { code: 'ARCHIVE_INVALID' });
const tooLarge = () => fail('Arşiv desteklenen 512 MiB, 250.000 olay veya satır boyutu sınırını aşıyor.', { status: 413, code: 'ARCHIVE_TOO_LARGE' });
const storedInvalid = () => { throw Object.assign(new Error('Stored ledger history failed archive validation.'), { code: 'STORED_HISTORY_INVALID' }); };
const keysAre = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function exportLedgerArchive(repository, filename) {
  let descriptor, owned = false, transaction = false, count = 0, bytes = 0, pendingBytes = 0;
  const pending = [], hash = createHash('sha256'), state = emptyState(), seen = new Set();
  function flush() {
    if (!pendingBytes) return;
    const buffer = Buffer.concat(pending, pendingBytes);
    let offset = 0;
    while (offset < buffer.length) offset += writeSync(descriptor, buffer, offset);
    pending.length = 0; pendingBytes = 0;
  }
  function line(value, hashed = true) {
    const buffer = Buffer.from(JSON.stringify(value) + '\n');
    if (buffer.length - 1 > ARCHIVE_MAX_LINE_BYTES || bytes + buffer.length > ARCHIVE_MAX_BYTES) tooLarge();
    bytes += buffer.length;
    if (hashed) hash.update(buffer);
    pending.push(buffer); pendingBytes += buffer.length;
    if (pendingBytes >= 64 * 1024) flush();
  }
  try {
    descriptor = openSync(filename, 'wx', 0o600);
    owned = true;
    repository.db.exec('BEGIN'); transaction = true;
    const revision = repository.db.prepare('SELECT revision FROM meta WHERE id=1').get()?.revision;
    if (!Number.isSafeInteger(revision) || revision < 0) storedInvalid();
    line({ type: 'header', format: FORMAT, workspace: repository.workspace, eventSchema: 3, sourceRevision: revision, exportedAt: new Date().toISOString() });
    for (const row of repository.db.prepare('SELECT seq,id,body FROM events ORDER BY seq').iterate()) {
      if (++count > ARCHIVE_MAX_EVENTS) tooLarge();
      let event;
      try {
        event = JSON.parse(row.body);
        if (event?.id !== row.id) storedInvalid();
        applyEvent(state, event, seen);
      } catch { storedInvalid(); }
      line({ type: 'event', event });
    }
    const sha256 = hash.digest('hex');
    line({ type: 'trailer', count, sha256 }, false);
    flush(); fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
    repository.db.exec('COMMIT'); transaction = false;
    return { workspace: repository.workspace, revision, eventCount: count, bytes, sha256 };
  } catch (error) {
    if (transaction) repository.db.exec('ROLLBACK');
    // Never remove a pre-existing file when the exclusive open itself failed.
    if (descriptor !== undefined) closeSync(descriptor);
    if (owned) rmSync(filename, { force: true });
    throw error;
  }
}

async function* archiveLines(source) {
  let bytes = 0, lineBytes = 0;
  const parts = [];
  for await (const incoming of source) {
    const chunk = Buffer.isBuffer(incoming) ? incoming : Buffer.from(incoming);
    bytes += chunk.length;
    if (bytes > ARCHIVE_MAX_BYTES) tooLarge();
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset), end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      lineBytes += part.length;
      if (lineBytes > ARCHIVE_MAX_LINE_BYTES) tooLarge();
      if (part.length) parts.push(part);
      if (newline < 0) break;
      const line = Buffer.concat(parts, lineBytes);
      parts.length = 0; lineBytes = 0;
      yield line;
      offset = end + 1;
    }
  }
  // The exporter always terminates every record, including the trailer, with LF.
  if (lineBytes) invalid();
}

export async function importLedgerArchive(repository, source, { revision, confirmation, temporaryDirectory = tmpdir(), beforeCommit } = {}) {
  if (confirmation !== 'GERİ YÜKLE') fail('Geri yükleme onayı eşleşmiyor.');
  if (!Number.isSafeInteger(revision) || revision < 0) fail('Geçerli ekran sürümü gerekli.');
  const temporaryRoot = resolve(temporaryDirectory);
  mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(join(temporaryRoot, 'ledger-import-')), filename = join(directory, 'stage.sqlite');
  let stage, attached = false, transaction = false;
  try {
    stage = new DatabaseSync(filename);
    stage.exec('CREATE TABLE events(seq INTEGER PRIMARY KEY,id TEXT UNIQUE NOT NULL,body TEXT NOT NULL); BEGIN');
    const insert = stage.prepare('INSERT INTO events(id,body) VALUES(?,?)');
    const hash = createHash('sha256'), decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const state = emptyState(), seen = new Set();
    let header = false, trailer = false, count = 0;
    for await (const bytes of archiveLines(source)) {
      if (trailer || !bytes.length) invalid();
      let record;
      try { record = JSON.parse(decoder.decode(bytes)); } catch { invalid(); }
      if (!header) {
        if (bytes.length > 4096 || !keysAre(record, ['type', 'format', 'workspace', 'eventSchema', 'sourceRevision', 'exportedAt']) || record.type !== 'header' || record.format !== FORMAT || record.eventSchema !== 3 || !Number.isSafeInteger(record.sourceRevision) || record.sourceRevision < 0 || typeof record.exportedAt !== 'string' || record.exportedAt.length > 40 || !Number.isFinite(Date.parse(record.exportedAt))) invalid();
        if (record.workspace !== repository.workspace) fail('Arşivin çalışma alanı eşleşmiyor. Örnek ve dükkân kayıtları birbirine yüklenemez.');
        hash.update(bytes); hash.update('\n'); header = true;
      } else if (record?.type === 'event') {
        if (!keysAre(record, ['type', 'event'])) invalid();
        if (++count > ARCHIVE_MAX_EVENTS) tooLarge();
        applyEvent(state, record.event, seen);
        insert.run(record.event.id, JSON.stringify(record.event));
        hash.update(bytes); hash.update('\n');
      } else if (record?.type === 'trailer') {
        if (!keysAre(record, ['type', 'count', 'sha256']) || !Number.isSafeInteger(record.count) || record.count !== count || !/^[a-f0-9]{64}$/.test(record.sha256) || record.sha256 !== hash.digest('hex')) invalid();
        trailer = true;
      } else invalid();
    }
    if (!header || !trailer) invalid();
    stage.exec('COMMIT'); stage.close(); stage = undefined;

    // Only our own fixed-schema staging database is attached, never a client SQLite file.
    repository.db.prepare('ATTACH DATABASE ? AS incoming_archive').run(filename); attached = true;
    repository.db.exec('BEGIN IMMEDIATE'); transaction = true;
    const current = repository.db.prepare('SELECT revision FROM meta WHERE id=1').get()?.revision;
    if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) throw new Error('Stored revision metadata is invalid.');
    if (current !== revision) fail('Veriler değişti. Geri yüklemeden önce yenileyin.', { status: 409, code: 'REVISION_CONFLICT' });
    // Preserve exact old seq/id/body in SQLite, without building a second full JS history.
    // SQLite's aggregate still uses native memory proportional to the old history.
    const archived = repository.db.prepare(`INSERT INTO restore_archive(created_at,body)
      SELECT ?,json_object('format','kuyumcu-raw-history-v1','workspace',?,'revision',?,
        'records',json_group_array(json_object('seq',seq,'id',id,'body',body)))
      FROM (SELECT seq,id,body FROM events ORDER BY seq)`).run(new Date().toISOString(), repository.workspace, current);
    const archiveId = Number(archived.lastInsertRowid);
    if (!Number.isSafeInteger(archiveId)) throw new Error('Archive identifier exceeds supported range.');
    repository.db.exec('DELETE FROM events; INSERT INTO events(seq,id,body) SELECT seq,id,body FROM incoming_archive.events ORDER BY seq; UPDATE meta SET revision=revision+1 WHERE id=1;');
    beforeCommit?.();
    repository.db.exec('COMMIT');
    transaction = false;
    return { workspace: repository.workspace, revision: current + 1, restoredEvents: count, archiveId };
  } catch (error) {
    if (transaction) repository.db.exec('ROLLBACK');
    throw error;
  } finally {
    if (attached) repository.db.exec('DETACH DATABASE incoming_archive');
    if (stage) { if (stage.isTransaction) stage.exec('ROLLBACK'); stage.close(); }
    if (dirname(resolve(directory)) !== temporaryRoot) throw new Error('Temporary archive directory is outside its owned root.');
    rmSync(directory, { recursive: true, force: true });
  }
}
