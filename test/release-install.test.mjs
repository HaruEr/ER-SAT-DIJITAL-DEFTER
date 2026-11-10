import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createApp } from '../server.mjs';
import { authenticateTestOwner, ownerFetch } from '../test-support/editor-session.mjs';

test('fresh installation has no business records in either workspace and setup is one-time', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'release-empty-'));
  const { server: app } = createApp({ dataDirectory: directory });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}`;
  assert.deepEqual(await (await fetch(base + '/api/auth/users')).json(), {setup:true,users:[]});
  assert.equal((await fetch(base + '/api/state')).status, 401);
  await authenticateTestOwner(app);
  for (const workspace of ['demo','dukkan']) {
    const state = await (await ownerFetch(base + '/api/state?workspace=' + workspace)).json();
    assert.equal(state.revision, 0);
    assert.equal(state.initialized, false);
    assert.equal(state.journal.length, 0);
    assert.equal(state.accounts.filter(a => a.kind !== 'asset').length, 0);
    assert.ok(Object.values(state.balances).every(value => value === 0));
    for (const key of ['closings','stocktakes','inventoryItems','supplierFirms']) {
      if (state[key]) assert.equal(state[key].length, 0, key);
    }
  }
  const setup = await fetch(base + '/api/auth/setup', {method:'POST', headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Second',password:'No-second-owner-12345'})});
  assert.notEqual(setup.status, 201);
});

test('synthetic seed creates distinct directories and never initializes normal data', () => {
  const parent = mkdtempSync(join(tmpdir(), 'release-seed-'));
  const results = [];
  for (let n=0;n<2;n++) {
    const result = spawnSync(process.execPath, ['qa-temp/supplier-uat-seed.mjs'], {
      encoding:'utf8', windowsHide:true, env:{...process.env,TEMP:parent,TMP:parent,NODE_OPTIONS:'',JSDOM_MODULE_PATH:''}
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.ok(output.directory.startsWith(parent));
    assert.ok(output.password.length >= 24);
    results.push(output);
  }
  assert.notEqual(results[0].directory, results[1].directory);
  assert.notEqual(results[0].password, results[1].password);
  assert.equal(existsSync(join(parent, 'data')), false);
});
