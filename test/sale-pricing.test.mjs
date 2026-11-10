import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadStream, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from '../repository.mjs';
import { ReportRepository } from '../report-repository.mjs';
import { INITIAL_ACCOUNTS, replay } from '../domain.mjs';

const date = '2026-11-10';
function setup(t, file = ':memory:') {
  const repo = new Repository(file, 'demo');
  t.after(() => repo.close());
  const balances = Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, '0']));
  balances.ceyrek = '4';
  const execute = (id, command) => repo.execute({ id, revision: repo.state().revision, command: {date, ...command} });
  execute('opening', {type:'opening', balances});
  return {repo,execute};
}
function sale() {
  return {type:'sale',items:[{accountId:'ceyrek',quantity:'1',value:'100'}, {accountId:'ceyrek',quantity:'1',value:'150'}],
    received:[{accountId:'nakit',quantity:'250',valueTL:'250'}],given:[],credits:[],debts:[],counterpartyType:'customer',
    salePricing:{version:1,lines:[{quotedTL:'120',source:'Etiket',components:[{label:'Etiket bedeli',amountTL:'125'},{label:'İndirim',amountTL:'-5'}],costTL:'0'},null]}};
}
const snapshot = {quotedTL:12000,source:'Etiket',components:[{label:'Etiket bedeli',amountTL:12500},{label:'İndirim',amountTL:-500}],costKnown:true,costTL:0};
test('line price and explicit zero cost are independent of realized sale and receipts', t => {
  const {repo,execute} = setup(t);
  const command = sale(); execute('sale',command);
  const event=repo.events().at(-1), record=repo.state().journal.at(-1);
  assert.equal(event.schemaVersion,10);
  assert.deepEqual(record.meta.lines[0].pricing,snapshot);
  assert.deepEqual(record.meta.lines[1].pricing,{costKnown:false});
  assert.equal(record.meta.costKnown,false);
  assert.equal(record.meta.revenue,25000);
  assert.deepEqual(record.meta.lines.map(l=>l.value),[10000,15000]);
  assert.deepEqual([repo.state().balances.ceyrek,repo.state().balances.nakit],[2,25000]);
  assert.equal(execute('sale',command).duplicate,true);
  const changed=structuredClone(command);changed.salePricing.lines[0].costTL='10';
  assert.throws(()=>execute('sale',changed),/aynı işlem anahtarı/i);
  assert.equal(repo.events().length,2);
});
test('invalid price metadata rejects the whole sale without moving balances or revision', t => {
  const {repo,execute}=setup(t), before=repo.state();
  const invalid=[null,{version:2,lines:[null,null]},{version:1,lines:[]},{version:1,lines:[null,null]},
    ...[{costTL:null},{costTL:'-1'},{costTL:'1.001'},{source:''},{components:[{label:'',amountTL:'1'}]},
      {profitTL:'0'},{components:Array(13).fill({label:'x',amountTL:'1'})}].map(line=>({version:1,lines:[line,null]}))];
  for(const value of invalid){const command=sale();command.salePricing=value;assert.throws(()=>execute('bad',command));}
  assert.throws(()=>execute('bad',{...sale(),counterpartyType:'supplier'}));
  assert.throws(()=>execute('bad',{type:'movement',accountId:'nakit',quantity:'1',category:'Sermaye',direction:'in',salePricing:sale().salePricing}));
  assert.deepEqual(repo.state(),before);
});
test('legacy extra payload remains uninterpreted in historical sales and amendments',t=>{
  const {repo,execute}=setup(t), legacy=sale();delete legacy.salePricing;
  execute('sale',legacy);execute('fix',{type:'amend',originalId:'sale',note:'Düzeltme',replacement:legacy});
  const events=repo.events(), before=replay(events);
  events[1].command.salePricing={version:1,lines:[{costTL:'25'},null]};
  events[2].command.replacement.salePricing=events[1].command.salePricing;
  const after=replay(events);
  for(const state of [before,after])for(const entry of state.journal.filter(e=>e.type==='sale'))assert.equal(entry.meta.lines[0].pricing,undefined);
  assert.deepEqual(after.balances,before.balances);
});
test('price correction preserves original snapshot and amount, restores through both archives and stays private on reports',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'price-snapshot-')),file=join(directory,'source.sqlite');
  const {repo,execute}=setup(t,file), original=sale();execute('sale',original);
  const replacement=structuredClone(original);
  replacement.salePricing.lines[0]={source:'Manuel düzeltme',costTL:'87.43'};
  replacement.salePricing.lines[1]={costTL:'133.09'};
  execute('fix',{type:'amend',originalId:'sale',note:'Kayıtlı maliyet düzeltmesi',replacement});
  function check(target) {
    const state=target.state(),sales=state.journal.filter(e=>e.type==='sale');
    assert.deepEqual(sales[0].meta.lines[0].pricing,snapshot);
    assert.equal(sales[1].meta.lines[0].pricing.costTL,8743);
    assert.equal(sales[1].meta.costKnown,true);
    assert.equal(sales[1].editableCommand.salePricing.lines[1].costTL,'133.09');
    assert.deepEqual([state.balances.ceyrek,state.balances.nakit],[2,25000]);
  }
  check(repo);
  const reader=new ReportRepository(file,'demo');t.after(()=>reader.close());
  for(const response of [reader.overview(),reader.summary(date),reader.journal()])assert.doesNotMatch(JSON.stringify(response),/costTL|salePricing|8743|13309|Manuel düzeltme/);
  const restored = new Repository(':memory:','demo'); t.after(()=>restored.close());
  restored.restore({backup:repo.backup(),revision:0,confirmation:'GERİ YÜKLE'});check(restored);
  const archive=join(directory,'ledger.ndjson');repo.exportArchive(archive);
  await restored.restoreArchive(createReadStream(archive),{revision:restored.state().revision,confirmation:'GERİ YÜKLE',temporaryDirectory:directory});check(restored);
});
test('restore rejects an altered trade version even if the legacy payment fields could balance',t=>{
  const {repo,execute}=setup(t);execute('sale',sale());
  const events=repo.events(), event=events.at(-1);
  event.tradeVersion=3;delete event.command.credits;delete event.command.debts;Object.assign(event.command,{note:'Eski biçim',cash:'250',pos:'0',bank:'0',scrapQuantity:'0',scrapValue:'0'});
  assert.throws(()=>replay(events));
});
