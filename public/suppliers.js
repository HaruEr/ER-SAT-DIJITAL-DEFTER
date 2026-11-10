const TASKS = [
  ['purchase','Ürün Al'],['payment','Ödeme Yap'],['offset','Hesap Mahsup Et'],
  ['return','Ürün İade Et'],['history','Hareketleri İncele'],['statement','Ekstre / Mutabakat']
];
const SUPPLIER_DRAFTS = new Map();
const unitLabel=unit=>unit==='SILVER'?'Ag · saf gümüş':unit;
function receiptSuffix(record, peers=[]){
  if(!record.id)return '';
  const id=String(record.id);let width=8;
  while(width<id.length&&peers.some(other=>other.id!==record.id&&String(other.id).slice(-width)===id.slice(-width)))width++;
  return (record.note?' · '+String(record.note).slice(0,90):'')+' · Fiş '+(id.length>width?'…':'')+id.slice(-width);
}
const receiptSelects='select[data-source-field="choice"],select[data-source-field="purchase"],select[data-target-field="purchaseId"],select[name="originalId"],select[data-field="source"]';
function selectionSummary(select){
  if(!select)return;const label=select.closest('label');if(!label)return;
  let summary=label.querySelector('.supplier-selection-summary');if(!summary){summary=select.ownerDocument.createElement('p');summary.className='supplier-selection-summary';summary.setAttribute('aria-live','polite');select.after(summary);}
  summary.textContent=select.value?select.selectedOptions[0]?.textContent||'':'';summary.hidden=!summary.textContent;
}
const normalize = value => String(value || '').toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/ı/g,'i');

// The wrapper owns authorization, HTTP, pending/retry and authoritative ledger state.
export function renderSupplierWorkspace(container, context) {
  const {escape:esc,format,day}=context;
  const memory=context.memory||SUPPLIER_DRAFTS,viewKey='supplier:view:'+(context.workspace||'default'),remembered=memory.get(viewKey);
  let state=context.state,selectedId=remembered?.partyId||null,activeTask=remembered?.kind||null,query='',disposed=false,taskCleanup=null;
  const pending=()=>Boolean(context.isPending?.());
  const firms=()=>state?.supplierParties;
  const status=message=>{const node=container.querySelector('[data-supplier-status]');if(node)node.textContent=message;};
  const clearTask=completedDraftKey=>{if(typeof taskCleanup==='function')taskCleanup(completedDraftKey);taskCleanup=null;};
  const balanceMarkup = accounts => accounts.length ? accounts.map(a=>{
    const label=a.balance<0?'Borcumuz':a.balance>0?'Alacağımız':'Bakiyesi sıfır';
    const amount=(a.balance<0?'−':a.balance>0?'+':'')+format(Math.abs(a.balance),a.unit);
    return '<div class="balance-row" data-balance="'+esc(a.id)+'"><span>'+esc(unitLabel(a.unit))+' · '+label+'</span><strong class="'+(a.balance<0?'negative':a.balance>0?'positive':'')+'">'+esc(amount)+'</strong></div>';
  }).join('') : '<p class="context-note">Henüz hesap birimi yok.</p>';
  function drawList() {
    const list=container.querySelector('[data-supplier-list]');if(!list)return;
    const matches=firms().filter(f=>normalize([f.name,f.phone,f.taxId].join(' ')).includes(normalize(query)));
    list.innerHTML=matches.map(f=>'<article class="account-card" data-firm-card="'+esc(f.id)+'"><h2><button type="button" class="button text" data-open-firm="'+esc(f.id)+'">'+esc(f.name)+'</button></h2>'+
      (f.phone?'<p>'+esc(f.phone)+'</p>':'')+balanceMarkup(f.accounts)+
      (f.lastEvent?'<p class="context-note">Son işlem: '+esc(day(f.lastEvent.date)+' · '+f.lastEvent.label)+'</p>':'<p class="context-note">Henüz işlem yok.</p>')+'</article>').join('')||
      '<p class="info neutral">'+(firms().length?'Aramanızla eşleşen firma yok.':'Henüz firma yok. Firma ekleyerek başlayın.')+'</p>';
  }
  function draw(focus=false) {
    if(disposed)return;clearTask();
    const header='<div class="section-header"><h1>Toptancılar</h1><button type="button" class="button secondary" data-refresh-suppliers>Yenile</button></div><p role="status" aria-live="polite" data-supplier-status></p>';
    if(!Array.isArray(firms())) {container.innerHTML=header+'<p class="info neutral">Firma bilgileri alınamadı. Yeniden deneyin.</p>';return;}
    const firm=firms().find(f=>f.id===selectedId);
    if(!firm)selectedId=null;
    if(firm) {
      container.innerHTML=header+'<section class="section supplier-active-header"><div class="section-header"><h2 tabindex="-1" data-firm-heading>'+esc(firm.name)+'</h2><button type="button" class="button secondary" data-back-suppliers>Firma listesine dön</button></div>'+
        ([firm.phone,firm.taxId,firm.address].some(Boolean)?'<details class="supplier-contact-details"><summary>İletişim bilgileri</summary><p>'+[firm.phone,firm.taxId,firm.address].filter(Boolean).map(esc).join(' · ')+'</p></details>':'')+'<h3>Güncel hesaplar</h3><div class="supplier-balances">'+balanceMarkup(firm.accounts)+'</div>'+
        '<div class="workbench-actions supplier-identity-actions" aria-label="Firma bilgileri ve belge bağlantıları"><button type="button" class="button secondary" data-edit-supplier>Firma bilgilerini düzenle</button><button type="button" class="button secondary" data-add-supplier-unit'+(pending()?' disabled':'')+'>Hesap birimi ekle</button>'+
        '<button type="button" class="button secondary" data-supplier-documents>Ödeme / avansı alışa bağla</button></div><div class="workbench-actions supplier-task-actions" aria-label="Firma işlemleri">'+TASKS.map(([kind,label])=>'<button type="button" class="button secondary" data-supplier-task="'+kind+'"'+(pending()&&!['history','statement'].includes(kind)?' disabled':'')+'>'+label+'</button>').join('')+'</div></section><section class="section" data-supplier-task-panel hidden></section>';
      if(focus)container.querySelector('[data-firm-heading]').focus();
    } else {
      container.innerHTML=header+'<div class="workbench-actions"><label class="field"><span>Firma ara</span><input type="search" data-supplier-search maxlength="160" value="'+esc(query)+'" autocomplete="off"></label><button type="button" class="button" data-create-firm'+(pending()?' disabled':'')+'>Firma ekle</button></div><div class="account-grid" data-supplier-list></div><section class="section" data-supplier-task-panel hidden></section>';
      drawList();if(focus)container.querySelector('[data-supplier-search]').focus();
    }
    if(activeTask && (selectedId||activeTask==='create'))openTask(activeTask);
  }
  function openTask(kind) {
    if(pending()&&!['history','statement'].includes(kind)){status('Bekleyen işlemin sonucu doğrulanmadan yeni işlem başlatılamaz.');return;}
    activeTask=kind;memory.set(viewKey,{partyId:selectedId,kind});
    clearTask();const panel=container.querySelector('[data-supplier-task-panel]');panel.hidden=false;panel.replaceChildren();
    const title=TASKS.find(([key])=>key===kind)?.[1]||({create:'Firma ekle',profile:'Firma bilgileri',reverse:'İşlemi ters kayıtla iptal et',unit:'Hesap birimi ekle',allocation:'Ödeme / avansı alışa bağla',legacyLink:'Eski tahsilatın ödeme kaynakları'}[kind]);
    const heading=container.ownerDocument.createElement('h3');heading.textContent=title;heading.tabIndex=-1;panel.append(heading);
    const handled=context.onTask?.({kind,partyId:selectedId,container:panel,context:{...context,state}});
    if(context.onTask && handled!==false)taskCleanup=handled;
    else if(['create','profile','reverse','unit','purchase','payment'].includes(kind)){
      const saved=memory.get('supplier:draft:'+JSON.stringify([context.workspace||'default',selectedId||'',kind]));
      if(saved?.amend){let stopped=false,cleanup=null;const partyId=selectedId;const note=container.ownerDocument.createElement('p');note.textContent='Düzeltme önizlemesi yükleniyor…';panel.append(note);
        context.request('suppliers',undefined,context.workspace,{query:{supplierId:partyId,editOriginalId:saved.amend.originalId,limit:50}}).then(data=>{if(stopped)return;if(data.revision!==state.revision||data.amendment?.originalId!==saved.amend.originalId)throw Error('Düzeltme önizlemesi doğrulanamadı.');note.textContent='Düzeltme için eski etkinin geri alınmış önizlemesi';const previewState={...state,supplierParties:state.supplierParties.map(p=>p.id===partyId?{...p,accounts:p.accounts.map(a=>({...a,balance:data.amendment.balances[a.id]}))}:p)};cleanup=renderSupplierForm(panel,{...context,state:previewState,partyId,kind,editOriginalId:saved.amend.originalId});}).catch(error=>{if(!stopped)note.textContent=error.message;});taskCleanup=key=>{stopped=true;cleanup?.(key);};
      }else taskCleanup=renderSupplierForm(panel,{...context,state,partyId:selectedId,kind});
    }
    else if(['allocation','offset','return','legacyLink'].includes(kind)){let stopped=false,cleanup=null;renderSupplierDocumentTask(panel,{...context,state,partyId:selectedId,kind,isCurrent:()=>!stopped&&panel.isConnected}).then(fn=>{if(stopped)fn?.();else cleanup=fn;});taskCleanup=key=>{stopped=true;cleanup?.(key);};}
    else if(['history','statement'].includes(kind))taskCleanup=renderSupplierRead(panel,{...context,state,partyId:selectedId,kind,onRecordAction(event,action){
      const command=event.editableCommand||event.meta?.editableCommand,task=action==='reverse'?'reverse':({supplierPurchase:'purchase',supplierPayment:'payment',supplierAllocation:'allocation',supplierOffset:'offset',supplierReturn:'return'})[command?.type];
      const key='supplier:draft:'+JSON.stringify([context.workspace||'default',selectedId,task]);
      if(memory.has(key)){status('Bu işlem için korunmuş bir taslak var. Önce taslağı tamamlayın.');return;}
      const fields=action==='reverse'?{originalId:event.id,note:''}:{...Object.fromEntries(Object.entries(command).filter(([,value])=>typeof value==='string')),direction:command.received?.length&&!command.given?.length?'collect':'pay',advanceScope:command.advanceScope||'general'};
      const rows={};if(action!=='reverse')for(const name of ['items','charges','given','credits','received','debts'])rows[name]=command[name]||[];
      const links=(action!=='reverse'?(command.type==='supplierPurchase'||command.type==='supplierAllocation'?command.allocations:command.type==='supplierOffset'?(command.sourceUses||[]).map(row=>({...row,accountId:command.fromAccountId})):command.debtUses):[])||[];
      if(task==='return'){for(const line of command.items||[]){fields['returnQty-'+line.lineIndex]=line.quantity;if(line.weight)fields['returnWeight-'+line.lineIndex]=line.weight;}for(const row of command.reductions||[])fields['reduction-'+row.accountId]=row.quantity;}
      memory.set(key,{fields,rows,arrays:rows,targets:command?.targetUses||[],stamp:{revision:state.revision,date:state.date},recordLabel:day(event.date)+' · '+event.label,...(action==='edit'?{amend:{originalId:event.id,note:''}}:{}),links:links.map(row=>({...row,choice:JSON.stringify([row.sourceId||'',row.accountId]),...(row.purchaseId?{purchase:JSON.stringify([row.purchaseId,row.accountId])}:{})})),debtLinks:(command?.type==='supplierPurchase'?command.debtUses||[]:[]).map(row=>({...row,choice:JSON.stringify([row.sourceId||'',row.accountId])}))});openTask(task);
    }});
    else {const note=container.ownerDocument.createElement('p');note.className='info neutral';note.textContent='Bu işlem henüz hazır değil. Geliştirme aşamasında.';panel.append(note);}
    heading.focus();
    heading.scrollIntoView?.({block:'start',behavior:'instant'});
  }
  function click(event) {
    const button=event.target.closest('button');if(!button||!container.contains(button)||disposed)return;context.onInteraction?.({kind:'action'});
    if(button.hasAttribute('data-open-firm')){selectedId=button.dataset.openFirm;activeTask=null;memory.set(viewKey,{partyId:selectedId,kind:null});draw(true);}
    else if(button.hasAttribute('data-back-suppliers')){selectedId=null;activeTask=null;memory.set(viewKey,{partyId:null,kind:null});draw(true);}
    else if(button.hasAttribute('data-refresh-suppliers'))context.refresh();
    else if(button.hasAttribute('data-create-firm'))openTask('create');
    else if(button.hasAttribute('data-edit-supplier'))openTask('profile');
    else if(button.hasAttribute('data-add-supplier-unit'))openTask('unit');
    else if(button.hasAttribute('data-supplier-legacy'))openTask('legacyLink');
    else if(button.hasAttribute('data-supplier-documents'))openTask('allocation');
    else if(button.hasAttribute('data-supplier-task'))openTask(button.dataset.supplierTask);
  }
  function input(event){context.onInteraction?.({kind:'input'});if(event.target.matches('[data-supplier-search]')){query=event.target.value;drawList();}}
  const interact=event=>{context.onInteraction?.({kind:'input'});if(event.target.matches(receiptSelects))selectionSummary(event.target);};container.addEventListener('click',click);container.addEventListener('input',input);container.addEventListener('change',interact);container.addEventListener('invalid',interact,true);draw();
  return {
    update(nextState,{completedDraftKey}={}){if(disposed)return;if(completedDraftKey)clearTask(completedDraftKey);if(activeTask==='reverse'&&completedDraftKey==='supplier:draft:'+JSON.stringify([context.workspace||'default',selectedId,'reverse'])){activeTask='history';memory.set(viewKey,{partyId:selectedId,kind:activeTask});}state=nextState;draw();},
    destroy(){if(disposed)return;disposed=true;clearTask();container.removeEventListener('click',click);container.removeEventListener('input',input);container.removeEventListener('change',interact);container.removeEventListener('invalid',interact,true);container.replaceChildren();}
  };
}


