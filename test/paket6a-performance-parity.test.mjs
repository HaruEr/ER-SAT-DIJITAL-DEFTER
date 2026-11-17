import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS, replay } from '../domain.mjs';

const tempRoot = process.env.TEMP || process.env.TMP || 'D:\\Antigravity-Projects\\_isolated_temp';

function buildParityEvents(count = 600) {
  const date = '2026-11-10';
  const balances = Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, a.id === 'nakit' ? '500000' : a.id === 'ceyrek' ? '500' : '0']));
  const events = [
    { id: 'p6a-open', schemaVersion: 3, timestamp: `${date}T08:00:00Z`, command: { type: 'opening', date, balances } },
    { id: 'p6a-cust-1', schemaVersion: 5, timestamp: `${date}T08:01:00Z`, command: { type: 'account', date, name: 'Test Müşteri ÇŞĞÜÖİ', unit: 'TL', opening: '0', phone: '05321112233' } },
    { id: 'p6a-stk-1', schemaVersion: 5, timestamp: `${date}T08:02:00Z`, command: { type: 'stockAccount', date, name: 'Test Stok 1', unit: 'GRAM', countPolicy: 'periodic', opening: '10' } },
    { id: 'p6a-firm-1', schemaVersion: 17, timestamp: `${date}T08:03:00Z`, command: { type: 'supplierFirm', date, name: 'Test Toptancı' } },
    { id: 'p6a-unit-has', schemaVersion: 17, timestamp: `${date}T08:04:00Z`, command: { type: 'supplierUnit', date, supplierId: 'supplier-p6a-firm-1', unit: 'HAS' } },
    {
      id: 'p6a-spur-1',
      schemaVersion: 17,
      timestamp: `${date}T08:05:00Z`,
      command: { type: 'supplierPurchase', date, supplierId: 'supplier-p6a-firm-1', items: [{ accountId: 'ceyrek', quantity: '2' }], charges: [{ accountId: 'supplier-unit-p6a-unit-has', quantity: '3.200' }], note: 'Alış' }
    },
    {
      id: 'p6a-spay-1',
      schemaVersion: 17,
      timestamp: `${date}T08:06:00Z`,
      command: { type: 'supplierPayment', date, supplierId: 'supplier-p6a-firm-1', given: [{ accountId: 'nakit', quantity: '1000' }], credits: [{ accountId: 'supplier-unit-p6a-unit-has', quantity: '1.000' }], note: 'Ödeme' }
    },
    {
      id: 'p6a-salloc-1',
      schemaVersion: 17,
      timestamp: `${date}T08:07:00Z`,
      command: { type: 'supplierAllocation', date, supplierId: 'supplier-p6a-firm-1', allocations: [{ sourceId: 'p6a-spay-1', purchaseId: 'p6a-spur-1', accountId: 'supplier-unit-p6a-unit-has', quantity: '1.000' }], note: 'Tahsis' }
    },
    {
      id: 'p6a-sale-1',
      schemaVersion: 5,
      timestamp: `${date}T08:08:00Z`,
      command: { type: 'sale', date, items: [{ accountId: 'ceyrek', quantity: '1', value: '5500' }], payments: [{ accountId: 'nakit', quantity: '5000' }], credits: [{ accountId: 'cari-p6a-cust-1', quantity: '500' }], scrap: [], note: 'Satış' }
    }
  ];
  for (let i = events.length; i < count; i++) {
    events.push({
      id: `p6a-mov-${i}`,
      schemaVersion: 3,
      timestamp: `${date}T09:00:00Z`,
      command: { type: 'movement', date, accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '0.01', note: `Hareket ${i}` }
    });
  }
  return events;
}

test('snapshot load matches replay() exactly and safely rebuilds on corruption or stale revision', () => {
  const dir = mkdtempSync(join(tempRoot, 'p6a-test-'));
  const dbPath = join(dir, 'parity.sqlite');
  try {
    const events = buildParityEvents(600);
    const expected = replay(events);

    // 1. Seed DB and build initial snapshot on cold open
    const repo1 = new Repository(dbPath, 'parity');
    const insert = repo1.db.prepare('INSERT INTO events(id,body) VALUES(?,?)');
    repo1.db.exec('BEGIN');
    for (const ev of events) insert.run(ev.id, JSON.stringify(ev));
    repo1.db.prepare('UPDATE meta SET revision = ? WHERE id = 1').run(events.length);
    repo1.db.exec('COMMIT');

    const s1 = repo1.state({ compact: true });
    assert.deepEqual(s1.balances, expected.balances);
    assert.equal(repo1.cacheInfo().misses, 1);
    // Warm hit should not miss again
    repo1.state({ compact: true });
    assert.equal(repo1.cacheInfo().misses, 1);
    assert.equal(repo1.cacheInfo().hits, 1);

    const snapRow = repo1.db.prepare('SELECT version, revision, event_count FROM ledger_snapshot WHERE id=1').get();
    assert.equal(snapRow.version, 1);
    assert.equal(snapRow.revision, events.length);
    assert.equal(snapRow.event_count, events.length);
    repo1.close();

    // 2. Reopen cold: loads from snapshot and preserves full financial parity
    const repo2 = new Repository(dbPath, 'parity');
    const s2 = repo2.state({ compact: false });
    assert.deepEqual(s2.balances, expected.balances);
    assert.equal(s2.journal.length, expected.journal.length);
    const sup = repo2.supplierDetail({ supplierId: 'supplier-p6a-firm-1', limit: 50 });
    assert.equal(sup.documents.purchases[0].charges[0].remaining, 2200);
    const jFiltered = repo2.journalPage({ scope: 'all', q: 'Test Müşteri', limit: 50 });
    assert.equal(jFiltered.total, 2);
    repo2.close();

    // 3. Corrupt snapshot sha256 and simulate older-version write to events/meta -> must rebuild cleanly
    const repo3 = new Repository(dbPath, 'parity');
    repo3.db.exec("UPDATE ledger_snapshot SET sha256 = 'corrupted' WHERE id = 1");
    const extraEv = { id: 'p6a-legacy-write', schemaVersion: 3, timestamp: '2026-11-10T10:00:00Z', command: { type: 'movement', date: '2026-11-10', accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '10', note: 'Eski sürüm yazımı' } };
    repo3.db.prepare('INSERT INTO events(id,body) VALUES(?,?)').run(extraEv.id, JSON.stringify(extraEv));
    repo3.db.exec('UPDATE meta SET revision = revision + 1 WHERE id = 1');

    const s3 = repo3.state({ compact: true });
    assert.equal(s3.revision, events.length + 1);
    assert.equal(s3.balances.nakit, expected.balances.nakit + 1000);
    repo3.close();
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  }
});
