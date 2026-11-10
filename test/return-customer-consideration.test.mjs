import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS, replay } from '../domain.mjs';
const date = '2026-11-10';
function setup(t, paid = false, unit = 'TL') {
  const repo=new Repository(':memory:','demo'); t.after(()=>repo.close());
  const send=(id,c)=>repo.execute({id,revision:repo.state().revision,command:{date,...c}});
  send('open',{type:'opening',balances:Object.fromEntries(INITIAL_ACCOUNTS.filter(a=>!a.retired).map(a=>[a.id,a.id==='ceyrek'?'8':a.id==='nakit'?'200':'0']))});
  for(const id of ['buyer','other']) send(id,{type:'account',name:id,unit,partyType:'customer',opening:'0'});
  const money={accountId:'nakit',quantity:'100',valueTL:'100'};
  const account={accountId:'cari-buyer',quantity:unit==='TL'?'100':'2',valueTL:'100'};
  send('sale',{type:'sale',items:[{accountId:'ceyrek',quantity:'4',value:'100'}],counterpartyId:account.accountId,counterpartyType:'customer',
    received:paid?[money]:[],given:[],credits:paid?[]:[account],debts:[]});
  return {repo,send};
}
function returns(rows, outgoing=[]) {
  return {type:'saleReturn',originalId:'sale',items:[{lineIndex:0,quantity:'1',value:'40'}],outgoing,customerConsideration:rows,note:'Tezgâhta anlaşılmış iade'};
}
const row=(action,quantity,valueTL=quantity)=>({action,accountId:'cari-buyer',quantity,valueTL});

test('return pays the agreed value in stock, cash and explicit debt reduction once',async t=>{
  const {repo,send}=setup(t);
  const command=returns([row('reduceDebt','25')],[{accountId:'nakit',quantity:'10',valueTL:'10'},{accountId:'ceyrek',quantity:'1',valueTL:'5'}]);
  const state=send('refund',command).state;
  assert.equal(state.balances['cari-buyer'],7500);
  assert.equal(state.balances.nakit,19000);
  assert.equal(state.balances.ceyrek,4);
  assert.equal(state.journal.at(-1).meta.returnTotal,4000);
  assert.equal(state.journal.at(-1).meta.customerConsideration[0].action,'reduceDebt');
  assert.equal(state.journal.find(e=>e.id==='sale').meta.revenue,10000);
  assert.equal(send('refund',command).duplicate,true);
  const before=repo.events();
  for(const bad of [returns([row('reduceDebt','76')]), returns([{...row('reduceDebt','40'),accountId:'cari-other'}]),returns([row('reduceDebt','39')]),returns([row('pretend','40')]),{...command,refunds:[]}]){
    assert.throws(()=>send('no',bad));assert.deepEqual(repo.events(),before);
  }
  const restored=new Repository(':memory:','demo');t.after(()=>restored.close());
  restored.restore({backup:repo.backup(),revision:0,confirmation:'GERİ YÜKLE'});
  assert.deepEqual(restored.events(),before);
  const temp=mkdtempSync(join(tmpdir(),'cari-return-'));t.after(()=>rmSync(temp,{recursive:true,force:true}));
  const file=join(temp,'ledger.ndjson');repo.exportArchive(file);
  await restored.restoreArchive(createReadStream(file),{revision:1,confirmation:'GERİ YÜKLE',temporaryDirectory:temp});
  assert.deepEqual(restored.state().balances,state.balances);
});

for (const exchange of [false,true]) test('serialized customer consideration preserves the returned and delivered identities, exchange='+exchange,t=>{
  const {repo,send}=setup(t);
  for(const code of ['OLD','NEW']) send('reg-'+code,{type:'registerItem',code,accountId:'ceyrek'});
  send('serial-sale',{type:'sale',counterpartyId:'cari-buyer',counterpartyType:'customer',items:[{accountId:'ceyrek',quantity:'1',value:'50',inventoryCode:'OLD'}],
    received:[],given:[],credits:[{accountId:'cari-buyer',quantity:'50',valueTL:'50'}],debts:[]});
  const prior=repo.state();
  const product={accountId:'ceyrek',quantity:'1',inventoryCode:'NEW'};
  const reduction=[row('reduceDebt','20')];
  const ret={...returns(reduction,[{...product,valueTL:'20'}]),originalId:'serial-sale'};
  const cmd=exchange?{type:'retailExchange',originalId:'serial-sale',returnItems:ret.items,newItems:[{...product,value:'20'}],received:[],refunds:[],customerConsideration:reduction,note:'Parça ve cari'}:ret;
  const delivered=send('settled',cmd).state;
  assert.equal(delivered.inventoryItems.find(p=>p.code==='OLD').status,'available');
  assert.equal(delivered.inventoryItems.find(p=>p.code==='NEW').status,exchange?'sold':'issued');
  assert.equal(delivered.balances['cari-buyer'],13000);
  assert.equal(delivered.balances.nakit,20000);
  const restored=send('undo',{type:exchange?'undoExchange':'reverse',originalId:'settled',note:'Yanlış karşılık'}).state;
  assert.deepEqual(restored.balances,prior.balances);
  for(const item of prior.inventoryItems) assert.equal(restored.inventoryItems.find(p=>p.code===item.code).status,item.status);
});

