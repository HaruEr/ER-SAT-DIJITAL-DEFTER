import { applyInventory, checkReserved, usesInventory } from './inventory.mjs';
import { isSupplierCommand, prepareSupplier, assertSupplierUndoAllowed, supplierFirms, supplierAccountIds } from './supplier-ledger.mjs';
import { applyExchange, exchangeUndo } from './retail-exchange.mjs';

import { hasSalePricing, underlyingSaleCommand, salePriceSnapshot } from './sale-pricing.mjs';
// All quantities are integers: kurus, milligrams, or pieces. Never add unlike units.
export const UNITS = { TL: { scale: 100, digits: 2 }, USD: { scale: 100, digits: 2 }, EUR: { scale: 100, digits: 2 }, GRAM: { scale: 1000, digits: 3 }, HAS: { scale: 1000, digits: 3 }, SILVER: { scale: 1000, digits: 3 }, ADET: { scale: 1, digits: 0 } };
export const INITIAL_ACCOUNTS = [
  ['nakit', 'Nakit TL', 'TL', true], ['usd', 'Nakit USD', 'USD', true], ['eur', 'Nakit EUR', 'EUR', true],
  ['bilezik22', 'Bilezik — ana terazi', 'GRAM', true], ['taki14', '14 ayar takı — ana terazi', 'GRAM', true], ['taki22', '22 ayar takı — ana terazi', 'GRAM', true],
  ['hurda22', '22 ayar hurda (ayrı havuz)', 'GRAM', true],
  ['ceyrek', 'Ziynet çeyrek', 'ADET', true], ['yarim', 'Ziynet yarım', 'ADET', true], ['ziynet', 'Ziynet birlik', 'ADET', true],
  ['cumhuriyet', 'Cumhuriyet sikke', 'ADET', true], ['resat', 'Reşat', 'ADET', true], ['gramaltin', 'Gram altın', 'GRAM', true], ['saat', 'Saat', 'ADET', true],
  ['pos', 'Tahsil edilmemiş POS', 'TL', false], ['banka', 'Banka TL', 'TL', false]
].map(([id, name, unit, physical]) => ({ id, name, unit, physical, isSaleable: physical && unit === 'ADET', pairedGroups: [], countGroup: ['bilezik22', 'taki14', 'taki22'].includes(id) ? 'ana-terazi' : id === 'gramaltin' ? 'gram-havuzu' : 'gunluk', kind: 'asset', owner: 'işletme', location: physical ? 'dükkân' : 'finansal hesap' })).concat([
  ['bilezikAdet', 'Bilezik (günlük adet)', ['bilezik22']], ['gramAdet', 'Gram altın (günlük adet)', ['gramaltin']],
  ['yuzuk', 'Yüzük', ['taki14', 'taki22']], ['kupe', 'Küpe', ['taki14', 'taki22']], ['kolye', 'Kolye', ['taki14', 'taki22']],
  ['kunye', 'Künye', ['taki14', 'taki22']], ['sahmeran', 'Şahmeran', ['taki14', 'taki22']], ['digerTaki', 'Diğer takı', ['taki14', 'taki22']]
].map(([id, name, pairedGroups]) => ({ id, name, unit: 'ADET', physical: true, isSaleable: true, pairedGroups, introduced: 2, countGroup: 'gunluk', kind: 'asset', owner: 'işletme', location: 'dükkân' })));
export const JEWELRY_CATEGORIES = ['Yüzük', 'Küpe', 'Kolye', 'Künye', 'Şahmeran', 'Diğer'];
// Old package/weight accounts remain readable, but are not converted into nominal grams.
for (const a of INITIAL_ACCOUNTS) {
  a.retired = ['gramAdet', 'gramaltin'].includes(a.id);
  a.countPolicy = !a.physical ? 'none' : a.unit === 'GRAM' ? 'periodic' : 'daily';
}
INITIAL_ACCOUNTS.push({ id: 'gramToplam', name: 'Gram altın — toplam gram', unit: 'GRAM', physical: true, isSaleable: true, pairedGroups: [], introduced: 3, countGroup: 'gunluk', countPolicy: 'daily', nominal: true, retired: false, kind: 'asset', owner: 'işletme', location: 'dükkân' });
for (const a of INITIAL_ACCOUNTS) a.isPurchasable = !a.retired && (a.isSaleable || a.id === 'hurda22');
// Account identifiers remain stable; display names can evolve without moving balances.
const stockNames = { bilezikAdet: 'BİLEZİK ADET', ceyrek: 'ÇEYREK', yarim: 'YARIM', ziynet: 'ZİYNET', cumhuriyet: 'ATA', resat: 'REŞAT', gramToplam: 'GRAM ALTIN', yuzuk: 'YÜZÜK', kupe: 'KÜPE', kolye: 'KOLYE', kunye: 'KÜNYE', sahmeran: 'ŞAHMERAN', digerTaki: 'DİĞER ÜRÜN', taki14: '14 AYAR TAKI', taki22: '22 AYAR TAKI', hurda22: '22 AYAR HURDA', bilezik22: 'BİLEZİK TERAZİ', saat: 'SAAT' };
for (const a of INITIAL_ACCOUNTS) { if (stockNames[a.id]) a.name = stockNames[a.id]; if (a.id === 'hurda22') a.scrap = true; }
for (const purity of [21, 18, 14, 8, 24]) INITIAL_ACCOUNTS.push({ id: `hurda${purity}`, name: purity === 24 ? '24 AYAR HAS' : `${purity} AYAR HURDA`, unit: 'GRAM', physical: true, kind: 'asset', retired: false, isSaleable: false, isPurchasable: true, scrap: true, pairedGroups: [], introduced: 5, countGroup: 'hurda', countPolicy: 'periodic', owner: 'işletme', location: 'dükkân' });
const stockOrder = ['bilezikAdet','ceyrek','yarim','ziynet','cumhuriyet','resat','gramToplam','yuzuk','kupe','kolye','kunye','sahmeran','digerTaki','taki14','taki22','hurda22','hurda21','hurda18','hurda14','hurda8','hurda24','bilezik22','saat'];
for (const a of INITIAL_ACCOUNTS) a.displayOrder = stockOrder.includes(a.id) ? stockOrder.indexOf(a.id) : 100;

