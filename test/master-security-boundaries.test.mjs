import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createApp } from '../server.mjs';
import { createReportApp } from '../report-server.mjs';

const origin='https://master-audit.synthetic-tailnet.ts.net';
async function fixture(t,report=false){
  const root=resolve(tmpdir()),directory=mkdtempSync(join(root,'master-security-'));
  const app=report?createReportApp({enabled:true,origin,allowedLogins:['reader@example.test'],dataDirectory:directory}):createApp({dataDirectory:directory});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>{app.server.close(r);app.server.closeAllConnections();});assert.equal(dirname(resolve(directory)),root);rmSync(directory,{recursive:true,force:true});});
  const port=app.server.address().port;
  const request=(path,method='GET',extra={},body)=>new Promise((resolveResponse,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port,path,method,agent:false,headers:{Host:report?new URL(origin).host:`127.0.0.1:${port}`,...(report?{'Tailscale-User-Login':'reader@example.test'}:{}),...extra}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolveResponse({status:res.statusCode,headers:res.headers,text:Buffer.concat(chunks).toString('utf8')}));});
    req.on('error',reject);req.end(method==='GET'?undefined:body);
  });
  return {app,directory,request,port};
}

test('master security: all editor data and restore routes reject proxy-marked requests before opening any ledger',async t=>{
  const {app,directory,request}=await fixture(t);
  for(const route of ['/api/state','/api/backup','/api/archive','/api/recovery','/api/command','/api/restore','/api/archive/restore']){
    for(const header of ['Forwarded','X-Forwarded-Host','X-Real-IP','Tailscale-User-Login']){
      const response=await request(route+'?workspace=dukkan',route.includes('restore')||route.endsWith('command')?'POST':'GET',{[header]:'synthetic-proxy','Content-Type':'application/json'},'{}');
      assert.equal(response.status,403,route+' '+header);
    }
  }
  assert.equal(app.repositories.size,0);assert.deepEqual(readdirSync(directory),[]);
});

test('master security: foreign and opaque origins cannot read or mutate editor ledgers',async t=>{
  const {app,directory,request}=await fixture(t);
  for(const origin of ['null','https://attacker.example','http://localhost:1'])for(const [path,method] of [['/api/state','GET'],['/api/command','POST'],['/api/restore','POST']]){
    assert.equal((await request(path,method,{Origin:origin,'Content-Type':'application/json'},'{}')).status,403);
  }
  assert.equal(app.repositories.size,0);assert.deepEqual(readdirSync(directory),[]);
});

test('master security: authenticated report reader cannot select writer or backup paths by method or path encoding',async t=>{
  const {app,directory,request}=await fixture(t,true);
  for(const path of ['/api/command','/api/restore','/api/archive/restore','/api/backup','/api/recovery','/data/demo.sqlite','/%2e%2e/repository.mjs']){
    assert.equal((await request(path)).status,404,path);
    assert.equal((await request(path,'POST',{'Content-Type':'application/json'},'{}')).status,405,path);
  }
  for(const path of ['/api/reports/overview?workspace=demo&workspace=dukkan','/api/reports/overview?unknown=1','/api/reports/summary?date=2026-10-28&date=2026-10-27'])assert.equal((await request(path)).status,400,path);
  assert.equal(app.repositories.size,0);assert.deepEqual(readdirSync(directory),[]);
});

test('master security: both static surfaces retain no-store, anti-framing, nosniff and no external script policy',async t=>{
  for(const report of [false,true]){
    const {request}=await fixture(t,report),response=await request('/');
    assert.equal(response.status,200);assert.equal(response.headers['cache-control'],'no-store');
    assert.equal(response.headers['x-content-type-options'],'nosniff');assert.equal(response.headers['referrer-policy'],'no-referrer');
    assert.match(response.headers['content-security-policy'],/script-src 'self'/);assert.match(response.headers['content-security-policy'],/frame-ancestors 'none'/);
    assert.doesNotMatch(response.text,/<script[^>]+src=["']https?:/i);
  }
});
