import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INITIAL_ACCOUNTS } from '../domain.mjs';
import { Repository } from '../repository.mjs';
import { ReportRepository } from '../report-repository.mjs';
import { createReportApp } from '../report-server.mjs';

const stylesCss = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const accessCss = readFileSync(new URL('../public/access.css', import.meta.url), 'utf8');
const reportsCss = readFileSync(new URL('../public/reports.css', import.meta.url), 'utf8');
const reportsHtml = readFileSync(new URL('../public/reports.html', import.meta.url), 'utf8');

const origin = 'https://m43-audit.example-tailnet.ts.net';
const host = new URL(origin).host;
const authHeaders = {
  Host: host,
  'Tailscale-User-Login': 'reader@example.test',
  Origin: origin
};

const tempDirs = new Set();
test.after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function extractBraceBlock(css, startAt) {
  const open = css.indexOf('{', startAt);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) {
        return {
          header: css.slice(startAt, open).trim(),
          body: css.slice(open + 1, i),
          start: startAt,
          end: i + 1
        };
      }
    }
  }
  return null;
}

function findMediaBlocks(css, needle) {
  const results = [];
  let idx = 0;
  while (idx < css.length) {
    const pos = css.indexOf('@media', idx);
    if (pos === -1) break;
    const block = extractBraceBlock(css, pos);
    if (!block) break;
    if (block.header.includes(needle)) results.push(block);
    idx = block.end;
  }
  return results;
}

function parseVars(declarationText) {
  const vars = {};
  for (const match of declarationText.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)) {
    vars[match[1]] = match[2].trim();
  }
  return vars;
}

function resolveVar(name, vars, seen = new Set()) {
  if (seen.has(name)) return null;
  const raw = vars[name];
  if (!raw) return null;
  const ref = raw.match(/^var\((--[a-zA-Z0-9-]+)\)$/);
  if (!ref) return raw;
  seen.add(name);
  return resolveVar(ref[1], vars, seen);
}

function hexToRgb(hex) {
  let clean = hex.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(clean)) {
    clean = clean.split('').map(c => c + c).join('');
  }
  assert.match(clean, /^[0-9a-fA-F]{6}$/, `Expected 3- or 6-digit hex color, got: ${hex}`);
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16)
  ];
}

