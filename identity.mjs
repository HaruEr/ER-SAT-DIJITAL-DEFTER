import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, win32 as win32Path } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const passwordOptions = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const identityApplicationId = 1163086153;
const attemptWindow = 60_000;
const sessionLifetime = 8 * 60 * 60_000;
const invalidSession = 'Bu işlem için geçerli işletme sahibi oturumu gerekli.';
const tokenDigest = token => createHash('sha256').update(token).digest('hex');
const validToken = token => typeof token === 'string' && token.length === 43 && /^[A-Za-z0-9_-]+$/.test(token);
const validPin = pin => typeof pin === 'string' && /^\d{6}$/.test(pin);
const readPin = input => input?.pin ?? input?.password;

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

// A separate database holds credentials. The session map belongs to one running editor.
export class IdentityStore {
  #db;
  #now;
  #sessions = new Map();
  #epoch = 0;
  #hashes = 0;
  #dummySalt = randomBytes(16);
  #dummyVerifier = randomBytes(32);

  constructor(directory, { now = Date.now } = {}) {
    this.#now = now;
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
        !(initialAppId === identityApplicationId && [1, 2, 3].includes(initialUserVersion))
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
            bucket TEXT PRIMARY KEY NOT NULL, until_ms INTEGER NOT NULL, attempts INTEGER NOT NULL
          ) STRICT;
          CREATE TABLE session_generation (id INTEGER PRIMARY KEY CHECK(id = 1), generation TEXT NOT NULL) STRICT;
          PRAGMA application_id = ${identityApplicationId};
          PRAGMA user_version = 3;
        `);
        this.#db.prepare('INSERT INTO session_generation VALUES(1, ?)').run(randomUUID());
      } else if (application_id !== identityApplicationId || ![1, 2, 3].includes(user_version)) {
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
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      if (this.#db.isTransaction) {
        try { this.#db.exec('ROLLBACK'); } catch {}
      }
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

  async initializeOwner(input) {
    if (!this.needsSetup()) throw new IdentityError('İlk kurulum tamamlanmış.', 409);
    const { id, name, salt, verifier } = await this.#credentials(input);
    const result = this.#db.prepare(`
      INSERT INTO identity_users (id, name, role, must_change_pin, salt, verifier)
      SELECT ?, ?, 'owner', 0, ?, ? WHERE NOT EXISTS (SELECT 1 FROM identity_users)
    `).run(id, name, salt, verifier);
    if (!result.changes) throw new IdentityError('İlk kurulum tamamlanmış.', 409);
    return { id, name, role: 'owner', mustChangePin: false };
  }

  #requireOwner(token) {
    const current = this.session(token);
    if (!current || current.role !== 'owner' || current.mustChangePin) throw new IdentityError(invalidSession, 403);
  }

  #revokeUserSessions(userId, keepDigest = null) {
    for (const [digest, entry] of this.#sessions) {
      if (entry.id === userId && digest !== keepDigest) this.#sessions.delete(digest);
    }
  }

  async createEmployee(token, input) {
    this.#requireOwner(token);
    const { id, name, salt, verifier } = await this.#credentials(input);
    this.#requireOwner(token); // The session can expire or be revoked during the PIN hash.
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const key = displayKey(name);
      if (this.listUsers().some(user => displayKey(user.name) === key)) {
        throw new IdentityError('Bu adla etkin bir kullanıcı var. Ayırt edici bir kullanıcı adı girin.', 409);
      }
      this.#db.prepare("INSERT INTO identity_users (id, name, role, must_change_pin, salt, verifier) VALUES (?, ?, 'employee', 1, ?, ?)")
        .run(id, name, salt, verifier);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    return { id, name, role: 'employee', mustChangePin: true };
  }

  async resetEmployeePin(ownerToken, input) {
    this.#requireOwner(ownerToken);
    const targetId = input?.id;
    const newPin = input?.newPin ?? readPin(input);
    if (typeof targetId !== 'string' || !this.#db.prepare("SELECT 1 FROM identity_users WHERE id = ? AND role = 'employee' AND enabled = 1").get(targetId)) {
      throw new IdentityError('Çalışan hesabı bulunamadı.', 404);
    }
    if (!validPin(newPin)) throw new IdentityError('PIN kodu tam 6 haneli rakamdan oluşmalı.');
    const salt = randomBytes(16);
    const verifier = await this.#hash(newPin, salt);
    this.#requireOwner(ownerToken);
    const result = this.#db.prepare(
      "UPDATE identity_users SET salt = ?, verifier = ?, must_change_pin = 1 WHERE id = ? AND role = 'employee' AND enabled = 1"
    ).run(salt, verifier, targetId);
    if (!result.changes) throw new IdentityError('Çalışan hesabı bulunamadı.', 404);
    this.#db.prepare('DELETE FROM login_limits WHERE bucket = ?').run(targetId);
    this.#revokeUserSessions(targetId);
    return { ok: true };
  }

  async changePin(token, input) {
    const currentActor = this.session(token);
    if (!currentActor) throw new IdentityError('Oturum açın.', 401);
    const currentPin = input?.currentPin ?? input?.oldPin;
    const newPin = input?.newPin ?? input?.pin;
    if (!validPin(currentPin) || !validPin(newPin)) {
      throw new IdentityError('PIN kodu tam 6 haneli rakamdan oluşmalı.');
    }
    if (currentActor.mustChangePin && newPin === currentPin) {
      throw new IdentityError('Yeni PIN geçici PIN ile aynı olamaz.');
    }
    if (!this.#reserveAttempt(currentActor.id, this.#now())) {
      throw new IdentityError('Çok fazla hatalı deneme. Kısa süre sonra yeniden deneyin.', 429);
    }
    const row = this.#db.prepare('SELECT * FROM identity_users WHERE id = ? AND enabled = 1').get(currentActor.id);
    const check = await this.#hash(currentPin, row?.salt ?? this.#dummySalt);
    if (!timingSafeEqual(check, row?.verifier ?? this.#dummyVerifier) || !row) {
      throw new IdentityError('Mevcut PIN hatalı.', 401);
    }
    const salt = randomBytes(16);
    const verifier = await this.#hash(newPin, salt);
    if (!this.session(token)) throw new IdentityError('Oturum açın.', 401);
    this.#db.prepare('UPDATE identity_users SET salt = ?, verifier = ?, must_change_pin = 0 WHERE id = ? AND enabled = 1')
      .run(salt, verifier, currentActor.id);
    this.#db.prepare('DELETE FROM login_limits WHERE bucket = ?').run(currentActor.id);
    this.#revokeUserSessions(currentActor.id, tokenDigest(token));
    return this.session(token);
  }

  disableUser(ownerToken, targetId) {
    this.#requireOwner(ownerToken);
    if (typeof targetId !== 'string' || !this.#db.prepare(
      "UPDATE identity_users SET enabled = 0 WHERE id = ? AND role = 'employee'"
    ).run(targetId).changes) throw new IdentityError('Çalışan hesabı bulunamadı.', 404);
    this.#revokeUserSessions(targetId);
  }

  renameUser(ownerToken, input) {
    this.#requireOwner(ownerToken);
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
      this.#db.exec('COMMIT');
      return actor({ ...target, name });
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  // Reserve before deriving a hash so parallel requests cannot overrun the limits.
  #reserveAttempt(id, now) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.prepare('DELETE FROM login_limits WHERE until_ms <= ?').run(now);
      const count = this.#db.prepare('SELECT attempts FROM login_limits WHERE bucket = ?');
      const allowed = (count.get('*')?.attempts ?? 0) < 30 && (count.get(id)?.attempts ?? 0) < 5;
      if (allowed) {
        const reserve = this.#db.prepare(`
          INSERT INTO login_limits (bucket, until_ms, attempts) VALUES (?, ?, 1)
          ON CONFLICT(bucket) DO UPDATE SET attempts = attempts + 1
        `);
        reserve.run('*', now + attemptWindow);
        reserve.run(id, now + attemptWindow);
      }
      this.#db.exec('COMMIT');
      return allowed;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  async #verifyWithMasterFallback(row, pin) {
    const check = await this.#hash(pin, row?.salt ?? this.#dummySalt);
    if (row && timingSafeEqual(check, row.verifier)) return { ok: true, viaMasterPin: false, masterActorId: null };
    if (row && row.role === 'employee') {
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

  async login(id, pin) {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) ||
        !validPin(pin) || this.#hashes >= 2) return null;
    if (!this.#reserveAttempt(id, this.#now())) return null;
    const epoch = this.#epoch;
    const { generation } = this.#db.prepare('SELECT generation FROM session_generation WHERE id = 1').get();
    const row = this.#db.prepare('SELECT * FROM identity_users WHERE id = ? AND enabled = 1').get(id);
    const verified = await this.#verifyWithMasterFallback(row, pin);
    if (!verified.ok || !row || epoch !== this.#epoch) return null;
    const current = this.#activeUser(id, generation);
    if (!current) return null;
    this.#db.prepare('DELETE FROM login_limits WHERE bucket = ?').run(id);
    const now = this.#now();
    for (const [digest, session] of this.#sessions) {
      if (session.expiresAt <= now) this.#sessions.delete(digest);
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + sessionLifetime;
    const extra = verified.viaMasterPin ? { viaMasterPin: true, masterActorId: verified.masterActorId } : null;
    this.#sessions.set(tokenDigest(token), { id, expiresAt, generation, extra });
    return { token, actor: actor(current, extra), expiresAt };
  }

  async loginByName(name, pin) {
    if (typeof name !== 'string' || !name.trim() || name.length > 100 || /[\u0000-\u001f\u007f]/u.test(name) ||
        !validPin(pin) || this.#hashes >= 2) return null;
    const key = displayKey(name.trim());
    const rows = this.#db.prepare('SELECT * FROM identity_users WHERE enabled = 1').all();
    const row = rows.find(candidate => displayKey(candidate.name) === key) || null;
    const bucket = row ? row.id : `name:${key}`;
    if (!this.#reserveAttempt(bucket, this.#now())) return null;
    const epoch = this.#epoch;
    const { generation } = this.#db.prepare('SELECT generation FROM session_generation WHERE id = 1').get();
    const verified = await this.#verifyWithMasterFallback(row, pin);
    if (!verified.ok || !row || epoch !== this.#epoch) return null;
    const current = this.#activeUser(row.id, generation);
    if (!current) return null;
    this.#db.prepare('DELETE FROM login_limits WHERE bucket = ?').run(bucket);
    const now = this.#now();
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

  logout(token) {
    if (validToken(token)) this.#sessions.delete(tokenDigest(token));
  }

  invalidateSessions() {
    this.#db.prepare('UPDATE session_generation SET generation = ? WHERE id = 1').run(randomUUID());
    this.#sessions.clear();
    this.#epoch++;
  }
}
