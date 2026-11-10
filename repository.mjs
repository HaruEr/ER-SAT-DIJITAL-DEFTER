import { usesInventory } from './inventory.mjs';
import { projectSupplierDetail } from './supplier-view.mjs';
import { underlyingSaleCommand } from './sale-pricing.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { replay, fail, text, eventVersion, eventActor } from './domain.mjs';
import { exportLedgerArchive, importLedgerArchive } from './archive.mjs';
import { LEDGER_CACHE_MAX_BYTES, applyLedgerEvent, estimateLedgerBytes, hydrateLedger, normalizeJournalOptions, projectAccountStatement, projectJournal, projectLedger } from './ledger-view.mjs';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const BACKUP_MAX_BYTES = 64 * 1024 * 1024;
const backupTooLarge = () => fail('JSON yedeği desteklenen 64 MiB sınırını aşıyor. Büyük defter için Yedek ekranındaki akışlı arşivi kullanın.', { status: 413, code: 'BACKUP_TOO_LARGE' });
export function assertBackupSize(backup) {
  if (Buffer.byteLength(JSON.stringify(backup), 'utf8') > BACKUP_MAX_BYTES) backupTooLarge();
}
export class Repository {
  #cache = null;
  #cacheMaxBytes;
  #hits = 0;
  #misses = 0;
  constructor(filename = ':memory:', workspace = 'test', { cacheMaxBytes = LEDGER_CACHE_MAX_BYTES } = {}) {
    if (!Number.isSafeInteger(cacheMaxBytes) || cacheMaxBytes < 0 || cacheMaxBytes > LEDGER_CACHE_MAX_BYTES) throw new Error('Invalid ledger cache budget.');
    this.#cacheMaxBytes = cacheMaxBytes;
    this.workspace = workspace;
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO meta VALUES(1,0);
      CREATE TABLE IF NOT EXISTS restore_archive(id INTEGER PRIMARY KEY, created_at TEXT, body TEXT NOT NULL);`);
  }
  events({ stream = false } = {}) {
    const rows = this.db.prepare('SELECT body FROM events ORDER BY seq').iterate();
    const iterator = (function* () { for (const row of rows) yield JSON.parse(row.body); })();
    return stream ? iterator : [...iterator];
  }
  itemPhoto(code) {
    const item = this.#ownedLedger().state.inventoryItems?.find(row => row.code === code);
    if (!item?.hasPhoto) fail('Ürün fotoğrafı bulunamadı.', { status:404 });
    const event = this.db.prepare('SELECT body FROM events WHERE id = ?').get(item.registeredId);
    return JSON.parse(event.body).command.photo;
  }
  exportArchive(filename) { return exportLedgerArchive(this, filename); }
  restoreArchive(source, options) { return importLedgerArchive(this, source, options); }
  #fingerprint() {
    const revision = this.db.prepare('SELECT revision FROM meta WHERE id=1').get()?.revision;
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Stored revision metadata is invalid.');
    return { revision, key: JSON.stringify([revision, this.db.prepare('PRAGMA data_version').get().data_version, this.db.prepare('SELECT total_changes() AS changes').get().changes, this.db.prepare('PRAGMA schema_version').get().schema_version]) };
  }
  #remember(ledger, key) {
    const estimatedBytes = estimateLedgerBytes(ledger);
    this.#cache = estimatedBytes <= this.#cacheMaxBytes ? { ledger, key, estimatedBytes } : null;
  }
  #ownedLedger() {
    const ownTransaction = !this.db.isTransaction;
    if (ownTransaction) this.db.exec('BEGIN');
    try {
      const { revision, key } = this.#fingerprint();
      let ledger;
      if (this.#cache?.key === key) { this.#hits++; ledger = this.#cache.ledger; }
      else { this.#misses++; ledger = hydrateLedger(this.events({ stream: true })); ledger.state.revision = revision; }
      if (ownTransaction) {
        this.db.exec('COMMIT');
        this.#remember(ledger, key);
      }
      return ledger;
    } catch (error) {
      this.#cache = null;
      if (ownTransaction && this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }
  cacheInfo() { return { entries: this.#cache ? 1 : 0, estimatedBytes: this.#cache?.estimatedBytes || 0, maxBytes: this.#cacheMaxBytes, hits: this.#hits, misses: this.#misses }; }
  state({ compact = false } = {}) { return projectLedger(this.#ownedLedger(), compact); }
  supplierDetail(options) { return projectSupplierDetail(this.#ownedLedger().state, options); }
  journalPage(options) { const normalized = normalizeJournalOptions(options); return projectJournal(this.#ownedLedger(), normalized); }
  accountStatement(options) { const normalized = normalizeJournalOptions({ ...options, scope: 'all' }); return projectAccountStatement(this.#ownedLedger(), normalized); }
  recoveryInfo() {
    // Read a consistent metadata/archiveability snapshot without replaying the ledger.
    this.db.exec('BEGIN');
    try {
      const revision = this.db.prepare('SELECT revision FROM meta WHERE id=1').get()?.revision;
      if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Stored revision metadata is invalid.');
      let canRestore = true;
      try { this.events(); }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        canRestore = false;
      }
      this.db.exec('COMMIT');
      return { workspace: this.workspace, revision, canRestore };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  execute({ id, revision, command }, { compact = false, actor = null } = {}) {
    text(id, 'İşlem anahtarı', 100);
    if (!command || typeof command !== 'object') fail('İşlem içeriği gerekli.');
    if (actor && ['stocktake', 'close'].includes(command.type)) command = { ...command, approvedBy: actor.name };
    const audit = actor && { version: 1, actor: { id: actor.id, name: actor.name, role: actor.role } };
    if (audit) eventActor({ audit, command });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT body FROM events WHERE id=?').get(id);
      if (existing) {
        const stored = JSON.parse(existing.body);
        if (stored.audit?.actor.id !== actor?.id || JSON.stringify(stored.command) !== JSON.stringify(command)) fail('Aynı işlem anahtarı farklı içerikle kullanılamaz.');
        const ledger = this.#ownedLedger(); this.db.exec('COMMIT'); return { state: projectLedger(ledger, compact), duplicate: true };
      }
      // Current-command policy only: historical HAS funds remain replayable and
      // an already committed request above can still be retried idempotently.
      if (command.type === 'fundAccount' && command.physical === false && command.unit === 'HAS') fail('Banka hesabında para birimi seçin. HAS için fiziki kasa veya cari hesap kullanın.');
      if (command.type === 'fundAccount' && command.physical === false && command.unit === 'SILVER') fail('Saf gümüş için fiziki kasa veya cari hesap kullanın.');
      const ledger = this.#ownedLedger();
      if (!Number.isInteger(revision) || revision !== ledger.state.revision) fail('Veriler başka sekmede değişti. Yenileyip sayım/işlemi tekrar kontrol edin.', { status: 409, code: 'REVISION_CONFLICT' });
      if (command.type === 'amend' && command.replacement?.orderSettlement !== undefined) fail('Sipariş mahsubu yalnız yeni nihai satışta kaydedilir.');
      // Retired supplier write paths cannot bypass explicit source consumption.
      // This gate is deliberately absent from replay/restore and follows duplicate handling.
      const currentTrade=command.type==='amend'?command.replacement:command;
      if (currentTrade && ['sale','purchase','collection','movement'].includes(currentTrade.type)) {
        const supplierIds=new Set(ledger.state.accounts.filter(a=>a.partyType==='supplier').map(a=>a.id));
        const references=value=>value&&typeof value==='object'&&Object.entries(value).some(([key,item])=>
          ['accountId','customerAccount','counterpartyId','counterpartyAccount'].includes(key)&&supplierIds.has(item)
          || item&&typeof item==='object'&&(Array.isArray(item)?item.some(references):references(item)));
        const original=command.type==='amend'&&ledger.state.journal.find(entry=>entry.id===command.originalId);
        if (currentTrade.source==='supplier'||references(currentTrade)||original&&(original.meta.source==='supplier'||references(original.meta)||references(original.entries))) fail('Toptancı işlemini firma kartındaki yeni alış, ödeme veya tahsis akışından kaydedin.');
      }
      const schemaVersion = eventVersion(command, ledger.state);
      const event = { id, schemaVersion, timestamp: new Date().toISOString(), command, ...(audit && { audit }) };
      if (schemaVersion === 10) event.tradeVersion = eventVersion(underlyingSaleCommand(command), ledger.state);
      if ((schemaVersion === 11 || event.tradeVersion === 11) && usesInventory(command)) event.saleInventoryVersion = 1;
      applyLedgerEvent(ledger, event);
      this.db.prepare('INSERT INTO events(id,body) VALUES(?,?)').run(id, JSON.stringify(event));
      this.db.exec('UPDATE meta SET revision=revision+1 WHERE id=1');
      ledger.state.revision = revision + 1;
      const { key } = this.#fingerprint();
      this.db.exec('COMMIT'); this.#remember(ledger, key); return { state: projectLedger(ledger, compact), duplicate: false };
    } catch (e) { this.#cache = null; if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw e; }
  }
  #backupSnapshot({ bounded = false } = {}) {
    const exportedAt = new Date().toISOString();
    if (!bounded) {
      const events = this.events();
      return { format: 'kuyumcu-defter-v1', workspace: this.workspace, exportedAt, events, sha256: digest(events) };
    }
    const backup = { format: 'kuyumcu-defter-v1', workspace: this.workspace, exportedAt, events: [], sha256: '0'.repeat(64) };
    let bytes = Buffer.byteLength(JSON.stringify(backup));
    const hash = createHash('sha256').update('[');
    for (const event of this.events({ stream: true })) {
      const body = JSON.stringify(event), comma = backup.events.length ? ',' : '';
      bytes += Buffer.byteLength(body) + comma.length;
      if (bytes > BACKUP_MAX_BYTES) backupTooLarge();
      hash.update(comma); hash.update(body); backup.events.push(event);
    }
    backup.sha256 = hash.update(']').digest('hex');
    return backup;
  }
  backup() {
    const backup = this.#backupSnapshot({ bounded: true });
    assertBackupSize(backup);
    // A damaged stored history is a system failure, not invalid user input.
    try { replay(backup.events); }
    catch { throw Object.assign(new Error('Stored backup history failed validation.'), { code: 'BACKUP_HISTORY_INVALID' }); }
    return backup;
  }
  restore({ backup, revision, confirmation }, { compact = false, beforeCommit } = {}) {
    if (confirmation !== 'GERİ YÜKLE') fail('Geri yükleme onayı eşleşmiyor.');
    if (backup?.workspace !== this.workspace) fail('Yedeğin çalışma alanı eşleşmiyor. Örnek ve dükkân verileri birbirine yüklenemez.');
    if (backup?.format !== 'kuyumcu-defter-v1' || !Array.isArray(backup.events)) fail('Yedek biçimi veya bütünlük özeti geçersiz.');
    assertBackupSize(backup);
    if (backup.sha256 !== digest(backup.events)) fail('Yedek biçimi veya bütünlük özeti geçersiz.');
    replay(backup.events); // Validate the complete history before touching active records.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (revision !== this.db.prepare('SELECT revision FROM meta WHERE id=1').get().revision) fail('Veriler değişti. Geri yüklemeden önce yenileyin.', { status: 409, code: 'REVISION_CONFLICT' });
      // Preserve the previous history even when it exceeds the supported export size.
      this.db.prepare('INSERT INTO restore_archive(created_at,body) VALUES(?,?)').run(new Date().toISOString(), JSON.stringify(this.#backupSnapshot()));
      this.db.exec('DELETE FROM events');
      const insert = this.db.prepare('INSERT INTO events(id,body) VALUES(?,?)');
      for (const event of backup.events) insert.run(event.id, JSON.stringify(event));
      this.db.exec('UPDATE meta SET revision=revision+1 WHERE id=1');
      const ledger = this.#ownedLedger(), { key } = this.#fingerprint();
      beforeCommit?.();
      this.db.exec('COMMIT'); this.#remember(ledger, key); return projectLedger(ledger, compact);
    } catch (e) { this.#cache = null; if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw e; }
  }
  close() { this.#cache = null; this.db.close(); }
}
