import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadJSDOM } from '../test-support/jsdom.mjs';
import { Repository, BACKUP_MAX_BYTES } from '../repository.mjs';
import { DomainError, INITIAL_ACCOUNTS } from '../domain.mjs';

const JSDOM = await loadJSDOM();
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const cases = [];
const check = (name, run) => cases.push({ name, run });

async function fixture({ pending = false, committedPending = false } = {}) {
  const repo = new Repository(':memory:', 'demo'), donor = new Repository(':memory:', 'demo'), other = new Repository(':memory:', 'dukkan');
  const balances = Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, '0']));
  balances.nakit = '100';
  donor.execute({ id: 'recovery-valid-opening', revision: 0, command: { type: 'opening', date: '2026-10-27', balances } });
  const backup = donor.backup();
  let original = { ...backup.events[0], command: { ...backup.events[0].command, balances: {} } };
  let pendingEnvelope = { id: 'pending-request', revision: 0, command: { type: 'movement' } };
  if (committedPending) {
    repo.execute({ id: backup.events[0].id, revision: 0, command: backup.events[0].command });
    pendingEnvelope = { id: 'recovery-committed-pending', revision: 1, command: { type: 'movement', date: '2026-10-27', accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '1', note: 'Synthetic committed pending request' } };
    repo.execute(pendingEnvelope);
    original = { ...original, id: 'semantic-damage-after-pending' };
  }
  repo.db.prepare('INSERT INTO events(id,body) VALUES(?,?)').run(original.id, JSON.stringify(original));
  if (committedPending) repo.db.exec('UPDATE meta SET revision=3 WHERE id=1');
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:4317/', runScripts: 'outside-only' });
  const { window } = dom, document = window.document;
  if (pending || committedPending) window.sessionStorage.setItem('defter-pending-demo', JSON.stringify(pendingEnvelope));
  const calls = { metadata: 0, restore: 0, state: 0, command: 0, commandStatus: null };
  const controller = { metadata: { workspace: 'demo', revision: 0, canRestore: true }, metadataDelay: null, restoreDelay: null, mode: 'success', usable: false };
  window.fetch = async (url, options) => {
    const selected = new URL(url, window.location.href), route = selected.pathname, workspace = selected.searchParams.get('workspace');
    const ok = value => ({ ok: true, status: 200, json: async () => value });
    const fail = (status, error) => ({ ok: false, status, json: async () => ({ error }) });
    if (route === '/api/state') {
      calls.state++;
      if (workspace === 'dukkan') return ok(other.state());
      return controller.usable ? ok(repo.state()) : fail(500, 'Defter okunamadı <img src=x>');
    }
    if(route==='/api/journal'){
      try{return ok(repo.journalPage({scope:'all',q:new URL(url,'http://localhost').searchParams.get('q')}));}
      catch(error){calls.lookupStatus=error instanceof DomainError?error.status:500;return fail(calls.lookupStatus,'Defter okunamadı.');}
    }
    if (route === '/api/recovery') {
      calls.metadata++;
      if (controller.metadataDelay) await controller.metadataDelay;
      return ok(controller.metadata);
    }
    if (route === '/api/command') {
      assert.equal(workspace, 'demo'); calls.command++;
      try { const result = repo.execute(JSON.parse(options.body)); calls.commandStatus = 200; return ok(result); }
      catch (error) { calls.commandStatus = error instanceof DomainError ? error.status : 500; return fail(calls.commandStatus, 'İşlem tamamlanamadı. Son isteğin sonucunu kontrol edin.'); }
    }
    assert.equal(route, '/api/restore'); assert.equal(workspace, 'demo'); calls.restore++;
    if (controller.restoreDelay) await controller.restoreDelay;
    if (controller.mode === 'conflict') return fail(409, 'Veriler değişti.');
    if (controller.mode === 'network') throw new Error('Bağlantı kesildi');
    const state = repo.restore(JSON.parse(options.body)); controller.usable = true;
    return controller.mode === 'committed500' ? fail(500, 'Yanıt alınamadı') : ok({ state });
  };
  window.eval(source);
  await tick();
  return { repo, backup, original, pendingEnvelope, window, document, controller, calls,
    async open() { const button = document.querySelector('#load-recovery'); assert.ok(button, 'Explicit recovery action is available'); button.click(); await tick(); },
    async send({ size = 1000, confirmation = 'GERİ YÜKLE', text = async () => JSON.stringify(backup) } = {}) {
      const file = document.querySelector('#f-backupFile'); assert.ok(file);
      Object.defineProperty(file, 'files', { value: [{ size, text }], configurable: true });
      document.querySelector('#f-confirmation').value = confirmation;
      document.querySelector('#restore-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      await tick();
    },
    changeWorkspace() { document.querySelector('#workspace').value = 'dukkan'; document.querySelector('#workspace').dispatchEvent(new window.Event('change', { bubbles: true })); },
    close() { window.close(); repo.close(); donor.close(); other.close(); }
  };
}

