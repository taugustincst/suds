'use strict';
// The office server is the system of record (docs/PLATFORM.md): a fresh install does not hand out the
// in-browser offline copy until someone decides it should — the setup wizard's answer (server.json
// localModeEnabled) or LOCAL_MODE_ENABLED, which overrides it either way.
delete process.env.LOCAL_MODE_ENABLED;
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const H = require('./helpers');

const root = path.join(__dirname, '..');
/** config.localModeEnabled as a fresh process sees it, from its own empty data directory and cwd (no .env). */
function freshConfig({ env = {}, serverJson } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-lm-'));
  try {
    if (serverJson) fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify(serverJson));
    const childEnv = { ...process.env, SUDS_ENV: 'test', SUDS_DATA_DIR: dir, ...env };
    if (!('LOCAL_MODE_ENABLED' in env)) delete childEnv.LOCAL_MODE_ENABLED;
    const script = `const c = require(${JSON.stringify(path.join(root, 'server', 'config.js'))}); process.stdout.write(JSON.stringify({ on: c.localModeEnabled, fromEnv: c.localModeFromEnv }))`;
    return JSON.parse(String(execFileSync(process.execPath, ['-e', script], { cwd: dir, env: childEnv })));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('a fresh office-server config has local mode off', () => {
  assert.deepEqual(freshConfig(), { on: false, fromEnv: false });
});

test('the setup wizard answer in server.json is honoured, and LOCAL_MODE_ENABLED overrides it either way', () => {
  assert.equal(freshConfig({ serverJson: { setupComplete: true, localModeEnabled: true } }).on, true);
  assert.equal(freshConfig({ serverJson: { setupComplete: true, localModeEnabled: false } }).on, false);
  assert.deepEqual(freshConfig({ env: { LOCAL_MODE_ENABLED: 'false' }, serverJson: { localModeEnabled: true } }), { on: false, fromEnv: true });
  assert.deepEqual(freshConfig({ env: { LOCAL_MODE_ENABLED: 'true' }, serverJson: { localModeEnabled: false } }), { on: true, fromEnv: true });
  assert.equal(freshConfig({ env: { LOCAL_MODE_ENABLED: '1' } }).on, true);
  assert.equal(freshConfig({ env: { LOCAL_MODE_ENABLED: 'off' } }).on, false);
  // An empty variable (run-all.sh clears it for the wizard's server) is "not set", so the wizard decides.
  assert.deepEqual(freshConfig({ env: { LOCAL_MODE_ENABLED: '' }, serverJson: { localModeEnabled: true } }), { on: true, fromEnv: false });
});

let c;
before(async () => { await H.start(); c = H.client(); });
after(async () => { await H.stop(); });

test('with the default config, /?local=1 serves the interstitial and not the kernel', async () => {
  assert.equal(require('../server/config').localModeEnabled, false, 'the in-process test server starts with the default');
  const page = await c.get('/?local=1');
  assert.equal(page.status, 200);
  assert.match(String(page.data), /Local mode is turned off/);
  assert.doesNotMatch(String(page.data), /<script/i, 'the explanation runs no scripts');
  assert.equal((await c.get('/local/kernel.js')).status, 404);
  const info = await c.get('/api/app/info');
  assert.equal(info.data.local_mode, false, '/app is told not to mention the offline copy');
  assert.equal((await c.get('/')).status, 200, 'the office app itself still serves');
});
