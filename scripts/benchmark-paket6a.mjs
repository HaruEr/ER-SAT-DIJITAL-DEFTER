import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS, applyEvent, currentCountPolicy, emptyState } from '../domain.mjs';

const args = new Set(process.argv.slice(2));
const validateMixed = args.has('--validate-mixed');
const profileMixed = args.has('--profile-mixed');
const runAll = !validateMixed && !profileMixed && (args.size === 0 || args.has('--all'));
const run50k = runAll || args.has('--50k');
const run100k = runAll || args.has('--100k');
const runMixed = runAll || args.has('--mixed');

const tempRoot = process.env.TEMP || process.env.TMP || 'D:\\Antigravity-Projects\\_isolated_temp';

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const p95Idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return {
    samples: sorted.length,
    minMs: Number(sorted[0].toFixed(2)),
    medianMs: Number(median.toFixed(2)),
    p95Ms: Number(sorted[p95Idx].toFixed(2)),
    maxMs: Number(sorted[sorted.length - 1].toFixed(2))
  };
}

function measure(fn, count = 5) {
  const samples = [];
  for (let i = 0; i < count; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return stats(samples);
}

function insertEventsBulk(db, events) {
  const insert = db.prepare('INSERT INTO events(id,body) VALUES(?,?)');
  db.exec('BEGIN');
  for (const event of events) insert.run(event.id, JSON.stringify(event));
  db.prepare('UPDATE meta SET revision = ? WHERE id = 1').run(events.length);
  db.exec('COMMIT');
}

function buildBaselineEvents(customerCount, stockCount, totalEvents) {
  const date = '2026-11-01';
  const balances = Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, a.id === 'nakit' ? '100000' : '0']));
  const events = [
    { id: 'base-opening', schemaVersion: 3, timestamp: `${date}T09:00:00Z`, command: { type: 'opening', date, balances } }
  ];
  for (let i = 0; i < customerCount; i++) {
    events.push({
      id: `cust-${i}`,
      schemaVersion: 5,
      timestamp: `${date}T09:01:00Z`,
      command: { type: 'account', date, name: `Sentetik Müşteri ${i}`, unit: 'TL', opening: '0', phone: `0532${String(i).padStart(7, '0')}` }
    });
  }
  for (let i = 0; i < stockCount; i++) {
    events.push({
      id: `stk-${i}`,
      schemaVersion: 5,
      timestamp: `${date}T09:02:00Z`,
      command: { type: 'stockAccount', date, name: `Sentetik Stok ${i}`, unit: 'GRAM', countPolicy: 'periodic', opening: '10' }
    });
  }
  const remaining = totalEvents - events.length;
  for (let i = 0; i < remaining; i++) {
    events.push({
      id: `mov-${i}`,
      schemaVersion: 3,
      timestamp: `${date}T10:00:00Z`,
      command: { type: 'movement', date, accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '0.01', note: 'Sentetik hareket' }
    });
  }
  return events;
}

