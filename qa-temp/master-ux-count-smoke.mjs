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
  execute({ type: 'opening', date: '2026-01-02', balances: Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, a.id === 'nakit' ? '1000' : '0'])) });
  execute({ type: 'account', date: '2026-01-02', name: 'İpek <img src=x>', unit: 'TL', opening: '500' });
  execute({ type: 'account', date: '2026-01-02', name: 'Tedarikçi', unit: 'USD', opening: '-20' });
  execute({ type: 'fundAccount', date: '2026-01-02', name: 'Fiziki has', unit: 'HAS', physical: true, opening: '5' });
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
      else if (path === '/api/summary') result = workdaySummary(repo.state(), q.date);
      else if (path === '/api/command') result = repo.execute(JSON.parse(options.body), { compact: true });
      else throw new Error('Unexpected synthetic route');
      return { ok: true, status: 200, json: async () => result };
    } catch (error) { return { ok: false, status: error.status || 500, json: async () => ({ error: error.message }) }; }
  };
  window.eval(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8') + '\nwindow.__workbench = { setView };');
  await tick();
  return { window, document, repo, calls, control, async open(view) { window.__workbench.setView(view); await tick(); }, close() { window.close(); repo.close(); } };
}


check('v6 count mode guidance matches required daily scrap and optional periodic gram groups',async f=>{
 await f.open('closing');const d=f.document,revision=f.repo.state().revision;
 for(const id of ['hurda8','hurda14','hurda18','hurda21','hurda22','hurda24']){
  const input=d.querySelector(`#close-form [data-measure="${id}"]`);
  assert.ok(input,`${id} belongs to daily count`);assert.equal(input.required,true);assert.equal(input.value,'');
  assert.equal(d.querySelector(`#stocktake-form [data-measure="${id}"]`),null,`${id} must not be offered for periodic weighing`);
 }
 const periodicIds=['taki14','taki22','bilezik22',f.repo.state().accounts.find(a=>a.name==='Fiziki has').id];
 for(const id of periodicIds){const input=d.querySelector(`#stocktake-form [data-measure="${id}"]`);assert.ok(input);assert.equal(input.required,false);assert.equal(input.value,'');}
 const daily=d.querySelector('[data-count-mode="daily"]'),periodic=d.querySelector('[data-count-mode="periodic"]');
 assert.match(daily.querySelector('small').textContent,/hurda/i,'Daily guidance must include the mandatory scrap grams');
 assert.doesNotMatch(periodic.querySelector('small').textContent,/hurda/i,'Periodic guidance must not direct scrap to the wrong form');
 for(const group of [/takı/i,/bilezik/i,/HAS kasa/])assert.match(periodic.querySelector('small').textContent,group);
 const dailyDescription=d.querySelector('#close-form').closest('section').querySelector('.section-header p').textContent;
 assert.match(dailyDescription,/8\/14\/18\/21\/22\/24 ayar hurda gramları/,'Daily section must identify all six mandatory scrap grades');
 assert.doesNotMatch(dailyDescription,/Terazi gramlarını her akşam girmeniz gerekmez/,'Daily section must not exempt every gram account');
 const closingNote=d.querySelector('#close-form .form-actions .muted').textContent;
 for(const group of [/takı/i,/bilezik/i,/HAS kasa/])assert.match(closingNote,group);
 assert.match(closingNote,/tartılmadan/);assert.doesNotMatch(closingNote,/Ana terazi tartımı zorunlu değildir/);
 periodic.click();await tick();assert.equal(periodic.getAttribute('aria-pressed'),'true');assert.equal(d.querySelector('#stocktake-form').closest('section').hidden,false);
 assert.equal(f.repo.state().revision,revision);assert.equal(f.calls.filter(x=>x.method==='POST').length,0);
});
check('filtered invalid count is revealed without changing its blank value or writing',async f=>{
 await f.open('closing');const d=f.document,c=d.querySelector('#daily-count-nakit');c.value='999';c.dispatchEvent(new f.window.Event('input',{bubbles:true}));d.querySelector('#daily-reason-nakit').value='Sentetik fark';
 const filter=d.querySelector('#count-differences-only');filter.checked=true;filter.dispatchEvent(new f.window.Event('change'));
 const missing=[...d.querySelectorAll('#close-form [data-measure]')].find(e=>e.value==='');assert.ok(missing);assert.equal(missing.closest('tr').hidden,true);
 missing.dispatchEvent(new f.window.Event('invalid',{cancelable:true}));await tick();
 assert.equal(missing.closest('tr').hidden,false,'An invalid required field must be revealed so native validation can direct the user to it');assert.equal(missing.value,'');assert.equal(f.calls.filter(x=>x.method==='POST').length,0);
});
check('explicit missing-count recovery clears filter and focuses first blank without writing',async f=>{
 await f.open('closing');const d=f.document,c=d.querySelector('#daily-count-nakit');c.value='999';c.dispatchEvent(new f.window.Event('input',{bubbles:true}));d.querySelector('#daily-reason-nakit').value='Sentetik fark';
 const filter=d.querySelector('#count-differences-only');filter.checked=true;filter.dispatchEvent(new f.window.Event('change'));
 const missing=[...d.querySelectorAll('#close-form [data-measure]')].find(e=>e.value==='');assert.ok(missing);assert.equal(missing.closest('tr').hidden,true);
 d.querySelector('#count-show-missing').click();await tick();
 assert.equal(filter.checked,false);assert.equal(missing.closest('tr').hidden,false);assert.equal(d.activeElement,missing);assert.equal(missing.value,'');assert.equal(f.calls.filter(x=>x.method==='POST').length,0);
});
check('owner can distinguish an authenticated count from an old typed name in history', async f => {
  const actor = { id: 'c8d7225e-5535-49ed-b37f-5f6d0e7d09ef', role: 'owner', name: 'Defter sahibi' };
  const command = { type: 'stocktake', date: f.repo.state().date, counts: { bilezik22: '0' }, approvedBy: actor.name };
  for (const identity of [null, actor]) {
    f.repo.execute({ id: randomUUID(), revision: f.repo.state().revision, command }, { actor: identity });
  }
  await f.window.eval('refresh()');
  await f.open('journal');
  assert.match(f.document.querySelector('#journal-list').textContent, /İşlemi kaydeden · Defter sahibi \(c8d7225e-5535-49ed-b37f-5f6d0e7d09ef\)/);
  await f.window.eval('refresh()');
  await f.open('closing');
  const rows = Array.from(f.document.querySelectorAll('.closing-history summary'), el => el.textContent);
  assert.ok(rows.some(row => row.includes('Defter sahibi · Doğrulanmış kullanıcı')));
  assert.ok(rows.some(row => row.includes('Defter sahibi · Eski kayıtta yazılan ad')));
});
let failed = 0;
for (const { name, run } of cases) {
  const f = await fixture();
  try { await run(f); console.log(`PASS: ${name}`); }
  catch (error) { failed++; console.error(`FAIL: ${name}\n${error.stack}`); }
  finally { f.close(); }
}
if (failed) process.exitCode = 1;
else console.log(`PASS: ${cases.length} D04 measurement checks using synthetic memory repositories.`);