test('settled foreign sale can grant actual customer credit without cash or fabricated FX rate',t=>{
  const {repo,send}=setup(t,true,'USD');
  assert.throws(()=>send('refuse',returns([row('reduceDebt','1','40')])));
  const s=send('grant',returns([row('grantCredit','1.5','40')])).state;
  assert.equal(s.balances['cari-buyer'],-150);
  assert.equal(s.balances.nakit,30000);
  assert.equal(s.journal.at(-1).meta.customerConsideration[0].valueTL,4000);
  const reversed=send('undo',{type:'reverse',originalId:'grant',note:'Yanlış kayıt'}).state;
  assert.equal(reversed.balances['cari-buyer'],0);
  assert.equal(reversed.balances.ceyrek,4);
  send('grant-again',returns([row('grantCredit','1.5','40')]));
  send('payout',{type:'collection',counterpartyType:'customer',counterpartyId:'cari-buyer',received:[],given:[{accountId:'nakit',quantity:'40',valueTL:'40'}],
    credits:[{accountId:'cari-buyer',quantity:'1.5',valueTL:'40'}],debts:[]});
  assert.throws(()=>send('spent-undo',{type:'reverse',originalId:'grant-again',note:'Alacak kullanılmış'}));
  assert.equal(repo.state().balances['cari-buyer'],0);
});

test('exchange covers the actual difference with cash and original customer debt reduction',t=>{
  const {repo,send}=setup(t);
  const command={type:'retailExchange',originalId:'sale',returnItems:[{lineIndex:0,quantity:'1',value:'40'}],
    newItems:[{accountId:'ceyrek',quantity:'1',value:'10'}],received:[],refunds:[{accountId:'nakit',quantity:'10',valueTL:'10'}],
    customerConsideration:[row('reduceDebt','20')],note:'Fark nakit ve açık borçtan düşüm'};
  const before=repo.state(),state=send('exchange',command).state;
  assert.equal(state.balances.ceyrek,before.balances.ceyrek);
  assert.equal(state.balances.nakit,19000);
  assert.equal(state.balances['cari-buyer'],8000);
  assert.equal(repo.events().at(-1).schemaVersion,14);
  assert.equal(repo.state({compact:true}).overview.revenue,7000);
  assert.equal(send('exchange',command).duplicate,true);
  const reversed=send('undo-x',{type:'undoExchange',originalId:'exchange',note:'Yanlış değişim'}).state;
  assert.deepEqual(reversed.balances,before.balances);
});

