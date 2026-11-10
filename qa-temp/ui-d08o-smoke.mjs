import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadJSDOM } from '../test-support/jsdom.mjs';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS, workdaySummary } from '../domain.mjs';

const JSDOM = await loadJSDOM();
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0)); };
const cases = [];
const check = (name, run) => cases.push({ name, run });
async function fixture() {
  const repo = new Repository(':memory:', 'demo');
  const execute = command => repo.execute({ id: randomUUID(), revision: repo.state().revision, command });
  execute({ type: 'opening', date: '2026-01-02', balances: Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, a.id === 'nakit' ? '1000' : a.id==='gramToplam'?'10':a.id==='bilezik22'?'20':'0'])) });
  execute({ type: 'account', date: '2026-01-02', name: 'İpek <img src=x>', unit: 'TL', opening: '500' });
  execute({ type: 'account', date: '2026-01-02', name: 'Tedarikçi', unit: 'USD', opening: '-20' });
  execute({ type: 'fundAccount', date: '2026-01-02', name: 'Fiziki has', unit: 'HAS', physical: true, opening: '5' });
  execute({type:'sale',date:'2026-01-02',items:[{accountId:'gramToplam',quantity:'2',value:'200'}],cash:'200',pos:'0',bank:'0',scrapQuantity:'0',scrapValue:'0'});
  execute({type:'stocktake',date:'2026-01-02',counts:{bilezik22:'21'},reasons:{bilezik22:'Sentetik fark'},approvedBy:'Test'});
  const dom = new JSDOM(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), { url: 'http://127.0.0.1:4317/', runScripts: 'outside-only' });
  const { window } = dom, { document } = window;
  Object.defineProperty(window.crypto, 'randomUUID', { value: randomUUID });
  const calls = [], control = { statementFailure: false, statementDelay: null };
  window.fetch = async (url, options = {}) => {
    const parsed = new URL(url, window.location.href), path = parsed.pathname, q = Object.fromEntries(parsed.searchParams);
    calls.push({ path, q, method: options.method || 'GET' });
    try {
      let result;
      if (path === '/api/state') result = repo.state({ compact: true });
      else if (path === '/api/journal') result = repo.journalPage({ ...q, limit: q.limit ? Number(q.limit) : 25 });
      else if (path === '/api/account-statement') {
        if (control.statementDelay) await control.statementDelay;
        if (control.statementFailure) throw new Error('Sentetik ekstre hatası');
        result = repo.accountStatement(q);
      }
      else if (path === '/api/summary') { result = workdaySummary(repo.state(), q.date); if (control.summaryRows) result.accounts = control.summaryRows(result.accounts); }
      else if (path === '/api/command') result = repo.execute(JSON.parse(options.body), { compact: true });
      else throw new Error('Unexpected synthetic route');
      return { ok: true, status: 200, json: async () => result };
    } catch (error) { return { ok: false, status: error.status || 500, json: async () => ({ error: error.message }) }; }
  };
  window.eval(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8') + '\nwindow.__workbench = { setView, formatted };');
  await tick();
  return { window, document, repo, calls, control, async open(view) { window.__workbench.setView(view); await tick(); }, close() { window.close(); repo.close(); } };
}


check('All five values keep exact domain results and individual units',async f=>{await f.open('summary');const expected=workdaySummary(f.repo.state(),'2026-01-02').accounts.filter(r=>!['gramAdet','gramaltin'].includes(r.accountId));const rows=[...f.document.querySelectorAll('#summary-result tbody tr')];assert.equal(rows.length,expected.length);rows.forEach((tr,i)=>{const row=expected[i];assert.deepEqual([...tr.querySelectorAll('td.numeric')].map(x=>x.textContent),['opening','incoming','outgoing','adjustment','closing'].map(k=>f.window.__workbench.formatted(row[k],row.unit)));});assert.match(f.document.querySelector('caption').textContent,/2 Ocak 2026/);assert.equal(f.calls.filter(x=>x.method!=='GET').length,0);});
check('Unit/group/search filters preserve independent day totals',async f=>{await f.open('summary');const total=f.document.querySelector('.summary-day').textContent;const unit=f.document.querySelector('#summary-unit');unit.value='USD';unit.dispatchEvent(new f.window.Event('change'));for(const tr of f.document.querySelectorAll('tbody tr'))assert.match(tr.textContent,/USD/);assert.equal(f.document.querySelector('.summary-day').textContent,total);const search=f.document.querySelector('#summary-search');search.value='eşleşmez';search.dispatchEvent(new f.window.Event('input'));assert.match(f.document.querySelector('tbody').textContent,/eşleşen hesap yok/);assert.equal(f.document.querySelector('.summary-day').textContent,total);});
check('Changing date input does not relabel already loaded data; failed date removes stale table',async f=>{await f.open('summary');const input=f.document.querySelector('#f-summaryDate');input.value='2027-01-01';input.dispatchEvent(new f.window.Event('input'));assert.match(f.document.querySelector('.summary-day').textContent,/2 Ocak 2026/);f.document.querySelector('#summary-form').dispatchEvent(new f.window.Event('submit',{bubbles:true,cancelable:true}));await tick();assert.equal(f.document.querySelector('#summary-result table'),null);assert.match(f.document.querySelector('#summary-status').textContent,/Özet alınamadı/);});
check('Active filter shows only original nonzero movements and clears empty results on reset',async f=>{await f.open('summary');const check=f.document.querySelector('#summary-active');check.checked=true;check.dispatchEvent(new f.window.Event('change'));const expected=workdaySummary(f.repo.state(),'2026-01-02').accounts.filter(r=>r.incoming||r.outgoing||r.adjustment);assert.equal(f.document.querySelectorAll('tbody td.numeric').length,expected.length*5);check.checked=false;check.dispatchEvent(new f.window.Event('change'));assert.ok(f.document.querySelectorAll('tbody td.numeric').length>0);});
check('Empty retired accounts disappear while active zero accounts remain', async f => {
  await f.open('summary');
  const text = f.document.querySelector('#summary-result tbody').textContent;
  assert.doesNotMatch(text, /Eski hesap/);
  assert.match(text, /GRAM ALTIN/);
  assert.ok(f.repo.state().accounts.some(a => a.id === 'gramAdet'));
  assert.equal(f.calls.filter(x => x.method !== 'GET').length, 0);
});
for (const values of [
  { opening: 3, outgoing: 3 }, { incoming: 2, outgoing: 2 },
  { adjustment: -1, closing: -1 },
  { opening: 1 }, { incoming: 1 }, { outgoing: 1 }, { adjustment: 1 }, { closing: 1 },
  { closing: null },
]) check(`Retired historical values remain visible: ${JSON.stringify(values)}`, async f => {
  f.control.summaryRows = rows => rows.map(r => r.accountId === 'gramAdet' ? { ...r, ...values } : r);
  await f.open('summary');
  assert.match(f.document.querySelector('#summary-result tbody').textContent, /Gram altın \(günlük adet\)/);
});
let failed = 0;
for (const { name, run } of cases) {
  const f = await fixture();
  try { await run(f); console.log(`PASS: ${name}`); }
  catch (error) { failed++; console.error(`FAIL: ${name}\n${error.stack}`); }
  finally { f.close(); }
}
if (failed) process.exitCode = 1;
else console.log(`PASS: ${cases.length} D08-O behavior checks using synthetic memory repositories.`);
