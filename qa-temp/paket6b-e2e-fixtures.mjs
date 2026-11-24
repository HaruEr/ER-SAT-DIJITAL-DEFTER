import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { INITIAL_ACCOUNTS } from '../domain.mjs';
import { IdentityStore } from '../identity.mjs';
import { Repository } from '../repository.mjs';
import { createApp } from '../server.mjs';
import { isInsideDir, killOrphanChromeForUserDataDir, removeDirWithRetry } from './paket6b-cdp-harness.mjs';

export function getIsolatedTempRoot() {
  const root = process.env.TEMP || process.env.TMP || tmpdir();
  return resolve(root);
}

function insertEventsBulk(db, events) {
  const insert = db.prepare('INSERT INTO events(id,body) VALUES(?,?)');
  db.exec('BEGIN');
  try {
    for (const event of events) {
      insert.run(event.id, JSON.stringify(event));
    }
    db.prepare('UPDATE meta SET revision = ? WHERE id = 1').run(events.length);
    db.exec('COMMIT');
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

export function seedFunctionalLedger(dbPath, workspace = 'demo', { date = '2026-11-10' } = {}) {
  const repo = new Repository(dbPath, workspace);
  try {
    const write = (id, command) =>
      repo.execute({
        id,
        revision: repo.state().revision,
        command: { date, ...command }
      });

    const balanceDefaults = {
      nakit: '500000',
      usd: '5000',
      eur: '5000',
      pos: '2500',
      banka: '0', // retired when opening schemaVersion: 5
      ceyrek: '25',
      yarim: '10',
      ziynet: '5',
      cumhuriyet: '5',
      resat: '5',
      bilezikAdet: '5',
      bilezik22: '100',
      yuzuk: '5',
      kupe: '4',
      kolye: '4',
      kunye: '4',
      sahmeran: '3',
      digerTaki: '3',
      taki14: '50',
      taki22: '0',
      gramToplam: '100',
      hurda22: '20',
      hurda21: '5',
      hurda18: '5',
      hurda14: '5',
      hurda8: '5',
      hurda24: '5',
      saat: '0'
    };

    const balances = Object.fromEntries(
      INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, balanceDefaults[a.id] ?? '0'])
    );

    write('fn-opening', {
      type: 'opening',
      banks: [],
      balances
    });

    write('fund-ziraat', {
      type: 'fundAccount',
      name: 'Ziraat Bankası TL',
      unit: 'TL',
      physical: false,
      opening: '100000'
    });

    const customers = [
      ['cust-ahmet-tl', { name: 'Ahmet Yılmaz', unit: 'TL', opening: '1500', phone: '05321112233', taxId: '11111111111', address: 'Merkez Şube' }],
      ['cust-ahmet-usd', { name: 'Ahmet Yılmaz', unit: 'USD', opening: '100', phone: '05324445566', taxId: '22222222222', address: 'Döviz Cari' }],
      ['cust-ahmet-kuyumcu', { name: 'Ahmet Yılmaz Kuyumcu', unit: 'TL', opening: '-500', phone: '05327778899', taxId: '33333333333' }],
      ['cust-ismail', { name: 'İsmail Işık', unit: 'TL', opening: '2000', phone: '05411234567', taxId: '44444444444' }],
      ['cust-ayse', { name: 'Ayşe Şahin', unit: 'TL', opening: '0', phone: '05339876543', taxId: '55555555555' }],
      ['cust-omer', { name: 'Ömer Çelik', unit: 'TL', opening: '0' }],
      ['cust-seyma', { name: 'Şeyma Güneş', unit: 'HAS', opening: '5' }],
      ['cust-umit', { name: 'Ümit Erdoğan', unit: 'TL', opening: '0' }],
      ['cust-igdir', { name: 'Iğdır Kuyumculuk', unit: 'TL', opening: '0' }],
      ['cust-istanbul', { name: 'İstanbul Sarrafiye', unit: 'TL', opening: '0' }],
      ['cust-xss-img', { name: '<img src=x onerror="window.__xss=1">', unit: 'TL', opening: '0', phone: '05550001122' }],
      ['cust-xss-script', { name: '<script>window.__xss=2</script>', unit: 'TL', opening: '0' }]
    ];

    for (const [id, c] of customers) {
      write(id, { type: 'account', partyType: 'customer', ...c });
    }

    const stocks = [
      ['stk-agri', { name: 'Ağrı Has Altın', unit: 'GRAM', countPolicy: 'periodic', opening: '100' }],
      ['stk-gumus', { name: 'Gümüş Bilezik', unit: 'ADET', countPolicy: 'daily', opening: '8' }],
      ['stk-sifir', { name: 'Sıfır Stok Kolye', unit: 'ADET', countPolicy: 'daily', opening: '0', isSaleable: true }],
      ['stk-non-sale', { name: 'Alış Özel Ürün', unit: 'ADET', countPolicy: 'daily', opening: '5', isSaleable: false }],
      ['stk-xss', { name: '<img src=x onerror="window.__xss=3">', unit: 'ADET', countPolicy: 'daily', opening: '2' }]
    ];

    for (const [id, c] of stocks) {
      write(id, { type: 'stockAccount', ...c });
    }

    const suppliers = [
      ['sup-ozgur', { name: 'Özgür Çelik Toptan', phone: '02121112233', taxId: '66666666666' }, ['HAS', 'TL']],
      ['sup-sahin', { name: 'Şahin Altın A.Ş.', phone: '02124445566', taxId: '77777777777' }, ['HAS', 'USD']],
      ['sup-isik', { name: 'Işık İthalat', phone: '02127778899', taxId: '88888888888' }, ['HAS', 'TL', 'SILVER']],
      ['sup-xss', { name: '<img src=x onerror="window.__xss=4">', phone: '02129990000' }, ['HAS']]
    ];

    for (const [id, firm, unitList] of suppliers) {
      write(id, { type: 'supplierFirm', ...firm });
      for (const unit of unitList) {
        write(`${id}-${unit.toLowerCase()}`, {
          type: 'supplierUnit',
          supplierId: `supplier-${id}`,
          unit
        });
      }
    }

    write('cust-order-1', {
      type: 'customerOrder',
      customerId: 'cari-cust-ismail',
      description: 'Özel bilezik siparişi'
    });
    write('cust-adv-1', {
      type: 'orderAdvance',
      orderId: 'cust-order-1',
      accountId: 'nakit',
      amountTL: '500'
    });
    write('init-sale-1', {
      type: 'sale',
      counterpartyType: 'customer',
      counterpartyId: 'cari-cust-ismail',
      items: [{ accountId: 'ceyrek', quantity: '1', value: '5000' }],
      received: [{ accountId: 'nakit', quantity: '5000', valueTL: '5000' }],
      given: [],
      credits: [],
      debts: [],
      note: 'İsmail Işık ilk çeyrek satışı'
    });
    write('init-pur-1', {
      type: 'purchase',
      source: 'customer',
      counterpartyType: 'customer',
      counterpartyId: 'cari-cust-omer',
      items: [{ accountId: 'hurda22', quantity: '2.500', value: '6000' }],
      given: [{ accountId: 'nakit', quantity: '6000', valueTL: '6000' }],
      received: [],
      credits: [],
      debts: [],
      note: 'Ömer Çelik hurda alışı'
    });
    write('init-sup-pur-1', {
      type: 'supplierPurchase',
      supplierId: 'supplier-sup-ozgur',
      items: [{ accountId: 'ceyrek', quantity: '2' }],
      charges: [{ accountId: 'supplier-unit-sup-ozgur-has', quantity: '3.200' }],
      note: 'Özgür Çelik açılış alış'
    });

    const state = repo.state({ compact: true });
    return { revision: state.revision, date: state.date };
  } finally {
    repo.close();
  }
}

