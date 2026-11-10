const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const normalized = value => value.toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/ı/g,'i');
const units = { TL:[100,2,'TL'],USD:[100,2,'USD'],EUR:[100,2,'EUR'],HAS:[1000,3,'has gr'],SILVER:[1000,3,'saf gümüş gr'],GRAM:[1000,3,'gr'],ADET:[1,0,'adet'] };
function amount(value, unit = 'TL') { const [scale,digits,label] = units[unit] || [100,2,unit]; return new Intl.NumberFormat('tr-TR',{minimumFractionDigits:digits,maximumFractionDigits:digits}).format(value/scale)+' '+label; }
function dateLabel(value) { return value ? new Date(value+'T12:00:00').toLocaleDateString('tr-TR',{day:'numeric',month:'long',year:'numeric'}) : 'Açılış bekleniyor'; }
let workspace='demo', view='overview', data=null, sequence=0, busy=false, journalPage=null;


// Session-only display context, isolated per ledger. No persisted business data.
const filterMemory = new Map();
const filterIds = ['stock-search','cari-search','cari-filter','journal-date','journal-type','journal-search','report-date'];
function rememberFilters() { const values={...filterMemory.get(workspace)}; for(const id of filterIds){const el=document.getElementById(id);if(el)values[id]=el.value;}filterMemory.set(workspace,values); }
function restoreFilters() { for(const [id,value] of Object.entries(filterMemory.get(workspace)||{})){const el=document.getElementById(id);if(el)el.value=value;} }
function denied(error){return error.status===401||error.status===403;}
function validateReport(name,result,selectedWorkspace){
 const integer=Number.isSafeInteger, rows=(items,keys)=>Array.isArray(items)&&items.every(a=>a&&typeof a.name==='string'&&typeof a.unit==='string'&&keys.every(k=>integer(a[k])));
 const date=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value);
 let valid=result&&integer(result.revision)&&result.revision>=0&&result.workspace===selectedWorkspace;
 if(name==='overview')valid=valid&&typeof result.initialized==='boolean'&&(!result.initialized||date(result.date))&&rows(result.accounts,['balance'])&&result.totals&&['sales','purchases','expenses'].every(k=>integer(result.totals[k]));
 if(name==='summary')valid=valid&&date(result.date)&&rows(result.accounts,['opening','incoming','outgoing','adjustment','closing'])&&result.totals&&['sales','purchases'].every(k=>integer(result.totals[k]));
 if(name==='journal')valid=valid&&Array.isArray(result.items)&&result.items.every(a=>date(a.date)&&rows(a.entries,['delta']));
 if(!valid)throw new Error('Rapor verileri eksik veya doğrulanamadı. Eksik değerler sıfır kabul edilmedi.');
 return result;
}

