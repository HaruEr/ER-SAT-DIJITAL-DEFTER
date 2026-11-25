import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, win32 as win32Path } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { replay } from '../domain.mjs';
import { IdentityStore } from '../identity.mjs';
import { Repository } from '../repository.mjs';

const deriveKey = promisify(scrypt);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const BUNDLE_MANIFEST_FILENAME = 'bundle-manifest.json';
const BUNDLE_MANIFEST_MAX_BYTES = 1024 * 1024;
const IDENTITY_APPLICATION_ID = 1163086153;
const ENCRYPTED_MAGIC = Buffer.from('KUYUMCU-BUNDLE1\0', 'ascii'); // 16 bytes
const ENCRYPTED_VERSION = 1;
const ENCRYPTED_HEADER_BYTES = 57; // 16 magic + 1 ver + 4 N + 4 r + 4 p + 16 salt + 12 iv
const ENCRYPTED_TAG_BYTES = 16;
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 3;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const SQLITE_HEADER_PREFIX = 'SQLite format 3\0';
const LEDGER_REQUIRED_TABLES = [
  'events',
  'meta',
  'restore_archive',
  'ledger_snapshot',
  'ledger_journal',
  'ledger_journal_accounts',
  'ledger_links',
  'pending_submissions'
];
const IDENTITY_REQUIRED_TABLES = ['identity_users', 'login_limits', 'session_generation'];
const MANAGED_DB_FILES = [
  'dukkan.sqlite',
  'dukkan.sqlite-wal',
  'dukkan.sqlite-shm',
  'demo.sqlite',
  'demo.sqlite-wal',
  'demo.sqlite-shm',
  'identity.sqlite',
  'identity.sqlite-wal',
  'identity.sqlite-shm'
];

const pathKey = value => (process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value));
const samePath = (a, b) => pathKey(a) === pathKey(b);
const sha256Buffer = buf => createHash('sha256').update(buf).digest('hex');
const sha256Json = value => sha256Buffer(Buffer.from(JSON.stringify(value), 'utf8'));

function failBundle(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

const ALLOWED_BUNDLE_FILES = new Set([
  BUNDLE_MANIFEST_FILENAME,
  'dukkan.sqlite',
  'demo.sqlite',
  'identity.sqlite'
]);
const EXPECTED_FILENAME_BY_ROLE = Object.freeze({
  dukkan: 'dukkan.sqlite',
  demo: 'demo.sqlite',
  identity: 'identity.sqlite'
});
const SAFE_BUNDLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WIN32_ILLEGAL_CHAR_RE = /[\x00-\x1f\x7f\\/:*?"<>|]/;
const CONTROL_OR_BIDI_RE = /[\u0080-\u009f\u202a-\u202e\u2066-\u2069]/;
const WINDOWS_RESERVED_STEM_RE = /^(?:con|prn|aux|nul|com[0-9\u00B2\u00B3\u00B9]|lpt[0-9\u00B2\u00B3\u00B9]|conin\$|conout\$)$/i;
const WIN32_DEVICE_NAMESPACE_RE = /^[\\/]{2}[?.](?:[\\/]|$)/;
const WIN32_DRIVE_ROOT_RE = /^[A-Za-z]:[\\/]?$/;

function isWindowsReservedName(segment) {
  if (typeof segment !== 'string' || !segment) return false;
  const cut = segment.search(/[.:]/);
  const rawStem = cut === -1 ? segment : segment.slice(0, cut);
  const stem = rawStem.replace(/[\s.]+$/u, '');
  return WINDOWS_RESERVED_STEM_RE.test(stem);
}

function isUnsafeWin32Segment(segment, { allowDotNavigation = false } = {}) {
  if (!segment) return false;
  if (segment === '.' || segment === '..') {
    return !allowDotNavigation;
  }
  if (segment !== segment.trim()) return true;
  if (segment.endsWith('.')) return true;
  if (WIN32_ILLEGAL_CHAR_RE.test(segment)) return true;
  if (CONTROL_OR_BIDI_RE.test(segment)) return true;
  if (isWindowsReservedName(segment)) return true;
  return false;
}

function validatePathTree(pathValue, { allowDotNavigation, label }) {
  if (WIN32_DEVICE_NAMESPACE_RE.test(pathValue)) {
    throw failBundle('INVALID_PATH', `${label} Win32 aygıt ad alanı içeremez.`);
  }
  const { root } = win32Path.parse(pathValue);
  if (root) {
    if (WIN32_DEVICE_NAMESPACE_RE.test(root)) {
      throw failBundle('INVALID_PATH', `${label} Win32 aygıt ad alanı içeremez.`);
    }
    const isSlashRoot = root === '/' || root === '\\';
    const isDriveRoot = WIN32_DRIVE_ROOT_RE.test(root);
    if (!isSlashRoot && !isDriveRoot) {
      if (!/^(?:\\\\|\/\/)/.test(root)) {
        throw failBundle('INVALID_PATH', `${label} geçersiz bir kök yolu içeriyor.`);
      }
      const uncParts = root.replace(/^[\\/]{2}/, '').split(/[\\/]+/).filter(Boolean);
      if (uncParts.length !== 2 || uncParts.some(part => isUnsafeWin32Segment(part, { allowDotNavigation: false }))) {
        throw failBundle('INVALID_PATH', `${label} geçersiz bir UNC kök yolu içeriyor.`);
      }
    }
  }
  const remainder = pathValue.slice(root.length);
  for (const segment of remainder.split(/[\\/]+/)) {
    if (!segment) continue;
    if (isUnsafeWin32Segment(segment, { allowDotNavigation })) {
      throw failBundle('INVALID_PATH', `${label} geçersiz veya Windows ayrılmış yol bölümü içeriyor.`);
    }
  }
}

function assertSafePathSegments(rawPath, resolvedPath, label) {
  if (
    typeof rawPath !== 'string' ||
    typeof resolvedPath !== 'string' ||
    !rawPath.trim() ||
    !resolvedPath.trim() ||
    rawPath.includes('\0') ||
    resolvedPath.includes('\0') ||
    rawPath !== rawPath.trim() ||
    resolvedPath !== resolvedPath.trim()
  ) {
    throw failBundle('INVALID_PATH', `${label} geçerli bir dosya veya klasör yolu olmalı.`);
  }
  validatePathTree(rawPath, { allowDotNavigation: true, label });
  validatePathTree(resolvedPath, { allowDotNavigation: false, label });
}

function assertNonEmptyPath(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value !== value.trim()) {
    throw failBundle('INVALID_PATH', `${label} geçerli bir dosya veya klasör yolu olmalı.`);
  }
  const resolved = resolve(value);
  assertSafePathSegments(value, resolved, label);
  return resolved;
}

function assertRegularNoSymlink(targetPath, label) {
  if (!pathExistsOrSymlink(targetPath)) {
    throw failBundle('MISSING_FILE', `${label} bulunamadı.`);
  }
  const st = lstatSync(targetPath);
  if (st.isSymbolicLink() || !st.isFile()) {
    throw failBundle('INVALID_FILE', `${label} geçerli bir normal dosya değil.`);
  }
}

function assertValidSqliteSource(filePath, label) {
  assertRegularNoSymlink(filePath, label);
  const fd = openSync(filePath, 'r');
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      throw failBundle('INVALID_FILE', `${label} geçerli bir normal dosya değil.`);
    }
    if (st.size < 100) {
      throw failBundle('SQLITE_HEADER_INVALID', `${label} geçerli bir SQLite veritabanı değil.`);
    }
    const header = Buffer.alloc(16);
    let totalRead = 0;
    while (totalRead < 16) {
      const bytesRead = readSync(fd, header, totalRead, 16 - totalRead, totalRead);
      if (bytesRead === 0) break;
      totalRead += bytesRead;
    }
    if (totalRead !== 16 || header.toString('utf8') !== SQLITE_HEADER_PREFIX) {
      throw failBundle('SQLITE_HEADER_INVALID', `${label} SQLite dosya başlığı geçersiz.`);
    }
  } finally {
    closeSync(fd);
  }
}

