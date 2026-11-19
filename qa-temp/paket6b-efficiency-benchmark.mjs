import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
import { INITIAL_ACCOUNTS, applyEvent, currentCountPolicy, decimal, emptyState, eventVersion } from '../domain.mjs';
import { IdentityStore } from '../identity.mjs';
import { Repository } from '../repository.mjs';

const args = process.argv.slice(2);
const hasFlag = flag => args.includes(flag);
const argValue = (name, fallback = null) => {
  const idx = args.indexOf(name);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  const eq = args.find(a => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : fallback;
};

const suiteArg = (argValue('--suite', hasFlag('--all') ? 'all' : 'all') || 'all').toLowerCase();
const runR1 = suiteArg === 'all' || suiteArg === 'r1';
const runR4 = suiteArg === 'all' || suiteArg === 'r4';
const r4ScalesArg = (argValue('--r4-scales', '5k,10k') || '5k,10k').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const jsonOnly = hasFlag('--json');
const assertThresholds = hasFlag('--assert');

function foldTr(text) {
  return String(text ?? '')
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i')
    .replace(/\s+/g, ' ')
    .trim();
}

const tempRoot = process.env.TEMP || process.env.TMP || resolve('..', '_isolated_temp');
const chromePath = process.env.CHROMIUM_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TRANSIENT_RM_CODES = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES', 'EMFILE', 'ENFILE']);

function killOrphanChromeForUserDataDir(userDataDir) {
  if (process.platform !== 'win32' || !userDataDir) return 0;
  const resolved = resolve(userDataDir).replace(/'/g, "''");
  const ps = [
    `$needle = '${resolved}'`,
    `$escaped = [regex]::Escape($needle)`,
    `$pattern = $escaped + '(?=$|[\\s"\\\\])'`,
    `$procs = @(Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine -imatch $pattern })`,
    `foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }`,
    `Write-Output $procs.Count`
  ].join('; ');
  try {
    const res = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000
    });
    if (res.status !== 0) return 0;
    return Number(String(res.stdout || '').trim()) || 0;
  } catch {
    return 0;
  }
}

async function removeDirWithRetry(targetDir, profileDir, { maxAttempts = 45, delayMs = 200 } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      rmSync(targetDir, { recursive: true, force: true });
      if (!existsSync(targetDir)) return;
    } catch (err) {
      lastErr = err;
      if (!TRANSIENT_RM_CODES.has(err?.code) || attempt === maxAttempts) {
        throw err;
      }
      if (profileDir && (attempt === 1 || attempt % 5 === 0)) {
        killOrphanChromeForUserDataDir(profileDir);
      }
    }
    await delay(delayMs);
  }
  if (existsSync(targetDir)) {
    throw lastErr || new Error(`Failed to remove temporary directory after ${maxAttempts} attempts: ${targetDir}`);
  }
}

function stats(samples) {
  const valid = samples.filter(n => typeof n === 'number' && Number.isFinite(n)).sort((a, b) => a - b);
  if (!valid.length) return { samples: 0, minMs: null, medianMs: null, p95Ms: null, maxMs: null };
  const mid = Math.floor(valid.length / 2);
  const median = valid.length % 2 ? valid[mid] : (valid[mid - 1] + valid[mid]) / 2;
  const p95Idx = Math.min(valid.length - 1, Math.ceil(valid.length * 0.95) - 1);
  return {
    samples: valid.length,
    minMs: Number(valid[0].toFixed(2)),
    medianMs: Number(median.toFixed(2)),
    p95Ms: Number(valid[p95Idx].toFixed(2)),
    maxMs: Number(valid[valid.length - 1].toFixed(2))
  };
}

function insertEventsBulk(db, events) {
  const insert = db.prepare('INSERT INTO events(id,body) VALUES(?,?)');
  db.exec('BEGIN');
  for (const event of events) insert.run(event.id, JSON.stringify(event));
  db.prepare('UPDATE meta SET revision = ? WHERE id = 1').run(events.length);
  db.exec('COMMIT');
}

function validateEventsReplay(events) {
  const s = emptyState();
  const seen = new Set();
  for (const e of events) applyEvent(s, e, seen);
  return s;
}

function createEventBuilder() {
  const events = [];
  const simState = emptyState();
  const seen = new Set();
  function push(id, timestamp, command, explicitSchemaVersion = null) {
    const schemaVersion = explicitSchemaVersion ?? eventVersion(command, simState);
    const ev = { id, schemaVersion, timestamp, command };
    applyEvent(simState, ev, seen);
    events.push(ev);
    return ev;
  }
  return { events, simState, push };
}

const TURKISH_GIVEN = [
  'Ahmet', 'Mehmet', 'Ayşe', 'Fatma', 'Mustafa', 'Zeynep', 'İbrahim', 'Emine', 'Hasan', 'Hüseyin',
  'Şahin', 'Çiğdem', 'Gökhan', 'Özge', 'Ömer', 'Ümit', 'Çağlar', 'Şükrü', 'Gülşah', 'İpek',
  'Oğuzhan', 'Yağmur', 'Mücahit', 'Hülya', 'Erdoğan', 'Yıldırım', 'İsmail', 'Işıl', 'Büşra', 'Kürşat'
];
const TURKISH_SURNAMES = [
  'Yılmaz', 'Kaya', 'Demir', 'Çelik', 'Şahin', 'Yıldız', 'Öztürk', 'Aydın', 'Özdemir', 'Arslan',
  'Doğan', 'Kılıç', 'Aslan', 'Çetin', 'Kara', 'Koç', 'Kurt', 'Özkan', 'Şimşek', 'Ünal',
  'Çağlar', 'Boğaziçi', 'Aydınlı', 'Güneş', 'Çınar', 'Erdoğan', 'Aktaş', 'Başaran', 'Korkmaz', 'Polat'
];

function buildR1StandardEvents() {
  const d0 = '2026-11-10';
  const d1 = '2026-11-11';
  const balances = Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => {
    if (a.id === 'nakit') return [a.id, '2500000'];
    if (a.id === 'banka') return [a.id, '2500000'];
    if (a.id === 'usd') return [a.id, '50000'];
    if (a.id === 'eur') return [a.id, '50000'];
    if (a.id === 'ceyrek') return [a.id, '100'];
    if (a.id === 'yarim') return [a.id, '50'];
    if (a.id === 'ziynet') return [a.id, '30'];
    if (a.id === 'cumhuriyet') return [a.id, '25'];
    if (a.id === 'resat') return [a.id, '10'];
    if (a.id === 'bilezik22') return [a.id, '5000'];
    if (a.id === 'taki14') return [a.id, '5000'];
    if (a.id === 'taki22') return [a.id, '5000'];
    if (a.id === 'gramToplam') return [a.id, '1000'];
    if (a.id === 'hurda22') return [a.id, '500'];
    if (a.id === 'saat') return [a.id, '20'];
    return [a.id, '0'];
  }));

  const { events, simState, push } = createEventBuilder();
  push('r1-open', `${d0}T08:00:00Z`, { type: 'opening', date: d0, balances }, 3);

  const customers = [
    ['cust-ahmet-tl', 'Ahmet Yılmaz', 'TL', '1500.00', '05321110001', '11111111111'],
    ['cust-ahmet-has', 'Ahmet Yılmaz', 'HAS', '5.000', '05321110002', '11111111112'],
    ['cust-mehmet-1', 'Mehmet Yılmaz', 'TL', '2500.00', '05321110003', '11111111113'],
    ['cust-mehmet-2', 'Mehmet Yılmaz (Merkez)', 'TL', '0', '05321110004', '11111111114'],
    ['cust-sahin', 'Şahin Çelik', 'TL', '1000.00', '05321110005', '11111111115'],
    ['cust-cagla', 'Çağla Öztürk', 'TL', '0', '05321110006', '11111111116'],
    ['cust-isik', 'Işık Aydın', 'TL', '-800.00', '05321110007', '11111111117'],
    ['cust-ismail', 'İsmail Koç', 'TL', '0', '05321110008', '11111111118'],
    ['cust-gokhan', 'Gökhan Ünal', 'USD', '200.00', '05321110009', '11111111119'],
    ['cust-zeynep', 'Zeynep Şimşek', 'TL', '3200.00', '05321110010', '11111111120'],
    ['cust-ayse', 'Ayşe Kaya', 'TL', '0', '05321110011', '11111111121'],
    ['cust-ayse-has', 'Ayşe Kaya', 'HAS', '0', '05321110012', '11111111122'],
    ['cust-fatma', 'Fatma Güneş', 'TL', '0', '05321110013', '11111111123'],
    ['cust-omer', 'Ömer Arslan', 'EUR', '150.00', '05321110014', '11111111124'],
    ['cust-hulya', 'Hülya Yıldırım', 'TL', '0', '05321110015', '11111111125']
  ];
  for (const [id, name, unit, opening, phone, taxId] of customers) {
    push(id, `${d0}T08:05:00Z`, { type: 'account', date: d0, name, unit, partyType: 'customer', opening, phone, taxId, address: 'İstanbul' });
  }

  push('r1-stk-burma', `${d0}T08:06:00Z`, { type: 'stockAccount', date: d0, name: '22 AYAR BURMA BİLEZİK', unit: 'ADET', pairedGroups: ['bilezik22'], opening: '0', isSaleable: true });
  push('r1-stk-sahmeran-zincir', `${d0}T08:06:30Z`, { type: 'stockAccount', date: d0, name: '14 AYAR ŞAHMERAN ZİNCİR', unit: 'ADET', pairedGroups: ['taki14'], opening: '0', isSaleable: true });
  push('r1-stk-in-1', `${d0}T08:07:00Z`, {
    type: 'stock',
    date: d0,
    direction: 'in',
    category: 'Stok girişi',
    items: [
      { accountId: 'stock-r1-stk-burma', quantity: '10', weightAccount: 'bilezik22', weight: '200.000' },
      { accountId: 'stock-r1-stk-sahmeran-zincir', quantity: '15', weightAccount: 'taki14', weight: '90.000' },
      { accountId: 'yuzuk', quantity: '10', weightAccount: 'taki14', weight: '40.000' },
      { accountId: 'sahmeran', quantity: '10', weightAccount: 'taki14', weight: '50.000' }
    ],
    note: 'R1 sentetik stok girişi'
  });
  push('r1-item-1', `${d0}T08:08:00Z`, { type: 'registerItem', date: d0, code: 'SL-001', accountId: 'yuzuk', weightAccount: 'taki14', actualWeight: '4.500', description: 'Tektaş 14 ayar yüzük' });
  push('r1-item-2', `${d0}T08:08:30Z`, { type: 'registerItem', date: d0, code: 'SL-002', accountId: 'sahmeran', weightAccount: 'taki14', actualWeight: '6.250', description: 'Özel şahmeran' });

  const suppliers = [
    ['r1-firm-1', 'Özkan Altın Toptan', '02125550001', '3000000001', ['HAS', 'TL']],
    ['r1-firm-2', 'Çelik Has Maden A.Ş.', '02125550002', '3000000002', ['HAS', 'TL']],
    ['r1-firm-3', 'Şahin Değerli Metal', '02125550003', '3000000003', ['HAS', 'USD']]
  ];
  for (const [fid, name, phone, taxId, uList] of suppliers) {
    push(fid, `${d0}T08:10:00Z`, { type: 'supplierFirm', date: d0, name, phone, taxId, address: 'Kapalıçarşı' });
    for (const u of uList) {
      push(`${fid}-${u.toLowerCase()}`, `${d0}T08:11:00Z`, { type: 'supplierUnit', date: d0, supplierId: `supplier-${fid}`, unit: u });
    }
  }
  push('r1-sup-pur-1', `${d0}T09:00:00Z`, {
    type: 'supplierPurchase',
    date: d0,
    supplierId: 'supplier-r1-firm-1',
    items: [{ accountId: 'ceyrek', quantity: '5' }],
    charges: [{ accountId: 'supplier-unit-r1-firm-1-has', quantity: '8.000' }],
    given: [],
    received: [],
    credits: [],
    debts: [],
    note: 'R1 toptancı çeyrek alışı'
  });
  push('r1-sup-pay-1', `${d0}T09:30:00Z`, {
    type: 'supplierPayment',
    date: d0,
    supplierId: 'supplier-r1-firm-1',
    advanceScope: 'general',
    given: [{ accountId: 'nakit', quantity: '10000' }],
    credits: [{ accountId: 'supplier-unit-r1-firm-1-tl', quantity: '10000' }],
    received: [],
    debts: [],
    note: 'R1 toptancı avans ödemesi'
  });

  push('r1-sale-0', `${d0}T10:00:00Z`, {
    type: 'sale',
    date: d0,
    items: [{ accountId: 'ceyrek', quantity: '1', value: '5500' }],
    payments: [{ accountId: 'nakit', quantity: '4500' }],
    credits: [{ accountId: 'cari-cust-sahin', quantity: '1000' }],
    scrap: [],
    note: 'Şahin Çelik çeyrek satışı'
  });
  push('r1-pur-0', `${d0}T11:00:00Z`, {
    type: 'purchase',
    date: d0,
    source: 'customer',
    counterpartyId: 'cari-cust-ahmet-tl',
    items: [{ accountId: 'hurda22', quantity: '2.000', value: '6000' }],
    payments: [{ accountId: 'nakit', quantity: '6000' }],
    debts: [],
    note: 'Ahmet Yılmaz hurda alışı'
  });
  push('r1-col-0', `${d0}T12:00:00Z`, {
    type: 'collection',
    date: d0,
    customerAccount: 'cari-cust-zeynep',
    direction: 'collect',
    target: 'nakit',
    quantity: '200',
    note: 'Zeynep kısmi tahsilat'
  });

  push('r1-stk-d0', `${d0}T19:50:00Z`, { type: 'stocktake', date: d0, approvedBy: 'R1 Yönetici', reasons: {}, counts: { taki14: decimal(simState.balances.taki14 || 0, 'GRAM') } });
  const dailyCountsD0 = {};
  for (const a of simState.accounts) {
    if (!a.retired && a.physical && currentCountPolicy(a) === 'daily') {
      dailyCountsD0[a.id] = decimal(simState.balances[a.id] || 0, a.unit);
    }
  }
  push('r1-close-d0', `${d0}T20:00:00Z`, { type: 'close', date: d0, nextDate: d1, approvedBy: 'R1 Yönetici', reasons: {}, counts: dailyCountsD0 });

  push('r1-sale-1', `${d1}T10:15:00Z`, {
    type: 'sale',
    date: d1,
    items: [{ accountId: 'yarim', quantity: '1', value: '11000' }],
    payments: [{ accountId: 'nakit', quantity: '11000' }],
    credits: [],
    scrap: [],
    note: 'Peşin yarım altın satışı'
  });
  push('r1-sale-2', `${d1}T11:30:00Z`, {
    type: 'sale',
    date: d1,
    items: [{ accountId: 'yuzuk', quantity: '1', weightAccount: 'taki14', weight: '3.500', value: '9500' }],
    payments: [{ accountId: 'nakit', quantity: '9500' }],
    credits: [],
    scrap: [],
    note: 'Çağla Öztürk yüzük satışı'
  });
  push('r1-mov-1', `${d1}T12:10:00Z`, { type: 'movement', date: d1, accountId: 'nakit', direction: 'out', category: 'Gider', quantity: '350', note: 'Elektrik faturası' });

  return events;
}