function status(message, error=false) { const node=$('#report-status');node.setAttribute('role',error?'alert':'status');node.setAttribute('aria-live',error?'assertive':'polite');node.classList.toggle('error',error);node.textContent=message; }
function setBusy(value) { busy=value;document.body.setAttribute('aria-busy',String(value));document.querySelectorAll('button,input,select').forEach(control=>{if(value){control.dataset.priorDisabled=String(control.disabled);control.disabled=true;}else{control.disabled=control.dataset.priorDisabled==='true';delete control.dataset.priorDisabled;}}); }
async function getReport(name, params = {}, selectedWorkspace = workspace) {
  const query=new URLSearchParams({workspace:selectedWorkspace,...params});
  const response=await fetch('/api/reports/'+name+'?'+query),result=await response.json();
  if(!response.ok){const error=new Error(result.error||'Rapor alınamadı.');error.status=response.status;throw error;}return validateReport(name,result,selectedWorkspace);
}
function heading(title,description) { return '<div class="page-heading"><span class="eyebrow">DEFTER RAPORLARI</span><h1>'+title+'</h1><p>'+description+'</p></div>'; }
function metadata(revision = data?.revision, date = data?.date) { $('#report-meta').textContent=(workspace==='demo'?'Örnek defter':'Dükkân defteri')+' · '+(date?dateLabel(date):'Tarih doğrulanamadı')+(Number.isSafeInteger(revision)?' · Veri sürümü '+revision:' · Veri sürümü doğrulanamadı'); }
function accessibleTables(container) { container.querySelectorAll('.table-wrap').forEach(wrapper=>{wrapper.tabIndex=0;wrapper.setAttribute('role','region');wrapper.setAttribute('aria-label','Hesap hareketleri tablosu; yatay kaydırılabilir');}); }
function accountCard(account, extra='') { return '<article class="account-card"><div><h3>'+esc(account.name)+'</h3><p>'+esc(extra||({daily:'Günlük sayım',periodic:'Dönemsel tartım',none:'Hesap bakiyesi'}[account.countPolicy]||'Hesap bakiyesi'))+'</p></div><strong class="account-value">'+esc(amount(account.balance,account.unit))+'</strong></article>'; }
function render() {
  document.querySelectorAll('[data-report-view]').forEach(button=>{const selected=button.dataset.reportView===view;button.classList.toggle('active',selected);button.setAttribute('aria-current',selected?'page':'false');});
  if(!data)return;
  metadata();
  if(!data.initialized){$('#report-main').innerHTML=heading('Henüz açılış yapılmadı','Bu defter için başlangıç devri ana bilgisayarda onaylandığında raporlar burada görünür.')+'<section class="empty-state"><h2>Raporlanacak kayıt yok</h2><p>Bu ekranda açılış veya işlem oluşturulmaz.</p></section>';return;}
  ({overview:renderOverview,stock:renderStock,cari:renderCaris,journal:renderJournal})[view]();
}
function tradeChart() {
  const rows=[['Net satış',data.totals.sales,'sale'],['Net alış',data.totals.purchases,'purchase'],['Gider',data.totals.expenses,'expense']],maximum=Math.max(1,...rows.map(row=>Math.abs(row[1])));
  return '<section class="report-card"><div class="section-heading"><div><span class="eyebrow">BUGÜNÜN HAREKETİ · TL</span><h2>Alış, satış ve gider</h2></div><span class="date-chip">'+esc(dateLabel(data.date))+'</span></div><div id="trade-chart" class="trade-chart">'+rows.map(([label,value,tone])=>{const width=Math.abs(value)/maximum*48,x=value<0?50-width:50;const long=amount(value).length>16;return '<div class="chart-row'+(long?' long-amount':'')+'"><div><span>'+label+'</span><strong'+(long?' tabindex="0"':'')+'>'+esc(amount(value))+'</strong></div><svg viewBox="0 0 100 12" aria-hidden="true" focusable="false"><line x1="50" x2="50" y1="0" y2="12"></line><rect class="'+tone+'" x="'+x+'" y="2" width="'+width+'" height="8" rx="2"></rect></svg></div>';}).join('')+'</div><p class="helper">Satış ve alış, işlemde anlaşılmış TL karşılıklarıdır. Ters kayıtlar dahildir; bu grafik kâr hesabı değildir. Sıfırın solundaki çubuklar negatif net etkiyi gösterir.</p></section>';
}
function renderOverview() {
 const funds=data.accounts.filter(a=>a.category==='financial'),caris=data.accounts.filter(a=>a.category==='receivable');
 const group=(title,rows)=>'<section class="report-card fund-group"><h2>'+title+'</h2><div class="account-list">'+rows.map(a=>accountCard(a,a.physical?'Fiziki kasa · '+a.unit:'Banka / alacak · '+a.unit)).join('')+'</div></section>';
 $('#report-main').innerHTML=heading('Günün özeti','Açık iş günü · '+dateLabel(data.date)+' · TL hareketleri kâr değildir.')+tradeChart()+'<p class="helper">'+caris.filter(a=>a.balance>0).length+' alacak hesabı · '+caris.filter(a=>a.balance<0).length+' borç hesabı. Ayrıntılar Cariler bölümünde.</p>'+
 '<div class="report-grid">'+group('TL mevcudu',funds.filter(a=>a.unit==='TL'))+[...new Set(funds.filter(a=>a.unit!=='TL').map(a=>a.unit))].map(unit=>group(esc(unit)+' hesapları',funds.filter(a=>a.unit===unit))).join('')+'</div>'+
 '<section class="report-card"><h2>Günü hesap bazında incele</h2><p>Seçilen günün devir, giriş, çıkış ve kapanışı. Üst göstergeler açık iş gününe aittir.</p><form id="report-summary-form" class="report-filters"><label for="report-date">İncelenecek iş günü<input id="report-date" type="date" value="'+esc(data.date)+'" required></label><button class="button" type="submit">Günü incele</button></form><p id="dated-summary-status" role="status" aria-live="polite"></p><div id="dated-summary" role="region" aria-label="Seçilen günün hesap özeti"></div></section>';
 restoreFilters();$('#report-summary-form').addEventListener('submit',event=>{event.preventDefault();loadSummary();});
}
async function loadSummary() {
  if(busy)return;rememberFilters();const ticket=++sequence,selectedWorkspace=workspace,target=$('#dated-summary'),notice=$('#dated-summary-status'),date=$('#report-date').value;
  target.textContent='';notice.textContent='Gün özeti hazırlanıyor…';setBusy(true);
  try{
    const result=await getReport('summary',{date},selectedWorkspace);if(ticket!==sequence||selectedWorkspace!==workspace||!target.isConnected)return;
    target.innerHTML='<p class="summary-caption">'+esc(dateLabel(result.date))+' · Veri sürümü '+result.revision+' · Net satış '+esc(amount(result.totals.sales))+' · Net alış '+esc(amount(result.totals.purchases))+'</p><div class="table-wrap"><table><thead><tr><th>Hesap</th><th>Devir</th><th>Giriş</th><th>Çıkış</th><th>Düzeltme</th><th>Kapanış</th></tr></thead><tbody>'+result.accounts.map(account=>'<tr><th scope="row">'+esc(account.name)+'<small>'+esc(account.unit)+'</small></th>'+['opening','incoming','outgoing','adjustment','closing'].map(key=>'<td>'+esc(amount(account[key],account.unit))+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
    accessibleTables(target);notice.textContent=dateLabel(result.date)+' özeti hazır.';
  }catch(error){if(ticket===sequence&&target.isConnected){notice.textContent=denied(error)?'Bu rapora erişim izni yok.':'Gün özeti alınamadı.';target.textContent=error.message;}}
  finally{if(ticket===sequence)setBusy(false);}
}
function renderStock() {
  const accounts=data.accounts.filter(account=>account.category==='stock');
  $('#report-main').innerHTML=heading('Stokta neler var?','Hesaplanan adet ve gram mevcutları. Adet ile gram aynı malın farklı ölçüleri olabilir; toplanmaz.')+'<section class="report-card"><label for="stock-search" class="standalone-filter">Stok hesabı ara<input id="stock-search" type="search" maxlength="160" placeholder="Bilezik, çeyrek, 14 ayar…"></label><p id="stock-results" role="status" aria-live="polite"></p><div id="report-stock-list" class="stock-grid"></div></section>';
  const draw=()=>{const q=normalized($('#stock-search').value.trim()),filtered=accounts.filter(account=>!q||normalized(account.name).includes(q));$('#stock-results').textContent=filtered.length+' stok hesabı';$('#report-stock-list').innerHTML=filtered.length?filtered.map(account=>accountCard(account)).join(''):'<p class="empty-note">Aramaya uygun stok hesabı bulunamadı.</p>';};
  restoreFilters();$('#stock-search').addEventListener('input',draw);draw();
}
function renderCaris() {
  const accounts=data.accounts.filter(account=>account.category==='receivable'),totals=new Map();
  for(const account of accounts){if(!totals.has(account.unit))totals.set(account.unit,{claim:0,debt:0});const total=totals.get(account.unit);if(account.balance>0)total.claim+=account.balance;else total.debt-=account.balance;}
  $('#report-main').innerHTML=heading('Kimden alacak, kime borç?','Pozitif bakiye alacağımızı, negatif bakiye borcumuzu gösterir. Her kişi ve para/has birimi ayrı hesaptır.')+'<div class="cari-unit-totals">'+[...totals].map(([unit,total])=>'<section class="unit-card"><span>'+esc(unit)+'</span><p>Alacağımız <strong>'+esc(amount(total.claim,unit))+'</strong></p><p>Borcumuz <strong>'+esc(amount(total.debt,unit))+'</strong></p></section>').join('')+'</div><section class="report-card"><div class="report-filters"><label for="cari-search">Kişi / hesap ara<input id="cari-search" type="search" maxlength="160" placeholder="Ad veya hesap adı"></label><label for="cari-filter">Göster<select id="cari-filter"><option value="all">Bütün cariler</option><option value="claim">Yalnız alacaklarımız</option><option value="debt">Yalnız borçlarımız</option><option value="zero">Bakiyesi sıfır olanlar</option></select></label></div><p id="cari-results" role="status" aria-live="polite"></p><div id="report-cari-list" class="account-list"></div></section>';
  const draw=()=>{const q=normalized($('#cari-search').value.trim()),filter=$('#cari-filter').value,filtered=accounts.filter(account=>(!q||normalized(account.name).includes(q))&&(filter==='all'||filter==='claim'&&account.balance>0||filter==='debt'&&account.balance<0||filter==='zero'&&account.balance===0));$('#cari-results').textContent=filtered.length+' cari hesabı';$('#report-cari-list').innerHTML=filtered.length?filtered.map(account=>'<article class="account-card cari-card"><div><h3>'+esc(account.name)+'</h3><p class="'+(account.balance<0?'debt':'claim')+'">'+(account.balance>0?'Alacağımız':account.balance<0?'Borcumuz':'Bakiye sıfır')+'</p></div><strong class="account-value">'+esc(amount(Math.abs(account.balance),account.unit))+'</strong></article>').join(''):'<p class="empty-note">Bu filtreye uygun cari hesabı yok.</p>';};
  const filters=$('.report-filters'),totalsNode=$('.cari-unit-totals');totalsNode.before(filters);totalsNode.insertAdjacentHTML('afterend','<p class="helper">Birim toplamları bütün cari hesapları kapsar; arama yalnız listeyi daraltır.</p>');restoreFilters();$('#cari-search').addEventListener('input',draw);$('#cari-filter').addEventListener('change',draw);draw();
}
function renderJournal() {
  journalPage=null;
  $('#report-main').innerHTML=heading('Hareketleri incele','Kayıtların hesaplara etkisini okuyun. Her miktar hesabın özgün birimindedir.')+'<section class="report-card"><form id="report-journal-form" class="report-filters"><label for="journal-date">İş günü<input id="journal-date" type="date"></label><label for="journal-type">İşlem<select id="journal-type"><option value="">Bütün türler</option><option value="sale">Satış</option><option value="saleReturn">Ürün iadesi</option><option value="settlement">POS tahsilatı</option><option value="purchase">Eski / müşteri alışları</option><option value="supplierPurchase">Toptancı alış</option><option value="supplierPayment">Toptancı ödeme / avans</option><option value="supplierAllocation">Toptancı tahsis</option><option value="supplierOffset">Toptancı mahsup</option><option value="supplierReturn">Toptancı alış iadesi</option><option value="supplierReverse">Toptancı ters kayıt</option><option value="collection">Cari tahsilat / ödeme</option><option value="movement">Tek hesap hareketi / düzeltme</option><option value="stock">Stok giriş / çıkışı</option><option value="transfer">Transfer</option><option value="close">Kapanış</option><option value="stocktake">Tartım</option><option value="registerItem">Tekil ürün kaydı</option><option value="releaseItem">Tekil ürün eşlemesi kaldırıldı</option><option value="reverse">Ters kayıt</option></select></label><label for="journal-search">Açıklama / hesap ara<input id="journal-search" type="search" maxlength="160"></label><button type="submit" class="button">Raporu filtrele</button><button id="journal-clear" type="button" class="button secondary">Filtreleri temizle</button></form><p id="journal-applied-filters" class="helper"></p><p id="journal-filter-draft" class="helper" role="status" aria-live="polite"></p><p id="journal-status" role="status" aria-live="polite"></p><div id="report-journal-list"></div><button id="report-more" class="button secondary" type="button" hidden>Sonraki kayıtları göster</button></section>';
  const form=$('#report-journal-form');
  form.addEventListener('submit',event=>{event.preventDefault();loadJournal();});
  form.addEventListener('input',updateJournalFilters);form.addEventListener('change',updateJournalFilters);
  $('#journal-clear').addEventListener('click',async()=>{
    if(busy)return;
    for(const id of ['journal-date','journal-type','journal-search'])$('#'+id).value='';
    const search=$('#journal-search');await loadJournal();if(search.isConnected)search.focus();
  });
  $('#report-more').addEventListener('click',()=>loadJournal(true));restoreFilters();loadJournal();
}
function journalFilterValues() { return {date:$('#journal-date').value,type:$('#journal-type').value,q:$('#journal-search').value,limit:'25'}; }
function updateJournalFilters() {
  const summary=$('#journal-applied-filters'),draft=$('#journal-filter-draft');
  if(!summary||!draft)return;
  if(!journalPage){summary.textContent='';draft.textContent='';return;}
  const applied=journalPage.filters,current=journalFilterValues();
  const typeLabel=[...$('#journal-type').options].find(option=>option.value===applied.type)?.textContent||'Bütün türler';
  summary.textContent='Uygulanan filtreler: '+(applied.date?dateLabel(applied.date):'Bütün günler')+' · '+typeLabel+' · '+(applied.q.trim()?'Arama: '+applied.q:'Arama yok');
  draft.textContent=['date','type','q'].some(key=>current[key]!==applied[key])?'Filtre değişti. Listeyi güncellemek için Raporu filtrele düğmesine basın.':'';
}
function journalMarkup(item) { return '<article class="movement-card" data-record="'+item.record+'"><header><div><h2>'+esc(item.label)+'</h2><p>'+esc(dateLabel(item.date))+'</p></div><span class="record-chip">Kayıt '+item.record+'</span></header>'+(item.note?'<p class="movement-note">'+esc(item.note)+'</p>':'')+'<dl>'+item.entries.map(entry=>'<div><dt>'+esc(entry.name)+'</dt><dd>'+(entry.delta>0?'+':'')+esc(amount(entry.delta,entry.unit))+'</dd></div>').join('')+'</dl></article>'; }
async function loadJournal(append=false) {
  if(busy)return;rememberFilters();const target=$('#report-journal-list'),notice=$('#journal-status'),ticket=++sequence,selectedWorkspace=workspace;
  const params=append?{...journalPage.filters,cursor:journalPage.nextCursor}:journalFilterValues();
  if(!append){journalPage=null;target.textContent='';}updateJournalFilters();notice.textContent='Hareketler hazırlanıyor…';setBusy(true);
  try{
    const result=await getReport('journal',params,selectedWorkspace);if(ticket!==sequence||selectedWorkspace!==workspace||!target.isConnected)return;
    const items=append?[...journalPage.items,...result.items]:result.items;journalPage={...result,items,filters:append?journalPage.filters:params};
    target.innerHTML=items.length?items.map(journalMarkup).join(''):'<p class="empty-note">Seçili filtrelerde kayıt bulunamadı.</p>';
    updateJournalFilters();$('#report-more').hidden=!result.nextCursor;metadata(result.revision,null);notice.textContent=items.length+' kayıt gösteriliyor. Veri sürümü '+result.revision+'.';
  }catch(error){if(ticket===sequence&&target.isConnected){journalPage=null;updateJournalFilters();target.innerHTML='<div class="empty-state"><h2>'+ (denied(error)?'Bu rapora erişim izni yok':'Hareket listesi alınamadı') +'</h2><p>'+esc(error.message)+'</p><button id="journal-reload" class="button secondary" type="button">Listeyi yeniden yükle</button></div>';$('#report-more').hidden=true;notice.textContent='Liste güncel olarak doğrulanamadı.';$('#journal-reload').addEventListener('click',()=>loadJournal());}}
  finally{if(ticket===sequence)setBusy(false);}
}
async function refresh() {
  if(busy)return;rememberFilters();const ticket=++sequence,selectedWorkspace=workspace;status('Son kayıtlar okunuyor…');setBusy(true);$('#report-main').innerHTML='<section class="empty-state"><h1>Rapor hazırlanıyor</h1><p>Defterin son kayıtları okunuyor.</p></section>';
  try{const result=await getReport('overview',{},selectedWorkspace);if(ticket!==sequence||selectedWorkspace!==workspace)return;data=result;status('Rapor güncel kayıtlarla hazır.');setBusy(false);render();}
  catch(error){if(ticket===sequence&&selectedWorkspace===workspace){data=null;metadata(null,null);status('Rapor alınamadı. Gösterilecek güncel veri doğrulanamadı.',true);$('#report-main').innerHTML='<section class="empty-state"><h1>'+ (denied(error)?'Bu rapora erişim izni yok':'Rapor açılamadı') +'</h1><p>'+esc(error.message)+'</p><button id="report-retry" class="button" type="button">Yeniden dene</button></section>';$('#report-retry').addEventListener('click',refresh);}}
  finally{if(ticket===sequence)setBusy(false);}
}
document.querySelector('.report-nav').addEventListener('click',event=>{const button=event.target.closest('[data-report-view]');if(!button||busy)return;rememberFilters();view=button.dataset.reportView;++sequence;render();$('#report-main').focus({preventScroll:true});});
$('#report-refresh').addEventListener('click',refresh);
$('#report-workspace').addEventListener('change',()=>{if(busy){$('#report-workspace').value=workspace;return;}rememberFilters();workspace=$('#report-workspace').value;$('#report-main').textContent='';data=null;++sequence;refresh();});
refresh();

function ensureVisibleControl(event){
 const el=event.target;if(!el.matches?.('input,select,button,a,strong[tabindex="0"]')||el.closest('.report-nav'))return;
 requestAnimationFrame(()=>{const nav=$('.report-nav'),r=el.getBoundingClientRect(),fixed=getComputedStyle(nav).position==='fixed';const edge=Math.min(window.visualViewport?.height||innerHeight,fixed?nav.getBoundingClientRect().top:innerHeight);if(r.bottom>edge-12)window.scrollBy({top:r.bottom-edge+20,behavior:'instant'});});
}
document.addEventListener('focusin',ensureVisibleControl);
