import { appendHistoricalEvent } from '../test-support/historical-supplier.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS, replay, decimal, applyEvent } from '../domain.mjs';
const date = '2026-10-28';
const run = (r,id,c) => ((c.replacement||c).source==='supplier'||(c.replacement||c).counterpartyType==='supplier')&&!r.events().some(e=>e.id===id)
  ? appendHistoricalEvent(r,id,{date,...c})
  : r.execute({id,revision:r.state().revision,command:{date,...c}});
function fixture(t) {
  const r = new Repository(':memory:', 'exchange-test'); t.after(() => r.close());
  run(r, 'opening', { type: 'opening', banks: [], balances: Object.fromEntries(INITIAL_ACCOUNTS.filter(a=>!a.retired).map(a=>[a.id, ({nakit:'1000',usd:'10',ceyrek:'10',bilezikAdet:'2',bilezik22:'20',hurda22:'3'})[a.id] || '0'])) });
  run(r, 'supplier', { type:'account', name:'Synthetic supplier',unit:'HAS',opening:'0',partyType:'supplier' });
  return r;
}
const sale = {type:'sale',items:[{accountId:'ceyrek',quantity:'1',value:'100'}],received:[{accountId:'nakit',quantity:'150'}],given:[{accountId:'nakit',quantity:'50'}],credits:[],debts:[]};
function rejected(r,id,c) { const before=r.state(), events=r.events(); assert.throws(()=>run(r,id,c));assert.deepEqual(r.state(),before);assert.deepEqual(r.events(),events); }
test('manual sale change and supplier purchase HAS preserve independent native balances and exact reverse', t=>{
  const r=fixture(t),before=r.state().balances;
  run(r,'sale',sale);assert.equal(r.state().balances.nakit,110000);assert.equal(r.state().balances.ceyrek,9);assert.equal(r.events().at(-1).schemaVersion,6);
  run(r,'reverse',{type:'reverse',originalId:'sale',note:'Synthetic cancellation'});assert.deepEqual(r.state().balances,before);
  run(r,'buy',{type:'purchase',source:'supplier',counterpartyId:'cari-supplier',counterpartyType:'supplier',items:[{accountId:'ceyrek',quantity:'1',value:'500'}],received:[],given:[{accountId:'nakit',quantity:'200'}],debts:[{accountId:'cari-supplier',quantity:'0.125',valueTL:'300'}],credits:[]});
  assert.equal(r.state().balances['cari-supplier'],-125);assert.equal(r.state().balances.nakit,80000);assert.equal(r.state().balances.ceyrek,11);
  assert.deepEqual(replay(r.events()).balances,r.state().balances);
});
test('stock counterlegs keep measured pairing; supplied values cannot bypass quantities, roles or equation',t=>{
  const r=fixture(t);
  run(r,'paired',{...sale,received:[{accountId:'bilezikAdet',quantity:'1',weightAccount:'bilezik22',weight:'4.123',valueTL:'150'}],given:[{accountId:'nakit',quantity:'50'}]});
  assert.equal(r.state().balances.bilezikAdet,3);assert.equal(r.state().balances.bilezik22,24123);
  for(const [id,c] of [
    ['missing-weight',{...sale,received:[{accountId:'bilezikAdet',quantity:'1',valueTL:'100'}],given:[]}],
    ['pos-out',{...sale,given:[{accountId:'pos',quantity:'50'}]}],
    ['legacy-mix',{...sale,payments:[]}],
    ['null',{...sale,received:null}],
    ['unbalanced',{...sale,given:[]}],
    ['overflow',{...sale,received:[{accountId:'nakit',quantity:'10000000000.01'}]}],
    ['wrong-party',{...sale,counterpartyId:'cari-supplier',credits:[{accountId:'cari-supplier',quantity:'1',valueTL:'100'}]}]
  ]) rejected(r,id,c);
});
test('v6 amendment, original-product return and duplicate requests survive backup restore',t=>{
  const r=fixture(t);run(r,'sale',sale);
  const replacement={...sale,received:[{accountId:'nakit',quantity:'160'}],given:[{accountId:'nakit',quantity:'60'}]};
  run(r,'amend',{type:'amend',originalId:'sale',replacement,note:'Synthetic corrected tender'});
  const before=r.state();assert.equal(run(r,'amend',{type:'amend',originalId:'sale',replacement,note:'Synthetic corrected tender'}).duplicate,true);assert.deepEqual(r.state(),before);
  run(r,'return',{type:'saleReturn',originalId:'amend',items:[{lineIndex:0,quantity:'1',value:'100'}],refunds:[{accountId:'nakit',quantity:'100'}],note:'Synthetic product return'});
  assert.equal(r.state().balances.ceyrek,10);assert.equal(r.state().balances.nakit,100000);
  const restored=new Repository(':memory:','exchange-test');t.after(()=>restored.close());restored.restore({backup:r.backup(),revision:0,confirmation:'GERİ YÜKLE'});
  assert.deepEqual(restored.events(),r.events());
  assert.deepEqual(restored.state().balances,r.state().balances);
  assert.deepEqual(restored.state().journal,r.state().journal);
});
test('new close requires six daily scrap counts; old close and stocktake remain replayable',t=>{
  const r=fixture(t),s=r.state();
  for(const id of ['hurda8','hurda14','hurda18','hurda21','hurda22','hurda24']) assert.equal(s.accounts.find(a=>a.id===id).countPolicy,'daily');
  const counts=Object.fromEntries(s.accounts.filter(a=>a.physical&&!a.retired&&a.countPolicy==='daily').map(a=>[a.id,decimal(s.balances[a.id]||0,a.unit)]));
  const close={type:'close',counts,reasons:{},approvedBy:'Synthetic operator',nextDate:'2026-10-30'};
  const missing={...counts};delete missing.hurda8;rejected(r,'missing',{...close,counts:missing});
  rejected(r,'periodic',{type:'stocktake',counts:{hurda22:'3'},reasons:{},approvedBy:'Synthetic operator'});
  const oldCounts={...counts};for(const id of ['hurda8','hurda14','hurda18','hurda21','hurda22','hurda24'])delete oldCounts[id];
  const old=replay([...r.events(),{id:'old-close',schemaVersion:4,timestamp:'2026-10-28T10:00:00Z',command:{date,...close,counts:oldCounts}}]);assert.equal(old.date,'2026-10-30');
  const stock=applyEvent(replay(r.events()),{id:'old-stock',schemaVersion:3,timestamp:'2026-10-28T10:00:00Z',command:{date,type:'stocktake',counts:{hurda22:'3'},reasons:{},approvedBy:'Synthetic operator'}});assert.equal(stock.stocktakes.length,1);
  run(r,'close',close);assert.equal(r.events().at(-1).schemaVersion,6);assert.equal(r.state().date,'2026-10-30');
});
test('supplier gold settlement closes native HAS debt without sale revenue and supports amend/reverse/restore',t=>{
  const r=fixture(t);
  run(r,'buy',{type:'purchase',source:'supplier',counterpartyId:'cari-supplier',items:[{accountId:'ceyrek',quantity:'1',value:'500'}],received:[],given:[],debts:[{accountId:'cari-supplier',quantity:'1',valueTL:'500'}]});
  const settlement={type:'collection',counterpartyId:'cari-supplier',counterpartyType:'supplier',received:[],given:[{accountId:'hurda22',quantity:'2',valueTL:'300'}],credits:[{accountId:'cari-supplier',quantity:'0.600',valueTL:'300'}],debts:[]};
  run(r,'settle',settlement);assert.equal(r.state().balances['cari-supplier'],-400);assert.equal(r.state().balances.hurda22,1000);assert.equal(r.state().journal.at(-1).meta.revenue,0);
  rejected(r,'too-much',{...settlement,credits:[{accountId:'cari-supplier',quantity:'0.601',valueTL:'300'}]});
  const replacement={...settlement,given:[{accountId:'hurda22',quantity:'1',valueTL:'200'}],credits:[{accountId:'cari-supplier',quantity:'0.400',valueTL:'200'}]};
  run(r,'amend-settle',{type:'amend',originalId:'settle',replacement,note:'Synthetic manual settlement correction'});
  assert.equal(r.state().balances['cari-supplier'],-600);assert.equal(r.state().balances.hurda22,2000);
  const restored=new Repository(':memory:','exchange-test');t.after(()=>restored.close());restored.restore({backup:r.backup(),revision:0,confirmation:'GERİ YÜKLE'});assert.deepEqual(restored.state().balances,r.state().balances);
  run(r,'undo-settle',{type:'reverse',originalId:'amend-settle',note:'Synthetic reversal'});assert.equal(r.state().balances['cari-supplier'],-1000);assert.equal(r.state().balances.hurda22,3000);
  assert.deepEqual(replay(r.events()).balances,r.state().balances);
});
test('historical v5 ignores formerly unknown exchange fields without changing original cash semantics',t=>{
  const r=fixture(t);
  const event={id:'legacy-sale',schemaVersion:5,timestamp:'2026-10-28T12:00:00Z',command:{date,type:'sale',items:[{accountId:'ceyrek',quantity:'1',value:'100'}],payments:[{accountId:'nakit',quantity:'100'}],credits:[],scrap:[],received:[{accountId:'usd',quantity:'9',valueTL:'999'}]}};
  const state=replay([...r.events(),event]);assert.equal(state.balances.nakit,110000);assert.equal(state.balances.usd,1000);assert.equal(state.balances.ceyrek,9);
});
