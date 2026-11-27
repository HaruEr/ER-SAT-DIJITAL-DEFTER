import { createHash } from 'node:crypto';
import { projectSupplierParties, projectSupplierDetail } from './supplier-view.mjs';
import { supplierDocuments, supplierFirms, supplierAccountIds, ledgerActiveSupplierUnits } from './supplier-ledger.mjs';
import { purchaseCostOffer } from './inventory.mjs';
import { applyEvent, emptyState, fail, validDate, currentCountPolicy, priorScrapChoices, scrapCustomerResolver, scrapAdvanceSources, getAccountIndex } from './domain.mjs';

export const LEDGER_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const blankTotals = () => ({ todaysCount: 0, revenue: 0, expenses: 0, salesCash: 0, totalEntries: 0, items: [], flowByUnit: {} });
const ordinaryMoneyFlow = entry => entry && (['sale','saleReturn','purchase','collection','orderAdvance','orderRefund','supplierPurchase','supplierPayment','supplierReturn','currencyExchange'].includes(entry.type) || (entry.type === 'movement' && entry.label !== 'Açılış düzeltmesi'));
function financialRows(accounts, entries) {
  const byId = getAccountIndex(accounts).byId;
  return entries.flatMap(row => {
    const a = byId.get(row.accountId);
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
function indexMoneyFlow(accounts, byIdGet, day, entry) {
  // The undo and replacement form one atomic correction, never two new payments.
  if (entry.meta.amendmentId) return;
  const previous = entry.meta.amendsOriginalId && byIdGet(entry.meta.amendsOriginalId);
  if (previous) {
    let origin = previous;
    while (origin.meta.amendsOriginalId) origin = byIdGet(origin.meta.amendsOriginalId);
    if (origin.date === entry.date) {
      if (ordinaryMoneyFlow(previous)) addFlow(day, financialRows(accounts, previous.entries), -1);
      if (ordinaryMoneyFlow(entry)) addFlow(day, financialRows(accounts, entry.entries));
    } else if (ordinaryMoneyFlow(previous) || ordinaryMoneyFlow(entry)) {
      const changes = new Map();
      for (const [event, sign] of [[previous, -1], [entry, 1]]) for (const row of financialRows(accounts, event.entries)) changes.set(row.unit, (changes.get(row.unit) || 0) + row.delta * sign);
      addFlow(day, [...changes].filter(([, delta]) => delta).map(([unit, delta]) => ({ unit, delta })));
    }
  } else {
    const source = ['reverse','supplierReverse'].includes(entry.type) ? byIdGet(entry.meta.originalId) : entry;
    if (ordinaryMoneyFlow(source)) addFlow(day, financialRows(accounts, entry.entries));
  }
}

function connectReceiptLink(ledger, from, to) {
  if (!to || to === from) return;
  let setFrom = ledger.receiptLinks.get(from);
  if (!setFrom) { setFrom = new Set(); ledger.receiptLinks.set(from, setFrom); }
  setFrom.add(to);
  let setTo = ledger.receiptLinks.get(to);
  if (!setTo) { setTo = new Set(); ledger.receiptLinks.set(to, setTo); }
  setTo.add(from);
}

function indexEntry(ledger, entry, { measureBytes = true } = {}) {
  let day = ledger.byDate.get(entry.date);
  if (!day) { day = blankTotals(); ledger.byDate.set(entry.date, day); ledger.indexBytes += 160; }
  day.items.push(entry); day.todaysCount++;
  day.revenue += entry.meta.revenue || 0; day.expenses += entry.meta.expense || 0;
  if (['sale', 'saleReturn'].includes(entry.type) || (entry.type === 'reverse' && ['sale', 'saleReturn'].includes(ledger.byId.get(entry.meta.originalId)?.type))) {
    for (const row of entry.entries) if (row.accountId === 'nakit') day.salesCash += row.delta;
  }
  day.totalEntries += entry.entries.length; ledger.totalEntries += entry.entries.length;
  indexMoneyFlow(ledger.state.accounts, id => ledger.byId.get(id), day, entry);
  if (['reverse','supplierReverse'].includes(entry.type)) ledger.reversed.add(entry.meta.originalId);
  if (entry.type === 'saleReturn' && entry.meta.originalId) {
    let list = ledger.saleReturnsByOriginal.get(entry.meta.originalId);
    if (!list) { list = []; ledger.saleReturnsByOriginal.set(entry.meta.originalId, list); }
    list.push(entry);
  }
  const orderIndex = ledger.byId.size;
  ledger.byId.set(entry.id, entry);
  ledger.orderById.set(entry.id, orderIndex);
  for (const id of [entry.meta.originalId, entry.meta.amendsOriginalId, entry.meta.amendmentId, entry.meta.exchangeId, ...(['scrapAdvanceTransfer','scrapAdvanceUndo'].includes(entry.type) ? [entry.meta.purchaseId] : []), entry.meta.orderId, entry.meta.advanceId,
    ...(entry.meta.advanceAllocations || []).map(row => row.advanceId),
    ...(entry.meta.allocations || []).flatMap(row=>[row.sourceId,row.purchaseId]),
    ...(entry.meta.sourceUses || []).map(row=>row.sourceId),...(entry.meta.debtUses || []).map(row=>row.sourceId),...(entry.meta.uses || []).map(row=>row.sourceId)]) {
    connectReceiptLink(ledger, entry.id, id);
  }
  if (entry.type === 'linkScrapPurchase') {
    for (const ref of [entry.id, entry.meta.saleId, entry.meta.purchaseId]) {
      if (!ref) continue;
      let list = ledger.scrapLinksByRef.get(ref);
      if (!list) { list = []; ledger.scrapLinksByRef.set(ref, list); }
      list.push(entry);
    }
  }
  if (measureBytes) ledger.journalBytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
  // Conservative accounting for index keys/references; this is not a V8/RSS measurement.
  ledger.indexBytes += 128 + Buffer.byteLength(entry.id) * 2;
}

export function restoreLedgerSnapshot({ state, journalBytes }) {
  const ledger = { state, seen: new Set(), byDate: new Map(), byId: new Map(), orderById: new Map(), reversed: new Set(), saleReturnsByOriginal: new Map(), receiptLinks: new Map(), scrapLinksByRef: new Map(), searchCache: new Map(), supplierPartiesCache: null, totalEntries: 0, journalBytes: journalBytes || 2, indexBytes: 0 };
  for (const entry of state.journal) {
    ledger.seen.add(entry.id);
    if (entry.meta?.amendmentId) ledger.seen.add(`${entry.id}:undo`);
    indexEntry(ledger, entry, { measureBytes: !journalBytes });
  }
  return ledger;
}

export function hydrateLedger(events) {
  const ledger = { state: emptyState(), seen: new Set(), byDate: new Map(), byId: new Map(), orderById: new Map(), reversed: new Set(), saleReturnsByOriginal: new Map(), receiptLinks: new Map(), scrapLinksByRef: new Map(), searchCache: new Map(), supplierPartiesCache: null, totalEntries: 0, journalBytes: 2, indexBytes: 0 };
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
  if (['accountUpdate', 'stockUpdate', 'fundUpdate', 'supplierFirmUpdate'].includes(event.command?.type)) ledger.searchCache.clear();
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
  const cacheKey = `${ledger.state.journal.length}:${ledger.state.accounts.length}`;
  if (!ledger.supplierPartiesCache || ledger.supplierPartiesCache.key !== cacheKey) {
    ledger.supplierPartiesCache = { key: cacheKey, value: projectSupplierParties(ledger.state) };
  }
  const supplierParties = ledger.supplierPartiesCache.value;
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

const types = new Set(['all', 'linkScrapPurchase', 'customerOrder', 'orderUpdate', 'orderAdvance', 'orderRefund', 'orderCancel', 'scrapAdvanceTransfer', 'scrapAdvanceUndo', 'opening', 'nominalOpening', 'account', 'accountUpdate', 'fundAccount', 'fundUpdate', 'stockAccount', 'stockUpdate', 'sale', 'saleReturn', 'purchase', 'stock', 'movement', 'collection', 'transfer', 'currencyExchange', 'settlement', 'reverse', 'stocktake', 'close', 'registerItem', 'releaseItem', 'itemCostSource']);
const supplierEventTypes = ['supplierFirm','supplierFirmUpdate','supplierUnit','supplierOpening','supplierPurchase','supplierPayment','supplierAllocation','supplierOffset','supplierTransfer','supplierReturn','supplierReverse','supplierLegacyReceiptLink'];
export const typeGroups = {
  money: ['movement','transfer','currencyExchange','settlement'],
  inventory: ['stock','stocktake','registerItem','releaseItem','itemCostSource'],
  setup: ['opening','nominalOpening','account','accountUpdate','fundAccount','fundUpdate','stockAccount','stockUpdate','close'],
  supplier: [...supplierEventTypes],
  orders: ['customerOrder','orderUpdate','orderAdvance','orderRefund','orderCancel','scrapAdvanceTransfer','scrapAdvanceUndo'],
  reverse: ['reverse','supplierReverse']
};
for(const type of supplierEventTypes)types.add(type);
typeGroups.purchases=['purchase','supplierPurchase'];
// Match the existing browser journal's Turkish and accent-insensitive search.
export const normalizeSearch = value => value.toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i');
export function normalizeJournalOptions({ scope = 'today', q = '', type = 'all', limit = 50, cursor, startDate = '', endDate = '', accountId = '', unit = '', status = 'all', scrapForSale = '', scrapForAdvance = '' } = {}) {
  if (!['today', 'all'].includes(scope) || (!types.has(type) && !Object.hasOwn(typeGroups, type)) || typeof q !== 'string' || q.length > 160 || !Number.isInteger(limit) || limit < 1 || limit > 100 || (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 512))) fail('Geçerli defter filtresi ve 1–100 arası sayfa boyutu seçin.');
  if (typeof startDate !== 'string' || typeof endDate !== 'string' || typeof accountId !== 'string' || accountId.length > 160) fail('Geçerli tarih aralığı ve hesap seçin.');
  if (typeof unit !== 'string' || (unit && !/^(TL|HAS|SILVER|GRAM|ADET|[A-Z]{3})$/.test(unit))) fail('Geçerli birim filtresi seçin.');
  if (!['all', 'active', 'reversed'].includes(status)) fail('Geçerli kayıt durumu filtresi seçin.');
  if (typeof scrapForAdvance !== 'string' || scrapForAdvance.length > 100 || (scrapForAdvance && (scrapForSale || type !== 'purchase' || scope !== 'all'))) fail('Hurda avansı için müşteri ve tüm alışlar filtresi gerekli.');
  if (typeof scrapForSale !== 'string' || scrapForSale.length > 100 || (scrapForSale && (type !== 'purchase' || scope !== 'all'))) fail('Önceki hurda alışları için tüm geçmişte alış filtresini seçin.');
  if (startDate) validDate(startDate);
  if (endDate) validDate(endDate);
  if (startDate && endDate && startDate > endDate) fail('Başlangıç tarihi bitiş tarihinden sonra olamaz.');
  return { scope, q: normalizeSearch(q.trim()), type, limit, cursor, startDate, endDate, accountId, ...(unit && { unit }), ...(status !== 'all' && { status }), ...(scrapForSale && {scrapForSale}), ...(scrapForAdvance && {scrapForAdvance}) };
}

export function selectedAccountForState(state, accountId) {
  return getAccountIndex(state.accounts).byId.get(accountId) || fail('Hesap bulunamadı.');
}

function selectedAccount(ledger, accountId) {
  return selectedAccountForState(ledger.state, accountId);
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
  const visible = new Set(items.map(entry => entry.id)), related = new Set(visible), pending = [...visible];
  const expandScrap = id => {
    for (const entry of ledger.scrapLinksByRef.get(id) || []) {
      for (const ref of [entry.id, entry.meta.saleId, entry.meta.purchaseId]) {
        if (ref && ledger.byId.has(ref) && !related.has(ref)) {
          related.add(ref);
          pending.push(ref);
        }
      }
    }
  };
  for (const id of visible) expandScrap(id);
  for (let index = 0; index < pending.length; index++) {
    const cur = pending[index];
    for (const id of ledger.receiptLinks.get(cur) || []) {
      if (ledger.byId.has(id) && !related.has(id)) {
        related.add(id);
        pending.push(id);
        expandScrap(id);
      }
    }
  }
  const result = [];
  for (const id of related) {
    if (!visible.has(id)) result.push(ledger.byId.get(id));
  }
  return result.sort((a, b) => ledger.orderById.get(a.id) - ledger.orderById.get(b.id));
}

export function parseJournalCursor(cursor, revision, filterHash) {
  if (!cursor) return 0;
  let decoded;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!decoded || Object.keys(decoded).length !== 3 || !Number.isSafeInteger(decoded.revision) || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0 || typeof decoded.filterHash !== 'string') throw new Error();
  } catch { fail('Defter sayfa bilgisi geçersiz.'); }
  if (decoded.revision !== revision || decoded.filterHash !== filterHash) fail('Defter veya filtreler değişti. İlk sayfadan yeniden başlayın.', { status: 409, code: 'JOURNAL_CURSOR_STALE' });
  return decoded.offset;
}

export function journalFilterHash({ scope, q, type, limit, startDate = '', endDate = '', accountId = '', unit = '', status = 'all', scrapForSale = '', scrapForAdvance = '' }) {
  const range = { ...(startDate ? { startDate } : {}), ...(endDate ? { endDate } : {}), ...(accountId ? { accountId } : {}), ...(unit ? { unit } : {}), ...(status && status !== 'all' ? { status } : {}), ...(scrapForSale && {scrapForSale}), ...(scrapForAdvance && {scrapForAdvance}) };
  return createHash('sha256').update(JSON.stringify({ scope, q, type, limit, ...range })).digest('hex');
}

export function buildJournalReturnInfo(state, items, isReversedFn, returnsForSaleFn) {
  const retired = new Set(state.accounts.filter(account => account.retired).map(account => account.id));
  const returnInfo = new Map(items.filter(entry => entry.type === 'sale').map(entry => [entry.id, {
    eligible: !isReversedFn(entry.id),
    lines: (entry.meta.lines || []).map((line, lineIndex) => ({ line, lineIndex })).filter(({ line }) => !retired.has(line.accountId) && !retired.has(line.weightAccount)).map(({ line, lineIndex }) => ({ lineIndex, remainingQuantity: line.quantity, remainingWeight: line.weight || 0 }))
  }]));
  if (returnInfo.size) {
    // The visible sale page may exclude every return and every cancellation.
    // Derive availability from the full owned ledger without mutating its events.
    for (const [saleId, info] of returnInfo) {
      for (const event of returnsForSaleFn(saleId)) {
        if (isReversedFn(event.id)) continue;
        for (const line of event.meta.lines) {
          const remaining = info.lines.find(row => row.lineIndex === line.lineIndex);
          if (!remaining) continue;
          remaining.remainingQuantity -= line.quantity;
          remaining.remainingWeight -= line.weight;
        }
      }
      info.eligible = info.eligible && info.lines.some(line => line.remainingQuantity > 0);
    }
  }
  return returnInfo;
}

export function projectJournal(ledger, { scope, q, type, limit, cursor, startDate = '', endDate = '', accountId = '', unit = '', status = 'all', scrapForSale = '', scrapForAdvance = '' }) {
  const inheritParty = accountId ? selectedAccount(ledger, accountId).kind === 'receivable' : false;
  const revision = ledger.state.revision;
  // Preserve existing cursors when none of the new optional filters is selected.
  const filterHash = journalFilterHash({ scope, q, type, limit, startDate, endDate, accountId, unit, status, scrapForSale, scrapForAdvance });
  const offset = parseJournalCursor(cursor, revision, filterHash);
  const day = ledger.byDate.get(ledger.state.date) || blankTotals();
  let selected = scope === 'today' ? day.items : ledger.state.journal;
  const filtered = q || type !== 'all' || startDate || endDate || accountId || unit || (status && status !== 'all');
  const resolveParty = scrapCustomerResolver(ledger.state);
  const advanceChoices = scrapForAdvance ? scrapAdvanceSources(ledger.state,scrapForAdvance) : null;
  const scrapChoices = scrapForSale ? priorScrapChoices(ledger.state,scrapForSale,resolveParty) : advanceChoices;
  if (filtered) {
    const names = new Map(ledger.state.accounts.map(account => [account.id, account.name]));
    const unitAccountIds = unit ? new Set(ledger.state.accounts.filter(a => a.unit === unit).map(a => a.id)) : null;
    const searchCache = ledger.searchCache;
    selected = selected.filter(entry => {
      if (scrapChoices && !scrapChoices.has(entry.id)) return false;
      if ((startDate && entry.date < startDate) || (endDate && entry.date > endDate) || (accountId && !matchesJournalAccount(ledger, entry, accountId, inheritParty, resolveParty))) return false;
      if (type !== 'all' && !(typeGroups[type] || [type]).includes(entry.type)) return false;
      if (unitAccountIds && !entry.entries.some(row => unitAccountIds.has(row.accountId))) return false;
      if (status === 'active' && (['reverse', 'supplierReverse'].includes(entry.type) || ledger.reversed.has(entry.id))) return false;
      if (status === 'reversed' && !['reverse', 'supplierReverse'].includes(entry.type) && !ledger.reversed.has(entry.id)) return false;
      if (!q) return true;
      let text = searchCache.get(entry.id);
      if (text === undefined) {
        text = entrySearchText(entry, names);
        searchCache.set(entry.id, text);
      }
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
  const returnInfo = buildJournalReturnInfo(ledger.state, items, id => ledger.reversed.has(id), id => ledger.saleReturnsByOriginal.get(id) || []);
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

export function computeAccountStatement(revision, account, events, { startDate, endDate }) {
  let opening = 0, incoming = 0, outgoing = 0, lastPhysicalCount = null;
  for (const event of events) {
    if (endDate && event.date > endDate) continue;
    for (const row of event.entries) {
      if (row.accountId !== account.id) continue;
      if (startDate && event.date < startDate) opening += row.delta;
      else if (row.delta >= 0) incoming += row.delta;
      else outgoing -= row.delta;
      if (![opening, incoming, outgoing].every(Number.isSafeInteger)) fail('Ekstre toplamı güvenli miktar sınırını aşıyor. Daha kısa bir tarih aralığı seçin.');
    }
    // Carried periodic gram balances are not physical measurements. Read actual
    // count rows, including zero-difference counts with no journal entry leg.
    if (account.physical && ['close', 'stocktake'].includes(event.type)) {
      const count = event.meta.counts?.find(row => row.accountId === account.id && Number.isSafeInteger(row.counted));
      if (count) lastPhysicalCount = { eventId: event.id, date: event.date, type: event.type, unit: account.unit, counted: count.counted, expected: count.expected, difference: count.difference };
    }
  }
  const closing = Number(BigInt(opening) + BigInt(incoming) - BigInt(outgoing));
  if (!Number.isSafeInteger(closing)) fail('Ekstre bakiyesi güvenli miktar sınırını aşıyor.');
  return structuredClone({ revision, account, startDate, endDate, opening, incoming, outgoing, closing, lastPhysicalCount });
}

export function projectAccountStatement(ledger, { accountId, startDate, endDate }) {
  if (!accountId) fail('Ekstre için hesap seçin.');
  const account = selectedAccount(ledger, accountId);
  return computeAccountStatement(ledger.state.revision, account, ledger.state.journal, { startDate, endDate });
}

export function entrySearchText(entry, accountNames) {
  return normalizeSearch([
    entry.label, entry.date, entry.id, entry.meta.note, entry.meta.productCategory,
    accountNames.get(entry.meta.counterpartyId),
    ...entry.entries.map(row => accountNames.get(row.accountId) || '')
  ].filter(Boolean).join(' '));
}

export function entryLinkIds(entry) {
  const ids = [
    entry.meta.originalId, entry.meta.amendsOriginalId, entry.meta.amendmentId, entry.meta.exchangeId,
    ...(['scrapAdvanceTransfer', 'scrapAdvanceUndo'].includes(entry.type) ? [entry.meta.purchaseId] : []),
    entry.meta.orderId, entry.meta.advanceId,
    ...(entry.meta.advanceAllocations || []).map(row => row.advanceId),
    ...(entry.meta.allocations || []).flatMap(row => [row.sourceId, row.purchaseId]),
    ...(entry.meta.sourceUses || []).map(row => row.sourceId),
    ...(entry.meta.debtUses || []).map(row => row.sourceId),
    ...(entry.meta.uses || []).map(row => row.sourceId)
  ];
  if (entry.type === 'linkScrapPurchase') ids.push(entry.meta.saleId, entry.meta.purchaseId);
  return ids.filter(id => id && id !== entry.id);
}

export function buildHotScrapResolver(state, accountCreatedSeq, seqById) {
  const accountById = getAccountIndex(state.accounts).byId;
  return entry => {
    if (!entry || !['sale', 'purchase'].includes(entry.type) || entry.meta.counterpartyType === 'supplier' ||
        (entry.type === 'purchase' && entry.meta.source !== 'customer')) return null;
    const command = entry.editableCommand || {};
    const classic = !entry.meta.receivedLines && !command.payments && !command.credits && !command.debts;
    const named = classic ? command[entry.type === 'sale' ? 'customerAccount' : 'counterpartyAccount'] : null;
    const ids = new Set([entry.meta.counterpartyId, named].filter(Boolean));
    let hasLeg = false;
    for (const row of entry.entries) {
      if (row.delta && accountById.get(row.accountId)?.kind === 'receivable') { ids.add(row.accountId); hasLeg = true; }
    }
    if (ids.size !== 1) return null;
    const [id] = ids, party = accountById.get(id);
    if (!party || party.kind !== 'receivable' || party.partyType === 'supplier') return null;
    if (!party.partyType && !named && entry.meta.source !== 'customer' && entry.meta.counterpartyType !== 'customer') return null;
    if (named && !hasLeg && !entry.meta.counterpartyId) {
      const openedSeq = accountCreatedSeq.get(id), entrySeq = seqById.get(entry.id);
      if (!(openedSeq < entrySeq)) return null;
    }
    return id;
  };
}

export function entryAccountMatches(entry, seq, state, byIdLookup, accountCreatedSeq) {
  const accountById = getAccountIndex(state.accounts).byId;
  const directIds = new Set([entry.meta?.counterpartyId, ...entry.entries.map(row => row.accountId)].filter(Boolean));
  const inheritedIds = new Set();
  const resolveParty = buildHotScrapResolver(state, accountCreatedSeq, { get: id => id === entry.id ? seq : byIdLookup(id)?.seq });
  let cur = entry, curSeq = seq;
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur !== entry) {
      if (cur.meta?.counterpartyId && accountById.get(cur.meta.counterpartyId)?.kind === 'receivable') inheritedIds.add(cur.meta.counterpartyId);
      for (const row of cur.entries) {
        if (accountById.get(row.accountId)?.kind === 'receivable') inheritedIds.add(row.accountId);
      }
    }
    const p = resolveParty(cur);
    if (p) inheritedIds.add(p);
    if (['saleReturn', 'reverse'].includes(cur.type) && cur.meta?.originalId) {
      const found = byIdLookup(cur.meta.originalId);
      cur = found?.entry || found || null;
      curSeq = found?.seq ?? curSeq;
    } else {
      cur = null;
    }
  }
  for (const id of directIds) inheritedIds.delete(id);
  return { directIds: [...directIds], inheritedIds: [...inheritedIds] };
}

function buildSupplierOwners(state) {
  const firms = supplierFirms(state);
  const firmIds = new Set(firms.map(f => f.id));
  const owners = new Map();
  for (const firm of firms) {
    for (const accId of supplierAccountIds(state, firm.id)) owners.set(accId, firm.id);
  }
  return { firms, firmIds, owners };
}

function resolveEntrySupplierOwners(entry, firmIds, owners, byIdLookup, visited = new Set()) {
  if (!entry || visited.has(entry.id)) return new Set();
  visited.add(entry.id);
  const ids = new Set([entry.meta?.supplierId, entry.meta?.counterpartyId, ...entry.entries.map(row => owners.get(row.accountId))].filter(id => firmIds.has(id)));
  if (['reverse', 'supplierReverse', 'supplierReturn', 'supplierAmend'].includes(entry.type) && entry.meta?.originalId) {
    const orig = byIdLookup(entry.meta.originalId);
    for (const id of resolveEntrySupplierOwners(orig?.entry || orig, firmIds, owners, byIdLookup, visited)) ids.add(id);
  }
  return ids;
}

function projectHotSupplierParties(hot) {
  const firms = supplierFirms(hot.state);
  const availableUnits = ledgerActiveSupplierUnits(hot.state);
  return firms.map(firm => {
    const ids = new Set(supplierAccountIds(hot.state, firm.id));
    const accounts = hot.state.accounts.filter(a => ids.has(a.id)).map(a => ({ id: a.id, name: a.name, unit: a.unit, balance: hot.state.balances[a.id] || 0 }));
    const lastEvent = hot.supplierLastEvents.get(firm.id);
    const givenScrapBalances = hot.supplierGivenScrap?.get(firm.id) || {};
    return { ...firm, accounts, availableUnits, givenScrapBalances, ...(lastEvent && { lastEvent }) };
  });
}

function computeHotIndexBytes(hot) {
  return (hot.accountCreatedDates.size + hot.accountCreatedSeq.size) * 96
    + hot.supplierLastEvents.size * 128
    + hot.inventoryPurchaseEntries.size * 512;
}

export function extractHotState(ledger) {
  const { journal, ...rest } = ledger.state;
  const day = ledger.byDate.get(ledger.state.date) || blankTotals();
  const supplierLastEvents = new Map();
  const supplierGivenScrap = new Map();
  for (const party of projectSupplierParties(ledger.state)) {
    if (party.lastEvent) supplierLastEvents.set(party.id, party.lastEvent);
    if (party.givenScrapBalances && Object.keys(party.givenScrapBalances).length) supplierGivenScrap.set(party.id, party.givenScrapBalances);
  }
  const inventoryPurchaseEntries = new Map();
  for (const item of ledger.state.inventoryItems || []) {
    const id = item.purchaseLine?.id;
    if (id && !ledger.reversed.has(id)) {
      const p = ledger.byId.get(id);
      if (p) inventoryPurchaseEntries.set(id, p);
    }
  }
  const accountCreatedDates = new Map(), accountCreatedSeq = new Map();
  for (let i = 0; i < journal.length; i++) {
    const e = journal[i];
    if (['account', 'fundAccount', 'stockAccount', 'supplierUnit'].includes(e.type) && e.meta?.accountId) {
      accountCreatedDates.set(e.meta.accountId, e.date);
      if (e.type === 'account') accountCreatedSeq.set(e.meta.accountId, i + 1);
    }
  }
  const hot = {
    state: { ...rest, journal: journal.slice(-4) },
    journalMeta: { total: journal.length, totalEntries: ledger.totalEntries },
    openingDate: journal[0]?.date || null,
    today: {
      date: ledger.state.date,
      todaysCount: day.todaysCount,
      revenue: day.revenue,
      expenses: day.expenses,
      salesCash: day.salesCash,
      flowByUnit: structuredClone(day.flowByUnit)
    },
    supplierLastEvents,
    supplierGivenScrap,
    inventoryPurchaseEntries,
    accountCreatedDates,
    accountCreatedSeq,
    indexBytes: 0
  };
  hot.indexBytes = computeHotIndexBytes(hot);
  return hot;
}

export function applyHotState(hot, nextState, newEntries, lookupById, startSeq) {
  const nextFlowByUnit = {};
  const resetToday = nextState.date !== hot.today.date;
  if (!resetToday) {
    for (const [u, f] of Object.entries(hot.today.flowByUnit)) nextFlowByUnit[u] = { incoming: f.incoming, outgoing: f.outgoing };
  }
  const nextToday = resetToday
    ? { date: nextState.date, todaysCount: 0, revenue: 0, expenses: 0, salesCash: 0, flowByUnit: {} }
    : { ...hot.today, flowByUnit: nextFlowByUnit };
  const resolvedById = id => {
    for (const e of newEntries) if (e.id === id) return e;
    const found = lookupById(id);
    return found?.entry || found;
  };
  let supplierLastEvents = hot.supplierLastEvents;
  let supplierGivenScrap = hot.supplierGivenScrap || new Map();
  let inventoryPurchaseEntries = hot.inventoryPurchaseEntries;
  let accountCreatedDates = hot.accountCreatedDates;
  let accountCreatedSeq = hot.accountCreatedSeq;
  const { firmIds, owners } = buildSupplierOwners(nextState);
  let totalEntriesAdded = 0;
  const promoted = new Set();
  for (let i = 0; i < newEntries.length; i++) {
    const entry = newEntries[i];
    totalEntriesAdded += entry.entries.length;
    if (entry.date === nextToday.date) {
      nextToday.todaysCount++;
      nextToday.revenue += entry.meta.revenue || 0;
      nextToday.expenses += entry.meta.expense || 0;
      if (['sale', 'saleReturn'].includes(entry.type) || (entry.type === 'reverse' && ['sale', 'saleReturn'].includes(resolvedById(entry.meta.originalId)?.type))) {
        for (const row of entry.entries) if (row.accountId === 'nakit') nextToday.salesCash += row.delta;
      }
      indexMoneyFlow(nextState.accounts, resolvedById, nextToday, entry);
    }
    if (['account', 'fundAccount', 'stockAccount', 'supplierUnit'].includes(entry.type) && entry.meta?.accountId) {
      if (accountCreatedDates === hot.accountCreatedDates) accountCreatedDates = new Map(hot.accountCreatedDates);
      accountCreatedDates.set(entry.meta.accountId, entry.date);
      if (entry.type === 'account') {
        if (accountCreatedSeq === hot.accountCreatedSeq) accountCreatedSeq = new Map(hot.accountCreatedSeq);
        accountCreatedSeq.set(entry.meta.accountId, startSeq + i);
      }
    }
    if (entry.type === 'registerItem') {
      const addedItem = nextState.inventoryItems?.at(-1);
      const pId = addedItem?.purchaseLine?.id;
      if (pId) {
        const pEntry = resolvedById(pId);
        if (pEntry) {
          if (inventoryPurchaseEntries === hot.inventoryPurchaseEntries) inventoryPurchaseEntries = new Map(hot.inventoryPurchaseEntries);
          inventoryPurchaseEntries.set(pId, pEntry);
        }
      }
    } else if (['reverse', 'supplierReverse'].includes(entry.type) && inventoryPurchaseEntries.has(entry.meta.originalId)) {
      if (inventoryPurchaseEntries === hot.inventoryPurchaseEntries) inventoryPurchaseEntries = new Map(hot.inventoryPurchaseEntries);
      inventoryPurchaseEntries.delete(entry.meta.originalId);
    }
    if (entry.type === 'accountUpdate' && entry.meta?.accountId) {
      const aid = entry.meta.accountId;
      if (firmIds.has(aid) && !supplierLastEvents.has(aid)) promoted.add(aid);
      else if (!firmIds.has(aid) && supplierLastEvents.has(aid)) {
        if (supplierLastEvents === hot.supplierLastEvents) supplierLastEvents = new Map(hot.supplierLastEvents);
        supplierLastEvents.delete(aid);
      }
    }
    const supOwners = resolveEntrySupplierOwners(entry, firmIds, owners, resolvedById);
    if (supOwners.size) {
      if (supplierLastEvents === hot.supplierLastEvents) supplierLastEvents = new Map(hot.supplierLastEvents);
      const last = { id: entry.id, date: entry.date, label: entry.label };
      for (const sid of supOwners) supplierLastEvents.set(sid, last);
    }
  }
  if (promoted.size && nextState.journal.length) {
    const journalById = new Map(nextState.journal.map(e => [e.id, e]));
    const jLookup = id => journalById.get(id);
    const promotedOwners = new Map([...owners].filter(([, fid]) => promoted.has(fid)));
    for (const entry of nextState.journal) {
      const supOwners = resolveEntrySupplierOwners(entry, promoted, promotedOwners, jLookup);
      if (supOwners.size) {
        if (supplierLastEvents === hot.supplierLastEvents) supplierLastEvents = new Map(hot.supplierLastEvents);
        const last = { id: entry.id, date: entry.date, label: entry.label };
        for (const sid of supOwners) supplierLastEvents.set(sid, last);
      }
    }
  }
  const { journal: _j, ...restState } = nextState;
  const nextHot = {
    state: { ...restState, journal: [...hot.state.journal, ...newEntries].slice(-4) },
    journalMeta: { total: hot.journalMeta.total + newEntries.length, totalEntries: hot.journalMeta.totalEntries + totalEntriesAdded },
    openingDate: hot.openingDate || newEntries[0]?.date || null,
    today: nextToday,
    supplierLastEvents,
    supplierGivenScrap,
    inventoryPurchaseEntries,
    accountCreatedDates,
    accountCreatedSeq,
    indexBytes: 0
  };
  nextHot.indexBytes = computeHotIndexBytes(nextHot);
  return nextHot;
}

export function estimateHotBytes(hot) {
  const { journal, ...base } = hot.state;
  return Buffer.byteLength(JSON.stringify(base)) + Buffer.byteLength(JSON.stringify(journal)) + hot.indexBytes;
}

export function serializeHotSnapshot(hot) {
  return {
    kind: 'hot-v1',
    state: hot.state,
    journalMeta: hot.journalMeta,
    openingDate: hot.openingDate,
    today: hot.today,
    supplierLastEvents: [...hot.supplierLastEvents.entries()],
    supplierGivenScrap: [...(hot.supplierGivenScrap || new Map()).entries()],
    inventoryPurchaseEntries: [...hot.inventoryPurchaseEntries.entries()],
    accountCreatedDates: [...hot.accountCreatedDates.entries()],
    accountCreatedSeq: [...hot.accountCreatedSeq.entries()],
    indexBytes: hot.indexBytes
  };
}

export function restoreHotSnapshot(parsed) {
  return {
    state: parsed.state,
    journalMeta: parsed.journalMeta,
    openingDate: parsed.openingDate ?? null,
    today: parsed.today,
    supplierLastEvents: new Map(parsed.supplierLastEvents || []),
    supplierGivenScrap: new Map(parsed.supplierGivenScrap || []),
    inventoryPurchaseEntries: new Map(parsed.inventoryPurchaseEntries || []),
    accountCreatedDates: new Map(parsed.accountCreatedDates || []),
    accountCreatedSeq: new Map(parsed.accountCreatedSeq || []),
    indexBytes: parsed.indexBytes || 0
  };
}

export function projectHotLedger(hot, compact = true, fullJournal = null) {
  const accounts = hot.state.accounts.map(a => a.countPolicy ? { ...a, countPolicy: currentCountPolicy(a) } : a);
  const day = hot.today;
  const moneyFlow = { incoming: day.flowByUnit.TL?.incoming || 0, outgoing: day.flowByUnit.TL?.outgoing || 0, byUnit: day.flowByUnit };
  const supplierParties = projectHotSupplierParties(hot);
  if (!compact) {
    return structuredClone({ ...hot.state, journal: fullJournal || hot.state.journal, accounts, moneyFlow, supplierParties });
  }
  const inventoryItems = hot.state.inventoryItems?.map(item => {
    const id = item.purchaseLine?.id;
    const offer = id && purchaseCostOffer(item, hot.inventoryPurchaseEntries.get(id));
    return offer ? { ...item, purchaseCostOffer: offer } : item;
  });
  return structuredClone({
    ...hot.state,
    accounts,
    moneyFlow,
    supplierParties,
    view: 'compact',
    journal: hot.state.journal,
    ...(inventoryItems && { inventoryItems }),
    overview: { todaysCount: day.todaysCount, revenue: day.revenue, expenses: day.expenses, salesCash: day.salesCash, closingCount: hot.state.closings.length },
    journalMeta: hot.journalMeta
  });
}
