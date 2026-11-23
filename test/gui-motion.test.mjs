// GUI redesign Faz 1: motion tokens, preference switch and the "never change colours" rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const motionCss = read('public/motion.css');
const prefsSource = read('public/ui-prefs.js');
const PAGES = ['public/index.html', 'public/checkout.html', 'public/login.html', 'public/users.html', 'public/reports.html'];

test('motion.css introduces no colour literals; every tone comes from the existing palette', () => {
  const withoutComments = motionCss.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(withoutComments, /#[0-9a-f]{3,8}\b/i, 'no hex colours');
  assert.doesNotMatch(withoutComments, /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i, 'no colour functions');
  assert.doesNotMatch(withoutComments, /:\s*(white|black|gray|grey|red|gold|silver|goldenrod)\s*[;,}]/i, 'no named colours as values');
  for (const match of withoutComments.matchAll(/color-mix\(([^()]*(?:\([^()]*\))?[^()]*)\)/g)) {
    assert.match(match[1], /^in srgb, (var\(--[a-z-]+\)|black) \d+%, transparent$/, `colour mixes only blend palette tokens with transparent: ${match[0]}`);
  }
  // The only literal colour keyword allowed is inside the @supports feature probe.
  const probeFree = withoutComments.replace(/@supports not \(color: color-mix\(in srgb, black 50%, transparent\)\)/, '');
  assert.doesNotMatch(probeFree, /\bblack\b/);
});

test('motion.css defines the plan tokens and zeroes them for reduced motion', () => {
  for (const token of ['--dur-instant', '--dur-fast', '--dur-base', '--dur-slow', '--ease-out', '--ease-in', '--ease-spring',
    '--lift-hover', '--press-scale', '--enter-scale', '--glow-gold', '--glass-bg', '--glass-border', '--glass-blur',
    '--backdrop-tint', '--toast-inset-bottom', '--toast-inset-right']) {
    assert.match(motionCss, new RegExp(`${token}:`), `${token} defined`);
  }
  assert.match(motionCss, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*:root\s*\{[^}]*--dur-base: 0ms/);
  assert.match(motionCss, /:root\[data-motion="reduced"\]\s*\{[^}]*--dur-slow: 0ms/);
  assert.match(motionCss, /:root\[data-motion="reduced"\] \*,[\s\S]*?animation: none !important;[\s\S]*?transition: none !important;/);
  assert.match(motionCss, /@supports not \(\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\)\)/);
});

test('every page loads ui-prefs.js synchronously before stylesheets and motion.css last', () => {
  for (const page of PAGES) {
    const html = read(page);
    const prefs = html.indexOf('<script src="/ui-prefs.js"></script>');
    const firstCss = html.indexOf('<link rel="stylesheet"');
    const motion = html.indexOf('<link rel="stylesheet" href="/motion.css">');
    assert.ok(prefs > -1 && prefs < firstCss, `${page}: ui-prefs.js before CSS`);
    assert.ok(motion > -1, `${page}: motion.css linked`);
    const lastCss = html.lastIndexOf('<link rel="stylesheet"');
    assert.equal(motion, lastCss, `${page}: motion.css is the last stylesheet`);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, `${page}: no inline scripts`);
    assert.doesNotMatch(html, /\sstyle=/i, `${page}: no inline styles`);
  }
});

test('both servers serve motion.css and ui-prefs.js', () => {
  const server = read('server.mjs');
  const reports = read('report-server.mjs');
  assert.match(server, /\['\/motion\.css', \['motion\.css', 'text\/css; charset=utf-8'\]\]/);
  assert.match(server, /\['\/ui-prefs\.js', \['ui-prefs\.js', 'text\/javascript; charset=utf-8'\]\]/);
  assert.match(reports, /\['\/motion\.css',\['motion\.css','text\/css; charset=utf-8'\]\]/);
  assert.match(reports, /\['\/ui-prefs\.js',\['ui-prefs\.js','text\/javascript; charset=utf-8'\]\]/);
});

function loadPrefs({ stored = {}, systemReduced = false, storageThrows = false } = {}) {
  const dom = new JSDOM('<!doctype html><html lang="tr"><head></head><body></body></html>', { url: 'http://127.0.0.1/', runScripts: 'outside-only' });
  const { window } = dom;
  for (const [key, value] of Object.entries(stored)) window.localStorage.setItem(key, value);
  if (storageThrows) {
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new window.DOMException('blocked', 'SecurityError'); } });
  }
  const mediaListeners = [];
  window.matchMedia = query => ({ matches: query === '(prefers-reduced-motion: reduce)' && systemReduced, addEventListener: (_, fn) => mediaListeners.push(fn) });
  window.eval(prefsSource);
  return { window, root: window.document.documentElement, prefs: window.DefterPrefs, mediaListeners };
}

test('ui-prefs: defaults are full motion and sound on', () => {
  const { root, prefs } = loadPrefs();
  assert.equal(root.dataset.motion, undefined);
  assert.equal(prefs.getMotion(), 'full');
  assert.equal(prefs.motionReduced(), false);
  assert.equal(prefs.getSound(), true);
});

