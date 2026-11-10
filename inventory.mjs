import { fail, quantity, text } from './domain.mjs';

export function usesInventory(command) {
  if (!command || typeof command !== 'object') return false;
  if (command.type === 'amend') return command.replacement?.type === 'sale' && usesInventory(command.replacement);
  if (command.type === 'saleReturn') return Array.isArray(command.outgoing) && command.outgoing.some(row => row && Object.hasOwn(row, 'inventoryCode'));
  return ['registerItem', 'releaseItem', 'itemCostSource'].includes(command.type) ||
    (command.type === 'sale' && Array.isArray(command.items) && command.items.some(row => row && Object.hasOwn(row, 'inventoryCode')));
}

function codeOf(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/.test(value.trim())) {
    fail('Ürün kodu veya barkod 1–64 harf, rakam, nokta, eğik çizgi, alt çizgi veya tire içermeli.');
  }
  return value.trim().toUpperCase();
}

function optionalWeight(value) {
  return value === undefined || value === '' ? null : quantity(value, 'GRAM', { zero: false });
}

function remainingPurchaseLine(state, id, index) {
  const reversed=new Set(state.journal.filter(e=>['reverse','supplierReverse'].includes(e.type)).map(e=>e.meta.originalId));
  const entry=state.journal.find(e=>e.id===id&&['purchase','supplierPurchase'].includes(e.type));
  const original=entry?.meta.lines?.[index];
  if(!original||reversed.has(id))return null;
  const line={...original};
  for(const returned of state.journal.filter(e=>e.type==='supplierReturn'&&e.meta.originalId===id&&!reversed.has(e.id))) {
    for(const row of returned.meta.lines.filter(r=>r.lineIndex===index)) {
      line.quantity-=row.quantity;
      if(line.weightAccount)line.weight-=row.weight;
    }
  }
  return line;
}

function sourceLine(state, purchase, item) {
  if (!purchase || typeof purchase.id !== 'string' || !Number.isInteger(purchase.lineIndex) || purchase.lineIndex < 0) {
    fail('Alış bağlantısında kayıt ve satır numarası gerekli.');
  }
  const line = remainingPurchaseLine(state,purchase.id,purchase.lineIndex);
  if (!line || line.accountId !== item.accountId || line.weightAccount !== item.weightAccount ||
    state.journal.some(row => ['reverse','supplierReverse'].includes(row.type) && row.meta.originalId === purchase.id)) {
    fail('Etkin ve ürünle eşleşen alış satırı gerekli.');
  }
  if ((state.inventoryItems || []).some(row => row.status === 'released' &&
      row.costSource?.id === purchase.id && row.costSource.lineIndex === purchase.lineIndex)) {
    fail('Bu alış satırı eski ürün kartının maliyet kaynağıdır. Önce o karttan maliyet kaynağını kaldırın.');
  }
  const others = (state.inventoryItems || []).filter(row => row.status !== 'released' &&
    row.purchaseLine?.id === purchase.id && row.purchaseLine.lineIndex === purchase.lineIndex);
  const count = others.length + 1;
  if (count > line.quantity) fail('Alış satırındaki adet zaten eşleştirildi.');
  if (line.weightAccount) {
    const total = others.reduce((sum, row) => sum + row.actualWeight, item.actualWeight);
    if (count === line.quantity ? total !== line.weight : total >= line.weight) fail('Ürünün gerçek gramı alış satırının kalan gramıyla eşleşmiyor.');
  }
  return { id: purchase.id, lineIndex: purchase.lineIndex };
}

export function purchaseCostOffer(item, purchase) {
  const ref = item.purchaseLine;
  const line = purchase?.meta.lines?.[ref?.lineIndex];
  if (!ref || item.status === 'released' || item.costSource || purchase?.id !== ref.id ||
      purchase.type !== 'purchase' || !line || line.quantity !== 1 || line.accountId !== item.accountId ||
      line.weightAccount !== item.weightAccount || (item.weightAccount && line.weight !== item.actualWeight) ||
      !Number.isSafeInteger(line.value) || line.value <= 0) return null;
  return { id: ref.id, lineIndex: ref.lineIndex, amountTL: line.value };
}

function changeCostSource(state, command, current) {
  if (!current || Object.keys(command).some(key => !['type','date','inventoryCode','source','note'].includes(key))) {
    fail('Ürün ve geçerli alış maliyet kaynağı gerekli.');
  }
  const item = { ...current };
  if (command.source === null) {
    if (!item.costSource) fail('Bu üründe kayıtlı maliyet kaynağı yok.');
    delete item.costSource;
    return item;
  }
  const ref = command.source;
  const purchase = state.journal.find(row => row.id === item.purchaseLine?.id);
  const offer = purchaseCostOffer(item, purchase);
  if (!offer || !ref || typeof ref !== 'object' || Array.isArray(ref) ||
      Object.keys(ref).some(key => !['id','lineIndex','amountTL'].includes(key)) ||
      ref.id !== offer.id || ref.lineIndex !== offer.lineIndex || ref.amountTL !== offer.amountTL ||
      state.journal.some(row => row.type === 'reverse' && row.meta.originalId === offer.id)) {
    fail('Maliyet yalnız eşleşen etkin tek parçalık alış satırının kayıtlı TL tutarı olabilir.');
  }
  item.costSource = offer;
  return item;
}

