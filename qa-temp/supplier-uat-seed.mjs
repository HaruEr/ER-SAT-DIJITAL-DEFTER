// Disposable UAT prerequisites, never a production migration or acceptance result.
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {Repository} from '../repository.mjs';
import {IdentityStore} from '../identity.mjs';
import {INITIAL_ACCOUNTS,currentCountPolicy,decimal} from '../domain.mjs';
import {appendHistoricalEvent} from '../test-support/historical-supplier.mjs';
const root=resolve(tmpdir());
const directory=mkdtempSync(join(root,'supplier-uat-v1-'));
const r=new Repository(join(directory,'demo.sqlite'),'demo');
const write=(id,c)=>r.execute({id,revision:r.state().revision,command:{date:r.state().date||'2026-11-09',...c}});
write('uat-opening',{type:'opening',balances:Object.fromEntries(INITIAL_ACCOUNTS.filter(a=>!a.retired).map(a=>[a.id,a.id==='nakit'?'5000000':a.id==='banka'?'1000000':['USD','EUR'].includes(a.unit)?'100000':a.unit==='ADET'?'1000':a.unit==='GRAM'?'10000':'0']))});
appendHistoricalEvent(r,'uat-legacy',{type:'account',date:'2026-11-09',name:'UAT Eski Firma',partyType:'supplier',unit:'TL',opening:'100'});
const firms={};
function firm(code,units=['HAS']){
 write(code,{type:'supplierFirm',name:'UAT '+code});
 const supplierId='supplier-'+code,accounts={};
 for(const unit of units){const id=code+'-'+unit;write(id,{type:'supplierUnit',supplierId,unit});accounts[unit]='supplier-unit-'+id;}
 return firms[code]={supplierId,accounts};
}
function buy(code,id,amount,quantity='10',unit='HAS'){
 const f=firms[code];write(id,{type:'supplierPurchase',supplierId:f.supplierId,items:[{accountId:'ceyrek',quantity}],charges:[{accountId:f.accounts[unit],quantity:amount}],agreementId:id});
}
function pay(code,id,amount,unit='HAS',scope='general',agreementId){
 const f=firms[code];write(id,{type:'supplierPayment',supplierId:f.supplierId,given:[{accountId:'nakit',quantity:'100'}],credits:[{accountId:f.accounts[unit],quantity:amount}],advanceScope:scope,...(agreementId?{agreementId}:{})});
}
firm('E07');buy('E07','E07-closed-purchase','10');
firm('F05',['HAS']);
const s=r.state();write('uat-close',{type:'close',approvedBy:'Sentetik UAT kurulumu',counts:Object.fromEntries(s.accounts.filter(a=>!a.retired&&a.physical&&currentCountPolicy(a)==='daily').map(a=>[a.id,decimal(s.balances[a.id]||0,a.unit)])),reasons:{}});
write('F05-new-EUR',{type:'supplierUnit',supplierId:firms.F05.supplierId,unit:'EUR'});
for(const code of ['B02','B03','B04','B05','B06','C01','C02','C03','C04','C05','C06','C07','D01','D02','D03','D04','D05','D06','D07','E01','E02','E03','E04','E05','E06'])firm(code,['HAS','USD','TL','SILVER']);
for(const code of ['C03','C04','C06'])buy(code,code+'-purchase','20');
pay('B06','B06-advance','10');
for(let i=1;i<=3;i++)buy('D01','D01-purchase-'+i,'5');pay('D01','D01-payment','15');
buy('D02','D02-purchase','15');for(let i=1;i<=3;i++)pay('D02','D02-payment-'+i,'5');
for(const code of ['D03','D04','D07']){buy(code,code+'-purchase','10');pay(code,code+'-payment','10');}
write('D04-link',{type:'supplierAllocation',supplierId:firms.D04.supplierId,allocations:[{sourceId:'D04-payment',purchaseId:'D04-purchase',accountId:firms.D04.accounts.HAS,quantity:'10'}]});
buy('D05','D05-purchase','10');pay('D05','D05-usd-source','100','USD');
buy('D06','D06-other-order','10');pay('D06','D06-reserved','10','HAS','reserved','RESERVED-ORDER');
for(const code of ['E01','E02','E03','E04','E05','E06'])buy(code,code+'-purchase','10');
pay('E04','E04-payment','10');write('E04-link',{type:'supplierAllocation',supplierId:firms.E04.supplierId,allocations:[{sourceId:'E04-payment',purchaseId:'E04-purchase',accountId:firms.E04.accounts.HAS,quantity:'10'}]});
write('E03-return',{type:'supplierReturn',supplierId:firms.E03.supplierId,originalId:'E03-purchase',items:[{lineIndex:0,quantity:'10'}],credits:[{accountId:firms.E03.accounts.HAS,quantity:'10'}],reductions:[{accountId:firms.E03.accounts.HAS,quantity:'10'}],note:'UAT önkoşulu tam iade'});
write('E06-reverse',{type:'supplierReverse',originalId:'E06-purchase',note:'UAT önkoşulu iptal'});
firm('A03',['HAS','USD','SILVER']);
buy('A03','A03-has','264.150','1');buy('A03','A03-usd','9998.39','1','USD');pay('A03','A03-ag','1402.080','SILVER');
const state=r.state();writeFileSync(join(directory,'uat-baseline.json'),JSON.stringify({version:'supplier-uat-v1',date:state.date,revision:state.revision,firms,balances:state.balances},null,2));r.close();
const identities=new IdentityStore(directory),password=randomBytes(24).toString('base64url');
const owner=await identities.initializeOwner({name:'UAT Yönetici',password});
const session=await identities.login(owner.id,password);await identities.createEmployee(session.token,{name:'UAT Çalışan',password});identities.close();
console.log(JSON.stringify({directory,version:'supplier-uat-v1',revision:state.revision,password}));