export function seedAlternateWorkspaceLedger(dbPath, workspace = 'dukkan', { date = '2026-11-10' } = {}) {
  const repo = new Repository(dbPath, workspace);
  try {
    const write = (id, command) =>
      repo.execute({
        id,
        revision: repo.state().revision,
        command: { date, ...command }
      });
    const balances = Object.fromEntries(
      INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, a.id === 'nakit' ? '250000' : a.id === 'ceyrek' ? '10' : '0'])
    );
    write('dukkan-opening', { type: 'opening', banks: [], balances });
    write('dukkan-cust-1', {
      type: 'account',
      partyType: 'customer',
      name: 'Dükkân Özel Müşteri',
      unit: 'TL',
      opening: '0',
      phone: '05559998877'
    });
    write('dukkan-stk-1', {
      type: 'stockAccount',
      name: 'Dükkân Özel Bilezik',
      unit: 'ADET',
      countPolicy: 'daily',
      opening: '5'
    });
    return { revision: repo.state({ compact: true }).revision, date };
  } finally {
    repo.close();
  }
}

export function seedUninitializedLedger(dbPath, workspace = 'demo') {
  const repo = new Repository(dbPath, workspace);
  try {
    return { revision: repo.state({ compact: true }).revision, date: null };
  } finally {
    repo.close();
  }
}

