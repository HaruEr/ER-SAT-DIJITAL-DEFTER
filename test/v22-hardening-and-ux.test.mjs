import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyEvent, emptyState, eventVersion, replay, workdaySummary } from '../domain.mjs';
import { supplierDocuments } from '../supplier-ledger.mjs';
import { checkoutState, workerCountCatalog } from '../editor-access.mjs';
import { normalizeJournalOptions } from '../ledger-view.mjs';
import { Repository } from '../repository.mjs';
import { ReportRepository } from '../report-repository.mjs';
import { createApp } from '../server.mjs';

const DATE = '2026-06-15';
const DAY2 = '2026-06-16';
const OWNER = { id: '11111111-1111-4111-8111-111111111111', name: 'Yönetici', role: 'owner' };
const EMP1 = { id: '22222222-2222-4222-8222-222222222222', name: 'Tezgahtar 1', role: 'employee' };
const EMP2 = { id: '33333333-3333-4333-8333-333333333333', name: 'Tezgahtar 2', role: 'employee' };

function openingCommand(date = DATE) {
  return {
    type: 'opening',
    date,
    banks: [{ name: 'Ana Banka', unit: 'TL', opening: '50000' }],
    balances: {
      nakit: '100000', usd: '5000', eur: '3000',
      bilezik22: '500', taki14: '200', taki22: '200',
      hurda22: '100', hurda21: '0', hurda18: '0', hurda14: '50', hurda8: '0', hurda24: '50',
      ceyrek: '40', yarim: '20', ziynet: '10', cumhuriyet: '10', resat: '5',
      gramToplam: '250', saat: '10', pos: '0', banka: '0',
      bilezikAdet: '25', yuzuk: '15', kupe: '10', kolye: '10', kunye: '10', sahmeran: '5', digerTaki: '5'
    }
  };
}

function run(state, id, command, actor = null, forcedVersion = null) {
  const schemaVersion = forcedVersion ?? eventVersion(command, state);
  return applyEvent(state, { id, schemaVersion, timestamp: '2026-06-15T10:00:00.000Z', command });
}

function seedState() {
  let s = emptyState();
  s = run(s, 'open-1', openingCommand());
  s = run(s, 'cust-1', { type: 'account', date: DATE, name: 'Ahmet Müşteri', unit: 'TL', opening: '0', partyType: 'customer' });
  s = run(s, 'sup-1', { type: 'supplierFirm', date: DATE, name: 'Altın Toptancı A', autoUnits: true });
  s = run(s, 'sup-2', { type: 'supplierFirm', date: DATE, name: 'Altın Toptancı B', autoUnits: true });
  return s;
}

// ── K3: Blind-Count Stock Leak Fix ──────────────────────────────────────────
test('K3: checkoutState masks quantity and freeQuantity for every workerCountCatalog item when hidePrivatePools=true', () => {
  const s = seedState();
  const catalogIds = new Set(workerCountCatalog(s).map(i => i.id));
  assert.ok(catalogIds.size >= 10, 'workerCountCatalog should include sarrafiye, gramToplam, hurda, bilezikAdet');
  assert.ok(catalogIds.has('ceyrek'));
  assert.ok(catalogIds.has('gramToplam'));
  assert.ok(catalogIds.has('hurda22'));
  assert.ok(catalogIds.has('bilezikAdet'));

  const empView = checkoutState(s, { hidePrivatePools: true });
  for (const st of empView.stocks) {
    if (catalogIds.has(st.id)) {
      assert.equal(st.quantity, null, `stocks[${st.id}].quantity must be null`);
      assert.equal(st.freeQuantity, null, `stocks[${st.id}].freeQuantity must be null`);
      assert.equal(st.blind, true, `stocks[${st.id}].blind must be true`);
    }
  }
  for (const pr of empView.products) {
    if (catalogIds.has(pr.id)) {
      assert.equal(pr.quantity, null, `products[${pr.id}].quantity must be null`);
      assert.equal(pr.freeQuantity, null, `products[${pr.id}].freeQuantity must be null`);
      assert.equal(pr.blind, true, `products[${pr.id}].blind must be true`);
    }
  }

  // Owner view (hidePrivatePools: false) still gets real quantities
  const ownerView = checkoutState(s, { hidePrivatePools: false });
  const ceyrek = ownerView.products.find(p => p.id === 'ceyrek');
  assert.equal(ceyrek.quantity, 40);
  assert.equal(ceyrek.freeQuantity, 40);
  assert.equal(ceyrek.blind, undefined);
});

