import { fail, financialUnit, quantity, text } from './domain.mjs';

const supplierTypes = new Set(['supplierFirm','supplierFirmUpdate','supplierUnit','supplierPurchase','supplierPayment','supplierAllocation','supplierOffset','supplierReturn','supplierReverse','supplierAmend','supplierLegacyReceiptLink']);
export function isSupplierCommand(command) {
  return supplierTypes.has(command?.type);
}

export function supplierFirms(state) {
  const firms = (state.supplierFirms || []).map(firm => ({...firm}));
  const legacy = state.accounts.filter(a => a.kind === 'receivable' && a.partyType === 'supplier' && !a.parentAccountId && !a.supplierId && !firms.some(f=>f.id===a.id));
  return firms.concat(legacy.map(({id,name,phone,taxId,address}) => ({id,name,phone:phone || '',taxId:taxId || '',address:address || '',legacy:true})));
}

export function resolveSupplierFirm(state, id) {
  return supplierFirms(state).find(firm => firm.id === id) || fail('Toptancı firma bulunamadı.');
}

export function supplierAccountIds(state, id) {
  const firm = resolveSupplierFirm(state,id);
  return state.accounts.filter(a => a.kind === 'receivable' && a.partyType === 'supplier' &&
    (a.supplierId === id || (firm.legacy && (a.id === id || a.parentAccountId === id)))).map(a => a.id);
}

function totals(state, ids, input) {
  const map = new Map();
  for (const row of input || []) {
    if (!ids.has(row.accountId) || !row.quantity) continue;
    const prior = map.get(row.accountId) || {accountId:row.accountId,unit:state.accounts.find(a=>a.id===row.accountId).unit,quantity:0};
    prior.quantity += row.quantity;
    if (!Number.isSafeInteger(prior.quantity)) fail('Belge toplamı miktar sınırını aşıyor.');
    map.set(row.accountId,prior);
  }
  return [...map.values()];
}

function collectionNativeNet(entry, ids) {
  const amounts=new Map();
  for(const row of entry.entries)if(ids.has(row.accountId))amounts.set(row.accountId,(amounts.get(row.accountId)||0)+row.delta);
  return [...amounts].map(([accountId,quantity])=>({accountId,quantity}));
}

function assertSourceResolved(source, accountId) {
  if(source.blockedAccounts?.includes(accountId))fail('Bu birimde eski tahsilatın ödeme kaynağı belirsiz. Önce eski tahsilatı açıkça eşleyin.');
}

