import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
const git = args => execFileSync('git', args, {encoding:'utf8',maxBuffer:64*1024*1024,windowsHide:true});
const denied = /(^|\/)(data|\.local|node_modules|source-backups|evidence|\.playwright-mcp)(\/|$)|(^|\/)\.env(\.|$)|\.(sqlite(?:-wal|-shm)?|db|log|pem|pfx|key)$/i;
const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/,
  /\bTR\d{24}\b/,
  /[A-Z]:[\\/]Users[\\/][^\s'"\\/]+/i
];
let checked=0, failures=[];
function inspect(path, bytes, context) {
  checked++;
  if(denied.test(path) && !path.endsWith('.env.example')) failures.push(`${context}: forbidden path ${path}`);
  if(bytes.subarray(0,16).toString().startsWith('SQLite format 3')) failures.push(`${context}: SQLite ${path}`);
  const text=bytes.toString('utf8');
  if(patterns.some(pattern=>pattern.test(text))) failures.push(`${context}: sensitive pattern in ${path}`);
}
const files=git(['ls-files','-z']).split('\0').filter(Boolean);
if(!files.length) throw new Error('Stage the exact publication allowlist before checking.');
for(const path of files){
  if(lstatSync(path).isSymbolicLink()) failures.push(`symlink: ${path}`);
  else inspect(path,readFileSync(path),'working tree');
}
for(const entry of git(['ls-files','--stage','-z']).split('\0').filter(Boolean)) {
  const [meta,path]=entry.split('\t'),[mode,oid,stage]=meta.split(' ');
  if(stage!=='0'||!['100644','100755'].includes(mode)) failures.push(`index unsupported entry: ${path}`);
  else inspect(path,execFileSync('git',['cat-file','blob',oid],{maxBuffer:64*1024*1024,windowsHide:true}),'index');
}
let commits=[];
try{commits=git(['rev-list','--all']).trim().split('\n').filter(Boolean);}catch{}
const seen=new Set();
for(const commit of commits){
  const entries=git(['ls-tree','-r','-z',commit]).split('\0').filter(Boolean);
  for(const entry of entries){
    const [meta,path]=entry.split('\t'),[mode,type,oid]=meta.split(' ');
    if(mode!=='100644' && mode!=='100755') failures.push(`history unsupported mode: ${path}`);
    if(type!=='blob')continue;
    const key=path+':'+oid;if(seen.has(key))continue;seen.add(key);
    inspect(path,execFileSync('git',['cat-file','blob',oid],{maxBuffer:64*1024*1024,windowsHide:true}),'history');
  }
}
console.log(JSON.stringify({files:files.length,commits:commits.length,checked,failures},null,2));
if(failures.length)process.exitCode=1;
// Pattern scans supplement manual review; they cannot prove absence of all PII.
