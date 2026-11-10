import { appendHistoricalEvent } from '../test-support/historical-supplier.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS, decimal, workdaySummary } from '../domain.mjs';

function temporaryDirectory(t) {
  const root = resolve(tmpdir());
  const directory = mkdtempSync(join(root, 'defter-recovery-drill-'));
  t.after(() => {
    assert.equal(dirname(resolve(directory)), root);
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
function execute(repo, id, command) {
  return (command.source==='supplier'?appendHistoricalEvent(repo,id,command):repo.execute({ id, revision: repo.state().revision, command })).state;
}
function opening(nakit = '100000') {
  const balances = Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, '0']));
  Object.assign(balances, { nakit, banka: '50000', usd: '200', bilezikAdet: '20', bilezik22: '1205', gramToplam: '243' });
  return { type: 'opening', date: '2026-10-27', balances };
}
function inspectInNewProcess(filename) {
  const moduleUrl = new URL('../repository.mjs', import.meta.url).href;
  const source = `import {Repository} from ${JSON.stringify(moduleUrl)};
    const repo = new Repository(process.argv[1], 'dukkan');
    try { const state = repo.state(); console.log(JSON.stringify({date:state.date,balances:state.balances,events:repo.events(),sha256:repo.backup().sha256})); }
    finally { repo.close(); }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, filename], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('disk recovery drill preserves original units, closed-day summary and previous history across process restart', t => {
  const directory = temporaryDirectory(t);
  const sourceFile = join(directory, 'source.sqlite'), targetFile = join(directory, 'target.sqlite');
  const source = new Repository(sourceFile, 'dukkan');
  let snapshot, backup, summary;
  try {
    execute(source, 'opening-source', opening());
    execute(source, 'supplier-usd', { type: 'account', date: '2026-10-27', name: 'Sentetik USD tedarikçi', unit: 'USD', opening: '0' });
    execute(source, 'purchase-drill', { type: 'purchase', date: '2026-10-27', source: 'supplier',
      items: [{ accountId: 'bilezikAdet', quantity: '1', weightAccount: 'bilezik22', weight: '20.220', value: '10000' }],
      payments: [{ accountId: 'nakit', quantity: '7000', valueTL: '7000' }],
      debts: [{ accountId: 'cari-supplier-usd', quantity: '100', valueTL: '3000' }], note: 'Sentetik yedek kurtarma tatbikatı' });
    const state = source.state();
    execute(source, 'closing-drill', { type: 'close', date: state.date, approvedBy: 'Sentetik test', reasons: {},
      counts: Object.fromEntries(state.accounts.filter(a => a.physical && !a.retired && a.countPolicy === 'daily').map(a => [a.id, decimal(state.balances[a.id], a.unit)])) });
    snapshot = source.state(); backup = source.backup(); summary = workdaySummary(snapshot, '2026-10-27');
    const exportFile = join(directory, 'external-copy.json');
    writeFileSync(exportFile, JSON.stringify(backup), { encoding: 'utf8', flag: 'wx', flush: true });
    backup = JSON.parse(readFileSync(exportFile, 'utf8'));
  } finally { source.close(); }
  const independent = inspectInNewProcess(sourceFile);
  assert.equal(independent.sha256, backup.sha256);
  assert.deepEqual(independent.events, backup.events);
  assert.deepEqual(independent.balances, snapshot.balances);
  assert.equal(independent.date, '2026-10-28');

  const target = new Repository(targetFile, 'dukkan');
  try {
    execute(target, 'previous-target-opening', opening('1'));
    const previous = target.events();
    const restored = target.restore({ backup, revision: target.state().revision, confirmation: 'GERİ YÜKLE' });
    assert.deepEqual(restored.balances, snapshot.balances);
    assert.equal(restored.balances['cari-supplier-usd'], -10000);
    assert.equal(restored.balances.bilezikAdet, 21);
    assert.equal(restored.balances.bilezik22, 1225220);
    assert.deepEqual(workdaySummary(restored, '2026-10-27'), summary);
    const archive = target.db.prepare('SELECT body FROM restore_archive').all();
    assert.equal(archive.length, 1);
    assert.deepEqual(JSON.parse(archive[0].body).events, previous);
    assert.equal(Object.values(target.db.prepare('PRAGMA integrity_check').get())[0], 'ok');
  } finally { target.close(); }
  const restarted = inspectInNewProcess(targetFile);
  assert.deepEqual(restarted, independent);
});

test('disk drill rejects damaged and wrong-workspace backups without changing active history or archive', t => {
  const directory = temporaryDirectory(t), filename = join(directory, 'target.sqlite');
  const target = new Repository(filename, 'dukkan');
  let before;
  try {
    execute(target, 'opening-target', opening()); before = target.backup();
    const damaged = structuredClone(before); damaged.events[0].command.balances.nakit = '1';
    for (const backup of [damaged, { ...before, workspace: 'demo' }]) {
      assert.throws(() => target.restore({ backup, revision: 1, confirmation: 'GERİ YÜKLE' }));
      assert.deepEqual(target.events(), before.events);
      assert.equal(target.state().revision, 1);
      assert.equal(target.db.prepare('SELECT count(*) AS n FROM restore_archive').get().n, 0);
    }
  } finally { target.close(); }
  const restarted = inspectInNewProcess(filename);
  assert.equal(restarted.sha256, before.sha256);
  assert.deepEqual(restarted.events, before.events);
});
