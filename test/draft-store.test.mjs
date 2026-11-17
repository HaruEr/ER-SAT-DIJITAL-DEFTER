import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

const draftStoreSource = readFileSync(new URL('../public/draft-store.js', import.meta.url), 'utf8');
const accessClientSource = readFileSync(new URL('../public/access-client.js', import.meta.url), 'utf8');

function setupTestEnvironment(initialHtml = '<!doctype html><html lang="tr"><body></body></html>') {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('error', err => {
    if (err && String(err.message || err).includes('navigation')) return;
    console.error(err);
  });
  const dom = new JSDOM(initialHtml, {
    url: 'http://127.0.0.1:4317/',
    runScripts: 'outside-only',
    virtualConsole
  });
  dom.window.eval(draftStoreSource);
  dom.window.eval(accessClientSource);
  return {
    dom,
    window: dom.window,
    sessionStorage: dom.window.sessionStorage,
    store: dom.window.DefterDraftStore,
    session: dom.window.DefterSession
  };
}

// ============================================================================
// 1. Key generation formatting & component isolation
// ============================================================================

test('makeKey: formats deterministic key string with all components and handles defaults', () => {
  const { store } = setupTestEnvironment();

  // Full options object
  const key1 = store.makeKey({
    actorId: 'usr_owner',
    workspace: 'dukkan',
    scope: 'retail',
    type: 'sale-form',
    entityId: 'cust_123'
  });
  assert.equal(key1, 'defter-draft:v1:usr_owner:dukkan:retail:sale-form:cust_123');

  // Without entityId
  const key2 = store.makeKey({
    actorId: 'usr_emp',
    workspace: 'demo',
    scope: 'supplier',
    type: 'purchase'
  });
  assert.equal(key2, 'defter-draft:v1:usr_emp:demo:supplier:purchase');

  // Empty / undefined defaults
  const key3 = store.makeKey({});
  assert.equal(key3, 'defter-draft:v1:anon:default:general:default');

  // Positional arguments fallback
  const key4 = store.makeKey('usr_2', 'dukkan', 'checkout', 'sale', 'cust_456');
  assert.equal(key4, 'defter-draft:v1:usr_2:dukkan:checkout:sale:cust_456');

  // Pending key formatting
  const pendingKey = store.makePendingKey(key1);
  assert.equal(pendingKey, 'defter-draft:v1:usr_owner:dukkan:retail:sale-form:cust_123:pending');

  // Pending key idempotent
  assert.equal(store.makePendingKey(pendingKey), pendingKey);
});

test('makeKey: sanitizes delimiters to prevent cross-field collisions and injection', () => {
  const { store } = setupTestEnvironment();

  // Colons in actorId or workspace must be sanitized to underscores
  const keyA = store.makeKey({ actorId: 'usr:admin', workspace: 'dukkan', scope: 'retail', type: 'sale' });
  const keyB = store.makeKey({ actorId: 'usr', workspace: 'admin:dukkan', scope: 'retail', type: 'sale' });

  // Assert keys do not collide
  assert.notEqual(keyA, keyB, 'Delimiter injection must not cause cross-field key collision');
  assert.equal(keyA, 'defter-draft:v1:usr_admin:dukkan:retail:sale');
  assert.equal(keyB, 'defter-draft:v1:usr:admin_dukkan:retail:sale');

  // Multi-colon and scope/type delimiter sanitization
  const keyC = store.makeKey({ actorId: 'user:sub:team', workspace: 'shop:main', scope: 'a:b', type: 't:1' });
  assert.equal(keyC, 'defter-draft:v1:user_sub_team:shop_main:a_b:t_1');

  // Delimiter in actorId must not break clearWorkspace
  store.saveDraft(keyA, { data: { fields: { note: 'A' } } });
  store.saveDraft(keyB, { data: { fields: { note: 'B' } } });
  assert.ok(store.getDraft(keyA));
  assert.ok(store.getDraft(keyB));

  // Clearing 'dukkan' workspace must remove keyA and preserve keyB
  store.clearWorkspace('dukkan');
  assert.equal(store.getDraft(keyA), null, 'keyA in dukkan must be cleared');
  assert.ok(store.getDraft(keyB), 'keyB in admin_dukkan must remain');

  // Clearing 'admin:dukkan' must remove keyB via sanitized workspace matching
  store.clearWorkspace('admin:dukkan');
  assert.equal(store.getDraft(keyB), null, 'keyB must be cleared via sanitized workspace');
});

