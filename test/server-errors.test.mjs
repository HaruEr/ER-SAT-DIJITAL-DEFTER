import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { authenticateTestOwner, ownerFetch as fetch } from '../test-support/editor-session.mjs';
import { Repository } from '../repository.mjs';
import * as domain from '../domain.mjs';

const projectDirectory = fileURLToPath(new URL('../', import.meta.url));
const opening = () => ({ type: 'opening', date: '2026-10-27', balances: Object.fromEntries(domain.INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, '0'])) });

async function fixture(t, logger) {
  const temporaryRoot = resolve(tmpdir());
  const dataDirectory = mkdtempSync(join(temporaryRoot, 'defter-errors-'));
  const { server, repositories } = createApp({ dataDirectory, logger });
  const repo = new Repository(':memory:', 'demo');
  repositories.set('demo', repo);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await authenticateTestOwner(server);
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    assert.equal(dirname(resolve(dataDirectory)), temporaryRoot);
    rmSync(dataDirectory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const send = body => fetch(`${base}/command?workspace=demo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { repo, base, send };
}

test('expected domain failures have an explicit safe type and conflict status', () => {
  assert.equal(typeof domain.DomainError, 'function');
  assert.throws(() => domain.fail('Geçersiz miktar.'), error => error instanceof domain.DomainError && error.status === 400);
  assert.throws(() => domain.fail('Güncel ekran gerekli.', { status: 409, code: 'REVISION_CONFLICT' }), error => error instanceof domain.DomainError && error.status === 409 && error.code === 'REVISION_CONFLICT');
});

test('unexpected and system failures return generic 500 and log only safe diagnostics', async t => {
  const logs = [], { repo, base } = await fixture(t, record => logs.push(record));
  for (const code of ['EACCES', 'SQLITE_BUSY', 'untrusted-private-code']) {
    repo.state = () => { throw Object.assign(new Error('audit-private-marker path and customer data'), { code }); };
    const response = await fetch(`${base}/state?workspace=demo`);
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /audit-private-marker|customer|path|untrusted-private/);
    assert.equal(logs.length, ['EACCES', 'SQLITE_BUSY', 'untrusted-private-code'].indexOf(code) + 1);
    const record = logs.at(-1);
    assert.equal(record.operation, 'state');
    assert.equal(record.workspace, 'demo');
    assert.doesNotMatch(JSON.stringify(record), /audit-private-marker|customer|path|untrusted-private/);
    assert.equal(record.code, code === 'untrusted-private-code' ? 'INTERNAL_ERROR' : code);
  }
});

test('logger failures cannot replace or interrupt the controlled server error response', async t => {
  const { repo, base } = await fixture(t, () => { throw new Error('logger-private-marker'); });
  repo.state = () => { throw new Error('request-private-marker'); };
  const response = await fetch(`${base}/state?workspace=demo`);
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /private-marker/);
});

test('same-ID retry after a committed but failed response never duplicates a command', async t => {
  const logs = [], { repo, send } = await fixture(t, record => logs.push(record));
  const execute = repo.execute.bind(repo);
  let interrupt = true;
  repo.execute = body => {
    const result = execute(body);
    if (interrupt) { interrupt = false; throw new Error('private-marker-after-commit'); }
    return result;
  };
  const envelope = { id: 'same-id-response-retry', revision: 0, command: opening() };
  const first = await send(envelope);
  assert.equal(first.status, 500, '5xx tells the existing UI to preserve its pending key');
  assert.doesNotMatch(await first.text(), /private-marker/);
  assert.equal(repo.events().length, 1);
  const retry = await send(envelope);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).duplicate, true);
  assert.equal(repo.events().length, 1);
  assert.equal(logs.length, 1);
});

test('malformed arrays, nulls and primitive maps remain 400 without recording events', async t => {
  const logs = [], { repo, send, base } = await fixture(t, record => logs.push(record));
  for (const command of [null, [], { ...opening(), balances: null }, { ...opening(), balances: [] }, { ...opening(), balances: true }, { ...opening(), balances: 1 }]) {
    const response = await send({ id: 'malformed-opening', revision: 0, command });
    assert.equal(response.status, 400);
    await response.text();
    assert.equal(repo.events().length, 0);
  }
  assert.equal((await send({ id: 'valid-opening', revision: 0, command: opening() })).status, 200);
  for (const counts of [null, [], true, 1]) {
    const response = await send({ id: 'malformed-count', revision: 1, command: { type: 'close', date: '2026-10-27', counts, reasons: {}, approvedBy: 'Test' } });
    assert.equal(response.status, 400);
    await response.text();
    assert.equal(repo.events().length, 1);
  }
  assert.equal((await fetch(`${base}/state?workspace=other`)).status, 400);
  assert.equal(logs.length, 0);
});

test('revision conflicts use explicit 409 rather than matching arbitrary message text', async t => {
  const { repo, send } = await fixture(t, () => {});
  repo.execute({ id: 'open-conflict', revision: 0, command: opening() });
  const stale = await send({ id: 'stale-conflict', revision: 0, command: { type: 'movement', date: '2026-10-27', accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '1', note: 'Test' } });
  assert.equal(stale.status, 409);
  repo.execute = () => domain.fail('Bu açıklama değişti fakat revizyon çatışması değildir.');
  const validation = await send({ id: 'message-not-status', revision: 1, command: {} });
  assert.equal(validation.status, 400);
});

test('response serialization failure is handled before sending successful headers', () => {
  const source = `
    import assert from 'node:assert/strict';
    import { createApp } from './server.mjs';
    import { authenticateTestOwner, ownerFetch as fetch } from './test-support/editor-session.mjs';
    import { mkdtempSync, rmSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const directory = mkdtempSync(join(tmpdir(), 'serialization-'));
    const { server, repositories } = createApp({ dataDirectory: directory, logger: () => {} });
    const circular = {}; circular.self = circular;
    repositories.set('demo', { state: () => circular, close() {} });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await authenticateTestOwner(server);
    try {
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/state?workspace=demo');
      assert.equal(response.status, 500);
      assert.doesNotMatch(await response.text(), /circular|self|TypeError/);
      console.log('controlled-serialization-error');
    } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); rmSync(directory, { recursive: true, force: true }); }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: projectDirectory, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /controlled-serialization-error/);
});
