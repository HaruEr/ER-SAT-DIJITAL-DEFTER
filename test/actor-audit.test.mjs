import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadStream, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { INITIAL_ACCOUNTS, currentCountPolicy, replay } from '../domain.mjs';
import { Repository } from '../repository.mjs';

const owner = { id: 'c8d7225e-5535-49ed-b37f-5f6d0e7d09ef', name: 'Deneme yönetici', role: 'owner' };
const other = { ...owner, id: '63d75b29-59de-4266-ad8a-ffefbb55df8c' };
function fixture(t) {
  const repo = new Repository(':memory:', 'demo');
  t.after(() => repo.close());
  const date = '2026-11-10';
  const balances = Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, '0']));
  repo.execute({ id: 'opening', revision: 0, command: { type: 'opening', date, balances } });
  return repo;
}

test('verified count approval survives replay while historical free text has no identity', t => {
  const repo = fixture(t);
  const command = { type: 'stocktake', date: repo.state().date, counts: { bilezik22: '0' }, approvedBy: 'Eski ad' };
  repo.execute({ id: 'old', revision: 1, command });
  assert.throws(() => repo.execute({ id: 'old', revision: 1, command }, { actor: owner }));
  const request = { id: 'new', revision: 2, command };
  repo.execute(request, { actor: owner });
  assert.equal(repo.execute(request, { actor: owner }).duplicate, true);
  assert.throws(() => repo.execute(request, { actor: { ...owner, role: 'employee' } }));
  assert.throws(() => repo.execute(request, { actor: other }));
  const counts = Object.fromEntries(repo.state().accounts.filter(a => a.physical && !a.retired && currentCountPolicy(a) === 'daily').map(a => [a.id, '0']));
  repo.execute({ id: 'close', revision: 3, command: { type: 'close', date: command.date, counts } }, { actor: owner });
  const state = replay(repo.backup().events);
  assert.equal(state.stocktakes[0].approvedBy, 'Eski ad');
  assert.equal(state.stocktakes[0].approvedById, undefined);
  assert.equal(state.stocktakes[1].approvedBy, owner.name);
  assert.equal(state.stocktakes[1].approvedById, owner.id);
  assert.equal(state.closings[0].approvedById, owner.id);
  assert.deepEqual(state.journal.at(-1).actor, owner);
  assert.equal(repo.events()[2].command.approvedBy, owner.name);
});

test('unsupported or malformed audit envelope fails replay', t => {
  const event = fixture(t).events()[0];
  for (const audit of [{ version: 2, actor: owner }, { version: 1, actor: { ...owner, id: '' } }, null]) {
    assert.throws(() => replay([{ ...event, audit }]));
  }
});

test('amendment attribution survives both backup formats and SQLite reopen', async t => {
  const root = mkdtempSync(join(tmpdir(), 'actor-roundtrip-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = fixture(t);
  const original = { type: 'movement', date: repo.state().date, accountId: 'nakit', direction: 'in', category: 'Sermaye', quantity: '1', note: 'Sentetik kayıt' };
  repo.execute({ id: 'move', revision: 1, command: original }, { actor: owner });
  repo.execute({ id: 'edit', revision: 2, command: { type: 'amend', date: original.date, originalId: 'move', replacement: { ...original, quantity: '2' }, note: 'Sentetik düzeltme' } }, { actor: other });
  const history = repo.state().journal;
  assert.deepEqual(history.slice(1).map(x => x.actor.id), [owner.id, other.id, other.id]);
  const archive = join(root, 'audit.ndjson');
  repo.exportArchive(archive);
  for (const format of ['json', 'ndjson']) {
    const file = join(root, format + '.sqlite');
    const target = new Repository(file, 'demo');
    try {
      const controls = { revision: 0, confirmation: 'GERİ YÜKLE' };
      if (format === 'json') target.restore({ ...controls, backup: repo.backup() });
      else await target.restoreArchive(createReadStream(archive), { ...controls, temporaryDirectory: root });
    } finally { target.close(); }
    const reopened = new Repository(file, 'demo');
    try { assert.deepEqual(reopened.state().journal, history); } finally { reopened.close(); }
  }
});

test('employee-created native customer accounts replay while forged privileged account events fail', async t => {
  const repo = fixture(t), actor = {...owner,role:'employee'};
  for (const unit of ['TL','USD','EUR','HAS','SILVER']) {
    const command={type:'account',date:repo.state().date,name:'Deneme '+unit,unit,partyType:'customer',opening:'0'};
    repo.execute({id:'worker-'+unit,revision:repo.state().revision,command},{actor});
    assert.equal(repo.state().balances['cari-worker-'+unit],0);
  }
  const events=repo.events();
  assert.deepEqual(replay(events).balances,repo.state().balances);
  for(const extra of [{opening:'1'},{opening:'-0.001',unit:'HAS'},{partyType:'supplier'},{parentAccountId:'cari-worker-TL'},{kind:'asset'},{approvedBy:'sahte'}]) {
    const forged=structuredClone(events);
    Object.assign(forged.at(-1).command,extra);
    assert.throws(()=>replay(forged));
  }
  const root=mkdtempSync(join(tmpdir(),'worker-customer-restore-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const archive=join(root,'customer.ndjson');
  repo.exportArchive(archive);
  for(const format of ['json','ndjson']){
    const target=new Repository(':memory:','demo');
    try{
      const controls={revision:0,confirmation:'GERİ YÜKLE'};
      if(format==='json') target.restore({...controls,backup:repo.backup()});
      else await target.restoreArchive(createReadStream(archive),{...controls,temporaryDirectory:root});
      assert.deepEqual(target.state().accounts,repo.state().accounts);
      assert.deepEqual(target.state().journal.at(-1).actor,actor);
    }finally{target.close();}
  }
});