// ============================================================================
// 2. Draft save, retrieval, clear and user input preservation
// ============================================================================

test('saveDraft & getDraft: stores structured envelope and preserves exact user inputs', () => {
  const { store, sessionStorage } = setupTestEnvironment();

  const key = store.makeKey({
    actorId: 'usr_owner',
    workspace: 'dukkan',
    scope: 'retail',
    type: 'sale-form'
  });

  const payload = {
    meta: {
      actorId: 'usr_owner',
      workspace: 'dukkan',
      workday: '2026-11-17',
      revision: 42,
      formId: 'sale-form',
      entityId: 'cari-101',
      entityType: 'customer',
      policy: 'standard',
      pendingCommandId: null
    },
    data: {
      fields: {
        counterpartyId: 'cari-101',
        note: 'Özel sipariş bilezik',
        amountInput: '15420.75', // Exact user input string must be preserved
        quantityInput: '3,50'
      },
      items: [
        { rowId: 'row-1', stockId: 'stk-gold-22', weight: '14.250', unit: 'GRAM', priceTL: '45500.00' }
      ],
      allocations: [
        { type: 'CASH_TL', amount: '20000.00' },
        { type: 'TRANSFER_BANK', amount: '25500.00' }
      ]
    }
  };

  const saved = store.saveDraft(key, payload);
  assert.ok(saved, 'saveDraft must return saved envelope');
  assert.equal(saved.version, 1);
  assert.equal(saved.key, key);
  assert.equal(saved.meta.revision, 42);
  assert.equal(saved.meta.workday, '2026-11-17');
  assert.equal(typeof saved.meta.savedAt, 'number');

  // Verify stored in sessionStorage as JSON string
  const raw = sessionStorage.getItem(key);
  assert.ok(raw, 'Raw item must be in sessionStorage');
  assert.equal(JSON.parse(raw).version, 1);

  // Retrieve via getDraft
  const retrieved = store.getDraft(key);
  assert.ok(retrieved, 'Draft must be retrieved');
  assert.equal(retrieved.key, key);
  assert.equal(retrieved.meta.actorId, 'usr_owner');
  assert.equal(retrieved.data.fields.amountInput, '15420.75');
  assert.equal(retrieved.data.fields.quantityInput, '3,50');
  assert.equal(retrieved.data.items[0].weight, '14.250');
  assert.equal(retrieved.data.allocations.length, 2);

  // Non-existent key returns null
  assert.equal(store.getDraft('defter-draft:v1:non-existent'), null);

  // Corrupted JSON returns null safely
  sessionStorage.setItem('defter-draft:v1:corrupt', '{ invalid json ...');
  assert.equal(store.getDraft('defter-draft:v1:corrupt'), null);
});

test('saveDraft: preserves entity ID containing colons when deriving metadata from key', () => {
  const { store } = setupTestEnvironment();

  // Barcode / stock identifier containing colons (e.g. ALT:22:BZN)
  const key = store.makeKey({
    actorId: 'usr_1',
    workspace: 'dukkan',
    scope: 'stock',
    type: 'item-card',
    entityId: 'ALT:22:BZN'
  });
  assert.equal(key, 'defter-draft:v1:usr_1:dukkan:stock:item-card:ALT:22:BZN');

  // Save flat payload where entityId is omitted from meta, requiring derivation from key
  const saved = store.saveDraft(key, {
    fields: {
      barcode: 'ALT:22:BZN',
      description: '22 Ayar Bilezik'
    }
  });

  assert.ok(saved, 'Draft must be saved');
  assert.equal(saved.meta.entityId, 'ALT:22:BZN', 'Derived entityId must retain full value with colons without truncation');

  // Retrieve and verify
  const retrieved = store.getDraft(key);
  assert.ok(retrieved);
  assert.equal(retrieved.meta.entityId, 'ALT:22:BZN');

  // Multi-colon and complex entity IDs
  const complexKey = store.makeKey({
    actorId: 'usr_1',
    workspace: 'dukkan',
    scope: 'inventory',
    type: 'count',
    entityId: 'LOT:2026:Q4:0098:GOLD'
  });
  const savedComplex = store.saveDraft(complexKey, { fields: { counted: 10 } });
  assert.equal(savedComplex.meta.entityId, 'LOT:2026:Q4:0098:GOLD');
});

