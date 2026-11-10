import { createHash } from 'node:crypto';
import { projectSupplierParties } from './supplier-view.mjs';
import {supplierDocuments} from './supplier-ledger.mjs';
import { purchaseCostOffer } from './inventory.mjs';
import { applyEvent, emptyState, fail, validDate, currentCountPolicy, priorScrapChoices, scrapCustomerResolver, scrapAdvanceSources } from './domain.mjs';

export const LEDGER_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const blankTotals = () => ({ todaysCount: 0, revenue: 0, expenses: 0, salesCash: 0, totalEntries: 0, items: [], flowByUnit: {} });
const ordinaryMoneyFlow = entry => entry && (['sale','saleReturn','purchase','collection','orderAdvance','orderRefund','supplierPurchase','supplierPayment','supplierReturn'].includes(entry.type) || (entry.type === 'movement' && entry.label !== 'Açılış düzeltmesi'));
function financialRows(ledger, entries) {
  return entries.flatMap(row => {
    const a = ledger.state.accounts.find(a => a.id === row.accountId);
    return a?.kind === 'asset' && (['TL','HAS','SILVER'].includes(a.unit) || /^[A-Z]{3}$/.test(a.unit)) && row.delta ? [{ unit: a.unit, delta: row.delta }] : [];
  });
}
function addFlow(day, rows, sign = 1) {
  for (const row of rows) {
    const totals = day.flowByUnit[row.unit] ||= { incoming: 0, outgoing: 0 };
    totals[row.delta > 0 ? 'incoming' : 'outgoing'] += sign * Math.abs(row.delta);
    if (!Number.isSafeInteger(totals.incoming) || !Number.isSafeInteger(totals.outgoing)) fail('Günlük ödeme toplamı güvenli miktar sınırını aşıyor.');
  }
}
function indexMoneyFlow(ledger, day, entry) {
  // The undo and replacement form one atomic correction, never two new payments.
  if (entry.meta.amendmentId) return;
  const previous = entry.meta.amendsOriginalId && ledger.byId.get(entry.meta.amendsOriginalId);
  if (previous) {
    let origin = previous;
    while (origin.meta.amendsOriginalId) origin = ledger.byId.get(origin.meta.amendsOriginalId);
    if (origin.date === entry.date) {
      if (ordinaryMoneyFlow(previous)) addFlow(day, financialRows(ledger, previous.entries), -1);
      if (ordinaryMoneyFlow(entry)) addFlow(day, financialRows(ledger, entry.entries));
    } else if (ordinaryMoneyFlow(previous) || ordinaryMoneyFlow(entry)) {
      const changes = new Map();
      for (const [event, sign] of [[previous, -1], [entry, 1]]) for (const row of financialRows(ledger, event.entries)) changes.set(row.unit, (changes.get(row.unit) || 0) + row.delta * sign);
      addFlow(day, [...changes].filter(([,delta]) => delta).map(([unit,delta]) => ({ unit, delta })));
    }
  } else {
    const source = ['reverse','supplierReverse'].includes(entry.type) ? ledger.byId.get(entry.meta.originalId) : entry;
    if (ordinaryMoneyFlow(source)) addFlow(day, financialRows(ledger, entry.entries));
  }
}

function indexEntry(ledger, entry) {
  let day = ledger.byDate.get(entry.date);
  if (!day) { day = blankTotals(); ledger.byDate.set(entry.date, day); ledger.indexBytes += 160; }
  day.items.push(entry); day.todaysCount++;
  day.revenue += entry.meta.revenue || 0; day.expenses += entry.meta.expense || 0;
  if (['sale', 'saleReturn'].includes(entry.type) || (entry.type === 'reverse' && ['sale', 'saleReturn'].includes(ledger.byId.get(entry.meta.originalId)?.type))) {
    for (const row of entry.entries) if (row.accountId === 'nakit') day.salesCash += row.delta;
  }
  day.totalEntries += entry.entries.length; ledger.totalEntries += entry.entries.length;
  indexMoneyFlow(ledger, day, entry);
  if (['reverse','supplierReverse'].includes(entry.type)) ledger.reversed.add(entry.meta.originalId);
  ledger.byId.set(entry.id, entry);
  ledger.journalBytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
  // Conservative accounting for index keys/references; this is not a V8/RSS measurement.
  ledger.indexBytes += 128 + Buffer.byteLength(entry.id) * 2;
}