function renderSupplierForm(panel, context) {
  const {escape:esc,state,kind,partyId}=context,doc=panel.ownerDocument;
  const party=state.supplierParties?.find(p=>p.id===partyId),nativeAccounts=party?.accounts||[];
  const catalog=(state.accounts||[]).filter(a=>!a.retired),drafts=context.memory||SUPPLIER_DRAFTS;
  const key='supplier:draft:'+JSON.stringify([context.workspace||'default',partyId||'',kind]),saved=drafts.get(key);
  let sourcePicker=null,receiptPicker=null,sending=false,destroyed=false,completed=false,dirty=Boolean(saved),stamp=saved?.stamp||{revision:state.revision,date:state.date};
  const stale=()=>stamp.revision!==state.revision||stamp.date!==state.date;
  const field=(name,label,required=false)=>'<label class="field"><span>'+label+'</span><input name="'+name+'" maxlength="300"'+(required?' required':'')+'></label>';
  const form=doc.createElement('form');form.dataset.supplierForm=kind;form.dataset.kind=kind;form.className='supplier-task-form';panel.append(form);
  const groups=new Map();
  const status=doc.createElement('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const info=message=>{context.onInteraction?.({kind:'feedback'});status.textContent=message;};
  const select=(name,label,options)=>'<label class="field"><span>'+label+'</span><select name="'+name+'" required><option value="">Seçin</option>'+options.map(([id,label])=>'<option value="'+esc(id)+'">'+esc(label)+'</option>').join('')+'</select></label>';
  if(['create','profile'].includes(kind))form.innerHTML=field('name','Firma adı',true)+field('phone','Telefon · isteğe bağlı')+field('taxId','TC / VKN · isteğe bağlı')+field('address','Adres · isteğe bağlı');
  else if(kind==='reverse')form.innerHTML='<p>'+esc(saved?.recordLabel||'Seçilen kayıt')+'</p><p>Asıl kayıt korunur; etkileri ters kayıtla geri alınır. Bağlı kayıt varsa işlem reddedilir. Gerçek ürün geri verildiyse Ürün İade Et akışını kullanın.</p>'+field('note','İptal gerekçesi',true)+'<input type="hidden" name="originalId" value="'+esc(saved?.fields.originalId||'')+'">';
  else if(kind==='unit'){
    const used=new Set(nativeAccounts.map(a=>a.unit));
    form.innerHTML=select('unit','Hesap birimi',['TL','USD','EUR','GBP','CHF','HAS','SILVER'].filter(u=>!used.has(u)).map(u=>[u,unitLabel(u)]).concat([['other','Diğer döviz']]))+field('currencyCode','Üç harfli döviz kodu')+
      '<p class="context-note">Hesap sıfır bakiye ile açılır.</p>';
  } else {
    if(!nativeAccounts.length)form.insertAdjacentHTML('beforeend','<p class="info neutral">Bu firmanın hesap birimi yok. İşlemden önce hesap birimi ekleyin.</p>');
    if(kind==='payment')form.insertAdjacentHTML('beforeend',select('direction','Ne yapılıyor?',[['pay','Firmaya ödeme / ön ödeme'],['collect','Firmadan tahsilat']]));
    const definitions=kind==='purchase'?
      [['items','1. Aldığınız ürünler',true],['charges','2. Anlaştığınız alış borcu',false],['given','Ödediğiniz / verdiğiniz',true],['credits','Ödemenin borç / alacak karşılığı',false],['received','Ek olarak aldığınız',true],['debts','Aldığınızın borç / alacak karşılığı',false]]:
      [['given','Ödediğiniz / verdiğiniz',true],['credits','Ödemenin borç / alacak karşılığı',false],['received','Aldığınız para / ürün',true],['debts','Aldığınızın borç / alacak karşılığı',false]];
    for(const [name,title,physical] of definitions){
      const section=doc.createElement('fieldset');section.dataset.group=name;section.innerHTML='<legend>'+title+'</legend><div data-rows></div><button type="button" class="button secondary compact" data-add-row>Satır ekle</button>';
      form.append(section);
      const rows=()=>[...section.querySelectorAll('[data-row]')];
      const add=(values={})=>{
        if(rows().length>=30){info('Bir grupta en çok 30 satır eklenebilir.');return;}
        const row=doc.createElement('div');row.dataset.row='';row.className='form-grid';
        const choices=physical?catalog.filter(a=>name==='items'?(a.isPurchasable||a.isSaleable):a.kind==='asset'&&a.id!=='pos'):nativeAccounts;
        row.innerHTML='<label class="field"><span>'+ (physical?(name==='items'?'Ürün':'Ürün / kasa / banka'):'Firma hesabı') +'</span><select data-field="accountId" required><option value="">Seçin</option>'+choices.map(a=>'<option value="'+esc(a.id)+'">'+esc((a.name||unitLabel(a.unit))+' · '+unitLabel(a.unit))+'</option>').join('')+'</select></label>'+
          '<label class="field"><span data-quantity-label>Miktar</span><input data-field="quantity" required inputmode="decimal" maxlength="24"></label>'+
          (physical?'<label class="field" data-weight-group hidden><span>Ayar / terazi grubu</span><select data-field="weightAccount"></select></label><label class="field" data-weight-input hidden><span>Gerçek toplam gram</span><input data-field="weight" inputmode="decimal" maxlength="24"></label>':'')+
          '<details><summary>TL referansı · isteğe bağlı</summary><label class="field"><span>Anlaşılmış TL referansı</span><input data-field="referenceTL" inputmode="decimal" maxlength="24"></label></details><button type="button" class="button text" data-remove-row>Satırı kaldır</button>';
        const accountSelect=row.querySelector('[data-field="accountId"]');
        function configure(){
          const a=choices.find(a=>a.id===accountSelect.value);row.querySelector('[data-quantity-label]').textContent='Miktar'+(a?' · '+unitLabel(a.unit):'');
          if(physical){const weightGroup=row.querySelector('[data-field="weightAccount"]'),weight=row.querySelector('[data-field="weight"]'),old=weightGroup.value,ids=a?.pairedGroups||[];
            weightGroup.innerHTML=ids.map(id=>'<option value="'+esc(id)+'">'+esc(catalog.find(a=>a.id===id)?.name||id)+'</option>').join('');
            if(ids.includes(old))weightGroup.value=old;
            weightGroup.disabled=weight.disabled=!ids.length;weightGroup.required=weight.required=!!ids.length;row.querySelector('[data-weight-group]').hidden=row.querySelector('[data-weight-input]').hidden=!ids.length;
          }
        }
        accountSelect.addEventListener('change',configure);
        row.querySelector('[data-remove-row]').addEventListener('click',()=>{row.remove();dirty=true;remember();preview();});
        section.querySelector('[data-rows]').append(row);accountSelect.value=values.accountId||'';configure();
        for(const [k,v] of Object.entries(values)){const input=row.querySelector('[data-field="'+k+'"]');if(input&&!input.disabled)input.value=v;}
      };
      section.querySelector('[data-add-row]').addEventListener('click',()=>{add();dirty=true;remember();preview();});
      groups.set(name,{rows,add,section});
    }
    if(kind==='purchase'){
      for(const [title,names]of [['3. Bu alışta ödeme yapıyoruz',['given','credits']],['Ek olarak para / ürün alıyoruz',['received','debts']]]){const details=doc.createElement('details');details.className='supplier-payment-details';details.innerHTML='<summary>'+title+'</summary><div class="supplier-payment-columns"></div>';form.append(details);for(const name of names)details.querySelector('div').append(groups.get(name).section);}
      const addPayment=doc.createElement('button');addPayment.type='button';addPayment.className='button secondary';addPayment.textContent='Ödeme ekle';addPayment.dataset.addPayment='';
      groups.get('given').section.before(addPayment);
      addPayment.addEventListener('click',()=>{for(const name of ['given','credits'])if(!groups.get(name).rows().length)groups.get(name).add(name==='credits'?{accountId:preferredCredit()}:{});dirty=true;remember();preview();revealInput(groups.get('given').rows()[0].querySelector('select'));});
    }
    if(kind==='payment'){const extra=doc.createElement('details');extra.dataset.extraPayment='';extra.innerHTML='<summary>Ek olarak ters yönde para / ürün veriyoruz veya alıyoruz</summary>';form.append(extra);}
    if(kind==='payment')form.insertAdjacentHTML('beforeend',select('advanceScope','Ödeme / avansın kapsamı',[['general','Genel firma hesabı'],['reserved','Belirli anlaşmaya ayrılmış']])+'<details data-agreement-details><summary>Anlaşma / sipariş · isteğe bağlı</summary>'+field('agreementId','Anlaşma / sipariş kimliği')+'</details>');
    else form.insertAdjacentHTML('beforeend','<details class="supplier-optional-metadata"><summary>Anlaşma / sipariş · isteğe bağlı</summary>'+field('agreementId','Anlaşma / sipariş kimliği · isteğe bağlı')+'</details>');
    form.insertAdjacentHTML('beforeend','<details class="supplier-optional-metadata"><summary>Açıklama · isteğe bağlı</summary>'+field('note','Açıklama')+'</details>'+ '<details><summary>İşlem TL referansı · isteğe bağlı</summary>'+field('referenceTL','Anlaşılmış toplam TL referansı')+'</details>'+ '<div data-supplier-preview class="info neutral" aria-live="polite"></div>');
  }
  if(saved?.amend)form.insertAdjacentHTML('beforeend','<p>'+esc(saved.recordLabel)+' · Düzeltme</p>'+field('amendNote','Düzeltme gerekçesi',true));
  const review=doc.createElement('button');review.type='button';review.className='button secondary';review.dataset.reviewCurrent='';review.textContent='Güncel bilgilerle kontrol ettim';review.hidden=!stale();form.append(review);
  review.addEventListener('click',()=>{stamp={revision:state.revision,date:state.date};review.hidden=true;remember();preview();info('Güncel hesap ve ürün seçimlerini kontrol edip kaydedin.');});
  const save=doc.createElement('button');save.type='submit';save.className='button';save.textContent=({create:'Firmayı ekle',profile:'Firma bilgilerini kaydet',reverse:'Ters kaydı kaydet',unit:'Hesap birimini ekle',purchase:'Ürün alışını kaydet',payment:'Ödemeyi / tahsilatı kaydet'})[kind];form.append(save,status);
  function values(){const fields={};for(const input of form.querySelectorAll('[name]'))fields[input.name]=input.value;const rows={};for(const [name,group]of groups)rows[name]=group.rows().map(row=>Object.fromEntries([...row.querySelectorAll('[data-field]')].filter(x=>!x.disabled).map(x=>[x.dataset.field,x.value])));return {fields,rows,stamp,...(saved?.amend?{amend:saved.amend,recordLabel:saved.recordLabel}:{}),...(kind==='reverse'?{recordLabel:saved?.recordLabel}:{}),links:sourcePicker?.snapshot()||[],debtLinks:receiptPicker?.snapshot()||[]};}
  function remember(){if(!completed&&dirty)drafts.set(key,values());}
  function scope(){if(kind!=='payment')return;const reserved=form.elements.direction.value==='pay'&&form.elements.advanceScope.value==='reserved';form.elements.agreementId.required=reserved;const details=form.querySelector('[data-agreement-details]');details.querySelector('summary').textContent=reserved?'Anlaşma / sipariş · zorunlu':'Anlaşma / sipariş · isteğe bağlı';if(reserved||form.elements.agreementId.value)details.open=true;}
  function revealInput(input){
    if(!input)return;for(let node=input.parentElement;node&&node!==form;node=node.parentElement)if(node.tagName==='DETAILS')node.open=true;
    input.focus();input.scrollIntoView?.({block:'center'});
  }
  function preferredCredit(){
    const charges=groups.get('charges')?.rows()||[];
    return charges.length===1?charges[0].querySelector('[data-field="accountId"]').value:nativeAccounts.length===1?nativeAccounts[0].id:'';
  }
  function paymentLayout(){
    if(kind!=='payment')return;
    const extra=form.querySelector('[data-extra-payment]'),collect=form.elements.direction.value==='collect';
    const primary=collect?['received','debts']:['given','credits'],secondary=collect?['given','credits']:['received','debts'];
    for(const name of primary)form.insertBefore(groups.get(name).section,extra);
    for(const name of secondary)extra.append(groups.get(name).section);
    if(secondary.some(name=>groups.get(name).rows().length))extra.open=true;
  }
  function paymentIssue(reveal=false){
    for(const help of form.querySelectorAll('[data-payment-help]')){help.textContent='';help.hidden=true;}
    for(const [physical,native]of [['given','credits'],['received','debts']]){
      const source=groups.get(physical),target=groups.get(native);if(!source||!target)continue;
      const rows=source.rows(),effects=target.rows();
      let help=source.section.querySelector('[data-payment-help]');
      if(!help){help=doc.createElement('p');help.dataset.paymentHelp=physical;help.id='supplier-'+kind+'-'+physical+'-help';help.className='context-note';help.setAttribute('aria-live','polite');source.section.append(help);}
      help.textContent='';help.hidden=true;
      const missing=rows.length&&(!effects.length||effects.some(row=>!row.querySelector('select').value||!row.querySelector('[data-field="quantity"]').value.trim()));
      const orphan=effects.length&&!rows.length;
      if(!missing&&!orphan)continue;
      const units=[...new Set(effects.map(row=>nativeAccounts.find(a=>a.id===row.querySelector('select').value)?.unit).filter(Boolean))];
      if(!units.length){const a=nativeAccounts.find(a=>a.id===preferredCredit());if(a)units.push(a.unit);}
      const amounts=rows.map(row=>{const a=catalog.find(a=>a.id===row.querySelector('select').value),input=row.querySelector('[data-field="quantity"]');if(!a||!input.value.trim())return '';const n=context.parseAmount?.(input,a.unit,true);return Number.isSafeInteger(n)&&n>0?context.format(n,a.unit):input.value+' '+unitLabel(a.unit);}).filter(Boolean).join(' + ');
      const message=orphan?'Borç / alacak karşılığı girdiniz. Buna karşılık gerçekten verdiğiniz veya aldığınız para / ürünü ekleyin.':(amounts?amounts+' ':'')+(physical==='given'?'ödeme girdiniz. Toptancıyla bu ödemenin ':'tahsilat girdiniz. Toptancıyla bu tahsilatın ')+(units.length?'kaç '+units.map(unitLabel).join(' / ')+' ':'hangi birimde ne kadar ')+(physical==='given'?'borç kapatacağı veya alacak oluşturacağı':'alacağı azaltacağı veya borç oluşturacağı')+' konusunda anlaştığınız miktarı belirtin.';
      help.hidden=false;help.textContent=message;
      if(reveal){const group=orphan?source:target;if(!group.rows().length)group.add(orphan?{}:{accountId:preferredCredit()});const row=group.rows().find(row=>!row.querySelector('select').value||!row.querySelector('[data-field="quantity"]').value.trim())||group.rows()[0];const input=row.querySelector('select').value?row.querySelector('[data-field="quantity"]'):row.querySelector('select');input.setAttribute('aria-describedby',help.id);revealInput(input);dirty=true;remember();status.textContent='';}
      return message;
    }
    return '';
  }
  function updateCopyButtons(){
    for(const [physical,native]of [['given','credits'],['received','debts']]){
      const target=groups.get(native);if(!target)continue;
      let button=target.section.querySelector('[data-copy-payment]');
      if(!button){button=doc.createElement('button');button.type='button';button.className='button secondary compact';button.dataset.copyPayment=physical;button.textContent='Aynı birimdeki miktarı kullan';target.section.append(button);button.addEventListener('click',()=>{const match=copyCandidate(physical,native);if(!match)return;match.input.value=match.value;match.input.setCustomValidity('');dirty=true;remember();preview();revealInput(match.input);});}
      button.disabled=!copyCandidate(physical,native);button.hidden=button.disabled;
    }
  }
  function copyCandidate(physical,native){
    const sources=groups.get(physical).rows(),targets=groups.get(native).rows();if(sources.length!==1||targets.length!==1)return null;
    const source=sources[0],target=targets[0],a=catalog.find(a=>a.id===source.querySelector('select').value),b=nativeAccounts.find(a=>a.id===target.querySelector('select').value),input=source.querySelector('[data-field="quantity"]');
    const amount=a&&context.parseAmount?.(input,a.unit,true);
    return a&&b&&a.unit===b.unit&&Number.isSafeInteger(amount)&&amount>0?{input:target.querySelector('[data-field="quantity"]'),value:input.value}:null;
  }
  function preview(){
    const target=form.querySelector('[data-supplier-preview]');if(!target)return;
    const addPayment=form.querySelector('[data-add-payment]');if(addPayment)addPayment.hidden=!!(groups.get('given').rows().length||groups.get('credits').rows().length);
    updateCopyButtons();
    sourcePicker?.refresh();receiptPicker?.refresh();
    const current=values(),parts=[];
    const issue=paymentIssue();if(issue){target.textContent='Ödeme / tahsilat karşılığını tamamlayın. Mali önizleme hesaplanmadı.';return;}
    if(stale()){target.textContent='Defter veya iş günü değişti. Güncel bilgileri kontrol etmeden mali önizleme hesaplanmaz.';return;}
    if(kind==='purchase'&&(!current.rows.items.length||!current.rows.charges.length)){target.textContent='Alınan ürün ve anlaşılmış alış borcu gerekli. Mali önizleme hesaplanmadı.';return;}
    for(const picker of [sourcePicker,receiptPicker]){const result=picker?.read();if(result?.error){target.textContent=result.error+' Mali önizleme hesaplanmadı.';return;}}
    if(form.elements.referenceTL?.value.trim()&&context.parseAmount){const n=context.parseAmount(form.elements.referenceTL,'TL',false);if(!Number.isSafeInteger(n)||n<0){target.textContent='Geçerli TL referansı girin. Mali önizleme hesaplanmadı.';return;}}
    if(context.parseAmount){let invalid=false;
      for(const[name,group]of groups)for(const row of group.rows()){
        const account=[...catalog,...nativeAccounts].find(a=>a.id===row.querySelector('[data-field="accountId"]').value);if(!account){invalid=true;continue;}
        for(const[key,unit,positive]of [['quantity',account.unit,true],['weight','GRAM',true],['referenceTL','TL',false]]){const input=row.querySelector('[data-field="'+key+'"]');if(!input||input.disabled||key!=='quantity'&&!input.required&&!input.value.trim())continue;if(!input.value.trim()){invalid=true;continue;}const amount=context.parseAmount(input,unit,positive);if(!Number.isSafeInteger(amount)||amount<(positive?1:0))invalid=true;}
      }
      if(invalid){target.textContent='Eksik veya geçersiz miktarlar var. Mali önizleme hesaplanmadı.';return;}
    }
    for(const [name,group]of groups){
      const lines=current.rows[name].map(row=>{const a=[...catalog,...nativeAccounts].find(a=>a.id===row.accountId);return a&&row.quantity?esc((a.name||unitLabel(a.unit))+' · '+row.quantity+' '+unitLabel(a.unit)+(row.weight?' · '+row.weight+' gr':'')+(row.referenceTL?' · TL referansı '+row.referenceTL:'')):'';}).filter(Boolean);
      if(lines.length)parts.push('<h4>'+esc(group.section.querySelector('legend').textContent)+'</h4><ul>'+lines.map(x=>'<li>'+x+'</li>').join('')+'</ul>');
    }
    if(context.parseAmount){
      const deltas=new Map(),invalid=new Set();
      for(const name of ['charges','credits','debts'])for(const row of groups.get(name)?.rows()||[]){
        const id=row.querySelector('[data-field="accountId"]').value,a=nativeAccounts.find(a=>a.id===id);if(!a)continue;
        const amount=context.parseAmount(row.querySelector('[data-field="quantity"]'),a.unit,true);
        if(amount===null)invalid.add(id);else deltas.set(id,(deltas.get(id)||0)+(name==='credits'?amount:-amount));
      }
      if(deltas.size||invalid.size)parts.push('<h4>Firma bakiyesi: önce → sonra</h4><ul>'+nativeAccounts.filter(a=>deltas.has(a.id)||invalid.has(a.id)).map(a=>{
        const next=a.balance+(deltas.get(a.id)||0),valid=Number.isSafeInteger(a.balance)&&Number.isSafeInteger(next)&&Math.abs(next)<=1e12&&!invalid.has(a.id);
        const label=n=>(n<0?'Borcumuz ':n>0?'Alacağımız ':'Bakiyesi sıfır ')+context.format(Math.abs(n),a.unit);
        return '<li>'+esc(unitLabel(a.unit)+' · '+(Number.isSafeInteger(a.balance)?label(a.balance):'Belirtilmedi')+' → '+(valid?label(next):'Eksik / geçersiz'))+'</li>';
      }).join('')+'</ul>');
    }
    target.innerHTML=parts.join('')||'Gerçek miktarları ve anlaşılmış hesap etkilerini girin. Birimler otomatik çevrilmez.';
  }
  if(saved){for(const[name,value]of Object.entries(saved.fields)){if(form.elements[name])form.elements[name].value=value;}for(const[name,rows]of Object.entries(saved.rows))for(const row of rows)groups.get(name)?.add(row);}
  else if(kind==='profile'){for(const name of ['name','phone','taxId','address'])form.elements[name].value=party?.[name]||'';}
  else if(kind==='purchase'){groups.get('items').add();groups.get('charges').add();}
  else if(kind==='payment'){form.elements.direction.value='pay';form.elements.advanceScope.value='general';groups.get('given').add();groups.get('credits').add();}
  for(const select of form.querySelectorAll(receiptSelects))selectionSummary(select);
  for(const details of form.querySelectorAll('details'))if([...details.querySelectorAll('input,textarea')].some(input=>!input.disabled&&input.type!=='checkbox'&&input.value.trim()))details.open=true;
  if(kind==='unit'){const configureUnit=()=>{const other=form.elements.unit.value==='other';form.elements.currencyCode.closest('label').hidden=!other;form.elements.currencyCode.required=other;};form.elements.unit.addEventListener('change',configureUnit);configureUnit();}
  if(kind==='payment'){form.elements.advanceScope.addEventListener('change',scope);form.elements.direction.addEventListener('change',()=>{for(const group of groups.values())for(const row of group.rows())row.remove();const names=form.elements.direction.value==='collect'?['received','debts']:['given','credits'];for(const name of names)groups.get(name).add();scope();remember();preview();info('İşlem yönü değiştirildi; önceki karşılık satırları temizlendi.');});scope();}
  paymentLayout();
  if(kind==='payment')form.elements.direction.addEventListener('change',()=>{form.elements.agreementId.value='';form.elements.advanceScope.value='general';sourcePicker?.reset();paymentLayout();scope();dirty=true;remember();preview();});
  if(['purchase','payment'].includes(kind)&&context.request)sourcePicker=attachSupplierSources(form,context,saved?.links||[]);
  if(kind==='purchase'&&context.request)receiptPicker=attachSupplierSources(form,{...context,kind:'payment',sourcePurpose:'receipt'},saved?.debtLinks||[]);
  form.addEventListener('input',event=>{event.target.setCustomValidity?.('');status.textContent='';completed=false;dirty=true;remember();preview();});form.addEventListener('change',event=>{event.target.setCustomValidity?.('');status.textContent='';completed=false;dirty=true;remember();preview();});preview();
  form.addEventListener('invalid',event=>{revealInput(event.target);if(event.target.closest('[data-group="credits"],[data-group="debts"]'))paymentIssue(true);},true);
  form.addEventListener('supplier-sources-ready',preview);
  save.addEventListener('click',event=>{if(!form.querySelector('[data-group="items"] :invalid,[data-group="charges"] :invalid')&&paymentIssue(true))event.preventDefault();});
  if(stale())info('Defter veya iş günü değişti. Güncel hesapları ve kaynakları kontrol edin.');
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(sending||context.isPending?.())return;
    dirty=true;remember();if(stale()){info('Defter veya iş günü değişti. Güncel bilgileri kontrol edin.');return;}
    if(paymentIssue(true))return;
    if(context.parseAmount)for(const group of groups.values())for(const row of group.rows()){const a=[...catalog,...nativeAccounts].find(a=>a.id===row.querySelector('[data-field="accountId"]').value);if(a)context.parseAmount(row.querySelector('[data-field="quantity"]'),a.unit,true);for(const[field,unit]of [['weight','GRAM'],['referenceTL','TL']]){const input=row.querySelector('[data-field="'+field+'"]');if(input&&!input.disabled&&input.value.trim())context.parseAmount(input,unit,field!=='referenceTL');}}
    if(!form.reportValidity())return;
    const data=values(),command={type:{create:'supplierFirm',profile:'supplierFirmUpdate',reverse:'supplierReverse',unit:'supplierUnit',purchase:'supplierPurchase',payment:'supplierPayment'}[kind],date:state.date};
    if(kind==='reverse'){command.originalId=data.fields.originalId;command.note=data.fields.note.trim();}
    else if(kind==='profile'){command.supplierId=partyId;for(const k of ['name','phone','taxId','address'])command[k]=data.fields[k].trim();}
    else if(kind==='create'){for(const k of ['name','phone','taxId','address'])if(data.fields[k]?.trim())command[k]=data.fields[k].trim();}
    else if(kind==='unit'){command.supplierId=partyId;command.unit=data.fields.unit==='other'?data.fields.currencyCode.trim().toUpperCase():data.fields.unit;if(!/^[A-Z]{3}$/.test(command.unit)&&command.unit!=='TL'&&command.unit!=='SILVER'||command.unit==='TRY'){info('Döviz için üç harfli kod, Türk lirası için TL seçin.');return;}}
    else {
      if(!nativeAccounts.length){info('Önce firma hesabı için birim ekleyin.');return;}command.supplierId=partyId;
      for(const[name,rows]of Object.entries(data.rows))if(rows.length)command[name]=rows.map(row=>Object.fromEntries(Object.entries(row).filter(([,v])=>v.trim()!=='')));
      if(kind==='purchase'&&(!command.items?.length||!command.charges?.length)){info('Alınan ürün ve anlaşılmış alış borcu gerekli.');return;}
      if(kind==='payment'&&(!command.given?.length&&!command.received?.length||!command.credits?.length&&!command.debts?.length)){info('Gerçek karşılık ve anlaşılmış firma hesabı etkisi gerekli.');return;}
      if(data.fields.referenceTL?.trim()){if(context.parseAmount&&context.parseAmount(form.elements.referenceTL,'TL',false)===null){info('Geçerli TL referansı girin.');return;}command.referenceTL=data.fields.referenceTL.trim();}
      for(const k of ['note','agreementId'])if(data.fields[k]?.trim())command[k]=data.fields[k].trim();
      const links=sourcePicker?.read();if(links?.error){info(links.error);return;}if(links?.rows.length)command[kind==='purchase'?'allocations':'debtUses']=links.rows;
      const receipts=receiptPicker?.read();if(receipts?.error){info(receipts.error);return;}if(receipts?.rows.length)command.debtUses=receipts.rows;
      if(kind==='payment')command.advanceScope=data.fields.direction==='collect'?'general':data.fields.advanceScope;
    }
    sending=true;save.disabled=true;
    try{if(await context.submit(saved?.amend?{type:'supplierAmend',date:state.date,originalId:saved.amend.originalId,note:data.fields.amendNote.trim(),replacement:command}:command,'Toptancı işlemi kaydedildi.',{supplierDraftKey:key})){completed=true;drafts.delete(key);if(form.isConnected){const message=doc.createElement('p');message.setAttribute('role','status');message.textContent='Kayıt tamamlandı.';form.replaceWith(message);}}}
    catch(error){if(form.isConnected)info(error.message||'İşlem kaydedilemedi. Taslak korunuyor.');}
    finally{sending=false;if(form.isConnected)save.disabled=false;}
  });
  return completedDraftKey=>{if(destroyed)return;destroyed=true;if(completedDraftKey===key)completed=true;if(!sending)remember();sourcePicker?.destroy();receiptPicker?.destroy();};
}