// Read-only document capacities. They are not another balance ledger: allocations
// consume these documentary capacities but never write stock, cash or cari entries.
export function supplierDocuments(state, supplierId) {
  const ids = new Set(supplierAccountIds(state,supplierId));
  const reversed = new Set(state.journal.filter(e=>['reverse','supplierReverse'].includes(e.type)).map(e=>e.meta.originalId));
  const active = state.journal.filter(e=>!reversed.has(e.id));
  const purchases=[],sources=[],allocations=[];
  const display=e=>({... (typeof e.label==='string'&&e.label?{label:e.label.slice(0,120)}:{}),...(typeof e.meta?.note==='string'&&e.meta.note?{note:e.meta.note.slice(0,300)}:{})});
  for (const e of active) {
    const own=e.meta.supplierId===supplierId;
    const legacyPurchase=e.type==='purchase' && e.meta.source==='supplier' && e.entries.some(r=>ids.has(r.accountId));
    if ((own && (['supplierPurchase','supplierReturn'].includes(e.type)||e.type==='supplierPayment'&&e.meta.receiptChargeLines?.length)) || legacyPurchase) {
      const chargeRows=own ? [...(e.meta.chargeLines||[]),...(e.meta.receiptChargeLines||[])] : e.meta.debtLines?.length ? e.meta.debtLines : e.entries.filter(r=>ids.has(r.accountId)&&r.delta<0).map(r=>({accountId:r.accountId,quantity:-r.delta}));
      purchases.push({id:e.id,date:e.date,...display(e),legacy:!own,kind:e.type,...(e.meta.originalId&&{originalId:e.meta.originalId}),...(e.meta.agreementId&&{agreementId:e.meta.agreementId}),lines:(e.meta.lines||[]).map((r,lineIndex)=>({...structuredClone(r),lineIndex,remainingQuantity:r.quantity,remainingWeight:r.weight||0})),
        charges:totals(state,ids,chargeRows).map(r=>({...r,allocated:0,reduced:0,remaining:r.quantity}))});
    }
    const eligible=own && ['supplierPurchase','supplierPayment','supplierReturn','supplierOffset'].includes(e.type) || legacyPurchase || ['collection','account','sale'].includes(e.type);
    const creditRows=own && e.type==='supplierOffset' ? [e.meta.to] : own && e.type==='supplierReturn' ? e.meta.availableCreditLines : own || legacyPurchase ? e.meta.creditLines : e.type==='collection' ? collectionNativeNet(e,ids).filter(r=>r.quantity>0) : e.entries.filter(r=>ids.has(r.accountId)&&r.delta>0).map(r=>({accountId:r.accountId,quantity:r.delta}));
    const credits=eligible ? totals(state,ids,creditRows) : [];
    if(credits.length)sources.push({id:e.id,date:e.date,...display(e),legacy:!own,kind:e.type,...(e.meta.agreementId&&{agreementId:e.meta.agreementId}),advanceScope:e.meta.advanceScope||'general',credits:credits.map(r=>({...r,allocated:0,consumed:0,remaining:r.quantity}))});
    if(own)for(const row of e.meta.allocations||[])allocations.push({eventId:e.id,...row});
  }
  for(const e of active.filter(e=>e.meta.supplierId===supplierId))for(const row of [...(e.meta.sourceUses||[]),...(e.meta.debtUses||[]),...(e.type==='supplierLegacyReceiptLink'?e.meta.uses:[])]) {
    const source=sources.find(s=>s.id===row.sourceId)?.credits.find(r=>r.accountId===row.accountId);
    if(!source)fail('Mahsup alacak kaynağı bulunamadı.');
    source.consumed+=row.quantity;source.remaining-=row.quantity;
    if(source.remaining<0)fail('Mahsup alacak kaynağının kalanını aşıyor.');
  }
  for(const row of allocations) {
    const source=sources.find(s=>s.id===row.sourceId)?.credits.find(r=>r.accountId===row.accountId);
    const purchase=purchases.find(p=>p.id===row.purchaseId)?.charges.find(r=>r.accountId===row.accountId);
    if(!source||!purchase)fail('Tahsis belgesinin kaynağı veya alış bağlantısı bulunamadı.');
    source.allocated+=row.quantity;source.remaining-=row.quantity;
    purchase.allocated+=row.quantity;purchase.remaining-=row.quantity;
    if(source.remaining<0||purchase.remaining<0)fail('Tahsis belge kapasitesini aşıyor.');
  }
  for(const e of active.filter(e=>e.type==='supplierReturn'&&e.meta.supplierId===supplierId)) {
    const original=purchases.find(p=>p.id===e.meta.originalId);
    for(const row of e.meta.lines) {
      const line=original?.lines[row.lineIndex];
      if(!line)fail('İadenin ürün belgesi bulunamadı.');
      line.remainingQuantity-=row.quantity;line.remainingWeight-=row.weight||0;
      if(line.remainingQuantity<0||line.remainingWeight<0)fail('İade alış satırının kalanını aşıyor.');
    }
    for(const row of e.meta.reductions) {
    const charge=purchases.find(p=>p.id===e.meta.originalId)?.charges.find(r=>r.accountId===row.accountId);
    if(!charge)fail('İadenin borç belgesi bulunamadı.');
    charge.reduced+=row.quantity;charge.remaining-=row.quantity;
    if(charge.remaining<0)fail('İade belgenin kalan açık miktarını aşıyor.');
    }
  }
  const linkedReceipts=new Set(active.filter(e=>e.type==='supplierLegacyReceiptLink'&&e.meta.supplierId===supplierId).map(e=>e.meta.originalId));
  const order=new Map(state.journal.map((e,index)=>[e.id,index]));
  const unresolvedReceipts=active.filter(e=>e.type==='collection'&&!linkedReceipts.has(e.id)).flatMap(e=>{
    const debts=totals(state,ids,collectionNativeNet(e,ids).filter(r=>r.quantity<0).map(r=>({...r,quantity:-r.quantity})));
    if(!debts.length)return [];
    const receiptAccounts=new Set(debts.map(r=>r.accountId));
    const choices=sources.filter(s=>s.legacy&&order.get(s.id)<order.get(e.id)&&s.date<=e.date).map(s=>({id:s.id,date:s.date,kind:s.kind,...(s.label&&{label:s.label}),...(s.note&&{note:s.note}),credits:s.credits.filter(r=>receiptAccounts.has(r.accountId)&&r.remaining>0).map(({accountId,unit,remaining})=>({accountId,unit,remaining}))})).filter(s=>s.credits.length);
    return [{id:e.id,date:e.date,kind:e.type,...display(e),debts,sources:choices}];
  });
  const blockedUnits=new Set(unresolvedReceipts.flatMap(r=>r.debts.map(d=>d.unit)));
  for(const source of sources)source.blockedAccounts=source.legacy?source.credits.filter(r=>blockedUnits.has(r.unit)).map(r=>r.accountId):[];
  return {purchases,sources,allocations,unresolvedReceipts};
}