function register(state, command, eventId) {
  const allowed = ['type', 'date', 'code', 'barcode', 'accountId', 'weightAccount', 'description', 'actualWeight',
    'grossWeight', 'netWeight', 'fineness', 'purchaseLine', 'photo'];
  if (Object.keys(command).some(key => !allowed.includes(key))) fail('Tekil ürün kaydında desteklenmeyen alan.');
  const account = state.accounts.find(a => a.id === command.accountId);
  if (!account?.physical || !account.isSaleable || account.retired || account.unit !== 'ADET') fail('Satılabilir adet stok kartını seçin.');
  const weightAccount = command.weightAccount || null;
  if (account.pairedGroups.length ? !account.pairedGroups.includes(weightAccount) : weightAccount !== null) fail('Terazi grubu stok kartıyla eşleşmiyor.');
  const code = codeOf(command.code), barcode = command.barcode ? codeOf(command.barcode) : null;
  if ((state.inventoryItems || []).some(row => [code, barcode].some(key => key && (key === row.code || key === row.barcode)))) fail('Bu ürün kodu veya barkod daha önce kaydedildi.');
  const actualWeight = optionalWeight(command.actualWeight), grossWeight = optionalWeight(command.grossWeight), netWeight = optionalWeight(command.netWeight);
  if (weightAccount && !actualWeight) fail('Bu terazi grubu için gerçek gram gerekli.');
  if (grossWeight !== null && netWeight !== null && netWeight > grossWeight) fail('Net gram brüt gramdan büyük olamaz.');
  let fineness = null;
  if (command.fineness !== undefined && command.fineness !== '') {
    if (typeof command.fineness !== 'string' || !/^(?:[1-9]\d{0,2}|1000)$/.test(command.fineness)) fail('Milyem 1–1000 arasında tam sayı olmalı.');
    fineness = Number(command.fineness);
  }
  const item = { code, barcode, accountId: account.id, weightAccount, actualWeight, grossWeight, netWeight, fineness,
    description: command.description ? text(command.description, 'Ürün açıklaması', 160) : '',
    registeredId: eventId, status: 'available', lastEventId: eventId };
  if (command.photo !== undefined) {
    const photo = command.photo;
    // A fixed RGB thumbnail has no file metadata, decoder, paths or active content.
    if (!photo || typeof photo !== 'object' || Object.keys(photo).length !== 2 || photo.version !== 1 ||
      typeof photo.pixels !== 'string' || photo.pixels.length !== 96 * 96 * 4 || /[^A-Za-z0-9+/]/.test(photo.pixels)) {
      fail('Ürün fotoğrafı geçersiz. 96 × 96 RGB önizleme gerekli.');
    }
    item.hasPhoto = true;
  }
  if (command.purchaseLine !== undefined) item.purchaseLine = sourceLine(state, command.purchaseLine, item);
  return item;
}

function reserve(reserved, item, sign) {
  reserved[item.accountId] = (reserved[item.accountId] || 0) + sign;
  if (item.weightAccount) reserved[item.weightAccount] = (reserved[item.weightAccount] || 0) + sign * item.actualWeight;
}

export function checkReserved(state) {
  for (const [id, amount] of Object.entries(state.inventoryReserved || {})) {
    if (amount > state.balances[id]) fail('İşlem tekil ürünlere ayrılmış adet veya gramı aşıyor. Ürün kodunu seçin veya kart eşlemesini kontrol edin.');
  }
}

