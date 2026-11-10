import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReportApp, validateReportConfig } from './report-server.mjs';

const MAX_CONFIG_BYTES = 16 * 1024;
const CONFIG_FIELDS = ['schemaVersion', 'enabled', 'origin', 'allowedLogins', 'dataDirectory', 'port'];
const FAILURE = 'Rapor portalı başlatılamadı. Yerel başlangıç ayarını ve rapor portunu kontrol edin.';
const configurationError = () => new Error('Rapor başlangıç ayarı geçersiz.');
const startupError = () => new Error(FAILURE);

export function validateLauncherConfig(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== CONFIG_FIELDS.length || !CONFIG_FIELDS.every(key => Object.hasOwn(value, key)) || value.schemaVersion !== 1 || value.enabled !== true || value.port !== 4318) throw configurationError();
    const validated = validateReportConfig(value);
    return { schemaVersion: 1, enabled: true, origin: validated.origin, allowedLogins: [...validated.allowedLogins], dataDirectory: validated.dataDirectory, port: 4318 };
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

export function createReportLauncher(value, { createApp = createReportApp, signals = process } = {}) {
  const config = validateLauncherConfig(value); requireDataDirectory(config);
  let app;
  try { app = createApp({ enabled: true, origin: config.origin, allowedLogins: config.allowedLogins, dataDirectory: config.dataDirectory }); }
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