// ============================================================================
// 3. Sensitive data sanitization
// ============================================================================

test('saveDraft: strictly filters and strips passwords, tokens, auth secrets, and credentials', () => {
  const { store } = setupTestEnvironment();

  const key = store.makeKey({ actorId: 'usr_owner', workspace: 'dukkan', scope: 'retail', type: 'sale-form' });

  const dirtyPayload = {
    meta: {
      actorId: 'usr_owner',
      workspace: 'dukkan',
      workday: '2026-11-17',
      revision: 10,
      authToken: 'secret-token-xyz-12345',
      bearerToken: 'Bearer eyJhbGciOi...',
      client_secret: 'super-secret-shhh'
    },
    data: {
      fields: {
        counterpartyId: 'cari-101',
        note: 'Normal sipariş notu',
        password: 'PlainTextPassword123!',
        newPassword: 'MyNewPassword!',
        userPwd: 'pwd-value',
        token: 'token-abc',
        authorization: 'Bearer token-value',
        credentialData: 'admin-creds',
        passwordControl: { type: 'password', value: 'secret' },
        passwordControlUpper: { type: 'PASSWORD', value: 'UpperSecretValue!' },
        passwordControlMixed: { type: 'Password', value: 'MixedSecretValue!' },
        safeField: 'This field is preserved'
      },
      items: [
        {
          id: 'item-1',
          name: 'Bilezik',
          apiKey: 'secret-key-to-strip',
          authHeader: 'Basic dXNlcjpwYXNz'
        }
      ]
    }
  };

  const saved = store.saveDraft(key, dirtyPayload);
  assert.ok(saved);

  // Verify stripped from meta
  assert.equal(saved.meta.authToken, undefined, 'authToken in meta must be stripped');
  assert.equal(saved.meta.bearerToken, undefined, 'bearerToken in meta must be stripped');
  assert.equal(saved.meta.client_secret, undefined, 'client_secret in meta must be stripped');

  // Verify stripped from fields
  const fields = saved.data.fields;
  assert.equal(fields.password, undefined, 'password field must be stripped');
  assert.equal(fields.newPassword, undefined, 'newPassword field must be stripped');
  assert.equal(fields.userPwd, undefined, 'userPwd field must be stripped');
  assert.equal(fields.token, undefined, 'token field must be stripped');
  assert.equal(fields.authorization, undefined, 'authorization field must be stripped');
  assert.equal(fields.credentialData, undefined, 'credentialData field must be stripped');
  assert.equal(fields.passwordControl, undefined, 'passwordControl object must be stripped');
  assert.equal(fields.passwordControlUpper, undefined, 'passwordControlUpper object must be stripped');
  assert.equal(fields.passwordControlMixed, undefined, 'passwordControlMixed object must be stripped');

  // Safe fields must remain
  assert.equal(fields.counterpartyId, 'cari-101');
  assert.equal(fields.note, 'Normal sipariş notu');
  assert.equal(fields.safeField, 'This field is preserved');

  // Verify stripped from nested items
  const item = saved.data.items[0];
  assert.equal(item.name, 'Bilezik');
  assert.equal(item.apiKey, undefined, 'apiKey in items must be stripped');
  assert.equal(item.authHeader, undefined, 'authHeader in items must be stripped');

  // Verify stored JSON does not contain sensitive tokens anywhere
  const retrieved = store.getDraft(key);
  const jsonString = JSON.stringify(retrieved);
  assert.ok(!jsonString.includes('PlainTextPassword123!'));
  assert.ok(!jsonString.includes('secret-token-xyz'));
  assert.ok(!jsonString.includes('MyNewPassword!'));
  assert.ok(!jsonString.includes('super-secret-shhh'));
  assert.ok(!jsonString.includes('UpperSecretValue!'));
  assert.ok(!jsonString.includes('MixedSecretValue!'));
});