function relativeLuminance([r, g, b]) {
  const linear = [r, g, b].map(c => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(hexA, hexB) {
  const lumA = relativeLuminance(hexToRgb(hexA));
  const lumB = relativeLuminance(hexToRgb(hexB));
  const hi = Math.max(lumA, lumB);
  const lo = Math.min(lumA, lumB);
  return (hi + 0.05) / (lo + 0.05);
}

function rawHttpRequest(port, path, method = 'GET', headers = authHeaders) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ============================================================================
// 1. M2-F19: Report Portal /favicon.ico, Strict CSP & Read-Only Preservation
// ============================================================================

test('M2-F19: reports.html suppresses /favicon.ico cleanly and remains strictly CSP-compliant', () => {
  assert.match(reportsHtml, /<link\s+rel=["']icon["']\s+href=["']data:,["']\s*>/i);
  assert.doesNotMatch(reportsHtml, /<script(?![^>]*\bsrc=)[^>]*>/i, 'Must contain no inline <script>');
  assert.doesNotMatch(reportsHtml, /<style\b/i, 'Must contain no <style> tags');
  assert.doesNotMatch(reportsHtml, /\sstyle\s*=/i, 'Must contain no inline style= attributes');
  assert.doesNotMatch(reportsHtml, /\son[a-z]+\s*=/i, 'Must contain no inline on*= handlers');
});

test('M2-F19: report-server returns 204 for GET /favicon.ico, enforces auth/GET-only, CSP img-src data:, and query_only=ON', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'defter-m43-report-'));
  tempDirs.add(dir);
  const dbPath = join(dir, 'demo.sqlite');

  const writer = new Repository(dbPath, 'demo');
  t.after(() => writer.close());
  const balances = Object.fromEntries(INITIAL_ACCOUNTS.filter(a => !a.retired).map(a => [a.id, '0']));
  balances.nakit = '5000';
  writer.execute({ id: 'open-m43', revision: 0, command: { type: 'opening', date: '2026-11-18', balances } });

  const app = createReportApp({
    enabled: true,
    origin,
    allowedLogins: ['reader@example.test'],
    dataDirectory: dir
  });
  await app.listen(0);
  t.after(async () => {
    await new Promise(resolve => {
      app.server.close(resolve);
      app.server.closeAllConnections();
    });
  });
  const port = app.server.address().port;

  // Root HTML 200 + strict CSP including img-src 'self' data:
  const rootRes = await rawHttpRequest(port, '/', 'GET');
  assert.equal(rootRes.status, 200);
  const csp = rootRes.headers['content-security-policy'];
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /style-src 'self'/);
  assert.match(csp, /img-src 'self' data:/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);

  // Authenticated GET /favicon.ico and /favicon.ico?v=1 (with and without Origin) -> 204 with security headers and zero DB open
  for (const [favPath, favHeaders] of [
    ['/favicon.ico', authHeaders],
    ['/favicon.ico?v=1', authHeaders],
    ['/favicon.ico?v=1', { Host: host, 'Tailscale-User-Login': 'reader@example.test' }]
  ]) {
    const favRes = await rawHttpRequest(port, favPath, 'GET', favHeaders);
    assert.equal(favRes.status, 204, `Expected 204 for ${favPath}`);
    assert.equal(favRes.body, '');
    assert.equal(favRes.headers['cache-control'], 'no-store');
    assert.equal(favRes.headers['x-content-type-options'], 'nosniff');
    assert.equal(favRes.headers['referrer-policy'], 'no-referrer');
    assert.match(favRes.headers['content-security-policy'], /img-src 'self' data:/);
  }
  assert.equal(app.repositories.size, 0);

  // Unauthenticated, wrong Origin, or Tailscale-Funnel-Request on /favicon.ico -> 401/403
  for (const [favPath, badHeaders] of [
    ['/favicon.ico', { Host: host }],
    ['/favicon.ico', { Host: host, 'Tailscale-User-Login': 'intruder@example.test' }],
    ['/favicon.ico?v=1', { ...authHeaders, Origin: 'https://evil.example.test' }],
    ['/favicon.ico?v=1', { ...authHeaders, 'Tailscale-Funnel-Request': '1' }]
  ]) {
    const denied = await rawHttpRequest(port, favPath, 'GET', badHeaders);
    assert.ok([401, 403].includes(denied.status), `Expected 401/403 for ${favPath}, got ${denied.status}`);
  }
  assert.equal(app.repositories.size, 0);

  // Non-GET methods on /favicon.ico and /favicon.ico?v=1 -> 405 with Allow: GET
  for (const [favPath, method] of [
    ['/favicon.ico', 'POST'],
    ['/favicon.ico', 'PUT'],
    ['/favicon.ico', 'PATCH'],
    ['/favicon.ico', 'DELETE'],
    ['/favicon.ico', 'OPTIONS'],
    ['/favicon.ico', 'TRACE'],
    ['/favicon.ico?v=1', 'POST']
  ]) {
    const mRes = await rawHttpRequest(port, favPath, method);
    assert.equal(mRes.status, 405, `Expected 405 for ${method} ${favPath}`);
    assert.equal(mRes.headers.allow, 'GET');
  }
  assert.equal(app.repositories.size, 0);

  // ReportRepository still enforces PRAGMA query_only=ON
  const reader = new ReportRepository(dbPath, 'demo');
  try {
    assert.equal(reader.db.prepare('PRAGMA query_only').get().query_only, 1);
    assert.throws(() => reader.db.exec('DELETE FROM events'), /readonly|read-only/i);
    assert.equal(reader.db.prepare('SELECT total_changes() AS n').get().n, 0);
  } finally {
    reader.close();
  }
});

// ============================================================================
// 2. M2-F21: WCAG 1.4.11 Non-Text Contrast (>= 3.0:1) for Light & Dark SVG Bars
// ============================================================================