export function hydrateLedger(events) {
  const ledger = { state: emptyState(), seen: new Set(), byDate: new Map(), byId: new Map(), reversed: new Set(), totalEntries: 0, journalBytes: 2, indexBytes: 0 };
  const iterator = events[Symbol.iterator]();
  try {
    while (true) {
      const next = iterator.next(); // SQL/JSON read errors retain their original classification.
      if (next.done) break;
      const before = ledger.state.journal.length;
      try { applyEvent(ledger.state, next.value, ledger.seen); }
      catch { throw Object.assign(new Error('Stored ledger history failed validation.'), { code: 'STORED_HISTORY_INVALID' }); }
      for (const entry of ledger.state.journal.slice(before)) indexEntry(ledger, entry);
    }
  } finally { iterator.return?.(); }
  return ledger;
}

export function applyLedgerEvent(ledger, event) {
  // This state is privately owned. Any failure evicts it at the Repository boundary.
  const before = ledger.state.journal.length;
  applyEvent(ledger.state, event, ledger.seen);
  for (const entry of ledger.state.journal.slice(before)) indexEntry(ledger, entry);
}

export function estimateLedgerBytes(ledger) {
  const { journal, ...base } = ledger.state;
  return Buffer.byteLength(JSON.stringify(base)) + ledger.journalBytes + ledger.indexBytes;
}

export function projectLedger(ledger, compact = false) {
  const accounts = ledger.state.accounts.map(a => a.countPolicy ? { ...a, countPolicy: currentCountPolicy(a) } : a);
  const day = ledger.byDate.get(ledger.state.date) || blankTotals();
  const moneyFlow = { incoming: day.flowByUnit.TL?.incoming || 0, outgoing: day.flowByUnit.TL?.outgoing || 0, byUnit: day.flowByUnit };
  const supplierParties = projectSupplierParties(ledger.state);
  if (!compact) return structuredClone({ ...ledger.state, accounts, moneyFlow, supplierParties });
  const inventoryItems = ledger.state.inventoryItems?.map(item => {
    const id = item.purchaseLine?.id;
    const offer = id && !ledger.reversed.has(id) && purchaseCostOffer(item, ledger.byId.get(id));
    return offer ? { ...item, purchaseCostOffer: offer } : item;
  });
  return structuredClone({
    ...ledger.state, accounts, moneyFlow, supplierParties, view: 'compact', journal: ledger.state.journal.slice(-4),
    ...(inventoryItems && { inventoryItems }),
    overview: { todaysCount: day.todaysCount, revenue: day.revenue, expenses: day.expenses, salesCash: day.salesCash, closingCount: ledger.state.closings.length },
    journalMeta: { total: ledger.state.journal.length, totalEntries: ledger.totalEntries }
  });
}

