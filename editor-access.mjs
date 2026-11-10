import { randomUUID } from 'node:crypto';
import { fail, isWorkerCustomerCreation } from './domain.mjs';

export function deny() {
  fail('Bu işlem için yönetici oturumu gerekli.', { status: 403 });
}

export function requireSession(identities, token) {
  const actor = identities.session(token);
  if (!actor) fail('Oturum açın.', { status: 401 });
  return actor;
}

// Browsers download large archives natively. Each ticket is short-lived, single-use
// and scoped to one operation, ledger and session. The session itself never enters a URL.
export class DownloadTickets {
  #tickets = new Map();
  issue(token, operation, workspace) {
    if (!['backup', 'archive'].includes(operation) || !['demo', 'dukkan'].includes(workspace)) fail('Geçersiz yedek seçimi.');
    for (const [key, ticket] of this.#tickets) {
      if (ticket.expires <= Date.now() || ticket.token === token) this.#tickets.delete(key);
    }
    const key = randomUUID();
    this.#tickets.set(key, { token, operation, workspace, expires: Date.now() + 30000 });
    return '/api/' + operation + '?' + new URLSearchParams({ workspace, ticket: key });
  }
  consume(key, operation, workspace) {
    const ticket = this.#tickets.get(key);
    this.#tickets.delete(key);
    if (!ticket || ticket.operation !== operation || ticket.workspace !== workspace || ticket.expires <= Date.now()) return null;
    return ticket.token;
  }
}

function paymentSources(state) {
  return state.accounts.filter(a => a.kind === 'asset' && !a.retired && !['GRAM','ADET'].includes(a.unit));
}
export function checkoutState(state) {
  const free = id => Math.max(0, (state.balances[id] || 0) - (state.inventoryReserved?.[id] || 0));
  const available = state.accounts.filter(a => !a.retired && (a.isSaleable || a.isPurchasable));
  return {
    initialized: state.initialized, date: state.date, revision: state.revision,
    payments: paymentSources(state).map(({ id, name, unit }) => ({ id, name, unit })),
    stocks: state.accounts.filter(a => a.kind === 'asset' && a.physical && !a.retired && ['GRAM','ADET'].includes(a.unit))
      .map(({id,name,unit}) => ({id,name,unit,quantity:state.balances[id] || 0,freeQuantity:free(id)})),
    inventoryItems: (state.inventoryItems || []).filter(i => i.status === 'available')
      .map(({ code, barcode, description, accountId, weightAccount, actualWeight, status }) =>
        ({ code, barcode, description, accountId, weightAccount, actualWeight, status })),
    products: available.map(a => ({
      id: a.id, name: a.name, unit: a.unit, scrap: a.scrap === true, quantity: state.balances[a.id] || 0, freeQuantity: free(a.id),
      canSell: a.isSaleable && !(a.id === 'gramToplam' && state.nominalUnconfirmed),
      canBuy: a.isPurchasable && !(a.id === 'gramToplam' && state.nominalUnconfirmed),
      weights: a.pairedGroups.map(id => {
        const pool = state.accounts.find(account => account.id === id);
        return { id, name: pool.name, quantity: state.balances[id] || 0, freeQuantity: free(id) };
      })
    }))
  };
}

export function customerChoices(state, search) {
  const query = search.trim().toLocaleLowerCase('tr');
  if (query.length < 2 || query.length > 100) return [];
  return state.accounts.filter(a => a.kind === 'receivable' && !a.retired && a.partyType !== 'supplier'
    && (a.id === search || a.name.toLocaleLowerCase('tr').includes(query))).slice(0, 12)
    .map(({ id, name, unit }) => ({ id, name, unit }));
}

export function customerDetail(state, id) {
  const a = state.accounts.find(account => account.id === id);
  if (!a || a.kind !== 'receivable' || a.retired || a.partyType === 'supplier' || a.parentAccountId) deny();
  return { id:a.id, name:a.name, phone:a.phone || '', taxId:a.taxId || '', address:a.address || '',
    accounts:[{id:a.id,name:a.name,unit:a.unit,balance:state.balances[a.id] || 0}] };
}

function onlyKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => keys.includes(k));
}

export function requireWorkerAccounts(command, state) {
  if (command.type === 'account') return;
  const sources = new Set(state.accounts.filter(a => a.kind === 'asset' && !a.retired).map(a => a.id));
  const customer = command.counterpartyId && state.accounts.find(a => a.id === command.counterpartyId);
  if (command.counterpartyId && (!customer || customer.kind !== 'receivable' || customer.retired || customer.partyType === 'supplier')) deny();
  if ([...(command.received ?? []), ...(command.given ?? [])].some(row => !sources.has(row.accountId))) deny();
}

// Worker retail uses the same mixed-consideration engine as owner retail.
// Administrative operations remain outside this command allowlist.
export function requireWorkerTrade(command) {
  if (isWorkerCustomerCreation(command)) return;
  const purchase = command?.type === 'purchase';
  if ((!purchase && command?.type !== 'sale') || !onlyKeys(command,
    ['type','date','items','source','counterpartyType','counterpartyId','received','given','credits','debts','note','salePricing'])) deny();
  if ((purchase && command.source !== 'customer') || (!purchase && command.source !== undefined) ||
      command.counterpartyType !== 'customer') deny();
  if (!Array.isArray(command.items) || !command.items.length || command.items.length > 30 || !command.items.every(row =>
    onlyKeys(row, ['accountId','quantity','weightAccount','weight','value', ...(!purchase ? ['inventoryCode'] : [])]))) deny();
  if (command.salePricing !== undefined) {
    const pricing = command.salePricing;
    if (purchase || !onlyKeys(pricing, ['version','lines']) || pricing.version !== 1 ||
        !Array.isArray(pricing.lines) || pricing.lines.length !== command.items.length ||
        !pricing.lines.every(row => row === null || (onlyKeys(row, ['quotedTL','source','components']) &&
          (row.components === undefined || (Array.isArray(row.components) && row.components.every(component =>
            onlyKeys(component, ['label','amountTL']))))))) deny();
  }
  for (const key of ['received','given','credits','debts']) {
    const rows = command[key] ?? [];
    if (!Array.isArray(rows) || rows.length > 30) deny();
    for (const row of rows) {
      const asset = key === 'received' || key === 'given';
      if (!onlyKeys(row, ['accountId','quantity','valueTL', ...(asset ? ['weightAccount','weight'] : [])])) deny();
      if (asset && typeof row.accountId === 'string') continue;
      if (command.counterpartyId && row.accountId === command.counterpartyId) continue;
      deny();
    }
  }
}
