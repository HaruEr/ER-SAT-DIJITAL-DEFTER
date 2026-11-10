const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const units = new Proxy({ TL: { scale: 100, digits: 2, label: 'TL' }, USD: { scale: 100, digits: 2, label: 'USD' }, EUR: { scale: 100, digits: 2, label: 'EUR' }, GRAM: { scale: 1000, digits: 3, label: 'gr' }, HAS: { scale: 1000, digits: 3, label: 'has gr' }, SILVER: { scale: 1000, digits: 3, label: 'saf gümüş gr' }, ADET: { scale: 1, digits: 0, label: 'adet' } }, { get: (known, code) => Object.hasOwn(known, code) ? known[code] : { scale: 100, digits: 2, label: String(code) } });
let state, view = 'overview', transactionTab = 'sale', busy = false, editingTransaction = null, partyReturnContext = null;
let busyControls = new Map();
let recoveryGeneration = 0;
let workspace = localStorage.getItem('defter-workspace') === 'dukkan' ? 'dukkan' : 'demo';
let pending = readPending();
const journalFilterMemory = new Map();
const workbenchMemory = new Map();
const supplierMemory = new Map();
let supplierModule, supplierWorkspace, supplierWorkspaceScope, supplierRenderGeneration=0, supplierCompletedDraftKey;
// Drafts stay in this page's memory. Pending committed requests use their separate existing protocol.
const drafts = new Map(), pendingDraftEffects = new Map();
let restoringDraft = false;
const draftForms = new Set(['opening-form','sale-form','movement-form','account-form','collection-form','transfer-form','settlement-form','close-form','stocktake-form','nominal-opening-form','stock-form','bank-form','bank-rename-form','account-edit-form']);
function draftKey(form) { return `${workspace}:${view==='edit'&&editingTransaction?'edit:'+editingTransaction.original.id+':'+form.id:form.id === 'sale-form' ? form.dataset.operation || transactionTab : ['account-form','collection-form'].includes(form.id) ? view + ':' + form.id : form.id}${form.dataset.draftEntity?':'+form.dataset.draftEntity:''}`; }
function draftFields(form) {
  return [...form.querySelectorAll('input,select,textarea')].filter(control => control.type !== 'file' && control.type !== 'password' && !control.matches('[data-item-field],[data-allocation-field]') && (control.name || control.id));
}
function captureDrafts() {
  if (restoringDraft) return;
  for (const form of document.querySelectorAll('#main form[data-draft-key]')) {
    if (form.dataset.draftDirty !== 'true') continue;
    drafts.set(form.dataset.draftKey, { revision: Number(form.dataset.draftRevision), date: form.dataset.draftDate, fields: Object.fromEntries(draftFields(form).map(control => [control.name || control.id, control.value])), sale: form.draftAdapter?.read() });
  }
}
function clearWorkspaceDrafts(selected = workspace) {
  for (const key of supplierMemory.keys()) {
    if (key.startsWith('supplier:draft:')) {
      try { if (JSON.parse(key.slice('supplier:draft:'.length))[0]===selected) supplierMemory.delete(key); } catch {}
    }
  }
  for (const key of drafts.keys()) if (key.startsWith(selected + ':')) drafts.delete(key);
  if (partyReturnContext?.workspace === selected) partyReturnContext = null;
  for (const form of document.querySelectorAll('#main form[data-draft-key]')) if (form.dataset.draftKey.startsWith(selected + ':')) form.dataset.draftDirty = 'false';
}
function prepareDraftForms() {
  for (const form of document.querySelectorAll('#main form')) {
    if ((!draftForms.has(form.id) && !form.id.startsWith('return-form-')) || form.dataset.draftKey) continue;
    const key = draftKey(form), saved = drafts.get(key);
    form.dataset.draftKey = key; form.dataset.draftRevision = String(saved?.revision ?? state.revision); form.dataset.draftDate = saved?.date ?? state.date ?? ''; form.dataset.draftDirty = String(Boolean(saved));
    if (saved) {
      restoringDraft = true;
      try {
        // Category/unit changes rebuild dependent selects; repeat once to restore their selected values.
        for (let pass = 0; pass < 2; pass++) for (const control of draftFields(form)) if (Object.hasOwn(saved.fields, control.name || control.id)) {
          const value = saved.fields[control.name || control.id];
          if (control.tagName !== 'SELECT' || [...control.options].some(option => option.value === value)) control.value = value;
          control.dispatchEvent(new Event(control.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
        }
        if (saved.sale) form.draftAdapter?.restore(saved.sale);
      } finally { restoringDraft = false; }
    }
    const stale = saved && (saved.revision !== state.revision || saved.date !== (state.date ?? ''));
    form.dataset.draftStale = String(Boolean(stale));
    const bar = document.createElement('div'); bar.className = stale ? 'info neutral' : 'draft-status';
    const count = ['close-form','stocktake-form'].includes(form.id);
    bar.innerHTML = `<${stale ? 'p' : 'span'}${stale ? ' data-draft-stale role="alert"' : ''}>${stale ? count ? 'Bu sayım eski kayıt sürümüne veya iş gününe ait. Değerler yalnız inceleme için korundu; taslağı temizleyip güncel mevcutlarla yeniden sayın.' : 'Bu taslak hazırlanırken defter değişti. Hesapları, miktarları ve karşılıkları güncel bilgilerle yeniden kontrol edin.' : 'Taslak · Bu sayfa kapanınca silinir.'}</${stale ? 'p' : 'span'}><button type="button" class="button secondary compact" data-clear-draft>Taslağı temizle</button>${stale && !count ? '<button type="button" class="button secondary compact" data-review-draft>Güncel bilgilerle kontrol ettim</button>' : ''}`;
    form.prepend(bar);
    if (stale) for (const button of form.querySelectorAll('button[type="submit"]')) button.disabled = true;
    bar.querySelector('[data-clear-draft]').addEventListener('click', () => { if (pending) { inform('Önce sonucu belirsiz son isteği doğrulayın. Taslak temizlenmedi.', true); return; } drafts.delete(key); form.dataset.draftDirty = 'false'; render(); $('#main').focus({ preventScroll: true }); inform('Bu işlem taslağı temizlendi. Kayıtlı hareketler değiştirilmedi.'); });
    bar.querySelector('[data-review-draft]')?.addEventListener('click', () => { captureDrafts(); const draft = drafts.get(key); if (draft) { draft.revision = state.revision; draft.date = state.date ?? ''; } form.dataset.draftDirty = 'false'; render(); $('#main').focus({ preventScroll: true }); });
    form.addEventListener('submit', event => { if (form.dataset.draftStale === 'true') { event.preventDefault(); event.stopImmediatePropagation(); inform(count ? 'Eski sayım gönderilmedi. Taslağı temizleyip güncel sayımı yeniden girin.' : 'Taslak gönderilmedi. Önce güncel bilgileri kontrol ederek onaylayın.', true); } }, true);
  }
}
document.addEventListener('input', event => { const form = event.target.closest('form[data-draft-key]'); if (form && !restoringDraft) form.dataset.draftDirty = 'true'; });
document.addEventListener('change', event => { const form = event.target.closest('form[data-draft-key]'); if (form && !restoringDraft) form.dataset.draftDirty = 'true'; });
window.addEventListener('beforeunload', event => { captureDrafts(); if (drafts.size || pending) { event.preventDefault(); event.returnValue = ''; } });
const countGroupLabel = group => ({'ana-terazi':'ANA TERAZİ · 14 AYAR / 22 AYAR / BİLEZİK',gunluk:'GÜNLÜK DEFTER · ADET, PARA VE GRAM ALTIN TOPLAMI', 'gram-havuzu':'GRAM ALTIN · AYRI AĞIRLIK HAVUZU'})[group] || 'DİĞER MEVCUT';
const api = path => `/api/${path}?workspace=${workspace}`;
function readPending() { try { return JSON.parse(sessionStorage.getItem(`defter-pending-${workspace}`)) || null; } catch { return null; } }
function savePending(value) { pending = value; if (value) sessionStorage.setItem(`defter-pending-${workspace}`, JSON.stringify(value)); else sessionStorage.removeItem(`defter-pending-${workspace}`); $('#retry-bar').hidden = !pending; }
function formatted(value, unit = 'TL') { const u = units[unit]; return `${new Intl.NumberFormat('tr-TR', { minimumFractionDigits: u.digits, maximumFractionDigits: u.digits }).format((value || 0) / u.scale)} ${u.label}`; }
function raw(value, unit) { return ((value || 0) / units[unit].scale).toFixed(units[unit].digits); }
function day(value) { return value ? new Date(`${value}T12:00:00`).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' }) : 'Başlangıç devri bekleniyor'; }
function today() { const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(p => [p.type, p.value])); return `${parts.year}-${parts.month}-${parts.day}`; }
function account(id) { return state.accounts.find(a => a.id === id); }
function activeAccounts() { return state.accounts.filter(a => !a.retired).sort((a,b)=>(a.displayOrder??90)-(b.displayOrder??90)); }
function summaryAccountLabel(id) { const a = account(id); return esc(a?.name || id) + (a?.retired ? '<br><small>Eski hesap · yeni işleme kapalı</small>' : ''); }
function inform(message, error = false) {
  const notice = $('#notice');
  notice.setAttribute('role', error ? 'alert' : 'status');
  notice.setAttribute('aria-live', error ? 'assertive' : 'polite');
  notice.setAttribute('aria-atomic', 'true');
  notice.textContent = message; notice.className = `notice${error ? ' error' : ''}`; notice.hidden = false;
  if (error && !document.activeElement?.closest('form')) {
    notice.tabIndex = -1; notice.focus({ preventScroll: true });
    notice.scrollIntoView?.({ block: 'nearest' });
  }
}
function setBusy(value) {
  if (value && !busy) {
    busyControls = new Map([...document.querySelectorAll('button, input, select, textarea')].map(control => [control, control.disabled]));
    for (const control of busyControls.keys()) control.disabled = true;
  } else if (!value) {
    for (const [control, disabled] of busyControls) if (control.isConnected) control.disabled = disabled;
    busyControls.clear();
  }
  busy = value;
  document.body.setAttribute('aria-busy', String(value));
}
async function request(path, body, selectedWorkspace = workspace, { raw = false, query = {} } = {}) {
  const compact = ['state','command','restore'].includes(path) ? { view: 'compact' } : {};
  const parameters = new URLSearchParams({ ...compact, ...query, workspace: selectedWorkspace });
  const session = window.DefterSession?.current();
  const headers = session ? { Authorization: 'Bearer ' + session.token } : {};
  if (body) headers['Content-Type'] = raw ? 'application/x-ndjson' : 'application/json';
  const response = await fetch(`/api/${path}?${parameters}`, body ? { method: 'POST', headers, body: raw ? body : JSON.stringify(body) } : { headers });
  if (response.status === 401 && window.DefterSession) window.DefterSession.lock();
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error || 'İstek tamamlanamadı.'); error.status = response.status; throw error; }
  return result;
}
async function refresh(announce = true) {
  if (busy) return;
  if (pending) { await submit(pending.command, 'Bekleyen kayıt sorgulandı.', pending, undefined, true); return; }
  captureDrafts();
  const selectedWorkspace = workspace, generation = ++recoveryGeneration;
  const previousFocus = document.activeElement;
  if (!state) { $('#business-date').textContent = 'Yükleniyor…'; $('#main').innerHTML = '<div class="loading" role="status"><strong>Defter açılıyor…</strong><span>Yerel kayıtlar hazırlanıyor.</span></div>'; }
  setBusy(true);
  try { const loaded = await request('state', undefined, selectedWorkspace); if (workspace !== selectedWorkspace || generation !== recoveryGeneration) return; state = loaded; render(); if (!previousFocus?.isConnected) $('#main').focus({ preventScroll: true }); if (announce) inform('Defter yenilendi. Sayım formu açıksa fiziki sayıları yeniden kontrol ederek girin.'); }
  catch (e) { if (workspace !== selectedWorkspace || generation !== recoveryGeneration) return; if (!state) renderLoadError(e.message); inform(`Defter bilgileri alınamadı: ${e.message}`, true); }
  finally { setBusy(false); if (workspace !== selectedWorkspace) await refresh(announce); }
}
function renderLoadError(message) {
  $('#business-date').textContent = 'Bilgi alınamadı';
  $('#main').innerHTML = `<section class="load-error section" aria-labelledby="load-error-title"><span class="eyebrow">DEFTERE ERİŞİM</span><h1 id="load-error-title">Defter açılamadı</h1><p>Önce yeniden deneyin. Defter yine açılamıyorsa seçili alana ait JSON yedeği veya akışlı arşivle kurtarma seçeneklerini kontrol edebilirsiniz.</p><p class="context-note">${esc(message)}</p><div class="recovery-actions"><button id="load-retry" class="button" type="button">Tekrar dene</button><button id="load-recovery" class="button secondary" type="button">Yedekten kurtar</button></div><div id="recovery-panel" class="recovery-panel"></div></section>`;
  $('#load-retry').addEventListener('click', () => refresh());
  $('#load-recovery').addEventListener('click', openRecovery);
  $('#retry-bar').hidden = !pending;
}
async function openRecovery() {
  if (busy) return;
  if (pending) { inform('Önce sonucu belirsiz son isteği doğrulayın. Bekleyen işlem varken yedekten kurtarma başlatılamaz.', true); return; }
  const panel = $('#recovery-panel'); if (!panel) return;
  const selectedWorkspace = workspace, generation = ++recoveryGeneration;
  const current = () => selectedWorkspace === workspace && generation === recoveryGeneration && panel.isConnected;
  panel.innerHTML = '<p role="status">Kurtarma bilgileri kontrol ediliyor…</p>'; setBusy(true);
  try {
    const metadata = await request('recovery', undefined, selectedWorkspace);
    if (!current()) return;
    if (!metadata || metadata.workspace !== selectedWorkspace || !Number.isSafeInteger(metadata.revision) || metadata.revision < 0 || metadata.canRestore !== true) {
      panel.innerHTML = '<div class="info neutral" role="status">Bu alan için güvenli geri yükleme hazırlığı doğrulanamadı. Kayıt dosyalarını değiştirmeyin; teknik kurtarma desteği alın veya defteri yeniden yükleyin.</div>'; return;
    }
    if (pending) { panel.textContent = 'Önce sonucu belirsiz son isteği doğrulayın.'; return; }
    panel.innerHTML = '<h2>Yedekten kurtarma</h2><p class="subtitle">Mevcut kayıtların sağlıklı olduğu doğrulanmadı. Sunucu yalnız geri yükleme öncesinde geçmişi arşivlemeye hazırlanabildiğini bildirdi.</p><div id="restore-panel">' + restoreFormMarkup() + '</div>';
    bindRestoreForm({ revision: metadata.revision, selectedWorkspace, recovery: true }); connectFieldHints(panel);
    $('#f-backupFile').focus();
  } catch {
    if (current()) { panel.textContent = 'Kurtarma bilgileri alınamadı. Yerel sunucuyu kontrol edip yeniden deneyin; kayıt dosyalarını değiştirmeyin.'; inform('Kurtarma bilgileri alınamadı. Henüz geri yükleme yapılmadı.', true); }
  } finally { setBusy(false); if (workspace !== selectedWorkspace) await refresh(); }
}
async function lookupPendingCommand(content) {
  let cursor,revision,total,found=null,count=0;const seen=new Set(),cursors=new Set();
  do {
    const page=await request('journal',undefined,workspace,{query:{scope:'all',q:content.id,limit:100,...(cursor?{cursor}:{})}});
    if(!Array.isArray(page.items)||!Number.isSafeInteger(page.revision)||!Number.isSafeInteger(page.total)||page.total<0||(revision!==undefined&&page.revision!==revision)||(total!==undefined&&page.total!==total))throw Error('Bekleyen kaydın sorgusu doğrulanamadı. İşlem yeniden gönderilmedi.');
    revision=page.revision;total=page.total;
    for(const entry of page.items){if(seen.has(entry.id))throw Error('Kayıt sorgusu tekrar ediyor. İşlem yeniden gönderilmedi.');seen.add(entry.id);count++;if(entry.id===content.id)found=entry;}
    cursor=page.nextCursor;
    if(cursor!==null&&(typeof cursor!=='string'||!cursor||!page.items.length||cursors.has(cursor)))throw Error('Kayıt sorgusu tamamlanamadı. İşlem yeniden gönderilmedi.');
    if(cursor)cursors.add(cursor);
  }while(cursor);
  if(count!==total)throw Error('Kayıt sorgusunun tamamı doğrulanamadı. İşlem yeniden gönderilmedi.');
  if(found){
    const actor=window.DefterSession?.current()?.actor;
    const expectedType=['amend','supplierAmend'].includes(content.command.type)?content.command.replacement?.type:content.command.type;
    if(found.type!==expectedType||found.date!==content.command.date||(actor&&found.actor?.id!==actor.id))throw Error('Kayıt anahtarı bekleyen işlemle eşleşmedi. İşlem yeniden gönderilmedi; kaydı kontrol edin.');
  }
  const loaded=await request('state');
  if(loaded.revision!==revision)throw Error('Sorgu sırasında defter değişti. Bekleyen kaydı yeniden sorgulayın.');
  return {found,state:loaded,duplicate:Boolean(found),queried:true};
}
async function submit(command, message = 'İşlem kaydedildi.', envelope, effect, lookupOnly = false) {
  if (busy) return false;
  if(!envelope&&view==='edit'&&editingTransaction&&command.type===editingTransaction.original.type){
    if(editingTransaction.revision!==state.revision||editingTransaction.date!==state.date){inform('Defter değişti. Düzenlemeyi Günlük İşlemler ekranından yeniden açın.',true);return false;}
    const reason=$('#amend-reason');if(!reason?.reportValidity())return false;
    const form=$('#edit-operation form');effect={...effect,key:form?.dataset.draftKey};
    command={type:'amend',originalId:editingTransaction.original.id,replacement:command,note:reason.value};message='İşlem düzenlendi. Eski kayıt ve düzeltme izi korundu.';
  }
  captureDrafts();
  const previousFocus = document.activeElement;
  const content = envelope || { id: crypto.randomUUID(), revision: state.revision, command: { ...command, ...(command.type !== 'opening' ? { date: state.date } : {}) } };
  if (pending && pending.id !== content.id) { inform('Önce sonucu belirsiz son isteği sorgulayın. Yeni bir işlem oluşturulmadı.', true); return false; }
  if (!pendingDraftEffects.has(content.id)) {
    const formId = { opening:'opening-form', sale:'sale-form', purchase:'sale-form', stock:'sale-form', account:'account-form', fundAccount:'bank-form', stockAccount:'stock-form', stockUpdate:'stock-form', fundUpdate:'bank-rename-form', accountUpdate:'account-edit-form', movement:'movement-form', collection:'collection-form', transfer:'transfer-form', settlement:'settlement-form', close:'close-form', stocktake:'stocktake-form', nominalOpening:'nominal-opening-form' }[command.type];
    const form = formId ? document.getElementById(formId) : null;
    pendingDraftEffects.set(content.id, { key: form?.dataset.draftKey, baseRevision: state?.revision ?? content.revision, baseDate: state?.date ?? content.command.date, ...effect });
  }
  $('#retry-bar span').textContent = envelope ? 'Bekleyen kayıt defterde sorgulanıyor…' : 'İşlem kaydediliyor…';
  savePending(content); setBusy(true);
  let sent=false;
  try {
    let result=envelope?await lookupPendingCommand(content):null;
    if(result&&!result.found&&lookupOnly){state=result.state;render();inform('Bu kayıt anahtarı defterde bulunamadı. Yeniden dene düğmesi önce tekrar sorgular, ardından aynı anahtarla gönderir.',true);return false;}
    if(!result?.found){sent=true;$('#retry-bar span').textContent='İşlem kaydediliyor…';result=await request('command', content);}
    savePending(null); state = result.state;
    const completed = pendingDraftEffects.get(content.id); pendingDraftEffects.delete(content.id);
    if (completed?.key) drafts.delete(completed.key);
    if (completed?.supplierDraftKey) {
      supplierMemory.delete(completed.supplierDraftKey);
      supplierCompletedDraftKey=completed.supplierDraftKey;
    }
    const returnContext = completed?.partyReturn;
    let createdPartyId;
    if (returnContext && returnContext.workspace === workspace && partyReturnContext === returnContext) {
      const sale = drafts.get(returnContext.saleKey), created = state.accounts.find(a => a.id === 'cari-' + content.id && a.partyType === returnContext.partyType);
      if (sale && created) {
        // Only our own account creation may advance a draft based on the immediately preceding state.
        if (sale.revision === completed.baseRevision && sale.date === completed.baseDate) { sale.revision = state.revision; sale.date = state.date; }
        sale.fields.counterpartyId = created.id;
        if (!returnContext.mode.includes('purchase') && sale.sale && !sale.sale.debt.some(row => row.accountId === created.id) && sale.sale.debt.length < 30) sale.sale.debt.push({ accountId: created.id, quantity: '', valueTL: '' });
        createdPartyId = created.id;
        applyPartyReturn(returnContext);
      }
    }
    for (const form of document.querySelectorAll('#main form[data-draft-key]')) form.dataset.draftDirty = 'false';
    if(content.command.type==='amend'){editingTransaction=null;view='journal';}
    render(); $('#main').focus({ preventScroll: true });
    if (createdPartyId) {
      const selected = $('#f-counterpartyId') || [...document.querySelectorAll('[data-allocation-kind="debt"] select')].find(control=>control.value===createdPartyId);
      (selected || $('#sale-form'))?.scrollIntoView?.({block:'center',behavior:'instant'});selected?.focus({preventScroll:true});
    }
    if(content.command.type==='close'&&result.queried)inform('Kapanış kaydı defterde doğrulandı; ikinci kez gönderilmedi. Dosya yedeğinin durumunu Yedek ekranından ayrıca kontrol edin.',true);
    else if (content.command.type === 'close' && result.backupStatus?.saved === false) inform(`GÜN KAPANDI ve yeni gün açıldı; ancak YEDEK ALINAMADI: ${result.backupStatus.error || 'Dosya yazma hatası. Yedek ekranından uygun yedeği (büyük defter için akışlı arşiv) indirin.'}`, true);
    else if (content.command.type === 'close' && result.backupStatus?.saved) inform(`${result.duplicate ? 'Bu kapanış daha önce kaydedilmişti; ikinci kez işlenmedi.' : message} Dosya yedeği doğrulandı: ${result.backupStatus.filename}`);
    else inform(result.duplicate ? 'Bu işlem daha önce kaydedilmişti. İkinci kez yazılmadı.' : message);
    return true;
  } catch (e) {
    if (sent && e.status >= 400 && e.status < 500) { savePending(null); pendingDraftEffects.delete(content.id); }
    const errorMessage=/Failed to fetch|NetworkError|Load failed/i.test(e.message)?'Sunucu yanıtı alınamadı. Kayıt sonucu belirsiz; yeniden denemeden önce mevcut kayıt sorgulanacak.':e.message;
    if(lookupOnly&&!state)renderLoadError(errorMessage);
    inform(e.status === 409 || /başka sekmede|Veriler değişti|Yenileyip|Ekranı yenileyin/i.test(errorMessage) ? `${errorMessage} Üstteki Yenile düğmesine basın; açık formu ve sayımı yeniden kontrol edin.` : errorMessage, true);
    return false;
  } finally {
    $('#retry-bar span').textContent = 'Son isteğin sonucu doğrulanamadı. Yeniden denemeden önce mevcut kayıt sorgulanır; bulunmazsa aynı anahtarla gönderilir.';
    setBusy(false);
    if (previousFocus?.isConnected && previousFocus.closest('form')) previousFocus.focus({ preventScroll: true });
  }
}
function heading(title, subtitle, action = '') { return `<div class="page-heading"><div><span class="eyebrow">DİJİTAL DEFTER / ${esc(workspace === 'demo' ? 'ÖRNEK ALAN' : 'DÜKKÂN ALANI')}</span><h1>${title}</h1><p class="subtitle">${subtitle}</p></div>${action}</div>`; }
function approvalField(name, label) {
  return '<label>' + esc(label) + '<input readonly id="f-' + name + '" name="' + name + '" value="' + esc(window.DefterSession?.current()?.actor.name) + '"></label>';
}
function field(name, label, { value = '', hint = '', type = 'text', required = true, full = false, options, max = 160 } = {}) {
  const attrs = `name="${esc(name)}" id="f-${esc(name)}" ${required ? 'required aria-required="true"' : ''}${hint ? ` aria-describedby="f-${esc(name)}-hint"` : ''}`;
  const control = options ? `<select ${attrs}>${options.map(([v, t]) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>` : `<input ${attrs} type="${type}" value="${esc(value)}" ${type === 'text' ? `maxlength="${max}"` : ''} ${type === 'text' && /quantity|cash|pos|bank|total|value|opening|gross|fee|count|balance/i.test(name) ? 'inputmode="decimal" autocomplete="off"' : ''}>`;
  return `<label class="field${full ? ' full' : ''}" for="f-${esc(name)}"><span>${label}${required ? '<span class="field-required" aria-hidden="true">zorunlu</span>' : ''}</span>${control}${hint ? `<small class="field-hint" id="f-${esc(name)}-hint">${esc(hint)}</small>` : ''}</label>`;
}
function connectFieldHints(container) {
  container.querySelectorAll('label.field').forEach(label => {
    const control = label.querySelector('input, select, textarea'), hint = label.querySelector('small:not(.field-required):not(.field-error)');
    if (!control) return;
    if (control.required) control.setAttribute('aria-required', 'true'); else control.removeAttribute('aria-required');
    if (hint && control.id) {
      hint.id ||= `${control.id}-hint`;
      control.setAttribute('aria-describedby', [...new Set([...(control.getAttribute('aria-describedby') || '').split(' ').filter(Boolean), hint.id])].join(' '));
    }
  });
}
function clearFieldError(control) {
  if (!control.id) return;
  const errorId = `${control.id}-error`;
  document.getElementById(errorId)?.remove(); control.removeAttribute('aria-invalid');
  const described = (control.getAttribute('aria-describedby') || '').split(' ').filter(id => id && id !== errorId);
  if (described.length) control.setAttribute('aria-describedby', described.join(' ')); else control.removeAttribute('aria-describedby');
}
function enhanceTables(container) {
  container.querySelectorAll('.table-wrap').forEach(wrapper => {
    const table = wrapper.querySelector('table'); if (!table) return;
    const title = wrapper.closest('.journal-item')?.querySelector('.journal-head strong')?.textContent || wrapper.closest('section')?.querySelector('h2, h3')?.textContent || $('#main h1')?.textContent || 'Defter';
    const columns = [...table.querySelectorAll('thead th')].slice(0, 2).map(cell => cell.textContent.trim()).join(', ');
    wrapper.tabIndex = 0; wrapper.setAttribute('role', 'region'); wrapper.setAttribute('aria-label', `${title} · ${columns} tablosu; yatay kaydırılabilir`);
  });
}
function action(label, note = 'Tüm bağlı hareketler tek kayıt olarak işlenir.') { return `<div class="form-actions"><span class="muted">${note}</span><button class="button" type="submit">${label}</button></div>`; }
const formValues = form => Object.fromEntries(new FormData(form).entries());
function setView(next) {
  setNavigationOpen(false);
  captureDrafts();
  if (partyReturnContext && (partyReturnContext.workspace !== workspace || next !== partyReturnContext.ownerView)) partyReturnContext = null;
  view = next; $('#notice').hidden = true; render(); $('#main').focus({ preventScroll: true });$('#main').scrollIntoView?.({block:'start',behavior:'instant'});
}
function canonicalTransactionRoute() {
  if (view !== 'transaction') return false;
  const route = { transfer:['banks','transfer'], settlement:['banks','settlement'], account:['accounts','new'], fund:['banks','new'], stock:['stocks','stock'], 'supplier-purchase':['suppliers','supplier-purchase'], 'supplier-collection':['suppliers','collection'] }[transactionTab];
  if (!route) return false;
  const [owner,operation] = route;
  workbenchMemory.set(`${workspace}:${owner}`, {...workbenchMemory.get(`${workspace}:${owner}`), editor:operation==='new'?'new':null, operation:operation==='new'?null:operation});
  transactionTab = ['transfer','settlement','fund'].includes(transactionTab) ? 'movement' : 'sale';
  view = owner;
  return true;
}
function openOwnedOperation(owner, operation) {
  captureDrafts();
  workbenchMemory.set(`${workspace}:${owner}`, {...workbenchMemory.get(`${workspace}:${owner}`), editor:null, operation});
  setView(owner);
  (owner==='banks'?$('#bank-operation'):$('#special-operation'))?.scrollIntoView?.({block:'start',behavior:'instant'});
}
function startPartyCreation(form, mode) {
  if (busy || pending) { inform('Önce sonucu belirsiz son isteği doğrulayın.', true); return; }
  form.dataset.draftDirty = 'true'; captureDrafts();
  const supplier = mode.startsWith('supplier-'), ownerView = supplier ? 'suppliers' : 'accounts';
  partyReturnContext = {workspace, ownerView, sourceView:view, mode, saleKey:form.dataset.draftKey, partyType:supplier?'supplier':'customer'};
  workbenchMemory.set(`${workspace}:${ownerView}`, {...workbenchMemory.get(`${workspace}:${ownerView}`), editor:'new', operation:null});
  setView(ownerView);
  $('#f-name')?.focus({preventScroll:true});$('#f-name')?.scrollIntoView?.({block:'center',behavior:'instant'});
}
function applyPartyReturn(context) {
  workbenchMemory.set(`${workspace}:${context.ownerView}`, {...workbenchMemory.get(`${workspace}:${context.ownerView}`), editor:null, operation:context.sourceView==='suppliers'?context.mode:null});
  view = context.sourceView;
  if (view === 'transaction') transactionTab = context.mode;
  partyReturnContext = null;
}
function returnToPartyOperation(context) {
  if (busy || pending) { inform('Önce sonucu belirsiz son isteği doğrulayın.', true); return; }
  if (partyReturnContext !== context || context.workspace !== workspace) return;
  captureDrafts(); applyPartyReturn(context); render();
  const target=$('#f-counterpartyId')||document.querySelector('[data-item-field="accountId"]');target?.focus({preventScroll:true});target?.scrollIntoView?.({block:'center',behavior:'instant'});
}
function render() {
  if (!state) return;
  captureDrafts();
  canonicalTransactionRoute();
  supplierRenderGeneration++;
  if (supplierWorkspace && (view!=='suppliers'||supplierWorkspaceScope!==workspace||!state.initialized)) {
    supplierWorkspace.destroy(); supplierWorkspace=null;
  }
  if (partyReturnContext && (partyReturnContext.workspace!==workspace || partyReturnContext.ownerView!==view)) partyReturnContext=null;
  $('#workspace').value = workspace;
  $('#business-date').textContent = day(state.date);
  const banner = $('#workspace-banner');
  banner.className = `workspace-banner${workspace === 'dukkan' ? ' real' : ''}`;
  banner.textContent = workspace === 'demo' ? 'ÖRNEK DEFTER · Deneme kayıtları ayrı tutulur. Buradaki miktar ve fiyatlar gerçek işletme verisi değildir.' : 'DÜKKÂN DEFTERİ · Bu yeni uygulamanın ayrı yerel kayıt alanı. Mevcut Excel verileri içe aktarılmadı; ilk sürümü önce örnek alanda doğrulayın.';
  document.querySelectorAll('[data-view]').forEach(b => { b.classList.toggle('active', b.dataset.view === view); b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false'); });
  $('#retry-bar').hidden = !pending;
  if (!state.initialized && !['backup'].includes(view)) renderOpening();
  else ({ overview: renderOverview, transaction: renderTransaction, accounts: renderAccounts, stocks: () => renderAccounts(true), suppliers: renderSupplierPage, banks: renderBanks, edit:renderEditPage, closing: renderClosing, journal: renderJournal, summary: renderSummary, backup: renderBackup }[view] || renderOverview)();
  const dayWarning = $('#workday-warning');
  dayWarning.hidden = !state.initialized || state.date === today();
  dayWarning.textContent = dayWarning.hidden ? '' : `Açık iş günü ${day(state.date)}; bugün ${day(today())}. Yeni kayıtlar açık iş gününe yazılır. Sayım ve kapanıştan iş gününü kontrol edin.`;
  renderNominalOpeningGate();
  connectFieldHints($('#main'));
  enhanceTables($('#main'));
  prepareDraftForms();
  document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => { if (b.dataset.go === 'transaction' && b.dataset.quickAction) transactionTab = b.dataset.quickAction; setView(b.dataset.go); }));
}
async function renderSupplierPage() {
  if (supplierWorkspace) {
    supplierWorkspace.update(state,{completedDraftKey:supplierCompletedDraftKey});
    supplierCompletedDraftKey=undefined;
    return;
  }
  const generation=supplierRenderGeneration, selectedWorkspace=workspace;
  $('#main').innerHTML='<section class="supplier-workspace" aria-label="Toptancılar"><p role="status">Firma ekranı yükleniyor…</p></section>';
  try {
    supplierModule ||= import('./suppliers.js');
    const {renderSupplierWorkspace}=await supplierModule;
    if (generation!==supplierRenderGeneration||view!=='suppliers'||workspace!==selectedWorkspace) return;
    supplierWorkspaceScope=workspace;
    supplierWorkspace=renderSupplierWorkspace($('#main .supplier-workspace'),{
      state,workspace,memory:supplierMemory,request,refresh,escape:esc,format:formatted,day,parseAmount,
      onInteraction() {
        const notice=$('#notice');
        if(!pending&&notice.getAttribute('role')==='status') { notice.hidden=true;notice.textContent=''; }
      },
      isPending:()=>Boolean(pending),submit:(command,message,effect)=>submit(command,message,undefined,effect),
      async exportPdf(snapshot) { const {exportSupplierPdf}=await import('./supplier-pdf.js');await exportSupplierPdf(snapshot); },
      printReport(markup) {
        document.getElementById('statement-print-snapshot')?.remove();
        const node=document.createElement('section');node.id='statement-print-snapshot';node.innerHTML=markup;
        prepareStatementPrint(node);document.body.append(node);document.body.dataset.printScope='statement';
        const cleanup=()=>{node.remove();delete document.body.dataset.printScope;window.removeEventListener('afterprint',cleanup);};
        window.addEventListener('afterprint',cleanup);
        try {window.print();} catch(error) {cleanup();throw error;}
      }
    });
  } catch(error) {
    supplierModule=null;
    if (generation===supplierRenderGeneration&&view==='suppliers') {
      $('#main').innerHTML='<p role="alert">Firma ekranı yüklenemedi. Yenile düğmesiyle yeniden deneyin.</p>';
      inform(error.message,true);
    }
  }
}
function renderOpening() {
  const openingAccounts = activeAccounts().filter(a => a.id !== 'banka');
  const groups = [['ana-terazi','1 · ANA TERAZİ'],['money','2 · BAŞLANGIÇ KASA'],['stock','3 · BAŞLANGIÇ STOK']];
  $('#main').innerHTML = heading('İlk Sayfayı Aç', 'Kasayı, ürünleri ve ana teraziyi bir kez bildirin. Bankalarınızı ayrı ayrı ekleyebilirsiniz.', workspace === 'demo' ? '<button class="button secondary" id="demo-seed" type="button">Örnek günü hazırla</button>' : '') +
    `<section class="section"><form id="opening-form">${field('date','İlk iş günü',{type:'date',value:today()})}${groups.map(([key,label])=>`<details class="opening-group" open><summary>${label}</summary><div class="form-grid">${openingAccounts.filter(a=>key==='ana-terazi'?a.countGroup==='ana-terazi':key==='money'?!['ADET','GRAM'].includes(a.unit):['ADET','GRAM'].includes(a.unit)&&a.countGroup!=='ana-terazi').map(a=>field('balance-'+a.id,esc(a.name)+' · '+esc(units[a.unit].label),{max:24})).join('')}</div></details>`).join('')}<section class="opening-banks"><div class="section-header"><div><h2>4 · Banka hesapları</h2><p class="muted">Her bankayı ve para birimini ayrı ekleyin. Banka hesabınız yoksa boş bırakabilirsiniz.</p></div><button type="button" class="button secondary" id="opening-bank-add">+ Banka ekle</button></div><div id="opening-banks"></div></section><p class="info neutral">Kasa ve stok alanları zorunludur. Mevcut yoksa 0 yazın; boş alan sıfır sayılmaz.</p>${action('Başlangıç devrini onayla','Sonraki işlemler bu başlangıç üzerinden hesaplanır.')}</form></section>`;
  let nextBank=0;
  const addBank=(saved={})=>{
    const key=nextBank++, row=document.createElement('div');row.className='form-grid payment-panel';row.dataset.openingBank=String(key);
    row.innerHTML=`${field('bankName'+key,'Banka / hesap adı',{max:70,value:saved.name||''})}${field('bankUnit'+key,'Para birimi',{value:saved.unit||'TL',options:[['TL','TL'],['USD','USD'],['EUR','EUR'],['GBP','GBP'],['CHF','CHF']]})}${field('bankOpening'+key,'Başlangıç bakiyesi',{value:saved.opening||'0',max:24})}<button type="button" class="button text" data-remove-bank>Bankayı kaldır</button>`;
    row.querySelector('[data-remove-bank]').addEventListener('click',()=>{row.remove();$('#opening-form').dataset.draftDirty='true';});$('#opening-banks').append(row);
  };
  $('#opening-bank-add').addEventListener('click',()=>{addBank();$('#opening-form').dataset.draftDirty='true';});
  $('#opening-form').draftAdapter={read:()=>({banks:[...document.querySelectorAll('[data-opening-bank]')].map(row=>{const key=row.dataset.openingBank;return {name:row.querySelector('[name=bankName'+key+']').value,unit:row.querySelector('[name=bankUnit'+key+']').value,opening:row.querySelector('[name=bankOpening'+key+']').value};})}),restore:saved=>{$('#opening-banks').innerHTML='';for(const bank of saved.banks||[])addBank(bank);}};
  $('#opening-form').addEventListener('submit',event=>{event.preventDefault();const form=event.currentTarget;if(!form.reportValidity())return;const values=formValues(form);submit({type:'opening',date:values.date,balances:{...Object.fromEntries(openingAccounts.map(a=>[a.id,values['balance-'+a.id]])),banka:'0'},banks:form.draftAdapter.read().banks},'Başlangıç kasa, stok ve bankalar kaydedildi.');});
  $('#demo-seed')?.addEventListener('click',seedDemo);
}