const types = new Set(['all', 'linkScrapPurchase', 'customerOrder', 'orderAdvance', 'orderRefund', 'orderCancel', 'scrapAdvanceTransfer', 'scrapAdvanceUndo', 'opening', 'nominalOpening', 'account', 'accountUpdate', 'fundAccount', 'fundUpdate', 'stockAccount', 'stockUpdate', 'sale', 'saleReturn', 'purchase', 'stock', 'movement', 'collection', 'transfer', 'settlement', 'reverse', 'stocktake', 'close', 'registerItem', 'releaseItem', 'itemCostSource']);
const typeGroups = { money: ['movement','transfer','settlement'], inventory: ['stock','stocktake','registerItem','releaseItem','itemCostSource'], setup: ['opening','nominalOpening','account','accountUpdate','fundAccount','fundUpdate','stockAccount','stockUpdate','close'] };
for(const type of ['supplierFirm','supplierFirmUpdate','supplierUnit','supplierPurchase','supplierPayment','supplierAllocation','supplierOffset','supplierReturn','supplierReverse','supplierLegacyReceiptLink'])types.add(type);
typeGroups.purchases=['purchase','supplierPurchase'];
// Match the existing browser journal's Turkish and accent-insensitive search.
const normalizeSearch = value => value.toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i');
export function normalizeJournalOptions({ scope = 'today', q = '', type = 'all', limit = 50, cursor, startDate = '', endDate = '', accountId = '', scrapForSale = '', scrapForAdvance = '' } = {}) {
  if (!['today', 'all'].includes(scope) || (!types.has(type) && !Object.hasOwn(typeGroups, type)) || typeof q !== 'string' || q.length > 160 || !Number.isInteger(limit) || limit < 1 || limit > 100 || (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 512))) fail('Geçerli defter filtresi ve 1–100 arası sayfa boyutu seçin.');
  if (typeof startDate !== 'string' || typeof endDate !== 'string' || typeof accountId !== 'string' || accountId.length > 160) fail('Geçerli tarih aralığı ve hesap seçin.');
  if (typeof scrapForAdvance !== 'string' || scrapForAdvance.length > 100 || (scrapForAdvance && (scrapForSale || type !== 'purchase' || scope !== 'all'))) fail('Hurda avansı için müşteri ve tüm alışlar filtresi gerekli.');
  if (typeof scrapForSale !== 'string' || scrapForSale.length > 100 || (scrapForSale && (type !== 'purchase' || scope !== 'all'))) fail('Önceki hurda alışları için tüm geçmişte alış filtresini seçin.');
  if (startDate) validDate(startDate);
  if (endDate) validDate(endDate);
  if (startDate && endDate && startDate > endDate) fail('Başlangıç tarihi bitiş tarihinden sonra olamaz.');
  return { scope, q: normalizeSearch(q.trim()), type, limit, cursor, startDate, endDate, accountId, ...(scrapForSale && {scrapForSale}), ...(scrapForAdvance && {scrapForAdvance}) };
}

function selectedAccount(ledger, accountId) {
  return ledger.state.accounts.find(account => account.id === accountId) || fail('Hesap bulunamadı.');
}

function matchesJournalAccount(ledger, entry, accountId, inheritParty, resolveParty) {
  const seen = new Set();
  while (entry && !seen.has(entry.id)) {
    seen.add(entry.id);
    if (entry.meta.counterpartyId === accountId || entry.entries.some(row => row.accountId === accountId) || (inheritParty && resolveParty(entry) === accountId)) return true;
    // Returns and their reversals retain the original party even for cash-only
    // sales. An amendment replacement keeps its own party and financial legs.
    entry = inheritParty && ['saleReturn', 'reverse'].includes(entry.type) ? ledger.byId.get(entry.meta.originalId) : null;
  }
  return false;
}

function projectReceiptContext(ledger, items) {
  if (!items.length) return [];
  const linked = new Map();
  const connect = (from, to) => {
    if (!to || to === from || !ledger.byId.has(to)) return;
    if (!linked.has(from)) linked.set(from, new Set());
    if (!linked.has(to)) linked.set(to, new Set());
    linked.get(from).add(to); linked.get(to).add(from);
  };
  const visible = new Set(items.map(entry => entry.id)), related = new Set(visible), pending = [...visible];
  for (const entry of ledger.state.journal) {
    for (const id of [entry.meta.originalId, entry.meta.amendsOriginalId, entry.meta.amendmentId, entry.meta.exchangeId, ...(['scrapAdvanceTransfer','scrapAdvanceUndo'].includes(entry.type) ? [entry.meta.purchaseId] : []), entry.meta.orderId, entry.meta.advanceId,
      ...(entry.meta.advanceAllocations || []).map(row => row.advanceId),
      ...(entry.meta.allocations || []).flatMap(row=>[row.sourceId,row.purchaseId]),
      ...(entry.meta.sourceUses || []).map(row=>row.sourceId),...(entry.meta.debtUses || []).map(row=>row.sourceId),...(entry.meta.uses || []).map(row=>row.sourceId)]) connect(entry.id, id);
    if (entry.type !== 'linkScrapPurchase') continue;
    // A shared purchase contributes only directly associated records to this page.
    const refs = [entry.id, entry.meta.saleId, entry.meta.purchaseId];
    if (!refs.some(id => visible.has(id))) continue;
    for (const id of refs) if (!related.has(id)) { related.add(id); pending.push(id); }
  }
  for (let index = 0; index < pending.length; index++) {
    for (const id of linked.get(pending[index]) || []) {
      if (!related.has(id)) { related.add(id); pending.push(id); }
    }
  }
  // Context is the selected page's linked families in original journal order,
  // not extra result rows. Filters, pagination and financial totals stay intact.
  return ledger.state.journal.filter(entry => related.has(entry.id) && !visible.has(entry.id));
}

