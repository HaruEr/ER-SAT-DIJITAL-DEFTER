import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { IdentityStore, IdentityError } from '../identity.mjs';

const password = 'Sentetik mağaza parolası';
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'identity-'));
  let now = 10000000;
  const store = new IdentityStore(directory, { now: () => now });
  t.after(() => store.close());
  return { directory, store, advance: ms => { now += ms; } };
}
async function ownerSession(store) {
  const owner = await store.initializeOwner({ name: 'Sahip', password });
  return { owner, ...(await store.login(owner.id, password)) };
}

test('first owner wins once, also across concurrent connections and restart', async t => {
  const { store, directory } = fixture(t);
  const other = new IdentityStore(directory);
  t.after(() => other.close());
  assert.equal(store.needsSetup(), true);
  const attempts = await Promise.allSettled([store, other].map(s => s.initializeOwner({ name: 'Sahip', password })));
  assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(other.needsSetup(), false);
  await assert.rejects(other.initializeOwner({ name: 'Başka', password }), { name: 'IdentityError', status: 409 });
  assert.equal(store.listUsers().length, 1);
});

test('owner provisions employee with a stable id; secrets and roles are absent from selector', async t => {
  const { store, directory } = fixture(t);
  const { token, owner } = await ownerSession(store);
  const employee = await store.createEmployee(token, { name: 'Çalışan', password, role: 'owner' });
  assert.equal(employee.role, 'employee');
  assert.notEqual(owner.id, employee.id);
  assert.deepEqual(store.listUsers().map(u => Object.keys(u).sort()), [['id', 'name'], ['id', 'name']]);
  const signedIn = await store.login(employee.id, password);
  assert.deepEqual(store.session(signedIn.token), employee);
  await assert.rejects(store.createEmployee(signedIn.token, { name: 'Başka', password }));
  await assert.rejects(store.createEmployee('forged', { name: 'Başka', password }), error => error instanceof IdentityError && error.status === 403);
  assert.throws(() => store.disableUser(signedIn.token, owner.id));
  assert.throws(() => store.disableUser(token, owner.id));
  const db = new DatabaseSync(join(directory, 'identity.sqlite'), { readOnly: true });
  t.after(() => db.close());
  const rows = db.prepare('SELECT salt, verifier FROM identity_users').all();
  assert.equal(rows.length, 2);
  assert.notDeepEqual(rows[0].salt, rows[1].salt);
  assert.notDeepEqual(rows[0].verifier, rows[1].verifier);
  const bytes = readFileSync(join(directory, 'identity.sqlite'));
  for (const secret of [password, token, signedIn.token]) assert.equal(bytes.includes(Buffer.from(secret)), false);
});

test('logout, expiry, invalidation, disablement and restart revoke sessions', async t => {
  const { store, advance, directory } = fixture(t);
  const { token, owner, expiresAt } = await ownerSession(store);
  const employee = await store.createEmployee(token, { name: 'Çalışan', password });
  const a = await store.login(employee.id, password);
  const b = await store.login(employee.id, password);
  assert.notEqual(a.token, b.token);
  assert.equal(store.session(a.token + 'x'), null);
  store.logout(a.token);
  assert.equal(store.session(a.token), null);
  const secondStore = new IdentityStore(directory);
  t.after(() => secondStore.close());
  assert.equal(secondStore.session(b.token), null);
  store.disableUser(token, employee.id);
  assert.equal(store.session(b.token), null);
  assert.equal(await store.login(employee.id, password), null);
  assert.equal(store.listUsers().some(u => u.id === employee.id), false);
  advance(expiresAt - 10000000);
  assert.equal(store.session(token), null);
  const c = await store.login(owner.id, password);
  store.invalidateSessions();
  assert.equal(store.session(c.token), null);
});

test('failures are generic and repeated guessing is limited until the window lapses', async t => {
  const { store, advance } = fixture(t);
  const owner = await store.initializeOwner({ name: 'Sahip', password });
  assert.equal(await store.login('a38d735c-1448-4996-a528-dfeaef9146c2', password), null);
  for (let i = 0; i < 5; i++) assert.equal(await store.login(owner.id, 'incorrect'), null);
  assert.equal(await store.login(owner.id, password), null);
  advance(60001);
  assert.equal((await store.login(owner.id, password)).actor.id, owner.id);
});

test('invalid inputs never create an account or issue a token', async t => {
  const { store } = fixture(t);
  await assert.rejects(store.initializeOwner({ name: '', password }), { name: 'IdentityError', status: 400 });
  await assert.rejects(store.initializeOwner({ name: 'Sahip', password: 'short' }));
  await assert.rejects(store.initializeOwner({ name: 'Sahip', password: 'a'.repeat(1025) }));
  const { owner } = await ownerSession(store);
  for (const invalid of [null, {}, 'a'.repeat(1025)]) assert.equal(await store.login(owner.id, invalid), null);
  for (const invalid of [null, {}, 'x'.repeat(1000)]) assert.equal(store.session(invalid), null);
});

test('will not attach identity records to a financial or foreign SQLite database', t => {
  const directory = mkdtempSync(join(tmpdir(), 'identity-foreign-'));
  const db = new DatabaseSync(join(directory, 'identity.sqlite'));
  t.after(() => db.close());
  db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY)');
  assert.throws(() => new IdentityStore(directory));
  assert.deepEqual(db.prepare('SELECT name FROM sqlite_schema').all().map(r => r.name), ['events']);
});

test('active display names remain distinct in the selector under concurrent provisioning', async t => {
  const { store } = fixture(t);
  const { token } = await ownerSession(store);
  await assert.rejects(store.createEmployee(token, { name: ' SAHİP ', password }), { status: 409 });
  const attempts = await Promise.allSettled(['Çalışan', 'çalışan'].map(name => store.createEmployee(token, { name, password })));
  const created = attempts.filter(result => result.status === 'fulfilled');
  assert.equal(created.length, 1);
  assert.equal(attempts.find(result => result.status === 'rejected').reason.status, 409);
  store.disableUser(token, created[0].value.id);
  const replacement = await store.createEmployee(token, { name: 'Çalışan', password });
  assert.notEqual(replacement.id, created[0].value.id);
});

test('restore invalidates other editor connections and logins already computing their password hash', async t => {
  const { store, directory } = fixture(t);
  const { owner, token } = await ownerSession(store);
  const other = new IdentityStore(directory);
  t.after(()=>other.close());
  const session = await other.login(owner.id,password);
  const inFlight = other.login(owner.id,password);
  store.invalidateSessions();
  assert.equal(store.session(token),null);
  assert.equal(other.session(session.token),null);
  assert.equal(await inFlight,null);
  assert.deepEqual((await other.login(owner.id,password)).actor,owner);
});