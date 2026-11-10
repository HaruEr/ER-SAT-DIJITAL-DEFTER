// Only structured, revision-validated supplier snapshots enter this adapter.
// All business text is PDF text, never HTML, SVG, a URL or executable content.
const text=value=>String(value??'');
// A conservative bound for ordinary short receipts: reserve a line per wrap,
// plus word-boundary slack and margins. Oversized text stays freely paginated.
const receiptHeightBound=nodes=>nodes.reduce((height,node)=>height+text(node.text).split(/\r?\n/).reduce((n,line)=>n+(Math.ceil(line.length/35)+1)*16,0)+(node.style==='heading'?17:node.style==='label'?8:4),0);
function receiptBlock(nodes,firm){
  const header={stack:[{text:text(firm),bold:true},...nodes.slice(0,2)]},rows=nodes.slice(2);
  return {margin:[0,10,0,0],unbreakable:receiptHeightBound([{text:firm},...nodes])<=620,
    table:{widths:['*'],headerRows:1,keepWithHeaderRows:receiptHeightBound(rows.slice(0,2))<250?Math.min(2,rows.length):1,
      body:[[header],...rows.map(node=>[node])]},layout:'noBorders'};
}
function amount(value,unit){
  if(!Number.isSafeInteger(value)||!unit)throw Error('PDF için miktar veya birim doğrulanamadı.');
  const digits=unit==='ADET'?0:['GRAM','HAS','SILVER'].includes(unit)?3:2;
  const label={GRAM:'gr',HAS:'has gr',SILVER:'saf gümüş gr',ADET:'adet'}[unit]||unit;
  return new Intl.NumberFormat('tr-TR',{minimumFractionDigits:digits,maximumFractionDigits:digits}).format(value/10**digits)+' '+label;
}
export function buildSupplierPdf(snapshot){
  const {page,events,scope,revision,catalog=[]}=snapshot;
  if(!page?.supplier||!Array.isArray(events)||events.length!==page.total||new Set(events.map(e=>e.id)).size!==events.length)throw Error('PDF kayıtlarının tamamı doğrulanamadı.');
  const accounts=new Map([...catalog,...(page.accounts||[])].map(a=>[a.id,a]));
  const content=[],add=(value,style)=>content.push({text:text(value),...(style?{style}:{})});
  add(page.supplier.name+' · '+(snapshot.kind==='history'?'Hareket geçmişi':'Ekstre'),'title');
  add('Dönem: '+(scope.startDate||'Başlangıçtan')+' — '+(scope.endDate||'Son kayda kadar')+' · '+events.length+' hareket · Sürüm '+revision);
  add('ER ŞAT bakışı: negatif borcumuz, pozitif alacağımız. Her birim bağımsızdır.');
  add('Birim bazlı dönem ekstresi','heading');
  const fields=[['opening','Dönem başı'],['debtIncrease','Borç artışı'],['debtDecrease','Borç azalışı'],['creditIncrease','Alacak artışı'],['creditDecrease','Alacak azalışı'],['closing','Dönem sonu']];
  for(const row of page.statements||[]){
    add(row.unit==='SILVER'?'Ag / saf gümüş':row.unit,'heading');
    content.push({table:{widths:['*','*'],body:fields.map(([key,label])=>[label,amount(row[key],row.unit)])},layout:'lightHorizontalLines'});
  }
  add('Güncel firma bakiyeleri · dönem bakiyesi yerine geçmez','heading');
  for(const a of page.accounts||[])add((a.name||a.unit)+': '+amount(a.balance,a.unit));
  if(snapshot.reconciliation){const r=snapshot.reconciliation;add('Harici ekstre karşılaştırması','heading');add(text(r.reference)+' · '+text(r.date));add('Harici: '+amount(r.external,r.unit)+' · Dönem sonu: '+amount(r.closing,r.unit)+' · Fark: '+amount(r.difference,r.unit));}
  const lineText=row=>{const a=accounts.get(row.accountId),unit=row.unit||a?.unit;
    // Stock lines without a paired gram pool carry canonical weight:0 even
    // though no weight was entered. That sentinel is not a measured zero.
    const hasWeight=row.weight!==undefined&&row.weight!==null&&row.weight!==''&&(row.weight!==0||Boolean(row.weightAccount));
    return (a?.name||row.accountId||unit)+': '+amount(row.quantity,unit)+(hasWeight?' · Gerçek ağırlık '+amount(row.weight,'GRAM'):'')+(row.referenceTL!==undefined?' · TL referansı '+amount(row.referenceTL,'TL'):'');};
  for(const event of events){
    const eventStart=content.length;
    const m=event.meta||{};
    add(text(event.date)+' · '+text(event.label),'heading');
    add(({active:'Aktif',reversed:'İptal edildi',amended:'Düzeltildi'}[event.status]||'Kayıt durumu belirtilmedi')+' · Kayıt: '+event.id);
    const groups=[[event.type==='supplierReturn'?'Firmaya iade edilen ürünler':'Alınan ürünler',m.lines],['Verilen karşılıklar',m.givenLines],['Alınan karşılıklar',m.receivedLines],[event.type==='supplierReturn'?'İade sonrası kalan borç':'Anlaşılmış alış / hesap borcu',m.chargeLines],['Anlaşılmış cari alacak',m.creditLines],['Tahsilatın cari borç etkisi',m.debtLines],['Kaynak alış belgesinden düşülen',m.reductions],['Mahsupta kullanılan alacak',m.from?[m.from]:[]],['Mahsupla azalan borç',m.to?[m.to]:[]]];
    for(const [label,rows] of groups)if(rows?.length){add(label,'label');for(const row of rows)add(lineText(row));}
    add('TL referansı: '+(m.referenceTL===undefined?'Belirtilmedi':amount(m.referenceTL,'TL')));
    for(const [label,links] of [['Tahsis',m.allocations],['Mahsup kaynakları',m.sourceUses],['Mahsup hedefleri',m.targetUses],['Tahsilat kaynakları',m.debtUses],['Eski tahsilat eşleştirmesi',m.uses]]){
      if(links?.length){add(label,'label');for(const link of links)add(lineText(link)+' · Kaynak: '+text(link.sourceId||event.id)+(link.purchaseId?' · Belge: '+link.purchaseId:'')+(link.reason?' · Gerekçe: '+link.reason:''));}
    }
    if(m.agreementId)add('Anlaşma: '+m.agreementId);
    if(m.advanceScope)add('Avans kapsamı: '+(m.advanceScope==='reserved'?'Anlaşmaya ayrılmış':'Genel'));
    if(m.note)add('Not: '+m.note);
    for(const row of event.balances||[])add('Cari · Önce: '+amount(row.before,row.unit)+'; sonra: '+amount(row.after,row.unit)+'; etki: '+amount(row.delta,row.unit));
    if(event.relatedEventIds?.length)add('Bağlı kayıtlar: '+event.relatedEventIds.join(', '));
    add('Kaydeden: '+text(event.actor?.displayName||event.actor?.name||'Belirtilmedi'));
    content.push(receiptBlock(content.splice(eventStart),page.supplier.name));
  }
  if(!events.length)add('Seçilen dönemde hareket yok.');
  return {pageSize:'A4',pageMargins:[36,36,36,42],info:{title:text(page.supplier.name)+' · Ekstre',creator:'ER ŞAT'},defaultStyle:{font:'Roboto',fontSize:9},styles:{title:{fontSize:17,bold:true,margin:[0,0,0,10]},heading:{fontSize:12,bold:true,margin:[0,12,0,5]},label:{bold:true,margin:[0,6,0,2]}},footer:(page,total)=>({text:page+' / '+total,alignment:'center',fontSize:8}),content};
}
export function pdfBytes(definition,engine){
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('PDF hazırlanamadı. Yeniden deneyin.')),60000);
    try{
      // No URL fonts/images are admitted; synchronous stream construction surfaces errors.
      const stream=engine.createPdf(definition).getStream(),chunks=[];
      stream.on('data',chunk=>chunks.push(chunk));
      stream.on('error',error=>{clearTimeout(timer);reject(error);});
      stream.on('end',()=>{clearTimeout(timer);const bytes=new Uint8Array(chunks.reduce((n,c)=>n+c.length,0));let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}resolve(bytes);});
      stream.end();
    }
    catch(error){clearTimeout(timer);reject(error);}
  });
}
let enginePromise;
function loadEngine(){
  if(!enginePromise)enginePromise=(async()=>{
    for(const path of ['./vendor/pdfmake/pdfmake.min.js','./vendor/pdfmake/vfs_fonts.js'])await new Promise((resolve,reject)=>{
      const script=document.createElement('script');script.src=new URL(path,import.meta.url).href;
      script.onload=()=>{script.remove();resolve();};script.onerror=()=>{script.remove();reject(Error('Çevrimdışı PDF bileşeni yüklenemedi.'));};document.head.append(script);
    });
    if(!globalThis.pdfMake?.createPdf)throw Error('PDF bileşeni hazır değil.');return globalThis.pdfMake;
  })().catch(error=>{enginePromise=null;throw error;});
  return enginePromise;
}
export async function exportSupplierPdf(snapshot){
  const definition=buildSupplierPdf(snapshot),engine=await loadEngine(),bytes=await pdfBytes(definition,engine);
  const url=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'})),anchor=document.createElement('a');
  anchor.href=url;anchor.download='firma-'+String(snapshot.page.supplier.id).replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,80)+'-'+(snapshot.scope.startDate||'baslangic')+'-'+(snapshot.scope.endDate||'son')+'.pdf';
  document.body.append(anchor);try{anchor.click();}finally{anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
}
