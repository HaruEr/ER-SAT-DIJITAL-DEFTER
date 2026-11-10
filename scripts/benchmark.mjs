import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS } from '../domain.mjs';

// Synthetic histories only: this command never opens the data directory.
// Bulk insertion builds fixtures; its duration is not a transaction benchmark.
const sizes = process.argv.slice(2).length ? process.argv.slice(2).map(Number) : [1000, 10000, 50000];
if (sizes.some(size => !Number.isInteger(size) || size < 1 || size > 100000)) {
  throw new Error('Her örnek için 1–100000 arasında tam sayı olay adedi belirtin.');
}
function medianDuration(callback) {
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    callback();
    samples.push(performance.now() - start);
  }
  return Number(samples.sort((a, b) => a - b)[2].toFixed(1));
}
const results = [];
for (const size of sizes) {
  const repo = new Repository(':memory:', 'benchmark');
  try {
    const balances = Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, '0']));
    const insert = repo.db.prepare('INSERT INTO events(id,body) VALUES(?,?)');
    repo.db.exec('BEGIN');
    for (let i = 0; i < size; i++) {
      const command = i === 0 ? { type: 'opening', date: '2026-10-27', balances }
        : { type: 'movement', date: '2026-10-27', accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '0.01', note: 'Sentetik performans ölçümü' };
      const event = { id: `benchmark-${i}`, schemaVersion: 3, timestamp: '2026-10-27T12:00:00Z', command };
      insert.run(event.id, JSON.stringify(event));
    }
    repo.db.exec('COMMIT');
    assert.equal(repo.state().balances.nakit, size - 1);
    const stateMs = medianDuration(() => repo.state());
    const backupMs = medianDuration(() => repo.backup());
    const start = performance.now();
    const result = repo.execute({ id: 'benchmark-final', revision: 0, command: { type: 'movement', date: '2026-10-27', accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '0.01', note: 'Sentetik son işlem' } });
    const commandMs = Number((performance.now() - start).toFixed(1));
    assert.equal(result.state.balances.nakit, size);
    results.push({ events: size, stateMedianMs: stateMs, backupMedianMs: backupMs, singleCommandMs: commandMs });
  } finally { repo.close(); }
}
console.log('Bellek içi sentetik ölçüm: durum/yedek 5 örneğin medyanı, komut tek örnek. Disk ve tarayıcı gecikmesini kapsamaz.');
console.table(results);