function pathExistsOrSymlink(targetPath) {
  if (existsSync(targetPath)) return true;
  try {
    lstatSync(targetPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function assertSafeBasename(name) {
  if (
    typeof name !== 'string' ||
    !name ||
    Buffer.byteLength(name, 'utf8') > 255 ||
    name !== basename(name) ||
    name !== name.trim() ||
    name === '.' ||
    name === '..' ||
    name.endsWith('.') ||
    name.includes('\uFFFD') ||
    WIN32_ILLEGAL_CHAR_RE.test(name) ||
    CONTROL_OR_BIDI_RE.test(name) ||
    isWindowsReservedName(name)
  ) {
    throw failBundle('INVALID_FILENAME', 'Geçersiz paket dosya adı.');
  }
}

function assertSafeBundleId(bundleId) {
  if (typeof bundleId !== 'string' || !bundleId.trim()) {
    throw failBundle('MANIFEST_INVALID', 'Manifest bundleId alanı geçersiz.');
  }
  assertSafeBasename(bundleId);
  if (!SAFE_BUNDLE_ID_RE.test(bundleId) || bundleId.includes('..')) {
    throw failBundle('MANIFEST_INVALID', 'Manifest bundleId güvenli tanımlayıcı formatında değil.');
  }
}

function assertChildDirectory(parentDir, childDir, code = 'MANIFEST_INVALID') {
  const resolvedParent = resolve(parentDir);
  const resolvedChild = resolve(childDir);
  const rel = relative(resolvedParent, resolvedChild);
  if (
    !rel ||
    rel === '.' ||
    rel.startsWith('..') ||
    isAbsolute(rel) ||
    /[\\/]/.test(rel) ||
    !samePath(dirname(resolvedChild), resolvedParent)
  ) {
    throw failBundle(code, 'Paket hedef klasör sınırları dışına çıkamaz.');
  }
}

function removeDirSafe(dir) {
  if (dir && existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function removeSidecars(dbPath) {
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${dbPath}${suffix}`;
    if (existsSync(sidecar)) {
      unlinkSync(sidecar);
    }
  }
}

function moveDirectoryAtomically(sourceDir, targetDir) {
  mkdirSync(dirname(targetDir), { recursive: true });
  try {
    renameSync(sourceDir, targetDir);
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    const stagingInTarget = join(dirname(targetDir), `.tmp-${basename(targetDir)}-${randomUUID()}`);
    try {
      mkdirSync(stagingInTarget, { recursive: true, mode: 0o700 });
      for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
        if (!entry.isFile()) throw failBundle('BUNDLE_PAYLOAD_INVALID', 'Beklenmeyen paket öğesi.');
        copyFileSync(join(sourceDir, entry.name), join(stagingInTarget, entry.name));
      }
      renameSync(stagingInTarget, targetDir);
    } catch (innerError) {
      removeDirSafe(stagingInTarget);
      throw innerError;
    }
  }
}

function moveFileReplace(sourceFile, targetFile) {
  try {
    renameSync(sourceFile, targetFile);
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    const tempTarget = `${targetFile}.tmp-${randomUUID()}`;
    try {
      copyFileSync(sourceFile, tempTarget);
      renameSync(tempTarget, targetFile);
      unlinkSync(sourceFile);
    } catch (innerError) {
      if (existsSync(tempTarget)) {
        try { unlinkSync(tempTarget); } catch {}
      }
      throw innerError;
    }
  }
}

function readAppVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function readGitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function readLedgerFingerprint(db) {
  const revRow = db.prepare('SELECT revision FROM meta WHERE id = 1').get();
  if (!revRow || !Number.isSafeInteger(revRow.revision) || revRow.revision < 0) {
    throw failBundle('LEDGER_META_INVALID', 'Defter revision metadata geçersiz.');
  }
  const eventStats = db.prepare('SELECT COUNT(*) AS count, COALESCE(MAX(seq), 0) AS maxSeq FROM events').get();
  const pendingRows = db.prepare(
    'SELECT id, status, submitted_at, reviewed_at, approved_event_id FROM pending_submissions ORDER BY id'
  ).all();
  const archiveStats = db.prepare('SELECT COUNT(*) AS count, COALESCE(MAX(id), 0) AS maxId FROM restore_archive').get();
  const dataVersion = db.prepare('PRAGMA data_version').get().data_version;
  return {
    revision: revRow.revision,
    eventCount: eventStats.count,
    maxSeq: eventStats.maxSeq,
    pendingCount: pendingRows.length,
    pendingDigest: sha256Json(pendingRows),
    restoreArchiveCount: archiveStats.count,
    restoreArchiveMaxId: archiveStats.maxId,
    dataVersion
  };
}

function readIdentityFingerprint(db) {
  const users = db.prepare(
    'SELECT id, name, role, enabled, must_change_pin, hex(salt) AS saltHex, hex(verifier) AS verifierHex FROM identity_users ORDER BY id'
  ).all();
  const genRow = db.prepare('SELECT generation FROM session_generation WHERE id = 1').get();
  if (!genRow || typeof genRow.generation !== 'string' || !genRow.generation) {
    throw failBundle('IDENTITY_GENERATION_INVALID', 'Kimlik session_generation kaydı geçersiz.');
  }
  const limits = db.prepare('SELECT bucket, until_ms, attempts FROM login_limits ORDER BY bucket').all();
  const dataVersion = db.prepare('PRAGMA data_version').get().data_version;
  return {
    userCount: users.length,
    usersDigest: sha256Json(users),
    sessionGeneration: genRow.generation,
    loginLimitsDigest: sha256Json(limits),
    dataVersion
  };
}

function inspectStagedDatabase(stagedFile, role, workspace) {
  const bytes = readFileSync(stagedFile);
  if (bytes.subarray(0, 16).toString('utf8') !== SQLITE_HEADER_PREFIX) {
    throw failBundle('SQLITE_HEADER_INVALID', `${basename(stagedFile)} geçerli bir SQLite dosyası değil.`);
  }
  const db = new DatabaseSync(stagedFile, { readOnly: true });
  try {
    const integrityRow = db.prepare('PRAGMA integrity_check').get();
    const integrityCheck = integrityRow ? String(Object.values(integrityRow)[0]) : 'error';
    if (integrityCheck !== 'ok') {
      throw failBundle('SQLITE_INTEGRITY_FAILED', `${basename(stagedFile)} bütünlük kontrolü başarısız: ${integrityCheck}`);
    }
    const applicationId = db.prepare('PRAGMA application_id').get().application_id;
    const userVersion = db.prepare('PRAGMA user_version').get().user_version;
    const schemaVersion = db.prepare('PRAGMA schema_version').get().schema_version;

    if (role === 'identity') {
      const userCount = db.prepare('SELECT COUNT(*) AS c FROM identity_users').get().c;
      return {
        role,
        workspace: null,
        filename: basename(stagedFile),
        applicationId,
        userVersion,
        schemaVersion,
        revision: null,
        eventCount: null,
        pendingCount: null,
        restoreArchiveCount: null,
        userCount,
        sizeBytes: bytes.length,
        sha256: sha256Buffer(bytes),
        integrityCheck
      };
    }

    const revision = db.prepare('SELECT revision FROM meta WHERE id = 1').get()?.revision;
    const eventCount = db.prepare('SELECT COUNT(*) AS c FROM events').get().c;
    const pendingCount = db.prepare('SELECT COUNT(*) AS c FROM pending_submissions').get().c;
    const restoreArchiveCount = db.prepare('SELECT COUNT(*) AS c FROM restore_archive').get().c;
    return {
      role,
      workspace,
      filename: basename(stagedFile),
      applicationId,
      userVersion,
      schemaVersion,
      revision,
      eventCount,
      pendingCount,
      restoreArchiveCount,
      userCount: null,
      sizeBytes: bytes.length,
      sha256: sha256Buffer(bytes),
      integrityCheck
    };
  } finally {
    db.close();
  }
}

/**
 * Create a cross-DB consistent backup bundle in `outputDirectory/<bundleId>` using SQLite VACUUM INTO.
 * Retries up to `maxRetries` times if any ledger or identity database mutates mid-backup.
 * On failure or exhausted retries, deletes all staging artifacts and publishes nothing to `outputDirectory`.
 *
 * @param {object} options
 * @param {string} options.dataDirectory
 * @param {string} options.outputDirectory
 * @param {number} [options.maxRetries=3]
 * @param {string} [options.tempDirectory=tmpdir()]
 * @returns {Promise<{bundleId: string, bundleDirectory: string, manifestPath: string, manifest: object, attempts: number}>}
 */
export async function createBackupBundle({
  dataDirectory,
  outputDirectory,
  maxRetries = 3,
  tempDirectory = tmpdir()
} = {}) {
  const sourceDir = assertNonEmptyPath(dataDirectory, 'Veri klasörü');
  const outDir = assertNonEmptyPath(outputDirectory, 'Çıktı klasörü');
  const tempBase = assertNonEmptyPath(tempDirectory, 'Geçici klasör');
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 20) {
    throw failBundle('INVALID_OPTIONS', 'maxRetries 0 ile 20 arasında bir tam sayı olmalı.');
  }
  if (!existsSync(sourceDir) || !lstatSync(sourceDir).isDirectory()) {
    throw failBundle('MISSING_DATA_DIRECTORY', 'Kaynak veri klasörü bulunamadı.');
  }

  const dukkanSrc = join(sourceDir, 'dukkan.sqlite');
  const demoSrc = join(sourceDir, 'demo.sqlite');
  const identitySrc = join(sourceDir, 'identity.sqlite');
  assertValidSqliteSource(dukkanSrc, 'dukkan.sqlite');
  assertValidSqliteSource(identitySrc, 'identity.sqlite');

  mkdirSync(tempBase, { recursive: true });
  const stagingRoot = mkdtempSync(join(tempBase, 'backup-bundle-stage-'));
  const startedAt = new Date().toISOString();
  const bundleId = `bundle-${startedAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const maxAttempts = 1 + maxRetries;

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const attemptDir = join(stagingRoot, `attempt-${attempt}`);
      mkdirSync(attemptDir, { recursive: true });

      const hasDemo = pathExistsOrSymlink(demoSrc);
      if (hasDemo) assertValidSqliteSource(demoSrc, 'demo.sqlite');

      let dukkanRepo = null;
      let demoRepo = null;
      let identityStore = null;
      let fpDukkan = null;
      let fpDemo = null;
      let fpIdentity = null;

      try {
        dukkanRepo = new Repository(dukkanSrc, 'dukkan');
        if (hasDemo) demoRepo = new Repository(demoSrc, 'demo');
        identityStore = new IdentityStore(sourceDir);

        fpDukkan = new DatabaseSync(dukkanSrc, { readOnly: true, timeout: 5000 });
        if (hasDemo) fpDemo = new DatabaseSync(demoSrc, { readOnly: true, timeout: 5000 });
        fpIdentity = new DatabaseSync(identitySrc, { readOnly: true, timeout: 5000 });

        const beforeFp = {
          hasDemo,
          dukkan: readLedgerFingerprint(fpDukkan),
          demo: hasDemo ? readLedgerFingerprint(fpDemo) : null,
          identity: readIdentityFingerprint(fpIdentity)
        };

        const dukkanStage = join(attemptDir, 'dukkan.sqlite');
        const demoStage = join(attemptDir, 'demo.sqlite');
        const identityStage = join(attemptDir, 'identity.sqlite');

        dukkanRepo.createConsistentBackup(dukkanStage);
        if (hasDemo) demoRepo.createConsistentBackup(demoStage);
        identityStore.createConsistentBackup(identityStage);

        const demoStillPresent = pathExistsOrSymlink(demoSrc);
        const afterFp = {
          hasDemo: demoStillPresent,
          dukkan: readLedgerFingerprint(fpDukkan),
          demo: demoStillPresent && fpDemo ? readLedgerFingerprint(fpDemo) : null,
          identity: readIdentityFingerprint(fpIdentity)
        };

        if (JSON.stringify(beforeFp) !== JSON.stringify(afterFp)) {
          if (attempt < maxAttempts) {
            continue;
          }
          throw failBundle(
            'BACKUP_INCONSISTENT_CROSS_DB',
            `Çapraz veritabanı tutarlılığı ${maxAttempts} denemede sağlanamadı; kısmi yedek yayınlanmadı.`,
            { attempts: attempt }
          );
        }

        const databases = [
          inspectStagedDatabase(dukkanStage, 'dukkan', 'dukkan'),
          ...(hasDemo ? [inspectStagedDatabase(demoStage, 'demo', 'demo')] : []),
          inspectStagedDatabase(identityStage, 'identity', null)
        ];

        const manifest = {
          manifestVersion: 1,
          bundleId,
          startedAt,
          finishedAt: new Date().toISOString(),
          appVersion: readAppVersion(),
          gitCommit: readGitCommit(),
          method: 'VACUUM INTO',
          attempts: attempt,
          databases
        };

        const manifestPath = join(attemptDir, BUNDLE_MANIFEST_FILENAME);
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { encoding: 'utf8', flag: 'wx', flush: true });

        mkdirSync(outDir, { recursive: true });
        assertSafeBundleId(bundleId);
        const publishedDir = resolve(outDir, bundleId);
        assertChildDirectory(outDir, publishedDir);
        if (pathExistsOrSymlink(publishedDir)) {
          throw failBundle('BUNDLE_EXISTS', 'Hedef yedek paketi klasörü zaten mevcut.');
        }
        moveDirectoryAtomically(attemptDir, publishedDir);

        return {
          bundleId,
          bundleDirectory: publishedDir,
          manifestPath: join(publishedDir, BUNDLE_MANIFEST_FILENAME),
          manifest,
          attempts: attempt
        };
      } finally {
        for (const handle of [fpDukkan, fpDemo, fpIdentity, dukkanRepo, demoRepo, identityStore]) {
          if (handle) {
            try { handle.close(); } catch {}
          }
        }
        removeDirSafe(attemptDir);
      }
    }

    throw failBundle('BACKUP_INCONSISTENT_CROSS_DB', 'Yedek paketi oluşturulamadı.');
  } finally {
    removeDirSafe(stagingRoot);
  }
}

function validateBundleManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw failBundle('MANIFEST_INVALID', 'Manifest yapısı geçersiz.');
  }
  if (manifest.manifestVersion !== 1 || manifest.method !== 'VACUUM INTO') {
    throw failBundle('MANIFEST_INVALID', 'Manifest sürümü veya yöntemi desteklenmiyor.');
  }
  if (
    typeof manifest.bundleId !== 'string' ||
    !manifest.bundleId.trim() ||
    typeof manifest.startedAt !== 'string' ||
    typeof manifest.finishedAt !== 'string'
  ) {
    throw failBundle('MANIFEST_INVALID', 'Manifest kimlik veya zaman alanları geçersiz.');
  }
  assertSafeBundleId(manifest.bundleId);
  if (!Array.isArray(manifest.databases) || manifest.databases.length < 2 || manifest.databases.length > 3) {
    throw failBundle('MANIFEST_INVALID', 'Manifest veritabanı listesi geçersiz.');
  }

  const seenRoles = new Set();
  const seenFilenames = new Set();
  const expectedFiles = [BUNDLE_MANIFEST_FILENAME];

  for (const dbEntry of manifest.databases) {
    if (!dbEntry || typeof dbEntry !== 'object' || Array.isArray(dbEntry)) {
      throw failBundle('MANIFEST_INVALID', 'Veritabanı manifest kaydı geçersiz.');
    }
    if (!Object.hasOwn(EXPECTED_FILENAME_BY_ROLE, dbEntry.role)) {
      throw failBundle('MANIFEST_INVALID', `Desteklenmeyen veritabanı rolü: ${dbEntry.role}`);
    }
    if (seenRoles.has(dbEntry.role)) {
      throw failBundle('MANIFEST_INVALID', `Yinelenen veritabanı rolü: ${dbEntry.role}`);
    }
    seenRoles.add(dbEntry.role);

    assertSafeBasename(dbEntry.filename);
    if (dbEntry.filename !== EXPECTED_FILENAME_BY_ROLE[dbEntry.role] || seenFilenames.has(dbEntry.filename)) {
      throw failBundle('MANIFEST_INVALID', `Geçersiz veritabanı dosya adı: ${dbEntry.filename}`);
    }
    seenFilenames.add(dbEntry.filename);
    expectedFiles.push(dbEntry.filename);

    if (!Number.isSafeInteger(dbEntry.sizeBytes) || dbEntry.sizeBytes <= 0) {
      throw failBundle('MANIFEST_INVALID', `Geçersiz dosya boyutu: ${dbEntry.filename}`);
    }
    if (typeof dbEntry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(dbEntry.sha256)) {
      throw failBundle('MANIFEST_INVALID', `Geçersiz SHA-256 özeti: ${dbEntry.filename}`);
    }
    if (dbEntry.integrityCheck !== 'ok') {
      throw failBundle('MANIFEST_INVALID', `Manifest integrityCheck geçersiz: ${dbEntry.filename}`);
    }
    if (
      !Number.isSafeInteger(dbEntry.applicationId) ||
      !Number.isSafeInteger(dbEntry.userVersion) ||
      !Number.isSafeInteger(dbEntry.schemaVersion)
    ) {
      throw failBundle('MANIFEST_INVALID', `Manifest şema sürümleri geçersiz: ${dbEntry.filename}`);
    }
    if (dbEntry.role !== 'identity') {
      if (!Number.isSafeInteger(dbEntry.eventCount) || dbEntry.eventCount < 0) {
        throw failBundle('MANIFEST_INVALID', `Manifest olay sayısı geçersiz: ${dbEntry.filename}`);
      }
      if (!Number.isSafeInteger(dbEntry.revision) || dbEntry.revision < 0) {
        throw failBundle('MANIFEST_INVALID', `Manifest revision değeri geçersiz: ${dbEntry.filename}`);
      }
    }
  }

  if (!seenRoles.has('dukkan') || !seenRoles.has('identity')) {
    throw failBundle('MANIFEST_INVALID', 'Manifest zorunlu dukkan ve identity veritabanlarını içermiyor.');
  }

  return { manifest, expectedFiles };
}

function parseAndValidateManifestBytes(manifestBytes) {
  if (!Buffer.isBuffer(manifestBytes) || manifestBytes.length <= 0 || manifestBytes.length > BUNDLE_MANIFEST_MAX_BYTES) {
    throw failBundle('MANIFEST_INVALID', 'bundle-manifest.json boyutu geçersiz.');
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw failBundle('MANIFEST_INVALID', 'bundle-manifest.json ayrıştırılamadı.');
  }
  return validateBundleManifest(manifest);
}

function validateDatabaseBuffer(dbEntry, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== dbEntry.sizeBytes) {
    throw failBundle('SIZE_MISMATCH', `${dbEntry.filename} dosya boyutu manifest ile uyuşmuyor.`);
  }
  if (sha256Buffer(bytes) !== dbEntry.sha256) {
    throw failBundle('SHA256_MISMATCH', `${dbEntry.filename} SHA-256 özeti uyuşmuyor.`);
  }
  if (bytes.subarray(0, 16).toString('utf8') !== SQLITE_HEADER_PREFIX) {
    throw failBundle('SQLITE_HEADER_INVALID', `${dbEntry.filename} SQLite dosya başlığı geçersiz.`);
  }
}