export function seedNominalUnconfirmedLedger(dbPath, workspace = 'demo', { date = '2026-11-10' } = {}) {
  const repo = new Repository(dbPath, workspace);
  try {
    const balances = Object.fromEntries(
      INITIAL_ACCOUNTS.filter(a => !a.introduced || a.introduced <= 2).map(a => [
        a.id,
        a.id === 'nakit' ? '100000' : a.id === 'ceyrek' ? '5' : '0'
      ])
    );
    insertEventsBulk(repo.db, [
      {
        id: 'nom-opening',
        schemaVersion: 2,
        timestamp: `${date}T08:00:00Z`,
        command: { type: 'opening', date, balances }
      }
    ]);
    const state = repo.state({ compact: true });
    return { revision: state.revision, date: state.date };
  } finally {
    repo.close();
  }
}

export function seedBigDataLedger(
  dbPath,
  { customers = 10000, stocks = 2000, suppliers = 120, workspace = 'demo', date = '2026-11-10' } = {}
) {
  const repo = new Repository(dbPath, workspace);
  try {
    const balances = Object.fromEntries(
      INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => {
        if (a.id === 'nakit') return [a.id, '5000000'];
        if (a.id === 'banka') return [a.id, '1000000'];
        if (a.id === 'ceyrek') return [a.id, '500'];
        if (a.id === 'gramToplam') return [a.id, '500'];
        if (a.id === 'taki14') return [a.id, '500'];
        if (a.id === 'hurda22') return [a.id, '100'];
        return [a.id, '0'];
      })
    );

    const events = [
      {
        id: 'bd-opening',
        schemaVersion: 3,
        timestamp: `${date}T08:00:00Z`,
        command: { type: 'opening', date, balances }
      }
    ];

    for (let i = 0; i < customers; i++) {
      const trTag = i % 5 === 0 ? ' ÇŞĞÜÖİ' : '';
      events.push({
        id: `bd-cust-${i}`,
        schemaVersion: 5,
        timestamp: `${date}T08:01:00Z`,
        command: {
          type: 'account',
          partyType: 'customer',
          date,
          name: `Sentetik Müşteri ${i}${trTag}`,
          unit: 'TL',
          opening: '0',
          phone: `0532${String(i).padStart(7, '0')}`
        }
      });
    }

    for (let i = 0; i < stocks; i++) {
      const trTag = i % 5 === 0 ? ' ÇŞĞÜÖİ' : '';
      events.push({
        id: `bd-stk-${i}`,
        schemaVersion: 5,
        timestamp: `${date}T08:02:00Z`,
        command: {
          type: 'stockAccount',
          date,
          name: `SENTETİK STOK ${i}${trTag}`,
          unit: 'GRAM',
          countPolicy: 'periodic',
          opening: '10'
        }
      });
    }

    for (let i = 0; i < suppliers; i++) {
      const firmId = `bd-sup-${i}`;
      events.push({
        id: firmId,
        schemaVersion: 17,
        timestamp: `${date}T08:03:00Z`,
        command: {
          type: 'supplierFirm',
          date,
          name: `Sentetik Toptancı ${i}${i % 4 === 0 ? ' ÖŞÇÜĞİ' : ''}`,
          phone: `0212${String(i).padStart(7, '0')}`
        }
      });
      for (const unit of ['HAS', 'TL']) {
        events.push({
          id: `${firmId}-${unit.toLowerCase()}`,
          schemaVersion: 17,
          timestamp: `${date}T08:03:01Z`,
          command: {
            type: 'supplierUnit',
            date,
            supplierId: `supplier-${firmId}`,
            unit
          }
        });
      }
    }

    // Tail needles placed past index > customers + stocks + suppliers
    events.push(
      {
        id: 'bd-needle-ismail',
        schemaVersion: 5,
        timestamp: `${date}T08:10:00Z`,
        command: {
          type: 'account',
          partyType: 'customer',
          date,
          name: 'İsmail Işık Hedef',
          unit: 'TL',
          opening: '500',
          phone: '05991234567',
          taxId: '99999999991'
        }
      },
      {
        id: 'bd-needle-ahmet-tl',
        schemaVersion: 5,
        timestamp: `${date}T08:10:01Z`,
        command: {
          type: 'account',
          partyType: 'customer',
          date,
          name: 'Ahmet Yılmaz Hedef',
          unit: 'TL',
          opening: '100',
          phone: '05991112233'
        }
      },
      {
        id: 'bd-needle-ahmet-usd',
        schemaVersion: 5,
        timestamp: `${date}T08:10:02Z`,
        command: {
          type: 'account',
          partyType: 'customer',
          date,
          name: 'Ahmet Yılmaz Hedef',
          unit: 'USD',
          opening: '50',
          phone: '05994445566'
        }
      },
      {
        id: 'bd-needle-xss',
        schemaVersion: 5,
        timestamp: `${date}T08:10:03Z`,
        command: {
          type: 'account',
          partyType: 'customer',
          date,
          name: '<img src=x onerror="window.__xss=9"> Hedef',
          unit: 'TL',
          opening: '0'
        }
      },
      {
        id: 'bd-needle-stock',
        schemaVersion: 5,
        timestamp: `${date}T08:10:04Z`,
        command: {
          type: 'stockAccount',
          date,
          name: 'AĞRI HEDEF BİLEZİK',
          unit: 'ADET',
          countPolicy: 'daily',
          opening: '5'
        }
      },
      {
        id: 'bd-needle-supplier',
        schemaVersion: 17,
        timestamp: `${date}T08:10:05Z`,
        command: {
          type: 'supplierFirm',
          date,
          name: 'Şeyma Hedef Toptancı',
          phone: '02129998877'
        }
      },
      {
        id: 'bd-needle-supplier-has',
        schemaVersion: 17,
        timestamp: `${date}T08:10:06Z`,
        command: {
          type: 'supplierUnit',
          date,
          supplierId: 'supplier-bd-needle-supplier',
          unit: 'HAS'
        }
      },
      {
        id: 'bd-needle-supplier-tl',
        schemaVersion: 17,
        timestamp: `${date}T08:10:07Z`,
        command: {
          type: 'supplierUnit',
          date,
          supplierId: 'supplier-bd-needle-supplier',
          unit: 'TL'
        }
      },
      {
        id: 'bd-needle-sale',
        schemaVersion: 6,
        timestamp: `${date}T08:11:00Z`,
        command: {
          type: 'sale',
          date,
          counterpartyType: 'customer',
          counterpartyId: 'cari-bd-needle-ismail',
          items: [{ accountId: 'ceyrek', quantity: '1', value: '5000' }],
          received: [{ accountId: 'nakit', quantity: '5000', valueTL: '5000' }],
          given: [],
          credits: [],
          debts: [],
          note: 'Hedef büyük veri satış kaydı Şeyma Çelik'
        }
      }
    );

    insertEventsBulk(repo.db, events);
    const state = repo.state({ compact: true });
    return { revision: state.revision, date: state.date, eventCount: events.length };
  } finally {
    repo.close();
  }
}

