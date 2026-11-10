import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Repository } from '../repository.mjs';
import { INITIAL_ACCOUNTS, decimal, replay } from '../domain.mjs';

function fixture(t, date = '2026-10-31') {
  const repo = new Repository(':memory:', 'demo'); t.after(() => repo.close());
  execute(repo, 'opening', { type: 'opening', date, balances: Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, a.id === 'pos' ? '1000' : '0'])) });
  return repo;
}
function execute(repo, id, command) { return repo.execute({ id, revision: repo.state().revision, command }); }
function closeCommand(repo, extra = {}) {
  const state = repo.state();
  return { type: 'close', date: state.date, counts: Object.fromEntries(state.accounts.filter(a => a.physical && !a.retired && a.countPolicy === 'daily').map(a => [a.id, decimal(state.balances[a.id] || 0, a.unit)])), reasons: {}, approvedBy: 'Synthetic count', ...extra };
}
function bank(repo, id, unit = 'TL', physical = false) {
  execute(repo, id, { type: 'fundAccount', date: repo.state().date, name: `Synthetic bank ${id}`, unit, physical, opening: '0' });
  return `fund-${id}`;
}
function settlement(repo, extra = {}) { return { type: 'settlement', date: repo.state().date, gross: '200', fee: '5', note: 'Synthetic bank settlement', ...extra }; }

test('closing accepts operator-chosen next business dates including Sunday and keeps default calendar increment', t => {
  const repo = fixture(t);
  execute(repo, 'open-sunday', closeCommand(repo, { nextDate: '2026-11-01' }));
  assert.equal(repo.state().date, '2026-11-01');
  execute(repo, 'skip-holiday', closeCommand(repo, { nextDate: '2026-11-04' }));
  assert.equal(repo.state().date, '2026-11-04');
  assert.equal(repo.state().closings.at(-1).nextDate, '2026-11-04');
  execute(repo, 'default-next', closeCommand(repo)); assert.equal(repo.state().date, '2026-11-05');
  assert.deepEqual(repo.events().map(e => e.schemaVersion), [3, 6, 6, 6]);
  assert.deepEqual(replay(repo.events()).balances, repo.state().balances);
});

test('invalid, same and past next dates reject the entire closing without changing counts or history', t => {
  const repo = fixture(t), before = repo.state();
  for (const nextDate of ['2026-10-31', '2026-10-30', '2026-02-30', '2026-11-31', '2026-1-1', '2026-11-01junk', '', null, 20261101, '2100-12-31']) {
    assert.throws(() => execute(repo, `invalid-${String(nextDate)}`, closeCommand(repo, { nextDate })), e => e.status === 400);
    assert.deepEqual(repo.state(), before);
  }
});

test('new closure uses v6 while legacy v3 and v4 next-date meanings remain unchanged', t => {
  const repo = fixture(t);
  execute(repo, 'close', closeCommand(repo, { nextDate: '2026-11-04' }));
  const events = repo.events();
  const legacyIds = new Set(INITIAL_ACCOUNTS.filter(a => a.physical && !a.retired && a.countPolicy === 'daily').map(a => a.id));
  const legacyClose = { ...events[1], schemaVersion: 3, command: { ...events[1].command, counts: Object.fromEntries(Object.entries(events[1].command.counts).filter(([id]) => legacyIds.has(id))) } };
  assert.equal(replay([events[0], legacyClose]).date, '2026-11-01', 'Old v3 ignored a stray nextDate property.');
  assert.equal(replay([events[0], { ...legacyClose, schemaVersion: 4 }]).date, '2026-11-04', 'Old v4 preserves explicit nextDate with its historical count set.');
  assert.throws(() => replay([{ ...events[0], schemaVersion: 4 }]), /sürüm/i, 'Unrelated command types must not silently claim v4 support.');
  assert.throws(() => replay([{ ...events[0], schemaVersion: 5 }]), /sürüm/i);
  assert.equal(events[0].schemaVersion, 3); assert.equal(events[1].schemaVersion, 6);
});

