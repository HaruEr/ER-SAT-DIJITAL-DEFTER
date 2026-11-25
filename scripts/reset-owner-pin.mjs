import { closeSync, existsSync, lstatSync, openSync, readSync, statSync } from 'node:fs';
import { join, resolve, win32 as win32Path } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IdentityStore } from '../identity.mjs';

const SQLITE_HEADER_PREFIX = 'SQLite format 3\0';
const WIN32_ILLEGAL_CHAR_RE = /[\x00-\x1f\x7f\\/:*?"<>|]/;
const CONTROL_OR_BIDI_RE = /[\u0080-\u009f\u202a-\u202e\u2066-\u2069]/;
const WINDOWS_RESERVED_STEM_RE = /^(?:con|prn|aux|nul|com[0-9\u00B2\u00B3\u00B9]|lpt[0-9\u00B2\u00B3\u00B9]|conin\$|conout\$)$/i;
const WIN32_DEVICE_NAMESPACE_RE = /^[\\/]{2}[?.](?:[\\/]|$)/;
const WIN32_DRIVE_ROOT_RE = /^[A-Za-z]:[\\/]?$/;

const pathKey = value => (process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value));
const samePath = (a, b) => pathKey(a) === pathKey(b);

function cliError(code, message) {
  return Object.assign(new Error(message), { code });
}

function isUnsafeWin32Segment(segment, { allowDotNavigation = false } = {}) {
  if (!segment) return false;
  if (segment === '.' || segment === '..') return !allowDotNavigation;
  if (segment !== segment.trim()) return true;
  if (segment.endsWith('.')) return true;
  if (WIN32_ILLEGAL_CHAR_RE.test(segment)) return true;
  if (CONTROL_OR_BIDI_RE.test(segment)) return true;
  const cut = segment.search(/[.:]/);
  const stem = (cut === -1 ? segment : segment.slice(0, cut)).replace(/[\s.]+$/u, '');
  return WINDOWS_RESERVED_STEM_RE.test(stem);
}

function validatePathTree(pathValue, { allowDotNavigation }) {
  if (WIN32_DEVICE_NAMESPACE_RE.test(pathValue)) {
    throw cliError('INVALID_PATH', 'Veri klasörü Win32 aygıt ad alanı içeremez.');
  }
  const { root } = win32Path.parse(pathValue);
  if (root) {
    if (WIN32_DEVICE_NAMESPACE_RE.test(root)) {
      throw cliError('INVALID_PATH', 'Veri klasörü Win32 aygıt ad alanı içeremez.');
    }
    const isSlashRoot = root === '/' || root === '\\';
    const isDriveRoot = WIN32_DRIVE_ROOT_RE.test(root);
    if (!isSlashRoot && !isDriveRoot) {
      if (!/^(?:\\\\|\/\/)/.test(root)) {
        throw cliError('INVALID_PATH', 'Veri klasörü geçersiz bir kök yolu içeriyor.');
      }
      const uncParts = root.replace(/^[\\/]{2}/, '').split(/[\\/]+/).filter(Boolean);
      if (uncParts.length !== 2 || uncParts.some(part => isUnsafeWin32Segment(part, { allowDotNavigation: false }))) {
        throw cliError('INVALID_PATH', 'Veri klasörü geçersiz bir UNC kök yolu içeriyor.');
      }
    }
  }
  const remainder = pathValue.slice(root.length);
  for (const segment of remainder.split(/[\\/]+/)) {
    if (!segment) continue;
    if (isUnsafeWin32Segment(segment, { allowDotNavigation })) {
      throw cliError('INVALID_PATH', 'Veri klasörü geçersiz veya ayrılmış yol bölümü içeriyor.');
    }
  }
}