export function projectJournal(ledger, { scope, q, type, limit, cursor, startDate = '', endDate = '', accountId = '', scrapForSale = '', scrapForAdvance = '' }) {
  const inheritParty = accountId ? selectedAccount(ledger, accountId).kind === 'receivable' : false;
  const revision = ledger.state.revision;
  // Preserve existing cursors when none of the new optional filters is selected.
  const range = { ...(startDate ? { startDate } : {}), ...(endDate ? { endDate } : {}), ...(accountId ? { accountId } : {}), ...(scrapForSale && {scrapForSale}), ...(scrapForAdvance && {scrapForAdvance}) };
  const filterHash = createHash('sha256').update(JSON.stringify({ scope, q, type, limit, ...range })).digest('hex');
  let offset = 0;
  if (cursor) {
    let decoded;
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
      decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (!decoded || Object.keys(decoded).length !== 3 || !Number.isSafeInteger(decoded.revision) || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0 || typeof decoded.filterHash !== 'string') throw new Error();
    } catch { fail('Defter sayfa bilgisi geçersiz.'); }
    if (decoded.revision !== revision || decoded.filterHash !== filterHash) fail('Defter veya filtreler değişti. İlk sayfadan yeniden başlayın.', { status: 409, code: 'JOURNAL_CURSOR_STALE' });
    offset = decoded.offset;
  }
  const day = ledger.byDate.get(ledger.state.date) || blankTotals();
  let selected = scope === 'today' ? day.items : ledger.state.journal;
  const filtered = q || type !== 'all' || startDate || endDate || accountId;
  const resolveParty = scrapCustomerResolver(ledger.state);
  const advanceChoices = scrapForAdvance ? scrapAdvanceSources(ledger.state,scrapForAdvance) : null;
  const scrapChoices = scrapForSale ? priorScrapChoices(ledger.state,scrapForSale,resolveParty) : advanceChoices;
  if (filtered) {
    const names = new Map(ledger.state.accounts.map(account => [account.id, account.name]));
    selected = selected.filter(entry => {
      if (scrapChoices && !scrapChoices.has(entry.id)) return false;
      if ((startDate && entry.date < startDate) || (endDate && entry.date > endDate) || (accountId && !matchesJournalAccount(ledger, entry, accountId, inheritParty, resolveParty))) return false;
      if (type !== 'all' && !(typeGroups[type] || [type]).includes(entry.type)) return false;
      if (!q) return true;
      const text = normalizeSearch([entry.label, entry.date, entry.id, entry.meta.note, entry.meta.productCategory, names.get(entry.meta.counterpartyId), ...entry.entries.map(row => names.get(row.accountId) || '')].filter(Boolean).join(' '));
      return text.includes(q);
    });
  }
  if (offset > selected.length) fail('Defter sayfa bilgisi geçersiz.');
  const end = selected.length - offset, items = selected.slice(Math.max(0, end - limit), end).reverse();
  const supplierPurchaseInfo={};
  for(const supplierId of new Set(items.filter(e=>e.type==='supplierPurchase').map(e=>e.meta.supplierId))) {
    for(const purchase of supplierDocuments(ledger.state,supplierId).purchases) {
      if(items.some(e=>e.id===purchase.id)) supplierPurchaseInfo[purchase.id]=purchase.lines;
    }
  }
  const retired = new Set(ledger.state.accounts.filter(account => account.retired).map(account => account.id));
  const returnInfo = new Map(items.filter(entry => entry.type === 'sale').map(entry => [entry.id, {
    eligible: !ledger.reversed.has(entry.id),
    lines: (entry.meta.lines || []).map((line, lineIndex) => ({ line, lineIndex })).filter(({ line }) => !retired.has(line.accountId) && !retired.has(line.weightAccount)).map(({ line, lineIndex }) => ({ lineIndex, remainingQuantity: line.quantity, remainingWeight: line.weight || 0 }))
  }]));
  if (returnInfo.size) {
    // The visible sale page may exclude every return and every cancellation.
    // Derive availability from the full owned ledger without mutating its events.
    for (const event of ledger.state.journal) {
      if (event.type !== 'saleReturn' || ledger.reversed.has(event.id)) continue;
      const info = returnInfo.get(event.meta.originalId);
      if (!info) continue;
      for (const line of event.meta.lines) {
        const remaining = info.lines.find(row => row.lineIndex === line.lineIndex);
        if (!remaining) continue;
        remaining.remainingQuantity -= line.quantity;
        remaining.remainingWeight -= line.weight;
      }
    }
    for (const info of returnInfo.values()) info.eligible = info.eligible && info.lines.some(line => line.remainingQuantity > 0);
  }
  const nextOffset = offset + items.length;
  return structuredClone({
    items: items.map(entry => returnInfo.has(entry.id) ? { ...entry, returnInfo: returnInfo.get(entry.id), scrapLinkCustomerId:resolveParty(entry) } : advanceChoices ? { ...entry, scrapAdvanceCapacityTL:advanceChoices.get(entry.id) } : entry), total: selected.length,
    receiptContext: projectReceiptContext(ledger, items), supplierPurchaseInfo,
    totalEntries: filtered ? selected.reduce((sum, entry) => sum + entry.entries.length, 0) : scope === 'today' ? day.totalEntries : ledger.totalEntries,
    reversedIds: items.filter(entry => ledger.reversed.has(entry.id)).map(entry => entry.id),
    nextCursor: nextOffset < selected.length ? Buffer.from(JSON.stringify({ revision, offset: nextOffset, filterHash })).toString('base64url') : null,
    revision
  });
}

