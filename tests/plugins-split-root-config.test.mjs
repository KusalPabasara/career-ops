// plugins split-checkout contract (#3867 finding 3): executable plugin code
// stays in the checkout, while config/plugins.yml and .env live in DATA_ROOT.
//
// Run: node --test tests/plugins-split-root-config.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rmSync, ROOT } from './helpers.mjs';

const PLUGINS_CLI = join(ROOT, 'plugins.mjs');
const NOTION_KEYS = ['NOTION_ACCESS_TOKEN', 'NOTION_PARENT_PAGE_ID'];

function sandbox(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, 'config'), { recursive: true });
  return dir;
}

function runCli(dataRoot, args) {
  const env = { ...process.env, CAREER_OPS_ROOT: dataRoot };
  for (const key of NOTION_KEYS) delete env[key];
  return spawnSync(process.execPath, [PLUGINS_CLI, ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf-8',
    timeout: 30_000,
  });
}

function writeNotionConfig(dir) {
  writeFileSync(join(dir, 'config', 'plugins.yml'), 'plugins:\n  notion:\n    enabled: true\n');
  writeFileSync(
    join(dir, '.env'),
    'NOTION_ACCESS_TOKEN=test-token\nNOTION_PARENT_PAGE_ID=test-parent\n',
  );
}

test('plugins list reads activation and .env from the configured data root', () => {
  const dir = sandbox('career-ops-plugin-list-');
  try {
    writeNotionConfig(dir);
    const result = runCli(dir, ['list']);

    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(result.stdout, /notion\s+\[export, search\]\s+— ✅ enabled/);
    assert.doesNotMatch(result.stdout + result.stderr, /missing env/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plugins run loads data-root .env before its required-key gate', () => {
  const dir = sandbox('career-ops-plugin-run-');
  try {
    writeNotionConfig(dir);

    // A missing search query exits after the config/env gates but before the
    // hook, integrity lock, or network. That makes this an offline black-box
    // witness for the gate order rather than a source-text assertion.
    const result = runCli(dir, ['run', 'notion', 'search']);

    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(result.stderr, /search needs a query/);
    assert.doesNotMatch(result.stderr, /not enabled|missing .*\.env/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scan preloads .env from the data root instead of the caller cwd', () => {
  const dataRoot = sandbox('career-ops-scan-env-data-');
  const callerRoot = sandbox('career-ops-scan-env-cwd-');
  const key = 'CAREER_OPS_SPLIT_SCAN_ENV_TEST';
  try {
    writeFileSync(join(dataRoot, '.env'), `${key}=from-data-root\n`);
    writeFileSync(join(callerRoot, '.env'), `${key}=from-caller-cwd\n`);
    const env = { ...process.env, CAREER_OPS_ROOT: dataRoot };
    delete env[key];
    const scanUrl = pathToFileURL(join(ROOT, 'scan.mjs')).href;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(scanUrl)}); process.stdout.write(process.env[${JSON.stringify(key)}] || '');`],
      { cwd: callerRoot, env, encoding: 'utf-8', timeout: 30_000 },
    );

    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.equal(result.stdout, 'from-data-root');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(callerRoot, { recursive: true, force: true });
  }
});

test('plugin activation writes config/plugins.yml under the data root', async () => {
  const dir = sandbox('career-ops-plugin-enable-');
  try {
    const { setPluginEnabled } = await import(
      pathToFileURL(PLUGINS_CLI).href + `?split-root-write=${Date.now()}`
    );
    setPluginEnabled(dir, 'h1b-sponsor', true, { region: 'us' });

    const file = join(dir, 'config', 'plugins.yml');
    assert.equal(existsSync(file), true);
    const written = readFileSync(file, 'utf-8');
    assert.match(written, /h1b-sponsor:/);
    assert.match(written, /enabled: true/);
    assert.match(written, /region: us/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('provider engine discovers code in code root and config in data root', async () => {
  const codeRoot = sandbox('career-ops-plugin-code-');
  const dataRoot = sandbox('career-ops-plugin-data-');
  const key = 'CAREER_OPS_SPLIT_PLUGIN_TOKEN';
  const previous = process.env[key];
  try {
    const pluginDir = join(codeRoot, 'plugins', 'split-demo');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'manifest.json'), JSON.stringify({
      id: 'split-demo',
      apiVersion: 1,
      description: 'split-root fixture',
      hooks: ['provider'],
      requiredEnv: [key],
      allowedHosts: ['api.example.com'],
      humanInTheLoop: true,
    }));
    writeFileSync(
      join(pluginDir, 'index.mjs'),
      'export default { provider: { id: "split-demo", async fetch() { return [{ title: "Fixture", url: "https://api.example.com/1" }]; } } };\n',
    );
    writeFileSync(join(dataRoot, 'config', 'plugins.yml'), 'plugins:\n  split-demo:\n    enabled: true\n');
    writeFileSync(join(dataRoot, '.env'), `${key}=from-data-root\n`);
    delete process.env[key];

    const engine = await import(
      pathToFileURL(join(ROOT, 'plugins', '_engine.mjs')).href + `?split-root-engine=${Date.now()}`
    );
    const providers = new Map();
    await engine.mergeProviderPlugins(providers, { root: codeRoot, dataRoot });

    const provider = providers.get('split-demo');
    assert.ok(provider, 'enabled provider from the split roots was not merged');
    assert.equal(process.env[key], 'from-data-root');
    assert.deepEqual(await provider.fetch({}), [{ title: 'Fixture', url: 'https://api.example.com/1' }]);
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
    rmSync(codeRoot, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
