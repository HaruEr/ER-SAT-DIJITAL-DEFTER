import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

async function fixture(t) {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'editor-auth-'));
  const { server, repositories } = createApp({ dataDirectory, logger: () => {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    rmSync(dataDirectory, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  function send(path, token, body) {
    const headers = token ? { Authorization: 'Bearer ' + token } : {};
    return fetch(base + path, body === undefined ? { headers } : {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
  }
  return { send, repositories, dataDirectory };
}

test('anonymous and unknown sessions cannot read or write either ledger', async t => {
  const { send, repositories } = await fixture(t);
  for (const token of [null, 'not-a-session']) {
    for (const route of ['state','backup','journal','account-statement','summary','archive','recovery','checkout']) {
      assert.equal((await send('/api/' + route + '?workspace=dukkan', token)).status, 401, route);
    }
    for (const route of ['command','restore','archive/restore','download-ticket']) {
      assert.equal((await send('/api/' + route, token, {})).status, 401, route);
    }
  }
  assert.equal(repositories.size, 0);
});

test('employee privileges stay narrow and logout revokes the bearer', async t => {
  const { send, repositories } = await fixture(t);
  const setup = await send('/api/auth/setup', null, { name: 'Sahip', password: 'example-owner-test-2026' });
  assert.equal(setup.status, 201);
  const owner = await setup.json();
  const created = await send('/api/auth/employees', owner.token, { name: 'Çalışan', password: 'example-worker-test-2026' });
  assert.equal(created.status, 201);
  const person = await created.json();
  const logged = await send('/api/auth/login', null, { id: person.id, password: 'example-worker-test-2026' });
  assert.equal(logged.status, 200);
  const worker = await logged.json();
  for (const route of ['state','journal','account-statement','summary','backup','archive','recovery']) {
    assert.equal((await send('/api/' + route, worker.token)).status, 403);
  }
  for (const route of ['restore','archive/restore','download-ticket','auth/employees']) {
    assert.equal((await send('/api/' + route, worker.token, {})).status, 403);
  }
  for (const type of ['close','movement','account','amend','reverse','opening','collection','linkScrapPurchase','itemCostSource','scrapAdvanceTransfer','scrapAdvanceUndo']) {
    assert.equal((await send('/api/command', worker.token, { command: { type } })).status, 403);
  }
  assert.equal(repositories.size, 0);
  const initial = await (await send('/api/state', owner.token)).json();
  const opening = { type: 'opening', date: '2026-11-10', balances: Object.fromEntries(initial.accounts.filter(a => !a.retired).map(a => [a.id, a.id === 'ceyrek' ? '5' : '0'])) };
  assert.equal((await send('/api/command', owner.token, { id: 'open', revision: 0, command: opening })).status, 200);
  const secret = 'ONLY_OWNER_REFERENCE_397';
  const named = { type: 'fundAccount', date: opening.date, name: 'Tezgâh bankası', unit: 'USD', physical: false, opening: '0', note: secret };
  assert.equal((await send('/api/command', owner.token, { id: 'usd', revision: 1, command: named })).status, 200);
  const checkout = await (await send('/api/checkout', worker.token)).json();
  assert.deepEqual(Object.keys(checkout).sort(), ['date','initialized','inventoryItems','payments','products','revision','stocks']);
  assert.deepEqual(checkout.payments.find(p => p.id === 'fund-usd'), { id: 'fund-usd', name: named.name, unit: 'USD' });
  const sale = { type: 'sale', date: opening.date, counterpartyType: 'customer',
    items: [{ accountId: 'ceyrek', quantity: '1', value: '50' }], received: [{ accountId: 'fund-usd', quantity: '1', valueTL: '50' }] };
  const envelope = { id: 'local-sale', revision: 2, command: sale };
  for (const extra of [{ costTL:'0' }, { costTL:null }, { costTL:'' }]) {
    const forbidden = { ...sale, salePricing: { version: 1, lines: [extra] } };
    assert.equal((await send('/api/command', worker.token, { ...envelope, command: forbidden })).status, 403);
  }
  const coupled = { ...sale, given: [{ accountId: 'nakit', quantity: '1', valueTL: '1' }] };
  assert.equal((await send('/api/command', worker.token, { ...envelope, command: coupled })).status, 400);
  for (const duplicate of [false,true]) {
    const response = await send('/api/command', worker.token, envelope);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { id: 'local-sale', revision: 3, duplicate });
  }
  const state = await (await send('/api/state', owner.token)).json();
  assert.equal(state.balances.ceyrek, 4);
  assert.equal(state.balances['fund-usd'], 100);
  const download = async () => (await (await send('/api/download-ticket', owner.token, { operation: 'backup' })).json()).url;
  const ticket = await download();
  assert.equal((await send(ticket)).status, 200);
  assert.equal((await send(ticket)).status, 401);
  const wrongRoute = (await download()).replace('/api/backup','/api/archive');
  assert.equal((await send(wrongRoute)).status, 401);
  const outstanding = await download();
  assert.equal((await send('/api/auth/logout', owner.token, {})).status, 200);
  assert.equal((await send(outstanding)).status, 401);
  assert.equal((await send('/api/auth/logout', worker.token, {})).status, 200);
  assert.equal((await send('/api/checkout', worker.token)).status, 401);
});

test('only the owner can request a registered thumbnail; state, journal and employee reads omit pixel bytes', async t => {
  const { send } = await fixture(t);
  const owner = await (await send('/api/auth/setup', null, { name:'Fotoğraf sahibi', password:'example-owner-photo-2026' })).json();
  const employee = await (await send('/api/auth/employees', owner.token, { name:'Çalışan', password:'example-worker-photo-2026' })).json();
  const worker = await (await send('/api/auth/login', null, { id:employee.id, password:'example-worker-photo-2026' })).json();
  const initial = await (await send('/api/state', owner.token)).json(), date = '2026-11-10';
  const opening = { type:'opening', date, balances:Object.fromEntries(initial.accounts.filter(a=>!a.retired).map(a=>[a.id,a.id==='saat'?'1':'0'])) };
  assert.equal((await send('/api/command',owner.token,{id:'open-photo',revision:0,command:opening})).status,200);
  const pixels = Buffer.alloc(96*96*3, 137).toString('base64');
  const photo = { version:1, pixels };
  const command = { type:'registerItem',date,accountId:'saat',code:'S-1',photo };
  for (const invalid of [{version:2,pixels},{...photo,pixels:pixels.slice(1)}, {...photo,pixels:pixels.slice(0,-1)+'_'}, {...photo,url:'file:///bad'}]) {
    assert.equal((await send('/api/command',owner.token,{id:'reg-photo',revision:1,command:{...command,photo:invalid}})).status,400);
  }
  const saved = await send('/api/command',owner.token,{id:'reg-photo',revision:1,command});
  assert.equal(saved.status,200);
  const result = await saved.json();
  assert.equal(result.state.inventoryItems[0].hasPhoto,true);
  assert.ok(!JSON.stringify(result).includes(pixels));
  for (const route of ['state','state?view=compact','journal']) assert.ok(!(await (await send('/api/'+route,owner.token)).text()).includes(pixels));
  const route = '/api/item-photo?code=S-1';
  assert.equal((await send(route,null)).status,401);
  assert.equal((await send(route,worker.token)).status,403);
  const response=await send(route,owner.token);
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),photo);
  assert.equal((await send('/api/item-photo?code=UNKNOWN',owner.token)).status,404);
});
test('successful restores revoke all sessions and tickets; unsuccessful restore keeps the actor authorized', async t => {
  const {send} = await fixture(t);
  const credentials={name:'Sahip',password:'sentetik-restore-parola-2026'};
  let owner=await (await send('/api/auth/setup',null,credentials)).json();
  const id=owner.actor.id;
  const employee=await (await send('/api/auth/employees',owner.token,{name:'Çalışan',password:credentials.password})).json();
  for(const format of ['json','archive']){
    const worker=await (await send('/api/auth/login',null,{id:employee.id,password:credentials.password})).json();
    const state=await (await send('/api/state',owner.token)).json();
    const ticket=await (await send('/api/download-ticket',owner.token,{operation:'backup'})).json();
    const backup=await (await send('/api/backup',owner.token)).json();
    const invalid=await send('/api/restore',owner.token,{backup,revision:state.revision+1,confirmation:'GERİ YÜKLE'});
    assert.equal(invalid.status,409);
    assert.equal((await send('/api/auth/session',worker.token)).status,200);
    let response;
    if(format==='json') response=await send('/api/restore',owner.token,{backup,revision:state.revision,confirmation:'GERİ YÜKLE'});
    else{
      const archive=await send('/api/archive',owner.token);
      response=await fetch(new URL('/api/archive/restore?'+new URLSearchParams({revision:String(state.revision),confirmation:'GERİ YÜKLE'}),archive.url),
        {method:'POST',headers:{Authorization:'Bearer '+owner.token,'Content-Type':'application/x-ndjson'},body:await archive.text()});
    }
    assert.equal(response.status,200);
    assert.equal((await send('/api/auth/session',owner.token)).status,401);
    assert.equal((await send('/api/checkout',worker.token)).status,401);
    assert.equal((await send(ticket.url,null)).status,401);
    assert.equal((await response.json()).reauthenticate,true);
    owner=await (await send('/api/auth/login',null,{id,password:credentials.password})).json();
    assert.equal((await send('/api/state',owner.token)).status,200);
  }
});
test('logging out while NDJSON is staging prevents commit and preserves another owner session', async t => {
  const {send,dataDirectory,repositories}=await fixture(t);
  const credentials={name:'Sahip',password:'sentetik-stream-parola-2026'};
  const owner=await (await send('/api/auth/setup',null,credentials)).json();
  const observer=await (await send('/api/auth/login',null,{id:owner.actor.id,password:credentials.password})).json();
  const archive=await send('/api/archive',owner.token), lines=(await archive.text()).trimEnd().split('\n');
  const url=new URL('/api/archive/restore?'+new URLSearchParams({revision:'0',confirmation:'GERİ YÜKLE'}),archive.url);
  let request;
  const upload=new Promise((resolve,reject)=>{
    request=httpRequest(url,{method:'POST',headers:{Authorization:'Bearer '+owner.token,'Content-Type':'application/x-ndjson'}},response=>{
      response.resume();response.once('end',()=>resolve(response.statusCode));
    });
    request.once('error',reject);
    request.write(lines.slice(0,-1).join('\n')+'\n');
  });
  const dir=join(dataDirectory,'.archive-temp'), deadline=Date.now()+5000;
  try {
    while (Date.now()<deadline && !(existsSync(dir)&&readdirSync(dir,{recursive:true}).some(p=>p.endsWith('stage.sqlite')))) {
      await new Promise(r=>setTimeout(r,20));
    }
    assert.ok(existsSync(dir)&&readdirSync(dir,{recursive:true}).some(p=>p.endsWith('stage.sqlite')));
    assert.equal((await send('/api/auth/logout',owner.token,{})).status,200);
  } finally { request.end(lines.at(-1)+'\n'); }
  assert.equal(await upload,401);
  assert.equal(repositories.get('demo').state().revision,0);
  assert.equal((await send('/api/state',observer.token)).status,200);
});

test('employee retail supports mixed native consideration and zero-balance customer creation without broad access', async t => {
  const {send,repositories}=await fixture(t);
  const owner=await (await send('/api/auth/setup',null,{name:'Retail owner',password:'retail-owner-password-2026'})).json();
  const employee=await (await send('/api/auth/employees',owner.token,{name:'Retail worker',password:'retail-worker-password-2026'})).json();
  const worker=await (await send('/api/auth/login',null,{id:employee.id,password:'retail-worker-password-2026'})).json();
  const initial=await (await send('/api/state',owner.token)).json(),date='2026-11-10';
  const balances=Object.fromEntries(initial.accounts.filter(a=>!a.retired).map(a=>[a.id,({ceyrek:'5',nakit:'1000',usd:'100',hurda22:'3'})[a.id]||'0']));
  assert.equal((await send('/api/command',owner.token,{id:'retail-open',revision:0,command:{type:'opening',date,balances}})).status,200);
  const customer={type:'account',date,name:'Yeni müşteri',unit:'TL',partyType:'customer',opening:'0',phone:'555 000',address:'Deneme'};
  const create={id:'worker-customer',revision:1,command:customer};
  for(const duplicate of [false,true]){
    const response=await send('/api/command',worker.token,create);
    assert.equal(response.status,200,await response.clone().text());
    assert.deepEqual(await response.json(),{id:create.id,revision:2,duplicate,account:{id:'cari-worker-customer',name:customer.name,unit:'TL'}});
  }
  assert.equal((await send('/api/command',owner.token,create)).status,400);
  for(const changed of [{opening:'1'},{opening:'-1'},{partyType:'supplier'},{parentAccountId:'cari-worker-customer'},{role:'owner'},{kind:'asset'},{balances:{nakit:'10'}}]){
    const response=await send('/api/command',worker.token,{id:'bad-customer',revision:2,command:{...customer,...changed}});
    assert.equal(response.status,403,JSON.stringify(changed));
  }
  const id='cari-worker-customer';
  const sale={type:'sale',date,counterpartyType:'customer',counterpartyId:id,items:[{accountId:'ceyrek',quantity:'1',value:'100'}],
    received:[{accountId:'usd',quantity:'1',valueTL:'40'},{accountId:'hurda22',quantity:'0.1',valueTL:'30'},{accountId:'nakit',quantity:'50'}],
    given:[{accountId:'nakit',quantity:'10'}],credits:[{accountId:id,quantity:'20'}],debts:[{accountId:id,quantity:'30'}]};
  let response=await send('/api/command',worker.token,{id:'retail-sale',revision:2,command:sale});
  assert.equal(response.status,200,await response.clone().text());
  assert.deepEqual(await response.json(),{id:'retail-sale',revision:3,duplicate:false});
  const purchase={type:'purchase',source:'customer',date,counterpartyType:'customer',counterpartyId:id,items:[{accountId:'hurda22',quantity:'0.2',value:'100'}],
    received:[{accountId:'nakit',quantity:'10'}],given:[{accountId:'usd',quantity:'1',valueTL:'40'},{accountId:'nakit',quantity:'50'}],
    credits:[{accountId:id,quantity:'10'}],debts:[{accountId:id,quantity:'30'}]};
  response=await send('/api/command',worker.token,{id:'retail-purchase',revision:3,command:purchase});
  assert.equal(response.status,200,await response.clone().text());
  const detail=await (await send('/api/customers?id='+id,worker.token)).json();
  assert.deepEqual(detail,{id,name:customer.name,phone:customer.phone,taxId:'',address:customer.address,accounts:[{id,name:customer.name,unit:'TL',balance:-3000}]});
  const state=await (await send('/api/state',owner.token)).json();
  assert.equal(state.balances.nakit,100000);
  assert.equal(state.balances.usd,10000);
  assert.equal(state.balances.hurda22,3300);
  assert.equal(state.balances.ceyrek,4);
  assert.equal(state.journal.find(e=>e.id===create.id).actor.id,employee.id);
  for(const bad of [{...sale,credits:[{accountId:'another-customer',quantity:'20'}]},
    {...sale,received:[{accountId:'nakit',quantity:'-1'}]},
    {...sale,received:[{accountId:'hurda22',quantity:'1',valueTL:'100',inventoryCode:'ignored'}]},
    {...purchase,items:[{...purchase.items[0],inventoryCode:'ignored'}]}]){
    response=await send('/api/command',worker.token,{id:'bad-trade',revision:4,command:bad});
    assert.ok([400,403].includes(response.status),await response.clone().text());
  }
  assert.equal((await send('/api/customers?id=nakit',worker.token)).status,403);
  assert.equal((await send('/api/state',worker.token)).status,403);
  assert.equal((await send('/api/checkout',worker.token)).status,200);
  const checkout=await (await send('/api/checkout',worker.token)).json();
  assert.equal(checkout.revision,4);
  assert.ok(checkout.stocks.every(a=>['GRAM','ADET'].includes(a.unit)));
  assert.ok(checkout.payments.every(a=>!Object.hasOwn(a,'quantity') && !Object.hasOwn(a,'balance')));
  assert.equal(checkout.stocks.find(a=>a.id==='hurda22').quantity,3300);
  const repo=[...repositories.values()][0];
  assert.equal(repo.backup().events.find(e=>e.id===create.id).audit.actor.id,employee.id);
});