test('saveDraft: redacts password controls regardless of type attribute casing (mixed/uppercase)', () => {
  const { store } = setupTestEnvironment();

  const key = store.makeKey({ actorId: 'usr_emp', workspace: 'dukkan', scope: 'auth', type: 'login-draft' });
  const payload = {
    data: {
      fields: {
        safeLoginField: 'admin_user',
        ctrl1: { type: 'PASSWORD', value: 'SecretOne123!' },
        ctrl2: { type: 'Password', value: 'SecretTwo456!' },
        ctrl3: { type: 'PassWord', value: 'SecretThree789!' },
        ctrl4: { type: 'PASSWORD', placeholder: '***', raw: 'SecretFour000!' },
        textElement: { type: 'text', value: 'NormalVisibleValue' }
      }
    }
  };

  const saved = store.saveDraft(key, payload);
  assert.ok(saved);
  assert.equal(saved.data.fields.safeLoginField, 'admin_user');
  assert.equal(saved.data.fields.textElement.type, 'text');
  assert.equal(saved.data.fields.textElement.value, 'NormalVisibleValue');
  assert.equal(saved.data.fields.ctrl1, undefined, 'ctrl1 with type PASSWORD must be redacted');
  assert.equal(saved.data.fields.ctrl2, undefined, 'ctrl2 with type Password must be redacted');
  assert.equal(saved.data.fields.ctrl3, undefined, 'ctrl3 with type PassWord must be redacted');
  assert.equal(saved.data.fields.ctrl4, undefined, 'ctrl4 with type PASSWORD must be redacted');

  const json = JSON.stringify(store.getDraft(key));
  assert.ok(!json.includes('SecretOne123!'));
  assert.ok(!json.includes('SecretTwo456!'));
  assert.ok(!json.includes('SecretThree789!'));
  assert.ok(!json.includes('SecretFour000!'));
  assert.ok(json.includes('NormalVisibleValue'));
});

// ============================================================================
// 4. Draft clearing and listing
// ============================================================================

test('clearDraft and listDrafts: accurately enumerates and clears drafts', () => {
  const { store } = setupTestEnvironment();

  const key1 = store.makeKey({ actorId: 'usr_1', workspace: 'dukkan', scope: 'retail', type: 'sale' });
  const key2 = store.makeKey({ actorId: 'usr_1', workspace: 'dukkan', scope: 'supplier', type: 'purchase' });
  const key3 = store.makeKey({ actorId: 'usr_2', workspace: 'dukkan', scope: 'retail', type: 'sale' });
  const key4 = store.makeKey({ actorId: 'usr_1', workspace: 'demo', scope: 'retail', type: 'sale' });

  store.saveDraft(key1, { data: { fields: { val: '1' } } });
  store.saveDraft(key2, { data: { fields: { val: '2' } } });
  store.saveDraft(key3, { data: { fields: { val: '3' } } });
  store.saveDraft(key4, { data: { fields: { val: '4' } } });

  // List all
  const allDrafts = store.listDrafts();
  assert.equal(allDrafts.length, 4);

  // Filter by actorId
  const usr1Drafts = store.listDrafts({ actorId: 'usr_1' });
  assert.equal(usr1Drafts.length, 3);
  assert.ok(usr1Drafts.includes(key1));
  assert.ok(usr1Drafts.includes(key2));
  assert.ok(usr1Drafts.includes(key4));

  // Filter by workspace
  const demoDrafts = store.listDrafts({ workspace: 'demo' });
  assert.equal(demoDrafts.length, 1);
  assert.equal(demoDrafts[0], key4);

  // Filter by scope
  const supplierDrafts = store.listDrafts({ scope: 'supplier' });
  assert.equal(supplierDrafts.length, 1);
  assert.equal(supplierDrafts[0], key2);

  // Clear single draft
  assert.equal(store.clearDraft(key1), true);
  assert.equal(store.getDraft(key1), null);
  assert.equal(store.listDrafts({ actorId: 'usr_1' }).length, 2);
});