function buildR4Events(customerCount = 5000, targetEvents = 15000) {
  const days = 5;
  const startDay = new Date('2026-11-10T00:00:00Z');
  const dayStr = idx => new Date(startDay.getTime() + idx * 86400000).toISOString().slice(0, 10);
  const d0 = dayStr(0);

  const balances = Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => {
    if (a.id === 'nakit') return [a.id, '50000000'];
    if (a.id === 'banka') return [a.id, '50000000'];
    if (a.id === 'usd') return [a.id, '500000'];
    if (a.id === 'eur') return [a.id, '500000'];
    if (a.id === 'ceyrek') return [a.id, '50000'];
    if (a.id === 'yarim') return [a.id, '10000'];
    if (a.id === 'ziynet') return [a.id, '10000'];
    if (a.id === 'cumhuriyet') return [a.id, '10000'];
    if (a.id === 'resat') return [a.id, '5000'];
    if (a.id === 'bilezik22') return [a.id, '100000'];
    if (a.id === 'taki14') return [a.id, '100000'];
    if (a.id === 'taki22') return [a.id, '100000'];
    if (a.id === 'gramToplam') return [a.id, '20000'];
    if (a.id.startsWith('hurda')) return [a.id, '5000'];
    if (a.id === 'saat') return [a.id, '1000'];
    return [a.id, '0'];
  }));

  const { events, simState, push } = createEventBuilder();
  push('r4-open', `${d0}T08:00:00Z`, {
    type: 'opening',
    date: d0,
    balances,
    banks: [
      { name: 'Ziraat Bankası TL', unit: 'TL', opening: '1000000' },
      { name: 'Garanti USD', unit: 'USD', opening: '50000' }
    ]
  });

  // Customers: Cohort A (50 cross-unit pairs = 100), Cohort B (100 same-unit similar/Turkish pairs = 200), Cohort C (remaining)
  const customerIds = [];
  const tlCustomerIds = [];
  const nonZeroTlCustomers = [];
  let cSeq = 0;
  const pushCustomer = (id, name, unit, opening, phone, taxId) => {
    push(id, `${d0}T08:01:00Z`, {
      type: 'account',
      date: d0,
      name,
      unit,
      partyType: 'customer',
      opening,
      ...(phone ? { phone } : {}),
      ...(taxId ? { taxId } : {}),
      address: 'İstanbul'
    });
    const cariId = `cari-${id}`;
    customerIds.push(cariId);
    if (unit === 'TL') {
      tlCustomerIds.push(cariId);
      if (opening !== '0') nonZeroTlCustomers.push({ id: cariId, unit, balance: Math.round(Number(opening) * 100) });
    }
    cSeq++;
  };

  // Cohort A: 50 cross-unit exact-name pairs (100 accounts)
  const crossUnits = ['HAS', 'USD', 'EUR'];
  for (let i = 0; i < 50; i++) {
    const baseName = i === 0
      ? 'Ayşe Kaya'
      : i === 1
        ? 'İbrahim Şahin'
        : i === 2
          ? 'Çiğdem Öztürk'
          : i === 3
            ? 'Ümit Çağlar'
            : `${TURKISH_GIVEN[i % TURKISH_GIVEN.length]} ${TURKISH_SURNAMES[Math.floor(i / 2) % TURKISH_SURNAMES.length]} Çift ${i}`;
    const altUnit = crossUnits[i % crossUnits.length];
    pushCustomer(`r4-ca-${i}-tl`, baseName, 'TL', i % 2 === 0 ? '1500.00' : '0', `0532100${String(i * 2).padStart(4, '0')}`, String(10000000001 + i * 2));
    pushCustomer(`r4-ca-${i}-alt`, baseName, altUnit, '0', `0532100${String(i * 2 + 1).padStart(4, '0')}`, String(10000000002 + i * 2));
  }

  // Cohort B: 100 same-unit similar-name & Turkish diacritic/case pairs (200 accounts in TL)
  const cohortBPairs = [
    ['Mehmet Yılmaz', 'Mehmet Yılmaz (Merkez)'],
    ['İsmail Şahin', 'Ismail Sahin'],
    ['Işıl Özkan', 'Isil Ozkan'],
    ['Gökhan Çınar', 'Gokhan Cinar'],
    ['Ömer Ünal', 'Omer Unal'],
    ['Ahmet Çelik', 'Ahmet Çeliköz'],
    ['Fatma Güneş', 'Fatma Güneştekin'],
    ['Şahin Erdoğan', 'Sahin Erdogan']
  ];
  for (let i = 0; i < 100; i++) {
    const pair = cohortBPairs[i] || [`${TURKISH_GIVEN[(i + 3) % TURKISH_GIVEN.length]} ${TURKISH_SURNAMES[(i + 7) % TURKISH_SURNAMES.length]} #B${i}`, `${TURKISH_GIVEN[(i + 3) % TURKISH_GIVEN.length]} ${TURKISH_SURNAMES[(i + 7) % TURKISH_SURNAMES.length]} (Şube) #B${i}`];
    pushCustomer(`r4-cb-${i}-a`, pair[0], 'TL', i % 5 === 0 ? '2000.00' : '0', `0533100${String(i * 2).padStart(4, '0')}`, String(20000000001 + i * 2));
    pushCustomer(`r4-cb-${i}-b`, pair[1], 'TL', '0', `0533100${String(i * 2 + 1).padStart(4, '0')}`, String(20000000002 + i * 2));
  }

  // Cohort C: remaining bulk Turkish customers
  const remainingCust = customerCount - cSeq;
  for (let i = 0; i < remainingCust; i++) {
    const g = TURKISH_GIVEN[i % TURKISH_GIVEN.length];
    const s = TURKISH_SURNAMES[Math.floor(i / TURKISH_GIVEN.length) % TURKISH_SURNAMES.length];
    const name = `${g} ${s} ${i + 1}`;
    const r = i % 100;
    const unit = r < 85 ? 'TL' : r < 92 ? 'HAS' : r < 96 ? 'USD' : 'EUR';
    const opening = unit === 'TL' && i % 5 === 0 ? (i % 10 === 0 ? '1500.00' : '-750.00') : '0';
    const phone = i % 100 < 85 ? `054${i % 10}${String(1000000 + i).slice(-7)}` : undefined;
    const taxId = i % 100 < 60 ? String(30000000000 + i) : undefined;
    pushCustomer(`r4-cc-${i}`, name, unit, opening, phone, taxId);
  }

  // Stocks: 2,000 synthetic stocks
  const pairedGroupsCycle = ['taki14', 'taki22', 'bilezik22'];
  const pairedStockIds = [];
  for (let i = 0; i < 1000; i++) {
    const id = `r4-sp-${i}`;
    const group = pairedGroupsCycle[i % 3];
    const prefix = i === 0 ? '14 AYAR ŞAHMERAN ZİNCİR ÖZEL' : i === 1 ? '22 AYAR BURMA BİLEZİK ÖZEL' : i < 350 ? '14 AYAR ŞAHMERAN ZİNCİR' : i < 700 ? 'ÇİÇEK DESEN YÜZÜK' : '22 AYAR BURMA BİLEZİK';
    push(id, `${d0}T08:02:00Z`, { type: 'stockAccount', date: d0, name: `${prefix} ${String(i + 1).padStart(4, '0')}`, unit: 'ADET', pairedGroups: [group], opening: '0', isSaleable: true });
    const fullId = `stock-${id}`;
    if (i < 900) pairedStockIds.push({ id: fullId, group });
  }
  for (let i = 0; i < pairedStockIds.length; i += 30) {
    const slice = pairedStockIds.slice(i, i + 30);
    push(`r4-stkin-${i}`, `${d0}T08:03:00Z`, {
      type: 'stock',
      date: d0,
      direction: 'in',
      category: 'Stok girişi',
      items: slice.map(s => ({ accountId: s.id, quantity: '5', weightAccount: s.group, weight: '25.000' })),
      note: 'Sentetik eşli stok girişi'
    });
  }
  for (let i = 0; i < 500; i++) {
    push(`r4-sa-${i}`, `${d0}T08:04:00Z`, { type: 'stockAccount', date: d0, name: `GÜMÜŞ İNCİ KOLYE ${String(i + 1).padStart(4, '0')}`, unit: 'ADET', pairedGroups: [], opening: '15', isSaleable: true });
  }
  for (let i = 0; i < 450; i++) {
    push(`r4-sg-${i}`, `${d0}T08:05:00Z`, { type: 'stockAccount', date: d0, name: `ÖZEL İŞÇİLİKLİ KÜNYE ${String(i + 1).padStart(4, '0')}`, unit: 'GRAM', countPolicy: 'periodic', opening: '50.000', isSaleable: true });
  }
  for (let i = 0; i < 50; i++) {
    push(`r4-sbuy-${i}`, `${d0}T08:06:00Z`, { type: 'stockAccount', date: d0, name: `HAS KÜLÇE SERİ ${String(i + 1).padStart(4, '0')}`, unit: 'GRAM', countPolicy: 'periodic', opening: '25.000', isSaleable: false });
  }

  // 100 Multi-unit Suppliers
  const supplierNames = ['Çelik Has Altın A.Ş.', 'Şahin Değerli Madenler Ltd.', 'Özkan Altın Toptan', 'Özkan Altın Toptan (Ankara)'];
  const supplierInfo = [];
  for (let i = 0; i < 100; i++) {
    const fid = `r4-firm-${i}`;
    const supId = `supplier-${fid}`;
    const name = i < supplierNames.length ? supplierNames[i] : `${TURKISH_SURNAMES[i % TURKISH_SURNAMES.length]} Değerli Maden ${i + 1}`;
    push(fid, `${d0}T08:07:00Z`, { type: 'supplierFirm', date: d0, name, phone: `0212600${String(i).padStart(4, '0')}`, taxId: String(4000000001 + i), address: 'Kapalıçarşı' });
    const hasEv = `r4-u-has-${i}`;
    push(hasEv, `${d0}T08:07:10Z`, { type: 'supplierUnit', date: d0, supplierId: supId, unit: 'HAS' });
    const tlEv = `r4-u-tl-${i}`;
    push(tlEv, `${d0}T08:07:20Z`, { type: 'supplierUnit', date: d0, supplierId: supId, unit: 'TL' });
    let usdAcc = null;
    if (i < 20) {
      const usdEv = `r4-u-usd-${i}`;
      push(usdEv, `${d0}T08:07:30Z`, { type: 'supplierUnit', date: d0, supplierId: supId, unit: 'USD' });
      usdAcc = `supplier-unit-${usdEv}`;
    }
    supplierInfo.push({ supId, hasAcc: `supplier-unit-${hasEv}`, tlAcc: `supplier-unit-${tlEv}`, usdAcc });
  }

  const dailyAccounts = simState.accounts.filter(a => !a.retired && a.physical && currentCountPolicy(a) === 'daily');

  // Multi-day journal events across 5 days (2026-11-10..2026-11-14)
  const perDayTarget = Math.max(200, Math.floor((targetEvents - events.length - (days - 1) * 2) / days));
  let seq = 0;
  let colIdx = 0;
  for (let d = 0; d < days; d++) {
    const date = dayStr(d);
    const openPurchases = [];
    for (let j = 0; j < perDayTarget && events.length < targetEvents - (days - 1 - d) * 2; j++) {
      const idx = seq++;
      const mod = idx % 10;
      const custId = tlCustomerIds[idx % tlCustomerIds.length];
      if (mod < 4) {
        push(`r4-sale-${idx}`, `${date}T10:00:00Z`, {
          type: 'sale',
          date,
          items: [{ accountId: 'ceyrek', quantity: '1', value: '5500' }],
          payments: [{ accountId: 'nakit', quantity: '5500' }],
          credits: [],
          scrap: [],
          note: idx < 50 ? 'Ayşe Kaya çeyrek satış' : `Satış #${idx}`
        });
      } else if (mod < 6) {
        push(`r4-pur-${idx}`, `${date}T11:00:00Z`, {
          type: 'purchase',
          date,
          source: 'customer',
          counterpartyId: custId,
          items: [{ accountId: 'hurda22', quantity: '1.500', value: '4500' }],
          payments: [{ accountId: 'nakit', quantity: '4500' }],
          debts: [],
          note: idx < 60 ? 'Mehmet Yılmaz hurda alış' : `Alış #${idx}`
        });
      } else if (mod === 6 && colIdx < nonZeroTlCustomers.length) {
        const target = nonZeroTlCustomers[colIdx++];
        const curBal = simState.balances[target.id] || 0;
        if (curBal !== 0) {
          const dir = curBal > 0 ? 'collect' : 'pay';
          push(`r4-col-${idx}`, `${date}T12:00:00Z`, {
            type: 'collection',
            date,
            customerAccount: target.id,
            direction: dir,
            target: 'nakit',
            quantity: '100.00',
            note: `Cari tahsilat #${idx}`
          });
        } else {
          push(`r4-mov-${idx}`, `${date}T12:00:00Z`, { type: 'movement', date, accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '10.00', note: `Hareket #${idx}` });
        }
      } else if (mod === 7 && idx < 250) {
        const sup = supplierInfo[idx % 50];
        const pid = `r4-spur-${idx}`;
        push(pid, `${date}T13:00:00Z`, {
          type: 'supplierPurchase',
          date,
          supplierId: sup.supId,
          items: [{ accountId: 'ceyrek', quantity: '2' }],
          charges: [{ accountId: sup.hasAcc, quantity: '3.200' }],
          given: [],
          received: [],
          credits: [],
          debts: [],
          note: `Toptancı alış #${idx}`
        });
        openPurchases.push({ id: pid, sup });
      } else if (mod === 8 && openPurchases.length) {
        const target = openPurchases.pop();
        const payId = `r4-spay-${idx}`;
        push(payId, `${date}T14:00:00Z`, {
          type: 'supplierPayment',
          date,
          supplierId: target.sup.supId,
          advanceScope: 'general',
          given: [{ accountId: 'nakit', quantity: '1000' }],
          credits: [{ accountId: target.sup.hasAcc, quantity: '1.000' }],
          received: [],
          debts: [],
          note: `Toptancı ödeme #${idx}`
        });
        push(`r4-salloc-${idx}`, `${date}T14:10:00Z`, {
          type: 'supplierAllocation',
          date,
          supplierId: target.sup.supId,
          allocations: [{ sourceId: payId, purchaseId: target.id, accountId: target.sup.hasAcc, quantity: '1.000' }],
          note: `Toptancı tahsis #${idx}`
        });
      } else {
        push(`r4-mov-${idx}`, `${date}T15:00:00Z`, {
          type: 'movement',
          date,
          accountId: 'nakit',
          direction: 'in',
          category: 'Sermaye',
          quantity: '10.00',
          note: idx % 25 === 0 ? 'İsmail Şahin sermaye' : `Hareket #${idx}`
        });
      }
    }
    if (d < days - 1) {
      const counts = {};
      for (const a of dailyAccounts) {
        counts[a.id] = decimal(simState.balances[a.id] || 0, a.unit);
      }
      push(`r4-stktake-${d}`, `${date}T19:50:00Z`, { type: 'stocktake', date, approvedBy: 'R4 Yönetici', reasons: {}, counts: { taki14: decimal(simState.balances.taki14 || 0, 'GRAM') } });
      push(`r4-close-${d}`, `${date}T20:00:00Z`, { type: 'close', date, nextDate: dayStr(d + 1), approvedBy: 'R4 Yönetici', reasons: {}, counts });
    }
  }
  return { events, validatedState: simState };
}

async function setupServerAndCredentials(events, label) {
  const dir = mkdtempSync(join(tempRoot, `p6b-${label}-`));
  const dataDir = join(dir, 'data');
  const profileDir = join(dir, 'profile');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(profileDir, { recursive: true });

  const dbPath = join(dataDir, 'demo.sqlite');
  const setupRepo = new Repository(dbPath, 'demo');
  insertEventsBulk(setupRepo.db, events);
  setupRepo.close();

  const coldT0 = performance.now();
  const verifyRepo = new Repository(dbPath, 'demo');
  const state = verifyRepo.state({ compact: true });
  const coldRepoMs = Number((performance.now() - coldT0).toFixed(2));
  verifyRepo.close();

  const password = `P6b-${randomUUID()}-Bench!`;
  const idStore = new IdentityStore(dataDir);
  const ownerUser = await idStore.initializeOwner({ name: 'Sentetik İşletme Sahibi', password });
  const ownerLogin = await idStore.login(ownerUser.id, password);
  await idStore.createEmployee(ownerLogin.token, { name: 'Sentetik Çalışan', password });
  idStore.close();

  const { server } = createApp({ dataDirectory: dataDir });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { dir, dataDir, profileDir, origin, password, state, coldRepoMs, server };
}

