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

check('D04 measurement controls describe expected value and difference without changing tab sequence',async f=>{
 await f.open('closing');const d=f.document,form=d.querySelector('#close-form');
 const input=form.querySelector('[data-measure]');assert.ok(d.querySelector('caption'));
 const refs=input.getAttribute('aria-describedby').split(' ');assert.ok(refs.every(id=>d.getElementById(id)));assert.ok(refs.includes('daily-expected-'+input.dataset.measure));
 const controls=[...form.querySelectorAll('.count-table input')];for(let i=0;i<controls.length;i+=2){assert.ok(controls[i].name.startsWith('count-'));assert.equal(controls[i+1].name,'reason-'+controls[i].dataset.measure);}
 assert.ok(form.querySelector('.count-approval #f-nextDate'));assert.ok(form.querySelector('.count-approval button[type=submit]'));
});
check('D04 blank, zero, signed difference, reason requirement and invalid precision remain distinct',async f=>{
 await f.open('closing');const d=f.document,c=d.querySelector('#daily-count-nakit'),r=d.querySelector('#daily-reason-nakit'),diff=d.querySelector('#daily-diff-nakit');
 const set=value=>{c.value=value;c.dispatchEvent(new f.window.Event('input',{bubbles:true}));};
 assert.equal(c.value,'');assert.equal(diff.textContent,'—');set('0');assert.equal(diff.textContent,'-1.000,00 TL');assert.equal(r.required,true);assert.equal(d.querySelector('#close-form').checkValidity(),false);
 set('1000');assert.equal(diff.textContent,'0,00 TL');assert.equal(r.required,false);set('1001');assert.equal(diff.textContent,'1,00 TL');assert.equal(r.required,true);set('1.001');assert.equal(c.checkValidity(),false);set('');assert.equal(diff.textContent,'—');assert.equal(c.checkValidity(),false);
 assert.equal(f.calls.filter(x=>x.method==='POST').length,0);
});
check('D04 daily close uses all actual counts and the selected next date',async f=>{
 await f.open('closing');const d=f.document,st=f.repo.state();
 const scales={TL:100,USD:100,EUR:100,HAS:1000,GRAM:1000,ADET:1};
 for(const input of d.querySelectorAll('#close-form [data-measure]')){const a=st.accounts.find(a=>a.id===input.dataset.measure);input.value=String((st.balances[a.id]||0)/scales[a.unit]);input.dispatchEvent(new f.window.Event('input',{bubbles:true}));}
 d.querySelector('#f-dailyApprovedBy').value='Sentetik sayım';d.querySelector('#f-nextDate').value='2026-01-05';const form=d.querySelector('#close-form');assert.equal(form.checkValidity(),true);form.requestSubmit();await tick();
 assert.equal(f.repo.state().date,'2026-01-05');assert.equal(f.repo.state().balances.nakit,st.balances.nakit);assert.equal(f.repo.state().closings.length,1);
});
check('D04 partial periodic count changes only measured grams and never closes the day',async f=>{
 await f.open('closing');const d=f.document,st=f.repo.state();d.querySelector('[data-count-mode=periodic]').click();
 const c=d.querySelector('#periodic-count-bilezik22');assert.equal(c.required,false);c.value='2.500';c.dispatchEvent(new f.window.Event('input',{bubbles:true}));d.querySelector('#periodic-reason-bilezik22').value='Sentetik gerçek tartım';d.querySelector('#f-stockApprovedBy').value='Sentetik denetçi';
 const form=d.querySelector('#stocktake-form');assert.equal(form.checkValidity(),true);form.requestSubmit();await tick();const after=f.repo.state();assert.equal(after.date,st.date);assert.equal(after.balances.bilezik22,2500);assert.equal(after.balances.taki14,st.balances.taki14);assert.equal(after.balances.bilezikAdet,st.balances.bilezikAdet);assert.equal(after.closings.length,0);
});
check('D04 modes preserve typed count and difference filter does not complete blank accounts',async f=>{
 await f.open('closing');const d=f.document,c=d.querySelector('#daily-count-nakit');c.value='999';c.dispatchEvent(new f.window.Event('input',{bubbles:true}));
 d.querySelector('[data-count-mode=periodic]').click();d.querySelector('[data-count-mode=daily]').click();assert.equal(c.value,'999');const filter=d.querySelector('#count-differences-only');filter.checked=true;filter.dispatchEvent(new f.window.Event('change'));assert.equal(c.closest('tr').hidden,false);assert.match(d.querySelector('#count-progress').textContent,/1 \/ /);assert.equal(d.querySelector('#close-form').checkValidity(),false);
});
check('D04 a count captured before a new record cannot commit against the newer revision',async f=>{
 await f.open('closing');const d=f.document;d.querySelector('[data-count-mode=periodic]').click();const c=d.querySelector('#periodic-count-bilezik22');c.value='2.500';c.dispatchEvent(new f.window.Event('input',{bubbles:true}));d.querySelector('#periodic-reason-bilezik22').value='Sentetik fark';d.querySelector('#f-stockApprovedBy').value='Sentetik';
 f.repo.execute({id:'d04-concurrent',revision:f.repo.state().revision,command:{type:'movement',date:'2026-01-02',accountId:'nakit',category:'Sermaye',direction:'in',quantity:'1'}});
 const rev=f.repo.state().revision;d.querySelector('#stocktake-form').requestSubmit();await tick();assert.equal(f.repo.state().revision,rev);assert.equal(f.repo.state().balances.bilezik22,0);assert.equal(f.repo.state().stocktakes.length,0);assert.equal(f.repo.state().date,'2026-01-02');
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
