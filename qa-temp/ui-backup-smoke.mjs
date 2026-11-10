import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadJSDOM } from '../test-support/jsdom.mjs';
import { Repository, BACKUP_MAX_BYTES } from '../repository.mjs';
import { INITIAL_ACCOUNTS } from '../domain.mjs';

const JSDOM = await loadJSDOM();
const repo = new Repository(':memory:', 'demo');
const balances = Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, '0']));
repo.execute({ id: 'ui-backup-opening', revision: 0, command: { type: 'opening', date: '2026-10-27', balances } });
const content = JSON.stringify(repo.backup());
const dom = new JSDOM(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), {
  url: 'http://127.0.0.1:4317/', runScripts: 'outside-only'
});
const { window } = dom;
Object.defineProperty(window.crypto, 'randomUUID', { value: randomUUID });
let backupFailure = 'Gün kapandı ve kayıtlar SQLite’a işlendi; geçmiş desteklenen 64 MiB JSON yedek sınırını aşıyor. Bu geçmiş için ayrı kurtarma desteği gerekir; kayıtları silmeyin veya kaynak veritabanını değiştirmeyin.';
let restores = 0;
window.fetch = async (url, options) => {
  const route = new URL(url, window.location.href).pathname;
  if (route === '/api/state') return { ok: true, status: 200, json: async () => repo.state() };
  if (route === '/api/command') {
    const result = repo.execute(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => ({ ...result, backupStatus: { saved: false, error: backupFailure } }) };
  }
  assert.equal(route, '/api/restore');
  restores++;
  const state = repo.restore(JSON.parse(options.body));
  return { ok: true, status: 200, json: async () => ({ state }) };
};
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
try {
  window.eval(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8') + '\nwindow.__ui = { setView, submit };');
  await tick();
  window.__ui.setView('backup');
  const submitFile = async size => {
    // Isolate the UI File.size boundary; content is a small genuine Repository backup.
    // Repository/HTTP tests separately exercise actual 64 MiB serialized data.
    const file = { size, text: async () => content };
    Object.defineProperty(window.document.querySelector('#f-backupFile'), 'files', { value: [file], configurable: true });
    window.document.querySelector('#f-confirmation').value = 'GERİ YÜKLE';
    window.document.querySelector('#restore-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await tick();
  };
  const before = repo.state().revision;
  await submitFile(BACKUP_MAX_BYTES + 1);
  assert.equal(restores, 0);
  assert.equal(repo.state().revision, before);
  assert.match(window.document.querySelector('#notice').textContent, /64 MiB/);
  await submitFile(BACKUP_MAX_BYTES);
  assert.equal(restores, 1);
  assert.equal(repo.state().revision, before + 1);
  assert.equal(repo.db.prepare('SELECT count(*) AS count FROM restore_archive').get().count, 1);
  assert.match(window.document.querySelector('#notice').textContent, /Yedek doğrulanarak geri yüklendi/);
  assert.equal(window.document.body.getAttribute('aria-busy'), 'false');
  const state = repo.state();
  await window.__ui.submit({ type: 'close', approvedBy: 'Synthetic UI test', reasons: {},
    counts: Object.fromEntries(state.accounts.filter(a => a.physical && !a.retired && a.countPolicy === 'daily').map(a => [a.id, '0'])) });
  assert.equal(repo.state().date, '2026-10-28');
  assert.match(window.document.querySelector('#notice').textContent, /GÜN KAPANDI/);
  assert.match(window.document.querySelector('#notice').textContent, /kurtarma desteği/);
  assert.doesNotMatch(window.document.querySelector('#notice').textContent, /Yedek ekranından uygun yedeği/i);
  backupFailure = undefined;
  await window.__ui.submit({ type: 'close', approvedBy: 'Synthetic UI test', reasons: {},
    counts: Object.fromEntries(repo.state().accounts.filter(a => a.physical && !a.retired && a.countPolicy === 'daily').map(a => [a.id, '0'])) });
  assert.equal(repo.state().date, '2026-10-29');
  assert.match(window.document.querySelector('#notice').textContent, /Dosya yazma hatası.*Yedek ekranından uygun yedeği.*akışlı arşiv/i);
  console.log('PASS: UI backup boundary accepts File.size=64 MiB, rejects +1 before fetch, restores a genuine small backup through the memory Repository, and preserves actionable oversized closing backup guidance. File.size metadata is simulated; actual 64 MiB content is covered separately.');
} finally { window.close(); repo.close(); }