async function launchCdpBrowser(profileDir) {
  if (!existsSync(chromePath)) throw new Error(`Chrome binary not found at: ${chromePath}`);
  const browser = spawn(chromePath, [
    '--headless=new',
    '--no-first-run',
    '--disable-default-apps',
    '--disable-background-networking',
    '--remote-debugging-pipe',
    '--enable-precise-memory-info',
    `--user-data-dir=${profileDir}`,
    'about:blank'
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });

  let counter = 0;
  let buffer = '';
  let sessionId = null;
  let closed = false;
  const pending = new Map();

  browser.stdio[4].setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\0')) !== -1) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const call = pending.get(message.id);
      if (call) {
        pending.delete(message.id);
        if (message.error) call.reject(new Error(`${message.error.message} (${call.method})`));
        else call.resolve(message.result);
      }
    }
  });

  browser.on('exit', () => {
    for (const [, entry] of pending) {
      entry.reject(new Error(`${entry.method}: Chrome exited before reply`));
    }
    pending.clear();
  });

  function call(method, params = {}, sid = sessionId) {
    if (closed) return Promise.reject(new Error(`CDP closed before calling ${method}`));
    return new Promise((resolveCall, rejectCall) => {
      const id = ++counter;
      pending.set(id, { resolve: resolveCall, reject: rejectCall, method });
      try {
        browser.stdio[3].write(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) }) + '\0');
      } catch (err) {
        pending.delete(id);
        rejectCall(err);
      }
    });
  }

  const targets = await call('Target.getTargets', {}, null);
  const page = targets.targetInfos.find(info => info.type === 'page');
  ({ sessionId } = await call('Target.attachToTarget', { targetId: page.targetId, flatten: true }, null));

  await call('Page.enable');
  await call('Runtime.enable');
  await call('Performance.enable');
  await call('DOM.enable');
  await call('HeapProfiler.enable');

  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const desc = el => {
        if (!el) return 'null';
        if (el === document.body) return 'body';
        if (el.id) return '#' + el.id;
        return el.tagName.toLowerCase() + (el.dataset?.view ? '[data-view=' + el.dataset.view + ']' : '');
      };
      let lastEl = null;
      const state = { focusChanges: 0, bodyDrops: 0, screenTransitions: 0, lastSnap: '' };
      const snap = () => {
        const h = document.querySelector('#main h1, #main h2, main h1')?.textContent?.trim() || '';
        const rev = document.querySelector('#review')?.hidden === false ? 'review' : '';
        const step = document.querySelector('[data-step-panel].is-active')?.dataset?.stepPanel || '';
        const dlg = document.querySelector('dialog[open]') ? 'dialog' : '';
        return [location.pathname, location.hash, h, rev, step, dlg].join('|');
      };
      document.addEventListener('focusin', () => {
        const cur = document.activeElement;
        if (cur !== lastEl) {
          state.focusChanges++;
          if (cur === document.body) state.bodyDrops++;
          lastEl = cur;
        }
      }, true);
      const checkSnap = () => {
        const s = snap();
        if (state.lastSnap && s !== state.lastSnap) state.screenTransitions++;
        state.lastSnap = s;
      };
      window.addEventListener('hashchange', checkSnap);
      document.addEventListener('DOMContentLoaded', () => {
        state.lastSnap = snap();
        const mo = new MutationObserver(checkSnap);
        mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'open', 'class'] });
      });
      window.__p6bBench = {
        reset() {
          state.focusChanges = 0;
          state.bodyDrops = 0;
          state.screenTransitions = 0;
          state.lastSnap = snap();
          lastEl = document.activeElement;
        },
        read() { return { ...state }; },
        doubleRAF() {
          return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        }
      };
    })();`
  });

  async function evaluate(expression) {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Browser eval failed');
    }
    return result.result.value;
  }

  async function until(expression, timeoutMs = 15000, pollMs = 10) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      try {
        if (await evaluate(expression)) return;
      } catch {}
      await delay(pollMs);
    }
    let diag = '';
    try {
      diag = await evaluate(`JSON.stringify({
        path: location.pathname,
        hash: location.hash,
        notice: document.querySelector('#notice')?.textContent?.trim(),
        toast: [...document.querySelectorAll('.defter-toast-body')].map(e => e.textContent.trim()),
        status: document.querySelector('#status')?.textContent?.trim(),
        remainder: document.querySelector('#sale-remainder')?.textContent?.trim(),
        busy: document.body?.getAttribute('aria-busy'),
        invalid: [...document.querySelectorAll('input,select,textarea')].filter(e => !e.disabled && !e.validity.valid).map(e => ({ id: e.id, name: e.name, msg: e.validationMessage, val: e.value })).slice(0, 5)
      })`);
    } catch {}
    throw new Error(`Timeout (${timeoutMs}ms) waiting for: ${expression} | diag=${diag}`);
  }

  const actions = { clicks: 0, keystrokes: 0 };
  const resetActions = () => { actions.clicks = 0; actions.keystrokes = 0; };

  async function setViewport(width, height = 900) {
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width <= 480 });
  }

  async function cdpClick(selector) {
    const box = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { found: false };
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      return { found: true, x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, disabled: Boolean(el.disabled), hidden: Boolean(el.closest('[hidden]')) };
    })()`);
    if (!box?.found || box.w === 0 || box.h === 0) throw new Error(`Element not clickable or missing: ${selector} (${JSON.stringify(box)})`);
    if (box.disabled) throw new Error(`Element disabled: ${selector}`);
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    actions.clicks++;
    return box;
  }

  async function cdpKey(key, opts = {}) {
    const map = {
      k: { code: 'KeyK', vk: 75, key: 'k' },
      K: { code: 'KeyK', vk: 75, key: 'k' },
      a: { code: 'KeyA', vk: 65, key: 'a' },
      Enter: { code: 'Enter', vk: 13, key: 'Enter', text: '\r' },
      Escape: { code: 'Escape', vk: 27, key: 'Escape' },
      Tab: { code: 'Tab', vk: 9, key: 'Tab' },
      ArrowDown: { code: 'ArrowDown', vk: 40, key: 'ArrowDown' },
      ArrowUp: { code: 'ArrowUp', vk: 38, key: 'ArrowUp' },
      Home: { code: 'Home', vk: 36, key: 'Home' },
      End: { code: 'End', vk: 35, key: 'End' },
      Backspace: { code: 'Backspace', vk: 8, key: 'Backspace' }
    };
    const spec = map[key] || {
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      vk: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
      key
    };
    const modifiers = (opts.alt ? 1 : 0) | (opts.ctrl ? 2 : 0) | (opts.meta ? 4 : 0) | (opts.shift ? 8 : 0);
    const plainEnter = spec.key === 'Enter' && !opts.ctrl && !opts.meta && !opts.alt;
    await call('Input.dispatchKeyEvent', {
      type: plainEnter ? 'keyDown' : 'rawKeyDown',
      modifiers,
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.vk,
      ...(plainEnter ? { text: '\r', unmodifiedText: '\r' } : {})
    });
    await call('Input.dispatchKeyEvent', {
      type: 'keyUp',
      modifiers,
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.vk
    });
    actions.keystrokes++;
  }

  async function cdpType(selector, text, { focusFirst = true, clear = false } = {}) {
    if (focusFirst && selector) await cdpClick(selector);
    if (clear && selector) {
      await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); } })()`);
    }
    for (const ch of String(text)) {
      await call('Input.insertText', { text: ch });
      actions.keystrokes++;
    }
  }

  async function cdpSelect(selector, value) {
    await cdpClick(selector);
    const meta = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const optCount = el.options.length;
      const ok = [...el.options].some(o => o.value === ${JSON.stringify(value)});
      if (!ok) return { ok: false, optCount };
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, optCount };
    })()`);
    if (!meta?.ok) throw new Error(`Option ${value} not found in ${selector}`);
    actions.keystrokes++;
    return meta;
  }

  async function cdpComboboxSelect(backingSelector, query, matchText, { clear = true } = {}) {
    const box = await evaluate(`(() => {
      const backing = document.querySelector(${JSON.stringify(backingSelector)});
      if (!backing) return { found: false, reason: 'backing-missing' };
      let combo = backing.getAttribute('role') === 'combobox' ? backing : null;
      if (!combo && backing.id === 'customer') {
        combo = document.querySelector('#search[role="combobox"]');
      }
      if (!combo && backing.matches('[data-product]')) {
        combo = backing.closest('[data-item], .checkout-line')?.querySelector('[data-product-search][role="combobox"]') || null;
      }
      if (!combo) {
        combo = backing.closest('.defter-combobox, .field, label')?.querySelector('.defter-combobox-input[role="combobox"], [role="combobox"]')
          || backing.parentElement?.querySelector('.defter-combobox-input[role="combobox"], [role="combobox"]')
          || null;
      }
      if (!combo) return { found: false, reason: 'combobox-missing' };
      combo.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = combo.getBoundingClientRect();
      return {
        found: true,
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        w: r.width,
        h: r.height,
        disabled: Boolean(combo.disabled)
      };
    })()`);
    if (!box?.found || box.w === 0 || box.h === 0) {
      throw new Error(`Combobox input not clickable/missing for ${backingSelector} (${JSON.stringify(box)})`);
    }
    if (box.disabled) throw new Error(`Combobox input disabled for ${backingSelector}`);
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    actions.clicks++;

    if (clear) {
      await evaluate(`(() => {
        const backing = document.querySelector(${JSON.stringify(backingSelector)});
        let combo = backing?.getAttribute('role') === 'combobox' ? backing : null;
        if (!combo && backing?.id === 'customer') combo = document.querySelector('#search[role="combobox"]');
        if (!combo && backing?.matches('[data-product]')) combo = backing.closest('[data-item], .checkout-line')?.querySelector('[data-product-search][role="combobox"]') || null;
        if (!combo) combo = backing?.closest('.defter-combobox, .field, label')?.querySelector('.defter-combobox-input[role="combobox"], [role="combobox"]') || backing?.parentElement?.querySelector('.defter-combobox-input[role="combobox"], [role="combobox"]');
        if (combo) combo.value = '';
      })()`);
    }
    if (query) {
      await cdpType(null, query, { focusFirst: false });
    }

    const matchNorm = foldTr(matchText);
    const resolveExpr = `(() => {
      const backing = document.querySelector(${JSON.stringify(backingSelector)});
      let combo = backing?.getAttribute('role') === 'combobox' ? backing : null;
      if (!combo && backing?.id === 'customer') combo = document.querySelector('#search[role="combobox"]');
      if (!combo && backing?.matches('[data-product]')) combo = backing.closest('[data-item], .checkout-line')?.querySelector('[data-product-search][role="combobox"]') || null;
      if (!combo) combo = backing?.closest('.defter-combobox, .field, label')?.querySelector('.defter-combobox-input[role="combobox"], [role="combobox"]') || backing?.parentElement?.querySelector('.defter-combobox-input[role="combobox"], [role="combobox"]');
      const controlsId = combo?.getAttribute('aria-controls') || '';
      const lb = controlsId ? document.getElementById(controlsId) : null;
      return { backing, combo, lb };
    })()`;

    await until(`(() => {
      const fold = s => String(s ?? '').toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').replace(/ı/g, 'i').replace(/\\s+/g, ' ').trim();
      const { combo, lb } = ${resolveExpr};
      if (!combo || !lb || lb.hidden) return false;
      return [...lb.querySelectorAll('[role="option"]')].some(o => o.getAttribute('aria-disabled') !== 'true' && fold(o.textContent).includes(${JSON.stringify(matchNorm)}));
    })()`, 8000);

    const stepInfo = await evaluate(`(() => {
      const fold = s => String(s ?? '').toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').replace(/ı/g, 'i').replace(/\\s+/g, ' ').trim();
      const { combo, lb } = ${resolveExpr};
      const opts = [...lb.querySelectorAll('[role="option"]')];
      const enabled = opts.filter(o => o.getAttribute('aria-disabled') !== 'true');
      const targetIdx = enabled.findIndex(o => fold(o.textContent).includes(${JSON.stringify(matchNorm)}));
      const activeId = combo.getAttribute('aria-activedescendant') || '';
      const activeIdx = enabled.findIndex(o => o.id && o.id === activeId);
      return { targetIdx, activeIdx, enabledCount: enabled.length };
    })()`);

    if (stepInfo.targetIdx < 0) {
      throw new Error(`Combobox match "${matchText}" not found in enabled options for ${backingSelector}`);
    }
    if (stepInfo.activeIdx !== stepInfo.targetIdx) {
      if (stepInfo.activeIdx < 0 || stepInfo.activeIdx > stepInfo.targetIdx) {
        await cdpKey('Home');
        for (let i = 0; i < stepInfo.targetIdx; i++) {
          await cdpKey('ArrowDown');
        }
      } else {
        for (let i = stepInfo.activeIdx; i < stepInfo.targetIdx; i++) {
          await cdpKey('ArrowDown');
        }
      }
    }

    await cdpKey('Enter');
    await until(`(() => {
      const { backing, combo } = ${resolveExpr};
      if (!combo) return false;
      const expanded = combo.getAttribute('aria-expanded');
      if (expanded !== 'false') return false;
      if (backing && backing.tagName === 'SELECT') return backing.value !== '';
      return true;
    })()`, 5000);
  }

  async function cdpPaletteSelect(query, matchText) {
    await cdpKey('k', { ctrl: true });
    await until("Boolean(document.querySelector('dialog[data-command-palette][open]')) && Boolean(document.activeElement?.matches('[data-command-palette-input]'))", 5000);
    if (query) {
      await cdpType(null, query, { focusFirst: false });
    }
    const matchNorm = foldTr(matchText);
    await until(`(() => {
      const fold = s => String(s ?? '').toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').replace(/ı/g, 'i').replace(/\\s+/g, ' ').trim();
      const list = document.querySelector('[data-command-palette-list]');
      if (!list) return false;
      return [...list.querySelectorAll('[role="option"]')].some(o => o.getAttribute('aria-disabled') !== 'true' && fold(o.textContent).includes(${JSON.stringify(matchNorm)}));
    })()`, 5000);

    const stepInfo = await evaluate(`(() => {
      const fold = s => String(s ?? '').toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').replace(/ı/g, 'i').replace(/\\s+/g, ' ').trim();
      const input = document.querySelector('[data-command-palette-input]');
      const list = document.querySelector('[data-command-palette-list]');
      const enabled = [...list.querySelectorAll('[role="option"]')].filter(o => o.getAttribute('aria-disabled') !== 'true');
      const targetIdx = enabled.findIndex(o => fold(o.textContent).includes(${JSON.stringify(matchNorm)}));
      const activeId = input?.getAttribute('aria-activedescendant') || '';
      const activeIdx = enabled.findIndex(o => o.id && o.id === activeId);
      return { targetIdx, activeIdx };
    })()`);

    if (stepInfo.targetIdx < 0) {
      throw new Error(`Palette match "${matchText}" not found`);
    }
    if (stepInfo.activeIdx !== stepInfo.targetIdx) {
      if (stepInfo.activeIdx < 0 || stepInfo.activeIdx > stepInfo.targetIdx) {
        await cdpKey('Home');
        for (let i = 0; i < stepInfo.targetIdx; i++) await cdpKey('ArrowDown');
      } else {
        for (let i = stepInfo.activeIdx; i < stepInfo.targetIdx; i++) await cdpKey('ArrowDown');
      }
    }
    await cdpKey('Enter');
    await until("!document.querySelector('dialog[data-command-palette][open]')", 5000);
  }

  async function domProbe() {
    const js = await evaluate(`(() => {
      const selects = [...document.querySelectorAll('select')];
      return {
        totalElements: document.querySelectorAll('*').length,
        selectCount: selects.length,
        optionCount: document.querySelectorAll('option').length,
        maxSelectOptions: selects.reduce((m, s) => Math.max(m, s.options.length), 0),
        comboboxOptionCount: document.querySelectorAll('[role="option"]').length
      };
    })()`);
    const counters = await call('Memory.getDOMCounters');
    return { ...js, cdpDocuments: counters.documents, cdpNodes: counters.nodes, cdpEventListeners: counters.jsEventListeners };
  }

  async function heapProbe() {
    await call('HeapProfiler.collectGarbage');
    const jsMem = await evaluate(`(() => {
      const m = performance.memory;
      return m ? { usedJSHeapMB: Number((m.usedJSHeapSize / 1048576).toFixed(2)), totalJSHeapMB: Number((m.totalJSHeapSize / 1048576).toFixed(2)) } : null;
    })()`);
    const cdpHeap = await call('Runtime.getHeapUsage');
    const perf = await call('Performance.getMetrics');
    const metricMap = Object.fromEntries(perf.metrics.map(m => [m.name, m.value]));
    return {
      ...jsMem,
      cdpUsedHeapMB: Number((cdpHeap.usedSize / 1048576).toFixed(2)),
      cdpTotalHeapMB: Number((cdpHeap.totalSize / 1048576).toFixed(2)),
      perfNodes: metricMap.Nodes ?? null,
      perfJSHeapUsedMB: metricMap.JSHeapUsedSize ? Number((metricMap.JSHeapUsedSize / 1048576).toFixed(2)) : null
    };
  }

  async function perfMetrics() {
    const perf = await call('Performance.getMetrics');
    return Object.fromEntries(perf.metrics.map(m => [m.name, m.value]));
  }

  async function close() {
    if (closed) return;
    const exitPromise = new Promise(resolveExit => {
      if (browser.exitCode !== null || browser.signalCode !== null) return resolveExit();
      browser.once('exit', () => resolveExit());
    });
    try {
      await Promise.race([call('Browser.close', {}, null).catch(() => {}), delay(1000)]);
    } catch {}
    closed = true;
    await Promise.race([exitPromise, delay(2000)]);
    if (browser.exitCode === null && browser.signalCode === null && browser.pid) {
      if (process.platform === 'win32') {
        try {
          spawnSync('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { windowsHide: true });
        } catch {}
      } else {
        try { browser.kill('SIGKILL'); } catch {}
      }
      await Promise.race([exitPromise, delay(1000)]);
    }
    if (process.platform === 'win32') {
      killOrphanChromeForUserDataDir(profileDir);
    }
    await delay(150);
  }

  return {
    browser,
    call,
    evaluate,
    until,
    setViewport,
    cdpClick,
    cdpKey,
    cdpType,
    cdpSelect,
    cdpComboboxSelect,
    cdpPaletteSelect,
    actions,
    resetActions,
    domProbe,
    heapProbe,
    perfMetrics,
    close
  };
}

