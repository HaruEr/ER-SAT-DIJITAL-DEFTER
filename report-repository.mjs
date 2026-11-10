import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { replay, validDate, workdaySummary, currentCountPolicy } from './domain.mjs';

export class ReportError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const unavailable = () => new ReportError('Rapor verileri şu anda okunamıyor. Ana bilgisayardaki defteri kontrol edin.', 503);
const types = new Set(['scrapAdvanceTransfer','scrapAdvanceUndo','opening','account','fundAccount','sale','saleReturn','purchase','stock','movement','collection','transfer','settlement','reverse','stocktake','close','nominalOpening','registerItem','releaseItem']);
for(const type of ['supplierFirm','supplierFirmUpdate','supplierUnit','supplierPurchase','supplierPayment','supplierAllocation','supplierOffset','supplierReturn','supplierReverse','supplierLegacyReceiptLink'])types.add(type);
const normalize = value => value.toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/ı/g,'i');
function accountInfo(account) {
  const stock = account.isSaleable || account.isPurchasable || account.pairedGroups?.length || ['bilezik22','taki14','taki22','hurda22','gramaltin','gramAdet'].includes(account.id);
  return { id: account.id, name: account.name, unit: account.unit, kind: account.kind, category: account.kind === 'receivable' ? 'receivable' : stock ? 'stock' : 'financial', physical: Boolean(account.physical), countPolicy: currentCountPolicy(account), retired: Boolean(account.retired) };
}

export class ReportRepository {
  constructor(filename, workspace = 'demo') {
    this.workspace = workspace;
    try { this.db = new DatabaseSync(filename, { readOnly: true }); this.db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;'); }
    catch { this.db?.close(); throw unavailable(); }
  }
  #snapshot() {
    try {
      this.db.exec('BEGIN');
      const revision = this.db.prepare('SELECT revision FROM meta WHERE id=1').get()?.revision;
      if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid revision');
      const rows = this.db.prepare('SELECT body FROM events ORDER BY seq').iterate();
      const events = (function* () { for (const row of rows) yield JSON.parse(row.body); })();
      const state = replay(events);
      this.db.exec('COMMIT'); return { state, revision };
    } catch { try { this.db.exec('ROLLBACK'); } catch {} throw unavailable(); }
  }
  overview() {
    const { state, revision } = this.#snapshot(), today = state.journal.filter(event => event.date === state.date);
    return { workspace: this.workspace, revision, initialized: state.initialized, date: state.date,
      totals: { sales: today.reduce((n,event) => n+(event.meta.revenue||0),0), purchases: today.reduce((n,event) => n+(event.meta.purchaseTotal||0),0), expenses: today.reduce((n,event) => n+(event.meta.expense||0),0) },
      accounts: state.accounts.filter(account => !account.retired).map(account => ({ ...accountInfo(account), balance: state.balances[account.id] || 0 })) };
  }
  summary(date) {
    const { state, revision } = this.#snapshot();
    let summary;
    try { summary = workdaySummary(state, date); }
    catch { throw new ReportError('Geçerli bir defter günü seçin.'); }
    return { workspace: this.workspace, revision, ...summary, accounts: summary.accounts.map(row => {
      const { id, ...info } = accountInfo(state.accounts.find(account => account.id === row.accountId));
      return { ...info, ...row };
    }) };
  }
  journal({ date = '', type = '', q = '', limit = 25, cursor = '' } = {}) {
    if (typeof date !== 'string' || typeof type !== 'string' || typeof q !== 'string' || q.length > 160 || typeof cursor !== 'string' || cursor.length > 1200 || (type && !types.has(type))) throw new ReportError('Geçersiz rapor filtresi.');
    if (date) { try { validDate(date); } catch { throw new ReportError('Geçerli bir iş günü seçin.'); } }
    if (!(typeof limit === 'number' || typeof limit === 'string') || !/^\d{1,3}$/.test(String(limit)) || Number(limit) < 1 || Number(limit) > 100) throw new ReportError('Sayfa başına 1–100 kayıt seçin.');
    limit = Number(limit); q = normalize(q.trim());
    const { state, revision } = this.#snapshot();
    const filter = createHash('sha256').update(JSON.stringify({ workspace: this.workspace, date, type, q, limit })).digest('hex');
    let offset = 0;
    if (cursor) {
      let value;
      try { if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error(); value = JSON.parse(Buffer.from(cursor,'base64url').toString('utf8')); }
      catch { throw new ReportError('Sayfa bağlantısı geçersiz. Listeyi yeniden açın.'); }
      if (!value || !Number.isSafeInteger(value.revision) || !Number.isSafeInteger(value.offset) || value.offset < 0 || value.filter !== filter) throw new ReportError('Sayfa bağlantısı bu filtreye ait değil.');
      if (value.revision !== revision) throw new ReportError('Kayıtlar değişti. Listeyi yeniden yükleyin.',409);
      offset = value.offset;
    }
    const accountMap = new Map(state.accounts.map(account => [account.id,account]));
    const all = state.journal.map((event,index) => ({ event, record: index+1 })).filter(({event}) => event.type !== 'itemCostSource' && (!date || event.date===date) && (!type || event.type===type) && (!q || normalize([event.label,event.meta.note,event.date,...event.entries.map(entry=>accountMap.get(entry.accountId).name)].filter(Boolean).join(' ')).includes(q))).reverse();
    if (offset > all.length) throw new ReportError('Sayfa bağlantısı geçersiz.');
    const items = all.slice(offset,offset+limit).map(({event,record}) => ({ record, date: event.date, type: event.type, label: event.label, note: event.meta.note || '', sales: event.meta.revenue || 0, purchases: event.meta.purchaseTotal || 0,
      entries: event.entries.map(entry => { const account=accountMap.get(entry.accountId), info=accountInfo(account); return { accountId: account.id, name: account.name, unit: account.unit, kind: account.kind, category: info.category, delta: entry.delta }; }) }));
    const nextCursor = offset+limit < all.length ? Buffer.from(JSON.stringify({revision,offset:offset+limit,filter})).toString('base64url') : null;
    return { workspace: this.workspace, revision, items, nextCursor };
  }
  close() { this.db.close(); }
}
