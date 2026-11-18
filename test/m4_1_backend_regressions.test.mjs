import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Repository } from '../repository.mjs';
import { createApp } from '../server.mjs';
import { INITIAL_ACCOUNTS, DomainError, decimal, eventVersion, quantity, replay, workdaySummary } from '../domain.mjs';
import { supplierDocuments, supplierAccountIds } from '../supplier-ledger.mjs';
import { projectSupplierDetail, projectSupplierParties } from '../supplier-view.mjs';
import { authenticateTestOwner, ownerFetch as fetch } from '../test-support/editor-session.mjs';
import { appendHistoricalEvent } from '../test-support/historical-supplier.mjs';

const tempRoot = process.env.TEMP || process.env.TMP || tmpdir();

function zeroBalances(extra = {}) {
  return {
    ...Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, '0'])),
    ...extra
  };
}

function exec(repo, id, command) {
  const rev = repo.state({ compact: true }).revision;
  return repo.execute({ id, revision: rev, command }, { compact: true });
}

function closeCounts(state) {
  return Object.fromEntries(
    state.accounts
      .filter(a => a.physical && !a.retired && (a.countPolicy === 'daily' || (a.scrap && a.unit === 'GRAM')))
      .map(a => [a.id, decimal(state.balances[a.id] || 0, a.unit)])
  );
}

function assertSupplierEquation(state, supplierId) {
  const docs = supplierDocuments(state, supplierId);
  const ids = supplierAccountIds(state, supplierId);
  for (const id of ids) {
    const charges = docs.purchases.flatMap(p => p.charges).filter(c => c.accountId === id).reduce((s, c) => s + c.remaining, 0);
    const unresolved = docs.unresolvedReceipts.flatMap(r => r.debts).filter(d => d.accountId === id).reduce((s, d) => s + d.quantity, 0);
    const credits = docs.sources.flatMap(s => s.credits).filter(c => c.accountId === id).reduce((s, c) => s + c.remaining, 0);
    const balance = state.balances[id] || 0;
    assert.equal(charges + unresolved - credits, balance === 0 ? 0 : -balance, `Equation mismatch on ${id}`);
  }
  for (const p of docs.purchases) {
    for (const c of p.charges) assert.ok(c.remaining >= 0, `Negative charge remaining on ${p.id}`);
    for (const l of p.lines) {
      assert.ok(l.remainingQuantity >= 0);
      assert.ok(l.remainingWeight >= 0);
    }
  }
  for (const s of docs.sources) {
    for (const c of s.credits) assert.ok(c.remaining >= 0, `Negative credit remaining on ${s.id}`);
  }
}

// ---------------------------------------------------------------------------
// F-M3-001: Two-tier cache spillover, SQLite journal parity, direct close() snapshot
// ---------------------------------------------------------------------------
test('F-M3-001: hot cache spillover, query parity, direct close() snapshot, corruption & archive restore', async () => {
  const dir = mkdtempSync(join(tempRoot, 'm41-f001-'));
  const dbPath = join(dir, 'ledger.sqlite');
  const archivePath = join(dir, 'ledger.ndjson');
  try {
    // 1. Start in full mode, build rich operational history, then spill over to hot mode
    //    with a tight cache budget (256 KiB < ~450 KiB full ledger, > ~40 KiB hot state).
    const repo = new Repository(dbPath, 'demo', { cacheMaxBytes: 256 * 1024 });
    const d0 = '2026-11-01';
    const d1 = '2026-11-02';
    repo.execute({
      id: 'open-0',
      revision: 0,
      command: {
        type: 'opening',
        date: d0,
        balances: zeroBalances({ nakit: '500000', banka: '100000', ceyrek: '200', yuzuk: '20', taki14: '200', hurda22: '100' })
      }
    });
    exec(repo, 'cust-tr', { type: 'account', date: d0, name: 'Şeyma Çelik İstanbul', unit: 'TL', opening: '0', phone: '05321234567' });
    exec(repo, 'cust-2', { type: 'account', date: d0, name: 'Ahmet Yılmaz', unit: 'TL', opening: '0' });
    exec(repo, 'sup-firm', { type: 'supplierFirm', date: d0, name: 'Altın Tedarik AŞ' });
    exec(repo, 'sup-has', { type: 'supplierUnit', date: d0, supplierId: 'supplier-sup-firm', unit: 'HAS' });
    exec(repo, 'sup-pur-1', {
      type: 'supplierPurchase',
      date: d0,
      supplierId: 'supplier-sup-firm',
      items: [{ accountId: 'ceyrek', quantity: '2' }],
      charges: [{ accountId: 'supplier-unit-sup-has', quantity: '3.200' }],
      note: 'Tedarik alış'
    });
    exec(repo, 'sup-pay-1', {
      type: 'supplierPayment',
      date: d0,
      supplierId: 'supplier-sup-firm',
      given: [{ accountId: 'nakit', quantity: '5000' }],
      credits: [{ accountId: 'supplier-unit-sup-has', quantity: '1.000' }],
      note: 'Tedarik ödeme'
    });
    exec(repo, 'sup-alloc-1', {
      type: 'supplierAllocation',
      date: d0,
      supplierId: 'supplier-sup-firm',
      allocations: [{ sourceId: 'sup-pay-1', purchaseId: 'sup-pur-1', accountId: 'supplier-unit-sup-has', quantity: '1.000' }],
      note: 'Tahsis'
    });
    exec(repo, 'sale-1', {
      type: 'sale',
      date: d0,
      items: [{ accountId: 'ceyrek', quantity: '2', value: '12000' }],
      payments: [{ accountId: 'nakit', quantity: '8000' }],
      credits: [{ accountId: 'cari-cust-tr', quantity: '4000' }],
      scrap: [],
      note: 'Şeyma çeyrek satışı'
    });
    exec(repo, 'ret-1', {
      type: 'saleReturn',
      date: d0,
      originalId: 'sale-1',
      items: [{ lineIndex: 0, quantity: '1', value: '6000' }],
      refunds: [{ accountId: 'nakit', quantity: '6000' }],
      note: 'Kısmi iade'
    });
    exec(repo, 'pur-cust', {
      type: 'purchase',
      date: d0,
      source: 'customer',
      counterpartyId: 'cari-cust-tr',
      items: [{ accountId: 'hurda22', quantity: '5', value: '10000' }],
      payments: [{ accountId: 'nakit', quantity: '5000' }],
      debts: [{ accountId: 'cari-cust-tr', quantity: '5000' }],
      note: 'Hurda alış'
    });
    exec(repo, 'reg-item', {
      type: 'registerItem',
      date: d0,
      code: 'YZ-100',
      accountId: 'yuzuk',
      weightAccount: 'taki14',
      actualWeight: '3.500',
      description: 'Tektaş yüzük'
    });
    exec(repo, 'sale-item', {
      type: 'sale',
      date: d0,
      items: [{ accountId: 'yuzuk', quantity: '1', weightAccount: 'taki14', weight: '3.500', value: '9000', inventoryCode: 'YZ-100' }],
      received: [{ accountId: 'nakit', quantity: '9000' }],
      given: [],
      credits: [],
      debts: [],
      counterpartyId: 'cari-cust-2',
      counterpartyType: 'customer',
      note: 'Tekil yüzük satış'
    });

    // Insert enough events to exceed 256 KiB full budget AND > 500 SNAPSHOT_MIN_EVENTS
    for (let i = 0; i < 650; i++) {
      exec(repo, `mov-${i}`, {
        type: 'movement',
        date: d0,
        accountId: 'nakit',
        direction: 'in',
        category: 'Sermaye',
        quantity: '0.01',
        note: `Günlük sermaye girişi seri numarası ${String(i).padStart(4, '0')} ekstra dolgu metni`
      });
    }

    const info = repo.cacheInfo();
    assert.equal(info.entries, 1);
    assert.ok(info.estimatedBytes > 0 && info.estimatedBytes <= info.maxBytes);

    // Warm hit check: repo.events must not be called for compact state, journalPage, accountStatement, supplierDetail, workdaySummary
    const origEvents = repo.events.bind(repo);
    repo.events = () => assert.fail('Warm hot cache must not call events()');
    let hotCompact, hotFull, hotPageQ, hotPageAcc, hotStmt, hotSup, hotSummary;
    try {
      const missesBefore = repo.cacheInfo().misses;
      hotCompact = repo.state({ compact: true });
      assert.equal(repo.cacheInfo().misses, missesBefore);
      hotFull = repo.state({ compact: false });
      hotPageQ = repo.journalPage({ scope: 'all', q: 'SEYMA ISTANBUL', limit: 25 });
      hotPageAcc = repo.journalPage({ scope: 'all', accountId: 'cari-cust-tr', limit: 25 });
      hotStmt = repo.accountStatement({ accountId: 'cari-cust-tr', startDate: d0, endDate: d0 });
      hotSup = repo.supplierDetail({ supplierId: 'supplier-sup-firm', editOriginalId: 'sup-alloc-1', limit: 25 });
      hotSummary = repo.workdaySummary(d0);
    } finally {
      repo.events = origEvents;
    }

    // Compare bit-for-bit against an independent full-mode uncached/replay Repository
    const allEvents = repo.events();
    const expectedReplay = replay(allEvents);
    assert.deepEqual(hotCompact.balances, expectedReplay.balances);
    assert.equal(hotCompact.journalMeta.total, expectedReplay.journal.length);
    assert.deepEqual(hotFull.balances, expectedReplay.balances);
    assert.equal(hotFull.journal.length, expectedReplay.journal.length);

    const refRepo = new Repository(':memory:', 'demo');
    const insRef = refRepo.db.prepare('INSERT INTO events(id,body) VALUES(?,?)');
    refRepo.db.exec('BEGIN');
    for (const ev of allEvents) insRef.run(ev.id, JSON.stringify(ev));
    refRepo.db.prepare('UPDATE meta SET revision = ? WHERE id = 1').run(allEvents.length);
    refRepo.db.exec('COMMIT');

    assert.deepEqual(hotCompact, refRepo.state({ compact: true }));
    assert.deepEqual(hotFull, refRepo.state({ compact: false }));
    assert.deepEqual(hotPageQ, refRepo.journalPage({ scope: 'all', q: 'SEYMA ISTANBUL', limit: 25 }));
    assert.deepEqual(hotPageAcc, refRepo.journalPage({ scope: 'all', accountId: 'cari-cust-tr', limit: 25 }));
    assert.deepEqual(hotStmt, refRepo.accountStatement({ accountId: 'cari-cust-tr', startDate: d0, endDate: d0 }));
    assert.deepEqual(hotSup, refRepo.supplierDetail({ supplierId: 'supplier-sup-firm', editOriginalId: 'sup-alloc-1', limit: 25 }));
    assert.deepEqual(hotSummary, refRepo.workdaySummary(d0));

    // Also test pagination cursor + scrapForSale + receiptContext parity in hot mode
    const p1 = repo.journalPage({ scope: 'all', limit: 10 });
    const p2 = repo.journalPage({ scope: 'all', limit: 10, cursor: p1.nextCursor });
    assert.deepEqual(p2, refRepo.journalPage({ scope: 'all', limit: 10, cursor: p1.nextCursor }));
    assert.deepEqual(
      repo.journalPage({ scope: 'all', type: 'purchase', scrapForSale: 'sale-1', limit: 10 }),
      refRepo.journalPage({ scope: 'all', type: 'purchase', scrapForSale: 'sale-1', limit: 10 })
    );
    refRepo.close();

    // Forward rename + history-reading commands in hot mode + failed command isolation
    exec(repo, 'rename-cust', { type: 'accountUpdate', date: d0, accountId: 'cari-cust-tr', name: 'Zeynep Güneş Ankara' });
    assert.equal(repo.journalPage({ scope: 'all', q: 'zeynep gunes', limit: 10 }).total, 3);
    assert.equal(repo.journalPage({ scope: 'all', q: 'seyma', limit: 10 }).total, 1); // note still says 'Şeyma çeyrek satışı'

    exec(repo, 'amend-sale', {
      type: 'amend',
      date: d0,
      originalId: 'sale-item',
      note: 'Düzeltme',
      replacement: {
        type: 'sale',
        items: [{ accountId: 'yuzuk', quantity: '1', weightAccount: 'taki14', weight: '3.500', value: '9500', inventoryCode: 'YZ-100' }],
        received: [{ accountId: 'nakit', quantity: '9500' }],
        given: [],
        credits: [],
        debts: [],
        counterpartyId: 'cari-cust-2',
        counterpartyType: 'customer',
        note: 'Güncel tekil satış'
      }
    });
    const missesBeforeRead = repo.cacheInfo().misses;
    assert.equal(repo.state({ compact: true }).balances.nakit, replay(repo.events()).balances.nakit);
    assert.equal(repo.cacheInfo().misses, missesBeforeRead, 'post-execute read must hit warm hot cache');

    // Failed command in hot mode must NOT corrupt warm hot state or fail subsequent reads
    const preFail = repo.state({ compact: true });
    assert.throws(() => exec(repo, 'bad-mov', { type: 'movement', date: d0, accountId: 'nakit', direction: 'out', category: 'Gider', quantity: '99999999', note: 'Yetersiz' }), e => e.status === 400);
    assert.deepEqual(repo.state({ compact: true }), preFail);

    // Close day and then execute one more command and call close() directly without an intervening read
    const stClose = repo.state({ compact: true });
    exec(repo, 'close-d0', { type: 'close', date: d0, counts: closeCounts(stClose), reasons: {}, approvedBy: 'Test Owner' });
    exec(repo, 'mov-d1', { type: 'movement', date: d1, accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '25', note: 'Direct close check' });
    const expectedRev = repo.state({ compact: true }).revision; // Wait: check close() directly after execute()!
    exec(repo, 'mov-d1-b', { type: 'movement', date: d1, accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '10', note: 'Direct close final' });
    const finalRev = expectedRev + 1;
    repo.close();

    // Reopen fresh Repository with same tight budget: MUST load from hot-v1 snapshot with 1 miss and 0 replay()
    const repo2 = new Repository(dbPath, 'demo', { cacheMaxBytes: 256 * 1024 });
    const snapRow = repo2.db.prepare('SELECT version, revision, event_count FROM ledger_snapshot WHERE id = 1').get();
    assert.equal(snapRow.version, 1);
    assert.equal(snapRow.revision, finalRev);
    assert.equal(snapRow.event_count, repo2.events().length);

    const origReplayCheck = repo2.events.bind(repo2);
    repo2.events = () => assert.fail('Reopen must load from hot-v1 snapshot without scanning events');
    let reopenedState;
    try {
      reopenedState = repo2.state({ compact: true });
      assert.equal(repo2.cacheInfo().misses, 1);
      assert.equal(repo2.cacheInfo().entries, 1);
    } finally {
      repo2.events = origReplayCheck;
    }
    assert.deepEqual(reopenedState.balances, replay(repo2.events()).balances);
    assert.equal(repo2.workdaySummary(d1).date, d1);

    // Corrupt snapshot sha256 -> must rebuild cleanly and repopulate ledger_journal*
    repo2.db.exec("UPDATE ledger_snapshot SET sha256 = 'bad' WHERE id = 1");
    const repo3 = new Repository(dbPath, 'demo', { cacheMaxBytes: 256 * 1024 });
    assert.deepEqual(repo3.state({ compact: true }).balances, reopenedState.balances);
    assert.equal(repo3.cacheInfo().entries, 1);

    // Simulate legacy 7719eaf full snapshot on disk exceeding 256 KiB -> must auto-convert to hot
    const fullStateForLegacySnap = repo3.state({ compact: false });
    const legacyBody = JSON.stringify({ state: fullStateForLegacySnap, journalBytes: 0 });
    const legacySha = createHash('sha256').update(legacyBody).digest('hex');
    const metaStats = repo3.db.prepare('SELECT COALESCE(MAX(seq),0) AS last_seq, COUNT(*) AS event_count FROM events').get();
    repo3.db.prepare('INSERT OR REPLACE INTO ledger_snapshot(id, version, revision, last_seq, event_count, sha256, body) VALUES(1, 1, ?, ?, ?, ?, ?)').run(finalRev, metaStats.last_seq, metaStats.event_count, legacySha, legacyBody);
    repo3.close();
    repo2.close();

    const repoLegacy = new Repository(dbPath, 'demo', { cacheMaxBytes: 256 * 1024 });
    const convertedState = repoLegacy.state({ compact: true });
    assert.deepEqual(convertedState.balances, reopenedState.balances);
    assert.equal(repoLegacy.cacheInfo().entries, 1);
    assert.equal(JSON.parse(repoLegacy.db.prepare('SELECT body FROM ledger_snapshot WHERE id=1').get().body).kind, 'hot-v1');

    // Export NDJSON archive & restoreArchive into a fresh repo (verifies ledger_journal* cleanup + rebuild)
    repoLegacy.exportArchive(archivePath);
    repoLegacy.close();

    const dbPath2 = join(dir, 'restored.sqlite');
    const repoRestored = new Repository(dbPath2, 'demo', { cacheMaxBytes: 256 * 1024 });
    repoRestored.execute({ id: 'dummy', revision: 0, command: { type: 'opening', date: '2026-01-01', balances: zeroBalances() } });
    await repoRestored.restoreArchive(createReadStream(archivePath), { revision: 1, confirmation: 'GERİ YÜKLE', temporaryDirectory: dir });
    assert.deepEqual(repoRestored.state({ compact: true }).balances, reopenedState.balances);
    assert.equal(repoRestored.journalPage({ scope: 'all', q: 'zeynep gunes', limit: 10 }).total, 3);
    repoRestored.close();

    // cacheMaxBytes: 1 and cacheMaxBytes: 0 contracts
    const repoOne = new Repository(dbPath, 'demo', { cacheMaxBytes: 1 });
    assert.equal(repoOne.state({ compact: true }).revision, finalRev);
    assert.equal(repoOne.cacheInfo().entries, 0);
    assert.equal(repoOne.cacheInfo().estimatedBytes, 0);
    repoOne.close();

    const dbZero = join(dir, 'zero.sqlite');
    const repoZero = new Repository(dbZero, 'demo', { cacheMaxBytes: 0 });
    repoZero.execute({ id: 'z-open', revision: 0, command: { type: 'opening', date: d0, balances: zeroBalances() } });
    assert.equal(repoZero.cacheInfo().entries, 0);
    assert.equal(repoZero.db.prepare('SELECT COUNT(*) AS c FROM ledger_snapshot').get().c, 0);
    repoZero.close();
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch {}
  }
});

