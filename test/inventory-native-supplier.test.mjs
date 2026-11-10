import test from 'node:test';
import assert from 'node:assert/strict';
import {applyEvent,emptyState,eventVersion,INITIAL_ACCOUNTS,replay} from '../domain.mjs';
import {purchaseCostOffer} from '../inventory.mjs';
const date='2026-11-10';
function fixture(){
  let state=emptyState();const events=[];
  const write=(id,command)=>{command={date,...command};const event={id,command,schemaVersion:eventVersion(command,state)};state=applyEvent(state,event);events.push(event);return state;};
  write('opening',{type:'opening',balances:Object.fromEntries(INITIAL_ACCOUNTS.filter(a=>!a.retired).map(a=>[a.id,a.id==='yuzuk'?'2':a.id==='taki14'?'10':'0']))});
  write('firm',{type:'supplierFirm',name:'Sentetik firma'});write('unit',{type:'supplierUnit',supplierId:'supplier-firm',unit:'HAS'});
  const buy=(id,qty='2',weight='8')=>write(id,{type:'supplierPurchase',supplierId:'supplier-firm',items:[{accountId:'yuzuk',quantity:qty,weightAccount:'taki14',weight,referenceTL:'5000'}],charges:[{accountId:'supplier-unit-unit',quantity:'5'}]});
  const ret=(id,qty='1',weight='3')=>write(id,{type:'supplierReturn',supplierId:'supplier-firm',originalId:'buy',items:[{lineIndex:0,quantity:qty,weight}],credits:[{accountId:'supplier-unit-unit',quantity:'1'}],reductions:[],note:'Sentetik ürün iadesi'});
  const register=(id,weight='5')=>write(id,{type:'registerItem',code:id,accountId:'yuzuk',weightAccount:'taki14',actualWeight:weight,purchaseLine:{id:'buy',lineIndex:0}});
  return {write,buy,ret,register,events,get state(){return state;}};
}
function rejects(f,fn){const prior=structuredClone(f.state);assert.throws(fn);assert.deepEqual(f.state,prior);}

test('native supplier purchase supports exact serialized source with unknown cost despite optional TL reference',()=>{
  const f=fixture();f.buy('buy');f.register('ring1','3');f.register('ring2','5');
  assert.deepEqual(f.state.inventoryItems[0].purchaseLine,{id:'buy',lineIndex:0});
  assert.equal(purchaseCostOffer(f.state.inventoryItems[0],f.state.journal.find(e=>e.id==='buy')),null);
  rejects(f,()=>f.register('third','1'));
  rejects(f,()=>f.write('cost',{type:'itemCostSource',inventoryCode:'RING1',source:{id:'buy',lineIndex:0,amountTL:500000}}));
  rejects(f,()=>f.write('reverse',{type:'supplierReverse',originalId:'buy',note:'Bağlı ürün var'}));
  assert.deepEqual(replay(f.events),f.state);
});

test('new item source respects quantities and actual grams remaining after partial native supplier return',()=>{
  const f=fixture();f.buy('buy');f.ret('return');
  rejects(f,()=>f.register('wrongweight','3'));
  f.register('remaining','5');
  rejects(f,()=>f.register('extra','1'));
  assert.deepEqual(replay(f.events),f.state);
});

test('return cannot mask a purchase-linked serialized item with unrelated free aggregate inventory',()=>{
  const f=fixture();f.buy('buy');f.register('linked','5');
  // Total stock has another two opening pieces/10g, but this document only has
  // one unassigned piece/3g left. Its linked piece cannot be returned by proxy.
  rejects(f,()=>f.ret('masked','2','8'));
  rejects(f,()=>f.ret('masked-weight','1','4'));
  f.ret('remaining','1','3');
  rejects(f,()=>f.ret('linked-return','1','5'));
  f.write('release',{type:'releaseItem',inventoryCode:'LINKED',note:'Tekil eşleme kaldırıldı'});
  f.ret('released-return','1','5');
  assert.deepEqual(replay(f.events),f.state);
});

test('reversed supplier purchase cannot be a new item source and amended replacement is independently usable',()=>{
  const f=fixture();f.buy('buy','1','3');
  f.write('undo',{type:'supplierReverse',originalId:'buy',note:'İptal'});
  rejects(f,()=>f.register('old','3'));
  f.buy('new','1','3');
  f.write('edit',{type:'supplierAmend',originalId:'new',replacement:{type:'supplierPurchase',supplierId:'supplier-firm',items:[{accountId:'yuzuk',quantity:'1',weightAccount:'taki14',weight:'4'}],charges:[{accountId:'supplier-unit-unit',quantity:'4'}]},note:'Gerçek gram düzeltildi'});
  rejects(f,()=>f.write('oldref',{type:'registerItem',code:'oldref',accountId:'yuzuk',weightAccount:'taki14',actualWeight:'3',purchaseLine:{id:'new',lineIndex:0}}));
  f.write('newref',{type:'registerItem',code:'newref',accountId:'yuzuk',weightAccount:'taki14',actualWeight:'4',purchaseLine:{id:'edit',lineIndex:0}});
  assert.deepEqual(replay(f.events),f.state);
});