function allocationLines(state,event,input,embedded=false) {
  const docs=supplierDocuments(state,event.command.supplierId),lines=[];
  for(const row of rows(input)) {
    fields(row,['sourceId','purchaseId','accountId','quantity','overrideReserved','reason']);
    const sourceId=embedded && row.sourceId===undefined ? event.id : text(row.sourceId,'Ödeme kaynağı',160);
    const purchaseId=embedded && row.purchaseId===undefined ? event.id : text(row.purchaseId,'Alış belgesi',160);
    const source=docs.sources.find(s=>s.id===sourceId),purchase=docs.purchases.find(p=>p.id===purchaseId);
    const credit=source?.credits.find(r=>r.accountId===row.accountId),charge=purchase?.charges.find(r=>r.accountId===row.accountId);
    if(!credit||!charge)fail('Tahsis aynı firma ve aynı birim hesabındaki kaynak ile alışa bağlanmalı.');
    assertSourceResolved(source,row.accountId);
    const amount=quantity(row.quantity,credit.unit,{zero:false});
    if(amount>credit.remaining||amount>charge.remaining)fail('Tahsis kaynak veya alışın kalan miktarını aşamaz.');
    if(row.overrideReserved!==undefined && typeof row.overrideReserved!=='boolean')fail('Ayrılmış avans kullanım onayı geçersiz.');
    const override=source.advanceScope==='reserved'&&source.agreementId!==purchase.agreementId;
    if(override&&row.overrideReserved!==true)fail('Ayrılmış avansın başka anlaşmada kullanımını açıkça onaylayın.');
    const reason=row.reason===undefined ? '' : text(row.reason,'Tahsis kullanım gerekçesi');
    if((override||row.overrideReserved)&&!reason)fail('Ayrılmış avans kullanım gerekçesi gerekli.');
    credit.remaining-=amount;charge.remaining-=amount;
    lines.push({sourceId,purchaseId,accountId:credit.accountId,quantity:amount,...(row.overrideReserved&&{overrideReserved:true}),...(reason&&{reason})});
  }
  return lines;
}

export function assertSupplierUndoAllowed(state, originalId) {
  const reversed=new Set(state.journal.filter(e=>['reverse','supplierReverse'].includes(e.type)).map(e=>e.meta.originalId));
  if(state.journal.some(e=>e.id!==originalId&&!reversed.has(e.id)&&(e.meta.allocations?.some(r=>r.sourceId===originalId||r.purchaseId===originalId)||e.meta.sourceUses?.some(r=>r.sourceId===originalId)||e.meta.debtUses?.some(r=>r.sourceId===originalId)||(e.type==='supplierLegacyReceiptLink'&&(e.meta.originalId===originalId||e.meta.uses.some(r=>r.sourceId===originalId)))||(e.type==='supplierReturn'&&e.meta.originalId===originalId)))) {
    fail('Bu belgeye bağlı etkin ödeme tahsisi var. Önce bağlı tahsisi geri alın.');
  }
  const original=state.journal.find(e=>e.id===originalId);
  if(original?.type==='supplierLegacyReceiptLink') {
    const sources=new Set(original.meta.uses.map(r=>r.sourceId));
    if(state.journal.some(e=>e.id!==originalId&&!reversed.has(e.id)&&[...(e.meta.allocations||[]),...(e.meta.sourceUses||[]),...(e.meta.debtUses||[])].some(r=>sources.has(r.sourceId))))fail('Eşlenen eski kaynak sonradan kullanılmış. Önce bağlı kullanımları geri alın.');
  }
  const targets=new Set((original?.meta.allocations||[]).map(r=>r.purchaseId));
  if(state.journal.some(e=>e.type==='supplierReturn'&&!reversed.has(e.id)&&targets.has(e.meta.originalId)))fail('Bu tahsisin alışına bağlı iade var. Önce iadeyi geri alın.');
}

