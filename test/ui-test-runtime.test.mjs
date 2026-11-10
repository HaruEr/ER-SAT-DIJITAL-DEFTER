import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const loader = new URL('../test-support/jsdom.mjs', import.meta.url).href;

function fixture(t, { local = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'defter-ui-loader-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const projectFile = join(directory, 'package.json');
  writeFileSync(projectFile, '{"private":true}');
  if (local) {
    const packageDirectory = join(directory, 'node_modules', 'jsdom');
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(packageDirectory, 'package.json'), '{"name":"jsdom","main":"index.cjs"}');
    writeFileSync(join(packageDirectory, 'index.cjs'), 'exports.JSDOM = Object.assign(function JSDOM() {}, { fixture: "local-runtime" });');
  }
  return { directory, projectFile };
}

function runLoader(projectFile, modulePath) {
  const env = { ...process.env };
  delete env.JSDOM_MODULE_PATH;
  if (modulePath !== undefined) env.JSDOM_MODULE_PATH = modulePath;
  return spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { loadJSDOM } from ${JSON.stringify(loader)}; const JSDOM = await loadJSDOM({ projectFile: process.argv[1] }); console.log(JSDOM.fixture);`, projectFile],
  { cwd: root, env, encoding: 'utf8', timeout: 10000 });
}

test('UI runtime resolves jsdom from the selected project without an environment override', t => {
  const { projectFile } = fixture(t, { local: true });
  const result = runLoader(projectFile);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'local-runtime');
});

test('an explicit runtime takes precedence over a project installation and supports file URLs', t => {
  const { directory, projectFile } = fixture(t, { local: true });
  const runtime = join(directory, 'explicit runtime.cjs');
  writeFileSync(runtime, 'exports.JSDOM = Object.assign(function JSDOM() {}, { fixture: "explicit-runtime" });');
  for (const modulePath of [runtime, pathToFileURL(runtime).href]) {
    const result = runLoader(projectFile, modulePath);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'explicit-runtime');
  }
});

test('a missing explicit runtime fails clearly without falling back to an installed runtime', t => {
  const { directory, projectFile } = fixture(t, { local: true });
  const result = runLoader(projectFile, join(directory, 'missing.cjs'));
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /JSDOM_MODULE_PATH.*başka kurulum denenmedi/);
  assert.equal(result.stdout, '');
});

test('a runtime without JSDOM fails instead of reporting successful UI validation', t => {
  const { directory, projectFile } = fixture(t, { local: true });
  const runtime = join(directory, 'wrong-runtime.cjs');
  writeFileSync(runtime, 'exports.other = true;');
  const result = runLoader(projectFile, runtime);
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /JSDOM_MODULE_PATH.*başka kurulum denenmedi/);
  assert.equal(result.stdout, '');
});

test('an unavailable runtime explains the explicit setup without installing or skipping tests', t => {
  const { projectFile } = fixture(t);
  const result = runLoader(projectFile);
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /UI testleri için JSDOM bulunamadı/);
  assert.match(result.stderr, /JSDOM_MODULE_PATH/);
  assert.match(result.stderr, /Otomatik kurulum yapılmadı/);
  assert.equal(result.stdout, '');
});

for (const script of ['ui-purchase-smoke.mjs', 'ui-advanced-smoke.mjs', 'ui-busy-smoke.mjs']) {
  test(`${script} uses the explicitly configured JSDOM runtime`, t => {
    const directory = mkdtempSync(join(tmpdir(), 'defter-ui-runtime-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const runtime = join(directory, 'runtime.cjs');
    writeFileSync(runtime, 'exports.JSDOM = class { constructor() { throw new Error("EXPLICIT_TEST_RUNTIME_SELECTED"); } };');
    const result = spawnSync(process.execPath, [join(root, 'qa-temp', script)], {
      cwd: root,
      env: { ...process.env, JSDOM_MODULE_PATH: runtime },
      encoding: 'utf8',
      timeout: 10000
    });
    assert.equal(result.error, undefined);
    assert.match(result.stderr, /EXPLICIT_TEST_RUNTIME_SELECTED/);
    assert.notEqual(result.status, 0);
  });
}