export async function createIsolatedApp({
  prefix = 'paket6b-e2e-',
  seedFn = seedFunctionalLedger,
  dualWorkspace = false
} = {}) {
  const tempRoot = getIsolatedTempRoot();
  mkdirSync(tempRoot, { recursive: true });
  const root = mkdtempSync(join(tempRoot, prefix));
  const dataDir = join(root, 'ledger');
  const profileDir = join(root, 'chrome-profile');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(profileDir, { recursive: true });

  const seedInfo = seedFn(join(dataDir, 'demo.sqlite'), 'demo');
  if (dualWorkspace) {
    seedAlternateWorkspaceLedger(join(dataDir, 'dukkan.sqlite'), 'dukkan');
  }

  const ownerPassword = String(Math.floor(100000 + Math.random() * 900000));
  const employeePassword = String(Math.floor(100000 + Math.random() * 900000));

  const identities = new IdentityStore(dataDir);
  let owner, employee;
  try {
    owner = await identities.initializeOwner({ name: 'E2E Yönetici', pin: ownerPassword });
    const session = await identities.login(owner.id, ownerPassword);
    employee = await identities.createEmployee(session.token, {
      name: 'E2E Tezgâh Çalışanı',
      pin: '111111'
    });
    const empSession = await identities.login(employee.id, '111111');
    await identities.changePin(empSession.token, { currentPin: '111111', newPin: employeePassword });
  } finally {
    identities.close();
  }

  const { server } = createApp({ dataDirectory: dataDir, logger: () => {} });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;

  function openRepo(workspace = 'demo') {
    return new Repository(join(dataDir, `${workspace}.sqlite`), workspace);
  }

  async function close() {
    await new Promise(done => {
      server.close(() => done());
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    });
    await new Promise(r => setTimeout(r, 120));
    if (isInsideDir(root, tempRoot)) {
      await removeDirWithRetry(root, {
        onTransientError: () => killOrphanChromeForUserDataDir(join(profileDir, 'chrome'))
      });
    }
  }

  return {
    root,
    dataDir,
    profileDir,
    origin,
    seedInfo,
    owner: { id: owner.id, name: owner.name, password: ownerPassword, role: 'owner' },
    employee: { id: employee.id, name: employee.name, password: employeePassword, role: 'employee' },
    openRepo,
    close
  };
}