function renderOverview() {
  const flow=state.moneyFlow||{incoming:0,outgoing:0,byUnit:{}};
  const foreign=direction=>Object.entries(flow.byUnit||{}).filter(([unit,row])=>unit!=='TL'&&row[direction]).map(([unit,row])=>`<small>${esc(formatted(row[direction],unit))}</small>`).join('');
  const cash=activeAccounts().filter(a=>a.kind==='asset'&&a.physical&&a.unit==='TL').reduce((sum,a)=>sum+(state.balances[a.id]||0),0);
  const physical=activeAccounts().filter(isStockAccount),count=state.overview?.todaysCount??state.journal.filter(e=>e.date===state.date).length;
  $('#main').innerHTML='<div class="overview-screen">'+heading('Günün Görünümü','Kasayı, günlük ödemeleri ve stokları tek bakışta takip edin.')+
    `<div class="stats">${[['Kasadaki Nakit',cash,'Fiziki TL kasalarının anlık toplamı','primary',''],['Bugün Giren',flow.incoming,'Nakit + POS + havale / EFT','','incoming'],['Bugün Çıkan',flow.outgoing,'Yapılan ödemeler ve nakit çıkışları','','outgoing'],['Bekleyen POS',state.balances.pos,'Henüz bankaya geçmeyen alacak','','']].map(([label,value,note,cls,direction])=>`<div class="stat ${cls}"><span class="stat-label">${label}</span><strong class="stat-value"${formatted(value).length>16?' tabindex="0"':''}>${esc(formatted(value))}</strong>${direction?`<div class="stat-subtotals">${foreign(direction)}</div>`:''}<span class="stat-note">${note}</span></div>`).join('')}</div><p class="context-note">İşletme içi kasa–banka aktarımı ve POS'un bankaya geçişi yeniden giriş/çıkış sayılmaz. Dövizler kendi biriminde gösterilir.</p>
    <section class="quick-actions" aria-label="Sık kullanılan işlemler">${[['sale','transaction','Satış Yap','Ürün ve tahsilat'],['purchase','transaction','Alış Yap','Müşteriden ürün al'],['collection','transaction','Cari Tahsilat / Ödeme','Borç ve alacak kapat'],['closing','closing','Günlük Sayım','Say ve günü tamamla']].map(([id,target,title,note],i)=>`<button type="button" class="quick-action" data-quick-action="${id}" data-go="${target}"><span class="quick-icon" aria-hidden="true">${['↗','↙','⇄','✓'][i]}</span><strong>${title}</strong><small>${note}</small></button>`).join('')}</section>
    <div class="split"><section class="section"><div class="section-header"><div><h2>Anlık Stok Durumu</h2><p class="muted">Ürün adedi ve terazi gramı ayrı takip edilir.</p></div><button class="button text" type="button" data-go="stocks">Stok Ekranı →</button></div><div class="table-wrap"><table class="inventory-table"><thead><tr><th>Ürün / stok grubu</th><th class="numeric">Mevcut</th><th>Kontrol</th></tr></thead><tbody>${physical.map(a=>`<tr><td><strong>${esc(a.name)}</strong></td><td class="numeric">${esc(formatted(state.balances[a.id],a.unit))}</td><td><span class="badge">${a.countPolicy==='periodic'?'Dönemsel tartım':'Günlük sayım'}</span></td></tr>`).join('')}</tbody></table></div></section><div><section class="section"><div class="section-header"><h2>Son hareketler</h2><span class="badge gold">${count} işlem · açık gün</span></div>${state.journal.slice(-4).reverse().map(e=>`<div class="balance-row"><span>${esc(e.label)}<small>${esc(day(e.date))}</small></span><span class="badge">${e.meta.revenue?esc(formatted(e.meta.revenue)):e.meta.total?esc(formatted(e.meta.total)):'Kayıtlı'}</span></div>`).join('')}<button class="button secondary" type="button" data-go="journal">Günlük İşlemler</button></section><section class="section"><h2>Hesaplara hızlı erişim</h2><div class="workbench-actions"><button class="button secondary" type="button" data-go="accounts">Müşteriler</button><button class="button secondary" type="button" data-go="suppliers">Toptancılar</button><button class="button secondary" type="button" data-go="banks">Banka/Pos/Kasa</button></div><p class="context-note">Giriş ve çıkış tutarları kâr değildir. Açık alacaklar Müşteri ve Toptancı ekranlarında izlenir.</p></section></div></div></div>`;
  // Match reading and keyboard order to the desktop task hierarchy.
  const overview=$('#main .overview-screen');
  overview.querySelector('.stats').before(overview.querySelector('.quick-actions'));
  const detail=overview.querySelector('.split');
  detail.prepend(detail.lastElementChild);
}
function isStockAccount(a){return a.kind==='asset'&&(a.isSaleable||a.isPurchasable||a.pairedGroups?.length||['bilezik22','taki14','taki22'].includes(a.id));}
function balanceRow(a) {
  const balance=state.balances[a.id]||0;
  return `<div class="balance-row"><span>${esc(a.name)}${a.kind==='receivable'?`<small>${balance>0?'Alacağımız':balance<0?'Borcumuz':'Bakiyesi sıfır'}</small>`:''}</span><strong class="${balance<0?'negative':''}">${a.id==='gramToplam'&&state.nominalUnconfirmed?'Açılış onayı bekliyor':esc(formatted(balance,a.unit))}</strong></div>`;
}
function renderPartyForm(container,supplier=false,existing=null,parent=null){
  captureDrafts();
  const formId=existing?'account-edit-form':'account-form';
  const context=!existing&&!parent&&partyReturnContext?.workspace===workspace&&partyReturnContext.ownerView===view&&partyReturnContext.partyType===(supplier?'supplier':'customer')?partyReturnContext:null;
  const operationName=context?.mode?.endsWith('-exchange')?'cari işlem':context?.mode==='supplier-sale'?'toptancı satış':context?.mode==='sale'?'satış':context?.mode==='supplier-purchase'?'toptancı alış':'müşteriden alış';
  container.innerHTML=`<h2>${existing?'Bilgileri düzenle':parent?esc(parent.name)+' · Bakiye hesabı ekle':supplier?'Toptancı ekle':'Müşteri ekle'}</h2>${context?`<div class="info neutral operation-return"><p>${operationName.charAt(0).toLocaleUpperCase('tr-TR')+operationName.slice(1)} taslağınız korunuyor. Hesabı ekleyince bu taslağa dönülecek; ürün işlemi ayrıca kaydedilecek.</p><button type="button" class="button secondary compact" data-return-operation>Hesap eklemeden ${operationName} işlemine dön</button></div>`:''}<form id="${formId}" data-draft-entity="${esc(existing?.id||'new')}"><div class="form-grid">${field('name','İsim soyisim / şirket',{max:70,value:existing?.name||parent?.name||''})}${field('phone','Telefon · isteğe bağlı',{required:false,max:30,value:existing?.phone||'',type:'tel'})}${field('taxId','TC / VKN · isteğe bağlı',{required:false,max:11,value:existing?.taxId||''})}${field('address','Adres · isteğe bağlı',{required:false,max:300,value:existing?.address||'',full:true})}${existing&&!existing.partyType?field('partyType','Eski hesabın türü',{options:[['customer','Müşteri'],['supplier','Toptancı / firma']],hint:'Bu eski hesabı doğru ekrana taşıyın. Bakiye ve işlem geçmişi korunur.'}):''}${existing?'':field('unit','Hesap birimi',{options:[['TL','TL'],['HAS','Has gram'],...(supplier?[['SILVER','Saf gümüş gram']]:[]),['USD','USD'],['EUR','EUR'],['GBP','GBP'],['CHF','CHF'],['other','Diğer döviz']]})}${existing?'':`<div id="party-other-unit" hidden>${field('currencyCode','Üç harfli döviz kodu',{required:false,max:3})}</div>`}${existing?'':field('opening','Önceden gelen bakiye',{value:'0',hint:'Alacağımız pozitif, borcumuz negatif. Yeni satış / alış burada açılış olarak yazılmaz.'})}</div>${action(existing?'Bilgileri kaydet':context?'Hesabı ekle ve işleme dön':parent?'Bakiye hesabını ekle':supplier?'Toptancıyı ekle':'Müşteriyi ekle','Telefon, TC/VKN ve adres zorunlu değildir.')}</form>`;
  const memoryKey=`${workspace}:${view}`;
  const form=container.querySelector('form');
  if(parent){const unit=form.querySelector('#f-unit'),used=new Set(activeAccounts().filter(a=>a.id===parent.id||a.parentAccountId===parent.id).map(a=>a.unit));for(const option of unit.options)option.disabled=used.has(option.value);unit.value=[...unit.options].find(option=>!option.disabled).value;form.dataset.draftEntity='supplier-unit:'+parent.id;form.querySelector('#f-name').readOnly=true;for(const key of ['phone','taxId','address']){const input=form.querySelector('#f-'+key);input.disabled=true;input.closest('.field').hidden=true;}}
  if(context)form.dataset.draftEntity=`operation:${context.mode}`;
  if(!existing){const unit=form.querySelector('#f-unit'),currency=form.querySelector('#f-currencyCode');const update=()=>{const other=unit.value==='other';form.querySelector('#party-other-unit').hidden=!other;currency.required=other;currency.disabled=!other;if(!other)currency.setCustomValidity('');};unit.addEventListener('change',update);currency.addEventListener('input',()=>{currency.value=currency.value.toUpperCase();currency.setCustomValidity(/^[A-Z]{3}$/.test(currency.value)&&!['TRY','HAS'].includes(currency.value)?'':'Üç harfli döviz kodu yazın.');});update();}
  container.querySelector('[data-return-operation]')?.addEventListener('click',()=>returnToPartyOperation(context));
  form.addEventListener('submit',async e=>{
    e.preventDefault();if(!form.reportValidity())return;
    const values=formValues(form);if(values.unit==='other')values.unit=values.currencyCode.toUpperCase();delete values.currencyCode;
    const effect=context&&partyReturnContext===context?{partyReturn:context}:undefined;
    const saved=await submit({type:existing?'accountUpdate':'account',...values,...(existing?{accountId:existing.id}:{partyType:supplier?'supplier':'customer',...(parent?{parentAccountId:parent.id,name:parent.name}:{})})},context?'Hesap eklendi. Taslağı kontrol edip işlemi kaydedin.':'Hesap bilgileri kaydedildi.',undefined,effect);
    if(saved&&!effect){workbenchMemory.set(memoryKey,{...workbenchMemory.get(memoryKey),editor:null});if(`${workspace}:${view}`===memoryKey)render();}
  });
  prepareDraftForms();connectFieldHints(container);container.querySelector('input')?.focus();
}
function renderStockForm(container,existing=null){
  captureDrafts();
  container.innerHTML=`<h2>${existing?'Stok adını düzenle':'Stok kartı ekle'}</h2><form id="stock-form" data-draft-entity="${esc(existing?.id||'new')}"><div class="form-grid">${field('name','Stok adı',{value:existing?.name||'',max:70})}${existing?'':field('unit','Takip birimi',{options:[['ADET','Adet'],['GRAM','Gram']]})}${existing?'':field('weightGroup','Adetli ürünün terazi grubu',{required:false,options:[['','Terazi bağlantısı yok'],...activeAccounts().filter(a=>a.countGroup==='ana-terazi'&&a.unit==='GRAM').map(a=>[a.id,a.name])]})}${existing?'':field('opening','Başlangıç miktarı',{value:'0',hint:'Teraziye bağlı ürünler sıfırla açılır; adet ve gram girişi Stok Girişi ile birlikte yapılır.'})}</div>${action(existing?'Adı kaydet':'Stok kartını ekle','Mevcut hareket geçmişi korunur.')}</form>`;
  if(!existing){const update=()=>{const isGram=$('#f-unit').value==='GRAM';$('#f-weightGroup').closest('.field').hidden=isGram;$('#f-weightGroup').disabled=isGram;};$('#f-unit').addEventListener('change',update);update();}
  const memoryKey=`${workspace}:${view}`;
  $('#stock-form').addEventListener('submit',async e=>{e.preventDefault();if(!e.currentTarget.reportValidity())return;const values=formValues(e.currentTarget);const saved=await submit(existing?{type:'stockUpdate',accountId:existing.id,name:values.name.toLocaleUpperCase('tr-TR')}:{type:'stockAccount',name:values.name.toLocaleUpperCase('tr-TR'),unit:values.unit,pairedGroups:values.unit==='ADET'&&values.weightGroup?[values.weightGroup]:[],opening:values.opening,isSaleable:true,countPolicy:values.unit==='GRAM'?'periodic':'daily'},'Stok kartı kaydedildi.');if(saved){workbenchMemory.set(memoryKey,{...workbenchMemory.get(memoryKey),editor:null});if(`${workspace}:${view}`===memoryKey)render();}});prepareDraftForms();connectFieldHints(container);
}
async function loadCompleteAccountSnapshot({a,filters,selectedWorkspace,expectedRevision,current,statement,expectedTotal}) {
  const id=a.id,deltaFor=event=>event.entries.filter(row=>row.accountId===id).reduce((sum,row)=>sum+row.delta,0);
  const all=[],seenIds=new Set(),seenCursors=new Set(),context=new Map();let cursor,total=null;
  do{
    const next=await request('journal',undefined,selectedWorkspace,{query:{...filters,scope:'all',limit:'100',...(cursor?{cursor}:{})}});
    if(!current()||next.revision!==expectedRevision)throw new Error('Defter değişti; yenileyip ekstreyi yeniden açın.');
    if(!Array.isArray(next.items)||next.items.length>100||!Number.isSafeInteger(next.total)||next.total<0||(expectedTotal!==undefined&&next.total!==expectedTotal)
        ||(total!==null&&next.total!==total)||(next.nextCursor!==null&&(typeof next.nextCursor!=='string'||!next.nextCursor)))throw new Error('Ekstre sayfası doğrulanamadı.');
    total=next.total;
    if(!next.items.length&&(next.nextCursor||all.length!==total))throw new Error('Ekstre sayfası eksik.');
    for(const event of next.items){
      if(!event||typeof event.id!=='string'||!event.id||seenIds.has(event.id)||!Array.isArray(event.entries)
          ||event.entries.some(row=>typeof row.accountId!=='string'||!Number.isSafeInteger(row.delta)))throw new Error('Ekstre kaydı tekrarlı veya geçersiz.');
      seenIds.add(event.id);all.push(event);
    }
    if(next.receiptContext!==undefined&&!Array.isArray(next.receiptContext))throw new Error('Fiş bağlamı doğrulanamadı.');
    for(const event of next.receiptContext||[])context.set(event.id,event);
    if(all.length>total||(all.length===total&&next.nextCursor))throw new Error('Ekstre kayıt sayısı tutarsız.');
    cursor=next.nextCursor;if(cursor){if(seenCursors.has(cursor))throw new Error('Ekstre sayfalama bilgisi tekrarlandı.');seenCursors.add(cursor);}
  }while(cursor);
  if(all.length!==total)throw new Error('Ekstre eksik; yeniden deneyin.');
  const fresh=await request('account-statement',undefined,selectedWorkspace,{query:filters});
  if(!current()||fresh.revision!==expectedRevision||fresh.account?.id!==id||fresh.account?.unit!==a.unit
      ||!['opening','incoming','outgoing','closing'].every(key=>Number.isSafeInteger(fresh[key])&&fresh[key]===statement[key]))throw new Error('Defter değişti; yenileyip ekstreyi yeniden açın.');
  let balance=fresh.opening,incoming=0,outgoing=0;
  const chronological=all.reverse().map(event=>{
    for(const row of event.entries.filter(row=>row.accountId===id)){if(row.delta>0)incoming+=row.delta;else outgoing-=row.delta;}
    const delta=deltaFor(event);balance+=delta;if(!Number.isSafeInteger(balance)||!Number.isSafeInteger(delta))throw new Error('Ekstre bakiyesi doğrulanamadı.');
    return {event,delta,balance};
  });
  if(balance!==fresh.closing||incoming!==fresh.incoming||outgoing!==fresh.outgoing)throw new Error('Ekstre hareketleri ile toplamları eşleşmiyor.');
  for(const event of all)context.set(event.id,event);
  return {rows:chronological,context:[...context.values()],statement:fresh,generatedAt:new Date().toLocaleString('tr-TR')};

}

function prepareStatementPrint(snapshotNode){
    for(const details of snapshotNode.querySelectorAll('details'))details.open=true;
    for(const article of snapshotNode.querySelectorAll('.statement-print-record')){
      if(article.querySelectorAll('.receipt-flow-row').length<=12&&article.textContent.length<=4500)continue;
      article.classList.add('long-receipt');
      // Native table headers repeat on printed continuation pages. Move the
      // existing receipt content; do not derive amounts or omit any rows.
      for(const group of article.querySelectorAll('.receipt-flow-group')){
        const table=document.createElement('table');table.className='receipt-print-flow-table';
        const header=document.createElement('th');header.scope='col';
        header.textContent=`${article.dataset.unitLabel?article.dataset.unitLabel+' · ':''}${group.querySelector('h4').textContent} · Kayıt: ${article.dataset.statementRecord}`;
        table.createTHead().insertRow().append(header);const body=table.createTBody();
        const rows=[...group.querySelectorAll('.receipt-flow-row')];
        for(const row of rows){const content=document.createElement('div');content.className='receipt-flow-row';content.append(...row.childNodes);body.insertRow().insertCell().append(content);}
        if(!rows.length)body.insertRow().insertCell().textContent=group.querySelector('.receipt-flow-empty')?.textContent||'Hareket yok.';
        group.replaceWith(table);
      }
    }
}