export function projectAccountStatement(ledger, { accountId, startDate, endDate }) {
  if (!accountId) fail('Ekstre için hesap seçin.');
  const account = selectedAccount(ledger, accountId);
  let opening = 0, incoming = 0, outgoing = 0, lastPhysicalCount = null;
  for (const event of ledger.state.journal) {
    if (endDate && event.date > endDate) continue;
    for (const row of event.entries) {
      if (row.accountId !== accountId) continue;
      if (startDate && event.date < startDate) opening += row.delta;
      else if (row.delta >= 0) incoming += row.delta;
      else outgoing -= row.delta;
      if (![opening, incoming, outgoing].every(Number.isSafeInteger)) fail('Ekstre toplamı güvenli miktar sınırını aşıyor. Daha kısa bir tarih aralığı seçin.');
    }
    // Carried periodic gram balances are not physical measurements. Read actual
    // count rows, including zero-difference counts with no journal entry leg.
    if (account.physical && ['close', 'stocktake'].includes(event.type)) {
      const count = event.meta.counts?.find(row => row.accountId === accountId && Number.isSafeInteger(row.counted));
      if (count) lastPhysicalCount = { eventId: event.id, date: event.date, type: event.type, unit: account.unit, counted: count.counted, expected: count.expected, difference: count.difference };
    }
  }
  const closing = Number(BigInt(opening) + BigInt(incoming) - BigInt(outgoing));
  if (!Number.isSafeInteger(closing)) fail('Ekstre bakiyesi güvenli miktar sınırını aşıyor.');
  return structuredClone({ revision: ledger.state.revision, account, startDate, endDate, opening, incoming, outgoing, closing, lastPhysicalCount });
}
