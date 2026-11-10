import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const sessions = new Map();
export async function authenticateTestOwner(server) {
  const { address, port } = server.address();
  assert.equal(address, '127.0.0.1');
  const origin = 'http://127.0.0.1:' + port;
  const password = randomUUID();
  const response = await globalThis.fetch(origin + '/api/auth/setup', {
    method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Sentetik yönetici', password })
  });
  assert.equal(response.status, 201, 'Synthetic owner setup must succeed.');
  const { token, actor } = await response.json();
  sessions.set(origin, { token, id:actor.id, password });
  server.once('close', () => sessions.delete(origin));
  return 'Bearer ' + token;
}
export async function renewTestOwner(base) {
  const origin = new URL(base).origin, saved = sessions.get(origin);
  assert.ok(saved, 'Initialize the synthetic editor owner first.');
  const response = await globalThis.fetch(origin + '/api/auth/login', {
    method:'POST', redirect:'error', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({id:saved.id, password:saved.password})
  });
  assert.equal(response.status,200);
  saved.token = (await response.json()).token;
}

export function ownerFetch(input, options = {}) {
  const token = sessions.get(new URL(input).origin)?.token;
  assert.ok(token, 'Initialize the synthetic editor session in this fixture.');
  return globalThis.fetch(input, { ...options, headers: { ...options.headers, Authorization: 'Bearer ' + token } });
}