const editableTypes = new Set(['sale', 'purchase', 'movement', 'collection', 'transfer', 'settlement', 'stock']);
const optionalNoteTypes = new Set(['sale', 'purchase', 'collection', 'transfer', 'settlement', 'stock', 'movement']);
const scrapAdvanceTypes = new Set(['scrapAdvanceTransfer', 'scrapAdvanceUndo']);
const orderTypes = new Set(['customerOrder', 'orderUpdate', 'orderAdvance', 'orderRefund', 'orderCancel', ...scrapAdvanceTypes]);
export const ORDER_CATEGORIES = new Set(['bilezik', 'urun', 'sarrafiye', 'gram']);
function orderFeature(command) {
  return orderTypes.has(command?.type) || (command?.type === 'sale' && Object.hasOwn(command, 'orderSettlement'));
}
function usesV18OrderFeature(command) {
  if (!command || typeof command !== 'object') return false;
  if (command.type === 'orderUpdate') return true;
  if (command.type === 'customerOrder') {
    return ['category', 'productAccountId', 'weightAccountId', 'orderUnit', 'targetQuantity', 'deliveryDate', 'targetSpec', 'estimatedTotalTL', 'initialAdvance'].some(k => Object.hasOwn(command, k));
  }
  if (command.type === 'orderAdvance') {
    return ['receivedQuantity', 'creditedQuantity', 'weightAccount', 'weight', 'note'].some(k => Object.hasOwn(command, k));
  }
  if (command.type === 'orderRefund') {
    return ['refundedQuantity', 'creditedQuantity', 'weightAccount', 'weight', 'note'].some(k => Object.hasOwn(command, k));
  }
  if (command.type === 'sale' && command.orderSettlement && Array.isArray(command.orderSettlement.advances)) {
    return command.orderSettlement.advances.some(r => r && typeof r === 'object' && (Object.hasOwn(r, 'appliedQuantity') || Object.hasOwn(r, 'appliedValueTL')))
      || (Array.isArray(command.given) && command.given.length > 0)
      || (Array.isArray(command.debts) && command.debts.length > 0);
  }
  return false;
}
function usesAutoSupplierUnit(command) {
  if (!command || typeof command !== 'object') return false;
  if (command.type === 'supplierFirm' && command.autoUnits === true) return true;
  if (command.type === 'supplierTransfer') return true;
  const hasScrap = rows => Array.isArray(rows) && rows.some(r => /^hurda(8|14|18|21|22)$/.test(r?.accountId || ''));
  if (command.type === 'supplierPurchase' && hasScrap(command.items)) return true;
  if (command.type === 'supplierPayment' && hasScrap(command.received)) return true;
  const checkRows = rows => Array.isArray(rows) && rows.some(r => typeof r?.accountId === 'string' && r.accountId.startsWith('auto-unit:'));
  return checkRows(command.charges) || checkRows(command.credits) || checkRows(command.debts) || checkRows(command.reductions)
    || (typeof command.fromAccountId === 'string' && command.fromAccountId.startsWith('auto-unit:'))
    || (typeof command.toAccountId === 'string' && command.toAccountId.startsWith('auto-unit:'));
}
export function eventVersion(command, state) {
  if (isSupplierCommand(command)) return usesAutoSupplierUnit(command) ? 18 : 17;
  if (['close', 'stocktake'].includes(command.type) && state?.accounts?.some(a => !a.retired && a.physical && a.unit === 'SILVER')) return 18;
  if (command.type === 'fundAccount' && command.autoSupplierUnits === true) return 18;
  if (usesV18OrderFeature(command)) return 18;
  if (scrapAdvanceTypes.has(command.type)) return 16;
  if (hasSalePricing(command)) return 10;
  if (['saleReturn','retailExchange'].includes(command.type) && Object.hasOwn(command,'customerConsideration')) return 14;
  if (command.type === 'retailExchange' && state && classicCashCustomer(state, state.journal.find(e => e.id === command.originalId))) return 15;
  if (['retailExchange','undoExchange'].includes(command.type)) return 13;
  if (orderFeature(command)) return 11;
  if (usesInventory(command)) return 8;
  if (command.type === 'linkScrapPurchase') return 12;
  if (command.type === 'saleReturn' && Object.hasOwn(command, 'outgoing')) return 9;
  return financialVersion(command, state);
}
export function financialVersion(command, state) {
  if (supplierUnitFeature(command, state)) return 7;
  return priorEventVersion(command, state);
}
function supplierUnitFeature(command, state) {
  if (!command || typeof command !== 'object') return false;
  if (Object.hasOwn(command, 'parentAccountId') || command.unit === 'SILVER') return true;
  if (Array.isArray(command.banks) && command.banks.some(bank => bank?.unit === 'SILVER')) return true;
  if (command.type === 'amend') return supplierUnitFeature(command.replacement, state);
  const ids = [command.accountId, command.counterpartyId, command.customerAccount, command.counterpartyAccount, command.target, command.fromAccount, command.toAccount,
    ...Object.keys(command.counts || {}), ...['received', 'given', 'credits', 'debts', 'payments', 'refunds'].flatMap(key => Array.isArray(command[key]) ? command[key].map(row => row?.accountId) : [])];
  // A root keeps its historical trade semantics when a child is added later.
  // Only profile edits need family mode without actually referencing a child.
  const idx = state ? getAccountIndex(state.accounts) : null;
  if (!idx) return false;
  for (const id of ids) {
    if (!id) continue;
    if (idx.silverOrChildIds.has(id)) return true;
    if (command.type === 'accountUpdate' && idx.parentsWithChildren.has(id)) return true;
  }
  return false;
}
function priorEventVersion(command, state) {
  if (command.type === 'amend' && command.replacement && ['sale', 'purchase', 'collection'].includes(command.replacement.type) && (Object.hasOwn(command.replacement, 'received') || Object.hasOwn(command.replacement, 'given'))) return 6;
  if (['close', 'stocktake'].includes(command.type) || (['sale', 'purchase', 'collection'].includes(command.type) && (Object.hasOwn(command, 'received') || Object.hasOwn(command, 'given')))) return 6;
  return legacyEventVersion(command, state);
}
function legacyEventVersion(command, state) {
  // An omitted optional field has the same meaning before and after JSON storage.
  const defined = key => Object.hasOwn(command, key) && command[key] !== undefined;
  const partyIds = [command.customerAccount, command.counterpartyAccount, ...(Array.isArray(command.credits) ? command.credits.map(row => row?.accountId) : []), ...(Array.isArray(command.debts) ? command.debts.map(row => row?.accountId) : [])];
  const idx = state ? getAccountIndex(state.accounts) : null;
  const typedTrade = Boolean(idx && ['sale','purchase'].includes(command.type) && partyIds.some(id => id && idx.typedPartyIds.has(id)));
  if (['accountUpdate','fundUpdate','stockAccount','stockUpdate','amend'].includes(command.type) ||
      (command.type === 'opening' && Object.hasOwn(command, 'banks')) ||
      (command.type === 'account' && ['partyType','phone','taxId','address'].some(defined)) ||
      (command.type === 'sale' && Object.hasOwn(command, 'scrap')) ||
      (command.type === 'purchase' && defined('counterpartyId')) || typedTrade ||
      (command.type === 'movement' && command.category === 'Gider' && !['nakit','banka'].includes(command.accountId)) ||
      (optionalNoteTypes.has(command.type) && (command.note === undefined || typeof command.note === 'string' && !command.note.trim())))
    return 5;
  return command.type === 'saleReturn' || (command.type === 'close' && Object.hasOwn(command, 'nextDate')) || (command.type === 'settlement' && Object.hasOwn(command, 'bankAccount')) ? 4 : 3;
}
function optionalText(value, label, max = 160) {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || value.length > max) fail(`${label} en çok ${max} karakter olmalı.`);
  return value.trim();
}
function partyProfile(command, previous = {}, preserveUnknown = false) {
  const defined = key => Object.hasOwn(command, key) && command[key] !== undefined;
  const partyType = defined('partyType') ? command.partyType : previous.partyType ?? (preserveUnknown ? undefined : 'customer');
  if (partyType !== undefined && !['customer','supplier'].includes(partyType)) fail('Müşteri veya toptancı hesap türü seçin.');
  const phone = optionalText(defined('phone') ? command.phone : previous.phone, 'Telefon', 30);
  const taxId = optionalText(defined('taxId') ? command.taxId : previous.taxId, 'TC / VKN', 11);
  const address = optionalText(defined('address') ? command.address : previous.address, 'Adres', 300);
  if (taxId && !/^\d{10,11}$/.test(taxId)) fail('TC / VKN 10 veya 11 rakam olmalı.');
  if (phone && !/^[+\d ()-]{3,30}$/.test(phone)) fail('Geçerli bir telefon numarası girin.');
  return { ...(partyType === undefined ? {} : { partyType }), phone, taxId, address };
}
function assertParty(s, id, partyType) {
  const a = account(s, id);
  if (a.kind !== 'receivable' || (a.partyType && a.partyType !== partyType)) fail(partyType === 'supplier' ? 'Toptancı işlemi için firma carisi seçin.' : 'Müşteri işlemi için müşteri carisi seçin.');
  return a;
}
export function financialUnit(unit) {
  if (unit === 'TL' || unit === 'HAS' || unit === 'SILVER' || (typeof unit === 'string' && /^[A-Z]{3}$/.test(unit) && unit !== 'TRY')) return unit;
  fail('Birim TL, HAS, SILVER veya üç büyük harfli döviz kodu olmalı. Türk lirası için TL kullanın.');
}
export function unitSpec(unit) {
  if (Object.hasOwn(UNITS, unit)) return UNITS[unit];
  financialUnit(unit);
  return { scale: 100, digits: 2 };
}
export class DomainError extends Error {
  constructor(message, { status = 400, code = 'VALIDATION_ERROR' } = {}) {
    super(message);
    this.name = 'DomainError';
    this.status = status;
    this.code = code;
  }
}
export function fail(message, options) { throw new DomainError(message, options); }
export function text(value, label, max = 160) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${label} gerekli (en çok ${max} karakter).`);
  return value.trim();
}
export function quantity(value, unit, { signed = false, zero = true } = {}) {
  const spec = unitSpec(unit);
  if (!spec || typeof value !== 'string' || value.length > 24) fail('Geçersiz miktar.');
  const normalized = value.trim().replace(',', '.');
  const pattern = new RegExp(`^${signed ? '-?' : ''}\\d+(?:\\.\\d{1,${Math.max(1, spec.digits)}})?$`);
  if (!pattern.test(normalized) || (spec.digits === 0 && normalized.includes('.'))) fail(`${unit}: en fazla ${spec.digits} ondalık basamak kullanın; binlik ayırıcı kullanmayın.`);
  const [whole, fraction = ''] = normalized.replace('-', '').split('.');
  const result = (Number(whole) * spec.scale + Number(fraction.padEnd(spec.digits, '0'))) * (normalized.startsWith('-') ? -1 : 1);
  if (!Number.isSafeInteger(result) || Math.abs(result) > 1e12 || (!zero && result === 0)) fail('Miktar sıfır olamaz veya izin verilen sınırı aşıyor.');
  return result === 0 ? 0 : result;
}
export function decimal(value, unit) { const spec = unitSpec(unit); return (value / spec.scale).toFixed(spec.digits); }
export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value || value < '2000-01-01' || value > '2100-12-30') fail('Geçerli bir iş günü tarihi girin (2000–2100).');
  return value;
}
export function emptyState() { return { initialized: false, date: null, accounts: structuredClone(INITIAL_ACCOUNTS), balances: {}, journal: [], closings: [], stocktakes: [], nominalUnconfirmed: true }; }
const accountIndices = new WeakMap();
function buildAccountIndex(accounts) {
  const byId = new Map();
  const unitNameTr = new Set();
  const unitNameTrTR = new Set();
  const assetUnitNameTr = new Set();
  const upperNames = new Set();
  const parentsWithChildren = new Set();
  const physicalAccounts = [];
  const pairedTargets = new Set();
  const silverOrChildIds = new Set();
  const typedPartyIds = new Set();
  for (const a of accounts) {
    byId.set(a.id, a);
    const lowerTr = a.name.toLocaleLowerCase('tr');
    const lowerTrTR = a.name.toLocaleLowerCase('tr-TR');
    unitNameTr.add(`${a.unit}\0${lowerTr}`);
    unitNameTrTR.add(`${a.unit}\0${lowerTrTR}`);
    if (a.kind === 'asset') assetUnitNameTr.add(`${a.unit}\0${lowerTr}`);
    upperNames.add(a.name.toLocaleUpperCase('tr-TR'));
    if (a.parentAccountId) {
      parentsWithChildren.add(a.parentAccountId);
      silverOrChildIds.add(a.id);
    }
    if (a.unit === 'SILVER') silverOrChildIds.add(a.id);
    if (a.partyType) typedPartyIds.add(a.id);
    if (a.physical) physicalAccounts.push(a);
    if (a.pairedGroups?.length) for (const g of a.pairedGroups) pairedTargets.add(g);
  }
  const idx = { byId, unitNameTr, unitNameTrTR, assetUnitNameTr, upperNames, parentsWithChildren, physicalAccounts, pairedTargets, silverOrChildIds, typedPartyIds, len: accounts.length };
  accountIndices.set(accounts, idx);
  return idx;
}
export function getAccountIndex(accounts) {
  let idx = accountIndices.get(accounts);
  if (!idx || idx.len !== accounts.length) idx = buildAccountIndex(accounts);
  return idx;
}
function indexAddAccount(accounts, a) {
  const idx = accountIndices.get(accounts);
  if (!idx) return;
  idx.byId.set(a.id, a);
  const lowerTr = a.name.toLocaleLowerCase('tr');
  const lowerTrTR = a.name.toLocaleLowerCase('tr-TR');
  idx.unitNameTr.add(`${a.unit}\0${lowerTr}`);
  idx.unitNameTrTR.add(`${a.unit}\0${lowerTrTR}`);
  if (a.kind === 'asset') idx.assetUnitNameTr.add(`${a.unit}\0${lowerTr}`);
  idx.upperNames.add(a.name.toLocaleUpperCase('tr-TR'));
  if (a.parentAccountId) {
    idx.parentsWithChildren.add(a.parentAccountId);
    idx.silverOrChildIds.add(a.id);
  }
  if (a.unit === 'SILVER') idx.silverOrChildIds.add(a.id);
  if (a.partyType) idx.typedPartyIds.add(a.id);
  if (a.physical) idx.physicalAccounts.push(a);
  if (a.pairedGroups?.length) for (const g of a.pairedGroups) idx.pairedTargets.add(g);
  idx.len = accounts.length;
}
function account(s, id) { return getAccountIndex(s.accounts).byId.get(id) || fail('Hesap bulunamadı.'); }
function stockLines(s, items, direction, priced, version = 2, purchase = false) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 30) fail('1–30 ürün satırı girin.');
  const entries = [], lines = [];
  let total = 0;
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('Geçerli bir ürün satırı girin.');
    const a = account(s, item.accountId);
    if (version >= 3 && a.retired) fail('Eski paket/ağırlık hesabı yeni işlemlerde kullanılamaz. Gram altın toplamını kullanın.');
    if (version >= 3 && a.id === 'gramToplam' && s.nominalUnconfirmed) fail('Önce gram altının mevcut toplamını açıkça onaylayın.');
    if (purchase ? !a.isPurchasable : !a.isSaleable) fail('Ürün satırında izinli ürün hesabını seçin; toplu gram havuzu ayrı bir mal değildir.');
    const q = quantity(item.quantity, a.unit, { zero: false });
    entries.push({ accountId: a.id, delta: direction * q });
    let weight = 0, weightAccount = null;
    if (a.pairedGroups.length) {
      if (!a.pairedGroups.includes(item.weightAccount)) fail(`${a.name}: geçerli ayar/terazi grubunu seçin.`);
      weightAccount = item.weightAccount;
      weight = quantity(item.weight, 'GRAM', { zero: false });
      entries.push({ accountId: weightAccount, delta: direction * weight });
    } else if ((item.weight && item.weight !== '0') || item.weightAccount) fail('Bu ürün ikinci gram havuzuna bağlanmaz; kendi birimindeki toplam miktarı girin.');
    const value = priced ? quantity(item.value, 'TL', { zero: false }) : 0;
    total += value;
    if (!Number.isSafeInteger(total) || total > 1e12) fail('Toplam satış tutarı sınırı aşıyor.');
    lines.push({ accountId: a.id, quantity: q, weightAccount, weight, value });
  }
  return { entries, lines, total };
}
function moneyAccount(s, id, allowPos = false) {
  const a = account(s, id);
  if (a.kind !== 'asset' || a.retired || (!allowPos && id === 'pos')) fail('Geçerli kasa, banka veya has ödeme hesabı seçin. POS alacağı çıkış hesabı değildir.');
  financialUnit(a.unit);
  return a;
}
// TL values are agreed references entered for this event, never inferred exchange rates.
function allocations(s, rows, role, sign, allowPos = false) {
  if (!Array.isArray(rows) || rows.length > 30) fail('Ödeme ve cari bölümlerinde en çok 30 satır olabilir.');
  const entries = [], lines = [];
  let total = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail('Geçerli ödeme/cari satırı girin.');
    const a = role === 'asset' ? moneyAccount(s, row.accountId, allowPos) : account(s, row.accountId);
    if (role !== 'asset' && a.kind !== 'receivable') fail('Borç veya alacak için cari hesap seçin.');
    financialUnit(a.unit);
    const amount = quantity(row.quantity, a.unit, { zero: false });
    const valueTL = a.unit === 'TL' && row.valueTL === undefined ? amount : quantity(row.valueTL, 'TL', { zero: false });
    if (a.unit === 'TL' && valueTL !== amount) fail('TL hesabının TL karşılığı miktarla aynı olmalı.');
    total += valueTL;
    if (!Number.isSafeInteger(total) || total > 1e12) fail('Ödeme/cari toplamı sınırı aşıyor.');
    entries.push({ accountId: a.id, delta: sign * amount });
    lines.push({ accountId: a.id, quantity: amount, unit: a.unit, valueTL });
  }
  return { entries, lines, total };
}
function noMixedPayments(c, legacyFields) {
  if (legacyFields.some(key => c[key] !== undefined)) fail('Çok birimli ödeme satırları ile eski ödeme alanları birlikte kullanılamaz.');
}
const dailyScrapIds = new Set(['hurda8', 'hurda14', 'hurda18', 'hurda21', 'hurda22', 'hurda24']);
export function currentCountPolicy(a) { return (dailyScrapIds.has(a.id) || (a.physical && a.unit === 'SILVER')) ? 'daily' : a.countPolicy || 'none'; }
function exchangeAssets(s, rows, sign) {
  if (!Array.isArray(rows) || rows.length > 30) fail('Karşılık bölümünde en çok 30 satır olabilir.');
  const entries = [], lines = []; let total = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail('Geçerli karşılık satırı girin.');
    const a = account(s, row.accountId);
    let result;
    if (a.kind === 'asset' && a.physical && ['GRAM', 'ADET'].includes(a.unit)) {
      result = stockLines(s, [{ ...row, value: row.valueTL }], sign, true, 6, true);
      result.lines = result.lines.map(line => ({ ...line, unit: a.unit, valueTL: line.value, kind: 'stock' }));
    } else {
      if (row.weightAccount || (row.weight !== undefined && row.weight !== '')) fail('Ödeme hesabında ürün gramı girilmez.');
      result = allocations(s, [row], 'asset', sign, sign > 0);
      result.lines = result.lines.map(line => ({ ...line, kind: 'money' }));
    }
    total += result.total;
    if (!Number.isSafeInteger(total) || total > 1e12) fail('Karşılık toplamı sınırı aşıyor.');
    entries.push(...result.entries); lines.push(...result.lines);
  }
  return { entries, lines, total };
}
function exchangeTrade(s, c, total, purchase, familyMode = false, advanceTL = 0) {
  noMixedPayments(c, ['payments', 'scrap', 'scrapQuantity', 'scrapValue', 'cash', 'pos', 'bank', 'customerAccount', 'counterpartyAccount']);
  const partyType = c.counterpartyType ?? (purchase ? c.source : 'customer');
  if (!['customer', 'supplier'].includes(partyType) || (purchase && partyType !== c.source)) fail('İşlem cari türü ve kaynak uyumlu olmalı.');
  const counterpartyId = optionalText(c.counterpartyId, 'İşlem carisi', 160);
  const party = counterpartyId ? assertParty(s, counterpartyId, partyType) : null;
  if (familyMode && party?.parentAccountId) fail('İşlem carisi için ana toptancı hesabını seçin.');
  const received = exchangeAssets(s, c.received === undefined ? [] : c.received, 1);
  const given = exchangeAssets(s, c.given === undefined ? [] : c.given, -1);
  const credits = allocations(s, c.credits === undefined ? [] : c.credits, 'receivable', 1);
  const debts = allocations(s, c.debts === undefined ? [] : c.debts, 'receivable', -1);
  for (const row of [...credits.lines, ...debts.lines]) {
    assertParty(s, row.accountId, partyType);
    const child = account(s, row.accountId);
    const belongs = row.accountId === counterpartyId || (familyMode && partyType === 'supplier' && party?.partyType === 'supplier' && child.partyType === 'supplier' && child.parentAccountId === counterpartyId);
    if (!counterpartyId || !belongs) fail('Cari karşılık satırı seçili işlem carisine ait olmalı.');
  }
  const net = received.total - given.total + credits.total - debts.total + advanceTL;
  if ((purchase ? -net : net) !== total) fail('Ürün bedeli ile alınan, verilen ve cari karşılıkların anlaşılmış TL dengesi eşleşmeli.');
  return { entries: [...received.entries, ...given.entries, ...credits.entries, ...debts.entries],
    meta: { receivedLines: received.lines, givenLines: given.lines, creditLines: credits.lines, debtLines: debts.lines,
      paymentLines: (purchase ? given : received).lines.filter(row => row.kind === 'money'),
      counterpartyId, counterpartyType: partyType, credit: credits.total, paid: given.total - received.total, outstanding: debts.total - credits.total } };
}
export const amendmentValidation = Symbol('validate amendment balances after both legs');
export function supplierAmendmentPreview(state,originalId) {
  text(originalId,'Düzeltilecek işlem',100);
  const original=state.journal.find(entry=>entry.id===originalId);
  if(!original||!['supplierPurchase','supplierPayment','supplierAllocation','supplierOffset','supplierReturn'].includes(original.type)) fail('Düzeltilebilen toptancı işlemi seçin.');
  let counter=0,id;
  do {id='supplier-amend-preview-'+counter++;} while(state.journal.some(entry=>entry.id===id));
  return applyEvent(state,{id,schemaVersion:17,command:{type:'supplierReverse',date:state.date,originalId,note:'Kaydedilmeyen düzeltme önizlemesi'}},undefined,amendmentValidation);
}
function entriesApply(s, entries, validationMode) {
  const sums = new Map();
  for (const e of entries) {
    account(s, e.accountId);
    if (!Number.isSafeInteger(e.delta)) fail('Geçersiz hareket miktarı.');
    sums.set(e.accountId, (sums.get(e.accountId) || 0) + e.delta);
  }
  for (const [id, delta] of sums) {
    const result = (s.balances[id] || 0) + delta;
    if (!Number.isSafeInteger(result) || Math.abs(result) > 1e12) fail('Bakiye sınırı aşıldı.');
    if (validationMode !== amendmentValidation && account(s, id).kind === 'asset' && result < 0) fail(`${account(s, id).name}: yetersiz mevcut. İşlem bütünüyle reddedildi.`);
    s.balances[id] = result;
  }
}
function orderUnitCheck(state, raw) {
  if (raw === undefined || raw === '') return 'TL';
  const u = String(raw).trim().toUpperCase();
  if (u === 'ADET' || u === 'GRAM' || u === 'HAS' || u === 'SILVER' || u === 'TL') return u;
  if (/^[A-Z]{3}$/.test(u) && u !== 'TRY') return u;
  fail('Sipariş takip birimi geçersiz.');
}
function orderAssetAccount(state, accountId) {
  const a = account(state, accountId);
  if (a.retired || a.kind !== 'asset' || a.id === 'pos') fail('Kapora için aktif kasa, banka, döviz, hurda veya ürün hesabı seçin.');
  return a;
}
function orderAdvanceRemaining(a, orderUnit) {
  if (orderUnit === 'TL' && a.creditedQuantity === undefined) {
    return a.receivedTL - a.refundedTL - a.appliedTL - (a.returnedToPayableTL || 0);
  }
  const credited = a.creditedQuantity ?? a.receivedTL ?? 0;
  const refunded = a.refundedQuantity ?? a.refundedTL ?? 0;
  const applied = a.appliedQuantity ?? a.appliedTL ?? 0;
  const returned = a.returnedToPayableTL || 0;
  return credited - refunded - applied - returned;
}
function orderAssetEntries(state, asset, qty, direction, weightAccount, weight) {
  const entries = [{ accountId: asset.id, delta: direction * qty }];
  if (asset.pairedGroups?.length) {
    if (!weightAccount || !asset.pairedGroups.includes(weightAccount)) fail(`${asset.name} için bağlı terazi grubunu seçin.`);
    const w = quantity(weight, 'GRAM', { zero: false });
    entries.push({ accountId: weightAccount, delta: direction * w });
  } else if (weightAccount || (weight !== undefined && weight !== '')) {
    fail(`${asset.name} için terazi ağırlığı girilemez.`);
  }
  return entries;
}
function orderProductBinding(state, rawProductId, rawWeightId) {
  const productAccountId = rawProductId !== undefined && rawProductId !== '' ? String(rawProductId).trim() : '';
  const weightAccountId = rawWeightId !== undefined && rawWeightId !== '' ? String(rawWeightId).trim() : '';
  if (!productAccountId) {
    if (weightAccountId) fail('Ayar / terazi grubu seçmek için önce ürün seçin.');
    return { productAccountId: '', weightAccountId: '' };
  }
  const prod = account(state, productAccountId);
  if (prod.retired || prod.kind !== 'asset' || !prod.isSaleable || /^hurda(8|14|18|21|22)$/.test(prod.id)) {
    fail('Sipariş ürünü olarak aktif ve satılabilir bir stok kartı seçin.');
  }
  if (weightAccountId) {
    if (!Array.isArray(prod.pairedGroups) || !prod.pairedGroups.includes(weightAccountId)) {
      fail(`${prod.name} için geçerli bir bağlı ayar / terazi grubu seçin.`);
    }
  }
  return { productAccountId: prod.id, weightAccountId };
}
// Each receipt retains its own unused amount in the order's tracking unit. Refund and final-sale materialization
// are staged until the financial entries have passed the normal balance checks.
function prepareOrder(state, event) {
  const c = event.command;
  const orders = state.customerOrders || [];
  const fields = {
    customerOrder: ['type','date','customerId','description','category','productAccountId','weightAccountId','orderUnit','targetQuantity','deliveryDate','targetSpec','estimatedTotalTL','initialAdvance'],
    orderUpdate: ['type','date','orderId','category','productAccountId','weightAccountId','orderUnit','targetQuantity','deliveryDate','targetSpec','estimatedTotalTL','description','note'],
    orderAdvance: ['type','date','orderId','accountId','amountTL','receivedQuantity','creditedQuantity','weightAccount','weight','note'],
    orderRefund: ['type','date','orderId','advanceId','accountId','amountTL','refundedQuantity','creditedQuantity','weightAccount','weight','note'],
    scrapAdvanceTransfer: ['type','date','orderId','purchaseId','customerId','amountTL','note'],
    scrapAdvanceUndo: ['type','date','orderId','advanceId','amountTL','note'],
    orderCancel: ['type','date','orderId','note']
  };
  if (fields[c.type] && Object.keys(c).some(key => !fields[c.type].includes(key))) fail('Sipariş işleminde desteklenmeyen alan.');
  if (c.type === 'customerOrder') {
    const customer = assertParty(state, c.customerId, 'customer');
    const category = c.category !== undefined && c.category !== '' ? String(c.category).trim().toLowerCase() : 'urun';
    if (!ORDER_CATEGORIES.has(category)) fail('Geçerli bir sipariş kategorisi seçin (Bilezik, Ürün, Sarrafiye veya Gram).');
    const { productAccountId, weightAccountId } = orderProductBinding(state, c.productAccountId, c.weightAccountId);
    const orderUnit = orderUnitCheck(state, c.orderUnit);
    const targetQuantity = c.targetQuantity !== undefined && c.targetQuantity !== '' ? quantity(c.targetQuantity, orderUnit, { zero: false }) : null;
    const deliveryDate = c.deliveryDate !== undefined && c.deliveryDate !== '' ? validDate(c.deliveryDate) : '';
    const targetSpec = c.targetSpec !== undefined && c.targetSpec !== '' ? text(c.targetSpec, 'Hedef özellik / ayar', 80) : '';
    const estimatedTotalTL = c.estimatedTotalTL !== undefined && c.estimatedTotalTL !== '' ? quantity(c.estimatedTotalTL, 'TL', { zero: false }) : null;
    const order = {
      id: event.id,
      customerId: customer.id,
      description: text(c.description, 'Sipariş açıklaması', 300),
      category,
      ...(productAccountId ? { productAccountId } : {}),
      ...(weightAccountId ? { weightAccountId } : {}),
      orderUnit,
      ...(targetQuantity !== null ? { targetQuantity } : {}),
      ...(deliveryDate ? { deliveryDate } : {}),
      ...(targetSpec ? { targetSpec } : {}),
      ...(estimatedTotalTL !== null ? { estimatedTotalTL } : {}),
      date: c.date,
      status: 'open',
      availableTL: 0,
      availableQuantity: 0,
      advances: []
    };
    const entries = [];
    const meta = {
      orderId: order.id,
      counterpartyId: customer.id,
      description: order.description,
      category,
      ...(productAccountId ? { productAccountId } : {}),
      ...(weightAccountId ? { weightAccountId } : {}),
      orderUnit,
      ...(targetQuantity !== null ? { targetQuantity } : {}),
      ...(deliveryDate ? { deliveryDate } : {}),
      ...(estimatedTotalTL !== null ? { estimatedTotalTL } : {}),
      revenue: 0
    };
    if (c.initialAdvance !== undefined && c.initialAdvance !== null) {
      if (typeof c.initialAdvance !== 'object' || Array.isArray(c.initialAdvance)
        || Object.keys(c.initialAdvance).some(k => !['accountId','receivedQuantity','creditedQuantity','weightAccount','weight'].includes(k))) {
        fail('Açılış kaporası bilgileri geçersiz.');
      }
      const asset = orderAssetAccount(state, c.initialAdvance.accountId);
      const receivedQty = quantity(c.initialAdvance.receivedQuantity, asset.unit, { zero: false });
      const hasExplicitCredit = c.initialAdvance.creditedQuantity !== undefined && c.initialAdvance.creditedQuantity !== '';
      if (asset.unit !== orderUnit && !hasExplicitCredit) {
        fail(`Alınan varlık (${asset.unit}) sipariş biriminden (${orderUnit}) farklı; siparişe sayılan miktarı açıkça girin.`);
      }
      const creditedQty = hasExplicitCredit ? quantity(c.initialAdvance.creditedQuantity, orderUnit, { zero: false }) : receivedQty;
      if (!Number.isSafeInteger(creditedQty) || creditedQty <= 0 || creditedQty > 1e12) fail('Siparişe sayılan kapora miktarı geçersiz.');
      entries.push(...orderAssetEntries(state, asset, receivedQty, +1, c.initialAdvance.weightAccount, c.initialAdvance.weight));
      order.advances.push({
        id: event.id,
        unit: orderUnit,
        receivedTL: orderUnit === 'TL' ? creditedQty : 0,
        refundedTL: 0,
        appliedTL: 0,
        creditedQuantity: creditedQty,
        refundedQuantity: 0,
        appliedQuantity: 0,
        receivedAccountId: asset.id,
        receivedUnit: asset.unit,
        receivedQuantity: receivedQty
      });
      order.availableQuantity = creditedQty;
      order.availableTL = orderUnit === 'TL' ? creditedQty : 0;
      Object.assign(meta, {
        advanceId: event.id,
        fundAccountId: asset.id,
        receivedUnit: asset.unit,
        receivedQuantity: receivedQty,
        creditedQuantity: creditedQty,
        ...(orderUnit === 'TL' ? { amountTL: creditedQty } : {})
      });
    }
    return { orders: [...orders, order], entries, label: entries.length ? 'Müşteri siparişi ve kapora' : 'Müşteri siparişi', meta };
  }
  const settlement = c.type === 'sale' ? c.orderSettlement : null;
  if (c.type === 'sale' && (!settlement || Array.isArray(settlement) || typeof settlement !== 'object' || Object.keys(settlement).some(k => !['orderId','advances'].includes(k)))) fail('Sipariş bağlantısı gerekli.');
  const id = text(settlement ? settlement.orderId : c.orderId, 'Sipariş kaydı', 100);
  const original = orders.find(o => o.id === id);
  if (!original || original.status === 'cancelled' || (original.status !== 'open' && !['orderRefund','scrapAdvanceUndo'].includes(c.type))) fail('İşleme uygun açık sipariş seçin.');
  const orderUnit = original.orderUnit || 'TL';
  const origAvailable = original.availableQuantity ?? original.availableTL ?? 0;
  const order = { ...original, orderUnit, availableQuantity: origAvailable, advances: original.advances.map(a => ({ ...a })) };
  const meta = { orderId: id, counterpartyId: order.customerId, orderUnit, revenue: 0 };
  const entries = [];
  let label;
  const receipt = id => order.advances.find(a => a.id === id) || fail('Avans makbuzu bu siparişe ait olmalı.');
  const remaining = a => orderAdvanceRemaining(a, orderUnit);
  if (scrapAdvanceTypes.has(c.type)) {
    if (orderUnit !== 'TL') fail('Hurda borcundan avans aktarımı yalnız TL takip birimli siparişlerde kullanılabilir.');
    const customer = assertParty(state, order.customerId, 'customer');
    if (customer.unit !== 'TL') fail('Hurda borcundan avans için aynı TL müşteri hesabı gerekli.');
    const amount = quantity(c.amountTL, 'TL', { zero: false });
    meta.note = text(c.note, 'Avansa aktarma / geri alma açıklaması');
    meta.amountTL = amount;
    if (c.type === 'scrapAdvanceTransfer') {
      if (c.customerId !== customer.id) fail('Sipariş ve alış aynı müşteriye ait olmalı.');
      const capacity = scrapAdvanceSources(state, customer.id).get(c.purchaseId);
      if (!capacity || amount > capacity || amount > Math.max(0,-(state.balances[customer.id] || 0))) fail('Tutar alışın aktarılmamış tutarını veya müşteriye net borcumuzu aşıyor.');
      order.advances.push({ id:event.id, unit:'TL', receivedTL:amount, refundedTL:0, appliedTL:0, creditedQuantity:amount, refundedQuantity:0, appliedQuantity:0, returnedToPayableTL:0, sourcePurchaseId:c.purchaseId });
      order.availableTL += amount;
      order.availableQuantity += amount;
      if (!Number.isSafeInteger(order.availableTL) || order.availableTL > 1e12) fail('Avans toplamı sınırı aşıyor.');
      entries.push({ accountId:customer.id, delta:amount });
      Object.assign(meta,{ purchaseId:c.purchaseId, advanceId:event.id, sourceCapacityTL:capacity });
      label = 'Hurda alış borcundan avansa aktarma';
    } else {
      const advance = receipt(c.advanceId);
      if (!advance.sourcePurchaseId || amount > remaining(advance)) fail('Yalnız hurda borcundan ayrılmış kullanılmamış avans geri alınabilir.');
      advance.returnedToPayableTL = (advance.returnedToPayableTL || 0) + amount;
      order.availableTL -= amount;
      order.availableQuantity -= amount;
      entries.push({ accountId:customer.id, delta:-amount });
      Object.assign(meta,{ purchaseId:advance.sourcePurchaseId, advanceId:advance.id });
      label = 'Hurda avansını müşteri borcumuza geri alma';
    }
    meta.customerBalanceBefore = state.balances[customer.id] || 0;
    meta.customerBalanceAfter = meta.customerBalanceBefore + entries[0].delta;
  } else if (c.type === 'orderUpdate') {
    if (original.status !== 'open') fail('Yalnız açık siparişler düzenlenebilir.');
    const nextCategory = c.category !== undefined && c.category !== '' ? String(c.category).trim().toLowerCase() : (order.category || 'urun');
    if (!ORDER_CATEGORIES.has(nextCategory)) fail('Geçerli bir sipariş kategorisi seçin.');
    const nextUnit = c.orderUnit !== undefined && c.orderUnit !== '' ? orderUnitCheck(state, c.orderUnit) : orderUnit;
    if (nextUnit !== orderUnit && (original.advances || []).length > 0) {
      fail('Kapora alınmış siparişin takip birimi değiştirilemez.');
    }
    const rawProd = Object.hasOwn(c, 'productAccountId') ? c.productAccountId : (order.productAccountId || '');
    const rawWeight = Object.hasOwn(c, 'weightAccountId') ? c.weightAccountId : (order.weightAccountId || '');
    const { productAccountId, weightAccountId } = orderProductBinding(state, rawProd, rawWeight);
    order.category = nextCategory;
    order.orderUnit = nextUnit;
    if (productAccountId) order.productAccountId = productAccountId; else delete order.productAccountId;
    if (weightAccountId) order.weightAccountId = weightAccountId; else delete order.weightAccountId;
    if (Object.hasOwn(c, 'description')) order.description = text(c.description, 'Sipariş açıklaması', 300);
    if (Object.hasOwn(c, 'targetQuantity')) {
      if (c.targetQuantity === '' || c.targetQuantity === null || c.targetQuantity === undefined) delete order.targetQuantity;
      else order.targetQuantity = quantity(c.targetQuantity, nextUnit, { zero: false });
    }
    if (Object.hasOwn(c, 'deliveryDate')) {
      if (c.deliveryDate === '' || c.deliveryDate === null || c.deliveryDate === undefined) delete order.deliveryDate;
      else order.deliveryDate = validDate(c.deliveryDate);
    }
    if (Object.hasOwn(c, 'targetSpec')) {
      const spec = optionalText(c.targetSpec, 'Hedef özellik / ayar', 80);
      if (spec) order.targetSpec = spec; else delete order.targetSpec;
    }
    if (Object.hasOwn(c, 'estimatedTotalTL')) {
      if (c.estimatedTotalTL === '' || c.estimatedTotalTL === null || c.estimatedTotalTL === undefined) delete order.estimatedTotalTL;
      else order.estimatedTotalTL = quantity(c.estimatedTotalTL, 'TL', { zero: false });
    }
    meta.orderUnit = nextUnit;
    meta.category = nextCategory;
    meta.description = order.description;
    if (productAccountId) meta.productAccountId = productAccountId;
    if (weightAccountId) meta.weightAccountId = weightAccountId;
    if (c.note) meta.note = optionalText(c.note, 'Düzenleme açıklaması');
    label = 'Sipariş düzenleme';
  } else if (c.type === 'orderCancel') {
    if (order.availableTL || order.availableQuantity) fail('İptal öncesinde kullanılmamış avansı iade edin.');
    order.status = 'cancelled';
    order.cancelId = event.id;
    meta.note = text(c.note, 'İptal açıklaması');
    label = 'Sipariş iptali';
  } else if (c.type === 'sale') {
    if (c.counterpartyType !== 'customer' || c.counterpartyId !== order.customerId) fail('Nihai satış siparişteki müşteriye bağlanmalı.');
    if (!Array.isArray(settlement.advances) || settlement.advances.length > 100) fail('Mahsup edilecek avans satırlarını seçin.');
    const seen = new Set();
    let totalAppliedTL = 0;
    meta.advanceAllocations = settlement.advances.map(row => {
      if (!row || typeof row !== 'object' || Array.isArray(row) || seen.has(row.advanceId)) fail('Her avans makbuzunu bir kez seçin.');
      const advance = receipt(row.advanceId);
      if (orderUnit === 'TL' && !Object.hasOwn(row, 'appliedQuantity') && !Object.hasOwn(row, 'appliedValueTL')) {
        if (Object.keys(row).some(k => !['advanceId','amountTL'].includes(k))) fail('Avans mahsup alanları geçersiz.');
        const amount = quantity(row.amountTL, 'TL', { zero: false });
        if (amount > remaining(advance)) fail('Mahsup tutarı kullanılabilir avansı aşıyor.');
        advance.appliedTL += amount;
        if (advance.appliedQuantity !== undefined) advance.appliedQuantity += amount;
        order.availableTL -= amount;
        order.availableQuantity -= amount;
        totalAppliedTL += amount;
        seen.add(row.advanceId);
        return { advanceId: advance.id, amountTL: amount };
      }
      if (Object.keys(row).some(k => !['advanceId','appliedQuantity','appliedValueTL'].includes(k))) fail('Çok birimli avans mahsup alanları geçersiz.');
      const appliedQty = quantity(row.appliedQuantity, orderUnit, { zero: false });
      if (appliedQty > remaining(advance)) fail('Mahsup miktarı kullanılabilir kaporayı aşıyor.');
      const appliedValTL = orderUnit === 'TL' && (row.appliedValueTL === undefined || row.appliedValueTL === '')
        ? appliedQty
        : quantity(row.appliedValueTL, 'TL', { zero: false });
      advance.appliedQuantity = (advance.appliedQuantity ?? advance.appliedTL ?? 0) + appliedQty;
      if (orderUnit === 'TL') {
        advance.appliedTL = (advance.appliedTL || 0) + appliedQty;
        order.availableTL -= appliedQty;
      }
      order.availableQuantity -= appliedQty;
      totalAppliedTL += appliedValTL;
      if (!Number.isSafeInteger(totalAppliedTL) || totalAppliedTL > 1e12) fail('Mahsup TL toplamı sınırı aşıyor.');
      seen.add(row.advanceId);
      return { advanceId: advance.id, appliedQuantity: appliedQty, appliedValueTL: appliedValTL, amountTL: appliedValTL, unit: orderUnit };
    });
    meta.advanceAppliedTL = totalAppliedTL;
    order.status = 'fulfilled';
    order.saleId = event.id;
  } else if (c.type === 'orderAdvance') {
    const isV18 = Object.hasOwn(c, 'receivedQuantity') || Object.hasOwn(c, 'creditedQuantity') || orderUnit !== 'TL';
    if (!isV18) {
      const fund = moneyAccount(state, c.accountId);
      if (fund.unit !== 'TL') fail('TL sipariş avansı için TL kasa veya banka seçin.');
      const amount = quantity(c.amountTL, 'TL', { zero: false });
      order.advances.push({ id: event.id, unit: 'TL', receivedTL: amount, refundedTL: 0, appliedTL: 0, creditedQuantity: amount, refundedQuantity: 0, appliedQuantity: 0 });
      order.availableTL += amount;
      order.availableQuantity += amount;
      if (!Number.isSafeInteger(order.availableTL) || order.availableTL > 1e12) fail('Avans toplamı sınırı aşıyor.');
      entries.push({ accountId: fund.id, delta: amount });
      label = 'Sipariş avansı';
      meta.advanceId = event.id;
      meta.amountTL = amount;
      meta.fundAccountId = fund.id;
    } else {
      const asset = orderAssetAccount(state, c.accountId);
      const receivedQty = quantity(c.receivedQuantity, asset.unit, { zero: false });
      const hasExplicitCredit = c.creditedQuantity !== undefined && c.creditedQuantity !== '';
      if (asset.unit !== orderUnit && !hasExplicitCredit) {
        fail(`Alınan varlık (${asset.unit}) sipariş biriminden (${orderUnit}) farklı; siparişe sayılan miktarı açıkça girin.`);
      }
      const creditedQty = hasExplicitCredit ? quantity(c.creditedQuantity, orderUnit, { zero: false }) : receivedQty;
      order.availableQuantity += creditedQty;
      if (orderUnit === 'TL') order.availableTL += creditedQty;
      if (!Number.isSafeInteger(order.availableQuantity) || order.availableQuantity > 1e12) fail('Avans toplamı sınırı aşıyor.');
      order.advances.push({
        id: event.id,
        unit: orderUnit,
        receivedTL: orderUnit === 'TL' ? creditedQty : 0,
        refundedTL: 0,
        appliedTL: 0,
        creditedQuantity: creditedQty,
        refundedQuantity: 0,
        appliedQuantity: 0,
        receivedAccountId: asset.id,
        receivedUnit: asset.unit,
        receivedQuantity: receivedQty
      });
      entries.push(...orderAssetEntries(state, asset, receivedQty, +1, c.weightAccount, c.weight));
      label = 'Sipariş kaporası';
      meta.advanceId = event.id;
      meta.fundAccountId = asset.id;
      meta.receivedUnit = asset.unit;
      meta.receivedQuantity = receivedQty;
      meta.creditedQuantity = creditedQty;
      if (orderUnit === 'TL') meta.amountTL = creditedQty;
      if (c.note) meta.note = optionalText(c.note, 'Kapora açıklaması');
    }
  } else {
    const isV18 = Object.hasOwn(c, 'refundedQuantity') || Object.hasOwn(c, 'creditedQuantity') || orderUnit !== 'TL';
    const advance = receipt(c.advanceId);
    if (!isV18) {
      const fund = moneyAccount(state, c.accountId);
      if (fund.unit !== 'TL') fail('TL sipariş avansı için TL kasa veya banka seçin.');
      const amount = quantity(c.amountTL, 'TL', { zero: false });
      if (amount > remaining(advance)) fail('İade tutarı kullanılmamış avansı aşıyor.');
      advance.refundedTL += amount;
      if (advance.refundedQuantity !== undefined) advance.refundedQuantity += amount;
      order.availableTL -= amount;
      order.availableQuantity -= amount;
      entries.push({ accountId: fund.id, delta: -amount });
      label = 'Sipariş avansı iadesi';
      meta.advanceId = advance.id;
      meta.amountTL = amount;
      meta.fundAccountId = fund.id;
    } else {
      const asset = orderAssetAccount(state, c.accountId);
      const refundedQty = quantity(c.refundedQuantity, asset.unit, { zero: false });
      const hasExplicitCredit = c.creditedQuantity !== undefined && c.creditedQuantity !== '';
      if (asset.unit !== orderUnit && !hasExplicitCredit) {
        fail(`İade edilen varlık (${asset.unit}) sipariş biriminden (${orderUnit}) farklı; kapatılan kapora miktarını açıkça girin.`);
      }
      const creditedQty = hasExplicitCredit ? quantity(c.creditedQuantity, orderUnit, { zero: false }) : refundedQty;
      if (creditedQty > remaining(advance)) fail('Kapatılan kapora miktarı makbuzdaki kullanılmamış tutarı aşıyor.');
      advance.refundedQuantity = (advance.refundedQuantity ?? advance.refundedTL ?? 0) + creditedQty;
      if (orderUnit === 'TL') {
        advance.refundedTL = (advance.refundedTL || 0) + creditedQty;
        order.availableTL -= creditedQty;
      }
      order.availableQuantity -= creditedQty;
      entries.push(...orderAssetEntries(state, asset, refundedQty, -1, c.weightAccount, c.weight));
      label = 'Sipariş kaporası iadesi';
      meta.advanceId = advance.id;
      meta.fundAccountId = asset.id;
      meta.refundedUnit = asset.unit;
      meta.refundedQuantity = refundedQty;
      meta.creditedQuantity = creditedQty;
      if (orderUnit === 'TL') meta.amountTL = creditedQty;
      if (c.note) meta.note = optionalText(c.note, 'İade açıklaması');
    }
  }
  return { orders: orders.map(o => o === original ? order : o), meta, entries, label };
}
function returnCustomerConsideration(s, original, rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 2) fail('İadede bir veya iki açık cari karşılık satırı seçin.');
  const originalParties = new Set(original.entries.map(e=>e.accountId).filter(id=>account(s,id).kind === 'receivable'));
  const partyId = original.meta.counterpartyId || (originalParties.size === 1 ? [...originalParties][0] : classicCashCustomer(s,original));
  if (!partyId || original.meta.counterpartyType === 'supplier') fail('Özgün satışta doğrulanabilen tek bir müşteri gerekli.');
  const customer = assertParty(s, partyId, 'customer');
  let balance = s.balances[partyId] || 0;
  const selected = new Set(), entries = [], lines = [];
  let total = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(k=>!['accountId','quantity','valueTL','action'].includes(k)) ||
        row.accountId !== partyId || !['reduceDebt','grantCredit'].includes(row.action) || selected.has(row.action)) fail('İade karşılığı özgün müşteriye ve açıkça seçilen cari işleme ait olmalı.');
    selected.add(row.action);
    const allocation = allocations(s,[row],'receivable',-1);
    const line = allocation.lines[0], before = balance;
    if (row.action === 'reduceDebt' && line.quantity > Math.max(0,balance)) fail('Borçtan düşülecek miktar müşterinin açık borcunu aşıyor.');
    balance -= line.quantity;
    total += line.valueTL;
    if (!Number.isSafeInteger(total) || total > 1e12) fail('Cari karşılık toplamı sınırı aşıyor.');
    entries.push(...allocation.entries);
    lines.push({ ...line, unit: customer.unit, action:row.action, before, after:balance });
  }
  return { entries, lines, total, partyId };
}

function activeSaleReturns(s, originalId) {
  const reversed = new Set(s.journal.filter(event => event.type === 'reverse').map(event => event.meta.originalId));
  return s.journal.filter(event => event.type === 'saleReturn' && event.meta.originalId === originalId && !reversed.has(event.id));
}
export function isWorkerCustomerCreation(command) {
  if (!command || command.type !== 'account' || command.partyType !== 'customer' ||
      Object.keys(command).some(key => !['type','date','name','unit','opening','partyType','phone','taxId','address'].includes(key))) return false;
  try {
    financialUnit(command.unit);
    return quantity(command.opening, command.unit, { signed:true }) === 0;
  } catch { return false; }
}

const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function eventActor(event) {
  if (!Object.hasOwn(event, 'audit')) return null;
  const audit = event.audit;
  if (audit?.version !== 1 || !audit.actor || typeof audit.actor !== 'object' || Array.isArray(audit.actor)) fail('İşlem sahibi bilgisi geçersiz.');
  const { id, name, role } = audit.actor;
  if (typeof id !== 'string' || !UUID_RE.test(id)
    || !['employee', 'owner'].includes(role) || text(name, 'İşlem sahibi') !== name) fail('İşlem sahibi bilgisi geçersiz.');
  if (role === 'employee' && !['sale', 'purchase'].includes(event.command.type) && !isWorkerCustomerCreation(event.command)) fail('Bu işlem yönetici yetkisi gerektirir.');
  if (['stocktake', 'close'].includes(event.command.type) && event.command.approvedBy !== name) fail('Sayım onayı işlem sahibiyle eşleşmiyor.');
  const result = { id, name, role };
  if (Object.hasOwn(audit.actor, 'viaMasterPin') || Object.hasOwn(audit.actor, 'masterActorId')) {
    if (audit.actor.viaMasterPin !== true || role !== 'employee'
      || typeof audit.actor.masterActorId !== 'string' || !UUID_RE.test(audit.actor.masterActorId)) {
      fail('İşlem sahibi bilgisi geçersiz.');
    }
    result.viaMasterPin = true;
    result.masterActorId = audit.actor.masterActorId;
  }
  if (audit.submittedBy && typeof audit.submittedBy === 'object' && !Array.isArray(audit.submittedBy)) {
    const sid = audit.submittedBy.id, sname = audit.submittedBy.name;
    if (typeof sid !== 'string' || !UUID_RE.test(sid)
      || text(sname, 'Tezgâh çalışanı') !== sname) fail('Tezgâh çalışanı bilgisi geçersiz.');
    result.submittedBy = { id: sid, name: sname };
    if (Object.hasOwn(audit.submittedBy, 'viaMasterPin') || Object.hasOwn(audit.submittedBy, 'masterActorId')) {
      if (audit.submittedBy.viaMasterPin !== true
        || typeof audit.submittedBy.masterActorId !== 'string' || !UUID_RE.test(audit.submittedBy.masterActorId)) {
        fail('Tezgâh çalışanı bilgisi geçersiz.');
      }
      result.submittedBy.viaMasterPin = true;
      result.submittedBy.masterActorId = audit.submittedBy.masterActorId;
    }
    if (audit.wasEdited === true) result.wasEdited = true;
  }
  return result;
}

// Legacy scalar trades could name a customer even when paid entirely in cash.
// Resolve account IDs only. A later account creation cannot claim an older trade.
export function scrapCustomerResolver(state) {
  const parties = new Map(state.accounts.filter(a => a.kind === 'receivable').map(a => [a.id,a]));
  let positions, opened;
  return entry => {
    if (!entry || !['sale','purchase'].includes(entry.type) || entry.meta.counterpartyType === 'supplier' ||
        (entry.type === 'purchase' && entry.meta.source !== 'customer')) return null;
    const command = entry.editableCommand || {};
    const classic = !entry.meta.receivedLines && !command.payments && !command.credits && !command.debts;
    const named = classic ? command[entry.type === 'sale' ? 'customerAccount' : 'counterpartyAccount'] : null;
    const ids = new Set([entry.meta.counterpartyId,named].filter(Boolean));
    let hasLeg = false;
    for (const row of entry.entries) {
      if (row.delta && parties.has(row.accountId)) { ids.add(row.accountId); hasLeg = true; }
    }
    if (ids.size !== 1) return null;
    const [id] = ids, party = parties.get(id);
    if (!party || party.partyType === 'supplier') return null;
    if (!party.partyType && !named && entry.meta.source !== 'customer' && entry.meta.counterpartyType !== 'customer') return null;
    if (named && !hasLeg && !entry.meta.counterpartyId) {
      if (!positions) {
        positions = new Map(); opened = new Map();
        for (const [i, row] of state.journal.entries()) {
          positions.set(row.id,i);
          if (row.type === 'account') opened.set(row.meta.accountId,i);
        }
      }
      if (!(opened.get(id) < positions.get(entry.id))) return null;
    }
    return id;
  };
}

// A classic fully paid sale can name a customer without a receivable entry.
export function classicCashCustomer(state, sale) {
  if (sale?.type !== 'sale' || sale.meta.counterpartyId || !sale.editableCommand?.customerAccount) return null;
  const byId = getAccountIndex(state.accounts).byId;
  if (sale.entries.some(row => byId.get(row.accountId)?.kind === 'receivable')) return null;
  return scrapCustomerResolver(state)(sale);
}

export function scrapAdvanceSources(state, customerId) {
  const customer = assertParty(state, customerId, 'customer');
  if (customer.unit !== 'TL') fail('Hurda borcundan avans için TL müşteri hesabı seçin.');
  const reversed = new Set(state.journal.filter(e => e.type === 'reverse').map(e => e.meta.originalId));
  const scrap = new Set(state.accounts.filter(a => a.scrap).map(a => a.id));
  const resolveParty = scrapCustomerResolver(state);
  const allocated = new Map();
  for (const order of state.customerOrders || []) for (const advance of order.advances) {
    if (advance.sourcePurchaseId) allocated.set(advance.sourcePurchaseId, (allocated.get(advance.sourcePurchaseId) || 0) + advance.receivedTL - (advance.returnedToPayableTL || 0));
  }
  const choices = new Map();
  for (const entry of state.journal) {
    if (entry.type !== 'purchase' || reversed.has(entry.id) || entry.date > state.date ||
        resolveParty(entry) !== customerId || !entry.meta.lines?.length ||
        !entry.meta.lines.every(line => scrap.has(line.accountId))) continue;
    const payable = -entry.entries.filter(row => row.accountId === customerId).reduce((sum,row) => sum + row.delta,0);
    if (!Number.isSafeInteger(payable) || payable <= 0 || payable > entry.meta.purchaseTotal) continue;
    const capacity = payable - (allocated.get(entry.id) || 0);
    if (capacity > 0) choices.set(entry.id,capacity);
  }
  return choices;
}
export function priorScrapChoices(state, saleId, resolveParty = scrapCustomerResolver(state)) {
  text(saleId, 'Satış kayıt numarası', 100);
  const journal = state.journal;
  const sale = journal.find(entry => entry.id === saleId);
  const partyId = resolveParty(sale);
  if (sale?.type !== 'sale' || !partyId) {
    fail('Müşteri kartına bağlı perakende satışı seçin.');
  }
  const originalPosition = new Map(), reversed = new Set(), links = [];
  for (const [index, entry] of journal.entries()) {
    originalPosition.set(entry.id, originalPosition.get(entry.meta.amendsOriginalId) ?? index);
    if (entry.type === 'reverse') reversed.add(entry.meta.originalId);
    if (entry.type === 'linkScrapPurchase' && entry.meta.saleId === sale.id) links.push(entry);
  }
  if (reversed.has(sale.id)) fail('İptal edilmiş satışa hurda alışı bağlanamaz.');
  const associated = new Set(links.filter(entry => !reversed.has(entry.id)).map(entry => entry.meta.purchaseId));
  const scrapAccounts = new Set(state.accounts.filter(a => a.scrap).map(a => a.id));
  // Corrections keep the commercial sequence of the original records, even on the same day.
  return new Set(journal.filter(entry => entry.type === 'purchase' && entry.meta.source === 'customer' &&
    resolveParty(entry) === partyId && originalPosition.get(entry.id) < originalPosition.get(sale.id) &&
    !reversed.has(entry.id) && !associated.has(entry.id) && entry.meta.lines?.some(line => scrapAccounts.has(line.accountId))
  ).map(entry => entry.id));
}

export function applyEvent(previous, event, replayContext, validationMode, exchangeAppliedTL = 0) {
  if ((event?.schemaVersion === 17 && !isSupplierCommand(event?.command)) || (isSupplierCommand(event?.command) && ![17, 18].includes(event?.schemaVersion))) fail('Toptancı işlemi için geçerli olay sürümü gerekli.');
  if (event?.schemaVersion === 10) {
    // Validate optional data before applying any stock, cash or revision changes.
    if (![3, 5, 6, 7, 8, 11, 18].includes(event.tradeVersion) || !event.command) fail('Fiyatlı satışın temel olay sürümü geçersiz.');
    const base = underlyingSaleCommand(event.command);
    let expectedVersion = financialVersion(base, previous);
    if (event.tradeVersion === 8 && usesInventory(base)) expectedVersion = 8;
    if (event.tradeVersion === 11 && orderFeature(base)) expectedVersion = 11;
    if (event.tradeVersion === 18 && usesV18OrderFeature(base)) expectedVersion = 18;
    if (event.tradeVersion !== expectedVersion) fail('Satış biçimi kayıtlı temel olay sürümüyle eşleşmiyor.');
    const sale = event.command.type === 'amend' ? event.command.replacement : event.command;
    const snapshots = salePriceSnapshot(sale);
    const result = applyEvent(previous, { ...event, schemaVersion:event.tradeVersion, command:base }, replayContext, validationMode);
    const entry = result.journal.at(-1);
    entry.meta.lines.forEach((line, index) => { line.pricing = snapshots[index]; });
    entry.meta.costKnown = snapshots.every(line => line.costKnown);
    if (entry.editableCommand) entry.editableCommand.salePricing = structuredClone(sale.salePricing);
    return result;
  }
  // Replaying builds a private state in place; live commands preserve the caller's state.
  const s = replayContext ? previous : { ...previous, accounts: [...previous.accounts], balances: { ...previous.balances }, journal: [...previous.journal], closings: [...previous.closings], stocktakes: [...(previous.stocktakes || [])] };
  if (!event || typeof event !== 'object' || Array.isArray(event) || !event.command || typeof event.command !== 'object' || Array.isArray(event.command)) fail('Geçersiz olay kaydı.');
  if (event.schemaVersion === 14 && (!['saleReturn','retailExchange'].includes(event.command.type) || !Object.hasOwn(event.command,'customerConsideration'))) fail('Cari iade karşılığı için geçerli bir işlem gerekli.');
  if (event.schemaVersion === 15 && (event.command.type !== 'retailExchange' || eventVersion(event.command, previous) !== 15)) fail('Eski peşin satışın müşteri bağlantısı doğrulanamadı.');
  if ([13,15].includes(event.schemaVersion) || (event.schemaVersion === 14 && event.command.type === 'retailExchange')) {
    if (!['retailExchange','undoExchange'].includes(event.command.type)) fail('Geçersiz değişim olayı.');
    eventActor(event);
    return applyExchange(previous, event, replayContext);
  }
  if ((event.schemaVersion === 16) !== scrapAdvanceTypes.has(event.command.type)) fail('Hurda borcu avans aktarımı için geçerli olay sürümü gerekli.');
  if (event.schemaVersion === 16) event = { ...event, schemaVersion:11 };
  const orderItem = (event.schemaVersion === 11 || (event.schemaVersion === 18 && orderFeature(event.command))) && usesInventory(event.command);
  if ((event.schemaVersion === 11 || (event.schemaVersion === 18 && orderFeature(event.command))) && Object.hasOwn(event,'saleInventoryVersion') && (event.saleInventoryVersion !== 1 || !orderItem)) {
    fail('Sipariş satışının tekil ürün sürümü geçersiz.');
  }
  // Early order-only ledgers had no serialized stock. The first combined writer
  // required a prior registration to accept a code. Later writers mark that intent explicitly.
  const inventoryTagged = event.schemaVersion === 8 || (event.schemaVersion === 14 && usesInventory(event.command)) || (orderItem && (event.saleInventoryVersion === 1 || !!s.inventoryItems?.length));
  if (event.schemaVersion === 8) {
    if (!usesInventory(event.command)) fail('Tekil ürün için geçersiz olay sürümü.');
    event = { ...event, schemaVersion: event.command.type === 'saleReturn' ? 9 : financialVersion(event.command, s) };
  }
  if (event.schemaVersion !== undefined && ![2, 3, 4, 5, 6, 7, 9, 11, 12, 14, 17, 18].includes(event.schemaVersion)) fail('Desteklenmeyen olay sürümü.');
  if ((event.schemaVersion === 11 && !orderFeature(event.command)) || (orderTypes.has(event.command.type) && ![11, 18].includes(event.schemaVersion))) fail('Sipariş işlemi için güncel olay sürümü gerekli.');
  if ((event.schemaVersion === 11 || (event.schemaVersion === 18 && orderFeature(event.command))) && event.audit?.actor?.role === 'employee') fail('Sipariş işlemi için yönetici gerekli.');
  if ((event.schemaVersion === 12) !== (event.command.type === 'linkScrapPurchase')) fail('Hurda alış bağlantısı için olay sürümü geçersiz.');
  if (event.schemaVersion === 9 && (event.command.type !== 'saleReturn' || !Object.hasOwn(event.command, 'outgoing'))) fail('Karma iade karşılıkları gerekli.');
  if (![7, 9, 14, 17, 18].includes(event.schemaVersion) && supplierUnitFeature(event.command, s)) fail('Bağlı toptancı veya saf gümüş için güncel olay sürümü gerekli.');
  if (event.schemaVersion === 7 && !supplierUnitFeature(event.command, s)) fail('Bu işlem için desteklenmeyen olay sürümü.');
  if (event.schemaVersion === 4 && !['close', 'settlement', 'saleReturn'].includes(event.command.type)) fail('Bu işlem için desteklenmeyen olay sürümü.');
  if (event.schemaVersion === 5 && legacyEventVersion(event.command, s) !== 5) fail('Bu işlem için desteklenmeyen olay sürümü.');
  if (event.schemaVersion === 6 && !(['close', 'stocktake', 'amend'].includes(event.command.type) || (['sale', 'purchase', 'collection'].includes(event.command.type) && (Object.hasOwn(event.command, 'received') || Object.hasOwn(event.command, 'given'))))) fail('Bu işlem için desteklenmeyen olay sürümü.');
  const c = event.command;
  const actor = eventActor(event);
  if (Object.hasOwn(c, 'parentAccountId') && c.type !== 'account') fail('Ana toptancı bağı yalnız hesap açılışında belirlenir.');
  text(event.id, 'İşlem anahtarı', 100);
  if (replayContext ? replayContext.has(event.id) : s.journal.some(x => x.id === event.id)) fail('Tekrarlanan işlem anahtarı.');
  if (c.type === 'supplierAmend') {
    if(Object.keys(c).some(key=>!['type','date','originalId','replacement','note'].includes(key)))fail('Düzeltme alanları geçersiz.');
    text(event.id,'Düzenleme anahtarı',90);
    const original=s.journal.find(entry=>entry.id===c.originalId);
    if(!original||!['supplierPurchase','supplierPayment','supplierAllocation','supplierOffset','supplierReturn'].includes(original.type))fail('Bu toptancı kaydı düzenlenemez.');
    if(!c.replacement||typeof c.replacement!=='object'||Array.isArray(c.replacement)||c.replacement.type!==original.type||c.replacement.supplierId!==original.meta.supplierId)fail('Düzeltme aynı firma ve işlem türüne ait olmalı.');
    const reason=text(c.note,'Düzeltme gerekçesi');
    const reversed=applyEvent(s,{...event,id:`${event.id}:undo`,command:{type:'supplierReverse',date:c.date,originalId:c.originalId,note:reason}},undefined,amendmentValidation);
    const revised=applyEvent(reversed,{...event,command:{...c.replacement,date:c.date}},undefined,amendmentValidation);
    for(const a of revised.accounts)if(a.kind==='asset'&&revised.balances[a.id]<0)fail(`${a.name}: yetersiz mevcut. Düzenleme bütünüyle reddedildi.`);
    checkReserved(revised);
    revised.journal.at(-2).meta.amendmentId=event.id;
    revised.journal.at(-1).meta.amendsOriginalId=original.id;
    revised.journal.at(-1).meta.editReason=reason;
    if(replayContext){Object.assign(previous,revised);replayContext.add(`${event.id}:undo`);replayContext.add(event.id);return previous;}
    return revised;
  }
  if (c.type === 'amend') {
    if (![5, 6, 7].includes(event.schemaVersion)) fail('İşlem düzenleme için güncel olay sürümü gerekli.');
    text(event.id, 'Düzenleme anahtarı', 90);
    const original = s.journal.find(entry => entry.id === c.originalId);
    if (!original || !editableTypes.has(original.type) || !original.editableCommand) fail('Bu işlem doğrudan düzenlenemez.');
    if (!c.replacement || typeof c.replacement !== 'object' || Array.isArray(c.replacement) || c.replacement.type !== original.type) fail('Düzenleme aynı işlem türünün yeni içeriğini taşımalı.');
    const reason = text(c.note, 'Düzenleme gerekçesi');
    // Build both legs on private copies: even direct reducer callers never see a partial amendment.
    const reversed = applyEvent(s, { ...event, id: `${event.id}:undo`, schemaVersion: 3, command: { type: 'reverse', date: c.date, originalId: c.originalId, note: reason } }, undefined, amendmentValidation);
    const replacement = { ...c.replacement, date: c.date };
    // v8 predates order and pricing metadata. Its replacement sale stays in the v8 dialect.
    const revised = applyEvent(reversed, { ...event, schemaVersion: inventoryTagged ? 8 : event.schemaVersion === 7 ? financialVersion(replacement, reversed) : event.schemaVersion === 6 ? priorEventVersion(replacement, reversed) : legacyEventVersion(replacement, reversed), command: replacement }, undefined, amendmentValidation);
    for (const a of revised.accounts) if (a.kind === 'asset' && revised.balances[a.id] < 0) fail(`${a.name}: yetersiz mevcut. Düzenleme bütünüyle reddedildi.`);
    checkReserved(revised);
    revised.journal.at(-2).meta.amendmentId = event.id;
    revised.journal.at(-1).meta.amendsOriginalId = original.id;
    revised.journal.at(-1).meta.editReason = reason;
    if (replayContext) { Object.assign(previous, revised); replayContext.add(`${event.id}:undo`); replayContext.add(event.id); return previous; }
    return revised;
  }
  const note = label => event.schemaVersion >= 5 && optionalNoteTypes.has(c.type) && c.category !== 'Açılış düzeltmesi' ? optionalText(c.note, label) : text(c.note, label);
  let orderChange, supplierChange;
  let entries = [], meta = {}, label = '', date = s.date;
  if (c.type === 'opening') {
    if (s.initialized) fail('Başlangıç devri zaten onaylandı.');
    date = validDate(c.date);
    if (!c.balances || typeof c.balances !== 'object' || Array.isArray(c.balances) || Object.keys(c.balances).some(id => !getAccountIndex(s.accounts).byId.has(id))) fail('Açılış hesapları geçersiz.');
    if (event.schemaVersion >= 5) {
      if (!Array.isArray(c.banks) || c.banks.length > 50) fail('Açılışta en çok 50 banka hesabı ekleyebilirsiniz.');
      for (const [index, bank] of c.banks.entries()) {
        if (!bank || typeof bank !== 'object' || Array.isArray(bank)) fail('Geçerli banka hesabı girin.');
        const name = text(bank.name, 'Banka adı', 70), unit = financialUnit(bank.unit);
        if (['HAS', 'SILVER'].includes(unit)) fail('Banka hesabında para birimi seçin.');
        if (getAccountIndex(s.accounts).unitNameTrTR.has(`${unit}\0${name.toLocaleLowerCase('tr-TR')}`)) fail('Aynı ad ve birimde banka zaten var.');
        const a = { id: `bank-${event.id}-${index}`, name, unit, physical: false, kind: 'asset', countPolicy: 'none', countGroup: 'gunluk', retired: false, isSaleable: false, isPurchasable: false, pairedGroups: [], owner: 'işletme', location: 'finansal hesap', bank: true };
        s.accounts.push(a); indexAddAccount(s.accounts, a); entries.push({ accountId: a.id, delta: quantity(bank.opening, unit) });
      }
    }
    for (const a of s.accounts) {
      if (a.id.startsWith(`bank-${event.id}-`)) continue;
      if (event.schemaVersion >= 3 && a.retired) {
        if (a.id in c.balances && quantity(c.balances[a.id], a.unit) !== 0) fail('Eski gram altın hesabına yeni açılış yapılamaz.');
        entries.push({ accountId: a.id, delta: 0 }); continue;
      }
      if (!(a.id in c.balances) && (a.introduced || 1) > (event.schemaVersion || 1)) { entries.push({ accountId: a.id, delta: 0 }); continue; }
      if (!(a.id in c.balances)) fail(`${a.name} açılışını girin; boş alan sıfır değildir.`);
      entries.push({ accountId: a.id, delta: quantity(c.balances[a.id], a.unit) });
    }
    if (event.schemaVersion >= 5 && quantity(c.balances.banka, 'TL') === 0) s.accounts = s.accounts.map(a => a.id === 'banka' ? { ...a, retired: true } : a);
    s.initialized = true; s.date = date; s.nominalUnconfirmed = !(event.schemaVersion >= 3); label = 'Başlangıç devri';
  } else {
    if (!s.initialized) fail('Önce başlangıç devrini onaylayın.');
    if (c.date !== s.date) fail('İşlem yalnız açık iş gününe yazılabilir. Ekranı yenileyin.');
    if (event.schemaVersion === 11 || (event.schemaVersion === 18 && orderFeature(c))) orderChange = prepareOrder(s, event);
    if (event.schemaVersion === 17 || (event.schemaVersion === 18 && isSupplierCommand(c))) {
      supplierChange = prepareSupplier(s,event,{stockLines,moneyAccount,partyProfile,optionalText,isReplay:Boolean(replayContext)});
      ({entries,meta,label} = supplierChange);
      if (supplierChange.addAccounts?.length) {
        for (const acc of supplierChange.addAccounts) { s.accounts.push(acc); indexAddAccount(s.accounts, acc); }
      }
      if (supplierChange.addAccount) { s.accounts.push(supplierChange.addAccount); indexAddAccount(s.accounts, supplierChange.addAccount); }
      else if (supplierChange.accounts) s.accounts = supplierChange.accounts;
    } else if (orderTypes.has(c.type)) {
      ({ entries, meta, label } = orderChange);
    } else if (inventoryTagged && c.type === 'registerItem') {
      label = 'Tekil ürün kaydı';
    } else if (inventoryTagged && c.type === 'itemCostSource') {
      label = c.source === null ? 'Ürün maliyet kaynağı kaldırıldı' : 'Ürün maliyet kaynağı kaydedildi';
    } else if (inventoryTagged && c.type === 'releaseItem') {
      label = 'Tekil ürün eşlemesi kaldırıldı'; meta = { note: text(c.note, 'Eşleme kaldırma gerekçesi') };
    } else if (c.type === 'linkScrapPurchase') {
      if (Object.keys(c).some(key => !['type','date','saleId','purchaseId'].includes(key))) fail('Hurda alış bağlantısı tutar veya ödeme içeremez.');
      text(c.purchaseId, 'Hurda alış kayıt numarası', 100);
      const resolveParty = scrapCustomerResolver(s);
      if (!priorScrapChoices(s,c.saleId,resolveParty).has(c.purchaseId)) fail('Aynı müşterinin satıştan önceki, etkin ve henüz bağlanmamış hurda alışını seçin.');
      const sale = s.journal.find(entry => entry.id === c.saleId);
      label = 'Önceki hurda alışı satışa bağlandı';
      meta = {purchaseId:c.purchaseId, saleId:c.saleId, counterpartyId:resolveParty(sale)};
    } else if (c.type === 'fundUpdate') {
      if (![5, 7].includes(event.schemaVersion)) fail('Ödeme hesabı düzenleme için güncel olay sürümü gerekli.');
      const a = moneyAccount(s, c.accountId), name = text(c.name, 'Hesap adı', 70);
      if (Object.keys(c).some(key => !['type','date','accountId','name'].includes(key))) fail('Yalnız ödeme hesabının adı düzenlenebilir.');
      if (s.accounts.some(other => other.id !== a.id && other.kind === 'asset' && other.unit === a.unit && other.name.toLocaleLowerCase('tr-TR') === name.toLocaleLowerCase('tr-TR'))) fail('Aynı ad ve birimde ödeme hesabı zaten var.');
      s.accounts = s.accounts.map(other => other.id === a.id ? { ...other, name } : other); label = 'Ödeme hesabı adı güncellendi'; meta = { accountId: a.id };
    } else if (c.type === 'accountUpdate') {
      if (![5, 7].includes(event.schemaVersion)) fail('Hesap düzenleme için güncel olay sürümü gerekli.');
      const a = account(s, c.accountId);
      if (a.kind !== 'receivable' || Object.keys(c).some(key => !['type','date','accountId','name','partyType','phone','taxId','address'].includes(key))) fail('Yalnız cari kişi bilgileri düzenlenebilir.');
      const name = text(c.name ?? a.name, 'Cari adı', 70), profile = partyProfile(c, a, true);
      const children = s.accounts.filter(child => child.parentAccountId === a.id);
      if (a.parentAccountId) fail('Bağlı hesap bilgilerini ana toptancı üzerinden düzenleyin.');
      if (children.length && profile.partyType !== 'supplier') fail('Bağlı hesapları olan toptancının türü değiştirilemez.');
      if (s.accounts.some(other => other.id !== a.id && other.unit === a.unit && other.name.toLocaleLowerCase('tr-TR') === name.toLocaleLowerCase('tr-TR'))) fail('Bu ad ve birimde cari zaten var.');
      if (a.partyType && a.partyType !== profile.partyType && s.journal.some(e => e.entries.some(row => row.accountId === a.id && row.delta !== 0))) fail('Hareketi bulunan hesabın müşteri/toptancı türü değiştirilemez.');
      for (const child of children) if (s.accounts.some(other => other.id !== child.id && other.unit === child.unit && other.name.toLocaleLowerCase('tr-TR') === name.toLocaleLowerCase('tr-TR'))) fail('Bu ad ve birimde cari zaten var.');
      s.accounts = s.accounts.map(other => other.id === a.id || other.parentAccountId === a.id ? { ...other, name, ...profile } : other);
      label = 'Cari bilgileri güncellendi'; meta = { accountId: a.id };
    } else if (c.type === 'stockAccount') {
      if (event.schemaVersion !== 5) fail('Stok kartı için güncel olay sürümü gerekli.');
      const name = text(c.name, 'Stok adı', 70).toLocaleUpperCase('tr-TR'), unit = c.unit;
      if (!['GRAM','ADET'].includes(unit)) fail('Stok birimi adet veya gram olmalı.');
      if (c.isSaleable !== undefined && typeof c.isSaleable !== 'boolean') fail('Stok satış seçeneği geçersiz.');
      if (getAccountIndex(s.accounts).upperNames.has(name)) fail('Bu stok adı zaten var.');
      const pairedGroups = c.pairedGroups ?? [];
      if (!Array.isArray(pairedGroups) || pairedGroups.length > 3 || new Set(pairedGroups).size !== pairedGroups.length || pairedGroups.some(id => !['bilezik22','taki14','taki22'].includes(id)) || (unit !== 'ADET' && pairedGroups.length)) fail('Geçerli bağlı terazi grupları seçin.');
      const opening = quantity(c.opening ?? '0', unit);
      if (pairedGroups.length && opening) fail('Bağlı stok kartı sıfır açılır; adet ve gramı birlikte stok girişinden kaydedin.');
      const countPolicy = c.countPolicy ?? (unit === 'ADET' ? 'daily' : 'periodic');
      if (!['daily','periodic'].includes(countPolicy) || (unit === 'ADET' && countPolicy !== 'daily')) fail('Adet stokları günlük sayılmalı.');
      const a = { id: `stock-${event.id}`, name, unit, physical: true, kind: 'asset', retired: false, isSaleable: c.isSaleable !== false, isPurchasable: true, pairedGroups: [...pairedGroups], countPolicy, countGroup: countPolicy === 'daily' ? 'gunluk' : 'stok', owner: 'işletme', location: 'dükkân', displayOrder: 90 };
      s.accounts.push(a); indexAddAccount(s.accounts, a); entries = [{ accountId: a.id, delta: opening }]; label = 'Stok kartı açılışı'; meta = { accountId: a.id };
    } else if (c.type === 'stockUpdate') {
      if (event.schemaVersion !== 5) fail('Stok düzenleme için güncel olay sürümü gerekli.');
      const a = account(s, c.accountId), name = text(c.name, 'Stok adı', 70).toLocaleUpperCase('tr-TR');
      if (!a.physical || !['GRAM','ADET'].includes(a.unit) || a.retired || Object.keys(c).some(key => !['type','date','accountId','name'].includes(key))) fail('Yalnız etkin stok kartının adı düzenlenebilir.');
      if (s.accounts.some(other => other.id !== a.id && other.name.toLocaleUpperCase('tr-TR') === name)) fail('Bu stok adı zaten var.');
      s.accounts = s.accounts.map(other => other.id === a.id ? { ...other, name } : other); label = 'Stok adı güncellendi'; meta = { accountId: a.id };
    } else if (c.type === 'nominalOpening') {
      if (event.schemaVersion !== 3 || !s.nominalUnconfirmed) fail('Gram altın toplamı zaten onaylı; yeni açılış yerine gerekçeli düzeltme kullanın.');
      const actual = quantity(c.quantity, 'GRAM');
      entries = [{ accountId: 'gramToplam', delta: actual - (s.balances.gramToplam || 0) }];
      s.nominalUnconfirmed = false;
      label = 'Gram altın toplamı onayı'; meta = { note: text(c.note, 'Mevcut toplam onay gerekçesi'), revenue: 0 };
    } else if (c.type === 'fundAccount') {
      const name = text(c.name, 'Kasa / banka / has hesabı adı', 70), unit = financialUnit(c.unit);
      if (typeof c.physical !== 'boolean') fail('Fiziki kasa veya banka/diğer hesap seçin.');
      if (unit === 'SILVER' && !c.physical) fail('Saf gümüş için fiziki kasa veya cari hesap kullanın.');
      if (getAccountIndex(s.accounts).assetUnitNameTr.has(`${unit}\0${name.toLocaleLowerCase('tr')}`)) fail('Bu ad ve birimde ödeme hesabı zaten var.');
      const a = { id: `fund-${event.id}`, name, unit, physical: c.physical, countPolicy: c.physical ? unit === 'HAS' ? 'periodic' : 'daily' : 'none', countGroup: c.physical && unit === 'HAS' ? 'ana-terazi' : 'gunluk', kind: 'asset', retired: false, isSaleable: false, isPurchasable: false, pairedGroups: [], owner: 'işletme', location: c.physical ? 'dükkân' : 'finansal hesap' };
      s.accounts.push(a); indexAddAccount(s.accounts, a);
      entries = [{ accountId: a.id, delta: quantity(c.opening, unit) }];
      const createdSupplierUnitIds = [];
      if (event.schemaVersion === 18 && c.autoSupplierUnits === true) {
        for (const firm of supplierFirms(s)) {
          const firmIds = new Set(supplierAccountIds(s, firm.id));
          if (s.accounts.some(other => firmIds.has(other.id) && other.unit === unit)) continue;
          const unitAcc = { id: `supplier-unit-${event.id}-${firm.id}-${unit}`, name: firm.name, unit, physical: false, kind: 'receivable', partyType: 'supplier', supplierId: firm.id, phone: firm.phone, taxId: firm.taxId, address: firm.address, owner: 'işletme', location: 'cari hesap' };
          s.accounts.push(unitAcc); indexAddAccount(s.accounts, unitAcc);
          entries.push({ accountId: unitAcc.id, delta: 0 });
          createdSupplierUnitIds.push(unitAcc.id);
        }
      }
      label = 'Ödeme hesabı açılışı'; meta = { accountId: a.id, ...(createdSupplierUnitIds.length ? { createdAccountIds: createdSupplierUnitIds } : {}), note: 'Özgün birim bakiyesiyle yeni ödeme hesabı açıldı.' };
    } else if (c.type === 'account') {
      const parent = Object.hasOwn(c, 'parentAccountId') ? account(s, text(c.parentAccountId, 'Ana toptancı hesabı', 160)) : null;
      if (parent && (parent.kind !== 'receivable' || parent.partyType !== 'supplier' || parent.parentAccountId)) fail('Alt hesap için ana toptancı hesabını seçin.');
      if (parent && c.partyType !== undefined && c.partyType !== 'supplier') fail('Bağlı hesap toptancı türünde olmalı.');
      const name = text(parent ? parent.name : c.name, 'Cari adı', 70);
      financialUnit(c.unit);
      if (parent && s.accounts.some(a => (a.id === parent.id || a.parentAccountId === parent.id) && a.unit === c.unit)) fail('Bu toptancının aynı birimde hesabı zaten var.');
      if (getAccountIndex(s.accounts).unitNameTr.has(`${c.unit}\0${name.toLocaleLowerCase('tr')}`)) fail('Bu ad ve birimde cari zaten var.');
      const a = { id: `cari-${event.id}`, name, unit: c.unit, physical: false, kind: 'receivable', owner: 'işletme', location: 'cari hesap', ...(event.schemaVersion >= 5 ? partyProfile(parent || c) : {}), ...(parent ? { parentAccountId: parent.id } : {}) };
      s.accounts.push(a); indexAddAccount(s.accounts, a);
      entries = [{ accountId: a.id, delta: quantity(c.opening, a.unit, { signed: true }) }];
      label = 'Cari açılışı'; meta = { accountId: a.id };
    } else if (c.type === 'sale') {
      let total, lines = [], legacyCategory;
      if (event.schemaVersion === undefined && !c.items) {
        const outgoing = account(s, c.outAccount);
        if (!outgoing.physical || !['GRAM', 'ADET'].includes(outgoing.unit)) fail('Satılan ürün hesabını seçin.');
        const amount = quantity(c.outQuantity, outgoing.unit, { zero: false });
        total = quantity(c.total, 'TL', { zero: false });
        entries.push({ accountId: outgoing.id, delta: -amount });
        legacyCategory = c.productCategory || outgoing.name;
      } else {
        const result = stockLines(s, c.items, -1, true, event.schemaVersion);
        entries = result.entries; lines = result.lines; total = result.total;
      }
      if ([6, 7, 11, 18].includes(event.schemaVersion)) {
        const applied = orderChange?.meta.advanceAppliedTL || 0;
        if (applied > total && event.schemaVersion !== 18) fail('Avans mahsubu satış bedelini aşamaz.');
        const exchange = exchangeTrade(s, c, total - exchangeAppliedTL, false, [7, 18].includes(event.schemaVersion), applied);
        entries.push(...exchange.entries);
        label = 'Karma satış'; meta = { revenue: total, lines, scrapValue: 0, scrapLines: [], costKnown: false, ...exchange.meta, note: note('İşlem açıklaması') };
      } else {
      let scrapValue = 0, scrapLines = [];
      if (event.schemaVersion >= 5 && Object.hasOwn(c, 'scrap')) {
        if (Object.hasOwn(c, 'scrapQuantity') || Object.hasOwn(c, 'scrapValue')) fail('Hurda satırları ile eski hurda alanları birlikte kullanılamaz.');
        if (!Array.isArray(c.scrap) || c.scrap.length > 30) fail('En çok 30 hurda ödeme satırı girin.');
        for (const row of c.scrap) {
          if (!row || typeof row !== 'object' || Array.isArray(row)) fail('Geçerli hurda ödeme satırı girin.');
          const a = account(s, row.accountId);
          if (!a.scrap || a.retired || a.unit !== 'GRAM') fail('Hurda ödemesi için ayarlı hurda hesabı seçin.');
          const amount = quantity(row.quantity, 'GRAM', { zero: false }), valueTL = quantity(row.valueTL, 'TL', { zero: false });
          scrapValue += valueTL;
          if (!Number.isSafeInteger(scrapValue) || scrapValue > 1e12) fail('Hurda toplamı miktar sınırını aşıyor.');
          entries.push({ accountId: a.id, delta: amount }); scrapLines.push({ accountId: a.id, quantity: amount, valueTL });
        }
      } else {
        const scrapQty = quantity(c.scrapQuantity, 'GRAM');
        scrapValue = quantity(c.scrapValue, 'TL');
        if ((scrapQty > 0) !== (scrapValue > 0)) fail('Hurda gramı ve anlaşılmış TL bedeli birlikte girilmeli.');
        if (scrapQty) entries.push({ accountId: 'hurda22', delta: scrapQty });
      }
      let credit, paymentLines = [], creditLines = [];
      if (c.payments !== undefined || c.credits !== undefined) {
        noMixedPayments(c, ['cash', 'pos', 'bank', 'customerAccount', 'debts']);
        const payment = allocations(s, c.payments === undefined ? [] : c.payments, 'asset', 1, true);
        const receivable = allocations(s, c.credits === undefined ? [] : c.credits, 'receivable', 1);
        if (event.schemaVersion >= 5) for (const row of receivable.lines) assertParty(s, row.accountId, 'customer');
        if (payment.total + receivable.total + scrapValue !== total) fail('Satış bedeli, hurda ve ödeme/cari satırlarının anlaşılmış TL toplamına eşit olmalı.');
        entries.push(...payment.entries, ...receivable.entries);
        paymentLines = payment.lines; creditLines = receivable.lines; credit = receivable.total;
      } else {
        const cash = quantity(c.cash, 'TL'), pos = quantity(c.pos, 'TL'), bank = quantity(c.bank, 'TL');
        if (bank) moneyAccount(s, 'banka');
        credit = total - scrapValue - cash - pos - bank;
        if (credit < 0) fail('Ödeme toplamı satış tutarını aşıyor. Para üstü bu ilk sürümde ayrı hareket gerektirir.');
        for (const [accountId, delta] of [['nakit', cash], ['pos', pos], ['banka', bank]]) if (delta) entries.push({ accountId, delta });
        if (credit) {
          const customer = account(s, c.customerAccount);
          if (event.schemaVersion >= 5) assertParty(s, c.customerAccount, 'customer');
          if (customer.kind !== 'receivable' || customer.unit !== 'TL') fail('Kalan tutar için TL müşteri carisi seçin.');
          entries.push({ accountId: customer.id, delta: credit });
        }
      }
      label = 'Karma satış'; meta = { revenue: total, scrapValue, credit, lines, paymentLines, creditLines, ...(event.schemaVersion >= 5 ? { scrapLines } : {}), ...(legacyCategory ? { productCategory: legacyCategory, legacySingleDimension: true } : {}), costKnown: false, note: note('İşlem açıklaması') };
      }
    } else if (c.type === 'saleReturn') {
      const mixed = [9,14].includes(event.schemaVersion);
      if (![4, 7, 9, 14].includes(event.schemaVersion)) fail('Satış iadesi için güncel olay sürümü gerekli.');
      const original = s.journal.find(event => event.id === c.originalId);
      if (!original || original.type !== 'sale' || !original.meta.lines?.length) fail('Satırları izlenebilen özgün satış kaydını seçin.');
      if (mixed && original.meta.counterpartyType === 'supplier') fail('Karma iade yalnız müşteri satışına bağlanabilir.');
      if (s.journal.some(event => event.type === 'reverse' && event.meta.originalId === original.id)) fail('Ters çevrilmiş satış için iade yapılamaz.');
      if (!Array.isArray(c.items) || !c.items.length || c.items.length > 30) fail('İade için 1–30 özgün ürün satırı seçin.');
      const used = new Map(), selected = new Set(), lines = [];
      for (const prior of activeSaleReturns(s, original.id)) {
        for (const line of prior.meta.lines) {
          const totals = used.get(line.lineIndex) || { quantity: 0, weight: 0 };
          totals.quantity += line.quantity; totals.weight += line.weight;
          used.set(line.lineIndex, totals);
        }
      }
      let total = 0;
      for (const item of c.items) {
        if (!item || typeof item !== 'object' || Array.isArray(item) || !Number.isInteger(item.lineIndex) || item.lineIndex < 0 || item.lineIndex >= original.meta.lines.length || selected.has(item.lineIndex)) fail('Her özgün satış satırını iade içinde yalnız bir kez seçin.');
        selected.add(item.lineIndex);
        const source = original.meta.lines[item.lineIndex], a = account(s, source.accountId), returned = used.get(item.lineIndex) || { quantity: 0, weight: 0 };
        if (a.retired || (source.weightAccount && account(s, source.weightAccount).retired)) fail('Eski paket/ağırlık hesabına yeni iade yazılamaz. Otomatik nominal gram dönüşümü yapılmaz.');
        const q = quantity(item.quantity, a.unit, { zero: false }), remainingQuantity = source.quantity - returned.quantity;
        if (q > remainingQuantity) fail('İade miktarı bu satırın kalan satılmış miktarını aşamaz.');
        let weight = 0;
        if (source.weightAccount) {
          weight = quantity(item.weight, 'GRAM', { zero: false });
          const remainingWeight = source.weight - returned.weight;
          if (weight > remainingWeight || (q === remainingQuantity && weight !== remainingWeight) || (q < remainingQuantity && weight >= remainingWeight)) fail('İade adedi ve gramı özgün satırın kalan miktarlarıyla tutarlı olmalı. Son adetlerle kalan gramın tamamı iade edilir.');
          entries.push({ accountId: source.weightAccount, delta: weight });
        } else if (item.weight !== undefined && item.weight !== '') fail('Bu ürün için ikinci gram hesabı girilmez.');
        const value = quantity(item.value, 'TL');
        total += value;
        if (!Number.isSafeInteger(total) || total > 1e12) fail('Toplam iade bedeli miktar sınırını aşıyor.');
        entries.push({ accountId: a.id, delta: q });
        lines.push({ lineIndex: item.lineIndex, accountId: a.id, quantity: q, weightAccount: source.weightAccount, weight, value });
      }
      if (mixed && Object.hasOwn(c, 'refunds')) fail('Eski iade ödemesi ve karma karşılıklar birlikte kullanılamaz.');
      const refund = mixed ? exchangeAssets(s, c.outgoing, -1) : allocations(s, c.refunds, 'asset', -1);
      if (mixed && refund.lines.some(row => row.kind === 'stock' && !account(s, row.accountId).isSaleable)) fail('İade karşılığı için satılabilir ürün seçin.');
      const cari = event.schemaVersion === 14 ? returnCustomerConsideration(s,original,c.customerConsideration) : null;
      if (refund.total + (cari?.total || 0) + exchangeAppliedTL !== total) fail('Anlaşılmış iade bedeli ile çıkan ödeme satırlarının TL karşılıkları eşit olmalı.');
      entries.push(...refund.entries, ...(cari?.entries || []));
      label = 'Satış iadesi'; meta = { originalId: original.id, lines, refunds: refund.lines, ...(cari && { customerConsideration:cari.lines, counterpartyId:cari.partyId }), returnTotal: total, revenue: total ? -total : 0, note: text(c.note, 'İade açıklaması / referans') };
    } else if (c.type === 'purchase') {
      if (!['customer', 'supplier'].includes(c.source)) fail('Alış kaynağı müşteri veya toptancı/bayi olmalı.');
      const counterpartyId = event.schemaVersion >= 5 ? optionalText(c.counterpartyId, 'Ödenen cari', 160) : '';
      if (counterpartyId) assertParty(s, counterpartyId, c.source);
      if (c.pos !== undefined && quantity(c.pos, 'TL') !== 0) fail('Alış ödemesinde POS alacağı kullanılamaz.');
      const result = stockLines(s, c.items, 1, true, event.schemaVersion, true);
      entries = result.entries;
      if ([6, 7].includes(event.schemaVersion)) {
        const exchange = exchangeTrade(s, c, result.total, true, event.schemaVersion === 7);
        entries.push(...exchange.entries);
        label = c.source === 'customer' ? 'Müşteriden alış' : 'Toptancı / bayiden alış';
        meta = { purchaseTotal: result.total, source: c.source, lines: result.lines, ...exchange.meta, note: note('Alış açıklaması / belge referansı'), revenue: 0 };
      } else {
      let paid, outstanding, paymentLines = [], debtLines = [];
      if (c.payments !== undefined || c.debts !== undefined) {
        noMixedPayments(c, ['cash', 'pos', 'bank', 'counterpartyAccount', 'credits']);
        const payment = allocations(s, c.payments === undefined ? [] : c.payments, 'asset', -1);
        const payable = allocations(s, c.debts === undefined ? [] : c.debts, 'receivable', -1);
        if (event.schemaVersion >= 5) for (const row of payable.lines) assertParty(s, row.accountId, c.source);
        if (payment.total + payable.total !== result.total) fail('Alış bedeli, ödeme ve borç satırlarının anlaşılmış TL toplamına eşit olmalı.');
        entries.push(...payment.entries, ...payable.entries);
        paid = payment.total; outstanding = payable.total; paymentLines = payment.lines; debtLines = payable.lines;
      } else {
        const cash = quantity(c.cash, 'TL'), bank = quantity(c.bank, 'TL');
        if (bank) moneyAccount(s, 'banka');
        paid = cash + bank; outstanding = result.total - paid;
        if (outstanding < 0) fail('Alış ödemesi toplam alış bedelini aşıyor.');
        if (cash) entries.push({ accountId: 'nakit', delta: -cash });
        if (bank) entries.push({ accountId: 'banka', delta: -bank });
        if (outstanding) {
          const counterparty = account(s, c.counterpartyAccount);
          if (event.schemaVersion >= 5) assertParty(s, c.counterpartyAccount, c.source);
          if (counterparty.kind !== 'receivable' || counterparty.unit !== 'TL') fail('Kalan alış borcu için TL cari seçin.');
          entries.push({ accountId: counterparty.id, delta: -outstanding });
        }
      }
      label = c.source === 'customer' ? 'Müşteriden alış' : 'Toptancı / bayiden alış';
      meta = { purchaseTotal: result.total, paid, outstanding, source: c.source, lines: result.lines, paymentLines, debtLines, ...(event.schemaVersion >= 5 ? { counterpartyId } : {}), note: note('Alış açıklaması / belge referansı'), revenue: 0 };
      }
    } else if (c.type === 'stock') {
      if (!['in', 'out'].includes(c.direction)) fail('Stok yönü geçersiz.');
      if (!['Stok girişi', 'Sermaye', 'İşletmeden çekiş'].includes(c.category) || (c.category !== 'İşletmeden çekiş' && c.direction !== 'in') || (c.category === 'İşletmeden çekiş' && c.direction !== 'out')) fail('Stok nedeni ve yönü uyumsuz.');
      const result = stockLines(s, c.items, c.direction === 'in' ? 1 : -1, false, event.schemaVersion);
      entries = result.entries; label = c.category;
      meta = { lines: result.lines, note: note('Stok hareket gerekçesi'), revenue: 0 };
    } else if (c.type === 'movement') {
      const a = account(s, c.accountId);
      if (event.schemaVersion >= 3 && a.retired) fail('Eski gram altın hesabı yeni harekete kapalı.');
      if (event.schemaVersion >= 3 && a.id === 'gramToplam' && s.nominalUnconfirmed) fail('Önce gram altının mevcut toplamını açıkça onaylayın.');
      if (!['in', 'out'].includes(c.direction)) fail('Giriş veya çıkış seçin.');
      if (!['Sermaye', 'İşletmeden çekiş', 'Stok girişi', 'Gider', 'Cari tahsilat/ödeme', 'Açılış düzeltmesi'].includes(c.category)) fail('Hareket nedeni geçersiz.');
      const q = quantity(c.quantity, a.unit, { zero: false });
      if (c.category === 'Cari tahsilat/ödeme') fail('Cari işlemi için bağlı tahsilat/ödeme formunu kullanın.');
      if (event.schemaVersion >= 2 && c.category !== 'Açılış düzeltmesi' && ((a.pairedGroups?.length || 0) > 0 || getAccountIndex(s.accounts).pairedTargets.has(a.id))) fail('Bu ürün adet ve gram birlikte izlenir. Bağlı stok girişi/çıkışı formunu kullanın.');
      if (a.kind === 'receivable' && c.category !== 'Açılış düzeltmesi') fail('Cari bakiyesi yalnız bağlı tahsilat/ödeme veya gerekçeli açılış düzeltmesiyle değiştirilebilir.');
      if (c.category === 'Stok girişi' && (!a.physical || !['GRAM', 'ADET'].includes(a.unit) || c.direction !== 'in')) fail('Stok girişi fiziksel ürün hesabına giriş olmalı.');
      if (c.category === 'Gider') {
        if (event.schemaVersion >= 5) moneyAccount(s, a.id);
        if ((event.schemaVersion < 5 && !['nakit', 'banka'].includes(a.id)) || c.direction !== 'out') fail('Gider, kasa veya banka hesabından çıkış olmalı.');
      }
      if (c.category === 'Sermaye' && (c.direction !== 'in' || a.id === 'pos')) fail('Sermaye, işletme varlığına giriş olmalı; POS tahsilatı değildir.');
      if (c.category === 'İşletmeden çekiş' && (c.direction !== 'out' || a.id === 'pos')) fail('İşletmeden çekiş varlık çıkışı olmalı; POS hareketi değildir.');
      entries = [{ accountId: a.id, delta: q * (c.direction === 'in' ? 1 : -1) }];
      label = c.category; meta = { note: note('Gerekçe'), expense: c.category === 'Gider' && a.unit === 'TL' && c.direction === 'out' ? q : 0 };
    } else if (c.type === 'collection') {
      if (event.schemaVersion === 6 || (event.schemaVersion === 7 && (Object.hasOwn(c, 'received') || Object.hasOwn(c, 'given')))) {
        noMixedPayments(c, ['items', 'target', 'direction', 'quantity']);
        if (!c.counterpartyId) fail('Tahsilat/ödeme için işlem carisi seçin.');
        const exchange = exchangeTrade(s, c, 0, false, event.schemaVersion === 7);
        const ids = event.schemaVersion === 7 ? [...new Set([...exchange.meta.creditLines, ...exchange.meta.debtLines].map(row => row.accountId))] : [c.counterpartyId];
        if (!ids.length) fail('Tahsilat/ödeme için cari karşılık gerekli.');
        const deltas = ids.map(id => {
          const delta = exchange.entries.filter(row => row.accountId === id).reduce((sum,row)=>sum+row.delta,0), balance = s.balances[id] || 0;
          if (!delta || !Number.isSafeInteger(delta) || delta * Math.sign(balance) >= 0 || Math.abs(delta) > Math.abs(balance)) fail('Tahsilat/ödeme mevcut cari borç veya alacağını kapatma yönünde olmalı ve aşmamalı.');
          return delta;
        });
        entries = exchange.entries; label = deltas.every(delta => delta < 0) ? 'Cari tahsilat' : deltas.every(delta => delta > 0) ? 'Cari ödeme' : 'Cari tahsilat / ödeme';
        meta = { ...exchange.meta, revenue: 0, note: note('Açıklama') };
      } else {
      const a = account(s, c.customerAccount);
      const target = moneyAccount(s, c.target);
      if (a.kind !== 'receivable' || a.unit !== target.unit) fail('Cari ve ödeme hesabının özgün birimi aynı olmalı; burada kur dönüşümü yapılmaz.');
      financialUnit(a.unit);
      if (!['collect', 'pay'].includes(c.direction)) fail('Cari işlem yönü geçersiz.');
      const q = quantity(c.quantity, a.unit, { zero: false });
      const balance = s.balances[a.id] || 0;
      if ((c.direction === 'collect' && (balance <= 0 || q > balance)) || (c.direction === 'pay' && (balance >= 0 || q > -balance))) fail('Tutar mevcut cari borç/alacağını aşamaz. Avans bu ilk sürümde desteklenmiyor.');
      const sign = c.direction === 'collect' ? 1 : -1;
      entries = [{ accountId: a.id, delta: -sign * q }, { accountId: c.target, delta: sign * q }];
      label = c.direction === 'collect' ? 'Cari tahsilat' : 'Cari ödeme'; meta = { note: note('Açıklama') };
      }
    } else if (c.type === 'transfer') {
      const from = moneyAccount(s, c.fromAccount), to = moneyAccount(s, c.toAccount);
      if (from.id === to.id || from.unit !== to.unit) fail('Transfer farklı ve aynı birimli iki ödeme hesabı arasında olmalı. Kur dönüşümü yapılmaz.');
      const q = quantity(c.quantity, from.unit, { zero: false });
      entries = [{ accountId: from.id, delta: -q }, { accountId: to.id, delta: q }];
      label = 'Kasa / banka transferi'; meta = { note: note('Transfer açıklaması'), revenue: 0 };
    } else if (c.type === 'settlement') {
      const gross = quantity(c.gross, 'TL', { zero: false }), fee = quantity(c.fee, 'TL');
      if (fee > gross) fail('Komisyon POS tutarından büyük olamaz.');
      // Legacy events ignored extra destination fields; only v4 opts into the
      // chosen-bank meaning so an older application rejects instead of misposting.
      const bankId = event.schemaVersion >= 4 && Object.hasOwn(c, 'bankAccount') ? c.bankAccount : 'banka';
      const bank = moneyAccount(s, bankId);
      if (bank.unit !== 'TL' || bank.physical) fail('POS için fiziki olmayan TL banka hesabı seçin.');
      entries = [{ accountId: 'pos', delta: -gross }, { accountId: bank.id, delta: gross - fee }];
      label = 'POS bankaya geçti'; meta = { expense: fee, note: note('Banka/valör açıklaması'), ...(event.schemaVersion >= 4 ? { bankAccount: bank.id } : {}) };
    } else if (c.type === 'reverse') {
      assertSupplierUndoAllowed(s,c.originalId);
      const original = s.journal.find(x => x.id === c.originalId);
      if (original?.meta.exchangeId && validationMode !== exchangeUndo) fail('Değişimin iki kaydı birlikte geri alınmalıdır.');
      for (const row of original?.meta.customerConsideration || []) {
        if (row.action === 'grantCredit' && Math.min(row.quantity, Math.max(0, -row.after)) > Math.max(0,-(s.balances[row.accountId] || 0))) fail('İade ile tanınan müşteri alacağı kullanılmış. Ödeme ve mahsup kayıtlarını kontrol edin.');
      }
      if ((s.customerOrders || []).some(order => order.advances.some(a => a.sourcePurchaseId === c.originalId && a.receivedTL > (a.returnedToPayableTL || 0)))) fail('Bu alıştan avansa ayrılmış tutar var. Kullanılmamış aktarımı geri alın; ödenmiş veya satışta kullanılmış tutarı önce bağlantılı işlemlerde kontrol edin.');
      if (original?.meta.orderId) fail('Siparişe bağlı işlem doğrudan ters çevrilemez.');
      if (!original || !['sale', 'saleReturn', 'purchase', 'stock', 'movement', 'collection', 'transfer', 'settlement','linkScrapPurchase'].includes(original.type)) fail('Bu kayıt ters çevrilemez.');
      if (s.journal.some(x => x.type === 'reverse' && x.meta.originalId === original.id)) fail('İşlem zaten ters çevrilmiş.');
      if (original.type === 'sale' && activeSaleReturns(s, original.id).length) fail('Aktif iadesi bulunan satış bütünüyle ters çevrilemez. Önce bağlı iadeleri kontrol edin.');
      entries = original.entries.map(e => ({ ...e, delta: -e.delta }));
      label = original.type === 'linkScrapPurchase' ? 'Hurda alış bağlantısı iptali' : 'Bağlı ters kayıt'; meta = { originalId: original.id, ...(original.meta.counterpartyId ? { counterpartyId: original.meta.counterpartyId } : {}), revenue: -(original.meta.revenue || 0), purchaseTotal: -(original.meta.purchaseTotal || 0), expense: -(original.meta.expense || 0), note: text(c.note, 'İptal/ters kayıt gerekçesi') };
    } else if (c.type === 'stocktake') {
      if (![3, 6, 7, 18].includes(event.schemaVersion)) fail('Dönemsel tartım için güncel sürüm gerekli.');
      const selected = Object.keys(c.counts || {});
      const policy = a => event.schemaVersion === 18 ? currentCountPolicy(a) : [6, 7].includes(event.schemaVersion) ? (a.unit === 'SILVER' ? a.countPolicy : currentCountPolicy(a)) : a.countPolicy;
      const allowed = getAccountIndex(s.accounts).physicalAccounts.filter(a => !a.retired && policy(a) === 'periodic');
      if (!selected.length || typeof c.counts !== 'object' || Array.isArray(c.counts) || selected.some(id => !allowed.some(a => a.id === id))) fail('Yalnız tartılan dönemsel gram hesaplarını seçin; en az bir tartım gerekli.');
      const rows = [];
      for (const id of selected) {
        const a = account(s, id), counted = quantity(c.counts[id], a.unit), expected = s.balances[id] || 0, difference = counted - expected;
        const reason = difference ? text(c.reasons?.[id], a.name + ' fark gerekçesi') : '';
        rows.push({ accountId: id, expected, counted, difference, reason });
        if (difference) entries.push({ accountId: id, delta: difference });
      }
      const approvedBy = text(c.approvedBy, 'Tartımı onaylayan');
      s.stocktakes.push({ id: event.id, date: s.date, counts: rows, approvedBy, ...(actor && { approvedById: actor.id }) });
      label = 'Dönemsel terazi sayımı'; meta = { counts: rows, approvedBy, note: 'Yalnız tartılan gram havuzları karşılaştırıldı; günlük adetler ve açık gün değişmedi.' };
    } else if (c.type === 'close') {
      const modern = event.schemaVersion >= 3;
      if (modern && s.nominalUnconfirmed) fail('Gün kapanışından önce gram altının mevcut toplamını açıkça onaylayın.');
      const policy = a => event.schemaVersion === 18 ? currentCountPolicy(a) : [6, 7].includes(event.schemaVersion) ? (a.unit === 'SILVER' ? a.countPolicy : currentCountPolicy(a)) : a.countPolicy;
      const allowed = getAccountIndex(s.accounts).physicalAccounts.filter(a => !modern || (!a.retired && policy(a) === 'daily'));
      if (!c.counts || typeof c.counts !== 'object' || Array.isArray(c.counts) || Object.keys(c.counts).some(id => !allowed.some(a => a.id === id))) fail('Günlük sayım hesapları geçersiz. Terazi gramları için dönemsel tartım formunu kullanın.');
      const countRows = [];
      for (const a of allowed) {
        if (!(a.id in c.counts) && (a.introduced || 1) > (event.schemaVersion || 1)) continue;
        if (!(a.id in c.counts)) fail(`${a.name}: sayım boş bırakılamaz.`);
        const counted = quantity(c.counts[a.id], a.unit), expected = s.balances[a.id] || 0, difference = counted - expected;
        const reason = difference ? text(c.reasons?.[a.id], `${a.name} fark gerekçesi`) : '';
        countRows.push({ accountId: a.id, counted, expected, difference, reason });
        if (difference) entries.push({ accountId: a.id, delta: difference });
      }
      const carried = modern ? getAccountIndex(s.accounts).physicalAccounts.filter(a => !a.retired && policy(a) === 'periodic').map(a => ({ accountId: a.id, expected: s.balances[a.id] || 0, counted: null, status: 'not-counted' })) : [];
      const next = new Date(`${s.date}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
      const nextDate = validDate(event.schemaVersion >= 4 && Object.hasOwn(c, 'nextDate') ? c.nextDate : next.toISOString().slice(0, 10));
      if (nextDate <= s.date) fail('Sonraki iş günü açık iş gününden sonra olmalı.');
      s.closings.push({ id: event.id, date: s.date, nextDate, counts: countRows, carried, approvedBy: text(c.approvedBy, 'Sayımı onaylayan'), ...(actor && { approvedById: actor.id }) });
      s.date = nextDate;
      label = modern ? 'Günlük sayım ve kapanış' : 'Sayım ve gün kapanışı';
      meta = { counts: countRows, carried, nextDate, note: modern ? 'Günlük sayım kaydedildi; terazi gramları tartılmadan hesaplanan bakiyeyle devredildi.' : 'Farklar açıklamalı düzeltme olarak işlendi; bakiyeler taşındı.' };
    } else fail('Bilinmeyen işlem türü.');
  }
  applyInventory(s, event, meta, inventoryTagged, entries, validationMode);
  entriesApply(s, entries, validationMode);
  if (validationMode !== amendmentValidation) checkReserved(s);
  if (orderChange) {
    s.customerOrders = orderChange.orders;
    if (c.type === 'sale') {
      Object.assign(meta, { orderId: orderChange.meta.orderId, advanceAppliedTL: orderChange.meta.advanceAppliedTL,
        advanceAllocations: orderChange.meta.advanceAllocations });
    }
  }
  if (supplierChange?.firms) s.supplierFirms = supplierChange.firms;
  let editableCommand;
  if([17,18].includes(event.schemaVersion) && ['supplierPurchase','supplierPayment','supplierAllocation','supplierOffset','supplierReturn'].includes(c.type)) editableCommand=structuredClone(c);
  if (!orderChange && editableTypes.has(c.type) && !(c.type === 'sale' && !c.items)) {
    editableCommand = structuredClone(c);
    if (c.type === 'sale') {
      // The editor may submit this draft again under today's dialect.
      // Expose only extensions recognized by the captured event.
      delete editableCommand.salePricing; // v10 adds its validated snapshot after the base event.
      delete editableCommand.orderSettlement; // An applied order settlement is never directly editable.
      if (!inventoryTagged) for (const row of editableCommand.items) delete row.inventoryCode;
    }
  }
  s.journal.push({ id: event.id, date, timestamp: event.timestamp, type: c.type, label, entries, meta, ...(actor && { actor }), ...(editableCommand && { editableCommand }) });
  replayContext?.add(event.id);
  return s;
}
export function replay(events) {
  const state = emptyState(), seen = new Set();
  for (const event of events) applyEvent(state, event, seen);
  return state;
}