function renderAccounts(stock=false){
  const expectedView=stock?'stocks':'accounts',selectedWorkspace=workspace,expectedRevision=state.revision;
  const memoryKey=`${workspace}:${expectedView}`,memory={q:'',unit:'',sign:'all',...workbenchMemory.get(memoryKey)};
  const remember=changes=>workbenchMemory.set(memoryKey,{...workbenchMemory.get(memoryKey),...changes});
  const rows=activeAccounts().filter(a=>stock?isStockAccount(a):a.kind==='receivable'&&(a.partyType||'customer')==='customer');
  const prefix=stock?'stock':'account';
  $('#main').innerHTML=heading(stock?'Stok Ekranı':'Müşteri Ekranı',stock?'Stokları inceleyin, kart ekleyin ve ürün adlarını düzenleyin.':'Müşterilerinizi bulun, bakiyelerini ve işlem dökümlerini inceleyin.',`<button type="button" class="button" id="${stock?'add-stock':'add-account'}">+ ${stock?'Stok ekle':'Müşteri ekle'}</button>`)+
    `${stock?'<section class="section"><div class="workbench-actions"><button class="button secondary" type="button" id="stock-movement">Stok Girişi / Çıkışı</button><button class="button secondary" type="button" data-go="closing">Sayım ile stok düzelt</button></div><div id="special-operation"></div></section>':''}<section class="section" id="card-editor" hidden></section><section class="section"><div class="workbench-filters"><label class="field"><span>${stock?'Stok ara':'İsim, telefon veya TC/VKN ara'}</span><input id="${prefix}-search" type="search" maxlength="160" placeholder="${stock?'Ürün veya ayar':'İsim, numara, TC / VKN'}" autocomplete="off"></label><label class="field"><span>Birim</span><select id="${prefix}-unit"><option value="">Bütün birimler</option>${[...new Set(rows.map(a=>a.unit))].map(unit=>`<option value="${esc(unit)}">${esc(units[unit].label)}</option>`).join('')}</select></label>${stock?'':'<label class="field"><span>Bakiye durumu</span><select id="account-sign"><option value="all">Tümü</option><option value="claim">Alacağımız olanlar</option><option value="debt">Borcumuz olanlar</option><option value="zero">Bakiyesi sıfır</option></select></label>'}</div><p id="workbench-status" class="context-note" role="status" aria-live="polite"></p><div id="${prefix}-list" class="${stock?'stock-grid':'account-grid'}"></div></section><section id="account-detail" class="section" hidden></section>`;
  if (stock) renderInventoryCards();
  const editor=$('#card-editor');
  const openOperation=kind=>{
    captureDrafts();
    if(partyReturnContext?.ownerView===view)partyReturnContext=null;
    remember({editor:null,operation:kind});editor.hidden=true;editor.innerHTML='';
    renderSale($('#special-operation'),rows.filter(a=>a.unit==='TL'),kind);
  };
  const openEditor=existing=>{captureDrafts();if(existing&&partyReturnContext?.ownerView===view)partyReturnContext=null;remember({editor:existing?.id||'new',operation:null,guided:null});const special=$('#special-operation');if(special)special.innerHTML='';editor.hidden=false;stock?renderStockForm(editor,existing):renderPartyForm(editor,false,existing);};
  $(`#${stock?'add-stock':'add-account'}`).addEventListener('click',()=>{captureDrafts();if(partyReturnContext?.ownerView===view)partyReturnContext=null;const form=editor.querySelector('form');if(!editor.hidden&&(form?.id==='account-form'||form?.dataset.draftEntity==='new')){remember({editor:null});editor.hidden=true;editor.innerHTML='';}else{openEditor();editor.scrollIntoView?.({block:'nearest'});}});
  $('#stock-movement')?.addEventListener('click',()=>openOperation('stock'));
  const search=$(`#${prefix}-search`),unit=$(`#${prefix}-unit`),sign=$('#account-sign'),list=$(`#${prefix}-list`);
  search.value=memory.q;unit.value=memory.unit;if(sign)sign.value=memory.sign;
  const draw=()=>{
    const q=normalize(search.value.trim());remember({q:search.value,unit:unit.value,sign:sign?.value||'all'});
    const matches=a=>(!q||normalize([a.name,a.phone,a.taxId].join(' ')).includes(q))&&(!unit.value||unit.value===a.unit)&&(!sign||sign.value==='all'||(sign.value==='claim'?state.balances[a.id]>0:sign.value==='debt'?state.balances[a.id]<0:!state.balances[a.id]));
    const selected=rows.filter(matches);
    list.innerHTML=selected.length?selected.map(a=>{const balance=state.balances[a.id]||0;return `<article class="account-card ${stock?'stock-card':''}"><div><button class="button text" type="button" data-account-detail="${esc(a.id)}">${esc(a.name)}</button><small>${stock?a.countPolicy==='periodic'?'Terazi · dönemsel kontrol':'Günlük sayım':balance>0?'Alacağımız':balance<0?'Borcumuz':'Bakiyesi sıfır'}</small>${!stock&&a.phone?`<small>${esc(a.phone)}</small>`:''}</div><strong class="numeric ${balance<0?'negative':''}">${esc(formatted(stock?balance:Math.abs(balance),a.unit))}</strong></article>`;}).join(''):'<div class="workbench-empty">Eşleşen hesap bulunamadı. Aramayı veya filtreleri değiştirin.</div>';
    $('#workbench-status').textContent=`${selected.length} / ${rows.length} ${stock?'stok kartı':'müşteri hesabı'}`;
    list.querySelectorAll('[data-account-detail]').forEach(button=>button.addEventListener('click',()=>detail(button.dataset.accountDetail)));
  };
  let sequence=0;
  const detail=id=>{
    const a=account(id),panel=$('#account-detail');
    list.closest('section').before(panel);panel.hidden=false;panel.tabIndex=-1;panel.setAttribute('aria-labelledby','statement-title');
    panel.innerHTML=`<div class="section-header"><div><h2 id="statement-title">${esc(a.name)}${a.parentAccountId?' · '+esc(units[a.unit].label):''}</h2><p class="subtitle">${stock?'Stok hareketleri ve mevcut miktar':'Hesap ekstresi · '+esc(units[a.unit].label)}</p></div><div class="workbench-actions"><button class="button secondary" type="button" id="statement-back">${stock?'Stok listesine dön':'Müşteri listesine dön'}</button>${a.parentAccountId?'':`<button class="button secondary" type="button" id="edit-card">${stock?'Stok adını düzenle':'Kişi bilgilerini düzenle'}</button>`}</div></div>${!stock?`<p class="context-note">${[a.phone&&'Telefon: '+a.phone,a.taxId&&'TC/VKN: '+a.taxId,a.address&&'Adres: '+a.address].filter(Boolean).map(esc).join(' · ')||'İletişim bilgisi eklenmemiş.'}</p>`:''}<div data-current-balance></div><form id="statement-filter"><div class="form-grid"><label class="field"><span>Başlangıç tarihi · isteğe bağlı</span><input id="statement-start" type="date"></label><label class="field"><span>Bitiş tarihi · isteğe bağlı</span><input id="statement-end" type="date"></label></div>${action('Ekstreyi göster','Tarih seçmezseniz bütün hesap geçmişi gösterilir.')}</form><div id="statement-result"></div><p id="statement-status" role="status" aria-live="polite"></p>`;
    if (!stock) renderCustomerOrders(panel, a);
    $('#statement-back').addEventListener('click',()=>{
      ++sequence;panel.hidden=true;panel.innerHTML='';
      const selected=[...list.querySelectorAll('[data-account-detail]')].find(button=>button.dataset.accountDetail===id);
      const target=selected||search;target.focus({preventScroll:true});target.scrollIntoView?.({block:'center',behavior:'instant'});
    });
    $('#edit-card')?.addEventListener('click',()=>{openEditor(a);editor.querySelector('input')?.focus({preventScroll:true});editor.scrollIntoView?.({block:'nearest'});});
    panel.focus({preventScroll:true});panel.scrollIntoView?.({block:'start',behavior:'instant'});
    const load=async()=>{
      const ticket=++sequence,result=$('#statement-result'),status=$('#statement-status'),filters={accountId:id,startDate:$('#statement-start').value,endDate:$('#statement-end').value};
      const current=()=>ticket===sequence&&result.isConnected&&view===expectedView&&workspace===selectedWorkspace&&state.revision===expectedRevision;
      result.textContent='';panel.querySelector('[data-current-balance]').textContent='';status.textContent='Ekstre hazırlanıyor…';
      try{
        if(filters.startDate&&filters.endDate&&filters.startDate>filters.endDate)throw new Error('Başlangıç tarihi bitiş tarihinden sonra olamaz.');
        const [statement,page]=await Promise.all([request('account-statement',undefined,selectedWorkspace,{query:filters}),request('journal',undefined,selectedWorkspace,{query:{...filters,scope:'all',limit:'25'}})]);
        if(!current())return;
        if(statement.revision!==expectedRevision||page.revision!==expectedRevision||statement.account?.id!==id||statement.account?.unit!==a.unit||!['opening','incoming','outgoing','closing'].every(key=>Number.isSafeInteger(statement[key])))throw new Error('Defter değişti veya ekstre doğrulanamadı. Defteri yenileyin.');
        const measured=statement.lastPhysicalCount;
        const balanceText=value=>a.kind==='receivable'?`${formatted(Math.abs(value),a.unit)} · ${value>0?'Alacağımız':value<0?'Borcumuz':'Bakiyesi sıfır'}`:formatted(value,a.unit);
        const labels=stock?[['opening','Seçilen tarihten önceki stok'],['incoming','Stoka eklenen'],['outgoing','Stoktan çıkan'],['closing','Dönem sonunda mevcut']]:[['opening','Önceden gelen bakiye'],['incoming','Alacağı artıran / borcu azaltan'],['outgoing','Alacağı azaltan / borcu artıran'],['closing','Seçilen dönem bakiyesi']];
        const deltaFor=event=>event.entries.filter(row=>row.accountId===id).reduce((sum,row)=>sum+row.delta,0);
        let screenBalance=statement.closing;
        const screenRows=page.items.map(event=>{const delta=deltaFor(event),balance=screenBalance;screenBalance-=delta;return {event,delta,balance};});
        const screenContext=[...(page.receiptContext||[]),...page.items];
        const effectText=delta=>delta===0?formatted(0,a.unit)+(a.kind==='receivable'?' · Cari etkisi yok':' · Hesap etkisi yok'):formatted(delta,a.unit);
        let exporting=false;
        const completeSnapshot=()=>loadCompleteAccountSnapshot({a,filters,selectedWorkspace,expectedRevision,current,statement,expectedTotal:page.total});
        panel.querySelector('[data-current-balance]').innerHTML=a.kind==='receivable'?`<div class="section-header"><div><h3>Güncel net bakiye</h3><strong>${esc(balanceText(state.balances[id]||0))}</strong><p class="context-note">Güncel defter · tarih filtresinden bağımsız</p></div>${state.balances[id]?`<button type="button" class="button" data-account-collect${pending?' disabled':''}>${state.balances[id]<0?'Borcumuzu öde':'Alacağımızı tahsil et'}</button>`:''}</div>`:'';
        result.innerHTML=`<div class="statement-totals">${labels.map(([key,label])=>`<div><span>${label}</span><strong>${esc(['opening','closing'].includes(key)?balanceText(statement[key]):formatted(statement[key],a.unit))}</strong></div>`).join('')}</div><details data-statement-help><summary>Ekstre nasıl okunur?</summary><p class="context-note">${stock?'Stok girişleri alış, açılış ve düzeltmeleri; çıkışlar satış ve diğer çıkışları içerir.':'Örneğin satış alacağımızı artırır, tahsilat azaltır. Müşteriden alış borcumuzu artırır, yaptığımız ödeme azaltır. Açılış ve düzeltmeler de bu hareketlere dahildir.'}</p><p>Kayıt durumları güncel deftere aittir. Bağlı fişler dönem dışında olabilir; dönem bakiyesine ayrıca eklenmez.</p></details>${a.physical?`<p class="info neutral">${measured?`Son fiziksel ${measured.type==='stocktake'?'tartım':'sayım'}: ${esc(day(measured.date))} · ${esc(formatted(measured.counted,a.unit))}`:'Henüz fiziksel sayım / tartım yapılmadı; hesaplanan miktar gösteriliyor.'}</p>`:''}<div class="workbench-actions"><button type="button" class="button secondary" id="statement-journal">Tüm hareketleri aç</button><button type="button" class="button secondary" id="statement-print">Yazdır / PDF</button><button type="button" class="button secondary" id="statement-download">Ekstreyi indir (CSV)</button></div><h3>İşlem dökümü</h3><p class="context-note" data-statement-scope>Dönem: ${esc(filters.startDate||'Başlangıçtan')} — ${esc(filters.endDate||'Son kayda kadar')} · ${page.items.length} / ${page.total} işlem. Yazdırma ve CSV: seçilen dönemin tamamı. Kayıt durumları günceldir.</p><div class="table-wrap statement-record-wrap"><table class="statement-record-table" aria-label="Ekstre işlem dökümü"><thead><tr><th scope="col" id="statement-col-date">Tarih</th><th scope="col" id="statement-col-event">İşlem</th><th scope="col" id="statement-col-effect" class="numeric">Hesaba etki</th><th scope="col" id="statement-col-balance" class="numeric">İşlem sonrası bakiye</th></tr></thead><tbody>${screenRows.map(({event,delta,balance})=>`<tr data-statement-record="${esc(event.id)}" data-statement-balance="${balance}"><td headers="statement-col-date" data-statement-label="Tarih">${esc(day(event.date))}</td><td headers="statement-col-event" data-statement-label="İşlem">${esc(event.label)}${statementReceipt(event,screenContext)}</td><td headers="statement-col-effect" data-statement-label="Hesaba etki" class="numeric">${esc(effectText(delta))}</td><td headers="statement-col-balance" data-statement-label="İşlem sonrası bakiye" class="numeric">${esc(balanceText(balance))}</td></tr>`).join('')||'<tr><td colspan="4">Bu dönemde işlem yok.</td></tr>'}</tbody></table></div>`;
        panel.querySelector('[data-account-collect]')?.addEventListener('click',()=>{
          if(pending||busy)return;
          transactionTab='collection';setView('transaction');
          for(const [selector,value] of [['#collection-search',''],['#collection-filter','all']]){const filter=$(selector);if(filter){filter.value=value;filter.dispatchEvent(new Event(filter.tagName==='SELECT'?'change':'input',{bubbles:true}));}}
          const select=$('#f-customerAccount');if(!select)return;select.value=id;select.dispatchEvent(new Event('change',{bubbles:true}));$('#f-quantity').focus();
        });
        $('#statement-journal').addEventListener('click',()=>{journalFilterMemory.set(workspace,{scope:'all',q:'',type:'all',...filters});setView('journal');});
        const exportBusy=value=>{exporting=value;for(const selector of ['#statement-print','#statement-download']){const button=result.querySelector(selector);if(button)button.disabled=value;}};
        $('#statement-print').addEventListener('click',async()=>{
          if(exporting)return;exportBusy(true);let snapshotNode,cleanup;
          try{
            const snapshot=await completeSnapshot();
            snapshotNode=document.createElement('section');snapshotNode.id='statement-print-snapshot';
            snapshotNode.innerHTML=`<header class="statement-print-header"><h1>Hesap ekstresi</h1><h2>${esc(a.name)}</h2><p>${esc(units[a.unit].label)} · Dönem: ${esc(filters.startDate||'Başlangıçtan')} — ${esc(filters.endDate||'Son kayda kadar')}</p><p>Oluşturulma: ${esc(snapshot.generatedAt)} · Sürüm: ${expectedRevision} · ${snapshot.rows.length} işlem</p><p>Önceden gelen: ${esc(balanceText(snapshot.statement.opening))} · Dönem sonu: ${esc(balanceText(snapshot.statement.closing))}</p><p>Hesap adları ve kayıt durumları bu sürümün güncel bilgileridir. Bağlı kayıtlar dönem dışında olabilir; dönem bakiyesine ayrıca eklenmez.</p></header>${snapshot.rows.map(({event,delta,balance})=>`<article class="statement-print-record" data-statement-record="${esc(event.id)}" data-statement-balance="${balance}"><div class="statement-print-balance"><strong>Hesaba etki: ${esc(effectText(delta))}</strong><strong>İşlem sonrası bakiye: ${esc(balanceText(balance))}</strong></div>${statementReceipt(event,snapshot.context)}</article>`).join('')||'<p>Bu dönemde işlem yok.</p>'}`;
            prepareStatementPrint(snapshotNode);
            document.body.append(snapshotNode);document.body.dataset.printScope='statement';
            cleanup=()=>{snapshotNode?.remove();delete document.body.dataset.printScope;window.removeEventListener('afterprint',cleanup);exportBusy(false);};
            window.addEventListener('afterprint',cleanup);window.print();
          }catch(error){if(cleanup)cleanup();else{snapshotNode?.remove();delete document.body.dataset.printScope;exportBusy(false);}inform('Yazdırma hazırlanamadı: '+error.message,true);}
        });
        $('#statement-download').addEventListener('click',async()=>{
          if(exporting)return;exportBusy(true);let url;
          try{
            const snapshot=await completeSnapshot();
            const csvCell=value=>{let text=String(value??'');if(/^[\s\u0000-\u001f\u007f]*[=+@\-]/.test(text))text="'"+text;return '"'+text.replace(/"/g,'""')+'"';};
            const nativeLine=row=>{const item=account(row.accountId);return `${item?.name||row.accountId}: ${formatted(row.quantity,item?.unit||'TL')}${row.weightAccount?' · '+formatted(row.weight,'GRAM')+' · '+(account(row.weightAccount)?.name||row.weightAccount):''}${Number.isSafeInteger(row.valueTL)?' · Anlaşılmış TL: '+formatted(row.valueTL):''}`;};
            const csv=[['Hesap','Dönem başlangıcı','Dönem bitişi','Sürüm','Kayıt ID','İş günü','Kayıt zamanı','Tür','Durum','Açıklama','Bağlı kayıtlar','Girenler','Çıkanlar','Cari ayrıntısı','Hesap etkisi','İşlem sonrası bakiye','Birim'],...snapshot.rows.map(({event,delta,balance})=>{
              const directions=receiptDirections(event,snapshot.context)||{incoming:event.entries.filter(row=>row.delta>0&&account(row.accountId)?.kind==='asset').map(row=>({...row,quantity:row.delta})),outgoing:event.entries.filter(row=>row.delta<0&&account(row.accountId)?.kind==='asset').map(row=>({...row,quantity:-row.delta})),cari:event.entries.filter(row=>account(row.accountId)?.kind==='receivable').map(row=>({...row,quantity:Math.abs(row.delta),impact:row.delta>0?1:-1}))};
              return [a.name,filters.startDate,filters.endDate,expectedRevision,event.id,event.date,event.timestamp,event.type,receiptStatus(event,snapshot.context),event.meta.note||'',receiptRelations(event,snapshot.context).join(' | '),directions.incoming.map(nativeLine).join(' | '),directions.outgoing.map(nativeLine).join(' | '),directions.cari.map(row=>nativeLine(row)+' · '+(row.action==='reduceDebt'?(row.impact<0?'Müşterinin açık borcundan düşüldü':'Önceki borç mahsubu geri alındı'):row.action==='grantCredit'?(row.impact<0?'Müşteriye yeni alacak yazıldı':'Önceki müşteri alacağı geri alındı'):row.impact>0?'Alacağımız artar / borcumuz azalır':'Borcumuz artar / alacağımız azalır')).join(' | '),raw(delta,a.unit),raw(balance,a.unit),a.unit];
            })].map(row=>row.map(csvCell).join(';')).join('\r\n');
            url=URL.createObjectURL(new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='hesap-ekstresi-'+state.date+'.csv';link.click();
          }catch(error){inform('Ekstre indirilemedi: '+error.message,true);}finally{if(url)URL.revokeObjectURL(url);exportBusy(false);}
        });enhanceTables(result);status.textContent='Ekstre hazır.';
      }catch(error){if(current()){result.textContent='Ekstre alınamadı: '+error.message;status.textContent='Filtreleri kontrol edip yeniden deneyin.';}}
    };$('#statement-filter').addEventListener('submit',e=>{e.preventDefault();load();});load();
  };
  search.addEventListener('input',draw);unit.addEventListener('change',draw);sign?.addEventListener('change',draw);draw();
  if(memory.editor==='new')openEditor();
  else if(memory.editor&&rows.some(a=>a.id===memory.editor))openEditor(account(memory.editor));
  else if(stock&&memory.operation==='stock')openOperation(memory.operation);
}
function receiptChoiceText(entry) {
  const lines=(entry.meta?.lines||[]).map(line=>{const a=account(line.accountId);return (a?.name||'Ürün')+' '+(a?formatted(line.quantity,a.unit):String(line.quantity));}).join(' / ');
  const amount=entry.meta?.total ?? entry.meta?.amountTL;
  return [day(entry.date),entry.label,lines,Number.isSafeInteger(amount)?formatted(amount):'',entry.meta?.note].filter(Boolean).join(' · ');
}
function receiptReference(id, suffix='') {
  const entry=state.journal.find(row=>row.id===id);
  return '<span data-receipt-label="'+esc(id)+'" data-receipt-suffix="'+esc(suffix)+'">'+esc((entry?receiptChoiceText(entry):'Fiş bilgisi yükleniyor')+suffix)+'</span>';
}
function receiptTechnical(ids) {
  return '<details data-receipt-technical><summary>Teknik kayıt bilgileri</summary><p style="overflow-wrap:anywhere">'+ids.filter(Boolean).map(esc).join(' · ')+'</p></details>';
}
async function hydrateReceiptLabels(root) {
  const selectedWorkspace=workspace,revision=state.revision;
  const ids=[...new Set([...root.querySelectorAll('[data-receipt-label]')].map(node=>node.dataset.receiptLabel))];
  for(const id of ids) {
    if(!root.isConnected||workspace!==selectedWorkspace||state.revision!==revision)return;
    let entry=state.journal.find(row=>row.id===id);
    try {
      if(!entry){const page=await request('journal',undefined,selectedWorkspace,{query:{scope:'all',q:id,limit:30}});if(page.revision!==revision)throw Error('Defter değişti');entry=[...page.items,...(page.receiptContext||[])].find(row=>row.id===id);}
      if(!root.isConnected||workspace!==selectedWorkspace||state.revision!==revision)return;
      for(const node of root.querySelectorAll('[data-receipt-label]'))if(node.dataset.receiptLabel===id)node.textContent=(entry?receiptChoiceText(entry):'Fiş bilgisi bulunamadı')+(node.dataset.receiptSuffix||'');
    }catch {if(root.isConnected)for(const node of root.querySelectorAll('[data-receipt-label]'))if(node.dataset.receiptLabel===id)node.textContent='Fiş bilgisi alınamadı'+(node.dataset.receiptSuffix||'');}
  }
}
function renderCustomerOrders(panel, customer) {
  const orders = (state.customerOrders || []).filter(order => order.customerId === customer.id);
  const funds = financialAccounts().filter(a => a.unit === 'TL' && a.id !== 'pos');
  const section = document.createElement('details');
  section.className = 'section customer-orders';
  const option = (value, label) => '<option value="' + esc(value) + '">' + esc(label) + '</option>';
  const fundField = '<label class="field">Kasa veya banka<select required name="accountId">' + funds.map(a=>option(a.id,a.name)).join('') + '</select></label>';
  const amountField = '<label class="field">Tutar (TL)<input name="amountTL" required inputmode="decimal"></label>';
  const moneyForm = (order, refund) => {
    const remaining = order.advances.filter(a => a.receivedTL > a.refundedTL + a.appliedTL + (a.returnedToPayableTL || 0));
    const receipts = refund ? '<label class="field">Avans makbuzu<select name="advanceId" required>' + remaining.map(a => '<option value="'+esc(a.id)+'" data-receipt-label="'+esc(a.id)+'" data-receipt-suffix="'+esc(' · kalan '+formatted(a.receivedTL-a.refundedTL-a.appliedTL-(a.returnedToPayableTL||0)))+'">'+esc((state.journal.find(e=>e.id===a.id)?receiptChoiceText(state.journal.find(e=>e.id===a.id)):'Fiş bilgisi yükleniyor')+' · kalan '+formatted(a.receivedTL-a.refundedTL-a.appliedTL-(a.returnedToPayableTL||0)))+'</option>').join('') + '</select></label>' : '';
    const title = refund ? 'Avans iade et' : 'Avans al';
    return '<details><summary>' + title + '</summary><form class="form-grid" data-order-action="' + (refund?'orderRefund':'orderAdvance') + '" data-order="' + esc(order.id) + '">' + receipts + (refund?receiptTechnical(remaining.map(a=>a.id)):'') + fundField + amountField + '<button class="button">' + title + '</button></form></details>';
  };
  const scrapForm = order => customer.unit !== 'TL' ? '' :
    '<details data-scrap-transfer><summary>Hurda alış borcunu avansa ayır</summary><form class="form-grid" data-order-action="scrapAdvanceTransfer" data-order="' + esc(order.id) + '">' +
    '<p class="context-note full">Kaynak hurda alışını seçin. Aktarım, bu alıştan avansa ayrılmamış tutar ve müşteriye güncel net borcumuzla sınırlıdır.</p>' +
    '<label class="field">Alış kaydı ara<input type="search" data-scrap-query maxlength="160"></label><button type="button" class="button secondary" data-find-scrap>Alışları göster</button>' +
    '<label class="field full">Kaynak hurda alışı<select name="purchaseId" required><option value="">Alış seçin</option></select></label><details><summary>Teknik kayıt bilgileri</summary><p data-source-id style="overflow-wrap:anywhere"></p></details><p class="context-note full" data-source-limit aria-live="polite"></p>' +
    amountField + '<label class="field full">Aktarım anlaşması / açıklaması<input name="note" required maxlength="160"></label>' +
    '<p class="info neutral full" data-scrap-preview aria-live="polite"></p><button class="button">Seçilen borcu avansa aktar</button></form></details>';
  const undoForm = order => {
    const receipts = order.advances.filter(a => a.sourcePurchaseId && a.receivedTL > a.refundedTL + a.appliedTL + (a.returnedToPayableTL || 0));
    return receipts.length ? '<details><summary>Hurda avansını cari borcumuza geri al</summary><form class="form-grid" data-order-action="scrapAdvanceUndo" data-order="' + esc(order.id) + '">' +
      '<label class="field">Aktarım kaydı<select name="advanceId" required>' + receipts.map(a=>'<option value="'+esc(a.id)+'" data-receipt-label="'+esc(a.id)+'" data-receipt-suffix="'+esc(' · kullanılmamış '+formatted(a.receivedTL-a.refundedTL-a.appliedTL-(a.returnedToPayableTL||0)))+'">'+esc((state.journal.find(e=>e.id===a.id)?receiptChoiceText(state.journal.find(e=>e.id===a.id)):'Fiş bilgisi yükleniyor')+' · kullanılmamış '+formatted(a.receivedTL-a.refundedTL-a.appliedTL-(a.returnedToPayableTL||0)))+'</option>').join('') + '</select></label>' +
      receiptTechnical(receipts.flatMap(a=>[a.id,a.sourcePurchaseId])) + amountField + '<label class="field">Geri alma gerekçesi<input name="note" maxlength="160" required></label><p class="context-note">Seçilen kullanılmamış avans azalır, müşteriye cari borcumuz aynı tutarda artar.</p><button class="button secondary">Cari borcumuza geri al</button></form></details>' : '';
  };
  section.innerHTML = '<summary>Siparişler ve avanslar (' + orders.length + ')</summary><form data-order-action="customerOrder" class="form-grid"><label class="field">Yeni sipariş açıklaması<input required maxlength="300" name="description"></label><button class="button secondary">Siparişi aç</button></form>' +
    orders.map(order => {
      const stateLabel = { open:'Açık', fulfilled:'Satışa bağlandı', cancelled:'İptal edildi' }[order.status];
      return '<article class="section"><h4>' + esc(order.description) + '</h4><p>' + esc(stateLabel) + ' · ' + esc(day(order.date)) + '</p><p>Kullanılabilir avans <strong>' + esc(formatted(order.availableTL)) + '</strong></p>' +
        (order.saleId ? '<p>Nihai satış · ' + receiptReference(order.saleId) + '</p>' + receiptTechnical([order.saleId]) : '') +
        (order.status === 'open' ? moneyForm(order,false) + scrapForm(order) + '<button class="button secondary" type="button" data-order-sale="' + esc(order.id) + '">Nihai satışı hazırla</button>' : '') +
        undoForm(order) + (order.availableTL ? moneyForm(order,true) : order.status === 'open' ? '<details><summary>Siparişi iptal et</summary><form data-order-action="orderCancel" data-order="' + esc(order.id) + '" class="form-grid"><label class="field">İptal gerekçesi<input name="note" required maxlength="160"></label><button class="button secondary">İptali kaydet</button></form></details>' : '') + '</article>';
    }).join('');
  panel.append(section);
  section.addEventListener('toggle',()=>{if(section.open)hydrateReceiptLabels(section);});
  for (const form of section.querySelectorAll('form')) form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const command = { type:form.dataset.orderAction, ...formValues(form) };
    if (command.type === 'customerOrder') command.customerId = customer.id;
    else command.orderId = form.dataset.order;
    if (command.type === 'scrapAdvanceTransfer') command.customerId = customer.id;
    if (await submit(command,'Sipariş kaydı güncellendi.') && view === 'accounts') {
      [...document.querySelectorAll('[data-account-detail]')].find(button => button.dataset.accountDetail === customer.id)?.click();
    }
  });
  for (const details of section.querySelectorAll('[data-scrap-transfer]')) {
    const form = details.querySelector('form'), select = form.elements.purchaseId, amount = form.elements.amountTL;
    const limit = form.querySelector('[data-source-limit]'), preview = form.querySelector('[data-scrap-preview]');
    const payable = Math.max(0,-(state.balances[customer.id] || 0));
    const order = orders.find(o=>o.id === form.dataset.order);
    const update = () => {
      form.querySelector('[data-source-id]').textContent=select.value||'Alış seçilmedi';
      const capacity = Number(select.selectedOptions[0]?.dataset.capacity || 0);
      const value = parseAmount(amount,'TL',true);
      if (value !== null && value > Math.min(capacity,payable)) amount.setCustomValidity('Tutar kaynak sınırını veya müşteriye net borcumuzu aşıyor.');
      limit.textContent = 'Bu alıştan daha önce avansa aktarılmamış tutar: ' + formatted(capacity) + ' · Müşteriye net borcumuz: ' + formatted(payable);
      preview.textContent = value !== null && value <= Math.min(capacity,payable) ? 'Avansa aktarılacak: ' + formatted(value) + ' · Kalan net borcumuz: ' + formatted(payable-value) + ' · Siparişte kullanılabilir avans: ' + formatted(order.availableTL+value) : 'Alış ve geçerli aktarım tutarını seçin.';
    };
    let loaded = false, generation = 0;
    const load = async () => {
      const attempt = ++generation;
      const button = form.querySelector('[data-find-scrap]');
      button.disabled = true;
      select.innerHTML = '<option value="">Alış seçin</option>';
      update();
      try {
        const page = await request('journal',undefined,workspace,{query:{scope:'all',type:'purchase',scrapForAdvance:customer.id,limit:30,q:form.querySelector('[data-scrap-query]').value}});
        if (!form.isConnected || attempt !== generation) return;
        if (page.revision !== state.revision) throw Error('Defter değişti. Ekranı yenileyin.');
        select.insertAdjacentHTML('beforeend',page.items.map(entry=>'<option value="' + esc(entry.id) + '" data-capacity="' + entry.scrapAdvanceCapacityTL + '">' + esc(receiptChoiceText(entry) + ' · Avansa ayrılmamış: ' + formatted(entry.scrapAdvanceCapacityTL)) + '</option>').join(''));
        limit.textContent = page.total ? 'Alış seçin.' + (page.nextCursor ? ' İlk 30 kayıt gösteriliyor; aramayı daraltın.' : '') : 'Aktarılabilecek tutarı bulunan hurda alışı yok.';
      } catch (error) { if (form.isConnected) limit.textContent = error.message; }
      finally { if (form.isConnected && attempt === generation) button.disabled = false; }
    };
    details.addEventListener('toggle',()=>{if(details.open && !loaded){loaded=true;load();}});
    form.querySelector('[data-find-scrap]').addEventListener('click',load);
    select.addEventListener('change',update);amount.addEventListener('input',update);update();
  }
  for (const button of section.querySelectorAll('[data-order-sale]')) button.addEventListener('click', () => {
    if (pending || busy) return;
    transactionTab = 'sale'; setView('transaction');
    const party = $('#f-counterpartyId');
    party.value = customer.id; party.dispatchEvent(new Event('change'));
    const order = $('#trade-order');
    order.value = button.dataset.orderSale; order.dispatchEvent(new Event('change'));
    order.focus();
  });
}

function renderBanks(){
  const memoryKey=`${workspace}:banks`,memory=workbenchMemory.get(memoryKey)||{};
  const remember=changes=>workbenchMemory.set(memoryKey,{...workbenchMemory.get(memoryKey),...changes});
  const banks=financialAccounts().filter(a=>a.id!=='pos');
  $('#main').innerHTML=heading('Banka/Pos/Kasa','Banka ve fiziki kasaları para birimine göre ayrı takip edin. Nakit Diğer için her dövize ayrı hesap açın.','<button class="button" id="add-bank" type="button">+ Banka / kasa ekle</button><button class="button secondary" id="add-other-cash" type="button">+ Nakit Diğer ekle</button>')+`<section class="section" id="bank-editor" hidden></section><div class="bank-grid">${banks.map(a=>`<article class="bank-card"><span class="card-label">${esc(a.name)}</span><small>${a.physical?(a.unit==='HAS'?'Fiziki HAS hesabı':a.unit==='SILVER'?'Fiziki saf gümüş hesabı':'Fiziki kasa'):'Banka hesabı'} · ${esc(a.unit)}</small><strong class="card-value">${esc(formatted(state.balances[a.id],a.unit))}</strong><button class="button text" type="button" data-bank-journal="${esc(a.id)}">Giriş / çıkışları gör →</button><button class="button text" type="button" data-bank-rename="${esc(a.id)}">Hesap adını düzenle</button></article>`).join('')}<article class="bank-card"><span class="card-label">Bekleyen POS</span><strong class="card-value">${esc(formatted(state.balances.pos))}</strong><button class="button text" type="button" data-bank-journal="pos">POS işlemlerini gör →</button></article></div><section class="section"><div class="workbench-actions"><button type="button" class="button" data-bank-action="settlement">POS'u Bankaya Aktar</button><button type="button" class="button secondary" data-bank-action="transfer">Kasa / Banka Transferi</button></div><div id="bank-operation"></div></section><section class="section"><h2>POS İşlemleri</h2><div id="pos-history" role="status">Yükleniyor…</div></section>`;
  // D06: presentation only; keep the existing finance forms and their handlers.
  const bankGrid=$('.bank-grid'),bankOperation=$('#bank-operation');
  const bankWorkspace=document.createElement('div');bankWorkspace.className='bank-workspace';
  bankGrid.before(bankWorkspace);bankWorkspace.append(bankOperation.closest('section'),bankGrid);
  bankGrid.setAttribute('aria-label','Hesap bakiyeleri');
  bankOperation.innerHTML='<p class="context-note">POS tahsilatı veya aynı birimde hesaplar arası transfer için yukarıdan işlem seçin.</p>';
  const presentBankOperation=()=>{
    const selects=[...bankOperation.querySelectorAll('select')];
    const summaries=selects.map(select=>{
      const summary=document.createElement('p');summary.className='bank-selection';summary.id=`${select.id}-selection`;
      select.setAttribute('aria-describedby',[select.getAttribute('aria-describedby'),summary.id].filter(Boolean).join(' '));
      select.after(summary);return summary;
    });
    const update=()=>selects.forEach((select,index)=>{const label=select.selectedOptions[0]?.textContent;const unit=select.name==='bankAccount'?account(select.value)?.unit:null;summaries[index].textContent=label?label+(unit?` · ${unit}`:''):'Uygun hedef hesap yok.';});
    selects.forEach(select=>select.addEventListener('change',update));update();
  };
  const editor=$('#bank-editor');
  const openEditor=(existing=null,otherCash=false)=>{
    captureDrafts();remember({editor:existing?.id||(otherCash?'other-cash':'new'),operation:null});$('#bank-operation').innerHTML='';editor.hidden=false;
    editor.innerHTML=existing?`<h2>Hesap adını düzenle</h2><form id="bank-rename-form" data-draft-entity="${esc(existing.id)}">${field('name','Banka / hesap adı',{value:existing.name,max:70})}${action('Adı kaydet','Bakiye ve işlem geçmişi korunur.')}</form>`:`<h2>${otherCash?'Nakit Diğer ekle':'Banka veya kasa hesabı ekle'}</h2><form id="bank-form"><div class="form-grid">${field('name','Banka / hesap adı',{max:70})}${field('unit','Para birimi',{options:[['TL','TL'],['USD','USD'],['EUR','EUR'],['GBP','GBP'],['CHF','CHF'],['SILVER','Saf gümüş gram'],['other','Diğer döviz']]})}<div id="bank-other-unit" hidden>${field('currencyCode','Üç harfli döviz kodu',{required:false,max:3})}</div>${field('physical','Hesap türü',{options:[['false','Banka hesabı'],['true','Fiziki kasa']]})}${field('opening','Başlangıç bakiyesi',{value:'0'})}</div>${action('Hesabı ekle','Her banka ve para birimi ayrı takip edilir.')}</form>`;
    const form=editor.querySelector('form');
    if(otherCash){form.dataset.draftEntity='other-cash';form.querySelector('#f-unit').value='other';form.querySelector('#f-physical').value='true';form.querySelector('#f-name').value='Nakit Diğer';form.insertAdjacentHTML('afterbegin','<p class="context-note">SAR, AED gibi her döviz için ayrı fiziki kasa açın. Miktar kendi biriminde, işlemin TL karşılığı ayrıca elle girilir.</p>');}
    if(!existing){const unit=form.querySelector('#f-unit'),currency=form.querySelector('#f-currencyCode');const update=()=>{const other=unit.value==='other';const physical=form.querySelector('#f-physical');physical.querySelector('option[value="false"]').disabled=unit.value==='SILVER';if(unit.value==='SILVER')physical.value='true';form.querySelector('#bank-other-unit').hidden=!other;currency.required=other;currency.disabled=!other;if(!other)currency.setCustomValidity('');};unit.addEventListener('change',update);currency.addEventListener('input',()=>{currency.value=currency.value.toUpperCase();currency.setCustomValidity(/^[A-Z]{3}$/.test(currency.value)&&!['TRY','HAS'].includes(currency.value)?'':'Üç harfli döviz kodu yazın. HAS, döviz değildir.');});update();}
    form.addEventListener('submit',async e=>{e.preventDefault();if(!form.reportValidity())return;const values=formValues(form);const saved=await submit(existing?{type:'fundUpdate',accountId:existing.id,name:values.name}:{type:'fundAccount',name:values.name,unit:values.unit==='other'?values.currencyCode.toUpperCase():values.unit,physical:values.physical==='true',opening:values.opening},existing?'Hesap adı güncellendi.':'Hesap eklendi.');if(saved){remember({editor:null});if(`${workspace}:${view}`===memoryKey)render();}});
    if(otherCash){const name=form.querySelector('#f-name'),currency=form.querySelector('#f-currencyCode');let suggested='Nakit Diğer';currency.addEventListener('input',()=>{const next=/^[A-Z]{3}$/.test(currency.value)?'Nakit Diğer ('+currency.value+')':'Nakit Diğer';if(!name.value.trim()||name.value===suggested)name.value=next;suggested=next;});}
    prepareDraftForms();connectFieldHints(editor);
  };
  const openOperation=kind=>{captureDrafts();remember({editor:null,operation:kind});editor.hidden=true;editor.innerHTML='';renderFinanceForm($('#bank-operation'),kind);presentBankOperation();};
  $('#add-bank').addEventListener('click',()=>{captureDrafts();if(!editor.hidden&&editor.querySelector('#bank-form')){remember({editor:null});editor.hidden=true;editor.innerHTML='';}else openEditor();});
  $('#add-other-cash').addEventListener('click',()=>openEditor(null,true));
  document.querySelectorAll('[data-bank-rename]').forEach(button=>button.addEventListener('click',()=>openEditor(account(button.dataset.bankRename))));
  document.querySelectorAll('[data-bank-action]').forEach(button=>button.addEventListener('click',()=>openOperation(button.dataset.bankAction)));
  document.querySelectorAll('[data-bank-journal]').forEach(button=>button.addEventListener('click',()=>{journalFilterMemory.set(workspace,{scope:'all',q:'',type:'all',accountId:button.dataset.bankJournal});setView('journal');}));
  const panel=$('#pos-history'),selectedWorkspace=workspace,revision=state.revision;
  request('journal',undefined,workspace,{query:{scope:'all',accountId:'pos',limit:'20'}}).then(page=>{if(!panel.isConnected||workspace!==selectedWorkspace)return;if(page.revision!==revision)throw new Error('Defter değişti; yenileyin.');panel.innerHTML=page.items.length?`<div class="table-wrap"><table><thead><tr><th>Tarih</th><th>İşlem</th><th class="numeric">POS etkisi</th></tr></thead><tbody>${page.items.map(event=>`<tr><td>${esc(day(event.date))}</td><td>${esc(event.label)}</td><td class="numeric">${esc(formatted(event.entries.filter(row=>row.accountId==='pos').reduce((sum,row)=>sum+row.delta,0)))}</td></tr>`).join('')}</tbody></table></div><p class="context-note">Son ${page.items.length} / ${page.total} işlem. Tam listeyi POS işlemlerini gör ile açın.</p>`:'Henüz POS işlemi yok.';enhanceTables(panel);}).catch(error=>{if(panel.isConnected)panel.textContent='POS işlemleri alınamadı: '+error.message;});
  if(memory.editor==='other-cash')openEditor(null,true);
  else if(memory.editor==='new')openEditor();
  else if(memory.editor&&banks.some(a=>a.id===memory.editor))openEditor(account(memory.editor));
  else if(['transfer','settlement'].includes(memory.operation))openOperation(memory.operation);
}

async function seedDemo() {
  if (workspace !== 'demo') return;
  const exampleBalances = { nakit: '20000', usd: '100', eur: '50', bilezik22: '100', bilezikAdet: '20', taki14: '50', taki22: '80', yuzuk: '12', kupe: '10', kolye: '8', kunye: '10', sahmeran: '4', digerTaki: '3', gramToplam: '243', hurda22: '20', ceyrek: '10', yarim: '5', ziynet: '3', cumhuriyet: '2', resat: '1', gramaltin: '20', saat: '4', pos: '0', banka: '30000' };
  const success = await submit({ type: 'opening', date: today(), balances: Object.fromEntries(activeAccounts().map(a => [a.id, exampleBalances[a.id] || '0'])) }, 'Örnek açılış kaydedildi.');
  if (!success) return;
  const added = await submit({ type: 'account', name: 'Örnek müşteri', unit: 'TL', opening: '0' }, 'Örnek müşteri eklendi.');
  if (!added) return;
  const customer = state.accounts.find(a => a.name === 'Örnek müşteri' && a.unit === 'TL');
  await submit({ type: 'sale', items: [{ accountId: 'kunye', quantity: '1', weightAccount: 'taki14', weight: '5.250', value: '25000' }, { accountId: 'kunye', quantity: '1', weightAccount: 'taki22', weight: '6.750', value: '35000' }], scrapQuantity: '6', scrapValue: '30000', cash: '10000', pos: '15000', bank: '0', customerAccount: customer.id, note: 'Örnek: 14 ve 22 ayar iki künye; 6 gr hurda + 10.000 nakit + 15.000 POS + 5.000 cari. Gerçek işlem değildir.' }, 'Örnek gün hazır: 60.000 TL satışın bütün bağlı hareketleri kaydedildi.');
}

function renderTransaction() {
  captureDrafts();
  if (canonicalTransactionRoute()) { render(); return; }
  if (!['sale','sale-multi','purchase','collection','customer-exchange','movement'].includes(transactionTab)) transactionTab = 'sale';
  if (transactionTab === 'sale-multi') transactionTab = 'sale';
  const money = transactionTab === 'movement',activeTab=transactionTab==='customer-exchange'?'collection':transactionTab;
  const tabs = [['sale','Satış'],['purchase','Alış'],['movement','Para'],['collection','Cari']];
  $('#main').innerHTML = `<div class="transaction-toolbar"><h1>İşlem Ekranı</h1>` +
    `<div class="transaction-group transaction-primary"><div class="transaction-tabs" role="group" aria-label="İşlem türü">${tabs.map(([id,label])=>`<button type="button" data-tab="${id}" aria-controls="transaction-content" class="${activeTab===id?'active':''}" aria-pressed="${activeTab===id}">${label}</button>`).join('')}</div></div>` +
    `</div><section class="section" id="transaction-content"></section>${money?'<aside class="section owner-shortcuts"><h2>Banka ve POS işlemleri</h2><p class="context-note">Hesaplar arası transfer ve POS aktarımı Banka/Pos/Kasa ekranında yapılır. Buradaki gider / sermaye taslağınız korunur.</p><div class="workbench-actions"><button type="button" class="button secondary" data-owner-operation="transfer">Kasa / banka transferi →</button><button type="button" class="button secondary" data-owner-operation="settlement">POS tahsilatı →</button></div></aside>':''}`;
  document.querySelectorAll('[data-tab]').forEach(button=>button.addEventListener('click',()=>{
    captureDrafts(); transactionTab=button.dataset.tab; renderTransaction();
    document.querySelector(`[data-tab="${transactionTab}"]`)?.focus({preventScroll:true});
  }));
  const container=$('#transaction-content');
  if (['sale','purchase','customer-exchange'].includes(transactionTab)) renderSale(container,[],transactionTab);
  else if (transactionTab==='collection') renderCollectionForm(container,'customer');
  else renderFinanceForm(container,transactionTab);
  document.querySelectorAll('[data-owner-operation]').forEach(button=>button.addEventListener('click',()=>openOwnedOperation('banks',button.dataset.ownerOperation)));
  connectFieldHints($('#main')); enhanceTables($('#main')); prepareDraftForms();
}

function renderCollectionForm(container, partyType = 'customer', editingCommand = null) {
  const allCaris=activeAccounts().filter(a=>a.kind==='receivable' && ((a.partyType || 'customer')===partyType || a.id===editingCommand?.customerAccount));
  const balanceFor=a=>{let balance=state.balances[a.id]||0;if(editingCommand?.customerAccount===a.id){const input=document.createElement('input');input.value=editingCommand.quantity;const amount=parseAmount(input,a.unit)||0;balance+=editingCommand.direction==='collect'?amount:-amount;}return balance;};
  container.innerHTML=`<h2>${partyType==='supplier'?'Firma':'Cari'} tahsilat / ödeme</h2><p class="subtitle">Kişiyi bulun; borç veya alacak durumuna uygun işlem otomatik seçilir.</p><form id="collection-form"><div class="workbench-filters"><label class="field" for="collection-search"><span>İsim, telefon veya TC/VKN ara</span><input type="search" id="collection-search" name="collectionSearch" maxlength="160" autocomplete="off"></label><label class="field" for="collection-filter"><span>Hesap durumu</span><select id="collection-filter" name="collectionFilter"><option value="all">Borç ve alacak bulunanlar</option><option value="claim">Alacağımız bulunanlar</option><option value="debt">Borcumuz bulunanlar</option></select></label></div><div class="form-grid">${field('customerAccount','Hesap',{options:[]})}${field('direction','Yapılacak işlem',{options:[]})}${field('target','Ödemenin yapılacağı kasa / banka',{options:[]})}${field('quantity','Miktar')}${field('note','Açıklama · isteğe bağlı',{full:true,required:false})}</div><p class="context-note" id="collection-balance" role="status"></p>${action('İşlemi kaydet','Tutar, seçilen hesabın borç veya alacağını aşamaz.')}</form>`;
  const form=container.querySelector('#collection-form'), customer=form.querySelector('#f-customerAccount'), direction=form.querySelector('#f-direction'), target=form.querySelector('#f-target');
  if(view!=='edit'){
    form.insertAdjacentHTML('beforebegin','<p class="context-note">Altın veya birden çok karşılıkla mahsup için ayrı karma cari formunu kullanın; satış geliri oluşmaz.</p><button type="button" class="button secondary" data-open-exchange>Altın / karma cari tahsilat ve ödeme</button>');
    container.querySelector('[data-open-exchange]').addEventListener('click',()=>{const selected=account(customer.value)?.parentAccountId||customer.value;captureDrafts();if(view==='transaction')transactionTab='customer-exchange';else if(view==='suppliers')workbenchMemory.set(`${workspace}:suppliers`,{...workbenchMemory.get(`${workspace}:suppliers`),operation:'supplier-exchange'});renderSale(container,[],partyType+'-exchange');const party=container.querySelector('#f-counterpartyId');if(!party.value&&[...party.options].some(o=>o.value===selected)){party.value=selected;party.dispatchEvent(new Event('change'));}container.querySelector('select')?.focus();});
  }
  const updateCollection=()=>{
    const a=account(customer.value), balance=a?balanceFor(a):0;
    const choices=a?financialAccounts().filter(t=>t.id!=='pos'&&t.unit===a.unit):[];
    const old=target.value;
    target.innerHTML=choices.map(t=>`<option value="${esc(t.id)}">${esc(t.name)} · ${esc(formatted(state.balances[t.id],t.unit))}</option>`).join('');
    if(choices.some(t=>t.id===old))target.value=old;
    direction.innerHTML=balance?`<option value="${balance>0?'collect':'pay'}">${balance>0?'Alacağımızı tahsil et':'Borcumuzu öde'}</option>`:'<option value="">İşlem yapılacak bakiye yok</option>';
    target.previousElementSibling.firstChild.textContent=balance>0?'Tahsilatın gireceği kasa / banka':balance<0?'Ödemenin yapılacağı kasa / banka':'Kasa / banka';
    const q=form.querySelector('#f-quantity');q.previousElementSibling.textContent='Miktar'+(a?' · '+units[a.unit].label:'');q.setCustomValidity('');
    form.querySelector('#collection-balance').textContent=!a?'Aramaya uygun, borç veya alacak bulunan hesap yok.':!choices.length?'Bu birimde ödeme hesabı bulunmuyor. Banka/Pos/Kasa sayfasından uygun kasa veya banka hesabını ekleyin.':`${a.name}: ${balance>0?'alacağımız':'borcumuz'} ${formatted(Math.abs(balance),a.unit)}.`;
    form.querySelector('button[type="submit"]').disabled=!balance||!choices.length;
  };
  const filter=()=>{
    const old=customer.value,q=normalize(form.querySelector('#collection-search').value.trim()),sign=form.querySelector('#collection-filter').value;
    const rows=allCaris.filter(a=>{const b=balanceFor(a);return b!==0&&(!q||normalize([a.name,a.phone,a.taxId].join(' ')).includes(q))&&(sign==='all'||(sign==='claim'?b>0:b<0));});
    customer.innerHTML=rows.map(a=>`<option value="${esc(a.id)}">${esc(a.name)} · ${esc(units[a.unit].label)}</option>`).join('');
    if(rows.some(a=>a.id===old))customer.value=old;
    updateCollection();
  };
  form.querySelector('#collection-search').addEventListener('input',filter);form.querySelector('#collection-filter').addEventListener('change',filter);customer.addEventListener('change',updateCollection);filter();
  form.querySelector('#f-quantity').addEventListener('input',()=>{const a=account(customer.value);if(!a)return;const input=form.querySelector('#f-quantity'),amount=parseAmount(input,a.unit,true);if(amount!==null&&amount>Math.abs(balanceFor(a)))input.setCustomValidity('Tutar mevcut borç veya alacağı aşamaz.');});
  form.addEventListener('submit',event=>{
    event.preventDefault();const a=account(customer.value);if(!a)return;
    const amount=parseAmount(form.querySelector('#f-quantity'),a.unit,true),balance=balanceFor(a);
    if(amount!==null&&amount>Math.abs(balance))form.querySelector('#f-quantity').setCustomValidity('Tutar mevcut borç veya alacağı aşamaz.');
    if(!form.reportValidity()||!balance||!target.value)return;
    submit({type:'collection',customerAccount:a.id,direction:balance>0?'collect':'pay',target:target.value,quantity:form.querySelector('#f-quantity').value,note:form.querySelector('#f-note').value},'Cari ve ödeme hesabı güncellendi.');
  });
  connectFieldHints(container);if(view!=='edit')prepareDraftForms();
}

function renderFinanceForm(container, kind = 'transfer') {
  const funds=financialAccounts().filter(a=>a.id!=='pos');
  if(kind==='settlement'){
    const banks=funds.filter(a=>a.unit==='TL'&&!a.physical);
    container.innerHTML=`<h2>POS tahsilatı</h2><p class="subtitle">Bankaya yatacak net tutarı yazın. Komisyon, POS alacağından otomatik hesaplanır.</p><div class="info neutral">Bekleyen POS alacağı: <b>${esc(formatted(state.balances.pos))}</b></div><form id="settlement-form"><div class="form-grid">${field('bankAccount','Paranın yatacağı banka',{options:banks.map(a=>[a.id,a.name])})}${field('gross','Kapatılacak POS alacağı · TL')}${field('expected','Bankaya yatacak net tutar · TL')}${field('fee','Hesaplanan komisyon · TL',{value:'0'})}${field('note','Açıklama · isteğe bağlı',{full:true,required:false})}</div><p id="settlement-hint" class="context-note" role="status"></p>${action('POS tahsilatını kaydet','POS azalır, net tutar seçilen bankaya geçer.')}</form>`;
    const form=container.querySelector('#settlement-form'),gross=form.querySelector('#f-gross'),expected=form.querySelector('#f-expected'),fee=form.querySelector('#f-fee');fee.readOnly=true;
    const calculate=()=>{const g=parseAmount(gross,'TL',true),n=parseAmount(expected,'TL');if(g!==null&&n!==null)expected.setCustomValidity(n>g?'Bankaya yatacak tutar POS alacağını aşamaz.':'');fee.value=g!==null&&n!==null&&g>=n?raw(g-n,'TL'):'';form.querySelector('#settlement-hint').textContent=banks.length?'Komisyon = kapatılacak POS alacağı − bankaya yatacak net tutar.':'Önce Banka/Pos/Kasa sayfasından TL banka hesabı ekleyin.';form.querySelector('button[type="submit"]').disabled=!banks.length;};
    gross.addEventListener('input',calculate);expected.addEventListener('input',calculate);calculate();
    form.addEventListener('submit',event=>{event.preventDefault();calculate();if(!form.reportValidity()||!fee.value)return;submit({type:'settlement',bankAccount:form.querySelector('#f-bankAccount').value,gross:gross.value,fee:fee.value,note:form.querySelector('#f-note').value},'POS alacağı ve banka bakiyesi güncellendi.');});
  }else if(kind==='movement'){
    container.innerHTML=`<h2>Gider / Sermaye</h2><p class="subtitle">İşletme giderini, sermaye girişini veya işletmeden çekişi kaydedin.</p><form id="movement-form"><div class="form-grid">${field('category','İşlem',{options:[['Gider','İşletme gideri'],['Sermaye','Sermaye ekleme'],['İşletmeden çekiş','İşletmeden çekiş']]})}${field('accountId','Kasa / banka',{options:funds.map(a=>[a.id,`${a.name} · ${units[a.unit].label}`])})}${field('quantity','Miktar')}${field('note','Açıklama · isteğe bağlı',{full:true,required:false})}</div><p id="movement-warning" class="context-note"></p>${action('Kaydet')}</form>`;
    const form=container.querySelector('#movement-form'),select=form.querySelector('#f-accountId');
    form.querySelector('#f-quantity').addEventListener('input',()=>{const a=account(select.value);if(a)parseAmount(form.querySelector('#f-quantity'),a.unit,true);});
    const update=()=>{const a=account(select.value);form.querySelector('#f-quantity').previousElementSibling.textContent='Miktar'+(a?' · '+units[a.unit].label:'');form.querySelector('#movement-warning').textContent=a?'Mevcut: '+formatted(state.balances[a.id],a.unit):'Önce bir kasa / banka hesabı oluşturun.';};select.addEventListener('change',update);update();
    form.addEventListener('submit',event=>{event.preventDefault();const values=formValues(form),a=account(values.accountId);if(!a)return;parseAmount(form.querySelector('#f-quantity'),a.unit,true);if(!form.reportValidity())return;submit({type:'movement',...values,direction:values.direction||(values.category==='Sermaye'?'in':'out')},'Kasa / banka hareketi kaydedildi.');});
  }else{
    container.innerHTML=`<h2>Kasa / Banka transferi</h2><p class="subtitle">TL veya dövizi aynı birimdeki hesaplarınız arasında taşıyın.</p><form id="transfer-form"><div class="form-grid">${field('fromAccount','Çıkan kasa / banka',{options:funds.map(a=>[a.id,`${a.name} · ${formatted(state.balances[a.id],a.unit)}`])})}${field('toAccount','Giren kasa / banka',{options:[]})}${field('quantity','Aktarılan miktar')}${field('note','Açıklama · isteğe bağlı',{full:true,required:false})}</div><p class="context-note" id="transfer-hint"></p>${action('Transferi kaydet','Aynı birimdeki iki hesap birlikte güncellenir.')}</form>`;
    const form=container.querySelector('#transfer-form'),from=form.querySelector('#f-fromAccount'),to=form.querySelector('#f-toAccount');
    form.querySelector('#f-quantity').addEventListener('input',()=>{const a=account(from.value);if(a)parseAmount(form.querySelector('#f-quantity'),a.unit,true);});
    const update=()=>{const a=account(from.value),old=to.value,choices=funds.filter(t=>t.id!==a?.id&&t.unit===a?.unit);to.innerHTML=choices.map(t=>`<option value="${esc(t.id)}">${esc(t.name)} · ${esc(formatted(state.balances[t.id],t.unit))}</option>`).join('');if(choices.some(t=>t.id===old))to.value=old;form.querySelector('#f-quantity').previousElementSibling.textContent='Aktarılan miktar'+(a?' · '+units[a.unit].label:'');form.querySelector('#transfer-hint').textContent=choices.length?'Bu transfer işletmenin toplam parasını değiştirmez.':'Banka/Pos/Kasa sayfasından aynı birimde ikinci hesap ekleyin.';form.querySelector('button[type="submit"]').disabled=!choices.length;};
    from.addEventListener('change',update);update();
    form.addEventListener('submit',event=>{event.preventDefault();const a=account(from.value);if(!a)return;parseAmount(form.querySelector('#f-quantity'),a.unit,true);if(!form.reportValidity()||!to.value)return;submit({type:'transfer',...formValues(form)},'Hesaplar arası transfer kaydedildi.');});
  }
  connectFieldHints(container);if(view!=='edit')prepareDraftForms();
}

function parseAmount(input, unit = 'TL', positive = false) {
  const spec = units[unit], normalized = String(input.value).trim().replace(',', '.');
  const pattern = spec.digits === 0 ? /^\d+$/ : new RegExp('^\\d+(?:\\.\\d{1,' + spec.digits + '})?$');
  const [whole = '', fraction = ''] = normalized.split('.');
  const scaled = Number(whole) * spec.scale + Number(fraction.padEnd(spec.digits, '0'));
  const valid = pattern.test(normalized) && Number.isSafeInteger(scaled) && scaled <= 1e12 && (!positive || scaled > 0);
  input.setCustomValidity(normalized && !valid ? 'Geçersiz miktar. ' + unit + ' için en fazla ' + spec.digits + ' ondalık basamak kullanın' + (positive ? '; sıfırdan büyük olmalı.' : '.') : '');
  return valid ? scaled : null;
}
function financialAccounts() { return activeAccounts().filter(a => a.kind === 'asset' && (['TL','HAS','SILVER'].includes(a.unit) || /^[A-Z]{3}$/.test(a.unit))); }

const normalize=value=>String(value||'').toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/ı/g,'i');
// Search selects a stock account on this row. Quantity and price still belong to the sale form.
function unallocatedStock(id) {
  return Math.max(0, (state.balances[id] || 0) - (state.inventoryReserved?.[id] || 0));
}

