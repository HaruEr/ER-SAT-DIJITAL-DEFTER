import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, win32 as win32Path } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const passwordOptions = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const identityApplicationId = 1163086153;
const attemptWindow = 60_000;
const ATTEMPT_RETENTION_MS = 24 * 60 * 60_000;
const sessionLifetime = 8 * 60 * 60_000;
const invalidSession = 'Bu işlem için geçerli işletme sahibi oturumu gerekli.';
const tokenDigest = token => createHash('sha256').update(token).digest('hex');
const validToken = token => typeof token === 'string' && token.length === 43 && /^[A-Za-z0-9_-]+$/.test(token);
const validPin = pin => typeof pin === 'string' && /^\d{6}$/.test(pin);
const readPin = input => input?.pin ?? input?.password;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AUDIT_FORBIDDEN_KEY_RE = /pin|password|token|salt|verifier|passphrase|secret|auth|amount|price|balance|gram|has|tl|usd|eur|iban|account|ledger|journal/i;

function lockoutDurationMs(attempts) {
  if (attempts >= 15) return 15 * 60_000;
  if (attempts >= 10) return 5 * 60_000;
  if (attempts >= 5) return 60_000;
  return 0;
}

function normalizeClientKey(clientKey) {
  if (typeof clientKey !== 'string') return null;
  const trimmed = clientKey.trim().normalize('NFC');
  if (!trimmed) return null;
  const canonical = trimmed.toLocaleLowerCase('en');
  if (canonical.length > 128 || /[\u0000-\u001f\u007f]/u.test(canonical)) {
    return `client:sha256:${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}`;
  }
  return `client:${canonical}`;
}

function sanitizeSourceKey(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().normalize('NFC');
  if (!trimmed) return null;
  if (trimmed.length > 128 || /[\u0000-\u001f\u007f]/u.test(trimmed)) {
    return `sha256:${createHash('sha256').update(trimmed).digest('hex').slice(0, 32)}`;
  }
  return trimmed;
}

export function sanitizeAuditDetail(detail) {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null;
  const clean = Object.create(null);
  let hasEntries = false;
  let truncated = false;
  for (const [key, value] of Object.entries(detail)) {
    if (AUDIT_FORBIDDEN_KEY_RE.test(key)) continue;
    let sanitized;
    if (typeof value === 'boolean') {
      sanitized = value;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      sanitized = value;
    } else if (typeof value === 'string') {
      const stripped = value.replace(/[\u0000-\u001f\u007f]/gu, '').trim();
      if (!stripped) continue;
      sanitized = /^\d{6}$/.test(stripped) ? '[redacted]' : stripped.slice(0, 128);
    } else {
      continue;
    }
    hasEntries = true;
    const candidate = Object.assign(Object.create(null), clean);
    Object.defineProperty(candidate, key, { value: sanitized, enumerable: true, writable: true, configurable: true });
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > 1024) {
      truncated = true;
      break;
    }
    Object.defineProperty(clean, key, { value: sanitized, enumerable: true, writable: true, configurable: true });
  }
  if (!hasEntries) return null;
  if (truncated) {
    const keys = Object.keys(clean);
    while (keys.length > 0) {
      const withFlag = Object.assign(Object.create(null), clean, { truncated: true });
      const withFlagJson = JSON.stringify(withFlag);
      if (Buffer.byteLength(withFlagJson, 'utf8') <= 1024) return withFlagJson;
      delete clean[keys.pop()];
    }
    return '{"truncated":true}';
  }
  const json = JSON.stringify(clean);
  return Buffer.byteLength(json, 'utf8') <= 1024 ? json : '{"truncated":true}';
}

const BACKUP_WIN32_ILLEGAL_CHAR_RE = /[\x00-\x1f\x7f\\/:*?"<>|]/;
const BACKUP_CONTROL_OR_BIDI_RE = /[\u0080-\u009f\u202a-\u202e\u2066-\u2069]/;
const BACKUP_WINDOWS_RESERVED_STEM_RE = /^(?:con|prn|aux|nul|com[0-9\u00B2\u00B3\u00B9]|lpt[0-9\u00B2\u00B3\u00B9]|conin\$|conout\$)$/i;
const BACKUP_WIN32_DEVICE_NAMESPACE_RE = /^[\\/]{2}[?.](?:[\\/]|$)/;
const BACKUP_WIN32_DRIVE_ROOT_RE = /^[A-Za-z]:[\\/]?$/;

function isUnsafeBackupWin32Segment(segment, { allowDotNavigation = false } = {}) {
  if (!segment) return false;
  if (segment === '.' || segment === '..') return !allowDotNavigation;
  if (segment !== segment.trim()) return true;
  if (segment.endsWith('.')) return true;
  if (BACKUP_WIN32_ILLEGAL_CHAR_RE.test(segment)) return true;
  if (BACKUP_CONTROL_OR_BIDI_RE.test(segment)) return true;
  const cut = segment.search(/[.:]/);
  const stem = (cut === -1 ? segment : segment.slice(0, cut)).replace(/[\s.]+$/u, '');
  return BACKUP_WINDOWS_RESERVED_STEM_RE.test(stem);
}

function validateBackupPathTree(pathValue, { allowDotNavigation }) {
  if (BACKUP_WIN32_DEVICE_NAMESPACE_RE.test(pathValue)) {
    throw Object.assign(new Error('Yedek hedef dosyası Win32 aygıt ad alanı içeremez.'), { code: 'INVALID_PATH' });
  }
  const { root } = win32Path.parse(pathValue);
  if (root) {
    if (BACKUP_WIN32_DEVICE_NAMESPACE_RE.test(root)) {
      throw Object.assign(new Error('Yedek hedef dosyası Win32 aygıt ad alanı içeremez.'), { code: 'INVALID_PATH' });
    }
    const isSlashRoot = root === '/' || root === '\\';
    const isDriveRoot = BACKUP_WIN32_DRIVE_ROOT_RE.test(root);
    if (!isSlashRoot && !isDriveRoot) {
      if (!/^(?:\\\\|\/\/)/.test(root)) {
        throw Object.assign(new Error('Yedek hedef dosyası geçersiz bir kök yolu içeriyor.'), { code: 'INVALID_PATH' });
      }
      const uncParts = root.replace(/^[\\/]{2}/, '').split(/[\\/]+/).filter(Boolean);
      if (uncParts.length !== 2 || uncParts.some(part => isUnsafeBackupWin32Segment(part, { allowDotNavigation: false }))) {
        throw Object.assign(new Error('Yedek hedef dosyası geçersiz bir UNC kök yolu içeriyor.'), { code: 'INVALID_PATH' });
      }
    }
  }
  const remainder = pathValue.slice(root.length);
  for (const segment of remainder.split(/[\\/]+/)) {
    if (!segment) continue;
    if (isUnsafeBackupWin32Segment(segment, { allowDotNavigation })) {
      throw Object.assign(new Error('Yedek hedef dosyası geçersiz veya Windows ayrılmış yol bölümü içeriyor.'), { code: 'INVALID_PATH' });
    }
  }
}

function assertSafeBackupTargetPath(targetFile) {
  if (
    typeof targetFile !== 'string' ||
    !targetFile.trim() ||
    targetFile.includes('\0') ||
    targetFile !== targetFile.trim() ||
    targetFile === ':memory:'
  ) {
    throw Object.assign(new Error('Geçerli bir yedek hedef dosya yolu gerekli.'), { code: 'INVALID_PATH' });
  }
  const resolvedTarget = resolve(targetFile);
  if (!resolvedTarget.trim() || resolvedTarget.includes('\0') || resolvedTarget !== resolvedTarget.trim()) {
    throw Object.assign(new Error('Geçerli bir yedek hedef dosya yolu gerekli.'), { code: 'INVALID_PATH' });
  }
  validateBackupPathTree(targetFile, { allowDotNavigation: true });
  validateBackupPathTree(resolvedTarget, { allowDotNavigation: false });
  return resolvedTarget;
}

export class IdentityError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'IdentityError';
    this.status = status;
  }
}

