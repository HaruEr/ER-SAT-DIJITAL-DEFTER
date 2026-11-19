import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const TRANSIENT_RM_CODES = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES', 'EMFILE', 'ENFILE']);

export function getIsolatedTempRoot() {
  return resolve(process.env.TEMP || process.env.TMP || tmpdir());
}

export function isInsideDir(targetPath, parentDir) {
  const target = resolve(targetPath);
  const parent = resolve(parentDir);
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  return process.platform === 'win32'
    ? target.toLowerCase().startsWith(prefix.toLowerCase())
    : target.startsWith(prefix);
}

export function killOrphanChromeForUserDataDir(userDataDir) {
  if (process.platform !== 'win32' || !userDataDir) return 0;
  const resolved = resolve(userDataDir).replace(/'/g, "''");
  const ps = [
    `$needle = '${resolved}'`,
    `$escaped = [regex]::Escape($needle)`,
    `$pattern = $escaped + '(?=$|[\\s"\\\\])'`,
    `$procs = @(Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine -imatch $pattern })`,
    `foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }`,
    `Write-Output $procs.Count`
  ].join('; ');
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000
    }).trim();
    return Number(out) || 0;
  } catch {
    return 0;
  }
}

export async function removeDirWithRetry(targetDir, { maxAttempts = 40, onTransientError = null } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await rm(targetDir, { recursive: true, force: true });
      if (!existsSync(targetDir)) return;
    } catch (err) {
      lastErr = err;
      if (!TRANSIENT_RM_CODES.has(err?.code) || attempt === maxAttempts) throw err;
      if (onTransientError && (attempt === 1 || attempt % 10 === 0)) {
        onTransientError();
      }
    }
    await delay(Math.min(50 + attempt * 25, 250));
  }
  if (existsSync(targetDir)) {
    throw lastErr || new Error(`Directory still exists after cleanup: ${targetDir}`);
  }
}

const CHROME_FALLBACK_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];

export function resolveChromeBinary() {
  const fromEnv = process.env.CHROMIUM_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const candidate of CHROME_FALLBACK_PATHS) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('Chrome binary not found. Set CHROMIUM_PATH or install Chrome in Program Files.');
}