// ============================================================================
// 5. Multi-tenant and workspace isolation
// ============================================================================

test('Multi-tenant isolation: clearWorkspace and clearSession isolate user and tenant data', () => {
  const { store } = setupTestEnvironment();

  const dukkanOwnerKey = store.makeKey({ actorId: 'owner_1', workspace: 'dukkan', scope: 'retail', type: 'sale' });
  const dukkanEmployeeKey = store.makeKey({ actorId: 'emp_1', workspace: 'dukkan', scope: 'retail', type: 'sale' });
  const demoOwnerKey = store.makeKey({ actorId: 'owner_1', workspace: 'demo', scope: 'retail', type: 'sale' });

  store.saveDraft(dukkanOwnerKey, { data: { fields: { note: 'Dukkan Owner' } } });
  store.saveDraft(dukkanEmployeeKey, { data: { fields: { note: 'Dukkan Employee' } } });
  store.saveDraft(demoOwnerKey, { data: { fields: { note: 'Demo Owner' } } });

  // clearWorkspace('demo') should remove demo drafts but preserve dukkan drafts
  const clearedDemo = store.clearWorkspace('demo');
  assert.equal(clearedDemo, 1);
  assert.equal(store.getDraft(demoOwnerKey), null);
  assert.ok(store.getDraft(dukkanOwnerKey));
  assert.ok(store.getDraft(dukkanEmployeeKey));

  // clearSession('emp_1') should remove employee drafts but preserve owner drafts
  const clearedEmp = store.clearSession('emp_1');
  assert.equal(clearedEmp, 1);
  assert.equal(store.getDraft(dukkanEmployeeKey), null);
  assert.ok(store.getDraft(dukkanOwnerKey));

  // clearSession() without args should purge all remaining draft keys
  store.saveDraft(demoOwnerKey, { data: { fields: { note: 'Re-created' } } });
  assert.equal(store.listDrafts().length, 2);
  store.clearSession();
  assert.equal(store.listDrafts().length, 0);
});

// ============================================================================
// 6. Draft validity state machine (validateDraft)
// ============================================================================

test('validateDraft: verifies state matching and returns VALID status', () => {
  const { store } = setupTestEnvironment();

  const draft = {
    version: 1,
    key: 'defter-draft:v1:usr_1:dukkan:retail:sale',
    meta: {
      actorId: 'usr_1',
      workspace: 'dukkan',
      workday: '2026-11-17',
      revision: 100,
      formId: 'sale'
    },
    data: { fields: { amount: '1000' } }
  };

  const liveState = {
    actorId: 'usr_1',
    workspace: 'dukkan',
    date: '2026-11-17',
    revision: 100
  };

  const result = store.validateDraft(draft, liveState);
  assert.equal(result.status, 'VALID');
  assert.equal(result.reasons.length, 0);
});

test('validateDraft: detects revision mismatch and returns STALE_REVISION', () => {
  const { store } = setupTestEnvironment();

  const draft = {
    version: 1,
    meta: {
      actorId: 'usr_1',
      workspace: 'dukkan',
      workday: '2026-11-17',
      revision: 95
    },
    data: {}
  };

  const liveState = {
    actorId: 'usr_1',
    workspace: 'dukkan',
    date: '2026-11-17',
    revision: 100
  };

  const result = store.validateDraft(draft, liveState);
  assert.equal(result.status, 'STALE_REVISION');
  assert.ok(result.reasons.length > 0);
  assert.ok(result.reasons[0].includes('revizyon'));
});

test('validateDraft: detects workday rollover and returns STALE_WORKDAY', () => {
  const { store } = setupTestEnvironment();

  const draft = {
    version: 1,
    meta: {
      actorId: 'usr_1',
      workspace: 'dukkan',
      workday: '2026-11-16', // Yesterday
      revision: 100
    },
    data: {}
  };

  const liveState = {
    actorId: 'usr_1',
    workspace: 'dukkan',
    date: '2026-11-17', // Today
    revision: 100
  };

  const result = store.validateDraft(draft, liveState);
  assert.equal(result.status, 'STALE_WORKDAY');
  assert.ok(result.reasons.some(r => r.includes('iş günü')));
});