export function applyInventory(state, event, meta, tagged, entries) {
  const c = event.command;
  if (!tagged && !state.inventoryItems?.length) return;
  const previous = state.inventoryItems || [];
  let items = previous;
  const reserved = { ...state.inventoryReserved };
  const changes = [];
  const released = {};
  const change = (code, status, lastEventId, expectedStatus, expectedEventId) => {
    const index = items.findIndex(row => row.code === code);
    const old = items[index];
    if (!old || old.status !== expectedStatus || (expectedEventId && old.lastEventId !== expectedEventId)) {
      fail('Tekil ürün bu harekete uygun durumda değil.');
    }
    if (items === previous) items = [...previous];
    if (old.status === 'available') {
      reserve(reserved, old, -1);
      reserve(released, old, 1);
    }
    items[index] = { ...old, status, lastEventId };
    if (status === 'available') reserve(reserved, old, 1);
    changes.push({ code, before: old.status, beforeId: old.lastEventId, after: status, afterId: lastEventId });
    return old;
  };
  const deliver = (value, line, status) => {
    const code = codeOf(value);
    const item = change(code, status, event.id, 'available');
    if (item.lastEventId === event.id) fail('Geri alınan ürün aynı işlemde yeni ürün olarak verilemez.');
    if (line.quantity !== 1 || line.accountId !== item.accountId || line.weightAccount !== item.weightAccount ||
      (item.weightAccount && line.weight !== item.actualWeight)) fail('Tekil ürünün adet, terazi grubu ve gerçek gramı teslim satırıyla eşleşmeli.');
    line.inventoryCode = code;
  };
  if (tagged && c.type === 'registerItem') {
    const item = register(state, c, event.id);
    reserve(reserved, item, 1);
    items = [...previous, item];
    meta.inventoryCode = item.code;
  } else if (tagged && c.type === 'itemCostSource') {
    const code = codeOf(c.inventoryCode);
    const index = previous.findIndex(row => row.code === code);
    const updated = changeCostSource(state, c, previous[index]);
    items = [...previous];
    items[index] = updated;
    meta.inventoryCode = code;
    meta.itemCostSource = updated.costSource || previous[index].costSource;
    if (c.source === null) meta.costRemovalReason = text(c.note, 'Maliyet kaynağını kaldırma gerekçesi');
  } else if (tagged && c.type === 'releaseItem') {
    const code = codeOf(c.inventoryCode);
    change(code, 'released', event.id, 'available');
    meta.inventoryCode = code;
  } else if (tagged && c.type === 'sale') {
    for (const [index, line] of meta.lines.entries()) {
      if (!Object.hasOwn(c.items[index], 'inventoryCode')) continue;
      deliver(c.items[index].inventoryCode, line, 'sold');
    }
  } else if (c.type === 'supplierReturn') {
    for(const row of meta.lines) {
      const line=remainingPurchaseLine(state,c.originalId,row.lineIndex);
      const linked=previous.filter(item=>item.status!=='released'&&item.purchaseLine?.id===c.originalId&&item.purchaseLine.lineIndex===row.lineIndex);
      if(!line||row.quantity>line.quantity-linked.length || (line.weightAccount&&row.weight>line.weight-linked.reduce((sum,item)=>sum+item.actualWeight,0))) {
        fail('İade satırı tekil ürün kartlarına bağlı miktarı kullanamaz. Önce ilgili ürün eşlemesini kontrol edin.');
      }
    }
  } else if (c.type === 'saleReturn') {
    const original = state.journal.find(row => row.id === c.originalId);
    for (const line of meta.lines) {
      const code = original.meta.lines[line.lineIndex].inventoryCode;
      if (code) {
        change(code, 'available', event.id, 'sold', original.id);
        line.inventoryCode = code;
      }
    }
    if (tagged) {
      for (const [index, line] of meta.refunds.entries()) {
        if (Object.hasOwn(c.outgoing[index], 'inventoryCode')) deliver(c.outgoing[index].inventoryCode, line, 'issued');
      }
    }
  } else if (c.type === 'reverse') {
    if (previous.some(item => item.costSource?.id === c.originalId)) {
      fail('Bu alış tekil ürünün kayıtlı maliyet kaynağıdır. Önce ürün kartından maliyet kaynağını kaldırın.');
    }
    if (previous.some(item => item.purchaseLine?.id === c.originalId && item.status !== 'released')) {
      fail('Bu alışa bağlı tekil ürün var. Önce ürün eşlemesini kontrol edin.');
    }
    const original = state.journal.find(row => row.id === c.originalId);
    for (const prior of original.meta.inventoryChanges || []) {
      change(prior.code, prior.before, prior.beforeId, prior.after, prior.afterId);
    }
  }
  // Received and delivered stock may use the same account in one trade.
  // Stock received in this event cannot stand in for a reserved piece it delivers.
  const outgoing = new Map();
  for (const entry of entries) {
    if (entry.delta < 0 && state.inventoryReserved?.[entry.accountId] > 0) {
      outgoing.set(entry.accountId, (outgoing.get(entry.accountId) || 0) - entry.delta);
    }
  }
  for (const [id, amount] of outgoing) {
    if (amount > state.balances[id] - state.inventoryReserved[id] + (released[id] || 0)) {
      fail('Verilen adet veya gram tekil ürünlere ayrılmış. Teslim edilen ürün kodunu seçin.');
    }
  }
  if (items !== previous) {
    state.inventoryItems = items;
    state.inventoryReserved = reserved;
  }
  if (changes.length) meta.inventoryChanges = changes;
}