function validateBundleEntryBuffers(files) {
  for (const name of files.keys()) {
    assertSafeBasename(name);
    if (!ALLOWED_BUNDLE_FILES.has(name)) {
      throw failBundle('BUNDLE_PAYLOAD_INVALID', `Paket içinde izin verilmeyen dosya: ${name}`);
    }
  }
  if (!files.has(BUNDLE_MANIFEST_FILENAME)) {
    throw failBundle('MANIFEST_MISSING', 'bundle-manifest.json bulunamadı.');
  }
  const { manifest, expectedFiles } = parseAndValidateManifestBytes(files.get(BUNDLE_MANIFEST_FILENAME));
  const actualFiles = Array.from(files.keys()).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify([...expectedFiles].sort())) {
    throw failBundle('BUNDLE_PAYLOAD_INVALID', 'Paket dosya listesi manifest ile uyuşmuyor.');
  }
  for (const dbEntry of manifest.databases) {
    validateDatabaseBuffer(dbEntry, files.get(dbEntry.filename));
  }
  return manifest;
}

function readAndValidateBundleDir(bundleDir) {
  if (!existsSync(bundleDir) || !lstatSync(bundleDir).isDirectory()) {
    throw failBundle('BUNDLE_DIR_MISSING', 'Yedek paketi klasörü bulunamadı.');
  }
  const entries = readdirSync(bundleDir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(bundleDir, entry.name);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw failBundle('BUNDLE_PAYLOAD_INVALID', `Paket içinde beklenmeyen öğe: ${entry.name}`);
    }
    assertSafeBasename(entry.name);
    if (!lstatSync(full).isFile()) {
      throw failBundle('BUNDLE_PAYLOAD_INVALID', `Paket öğesi normal dosya değil: ${entry.name}`);
    }
  }

  const manifestFile = join(bundleDir, BUNDLE_MANIFEST_FILENAME);
  if (!existsSync(manifestFile)) {
    throw failBundle('MANIFEST_MISSING', 'bundle-manifest.json bulunamadı.');
  }
  for (const entry of entries) {
    if (!ALLOWED_BUNDLE_FILES.has(entry.name)) {
      throw failBundle('BUNDLE_PAYLOAD_INVALID', `Paket içinde izin verilmeyen dosya: ${entry.name}`);
    }
  }
  const manifestStat = lstatSync(manifestFile);
  if (manifestStat.size <= 0 || manifestStat.size > BUNDLE_MANIFEST_MAX_BYTES) {
    throw failBundle('MANIFEST_INVALID', 'bundle-manifest.json boyutu geçersiz.');
  }

  const { manifest, expectedFiles } = parseAndValidateManifestBytes(readFileSync(manifestFile));

  const actualFiles = entries.map(e => e.name).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify([...expectedFiles].sort())) {
    throw failBundle('BUNDLE_PAYLOAD_INVALID', 'Paket dosya listesi manifest ile uyuşmuyor.');
  }

  for (const dbEntry of manifest.databases) {
    const dbBytes = readFileSync(join(bundleDir, dbEntry.filename));
    try {
      validateDatabaseBuffer(dbEntry, dbBytes);
    } finally {
      dbBytes.fill(0);
    }
  }

  return manifest;
}