check('recovery is explicit and restores a semantic damaged history while preserving its archive', async context => {
  const { calls, document, repo, original } = context;
  assert.equal(calls.metadata, 0); assert.equal(calls.restore, 0);
  assert.equal(document.querySelector('#business-date').textContent, 'Bilgi alınamadı');
  await context.open(); assert.equal(calls.metadata, 1);
  assert.match(document.querySelector('#restore-warning').textContent, /Örnek defter/);
  assert.equal(document.querySelector('#restore-form').getAttribute('aria-describedby'), 'restore-warning');
  await context.send(); assert.equal(calls.restore, 1);
  assert.match(document.querySelector('#main h1').textContent, /Günün Görünümü/);
  assert.equal(document.querySelector('#load-error-title'), null);
  assert.equal(repo.state().balances.nakit, 10000);
  assert.deepEqual(JSON.parse(repo.db.prepare('SELECT body FROM restore_archive').get().body).events, [original]);
  assert.equal(document.querySelector('img'), null);
});

check('unsafe or mismatched recovery metadata never exposes a restore form', async context => {
  const { controller, document, calls } = context;
  for (const metadata of [{ workspace: 'demo', revision: 0, canRestore: false }, { workspace: 'demo', revision: -1, canRestore: true }, { workspace: 'dukkan', revision: 0, canRestore: true }, { workspace: 'demo', revision: '0', canRestore: true }, { workspace: 'demo', revision: 0, canRestore: 'true' }]) {
    controller.metadata = metadata; await context.open();
    assert.equal(document.querySelector('#restore-form'), null);
  }
  assert.equal(calls.restore, 0); assert.equal(document.querySelector('img'), null);
});

check('pending uncertain commands block recovery before metadata or restore writes', async () => {
  const context = await fixture({ pending: true });
  try {
    await context.open(); assert.equal(context.calls.metadata, 0); assert.equal(context.calls.restore, 0);
    assert.equal(context.document.querySelector('#restore-form'), null);
    assert.match(context.document.querySelector('#notice').textContent, /belirsiz|son isteği/i);
  } finally { context.close(); }
});

check('stored history damage preserves a committed pending request when same-ID retry fails', async () => {
  // Exercise real history lookup: damaged history must prevent any repeated write.
  const context = await fixture({ committedPending: true });
  try {
    const { repo, document, window, pendingEnvelope, calls } = context;
    const before = repo.events();
    assert.equal(document.querySelector('#retry-bar').hidden, false);
    document.querySelector('#retry').click(); await tick();
    assert.equal(calls.command, 0);
    assert.equal(calls.lookupStatus, 500, 'Stored history failure must remain an uncertain server result.');
    assert.equal(document.querySelector('#retry-bar').hidden, false);
    assert.deepEqual(JSON.parse(window.sessionStorage.getItem('defter-pending-demo')), pendingEnvelope);
    await context.open();
    assert.equal(calls.metadata, 0); assert.equal(calls.restore, 0);
    assert.equal(document.querySelector('#restore-form'), null);
    assert.equal(repo.db.prepare('SELECT count(*) AS count FROM events WHERE id=?').get(pendingEnvelope.id).count, 1);
    assert.deepEqual(repo.events(), before);
  } finally { context.close(); }
});

check('recovery reuses file size and explicit confirmation guards without changing damaged records', async context => {
  await context.open();
  await context.send({ confirmation: 'yanlış' }); assert.equal(context.calls.restore, 0);
  await context.send({ size: BACKUP_MAX_BYTES + 1 }); assert.equal(context.calls.restore, 0);
  assert.deepEqual(context.repo.events(), [context.original]);
  assert.match(context.document.querySelector('#notice').textContent, /64 MiB/);
});

