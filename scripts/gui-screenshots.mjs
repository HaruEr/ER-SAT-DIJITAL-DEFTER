// GUI redesign evidence: screenshots every screen of a fresh synthetic ledger.
// Usage: node scripts/gui-screenshots.mjs <output-directory> [--only=owner,checkout,login,users,reports]
// Never reads data/ or .local/; see test-support/gui-browser.mjs.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startGuiSession, OWNER_READY, LOGIN_READY, CHECKOUT_READY, OWNER_NAME, EMPLOYEE_NAME } from '../test-support/gui-browser.mjs';

const outArg = process.argv[2];
if (!outArg || outArg.startsWith('--')) throw new Error('Usage: node scripts/gui-screenshots.mjs <output-directory> [--only=...]');
const outDir = resolve(outArg);
const only = (process.argv.find(arg => arg.startsWith('--only='))?.slice(7).split(',')) || ['login', 'owner', 'users', 'checkout', 'reports'];
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
if (outDir.startsWith(join(repoRoot, 'data')) || outDir.startsWith(join(repoRoot, '.local'))) throw new Error('Refusing to write into business data folders.');
mkdirSync(outDir, { recursive: true });

const WIDTHS = [
  { name: 'desktop', width: 1440, height: 900, mobile: false },
  { name: 'tablet', width: 1024, height: 768, mobile: false },
  { name: 'phone', width: 390, height: 844, mobile: true }
];
const THEMES = ['light', 'dark'];
const OWNER_VIEWS = ['overview', 'transaction', 'closing', 'accounts', 'suppliers', 'stocks', 'banks', 'journal', 'summary', 'backup'];
const REPORT_VIEWS = ['overview', 'stock', 'cari', 'journal'];
const MAX_FULL_HEIGHT = 7000;

// Local contact sheet: one row per screen, columns per width/theme. Opened via file://.
function gallery(shots) {
  const esc = value => String(value).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const screens = [...new Set(shots.map(s => s.file.split('--')[0]))];
  const columns = WIDTHS.flatMap(w => THEMES.map(t => `${w.name}-${t}`));
  const rows = screens.map(screen => `<section><h2>${esc(screen)}</h2><div class="row">${columns.map(col => {
    const file = `${screen}--${col}.png`;
    return shots.some(s => s.file === file) ? `<figure><a href="${esc(file)}" target="_blank"><img loading="lazy" src="${esc(file)}" alt="${esc(screen)} ${esc(col)}"></a><figcaption>${esc(col)}</figcaption></figure>` : '';
  }).join('')}</div></section>`).join('');
  return `<!doctype html><html lang="tr"><meta charset="utf-8"><title>GUI ekran görüntüleri</title>
<style>body{margin:0;padding:16px;font:14px system-ui;background:#181613;color:#f4efe3}h1{font-size:20px}h2{font-size:15px;margin:24px 0 8px;color:#e4c66b}
.row{display:flex;gap:12px;align-items:flex-start;overflow-x:auto}figure{margin:0;flex:0 0 auto}img{display:block;width:220px;max-height:420px;object-fit:cover;object-position:top;border:1px solid #534b3b;border-radius:6px}
figcaption{font-size:12px;color:#c9c0b0;margin-top:4px}</style><h1>GUI ekran görüntüleri · ${shots.length} adet · ${esc(new Date().toLocaleString('tr-TR'))}</h1>${rows}</html>`;
}

const gui = await startGuiSession({ reports: only.includes('reports') });
const { base, reportBase, page, evaluate, until, settle, navigate, viewport, setTheme, login, logout, closeLayers, enableReportProxy, consoleErrors } = gui;
const manifest = [];

async function shot(name, { full = true, keepFocus = false } = {}) {
  // Focus rings from programmatic focus are real but add noise to before/after comparisons.
  if (!keepFocus) await evaluate(`(() => { const el = document.activeElement; if (el && el !== document.body && !el.closest('dialog')) el.blur(); return true; })()`);
  const metrics = await page('Page.getLayoutMetrics');
  const width = Math.ceil(metrics.cssVisualViewport.clientWidth);
  const height = full ? Math.min(Math.ceil(metrics.cssContentSize.height), MAX_FULL_HEIGHT) : Math.ceil(metrics.cssVisualViewport.clientHeight);
  const { data } = await page('Page.captureScreenshot', full
    ? { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } }
    : { format: 'png' }); // viewport only: overlays are fixed to the visible area
  const file = `${name}.png`;
  writeFileSync(join(outDir, file), Buffer.from(data, 'base64'));
  manifest.push({ file, width, height, truncated: full && metrics.cssContentSize.height > MAX_FULL_HEIGHT });
  process.stdout.write(`  ✓ ${file}\n`);
}