function buildMixedEvents({ days = 10, customers = 1000, stocks = 300, suppliers = 10, targetEvents = 20000 } = {}) {
  const events = [];
  const startDay = new Date('2026-10-01T00:00:00Z');
  const dayStr = idx => new Date(startDay.getTime() + idx * 86400000).toISOString().slice(0, 10);
  const d0 = dayStr(0);
  const balances = Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => {
    if (a.id === 'nakit') return [a.id, '5000000'];
    if (a.id === 'banka') return [a.id, '5000000'];
    if (a.id === 'ceyrek') return [a.id, '5000'];
    if (a.id === 'taki14') return [a.id, '50000'];
    return [a.id, '0'];
  }));
  events.push({ id: 'mix-opening', schemaVersion: 3, timestamp: `${d0}T08:00:00Z`, command: { type: 'opening', date: d0, balances } });

  const customerIds = [];
  for (let i = 0; i < customers; i++) {
    const id = `mix-cust-${i}`;
    events.push({
      id,
      schemaVersion: 5,
      timestamp: `${d0}T08:05:00Z`,
      command: { type: 'account', date: d0, name: `Karma Müşteri ${i} ÇŞĞÜÖİ`, unit: 'TL', opening: '0', phone: `0544${String(i).padStart(7, '0')}` }
    });
    customerIds.push(`cari-${id}`);
  }
  for (let i = 0; i < stocks; i++) {
    events.push({
      id: `mix-stk-${i}`,
      schemaVersion: 5,
      timestamp: `${d0}T08:10:00Z`,
      command: { type: 'stockAccount', date: d0, name: `Karma Stok ${i}`, unit: 'GRAM', countPolicy: 'periodic', opening: '100' }
    });
  }
  const supplierIds = [];
  const supplierHasIds = [];
  const supplierTlIds = [];
  for (let i = 0; i < suppliers; i++) {
    const fid = `mix-firm-${i}`;
    const supId = `supplier-${fid}`;
    events.push({ id: fid, schemaVersion: 17, timestamp: `${d0}T08:15:00Z`, command: { type: 'supplierFirm', date: d0, name: `Toptancı Firma ${i}` } });
    supplierIds.push(supId);
    const hasEv = `mix-unit-has-${i}`;
    events.push({ id: hasEv, schemaVersion: 17, timestamp: `${d0}T08:16:00Z`, command: { type: 'supplierUnit', date: d0, supplierId: supId, unit: 'HAS' } });
    supplierHasIds.push(`supplier-unit-${hasEv}`);
    const tlEv = `mix-unit-tl-${i}`;
    events.push({ id: tlEv, schemaVersion: 17, timestamp: `${d0}T08:17:00Z`, command: { type: 'supplierUnit', date: d0, supplierId: supId, unit: 'TL' } });
    supplierTlIds.push(`supplier-unit-${tlEv}`);
  }

  const dailyCountAccounts = INITIAL_ACCOUNTS.filter(a => !a.retired && a.physical && currentCountPolicy(a) === 'daily');
  const perDayTarget = Math.max(100, Math.floor((targetEvents - events.length - days * 2) / days));
  let seq = 0;
  let nakitBalance = 500000000; // in kurus (5,000,000 TL)
  let ceyrekBalance = 5000;
  let hurda22Balance = 0;

  for (let d = 0; d < days; d++) {
    const date = dayStr(d);
    const openSupplierPurchases = [];
    for (let j = 0; j < perDayTarget && events.length < targetEvents - (days - d) * 2; j++) {
      const idx = seq++;
      const mod = idx % 10;
      const custId = customerIds[idx % customerIds.length];
      const supIdx = idx % suppliers;
      const supId = supplierIds[supIdx];
      const supHasId = supplierHasIds[supIdx];
      const supTlId = supplierTlIds[supIdx];
      if (mod < 4) {
        // Retail sale (40%)
        events.push({
          id: `mix-sale-${idx}`,
          schemaVersion: 5,
          timestamp: `${date}T11:00:00Z`,
          command: {
            type: 'sale',
            date,
            items: [{ accountId: 'ceyrek', quantity: '1', value: '5500' }],
            payments: [{ accountId: 'nakit', quantity: '5000' }],
            credits: [{ accountId: custId, quantity: '500' }],
            scrap: [],
            note: `Satış ${idx}`
          }
        });
        nakitBalance += 500000;
        ceyrekBalance -= 1;
      } else if (mod < 6) {
        // Customer purchase (20%)
        events.push({
          id: `mix-pur-${idx}`,
          schemaVersion: 5,
          timestamp: `${date}T12:00:00Z`,
          command: {
            type: 'purchase',
            date,
            source: 'customer',
            counterpartyId: custId,
            items: [{ accountId: 'hurda22', quantity: '2', value: '3500' }],
            payments: [{ accountId: 'nakit', quantity: '3000' }],
            debts: [{ accountId: custId, quantity: '500' }],
            note: `Müşteri alış ${idx}`
          }
        });
        nakitBalance -= 300000;
        hurda22Balance += 2000;
      } else if (mod === 6) {
        // Supplier purchase (10%)
        const pid = `mix-spur-${idx}`;
        events.push({
          id: pid,
          schemaVersion: 17,
          timestamp: `${date}T13:00:00Z`,
          command: {
            type: 'supplierPurchase',
            date,
            supplierId: supId,
            items: [{ accountId: 'ceyrek', quantity: '2' }],
            charges: [{ accountId: supHasId, quantity: '3.200' }],
            note: `Toptancı alış ${idx}`
          }
        });
        ceyrekBalance += 2;
        openSupplierPurchases.push({ id: pid, supplierId: supId, hasAcc: supHasId, tlAcc: supTlId, remHas: 3200 });
      } else if (mod === 7) {
        // Supplier payment + allocation (10%)
        const target = openSupplierPurchases.pop();
        if (target) {
          const payId = `mix-spay-${idx}`;
          events.push({
            id: payId,
            schemaVersion: 17,
            timestamp: `${date}T14:00:00Z`,
            command: {
              type: 'supplierPayment',
              date,
              supplierId: target.supplierId,
              given: [{ accountId: 'nakit', quantity: '1000' }],
              credits: [{ accountId: target.hasAcc, quantity: '1.000' }],
              note: `Toptancı ödeme ${idx}`
            }
          });
          events.push({
            id: `mix-salloc-${idx}`,
            schemaVersion: 17,
            timestamp: `${date}T14:10:00Z`,
            command: {
              type: 'supplierAllocation',
              date,
              supplierId: target.supplierId,
              allocations: [{ sourceId: payId, purchaseId: target.id, accountId: target.hasAcc, quantity: '1.000' }],
              note: `Toptancı tahsis ${idx}`
            }
          });
          nakitBalance -= 100000;
          if (target.remHas > 1000) {
            events.push({
              id: `mix-sret-${idx}`,
              schemaVersion: 17,
              timestamp: `${date}T14:30:00Z`,
              command: {
                type: 'supplierReturn',
                date,
                supplierId: target.supplierId,
                originalId: target.id,
                items: [{ lineIndex: 0, quantity: '1' }],
                reductions: [{ accountId: target.hasAcc, quantity: '1.600' }],
                credits: [{ accountId: target.hasAcc, quantity: '1.600' }],
                note: `Kısmi iade ${idx}`
              }
            });
            ceyrekBalance -= 1;
          }
        } else {
          events.push({
            id: `mix-mov-${idx}`,
            schemaVersion: 3,
            timestamp: `${date}T14:00:00Z`,
            command: { type: 'movement', date, accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '100', note: 'Ek sermaye' }
          });
          nakitBalance += 10000;
        }
      } else {
        // Movement (20%)
        events.push({
          id: `mix-mov-${idx}`,
          schemaVersion: 3,
          timestamp: `${date}T15:00:00Z`,
          command: { type: 'movement', date, accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '10', note: `Hareket ${idx}` }
        });
        nakitBalance += 1000;
      }
    }
    if (d < days - 1) {
      const counts = Object.fromEntries(dailyCountAccounts.map(a => {
        if (a.id === 'nakit') return [a.id, (nakitBalance / 100).toFixed(2)];
        if (a.id === 'bank') return [a.id, '5000000.00'];
        if (a.id === 'ceyrek') return [a.id, String(ceyrekBalance)];
        if (a.id === 'hurda22') return [a.id, (hurda22Balance / 1000).toFixed(3)];
        return [a.id, '0'];
      }));
      events.push({
        id: `mix-stk-day-${d}`,
        schemaVersion: 6,
        timestamp: `${date}T19:55:00Z`,
        command: { type: 'stocktake', date, approvedBy: 'Benchmark', reasons: {}, counts: { taki14: '50000' } }
      });
      events.push({
        id: `mix-close-${d}`,
        schemaVersion: 6,
        timestamp: `${date}T20:00:00Z`,
        command: { type: 'close', date, approvedBy: 'Benchmark', reasons: {}, counts }
      });
    }
  }
  return events;
}

