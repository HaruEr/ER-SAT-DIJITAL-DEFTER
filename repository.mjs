import { usesInventory } from './inventory.mjs';
import { projectSupplierDetail } from './supplier-view.mjs';
import { isSupplierCommand, supplierAccountIds, supplierDocuments } from './supplier-ledger.mjs';
import { underlyingSaleCommand } from './sale-pricing.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { replay, fail, text, quantity, eventVersion, eventActor, applyEvent, validDate, workdaySummary as computeWorkdaySummary } from './domain.mjs';
import { allowedWorkerCountIds, workerCountCatalog } from './editor-access.mjs';
import { exportLedgerArchive, importLedgerArchive } from './archive.mjs';
import {
  LEDGER_CACHE_MAX_BYTES,
  applyHotState,
  applyLedgerEvent,
  buildHotScrapResolver,
  buildJournalReturnInfo,
  computeAccountStatement,
  entryAccountMatches,
  entryLinkIds,
  entrySearchText,
  estimateHotBytes,
  estimateLedgerBytes,
  extractHotState,
  hydrateLedger,
  journalFilterHash,
  normalizeJournalOptions,
  normalizeSearch,
  parseJournalCursor,
  projectAccountStatement,
  projectHotLedger,
  projectJournal,
  projectLedger,
  restoreHotSnapshot,
  restoreLedgerSnapshot,
  selectedAccountForState,
  serializeHotSnapshot,
  typeGroups
} from './ledger-view.mjs';
const SNAPSHOT_VERSION = 1;
const SNAPSHOT_MIN_EVENTS = 500;
const HISTORY_COMMANDS = new Set([
  'amend', 'reverse', 'saleReturn', 'retailExchange', 'undoExchange',
  'linkScrapPurchase', 'scrapAdvanceTransfer', 'itemCostSource',
  'supplierReverse', 'supplierAmend', 'supplierReturn', 'supplierLegacyReceiptLink',
  'supplierAllocation', 'supplierOffset'
]);
const RENAME_COMMANDS = new Set(['accountUpdate', 'stockUpdate', 'fundUpdate', 'supplierFirmUpdate']);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const BACKUP_MAX_BYTES = 64 * 1024 * 1024;
const backupTooLarge = () => fail('JSON yedeği desteklenen 64 MiB sınırını aşıyor. Büyük defter için Yedek ekranındaki akışlı arşivi kullanın.', { status: 413, code: 'BACKUP_TOO_LARGE' });
export function assertBackupSize(backup) {
  if (Buffer.byteLength(JSON.stringify(backup), 'utf8') > BACKUP_MAX_BYTES) backupTooLarge();
}
export class Repository {
  #cache = null;
  #cacheMaxBytes;
  #filename;
  #snapshotDirty = false;
  #hits = 0;
  #misses = 0;
  constructor(filename = ':memory:', workspace = 'test', { cacheMaxBytes = LEDGER_CACHE_MAX_BYTES } = {}) {
    if (!Number.isSafeInteger(cacheMaxBytes) || cacheMaxBytes < 0 || cacheMaxBytes > LEDGER_CACHE_MAX_BYTES) throw new Error('Invalid ledger cache budget.');
    this.#cacheMaxBytes = cacheMaxBytes;
    this.#filename = filename;
    this.workspace = workspace;
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO meta VALUES(1,0);
      CREATE TABLE IF NOT EXISTS restore_archive(id INTEGER PRIMARY KEY, created_at TEXT, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ledger_snapshot(id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, revision INTEGER NOT NULL, last_seq INTEGER NOT NULL, event_count INTEGER NOT NULL, sha256 TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ledger_journal(
        seq INTEGER PRIMARY KEY,
        id TEXT UNIQUE NOT NULL,
        date TEXT NOT NULL,
        type TEXT NOT NULL,
        supplier_id TEXT,
        original_id TEXT,
        search_text TEXT NOT NULL,
        entry_count INTEGER NOT NULL,
        revenue INTEGER NOT NULL,
        purchase_total INTEGER NOT NULL,
        label TEXT NOT NULL,
        entries_json TEXT NOT NULL,
        body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_lj_date ON ledger_journal(date, seq);
      CREATE INDEX IF NOT EXISTS idx_lj_type ON ledger_journal(type, seq);
      CREATE INDEX IF NOT EXISTS idx_lj_supplier ON ledger_journal(supplier_id, seq);
      CREATE INDEX IF NOT EXISTS idx_lj_original ON ledger_journal(original_id, seq);
      CREATE TABLE IF NOT EXISTS ledger_journal_accounts(
        account_id TEXT NOT NULL,
        match_kind INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        PRIMARY KEY(account_id, match_kind, seq)
      );
      CREATE TABLE IF NOT EXISTS ledger_links(
        a TEXT NOT NULL,
        b TEXT NOT NULL,
        PRIMARY KEY(a, b)
      );
      CREATE TABLE IF NOT EXISTS pending_submissions(
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
      CREATE INDEX IF NOT EXISTS idx_ps_status ON pending_submissions(status, submitted_at);
      CREATE INDEX IF NOT EXISTS idx_ps_worker_date ON pending_submissions(submitted_by_id, date, status);`);
    const psSchema = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='pending_submissions'").get();
    if (psSchema?.sql && !psSchema.sql.includes("'dailyCount'")) {
      this.db.exec(`BEGIN IMMEDIATE;
        ALTER TABLE pending_submissions RENAME TO pending_submissions_old;
        CREATE TABLE pending_submissions(
          id TEXT PRIMARY KEY NOT NULL, workspace TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
          date TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('sale','purchase','dailyCount')),
          submitted_by_id TEXT NOT NULL, submitted_by_name TEXT NOT NULL, submitted_at TEXT NOT NULL,
          command_json TEXT NOT NULL, approved_command_json TEXT, summary_json TEXT NOT NULL,
          reviewed_by_id TEXT, reviewed_by_name TEXT, reviewed_at TEXT,
          was_edited INTEGER NOT NULL DEFAULT 0 CHECK(was_edited IN (0, 1)),
          rejection_reason TEXT, approved_event_id TEXT
        );
        INSERT INTO pending_submissions SELECT * FROM pending_submissions_old;
        DROP TABLE pending_submissions_old;
        CREATE INDEX IF NOT EXISTS idx_ps_status ON pending_submissions(status, submitted_at);
        CREATE INDEX IF NOT EXISTS idx_ps_worker_date ON pending_submissions(submitted_by_id, date, status);
        COMMIT;`);
    }
  }
  events({ stream = false } = {}) {
    const rows = this.db.prepare('SELECT body FROM events ORDER BY seq').iterate();
    const iterator = (function* () { for (const row of rows) yield JSON.parse(row.body); })();
    return stream ? iterator : [...iterator];
  }
  itemPhoto(code) {
    const owned = this.#ownedLedger();
    const item = owned.data.state.inventoryItems?.find(row => row.code === code);
    if (!item?.hasPhoto) fail('Ürün fotoğrafı bulunamadı.', { status:404 });
    const event = this.db.prepare('SELECT body FROM events WHERE id = ?').get(item.registeredId);
    return JSON.parse(event.body).command.photo;
  }
  exportArchive(filename) { return exportLedgerArchive(this, filename); }
  async restoreArchive(source, options) {
    const result = await importLedgerArchive(this, source, options);
    this.db.exec('DELETE FROM ledger_journal_accounts; DELETE FROM ledger_links; DELETE FROM ledger_journal;');
    this.#cache = null;
    this.#snapshotDirty = false;
    return result;
  }
  #fingerprint() {
    const revision = this.db.prepare('SELECT revision FROM meta WHERE id=1').get()?.revision;
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Stored revision metadata is invalid.');
    return { revision, key: JSON.stringify([revision, this.db.prepare('PRAGMA data_version').get().data_version, this.db.prepare('SELECT total_changes() AS changes').get().changes, this.db.prepare('PRAGMA schema_version').get().schema_version]) };
  }
  #syncJournalTables(journal, state) {
    this.db.exec('DELETE FROM ledger_journal_accounts; DELETE FROM ledger_links; DELETE FROM ledger_journal;');
    const insJ = this.db.prepare('INSERT INTO ledger_journal(seq, id, date, type, supplier_id, original_id, search_text, entry_count, revenue, purchase_total, label, entries_json, body) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insJA = this.db.prepare('INSERT OR IGNORE INTO ledger_journal_accounts(account_id, match_kind, seq) VALUES(?, ?, ?)');
    const insLink = this.db.prepare('INSERT OR IGNORE INTO ledger_links(a, b) VALUES(?, ?)');
    const accountNames = new Map(state.accounts.map(a => [a.id, a.name]));
    const byId = new Map();
    const accountCreatedSeq = new Map();
    for (let i = 0; i < journal.length; i++) {
      const entry = journal[i], seq = i + 1;
      if (entry.type === 'account' && entry.meta?.accountId) accountCreatedSeq.set(entry.meta.accountId, seq);
      insJ.run(
        seq, entry.id, entry.date, entry.type,
        entry.meta?.supplierId || null, entry.meta?.originalId || null,
        entrySearchText(entry, accountNames), entry.entries.length,
        entry.meta?.revenue || 0, entry.meta?.purchaseTotal || 0,
        entry.label || '', JSON.stringify(entry.entries), JSON.stringify(entry)
      );
      const { directIds, inheritedIds } = entryAccountMatches(entry, seq, state, id => byId.get(id), accountCreatedSeq);
      for (const accId of directIds) insJA.run(accId, 0, seq);
      for (const accId of inheritedIds) insJA.run(accId, 1, seq);
      for (const linkId of entryLinkIds(entry)) {
        insLink.run(entry.id, linkId);
        insLink.run(linkId, entry.id);
      }
      byId.set(entry.id, { entry, seq });
    }
  }
  #insertJournalEntries(newEntries, state, startSeq, accountCreatedSeq) {
    const insJ = this.db.prepare('INSERT INTO ledger_journal(seq, id, date, type, supplier_id, original_id, search_text, entry_count, revenue, purchase_total, label, entries_json, body) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insJA = this.db.prepare('INSERT OR IGNORE INTO ledger_journal_accounts(account_id, match_kind, seq) VALUES(?, ?, ?)');
    const insLink = this.db.prepare('INSERT OR IGNORE INTO ledger_links(a, b) VALUES(?, ?)');
    const findByIdStmt = this.db.prepare('SELECT seq, body FROM ledger_journal WHERE id = ?');
    const accountNames = new Map(state.accounts.map(a => [a.id, a.name]));
    const localById = new Map();
    const byIdLookup = id => {
      if (localById.has(id)) return localById.get(id);
      const row = findByIdStmt.get(id);
      if (!row) return null;
      const parsed = { entry: JSON.parse(row.body), seq: row.seq };
      localById.set(id, parsed);
      return parsed;
    };
    for (let i = 0; i < newEntries.length; i++) {
      const entry = newEntries[i], seq = startSeq + i;
      insJ.run(
        seq, entry.id, entry.date, entry.type,
        entry.meta?.supplierId || null, entry.meta?.originalId || null,
        entrySearchText(entry, accountNames), entry.entries.length,
        entry.meta?.revenue || 0, entry.meta?.purchaseTotal || 0,
        entry.label || '', JSON.stringify(entry.entries), JSON.stringify(entry)
      );
      const { directIds, inheritedIds } = entryAccountMatches(entry, seq, state, byIdLookup, accountCreatedSeq);
      for (const accId of directIds) insJA.run(accId, 0, seq);
      for (const accId of inheritedIds) insJA.run(accId, 1, seq);
      for (const linkId of entryLinkIds(entry)) {
        insLink.run(entry.id, linkId);
        insLink.run(linkId, entry.id);
      }
      localById.set(entry.id, { entry, seq });
    }
  }
  #syncAccountInheritedMatches(targetIds, journal, state, accountCreatedSeq) {
    if (!targetIds.length) return;
    const targetSet = new Set(targetIds);
    const ph = targetIds.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM ledger_journal_accounts WHERE account_id IN (${ph}) AND match_kind = 1`).run(...targetIds);
    const insJA = this.db.prepare('INSERT OR IGNORE INTO ledger_journal_accounts(account_id, match_kind, seq) VALUES(?, 1, ?)');
    const byId = new Map();
    for (let i = 0; i < journal.length; i++) {
      const entry = journal[i], seq = i + 1;
      const { inheritedIds } = entryAccountMatches(entry, seq, state, id => byId.get(id), accountCreatedSeq);
      for (const accId of inheritedIds) {
        if (targetSet.has(accId)) insJA.run(accId, seq);
      }
      byId.set(entry.id, { entry, seq });
    }
  }
  #refreshRenamedSearchText(command, state) {
    let targetIds = [];
    if (command.type === 'supplierFirmUpdate') {
      targetIds = supplierAccountIds(state, command.supplierId);
    } else if (command.type === 'accountUpdate') {
      targetIds = state.accounts.filter(a => a.id === command.accountId || a.parentAccountId === command.accountId).map(a => a.id);
    } else if (command.accountId) {
      targetIds = [command.accountId];
    }
    if (!targetIds.length) return;
    const ph = targetIds.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT DISTINCT seq, body FROM ledger_journal WHERE seq IN (SELECT seq FROM ledger_journal_accounts WHERE account_id IN (${ph}) AND match_kind = 0)`).all(...targetIds);
    if (!rows.length) return;
    const accountNames = new Map(state.accounts.map(a => [a.id, a.name]));
    const upd = this.db.prepare('UPDATE ledger_journal SET search_text = ? WHERE seq = ?');
    for (const row of rows) upd.run(entrySearchText(JSON.parse(row.body), accountNames), row.seq);
  }
  #remember(mode, data, key) {
    if (this.#cacheMaxBytes <= 0) {
      this.#cache = null;
      return { mode, data, evicted: true };
    }
    if (mode === 'full') {
      const estimatedBytes = estimateLedgerBytes(data);
      if (estimatedBytes <= this.#cacheMaxBytes) {
        this.#cache = { mode: 'full', ledger: data, key, estimatedBytes };
        return { mode: 'full', data, evicted: false };
      }
      data = extractHotState(data);
      mode = 'hot';
    }
    const estimatedBytes = estimateHotBytes(data);
    if (estimatedBytes <= this.#cacheMaxBytes) {
      this.#cache = { mode: 'hot', hot: data, key, estimatedBytes };
      return { mode: 'hot', data, evicted: false };
    }
    this.#cache = null;
    return { mode: 'hot', data, evicted: true };
  }
  #loadSnapshot(revision) {
    if (this.#cacheMaxBytes <= 0 || this.#filename === ':memory:') return null;
    try {
      const metaStats = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS last_seq, COUNT(*) AS event_count FROM events').get();
      if (!metaStats || metaStats.event_count < SNAPSHOT_MIN_EVENTS) return null;
      const row = this.db.prepare('SELECT version, revision, last_seq, event_count, sha256, body FROM ledger_snapshot WHERE id=1').get();
      if (!row || row.version !== SNAPSHOT_VERSION || row.revision !== revision || row.last_seq !== metaStats.last_seq || row.event_count !== metaStats.event_count) return null;
      if (createHash('sha256').update(row.body).digest('hex') !== row.sha256) return null;
      const parsed = JSON.parse(row.body);
      if (parsed?.kind === 'hot-v1') {
        const ljStats = this.db.prepare('SELECT COUNT(*) AS cnt FROM ledger_journal').get();
        if (!ljStats || ljStats.cnt !== parsed.journalCount) return null;
        const hot = restoreHotSnapshot(parsed);
        hot.state.revision = revision;
        return { mode: 'hot', data: hot };
      }
      if (!parsed || !parsed.state || !Array.isArray(parsed.state.journal) || parsed.state.journal.length < metaStats.event_count) return null;
      const ledger = restoreLedgerSnapshot(parsed);
      ledger.state.revision = revision;
      return { mode: 'full', data: ledger };
    } catch { return null; }
  }
  #saveSnapshot(mode, data, revision) {
    if (this.#cacheMaxBytes <= 0 || this.#filename === ':memory:') return;
    const journalLen = mode === 'full' ? data.state.journal.length : data.journalMeta.total;
    if (journalLen < SNAPSHOT_MIN_EVENTS) return;
    try {
      const metaStats = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS last_seq, COUNT(*) AS event_count FROM events').get();
      if (!metaStats || metaStats.event_count < SNAPSHOT_MIN_EVENTS) return;
      let body;
      if (mode === 'full') {
        body = JSON.stringify({ state: data.state, journalBytes: data.journalBytes });
      } else {
        const ljStats = this.db.prepare('SELECT COUNT(*) AS cnt FROM ledger_journal').get();
        if (!ljStats || ljStats.cnt !== data.journalMeta.total) return;
        const payload = serializeHotSnapshot(data);
        payload.journalCount = data.journalMeta.total;
        body = JSON.stringify(payload);
      }
      const sha256 = createHash('sha256').update(body).digest('hex');
      this.db.prepare('INSERT OR REPLACE INTO ledger_snapshot(id, version, revision, last_seq, event_count, sha256, body) VALUES(1, ?, ?, ?, ?, ?, ?)').run(SNAPSHOT_VERSION, revision, metaStats.last_seq, metaStats.event_count, sha256, body);
      this.#snapshotDirty = false;
    } catch { /* Snapshot persistence is best-effort; events remain authoritative. */ }
  }
  #ownedLedger() {
    const ownTransaction = !this.db.isTransaction;
    if (ownTransaction) this.db.exec('BEGIN');
    try {
      const { revision, key } = this.#fingerprint();
      let mode, data, rebuiltFromEvents = false, legacyConverted = false;
      if (this.#cache?.key === key) {
        this.#hits++;
        mode = this.#cache.mode;
        data = mode === 'full' ? this.#cache.ledger : this.#cache.hot;
      } else {
        this.#misses++;
        const snap = this.#loadSnapshot(revision);
        if (snap) {
          mode = snap.mode;
          data = snap.data;
          if (mode === 'full' && this.#cacheMaxBytes > 0 && estimateLedgerBytes(data) > this.#cacheMaxBytes) {
            legacyConverted = true;
          }
        } else {
          mode = 'full';
          data = hydrateLedger(this.events({ stream: true }));
          data.state.revision = revision;
          rebuiltFromEvents = true;
        }
      }
      if (ownTransaction) {
        this.db.exec('COMMIT');
        if (legacyConverted) {
          const hot = extractHotState(data);
          this.db.exec('BEGIN IMMEDIATE');
          try { this.#syncJournalTables(data.state.journal, data.state); this.db.exec('COMMIT'); }
          catch (err) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw err; }
          this.#saveSnapshot('hot', hot, revision);
          const remembered = this.#remember('hot', hot, this.#fingerprint().key);
          return { mode: remembered.mode, data: remembered.data };
        }
        if (rebuiltFromEvents) {
          if (this.#cacheMaxBytes > 0 && estimateLedgerBytes(data) > this.#cacheMaxBytes) {
            const hot = extractHotState(data);
            this.db.exec('BEGIN IMMEDIATE');
            try { this.#syncJournalTables(data.state.journal, data.state); this.db.exec('COMMIT'); }
            catch (err) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw err; }
            this.#saveSnapshot('hot', hot, revision);
            const remembered = this.#remember('hot', hot, this.#fingerprint().key);
            return { mode: remembered.mode, data: remembered.data };
          }
          this.#saveSnapshot('full', data, revision);
          const remembered = this.#remember('full', data, this.#fingerprint().key);
          return { mode: remembered.mode, data: remembered.data };
        }
        const remembered = this.#remember(mode, data, key);
        return { mode: remembered.mode, data: remembered.data };
      }
      if (legacyConverted || (mode === 'full' && this.#cacheMaxBytes > 0 && estimateLedgerBytes(data) > this.#cacheMaxBytes)) {
        const hot = extractHotState(data);
        this.#syncJournalTables(data.state.journal, data.state);
        return { mode: 'hot', data: hot };
      }
      return { mode, data };
    } catch (error) {
      this.#cache = null;
      if (ownTransaction && this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }
  #loadAllJournalEntries() {
    return this.db.prepare('SELECT body FROM ledger_journal ORDER BY seq').all().map(r => JSON.parse(r.body));
  }
  #loadSupplierJournalEntries(state, supplierId) {
    const ids = supplierAccountIds(state, supplierId);
    if (!ids.length) {
      return this.db.prepare("SELECT body FROM ledger_journal WHERE supplier_id = ? OR type IN ('reverse', 'supplierReverse') ORDER BY seq").all(supplierId).map(r => JSON.parse(r.body));
    }
    const ph = ids.map(() => '?').join(',');
    return this.db.prepare(`SELECT body FROM ledger_journal WHERE supplier_id = ? OR type IN ('reverse', 'supplierReverse') OR seq IN (SELECT seq FROM ledger_journal_accounts WHERE account_id IN (${ph}) AND match_kind = 0) ORDER BY seq`).all(supplierId, ...ids).map(r => JSON.parse(r.body));
  }
  #getJournalEntry(id) {
    const row = this.db.prepare('SELECT body FROM ledger_journal WHERE id = ?').get(id);
    return row ? JSON.parse(row.body) : null;
  }
  #project(mode, data, compact) {
    if (mode === 'full') return projectLedger(data, compact);
    const fullJournal = compact ? null : this.#loadAllJournalEntries();
    return projectHotLedger(data, compact, fullJournal);
  }
  cacheInfo() { return { entries: this.#cache ? 1 : 0, estimatedBytes: this.#cache?.estimatedBytes || 0, maxBytes: this.#cacheMaxBytes, hits: this.#hits, misses: this.#misses }; }
  state({ compact = false } = {}) {
    const owned = this.#ownedLedger();
    return this.#project(owned.mode, owned.data, compact);
  }
  supplierDetail(options) {
    const owned = this.#ownedLedger();
    if (owned.mode === 'full') return projectSupplierDetail(owned.data.state, options);
    const hot = owned.data;
    const supplierId = options?.supplierId;
    const journal = typeof supplierId === 'string' && supplierId && supplierId.length <= 160
      ? this.#loadSupplierJournalEntries(hot.state, supplierId)
      : [];
    return projectSupplierDetail({ ...hot.state, journal }, options);
  }
  journalPage(options) {
    const normalized = normalizeJournalOptions(options);
    const owned = this.#ownedLedger();
    if (owned.mode === 'full') return projectJournal(owned.data, normalized);
    return this.#hotJournalPage(owned.data, normalized);
  }
  #hotJournalPage(hot, normalized) {
    const { scope, q, type, limit, cursor, startDate = '', endDate = '', accountId = '', unit = '', status = 'all', scrapForSale = '', scrapForAdvance = '' } = normalized;
    const inheritParty = accountId ? selectedAccountForState(hot.state, accountId).kind === 'receivable' : false;
    const revision = hot.state.revision;
    const filterHash = journalFilterHash(normalized);
    const offset = parseJournalCursor(cursor, revision, filterHash);
    if (scrapForSale || scrapForAdvance) {
      const fullJournal = this.#loadAllJournalEntries();
      const tempLedger = restoreLedgerSnapshot({ state: { ...hot.state, journal: fullJournal }, journalBytes: 2 });
      return projectJournal(tempLedger, normalized);
    }
    const clauses = [], params = [];
    if (scope === 'today') { clauses.push('date = ?'); params.push(hot.state.date); }
    if (startDate) { clauses.push('date >= ?'); params.push(startDate); }
    if (endDate) { clauses.push('date <= ?'); params.push(endDate); }
    if (type !== 'all') {
      const allowed = typeGroups[type] || [type];
      clauses.push(`type IN (${allowed.map(() => '?').join(',')})`);
      params.push(...allowed);
    }
    if (accountId) {
      clauses.push(inheritParty
        ? 'seq IN (SELECT seq FROM ledger_journal_accounts WHERE account_id = ?)'
        : 'seq IN (SELECT seq FROM ledger_journal_accounts WHERE account_id = ? AND match_kind = 0)');
      params.push(accountId);
    }
    if (unit) {
      const unitAccIds = hot.state.accounts.filter(a => a.unit === unit).map(a => a.id);
      if (!unitAccIds.length) { clauses.push('0 = 1'); }
      else {
        clauses.push(`seq IN (SELECT seq FROM ledger_journal_accounts WHERE match_kind = 0 AND account_id IN (${unitAccIds.map(() => '?').join(',')}))`);
        params.push(...unitAccIds);
      }
    }
    if (status === 'active') {
      clauses.push("type NOT IN ('reverse', 'supplierReverse') AND id NOT IN (SELECT original_id FROM ledger_journal WHERE type IN ('reverse', 'supplierReverse') AND original_id IS NOT NULL)");
    } else if (status === 'reversed') {
      clauses.push("(type IN ('reverse', 'supplierReverse') OR id IN (SELECT original_id FROM ledger_journal WHERE type IN ('reverse', 'supplierReverse') AND original_id IS NOT NULL))");
    }
    if (q) { clauses.push('INSTR(search_text, ?) > 0'); params.push(q); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const counts = this.db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(entry_count), 0) AS totalEntries FROM ledger_journal ${where}`).get(...params);
    if (offset > counts.total) fail('Defter sayfa bilgisi geçersiz.');
    const rows = this.db.prepare(`SELECT seq, body FROM ledger_journal ${where} ORDER BY seq DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    const seqById = new Map();
    const items = rows.map(r => {
      const entry = JSON.parse(r.body);
      seqById.set(entry.id, r.seq);
      return entry;
    });
    const visible = new Set(items.map(e => e.id));
    const related = new Set(visible);
    const pending = [...visible];
    const linkStmt = this.db.prepare('SELECT l.b FROM ledger_links l JOIN ledger_journal j ON j.id = l.b WHERE l.a = ?');
    for (let i = 0; i < pending.length; i++) {
      for (const row of linkStmt.all(pending[i])) {
        if (!related.has(row.b)) {
          related.add(row.b);
          pending.push(row.b);
        }
      }
    }
    const extraIds = [...related].filter(id => !visible.has(id));
    let receiptContext = [];
    if (extraIds.length) {
      const ph = extraIds.map(() => '?').join(',');
      receiptContext = this.db.prepare(`SELECT body FROM ledger_journal WHERE id IN (${ph}) ORDER BY seq`).all(...extraIds).map(r => JSON.parse(r.body));
    }
    const reversedSet = new Set();
    if (items.length) {
      const itemIds = items.map(e => e.id);
      const ph = itemIds.map(() => '?').join(',');
      for (const r of this.db.prepare(`SELECT DISTINCT original_id FROM ledger_journal WHERE type IN ('reverse', 'supplierReverse') AND original_id IN (${ph})`).all(...itemIds)) {
        reversedSet.add(r.original_id);
      }
    }
    const returnsBySale = new Map();
    const saleIds = items.filter(e => e.type === 'sale').map(e => e.id);
    if (saleIds.length) {
      const ph = saleIds.map(() => '?').join(',');
      const retRows = this.db.prepare(`SELECT original_id, body FROM ledger_journal WHERE type = 'saleReturn' AND original_id IN (${ph}) ORDER BY seq`).all(...saleIds);
      const retIds = [];
      for (const r of retRows) {
        const ev = JSON.parse(r.body);
        retIds.push(ev.id);
        let list = returnsBySale.get(r.original_id);
        if (!list) { list = []; returnsBySale.set(r.original_id, list); }
        list.push(ev);
      }
      if (retIds.length) {
        const rph = retIds.map(() => '?').join(',');
        for (const r of this.db.prepare(`SELECT DISTINCT original_id FROM ledger_journal WHERE type = 'reverse' AND original_id IN (${rph})`).all(...retIds)) {
          reversedSet.add(r.original_id);
        }
      }
    }
    const supplierPurchaseInfo = {};
    for (const supplierId of new Set(items.filter(e => e.type === 'supplierPurchase').map(e => e.meta.supplierId))) {
      const scopedJournal = this.#loadSupplierJournalEntries(hot.state, supplierId);
      for (const purchase of supplierDocuments({ ...hot.state, journal: scopedJournal }, supplierId).purchases) {
        if (items.some(e => e.id === purchase.id)) supplierPurchaseInfo[purchase.id] = purchase.lines;
      }
    }
    const returnInfo = buildJournalReturnInfo(hot.state, items, id => reversedSet.has(id), id => returnsBySale.get(id) || []);
    const resolveParty = buildHotScrapResolver(hot.state, hot.accountCreatedSeq, seqById);
    const nextOffset = offset + items.length;
    return structuredClone({
      items: items.map(entry => returnInfo.has(entry.id) ? { ...entry, returnInfo: returnInfo.get(entry.id), scrapLinkCustomerId: resolveParty(entry) } : entry),
      total: counts.total,
      receiptContext,
      supplierPurchaseInfo,
      totalEntries: counts.totalEntries,
      reversedIds: items.filter(entry => reversedSet.has(entry.id)).map(entry => entry.id),
      nextCursor: nextOffset < counts.total ? Buffer.from(JSON.stringify({ revision, offset: nextOffset, filterHash })).toString('base64url') : null,
      revision
    });
  }
  accountStatement(options) {
    const normalized = normalizeJournalOptions({ ...options, scope: 'all' });
    const owned = this.#ownedLedger();
    if (owned.mode === 'full') return projectAccountStatement(owned.data, normalized);
    const hot = owned.data;
    const { accountId, startDate, endDate } = normalized;
    if (!accountId) fail('Ekstre için hesap seçin.');
    const account = selectedAccountForState(hot.state, accountId);
    const sql = account.physical
      ? `SELECT date, type, entries_json, CASE WHEN type IN ('close', 'stocktake') THEN body ELSE NULL END AS body
         FROM ledger_journal
         WHERE seq IN (SELECT seq FROM ledger_journal_accounts WHERE account_id = ? AND match_kind = 0)
            OR type IN ('close', 'stocktake')
         ORDER BY seq`
      : `SELECT date, type, entries_json, NULL AS body
         FROM ledger_journal
         WHERE seq IN (SELECT seq FROM ledger_journal_accounts WHERE account_id = ? AND match_kind = 0)
         ORDER BY seq`;
    const rows = this.db.prepare(sql).iterate(accountId);
    const events = (function* () {
      for (const r of rows) {
        if (r.body) yield JSON.parse(r.body);
        else yield { date: r.date, type: r.type, entries: JSON.parse(r.entries_json) };
      }
    })();
    return computeAccountStatement(hot.state.revision, account, events, { startDate, endDate });
  }
  workdaySummary(date, options = null) {
    const owned = this.#ownedLedger();
    let result;
    let accountsList;
    if (owned.mode === 'full') {
      const state = owned.data.state;
      accountsList = state.accounts;
      result = computeWorkdaySummary(state, date || state.date);
    } else {
      const hot = owned.data;
      accountsList = hot.state.accounts;
      const targetDate = date || hot.state.date;
      if (!hot.state.initialized) fail('Önce başlangıç devrini onaylayın.');
      validDate(targetDate);
      if (targetDate < hot.openingDate || targetDate > hot.state.date) fail('Özet tarihi başlangıç ile açık iş günü arasında olmalı.');
      const rows = new Map(
        hot.state.accounts
          .filter(a => !hot.accountCreatedDates.has(a.id) || hot.accountCreatedDates.get(a.id) <= targetDate)
          .map(a => [a.id, { accountId: a.id, unit: a.unit, opening: 0, incoming: 0, outgoing: 0, adjustment: 0, closing: 0 }])
      );
      const adjIds = new Set();
      const totals = { sales: 0, purchases: 0 };
      const isOpening = e => ['opening', 'account', 'fundAccount', 'stockAccount', 'nominalOpening'].includes(e.type);
      const isAdjustment = e => ['close', 'stocktake'].includes(e.type) || (e.type === 'movement' && e.label === 'Açılış düzeltmesi');
      const stmt = this.db.prepare('SELECT id, date, type, label, revenue, purchase_total, original_id, entries_json FROM ledger_journal WHERE date <= ? ORDER BY seq');
      for (const e of stmt.iterate(targetDate)) {
        if (isAdjustment(e)) adjIds.add(e.id);
        if (e.date === targetDate) {
          totals.sales += e.revenue || 0;
          totals.purchases += e.purchase_total || 0;
        }
        const reversedAdj = e.type === 'reverse' && adjIds.has(e.original_id);
        for (const entry of JSON.parse(e.entries_json)) {
          const row = rows.get(entry.accountId);
          if (!row) continue;
          if (e.date < targetDate || isOpening(e)) row.opening += entry.delta;
          else if (isAdjustment(e) || reversedAdj) row.adjustment += entry.delta;
          else if (entry.delta >= 0) row.incoming += entry.delta;
          else row.outgoing -= entry.delta;
        }
      }
      for (const row of rows.values()) row.closing = row.opening + row.incoming - row.outgoing + row.adjustment;
      result = { date: targetDate, accounts: [...rows.values()], totals };
    }
    if (!options?.paginated) return result;
    const kind = options.kind || 'all';
    const unit = options.unit || '';
    const active = options.active === true || options.active === '1' || options.active === 'true';
    const qTokens = options.q ? normalizeSearch(String(options.q).trim()).split(/\s+/).filter(Boolean) : [];
    const pageSize = Math.max(1, Math.min(200, Number(options.pageSize) || 50));
    const requestedPage = Math.max(1, Number(options.page) || 1);
    const accountMap = new Map(accountsList.map(a => [a.id, a]));
    const isStock = a => a.kind === 'asset' && Boolean(a.isSaleable || a.isPurchasable || a.pairedGroups?.length || ['bilezik22', 'taki14', 'taki22'].includes(a.id));
    const filtered = result.accounts.filter(row => {
      const a = accountMap.get(row.accountId);
      if (!a) return false;
      if (a.retired && row.opening === 0 && row.incoming === 0 && row.outgoing === 0 && row.adjustment === 0 && row.closing === 0) return false;
      if (unit && row.unit !== unit) return false;
      if (active && !row.incoming && !row.outgoing && !row.adjustment) return false;
      if (kind !== 'all') {
        if (kind === 'stock' && !isStock(a)) return false;
        if (kind === 'money' && !(a.kind === 'asset' && !isStock(a))) return false;
        if (kind === 'customer' && !(a.kind === 'receivable' && (a.partyType || 'customer') === 'customer')) return false;
        if (kind === 'supplier' && !(a.kind === 'receivable' && a.partyType === 'supplier')) return false;
      }
      if (qTokens.length) {
        const nameNorm = normalizeSearch(a.name || '');
        for (let i = 0; i < qTokens.length; i++) if (!nameNorm.includes(qTokens[i])) return false;
      }
      return true;
    });
    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    const page = Math.max(1, Math.min(requestedPage, totalPages));
    const startIdx = (page - 1) * pageSize;
    return {
      date: result.date,
      accounts: filtered.slice(startIdx, startIdx + pageSize),
      totals: result.totals,
      paginated: true,
      totalAccounts: result.accounts.length,
      filteredAccounts: filtered.length,
      page,
      pageSize,
      totalPages
    };
  }
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
  execute({ id, revision, command }, { compact = false, actor = null, submittedBy = null, wasEdited = false } = {}) {
    text(id, 'İşlem anahtarı', 100);
    if (!command || typeof command !== 'object') fail('İşlem içeriği gerekli.');
    if (actor && ['stocktake', 'close'].includes(command.type)) command = { ...command, approvedBy: actor.name };
    const audit = actor && {
      version: 1,
      actor: { id: actor.id, name: actor.name, role: actor.role },
      ...(submittedBy ? { submittedBy: { id: submittedBy.id, name: submittedBy.name }, ...(wasEdited ? { wasEdited: true } : {}) } : {})
    };
    if (audit) eventActor({ audit, command });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT body FROM events WHERE id=?').get(id);
      if (existing) {
        const stored = JSON.parse(existing.body);
        if (stored.audit?.actor.id !== actor?.id || JSON.stringify(stored.command) !== JSON.stringify(command)) fail('Aynı işlem anahtarı farklı içerikle kullanılamaz.');
        const owned = this.#ownedLedger();
        this.db.exec('COMMIT');
        return { state: this.#project(owned.mode, owned.data, compact), duplicate: true };
      }
      // Current-command policy only: historical HAS funds remain replayable and
      // an already committed request above can still be retried idempotently.
      if (command.type === 'fundAccount' && command.physical === false && command.unit === 'HAS') fail('Banka hesabında para birimi seçin. HAS için fiziki kasa veya cari hesap kullanın.');
      if (command.type === 'fundAccount' && command.physical === false && command.unit === 'SILVER') fail('Saf gümüş için fiziki kasa veya cari hesap kullanın.');
      const owned = this.#ownedLedger();
      const currentState = owned.data.state;
      if (!Number.isInteger(revision) || revision !== currentState.revision) fail('Veriler başka sekmede değişti. Yenileyip sayım/işlemi tekrar kontrol edin.', { status: 409, code: 'REVISION_CONFLICT' });
      if (command.type === 'amend' && command.replacement?.orderSettlement !== undefined) fail('Sipariş mahsubu yalnız yeni nihai satışta kaydedilir.');
      if (owned.mode === 'hot') {
        const checkIds = [id];
        if (['amend', 'supplierAmend'].includes(command.type)) checkIds.push(`${id}:undo`);
        if (['retailExchange', 'undoExchange'].includes(command.type)) checkIds.push(`${id}:return`);
        const ph = checkIds.map(() => '?').join(',');
        if (this.db.prepare(`SELECT 1 FROM ledger_journal WHERE id IN (${ph}) LIMIT 1`).get(...checkIds)) fail('Tekrarlanan işlem anahtarı.');
      }
      // Retired supplier write paths cannot bypass explicit source consumption.
      // This gate is deliberately absent from replay/restore and follows duplicate handling.
      const currentTrade=command.type==='amend'?command.replacement:command;
      if (currentTrade && ['sale','purchase','collection','movement'].includes(currentTrade.type)) {
        const supplierIds=new Set(currentState.accounts.filter(a=>a.partyType==='supplier').map(a=>a.id));
        const references=value=>value&&typeof value==='object'&&Object.entries(value).some(([key,item])=>
          ['accountId','customerAccount','counterpartyId','counterpartyAccount'].includes(key)&&supplierIds.has(item)
          || item&&typeof item==='object'&&(Array.isArray(item)?item.some(references):references(item)));
        const original=command.type==='amend'&&(owned.mode==='full'?currentState.journal.find(entry=>entry.id===command.originalId):this.#getJournalEntry(command.originalId));
        if (currentTrade.source==='supplier'||references(currentTrade)||original&&(original.meta.source==='supplier'||references(original.meta)||references(original.entries))) fail('Toptancı işlemini firma kartındaki yeni alış, ödeme veya tahsis akışından kaydedin.');
      }
      if (owned.mode === 'full') {
        const ledger = owned.data;
        const schemaVersion = eventVersion(command, ledger.state);
        const event = { id, schemaVersion, timestamp: new Date().toISOString(), command, ...(audit && { audit }) };
        if (schemaVersion === 10) event.tradeVersion = eventVersion(underlyingSaleCommand(command), ledger.state);
        if ((schemaVersion === 11 || event.tradeVersion === 11) && usesInventory(command)) event.saleInventoryVersion = 1;
        applyLedgerEvent(ledger, event);
        this.db.prepare('INSERT INTO events(id,body) VALUES(?,?)').run(id, JSON.stringify(event));
        this.db.exec('UPDATE meta SET revision=revision+1 WHERE id=1');
        ledger.state.revision = revision + 1;
        let mode = 'full', targetData = ledger;
        if (this.#cacheMaxBytes > 0 && estimateLedgerBytes(ledger) > this.#cacheMaxBytes) {
          const hot = extractHotState(ledger);
          this.#syncJournalTables(ledger.state.journal, ledger.state);
          mode = 'hot';
          targetData = hot;
        }
        const { key } = this.#fingerprint();
        this.db.exec('COMMIT');
        this.#snapshotDirty = true;
        const remembered = this.#remember(mode, targetData, key);
        if (remembered.evicted && this.#cacheMaxBytes > 0 && this.#filename !== ':memory:') {
          this.#saveSnapshot(remembered.mode, remembered.data, revision + 1);
        }
        return { state: this.#project(remembered.mode, remembered.data, compact), duplicate: false };
      }
      // Hot mode execution
      const hot = owned.data;
      const isHistory = HISTORY_COMMANDS.has(command.type)
        || (command.type === 'registerItem' && command.purchaseLine !== undefined)
        || (command.type === 'accountUpdate' && command.partyType !== undefined)
        || (['supplierPurchase', 'supplierPayment'].includes(command.type) && (Boolean(command.debts?.length) || command.debtUses !== undefined || command.allocations !== undefined));
      const supplierTargetId = isSupplierCommand(command)
        ? (command.supplierId || command.replacement?.supplierId || (command.originalId ? this.#getJournalEntry(command.originalId)?.meta?.supplierId : null))
        : null;
      const workJournal = isHistory
        ? (supplierTargetId ? this.#loadSupplierJournalEntries(hot.state, supplierTargetId) : this.#loadAllJournalEntries())
        : [];
      const workState = { ...hot.state, journal: workJournal };
      const schemaVersion = eventVersion(command, workState);
      const event = { id, schemaVersion, timestamp: new Date().toISOString(), command, ...(audit && { audit }) };
      if (schemaVersion === 10) event.tradeVersion = eventVersion(underlyingSaleCommand(command), workState);
      if ((schemaVersion === 11 || event.tradeVersion === 11) && usesInventory(command)) event.saleInventoryVersion = 1;
      const nextState = applyEvent(workState, event);
      const newEntries = nextState.journal.slice(workJournal.length);
      const lookupById = lookupId => this.#getJournalEntry(lookupId);
      const startSeq = hot.journalMeta.total + 1;
      const nextHot = applyHotState(hot, nextState, newEntries, lookupById, startSeq);
      this.db.prepare('INSERT INTO events(id,body) VALUES(?,?)').run(id, JSON.stringify(event));
      this.db.exec('UPDATE meta SET revision=revision+1 WHERE id=1');
      nextHot.state.revision = revision + 1;
      this.#insertJournalEntries(newEntries, nextHot.state, startSeq, nextHot.accountCreatedSeq);
      if (command.type === 'accountUpdate' && command.partyType !== undefined) {
        const targetIds = nextHot.state.accounts.filter(a => a.id === command.accountId || a.parentAccountId === command.accountId).map(a => a.id);
        this.#syncAccountInheritedMatches(targetIds, nextState.journal, nextHot.state, nextHot.accountCreatedSeq);
      }
      if (RENAME_COMMANDS.has(command.type)) this.#refreshRenamedSearchText(command, nextHot.state);
      const { key } = this.#fingerprint();
      this.db.exec('COMMIT');
      this.#snapshotDirty = true;
      const remembered = this.#remember('hot', nextHot, key);
      if (remembered.evicted && this.#cacheMaxBytes > 0 && this.#filename !== ':memory:') {
        this.#saveSnapshot('hot', nextHot, revision + 1);
      }
      return { state: isHistory && !supplierTargetId && !compact ? projectHotLedger(nextHot, false, nextState.journal) : this.#project(remembered.mode, remembered.data, compact), duplicate: false };
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
      this.db.exec('DELETE FROM events; DELETE FROM ledger_snapshot; DELETE FROM ledger_journal_accounts; DELETE FROM ledger_links; DELETE FROM ledger_journal;');
      const insert = this.db.prepare('INSERT INTO events(id,body) VALUES(?,?)');
      for (const event of backup.events) insert.run(event.id, JSON.stringify(event));
      this.db.exec('UPDATE meta SET revision=revision+1 WHERE id=1');
      const owned = this.#ownedLedger(), { key } = this.#fingerprint();
      beforeCommit?.();
      this.db.exec('COMMIT');
      this.#snapshotDirty = true;
      const remembered = this.#remember(owned.mode, owned.data, key);
      if (remembered.evicted && this.#cacheMaxBytes > 0 && this.#filename !== ':memory:') {
        this.#saveSnapshot(remembered.mode, remembered.data, owned.data.state.revision);
      }
      return this.#project(remembered.mode, remembered.data, compact);
    } catch (e) { this.#cache = null; if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw e; }
  }
  pendingCount() {
    return this.db.prepare("SELECT COUNT(*) AS c FROM pending_submissions WHERE status='pending'").get().c;
  }
  #summarizeTrade(state, command) {
    if (!command || typeof command !== 'object' || !['sale', 'purchase'].includes(command.type)) {
      fail('Yalnız satış veya alış işlemleri onaya gönderilebilir.');
    }
    const schemaVersion = eventVersion(command, state);
    const previewEvent = { id: 'dry-run-pending', schemaVersion, timestamp: new Date().toISOString(), command };
    if (schemaVersion === 10) previewEvent.tradeVersion = eventVersion(underlyingSaleCommand(command), state);
    if ((schemaVersion === 11 || previewEvent.tradeVersion === 11) && usesInventory(command)) previewEvent.saleInventoryVersion = 1;
    const nextState = applyEvent(state, previewEvent);
    const entry = nextState.journal.at(-1);
    const byId = new Map(state.accounts.map(a => [a.id, a]));
    const customer = entry.meta.counterpartyId ? byId.get(entry.meta.counterpartyId) : null;
    const lines = (entry.meta.lines || []).map(l => {
      const acc = byId.get(l.accountId);
      const wg = l.weightAccount ? byId.get(l.weightAccount) : null;
      return {
        accountId: l.accountId,
        name: acc?.name || l.accountId,
        unit: acc?.unit || 'ADET',
        quantity: l.quantity,
        weightAccount: l.weightAccount || null,
        weightAccountName: wg?.name || null,
        weight: l.weight || 0,
        value: l.value
      };
    });
    const totalTL = lines.reduce((sum, l) => sum + l.value, 0);
    const totalGram = lines.reduce((sum, l) => sum + (l.weightAccount ? l.weight : (l.unit === 'GRAM' ? l.quantity : 0)), 0);
    const mapAlloc = arr => (arr || []).map(r => {
      const a = byId.get(r.accountId);
      return { accountId: r.accountId, name: a?.name || r.accountId, unit: a?.unit || 'TL', quantity: r.quantity, valueTL: r.valueTL, weight: r.weight || 0 };
    });
    return {
      type: command.type,
      date: command.date,
      customerId: customer?.id || '',
      customerName: customer?.name || 'Peşin / isimsiz müşteri',
      totalTL,
      totalGram,
      note: entry.meta.note || '',
      lines,
      received: mapAlloc(entry.meta.receivedLines),
      given: mapAlloc(entry.meta.givenLines),
      credits: mapAlloc(entry.meta.creditLines),
      debts: mapAlloc(entry.meta.debtLines)
    };
  }
  #summarizeBlindCount(state, command) {
    if (!command || typeof command !== 'object' || command.type !== 'dailyCount') {
      fail('Geçerli günlük sayım verisi gerekli.');
    }
    if (command.date !== state.date) fail('Sayım yalnız açık iş gününe gönderilebilir.');
    if (!command.counts || typeof command.counts !== 'object' || Array.isArray(command.counts)) {
      fail('En az bir kalemin fiziki sayımını girin.');
    }
    const allowed = allowedWorkerCountIds(state);
    const catalogById = new Map(workerCountCatalog(state).map(c => [c.id, c]));
    const reasonsInput = command.reasons && typeof command.reasons === 'object' && !Array.isArray(command.reasons) ? command.reasons : {};
    const cleanCounts = {};
    const cleanReasons = {};
    const rows = [];
    for (const [accId, rawVal] of Object.entries(command.counts)) {
      if (!allowed.has(accId)) {
        fail('Bu kalem çalışan sayım yetkisi dışındadır.', { status: 403 });
      }
      if (rawVal === null || rawVal === undefined || String(rawVal).trim() === '') continue;
      const item = catalogById.get(accId);
      const counted = quantity(String(rawVal), item.unit, { zero: true });
      const rawReason = reasonsInput[accId];
      const reason = typeof rawReason === 'string' ? rawReason.trim().slice(0, 160) : '';
      cleanCounts[accId] = String(rawVal).trim();
      if (reason) cleanReasons[accId] = reason;
      rows.push({ accountId: accId, name: item.name, unit: item.unit, group: item.group, counted, reason });
    }
    if (!rows.length) fail('En az bir kalemin fiziki sayımını girin.');
    const note = typeof command.note === 'string' ? command.note.trim().slice(0, 160) : '';
    const cleanCommand = { type: 'dailyCount', date: state.date, counts: cleanCounts, reasons: cleanReasons, ...(note ? { note } : {}) };
    return {
      cleanCommand,
      summary: {
        type: 'dailyCount',
        date: state.date,
        countedCount: rows.length,
        notedCount: rows.filter(r => r.reason).length,
        note,
        rows
      }
    };
  }
  submitPending({ id, revision, command }, { actor }) {
    text(id, 'Bildirim anahtarı', 100);
    if (!actor?.id || !actor?.name) fail('İşlem sahibi bilgisi gerekli.');
    if (!command || typeof command !== 'object' || !['sale', 'purchase', 'dailyCount'].includes(command.type)) {
      fail('Yalnız satış, alış veya günlük sayım işlemleri onaya gönderilebilir.');
    }
    const existing = this.db.prepare('SELECT * FROM pending_submissions WHERE id=?').get(id);
    if (existing) {
      if (existing.submitted_by_id !== actor.id) {
        fail('Aynı bildirim anahtarı farklı kullanıcıyla kullanılamaz.');
      }
      const storedSummary = JSON.parse(existing.summary_json);
      return { id: existing.id, status: existing.status, duplicate: true, submittedAt: existing.submitted_at, summary: storedSummary };
    }
    const currentState = this.state({ compact: false });
    if (!currentState.initialized) fail('Defter henüz açılmamış.');
    if (revision !== undefined && (!Number.isInteger(revision) || revision !== currentState.revision)) {
      fail('Defter başka bir işlemle güncellendi. Ekranı yenileyip tekrar deneyin.', { status: 409, code: 'REVISION_CONFLICT' });
    }
    let storedCommand = command;
    let summary;
    if (command.type === 'dailyCount') {
      const built = this.#summarizeBlindCount(currentState, command);
      storedCommand = built.cleanCommand;
      summary = built.summary;
    } else {
      summary = this.#summarizeTrade(currentState, command);
    }
    const submittedAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO pending_submissions(
        id, workspace, status, date, type, submitted_by_id, submitted_by_name, submitted_at,
        command_json, summary_json
      ) VALUES(?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
    `).run(id, this.workspace, storedCommand.date, storedCommand.type, actor.id, actor.name, submittedAt, JSON.stringify(storedCommand), JSON.stringify(summary));
    return { id, status: 'pending', duplicate: false, submittedAt, summary };
  }
  #formatPendingRow(row, userNamesById = null, { includeComparison = false, balances = null } = {}) {
    const currentName = userNamesById?.get(row.submitted_by_id) || row.submitted_by_name;
    const reviewerName = row.reviewed_by_id ? (userNamesById?.get(row.reviewed_by_id) || row.reviewed_by_name) : null;
    const summary = JSON.parse(row.summary_json);
    let comparison = null;
    if (includeComparison && row.type === 'dailyCount' && balances) {
      const rows = (summary.rows || []).map(r => {
        const expected = balances[r.accountId] || 0;
        const difference = r.counted - expected;
        return { ...r, expected, difference };
      });
      comparison = {
        rows,
        diffCount: rows.filter(r => r.difference !== 0).length,
        matchCount: rows.filter(r => r.difference === 0).length
      };
    }
    return {
      id: row.id,
      workspace: row.workspace,
      status: row.status,
      date: row.date,
      type: row.type,
      submittedBy: { id: row.submitted_by_id, name: currentName },
      submittedAt: row.submitted_at,
      command: JSON.parse(row.approved_command_json || row.command_json),
      originalCommand: JSON.parse(row.command_json),
      summary,
      ...(comparison ? { comparison } : {}),
      reviewedBy: row.reviewed_by_id ? { id: row.reviewed_by_id, name: reviewerName } : null,
      reviewedAt: row.reviewed_at || null,
      wasEdited: Boolean(row.was_edited),
      rejectionReason: row.rejection_reason || '',
      approvedEventId: row.approved_event_id || null
    };
  }
  listPending({ status = 'pending', submittedById = '', type = 'all', startDate = '', endDate = '', limit = 100, userNamesById = null, includeComparison = false } = {}) {
    const where = [];
    const params = [];
    if (status === 'approved_direct') { where.push("status='approved' AND was_edited=0"); }
    else if (status === 'approved_edited') { where.push("status='approved' AND was_edited=1"); }
    else if (['pending', 'approved', 'rejected'].includes(status)) { where.push('status=?'); params.push(status); }
    if (submittedById) { where.push('submitted_by_id=?'); params.push(submittedById); }
    if (['sale', 'purchase', 'dailyCount'].includes(type)) { where.push('type=?'); params.push(type); }
    if (startDate) { validDate(startDate); where.push('date>=?'); params.push(startDate); }
    if (endDate) { validDate(endDate); where.push('date<=?'); params.push(endDate); }
    const sql = `SELECT * FROM pending_submissions${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY submitted_at DESC LIMIT ?`;
    params.push(Math.min(500, Math.max(1, Number(limit) || 100)));
    const balances = includeComparison ? this.state({ compact: true }).balances : null;
    return this.db.prepare(sql).all(...params).map(r => this.#formatPendingRow(r, userNamesById, { includeComparison, balances }));
  }
  employeeAnalytics({ submittedById = '', startDate = '', endDate = '', userNamesById = null } = {}) {
    const where = [];
    const params = [];
    if (startDate) { validDate(startDate); where.push('date>=?'); params.push(startDate); }
    if (endDate) { validDate(endDate); where.push('date<=?'); params.push(endDate); }
    const allRows = this.db.prepare(`SELECT * FROM pending_submissions${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY submitted_at DESC`).all(...params);
    const sarrafiyeIds = new Set(['ceyrek', 'yarim', 'ziynet', 'cumhuriyet', 'resat']);
    const gramIds = new Set(['gramToplam', 'hurda24']);
    const classifyLine = l => {
      if (l.accountId === 'bilezikAdet' || l.weightAccount === 'bilezik22' || l.accountId === 'bilezik22') return 'bilezik';
      if (l.weightAccount === 'taki14' || l.accountId === 'taki14') return 'taki14';
      if (l.weightAccount === 'taki22' || l.accountId === 'taki22') return 'taki22';
      if (sarrafiyeIds.has(l.accountId)) return 'sarrafiye';
      if (gramIds.has(l.accountId)) return 'gram';
      return 'diger';
    };
    const makeCategories = () => ({
      bilezik: { key: 'bilezik', label: 'Bilezik (22 Ayar)', pieces: 0, gram: 0, totalTL: 0, products: new Map() },
      taki22: { key: 'taki22', label: '22 Ayar Ürün / Takı', pieces: 0, gram: 0, totalTL: 0, products: new Map() },
      taki14: { key: 'taki14', label: '14 Ayar Ürün / Takı', pieces: 0, gram: 0, totalTL: 0, products: new Map() },
      sarrafiye: { key: 'sarrafiye', label: 'Sarrafiye', pieces: 0, gram: 0, totalTL: 0, products: new Map() },
      gram: { key: 'gram', label: 'Gram Altın', pieces: 0, gram: 0, totalTL: 0, products: new Map() },
      diger: { key: 'diger', label: 'Diğer / Hurda / Saat', pieces: 0, gram: 0, totalTL: 0, products: new Map() }
    });
    const makeBucket = (id, name) => ({
      id, name,
      pendingCount: 0, approvedCount: 0, approvedDirectCount: 0, approvedEditedCount: 0, rejectedCount: 0,
      saleCount: 0, saleTotalTL: 0, saleTotalGram: 0,
      purchaseCount: 0, purchaseTotalTL: 0, purchaseTotalGram: 0,
      salesByCategory: makeCategories(),
      purchasesByCategory: makeCategories()
    });
    const addToBucket = (bucket, row, summary) => {
      if (row.status === 'pending') { bucket.pendingCount++; return; }
      if (row.status === 'rejected') { bucket.rejectedCount++; return; }
      bucket.approvedCount++;
      if (row.was_edited) bucket.approvedEditedCount++; else bucket.approvedDirectCount++;
      if (row.type === 'dailyCount') return;
      const isSale = row.type === 'sale';
      if (isSale) { bucket.saleCount++; bucket.saleTotalTL += summary.totalTL; bucket.saleTotalGram += summary.totalGram; }
      else { bucket.purchaseCount++; bucket.purchaseTotalTL += summary.totalTL; bucket.purchaseTotalGram += summary.totalGram; }
      const catMap = isSale ? bucket.salesByCategory : bucket.purchasesByCategory;
      for (const l of summary.lines || []) {
        const cat = catMap[classifyLine(l)];
        const pieces = l.unit === 'ADET' ? l.quantity : 0;
        const gram = l.weightAccount ? l.weight : (l.unit === 'GRAM' ? l.quantity : 0);
        cat.pieces += pieces;
        cat.gram += gram;
        cat.totalTL += l.value;
        const prodKey = `${l.accountId}:${l.weightAccount || ''}`;
        if (!cat.products.has(prodKey)) {
          cat.products.set(prodKey, { accountId: l.accountId, name: l.name, weightAccountName: l.weightAccountName || '', unit: l.unit, pieces: 0, gram: 0, totalTL: 0 });
        }
        const p = cat.products.get(prodKey);
        p.pieces += pieces; p.gram += gram; p.totalTL += l.value;
      }
    };
    const serializeBucket = b => {
      const decided = b.approvedCount + b.rejectedCount;
      const serializeCats = cats => Object.values(cats).map(c => ({
        key: c.key, label: c.label, pieces: c.pieces, gram: c.gram, totalTL: c.totalTL,
        products: [...c.products.values()].sort((a, x) => x.totalTL - a.totalTL || x.gram - a.gram)
      }));
      return {
        id: b.id, name: b.name,
        pendingCount: b.pendingCount, approvedCount: b.approvedCount,
        approvedDirectCount: b.approvedDirectCount, approvedEditedCount: b.approvedEditedCount,
        rejectedCount: b.rejectedCount,
        approvalRatePct: decided ? Math.round((b.approvedCount * 100) / decided) : null,
        directAccuracyPct: b.approvedCount ? Math.round((b.approvedDirectCount * 100) / b.approvedCount) : null,
        saleCount: b.saleCount, saleTotalTL: b.saleTotalTL, saleTotalGram: b.saleTotalGram,
        purchaseCount: b.purchaseCount, purchaseTotalTL: b.purchaseTotalTL, purchaseTotalGram: b.purchaseTotalGram,
        salesByCategory: serializeCats(b.salesByCategory),
        purchasesByCategory: serializeCats(b.purchasesByCategory)
      };
    };
    const empMap = new Map();
    const totals = makeBucket('all', 'Tüm Çalışanlar');
    for (const row of allRows) {
      const empName = userNamesById?.get(row.submitted_by_id) || row.submitted_by_name;
      if (!empMap.has(row.submitted_by_id)) empMap.set(row.submitted_by_id, makeBucket(row.submitted_by_id, empName));
      const summary = JSON.parse(row.summary_json);
      addToBucket(empMap.get(row.submitted_by_id), row, summary);
      if (!submittedById || row.submitted_by_id === submittedById) addToBucket(totals, row, summary);
    }
    const byEmployee = [...empMap.values()].map(serializeBucket)
      .sort((a, b) => b.saleTotalTL - a.saleTotalTL || b.approvedCount - a.approvedCount || a.name.localeCompare(b.name, 'tr'));
    return { totals: serializeBucket(totals), byEmployee };
  }
  approvePending({ id, commandOverride = null, revision, actor }, { compact = false } = {}) {
    text(id, 'Bildirim anahtarı', 100);
    if (!actor || actor.role !== 'owner') fail('Onay için yönetici oturumu gerekli.', { status: 403 });
    const row = this.db.prepare('SELECT * FROM pending_submissions WHERE id=?').get(id);
    if (!row) fail('Onay bekleyen bildirim bulunamadı.', { status: 404 });
    if (row.status === 'approved') {
      return { ok: true, id, approvedEventId: row.approved_event_id, wasEdited: Boolean(row.was_edited), duplicate: true, state: this.state({ compact }) };
    }
    if (row.status !== 'pending') fail('Bu bildirim daha önce reddedilmiş.', { status: 409 });
    if (row.type === 'dailyCount') {
      const storedCommand = JSON.parse(row.command_json);
      const reviewedAt = new Date().toISOString();
      this.db.prepare(`
        UPDATE pending_submissions
        SET status='approved', reviewed_by_id=?, reviewed_by_name=?, reviewed_at=?, was_edited=0
        WHERE id=?
      `).run(actor.id, actor.name, reviewedAt, id);
      const st = this.state({ compact });
      return { ok: true, id, type: 'dailyCount', counts: storedCommand.counts || {}, reasons: storedCommand.reasons || {}, note: storedCommand.note || '', duplicate: false, state: st };
    }
    const currentState = this.state({ compact: false });
    const storedCommand = JSON.parse(row.command_json);
    const wasEdited = Boolean(commandOverride && typeof commandOverride === 'object');
    const finalCommand = { ...(wasEdited ? commandOverride : storedCommand), date: currentState.date };
    if (!['sale', 'purchase'].includes(finalCommand.type)) fail('Onaylanan işlem satış veya alış olmalı.');
    const approvedSummary = this.#summarizeTrade(currentState, finalCommand);
    const eventId = `approve-${id}`;
    const execResult = this.execute(
      { id: eventId, revision, command: finalCommand },
      { compact, actor, submittedBy: { id: row.submitted_by_id, name: row.submitted_by_name }, wasEdited }
    );
    const reviewedAt = new Date().toISOString();
    this.db.prepare(`
      UPDATE pending_submissions
      SET status='approved', approved_command_json=?, summary_json=?,
          reviewed_by_id=?, reviewed_by_name=?, reviewed_at=?, was_edited=?, approved_event_id=?
      WHERE id=?
    `).run(JSON.stringify(finalCommand), JSON.stringify(approvedSummary), actor.id, actor.name, reviewedAt, wasEdited ? 1 : 0, eventId, id);
    return { ok: true, id, approvedEventId: eventId, wasEdited, duplicate: execResult.duplicate, state: execResult.state };
  }
  rejectPending({ id, reason, actor }) {
    text(id, 'Bildirim anahtarı', 100);
    if (!actor || actor.role !== 'owner') fail('Red işlemi için yönetici oturumu gerekli.', { status: 403 });
    const cleanReason = text(reason, 'Red gerekçesi', 160);
    const row = this.db.prepare('SELECT * FROM pending_submissions WHERE id=?').get(id);
    if (!row) fail('Onay bekleyen bildirim bulunamadı.', { status: 404 });
    if (row.status !== 'pending') fail('Yalnızca onay bekleyen bildirimler reddedilebilir.', { status: 409 });
    const reviewedAt = new Date().toISOString();
    this.db.prepare(`
      UPDATE pending_submissions
      SET status='rejected', rejection_reason=?, reviewed_by_id=?, reviewed_by_name=?, reviewed_at=?
      WHERE id=?
    `).run(cleanReason, actor.id, actor.name, reviewedAt, id);
    return { ok: true, id, status: 'rejected', rejectionReason: cleanReason };
  }
  close() {
    if (this.#snapshotDirty && this.#cache) {
      if (this.#cache.mode === 'full') this.#saveSnapshot('full', this.#cache.ledger, this.#cache.ledger.state.revision);
      else this.#saveSnapshot('hot', this.#cache.hot, this.#cache.hot.state.revision);
    }
    this.#cache = null;
    this.db.close();
  }
}
