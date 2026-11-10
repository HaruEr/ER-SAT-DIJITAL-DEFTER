import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const walk = dir => readdirSync(dir,{withFileTypes:true}).flatMap(entry => {
  if (['node_modules','.git','data','.local','.synthetic'].includes(entry.name)) return [];
  const path = join(dir,entry.name);
  return entry.isDirectory() ? walk(path) : /\.(mjs|js)$/.test(path) ? [path] : [];
});
let count=0;
for (const file of walk('.')) {
  const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8',windowsHide:true});
  if(result.status!==0){console.error(file,result.stderr);process.exitCode=1;}
  count++;
}
console.log(`Syntax checked: ${count} JavaScript files`);
