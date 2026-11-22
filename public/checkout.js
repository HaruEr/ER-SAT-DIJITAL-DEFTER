const $ = id => document.getElementById(id);
const { api, current } = window.DefterSession;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const codec = globalThis.DefterAmountCodec;
const dateFmt = globalThis.DefterDateFormat;
const uiKit = (typeof window !== 'undefined' && window.DefterUI) || globalThis.DefterUI || null;
const comboboxLib = (typeof window !== 'undefined' && window.DefterCombobox) || globalThis.DefterCombobox || null;
const paletteLib = (typeof window !== 'undefined' && window.DefterCommandPalette) || globalThis.DefterCommandPalette || null;
const searchNorm = (typeof window !== 'undefined' && window.DefterSearchNorm) || globalThis.DefterSearchNorm || null;
const normalize = value => searchNorm ? searchNorm.normalizeSearch(value) : String(value || '').toLocaleLowerCase('tr').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/ı/g,'i');
const scale = unit => codec ? codec.units[unit].scale : (unit === 'ADET' ? 1 : ['GRAM','HAS','SILVER'].includes(unit) ? 1000 : 100);
const format = (value, unit='TL') => codec ? codec.formatAmount(value, unit) : ((value/scale(unit)).toLocaleString('tr-TR',{minimumFractionDigits:unit==='ADET'?0:unit==='GRAM'?3:2,maximumFractionDigits:scale(unit)===1000?3:2})+' '+({ADET:'adet',GRAM:'gr',HAS:'has gr',SILVER:'saf gümüş gr'}[unit] || unit));
const decimal = value => String(value || '').trim().replace(',','.');
const canonical = (input, unit='TL', positive=true) => codec ? codec.canonicalInputValue(input, unit, positive) : decimal(input?.value);
const day = value => dateFmt ? dateFmt.formatTurkishDate(value) : value;
const option = (id,name) => '<option value="'+esc(id)+'">'+esc(name)+'</option>';
const numeric = (field,label,required=true) => '<label>'+label+'<input '+field+' inputmode="decimal" maxlength="24"'+(required?' required':'')+'></label>';
const groups = ['received','given','credits','debts'];
const groupNames = {received:'İşletmeye alınan',given:'İşletmeden verilen',credits:'Cari alacağımız artar / borcumuz azalır',debts:'Müşteriye borcumuz artar / alacağımız azalır'};
let snapshot, pending, review, selectedCustomer = null, writing = false, rendering = false, customerLoading = false;
let workspace = $('workspace').value, operation = $('operation').value;
let loadSequence = 0, customerSequence = 0, draftRevision, draftDate, draftDirty = false, externalRevision = 0, stockPage = 0;
let activeCustomerDrawer = null, flowMode = 'quick', manualFlowMode = null, activeStep = 1, customerCombobox = null, quickFillCashBtn = null;
const defaultDraftStore = {
  PREFIX: 'defter-draft:v1:',
  PENDING_PREFIX: 'defter-draft:v1:pending:',
  makeKey({ actorId = 'owner', workspace = 'dukkan', scope = 'checkout', type = 'trade', entityId = '' }) {
    const clean = v => encodeURIComponent(String(v || 'unknown').trim().replace(/:/g, '_'));
    return `${this.PREFIX}${clean(actorId)}:${clean(workspace)}:${clean(scope)}:${clean(type)}${entityId ? ':' + clean(entityId) : ''}`;
  },
  makePendingKey({ actorId = 'owner', workspace = 'dukkan', scope = 'checkout', type = 'trade' }) {
    const clean = v => encodeURIComponent(String(v || 'unknown').trim().replace(/:/g, '_'));
    return `${this.PENDING_PREFIX}${clean(actorId)}:${clean(workspace)}:${clean(scope)}:${clean(type)}`;
  },
  saveDraft(key, payload) {
    try { sessionStorage.setItem(key, JSON.stringify(payload)); } catch {}
  },
  getDraft(key) {
    try {
      const raw = sessionStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },
  clearDraft(key) {
    try { sessionStorage.removeItem(key); } catch {}
  },
  savePending(key, envelope) {
    try {
      if (envelope === null || envelope === undefined) {
        this.clearPending(key);
        return null;
      }
      sessionStorage.setItem(key, JSON.stringify(envelope));
      return envelope;
    } catch { return null; }
  },
  getPending(key) {
    try {
      const raw = sessionStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },
  clearPending(key) {
    try { sessionStorage.removeItem(key); } catch {}
  },
  validateDraft(saved, state, options = {}) {
    if (!saved) return { status: 'VALID', reason: null };
    const meta = saved.meta || {};
    if (state && Number.isSafeInteger(state.revision) && Number.isSafeInteger(meta.revision) && meta.revision !== state.revision) {
      return { status: 'STALE_REVISION', reason: `Kayıt sürümü değişti (taslak: ${meta.revision}, güncel: ${state.revision}).` };
    }
    if (state && state.date && meta.workday && meta.workday !== state.date) {
      return { status: 'STALE_WORKDAY', reason: `İş günü değişti (taslak: ${meta.workday}, güncel: ${state.date}).` };
    }
    return { status: 'VALID', reason: null };
  }
};
function getDraftStore() {
  if (typeof window !== 'undefined' && window.DefterDraftStore) return window.DefterDraftStore;
  if (typeof globalThis !== 'undefined' && globalThis.DefterDraftStore) return globalThis.DefterDraftStore;
  return defaultDraftStore;
}
const actorId = () => current()?.actor?.id || 'owner';
const route = (path, selected=workspace) => '/api/'+path+'?workspace='+encodeURIComponent(selected);
async function apiWithSignal(path, signal) {
  const session = current?.();
  if (session?.token && typeof fetch === 'function') {
    const res = await fetch(path, {
      headers: { Authorization: 'Bearer ' + session.token },
      signal
    });
    const data = await res.json();
    if (res.status === 401 && session && location.pathname !== '/') window.DefterSession?.lock?.();
    if (!res.ok) {
      const err = new Error(data?.error || 'İstek tamamlanamadı.');
      err.status = res.status;
      throw err;
    }
    return data;
  }
  return api(path);
}
const draftStoreKey = (selected=workspace, kind=operation) => getDraftStore().makeKey({ actorId: actorId(), workspace: selected, scope: 'checkout', type: kind });
const pendingStoreKey = (selected=workspace) => {
  const store = getDraftStore();
  if (typeof store.makePendingKey === 'function') {
    return store.makePendingKey({ actorId: actorId(), workspace: selected, scope: 'checkout', type: 'trade' });
  }
  return store.makeKey({ actorId: actorId(), workspace: selected, scope: 'checkout', type: 'pending' });
};
const legacyDraftKey = (selected=workspace, kind=operation) => 'defter-pending-checkout-draft-'+actorId()+'-'+selected+'-'+kind;
const legacyPendingKey = (selected=workspace) => 'defter-sale-retry-'+actorId()+'-'+selected;
const readStored = key => { try {return JSON.parse(sessionStorage.getItem(key) || 'null');} catch {return null;} };
function readStoredDraft(selected=workspace, kind=operation) {
  const store = getDraftStore();
  const stored = store.getDraft(draftStoreKey(selected, kind));
  if (stored && stored.data) {
    return { ...stored.data, revision: stored.meta?.revision ?? stored.data.revision, date: stored.meta?.workday ?? stored.data.date };
  }
  return readStored(legacyDraftKey(selected, kind));
}
function clearStoredDraft(selected=workspace, kind=operation) {
  const store = getDraftStore();
  store.clearDraft(draftStoreKey(selected, kind));
  try { sessionStorage.removeItem(legacyDraftKey(selected, kind)); } catch {}
  if (selected === workspace && kind === operation) draftDirty = false;
}
function readStoredPending(selected=workspace) {
  const store = getDraftStore();
  const stored = store.getPending?.(pendingStoreKey(selected));
  if (stored) return stored;
  return readStored(legacyPendingKey(selected));
}
function saveStoredPending(val, selected=workspace) {
  const store = getDraftStore();
  const pKey = pendingStoreKey(selected);
  const legKey = legacyPendingKey(selected);
  if (val) {
    store.savePending?.(pKey, val);
    try { sessionStorage.setItem(legKey, JSON.stringify(val)); } catch {}
  } else {
    store.clearPending?.(pKey);
    if (typeof store.clearPending !== 'function') store.savePending?.(pKey, null);
    try { sessionStorage.removeItem(legKey); } catch {}
  }
}
const broadcast = typeof BroadcastChannel === 'function' ? new BroadcastChannel('defter-checkout-revisions') : null;
const status = message => { $('status').textContent = message; };
const isStale = () => snapshot && (draftRevision !== snapshot.revision || draftDate !== snapshot.date || externalRevision > snapshot.revision);
function parseSignedTL(input, optional=false, allowZero=false) {
  if (!input) return null;
  const text = String(input.value ?? '').trim();
  if (!text && optional) {
    input.setCustomValidity('');
    delete input.dataset.canonicalAmount;
    return null;
  }
  if (codec) {
    if (!text) {
      input.setCustomValidity('Geçerli TL tutarı girin.');
      delete input.dataset.canonicalAmount;
      return null;
    }
    const res = codec.parseUserAmount(text, 'TL', { positive: false, allowZero, signed: true });
    if (res.status !== 'valid') {
      input.setCustomValidity(res.reason || 'Geçerli TL tutarı girin.');
      delete input.dataset.canonicalAmount;
      return null;
    }
    input.setCustomValidity('');
    input.dataset.canonicalAmount = res.canonical;
    return res.scaled;
  }
  input.setCustomValidity('');
  const value=decimal(text);
  if (!value && optional) return null;
  const pattern=/^-?\d+(?:\.\d{1,2})?$/;
  if (!pattern.test(value)) {input.setCustomValidity('Geçerli TL miktarı girin.');return null;}
  const [whole,fraction='']=value.replace('-','').split('.');
  const mag=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  const amount=mag===0?0:(value.startsWith('-')?-mag:mag);
  if (!Number.isSafeInteger(amount) || Math.abs(amount)>1e12 || (!allowZero && amount===0)) {input.setCustomValidity('Geçerli, sınırlar içinde miktar girin.');return null;}
  return amount;
}
function parse(input,unit='TL',signed=false,optional=false,allowZero=false) {
  if (signed && unit === 'TL') return parseSignedTL(input, optional, allowZero);
  if (codec && !signed) {
    if (!String(input?.value ?? '').trim() && optional) { input?.setCustomValidity(''); return null; }
    return codec.parseInputElement(input, unit, !allowZero);
  }
  input.setCustomValidity('');
  const value=decimal(input.value);
  if (!value && optional) return null;
  const digits=scale(unit)===1?0:scale(unit)===1000?3:2;
  const pattern=new RegExp('^'+(signed?'-?':'')+'\\d+'+(digits?'(?:\\.\\d{1,'+digits+'})?':'')+'$');
  if (!pattern.test(value)) {input.setCustomValidity('Geçerli '+unit+' miktarı girin.');return null;}
  const [whole,fraction='']=value.replace('-','').split('.');
  const amount=(Number(whole)*scale(unit)+Number(fraction.padEnd(digits,'0')))*(value.startsWith('-')?-1:1);
  if (!Number.isSafeInteger(amount) || Math.abs(amount)>1e12 || (!signed && (amount<0 || (!allowZero && amount===0)))) {input.setCustomValidity('Geçerli, sınırlar içinde miktar girin.');return null;}
  return amount;
}
function clearAmountInputState(input) {
  if (!input) return;
  if (codec?.clearInputState) { codec.clearInputState(input); return; }
  if (input.dataset) {
    delete input.dataset.amountResolution;
    delete input.dataset.canonicalAmount;
    delete input.dataset.formattedPreview;
  }
  input.setCustomValidity?.('');
}
function parseReadOnlyAmount(inputOrValue, unit='TL') {
  const isEl = inputOrValue && typeof inputOrValue === 'object' && 'value' in inputOrValue;
  const text = String(isEl ? inputOrValue.value : inputOrValue ?? '').trim();
  if (!text) return null;
  if (codec) {
    const resolution = isEl ? (inputOrValue.dataset?.amountResolution || null) : null;
    const res = codec.parseUserAmount(text, unit, { positive: true, allowZero: false, resolution });
    return res.status === 'valid' ? res.scaled : null;
  }
  const normalized = decimal(text);
  const digits = scale(unit) === 1 ? 0 : scale(unit) === 1000 ? 3 : 2;
  const pattern = new RegExp('^\\d+' + (digits ? '(?:\\.\\d{1,' + digits + '})?' : '') + '$');
  if (!pattern.test(normalized)) return null;
  const [whole, fraction = ''] = normalized.split('.');
  const amount = Number(whole) * scale(unit) + Number(fraction.padEnd(digits, '0'));
  return Number.isSafeInteger(amount) && amount > 0 && amount <= 1e12 ? amount : null;
}
function isComplexCheckoutState() {
  if ($('items').children.length > 1) return true;
  const primaryKind = operation === 'sale' ? 'received' : 'given';
  const oppositeKind = operation === 'sale' ? 'given' : 'received';
  if ($(oppositeKind).children.length > 0) return true;
  if ($('credits').children.length > 0 || $('debts').children.length > 0) return true;
  const primaryRows = [...$(primaryKind).children];
  if (primaryRows.length > 1) return true;
  if (primaryRows.some(row => row.dataset.category !== 'money' || (allocationAccount(row)?.unit && allocationAccount(row).unit !== 'TL'))) return true;
  return false;
}
function controls() {
  const blocked=writing || !!pending || !!review || !snapshot;
  const complex=isComplexCheckoutState();
  $('trade-controls').disabled=blocked;
  for (const el of $('customer-form').elements) el.disabled=blocked;
  for (const id of ['search','customer','operation','clear-draft','add-item']) $(id).disabled=blocked;
  customerCombobox?.setDisabled?.(blocked);
  if ($('items')) for (const row of $('items').children) row._productCombobox?.setDisabled?.(blocked);
  for (const kind of groups) if ($(kind)) for (const row of $(kind).children) row._accountCombobox?.setDisabled?.(blocked);
  if (quickFillCashBtn) quickFillCashBtn.disabled = blocked;
  if ($('open-customer-drawer')) $('open-customer-drawer').disabled=blocked;
  const quickBtn = document.querySelector('[data-flow-mode="quick"]');
  const guidedBtn = document.querySelector('[data-flow-mode="guided"]');
  const escalateBtn = document.querySelector('[data-escalate-guided]');
  if (quickBtn) quickBtn.disabled = blocked || complex;
  if (guidedBtn) guidedBtn.disabled = blocked;
  if (escalateBtn) escalateBtn.disabled = blocked;
  $('workspace').disabled=writing || !!review;
  $('logout').disabled=writing;
  $('refresh').disabled=writing || !!review;
  $('retry').disabled=writing;
  $('confirm').disabled=writing;
  $('pending-panel').hidden=!pending;
  $('draft-stale').hidden=!isStale() || !!pending;
  $('record').disabled=blocked || customerLoading || !!isStale();
  $('accept-snapshot').disabled=writing || !snapshot || externalRevision>snapshot.revision;
}
function itemProduct(row) {
  const value=row.querySelector('[data-product]').value;
  const serial=value.startsWith('serial:') ? snapshot?.inventoryItems.find(i=>i.code===value.slice(7)) : null;
  return { product:snapshot?.products.find(p=>p.id===(serial?.accountId || value)), serial };
}
function priceFields(row,data={}) {
  const list=row.querySelector('[data-components]');
  const part=document.createElement('div');part.className='access-columns';
  part.innerHTML='<label>Bileşen adı<input data-component-name maxlength="60"></label>'+numeric('data-component-value','Tutar · TL',false)+'<button type="button" class="button text">Kaldır</button>';
  part.querySelector('[data-component-name]').value=data.label || '';
  part.querySelector('[data-component-value]').value=data.amountTL || '';
  part.querySelector('button').addEventListener('click',()=>{part.remove();changed();});
  list.append(part);
}
function pricing(row, canonicalize = false) {
  const result={};
  const quoted=row.querySelector('[data-quoted]'),source=row.querySelector('[data-source]');
  if (quoted.value.trim()) result.quotedTL = canonicalize ? canonical(quoted, 'TL', false) : quoted.value.trim();
  if (source.value.trim()) result.source=source.value.trim();
  const components=[...row.querySelector('[data-components]').children].map(part=>{
    const valInput = part.querySelector('[data-component-value]');
    let amountTL;
    if (canonicalize) {
      parseSignedTL(valInput, false, false);
      amountTL = valInput.dataset.canonicalAmount || decimal(valInput.value);
    } else {
      amountTL = valInput.value.trim();
    }
    return {label:part.querySelector('[data-component-name]').value.trim(),amountTL};
  });
  if (components.length) result.components=components;
  return Object.keys(result).length?result:null;
}
function configureItem(row,clear=false) {
  const {product,serial}=itemProduct(row), select=row.querySelector('[data-pool]');
  const previous=select.value;
  const pools=product?.weights || [];
  select.innerHTML=pools.map(p=>option(p.id,p.name+' · '+format(operation==='sale'?(p.freeQuantity ?? p.quantity):p.quantity,'GRAM'))).join('');
  if (pools.some(p=>p.id===previous)) select.value=previous;
  row.querySelector('[data-weight-fields]').hidden=!pools.length;
  row.querySelector('[data-weight]').required=!!pools.length;
  row.querySelector('[data-quantity-label]').textContent=product?.unit==='ADET'?'Adet':'Miktar · '+(product?.unit || 'GRAM');
  row.querySelector('[data-available]').textContent=product?'Toplu kullanım '+format(product.freeQuantity ?? product.quantity,product.unit)+(serial?' · Tekil ürün '+serial.code:''):'Ürün seçin.';
  for(const key of ['quantity','weight']) row.querySelector('[data-'+key+']').readOnly=!!serial;
  select.disabled=!!serial || !pools.length;
  select.required=!!pools.length;
  if(clear) for(const key of ['quantity','weight','value','quoted','source']) { const el=row.querySelector('[data-'+key+']'); clearAmountInputState(el); el.value=''; }
  if(clear) row.querySelector('[data-components]').replaceChildren();
  if(serial) {
    row.querySelector('[data-quantity]').value='1';
    select.value=serial.weightAccount || '';
    row.querySelector('[data-weight]').value=serial.actualWeight?(serial.actualWeight/1000).toFixed(3):'';
  }
}
function productChoices() {
  const items = [], sale = operation === 'sale';
  for (const product of snapshot?.products || []) {
    if (!(sale ? product.canSell : product.canBuy)) continue;
    const avail = product.freeQuantity ?? product.quantity ?? 0;
    const hasPool = !product.weights?.length || product.weights.some(w => (w.freeQuantity ?? w.quantity ?? 0) > 0);
    const isZeroStock = sale && (avail <= 0 || !hasPool);
    items.push({
      id: product.id,
      label: product.name,
      unit: product.unit,
      subtitle: sale ? `Mevcut: ${format(avail, product.unit)}` : '',
      badge: product.scrap ? 'Hurda' : '',
      keywords: [product.id, ...product.weights.map(w => w.name)].join(' '),
      disabled: isZeroStock,
      disabledReason: isZeroStock ? 'Stok yok' : '',
      available: !isZeroStock
    });
  }
  if (sale) {
    for (const piece of snapshot?.inventoryItems || []) {
      const product = snapshot.products.find(p => p.id === piece.accountId);
      if (!product?.canSell) continue;
      items.push({
        id: 'serial:' + piece.code,
        label: [piece.code, product.name, piece.description].filter(Boolean).join(' · '),
        unit: product.unit,
        code: piece.code,
        barcode: piece.barcode || '',
        badge: 'Tekil',
        subtitle: [piece.barcode ? 'Barkod: ' + piece.barcode : '', piece.actualWeight ? format(piece.actualWeight, 'GRAM') : ''].filter(Boolean).join(' · '),
        keywords: [product.name, piece.code, piece.barcode, piece.description, ...product.weights.map(w => w.name)].filter(Boolean).join(' '),
        disabled: false,
        available: true
      });
    }
  }
  items.sort((a, b) => Number(!!a.disabled) - Number(!!b.disabled));
  return items;
}
function syncProductSelect(row, items, selectedId) {
  const select = row.querySelector('[data-product]');
  if (!select) return;
  if (items.length <= 50) {
    select.innerHTML = items.map(m => '<option value="' + esc(m.id) + '"' + (m.code ? ' data-code="' + esc(m.code) + '"' : '') + '>' + esc(m.label) + '</option>').join('');
  } else {
    const selected = items.find(m => m.id === selectedId);
    select.innerHTML = '<option value="">Ürün seçin</option>' + (selected ? '<option value="' + esc(selected.id) + '"' + (selected.code ? ' data-code="' + esc(selected.code) + '"' : '') + '>' + esc(selected.label) + '</option>' : '');
  }
  select.value = selectedId || '';
}
function listProducts(row,preserve) {
  const search=row.querySelector('[data-product-search]').value, normalized=normalize(search), literal=search.trim().toLocaleLowerCase('tr');
  const selected=preserve || row.querySelector('[data-product]').value;
  const matches=[],sale=operation==='sale';
  for(const product of snapshot?.products || []) {
    if(!(sale?product.canSell:product.canBuy)) continue;
    if(normalize([product.id,product.name,...product.weights.map(p=>p.name)].join(' ')).includes(normalized)) matches.push({id:product.id,name:product.name,available:(product.freeQuantity ?? product.quantity)>0,exact:product.id.toLocaleLowerCase('tr')===literal});
  }
  if(sale) for(const piece of snapshot?.inventoryItems || []) {
    const product=snapshot.products.find(p=>p.id===piece.accountId);
    if(!product?.canSell) continue;
    if(normalize([product.name,piece.code,piece.barcode,piece.description,...product.weights.map(p=>p.name)].join(' ')).includes(normalized)) matches.push({id:'serial:'+piece.code,name:[piece.code,product.name,piece.description].filter(Boolean).join(' · '),code:piece.code,exact:[piece.code,piece.barcode].some(v=>v&&v.toLocaleLowerCase('tr')===literal)});
  }
  matches.sort((a,b)=>Number(b.exact)-Number(a.exact) || Number(!!b.available)-Number(!!a.available));
  const shown=matches.slice(0,12);
  if(preserve && !shown.some(m=>m.id===preserve)) {
    const known=matches.find(m=>m.id===preserve);
    shown.unshift(known || {id:preserve,name:preserve+' · yeniden seçin'});
  }
  row.querySelector('[data-product]').innerHTML=shown.map(m=>'<option value="'+esc(m.id)+'"'+(m.code?' data-code="'+esc(m.code)+'"':'')+'>'+esc(m.name)+'</option>').join('');
  if(preserve) row.querySelector('[data-product]').value=preserve;
  row.querySelector('[data-results]').textContent=matches.length>12?'İlk 12 eşleşme. Aramayı daraltın.':matches.length?'':'Eşleşen ürün yok.';
  configureItem(row, !preserve && selected!==row.querySelector('[data-product]').value);
}
function addItem(data={}) {
  if($('items').children.length>=30) return;
  const row=document.createElement('article');row.className='checkout-line';row.dataset.item='';
  row.innerHTML='<div class="access-bar"><strong data-title></strong><button type="button" data-remove class="button text">Satırı kaldır</button></div><label>Ürün ara<input data-product-search type="search" autocomplete="off" maxlength="160" placeholder="Kod, barkod, ad veya ayar"></label><p data-results role="status"></p><label>Ürün<select data-product required></select></label><small data-available></small><div class="access-columns">'+numeric('data-quantity','<span data-quantity-label>Miktar</span>')+numeric('data-value','Satır toplamı · TL')+'</div><div data-weight-fields class="access-columns" hidden><label>Ayar hesabı<select data-pool></select></label>'+numeric('data-weight','Gerçek gram',false)+'</div><details data-price'+(operation==='purchase'?' hidden':'')+'><summary>Fiyat ayrıntıları · isteğe bağlı</summary><div class="access-columns">'+numeric('data-quoted','Teklif edilen satır bedeli · TL',false)+'<label>Fiyat kaynağı<input data-source maxlength="120"></label></div><div data-components></div><button type="button" data-add-component class="button secondary compact">Fiyat bileşeni ekle</button></details>';
  $('items').append(row);
  const searchInput=row.querySelector('[data-product-search]');
  const productSelect=row.querySelector('[data-product]');
  if(comboboxLib){
    const resultsEl=row.querySelector('[data-results]');
    if(resultsEl)resultsEl.hidden=true;
    const selectLabel=productSelect.closest('label');
    if(selectLabel)selectLabel.hidden=true;
    productSelect.tabIndex=-1;
    productSelect.setAttribute('aria-hidden','true');
    const items=productChoices();
    const initialId=data.selection || items.find(it=>!it.disabled)?.id || '';
    const cbItems=(data.selection && !items.some(it=>it.id===data.selection))
      ? [{id:data.selection,label:data.selection+' · yeniden seçin',disabled:false},...items]
      : items;
    syncProductSelect(row,cbItems,initialId);
    configureItem(row,false);
    let syncingProduct=false;
    const productCb=comboboxLib.create({
      input:searchInput,
      label:'Ürün',
      placeholder:'Kod, barkod, ad veya ayar',
      items:cbItems,
      value:initialId,
      allowDisabled:Boolean(data.selection),
      allowEmpty:false,
      clearable:false,
      required:true,
      maxResults:20,
      openOnFocus:true,
      invalidTextBehavior:'error',
      emptyMessage:'Eşleşen ürün yok.',
      onChange:(val,_item,meta)=>{
        if(syncingProduct)return;
        syncingProduct=true;
        try{
          const changedProduct=productSelect.value!==val;
          syncProductSelect(row,cbItems,val);
          productSelect.setCustomValidity('');
          searchInput.setCustomValidity('');
          searchInput.removeAttribute('aria-invalid');
          if(changedProduct)configureItem(row,true);
          changed();
        }finally{syncingProduct=false;}
        if(meta?.source==='keyboard'||meta?.source==='pointer'){
          const nextTarget=itemProduct(row).serial?row.querySelector('[data-value]'):row.querySelector('[data-quantity]');
          if(nextTarget&&!nextTarget.disabled){
            if(meta.source==='keyboard')nextTarget.focus();
            else queueMicrotask(()=>nextTarget.focus());
          }
        }
      }
    });
    row._productCombobox=productCb;
    productSelect.addEventListener('invalid',event=>{
      if(!row._productCombobox)return;
      event.preventDefault();
      const msg=productSelect.validationMessage||'Geçerli hesap veya ürün seçin.';
      row._productCombobox.input.setCustomValidity?.(msg);
      row._productCombobox.input.setAttribute('aria-invalid','true');
      row._productCombobox.focus();
    });
    productSelect.addEventListener('change',()=>{
      if(syncingProduct)return;
      syncingProduct=true;
      try{
        productCb.setValue(productSelect.value,{emitChange:false});
        productSelect.setCustomValidity('');
        searchInput.setCustomValidity('');
        searchInput.removeAttribute('aria-invalid');
        configureItem(row,true);
        changed();
      }finally{syncingProduct=false;}
    });
  }else{
    searchInput.value=data.search || '';
    listProducts(row,data.selection);
    searchInput.addEventListener('input',()=>{listProducts(row);changed();});
    searchInput.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();(itemProduct(row).serial?row.querySelector('[data-value]'):row.querySelector('[data-quantity]')).focus();}});
    productSelect.addEventListener('change',()=>{configureItem(row,true);changed();});
  }
  for(const key of ['quantity','value','weight']) row.querySelector('[data-'+key+']').value=data[key] ?? row.querySelector('[data-'+key+']').value;
  if(data.weightAccount) row.querySelector('[data-pool]').value=data.weightAccount;
  row.querySelector('[data-quoted]').value=data.pricing?.quotedTL || '';
  row.querySelector('[data-source]').value=data.pricing?.source || '';
  for(const part of data.pricing?.components || []) priceFields(row,part);
  row.querySelector('[data-add-component]').addEventListener('click',()=>{if(row.querySelector('[data-components]').children.length<12){priceFields(row);changed();}});
  row.querySelector('[data-remove]').addEventListener('click',()=>{row._productCombobox?.destroy?.();row.remove();renumber();changed();});
  renumber();
  return row;
}
function renumber() {
  [...$('items').children].forEach((row,index)=>row.querySelector('[data-title]').textContent=(index+1)+'. ürün');
  $('add-item').disabled=$('items').children.length>=30;
}
function allocationAccount(row) {
  const id=row.querySelector('[data-account]').value;
  return allocationChoices(row).find(a=>a.id===id);
}
function allocationChoices(row) {
  const kind=row.dataset.allocation;
  if(['credits','debts'].includes(kind))return selectedCustomer?.accounts || [];
  if(row.dataset.category==='money')return (snapshot?.payments || []).filter(a=>kind!=='given'||a.id!=='pos');
  return (snapshot?.products || []).filter(p=>p.canBuy && (row.dataset.category==='scrap'?p.scrap===true:p.scrap!==true));
}
function allocationCategory(kind,data) {
  if(['credits','debts'].includes(kind))return 'customer';
  if(['money','product','scrap'].includes(data.category))return data.category;
  const product=snapshot?.products.find(p=>p.id===data.accountId);
  return product?(product.scrap===true?'scrap':'product'):'money';
}
function allocationOptions(row,preserve) {
  const kind=row.dataset.allocation,cari=['credits','debts'].includes(kind);
  const accounts=allocationChoices(row);
  const select=row.querySelector('[data-account]'),previous=preserve || select.value;
  if(row._accountCombobox){
    const cbItems=accounts.map(a=>({id:a.id,label:a.name,unit:a.unit,subtitle:a.unit,keywords:[a.id,a.name,a.unit].filter(Boolean).join(' ')}));
    let targetId=previous || '';
    if(previous && !accounts.some(a=>a.id===previous)) cbItems.push({id:previous,label:previous+' · yeniden seçin',unit:''});
    else if(!previous && cari && accounts.length===1) targetId=accounts[0].id;
    row._accountCombobox.setItems(cbItems);
    if(targetId)row._accountCombobox.setValue(targetId,{emitChange:false,allowDisabled:Boolean(previous)});
    else row._accountCombobox.clear({emitChange:false});
  }else{
    select.innerHTML='<option value="">Hesap seçin</option>'+accounts.map(a=>option(a.id,a.name+' · '+a.unit)).join('');
    if(previous) {
      if(!accounts.some(a=>a.id===previous)) select.insertAdjacentHTML('beforeend',option(previous,previous+' · yeniden seçin'));
      select.value=previous;
    } else if(cari && accounts.length===1) select.value=accounts[0].id;
  }
  configureAllocation(row);
}
function configureAllocation(row) {
  const account=allocationAccount(row),unit=account?.unit,pool=row.querySelector('[data-pool]');
  row.querySelector('[data-quantity-label]').textContent=unit?'Miktar · '+unit:'Miktar';
  const previous=pool.value;
  pool.innerHTML=(account?.weights || []).map(a=>option(a.id,a.name)).join('');
  if([...pool.options].some(o=>o.value===previous))pool.value=previous;
  row.querySelector('[data-weight-fields]').hidden=!account?.weights?.length;
  row.querySelector('[data-weight]').required=!!account?.weights?.length;
  pool.required=!!account?.weights?.length;
  row.querySelector('[data-reference]').hidden=unit==='TL';
  row.querySelector('[data-value]').required=unit!=='TL';
  if(unit==='TL')row.querySelector('[data-value]').value=row.querySelector('[data-quantity]').value;
}
function addAllocation(kind,data={}) {
  if($(kind).children.length>=30)return;
  const row=document.createElement('div');row.className='checkout-line';row.dataset.allocation=kind;
  row.dataset.category=allocationCategory(kind,data);
  const label={money:'Para hesabı',product:'Ürün',scrap:'Hurda hesabı',customer:'Seçilen müşterinin cari hesabı'}[row.dataset.category];
  row.innerHTML='<label><span>'+label+'</span><select data-account required></select></label><div class="access-columns">'+numeric('data-quantity','<span data-quantity-label>Miktar</span>')+'<div data-reference>'+numeric('data-value','Anlaşılmış TL karşılığı')+'</div></div><div data-weight-fields class="access-columns" hidden><label>Ayar hesabı<select data-pool></select></label>'+numeric('data-weight','Gerçek gram',false)+'</div><button type="button" data-remove class="button text">Karşılığı kaldır</button>';
  $(kind).append(row);
  const accountSelect=row.querySelector('[data-account]');
  if(comboboxLib?.enhanceSelect){
    row._accountCombobox=comboboxLib.enhanceSelect(accountSelect,{label,smallListThreshold:50,maxNativeOptions:2,allowEmpty:true,emptyLabel:'Hesap seçin',placeholder:'Hesap veya ürün ara…',invalidTextBehavior:'revert',formatSelectedText:item=>item.unit?`${item.label} · ${item.unit}`:item.label});
  }
  allocationOptions(row,data.accountId);
  for(const key of ['quantity','weight'])row.querySelector('[data-'+key+']').value=data[key] || '';
  row.querySelector('[data-value]').value=data.valueTL || '';
  if(data.weightAccount)row.querySelector('[data-pool]').value=data.weightAccount;
  configureAllocation(row);
  row.querySelector('[data-account]').addEventListener('change',()=>{for(const key of ['quantity','value','weight']){const el=row.querySelector('[data-'+key+']');clearAmountInputState(el);el.value='';}configureAllocation(row);changed();});
  row.querySelector('[data-quantity]').addEventListener('input',()=>configureAllocation(row));
  row.querySelector('[data-remove]').addEventListener('click',()=>{row._accountCombobox?.destroy?.();row.remove();changed();});
  return row;
}
function draft() {
  return {revision:draftRevision,date:draftDate,customer:selectedCustomer,note:$('note').value,
    flowMode, manualFlowMode, activeStep,
    items:[...$('items').children].map(row=>({selection:row.querySelector('[data-product]').value,search:row.querySelector('[data-product-search]').value,quantity:row.querySelector('[data-quantity]').value,value:row.querySelector('[data-value]').value,weight:row.querySelector('[data-weight]').value,weightAccount:row.querySelector('[data-pool]').value,pricing:pricing(row,false)})),
    ...Object.fromEntries(groups.map(kind=>[kind,[...$(kind).children].map(row=>({category:row.dataset.category,accountId:row.querySelector('[data-account]').value,quantity:row.querySelector('[data-quantity]').value,valueTL:row.querySelector('[data-value]').value,weight:row.querySelector('[data-weight]').value,weightAccount:row.querySelector('[data-pool]').value}))]))};
}
function saveDraft() {
  if (!current()) return;
  if (snapshot && !rendering && draftDirty) {
    const payload = draft();
    const store = getDraftStore();
    store.saveDraft(draftStoreKey(), {
      meta: {
        actorId: actorId(),
        workspace,
        workday: draftDate ?? snapshot.date,
        revision: draftRevision ?? snapshot.revision,
        formId: 'checkout-' + operation,
        type: operation
      },
      data: payload
    });
    try { sessionStorage.setItem(legacyDraftKey(), JSON.stringify(payload)); } catch {}
  }
}
function changed(event) {
  if(rendering)return;
  event?.target?.setCustomValidity?.('');
  draftDirty=true;
  review=null;$('review').hidden=true;
  totals();
  syncFlowMode({ preferredStep: event?.preferredStep || (event?.target?.closest?.('[data-allocation]') ? 2 : null), notify: true });
  saveDraft();controls();
}
function renderLiveSummary() {
  const customerCard = $('summary-customer');
  if (customerCard) {
    if (!selectedCustomer) {
      customerCard.innerHTML = '<h3>Müşteri</h3><p class="context-note">Peşin / kayıtsız müşteri · cari hesap etkisi yok</p>';
    } else {
      const balanceText = (val, unit) => `${format(Math.abs(val), unit)} · ${val > 0 ? 'Alacağımız' : val < 0 ? 'Borcumuz' : 'Bakiye sıfır'}`;
      const rows = (selectedCustomer.accounts || []).map(acc => {
        let net = 0, valid = true;
        for (const kind of ['credits', 'debts']) {
          for (const row of $(kind).children) {
            if (row.querySelector('[data-account]').value !== acc.id) continue;
            const qty = parseReadOnlyAmount(row.querySelector('[data-quantity]'), acc.unit);
            if (qty === null) valid = false;
            else net += qty * (kind === 'credits' ? 1 : -1);
          }
        }
        const next = (acc.balance || 0) + net;
        const nextStr = valid && Number.isSafeInteger(next) ? balanceText(next, acc.unit) : 'Eksik';
        return `<p><strong>${esc(acc.name)}</strong><span>${esc(balanceText(acc.balance || 0, acc.unit))} → ${esc(nextStr)}</span></p>`;
      }).join('');
      customerCard.innerHTML = `<h3>Müşteri cari özeti</h3>${rows || '<p class="context-note">Müşteri hesabı yok.</p>'}`;
    }
  }
  const linesList = $('summary-lines');
  if (linesList) {
    const items = [];
    for (const row of $('items').children) {
      const { product } = itemProduct(row);
      const qty = parseReadOnlyAmount(row.querySelector('[data-quantity]'), product?.unit || 'ADET');
      const val = parseReadOnlyAmount(row.querySelector('[data-value]'), 'TL');
      items.push(`<li><span>${esc(product?.name || 'Ürün')} · ${esc(qty === null ? 'Eksik' : format(qty, product?.unit || 'ADET'))}</span><strong>${esc(val === null ? 'Eksik' : format(val, 'TL'))}</strong></li>`);
    }
    const shortLabels = { received: 'Alınan', given: 'Verilen', credits: 'Cari alacak', debts: 'Cari borç' };
    for (const kind of groups) {
      for (const row of $(kind).children) {
        const acc = allocationAccount(row);
        const qty = acc ? parseReadOnlyAmount(row.querySelector('[data-quantity]'), acc.unit) : null;
        const val = parseReadOnlyAmount(row.querySelector('[data-value]'), 'TL');
        items.push(`<li><span>${esc(shortLabels[kind])} · ${esc(acc?.name || 'Hesap seçin')} · ${esc(qty === null || !acc ? 'Eksik' : format(qty, acc.unit))}</span><strong>${esc(val === null ? 'Eksik' : format(val, 'TL'))}</strong></li>`);
      }
    }
    linesList.innerHTML = items.join('') || '<li class="context-note">Henüz satır yok.</li>';
  }
}
function selectedPerson(person, { syncCombobox = true } = {}) {
  selectedCustomer=person;
  $('customer').innerHTML=option('','Müşteri seçilmedi')+(person?option(person.id,person.name+' · '+person.accounts[0].unit):'');
  $('customer').value=person?.id || '';
  if(syncCombobox&&customerCombobox){
    if(person){
      const unit=person.accounts?.[0]?.unit || '';
      customerCombobox.setValue(person.id,{
        emitChange:false,
        item:{
          id:person.id,
          label:person.name,
          unit,
          phone:person.phone || '',
          taxId:person.taxId || '',
          disambiguationLabel:[unit,person.phone,person.taxId?'TC/VKN '+person.taxId:''].filter(Boolean).join(' · ')
        }
      });
    }else{
      customerCombobox.setValue('',{emitChange:false});
    }
  }
  $('customer-balance').textContent=person?person.accounts.map(a=>a.name+' · '+(a.balance<0?'Borcumuz ':a.balance>0?'Alacağımız ':'Bakiye ')+format(Math.abs(a.balance),a.unit)).join(' / '):'';
  for(const kind of ['credits','debts'])for(const row of $(kind).children)allocationOptions(row);
  renderLiveSummary();
}
function restoreDraft(saved) {
  rendering=true;
  for(const id of ['items',...groups]){
    for(const row of $(id).children){
      row._productCombobox?.destroy?.();
      row._accountCombobox?.destroy?.();
    }
    $(id).replaceChildren();
  }
  selectedPerson(saved?.customer || null);
  draftRevision=saved?.revision ?? snapshot.revision;draftDate=saved?.date ?? snapshot.date;
  draftDirty=Boolean(saved);
  manualFlowMode=saved?.manualFlowMode ?? (saved?.flowMode === 'guided' ? 'guided' : null);
  activeStep=[1,2,3].includes(Number(saved?.activeStep)) ? Number(saved.activeStep) : 1;
  for(const item of saved?.items || [{}])addItem(item);
  for(const kind of groups)for(const row of saved?.[kind] || [])addAllocation(kind,row);
  $('note').value=saved?.note || '';
  $('items-title').textContent=operation==='sale'?'Satılan ürünler':'Alınan ürünler';
  $('total-label').textContent=operation==='sale'?'Satış bedeli':'Alış bedeli';
  rendering=false;
  syncFlowMode({ preferredStep: activeStep, notify: false });
  totals();controls();
}
function totals() {
  let total=0,net=0,incomplete=0;
  for(const row of $('items').children) {const amount=parse(row.querySelector('[data-value]'));if(amount===null)incomplete++;else total+=amount;}
  for(const kind of groups)for(const row of $(kind).children) {
    configureAllocation(row);const amount=parse(row.querySelector('[data-value]'));
    if(amount===null || !allocationAccount(row))incomplete++;
    else net+=amount*(['received','credits'].includes(kind)?1:-1);
  }
  const difference=total-(operation==='sale'?net:-net);
  $('total').textContent=format(total);
  $('balance').textContent=!$('items').children.length?'Ürün ekleyin':incomplete?'Eksik tutarları tamamlayın':difference===0?'Tam dengeli':'Fark '+format(difference);
  const eq=$('checkout-equation');
  if(eq){
    const balanced=Boolean($('items').children.length)&&!incomplete&&difference===0;
    const partial=Boolean($('items').children.length)&&(incomplete||difference>0);
    eq.classList.toggle('is-balanced',balanced);
    eq.classList.toggle('is-partial',!balanced&&partial);
    eq.classList.toggle('is-error',!balanced&&!partial);
  }
  for(const btn of document.querySelectorAll('[data-add]'))btn.disabled=$(btn.dataset.add).children.length>=30;
  if(quickFillCashBtn){
    const primaryKind=operation==='sale'?'received':'given';
    const cashAcc=(snapshot?.payments || []).find(p=>p.id==='nakit') || (snapshot?.payments || []).find(p=>p.unit==='TL');
    quickFillCashBtn.hidden=!(flowMode==='quick'&&$(primaryKind).children.length===0&&total>0&&incomplete===0&&Boolean(cashAcc));
  }
  renderLiveSummary();
  return {total,difference,incomplete};
}
function validateRow(row,product,primary) {
  const select=row.querySelector(primary?'[data-product]':'[data-account]');
  const msg=product?'':'Geçerli hesap veya ürün seçin.';
  select.setCustomValidity(msg);
  if(primary&&row._productCombobox?.input){
    row._productCombobox.input.setCustomValidity?.(msg);
    if(msg)row._productCombobox.input.setAttribute('aria-invalid','true');
    else row._productCombobox.input.removeAttribute('aria-invalid');
  }
  if(!product)return;
  parse(row.querySelector('[data-quantity]'),product.unit);
  parse(row.querySelector('[data-value]'));
  if(product.weights?.length)parse(row.querySelector('[data-weight]'),'GRAM');
}
function command() {
  const items=[],prices=[],serials=new Set();
  for(const row of $('items').children) {
    const {product,serial}=itemProduct(row);validateRow(row,product,true);
    if(!product)continue;
    if(serials.has(serial?.code)){
      const dupMsg='Tekil ürün bu işlemde bir kez seçilebilir.';
      row.querySelector('[data-product]').setCustomValidity(dupMsg);
      if(row._productCombobox?.input){
        row._productCombobox.input.setCustomValidity?.(dupMsg);
        row._productCombobox.input.setAttribute('aria-invalid','true');
      }
    }
    if(serial)serials.add(serial.code);
    const item={accountId:product.id,quantity:canonical(row.querySelector('[data-quantity]'),product.unit,true),value:canonical(row.querySelector('[data-value]'),'TL',true)};
    if(serial)item.inventoryCode=serial.code;
    if(product.weights.length)Object.assign(item,{weightAccount:row.querySelector('[data-pool]').value,weight:canonical(row.querySelector('[data-weight]'),'GRAM',true)});
    items.push(item);
    const price=pricing(row, true);prices.push(price);
    if(operation==='sale'&&price) {
      parse(row.querySelector('[data-quoted]'),'TL',false,true,true);
      for(const part of row.querySelector('[data-components]').children) {part.querySelector('[data-component-name]').required=true;parseSignedTL(part.querySelector('[data-component-value]'),false,false);}
    }
  }
  const result={type:operation,date:snapshot.date,counterpartyType:'customer',counterpartyId:selectedCustomer?.id || '',items};
  if(operation==='purchase')result.source='customer';
  if(operation==='sale'&&prices.some(Boolean))result.salePricing={version:1,lines:prices};
  for(const kind of groups)result[kind]=[...$(kind).children].map(row=>{
    const account=allocationAccount(row);validateRow(row,account,false);
    const allocation={accountId:row.querySelector('[data-account]').value,quantity:canonical(row.querySelector('[data-quantity]'),account?.unit||'TL',true),valueTL:canonical(row.querySelector('[data-value]'),'TL',true)};
    if(['credits','debts'].includes(kind)&&!selectedCustomer?.accounts.some(a=>a.id===allocation.accountId))row.querySelector('[data-account]').setCustomValidity('Seçilen müşterinin hesabını kullanın.');
    if(account?.weights?.length)Object.assign(allocation,{weightAccount:row.querySelector('[data-pool]').value,weight:canonical(row.querySelector('[data-weight]'),'GRAM',true)});
    return allocation;
  });
  if($('note').value.trim())result.note=$('note').value.trim();
  return result;
}
function renderReview(c) {
  status('');
  const names=new Map([...(snapshot.products || []),...snapshot.payments,...(selectedCustomer?.accounts || [])].map(a=>[a.id,a]));
  const lines=[...c.items.map(row=>({label:operation==='sale'?'Satılan':'Alınan ürün',row,reference:row.value})),...groups.flatMap(kind=>c[kind].map(row=>({label:groupNames[kind],row,reference:row.valueTL})))];
  const fmtReview = (val, u) => {
    if (!codec) return `${val} ${u}`;
    const res = codec.parseUserAmount(val, u, { positive: true, allowZero: true, resolution: 'decimal' });
    return res.status === 'valid' ? res.formatted : `${val} ${u}`;
  };
  $('review-content').innerHTML='<p>'+esc((operation==='sale'?'Satış':'Alış')+' · '+day(snapshot.date)+' · '+(selectedCustomer?.name || 'Müşteri seçilmedi'))+'</p><div class="table-wrap"><table><thead><tr><th scope="col">İşlem</th><th scope="col">Hesap / ürün</th><th scope="col">Miktar</th><th scope="col">TL bedeli</th></tr></thead><tbody>'+lines.map(({label,row,reference})=>{const u=names.get(row.accountId)?.unit||'TL';return '<tr><td data-review-label="İşlem">'+esc(label)+'</td><td data-review-label="Ürün / hesap">'+esc(names.get(row.accountId)?.name || row.accountId)+(row.inventoryCode?' · '+esc(row.inventoryCode):'')+'</td><td data-review-label="Miktar">'+esc(fmtReview(row.quantity,u))+(row.weight?' · '+esc(fmtReview(row.weight,'GRAM')):'')+'</td><td data-review-label="TL bedeli">'+esc(fmtReview(reference,'TL'))+'</td></tr>';}).join('')+'</tbody></table></div>';
  $('review').hidden=false;controls();$('review-title').focus();
}
function stockTable() {
  const query=normalize($('stock-search').value);
  const rows=(snapshot?.stocks || snapshot?.products || []).filter(a=>normalize(a.id+' '+a.name+' '+a.unit).includes(query));
  stockPage=Math.max(0,Math.min(stockPage,Math.ceil(rows.length/30)-1));
  $('stock-list').innerHTML=rows.slice(stockPage*30,stockPage*30+30).map(a=>'<tr><td>'+esc(a.name)+'</td><td class="numeric">'+esc(format(a.quantity ?? 0,a.unit))+'</td><td class="numeric">'+esc(a.freeQuantity===undefined?'—':format(a.freeQuantity,a.unit))+'</td></tr>').join('');
  $('stock-status').textContent=rows.length?(stockPage*30+1)+'–'+Math.min(rows.length,stockPage*30+30)+' / '+rows.length+' hesap':'Eşleşen stok veya hesap yok.';
  $('stock-prev').disabled=stockPage===0;$('stock-next').disabled=(stockPage+1)*30>=rows.length;
}
async function refresh() {
  if(writing)return;
  saveDraft();
  ++customerSequence;customerLoading=false;
  const sequence=++loadSequence,selected=workspace;
  pending=readStoredPending(workspace);
  if(pending?.command && !pending.envelope) pending={envelope:pending,kind:'trade',operation:pending.command.type,workspace};
  snapshot=null;controls();$('trade').hidden=true;status('Mevcutlar yükleniyor…');
  try {
    const fresh=await api(route('checkout',selected));
    if(sequence!==loadSequence || selected!==workspace)return;
    snapshot=fresh;externalRevision=Math.max(externalRevision,fresh.revision);
    $('date').textContent=fresh.initialized?'Açık iş günü · '+day(fresh.date):'Bu defterin açılışını işletme sahibi yapmalı.';
    restoreDraft(readStoredDraft(workspace, operation));stockTable();$('trade').hidden=!fresh.initialized;
    if(selectedCustomer && !pending) await lookupCustomer(selectedCustomer.id);
    if(sequence!==loadSequence || selected!==workspace)return;
    status('');
  }catch(error){if(sequence===loadSequence)status(error.message);}
  controls();
}
async function lookupCustomer(id) {
  const sequence=++customerSequence,selected=workspace;
  if(!id){selectedPerson(null,{syncCombobox:true});changed();return;}
  customerLoading=true;selectedPerson(null,{syncCombobox:false});changed();status('Müşteri hesabı yükleniyor…');
  try {
    const person=await api(route('customers',selected)+'&id='+encodeURIComponent(id));
    if(sequence!==customerSequence || selected!==workspace)return;
    selectedPerson(person,{syncCombobox:true});changed();status('');
  }catch(error){if(sequence===customerSequence){selectedPerson(null,{syncCombobox:true});status(error.message);changed();}}
  finally {if(sequence===customerSequence){customerLoading=false;controls();}}
}
async function sendPending() {
  if(writing || !pending)return;
  const request=pending,selected=workspace;
  writing=true;controls();
  let message;
  try {
    const result=await api(route('command',selected),request.envelope);
    saveStoredPending(null,selected);pending=null;
    broadcast?.postMessage({actorId:actorId(),workspace:selected,revision:result.revision});
    message=(result.duplicate?'Önceki kayıt doğrulandı. ':'İşlem kaydedildi. ')+'Kayıt '+result.id;
    if(request.kind==='trade') {
      // GUI Faz 9: check-mark toast + chime for a new sale/purchase. #status still announces the text.
      if(!result.duplicate)uiKit?.celebrate?.(message,{announce:false});
      clearStoredDraft(selected,request.operation);
      customerCombobox?.clear?.({emitChange:false});
      $('search').value='';
      rendering=true;for(const id of ['items',...groups]){for(const row of $(id).children){row._productCombobox?.destroy?.();row._accountCombobox?.destroy?.();}$(id).replaceChildren();}rendering=false;
      snapshot=null;
    } else {
      if(draftRevision===request.envelope.revision && draftDate===request.envelope.command.date) draftRevision=result.revision;
      saveDraft();
      $('customer-form').reset();$('new-customer').open=false;$('other-unit-field').hidden=true;
      $('customer-form').elements.currencyCode.required=false;
      uiKit?.clearBanner?.($('customer-drawer-notice'));
      activeCustomerDrawer?.close('saved');
      uiKit?.toast?.('Müşteri kartı oluşturuldu ve seçildi.', { kind: 'success' });
      request.createdCustomer=result.account;
    }
  }catch(error){
    if(error.status>=400&&error.status<500){saveStoredPending(null,selected);pending=null;}
    if(request.kind==='customer' && activeCustomerDrawer) {
      if(error.status===409 || !(error.status>=400 && error.status<500)) {
        activeCustomerDrawer.close(error.status===409 ? 'conflict' : 'pending');
      } else {
        uiKit?.showBanner?.($('customer-drawer-notice'), error.message, { kind: 'error', focus: false });
      }
    }
    message=error.message;
  }finally{
    writing=false;review=null;$('review').hidden=true;
    await refresh();
    if(request.createdCustomer)await lookupCustomer(request.createdCustomer.id);
    status(message);controls();
  }
}
function queue(envelope,kind) {
  if(pending || writing)return;
  ++customerSequence;customerLoading=false;
  pending={envelope,kind,operation,workspace};
  saveStoredPending(pending,workspace);controls();
  void sendPending();
}
const openAncestorDetails = el => {
  for (let d = el?.closest?.('details'); d; d = d.parentElement?.closest('details')) d.open = true;
};
const setCheckoutStep = step => {
  activeStep = [1, 2, 3].includes(Number(step)) ? Number(step) : 1;
  $('trade').querySelectorAll('[data-step-panel]').forEach(panel => panel.classList.toggle('is-active', Number(panel.dataset.stepPanel) === activeStep));
  $('trade').querySelectorAll('[data-step-target]').forEach(tab => {
    const active = Number(tab.dataset.stepTarget) === activeStep;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-current', active ? 'step' : 'false');
  });
  if (draftDirty && !rendering) saveDraft();
};
uiKit?.enhanceStepper?.($('trade')?.querySelector('.stepper-bar'), $('trade'));
function syncFlowMode({ preferredStep = null, notify = false } = {}) {
  const prevMode = flowMode;
  const complex = isComplexCheckoutState();
  flowMode = complex ? 'guided' : (manualFlowMode === 'guided' ? 'guided' : 'quick');
  const trade = $('trade');
  if (!trade) return;
  trade.dataset.flowMode = flowMode;
  trade.classList.toggle('checkout-trade-quick', flowMode === 'quick');
  trade.classList.toggle('checkout-trade-stepper', flowMode === 'guided');
  const stepperBar = trade.querySelector('.stepper-bar');
  if (stepperBar) stepperBar.hidden = flowMode !== 'guided';
  trade.querySelectorAll('.stepper-nav').forEach(nav => { nav.hidden = flowMode !== 'guided'; });
  const quickExtras = trade.querySelector('.checkout-quick-extras');
  if (quickExtras) quickExtras.hidden = flowMode === 'guided';
  const primaryKind = operation === 'sale' ? 'received' : 'given';
  const oppositeKind = operation === 'sale' ? 'given' : 'received';
  for (const kind of ['received', 'given', 'credits', 'debts']) {
    const groupEl = trade.querySelector(`[data-alloc-group="${kind}"]`);
    if (groupEl) groupEl.dataset.quickSecondary = kind === primaryKind ? 'false' : 'true';
  }
  const quickBtn = trade.querySelector('[data-flow-mode="quick"]');
  const guidedBtn = trade.querySelector('[data-flow-mode="guided"]');
  if (quickBtn) {
    quickBtn.setAttribute('aria-pressed', String(flowMode === 'quick'));
    quickBtn.disabled = writing || !!pending || !!review || !snapshot || complex;
  }
  if (guidedBtn) {
    guidedBtn.setAttribute('aria-pressed', String(flowMode === 'guided'));
    guidedBtn.disabled = writing || !!pending || !!review || !snapshot;
  }
  const titleEl = $('checkout-flow-title');
  const noteEl = $('checkout-flow-note');
  if (titleEl && noteEl) {
    if (flowMode === 'quick') {
      titleEl.textContent = 'Hızlı tezgâh modu';
      noteEl.textContent = 'Tek ürün, tek TL ödeme ve not için tek ekran.';
    } else if (complex) {
      titleEl.textContent = 'Rehberli adımlar (karma işlem)';
      noteEl.textContent = 'Çoklu ürün, hurda, verilen karşılık, TL dışı ödeme veya cari satırı nedeniyle adım adım kontrol açık.';
    } else {
      titleEl.textContent = 'Rehberli adımlar';
      noteEl.textContent = 'Ürünler, ödeme/karşılık ve onay adımlarıyla ilerleyin.';
    }
  }
  if (prevMode === 'quick' && flowMode === 'guided') {
    activeStep = preferredStep || activeStep;
    if (notify && !rendering && complex) {
      uiKit?.toast?.('Karma işlem algılandı; rehberli adımlara geçildi.', { kind: 'info', durationMs: 3000 });
    }
  } else if (preferredStep && flowMode === 'guided') {
    activeStep = preferredStep;
  }
  setCheckoutStep(activeStep);
}
const validateCheckoutStep = stepNum => {
  if (stepNum === 1) {
    for (const row of $('items').children) {
      const { product } = itemProduct(row);
      validateRow(row, product, true);
    }
  } else if (stepNum === 2) {
    for (const kind of groups) {
      for (const row of $(kind).children) {
        validateRow(row, allocationAccount(row), false);
      }
    }
  }
  const panel = $('trade').querySelector(`[data-step-panel="${stepNum}"]`);
  const invalid = panel && [...panel.querySelectorAll('input,select,textarea')].find(el => !el.disabled && !el.checkValidity());
  if (invalid) {
    openAncestorDetails(invalid);
    if (flowMode === 'guided') setCheckoutStep(stepNum);
    invalid.reportValidity();
    return false;
  }
  return true;
};
$('trade').querySelectorAll('[data-flow-mode]').forEach(btn => btn.addEventListener('click', () => {
  if (writing || pending || review || !snapshot) return;
  const target = btn.dataset.flowMode;
  if (target === 'quick' && isComplexCheckoutState()) return;
  manualFlowMode = target === 'guided' ? 'guided' : null;
  syncFlowMode({ preferredStep: activeStep, notify: false });
  if (draftDirty) saveDraft();
  controls();
}));
$('trade').querySelector('[data-escalate-guided]')?.addEventListener('click', () => {
  if (writing || pending || review || !snapshot) return;
  manualFlowMode = 'guided';
  syncFlowMode({ preferredStep: 2, notify: false });
  if (draftDirty) saveDraft();
  controls();
});
$('trade').querySelectorAll('[data-step-target]').forEach(btn => btn.addEventListener('click', () => {
  const target = Number(btn.dataset.stepTarget);
  const current = Number($('trade').querySelector('[data-step-panel].is-active')?.dataset.stepPanel || 1);
  if (target > current) for (let s = current; s < target; s++) if (!validateCheckoutStep(s)) return;
  setCheckoutStep(target);
}));
$('trade').querySelectorAll('[data-step-next], [data-step-prev]').forEach(btn => btn.addEventListener('click', () => {
  const next = Number(btn.dataset.stepNext || btn.dataset.stepPrev);
  if (btn.dataset.stepNext) {
    const current = Number(btn.closest('[data-step-panel]')?.dataset.stepPanel || 1);
    if (!validateCheckoutStep(current)) return;
  }
  setCheckoutStep(next);
}));
$('trade').addEventListener('invalid', event => {
  openAncestorDetails(event.target);
  const panel = event.target?.closest?.('[data-step-panel]');
  if (panel && flowMode === 'guided') setCheckoutStep(Number(panel.dataset.stepPanel));
}, true);
$('trade').addEventListener('submit',event=>{
  event.preventDefault();if(writing||pending||customerLoading||!snapshot||isStale())return;
  if(customerCombobox&&!customerCombobox.validate({report:true})){
    status('Müşteri aramasında listeden geçerli bir seçim yapın veya alanı temizleyin.');
    customerCombobox.focus({preventScroll:true,open:false});
    return;
  }
  if($('search')&&(!$('search').checkValidity()||$('search').getAttribute('aria-invalid')==='true')){
    status('Müşteri aramasında listeden geçerli bir seçim yapın veya alanı temizleyin.');
    $('search').reportValidity?.();
    $('search').focus();
    return;
  }
  const totalsResult=totals(),c=command();
  if(flowMode==='guided'&&(!validateCheckoutStep(1)||!validateCheckoutStep(2))){status('Ürün ve karşılık satırlarını tamamlayın.');return;}
  if(!$('trade').reportValidity() || !c.items.length){status('Ürün ve karşılık satırlarını tamamlayın.');return;}
  if(totalsResult.incomplete||totalsResult.difference!==0){status('Ürün bedeli ile karşılıkların TL dengesini tamamlayın.');return;}
  saveDraft();review={id:crypto.randomUUID(),revision:snapshot.revision,command:c};renderReview(c);
});
$('confirm').addEventListener('click',()=>{if(review&&!isStale())queue(review,'trade');else{review=null;$('review').hidden=true;controls();}});
$('edit').addEventListener('click',()=>{review=null;$('review').hidden=true;controls();$('record').focus();});
$('trade').addEventListener('input',changed);
$('trade').addEventListener('change',changed);
$('add-item').addEventListener('click',()=>{const row=addItem();changed({preferredStep:1});row?.querySelector('input').focus();});
for(const button of document.querySelectorAll('[data-add]'))button.addEventListener('click',()=>{const kind=button.dataset.add;const row=addAllocation(kind,{category:button.dataset.category});changed({preferredStep:2});if(!row)return;const select=row.querySelector('select');const preboundCari=['credits','debts'].includes(kind)&&Boolean(select?.value);if(preboundCari){row.querySelector('[data-quantity]')?.focus({preventScroll:true});}else if(row._accountCombobox){row._accountCombobox.focus({preventScroll:true,open:false});}else{select?.focus({preventScroll:true});}});
function syncCustomerDrawerTrigger() {
  const openBtn = $('open-customer-drawer');
  const details = $('new-customer');
  if (!openBtn || !details) return;
  if (uiKit?.openDrawer) {
    openBtn.hidden = false;
    details.hidden = true;
    details.open = false;
  } else {
    openBtn.hidden = true;
    details.hidden = false;
  }
}
$('open-customer-drawer')?.addEventListener('click', () => {
  if (writing || pending || review || !snapshot || activeCustomerDrawer || !uiKit?.openDrawer) return;
  const customerForm = $('customer-form');
  if (!customerForm) return;
  uiKit.clearBanner?.($('customer-drawer-notice'));
  activeCustomerDrawer = uiKit.openDrawer({
    title: 'Yeni Müşteri Kartı',
    subtitle: 'Tezgâh taslağınız korunur; müşteri eklendiğinde otomatik seçilir.',
    content: customerForm,
    trigger: $('open-customer-drawer'),
    onClose: () => {
      activeCustomerDrawer = null;
      uiKit.clearBanner?.($('customer-drawer-notice'));
      const host = $('new-customer');
      if (host && customerForm.parentElement !== host) host.append(customerForm);
      controls();
    }
  });
  controls();
});
const quickExtrasHost=$('trade')?.querySelector('.checkout-quick-extras');
if(quickExtrasHost&&!$('quick-fill-cash')){
  quickFillCashBtn=document.createElement('button');
  quickFillCashBtn.type='button';
  quickFillCashBtn.id='quick-fill-cash';
  quickFillCashBtn.className='button secondary compact';
  quickFillCashBtn.dataset.quickFillCash='';
  quickFillCashBtn.textContent='Tam tutarı Nakit doldur';
  quickFillCashBtn.hidden=true;
  quickFillCashBtn.addEventListener('click',()=>{
    if(writing||pending||review||!snapshot)return;
    const primaryKind=operation==='sale'?'received':'given';
    const cashAcc=(snapshot?.payments || []).find(p=>p.id==='nakit') || (snapshot?.payments || []).find(p=>p.unit==='TL');
    if($(primaryKind).children.length>0||!cashAcc)return;
    const totalsRes=totals();
    if(totalsRes.total<=0||totalsRes.incomplete>0)return;
    const row=addAllocation(primaryKind,{category:'money',accountId:cashAcc.id});
    if(!row)return;
    const qtyInput=row.querySelector('[data-quantity]');
    if(qtyInput){
      qtyInput.value=codec?codec.canonicalFromScaled(totalsRes.total,'TL'):(totalsRes.total/100).toFixed(2);
      qtyInput.dispatchEvent(new Event('input',{bubbles:true}));
    }
    changed({preferredStep:2});
    $('record')?.focus({preventScroll:true});
  });
  quickExtrasHost.prepend(quickFillCashBtn);
}
syncCustomerDrawerTrigger();
if(comboboxLib&&$('search')){
  const customerFieldLabel=$('customer')?.closest('label');
  if(customerFieldLabel)customerFieldLabel.hidden=true;
  $('customer').tabIndex=-1;
  $('customer').setAttribute('aria-hidden','true');
  customerCombobox=comboboxLib.create({
    input:$('search'),
    label:'Müşteri ara ve seç',
    placeholder:'Ad, telefon, TC/VKN veya kod ile ara…',
    allowEmpty:true,
    clearable:true,
    debounceMs:180,
    minQueryLength:2,
    maxResults:20,
    openOnFocus:false,
    invalidTextBehavior:'error',
    emptyMessage:'Müşteri bulunamadı. Yeni müşteri kartı açabilirsiniz.',
    formatSelectedText:item=>item.unit?`${item.label} · ${item.unit}`:item.label,
    provider:async(query,{signal,limit})=>{
      const selectedWs=workspace;
      const url=route('customers',selectedWs)+'&q='+encodeURIComponent(query)+'&limit='+encodeURIComponent(limit||20)+'&meta=1';
      const data=await apiWithSignal(url,signal);
      const rawItems=Array.isArray(data)?data:(data?.items||[]);
      const total=Array.isArray(data)?data.length:(Number.isFinite(Number(data?.total))?Number(data.total):rawItems.length);
      return {
        items:rawItems.map(p=>({
          id:p.id,
          label:p.name,
          unit:p.unit||'',
          phone:p.phone||'',
          taxId:p.taxId||'',
          disambiguationLabel:p.disambiguationLabel||[p.unit,p.phone,p.taxId?`TC/VKN ${p.taxId}`:''].filter(Boolean).join(' · ')
        })),
        total
      };
    },
    onQuery:()=>{
      ++customerSequence;
      customerLoading=false;
      controls();
    },
    onChange:val=>{
      void lookupCustomer(val);
    }
  });
}else{
  $('search').addEventListener('input',async()=>{
    const sequence=++customerSequence,selected=workspace,query=$('search').value.trim();
    customerLoading=false;controls();
    if(query.length<2)return;
    try {
      const people=await api(route('customers',selected)+'&q='+encodeURIComponent(query));
      if(sequence!==customerSequence || selected!==workspace)return;
      $('customer').innerHTML=option('','Müşteri seçilmedi')+people.map(p=>option(p.id,p.name+' · '+p.unit)).join('');
      if(selectedCustomer&&!people.some(p=>p.id===selectedCustomer.id))$('customer').insertAdjacentHTML('beforeend',option(selectedCustomer.id,selectedCustomer.name));
      $('customer').value=selectedCustomer?.id || '';
      if(!people.length)status('Müşteri bulunamadı. Yeni müşteri kartı açabilirsiniz.');
    }catch(error){if(sequence===customerSequence)status(error.message);}
  });
}
$('customer').addEventListener('change',()=>void lookupCustomer($('customer').value));
$('customer-form').elements.unit.addEventListener('change',()=>{
  const other=$('customer-form').elements.unit.value==='other';
  const codeEl=$('customer-form').elements.currencyCode;
  $('other-unit-field').hidden=!other;codeEl.required=other;
  if(!other){codeEl.value='';codeEl.setCustomValidity('');}
});
$('customer-form').elements.currencyCode.addEventListener('input',()=>{
  const codeEl=$('customer-form').elements.currencyCode;
  codeEl.value=codeEl.value.toUpperCase();
  codeEl.setCustomValidity(/^[A-Z]{3}$/.test(codeEl.value) && !['TRY', 'HAS'].includes(codeEl.value) ? '' : 'Üç harfli döviz kodu yazın.');
});
$('customer-form').addEventListener('submit',event=>{
  event.preventDefault();
  if($('customer-form').elements.unit.value==='other'){
    const codeEl=$('customer-form').elements.currencyCode;
    const val=codeEl.value.trim().toUpperCase();
    codeEl.setCustomValidity(/^[A-Z]{3}$/.test(val) && !['TRY', 'HAS'].includes(val) ? '' : 'Üç harfli döviz kodu yazın.');
  }
  if(writing||pending||!snapshot||!$('customer-form').reportValidity())return;
  uiKit?.clearBanner?.($('customer-drawer-notice'));
  const fields=Object.fromEntries(new FormData($('customer-form')));
  const c={type:'account',date:snapshot.date,name:fields.name.trim(),unit:fields.unit==='other'?fields.currencyCode.toUpperCase():fields.unit,partyType:'customer',opening:'0'};
  for(const key of ['phone','taxId','address'])if(fields[key].trim())c[key]=fields[key].trim();
  saveDraft();queue({id:crypto.randomUUID(),revision:snapshot.revision,command:c},'customer');
});
$('operation').addEventListener('change',()=>{saveDraft();++customerSequence;customerLoading=false;operation=$('operation').value;review=null;$('review').hidden=true;restoreDraft(readStoredDraft(workspace, operation));status('');});
$('workspace').addEventListener('change',()=>{saveDraft();workspace=$('workspace').value;++customerSequence;customerLoading=false;selectedCustomer=null;externalRevision=0;snapshot=null;review=null;$('review').hidden=true;customerCombobox?.clear?.({emitChange:false});$('search').value='';void refresh();});
$('refresh').addEventListener('click',()=>void refresh());
$('retry').addEventListener('click',()=>void sendPending());
$('accept-snapshot').addEventListener('click',()=>{if(snapshot){draftRevision=snapshot.revision;draftDate=snapshot.date;changed();}});
$('clear-draft').addEventListener('click',()=>{++customerSequence;customerLoading=false;review=null;$('review').hidden=true;clearStoredDraft(workspace, operation);restoreDraft(null);status('Taslak temizlendi.');});
$('stock-search').addEventListener('input',()=>{stockPage=0;stockTable();});
$('stock-prev').addEventListener('click',()=>{stockPage--;stockTable();});
$('stock-next').addEventListener('click',()=>{stockPage++;stockTable();});
if(broadcast)broadcast.onmessage=event=>{
  const message=event.data;
  if(message?.actorId===actorId()&&message.workspace===workspace&&Number.isSafeInteger(message.revision)&&message.revision>(snapshot?.revision || 0)) {
    externalRevision=message.revision;review=null;$('review').hidden=true;controls();status('Başka sekmede kayıt değişti. Mevcutları yenileyin.');
  }
};
function hasUnsavedCheckoutWork() {
  if (pending || writing || draftDirty) return true;
  const store = getDraftStore();
  if (typeof store.listDrafts === 'function') {
    if (store.listDrafts({ actorId: actorId(), scope: 'checkout' }).length > 0) return true;
  }
  for (const ws of ['demo', 'dukkan']) {
    if (readStoredPending(ws)) return true;
    for (const op of ['sale', 'purchase']) {
      if (readStoredDraft(ws, op)) return true;
    }
  }
  return false;
}
window.addEventListener('beforeunload', event => {
  if (!current()) return;
  saveDraft();
  if (hasUnsavedCheckoutWork()) {
    event.preventDefault();
    event.returnValue = '';
  }
});
window.addEventListener('popstate', () => {
  if (window.DefterUI?.getLayerCount?.() > 0) window.DefterUI.closeTopLayer('popstate');
});
window.addEventListener('pagehide', () => {
  if (current()) saveDraft();
  else draftDirty = false;
  broadcast?.close();
});
let checkoutPaletteInitialized=false;
function initCheckoutCommandPalette(){
  if(!paletteLib||checkoutPaletteInitialized)return;
  checkoutPaletteInitialized=true;
  paletteLib.configure({
    title:'Tezgâh Komut Paleti',
    placeholder:'Tezgâh komutu veya müşteri ara…',
    groupOrder:['actions','navigation','records','commands'],
    maxResults:24,
    maxPerGroup:8,
    debounceMs:150,
    isBlocked:()=>{
      if(writing||pending||review)return{blocked:true,reason:pending?'Önce sonucu belirsiz son isteği doğrulayın.':'İşlem devam ederken komut paleti açılamaz.'};
      if(!snapshot)return{blocked:true,reason:'Tezgâh mevcutları henüz yüklenmedi.'};
      return false;
    },
    onBlocked:reason=>status(reason)
  });

  paletteLib.registerProvider({
    id:'checkout-actions',
    group:'actions',
    groupLabel:'Tezgâh Araçları',
    priority:10,
    getItems:()=>[
      {
        id:'checkout-op-sale',
        group:'navigation',
        groupLabel:'İşlem Türü',
        title:'Müşteriye satış moduna geç',
        keywords:'satis musteriye satis mod',
        badge:operation==='sale'?'Aktif':'',
        when:()=>Boolean(snapshot?.initialized),
        action:()=>{
          if(writing||pending||review||!snapshot?.initialized)return;
          $('operation').value='sale';
          $('operation').dispatchEvent(new Event('change',{bubbles:true}));
        }
      },
      {
        id:'checkout-op-purchase',
        group:'navigation',
        groupLabel:'İşlem Türü',
        title:'Müşteriden alış moduna geç',
        keywords:'alis musteriden alis hurda mod',
        badge:operation==='purchase'?'Aktif':'',
        when:()=>Boolean(snapshot?.initialized),
        action:()=>{
          if(writing||pending||review||!snapshot?.initialized)return;
          $('operation').value='purchase';
          $('operation').dispatchEvent(new Event('change',{bubbles:true}));
        }
      },
      {
        id:'checkout-focus-customer',
        title:'Müşteri ara ve seç',
        keywords:'musteri ara telefon tc kod',
        when:()=>Boolean(snapshot?.initialized),
        action:()=>{$('search')?.focus();}
      },
      {
        id:'checkout-focus-product',
        title:'Ürün ara',
        keywords:'urun ara stok kod barkod',
        when:()=>Boolean(snapshot?.initialized),
        action:()=>{
          let target=$('items')?.querySelector('[data-product-search]');
          if(!target){
            const row=addItem();
            changed({preferredStep:1});
            target=row?.querySelector('[data-product-search]');
          }
          target?.focus();
        }
      },
      {
        id:'checkout-open-customer-drawer',
        title:'Yeni müşteri kartı aç',
        keywords:'yeni musteri kart ekle olustur',
        when:()=>Boolean(snapshot?.initialized),
        action:()=>{
          const openBtn=$('open-customer-drawer');
          if(openBtn&&!openBtn.hidden){
            openBtn.click();
          }else{
            const details=$('new-customer');
            if(details){details.hidden=false;details.open=true;}
            $('customer-form')?.elements?.name?.focus();
          }
        }
      },
      {
        id:'checkout-toggle-stock-panel',
        title:'Stokları incele panelini aç/kapat',
        keywords:'stok incele mevcut liste',
        when:()=>Boolean(snapshot?.initialized),
        action:()=>{
          const panel=$('stock-panel');
          if(!panel)return;
          panel.open=!panel.open;
          if(panel.open)$('stock-search')?.focus();
        }
      },
      {
        id:'checkout-mode-quick',
        group:'commands',
        groupLabel:'Görünüm ve Araçlar',
        title:'Hızlı Moda geç',
        keywords:'hizli mod tek ekran',
        badge:flowMode==='quick'?'Aktif':'',
        when:()=>Boolean(snapshot?.initialized)&&!isComplexCheckoutState(),
        action:()=>{document.querySelector('[data-flow-mode="quick"]')?.click();}
      },
      {
        id:'checkout-mode-guided',
        group:'commands',
        groupLabel:'Görünüm ve Araçlar',
        title:'Rehberli Adımlara geç',
        keywords:'rehberli adimlar',
        badge:flowMode==='guided'?'Aktif':'',
        when:()=>Boolean(snapshot?.initialized),
        action:()=>{document.querySelector('[data-flow-mode="guided"]')?.click();}
      },
      {
        id:'checkout-refresh',
        group:'commands',
        groupLabel:'Görünüm ve Araçlar',
        title:'Mevcutları yenile',
        keywords:'yenile guncelle tazele',
        action:()=>{void refresh();}
      }
    ]
  });

  paletteLib.registerProvider({
    id:'checkout-customers',
    group:'records',
    groupLabel:'Müşteriler',
    priority:20,
    minQueryLength:2,
    when:()=>Boolean(snapshot?.initialized),
    search:async(query,{signal,limit})=>{
      if(!snapshot?.initialized)return{items:[],total:0};
      const q=String(query||'').trim();
      if(q.length<2)return{items:[],total:0};
      const url=route('customers',workspace)+'&q='+encodeURIComponent(q)+'&limit='+encodeURIComponent(limit||20)+'&meta=1';
      const data=await apiWithSignal(url,signal);
      const rawItems=Array.isArray(data)?data:(data?.items||[]);
      const total=Array.isArray(data)?data.length:(Number.isFinite(Number(data?.total))?Number(data.total):rawItems.length);
      return {
        items:rawItems.map(p=>({
          id:'customer:'+p.id,
          title:p.name,
          subtitle:p.disambiguationLabel||[p.unit,p.phone,p.taxId?`TC/VKN ${p.taxId}`:''].filter(Boolean).join(' · '),
          badge:p.unit||'',
          keywords:[p.id,p.phone,p.taxId].filter(Boolean),
          action:()=>{void lookupCustomer(p.id);}
        })),
        total
      };
    }
  });
}
initCheckoutCommandPalette();
if(current())void refresh();
