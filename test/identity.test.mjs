import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { IdentityStore, IdentityError } from '../identity.mjs';

const password = '482910';
const workerTempPin = '123456';
const workerNewPin = '654321';
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
  for (let i = 0; i < 5; i++) assert.equal(await store.login(owner.id, '999999'), null);
  assert.equal(await store.login(owner.id, password), null);
  advance(60001);
  assert.equal((await store.login(owner.id, password)).actor.id, owner.id);
});

test('invalid inputs never create an account or issue a token', async t => {
  const { store } = fixture(t);
  await assert.rejects(store.initializeOwner({ name: '', password }), { name: 'IdentityError', status: 400 });
  await assert.rejects(store.initializeOwner({ name: 'Sahip', password: '12345' }));
  await assert.rejects(store.initializeOwner({ name: 'Sahip', password: '1234567' }));
  await assert.rejects(store.initializeOwner({ name: 'Sahip', password: 'abcdef' }));
  await assert.rejects(store.initializeOwner({ name: 'Sahip', password: 'Sentetik mağaza parolası' }));
  const { owner } = await ownerSession(store);
  for (const invalid of [null, {}, '12345', 'abcdef', 'Sentetik mağaza parolası']) assert.equal(await store.login(owner.id, invalid), null);
  for (const invalid of [null, {}, 'x'.repeat(1000)]) assert.equal(store.session(invalid), null);
});

test('mandatory first-login PIN change, self-service changePin, and owner resetEmployeePin', async t => {
  const { store } = fixture(t);
  const { token: ownerToken, owner } = await ownerSession(store);
  assert.equal(owner.mustChangePin, false);

  const emp = await store.createEmployee(ownerToken, { name: 'Kasiyer', pin: workerTempPin });
  assert.equal(emp.mustChangePin, true);

  const empSession = await store.login(emp.id, workerTempPin);
  assert.equal(empSession.actor.mustChangePin, true);

  // Cannot reuse temporary PIN as new PIN
  await assert.rejects(store.changePin(empSession.token, { currentPin: workerTempPin, newPin: workerTempPin }), { status: 400 });
  // Wrong current PIN returns 401
  await assert.rejects(store.changePin(empSession.token, { currentPin: '000000', newPin: workerNewPin }), { status: 401 });

  // Valid PIN change clears mustChangePin
  const updated = await store.changePin(empSession.token, { currentPin: workerTempPin, newPin: workerNewPin });
  assert.equal(updated.mustChangePin, false);
  assert.equal(await store.login(emp.id, workerTempPin), null);
  const empSession2 = await store.login(emp.id, workerNewPin);
  assert.equal(empSession2.actor.mustChangePin, false);

  // Owner resets employee PIN -> revokes active employee sessions and sets mustChangePin = true
  await store.resetEmployeePin(ownerToken, { id: emp.id, newPin: '777888' });
  assert.equal(store.session(empSession.token), null);
  assert.equal(store.session(empSession2.token), null);
  assert.equal(await store.login(emp.id, workerNewPin), null);
  const afterReset = await store.login(emp.id, '777888');
  assert.equal(afterReset.actor.mustChangePin, true);

  // Owner changes own PIN with old PIN verification
  const ownerUpdated = await store.changePin(ownerToken, { currentPin: password, newPin: '334455' });
  assert.equal(ownerUpdated.role, 'owner');
  assert.equal(await store.login(owner.id, password), null);
  assert.equal((await store.login(owner.id, '334455')).actor.id, owner.id);
  // loginByName supports Turkish case-insensitive match and rejects unknown usernames
  assert.equal((await store.loginByName('  sahip ', '334455')).actor.id, owner.id);
  assert.equal(await store.loginByName('Bilinmeyen Kişi', '334455'), null);
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