test('ui-prefs: stored reduced motion is applied before first paint and can be toggled', () => {
  const { window, root, prefs } = loadPrefs({ stored: { 'defter-motion': 'reduced' } });
  assert.equal(root.dataset.motion, 'reduced');
  assert.equal(prefs.motionReduced(), true);
  const seen = [];
  const off = prefs.onChange(state => seen.push(state));
  assert.equal(prefs.setMotion('full'), 'full');
  assert.equal(root.dataset.motion, undefined);
  assert.equal(window.localStorage.getItem('defter-motion'), 'full');
  assert.equal(prefs.setMotion('anything-else'), 'full', 'unknown values fall back to full');
  prefs.setMotion('reduced');
  assert.equal(root.dataset.motion, 'reduced');
  off();
  prefs.setSound(false);
  assert.deepEqual(seen.map(s => s.motion), ['full', 'full', 'reduced']);
  assert.equal(window.localStorage.getItem('defter-sound'), 'off');
  assert.equal(prefs.getSound(), false);
});

test('ui-prefs: the operating system preference wins even when the switch is off', () => {
  const { root, prefs } = loadPrefs({ systemReduced: true });
  assert.equal(root.dataset.motion, undefined, 'CSS media query handles the system case');
  assert.equal(prefs.getMotion(), 'full');
  assert.equal(prefs.motionReduced(), true, 'JS consumers (ghost exit, sheet drag) still skip motion');
});

test('ui-prefs: sticky top bar defaults on, persists "static" before first paint and toggles back', () => {
  const fresh = loadPrefs();
  assert.equal(fresh.prefs.getTopbarSticky(), true);
  assert.equal(fresh.root.dataset.topbar, undefined);
  const stored = loadPrefs({ stored: { 'defter-topbar': 'static' } });
  assert.equal(stored.root.dataset.topbar, 'static', 'applied by the head script, before CSS');
  assert.equal(stored.prefs.getTopbarSticky(), false);
  const seen = [];
  stored.prefs.onChange(state => seen.push(state.topbarSticky));
  assert.equal(stored.prefs.setTopbarSticky(true), true);
  assert.equal(stored.root.dataset.topbar, undefined);
  assert.equal(stored.window.localStorage.getItem('defter-topbar'), 'sticky');
  stored.prefs.setTopbarSticky(false);
  assert.equal(stored.root.dataset.topbar, 'static');
  assert.deepEqual(seen, [true, false]);
});

test('motion.css: every sticky top bar rule is skipped when the preference is off', () => {
  const block = motionCss.slice(motionCss.indexOf('@media screen and (min-width: 901px)', motionCss.indexOf('Faz 7')));
  for (const selector of [':root:not([data-topbar="static"]) .topbar {', ':root:not([data-topbar="static"]) .topbar.is-scrolled', 'html:not([data-topbar="static"]) { scroll-padding-top', ':root:not([data-topbar="static"]) .trade-live-summary', ':root:not([data-topbar="static"]) .workbench-split.has-detail']) {
    assert.ok(block.includes(selector), selector);
  }
});

test('ui-prefs: blocked storage never throws and keeps defaults', () => {
  const { root, prefs } = loadPrefs({ storageThrows: true });
  assert.equal(root.dataset.motion, undefined);
  assert.equal(prefs.setMotion('reduced'), 'reduced');
  assert.equal(root.dataset.motion, 'reduced', 'switch still works for the current page');
  assert.equal(prefs.getMotion(), 'full', 'nothing persisted');
  assert.equal(prefs.setSound(false), false);
  assert.equal(prefs.getSound(), true);
  assert.equal(prefs.setTopbarSticky(false), false);
  assert.equal(root.dataset.topbar, 'static', 'still applies to the current page');
  assert.equal(prefs.getTopbarSticky(), true, 'nothing persisted');
  assert.ok(Object.isFrozen(prefs));
});

// Faz 11: text on the glass surfaces must keep WCAG AA contrast (≥ 4.5:1) in both themes.
// The glass colour is composited from the real palette tokens of styles.css, worst case:
// surface at the given opacity, over the modal scrim (--sidebar at 58%), over the page ground.
test('glass surfaces keep text contrast ≥ 4.5:1 in light and dark themes', () => {
  const styles = read('public/styles.css');
  const block = selector => {
    const start = styles.indexOf(selector + ' {');
    return styles.slice(start, styles.indexOf('}', start));
  };
  const tokens = text => Object.fromEntries([...text.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})/gi)].map(m => [m[1], m[2]]));
  const light = tokens(block(':root'));
  const dark = { ...light, ...tokens(block(':root[data-theme="dark"]')) };
  const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const over = (top, alpha, bottom) => top.map((c, i) => c * alpha + bottom[i] * (1 - alpha));
  const lum = c => { const [r, g, b] = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const surfaces = { 'dialog/popover (90%)': 0.9, 'toast (96%)': 0.96, 'scrolled top bar (78%)': 0.78 };
  const results = [];
  for (const [theme, t] of [['light', light], ['dark', dark]]) {
    const page = rgb(t.paper);
    const scrim = over(rgb(t.sidebar), 0.58, page);
    for (const [name, alpha] of Object.entries(surfaces)) {
      const ground = over(rgb(t.surface), alpha, name.startsWith('scrolled') ? page : scrim);
      for (const ink of ['ink', 'muted']) {
        const ratio = contrast(rgb(t[ink]), ground);
        results.push(`${theme} ${name} ${ink}: ${ratio.toFixed(2)}`);
        assert.ok(ratio >= 4.5, `${theme} ${name} --${ink} contrast ${ratio.toFixed(2)} < 4.5`);
      }
    }
  }
  assert.equal(results.length, 12);
});