function buildEncryptedHeader(salt, iv, n = SCRYPT_N, r = SCRYPT_R, p = SCRYPT_P) {
  const header = Buffer.alloc(ENCRYPTED_HEADER_BYTES);
  ENCRYPTED_MAGIC.copy(header, 0);
  header.writeUInt8(ENCRYPTED_VERSION, 16);
  header.writeUInt32BE(n, 17);
  header.writeUInt32BE(r, 21);
  header.writeUInt32BE(p, 25);
  salt.copy(header, 29);
  iv.copy(header, 45);
  return header;
}

function packBundleFiles(bundleDir, filenames) {
  const chunks = [];
  try {
    const countBuf = Buffer.alloc(4);
    countBuf.writeUInt32BE(filenames.length, 0);
    chunks.push(countBuf);

    for (const filename of [...filenames].sort()) {
      assertSafeBasename(filename);
      const nameBytes = Buffer.from(filename, 'utf8');
      const dataBytes = readFileSync(join(bundleDir, filename));
      const metaBuf = Buffer.alloc(2 + nameBytes.length + 8);
      metaBuf.writeUInt16BE(nameBytes.length, 0);
      nameBytes.copy(metaBuf, 2);
      metaBuf.writeBigUInt64BE(BigInt(dataBytes.length), 2 + nameBytes.length);
      chunks.push(metaBuf, dataBytes);
    }
    return Buffer.concat(chunks);
  } finally {
    for (const chunk of chunks) {
      chunk.fill(0);
    }
  }
}