function assertExistingIdentityDataDir(rawDataDir) {
  if (
    typeof rawDataDir !== 'string' ||
    !rawDataDir.trim() ||
    rawDataDir.includes('\0') ||
    rawDataDir !== rawDataDir.trim() ||
    rawDataDir === ':memory:'
  ) {
    throw cliError('INVALID_PATH', 'Geçerli bir --data-dir klasör yolu gerekli.');
  }
  const dataDir = resolve(rawDataDir);
  if (!dataDir.trim() || dataDir.includes('\0') || dataDir !== dataDir.trim()) {
    throw cliError('INVALID_PATH', 'Geçerli bir --data-dir klasör yolu gerekli.');
  }
  validatePathTree(rawDataDir, { allowDotNavigation: true });
  validatePathTree(dataDir, { allowDotNavigation: false });

  let dirStat;
  try {
    dirStat = lstatSync(dataDir);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw cliError('MISSING_DATA_DIRECTORY', 'Belirtilen veri klasörü bulunamadı.');
    }
    throw error;
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw cliError('INVALID_PATH', 'Veri klasörü sembolik bağ olamaz ve geçerli bir dizin olmalıdır.');
  }

  const identityFile = join(dataDir, 'identity.sqlite');
  if (!existsSync(identityFile)) {
    throw cliError('IDENTITY_DB_MISSING', 'Belirtilen veri klasöründe identity.sqlite bulunamadı.');
  }
  const fileLstat = lstatSync(identityFile);
  if (fileLstat.isSymbolicLink() || !fileLstat.isFile()) {
    throw cliError('IDENTITY_DB_INVALID', 'identity.sqlite sembolik bağ olamaz ve düzenli bir dosya olmalıdır.');
  }
  const fileStat = statSync(identityFile);
  if (fileStat.size < 100) {
    throw cliError('SQLITE_HEADER_INVALID', 'identity.sqlite geçerli bir SQLite dosyası değil.');
  }
  const fd = openSync(identityFile, 'r');
  try {
    const header = Buffer.alloc(16);
    const bytesRead = readSync(fd, header, 0, 16, 0);
    if (bytesRead < 16 || header.toString('ascii') !== SQLITE_HEADER_PREFIX) {
      throw cliError('SQLITE_HEADER_INVALID', 'identity.sqlite SQLite başlığı geçersiz.');
    }
  } finally {
    closeSync(fd);
  }

  return dataDir;
}

export function parseResetOwnerPinArgs(argv) {
  const opts = {
    dataDir: undefined,
    pin: undefined,
    pinEnv: undefined,
    mustChangePin: false,
    help: false
  };
  const seen = new Set();

  const assignUnique = (key, value) => {
    if (seen.has(key)) {
      throw cliError('INVALID_CLI_ARGS', `Yinelenen parametre: --${key}`);
    }
    seen.add(key);
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }
    if (arg === '--must-change-pin') {
      assignUnique('must-change-pin', true);
      opts.mustChangePin = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      throw cliError('INVALID_CLI_ARGS', 'Desteklenmeyen konumsal argüman.');
    }
    const eqIndex = arg.indexOf('=');
    const flagName = eqIndex === -1 ? arg.slice(2) : arg.slice(2, eqIndex);
    let value = eqIndex === -1 ? undefined : arg.slice(eqIndex + 1);
    if (!['data-dir', 'pin', 'pin-env'].includes(flagName)) {
      throw cliError('INVALID_CLI_ARGS', `Bilinmeyen parametre: --${flagName}`);
    }
    if (eqIndex === -1) {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        throw cliError('INVALID_CLI_ARGS', `--${flagName} için değer gerekli.`);
      }
      value = argv[++i];
    }
    if (flagName === 'data-dir') {
      opts.dataDir = assignUnique('data-dir', value);
    } else if (flagName === 'pin') {
      opts.pin = assignUnique('pin', value);
    } else if (flagName === 'pin-env') {
      opts.pinEnv = assignUnique('pin-env', value);
    }
  }

  if (!opts.help) {
    if (opts.dataDir === undefined) {
      throw cliError('INVALID_CLI_ARGS', '--data-dir parametresi zorunludur.');
    }
    if (opts.pin !== undefined && opts.pinEnv !== undefined) {
      throw cliError('INVALID_CLI_ARGS', '--pin ve --pin-env birlikte kullanılamaz.');
    }
  }
  return opts;
}

function readPipedStdinPin(stdin) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = () => {
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.off('error', onError);
    };

    const fail = err => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(err);
    };

    const onData = chunk => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      totalBytes += buf.length;
      if (totalBytes > 1024) {
        fail(cliError('INVALID_PIN', 'PIN girişi çok uzun.'));
        return;
      }
      chunks.push(buf);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const raw = Buffer.concat(chunks).toString('utf8').replace(/(?:\r?\n)+$/, '');
      if (!raw) {
        rejectPromise(cliError('INVALID_PIN', 'PIN kodu girilmedi.'));
        return;
      }
      resolvePromise(raw);
    };

    const onError = err => fail(err);

    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('error', onError);
    stdin.resume();
  });
}