// ---------------------------------------------------------------------------
// F-M3-002: retailExchange with SILVER fund accounts & SILVER customers
// ---------------------------------------------------------------------------
test('F-M3-002: retailExchange supports SILVER fund accounts (received, v13/v14 refunds, SILVER customers) while rejecting GRAM/ADET', () => {
  const repo = new Repository(':memory:', 'demo');
  const d0 = '2026-11-01';
  repo.execute({
    id: 'open',
    revision: 0,
    command: { type: 'opening', date: d0, balances: zeroBalances({ nakit: '100000', ceyrek: '10', yuzuk: '10', taki14: '100' }) }
  });
  exec(repo, 'silver-fund', { type: 'fundAccount', date: d0, name: 'Gümüş Kasa', unit: 'SILVER', physical: true, opening: '100' });
  exec(repo, 'silver-cust', { type: 'account', date: d0, name: 'Gümüş Cari Müşteri', unit: 'SILVER', partyType: 'customer', opening: '0' });
  exec(repo, 'tl-cust', { type: 'account', date: d0, name: 'TL Cari Müşteri', unit: 'TL', partyType: 'customer', opening: '0' });
  exec(repo, 'item-1', { type: 'registerItem', date: d0, code: 'YZ-SIL-1', accountId: 'yuzuk', weightAccount: 'taki14', actualWeight: '4.000', description: 'Yüzük' });

  // Original cash sale (for upward/downward v13/v14)
  exec(repo, 'orig-sale-cash', {
    type: 'sale',
    date: d0,
    items: [{ accountId: 'ceyrek', quantity: '1', value: '5000' }],
    payments: [{ accountId: 'nakit', quantity: '5000' }],
    credits: [],
    scrap: [],
    note: 'İlk satış'
  });

  // 1. Upward retailExchange collecting physical SILVER in received (non-serialized)
  const up1 = exec(repo, 'ex-up-silver', {
    type: 'retailExchange',
    date: d0,
    originalId: 'orig-sale-cash',
    note: 'Gümüş fark tahsilli değişim',
    returnItems: [{ lineIndex: 0, quantity: '1', value: '5000' }],
    newItems: [{ accountId: 'ceyrek', quantity: '2', value: '8000' }],
    received: [{ accountId: 'fund-silver-fund', quantity: '15.000', valueTL: '3000' }],
    refunds: []
  });
  assert.equal(up1.state.balances['fund-silver-fund'], 115000);
  assert.deepEqual(up1.state.moneyFlow.byUnit.SILVER, { incoming: 15000, outgoing: 0 });
  const saleLeg1 = repo.events().find(e => e.id === 'ex-up-silver');
  assert.equal(saleLeg1.schemaVersion, 13);
  const fullJournal1 = repo.state().journal;
  assert.equal(fullJournal1.at(-1).id, 'ex-up-silver');
  assert.deepEqual(up1.state.balances, replay(repo.events()).balances);
  // undoExchange restores exact prior balances
  exec(repo, 'undo-up-silver', { type: 'undoExchange', date: d0, originalId: 'ex-up-silver', note: 'İptal' });
  assert.equal(repo.state().balances['fund-silver-fund'], 100000);

  // 2. Upward retailExchange with inventoryCode + physical SILVER in received (v8 -> v7)
  exec(repo, 'ex-up-item-silver', {
    type: 'retailExchange',
    date: d0,
    originalId: 'orig-sale-cash',
    note: 'Tekil ürün + gümüş değişim',
    returnItems: [{ lineIndex: 0, quantity: '1', value: '5000' }],
    newItems: [{ accountId: 'yuzuk', quantity: '1', weightAccount: 'taki14', weight: '4.000', value: '8000', inventoryCode: 'YZ-SIL-1' }],
    received: [{ accountId: 'fund-silver-fund', quantity: '10.000', valueTL: '3000' }],
    refunds: []
  });
  assert.equal(repo.state().inventoryItems.find(i => i.code === 'YZ-SIL-1').status, 'sold');
  assert.equal(repo.state().balances['fund-silver-fund'], 110000);
  exec(repo, 'undo-up-item-silver', { type: 'undoExchange', date: d0, originalId: 'ex-up-item-silver', note: 'Geri al' });
  assert.equal(repo.state().inventoryItems.find(i => i.code === 'YZ-SIL-1').status, 'available');
  assert.equal(repo.state().balances['fund-silver-fund'], 100000);

  // 3. Downward v13 retailExchange (without customerConsideration) refunding physical SILVER
  exec(repo, 'ex-down-v13', {
    type: 'retailExchange',
    date: d0,
    originalId: 'orig-sale-cash',
    note: 'v13 Gümüş iade farkı',
    returnItems: [{ lineIndex: 0, quantity: '1', value: '5000' }],
    newItems: [{ accountId: 'ceyrek', quantity: '1', value: '3000' }],
    received: [],
    refunds: [{ accountId: 'fund-silver-fund', quantity: '10.000', valueTL: '2000' }]
  });
  assert.equal(repo.state().balances['fund-silver-fund'], 90000);
  assert.deepEqual(repo.state().balances, replay(repo.events()).balances);
  exec(repo, 'undo-down-v13', { type: 'undoExchange', date: d0, originalId: 'ex-down-v13', note: 'Geri al' });
  assert.equal(repo.state().balances['fund-silver-fund'], 100000);

  // 4. Downward v14 retailExchange (with customerConsideration) refunding physical SILVER + grantCredit
  exec(repo, 'orig-sale-tl-cust', {
    type: 'sale',
    date: d0,
    items: [{ accountId: 'ceyrek', quantity: '1', value: '5000' }],
    received: [{ accountId: 'nakit', quantity: '5000' }],
    given: [],
    credits: [],
    debts: [],
    counterpartyId: 'cari-tl-cust',
    counterpartyType: 'customer',
    note: 'Müşteri satışı'
  });
  exec(repo, 'ex-down-v14', {
    type: 'retailExchange',
    date: d0,
    originalId: 'orig-sale-tl-cust',
    note: 'v14 Gümüş + cari alacak',
    returnItems: [{ lineIndex: 0, quantity: '1', value: '5000' }],
    newItems: [{ accountId: 'ceyrek', quantity: '1', value: '3000' }],
    received: [],
    refunds: [{ accountId: 'fund-silver-fund', quantity: '5.000', valueTL: '1000' }],
    customerConsideration: [{ accountId: 'cari-tl-cust', quantity: '1000', action: 'grantCredit' }]
  });
  assert.equal(repo.state().balances['fund-silver-fund'], 95000);
  assert.equal(repo.state().balances['cari-tl-cust'], -100000);

  // 5. Zero-difference retailExchange on credit sale to SILVER customer
  exec(repo, 'orig-sale-silver-cust', {
    type: 'sale',
    date: d0,
    items: [{ accountId: 'ceyrek', quantity: '1', value: '5000' }],
    received: [],
    given: [],
    credits: [{ accountId: 'cari-silver-cust', quantity: '25.000', valueTL: '5000' }],
    debts: [],
    counterpartyId: 'cari-silver-cust',
    counterpartyType: 'customer',
    note: 'Gümüş carili satış'
  });
  exec(repo, 'ex-zero-silver-cust', {
    type: 'retailExchange',
    date: d0,
    originalId: 'orig-sale-silver-cust',
    note: 'Birebir değişim gümüş müşteri',
    returnItems: [{ lineIndex: 0, quantity: '1', value: '5000' }],
    newItems: [{ accountId: 'ceyrek', quantity: '1', value: '5000' }],
    received: [],
    refunds: []
  });
  assert.deepEqual(repo.state().balances, replay(repo.events()).balances);

  // 6. Negative checks: GRAM and ADET fund/stock accounts in received & refunds remain rejected
  assert.throws(() => exec(repo, 'bad-gram-recv', {
    type: 'retailExchange', date: d0, originalId: 'orig-sale-cash', note: 'Yasak gram',
    returnItems: [{ lineIndex: 0, quantity: '1', value: '5000' }],
    newItems: [{ accountId: 'ceyrek', quantity: '2', value: '8000' }],
    received: [{ accountId: 'hurda22', quantity: '1', valueTL: '3000' }],
    refunds: []
  }), e => e instanceof DomainError);
  assert.throws(() => exec(repo, 'bad-adet-refund', {
    type: 'retailExchange', date: d0, originalId: 'orig-sale-cash', note: 'Yasak adet',
    returnItems: [{ lineIndex: 0, quantity: '1', value: '5000' }],
    newItems: [{ accountId: 'ceyrek', quantity: '1', value: '3000' }],
    received: [],
    refunds: [{ accountId: 'ceyrek', quantity: '1', valueTL: '2000' }]
  }), e => e instanceof DomainError);

  // Backup / restore round-trip
  const backup = repo.backup();
  repo.restore({ backup, revision: repo.state().revision, confirmation: 'GERİ YÜKLE' });
  assert.deepEqual(repo.state().balances, replay(backup.events).balances);
  repo.close();
});