function unpackBundleFiles(plaintext) {
  if (!Buffer.isBuffer(plaintext) || plaintext.length < 4) {
    throw failBundle('BUNDLE_PAYLOAD_CORRUPT', 'Şifresi çözülen paket verisi bozuk.');
  }
  let offset = 0;
  const count = plaintext.readUInt32BE(offset);
  offset += 4;
  if (count < 2 || count > 16) {
    throw failBundle('BUNDLE_PAYLOAD_CORRUPT', 'Paket dosya sayısı geçersiz.');
  }
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (offset + 2 > plaintext.length) throw failBundle('BUNDLE_PAYLOAD_CORRUPT', 'Paket dosya başlığı kesik.');
    const nameLen = plaintext.readUInt16BE(offset);
    offset += 2;
    if (nameLen === 0 || nameLen > 255 || offset + nameLen + 8 > plaintext.length) {
      throw failBundle('BUNDLE_PAYLOAD_CORRUPT', 'Paket dosya adı uzunluğu geçersiz.');
    }
    const nameBuf = plaintext.subarray(offset, offset + nameLen);
    const name = nameBuf.toString('utf8');
    offset += nameLen;
    if (!Buffer.from(name, 'utf8').equals(nameBuf)) {
      throw failBundle('INVALID_FILENAME', 'Paket dosya adı geçerli UTF-8 değil.');
    }
    assertSafeBasename(name);
    if (files.has(name)) {
      throw failBundle('BUNDLE_PAYLOAD_CORRUPT', `Paket içinde yinelenen dosya: ${name}`);
    }
    const dataLenBig = plaintext.readBigUInt64BE(offset);
    offset += 8;
    if (dataLenBig > BigInt(plaintext.length - offset)) {
      throw failBundle('BUNDLE_PAYLOAD_CORRUPT', 'Paket dosya boyutu geçersiz.');
    }
    const dataLen = Number(dataLenBig);
    files.set(name, plaintext.subarray(offset, offset + dataLen));
    offset += dataLen;
  }
  if (offset !== plaintext.length) {
    throw failBundle('BUNDLE_PAYLOAD_CORRUPT', 'Paket sonunda beklenmeyen fazla veri var.');
  }
  return files;
}

/**
 * Encrypt a verified backup bundle directory using AES-256-GCM + scrypt with authenticated header (AAD).
 *
 * @param {object} options
 * @param {string} options.bundleDirectory
 * @param {string} options.outputFile
 * @param {string} options.passphrase
 * @param {string} [options.tempDirectory=tmpdir()]
 * @returns {Promise<{encryptedFile: string, bundleId: string, sizeBytes: number, algorithm: string, kdf: string}>}
 */
export async function encryptBackupBundle({
  bundleDirectory,
  outputFile,
  passphrase,
  tempDirectory = tmpdir()
} = {}) {
  const srcBundleDir = assertNonEmptyPath(bundleDirectory, 'Yedek paketi klasörü');
  const destFile = assertNonEmptyPath(outputFile, 'Şifreli çıktı dosyası');
  const tempBase = assertNonEmptyPath(tempDirectory, 'Geçici klasör');
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw failBundle('INVALID_PASSPHRASE', 'Şifreleme parolası boş olamaz.');
  }
  if (pathExistsOrSymlink(destFile)) {
    throw failBundle('EEXIST', 'Hedef şifreli yedek dosyası zaten mevcut.');
  }

  const manifest = readAndValidateBundleDir(srcBundleDir);
  const filenames = [BUNDLE_MANIFEST_FILENAME, ...manifest.databases.map(d => d.filename)];
  let plaintext = null;
  let passphraseBuf = null;
  let key = null;
  let stageDir = null;

  try {
    plaintext = packBundleFiles(srcBundleDir, filenames);
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const header = buildEncryptedHeader(salt, iv);
    passphraseBuf = Buffer.from(passphrase, 'utf8');
    key = await deriveKey(passphraseBuf, salt, 32, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAXMEM
    });

    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(header);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const envelope = Buffer.concat([header, ciphertext, authTag]);

    mkdirSync(tempBase, { recursive: true });
    stageDir = mkdtempSync(join(tempBase, 'backup-enc-stage-'));
    const stagedFile = join(stageDir, 'bundle.enc');
    writeFileSync(stagedFile, envelope, { flag: 'wx', mode: 0o600, flush: true });
    mkdirSync(dirname(destFile), { recursive: true });
    if (pathExistsOrSymlink(destFile)) {
      throw failBundle('EEXIST', 'Hedef şifreli yedek dosyası zaten mevcut.');
    }
    moveFileReplace(stagedFile, destFile);
    return {
      encryptedFile: destFile,
      bundleId: manifest.bundleId,
      sizeBytes: envelope.length,
      algorithm: 'aes-256-gcm',
      kdf: 'scrypt'
    };
  } finally {
    key?.fill(0);
    passphraseBuf?.fill(0);
    plaintext?.fill(0);
    removeDirSafe(stageDir);
  }
}

async function decryptToStaging(encryptedFile, passphrase, stagingDir) {
  const encPath = assertNonEmptyPath(encryptedFile, 'Şifreli yedek dosyası');
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw failBundle('INVALID_PASSPHRASE', 'Şifre çözme parolası boş olamaz.');
  }
  assertRegularNoSymlink(encPath, 'Şifreli yedek dosyası');

  const raw = readFileSync(encPath);
  if (raw.length < ENCRYPTED_HEADER_BYTES + ENCRYPTED_TAG_BYTES + 4) {
    throw failBundle('BUNDLE_DECRYPT_FAILED', 'Şifreli yedek dosyası bozuk veya eksik.');
  }

  const header = raw.subarray(0, ENCRYPTED_HEADER_BYTES);
  if (!header.subarray(0, 16).equals(ENCRYPTED_MAGIC)) {
    throw failBundle('BUNDLE_DECRYPT_FAILED', 'Şifreli yedek dosya biçimi geçersiz.');
  }
  const version = header.readUInt8(16);
  const n = header.readUInt32BE(17);
  const r = header.readUInt32BE(21);
  const p = header.readUInt32BE(25);
  if (version !== ENCRYPTED_VERSION || n !== SCRYPT_N || r !== SCRYPT_R || p < 1 || p > 4) {
    throw failBundle('BUNDLE_DECRYPT_FAILED', 'Şifreli yedek KDF parametreleri geçersiz.');
  }

  const salt = header.subarray(29, 45);
  const iv = header.subarray(45, 57);
  const ciphertext = raw.subarray(ENCRYPTED_HEADER_BYTES, raw.length - ENCRYPTED_TAG_BYTES);
  const authTag = raw.subarray(raw.length - ENCRYPTED_TAG_BYTES);

  let passphraseBuf = null;
  let key = null;
  let decUpdate = null;
  let decFinal = null;
  let plaintext = null;

  try {
    passphraseBuf = Buffer.from(passphrase, 'utf8');
    key = await deriveKey(passphraseBuf, salt, 32, {
      N: n,
      r,
      p,
      maxmem: SCRYPT_MAXMEM
    });

    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(header);
      decipher.setAuthTag(authTag);
      decUpdate = decipher.update(ciphertext);
      decFinal = decipher.final();
      plaintext = Buffer.concat([decUpdate, decFinal]);
    } catch {
      throw failBundle('BUNDLE_DECRYPT_FAILED', 'Şifre çözme başarısız: parola hatalı veya paket bozulmuş.');
    }

    const files = unpackBundleFiles(plaintext);
    validateBundleEntryBuffers(files);
    mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
    for (const [name, data] of files) {
      writeFileSync(join(stagingDir, name), data, { flag: 'wx', mode: 0o600, flush: true });
    }
    return readAndValidateBundleDir(stagingDir);
  } finally {
    key?.fill(0);
    passphraseBuf?.fill(0);
    decUpdate?.fill(0);
    decFinal?.fill(0);
    plaintext?.fill(0);
  }
}