async function loginAs(cdp, origin, userName, password, expectedPath) {
  await cdp.call('Page.navigate', { url: origin });
  await cdp.until("document.querySelector('#login')?.hidden === false && document.querySelector('#user')?.options.length >= 1");
  await cdp.evaluate(`(() => {
    const sel = document.querySelector('#user');
    const opt = [...sel.options].find(o => o.textContent === ${JSON.stringify(userName)});
    if (!opt) throw new Error('User not in #user select: ' + ${JSON.stringify(userName)});
    sel.value = opt.value;
    document.querySelector('#password').value = ${JSON.stringify(password)};
    document.querySelector('#submit').click();
  })()`);
  if (expectedPath === '/owner') {
    await cdp.until("location.pathname === '/owner' && document.body.getAttribute('aria-busy') === 'false' && document.querySelector('#business-date')?.textContent.includes('2026')");
  } else {
    await cdp.until("location.pathname === '/checkout' && !document.querySelector('#trade')?.hidden && document.querySelector('[data-product]')?.value");
  }
  await cdp.evaluate('window.__p6bBench.doubleRAF()');
}

async function runR1Suite() {
  const events = buildR1StandardEvents();
  const env = await setupServerAndCredentials(events, 'r1');
  let cdp;
  try {
    cdp = await launchCdpBrowser(env.profileDir);
    await cdp.setViewport(1440, 900);
    await loginAs(cdp, env.origin, 'Sentetik İşletme Sahibi', env.password, '/owner');

    const scenarios = [];
    async function measureScenario(id, workflow, complexity, surface, fn, structuralNotes = []) {
      cdp.resetActions();
      await cdp.evaluate('window.__p6bBench.reset()');
      const t0 = performance.now();
      const extra = await fn();
      await cdp.evaluate('window.__p6bBench.doubleRAF()');
      const taskLatencyMs = Number((performance.now() - t0).toFixed(2));
      const bench = await cdp.evaluate('window.__p6bBench.read()');
      scenarios.push({
        id,
        workflow,
        complexity,
        surface,
        observed: {
          clicks: cdp.actions.clicks,
          keystrokes: cdp.actions.keystrokes,
          totalActions: cdp.actions.clicks + cdp.actions.keystrokes,
          focusChanges: bench.focusChanges,
          bodyDrops: bench.bodyDrops,
          screenTransitions: bench.screenTransitions,
          taskLatencyMs,
          ...(extra || {})
        },
        structuralNotes
      });
    }

    // Helper to reset /owner to overview cleanly
    const goOverview = async () => {
      await cdp.evaluate(`(() => {
        for (const f of document.querySelectorAll('form[data-draft-dirty]')) f.dataset.draftDirty = 'false';
        for (const k of Object.keys(sessionStorage)) {
          if (k.startsWith('defter-draft:v1:')) sessionStorage.removeItem(k);
        }
        location.hash = '#v=overview';
      })()`);
      await cdp.until("document.querySelector('.overview-screen') && document.body.getAttribute('aria-busy') === 'false'");
      await cdp.evaluate('window.__p6bBench.doubleRAF()');
    };

    // 1. Workflow 1: New Sale (/owner Simple & Complex)
    await goOverview();
    await measureScenario('w1_owner_sale_simple', '1. Yeni satış başlatma', 'simple', '/owner', async () => {
      await cdp.cdpClick('button.quick-action[data-quick-action="sale"]');
      await cdp.until("document.querySelector('#sale-form[data-operation=\"sale\"]')");
      await cdp.cdpType('[data-product-search]', 'çey');
      await cdp.cdpKey('Enter');
      await cdp.until("document.querySelector('[data-item-field=\"accountId\"]').value === 'ceyrek'");
      await cdp.cdpType('#item-value-0', '5500', { clear: true });
      await cdp.until("document.querySelector('[data-quick-fill-cash]') && !document.querySelector('[data-quick-fill-cash]').hidden");
      await cdp.cdpClick('[data-quick-fill-cash]');
      await cdp.cdpClick('#sale-form button[type="submit"]');
      await cdp.until("(document.querySelector('.defter-toast-body')?.textContent.includes('kaydedildi') || document.querySelector('#notice')?.textContent.includes('kaydedildi')) && document.body.getAttribute('aria-busy') === 'false'");
    }, ['Quick mode uses single screen; [data-product-search] auto-selects on Enter and [data-quick-fill-cash] fills cash in 1 click.']);

    await goOverview();
    await measureScenario('w1_owner_sale_complex', '1. Yeni satış başlatma', 'complex', '/owner', async () => {
      await cdp.cdpClick('#navigation button[data-view="transaction"]');
      await cdp.until("document.querySelector('#sale-form[data-operation=\"sale\"]')");
      await cdp.cdpComboboxSelect('#f-counterpartyId', 'sahin', 'Şahin Çelik');
      await cdp.cdpType('[data-product-search]', 'burma');
      await cdp.until("document.querySelector('[data-product-result=\"stock-r1-stk-burma\"]')");
      await cdp.cdpClick('[data-product-result="stock-r1-stk-burma"]');
      await cdp.cdpType('#item-weight-0', '18,500');
      await cdp.cdpType('#item-value-0', '42000');
      await cdp.cdpClick('#add-sale-item');
      await cdp.until("document.querySelector('#sale-form').dataset.flowMode === 'guided'");
      await cdp.cdpComboboxSelect('#item-account-1', 'cey', 'ÇEYREK');
      await cdp.cdpType('#item-value-1', '5500');
      await cdp.cdpClick('[data-step-next="2"]');
      await cdp.until("document.querySelector('[data-step-panel=\"2\"].is-active')");
      await cdp.cdpClick('[data-add-allocation="payment"][data-payment-type="pos"]');
      await cdp.cdpType('#allocation-quantity-0', '40000');
      await cdp.cdpClick('[data-add-allocation="debt"]');
      await cdp.until("document.querySelector('#allocation-account-1')?.value === 'cari-cust-sahin'");
      await cdp.cdpKey('Escape');
      await cdp.cdpType('#allocation-quantity-1', '7500');
      await cdp.cdpClick('[data-step-next="3"]');
      await cdp.until("document.querySelector('[data-step-panel=\"3\"].is-active')");
      await cdp.cdpClick('#sale-form button[type="submit"]');
      await cdp.until("(document.querySelector('.defter-toast-body')?.textContent.includes('kaydedildi') || document.querySelector('#notice')?.textContent.includes('kaydedildi')) && document.body.getAttribute('aria-busy') === 'false'");
    }, ['Guided mode with DefterCombobox customer search (#f-counterpartyId) and auto-populated Step 2 cari allocation (#allocation-account-1).']);

    // 2. Workflow 2: Customer Purchase (/owner Simple & Complex)
    await goOverview();
    await measureScenario('w2_owner_purchase_simple', '2. Müşteriden alış başlatma', 'simple', '/owner', async () => {
      await cdp.cdpClick('button.quick-action[data-quick-action="purchase"]');
      await cdp.until("document.querySelector('#sale-form[data-operation=\"purchase\"]')");
      await cdp.cdpComboboxSelect('#item-account-0', 'hurda22', '22 AYAR HURDA');
      await cdp.cdpType('#item-quantity-0', '2,500');
      await cdp.cdpType('#item-value-0', '7500');
      await cdp.until("document.querySelector('[data-quick-fill-cash]') && !document.querySelector('[data-quick-fill-cash]').hidden");
      await cdp.cdpClick('[data-quick-fill-cash]');
      await cdp.cdpClick('#sale-form button[type="submit"]');
      await cdp.until("(document.querySelector('.defter-toast-body')?.textContent.includes('kaydedildi') || document.querySelector('#notice')?.textContent.includes('kaydedildi')) && document.body.getAttribute('aria-busy') === 'false'");
    }, ['Purchase mode uses DefterCombobox on #item-account-0 with full Turkish/code search and auto-focus to quantity.']);

    await goOverview();
    await measureScenario('w2_owner_purchase_complex', '2. Müşteriden alış başlatma', 'complex', '/owner', async () => {
      await cdp.cdpClick('button.quick-action[data-quick-action="purchase"]');
      await cdp.until("document.querySelector('#sale-form[data-operation=\"purchase\"]')");
      await cdp.cdpComboboxSelect('#f-counterpartyId', '0001', 'Ahmet Yılmaz');
      await cdp.cdpComboboxSelect('#item-account-0', 'yuzuk', 'YÜZÜK');
      await cdp.cdpSelect('#item-group-0', 'taki14');
      await cdp.cdpType('#item-weight-0', '4,200');
      await cdp.cdpType('#item-value-0', '10000');
      await cdp.cdpClick('#add-sale-item');
      await cdp.cdpComboboxSelect('#item-account-1', 'hurda22', '22 AYAR HURDA');
      await cdp.cdpType('#item-quantity-1', '1,000');
      await cdp.cdpType('#item-value-1', '3000');
      await cdp.cdpClick('[data-step-next="2"]');
      await cdp.cdpClick('[data-add-allocation="payment"][data-payment-type="bank"]');
      await cdp.cdpType('#allocation-quantity-0', '10000');
      await cdp.cdpClick('[data-add-allocation="debt"]');
      await cdp.until("document.querySelector('#allocation-account-1')?.value === 'cari-cust-ahmet-tl'");
      await cdp.cdpKey('Escape');
      await cdp.cdpType('#allocation-quantity-1', '3000');
      await cdp.cdpClick('[data-step-next="3"]');
      await cdp.cdpClick('#sale-form button[type="submit"]');
      await cdp.until("(document.querySelector('.defter-toast-body')?.textContent.includes('kaydedildi') || document.querySelector('#notice')?.textContent.includes('kaydedildi')) && document.body.getAttribute('aria-busy') === 'false'");
    }, ['Complex purchase uses searchable DefterCombobox on #f-counterpartyId (phone/taxId/Turkish) and [data-item-field="accountId"], plus auto-populated cari allocation.']);

    // 3. Workflow 3: Finding Customer During Sale (/owner Simple & Complex)
    await goOverview();
    await cdp.cdpClick('button.quick-action[data-quick-action="sale"]');
    await cdp.until("document.querySelector('#sale-form[data-operation=\"sale\"]')");
    await measureScenario('w3_owner_find_customer_simple', '3. Satış sırasında müşteri bulma', 'simple', '/owner', async () => {
      await cdp.cdpComboboxSelect('#f-counterpartyId', 'gl', 'Çağla Öztürk');
    }, ['Single-control DefterCombobox on #f-counterpartyId with Turkish diacritic folding ("gl" -> "Çağla Öztürk").']);

    await measureScenario('w3_owner_find_customer_complex', '3. Satış sırasında müşteri bulma', 'complex', '/owner', async () => {
      await cdp.cdpComboboxSelect('#f-counterpartyId', '0001', 'Ahmet Yılmaz');
    }, ['Disambiguating same-named cross-unit customers directly in DefterCombobox via phone/taxId/unit subtitle without blind selection.']);

    // 4. Workflow 4: Selecting Product / Stock (/owner Simple & Complex)
    await goOverview();
    await cdp.cdpClick('button.quick-action[data-quick-action="sale"]');
    await cdp.until("document.querySelector('#sale-form[data-operation=\"sale\"]')");
    await measureScenario('w4_owner_select_product_simple', '4. Ürün/stok seçimi', 'simple', '/owner', async () => {
      await cdp.cdpComboboxSelect('[data-item-field="accountId"]', 'cey', 'ÇEYREK');
      await cdp.until("document.querySelector('[data-item-field=\"accountId\"]').value === 'ceyrek' && document.activeElement?.getAttribute('data-item-field') === 'quantity'");
    }, ['DefterCombobox on [data-item-field="accountId"] supports Turkish-folded type-ahead and auto-focuses quantity on commit.']);

    await measureScenario('w4_owner_select_product_complex', '4. Ürün/stok seçimi', 'complex', '/owner', async () => {
      await cdp.cdpType('[data-product-search]', 'şahmeran');
      await cdp.until("document.querySelectorAll('[data-product-result]').length >= 2");
      await cdp.cdpClick('[data-product-result="stock-r1-stk-sahmeran-zincir"]');
      await cdp.until("document.querySelector('.sale-item [data-item-field=\"accountId\"]')?.value === 'stock-r1-stk-sahmeran-zincir'");
      await cdp.cdpType('.sale-item [data-item-field="weight"]', '6,100');
      await cdp.cdpClick('button[data-tab="purchase"]');
      await cdp.until("document.querySelector('#sale-form[data-operation=\"purchase\"]')");
      await cdp.cdpComboboxSelect('.sale-item [data-item-field="accountId"]', 'hurda22', '22 AYAR HURDA');
    }, ['Purchase tab retains full product search parity via DefterCombobox on [data-item-field="accountId"].']);

    // 5. Workflow 5: Selecting Supplier Firm & Account/Unit (/owner Simple & Complex)
    await goOverview();
    await measureScenario('w5_owner_supplier_simple', '5. Toptancı firması ve ilgili hesap seçimi', 'simple', '/owner', async () => {
      await cdp.cdpClick('#navigation button[data-view="suppliers"]');
      await cdp.until("document.querySelector('[data-open-firm]')");
      await cdp.cdpClick('[data-open-firm="supplier-r1-firm-1"]');
      await cdp.until("document.querySelector('[data-supplier-task=\"purchase\"]')");
      await cdp.cdpClick('[data-supplier-task="purchase"]');
      await cdp.until("document.querySelector('[data-group=\"items\"] select[data-field=\"accountId\"]')");
      await cdp.cdpComboboxSelect('[data-group="items"] select[data-field="accountId"]', 'cey', 'ÇEYREK');
      await cdp.cdpComboboxSelect('[data-group="charges"] select[data-field="accountId"]', 'HAS', 'HAS');
    }, ['Supplier purchase items & charges use searchable DefterCombobox across stocks and firm unit accounts.']);
    await cdp.evaluate("document.querySelector('[data-back-suppliers]')?.click()");
    await cdp.until("document.querySelector('[data-supplier-search]')");

    await goOverview();
    await measureScenario('w5_owner_supplier_complex', '5. Toptancı firması ve ilgili hesap seçimi', 'complex', '/owner', async () => {
      await cdp.cdpClick('#navigation button[data-view="suppliers"]');
      await cdp.until("document.querySelector('[data-supplier-search]')");
      await cdp.cdpType('[data-supplier-search]', 'ozkan');
      await cdp.until("document.querySelector('[data-open-firm=\"supplier-r1-firm-1\"]')");
      await cdp.cdpClick('[data-open-firm="supplier-r1-firm-1"]');
      await cdp.until("document.querySelector('[data-supplier-documents]')");
      await cdp.cdpClick('[data-supplier-documents]');
      await cdp.until("document.querySelector('[data-add-source]') && !document.querySelector('[data-source-status]')?.textContent.includes('yükleniyor')");
      await cdp.cdpClick('[data-add-source]');
      await cdp.until("Boolean(document.querySelector('select[data-source-field=\"choice\"]')) && Boolean(window.DefterCombobox?.getInstance?.(document.querySelector('select[data-source-field=\"choice\"]')))");
      await cdp.cdpComboboxSelect('select[data-source-field="choice"]', 'avans', 'Ödeme / avans');
    }, ['Supplier document/receipt allocation uses Turkish-folded DefterCombobox for source/purchase selection.']);

    // 6. Workflow 6: Searching Daily Journal / Receipts (/owner Simple & Complex)
    await goOverview();
    await measureScenario('w6_owner_journal_simple', '6. Günlük işlem/fiş arama', 'simple', '/owner', async () => {
      await cdp.cdpClick('#navigation button[data-view="journal"]');
      await cdp.until("document.querySelector('#journal-search') && document.querySelector('#journal-list')?.getAttribute('aria-busy') === 'false'");
      await cdp.cdpType('#journal-search', 'yarım');
      await cdp.until("document.querySelector('#journal-list')?.getAttribute('aria-busy') === 'false' && !document.querySelector('#journal-list .loading') && document.querySelector('#journal-list .journal-item')");
      await cdp.cdpClick('#journal-list .journal-item details.journal-detail summary');
    }, ['Debounced (180ms) #journal-search collapses per-keystroke /api/journal storms into 1 request.']);
    await cdp.evaluate("document.querySelector('#journal-clear')?.click()");
    await cdp.until("document.querySelector('#journal-list')?.getAttribute('aria-busy') === 'false'");

    await goOverview();
    await measureScenario('w6_owner_journal_complex', '6. Günlük işlem/fiş arama', 'complex', '/owner', async () => {
      await cdp.cdpClick('#navigation button[data-view="journal"]');
      await cdp.until("document.querySelector('#journal-scope') && document.querySelector('#journal-list')?.getAttribute('aria-busy') === 'false'");
      await cdp.cdpSelect('#journal-scope', 'all');
      await cdp.until("document.querySelector('#journal-list')?.getAttribute('aria-busy') === 'false'");
      await cdp.cdpClick('details.journal-advanced-filters summary');
      await cdp.cdpSelect('#journal-type', 'sale');
      await cdp.until("document.querySelector('#journal-list')?.getAttribute('aria-busy') === 'false'");
      await cdp.cdpComboboxSelect('#journal-account', 'sahin', 'Şahin Çelik');
      await cdp.until("document.querySelector('#journal-list')?.getAttribute('aria-busy') === 'false'");
      await cdp.cdpType('#journal-search', 'Şahin');
      await cdp.until("document.querySelector('#journal-list')?.getAttribute('aria-busy') === 'false' && !document.querySelector('#journal-list .loading') && document.querySelector('[data-journal-inspect]')");
      await cdp.cdpClick('[data-journal-inspect]');
      await cdp.until("!document.querySelector('#journal-detail-pane').hidden");
    }, ['#journal-account uses DefterCombobox (<=2 native <option>s) and #journal-search is debounced.']);

    // 7. Workflow 7: Accessing Customer / Stock Cards + F5 Check (/owner Simple & Complex)
    await goOverview();
    await measureScenario('w7_owner_cards_simple', '7. Müşteri/stok kartlarına erişim', 'simple', '/owner', async () => {
      await cdp.cdpPaletteSelect('gl', 'Çağla Öztürk');
      await cdp.until("!document.querySelector('#account-detail')?.hidden && document.querySelector('#statement-status')?.textContent.includes('Ekstre hazır')");
    }, ['Ctrl+K Command Palette direct jump from overview -> customer detail card in 4 actions (vs 8 baseline).']);

    await goOverview();
    await measureScenario('w7_owner_cards_complex', '7. Müşteri/stok kartlarına erişim', 'complex', '/owner', async () => {
      await cdp.cdpClick('#navigation button[data-view="stocks"]');
      await cdp.until("document.querySelector('#stock-search')");
      await cdp.cdpType('#stock-search', 'burma');
      await cdp.until("document.querySelector('[data-account-detail=\"stock-r1-stk-burma\"]')");
      await cdp.cdpClick('[data-account-detail="stock-r1-stk-burma"]');
      await cdp.until("document.querySelector('#statement-status')?.textContent.includes('Ekstre hazır')");
      await cdp.cdpClick('[data-detail-tab="statement"]');
      const hashBeforeF5 = await cdp.evaluate('location.hash');
      return { hashBeforeF5 };
    }, ['formatViewHash() persists &id=stock-r1-stk-burma so F5 restores the open stock detail card cleanly.']);
    await cdp.evaluate('window.__p6bBeforeF5 = true');
    await cdp.call('Page.reload');
    await cdp.until("!window.__p6bBeforeF5 && location.pathname === '/owner' && document.body.getAttribute('aria-busy') === 'false' && document.querySelector('#stock-search') && document.querySelector('#account-detail:not([hidden]) #statement-title')?.textContent.includes('22 AYAR BURMA BİLEZİK')");
    await cdp.evaluate('window.__p6bBench.doubleRAF()');
    const detailVisibleAfterF5 = await cdp.evaluate("!document.querySelector('#account-detail')?.hidden && document.querySelector('#statement-title')?.textContent.includes('22 AYAR BURMA BİLEZİK')");
    scenarios[scenarios.length - 1].observed.f5RestoredDetailCard = detailVisibleAfterF5;

    // 8. Workflow 8: Switching to Stocktake / Closing / Summary (/owner Simple & Complex)
    await goOverview();
    await measureScenario('w8_owner_closing_summary_simple', '8. Sayım, kapanış ve rapor ekranlarına geçiş', 'simple', '/owner', async () => {
      await cdp.cdpClick('#navigation button[data-view="closing"]');
      await cdp.until("document.querySelector('#close-form')");
      await cdp.cdpPaletteSelect('özet', 'Günlük İşletme Özeti');
      await cdp.until("document.querySelector('#summary-status')?.textContent.includes('özeti hazır')");
    }, ['Ctrl+K Command Palette jump between closing and summary without sidebar traversal.']);

    await goOverview();
    await measureScenario('w8_owner_closing_summary_complex', '8. Sayım, kapanış ve rapor ekranlarına geçiş', 'complex', '/owner', async () => {
      await cdp.cdpClick('#navigation button[data-view="closing"]');
      await cdp.until("document.querySelector('[data-count-mode=\"periodic\"]')");
      await cdp.cdpClick('[data-count-mode="periodic"]');
      await cdp.until("!document.querySelector('#stocktake-form').closest('section').hidden");
      await cdp.cdpClick('#navigation button[data-view="summary"]');
      await cdp.until("document.querySelector('#summary-status')?.textContent.includes('özeti hazır')");
      await cdp.cdpSelect('#summary-kind', 'customer');
      await cdp.cdpSelect('#summary-unit', 'TL');
      await cdp.cdpType('#summary-search', 'sahin');
      await cdp.until("document.querySelectorAll('#summary-result tbody tr').length > 0");
    }, ['renderSummary() uses shared Turkish diacritic folding (ASCII "sahin" matches "Şahin Çelik").']);

    // Responsive check at 1100x900 and 390x844 on /owner
    const ownerResponsive = [];
    for (const width of [1100, 390]) {
      const height = width === 390 ? 844 : 900;
      await cdp.setViewport(width, height);
      await goOverview();
      let extraNavClicks = 0;
      let paletteFit = true;
      if (width === 390) {
        await cdp.evaluate("Promise.all((document.querySelector('.sidebar')?.getAnimations() || []).map(a => a.finished.catch(() => {})))");
        await delay(220);
        await cdp.evaluate('window.__p6bBench.doubleRAF()');
        await cdp.cdpKey('k', { ctrl: true });
        await cdp.until("Boolean(document.querySelector('dialog[data-command-palette][open]'))");
        const pRect = await cdp.evaluate("(() => { const d = document.querySelector('dialog[data-command-palette]'); const r = d.getBoundingClientRect(); return { left: r.left, right: r.right, iw: window.innerWidth }; })()");
        paletteFit = pRect.left >= 0 && pRect.right <= pRect.iw;
        await cdp.cdpKey('Escape');
        await cdp.until("!document.querySelector('dialog[data-command-palette][open]')");
        await cdp.cdpClick('#navigation-toggle');
        await cdp.until("document.querySelector('#navigation-toggle')?.getAttribute('aria-expanded') === 'true'");
        await cdp.evaluate('window.__p6bBench.doubleRAF()');
        extraNavClicks = 1;
      }
      await cdp.cdpClick('#navigation button[data-view="transaction"]');
      await cdp.until("document.querySelector('#sale-form')");
      const overflowSale = await cdp.evaluate('({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth })');
      ownerResponsive.push({
        surface: '/owner',
        width,
        height,
        extraNavToggleClicks: extraNavClicks,
        paletteFit,
        saleScrollWidth: overflowSale.scrollWidth,
        innerWidth: overflowSale.innerWidth,
        noHorizontalOverflow: overflowSale.scrollWidth <= overflowSale.innerWidth
      });
    }

    // Employee /checkout workflows (1, 2, 3, 4)
    await cdp.setViewport(1440, 900);
    await cdp.cdpClick('#logout');
    await cdp.until("document.querySelector('#user')?.options.length >= 2");
    await loginAs(cdp, env.origin, 'Sentetik Çalışan', env.password, '/checkout');

    const resetCheckout = async () => {
      await cdp.evaluate(`(() => {
        document.querySelector('#clear-draft')?.click();
        const s = document.querySelector('#search');
        if (s) { s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); }
        const c = document.querySelector('#customer');
        if (c && c.value) { c.value = ''; c.dispatchEvent(new Event('change', { bubbles: true })); }
      })()`);
      await cdp.until("document.querySelector('#trade') && !document.querySelector('#trade').hidden");
      await cdp.evaluate('window.__p6bBench.doubleRAF()');
    };

    // Checkout Workflow 1: Sale (Simple & Complex)
    await resetCheckout();
    await measureScenario('w1_checkout_sale_simple', '1. Yeni satış başlatma', 'simple', '/checkout', async () => {
      await cdp.cdpComboboxSelect('[data-product]', 'cey', 'ÇEYREK');
      await cdp.cdpType('[data-item] [data-quantity]', '1', { clear: true });
      await cdp.cdpType('[data-item] [data-value]', '5500', { clear: true });
      await cdp.cdpClick('[data-add="received"][data-category="money"]');
      await cdp.cdpComboboxSelect('[data-allocation="received"] [data-account]', 'nakit', 'Nakit TL');
      await cdp.cdpType('[data-allocation="received"] [data-quantity]', '5500', { clear: true });
      await cdp.cdpClick('#record');
      await cdp.until("document.querySelector('#review')?.hidden === false");
      await cdp.cdpClick('#confirm');
      await cdp.until("document.querySelector('#status')?.textContent.includes('İşlem kaydedildi')");
    }, ['2-stage #record -> #confirm confirmation safety preserved; product & money allocations use DefterCombobox.']);

    await resetCheckout();
    await measureScenario('w1_checkout_sale_complex', '1. Yeni satış başlatma', 'complex', '/checkout', async () => {
      await cdp.cdpComboboxSelect('#customer', 'sahin', 'Şahin Çelik');
      await cdp.until("document.querySelector('#customer-balance')?.textContent.includes('Şahin')");
      await cdp.cdpComboboxSelect('[data-product]', 'burma', '22 AYAR BURMA BİLEZİK');
      await cdp.cdpType('[data-item] [data-quantity]', '1', { clear: true });
      await cdp.cdpSelect('[data-item] [data-pool]', 'bilezik22');
      await cdp.cdpType('[data-item] [data-weight]', '18,000', { clear: true });
      await cdp.cdpType('[data-item] [data-value]', '42000', { clear: true });
      await cdp.cdpClick('[data-add="received"][data-category="money"]');
      await cdp.cdpComboboxSelect('[data-allocation="received"] [data-account]', 'nakit', 'Nakit TL');
      await cdp.cdpType('[data-allocation="received"] [data-quantity]', '30000', { clear: true });
      await cdp.cdpClick('[data-escalate-guided]');
      await cdp.until("document.querySelector('#trade')?.dataset.flowMode === 'guided'");
      await cdp.cdpClick('[data-add="credits"]');
      await cdp.until("document.querySelector('#credits [data-account]')?.value === 'cari-cust-sahin'");
      await cdp.cdpType('#credits [data-quantity]', '12000', { clear: true });
      await cdp.cdpClick('[data-step-next="3"]');
      await cdp.cdpClick('#record');
      await cdp.until("document.querySelector('#review')?.hidden === false");
      await cdp.cdpClick('#confirm');
      await cdp.until("document.querySelector('#status')?.textContent.includes('İşlem kaydedildi')");
    }, ['Unified single-control async DefterCombobox on #search (#customer) with 180ms debounce and auto-populated credit account.']);

    // Checkout Workflow 2: Purchase (Simple & Complex)
    await resetCheckout();
    await measureScenario('w2_checkout_purchase_simple', '2. Müşteriden alış başlatma', 'simple', '/checkout', async () => {
      await cdp.cdpSelect('#operation', 'purchase');
      await cdp.cdpComboboxSelect('[data-product]', 'hurda', '22 AYAR HURDA');
      await cdp.cdpType('[data-item] [data-quantity]', '2,000', { clear: true });
      await cdp.cdpType('[data-item] [data-value]', '6000', { clear: true });
      await cdp.cdpClick('[data-add="given"][data-category="money"]');
      await cdp.cdpComboboxSelect('[data-allocation="given"] [data-account]', 'nakit', 'Nakit TL');
      await cdp.cdpType('[data-allocation="given"] [data-quantity]', '6000', { clear: true });
      await cdp.cdpClick('#record');
      await cdp.until("document.querySelector('#review')?.hidden === false");
      await cdp.cdpClick('#confirm');
      await cdp.until("document.querySelector('#status')?.textContent.includes('İşlem kaydedildi')");
    }, ['Checkout purchase mode uses DefterCombobox for product & money selection + 2-stage #record -> #confirm.']);

    await resetCheckout();
    await measureScenario('w2_checkout_purchase_complex', '2. Müşteriden alış başlatma', 'complex', '/checkout', async () => {
      await cdp.cdpSelect('#operation', 'purchase');
      await cdp.cdpComboboxSelect('#customer', '0001', 'Ahmet Yılmaz');
      await cdp.until("document.querySelector('#customer-balance')?.textContent.includes('Ahmet')");
      await cdp.cdpComboboxSelect('[data-product]', 'hurda', '22 AYAR HURDA');
      await cdp.cdpType('[data-item] [data-quantity]', '3,000', { clear: true });
      await cdp.cdpType('[data-item] [data-value]', '9000', { clear: true });
      await cdp.cdpClick('[data-add="given"][data-category="money"]');
      await cdp.cdpComboboxSelect('[data-allocation="given"] [data-account]', 'nakit', 'Nakit TL');
      await cdp.cdpType('[data-allocation="given"] [data-quantity]', '6000', { clear: true });
      await cdp.cdpClick('[data-escalate-guided]');
      await cdp.until("document.querySelector('#trade')?.dataset.flowMode === 'guided'");
      await cdp.cdpClick('[data-add="debts"]');
      await cdp.until("document.querySelector('#debts [data-account]')?.value === 'cari-cust-ahmet-tl'");
      await cdp.cdpType('#debts [data-quantity]', '3000', { clear: true });
      await cdp.cdpClick('[data-step-next="3"]');
      await cdp.cdpClick('#record');
      await cdp.until("document.querySelector('#review')?.hidden === false");
      await cdp.cdpClick('#confirm');
      await cdp.until("document.querySelector('#status')?.textContent.includes('İşlem kaydedildi')");
    }, ['Unified async DefterCombobox disambiguates same-named cross-unit customer by phone/unit in 1 control.']);

    // Checkout Workflow 3: Finding Customer During Sale (Simple & Complex)
    await resetCheckout();
    await cdp.cdpSelect('#operation', 'sale');
    await measureScenario('w3_checkout_find_customer_simple', '3. Satış sırasında müşteri bulma', 'simple', '/checkout', async () => {
      await cdp.cdpComboboxSelect('#customer', 'gl', 'Çağla Öztürk');
      await cdp.until("document.querySelector('#customer-balance')?.textContent.includes('Çağla')");
    }, ['Single-control async DefterCombobox on #search (#customer) replaces 2-control split (#search + #customer).']);

    await resetCheckout();
    await measureScenario('w3_checkout_find_customer_complex', '3. Satış sırasında müşteri bulma', 'complex', '/checkout', async () => {
      await cdp.cdpComboboxSelect('#customer', '0002', 'HAS');
      await cdp.until("document.querySelector('#customer-balance')?.textContent.toLowerCase().includes('has')");
    }, ['Backend customerChoices() supports Turkish folding + phone/taxId search + disambiguationLabel in Combobox.']);

    // Checkout Workflow 4: Selecting Product / Stock (Simple & Complex)
    await resetCheckout();
    await measureScenario('w4_checkout_select_product_simple', '4. Ürün/stok seçimi', 'simple', '/checkout', async () => {
      await cdp.cdpComboboxSelect('[data-product]', 'cey', 'ÇEYREK');
      await cdp.until("document.activeElement?.hasAttribute('data-quantity')");
    }, ['DefterCombobox clears/searches product and auto-focuses [data-quantity] on Enter commit.']);

    await resetCheckout();
    await measureScenario('w4_checkout_select_product_complex', '4. Ürün/stok seçimi', 'complex', '/checkout', async () => {
      await cdp.cdpComboboxSelect('[data-product]', 'sahmeran', '14 AYAR ŞAHMERAN ZİNCİR');
      await cdp.cdpSelect('[data-pool]', 'taki14');
      await cdp.cdpType('[data-weight]', '5,750');
    }, ['Unified single-control DefterCombobox handles Turkish-folded ambiguous product selection without leaving input.']);

    // Checkout responsive sanity (1100x900 & 390x844)
    const checkoutResponsive = [];
    for (const width of [1100, 390]) {
      const height = width === 390 ? 844 : 900;
      await cdp.setViewport(width, height);
      await cdp.evaluate('window.__p6bBench.doubleRAF()');
      const box = await cdp.evaluate('({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth })');
      checkoutResponsive.push({
        surface: '/checkout',
        width,
        height,
        scrollWidth: box.scrollWidth,
        innerWidth: box.innerWidth,
        noHorizontalOverflow: box.scrollWidth <= box.innerWidth
      });
    }

    return {
      suite: 'r1',
      viewport: '1440x900',
      selectActionModel: 'click_plus_choose_2_actions',
      scenarios,
      responsiveChecks: [...ownerResponsive, ...checkoutResponsive]
    };
  } finally {
    if (cdp) {
      try { await cdp.close(); } catch {}
    }
    try { await new Promise(done => { env.server.close(done); env.server.closeAllConnections(); }); } catch {}
    await removeDirWithRetry(env.dir, env.profileDir);
  }
}

