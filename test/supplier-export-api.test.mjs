import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server.mjs';
import {authenticateTestOwner,ownerFetch} from '../test-support/editor-session.mjs';
test('offline PDF assets and explicit lightweight supplier query are routed without new write endpoints',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'supplier-export-'));
 const {server,repositories}=createApp({dataDirectory:directory,logger:()=>{}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});rmSync(directory,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+server.address().port;
 await authenticateTestOwner(server);
 for(const path of ['/supplier-pdf.js','/vendor/pdfmake/pdfmake.min.js','/vendor/pdfmake/vfs_fonts.js']){
   const response=await ownerFetch(base+path);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/javascript/);assert.ok((await response.text()).length>100);
 }
 await ownerFetch(base+'/api/state?workspace=demo');
 const repo=repositories.get('demo');let options;repo.supplierDetail=value=>{options=value;return {};};
 assert.equal((await ownerFetch(base+'/api/suppliers?workspace=demo&supplierId=f')).status,200);assert.equal(options.includeDocuments,true);
 assert.equal((await ownerFetch(base+'/api/suppliers?workspace=demo&supplierId=f&documents=omit')).status,200);assert.equal(options.includeDocuments,false);
 assert.equal((await ownerFetch(base+'/api/suppliers?workspace=demo&supplierId=f&documents=false')).status,400);
});