function attachSaleProductSearch(row, catalog, product, id) {
  const panel = document.createElement('div');
  panel.className = 'sale-product-search';
  panel.innerHTML = `<label class="field"><span>Ürün ara</span><input type="search" data-product-search maxlength="160" autocomplete="off" placeholder="Kod, ürün adı veya terazi grubu" aria-controls="sale-product-results-${id}"></label>
    <p class="context-note" role="status"></p><div class="sale-product-results" id="sale-product-results-${id}"></div>`;
  row.querySelector('.sale-line-header').after(panel);
  const search = panel.querySelector('input');
  const status = panel.querySelector('[role="status"]');
  const results = panel.querySelector('.sale-product-results');
  function clear() {
    search.value = '';
    search.setCustomValidity('');
    results.replaceChildren();
    status.textContent = '';
  }
  function draw() {
    const raw = search.value.trim();
    const query = normalize(raw);
    if (row.dataset.inventoryCode || !query) { clear(); return; }
    const matches = catalog.filter(item => item.code.includes(query) || item.name.includes(query) || item.groups.some(g => g.key.includes(query)));
    const exact = matches.filter(item => item.code === query);
    const literal = exact.find(item => item.account.id === raw);
    const preferred = literal || (exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : null);
    const limit = 12;
    const visible = [...new Set([literal, ...exact, ...matches.slice(0, limit)].filter(Boolean))].slice(0, limit);
    search.setCustomValidity('Bir arama sonucu seçin veya aramayı temizleyin.');
    results.replaceChildren();
    for (const item of visible) {
      const a = item.account;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button secondary compact';
      button.dataset.productResult = a.id;
      if (item === preferred) button.dataset.preferred = 'true';
      const matchingGroups = item.code.includes(query) || item.name.includes(query) ? [] : item.groups.filter(g => g.key.includes(query));
      const groups = matchingGroups.length ? matchingGroups : item.groups;
      const available = groups.filter(g => unallocatedStock(g.id) > 0);
      button.disabled = !(unallocatedStock(a.id) > 0) || (groups.length > 0 && !available.length);
      if (available.length === 1) button.dataset.weightAccount = available[0].id;
      const pools = matchingGroups.map(g => ` · ${g.name} havuzu ${formatted(unallocatedStock(g.id), 'GRAM')}`).join('');
      button.textContent = `${a.name} · ${a.id} · ${formatted(unallocatedStock(a.id), a.unit)}${pools}${button.disabled ? ' · Satışa uygun mevcut yok' : ''}`;
      results.append(button);
    }
    status.textContent = matches.length > limit ? `${matches.length} sonuçtan ilk ${limit} tanesi gösteriliyor.` : matches.length ? `${matches.length} sonuç` : 'Ürün bulunamadı.';
  }
  function choose(button) {
    if (row.dataset.inventoryCode || !button || button.disabled) return;
    if (product.value !== button.dataset.productResult) {
      product.value = button.dataset.productResult;
      product.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const group = row.querySelector('[data-item-field="weightAccount"]');
    if (button.dataset.weightAccount && group.value !== button.dataset.weightAccount) {
      group.value = button.dataset.weightAccount;
      row.querySelector('[data-item-field="weight"]').value = '';
      group.dispatchEvent(new Event('input', { bubbles: true }));
    }
    clear();
    row.querySelector('[data-item-field="quantity"]').focus();
  }
  product.addEventListener('change', clear);
  search.addEventListener('input', event => { event.stopPropagation(); draw(); });
  results.addEventListener('click', event => choose(event.target.closest('button')));
  panel.addEventListener('keydown', event => {
    if (event.isComposing || row.dataset.inventoryCode) return;
    const buttons = [...results.querySelectorAll('button:enabled')];
    if (event.key === 'Escape') {
      event.preventDefault(); clear(); search.focus();
    } else if (event.key === 'Enter' && event.target === search) {
      event.preventDefault();
      const preferred = results.querySelector('[data-preferred]');
      if (preferred) choose(preferred);
      else buttons[0]?.focus();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const index = buttons.indexOf(event.target);
      const next = event.key === 'ArrowDown' ? Math.min(index + 1, buttons.length - 1) : index - 1;
      (buttons[next] || search).focus();
    }
  });
}

function attachSaleLinePricing(row) {
  const panel = document.createElement('details');
  panel.className = 'sale-line-pricing';
  const moneyPattern = '[0-9]+([.,][0-9]{1,2})?';
  const moneyInput = (key, label, signed = false) => `<label class="field"><span>${label}</span><input data-price-field="${key}" inputmode="decimal" maxlength="24" pattern="${signed ? '-?' : ''}${moneyPattern}"></label>`;
  panel.innerHTML = `<summary>Fiyat ve maliyet bilgileri</summary>
    <div class="form-grid">${moneyInput('quotedTL','Teklif edilen toplam satır bedeli · TL')}
    <label class="field"><span>Fiyat kaynağı</span><input data-price-field="source" maxlength="120" placeholder="Örneğin ürün etiketi"></label>
    ${moneyInput('costTL','Bilinen toplam satır maliyeti · TL')}</div>
    <p class="context-note">Maliyeti bilmiyorsanız boş bırakın. Kesinleşen satış bedelini toplam satış tutarı alanına girin.</p>
    <div data-price-components></div><button type="button" class="button secondary compact" data-add-price-component>Fiyat bileşeni ekle</button>`;
  row.append(panel);
  const add = panel.querySelector('[data-add-price-component]');
  const list = panel.querySelector('[data-price-components]');
  const value = (scope, key) => scope.querySelector(`[data-price-field="${key}"]`).value.trim();
  function addComponent(part = {}, focus = false) {
    if (list.children.length >= 12) return;
    const group = document.createElement('div');
    group.className = 'form-grid';
    group.innerHTML = `<label class="field"><span>Bileşen adı</span><input data-price-field="label" maxlength="60" required></label>
      ${moneyInput('amountTL','Bileşen tutarı · TL',true)}
      <button class="button text" type="button" aria-label="Fiyat bileşenini kaldır">Kaldır</button>`;
    const name = group.querySelector('input'), amount = group.querySelector('[data-price-field="amountTL"]');
    name.value = part.label || ''; amount.value = part.amountTL ?? ''; amount.required = true;
    list.append(group);
    add.disabled = list.children.length >= 12;
    group.querySelector('button').addEventListener('click', () => {
      group.remove(); add.disabled = false; add.focus();
      panel.dispatchEvent(new Event('input', {bubbles:true}));
    });
    if (focus) name.focus();
  }
  add.addEventListener('click', () => addComponent({}, true));
  const product = row.querySelector('[data-item-field="accountId"]');
  let previousProduct = product.value;
  product.addEventListener('change', () => {
    if (product.value !== previousProduct && row.priceEditor.read()) {
      for (const input of panel.querySelectorAll('input')) input.value = '';
      list.replaceChildren();
      add.disabled = false;
      if (!restoringDraft) inform('Ürün değişti. Önceki ürüne ait fiyat ve maliyet bilgileri temizlendi.');
    }
    previousProduct = product.value;
  });
  row.priceEditor = {
    read() {
      const data = {};
      for (const key of ['quotedTL','source','costTL']) {
        const input = value(panel,key);
        if (input) data[key] = input;
      }
      if (list.children.length) data.components = [...list.children].map(group => ({label:value(group,'label'),amountTL:value(group,'amountTL')}));
      return Object.keys(data).length ? data : null;
    },
    restore(data) {
      if (!data) return;
      for (const key of ['quotedTL','source','costTL']) panel.querySelector(`[data-price-field="${key}"]`).value = data[key] ?? '';
      for (const part of data.components || []) addComponent(part);
      panel.open = true;
    }
  };
}

function itemCostAudit(meta) {
  const ref = meta.itemCostSource;
  return `<p data-private-item-cost>Ürün ${esc(meta.inventoryCode)} · Alış ${esc(ref.id)} · Satır ${ref.lineIndex + 1} · ${esc(formatted(ref.amountTL))}${meta.costRemovalReason ? ' · ' + esc(meta.costRemovalReason) : ''}</p>`;
}
function salePricingDetails(event) {
  if (event.type !== 'sale' || !event.meta.lines?.length) return '';
  const list = event.meta.lines.map((line, i) => {
    const data = line.pricing;
    const values = [`Gerçekleşen satış ${formatted(line.value)}`];
    if (data?.quotedTL !== undefined) values.push(`Teklif edilen ${formatted(data.quotedTL)}`);
    if (data?.source) values.push(`Kaynak · ${data.source}`);
    for (const part of data?.components || []) values.push(`${part.label} · ${formatted(part.amountTL)}`);
    values.push(data?.costKnown ? `Kayıtlı maliyet ${formatted(data.costTL)}` : 'Maliyet bilinmiyor');
    return `<li><strong>${i+1}. ${esc(account(line.accountId).name)}</strong><ul>${values.map(value => `<li>${esc(value)}</li>`).join('')}</ul></li>`;
  });
  return `<details data-private-sale-pricing><summary>Satır fiyatları ve kayıtlı maliyet</summary><ul>${list.join('')}</ul></details>`;
}

function renderSale(container, caris, mode = 'sale', editingCommand = null) {
  const isExchange=mode.endsWith('-exchange'),isStock=mode==='stock',isPurchase=['purchase','supplier-purchase'].includes(mode),supplier=mode.startsWith('supplier-'),partyType=supplier?'supplier':'customer';
  const stock=activeAccounts().filter(a=>(isPurchase?a.isPurchasable||a.isSaleable:a.isSaleable)&&!(a.id==='gramToplam'&&state.nominalUnconfirmed));
  const retailSearch = mode === 'sale' && !editingCommand ? stock.map(a => ({
    account: a,
    code: normalize(a.id),
    name: normalize(a.name),
    groups: a.pairedGroups.map(id => ({ id, name: account(id).name, key: normalize(account(id).name) }))
  })) : null;
  const editingCaris=new Set([editingCommand?.counterpartyId,editingCommand?.counterpartyAccount,editingCommand?.customerAccount,...(editingCommand?.credits||[]).map(row=>row.accountId),...(editingCommand?.debts||[]).map(row=>row.accountId)]);
  const legacyMultiCari=Boolean(editingCommand&&!Array.isArray(editingCommand.received)&&!Array.isArray(editingCommand.given)&&[...editingCaris].filter(Boolean).length>1);
  const ownCaris=activeAccounts().filter(a=>a.kind==='receivable'&&((a.partyType||'customer')===partyType || editingCaris.has(a.id)));
  const paymentChoices=(type,outgoing)=>{
    const financial=financialAccounts();
    const available=activeAccounts().filter(a=>a.kind==='asset'&&(financial.some(f=>f.id===a.id)||a.isPurchasable)&&(!outgoing||a.id!=='pos'));
    if(!type)return available;
    return available.filter(a=>type==='cash'?a.physical&&a.unit==='TL':type==='pos'?a.id==='pos':type==='bank'?!a.physical&&a.id!=='pos'&&financial.some(f=>f.id===a.id):type==='has'?a.unit==='HAS':type==='silver'?a.unit==='SILVER':type==='asset'?a.isPurchasable:!['TL','HAS','SILVER','GRAM','ADET'].includes(a.unit));
  };
  const scraps=activeAccounts().filter(a=>a.scrap||/^hurda\d+$/.test(a.id));
  let nextRow=0,allocationIndex=0;
  const title=isExchange?'Altın / karma cari tahsilat ve ödeme':isStock?'Stok girişi / çıkışı':isPurchase?supplier?'Toptancıdan alış':'Müşteriden alış':supplier?'Toptancıya satış':'Satış Yap';
  const chips=[['cash','Nakit'],['bank','Havale / EFT'],['foreign','Döviz / Nakit Diğer'],['has','Has altın'],['silver','Saf gümüş'],['asset','Ürün / altın']];
  const picker=(kind,outgoing)=>[...chips,...(!outgoing?[['pos','POS']]:[])].map(([type,label])=>{
    const available=paymentChoices(type,outgoing).length>0;
    return `<button type="button" class="button secondary compact payment-chip" data-add-allocation="${kind}" data-payment-type="${type}"${available?'':' disabled'}>+ ${label}${available?'':' · hesap yok'}</button>`;
  }).join('');
  const primaryTitle=supplier&&isExchange?'Mağazaya girenler':isPurchase?'Verilen karşılıklar':'Alınan karşılıklar',oppositeTitle=supplier&&isExchange?'Mağazadan çıkanlar':isPurchase?'Alınan karşılıklar':'Verilen karşılıklar';
  const partyField=field('counterpartyId',supplier?'İşlem yapılan firma':'İşlem yapılan müşteri',{required:supplier||isExchange,options:[['',supplier?'Firma seçin':'İsimsiz müşteri'],...ownCaris.filter(a=>!supplier||!a.parentAccountId||legacyMultiCari).map(a=>[a.id,supplier&&!legacyMultiCari?a.name:`${a.name} · ${units[a.unit].label}`])]});
  const nativeGuide=supplier?`<aside class="supplier-native-guide"><details><summary>Cari birim yardımı</summary><strong>${isExchange?'Ürün / altınla mahsup · satış veya alış değildir':'Borç / alacağı anlaşılmış birimde kaydedin'}</strong><p>${isExchange?'1. Firma → 2. Giren / çıkan ürün veya ödeme → 3. Anlaşılan cari birim ve miktar → 4. TL referansları.':'Ürün bedelini TL referansı olarak, ödenmeyen karşılığı cari satırında anlaşılmış birim ve miktarla girin.'}</p><p>HAS miktarı elle anlaşılır; gramdan veya TL’den otomatik çevrilmez. HAS / döviz satırındaki TL karşılığı denklik referansıdır. HAS / döviz cari satırı, seçilen borç veya alacağı etkiler; ayrıca TL borcu veya fiziki kasa hareketi oluşturmaz.</p><p>İstenen birim yoksa firma kartındaki “+ Bakiye hesabı ekle” ile HAS / döviz hesabını açın.</p></details><div id="supplier-native-balances" aria-live="polite"></div></aside>`:'';
  container.innerHTML=`<h2>${title}</h2><p class="subtitle">${isExchange?'Satış veya alış kaydı oluşmaz. Alınan/verilen varlıkları ve cari etkileri elle eşleştirin.':isStock?'Karşılıksız stok hareketi. Mal alımları için Alış ekranını kullanın.':'Miktarı kendi biriminde, anlaşılmış bedeli TL olarak girin.'}</p><form id="sale-form" class="trade-form"><section class="trade-products" aria-labelledby="trade-products-title">${isStock?`<div class="form-grid">${field('category','Stok hareketi',{options:[['Stok girişi','Stok girişi (+)'],['Sermaye','Sermaye olarak giriş (+)'],['İşletmeden çekiş','Stok çıkışı (−)']]})}</div>`:`<div class="trade-party">${partyField}${nativeGuide}</div>`}<div class="section-header sale-items-heading"${isExchange?' hidden':''}><h3 id="trade-products-title">${isPurchase?'Alınan ürünler':isStock?'Ürünler':'Verilen ürünler'}</h3><button type="button" id="add-sale-item" class="button secondary compact">+ Ürün satırı ekle</button></div><div id="sale-items"></div></section><section class="trade-checkout" aria-label="Karşılıklar ve kayıt kontrolü">${isStock?'':`<section class="allocation-section trade-primary"><h3>${primaryTitle}</h3><div class="payment-picker">${picker('payment',isPurchase)}${!isPurchase?'<button type="button" class="button secondary compact payment-chip" data-add-allocation="scrap">+ Hurda</button>':''}</div><div id="payment-lines"></div>${!isPurchase?'<div id="scrap-lines"></div>':''}</section><section class="allocation-section trade-opposite"><h3>${oppositeTitle}</h3><div class="payment-picker">${picker('counterpayment',!isPurchase)}</div><div id="counterpayment-lines"></div></section><section class="allocation-section trade-cari"><h3>Cari hesap etkisi</h3><div class="payment-picker"><button type="button" class="button secondary compact" data-add-allocation="debt">+ ${isExchange?(supplier?'Borcumuzdan düş':'Borcumuzu azalt / alacağımızı artır'):isPurchase?'Cari borç':'Cari alacak'}</button><button type="button" class="button secondary compact" data-add-allocation="counterdebt">+ ${isExchange?(supplier?'Alacağımızdan düş':'Alacağımızı azalt / borcumuzu artır'):isPurchase?'Cari alacak':'Cari borç'}</button></div><details class="trade-help"><summary>Cari alacak ve borç ne demek?</summary><p>Alacak bize ödenecek, borç bizim ödeyeceğimiz tutardır. Birim ve TL karşılığını ayrı girin.</p></details><div id="debt-lines"></div><div id="counterdebt-lines"></div></section>`}<div class="form-grid">${field('note','İşlem açıklaması · isteğe bağlı',{full:true,required:false})}</div>${isStock?'':`<div class="equation" id="sale-equation"><div><span>${isExchange?'Ürün bedeli yok · mahsup':isPurchase?'Alış bedeli':'Satış tutarı'}</span><strong id="sale-total">—</strong></div><div><span>TL denklik kontrolü</span><strong id="sale-remainder" role="status">—</strong></div></div><details class="trade-effects" open><summary>Kaydedilecek hareketleri kontrol edin</summary><div id="trade-effects"></div></details>`}${action(isExchange?'Cari işlemi kaydet':isStock?'Stok hareketini kaydet':isPurchase?'Alışı kaydet':'Satışı kaydet','Ürünler, alınanlar, verilenler ve cari etkiler tek işlemde kaydedilir.')}</section></form>`;

  const form=container.querySelector('#sale-form'),rows=()=>[...form.querySelectorAll('.sale-item')],allocationRows=kind=>[...form.querySelectorAll(`[data-allocation-kind="${kind}"]`)];
  form.dataset.operation=mode;
  const priceData = () => {
    if (mode !== 'sale') return {};
    const lines = rows().map(row => row.priceEditor.read());
    return lines.some(Boolean) ? {salePricing:{version:1,lines}} : {};
  };
  const orderPanel = !editingCommand && mode === 'sale' && (state.customerOrders || []).some(o=>o.status==='open') ? document.createElement('div') : null;
  if (orderPanel) {
    form.querySelector('.trade-party').after(orderPanel);
    const populate = () => {
      const orders = (state.customerOrders || []).filter(o => o.status === 'open' && o.customerId === form.querySelector('#f-counterpartyId').value);
      orderPanel.hidden = !orders.length;
      orderPanel.innerHTML = '<label class="field">Sipariş bağlantısı<select id="trade-order"><option value="">Bağımsız satış</option>' +
        orders.map(o => '<option value="' + esc(o.id) + '">' + esc(day(o.date)+' · '+o.description) + ' · ' + esc(formatted(o.availableTL)) + '</option>').join('') +
        '</select></label><div class="form-grid" data-order-receipts></div>';
      const select = orderPanel.querySelector('select');
      select.addEventListener('change', () => {
        delete form.dataset.missingOrder;
        const order = orders.find(o => o.id === select.value);
        const receipts = (order?.advances || []).filter(a => a.receivedTL > a.refundedTL + a.appliedTL + (a.returnedToPayableTL || 0));
        orderPanel.querySelector('[data-order-receipts]').innerHTML = receipts.map(a => '<label class="field">Mahsup edilecek TL · ' + receiptReference(a.id) +
          ' · kullanılabilir ' + esc(formatted(a.receivedTL-a.refundedTL-a.appliedTL-(a.returnedToPayableTL || 0))) + '<input inputmode="decimal" data-advance-id="' + esc(a.id) +
          '" data-available="' + (a.receivedTL-a.refundedTL-a.appliedTL-(a.returnedToPayableTL || 0)) + '"></label>').join('') + receiptTechnical(receipts.map(a=>a.id));
        hydrateReceiptLabels(orderPanel);
        updateTotals();
      });
    };
    form.querySelector('#f-counterpartyId').addEventListener('change',populate);
    orderPanel.addEventListener('input',()=>updateTotals());
    populate();
  }
  if(legacyMultiCari){
    form.querySelector('#f-counterpartyId').disabled=true;
    form.querySelector('.trade-party').insertAdjacentHTML('beforeend','<p class="context-note">Eski çok carili kayıt: hesap satırları ve eski kayıt modeli korunur. Her cari kendi biriminde düzenlenir; karşı yön eklenmez.</p>');
    for(const kind of ['counterpayment','counterdebt'])form.querySelectorAll(`[data-add-allocation="${kind}"]`).forEach(button=>{button.disabled=true;button.title='Eski çok carili kayıtta karşı yön eklenmez.';});
  }
  const familyCaris=()=>supplier&&!legacyMultiCari?ownCaris.filter(a=>form.querySelector('#f-counterpartyId').value?(a.id===form.querySelector('#f-counterpartyId').value||a.parentAccountId===form.querySelector('#f-counterpartyId').value):!a.parentAccountId):ownCaris;
  form.querySelector('#f-counterpartyId')?.addEventListener('change',()=>{if(supplier&&!legacyMultiCari)for(const kind of ['debt','counterdebt'])for(const row of allocationRows(kind)){const select=row.querySelector('select'),selected=select.value;select.innerHTML='<option value="">Bakiye hesabı seçin</option>'+familyCaris().map(a=>`<option value="${esc(a.id)}">${esc(a.name)} · ${esc(units[a.unit].label)}</option>`).join('');select.value=familyCaris().some(a=>a.id===selected)?selected:'';}updateTotals();});
  const items=()=>rows().map(row=>({ ...Object.fromEntries((isStock?['accountId','quantity','weightAccount','weight']:['accountId','quantity','weightAccount','weight','value']).map(key=>[key,row.querySelector(`[data-item-field="${key}"]`).value])), ...(row.dataset.inventoryCode && {inventoryCode:row.dataset.inventoryCode}) }));
  const allocations=kind=>allocationRows(kind).map(row=>Object.fromEntries(['accountId','quantity','valueTL','weightAccount','weight'].filter(key=>!row.querySelector(`[data-allocation-field="${key}"]`).disabled).map(key=>[key,row.querySelector(`[data-allocation-field="${key}"]`).value])));
  const updateTotals=()=>{
    form.querySelector('#add-sale-item').disabled=rows().length>=30;
    rows().forEach((row,index)=>{row.querySelector('.sale-line-title').textContent=`${index+1}. ürün`;row.querySelector('[data-remove-item]').disabled=rows().length===1&&!row.dataset.inventoryCode;const a=account(row.querySelector('[data-item-field="accountId"]').value);if(!a)return;parseAmount(row.querySelector('[data-item-field="quantity"]'),a.unit,true);const weight=row.querySelector('[data-item-field="weight"]');if(!weight.disabled)parseAmount(weight,'GRAM',true);});
    if(isStock)return;
    const values=rows().map(row=>{
      const a=account(row.querySelector('[data-item-field="accountId"]').value),q=row.querySelector('[data-item-field="quantity"]'),w=row.querySelector('[data-item-field="weight"]');
      const value=parseAmount(row.querySelector('[data-item-field="value"]'),'TL',true);
      return !a||parseAmount(q,a.unit,true)===null||(!w.disabled&&parseAmount(w,'GRAM',true)===null)?null:value;
    });
    const total=values.reduce((sum,n)=>sum+(n??0),0);
    let incomplete=values.filter(n=>n===null).length;
    const groupTotals={};
    const counterparts=[];
    for(const kind of ['payment','counterpayment','debt','counterdebt','scrap'])for(const row of allocationRows(kind)){
      const a=account(row.querySelector('[data-allocation-field="accountId"]').value),q=row.querySelector('[data-allocation-field="quantity"]'),v=row.querySelector('[data-allocation-field="valueTL"]');
      if(!a){counterparts.push(null);continue;}if(a.unit==='TL')v.value=q.value;
      if(['debt','counterdebt'].includes(kind)){const select=row.querySelector('select');select.setCustomValidity(legacyMultiCari||(supplier?familyCaris().some(member=>member.id===a.id):form.querySelector('#f-counterpartyId').value===a.id)?'':'Cari satırı, işlem için seçilen müşteri / firma hesabıyla aynı olmalı.');}
      const own=parseAmount(q,a.unit,true),reference=parseAmount(v,'TL',true),weight=row.querySelector('[data-allocation-field="weight"]');
      const validWeight=weight.disabled||parseAmount(weight,'GRAM',true)!==null;
      const valid=own!==null&&reference!==null&&validWeight&&row.querySelector('select').validity.valid;
      counterparts.push(valid?reference*(['counterpayment','counterdebt'].includes(kind)?-1:1):null);
      const group=kind==='scrap'?'payment':kind;groupTotals[group]=(groupTotals[group]||0)+(valid?reference:0);
    }
    for (const input of orderPanel?.querySelectorAll('[data-advance-id]') || []) {
      input.setCustomValidity('');
      if (!input.value.trim()) continue;
      const amount = parseAmount(input,'TL',true);
      if (amount > Number(input.dataset.available)) input.setCustomValidity('Kullanılabilir avans aşıldı.');
      counterparts.push(input.validity.valid ? amount : null);
    }
    incomplete+=counterparts.filter(n=>n===null).length;
    const provisional=total-counterparts.reduce((sum,n)=>sum+(n??0),0);
    const overflow=[total,...Object.values(groupTotals)].some(n=>!Number.isSafeInteger(n)||n>1e12)||!Number.isSafeInteger(provisional);
    const remaining=incomplete||overflow?null:provisional;
    const difference=provisional===0?'Fark: '+formatted(0):provisional>0?'Kalan: '+formatted(provisional):'Fazla ödeme: '+formatted(-provisional);
    form.querySelector('#sale-total').textContent=overflow?'Tutar sınırı aşıldı':(values.some(n=>n===null)?'Geçici: ':'')+formatted(total);
    const remainderLabel=form.querySelector('#sale-remainder');
    remainderLabel.textContent=overflow?'Tutar sınırı aşıldı; satırları kontrol edin.':isExchange&&!counterparts.length?'Karşılık girin':remaining===0?'Tam dengeli':difference;
    if(incomplete&&!overflow)remainderLabel.innerHTML=`<span>${esc('Geçici · '+difference)}</span><small>${esc('Tamamlanan satırlara göre · '+incomplete+' eksik / geçersiz satır')}</small>`;
    form.querySelector('#sale-equation').classList.toggle('error',remaining!==null&&remaining<0);
    form.querySelector('#sale-equation').classList.toggle('partial',incomplete>0||overflow);
    form.querySelector('button[type="submit"]').dataset.balanced=String(remaining===0&&(total>0||isExchange&&counterparts.length>0)&&[...form.querySelectorAll('input,select')].every(control=>control.disabled||control.validity.valid));
    const selectedParty=account(form.querySelector('#f-counterpartyId').value),partyContext=legacyMultiCari?'Eski çok carili işlem · hesap etkileri aşağıda ayrı gösterilir.':selectedParty?`İşlem yapılan ${supplier?'firma':'müşteri'}: ${selectedParty.name}${supplier?'':' · '+units[selectedParty.unit].label}`:supplier||isExchange?'Müşteri / firma: Eksik':'İsimsiz müşteri';
    if(supplier){const balancePanel=form.querySelector('#supplier-native-balances'),members=selectedParty?ownCaris.filter(a=>a.id===selectedParty.id||a.parentAccountId===selectedParty.id):[];balancePanel.innerHTML=members.length?'<strong>Firmanın mevcut bakiyeleri</strong><ul>'+members.map(a=>{const balance=state.balances[a.id]||0;return `<li><span>${esc(units[a.unit].label)}</span><strong>${esc(formatted(Math.abs(balance),a.unit))} · ${balance>0?'Alacağımız':balance<0?'Borcumuz':'Bakiyesi sıfır'}</strong></li>`;}).join('')+'</ul>':'Mevcut bakiyeleri görmek için firma seçin.';}
    const draftIncoming=[],draftOutgoing=[],draftCari=[],draftBalances=[];
    const previewAmount=(input,unit)=>{const value=parseAmount(input,unit,true);return value===null?'Eksik':formatted(value,unit);};
    const previewWeight=input=>input.disabled?'':input.value.trim()?' · '+previewAmount(input,'GRAM'):' · Ağırlık: Eksik';
    const draftRow=(name,label,quantity,weight,value)=>`<li class="receipt-flow-row draft-flow-row"><div class="receipt-flow-product"><strong>${esc(name)}</strong><small>${esc(label)}</small><span>${esc(quantity+weight)}</span></div><div class="receipt-flow-value"><small>Anlaşılmış TL karşılığı</small><strong>${esc(value)}</strong></div></li>`;
    for(const row of rows()){const a=account(row.querySelector('[data-item-field="accountId"]').value),weight=row.querySelector('[data-item-field="weight"]');(isPurchase?draftIncoming:draftOutgoing).push(draftRow(a.name,isPurchase?'Alınan ürün':'Verilen ürün',previewAmount(row.querySelector('[data-item-field="quantity"]'),a.unit),previewWeight(weight),previewAmount(row.querySelector('[data-item-field="value"]'),'TL')));}
    for(const kind of ['payment','counterpayment','debt','counterdebt','scrap'])for(const row of allocationRows(kind)){const a=account(row.querySelector('select').value);if(a){
      const label=row.querySelector('.allocation-direction').textContent,quantity=previewAmount(row.querySelector('[data-allocation-field="quantity"]'),a.unit),value=previewAmount(row.querySelector('[data-allocation-field="valueTL"]'),'TL'),weight=previewWeight(row.querySelector('[data-allocation-field="weight"]'));
      if(['debt','counterdebt'].includes(kind))draftCari.push(`${label} · ${a.name} · ${quantity} · ${value}${weight}`);
      else (kind==='scrap'||(kind==='payment'?!isPurchase:isPurchase)?draftIncoming:draftOutgoing).push(draftRow(a.name,label,quantity,weight,value));
    }}
    const previewIds=[...allocationRows('debt'),...allocationRows('counterdebt')].map(row=>row.querySelector('select').value);
    if(supplier&&view==='edit')for(const entry of editingTransaction?.original?.entries||[]){const previousAccount=account(entry.accountId);if(previousAccount?.kind==='receivable'&&previousAccount.partyType==='supplier')previewIds.push(entry.accountId);}
    const previewParties=legacyMultiCari||supplier?[...new Set(previewIds)].map(account).filter(Boolean):selectedParty?[selectedParty]:[];
    for(const selectedParty of previewParties){
      let net=0,valid=true;
      for(const kind of ['debt','counterdebt'])for(const row of allocationRows(kind)){if((legacyMultiCari||supplier)&&row.querySelector('select').value!==selectedParty.id)continue;const own=parseAmount(row.querySelector('[data-allocation-field="quantity"]'),selectedParty.unit,true);if(row.querySelector('select').value!==selectedParty.id||own===null)valid=false;else net+=own*((kind==='debt')!==isPurchase?1:-1);}
      const existing=state.balances[selectedParty.id]||0,oldEffect=view==='edit'?editingTransaction?.original?.entries?.filter(entry=>entry.accountId===selectedParty.id).reduce((sum,entry)=>sum+entry.delta,0)||0:0,next=existing-oldEffect+net;
      const balanceLabel=value=>`${formatted(Math.abs(value),selectedParty.unit)} · ${value>0?'Alacağımız':value<0?'Borcumuz':'Bakiyesi sıfır'}`;
      draftBalances.push(`${legacyMultiCari||supplier?selectedParty.name+' · ':''}Cari bakiye: ${balanceLabel(existing)} → ${valid&&Number.isSafeInteger(next)?balanceLabel(next):'Eksik'}${view==='edit'?' (eski kayıt etkisi yerine yeni etki)':''}`);
    }
    const draftGroup=(direction,title,lines)=>`<section class="receipt-flow-group" data-draft-direction="${direction}"><h4>${title}</h4><ul>${lines.join('')||'<li class="receipt-flow-empty">Bu yönde ürün veya ödeme yok.</li>'}</ul></section>`;
    form.querySelector('#trade-effects').innerHTML=`<p class="draft-party context-note">${esc(partyContext)}</p><div class="receipt-flow draft-flow">${draftGroup('in','Mağazaya girenler',draftIncoming)}${draftGroup('out','Mağazadan çıkanlar',draftOutgoing)}</div>${draftCari.length||draftBalances.length?`<section class="receipt-cari"><h4>Cari hesap etkisi</h4><p class="context-note">Cari kayıtlar ürün veya para girişi / çıkışı değildir.</p>${[...draftCari,...draftBalances].map(text=>`<p>${esc(text)}</p>`).join('')}</section>`:''}`;
    return remaining;
  };
  const addAllocation=(kind,paymentType='',savedAccount='')=>{
    const cari=['debt','counterdebt'].includes(kind),outgoing=kind==='counterpayment'?!isPurchase:kind==='payment'?isPurchase:false;
    if(!cari&&paymentType==='foreign'&&['HAS','SILVER'].includes(account(savedAccount)?.unit))paymentType=account(savedAccount).unit==='HAS'?'has':'silver';
    if(cari&&!savedAccount&&!form.querySelector('#f-counterpartyId').value){
      inform(supplier?'Önce işlem yapılan firmayı seçin.':'Önce işlem yapılan müşteriyi seçin.',true);
      form.querySelector('#f-counterpartyId').focus({preventScroll:true});
      return;
    }
    const choices=cari?familyCaris():kind==='scrap'?scraps:paymentChoices(paymentType,outgoing);
    if(!choices.length){inform(cari?(supplier?'Önce “Toptancı ekle ve işleme dön” kısayolundan firmayı ekleyin.':'Önce “Müşteri Ekranı’nda müşteri ekle” kısayolundan müşteriyi ekleyin.'):paymentType==='has'?'Kullanılabilir Has altın hesabı bulunmuyor.':'Bu karşılık türüne uygun hesap bulunamadı.',true);return;}
    if(allocationRows(kind).length>=30){inform('Bir karşılık grubunda en çok 30 satır olabilir.',true);return;}
    const id=allocationIndex++,row=document.createElement('div');row.className='allocation-row';row.dataset.allocationKind=kind;row.dataset.paymentType=paymentType;
    const creditDirection=kind==='debt'?!isPurchase:isPurchase;
    const label=cari?creditDirection?(isExchange?'Borcumuzu azalt / alacağımızı artır':'Cari alacağımız'):(isExchange?'Alacağımızı azalt / borcumuzu artır':'Cari borcumuz'):outgoing?'Verilen karşılık':'Alınan karşılık';
    row.innerHTML=`<strong class="allocation-direction">${label}</strong><div class="form-grid three"><label class="field" for="allocation-account-${id}"><span>${kind==='scrap'?'Hurdanın ayarı':cari?(supplier?'Borç / alacak birimi':'Cari hesap'):'Hesap / ürün'}</span><select id="allocation-account-${id}" data-allocation-field="accountId" required>${choices.map(a=>`<option value="${esc(a.id)}">${esc(a.name)} · ${esc(units[a.unit].label)}</option>`).join('')}</select></label><label class="field" for="allocation-quantity-${id}"><span>Miktar</span><input id="allocation-quantity-${id}" data-allocation-field="quantity" inputmode="decimal" required maxlength="24" value=""></label><label class="field" for="allocation-value-${id}"><span>${supplier?'Anlaşılmış TL referansı':'Anlaşılmış bedel · TL'}</span><input id="allocation-value-${id}" data-allocation-field="valueTL" inputmode="decimal" required maxlength="24" value=""></label><label class="field" for="allocation-group-${id}"><span>Ayar / terazi grubu</span><select id="allocation-group-${id}" data-allocation-field="weightAccount"></select></label><label class="field" for="allocation-weight-${id}"><span>Satırın toplam ağırlığı · gr</span><input id="allocation-weight-${id}" data-allocation-field="weight" inputmode="decimal" maxlength="24"><small>Adet başına değil, gerçek toplam gram.</small></label></div><div class="allocation-footer"><small class="context-note" data-allocation-note></small><button type="button" class="button text" data-remove-allocation>Satırı kaldır</button></div>`;
    form.querySelector(`#${kind}-lines`).append(row);
    const select=row.querySelector('select'),q=row.querySelector('[data-allocation-field="quantity"]'),v=row.querySelector('[data-allocation-field="valueTL"]'),group=row.querySelector('[data-allocation-field="weightAccount"]'),weight=row.querySelector('[data-allocation-field="weight"]');
    const selected=savedAccount||(cari?form.querySelector('#f-counterpartyId')?.value:'');if(choices.some(a=>a.id===selected))select.value=selected;
    if(cari&&!form.querySelector('#f-counterpartyId').value)form.querySelector('#f-counterpartyId').value=select.value;
    const change=()=>{const a=account(select.value);if(!a)return;q.previousElementSibling.textContent=(cari&&supplier?'Anlaşılan miktar · ':'Miktar · ')+units[a.unit].label;v.readOnly=a.unit==='TL';v.closest('label').hidden=a.unit==='TL';v.value=a.unit==='TL'?q.value:'';v.setCustomValidity('');const groups=cari?[]:a.pairedGroups||[];group.innerHTML=groups.map(id=>`<option value="${esc(id)}">${esc(account(id).name)}</option>`).join('');group.required=groups.length>0;group.disabled=!groups.length;group.closest('label').hidden=!groups.length;weight.required=groups.length>0;weight.disabled=!groups.length;weight.closest('label').hidden=!groups.length;weight.value='';weight.setCustomValidity('');row.querySelector('[data-allocation-note]').textContent=cari?(creditDirection?'Alacağımızı artırır / borcumuzu azaltır.':'Borcumuzu artırır / alacağımızı azaltır.') : '';row.querySelector('[data-allocation-note]').hidden=!cari;updateTotals();};
    select.addEventListener('change',change);row.querySelectorAll('input').forEach(input=>input.addEventListener('input',updateTotals));row.querySelector('[data-remove-allocation]').addEventListener('click',()=>{const next=row.nextElementSibling||row.previousElementSibling;row.remove();updateTotals();(next?.querySelector('select')||form.querySelector(`[data-add-allocation="${kind}"]`))?.focus({preventScroll:true});});change();connectFieldHints(row);return row;
  };

  const addRow=()=>{
    if(rows().length>=30||!stock.length)return;
    const id=nextRow++,row=document.createElement('section');row.className='sale-item';
    row.innerHTML=`<div class="sale-line-header"><h3 class="sale-line-title"></h3><button class="button text" type="button" data-remove-item aria-label="Bu ürün satırını kaldır">Satırı kaldır</button></div><div class="form-grid three"><label class="field" for="item-account-${id}"><span>Ürün</span><select id="item-account-${id}" data-item-field="accountId" required>${stock.map(a=>`<option value="${esc(a.id)}">${esc(a.name)}${isPurchase?'':' · '+esc(formatted(retailSearch?unallocatedStock(a.id):state.balances[a.id],a.unit))}</option>`).join('')}</select></label><label class="field" for="item-quantity-${id}"><span>Ürün miktarı</span><input id="item-quantity-${id}" data-item-field="quantity" value="1" inputmode="numeric" required maxlength="24"></label>${isStock?'':`<label class="field" for="item-value-${id}"><span>${isPurchase?'Toplam alış bedeli':'Toplam satış tutarı'} · TL</span><input id="item-value-${id}" data-item-field="value" inputmode="decimal" required maxlength="24"></label>`}<label class="field" for="item-group-${id}"><span>Ayar / terazi grubu</span><select id="item-group-${id}" data-item-field="weightAccount"></select></label><label class="field" for="item-weight-${id}"><span>Satırın toplam ağırlığı · gr</span><input id="item-weight-${id}" data-item-field="weight" inputmode="decimal" maxlength="24"><small>Adet başına değil, toplam gram.</small></label><p class="item-stock-note context-note" data-stock-note></p></div>`;
    form.querySelector('#sale-items').append(row);
    const product=row.querySelector('[data-item-field="accountId"]'),group=row.querySelector('[data-item-field="weightAccount"]'),weight=row.querySelector('[data-item-field="weight"]');
    if (mode === 'sale') attachSaleLinePricing(row);
    if (retailSearch) attachSaleProductSearch(row, retailSearch, product, id);
    const change=()=>{const a=account(product.value),groups=a.pairedGroups||[],q=row.querySelector('[data-item-field="quantity"]');q.previousElementSibling.textContent=a.unit==='GRAM'?'Toplam miktar · gr':'Ürün adedi';q.inputMode=a.unit==='ADET'?'numeric':'decimal';group.innerHTML=groups.map(id=>`<option value="${esc(id)}">${esc(account(id).name)}</option>`).join('');group.required=groups.length>0;group.disabled=!groups.length;group.closest('label').hidden=!groups.length;weight.required=groups.length>0;weight.disabled=!groups.length;weight.closest('label').hidden=!groups.length;weight.value='';weight.setCustomValidity('');row.querySelector('[data-stock-note]').textContent=groups.length?'Adet ve toplam gram birlikte kaydedilir.':a.id==='gramToplam'?'Paket adedi yerine toplam gramı girin.':'';row.querySelector('[data-stock-note]').hidden=!row.querySelector('[data-stock-note]').textContent;updateTotals();};
    product.addEventListener('change',()=>{row.dataset.productTouched='true';change();connectFieldHints(row);});row.querySelector('[data-remove-item]').addEventListener('click',()=>{if(rows().length<2){if(!row.dataset.inventoryCode)return;row.remove();addRow()?.querySelector('select').focus();updateTotals();return;}const next=row.nextElementSibling||row.previousElementSibling;row.remove();updateTotals();next?.querySelector('select').focus({preventScroll:true});});row.querySelectorAll('input').forEach(input=>input.addEventListener('input',updateTotals));change();connectFieldHints(row);return row;
  };
  form.addEventListener('click',event=>{if(!restoringDraft&&event.target.closest('[data-add-allocation],[data-remove-allocation],[data-remove-item],#add-sale-item'))form.dataset.draftDirty='true';});
  form.querySelector('#add-sale-item').addEventListener('click',()=>addRow()?.querySelector('select').focus({preventScroll:true}));
  form.querySelectorAll('[data-add-allocation]').forEach(button=>button.addEventListener('click',()=>addAllocation(button.dataset.addAllocation,button.dataset.paymentType)?.querySelector('select').focus({preventScroll:true})));
  form.addEventListener('input',updateTotals);
  form.addEventListener('submit',event=>{
    event.preventDefault();updateTotals();if(!form.reportValidity())return;
    if (form.dataset.missingOrder) { inform('Taslağın siparişi artık açık değil. Girdileri kontrol edip taslağı temizleyin veya açık bir sipariş seçin.',true); return; }
    const values=formValues(form);
    if(!isStock&&form.querySelector('button[type="submit"]').dataset.balanced!=='true'){inform('Kalan tutarı ödeme veya cari satırıyla tamamlayın. Fazla ödeme varsa tutarı düzeltin.',true);return;}
    if(isStock){submit({type:'stock',items:items(),category:values.category,direction:values.category==='İşletmeden çekiş'?'out':'in',note:values.note},'Stok hareketi kaydedildi.');return;}
    const primary=allocations('payment'),opposite=allocations('counterpayment');
    if(legacyMultiCari){
      const legacy={type:isPurchase?'purchase':'sale',items:items(),payments:primary,[isPurchase?'debts':'credits']:allocations('debt'),note:values.note};
      if(isPurchase){legacy.source=editingCommand.source||partyType;if(editingCommand.counterpartyId)legacy.counterpartyId=editingCommand.counterpartyId;if(editingCommand.counterpartyAccount)legacy.counterpartyAccount=editingCommand.counterpartyAccount;}
      else legacy.scrap=allocations('scrap');
      Object.assign(legacy, priceData());
      submit(legacy,'Eski çok carili kayıt düzeltildi.');return;
    }
    const command={type:isExchange?'collection':isPurchase?'purchase':'sale',...(isExchange?{}:{items:items()}),received:isPurchase?opposite:[...primary,...allocations('scrap')],given:isPurchase?primary:opposite,credits:allocations(isPurchase?'counterdebt':'debt'),debts:allocations(isPurchase?'debt':'counterdebt'),counterpartyId:values.counterpartyId||'',counterpartyType:partyType,note:values.note};
    Object.assign(command, priceData());
    if (orderPanel?.querySelector('select').value) {
      const advances = [...orderPanel.querySelectorAll('[data-advance-id]')].filter(input=>input.value.trim()).map(input=>({ advanceId:input.dataset.advanceId, amountTL:input.value }));
      command.orderSettlement = { orderId:orderPanel.querySelector('select').value, advances };
    }
    if(isPurchase)command.source=partyType;
    submit(command,isExchange?'Cari karşılıklar ve hesap etkileri kaydedildi.':isPurchase?'Alış, ödeme ve kalan borç kaydedildi.':'Satış ve ödemeler kaydedildi.',undefined,{key:form.dataset.draftKey});
  });
  form.draftAdapter={
    read:()=>({items:items(), ...priceData(), orderId:form.dataset.missingOrder || orderPanel?.querySelector('select')?.value,
      advanceAmounts:[...(orderPanel?.querySelectorAll('[data-advance-id]') || [])].map(input=>[input.dataset.advanceId,input.value]),
      ...Object.fromEntries(['payment','counterpayment','debt','counterdebt','scrap'].map(kind=>[kind,allocationRows(kind).map(row=>({...Object.fromEntries([...row.querySelectorAll('[data-allocation-field]')].map(control=>[control.dataset.allocationField,control.value])),paymentType:row.dataset.paymentType}))]))}),
    restore:saved=>{
      if (saved.orderId) {
        const select = orderPanel?.querySelector('select');
        if (select && [...select.options].some(o=>o.value===saved.orderId)) {
          select.value = saved.orderId;
          select.dispatchEvent(new Event('change'));
          const amounts = new Map(saved.advanceAmounts);
          for (const input of orderPanel.querySelectorAll('[data-advance-id]')) input.value = amounts.get(input.dataset.advanceId) || '';
        } else form.dataset.missingOrder = saved.orderId;
      }
      for(const row of rows())row.remove();
      for(const savedRow of (saved.items||[]).slice(0,30)){const row=addRow();if(!row)continue;for(const key of ['accountId','quantity','weightAccount','weight','value']){const control=row.querySelector(`[data-item-field="${key}"]`);if(!control||savedRow[key]===undefined)continue;if(control.tagName!=='SELECT'||[...control.options].some(option=>option.value===savedRow[key]))control.value=savedRow[key];control.dispatchEvent(new Event(control.tagName==='SELECT'?'change':'input',{bubbles:true}));}if(savedRow.inventoryCode)lockInventoryRow(row,(state.inventoryItems||[]).find(item=>item.code===savedRow.inventoryCode),savedRow.inventoryCode);}
      rows().forEach((row,i) => row.priceEditor?.restore(saved.salePricing?.lines[i]));
      if(!rows().length&&!isExchange)addRow();
      for(const kind of ['payment','counterpayment','debt','counterdebt','scrap']){for(const row of allocationRows(kind))row.remove();for(const savedRow of (saved[kind]||[]).slice(0,30)){const row=addAllocation(kind,savedRow.paymentType||'',savedRow.accountId);if(!row)continue;for(const key of ['accountId','quantity','valueTL','weightAccount','weight']){const control=row.querySelector(`[data-allocation-field="${key}"]`);if(control.tagName!=='SELECT'||[...control.options].some(option=>option.value===savedRow[key]))control.value=savedRow[key];control.dispatchEvent(new Event(control.tagName==='SELECT'?'change':'input',{bubbles:true}));}}}
      updateTotals();
    }
  };
  if(!isStock && !isPurchase && !isExchange && !supplier && state.inventoryItems?.length) bindSaleInventory(form,rows,addRow,updateTotals);
  if(!isExchange)addRow();
  if(!isStock&&view!=='edit'){
    container.insertAdjacentHTML('beforeend',`<div class="section owner-shortcuts"><h3>${supplier?'Yeni bir firmadan mı alış yapıyorsunuz?':'Müşteri listede yok mu?'}</h3><p class="context-note">${supplier?'Firma bilgileri Toptancılar ekranında tutulur.':'Müşteri bilgileri Müşteri Ekranı’nda tutulur.'} Ürün ve ödeme taslağınız korunur; hesap eklendiğinde bu işleme dönersiniz.</p><button type="button" class="button secondary" data-create-party>${supplier?'Toptancı ekle ve işleme dön':'Müşteri Ekranı’nda müşteri ekle →'}</button></div>`);
    container.querySelector('[data-create-party]').addEventListener('click',()=>startPartyCreation(form,mode));
  }
  connectFieldHints(container);if(view!=='edit')prepareDraftForms();if(isExchange)updateTotals();
}

function renderTransactionEditor(container, original) {
  const command=original.editableCommand;
  if(!command){container.innerHTML='<p class="info">Bu kaydın düzenlenebilir işlem bilgisi bulunamadı.</p>';return false;}
  const amount=(value,unit='TL')=>{const input=document.createElement('input');input.value=value??'0';return parseAmount(input,unit)||0;};
  const set=(name,value)=>{const control=container.querySelector(`[name="${name}"]`);if(!control||value===undefined)return;if(control.tagName==='SELECT'&&![...control.options].some(option=>option.value===String(value)))return;control.value=value;control.dispatchEvent(new Event(control.tagName==='SELECT'?'change':'input',{bubbles:true}));};
  if(['sale','purchase','stock'].includes(command.type)||command.type==='collection'&&Array.isArray(command.received)){
    const exchange=command.type==='collection',purchase=command.type==='purchase',mode=exchange?(command.counterpartyType||'customer')+'-exchange':purchase?(command.source==='supplier'?'supplier-purchase':'purchase'):command.type==='stock'?'stock':command.counterpartyType==='supplier'?'supplier-sale':'sale';
    const items=command.items||original.meta?.lines?.map(row=>({accountId:row.accountId,quantity:raw(row.quantity,account(row.accountId).unit),weightAccount:row.weightAccount||'',weight:row.weightAccount?raw(row.weight,'GRAM'):'',value:raw(row.value,'TL')}))||[];
    if(!exchange&&(!items.length||items.some(row=>{const a=account(row.accountId);return !a||a.retired||!(purchase?a.isPurchasable||a.isSaleable:a.isSaleable);}))) {container.innerHTML='<p class="info">Bu eski kayıtta güncel ürün kartlarıyla eşleştirilemeyen satırlar var. Yanlış miktar oluşturmamak için düzenleme açılamadı; gerekçeli iptal kullanın.</p>';return false;}
    renderSale(container,[],mode,command);
    const payments=command.payments||[['nakit',command.cash],['pos',command.pos],['banka',command.bank]].filter(([,value])=>amount(value)>0).map(([accountId,value])=>({accountId,quantity:value,valueTL:value}));
    const scrap=command.scrap||(amount(command.scrapQuantity,'GRAM')>0?[{accountId:'hurda22',quantity:command.scrapQuantity,valueTL:command.scrapValue}]:[]);
    let debt=command[purchase?'debts':'credits'];
    if(!debt){const total=items.reduce((sum,row)=>sum+amount(row.value),0),paid=payments.reduce((sum,row)=>sum+amount(row.valueTL??row.quantity),0),scrapValue=scrap.reduce((sum,row)=>sum+amount(row.valueTL),0),remaining=total-paid-scrapValue,id=purchase?command.counterpartyAccount:command.customerAccount;debt=remaining>0&&id?[{accountId:id,quantity:raw(remaining,'TL'),valueTL:raw(remaining,'TL')}]:[];}
    set('category',command.category);set('counterpartyId',command.counterpartyId||command.counterpartyAccount||command.customerAccount||debt?.[0]?.accountId||'');set('note',command.note||'');
    const salePricing=original.meta?.lines?.some(line=>line.pricing) ? command.salePricing : undefined;
    const mixed=Array.isArray(command.received)||Array.isArray(command.given);
    container.querySelector('#sale-form').draftAdapter.restore(mixed?{items,salePricing,payment:command[purchase?'given':'received']||[],counterpayment:command[purchase?'received':'given']||[],debt:command[purchase?'debts':'credits']||[],counterdebt:command[purchase?'credits':'debts']||[]}:{items,salePricing,payment:payments,debt,scrap});
  }else if(command.type==='collection'){
    const a=account(command.customerAccount);renderCollectionForm(container,a?.partyType||'customer',command);
    for(const key of ['customerAccount','target','quantity','note'])set(key,command[key]??'');
  }else if(['movement','transfer','settlement'].includes(command.type)){
    renderFinanceForm(container,command.type);
    if(command.type==='movement'&&!['Sermaye','İşletmeden çekiş','Gider'].includes(command.category)){
      const category=container.querySelector('#f-category'),option=document.createElement('option');option.value=command.category;option.textContent=command.category;category.append(option);
      const select=container.querySelector('#f-accountId'),a=account(command.accountId);if(a&&![...select.options].some(option=>option.value===a.id)){const option=document.createElement('option');option.value=a.id;option.textContent=a.name;select.append(option);}
      // Opening corrections retain their original direction; changing it is explicit in the editor.
      select.closest('.form-grid').insertAdjacentHTML('beforeend',field('direction','Düzeltme yönü',{value:command.direction,options:[['in','Giriş (+)'],['out','Çıkış (−)']]}));
    }
    const fields=command.type==='transfer'?['fromAccount','toAccount','quantity','note']:command.type==='movement'?['category','accountId','direction','quantity','note']:['bankAccount','gross','note'];
    for(const key of fields)set(key,command[key]);
    if(command.type==='settlement'){set('bankAccount',command.bankAccount||'banka');set('expected',raw(amount(command.gross)-amount(command.fee),'TL'));}
  }else{container.innerHTML='<p class="info">Bu işlem türü bu ekrandan düzenlenemez.</p>';return false;}
  const form=container.querySelector('form');if(form)form.dataset.editingOriginal=original.id;
  connectFieldHints(container);return Boolean(form);
}


function measureTable(accounts, prefix, optional = false) {
  return '<div class="table-wrap"><table class="count-table"><caption id="' + prefix + '-guide">Fark = ölçülen − beklenen. Pozitif fark fazlalık, negatif fark eksiktir. ' + (optional ? 'Boş alan ölçülmedi demektir; 0 gerçek sıfır ölçümüdür.' : 'Boş alan tamamlanmamıştır; 0 fiziksel sayım sonucudur.') + '</caption><thead><tr><th>Hesap / birim</th><th class="numeric">Beklenen</th><th>' + (optional ? 'Tartılan · boşsa ölçülmedi' : 'Sayılan') + '</th><th class="numeric">Fark</th><th>Fark gerekçesi</th></tr></thead><tbody>' + accounts.map(a => '<tr><td><strong>' + esc(a.name) + '</strong><br><span class="muted">' + esc(units[a.unit].label) + '</span></td><td class="numeric" id="' + prefix + '-expected-' + esc(a.id) + '">' + (a.id === 'gramToplam' && state.nominalUnconfirmed ? 'Açılış onayı bekliyor' : esc(formatted(state.balances[a.id], a.unit))) + '</td><td><label class="field" for="' + prefix + '-count-' + esc(a.id) + '"><span class="sr-only">' + esc(a.name) + ' ölçülen</span><input id="' + prefix + '-count-' + esc(a.id) + '" name="count-' + esc(a.id) + '" inputmode="decimal" autocomplete="off" maxlength="24" ' + (optional ? '' : 'required') + ' aria-describedby="' + prefix + '-guide ' + prefix + '-expected-' + esc(a.id) + '" data-measure="' + esc(a.id) + '" aria-label="' + esc(a.name + ' · ' + units[a.unit].label + (optional ? ' tartılan miktar' : ' günlük sayım miktarı')) + '"></label></td><td class="numeric count-diff" id="' + prefix + '-diff-' + esc(a.id) + '">—</td><td><label class="field" for="' + prefix + '-reason-' + esc(a.id) + '"><span class="sr-only">' + esc(a.name) + ' fark gerekçesi</span><input id="' + prefix + '-reason-' + esc(a.id) + '" name="reason-' + esc(a.id) + '" maxlength="160" aria-describedby="' + prefix + '-diff-' + esc(a.id) + '" aria-label="' + esc(a.name) + ' fark gerekçesi" placeholder="Fark varsa zorunlu"></label></td></tr>').join('') + '</tbody></table></div>';
}
function bindMeasureForm(formId, accounts, prefix, type) {
  const form = document.getElementById(formId), revision = state.revision, date = state.date;
  if (type === 'close') {
    form.insertAdjacentHTML('afterbegin','<div class="count-status"><p id="count-progress" role="status" aria-live="polite"></p><div class="count-tools"><label><input type="checkbox" id="count-differences-only"> Yalnız fark olan satırları göster</label></div><small>Gizlenen boş satırlar tamamlanmış sayılmaz. Bütün günlük hesaplar fiziksel olarak sayılmalıdır.</small></div>');
    const updateProgress = () => {
      let completed=0,differences=0;
      for (const input of form.querySelectorAll('[data-measure]')) {
        const a=account(input.dataset.measure);let counted=null;
        try { if(input.value.trim())counted=parseAmount(input,a.unit); } catch {}
        if(counted!==null)completed++;
        const different=counted!==null&&counted!==(state.balances[a.id]||0);
        if(different)differences++;
        input.closest('tr').hidden=$('#count-differences-only').checked&&!different;
      }
      $('#count-progress').textContent=`${completed} / ${accounts.length} hesap sayıldı · ${accounts.length-completed} bekliyor · ${differences} fark. Kapanacak iş günü: ${day(date)}.`;
    };
    const revealMissing=()=>{
      $('#count-differences-only').checked=false;updateProgress();
      const missing=[...form.querySelectorAll('[data-measure]')].find(input=>!input.value.trim()||!input.validity.valid);
      missing?.focus();
    };
    form.querySelector('.count-tools').insertAdjacentHTML('beforeend','<button class="button secondary compact" type="button" id="count-show-missing">İlk eksik sayıma git →</button>');
    $('#count-show-missing').addEventListener('click',revealMissing);
    // Native validation runs before submit: reveal filtered invalid controls synchronously.
    form.addEventListener('invalid',event=>{
      if(event.target.closest('tr')?.hidden){$('#count-differences-only').checked=false;updateProgress();}
    },true);
    form.addEventListener('input',updateProgress);$('#count-differences-only').addEventListener('change',updateProgress);updateProgress();
  }
  for (const input of form.querySelectorAll('[data-measure]')) input.addEventListener('input', () => {
    const a = account(input.dataset.measure), spec = units[a.unit], normalized = input.value.trim().replace(',', '.');
    const pattern = spec.digits === 0 ? /^\d+$/ : new RegExp('^\\d+(?:\\.\\d{1,' + spec.digits + '})?$');
    const parts = normalized.split('.'), scaled = Number(parts[0]) * spec.scale + Number((parts[1] || '').padEnd(spec.digits, '0'));
    const valid = pattern.test(normalized) && Number.isSafeInteger(scaled) && scaled <= 1e12;
    input.setCustomValidity(!normalized || valid ? '' : 'Geçersiz miktar: en fazla ' + spec.digits + ' ondalık basamak kullanın.');
    const delta = normalized && valid ? scaled - (state.balances[a.id] || 0) : null;
    const cell = document.getElementById(prefix + '-diff-' + a.id);
    cell.textContent = !normalized ? '—' : !valid ? 'Geçersiz miktar' : formatted(delta, a.unit);
    cell.className = 'numeric count-diff' + (delta || (!valid && normalized) ? ' negative' : '');
    document.getElementById(prefix + '-reason-' + a.id).required = delta !== null && delta !== 0;
  });
  form.addEventListener('submit', e => {
    e.preventDefault(); const values = formValues(form);
    const selected = type === 'stocktake' ? accounts.filter(a => values['count-' + a.id].trim() !== '') : accounts;
    if (!selected.length) { inform('En az bir terazi hesabının gerçek tartımını girin. Boş alan sıfır değildir.', true); return; }
    const command = { type, date, counts: Object.fromEntries(selected.map(a => [a.id, values['count-' + a.id]])), reasons: Object.fromEntries(selected.map(a => [a.id, values['reason-' + a.id]])), approvedBy: values[type === 'close' ? 'dailyApprovedBy' : 'stockApprovedBy'], ...(type==='close'?{nextDate:values.nextDate}:{}) };
    submit(command, type === 'close' ? 'Günlük sayım kaydedildi; gram havuzları tartım yapılmış sayılmadan ertesi güne devredildi.' : 'Dönemsel tartım ve gerekçeli gram farkları kaydedildi. İş günü ve günlük adetler değişmedi.', { id: crypto.randomUUID(), revision, command });
  });
}
function measurementRows(rows) {
  return '<div class="table-wrap"><table><thead><tr><th>Hesap</th><th class="numeric">Beklenen</th><th class="numeric">Ölçülen</th><th class="numeric">Fark</th><th>Gerekçe</th></tr></thead><tbody>' + rows.map(row => { const a = account(row.accountId); return '<tr><td>' + esc(a.name) + '</td><td class="numeric">' + esc(formatted(row.expected,a.unit)) + '</td><td class="numeric">' + (row.counted === null ? 'Tartılmadı' : esc(formatted(row.counted,a.unit))) + '</td><td class="numeric">' + (row.difference === null || row.difference === undefined ? '—' : esc(formatted(row.difference,a.unit))) + '</td><td>' + esc(row.reason || (row.counted === null ? 'Hesaplanan bakiye korundu.' : 'Fark yok')) + '</td></tr>'; }).join('') + '</tbody></table></div>';
}
function renderClosing() {
  const daily = activeAccounts().filter(a => a.physical && a.countPolicy === 'daily');
  const periodic = activeAccounts().filter(a => a.physical && a.countPolicy === 'periodic');
  $('#main').innerHTML = '<div class="closing-screen">'+heading('Sayım ve Kapanış', 'Günlük kapanış veya dönemsel tartım seçin.') +
    '<div class="info neutral">Açık iş günü: <b>' + esc(day(state.date)) + '</b> · kayıt sürümü ' + state.revision + '. Yeni kayıt gelirse sayımı güncel bilgilerle yeniden kontrol edin.</div>' +
    '<section class="section"><div class="section-header"><div><h2>Günlük sayım ve gün kapanışı</h2><p class="muted">Nakit/döviz, ürün adetleri, gram altın ve 8/14/18/21/22/24 ayar hurda gramları zorunludur.</p></div><span class="badge gold">' + esc(state.date) + ' açık</span></div><form id="close-form">' + measureTable(daily,'daily') + '<div class="form-grid closing-approver">' + approvalField('dailyApprovedBy','Günlük sayımı onaylayan') + '</div><div class="info">Farklar gerekçeli düzeltme olarak kaydedilir. POS, banka ve cari bakiyeleri korunur.</div><div class="balance-grid">' + periodic.map(balanceRow).join('') + '</div>' + action('Günlük sayımı onayla ve ertesi güne devret','Takı, bilezik ve HAS kasa gramları günlük kapanışta tartılmadan bakiyeleri korunarak devredilir.') + '</form></section>' +
    '<section class="section"><div class="section-header"><div><h2>Dönemsel terazi sayımı</h2><p class="muted">Yalnız gerçekten tarttığınız gram hesaplarını doldurun.</p></div><span class="badge">Günü kapatmaz</span></div><form id="stocktake-form">' + measureTable(periodic,'periodic',true) + '<div class="form-grid closing-approver">' + approvalField('stockApprovedBy','Terazi sayımını onaylayan') + '</div><div class="info neutral">Gram farkı ürün adedini değiştirmez; yalnız girilen gram hesapları düzeltilir.</div>' + action('Dönemsel tartımı kaydet','İş günü aynı kalır; günlük adetler değiştirilmez.') + '</form></section>' +
    '<section class="section closing-history"><h2>Gün kapanışları</h2>' + (state.closings.length ? state.closings.slice().reverse().map(c => '<details><summary>' + esc(day(c.date)) + ' → ' + esc(day(c.nextDate)) + ' · ' + countApprover(c) + '</summary>' + measurementRows(c.counts) + ((c.carried || []).length ? '<h3>Tartım yapılmadan devreden gramlar</h3>' + measurementRows(c.carried) : '') + '</details>').join('') : '<p class="muted">Henüz kapanmış gün yok.</p>') + '</section>' +
    '<section class="section closing-history"><h2>Dönemsel tartım geçmişi</h2>' + ((state.stocktakes || []).length ? state.stocktakes.slice().reverse().map(c => '<details><summary>' + esc(day(c.date)) + ' · ' + countApprover(c) + '</summary>' + measurementRows(c.counts) + '</details>').join('') : '<p class="muted">Henüz dönemsel tartım kaydı yok. Hesaplanan gram, tartılarak doğrulanmış gram değildir.</p>') + '</section></div>';
  const followingDate=new Date(`${state.date}T12:00:00Z`);followingDate.setUTCDate(followingDate.getUTCDate()+1);
  const defaultNextDate=followingDate.toISOString().slice(0,10);
  $('#close-form .form-grid').insertAdjacentHTML('beforeend',field('nextDate','Sonraki açık iş günü',{type:'date',value:defaultNextDate,hint:'Çalışacağınız günü siz seçin. Pazar veya tatil günü otomatik olarak atlanmaz.'}));
  $('#f-nextDate').min=defaultNextDate;
  $('#close-form button[type="submit"]').textContent='Günlük sayımı onayla ve seçilen güne devret';
  bindMeasureForm('close-form',daily,'daily','close');
  bindMeasureForm('stocktake-form',periodic,'periodic','stocktake');
  const dailySection=$('#close-form').closest('section'),periodicSection=$('#stocktake-form').closest('section');
  dailySection.insertAdjacentHTML('beforebegin','<div class="count-modes" role="group" aria-label="Sayım türü"><button type="button" class="count-mode active" data-count-mode="daily" aria-pressed="true"><strong>Günlük kapanış</strong><small>Nakit, adet, gram altın ve hurda</small></button><button type="button" class="count-mode" data-count-mode="periodic" aria-pressed="false"><strong>Dönemsel Tartım</strong><small>Takı, bilezik ve HAS kasa gramları</small></button></div>');
  periodicSection.hidden=true;
  const carriedGrid=$('#close-form > .balance-grid');
  if(carriedGrid){const details=document.createElement('details');details.innerHTML='<summary>Tartılmadan devreden gram stokları</summary>';carriedGrid.before(details);details.append(carriedGrid);}
  // Presentation grouping only: controls and their original order stay in the same form.
  for (const [id,title] of [['close-form','Kontrol ve gün devri onayı'],['stocktake-form','Tartım onayı · iş günü açık kalır']]) {
    const form=document.getElementById(id),start=form.querySelector('.closing-approver');
    const panel=document.createElement('div');panel.className='count-approval';
    panel.setAttribute('role','group');panel.setAttribute('aria-labelledby',id+'-approval-title');
    const titleNode=document.createElement('h3');titleNode.id=id+'-approval-title';titleNode.textContent=title;panel.append(titleNode);
    const nodes=[];for(let node=start;node;node=node.nextElementSibling)nodes.push(node);
    start.before(panel);panel.append(...nodes);
  }
  document.querySelectorAll('[data-count-mode]').forEach(button=>button.addEventListener('click',()=>{captureDrafts();const periodic=button.dataset.countMode==='periodic';dailySection.hidden=periodic;periodicSection.hidden=!periodic;document.querySelectorAll('[data-count-mode]').forEach(tab=>{const active=tab===button;tab.classList.toggle('active',active);tab.setAttribute('aria-pressed',String(active));});}));
}
function renderNominalOpeningGate() {
  if (!state.initialized || !state.nominalUnconfirmed || ['journal','backup'].includes(view)) return;
  const capturedRevision = state.revision, capturedDate = state.date;
  $('#main').insertAdjacentHTML('afterbegin','<section class="section" aria-labelledby="nominal-opening-title"><div class="section-header"><div><h2 id="nominal-opening-title">Gram altının gerçek toplamını onaylayın</h2><p class="muted">Önceki sürümdeki paket adedi veya ayrı ağırlık hesabı yeni nominal toplamınıza otomatik çevrilmedi.</p></div><span class="badge gold">Onay bekliyor</span></div><div class="info">Kasada 243 gram altın varsa <b>243</b> girin. 10 gramlık bir ürün bu toplamda 10 anlamına gelir; paket sayısı 1 olarak yazılmaz. Mevcut yoksa <b>0</b> geçerli bir onaydır. Eski hareketler korunur.</div><form id="nominal-opening-form"><div class="form-grid"><label class="field" for="nominal-quantity"><span>Gerçek toplam nominal gram altın</span><input id="nominal-quantity" name="quantity" required maxlength="24" inputmode="decimal" autocomplete="off"><small>Boş alan sıfır değildir; 243 veya 243,500 gibi binlik ayırıcısız yazın.</small></label><label class="field" for="nominal-note"><span>Onay açıklaması / referans</span><input id="nominal-note" name="note" required maxlength="160"><small>Eski paket sayısından miktar tahmini yapılmaz.</small></label></div>' + action('Gerçek gram altın toplamını kaydet','Yalnız bu toplamın açılışı onaylanır; satış veya kazanç oluşmaz.') + '</form></section>');
  $('#nominal-opening-form').addEventListener('submit',e => {
    e.preventDefault(); const values = formValues(e.currentTarget);
    const command = {type:'nominalOpening',date:capturedDate,quantity:values.quantity,note:values.note};
    submit(command,'Gram altının gerçek nominal toplamı onaylandı. Paket adedi tahmini yapılmadı.',{id:crypto.randomUUID(),revision:capturedRevision,command});
  });
}
function renderSummary() {
  $('#main').innerHTML=heading('Günlük İşletme Özeti','İş gününü seçin, görmek istediğiniz hesaplara odaklanın.')+`<section class="section"><form id="summary-form"><div class="summary-filters">${field('summaryDate','İş günü',{type:'date',value:state.date})}<label class="field"><span>Hesap grubu</span><select id="summary-kind"><option value="all">Bütün hesaplar</option><option value="stock">Stok</option><option value="money">Kasa / Banka / POS</option><option value="customer">Müşteriler</option><option value="supplier">Toptancılar</option></select></label><label class="field"><span>Hesap ara</span><input id="summary-search" type="search" maxlength="160" placeholder="Hesap veya ürün adı"></label><label class="field"><span>Birim</span><select id="summary-unit"><option value="">Bütün birimler</option>${[...new Set(state.accounts.map(a=>a.unit))].map(unit=>`<option value="${esc(unit)}">${esc(units[unit].label)}</option>`).join('')}</select></label><label><input id="summary-active" type="checkbox"> Yalnız hareket olan hesaplar</label></div>${action('Günün özetini göster','Geçmiş günleri de inceleyebilirsiniz.')}</form><p id="summary-status" class="context-note" role="status" aria-live="polite" aria-atomic="true"></p><div id="summary-result" role="region" aria-label="Seçilen günün hesap özeti"></div></section>`;
  const result=$('#summary-result'),status=$('#summary-status'),selectedWorkspace=workspace;let sequence=0,loaded=null;
  const draw=()=>{
    if(!loaded)return;const group=$('#summary-kind').value,q=$('#summary-search').value.toLocaleLowerCase('tr-TR'),unit=$('#summary-unit').value,active=$('#summary-active').checked;
    const rows=loaded.accounts.filter(row=>{const a=account(row.accountId);if(a.retired&&['opening','incoming','outgoing','adjustment','closing'].every(key=>row[key]===0))return false;return(!q||a.name.toLocaleLowerCase('tr-TR').includes(q))&&(!unit||row.unit===unit)&&(!active||row.incoming||row.outgoing||row.adjustment)&&(group==='all'||group==='stock'&&isStockAccount(a)||group==='money'&&a.kind==='asset'&&!isStockAccount(a)||group==='customer'&&a.kind==='receivable'&&(a.partyType||'customer')==='customer'||group==='supplier'&&a.kind==='receivable'&&a.partyType==='supplier');});
    result.innerHTML=`<div class="summary-day"><div><span class="eyebrow">Görüntülenen iş günü</span><h2>${esc(day(loaded.date))}</h2><p>Gün toplamları hesap filtresinden etkilenmez. Kâr değildir.</p></div><dl><div><dt>Net satış</dt><dd>${esc(formatted(loaded.totals.sales))}</dd></div><div><dt>Net alış</dt><dd>${esc(formatted(loaded.totals.purchases))}</dd></div></dl></div><div class="table-wrap summary-ledger"><table><caption>Hesap hareket cetveli · ${esc(day(loaded.date))}<span>Gelen devir + giriş − çıkış + sayım düzeltmesi = gün sonu bakiye. Her satır kendi biriminde okunur. Farklı birimler toplanmaz.</span></caption><thead><tr><th scope="col">Hesap / birim</th><th scope="col" class="numeric">Gelen devir</th><th scope="col" class="numeric">Giriş</th><th scope="col" class="numeric">Çıkış</th><th scope="col" class="numeric">Sayım düzeltmesi</th><th scope="col" class="numeric">Gün sonu bakiye</th></tr></thead><tbody>${rows.map(row=>`<tr><th scope="row">${summaryAccountLabel(row.accountId)}<small>${esc(units[row.unit].label)}</small></th>${['opening','incoming','outgoing','adjustment','closing'].map(key=>`<td class="numeric">${esc(formatted(row[key],row.unit))}</td>`).join('')}</tr>`).join('')||'<tr><td colspan="6">Bu filtrelerle eşleşen hesap yok.</td></tr>'}</tbody></table></div>`;enhanceTables(result);status.textContent=`${day(loaded.date)} özeti hazır. ${rows.length} / ${loaded.accounts.length} hesap gösteriliyor.`;
  };
  const load=async()=>{const ticket=++sequence,date=$('#f-summaryDate').value;status.textContent='Özet hazırlanıyor…';result.textContent='';loaded=null;try{const summary=await request('summary',undefined,selectedWorkspace,{query:{date}});if(view!=='summary'||workspace!==selectedWorkspace||ticket!==sequence||!result.isConnected)return;loaded=summary;draw();}catch(error){if(result.isConnected&&ticket===sequence){status.textContent='Özet alınamadı. Tarihi kontrol ederek yeniden deneyin.';result.textContent='Özet alınamadı: '+error.message;}}};
  $('#summary-form').addEventListener('submit',e=>{e.preventDefault();load();});for(const id of ['summary-kind','summary-unit','summary-active'])$('#'+id).addEventListener('change',draw);$('#summary-search').addEventListener('input',draw);load();
}

function returnProductFields(form, update) {
  const target = form.querySelector('[data-return-fund]').closest('.form-grid');
  const choices = activeAccounts().filter(a => a.isSaleable && state.balances[a.id] > 0 && !(a.nominal && state.nominalUnconfirmed));
  target.insertAdjacentHTML('beforebegin', `<fieldset><legend>Ürünle karşılık</legend>${state.inventoryItems?.some(item=>item.status==='available')?'<label class="field"><span>Tekil ürün kodu veya barkodu</span><input type="search" name="refundItemSearch" maxlength="160" autocomplete="off"></label><p class="context-note" data-item-matches aria-live="polite"></p>':''}<label class="field"><span>Verilen ürün</span><select name="refundProduct"><option value="">Ürün verilmiyor</option>${choices.filter(a=>unallocatedStock(a.id)>0 && (!a.pairedGroups.length || a.pairedGroups.some(id=>unallocatedStock(id)>0))).map(a => `<option value="${esc(a.id)}">${esc(a.name)} · ${esc(formatted(unallocatedStock(a.id), a.unit))}</option>`).join('')}</select></label>
    <div class="form-grid" data-refund-product-fields><label class="field"><span>Verilen miktar</span><input name="refundProductQuantity" inputmode="decimal" maxlength="24"></label>
    <label class="field"><span>İşlem</span><select name="returnOperation"><option value="refund">İade karşılığı ürün ver</option><option value="exchange">Yeni ürünle değiştir</option></select></label>
    <label class="field"><span>Terazi grubu</span><select name="refundProductGroup"></select></label>
    <label class="field"><span>Gerçek toplam gram</span><input name="refundProductWeight" inputmode="decimal" maxlength="24"></label>
    <label class="field"><span>Ürünün anlaşılmış karşılığı · TL</span><input name="refundProductValue" inputmode="decimal" maxlength="24"></label></div></fieldset>`);
  const { refundProduct: product, refundProductQuantity: qty, refundProductGroup: group, refundProductWeight: weight, refundProductValue: value } = form.elements;
  const controls = [qty, group, weight, value];
  const search = form.elements.refundItemSearch;
  const found = document.createElement('optgroup');
  found.label = 'Tekil ürünler'; product.append(found);
  const selectedItem = () => product.selectedOptions[0]?.inventoryItem;
  if (search) {
    const draw = () => {
      const matches = search.value.trim() ? (state.inventoryItems || []).filter(item => item.status === 'available' && inventoryMatches(item,search.value)) : [];
      const selected = selectedItem();
      const exact = matches.find(item=>[item.code,item.barcode].includes(search.value.trim().toUpperCase()));
      const shown = [...new Set([selected, exact,...matches.slice(0,12)].filter(Boolean))];
      found.replaceChildren();
      for (const item of shown) {
        const option = document.createElement('option'); option.textContent = inventoryLabel(item);
        option.value = 'item:' + item.code; option.inventoryItem = item; found.append(option);
        if (item === selected) option.selected = true;
      }
      form.querySelector('[data-item-matches]').textContent = search.value ? (matches.length ? matches.length+' tekil ürün. Verilen ürün listesinden seçin.' : 'Stokta eşleşen tekil ürün yok.') : '';
      return exact || (matches.length === 1 ? matches[0] : null);
    };
    search.addEventListener('input', draw);
    search.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      const item = draw();
      if (item) { product.value='item:'+item.code; product.dispatchEvent(new Event('change',{bubbles:true})); value.focus(); }
      else product.focus();
    });
  }
  const configure = () => {
    const item = selectedItem(), a = account(item ? item.accountId : product.value), groups = a?.pairedGroups || [];
    form.querySelector('[data-refund-product-fields]').hidden = !a;
    group.innerHTML = groups.map(id => `<option value="${esc(id)}">${esc(account(id).name)}</option>`).join('');
    for (const field of controls) {
      field.disabled = !a || ([group, weight].includes(field) && !groups.length);
      field.closest('label').hidden = field.disabled;
      field.required = !field.disabled;
      field.setCustomValidity('');
      if (!restoringDraft && field !== group) field.value = '';
    }
    if (item) {
      qty.value='1'; qty.readOnly=true;
      if (item.weightAccount) { group.value=item.weightAccount; group.disabled=true; weight.value=raw(item.actualWeight,'GRAM'); weight.readOnly=true; }
    } else { qty.readOnly=false; weight.readOnly=false; }
    if (a) qty.previousElementSibling.textContent = 'Verilen miktar · ' + units[a.unit].label;
  };
  configure();
  form.elements.returnOperation.addEventListener('change', update);
  product.addEventListener('change', () => { configure(); update(); });
  for (const field of controls) field.addEventListener('input', () => { field.setCustomValidity(''); update(); });
  return {
    value: () => product.value ? parseAmount(value, 'TL', true) || 0 : 0,
    read() {
      if (!product.value) return null;
      const item = selectedItem(), a = account(item ? item.accountId : product.value);
      if (parseAmount(qty, a.unit, true) > (item ? 1 : unallocatedStock(a.id))) qty.setCustomValidity('Verilen miktar stok mevcudunu aşıyor.');
      if (!weight.disabled && parseAmount(weight, 'GRAM', true) > (item ? item.actualWeight : unallocatedStock(group.value))) weight.setCustomValidity('Verilen gram terazi mevcudunu aşıyor.');
      return { accountId: a.id, quantity: qty.value, valueTL: value.value, ...(item && {inventoryCode:item.code}), ...(weight.disabled ? {} : { weightAccount: group.value, weight: weight.value }) };
    }
  };
}