/**
 * Decrypt and validate an AES-256-GCM encrypted backup bundle into `outputDirectory/<bundleId>`.
 * Rejects wrong passphrases, tampered headers/AAD, ciphertext, or authTags before writing to `outputDirectory`.
 *
 * @param {object} options
 * @param {string} options.encryptedFile
 * @param {string} options.outputDirectory
 * @param {string} options.passphrase
 * @param {string} [options.tempDirectory=tmpdir()]
 * @returns {Promise<{bundleId: string, bundleDirectory: string, manifestPath: string, manifest: object}>}
 */
export async function decryptBackupBundle({
  encryptedFile,
  outputDirectory,
  passphrase,
  tempDirectory = tmpdir()
} = {}) {
  const encPath = assertNonEmptyPath(encryptedFile, 'Şifreli yedek dosyası');
  const outDir = assertNonEmptyPath(outputDirectory, 'Çıktı klasörü');
  const tempBase = assertNonEmptyPath(tempDirectory, 'Geçici klasör');
  mkdirSync(tempBase, { recursive: true });
  const stageRoot = mkdtempSync(join(tempBase, 'backup-dec-stage-'));
  const stagedBundleDir = join(stageRoot, 'bundle');

  try {
    const manifest = await decryptToStaging(encPath, passphrase, stagedBundleDir);
    assertSafeBundleId(manifest.bundleId);
    mkdirSync(outDir, { recursive: true });
    const publishedDir = resolve(outDir, manifest.bundleId);
    assertChildDirectory(outDir, publishedDir);
    if (pathExistsOrSymlink(publishedDir)) {
      throw failBundle('BUNDLE_EXISTS', 'Hedef çözülmüş paket klasörü zaten mevcut.');
    }
    moveDirectoryAtomically(stagedBundleDir, publishedDir);
    return {
      bundleId: manifest.bundleId,
      bundleDirectory: publishedDir,
      manifestPath: join(publishedDir, BUNDLE_MANIFEST_FILENAME),
      manifest
    };
  } finally {
    removeDirSafe(stageRoot);
  }
}

function verifyDatabaseContentsAndReconcile(stagedFile, dbEntry) {
  const db = new DatabaseSync(stagedFile, { readOnly: true });
  try {
    const integrityRow = db.prepare('PRAGMA integrity_check').get();
    const integrity = integrityRow ? String(Object.values(integrityRow)[0]) : 'error';
    if (integrity !== 'ok') {
      throw failBundle('SQLITE_INTEGRITY_FAILED', `${dbEntry.filename} bütünlük kontrolü başarısız: ${integrity}`);
    }
    const applicationId = db.prepare('PRAGMA application_id').get().application_id;
    const userVersion = db.prepare('PRAGMA user_version').get().user_version;
    if (applicationId !== dbEntry.applicationId || userVersion !== dbEntry.userVersion) {
      throw failBundle('SCHEMA_VERSION_MISMATCH', `${dbEntry.filename} uygulama/şema sürümü uyuşmuyor.`);
    }

    const tableNames = new Set(
      db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map(r => r.name)
    );

    if (dbEntry.role === 'identity') {
      if (applicationId !== IDENTITY_APPLICATION_ID || ![1, 2, 3, 4].includes(userVersion)) {
        throw failBundle('IDENTITY_SCHEMA_INVALID', 'identity.sqlite kimlik uygulaması veya sürümü geçersiz.');
      }
      for (const reqTable of IDENTITY_REQUIRED_TABLES) {
        if (!tableNames.has(reqTable)) {
          throw failBundle('IDENTITY_SCHEMA_INVALID', `identity.sqlite tablosu eksik: ${reqTable}`);
        }
      }
      if (userVersion >= 4 && !tableNames.has('auth_audit_log')) {
        throw failBundle('IDENTITY_SCHEMA_INVALID', 'identity.sqlite tablosu eksik: auth_audit_log');
      }
      const genRow = db.prepare('SELECT generation FROM session_generation WHERE id = 1').get();
      if (!genRow || typeof genRow.generation !== 'string' || !genRow.generation) {
        throw failBundle('IDENTITY_GENERATION_INVALID', 'identity.sqlite session_generation eksik.');
      }
      const users = db.prepare('SELECT id, role, length(salt) AS saltLen, length(verifier) AS verLen FROM identity_users').all();
      for (const u of users) {
        if (!['owner', 'employee'].includes(u.role) || u.saltLen !== 16 || u.verLen !== 32) {
          throw failBundle('IDENTITY_DATA_INVALID', 'identity.sqlite kullanıcı kaydı bozuk.');
        }
      }
      db.prepare('SELECT bucket, until_ms, attempts FROM login_limits').all();
      if (userVersion >= 4) {
        db.prepare('SELECT id, created_at, event_type, outcome FROM auth_audit_log LIMIT 0').all();
      }
      return { role: 'identity', userCount: users.length };
    }

    for (const reqTable of LEDGER_REQUIRED_TABLES) {
      if (!tableNames.has(reqTable)) {
        throw failBundle('LEDGER_SCHEMA_INVALID', `${dbEntry.filename} tablosu eksik: ${reqTable}`);
      }
    }

    const revRow = db.prepare('SELECT revision FROM meta WHERE id = 1').get();
    if (!revRow || !Number.isSafeInteger(revRow.revision) || revRow.revision < 0 || revRow.revision !== dbEntry.revision) {
      throw failBundle('LEDGER_REVISION_MISMATCH', `${dbEntry.filename} revision değeri manifest ile uyuşmuyor.`);
    }

    const eventRows = db.prepare('SELECT seq, id, body FROM events ORDER BY seq').all();
    if (!Number.isSafeInteger(dbEntry.eventCount) || dbEntry.eventCount < 0 || eventRows.length !== dbEntry.eventCount) {
      throw failBundle('LEDGER_EVENT_COUNT_MISMATCH', `${dbEntry.filename} olay sayısı manifest ile uyuşmuyor.`);
    }

    const parsedEvents = [];
    for (const row of eventRows) {
      let ev;
      try {
        ev = JSON.parse(row.body);
      } catch {
        throw failBundle('LEDGER_EVENT_CORRUPT', `${dbEntry.filename} olay JSON verisi bozuk.`);
      }
      if (!ev || ev.id !== row.id) {
        throw failBundle('LEDGER_EVENT_CORRUPT', `${dbEntry.filename} olay kimliği tutarsız.`);
      }
      parsedEvents.push(ev);
    }

    let replayedState;
    try {
      replayedState = replay(parsedEvents);
    } catch (error) {
      throw failBundle('FINANCIAL_RECONCILIATION_FAILED', `${dbEntry.filename} finansal mutabakat başarısız: ${error.message}`);
    }

    for (const acc of replayedState.accounts) {
      if (acc.kind === 'asset' && (replayedState.balances[acc.id] ?? 0) < 0) {
        throw failBundle('FINANCIAL_INVARIANT_FAILED', `${dbEntry.filename} varlık hesabı negatif bakiye içeriyor: ${acc.id}`);
      }
    }

    const pendingRows = db.prepare('SELECT id, status, type, command_json, summary_json FROM pending_submissions').all();
    for (const ps of pendingRows) {
      if (!['pending', 'approved', 'rejected'].includes(ps.status) || !['sale', 'purchase', 'dailyCount'].includes(ps.type)) {
        throw failBundle('PENDING_SUBMISSIONS_INVALID', `${dbEntry.filename} bekleyen onay satırı geçersiz.`);
      }
      try {
        JSON.parse(ps.command_json);
        JSON.parse(ps.summary_json);
      } catch {
        throw failBundle('PENDING_SUBMISSIONS_INVALID', `${dbEntry.filename} bekleyen onay JSON verisi bozuk.`);
      }
    }

    const archiveRows = db.prepare('SELECT id, body FROM restore_archive').all();
    for (const ar of archiveRows) {
      try {
        JSON.parse(ar.body);
      } catch {
        throw failBundle('RESTORE_ARCHIVE_INVALID', `${dbEntry.filename} geri yükleme arşivi bozuk.`);
      }
    }

    return {
      role: dbEntry.role,
      revision: revRow.revision,
      eventCount: parsedEvents.length,
      pendingCount: pendingRows.length,
      restoreArchiveCount: archiveRows.length,
      date: replayedState.date
    };
  } finally {
    db.close();
  }
}

