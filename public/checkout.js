const $ = id => document.getElementById(id);
const { api, current } = window.DefterSession;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const normalize = value => String(value || '').toLocaleLowerCase('tr').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/ı/g,'i');
const scale = unit => unit === 'ADET' ? 1 : ['GRAM','HAS','SILVER'].includes(unit) ? 1000 : 100;
const format = (value, unit='TL') => (value/scale(unit)).toLocaleString('tr-TR',{minimumFractionDigits:unit==='ADET'?0:unit==='GRAM'?3:2,maximumFractionDigits:scale(unit)===1000?3:2})+' '+({ADET:'adet',GRAM:'gr',HAS:'has gr',SILVER:'saf gümüş gr'}[unit] || unit);
const decimal = value => String(value || '').trim().replace(',','.');
const option = (id,name) => '<option value="'+esc(id)+'">'+esc(name)+'</option>';
const numeric = (field,label,required=true) => '<label>'+label+'<input '+field+' inputmode="decimal" maxlength="24"'+(required?' required':'')+'></label>';
const groups = ['received','given','credits','debts'];
const groupNames = {received:'İşletmeye alınan',given:'İşletmeden verilen',credits:'Cari alacağımız artar / borcumuz azalır',debts:'Müşteriye borcumuz artar / alacağımız azalır'};
let snapshot, pending, review, selectedCustomer = null, writing = false, rendering = false, customerLoading = false;
let workspace = $('workspace').value, operation = $('operation').value;
let loadSequence = 0, customerSequence = 0, draftRevision, draftDate, externalRevision = 0, stockPage = 0;
const actorId = () => current()?.actor.id || '';
const route = (path, selected=workspace) => '/api/'+path+'?workspace='+encodeURIComponent(selected);
const pendingKey = (selected=workspace) => 'defter-sale-retry-'+actorId()+'-'+selected;
const draftKey = (selected=workspace, kind=operation) => 'defter-pending-checkout-draft-'+actorId()+'-'+selected+'-'+kind;
const readStored = key => { try {return JSON.parse(sessionStorage.getItem(key) || 'null');} catch {return null;} };
const broadcast = typeof BroadcastChannel === 'function' ? new BroadcastChannel('defter-checkout-revisions') : null;
const status = message => { $('status').textContent = message; };
const isStale = () => snapshot && (draftRevision !== snapshot.revision || draftDate !== snapshot.date || externalRevision > snapshot.revision);
function parse(input,unit='TL',signed=false,optional=false,allowZero=false) {
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
function controls() {
  const blocked=writing || !!pending || !!review || !snapshot;
  $('trade-controls').disabled=blocked;
  for (const el of $('customer-form').elements) el.disabled=blocked;
  for (const id of ['search','customer','operation','clear-draft','add-item']) $(id).disabled=blocked;
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
function pricing(row) {
  const result={};
  const quoted=row.querySelector('[data-quoted]'),source=row.querySelector('[data-source]');
  if (quoted.value.trim()) result.quotedTL=decimal(quoted.value);
  if (source.value.trim()) result.source=source.value.trim();
  const components=[...row.querySelector('[data-components]').children].map(part=>({label:part.querySelector('[data-component-name]').value.trim(),amountTL:decimal(part.querySelector('[data-component-value]').value)}));
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
  if(clear) for(const key of ['quantity','weight','value','quoted','source']) row.querySelector('[data-'+key+']').value='';
  if(clear) row.querySelector('[data-components]').replaceChildren();
  if(serial) {
    row.querySelector('[data-quantity]').value='1';
    select.value=serial.weightAccount || '';
    row.querySelector('[data-weight]').value=serial.actualWeight?(serial.actualWeight/1000).toFixed(3):'';
  }
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
  row.querySelector('[data-product-search]').value=data.search || '';
  listProducts(row,data.selection);
  for(const key of ['quantity','value','weight']) row.querySelector('[data-'+key+']').value=data[key] ?? row.querySelector('[data-'+key+']').value;
  if(data.weightAccount) row.querySelector('[data-pool]').value=data.weightAccount;
  row.querySelector('[data-quoted]').value=data.pricing?.quotedTL || '';
  row.querySelector('[data-source]').value=data.pricing?.source || '';
  for(const part of data.pricing?.components || []) priceFields(row,part);
  row.querySelector('[data-add-component]').addEventListener('click',()=>{if(row.querySelector('[data-components]').children.length<12){priceFields(row);changed();}});
  row.querySelector('[data-product-search]').addEventListener('input',()=>{listProducts(row);changed();});
  row.querySelector('[data-product-search]').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();(itemProduct(row).serial?row.querySelector('[data-value]'):row.querySelector('[data-quantity]')).focus();}});
  row.querySelector('[data-product]').addEventListener('change',()=>{configureItem(row,true);changed();});
  row.querySelector('[data-remove]').addEventListener('click',()=>{row.remove();renumber();changed();});
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
  select.innerHTML='<option value="">Hesap seçin</option>'+accounts.map(a=>option(a.id,a.name+' · '+a.unit)).join('');
  if(previous) {
    if(!accounts.some(a=>a.id===previous)) select.insertAdjacentHTML('beforeend',option(previous,previous+' · yeniden seçin'));
    select.value=previous;
  } else if(cari && accounts.length===1) select.value=accounts[0].id;
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
  row.innerHTML='<label>'+label+'<select data-account required></select></label><div class="access-columns">'+numeric('data-quantity','<span data-quantity-label>Miktar</span>')+'<div data-reference>'+numeric('data-value','Anlaşılmış TL karşılığı')+'</div></div><div data-weight-fields class="access-columns" hidden><label>Ayar hesabı<select data-pool></select></label>'+numeric('data-weight','Gerçek gram',false)+'</div><button type="button" data-remove class="button text">Karşılığı kaldır</button>';
  $(kind).append(row);allocationOptions(row,data.accountId);
  for(const key of ['quantity','weight'])row.querySelector('[data-'+key+']').value=data[key] || '';
  row.querySelector('[data-value]').value=data.valueTL || '';
  if(data.weightAccount)row.querySelector('[data-pool]').value=data.weightAccount;
  configureAllocation(row);
  row.querySelector('[data-account]').addEventListener('change',()=>{for(const key of ['quantity','value','weight'])row.querySelector('[data-'+key+']').value='';configureAllocation(row);changed();});
  row.querySelector('[data-quantity]').addEventListener('input',()=>configureAllocation(row));
  row.querySelector('[data-remove]').addEventListener('click',()=>{row.remove();changed();});
  return row;
}
function draft() {
  return {revision:draftRevision,date:draftDate,customer:selectedCustomer,note:$('note').value,
    items:[...$('items').children].map(row=>({selection:row.querySelector('[data-product]').value,search:row.querySelector('[data-product-search]').value,quantity:row.querySelector('[data-quantity]').value,value:row.querySelector('[data-value]').value,weight:row.querySelector('[data-weight]').value,weightAccount:row.querySelector('[data-pool]').value,pricing:pricing(row)})),
    ...Object.fromEntries(groups.map(kind=>[kind,[...$(kind).children].map(row=>({category:row.dataset.category,accountId:row.querySelector('[data-account]').value,quantity:row.querySelector('[data-quantity]').value,valueTL:row.querySelector('[data-value]').value,weight:row.querySelector('[data-weight]').value,weightAccount:row.querySelector('[data-pool]').value}))]))};
}
function saveDraft() {if(snapshot&&!rendering)sessionStorage.setItem(draftKey(),JSON.stringify(draft()));}
function changed(event) {
  if(rendering)return;
  event?.target?.setCustomValidity?.('');
  review=null;$('review').hidden=true;
  totals();saveDraft();controls();
}
function selectedPerson(person) {
  selectedCustomer=person;
  $('customer').innerHTML=option('','Müşteri seçilmedi')+(person?option(person.id,person.name+' · '+person.accounts[0].unit):'');
  $('customer').value=person?.id || '';
  $('customer-balance').textContent=person?person.accounts.map(a=>a.name+' · '+(a.balance<0?'Borcumuz ':a.balance>0?'Alacağımız ':'Bakiye ')+format(Math.abs(a.balance),a.unit)).join(' / '):'';
  for(const kind of ['credits','debts'])for(const row of $(kind).children)allocationOptions(row);
}
function restoreDraft(saved) {
  rendering=true;
  for(const id of ['items',...groups])$(id).replaceChildren();
  selectedPerson(saved?.customer || null);
  draftRevision=saved?.revision ?? snapshot.revision;draftDate=saved?.date ?? snapshot.date;
  for(const item of saved?.items || [{}])addItem(item);
  for(const kind of groups)for(const row of saved?.[kind] || [])addAllocation(kind,row);
  $('note').value=saved?.note || '';
  $('items-title').textContent=operation==='sale'?'Satılan ürünler':'Alınan ürünler';
  $('total-label').textContent=operation==='sale'?'Satış bedeli':'Alış bedeli';
  rendering=false;totals();controls();
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
  return {total,difference,incomplete};
}
function validateRow(row,product,primary) {
  const select=row.querySelector(primary?'[data-product]':'[data-account]');
  select.setCustomValidity(product?'':'Geçerli hesap veya ürün seçin.');
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
    if(serials.has(serial?.code))row.querySelector('[data-product]').setCustomValidity('Tekil ürün bu işlemde bir kez seçilebilir.');
    if(serial)serials.add(serial.code);
    const item={accountId:product.id,quantity:decimal(row.querySelector('[data-quantity]').value),value:decimal(row.querySelector('[data-value]').value)};
    if(serial)item.inventoryCode=serial.code;
    if(product.weights.length)Object.assign(item,{weightAccount:row.querySelector('[data-pool]').value,weight:decimal(row.querySelector('[data-weight]').value)});
    items.push(item);
    const price=pricing(row);prices.push(price);
    if(operation==='sale'&&price) {
      parse(row.querySelector('[data-quoted]'),'TL',false,true,true);
      for(const part of row.querySelector('[data-components]').children) {part.querySelector('[data-component-name]').required=true;parse(part.querySelector('[data-component-value]'),'TL',true);}
    }
  }
  const result={type:operation,date:snapshot.date,counterpartyType:'customer',counterpartyId:selectedCustomer?.id || '',items};
  if(operation==='purchase')result.source='customer';
  if(operation==='sale'&&prices.some(Boolean))result.salePricing={version:1,lines:prices};
  for(const kind of groups)result[kind]=[...$(kind).children].map(row=>{
    const account=allocationAccount(row);validateRow(row,account,false);
    const allocation={accountId:row.querySelector('[data-account]').value,quantity:decimal(row.querySelector('[data-quantity]').value),valueTL:decimal(row.querySelector('[data-value]').value)};
    if(['credits','debts'].includes(kind)&&!selectedCustomer?.accounts.some(a=>a.id===allocation.accountId))row.querySelector('[data-account]').setCustomValidity('Seçilen müşterinin hesabını kullanın.');
    if(account?.weights?.length)Object.assign(allocation,{weightAccount:row.querySelector('[data-pool]').value,weight:decimal(row.querySelector('[data-weight]').value)});
    return allocation;
  });
  if($('note').value.trim())result.note=$('note').value.trim();
  return result;
}
function renderReview(c) {
  status('');
  const names=new Map([...(snapshot.products || []),...snapshot.payments,...(selectedCustomer?.accounts || [])].map(a=>[a.id,a]));
  const lines=[...c.items.map(row=>({label:operation==='sale'?'Satılan':'Alınan ürün',row,reference:row.value})),...groups.flatMap(kind=>c[kind].map(row=>({label:groupNames[kind],row,reference:row.valueTL})))];
  $('review-content').innerHTML='<p>'+esc((operation==='sale'?'Satış':'Alış')+' · '+snapshot.date+' · '+(selectedCustomer?.name || 'Müşteri seçilmedi'))+'</p><div class="table-wrap"><table><thead><tr><th>İşlem</th><th>Hesap / ürün</th><th>Miktar</th><th>TL bedeli</th></tr></thead><tbody>'+lines.map(({label,row,reference})=>'<tr><td data-review-label="İşlem">'+esc(label)+'</td><td data-review-label="Ürün / hesap">'+esc(names.get(row.accountId)?.name || row.accountId)+(row.inventoryCode?' · '+esc(row.inventoryCode):'')+'</td><td data-review-label="Miktar">'+esc(row.quantity+' '+({ADET:'adet',GRAM:'gr'}[names.get(row.accountId)?.unit] || names.get(row.accountId)?.unit || ''))+(row.weight?' · '+esc(row.weight+' gr'):'')+'</td><td data-review-label="TL bedeli">'+esc(reference+' TL')+'</td></tr>').join('')+'</tbody></table></div>';
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
  pending=readStored(pendingKey());
  if(pending?.command && !pending.envelope) pending={envelope:pending,kind:'trade',operation:pending.command.type,workspace};
  snapshot=null;controls();$('trade').hidden=true;status('Mevcutlar yükleniyor…');
  try {
    const fresh=await api(route('checkout',selected));
    if(sequence!==loadSequence || selected!==workspace)return;
    snapshot=fresh;externalRevision=Math.max(externalRevision,fresh.revision);
    $('date').textContent=fresh.initialized?'Açık iş günü · '+fresh.date:'Bu defterin açılışını işletme sahibi yapmalı.';
    restoreDraft(readStored(draftKey()));stockTable();$('trade').hidden=!fresh.initialized;
    if(selectedCustomer && !pending) await lookupCustomer(selectedCustomer.id);
    if(sequence!==loadSequence || selected!==workspace)return;
    status('');
  }catch(error){if(sequence===loadSequence)status(error.message);}
  controls();
}
async function lookupCustomer(id) {
  const sequence=++customerSequence,selected=workspace;
  if(!id){selectedPerson(null);changed();return;}
  customerLoading=true;selectedPerson(null);changed();status('Müşteri hesabı yükleniyor…');
  try {
    const person=await api(route('customers',selected)+'&id='+encodeURIComponent(id));
    if(sequence!==customerSequence || selected!==workspace)return;
    selectedPerson(person);changed();status('');
  }catch(error){if(sequence===customerSequence){selectedPerson(null);status(error.message);changed();}}
  finally {if(sequence===customerSequence){customerLoading=false;controls();}}
}
async function sendPending() {
  if(writing || !pending)return;
  const request=pending,selected=workspace,key=pendingKey(selected);
  writing=true;controls();
  let message;
  try {
    const result=await api(route('command',selected),request.envelope);
    sessionStorage.removeItem(key);pending=null;
    broadcast?.postMessage({actorId:actorId(),workspace:selected,revision:result.revision});
    message=(result.duplicate?'Önceki kayıt doğrulandı. ':'İşlem kaydedildi. ')+'Kayıt '+result.id;
    if(request.kind==='trade') {
      sessionStorage.removeItem(draftKey(selected,request.operation));
      $('search').value='';
      rendering=true;for(const id of ['items',...groups])$(id).replaceChildren();rendering=false;
      snapshot=null;
    } else {
      if(draftRevision===request.envelope.revision && draftDate===request.envelope.command.date) draftRevision=result.revision;
      saveDraft();
      $('customer-form').reset();$('new-customer').open=false;$('other-unit-field').hidden=true;
      $('customer-form').elements.currencyCode.required=false;
      request.createdCustomer=result.account;
    }
  }catch(error){
    if(error.status>=400&&error.status<500){sessionStorage.removeItem(key);pending=null;}
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
  sessionStorage.setItem(pendingKey(),JSON.stringify(pending));controls();
  void sendPending();
}
$('trade').addEventListener('submit',event=>{
  event.preventDefault();if(writing||pending||customerLoading||!snapshot||isStale())return;
  const totalsResult=totals(),c=command();
  if(!$('trade').reportValidity() || !c.items.length){status('Ürün ve karşılık satırlarını tamamlayın.');return;}
  if(totalsResult.incomplete||totalsResult.difference!==0){status('Ürün bedeli ile karşılıkların TL dengesini tamamlayın.');return;}
  saveDraft();review={id:crypto.randomUUID(),revision:snapshot.revision,command:c};renderReview(c);
});
$('confirm').addEventListener('click',()=>{if(review&&!isStale())queue(review,'trade');else{review=null;$('review').hidden=true;controls();}});
$('edit').addEventListener('click',()=>{review=null;$('review').hidden=true;controls();$('record').focus();});
$('trade').addEventListener('input',changed);
$('trade').addEventListener('change',changed);
$('add-item').addEventListener('click',()=>{const row=addItem();changed();row?.querySelector('input').focus();});
for(const button of document.querySelectorAll('[data-add]'))button.addEventListener('click',()=>{const row=addAllocation(button.dataset.add,{category:button.dataset.category});changed();row?.querySelector('select').focus();});
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
$('customer').addEventListener('change',()=>void lookupCustomer($('customer').value));
$('customer-form').elements.unit.addEventListener('change',()=>{
  const other=$('customer-form').elements.unit.value==='other';
  $('other-unit-field').hidden=!other;$('customer-form').elements.currencyCode.required=other;
});
$('customer-form').addEventListener('submit',event=>{
  event.preventDefault();if(writing||pending||!snapshot||!$('customer-form').reportValidity())return;
  const fields=Object.fromEntries(new FormData($('customer-form')));
  const c={type:'account',date:snapshot.date,name:fields.name.trim(),unit:fields.unit==='other'?fields.currencyCode.toUpperCase():fields.unit,partyType:'customer',opening:'0'};
  for(const key of ['phone','taxId','address'])if(fields[key].trim())c[key]=fields[key].trim();
  saveDraft();queue({id:crypto.randomUUID(),revision:snapshot.revision,command:c},'customer');
});
$('operation').addEventListener('change',()=>{saveDraft();++customerSequence;customerLoading=false;operation=$('operation').value;review=null;restoreDraft(readStored(draftKey()));status('');});
$('workspace').addEventListener('change',()=>{saveDraft();workspace=$('workspace').value;++customerSequence;customerLoading=false;selectedCustomer=null;externalRevision=0;snapshot=null;review=null;$('review').hidden=true;$('search').value='';void refresh();});
$('refresh').addEventListener('click',()=>void refresh());
$('retry').addEventListener('click',()=>void sendPending());
$('accept-snapshot').addEventListener('click',()=>{if(snapshot){draftRevision=snapshot.revision;draftDate=snapshot.date;changed();}});
$('clear-draft').addEventListener('click',()=>{++customerSequence;customerLoading=false;sessionStorage.removeItem(draftKey());restoreDraft(null);changed();status('Taslak temizlendi.');});
$('stock-search').addEventListener('input',()=>{stockPage=0;stockTable();});
$('stock-prev').addEventListener('click',()=>{stockPage--;stockTable();});
$('stock-next').addEventListener('click',()=>{stockPage++;stockTable();});
if(broadcast)broadcast.onmessage=event=>{
  const message=event.data;
  if(message?.actorId===actorId()&&message.workspace===workspace&&Number.isSafeInteger(message.revision)&&message.revision>(snapshot?.revision || 0)) {
    externalRevision=message.revision;review=null;$('review').hidden=true;controls();status('Başka sekmede kayıt değişti. Mevcutları yenileyin.');
  }
};
window.addEventListener('pagehide',()=>{saveDraft();broadcast?.close();});
if(current())void refresh();