try {
  for (const vp of WIDTHS) {
    await viewport(vp);
    for (const theme of THEMES) {
      const tag = `${vp.name}-${theme}`;
      console.log(`[${tag}]`);
      await navigate(`${base}/`, LOGIN_READY);
      await setTheme(theme);

      if (only.includes('login')) {
        await navigate(`${base}/`, LOGIN_READY);
        await shot(`login--${tag}`);
      }

      if (only.includes('owner') || only.includes('users')) {
        await login(OWNER_NAME);
        await navigate(`${base}/owner`, OWNER_READY);
        if (only.includes('owner')) {
          for (const view of OWNER_VIEWS) {
            await evaluate(`(() => { document.querySelector('[data-view="${view}"]').click(); return true; })()`);
            await until(OWNER_READY);
            await settle();
            await evaluate('window.scrollTo(0, 0) || true');
            await shot(`owner-${view}--${tag}`);
          }
          // Overlays: command palette and the quick-customer drawer.
          await evaluate(`(() => { document.querySelector('#command-palette-trigger').click(); return true; })()`);
          await until(`document.querySelector('dialog[data-command-palette][open]')`).catch(() => {});
          await settle();
          await shot(`owner-overlay-palette--${tag}`, { full: false });
          await closeLayers();
          await evaluate(`(() => { document.querySelector('[data-view="transaction"]').click(); return true; })()`);
          await until(OWNER_READY);
          await settle();
          const hasCreate = await evaluate(`Boolean(document.querySelector('[data-create-party]'))`);
          if (hasCreate) {
            await evaluate(`(() => { document.querySelector('[data-create-party]').click(); return true; })()`);
            await until(`document.querySelector('dialog.defter-drawer[open]')`).catch(() => {});
            await settle();
            await shot(`owner-overlay-drawer--${tag}`, { full: false });
            await closeLayers();
          }
        }
        if (only.includes('users')) {
          await navigate(`${base}/users`);
          await settle();
          await shot(`users--${tag}`);
        }
        await logout();
      }

      if (only.includes('checkout')) {
        await login(EMPLOYEE_NAME);
        await navigate(`${base}/checkout`, CHECKOUT_READY);
        await shot(`checkout-quick--${tag}`);
        await evaluate(`(() => { document.querySelector('button[data-flow-mode="guided"]').click(); return true; })()`);
        await settle();
        await shot(`checkout-guided--${tag}`);
        const canDrawer = await evaluate(`Boolean(document.querySelector('#open-customer-drawer:not([hidden])'))`);
        if (canDrawer) {
          await evaluate(`(() => { document.querySelector('#open-customer-drawer').click(); return true; })()`);
          await until(`document.querySelector('dialog.defter-drawer[open]')`).catch(() => {});
          await settle();
          await shot(`checkout-overlay-drawer--${tag}`, { full: false });
          await closeLayers();
        }
        await logout();
      }

      if (only.includes('reports') && reportBase) {
        await enableReportProxy();
        await navigate(`${reportBase}/`, `document.querySelector('[data-report-view]')`);
        await setTheme(theme);
        for (const view of REPORT_VIEWS) {
          await evaluate(`(() => { document.querySelector('[data-report-view="${view}"]').click(); return true; })()`);
          await settle();
          await shot(`reports-${view}--${tag}`);
        }
        await page('Fetch.disable');
      }
    }
  }
} finally {
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), widths: WIDTHS, themes: THEMES, consoleErrors, shots: manifest }, null, 2));
  writeFileSync(join(outDir, 'index.html'), gallery(manifest));
  await gui.close();
}
console.log(`\n${manifest.length} ekran görüntüsü → ${outDir}`);
if (consoleErrors.length) { console.log(`Sayfa hataları (${consoleErrors.length}):`); for (const error of consoleErrors) console.log('  - ' + String(error).split('\n')[0]); }