test('M2-F21: SVG chart bars pass WCAG 1.4.11 (>= 3.0:1) in light and dark modes while preserving --gold', () => {
  // Parse styles.css :root and :root[data-theme="dark"]
  const rootMatch = stylesCss.match(/:root\s*\{([^}]+)\}/);
  const darkMatch = stylesCss.match(/:root\[data-theme="dark"\]\s*\{([^}]+)\}/);
  assert.ok(rootMatch && darkMatch, 'styles.css must define :root and :root[data-theme="dark"]');
  const stylesLight = parseVars(rootMatch[1]);
  const stylesDark = { ...stylesLight, ...parseVars(darkMatch[1]) };

  assert.equal(stylesLight['--gold'], '#c9a646', '--gold button/accent token must remain untouched');
  assert.match(stylesCss, /\.chart-in\s*\{\s*fill:\s*var\(--chart-in\);/);
  assert.match(stylesCss, /\.chart-out\s*\{\s*fill:\s*var\(--red\);/);

  const lightChartIn = resolveVar('--chart-in', stylesLight);
  const lightChartOut = resolveVar('--red', stylesLight);
  const lightSurfaceSoft = resolveVar('--surface-soft', stylesLight);
  const lightSurface = resolveVar('--surface', stylesLight);
  assert.notEqual(lightChartIn, lightChartOut);
  assert.ok(contrastRatio(lightChartIn, lightSurfaceSoft) >= 3.5, 'Light .chart-in vs --surface-soft >= 3.5:1');
  assert.ok(contrastRatio(lightChartIn, lightSurface) >= 3.5, 'Light .chart-in vs --surface >= 3.5:1');
  assert.ok(contrastRatio(lightChartOut, lightSurfaceSoft) >= 3.0, 'Light .chart-out vs --surface-soft >= 3.0:1');

  const darkChartIn = resolveVar('--chart-in', stylesDark);
  const darkChartOut = resolveVar('--red', stylesDark);
  const darkSurfaceSoft = resolveVar('--surface-soft', stylesDark);
  const darkSurface = resolveVar('--surface', stylesDark);
  assert.notEqual(darkChartIn, darkChartOut);
  assert.ok(contrastRatio(darkChartIn, darkSurfaceSoft) >= 3.0, 'Dark .chart-in vs --surface-soft >= 3.0:1');
  assert.ok(contrastRatio(darkChartIn, darkSurface) >= 3.0, 'Dark .chart-in vs --surface >= 3.0:1');
  assert.ok(contrastRatio(darkChartOut, darkSurfaceSoft) >= 3.0, 'Dark .chart-out vs --surface-soft >= 3.0:1');

  // Parse styles.css @media print token overrides under both light and dark themes
  const stylesPrintBlocks = findMediaBlocks(stylesCss, 'print');
  const stylesPrintTokenBlock = stylesPrintBlocks.find(b => /:root\s*,\s*:root\[data-theme="dark"\]\s*\{/.test(b.body));
  assert.ok(stylesPrintTokenBlock, 'styles.css @media print must define :root, :root[data-theme="dark"] token overrides');
  const stylesPrintTokenMatch = stylesPrintTokenBlock.body.match(/:root\s*,\s*:root\[data-theme="dark"\]\s*\{([^}]+)\}/);
  assert.ok(stylesPrintTokenMatch);
  const stylesPrintVars = parseVars(stylesPrintTokenMatch[1]);
  for (const [modeName, baseVars] of [
    ['print-light', stylesLight],
    ['print-dark', stylesDark]
  ]) {
    const merged = { ...baseVars, ...stylesPrintVars };
    const printIn = resolveVar('--chart-in', merged);
    const printOut = resolveVar('--red', merged);
    const printSurfSoft = resolveVar('--surface-soft', merged);
    const printSurf = resolveVar('--surface', merged);
    assert.notEqual(printIn, printOut, `${modeName} .chart-in and .chart-out must be distinct`);
    assert.ok(contrastRatio(printIn, printSurfSoft) >= 3.0, `${modeName} .chart-in vs --surface-soft >= 3.0:1`);
    assert.ok(contrastRatio(printIn, printSurf) >= 3.0, `${modeName} .chart-in vs --surface >= 3.0:1`);
    assert.ok(contrastRatio(printOut, printSurfSoft) >= 3.0, `${modeName} .chart-out vs --surface-soft >= 3.0:1`);
  }

  // Parse reports.css :root, @media (prefers-color-scheme: dark), html[data-theme="dark"], and @media print
  const rRootMatch = reportsCss.match(/:root\s*\{([^}]+)\}/);
  const rDarkMedia = findMediaBlocks(reportsCss, 'prefers-color-scheme: dark');
  const rDarkAttr = reportsCss.match(/html\[data-theme="dark"\]\s*\{([^}]+)\}/);
  const rPrintBlocks = findMediaBlocks(reportsCss, 'print');
  assert.ok(rRootMatch && rDarkMedia.length && rDarkAttr && rPrintBlocks.length);
  const rDarkMediaRoot = rDarkMedia[0].body.match(/:root\s*\{([^}]+)\}/);
  const rPrintTokenBlock = rPrintBlocks.find(b => /:root\s*,\s*html\[data-theme="dark"\]\s*\{/.test(b.body));
  assert.ok(rDarkMediaRoot && rPrintTokenBlock, 'reports.css must define dark media :root and print token overrides');
  const rPrintTokenMatch = rPrintTokenBlock.body.match(/:root\s*,\s*html\[data-theme="dark"\]\s*\{([^}]+)\}/);
  assert.ok(rPrintTokenMatch);

  const reportsLight = parseVars(rRootMatch[1]);
  const reportsDarkAttr = { ...reportsLight, ...parseVars(rDarkAttr[1]) };
  const reportsDarkMedia = { ...reportsLight, ...parseVars(rDarkMediaRoot[1]) };
  const reportsPrintVars = parseVars(rPrintTokenMatch[1]);

  assert.equal(reportsLight['--gold'], '#c9a646', 'reports.css --gold must remain untouched');
  for (const mode of [
    { name: 'light', vars: reportsLight, minSale: 3.5 },
    { name: 'dark-attr', vars: reportsDarkAttr, minSale: 3.0 },
    { name: 'dark-media', vars: reportsDarkMedia, minSale: 3.0 },
    { name: 'print-light', vars: { ...reportsLight, ...reportsPrintVars }, minSale: 3.0 },
    { name: 'print-dark-attr', vars: { ...reportsDarkAttr, ...reportsPrintVars }, minSale: 3.0 },
    { name: 'print-dark-media', vars: { ...reportsDarkMedia, ...reportsPrintVars }, minSale: 3.0 }
  ]) {
    const sale = resolveVar('--chart-sale', mode.vars);
    const purchase = resolveVar('--chart-purchase', mode.vars);
    const expense = resolveVar('--chart-expense', mode.vars);
    const surfSoft = resolveVar('--surface-soft', mode.vars);
    const surf = resolveVar('--surface', mode.vars);
    assert.notEqual(sale, purchase, `${mode.name} --chart-sale and --chart-purchase must be distinct`);
    assert.ok(contrastRatio(sale, surfSoft) >= mode.minSale, `${mode.name} --chart-sale vs --surface-soft`);
    assert.ok(contrastRatio(sale, surf) >= mode.minSale, `${mode.name} --chart-sale vs --surface`);
    assert.ok(contrastRatio(purchase, surfSoft) >= 3.0, `${mode.name} --chart-purchase vs --surface-soft`);
    assert.ok(contrastRatio(purchase, surf) >= 3.0, `${mode.name} --chart-purchase vs --surface`);
    assert.ok(contrastRatio(expense, surfSoft) >= 3.0, `${mode.name} --chart-expense vs --surface-soft`);
    assert.ok(contrastRatio(expense, surf) >= 3.0, `${mode.name} --chart-expense vs --surface`);
  }
});

