import test from 'node:test';
import assert from 'node:assert/strict';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS, decimal, replay, workdaySummary } from '../domain.mjs';
import { ReportRepository } from '../report-repository.mjs';
import { createReadStream, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const day = '2026-10-28';
const execute = (repo, id, command) => repo.execute({ id, revision: repo.state().revision, command: { date: repo.state().date || day, ...command } });
function fixture(t) {
  const repo = new Repository(':memory:', 'demo');t.after(()=>repo.close());
  const balances = Object.fromEntries(INITIAL_ACCOUNTS.filter(a=>!a.retired).map(a=>[a.id,'0']));
  Object.assign(balances,{nakit:'1000',gramToplam:'10'});
  execute(repo,'opening',{type:'opening',date:day,balances});return repo;
}
const sale = (price='100') => ({type:'sale',items:[{accountId:'gramToplam',quantity:'1',value:price}],payments:[{accountId:'nakit',quantity:price}],credits:[],scrap:[],note:''});
function close(repo, id='close') {
  const state=repo.state();
  execute(repo,id,{type:'close',counts:Object.fromEntries(state.accounts.filter(a=>a.physical&&!a.retired&&a.countPolicy==='daily').map(a=>[a.id,decimal(state.balances[a.id]||0,a.unit)])),reasons:{},approvedBy:'Sentetik denetim'});
}

test('review: a prior-day note-only amendment does not invent cash receipts and payments today', t=>{
  const repo=fixture(t);execute(repo,'sale',sale());close(repo);
  const before=repo.state();
  execute(repo,'amend',{type:'amend',originalId:'sale',replacement:{...sale(),note:'Yalnız açıklama düzeltildi'},note:'Yazım düzeltmesi'});
  assert.deepEqual(repo.state().balances,before.balances);
  assert.equal(workdaySummary(repo.state(),day).totals.sales,10000,'Closed-day history remains intact');
  assert.deepEqual({incoming:repo.state().moneyFlow.incoming,outgoing:repo.state().moneyFlow.outgoing},{incoming:0,outgoing:0},'No cash moved when only a prior-day note changed');
  assert.deepEqual(replay(repo.events()).balances,repo.state().balances);
});

test('review: prior-day price correction shows only the actual net payment, including repeated edits', t=>{
  const repo=fixture(t);execute(repo,'sale',sale());close(repo);
  execute(repo,'amend',{type:'amend',originalId:'sale',replacement:sale('90'),note:'Fazla tutar düzeltildi'});
  assert.equal(repo.state().balances.nakit,109000);
  assert.deepEqual({incoming:repo.state().moneyFlow.incoming,outgoing:repo.state().moneyFlow.outgoing},{incoming:0,outgoing:1000});
  execute(repo,'amend-again',{type:'amend',originalId:'amend',replacement:sale('80'),note:'Tutar yeniden düzeltildi'});
  assert.equal(repo.state().balances.nakit,108000);
  assert.deepEqual({incoming:repo.state().moneyFlow.incoming,outgoing:repo.state().moneyFlow.outgoing},{incoming:0,outgoing:2000});
});

test('review: an accepted optional undefined profile field cannot produce an unreplayable stored event', t=>{
  const repo=fixture(t);
  execute(repo,'optional-profile',{type:'account',name:'Sentetik müşteri',unit:'TL',opening:'0',phone:undefined});
  assert.doesNotThrow(()=>repo.backup(),'Successful commands must remain valid after JSON persistence omits undefined fields');
  assert.deepEqual(replay(repo.events()).balances,repo.state().balances);
});

test('review: journal search finds the named payee of a fully paid purchase',t=>{
  const repo=fixture(t);
  execute(repo,'person',{type:'account',name:'Özgün Müşteri',unit:'TL',opening:'0',partyType:'customer'});
  execute(repo,'paid-purchase',{type:'purchase',source:'customer',counterpartyId:'cari-person',items:[{accountId:'hurda14',quantity:'1',value:'100'}],payments:[{accountId:'nakit',quantity:'100'}],debts:[],note:''});
  assert.ok(repo.journalPage({scope:'all',q:'ozgun musteri'}).items.some(event=>event.id==='paid-purchase'),'Displayed payee name must be included in account-name search even without a debt entry');
});

test('review: amendment payment channel changes preserve native units across repeated edits and another closing', t=>{
  const repo=fixture(t);
  const foreign={...sale(),payments:[{accountId:'usd',quantity:'10',valueTL:'100'}]};
  execute(repo,'foreign-sale',foreign);close(repo);
  execute(repo,'channel-correction',{type:'amend',originalId:'foreign-sale',replacement:sale(),note:'Döviz yerine nakit'});
  assert.deepEqual(repo.state().moneyFlow.byUnit,{USD:{incoming:0,outgoing:1000},TL:{incoming:10000,outgoing:0}});
  execute(repo,'price-correction',{type:'amend',originalId:'channel-correction',replacement:sale('90'),note:'On TL iade'});
  assert.deepEqual(repo.state().moneyFlow.byUnit,{USD:{incoming:0,outgoing:1000},TL:{incoming:10000,outgoing:1000}});
  close(repo,'close-again');
  execute(repo,'next-day-channel',{type:'amend',originalId:'price-correction',replacement:{...sale('90'),payments:[{accountId:'usd',quantity:'9',valueTL:'90'}]},note:'Ertesi gün ödeme yöntemi değişti'});
  assert.deepEqual(repo.state().moneyFlow.byUnit,{TL:{incoming:0,outgoing:9000},USD:{incoming:900,outgoing:0}});
  const cached=repo.state();repo.db.exec('PRAGMA user_version=1');assert.deepEqual(repo.state(),cached,'Uncached replay must match incremental flow index');
});

test('review: report projection omits new personal fields and amendment payloads while archives preserve them', async()=>{
  const temporaryRoot=resolve(fileURLToPath(new URL('../qa-temp/',import.meta.url))),directory=mkdtempSync(join(temporaryRoot,'domain-review-'));
  const writer=new Repository(join(directory,'demo.sqlite'),'demo');
  let reader,target;
  try{
    const balances=Object.fromEntries(INITIAL_ACCOUNTS.filter(a=>!a.retired).map(a=>[a.id,'0']));Object.assign(balances,{nakit:'1000',gramToplam:'10'});
    execute(writer,'opening',{type:'opening',date:day,balances,banks:[{name:'Deneme Bankası',unit:'USD',opening:'5'}]});
    execute(writer,'person',{type:'account',name:'Sentetik Müşteri',unit:'TL',opening:'0',partyType:'customer',phone:'05551234567',taxId:'12345678901',address:'PRIVATE_ADDRESS_MARKER'});
    execute(writer,'sale',sale());execute(writer,'change',{type:'amend',originalId:'sale',replacement:sale('90'),note:'Bedel düzeltildi'});
    reader=new ReportRepository(join(directory,'demo.sqlite'),'demo');
    const responses=JSON.stringify([reader.overview(),reader.summary(day),reader.journal()]);
    for(const secret of ['05551234567','12345678901','PRIVATE_ADDRESS_MARKER','editableCommand','replacement'])assert.ok(!responses.includes(secret),secret);
    const filename=join(directory,'history.ndjson');writer.exportArchive(filename);
    target=new Repository(':memory:','demo');await target.restoreArchive(createReadStream(filename),{revision:0,confirmation:'GERİ YÜKLE',temporaryDirectory:directory});
    assert.deepEqual(target.state().accounts,writer.state().accounts);
    assert.deepEqual(target.state().balances,writer.state().balances);
    assert.deepEqual(target.state().moneyFlow,writer.state().moneyFlow);
    assert.deepEqual(target.events(),writer.events());
  }finally{reader?.close();target?.close();writer.close();assert.equal(dirname(resolve(directory)),temporaryRoot);rmSync(directory,{recursive:true,force:true});}
});