test('classic cash sales retain the proven customer through a refund or exchange, while v13 replay stays unchanged', t => {
  const {repo,send}=setup(t,true);
  const sale={type:'sale',customerAccount:'cari-buyer',items:[{accountId:'ceyrek',quantity:'1',value:'40'}],cash:'40',pos:'0',bank:'0',scrapQuantity:'0',scrapValue:'0',note:'Peşin satış'};
  for(const id of ['old-1','old-2','old-3']) send(id,sale);
  const base={type:'retailExchange',returnItems:[{lineIndex:0,quantity:'1',value:'40'}],
    newItems:[{accountId:'ceyrek',quantity:'1',value:'40'}],received:[],refunds:[],note:'Eski kayıttan değişim'};
  const historical=repo.events();
  const old={id:'historical',schemaVersion:13,command:{...base,date,originalId:'old-1'}};
  assert.equal(replay([...historical,old]).journal.at(-1).meta.counterpartyId,'');
  const rep=send('exchange-named',{...base,originalId:'old-1'}).state;
  assert.equal(rep.journal.at(-1).meta.counterpartyId,'cari-buyer');
  assert.equal(repo.events().at(-1).schemaVersion,15);
  const credited=send('credit',{...returns([row('grantCredit','40')]),originalId:'old-2'}).state;
  assert.equal(credited.balances['cari-buyer'],-4000);
  const next=send('exchange-credit',{...base,originalId:'old-3',newItems:[{...base.newItems[0],value:'20'}],
    customerConsideration:[row('grantCredit','20')]}).state;
  assert.equal(next.journal.at(-1).meta.counterpartyId,'cari-buyer');
  assert.equal(next.balances['cari-buyer'],-6000);
  assert.deepEqual(replay(repo.events()).balances,next.balances);
  const restored=new Repository(':memory:','demo'); t.after(()=>restored.close());
  restored.restore({backup:repo.backup(),revision:0,confirmation:'GERİ YÜKLE'});
  assert.deepEqual(restored.state().journal,next.journal);
  const activity=repo.journalPage({scope:'all',accountId:'cari-buyer'}).items.map(e=>e.id);
  for (const id of ['old-1','exchange-named','credit','exchange-credit']) assert.ok(activity.includes(id),id);
  assert.throws(()=>replay([...historical,{...old,schemaVersion:15,command:{...old.command,originalId:'sale'}}]));
  send('late-sale',{...sale,customerAccount:'cari-later'});
  send('later',{type:'account',name:'Sonradan',partyType:'customer',unit:'TL',opening:'0'});
  assert.throws(()=>send('forged',{...returns([{...row('grantCredit','40'),accountId:'cari-later'}]),originalId:'late-sale'}));
});

for (const value of [60, 100, 160]) test('new return credit nets against debt and remains a distinct statement movement: '+value, t => {
  const {repo,send}=setup(t);
  const before=repo.state();
  const command=returns([row('grantCredit',String(value))]);
  command.items[0].value=String(value);
  const result=send('net-credit',command).state;
  assert.equal(result.balances['cari-buyer'],(100-value)*100);
  assert.equal(result.balances.nakit,before.balances.nakit);
  const event=result.journal.at(-1);
  assert.equal(event.meta.customerConsideration[0].action,'grantCredit');
  assert.equal(event.meta.customerConsideration[0].before,10000);
  assert.equal(event.meta.customerConsideration[0].after,(100-value)*100);
  assert.deepEqual(event.entries.filter(e=>e.accountId==='cari-buyer'),[{accountId:'cari-buyer',delta:-value*100}]);
  const statement=repo.accountStatement({accountId:'cari-buyer'});
  assert.equal(statement.closing,(100-value)*100);
  assert.equal(statement.outgoing,value*100);
  const history=repo.journalPage({accountId:'cari-buyer',scope:'all'});
  assert.equal(history.items.find(event=>event.id==='net-credit').meta.customerConsideration[0].action,'grantCredit');
  assert.equal(send('net-credit',command).duplicate,true);
  assert.deepEqual(replay(repo.events()).balances,result.balances);
  const restored=new Repository(':memory:','demo');t.after(()=>restored.close());
  restored.restore({backup:repo.backup(),revision:0,confirmation:'GERİ YÜKLE'});
  assert.deepEqual(restored.state().balances,result.balances);
  const undone=send('undo-net',{type:'reverse',originalId:'net-credit',note:'Yanlış iade'}).state;
  assert.deepEqual(undone.balances,before.balances);
});

test('only the new spendable credit portion must remain when reversing a return which crossed zero',t=>{
  const {repo,send}=setup(t);
  const command=returns([row('grantCredit','160')]);command.items[0].value='160';
  send('grant',command);
  send('payout',{type:'collection',counterpartyType:'customer',counterpartyId:'cari-buyer',received:[],
    given:[{accountId:'nakit',quantity:'60',valueTL:'60'}],credits:[{accountId:'cari-buyer',quantity:'60',valueTL:'60'}],debts:[]});
  const before=repo.events();
  assert.throws(()=>send('bad-undo',{type:'reverse',originalId:'grant',note:'Kullanılmış alacak'}));
  assert.deepEqual(repo.events(),before);
  send('undo-pay',{type:'reverse',originalId:'payout',note:'Ödeme geri alındı'});
  assert.equal(send('undo-grant',{type:'reverse',originalId:'grant',note:'İade geri alındı'}).state.balances['cari-buyer'],10000);
});