function returnCustomerFields(form, original, changed) {
  const candidates = [...new Set(original.entries.map(e=>e.accountId).filter(id=>account(id)?.kind==='receivable'))];
  const id = original.meta.counterpartyId || (candidates.length===1 ? candidates[0] : original.scrapLinkCustomerId);
  const customer = account(id);
  if (!customer || customer.retired || customer.kind!=='receivable' || customer.partyType==='supplier' || original.meta.counterpartyType==='supplier') return () => ({ rows:[], total:0 });
  const initial = state.balances[id] || 0;
  const names = {reduceDebt:'Müşterinin açık borcundan düş',grantCredit:'Müşteriye yeni alacak yaz'};
  const section = document.createElement('details');
  section.innerHTML = '<summary>Cari ile iade karşılığı · ' + esc(customer.name) + '</summary><p class="context-note">İade öncesi ' + (initial>0?'müşterinin borcu':initial<0?'müşterinin alacağı':'bakiye') + ' · ' + esc(formatted(Math.abs(initial),customer.unit)) + '</p>' +
    Object.entries(names).filter(([action])=>action!=='reduceDebt'||initial>0).map(([action,label])=>
      '<div class="form-grid" data-cari-action="' + action + '"><label class="field">' + esc(label) + ' · ' + esc(units[customer.unit].label) + '<input name="' + action + 'Quantity" inputmode="decimal" maxlength="24"></label>' +
      (customer.unit==='TL'?'':'<label class="field">Anlaşılmış karşılık · TL<input name="' + action + 'ValueTL" inputmode="decimal" maxlength="24"></label>') + '</div>').join('');
  form.querySelector('[data-return-total]').before(section);
  section.addEventListener('input',changed);
  return () => {
    let balance=initial, total=0;
    const rows=[];
    for (const group of section.querySelectorAll('[data-cari-action]')) {
      const [native, reference] = group.querySelectorAll('input');
      native.setCustomValidity('');
      if (reference) reference.setCustomValidity('');
      if (!native.value.trim() && !reference?.value.trim()) continue;
      const amount = parseAmount(native,customer.unit,true), action=group.dataset.cariAction;
      const valueTL = reference ? parseAmount(reference,'TL',true) : amount;
      if (!amount) native.setCustomValidity('Cari miktarı girin.');
      if (reference && !valueTL) reference.setCustomValidity('Anlaşılmış TL karşılığını girin.');
      if (action==='reduceDebt' && amount>Math.max(0,balance)) native.setCustomValidity('Müşterinin açık borcu aşıldı.');
      balance -= amount || 0;
      total += valueTL || 0;
      rows.push({action,accountId:id,quantity:native.value,valueTL:reference ? reference.value : native.value});
    }
    return {rows,total,balance};
  };
}