function readTtyHiddenPin(stdin, stderr) {
  return new Promise((resolvePromise, rejectPromise) => {
    stderr.write('Yeni yönetici PIN (6 hane): ');
    const chars = [];
    const hadRawMode = typeof stdin.setRawMode === 'function';
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      stdin.off('data', onData);
      stdin.off('error', onError);
      if (hadRawMode) {
        try { stdin.setRawMode(false); } catch {}
      }
      stdin.pause();
      if (err) rejectPromise(err);
      else resolvePromise(value);
    };

    const onError = err => finish(err);

    const onData = chunk => {
      const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (str.startsWith('\u001b')) {
        return;
      }
      for (const ch of str) {
        if (ch === '\u0003') {
          stderr.write('\n');
          finish(cliError('CANCELLED', 'İşlem iptal edildi.'));
          return;
        }
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          stderr.write('\n');
          finish(null, chars.join(''));
          return;
        }
        if (ch === '\b' || ch === '\u007f') {
          chars.pop();
          continue;
        }
        const cp = ch.codePointAt(0);
        if (cp !== undefined && cp >= 0x20) {
          if (chars.length >= 64) {
            stderr.write('\n');
            finish(cliError('INVALID_PIN', 'PIN kodu tam 6 haneli rakamdan oluşmalı.'));
            return;
          }
          chars.push(ch);
        }
      }
    };

    try {
      if (hadRawMode) stdin.setRawMode(true);
      stdin.setEncoding('utf8');
      stdin.on('data', onData);
      stdin.on('error', onError);
      stdin.resume();
    } catch (error) {
      finish(error);
    }
  });
}

async function resolvePinInput(opts, stdin = process.stdin, stderr = process.stderr) {
  let pin;
  if (opts.pin !== undefined) {
    pin = opts.pin;
  } else if (opts.pinEnv !== undefined) {
    const envName = opts.pinEnv;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName) || typeof process.env[envName] !== 'string' || !process.env[envName]) {
      throw cliError('INVALID_PIN', '--pin-env ile tanımlı geçerli bir ortam değişkeni gerekli.');
    }
    pin = process.env[envName];
  } else if (stdin.isTTY) {
    pin = await readTtyHiddenPin(stdin, stderr);
  } else {
    pin = await readPipedStdinPin(stdin);
  }

  if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
    throw cliError('INVALID_PIN', 'PIN kodu tam 6 haneli rakamdan oluşmalı.');
  }
  return pin;
}

export function formatHelpText() {
  return [
    'Kullanım: node scripts/reset-owner-pin.mjs --data-dir <klasor> [--pin <6_hane> | --pin-env <ENV>] [--must-change-pin]',
    '',
    'Seçenekler:',
    '  --data-dir <klasor>   Mevcut identity.sqlite dosyasını içeren veri klasörü (zorunlu)',
    '  --pin <6_hane>        Yeni 6 haneli yönetici PIN kodu',
    '  --pin-env <ENV>       Yeni 6 haneli PIN kodunu içeren ortam değişkeni adı',
    '  --must-change-pin     Sonraki ilk girişte yöneticiyi PIN değiştirmeye zorlar',
    '  --help, -h            Bu yardım metnini gösterir'
  ].join('\n');
}

export async function runResetOwnerPin(argv, { stdin = process.stdin, stderr = process.stderr } = {}) {
  const opts = parseResetOwnerPinArgs(argv);
  if (opts.help) {
    return { help: true, text: formatHelpText() };
  }
  const dataDir = assertExistingIdentityDataDir(opts.dataDir);
  const pin = await resolvePinInput(opts, stdin, stderr);

  const store = new IdentityStore(dataDir);
  try {
    const result = await store.resetOwnerPin({
      pin,
      mustChangePin: opts.mustChangePin,
      source: 'cli:reset-owner-pin'
    });
    return {
      ok: true,
      dataDirectory: dataDir,
      ownerId: result.ownerId,
      name: result.name,
      mustChangePin: result.mustChangePin,
      invalidatedSessions: result.invalidatedSessions
    };
  } finally {
    store.close();
  }
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  try {
    const output = await runResetOwnerPin(process.argv.slice(2));
    if (output?.help) {
      console.log(output.text);
    } else {
      console.log(JSON.stringify(output, null, 2));
    }
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      code: error?.code || 'RESET_OWNER_PIN_FAILED',
      error: error?.message || 'İşlem başarısız.'
    }));
    process.exitCode = 1;
  }
}