// ============================================================================
// 3. CSS Selector, Cascade & Responsive Contracts (All 10 Remaining Findings)
// ============================================================================

test('M2-F05: desktop sidebar tightened and mobile .navigation-open .sidebar-bottom revealed', () => {
  assert.match(stylesCss, /#navigation\s*\{[^}]*gap:\s*14px;\s*margin-top:\s*16px;/);
  assert.match(stylesCss, /#navigation button\s*\{[^}]*min-height:\s*44px;/);

  const mobileBlocks = findMediaBlocks(stylesCss, 'max-width: 900px');
  const combined = mobileBlocks.map(b => b.body).join('\n');
  assert.match(combined, /\.sidebar-label,\s*\.sidebar-bottom\s*\{\s*display:\s*none;\s*\}/);
  assert.match(combined, /\.navigation-open\s+\.sidebar-bottom\s*\{[^}]*display:\s*(?:flex|grid|block)/);
  assert.match(combined, /\.navigation-open\s+\.sidebar-bottom\s+a\s*\{[^}]*min-width:\s*44px;[^}]*min-height:\s*44px;/);
  assert.match(combined, /\.navigation-open\s+\.sidebar-bottom\s+#logout\s*\{[^}]*min-width:\s*44px;[^}]*min-height:\s*44px;/);

  // Desktop sidebar-bottom a must not receive 44px via (pointer: coarse) outside max-width: 900px
  const coarseBlocks = findMediaBlocks(stylesCss, 'pointer: coarse');
  for (const block of coarseBlocks) {
    assert.doesNotMatch(block.body, /\.sidebar-bottom\s+a\b/);
  }
});

test('M2-F08: toast region moved to top-right and toast body does not intercept clicks', () => {
  const regionMatch = stylesCss.match(/\.defter-toast-region\s*\{([^}]+)\}/);
  assert.ok(regionMatch);
  assert.match(regionMatch[1], /top:\s*96px;/);
  assert.match(regionMatch[1], /bottom:\s*auto;/);
  assert.match(regionMatch[1], /pointer-events:\s*none;/);

  const toastMatch = stylesCss.match(/\.defter-toast\s*\{([^}]+)\}/);
  assert.ok(toastMatch);
  assert.match(toastMatch[1], /pointer-events:\s*none;/);

  const bodyMatch = stylesCss.match(/\.defter-toast-body\s*\{([^}]+)\}/);
  assert.ok(bodyMatch);
  assert.match(bodyMatch[1], /pointer-events:\s*none;/);

  const closeMatch = stylesCss.match(/\.defter-toast-close\s*\{([^}]+)\}/);
  assert.ok(closeMatch);
  assert.match(closeMatch[1], /pointer-events:\s*auto;/);

  const mobileToastBlocks = findMediaBlocks(stylesCss, 'max-width: 900px').map(b => b.body).join('\n');
  assert.match(mobileToastBlocks, /\.defter-toast-region\s*\{[^}]*top:\s*96px;/);
});