test('validateDraft: strictly rejects physical count rollover to new workday (isCountForm: true)', () => {
  const { store } = setupTestEnvironment();

  const countDraft = {
    version: 1,
    meta: {
      actorId: 'usr_1',
      workspace: 'dukkan',
      workday: '2026-11-16',
      revision: 100,
      formId: 'close-form'
    },
    data: {
      fields: { physicalCash: '50000.00', physicalGold: '1500.000' }
    }
  };

  const liveState = {
    actorId: 'usr_1',
    workspace: 'dukkan',
    date: '2026-11-17',
    revision: 100
  };

  // 1. With isCountForm = true
  const result1 = store.validateDraft(countDraft, liveState, { isCountForm: true });
  assert.equal(result1.status, 'STALE_WORKDAY');
  assert.ok(result1.reasons[0].includes('Fiziki sayım ve kasa kapanış taslakları yeni iş gününe devredilemez'));

  // 2. Automatically detected via formId 'stocktake-form'
  countDraft.meta.formId = 'stocktake-form';
  const result2 = store.validateDraft(countDraft, liveState);
  assert.equal(result2.status, 'STALE_WORKDAY');
  assert.ok(result2.reasons[0].includes('Fiziki sayım'));
});

test('validateDraft: detects disabled or retired counterparty entity and returns DISABLED_ENTITY', () => {
  const { store } = setupTestEnvironment();

  const draft = {
    version: 1,
    meta: {
      actorId: 'usr_1',
      workspace: 'dukkan',
      workday: '2026-11-17',
      revision: 100,
      entityId: 'cust_retired_1'
    },
    data: {
      fields: { counterpartyId: 'cust_retired_1' }
    }
  };

  const liveState = {
    actorId: 'usr_1',
    workspace: 'dukkan',
    date: '2026-11-17',
    revision: 100,
    customers: [
      { id: 'cust_active', name: 'Aktif Müşteri', retired: false },
      { id: 'cust_retired_1', name: 'Eski Müşteri', retired: true }
    ]
  };

  const result = store.validateDraft(draft, liveState);
  assert.equal(result.status, 'DISABLED_ENTITY');
  assert.ok(result.reasons.some(r => r.includes('kullanıma kapatılmış')));
});

test('validateDraft: detects workspace and actor mismatch and returns INVALID', () => {
  const { store } = setupTestEnvironment();

  const draft = {
    version: 1,
    meta: {
      actorId: 'usr_other',
      workspace: 'dukkan',
      workday: '2026-11-17',
      revision: 100
    },
    data: {}
  };

  const liveState = {
    actorId: 'usr_active',
    workspace: 'dukkan',
    date: '2026-11-17',
    revision: 100
  };

  const result = store.validateDraft(draft, liveState);
  assert.equal(result.status, 'INVALID');
  assert.ok(result.reasons[0].includes('Taslak sahibi'));
});

// ============================================================================
// 7. Pending command envelopes & idempotency UUID preservation
// ============================================================================

