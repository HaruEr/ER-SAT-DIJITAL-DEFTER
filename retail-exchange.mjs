import { applyEvent, classicCashCustomer, fail, quantity, text } from './domain.mjs';

export const exchangeUndo = Symbol('undo both exchange legs');

function total(lines, canBeZero) {
  if (!Array.isArray(lines) || !lines.length || lines.length > 30) fail('Değişimde geri gelen ve verilen ürünleri seçin.');
  const sum = lines.reduce((value, line) => value + quantity(line?.value, 'TL', { zero: canBeZero }), 0);
  if (!Number.isSafeInteger(sum) || sum > 1e12) fail('Değişim tutarı sınırı aşıyor.');
  return sum;
}

// Each leg uses the normal stock, price and remaining-return validations. The
// agreed amount applied between legs is never posted to cash or a party account.
export function applyExchange(state, event, seen) {
  const c = event.command, undo = c.type === 'undoExchange';
  const allowed = undo ? ['type','date','originalId','note'] : ['type','date','originalId','note','returnItems','newItems','received','refunds'];
  if (event.schemaVersion === 14) allowed.push('customerConsideration');
  if (Object.keys(c).some(key => !allowed.includes(key))) fail('Değişim alanlarını kontrol edin.');
  text(event.id, 'Değişim numarası', 88);
  const note = text(c.note, 'Değişim açıklaması');
  const firstId = event.id + ':return';
  const original = state.journal.find(row => row.id === c.originalId);
  if (!original || original.type !== 'sale' || original.meta.counterpartyType === 'supplier') fail('Özgün müşteri satışını seçin.');
  const child = (id, schemaVersion, command) => ({ ...event, id, schemaVersion, command: { ...command, date: c.date, note } });
  let result;
  if (undo) {
    if (original.meta.exchangeId !== original.id) fail('Geri alınacak değişimi seçin.');
    const removeSale = child(firstId, 3, { type: 'reverse', originalId: original.id });
    result = applyEvent(state, removeSale, undefined, exchangeUndo);
    result = applyEvent(result, child(event.id, 3, { type: 'reverse', originalId: original.id + ':return' }), undefined, exchangeUndo);
  } else {
    const returned = total(c.returnItems, true), issued = total(c.newItems, false);
    if (!Array.isArray(c.received) || !Array.isArray(c.refunds) ||
        (returned >= issued && c.received.length) || (issued >= returned && c.refunds.length)) fail('Yalnız değişimdeki gerçek farkı tahsil edin veya ödeyin.');
    const offset = Math.min(returned, issued);
    const hasCari = event.schemaVersion === 14;
    if (hasCari && returned <= issued) fail('Cari iade karşılığı için müşteriye ödenecek değişim farkı gerekli.');
    if (hasCari && c.refunds.some(row => {
      const target = state.accounts.find(a => a.id === row?.accountId);
      return !target || target.kind !== 'asset' || ['GRAM','ADET'].includes(target.unit);
    })) fail('Değişimde yeni ürünleri teslim satırına, kalan fiilî para çıkışını ödeme hesabına yazın.');
    const refund = child(firstId, hasCari ? 14 : 4, { type: 'saleReturn', originalId: original.id, items: c.returnItems,
      ...(hasCari ? { outgoing:c.refunds, customerConsideration:c.customerConsideration } : { refunds:c.refunds }) });
    result = applyEvent(state, refund, undefined, undefined, offset);
    const parties = new Set(original.entries.map(row => row.accountId).filter(id => state.accounts.some(a => a.id === id && a.kind === 'receivable')));
    const party = original.meta.counterpartyId || (parties.size === 1 ? [...parties][0] : '') ||
      (hasCari ? result.journal.at(-1).meta.counterpartyId : event.schemaVersion === 15 ? classicCashCustomer(state, original) : '');
    if (parties.size > 1 && !original.meta.counterpartyId) fail('Birden fazla carili satışta değişim müşterisi belirsiz.');
    for (const row of c.received) {
      const fund = state.accounts.find(a => a.id === row?.accountId);
      if (!fund || ['ADET','GRAM'].includes(fund.unit)) fail('Değişim farkının tahsil edildiği ödeme hesabını seçin.');
    }
    const sale = child(event.id, c.newItems.some(row => Object.hasOwn(row,'inventoryCode')) ? 8 : 6, {
      type: 'sale', items: c.newItems, received: c.received, given: [], credits: [], debts: [], counterpartyId: party, counterpartyType: 'customer'
    });
    result = applyEvent(result, sale, undefined, undefined, offset);
    const [returnLeg, saleLeg] = result.journal.slice(-2);
    const returnedCodes = new Set(returnLeg.meta.lines.map(line => line.inventoryCode).filter(Boolean));
    if (saleLeg.meta.lines.some(line => returnedCodes.has(line.inventoryCode))) {
      fail('Değişimde geri alınan tekil ürün yeni ürün olarak tekrar verilemez.');
    }
    for (const leg of [returnLeg, saleLeg]) {
      leg.meta.exchangeId = event.id;
      leg.meta.exchangeAppliedTL = offset;
    }
  }
  if (!seen) return result;
  Object.assign(state, result);
  seen.add(firstId);
  seen.add(event.id);
  return state;
}