const displayKey = name => name.toLocaleLowerCase('tr').normalize('NFC');
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
const isSqliteBusyError = error =>
  error?.code === 'ERR_SQLITE_ERROR' &&
  ((Number.isInteger(error?.errcode) && (error.errcode & 0xff) === 5) ||
    /database is locked|SQLITE_BUSY/i.test(error?.message || ''));

function actor(row, extra = null) {
  const base = { id: row.id, name: row.name, role: row.role, mustChangePin: Boolean(row.must_change_pin) };
  if (extra?.viaMasterPin) {
    base.mustChangePin = false;
    base.viaMasterPin = true;
    base.masterActorId = extra.masterActorId;
  }
  return base;
}

const AUTH_AUDIT_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS auth_audit_log (
    id INTEGER PRIMARY KEY,
    created_at INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    actor_id TEXT,
    actor_role TEXT CHECK(actor_role IS NULL OR actor_role IN ('owner', 'employee', 'system')),
    target_id TEXT,
    source_key TEXT,
    outcome TEXT NOT NULL CHECK(outcome IN ('success', 'failure', 'locked')),
    via_master_pin INTEGER NOT NULL DEFAULT 0 CHECK(via_master_pin IN (0, 1)),
    master_actor_id TEXT,
    detail_json TEXT
  ) STRICT;
  CREATE INDEX IF NOT EXISTS idx_auth_audit_created_at ON auth_audit_log(created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_auth_audit_event_type ON auth_audit_log(event_type, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_auth_audit_actor_id ON auth_audit_log(actor_id, created_at DESC, id DESC);
`;

// A separate database holds credentials. The session map belongs to one running editor.
export class IdentityStore {
  #db;
  #now;
  #allowMasterFallback;
  #closed = false;
  #sessions = new Map();
  #epoch = 0;
  #hashes = 0;
  #dummySalt = randomBytes(16);
  #dummyVerifier = randomBytes(32);

  constructor(directory, { now = Date.now, allowMasterFallback = true } = {}) {
    this.#now = now;
    this.#allowMasterFallback = Boolean(allowMasterFallback);
    this.#db = new DatabaseSync(join(directory, 'identity.sqlite'), { timeout: 5000 });
    try {
      this.#db.exec('PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF;');

      this.#db.exec('BEGIN');
      let hasInitialSchema, initialAppId, initialUserVersion, initialJournalMode;
      try {
        hasInitialSchema = Boolean(this.#db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get());
        ({ application_id: initialAppId } = this.#db.prepare('PRAGMA application_id').get());
        ({ user_version: initialUserVersion } = this.#db.prepare('PRAGMA user_version').get());
        ({ journal_mode: initialJournalMode } = this.#db.prepare('PRAGMA journal_mode').get());
      } finally {
        if (this.#db.isTransaction) {
          this.#db.exec('ROLLBACK');
        }
      }

      if (
        !(initialAppId === 0 && initialUserVersion === 0 && !hasInitialSchema) &&
        !(initialAppId === identityApplicationId && [1, 2, 3, 4].includes(initialUserVersion))
      ) {
        throw new Error('Desteklenmeyen kimlik veritabanı.');
      }

      const lockDeadline = Date.now() + 5000;
      if (String(initialJournalMode).toLowerCase() !== 'wal') {
        let lastBusyError = null;
        while (true) {
          try {
            const currentMode = this.#db.prepare('PRAGMA journal_mode').get()?.journal_mode;
            if (String(currentMode).toLowerCase() === 'wal') break;
            const nextMode = this.#db.prepare('PRAGMA journal_mode = WAL').get()?.journal_mode;
            if (String(nextMode).toLowerCase() === 'wal') break;
          } catch (error) {
            if (!isSqliteBusyError(error) || Date.now() >= lockDeadline) throw error;
            lastBusyError = error;
          }
          if (Date.now() >= lockDeadline) {
            throw lastBusyError ?? new Error('Kimlik veritabanı WAL moduna geçirilemedi.');
          }
          Atomics.wait(sleepBuffer, 0, 0, 5 + Math.floor(Math.random() * 20));
        }
      }

      this.#db.exec('PRAGMA synchronous = FULL;');

      while (true) {
        try {
          this.#db.exec('BEGIN IMMEDIATE');
          break;
        } catch (error) {
          if (!isSqliteBusyError(error) || Date.now() >= lockDeadline) throw error;
          Atomics.wait(sleepBuffer, 0, 0, 5 + Math.floor(Math.random() * 20));
        }
      }
      const { application_id } = this.#db.prepare('PRAGMA application_id').get();
      const { user_version } = this.#db.prepare('PRAGMA user_version').get();
      if (application_id === 0 && user_version === 0 && !this.#db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get()) {
        this.#db.exec(`
          CREATE TABLE identity_users (
            id TEXT PRIMARY KEY NOT NULL,
            name TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('owner', 'employee')),
            enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
            must_change_pin INTEGER NOT NULL DEFAULT 0 CHECK(must_change_pin IN (0, 1)),
            salt BLOB NOT NULL CHECK(length(salt) = 16),
            verifier BLOB NOT NULL CHECK(length(verifier) = 32)
          ) STRICT;
          CREATE TABLE login_limits (
            bucket TEXT PRIMARY KEY NOT NULL,
            until_ms INTEGER NOT NULL,
            attempts INTEGER NOT NULL,
            last_attempt_ms INTEGER
          ) STRICT;
          CREATE TABLE session_generation (id INTEGER PRIMARY KEY CHECK(id = 1), generation TEXT NOT NULL) STRICT;
          ${AUTH_AUDIT_TABLE_SQL}
          PRAGMA application_id = ${identityApplicationId};
          PRAGMA user_version = 4;
        `);
        this.#db.prepare('INSERT INTO session_generation VALUES(1, ?)').run(randomUUID());
      } else if (application_id !== identityApplicationId || ![1, 2, 3, 4].includes(user_version)) {
        throw new Error('Desteklenmeyen kimlik veritabanı.');
      } else {
        if (user_version < 2) {
          this.#db.exec('CREATE TABLE session_generation (id INTEGER PRIMARY KEY CHECK(id = 1), generation TEXT NOT NULL) STRICT');
          this.#db.prepare('INSERT INTO session_generation VALUES(1, ?)').run(randomUUID());
          this.#db.exec('PRAGMA user_version = 2');
        }
        if (user_version < 3) {
          this.#db.exec('ALTER TABLE identity_users ADD COLUMN must_change_pin INTEGER NOT NULL DEFAULT 0 CHECK(must_change_pin IN (0, 1))');
          this.#db.exec('PRAGMA user_version = 3');
        }
        if (user_version < 4) {
          const limitCols = this.#db.prepare('PRAGMA table_info(login_limits)').all();
          if (!limitCols.some(col => col.name === 'last_attempt_ms')) {
            this.#db.exec('ALTER TABLE login_limits ADD COLUMN last_attempt_ms INTEGER');
          }
          this.#db.exec(AUTH_AUDIT_TABLE_SQL);
          this.#db.exec('PRAGMA user_version = 4');
        }
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      if (this.#db.isTransaction) {
        try { this.#db.exec('ROLLBACK'); } catch {}
      }
      this.#closed = true;
      this.#db.close();
      throw error;
    }
  }

  createConsistentBackup(targetFile) {
    const resolvedTarget = assertSafeBackupTargetPath(targetFile);
    let targetExists = existsSync(resolvedTarget);
    if (!targetExists) {
      try {
        lstatSync(resolvedTarget);
        targetExists = true;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    if (targetExists) {
      throw Object.assign(new Error(`Yedek hedef dosyası zaten mevcut: ${resolvedTarget}`), { code: 'EEXIST' });
    }
    mkdirSync(dirname(resolvedTarget), { recursive: true });
    this.#db.prepare('VACUUM INTO ?').run(resolvedTarget);
    if (!existsSync(resolvedTarget)) {
      throw new Error('Tutarlı yedek dosyası oluşturulamadı.');
    }
    const sizeBytes = statSync(resolvedTarget).size;
    if (sizeBytes <= 0) {
      throw new Error('Oluşturulan yedek dosyası boş.');
    }
    return { filename: resolvedTarget, sizeBytes, method: 'VACUUM INTO' };
  }

  close() {
    this.#closed = true;
    this.#sessions.clear();
    this.#epoch++;
    this.#db.close();
  }

  needsSetup() {
    return !this.#db.prepare('SELECT 1 FROM identity_users LIMIT 1').get();
  }

  listUsers() {
    return this.#db.prepare('SELECT id, name FROM identity_users WHERE enabled = 1 ORDER BY name, id').all()
      .map(({ id, name }) => ({ id, name }));
  }

  #recordAudit({
    eventType,
    actorId = null,
    actorRole = null,
    targetId = null,
    sourceKey = null,
    outcome = 'success',
    viaMasterPin = false,
    masterActorId = null,
    detail = null,
    now = this.#now()
  }) {
    if (this.#closed) return;
    this.#db.prepare(`
      INSERT INTO auth_audit_log (
        created_at, event_type, actor_id, actor_role, target_id,
        source_key, outcome, via_master_pin, master_actor_id, detail_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      Math.trunc(now),
      eventType,
      actorId,
      actorRole,
      targetId,
      sanitizeSourceKey(sourceKey),
      outcome,
      viaMasterPin ? 1 : 0,
      masterActorId,
      sanitizeAuditDetail(detail)
    );
  }

  listAuthAudit({ limit = 100, offset = 0, eventType = null } = {}) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new IdentityError('Geçersiz denetim sınırı.', 400);
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new IdentityError('Geçersiz denetim başlangıcı.', 400);
    }
    let normalizedEventType = null;
    if (eventType !== null && eventType !== undefined) {
      if (typeof eventType !== 'string') {
        throw new IdentityError('Geçersiz olay türü filtresi.', 400);
      }
      const trimmed = eventType.trim();
      if (trimmed) {
        if (!/^[a-z0-9_:-]{1,64}$/i.test(trimmed)) {
          throw new IdentityError('Geçersiz olay türü filtresi.', 400);
        }
        normalizedEventType = trimmed;
      }
    }
    const cappedLimit = Math.min(500, limit);
    const total = normalizedEventType
      ? this.#db.prepare('SELECT COUNT(*) AS total FROM auth_audit_log WHERE event_type = ?').get(normalizedEventType).total
      : this.#db.prepare('SELECT COUNT(*) AS total FROM auth_audit_log').get().total;
    const rows = normalizedEventType
      ? this.#db.prepare(`
          SELECT id, created_at, event_type, actor_id, actor_role, target_id,
                 source_key, outcome, via_master_pin, master_actor_id, detail_json
          FROM auth_audit_log
          WHERE event_type = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ? OFFSET ?
        `).all(normalizedEventType, cappedLimit, offset)
      : this.#db.prepare(`
          SELECT id, created_at, event_type, actor_id, actor_role, target_id,
                 source_key, outcome, via_master_pin, master_actor_id, detail_json
          FROM auth_audit_log
          ORDER BY created_at DESC, id DESC
          LIMIT ? OFFSET ?
        `).all(cappedLimit, offset);
    const entries = rows.map(row => ({
      id: row.id,
      createdAt: row.created_at,
      eventType: row.event_type,
      actorId: row.actor_id,
      actorRole: row.actor_role,
      targetId: row.target_id,
      sourceKey: row.source_key,
      outcome: row.outcome,
      viaMasterPin: Boolean(row.via_master_pin),
      masterActorId: row.master_actor_id,
      detail: row.detail_json ? JSON.parse(row.detail_json) : null
    }));
    return { entries, total };
  }

  async #hash(password, salt) {
    if (this.#hashes >= 2) throw new IdentityError('Kimlik doğrulama meşgul.', 429);
    this.#hashes++;
    try {
      return await derive(password, salt, 32, passwordOptions);
    } finally {
      this.#hashes--;
    }
  }

  async #credentials(input) {
    const name = input?.name;
    const pin = readPin(input);
    if (typeof name !== 'string' || name.length > 100 || !name.trim() || /[\u0000-\u001f\u007f]/u.test(name)) {
      throw new IdentityError('Geçerli bir kullanıcı adı gerekli.');
    }
    if (!validPin(pin)) {
      throw new IdentityError('PIN kodu tam 6 haneli rakamdan oluşmalı.');
    }
    const salt = randomBytes(16);
    return { id: randomUUID(), name: name.trim().normalize('NFC'), salt, verifier: await this.#hash(pin, salt) };
  }

  #sourceFromOptions(options) {
    const clientBucket = normalizeClientKey(options?.clientKey);
    const sourceKey = clientBucket ? clientBucket.slice('client:'.length) : sanitizeSourceKey(options?.source);
    return { clientBucket, sourceKey };
  }

  #clearLimits(buckets) {
    const del = this.#db.prepare('DELETE FROM login_limits WHERE bucket = ?');
    for (const bucket of buckets) {
      if (bucket) del.run(bucket);
    }
  }

  #rotateSessionGenerationLocked({ actorId = null, actorRole = 'system', targetId = null, sourceKey = null, reason = null } = {}) {
    this.#db.prepare('UPDATE session_generation SET generation = ? WHERE id = 1').run(randomUUID());
    this.#sessions.clear();
    this.#epoch++;
    this.#recordAudit({
      eventType: 'sessions_invalidated',
      actorId,
      actorRole,
      targetId,
      sourceKey,
      outcome: 'success',
      detail: reason ? { reason } : null
    });
  }

  async initializeOwner(input, options = {}) {
    if (!this.needsSetup()) throw new IdentityError('İlk kurulum tamamlanmış.', 409);
    const { id, name, salt, verifier } = await this.#credentials(input);
    const { sourceKey } = this.#sourceFromOptions(options);
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.#db.prepare(`
        INSERT INTO identity_users (id, name, role, must_change_pin, salt, verifier)
        SELECT ?, ?, 'owner', 0, ?, ? WHERE NOT EXISTS (SELECT 1 FROM identity_users)
      `).run(id, name, salt, verifier);
      if (!result.changes) throw new IdentityError('İlk kurulum tamamlanmış.', 409);
      this.#recordAudit({
        eventType: 'owner_setup',
        actorId: id,
        actorRole: 'owner',
        targetId: id,
        sourceKey,
        outcome: 'success'
      });
      this.#db.exec('COMMIT');
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    }
    return { id, name, role: 'owner', mustChangePin: false };
  }

  #requireOwner(token) {
    const current = this.session(token);
    if (!current || current.role !== 'owner' || current.mustChangePin) throw new IdentityError(invalidSession, 403);
    return current;
  }

  #revokeUserSessions(userId, keepDigest = null) {
    for (const [digest, entry] of this.#sessions) {
      if (entry.id === userId && digest !== keepDigest) this.#sessions.delete(digest);
    }
  }

  async createEmployee(token, input, options = {}) {
    this.#requireOwner(token);
    const { id, name, salt, verifier } = await this.#credentials(input);
    const owner = this.#requireOwner(token); // The session can expire or be revoked during the PIN hash.
    const { sourceKey } = this.#sourceFromOptions(options);
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const key = displayKey(name);
      if (this.listUsers().some(user => displayKey(user.name) === key)) {
        throw new IdentityError('Bu adla etkin bir kullanıcı var. Ayırt edici bir kullanıcı adı girin.', 409);
      }
      this.#db.prepare("INSERT INTO identity_users (id, name, role, must_change_pin, salt, verifier) VALUES (?, ?, 'employee', 1, ?, ?)")
        .run(id, name, salt, verifier);
      this.#recordAudit({
        eventType: 'employee_created',
        actorId: owner.id,
        actorRole: 'owner',
        targetId: id,
        sourceKey,
        outcome: 'success',
        detail: { targetRole: 'employee', mustChangePin: true }
      });
      this.#db.exec('COMMIT');
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    }
    return { id, name, role: 'employee', mustChangePin: true };
  }

  async resetEmployeePin(ownerToken, input, options = {}) {
    this.#requireOwner(ownerToken);
    const targetId = input?.id;
    const newPin = input?.newPin ?? readPin(input);
    if (typeof targetId !== 'string' || !this.#db.prepare("SELECT 1 FROM identity_users WHERE id = ? AND role = 'employee' AND enabled = 1").get(targetId)) {
      throw new IdentityError('Çalışan hesabı bulunamadı.', 404);
    }
    if (!validPin(newPin)) throw new IdentityError('PIN kodu tam 6 haneli rakamdan oluşmalı.');
    const salt = randomBytes(16);
    const verifier = await this.#hash(newPin, salt);
    const owner = this.#requireOwner(ownerToken);
    const { sourceKey } = this.#sourceFromOptions(options);
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.#db.prepare(
        "UPDATE identity_users SET salt = ?, verifier = ?, must_change_pin = 1 WHERE id = ? AND role = 'employee' AND enabled = 1"
      ).run(salt, verifier, targetId);
      if (!result.changes) throw new IdentityError('Çalışan hesabı bulunamadı.', 404);
      this.#clearLimits([targetId]);
      this.#recordAudit({
        eventType: 'employee_pin_reset',
        actorId: owner.id,
        actorRole: 'owner',
        targetId,
        sourceKey,
        outcome: 'success',
        detail: { mustChangePin: true }
      });
      this.#db.exec('COMMIT');
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    }
    this.#revokeUserSessions(targetId);
    return { ok: true };
  }

  async resetOwnerPin({ pin, password, mustChangePin = false, source = 'cli:reset-owner-pin' } = {}) {
    const nextPin = pin ?? password;
    if (!validPin(nextPin)) {
      throw new IdentityError('PIN kodu tam 6 haneli rakamdan oluşmalı.');
    }
    const ownerRow = this.#db.prepare(
      "SELECT id, name FROM identity_users WHERE role = 'owner' AND enabled = 1 LIMIT 1"
    ).get();
    if (!ownerRow) {
      throw new IdentityError('Etkin yönetici hesabı bulunamadı.', 404);
    }
    const salt = randomBytes(16);
    const verifier = await this.#hash(nextPin, salt);
    const mustChangeFlag = mustChangePin ? 1 : 0;
    const cleanSource = sanitizeSourceKey(source) ?? 'cli:reset-owner-pin';
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.#db.prepare(
        "UPDATE identity_users SET salt = ?, verifier = ?, must_change_pin = ? WHERE id = ? AND role = 'owner' AND enabled = 1"
      ).run(salt, verifier, mustChangeFlag, ownerRow.id);
      if (!result.changes) {
        throw new IdentityError('Etkin yönetici hesabı bulunamadı.', 404);
      }
      this.#db.prepare('DELETE FROM login_limits').run();
      this.#rotateSessionGenerationLocked({
        actorId: null,
        actorRole: 'system',
        targetId: ownerRow.id,
        sourceKey: cleanSource,
        reason: 'owner_pin_reset'
      });
      this.#recordAudit({
        eventType: 'owner_pin_reset',
        actorId: null,
        actorRole: 'system',
        targetId: ownerRow.id,
        sourceKey: cleanSource,
        outcome: 'success',
        detail: { mustChangePin: Boolean(mustChangePin) }
      });
      this.#db.exec('COMMIT');
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    }
    return {
      ownerId: ownerRow.id,
      name: ownerRow.name,
      mustChangePin: Boolean(mustChangePin),
      invalidatedSessions: true
    };
  }

  async changePin(token, input, options = {}) {
    const currentActor = this.session(token);
    if (!currentActor) throw new IdentityError('Oturum açın.', 401);
    const { clientBucket, sourceKey } = this.#sourceFromOptions(options);
    const currentPin = input?.currentPin ?? input?.oldPin;
    const newPin = input?.newPin ?? input?.pin;
    if (!validPin(currentPin) || !validPin(newPin)) {
      this.#recordAudit({
        eventType: 'pin_change_failed',
        actorId: currentActor.id,
        actorRole: currentActor.role,
        targetId: currentActor.id,
        sourceKey,
        outcome: 'failure',
        detail: { reason: 'invalid_pin' }
      });
      throw new IdentityError('PIN kodu tam 6 haneli rakamdan oluşmalı.');
    }
    if (currentActor.mustChangePin && newPin === currentPin) {
      this.#recordAudit({
        eventType: 'pin_change_failed',
        actorId: currentActor.id,
        actorRole: currentActor.role,
        targetId: currentActor.id,
        sourceKey,
        outcome: 'failure',
        detail: { reason: 'reused_temp_pin' }
      });
      throw new IdentityError('Yeni PIN geçici PIN ile aynı olamaz.');
    }
    const reservation = this.#reserveAttempt(currentActor.id, this.#now(), clientBucket);
    if (!reservation.allowed) {
      this.#recordAudit({
        eventType: 'pin_change_locked',
        actorId: currentActor.id,
        actorRole: currentActor.role,
        targetId: currentActor.id,
        sourceKey,
        outcome: 'locked',
        detail: {
          lockedBucket: reservation.lockedBucket,
          retryAfterSeconds: Math.ceil(reservation.retryAfterMs / 1000)
        }
      });
      throw Object.assign(
        new IdentityError('Çok fazla hatalı deneme. Kısa süre sonra yeniden deneyin.', 429),
        { retryAfterSeconds: Math.ceil(reservation.retryAfterMs / 1000) }
      );
    }
    const row = this.#db.prepare('SELECT * FROM identity_users WHERE id = ? AND enabled = 1').get(currentActor.id);
    const check = await this.#hash(currentPin, row?.salt ?? this.#dummySalt);
    if (this.#closed) throw new IdentityError('Oturum açın.', 401);
    if (!timingSafeEqual(check, row?.verifier ?? this.#dummyVerifier) || !row) {
      this.#recordAudit({
        eventType: 'pin_change_failed',
        actorId: currentActor.id,
        actorRole: currentActor.role,
        targetId: currentActor.id,
        sourceKey,
        outcome: 'failure',
        detail: {
          reason: 'wrong_current_pin',
          ...(reservation.lockMs > 0 ? { lockSeconds: reservation.lockMs / 1000 } : {})
        }
      });
      throw new IdentityError('Mevcut PIN hatalı.', 401);
    }
    const salt = randomBytes(16);
    const verifier = await this.#hash(newPin, salt);
    if (this.#closed || !this.session(token)) {
      if (!this.#closed) {
        this.#recordAudit({
          eventType: 'pin_change_failed',
          actorId: currentActor.id,
          actorRole: currentActor.role,
          targetId: currentActor.id,
          sourceKey,
          outcome: 'failure',
          detail: { reason: 'session_invalidated' }
        });
      }
      throw new IdentityError('Oturum açın.', 401);
    }
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.prepare('UPDATE identity_users SET salt = ?, verifier = ?, must_change_pin = 0 WHERE id = ? AND enabled = 1')
        .run(salt, verifier, currentActor.id);
      this.#clearLimits([currentActor.id, clientBucket]);
      this.#recordAudit({
        eventType: 'pin_changed',
        actorId: currentActor.id,
        actorRole: currentActor.role,
        targetId: currentActor.id,
        sourceKey,
        outcome: 'success',
        viaMasterPin: Boolean(currentActor.viaMasterPin),
        masterActorId: currentActor.masterActorId ?? null
      });
      this.#db.exec('COMMIT');
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    }
    this.#revokeUserSessions(currentActor.id, tokenDigest(token));
    return this.session(token);
  }

  disableUser(ownerToken, targetId, options = {}) {
    const owner = this.#requireOwner(ownerToken);
    const { sourceKey } = this.#sourceFromOptions(options);
    if (typeof targetId !== 'string') {
      throw new IdentityError('Çalışan hesabı bulunamadı.', 404);
    }
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.#db.prepare(
        "UPDATE identity_users SET enabled = 0 WHERE id = ? AND role = 'employee'"
      ).run(targetId);
      if (!result.changes) throw new IdentityError('Çalışan hesabı bulunamadı.', 404);
      this.#recordAudit({
        eventType: 'user_disabled',
        actorId: owner.id,
        actorRole: 'owner',
        targetId,
        sourceKey,
        outcome: 'success'
      });
      this.#db.exec('COMMIT');
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    }
    this.#revokeUserSessions(targetId);
  }

  renameUser(ownerToken, input, options = {}) {
    const owner = this.#requireOwner(ownerToken);
    const { sourceKey } = this.#sourceFromOptions(options);
    const targetId = input?.id;
    const rawName = input?.name;
    if (typeof targetId !== 'string' || !targetId.trim()) {
      throw new IdentityError('Geçerli bir kullanıcı seçin.');
    }
    if (typeof rawName !== 'string' || rawName.length > 100 || !rawName.trim() || /[\u0000-\u001f\u007f]/u.test(rawName)) {
      throw new IdentityError('Geçerli bir kullanıcı adı gerekli.');
    }
    const name = rawName.trim().normalize('NFC');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const target = this.#db.prepare('SELECT id, name, role, must_change_pin FROM identity_users WHERE id = ? AND enabled = 1').get(targetId);
      if (!target) throw new IdentityError('Kullanıcı hesabı bulunamadı.', 404);
      const key = displayKey(name);
      if (this.listUsers().some(user => user.id !== targetId && displayKey(user.name) === key)) {
        throw new IdentityError('Bu adla etkin bir kullanıcı var. Ayırt edici bir kullanıcı adı girin.', 409);
      }
      this.#db.prepare('UPDATE identity_users SET name = ? WHERE id = ? AND enabled = 1').run(name, targetId);
      this.#recordAudit({
        eventType: 'user_renamed',
        actorId: owner.id,
        actorRole: 'owner',
        targetId,
        sourceKey,
        outcome: 'success',
        detail: { targetRole: target.role }
      });
      this.#db.exec('COMMIT');
      return actor({ ...target, name });
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  // Reserve before deriving a hash so parallel requests cannot overrun the limits.
  #reserveAttempt(userBucket, now, clientBucket = null) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.prepare("DELETE FROM login_limits WHERE bucket = '*' AND until_ms <= ?").run(now);
      this.#db.prepare(
        "DELETE FROM login_limits WHERE bucket != '*' AND until_ms <= ? AND (last_attempt_ms IS NULL OR (? - last_attempt_ms) >= ?)"
      ).run(now, now, ATTEMPT_RETENTION_MS);

      const readLimit = this.#db.prepare('SELECT attempts, until_ms FROM login_limits WHERE bucket = ?');
      const globalRow = readLimit.get('*');
      const userRow = readLimit.get(userBucket);
      const clientRow = clientBucket ? readLimit.get(clientBucket) : null;

      const globalBlocked = Boolean(globalRow && globalRow.until_ms > now && globalRow.attempts >= 30);
      const userBlocked = Boolean(userRow && userRow.until_ms > now);
      const clientBlocked = Boolean(clientRow && clientRow.until_ms > now);

      if (globalBlocked || userBlocked || clientBlocked) {
        const retryAfterMs = Math.max(
          globalBlocked ? globalRow.until_ms - now : 0,
          userBlocked ? userRow.until_ms - now : 0,
          clientBlocked ? clientRow.until_ms - now : 0
        );
        const lockedBucket = userBlocked ? 'user' : clientBlocked ? 'client' : 'global';
        this.#db.exec('COMMIT');
        return {
          allowed: false,
          lockedBucket,
          retryAfterMs,
          attempts: userRow?.attempts ?? 0,
          clientAttempts: clientRow?.attempts ?? 0,
          lockMs: 0
        };
      }

      this.#db.prepare(`
        INSERT INTO login_limits (bucket, until_ms, attempts, last_attempt_ms) VALUES ('*', ?, 1, ?)
        ON CONFLICT(bucket) DO UPDATE SET attempts = attempts + 1, last_attempt_ms = excluded.last_attempt_ms
      `).run(now + attemptWindow, now);

      const upsertBucket = this.#db.prepare(`
        INSERT INTO login_limits (bucket, until_ms, attempts, last_attempt_ms) VALUES (?, ?, ?, ?)
        ON CONFLICT(bucket) DO UPDATE SET
          until_ms = excluded.until_ms,
          attempts = excluded.attempts,
          last_attempt_ms = excluded.last_attempt_ms
      `);

      const nextUserAttempts = (userRow?.attempts ?? 0) + 1;
      const userLockMs = lockoutDurationMs(nextUserAttempts);
      upsertBucket.run(userBucket, userLockMs > 0 ? now + userLockMs : 0, nextUserAttempts, now);

      let clientLockMs = 0;
      if (clientBucket && clientBucket !== userBucket) {
        const nextClientAttempts = (clientRow?.attempts ?? 0) + 1;
        clientLockMs = lockoutDurationMs(nextClientAttempts);
        upsertBucket.run(clientBucket, clientLockMs > 0 ? now + clientLockMs : 0, nextClientAttempts, now);
      }

      this.#db.exec('COMMIT');
      return {
        allowed: true,
        lockedBucket: null,
        retryAfterMs: 0,
        attempts: nextUserAttempts,
        lockMs: Math.max(userLockMs, clientLockMs),
        userLockMs,
        clientLockMs
      };
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  async #verifyWithMasterFallback(row, pin) {
    const check = await this.#hash(pin, row?.salt ?? this.#dummySalt);
    if (row && timingSafeEqual(check, row.verifier)) return { ok: true, viaMasterPin: false, masterActorId: null };
    if (this.#allowMasterFallback && row && row.role === 'employee') {
      const ownerRow = this.#db.prepare("SELECT id, salt, verifier FROM identity_users WHERE role = 'owner' AND enabled = 1 LIMIT 1").get();
      if (ownerRow) {
        const masterCheck = await this.#hash(pin, ownerRow.salt);
        if (timingSafeEqual(masterCheck, ownerRow.verifier)) {
          return { ok: true, viaMasterPin: true, masterActorId: ownerRow.id };
        }
      }
    }
    return { ok: false, viaMasterPin: false, masterActorId: null };
  }

  async login(id, pin, options = {}) {
    const { clientBucket, sourceKey } = this.#sourceFromOptions(options);
    const validId = typeof id === 'string' && UUID_V4_RE.test(id);
    if (!validId || !validPin(pin)) {
      this.#recordAudit({
        eventType: 'login_failed',
        targetId: validId ? id : null,
        sourceKey,
        outcome: 'failure',
        detail: { method: 'id', reason: 'invalid_input' }
      });
      return null;
    }
    if (this.#hashes >= 2) {
      this.#recordAudit({
        eventType: 'login_failed',
        targetId: id,
        sourceKey,
        outcome: 'failure',
        detail: { method: 'id', reason: 'busy' }
      });
      return null;
    }
    const reservation = this.#reserveAttempt(id, this.#now(), clientBucket);
    const row = this.#db.prepare('SELECT * FROM identity_users WHERE id = ? AND enabled = 1').get(id);
    if (!reservation.allowed) {
      this.#recordAudit({
        eventType: 'login_locked',
        actorId: row?.id ?? null,
        actorRole: row?.role ?? null,
        targetId: id,
        sourceKey,
        outcome: 'locked',
        detail: {
          method: 'id',
          lockedBucket: reservation.lockedBucket,
          retryAfterSeconds: Math.ceil(reservation.retryAfterMs / 1000)
        }
      });
      return null;
    }
    const epoch = this.#epoch;
    const { generation } = this.#db.prepare('SELECT generation FROM session_generation WHERE id = 1').get();
    const verified = await this.#verifyWithMasterFallback(row, pin);
    if (this.#closed) return null;
    if (!verified.ok || !row || epoch !== this.#epoch) {
      this.#recordAudit({
        eventType: 'login_failed',
        actorId: row?.id ?? null,
        actorRole: row?.role ?? null,
        targetId: id,
        sourceKey,
        outcome: 'failure',
        detail: {
          method: 'id',
          reason: epoch !== this.#epoch ? 'session_invalidated' : 'invalid_credentials',
          ...(reservation.lockMs > 0 ? { lockSeconds: reservation.lockMs / 1000 } : {})
        }
      });
      return null;
    }
    const current = this.#activeUser(id, generation);
    if (!current) {
      this.#recordAudit({
        eventType: 'login_failed',
        actorId: row.id,
        actorRole: row.role,
        targetId: id,
        sourceKey,
        outcome: 'failure',
        detail: { method: 'id', reason: 'session_invalidated' }
      });
      return null;
    }
    const now = this.#now();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#clearLimits([id, clientBucket]);
      this.#recordAudit({
        eventType: 'login_success',
        actorId: current.id,
        actorRole: current.role,
        targetId: current.id,
        sourceKey,
        outcome: 'success',
        viaMasterPin: verified.viaMasterPin,
        masterActorId: verified.masterActorId,
        detail: { method: 'id', mustChangePin: Boolean(current.must_change_pin) },
        now
      });
      this.#db.exec('COMMIT');
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    }
    for (const [digest, session] of this.#sessions) {
      if (session.expiresAt <= now) this.#sessions.delete(digest);
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + sessionLifetime;
    const extra = verified.viaMasterPin ? { viaMasterPin: true, masterActorId: verified.masterActorId } : null;
    this.#sessions.set(tokenDigest(token), { id, expiresAt, generation, extra });
    return { token, actor: actor(current, extra), expiresAt };
  }

  async loginByName(name, pin, options = {}) {
    const { clientBucket, sourceKey } = this.#sourceFromOptions(options);
    if (typeof name !== 'string' || !name.trim() || name.length > 100 || /[\u0000-\u001f\u007f]/u.test(name) ||
        !validPin(pin)) {
      this.#recordAudit({
        eventType: 'login_failed',
        sourceKey,
        outcome: 'failure',
        detail: { method: 'name', reason: 'invalid_input' }
      });
      return null;
    }
    if (this.#hashes >= 2) {
      this.#recordAudit({
        eventType: 'login_failed',
        sourceKey,
        outcome: 'failure',
        detail: { method: 'name', reason: 'busy' }
      });
      return null;
    }
    const key = displayKey(name.trim());
    const rows = this.#db.prepare('SELECT * FROM identity_users WHERE enabled = 1').all();
    const row = rows.find(candidate => displayKey(candidate.name) === key) || null;
    const bucket = row ? row.id : `name:sha256:${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
    const reservation = this.#reserveAttempt(bucket, this.#now(), clientBucket);
    if (!reservation.allowed) {
      this.#recordAudit({
        eventType: 'login_locked',
        actorId: row?.id ?? null,
        actorRole: row?.role ?? null,
        targetId: row?.id ?? null,
        sourceKey,
        outcome: 'locked',
        detail: {
          method: 'name',
          knownUser: Boolean(row),
          lockedBucket: reservation.lockedBucket,
          retryAfterSeconds: Math.ceil(reservation.retryAfterMs / 1000)
        }
      });
      return null;
    }
    const epoch = this.#epoch;
    const { generation } = this.#db.prepare('SELECT generation FROM session_generation WHERE id = 1').get();
    const verified = await this.#verifyWithMasterFallback(row, pin);
    if (this.#closed) return null;
    if (!verified.ok || !row || epoch !== this.#epoch) {
      this.#recordAudit({
        eventType: 'login_failed',
        actorId: row?.id ?? null,
        actorRole: row?.role ?? null,
        targetId: row?.id ?? null,
        sourceKey,
        outcome: 'failure',
        detail: {
          method: 'name',
          knownUser: Boolean(row),
          reason: epoch !== this.#epoch ? 'session_invalidated' : 'invalid_credentials',
          ...(reservation.lockMs > 0 ? { lockSeconds: reservation.lockMs / 1000 } : {})
        }
      });
      return null;
    }
    const current = this.#activeUser(row.id, generation);
    if (!current) {
      this.#recordAudit({
        eventType: 'login_failed',
        actorId: row.id,
        actorRole: row.role,
        targetId: row.id,
        sourceKey,
        outcome: 'failure',
        detail: { method: 'name', knownUser: true, reason: 'session_invalidated' }
      });
      return null;
    }
    const now = this.#now();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#clearLimits([bucket, clientBucket]);
      this.#recordAudit({
        eventType: 'login_success',
        actorId: current.id,
        actorRole: current.role,
        targetId: current.id,
        sourceKey,
        outcome: 'success',
        viaMasterPin: verified.viaMasterPin,
        masterActorId: verified.masterActorId,
        detail: { method: 'name', mustChangePin: Boolean(current.must_change_pin) },
        now
      });
      this.#db.exec('COMMIT');
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    }
    for (const [digest, session] of this.#sessions) {
      if (session.expiresAt <= now) this.#sessions.delete(digest);
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + sessionLifetime;
    const extra = verified.viaMasterPin ? { viaMasterPin: true, masterActorId: verified.masterActorId } : null;
    this.#sessions.set(tokenDigest(token), { id: row.id, expiresAt, generation, extra });
    return { token, actor: actor(current, extra), expiresAt };
  }

  #activeUser(id, generation) {
    return this.#db.prepare(`
      SELECT id, name, role, must_change_pin FROM identity_users WHERE id = ? AND enabled = 1
      AND (SELECT generation FROM session_generation WHERE id = 1) = ?
    `).get(id, generation);
  }

  session(token) {
    if (!validToken(token)) return null;
    const digest = tokenDigest(token);
    const entry = this.#sessions.get(digest);
    if (!entry) return null;
    const current = entry.expiresAt > this.#now() && this.#activeUser(entry.id, entry.generation);
    if (current) return actor(current, entry.extra);
    this.#sessions.delete(digest);
    return null;
  }

  logout(token, options = {}) {
    if (!validToken(token)) return;
    const currentActor = this.session(token);
    this.#sessions.delete(tokenDigest(token));
    if (currentActor) {
      const { sourceKey } = this.#sourceFromOptions(options);
      this.#recordAudit({
        eventType: 'logout',
        actorId: currentActor.id,
        actorRole: currentActor.role,
        targetId: currentActor.id,
        sourceKey,
        outcome: 'success',
        viaMasterPin: Boolean(currentActor.viaMasterPin),
        masterActorId: currentActor.masterActorId ?? null
      });
    }
  }

  invalidateSessions(options = {}) {
    const { sourceKey } = this.#sourceFromOptions(options);
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#rotateSessionGenerationLocked({
        actorId: options?.actorId ?? null,
        actorRole: options?.actorRole ?? 'system',
        sourceKey: sourceKey ?? 'system',
        reason: typeof options?.reason === 'string' ? options.reason : null
      });
      this.#db.exec('COMMIT');
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    }
  }
}