// ---------------------------------------------------------------------------
// F-M3-003: amend / supplierAmend / supplierAmendmentPreview when inventoryReserved > 0
// ---------------------------------------------------------------------------
test('F-M3-003: amend, supplierAmend, and supplierAmendmentPreview work with inventoryReserved > 0 while preserving anti-masking and linked blocks', () => {
  const repo = new Repository(':memory:', 'demo');
  const d0 = '2026-11-01';
  repo.execute({
    id: 'open',
    revision: 0,
    command: { type: 'opening', date: d0, balances: zeroBalances({ nakit: '500000' }) }
  });
  exec(repo, 'sup-f', { type: 'supplierFirm', date: d0, name: 'Tedarikçi' });
  exec(repo, 'sup-tl', { type: 'supplierUnit', date: d0, supplierId: 'supplier-sup-f', unit: 'TL' });

  // Unlinked supplierPurchase: 2 yuzuk, 6.550 g taki14
  exec(repo, 'sp-unlinked', {
    type: 'supplierPurchase',
    date: d0,
    supplierId: 'supplier-sup-f',
    items: [{ accountId: 'yuzuk', quantity: '2', weightAccount: 'taki14', weight: '6.550' }],
    charges: [{ accountId: 'supplier-unit-sup-tl', quantity: '20000' }],
    note: 'İlk toptancı alışı'
  });
  // Unlinked retail purchase: 2 yuzuk, 6.000 g taki14
  exec(repo, 'ret-pur', {
    type: 'purchase',
    date: d0,
    source: 'customer',
    items: [{ accountId: 'yuzuk', quantity: '2', weightAccount: 'taki14', weight: '6.000', value: '18000' }],
    payments: [{ accountId: 'nakit', quantity: '18000' }],
    debts: [],
    note: 'Perakende alış'
  });
  // Unlinked stock in: 1 yuzuk, 2.500 g taki14
  exec(repo, 'stk-in', {
    type: 'stock',
    date: d0,
    direction: 'in',
    category: 'Stok girişi',
    items: [{ accountId: 'yuzuk', quantity: '1', weightAccount: 'taki14', weight: '2.500' }],
    note: 'Stok girişi'
  });
  // Unlinked movement in: 2 ceyrek
  exec(repo, 'mov-in', {
    type: 'movement',
    date: d0,
    accountId: 'ceyrek',
    direction: 'in',
    category: 'Stok girişi',
    quantity: '2',
    note: 'Çeyrek giriş'
  });
  // Register unlinked YZ-UNL (yuzuk: 1, taki14: 3.250) and CY-UNL (ceyrek: 1)
  exec(repo, 'reg-yz', { type: 'registerItem', date: d0, code: 'YZ-UNL', accountId: 'yuzuk', weightAccount: 'taki14', actualWeight: '3.250', description: 'Ayrılmış yüzük' });
  exec(repo, 'reg-cy', { type: 'registerItem', date: d0, code: 'CY-UNL', accountId: 'ceyrek', actualWeight: '1.750', description: 'Ayrılmış çeyrek' });

  // Sell unserialized yuzuk (4 units, weight 11.800) so remaining balance = 1 yuzuk, 3.250 g (exact reserved floor!)
  // Wait: total yuzuk = 2+2+1 = 5, reserved = 1 -> sell 4 -> remaining yuzuk = 1!
  // total taki14 = 6.550 + 6.000 + 2.500 = 15.050, reserved = 3.250 -> sell 11.800 -> remaining = 3.250!
  // total ceyrek = 2, reserved = 1 -> sell 1 -> remaining = 1!
  exec(repo, 'sell-unser', {
    type: 'sale',
    date: d0,
    items: [
      { accountId: 'yuzuk', quantity: '4', weightAccount: 'taki14', weight: '11.800', value: '30000' },
      { accountId: 'ceyrek', quantity: '1', value: '5000' }
    ],
    received: [{ accountId: 'nakit', quantity: '35000' }],
    given: [],
    credits: [],
    debts: [],
    counterpartyType: 'customer',
    note: 'Serisiz satış'
  });

  // 1. supplierAmendmentPreview on sp-unlinked must succeed even though balance == reserved
  const supDetail = repo.supplierDetail({ supplierId: 'supplier-sup-f', editOriginalId: 'sp-unlinked' });
  assert.ok(supDetail.amendment);
  assert.equal(supDetail.amendment.balances.yuzuk, -1); // intermediate preview

  // 2. supplierAmend keeping >= reserved succeeds
  exec(repo, 'samend-ok', {
    type: 'supplierAmend',
    date: d0,
    originalId: 'sp-unlinked',
    note: 'Fiyat düzeltme',
    replacement: {
      type: 'supplierPurchase',
      supplierId: 'supplier-sup-f',
      items: [{ accountId: 'yuzuk', quantity: '2', weightAccount: 'taki14', weight: '6.550' }],
      charges: [{ accountId: 'supplier-unit-sup-tl', quantity: '21000' }],
      note: 'Yeni borç'
    }
  });
  assert.equal(repo.state().balances['supplier-unit-sup-tl'], -2100000);

  // 3. supplierAmend reducing below reserved MUST fail (400)
  assert.throws(() => exec(repo, 'samend-low-qty', {
    type: 'supplierAmend',
    date: d0,
    originalId: 'samend-ok',
    note: 'Eksik adet',
    replacement: {
      type: 'supplierPurchase',
      supplierId: 'supplier-sup-f',
      items: [{ accountId: 'yuzuk', quantity: '1', weightAccount: 'taki14', weight: '6.550' }],
      charges: [{ accountId: 'supplier-unit-sup-tl', quantity: '21000' }],
      note: 'Eksik'
    }
  }), e => e.status === 400);
  assert.throws(() => exec(repo, 'samend-low-wt', {
    type: 'supplierAmend',
    date: d0,
    originalId: 'samend-ok',
    note: 'Eksik gram',
    replacement: {
      type: 'supplierPurchase',
      supplierId: 'supplier-sup-f',
      items: [{ accountId: 'yuzuk', quantity: '2', weightAccount: 'taki14', weight: '6.540' }],
      charges: [{ accountId: 'supplier-unit-sup-tl', quantity: '21000' }],
      note: 'Eksik'
    }
  }), e => e.status === 400);

  // 4. amend on unlinked retail purchase, stock in, movement in
  exec(repo, 'amend-pur', {
    type: 'amend', date: d0, originalId: 'ret-pur', note: 'Alış tutarı düzeltme',
    replacement: {
      type: 'purchase', source: 'customer',
      items: [{ accountId: 'yuzuk', quantity: '2', weightAccount: 'taki14', weight: '6.000', value: '18500' }],
      payments: [{ accountId: 'nakit', quantity: '18500' }], debts: [], note: 'Düzeltildi'
    }
  });
  assert.throws(() => exec(repo, 'amend-pur-low', {
    type: 'amend', date: d0, originalId: 'amend-pur', note: 'Eksik alış',
    replacement: {
      type: 'purchase', source: 'customer',
      items: [{ accountId: 'yuzuk', quantity: '1', weightAccount: 'taki14', weight: '6.000', value: '18500' }],
      payments: [{ accountId: 'nakit', quantity: '18500' }], debts: [], note: 'Eksik'
    }
  }), e => e.status === 400);

  exec(repo, 'amend-stk', {
    type: 'amend', date: d0, originalId: 'stk-in', note: 'Açıklama düzeltme',
    replacement: { type: 'stock', direction: 'in', category: 'Stok girişi', items: [{ accountId: 'yuzuk', quantity: '1', weightAccount: 'taki14', weight: '2.500' }], note: 'Yeni not' }
  });
  exec(repo, 'amend-mov', {
    type: 'amend', date: d0, originalId: 'mov-in', note: 'Açıklama düzeltme',
    replacement: { type: 'movement', accountId: 'ceyrek', direction: 'in', category: 'Stok girişi', quantity: '2', note: 'Yeni çeyrek not' }
  });
  assert.throws(() => exec(repo, 'amend-mov-low', {
    type: 'amend', date: d0, originalId: 'amend-mov', note: 'Eksik',
    replacement: { type: 'movement', accountId: 'ceyrek', direction: 'in', category: 'Stok girişi', quantity: '1', note: 'Eksik' }
  }), e => e.status === 400);

  // 5. Guardrails: standalone reverse / supplierReverse still reject when balance - reserved < originalQty
  assert.throws(() => exec(repo, 'rev-pur', { type: 'reverse', date: d0, originalId: 'amend-pur', note: 'Yasak' }), e => e.status === 400);
  assert.throws(() => exec(repo, 'srev-pur', { type: 'supplierReverse', date: d0, originalId: 'samend-ok', note: 'Yasak' }), e => e.status === 400);

  // 6. Guardrail: purchaseLine-linked purchase amend STILL rejects
  exec(repo, 'pur-linked', {
    type: 'purchase', date: d0, source: 'customer',
    items: [{ accountId: 'ceyrek', quantity: '1', value: '4500' }],
    payments: [{ accountId: 'nakit', quantity: '4500' }], debts: [], note: 'Bağlı alış'
  });
  exec(repo, 'reg-linked', {
    type: 'registerItem', date: d0, code: 'CY-LNK', accountId: 'ceyrek',
    purchaseLine: { id: 'pur-linked', lineIndex: 0 }, description: 'Bağlı çeyrek'
  });
  assert.throws(() => exec(repo, 'amend-linked', {
    type: 'amend', date: d0, originalId: 'pur-linked', note: 'Yasak',
    replacement: {
      type: 'purchase', source: 'customer',
      items: [{ accountId: 'ceyrek', quantity: '1', value: '4600' }],
      payments: [{ accountId: 'nakit', quantity: '4600' }], debts: [], note: 'Yasak'
    }
  }), e => e.status === 400);

  // 7. Guardrail: adversarial amend on sale trying to mask reserved stock delivery via same-event received
  //    Add 1 unreserved ceyrek, sell 1 ceyrek (so remaining ceyrek == reserved == 2; on Leg 1 bal=3, res=2),
  //    then amend sale to deliver 2 ceyrek while receiving 1 ceyrek (net delta = -1, checkReserved would pass,
  //    ONLY inventory.mjs:230-240 anti-masking catches amount=2 > 3-2=1!).
  exec(repo, 'mov-extra-cy', { type: 'movement', date: d0, accountId: 'ceyrek', direction: 'in', category: 'Stok girişi', quantity: '1', note: 'Ek çeyrek' });
  exec(repo, 'sale-mask-orig', {
    type: 'sale', date: d0,
    items: [{ accountId: 'ceyrek', quantity: '1', value: '5000' }],
    received: [{ accountId: 'nakit', quantity: '5000' }],
    given: [], credits: [], debts: [], counterpartyType: 'customer', note: 'Normal satış'
  });
  assert.throws(() => exec(repo, 'amend-mask-attack', {
    type: 'amend', date: d0, originalId: 'sale-mask-orig', note: 'Maskeleme denemesi',
    replacement: {
      type: 'sale',
      items: [{ accountId: 'ceyrek', quantity: '2', value: '10000' }],
      received: [{ accountId: 'ceyrek', quantity: '1', valueTL: '5000' }, { accountId: 'nakit', quantity: '5000' }],
      given: [], credits: [], debts: [], counterpartyType: 'customer', note: 'Maskeli'
    }
  }), e => e.status === 400);
  assert.deepEqual(repo.state().balances, replay(repo.events()).balances);
  repo.close();
});