function bindPriorScrapLink(article, sale, reversed, current) {
  const partyId = Object.hasOwn(sale,'scrapLinkCustomerId') ? sale.scrapLinkCustomerId : sale.meta.counterpartyId;
  if (sale.type !== 'sale' || reversed.has(sale.id) || !partyId ||
      sale.meta.counterpartyType === 'supplier' || account(partyId)?.partyType === 'supplier') return;
  const panel = document.createElement('details');
  panel.dataset.scrapLink = '';
  panel.innerHTML = `<summary>Önceki hurda alışını ilişkilendir</summary>
    <label class="field"><span>${esc(account(partyId).name)} · Satıştan önceki hurda alışı</span><select></select></label>
    <p class="context-note">Bağlantı yalnızca iki kaydı müşteri geçmişinde bir araya getirir. Stok, ödeme ve cari bakiyeler aynı kalır.</p>
    <p role="status" class="context-note"></p><details><summary>Teknik kayıt bilgileri</summary><p data-link-id style="overflow-wrap:anywhere"></p></details>
    <button type="button" class="button secondary compact" data-more-scrap hidden>Daha eski alışları göster</button>
    <button type="button" class="button secondary compact" data-link-purchase disabled>Seçili alışı satışa bağla</button>`;
  article.append(panel);
  const select = panel.querySelector('select'), status = panel.querySelector('[role="status"]');
  const more = panel.querySelector('[data-more-scrap]'), submitButton = panel.querySelector('[data-link-purchase]');
  const selectedWorkspace = workspace, revision = state.revision;
  let generation = 0, cursor = null;
  function reset() {
    select.replaceChildren(new Option('Alış seçin', '')); cursor = null;
    submitButton.disabled = true; more.hidden = true;
  }
  async function load(append = false) {
    const ticket = ++generation;
    if (!append) reset();
    more.disabled = true; status.textContent = 'Hurda alışları yükleniyor…';
    try {
      const page = await request('journal', undefined, selectedWorkspace, {query:{
        scope:'all', type:'purchase', accountId:partyId, scrapForSale:sale.id, limit:25, ...(cursor && {cursor})
      }});
      if (ticket !== generation || !current() || !panel.isConnected) return;
      if (page.revision !== revision) throw Error('Defter değişti. Yenileyip yeniden açın.');
      for (const purchase of page.items) {
        const scrap = purchase.meta.lines.filter(line => account(line.accountId)?.scrap);
        const items = scrap.map(line => `${account(line.accountId).name} · ${formatted(line.quantity,'GRAM')}`).join(' / ');
        select.add(new Option(receiptChoiceText(purchase), purchase.id));
      }
      cursor = page.nextCursor; more.hidden = !cursor; more.disabled = false;
      status.textContent = select.length > 1 ? `${select.length-1} alış gösteriliyor.` : 'Bağlanabilecek önceki hurda alışı yok.';
    } catch (error) {
      if (ticket !== generation || !current() || !panel.isConnected) return;
      reset(); status.textContent = error.message;
    }
  }
  panel.addEventListener('toggle', () => { if (panel.open) load(); else generation++; });
  select.addEventListener('change', () => {
    submitButton.disabled = !select.value;
    panel.querySelector('[data-link-id]').textContent=select.value||'Alış seçilmedi';
    if (select.value) {
      status.style.overflowWrap = 'anywhere';
      status.textContent = 'Seçilen alış · ' + select.selectedOptions[0].textContent;
    } else status.textContent = (select.length-1) + ' alış gösteriliyor.';
  });
  more.addEventListener('click', () => load(true));
  submitButton.addEventListener('click', () => {
    if (current() && select.value) submit({type:'linkScrapPurchase',saleId:sale.id,purchaseId:select.value}, 'Hurda alış bağlantısı müşteri geçmişine kaydedildi.');
  });
}

function scrapTraceReceipt(event, available) {
  if (event.type !== 'linkScrapPurchase') return '';
  const records = receiptRecords(available);
  return [['Hurda alışı',event.meta.purchaseId],['Bağlanan satış',event.meta.saleId]].map(([label,id]) => {
    const source = records.find(entry => entry.id === id);
    return `<p>${label} · ${esc(id)}${source ? ' · '+esc(receiptStatus(source,available)) : ''}</p>`;
  }).join('');
}

function bindSaleReturn(article, original, current) {
  const info=original.returnInfo;
  if(original.type!=='sale'||!info?.eligible||!Array.isArray(original.meta.lines))return;
  const funds=financialAccounts().filter(a=>a.id!=='pos');
  const lines=info.lines.filter(line=>line.remainingQuantity>0);
  article.insertAdjacentHTML('beforeend',`<details><summary>Ürün iadesi kaydet</summary><p class="context-note">Geri gelen ürünü ve müşteriye verdiğiniz karşılığı seçin. Önerilen orantılı bedeli anlaşmanıza göre değiştirebilirsiniz. Para veya ürün iadesi tek başına müşteri cari borcunu kapatmaz. Cari tutarı ayrıca seçin.</p><form id="return-form-${esc(original.id)}" class="sale-return-form">${lines.map(remaining=>{
    const i=remaining.lineIndex,line=original.meta.lines[i],a=account(line.accountId);
    return `<section class="section"><h3>${esc(a.name)}${line.inventoryCode?' · '+esc(line.inventoryCode):''}</h3><p>Kalan iade edilebilir: ${esc(formatted(remaining.remainingQuantity,a.unit))}${line.weightAccount?` · ${esc(formatted(remaining.remainingWeight,'GRAM'))}`:''}</p><div class="form-grid"><label class="field" for="return-q-${esc(original.id)}-${i}"><span>Geri gelen miktar · ${esc(units[a.unit].label)}</span><input id="return-q-${esc(original.id)}-${i}" name="quantity-${i}" data-return-quantity="${i}" inputmode="decimal" value="0" maxlength="24"></label>${line.weightAccount?`<label class="field" for="return-w-${esc(original.id)}-${i}"><span>Geri gelen toplam gram</span><input id="return-w-${esc(original.id)}-${i}" name="weight-${i}" data-return-weight="${i}" inputmode="decimal" value="0" maxlength="24"></label>`:''}<label class="field" for="return-v-${esc(original.id)}-${i}"><span>Anlaşılmış iade bedeli · TL</span><input id="return-v-${esc(original.id)}-${i}" name="value-${i}" data-return-value="${i}" inputmode="decimal" value="0" maxlength="24"></label></div></section>`;
  }).join('')}<div class="form-grid"><label class="field" for="return-fund-${esc(original.id)}"><span>Paranın çıktığı kasa / banka</span><select id="return-fund-${esc(original.id)}" name="refundAccount" data-return-fund>${funds.map(a=>`<option value="${esc(a.id)}">${esc(a.name)} · ${esc(units[a.unit].label)}</option>`).join('')}</select></label><label class="field" for="return-amount-${esc(original.id)}"><span>Gerçek çıkan miktar · <span data-refund-unit>TL</span></span><input id="return-amount-${esc(original.id)}" name="refundQuantity" data-return-refund inputmode="decimal" value="0" maxlength="24" required></label><label class="field" for="return-note-${esc(original.id)}"><span>İade gerekçesi / anlaşma</span><input id="return-note-${esc(original.id)}" name="note" data-return-note required maxlength="160"></label></div><p class="context-note" data-return-total></p><p class="context-note">Farklı birimde ödeme yapılırsa gerçek çıkan miktarı siz girin; Para ile karşılanacak TL tutarı, ürün ve cari karşılıklarından sonra kalandır. Otomatik kur dönüşümü yapılmaz.</p>${action('İade etkilerini gözden geçir','Bu aşamada henüz kayıt yapılmaz.')}</form></details>`);
  const form=article.querySelector('.sale-return-form'),fund=form.querySelector('[data-return-fund]'),refund=form.querySelector('[data-return-refund]');
  if([...fund.options].some(option=>option.value==='nakit'))fund.value='nakit';
  const proportional=(total,part,whole)=>Number((2n*BigInt(total)*BigInt(part)+BigInt(whole))/(2n*BigInt(whole)));
  const total=()=>lines.reduce((sum,r)=>{const q=parseAmount(form.querySelector(`[data-return-quantity="${r.lineIndex}"]`),account(original.meta.lines[r.lineIndex].accountId).unit);const value=parseAmount(form.querySelector(`[data-return-value="${r.lineIndex}"]`));return sum+(q>0&&value!==null?value:0);},0);
  const productFields = original.meta.counterpartyType === 'supplier' ? { value: () => 0, read: () => null } : returnProductFields(form, () => updateRefund());
  const readCustomer = returnCustomerFields(form,original,()=>updateRefund());
  const exchanging = () => Boolean(form.elements.refundProduct?.value && form.elements.returnOperation?.value === 'exchange');
  const updateRefund=()=>{
    const a=account(fund.value), value=total(), cari=readCustomer(), difference=value-productFields.value()-cari.total;
    const incoming=exchanging() && difference<0, remaining=incoming ? -difference : Math.max(difference,0);
    fund.previousElementSibling.textContent=incoming?'Farkın tahsil edildiği kasa / banka':'Paranın çıktığı kasa / banka';
    refund.previousElementSibling.firstChild.textContent=incoming?'Tahsil edilen miktar · ':'Gerçek çıkan miktar · ';
    form.querySelector('[data-refund-unit]').textContent=units[a.unit].label;
    if(a.unit==='TL')refund.value=raw(remaining,'TL');
    parseAmount(refund,a.unit);
    form.querySelector('[data-return-total]').textContent='Anlaşılmış iade bedeli: '+formatted(value)+(cari.rows.length?' · Cari ile karşılanacak: '+formatted(cari.total):'')+(productFields.value()||cari.rows.length?(incoming?' · Tahsil edilecek: ':' · Para ile karşılanacak: ')+formatted(remaining):'');
  };
  for(const remaining of lines){
    const i=remaining.lineIndex,line=original.meta.lines[i],q=form.querySelector(`[data-return-quantity="${i}"]`),value=form.querySelector(`[data-return-value="${i}"]`);
    q.addEventListener('input',()=>{const quantity=parseAmount(q,account(line.accountId).unit);if(quantity!==null)value.value=raw(proportional(line.value,quantity,line.quantity),'TL');if(line.weightAccount){const weight=form.querySelector(`[data-return-weight="${i}"]`);weight.value='';weight.required=quantity>0;weight.setCustomValidity('');}updateRefund();});
    if(line.weightAccount){const weight=form.querySelector(`[data-return-weight="${i}"]`);weight.value='';weight.addEventListener('input',()=>parseAmount(weight,'GRAM',true));}
    value.addEventListener('input',updateRefund);
  }
  fund.addEventListener('change',()=>{refund.value='';updateRefund();});
  refund.addEventListener('input',()=>parseAmount(refund,account(fund.value).unit));
  form.addEventListener('input',()=>{delete form.dataset.reviewedReturn;form.querySelector('[data-return-review]')?.remove();});
  form.addEventListener('change',()=>{delete form.dataset.reviewedReturn;form.querySelector('[data-return-review]')?.remove();});
  form.addEventListener('submit',event=>{
    event.preventDefault();if(!current()||busy||pending||form.dataset.draftStale==='true')return;
    const items=[];
    for(const remaining of lines){
      const i=remaining.lineIndex,line=original.meta.lines[i],q=form.querySelector(`[data-return-quantity="${i}"]`),quantity=parseAmount(q,account(line.accountId).unit);
      if(quantity===null||quantity>remaining.remainingQuantity){q.setCustomValidity('Kalan iade edilebilir miktarı aşmayan geçerli miktar girin.');q.reportValidity();return;}
      if(!quantity)continue;
      if(line.weightAccount){
        const weight=form.querySelector(`[data-return-weight="${i}"]`),measured=parseAmount(weight,'GRAM',true);
        if(measured===null||measured>remaining.remainingWeight||(quantity===remaining.remainingQuantity&&measured!==remaining.remainingWeight)||(quantity<remaining.remainingQuantity&&measured>=remaining.remainingWeight)){weight.setCustomValidity('Gerçek tartımı girin; kalan adet ve gram birlikte tutarlı olmalıdır.');weight.reportValidity();return;}
      }
      const value=form.querySelector(`[data-return-value="${i}"]`);if(parseAmount(value)===null){value.reportValidity();return;}
      items.push({lineIndex:i,quantity:q.value,value:value.value,...(line.weightAccount?{weight:form.querySelector(`[data-return-weight="${i}"]`).value}:{})});
    }
    if(!items.length){inform('En az bir geri gelen ürün miktarı girin.',true);return;}
    const cari=readCustomer();
    if(cari.rows.length && cari.total>total()-productFields.value()){inform('Cari karşılık, iade bedelinin üründen sonra kalan kısmını aşıyor.',true);return;}
    const a=account(fund.value),sum=total(),product=productFields.read(),difference=sum-productFields.value()-cari.total,remaining=exchanging()?Math.abs(difference):difference,amount=parseAmount(refund,a.unit);
    if(!Number.isSafeInteger(sum)||remaining<0||amount===null||(remaining>0&&amount<=0)||(remaining===0&&amount!==0)||(a.unit==='TL'&&amount!==remaining)){refund.setCustomValidity('Gerçek çıkan miktar ile anlaşılmış iade bedelini kontrol edin.');refund.reportValidity();return;}
    if(!form.reportValidity())return;
    const money=remaining?[{accountId:a.id,quantity:refund.value,valueTL:raw(remaining,'TL')}]:[];
    const note=form.querySelector('[data-return-note]').value;
    const command=exchanging()?{type:'retailExchange',originalId:original.id,returnItems:items,newItems:[{accountId:product.accountId,quantity:product.quantity,value:product.valueTL,...(product.inventoryCode&&{inventoryCode:product.inventoryCode}),...(product.weightAccount&&{weightAccount:product.weightAccount,weight:product.weight})}],received:difference<0?money:[],refunds:difference>0?money:[],...(cari.rows.length&&{customerConsideration:cari.rows}),note}
      :{type:'saleReturn',originalId:original.id,items,...(cari.rows.length ? {outgoing:[...(product?[product]:[]),...money],customerConsideration:cari.rows} : product?{outgoing:[product,...money]}:{refunds:money}),note};
    const fingerprint=JSON.stringify(command);
    if(form.dataset.reviewedReturn!==fingerprint){
      form.querySelector('[data-return-review]')?.remove();
      form.insertAdjacentHTML('beforeend',`<div data-return-review class="info neutral"><p class="journal-record-context">İade yapılan satış: ${esc(original.id)} · ${esc(day(original.date))}</p><strong>İade bedeli: ${esc(formatted(sum))}</strong><p>Para çıkışı: ${esc(a.name)} · ${esc(formatted(amount,a.unit))}. İş günü: ${esc(state.date)}.</p><p>Eski satış ve cari bakiye silinmez; seçili ürünler stoğa geri girer.</p><button type="button" data-confirm-return class="button">İadeyi onayla</button></div>`);
      const returnedCodes=items.map(item=>original.meta.lines[item.lineIndex].inventoryCode).filter(Boolean);
      if(returnedCodes.length){
        const summary=document.createElement('p');
        summary.textContent='Geri alınan tekil ürün: '+returnedCodes.join(', ');
        form.querySelector('[data-confirm-return]').before(summary);
      }
      if(cari.rows.length){
        const effects=document.createElement('p');
        const a=account(cari.rows[0].accountId);
        effects.textContent=cari.rows.map(row=>(row.action==='reduceDebt'?'Müşteri borcundan düşülecek':'Müşteriye alacak yazılacak')+
          ' · '+a.name+' · '+row.quantity+' '+units[a.unit].label+(a.unit==='TL'?'':' · '+row.valueTL+' TL karşılığı')).join(' / ')+
          ' · Kalan '+(cari.balance>0?'müşteri borcu ':cari.balance<0?'müşteri alacağı ':'bakiye ')+formatted(Math.abs(cari.balance),a.unit);
        if (!amount) form.querySelector('[data-return-review] strong + p').textContent='Para çıkışı yok. İş günü '+state.date;
        form.querySelector('[data-confirm-return]').before(effects);
      }
      if(product){
        const review=form.querySelector('[data-return-review]');
        if(exchanging()){
          review.querySelector('strong').textContent='Ürün değişimi · İade bedeli '+formatted(sum);
          review.querySelector('strong + p').textContent=(difference<0?'Tahsil edilecek: ':difference>0?'Ödenecek: ':'Fark: ')+formatted(amount,a.unit)+(amount?' · '+a.name:'')+' · İş günü '+state.date;
          review.querySelector('[data-confirm-return]').textContent='Değişimi onayla';
        }
        const supplied=account(product.accountId), detail=document.createElement('p');
        detail.textContent='Verilen ürün: '+supplied.name+(product.inventoryCode?' · '+product.inventoryCode:'')+' · '+formatted(parseAmount(form.elements.refundProductQuantity,supplied.unit),supplied.unit)+(product.weightAccount?' · '+account(product.weightAccount).name+' · '+formatted(parseAmount(form.elements.refundProductWeight,'GRAM'),'GRAM'):'')+' · '+formatted(productFields.value());
        form.querySelector('[data-confirm-return]').before(detail);
      }
      form.querySelector('[data-confirm-return]').addEventListener('click',()=>{form.dataset.reviewedReturn=fingerprint;form.requestSubmit();});form.querySelector('[data-confirm-return]').focus();return;
    }
    submit(command,exchanging()?'Değişim ve fiilî fark birlikte kaydedildi.':'İade ve verilen karşılık kaydedildi.',undefined,{key:form.dataset.draftKey});
  });
  updateRefund();
}

