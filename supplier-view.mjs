import { fail, validDate, supplierAmendmentPreview } from './domain.mjs';
import { supplierFirms, resolveSupplierFirm, supplierAccountIds, supplierDocuments } from './supplier-ledger.mjs';

function belongs(entry, id, accounts, byId, visited = new Set()) {
  if (!entry || visited.has(entry.id)) return false;
  visited.add(entry.id);
  if (entry.meta?.supplierId === id || entry.meta?.counterpartyId === id || entry.entries.some(row => accounts.has(row.accountId))) return true;
  return ['reverse', 'supplierReverse', 'supplierReturn', 'supplierAmend'].includes(entry.type)
    && belongs(byId.get(entry.meta?.originalId), id, accounts, byId, visited);
}

function accountRows(state, id) {
  const ids = new Set(supplierAccountIds(state, id));
  return state.accounts.filter(a => ids.has(a.id)).map(a => ({id:a.id, name:a.name, unit:a.unit, balance:state.balances[a.id] || 0}));
}

export function projectSupplierParties(state) {
  const parties = supplierFirms(state).map(firm => ({...firm, accounts:accountRows(state,firm.id)}));
  const byFirm = new Map(parties.map(firm=>[firm.id,firm]));
  const owners = new Map(parties.flatMap(firm=>firm.accounts.map(a=>[a.id,firm.id])));
  const eventOwners = new Map();
  for (const entry of state.journal) {
    const ids = new Set([entry.meta?.supplierId,entry.meta?.counterpartyId,...entry.entries.map(row=>owners.get(row.accountId))].filter(id=>byFirm.has(id)));
    if (['reverse','supplierReverse','supplierReturn','supplierAmend'].includes(entry.type)) {
      for (const id of eventOwners.get(entry.meta?.originalId)||[]) ids.add(id);
    }
    eventOwners.set(entry.id,ids);
    for (const id of ids) byFirm.get(id).lastEvent={id:entry.id,date:entry.date,label:entry.label};
  }
  return parties;
}

export function projectSupplierDetail(state, {supplierId, startDate='', endDate='', limit=50, cursor, editOriginalId, includeDocuments=true} = {}) {
  if (typeof includeDocuments !== 'boolean') fail('Geçerli belge görünümü seçin.');
  if (typeof supplierId !== 'string' || !supplierId || supplierId.length > 160) fail('Firma seçin.');
  const supplier = resolveSupplierFirm(state, supplierId);
  if (typeof startDate !== 'string' || typeof endDate !== 'string') fail('Geçerli dönem seçin.');
  if (startDate) validDate(startDate);
  if (endDate) validDate(endDate);
  if (startDate && endDate && startDate > endDate) fail('Başlangıç tarihi bitiş tarihinden sonra olamaz.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('Sayfa boyutu 1–100 arasında olmalı.');
  let offset = 0;
  const scope = JSON.stringify([supplierId,startDate,endDate,limit,editOriginalId,includeDocuments]);
  if (cursor !== undefined) {
    if (typeof cursor !== 'string' || cursor.length > 1200) fail('Geçersiz devam anahtarı.');
    let decoded;
    try { decoded = JSON.parse(Buffer.from(cursor,'base64url').toString('utf8')); }
    catch { fail('Geçersiz devam anahtarı.'); }
    if (decoded.revision !== state.revision) fail('Defter değişti. Geçmişi yeniden açın.',{status:409,code:'REVISION_CONFLICT'});
    if (decoded.scope !== scope || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0) fail('Devam anahtarı seçilen döneme ait değil.');
    offset = decoded.offset;
  }
  const accounts = accountRows(state,supplierId), ids = new Set(accounts.map(a=>a.id));
  const byId = new Map(state.journal.map(e=>[e.id,e]));
  const relations = new Map(), reversed = new Set(), amended = new Set();
  for (const entry of state.journal) {
    for(const originalId of new Set([entry.meta?.originalId,entry.meta?.amendsOriginalId].filter(Boolean))) {
      const related=relations.get(originalId)||[];
      related.push(entry.id); relations.set(originalId,related);
    }
    if (['reverse','supplierReverse'].includes(entry.type)) reversed.add(entry.meta.originalId);
    if(entry.meta?.amendsOriginalId) amended.add(entry.meta.amendsOriginalId);
  }
  const statements = accounts.map(a=>({accountId:a.id,unit:a.unit,opening:0,debtIncrease:0,debtDecrease:0,creditIncrease:0,creditDecrease:0,closing:0}));
  const totals = new Map(statements.map(row=>[row.accountId,row]));
  const balances = new Map(accounts.map(a=>[a.id,0]));
  const events = [];
  for (const entry of state.journal) {
    const changes = new Map();
    for (const row of entry.entries) if (ids.has(row.accountId)) changes.set(row.accountId,(changes.get(row.accountId)||0)+row.delta);
    const effects = [];
    for (const [accountId,delta] of changes) {
      const before=balances.get(accountId), after=before+delta, total=totals.get(accountId);
      balances.set(accountId,after);
      effects.push({accountId,unit:total.unit,before,delta,after});
      if (startDate && entry.date < startDate) total.opening += delta;
      else if (!endDate || entry.date <= endDate) {
        total.debtIncrease += Math.max(0,Math.max(-after,0)-Math.max(-before,0));
        total.debtDecrease += Math.max(0,Math.max(-before,0)-Math.max(-after,0));
        total.creditIncrease += Math.max(0,Math.max(after,0)-Math.max(before,0));
        total.creditDecrease += Math.max(0,Math.max(before,0)-Math.max(after,0));
      }
    }
    if ((!startDate || entry.date >= startDate) && (!endDate || entry.date <= endDate) && belongs(entry,supplierId,ids,byId)) {
      events.push({...entry, balances:effects, status:amended.has(entry.id)?'amended':reversed.has(entry.id)?'reversed':'active', relatedEventIds:relations.get(entry.id)||[]});
    }
  }
  for (const total of statements) total.closing=total.opening-total.debtIncrease+total.debtDecrease+total.creditIncrease-total.creditDecrease;
  events.reverse();
  const next = offset + limit;
  let amendment;
  if(editOriginalId!==undefined) {
    if(state.journal.find(entry=>entry.id===editOriginalId)?.meta.supplierId!==supplierId) fail('Düzeltilecek kayıt seçilen firmaya ait değil.');
    const preview=supplierAmendmentPreview(state,editOriginalId);
    amendment={originalId:editOriginalId,documents:supplierDocuments(preview,supplierId),balances:preview.balances};
  }
  const created = new Map(state.journal.filter(entry=>['account','supplierUnit'].includes(entry.type) && entry.meta?.accountId).map(entry=>[entry.meta.accountId,entry.date]));
  const periodStatements = endDate ? statements.filter(row=>!created.has(row.accountId) || created.get(row.accountId)<=endDate) : statements;
  return structuredClone({revision:state.revision, supplier, accounts, startDate,endDate, statements:periodStatements, ...(includeDocuments&&{documents:supplierDocuments(state,supplierId)}),
    ...(amendment&&{amendment}),
    events:events.slice(offset,next),total:events.length,
    ...(next < events.length && {nextCursor:Buffer.from(JSON.stringify({revision:state.revision,scope,offset:next})).toString('base64url')})});
}