// ── K4: pending_submissions schema migration + currencyExchange & collection ─
test('K4: Repository migrates legacy pending_submissions CHECK and supports currencyExchange & collection', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ersat-v22-k4-'));
  const dbPath = path.join(dir, 'ledger.sqlite');
  try {
    // Seed a legacy pending_submissions table with old CHECK constraint
    const rawDb = new DatabaseSync(dbPath);
    rawDb.exec(`
      CREATE TABLE meta(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
      INSERT INTO meta(id, revision) VALUES(1, 0);
      CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, body TEXT NOT NULL);
      CREATE TABLE pending_submissions(
        id TEXT PRIMARY KEY NOT NULL, workspace TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
        date TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('sale','purchase','dailyCount')),
        submitted_by_id TEXT NOT NULL, submitted_by_name TEXT NOT NULL, submitted_at TEXT NOT NULL,
        command_json TEXT NOT NULL, approved_command_json TEXT, summary_json TEXT NOT NULL,
        reviewed_by_id TEXT, reviewed_by_name TEXT, reviewed_at TEXT,
        was_edited INTEGER NOT NULL DEFAULT 0 CHECK(was_edited IN (0, 1)),
        rejection_reason TEXT, approved_event_id TEXT
      );
      INSERT INTO pending_submissions(id, workspace, status, date, type, submitted_by_id, submitted_by_name, submitted_at, command_json, summary_json)
      VALUES('legacy-1', 'demo', 'pending', '${DATE}', 'sale', 'emp-1', 'Tezgahtar 1', '2026-06-15T09:00:00Z', '{"type":"sale","date":"${DATE}"}', '{"type":"sale","totalTL":10000}');
    `);
    rawDb.close();

    const repo = new Repository(dbPath, 'demo');
    try {
      // Legacy row preserved
      const before = repo.listPending({ status: 'pending' });
      assert.equal(before.length, 1);
      assert.equal(before[0].id, 'legacy-1');

      // Initialize ledger + customer
      let st = repo.execute({ id: 'open-1', revision: 0, command: openingCommand() }, { actor: OWNER }).state;
      st = repo.execute({ id: 'cust-1', revision: st.revision, command: { type: 'account', date: DATE, name: 'Cari Müşteri', unit: 'TL', opening: '5000', partyType: 'customer' } }, { actor: OWNER }).state;

      // Submit currencyExchange pending
      const fxSub = repo.submitPending({
        id: 'pend-fx-1',
        revision: st.revision,
        command: {
          type: 'currencyExchange',
          date: DATE,
          received: [{ accountId: 'usd', quantity: '100' }],
          given: [{ accountId: 'nakit', quantity: '3800' }],
          note: 'USD alış'
        }
      }, { actor: EMP1 });
      assert.equal(fxSub.status, 'pending');
      assert.equal(fxSub.summary.type, 'currencyExchange');

      // Submit collection pending
      const colSub = repo.submitPending({
        id: 'pend-col-1',
        revision: st.revision,
        command: {
          type: 'collection',
          date: DATE,
          customerAccount: 'cari-cust-1',
          target: 'nakit',
          direction: 'collect',
          quantity: '2000',
          note: 'Tahsilat'
        }
      }, { actor: EMP1 });
      assert.equal(colSub.status, 'pending');
      assert.equal(colSub.summary.type, 'collection');

      // Filter listPending by currencyExchange and collection
      assert.equal(repo.listPending({ status: 'pending', type: 'currencyExchange' }).length, 1);
      assert.equal(repo.listPending({ status: 'pending', type: 'collection' }).length, 1);

      // Owner approves both
      const fxApp = repo.approvePending({ id: 'pend-fx-1', revision: st.revision, actor: OWNER });
      assert.equal(fxApp.ok, true);
      const colApp = repo.approvePending({ id: 'pend-col-1', revision: fxApp.state.revision, actor: OWNER });
      assert.equal(colApp.ok, true);
      assert.equal(colApp.state.balances['cari-cust-1'], 300000);
    } finally {
      repo.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── K5: amend for currencyExchange & collection (allowAdvance) ──────────────
test('K5: amend works cleanly for currencyExchange (v19) and collection with allowAdvance (v20)', () => {
  let s = seedState();
  // 1. currencyExchange + amend
  s = run(s, 'fx-1', {
    type: 'currencyExchange', date: DATE,
    received: [{ accountId: 'usd', quantity: '100' }],
    given: [{ accountId: 'nakit', quantity: '3500' }],
    note: 'İlk kur'
  });
  assert.equal(s.balances.usd, 510000);
  assert.equal(s.balances.nakit, 9650000);

  const amendFxCmd = {
    type: 'amend', date: DATE, originalId: 'fx-1', note: 'Kur düzeltmesi',
    replacement: {
      type: 'currencyExchange', date: DATE,
      received: [{ accountId: 'usd', quantity: '100' }],
      given: [{ accountId: 'nakit', quantity: '3600' }],
      note: 'Doğru kur'
    }
  };
  assert.equal(eventVersion(amendFxCmd, s), 19);
  s = run(s, 'fx-amend-1', amendFxCmd);
  assert.equal(s.balances.usd, 510000);
  assert.equal(s.balances.nakit, 9640000);

  // 2. collection (allowAdvance: true) + amend
  s = run(s, 'col-1', {
    type: 'collection', date: DATE, customerAccount: 'cari-cust-1', target: 'nakit',
    direction: 'collect', quantity: '1000', allowAdvance: true, note: 'İlk emanet'
  });
  assert.equal(s.balances['cari-cust-1'], -100000);

  const amendColCmd = {
    type: 'amend', date: DATE, originalId: 'col-1', note: 'Tutar düzeltmesi',
    replacement: {
      type: 'collection', date: DATE, customerAccount: 'cari-cust-1', target: 'nakit',
      direction: 'collect', quantity: '1500', allowAdvance: true, note: 'Güncel emanet'
    }
  };
  assert.equal(eventVersion(amendColCmd, s), 20);
  s = run(s, 'col-amend-1', amendColCmd);
  assert.equal(s.balances['cari-cust-1'], -150000);
});

// ── K6: supplierBind/supplierAdjust docs, autoSameUnit dup rows, hot-mode == replay ──
test('K6: supplierBind & supplierAdjust work in supplierDocuments, supplierAllocation, supplierOffset, supplierTransfer', () => {
  let s = seedState();
  const supA = s.supplierFirms[0].id;
  const supB = s.supplierFirms[1].id;
  const tlA = s.accounts.find(a => a.supplierId === supA && a.unit === 'TL').id;
  const hasA = s.accounts.find(a => a.supplierId === supA && a.unit === 'HAS').id;
  const tlB = s.accounts.find(a => a.supplierId === supB && a.unit === 'TL').id;

  // supplierBind: receive 10 HAS credit, owe 30000 TL charge
  s = run(s, 'bind-1', {
    type: 'supplierBind', date: DATE, supplierId: supA,
    receiveAccountId: hasA, receiveQuantity: '10',
    oweAccountId: tlA, oweQuantity: '30000',
    note: 'HAS bağlama'
  });
  // supplierAdjust: credit 5000 TL, and debt 2 HAS
  s = run(s, 'adj-cr-1', {
    type: 'supplierAdjust', date: DATE, supplierId: supA,
    accountId: tlA, direction: 'credit', quantity: '5000', note: 'Alacak düzeltme'
  });
  s = run(s, 'adj-db-1', {
    type: 'supplierAdjust', date: DATE, supplierId: supA,
    accountId: hasA, direction: 'debt', quantity: '2', note: 'Borç düzeltme'
  });

  const docs = supplierDocuments(s, supA);
  assert.ok(docs.purchases.some(p => p.id === 'bind-1' && p.charges[0].remaining === 3000000));
  assert.ok(docs.purchases.some(p => p.id === 'adj-db-1' && p.charges[0].remaining === 2000));
  assert.ok(docs.sources.some(src => src.id === 'bind-1' && src.credits[0].remaining === 10000));
  assert.ok(docs.sources.some(src => src.id === 'adj-cr-1' && src.credits[0].remaining === 500000));

  // Allocate adj-cr-1 (5000 TL) against bind-1 (30000 TL charge)
  s = run(s, 'alloc-1', {
    type: 'supplierAllocation', date: DATE, supplierId: supA,
    allocations: [{ sourceId: 'adj-cr-1', purchaseId: 'bind-1', accountId: tlA, quantity: '5000' }],
    note: 'Tahsis'
  });
  // Offset 1 HAS from bind-1 against 3000 TL of bind-1
  s = run(s, 'offset-1', {
    type: 'supplierOffset', date: DATE, supplierId: supA,
    fromAccountId: hasA, fromQuantity: '1', toAccountId: tlA, toQuantity: '3000',
    sourceUses: [{ sourceId: 'bind-1', quantity: '1' }],
    targetUses: [{ purchaseId: 'bind-1', quantity: '3000' }],
    note: 'Mahsup'
  });
  // Transfer 2 HAS from supA (bind-1) to supB
  s = run(s, 'xfer-1', {
    type: 'supplierTransfer', date: DATE,
    fromSupplierId: supA, toSupplierId: supB,
    unit: 'HAS', quantity: '2',
    sourceUses: [{ sourceId: 'bind-1', quantity: '2' }],
    note: 'Virman'
  });
  const docsAfter = supplierDocuments(s, supA);
  const bindSrc = docsAfter.sources.find(src => src.id === 'bind-1');
  assert.equal(bindSrc.credits[0].remaining, 7000); // 10 - 1 - 2 = 7 HAS
  assert.ok(tlB);
});

test('K6: supplierPayment autoSameUnit handles duplicate accountId lines accurately', () => {
  let s = seedState();
  const supA = s.supplierFirms[0].id;
  const tlA = s.accounts.find(a => a.supplierId === supA && a.unit === 'TL').id;

  s = run(s, 'sp-dup-1', {
    type: 'supplierPayment', date: DATE, supplierId: supA,
    autoSameUnit: true,
    given: [
      { accountId: 'nakit', quantity: '100' },
      { accountId: 'nakit', quantity: '250' }
    ],
    note: 'İki satır nakit'
  });
  assert.equal(s.balances.nakit, 10000000 - 35000);
  assert.equal(s.balances[tlA], 35000); // 100 + 250 = 350 TL, NOT 200 TL
});

test('K6: hot-mode matches replay() for supplierTransfer, autoSameUnit scrap/receipt, supplierGivenScrap, createdAccountIds, and journal filters', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ersat-v22-hot-'));
  const dbPath = path.join(dir, 'ledger.sqlite');
  try {
    // Small cacheMaxBytes forces hot mode immediately after a few events
    const repo = new Repository(dbPath, 'demo', { cacheMaxBytes: 1 });
    try {
      let st = repo.execute({ id: 'open-1', revision: 0, command: openingCommand(DATE) }, { actor: OWNER }).state;
      st = repo.execute({ id: 'sup-1', revision: st.revision, command: { type: 'supplierFirm', date: DATE, name: 'Firma A', autoUnits: true } }, { actor: OWNER }).state;
      st = repo.execute({ id: 'sup-2', revision: st.revision, command: { type: 'supplierFirm', date: DATE, name: 'Firma B', autoUnits: true } }, { actor: OWNER }).state;
      const supA = st.supplierFirms[0].id;
      const supB = st.supplierFirms[1].id;
      const tlA = st.accounts.find(a => a.supplierId === supA && a.unit === 'TL').id;
      const tlB = st.accounts.find(a => a.supplierId === supB && a.unit === 'TL').id;

      // Give scrap + cash to supA
      st = repo.execute({
        id: 'sp-give-1', revision: st.revision,
        command: {
          type: 'supplierPayment', date: DATE, supplierId: supA,
          given: [{ accountId: 'hurda22', quantity: '20' }, { accountId: 'nakit', quantity: '10000' }],
          credits: [{ accountId: tlA, quantity: '20000' }],
          note: 'Hurda ve nakit'
        }
      }, { actor: OWNER }).state;

      // Verify supplierGivenScrap in hot mode
      const hotPartyA = st.supplierParties.find(p => p.id === supA);
      assert.equal(hotPartyA.givenScrapBalances.hurda22, 20000);

      // Return partial scrap + receive cash via autoSameUnit
      st = repo.execute({
        id: 'sp-recv-1', revision: st.revision,
        command: {
          type: 'supplierPayment', date: DATE, supplierId: supA,
          autoSameUnit: true,
          received: [{ accountId: 'nakit', quantity: '4000' }],
          note: 'Nakit tahsilat autoSameUnit'
        }
      }, { actor: OWNER }).state;

      // Transfer 5000 TL from supA to supB in hot mode
      st = repo.execute({
        id: 'sp-xfer-1', revision: st.revision,
        command: {
          type: 'supplierTransfer', date: DATE,
          fromSupplierId: supA, toSupplierId: supB,
          unit: 'TL', quantity: '5000',
          sourceUses: [{ sourceId: 'sp-give-1', quantity: '5000' }],
          note: 'Hot virman'
        }
      }, { actor: OWNER }).state;

      // Verify supplierLastEvents for toSupplierId updated in hot mode
      const hotPartyB = st.supplierParties.find(p => p.id === supB);
      assert.equal(hotPartyB.lastEvent?.id, 'sp-xfer-1');

      // Compare hot state balances & supplier docs against full replay()
      const replayed = replay(repo.events());
      assert.deepEqual(st.balances, replayed.balances);
      assert.deepEqual(
        supplierDocuments(replayed, supA).sources.map(x => x.credits),
        repo.supplierDetail({ supplierId: supA }).documents.sources.map(x => x.credits)
      );

      // ledger-view.mjs journal filter allowlist accepts supplierBind, supplierAdjust, customerAdjustment
      assert.equal(normalizeJournalOptions({ type: 'supplierBind' }).type, 'supplierBind');
      assert.equal(normalizeJournalOptions({ type: 'supplierAdjust' }).type, 'supplierAdjust');
      assert.equal(normalizeJournalOptions({ type: 'customerAdjustment' }).type, 'customerAdjustment');
    } finally {
      repo.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Y1: POS allowed on incoming order legs, blocked on outgoing/refund legs ─
test('Y1: POS allowed on incoming order kapora/delivery, blocked on orderRefund and delivery given', () => {
  let s = seedState();
  // Incoming initialAdvance via POS
  s = run(s, 'ord-pos-1', {
    type: 'customerOrder', date: DATE, customerId: 'cari-cust-1',
    description: 'POS Kaporalı Sipariş', orderUnit: 'TL', targetQuantity: '20000',
    initialAdvance: { accountId: 'pos', receivedQuantity: '5000' }
  });
  assert.equal(s.balances.pos, 500000);

  // Incoming orderAdvance via POS
  s = run(s, 'ord-pos-adv', {
    type: 'orderAdvance', date: DATE, orderId: 'ord-pos-1',
    accountId: 'pos', receivedQuantity: '3000'
  });
  assert.equal(s.balances.pos, 800000);

  // Outgoing orderRefund via POS MUST fail
  assert.throws(() => run(s, 'ord-pos-ref', {
    type: 'orderRefund', date: DATE, orderId: 'ord-pos-1',
    advanceId: 'ord-pos-adv', accountId: 'pos', refundedQuantity: '1000'
  }), /Kapora için aktif kasa/);

  // Incoming orderDeliver settlement.received via POS succeeds
  s = run(s, 'ord-pos-del', {
    type: 'orderDeliver', date: DATE, orderId: 'ord-pos-1',
    items: [{ accountId: 'ceyrek', quantity: '2' }],
    deliveredQuantity: '20000', closeOrder: true,
    settlement: { received: [{ accountId: 'pos', quantity: '12000' }] }
  });
  assert.equal(s.balances.pos, 2000000);

  // Outgoing orderDeliver settlement.given via POS MUST fail
  s = run(s, 'ord-pos-2', {
    type: 'customerOrder', date: DATE, customerId: 'cari-cust-1',
    description: 'Fazla kapora POS iade engeli', orderUnit: 'TL', targetQuantity: '10000',
    initialAdvance: { accountId: 'nakit', receivedQuantity: '10000' }
  });
  assert.throws(() => run(s, 'ord-pos-del-2', {
    type: 'orderDeliver', date: DATE, orderId: 'ord-pos-2',
    items: [{ accountId: 'ceyrek', quantity: '1' }],
    deliveredQuantity: '6000', closeOrder: true,
    settlement: { given: [{ accountId: 'pos', quantity: '4000' }] }
  }), /Kapora için aktif kasa/);
});

// ── Y2: restore() & restoreArchive() clear pending_submissions ──────────────
test('Y2: restore() and restoreArchive() clear stale pending_submissions', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ersat-v22-y2-'));
  const dbPath = path.join(dir, 'ledger.sqlite');
  const archivePath = path.join(dir, 'backup.ndjson');
  try {
    const repo = new Repository(dbPath, 'demo');
    try {
      const st = repo.execute({ id: 'open-1', revision: 0, command: openingCommand() }, { actor: OWNER }).state;
      const backup = repo.backup();
      repo.exportArchive(archivePath);

      repo.submitPending({
        id: 'stale-pend-1',
        revision: st.revision,
        command: {
          type: 'sale', date: DATE, counterpartyType: 'customer',
          items: [{ accountId: 'ceyrek', quantity: '1', value: '5000' }],
          received: [{ accountId: 'nakit', quantity: '5000', valueTL: '5000' }],
          given: [], credits: [], debts: []
        }
      }, { actor: EMP1 });
      assert.equal(repo.pendingCount(), 1);

      // restore() clears pending_submissions
      const restored = repo.restore({ backup, revision: st.revision, confirmation: 'GERİ YÜKLE' });
      assert.equal(repo.pendingCount(), 0);

      // Re-submit and test restoreArchive()
      repo.submitPending({
        id: 'stale-pend-2',
        revision: restored.revision,
        command: {
          type: 'sale', date: DATE, counterpartyType: 'customer',
          items: [{ accountId: 'ceyrek', quantity: '1', value: '5000' }],
          received: [{ accountId: 'nakit', quantity: '5000', valueTL: '5000' }],
          given: [], credits: [], debts: []
        }
      }, { actor: EMP1 });
      assert.equal(repo.pendingCount(), 1);

      const { createReadStream } = await import('node:fs');
      await repo.restoreArchive(createReadStream(archivePath), {
        revision: restored.revision,
        confirmation: 'GERİ YÜKLE',
        temporaryDirectory: dir
      });
      assert.equal(repo.pendingCount(), 0);
    } finally {
      repo.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Y5: v20 supplier editableCommand & ReportRepository journal filter ──────
test('Y5: v20 supplierPurchase(openAccount) & supplierPayment(autoSameUnit) are editable and ReportRepository accepts v18-v21 types', () => {
  let s = seedState();
  const supA = s.supplierFirms[0].id;

  s = run(s, 'sp-open-1', {
    type: 'supplierPurchase', date: DATE, supplierId: supA, openAccount: true,
    items: [{ accountId: 'ceyrek', quantity: '5' }],
    note: 'Açık hesap alış'
  });
  assert.ok(s.journal.at(-1).editableCommand, 'v20 supplierPurchase(openAccount) must keep editableCommand');
  s = run(s, 'sp-open-amend', {
    type: 'supplierAmend', date: DATE, originalId: 'sp-open-1', note: 'Adet düzeltme',
    replacement: {
      type: 'supplierPurchase', date: DATE, supplierId: supA, openAccount: true,
      items: [{ accountId: 'ceyrek', quantity: '6' }],
      note: 'Güncel açık hesap alış'
    }
  });
  assert.equal(s.balances.ceyrek, 46);

  s = run(s, 'sp-auto-1', {
    type: 'supplierPayment', date: DATE, supplierId: supA, autoSameUnit: true,
    given: [{ accountId: 'nakit', quantity: '1000' }], note: 'Otomatik ödeme'
  });
  assert.ok(s.journal.at(-1).editableCommand, 'v20 supplierPayment(autoSameUnit) must keep editableCommand');

  // ReportRepository journal filter allowlist
  const dir = mkdtempSync(path.join(tmpdir(), 'ersat-v22-y5-'));
  const dbPath = path.join(dir, 'ledger.sqlite');
  try {
    const repo = new Repository(dbPath, 'demo');
    repo.execute({ id: 'open-1', revision: 0, command: openingCommand() }, { actor: OWNER });
    repo.close();

    const rRepo = new ReportRepository(dbPath, 'demo');
    try {
      for (const t of ['customerOrder', 'orderUpdate', 'orderAdvance', 'orderDeliver', 'orderRefund', 'orderCancel', 'currencyExchange', 'customerAdjustment', 'supplierOpening', 'supplierBind', 'supplierAdjust', 'supplierTransfer', 'linkScrapPurchase']) {
        const res = rRepo.journal({ type: t });
        assert.ok(Array.isArray(res.items), `ReportRepository.journal should accept type=${t}`);
      }
    } finally {
      rRepo.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Y7: Cash-Basis Order Revenue (schemaVersion: 22, zero double counting) ──
test('Y7: schemaVersion 22 cash-basis order revenue has zero double counting and preserves v21 replay', () => {
  let s = seedState();

  // 1. TL Order: 4000 kapora + 2000 kapora - 1000 refund + deliver 10000 (waive 500) -> net 9500 TL
  s = run(s, 'ord-tl-1', {
    type: 'customerOrder', date: DATE, customerId: 'cari-cust-1',
    description: 'TL Sipariş', orderUnit: 'TL', targetQuantity: '10000',
    initialAdvance: { accountId: 'nakit', receivedQuantity: '4000' }
  });
  assert.equal(s.journal.at(-1).meta.revenue, 400000);

  s = run(s, 'ord-tl-adv', {
    type: 'orderAdvance', date: DATE, orderId: 'ord-tl-1',
    accountId: 'nakit', receivedQuantity: '2000'
  });
  assert.equal(s.journal.at(-1).meta.revenue, 200000);

  s = run(s, 'ord-tl-ref', {
    type: 'orderRefund', date: DATE, orderId: 'ord-tl-1',
    advanceId: 'ord-tl-adv', accountId: 'nakit', refundedQuantity: '1000'
  });
  assert.equal(s.journal.at(-1).meta.revenue, -100000);

  s = run(s, 'ord-tl-del', {
    type: 'orderDeliver', date: DATE, orderId: 'ord-tl-1',
    items: [{ accountId: 'ceyrek', quantity: '2' }],
    deliveredQuantity: '10000', closeOrder: true, note: 'İskontolu teslimat',
    settlement: {
      received: [{ accountId: 'nakit', quantity: '4500' }],
      waiveQuantity: '500'
    }
  });
  // unpaid = 10000 - 5000 = 5000, waive = 500 -> deliveryRevenue = 4500
  assert.equal(s.journal.at(-1).meta.revenue, 450000);
  assert.equal(workdaySummary(s, DATE).totals.sales, 950000);

  // 2. TL Order early close with leftover kapora refund -> negative deliveryRevenue + reverse negation
  s = run(s, 'ord-tl-2', {
    type: 'customerOrder', date: DATE, customerId: 'cari-cust-1',
    description: 'Erken Kapanış TL', orderUnit: 'TL', targetQuantity: '10000',
    initialAdvance: { accountId: 'nakit', receivedQuantity: '10000' }
  });
  assert.equal(s.journal.at(-1).meta.revenue, 1000000);

  s = run(s, 'ord-tl-2-del', {
    type: 'orderDeliver', date: DATE, orderId: 'ord-tl-2',
    items: [{ accountId: 'ceyrek', quantity: '1' }],
    deliveredQuantity: '6000', closeOrder: true,
    settlement: { given: [{ accountId: 'nakit', quantity: '4000' }] }
  });
  assert.equal(s.journal.at(-1).meta.revenue, -400000);
  // Reverse delivery -> negates -400000 to +400000
  s = run(s, 'ord-tl-2-rev', { type: 'reverse', date: DATE, originalId: 'ord-tl-2-del', note: 'Teslimat iptali' });
  assert.equal(s.journal.at(-1).meta.revenue, 400000);

  // 3. Non-TL (GRAM) order fully prepaid in TL -> revenue recorded on kapora, 0 on delivery
  s = run(s, 'ord-gr-1', {
    type: 'customerOrder', date: DATE, customerId: 'cari-cust-1',
    description: 'Gram Sipariş', orderUnit: 'GRAM', targetQuantity: '10',
    initialAdvances: [
      { accountId: 'nakit', receivedQuantity: '30000', creditedQuantity: '10' }
    ]
  });
  assert.equal(s.journal.at(-1).meta.revenue, 3000000);
  s = run(s, 'ord-gr-1-del', {
    type: 'orderDeliver', date: DATE, orderId: 'ord-gr-1',
    items: [{ accountId: 'gramToplam', quantity: '10' }],
    deliveredQuantity: '10', closeOrder: true
  });
  assert.equal(s.journal.at(-1).meta.revenue, 0);

  // 4. Unit isolation (USD kapora) & carryover kapora -> 0 TL revenue
  s = run(s, 'ord-usd-1', {
    type: 'customerOrder', date: DATE, customerId: 'cari-cust-1',
    description: 'USD Kapora', orderUnit: 'GRAM', targetQuantity: '5',
    initialAdvances: [
      { accountId: 'usd', receivedQuantity: '500', creditedQuantity: '3' },
      { carryover: true, creditedQuantity: '2', note: 'Devir' }
    ]
  });
  assert.equal(s.journal.at(-1).meta.revenue, 0);

  // 5. Legacy v21 replay compatibility unchanged
  let s21 = seedState();
  s21 = run(s21, 'ord-v21', {
    type: 'customerOrder', date: DATE, customerId: 'cari-cust-1',
    description: 'Eski v21 Sipariş', orderUnit: 'TL', targetQuantity: '10000',
    initialAdvance: { accountId: 'nakit', receivedQuantity: '4000' }
  }, OWNER, 21);
  assert.equal(s21.journal.at(-1).meta.revenue, 0);
  s21 = run(s21, 'ord-v21-del', {
    type: 'orderDeliver', date: DATE, orderId: 'ord-v21',
    items: [{ accountId: 'ceyrek', quantity: '2' }],
    deliveredQuantity: '10000', closeOrder: true,
    settlement: { received: [{ accountId: 'nakit', quantity: '6000' }] }
  }, OWNER, 21);
  assert.equal(s21.journal.at(-1).meta.revenue, 1000000);
});

// ── Paket C: withdrawPending endpoint + Content-Type + Content-Disposition ──
test('Paket C: employee withdrawPending API, strict Content-Type, and Content-Disposition workspace', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ersat-v22-srv-'));
  const { server: srv, close: closeApp } = createApp({ dataDirectory: dir });
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    // Setup owner
    let res = await fetch(`${base}/api/auth/setup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Patron', pin: '123456' })
    });
    assert.equal(res.status, 201);
    const ownerToken = (await res.json()).token;

    // Initialize demo ledger
    res = await fetch(`${base}/api/command?workspace=demo`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ id: 'open-1', revision: 0, command: openingCommand() })
    });
    assert.equal(res.status, 200);
    const { state } = await res.json();

    // Strict Content-Type check rejects application/json-evil
    res = await fetch(`${base}/api/command?workspace=demo`, {
      method: 'POST', headers: { 'Content-Type': 'application/json-evil', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ id: 'bad-ct', revision: state.revision, command: {} })
    });
    assert.equal(res.status, 415);

    // Content-Disposition uses repository.workspace
    res = await fetch(`${base}/api/backup?workspace=demo`, {
      headers: { Authorization: `Bearer ${ownerToken}` }
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /filename="kuyumcu-demo-/);

    // Create 2 employees
    const mkEmp = async (name, tempPin = '111111', finalPin = '654321') => {
      const r = await fetch(`${base}/api/auth/employees`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({ name, pin: tempPin })
      });
      assert.equal(r.status, 201);
      const created = await r.json();
      const login = await fetch(`${base}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: created.id, pin: tempPin })
      });
      assert.equal(login.status, 200);
      const sess = await login.json();
      const ch = await fetch(`${base}/api/auth/change-pin`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sess.token}` },
        body: JSON.stringify({ currentPin: tempPin, newPin: finalPin })
      });
      assert.equal(ch.status, 200);
      return sess.token;
    };
    const emp1Token = await mkEmp('Ahmet');
    const emp2Token = await mkEmp('Mehmet');

    // Emp1 submits a pending sale
    const pendingId = 'pend-w-1';
    res = await fetch(`${base}/api/pending-approvals?workspace=demo`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${emp1Token}` },
      body: JSON.stringify({
        id: pendingId, revision: state.revision,
        command: {
          type: 'sale', date: DATE, counterpartyType: 'customer',
          items: [{ accountId: 'ceyrek', quantity: '1', value: '5000' }],
          received: [{ accountId: 'nakit', quantity: '5000', valueTL: '5000' }],
          given: [], credits: [], debts: []
        }
      })
    });
    assert.equal(res.status, 201);

    // Emp2 CANNOT withdraw Emp1's pending submission (403)
    res = await fetch(`${base}/api/pending-approvals/${pendingId}/withdraw?workspace=demo`, {
      method: 'POST', headers: { Authorization: `Bearer ${emp2Token}` }
    });
    assert.equal(res.status, 403);

    // Emp1 CAN withdraw own pending submission (200)
    res = await fetch(`${base}/api/pending-approvals/${pendingId}/withdraw?workspace=demo`, {
      method: 'POST', headers: { Authorization: `Bearer ${emp1Token}` }
    });
    assert.equal(res.status, 200);
    const withdrawn = await res.json();
    assert.equal(withdrawn.withdrawn, true);

    // Withdrawing again returns 404
    res = await fetch(`${base}/api/pending-approvals/${pendingId}/withdraw?workspace=demo`, {
      method: 'POST', headers: { Authorization: `Bearer ${emp1Token}` }
    });
    assert.equal(res.status, 404);
  } finally {
    await new Promise(resolve => srv.close(resolve));
    closeApp?.();
    rmSync(dir, { recursive: true, force: true });
  }
});