test('savePending, getPending, and clearPending: stores pending envelope preserving idempotency UUID', () => {
  const { store } = setupTestEnvironment();

  const key = store.makeKey({ actorId: 'usr_1', workspace: 'dukkan', scope: 'checkout', type: 'sale' });
  const pendingEnvelope = {
    id: 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6',
    command: 'retail_sale',
    revision: 55,
    payload: {
      items: [{ stockId: 'stk-1', qty: 1 }],
      allocations: [{ type: 'CASH', amount: 1000 }]
    }
  };

  const saved = store.savePending(key, pendingEnvelope);
  assert.ok(saved);
  assert.equal(saved.id, 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6');
  assert.equal(saved.command, 'retail_sale');

  // getPending retrieves identical envelope
  const retrieved = store.getPending(key);
  assert.ok(retrieved);
  assert.equal(retrieved.id, 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6');
  assert.equal(retrieved.revision, 55);

  // clearPending removes it
  assert.equal(store.clearPending(key), true);
  assert.equal(store.getPending(key), null);
});

test('savePending(key, null | undefined): defensively clears existing pending envelope and returns null', () => {
  const { store, sessionStorage } = setupTestEnvironment();

  const key = store.makeKey({ actorId: 'usr_1', workspace: 'dukkan', scope: 'checkout', type: 'trade' });
  const pKey = store.makePendingKey(key);

  store.savePending(key, { id: 'uuid-clear-null', command: 'sale', revision: 12 });
  assert.ok(store.getPending(key));
  assert.ok(sessionStorage.getItem(pKey));

  assert.equal(store.savePending(key, null), null);
  assert.equal(store.getPending(key), null, 'savePending(key, null) must clear stored pending envelope');
  assert.equal(sessionStorage.getItem(pKey), null, 'sessionStorage pending key must be removed on null');

  store.savePending(key, { id: 'uuid-clear-undef', command: 'sale', revision: 13 });
  assert.ok(store.getPending(key));

  assert.equal(store.savePending(key, undefined), null);
  assert.equal(store.getPending(key), null, 'savePending(key, undefined) must clear stored pending envelope');
  assert.equal(sessionStorage.getItem(pKey), null, 'sessionStorage pending key must be removed on undefined');
});

// ============================================================================
// 8. Session cleanup integration with access-client.js
// ============================================================================

test('access-client.js integration: clear() and lock() completely purge defter-draft:v1:* from sessionStorage', () => {
  const { store, session, sessionStorage } = setupTestEnvironment();

  // Populate various drafts
  const draftKey1 = store.makeKey({ actorId: 'usr_1', workspace: 'dukkan', scope: 'retail', type: 'sale-form' });
  const draftKey2 = store.makeKey({ actorId: 'usr_2', workspace: 'demo', scope: 'supplier', type: 'purchase' });
  const pendingKey = store.makeKey({ actorId: 'usr_1', workspace: 'dukkan', scope: 'checkout', type: 'sale' });

  store.saveDraft(draftKey1, { data: { fields: { a: '1' } } });
  store.saveDraft(draftKey2, { data: { fields: { b: '2' } } });
  store.savePending(pendingKey, { id: 'uuid-1234', command: 'test' });

  // Add standard session keys
  sessionStorage.setItem('defter-session', JSON.stringify({ actor: { id: 'usr_1' }, token: 'xyz' }));
  sessionStorage.setItem('defter-pending-sale-dukkan', '{"id":"old-pending"}');
  sessionStorage.setItem('unrelated-storage-key', 'keep-me');

  assert.ok(sessionStorage.getItem(draftKey1));
  assert.ok(sessionStorage.getItem(draftKey2));
  assert.ok(store.getPending(pendingKey));

  // Invoke DefterSession.clear()
  session.clear();

  // All defter-draft:v1:* and defter-pending:* keys must be purged
  assert.equal(sessionStorage.getItem(draftKey1), null);
  assert.equal(sessionStorage.getItem(draftKey2), null);
  assert.equal(store.getPending(pendingKey), null);
  assert.equal(sessionStorage.getItem('defter-pending-sale-dukkan'), null);
  assert.equal(sessionStorage.getItem('defter-session'), null);

  // Unrelated keys not starting with defter- draft/pending prefixes remain intact
  assert.equal(sessionStorage.getItem('unrelated-storage-key'), 'keep-me');
});

test('access-client.js lock(): invokes clear() and purges all drafts on screen lock', () => {
  const { dom, store, session, sessionStorage } = setupTestEnvironment();

  const draftKey = store.makeKey({ actorId: 'usr_owner', workspace: 'dukkan', scope: 'retail', type: 'sale' });
  store.saveDraft(draftKey, { data: { fields: { note: 'Draft before lock' } } });
  assert.ok(sessionStorage.getItem(draftKey));

  session.lock();

  // Screen lock must purge all drafts and hide document body
  assert.equal(sessionStorage.getItem(draftKey), null);
  assert.equal(dom.window.document.body.hidden, true);
});