function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    fail('Toptancı işleminin alanları geçersiz.');
  }
}

function rows(value = []) {
  if (!Array.isArray(value) || value.length > 30) fail('En çok 30 hareket satırı girin.');
  return value;
}

function reference(row) {
  return row.referenceTL === undefined ? {} : {referenceTL:quantity(row.referenceTL,'TL')};
}

function nativeLines(state, supplierId, input, sign) {
  const allowed = new Set(supplierAccountIds(state,supplierId)), entries = [], lines = [];
  for (const row of rows(input)) {
    fields(row,['accountId','quantity','referenceTL']);
    const a = state.accounts.find(a => a.id === row.accountId);
    if (!allowed.has(row.accountId) || !a || a.retired) fail('Cari satırı seçili firmanın etkin birim hesabına ait olmalı.');
    const amount = quantity(row.quantity,a.unit,{zero:false});
    entries.push({accountId:a.id,delta:sign*amount});
    lines.push({accountId:a.id,unit:a.unit,quantity:amount,...reference(row)});
  }
  return {entries,lines};
}

function productLines(state, input, sign, helpers) {
  for (const row of rows(input)) fields(row,['accountId','quantity','weightAccount','weight','referenceTL']);
  const result = helpers.stockLines(state,input,sign,false,17,true);
  return {entries:result.entries,lines:result.lines.map(({value,...line},index) => ({...line,...reference(input[index])}))};
}

function assetLines(state, input, sign, helpers) {
  const entries = [], lines = [];
  for (const row of rows(input)) {
    fields(row,['accountId','quantity','weightAccount','weight','referenceTL']);
    const a = state.accounts.find(a => a.id === row.accountId);
    if (!a || a.kind !== 'asset') fail('Gerçek karşılık için kasa, banka veya ürün hesabı seçin.');
    if (a.physical && ['GRAM','ADET'].includes(a.unit)) {
      const result = productLines(state,[row],sign,helpers);
      entries.push(...result.entries);
      lines.push({...result.lines[0],unit:a.unit,kind:'stock'});
    } else {
      helpers.moneyAccount(state,a.id,sign > 0);
      if (row.weightAccount || (row.weight !== undefined && row.weight !== '')) fail('Ödeme hesabında ürün gramı girilmez.');
      const amount = quantity(row.quantity,a.unit,{zero:false});
      entries.push({accountId:a.id,delta:sign*amount});
      lines.push({accountId:a.id,unit:a.unit,quantity:amount,kind:'money',...reference(row)});
    }
  }
  return {entries,lines};
}