function runScenario(label, events, { supplierProbe = false } = {}) {
  const dir = mkdtempSync(join(tempRoot, `p6a-${label}-`));
  const dbPath = join(dir, 'bench.sqlite');
  try {
    const setupRepo = new Repository(dbPath, 'benchmark');
    const tInsert0 = performance.now();
    insertEventsBulk(setupRepo.db, events);
    const fixtureMs = Number((performance.now() - tInsert0).toFixed(2));
    setupRepo.close();

    const dbBytes = statSync(dbPath).size;

    // Cold open + cold state({ compact: true })
    const tCold0 = performance.now();
    const repo = new Repository(dbPath, 'benchmark');
    const coldState = repo.state({ compact: true });
    const coldMs = Number((performance.now() - tCold0).toFixed(2));
    const compactJson = JSON.stringify(coldState);
    const compactBytes = Buffer.byteLength(compactJson, 'utf8');

    const warmState = measure(() => repo.state({ compact: true }), 5);
    const journalAll = measure(() => repo.journalPage({ scope: 'all', limit: 50 }), 5);
    const journalToday = measure(() => repo.journalPage({ scope: 'today', limit: 50 }), 5);
    const journalFiltered = measure(() => repo.journalPage({ scope: 'all', q: 'Müşteri', limit: 50 }), 5);
    const supplier = supplierProbe ? measure(() => repo.supplierDetail({ supplierId: 'supplier-mix-firm-0', limit: 50 }), 5) : null;

    const tCmd0 = performance.now();
    const cmdRes = repo.execute({
      id: `bench-cmd-${Date.now()}`,
      revision: coldState.revision,
      command: { type: 'movement', date: coldState.date, accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '1', note: 'Tekil komut ölçümü' }
    }, { compact: true });
    const executeMs = Number((performance.now() - tCmd0).toFixed(2));
    assert.equal(cmdRes.state.revision, coldState.revision + 1);

    const cache = repo.cacheInfo();
    const mem = process.memoryUsage();
    repo.close();

    // Second cold Repository open on the same DB (verifies snapshot load path)
    const tSnap0 = performance.now();
    const repo2 = new Repository(dbPath, 'benchmark');
    const snapState = repo2.state({ compact: true });
    const coldOpenWithSnapshotMs = Number((performance.now() - tSnap0).toFixed(2));
    assert.equal(snapState.revision, cmdRes.state.revision);
    assert.equal(snapState.balances.nakit, cmdRes.state.balances.nakit);
    repo2.close();

    return {
      label,
      eventCount: events.length,
      dbMB: Number((dbBytes / (1024 * 1024)).toFixed(2)),
      fixtureMs,
      coldOpenAndCompactMs: coldMs,
      coldOpenWithSnapshotMs,
      compactMB: Number((compactBytes / (1024 * 1024)).toFixed(2)),
      warmStateCompact: warmState,
      journalAll50: journalAll,
      journalToday50: journalToday,
      journalFiltered50: journalFiltered,
      ...(supplier && { supplierDetail50: supplier }),
      singleExecuteMs: executeMs,
      cache,
      rssMB: Number((mem.rss / (1024 * 1024)).toFixed(2)),
      heapUsedMB: Number((mem.heapUsed / (1024 * 1024)).toFixed(2))
    };
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  }
}

