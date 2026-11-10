import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS } from '../domain.mjs';
import { ReportRepository } from '../report-repository.mjs';
import { createReportApp, validateReportConfig, authorizeReportRequest } from '../report-server.mjs';

const origin = 'https://defter.example-tailnet.ts.net';
const options = { enabled: true, origin, allowedLogins: ['reader@example.com'] };
const headers = { Host: new URL(origin).host, 'Tailscale-User-Login': 'reader@example.com', Origin: origin };
const temporaryDirectories = new Set();
test.after(() => { for (const directory of temporaryDirectories) rmSync(directory,{recursive:true,force:true}); });
const requestShape = (change = {}) => ({ headers: { host: headers.Host, 'tailscale-user-login': headers['Tailscale-User-Login'], origin }, rawHeaders: ['Host',headers.Host,'Tailscale-User-Login',headers['Tailscale-User-Login']], socket: { remoteAddress: '127.0.0.1' }, ...change });

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'defter-reports-')), filename = join(directory, 'demo.sqlite');
  const writer = new Repository(filename, 'demo');
  temporaryDirectories.add(directory); t.after(() => writer.close());
  const run = (id, command) => writer.execute({ id, revision: writer.state().revision, command });
  const balances = Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, '0']));
  Object.assign(balances, { nakit: '1000', gramToplam: '10' });
  run('report-opening', { type: 'opening', date: '2026-10-27', balances });
  run('report-cari', { type: 'account', date: '2026-10-27', name: 'Cari <img src=x>', unit: 'HAS', opening: '-1.125' });
  for (let i = 0; i < 4; i++) run('report-movement-'+i, { type: 'movement', date: '2026-10-27', accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '1', note: 'İstanbul çeyrek '+i, privateDebug: 'PRIVATE_COMMAND_MARKER' });
  writer.db.prepare('INSERT INTO restore_archive(created_at,body) VALUES(?,?)').run('test', 'PRIVATE_ARCHIVE_MARKER');
  return { directory, filename, writer, run };
}

async function application(t, dataDirectory) {
  const app = createReportApp({ ...options, dataDirectory });
  await app.listen(0);
  t.after(async () => { await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const get = (path, extra = {}) => new Promise((resolve,reject) => {
    const request=http.get(base+path,{headers:{...headers,...extra}},response=>{
      const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:response.statusCode,headers:response.headers})));
    });request.on('error',reject);
  });
  return { ...app, base, get };
}

test('report service is explicitly disabled and refuses unsafe origin or identity configuration', () => {
  assert.throws(() => createReportApp(), /kapalı|disabled/i);
  for (const value of ['http://defter.example-tailnet.ts.net','https://example.com','https://user:secret@defter.example-tailnet.ts.net','https://defter.example-tailnet.ts.net/path','https://defter.example-tailnet.ts.net?x=1','https://defter.example-tailnet.ts.net#fragment','https://*.ts.net']) {
    assert.throws(() => validateReportConfig({ ...options, origin: value }));
  }
  for (const allowedLogins of [[],[''],['*'],['reader@example.com,other@example.com'],['reader\r\n@example.com']]) assert.throws(() => validateReportConfig({ ...options, allowedLogins }));
});

test('report authentication trusts only loopback plus exact origin, host and a single allowed Serve identity', () => {
  const config = validateReportConfig(options);
  assert.doesNotThrow(() => authorizeReportRequest(requestShape(), config));
  for (const request of [
    requestShape({ socket: { remoteAddress: '192.0.2.1' } }),
    requestShape({ headers: { host: headers.Host } }),
    requestShape({ headers: { host: headers.Host, 'tailscale-user-login': 'other@example.com' } }),
    requestShape({ headers: { host: headers.Host, 'tailscale-user-login': 'reader@example.com,other@example.com' } }),
    requestShape({ headers: { host: 'evil.example', 'tailscale-user-login': 'reader@example.com' } }),
    requestShape({ headers: { host: headers.Host, 'tailscale-user-login': 'reader@example.com', origin: 'https://evil.example' } }),
    requestShape({ rawHeaders: [...requestShape().rawHeaders,'Tailscale-User-Login','reader@example.com'] }),
    requestShape({ headers: { host: headers.Host, 'tailscale-user-login': 'reader@example.com', 'tailscale-funnel-request': 'true' } })
  ]) assert.throws(() => authorizeReportRequest(request, config), error => [401,403].includes(error.status));
});

