import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS, replay } from '../domain.mjs';

const date = '2026-10-28';
const opening = { type: 'opening', date, banks: [], balances: Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, '0'])) };
const fund = { type: 'fundAccount', date, name: 'Synthetic legacy HAS', unit: 'HAS', physical: false, opening: '1.125' };
function fixture(t) {
  const repo = new Repository(':memory:', 'manual-review');
  t.after(() => repo.close());
  repo.execute({ id: 'opening', revision: 0, command: opening });
  return repo;
}

test('new nonphysical HAS fund is rejected atomically while physical HAS, HAS party and currency banks remain valid', t => {
  const repo = fixture(t), before = repo.state(), events = repo.events();
  assert.throws(() => repo.execute({ id: 'new-has-bank', revision: before.revision, command: fund }), /Banka hesabında para birimi/);
  assert.deepEqual(repo.state(), before);
  assert.deepEqual(repo.events(), events);
  for (const [id, command] of [
    ['physical', { ...fund, physical: true }],
    ['tl-bank', { ...fund, name: 'Synthetic TL bank', unit: 'TL' }],
    ['usd-bank', { ...fund, name: 'Synthetic USD bank', unit: 'USD' }],
    ['party', { type: 'account', date, name: 'Synthetic supplier HAS', unit: 'HAS', opening: '-1.125', partyType: 'supplier' }]
  ]) repo.execute({ id, revision: repo.state().revision, command: { ...command, opening: command.unit === 'HAS' ? command.opening : '10.25' } });
  assert.equal(repo.state().balances['fund-physical'], 1125);
  assert.equal(repo.state().balances['fund-tl-bank'], 1025);
  assert.equal(repo.state().balances['fund-usd-bank'], 1025);
  assert.equal(repo.state().balances['cari-party'], -1125);
});

for (const schemaVersion of [3]) test(`historical v${schemaVersion} nonphysical HAS events retain replay, restore and duplicate retry semantics`, t => {
  const repo = fixture(t);
  const events = [...repo.events(), { id: 'old-has', schemaVersion, timestamp: '2026-10-28T09:00:00.000Z', command: fund }];
  assert.equal(replay(events).balances['fund-old-has'], 1125);
  const backup = { format: 'kuyumcu-defter-v1', workspace: 'manual-review', exportedAt: '2026-10-28T10:00:00.000Z', events, sha256: createHash('sha256').update(JSON.stringify(events)).digest('hex') };
  repo.restore({ backup, revision: repo.state().revision, confirmation: 'GERİ YÜKLE' });
  assert.deepEqual(repo.events(), events);
  assert.equal(repo.state().balances['fund-old-has'], 1125);
  const before = repo.state();
  assert.equal(repo.execute({ id: 'old-has', revision: 0, command: fund }).duplicate, true);
  assert.deepEqual(repo.state(), before);
  assert.deepEqual(repo.backup().events, events);
  assert.throws(() => repo.execute({ id: 'new-has', revision: before.revision, command: fund }), /Banka hesabında para birimi/);
  assert.deepEqual(repo.state(), before);
});
