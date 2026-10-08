'use strict';
// 1.25.2, BO2: the first-run wizard's Yes to "Allow staff to keep an offline copy" and to "participant codes by
// default" were dropped. validate() turns a boolean into 1/0 and POST /api/setup/complete compared the answer
// with `=== true`, so both were always stored as off. A real unconfigured production server is started in a
// throwaway data directory (setup is never "needed" in the test environment) and the wizard's request is sent.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

async function wizard(answers) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-setup-answers-'));
  const free = await new Promise((resolve) => { const s = require('node:net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const env = { PATH: process.env.PATH || '', HOME: dir, SUDS_ENV: 'production', SUDS_DATA_DIR: dir, PORT: String(free), LOG_FORMAT: 'text', TZ: process.env.TZ || '' };
  const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(ROOT, 'server', 'index.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 30_000);
      const seen = (d) => { out += d; if (/listening on/.test(out)) { clearTimeout(timer); resolve(free); } };
      child.stdout.on('data', seen); child.stderr.on('data', seen);
      child.on('exit', () => { clearTimeout(timer); reject(new Error(`server exited:\n${out}`)); });
    });
    const base = `http://127.0.0.1:${port}`;
    const status = await (await fetch(`${base}/api/setup/status`)).json();
    assert.equal(status.needed, true, 'an unconfigured production server asks for setup');
    const r = await fetch(`${base}/api/setup/complete`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'suds' },
      body: JSON.stringify({ org_name: 'Answers Programme', admin_username: 'answers', admin_display_name: 'Ann Swers', admin_password: 'SetupPassw0rd!x', network: 'local', https: false, programme_profile: 'harm_reduction', ...answers }) });
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    const serverJson = JSON.parse(fs.readFileSync(path.join(dir, 'server.json'), 'utf8'));
    return { body, serverJson, dir };
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null && child.signalCode === null) await new Promise((r) => child.once('exit', r));
  }
}

function setting(dir, key) {
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(path.join(dir, 'suds.db'), { readOnly: true });
  try { return d.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? null; } finally { d.close(); }
}

test('the wizard\'s Yes to the offline copy and to participant codes is stored', async () => {
  const { body, serverJson, dir } = await wizard({ local_mode: true, participant_code_default: true });
  try {
    assert.equal(body.local_mode, true, 'the answer is reported back');
    assert.equal(serverJson.localModeEnabled, true, 'and saved in server.json');
    assert.equal(setting(dir, 'participant_code_default'), '1', 'participant codes by default');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the wizard\'s No (or no answer) leaves both off', async () => {
  const { body, serverJson, dir } = await wizard({ local_mode: false });
  try {
    assert.equal(body.local_mode, false);
    assert.equal(serverJson.localModeEnabled, false);
    assert.equal(setting(dir, 'participant_code_default'), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