const KEY_DEFS = {
  k: { windowsVirtualKeyCode: 75, key: 'k', code: 'KeyK' },
  K: { windowsVirtualKeyCode: 75, key: 'k', code: 'KeyK' },
  a: { windowsVirtualKeyCode: 65, key: 'a', code: 'KeyA' },
  ArrowDown: { windowsVirtualKeyCode: 40, key: 'ArrowDown', code: 'ArrowDown' },
  ArrowUp: { windowsVirtualKeyCode: 38, key: 'ArrowUp', code: 'ArrowUp' },
  Home: { windowsVirtualKeyCode: 36, key: 'Home', code: 'Home' },
  End: { windowsVirtualKeyCode: 35, key: 'End', code: 'End' },
  Enter: { windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' },
  Escape: { windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' },
  Tab: { windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' },
  Backspace: { windowsVirtualKeyCode: 8, key: 'Backspace', code: 'Backspace' }
};

function modifierMask({ alt = false, ctrl = false, meta = false, shift = false } = {}) {
  return (alt ? 1 : 0) | (ctrl ? 2 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0);
}

export async function launchChromeSession({
  userDataDir,
  width = 1440,
  height = 900,
  watchdogMs = 240000
} = {}) {
  if (!userDataDir) throw new Error('userDataDir is required.');
  const binary = resolveChromeBinary();

  const browser = spawn(
    binary,
    [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-default-apps',
      '--disable-background-networking',
      '--disable-popup-blocking',
      '--remote-debugging-pipe',
      `--user-data-dir=${userDataDir}`,
      'about:blank'
    ],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] }
  );

  let nextId = 0;
  let sessionId = null;
  let recvBuffer = Buffer.alloc(0);
  let closed = false;
  const pending = new Map();
  const listeners = new Map();

  const consoleErrors = [];
  const uncaughtExceptions = [];
  const securityLogs = [];
  const networkErrors = [];
  const networkFailed = [];
  const requests = [];
  const dialogs = [];
  const allowedStatusStack = [];
  let allowNetworkFailuresCount = 0;

  const isAllowedStatus = (status, url) => {
    for (const rule of allowedStatusStack) {
      if (typeof rule === 'function') {
        if (rule(status, url)) return true;
      } else if (Array.isArray(rule) && rule.includes(status)) {
        return true;
      } else if (rule && typeof rule === 'object') {
        const statusOk = !rule.statuses || rule.statuses.includes(status);
        const urlOk = !rule.urlIncludes || String(url || '').includes(rule.urlIncludes);
        if (statusOk && urlOk) return true;
      }
    }
    return false;
  };

  function emit(method, params) {
    const set = listeners.get(method);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(params);
      } catch {
        // Listener errors should not break pipe pump
      }
    }
  }

  function on(method, fn) {
    let set = listeners.get(method);
    if (!set) {
      set = new Set();
      listeners.set(method, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  browser.stdio?.[3]?.on?.('error', () => {});
  browser.stdio?.[4]?.on?.('error', () => {});

  browser.stdio[4].on('data', chunk => {
    recvBuffer = Buffer.concat([recvBuffer, chunk]);
    let zeroIdx;
    while ((zeroIdx = recvBuffer.indexOf(0)) !== -1) {
      const raw = recvBuffer.subarray(0, zeroIdx).toString('utf8');
      recvBuffer = recvBuffer.subarray(zeroIdx + 1);
      if (!raw) continue;
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        continue;
      }
      if (msg.id !== undefined) {
        const entry = pending.get(msg.id);
        if (entry) {
          pending.delete(msg.id);
          if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message}`));
          else entry.resolve(msg.result);
        }
      } else if (msg.method) {
        emit(msg.method, msg.params);
      }
    }
  });

  browser.on('exit', () => {
    for (const [, entry] of pending) {
      entry.reject(new Error(`${entry.method}: Chrome exited before reply`));
    }
    pending.clear();
  });

  function call(method, params = {}, session = sessionId) {
    if (closed) return Promise.reject(new Error(`CDP closed before calling ${method}`));
    return new Promise((resolveCall, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve: resolveCall, reject, method });
      const payload = session ? { id, method, params, sessionId: session } : { id, method, params };
      try {
        browser.stdio[3].write(JSON.stringify(payload) + '\0');
      } catch (err) {
        pending.delete(id);
        reject(err);
      }
    });
  }

  const watchdog = setTimeout(() => {
    try {
      if (browser.pid) spawnSync('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { windowsHide: true });
    } catch {}
    killOrphanChromeForUserDataDir(userDataDir);
  }, watchdogMs);
  watchdog.unref?.();

  on('Runtime.consoleAPICalled', params => {
    if (params?.type === 'error') {
      const text = (params.args || []).map(a => a.value ?? a.description ?? a.type).join(' ');
      consoleErrors.push({ text, timestamp: params.timestamp });
    }
  });

  on('Runtime.exceptionThrown', params => {
    const details = params?.exceptionDetails || {};
    uncaughtExceptions.push({
      text: details.text || details.exception?.description || 'Uncaught exception',
      url: details.url,
      lineNumber: details.lineNumber
    });
  });

  on('Log.entryAdded', params => {
    const entry = params?.entry;
    if (!entry) return;
    if (entry.source === 'security') {
      securityLogs.push({ level: entry.level, text: entry.text, url: entry.url });
    } else if (entry.level === 'error' && entry.source === 'javascript') {
      consoleErrors.push({ text: entry.text, source: entry.source });
    }
  });

  on('Network.requestWillBeSent', params => {
    if (!params?.request) return;
    requests.push({
      requestId: params.requestId,
      url: params.request.url,
      method: params.request.method,
      type: params.type,
      wallTime: params.wallTime
    });
  });

  on('Network.responseReceived', params => {
    const res = params?.response;
    if (!res) return;
    if (res.status >= 400 && !isAllowedStatus(res.status, res.url)) {
      networkErrors.push({ status: res.status, url: res.url, statusText: res.statusText });
    }
  });

  on('Network.loadingFailed', params => {
    if (!params || params.canceled) return;
    if (params.errorText === 'net::ERR_ABORTED') return;
    if (allowNetworkFailuresCount > 0) return;
    networkFailed.push({ errorText: params.errorText, type: params.type, blockedReason: params.blockedReason });
  });

  on('Page.javascriptDialogOpening', params => {
    dialogs.push({
      type: params.type,
      message: params.message,
      hasBrowserHandler: Boolean(params.hasBrowserHandler),
      url: params.url
    });
    void call('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
  });

  const targets = await call('Target.getTargets', {}, null);
  const pageTarget = targets.targetInfos.find(t => t.type === 'page');
  if (!pageTarget) throw new Error('Initial Chrome page target not found.');
  ({ sessionId } = await call('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true }, null));

  await call('Page.enable');
  await call('Runtime.enable');
  await call('Log.enable');
  await call('Network.enable');
  await call('Emulation.setFocusEmulationEnabled', { enabled: true });
  await call('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false
  });

  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      window.__e2eCspViolations = window.__e2eCspViolations || [];
      document.addEventListener('securitypolicyviolation', e => {
        window.__e2eCspViolations.push({
          violatedDirective: e.violatedDirective,
          effectiveDirective: e.effectiveDirective,
          blockedURI: e.blockedURI,
          sourceFile: e.sourceFile,
          lineNumber: e.lineNumber
        });
      }, true);
    })();`
  });

  async function evaluate(expression) {
    const res = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'Browser evaluation failed');
    }
    return res.result?.value;
  }

  async function until(expression, { timeoutMs = 10000, intervalMs = 50, label } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const val = await evaluate(expression);
        if (val) return val;
        lastError = null;
      } catch (err) {
        lastError = err;
      }
      await delay(intervalMs);
    }
    throw new Error(`Timeout waiting for condition (${label || expression})${lastError ? ': ' + lastError.message : ''}`);
  }

  async function waitFor(fn, { timeoutMs = 10000, intervalMs = 50, label = 'waitFor' } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const val = await fn();
        if (val) return val;
        lastError = null;
      } catch (err) {
        lastError = err;
      }
      await delay(intervalMs);
    }
    throw new Error(`Timeout waiting for ${label}${lastError ? ': ' + lastError.message : ''}`);
  }

  async function waitForDoubleRaf() {
    await evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
  }

  async function navigate(url) {
    const loaded = new Promise(resolveLoad => {
      const off = on('Page.loadEventFired', () => {
        off();
        resolveLoad();
      });
      setTimeout(() => {
        off();
        resolveLoad();
      }, 8000);
    });
    await call('Page.navigate', { url });
    await loaded;
    await until("document.readyState === 'complete'");
  }

  async function reload({ ignoreCache = false } = {}) {
    const loaded = new Promise(resolveLoad => {
      const off = on('Page.loadEventFired', () => {
        off();
        resolveLoad();
      });
      setTimeout(() => {
        off();
        resolveLoad();
      }, 8000);
    });
    await call('Page.reload', { ignoreCache });
    await loaded;
    await until("document.readyState === 'complete'");
  }

  async function back() {
    const hist = await call('Page.getNavigationHistory');
    if (hist.currentIndex > 0) {
      const target = hist.entries[hist.currentIndex - 1];
      await call('Page.navigateToHistoryEntry', { entryId: target.id });
    } else {
      await evaluate('history.back()');
    }
    await delay(120);
  }

  async function forward() {
    const hist = await call('Page.getNavigationHistory');
    if (hist.currentIndex + 1 < hist.entries.length) {
      const target = hist.entries[hist.currentIndex + 1];
      await call('Page.navigateToHistoryEntry', { entryId: target.id });
    } else {
      await evaluate('history.forward()');
    }
    await delay(120);
  }

  async function historyBack() {
    await evaluate('history.back()');
    await delay(150);
  }

  async function historyForward() {
    await evaluate('history.forward()');
    await delay(150);
  }

  async function setViewport(newWidth, newHeight = 900) {
    await call('Emulation.setDeviceMetricsOverride', {
      width: newWidth,
      height: newHeight,
      deviceScaleFactor: 1,
      mobile: false
    });
    await waitForDoubleRaf();
  }

  async function assertNoHorizontalOverflow(contextLabel = '') {
    await waitForDoubleRaf();
    const metrics = await evaluate('({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth })');
    assert.ok(
      metrics.scrollWidth <= metrics.innerWidth,
      `Horizontal overflow ${contextLabel ? '[' + contextLabel + '] ' : ''}: scrollWidth=${metrics.scrollWidth} > innerWidth=${metrics.innerWidth}`
    );
    return metrics;
  }

  async function pressKey(keyName, opts = {}) {
    const def = KEY_DEFS[keyName] || {
      windowsVirtualKeyCode: keyName.length === 1 ? keyName.toUpperCase().charCodeAt(0) : 0,
      key: keyName,
      code: keyName.length === 1 ? `Key${keyName.toUpperCase()}` : keyName
    };
    const modifiers = modifierMask(opts);
    const isPlainEnter = def.key === 'Enter' && !opts.ctrl && !opts.meta && !opts.alt;
    await call('Input.dispatchKeyEvent', {
      type: isPlainEnter ? 'keyDown' : 'rawKeyDown',
      modifiers,
      windowsVirtualKeyCode: def.windowsVirtualKeyCode,
      key: def.key,
      code: def.code,
      ...(isPlainEnter ? { text: '\r', unmodifiedText: '\r' } : {})
    });
    await call('Input.dispatchKeyEvent', {
      type: 'keyUp',
      modifiers,
      windowsVirtualKeyCode: def.windowsVirtualKeyCode,
      key: def.key,
      code: def.code
    });
  }

  async function focusSelector(selector) {
    const ok = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      el.focus();
      return document.activeElement === el;
    })()`);
    if (!ok) throw new Error(`Cannot focus selector: ${selector}`);
  }

  async function clickSelector(selector) {
    const pt = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { found: false };
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      return { found: true, x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, disabled: Boolean(el.disabled) };
    })()`);
    if (!pt?.found) throw new Error(`Selector not found for click: ${selector}`);
    if (pt.w === 0 || pt.h === 0) throw new Error(`Selector has zero size (hidden?) for click: ${selector}`);
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  }

  async function typeText(text, { selector = null, clear = false, perCharDelayMs = 0 } = {}) {
    if (selector) {
      await clickSelector(selector);
      await focusSelector(selector);
    }
    if (clear) {
      await pressKey('a', { ctrl: true });
      await pressKey('Backspace');
    }
    if (perCharDelayMs > 0) {
      for (const ch of String(text)) {
        await call('Input.insertText', { text: ch });
        await delay(perCharDelayMs);
      }
    } else if (String(text).length > 0) {
      await call('Input.insertText', { text: String(text) });
    }
  }

  async function getDomStats() {
    const [domCounters, elementCount] = await Promise.all([
      call('Memory.getDOMCounters'),
      evaluate('document.querySelectorAll("*").length')
    ]);
    return { domCounters, elementCount };
  }

  async function measureDomAndPaint(actionFn) {
    const before = await getDomStats();
    const t0 = performance.now();
    await actionFn();
    await waitForDoubleRaf();
    const elapsedMs = performance.now() - t0;
    const after = await getDomStats();
    return { elapsedMs, before, after };
  }

  async function getBoundingRect(selector) {
    return evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, innerWidth: window.innerWidth, innerHeight: window.innerHeight };
    })()`);
  }

  async function getActiveElementInfo() {
    return evaluate(`(() => {
      const el = document.activeElement;
      if (!el) return null;
      return {
        tag: el.tagName,
        id: el.id || '',
        name: el.getAttribute('name') || '',
        role: el.getAttribute('role') || '',
        ariaActive: el.getAttribute('aria-activedescendant') || '',
        type: el.getAttribute('type') || '',
        dataItemField: el.getAttribute('data-item-field') || '',
        hasDataQuantity: el.hasAttribute('data-quantity'),
        hasDataProductSearch: el.hasAttribute('data-product-search'),
        isCommandPaletteInput: el.hasAttribute('data-command-palette-input')
      };
    })()`);
  }

  function resetTelemetry() {
    consoleErrors.length = 0;
    uncaughtExceptions.length = 0;
    securityLogs.length = 0;
    networkErrors.length = 0;
    networkFailed.length = 0;
    dialogs.length = 0;
    requests.length = 0;
  }

  async function withAllowedHttpStatuses(rule, fn) {
    allowedStatusStack.push(rule);
    try {
      return await fn();
    } finally {
      allowedStatusStack.pop();
    }
  }

  async function withAllowedNetworkFailures(fn) {
    allowNetworkFailuresCount++;
    try {
      return await fn();
    } finally {
      allowNetworkFailuresCount--;
    }
  }

  async function assertCleanTelemetry({ allowXss = false } = {}) {
    let pageCsp = [];
    let xssFlag;
    try {
      pageCsp = (await evaluate('window.__e2eCspViolations || []')) || [];
      xssFlag = await evaluate('window.__xss');
    } catch {
      // Ignore if context is mid-navigation
    }
    const allCsp = [...securityLogs, ...pageCsp];
    assert.equal(consoleErrors.length, 0, `Unexpected console.error: ${JSON.stringify(consoleErrors)}`);
    assert.equal(uncaughtExceptions.length, 0, `Unexpected uncaught exceptions: ${JSON.stringify(uncaughtExceptions)}`);
    assert.equal(allCsp.length, 0, `Unexpected CSP/security violations: ${JSON.stringify(allCsp)}`);
    assert.equal(networkErrors.length, 0, `Unexpected HTTP >= 400 responses: ${JSON.stringify(networkErrors)}`);
    assert.equal(networkFailed.length, 0, `Unexpected failed network requests: ${JSON.stringify(networkFailed)}`);
    if (!allowXss) {
      assert.equal(xssFlag, undefined, `XSS payload executed! window.__xss = ${JSON.stringify(xssFlag)}`);
    }
  }

  let closePromise = null;
  async function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      clearTimeout(watchdog);
      const exitPromise = new Promise(resolveExit => {
        if (browser.exitCode !== null || browser.signalCode !== null) return resolveExit();
        browser.once('exit', () => resolveExit());
      });
      try {
        await Promise.race([call('Browser.close', {}, null).catch(() => {}), delay(1000)]);
      } catch {}
      closed = true;
      for (const [, entry] of pending) {
        entry.reject(new Error(`${entry.method}: CDP closed`));
      }
      pending.clear();
      try { browser.stdio?.[3]?.end?.(); } catch {}
      try { browser.stdio?.[3]?.destroy?.(); } catch {}
      try { browser.stdio?.[4]?.destroy?.(); } catch {}
      await Promise.race([exitPromise, delay(1500)]);
      if (browser.exitCode === null && browser.signalCode === null && browser.pid) {
        try {
          spawnSync('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { windowsHide: true });
        } catch {}
        await Promise.race([exitPromise, delay(1500)]);
      }
      killOrphanChromeForUserDataDir(userDataDir);
      if (userDataDir && isInsideDir(userDataDir, getIsolatedTempRoot())) {
        await removeDirWithRetry(userDataDir, {
          onTransientError: () => killOrphanChromeForUserDataDir(userDataDir)
        });
      }
    })();
    return closePromise;
  }

  return {
    call,
    on,
    evaluate,
    until,
    waitFor,
    waitForDoubleRaf,
    navigate,
    reload,
    back,
    forward,
    historyBack,
    historyForward,
    setViewport,
    assertNoHorizontalOverflow,
    pressKey,
    focusSelector,
    clickSelector,
    typeText,
    getDomStats,
    measureDomAndPaint,
    getBoundingRect,
    getActiveElementInfo,
    getDialogs: () => [...dialogs],
    clearDialogs: () => { dialogs.length = 0; },
    getRequests: () => [...requests],
    clearRequests: () => { requests.length = 0; },
    resetTelemetry,
    withAllowedHttpStatuses,
    withAllowedNetworkFailures,
    assertCleanTelemetry,
    close
  };
}
