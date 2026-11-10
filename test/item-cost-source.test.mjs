import test from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_ACCOUNTS, replay } from '../domain.mjs';
import { Repository } from '../repository.mjs';
import { checkoutState } from '../editor-access.mjs';
import { ReportRepository } from '../report-repository.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const date = '2026-11-10';
const source = { id:'p', lineIndex:0, amountTL:2537 };
function fixture(t, units = 1, linked = true, disk = false) {
  const dir = disk && mkdtempSync(join(tmpdir(),'cost-source-'));
  const filename = disk ? join(dir,'demo.sqlite') : ':memory:';
  const repo = new Repository(filename, 'demo');
  t.after(() => {
    repo.close();
    if (dir) rmSync(dir,{recursive:true,force:true});
  });
  const post = (id, command) => repo.execute({ id, revision:repo.state().revision, command:{date,...command} });
  const balances = Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id,'0']));
  post('opening', {type:'opening',balances:{...balances,nakit:'200'}});
  post('p',{ type:'purchase', source:'customer', items:[{accountId:'yuzuk',quantity:String(units),weightAccount:'taki14',weight:String(units * 3),value:'25.37'}], received:[],given:[{accountId:'nakit',quantity:'25.37'}],debts:[],credits:[] });
  post('reg',{type:'registerItem', code:'A1',accountId:'yuzuk',weightAccount:'taki14',actualWeight:'3',...(linked?{purchaseLine:{id:'p',lineIndex:0}}:{})});
  const cost = (id, value, extra) => post(id,{type:'itemCostSource',inventoryCode:'A1',source:value,...extra});
  return {repo,cost,post,filename};
}

test('owner expressly adopts one exact single-piece purchase line in kuruş, without new payment, reservation or stock entry', t => {
  const {repo,cost} = fixture(t);
  const before = repo.state();
  assert.equal(before.inventoryItems[0].costSource, undefined);
  assert.deepEqual(repo.state({compact:true}).inventoryItems[0].purchaseCostOffer,source);
  assert.doesNotMatch(JSON.stringify(checkoutState(repo.state({compact:true}))),/amountTL|costSource|purchaseCostOffer/);
  cost('link',source);
  assert.equal(cost('link',source).duplicate,true);
  const after = repo.state();
  assert.deepEqual(after.inventoryItems[0].costSource,source);
  assert.deepEqual(after.balances,before.balances);
  assert.deepEqual(after.inventoryReserved,before.inventoryReserved);
  assert.equal(after.inventoryItems[0].lastEventId,'reg');
  assert.deepEqual(after.journal.at(-1).entries,[]);
  assert.deepEqual(replay(repo.events()).inventoryItems,after.inventoryItems);
  assert.doesNotMatch(JSON.stringify(checkoutState(after)),/amountTL|costSource|purchaseCostOffer/);
  assert.throws(()=>cost('duplicate',source));
  assert.throws(()=>cost('empty-note',null));
  cost('clear',null,{note:'Kaynak seçimini kaldır'});
  assert.equal(repo.state().inventoryItems[0].costSource,undefined);
  assert.deepEqual(replay(repo.events()).inventoryItems,repo.state().inventoryItems);
});
test('refuses conflicting source, stale or ill-typed amount, unsupported payloads and released items', t => {
  const {repo,cost,post} = fixture(t);
  for (const other of [undefined,null,[],{}, {...source,id:'other'},{...source,lineIndex:1},{...source,amountTL:'2537'},{...source,amountTL:2537.1},{...source,amountTL:2538},{...source,amountTL:0},{...source,amountTL:Number.MAX_SAFE_INTEGER+1},{...source,rate:1}]) assert.throws(()=>cost('bad',other));
  assert.equal(repo.state().revision,3);
  post('release',{type:'releaseItem',inventoryCode:'A1',note:'Eşleme kaldır'});
  assert.throws(()=>cost('released',source));
});
for (const [units,linked] of [[2,true],[1,false]]) test('unknown item cost stays unknown with units='+units+' and linked='+linked, t => {
  const {repo,cost} = fixture(t,units,linked);
  assert.equal(repo.state({compact:true}).inventoryItems[0].purchaseCostOffer,undefined);
  assert.throws(()=>cost('bad',source));
  assert.equal(repo.state().inventoryItems[0].costSource,undefined);
});

test('mobile journal omits cost records, and reversing a source requires clearing its active cost link', t => {
  const {cost,post,filename} = fixture(t,1,true,true);
  cost('record',source);
  post('release',{type:'releaseItem',inventoryCode:'A1',note:'Eşlemeyi kaldır'});
  assert.throws(()=>post('duplicate-item',{type:'registerItem', code:'A2',accountId:'yuzuk',weightAccount:'taki14',actualWeight:'3',purchaseLine:{id:'p',lineIndex:0}}),/maliyet kaynağı/);
  const undo = {type:'reverse',originalId:'p',note:'Yanlış alış'};
  assert.throws(()=>post('undo',undo),/maliyet kaynağı/);
  cost('clear',null,{note:'OWNER-CLEAR-2537'});
  post('undo',undo);
  const report = new ReportRepository(filename);
  try {
    assert.doesNotMatch(JSON.stringify([report.journal(),report.overview(),report.summary(date)]),/OWNER-CLEAR|itemCostSource|costSource|purchaseCostOffer/);
  } finally { report.close(); }
});

test('checkout exposes an explicit scrap classification without leaking account internals', t => {
  const {repo}=fixture(t);
  const products=checkoutState(repo.state({compact:true})).products;
  assert.deepEqual(products.filter(p=>p.scrap).map(p=>p.id).sort(),
    ['hurda8','hurda14','hurda18','hurda21','hurda22','hurda24'].sort());
  assert.ok(products.every(p=>typeof p.scrap==='boolean'));
  assert.equal(products.find(p=>p.id==='yuzuk').scrap,false);
  assert.equal(products.find(p=>p.id==='gramToplam').scrap,false);
  assert.equal(products.find(p=>p.id==='hurda24').canBuy,true);
  assert.equal(products.find(p=>p.id==='hurda24').canSell,false);
  assert.ok(products.every(p=>!Object.hasOwn(p,'costSource') && !Object.hasOwn(p,'owner')));
});
