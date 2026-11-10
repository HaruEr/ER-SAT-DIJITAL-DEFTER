import test from 'node:test';
import assert from 'node:assert/strict';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS, currentCountPolicy, decimal, replay } from '../domain.mjs';
import { supplierDocuments } from '../supplier-ledger.mjs';

test('two later workdays explicitly settle one selected purchase without FIFO or duplicate physical effects', t => {
  const r=new Repository(':memory:','multiday');t.after(()=>r.close());
  const write=(id,command)=>r.execute({id,revision:r.state().revision,command:{date:r.state().date||'2026-11-10',...command}});
  const close=id=>{
    const s=r.state(),before={...s.balances};
    write(id,{type:'close',approvedBy:'Sentetik bağımsız kontrol',counts:Object.fromEntries(s.accounts.filter(a=>!a.retired&&a.physical&&currentCountPolicy(a)==='daily').map(a=>[a.id,decimal(s.balances[a.id]||0,a.unit)])),reasons:{}});
    assert.deepEqual(r.state().balances,before,'matching physical close changes no balances');
  };
  write('opening',{type:'opening',balances:Object.fromEntries(INITIAL_ACCOUNTS.filter(a=>!a.retired).map(a=>[a.id,a.id==='nakit'?'2000':'0']))});
  write('firm',{type:'supplierFirm',name:'Sentetik üç gün'});
  write('has',{type:'supplierUnit',supplierId:'supplier-firm',unit:'HAS'});
  const supplierId='supplier-firm',accountId='supplier-unit-has';
  for(const[id,quantity]of [['older','2'],['selected','10']])write(id,{type:'supplierPurchase',supplierId,items:[{accountId:'ceyrek',quantity:'1'}],charges:[{accountId,quantity}]});
  const day1=r.state();assert.equal(day1.balances[accountId],-12000);assert.equal(day1.balances.ceyrek,2);
  const future={type:'supplierPayment',supplierId,date:'2026-11-11',given:[{accountId:'nakit',quantity:'300'}],credits:[{accountId,quantity:'3'}],advanceScope:'general'};
  assert.throws(()=>write('future',future));assert.equal(r.events().some(e=>e.id==='future'),false);
  close('close1');assert.equal(r.state().date,'2026-11-11');
  write('payment2',future);
  const allocate=(id,sourceId,quantity)=>{
    const before={...r.state().balances};
    write(id,{type:'supplierAllocation',supplierId,allocations:[{sourceId,purchaseId:'selected',accountId,quantity}]});
    assert.deepEqual(r.state().balances,before,'metadata allocation has zero money/stock/cari effect');
    assert.deepEqual(r.state().journal.at(-1).entries,[]);
  };
  allocate('allocation2','payment2','3');
  let docs=supplierDocuments(r.state(),supplierId);
  assert.equal(docs.purchases.find(p=>p.id==='selected').charges[0].remaining,7000);
  assert.equal(docs.purchases.find(p=>p.id==='older').charges[0].remaining,2000);
  close('close2');assert.equal(r.state().date,'2026-11-12');
  write('payment3',{...future,date:'2026-11-12',given:[{accountId:'nakit',quantity:'700'}],credits:[{accountId,quantity:'7'}]});
  allocate('allocation3','payment3','7');
  docs=supplierDocuments(r.state(),supplierId);
  assert.equal(docs.purchases.find(p=>p.id==='selected').charges[0].remaining,0);
  assert.equal(docs.purchases.find(p=>p.id==='older').charges[0].remaining,2000,'no implicit FIFO to earlier purchase');
  assert.deepEqual(docs.sources.map(s=>[s.id,s.credits[0].remaining]),[['payment2',0],['payment3',0]]);
  assert.equal(r.state().balances.nakit,100000);assert.equal(r.state().balances.ceyrek,2);assert.equal(r.state().balances[accountId],-2000);
  assert.deepEqual(r.state().journal.filter(e=>['selected','payment2','allocation2','payment3','allocation3'].includes(e.id)).map(e=>[e.id,e.date]),[['selected','2026-11-10'],['payment2','2026-11-11'],['allocation2','2026-11-11'],['payment3','2026-11-12'],['allocation3','2026-11-12']]);
  const before={...r.state().balances},count=r.events().length;
  assert.throws(()=>allocate('reuse','payment2','1'));assert.deepEqual(r.state().balances,before);assert.equal(r.events().length,count);
  const replayed=replay(r.events());assert.deepEqual(replayed.balances,r.state().balances);assert.deepEqual(supplierDocuments(replayed,supplierId),docs);
});