test('native report repository opens read-only without creating missing files or mutating ledger bytes', t => {
  const { directory, filename, writer } = fixture(t), before = readFileSync(filename), events = writer.events(), revision = writer.state().revision;
  const reports = new ReportRepository(filename, 'demo');
  try {
    const overview = reports.overview();
    assert.equal(overview.accounts.find(a => a.unit === 'HAS').balance, -1125);
    assert.equal(overview.accounts.find(a => a.id === 'nakit').balance, 100400);
    assert.throws(() => reports.db.exec('DELETE FROM events'), /readonly|read-only/i);
    assert.equal(reports.db.prepare('SELECT total_changes() AS n').get().n, 0);
    assert.deepEqual(writer.events(), events); assert.equal(writer.state().revision, revision);
    assert.deepEqual(readFileSync(filename), before);
  } finally { reports.close(); }
  const missing = join(directory,'missing.sqlite'); assert.throws(() => new ReportRepository(missing, 'demo')); assert.equal(existsSync(missing), false);
});

test('report server authenticates before opening data and never serves editor or recovery routes', async t => {
  const { directory } = fixture(t), app = await application(t,directory);
  const denied = await fetch(app.base+'/api/reports/overview?workspace=demo', { headers: { Host: headers.Host } });
  assert.ok([401,403].includes(denied.status)); assert.equal(app.repositories.size, 0);
  for (const path of ['/api/state','/api/command','/api/restore','/api/backup','/api/recovery','/repository.mjs','/data/demo.sqlite','/app.js','/styles.css']) assert.equal((await app.get(path)).status, 404, path);
  for (const method of ['POST','PUT','PATCH','DELETE','OPTIONS','TRACE']) {
    const response = await new Promise((resolve,reject) => { const req=http.request(app.base+'/api/reports/overview',{method,headers},res=>{res.resume();resolve(res);});req.on('error',reject);req.end(); });
    assert.equal(response.statusCode, 405, method);
  }
  assert.equal(app.repositories.size, 0);
  const response = await app.get('/'); assert.equal(response.status,200); assert.match(response.headers.get('cache-control'),/no-store/); assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.equal(app.server.address().address,'127.0.0.1');
});

test('report overview and dated summary expose original units and no commands, archives or server paths', async t => {
  const { directory, filename, writer } = fixture(t), app = await application(t,directory), before = writer.events();
  for (const path of ['/api/reports/overview?workspace=demo','/api/reports/summary?workspace=demo&date=2026-10-27','/api/reports/journal?workspace=demo&limit=100']) {
    const response=await app.get(path), content=await response.text(); assert.equal(response.status,200,content);
    assert.doesNotMatch(content,/PRIVATE_COMMAND_MARKER|PRIVATE_ARCHIVE_MARKER|"command"|restore_archive|sqlite/i);
    assert.equal(content.includes(filename),false);
    const result=JSON.parse(content); assert.equal(result.workspace,'demo');
    if(result.accounts) assert.ok(result.accounts.some(a=>a.unit==='HAS'&&(a.balance===-1125||a.closing===-1125)));
  }
  assert.deepEqual(writer.events(),before);
  for(const path of ['/api/reports/overview?workspace=../demo','/api/reports/summary?workspace=demo&date=2026-02-31','/api/reports/journal?workspace=demo&limit=101','/api/reports/journal?workspace=demo&limit=-1','/api/reports/journal?workspace=demo&type=unknown','/api/reports/journal?workspace=demo&cursor=not-a-cursor']) assert.equal((await app.get(path)).status,400,path);
});

test('journal pagination has bounded unique pages and rejects stale or cross-filter cursors', async t => {
  const { directory, run }=fixture(t),app=await application(t,directory);
  const first=await(await app.get('/api/reports/journal?workspace=demo&limit=2')).json();
  assert.equal(first.items.length,2);assert.ok(first.nextCursor);
  const second=await(await app.get('/api/reports/journal?workspace=demo&limit=2&cursor='+encodeURIComponent(first.nextCursor))).json();
  assert.equal(second.items.length,2);assert.equal(new Set([...first.items,...second.items].map(e=>e.record)).size,4);
  assert.equal((await app.get('/api/reports/journal?workspace=demo&type=movement&limit=2&cursor='+encodeURIComponent(first.nextCursor))).status,400);
  run('report-later',{type:'movement',date:'2026-10-27',accountId:'nakit',direction:'in',category:'Sermaye',quantity:'1',note:'Yeni kayıt'});
  assert.equal((await app.get('/api/reports/journal?workspace=demo&limit=2&cursor='+encodeURIComponent(first.nextCursor))).status,409);
  const search=await(await app.get('/api/reports/journal?workspace=demo&q=ISTANBUL&limit=100')).json();assert.equal(search.items.length,4);
});

