// Synthetic-only fresh process reader. No writable repository or clock/provider claims.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReportRepository } from '../report-repository.mjs';
import { validatePilotParent } from './synthetic-encrypted-backup-pilot.mjs';

export function inspectSyntheticRestoredDatabase(filename) {
  if(typeof filename!=='string')throw new Error('SYNTHETIC_READER_PATH_REJECTED');
  const absolute=resolve(filename),directory=dirname(absolute);
  validatePilotParent(directory);
  if(basename(directory)!=='restored-database'||!/^encrypted-backup-pilot-[a-zA-Z0-9]+$/.test(basename(dirname(directory)))
      ||!absolute.endsWith('.sqlite')||!existsSync(absolute)||!lstatSync(absolute).isFile()||lstatSync(absolute).isSymbolicLink()
      ||realpathSync(absolute).toLowerCase()!==absolute.toLowerCase())throw new Error('SYNTHETIC_READER_PATH_REJECTED');
  const repo=new ReportRepository(absolute,'demo');
  try {
    const view=repo.overview();
    const expected={bilezikAdet:9,bilezik22:89000,ceyrek:1,nakit:950000,'cari-buyer':20000};
    const balances=Object.fromEntries(Object.keys(expected).map(id=>[id,view.accounts.find(account=>account.id===id)?.balance]));
    assert.deepEqual(balances,expected);assert.equal(view.date,'2026-10-28');assert.equal(view.revision,1);
    const previousRevenue=repo.summary('2026-10-27').totals.sales,currentRevenue=repo.summary('2026-10-28').totals.sales;
    assert.equal(previousRevenue,100000);assert.equal(currentRevenue,-40000);
    const integrity=Object.values(repo.db.prepare('PRAGMA integrity_check').get())[0];assert.equal(integrity,'ok');
    const events=repo.db.prepare('SELECT body FROM events ORDER BY seq').all().map(row=>JSON.parse(row.body));
    return {verified:true,pid:process.pid,integrity,date:view.date,revision:view.revision,balances,previousRevenue,currentRevenue,
      eventsHash:createHash('sha256').update(JSON.stringify(events)).digest('hex')};
  } finally {repo.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    if(process.argv.length!==3)throw new Error('SYNTHETIC_READER_ARGUMENT_REJECTED');
    console.log(JSON.stringify(inspectSyntheticRestoredDatabase(process.argv[2])));
  } catch {console.error('SYNTHETIC_READER_FAILED');process.exitCode=1;}
}
