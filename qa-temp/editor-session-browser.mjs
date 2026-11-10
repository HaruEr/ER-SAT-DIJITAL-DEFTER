import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.mjs';
import { INITIAL_ACCOUNTS } from '../domain.mjs';
import { Repository } from '../repository.mjs';

const binary = process.env.CHROMIUM_PATH;
const evidence = process.argv[2];
if (!binary || !existsSync(binary) || !evidence) throw new Error('CHROMIUM_PATH ve kanıt dizini gerekli.');
const directory = mkdtempSync(join(tmpdir(), 'auth-browser-'));
const data = join(directory, 'synthetic-ledger');
mkdirSync(data);
mkdirSync(evidence, { recursive: true });
const repo = new Repository(join(data, 'demo.sqlite'), 'demo');
repo.execute({ id: 'browser-opening', revision: 0, command: { type: 'opening', date: '2026-11-10',
  balances: Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, a.id === 'ceyrek' ? (process.argv[3] === '--orders' ? '3' : '2') : '0'])) } });
repo.close();
const { server } = createApp({ dataDirectory: data });
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = spawn(binary, ['--headless=new','--no-first-run','--disable-default-apps','--disable-background-networking',
  '--remote-debugging-pipe', '--user-data-dir=' + join(directory,'profile'), 'about:blank'],
  { windowsHide:true, stdio:['ignore','ignore','ignore','pipe','pipe'] });
