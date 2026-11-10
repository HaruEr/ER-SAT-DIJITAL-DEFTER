import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadJSDOM } from '../test-support/jsdom.mjs';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS } from '../domain.mjs';

const JSDOM = await loadJSDOM();
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const cases = [];
const check = (name, run) => cases.push({ name, run });
async function fixture({ damaged = false } = {}) {
  const repo = new Repository(':memory:', 'demo'), donor = new Repository(':memory:', 'demo'), other = new Repository(':memory:', 'dukkan');
  const balances = Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, '0']));
  balances.nakit = '100';
  repo.execute({ id: 'old-opening', revision: 0, command: { type: 'opening', date: '2026-10-27', balances } });
  donor.execute({ id: 'new-opening', revision: 0, command: { type: 'opening', date: '2026-10-27', balances: { ...balances, nakit: '275' } } });
  const backup = donor.backup();
  const controller = { usable: !damaged, mode: 'success', delay: null, calls: [], file: null, stateReads: 0, stateFailure: null, failedStateStatus: 500 };
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:4317/', runScripts: 'outside-only' });
  const { window } = dom, document = window.document;
  window.fetch = async (url, options) => {
    const selected = new URL(url, window.location.href), route = selected.pathname, workspace = selected.searchParams.get('workspace');
    const ok = value => ({ ok: true, status: 200, json: async () => value });
    if (route === '/api/state') {
      controller.stateReads++;
      if (workspace === 'dukkan') return ok(other.state());
      if (controller.stateFailure) return { ok: false, status: controller.stateFailure, json: async () => ({ error: 'Sentetik görünüm yenileme hatası' }) };
      if (!controller.usable) return { ok: false, status: 500, json: async () => ({ error: 'Sentetik okunamayan görünüm' }) };
      return ok(repo.state());
    }
    if (route === '/api/recovery') return ok({ workspace: 'demo', revision: repo.state().revision, canRestore: true });
    assert.equal(route, '/api/archive/restore');
    assert.equal(workspace, 'demo');
    assert.equal(options.body, controller.file, 'Send the file body directly, without JSON or text buffering.');
    assert.equal(options.headers['Content-Type'], 'application/x-ndjson');
    assert.equal(selected.searchParams.get('confirmation'), 'GERİ YÜKLE');
    controller.calls.push(selected);
    if (controller.delay) await controller.delay;
    const state = repo.restore({ backup, revision: Number(selected.searchParams.get('revision')), confirmation: selected.searchParams.get('confirmation') });
    controller.usable = true;
    if (controller.mode === 'stateReadFailure') controller.stateFailure = controller.failedStateStatus;
    if (controller.mode === 'committed500') return { ok: false, status: 500, json: async () => ({ error: 'Sentetik yanıt kaybı' }) };
    return ok({ workspace: controller.mode === 'wrongWorkspace' ? 'dukkan' : 'demo', revision: state.revision, restoredEvents: backup.events.length, archiveId: 1 });
  };
  window.eval(script + '\nwindow.__archiveUX = { setView };');
  await tick();
  if (!damaged) window.__archiveUX.setView('backup');
  return { repo, window, document, controller,
    async send({ name = 'fixture.ndjson', size = 70 * 1024 * 1024 } = {}) {
      const file = { name, size, text() { throw new Error('Large file must not be read through text().'); } };
      controller.file = file;
      Object.defineProperty(document.querySelector('#f-backupFile'), 'files', { value: [file], configurable: true });
      document.querySelector('#f-confirmation').value = 'GERİ YÜKLE';
      document.querySelector('#restore-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      await tick();
    },
    close() { window.close(); repo.close(); donor.close(); other.close(); }
  };
}
check('archive download and legacy JSON remain separately discoverable', async ({ document }) => {
  assert.ok(document.querySelector('a[href^="/api/archive?"]'));
  assert.ok(document.querySelector('a[href^="/api/backup?"]'));
  assert.match(document.querySelector('#f-backupFile').accept, /ndjson/);
});
check('a large file is sent raw and its compact receipt is followed by a fresh state read', async context => {
  const before = context.controller.stateReads;
  await context.send();
  assert.equal(context.controller.calls.length, 1);
  assert.equal(context.controller.calls[0].searchParams.get('revision'), '1');
  assert.equal(context.controller.stateReads, before + 1);
  assert.equal(context.repo.state().balances.nakit, 27500);
  assert.match(context.document.querySelector('#notice').textContent, /geri yüklendi/);
});
check('the larger archive cap never silently expands the legacy JSON cap', async context => {
  await context.send({ name: 'too-large.ndjson', size: 512 * 1024 * 1024 + 1 });
  assert.equal(context.controller.calls.length, 0);
  assert.match(context.document.querySelector('#notice').textContent, /512 MiB/);
  await context.send({ name: 'legacy.json', size: 64 * 1024 * 1024 + 1 });
  assert.equal(context.controller.calls.length, 0);
  assert.match(context.document.querySelector('#notice').textContent, /64 MiB/);
});
check('an archive is available from explicit startup recovery as well', async () => {
  const context = await fixture({ damaged: true });
  try {
    context.document.querySelector('#load-recovery').click(); await tick();
    await context.send();
    assert.equal(context.controller.calls.length, 1);
    assert.match(context.document.querySelector('#main h1').textContent, /Günün Görünümü/);
  } finally { context.close(); }
});
check('a lost response never leaves an armed archive restore form', async context => {
  context.controller.mode = 'committed500'; await context.send();
  assert.equal(context.controller.calls.length, 1);
  assert.equal(context.document.querySelector('#restore-form'), null);
  context.document.querySelector('#refresh').click(); await tick();
  assert.equal(context.controller.calls.length, 1);
});
check('a mismatched receipt is rejected instead of installing another workspace state', async context => {
  context.controller.mode = 'wrongWorkspace'; await context.send();
  assert.equal(context.controller.calls.length, 1);
  assert.equal(context.document.querySelector('#restore-form'), null);
  assert.match(context.document.querySelector('#notice').textContent, /belirsiz|doğrulanamadı/);
});
for (const stateStatus of [400, 500]) check(`a confirmed archive restore remains successful when the following state read fails with ${stateStatus}`, async context => {
  context.controller.mode = 'stateReadFailure'; context.controller.failedStateStatus = stateStatus;
  await context.send();
  assert.equal(context.controller.calls.length, 1);
  assert.equal(context.repo.state().balances.nakit, 27500);
  assert.equal(context.repo.db.prepare('SELECT count(*) AS count FROM restore_archive').get().count, 1);
  assert.equal(context.document.querySelector('#restore-form'), null);
  const notice = context.document.querySelector('#notice').textContent, panel = context.document.querySelector('#restore-panel').textContent;
  assert.match(notice, /Arşiv geri yüklendi/i); assert.match(notice, /ekran yenilenemedi/i);
  assert.match(notice, /tekrar yapmayın/i); assert.doesNotMatch(notice + panel, /belirsiz/i);
  assert.ok(context.document.querySelector('#restore-state-refresh'));
  context.controller.stateFailure = null;
  context.document.querySelector('#restore-state-refresh').click(); await tick();
  assert.equal(context.controller.calls.length, 1, 'Refreshing the confirmed result must never send another restore request.');
  assert.match(context.document.querySelector('#notice').textContent, /Defter yenilendi/);
});

let failed = 0;
for (const item of cases) {
  const context = await fixture();
  try { await item.run(context); console.log(`PASS: ${item.name}`); }
  catch (error) { failed++; console.error(`FAIL: ${item.name}\n${error.message}`); }
  finally { context.close(); }
}
if (failed) { console.error(`${failed} archive UI checks failed.`); process.exitCode = 1; }
else console.log(`PASS: ${cases.length} archive UI checks; file metadata/body are simulated, backend stream roundtrip is tested separately.`);
