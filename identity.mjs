import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
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
const validPasswordSize = password => typeof password === 'string' && password.length > 0 &&
  password.length <= 1024 && Buffer.byteLength(password) <= 1024;

export class IdentityError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'IdentityError';
    this.status = status;
  }
}

const displayKey = name => name.toLocaleLowerCase('tr').normalize('NFC');

function actor(row) {
  return { id: row.id, name: row.name, role: row.role };
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
    this.#db = new DatabaseSync(join(directory, 'identity.sqlite'));
    try {
      this.#db.exec('PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
      const { application_id } = this.#db.prepare('PRAGMA application_id').get();
      const { user_version } = this.#db.prepare('PRAGMA user_version').get();
      if (application_id === 0 && user_version === 0 && !this.#db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get()) {
        this.#db.exec(`
          CREATE TABLE identity_users (
            id TEXT PRIMARY KEY NOT NULL,
            name TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('owner', 'employee')),
            enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
            salt BLOB NOT NULL CHECK(length(salt) = 16),
            verifier BLOB NOT NULL CHECK(length(verifier) = 32)
          ) STRICT;
          CREATE TABLE login_limits (
            bucket TEXT PRIMARY KEY NOT NULL, until_ms INTEGER NOT NULL, attempts INTEGER NOT NULL
          ) STRICT;
          PRAGMA application_id = ${identityApplicationId};
          PRAGMA user_version = 1;
        `);
      } else if (application_id !== identityApplicationId || ![1, 2].includes(user_version)) {
        throw new Error('Desteklenmeyen kimlik veritabanı.');
      }
      if (user_version < 2) {
        this.#db.exec('CREATE TABLE session_generation (id INTEGER PRIMARY KEY CHECK(id = 1), generation TEXT NOT NULL) STRICT');
        this.#db.prepare('INSERT INTO session_generation VALUES(1, ?)').run(randomUUID());
        this.#db.exec('PRAGMA user_version = 2');
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.close();
      throw error;
    }
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
    const { name, password } = input ?? {};
    if (typeof name !== 'string' || name.length > 100 || !name.trim() || /[\u0000-\u001f\u007f]/u.test(name)) {
      throw new IdentityError('Geçerli bir kullanıcı adı gerekli.');
    }
    if (!validPasswordSize(password) || [...password].length < 15) {
      throw new IdentityError('Parola en az 15 karakter ve en fazla 1024 bayt olmalı.');
    }
    const salt = randomBytes(16);
    return { id: randomUUID(), name: name.trim().normalize('NFC'), salt, verifier: await this.#hash(password, salt) };
  }

  async initializeOwner(input) {
    if (!this.needsSetup()) throw new IdentityError('İlk kurulum tamamlanmış.', 409);
    const { id, name, salt, verifier } = await this.#credentials(input);
    const result = this.#db.prepare(`
      INSERT INTO identity_users (id, name, role, salt, verifier)
      SELECT ?, ?, 'owner', ?, ? WHERE NOT EXISTS (SELECT 1 FROM identity_users)
    `).run(id, name, salt, verifier);
    if (!result.changes) throw new IdentityError('İlk kurulum tamamlanmış.', 409);
    return { id, name, role: 'owner' };
  }

  #requireOwner(token) {
    if (this.session(token)?.role !== 'owner') throw new IdentityError(invalidSession, 403);
  }

  async createEmployee(token, input) {
    this.#requireOwner(token);
    const { id, name, salt, verifier } = await this.#credentials(input);
    this.#requireOwner(token); // The session can expire or be revoked during the password hash.
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const key = displayKey(name);
      if (this.listUsers().some(user => displayKey(user.name) === key)) {
        throw new IdentityError('Bu adla etkin bir kullanıcı var. Ayırt edici bir kullanıcı adı girin.', 409);
      }
      this.#db.prepare("INSERT INTO identity_users (id, name, role, salt, verifier) VALUES (?, ?, 'employee', ?, ?)")
        .run(id, name, salt, verifier);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    return { id, name, role: 'employee' };
  }

  disableUser(ownerToken, targetId) {
    this.#requireOwner(ownerToken);
    if (typeof targetId !== 'string' || !this.#db.prepare(
      "UPDATE identity_users SET enabled = 0 WHERE id = ? AND role = 'employee'"
    ).run(targetId).changes) throw new IdentityError('Çalışan hesabı bulunamadı.', 404);
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

  async login(id, password) {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) ||
        !validPasswordSize(password) || this.#hashes >= 2) return null;
    if (!this.#reserveAttempt(id, this.#now())) return null;
    const epoch = this.#epoch;
    const { generation } = this.#db.prepare('SELECT generation FROM session_generation WHERE id = 1').get();
    const row = this.#db.prepare('SELECT * FROM identity_users WHERE id = ? AND enabled = 1').get(id);
    const check = await this.#hash(password, row?.salt ?? this.#dummySalt);
    if (!timingSafeEqual(check, row?.verifier ?? this.#dummyVerifier) || !row || epoch !== this.#epoch) return null;
    const current = this.#activeUser(id, generation);
    if (!current) return null;
    this.#db.prepare('DELETE FROM login_limits WHERE bucket = ?').run(id);
    const now = this.#now();
    for (const [digest, session] of this.#sessions) {
      if (session.expiresAt <= now) this.#sessions.delete(digest);
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + sessionLifetime;
    this.#sessions.set(tokenDigest(token), { id, expiresAt, generation });
    return { token, actor: actor(current), expiresAt };
  }

  #activeUser(id, generation) {
    return this.#db.prepare(`
      SELECT id, name, role FROM identity_users WHERE id = ? AND enabled = 1
      AND (SELECT generation FROM session_generation WHERE id = 1) = ?
    `).get(id, generation);
  }

  session(token) {
    if (!validToken(token)) return null;
    const digest = tokenDigest(token);
    const entry = this.#sessions.get(digest);
    if (!entry) return null;
    const current = entry.expiresAt > this.#now() && this.#activeUser(entry.id, entry.generation);
    if (current) return actor(current);
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
