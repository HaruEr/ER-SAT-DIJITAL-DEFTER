import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReportApp, validateReportConfig } from './report-server.mjs';

const MAX_CONFIG_BYTES = 16 * 1024;
const CONFIG_FIELDS = ['schemaVersion', 'enabled', 'origin', 'allowedLogins', 'dataDirectory', 'port'];
const TAILSCALE_EXPLICIT_FIELDS = ['schemaVersion', 'enabled', 'authProvider', 'origin', 'allowedLogins', 'dataDirectory', 'port'];
const CLOUDFLARE_CONFIG_FIELDS = ['schemaVersion', 'enabled', 'authProvider', 'origin', 'cfTeamDomain', 'cfAud', 'allowedLogins', 'dataDirectory', 'port'];
const FAILURE = 'Rapor portalı başlatılamadı. Yerel başlangıç ayarını ve rapor portunu kontrol edin.';
const configurationError = () => new Error('Rapor başlangıç ayarı geçersiz.');
const startupError = () => new Error(FAILURE);

function hasExactKeys(value, fields) {
  return Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
}

export function validateLauncherConfig(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1 || value.enabled !== true || value.port !== 4318) {
      throw configurationError();
    }
    if (!Object.hasOwn(value, 'authProvider')) {
      if (!hasExactKeys(value, CONFIG_FIELDS)) throw configurationError();
      const validated = validateReportConfig(value);
      return {
        schemaVersion: 1,
        enabled: true,
        origin: validated.origin,
        allowedLogins: [...validated.allowedLogins],
        dataDirectory: validated.dataDirectory,
        port: 4318
      };
    }
    if (value.authProvider === 'tailscale') {
      if (!hasExactKeys(value, TAILSCALE_EXPLICIT_FIELDS)) throw configurationError();
      const validated = validateReportConfig(value);
      return {
        schemaVersion: 1,
        enabled: true,
        authProvider: 'tailscale',
        origin: validated.origin,
        allowedLogins: [...validated.allowedLogins],
        dataDirectory: validated.dataDirectory,
        port: 4318
      };
    }
    if (value.authProvider === 'cloudflare-access') {
      if (!hasExactKeys(value, CLOUDFLARE_CONFIG_FIELDS)) throw configurationError();
      const validated = validateReportConfig(value);
      return {
        schemaVersion: 1,
        enabled: true,
        authProvider: 'cloudflare-access',
        origin: validated.origin,
        cfTeamDomain: validated.cfTeamDomain,
        cfAud: value.cfAud,
        allowedLogins: [...validated.allowedLogins],
        dataDirectory: validated.dataDirectory,
        port: 4318
      };
    }
    throw configurationError();
  } catch { throw configurationError(); }
}

function requireDataDirectory(config) {
  try { if (!statSync(config.dataDirectory).isDirectory()) throw configurationError(); }
  catch { throw configurationError(); }
}

export function readLauncherConfig(filename) {
  try {
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw configurationError();
    const descriptor = openSync(filename, 'r');
    let content;
    try {
      const info = fstatSync(descriptor);
      if (!info.isFile() || info.size > MAX_CONFIG_BYTES) throw configurationError();
      // Bound the actual read as well as stat: a file growing concurrently stays bounded.
      const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1); let length = 0;
      while (length < buffer.length) {
        const count = readSync(descriptor, buffer, length, buffer.length - length, null);
        if (!count) break;
        length += count;
      }
      if (length > MAX_CONFIG_BYTES) throw configurationError();
      content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
    } finally { closeSync(descriptor); }
    const config = validateLauncherConfig(JSON.parse(content));
    requireDataDirectory(config);
    return config;
  } catch { throw configurationError(); }
}

export function createReportLauncher(value, { createApp = createReportApp, signals = process, jwksProvider = undefined } = {}) {
  const config = validateLauncherConfig(value); requireDataDirectory(config);
  let app;
  const appOptions = {
    enabled: true,
    origin: config.origin,
    allowedLogins: config.allowedLogins,
    dataDirectory: config.dataDirectory,
    ...(Object.hasOwn(config, 'authProvider') ? { authProvider: config.authProvider } : {}),
    ...(config.authProvider === 'cloudflare-access'
      ? {
          cfTeamDomain: config.cfTeamDomain,
          cfAud: config.cfAud,
          ...(jwksProvider !== undefined ? { jwksProvider } : {})
        }
      : {})
  };
  try { app = createApp(appOptions); }
  catch { throw startupError(); }
  let startPromise, closePromise, stopped = false;
  const onSignal = () => { void close().catch(() => { console.error(FAILURE); process.exitCode = 1; }); };
  function close() {
    if (closePromise) return closePromise;
    stopped = true;
    for (const signal of ['SIGINT', 'SIGTERM']) signals.removeListener(signal, onSignal);
    closePromise = new Promise((resolve, reject) => {
      try {
        app.server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(startupError()) : resolve());
      } catch { reject(startupError()); }
    });
    return closePromise;
  }
  function start() {
    if (startPromise) return startPromise;
    startPromise = (async () => {
      try {
        if (stopped) throw startupError();
        // createReportApp.listen binds 127.0.0.1; no editor server is imported.
        await app.listen(config.port);
        for (const signal of ['SIGINT', 'SIGTERM']) signals.once(signal, onSignal);
        return launcher;
      } catch {
        await close().catch(() => {});
        throw startupError();
      }
    })();
    return startPromise;
  }
  const launcher = { server: app.server, repositories: app.repositories, start, close };
  return launcher;
}

export async function startReportLauncher(filename, options) {
  const launcher = createReportLauncher(readLauncherConfig(filename), options);
  await launcher.start();
  return launcher;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--config') throw configurationError();
    await startReportLauncher(args[1]);
    console.log('Salt okunur rapor portalı yerel arayüzde hazır.');
  } catch {
    console.error(FAILURE);
    process.exitCode = 1;
  }
}