function receiptDirections(event, available=[]) {
  const meta=event.meta||{},cari=(credits=[],debts=[])=>[...credits.map(row=>({...row,impact:1})),...debts.map(row=>({...row,impact:-1}))];
  if(['reverse','supplierReverse'].includes(event.type)){
    const original=[...available,...(state.journal||[])].find(item=>item.id===meta.originalId&&!['reverse','supplierReverse'].includes(item.type));
    const entriesKey=(entries,sign=1)=>JSON.stringify(entries.filter(row=>row.delta!==0).map(row=>[row.accountId,row.delta*sign]).sort((a,b)=>a[0].localeCompare(b[0])||a[1]-b[1]));
    const source=original&&Array.isArray(original.entries)&&entriesKey(original.entries,-1)===entriesKey(event.entries||[])?receiptDirections(original):null;
    if(source&&!source.fallback){
      const sums=new Map(),add=(id,delta)=>sums.set(id,(sums.get(id)||0)+delta);
      for(const [rows,sign] of [[source.incoming,1],[source.outgoing,-1]])for(const row of rows){add(row.accountId,row.quantity*sign);if(row.weightAccount)add(row.weightAccount,row.weight*sign);}
      for(const row of source.cari)add(row.accountId,row.quantity*row.impact);
      const actual=new Map();for(const row of original.entries)actual.set(row.accountId,(actual.get(row.accountId)||0)+row.delta);
      if([...new Set([...sums.keys(),...actual.keys()])].every(id=>Number.isSafeInteger(sums.get(id)||0)&&(sums.get(id)||0)===(actual.get(id)||0))){
        const reversed=rows=>rows.map(row=>({...row,role:'İptal · '+row.role}));
        return {incoming:reversed(source.outgoing),outgoing:reversed(source.incoming),cari:source.cari.map(row=>({...row,impact:-row.impact})),note:'İptal kaydının ters etkileri · İlgili kaydın doğrulanan ürün ve karşılıkları ters yönde gösteriliyor. Yeni bir ürün iadesi veya ödeme değildir.'};
      }
    }
    const incoming=[],outgoing=[],accounts=[];
    for(const row of event.entries||[]){const a=account(row.accountId);if(!a||!Number.isSafeInteger(row.delta)||row.delta===0)continue;const line={accountId:row.accountId,quantity:Math.abs(row.delta),role:'Ters kayıt etkisi'};
      if(a.kind==='receivable')accounts.push({...line,impact:row.delta>0?1:-1});else if(a.kind==='asset')(row.delta>0?incoming:outgoing).push(line);
    }
    return {incoming,outgoing,cari:accounts,fallback:true,note:'İptal kaydının ters etkileri · Hesap hareketlerinden gösteriliyor. Yeni bir ürün iadesi veya ödeme değildir. Ürün / karşılık ayrımı, bağlı ağırlık ve anlaşılmış TL bedeli tahmin edilmez.'};
  }
  if(event.type==='saleReturn'&&Array.isArray(meta.lines)&&Array.isArray(meta.refunds))return {
    incoming:meta.lines.map(row=>({...row,valueTL:row.value,role:'İade edilen ürün'})),outgoing:meta.refunds.map(row=>({...row,role:row.kind==='stock'?'İade karşılığı verilen ürün':'İade ödemesi'})),cari:(meta.customerConsideration || []).map(row=>({...row,impact:-1}))
  };
  if(['supplierPurchase','supplierPayment','supplierReturn'].includes(event.type)) {
    const nativeRow=row=>({...row,valueTL:row.referenceTL});
    return {incoming:[...(event.type==='supplierPurchase'?(meta.lines||[]).map(row=>({...nativeRow(row),role:'Alınan ürün'})):[]),...(meta.receivedLines||[]).map(row=>({...nativeRow(row),role:'Alınan karşılık'}))],
      outgoing:[...(event.type==='supplierReturn'?(meta.lines||[]).map(row=>({...nativeRow(row),role:'Firmaya iade edilen ürün'})):[]),...(meta.givenLines||[]).map(row=>({...nativeRow(row),role:'Verilen karşılık'}))],
      cari:cari((meta.creditLines||[]).map(nativeRow),[...(event.type==='supplierPurchase'?meta.chargeLines||[]:[]),...(meta.debtLines||[])].map(nativeRow)),
      note:'Gerçek miktarlar ve elle anlaşılmış cari karşılıklar. Girilmemiş TL referansı sıfır bedel değildir.'};
  }
  if(!['sale','purchase','collection'].includes(event.type)||!Array.isArray(meta.receivedLines)||!Array.isArray(meta.givenLines)
      ||(['sale','purchase'].includes(event.type)&&!Array.isArray(meta.lines)))return null;
  const products=(meta.lines||[]).map(row=>({...row,valueTL:row.value,role:event.type==='sale'?'Satılan ürün':'Alınan ürün'}));
  return {incoming:[...(event.type==='purchase'?products:[]),...meta.receivedLines.map(row=>({...row,role:'Alınan karşılık'}))],
    outgoing:[...(event.type==='sale'?products:[]),...meta.givenLines.map(row=>({...row,role:'Verilen karşılık'}))],cari:cari(meta.creditLines,meta.debtLines)};
}
function directionalTradeReceipt(event, available=[]) {
  const meta=event.meta||{},directions=receiptDirections(event,available);
  if(!directions)return '';
  const {incoming,outgoing,cari}=directions;
  if([...incoming,...outgoing].some(row=>!account(row.accountId)||account(row.accountId).kind!=='asset'))return '';
  const group=(direction,title,rows)=>`<section class="receipt-flow-group" data-receipt-direction="${direction}"><h4>${title}</h4><ul>${rows.map(row=>{
    const a=account(row.accountId);
    return `<li class="receipt-flow-row" data-receipt-account="${esc(a.id)}"><div class="receipt-flow-product"><strong>${esc(a.name)}</strong><small>${esc(row.role)}</small><span>${esc(formatted(row.quantity,a.unit))}${row.weightAccount?` · ${esc(formatted(row.weight,'GRAM'))}<small>${esc(account(row.weightAccount)?.name||row.weightAccount)}</small>`:''}</span></div>${Number.isSafeInteger(row.valueTL)?`<div class="receipt-flow-value"><small>Anlaşılmış TL karşılığı</small><strong>${(Number.isSafeInteger(row.valueTL??row.referenceTL)?esc(formatted(row.valueTL??row.referenceTL)):'Belirtilmemiş')}</strong></div>`:''}</li>`;
  }).join('')||'<li class="receipt-flow-empty">Bu yönde ürün veya ödeme yok.</li>'}</ul></section>`;

  const summary=event.type==='purchase'?`<p class="journal-note receipt-trade-summary">Alış bedeli: ${esc(formatted(meta.purchaseTotal))} · ${meta.source==='supplier'?'Toptancı / bayi':'Müşteriden alış'} · ${meta.source==='supplier'?'İşlemde borçlanmanın anlaşılmış TL referansı':'Kalan borcun TL karşılığı'}: ${esc(formatted(meta.outstanding))}</p>`:'';
  return summary+(directions.note?`<p class="context-note receipt-direction-note">${esc(directions.note)}</p>`:'')+`<div class="receipt-flow">${group('in','Mağazaya girenler',incoming)}${group('out','Mağazadan çıkanlar',outgoing)}</div>${cari.length?`<section class="receipt-cari"><h4>Cari hesap etkisi</h4><p class="context-note">Cari kayıtlar ürün veya para girişi / çıkışı değildir.</p><ul>${cari.map(row=>{const a=account(row.accountId);return `<li><strong>${esc(a?.name||row.accountId)}</strong> · ${row.impact>0?'Alacağımız artar / borcumuz azalır':'Borcumuz artar / alacağımız azalır'}<br>${esc(formatted(row.quantity,a?.unit||'TL'))}${Number.isSafeInteger(row.valueTL)?' · Anlaşılmış TL karşılığı: '+(Number.isSafeInteger(row.valueTL??row.referenceTL)?esc(formatted(row.valueTL??row.referenceTL)):'Belirtilmemiş'):''}</li>`;}).join('')}</ul></section>`:''}${event.type==='collection'?'<p class="context-note">Cari tahsilat / ödeme · satış veya alış geliri değildir.</p>':''}`;
}
function receiptRecords(available=[]) {
  return [...new Map([...(state.journal||[]),...available].map(event=>[event.id,event])).values()];
}
function receiptStatus(event, available=[]) {
  const records=receiptRecords(available);
  if(records.some(item=>item.meta.amendsOriginalId===event.id||(['reverse','supplierReverse'].includes(item.type)&&item.meta.originalId===event.id&&item.meta.amendmentId)))return 'Düzeltilmiş eski kayıt';
  if(records.some(item=>['reverse','supplierReverse'].includes(item.type)&&item.meta.originalId===event.id))return 'İptal edilmiş kayıt';
  if(['reverse','supplierReverse'].includes(event.type))return event.meta.amendmentId?'Düzeltmenin ters kaydı':'İptal / ters kayıt';
  if(event.meta.amendsOriginalId)return 'Düzeltilmiş kayıt';
  if(['saleReturn','supplierReturn'].includes(event.type))return 'Ürün iadesi';
  if(records.some(item=>['saleReturn','supplierReturn'].includes(item.type)&&item.meta.originalId===event.id))return 'Bağlı ürün iadesi bulunan kayıt';
  return 'Aktif kayıt';
}
function receiptRelations(event, available=[]) {
  const links = item => [...(item.meta.allocations||[]).flatMap(row=>[row.sourceId,row.purchaseId]),...(item.meta.sourceUses||[]).map(row=>row.sourceId),...(item.meta.debtUses||[]).map(row=>row.sourceId),...(item.meta.uses||[]).map(row=>row.sourceId),...(["linkScrapPurchase","scrapAdvanceTransfer","scrapAdvanceUndo"].includes(item.type)?[item.meta.purchaseId,item.meta.saleId]:[]),item.meta.originalId,item.meta.amendsOriginalId,item.meta.amendmentId,item.meta.orderId,item.meta.advanceId,...(item.meta.advanceAllocations || []).map(row=>row.advanceId)];
  return [...new Set([...links(event),...receiptRecords(available).filter(item=>links(item).includes(event.id)).map(item=>item.id)].filter(id=>id && id!==event.id))];
}
function receiptRecordMeta(event, available=[]) {
  const timestamp=Number.isFinite(Date.parse(event.timestamp))?new Date(event.timestamp).toLocaleString('tr-TR'):'Kayıt zamanı mevcut değil';
  const totals=event.type==='sale'?[['Satış bedeli',event.meta.revenue]]:event.type==='purchase'?[['Alış bedeli',event.meta.purchaseTotal]]:event.type==='saleReturn'?[['İade bedeli',event.meta.returnTotal]]:event.type==='reverse'?[['Satışa ters etki',event.meta.revenue],['Alışa ters etki',event.meta.purchaseTotal]]:[];
  if (event.meta.advanceAppliedTL) totals.push(['Sipariş avansından mahsup',event.meta.advanceAppliedTL]);
  if (['orderAdvance','orderRefund','scrapAdvanceTransfer','scrapAdvanceUndo'].includes(event.type)) totals.push(['Tutar',event.meta.amountTL]);
  const relations=receiptRelations(event,available);
  return `<div class="receipt-record-meta"><p><strong>${esc(event.label)}</strong> · ${esc(receiptStatus(event,available))}</p><p>Kayıt: ${esc(event.id)}<br>İş günü: ${esc(day(event.date))} · Kayıt zamanı: ${esc(timestamp)}</p>${event.meta.exchangeId?`<p>Değişim: ${esc(event.meta.exchangeId)} · Mahsup edilen ${esc(formatted(event.meta.exchangeAppliedTL))}</p>`:''}${scrapTraceReceipt(event,available)}${totals.filter(([,value])=>Number.isSafeInteger(value)).map(([label,value])=>`<p>${esc(label)}: <strong>${esc(formatted(value))}</strong></p>`).join('')}${event.meta.note?`<p class="receipt-note">Açıklama: ${esc(event.meta.note)}</p>`:''}${relations.length?`<p class="receipt-related">Bağlı kayıtlar: ${relations.map(id=>esc(id)).join(' · ')}</p>`:''}</div>`;
}
function statementReceipt(event, available=[], family=false) {
  if (event.type === 'itemCostSource') return '';
  const meta=event.meta||{};
  const receipt=directionalTradeReceipt(event,available);
  const ledgerEffects=!receipt?`<section class="receipt-ledger-effects"><h4>Hesap hareketleri</h4><ul>${event.entries.filter(row=>row.delta!==0).map(row=>{const a=account(row.accountId);return `<li>${esc(a?.name||row.accountId)}: ${row.delta>0?'+':''}${esc(formatted(row.delta,a?.unit||'TL'))}</li>`;}).join('')||'<li>Hesap bakiyesi değişmedi.</li>'}</ul></section>`:'';
  const products=(meta.lines||[]).map(row=>{const a=account(row.accountId);return `<li><strong>${esc(a?.name||row.accountId)}</strong> · ${esc(formatted(row.quantity,a?.unit||'TL'))}${row.weightAccount?' · '+esc(account(row.weightAccount)?.name||row.weightAccount)+' · '+esc(formatted(row.weight,'GRAM')):''}${Number.isSafeInteger(row.value)?' · '+esc(formatted(row.value)):''}</li>`;}).join('');
  return `<details class="statement-receipt"><summary>${family?'İşlem fişi':'İşlem fişini aç'}</summary>${receiptRecordMeta(event,available)}${meta.counterpartyId?`<p>İşlem yapılan hesap: ${esc(account(meta.counterpartyId)?.name||meta.counterpartyId)}</p>`:''}${receipt||`${products?`<h4>${event.type==='purchase'?'Alınan ürünler':event.type==='saleReturn'?'İade edilen ürünler':'İşlem ürünleri'}</h4><ul>${products}</ul>`:''}${journalFinancialMeta(event)}`}${ledgerEffects}<p class="context-note">Hesaba etki, bu ekstrenin hesabına aittir; fiş bütün işlemin ürün ve karşılıklarını gösterir. ${family?'Bu bölüm yalnız belirtilen birimin bakiyesini gösterir.':'Bağlı kayıtlar ve işlemler için “Tüm hareketleri aç”ı kullanın.'}</p></details>`;
}
function journalFinancialMeta(event) {
  const meta = event.meta;
  const header = event.type === 'purchase' ? `<p class="journal-note">Alış bedeli: ${esc(formatted(meta.purchaseTotal))} · ${meta.source === 'supplier' ? 'Toptancı / bayi' : 'Müşteriden alış'} · ${meta.source==='supplier'?'İşlemde borçlanmanın anlaşılmış TL referansı':'Kalan borcun TL karşılığı'}: ${esc(formatted(meta.outstanding))}</p>` : '';
  const mixed=Array.isArray(meta.receivedLines)||Array.isArray(meta.givenLines);
  const assets=mixed?[...(meta.receivedLines||[]).map(row=>({...row,kind:'Alınan karşılık'})),...(meta.givenLines||[]).map(row=>({...row,kind:'Verilen karşılık'}))]:[...(meta.scrapLines||[]).map(row=>({...row,kind:'Hurda karşılığı'})),...(meta.paymentLines||[]).map(row=>({...row,kind:'Ödeme'}))];
  const lines=[...assets,...(meta.debtLines||[]).map(row=>({...row,kind:'Cari borcumuz (+) / alacağımız (−)'})),...(meta.creditLines||[]).map(row=>({...row,kind:'Cari alacağımız (+) / borcumuz (−)'}))];
  return header + (mixed&&event.type==='collection'?'<p class="context-note">Cari tahsilat / ödeme · satış veya alış geliri değildir.</p>':'') + (lines.length ? `<div class="table-wrap"><table><thead><tr><th>Karşılık türü / hesap</th><th class="numeric">Özgün miktar / ağırlık</th><th class="numeric">Anlaşılmış TL karşılığı</th></tr></thead><tbody>${lines.map(row=>{const a=account(row.accountId);return `<tr><td>${esc(row.kind)} · ${esc(a.name)}</td><td class="numeric">${esc(formatted(row.quantity,a.unit))}${row.weightAccount?`<br><small>${esc(account(row.weightAccount).name)} · ${esc(formatted(row.weight,'GRAM'))}</small>`:''}</td><td class="numeric">${(Number.isSafeInteger(row.valueTL??row.referenceTL)?esc(formatted(row.valueTL??row.referenceTL)):'Belirtilmemiş')}</td></tr>`;}).join('')}</tbody></table></div>` : '');
}
function journalItemMarkup(e,reversed,available=[]){
  const cancelled=reversed.has(e.id),supplierRecord=e.type.startsWith('supplier')||e.meta.source==='supplier'||e.entries.some(row=>account(row.accountId)?.partyType==='supplier'),editable=e.editableCommand&&!cancelled&&!e.meta.exchangeId&&!supplierRecord;
  const receipt=directionalTradeReceipt(e,available);
  const amount=e.meta.total||e.meta.purchaseTotal||e.meta.revenue;
  return `<article class="journal-item"${e.type === 'itemCostSource' ? ' data-private-item-cost' : ''}><div class="journal-head"><div><strong>${esc(e.label)}</strong><small>${esc(day(e.date))} · ${esc(new Date(e.timestamp).toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit'}))}</small></div><span class="badge${cancelled?' gold':''}">${cancelled?'İptal / düzeltme işlendi':e.meta.amendsOriginalId?'Düzenlenmiş kayıt':e.type==='reverse'?'İptal kaydı':amount?esc(formatted(amount)):'Kayıtlı'}</span></div>${e.meta.counterpartyId?`<p class="journal-summary">${esc(account(e.meta.counterpartyId)?.name||'')}</p>`:''}${e.meta.note?`<p class="journal-note">${esc(e.meta.note)}</p>`:''}${e.meta.lines?.length?`<p class="journal-summary">${e.meta.lines.map(line=>esc(account(line.accountId).name)+' · '+esc(formatted(line.quantity,account(line.accountId).unit))).join(' / ')}</p>`:''}<details class="journal-detail"><summary>Ürün, ödeme ve hesap ayrıntıları</summary>${receiptRecordMeta(e,available)}${receipt||`${e.meta.lines?.length?`<div class="table-wrap"><table><thead><tr><th>Ürün</th><th class="numeric">Miktar</th><th>Ayar / ağırlık</th><th class="numeric">Tutar</th></tr></thead><tbody>${e.meta.lines.map(line=>`<tr><td>${esc(account(line.accountId).name)}</td><td class="numeric">${esc(formatted(line.quantity,account(line.accountId).unit))}</td><td>${line.weightAccount?esc(account(line.weightAccount).name)+' · '+esc(formatted(line.weight,'GRAM')):'—'}</td><td class="numeric">${line.value?esc(formatted(line.value)):'—'}</td></tr>`).join('')}</tbody></table></div>`:''}${journalFinancialMeta(e)}`}${salePricingDetails(e)}${e.type === 'itemCostSource' ? itemCostAudit(e.meta) : ''}${e.actor ? `<p class="journal-summary">İşlemi kaydeden · ${esc(e.actor.name)} (${esc(e.actor.id)})</p>` : '<p class="journal-summary">Eski kayıt · Doğrulanmış işlem sahibi yok</p>'}<details class="receipt-account-effects"><summary>Hesap hareketlerini göster</summary><div class="journal-lines">${e.entries.map(row=>{const a=account(row.accountId);return `<div class="journal-line"><span>${esc(a.name)}</span><strong class="${row.delta<0?'negative':'positive'}">${row.delta>0?'+':''}${esc(formatted(row.delta,a.unit))}</strong></div>`;}).join('')}</div></details><small>Kayıt: ${esc(e.id)}${e.meta.originalId?' · İlgili kayıt: '+esc(e.meta.originalId):''}</small></details>${editable?'<div class="journal-actions"><button type="button" class="button secondary compact" data-edit-transaction>İşlemi düzenle</button></div>':''}${['sale','purchase','stock','movement','collection','transfer','settlement'].includes(e.type)&&!cancelled&&!e.meta.orderId?`<details class="operation-more"><summary>İşlemi tamamen iptal et</summary><p class="context-note">Yanlış veya tamamen geri alınan işlem için kullanın. Stok, ödeme ve cari etkilerinin tamamı geri alınır. Kısmi ürün dönüşünde Ürün İadesi seçin.</p><form class="reverse-form" data-original="${esc(e.id)}"><label class="field"><span>İptal gerekçesi</span><input name="note" required maxlength="160" aria-label="${esc(e.label)} iptal gerekçesi"></label><button class="button danger compact" type="submit">İptal etkilerini göster</button></form></details>`:''}</article>`;
}

function beginTransactionEdit(original){
  if(busy||pending)return;
  captureDrafts();editingTransaction={original,workspace,revision:state.revision,date:state.date};setView('edit');
}
function renderEditPage(){
  if(!editingTransaction||editingTransaction.workspace!==workspace){editingTransaction=null;view='journal';renderJournal();return;}
  const original=editingTransaction.original;
  $('#main').innerHTML=heading('İşlemi Düzenle',`${day(original.date)} · ${original.label}. Değişiklikler açık iş gününe bağlı düzeltme olarak kaydedilir.`,'<button type="button" class="button secondary" id="cancel-edit">Günlük İşlemlere dön</button>')+'<section class="section"><p class="info neutral">Eski kayıt korunur. Eski etkiler geri alınır ve yeni bilgiler tek işlemde uygulanır. Kaydetmeden önce ürün, ödeme ve cari tutarlarını kontrol edin.</p><div id="edit-operation"></div></section>';
  $('#edit-operation').insertAdjacentHTML('beforebegin',`<p class="edit-record-context">Düzenlenen kayıt: ${esc(original.id)} · ${esc(day(original.date))} · ${esc(original.label)}</p>`);
  $('#cancel-edit').addEventListener('click',()=>{captureDrafts();setView('journal');});
  renderTransactionEditor($('#edit-operation'),original);
  const editHeading=$('#edit-operation h2');if(editHeading)editHeading.textContent=original.label+' · düzeltme';
  const form=$('#edit-operation form');if(!form)return;
  form.insertAdjacentHTML('afterbegin','<label class="field"><span>Düzenleme gerekçesi</span><input id="amend-reason" name="amendReason" required maxlength="160" placeholder="Örneğin: ürün ağırlığı yanlış girilmiş"></label>');
  form.querySelector('button[type="submit"]').textContent='Düzenlemeyi kaydet';
  if(editingTransaction.revision!==state.revision||editingTransaction.date!==state.date){form.querySelector('button[type="submit"]').disabled=true;form.insertAdjacentHTML('afterbegin','<p class="notice error">Düzenleme açıldıktan sonra defter değişti. Günlük İşlemlere dönüp işlemi yeniden açın.</p>');}
}

function countApprover(record) {
  return esc(record.approvedBy) + (record.approvedById ? ' · Doğrulanmış kullanıcı' : ' · Eski kayıtta yazılan ad');
}