test('missing, corrupt and semantically damaged report databases fail safely without creating or leaking data', async t => {
  const directory=mkdtempSync(join(tmpdir(),'defter-report-errors-'));temporaryDirectories.add(directory);
  const app=await application(t,directory);
  let response=await app.get('/api/reports/overview?workspace=demo');assert.equal(response.status,503);assert.equal(existsSync(join(directory,'demo.sqlite')),false);assert.doesNotMatch(await response.text(),/ENOENT|sqlite|[A-Z]:\\/);
  writeFileSync(join(directory,'demo.sqlite'),'invalid physical SQLite');response=await app.get('/api/reports/overview?workspace=demo');assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/SQLITE|database|[A-Z]:\\/);
});

test('HTTP identity spoofing, duplicate headers and cross-origin reads fail before database access', async t => {
  const {directory}=fixture(t),app=await application(t,directory);
  for(const extra of [
    {'Tailscale-User-Login':'other@example.com'},
    {'Tailscale-User-Login':['reader@example.com','reader@example.com']},
    {'Tailscale-User-Login':'reader@example.com,other@example.com'},
    {Origin:'https://other.example'},
    {Host:'defter.example-tailnet.ts.net.evil.example'},
    {'Tailscale-Funnel-Request':'true'},
    {'Tailscale-User-Login':'','X-Forwarded-User':'reader@example.com','X-Forwarded-For':'127.0.0.1'}
  ])assert.ok([401,403].includes((await app.get('/api/reports/overview?workspace=demo',extra)).status));
  assert.equal(app.repositories.size,0);
  const withoutOrigin={...headers};delete withoutOrigin.Origin;
  const status=await new Promise((resolve,reject)=>{const request=http.get(app.base+'/',{headers:withoutOrigin},response=>{response.resume();resolve(response.statusCode);});request.on('error',reject);});
  assert.equal(status,200);
});

test('physical HAS funds are financial accounts and report DTOs preserve each business category', t => {
  const{filename,run}=fixture(t);run('report-has-fund',{type:'fundAccount',date:'2026-10-27',name:'HAS kasa',unit:'HAS',physical:true,opening:'2.500'});
  const reader=new ReportRepository(filename,'demo');try{
    const accounts=reader.overview().accounts;
    assert.equal(accounts.find(account=>account.name==='HAS kasa').category,'financial');
    assert.equal(accounts.find(account=>account.id==='gramToplam').category,'stock');
    assert.equal(accounts.find(account=>account.kind==='receivable').category,'receivable');
    assert.equal(accounts.find(account=>account.name==='HAS kasa').countPolicy,'periodic');
    assert.equal(typeof reader.execute,'undefined');assert.equal(typeof reader.restore,'undefined');assert.equal(typeof reader.backup,'undefined');
  }finally{reader.close();}
});

test('a semantically damaged ledger is unavailable rather than mislabeled as valid zero balances', async t => {
  const{directory,writer}=fixture(t);writer.db.prepare('UPDATE events SET body=? WHERE seq=1').run(JSON.stringify({id:'broken',schemaVersion:3,command:{type:'opening',date:'2026-10-27',balances:{}}}));
  const app=await application(t,directory),response=await app.get('/api/reports/overview?workspace=demo');
  assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/Nakit TL|balances|opening|SQLITE|body/);
});

test('CONNECT and upgrade requests never expose a tunnel or reader database', async t => {
  const{directory}=fixture(t),app=await application(t,directory);
  const connected=await new Promise((resolve,reject)=>{const request=http.request(app.base,{method:'CONNECT',headers});request.on('connect',(response,socket)=>{resolve(response.statusCode);socket.destroy();});request.on('error',reject);request.end();});
  assert.equal(connected,405);
  const upgraded=await new Promise((resolve,reject)=>{const request=http.get(app.base+'/',{headers:{...headers,Connection:'Upgrade',Upgrade:'websocket'}},response=>{response.resume();resolve(response.statusCode);});request.on('upgrade',(response,socket)=>{resolve(response.statusCode);socket.destroy();});request.on('error',reject);});
  assert.equal(upgraded,403);assert.equal(app.repositories.size,0);
});

test('disabled CLI configuration does not listen, create files or disclose supplied environment values', t => {
  const directory=mkdtempSync(join(tmpdir(),'defter-report-cli-'));temporaryDirectories.add(directory);
  const marker='PRIVATE_CONFIGURATION_MARKER';
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../report-server.mjs',import.meta.url))],{env:{...process.env,REPORT_ENABLED:'0',REPORT_ORIGIN:marker,REPORT_ALLOWED_LOGINS:marker,REPORT_DATA_DIRECTORY:join(directory,'never-created')},encoding:'utf8',timeout:10000});
  assert.equal(result.status,1,result.stderr);assert.equal(existsSync(join(directory,'never-created')),false);assert.equal((result.stdout+result.stderr).includes(marker),false);
});