test('POS settles to the chosen existing nonphysical TL bank and linked reversal restores all original legs', t => {
  const repo = fixture(t), target = bank(repo, 'bank-two');
  const command = settlement(repo, { bankAccount: target });
  execute(repo, 'settle', command);
  let state = repo.state();
  assert.equal(state.balances.pos, 80000); assert.equal(state.balances[target], 19500); assert.equal(state.balances.banka, 0);
  assert.equal(state.journal.at(-1).meta.expense, 500); assert.equal(state.journal.at(-1).meta.bankAccount, target);
  assert.equal(repo.events().at(-1).schemaVersion, 4);
  const duplicate = execute(repo, 'settle', command); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.state.balances[target], 19500);
  execute(repo, 'reverse-settle', { type: 'reverse', date: state.date, originalId: 'settle', note: 'Synthetic cancellation' });
  state = repo.state(); assert.equal(state.balances.pos, 100000); assert.equal(state.balances[target], 0); assert.equal(state.journal.at(-1).meta.expense, -500);
});

test('POS default destination and old event replay remain Banka TL', t => {
  const repo = fixture(t), target = bank(repo, 'bank-two');
  execute(repo, 'default-settle', settlement(repo));
  assert.equal(repo.state().balances.banka, 19500); assert.equal(repo.events().at(-1).schemaVersion, 3);
  const events = repo.events(); events.at(-1).command.bankAccount = target;
  const state = replay(events); assert.equal(state.balances.banka, 19500); assert.equal(state.balances[target], 0);
});

test('ineligible destination, invalid commission and insufficient POS fail atomically', t => {
  const repo = fixture(t), usd = bank(repo, 'usd-bank', 'USD'), physical = bank(repo, 'cashbox', 'TL', true);
  execute(repo, 'customer', { type: 'account', date: repo.state().date, name: 'Synthetic customer', unit: 'TL', opening: '0' });
  const before = repo.state();
  for (const bankAccount of ['nakit', 'pos', 'missing', 'cari-customer', usd, physical, '', null, 42]) {
    assert.throws(() => execute(repo, `bad-bank-${String(bankAccount)}`, settlement(repo, { bankAccount })), e => e.status === 400);
    assert.deepEqual(repo.state(), before);
  }
  for (const extra of [{ gross: '1001' }, { fee: '201' }, { fee: '-1' }, { gross: '0' }]) {
    assert.throws(() => execute(repo, 'bad-amount', settlement(repo, { bankAccount: 'banka', ...extra })), e => e.status === 400);
    assert.deepEqual(repo.state(), before);
  }
});

test('new dated closing and chosen-bank events survive JSON backup and streamed archive restore', async t => {
  const repo = fixture(t), target = bank(repo, 'bank-two');
  execute(repo, 'settle', settlement(repo, { bankAccount: target })); execute(repo, 'close', closeCommand(repo, { nextDate: '2026-11-04' }));
  const expected = repo.state(), backup = repo.backup();
  assert.equal(expected.date, '2026-11-04'); assert.equal(expected.balances[target], 19500); assert.equal(expected.balances.banka, 0);
  const jsonTarget = new Repository(':memory:', 'demo'); t.after(() => jsonTarget.close());
  jsonTarget.restore({ backup, revision: 0, confirmation: 'GERİ YÜKLE' });
  assert.equal(jsonTarget.state().date, expected.date); assert.deepEqual(jsonTarget.state().balances, expected.balances);
  const root = resolve(tmpdir()), directory = mkdtempSync(join(root, 'defter-workday-bank-')), filename = join(directory, 'synthetic.ndjson');
  t.after(() => { assert.equal(dirname(resolve(directory)), root); rmSync(directory, { recursive: true, force: true }); });
  repo.exportArchive(filename);
  const archiveTarget = new Repository(':memory:', 'demo'); t.after(() => archiveTarget.close());
  const { createReadStream } = await import('node:fs');
  await archiveTarget.restoreArchive(createReadStream(filename), { revision: 0, confirmation: 'GERİ YÜKLE', temporaryDirectory: directory });
  assert.equal(archiveTarget.state().date, expected.date); assert.deepEqual(archiveTarget.state().balances, expected.balances);
});