test('M2-F12: .notice:not([hidden]) is not position: sticky', () => {
  const noticeMatch = stylesCss.match(/\.notice:not\(\[hidden\]\)\s*\{([^}]+)\}/);
  assert.ok(noticeMatch);
  assert.doesNotMatch(noticeMatch[1], /position:\s*sticky/);
  assert.match(noticeMatch[1], /box-shadow:\s*var\(--shadow\)/);
});

test('M2-F13: .statement-totals avoids mid-decimal wrapping and split-view filters stack cleanly', () => {
  const totDivMatch = stylesCss.match(/\.statement-totals\s*>\s*div\s*\{([^}]+)\}/);
  assert.ok(totDivMatch);
  assert.doesNotMatch(totDivMatch[1], /overflow-wrap:\s*anywhere/);

  const totStrongMatch = stylesCss.match(/\.statement-totals\s+strong\s*\{([^}]+)\}/);
  assert.ok(totStrongMatch);
  assert.match(totStrongMatch[1], /font-variant-numeric:\s*tabular-nums/);
  assert.match(totStrongMatch[1], /overflow-wrap:\s*normal/);
  assert.match(totStrongMatch[1], /word-break:\s*normal/);

  const min1024 = findMediaBlocks(stylesCss, 'min-width: 1024px').map(b => b.body).join('\n');
  assert.match(min1024, /\.workbench-split\.has-detail\s+\.workbench-filters\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(min1024, /\.workbench-split\.has-detail\s+\.workbench-filters\s+\.field:first-child\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
  assert.match(min1024, /\.workbench-split\.has-detail\s+\.workbench-filters:has\(#stock-search\)\s*\{[^}]*grid-template-columns:\s*1fr/);
  assert.match(stylesCss, /\.workbench-split\.has-detail\s+\.statement-totals\s*\{[^}]*repeat\(auto-fit,\s*minmax\(min\(100%,\s*220px\),\s*1fr\)\)/);
});

test('M2-F16: closing approver inputs >= 48px and touch targets >= 44x44px across styles, access & reports CSS', () => {
  assert.match(stylesCss, /\.closing-screen\s+\.closing-approver\s+input\s*\{[^}]*min-height:\s*48px;/);
  assert.match(accessCss, /\.access-card\s*>\s*a\s*\{[^}]*min-width:\s*44px;[^}]*min-height:\s*44px;/);

  const touchStyles = findMediaBlocks(stylesCss, '(pointer: coarse)').map(b => b.body).join('\n');
  for (const selector of [
    /\.defter-combobox\s+\.defter-combobox-clear/,
    /\.defter-combobox\s+\.defter-combobox-toggle/,
    /\.defter-toast-close/,
    /\.defter-dialog-close/,
    /\.defter-popover-close/,
    /\.defter-command-palette-clear/,
    /\.defter-command-palette-close/,
    /\.workbench-tab/,
    /\.button\.text/,
    /\.bank-workspace\s+\.bank-card\s+\.button\.text/,
    /\.account-card\s+\.button\.text/
  ]) {
    assert.match(touchStyles, selector);
  }
  assert.match(touchStyles, /min-width:\s*44px;[^}]*min-height:\s*44px;/);
  assert.match(touchStyles, /\.defter-combobox\.has-clear\s+\.defter-combobox-input\s*\{[^}]*padding-right:\s*98px;/);
  assert.match(touchStyles, /\.count-tools\s+label,\s*\.summary-filters\s*>\s*label:has\(input\[type="checkbox"\]\)\s*\{[^}]*min-height:\s*44px;/);

  const touchReports = findMediaBlocks(reportsCss, '(pointer: coarse)').map(b => b.body).join('\n');
  assert.match(touchReports, /min-width:\s*44px;[^}]*min-height:\s*44px;/);
});

