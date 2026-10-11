'use strict';
// The first administrator's temporary password (server/bootstrap.js). It goes to stdout, never to the log file; but
// under systemd stdout is the journal, readable by the adm group and kept after the password is changed (evaluation of
// 1.25.5, J12). There only the username and the 0600 file are named. A terminal (no journal) still prints it.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
// A fresh data directory, a first start in production (as suds.service runs it), with `extra` in the environment.
function firstStart(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-bootstrap-journal-'));
  const env = { ...process.env, SUDS_ENV: 'production', SUDS_DATA_DIR: dir, SUDS_DB_PATH: path.join(dir, 'suds.db'),
    SUDS_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'), SUDS_INDEX_KEY: crypto.randomBytes(32).toString('hex'), ...extra };
  delete env.SUDS_ADMIN_PASSWORD; delete env.SUDS_ADMIN_USERNAME;
  for (const k of ['INVOCATION_ID', 'JOURNAL_STREAM']) if (!(k in extra)) delete env[k];
  const r = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', '-e', "const r = require('./server/bootstrap').ensureBootstrap(); require('node:fs').writeFileSync(process.env.SUDS_DATA_DIR + '/made.json', JSON.stringify(r));"],
    { cwd: root, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const made = JSON.parse(fs.readFileSync(path.join(dir, 'made.json'), 'utf8'));
  const file = path.join(dir, 'first-admin-password.txt');
  const kept = fs.existsSync(file) ? { text: fs.readFileSync(file, 'utf8').trim(), mode: fs.statSync(file).mode & 0o777 } : null;
  fs.rmSync(dir, { recursive: true, force: true });
  return { out: r.stdout + r.stderr, made, kept, file };
}

test('under systemd (INVOCATION_ID) the temporary password is not printed: only the username and the 0600 file', () => {
  const { out, made, kept, file } = firstStart({ INVOCATION_ID: 'a1b2c3d4e5f6' });
  assert.ok(made.password && made.password.length >= 12);
  assert.ok(!out.includes(made.password), 'the password is not in the output (the journal)');
  assert.doesNotMatch(out, /Temporary password:/);
  assert.match(out, /Created initial admin user "guest"/);
  assert.ok(out.includes(file), 'the file is named');
  assert.ok(kept, 'the file is written');
  assert.equal(kept.text, made.password, 'and holds the password');
  assert.equal(kept.mode, 0o600);
});

test('stdout connected to the journal (JOURNAL_STREAM, not a terminal) is treated the same', () => {
  const { out, made, kept } = firstStart({ JOURNAL_STREAM: '8:12345' });
  assert.ok(!out.includes(made.password), 'the password is not in the output');
  assert.equal(kept && kept.text, made.password);
});

test('with no journal the password is printed as before, and the file is still written in production', () => {
  const { out, made, kept } = firstStart({});
  assert.ok(out.includes(`Temporary password: ${made.password}`), out);
  assert.equal(kept && kept.text, made.password);
});
