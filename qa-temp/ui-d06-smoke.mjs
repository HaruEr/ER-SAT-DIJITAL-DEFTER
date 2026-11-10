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
  execute({ type: 'opening', date: '2026-01-02', balances: Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, ['nakit','pos','usd'].includes(a.id) ? '1000' : '0'])) });
  execute({ type: 'account', date: '2026-01-02', name: 'İpek <img src=x>', unit: 'TL', opening: '500' });
  execute({ type: 'account', date: '2026-01-02', name: 'Tedarikçi', unit: 'USD', opening: '-20' });
  execute({ type: 'fundAccount', date: '2026-01-02', name: 'Fiziki has', unit: 'HAS', physical: true, opening: '5' });
  execute({type:'fundAccount',date:'2026-01-02',name:'İkinci TL banka',unit:'TL',physical:false,opening:'100'});
  execute({type:'fundAccount',date:'2026-01-02',name:'İkinci USD banka',unit:'USD',physical:false,opening:'50'});
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


const input=(f,name,value)=>{const e=f.document.querySelector(`[name="${name}"]`);e.value=value;e.dispatchEvent(new f.window.Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));return e;};
const bank=(f,unit)=>f.repo.state().accounts.find(a=>a.name===`İkinci ${unit} banka`).id;
const start=async(f,kind)=>{await f.open('banks');f.document.querySelector(`[data-bank-action="${kind}"]`).click();};
check('POS only offers TL banks; readonly fee and selected target receive exact net',async f=>{
 await start(f,'settlement');const s=f.repo.state();const choices=[...f.document.querySelector('[name="bankAccount"]').options];
 for(const o of choices){const a=s.accounts.find(a=>a.id===o.value);assert.equal(a.unit,'TL');assert.equal(a.physical,false);assert.notEqual(a.id,'pos');}
 input(f,'bankAccount',bank(f,'TL'));input(f,'gross','200');input(f,'expected','195');
 assert.equal(f.document.querySelector('[name="fee"]').readOnly,true);assert.equal(f.document.querySelector('[name="fee"]').value,'5.00');
 f.document.querySelector('#settlement-form').dispatchEvent(new f.window.Event('submit',{bubbles:true,cancelable:true}));await tick();
 const after=f.repo.state();assert.equal(after.balances.pos,s.balances.pos-20000);assert.equal(after.balances[bank(f,'TL')],s.balances[bank(f,'TL')]+19500);assert.equal(after.balances.banka,s.balances.banka);assert.equal(after.revision,s.revision+1);
});
check('Net above gross is invalid and performs no write',async f=>{
 await start(f,'settlement');input(f,'gross','200');const e=input(f,'expected','201');assert.equal(e.checkValidity(),false);const rev=f.repo.state().revision;
 f.document.querySelector('#settlement-form').dispatchEvent(new f.window.Event('submit',{bubbles:true,cancelable:true}));await tick();assert.equal(f.repo.state().revision,rev);
});
check('USD source restricts targets and transfers exact amount with preserved total',async f=>{
 await start(f,'transfer');input(f,'fromAccount','usd');const target=f.document.querySelector('[name="toAccount"]');assert.deepEqual([...target.options].map(x=>x.value),[bank(f,'USD')]);
 assert.match(f.document.querySelector('#f-toAccount-selection').textContent,/İkinci USD/);input(f,'quantity','10,25');const before=f.repo.state();
 f.document.querySelector('#transfer-form').dispatchEvent(new f.window.Event('submit',{bubbles:true,cancelable:true}));await tick();const after=f.repo.state();assert.equal(after.balances.usd,before.balances.usd-1025);assert.equal(after.balances[bank(f,'USD')],before.balances[bank(f,'USD')]+1025);assert.equal(after.balances.nakit,before.balances.nakit);
});
check('Single HAS account has no target and disabled save',async f=>{
 await start(f,'transfer');const a=f.repo.state().accounts.find(a=>a.name==='Fiziki has');input(f,'fromAccount',a.id);assert.equal(f.document.querySelector('[name="toAccount"]').options.length,0);assert.equal(f.document.querySelector('#transfer-form button[type="submit"]').disabled,true);assert.match(f.document.querySelector('#f-toAccount-selection').textContent,/Uygun hedef/);
});
check('Draft selected account survives navigation; visual and DOM order agree',async f=>{
 await start(f,'settlement');input(f,'bankAccount',bank(f,'TL'));input(f,'gross','120');input(f,'expected','118');await f.open('overview');await f.open('banks');
 assert.equal(f.document.querySelector('[name="bankAccount"]').value,bank(f,'TL'));assert.equal(f.document.querySelector('[name="gross"]').value,'120');assert.match(f.document.querySelector('#f-bankAccount-selection').textContent,/İkinci TL/);
 const wrap=f.document.querySelector('.bank-workspace');assert.ok(wrap.firstElementChild.querySelector('#bank-operation'));assert.ok(wrap.lastElementChild.classList.contains('bank-grid'));
});
check('money shortcuts identify destination actions and preserve the expense draft',async f=>{
 await f.open('transaction');
 f.document.querySelector('[data-tab="movement"]').click();
 input(f,'note','Korunan gider taslağı');
 const transfer=f.document.querySelector('[data-owner-operation="transfer"]'),pos=f.document.querySelector('[data-owner-operation="settlement"]');
 assert.equal(transfer.textContent,'Kasa / banka transferi →');
 assert.equal(pos.textContent,'POS tahsilatı →');
 transfer.click();await tick();
 assert.ok(f.document.querySelector('#transfer-form'));
 await f.open('transaction');
 assert.equal(f.document.querySelector('[name="note"]').value,'Korunan gider taslağı');
});
check('summary explains its per-unit balance formula once',async f=>{
 await f.open('summary');
 assert.equal((f.document.querySelector('#summary-result').textContent.match(/giriş − çıkış/g)||[]).length,1);
 assert.match(f.document.querySelector('#summary-result caption').textContent,/Her satır kendi biriminde/);
});
let failed = 0;
for (const { name, run } of cases) {
  const f = await fixture();
  try { await run(f); console.log(`PASS: ${name}`); }
  catch (error) { failed++; console.error(`FAIL: ${name}\n${error.stack}`); }
  finally { f.close(); }
}
if (failed) process.exitCode = 1;
else console.log(`PASS: ${cases.length} D06 behavior checks using synthetic memory repositories.`);