export function workdaySummary(state, date = state.date) {
  if (!state.initialized) fail('Önce başlangıç devrini onaylayın.');
  validDate(date);
  if (date < state.journal[0].date || date > state.date) fail('Özet tarihi başlangıç ile açık iş günü arasında olmalı.');
  const created = new Map();
  for (const e of state.journal) {
    if (['account', 'fundAccount', 'stockAccount', 'supplierUnit'].includes(e.type) && e.meta?.accountId) created.set(e.meta.accountId, e.date);
    if (Array.isArray(e.meta?.createdAccountIds)) for (const id of e.meta.createdAccountIds) created.set(id, e.date);
  }
  const rows = new Map(state.accounts.filter(a => !created.has(a.id) || created.get(a.id) <= date).map(a => [a.id, { accountId: a.id, unit: a.unit, opening: 0, incoming: 0, outgoing: 0, adjustment: 0, closing: 0 }]));
  const adjIds = new Set();
  const totals = { sales: 0, purchases: 0 };
  const isOpening = e => ['opening', 'account', 'fundAccount', 'stockAccount', 'nominalOpening'].includes(e.type);
  const isAdjustment = e => ['close', 'stocktake'].includes(e.type) || (e.type === 'movement' && e.label === 'Açılış düzeltmesi');
  for (const e of state.journal) {
    if (e.date > date) continue;
    if (isAdjustment(e)) adjIds.add(e.id);
    if (e.date === date) {
      totals.sales += e.meta.revenue || 0;
      totals.purchases += e.meta.purchaseTotal || 0;
    }
    const reversedAdj = e.type === 'reverse' && adjIds.has(e.meta.originalId);
    for (const entry of e.entries) {
      const row = rows.get(entry.accountId);
      if (!row) continue;
      if (e.date < date || isOpening(e)) row.opening += entry.delta;
      else if (isAdjustment(e) || reversedAdj) row.adjustment += entry.delta;
      else if (entry.delta >= 0) row.incoming += entry.delta;
      else row.outgoing -= entry.delta;
    }
  }
  for (const row of rows.values()) row.closing = row.opening + row.incoming - row.outgoing + row.adjustment;
  return { date, accounts: [...rows.values()], totals };
}