async function runR4Scale(customerCount, targetEvents) {
  const label = customerCount >= 10000 ? '10k' : '5k';
  const tGen0 = performance.now();
  const { events, validatedState } = buildR4Events(customerCount, targetEvents);
  const genAndReplayMs = Number((performance.now() - tGen0).toFixed(2));

  const custCount = validatedState.accounts.filter(a => a.kind === 'receivable' && (a.partyType || 'customer') === 'customer').length;
  const stockCount = validatedState.accounts.filter(a => a.kind === 'asset' && (a.isSaleable || a.isPurchasable || a.pairedGroups?.length || ['bilezik22', 'taki14', 'taki22'].includes(a.id))).length;
  const supplierFirmCount = validatedState.supplierFirms.length;
  const supplierAccCount = validatedState.accounts.filter(a => a.kind === 'receivable' && a.partyType === 'supplier').length;

  assert.equal(custCount, customerCount);
  assert.ok(stockCount >= 2000, `Expected >= 2000 stocks, got ${stockCount}`);
  assert.equal(supplierFirmCount, 100);
  assert.equal(supplierAccCount, 220);

  const env = await setupServerAndCredentials(events, `r4-${label}`);
  let cdp;
  try {
    cdp = await launchCdpBrowser(env.profileDir);
    await cdp.setViewport(1440, 900);

    const tLogin0 = performance.now();
    await loginAs(cdp, env.origin, 'Sentetik İşletme Sahibi', env.password, '/owner');
    const ownerInitialLoadMs = Number((performance.now() - tLogin0).toFixed(2));

    const viewMetrics = {};

    async function measureView(viewName, navFn, readyExpr) {
      const msSamples = [];
      const scriptSamples = [];
      const layoutSamples = [];
      const styleSamples = [];
      for (let i = 0; i < 6; i++) {
        if (viewName !== 'overview') {
          await cdp.evaluate("location.hash = '#v=overview'");
          await cdp.until("document.querySelector('.overview-screen')");
          await cdp.evaluate('window.__p6bBench.doubleRAF()');
        } else if (i > 0) {
          await cdp.evaluate("location.hash = '#v=closing'");
          await cdp.until("document.querySelector('#close-form')");
          await cdp.evaluate('window.__p6bBench.doubleRAF()');
        }
        const beforePerf = await cdp.perfMetrics();
        const t0 = performance.now();
        await navFn();
        await cdp.until(readyExpr);
        await cdp.evaluate('window.__p6bBench.doubleRAF()');
        const totalMs = performance.now() - t0;
        const afterPerf = await cdp.perfMetrics();
        if (i >= 1) {
          msSamples.push(totalMs);
          scriptSamples.push((afterPerf.ScriptDuration - beforePerf.ScriptDuration) * 1000);
          layoutSamples.push((afterPerf.LayoutDuration - beforePerf.LayoutDuration) * 1000);
          styleSamples.push((afterPerf.RecalcStyleDuration - beforePerf.RecalcStyleDuration) * 1000);
        }
      }
      const dom = await cdp.domProbe();
      const heap = await cdp.heapProbe();
      viewMetrics[viewName] = {
        settle: stats(msSamples),
        scriptDuration: stats(scriptSamples),
        layoutDuration: stats(layoutSamples),
        recalcStyleDuration: stats(styleSamples),
        dom,
        heap
      };
    }

    await measureView('overview', () => cdp.cdpClick('#navigation button[data-view="overview"]'), "document.querySelector('.overview-screen')");
    await measureView('transaction_sale', () => cdp.cdpClick('#navigation button[data-view="transaction"]'), "document.querySelector('#sale-form[data-operation=\"sale\"]') && document.querySelector('#f-counterpartyId') && Boolean(document.querySelector('#sale-form .defter-combobox-input'))");
    await measureView('transaction_collection', async () => {
      await cdp.cdpClick('#navigation button[data-view="transaction"]');
      await cdp.until("document.querySelector('[data-tab=\"collection\"]')");
      await cdp.cdpClick('[data-tab="collection"]');
    }, "document.querySelector('#collection-form') && document.querySelector('#f-customerAccount')");
    await measureView('journal', () => cdp.cdpClick('#navigation button[data-view="journal"]'), "document.querySelector('#journal-list')?.getAttribute('aria-busy') === 'false'");
    await measureView('accounts', () => cdp.cdpClick('#navigation button[data-view="accounts"]'), "document.querySelector('#account-search')");
    await measureView('stocks', () => cdp.cdpClick('#navigation button[data-view="stocks"]'), "document.querySelector('#stock-search')");
    await measureView('suppliers', () => cdp.cdpClick('#navigation button[data-view="suppliers"]'), "document.querySelector('[data-supplier-search]') && document.querySelector('[data-supplier-list]')");

    // Probe suppliers purchase form DOM bounds (2k stock catalog Combobox)
    await cdp.cdpClick('[data-open-firm="supplier-r4-firm-0"]');
    await cdp.until("document.querySelector('[data-supplier-task=\"purchase\"]')");
    await cdp.cdpClick('[data-supplier-task="purchase"]');
    await cdp.until("document.querySelector('form[data-supplier-form=\"purchase\"] [data-group=\"items\"] select[data-field=\"accountId\"]')");
    await cdp.evaluate('window.__p6bBench.doubleRAF()');
    const suppliersPurchaseFormDom = await cdp.domProbe();
    await cdp.evaluate("document.querySelector('[data-back-suppliers]')?.click()");
    await cdp.until("document.querySelector('[data-supplier-search]')");

    // Probe journal lazy bindSaleReturn unmounted initially + expand latency
    await cdp.cdpClick('#navigation button[data-view="journal"]');
    await cdp.until("document.querySelector('#journal-list')?.getAttribute('aria-busy') === 'false' && document.querySelector('details[data-sale-return] summary')");
    await cdp.evaluate('window.__p6bBench.doubleRAF()');
    const lazyBefore = await cdp.evaluate(`({
      returnDetailsCount: document.querySelectorAll('details[data-sale-return]').length,
      mountedFormsBefore: document.querySelectorAll('details[data-sale-return] form.sale-return-form').length
    })`);
    const lazyExpandMs = await cdp.evaluate(`(async () => {
      const summary = document.querySelector('details[data-sale-return] summary');
      const t0 = performance.now();
      summary.click();
      const deadline = performance.now() + 5000;
      while (!document.querySelector('details[data-sale-return][open] form.sale-return-form')) {
        if (performance.now() > deadline) throw new Error('Timeout waiting for lazy sale-return-form');
        await new Promise(r => setTimeout(r, 2));
      }
      await window.__p6bBench.doubleRAF();
      return Number((performance.now() - t0).toFixed(2));
    })()`);
    const lazyAfter = await cdp.evaluate(`({
      mountedFormsAfter: document.querySelectorAll('details[data-sale-return] form.sale-return-form').length,
      refundProductOptions: document.querySelector('details[data-sale-return] select[name="refundProduct"]')?.options.length ?? null
    })`);
    await cdp.evaluate("document.querySelector('details[data-sale-return][open]')?.removeAttribute('open')");
    const journalLazyReturn = {
      unmountedInitially: lazyBefore.returnDetailsCount > 0 && lazyBefore.mountedFormsBefore === 0,
      expandSettleMs: lazyExpandMs,
      mountedAfterExpand: lazyAfter.mountedFormsAfter >= 1,
      refundProductOptions: lazyAfter.refundProductOptions
    };

    // Local searches (cold first run vs 5 warm repeats)
    const localSearch = {};

    // 1. /owner #accounts #account-search (cold WeakMap build on fresh page reload + 5 warm repeats + Turkish/phone/taxId)
    await cdp.call('Page.navigate', { url: `${env.origin}/owner#v=accounts` });
    await cdp.until("document.querySelector('#account-search') && document.body.getAttribute('aria-busy') === 'false'");
    await cdp.evaluate('window.__p6bBench.doubleRAF()');
    const measureInputQuery = async (selector, query, readyExpr = null, timeoutMs = 15000) => {
      return await cdp.evaluate(`(async () => {
        const el = document.querySelector(${JSON.stringify(selector)});
        const t0 = performance.now();
        el.value = ${JSON.stringify(query)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        const syncMs = performance.now() - t0;
        ${readyExpr ? `
        const deadline = performance.now() + ${Number(timeoutMs) || 15000};
        while (!(${readyExpr})) {
          if (performance.now() > deadline) throw new Error('Timeout waiting for readyExpr in measureInputQuery: ' + ${JSON.stringify(readyExpr)});
          await new Promise(r => setTimeout(r, 2));
        }` : ''}
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        return { syncMs: Number(syncMs.toFixed(2)), settleMs: Number((performance.now() - t0).toFixed(2)) };
      })()`);
    };

    const accCold = await measureInputQuery('#account-search', 'yıl');
    const accRepeatSamples = [];
    for (let i = 0; i < 6; i++) {
      await measureInputQuery('#account-search', '');
      const res = await measureInputQuery('#account-search', i % 2 === 0 ? 'çşğ' : '0533100');
      if (i >= 1) accRepeatSamples.push(res.settleMs);
    }
    const accPhoneMatchCount = await cdp.evaluate(`(() => {
      const el = document.querySelector('#account-search');
      el.value = '05331000001';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return document.querySelectorAll('#account-list .account-card').length;
    })()`);
    const accTaxIdMatchCount = await cdp.evaluate(`(() => {
      const el = document.querySelector('#account-search');
      el.value = '20000000001';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return document.querySelectorAll('#account-list .account-card').length;
    })()`);
    localSearch.ownerAccountSearch = {
      coldInitialMs: accCold.settleMs,
      coldSyncMs: accCold.syncMs,
      repeatSettle: stats(accRepeatSamples),
      phoneHits: accPhoneMatchCount,
      taxIdHits: accTaxIdMatchCount
    };

    // 2. /owner #transaction/sale [data-product-search]
    await cdp.cdpClick('#navigation button[data-view="transaction"]');
    await cdp.until("document.querySelector('[data-tab=\"sale\"]')");
    await cdp.cdpClick('[data-tab="sale"]');
    await cdp.until("document.querySelector('[data-product-search]')");
    await cdp.evaluate('window.__p6bBench.doubleRAF()');
    const prodCold = await measureInputQuery('[data-product-search]', 'şahmeran');
    const prodRepeatSamples = [];
    for (let i = 0; i < 6; i++) {
      await measureInputQuery('[data-product-search]', '');
      const res = await measureInputQuery('[data-product-search]', 'bilezik');
      if (i >= 1) prodRepeatSamples.push(res.settleMs);
    }
    localSearch.ownerProductSearch = {
      coldInitialMs: prodCold.settleMs,
      coldSyncMs: prodCold.syncMs,
      repeatSettle: stats(prodRepeatSamples)
    };

    // 3. /owner #suppliers [data-supplier-search]
    await cdp.cdpClick('#navigation button[data-view="suppliers"]');
    await cdp.until("document.querySelector('[data-supplier-search]')");
    await cdp.evaluate('window.__p6bBench.doubleRAF()');
    const supCold = await measureInputQuery('[data-supplier-search]', 'özkan');
    const supRepeatSamples = [];
    for (let i = 0; i < 6; i++) {
      await measureInputQuery('[data-supplier-search]', '');
      const res = await measureInputQuery('[data-supplier-search]', 'çelik');
      if (i >= 1) supRepeatSamples.push(res.settleMs);
    }
    localSearch.ownerSupplierSearch = {
      coldInitialMs: supCold.settleMs,
      coldSyncMs: supCold.syncMs,
      repeatSettle: stats(supRepeatSamples)
    };

    // Async search: /owner #journal #journal-search (cold backend searchCache vs warm repeat + 4-keystroke burst)
    await cdp.cdpClick('#navigation button[data-view="journal"]');
    await cdp.until("document.querySelector('#journal-list')?.getAttribute('aria-busy') === 'false'");
    await cdp.cdpSelect('#journal-scope', 'all');
    await cdp.until("document.querySelector('#journal-list')?.getAttribute('aria-busy') === 'false'");
    await cdp.evaluate('window.__p6bBench.doubleRAF()');

    const measureJournalQuery = async q => {
      const startMark = await cdp.evaluate(`(() => {
        performance.clearResourceTimings();
        const el = document.querySelector('#journal-search');
        const t0 = performance.now();
        el.value = ${JSON.stringify(q)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return t0;
      })()`);
      await cdp.until("performance.getEntriesByType('resource').some(e => e.name.includes('/api/journal')) && document.querySelector('#journal-list')?.getAttribute('aria-busy') === 'false' && !document.querySelector('#journal-list .loading')");
      const net = await cdp.evaluate(`(async () => {
        await window.__p6bBench.doubleRAF();
        const end = performance.now();
        const entries = performance.getEntriesByType('resource').filter(e => e.name.includes('/api/journal'));
        const last = entries.length ? entries[entries.length - 1] : null;
        const settleMs = Number((end - ${startMark}).toFixed(2));
        const postDebounceSettleMs = last
          ? Number(Math.max(0, end - Math.max(${startMark}, last.fetchStart)).toFixed(2))
          : settleMs;
        return {
          settleMs,
          postDebounceSettleMs,
          count: entries.length,
          durationMs: last ? Number(last.duration.toFixed(2)) : 0
        };
      })()`);
      return net;
    };

    const journalCold = await measureJournalQuery('Ayşe Kaya');
    const journalRepeatSamples = [];
    const journalPostDebounceSamples = [];
    for (let i = 0; i < 6; i++) {
      const res = await measureJournalQuery(i % 2 === 0 ? 'Mehmet Yılmaz' : 'Ayşe Kaya');
      if (i >= 1) {
        journalRepeatSamples.push(res.settleMs);
        journalPostDebounceSamples.push(res.postDebounceSettleMs);
      }
    }
    await cdp.evaluate("performance.clearResourceTimings(); document.querySelector('#journal-search').value = ''; document.querySelector('#journal-search').dispatchEvent(new Event('input', { bubbles: true }));");
    await cdp.until("performance.getEntriesByType('resource').some(e => e.name.includes('/api/journal')) && document.querySelector('#journal-list')?.getAttribute('aria-busy') === 'false'", 5000).catch(() => {});
    await delay(350);
    await cdp.evaluate('performance.clearResourceTimings()');
    await cdp.cdpType('#journal-search', 'Ayşe');
    await cdp.until("performance.getEntriesByType('resource').some(e => e.name.includes('/api/journal')) && document.querySelector('#journal-list')?.getAttribute('aria-busy') === 'false'", 5000);
    await delay(300);
    const journalBurstReqs = await cdp.evaluate("performance.getEntriesByType('resource').filter(e => e.name.includes('/api/journal')).length");

    // Employee /checkout metrics on R4
    await cdp.cdpClick('#logout');
    await cdp.until("document.querySelector('#user')?.options.length >= 2");
    const tCo0 = performance.now();
    await loginAs(cdp, env.origin, 'Sentetik Çalışan', env.password, '/checkout');
    const checkoutLoadMs = Number((performance.now() - tCo0).toFixed(2));
    const checkoutDom = await cdp.domProbe();
    const checkoutHeap = await cdp.heapProbe();

    // Checkout local product search
    const coProdCold = await measureInputQuery('[data-product-search]', 'şahmeran');
    const coProdRepeat = [];
    for (let i = 0; i < 6; i++) {
      await measureInputQuery('[data-product-search]', '');
      const res = await measureInputQuery('[data-product-search]', 'bilezik');
      if (i >= 1) coProdRepeat.push(res.settleMs);
    }
    // Close product Combobox before measuring #search customer Combobox
    await cdp.evaluate("document.querySelector('[data-product-search]')?.focus()");
    await cdp.cdpKey('Escape');
    await cdp.evaluate('window.__p6bBench.doubleRAF()');

    // Checkout async customer search (strictly scoped to #search's aria-controls listbox)
    const measureCheckoutCust = async q => {
      const startMark = await cdp.evaluate(`(() => {
        performance.clearResourceTimings();
        const el = document.querySelector('#search');
        el.focus();
        const t0 = performance.now();
        el.value = ${JSON.stringify(q)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return t0;
      })()`);
      await cdp.until(`(() => {
        if (!performance.getEntriesByType('resource').some(e => e.name.includes('/api/customers'))) return false;
        const s = document.querySelector('#search');
        const cid = s?.getAttribute('aria-controls');
        const lb = cid ? document.getElementById(cid) : null;
        return Boolean(lb && !lb.hidden && !lb.closest('[hidden]') && lb.querySelectorAll('[role="option"]').length > 0);
      })()`);
      const net = await cdp.evaluate(`(async () => {
        await window.__p6bBench.doubleRAF();
        const end = performance.now();
        const entries = performance.getEntriesByType('resource').filter(e => e.name.includes('/api/customers'));
        const last = entries.length ? entries[entries.length - 1] : null;
        const cid = document.querySelector('#search')?.getAttribute('aria-controls');
        const lb = cid ? document.getElementById(cid) : null;
        const settleMs = Number((end - ${startMark}).toFixed(2));
        const postDebounceSettleMs = last
          ? Number(Math.max(0, end - Math.max(${startMark}, last.fetchStart)).toFixed(2))
          : settleMs;
        return {
          settleMs,
          postDebounceSettleMs,
          count: entries.length,
          durationMs: last ? Number(last.duration.toFixed(2)) : 0,
          options: document.querySelector('#customer')?.options.length || 0,
          comboboxOptions: lb ? lb.querySelectorAll('[role="option"]').length : 0
        };
      })()`);
      return net;
    };

    const coCustCold = await measureCheckoutCust('Mehmet');
    const coCustRepeat = [];
    const coCustPostDebounceRepeat = [];
    for (let i = 0; i < 6; i++) {
      const res = await measureCheckoutCust(i % 2 === 0 ? 'Ayşe' : 'Mehmet');
      if (i >= 1) {
        coCustRepeat.push(res.settleMs);
        coCustPostDebounceRepeat.push(res.postDebounceSettleMs);
      }
    }
    await cdp.evaluate("document.querySelector('#search').value = ''; document.querySelector('#search').dispatchEvent(new Event('input', { bubbles: true }));");
    await delay(350);
    await cdp.evaluate('performance.clearResourceTimings()');
    await cdp.cdpType('#search', 'Mehme');
    await cdp.until(`(() => {
      if (!performance.getEntriesByType('resource').some(e => e.name.includes('/api/customers'))) return false;
      const cid = document.querySelector('#search')?.getAttribute('aria-controls');
      const lb = cid ? document.getElementById(cid) : null;
      return Boolean(lb && !lb.hidden && lb.querySelectorAll('[role="option"]').length > 0);
    })()`, 5000);
    await delay(300);
    const coCustBurstReqs = await cdp.evaluate("performance.getEntriesByType('resource').filter(e => e.name.includes('/api/customers')).length");

    // Paket 6B Components R4 Benchmarks (Command Palette & Combobox on 5k / 10k)
    await cdp.cdpClick('#logout');
    await cdp.until("document.querySelector('#user')?.options.length >= 2");
    await loginAs(cdp, env.origin, 'Sentetik İşletme Sahibi', env.password, '/owner');

    const tailIdx = customerCount - 301;
    const tailG = TURKISH_GIVEN[tailIdx % TURKISH_GIVEN.length];
    const tailS = TURKISH_SURNAMES[Math.floor(tailIdx / TURKISH_GIVEN.length) % TURKISH_SURNAMES.length];
    const tailNeedleName = `${tailG} ${tailS} ${tailIdx + 1}`;
    const tailNeedleNorm = foldTr(tailNeedleName);

    // 1. Command Palette openMs (1 cold + 5 warm) & tail search
    const cpOpenSamples = [];
    let cpColdOpenMs = null;
    for (let i = 0; i < 6; i++) {
      await cdp.evaluate(`(() => {
        window.__p6bCpMark = 0;
        const onKey = ev => {
          if (ev.ctrlKey && String(ev.key).toLowerCase() === 'k') {
            window.__p6bCpMark = performance.now();
            window.removeEventListener('keydown', onKey, true);
          }
        };
        window.addEventListener('keydown', onKey, true);
      })()`);
      await cdp.cdpKey('k', { ctrl: true });
      await cdp.until("Boolean(document.querySelector('dialog[data-command-palette][open]')) && Boolean(document.activeElement?.matches('[data-command-palette-input]'))", 5000);
      const openMs = await cdp.evaluate(`(async () => {
        await window.__p6bBench.doubleRAF();
        return Number((performance.now() - window.__p6bCpMark).toFixed(2));
      })()`);
      if (i === 0) cpColdOpenMs = openMs;
      else cpOpenSamples.push(openMs);
      if (i < 5) {
        await cdp.cdpKey('Escape');
        await cdp.until("!document.querySelector('dialog[data-command-palette][open]')", 5000);
        await cdp.evaluate('window.__p6bBench.doubleRAF()');
      }
    }
    const cpTailSearch = await cdp.evaluate(`(async () => {
      const fold = s => String(s ?? '').toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').replace(/ı/g, 'i').replace(/\\s+/g, ' ').trim();
      const input = document.querySelector('[data-command-palette-input]');
      const t0 = performance.now();
      input.value = ${JSON.stringify(tailNeedleName)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await window.__p6bBench.doubleRAF();
      const dt = Number((performance.now() - t0).toFixed(2));
      const opts = [...document.querySelectorAll('[data-command-palette-list] [role="option"]')];
      const matched = opts.some(o => fold(o.textContent).includes(${JSON.stringify(tailNeedleNorm)}));
      return { searchMs: dt, optionCount: opts.length, matched };
    })()`);
    await cdp.cdpKey('Escape');
    await cdp.until("!document.querySelector('dialog[data-command-palette][open]')", 5000);

    // 2. Combobox (#f-counterpartyId over 5k/10k pool): 3 fresh cold samples + 5 warm resultBuild + arrowStep + enterCommit
    const comboColdSamples = [];
    for (let c = 0; c < 3; c++) {
      await cdp.call('Page.navigate', { url: `${env.origin}/owner#v=transaction` });
      await cdp.until("document.querySelector('#sale-form[data-operation=\"sale\"]') && Boolean(document.querySelector('#sale-form .defter-combobox-input'))");
      await cdp.evaluate('window.__p6bBench.doubleRAF()');
      const coldRes = await cdp.evaluate(`(async () => {
        const fold = s => String(s ?? '').toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').replace(/ı/g, 'i').replace(/\\s+/g, ' ').trim();
        const backing = document.querySelector('#f-counterpartyId');
        const combo = backing.closest('.defter-combobox, .field, label').querySelector('.defter-combobox-input[role="combobox"]');
        combo.focus();
        const t0 = performance.now();
        combo.value = ${JSON.stringify(tailNeedleName)};
        combo.dispatchEvent(new Event('input', { bubbles: true }));
        const lb = document.getElementById(combo.getAttribute('aria-controls'));
        const deadline = performance.now() + 5000;
        while (!lb || lb.hidden || lb.querySelectorAll('[role="option"]').length === 0) {
          if (performance.now() > deadline) throw new Error('Timeout waiting for cold combobox options');
          await new Promise(r => setTimeout(r, 1));
        }
        await window.__p6bBench.doubleRAF();
        const dt = Number((performance.now() - t0).toFixed(2));
        const opts = [...lb.querySelectorAll('[role="option"]')];
        return {
          ms: dt,
          optionCount: opts.length,
          backingOptions: backing.options.length,
          tailMatched: opts.some(o => fold(o.textContent).includes(${JSON.stringify(tailNeedleNorm)}))
        };
      })()`);
      comboColdSamples.push(coldRes);
    }

    const comboBuildSamples = [];
    let maxComboOpts = Math.max(...comboColdSamples.map(x => x.optionCount));
    let maxBackingOpts = Math.max(...comboColdSamples.map(x => x.backingOptions));
    const buildQueries = ['Ahmet', 'İbrahim Şahin', tailNeedleName, 'Ayşe Kaya', 'Mehmet Yılmaz', tailNeedleName];
    for (let i = 0; i < buildQueries.length; i++) {
      const q = buildQueries[i];
      const res = await cdp.evaluate(`(async () => {
        const backing = document.querySelector('#f-counterpartyId');
        const combo = backing.closest('.defter-combobox, .field, label').querySelector('.defter-combobox-input[role="combobox"]');
        combo.focus();
        combo.value = '';
        const t0 = performance.now();
        combo.value = ${JSON.stringify(q)};
        combo.dispatchEvent(new Event('input', { bubbles: true }));
        const lb = document.getElementById(combo.getAttribute('aria-controls'));
        const deadline = performance.now() + 5000;
        while (!lb || lb.hidden || lb.querySelectorAll('[role="option"]').length === 0) {
          if (performance.now() > deadline) throw new Error('Timeout waiting for warm combobox options');
          await new Promise(r => setTimeout(r, 1));
        }
        await window.__p6bBench.doubleRAF();
        return {
          ms: Number((performance.now() - t0).toFixed(2)),
          optionCount: lb.querySelectorAll('[role="option"]').length,
          backingOptions: backing.options.length
        };
      })()`);
      maxComboOpts = Math.max(maxComboOpts, res.optionCount);
      maxBackingOpts = Math.max(maxBackingOpts, res.backingOptions);
      if (i >= 1) comboBuildSamples.push(res.ms);
    }

    // ArrowDown (single-rAF) + Enter commit (double-rAF)
    const arrowSamples = [];
    const enterSamples = [];
    for (let i = 0; i < 6; i++) {
      await cdp.evaluate(`(async () => {
        const backing = document.querySelector('#f-counterpartyId');
        const combo = backing.closest('.defter-combobox, .field, label').querySelector('.defter-combobox-input[role="combobox"]');
        window.DefterCombobox.getInstance(backing).clear({ emitChange: false });
        combo.focus();
        combo.value = 'Ahmet';
        combo.dispatchEvent(new Event('input', { bubbles: true }));
        await window.__p6bBench.doubleRAF();
        window.__p6bArrowMark = 0;
        const onArrow = ev => {
          if (ev.key === 'ArrowDown') {
            window.__p6bArrowMark = performance.now();
            combo.removeEventListener('keydown', onArrow, true);
          }
        };
        combo.addEventListener('keydown', onArrow, true);
      })()`);
      const prevActive = await cdp.evaluate("document.querySelector('#f-counterpartyId').closest('.defter-combobox, .field, label').querySelector('.defter-combobox-input[role=\"combobox\"]').getAttribute('aria-activedescendant') || ''");
      await cdp.cdpKey('ArrowDown');
      const arrowMs = await cdp.evaluate(`(async () => {
        const combo = document.querySelector('#f-counterpartyId').closest('.defter-combobox, .field, label').querySelector('.defter-combobox-input[role="combobox"]');
        const deadline = performance.now() + 2000;
        while ((combo.getAttribute('aria-activedescendant') || '') === ${JSON.stringify(prevActive)}) {
          if (performance.now() > deadline) break;
          await new Promise(r => setTimeout(r, 1));
        }
        await new Promise(r => requestAnimationFrame(r));
        return Number((performance.now() - window.__p6bArrowMark).toFixed(2));
      })()`);

      await cdp.evaluate(`(() => {
        const combo = document.querySelector('#f-counterpartyId').closest('.defter-combobox, .field, label').querySelector('.defter-combobox-input[role="combobox"]');
        window.__p6bEnterMark = 0;
        const onEnter = ev => {
          if (ev.key === 'Enter') {
            window.__p6bEnterMark = performance.now();
            combo.removeEventListener('keydown', onEnter, true);
          }
        };
        combo.addEventListener('keydown', onEnter, true);
      })()`);
      await cdp.cdpKey('Enter');
      const enterMs = await cdp.evaluate(`(async () => {
        const backing = document.querySelector('#f-counterpartyId');
        const combo = backing.closest('.defter-combobox, .field, label').querySelector('.defter-combobox-input[role="combobox"]');
        const deadline = performance.now() + 2000;
        while (backing.value === '' || combo.getAttribute('aria-expanded') !== 'false') {
          if (performance.now() > deadline) throw new Error('Timeout waiting for combobox Enter commit');
          await new Promise(r => setTimeout(r, 1));
        }
        await window.__p6bBench.doubleRAF();
        return Number((performance.now() - window.__p6bEnterMark).toFixed(2));
      })()`);
      if (i >= 1) {
        arrowSamples.push(arrowMs);
        enterSamples.push(enterMs);
      }
    }

    const coldSamplesMs = comboColdSamples.map(x => x.ms);
    const coldStats = stats(coldSamplesMs);

    return {
      scale: label,
      dataset: {
        customers: custCount,
        stocks: stockCount,
        supplierFirms: supplierFirmCount,
        supplierUnitAccounts: supplierAccCount,
        totalEvents: events.length,
        genAndReplayMs,
        coldRepoMs: env.coldRepoMs
      },
      ownerInitialLoadMs,
      viewMetrics,
      suppliersPurchaseFormDom,
      journalLazyReturn,
      localSearch: {
        ...localSearch,
        checkoutProductSearch: {
          coldInitialMs: coProdCold.settleMs,
          coldSyncMs: coProdCold.syncMs,
          repeatSettle: stats(coProdRepeat)
        }
      },
      asyncSearch: {
        ownerJournalSearch: {
          coldInitialMs: journalCold.settleMs,
          coldPostDebounceMs: journalCold.postDebounceSettleMs,
          coldNetworkMs: journalCold.durationMs,
          repeatSettle: stats(journalRepeatSamples),
          postDebounceRepeatSettle: stats(journalPostDebounceSamples),
          fourKeystrokeBurstRequests: journalBurstReqs
        },
        checkoutCustomerSearch: {
          coldInitialMs: coCustCold.settleMs,
          coldPostDebounceMs: coCustCold.postDebounceSettleMs,
          coldNetworkMs: coCustCold.durationMs,
          repeatSettle: stats(coCustRepeat),
          postDebounceRepeatSettle: stats(coCustPostDebounceRepeat),
          fiveCharBurstRequests: coCustBurstReqs
        }
      },
      checkout: {
        loadMs: checkoutLoadMs,
        dom: checkoutDom,
        heap: checkoutHeap
      },
      paket6bOnlyComponents: {
        commandPalette: {
          coldOpenMs: cpColdOpenMs,
          warmOpen: stats(cpOpenSamples),
          tailNeedle: tailNeedleName,
          searchTailNeedleMs: cpTailSearch.searchMs,
          searchTailNeedleOptions: cpTailSearch.optionCount,
          searchTailNeedleMatched: cpTailSearch.matched
        },
        combobox: {
          coldInitialMs: coldSamplesMs[0],
          coldInitialSamplesMs: coldSamplesMs,
          coldInitialP95Ms: coldStats.p95Ms,
          tailNeedleMatched: comboColdSamples.every(x => x.tailMatched),
          resultBuild: stats(comboBuildSamples),
          comboboxOptionCount: maxComboOpts,
          backingOptionCount: maxBackingOpts,
          keyboardSelect: {
            arrowStep: stats(arrowSamples),
            enterCommit: stats(enterSamples)
          }
        }
      }
    };
  } finally {
    if (cdp) {
      try { await cdp.close(); } catch {}
    }
    try { await new Promise(done => { env.server.close(done); env.server.closeAllConnections(); }); } catch {}
    await removeDirWithRetry(env.dir, env.profileDir);
  }
}