function renderSupplierRead(panel, context) {
  const {escape:esc,format,day,state,partyId,kind}=context;
  let disposed=false,generation=0,snapshot=null,printing=false;
  const doc=panel.ownerDocument,scope={supplierId:partyId,startDate:'',endDate:'',limit:50,documents:'omit'},revision=state.revision;
  panel.insertAdjacentHTML('beforeend','<form data-supplier-period class="form-grid"><label class="field"><span>Başlangıç tarihi</span><input type="date" name="startDate"></label><label class="field"><span>Bitiş tarihi</span><input type="date" name="endDate"></label><button class="button secondary">Dönemi göster</button></form><p role="status" data-supplier-read-status></p><div data-supplier-read-result></div><button type="button" class="button secondary" data-supplier-more hidden>Daha eski hareketleri göster</button><button type="button" class="button" data-supplier-print disabled>Yazdır</button><button type="button" class="button secondary" data-supplier-pdf disabled>PDF indir</button><button type="button" class="button secondary" data-supplier-csv disabled>CSV indir</button>');
  const form=panel.querySelector('[data-supplier-period]'),status=panel.querySelector('[data-supplier-read-status]'),result=panel.querySelector('[data-supplier-read-result]'),more=panel.querySelector('[data-supplier-more]'),print=panel.querySelector('[data-supplier-print]'),csv=panel.querySelector('[data-supplier-csv]'),pdf=panel.querySelector('[data-supplier-pdf]');
  const current=ticket=>!disposed&&panel.isConnected&&ticket===generation;
  const signature=page=>JSON.stringify([page.revision,page.supplier?.id,page.accounts,page.statements,page.startDate,page.endDate,page.total]);
  const signed=(n,unit)=>Number.isSafeInteger(n)?(n<0?'−':n>0?'+':'')+format(Math.abs(n),unit):'Belirtilmedi';
  function validate(page,baseline){
    if(page.revision!==revision||page.supplier?.id!==partyId||!Array.isArray(page.events)||!Array.isArray(page.statements)||!Number.isSafeInteger(page.total)||page.total<0||page.startDate!==scope.startDate||page.endDate!==scope.endDate)throw Error('Defter veya dönem değişti. Yeniden yükleyin.');
    if(baseline&&signature(page)!==signature(baseline))throw Error('Ekstre sayfaları birlikte doğrulanamadı.');
  }
  async function fetchPage(cursor){const page=await context.request('suppliers',undefined,context.workspace,{query:{...scope,...(cursor?{cursor}:{})}});validate(page);return page;}
  function eventsMarkup(events,interactive=false){
    return events.map(event=>{
      const meta=event.meta||{},account=id=>(state.accounts||[]).find(a=>a.id===id);
      const rows=(title,lines)=>!lines?.length?'':'<h4>'+title+'</h4><ul>'+lines.map(line=>{const a=account(line.accountId),unit=line.unit||a?.unit;return '<li>'+esc((a?.name||'Hesap')+' · '+(unit?format(line.quantity,unit):'Birim belirtilmedi')+(line.weight?' · '+format(line.weight,'GRAM'):'')+(Number.isSafeInteger(line.referenceTL)?' · TL referansı '+format(line.referenceTL,'TL'):''))+'</li>';}).join('')+'</ul>';
      const statusLabel={active:'Aktif',reversed:'İptal edildi',amended:'Düzeltildi'}[event.status]||'Kayıt durumu bu görünümde belirtilmedi';
      return '<article class="section" data-supplier-event="'+esc(event.id)+'"><h3>'+esc(day(event.date)+' · '+event.label)+'</h3><p>'+esc(statusLabel)+'</p><details><summary>Fiş ayrıntısı</summary>'+
        rows(event.type==='supplierReturn'?'Firmaya iade edilen ürünler':'Alınan ürünler',meta.lines)+rows('Verilen karşılıklar',meta.givenLines)+rows('Alınan karşılıklar',meta.receivedLines)+rows(event.type==='supplierReturn'?'İade sonrası kalan borç':'Anlaşılmış alış / hesap borcu',meta.chargeLines)+rows('Anlaşılmış cari alacak',meta.creditLines)+rows('Tahsilatın cari borç etkisi',meta.debtLines)+rows('Kaynak alış belgesinden düşülen',meta.reductions)+rows('Mahsupta kullanılan alacak',meta.from?[meta.from]:[])+rows('Mahsupla azalan borç',meta.to?[meta.to]:[])+
        '<p>TL referansı: '+(Number.isSafeInteger(meta.referenceTL)?esc(format(meta.referenceTL,'TL')):'Belirtilmedi')+'</p>'+
        (meta.note?'<p>'+esc(meta.note)+'</p>':'')+
        ([...(meta.allocations||[]),...(meta.sourceUses||[]),...(meta.debtUses||[]),...(meta.uses||[])].length?'<h4>Açık kaynak bağlantıları</h4><ul>'+[...(meta.allocations||[]),...(meta.sourceUses||[]),...(meta.debtUses||[]),...(meta.uses||[])].map(link=>{const linked=snapshot?.events.find(e=>e.id===link.sourceId);return '<li>'+esc((linked?day(linked.date)+' · '+linked.label:'Kaynak kayıt: '+(link.sourceId||event.id))+((link.unit||account(link.accountId)?.unit)&&Number.isSafeInteger(link.quantity)?' · '+format(link.quantity,link.unit||account(link.accountId).unit):'')+(link.purchaseId?' · Bağlanan belge: '+(snapshot?.events.find(e=>e.id===link.purchaseId)?.label||link.purchaseId):'')+(link.reason?' · '+link.reason:''))+'</li>';}).join('')+'</ul>':'')+
        (event.relatedEventIds?.length?'<details><summary>Bağlı kayıtlar</summary><ul>'+event.relatedEventIds.map(id=>{const linked=snapshot?.events.find(e=>e.id===id);return '<li>'+esc(linked?day(linked.date)+' · '+linked.label:id)+'</li>';}).join('')+'</ul></details>':'')+
        '<ul>'+(event.balances||[]).map(row=>'<li>'+esc(unitLabel(row.unit)+' · '+signed(row.before,row.unit)+' → '+signed(row.after,row.unit)+' · Etki '+signed(row.delta,row.unit))+'</li>').join('')+'</ul>'+
        (interactive&&event.status==='active'&&['supplierPurchase','supplierPayment','supplierAllocation','supplierOffset','supplierReturn','supplierLegacyReceiptLink'].includes(event.type)?'<button type="button" class="button secondary" data-reverse-supplier-event="'+esc(event.id)+'">Ters kayıtla iptal et</button>'+(['supplierPurchase','supplierPayment','supplierAllocation','supplierOffset','supplierReturn'].includes(event.type)&&(event.editableCommand||event.meta?.editableCommand)?'<button type="button" class="button secondary" data-edit-supplier-event="'+esc(event.id)+'">İşlemi düzelt</button>':''):'')+'<p>Kaydeden: '+esc(event.actor?.displayName||event.actor?.name||'Belirtilmedi')+'</p></details><details><summary>Teknik kayıt bilgileri</summary><p>'+esc(event.id)+'</p></details></article>';
    }).join('')||'<p>Seçilen dönemde hareket yok.</p>';
  }
  function totalsMarkup(page){
    return '<h3>Birim bazlı dönem ekstresi</h3><div class="table-wrap"><table><thead><tr>'+['Birim','Dönem başı','Borç artışı','Borç azalışı','Alacak artışı','Alacak azalışı','Dönem sonu'].map(x=>'<th>'+x+'</th>').join('')+'</tr></thead><tbody>'+page.statements.map(row=>'<tr><th>'+esc(unitLabel(row.unit))+'</th>'+['opening','debtIncrease','debtDecrease','creditIncrease','creditDecrease','closing'].map(k=>'<td>'+esc(signed(row[k],row.unit))+'</td>').join('')+'</tr>').join('')+'</tbody></table></div><p>Her birim bağımsızdır. Dönem bakiyesi güncel bakiye yerine geçmez.</p>';
  }
  function reconciliation(){
    const form=panel.querySelector('[data-reconcile-form]');if(!form)return '';
    const row=snapshot.statements.find(row=>row.accountId===form.elements.accountId.value),target=panel.querySelector('[data-reconcile-result]');
    if(!row||!form.elements.amount.value.trim()){target.textContent='Harici ekstre tutarını ve yönünü girin.';return '';}
    const amount=context.parseAmount?.(form.elements.amount,row.unit,false);
    if(amount===null||amount===undefined){target.textContent='Geçerli tutarı girin.';return '';}
    const external=amount*(form.elements.sign.value==='debt'?-1:1),difference=row.closing-external;
    const text='Defter dönem sonu: '+signed(row.closing,row.unit)+' · Harici ekstre: '+signed(external,row.unit)+' · Fark (defter − harici): '+signed(difference,row.unit);
    target.textContent=text;
    return '<section><h3>Mutabakat karşılaştırması</h3><p>'+esc(form.elements.reference.value)+' · '+esc(form.elements.date.value)+'</p><p>'+esc(text)+'</p><p>Bu karşılaştırma deftere hareket yazmaz.</p></section>';
  }
  function paint(){
    result.innerHTML='<p>Dönem: '+esc(scope.startDate||'Başlangıçtan')+' — '+esc(scope.endDate||'Son kayda kadar')+' · '+snapshot.events.length+' / '+snapshot.total+' hareket</p>'+
      (kind==='statement'?totalsMarkup(snapshot):'')+'<div data-supplier-events>'+eventsMarkup(snapshot.events,true)+'</div>';
    if(kind==='statement')result.insertAdjacentHTML('beforeend','<details><summary>Harici ekstre ile karşılaştır</summary><p>ER ŞAT bakışından: negatif borcumuz, pozitif alacağımız. Birimler otomatik çevrilmez.</p><form data-reconcile-form class="form-grid"><label class="field"><span>Harici belge numarası</span><input name="reference" maxlength="100"></label><label class="field"><span>Harici ekstre tarihi</span><input type="date" name="date"></label><label class="field"><span>Birim</span><select name="accountId">'+snapshot.statements.map(row=>'<option value="'+esc(row.accountId)+'">'+esc(unitLabel(row.unit))+'</option>').join('')+'</select></label><label class="field"><span>ER ŞAT hesabının yönü</span><select name="sign"><option value="debt">Borcumuz (−)</option><option value="credit">Alacağımız (+)</option></select></label><label class="field"><span>Harici ekstre miktarı</span><input name="amount" inputmode="decimal" maxlength="24"></label><p data-reconcile-result role="status">Harici ekstre tutarını ve yönünü girin.</p></form></details>');
    const compare=panel.querySelector('[data-reconcile-form]');compare?.addEventListener('submit',e=>e.preventDefault());compare?.addEventListener('input',reconciliation);compare?.addEventListener('change',reconciliation);
    more.hidden=!snapshot.nextCursor;more.disabled=false;print.disabled=!context.printReport;csv.disabled=false;pdf.disabled=!context.exportPdf;status.textContent='Seçilen dönem yüklendi. Yazdırma ve indirmeler dönemin tamamını doğrular.';
  }
  async function load(append=false){
    const ticket=++generation;more.disabled=true;print.disabled=true;csv.disabled=true;pdf.disabled=true;status.textContent='Firma kayıtları yükleniyor…';
    if(!append){snapshot=null;result.replaceChildren();}
    try{
      const page=await fetchPage(append?snapshot.nextCursor:undefined);if(!current(ticket))return;
      if(append){validate(page,snapshot);const ids=new Set(snapshot.events.map(e=>e.id));for(const event of page.events){if(ids.has(event.id))throw Error('Hareket sayfası tekrar ediyor.');ids.add(event.id);}snapshot={...page,events:[...snapshot.events,...page.events]};}
      else snapshot=page;
      paint();
    }catch(error){if(current(ticket)){snapshot=null;result.replaceChildren();more.hidden=true;status.textContent=error.message;}}
  }
  result.addEventListener('click',event=>{const button=event.target.closest('[data-reverse-supplier-event],[data-edit-supplier-event]');if(!button||context.isPending?.())return;const record=snapshot?.events.find(e=>e.id===(button.dataset.reverseSupplierEvent||button.dataset.editSupplierEvent));if(record)context.onRecordAction?.(record,button.hasAttribute('data-reverse-supplier-event')?'reverse':'edit');});
  form.addEventListener('submit',e=>{e.preventDefault();if(printing)return;scope.startDate=form.elements.startDate.value;scope.endDate=form.elements.endDate.value;load();});
  more.addEventListener('click',()=>{if(snapshot?.nextCursor&&!printing)load(true);});
  async function collectExportSnapshot(ticket){
    const first=await fetchPage(),seen=new Set(),cursors=new Set(),events=[];
    let page=first;
    while(true){
      if(!current(ticket))return null;validate(page,first);
      for(const event of page.events){if(seen.has(event.id))throw Error('Çıktıda kayıt tekrarı doğrulanamadı.');seen.add(event.id);events.push(event);}
      if(!page.nextCursor)break;
      if(cursors.has(page.nextCursor)||!page.events.length)throw Error('Çıktı sayfaları tekrar ediyor.');
      cursors.add(page.nextCursor);page=await fetchPage(page.nextCursor);
    }
    if(events.length!==first.total)throw Error('Çıktının tamamı doğrulanamadı.');
    validate(await fetchPage(),first);if(!current(ticket))return null;
    const sums=new Map();for(const event of events)for(const row of event.balances||[]){if(!Number.isSafeInteger(row.delta))throw Error('Hareket tutarı doğrulanamadı.');sums.set(row.accountId,(sums.get(row.accountId)||0)+row.delta);}
    for(const row of first.statements){if(!['opening','closing','debtIncrease','debtDecrease','creditIncrease','creditDecrease'].every(key=>Number.isSafeInteger(row[key]))||row.opening+(sums.get(row.accountId)||0)!==row.closing||row.opening-row.debtIncrease+row.debtDecrease+row.creditIncrease-row.creditDecrease!==row.closing)throw Error('Özet ve hareket tutarları birlikte doğrulanamadı.');sums.delete(row.accountId);}if(sums.size)throw Error('Hareket hesabının özeti bulunamadı.');
    const output={page:first,events,scope:{...scope},revision,kind,catalog:(state.accounts||[]).map(({id,name,unit})=>({id,name,unit}))};
    const compare=panel.querySelector('[data-reconcile-form]');if(compare?.elements.amount.value.trim()){const statement=first.statements.find(r=>r.accountId===compare.elements.accountId.value),amount=statement&&context.parseAmount?.(compare.elements.amount,statement.unit,false);if(!Number.isSafeInteger(amount)||amount<0)throw Error('Mutabakat miktarını düzeltin veya temizleyin.');const external=amount*(compare.elements.sign.value==='debt'?-1:1);output.reconciliation={reference:compare.elements.reference.value,date:compare.elements.date.value,accountId:statement.accountId,unit:statement.unit,external,closing:statement.closing,difference:statement.closing-external};}
    return output;
  }
  function csvDocument(output){
    const {page,events}=output,catalog=new Map([...output.catalog,...page.accounts].map(a=>[a.id,a]));
    const headings=['Satır türü','Firma ID','Firma','Dönem başlangıcı','Dönem bitişi','Sürüm','Toplam hareket','Kayıt ID','Tarih','İşlem türü','Durum','Açıklama','Not','Hesap ID','Hesap','Birim','Miktar (alt birim)','Görünen miktar','Önce (alt birim)','Etki (alt birim)','Sonra (alt birim)','Dönem başı (alt birim)','Borç artışı (alt birim)','Borç azalışı (alt birim)','Alacak artışı (alt birim)','Alacak azalışı (alt birim)','Dönem sonu (alt birim)','Kaynak ID','Bağlanan belge ID','Bağlı kayıtlar','Gram hesabı ID','Gram (alt birim)','TL referansı (alt birim)','Kaydeden','Anlaşma ID','Avans kapsamı','Ayrılmış kaynak kullanım onayı','Kullanım gerekçesi'];
    const rows=[headings],append=(type,event={},line={},summary={})=>{const account=catalog.get(line.accountId),unit=line.unit||account?.unit||'',quantity=line.quantity;rows.push([type,page.supplier.id,page.supplier.name,output.scope.startDate,output.scope.endDate,output.revision,events.length,event.id,event.date,event.type,event.status,event.label,event.meta?.note,line.accountId,account?.name,unit,quantity,Number.isSafeInteger(quantity)&&unit?format(quantity,unit):'',line.before,line.delta,line.after,summary.opening,summary.debtIncrease,summary.debtDecrease,summary.creditIncrease,summary.creditDecrease,summary.closing,line.sourceId,line.purchaseId,(event.relatedEventIds||[]).join(' | '),line.weightAccount,line.weight,line.referenceTL??event.meta?.referenceTL,event.actor?.displayName||event.actor?.name,event.meta?.agreementId,event.meta?.advanceScope,line.overrideReserved,line.reason]);};
    for(const summary of page.statements)append('Özet',{},summary,summary);
    for(const event of events){append('Hareket',event);for(const balance of event.balances||[])append('Hesap etkisi',event,balance);const meta=event.meta||{};
      for(const[key,label]of [['lines',event.type==='supplierReturn'?'Firmaya iade edilen ürün':'Alınan ürün'],['givenLines','Verilen karşılık'],['receivedLines','Alınan karşılık'],['chargeLines',event.type==='supplierReturn'?'İade sonrası kalan borç':'Anlaşılan borç'],['creditLines','Cari alacak'],['debtLines','Tahsilat cari etkisi'],['reductions','Belgeden düşüm'],['allocations','Tahsis'],['sourceUses','Mahsup kaynağı'],['debtUses','Tahsilat kaynağı'],['uses','Eski tahsilat eşleştirmesi']])for(const line of meta[key]||[])append(label,event,line);
      if(meta.from)append('Mahsup kaynak birimi',event,meta.from);if(meta.to)append('Mahsup hedef birimi',event,meta.to);
    }
    if(output.reconciliation){const r=output.reconciliation;append('Mutabakat', {date:r.date,label:r.reference,meta:{note:'Önce: harici bakiye; etki: defter eksi harici; sonra: defter dönem sonu'}},{accountId:r.accountId,unit:r.unit,before:r.external,delta:r.difference,after:r.closing});}
    const cell=value=>{let text=String(value??'');if(/^[\s\u0000-\u001f\u007f]*[=+@\-]/.test(text))text="'"+text;return '"'+text.replace(/"/g,'""')+'"';};
    return '\uFEFF'+rows.map(row=>row.map(cell).join(';')).join('\r\n');
  }
  async function exportReport(mode){
    if(printing||!snapshot||mode==='print'&&!context.printReport||mode==='pdf'&&!context.exportPdf)return;
    const ticket=++generation;printing=true;for(const button of [print,csv,pdf,more])button.disabled=true;status.textContent='Çıktı için bütün kayıtlar doğrulanıyor…';
    try{
      const output=await collectExportSnapshot(ticket);if(!output||!current(ticket))return;
      if(mode==='csv'){const url=doc.defaultView.URL.createObjectURL(new doc.defaultView.Blob([csvDocument(output)],{type:'text/csv;charset=utf-8'}));try{const link=doc.createElement('a');link.href=url;link.download='toptanci-ekstresi-'+(state.date||'donem')+'.csv';link.click();}finally{doc.defaultView.URL.revokeObjectURL(url);}status.textContent='Tam dönem CSV dosyası hazır.';}
      else if(mode==='pdf'){status.textContent='Tam dönem PDF dosyası hazırlanıyor…';await context.exportPdf(output);if(current(ticket))status.textContent='Tam dönem PDF dosyası hazır.';}
      else{const markup='<header><h1>'+esc(output.page.supplier.name)+' · '+(kind==='statement'?'Ekstre':'Hareket geçmişi')+'</h1><p>Dönem: '+esc(scope.startDate||'Başlangıçtan')+' — '+esc(scope.endDate||'Son kayda kadar')+' · '+output.events.length+' hareket · Sürüm '+revision+'</p></header>'+totalsMarkup(output.page)+reconciliation()+eventsMarkup(output.events);status.textContent='Tam dönem çıktısı hazır.';context.printReport(markup);}
    }catch(error){if(current(ticket))status.textContent=error.message;}
    finally{printing=false;if(current(ticket)){print.disabled=!context.printReport;pdf.disabled=!context.exportPdf;csv.disabled=false;more.disabled=false;}}
  }
  print.addEventListener('click',()=>exportReport('print'));csv.addEventListener('click',()=>exportReport('csv'));pdf.addEventListener('click',()=>exportReport('pdf'));
  load();return()=>{disposed=true;generation++;};
}


function attachSupplierSources(form, context, saved=[]) {
  const {escape:esc,format,day,state,partyId,kind}=context,doc=form.ownerDocument;
  const section=doc.createElement('details');section.dataset.supplierSources=context.sourcePurpose||kind;
  section.innerHTML='<summary>'+(kind==='purchase'?'Önceki ödeme / avansı bu alışa bağla':kind==='allocation'?'Ödeme / avans ve alış seçimi':kind==='offset'?'Mahsupta kullanılacak alacağın kaynağı':'Geri alınan avansın kaynağı')+'</summary><p>Kullanılacak ödeme / avansı ve miktarı seçin.</p><p role="status" data-source-status>Kaynaklar yükleniyor…</p><div data-source-rows></div><button type="button" class="button secondary" data-add-source>Kaynak ekle</button><button type="button" class="button text" data-reload-sources>Kaynakları yenile</button>';
  if(['allocation','offset'].includes(kind)){section.open=true;const save=[...form.children].find(node=>node.tagName==='BUTTON'&&node.type==='submit');form.insertBefore(section,save||null);}else form.append(section);
  const host=section.querySelector('[data-source-rows]'),status=section.querySelector('[data-source-status]');
  let disposed=false,generation=0,choices=[],persistedChoices=[],targets=[],loaded=false;
  const rows=()=>[...host.children];
  const snapshot=()=>rows().map(row=>Object.fromEntries([...row.querySelectorAll('[data-source-field]')].map(input=>[input.dataset.sourceField,input.type==='checkbox'?input.checked:input.value])));
  function updateCurrentSources(){
    choices=[...persistedChoices];
    if(!['purchase','payment'].includes(kind)||!context.parseAmount)return;
    const amounts=new Map(),native=state.supplierParties?.find(p=>p.id===partyId)?.accounts||[];
    for(const row of form.querySelectorAll('[data-group="credits"] [data-row]')){const accountId=row.querySelector('[data-field="accountId"]').value,account=native.find(a=>a.id===accountId),input=row.querySelector('[data-field="quantity"]');if(!account||!input.value.trim())continue;const amount=context.parseAmount(input,account.unit,true);if(Number.isSafeInteger(amount)&&amount>0)amounts.set(accountId,(amounts.get(accountId)||0)+amount);}
    for(const[accountId,remaining]of amounts){const account=native.find(a=>a.id===accountId);choices.push({source:{id:'',kind:'current',date:state.date,advanceScope:form.elements.advanceScope?.value||'general',agreementId:form.elements.agreementId?.value.trim()||''},line:{accountId,unit:account.unit,remaining}});}
  }
  function sourceStatus(){status.textContent=choices.some(c=>c.source.kind==='current')?'Bu işlemdeki ödeme kaynak olarak seçilebilir. Önceki kaynaklar varsa ayrıca listelenir.':choices.length?'Önceki ödeme / avansların kullanılabilir tutarları gösteriliyor.':'Kullanılabilir ödeme / avans kaynağı yok.';}
  function refreshOptions(){if(!loaded)return;updateCurrentSources();sourceStatus();for(const row of rows()){const select=row.querySelector('select');options(select,select.value);configure(row);}}
  function refreshCurrent(event){if(section.contains(event.target)||!event.target.closest('[data-group="credits"]')&&!['agreementId','advanceScope'].includes(event.target.name))return;refreshOptions();}
  form.addEventListener('input',refreshCurrent);form.addEventListener('change',refreshCurrent);
  function options(select,old){select.innerHTML='<option value="">Ödeme / avans seçin</option>'+choices.map(({source,line})=>'<option value="'+esc(JSON.stringify([source.id,line.accountId]))+'">'+esc(day(source.date)+' · '+(source.kind==='current'?'Bu işlemde verdiğimiz karşılık':source.kind==='supplierReturn'?'İade alacağı':'Ödeme / avans')+' · '+unitLabel(line.unit)+' · Kullanılabilir '+format(line.remaining,line.unit)+(source.agreementId?' · '+source.agreementId:'')+receiptSuffix(source,choices.map(c=>c.source)))+'</option>').join('');select.value=old||'';}
  function configure(row){
    const selected=choices.find(c=>JSON.stringify([c.source.id,c.line.accountId])===row.querySelector('select').value),approval=row.querySelector('[data-source-field="overrideReserved"]'),reason=row.querySelector('[data-source-field="reason"]');
    const targetSelect=row.querySelector('[data-source-field="purchase"]');
    if(targetSelect){const old=targetSelect.value;targetSelect.innerHTML='<option value="">Alış / açık belge seçin</option>'+targets.filter(t=>t.line.accountId===selected?.line.accountId).map(t=>'<option value="'+esc(JSON.stringify([t.purchase.id,t.line.accountId]))+'">'+esc(day(t.purchase.date)+' · '+(t.purchase.kind==='supplierReturn'?'İade sonrası kalan borç':'Açık alış / borç')+' · '+format(t.line.remaining,t.line.unit)+(t.purchase.agreementId?' · '+t.purchase.agreementId:'')+receiptSuffix(t.purchase,targets.map(t=>t.purchase)))+'</option>').join('');targetSelect.value=old;}
    const target=targets.find(t=>JSON.stringify([t.purchase.id,t.line.accountId])===targetSelect?.value);
    const currentAgreement=kind==='allocation'?(target?.purchase.agreementId||''):(form.elements.agreementId?.value.trim()||''),reserved=selected?.source.advanceScope==='reserved'&&(selected.source.agreementId||'')!==currentAgreement;
    row.querySelector('[data-source-override]').hidden=!reserved;approval.required=reserved;reason.required=reserved;reason.disabled=!reserved;if(!reserved){approval.checked=false;reason.value='';}
    row.querySelector('[data-source-id]').textContent=selected?selected.source.id+' · '+selected.line.accountId:'Kaynak seçilmedi';selectionSummary(row.querySelector('select'));selectionSummary(targetSelect);
  }
  function add(values={}){
    if(rows().length>=30)return;
    const row=doc.createElement('div');row.className='form-grid';
    row.innerHTML='<label class="field"><span>Kaynak ödeme / avans</span><select data-source-field="choice" required></select></label><label class="field"><span>Kullanılacak miktar · kaynağın biriminde</span><input data-source-field="quantity" inputmode="decimal" maxlength="24" required></label><div data-source-override hidden><label><input type="checkbox" data-source-field="overrideReserved">Bu kullanım için başka anlaşmaya ayrılmış tutarı kullanmayı onaylıyorum.</label><label class="field"><span>Bu kullanımın gerekçesi</span><input data-source-field="reason" maxlength="300"></label></div><details><summary>Teknik kayıt bilgileri</summary><p data-source-id></p></details><button type="button" class="button text" data-remove-source>Kaynağı kaldır</button>';
    if(kind==='allocation')row.querySelector('[data-source-override]').insertAdjacentHTML('beforebegin','<label class="field"><span>Bağlanacak alış / açık belge</span><select data-source-field="purchase" required></select></label>');
    host.append(row);options(row.querySelector('select'),values.choice);
    for(const input of row.querySelectorAll('[data-source-field]')){const value=values[input.dataset.sourceField];if(input.type==='checkbox')input.checked=!!value;else if(input.tagName!=='SELECT')input.value=value||'';}
    row.querySelector('select').addEventListener('change',()=>configure(row));
    row.querySelector('[data-source-field="purchase"]')?.addEventListener('change',()=>configure(row));
    row.querySelector('[data-remove-source]').addEventListener('click',()=>{row.remove();form.dispatchEvent(new doc.defaultView.Event('input',{bubbles:true}));});configure(row);if(kind==='allocation'&&values.purchase){row.querySelector('[data-source-field="purchase"]').value=values.purchase;configure(row);}
  }
  async function load(){
    const ticket=++generation;loaded=false;const prior=host.children.length?snapshot():saved;status.textContent='Kaynaklar yükleniyor…';
    try{
      const response=await context.request('suppliers',undefined,context.workspace,{query:{supplierId:partyId,limit:50,...(context.editOriginalId?{editOriginalId:context.editOriginalId}:{})}});
      if(disposed||!form.isConnected||ticket!==generation)return;
      if(response.revision!==state.revision||response.supplier?.id!==partyId||!response.documents)throw Error('Kaynaklar doğrulanamadı. Defteri yenileyin.');
      if(context.editOriginalId){if(response.amendment?.originalId!==context.editOriginalId)throw Error('Düzeltme kaynakları doğrulanamadı.');response.documents=response.amendment.documents;}
      targets=(response.documents.purchases||[]).flatMap(purchase=>purchase.charges.filter(line=>line.remaining>0).map(line=>({purchase,line})));
      persistedChoices=response.documents.sources.flatMap(source=>source.credits.filter(line=>line.remaining>0&&!source.blockedAccounts?.includes(line.accountId)).map(line=>({source,line})));updateCurrentSources();loaded=true;if(response.documents.unresolvedReceipts?.length&&!section.querySelector('[data-supplier-legacy]'))section.insertAdjacentHTML('beforeend','<p>Kaynağı belirtilmemiş eski tahsilatlar var. İlgili eski avanslar kullanılmadan önce kaynakları eşleştirin.</p><button type="button" class="button secondary" data-supplier-legacy>Eski tahsilat kaynaklarını eşleştir</button>');host.replaceChildren();for(const values of prior)add(values);
      sourceStatus();form.dispatchEvent(new doc.defaultView.Event('supplier-sources-ready'));
    }catch(error){if(!disposed&&form.isConnected&&ticket===generation)status.textContent=error.message;}
  }
  section.querySelector('[data-add-source]').addEventListener('click',()=>{add();form.dispatchEvent(new doc.defaultView.Event('input',{bubbles:true}));});
  section.querySelector('[data-reload-sources]').addEventListener('click',load);
  form.elements.agreementId?.addEventListener('input',()=>rows().forEach(configure));
  load();
  return {snapshot,refresh:refreshOptions,reset(){saved=[];host.replaceChildren();load();},read(){
    updateCurrentSources();
    if(rows().length&&!loaded)return {error:'Ödeme / avans kaynakları doğrulanamadı.'};
    const result=[],sourceTotals=new Map(),targetTotals=new Map();
    for(const row of rows()){
      configure(row);const data=Object.fromEntries([...row.querySelectorAll('[data-source-field]')].map(input=>[input.dataset.sourceField,input.type==='checkbox'?input.checked:input.value]));
      if([...row.querySelectorAll('[required]')].some(input=>input.type==='checkbox'?!input.checked:!input.value.trim()))return {error:'Kaynak seçimini, gerekli miktarı ve farklı anlaşma onayı / gerekçesini tamamlayın.'};
      const match=choices.find(c=>JSON.stringify([c.source.id,c.line.accountId])===data.choice),target=targets.find(t=>JSON.stringify([t.purchase.id,t.line.accountId])===data.purchase);if(kind==='allocation'&&(!target||target.line.accountId!==match?.line.accountId))return {error:'Aynı birimde geçerli alış / açık belge seçin.'};if(!match)return {error:'Geçerli ödeme / avans seçin.'};
      if(context.parseAmount){const quantity=context.parseAmount(row.querySelector('[data-source-field="quantity"]'),match.line.unit,true);if(quantity===null||!Number.isSafeInteger(quantity)||quantity<=0)return {error:'Geçerli pozitif kaynak miktarı girin.'};const sourceKey=JSON.stringify([match.source.id,match.line.accountId]),targetKey=target?JSON.stringify([target.purchase.id,target.line.accountId]):'';sourceTotals.set(sourceKey,(sourceTotals.get(sourceKey)||0)+quantity);if(target)targetTotals.set(targetKey,(targetTotals.get(targetKey)||0)+quantity);if(sourceTotals.get(sourceKey)>match.line.remaining||target&&targetTotals.get(targetKey)>target.line.remaining)return {error:'Toplam kullanım kaynakta veya belgede kalan tutarı aşamaz.'};}
      result.push({... (match.source.id?{sourceId:match.source.id}:{}),...(target?{purchaseId:target.purchase.id}:{}),accountId:match.line.accountId,quantity:data.quantity,...(data.overrideReserved?{overrideReserved:true,reason:data.reason}:{})});
    }
    return {rows:result};
  },destroy(){disposed=true;generation++;form.removeEventListener('input',refreshCurrent);form.removeEventListener('change',refreshCurrent);}};
}


async function renderSupplierDocumentTask(panel, context) {
  // Synchronous cleanup handle is installed by the caller; this worker uses a detached guard.
  const {escape:esc,format,day,state,partyId,kind}=context,doc=panel.ownerDocument;
  const revision=state.revision,memory=context.memory||SUPPLIER_DRAFTS,key='supplier:draft:'+JSON.stringify([context.workspace||'default',partyId,kind]),saved=memory.get(key);
  const status=doc.createElement('p');status.setAttribute('role','status');status.textContent='Açık belgeler yükleniyor…';panel.append(status);
  let data;
  try{data=await context.request('suppliers',undefined,context.workspace,{query:{supplierId:partyId,limit:50,...(saved?.amend?{editOriginalId:saved.amend.originalId}:{})}});if(!panel.isConnected||context.isCurrent?.()===false)return ()=>{};if(data.revision!==revision||data.supplier?.id!==partyId||!data.documents)throw Error('Açık belgeler doğrulanamadı. Yeniden açın.');}
  catch(error){if(panel.isConnected)status.textContent=error.message;return ()=>{};}
  if(saved?.amend){if(data.amendment?.originalId!==saved.amend.originalId){status.textContent='Düzeltme önizlemesi doğrulanamadı.';return ()=>{};}context={...context,editOriginalId:saved.amend.originalId};status.textContent='Düzeltme için eski etkinin geri alınmış önizlemesi';}
  const accounts=saved?.amend?data.accounts.map(a=>({...a,balance:data.amendment.balances[a.id]})):data.accounts,catalog=(state.accounts||[]).filter(a=>!a.retired),documents=saved?.amend?data.amendment.documents:data.documents;
  const form=doc.createElement('form');form.dataset.supplierDocumentForm=kind;form.dataset.kind=kind;form.className='supplier-task-form';panel.append(form);
  let sending=false,completed=false,dirty=!!saved,stamp=saved?.stamp||{revision,date:state.date},sourcePicker=null;
  const stale=()=>stamp.revision!==revision||stamp.date!==state.date;
  const field=(name,label,required=false)=>'<label class="field"><span>'+label+'</span><input name="'+name+'" inputmode="decimal" maxlength="300"'+(required?' required':'')+'></label>';
  const select=(name,label,options)=>'<label class="field"><span>'+label+'</span><select name="'+name+'" required><option value="">Seçin</option>'+options.map(([value,label])=>'<option value="'+esc(value)+'">'+esc(label)+'</option>').join('')+'</select></label>';
  const nativeOptions=list=>list.map(a=>[a.id,unitLabel(a.unit)+' · '+(a.balance<0?'Borcumuz ':a.balance>0?'Alacağımız ':'Bakiyesi sıfır ')+format(Math.abs(a.balance),a.unit)]);
  const groups=new Map();
  function lineGroup(name,title,physical=false){
    const fieldset=doc.createElement('fieldset');fieldset.dataset.documentGroup=name;fieldset.innerHTML='<legend>'+title+'</legend><div data-lines></div><button type="button" class="button secondary" data-add-document-line>Satır ekle</button>';form.append(fieldset);
    const host=fieldset.querySelector('[data-lines]'),rows=()=>[...host.children];
    const add=(value={})=>{
      if(rows().length>=30)return;
      const row=doc.createElement('div');row.className='form-grid';const choices=physical?catalog.filter(a=>a.kind==='asset'&&a.id!=='pos'):accounts;
      row.innerHTML='<label class="field"><span>'+ (physical?'Alınan ürün / kasa / banka':'Firma hesabı') +'</span><select data-field="accountId" required><option value="">Seçin</option>'+choices.map(a=>'<option value="'+esc(a.id)+'">'+esc((a.name||unitLabel(a.unit))+' · '+unitLabel(a.unit))+'</option>').join('')+'</select></label><label class="field"><span>Miktar</span><input data-field="quantity" required inputmode="decimal" maxlength="24"></label>'+
        (physical?'<label class="field" data-weight-label hidden><span>Ayar / terazi</span><select data-field="weightAccount"></select></label><label class="field" data-weight-value hidden><span>Gerçek toplam gram</span><input data-field="weight" inputmode="decimal" maxlength="24"></label>':'')+
        '<details><summary>TL referansı · isteğe bağlı</summary><label class="field"><span>Anlaşılmış TL referansı</span><input data-field="referenceTL" inputmode="decimal" maxlength="24"></label></details><button type="button" class="button text" data-remove-document-line>Satırı kaldır</button>';
      const account=row.querySelector('select');
      const configure=()=>{if(!physical)return;const a=choices.find(a=>a.id===account.value),ids=a?.pairedGroups||[],group=row.querySelector('[data-field="weightAccount"]'),weight=row.querySelector('[data-field="weight"]');group.innerHTML=ids.map(id=>'<option value="'+esc(id)+'">'+esc(catalog.find(a=>a.id===id)?.name||id)+'</option>').join('');group.disabled=weight.disabled=!ids.length;group.required=weight.required=!!ids.length;row.querySelector('[data-weight-label]').hidden=row.querySelector('[data-weight-value]').hidden=!ids.length;};
      host.append(row);account.value=value.accountId||'';configure();for(const[k,v]of Object.entries(value)){const input=row.querySelector('[data-field="'+k+'"]');if(input&&!input.disabled)input.value=v;}
      account.addEventListener('change',configure);row.querySelector('[data-remove-document-line]').addEventListener('click',()=>{row.remove();dirty=true;remember();});
    };
    fieldset.querySelector('[data-add-document-line]').addEventListener('click',()=>{add();dirty=true;remember();});groups.set(name,{rows,add});
  }
  const refundable=documents.purchases.filter(p=>['purchase','supplierPurchase'].includes(p.kind)&&p.lines.some(line=>line.remainingQuantity>0));
  if(kind==='allocation')form.innerHTML='<p>Ödeme ile alış aynı birimde bağlanır. Bu işlem kasa, stok veya cari bakiyeyi yeniden değiştirmez.</p>';
  if(kind==='legacyLink')form.innerHTML=select('originalId','Kaynağı belirlenecek eski tahsilat',(documents.unresolvedReceipts||[]).map(receipt=>[receipt.id,day(receipt.date)+' · '+receipt.debts.map(row=>format(row.quantity,row.unit)).join(' / ')+receiptSuffix(receipt,documents.unresolvedReceipts)]))+'<p>Bu işlem yalnız eski tahsilatı ödeme kaynaklarına bağlar. Kasa, stok ve cari bakiyeler değişmez. Her birimin tahsil edilen tutarı tam olarak eşleştirilmelidir.</p><div data-legacy-amounts></div><fieldset><legend>Önceki ödeme kaynakları</legend><div data-legacy-rows></div><button type="button" class="button secondary" data-add-legacy-source>Kaynak ekle</button></fieldset>';
  if(kind==='offset')form.innerHTML=select('fromAccountId','Kullanılacak alacak birimi',nativeOptions(accounts.filter(a=>a.balance>0)))+field('fromQuantity','Kullanılacak alacak miktarı',true)+select('toAccountId','Azaltılacak borç birimi',nativeOptions(accounts.filter(a=>a.balance<0)))+field('toQuantity','Kapatılacak borç miktarı',true)+field('agreementId','Anlaşma / sipariş kimliği · isteğe bağlı')+'<p>İki miktarı anlaşmanıza göre ayrı girin. Kur, para veya stok hareketi oluşturulmaz.</p>';
  if(kind==='return'){
    form.innerHTML=select('originalId','İade edilecek alış',refundable.map(p=>[p.id,day(p.date)+' · '+[...new Set(p.lines.map(line=>catalog.find(a=>a.id===line.accountId)?.name||'Ürün'))].join(' / ')+(p.agreementId?' · '+p.agreementId:'')+receiptSuffix(p,refundable)]))+
      '<div data-return-products></div><div data-return-reductions></div><p>Belgeden düşülecek açık borç ile anlaşılan cari alacak ayrı miktarlardır. Fark varsa açık kalır; kendiliğinden silinmez.</p>';
    lineGroup('credits','İade için anlaştığınız alacak');lineGroup('received','Firmadan gerçekten aldığımız karşılık',true);form.insertAdjacentHTML('beforeend','<details><summary>İade TL referansı · isteğe bağlı</summary>'+field('referenceTL','Anlaşılmış TL referansı')+'</details>');
  }
  let targetHost;
  if(kind==='offset'){
    const targetDetails=doc.createElement('details');targetDetails.innerHTML='<summary>Mahsubu açık alış / borç belgelerine bağla · isteğe bağlı</summary><div data-offset-targets></div><button type="button" class="button secondary" data-add-offset-target>Belge ekle</button>';form.append(targetDetails);targetHost=targetDetails.querySelector('[data-offset-targets]');
    targetDetails.querySelector('button').addEventListener('click',()=>{addTarget();dirty=true;remember();});
  }
  function addTarget(values={}){
    if(targetHost.children.length>=30)return;
    const row=doc.createElement('div');row.className='form-grid';
    const candidates=documents.purchases.filter(p=>p.charges.some(c=>c.accountId===form.elements.toAccountId.value&&c.remaining>0));
    row.innerHTML='<label class="field"><span>Açık belge</span><select data-target-field="purchaseId" required><option value="">Seçin</option>'+candidates.map(p=>'<option value="'+esc(p.id)+'">'+esc(day(p.date)+' · '+(p.kind==='supplierReturn'?'İade sonrası kalan borç':'Alış / açık borç')+' · '+format(p.charges.find(c=>c.accountId===form.elements.toAccountId.value).remaining,accounts.find(a=>a.id===form.elements.toAccountId.value)?.unit)+receiptSuffix(p,candidates))+'</option>').join('')+'</select></label><label class="field"><span>Bu belgeye bağlanacak miktar</span><input data-target-field="quantity" required inputmode="decimal" maxlength="24"></label><label><input type="checkbox" data-target-field="overrideReserved">Bu belgeyi farklı anlaşmayla bağlamayı onaylıyorum.</label><label class="field"><span>Farklı anlaşma gerekçesi</span><input data-target-field="reason" maxlength="300"></label><button type="button" class="button text">Kaldır</button>';
    targetHost.append(row);for(const input of row.querySelectorAll('[data-target-field]'))if(input.type==='checkbox')input.checked=!!values[input.dataset.targetField];else input.value=values[input.dataset.targetField]||'';
    row.querySelector('button').addEventListener('click',()=>{row.remove();dirty=true;remember();});
  }
  function returnProducts(values={}){
    const purchase=refundable.find(p=>p.id===form.elements.originalId.value),products=form.querySelector('[data-return-products]'),reductions=form.querySelector('[data-return-reductions]');
    products.innerHTML=purchase?'<h4>Geri verilecek ürünler</h4>'+purchase.lines.filter(line=>line.remainingQuantity>0).map(line=>{const a=catalog.find(a=>a.id===line.accountId);return '<fieldset data-return-line="'+line.lineIndex+'"><legend>'+esc(a?.name||'Ürün')+' · İade edilebilir '+esc(format(line.remainingQuantity,a?.unit||'ADET'))+'</legend>'+field('returnQty-'+line.lineIndex,'İade miktarı · boşsa bu satır iade edilmez')+(line.weightAccount?field('returnWeight-'+line.lineIndex,'İade edilen gerçek toplam gram · kalan '+format(line.remainingWeight,'GRAM')):'')+'</fieldset>';}).join(''):'';
    reductions.innerHTML=purchase?'<h4>Bu alışın açık belgesinden düşülecek</h4>'+purchase.charges.filter(c=>c.remaining>0).map(c=>field('reduction-'+c.accountId,unitLabel(c.unit)+' · Açık '+format(c.remaining,c.unit))).join(''):'';
    for(const[name,value]of Object.entries(values))if(form.elements[name])form.elements[name].value=value;
  }
  form.insertAdjacentHTML('beforeend',['allocation','legacyLink'].includes(kind)?'<details class="supplier-optional-metadata"><summary>Açıklama · isteğe bağlı</summary>'+field('note','İşlem açıklaması')+'</details>':field('note','İşlem açıklaması',true));
  if(saved?.amend)form.insertAdjacentHTML('beforeend','<p>'+esc(saved.recordLabel)+' · Düzeltme</p>'+field('amendNote','Düzeltme gerekçesi',true));
  const review=doc.createElement('button');review.type='button';review.className='button secondary';review.dataset.reviewCurrent='';review.textContent='Güncel belgelerle kontrol ettim';review.hidden=!stale();form.append(review);
  review.addEventListener('click',()=>{stamp={revision,date:state.date};review.hidden=true;dirty=true;remember();status.textContent='Güncel belge miktarlarını kontrol edip kaydedin.';});
  if(kind==='return')form.insertAdjacentHTML('beforeend','<div data-return-preview class="info neutral" aria-live="polite"></div>');
  const save=doc.createElement('button');save.className='button';save.textContent={allocation:'Tahsisi kaydet',offset:'Hesap mahsubunu kaydet',return:'Alış iadesini kaydet',legacyLink:'Eski tahsilat kaynaklarını kaydet'}[kind];form.append(save);
  function capture(){
    const fields=Object.fromEntries([...form.querySelectorAll('[name]')].map(input=>[input.name,input.value]));
    const arrays={};for(const[name,group]of groups)arrays[name]=group.rows().map(row=>Object.fromEntries([...row.querySelectorAll('[data-field]')].filter(x=>!x.disabled).map(x=>[x.dataset.field,x.value])));
    const targets=targetHost?[...targetHost.children].map(row=>Object.fromEntries([...row.querySelectorAll('[data-target-field]')].map(input=>[input.dataset.targetField,input.type==='checkbox'?input.checked:input.value]))):[];
    return {fields,arrays,targets,links:sourcePicker?.snapshot()||[],stamp,...(saved?.amend?{amend:saved.amend,recordLabel:saved.recordLabel}:{})};
  }
  function remember(){if(dirty&&!completed)memory.set(key,capture());returnPreview();}
  function returnPreview(){
    const target=form.querySelector('[data-return-preview]');if(!target)return;
    const purchase=refundable.find(p=>p.id===form.elements.originalId.value);
    if(!purchase){target.textContent='Önizleme için kaynak alış seçin.';return;}
    if(stale()){target.textContent='Güncel belgeleri kontrol etmeden önizleme hesaplanmaz.';return;}
    let invalid=false;const outgoing=[],incoming=[],credits=new Map(),reductions=new Map();
    const read=(input,unit,max=Infinity,positive=true)=>{if(!input?.value.trim())return null;const n=context.parseAmount?.(input,unit,positive);if(!Number.isSafeInteger(n)||n<(positive?1:0)||n>max){invalid=true;return null;}return n;};
    for(const line of purchase.lines){const input=form.elements['returnQty-'+line.lineIndex],weightInput=form.elements['returnWeight-'+line.lineIndex];if(!input?.value.trim()){if(weightInput?.value.trim())invalid=true;continue;}const account=catalog.find(a=>a.id===line.accountId);if(!account){invalid=true;continue;}const quantity=read(input,account.unit,line.remainingQuantity),weight=line.weightAccount?read(weightInput,'GRAM',line.remainingWeight):null;if(line.weightAccount&&(weight===null||quantity===line.remainingQuantity&&weight!==line.remainingWeight||quantity!==null&&quantity<line.remainingQuantity&&weight>=line.remainingWeight))invalid=true;if(quantity!==null)outgoing.push((account.name||unitLabel(account.unit))+' · '+format(quantity,account.unit)+(weight!==null?' · '+format(weight,'GRAM'):''));}
    for(const line of purchase.charges){const input=form.elements['reduction-'+line.accountId];if(!input?.value.trim())continue;const quantity=read(input,line.unit,line.remaining);if(quantity!==null)reductions.set(line.accountId,(reductions.get(line.accountId)||0)+quantity);}
    for(const name of ['credits','received'])for(const row of groups.get(name).rows()){
      const account=(name==='credits'?accounts:catalog).find(a=>a.id===row.querySelector('[data-field="accountId"]').value),input=row.querySelector('[data-field="quantity"]');if(!account||!input.value.trim()){invalid=true;continue;}const quantity=read(input,account.unit),weightInput=row.querySelector('[data-field="weight"]'),weight=weightInput&&!weightInput.disabled?read(weightInput,'GRAM'):null;if(weightInput?.required&&weight===null)invalid=true;
      const reference=row.querySelector('[data-field="referenceTL"]');if(reference?.value.trim())read(reference,'TL',Infinity,false);
      if(quantity!==null){if(name==='credits')credits.set(account.id,(credits.get(account.id)||0)+quantity);else incoming.push((account.name||unitLabel(account.unit))+' · '+format(quantity,account.unit)+(weight!==null?' · '+format(weight,'GRAM'):''));}
    }
    if(form.elements.referenceTL?.value.trim())read(form.elements.referenceTL,'TL',Infinity,false);
    if([...credits.values(),...reductions.values()].some(n=>!Number.isSafeInteger(n)))invalid=true;
    const heading=saved?.amend?'Düzeltme için eski etkinin geri alınmış önizlemesi':'İade önizlemesi · güncel hesaplar';
    if(invalid){target.innerHTML='<h4>'+esc(heading)+'</h4><p>Eksik veya geçersiz miktarlar var. Bakiye ve fark hesaplanmadı.</p>';return;}
    const list=(title,rows,empty)=>'<h4>'+title+'</h4>'+(rows.length?'<ul>'+rows.map(text=>'<li>'+esc(text)+'</li>').join('')+'</ul>':'<p>'+empty+'</p>');
    const label=(n,unit)=>(n<0?'Borcumuz ':n>0?'Alacağımız ':'Bakiyesi sıfır ')+format(Math.abs(n),unit);
    const balances=[],differences=[];
    for(const id of new Set([...credits.keys(),...reductions.keys()])){const account=accounts.find(a=>a.id===id);if(!account){invalid=true;break;}const credit=credits.get(id)||0,reduction=reductions.get(id)||0,next=account.balance+credit,difference=credit-reduction;if(!Number.isSafeInteger(account.balance)||!Number.isSafeInteger(next)||Math.abs(next)>1e12||!Number.isSafeInteger(difference)){invalid=true;break;}
      balances.push(unitLabel(account.unit)+' · Önce: '+label(account.balance,account.unit)+' → Sonra: '+label(next,account.unit)+(credits.has(id)?'':' · Cari alacak satırı girilmedi; hesap etkisi yok'));
      differences.push(unitLabel(account.unit)+' · '+(reductions.has(id)?'Belgeden düşüm: '+format(reduction,account.unit):'Belgeden düşüm girilmedi')+' · '+(credits.has(id)?'Cari alacak: '+format(credit,account.unit):'Cari alacak satırı girilmedi')+' · '+(difference<0?'İade sonrası kalan borç: '+format(-difference,account.unit):difference>0?'Kullanılabilir iade alacağı: '+format(difference,account.unit):'Belge azaltımı ile cari alacak eşit'));
    }
    if(invalid){target.innerHTML='<h4>'+esc(heading)+'</h4><p>Hesap bakiyesi doğrulanamadı. Bakiye ve fark hesaplanmadı.</p>';return;}
    target.innerHTML='<h4>'+esc(heading)+'</h4>'+list('Firmaya çıkan',outgoing,'İade ürünü miktarı girilmedi.')+list('Firmadan giren',incoming,'Alınan karşılık satırı girilmedi.')+list('Firma bakiyesi: önce → sonra',balances,'Cari alacak satırı girilmedi; bakiye önizlemesi yok.')+list('Alış belgesi ile anlaşılan cari alacak',differences,'Belgeden düşüm girilmedi; cari alacak satırı girilmedi.')+(!outgoing.length||!credits.size&&!incoming.length?'<p>İade kaydı için ürün ve anlaşılan karşılığı tamamlayın.</p>':'');
  }
  if(saved){for(const[name,value]of Object.entries(saved.fields||{}))if(form.elements[name])form.elements[name].value=value;}
  if(kind==='legacyLink'){
    const host=form.querySelector('[data-legacy-rows]'),rows=()=>[...host.children];
    const receipt=()=>documents.unresolvedReceipts.find(r=>r.id===form.elements.originalId.value);
    const add=(value={})=>{
      if(rows().length>=30)return;
      const choices=(receipt()?.sources||[]).flatMap(source=>source.credits.map(line=>({source,line}))),row=doc.createElement('div');row.className='form-grid';
      row.innerHTML='<label class="field"><span>Önceki kaynak ödeme</span><select data-field="source" required><option value="">Seçin</option>'+choices.map(({source,line})=>'<option value="'+esc(JSON.stringify([source.id,line.accountId]))+'">'+esc(day(source.date)+' · '+unitLabel(line.unit)+' · '+format(line.remaining,line.unit)+receiptSuffix(source,receipt()?.sources||[]))+'</option>').join('')+'</select></label><label class="field"><span>Eşleştirilecek miktar</span><input data-field="quantity" required inputmode="decimal" maxlength="24"></label><button type="button" class="button text">Kaldır</button>';
      host.append(row);row.querySelector('select').value=value.source||'';row.querySelector('input').value=value.quantity||'';row.querySelector('button').addEventListener('click',()=>{row.remove();dirty=true;remember();});
    };
    groups.set('legacyUses',{rows,add});form.querySelector('[data-add-legacy-source]').addEventListener('click',()=>{add();dirty=true;remember();});
    const show=()=>{form.querySelector('[data-legacy-amounts]').textContent=receipt()?'Eşleştirilecek: '+receipt().debts.map(row=>format(row.quantity,row.unit)).join(' / '):'Eski tahsilat seçin.';};
    form.elements.originalId.addEventListener('change',()=>{host.replaceChildren();show();dirty=true;remember();});show();
  }
  if(kind==='return'){returnProducts(saved?.fields);form.elements.originalId.addEventListener('change',()=>{returnProducts();dirty=true;remember();});}
  if(kind==='offset'){for(const row of saved?.targets||[])addTarget(row);form.elements.toAccountId.addEventListener('change',()=>{targetHost.replaceChildren();dirty=true;remember();});}
  for(const[name,rows]of Object.entries(saved?.arrays||{}))for(const row of rows)groups.get(name)?.add(row);
  for(const select of form.querySelectorAll(receiptSelects))selectionSummary(select);
  for(const details of form.querySelectorAll('details'))if([...details.querySelectorAll('input,textarea')].some(input=>!input.disabled&&input.type!=='checkbox'&&input.value.trim()))details.open=true;
  if(['allocation','offset'].includes(kind))sourcePicker=attachSupplierSources(form,context,saved?.links||[]);
  form.addEventListener('input',event=>{event.target.setCustomValidity?.('');dirty=true;remember();});form.addEventListener('change',event=>{event.target.setCustomValidity?.('');dirty=true;remember();});
  returnPreview();
  if(stale())status.textContent='Defter veya iş günü değişti. Güncel belgeleri kontrol edin.';else status.textContent=saved?.amend?'Düzeltme için eski etkinin geri alınmış önizlemesi':'Güncel açık belgeler hazır.';
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(sending||context.isPending?.())return;dirty=true;remember();if(stale()){status.textContent='Güncel belgeleri kontrol edin.';return;}
    const selectedSources=sourcePicker?.read();if(selectedSources?.error){status.textContent=selectedSources.error;return;}if(!form.reportValidity())return;
    if(context.parseAmount)for(const[name,group]of groups){if(name==='legacyUses')continue;for(const row of group.rows()){
      const account=[...catalog,...accounts].find(a=>a.id===row.querySelector('[data-field="accountId"]').value);if(!account){status.textContent='Geçerli hesap seçin.';return;}
      for(const[field,unit,positive]of [['quantity',account.unit,true],['weight','GRAM',true],['referenceTL','TL',false]]){const input=row.querySelector('[data-field="'+field+'"]');if(!input||input.disabled||field!=='quantity'&&!input.required&&!input.value.trim())continue;const amount=context.parseAmount(input,unit,positive);if(amount===null||!Number.isSafeInteger(amount)||amount<(positive?1:0)){status.textContent='Geçerli miktar ve referansları girin.';return;}}
    }}
    const input=capture(),command={type:{allocation:'supplierAllocation',offset:'supplierOffset',return:'supplierReturn',legacyLink:'supplierLegacyReceiptLink'}[kind],date:state.date,supplierId:partyId};
    if(kind==='legacyLink'){
      const receipt=documents.unresolvedReceipts.find(r=>r.id===input.fields.originalId);if(!receipt){status.textContent='Eski tahsilat seçin.';return;}
      const choices=receipt.sources.flatMap(source=>source.credits.map(line=>({source,line}))),uses=[];
      for(const row of input.arrays.legacyUses){const choice=choices.find(c=>JSON.stringify([c.source.id,c.line.accountId])===row.source);if(!choice){status.textContent='Geçerli önceki ödeme kaynağı seçin.';return;}uses.push({sourceId:choice.source.id,accountId:choice.line.accountId,quantity:row.quantity});}
      if(!uses.length){status.textContent='Kaynak ödeme ve miktarları seçin.';return;}
      if(!context.parseAmount){status.textContent='Miktarlar doğrulanamadı. Ekranı yeniden açın.';return;}
      const totals=new Map(),sourceTotals=new Map();
      for(let i=0;i<uses.length;i++){
        const use=uses[i],choice=choices.find(c=>c.source.id===use.sourceId&&c.line.accountId===use.accountId),element=groups.get('legacyUses').rows()[i].querySelector('[data-field="quantity"]'),amount=context.parseAmount(element,choice.line.unit,true),sourceKey=JSON.stringify([use.sourceId,use.accountId]);
        if(amount===null||!Number.isSafeInteger(amount)||amount<=0){status.textContent='Geçerli kaynak miktarı girin.';return;}
        totals.set(use.accountId,(totals.get(use.accountId)||0)+amount);sourceTotals.set(sourceKey,(sourceTotals.get(sourceKey)||0)+amount);
        if(sourceTotals.get(sourceKey)>choice.line.remaining){status.textContent='Eşleştirilen miktar kaynakta kalan tutarı aşamaz.';return;}
      }
      if(receipt.debts.some(debt=>totals.get(debt.accountId)!==debt.quantity)||[...totals.keys()].some(id=>!receipt.debts.some(debt=>debt.accountId===id))){status.textContent='Her birimin tahsil edilen tutarını tam olarak eşleştirin.';return;}
      command.originalId=receipt.id;command.uses=uses;
    }
    if(kind==='allocation'){if(!selectedSources.rows.length){status.textContent='En az bir kaynak ve alış seçin.';return;}command.allocations=selectedSources.rows;}
    if(kind==='offset'){
      if(!selectedSources.rows.length||selectedSources.rows.some(row=>row.accountId!==input.fields.fromAccountId)){status.textContent='Kaynaklar seçilen alacak biriminden olmalı.';return;}
      if(context.parseAmount){const from=accounts.find(a=>a.id===input.fields.fromAccountId),to=accounts.find(a=>a.id===input.fields.toAccountId),fromAmount=context.parseAmount(form.elements.fromQuantity,from?.unit,true),toAmount=context.parseAmount(form.elements.toQuantity,to?.unit,true);if(!from||!to||from.id===to.id||!Number.isSafeInteger(fromAmount)||fromAmount<=0||fromAmount>from.balance||!Number.isSafeInteger(toAmount)||toAmount<=0||toAmount>-to.balance){status.textContent='Mahsup miktarları mevcut alacak ve borç sınırları içinde olmalı.';return;}
        let sourceTotal=0;for(const row of form.querySelectorAll('[data-source-rows] > div'))sourceTotal+=context.parseAmount(row.querySelector('[data-source-field="quantity"]'),from.unit,true)||0;if(sourceTotal!==fromAmount){status.textContent='Kaynakların toplamı kullanılacak alacağa eşit olmalı.';return;}
        let targetTotal=0;const used=new Map();for(const row of targetHost.children){const id=row.querySelector('select').value,purchase=documents.purchases.find(p=>p.id===id),charge=purchase?.charges.find(c=>c.accountId===to.id),quantity=context.parseAmount(row.querySelector('[data-target-field="quantity"]'),to.unit,true);if(!charge||!Number.isSafeInteger(quantity)||quantity<=0){status.textContent='Geçerli hedef belge ve miktar seçin.';return;}used.set(id,(used.get(id)||0)+quantity);targetTotal+=quantity;if(used.get(id)>charge.remaining){status.textContent='Hedef belge kullanım toplamı açık borcu aşamaz.';return;}}if(targetTotal>toAmount){status.textContent='Belgelere bağlanan toplam hedef mahsup miktarını aşamaz.';return;}
      }
      Object.assign(command,{fromAccountId:input.fields.fromAccountId,fromQuantity:input.fields.fromQuantity,toAccountId:input.fields.toAccountId,toQuantity:input.fields.toQuantity,note:input.fields.note,
        sourceUses:selectedSources.rows.map(({accountId,...row})=>row)});
      if(input.fields.agreementId)command.agreementId=input.fields.agreementId;
      if(input.targets.length)command.targetUses=input.targets.map(row=>({purchaseId:row.purchaseId,quantity:row.quantity,...(row.overrideReserved?{overrideReserved:true,reason:row.reason}:{})}));
    }
    if(kind==='return'){
      const purchase=refundable.find(p=>p.id===input.fields.originalId);if(!purchase){status.textContent='İade edilecek alış seçin.';return;}
      if(context.parseAmount){
        for(const line of purchase.lines){const input=form.elements['returnQty-'+line.lineIndex];if(!input?.value.trim())continue;const quantity=context.parseAmount(input,catalog.find(a=>a.id===line.accountId)?.unit,true);if(quantity===null||!Number.isSafeInteger(quantity)||quantity<=0||quantity>line.remainingQuantity){status.textContent='İade miktarı alışın kalan ürün miktarını aşamaz.';return;}if(line.weightAccount){const weight=context.parseAmount(form.elements['returnWeight-'+line.lineIndex],'GRAM',true);if(weight===null||!Number.isSafeInteger(weight)||weight<=0||weight>line.remainingWeight){status.textContent='İade gramı alışın kalan gerçek gramını aşamaz.';return;}}}
        for(const charge of purchase.charges){const input=form.elements['reduction-'+charge.accountId];if(!input?.value.trim())continue;const quantity=context.parseAmount(input,charge.unit,true);if(quantity===null||!Number.isSafeInteger(quantity)||quantity<=0||quantity>charge.remaining){status.textContent='Belgeden düşülen tutar açık borcu aşamaz.';return;}}
      }
      command.originalId=purchase.id;command.items=purchase.lines.filter(line=>input.fields['returnQty-'+line.lineIndex]?.trim()).map(line=>({lineIndex:line.lineIndex,quantity:input.fields['returnQty-'+line.lineIndex],...(line.weightAccount?{weight:input.fields['returnWeight-'+line.lineIndex]}:{})}));
      if(!command.items.length){status.textContent='İade edilecek ürün miktarını girin.';return;}
      command.reductions=purchase.charges.filter(c=>input.fields['reduction-'+c.accountId]?.trim()).map(c=>({accountId:c.accountId,quantity:input.fields['reduction-'+c.accountId]}));
      command.credits=input.arrays.credits.map(row=>Object.fromEntries(Object.entries(row).filter(([,v])=>v.trim())));command.received=input.arrays.received.map(row=>Object.fromEntries(Object.entries(row).filter(([,v])=>v.trim())));command.note=input.fields.note;if(input.fields.referenceTL?.trim()){if(context.parseAmount){const amount=context.parseAmount(form.elements.referenceTL,'TL',false);if(!Number.isSafeInteger(amount)||amount<0){status.textContent='Geçerli TL referansı girin.';return;}}command.referenceTL=input.fields.referenceTL.trim();}
      if(!command.credits.length&&!command.received.length){status.textContent='Anlaşılan cari alacağı veya gerçek alınan karşılığı girin.';return;}
    }
    sending=true;save.disabled=true;
    try{if(await context.submit(saved?.amend?{type:'supplierAmend',date:state.date,originalId:saved.amend.originalId,note:input.fields.amendNote.trim(),replacement:command}:command,'Toptancı belgesi kaydedildi.',{supplierDraftKey:key})){completed=true;memory.delete(key);if(form.isConnected){form.replaceChildren();status.textContent='Kayıt tamamlandı.';}}}
    catch(error){if(form.isConnected)status.textContent=error.message;}
    finally{sending=false;if(save.isConnected)save.disabled=false;}
  });
  return completedDraftKey=>{if(completedDraftKey===key)completed=true;if(!sending)remember();sourcePicker?.destroy();};
}