/**
 * Restore a plain or encrypted backup bundle into `targetDirectory`.
 * Performs complete validation, financial replay reconciliation, and session_generation rotation
 * inside an isolated staging directory before atomically replacing `targetDirectory` with rollback safety.
 *
 * @param {object} options
 * @param {string} [options.bundleDirectory]
 * @param {string} [options.encryptedFile]
 * @param {string} [options.passphrase]
 * @param {string} options.targetDirectory
 * @param {string} [options.tempDirectory=tmpdir()]
 * @returns {Promise<{ok: boolean, bundleId: string, targetDirectory: string, restoredDatabases: string[], sessionGenerationRotated: boolean, newSessionGeneration: string, reconciliations: object}>}
 */
export async function restoreBackupBundle({
  bundleDirectory,
  encryptedFile,
  passphrase,
  targetDirectory,
  tempDirectory = tmpdir()
} = {}) {
  const destDir = assertNonEmptyPath(targetDirectory, 'Hedef veri klasörü');
  const tempBase = assertNonEmptyPath(tempDirectory, 'Geçici klasör');
  const hasBundleDir = typeof bundleDirectory === 'string' && bundleDirectory.trim().length > 0;
  const hasEncFile = typeof encryptedFile === 'string' && encryptedFile.trim().length > 0;
  if (hasBundleDir === hasEncFile) {
    throw failBundle('INVALID_OPTIONS', 'bundleDirectory veya encryptedFile seçeneklerinden tam olarak biri verilmelidir.');
  }
  const srcDir = hasBundleDir ? assertNonEmptyPath(bundleDirectory, 'Yedek paketi klasörü') : null;
  const encPath = hasEncFile ? assertNonEmptyPath(encryptedFile, 'Şifreli yedek dosyası') : null;

  mkdirSync(tempBase, { recursive: true });
  const stagingRoot = mkdtempSync(join(tempBase, 'backup-restore-stage-'));
  const stagedBundleDir = join(stagingRoot, 'bundle');
  const preparedDir = join(stagingRoot, 'prepared');
  const rollbackDir = join(stagingRoot, 'rollback');

  try {
    let manifest;
    if (hasEncFile) {
      manifest = await decryptToStaging(encPath, passphrase, stagedBundleDir);
    } else {
      manifest = readAndValidateBundleDir(srcDir);
      const expectedFiles = [BUNDLE_MANIFEST_FILENAME, ...manifest.databases.map(d => d.filename)];
      mkdirSync(stagedBundleDir, { recursive: true });
      for (const fname of expectedFiles) {
        const srcFile = join(srcDir, fname);
        assertRegularNoSymlink(srcFile, fname);
        copyFileSync(srcFile, join(stagedBundleDir, fname));
      }
      manifest = readAndValidateBundleDir(stagedBundleDir);
    }

    const reconciliations = {};
    for (const dbEntry of manifest.databases) {
      reconciliations[dbEntry.role] = verifyDatabaseContentsAndReconcile(
        join(stagedBundleDir, dbEntry.filename),
        dbEntry
      );
    }

    mkdirSync(preparedDir, { recursive: true });
    for (const dbEntry of manifest.databases) {
      copyFileSync(join(stagedBundleDir, dbEntry.filename), join(preparedDir, dbEntry.filename));
    }

    // Smoke-open each prepared DB via Repository / IdentityStore and rotate session_generation.
    for (const dbEntry of manifest.databases) {
      const prepFile = join(preparedDir, dbEntry.filename);
      if (dbEntry.role === 'identity') {
        const store = new IdentityStore(preparedDir);
        try {
          store.needsSetup();
          store.listUsers();
        } finally {
          store.close();
        }
      } else {
        const repo = new Repository(prepFile, dbEntry.role);
        try {
          const st = repo.state();
          if (st.revision !== dbEntry.revision) {
            throw failBundle('LEDGER_REVISION_MISMATCH', `${dbEntry.filename} state revision uyuşmuyor.`);
          }
          repo.listPending({ status: 'all' });
        } finally {
          repo.close();
        }
      }
      const checkpointDb = new DatabaseSync(prepFile);
      try {
        checkpointDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      } finally {
        checkpointDb.close();
      }
      removeSidecars(prepFile);
    }

    const newSessionGeneration = randomUUID();
    const prepIdentityFile = join(preparedDir, 'identity.sqlite');
    const idDb = new DatabaseSync(prepIdentityFile);
    try {
      idDb.exec('BEGIN IMMEDIATE');
      const res = idDb.prepare('UPDATE session_generation SET generation = ? WHERE id = 1').run(newSessionGeneration);
      if (res.changes !== 1) {
        throw failBundle('IDENTITY_GENERATION_INVALID', 'session_generation yenilenemedi.');
      }
      const integrityRow = idDb.prepare('PRAGMA integrity_check').get();
      if (!integrityRow || String(Object.values(integrityRow)[0]) !== 'ok') {
        throw failBundle('SQLITE_INTEGRITY_FAILED', 'identity.sqlite oturum yenileme sonrası bütünlük kontrolü başarısız.');
      }
      idDb.exec('COMMIT');
      idDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch (error) {
      if (idDb.isTransaction) {
        try { idDb.exec('ROLLBACK'); } catch {}
      }
      throw error;
    } finally {
      idDb.close();
    }
    removeSidecars(prepIdentityFile);

    // Atomic / rollback-safe swap into targetDirectory.
    mkdirSync(destDir, { recursive: true });
    mkdirSync(rollbackDir, { recursive: true });
    for (const managedName of MANAGED_DB_FILES) {
      const targetPath = join(destDir, managedName);
      if (pathExistsOrSymlink(targetPath)) {
        const st = lstatSync(targetPath);
        if (st.isSymbolicLink() || !st.isFile()) {
          throw failBundle('INVALID_FILE', `Hedef klasörde geçersiz dosya veya sembolik bağlantı: ${managedName}`);
        }
      }
    }
    const movedBackups = [];
    const placedTargets = [];

    try {
      for (const managedName of MANAGED_DB_FILES) {
        const targetPath = join(destDir, managedName);
        if (pathExistsOrSymlink(targetPath)) {
          const backupPath = join(rollbackDir, managedName);
          moveFileReplace(targetPath, backupPath);
          movedBackups.push({ targetPath, backupPath });
        }
      }

      for (const dbEntry of manifest.databases) {
        const srcPrep = join(preparedDir, dbEntry.filename);
        const destTarget = join(destDir, dbEntry.filename);
        moveFileReplace(srcPrep, destTarget);
        placedTargets.push(destTarget);
      }
    } catch (swapError) {
      for (const placed of placedTargets) {
        if (pathExistsOrSymlink(placed)) {
          try { unlinkSync(placed); } catch {}
        }
      }
      for (const { targetPath, backupPath } of movedBackups) {
        if (pathExistsOrSymlink(backupPath)) {
          try { moveFileReplace(backupPath, targetPath); } catch {}
        }
      }
      throw swapError;
    }

    return {
      ok: true,
      bundleId: manifest.bundleId,
      targetDirectory: destDir,
      restoredDatabases: manifest.databases.map(d => d.filename),
      sessionGenerationRotated: true,
      newSessionGeneration,
      reconciliations
    };
  } finally {
    removeDirSafe(stagingRoot);
  }
}

/**
 * Probe local Restic availability against `scripts/restic-pilot-tool.json` or `RESTIC_PILOT_BINARY`.
 * Never crashes when binary is absent; transparently returns `{ available: false, status: 'BLOCKED (binary eksik)', ... }`.
 *
 * @param {object} [options]
 * @param {string} [options.resticBinary]
 * @returns {{available: boolean, status: string, reason: string|null, expectedVersion: string, expectedSha256: string, binaryPath: string}}
 */
export function checkResticPilotAvailability({ resticBinary } = {}) {
  if (resticBinary !== undefined) {
    if (typeof resticBinary !== 'string' || !resticBinary.trim() || resticBinary.includes('\0') || resticBinary !== resticBinary.trim()) {
      throw failBundle('INVALID_PATH', 'Restic ikili dosyası geçerli bir dosya yolu olmalı.');
    }
    assertSafePathSegments(resticBinary, resolve(repoRoot, resticBinary), 'Restic ikili dosyası');
  }
  let pin;
  try {
    pin = JSON.parse(readFileSync(join(repoRoot, 'scripts', 'restic-pilot-tool.json'), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return {
      available: false,
      status: 'BLOCKED (manifest geçersiz)',
      reason: 'PILOT_TOOL_MANIFEST_INVALID',
      expectedVersion: 'unknown',
      expectedSha256: '',
      binaryPath: ''
    };
  }
  const candidate = resticBinary || process.env.RESTIC_PILOT_BINARY || pin.binaryPath;
  if (typeof candidate !== 'string' || !candidate.trim() || candidate.includes('\0') || candidate !== candidate.trim()) {
    throw failBundle('INVALID_PATH', 'Restic ikili dosyası geçerli bir dosya yolu olmalı.');
  }
  const resolved = resolve(repoRoot, candidate);
  assertSafePathSegments(candidate, resolved, 'Restic ikili dosyası');
  if (!existsSync(resolved) || !lstatSync(resolved).isFile()) {
    return {
      available: false,
      status: 'BLOCKED (binary eksik)',
      reason: 'PILOT_TOOL_UNAVAILABLE',
      expectedVersion: pin.version,
      expectedSha256: pin.binarySha256,
      binaryPath: pin.binaryPath
    };
  }
  const actualHash = sha256Buffer(readFileSync(resolved)).toUpperCase();
  if (actualHash !== String(pin.binarySha256 || '').toUpperCase()) {
    return {
      available: false,
      status: 'BLOCKED (binary hash uyumsuz)',
      reason: 'PILOT_TOOL_HASH_MISMATCH',
      expectedVersion: pin.version,
      expectedSha256: pin.binarySha256,
      binaryPath: pin.binaryPath
    };
  }
  return {
    available: true,
    status: 'AVAILABLE',
    reason: null,
    expectedVersion: pin.version,
    expectedSha256: pin.binarySha256,
    binaryPath: resolved
  };
}

/**
 * Conditionally verify Restic encrypted backup + wrong-key rejection when pinned binary is present.
 * Returns transparent `{ available: false, verified: false, status: 'BLOCKED (binary eksik)' }` when absent.
 *
 * @param {object} options
 * @param {string} options.bundleDirectory
 * @param {string} options.passphrase
 * @param {string} [options.resticBinary]
 * @param {string} [options.tempDirectory=tmpdir()]
 */
export function verifyResticBundleEncryption({
  bundleDirectory,
  passphrase,
  resticBinary,
  tempDirectory = tmpdir()
} = {}) {
  const srcDir = assertNonEmptyPath(bundleDirectory, 'Yedek paketi klasörü');
  const tempBase = assertNonEmptyPath(tempDirectory, 'Geçici klasör');
  const probe = checkResticPilotAvailability({ resticBinary });
  if (!probe.available) {
    return {
      available: false,
      verified: false,
      status: probe.status,
      reason: probe.reason,
      expectedVersion: probe.expectedVersion
    };
  }
  if (typeof passphrase !== 'string' || !passphrase.length) {
    throw failBundle('INVALID_PASSPHRASE', 'Restic parolası boş olamaz.');
  }
  readAndValidateBundleDir(srcDir);

  mkdirSync(tempBase, { recursive: true });
  const stage = mkdtempSync(join(tempBase, 'restic-bundle-pilot-'));
  try {
    const repoDir = join(stage, 'restic-repo');
    const keyFile = join(stage, 'key');
    const wrongKeyFile = join(stage, 'wrong-key');
    const restoreDir = join(stage, 'restored');
    const procTemp = join(stage, 'proc-temp');
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(restoreDir, { recursive: true });
    mkdirSync(procTemp, { recursive: true });
    writeFileSync(keyFile, `${passphrase}\n`, { flag: 'wx', mode: 0o600 });
    writeFileSync(wrongKeyFile, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });

    const env = {
      SystemRoot: process.env.SystemRoot || 'C:\\Windows',
      WINDIR: process.env.WINDIR || 'C:\\Windows',
      TEMP: procTemp,
      TMP: procTemp
    };
    const runRestic = (args, key = keyFile, cwd = srcDir) => execFileSync(
      probe.binaryPath,
      ['--repo', repoDir, '--password-file', key, '--no-cache', ...args],
      { cwd, env, windowsHide: true, encoding: 'utf8', timeout: 45000 }
    );

    runRestic(['init', '--json']);
    const backupOut = runRestic(['backup', '--json', '.']);
    const summary = backupOut.split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l)).find(v => v.message_type === 'summary');
    if (!summary?.snapshot_id) {
      throw failBundle('RESTIC_SNAPSHOT_MISSING', 'Restic snapshot kimliği alınamadı.');
    }

    let wrongKeyRejected = false;
    try {
      runRestic(['snapshots', '--json'], wrongKeyFile);
    } catch {
      wrongKeyRejected = true;
    }
    if (!wrongKeyRejected) {
      throw failBundle('RESTIC_WRONG_KEY_ACCEPTED', 'Restic yanlış parolayı reddetmedi.');
    }

    runRestic(['restore', summary.snapshot_id, '--target', restoreDir]);
    runRestic(['check', '--read-data']);

    return {
      available: true,
      verified: true,
      status: 'VERIFIED',
      reason: null,
      snapshotId: summary.snapshot_id,
      wrongKeyRejected
    };
  } finally {
    removeDirSafe(stage);
  }
}

function parseCliArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (!flag?.startsWith('--') || value === undefined) {
      throw failBundle('INVALID_CLI_ARGS', 'Geçersiz komut satırı argümanı.');
    }
    opts[flag.slice(2)] = value;
  }
  return { command, opts };
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  try {
    const { command, opts } = parseCliArgs(process.argv.slice(2));
    const readPassphraseFromEnv = () => {
      const envName = opts['passphrase-env'];
      if (!envName || !process.env[envName]) {
        throw failBundle('INVALID_PASSPHRASE', '--passphrase-env ile tanımlı bir ortam değişkeni gerekli.');
      }
      return process.env[envName];
    };
    let output;
    if (command === 'create') {
      output = await createBackupBundle({
        dataDirectory: opts['data-dir'],
        outputDirectory: opts['out-dir'],
        maxRetries: opts['max-retries'] !== undefined ? Number(opts['max-retries']) : 3,
        ...(opts['temp-dir'] !== undefined ? { tempDirectory: opts['temp-dir'] } : {})
      });
    } else if (command === 'encrypt') {
      output = await encryptBackupBundle({
        bundleDirectory: opts['bundle-dir'],
        outputFile: opts['out-file'],
        passphrase: readPassphraseFromEnv(),
        ...(opts['temp-dir'] !== undefined ? { tempDirectory: opts['temp-dir'] } : {})
      });
    } else if (command === 'decrypt') {
      output = await decryptBackupBundle({
        encryptedFile: opts['encrypted-file'],
        outputDirectory: opts['out-dir'],
        passphrase: readPassphraseFromEnv(),
        ...(opts['temp-dir'] !== undefined ? { tempDirectory: opts['temp-dir'] } : {})
      });
    } else if (command === 'restore') {
      output = await restoreBackupBundle({
        bundleDirectory: opts['bundle-dir'],
        encryptedFile: opts['encrypted-file'],
        passphrase: opts['encrypted-file'] ? readPassphraseFromEnv() : undefined,
        targetDirectory: opts['target-dir'],
        ...(opts['temp-dir'] !== undefined ? { tempDirectory: opts['temp-dir'] } : {})
      });
    } else if (command === 'check-restic') {
      output = checkResticPilotAvailability({ resticBinary: opts['restic-bin'] });
    } else {
      throw failBundle('UNKNOWN_COMMAND', 'Desteklenen komutlar: create, encrypt, decrypt, restore, check-restic');
    }
    console.log(JSON.stringify(output, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error?.code || 'BACKUP_BUNDLE_FAILED', error: error?.message || 'İşlem başarısız.' }));
    process.exitCode = 1;
  }
}