test('M2-F17: topbar grid-area rules are scoped under .topbar so checkout toolbar selects are unaffected', () => {
  assert.doesNotMatch(stylesCss, /^\s*#(command-palette-trigger|theme-toggle|refresh)\s*\{\s*grid-area:/m);
  assert.match(stylesCss, /\.topbar\s+#command-palette-trigger\s*\{\s*grid-area:\s*palette;\s*\}/);
  assert.match(stylesCss, /\.topbar\s+#theme-toggle\s*\{\s*grid-area:\s*theme;\s*\}/);
  assert.match(stylesCss, /\.topbar\s+#refresh\s*\{\s*grid-area:\s*refresh;\s*\}/);
});

test('M2-F18: #stock-list grid rules are scoped to div#stock-list so tbody#stock-list keeps native table layout', () => {
  assert.doesNotMatch(stylesCss, /(?:,\s*|:\s*is\([^)]*)#stock-list\b(?<!div#stock-list)/);
  assert.match(stylesCss, /\.account-grid,\s*\.stock-grid,\s*\.bank-grid,\s*div#stock-list\s*\{\s*display:\s*grid;/);
  assert.match(stylesCss, /main:has\(>#account-detail\)\s+:is\(div#stock-list,#account-list\)/);
});

test('M2-F22: supplier [data-rows] > div stacks to 1fr at <=700px after un-queried repeat(2) rule', () => {
  const twoColIdx = stylesCss.indexOf('.supplier-workspace [data-rows]>div { grid-template-columns:repeat(2,minmax(0,1fr));');
  assert.notEqual(twoColIdx, -1, 'Expected un-queried 2-col supplier row rule');
  const afterTwoCol = stylesCss.slice(twoColIdx);
  const blocks = findMediaBlocks(afterTwoCol, 'max-width: 700px');
  assert.ok(blocks.some(b => /\.supplier-workspace\s+\[data-rows\]\s*>\s*div\s*\{\s*grid-template-columns:\s*1fr;\s*\}/.test(b.body)));
});

test('CHAL-M23-ADD-01: #sale-form.trade-form > .info > .button is not constrained to max-width: 100px at <=600px', () => {
  assert.doesNotMatch(stylesCss, /#sale-form\.trade-form\s*>\s*\.info\s*>\s*\.button\s*\{[^}]*max-width:\s*100px/);
  assert.match(stylesCss, /#sale-form\.trade-form\s*>\s*\.info\s*>\s*\.button\s*\{\s*max-width:\s*none;/);
  assert.match(stylesCss, /#sale-form\.trade-form\s*>\s*\.info:has\(\[data-review-draft\]\)\s*>\s*\.button\s*\{\s*width:\s*100%;\s*max-width:\s*none;\s*\}/);
});

test('CHAL-M23-ADD-02: .closing-screen .count-table caption uses container-query sticky width on screen and resets on print', () => {
  const screenBlocks = findMediaBlocks(stylesCss, 'screen').filter(b => b.header === '@media screen');
  const screenText = screenBlocks.map(b => b.body).join('\n');
  assert.match(screenText, /\.closing-screen\s+#close-form\s+\.table-wrap,\s*\.closing-screen\s+#stocktake-form\s+\.table-wrap\s*\{[^}]*container-type:\s*inline-size;/);
  assert.match(screenText, /\.closing-screen\s+\.count-table\s+caption\s*\{[^}]*position:\s*sticky;[^}]*left:\s*0;[^}]*width:\s*100cqi;[^}]*max-width:\s*100%;/);

  const printBlocks = findMediaBlocks(stylesCss, 'print');
  const printText = printBlocks.map(b => b.body).join('\n');
  assert.match(printText, /\.closing-screen\s+#close-form\s+\.table-wrap,\s*\.closing-screen\s+#stocktake-form\s+\.table-wrap\s*\{[^}]*container-type:\s*normal;/);
  assert.match(printText, /\.closing-screen\s+\.count-table\s+caption\s*\{[^}]*position:\s*static;[^}]*width:\s*auto;/);
});
