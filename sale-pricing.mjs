import { fail, quantity, text } from './domain.mjs';

function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    fail('Satış fiyat bilgisi geçersiz alan içeriyor.');
  }
}

export function hasSalePricing(command) {
  return Boolean(command && (Object.hasOwn(command, 'salePricing') ||
    (command.type === 'amend' && command.replacement && Object.hasOwn(command.replacement, 'salePricing'))));
}

// Capture the ordinary trade version at write time. A later product feature must
// not reinterpret formerly ignored fields when replaying this price snapshot.
export function underlyingSaleCommand(command) {
  const amendment = command.type === 'amend';
  const sale = amendment ? command.replacement : command;
  if (sale?.type !== 'sale' || sale.counterpartyType === 'supplier' ||
      !Array.isArray(sale.items) || !Object.hasOwn(sale, 'salePricing') || (amendment && Object.hasOwn(command, 'salePricing'))) {
    fail('Satır fiyat bilgisi yalnız müşteri satışında veya bağlı satış düzeltmesinde kullanılabilir.');
  }
  const { salePricing, ...base } = sale;
  return amendment ? { ...command, replacement: base } : base;
}

function priceLine(line) {
  if (line === null) return {costKnown:false};
  fields(line, ['quotedTL','source','components','costTL']);
  if (!Object.keys(line).length) fail('Boş fiyat satırı yerine bilgi girin veya satırı boş bırakın.');
  const result = {costKnown:Object.hasOwn(line, 'costTL')};
  if (result.costKnown) result.costTL = quantity(line.costTL, 'TL');
  if (Object.hasOwn(line, 'quotedTL')) result.quotedTL = quantity(line.quotedTL, 'TL');
  if (Object.hasOwn(line, 'source')) result.source = text(line.source, 'Fiyat kaynağı', 120);
  if (Object.hasOwn(line, 'components')) {
    if (!Array.isArray(line.components) || !line.components.length || line.components.length > 12) fail('Bir satırda 1–12 fiyat bileşeni girin.');
    result.components = Array.from(line.components, part => {
      fields(part, ['label','amountTL']);
      return {label:text(part.label, 'Bileşen adı', 60), amountTL:quantity(part.amountTL, 'TL', {signed:true})};
    });
  }
  return result;
}

export function salePriceSnapshot(sale) {
  const pricing = sale.salePricing;
  fields(pricing, ['version','lines']);
  if (pricing.version !== 1 || !Array.isArray(pricing.lines) || pricing.lines.length !== sale.items.length ||
      pricing.lines.length > 30 || !pricing.lines.some(line => line !== null)) fail('Fiyat bilgisi ürün satırlarıyla eşleşmeli.');
  return Array.from(pricing.lines, priceLine);
}