const results = [];
if (validateMixed) {
  const evs = buildMixedEvents({ days: 3, customers: 10, stocks: 5, suppliers: 2, targetEvents: 200 });
  const s = emptyState(), seen = new Set();
  for (const e of evs) {
    try { applyEvent(s, e, seen); }
    catch (err) { console.error('FAIL AT:', e.id, e.command.type, 'v' + e.schemaVersion, err.stack || err.message); process.exit(1); }
  }
  console.log('Mixed validation OK:', evs.length);
  process.exit(0);
}
if (profileMixed) {
  const evs = buildMixedEvents({ days: 5, customers: 1000, stocks: 300, suppliers: 10, targetEvents: 4000 });
  const result = runScenario('profile-mixed-4k', evs, { supplierProbe: true });
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}
if (run50k) {
  results.push(runScenario('baseline-5k-50k', buildBaselineEvents(5000, 2000, 50000)));
}
if (runMixed) {
  results.push(runScenario('mixed-20k', buildMixedEvents({ days: 10, customers: 1000, stocks: 300, suppliers: 10, targetEvents: 20000 }), { supplierProbe: true }));
}
if (run100k) {
  results.push(runScenario('baseline-10k-100k', buildBaselineEvents(10000, 2000, 100000)));
}

console.log(JSON.stringify({ node: process.version, platform: process.platform, results }, null, 2));