function renderJournal() {
  const compact = state.view === 'compact', selectedWorkspace = workspace, expectedRevision = state.revision;
  const totals = compact ? state.journalMeta : { total: state.journal.length, totalEntries: state.journal.reduce((sum,event)=>sum+event.entries.length,0) };
  const types = [['sale','Satış'],['purchase','Alış'],['collection','Cari Tahsilat / Ödeme'],['money','Para / Banka / POS'],['inventory','Stok / Tartım'],['reverse','İptal / Düzeltme'],['setup','Açılış / Kartlar / Kapanış']];
  $('#main').innerHTML = heading('Günlük İşlemler', 'İşlemleri bulun, ayrıntılarını açın ve gerektiğinde düzenleyin. Ürün iadesi gerçek geri dönüşü; iptal, işlemin tamamını geri almayı kaydeder.') + '<section class="section"><div class="section-header"><div><h2>Kayıtlar</h2><p class="muted">' + totals.total + ' olay · ' + totals.totalEntries + ' bağlı hareket</p></div></div><div class="journal-filters"><label class="field" for="journal-scope"><span>Dönem</span><select id="journal-scope"><option value="today">Açık iş günü</option><option value="all">Bütün geçmiş</option></select></label><label class="field" for="journal-search"><span>Kayıtlarda ara</span><input id="journal-search" type="search" maxlength="160" autocomplete="off" placeholder="Açıklama, hesap adı veya kayıt" aria-describedby="journal-search-hint"><small id="journal-search-hint">Seçili dönemde açıklama, hesap ve kayıt bilgilerini arar.</small></label><label class="field" for="journal-type"><span>İşlem türü</span><select id="journal-type"><option value="all">Bütün işlem türleri</option>' + types.map(([value,label]) => '<option value="'+value+'">'+label+'</option>').join('') + '</select></label><button class="button secondary compact" type="button" id="journal-clear">Filtreleri temizle</button></div><p id="journal-results-count" class="context-note" role="status" aria-live="polite" aria-atomic="true"></p><div id="journal-list"></div><button id="journal-next" type="button" class="button secondary compact" hidden>Sonraki kayıtları göster</button></section>';
  const search = $('#journal-search'), type = $('#journal-type'), scope = $('#journal-scope'), list = $('#journal-list'), notice = $('#journal-results-count'), next = $('#journal-next');
  type.insertAdjacentHTML('beforeend','<option value="saleReturn">Ürün iadesi</option>');
  $('#journal-clear').insertAdjacentHTML('beforebegin', '<label class="field" for="journal-start"><span>Başlangıç tarihi</span><input id="journal-start" type="date"></label><label class="field" for="journal-end"><span>Bitiş tarihi</span><input id="journal-end" type="date"></label><label class="field" for="journal-account"><span>Hesap</span><select id="journal-account"><option value="">Bütün hesaplar</option>' + state.accounts.map(a=>`<option value="${esc(a.id)}">${esc(a.name)} · ${esc(units[a.unit].label)}${a.retired?' · eski hesap':''}</option>`).join('') + '</select></label>');
  const start = $('#journal-start'), end = $('#journal-end'), selectedAccount = $('#journal-account');
  const filterShell=$('.journal-filters'),primaryFilters=document.createElement('div'),secondaryFilters=document.createElement('div');
  primaryFilters.className='journal-filters-primary';secondaryFilters.className='journal-filters-secondary';
  for(const control of [scope,search])primaryFilters.append(control.closest('label'));
  for(const control of [type,start,end,selectedAccount])secondaryFilters.append(control.closest('label'));
  secondaryFilters.append($('#journal-clear'));filterShell.append(primaryFilters,secondaryFilters);
  filterShell.insertAdjacentHTML('afterend','<p id="journal-active-filters" class="context-note" role="status" aria-live="polite"></p>');
  const readFilters = () => ({scope:scope.value,q:search.value.trim(),type:type.value,startDate:start.value,endDate:end.value,accountId:selectedAccount.value});
  const savedFilters = journalFilterMemory.get(workspace);
  if (savedFilters) { scope.value=savedFilters.scope;search.value=savedFilters.q;type.value=savedFilters.type;start.value=savedFilters.startDate||'';end.value=savedFilters.endDate||'';selectedAccount.value=savedFilters.accountId||''; }
  const normalizeSearch = value => value.toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/ı/g,'i');
  const searchable = event => normalizeSearch([event.label,event.date,event.id,event.meta.note,event.meta.productCategory,account(event.meta.counterpartyId)?.name,...event.entries.map(row => account(row.accountId).name)].filter(Boolean).join(' '));
  const current = () => list.isConnected && view === 'journal' && workspace === selectedWorkspace && state.revision === expectedRevision;
  const updateClear = () => {
    $('#journal-clear').disabled = !search.value.trim() && type.value === 'all' && !start.value && !end.value && !selectedAccount.value;
    const labels=[scope.selectedOptions[0].textContent];if(search.value.trim())labels.push('Arama: '+search.value.trim());if(type.value!=='all')labels.push(type.selectedOptions[0].textContent);if(start.value)labels.push('Başlangıç: '+day(start.value));if(end.value)labels.push('Bitiş: '+day(end.value));if(selectedAccount.value)labels.push(selectedAccount.selectedOptions[0].textContent);
    $('#journal-active-filters').textContent='Görüntülenen kapsam: '+labels.join(' · ');
  };
  const clear = () => { search.value='';type.value='all';start.value='';end.value='';selectedAccount.value='';update();search.focus({preventScroll:true}); };
  const display = (items,reversed,context=[]) => {
    const filtered = search.value.trim() || type.value !== 'all' || start.value || end.value || selectedAccount.value;
    list.innerHTML = items.length ? items.map(event=>journalItemMarkup(event,reversed,[...context,...items])).join('') : filtered ? '<div class="empty"><strong class="empty-state-title">Eşleşen kayıt bulunamadı</strong><p>Aramayı değiştirin veya işlem türü filtresini temizleyin.</p><button type="button" id="journal-empty-clear" class="button secondary compact">Filtreleri temizle</button></div>' : '<div class="empty"><strong class="empty-state-title">Bu dönemde kayıt yok</strong><p>Önceki gün kayıtları için “Bütün geçmiş” seçin.</p></div>';
    list.querySelector('#journal-empty-clear')?.addEventListener('click',clear);
    list.querySelectorAll('.journal-item').forEach((article,index)=>{bindSaleReturn(article,items[index],current);bindPriorScrapLink(article,items[index],reversed,current);article.querySelector('[data-edit-transaction]')?.addEventListener('click',()=>{if(current())beginTransactionEdit(items[index]);});});
    list.querySelectorAll('.journal-item').forEach((article,index)=>{
      const event=items[index];
      if (event.type === 'linkScrapPurchase' && !reversed.has(event.id)) {
        article.insertAdjacentHTML('beforeend','<details><summary>Hurda alış bağlantısını iptal et</summary><form data-unlink-scrap><label class="field"><span>Bağlantı iptal gerekçesi</span><input name="note" required maxlength="160"></label><p class="context-note">Alış ve satış kayıtları ile bakiyeler korunur.</p><button type="submit" class="button secondary compact">Bağlantı iptalini kaydet</button></form></details>');
        const form = article.querySelector('[data-unlink-scrap]');
        form.addEventListener('submit', e => {
          e.preventDefault();
          if (current() && form.reportValidity()) submit({type:'reverse',originalId:event.id,note:form.elements.note.value},'Hurda alış bağlantısı iptal edildi.');
        });
      }
      if(event.type==='saleReturn'&&!event.meta.exchangeId&&!reversed.has(event.id))article.insertAdjacentHTML('beforeend',`<details><summary>İade kaydını iptal et</summary><p class="context-note">Yanlış iadenin stok ve ödeme etkileri geri alınır. Asıl satış korunur; ardından doğru bilgilerle yeniden iade kaydedebilirsiniz.</p><form class="reverse-form" data-original="${esc(event.id)}"><label class="field"><span>Gerekçe<input name="note" required maxlength="160"></span></label><button class="button danger compact" type="submit">İade düzeltmesini gözden geçir</button></form></details>`);
    });
    // D07: presentation only. Existing forms, guards and submit handlers stay intact.
    list.querySelectorAll('.journal-item').forEach((article,index)=>{
      const event=items[index];
      if(event.meta.supplierId){
        const button=document.createElement('button');button.type='button';button.className='button secondary compact';button.textContent='Firma hareketlerini aç';button.dataset.supplierHistory=event.meta.supplierId;
        button.addEventListener('click',()=>{supplierMemory.set('supplier:view:'+workspace,{partyId:event.meta.supplierId,kind:'history'});setView('suppliers');});article.append(button);
      }
      article.querySelector('.journal-head').insertAdjacentHTML('afterend',`<p class="journal-record-context">Kayıt: ${esc(event.id)}${event.meta.originalId?` · İlgili kayıt: ${esc(event.meta.originalId)}`:''}</p>`);
      const edit=article.querySelector('.journal-actions'),returns=article.querySelector('.sale-return-form')?.closest('details');
      const reverse=article.querySelector('.reverse-form')?.closest('details');
      if(reverse && event.meta.exchangeId) reverse.querySelector('summary').textContent='Değişimin iki kaydını geri al';
      if(edit){edit.insertAdjacentHTML('beforeend','<p>Eski etkiler geri alınır; yeni bilgiler tek düzeltme işleminde uygulanır.</p>');}
      if(returns){returns.classList.add('journal-action-return');returns.querySelector('summary').insertAdjacentHTML('beforeend','<small>Geri gelen ürünleri ve müşteriye verilen karşılığı gösterir.</small>');article.append(returns);}
      if(reverse){reverse.classList.add('journal-action-reverse');reverse.querySelector('summary').insertAdjacentHTML('beforeend',`<small>${event.type==='saleReturn'?'Yalnız bu iadenin stok ve ödeme etkileri geri alınır; asıl satış korunur.':'Bu kaydın stok, ödeme ve cari etkilerinin tamamı ters uygulanır.'}</small>`);if(event.type==='sale')reverse.querySelector('summary').insertAdjacentHTML('afterend','<p class="context-note">Aktif ürün iadesi bulunan satışın tam iptali yapılamaz. Önce bağlı iadeleri kontrol edin.</p>');article.append(reverse);}
    });
    enhanceTables(list); connectFieldHints(list); prepareDraftForms();
    list.querySelectorAll('.reverse-form').forEach(form=>{
      form.addEventListener('input',()=>{delete form.dataset.reviewedNote;form.querySelector('[data-reverse-review]')?.remove();});
      form.addEventListener('submit',event=>{
        event.preventDefault();if(!current()||busy||!form.reportValidity())return;
        const note=formValues(form).note,original=items.find(e=>e.id===form.dataset.original);
        if(!original)return;
        let effects = original.entries, itemEffects = original.meta.inventoryChanges || [];
        if (original.meta.exchangeId) {
          const returned = [...items,...context].find(row => row.id === original.meta.exchangeId + ':return');
          if (!returned) { inform('Bağlı iade kaydı yüklenemedi. Defteri yenileyin.', true); return; }
          effects = [...original.entries,...returned.entries];
          itemEffects = [...itemEffects,...(returned.meta.inventoryChanges || [])];
        }
        if(form.dataset.reviewedNote!==note){
          form.querySelector('[data-reverse-review]')?.remove();
          form.insertAdjacentHTML('beforeend',`<div data-reverse-review class="info neutral"><p class="journal-record-context">Ters çevrilen kayıt: ${esc(original.id)} · ${esc(original.label)} · ${esc(day(original.date))}</p><strong>Uygulanacak açık iş günü: ${esc(state.date)}</strong><p>Eski kayıt silinmez. Aşağıdaki bağlı etkilerin tamamı uygulanır</p>${itemEffects.map(item=>`<p>${esc(item.code)} · ${esc(({available:'Stoğa döner',sold:'Satılmış durumuna döner',issued:'İadede verilmiş durumuna döner'})[item.before] || item.before)}</p>`).join('')}${effects.map(row=>`<div>${esc(account(row.accountId).name)}: ${esc(formatted(-row.delta,account(row.accountId).unit))}</div>`).join('')}<button class="button danger" type="button" data-confirm-reverse>Etkileri kontrol ettim, ters kaydı onayla</button></div>`);
          form.querySelector('[data-confirm-reverse]').addEventListener('click',()=>{form.dataset.reviewedNote=note;form.requestSubmit();});
          form.querySelector('[data-confirm-reverse]').focus();return;
        }
        submit({type:original.meta.exchangeId?'undoExchange':'reverse',originalId:form.dataset.original,note},'Olayın bütün bağlı hareketleri açık güne ters kaydedildi.');
      });
    });
  };
  const drawLocal = () => {
    const query=normalizeSearch(search.value.trim()),period=state.journal.filter(event=>(scope.value==='all'||event.date===state.date)&&(!start.value||event.date>=start.value)&&(!end.value||event.date<=end.value)&&(!selectedAccount.value||event.meta.counterpartyId===selectedAccount.value||event.entries.some(row=>row.accountId===selectedAccount.value)));
    const items=period.filter(event=>(type.value==='all'||event.type===type.value||({money:['movement','transfer','settlement'],inventory:['stock','stocktake','registerItem','releaseItem','itemCostSource'],setup:['opening','nominalOpening','account','accountUpdate','fundAccount','stockAccount','stockUpdate','close']}[type.value]||[]).includes(event.type))&&(!query||searchable(event).includes(query))).slice().reverse();
    display(items,new Set(state.journal.filter(event=>event.type==='reverse').map(event=>event.meta.originalId)));
    notice.textContent=items.length+' kayıt gösteriliyor · seçili dönemde '+period.length+' kayıt';updateClear();
  };
  let sequence=0,items=[],reversed=new Set(),nextCursor=null,pageFilters=null,receiptContext=new Map();
  const loadPage = async (append=false) => {
    const ticket=++sequence;
    const filters=append?pageFilters:{...readFilters(),limit:'25'};
    const cursor=append?nextCursor:null;if(append&&!cursor)return;
    if(!append){items=[];reversed=new Set();receiptContext=new Map();nextCursor=null;pageFilters=filters;next.hidden=true;list.innerHTML='<div class="loading" role="status">Kayıtlar yükleniyor…</div>';}
    list.setAttribute('aria-busy','true');notice.setAttribute('role','status');notice.textContent='Hareket defteri hazırlanıyor…';next.disabled=true;updateClear();
    try {
      if(filters.startDate && filters.endDate && filters.startDate>filters.endDate)throw new Error('Başlangıç tarihi bitiş tarihinden sonra olamaz.');
      const page=await request('journal',undefined,selectedWorkspace,{query:{...filters,...(cursor?{cursor}:{})}});
      if(ticket!==sequence||!current())return;
      if(page.revision!==expectedRevision)throw Object.assign(new Error('Kayıtlar değişti. Defteri yenileyerek listeyi yeniden açın.'),{status:409});
      if(!Array.isArray(page.items)||!Array.isArray(page.reversedIds)||!Number.isSafeInteger(page.total)||page.total<0||!Number.isSafeInteger(page.totalEntries)||page.totalEntries<0||(page.nextCursor!==null&&typeof page.nextCursor!=='string'))throw new Error('Defter sayfası doğrulanamadı.');
      items=[...new Map([...(append?items:[]),...page.items].map(event=>[event.id,event])).values()];
      for(const id of page.reversedIds)reversed.add(id);
      for(const event of page.receiptContext||[])receiptContext.set(event.id,event);
      nextCursor=page.nextCursor;display(items,reversed,[...receiptContext.values()]);next.hidden=!nextCursor;
      notice.textContent=items.length+' kayıt gösteriliyor · '+page.total+' eşleşen kayıt · '+page.totalEntries+' bağlı hareket';
    } catch(error) {
      if(ticket!==sequence||!current())return;
      items=[];reversed.clear();nextCursor=null;next.hidden=true;
      notice.setAttribute('role','alert');notice.textContent=error.status===409?'Kayıtlar değişti. Defteri yenileyerek listeyi yeniden açın.':'Hareket defteri alınamadı: '+error.message;
      list.innerHTML='<div class="empty"><strong class="empty-state-title">Liste yeniden yüklenmeli</strong><p>'+esc(error.message)+'</p><button id="journal-retry" type="button" class="button secondary compact">'+(error.status===409?'Defteri yenile':'Listeyi yeniden dene')+'</button></div>';
      list.querySelector('#journal-retry').addEventListener('click',()=>error.status===409?refresh():loadPage());
    } finally { if(ticket===sequence&&current()){list.setAttribute('aria-busy','false');next.disabled=false;} }
  };
  const update = () => { captureDrafts();journalFilterMemory.set(workspace,readFilters()); return compact ? loadPage() : drawLocal(); };
  start.addEventListener('change',update);end.addEventListener('change',update);selectedAccount.addEventListener('change',update);
  scope.addEventListener('change',update);search.addEventListener('input',update);type.addEventListener('change',update);$('#journal-clear').addEventListener('click',clear);next.addEventListener('click',()=>loadPage(true));update();
}
function restoreFormMarkup() {
  const target = workspace === 'demo' ? 'Örnek defter' : 'Dükkân defteri';
  return `<p class="info neutral" id="restore-warning"><strong>Hedef alan: ${target}.</strong> Bu alanın aktif geçmişi yedekteki geçmişle değiştirilir. İşlem tamamlanırsa önceki geçmiş sunucudaki arşivde korunur. Yedeğin bu alana ait olduğunu kontrol edin. Geri yükleme tamamlandığında açık kullanıcı oturumları kapanır.</p><form id="restore-form" aria-describedby="restore-warning"><div class="form-grid">${field('backupFile','Yedek dosyası · JSON veya akışlı arşiv',{type:'file',full:true,hint:'JSON: en fazla 64 MiB. Akışlı .ndjson arşivi: en fazla 512 MiB ve 250.000 olay. Yalnız seçili çalışma alanına ait yedek kullanılabilir.'})}${field('confirmation','Onay için GERİ YÜKLE yazın',{full:true,hint:'Yedek dosyasını ve hedef alanı kontrol ettikten sonra onaylayın.'})}</div>${action('Seçili alana geri yükle',`Hedef alan: ${target}`)}</form>`;
}
function bindRestoreForm({ revision, selectedWorkspace = workspace, recovery = false }) {
  const form = $('#restore-form'), generation = ++recoveryGeneration;
  const current = () => workspace === selectedWorkspace && generation === recoveryGeneration && form.isConnected;
  const invalidate = (uncertain, completed = false) => {
    const panel = form.closest('#restore-panel'); ++recoveryGeneration;
    const explanation = completed ? 'Arşiv geri yüklendi; ancak ekran yenilenemedi. Geri yüklemeyi tekrar yapmayın. Defteri yeniden yükleyerek güncel görünümü kontrol edin.' : uncertain ? 'Geri yüklemenin sonucu belirsiz. Önce defteri yeniden yükleyerek mevcut durumu kontrol edin; işlem otomatik tekrarlanmayacak.' : 'Kayıtlar değişti. Kurtarma bilgilerini yeniden kontrol edin; dosyayı tekrar seçip yeniden onaylayın.';
    panel.innerHTML = `<div class="info neutral"><p>${explanation}</p><div class="recovery-actions"><button type="button" id="restore-state-refresh" class="button">Defteri yeniden yükle</button>${recovery && !completed ? '<button type="button" id="recovery-recheck" class="button secondary">Kurtarma bilgilerini yeniden kontrol et</button>' : ''}</div></div>`;
    $('#restore-state-refresh').addEventListener('click', () => refresh());
    $('#recovery-recheck')?.addEventListener('click', openRecovery);
  };
  $('#f-backupFile').accept = '.json,.ndjson,application/json,application/x-ndjson'; form.querySelector('button[type="submit"]').classList.add('danger');
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !current()) return;
    if (pending) { inform('Önce sonucu belirsiz son isteği doğrulayın.', true); return; }
    captureDrafts();
    if (drafts.size) { inform('Geri yüklemeden önce açık işlem taslaklarını temizleyin.', true); return; }
    const file = form.querySelector('#f-backupFile').files[0], confirmation = form.querySelector('#f-confirmation').value;
    const streamed = typeof file?.name === 'string' && /\.ndjson$/i.test(file.name);
    const fileLimit = (streamed ? 512 : 64) * 1024 * 1024;
    if (!file || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > fileLimit) { inform(streamed ? 'En fazla 512 MiB boyutunda bir akışlı arşiv seçin.' : 'En fazla 64 MiB boyutunda bir JSON yedeği seçin. Büyük defterler için .ndjson akışlı arşiv kullanın.', true); return; }
    if (confirmation !== 'GERİ YÜKLE') { inform('Onay alanına tam olarak GERİ YÜKLE yazın.', true); return; }
    let sent = false, acknowledged = false; const previousFocus = document.activeElement; setBusy(true);
    try {
      let result;
      if (streamed) {
        sent = true;
        const receipt = await request('archive/restore', file, selectedWorkspace, { raw: true, query: { revision: String(revision), confirmation } });
        if (!current()) return;
        if (!receipt || receipt.workspace !== selectedWorkspace || receipt.revision !== revision + 1 || !Number.isSafeInteger(receipt.restoredEvents) || receipt.restoredEvents < 0 || !Number.isSafeInteger(receipt.archiveId) || receipt.archiveId < 1) throw new Error('Arşiv geri yükleme sonucu doğrulanamadı.');
        acknowledged = true;
        if (receipt.reauthenticate === true) { window.DefterSession.finishRestore(); return; }
        result = { state: await request('state', undefined, selectedWorkspace) };
      } else {
        const backup = JSON.parse(await file.text());
        if (!current()) return;
        if (pending) { inform('Önce sonucu belirsiz son isteği doğrulayın.', true); return; }
        if (!backup || typeof backup !== 'object' || Array.isArray(backup) || backup.workspace !== selectedWorkspace) throw new Error('Yedek dosyası seçili çalışma alanına ait olmalı.');
        sent = true;
        result = await request('restore', { backup, revision, confirmation }, selectedWorkspace);
      }
      if (!current()) return;
      if (!result?.state || typeof result.state !== 'object') throw new Error('Geri yükleme sonucu doğrulanamadı.');
      if (result.reauthenticate === true) { window.DefterSession.finishRestore(); return; }
      clearWorkspaceDrafts(selectedWorkspace); state = result.state; render(); $('#main').focus({ preventScroll: true }); inform('Yedek doğrulanarak geri yüklendi. Önceki aktif geçmiş sunucudaki geri yükleme arşivinde korundu.');
    } catch (error) {
      if (!current()) return;
      if (acknowledged) {
        clearWorkspaceDrafts(selectedWorkspace);
        invalidate(false, true);
        inform('Arşiv geri yüklendi; ancak ekran yenilenemedi. Geri yüklemeyi tekrar yapmayın. Yenile ile defterin güncel görünümünü kontrol edin.', true);
      } else if (sent && (error.status === 409 || !Number.isInteger(error.status) || error.status >= 500)) {
        clearWorkspaceDrafts(selectedWorkspace);
        const uncertain = error.status !== 409; invalidate(uncertain);
        inform(uncertain ? 'Geri yüklemenin sonucu belirsiz. Yenile ile mevcut durumu kontrol edin; işlem otomatik tekrarlanmadı.' : 'Veriler değişti. Kurtarma bilgilerini yeniden kontrol ederek dosyayı tekrar seçin.', true);
      } else inform(error instanceof SyntaxError ? 'Yedek JSON dosyası okunamadı. Dosyayı kontrol ederek yeniden seçin.' : `Geri yükleme tamamlanamadı: ${error.message}`, true);
    } finally { setBusy(false); if (workspace !== selectedWorkspace) await refresh(); else if (previousFocus?.isConnected && previousFocus.closest('form')) previousFocus.focus({ preventScroll: true }); }
  });
}
function renderBackup() {
  $('#main').innerHTML = heading('Yedek ve çalışma alanı', 'Örnek ve dükkân kayıtları ayrı SQLite dosyalarında tutulur. Mevcut Excel dosyaları bu uygulamadan bağımsızdır.') + `<div class="split"><section class="section"><h2>Defter yedeği</h2><p class="subtitle">Yedek; bütün olay geçmişini ve bütünlük özetini içerir. İndirilen dosyayı ayrı bir diskte de saklayın.</p><div class="recovery-actions"><a class="button" href="${api('archive')}" download>Akışlı arşivi indir</a><a class="button secondary" href="${api('backup')}" download>Eski JSON yedeğini indir</a></div><p class="context-note">Büyük defter: akışlı arşivde 512 MiB / 250.000 olay. Eski JSON yolu 64 MiB ile uyumludur.</p><div class="info neutral">İndirme düğmesi tek başına yedeğin başka ortamda güvende olduğunu kanıtlamaz. Örnek çalışma alanında geri yükleme deneyin. Yedek yalnız alındığı çalışma alanına yüklenebilir; örnek yedek dükkân defterine taşınamaz. Bütünlük özeti dijital imza veya şifreleme değildir.</div><div class="restore-section"><h3>Yedekten geri yükle</h3><p class="subtitle">Seçili alanın aktif geçmişi yedekteki geçmişle değiştirilir. Sunucu önce mevcut geçmişi kendi veritabanında geri yükleme arşivine alır. İşlemden önce ayrıca uygun biçimde yedek indirin.</p><div id="restore-panel">${restoreFormMarkup()}</div></div></section><section class="section"><h2>Bu ilk sürümün sınırları</h2><ul class="helper-list"><li><b>Yerel kullanıcı hesapları</b><small>Ana bilgisayardaki editör kullanıcı oturumunu ve işlem yetkisini denetler. Telefon için ayrı kimlik doğrulamalı, salt okunur rapor portalı vardır; uzak bağlantı ayrıca devreye alınmalıdır.</small></li><li><b>Tek olay defteri</b><small>Satış, ödemeler ve stok aynı olayın bağlı hareketleridir. Sayım farkı açıklamalı ayrı iz bırakır.</small></li><li><b>Özgün birimler korunur</b><small>Para, gram, has gram ve adet birbirine otomatik çevrilmez. Fiyat katsayısı fiziksel saflık sayılmaz.</small></li><li><b>Henüz kapsam dışı</b><small>Emanet/konsinye, mülkiyet ve konum transferleri, ticari katsayı, otomatik maliyet tahsisi, atölye ve vergi hesabı.</small></li><li><b>Gerçek defterle doğrulanacak</b><small>Hurdanın terazi kapsamı, işçilik, has cari mahsuplaşması, POS valörü ve dükkânın kazanç hesabı. Günlük sayım ile dönemsel tartım ayrıdır.</small></li></ul></section></div>`;
  bindRestoreForm({ revision: state.revision });
  const count = [...drafts.keys()].filter(key => key.startsWith(workspace + ':')).length;
  if (count) {
    $('#restore-panel').insertAdjacentHTML('beforebegin', '<div class="info neutral" role="status"><p>Bu alanda ' + count + ' işlem taslağı var. Geri yükleme öncesinde bunları kontrol edip açıkça temizleyin. Diğer çalışma alanının taslakları korunur.</p><button type="button" class="button secondary compact" data-clear-workspace-drafts>Bu alandaki taslakları temizle</button></div>');
    $('#restore-form button[type="submit"]').disabled = true;
    document.querySelector('[data-clear-workspace-drafts]').addEventListener('click', () => { if (pending) { inform('Önce sonucu belirsiz son isteği doğrulayın.', true); return; } clearWorkspaceDrafts(); render(); $('#main').focus({ preventScroll: true }); });
  }
}
$('#navigation').addEventListener('click', e => { const b = e.target.closest('[data-view]'); if (b && !busy) setView(b.dataset.view); });
$('#refresh').addEventListener('click', () => refresh());
$('#retry').textContent='Kaydı sorgula / yeniden dene';
$('#retry').addEventListener('click', () => { if (pending) submit(pending.command, 'Bekleyen işlem doğrulandı.', pending); });
$('#workspace').addEventListener('change', async e => { captureDrafts(); partyReturnContext=null; ++recoveryGeneration; workspace = e.target.value; localStorage.setItem('defter-workspace', workspace); pending = readPending(); state = null; $('#main').innerHTML = '<div class="loading">Çalışma alanı açılıyor…</div>'; await refresh(); });
document.addEventListener('invalid', event => {
  const control = event.target;
  if (!control.matches('input, select, textarea')) return;
  control.setAttribute('aria-invalid', 'true');
  if (control.id) {
    const errorId = `${control.id}-error`;
    let error = document.getElementById(errorId);
    if (!error) { error = document.createElement('small'); error.id = errorId; error.className = 'field-error'; (control.closest('.field') || control.parentElement).append(error); }
    error.textContent = control.validity.valueMissing ? 'Bu alanı doldurun.' : control.validationMessage || 'Bu alanı kontrol edin.';
    control.setAttribute('aria-describedby', [...new Set([...(control.getAttribute('aria-describedby') || '').split(' ').filter(Boolean), errorId])].join(' '));
  }
  inform('İşaretli alanı kontrol edin. Eksik veya geçersiz bilgilerle kayıt oluşturulmadı.', true);
}, true);
document.addEventListener('input', event => { if (event.target.matches('input, select, textarea') && event.target.validity.valid) clearFieldError(event.target); });
document.addEventListener('change', event => { if (event.target.matches('input, select, textarea') && event.target.validity.valid) clearFieldError(event.target); });
function applyTheme(theme){
  const selected=theme==='dark'?'dark':'light';document.documentElement.dataset.theme=selected;
  const button=$('#theme-toggle');if(button){button.textContent=selected==='dark'?'Gündüz modu':'Gece modu';button.setAttribute('aria-pressed',String(selected==='dark'));button.setAttribute('aria-label',selected==='dark'?'Gündüz moduna geç':'Gece moduna geç');}
  localStorage.setItem('defter-theme',selected);
}
// Disclosure navigation: presentation only; existing routes and draft handling stay intact.
function setNavigationOpen(open) {
  const toggle = $('#navigation-toggle');
  if (!toggle) return;
  toggle.setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('navigation-open', open);
}
$('#navigation-toggle')?.addEventListener('click', () => setNavigationOpen($('#navigation-toggle').getAttribute('aria-expanded') !== 'true'));
$('.sidebar')?.addEventListener('keydown', event => {
  if (event.key === 'Escape' && $('#navigation-toggle')?.getAttribute('aria-expanded') === 'true') {
    setNavigationOpen(false); $('#navigation-toggle').focus(); event.preventDefault();
  }
});
async function start() { applyTheme(localStorage.getItem('defter-theme')||'light');$('#theme-toggle')?.addEventListener('click',()=>applyTheme(document.documentElement.dataset.theme==='dark'?'light':'dark'));$('#workspace').value = workspace; await refresh(false); }
start();

function inventoryMatches(item, query) {
  const normalize = value => String(value || '').toLocaleLowerCase('tr').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i');
  return normalize([item.code, item.barcode, item.description, account(item.accountId)?.name].join(' ')).includes(normalize(query.trim()));
}

function inventoryLabel(item) {
  return [item.code, account(item.accountId)?.name, item.description, item.actualWeight ? raw(item.actualWeight, 'GRAM') + ' gr' : ''].filter(Boolean).join(' · ');
}

function renderInventoryCards() {
  const cards = activeAccounts().filter(a => a.physical && a.unit === 'ADET' && a.isSaleable);
  const panel = document.createElement('section');
  panel.className = 'section';
  $('#card-editor').before(panel);
  panel.innerHTML = `<h2>Tekil ürünler</h2><details id="inventory-register"><summary>Mevcut stoktan tekil ürün tanımla</summary><p class="context-note">Bir adet ürüne kod verin. Bağlı terazideki gerçek gram ve ürün adedi aynı stok mevcutlarından ayrılır.</p><form id="inventory-register-form"><div class="form-grid">
    ${field('itemAccount','Stok kartı',{options:cards.map(a=>[a.id,a.name])})}
    ${field('itemCode','Ürün kodu',{max:64})}${field('itemBarcode','Barkod / QR metni',{max:64,required:false})}
    ${field('itemGroup','Ayar / terazi grubu',{options:[],required:false})}${field('itemWeight','Gerçek ağırlık · gr',{required:false,max:24})}
    ${field('itemDescription','Ürün açıklaması',{required:false})}
    <label class="field"><span>Fotoğraf · isteğe bağlı</span><input type="file" id="item-photo-file" accept="image/jpeg,image/png"><small>JPEG veya PNG, en çok 8 MiB. 96 × 96 önizleme saklanır.</small></label></div><details><summary>Brüt/net gram, milyem ve alış bağlantısı</summary><div class="form-grid">
    ${field('itemGross','Brüt ağırlık · gr',{required:false,max:24})}${field('itemNet','Net ağırlık · gr',{required:false,max:24})}
    ${field('itemFineness','Milyem',{required:false,max:4})}<label class="field"><span>Alış ara · tarih veya açıklama</span><input type="search" data-item-purchase-query maxlength="160"></label><button type="button" class="button secondary" data-find-item-purchase>Alışları göster</button><label class="field"><span>Alış fişi / ürün satırı · isteğe bağlı</span><select name="itemPurchaseChoice"><option value="">Alış bağlantısı yok</option></select></label><p role="status" data-item-purchase-status></p><details><summary>Teknik kayıt bilgileri</summary><p data-item-purchase-id style="overflow-wrap:anywhere">Alış seçilmedi</p></details></div></details>
    ${action('Tekil ürünü kaydet','Kayıt stok miktarını veya kasa bakiyesini değiştirmez.')}</form></details>
    <label class="field"><span>Tekil ürün ara</span><input type="search" id="inventory-card-search" maxlength="160" autocomplete="off"></label>
    <div id="inventory-card-list" aria-live="polite"></div>`;
  const fileInput = panel.querySelector('#item-photo-file');
  let thumbnail = null, photoSequence = 0;
  fileInput.addEventListener('change', async () => {
    const sequence = ++photoSequence, file = fileInput.files[0];
    thumbnail = null;
    fileInput.setCustomValidity(file ? 'Fotoğraf hazırlanıyor.' : '');
    if (!file) return;
    try {
      const value = await itemThumbnail(file);
      if (sequence !== photoSequence) return;
      thumbnail = value; fileInput.setCustomValidity('');
    } catch {
      if (sequence !== photoSequence) return;
      fileInput.setCustomValidity('Fotoğraf okunamadı. 8 MiB ve 24 megapiksel sınırında JPEG veya PNG seçin.');
      fileInput.reportValidity();
    }
  });
  const form = panel.querySelector('form'), group = form.elements.itemGroup, weight = form.elements.itemWeight;
  const syncGroup = () => {
    const groups = account(form.elements.itemAccount.value)?.pairedGroups || [];
    group.innerHTML = groups.map(id => `<option value="${esc(id)}">${esc(account(id).name)}</option>`).join('');
    group.disabled = !groups.length;
    group.closest('label').hidden = group.disabled;
    weight.required = !!groups.length;
    connectFieldHints(form);
  };
  form.elements.itemAccount.addEventListener('change', syncGroup);
  syncGroup();
  const purchaseChoice=form.elements.itemPurchaseChoice,purchaseStatus=form.querySelector('[data-item-purchase-status]');
  let purchaseGeneration=0;
  const clearPurchase=()=>{purchaseGeneration++;purchaseChoice.innerHTML='<option value="">Alış bağlantısı yok</option>';purchaseStatus.textContent='';form.querySelector('[data-item-purchase-id]').textContent='Alış seçilmedi';};
  form.elements.itemAccount.addEventListener('change',clearPurchase);group.addEventListener('change',clearPurchase);
  form.querySelector('[data-find-item-purchase]').addEventListener('click',async()=>{
    clearPurchase();const attempt=purchaseGeneration,revision=state.revision,selectedWorkspace=workspace,button=form.querySelector('[data-find-item-purchase]');
    button.disabled=true;purchaseStatus.textContent='Alışlar aranıyor…';
    try {
      const page=await request('journal',undefined,selectedWorkspace,{query:{scope:'all',type:'purchases',accountId:form.elements.itemAccount.value,q:form.querySelector('[data-item-purchase-query]').value,limit:30}});
      if(!form.isConnected||attempt!==purchaseGeneration||workspace!==selectedWorkspace)return;
      if(page.revision!==revision||state.revision!==revision)throw Error('Defter değişti. Alışları yeniden arayın.');
      const reversed=new Set([...page.items,...(page.receiptContext||[])].filter(e=>['reverse','supplierReverse'].includes(e.type)).map(e=>e.meta.originalId));
      for(const entry of page.items)if(!reversed.has(entry.id))for(const [lineIndex,line] of (entry.meta.lines||[]).entries()){
        if(line.accountId!==form.elements.itemAccount.value||(line.weightAccount||'')!==(group.disabled?'':group.value))continue;
        const used=(state.inventoryItems||[]).filter(item=>item.status!=='released'&&item.purchaseLine?.id===entry.id&&item.purchaseLine.lineIndex===lineIndex);
        const remaining=page.supplierPurchaseInfo?.[entry.id]?.find(row=>row.lineIndex===lineIndex)?.remainingQuantity??line.quantity;
        if(used.length>=remaining)continue;
        const option=new Option(receiptChoiceText(entry)+' · Satır '+(lineIndex+1)+' · '+account(line.accountId).name+' · '+(Number.isSafeInteger(line.value)?formatted(line.value):'TL bedeli belirtilmemiş'),String(purchaseChoice.options.length));
        option.dataset.purchaseId=entry.id;option.dataset.lineIndex=lineIndex;purchaseChoice.add(option);
      }
      purchaseStatus.textContent=purchaseChoice.options.length>1?'Ürün ve ayar eşleşen alış satırını seçin.'+(page.nextCursor?' İlk 30 fiş arandı; daha eski kayıt için aramayı daraltın.':''):'Eşleşen kullanılabilir alış satırı bulunamadı.'+(page.nextCursor?' İlk 30 fiş arandı; aramayı daraltın.':'');
    }catch(error){if(form.isConnected&&attempt===purchaseGeneration)purchaseStatus.textContent=error.message;}
    finally{if(button.isConnected)button.disabled=false;}
  });
  purchaseChoice.addEventListener('change',()=>{const selected=purchaseChoice.selectedOptions[0];form.querySelector('[data-item-purchase-id]').textContent=selected?.dataset.purchaseId?selected.dataset.purchaseId+' · Satır '+(Number(selected.dataset.lineIndex)+1):'Alış seçilmedi';});
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const v = formValues(form);
    const command = { type:'registerItem', accountId:v.itemAccount, code:v.itemCode, barcode:v.itemBarcode, description:v.itemDescription,
      weightAccount:group.value, actualWeight:v.itemWeight, grossWeight:v.itemGross, netWeight:v.itemNet, fineness:v.itemFineness };
    if (thumbnail) command.photo = thumbnail;
    const selectedPurchase=purchaseChoice.selectedOptions[0];
    if(selectedPurchase?.dataset.purchaseId)command.purchaseLine={id:selectedPurchase.dataset.purchaseId,lineIndex:Number(selectedPurchase.dataset.lineIndex)};
    submit(command, 'Tekil ürün mevcut stokla eşleştirildi.');
  });
  const list = panel.querySelector('#inventory-card-list'), search = panel.querySelector('#inventory-card-search');
  const paint = () => {
    const matches = (state.inventoryItems || []).filter(item => inventoryMatches(item, search.value));
    const shown = matches.slice(0, 30);
    list.innerHTML = shown.length ? shown.map((item, index) => `<details><summary>${esc(inventoryLabel(item))} · ${esc(({available:'Stokta',sold:'Satıldı',issued:'İadede verildi',released:'Eşleme kaldırıldı'})[item.status])}</summary>
      <p>${esc([item.barcode && 'Barkod ' + item.barcode, item.weightAccount && account(item.weightAccount).name, item.fineness && item.fineness + ' milyem',
        item.grossWeight && 'Brüt ' + raw(item.grossWeight,'GRAM') + ' gr',item.netWeight && 'Net ' + raw(item.netWeight,'GRAM') + ' gr',
        item.purchaseLine && 'Alış ' + item.purchaseLine.id + ' · Satır ' + (item.purchaseLine.lineIndex + 1)].filter(Boolean).join(' · '))}</p>
      <div data-private-item-cost>
        ${item.costSource ? `<p>Kayıtlı ürün maliyeti <strong>${esc(formatted(item.costSource.amountTL))}</strong> · Alış ${esc(item.costSource.id)} · Satır ${item.costSource.lineIndex + 1}</p>
          <form data-clear-cost="${index}"><label class="field"><span>Maliyet kaynağını kaldırma gerekçesi</span><input name="reason" maxlength="160" required></label><button type="submit" class="button secondary compact">Maliyet kaynağını kaldır</button></form>`
        : `<p>Ürün maliyeti bilinmiyor.</p>${item.purchaseCostOffer ? `<button type="button" class="button secondary" data-record-cost="${index}">Alış satırındaki ${esc(formatted(item.purchaseCostOffer.amountTL))} tutarı ürün maliyeti olarak kaydet</button>` : ''}`}
      </div>
      ${item.hasPhoto ? `<button class="button secondary compact" type="button" data-show-photo="${index}">Ürün fotoğrafını göster</button>` : ''}
      ${item.status === 'available' ? `<form data-release-item="${index}"><label class="field"><span>Eşleme kaldırma gerekçesi</span><input name="reason" maxlength="160" required></label><button class="button secondary" type="submit">Toplu stoğa geri ayır</button></form>` : ''}</details>`).join('') : '<p class="context-note">Eşleşen tekil ürün yok.</p>';
    if (matches.length > shown.length) list.insertAdjacentHTML('beforeend','<p>İlk 30 ürün gösteriliyor. Aramayı daraltın.</p>');
    for (const button of list.querySelectorAll('[data-record-cost]')) button.addEventListener('click', () => {
      const item = shown[Number(button.dataset.recordCost)];
      submit({type:'itemCostSource', inventoryCode:item.code, source:item.purchaseCostOffer}, 'Ürün maliyet kaynağı kaydedildi.');
    });
    for (const form of list.querySelectorAll('[data-clear-cost]')) form.addEventListener('submit', event => {
      event.preventDefault();
      if (form.reportValidity()) submit({type:'itemCostSource', inventoryCode:shown[Number(form.dataset.clearCost)].code, source:null, note:form.elements.reason.value}, 'Ürün maliyet kaynağı kaldırıldı.');
    });
    for (const button of list.querySelectorAll('[data-show-photo]')) button.addEventListener('click', async () => {
      const item = shown[Number(button.dataset.showPhoto)];
      button.disabled = true;
      try {
        const photo = await request('item-photo', undefined, workspace, {query:{code:item.code}});
        if (!button.isConnected) return;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 96;
        canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', item.code + ' ürün fotoğrafı');
        const ctx = canvas.getContext('2d'), pixels = atob(photo.pixels), img = ctx.createImageData(96,96);
        for (let i=0,j=0; i<pixels.length; i+=3,j+=4) {
          img.data[j]=pixels.charCodeAt(i); img.data[j+1]=pixels.charCodeAt(i+1); img.data[j+2]=pixels.charCodeAt(i+2); img.data[j+3]=255;
        }
        ctx.putImageData(img,0,0); button.replaceWith(canvas);
      } catch (error) { if (button.isConnected) { button.disabled = false; inform(error.message,true); } }
    });
    for (const release of list.querySelectorAll('[data-release-item]')) release.addEventListener('submit', event => {
      event.preventDefault();
      if (release.reportValidity()) submit({type:'releaseItem', inventoryCode:shown[Number(release.dataset.releaseItem)].code, note:release.elements.reason.value}, 'Ürün toplu stokta izleniyor.');
    });
  };
  search.addEventListener('input', paint); paint();
}

function lockInventoryRow(row, item, code) {
  row.dataset.inventoryCode = code;
  const genericSearch = row.querySelector('[data-product-search]');
  if (genericSearch) {
    genericSearch.value = ''; genericSearch.setCustomValidity(''); genericSearch.disabled = true;
    genericSearch.closest('.sale-product-search').hidden = true;
  }
  for (const key of ['accountId','quantity','weightAccount','weight']) row.querySelector(`[data-item-field="${key}"]`).disabled = true;
  const selected = row.querySelector('[data-item-field="accountId"]').selectedOptions[0];
  if (selected && item) selected.textContent = account(item.accountId).name + ' · 1 tekil ürün';
  const note = row.querySelector('[data-stock-note]');
  note.hidden = false;
  note.textContent = item ? 'Tekil ürün · ' + inventoryLabel(item) : 'Tekil ürün bulunamadı · ' + code;
}

function bindSaleInventory(form, rows, addRow, updateTotals) {
  const chooser = document.createElement('div');
  chooser.innerHTML = '<label class="field" for="sale-inventory-search"><span>Ürün kodu, barkod veya açıklama</span><input type="search" id="sale-inventory-search" autocomplete="off" maxlength="160"></label><div id="sale-inventory-results" class="workbench-actions" aria-live="polite"></div>';
  form.querySelector('#sale-items').before(chooser);
  const search = chooser.querySelector('input'), results = chooser.querySelector('#sale-inventory-results');
  let matches = [];
  const paint = () => {
    const used = new Set(rows().map(row => row.dataset.inventoryCode));
    matches = search.value.trim() ? (state.inventoryItems || []).filter(item => item.status === 'available' && !used.has(item.code) && inventoryMatches(item, search.value)) : [];
    results.innerHTML = matches.slice(0, 12).map((item, index) => `<button type="button" data-match="${index}" class="button secondary compact">${esc(inventoryLabel(item))}</button>`).join('');
    if (search.value.trim() && !matches.length) results.textContent = 'Satışa eklenebilecek tekil ürün bulunamadı.';
    if (matches.length > 12) results.insertAdjacentHTML('beforeend','<small>İlk 12 ürün gösteriliyor. Aramayı daraltın.</small>');
  };
  const choose = item => {
    if (!item || rows().some(row => row.dataset.inventoryCode === item.code)) return;
    let row = rows().find(r => !r.dataset.inventoryCode && !r.priceEditor?.read() && !r.dataset.productTouched && !r.querySelector('[data-item-field="value"]').value && !r.querySelector('[data-item-field="weight"]').value && r.querySelector('[data-item-field="quantity"]').value === '1');
    if (!row) row = addRow();
    if (!row) return;
    const control = key => row.querySelector(`[data-item-field="${key}"]`);
    control('accountId').value = item.accountId;
    control('accountId').dispatchEvent(new Event('change', { bubbles:true }));
    control('quantity').value = '1';
    if (item.weightAccount) { control('weightAccount').value = item.weightAccount; control('weight').value = raw(item.actualWeight,'GRAM'); }
    lockInventoryRow(row, item, item.code);
    form.dataset.draftDirty = 'true';
    updateTotals();
    search.value = ''; paint(); control('value').focus();
  };
  search.addEventListener('input', paint);
  search.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    paint();
    const key = search.value.trim().toUpperCase(), exact = matches.find(it => it.code === key || it.barcode === key);
    if (exact || matches.length === 1) choose(exact || matches[0]);
    else results.querySelector('button')?.focus();
  });
  results.addEventListener('click', event => { const button = event.target.closest('[data-match]'); if (button) choose(matches[Number(button.dataset.match)]); });
}

async function itemThumbnail(file) {
  if (!file.size || file.size > 8 * 1024 * 1024) throw Error('Boyut');
  // Read declared dimensions before invoking the browser decoder on an untrusted file.
  const bytes = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
  let w = 0, h = 0;
  if (file.type === 'image/png' && bytes.getUint32(0) === 0x89504e47 && bytes.getUint32(4) === 0x0d0a1a0a && bytes.getUint32(12) === 0x49484452) {
    w = bytes.getUint32(16); h = bytes.getUint32(20);
  } else if (file.type === 'image/jpeg' && bytes.getUint16(0) === 0xffd8) {
    let p = 2;
    while (p + 9 <= bytes.byteLength && bytes.getUint8(p) === 255) {
      while (p < bytes.byteLength && bytes.getUint8(p) === 255) p++;
      const marker = bytes.getUint8(p++), size = bytes.getUint16(p);
      if ([0xc0,0xc1,0xc2].includes(marker)) { h = bytes.getUint16(p + 3); w = bytes.getUint16(p + 5); break; }
      if (marker === 0xda || size < 2) break;
      p += size;
    }
  }
  if (!w || !h || w > 8192 || h > 8192 || w * h > 24_000_000) throw Error('Boyut');
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 96;
    const ctx = canvas.getContext('2d'), scale = 96 / Math.max(bitmap.width, bitmap.height);
    const width = bitmap.width * scale, height = bitmap.height * scale;
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 96, 96);
    ctx.drawImage(bitmap, (96 - width) / 2, (96 - height) / 2, width, height);
    const rgba = ctx.getImageData(0, 0, 96, 96).data, rgb = new Uint8Array(96 * 96 * 3);
    for (let i=0,j=0; i<rgba.length; i+=4,j+=3) { rgb[j]=rgba[i]; rgb[j+1]=rgba[i+1]; rgb[j+2]=rgba[i+2]; }
    return { version:1, pixels:btoa(String.fromCharCode(...rgb)) };
  } finally { bitmap.close(); }
}