let counter = 0, buffer = '', sessionId;
const pending = new Map();
browser.stdio[4].setEncoding('utf8').on('data', chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\0')) !== -1) {
    const message = JSON.parse(buffer.slice(0,end));
    buffer = buffer.slice(end + 1);
    const call = pending.get(message.id);
    if (call) { pending.delete(message.id); message.error ? call.reject(new Error(message.error.message)) : call.resolve(message.result); }
  }
});
function call(method, params = {}, session = sessionId) {
  return new Promise((resolveCall,reject) => {
    const id = ++counter;
    pending.set(id,{ resolve:resolveCall, reject });
    browser.stdio[3].write(JSON.stringify({ id, method, params, sessionId:session }) + '\0');
  });
}
async function evaluate(expression) {
  const result = await call('Runtime.evaluate',{ expression,returnByValue:true,awaitPromise:true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'Browser evaluation failed');
  return result.result.value;
}
async function until(expression) {
  for (let tries = 0; tries < 100; tries++) {
    try { if (await evaluate(expression)) return; } catch { /* navigation may replace the execution context */ }
    await delay(100);
  }
  throw new Error('Browser condition failed: ' + expression);
}
async function screenshot(name) {
  const { data: png } = await call('Page.captureScreenshot',{ format:'png',captureBeyondViewport:false });
  writeFileSync(join(evidence,name),Buffer.from(png,'base64'));
}
const viewport = width => call('Emulation.setDeviceMetricsOverride', {width,height:900,deviceScaleFactor:1,mobile:false});
async function click(id) { await evaluate('document.getElementById(' + JSON.stringify(id) + ').click()'); }
async function fill(id,value) { await evaluate('document.getElementById(' + JSON.stringify(id) + ').value=' + JSON.stringify(value)); }
const password = randomUUID();
const timeout = setTimeout(() => { browser.kill(); process.exit(2); }, 90000);
try {
  const targets = await call('Target.getTargets');
  const page = targets.targetInfos.find(info => info.type === 'page');
  ({ sessionId } = await call('Target.attachToTarget',{ targetId:page.targetId,flatten:true }));
  await viewport(1440);
  await call('Page.navigate',{ url:origin });
  await until("document.querySelector('#login')?.hidden === false");
  await screenshot('login-1440.png');
  await fill('name','Sentetik işletme sahibi');
  await fill('password',password);
  await click('submit');
  await until("location.pathname === '/owner' && document.querySelector('#business-date')?.textContent.includes('2026')");
  if (process.argv[3] === '--orders') {
    const { verifyCustomerOrders } = await import('./customer-order-browser.mjs');
    await verifyCustomerOrders({evaluate,until,screenshot,viewport});
  }
  if (process.argv[3] === '--cari-return') {
    const { verifyReturnCredit } = await import('./customer-return-browser.mjs');
    await verifyReturnCredit({ evaluate,until,screenshot,viewport });
  }
  await evaluate("document.querySelector('a[href=\"/users\"]').click()");
  await until("location.pathname === '/users' && document.readyState === 'complete' && document.querySelector('#employee input[name=name]')");
  await evaluate("document.querySelector('#employee input[name=name]').value='Sentetik çalışan';document.querySelector('#employee input[name=password]').value=" + JSON.stringify(password) + ";document.querySelector('#employee').requestSubmit()");
  await until("document.querySelector('#status')?.textContent.includes('oluşturuldu')");
  await click('logout');
  await until("document.querySelector('#user')?.options.length === 2");
  await evaluate("document.querySelector('#user').value=[...document.querySelector('#user').options].find(o=>o.textContent==='Sentetik çalışan').value");
  await fill('password',password);
  await click('submit');
  await until("location.pathname === '/checkout' && !document.querySelector('#trade')?.hidden && document.querySelector('[data-product]')?.value === 'ceyrek'");
  await evaluate("document.querySelector('[data-product-search]').focus(); document.querySelector('[data-product-search]').value='çey'; document.querySelector('[data-product-search]').dispatchEvent(new Event('input')); document.querySelector('[data-product-search]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
  assert.equal(await evaluate("document.activeElement.hasAttribute('data-quantity')"),true);
  await evaluate("document.querySelector('[data-item] [data-quantity]').value='1';document.querySelector('[data-item] [data-value]').value='5000';document.querySelector('[data-price]').open=true;document.querySelector('[data-quoted]').value='5050';document.querySelector('[data-source]').value='Tezgâh listesi';document.querySelector('[data-add-component]').click();document.querySelector('[data-component-name]').value='İşçilik';document.querySelector('[data-component-value]').value='100'");
  await evaluate("document.querySelector('[data-add=received][data-category=money]').click();const receipt=document.querySelector('[data-allocation=received]');receipt.querySelector('[data-account]').value='nakit';receipt.querySelector('[data-account]').dispatchEvent(new Event('change',{bubbles:true}));receipt.querySelector('[data-quantity]').value='5000';receipt.querySelector('[data-quantity]').dispatchEvent(new Event('input',{bubbles:true}))");
  await screenshot('checkout-1440.png');
  await viewport(390);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'),true);
  await screenshot('checkout-390.png');
  await click('record');
  await until("document.querySelector('#review')?.hidden === false");
  await click('confirm');
  await until("document.querySelector('#status')?.textContent.includes('İşlem kaydedildi') && document.querySelector('[data-available]')?.textContent.includes('1 adet')");
  assert.equal(await evaluate("fetch('/api/state',{headers:{Authorization:'Bearer '+DefterSession.current().token}}).then(r=>r.status)"),403);
  const checked = new Repository(join(data,'demo.sqlite'), 'demo');
  try {
    const entry = checked.state().journal.at(-1);
    assert.deepEqual(entry.meta.lines[0].pricing, {costKnown:false, quotedTL:505000, source:'Tezgâh listesi', components:[{label:'İşçilik',amountTL:10000}]});
    assert.equal(entry.meta.revenue,500000);
    assert.equal(entry.actor.role,'employee');
  } finally { checked.close(); }
  await click('logout');
  await until("document.querySelector('#user')?.options.length === 2");
  assert.equal(await evaluate("sessionStorage.getItem('defter-session')"),null);
  console.log('Owner setup / employee provision / logout / employee sale / denial / logout / 1440 and 390 screenshots PASS');
} finally {
  clearTimeout(timeout);
  browser.kill();
  await new Promise(done => { server.close(done); server.closeAllConnections(); });
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
}
