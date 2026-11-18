/**
 * ER ŞAT DİJİTAL DEFTER — Ortak Kontrollü Taslak Deposu (Draft Store)
 *
 * Güvenlik ve Bütünlük İlkeleri:
 * 1. Yalnızca sessionStorage kullanılır (sekme/oturum ömrüyle sınırlı).
 * 2. Taslağın depodan okunması finansal geçerlilik veya gönderim izni sağlamaz.
 * 3. Hassas veriler (parola, token, auth, credential, gizli anahtar) kesinlikle ayıklanır.
 * 4. Sayım ve kasa kapanış taslakları yeni iş gününe taşınamaz (güncel fiili sayım zorunludur).
 * 5. Kullanıcı ve çalışma alanı izolasyonu anahtar seviyesinde garanti edilir.
 */
(root => {
  const SENSITIVE_KEY_REGEX = /pass|pwd|token|auth|secret|bearer|credential|(?:api|private)[-_]?key/i;
  let testStorageOverride = null;

  function getStorage() {
    if (testStorageOverride) return testStorageOverride;
    try {
      if (typeof sessionStorage !== 'undefined' && sessionStorage) return sessionStorage;
      if (typeof window !== 'undefined' && window.sessionStorage) return window.sessionStorage;
      if (typeof globalThis !== 'undefined' && globalThis.sessionStorage) return globalThis.sessionStorage;
    } catch {}
    return null;
  }

  function setStorageForTesting(storage) {
    testStorageOverride = storage;
  }

  function sanitizeKeyPart(val, fallback) {
    if (val === null || val === undefined || val === '') return fallback;
    return String(val).replace(/:/g, '_');
  }

  /**
   * Deterministik taslak anahtarı üretici.
   * Format: defter-draft:v1:${actorId}:${workspace}:${scope}:${type}${entityId ? ':' + entityId : ''}
   */
  function makeKey(optionsOrActorId, workspace, scope, type, entityId) {
    let opts = {};
    if (optionsOrActorId && typeof optionsOrActorId === 'object') {
      opts = optionsOrActorId;
    } else {
      opts = { actorId: optionsOrActorId, workspace, scope, type, entityId };
    }
    const a = sanitizeKeyPart(opts.actorId, 'anon');
    const w = sanitizeKeyPart(opts.workspace, 'default');
    const s = sanitizeKeyPart(opts.scope, 'general');
    const t = sanitizeKeyPart(opts.type || opts.formOrTaskType || opts.formId, 'default');
    const e = (opts.entityId !== undefined && opts.entityId !== null && opts.entityId !== '') ? `:${opts.entityId}` : '';
    return `defter-draft:v1:${a}:${w}:${s}:${t}${e}`;
  }

  /**
   * Ağ belirsizliği için bekleyen komut (pending) anahtarı üretici.
   */
  function makePendingKey(key) {
    if (typeof key === 'object' && key !== null) {
      key = makeKey(key);
    }
    const str = String(key || '');
    if (str.endsWith(':pending')) return str;
    return `${str}:pending`;
  }

  /**
   * Hassas verileri (parola, token, yetki sırları) özyinelemeli olarak filtreler.
   * Kullanıcının girdiği finansal miktar ve metinleri mutasyona uğratmadan korur.
   */
  function sanitizeData(input) {
    if (input === null || typeof input !== 'object') {
      return input;
    }
    if (Array.isArray(input)) {
      return input.map(item => sanitizeData(item));
    }
    const clean = {};
    for (const [k, v] of Object.entries(input)) {
      if (SENSITIVE_KEY_REGEX.test(k)) {
        continue;
      }
      if (v && typeof v === 'object' && typeof v.type === 'string' && v.type.toLowerCase() === 'password') {
        continue;
      }
      clean[k] = sanitizeData(v);
    }
    return clean;
  }

  /**
   * Taslak zarfını sessionStorage içine güvenle kaydeder.
   */
  function saveDraft(key, payload = {}) {
    const storage = getStorage();
    if (!storage || !key || typeof key !== 'string') return null;

    let rawMeta = payload.meta;
    let rawData = payload.data;

    // Düz nesne aktarıldıysa meta ve data alanlarını otomatik yapılandır
    if (!rawMeta && !rawData) {
      const {
        revision,
        date,
        workday,
        actorId,
        workspace,
        formId,
        entityId,
        entityType,
        policy,
        pendingCommandId,
        savedAt,
        ...rest
      } = payload;
      rawMeta = {
        revision,
        date: date || workday,
        workday: workday || date,
        actorId,
        workspace,
        formId,
        entityId,
        entityType,
        policy,
        pendingCommandId,
        savedAt
      };
      rawData = (rest.fields || rest.items || rest.allocations) ? rest : { fields: rest };
    }

    rawMeta = rawMeta || {};
    rawData = rawData || {};

    const keyParts = key.split(':');
    const keyActorId = keyParts[2] || 'anon';
    const keyWorkspace = keyParts[3] || 'default';
    const keyType = keyParts[5] || 'default';
    const keyEntityId = keyParts.length > 6 ? keyParts.slice(6).join(':') : null;

    const meta = {
      actorId: rawMeta.actorId !== undefined ? rawMeta.actorId : (keyActorId !== 'anon' ? keyActorId : null),
      workspace: rawMeta.workspace !== undefined ? rawMeta.workspace : (keyWorkspace !== 'default' ? keyWorkspace : null),
      workday: rawMeta.workday !== undefined ? rawMeta.workday : (rawMeta.date !== undefined ? rawMeta.date : null),
      revision: rawMeta.revision !== undefined ? rawMeta.revision : null,
      formId: rawMeta.formId !== undefined ? rawMeta.formId : (keyType !== 'default' ? keyType : null),
      entityId: rawMeta.entityId !== undefined ? rawMeta.entityId : keyEntityId,
      entityType: rawMeta.entityType !== undefined ? rawMeta.entityType : null,
      policy: rawMeta.policy !== undefined ? rawMeta.policy : 'default',
      pendingCommandId: rawMeta.pendingCommandId !== undefined ? rawMeta.pendingCommandId : null,
      savedAt: typeof rawMeta.savedAt === 'number' ? rawMeta.savedAt : Date.now()
    };

    const sanitizedData = sanitizeData({
      fields: rawData.fields || {},
      items: rawData.items || [],
      allocations: rawData.allocations || [],
      ...rawData
    });

    const sanitizedMeta = sanitizeData(meta);

    const envelope = {
      version: 1,
      key,
      meta: sanitizedMeta,
      data: sanitizedData
    };

    try {
      storage.setItem(key, JSON.stringify(envelope));
      return envelope;
    } catch (err) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('DefterDraftStore: Taslak kaydedilemedi (depo kotası veya izin hatası).', err);
      }
      return null;
    }
  }

  /**
   * Taslak zarfını sessionStorage içinden güvenle okur.
   */
  function getDraft(key) {
    const storage = getStorage();
    if (!storage || !key) return null;
    try {
      const raw = storage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      if (parsed.version !== 1 || !parsed.meta || !parsed.data) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Belirtilen taslağı depodan siler.
   */
  function clearDraft(key) {
    const storage = getStorage();
    if (!storage || !key) return false;
    try {
      storage.removeItem(key);
      storage.removeItem(makePendingKey(key));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Aktif kullanıcı oturumuna ait (veya belirtilmediyse tüm) taslakları temizler.
   */
  function clearSession(actorId) {
    const storage = getStorage();
    if (!storage) return 0;
    let count = 0;
    try {
      const keysToRemove = [];
      const cleanActor = actorId ? sanitizeKeyPart(actorId, '') : null;
      const draftPrefix = cleanActor ? `defter-draft:v1:${cleanActor}:` : 'defter-draft:v1:';
      const pendingPrefix = cleanActor ? `defter-pending:v1:${cleanActor}:` : 'defter-pending:';

      const total = storage.length || 0;
      for (let i = 0; i < total; i++) {
        const k = storage.key(i);
        if (!k) continue;
        if (k.startsWith(draftPrefix) || k.startsWith(pendingPrefix)) {
          keysToRemove.push(k);
        }
      }
      for (const k of keysToRemove) {
        storage.removeItem(k);
        count++;
      }
    } catch (err) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('DefterDraftStore: clearSession hatası.', err);
      }
    }
    return count;
  }

  /**
   * Belirtilen çalışma alanına ait tüm taslakları temizler.
   */
  function clearWorkspace(workspace) {
    const storage = getStorage();
    if (!storage || !workspace) return 0;
    const targetWorkspace = sanitizeKeyPart(workspace, '');
    let count = 0;
    try {
      const keysToRemove = [];
      const total = storage.length || 0;
      for (let i = 0; i < total; i++) {
        const k = storage.key(i);
        if (!k) continue;
        if (k.startsWith('defter-draft:v1:')) {
          const parts = k.split(':');
          if (parts[3] === targetWorkspace) {
            keysToRemove.push(k);
          }
        } else if (k.startsWith('defter-pending:v1:')) {
          const parts = k.split(':');
          if (parts[3] === targetWorkspace) {
            keysToRemove.push(k);
          }
        }
      }
      for (const k of keysToRemove) {
        storage.removeItem(k);
        count++;
      }
    } catch (err) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('DefterDraftStore: clearWorkspace hatası.', err);
      }
    }
    return count;
  }

  /**
   * Verilen filtrelere uyan taslak anahtarlarını listeler.
   */
  function listDrafts({ actorId, workspace, scope } = {}) {
    const storage = getStorage();
    if (!storage) return [];
    const results = [];
    const cleanActor = actorId ? sanitizeKeyPart(actorId, '') : null;
    const cleanWorkspace = workspace ? sanitizeKeyPart(workspace, '') : null;
    const cleanScope = scope ? sanitizeKeyPart(scope, '') : null;
    try {
      const total = storage.length || 0;
      for (let i = 0; i < total; i++) {
        const k = storage.key(i);
        if (!k || !k.startsWith('defter-draft:v1:')) continue;
        if (k.endsWith(':pending')) continue;

        const parts = k.split(':');
        const keyActor = parts[2];
        const keyWorkspace = parts[3];
        const keyScope = parts[4];

        if (cleanActor && keyActor !== cleanActor) continue;
        if (cleanWorkspace && keyWorkspace !== cleanWorkspace) continue;
        if (cleanScope && keyScope !== cleanScope) continue;

        results.push(k);
      }
    } catch {
      return [];
    }
    return results;
  }

  /**
   * Kartın veya hesabın devre dışı / kapatılmış olup olmadığını inceler.
   */
  function isEntityDisabled(entityId, liveState) {
    if (!entityId || !liveState) return false;
    if (liveState.disabledEntityIds) {
      if (typeof liveState.disabledEntityIds.has === 'function') {
        if (liveState.disabledEntityIds.has(entityId)) return true;
      } else if (Array.isArray(liveState.disabledEntityIds)) {
        if (liveState.disabledEntityIds.includes(entityId)) return true;
      }
    }

    const collections = [
      liveState.accounts,
      liveState.customers,
      liveState.suppliers,
      liveState.stocks,
      liveState.parties
    ];
    for (const col of collections) {
      if (!col) continue;
      let entity = null;
      if (Array.isArray(col)) {
        entity = col.find(item => item && (item.id === entityId || item.code === entityId));
      } else if (typeof col === 'object') {
        entity = col[entityId];
      }
      if (entity) {
        if (entity.retired === true || entity.active === false || entity.status === 'disabled') {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Taslak zarfını sunucu canlı durumu (liveState) ile karşılaştırarak doğrular.
   * Döndürür: { status: 'VALID' | 'STALE_REVISION' | 'STALE_WORKDAY' | 'DISABLED_ENTITY' | 'INVALID', reasons: [...] }
   */
  function validateDraft(draft, liveState, { isCountForm = false } = {}) {
    if (!draft || typeof draft !== 'object' || !draft.meta) {
      return { status: 'INVALID', reasons: ['Geçersiz veya eksik taslak zarfı.'] };
    }
    if (!liveState || typeof liveState !== 'object') {
      return { status: 'INVALID', reasons: ['Canlı sunucu durumu (state) bulunamadı.'] };
    }

    const reasons = [];
    const meta = draft.meta || {};

    // 1. Çalışma alanı uyumu
    if (meta.workspace && liveState.workspace && meta.workspace !== liveState.workspace) {
      return {
        status: 'INVALID',
        reasons: [`Taslak çalışma alanı (${meta.workspace}) ile mevcut oturum çalışma alanı (${liveState.workspace}) uyuşmuyor.`]
      };
    }

    // 2. Kullanıcı / Aktör uyumu
    const liveActorId = liveState.actorId || liveState.actor?.id;
    if (meta.actorId && liveActorId && meta.actorId !== liveActorId) {
      return {
        status: 'INVALID',
        reasons: [`Taslak sahibi (${meta.actorId}) ile aktif kullanıcı (${liveActorId}) uyuşmuyor.`]
      };
    }

    // 3. Fiziki Sayım / Kasa Kapanışı: Yeni iş gününe devredilemez
    const countForm = isCountForm === true || meta.formId === 'close-form' || meta.formId === 'stocktake-form';
    const workdayMismatch = meta.workday && liveState.date && meta.workday !== liveState.date;

    if (countForm && workdayMismatch) {
      return {
        status: 'STALE_WORKDAY',
        reasons: ['Fiziki sayım ve kasa kapanış taslakları yeni iş gününe devredilemez. Güncel fiili mevcutlarla yeniden sayım yapılmalıdır.']
      };
    }

    // 4. Bağlı Varlık / Kart durumu
    let entityDisabled = false;
    const fields = draft.data?.fields || {};
    const checkedIds = new Set();
    const collectEntityId = val => {
      if (typeof val !== 'string') return;
      const trimmed = val.trim();
      if (!trimmed || trimmed.startsWith('serial:') || trimmed.startsWith('item:')) return;
      checkedIds.add(trimmed);
    };
    for (const id of [
      meta.entityId,
      fields.counterpartyId,
      fields.customer,
      fields.supplierId,
      fields.stockId,
      fields.accountId,
      fields.customerAccount,
      fields.fromAccount,
      fields.toAccount,
      fields.fromAccountId,
      fields.toAccountId,
      fields.bankAccount,
      fields.target,
      fields.refundProduct,
      draft.data?.customer?.id
    ]) {
      collectEntityId(id);
    }
    const scanRowArray = rows => {
      if (!Array.isArray(rows)) return;
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        for (const key of ['accountId', 'selection', 'weightAccount', 'fromAccountId', 'toAccountId']) {
          collectEntityId(row[key]);
        }
        for (const pairKey of ['choice', 'source']) {
          if (typeof row[pairKey] === 'string' && row[pairKey].startsWith('[')) {
            try {
              const parsed = JSON.parse(row[pairKey]);
              if (Array.isArray(parsed) && parsed.length === 2) collectEntityId(parsed[1]);
            } catch {}
          }
        }
      }
    };
    const scanContainer = obj => {
      if (!obj || typeof obj !== 'object') return;
      for (const key of ['items', 'payment', 'counterpayment', 'debt', 'counterdebt', 'scrap', 'received', 'given', 'credits', 'debts', 'charges', 'allocations', 'targets', 'links', 'debtLinks', 'legacyUses']) {
        scanRowArray(obj[key]);
      }
    };
    scanContainer(draft.data);
    scanContainer(draft.data?.sale);
    scanContainer(draft.data?.rows);
    scanContainer(draft.data?.arrays);

    for (const targetEntityId of checkedIds) {
      if (isEntityDisabled(targetEntityId, liveState)) {
        entityDisabled = true;
        reasons.push(`Seçili kart (${targetEntityId}) kullanıma kapatılmış veya devre dışı bırakılmış.`);
        break;
      }
    }

    // 5. İş günü kontrolü (genel formlar)
    if (workdayMismatch) {
      reasons.push(`Taslak iş günü (${meta.workday}) güncel iş günü (${liveState.date}) ile uyuşmuyor.`);
    }

    // 6. Revizyon kontrolü
    let revisionMismatch = false;
    if (meta.revision !== null && meta.revision !== undefined && liveState.revision !== null && liveState.revision !== undefined) {
      if (Number(meta.revision) !== Number(liveState.revision)) {
        revisionMismatch = true;
        reasons.push(`Defter kayıt revizyonu güncel değil (Taslak: ${meta.revision}, Güncel: ${liveState.revision}). Bilgiler yeniden kontrol edilmelidir.`);
      }
    }

    if (reasons.length === 0) {
      return { status: 'VALID', reasons: [] };
    }

    if (entityDisabled) {
      return { status: 'DISABLED_ENTITY', reasons };
    }

    if (workdayMismatch) {
      return { status: 'STALE_WORKDAY', reasons };
    }

    if (revisionMismatch) {
      return { status: 'STALE_REVISION', reasons };
    }

    return { status: 'INVALID', reasons };
  }

  /**
   * Ağ belirsizliğinde idempotency UUID'sini ve komut zarfını koruyarak kaydeder.
   */
  function savePending(key, pendingEnvelope) {
    const storage = getStorage();
    if (!storage || !key) return null;
    if (pendingEnvelope === null || pendingEnvelope === undefined) {
      clearPending(key);
      return null;
    }
    if (typeof pendingEnvelope !== 'object') return null;
    const pKey = makePendingKey(key);
    const envelope = {
      version: 1,
      key: pKey,
      id: pendingEnvelope.id || pendingEnvelope.pendingCommandId || null,
      createdAt: pendingEnvelope.createdAt || Date.now(),
      ...pendingEnvelope
    };
    try {
      storage.setItem(pKey, JSON.stringify(envelope));
      return envelope;
    } catch (err) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('DefterDraftStore: Bekleyen istek kaydedilemedi.', err);
      }
      return null;
    }
  }

  /**
   * Bekleyen komut zarfını okur.
   */
  function getPending(key) {
    const storage = getStorage();
    if (!storage || !key) return null;
    const pKey = makePendingKey(key);
    try {
      const raw = storage.getItem(pKey);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * Bekleyen komut zarfını siler.
   */
  function clearPending(key) {
    const storage = getStorage();
    if (!storage || !key) return false;
    const pKey = makePendingKey(key);
    try {
      storage.removeItem(pKey);
      return true;
    } catch {
      return false;
    }
  }

  const storeObj = {
    makeKey,
    makePendingKey,
    saveDraft,
    getDraft,
    clearDraft,
    clearSession,
    clearWorkspace,
    listDrafts,
    validateDraft,
    savePending,
    getPending,
    clearPending,
    setStorageForTesting
  };

  root.DefterDraftStore = storeObj;
  if (typeof globalThis !== 'undefined') {
    globalThis.DefterDraftStore = storeObj;
  }
})(typeof window !== 'undefined' ? window : globalThis);