function evaluateThresholds(output) {
  const checks = [];
  const addCheck = (id, category, metric, observed, target, passed) => {
    checks.push({ id, category, metric, observed, target, passed: Boolean(passed) });
  };

  const r1 = output.suites?.r1;
  const r4_5k = output.suites?.r4?.['5k'];
  const r4_10k = output.suites?.r4?.['10k'];

  if (r4_10k) {
    const accCold = r4_10k.localSearch.ownerAccountSearch.coldInitialMs;
    const prodCold = r4_10k.localSearch.ownerProductSearch.coldInitialMs;
    const supCold = r4_10k.localSearch.ownerSupplierSearch.coldInitialMs;
    const coProdCold = r4_10k.localSearch.checkoutProductSearch.coldInitialMs;
    const cbCold = r4_10k.paket6bOnlyComponents.combobox.coldInitialMs;
    const cbColdP95 = r4_10k.paket6bOnlyComponents.combobox.coldInitialP95Ms;
    addCheck(
      'T01_local_cold_search',
      'Local Search',
      'Initial cold search (10k)',
      { accCold, prodCold, supCold, coProdCold, cbCold, cbColdP95 },
      '<= 85 ms single cold, cb p95 <= 110 ms',
      accCold <= 85 && prodCold <= 85 && supCold <= 85 && coProdCold <= 85 && cbCold <= 85 && cbColdP95 <= 110
    );

    const accRep = r4_10k.localSearch.ownerAccountSearch.repeatSettle;
    const prodRep = r4_10k.localSearch.ownerProductSearch.repeatSettle;
    const supRep = r4_10k.localSearch.ownerSupplierSearch.repeatSettle;
    const coProdRep = r4_10k.localSearch.checkoutProductSearch.repeatSettle;
    addCheck(
      'T02_local_repeat_search',
      'Local Search',
      'Repeat warm search (10k)',
      { accRep, prodRep, supRep, coProdRep },
      'median <= 20 ms, p95 <= 40 ms',
      [accRep, prodRep, supRep, coProdRep].every(s => s.medianMs <= 20 && s.p95Ms <= 40)
    );

    const jBurst = r4_10k.asyncSearch.ownerJournalSearch.fourKeystrokeBurstRequests;
    const coBurst = r4_10k.asyncSearch.checkoutCustomerSearch.fiveCharBurstRequests;
    addCheck(
      'T03_async_burst_requests',
      'Async Search',
      'Debounced burst HTTP requests (4-5 chars)',
      { jBurst, coBurst },
      '<= 1 request',
      jBurst <= 1 && coBurst <= 1
    );

    const coPost = r4_10k.asyncSearch.checkoutCustomerSearch.postDebounceRepeatSettle;
    addCheck(
      'T04_checkout_async_settle',
      'Async Search',
      '/checkout #search postDebounceSettleMs (10k)',
      coPost,
      'median <= 140 ms, p95 <= 220 ms',
      coPost.medianMs <= 140 && coPost.p95Ms <= 220
    );

    const jPost = r4_10k.asyncSearch.ownerJournalSearch.postDebounceRepeatSettle;
    addCheck(
      'T05_journal_async_settle',
      'Async Search',
      '#journal-search postDebounceSettleMs repeat (10k)',
      jPost,
      'median <= 250 ms, p95 <= 400 ms',
      jPost.medianMs <= 250 && jPost.p95Ms <= 400
    );

    const cp10 = r4_10k.paket6bOnlyComponents.commandPalette.warmOpen;
    const cpDiff = r4_5k ? Math.abs(cp10.medianMs - r4_5k.paket6bOnlyComponents.commandPalette.warmOpen.medianMs) : 0;
    addCheck(
      'T06_command_palette_open',
      'Command Palette',
      'Ctrl+K open + double-rAF (5k & 10k)',
      { open10k: cp10, scaleDiffMs: Number(cpDiff.toFixed(2)), tailMatched: r4_10k.paket6bOnlyComponents.commandPalette.searchTailNeedleMatched },
      'median <= 35 ms, p95 <= 75 ms, |10k-5k| <= 15 ms',
      cp10.medianMs <= 35 && cp10.p95Ms <= 75 && cpDiff <= 15 && r4_10k.paket6bOnlyComponents.commandPalette.searchTailNeedleMatched
    );

    const cbBuild = r4_10k.paket6bOnlyComponents.combobox.resultBuild;
    addCheck(
      'T07_combobox_result_build',
      'Combobox',
      'Result build (<= 20 options over 10k pool)',
      { cbBuild, tailMatched: r4_10k.paket6bOnlyComponents.combobox.tailNeedleMatched },
      'median <= 35 ms, p95 <= 60 ms',
      cbBuild.medianMs <= 35 && cbBuild.p95Ms <= 60 && r4_10k.paket6bOnlyComponents.combobox.tailNeedleMatched
    );

    const kbArrow = r4_10k.paket6bOnlyComponents.combobox.keyboardSelect.arrowStep;
    const kbEnter = r4_10k.paket6bOnlyComponents.combobox.keyboardSelect.enterCommit;
    addCheck(
      'T08_combobox_keyboard',
      'Combobox',
      'ArrowDown (single-rAF) & Enter commit (double-rAF)',
      { arrowStep: kbArrow, enterCommit: kbEnter },
      'ArrowDown p95 <= 16.6 ms; Enter p95 <= 50 ms',
      kbArrow.p95Ms <= 16.6 && kbEnter.p95Ms <= 50
    );

    const maxRoleOpts = Math.max(
      r4_10k.paket6bOnlyComponents.combobox.comboboxOptionCount,
      r4_10k.paket6bOnlyComponents.commandPalette.searchTailNeedleOptions,
      r4_5k ? r4_5k.paket6bOnlyComponents.combobox.comboboxOptionCount : 0
    );
    addCheck(
      'T09_dom_role_options',
      'DOM Bounds',
      'Max [role="option"] in open Combobox (5k & 10k)',
      { maxRoleOpts },
      '<= 20 Combobox nodes (<= 25 Palette)',
      r4_10k.paket6bOnlyComponents.combobox.comboboxOptionCount <= 20 &&
      (!r4_5k || r4_5k.paket6bOnlyComponents.combobox.comboboxOptionCount <= 20)
    );

    const saleMaxSel = r4_10k.viewMetrics.transaction_sale.dom.maxSelectOptions;
    const colMaxSel = r4_10k.viewMetrics.transaction_collection.dom.maxSelectOptions;
    const jrnMaxSel = r4_10k.viewMetrics.journal.dom.maxSelectOptions;
    const supMaxSel = r4_10k.suppliersPurchaseFormDom.maxSelectOptions;
    addCheck(
      'T10_dom_max_select_options',
      'DOM Bounds',
      'Max <option> in single large-entity <select>',
      { saleMaxSel, colMaxSel, jrnMaxSel, supMaxSel, refundProductOpts: r4_10k.journalLazyReturn.refundProductOptions },
      '<= 25 (<= 2 on large Combobox selects)',
      saleMaxSel <= 25 && colMaxSel <= 25 && jrnMaxSel <= 25 && supMaxSel <= 25 &&
      (r4_10k.journalLazyReturn.refundProductOptions === null || r4_10k.journalLazyReturn.refundProductOptions <= 25)
    );

    const saleOpts = r4_10k.viewMetrics.transaction_sale.dom.optionCount;
    const colOpts = r4_10k.viewMetrics.transaction_collection.dom.optionCount;
    const jrnOpts = r4_10k.viewMetrics.journal.dom.optionCount;
    const diffSale = r4_5k ? r4_10k.viewMetrics.transaction_sale.dom.totalElements - r4_5k.viewMetrics.transaction_sale.dom.totalElements : 0;
    const diffCol = r4_5k ? r4_10k.viewMetrics.transaction_collection.dom.totalElements - r4_5k.viewMetrics.transaction_collection.dom.totalElements : 0;
    const diffJrn = r4_5k ? r4_10k.viewMetrics.journal.dom.totalElements - r4_5k.viewMetrics.journal.dom.totalElements : 0;
    addCheck(
      'T11_dom_total_options_and_o1_scaling',
      'DOM Bounds',
      'Total <option> & O(1) totalElements(10k-5k) <= 100',
      { saleOpts, colOpts, jrnOpts, diffSale, diffCol, diffJrn, lazyUnmounted: r4_10k.journalLazyReturn.unmountedInitially },
      'sale<=50, col<=50, journal<=150, diff<=100',
      saleOpts <= 50 && colOpts <= 50 && jrnOpts <= 150 &&
      diffSale <= 100 && diffCol <= 100 && diffJrn <= 100 &&
      r4_10k.journalLazyReturn.unmountedInitially
    );

    const saleSettle = r4_10k.viewMetrics.transaction_sale.settle;
    addCheck(
      'T12_sale_view_settle',
      'View Render & Heap',
      'transaction_sale view settle (10k)',
      saleSettle,
      'median <= 100 ms, p95 <= 150 ms',
      saleSettle.medianMs <= 100 && saleSettle.p95Ms <= 150
    );

    const jrnSettle = r4_10k.viewMetrics.journal.settle;
    addCheck(
      'T13_journal_view_settle',
      'View Render & Heap',
      'journal view settle (10k)',
      jrnSettle,
      'median <= 250 ms, p95 <= 400 ms',
      jrnSettle.medianMs <= 250 && jrnSettle.p95Ms <= 400
    );

    const accP95 = r4_10k.viewMetrics.accounts.settle.p95Ms;
    const stkP95 = r4_10k.viewMetrics.stocks.settle.p95Ms;
    const supP95 = r4_10k.viewMetrics.suppliers.settle.p95Ms;
    // Baseline p95s from BASELINE_METRICS.md: accounts=36.06, stocks=49.64, suppliers=52.50 -> max(base*1.25+30, 100) = 100 ms
    addCheck(
      'T14_unchanged_views_non_regression',
      'View Render & Heap',
      'Non-changed views p95 (accounts/stocks/suppliers 10k)',
      { accP95, stkP95, supP95 },
      'p95 <= 100 ms',
      accP95 <= 100 && stkP95 <= 100 && supP95 <= 100
    );

    const saleHeap = r4_10k.viewMetrics.transaction_sale.heap.usedJSHeapMB;
    const jrnHeap = r4_10k.viewMetrics.journal.heap.usedJSHeapMB;
    addCheck(
      'T15_post_gc_heap',
      'View Render & Heap',
      'Post-GC JS Heap (10k sale & journal)',
      { saleHeap, jrnHeap },
      '<= 8.50 MB',
      saleHeap <= 8.5 && jrnHeap <= 8.5
    );
  }

  if (r1) {
    const byId = Object.fromEntries(r1.scenarios.map(s => [s.id, s]));
    const w7s = byId.w7_owner_cards_simple?.observed;
    const w7c = byId.w7_owner_cards_complex?.observed;
    const w3o = byId.w3_owner_find_customer_simple?.observed;
    const w3co = byId.w3_checkout_find_customer_simple?.observed;
    const allResponsiveOk = r1.responsiveChecks.every(rc => rc.noHorizontalOverflow && (rc.paletteFit === undefined || rc.paletteFit));
    addCheck(
      'T16_r1_efficiency_and_continuity',
      'R1 Efficiency & Continuity',
      'Ctrl+K jump, Combobox <=6 actions, F5 detail restore, responsive',
      {
        w7SimpleActions: w7s?.totalActions,
        w3OwnerActions: w3o?.totalActions,
        w3CheckoutActions: w3co?.totalActions,
        f5RestoredDetailCard: w7c?.f5RestoredDetailCard,
        hashBeforeF5: w7c?.hashBeforeF5,
        allResponsiveOk
      },
      'w7_simple<=4, w3<=6, f5RestoredDetailCard=true, responsive OK',
      (w7s?.totalActions ?? 99) <= 4 &&
      (w3o?.totalActions ?? 99) <= 6 &&
      (w3co?.totalActions ?? 99) <= 6 &&
      w7c?.f5RestoredDetailCard === true &&
      String(w7c?.hashBeforeF5 || '').includes('&id=stock-r1-stk-burma') &&
      allResponsiveOk
    );
  }

  const passed = checks.filter(c => c.passed).length;
  return {
    checks,
    summary: {
      total: checks.length,
      passed,
      failed: checks.length - passed,
      allPassed: checks.length > 0 && passed === checks.length
    }
  };
}

async function main() {
  const output = {
    node: process.version,
    platform: process.platform,
    chromePath,
    timestamp: new Date().toISOString(),
    suites: {}
  };
  if (runR1) {
    output.suites.r1 = await runR1Suite();
  }
  if (runR4) {
    output.suites.r4 = {};
    if (r4ScalesArg.includes('5k')) output.suites.r4['5k'] = await runR4Scale(5000, 15000);
    if (r4ScalesArg.includes('10k')) output.suites.r4['10k'] = await runR4Scale(10000, 25000);
  }
  output.thresholdEvaluation = evaluateThresholds(output);
  if (jsonOnly) {
    console.log(JSON.stringify(output));
  } else {
    console.log(JSON.stringify(output, null, 2));
  }
  if (assertThresholds && !output.thresholdEvaluation.summary.allPassed) {
    const failedIds = output.thresholdEvaluation.checks.filter(c => !c.passed).map(c => c.id).join(', ');
    console.error(`Threshold assertion failed: ${failedIds}`);
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(err?.stack || err);
  process.exit(1);
});