// ---------------------------------------------------------------------------
// F-M3-004: Cross-day chained amend & supplierAmend moneyFlow parity (full & hot)
// ---------------------------------------------------------------------------
test('F-M3-004: cross-day chained amend and supplierAmend keep moneyFlow exact in full and hot modes', () => {
  const dir = mkdtempSync(join(tempRoot, 'm41-f004-'));
  try {
    for (const [label, opts] of [['full', {}], ['hot', { cacheMaxBytes: 96 * 1024 }]]) {
      const dbPath = join(dir, `${label}.sqlite`);
      const repo = new Repository(dbPath, 'demo', opts);
      const d0 = '2026-11-01', d1 = '2026-11-02', d2 = '2026-11-03';
      repo.execute({
        id: 'open',
        revision: 0,
        command: { type: 'opening', date: d0, balances: zeroBalances({ nakit: '500000', usd: '10000', ceyrek: '50' }) }
      });
      exec(repo, 'sup-f', { type: 'supplierFirm', date: d0, name: 'Toptancı' });
      exec(repo, 'sup-tl', { type: 'supplierUnit', date: d0, supplierId: 'supplier-sup-f', unit: 'TL' });
      // Day 0 events
      exec(repo, 'sale-d0', {
        type: 'sale', date: d0,
        items: [{ accountId: 'ceyrek', quantity: '1', value: '1000' }],
        received: [{ accountId: 'nakit', quantity: '1000' }],
        given: [], credits: [], debts: [], counterpartyType: 'customer', note: 'D0 satış'
      });
      exec(repo, 'spay-d0', {
        type: 'supplierPayment', date: d0, supplierId: 'supplier-sup-f',
        given: [{ accountId: 'nakit', quantity: '500' }],
        credits: [{ accountId: 'supplier-unit-sup-tl', quantity: '500' }],
        note: 'D0 ödeme'
      });
      exec(repo, 'spur-d0', {
        type: 'supplierPurchase', date: d0, supplierId: 'supplier-sup-f',
        items: [{ accountId: 'ceyrek', quantity: '1' }],
        charges: [{ accountId: 'supplier-unit-sup-tl', quantity: '1000' }],
        given: [{ accountId: 'usd', quantity: '10', referenceTL: '300' }],
        credits: [{ accountId: 'supplier-unit-sup-tl', quantity: '300' }],
        note: 'D0 USD ödemeli alış'
      });
      if (label === 'hot') {
        for (let i = 0; i < 250; i++) {
          exec(repo, `pad-${i}`, { type: 'movement', date: d0, accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '0.01', note: `Dolgu satırı ${i} uzun metin` });
        }
      }
      exec(repo, 'close-d0', { type: 'close', date: d0, counts: closeCounts(repo.state({ compact: true })), reasons: {}, approvedBy: 'Owner' });

      // Day 1: chained amend on sale-d0 (1000 -> 1200 -> 900)
      exec(repo, 'amend-sale-1', {
        type: 'amend', date: d1, originalId: 'sale-d0', note: '1200 oldu',
        replacement: {
          type: 'sale', items: [{ accountId: 'ceyrek', quantity: '1', value: '1200' }],
          received: [{ accountId: 'nakit', quantity: '1200' }], given: [], credits: [], debts: [], counterpartyType: 'customer', note: '1200'
        }
      });
      assert.deepEqual(repo.state({ compact: true }).moneyFlow.byUnit.TL, { incoming: 20000, outgoing: 0 });
      exec(repo, 'amend-sale-2', {
        type: 'amend', date: d1, originalId: 'amend-sale-1', note: '900 oldu',
        replacement: {
          type: 'sale', items: [{ accountId: 'ceyrek', quantity: '1', value: '900' }],
          received: [{ accountId: 'nakit', quantity: '900' }], given: [], credits: [], debts: [], counterpartyType: 'customer', note: '900'
        }
      });
      const tlAfterSale = repo.state({ compact: true }).moneyFlow.byUnit.TL;
      assert.equal(tlAfterSale.incoming - tlAfterSale.outgoing, -10000);
      assert.deepEqual(tlAfterSale, { incoming: 20000, outgoing: 30000 });

      // Day 1: chained supplierAmend on spay-d0 (500 -> 700 -> 400 => net +10000 kurus TL)
      exec(repo, 'samend-pay-1', {
        type: 'supplierAmend', date: d1, originalId: 'spay-d0', note: '700 ödeme',
        replacement: { type: 'supplierPayment', supplierId: 'supplier-sup-f', given: [{ accountId: 'nakit', quantity: '700' }], credits: [{ accountId: 'supplier-unit-sup-tl', quantity: '700' }], note: '700' }
      });
      exec(repo, 'samend-pay-2', {
        type: 'supplierAmend', date: d1, originalId: 'samend-pay-1', note: '400 ödeme',
        replacement: { type: 'supplierPayment', supplierId: 'supplier-sup-f', given: [{ accountId: 'nakit', quantity: '400' }], credits: [{ accountId: 'supplier-unit-sup-tl', quantity: '400' }], note: '400' }
      });
      const tlAfterSup = repo.state({ compact: true }).moneyFlow.byUnit.TL;
      assert.equal(tlAfterSup.incoming - tlAfterSup.outgoing, 0);
      assert.deepEqual(tlAfterSup, { incoming: 50000, outgoing: 50000 });

      // Multi-day chain: Day 2 chained amendments on both sale and supplierPurchase (USD)
      exec(repo, 'close-d1', { type: 'close', date: d1, counts: closeCounts(repo.state({ compact: true })), reasons: {}, approvedBy: 'Owner' });
      exec(repo, 'amend-sale-d2-1', {
        type: 'amend', date: d2, originalId: 'amend-sale-2', note: 'D2 ilk',
        replacement: {
          type: 'sale', items: [{ accountId: 'ceyrek', quantity: '1', value: '1100' }],
          received: [{ accountId: 'nakit', quantity: '1100' }], given: [], credits: [], debts: [], counterpartyType: 'customer', note: '1100'
        }
      });
      exec(repo, 'amend-sale-d2-2', {
        type: 'amend', date: d2, originalId: 'amend-sale-d2-1', note: 'D2 geri 900',
        replacement: {
          type: 'sale', items: [{ accountId: 'ceyrek', quantity: '1', value: '900' }],
          received: [{ accountId: 'nakit', quantity: '900' }], given: [], credits: [], debts: [], counterpartyType: 'customer', note: '900'
        }
      });
      exec(repo, 'samend-usd-1', {
        type: 'supplierAmend', date: d2, originalId: 'spur-d0', note: 'D2 USD 15',
        replacement: {
          type: 'supplierPurchase', supplierId: 'supplier-sup-f',
          items: [{ accountId: 'ceyrek', quantity: '1' }], charges: [{ accountId: 'supplier-unit-sup-tl', quantity: '1000' }],
          given: [{ accountId: 'usd', quantity: '15', referenceTL: '450' }], credits: [{ accountId: 'supplier-unit-sup-tl', quantity: '450' }], note: '15 USD'
        }
      });
      exec(repo, 'samend-usd-2', {
        type: 'supplierAmend', date: d2, originalId: 'samend-usd-1', note: 'D2 USD 8',
        replacement: {
          type: 'supplierPurchase', supplierId: 'supplier-sup-f',
          items: [{ accountId: 'ceyrek', quantity: '1' }], charges: [{ accountId: 'supplier-unit-sup-tl', quantity: '1000' }],
          given: [{ accountId: 'usd', quantity: '8', referenceTL: '240' }], credits: [{ accountId: 'supplier-unit-sup-tl', quantity: '240' }], note: '8 USD'
        }
      });

      const liveCompact = repo.state({ compact: true });
      assert.equal(liveCompact.moneyFlow.byUnit.TL.incoming - liveCompact.moneyFlow.byUnit.TL.outgoing, 0);
      assert.equal(liveCompact.moneyFlow.byUnit.USD.incoming - liveCompact.moneyFlow.byUnit.USD.outgoing, 200);
      assert.deepEqual(liveCompact.moneyFlow.byUnit.TL, { incoming: 20000, outgoing: 20000 });
      assert.deepEqual(liveCompact.moneyFlow.byUnit.USD, { incoming: 700, outgoing: 500 });

      // Must match fresh cold Repository replay bit-for-bit
      const events = repo.events();
      repo.close();
      const verifyRepo = new Repository(':memory:', 'demo');
      const ins = verifyRepo.db.prepare('INSERT INTO events(id,body) VALUES(?,?)');
      verifyRepo.db.exec('BEGIN');
      for (const e of events) ins.run(e.id, JSON.stringify(e));
      verifyRepo.db.prepare('UPDATE meta SET revision = ? WHERE id = 1').run(events.length);
      verifyRepo.db.exec('COMMIT');
      assert.deepEqual(liveCompact.moneyFlow, verifyRepo.state({ compact: true }).moneyFlow);
      verifyRepo.close();
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch {}
  }
});

// ---------------------------------------------------------------------------
// F-M3-006 & F-M3-009: GET /api/summary zero full-journal structuredClone & supplierUnit created filter
// ---------------------------------------------------------------------------
test('F-M3-006 & F-M3-009: GET /api/summary avoids full-journal structuredClone, preserves 400s, and excludes later-day supplierUnit', async () => {
  const dataDirectory = mkdtempSync(join(tempRoot, 'm41-f006-'));
  const { server, repositories } = createApp({ dataDirectory, logger: () => {} });
  server.keepAliveTimeout = 300000;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await authenticateTestOwner(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = url => fetch(url, { headers: { connection: 'close' } });
  const origClone = globalThis.structuredClone;
  try {
    const d0 = '2026-11-01', d1 = '2026-11-02';
    // Force tight cache budget on demo repo to test BOTH full and hot modes over HTTP
    const repo = new Repository(join(dataDirectory, 'demo.sqlite'), 'demo', { cacheMaxBytes: 96 * 1024 });
    repositories.set('demo', repo);

    repo.execute({ id: 'open', revision: 0, command: { type: 'opening', date: d0, balances: zeroBalances({ nakit: '100000' }) } });
    exec(repo, 'sup-f', { type: 'supplierFirm', date: d0, name: 'Toptancı' });
    for (let i = 0; i < 15; i++) {
      exec(repo, `mov-${i}`, { type: 'movement', date: d0, accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '1', note: `Kayıt ${i}` });
    }
    exec(repo, 'close-d0', { type: 'close', date: d0, counts: closeCounts(repo.state({ compact: true })), reasons: {}, approvedBy: 'Owner' });
    exec(repo, 'sup-has-d1', { type: 'supplierUnit', date: d1, supplierId: 'supplier-sup-f', unit: 'HAS' });

    // Full mode check: GET /api/summary must NOT structuredClone journal.length > 4
    let largeJournalCloned = false;
    globalThis.structuredClone = value => {
      if (value?.journal && Array.isArray(value.journal) && value.journal.length > 4) largeJournalCloned = true;
      return origClone(value);
    };
    const resD0Full = await get(`${base}/api/summary?workspace=demo&date=${d0}`);
    assert.equal(resD0Full.status, 200);
    assert.equal(largeJournalCloned, false, 'GET /api/summary must not structuredClone full journal');
    const sumD0Full = await resD0Full.json();
    assert.equal(sumD0Full.accounts.some(a => a.accountId === 'supplier-unit-sup-has-d1'), false, 'F-M3-009: d0 summary must exclude d1 supplierUnit');
    assert.deepEqual(sumD0Full, workdaySummary(repo.state(), d0));

    const resD1Full = await get(`${base}/api/summary?workspace=demo&date=${d1}`);
    assert.equal(resD1Full.status, 200);
    const sumD1Full = await resD1Full.json();
    assert.equal(sumD1Full.accounts.some(a => a.accountId === 'supplier-unit-sup-has-d1'), true);
    assert.deepEqual(sumD1Full, workdaySummary(repo.state(), d1));

    // Spill into hot mode (> 96 KiB) and re-verify HTTP GET /api/summary parity and zero structuredClone
    for (let i = 0; i < 250; i++) {
      exec(repo, `hot-pad-${i}`, { type: 'movement', date: d1, accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '1', note: `Uzun sermaye dolgu açıklaması ${i}` });
    }
    assert.equal(repo.cacheInfo().entries, 1);

    largeJournalCloned = false;
    const resD0Hot = await get(`${base}/api/summary?workspace=demo&date=${d0}`);
    assert.equal(resD0Hot.status, 200);
    assert.equal(largeJournalCloned, false);
    const sumD0Hot = await resD0Hot.json();
    assert.equal(sumD0Hot.accounts.some(a => a.accountId === 'supplier-unit-sup-has-d1'), false);
    assert.deepEqual(sumD0Hot, workdaySummary(replay(repo.events()), d0));

    const resD1Hot = await get(`${base}/api/summary?workspace=demo&date=${d1}`);
    assert.equal(resD1Hot.status, 200);
    assert.deepEqual(await resD1Hot.json(), workdaySummary(replay(repo.events()), d1));

    // Error validations preserved
    for (const badDate of ['2026-02-31', '2026-10-31', '2026-11-03']) {
      assert.equal((await get(`${base}/api/summary?workspace=demo&date=${badDate}`)).status, 400);
    }
    assert.equal((await get(`${base}/api/summary?workspace=dukkan`)).status, 400);
  } finally {
    globalThis.structuredClone = origClone;
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    try { rmSync(dataDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch {}
  }
});

// ---------------------------------------------------------------------------
// F-M3-008: quantity('-0', unit, { signed: true }) normalizes -0 to +0
// ---------------------------------------------------------------------------
test('F-M3-008: quantity() returns +0 instead of -0 for all units while preserving validation', () => {
  for (const unit of ['TL', 'USD', 'EUR', 'HAS', 'SILVER', 'GRAM', 'ADET']) {
    const r1 = quantity('-0', unit, { signed: true });
    assert.equal(Object.is(r1, 0), true, `Expected +0 for -0 in ${unit}`);
    const r2 = quantity(' -0 ', unit, { signed: true });
    assert.equal(Object.is(r2, 0), true, `Expected +0 for ' -0 ' in ${unit}`);
  }
  for (const [val, unit] of [['-0.00', 'TL'], ['-0,00', 'USD'], ['-0.000', 'GRAM'], ['-0,000', 'HAS'], ['-0,000', 'SILVER']]) {
    assert.equal(Object.is(quantity(val, unit, { signed: true }), 0), true);
  }
  assert.throws(() => quantity('-0', 'TL', { signed: true, zero: false }), e => e instanceof DomainError);
  assert.throws(() => quantity('-0', 'TL'), e => e instanceof DomainError);
  assert.equal(quantity('-0.01', 'TL', { signed: true }), -1);

  const repo = new Repository(':memory:', 'demo');
  repo.execute({ id: 'open', revision: 0, command: { type: 'opening', date: '2026-11-01', balances: zeroBalances() } });
  exec(repo, 'neg-zero-cust', { type: 'account', date: '2026-11-01', name: 'Sıfır Müşteri', unit: 'TL', opening: '-0' });
  const bal = repo.state().balances['cari-neg-zero-cust'];
  assert.equal(Object.is(bal, 0), true);
  assert.deepEqual(repo.state().balances, replay(repo.events()).balances);
  repo.close();
});

// ---------------------------------------------------------------------------
// CHAL-M33-P2: Mutual undo/amend deadlock & post-return allocation reversal
// ---------------------------------------------------------------------------
test('CHAL-M33-P2: post-return allocations/offsets are reversible & amendable without deadlock while pre-return allocations stay blocked', () => {
  const repo = new Repository(':memory:', 'demo');
  const d0 = '2026-11-01';
  repo.execute({ id: 'open', revision: 0, command: { type: 'opening', date: d0, balances: zeroBalances({ nakit: '500000' }) } });
  exec(repo, 'firm', { type: 'supplierFirm', date: d0, name: 'Ana Toptancı' });
  exec(repo, 'u-has', { type: 'supplierUnit', date: d0, supplierId: 'supplier-firm', unit: 'HAS' });
  exec(repo, 'u-tl', { type: 'supplierUnit', date: d0, supplierId: 'supplier-firm', unit: 'TL' });

  // Case 1: Mutual deadlock break (alloc-2 touching sp-1 + ret-1 chargeLines)
  exec(repo, 'sp-1', {
    type: 'supplierPurchase', date: d0, supplierId: 'supplier-firm',
    items: [{ accountId: 'ceyrek', quantity: '10' }],
    charges: [{ accountId: 'supplier-unit-u-has', quantity: '10.000' }], note: 'Alış 1'
  });
  exec(repo, 'ret-1', {
    type: 'supplierReturn', date: d0, supplierId: 'supplier-firm', originalId: 'sp-1',
    items: [{ lineIndex: 0, quantity: '7' }],
    reductions: [{ accountId: 'supplier-unit-u-has', quantity: '7.000' }],
    credits: [{ accountId: 'supplier-unit-u-has', quantity: '4.000' }], note: 'İade 1 (3 HAS borç)'
  });
  // sp-1 remaining = 3 HAS; ret-1 chargeLines = 3 HAS
  exec(repo, 'pay-1', {
    type: 'supplierPayment', date: d0, supplierId: 'supplier-firm',
    given: [{ accountId: 'nakit', quantity: '10000' }],
    credits: [{ accountId: 'supplier-unit-u-has', quantity: '6.000' }], note: 'Ödeme 1'
  });
  exec(repo, 'alloc-2', {
    type: 'supplierAllocation', date: d0, supplierId: 'supplier-firm',
    allocations: [
      { sourceId: 'pay-1', purchaseId: 'sp-1', accountId: 'supplier-unit-u-has', quantity: '3.000' },
      { sourceId: 'pay-1', purchaseId: 'ret-1', accountId: 'supplier-unit-u-has', quantity: '3.000' }
    ],
    note: 'Karma tahsis'
  });
  assertSupplierEquation(repo.state(), 'supplier-firm');

  // Reversing ret-1 while alloc-2 references it MUST still fail
  assert.throws(() => exec(repo, 'rev-ret-early', { type: 'supplierReverse', date: d0, originalId: 'ret-1', note: 'Erken' }), e => e.status === 400);

  // Preview and supplierAmend on alloc-2 MUST succeed (not deadlocked by ret-1!)
  const preview = repo.supplierDetail({ supplierId: 'supplier-firm', editOriginalId: 'alloc-2' });
  assert.ok(preview.amendment);
  // Over-capacity amend still rejected
  assert.throws(() => exec(repo, 'amend-alloc2-over', {
    type: 'supplierAmend', date: d0, originalId: 'alloc-2', note: 'Fazla',
    replacement: {
      type: 'supplierAllocation', supplierId: 'supplier-firm',
      allocations: [
        { sourceId: 'pay-1', purchaseId: 'sp-1', accountId: 'supplier-unit-u-has', quantity: '4.000' },
        { sourceId: 'pay-1', purchaseId: 'ret-1', accountId: 'supplier-unit-u-has', quantity: '2.000' }
      ],
      note: 'Fazla'
    }
  }), e => e.status === 400);

  exec(repo, 'amend-alloc2-ok', {
    type: 'supplierAmend', date: d0, originalId: 'alloc-2', note: 'Azalt',
    replacement: {
      type: 'supplierAllocation', supplierId: 'supplier-firm',
      allocations: [
        { sourceId: 'pay-1', purchaseId: 'sp-1', accountId: 'supplier-unit-u-has', quantity: '2.000' },
        { sourceId: 'pay-1', purchaseId: 'ret-1', accountId: 'supplier-unit-u-has', quantity: '1.000' }
      ],
      note: 'Azaltıldı'
    }
  });
  assertSupplierEquation(repo.state(), 'supplier-firm');

  // Unwind alloc-2 -> ret-1 -> pay-1 -> sp-1 cleanly
  exec(repo, 'rev-alloc2', { type: 'supplierReverse', date: d0, originalId: 'amend-alloc2-ok', note: 'Geri al' });
  exec(repo, 'rev-ret1', { type: 'supplierReverse', date: d0, originalId: 'ret-1', note: 'İadeyi geri al' });
  exec(repo, 'rev-pay1', { type: 'supplierReverse', date: d0, originalId: 'pay-1', note: 'Ödemeyi geri al' });
  exec(repo, 'rev-sp1', { type: 'supplierReverse', date: d0, originalId: 'sp-1', note: 'Alışı geri al' });
  assertSupplierEquation(repo.state(), 'supplier-firm');

  // Case 2: alloc touching ret availableCreditLines (sourceId: ret) + sp (purchaseId: sp)
  exec(repo, 'sp-2', {
    type: 'supplierPurchase', date: d0, supplierId: 'supplier-firm',
    items: [{ accountId: 'ceyrek', quantity: '10' }],
    charges: [{ accountId: 'supplier-unit-u-has', quantity: '10.000' }], note: 'Alış 2'
  });
  exec(repo, 'ret-2', {
    type: 'supplierReturn', date: d0, supplierId: 'supplier-firm', originalId: 'sp-2',
    items: [{ lineIndex: 0, quantity: '2' }],
    reductions: [{ accountId: 'supplier-unit-u-has', quantity: '2.000' }],
    credits: [{ accountId: 'supplier-unit-u-has', quantity: '3.000' }], note: 'İade 2 (1 HAS net alacak)'
  });
  exec(repo, 'alloc-ret', {
    type: 'supplierAllocation', date: d0, supplierId: 'supplier-firm',
    allocations: [{ sourceId: 'ret-2', purchaseId: 'sp-2', accountId: 'supplier-unit-u-has', quantity: '1.000' }],
    note: 'İade alacağı tahsisi'
  });
  exec(repo, 'rev-alloc-ret', { type: 'supplierReverse', date: d0, originalId: 'alloc-ret', note: 'Tahsis iptal' });
  exec(repo, 'rev-ret2', { type: 'supplierReverse', date: d0, originalId: 'ret-2', note: 'İade 2 iptal' });

  // Case 3: Pre-return vs post-return allocation + supplierOffset targetUses + mixed ret-later
  exec(repo, 'pay-pre', {
    type: 'supplierPayment', date: d0, supplierId: 'supplier-firm',
    given: [{ accountId: 'nakit', quantity: '4000' }], credits: [{ accountId: 'supplier-unit-u-has', quantity: '4.000' }], note: 'Ön ödeme'
  });
  exec(repo, 'alloc-pre', {
    type: 'supplierAllocation', date: d0, supplierId: 'supplier-firm',
    allocations: [{ sourceId: 'pay-pre', purchaseId: 'sp-2', accountId: 'supplier-unit-u-has', quantity: '4.000' }], note: 'İade öncesi tahsis'
  });
  exec(repo, 'ret-3a', {
    type: 'supplierReturn', date: d0, supplierId: 'supplier-firm', originalId: 'sp-2',
    items: [{ lineIndex: 0, quantity: '2' }],
    reductions: [{ accountId: 'supplier-unit-u-has', quantity: '2.000' }],
    credits: [{ accountId: 'supplier-unit-u-has', quantity: '2.000' }], note: 'İade 3a'
  });
  exec(repo, 'pay-post', {
    type: 'supplierPayment', date: d0, supplierId: 'supplier-firm',
    given: [{ accountId: 'nakit', quantity: '2000' }], credits: [{ accountId: 'supplier-unit-u-has', quantity: '2.000' }], note: 'Sonra ödeme'
  });
  exec(repo, 'alloc-post', {
    type: 'supplierAllocation', date: d0, supplierId: 'supplier-firm',
    allocations: [{ sourceId: 'pay-post', purchaseId: 'sp-2', accountId: 'supplier-unit-u-has', quantity: '2.000' }], note: 'İade sonrası tahsis'
  });
  exec(repo, 'tl-credit', {
    type: 'supplierPayment', date: d0, supplierId: 'supplier-firm',
    given: [{ accountId: 'nakit', quantity: '5000' }], credits: [{ accountId: 'supplier-unit-u-tl', quantity: '5000' }], note: 'TL avans'
  });
  exec(repo, 'off-post', {
    type: 'supplierOffset', date: d0, supplierId: 'supplier-firm',
    fromAccountId: 'supplier-unit-u-tl', fromQuantity: '5000',
    toAccountId: 'supplier-unit-u-has', toQuantity: '1.000',
    sourceUses: [{ sourceId: 'tl-credit', quantity: '5000' }],
    targetUses: [{ purchaseId: 'sp-2', quantity: '1.000' }],
    note: 'İade sonrası mahsup'
  });
  exec(repo, 'ret-3b', {
    type: 'supplierReturn', date: d0, supplierId: 'supplier-firm', originalId: 'sp-2',
    items: [{ lineIndex: 0, quantity: '1' }],
    reductions: [],
    credits: [{ accountId: 'supplier-unit-u-has', quantity: '1.000' }], note: 'Sonraki iade 3b'
  });

  // Pre-return alloc-pre MUST remain blocked while ret-3a / ret-3b are active
  assert.throws(() => exec(repo, 'rev-pre-fail', { type: 'supplierReverse', date: d0, originalId: 'alloc-pre', note: 'Yasak' }), e => e.status === 400 && /Önce iade/.test(e.message));
  // Post-return alloc-post is blocked by LATER ret-3b until ret-3b is reversed
  assert.throws(() => exec(repo, 'rev-post-fail', { type: 'supplierReverse', date: d0, originalId: 'alloc-post', note: 'Sonraki iade' }), e => e.status === 400 && /Önce iade/.test(e.message));
  exec(repo, 'rev-ret-3b', { type: 'supplierReverse', date: d0, originalId: 'ret-3b', note: '3b geri al' });
  // Now off-post & alloc-post MUST succeed even while EARLIER ret-3a remains active!
  exec(repo, 'rev-off-post', { type: 'supplierReverse', date: d0, originalId: 'off-post', note: 'Mahsup geri al' });
  exec(repo, 'rev-alloc-post', { type: 'supplierReverse', date: d0, originalId: 'alloc-post', note: 'Sonra tahsis geri al' });
  // Still blocked for pre-return alloc-pre until ret-3a is reversed
  assert.throws(() => exec(repo, 'rev-pre-fail-2', { type: 'supplierReverse', date: d0, originalId: 'alloc-pre', note: 'Yasak' }), e => e.status === 400);
  exec(repo, 'rev-ret-3a', { type: 'supplierReverse', date: d0, originalId: 'ret-3a', note: '3a geri al' });
  exec(repo, 'rev-alloc-pre', { type: 'supplierReverse', date: d0, originalId: 'alloc-pre', note: 'Artık serbest' });

  assertSupplierEquation(repo.state(), 'supplier-firm');
  assert.deepEqual(repo.state().balances, replay(repo.events()).balances);
  repo.close();
});

// ---------------------------------------------------------------------------
// CHAL-M33-P3: supplierLegacyReceiptLink sibling-source reversal & unit isolation
// ---------------------------------------------------------------------------
test('CHAL-M33-P3: supplierLegacyReceiptLink blocks sibling legacy source reversal after unblock without cross-unit or native false positives', () => {
  const repo = new Repository(':memory:', 'demo');
  const d0 = '2026-10-31';
  repo.execute({ id: 'open', revision: 0, command: { type: 'opening', date: d0, balances: zeroBalances({ nakit: '500000', usd: '10000', ceyrek: '50' }) } });
  // Legacy supplier root (TL, +100 TL credit) + child USD account
  appendHistoricalEvent(repo, 'leg-s1', { type: 'account', date: d0, name: 'Eski Toptancı', unit: 'TL', opening: '100', partyType: 'supplier' });
  appendHistoricalEvent(repo, 'leg-s1-usd', { type: 'account', date: d0, parentAccountId: 'cari-leg-s1', unit: 'USD', opening: '0' });
  // Historical v7 sale granting both 100 TL and 20 USD credits to legacy supplier
  appendHistoricalEvent(repo, 'leg-s2', {
    type: 'sale', date: d0,
    items: [{ accountId: 'ceyrek', quantity: '1', value: '500' }],
    received: [], given: [],
    credits: [
      { accountId: 'cari-leg-s1', quantity: '100', valueTL: '100' },
      { accountId: 'cari-leg-s1-usd', quantity: '20', valueTL: '400' }
    ],
    debts: [], counterpartyId: 'cari-leg-s1', counterpartyType: 'supplier', note: 'Tarihsel satış'
  });
  // Historical v5 collection 30 TL from supplier -> unresolved receipt in TL
  appendHistoricalEvent(repo, 'leg-r1', {
    type: 'collection', date: d0, customerAccount: 'cari-leg-s1', target: 'nakit', direction: 'collect', quantity: '30', note: 'Eski tahsilat'
  });

  // Native purchase (100 TL, 20 USD) & native payment (50 TL)
  exec(repo, 'buy-1', {
    type: 'supplierPurchase', date: d0, supplierId: 'cari-leg-s1',
    items: [{ accountId: 'ceyrek', quantity: '2' }],
    charges: [
      { accountId: 'cari-leg-s1', quantity: '100' },
      { accountId: 'cari-leg-s1-usd', quantity: '20' }
    ],
    note: 'Toptancı alış'
  });
  exec(repo, 'native-pay', {
    type: 'supplierPayment', date: d0, supplierId: 'cari-leg-s1',
    given: [{ accountId: 'nakit', quantity: '50' }],
    credits: [{ accountId: 'cari-leg-s1', quantity: '50' }],
    note: 'Yerli ödeme'
  });

  // USD is unblocked: allocate leg-s2 20 USD BEFORE leg-link-1, and allocate native-pay 50 TL
  exec(repo, 'alloc-usd', {
    type: 'supplierAllocation', date: d0, supplierId: 'cari-leg-s1',
    allocations: [{ sourceId: 'leg-s2', purchaseId: 'buy-1', accountId: 'cari-leg-s1-usd', quantity: '20' }],
    note: 'USD tahsis'
  });
  // TL legacy sources are blocked while leg-r1 is unresolved
  assert.throws(() => exec(repo, 'alloc-tl-blocked', {
    type: 'supplierAllocation', date: d0, supplierId: 'cari-leg-s1',
    allocations: [{ sourceId: 'leg-s2', purchaseId: 'buy-1', accountId: 'cari-leg-s1', quantity: '100' }],
    note: 'Blokeli TL tahsis'
  }), e => e.status === 400);

  // Link leg-r1 -> leg-s1 (30 TL) -> unblocks TL legacy sources
  exec(repo, 'leg-link-1', {
    type: 'supplierLegacyReceiptLink', date: d0, supplierId: 'cari-leg-s1',
    originalId: 'leg-r1',
    uses: [{ sourceId: 'leg-s1', accountId: 'cari-leg-s1', quantity: '30' }]
  });
  // Native TL payment allocation does NOT block reversing leg-link-1 (no native-source false positive)
  exec(repo, 'alloc-native', {
    type: 'supplierAllocation', date: d0, supplierId: 'cari-leg-s1',
    allocations: [{ sourceId: 'native-pay', purchaseId: 'buy-1', accountId: 'cari-leg-s1', quantity: '50' }],
    note: 'Yerli tahsis'
  });

  // Verify reversing leg-link-1 succeeds when ONLY USD (leg-s2 pre-link) or native-pay (TL) was used (no cross-unit or native false positive)
  exec(repo, 'rev-link-ok', { type: 'supplierReverse', date: d0, originalId: 'leg-link-1', note: 'Bağlantı testi' });
  // Re-link so TL legacy sources are unblocked again
  exec(repo, 'leg-link-2', {
    type: 'supplierLegacyReceiptLink', date: d0, supplierId: 'cari-leg-s1',
    originalId: 'leg-r1',
    uses: [{ sourceId: 'leg-s1', accountId: 'cari-leg-s1', quantity: '30' }]
  });

  // Now allocate sibling legacy source leg-s2 (50 TL remaining capacity on buy-1)
  exec(repo, 'leg-alloc-s2', {
    type: 'supplierAllocation', date: d0, supplierId: 'cari-leg-s1',
    allocations: [{ sourceId: 'leg-s2', purchaseId: 'buy-1', accountId: 'cari-leg-s1', quantity: '50' }],
    note: 'Kardeş eski kaynak tahsisi'
  });

  // Reversing leg-link-2 MUST be rejected while leg-alloc-s2 is active!
  assert.throws(
    () => exec(repo, 'rev-link-blocked', { type: 'supplierReverse', date: d0, originalId: 'leg-link-2', note: 'Yasak geri alma' }),
    e => e.status === 400 && /kullanılmış/.test(e.message)
  );

  // Reverse leg-alloc-s2 -> now reversing leg-link-2 succeeds and leg-r1 returns to unresolvedReceipts
  exec(repo, 'rev-alloc-s2', { type: 'supplierReverse', date: d0, originalId: 'leg-alloc-s2', note: 'Tahsis iptal' });
  exec(repo, 'rev-link-final', { type: 'supplierReverse', date: d0, originalId: 'leg-link-2', note: 'Eşleme iptal' });

  const docsAfter = supplierDocuments(repo.state(), 'cari-leg-s1');
  assert.equal(docsAfter.unresolvedReceipts.length, 1);
  assert.equal(docsAfter.unresolvedReceipts[0].id, 'leg-r1');
  assertSupplierEquation(repo.state(), 'cari-leg-s1');
  assert.deepEqual(repo.state().balances, replay(repo.events()).balances);
  repo.close();
});

// ---------------------------------------------------------------------------
// Iteration 2 Regressions: Hot-mode parity fixes (#1-#5) & CHAL-M33-P2 amend-return (#6)
// ---------------------------------------------------------------------------
test('F-M3-001 iter2: hot-mode supplier execute({compact:false}), :memory:+cacheMaxBytes:1, :undo/:return collision & legacy supplier promotion', () => {
  const d0 = '2026-11-01';

  // A) :memory: + cacheMaxBytes: 1 across opening todaysCount, restore(), state({compact:false}), journalPage(), workdaySummary()
  const memOne = new Repository(':memory:', 'demo', { cacheMaxBytes: 1 });
  const openRes = memOne.execute({ id: 'open', revision: 0, command: { type: 'opening', date: d0, balances: zeroBalances({ nakit: '5000' }) } }, { compact: true });
  assert.equal(openRes.state.overview.todaysCount, 1, 'opening in hot mode must count towards todaysCount');
  assert.equal(memOne.cacheInfo().entries, 0);
  assert.equal(memOne.cacheInfo().estimatedBytes, 0);

  exec(memOne, 'mov-1', { type: 'movement', date: d0, accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '100', note: 'Ek sermaye' });
  const backup = memOne.backup();
  memOne.close();

  const memRestored = new Repository(':memory:', 'demo', { cacheMaxBytes: 1 });
  const restoredFull = memRestored.restore({ backup, revision: 0, confirmation: 'GERİ YÜKLE' }, { compact: false });
  assert.equal(restoredFull.journal.length, 2);
  assert.equal(memRestored.state({ compact: false }).journal.length, 2);
  assert.equal(memRestored.journalPage({ scope: 'all', limit: 25 }).total, 2);
  const sumMem = memRestored.workdaySummary(d0);
  assert.equal(sumMem.accounts.find(a => a.accountId === 'nakit').opening, 500000);
  assert.equal(sumMem.accounts.find(a => a.accountId === 'nakit').incoming, 10000);
  assert.deepEqual(sumMem, workdaySummary(replay(memRestored.events()), d0));
  assert.equal(memRestored.cacheInfo().entries, 0);
  assert.equal(memRestored.cacheInfo().estimatedBytes, 0);
  memRestored.close();

  // B) File-backed hot mode: supplier execute({compact:false}), :undo/:return collision, legacy accountUpdate promotion
  const dir = mkdtempSync(join(tempRoot, 'm41-iter2-hot-'));
  const dbPath = join(dir, 'hot-parity.sqlite');
  try {
    const repo = new Repository(dbPath, 'demo', { cacheMaxBytes: 96 * 1024 });
    repo.execute({ id: 'open', revision: 0, command: { type: 'opening', date: d0, balances: zeroBalances({ nakit: '500000', ceyrek: '50' }) } });
    exec(repo, 'sup-f', { type: 'supplierFirm', date: d0, name: 'Kaya Toptan' });
    exec(repo, 'sup-tl', { type: 'supplierUnit', date: d0, supplierId: 'supplier-sup-f', unit: 'TL' });
    exec(repo, 'sp-1', {
      type: 'supplierPurchase', date: d0, supplierId: 'supplier-sup-f',
      items: [{ accountId: 'ceyrek', quantity: '2' }], charges: [{ accountId: 'supplier-unit-sup-tl', quantity: '1000' }], note: 'Alış'
    });
    exec(repo, 'spay-1', {
      type: 'supplierPayment', date: d0, supplierId: 'supplier-sup-f',
      given: [{ accountId: 'nakit', quantity: '400' }], credits: [{ accountId: 'supplier-unit-sup-tl', quantity: '400' }], note: 'Ödeme'
    });
    // Legacy untyped account (v3) created before spill
    appendHistoricalEvent(repo, 'leg-acc', { type: 'account', date: d0, name: 'Belirsiz Eski Cari', unit: 'TL', opening: '0' });
    // Retail sale for retailExchange collision test
    exec(repo, 'ret-sale', {
      type: 'sale', date: d0, items: [{ accountId: 'ceyrek', quantity: '1', value: '5000' }],
      payments: [{ accountId: 'nakit', quantity: '5000' }], credits: [], scrap: [], note: 'Değişim için'
    });
    // Pre-seed collision markers in non-supplier movements
    exec(repo, 'collide:undo', { type: 'movement', date: d0, accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '1', note: 'Çakışma undo' });
    exec(repo, 'ex-collide:return', { type: 'movement', date: d0, accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '1', note: 'Çakışma return' });

    // Spill into hot mode
    for (let i = 0; i < 250; i++) {
      exec(repo, `pad-${i}`, { type: 'movement', date: d0, accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '0.01', note: `Hot dolgu satırı ${i} ekstra uzun metin` });
    }
    assert.equal(repo.cacheInfo().entries, 1);

    // 1. Hot-mode execute(supplierAllocation / supplierAmend, { compact: false }) must return FULL journal
    const rev1 = repo.state({ compact: true }).revision;
    const allocFull = repo.execute({
      id: 'salloc-1', revision: rev1,
      command: { type: 'supplierAllocation', date: d0, supplierId: 'supplier-sup-f', allocations: [{ sourceId: 'spay-1', purchaseId: 'sp-1', accountId: 'supplier-unit-sup-tl', quantity: '400' }], note: 'Tahsis' }
    }, { compact: false });
    assert.equal(allocFull.state.journal.length, repo.state({ compact: false }).journal.length);

    const rev2 = allocFull.state.revision;
    const amendFull = repo.execute({
      id: 'samend-1', revision: rev2,
      command: {
        type: 'supplierAmend', date: d0, originalId: 'salloc-1', note: 'Düzeltme',
        replacement: { type: 'supplierAllocation', supplierId: 'supplier-sup-f', allocations: [{ sourceId: 'spay-1', purchaseId: 'sp-1', accountId: 'supplier-unit-sup-tl', quantity: '300' }], note: 'Güncel tahsis' }
      }
    }, { compact: false });
    assert.equal(amendFull.state.journal.length, repo.state({ compact: false }).journal.length);
    assert.equal(amendFull.state.journal.length, replay(repo.events()).journal.length);

    // 2. ID collision for :undo and :return in hot mode MUST throw DomainError (400), never ERR_SQLITE_ERROR
    const revCol = repo.state({ compact: true }).revision;
    assert.throws(
      () => repo.execute({
        id: 'collide', revision: revCol,
        command: {
          type: 'supplierAmend', date: d0, originalId: 'samend-1', note: 'Çakışmalı',
          replacement: { type: 'supplierAllocation', supplierId: 'supplier-sup-f', allocations: [{ sourceId: 'spay-1', purchaseId: 'sp-1', accountId: 'supplier-unit-sup-tl', quantity: '200' }], note: 'Yeni' }
        }
      }),
      e => e instanceof DomainError && e.status === 400
    );
    assert.throws(
      () => repo.execute({
        id: 'ex-collide', revision: revCol,
        command: {
          type: 'retailExchange', date: d0, originalId: 'ret-sale', note: 'Değişim çakışma',
          returnItems: [{ lineIndex: 0, quantity: '1', value: '5000' }],
          newItems: [{ accountId: 'ceyrek', quantity: '2', value: '8000' }],
          received: [{ accountId: 'nakit', quantity: '3000' }], refunds: []
        }
      }),
      e => e instanceof DomainError && e.status === 400
    );

    // 3. Hot-mode trade on legacy untyped account followed by accountUpdate promotion to partyType: 'supplier'
    exec(repo, 'leg-sale', {
      type: 'sale', date: d0, items: [{ accountId: 'ceyrek', quantity: '1', value: '5000' }],
      received: [{ accountId: 'nakit', quantity: '2000' }], given: [],
      credits: [{ accountId: 'cari-leg-acc', quantity: '3000' }], debts: [],
      counterpartyId: 'cari-leg-acc', counterpartyType: 'customer', note: 'Eski cari satışı'
    });
    exec(repo, 'promote-leg', { type: 'accountUpdate', date: d0, accountId: 'cari-leg-acc', partyType: 'supplier' });

    const expectedParties = projectSupplierParties(replay(repo.events()));
    const hotParties = repo.state({ compact: true }).supplierParties;
    assert.deepEqual(
      hotParties.find(p => p.id === 'cari-leg-acc'),
      expectedParties.find(p => p.id === 'cari-leg-acc')
    );
    assert.equal(hotParties.find(p => p.id === 'cari-leg-acc').lastEvent.id, 'leg-sale');

    // Survives snapshot close & reopen
    repo.close();
    const reopened = new Repository(dbPath, 'demo', { cacheMaxBytes: 96 * 1024 });
    assert.deepEqual(
      reopened.state({ compact: true }).supplierParties.find(p => p.id === 'cari-leg-acc'),
      expectedParties.find(p => p.id === 'cari-leg-acc')
    );
    reopened.close();
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch {}
  }
});

test('CHAL-M33-P2 iter2: amending an earlier supplierReturn preserves origin order and does not retroactively block post-return allocations/offsets', () => {
  const repo = new Repository(':memory:', 'demo');
  const d0 = '2026-11-01', d1 = '2026-11-02';
  repo.execute({ id: 'open', revision: 0, command: { type: 'opening', date: d0, balances: zeroBalances({ nakit: '500000' }) } });
  exec(repo, 'firm', { type: 'supplierFirm', date: d0, name: 'Test Toptancı' });
  exec(repo, 'u-has', { type: 'supplierUnit', date: d0, supplierId: 'supplier-firm', unit: 'HAS' });
  exec(repo, 'u-tl', { type: 'supplierUnit', date: d0, supplierId: 'supplier-firm', unit: 'TL' });

  exec(repo, 'sp-1', {
    type: 'supplierPurchase', date: d0, supplierId: 'supplier-firm',
    items: [{ accountId: 'ceyrek', quantity: '10' }],
    charges: [{ accountId: 'supplier-unit-u-has', quantity: '10.000' }], note: 'Alış 1'
  });
  exec(repo, 'pay-pre', {
    type: 'supplierPayment', date: d0, supplierId: 'supplier-firm',
    given: [{ accountId: 'nakit', quantity: '2000' }], credits: [{ accountId: 'supplier-unit-u-has', quantity: '2.000' }], note: 'Ön ödeme'
  });
  exec(repo, 'alloc-pre', {
    type: 'supplierAllocation', date: d0, supplierId: 'supplier-firm',
    allocations: [{ sourceId: 'pay-pre', purchaseId: 'sp-1', accountId: 'supplier-unit-u-has', quantity: '2.000' }], note: 'İade öncesi tahsis'
  });
  exec(repo, 'ret-1', {
    type: 'supplierReturn', date: d0, supplierId: 'supplier-firm', originalId: 'sp-1',
    items: [{ lineIndex: 0, quantity: '3' }],
    reductions: [{ accountId: 'supplier-unit-u-has', quantity: '3.000' }],
    credits: [{ accountId: 'supplier-unit-u-has', quantity: '3.000' }], note: 'İade 1'
  });
  exec(repo, 'pay-post', {
    type: 'supplierPayment', date: d0, supplierId: 'supplier-firm',
    given: [{ accountId: 'nakit', quantity: '2000' }], credits: [{ accountId: 'supplier-unit-u-has', quantity: '2.000' }], note: 'Sonra ödeme'
  });
  exec(repo, 'alloc-post', {
    type: 'supplierAllocation', date: d0, supplierId: 'supplier-firm',
    allocations: [{ sourceId: 'pay-post', purchaseId: 'sp-1', accountId: 'supplier-unit-u-has', quantity: '2.000' }], note: 'İade sonrası tahsis'
  });
  exec(repo, 'tl-adv', {
    type: 'supplierPayment', date: d0, supplierId: 'supplier-firm',
    given: [{ accountId: 'nakit', quantity: '5000' }], credits: [{ accountId: 'supplier-unit-u-tl', quantity: '5000' }], note: 'TL avans'
  });
  exec(repo, 'off-post', {
    type: 'supplierOffset', date: d0, supplierId: 'supplier-firm',
    fromAccountId: 'supplier-unit-u-tl', fromQuantity: '5000',
    toAccountId: 'supplier-unit-u-has', toQuantity: '1.000',
    sourceUses: [{ sourceId: 'tl-adv', quantity: '5000' }],
    targetUses: [{ purchaseId: 'sp-1', quantity: '1.000' }], note: 'İade sonrası mahsup'
  });
  exec(repo, 'pay-emb', {
    type: 'supplierPayment', date: d0, supplierId: 'supplier-firm',
    given: [{ accountId: 'nakit', quantity: '1000' }], credits: [{ accountId: 'supplier-unit-u-has', quantity: '1.000' }], note: 'Gömülü için'
  });
  exec(repo, 'sp-emb', {
    type: 'supplierPurchase', date: d0, supplierId: 'supplier-firm',
    items: [{ accountId: 'ceyrek', quantity: '1' }],
    charges: [{ accountId: 'supplier-unit-u-has', quantity: '1.000' }],
    allocations: [{ sourceId: 'pay-emb', purchaseId: 'sp-1', accountId: 'supplier-unit-u-has', quantity: '1.000' }], note: 'Gömülü tahsisli alış'
  });

  // Amend ret-1 on next day after post-return alloc-post / off-post / sp-emb
  exec(repo, 'close-d0', { type: 'close', date: d0, counts: closeCounts(repo.state({ compact: true })), reasons: {}, approvedBy: 'Owner' });
  exec(repo, 'amend-ret1', {
    type: 'supplierAmend', date: d1, originalId: 'ret-1', note: 'İade güncellendi',
    replacement: {
      type: 'supplierReturn', supplierId: 'supplier-firm', originalId: 'sp-1',
      items: [{ lineIndex: 0, quantity: '2' }],
      reductions: [{ accountId: 'supplier-unit-u-has', quantity: '2.000' }],
      credits: [{ accountId: 'supplier-unit-u-has', quantity: '2.000' }], note: '2 adet iade'
    }
  });
  assertSupplierEquation(repo.state(), 'supplier-firm');

  // Pre-return alloc-pre MUST remain blocked by amended ret-1
  assert.throws(
    () => exec(repo, 'rev-pre-blocked', { type: 'supplierReverse', date: d1, originalId: 'alloc-pre', note: 'Yasak' }),
    e => e.status === 400 && /Önce iade/.test(e.message)
  );

  // Create ret-2 AFTER alloc-post -> ret-2 blocks alloc-post until ret-2 is reversed
  exec(repo, 'ret-2', {
    type: 'supplierReturn', date: d1, supplierId: 'supplier-firm', originalId: 'sp-1',
    items: [{ lineIndex: 0, quantity: '1' }],
    reductions: [], credits: [{ accountId: 'supplier-unit-u-has', quantity: '1.000' }], note: 'Sonraki iade 2'
  });
  assert.throws(
    () => exec(repo, 'rev-post-blocked-by-ret2', { type: 'supplierReverse', date: d1, originalId: 'alloc-post', note: 'ret-2 aktif' }),
    e => e.status === 400 && /Önce iade/.test(e.message)
  );
  exec(repo, 'rev-ret2', { type: 'supplierReverse', date: d1, originalId: 'ret-2', note: 'ret-2 iptal' });

  // Now post-return sp-emb, off-post, and alloc-post MUST all reverse cleanly while amend-ret1 remains active!
  exec(repo, 'rev-sp-emb', { type: 'supplierReverse', date: d1, originalId: 'sp-emb', note: 'Gömülü geri al' });
  exec(repo, 'rev-off-post', { type: 'supplierReverse', date: d1, originalId: 'off-post', note: 'Mahsup geri al' });
  exec(repo, 'rev-alloc-post', { type: 'supplierReverse', date: d1, originalId: 'alloc-post', note: 'Post tahsis geri al' });

  // Pre-return alloc-pre STILL stays blocked until amend-ret1 is reversed
  assert.throws(
    () => exec(repo, 'rev-pre-still-blocked', { type: 'supplierReverse', date: d1, originalId: 'alloc-pre', note: 'Hala yasak' }),
    e => e.status === 400 && /Önce iade/.test(e.message)
  );
  exec(repo, 'rev-amend-ret1', { type: 'supplierReverse', date: d1, originalId: 'amend-ret1', note: 'İadeyi geri al' });
  exec(repo, 'rev-alloc-pre', { type: 'supplierReverse', date: d1, originalId: 'alloc-pre', note: 'Artık serbest' });

  assertSupplierEquation(repo.state(), 'supplier-firm');
  assert.deepEqual(repo.state().balances, replay(repo.events()).balances);
  repo.close();
});

// ---------------------------------------------------------------------------
// Iteration 3 Regressions: accountUpdate match_kind=1 hot/full parity & CHAL-M33-P3
// ---------------------------------------------------------------------------
test('F-M3-001 iter3: cached hot-mode accountUpdate promote/demote & counterpartyId sale+saleReturn keep journalPage parity across hot-v1 snapshot reopen', () => {
  const dir = mkdtempSync(join(tempRoot, 'm41-iter3-acct-'));
  const hotPath = join(dir, 'hot.sqlite');
  const fullPath = join(dir, 'full.sqlite');
  const d0 = '2026-11-01';
  try {
    const hot = new Repository(hotPath, 'demo', { cacheMaxBytes: 96 * 1024 });
    const full = new Repository(fullPath, 'demo');
    const execBoth = (id, command) => {
      exec(hot, id, command);
      exec(full, id, command);
    };

    const openCmd = { type: 'opening', date: d0, balances: zeroBalances({ nakit: '500000', ceyrek: '500' }) };
    hot.execute({ id: 'open', revision: 0, command: openCmd });
    full.execute({ id: 'open', revision: 0, command: openCmd });

    // Finding A setup: classic cash-only sale (customerAccount) + saleReturn
    execBoth('c1', { type: 'account', date: d0, name: 'Müşteri Klasik', unit: 'TL', partyType: 'customer', opening: '0' });
    execBoth('s1', {
      type: 'sale', date: d0,
      items: [{ accountId: 'ceyrek', quantity: '1', value: '5000' }],
      cash: '5000', pos: '0', bank: '0',
      scrap: [], customerAccount: 'cari-c1', note: 'Klasik peşin satış'
    });
    execBoth('sr1', {
      type: 'saleReturn', date: d0, originalId: 's1',
      items: [{ lineIndex: 0, quantity: '1', value: '5000' }],
      refunds: [{ accountId: 'nakit', quantity: '5000' }], note: 'Klasik iade'
    });

    // Finding B setup: v7 cash-only sale (counterpartyId) + saleReturn
    execBoth('c4', { type: 'account', date: d0, name: 'Müşteri Counterparty', unit: 'TL', partyType: 'customer', opening: '0' });
    execBoth('s4', {
      type: 'sale', date: d0,
      items: [{ accountId: 'ceyrek', quantity: '1', value: '5000' }],
      received: [{ accountId: 'nakit', quantity: '5000' }],
      given: [], credits: [], debts: [],
      counterpartyId: 'cari-c4', counterpartyType: 'customer', note: 'v7 peşin satış'
    });
    execBoth('sr4', {
      type: 'saleReturn', date: d0, originalId: 's4',
      items: [{ lineIndex: 0, quantity: '1', value: '5000' }],
      refunds: [{ accountId: 'nakit', quantity: '5000' }], note: 'v7 iade'
    });

    // Spill > 500 events so hot cache stays resident in hot mode (no eviction) & snapshot-eligible
    for (let i = 0; i < 520; i++) {
      execBoth(`pad-${i}`, {
        type: 'movement', date: d0, accountId: 'nakit', direction: 'in', category: 'Sermaye',
        quantity: '0.01', note: `Iter3 hot dolgu ${i} metni`
      });
    }
    assert.equal(hot.cacheInfo().entries, 1);
    assert.ok(hot.journalPage({ scope: 'all', limit: 1 }).total > 500);

    const idsFor = (repo, accountId) => repo.journalPage({ scope: 'all', accountId, limit: 25 }).items.map(e => e.id);

    // Baseline before promote
    assert.deepEqual(idsFor(hot, 'cari-c1'), ['sr1', 's1', 'c1']);
    assert.deepEqual(idsFor(hot, 'cari-c1'), idsFor(full, 'cari-c1'));
    assert.deepEqual(idsFor(hot, 'cari-c4'), ['sr4', 's4', 'c4']);
    assert.deepEqual(idsFor(hot, 'cari-c4'), idsFor(full, 'cari-c4'));

    // Finding A: Promote c1 -> supplier, then Demote c1 -> customer
    execBoth('prom-c1', { type: 'accountUpdate', date: d0, accountId: 'cari-c1', partyType: 'supplier' });
    assert.deepEqual(idsFor(hot, 'cari-c1'), ['c1']);
    assert.deepEqual(idsFor(hot, 'cari-c1'), idsFor(full, 'cari-c1'));

    execBoth('dem-c1', { type: 'accountUpdate', date: d0, accountId: 'cari-c1', partyType: 'customer' });
    assert.deepEqual(idsFor(hot, 'cari-c1'), ['sr1', 's1', 'c1']);
    assert.deepEqual(idsFor(hot, 'cari-c1'), idsFor(full, 'cari-c1'));

    // Finding B: Promote c4 (counterpartyId sale + saleReturn) -> supplier
    execBoth('prom-c4', { type: 'accountUpdate', date: d0, accountId: 'cari-c4', partyType: 'supplier' });
    assert.deepEqual(idsFor(hot, 'cari-c4'), ['sr4', 's4', 'c4']);
    assert.deepEqual(idsFor(hot, 'cari-c4'), idsFor(full, 'cari-c4'));

    // Close and reopen from hot-v1 snapshot -> must preserve exact parity without scanning events
    hot.close();
    const reopened = new Repository(hotPath, 'demo', { cacheMaxBytes: 96 * 1024 });
    const origEvents = reopened.events.bind(reopened);
    reopened.events = () => assert.fail('Reopen must load from hot-v1 snapshot');
    try {
      assert.deepEqual(idsFor(reopened, 'cari-c1'), ['sr1', 's1', 'c1']);
      assert.deepEqual(idsFor(reopened, 'cari-c1'), idsFor(full, 'cari-c1'));
      assert.deepEqual(idsFor(reopened, 'cari-c4'), ['sr4', 's4', 'c4']);
      assert.deepEqual(idsFor(reopened, 'cari-c4'), idsFor(full, 'cari-c4'));
    } finally {
      reopened.events = origEvents;
      reopened.close();
      full.close();
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch {}
  }
});

test('CHAL-M33-P3 iter3: pre-link native allocation and offset amended post-link to sibling legacy source block supplierReverse(leg-link) until unlinked', () => {
  const repo = new Repository(':memory:', 'demo');
  const d0 = '2026-10-31';
  repo.execute({ id: 'open', revision: 0, command: { type: 'opening', date: d0, balances: zeroBalances({ nakit: '500000', ceyrek: '50' }) } });

  appendHistoricalEvent(repo, 'leg-s1', { type: 'account', date: d0, name: 'Eski Toptancı 2', unit: 'TL', opening: '30', partyType: 'supplier' });
  appendHistoricalEvent(repo, 'leg-s1-usd', { type: 'account', date: d0, parentAccountId: 'cari-leg-s1', unit: 'USD', opening: '0' });
  appendHistoricalEvent(repo, 'leg-s2', {
    type: 'sale', date: d0,
    items: [{ accountId: 'ceyrek', quantity: '1', value: '100' }],
    received: [], given: [],
    credits: [{ accountId: 'cari-leg-s1', quantity: '100', valueTL: '100' }],
    debts: [], counterpartyId: 'cari-leg-s1', counterpartyType: 'supplier', note: 'Tarihsel satış'
  });
  appendHistoricalEvent(repo, 'leg-r1', {
    type: 'collection', date: d0, customerAccount: 'cari-leg-s1', target: 'nakit', direction: 'collect', quantity: '30', note: 'Eski tahsilat'
  });

  exec(repo, 'buy-1', {
    type: 'supplierPurchase', date: d0, supplierId: 'cari-leg-s1',
    items: [{ accountId: 'ceyrek', quantity: '2' }],
    charges: [
      { accountId: 'cari-leg-s1', quantity: '100' },
      { accountId: 'cari-leg-s1-usd', quantity: '20' }
    ],
    note: 'Toptancı alış'
  });
  exec(repo, 'native-pay', {
    type: 'supplierPayment', date: d0, supplierId: 'cari-leg-s1',
    given: [{ accountId: 'nakit', quantity: '100' }],
    credits: [{ accountId: 'cari-leg-s1', quantity: '100' }],
    note: 'Yerli ödeme'
  });

  // Pre-link native allocation AND pre-link native offset
  exec(repo, 'alloc-pre-link', {
    type: 'supplierAllocation', date: d0, supplierId: 'cari-leg-s1',
    allocations: [{ sourceId: 'native-pay', purchaseId: 'buy-1', accountId: 'cari-leg-s1', quantity: '50' }],
    note: 'Bağ öncesi yerli tahsis'
  });
  exec(repo, 'off-pre-link', {
    type: 'supplierOffset', date: d0, supplierId: 'cari-leg-s1',
    fromAccountId: 'cari-leg-s1', fromQuantity: '50',
    toAccountId: 'cari-leg-s1-usd', toQuantity: '1',
    sourceUses: [{ sourceId: 'native-pay', quantity: '50' }],
    targetUses: [{ purchaseId: 'buy-1', quantity: '1' }],
    note: 'Bağ öncesi yerli mahsup'
  });

  // Link leg-r1 -> leg-s1 -> unblocks TL legacy sources (leg-s2)
  exec(repo, 'leg-link-1', {
    type: 'supplierLegacyReceiptLink', date: d0, supplierId: 'cari-leg-s1',
    originalId: 'leg-r1', uses: [{ sourceId: 'leg-s1', accountId: 'cari-leg-s1', quantity: '30' }]
  });

  // 1) Amend pre-link allocation post-link to consume sibling legacy source leg-s2
  exec(repo, 'amend-alloc-to-legacy', {
    type: 'supplierAmend', date: d0, originalId: 'alloc-pre-link', note: 'Kardeş eski kaynağa geçir',
    replacement: {
      type: 'supplierAllocation', supplierId: 'cari-leg-s1',
      allocations: [{ sourceId: 'leg-s2', purchaseId: 'buy-1', accountId: 'cari-leg-s1', quantity: '50' }],
      note: 'leg-s2 tahsisi'
    }
  });
  assert.throws(
    () => exec(repo, 'rev-link-blocked-alloc', { type: 'supplierReverse', date: d0, originalId: 'leg-link-1', note: 'Yasak' }),
    e => e instanceof DomainError && e.status === 400 && /kullanılmış/.test(e.message)
  );

  // Amend away from leg-s2 (back to native-pay) -> unblocks leg-link-1
  exec(repo, 'amend-alloc-back-native', {
    type: 'supplierAmend', date: d0, originalId: 'amend-alloc-to-legacy', note: 'Yerliye dön',
    replacement: {
      type: 'supplierAllocation', supplierId: 'cari-leg-s1',
      allocations: [{ sourceId: 'native-pay', purchaseId: 'buy-1', accountId: 'cari-leg-s1', quantity: '50' }],
      note: 'Tekrar yerli tahsis'
    }
  });
  exec(repo, 'rev-link-after-alloc-switch', { type: 'supplierReverse', date: d0, originalId: 'leg-link-1', note: 'Artık serbest' });
  assert.deepEqual(supplierDocuments(repo.state(), 'cari-leg-s1').unresolvedReceipts.map(r => r.id), ['leg-r1']);

  // Re-link for Case 2 (supplierOffset)
  exec(repo, 'leg-link-2', {
    type: 'supplierLegacyReceiptLink', date: d0, supplierId: 'cari-leg-s1',
    originalId: 'leg-r1', uses: [{ sourceId: 'leg-s1', accountId: 'cari-leg-s1', quantity: '30' }]
  });

  // 2) Amend pre-link offset post-link to consume sibling legacy source leg-s2
  exec(repo, 'amend-off-to-legacy', {
    type: 'supplierAmend', date: d0, originalId: 'off-pre-link', note: 'Mahsubu leg-s2 ye geçir',
    replacement: {
      type: 'supplierOffset', supplierId: 'cari-leg-s1',
      fromAccountId: 'cari-leg-s1', fromQuantity: '50',
      toAccountId: 'cari-leg-s1-usd', toQuantity: '1',
      sourceUses: [{ sourceId: 'leg-s2', quantity: '50' }],
      targetUses: [{ purchaseId: 'buy-1', quantity: '1' }],
      note: 'leg-s2 mahsup'
    }
  });
  assert.throws(
    () => exec(repo, 'rev-link-blocked-off', { type: 'supplierReverse', date: d0, originalId: 'leg-link-2', note: 'Yasak' }),
    e => e instanceof DomainError && e.status === 400 && /kullanılmış/.test(e.message)
  );

  // Reverse amend-off-to-legacy -> unblocks leg-link-2
  exec(repo, 'rev-amend-off', { type: 'supplierReverse', date: d0, originalId: 'amend-off-to-legacy', note: 'Mahsup iptal' });
  exec(repo, 'rev-link-final-2', { type: 'supplierReverse', date: d0, originalId: 'leg-link-2', note: 'Eşleme iptal' });

  assert.deepEqual(supplierDocuments(repo.state(), 'cari-leg-s1').unresolvedReceipts.map(r => r.id), ['leg-r1']);
  assertSupplierEquation(repo.state(), 'cari-leg-s1');
  assert.deepEqual(repo.state().balances, replay(repo.events()).balances);
  repo.close();
});

test('Scale C summary heap fix: GET /api/summary?paginated=1 slices and filters accurately in full & hot modes while preserving unpaginated API', async t => {
  const dataDirectory = mkdtempSync(join(tempRoot, 'm4-summary-paginated-'));
  const { server, repositories } = createApp({ dataDirectory });
  t.after(async () => { server.closeAllConnections?.(); await new Promise(r => server.close(r)); for (const r of repositories.values()) { try { r.close(); } catch {} } rmSync(dataDirectory, { recursive: true, force: true }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await authenticateTestOwner(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  repositories.get('demo')?.close();
  const repo = new Repository(join(dataDirectory, 'demo.sqlite'), 'demo', { cacheMaxBytes: 96 * 1024 });
  repositories.set('demo', repo);
  const d0 = '2026-11-10';
  repo.execute({ id: 'init-open', revision: 0, command: { type: 'opening', date: d0, balances: zeroBalances({ nakit: '100000' }) } });
  for (let i = 0; i < 65; i++) {
    exec(repo, `cust-${i}`, {
      type: 'account', date: d0, name: i === 12 ? 'Şahin Çelik Özel' : `Müşteri ${String(i).padStart(3, '0')}`,
      unit: 'TL', kind: 'receivable', partyType: 'customer', opening: '0'
    });
  }
  const resFullUnpaged = await fetch(`${base}/api/summary?workspace=demo&date=${d0}`, { headers: { connection: 'close' } });
  assert.equal(resFullUnpaged.status, 200);
  const fullUnpaged = await resFullUnpaged.json();
  assert.equal(fullUnpaged.paginated, undefined);
  assert.ok(fullUnpaged.accounts.length >= 65);

  const resPage1 = await fetch(`${base}/api/summary?workspace=demo&date=${d0}&paginated=1&page=1&pageSize=50`, { headers: { connection: 'close' } });
  assert.equal(resPage1.status, 200);
  const page1 = await resPage1.json();
  assert.equal(page1.paginated, true);
  assert.equal(page1.page, 1);
  assert.equal(page1.pageSize, 50);
  assert.equal(page1.accounts.length, 50);
  assert.equal(page1.totalAccounts, fullUnpaged.accounts.length);
  assert.deepEqual(page1.totals, fullUnpaged.totals);

  const resSearch = await fetch(`${base}/api/summary?workspace=demo&date=${d0}&paginated=1&q=sahin&kind=customer&unit=TL`, { headers: { connection: 'close' } });
  assert.equal(resSearch.status, 200);
  const searchBody = await resSearch.json();
  assert.equal(searchBody.paginated, true);
  assert.equal(searchBody.filteredAccounts, 1);
  assert.equal(searchBody.accounts[0].accountId, 'cari-cust-12');

  const resBadPage = await fetch(`${base}/api/summary?workspace=demo&date=${d0}&paginated=1&page=0`, { headers: { connection: 'close' } });
  assert.equal(resBadPage.status, 400);
});
