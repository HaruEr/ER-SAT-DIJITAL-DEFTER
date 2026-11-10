import {performance} from 'node:perf_hooks';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {Repository} from '../repository.mjs';
import {INITIAL_ACCOUNTS,currentCountPolicy,eventVersion} from '../domain.mjs';

const root=resolve(tmpdir());

const directory=mkdtempSync(join(tmpdir(),'supplier-performance-'));
const repo=new Repository(join(directory,'synthetic.sqlite'),'performance');
const write=(id,command)=>repo.execute({id,revision:repo.state().revision,command});
const date='2026-11-10',supplierId='supplier-firm',accountId='supplier-unit-unit';
write('opening',{type:'opening',date,balances:Object.fromEntries(INITIAL_ACCOUNTS.filter(a=>!a.retired).map(a=>[a.id,a.id==='nakit'?'20000':'0']))});
write('firm',{type:'supplierFirm',date,name:'Sentetik 10000 olay'});
write('unit',{type:'supplierUnit',date,supplierId,unit:'TL'});
const backup=repo.backup();
for(let i=0;i<10000;i++){
  if(i===5000){
    const command={type:'close',date,approvedBy:'Sentetik ölçüm',reasons:{},counts:Object.fromEntries(INITIAL_ACCOUNTS.filter(a=>!a.retired&&a.physical&&currentCountPolicy(a)==='daily').map(a=>[a.id,a.id==='ceyrek'?'5000':a.id==='nakit'?'20000':'0']))};
    backup.events.push({id:'close-half',schemaVersion:eventVersion(command,repo.state()),timestamp:'2026-11-10T20:00:00Z',command});
  }
  backup.events.push({id:'purchase-'+i,schemaVersion:17,timestamp:'2026-11-10T10:00:00Z',command:{type:'supplierPurchase',date:i<5000?date:'2026-11-11',supplierId,items:[{accountId:'ceyrek',quantity:'1'}],charges:[{accountId,quantity:'1'}]}});
}
backup.sha256=createHash('sha256').update(JSON.stringify(backup.events)).digest('hex');
const start=performance.now();repo.restore({backup,revision:repo.state().revision,confirmation:'GERİ YÜKLE'});const setupMs=performance.now()-start;
const query={supplierId,limit:50,includeDocuments:false};
const coldStart=performance.now(),first=repo.supplierDetail(query),coldMs=performance.now()-coldStart;
assert.equal(first.total,10002);assert.equal(first.events.length,50);
const state=repo.state();assert.equal(state.balances.ceyrek,10000);assert.equal(state.balances.nakit,2000000);assert.equal(state.balances[accountId],-1000000);
const full=repo.supplierDetail({supplierId,limit:50});assert.equal(full.documents.purchases.length,10000);assert.equal(full.documents.sources.length,0);
assert.equal(full.documents.purchases.reduce((n,p)=>n+p.charges[0].remaining,0),1000000);
const collect=()=>{let page=repo.supplierDetail(query),ids=new Set(),pages=0;const revision=page.revision,total=page.total;while(true){assert.equal(page.revision,revision);assert.equal(page.total,total);for(const e of page.events){assert.ok(!ids.has(e.id));ids.add(e.id);}pages++;if(!page.nextCursor)break;page=repo.supplierDetail({...query,cursor:page.nextCursor});}assert.equal(ids.size,10002);assert.equal(pages,201);return ids.size;};
const operations={first50:()=>assert.equal(repo.supplierDetail(query).events.length,50),next50:()=>assert.equal(repo.supplierDetail({...query,cursor:first.nextCursor}).events.length,50),filtered50:()=>{const p=repo.supplierDetail({...query,startDate:'2026-11-11',endDate:'2026-11-11'});assert.equal(p.total,5000);assert.equal(p.statements[0].opening,-500000);assert.equal(p.statements[0].closing,-1000000);},fullStatement:collect};
const results={baseline:'ff0e532 lean on 98b8420',directory,eventCount:10000,setupMs,coldMs,node:process.version,platform:process.platform,measurements:{}};
for(const[name,fn]of Object.entries(operations)){
  console.log('warming '+name);fn();const samples=[];
  for(let i=0;i<5;i++){const t=performance.now();fn();samples.push(performance.now()-t);console.log(name+' sample'+(i+1)+' '+samples.at(-1).toFixed(1)+'ms');}
  const sorted=[...samples].sort((a,b)=>a-b),limitMs=name==='fullStatement'?10000:2000;
  results.measurements[name]={samples,medianMs:sorted[2],maxMs:sorted[4],limitMs,pass:sorted[4]<=limitMs};
}
repo.close();writeFileSync(join(directory,'supplier-performance-results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
if(Object.values(results.measurements).some(r=>!r.pass))process.exitCode=1;