check('revision conflicts invalidate the old file and confirmation until fresh metadata is requested', async context => {
  await context.open(); context.controller.mode = 'conflict'; await context.send();
  assert.equal(context.calls.restore, 1); assert.equal(context.document.querySelector('#restore-form'), null);
  assert.ok(context.document.querySelector('#recovery-recheck'));
  assert.match(context.document.querySelector('#notice').textContent, /yeniden|değişti/i);
  context.document.querySelector('#recovery-recheck').click(); await tick();
  assert.equal(context.calls.metadata, 2); assert.equal(context.calls.restore, 1);
  assert.equal(context.document.querySelector('#f-confirmation').value, '');
  assert.equal(context.document.querySelector('#f-backupFile').files.length, 0);
});

check('a committed restore with a failed response requires state refresh rather than automatic replay', async context => {
  await context.open(); context.controller.mode = 'committed500'; await context.send();
  assert.equal(context.calls.restore, 1); assert.equal(context.document.querySelector('#restore-form'), null);
  assert.match(context.document.querySelector('#notice').textContent, /belirsiz|Yenile/i);
  context.document.querySelector('#refresh').click(); await tick();
  assert.match(context.document.querySelector('#main h1').textContent, /Günün Görünümü/);
  assert.equal(context.calls.restore, 1); assert.equal(context.repo.db.prepare('SELECT count(*) AS count FROM restore_archive').get().count, 1);
});

check('a lost restore connection never retries automatically or retains an armed restore form', async context => {
  await context.open(); context.controller.mode = 'network'; await context.send();
  assert.equal(context.calls.restore, 1); assert.equal(context.document.querySelector('#restore-form'), null);
  assert.match(context.document.querySelector('#notice').textContent, /belirsiz|Yenile/i);
  assert.deepEqual(context.repo.events(), [context.original]);
});

check('the normal backup screen also requires refresh after an uncertain restore result', async context => {
  await context.open(); await context.send();
  context.document.querySelector('[data-view="backup"]').click();
  context.controller.mode = 'committed500'; await context.send();
  assert.equal(context.calls.restore, 2); assert.equal(context.document.querySelector('#restore-form'), null);
  assert.equal(context.document.querySelector('#recovery-recheck'), null);
  context.document.querySelector('#restore-state-refresh').click(); await tick();
  assert.ok(context.document.querySelector('#restore-form'));
  assert.equal(context.document.querySelector('#f-confirmation').value, '');
  assert.equal(context.calls.restore, 2);
});

check('workspace changes discard stale recovery metadata', async context => {
  let release; context.controller.metadataDelay = new Promise(resolve => { release = resolve; });
  context.document.querySelector('#load-recovery')?.click(); await tick();
  assert.equal(context.calls.metadata, 1); context.changeWorkspace(); release(); await tick(); await tick();
  assert.equal(context.document.querySelector('#restore-form'), null); assert.equal(context.calls.restore, 0);
  assert.equal(context.document.querySelector('#workspace').value, 'dukkan');
});

check('workspace changes during file reading cannot POST a backup to the new workspace', async context => {
  await context.open(); let release;
  const content = new Promise(resolve => { release = resolve; });
  await context.send({ text: () => content }); context.changeWorkspace(); release(JSON.stringify(context.backup)); await tick(); await tick();
  assert.equal(context.calls.restore, 0); assert.equal(context.document.querySelector('#restore-form'), null);
  assert.equal(context.document.querySelector('#workspace').value, 'dukkan');
});

check('workspace changes during a restore response cannot replace the newly selected screen', async context => {
  await context.open(); let release; context.controller.restoreDelay = new Promise(resolve => { release = resolve; });
  await context.send(); assert.equal(context.calls.restore, 1); context.changeWorkspace(); release(); await tick(); await tick();
  assert.equal(context.document.querySelector('#workspace').value, 'dukkan');
  assert.ok(context.document.querySelector('#opening-form')); assert.equal(context.document.querySelector('#restore-form'), null);
});

let failed = 0;
for (const { name, run } of cases) {
  const context = await fixture();
  try { await run(context); console.log('PASS:', name); }
  catch (error) { failed++; console.error('FAIL:', name, '\n', error.message); }
  finally { context.close(); }
}
if (failed) { console.error(`${failed} recovery checks failed.`); process.exitCode = 1; }
else console.log('PASS: 12 recovery checks using synthetic memory repositories; no real data files opened.');