// Produces entries and metadata for the existing applyEvent/entriesApply path.
// Each native amount is an explicit agreement, independent of actual stock grams.
export function prepareSupplier(state, event, helpers) {
  const c = event.command;
  const common = ['type','date'];
  if(c.type==='supplierReverse') {
    fields(c,[...common,'originalId','note']);
    const original=state.journal.find(e=>e.id===c.originalId);
    if(!original||!['supplierPurchase','supplierPayment','supplierAllocation','supplierOffset','supplierReturn','supplierLegacyReceiptLink'].includes(original.type))fail('Bu toptancı kaydı ters çevrilemez.');
    if(state.journal.some(e=>['reverse','supplierReverse'].includes(e.type)&&e.meta.originalId===original.id))fail('İşlem zaten ters çevrilmiş.');
    assertSupplierUndoAllowed(state,original.id);
    if((state.inventoryItems||[]).some(item=>item.costSource?.id===original.id||(item.purchaseLine?.id===original.id&&item.status!=='released')))fail('Bu alış tekil ürün kartına bağlı. Önce ürün eşlemesini kontrol edin.');
    return {entries:original.entries.map(r=>({...r,delta:-r.delta})),meta:{supplierId:original.meta.supplierId,originalId:original.id,note:text(c.note,'Ters kayıt gerekçesi')},label:'Toptancı bağlı ters kayıt'};
  }
  if (c.type === 'supplierFirm' || c.type === 'supplierFirmUpdate') {
    fields(c,[...common,'name','phone','taxId','address',...(c.type === 'supplierFirmUpdate' ? ['supplierId'] : [])]);
    const prior = c.type === 'supplierFirmUpdate' ? resolveSupplierFirm(state,c.supplierId) : null;
    const name = text(c.name,'Firma adı',70);
    const {phone,taxId,address} = helpers.partyProfile({...c,partyType:'supplier'},prior || {});
    const firm = {id:prior?.id || 'supplier-'+event.id,name,phone,taxId,address,...(prior?.legacy&&{legacy:true})};
    const firms = [...(state.supplierFirms || []).filter(f=>f.id!==firm.id),firm];
    const accountIds=new Set(prior?supplierAccountIds(state,firm.id):[]);
    const accounts = prior ? state.accounts.map(a => accountIds.has(a.id) ? {...a,name,phone,taxId,address} : a) : state.accounts;
    return {entries:[],meta:{supplierId:firm.id},label:prior?'Firma bilgileri güncellendi':'Toptancı firma açılışı',firms,accounts};
  }
  const firm = resolveSupplierFirm(state,c.supplierId);
  if(c.type==='supplierLegacyReceiptLink') {
    fields(c,[...common,'supplierId','originalId','uses']);
    const docs=supplierDocuments(state,firm.id),receipt=docs.unresolvedReceipts.find(r=>r.id===c.originalId);
    if(!receipt)fail('Eşlenmemiş etkin eski tahsilat kaydını seçin.');
    const used=new Map(),uses=[];
    for(const row of rows(c.uses)) {
      fields(row,['sourceId','accountId','quantity']);
      const source=receipt.sources.find(s=>s.id===row.sourceId),credit=source?.credits.find(r=>r.accountId===row.accountId);
      if(!credit)fail('Tahsilattan önceki aynı firma ve birimde gerçek eski alacak kaynağını seçin.');
      const amount=quantity(row.quantity,credit.unit,{zero:false});
      if(amount>credit.remaining)fail('Eski tahsilat eşlemesi kaynağın kalan miktarını aşamaz.');
      credit.remaining-=amount;used.set(row.accountId,(used.get(row.accountId)||0)+amount);
      uses.push({sourceId:source.id,accountId:row.accountId,quantity:amount});
    }
    if(!uses.length||receipt.debts.some(r=>used.get(r.accountId)!==r.quantity))fail('Eski tahsilatın her birim miktarı kaynaklara eksiksiz eşlenmeli.');
    return {entries:[],meta:{supplierId:firm.id,originalId:receipt.id,uses},label:'Eski toptancı tahsilatı kaynak eşlemesi'};
  }
  if(c.type==='supplierReturn') {
    fields(c,[...common,'supplierId','originalId','items','reductions','credits','received','note','referenceTL']);
    const docs=supplierDocuments(state,firm.id),purchase=docs.purchases.find(d=>d.id===c.originalId);
    if(!purchase||!['purchase','supplierPurchase'].includes(purchase.kind))fail('Etkin özgün toptancı alışını seçin.');
    const reversed=new Set(state.journal.filter(e=>['reverse','supplierReverse'].includes(e.type)).map(e=>e.meta.originalId));
    const priorReturns=state.journal.filter(e=>e.type==='supplierReturn'&&e.meta.originalId===purchase.id&&!reversed.has(e.id));
    const lines=[],entries=[],selected=new Set();
    for(const row of rows(c.items)) {
      fields(row,['lineIndex','quantity','weight']);
      if(!Number.isInteger(row.lineIndex)||row.lineIndex<0||row.lineIndex>=purchase.lines.length||selected.has(row.lineIndex))fail('İade için alışın farklı geçerli satırlarını seçin.');
      selected.add(row.lineIndex);
      const original=purchase.lines[row.lineIndex],a=state.accounts.find(a=>a.id===original.accountId);
      if(!a||a.retired||(original.weightAccount&&state.accounts.find(a=>a.id===original.weightAccount)?.retired))fail('Eski ürün hesabı yeni iadeye kapalı.');
      const used=priorReturns.flatMap(e=>e.meta.lines).filter(l=>l.lineIndex===row.lineIndex);
      const remaining=original.quantity-used.reduce((n,l)=>n+l.quantity,0),remainingWeight=(original.weight||0)-used.reduce((n,l)=>n+(l.weight||0),0);
      const amount=quantity(row.quantity,a.unit,{zero:false});
      if(amount>remaining)fail('İade adedi veya gramı alışın kalan miktarını aşamaz.');
      let weight=0;
      if(original.weightAccount) {
        weight=quantity(row.weight,'GRAM',{zero:false});
        if(weight>remainingWeight||(amount===remaining&&weight!==remainingWeight)||(amount<remaining&&weight>=remainingWeight))fail('İade adedi ve gerçek gramı kalan alış satırıyla tutarlı olmalı.');
        entries.push({accountId:original.weightAccount,delta:-weight});
      } else if(row.weight!==undefined&&row.weight!=='')fail('Bu ürün satırında ikinci gram girilmez.');
      entries.push({accountId:a.id,delta:-amount});
      lines.push({lineIndex:row.lineIndex,accountId:a.id,quantity:amount,weightAccount:original.weightAccount||null,weight});
    }
    if(!lines.length)fail('İade edilecek ürün satırı gerekli.');
    const reductions=nativeLines(state,firm.id,c.reductions,1).lines;
    const ids=new Set(supplierAccountIds(state,firm.id));
    const groupedReductions=totals(state,ids,reductions);
    for(const row of groupedReductions) {
      const charge=purchase.charges.find(r=>r.accountId===row.accountId);
      if(!charge||row.quantity>charge.remaining)fail('Belgeden düşülecek miktar alışın tahsis edilmemiş kalanını aşamaz.');
    }
    const credits=nativeLines(state,firm.id,c.credits,1),received=assetLines(state,c.received,1,helpers);
    if(!credits.lines.length&&!received.lines.length)fail('İadenin anlaşılan cari alacağını veya alınan gerçek karşılığını girin.');
    entries.push(...credits.entries,...received.entries);
    const groupedCredits=totals(state,ids,credits.lines),availableCreditLines=[],chargeLines=[];
    for(const accountId of new Set([...groupedReductions,...groupedCredits].map(r=>r.accountId))) {
      const credit=groupedCredits.find(r=>r.accountId===accountId),reduction=groupedReductions.find(r=>r.accountId===accountId);
      const difference=(credit?.quantity||0)-(reduction?.quantity||0),unit=(credit||reduction).unit;
      if(difference>0)availableCreditLines.push({accountId,unit,quantity:difference});
      if(difference<0)chargeLines.push({accountId,unit,quantity:-difference});
    }
    const meta={supplierId:firm.id,originalId:purchase.id,lines,reductions:groupedReductions,creditLines:credits.lines,receivedLines:received.lines,
      availableCreditLines,chargeLines,...(purchase.agreementId&&{agreementId:purchase.agreementId}),note:text(c.note,'İade açıklaması'),...reference(c)};
    return {entries,meta,label:'Toptancı alış iadesi'};
  }
  if(c.type==='supplierAllocation') {
    fields(c,[...common,'supplierId','allocations','note']);
    const allocations=allocationLines(state,event,c.allocations);
    if(!allocations.length)fail('En az bir açık tahsis satırı girin.');
    return {entries:[],meta:{supplierId:firm.id,allocations,note:helpers.optionalText(c.note,'Açıklama')},label:'Toptancı ödeme tahsisi'};
  }
  if(c.type==='supplierOffset') {
    fields(c,[...common,'supplierId','fromAccountId','fromQuantity','toAccountId','toQuantity','note','sourceUses','targetUses','agreementId']);
    const from=nativeLines(state,firm.id,[{accountId:c.fromAccountId,quantity:c.fromQuantity}],-1);
    const to=nativeLines(state,firm.id,[{accountId:c.toAccountId,quantity:c.toQuantity}],1);
    if(from.lines[0].unit===to.lines[0].unit)fail('Mahsup farklı birimlerdeki alacak ve borç arasında olmalı.');
    if(from.lines[0].quantity>(state.balances[c.fromAccountId]||0)||to.lines[0].quantity>-(state.balances[c.toAccountId]||0))fail('Mahsup mevcut alacak veya borç miktarını aşamaz.');
    const docs=supplierDocuments(state,firm.id),sourceUses=[];
    const agreementId=helpers.optionalText(c.agreementId,'Anlaşma / sipariş',160);
    let sourceTotal=0,advanceScope='general';
    for(const row of rows(c.sourceUses)) {
      fields(row,['sourceId','quantity','overrideReserved','reason']);
      const source=docs.sources.find(s=>s.id===row.sourceId),credit=source?.credits.find(r=>r.accountId===c.fromAccountId);
      if(!credit)fail('Mahsup için aynı firma ve kaynak birimde alacak belgesi seçin.');
      assertSourceResolved(source,c.fromAccountId);
      const amount=quantity(row.quantity,credit.unit,{zero:false});
      if(amount>credit.remaining)fail('Mahsup alacak kaynağının kalanını aşamaz.');
      if(row.overrideReserved!==undefined&&typeof row.overrideReserved!=='boolean')fail('Ayrılmış avans kullanım onayı geçersiz.');
      if(source.advanceScope==='reserved'&&source.agreementId!==agreementId&&row.overrideReserved!==true)fail('Ayrılmış alacağın başka anlaşmada kullanımını onaylayın.');
      const reason=row.reason===undefined?'':text(row.reason,'Mahsup kaynak gerekçesi');
      if(row.overrideReserved&&!reason)fail('Ayrılmış alacak kullanım gerekçesi gerekli.');
      if(source.advanceScope==='reserved'&&!row.overrideReserved)advanceScope='reserved';
      credit.remaining-=amount;sourceTotal+=amount;
      sourceUses.push({sourceId:source.id,accountId:c.fromAccountId,quantity:amount,...(row.overrideReserved&&{overrideReserved:true}),...(reason&&{reason})});
    }
    if(!Number.isSafeInteger(sourceTotal)||sourceTotal!==from.lines[0].quantity)fail('Seçilen kaynak miktarları mahsup edilen alacağa eşit olmalı.');
    const entries=[...from.entries,...to.entries];
    const meta={supplierId:firm.id,from:from.lines[0],to:to.lines[0],sourceUses,advanceScope,...(agreementId&&{agreementId}),note:text(c.note,'Mahsup gerekçesi')};
    const targets=rows(c.targetUses).map(row=>{
      fields(row,['purchaseId','quantity','overrideReserved','reason']);
      return {...row,sourceId:event.id,accountId:c.toAccountId};
    });
    meta.allocations=allocationLines({...state,journal:[...state.journal,{id:event.id,type:c.type,date:c.date,meta,entries}]},event,targets);
    return {entries,meta,label:'Toptancı birimler arası mahsup'};
  }
  if (c.type === 'supplierUnit') {
    fields(c,[...common,'supplierId','unit']);
    const unit = financialUnit(c.unit), ids = new Set(supplierAccountIds(state,firm.id));
    if (state.accounts.some(a => ids.has(a.id) && a.unit === unit)) fail('Firmanın bu birimde hesabı zaten var.');
    const a = {id:'supplier-unit-'+event.id,name:firm.name,unit,physical:false,kind:'receivable',partyType:'supplier',supplierId:firm.id,
      phone:firm.phone,taxId:firm.taxId,address:firm.address,owner:'işletme',location:'cari hesap'};
    return {entries:[{accountId:a.id,delta:0}],meta:{supplierId:firm.id,accountId:a.id},label:'Toptancı birim hesabı açılışı',accounts:[...state.accounts,a]};
  }
  const purchase = c.type === 'supplierPurchase';
  fields(c,[...common,'supplierId','given','received','credits','debts','debtUses','note','referenceTL','agreementId',...(purchase ? ['items','charges','allocations'] : ['advanceScope'])]);
  const agreementId = helpers.optionalText(c.agreementId,'Anlaşma / sipariş',160);
  const advanceScope = c.advanceScope ?? 'general';
  if (!purchase && (!['general','reserved'].includes(advanceScope) || (advanceScope === 'reserved' && !agreementId))) fail('Ayrılmış avans için anlaşma / sipariş seçin.');
  const products = purchase ? productLines(state,c.items,1,helpers) : {entries:[],lines:[]};
  const charges = nativeLines(state,firm.id,purchase ? c.charges : [],-1);
  if (purchase && !charges.lines.length) fail('Alışın anlaşılmış cari borç miktarını girin.');
  const given = assetLines(state,c.given,-1,helpers), received = assetLines(state,c.received,1,helpers);
  const credits = nativeLines(state,firm.id,c.credits,1), debts = nativeLines(state,firm.id,c.debts,-1);
  if (Boolean(given.lines.length) !== Boolean(credits.lines.length) || Boolean(received.lines.length) !== Boolean(debts.lines.length)) {
    fail('Verilen ve alınan karşılıkların anlaşılmış cari etkilerini ayrı girin.');
  }
  if (!purchase && !given.lines.length && !received.lines.length) fail('Gerçek verilen veya alınan karşılık gerekli.');
  const entries = [...products.entries,...charges.entries,...given.entries,...received.entries,...credits.entries,...debts.entries];
  const meta = {supplierId:firm.id,lines:products.lines,chargeLines:charges.lines,givenLines:given.lines,receivedLines:received.lines,
    creditLines:credits.lines,debtLines:debts.lines,note:helpers.optionalText(c.note,'Açıklama'),...reference(c),...(agreementId && {agreementId}),...(!purchase && {advanceScope})};
  if(debts.lines.length||c.debtUses!==undefined) {
    const docs=supplierDocuments({...state,journal:[...state.journal,{id:event.id,type:c.type,date:c.date,meta,entries}]},firm.id);
    const debtTotals=totals(state,new Set(supplierAccountIds(state,firm.id)),debts.lines);
    const required=new Map(debtTotals.map(row=>[row.accountId,Math.min(row.quantity,docs.sources.reduce((sum,s)=>sum+(s.blockedAccounts.includes(row.accountId)?0:s.credits.find(r=>r.accountId===row.accountId)?.remaining||0),0))]));
    const used=new Map(),debtUses=[];
    for(const row of rows(c.debtUses)) {
      fields(row,['sourceId','accountId','quantity','overrideReserved','reason']);
      const sourceId=row.sourceId===undefined?event.id:row.sourceId;
      const source=docs.sources.find(s=>s.id===sourceId),credit=source?.credits.find(r=>r.accountId===row.accountId);
      if(!credit||!required.has(row.accountId))fail('Tahsilat için ilgili birimdeki alacak kaynağını seçin.');
      assertSourceResolved(source,row.accountId);
      const amount=quantity(row.quantity,credit.unit,{zero:false});
      if(amount>credit.remaining)fail('Tahsilat alacak kaynağının kalanını aşamaz.');
      if(row.overrideReserved!==undefined&&typeof row.overrideReserved!=='boolean')fail('Ayrılmış avans kullanım onayı geçersiz.');
      if(source.advanceScope==='reserved'&&source.agreementId!==agreementId&&row.overrideReserved!==true)fail('Ayrılmış alacağın başka anlaşmada kullanımını onaylayın.');
      const reason=row.reason===undefined?'':text(row.reason,'Tahsilat kaynak gerekçesi');
      if(row.overrideReserved&&!reason)fail('Ayrılmış alacak kullanım gerekçesi gerekli.');
      credit.remaining-=amount;used.set(row.accountId,(used.get(row.accountId)||0)+amount);
      debtUses.push({sourceId,accountId:row.accountId,quantity:amount,...(row.overrideReserved&&{overrideReserved:true}),...(reason&&{reason})});
    }
    for(const [id,amount] of required)if((used.get(id)||0)!==amount)fail('Tahsilatın mevcut alacağı azaltan kısmı kadar belge kaynağı açıkça seçilmeli.');
    meta.debtUses=debtUses;
    meta.receiptChargeLines=debtTotals.map(row=>({...row,quantity:row.quantity-(required.get(row.accountId)||0)})).filter(row=>row.quantity>0);
  }
  if(purchase&&c.allocations!==undefined) {
    const withCurrent={...state,journal:[...state.journal,{id:event.id,type:c.type,date:c.date,meta,entries}]};
    meta.allocations=allocationLines(withCurrent,event,c.allocations,true);
  }
  return {entries,meta,label:purchase?'Toptancıdan ürün alışı':given.lines.length ? received.lines.length?'Toptancı ödeme / tahsilat':'Toptancıya ödeme':'Toptancıdan tahsilat'};
}
